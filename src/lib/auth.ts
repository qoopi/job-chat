import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { Pool } from "pg";

// Better Auth: Google OAuth only, its OWN auth-scoped node-`pg` Pool (the chat store's porsager client is
// untouched). Build-safe: construction does no I/O, so the build passes with no .env. Google is registered
// CONDITIONALLY - absent creds must not crash the app (guest chat stays open).

const googleId = process.env.GOOGLE_CLIENT_ID;
const googleSecret = process.env.GOOGLE_CLIENT_SECRET;

// node-`pg` reads `sslmode` from the connection string as STRICT verification (and ignores a separate `ssl`
// option), so drop it and set TLS explicitly per mode below: require/prefer encrypt WITHOUT cert verification,
// verify-ca/verify-full HONOR it (rejectUnauthorized: true), disable/absent = no SSL.
// RESIDUAL: prod uses `require`, so the leaf cert is unverified (encryption only); upgrade = a pinned Managed-PG CA.
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

// Cache the pool on globalThis so Next.js dev HMR reuses ONE pool, not a fresh `new Pool` per reload -
// which exhausts the Managed Postgres connection limit (intermittent CONNECT_TIMEOUT / read ETIMEDOUT).
const globalForAuthPool = globalThis as unknown as { __jobchatAuthPool?: Pool };
const authPool =
  globalForAuthPool.__jobchatAuthPool ?? new Pool(authPoolConfig(process.env.DATABASE_URL));
if (process.env.NODE_ENV !== "production") globalForAuthPool.__jobchatAuthPool = authPool;

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  database: authPool,
  // OAuth origins (guards state/callback CSRF). Vercel 308s the apex to www, so www is the canonical browser
  // origin - omitting it 403'd every prod sign-in; the apex stays trusted too.
  trustedOrigins: ["http://localhost:3000", "https://jobchat.dev", "https://www.jobchat.dev"],
  // SECURITY: the CVE-2026-53516 gate defaults are LEFT untouched (allowDifferentEmails false,
  // requireLocalEmailVerified true); Google stays a TRUSTED provider (it verifies emails).
  account: {
    accountLinking: { enabled: true, trustedProviders: ["google"] },
  },
  ...(googleId && googleSecret
    ? { socialProviders: { google: { clientId: googleId, clientSecret: googleSecret } } }
    : {}),
  // nextCookies MUST be LAST: it lets Better Auth flush Set-Cookie from Server Actions.
  plugins: [nextCookies()],
});
