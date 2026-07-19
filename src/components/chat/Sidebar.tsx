"use client";

import { useState } from "react";
import { PlusIcon, ChevronLeftIcon } from "@/components/icons";

// The shell sidebar - guest state only (the signed-in history list is a later epic; AC-14: guests
// keep the teaser). Collapse toggles 248px <-> 64px (interaction-spec section 5). Sign-in affordances
// render inert with a subtle "soon" hint until the auth epic wires them.
function BrandCredit() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 8px" }}>
      <div className="sb-brand" style={{ padding: 0 }}>
        jobchat.dev
      </div>
      <div style={{ fontSize: "10.5px", color: "var(--shell-fg-dim)" }}>
        built for <span style={{ color: "var(--clickhouse)", fontWeight: 600 }}>ClickHouse</span>{" "}
        &times; <span style={{ color: "var(--triggerdev)", fontWeight: 600 }}>Trigger.dev</span>
      </div>
    </div>
  );
}

export function Sidebar({ activeTitle }: { activeTitle?: string }) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        <div style={{ fontSize: "15px", fontWeight: 700, color: "var(--shell-strong)" }}>j.</div>
        <button
          className="sb-icon"
          type="button"
          onClick={() => setCollapsed(false)}
          aria-label="Expand sidebar"
        >
          <ChevronLeftIcon />
        </button>
        <div className="sb-icon" style={{ background: "var(--accent)", color: "#fff" }}>
          <PlusIcon size={15} />
        </div>
        <div className="sb-icon" style={{ marginTop: "auto" }}>
          <div className="avatar" style={{ width: 28, height: 28 }}>
            ?
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <BrandCredit />
        <button
          className="sb-icon"
          type="button"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse sidebar"
          style={{
            width: 28,
            height: 28,
            display: "grid",
            placeItems: "center",
            borderRadius: "var(--r-sm)",
            border: 0,
            background: "transparent",
            color: "var(--shell-fg-dim)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <ChevronLeftIcon />
        </button>
      </div>

      <button className="btn btn-primary btn-block" type="button">
        <PlusIcon />
        New chat
      </button>

      <div className="sb-section">History</div>
      <div className="sb-list">
        {activeTitle ? (
          <div className="sb-item active">
            {activeTitle}
            <time>just now</time>
          </div>
        ) : null}
        <div className="sb-teaser">
          Sign in to keep your conversations.
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <button className="btn btn-shell btn-sm" type="button" disabled title="Coming soon">
              Sign in
            </button>
            <span style={{ fontSize: "var(--fs-2xs)", color: "var(--shell-fg-dim)" }}>soon</span>
          </span>
        </div>
      </div>

      <div className="sb-foot">
        <div className="avatar">?</div>
        <div className="sb-who">
          Guest
          <small title="Coming soon">Sign in &middot; soon</small>
        </div>
      </div>
    </aside>
  );
}
