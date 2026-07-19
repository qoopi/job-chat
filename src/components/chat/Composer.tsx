import { SendIcon, StopIcon } from "@/components/icons";

// The message composer, all five design states (interaction-spec section 4). Inert in this task -
// send/stop wire live in 006; the focus ring, disabled dimming, and streaming stop are pure CSS/markup.
export type ComposerState = "default" | "focused" | "streaming" | "disabled";

const PLACEHOLDER: Record<ComposerState, string> = {
  default: "Ask a follow-up...",
  focused: "I am looking for...",
  streaming: "Answering...",
  disabled: "Sign in to continue",
};

export function Composer({ state = "default" }: { state?: ComposerState }) {
  const barClass =
    state === "focused" ? "input-bar focused" : state === "disabled" ? "input-bar disabled" : "input-bar";
  const streaming = state === "streaming";
  const inputDisabled = streaming || state === "disabled";

  return (
    <div className="composer">
      <div className={barClass}>
        <textarea rows={1} placeholder={PLACEHOLDER[state]} disabled={inputDisabled} />
        <button className={streaming ? "send stop" : "send"} type="button" aria-label={streaming ? "Stop" : "Send"}>
          {streaming ? <StopIcon /> : <SendIcon />}
        </button>
      </div>
      {streaming ? null : <div className="hint">Enter to send &middot; Shift+Enter for a new line</div>}
    </div>
  );
}
