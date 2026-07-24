// The pending-answer indicator: a typing-dots bubble through the run-wake gap; role="status" announces the
// wait to assistive tech. An optional label renders as a leading line (a narrated wait - parsing a profile,
// looking for fitting postings) and becomes the accessible name; without it the plain dots read as "Answering".
export function AnsweringIndicator({ label }: { label?: string }) {
  return (
    <div className="msg ai">
      <div className="bubble ai answering" role="status" aria-label={label ?? "Answering"}>
        {label ? <span className="answering-label">{label}</span> : null}
        <span className="answering-dot" />
        <span className="answering-dot" />
        <span className="answering-dot" />
      </div>
    </div>
  );
}
