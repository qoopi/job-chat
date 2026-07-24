"use client";

import type { PostingDetail } from "@shared/insight";
import type { PostingDetailState } from "@/lib/chat-ui";
import { salaryLabel } from "@/lib/postings-format";

// The single-posting detail (DetailPanel "posting" kind), fetched on demand by getPostingDetail. The
// description is SAFE pre-wrapped TEXT (React escapes it; htmlToText already stripped the HTML at ingest) -
// NEVER dangerouslySetInnerHTML. Apply is a prominent new-tab link with the safe rel; absent -> no button.

/** The location line: Remote, else the non-empty city/region/country joined, else an em dash. */
function locationLine(detail: PostingDetail): string {
  if (detail.remote) return "Remote";
  const parts = [detail.city, detail.region, detail.country].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(", ") : "—";
}

function LoadedDetail({ detail }: { detail: PostingDetail }) {
  const meta = [detail.company, locationLine(detail), detail.department, salaryLabel(detail)].filter(Boolean);
  return (
    <div className="posting-detail">
      <div className="posting-detail-head">
        <h2 className="posting-detail-title">{detail.title}</h2>
        <div className="posting-detail-meta">
          {meta.map((m, i) => (
            <span key={i}>{m}</span>
          ))}
        </div>
      </div>
      {detail.applyUrl ? (
        <a className="btn btn-primary posting-detail-apply" href={detail.applyUrl} target="_blank" rel="noopener noreferrer">
          Apply
        </a>
      ) : null}
      {detail.descriptionText ? (
        // pre-wrapped plain text: newlines from htmlToText survive via CSS white-space, no markup is parsed.
        <div className="posting-detail-desc">{detail.descriptionText}</div>
      ) : (
        <p className="posting-detail-note">No description provided.</p>
      )}
    </div>
  );
}

export function PostingDetailCard({ state }: { state: PostingDetailState }) {
  if (state.status === "loading") return <p className="posting-detail-note">Loading posting…</p>;
  if (state.status === "not-found") return <p className="posting-detail-note">This posting is no longer available.</p>;
  return <LoadedDetail detail={state.detail} />;
}
