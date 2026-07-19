import { expect, test } from "@playwright/test";

test("landing page renders with the product title", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/jobchat\.dev/);
  await expect(page.getByRole("heading", { name: "The jobs market, answered." })).toBeVisible();
});
