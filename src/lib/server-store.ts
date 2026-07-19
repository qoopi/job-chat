import "server-only";
import postgres, { type Sql } from "postgres";
import { createStore, type Store } from "@shared/store";

// Server-only Postgres access for the chat page's resume render (AC-13). A lazy singleton pool (no
// connection until first query, so the build passes with no .env), mirroring the actions layer. Kept
// out of "use server" so a Server Component can await it directly during render; `server-only` makes a
// stray client import a build error.
let sqlSingleton: Sql | undefined;
function store(): Store {
  return createStore((sqlSingleton ??= postgres(process.env.DATABASE_URL!)));
}

/** The stored conversation + messages, or `null` for an unknown/malformed id (store contract). */
export function loadConversation(conversationId: string) {
  return store().getConversation(conversationId);
}
