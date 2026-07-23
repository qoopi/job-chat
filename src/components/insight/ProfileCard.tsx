"use client";

import { useState } from "react";
import type { Experience, Profile, Skill } from "@shared/profile";
import { isGithubSkipped, profileSubline, profileTitle, splitSkills } from "@/lib/profile-format";

// The profile card (an InsightCard child, no tabs). Two surfaces: ProfileCard (in-chat compact) and
// ProfileExpanded (detail panel full view, READ-ONLY). Everything derives from the one `Profile` payload.

const MAX_SKILLS = 6; // cap the in-chat skill row (proven first)

/** The 10px "proven in code" check that rides inside a github-proven `.tag`. */
function CheckMark() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <path d="M1.5 5.5l2.5 2.5 4.5-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The merged-PR / branch glyph beside an OSS highlight line. */
function BranchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden style={{ flexShrink: 0, color: "var(--text-3)" }}>
      <circle cx="4" cy="4" r="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="12" r="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="8" r="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 6v4M6 4c4 0 4 4 4 4" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** The info circle for the (informational, not error) GitHub-skipped note. */
function InfoCircle() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden style={{ flexShrink: 0, color: "var(--text-3)" }}>
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 5v3.4M8 10.8v.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** A github-proven skill: accent `.tag` + the ✓. */
function ProvenTag({ skill }: { skill: Skill }) {
  return (
    <span className="tag">
      {skill.name}
      <CheckMark />
    </span>
  );
}

/** A resume-claimed skill (or, with `domain`, a "Works on" pill rendered in --text). */
function ClaimedPill({ label, domain = false }: { label: string; domain?: boolean }) {
  return (
    <span className="skill-claimed" style={domain ? { color: "var(--text)" } : undefined}>
      {label}
    </span>
  );
}

/** The identity verdict shared by both variants: `<b>{title}</b> — {subline}`. */
function IdentityVerdict({ profile }: { profile: Profile }) {
  const subline = profileSubline(profile);
  return (
    <p className="verdict">
      <b>{profileTitle(profile)}</b>
      {subline ? ` — ${subline}` : ""}
    </p>
  );
}

export function ProfileCard({
  profile,
  onFollowup,
  onEdit,
  onOpenPanel,
  pending = false,
}: {
  profile: Profile;
  /** Send a follow-up ("Find me a job that fits"). Disabled while a turn streams. */
  onFollowup?: (text: string) => void;
  /** "Edit profile" / "Add GitHub" - opens the detail panel profile form. */
  onEdit?: () => void;
  /** "Open in panel →" - opens the detail panel expanded profile view. */
  onOpenPanel?: () => void;
  pending?: boolean;
}) {
  const skipped = isGithubSkipped(profile);
  const { proven, claimed } = splitSkills(profile);
  const skills = [...proven, ...claimed].slice(0, MAX_SKILLS);
  const oss = profile.ossHighlights[0];

  return (
    <div className="insight">
      <div className="insight-head">
        <IdentityVerdict profile={profile} />
      </div>
      <div className="insight-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {skipped ? (
          <>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {skills.map((s) => (
                <ClaimedPill key={s.name} label={s.name} />
              ))}
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
              <InfoCircle />
              We couldn’t verify skills from GitHub for this profile — check the username or try again.
              <button className="link-accent" type="button" onClick={onEdit} style={{ marginLeft: "auto", flexShrink: 0 }}>
                Add GitHub
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <span className="micro">Skills</span>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                {skills.map((s) =>
                  s.source === "resume" ? (
                    <ClaimedPill key={s.name} label={s.name} />
                  ) : (
                    <ProvenTag key={s.name} skill={s} />
                  ),
                )}
              </div>
              <span style={{ fontSize: 11, color: "var(--text-3)" }}>
                green ✓ = proven in their GitHub code · grey = from the resume
              </span>
            </div>
            {profile.domains.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                <span className="micro">Works on</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {profile.domains.map((d) => (
                    <ClaimedPill key={d} label={d} domain />
                  ))}
                </div>
              </div>
            ) : null}
            {oss ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-2)" }}>
                <BranchIcon />
                {oss}
              </div>
            ) : null}
          </>
        )}
      </div>
      <div className="insight-foot">
        <div className="followups">
          <button
            className="chip chip-accent"
            type="button"
            disabled={pending}
            onClick={() => onFollowup?.("Find me a job that fits")}
          >
            Find me a job that fits
          </button>
          <button className="chip" type="button" onClick={onEdit}>
            Edit profile
          </button>
        </div>
        <span className="src">
          {skipped ? "from resume · " : "from resume + GitHub · "}
          <button className="src-link" type="button" onClick={onOpenPanel}>
            Open in panel →
          </button>
        </span>
      </div>
    </div>
  );
}

const MAX_BULLETS = 3; // experience bullets shown before "Show N more" (per role)
const MAX_ROLES = 2; // experience entries shown before "Show N more" (operator 039)

/** The quiet accent "Show N more" text-button, shared by the per-role bullet toggle and the experience-list toggle. */
const showMoreStyle: React.CSSProperties = {
  alignSelf: "flex-start",
  border: 0,
  background: "none",
  padding: 0,
  font: "inherit",
  fontSize: 12,
  fontWeight: 500,
  color: "var(--accent-ink)",
  cursor: "pointer",
};

/** One experience role: header line + up to 3 bullets, the rest behind a per-role toggle. */
function ExperienceEntry({ entry }: { entry: Experience }) {
  const [open, setOpen] = useState(false);
  const shown = open ? entry.bullets : entry.bullets.slice(0, MAX_BULLETS);
  const hidden = entry.bullets.length - shown.length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span>
        <strong style={{ color: "var(--text)" }}>{entry.title}</strong>
        {entry.company ? ` · ${entry.company}` : ""}
        {entry.years ? ` · ${entry.years}` : ""}
      </span>
      {shown.map((b, i) => (
        <span key={i}>· {b}</span>
      ))}
      {hidden > 0 ? (
        <button type="button" onClick={() => setOpen(true)} style={showMoreStyle}>
          Show {hidden} more ↓
        </button>
      ) : null}
    </div>
  );
}

/** The experience list: the first 2 roles, the rest behind a "Show N more" collapse (operator 039). */
function ExperienceList({ entries }: { entries: Experience[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? entries : entries.slice(0, MAX_ROLES);
  const hidden = entries.length - shown.length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13, color: "var(--text-2)" }}>
      {shown.map((e, i) => (
        <ExperienceEntry key={i} entry={e} />
      ))}
      {hidden > 0 ? (
        <button type="button" onClick={() => setOpen(true)} style={showMoreStyle}>
          Show {hidden} more role{hidden === 1 ? "" : "s"} ↓
        </button>
      ) : null}
    </div>
  );
}

/** A read-only sub-section wrapper: a `.micro` label + its content. */
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <span className="micro">{label}</span>
      {children}
    </div>
  );
}

export function ProfileExpanded({ profile }: { profile: Profile }) {
  const { proven, claimed } = splitSkills(profile);
  const subline = profileSubline(profile, { expanded: true });
  const skipped = isGithubSkipped(profile);
  return (
    <div className="profile-expanded" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {subline ? <div style={{ fontSize: 13, color: "var(--text-2)" }}>{subline}</div> : null}

      <Section label="Sources">
        <div className="file-row">
          <span style={{ flex: 1 }}>Resume</span>
          <span style={{ color: "var(--accent-ink)", fontWeight: 500 }}>Parsed ✓</span>
        </div>
        {!skipped ? (
          <div className="file-row">
            <span style={{ flex: 1 }}>Public GitHub</span>
            <span style={{ color: "var(--accent-ink)", fontWeight: 500 }}>Read ✓</span>
          </div>
        ) : null}
        <span style={{ fontSize: 11, color: "var(--text-3)" }}>We only read public GitHub data.</span>
      </Section>

      {proven.length > 0 ? (
        <Section label="Skills — proven in code">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {proven.map((s) => (
              <ProvenTag key={s.name} skill={s} />
            ))}
          </div>
        </Section>
      ) : null}

      {claimed.length > 0 ? (
        <Section label="Skills — from the resume">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {claimed.map((s) => (
              <ClaimedPill key={s.name} label={s.name} />
            ))}
          </div>
        </Section>
      ) : null}

      {profile.domains.length > 0 ? (
        <Section label="Works on">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {profile.domains.map((d) => (
              <ClaimedPill key={d} label={d} domain />
            ))}
          </div>
        </Section>
      ) : null}

      {profile.experience.length > 0 ? (
        <Section label="Experience — from the resume">
          <ExperienceList entries={profile.experience} />
        </Section>
      ) : null}

      {profile.ossHighlights.length > 0 ? (
        <Section label="Open-source highlights">
          <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "var(--text-2)" }}>
            {profile.ossHighlights.map((h, i) => (
              <span key={i}>· {h}</span>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}
