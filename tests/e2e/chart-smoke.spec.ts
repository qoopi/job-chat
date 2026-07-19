import { expect, test } from "@playwright/test";

const CHAT = "/chat/00000000-0000-4000-8000-000000000000";

// Component smoke: the fixture conversation renders one card per chart primitive with no console
// errors, and the Show-query reveal works.
test("Should_RenderEveryChartPrimitive_WithoutConsoleErrors", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto(CHAT);

  // the four Recharts primitives (trend, bars, histogram, donut) each render an SVG surface
  await expect(page.locator("svg.recharts-surface")).toHaveCount(4);
  // the fifth primitive: the sortable data table
  await expect(page.locator("table.data-table")).toHaveCount(1);
  // verdicts render the headline number in bold
  await expect(page.locator(".verdict b").first()).toBeVisible();

  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});

test("Should_RevealSql_When_ShowQueryClicked", async ({ page }) => {
  await page.goto(CHAT);

  const firstCard = page.locator(".insight").first();
  await expect(firstCard.locator(".codeblock")).toHaveCount(0);

  await firstCard.getByRole("button", { name: "Show query" }).click();
  await expect(firstCard.locator(".codeblock")).toBeVisible();
  await expect(firstCard.getByRole("button", { name: "Copy" })).toBeVisible();
});
