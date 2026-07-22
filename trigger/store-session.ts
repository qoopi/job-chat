import postgres from "postgres";
import { createStore, type Store } from "@shared/store";

/** Open a one-connection Postgres-backed store, run `fn`, and always close it. The per-task DB seam both
 *  durable tasks share (chat + extract-profile); constructed at call time so the build passes with no .env. */
export async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    return await fn(createStore(sql));
  } finally {
    await sql.end();
  }
}
