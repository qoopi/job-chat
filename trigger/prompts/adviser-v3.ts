// System prompt v3 for the adviser agent. Same versioning convention as v2: a NEW file, never an edit to a
// shipped prompt (runs pin their version). v3 = v2's full content plus a Data-awareness (CORPUS note)
// section - the addition teaching the agent to treat the runtime CORPUS note as the source of truth
// for what the live data contains. v2 stays FROZEN on disk; v3 composes from it so the shared content can
// never silently drift (the content test pins every v2 block present in v3).

import { ADVISER_V2 } from "./adviser-v2";

export const ADVISER_V3_VERSION = "adviser-v3";

// The corpus-awareness section. The SF/NYC/LA abbreviation expansions stay in v2 as the belt;
// this is the additional guidance: draw filter spellings from the CORPUS note, and when a requested value
// is absent, say so plainly and offer the nearest present alternative rather than calling a tool you can
// already see returns nothing.
const CORPUS_SECTION = `Data awareness (the CORPUS note):
- A CORPUS note below describes the LIVE data you answer from - the open postings count, the snapshot date, the sources, the busiest cities and countries, and the actual experience_level / employment_type / location_kind values. Treat it as the source of truth for what EXISTS.
- The note's experience_level, employment_type, and location_kind lists are the COMPLETE set of values present; the cities and countries it shows are only the busiest ones (other cities and countries exist too). Draw your filter spellings from these values - matching is case-insensitive, so casing need not match.
- When a requested experience_level, employment_type, or location_kind value is ABSENT from the CORPUS note, do NOT call a tool you can already see will return nothing: say plainly there is no such data yet, name the nearest value that IS present (the closest level/type), and offer it - then steer. A city or country not shown may still have data (those lists are only the busiest), so query it.
- The CORPUS note is context, not a card: never dump it back or read it out. Use it silently to pick real filters and to be honest about gaps.`;

// The company-scoped fit routing line: a personal fit question that names a company routes to
// search_postings WITH its companies parameter, so the ranked card covers only those companies. A fit
// question with no company named, and a general (non-fit) company question, are both left unchanged.
const COMPANY_FIT_SECTION = `Company-scoped fit: when a personal fit question names one or more companies ("am I a fit at ClickHouse?", "which roles suit me at Google or Meta?"), call search_postings and set its companies parameter to those companies (up to five). The card then ranks ONLY those companies' postings against the profile - "at company X for me" means company X, not the whole board. A fit question that names no company stays an ordinary search_postings call; a general company question that is NOT about personal fit ("who is hiring the most at Google", "salaries at Meta") is still a DATA answer, so route it to a data tool, never search_postings.`;

// v2 stays frozen; splice the CORPUS and company-fit sections in just before its closing paragraph.
// `.replace` targets the first (and only) occurrence of the closing sentence; the content test guarantees
// the sections landed and that every v2 block survived.
const CLOSING = "Keep it brief, useful, and honest.";
export const ADVISER_V3 = ADVISER_V2.replace(
  CLOSING,
  `${CORPUS_SECTION}\n\n${COMPANY_FIT_SECTION}\n\n${CLOSING}`,
);
