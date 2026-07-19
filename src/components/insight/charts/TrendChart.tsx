"use client";

import {
  Area,
  AreaChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DataPoint } from "@shared/insight";
import { labelKeyOf, valueKeyOf } from "@/lib/insight-format";
import { CHART_HEIGHT, TOOLTIP_STYLE, axisTickStyle } from "./chart-style";

// Area trend (postings_trend: {day, count}) - a filled line rising to the latest point, which
// carries an emphasized value label (the headline number). Colors from --chart-1.
export function TrendChart({ series }: { series: DataPoint[] }) {
  const labelKey = labelKeyOf(series);
  const valueKey = valueKeyOf(series, labelKey);
  const last = series[series.length - 1];

  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <AreaChart data={series} margin={{ top: 16, right: 16, left: 0, bottom: 0 }}>
        <XAxis
          dataKey={labelKey}
          tick={axisTickStyle}
          tickLine={false}
          axisLine={{ stroke: "var(--border)" }}
          minTickGap={40}
        />
        <YAxis hide />
        <Tooltip contentStyle={TOOLTIP_STYLE} cursor={{ stroke: "var(--border)" }} />
        <Area
          type="monotone"
          dataKey={valueKey}
          stroke="var(--chart-1)"
          strokeWidth={2}
          fill="var(--chart-1)"
          fillOpacity={0.08}
          isAnimationActive={false}
          dot={false}
        />
        {last ? (
          <ReferenceDot
            x={last[labelKey] as string | number}
            y={last[valueKey] as number}
            r={4}
            fill="var(--chart-1)"
            stroke="none"
            label={{
              value: Number(last[valueKey]).toLocaleString(),
              position: "top",
              fill: "var(--accent-ink)",
              fontSize: 11,
              fontWeight: 600,
            }}
          />
        ) : null}
      </AreaChart>
    </ResponsiveContainer>
  );
}
