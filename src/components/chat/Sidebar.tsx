"use client";

import { useState } from "react";
import Link from "next/link";
import type { Conversation } from "@shared/store";
import { PlusIcon, ChevronLeftIcon } from "@/components/icons";
import { freshnessLabel } from "@/lib/insight-format";

// A history row's data: the stored fields plus a first-message preview - optional so a
// caller that has not fetched it (or a guest) simply renders no preview line.
type HistoryItem = Pick<Conversation, "id" | "title" | "created_at"> & {
  preview?: string;
};

// The shell sidebar (interaction-spec s5). Guest: the teaser + Sign in (opens the lazy auth dialog).
// Signed-in: the history list (newest first, title + first-message preview + relative date, active
// highlight, New chat on top, empty state). Identity/auth live in the title bar (AccountMenu), not
// here. Pure presentation - sign-in state + the history list are resolved by the caller.
function BrandCredit() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: "0 8px",
      }}
    >
      {/* The wordmark is a way home - it links to the landing. */}
      <Link
        className="sb-brand"
        href="/"
        style={{ padding: 0, textDecoration: "none" }}
      >
        jobchat.dev
      </Link>
      <div style={{ fontSize: "10.5px", color: "var(--shell-fg-dim)" }}>
        built for{" "}
        <span style={{ color: "var(--clickhouse)", fontWeight: 600 }}>
          ClickHouse
        </span>{" "}
        &times;{" "}
        <span style={{ color: "var(--triggerdev)", fontWeight: 600 }}>
          Trigger.dev
        </span>
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
  conversations = [],
  activeId,
  activeTitle,
  onNewChat,
  onSignIn,
  onDeleteConversation,
}: {
  signedIn?: boolean;
  // Identity moved to the TitleBar (AccountMenu); the sidebar no longer renders a name
  // or avatar.
  conversations?: HistoryItem[];
  activeId?: string;
  activeTitle?: string;
  onNewChat?: () => void;
  onSignIn?: () => void;
  /** Delete a signed-in conversation (guarded server-side). Absent (guest) => no affordance. */
  onDeleteConversation?: (conversationId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  // Which row is showing its inline "Delete this chat?" confirm (never a modal). Local UI state.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  if (collapsed) {
    return (
      <aside className="sidebar collapsed">
        {/* The collapsed wordmark is a way home too. */}
        <Link
          href="/"
          style={{
            fontSize: "15px",
            fontWeight: 700,
            color: "var(--shell-strong)",
            textDecoration: "none",
          }}
        >
          j.
        </Link>
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
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
        }}
      >
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

      {/* New chat on top: always starts a fresh chat IN PLACE (never a bounce to the landing). */}
      <button
        className="btn btn-primary btn-block"
        type="button"
        onClick={() => onNewChat?.()}
      >
        <PlusIcon />
        New chat
      </button>

      <div className="sb-section">History</div>
      {signedIn ? (
        <div className="sb-list">
          {conversations.length === 0 ? (
            <div className="sb-empty">No conversations yet</div>
          ) : (
            conversations.map((c) =>
              confirmingId === c.id ? (
                // Inline confirm (interaction-spec s1 pattern - never a modal).
                <div key={c.id} className="sb-item sb-confirm">
                  <span>Delete this chat?</span>
                  <div className="sb-confirm-actions">
                    <button
                      type="button"
                      className="sb-confirm-yes"
                      onClick={() => {
                        setConfirmingId(null);
                        onDeleteConversation?.(c.id);
                      }}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      className="sb-confirm-no"
                      onClick={() => setConfirmingId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div key={c.id} className="sb-item-row">
                  <Link
                    className={c.id === activeId ? "sb-item active" : "sb-item"}
                    href={`/chat/${c.id}`}
                  >
                    {c.title}
                    {/* A muted first-message preview distinguishes duplicate titles. */}
                    {c.preview ? (
                      <span className="sb-preview">{c.preview}</span>
                    ) : null}
                    <time>{relativeDate(c.created_at)}</time>
                  </Link>
                  <button
                    type="button"
                    className="sb-del"
                    // Two conversations can share a title, which makes a title-only accessible name (and
                    // a getByRole lookup) ambiguous. A short id suffix keeps each delete label unique.
                    aria-label={`Delete ${c.title} (${c.id.slice(0, 8)})`}
                    onClick={() => setConfirmingId(c.id)}
                  >
                    &times;
                  </button>
                </div>
              ),
            )
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
            <button
              className="btn btn-shell btn-sm"
              type="button"
              onClick={() => onSignIn?.()}
            >
              Sign in
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
