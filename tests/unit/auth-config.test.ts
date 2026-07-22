import { describe, expect, it } from "vitest";
import { auth, authPoolConfig } from "@/lib/auth";

// Asserted off `auth.options` (Better Auth stores the resolved config verbatim): Google-only (no
// emailAndPassword), nextCookies LAST, trustedOrigins set, account linking still trusting Google,
// and sslmode verify-* never silently downgraded to no verification.

describe("auth config: google-only + reviewer should-fixes", () => {
  it("Should_RemoveEmailPassword_When_GoogleOnly", () => {
    // cast: the resolved options type NARROWS `emailAndPassword` away once it is omitted - reading it
    // back as absent is exactly the assertion.
    expect((auth.options as { emailAndPassword?: unknown }).emailAndPassword).toBeUndefined();
  });

  it("Should_SetTrustedOrigins_When_Configured", () => {
    expect(auth.options.trustedOrigins).toContain("http://localhost:3000");
    // BOTH prod hosts: Vercel 308s the apex to www, so www is the canonical browser origin - omitting
    // it 403'd every prod sign-in (INVALID_ORIGIN).
    expect(auth.options.trustedOrigins).toContain("https://jobchat.dev");
    expect(auth.options.trustedOrigins).toContain("https://www.jobchat.dev");
  });

  it("Should_PlaceNextCookiesLast_When_PluginsConfigured", () => {
    const plugins = auth.options.plugins ?? [];
    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins[plugins.length - 1]?.id).toBe("next-cookies");
  });

  it("Should_KeepAccountLinkingTrustingGoogle_When_GoogleOnly", () => {
    expect(auth.options.account?.accountLinking?.enabled).toBe(true);
    expect(auth.options.account?.accountLinking?.trustedProviders).toContain("google");
  });

  it("Should_NotSetRequireLocalEmailVerified_When_GoogleOnly", () => {
    // Do NOT touch the CVE gate default: leave requireLocalEmailVerified at its (true) default (unset).
    const linking = auth.options.account?.accountLinking as { requireLocalEmailVerified?: unknown } | undefined;
    expect(linking?.requireLocalEmailVerified).toBeUndefined();
  });

  it("Should_NotSetAllowDifferentEmails_When_GoogleOnly", () => {
    // CVE-2026-53516 checklist: allowDifferentEmails must stay false/omitted - setting
    // it true would let a Google login on a DIFFERENT email link onto an existing account.
    const linking = auth.options.account?.accountLinking as { allowDifferentEmails?: unknown } | undefined;
    expect(linking?.allowDifferentEmails).toBeUndefined();
  });
});

describe("authPoolConfig SSL: no silent downgrade of verify-* (reviewer should-fix)", () => {
  it("Should_EncryptWithoutVerify_When_Require", () => {
    // `require`/`prefer` ask for encryption WITHOUT cert verification (libpq semantics) - the Managed
    // Postgres presents an unverifiable chain, so this is the working prod path.
    expect(authPoolConfig("postgres://u:p@h:5432/db?sslmode=require").ssl).toEqual({ rejectUnauthorized: false });
    expect(authPoolConfig("postgres://u:p@h:5432/db?sslmode=prefer").ssl).toEqual({ rejectUnauthorized: false });
  });

  it("Should_KeepVerification_When_VerifyMode", () => {
    // `verify-ca`/`verify-full` DO promise verification - honor it (rejectUnauthorized: true) instead of
    // silently downgrading to no verification.
    expect(authPoolConfig("postgres://u:p@h:5432/db?sslmode=verify-full").ssl).toEqual({ rejectUnauthorized: true });
    expect(authPoolConfig("postgres://u:p@h:5432/db?sslmode=verify-ca").ssl).toEqual({ rejectUnauthorized: true });
  });

  it("Should_NotForceSsl_When_DisabledOrAbsent", () => {
    expect(authPoolConfig("postgres://u:p@h:5432/db?sslmode=disable").ssl).toBeUndefined();
    expect(authPoolConfig("postgres://u:p@h:5432/db").ssl).toBeUndefined();
  });

  it("Should_StripSslmode_FromConnectionString", () => {
    const cfg = authPoolConfig("postgres://u:p@h:5432/db?sslmode=require");
    expect(cfg.connectionString).toBeDefined();
    expect(cfg.connectionString).not.toContain("sslmode");
  });

  it("Should_ReturnEmpty_When_NoUrl", () => {
    expect(authPoolConfig(undefined)).toEqual({});
  });
});
