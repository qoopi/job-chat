"use client";

import {
  Bar,
  BarChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DataPoint } from "@shared/insight";
import { formatMoney } from "@/lib/insight-format";
import { CHART_HEIGHT, TOOLTIP_STYLE, axisTickStyle } from "./chart-style";

// Salary histogram: bucket-count bars + an amber dashed marker at the nearest bucket to the median. Money
// labels use the insight's REAL currency (meta.currency) so a non-USD set never mislabels its axis with a "$".
export function HistogramChart({ series, currency = "USD" }: { series: DataPoint[]; currency?: string }) {
  const median = Number(series[0]?.median);
  // Place the marker on the bucket closest to the median so the amber line reads against the discrete bars.
  const markerBucket =
    Number.isFinite(median) && series.length
      ? series.reduce((best, r) =>
          Math.abs(Number(r.bucket) - median) < Math.abs(Number(best.bucket) - median) ? r : best,
        ).bucket
      : undefined;

  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <BarChart data={series} margin={{ top: 20, right: 12, left: 0, bottom: 0 }}>
        <XAxis
          dataKey="bucket"
          tick={axisTickStyle}
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
          tickFormatter={(v: number) => formatMoney(v, currency)}
          minTickGap={24}
        />
        <YAxis hide />
        <Tooltip
          contentStyle={TOOLTIP_STYLE}
          cursor={{ fill: "var(--surface-2)" }}
          labelFormatter={(v) => formatMoney(Number(v), currency)}
        />
        <Bar dataKey="count" fill="var(--chart-1)" radius={[3, 3, 0, 0]} isAnimationActive={false} />
        {markerBucket !== undefined ? (
          <ReferenceLine
            x={markerBucket as number}
            stroke="var(--amber)"
            strokeWidth={1.5}
            strokeDasharray="4 4"
            label={{
              value: `median ${formatMoney(median, currency)}`,
              position: "top",
              fill: "var(--amber)",
              fontSize: 11,
              fontWeight: 600,
            }}
          />
        ) : null}
      </BarChart>
    </ResponsiveContainer>
  );
}
