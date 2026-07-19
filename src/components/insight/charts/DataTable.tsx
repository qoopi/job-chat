"use client";

import { useMemo, useState } from "react";
import type { DataPoint } from "@shared/insight";
import { formatUsd } from "@/lib/insight-format";

// The fifth primitive: a sortable data table (kind:"table", and the Table tab of any chart insight).
// Header click cycles none -> desc -> asc (element-states board). No apply/save link cells (scope note).
type Dir = "none" | "desc" | "asc";

function humanize(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function isMoneyKey(key: string): boolean {
  return /salary|median|pay|target/i.test(key);
}

function formatCell(key: string, value: string | number | null): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") return isMoneyKey(key) ? formatUsd(value) : value.toLocaleString();
  return value;
}

export function DataTable({ rows }: { rows: DataPoint[] }) {
  const columns = useMemo(() => (rows[0] ? Object.keys(rows[0]) : []), [rows]);
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [dir, setDir] = useState<Dir>("none");

  const sorted = useMemo(() => {
    if (!sortKey || dir === "none") return rows;
    const factor = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * factor;
      return String(av ?? "").localeCompare(String(bv ?? "")) * factor;
    });
  }, [rows, sortKey, dir]);

  function onSort(key: string) {
    if (sortKey !== key) {
      setSortKey(key);
      setDir("desc");
      return;
    }
    setDir((d) => (d === "none" ? "desc" : d === "desc" ? "asc" : "none"));
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((key) => {
              const active = sortKey === key && dir !== "none";
              const numeric = typeof rows[0]?.[key] === "number";
              return (
                <th
                  key={key}
                  className={`${numeric ? "r" : ""} ${active ? "sorted" : ""}`.trim()}
                  onClick={() => onSort(key)}
                >
                  {humanize(key)}
                  {active ? (dir === "desc" ? " ▾" : " ▴") : ""}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={i}>
              {columns.map((key) => (
                <td key={key} className={typeof row[key] === "number" ? "r" : ""}>
                  {formatCell(key, row[key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
