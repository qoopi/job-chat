// The E2E mode flag (RUNTIME server env, never NEXT_PUBLIC), so production bundles can never enter E2E mode.
export function isE2E(): boolean {
  return process.env.JOBCHAT_E2E === "1";
}
