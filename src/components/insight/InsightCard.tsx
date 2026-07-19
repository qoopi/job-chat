"use client";

import { useMemo, useState } from "react";
import type { DataInsight } from "@shared/insight";
import { splitFirstNumber } from "@/lib/insight-format";
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

function freshness(chTs: string): string {
  const parsed = Date.parse(chTs.includes("T") ? chTs : `${chTs.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed)) return "";
  const mins = Math.round((Date.now() - parsed) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function InsightCard({
  insight,
  usedFollowups = [],
  onFollowup,
}: {
  insight: DataInsight;
  usedFollowups?: string[];
  onFollowup?: (text: string) => void;
}) {
  const isChart = insight.kind === "chart";
  const [tab, setTab] = useState<Tab>(isChart ? "chart" : "table");
  const [sqlOpen, setSqlOpen] = useState(false);

  const rows = isChart ? insight.series : insight.rows;
  const rel = freshness(insight.meta.updatedAt);

  // A stable element reference (keyed on the insight identity, not on tab/sqlOpen) so React bails out
  // of re-rendering the Recharts subtree when only the Show-query reveal toggles.
  const chartEl = useMemo(
    () => (insight.kind === "chart" ? <InsightChart chartType={insight.chartType} series={insight.series} /> : null),
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
        {isChart && tab === "chart" ? chartEl : <DataTable rows={rows} />}
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
                disabled={used}
                onClick={() => onFollowup?.(f)}
              >
                {used ? `${f} ✓` : f}
              </button>
            );
          })}
        </div>
        <span className="src">
          {insight.meta.sampleN.toLocaleString()} postings
          {/* freshness is Date.now()-relative, so a server/client render straddling a minute boundary
             would mismatch on hydration - suppress the (benign) warning on just this text. */}
          <span suppressHydrationWarning>{rel ? ` — updated ${rel}` : ""}</span> ·{" "}
          <button className="src-link" type="button" onClick={() => setSqlOpen((v) => !v)}>
            {sqlOpen ? "Hide query" : "Show query"}
          </button>
        </span>
      </div>
    </div>
  );
}
