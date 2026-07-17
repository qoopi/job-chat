import { expect, test } from "@playwright/test";

// The mocking pattern for all future e2e: intercept network at the browser boundary with
// page.route, so specs run green without Trigger.dev, ClickHouse, or searchnapply.
test("network mocks answer in place of real backends", async ({ page }) => {
  await page.route("**/api/health", (route) =>
    route.fulfill({ json: { ok: true, source: "mock" } }),
  );

  await page.goto("/");
  const health = await page.evaluate(() =>
    fetch("/api/health").then((r) => r.json()),
  );

  expect(health).toEqual({ ok: true, source: "mock" });
});
