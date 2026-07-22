"use client";

import type { ChartType, DataPoint } from "@shared/insight";
import { TrendChart } from "./TrendChart";
import { BarsChart } from "./BarsChart";
import { HistogramChart } from "./HistogramChart";
import { DonutChart } from "./DonutChart";

// Dispatch a chart insight to its primitive; currency (meta.currency) threads to the histogram so its money labels match the source line.
export function InsightChart({
  chartType,
  series,
  currency,
  onShowAll,
}: {
  chartType: ChartType;
  series: DataPoint[];
  currency?: string;
  /** A capped bars chart's "+ N more" opens the full series as a table in the detail panel. */
  onShowAll?: () => void;
}) {
  switch (chartType) {
    case "trend":
      return <TrendChart series={series} />;
    case "bars":
      return <BarsChart series={series} onShowAll={onShowAll} />;
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
