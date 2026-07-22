import { expect, test } from "@playwright/test";

// A first-time visitor is minted a guest id cookie on arrival. A Server Component
// cannot set a cookie during render, so the landing ensures the guest via a server action on first
// paint. (The paired users-row write is exercised by the store/session integration tests against real
// Postgres; here we assert the cookie half.)
test("Should_MintGuestCookie_When_FirstVisit", async ({ page, context }) => {
  // a brand-new context has no guest cookie
  expect((await context.cookies()).some((c) => c.name === "jobchat_guest")).toBe(false);

  await page.goto("/");

  await expect
    .poll(async () => (await context.cookies()).find((c) => c.name === "jobchat_guest")?.value ?? null)
    .not.toBeNull();

  const cookie = (await context.cookies()).find((c) => c.name === "jobchat_guest");
  expect(cookie?.httpOnly).toBe(true);
});
