"use client";

import { useCallback, useMemo, useState } from "react";
import type { DataInsight } from "@shared/insight";
import {
  barsChartCapsAt,
  freshnessLabel,
  isSingleScalar,
} from "@/lib/insight-format";
import { LCP_TABLE_PREVIEW_ROWS, tablePlacement } from "@/lib/table-placement";
import { InsightChart } from "./charts/InsightChart";
import { DataTable } from "./charts/DataTable";
import { CodeBlock } from "./CodeBlock";
import { Verdict } from "./Verdict";

// The hero component: verdict (number in <b>), Chart|Table tabs, one visual, chips, and a "Show query" source line.
type Tab = "chart" | "table";

export function InsightCard({
  insight,
  usedFollowups = [],
  onFollowup,
  onOpenLcp,
  messageId,
  partId,
  pending = false,
}: {
  insight: DataInsight;
  usedFollowups?: string[];
  onFollowup?: (text: string) => void;
  /** Open this card's full table in the LCP by its STABLE message + part id (stable ids keep the chart-subtree memo stable). */
  onOpenLcp?: (messageId: string, partId: string) => void;
  messageId?: string;
  partId?: string;
  /** A turn is in flight: chips are disabled so one can't fire a concurrent send racing the live turn. */
  pending?: boolean;
}) {
  const isChart = insight.kind === "chart";
  // A single-scalar answer renders as the verdict alone - no table body, no tabs (chips + Show query stay).
  const scalar = isSingleScalar(insight);
  const [tab, setTab] = useState<Tab>(isChart ? "chart" : "table");
  const [sqlOpen, setSqlOpen] = useState(false);

  const rows = isChart ? insight.series : insight.rows;
  // Any table VIEW over the threshold renders as a preview + "Open full table" (one rule for every table view).
  const previewTable = tab === "table" && tablePlacement(rows) === "lcp";
  // Suppress the source line on an empty (sampleN 0) result (no "0 postings", no epoch freshness); defensive.
  const showSource = insight.meta.sampleN > 0;
  const rel = freshnessLabel(insight.meta.updatedAt);
  // When the chart caps its bars, the source line discloses "showing top N" so the slice never poses as the whole market.
  const topN = barsChartCapsAt(insight);
  const showTopN = isChart && tab === "chart" && topN !== null;

  // Stable ids keep `openTable` stable, so the chartEl memo can depend on it without recomputing the Recharts subtree.
  const openTable = useCallback(() => {
    if (onOpenLcp && messageId !== undefined && partId !== undefined) onOpenLcp(messageId, partId);
  }, [onOpenLcp, messageId, partId]);

  // A stable element ref (keyed on insight identity) so React bails on re-rendering the Recharts subtree when only Show-query/pending toggles.
  const chartEl = useMemo(
    () =>
      insight.kind === "chart" ? (
        <InsightChart
          chartType={insight.chartType}
          series={insight.series}
          currency={insight.meta.currency}
          onShowAll={openTable}
        />
      ) : null,
    [insight, openTable],
  );

  // ARIA tablist so a screen reader announces the selected view; a table-only insight keeps the pair with Chart disabled.
  const panelId = `${insight.id}-panel`;
  const chartTabId = `${insight.id}-tab-chart`;
  const tableTabId = `${insight.id}-tab-table`;

  return (
    <div className="insight">
      <div className="insight-head">
        <Verdict text={insight.verdict} />
        {scalar ? null : (
          <div className="tabs" role="tablist" aria-label="Result view">
            <button
              id={chartTabId}
              role="tab"
              aria-selected={tab === "chart"}
              aria-controls={panelId}
              className={tab === "chart" ? "tab active" : "tab"}
              type="button"
              disabled={!isChart}
              onClick={() => setTab("chart")}
            >
              Chart
            </button>
            <button
              id={tableTabId}
              role="tab"
              aria-selected={tab === "table"}
              aria-controls={panelId}
              className={tab === "table" ? "tab active" : "tab"}
              type="button"
              onClick={() => setTab("table")}
            >
              Table
            </button>
          </div>
        )}
      </div>

      <div
        className="insight-body"
        id={panelId}
        role={scalar ? undefined : "tabpanel"}
        aria-labelledby={scalar ? undefined : tab === "chart" ? chartTabId : tableTabId}
      >
        {/* A single scalar is fully stated by the verdict - no body, only the optional Show-query. */}
        {scalar ? null : isChart && tab === "chart" ? (
          chartEl
        ) : previewTable ? (
          <div className="table-preview">
            <DataTable
              rows={rows.slice(0, LCP_TABLE_PREVIEW_ROWS)}
              currency={insight.meta.currency}
            />
            <button
              className="btn btn-outline btn-sm open-full-table"
              type="button"
              onClick={openTable}
            >
              Open full table ({rows.length.toLocaleString()} rows)
            </button>
          </div>
        ) : (
          <DataTable rows={rows} currency={insight.meta.currency} />
        )}
        {sqlOpen ? <CodeBlock sql={insight.meta.sql} /> : null}
      </div>

      <div className="insight-foot">
        <div className="followups">
          {insight.followups.map((f) => {
            const used = usedFollowups.includes(f);
            return (
              <button
                key={f}
                className="chip"
                type="button"
                disabled={used || pending}
                onClick={() => onFollowup?.(f)}
              >
                {used ? `${f} ✓` : f}
              </button>
            );
          })}
        </div>
        {showSource ? (
          <span className="src">
            {insight.meta.sampleN.toLocaleString()}{" "}
            {insight.meta.openSet ? "open postings" : "postings"}
            {/* Salary aggregates are one currency; disclose the base so a mixed corpus never reads as if the median spanned all. */}
            {insight.meta.currency
              ? ` · salaries in ${insight.meta.currency}`
              : ""}
            {/* the chart is a top-N slice - disclosed beside the real total. */}
            {showTopN ? ` · showing top ${topN}` : ""}
            {/* freshness is Date.now()-relative; a render straddling a minute boundary mismatches on hydration - suppress the benign warning. */}
            <span suppressHydrationWarning>
              {rel ? ` — updated ${rel}` : ""}
            </span>{" "}
            ·{" "}
            <button
              className="src-link"
              type="button"
              onClick={() => setSqlOpen((v) => !v)}
            >
              {sqlOpen ? "Hide query" : "Show query"}
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
