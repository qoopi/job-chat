"use client";

import type { LcpContent } from "@/lib/chat-ui";
import { profileTitle } from "@/lib/profile-format";
import { DataTable } from "@/components/insight/charts/DataTable";
import { ProfileExpanded } from "@/components/insight/ProfileCard";
import { PostingsPanel } from "@/components/insight/PostingsCard";

// The Left Chat Part (interaction-spec section 1). It takes the middle of the canvas while the chat
// docks to the 360px right rail: a 48px header (title left, close right) + a routed body. The body is
// one of three card-backed content types (LcpContent), re-resolved from the immutable message payload
// so a resumed conversation renders the same LCP:
//  - table:        an over-threshold insight table, uncapped
//  - profile-card: the expanded profile (READ-ONLY this window)
//  - postings:     the full postings list with local filter chips
// The profile FORM is a separate LCP state (LcpProfile), opened from the menu / an invite, not here.

/** The panel title for each content type. */
function lcpTitle(content: LcpContent): string {
  if (content.kind === "table") return content.insight.verdict;
  if (content.kind === "profile-card") return profileTitle(content.profile);
  return `${content.total} matching postings`;
}

/** The region's accessible name (the e2e/tests locate the LCP by it). */
function lcpLabel(content: LcpContent): string {
  if (content.kind === "table") return "Full table";
  if (content.kind === "profile-card") return "Profile";
  return "Matching postings";
}

export function LcpPanel({ content, onClose }: { content: LcpContent; onClose: () => void }) {
  const title = lcpTitle(content);
  return (
    <section className="lcp" role="region" aria-label={lcpLabel(content)}>
      <div className="lcp-head">
        <span className="lcp-title" title={title}>
          {title}
        </span>
        <button className="x-btn" type="button" aria-label={`Close ${lcpLabel(content).toLowerCase()}`} onClick={onClose}>
          &times;
        </button>
      </div>
      <div className="lcp-body">
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
