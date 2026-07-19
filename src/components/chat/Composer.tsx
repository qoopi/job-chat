"use client";

import { useRef, type KeyboardEvent } from "react";
import { SendIcon, StopIcon } from "@/components/icons";

// The message composer, all five design states (interaction-spec section 4). 005 shipped the markup;
// 006 wires behavior via optional callbacks - controlled value, Enter-to-send (Shift+Enter newline),
// and the streaming send->stop swap. With no handlers passed it stays inert (the 005 contract), so the
// focus ring / disabled dimming / stop glyph remain pure CSS.
export type ComposerState = "default" | "focused" | "streaming" | "disabled";

const PLACEHOLDER: Record<ComposerState, string> = {
  default: "Ask a follow-up...",
  focused: "I am looking for...",
  streaming: "Answering...",
  disabled: "Sign in to continue",
};

export function Composer({
  state = "default",
  value,
  onChange,
  onSend,
  onStop,
}: {
  state?: ComposerState;
  value?: string;
  onChange?: (value: string) => void;
  onSend?: () => void;
  onStop?: () => void;
}) {
  const barClass =
    state === "focused" ? "input-bar focused" : state === "disabled" ? "input-bar disabled" : "input-bar";
  const streaming = state === "streaming";
  const inputDisabled = streaming || state === "disabled";
  const ref = useRef<HTMLTextAreaElement>(null);

  // Enter sends, Shift+Enter inserts a newline (interaction-spec section 4). The default textarea
  // newline on plain Enter is suppressed so a send never leaves a stray line break behind.
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
      {streaming ? null : <div className="hint">Enter to send &middot; Shift+Enter for a new line</div>}
    </div>
  );
}
