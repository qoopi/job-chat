"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Profile } from "@shared/profile";
import { deleteProfile, getMyProfile, getProfileRunStatus, saveProfile } from "@/app/actions";
import { pollProfileSave } from "@/lib/profile-poll";
import { isGithubSkipped, profileTitle } from "@/lib/profile-format";
import { ProfileExpanded } from "@/components/insight/ProfileCard";

// The account's profile form in the detail panel (five states: empty/saving/saved/github-skipped/error). Save polls
// getMyProfile until extraction terminates (profile-poll.ts closes the re-save edge), then injects the card into the live thread.

// The DECODED-PDF cap the form enforces before the round trip (the server also caps ~4.5MB).
const MAX_PDF_BYTES = 4 * 1024 * 1024;

type Status = "loading" | "form" | "saving" | "saved" | "github-skipped" | "error";

// The e2e fixture profile - the suite has no Postgres, so a save short-circuits to this (mock-transport path).
const E2E_PROFILE: Profile = {
  titles: ["Senior Backend Engineer"],
  seniority: "senior",
  skills: [
    { name: "ClickHouse", source: "github" },
    { name: "Go", source: "both" },
    { name: "Python", source: "resume" },
  ],
  locations: ["Berlin"],
  remotePref: true,
  salaryMin: 120000,
  yearsExp: 8,
  domains: ["distributed systems"],
  ossHighlights: ["Merged PRs to trigger.dev"],
  experience: [
    { title: "Senior Backend Engineer", company: "DataMesh", years: "2021-2026", bullets: ["Led the ClickHouse migration"] },
  ],
};

function reasonMessage(reason: "unauthorized" | "too-large" | "empty" | "enqueue-failed"): string {
  switch (reason) {
    case "too-large":
      return "That PDF is over the size limit — try a smaller file or paste the text.";
    case "empty":
      return "Add a resume or a GitHub username to build your profile.";
    case "unauthorized":
      return "Sign in to build and save your profile.";
    case "enqueue-failed":
      return "Couldn’t start building your profile — please try again.";
  }
}

/** Base64-encode file bytes in the browser (chunked so a ~4MB file never blows the call stack). */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function DetailProfile({
  conversationId,
  e2e = false,
  onClose,
  onFindJob,
  onProfileSaved,
  onProfileDeleted,
}: {
  conversationId: string;
  e2e?: boolean;
  onClose: () => void;
  /** "Find me a job that fits" from the saved full-profile view - sends the fit question as a chat turn. */
  onFindJob?: () => void;
  /** Inject / replace the profile card in the live thread after a successful save. */
  onProfileSaved: (profile: Profile) => void | Promise<void>;
  /** Remove the profile card from the live thread after a delete. */
  onProfileDeleted: () => void | Promise<void>;
}) {
  // e2e opens straight on the empty form (no store); otherwise start on a skeleton and resolve the real
  // state asynchronously below.
  const [status, setStatus] = useState<Status>(e2e ? "form" : "loading");
  const [profile, setProfile] = useState<Profile | null>(null);
  // The error copy gate = the POLL OUTCOME's `hadPriorProfile` (not local state, which can diverge in a multi-tab race).
  const [errorHadPriorProfile, setErrorHadPriorProfile] = useState(false);

  const [resumeText, setResumeText] = useState("");
  const [githubInput, setGithubInput] = useState("");
  const [pdfName, setPdfName] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [savingSources, setSavingSources] = useState({ resume: false, github: false });

  const fileRef = useRef<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const pollToken = useRef(0); // bumped per save so a stale poll never writes state after a newer one
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Initial load: resolve the real state (saved/github-skipped/error/empty); e2e opens on the empty form.
  useEffect(() => {
    if (e2e) return; // e2e already starts on the empty form (initial state)
    let alive = true;
    void (async () => {
      const my = await getMyProfile().catch(() => null);
      if (!alive) return;
      if (my?.profile && my.extractedAt) {
        setProfile(my.profile);
        setGithubInput(my.githubUsername ?? "");
        // github-skipped: a username was given but nothing came back proven in code.
        const skipped = my.githubUsername != null && isGithubSkipped(my.profile);
        setStatus(skipped ? "github-skipped" : "saved");
      } else if (my?.extractionFailed) {
        setStatus("error");
      } else {
        setStatus("form");
      }
    })();
    return () => {
      alive = false;
    };
  }, [e2e]);

  const build = useCallback(async () => {
    setFormError(null);
    const text = resumeText.trim();
    const gh = githubInput.trim();
    const file = fileRef.current;
    if (!text && !file && !gh) {
      setFormError("Add a resume or a GitHub username to build your profile.");
      return;
    }
    if (file && file.size > MAX_PDF_BYTES) {
      setFormError("That PDF is over the 4 MB limit — try a smaller file or paste the text.");
      return;
    }

    setSavingSources({ resume: Boolean(text || file), github: Boolean(gh) });
    setStatus("saving");

    if (e2e) {
      setProfile(E2E_PROFILE);
      setStatus("saved");
      void onProfileSaved(E2E_PROFILE);
      return;
    }

    // Capture the pre-save state so the poll knows what "advanced" means and how to word a failure.
    const prior = await getMyProfile().catch(() => null);
    const priorExtractedAt = prior?.extractedAt ?? null;
    const hadPriorProfile = Boolean(prior?.profile);

    let resumePdf: { bytes: string; name: string } | undefined;
    if (file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      resumePdf = { bytes: toBase64(bytes), name: file.name };
    }

    const res = await saveProfile({
      conversationId,
      resumeText: text || undefined,
      resumePdf,
      githubUsername: gh || undefined,
    });
    if (!mounted.current) return;
    if (!res.ok) {
      setFormError(reasonMessage(res.reason));
      setStatus(hadPriorProfile ? "saved" : "form"); // a refused save keeps the prior profile / the form
      return;
    }

    const token = ++pollToken.current;
    const outcome = await pollProfileSave(
      {
        getMyProfile: () => getMyProfile().catch(() => null),
        getRunStatus: getProfileRunStatus,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      },
      { runId: res.runId, priorExtractedAt, hadPriorProfile },
    );
    if (!mounted.current || token !== pollToken.current) return; // superseded by a newer save / unmounted
    if (outcome.outcome === "error") {
      setErrorHadPriorProfile(outcome.hadPriorProfile);
      setStatus("error");
      return;
    }
    setProfile(outcome.profile);
    setStatus(outcome.outcome);
    void onProfileSaved(outcome.profile);
  }, [conversationId, e2e, githubInput, resumeText, onProfileSaved]);

  const remove = useCallback(async () => {
    if (!e2e) await deleteProfile(conversationId).catch(() => ({ ok: false }));
    if (!mounted.current) return;
    setProfile(null);
    setResumeText("");
    setGithubInput("");
    setPdfName(null);
    fileRef.current = null;
    setFormError(null);
    setStatus("form");
    void onProfileDeleted();
  }, [conversationId, e2e, onProfileDeleted]);

  const onPickFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    fileRef.current = file;
    setPdfName(file?.name ?? null);
    if (file && file.size > MAX_PDF_BYTES) setFormError("That PDF is over the 4 MB limit — try a smaller file or paste the text.");
    else setFormError(null);
  }, []);

  return (
    <section className="detail-panel" role="region" aria-label="Your profile">
      <div className="detail-panel-head">
        <span className="detail-panel-title">Your profile</span>
        <button className="x-btn" type="button" aria-label="Close profile" onClick={onClose}>
          &times;
        </button>
      </div>
      <div className="detail-panel-body">
        {status === "loading" ? (
          <div className="profile-form">
            <div className="skeleton" style={{ height: 15, width: "50%" }} />
            <div className="skeleton" style={{ height: 13, width: "80%" }} />
            <div className="skeleton" style={{ height: 13, width: "65%" }} />
          </div>
        ) : status === "saving" ? (
          <SavingState sources={savingSources} pdfName={pdfName} github={githubInput.trim()} />
        ) : status === "saved" && profile ? (
          <SavedState
            profile={profile}
            onFindJob={() => onFindJob?.()}
            onEdit={() => setStatus("form")}
            onDelete={() => void remove()}
          />
        ) : status === "github-skipped" && profile ? (
          <GithubSkippedState
            githubInput={githubInput}
            onGithubInput={setGithubInput}
            onRetry={() => void build()}
            onDelete={() => void remove()}
          />
        ) : status === "error" ? (
          <ErrorState
            hadProfile={errorHadPriorProfile}
            inputRef={inputRef}
            pdfName={pdfName}
            onPickFile={onPickFile}
            onRetry={() => setStatus("form")}
          />
        ) : (
          <FormState
            editing={profile != null}
            resumeText={resumeText}
            onResumeText={setResumeText}
            githubInput={githubInput}
            onGithubInput={setGithubInput}
            pdfName={pdfName}
            inputRef={inputRef}
            onPickFile={onPickFile}
            formError={formError}
            onBuild={() => void build()}
          />
        )}
      </div>
    </section>
  );
}

/** The hidden file input + its dropzone trigger, shared by the empty form + the error state. */
function Dropzone({
  inputRef,
  pdfName,
  onPickFile,
  label,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  pdfName: string | null;
  onPickFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  label: string;
}) {
  return (
    <>
      <input ref={inputRef} type="file" accept="application/pdf" hidden onChange={onPickFile} />
      <button type="button" className="dropzone" onClick={() => inputRef.current?.click()}>
        {pdfName ? (
          <>Selected: {pdfName}</>
        ) : (
          <>
            {label}
            <br />
            <span style={{ fontSize: 11, color: "var(--text-3)" }}>or click to browse · 4 MB max</span>
          </>
        )}
      </button>
    </>
  );
}

function FormState({
  editing,
  resumeText,
  onResumeText,
  githubInput,
  onGithubInput,
  pdfName,
  inputRef,
  onPickFile,
  formError,
  onBuild,
}: {
  editing: boolean;
  resumeText: string;
  onResumeText: (v: string) => void;
  githubInput: string;
  onGithubInput: (v: string) => void;
  pdfName: string | null;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onPickFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  formError: string | null;
  onBuild: () => void;
}) {
  return (
    <div className="profile-form">
      <h3>{editing ? "Update your profile" : "No profile yet"}</h3>
      <p className="profile-form-sub">
        Add any of these — I’ll build your profile and score every posting against you.
      </p>
      {editing ? <p className="profile-note">A resume is on file. Re-upload to replace it.</p> : null}
      <Dropzone inputRef={inputRef} pdfName={pdfName} onPickFile={onPickFile} label="Drop your resume (PDF)" />
      <div className="field">
        <label htmlFor="profile-resume-text">…or paste your resume as text</label>
        <textarea
          id="profile-resume-text"
          className="profile-textarea"
          rows={3}
          placeholder="Paste the text of your CV here"
          value={resumeText}
          onChange={(e) => onResumeText(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="profile-github">GitHub username {editing ? "" : "(optional)"}</label>
        <input
          id="profile-github"
          type="text"
          placeholder="username"
          value={githubInput}
          onChange={(e) => onGithubInput(e.target.value)}
        />
      </div>
      <span className="profile-note">We only read public GitHub data. Nothing is shared with employers.</span>
      {formError ? (
        <span className="field-error" role="alert">
          {formError}
        </span>
      ) : null}
      <button className="btn btn-primary btn-block" type="button" onClick={onBuild}>
        {editing ? "Save changes" : "Build my profile"}
      </button>
    </div>
  );
}

function SavingState({
  sources,
  pdfName,
  github,
}: {
  sources: { resume: boolean; github: boolean };
  pdfName: string | null;
  github: string;
}) {
  return (
    <div className="profile-form">
      <h3>Building your profile…</h3>
      {sources.resume ? (
        <div className="file-row">
          <span style={{ flex: 1 }}>{pdfName ?? "Resume text"}</span>
          <span style={{ fontSize: 12, color: "var(--text-3)" }}>reading your resume…</span>
        </div>
      ) : null}
      <div className="skeleton" style={{ height: 13, width: "70%" }} />
      <div className="skeleton" style={{ height: 13, width: "45%" }} />
      {sources.github ? (
        <div className="file-row">
          <span style={{ flex: 1 }}>github.com/{github}</span>
          <span style={{ fontSize: 12, color: "var(--text-3)" }}>scanning public repos…</span>
        </div>
      ) : null}
      <button className="btn btn-primary btn-block" type="button" disabled>
        <span className="spinner" />
        Building…
      </button>
    </div>
  );
}

// The post-parse FULL profile (operator 039): the confirmation heading + the display-only expanded profile
// (identity header, source ticks, skills split by source, experience, OSS) + the two actions to keep wired.
function SavedState({
  profile,
  onFindJob,
  onEdit,
  onDelete,
}: {
  profile: Profile;
  onFindJob: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="profile-form">
      <h3>Profile saved ✓</h3>
      {/* Identity header - the headline role (the profile schema carries no name field). */}
      <div style={{ fontSize: "var(--fs-md)", fontWeight: 600, color: "var(--text)" }}>
        {profileTitle(profile)}
      </div>
      {/* The read-only full profile: subline, Sources (ticks), skills split by source, experience, OSS. */}
      <ProfileExpanded profile={profile} />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="chip chip-accent" type="button" onClick={onFindJob}>
          Find me a job that fits
        </button>
        <button className="chip" type="button" onClick={onEdit}>
          Edit &amp; re-save
        </button>
        <button className="btn btn-ghost btn-sm" type="button" style={{ color: "var(--danger)", marginLeft: "auto" }} onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

function GithubSkippedState({
  githubInput,
  onGithubInput,
  onRetry,
  onDelete,
}: {
  githubInput: string;
  onGithubInput: (v: string) => void;
  onRetry: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="profile-form">
      <h3>Profile saved — GitHub skipped</h3>
      <div className="file-row">
        <span style={{ flex: 1 }}>Resume</span>
        <span style={{ color: "var(--accent-ink)", fontWeight: 500 }}>Parsed ✓</span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          background: "var(--surface-2)",
          borderRadius: "var(--r-md)",
          padding: "9px 12px",
          fontSize: 12.5,
          color: "var(--text-2)",
        }}
      >
        We couldn’t verify skills from GitHub for this profile — check the username or try again.
      </div>
      <div className="field">
        <label htmlFor="profile-github-retry">GitHub username</label>
        <input
          id="profile-github-retry"
          type="text"
          value={githubInput}
          onChange={(e) => onGithubInput(e.target.value)}
        />
      </div>
      <button className="btn btn-primary btn-block" type="button" onClick={onRetry}>
        Retry GitHub
      </button>
      <button className="btn btn-ghost" type="button" style={{ color: "var(--danger)" }} onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

function ErrorState({
  hadProfile,
  inputRef,
  pdfName,
  onPickFile,
  onRetry,
}: {
  hadProfile: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
  pdfName: string | null;
  onPickFile: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRetry: () => void;
}) {
  return (
    <div className="profile-form">
      <h3>Couldn’t build the profile</h3>
      <div className="err-card" style={{ maxWidth: "100%" }}>
        I couldn’t read that PDF — try another file or paste the text.
        <button className="btn btn-outline btn-sm" type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
      <Dropzone inputRef={inputRef} pdfName={pdfName} onPickFile={onPickFile} label="Drop another resume (PDF)" />
      <span className="profile-note">
        {hadProfile ? "Your previous profile is untouched." : "Nothing was saved."}
      </span>
    </div>
  );
}
