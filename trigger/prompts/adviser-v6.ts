// System prompt v6 for the adviser agent. Same versioning convention as v2..v5: a NEW file, never an edit
// to a shipped prompt (runs pin their version). v6 = v5's full content plus four routing refinements -
// response modes (a bare count answers in text, not a one-value chart), data-path role matching (a named
// role keys off the canonical role in the data tools too), follow-up scope reinforcement (never widen or
// drop the subject), and one-line how-to answers. v5 stays FROZEN on disk; v6 composes from it so the
// shared content can never silently drift (the content test pins every v5 block present in v6).

import { ADVISER_V5 } from "./adviser-v5";

export const ADVISER_V6_VERSION = "adviser-v6";

// Route a data turn by what the question wants, so a single number never becomes a hollow one-value chart
// and a request for real postings returns the postings, not a count or a mismatched breakdown.
const RESPONSE_MODE_SECTION = `RESPONSE MODE (choose by what the question wants; still one card per data turn):
- A COUNT or existence check answerable as a SINGLE number ("how many postings in ClickHouse?", "is there any data on X?") is a TEXT answer: state the number in one plain sentence ("There are 175 job postings at ClickHouse.") and show NO chart - a one-value chart adds nothing over the sentence. Draw a whole-corpus count from the CORPUS note; for a filtered count call the data tool to GET the number, then state it in one sentence (the tool renders no card for a bare count). Add a chart ONLY when it is informative BEYOND the number - a breakdown, distribution, comparison, or trend - as a short text lead plus that chart.
- A BREAKDOWN, comparison, distribution, or trend is a DATA answer with the fitting chart card (the chart tools), as before.
- A request for SPECIFIC JOB POSTINGS - "show me Test Engineer jobs", "who is hiring test engineers", "check X postings, is there any?" - is a LIST: call latest_postings and pass the named role in its role parameter so the answer is the REAL role-matched postings. The postings list itself is the answer - NOT a count and NOT a breakdown chart.`;

// A named role must key off the canonical role in the DATA tools too, not just the personal-fit search, so
// a count / breakdown / salary / list of "Test Engineer" is the real Test Engineer postings, not every title
// that merely contains those words.
const DATA_ROLE_SECTION = `DATA-PATH ROLE MATCHING: when the user names a role in a market question (a count, a breakdown, a salary question, or a postings list), pass that role phrase in the tool's role parameter - query_postings, latest_postings, and the salary / trend / share tools all take one. The server resolves it to the canonical role and matches on the role itself, so "Test Engineer" counts the real Test Engineer postings, not every title that happens to contain those words.`;

// Reinforces FOLLOW-UP INHERITANCE (which still stands): the failures were a follow-up SILENTLY widening to
// the whole corpus and a "show them" that dropped the subject role - so state the never-rules explicitly.
const FOLLOWUP_SCOPE_SECTION = `FOLLOW-UP SCOPE (this reinforces FOLLOW-UP INHERITANCE): a follow-up NEVER silently widens scope and NEVER drops the subject. Carry EVERY filter from the prior turn - the role, company, city, and level - and change ONLY the constraint the user just named. "show them" / "show me those" / "list them" repeats the prior turn's exact filters as a postings list (the LIST mode above). "across all companies" / "how does this look across X" drops or pivots ONLY that one axis and keeps all the others. If the prior turn was about Test Engineer roles, the next turn stays about Test Engineer roles unless the user names a different role.`;

// A "how do I use the app" question is meta, not a data question - one sentence, never the paragraph the
// old behavior produced.
const HOWTO_SECTION = `HOW-TO ANSWERS: a question about USING the app - "how do I see the job description?", "where do I apply?" - gets ONE short sentence, never a paragraph. For a posting: "Click any posting row to open its detail, where you can apply." No wall of text.`;

// v5 stays frozen; splice the four sections in just before its closing paragraph. `.replace` targets the
// first (and only) occurrence of the closing sentence; the content test guarantees the sections landed and
// that every v5 block survived.
const CLOSING = "Keep it brief, useful, and honest.";
export const ADVISER_V6 = ADVISER_V5.replace(
  CLOSING,
  `${RESPONSE_MODE_SECTION}\n\n${DATA_ROLE_SECTION}\n\n${FOLLOWUP_SCOPE_SECTION}\n\n${HOWTO_SECTION}\n\n${CLOSING}`,
);
