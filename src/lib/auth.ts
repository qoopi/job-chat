import { betterAuth } from "better-auth";
import { Pool } from "pg";

// Better Auth server config. Google OAuth + email/password; its OWN small node-`pg` Pool scoped to
// auth ONLY (epic's decided default) - the chat store keeps its porsager `postgres` client untouched.
// Better Auth's CLI owns its tables (user/session/account/verification, each with a PK - AC-15); our
// `users` table links to them via `users.auth_user_id` (migration 0004), resolved in actions.ts.
//
// Build-safe: `new Pool` and `betterAuth` do no I/O at construction (creds resolve lazily per request),
// so the build passes with no .env. Secret + baseURL are read from BETTER_AUTH_SECRET / BETTER_AUTH_URL
// (env-only; never committed). Google is registered CONDITIONALLY: absent creds must not crash the app
// (email/password is the locally-testable path; Google is the operator's live check once creds land).

const googleId = process.env.GOOGLE_CLIENT_ID;
const googleSecret = process.env.GOOGLE_CLIENT_SECRET;

// The Managed Postgres presents an SSL cert node-`pg` cannot chain-verify. node-`pg` reads `sslmode`
// from the connection string as STRICT verification (and ignores a separate `ssl` option), so drop
// `sslmode` and apply lenient TLS explicitly - encrypt, skip the leaf-cert check - mirroring the
// porsager store's treatment of `require`. (disable/absent = no forced SSL, e.g. a plain local DB.)
function authPoolConfig(raw: string | undefined) {
  if (!raw) return {};
  const u = new URL(raw);
  const mode = u.searchParams.get("sslmode");
  u.searchParams.delete("sslmode");
  const ssl = mode && /require|prefer|verify/.test(mode) ? { rejectUnauthorized: false } : undefined;
  return { connectionString: u.toString(), ssl };
}

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  database: new Pool(authPoolConfig(process.env.DATABASE_URL)),
  emailAndPassword: { enabled: true },
  ...(googleId && googleSecret
    ? { socialProviders: { google: { clientId: googleId, clientSecret: googleSecret } } }
    : {}),
});
