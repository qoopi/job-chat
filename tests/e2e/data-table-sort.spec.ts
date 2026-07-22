import { expect, test } from "@playwright/test";

const CHAT = "/chat/00000000-0000-4000-8000-000000000000";

// DataTable header click cycles none -> desc -> asc -> none (DataTable.tsx onSort). The fixture's
// table insight is NOT pre-sorted by `published_at`, so a broken sort (or a header that is wired but
// does not actually reorder) changes observable row order - this is a biting test, not a presence check.
test.describe("DataTable - sortable header actually sorts", () => {
  test("Should_ReorderRows_ThroughTheFullSortCycle_When_PublishedAtHeaderClicked", async ({ page }) => {
    await page.goto(CHAT);

    const table = page.locator("table.data-table");
    const firstRowCompany = () => table.locator("tbody tr").first().locator("td").nth(1);

    // fixture order (unsorted by published_at): Airbnb, Stripe, Databricks, Netflix, Datadog
    await expect(firstRowCompany()).toHaveText("Airbnb");

    const header = table.getByRole("columnheader", { name: /Published At/ });

    // click 1: desc -> newest first (Stripe)
    await header.click();
    await expect(header).toHaveText("Published At ▾");
    await expect(firstRowCompany()).toHaveText("Stripe");

    // click 2: asc -> oldest first (Databricks)
    await header.click();
    await expect(header).toHaveText("Published At ▴");
    await expect(firstRowCompany()).toHaveText("Databricks");

    // click 3: back to none -> original fixture order restored
    await header.click();
    await expect(header).toHaveText("Published At");
    await expect(firstRowCompany()).toHaveText("Airbnb");
  });

  test("Should_ReorderRowsAndCycleAriaSort_When_HeaderDrivenByKeyboard", async ({ page }) => {
    await page.goto(CHAT);

    const table = page.locator("table.data-table");
    const firstRowCompany = () => table.locator("tbody tr").first().locator("td").nth(1);

    const header = table.getByRole("columnheader", { name: /Published At/ });
    // the sort control is a real <button>: in the tab order and activated by Enter/Space, so a keyboard
    // user triggers the exact same sort a mouse user can (WCAG 2.1.1), and aria-sort exposes the state.
    const sortButton = header.getByRole("button");

    await expect(firstRowCompany()).toHaveText("Airbnb");
    await expect(header).toHaveAttribute("aria-sort", "none");

    await sortButton.focus();
    await expect(sortButton).toBeFocused();

    // Enter -> descending (newest first: Stripe)
    await page.keyboard.press("Enter");
    await expect(header).toHaveAttribute("aria-sort", "descending");
    await expect(firstRowCompany()).toHaveText("Stripe");

    // Space -> ascending (oldest first: Databricks)
    await page.keyboard.press("Space");
    await expect(header).toHaveAttribute("aria-sort", "ascending");
    await expect(firstRowCompany()).toHaveText("Databricks");

    // Enter -> back to none (original fixture order restored)
    await page.keyboard.press("Enter");
    await expect(header).toHaveAttribute("aria-sort", "none");
    await expect(firstRowCompany()).toHaveText("Airbnb");
  });

  test("Should_SortNumerically_When_SalaryMinHeaderClicked", async ({ page }) => {
    await page.goto(CHAT);

    const table = page.locator("table.data-table");
    const firstRowCompany = () => table.locator("tbody tr").first().locator("td").nth(1);

    const header = table.getByRole("columnheader", { name: /Salary Min/ });
    // desc is a no-op vs fixture order (already highest-first); asc proves the numeric comparator runs
    // (falls to Datadog, salary_min 175000 - the lowest) rather than a string compare or no-op.
    await header.click();
    await header.click();
    await expect(firstRowCompany()).toHaveText("Datadog");
  });
});
