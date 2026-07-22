import type { Profile } from "@shared/profile";
import type { MyProfile } from "@/app/actions";
import { isGithubSkipped } from "@/lib/profile-format";

// The save poll's terminating core, extracted pure so its exit conditions - success, github-skipped,
// and every FAILURE path including the re-save edge - are unit-testable without React or real timers.
// After the save action returns a runId, the panel polls until ONE of:
//  - `extracted_at` advanced past its pre-save value  -> success (saved / github-skipped)
//  - `extraction_failed` flipped                       -> error (fresh-save failure)
//  - the run reached a terminal FAILED state (via runId)-> error (re-save-with-prior-profile edge:
//    the marker can't flip when a profile already exists, so the run status is the only terminal signal)
//  - the attempt ceiling is reached                    -> error (final backstop; never an infinite poll)

const DEFAULT_INTERVAL_MS = 1500;
const DEFAULT_MAX_ATTEMPTS = 40; // ~60s ceiling at the default interval

export interface PollDeps {
  getMyProfile: () => Promise<MyProfile | null>;
  getRunStatus: (runId: string) => Promise<{ status: "pending" | "done" | "failed" }>;
  /** Injectable so tests resolve instantly; production passes a real setTimeout sleep. */
  sleep: (ms: number) => Promise<void>;
}

export interface PollParams {
  runId: string;
  /** `extracted_at` BEFORE this save - success is when the polled value advances past it. */
  priorExtractedAt: string | null;
  /** Whether a profile already existed (drives the error copy: "previous profile untouched"). */
  hadPriorProfile: boolean;
  intervalMs?: number;
  maxAttempts?: number;
}

export type PollOutcome =
  | { outcome: "saved"; profile: Profile; githubUsername: string | null }
  | { outcome: "github-skipped"; profile: Profile; githubUsername: string | null }
  | { outcome: "error"; hadPriorProfile: boolean };

/** Classify a completed extraction into saved vs github-skipped: skipped when a username was given but
 *  no skill came back proven in code (the enrichment produced nothing). */
function classifySuccess(profile: Profile, githubUsername: string | null): PollOutcome {
  const skipped = githubUsername != null && isGithubSkipped(profile);
  return { outcome: skipped ? "github-skipped" : "saved", profile, githubUsername };
}

export async function pollProfileSave(deps: PollDeps, params: PollParams): Promise<PollOutcome> {
  const interval = params.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const fail = (): PollOutcome => ({ outcome: "error", hadPriorProfile: params.hadPriorProfile });

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await deps.sleep(interval);
    const my = await deps.getMyProfile();
    if (my) {
      const advanced = my.extractedAt !== null && my.extractedAt !== params.priorExtractedAt;
      if (advanced && my.profile) return classifySuccess(my.profile, my.githubUsername);
      if (my.extractionFailed) return fail();
    }
    // Not done via the profile read yet - consult the run. A terminal FAILED run ends the poll here (the
    // re-save edge); COMPLETED without an advanced `extracted_at` yet is DB-write lag, so loop once more.
    const run = await deps.getRunStatus(params.runId);
    if (run.status === "failed") return fail();
  }
  return fail(); // ceiling reached - terminate rather than poll forever
}
