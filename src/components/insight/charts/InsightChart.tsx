"use client";

import type { ChartType, DataPoint } from "@shared/insight";
import { TrendChart } from "./TrendChart";
import { BarsChart } from "./BarsChart";
import { HistogramChart } from "./HistogramChart";
import { DonutChart } from "./DonutChart";

// Dispatch a chart insight's series to its designated primitive (parts.ts chartTypeFor pins this). The
// insight's currency (meta.currency) is threaded to the histogram so its money labels match the source
// line and Table tab (018 review-fix S3); the other primitives carry no money axis.
export function InsightChart({
  chartType,
  series,
  currency,
}: {
  chartType: ChartType;
  series: DataPoint[];
  currency?: string;
}) {
  switch (chartType) {
    case "trend":
      return <TrendChart series={series} />;
    case "bars":
      return <BarsChart series={series} />;
    case "histogram":
      return <HistogramChart series={series} currency={currency} />;
    case "donut":
      return <DonutChart series={series} />;
    default: {
      const exhaustive: never = chartType;
      throw new Error(`unknown chartType: ${String(exhaustive)}`);
    }
  }
}
