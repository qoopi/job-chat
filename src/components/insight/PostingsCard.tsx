"use client";

import { useMemo, useState } from "react";
import type { ScoredPostingRow } from "@shared/insight";
import {
  corpusHonesty,
  hasSalary,
  isSeniorPlus,
  latestPostingsVerdict,
  locationLabel,
  openPanelLabel,
  postingsVerdict,
  salaryLabel,
  shownCount,
  POSTINGS_INCHAT_CAP,
} from "@/lib/postings-format";
import { Verdict } from "./Verdict";

// The job-postings card (an InsightCard child). Rows are score-ordered: ORDER IS THE RANK (no percentages/badges).
// Two surfaces: the in-chat card (capped, honesty caption, no-matches variant) and the detail panel full list (PostingsPanel).

/** A callback that opens one posting's in-app detail from its natural key. */
type OpenPosting = (source: string, externalId: string) => void;

/** The role cell: the title CLICKS THROUGH to the in-app posting detail (Apply lives inside that detail). A
 *  row carrying the natural key renders a title button; an older snapshot row (no key) or no handler renders
 *  plain text - no dead affordance. */
function RoleCell({ row, onOpenPosting }: { row: ScoredPostingRow; onOpenPosting?: OpenPosting }) {
  const title = <strong>{row.title}</strong>;
  const { source, externalId } = row;
  if (!onOpenPosting || !source || !externalId) return title;
  return (
    <button type="button" className="posting-title-btn" onClick={() => onOpenPosting(source, externalId)}>
      {title}
    </button>
  );
}

/** The 5-column table body. A missing salary reads muted "not listed" (never blank). */
function PostingsTable({ rows, onOpenPosting }: { rows: ScoredPostingRow[]; onOpenPosting?: OpenPosting }) {
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
                <RoleCell row={r} onOpenPosting={onOpenPosting} />
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
  mode,
  onFollowup,
  onOpenPanel,
  onOpenPosting,
  onEdit,
  pending = false,
}: {
  rows: ScoredPostingRow[];
  total: number;
  /** "latest" = a plain latest-list header (neutral: no "match your profile"/best-by-score). Absent = the fit card. */
  mode?: "latest";
  /** A follow-up prompt chip ("Only remote", "Include one level up"). Disabled while a turn streams. */
  onFollowup?: (text: string) => void;
  /** "Open all N in panel" - opens the detail panel full list. */
  onOpenPanel?: () => void;
  /** A row title click - opens that single posting's in-app detail. */
  onOpenPosting?: OpenPosting;
  /** "Edit profile" (no-matches way-out) - opens the detail panel profile form. */
  onEdit?: () => void;
  pending?: boolean;
}) {
  // The chips are CLIENT-SIDE toggles over the DELIVERED rows - never a chat turn (the old
  // follow-up re-derived search params and returned MORE rows). Composable (AND). Counts are honest to
  // the delivered set only; the server `total` is never re-queried (that re-query is out of scope).
  // Hooks run before the no-matches early return (rules-of-hooks) - unused on that path.
  const [onlyRemote, setOnlyRemote] = useState(false);
  const [onlySalary, setOnlySalary] = useState(false);
  const remoteCount = useMemo(() => rows.filter((r) => r.remote).length, [rows]);
  const salaryCount = useMemo(() => rows.filter(hasSalary).length, [rows]);
  const filtered = useMemo(
    () => rows.filter((r) => (!onlyRemote || r.remote) && (!onlySalary || hasSalary(r))),
    [rows, onlyRemote, onlySalary],
  );

  // No-matches variant: a COMPACT notice (an honest line + the two way-out chips), never the hollow
  // chart-card frame. The two chips do something real - "Include one level up" relaxes the seniority band
  // and "Edit profile" opens the editor; "Broaden location" was dropped (city is a score addend, not a
  // filter, so re-asking with it widened recall by nothing).
  if (total === 0) {
    return (
      <div className="postings-empty">
        <p className="verdict">No strong matches for your profile yet.</p>
        <div className="followups">
          <button className="chip" type="button" disabled={pending} onClick={() => onFollowup?.("Include one level up")}>
            Include one level up
          </button>
          <button className="chip" type="button" onClick={onEdit}>
            Edit profile
          </button>
        </div>
      </div>
    );
  }

  const filtering = onlyRemote || onlySalary;
  const visible = filtered.slice(0, POSTINGS_INCHAT_CAP);
  // "latest" mode reads as a neutral recency list; the default is the profile-fit headline.
  const headline = mode === "latest" ? latestPostingsVerdict : postingsVerdict;
  return (
    <div className="insight" style={{ maxWidth: 760 }}>
      <div className="insight-head">
        {/* Under an active filter the "showing the best N" tail would contradict the filtered table
            (honesty). Pass shown=total to suppress the tail while the honest server total stays;
            the full headline restores when the filter clears. */}
        <Verdict text={headline(total, filtering ? total : shownCount(rows))} />
      </div>
      <div className="insight-body">
        {filtered.length > 0 ? (
          <>
            <PostingsTable rows={visible} onOpenPosting={onOpenPosting} />
            <HonestyCaption rows={filtered} />
          </>
        ) : (
          <div style={{ fontSize: 13, color: "var(--text-2)", padding: "8px 2px" }}>
            None of these {rows.length} match that filter.
          </div>
        )}
      </div>
      <div className="insight-foot">
        <div className="followups">
          {rows.length > POSTINGS_INCHAT_CAP ? (
            <button className="chip chip-accent" type="button" onClick={onOpenPanel}>
              {openPanelLabel(rows.length, total)} in panel
            </button>
          ) : null}
          <button
            className={onlyRemote ? "chip chip-accent" : "chip"}
            type="button"
            aria-pressed={onlyRemote}
            onClick={() => setOnlyRemote((v) => !v)}
          >
            Only remote · {remoteCount}
          </button>
          <button
            className={onlySalary ? "chip chip-accent" : "chip"}
            type="button"
            aria-pressed={onlySalary}
            onClick={() => setOnlySalary((v) => !v)}
          >
            Only with salary · {salaryCount}
          </button>
        </div>
        <span className="src">
          {filtering
            ? `${Math.min(filtered.length, POSTINGS_INCHAT_CAP)} of ${filtered.length} shown`
            : `${shownCount(rows)} of ${total} ${mode === "latest" ? "shown" : "matches"}`}
        </span>
      </div>
    </div>
  );
}

type Filter = "all" | "salary" | "remote" | "senior";

/** The detail panel full list: the same table uncapped, with local filter chips (All / With salary / Remote /
 *  Senior+), each labelled with its count. Rendered inside the DetailPanel body. */
export function PostingsPanel({
  rows,
  total,
  mode,
  onOpenPosting,
}: {
  rows: ScoredPostingRow[];
  total: number;
  /** "latest" = neutral footer wording ("shown"); absent = the fit-list "matches". */
  mode?: "latest";
  onOpenPosting?: OpenPosting;
}) {
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
      <PostingsTable rows={filtered} onOpenPosting={onOpenPosting} />
      <span className="src">
        {filtered.length} of {total} {mode === "latest" ? "shown" : "matches"}
      </span>
    </div>
  );
}
