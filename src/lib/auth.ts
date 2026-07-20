import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { Pool } from "pg";

// Better Auth server config. Google OAuth ONLY (operator ruling 2026-07-21: email/password removed);
// its OWN small node-`pg` Pool scoped to auth ONLY (epic's decided default) - the chat store keeps its
// porsager `postgres` client untouched. Better Auth's CLI owns its tables
// (user/session/account/verification, each with a PK - AC-15); our `users` table links to them via
// `users.auth_user_id` (migration 0004), resolved in actions.ts.
//
// Build-safe: `new Pool` and `betterAuth` do no I/O at construction (creds resolve lazily per request),
// so the build passes with no .env. Secret + baseURL are read from BETTER_AUTH_SECRET / BETTER_AUTH_URL
// (env-only; never committed). Google is registered CONDITIONALLY: absent creds must not crash the app
// (guest chat stays open; Google is the operator's live check once creds land).

const googleId = process.env.GOOGLE_CLIENT_ID;
const googleSecret = process.env.GOOGLE_CLIENT_SECRET;

// The Managed Postgres presents an SSL cert node-`pg` cannot chain-verify. node-`pg` reads `sslmode`
// from the connection string as STRICT verification (and ignores a separate `ssl` option), so drop
// `sslmode` and apply TLS explicitly. `require`/`prefer` ask for encryption WITHOUT certificate
// verification (libpq semantics) - encrypt but skip the leaf check (the working Managed-PG prod path,
// mirroring the porsager store's treatment of `require`). `verify-ca`/`verify-full` DO promise
// verification, so HONOR it (rejectUnauthorized: true) rather than silently downgrading to no
// verification (reviewer should-fix). disable/absent = no forced SSL (a plain local DB).
// RESIDUAL: prod uses `require`, so the leaf cert is unverified (encryption only); the upgrade is a
// pinned Managed-PG CA (a `ca` PEM + `verify-full`) - infeasible in-window without the CA bundle.
export function authPoolConfig(raw: string | undefined): { connectionString?: string; ssl?: { rejectUnauthorized: boolean } } {
  if (!raw) return {};
  const u = new URL(raw);
  const mode = u.searchParams.get("sslmode");
  u.searchParams.delete("sslmode");
  let ssl: { rejectUnauthorized: boolean } | undefined;
  if (mode === "require" || mode === "prefer") ssl = { rejectUnauthorized: false };
  else if (mode === "verify-ca" || mode === "verify-full") ssl = { rejectUnauthorized: true };
  return { connectionString: u.toString(), ssl };
}

// Cache the pool on globalThis so Next.js dev HMR reuses ONE pool instead of leaking a fresh
// `new Pool` (up to 10 connections each) on every module reload - which exhausts the Managed
// Postgres connection limit and surfaces as intermittent CONNECT_TIMEOUT / read ETIMEDOUT.
const globalForAuthPool = globalThis as unknown as { __jobchatAuthPool?: Pool };
const authPool =
  globalForAuthPool.__jobchatAuthPool ?? new Pool(authPoolConfig(process.env.DATABASE_URL));
if (process.env.NODE_ENV !== "production") globalForAuthPool.__jobchatAuthPool = authPool;

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  database: authPool,
  // Every frontend origin that may start an OAuth flow - guards state/callback CSRF and prevents the
  // `state_mismatch` class (gold standard s2.4). Localhost in dev, the custom domain in prod.
  trustedOrigins: ["http://localhost:3000", "https://jobchat.dev"],
  // Account linking kept harmless under Google-only: there is no email/password path left to link, but
  // Google stays a TRUSTED provider (it verifies emails) so a returning account resolves cleanly.
  // The CVE-2026-53516 gate defaults are LEFT untouched - allowDifferentEmails omitted (false) and
  // requireLocalEmailVerified omitted (true).
  account: {
    accountLinking: { enabled: true, trustedProviders: ["google"] },
  },
  ...(googleId && googleSecret
    ? { socialProviders: { google: { clientId: googleId, clientSecret: googleSecret } } }
    : {}),
  // nextCookies MUST be LAST: it lets Better Auth flush Set-Cookie from Server Actions (gold standard
  // s4.1). Keep it the final plugin.
  plugins: [nextCookies()],
});
