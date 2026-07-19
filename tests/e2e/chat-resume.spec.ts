import { expect, test } from "@playwright/test";

const CHAT = "/chat/00000000-0000-4000-8000-000000000000";

// AC-13: a returning/reloading guest gets their conversation restored from the message store - every
// insight card rendered (verdict, chart, table, SQL intact) with NO re-run of analytics. In E2E the
// resume source is the fixture thread (no Postgres); the invariant under test is that the cards come
// from server-rendered stored state, and nothing hits ClickHouse to redraw them.
test("Should_RestoreCardsFromStore_When_GuestReturns", async ({ page }) => {
  const analyticsCalls: string[] = [];
  page.on("request", (r) => {
    if (/clickhouse|\/analytics|\/api\/query/i.test(r.url())) analyticsCalls.push(r.url());
  });

  await page.goto(CHAT);
  await page.reload(); // "returns or reloads"

  // every card restored: the four chart primitives + the one table, with the verdict number bolded
  await expect(page.locator("svg.recharts-surface")).toHaveCount(4);
  await expect(page.locator("table.data-table")).toHaveCount(1);
  await expect(page.locator(".verdict b").first()).toBeVisible();

  // SQL intact behind Show query
  const firstCard = page.locator(".insight").first();
  await firstCard.getByRole("button", { name: "Show query" }).click();
  await expect(firstCard.locator(".codeblock")).toContainText("FROM postings FINAL");

  // no analytics re-query on resume
  expect(analyticsCalls, `unexpected analytics calls:\n${analyticsCalls.join("\n")}`).toEqual([]);
});
