import { expect, test } from "@playwright/test";
import { armScript, insightScript } from "./chat-mock";

const CHAT = "/chat/00000000-0000-4000-8000-000000000000";

// AC-6b: the Chart|Table toggle swaps the visible primitive instantly and keeps the choice per card for
// the session - other cards are unaffected, and the choice survives a later turn re-rendering the
// thread. Runs against the resumed fixture conversation (histogram=0, bars=1, ...).
test.describe("InsightCard - tab switch and per-card session memory (AC-6b)", () => {
  test("Should_SwitchToTableView_When_TableTabClicked", async ({ page }) => {
    await page.goto(CHAT);

    const barsCard = page.locator(".insight").nth(1); // bars (top_companies) chart insight
    await expect(barsCard.locator("svg.recharts-surface")).toBeVisible();
    await expect(barsCard.locator("table.data-table")).toHaveCount(0);

    await barsCard.getByRole("tab", { name: "Table", exact: true }).click();
    await expect(barsCard.locator("table.data-table")).toBeVisible();
    await expect(barsCard.locator("table.data-table")).toContainText("Amazon");
    await expect(barsCard.locator("svg.recharts-surface")).toHaveCount(0);

    await barsCard.getByRole("tab", { name: "Chart", exact: true }).click();
    await expect(barsCard.locator("svg.recharts-surface")).toBeVisible();
    await expect(barsCard.locator("table.data-table")).toHaveCount(0);
  });

  test("Should_KeepTabChoicePerCard_When_AnotherTurnRenders", async ({ page }) => {
    await armScript(page, insightScript(120));
    await page.goto(CHAT);

    // switch card #1 (bars) to Table; card #0 (histogram) must be unaffected
    const barsCard = page.locator(".insight").nth(1);
    await barsCard.getByRole("tab", { name: "Table", exact: true }).click();
    await expect(barsCard.locator("table.data-table")).toBeVisible();
    await expect(page.locator(".insight").nth(0).locator("svg.recharts-surface")).toBeVisible();

    // send a follow-up: the thread re-renders with a new answer, but the per-card choice survives
    const box = page.getByRole("textbox", { name: "Ask a follow-up" });
    await box.fill("Who else is hiring?");
    await box.press("Enter");
    await expect(page.locator(".insight").last().locator(".verdict")).toContainText("Amazon leads hiring with");

    await expect(barsCard.locator("table.data-table")).toBeVisible(); // still Table after the new turn
    await expect(barsCard.locator("svg.recharts-surface")).toHaveCount(0);
  });
});
