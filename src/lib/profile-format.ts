import type { Profile, Skill } from "@shared/profile";
import { formatMoney } from "@/lib/insight-format";

// Pure presentation helpers for the profile surfaces (the in-chat card, the LCP expanded view, the
// form's saved summary). Kept free of React so the copy contracts - the identity verdict, the skill
// split, the "github skipped" signal, the summary counts - are unit-testable in isolation and the two
// card variants + the form never derive them differently.

/** The identity title: the primary extracted job title, or a neutral fallback when none was parsed. */
export function profileTitle(profile: Profile): string {
  return profile.titles[0] ?? "Job seeker";
}

/** `target $120k+`, or null when no minimum salary was extracted (the LCP sub-line only). */
export function salaryTarget(profile: Profile): string | null {
  return profile.salaryMin != null ? `target ${formatMoney(profile.salaryMin)}+` : null;
}

/**
 * The identity sub-line: `8 years · Berlin · open to remote` (compact) or, expanded, all locations plus
 * the target salary (`8 years · Berlin or Munich · open to remote · target $120k+`). Each segment is
 * dropped when its datum is unknown, so a sparse profile never renders a dangling separator.
 */
export function profileSubline(profile: Profile, opts: { expanded?: boolean } = {}): string {
  const parts: string[] = [];
  if (profile.yearsExp != null) parts.push(`${profile.yearsExp} years`);
  const locations = opts.expanded ? profile.locations.join(" or ") : profile.locations[0];
  if (locations) parts.push(locations);
  if (profile.remotePref === true) parts.push("open to remote");
  if (opts.expanded) {
    const salary = salaryTarget(profile);
    if (salary) parts.push(salary);
  }
  return parts.join(" · ");
}

/** The skills split by provenance: github-proven (accent tag + ✓) first, resume-claimed (neutral pill)
 *  after. `source: "both"` counts as proven (it IS in their code). */
export function splitSkills(profile: Profile): { proven: Skill[]; claimed: Skill[] } {
  return {
    proven: profile.skills.filter((s) => s.source !== "resume"),
    claimed: profile.skills.filter((s) => s.source === "resume"),
  };
}

/**
 * "GitHub skipped" presentation signal: the profile carries NO skill proven in code. Enrichment either
 * had no username or could not be read, so the card drops the proven/claimed split for a single neutral
 * skill row + an informational "add your username" note (never an error - the profile still works).
 */
export function isGithubSkipped(profile: Profile): boolean {
  return !profile.skills.some((s) => s.source !== "resume");
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The form's saved summary counts line: `6 skills (4 proven in code) · 2 domains · 3 OSS highlights`. */
export function profileSummary(profile: Profile): string {
  const proven = splitSkills(profile).proven.length;
  return `${plural(profile.skills.length, "skill")} (${proven} proven in code) · ${plural(
    profile.domains.length,
    "domain",
  )} · ${plural(profile.ossHighlights.length, "OSS highlight")}`;
}
