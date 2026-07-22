// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { DataTable } from "@/components/insight/charts/DataTable";

// isMoneyKey/formatCell's bucket-as-currency rule, proven through the component's public render
// output - and a non-money column (a plain count) stays a locale-formatted number, not money.

afterEach(cleanup);

describe("DataTable formats histogram bucket cells as currency (018 strand 3)", () => {
  test("a salary_distribution row's numeric `bucket` renders as money, `count` stays a plain number", () => {
    const { container } = render(
      <DataTable rows={[{ bucket: 160000, count: 3, median: 180000 }]} currency="USD" />,
    );
    const cells = Array.from(container.querySelectorAll("td")).map((td) => td.textContent);
    expect(cells).toEqual(["$160k", "3", "$180k"]); // bucket + median are money; count is a bare number
  });

  test("honors the real currency, not a hardcoded $", () => {
    const { container } = render(
      <DataTable rows={[{ bucket: 40000, count: 2, median: 90000 }]} currency="EUR" />,
    );
    const cells = Array.from(container.querySelectorAll("td")).map((td) => td.textContent);
    expect(cells).toEqual(["€40k", "2", "€90k"]);
  });
});
