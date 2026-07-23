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

/** Compose the single free-text "Location" field from the structured prefs: physical locations joined
 *  with " or ", plus a trailing "remote" when remotePref is set. "" when nothing is set. The inverse of
 *  parseLocationPref, so seeding the input then saving is a round-trip. */
export function formatLocationPref(profile: Pick<Profile, "locations" | "remotePref">): string {
  const parts = [...profile.locations];
  if (profile.remotePref === true) parts.push("remote");
  return parts.join(" or ");
}

/** Parse the free-text "Location" field back into the structured prefs. A "remote" token (word-boundary,
 *  case-insensitive) sets remotePref and is dropped from the physical locations; the rest split on
 *  comma / slash / " or ", each trimmed, empties dropped, deduped case-insensitively. Empty text clears
 *  both (locations [], remotePref null). One home for the salary/location edit -> schema mapping. */
export function parseLocationPref(text: string): { locations: string[]; remotePref: boolean | null } {
  const trimmed = text.trim();
  if (!trimmed) return { locations: [], remotePref: null };
  const remotePref = /\bremote\b/i.test(trimmed);
  const seen = new Set<string>();
  const locations: string[] = [];
  for (const raw of trimmed.split(/\s*(?:,|\/|\bor\b)\s*/i)) {
    const loc = raw.trim();
    if (!loc || /^remote$/i.test(loc)) continue;
    const key = loc.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push(loc);
  }
  return { locations, remotePref };
}
