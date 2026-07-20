"use client";

import { useState } from "react";
import Link from "next/link";
import type { Conversation } from "@shared/store";
import { PlusIcon, ChevronLeftIcon } from "@/components/icons";
import { freshnessLabel } from "@/lib/insight-format";

// The shell sidebar (interaction-spec s5). Guest: the teaser + Sign in (opens the lazy auth dialog).
// Signed-in: the real history list (newest first, title + relative date, active highlight, click loads,
// New chat on top, "No conversations yet" empty state). Pure presentation - sign-in state + the history
// list are resolved by the caller (SSR seed + client refetch after an in-page sign-in). Collapse + the
// built-for credit are P1 surfaces, untouched.
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

/** A relative "2h ago" / "just now" label from a conversation's created_at (reuses the freshness helper;
 *  no new dependency). */
function relativeDate(createdAt: Date): string {
  return freshnessLabel(new Date(createdAt).toISOString()) || "just now";
}

export function Sidebar({
  signedIn = false,
  accountName,
  conversations = [],
  activeId,
  activeTitle,
  onNewChat,
  onSignIn,
  onSignOut,
}: {
  signedIn?: boolean;
  accountName?: string;
  conversations?: Pick<Conversation, "id" | "title" | "created_at">[];
  activeId?: string;
  activeTitle?: string;
  onNewChat?: () => void;
  onSignIn?: () => void;
  onSignOut?: () => void;
}) {
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
        <button
          className="sb-icon"
          type="button"
          onClick={() => onNewChat?.()}
          aria-label="New chat"
          style={{ background: "var(--accent)", color: "#fff", border: 0 }}
        >
          <PlusIcon size={15} />
        </button>
        <div className="sb-icon" style={{ marginTop: "auto" }}>
          <div className="avatar" style={{ width: 28, height: 28 }}>
            {signedIn ? (accountName?.[0]?.toUpperCase() ?? "A") : "?"}
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

      {/* New chat on top. Guest keeps the P1 button (closes the LCP); signed-in starts a fresh chat. */}
      {signedIn ? (
        <Link className="btn btn-primary btn-block" href="/">
          <PlusIcon />
          New chat
        </Link>
      ) : (
        <button className="btn btn-primary btn-block" type="button" onClick={() => onNewChat?.()}>
          <PlusIcon />
          New chat
        </button>
      )}

      <div className="sb-section">History</div>
      {signedIn ? (
        <div className="sb-list">
          {conversations.length === 0 ? (
            <div className="sb-empty">No conversations yet</div>
          ) : (
            conversations.map((c) => (
              <Link
                key={c.id}
                className={c.id === activeId ? "sb-item active" : "sb-item"}
                href={`/chat/${c.id}`}
              >
                {c.title}
                <time>{relativeDate(c.created_at)}</time>
              </Link>
            ))
          )}
        </div>
      ) : (
        <div className="sb-list">
          {activeTitle ? (
            <div className="sb-item active">
              {activeTitle}
              <time>just now</time>
            </div>
          ) : null}
          <div className="sb-teaser">
            Sign in to keep your conversations.
            <button className="btn btn-shell btn-sm" type="button" onClick={() => onSignIn?.()}>
              Sign in
            </button>
          </div>
        </div>
      )}

      <div className="sb-foot">
        {signedIn ? (
          <>
            <div className="avatar">{accountName?.[0]?.toUpperCase() ?? "A"}</div>
            <div className="sb-who">
              {accountName ?? "Account"}
              <button
                type="button"
                onClick={() => onSignOut?.()}
                style={{
                  display: "block",
                  padding: 0,
                  border: 0,
                  background: "none",
                  font: "inherit",
                  fontSize: "var(--fs-2xs)",
                  color: "var(--shell-fg-dim)",
                  cursor: "pointer",
                }}
              >
                Sign out
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="avatar">?</div>
            <div className="sb-who">
              Guest
              <button
                type="button"
                onClick={() => onSignIn?.()}
                style={{
                  display: "block",
                  padding: 0,
                  border: 0,
                  background: "none",
                  font: "inherit",
                  fontSize: "var(--fs-2xs)",
                  color: "var(--shell-fg-dim)",
                  cursor: "pointer",
                }}
              >
                Sign in
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
