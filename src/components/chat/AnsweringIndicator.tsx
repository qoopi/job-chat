// The pending-answer indicator (006 operator ruling: instant send feedback). An animated typing-dots
// bubble that appears the instant a turn is sent and holds through the run-wake gap (~6s) until the
// first real content streams - it replaces the old hollow skeleton card on the streaming path (charts
// mount only when their data-insight part is complete). Shaped from the existing ai bubble tokens
// (.bubble.ai) so it reads as the adviser about to speak; the dots animate via the `answering-bounce`
// keyframe in globals.css (no new deps). `role="status"` announces the wait to assistive tech.
export function AnsweringIndicator() {
  return (
    <div className="msg ai">
      <div className="bubble ai answering" role="status" aria-label="Answering">
        <span className="answering-dot" />
        <span className="answering-dot" />
        <span className="answering-dot" />
      </div>
    </div>
  );
}
