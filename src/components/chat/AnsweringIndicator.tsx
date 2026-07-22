// The pending-answer indicator: a typing-dots bubble through the run-wake gap; role="status" announces the wait to assistive tech.
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
