import { z } from "zod";

// Required at runtime use, never validated at build/import time (the build must pass with no .env).
const schema = z.object({
  TRIGGER_SECRET_KEY: z.string().min(1),
  CLICKHOUSE_URL: z.string().min(1),
  CLICKHOUSE_USER: z.string().min(1),
  CLICKHOUSE_PASSWORD: z.string().min(1),
  // Dedicated read-only user (SELECT on postings only) - the analytics catalog's client.
  CLICKHOUSE_RO_USER: z.string().min(1),
  CLICKHOUSE_RO_PASSWORD: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  AWS_REGION: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  SEARCHNAPPLY_API_URL: z.string().min(1),
  SEARCHNAPPLY_AUTH_URL: z.string().min(1),
  SEARCHNAPPLY_EMAIL: z.string().min(1),
  SEARCHNAPPLY_PASSWORD: z.string().min(1),
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
