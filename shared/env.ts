import { z } from "zod";
import { ClickhouseEnvSchema, ClickhouseRoEnvSchema } from "./clickhouse";
import { SearchnapplyEnvSchema } from "./searchnapply";

// Composed from per-domain slices (each owns its keys). Validated at runtime USE, never at build/import
// time - the build must pass with no .env.
const BaseEnvSchema = z.object({
  TRIGGER_SECRET_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
});

// Bedrock uses the eu Claude inference profile. Locally these keys are empty (creds come from the AWS
// profile chain via fromNodeProviderChain); getEnv() is the strict validator, not the agent's cred path.
const BedrockEnvSchema = z.object({
  AWS_REGION: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
});

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
