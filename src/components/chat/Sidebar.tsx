"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Conversation } from "@shared/store";
import { PlusIcon, ChevronLeftIcon, KebabIcon } from "@/components/icons";
import { freshnessLabel } from "@/lib/insight-format";
import { isAuthDialogOpen, setMenuOpen } from "@/lib/layers";

// A history row: the stored fields only (title + date - the design contract's whole row, no preview line).
type HistoryItem = Pick<Conversation, "id" | "title" | "created_at">;

// The shell sidebar: guest teaser + Sign in, or the signed-in history list. Identity lives in the title bar, not here.
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

/** A relative "2h ago" label from created_at (reuses the freshness helper). */
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
  onRenameConversation,
}: {
  signedIn?: boolean;
  conversations?: HistoryItem[];
  activeId?: string;
  activeTitle?: string;
  onNewChat?: () => void;
  onSignIn?: () => void;
  /** Delete a signed-in conversation (guarded server-side). Absent (guest) => no affordance. */
  onDeleteConversation?: (conversationId: string) => void;
  /** Rename a signed-in conversation to a new title (guarded server-side). Absent (guest) => no affordance. */
  onRenameConversation?: (conversationId: string, title: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  // Which row shows its inline "Delete this chat?" confirm (never a modal).
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // At most one open kebab menu at a time, and at most one row in inline-rename.
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  // Publish the menu's open state to the layer seam (Esc order: dialog > menu > detail panel), so an Esc
  // that closes the kebab menu doesn't also close the detail panel underneath.
  useEffect(() => {
    setMenuOpen(menuId != null);
    return () => setMenuOpen(false);
  }, [menuId]);

  // Close the open menu on outside-click / Esc (yield Esc while the auth dialog is up); one menu at a time.
  useEffect(() => {
    if (menuId == null) return;
    function onClick(e: MouseEvent) {
      const t = e.target as Element | null;
      if (t?.closest?.(".sb-menu") || t?.closest?.(".sb-kebab")) return;
      setMenuId(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || isAuthDialogOpen()) return;
      setMenuId(null);
    }
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuId]);

  // Enter commits a non-empty (trimmed) rename; the server re-trims/caps. Empty or unchanged just closes.
  function commitRename(id: string, value: string) {
    const t = value.trim();
    setRenamingId(null);
    if (t) onRenameConversation?.(id, t);
  }

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
              renamingId === c.id ? (
                // Inline rename in place: seeded with the current title, Enter saves, Esc / blur cancels.
                <div key={c.id} className="sb-item-row">
                  <input
                    className="sb-rename"
                    aria-label={`Rename ${c.title}`}
                    defaultValue={c.title}
                    // Mirror the server's TitleSchema cap (trigger/session.ts, max 120) so the field can't
                    // silently over-type past what the store would trim anyway.
                    maxLength={120}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={() => setRenamingId(null)}
                    onKeyDown={(e) => {
                      // Keep Enter/Esc local so they never also reach the detail-panel Esc handler.
                      if (e.key === "Enter") {
                        e.stopPropagation();
                        commitRename(c.id, e.currentTarget.value);
                      } else if (e.key === "Escape") {
                        e.stopPropagation();
                        setRenamingId(null);
                      }
                    }}
                  />
                </div>
              ) : confirmingId === c.id ? (
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
                    {/* Single-line title (ellipsis via .sb-title); the active highlight wraps the whole row
                        including the date. Fallback guard: an empty/whitespace title never renders as a bare pill. */}
                    <span className="sb-title">{c.title.trim() || "New chat"}</span>
                    <time>{relativeDate(c.created_at)}</time>
                  </Link>
                  <button
                    type="button"
                    className="sb-kebab"
                    aria-haspopup="menu"
                    aria-expanded={menuId === c.id}
                    // Two conversations can share a title, so a short id suffix keeps each options label's accessible name unique.
                    // Fall back like the visible pill (title.trim() || "New chat") so an empty title never reads "Options for  (id)".
                    aria-label={`Options for ${c.title.trim() || "New chat"} (${c.id.slice(0, 8)})`}
                    onClick={() => setMenuId((m) => (m === c.id ? null : c.id))}
                  >
                    <KebabIcon />
                  </button>
                  {menuId === c.id ? (
                    <div className="sb-menu" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        className="sb-menu-item"
                        onClick={() => {
                          setMenuId(null);
                          setRenamingId(c.id);
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="sb-menu-item danger"
                        onClick={() => {
                          setMenuId(null);
                          setConfirmingId(c.id);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  ) : null}
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
