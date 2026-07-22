"use client";

import {
  Bar,
  BarChart,
  Cell,
  LabelList,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DataPoint } from "@shared/insight";
import {
  BARS_CAP,
  labelKeyOf,
  truncateLabel,
  valueKeysOf,
} from "@/lib/insight-format";
import {
  CHART_COLORS,
  CHART_HEIGHT,
  TOOLTIP_STYLE,
  axisTickStyle,
} from "./chart-style";

// Bars, two shapes driven by the data (interaction-spec / specimen board):
//  - one measure  -> sorted horizontal bars (top_companies, salary_compare): the leader accent-filled,
//    the rest neutral, value labels at the bar end.
//  - many measures -> grouped vertical bars: one group per row, one accent/amber bar per measure.
// Single-measure branch: cap the visible bars at BARS_CAP, truncate long category labels
// so they never smear, keep the FULL label in the tooltip, and offer "+ N more" into the LCP table.
export function BarsChart({
  series,
  onShowAll,
}: {
  series: DataPoint[];
  onShowAll?: () => void;
}) {
  const labelKey = labelKeyOf(series);
  const valueKeys = valueKeysOf(series, labelKey);
  const grouped = valueKeys.length > 1;

  if (grouped) {
    return (
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart
          data={series}
          margin={{ top: 16, right: 16, left: 0, bottom: 0 }}
        >
          <XAxis
            dataKey={labelKey}
            tick={axisTickStyle}
            tickLine={false}
            axisLine={{ stroke: "var(--border)" }}
          />
          <YAxis hide />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            cursor={{ fill: "var(--surface-2)" }}
          />
          <Legend wrapperStyle={{ fontSize: 11, color: "var(--text-2)" }} />
          {valueKeys.map((key, i) => (
            <Bar
              key={key}
              dataKey={key}
              fill={CHART_COLORS[i % CHART_COLORS.length]}
              radius={[3, 3, 0, 0]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  const valueKey = valueKeys[0] ?? "value";
  const sortedAll = [...series].sort(
    (a, b) => Number(b[valueKey]) - Number(a[valueKey]),
  );
  // Cap at BARS_CAP rows (34px each) so long titles never collide; the leader stays accent-filled.
  const sorted = sortedAll.slice(0, BARS_CAP);
  const hidden = sortedAll.length - sorted.length;
  const max = Math.max(...sorted.map((r) => Number(r[valueKey])));

  return (
    <>
      <ResponsiveContainer
        width="100%"
        height={Math.max(CHART_HEIGHT, sorted.length * 34)}
      >
        <BarChart
          layout="vertical"
          data={sorted}
          margin={{ top: 4, right: 40, left: 8, bottom: 4 }}
        >
          <XAxis type="number" hide />
          <YAxis
            type="category"
            dataKey={labelKey}
            width={180}
            tick={axisTickStyle}
            tickLine={false}
            axisLine={false}
            // Truncate the AXIS label only; the datum keeps the full title, so the Tooltip below shows it whole.
            tickFormatter={(v) => truncateLabel(String(v))}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            cursor={{ fill: "var(--surface-2)" }}
          />
          <Bar
            dataKey={valueKey}
            radius={[0, 4, 4, 0]}
            isAnimationActive={false}
            barSize={22}
          >
            {sorted.map((r, i) => (
              <Cell
                key={i}
                fill={
                  Number(r[valueKey]) === max
                    ? "var(--chart-1)"
                    : "var(--chart-5)"
                }
              />
            ))}
            <LabelList
              dataKey={valueKey}
              position="right"
              style={{ fontSize: 10.5, fontWeight: 600, fill: "var(--text-2)" }}
              formatter={(v) => Number(v ?? 0).toLocaleString()}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {hidden > 0 ? (
        <button
          type="button"
          className="bars-more"
          onClick={() => onShowAll?.()}
        >
          + {hidden} more →
        </button>
      ) : null}
    </>
  );
}
