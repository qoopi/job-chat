import { LAUNCH_QUESTIONS } from "./launch-questions";

// The AC-5 conformance sample: 19 prompts = the 7 launch questions (data/chart mode) + 5 conversational
// prompts (plain mode) + 1 city-abbreviation phrasing (alias normalization) + 6 P2-intent phrasings
// (find-me-a-job / what-fits-me class - the adviser clarifies in plain mode, no card). The metric: every
// PLAIN-mode answer holds the contract tone - at most two sentences, no "!", no opener from the
// banned-filler list below. Run live in the dev round trip against Bedrock; the fixture + countSentences +
// startsWithBannedOpener are the shared harness, exercised deterministically in unit tests. This fixture
// is the ONE home for the sample and the banned-opener list - the 010 eval-set imports both.

export const CONVERSATIONAL_PROMPTS: string[] = [
  "Hey, what can you help me with?",
  "Is now a good time to be job hunting?",
  "What does 'hybrid' mean in these listings?",
  "Thanks, that's helpful!",
  "Should I negotiate my salary?",
];

// City-abbreviation phrasings: the model must expand the abbreviation (SF -> San Francisco) BEFORE
// calling a tool and answer with the outcome only (never narrate a retry). Rides the live conformance
// run so the prompt's alias rule is exercised end to end; a 0-row result must answer in plain prose.
export const ABBREVIATION_PROMPTS: string[] = [
  "What's the median salary for a Data Engineer in SF?",
];

// P2-intent phrasings (find-me-a-job / what-fits-me class): applying, matching, and personal fit are P2
// scope, so the adviser must hold the clarify-path tone - a short, warm redirect to what it CAN answer
// from the postings data, no exclamation and no filler opener. These exercise the v2 clarify-tone rules.
export const P2_INTENT_PROMPTS: string[] = [
  "Find me a job.",
  "What job fits me?",
  "Can you help me apply to a role?",
  "Which roles match my background?",
  "I'm looking for a new job - where do I start?",
  "Show me jobs I'd be good at.",
];

export const SAMPLE_PROMPTS: string[] = [
  ...LAUNCH_QUESTIONS.map((q) => q.question),
  ...CONVERSATIONAL_PROMPTS,
  ...ABBREVIATION_PROMPTS,
  ...P2_INTENT_PROMPTS,
];

// The banned-filler openers (AC-5) - phrases a plain/clarify reply must NOT open with. Enumerated here
// as the ONE home; prompt v2 mirrors the rule and the 010 eval-set imports this list for its format
// scoring. Stored lowercased, without trailing punctuation - matched at a word boundary.
export const BANNED_OPENERS: string[] = [
  "great question",
  "good question",
  "great",
  "sure",
  "certainly",
  "absolutely",
  "of course",
  "happy to help",
  "i'd be happy to",
  "i would be happy to",
  "let me",
  "well",
  "so",
  "as an ai",
  "interesting question",
  "thanks for asking",
];

/** Count sentences by terminal punctuation - the AC-5 conformance metric (plain answers <= 2). */
export function countSentences(text: string): number {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

/**
 * AC-5 tone check: does a reply open with a banned filler phrase? Matched case-insensitively at the very
 * start, at a word boundary so an opener never trips a longer real word ("great" flags "Great question",
 * not "Greater Boston"; "so" flags "So, ..." not "Software roles").
 */
export function startsWithBannedOpener(text: string): boolean {
  const trimmed = text.trimStart();
  return BANNED_OPENERS.some((opener) =>
    new RegExp(`^${opener.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(trimmed),
  );
}
