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

test("Should_RevealSql_When_ShowQueryClicked", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-write"]).catch(() => {});
  await page.goto(CHAT);

  const firstCard = page.locator(".insight").first();
  await expect(firstCard.locator(".codeblock")).toHaveCount(0);

  await firstCard.getByRole("button", { name: "Show query" }).click();
  await expect(firstCard.locator(".codeblock")).toBeVisible();

  // Copy -> "Copied" for ~1.5s, then reverts (interaction-spec section 2). Queried by class, not by
  // accessible name, since the name itself is what changes across the assertions.
  const copyBtn = firstCard.locator(".copy-btn");
  await expect(copyBtn).toHaveText("Copy");
  await copyBtn.click();
  await expect(copyBtn).toHaveText("Copied");
  await expect(copyBtn).toHaveText("Copy", { timeout: 2500 });
});

// The four Recharts primitives render more than an empty surface: each carries the data-driven
// marker/label/order the design calls for, so a wrong dataKey, dropped marker, or broken sort would
// fail these, not just a missing <svg>.
test("Should_ShowMedianMarker_OnHistogramChart", async ({ page }) => {
  await page.goto(CHAT);
  const card = page.locator(".insight").first(); // fixture card 0: histogram
  await expect(card.getByText("median $182k")).toBeVisible();
});

test("Should_RenderSortedLeaderAndValueLabels_OnBarsChart", async ({ page }) => {
  await page.goto(CHAT);
  const card = page.locator(".insight").nth(1); // fixture card 1: bars (top_companies)
  // scoped to the chart SVG, not the whole card: the verdict text ("...214 open roles...") also
  // contains "214", so a card-wide text lookup would hit both the bold verdict number and this label.
  const chart = card.locator("svg.recharts-surface");

  // tick VALUES render in Recharts' own z-index layer, a sibling of (not nested under) the axis's
  // line/tick-mark group - hence the "-tick-labels" class, not ".recharts-yAxis" as an ancestor.
  const labels = await chart
    .locator(".recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value")
    .allTextContents();
  expect(labels).toEqual(["Amazon", "Databricks", "Google", "Stripe", "Airbnb", "Datadog"]);

  // value labels (LabelList) render the raw counts next to each bar
  await expect(chart.getByText("214", { exact: true })).toBeVisible();
  await expect(chart.getByText("71", { exact: true })).toBeVisible();
});

test("Should_ShowLastPointValueLabel_OnTrendChart", async ({ page }) => {
  await page.goto(CHAT);
  const card = page.locator(".insight").nth(2); // fixture card 2: trend (postings_trend)
  // scoped to the chart SVG: the verdict text ("1,204 new postings...") also contains "1,204".
  await expect(card.locator("svg.recharts-surface").getByText("1,204", { exact: true })).toBeVisible();
});

test("Should_ShowLegendCountsAndPercentages_OnDonutChart", async ({ page }) => {
  await page.goto(CHAT);
  const card = page.locator(".insight").nth(3); // fixture card 3: donut (share_split)

  await expect(card).toContainText("1,602");
  await expect(card).toContainText("(46%)");
  await expect(card).toContainText("1,115");
  await expect(card).toContainText("(32%)");
  await expect(card).toContainText("766");
  await expect(card).toContainText("(22%)");
});
