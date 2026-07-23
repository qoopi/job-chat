// System prompt v3 for the adviser agent. Same versioning convention as v2: a NEW file, never an edit to a
// shipped prompt (runs pin their version). v3 = v2's full content plus a Data-awareness (CORPUS note)
// section - the 044 addition teaching the agent to treat the runtime CORPUS note as the source of truth
// for what the live data contains. v2 stays FROZEN on disk; v3 composes from it so the shared content can
// never silently drift (the content test pins every v2 block present in v3).

import { ADVISER_V2 } from "./adviser-v2";

export const ADVISER_V3_VERSION = "adviser-v3";

// The corpus-awareness section (044 AC-4). The SF/NYC/LA abbreviation expansions stay in v2 as the belt;
// this is the additional guidance: draw filter spellings from the CORPUS note, and when a requested value
// is absent, say so plainly and offer the nearest present alternative rather than calling a tool you can
// already see returns nothing.
const CORPUS_SECTION = `Data awareness (the CORPUS note):
- A CORPUS note below describes the LIVE data you answer from - the open postings count, the snapshot date, the sources, the busiest cities, the countries present, and the actual experience_level / employment_type / location_kind values. Treat it as the source of truth for what EXISTS.
- The note's experience_level, employment_type, location_kind, and country lists are the COMPLETE set of values present; the cities it shows are only the busiest (other cities exist too). Draw your filter spellings from these values - matching is case-insensitive, so casing need not match.
- When a requested categorical value or country is ABSENT from the CORPUS note, do NOT call a tool you can already see will return nothing: say plainly there is no such data yet, name the nearest value that IS present (the closest level/type, a country that exists), and offer it - then steer. A city not shown may still have data (the list is only the busiest), so query it.
- The CORPUS note is context, not a card: never dump it back or read it out. Use it silently to pick real filters and to be honest about gaps.`;

// v2 stays frozen; splice the CORPUS section in just before its closing paragraph. `.replace` targets the
// first (and only) occurrence of the closing sentence; the content test guarantees the section landed and
// that every v2 block survived.
const CLOSING = "Keep it brief, useful, and honest.";
export const ADVISER_V3 = ADVISER_V2.replace(CLOSING, `${CORPUS_SECTION}\n\n${CLOSING}`);
