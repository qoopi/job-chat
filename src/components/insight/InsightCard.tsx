"use client";

import { useMemo, useState } from "react";
import type { DataInsight } from "@shared/insight";
import { freshnessLabel, splitFirstNumber } from "@/lib/insight-format";
import { LCP_TABLE_PREVIEW_ROWS, tablePlacement } from "@/lib/table-placement";
import { InsightChart } from "./charts/InsightChart";
import { DataTable } from "./charts/DataTable";
import { CodeBlock } from "./CodeBlock";

// The hero component (AC-4/AC-6/AC-6b): verdict with the number in <b>, Chart|Table tabs, one visual,
// follow-up chips, and a source line whose "Show query" reveals the executed SQL. Fed a DataInsight
// (shared/insight.ts) so 006 swaps the data source, not this component. Chips/tabs are interactive but
// chip *sending* is inert here - 006 wires it.
type Tab = "chart" | "table";

function Verdict({ text }: { text: string }) {
  const split = splitFirstNumber(text);
  if (!split) return <p className="verdict">{text}</p>;
  const [pre, num, post] = split;
  return (
    <p className="verdict">
      {pre}
      <b>{num}</b>
      {post}
    </p>
  );
}

export function InsightCard({
  insight,
  usedFollowups = [],
  onFollowup,
  onOpenTable,
  pending = false,
}: {
  insight: DataInsight;
  usedFollowups?: string[];
  onFollowup?: (text: string) => void;
  /** AC-8: open the full table in the LCP. Called from the over-threshold preview affordance. */
  onOpenTable?: () => void;
  /** A turn is in flight: follow-up chips are disabled while it streams, consistent with the composer's
   *  streaming-disabled state, so a chip cannot fire a concurrent send that races the live turn. */
  pending?: boolean;
}) {
  const isChart = insight.kind === "chart";
  const [tab, setTab] = useState<Tab>(isChart ? "chart" : "table");
  const [sqlOpen, setSqlOpen] = useState(false);

  const rows = isChart ? insight.series : insight.rows;
  // AC-8 + Ruling 27: any table VIEW over the row threshold renders as a 5-row preview + an "Open full
  // table" affordance that opens the full body in the LCP - a table insight AND a chart card's Table tab
  // (one rule for every table view). A chart's Chart tab is unaffected (it renders the chart, not rows).
  const previewTable = tab === "table" && tablePlacement(rows) === "lcp";
  // Suppress the whole source line on an empty (sampleN 0) result: no "0 postings", no epoch freshness.
  // A real answer always has sampleN > 0; this is defensive - an empty result now renders no card at all.
  const showSource = insight.meta.sampleN > 0;
  const rel = freshnessLabel(insight.meta.updatedAt);

  // A stable element reference (keyed on the insight identity, not on tab/sqlOpen) so React bails out
  // of re-rendering the Recharts subtree when only the Show-query reveal toggles.
  const chartEl = useMemo(
    () =>
      insight.kind === "chart" ? (
        <InsightChart chartType={insight.chartType} series={insight.series} currency={insight.meta.currency} />
      ) : null,
    [insight],
  );

  // The tabs are an ARIA tablist so a screen reader announces the selected view. A table-only insight
  // keeps the Chart|Table pair per the mock, with Chart disabled (there is no chart to switch to).
  const panelId = `${insight.id}-panel`;
  const chartTabId = `${insight.id}-tab-chart`;
  const tableTabId = `${insight.id}-tab-table`;

  return (
    <div className="insight">
      <div className="insight-head">
        <Verdict text={insight.verdict} />
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
      </div>

      <div
        className="insight-body"
        id={panelId}
        role="tabpanel"
        aria-labelledby={tab === "chart" ? chartTabId : tableTabId}
      >
        {isChart && tab === "chart" ? (
          chartEl
        ) : previewTable ? (
          <div className="table-preview">
            <DataTable rows={rows.slice(0, LCP_TABLE_PREVIEW_ROWS)} currency={insight.meta.currency} />
            <button
              className="btn btn-outline btn-sm open-full-table"
              type="button"
              onClick={() => onOpenTable?.()}
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
            {insight.meta.sampleN.toLocaleString()} {insight.meta.openSet ? "open postings" : "postings"}
            {/* Salary aggregates are filtered to one currency; disclose the base so a mixed-currency
               corpus never reads as if the median spanned everything (018 strand 3). */}
            {insight.meta.currency ? ` · salaries in ${insight.meta.currency}` : ""}
            {/* freshness is Date.now()-relative, so a server/client render straddling a minute boundary
               would mismatch on hydration - suppress the (benign) warning on just this text. */}
            <span suppressHydrationWarning>{rel ? ` — updated ${rel}` : ""}</span> ·{" "}
            <button className="src-link" type="button" onClick={() => setSqlOpen((v) => !v)}>
              {sqlOpen ? "Hide query" : "Show query"}
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
}
