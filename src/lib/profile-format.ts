import type { Profile, Skill } from "@shared/profile";
import { formatMoney } from "@/lib/insight-format";

export function profileTitle(profile: Profile): string {
  return profile.titles[0] ?? "Job seeker";
}

export function salaryTarget(profile: Profile): string | null {
  return profile.salaryMin != null ? `target ${formatMoney(profile.salaryMin)}+` : null;
}

/** The identity sub-line (compact or expanded); each segment is dropped when unknown, so a sparse profile never renders a dangling separator. */
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

/** Skills split by provenance: github-proven first, resume-claimed after; source "both" counts as proven. */
export function splitSkills(profile: Profile): { proven: Skill[]; claimed: Skill[] } {
  return {
    proven: profile.skills.filter((s) => s.source !== "resume"),
    claimed: profile.skills.filter((s) => s.source === "resume"),
  };
}

/** "GitHub skipped" signal: no skill proven in code (no username or unreadable), so the card shows a neutral row + a note (never an error). */
export function isGithubSkipped(profile: Profile): boolean {
  return !profile.skills.some((s) => s.source !== "resume");
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function profileSummary(profile: Profile): string {
  const proven = splitSkills(profile).proven.length;
  return `${plural(profile.skills.length, "skill")} (${proven} proven in code) · ${plural(
    profile.domains.length,
    "domain",
  )} · ${plural(profile.ossHighlights.length, "OSS highlight")}`;
}
