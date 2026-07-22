import type { Profile } from "@shared/profile";
import type { MyProfile } from "@/app/actions";
import { isGithubSkipped } from "@/lib/profile-format";

// The save poll's terminating core (pure). After the save returns a runId, the panel polls until ONE of:
// extracted_at advanced -> success; extraction_failed -> error; the run reached FAILED (re-save edge) -> error; the ceiling -> error.

const DEFAULT_INTERVAL_MS = 1500;
const DEFAULT_MAX_ATTEMPTS = 40; // ~60s ceiling at the default interval

export interface PollDeps {
  getMyProfile: () => Promise<MyProfile | null>;
  getRunStatus: (runId: string) => Promise<{ status: "pending" | "done" | "failed" }>;
  sleep: (ms: number) => Promise<void>;
}

export interface PollParams {
  runId: string;
  priorExtractedAt: string | null;
  hadPriorProfile: boolean;
  intervalMs?: number;
  maxAttempts?: number;
}

export type PollOutcome =
  | { outcome: "saved"; profile: Profile; githubUsername: string | null }
  | { outcome: "github-skipped"; profile: Profile; githubUsername: string | null }
  | { outcome: "error"; hadPriorProfile: boolean };

/** saved vs github-skipped: skipped when a username was given but no skill came back proven in code. */
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
    // The run status is load-bearing ONLY for the re-save edge (a fresh save terminates via extractionFailed or
    // the ceiling), so skip the round trip otherwise. FAILED ends the poll; COMPLETED-but-not-advanced is write lag.
    if (params.hadPriorProfile) {
      const run = await deps.getRunStatus(params.runId);
      if (run.status === "failed") return fail();
    }
  }
  return fail(); // ceiling reached - terminate rather than poll forever
}
