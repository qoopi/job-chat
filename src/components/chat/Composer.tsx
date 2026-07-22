"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";
import { SendIcon, StopIcon } from "@/components/icons";

// The message composer (five states): controlled value, Enter-to-send (Shift+Enter newline), streaming send->stop swap.
export type ComposerState =
  "default" | "focused" | "streaming" | "disabled" | "capped";

const PLACEHOLDER: Record<ComposerState, string> = {
  default: "Ask a follow-up...",
  focused: "I am looking for...",
  streaming: "Answering...",
  disabled: "Sign in to continue",
  // At the guest cap the composer stays ENABLED (a send opens the register dialog), so its placeholder invites the account.
  capped: "Create an account to keep asking…",
};

export function Composer({
  state = "default",
  value,
  onChange,
  onSend,
  onStop,
  focusSignal,
}: {
  state?: ComposerState;
  value?: string;
  onChange?: (value: string) => void;
  onSend?: () => void;
  onStop?: () => void;
  /** New chat focuses the composer: bumping this counter moves focus; the first render never steals it (a resumed thread mustn't grab it). */
  focusSignal?: number;
}) {
  const barClass =
    state === "focused"
      ? "input-bar focused"
      : state === "disabled"
        ? "input-bar disabled"
        : "input-bar";
  const streaming = state === "streaming";
  const inputDisabled = streaming || state === "disabled";
  const ref = useRef<HTMLTextAreaElement>(null);
  const firstFocus = useRef(true);

  useEffect(() => {
    if (firstFocus.current) {
      firstFocus.current = false;
      return; // skip the initial mount - only a bumped signal (New chat) moves focus here
    }
    ref.current?.focus();
  }, [focusSignal]);

  // Enter sends, Shift+Enter newline; the plain-Enter default is suppressed so a send leaves no stray line break.
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSend?.();
    }
  }

  return (
    <div className="composer">
      <div className={barClass}>
        <textarea
          ref={ref}
          rows={1}
          aria-label="Ask a follow-up"
          placeholder={PLACEHOLDER[state]}
          disabled={inputDisabled}
          value={value ?? ""}
          onChange={(e) => onChange?.(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          className={streaming ? "send stop" : "send"}
          type="button"
          aria-label={streaming ? "Stop" : "Send"}
          onClick={() => (streaming ? onStop?.() : onSend?.())}
        >
          {streaming ? <StopIcon /> : <SendIcon />}
        </button>
      </div>
      {streaming ? null : (
        <div className="hint">
          Enter to send &middot; Shift+Enter for a new line
        </div>
      )}
    </div>
  );
}
