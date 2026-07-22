import { z } from "zod";
import { ClickhouseEnvSchema, ClickhouseRoEnvSchema } from "./clickhouse";
import { SearchnapplyEnvSchema } from "./searchnapply";

// The full env schema, composed from the per-domain slices rather than
// re-listing every key here: ClickHouse (writer + read-only) and searchnapply own their own shapes.
// This file adds the vars no domain owns - Trigger, Postgres, Bedrock/AWS - plus the runtime
// guards. Required at runtime use, never validated at build/import time (the build must pass with no
// .env).
const BaseEnvSchema = z.object({
  TRIGGER_SECRET_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
});

// Bedrock invokes the eu. Claude inference profile. Locally the keys are empty and creds come from
// the AWS default profile chain (the agent uses fromNodeProviderChain), so getEnv() - which requires
// them - is the strict all-present validator, not the agent's credential path.
const BedrockEnvSchema = z.object({
  AWS_REGION: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
});

// The session guards (guest cap, signed-in cap, global daily budget). Env-tunable, conservative
// defaults until prod traffic is understood. Coerced because process.env
// values are strings. SIGNED_IN_MESSAGE_CAP is the higher per-user cap for accounts; auth never runs
// in the agent, but the run() backstop's cap check does, so mirror it in Trigger too.
const GuardsEnvSchema = z.object({
  GUEST_MESSAGE_CAP: z.coerce.number().int().positive().default(10),
  SIGNED_IN_MESSAGE_CAP: z.coerce.number().int().positive().default(30),
  DAILY_MESSAGE_BUDGET: z.coerce.number().int().positive().default(200),
});

// The agent loop ceilings. Same coercion + conservative defaults.
const AgentLimitsEnvSchema = z.object({
  AGENT_MAX_TURNS: z.coerce.number().int().positive().default(10),
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(8),
});

const schema = z.object({
  ...BaseEnvSchema.shape,
  ...ClickhouseEnvSchema.shape,
  ...ClickhouseRoEnvSchema.shape,
  ...BedrockEnvSchema.shape,
  ...SearchnapplyEnvSchema.shape,
  ...GuardsEnvSchema.shape,
  ...AgentLimitsEnvSchema.shape,
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function getEnv(
  source: Record<string, string | undefined> = process.env,
): Env {
  if (!cached) {
    const parsed = schema.safeParse(source);
    if (!parsed.success) {
      const missing = parsed.error.issues
        .map((i) => i.path.join("."))
        .join(", ");
      throw new Error(`Missing or invalid environment variables: ${missing}`);
    }
    cached = parsed.data;
  }
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}

export interface GuardConfig {
  guestCap: number;
  /**
   * The higher per-user cap for signed-in accounts. Optional here only so terse test guard
   * literals that exercise the guest path stay uncluttered; `getGuardConfig` ALWAYS sets it in
   * production. When unset, cap selection falls back to `guestCap` (fail-safe - the lower cap).
   */
  signedInCap?: number;
  dailyBudget: number;
}

/**
 * The session guards, validating only their own env slice (ISP) so callers need no ClickHouse/AWS
 * creds. Unset vars fall back to the epic's conservative defaults.
 */
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

/**
 * The agent loop ceilings, validating only their own env slice. Unset vars fall back to the
 * defaults (maxTurns 10, maxSteps 8).
 */
export function getAgentLimits(
  source: Record<string, string | undefined> = process.env,
): AgentLimits {
  const env = AgentLimitsEnvSchema.parse(source);
  return { maxTurns: env.AGENT_MAX_TURNS, maxSteps: env.AGENT_MAX_STEPS };
}
