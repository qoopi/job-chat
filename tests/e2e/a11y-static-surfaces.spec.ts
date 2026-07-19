import { expect, test } from "@playwright/test";

const CHAT = "/chat/00000000-0000-4000-8000-000000000000";

// A2: the text inputs carry an accessible name (WCAG 4.1.2). A placeholder is not a name and vanishes
// on input, so `getByRole("textbox", { name })` would fail if only the placeholder were present.
test.describe("accessible names on the text inputs", () => {
  test("Should_ExposeAccessibleName_On_LandingInput", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("textbox", { name: "What are you looking for" })).toBeVisible();
  });

  test("Should_ExposeAccessibleName_On_Composer", async ({ page }) => {
    await page.goto(CHAT);
    await expect(page.getByRole("textbox", { name: "Ask a follow-up" })).toBeVisible();
  });
});

// A3: the Chart|Table control is an ARIA tablist so a screen reader announces the selected view and its
// role - not two unrelated buttons. Visuals are unchanged; only the semantics are asserted here.
test.describe("insight tabs expose tablist semantics", () => {
  test("Should_ExposeTabRolesAndSelectedState_On_ChartCard", async ({ page }) => {
    await page.goto(CHAT);
    const barsCard = page.locator(".insight").nth(1); // fixture card 1: bars chart insight

    await expect(barsCard.getByRole("tablist")).toBeVisible();
    const chartTab = barsCard.getByRole("tab", { name: "Chart", exact: true });
    const tableTab = barsCard.getByRole("tab", { name: "Table", exact: true });

    await expect(chartTab).toHaveAttribute("aria-selected", "true");
    await expect(tableTab).toHaveAttribute("aria-selected", "false");

    await tableTab.click();
    await expect(tableTab).toHaveAttribute("aria-selected", "true");
    await expect(chartTab).toHaveAttribute("aria-selected", "false");
  });

  test("Should_ShowDisabledChartTabPair_On_TableOnlyInsight", async ({ page }) => {
    await page.goto(CHAT);
    const tableCard = page.locator(".insight").nth(4); // fixture card 5: table-only insight

    // per the mock's Chart|Table pattern, the table-only card keeps both tabs with Chart disabled
    // (there is no chart to switch to) rather than a lone, stray Table tab.
    const chartTab = tableCard.getByRole("tab", { name: "Chart", exact: true });
    const tableTab = tableCard.getByRole("tab", { name: "Table", exact: true });
    await expect(chartTab).toBeDisabled();
    await expect(chartTab).toHaveAttribute("aria-selected", "false");
    await expect(tableTab).toHaveAttribute("aria-selected", "true");
  });
});
