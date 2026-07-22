import { expect, test } from "@playwright/test";

// The landing serves the three credit links. Asserted page-wide - the mock 4b
// puts the hackathon credit in the header and GitHub + searchnapply in the footer.
test("Should_RenderCreditLinks_On_Landing", async ({ page }) => {
  await page.goto("/");

  // hackathon credit -> the exact Luma URL
  await expect(
    page.locator('a[href="https://triggerdev.clickhouse.com/?utm_source=luma"]'),
  ).toBeVisible();

  // data credit -> searchnapply.com
  await expect(page.locator('a[href*="searchnapply.com"]')).toBeVisible();

  // GitHub repo link
  const github = page.getByRole("link", { name: "GitHub" });
  await expect(github).toBeVisible();
  await expect(github).toHaveAttribute("href", /github\.com/);
});
