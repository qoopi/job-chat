import { expect, test } from "@playwright/test";

const CHAT = "/chat/00000000-0000-4000-8000-000000000000";

// InsightCard interactive states the chart-smoke presence check does not exercise: the Chart|Table
// tab shell actually swaps the visible primitive, and a used follow-up chip is a real one-shot
// (disabled, checkmarked) rather than just styled to look that way.
test.describe("InsightCard - tabs and follow-up chips", () => {
  test("Should_SwitchToTableView_When_TableTabClicked", async ({ page }) => {
    await page.goto(CHAT);

    // second AI card in the fixture conversation: the bars (top_companies) chart insight
    const barsCard = page.locator(".insight").nth(1);
    await expect(barsCard.locator("svg.recharts-surface")).toBeVisible();
    await expect(barsCard.locator("table.data-table")).toHaveCount(0);

    await barsCard.getByRole("button", { name: "Table", exact: true }).click();
    await expect(barsCard.locator("table.data-table")).toBeVisible();
    await expect(barsCard.locator("table.data-table")).toContainText("Amazon");
    await expect(barsCard.locator("svg.recharts-surface")).toHaveCount(0);

    await barsCard.getByRole("button", { name: "Chart", exact: true }).click();
    await expect(barsCard.locator("svg.recharts-surface")).toBeVisible();
    await expect(barsCard.locator("table.data-table")).toHaveCount(0);
  });

  test("Should_DisableUsedFollowupChip_AsOneShot", async ({ page }) => {
    await page.goto(CHAT);

    // first AI card: the histogram insight, fixture-marked with "Compare with LA" already used
    const histogramCard = page.locator(".insight").first();
    const usedChip = histogramCard.getByRole("button", { name: "Compare with LA ✓" });
    await expect(usedChip).toBeVisible();
    await expect(usedChip).toBeDisabled();

    const freshChip = histogramCard.getByRole("button", { name: "Trend this year", exact: true });
    await expect(freshChip).toBeEnabled();
  });
});
