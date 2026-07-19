"use client";

import { useState } from "react";
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
}: {
  insight: DataInsight;
  usedFollowups?: string[];
}) {
  const isChart = insight.kind === "chart";
  const [tab, setTab] = useState<Tab>(isChart ? "chart" : "table");
  const [sqlOpen, setSqlOpen] = useState(false);

  const rows = isChart ? insight.series : insight.rows;
  const rel = freshness(insight.meta.updatedAt);

  return (
    <div className="insight">
      <div className="insight-head">
        <Verdict text={insight.verdict} />
        <div className="tabs">
          {isChart ? (
            <button
              className={tab === "chart" ? "tab active" : "tab"}
              type="button"
              onClick={() => setTab("chart")}
            >
              Chart
            </button>
          ) : null}
          <button
            className={tab === "table" ? "tab active" : "tab"}
            type="button"
            onClick={() => setTab("table")}
          >
            Table
          </button>
        </div>
      </div>

      <div className="insight-body">
        {isChart && tab === "chart" ? (
          <InsightChart chartType={insight.chartType} series={insight.series} />
        ) : (
          <DataTable rows={rows} />
        )}
        {sqlOpen ? <CodeBlock sql={insight.meta.sql} /> : null}
      </div>

      <div className="insight-foot">
        <div className="followups">
          {insight.followups.map((f) => {
            const used = usedFollowups.includes(f);
            return (
              <button key={f} className="chip" type="button" disabled={used}>
                {used ? `${f} ✓` : f}
              </button>
            );
          })}
        </div>
        <span className="src">
          {insight.meta.sampleN.toLocaleString()} postings
          {rel ? ` — updated ${rel}` : ""} ·{" "}
          <button className="src-link" type="button" onClick={() => setSqlOpen((v) => !v)}>
            {sqlOpen ? "Hide query" : "Show query"}
          </button>
        </span>
      </div>
    </div>
  );
}
