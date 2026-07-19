// The E2E mode flag, resolved server-side only. Playwright starts the built app with JOBCHAT_E2E=1; the
// flag swaps the Bedrock-backed transport/actions for a scripted mock + fixtures so the client loop is
// exercisable with no Trigger.dev / ClickHouse / Bedrock. It is a RUNTIME server env (never a
// NEXT_PUBLIC build inline), so production bundles can never enter E2E mode - Server Components read it
// and pass it down as a prop.
export function isE2E(): boolean {
  return process.env.JOBCHAT_E2E === "1";
}
