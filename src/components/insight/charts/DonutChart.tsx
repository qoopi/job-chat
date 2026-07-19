"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { DataPoint } from "@shared/insight";
import { labelKeyOf, valueKeyOf } from "@/lib/insight-format";
import { CHART_COLORS, TOOLTIP_STYLE } from "./chart-style";

// Share donut (share_split: {label, count}). The center shows the leading slice's share; a legend
// list beside it names each slice with its count and percentage. Q5/Q6 are pinned to this visual.
export function DonutChart({ series }: { series: DataPoint[] }) {
  const labelKey = labelKeyOf(series);
  const valueKey = valueKeyOf(series, labelKey);
  const total = series.reduce((sum, r) => sum + Number(r[valueKey]), 0) || 1;
  const top = [...series].sort((a, b) => Number(b[valueKey]) - Number(a[valueKey]))[0];
  const topPct = top ? Math.round((Number(top[valueKey]) / total) * 100) : 0;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
      <div style={{ position: "relative", width: 180, height: 180, flexShrink: 0 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={series}
              dataKey={valueKey}
              nameKey={labelKey}
              innerRadius={52}
              outerRadius={78}
              startAngle={90}
              endAngle={-270}
              stroke="none"
              isAnimationActive={false}
            >
              {series.map((_, i) => (
                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip contentStyle={TOOLTIP_STYLE} />
          </PieChart>
        </ResponsiveContainer>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            pointerEvents: "none",
          }}
        >
          <span style={{ fontSize: 22, fontWeight: 700, color: "var(--text)" }}>{topPct}%</span>
          <span style={{ fontSize: 11, color: "var(--text-3)" }}>{String(top?.[labelKey] ?? "")}</span>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13, color: "var(--text-2)" }}>
        {series.map((r, i) => {
          const pct = Math.round((Number(r[valueKey]) / total) * 100);
          return (
            <span key={i}>
              <span
                style={{
                  display: "inline-block",
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  marginRight: 8,
                  background: CHART_COLORS[i % CHART_COLORS.length],
                }}
              />
              {String(r[labelKey])} &mdash; <strong>{Number(r[valueKey]).toLocaleString()}</strong> ({pct}%)
            </span>
          );
        })}
      </div>
    </div>
  );
}
