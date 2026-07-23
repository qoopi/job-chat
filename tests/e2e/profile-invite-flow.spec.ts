import { expect, test } from "@playwright/test";

// The invite -> form -> card happy path, end to end against the built app with the mock transport (no
// Trigger.dev / Postgres). Resumes a thread whose one assistant turn is a profile-invite card, opens the
// detail panel form from it, builds the profile (e2e short-circuits the save), and confirms the profile card is
// injected into the thread.
const PROFILE_INVITE_ID = "00000000-0000-4000-8000-000000000002";

test("profile-invite -> detail panel form -> profile card in thread", async ({ page }) => {
  await page.goto(`/chat/${PROFILE_INVITE_ID}`);

  // The profile-invite card is in the thread.
  const addProfile = page.getByRole("button", { name: "Add your profile" });
  await expect(addProfile).toBeVisible({ timeout: 15_000 });

  // Clicking it opens the detail panel profile form (empty state).
  await addProfile.click();
  await expect(page.getByRole("region", { name: "Your profile" })).toBeVisible();
  await expect(page.getByText("No profile yet")).toBeVisible();

  // Fill the GitHub field and build - the e2e path short-circuits the save to the saved state.
  await page.getByLabel(/GitHub username/).fill("mkoval");
  await page.getByRole("button", { name: "Build my profile" }).click();

  // The form reaches its saved state...
  await expect(page.getByText("Profile saved ✓")).toBeVisible();
  // ...and the profile card is injected into the thread (its "Find me a job that fits" chip is unique
  // to the card, not the form).
  await expect(page.getByRole("button", { name: "Find me a job that fits" })).toBeVisible();
  // F3 (biting): the invite interrupted the "Find me a job that fits" ask, so saving the profile
  // auto-continues it - a SECOND user bubble with that exact text appears (the original ask + the one
  // auto-resend). A regression that dropped the auto-continue leaves only ONE user bubble and fails here;
  // this is the guard the old chip-visibility line did not provide (the chip is a button, not a bubble).
  await expect(
    page.locator(".bubble.user").filter({ hasText: "Find me a job that fits" }),
  ).toHaveCount(2);
});
