import postgres, { type Sql } from "postgres";

// One lazy jobchat Postgres pool cached on globalThis (dev HMR reuses ONE client, not a leak per reload).
const globalForSql = globalThis as unknown as { __jobchatSql?: Sql };

/** The lazy jobchat Postgres pool - one home, shared by the server actions and the resume render. */
export function getJobchatSql(): Sql {
  return (globalForSql.__jobchatSql ??= postgres(process.env.DATABASE_URL!));
}
