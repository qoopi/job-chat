"use client";

import { useMemo, useState } from "react";
import type { DataPoint } from "@shared/insight";
import { formatMoney } from "@/lib/insight-format";

// A sortable data table (kind:"table" + the Table tab of any chart). Header click cycles none -> desc -> asc.
type Dir = "none" | "desc" | "asc";

function humanize(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// `bucket` is a numeric salary floor - format as money; a composed time bucket is a date STRING (never hits the money branch).
function isMoneyKey(key: string): boolean {
  return /salary|median|pay|target|bucket/i.test(key);
}

function formatCell(key: string, value: string | number | null, currency: string): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "number") return isMoneyKey(key) ? formatMoney(value, currency) : value.toLocaleString();
  return value;
}

// The posting apply link rides as an ordinary row field but is NEVER its own column: it turns the role
// cell into a new-tab link. A postings table (latest_postings) is the only one that carries it; every other
// table lacks the key and renders exactly as before.
const APPLY_KEY = "apply_url";

/** A non-empty apply link on this row, else "". */
function applyLinkOf(row: DataPoint): string {
  const v = row[APPLY_KEY];
  return typeof v === "string" ? v : "";
}

export function DataTable({ rows, currency = "USD" }: { rows: DataPoint[]; currency?: string }) {
  // Drop apply_url from the visible columns; it links the role cell instead. Prefer the `title` column as
  // the link anchor (its column in latest_postings), falling back to the first column.
  const columns = useMemo(
    () => (rows[0] ? Object.keys(rows[0]).filter((k) => k !== APPLY_KEY) : []),
    [rows],
  );
  const linkColumn = columns.includes("title") ? "title" : columns[0];
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
              // aria-sort exposes sort state to assistive tech; the <button> makes it keyboard-operable (WCAG). Label+glyph stay inside for the accessible name.
              const ariaSort = active ? (dir === "desc" ? "descending" : "ascending") : "none";
              return (
                <th
                  key={key}
                  className={`${numeric ? "r" : ""} ${active ? "sorted" : ""}`.trim()}
                  aria-sort={ariaSort}
                >
                  <button type="button" className="th-sort" onClick={() => onSort(key)}>
                    {humanize(key)}
                    {active ? (dir === "desc" ? " ▾" : " ▴") : ""}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => {
            const link = applyLinkOf(row);
            return (
              <tr key={i}>
                {columns.map((key) => {
                  const cell = formatCell(key, row[key], currency);
                  return (
                    <td key={key} className={typeof row[key] === "number" ? "r" : ""}>
                      {key === linkColumn && link ? (
                        <a href={link} target="_blank" rel="noopener noreferrer">
                          {cell}
                        </a>
                      ) : (
                        cell
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
