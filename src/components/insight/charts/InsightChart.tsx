"use client";

import type { ChartType, DataPoint } from "@shared/insight";
import { TrendChart } from "./TrendChart";
import { BarsChart } from "./BarsChart";
import { HistogramChart } from "./HistogramChart";
import { DonutChart } from "./DonutChart";

// Dispatch a chart insight's series to its designated primitive (parts.ts chartTypeFor pins this).
export function InsightChart({ chartType, series }: { chartType: ChartType; series: DataPoint[] }) {
  switch (chartType) {
    case "trend":
      return <TrendChart series={series} />;
    case "bars":
      return <BarsChart series={series} />;
    case "histogram":
      return <HistogramChart series={series} />;
    case "donut":
      return <DonutChart series={series} />;
    default: {
      const exhaustive: never = chartType;
      throw new Error(`unknown chartType: ${String(exhaustive)}`);
    }
  }
}
