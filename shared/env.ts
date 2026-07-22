import { z } from "zod";

// Session guards; coerced (process.env is strings). SIGNED_IN cap must be mirrored in Trigger - the run() backstop checks it there.
const GuardsEnvSchema = z.object({
  GUEST_MESSAGE_CAP: z.coerce.number().int().positive().default(10),
  SIGNED_IN_MESSAGE_CAP: z.coerce.number().int().positive().default(30),
  DAILY_MESSAGE_BUDGET: z.coerce.number().int().positive().default(200),
});

const AgentLimitsEnvSchema = z.object({
  AGENT_MAX_TURNS: z.coerce.number().int().positive().default(10),
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(8),
});

export interface GuardConfig {
  guestCap: number;
  /** Higher per-user cap for accounts; optional so test literals stay terse. Unset => falls back to
   *  `guestCap` (fail-safe, the lower cap); getGuardConfig always sets it in production. */
  signedInCap?: number;
  dailyBudget: number;
}

/** Validates only the guards env slice (ISP) - callers need no ClickHouse/AWS creds. */
export function getGuardConfig(
  source: Record<string, string | undefined> = process.env,
): GuardConfig {
  const env = GuardsEnvSchema.parse(source);
  return {
    guestCap: env.GUEST_MESSAGE_CAP,
    signedInCap: env.SIGNED_IN_MESSAGE_CAP,
    dailyBudget: env.DAILY_MESSAGE_BUDGET,
  };
}

export interface AgentLimits {
  maxTurns: number;
  maxSteps: number;
}

export function getAgentLimits(
  source: Record<string, string | undefined> = process.env,
): AgentLimits {
  const env = AgentLimitsEnvSchema.parse(source);
  return { maxTurns: env.AGENT_MAX_TURNS, maxSteps: env.AGENT_MAX_STEPS };
}
