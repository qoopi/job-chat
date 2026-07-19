// The streaming state (AC-8): verdict shimmers and the chart block draws as data arrives - never a
// spinner-only state. Same structure as the filled card so it reconciles in place. Built here for 006.
export function InsightCardSkeleton() {
  return (
    <div className="insight">
      <div className="insight-head" style={{ paddingBottom: 4 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
          <div className="skeleton" style={{ height: 15, width: "72%" }} />
          <div className="skeleton" style={{ height: 15, width: "38%" }} />
        </div>
        <div className="tabs">
          <button className="tab active" type="button">
            Chart
          </button>
          <button className="tab" type="button">
            Table
          </button>
        </div>
      </div>
      <div className="insight-body">
        <div className="skeleton" style={{ height: 140, borderRadius: 10 }} />
      </div>
      <div className="insight-foot">
        <div className="followups">
          <div className="skeleton" style={{ height: 32, width: 120, borderRadius: 999 }} />
          <div className="skeleton" style={{ height: 32, width: 90, borderRadius: 999 }} />
        </div>
      </div>
    </div>
  );
}
