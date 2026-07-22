import { expect, test } from "@playwright/test";

// No-FOUC: <html data-theme> must come from the server render of the `theme` cookie, not a
// client-side toggle after hydration. Proof: disable JS entirely in the browser context - with no
// script able to run, whatever value lands on <html> can only have come from the HTML the server sent.
test.describe("theme cookie - server-rendered, no flash of unstyled/wrong theme", () => {
  test("Should_RenderDarkThemeFromCookie_WithNoClientJs", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    await context.addCookies([{ name: "theme", value: "dark", url: baseURL! }]);
    const page = await context.newPage();

    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "Dark");

    await context.close();
  });

  test("Should_DefaultToLightTheme_WithNoClientJs_When_NoCookieSet", async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    const page = await context.newPage();

    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "Light");

    await context.close();
  });
});
