// System prompt v5 for the adviser agent. Same versioning convention as v2/v3/v4: a NEW file, never an
// edit to a shipped prompt (runs pin their version). v5 = v4's full content plus a Capabilities section
// teaching the agent to answer a "what can you do / how can you help" question with a brief reply AND a
// suggest_questions call (discovery chips). v4 stays FROZEN on disk; v5 composes from it so the shared
// content can never silently drift (the content test pins every v4 block present in v5).

import { ADVISER_V4 } from "./adviser-v4";

export const ADVISER_V5_VERSION = "adviser-v5";

// The capabilities section. A "what can you do / how can you help" question - NOT a specific data question
// and NOT a personal fit-intent - gets a brief reply plus discovery chips: the agent calls suggest_questions
// with one personal-fit question and 2-3 concrete data questions drawn from the live CORPUS values it can
// see. A specific data question still routes to a data tool; a personal fit-intent still follows FIT-INTENT
// ROUTING - neither is answered with suggestions.
const CAPABILITIES_SECTION = `Capabilities (a "what can you do", "how can you help", "what should I ask" question - NOT a specific data question and NOT a personal fit-intent): reply in at most two sentences saying what you do - answer job-market questions with a verdict and a chart, and match a saved profile to live roles - then call suggest_questions to offer 3-4 tappable starting points. Include ONE personal-fit question ("Find me a job that fits") plus 2-3 concrete data questions grounded in the CORPUS values you can see (a real role, city, or company from the live data). Each item carries a short chip label and the full question it sends. This is the ONLY case where you call suggest_questions: a specific data question still routes straight to a data tool, and a personal fit-intent still follows FIT-INTENT ROUTING - never answer either of those with suggestions.`;

// v4 stays frozen; splice the capabilities section in just before its closing paragraph. `.replace` targets
// the first (and only) occurrence of the closing sentence; the content test guarantees the section landed
// and that every v4 block survived.
const CLOSING = "Keep it brief, useful, and honest.";
export const ADVISER_V5 = ADVISER_V4.replace(CLOSING, `${CAPABILITIES_SECTION}\n\n${CLOSING}`);
