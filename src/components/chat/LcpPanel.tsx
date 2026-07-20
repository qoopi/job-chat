"use client";

import type { DataInsight } from "@shared/insight";
import { DataTable } from "@/components/insight/charts/DataTable";

// The Left Chat Part (interaction-spec section 1), table content type only (epic ruling: the sole LCP
// content type this epic; profile/matches/posting stay P2). It takes the middle of the canvas while the
// chat docks to the 360px right rail; this is the minimal shell - a 48px header (title left, close
// right) matching the rail header, and the full insight table body. Deliberate omissions (land with P2
// content types): deep-link URLs, breadcrumb stack, trigger-toggle close.
export function LcpPanel({ insight, onClose }: { insight: DataInsight; onClose: () => void }) {
  const rows = insight.kind === "table" ? insight.rows : insight.series;
  return (
    <section className="lcp" role="region" aria-label="Full table">
      <div className="lcp-head">
        <span className="lcp-title" title={insight.verdict}>
          {insight.verdict}
        </span>
        <button className="x-btn" type="button" aria-label="Close full table" onClick={onClose}>
          &times;
        </button>
      </div>
      <div className="lcp-body">
        <DataTable rows={rows} />
      </div>
    </section>
  );
}
