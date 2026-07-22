import { ZodError } from "zod";
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

/** Build the prompt and call the model, retrying ONCE only on a SCHEMA-INVALID generation (the model
 *  occasionally returns an object that fails ProfileSchema; a single re-ask recovers it). A transport /
 *  throttle error is re-thrown so the task's OWN retry policy (schemaTask maxAttempts, with backoff) owns
 *  it - the inner retry must not compound with generateObject.maxRetries + maxAttempts into a large
 *  model-call fan-out (S2). */
export async function extractProfileFields(
  generate: GenerateProfile,
  input: { resumeText?: string; resumePdf?: Uint8Array; githubSignals?: GithubSignals },
): Promise<Profile> {
  const { system, messages } = buildExtractionPrompt(input);
  try {
    return ProfileSchema.parse(await generate({ system, messages }));
  } catch (err) {
    if (!(err instanceof ZodError)) throw err; // transport/throttle - the task's retry, not ours
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
 * throws - AC-5), extract, upsert the structured profile, append the deterministic-id profile card, then
 * clear the transient PDF. Returns the profile, or `null` if the row was gone - deleted before the task
 * ran, or deleted mid-extraction (the profile write matched no row: skip the card so none is orphaned, S3).
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

  // The profile write is UPDATE ... WHERE user_id; if the profile was deleted mid-extraction it matches no
  // row. Skip the card (and the PDF clear) so a deleted profile never gets an orphan card message (S3).
  const updated = await deps.store.saveExtractedProfile(payload.userId, profile);
  if (!updated) return null;

  await deps.store.appendProfileCard(payload.conversationId, profileCardMessageId(payload.conversationId), {
    kind: "profile-card",
    profile,
  });
  // Clear the transient PDF ONLY after the card append succeeds (S1). If anything above throws (a transient
  // blip), schemaTask retries the whole run and the PDF is still present, so a PDF-only resume re-extracts
  // instead of degrading to the no-resume branch. A PERMANENT failure clears it via the onFailure hook.
  await deps.store.clearResumePdf(payload.userId);
  return profile;
}

/**
 * Terminal-failure handler wired to the task's onFailure hook, which fires once ALL retries are exhausted
 * (a PERMANENT failure). Clears the transient resume PDF (it must never linger as long-term PII) and stamps
 * the failure marker `getMyProfile` surfaces, so the saving panel can stop polling. Pure over the injected
 * store - the task (extract-profile.ts) wires the real store seam.
 */
export async function markProfileExtractionFailed(store: Store, userId: string): Promise<void> {
  console.error(`[extract-profile] extraction permanently failed for ${userId} - clearing the transient PDF and stamping the failure marker`);
  await store.markExtractionFailed(userId);
}
