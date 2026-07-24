"use client";

import type { DetailContent } from "@/lib/chat-ui";
import { profileTitle } from "@/lib/profile-format";
import { DataTable } from "@/components/insight/charts/DataTable";
import { ProfileExpanded } from "@/components/insight/ProfileCard";
import { PostingsPanel } from "@/components/insight/PostingsCard";
import { PostingDetailCard } from "@/components/insight/PostingDetailCard";

// The detail panel: the canvas-centre body routed to one of four card-backed contents (table / profile-card /
// postings / single posting), re-resolved from the immutable payload (or, for a single posting, from the
// on-demand fetch state) so a resume renders identically.

/** The single-posting header title across its fetch states. */
function postingTitle(content: Extract<DetailContent, { kind: "posting" }>): string {
  if (content.state.status === "loaded") return content.state.detail.title;
  if (content.state.status === "not-found") return "Posting unavailable";
  return "Loading posting…";
}

function detailTitle(content: DetailContent): string {
  if (content.kind === "table") return content.insight.verdict;
  if (content.kind === "profile-card") return profileTitle(content.profile);
  if (content.kind === "posting") return postingTitle(content);
  return `${content.total} matching postings`;
}

/** The region's accessible name (tests locate the detail panel by it). */
function detailLabel(content: DetailContent): string {
  if (content.kind === "table") return "Full table";
  if (content.kind === "profile-card") return "Profile";
  if (content.kind === "posting") return "Posting detail";
  return "Matching postings";
}

export function DetailPanel({
  content,
  onClose,
  onOpenPosting,
}: {
  content: DetailContent;
  onClose: () => void;
  /** Opens a single posting's detail from a row title (threaded to the postings-list surface). */
  onOpenPosting?: (source: string, externalId: string) => void;
}) {
  const title = detailTitle(content);
  return (
    <section className="detail-panel" role="region" aria-label={detailLabel(content)}>
      <div className="detail-panel-head">
        <span className="detail-panel-title" title={title}>
          {title}
        </span>
        <button className="x-btn" type="button" aria-label={`Close ${detailLabel(content).toLowerCase()}`} onClick={onClose}>
          &times;
        </button>
      </div>
      <div className="detail-panel-body">
        {content.kind === "table" ? (
          <DataTable
            rows={content.insight.kind === "table" ? content.insight.rows : content.insight.series}
            currency={content.insight.meta.currency}
          />
        ) : content.kind === "profile-card" ? (
          <ProfileExpanded profile={content.profile} />
        ) : content.kind === "posting" ? (
          <PostingDetailCard state={content.state} />
        ) : (
          <PostingsPanel rows={content.rows} total={content.total} mode={content.mode} onOpenPosting={onOpenPosting} />
        )}
      </div>
    </section>
  );
}
