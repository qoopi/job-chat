import { LAUNCH_QUESTIONS } from "./launch-questions";

// The AC-5 conformance sample: 13 prompts = the 7 launch questions (data/chart mode) + 5 conversational
// prompts (plain mode) + 1 city-abbreviation phrasing (alias normalization). The metric: every
// PLAIN-mode answer is at most two sentences. This is the first measurement (no prior baseline), run
// live in the dev round trip against Bedrock; the fixture + countSentences are the shared harness,
// exercised deterministically in unit tests.

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

export const SAMPLE_PROMPTS: string[] = [
  ...LAUNCH_QUESTIONS.map((q) => q.question),
  ...CONVERSATIONAL_PROMPTS,
  ...ABBREVIATION_PROMPTS,
];

/** Count sentences by terminal punctuation - the AC-5 conformance metric (plain answers <= 2). */
export function countSentences(text: string): number {
  return text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}
