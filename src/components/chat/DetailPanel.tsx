"use client";

import type { DetailContent } from "@/lib/chat-ui";
import { profileTitle } from "@/lib/profile-format";
import { DataTable } from "@/components/insight/charts/DataTable";
import { ProfileExpanded } from "@/components/insight/ProfileCard";
import { PostingsPanel } from "@/components/insight/PostingsCard";

// The detail panel: the canvas-centre body routed to one of three card-backed contents (table /
// profile-card / postings), re-resolved from the immutable payload so a resume renders identically.

function detailTitle(content: DetailContent): string {
  if (content.kind === "table") return content.insight.verdict;
  if (content.kind === "profile-card") return profileTitle(content.profile);
  return `${content.total} matching postings`;
}

/** The region's accessible name (tests locate the detail panel by it). */
function detailLabel(content: DetailContent): string {
  if (content.kind === "table") return "Full table";
  if (content.kind === "profile-card") return "Profile";
  return "Matching postings";
}

export function DetailPanel({ content, onClose }: { content: DetailContent; onClose: () => void }) {
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
        ) : (
          <PostingsPanel rows={content.rows} total={content.total} />
        )}
      </div>
    </section>
  );
}
