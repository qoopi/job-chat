import type { CSSProperties } from "react";

// Shared chart chrome so the five primitives read as one system (dataviz consistency). Colors are
// lifted as token names, never hex, so both themes flow through.
export const CHART_HEIGHT = 200;

/** The dark tooltip from the mocks (element-states board): near-black surface, light text. */
export const TOOLTIP_STYLE: CSSProperties = {
  background: "#18181b",
  border: "none",
  borderRadius: 8,
  color: "#fff",
  fontSize: 11,
  padding: "6px 10px",
  boxShadow: "var(--shadow-md)",
};

/** Axis tick text - matches the .axis class (10px, --text-3). */
export const axisTickStyle = {
  fontSize: 10,
  fill: "var(--text-3)",
} as const;

/** Categorical palette in order (donut / grouped bars cycle through these). */
export const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];
