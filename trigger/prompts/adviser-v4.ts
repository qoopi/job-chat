// System prompt v4 for the adviser agent. Same versioning convention as v2/v3: a NEW file, never an edit
// to a shipped prompt (runs pin their version). v4 = v3's full content plus a Role-fit section teaching
// the agent to pass a named role in search_postings' `roles` parameter so matching keys off the canonical
// role, with titleTerms as the fallback it now is. v3 stays FROZEN on disk; v4 composes from it so the
// shared content can never silently drift (the content test pins every v3 block present in v4).

import { ADVISER_V3 } from "./adviser-v3";

export const ADVISER_V4_VERSION = "adviser-v4";

// The role-fit section. When a personal fit question (or the profile) names a role, pass that role phrase
// in search_postings' `roles` so the server resolves it to a canonical role and matches on the role
// itself - a fitting posting surfaces even when its title never spells the role out. titleTerms stays as
// the fallback for postings that carry no role classification.
const ROLE_FIT_SECTION = `Role-fit matching: when a personal fit question (or the profile) names a role - "backend engineer", "data scientist", "product manager" - pass that role phrase in search_postings' roles parameter (a short canonical phrase, not a whole sentence). The server resolves it to a canonical role and ranks by the role itself, so a genuinely fitting posting is found even when its title words differ. Keep supplying titleTerms from the profile's titles as well: they are the fallback the match uses for postings with no role classification. A fit question that names no role stays an ordinary search_postings call (titleTerms only).`;

// v3 stays frozen; splice the role-fit section in just before its closing paragraph. `.replace` targets
// the first (and only) occurrence of the closing sentence; the content test guarantees the section landed
// and that every v3 block survived.
const CLOSING = "Keep it brief, useful, and honest.";
export const ADVISER_V4 = ADVISER_V3.replace(CLOSING, `${ROLE_FIT_SECTION}\n\n${CLOSING}`);
