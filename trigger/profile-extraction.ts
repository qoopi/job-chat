import { ProfileSchema, type Profile } from "@shared/profile";
import type { Store } from "@shared/store";
import type { GithubSignals } from "./github-profile";
import { profileCardMessageId } from "./profile-card-id";

// The profile extraction pipeline, pure over injected seams (store, github fetch, model `generate`) so
// the whole thing is unit-testable without Trigger or Bedrock - the same split as createChatRun. It
// reads the pending profiles row, enriches from GitHub (resume-only on failure), makes ONE model call
// with the resume as a document block (PDF) or text plus the GitHub signals, then upserts the structured
// profile and appends the deterministic-id profile card. The Trigger task (extract-profile.ts) wires the
// real seams.

/** A user message part: text, or a file (the resume PDF as a document block for the model to read). */
type TextPart = { type: "text"; text: string };
type FilePart = { type: "file"; mediaType: string; data: Uint8Array; filename?: string };
export type ExtractionMessage = { role: "user"; content: (TextPart | FilePart)[] };

/** The model seam: given the system + built messages, return the schema-valid profile (real: a Bedrock
 *  generateObject over ProfileSchema). Injected so tests assert the built prompt (the document block)
 *  and drive the retry without a live model. */
export type GenerateProfile = (args: {
  system: string;
  messages: ExtractionMessage[];
}) => Promise<Profile>;

const SYSTEM = [
  "You extract a structured job-seeker profile from a resume and/or public GitHub signals.",
  "Return ONLY what the sources support - never invent titles, skills, employers, or numbers.",
  "Skill provenance: mark a skill `resume` if only the resume shows it, `github` if only the GitHub",
  "signals do, `both` if both. Seniority is one of junior|mid|senior|lead, or null if unclear.",
  "salaryMin/yearsExp are numbers only when stated or clearly implied, else null. remotePref is true",
  "only when the resume states a remote preference, false when it states onsite, else null.",
  "domains are the industries/problem areas the person works in; ossHighlights are concrete open-source",
  "contributions (a maintained project, a notable merged PR area). experience is the resume's roles,",
  "each with short one-line achievement bullets (never a paragraph).",
].join(" ");

/** Serialize the GitHub signals into a compact block the model reads alongside the resume. */
function githubBlock(g: GithubSignals): string {
  const lines = [
    `GitHub @${g.username}${g.name ? ` (${g.name})` : ""}${g.location ? ` - ${g.location}` : ""}`,
    g.bio ? `Bio: ${g.bio}` : "",
    g.languages.length ? `Languages: ${g.languages.join(", ")}` : "",
    g.topics.length ? `Topics: ${g.topics.join(", ")}` : "",
    g.mergedPrCount ? `Merged public PRs: ${g.mergedPrCount}` : "",
    g.recentEventTypes.length ? `Recent activity: ${g.recentEventTypes.join(", ")}` : "",
    ...g.repos.map(
      (r) => `Repo ${r.name}${r.language ? ` [${r.language}]` : ""}${r.stars ? ` (${r.stars} stars)` : ""}: ${r.description ?? ""}${r.topics.length ? ` {${r.topics.join(", ")}}` : ""}`,
    ),
    ...g.readmes.map((r) => `README of ${r.repo}:\n${r.excerpt}`),
  ];
  if (g.capped) lines.push("(GitHub read without a token - only public repo metadata was available.)");
  return lines.filter(Boolean).join("\n");
}

/**
 * Build the extraction prompt. A PDF resume is attached as a `file` part (the model parses the document
 * itself - the same ProfileSchema output as the paste path); pasted text goes inline. GitHub signals, when
 * present, are appended as a text block. The trailing instruction pins the output to the sources.
 */
export function buildExtractionPrompt(input: {
  resumeText?: string;
  resumePdf?: Uint8Array;
  githubSignals?: GithubSignals;
}): { system: string; messages: ExtractionMessage[] } {
  const content: (TextPart | FilePart)[] = [];
  if (input.resumePdf) {
    content.push({ type: "text", text: "My resume is the attached PDF document." });
    content.push({ type: "file", mediaType: "application/pdf", data: input.resumePdf, filename: "resume.pdf" });
  } else if (input.resumeText && input.resumeText.trim().length > 0) {
    content.push({ type: "text", text: `My resume:\n${input.resumeText}` });
  } else {
    content.push({ type: "text", text: "I have no resume yet - build the profile from GitHub alone, and note in the summary that adding a resume would sharpen it." });
  }
  if (input.githubSignals) {
    content.push({ type: "text", text: githubBlock(input.githubSignals) });
  }
  content.push({ type: "text", text: "Extract my profile as the structured object. Use null / empty arrays for anything the sources do not support." });
  return { system: SYSTEM, messages: [{ role: "user", content }] };
}

/** Build the prompt and call the model, retrying ONCE on a failed/invalid generation (the model
 *  occasionally returns JSON that fails the schema; a single retry recovers it). */
export async function extractProfileFields(
  generate: GenerateProfile,
  input: { resumeText?: string; resumePdf?: Uint8Array; githubSignals?: GithubSignals },
): Promise<Profile> {
  const { system, messages } = buildExtractionPrompt(input);
  try {
    return ProfileSchema.parse(await generate({ system, messages }));
  } catch {
    return ProfileSchema.parse(await generate({ system, messages }));
  }
}

export interface ExtractionDeps {
  store: Store;
  fetchGithub: (username: string, token: string | undefined) => Promise<GithubSignals>;
  generate: GenerateProfile;
  githubToken: string | undefined;
}

/**
 * Run the extraction for one save: read the pending row, enrich from GitHub (resume-only if the fetch
 * throws - AC-5), extract, upsert the structured profile (which NULLs the transient PDF), and append the
 * deterministic-id profile card. Returns the profile, or `null` if the row was gone (deleted mid-flight).
 */
export async function runProfileExtraction(
  deps: ExtractionDeps,
  payload: { userId: string; conversationId: string },
): Promise<Profile | null> {
  const row = await deps.store.getProfile(payload.userId);
  if (!row) return null; // deleted before the task ran - nothing to extract

  let githubSignals: GithubSignals | undefined;
  if (row.github_username) {
    try {
      githubSignals = await deps.fetchGithub(row.github_username, deps.githubToken);
    } catch (err) {
      console.error("[extract-profile] GitHub enrichment failed - saving a resume-only profile", err);
      githubSignals = undefined;
    }
  }

  const profile = await extractProfileFields(deps.generate, {
    resumeText: row.raw_resume_text ?? undefined,
    resumePdf: row.resume_pdf ?? undefined,
    githubSignals,
  });

  await deps.store.saveExtractedProfile(payload.userId, profile);
  await deps.store.appendProfileCard(payload.conversationId, profileCardMessageId(payload.conversationId), {
    kind: "profile-card",
    profile,
  });
  return profile;
}
