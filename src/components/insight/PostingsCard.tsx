"use client";

import { useMemo, useState } from "react";
import type { ScoredPostingRow } from "@shared/insight";
import { splitFirstNumber } from "@/lib/insight-format";
import {
  corpusHonesty,
  hasSalary,
  isSeniorPlus,
  locationLabel,
  openPanelLabel,
  postingsVerdict,
  salaryLabel,
  shownCount,
  POSTINGS_INCHAT_CAP,
} from "@/lib/postings-format";

// The job-postings card - an InsightCard child. Rows are score-ordered: ORDER IS THE RANK (no
// percentages, no fit badges). Two surfaces: the in-chat card (capped at 8 + the corpus-honesty
// caption + a no-matches variant) and the LCP full list (PostingsPanel, uncapped + local filter chips).

/** The verdict with its first number (the total) bolded, matching the InsightCard verdict treatment. */
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

/** The 5-column table body. A missing salary reads muted "not listed" (never blank). */
function PostingsTable({ rows }: { rows: ScoredPostingRow[] }) {
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>Role</th>
          <th>Company</th>
          <th>Location</th>
          <th className="r">Salary</th>
          <th className="r">Level</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const salary = salaryLabel(r);
          return (
            <tr key={i}>
              <td>
                <strong>{r.title}</strong>
              </td>
              <td>{r.company}</td>
              <td>{locationLabel(r)}</td>
              <td className="r" style={hasSalary(r) ? undefined : { color: "var(--text-3)" }}>
                {salary}
              </td>
              <td className="r">{r.experience}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The computed corpus-honesty caption ("Most matches are at Google — it posts 93% of this corpus."). */
function HonestyCaption({ rows }: { rows: ScoredPostingRow[] }) {
  const honesty = corpusHonesty(rows);
  if (!honesty) return null;
  return (
    <div style={{ fontSize: 11.5, color: "var(--text-3)", padding: "8px 2px 0" }}>
      Most matches are at {honesty.company} — it posts {honesty.share}% of this corpus.
    </div>
  );
}

export function PostingsCard({
  rows,
  total,
  onFollowup,
  onOpenPanel,
  onEdit,
  pending = false,
}: {
  rows: ScoredPostingRow[];
  total: number;
  /** A follow-up prompt chip ("Only remote", "Include one level up"). Disabled while a turn streams. */
  onFollowup?: (text: string) => void;
  /** "Open all N in panel" - opens the LCP full list. */
  onOpenPanel?: () => void;
  /** "Edit profile" (no-matches way-out) - opens the LCP profile form. */
  onEdit?: () => void;
  pending?: boolean;
}) {
  // No-matches variant: a numeric near-miss verdict + way-out chips. The payload carries no dedicated
  // near-miss field, so the rows present ARE the near-misses and rows[0] is the closest.
  if (total === 0) {
    const near = rows.length;
    const closest = rows[0];
    const verdict =
      near > 0
        ? `No strong matches yet — ${near} near-miss${near === 1 ? "" : "es"} sit just outside your profile.`
        : "No strong matches yet.";
    return (
      <div className="insight" style={{ maxWidth: 640 }}>
        <div className="insight-head">
          <Verdict text={verdict} />
        </div>
        {closest ? (
          <div className="insight-body">
            <div style={{ fontSize: 13, color: "var(--text-2)", padding: "2px 0 6px" }}>
              Closest: {closest.title} at {closest.company}
              {closest.city ? `, ${closest.city}` : ""}.
            </div>
          </div>
        ) : null}
        <div className="insight-foot">
          <div className="followups">
            <button className="chip" type="button" disabled={pending} onClick={() => onFollowup?.("Include one level up")}>
              Include one level up
            </button>
            <button className="chip" type="button" disabled={pending} onClick={() => onFollowup?.("Broaden location")}>
              Broaden location
            </button>
            <button className="chip" type="button" onClick={onEdit}>
              Edit profile
            </button>
          </div>
          <span className="src">matched against your profile</span>
        </div>
      </div>
    );
  }

  const shown = shownCount(rows);
  const visible = rows.slice(0, POSTINGS_INCHAT_CAP);
  return (
    <div className="insight" style={{ maxWidth: 760 }}>
      <div className="insight-head">
        <Verdict text={postingsVerdict(total, shown)} />
      </div>
      <div className="insight-body">
        <PostingsTable rows={visible} />
        <HonestyCaption rows={rows} />
      </div>
      <div className="insight-foot">
        <div className="followups">
          {rows.length > POSTINGS_INCHAT_CAP ? (
            <button className="chip chip-accent" type="button" onClick={onOpenPanel}>
              {openPanelLabel(rows.length, total)} in panel
            </button>
          ) : null}
          <button className="chip" type="button" disabled={pending} onClick={() => onFollowup?.("Only remote")}>
            Only remote
          </button>
          <button className="chip" type="button" disabled={pending} onClick={() => onFollowup?.("Only with salary")}>
            Only with salary
          </button>
        </div>
        <span className="src">
          {shown} of {total} matches
        </span>
      </div>
    </div>
  );
}

type Filter = "all" | "salary" | "remote" | "senior";

/** The LCP full list: the same table uncapped, with local filter chips (All / With salary / Remote /
 *  Senior+), each labelled with its count. Rendered inside the LcpPanel body. */
export function PostingsPanel({ rows, total }: { rows: ScoredPostingRow[]; total: number }) {
  const [filter, setFilter] = useState<Filter>("all");
  const counts = useMemo(
    () => ({
      all: rows.length,
      salary: rows.filter(hasSalary).length,
      remote: rows.filter((r) => r.remote).length,
      senior: rows.filter(isSeniorPlus).length,
    }),
    [rows],
  );
  const filtered = useMemo(() => {
    if (filter === "salary") return rows.filter(hasSalary);
    if (filter === "remote") return rows.filter((r) => r.remote);
    if (filter === "senior") return rows.filter(isSeniorPlus);
    return rows;
  }, [rows, filter]);

  const chips: { key: Filter; label: string }[] = [
    { key: "all", label: `All · ${counts.all}` },
    { key: "salary", label: `With salary · ${counts.salary}` },
    { key: "remote", label: `Remote · ${counts.remote}` },
    { key: "senior", label: `Senior+ · ${counts.senior}` },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="followups" role="group" aria-label="Filter postings">
        {chips.map((c) => (
          <button
            key={c.key}
            className={filter === c.key ? "chip chip-accent" : "chip"}
            type="button"
            aria-pressed={filter === c.key}
            onClick={() => setFilter(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <PostingsTable rows={filtered} />
      <span className="src">
        {filtered.length} of {total} matches
      </span>
    </div>
  );
}
