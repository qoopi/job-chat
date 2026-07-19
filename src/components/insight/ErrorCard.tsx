import { InfoIcon } from "@/components/icons";
import { errorCopy, refusalCopy, type ErrorKind, type RefusalReason } from "@/lib/insight-format";

// AC-10 error card: compact message + Retry (re-runs the same question). Distinct copy for a system
// failure vs an unanswerable question; never a stack trace. Retry is inert here - 006 wires it.
export function ErrorCard({ kind, onRetry }: { kind: ErrorKind; onRetry?: () => void }) {
  return (
    <div className="err-card">
      <InfoIcon />
      {errorCopy(kind)}
      <button className="btn btn-outline btn-sm" type="button" onClick={() => onRetry?.()}>
        Retry
      </button>
    </div>
  );
}

// AC-15/AC-20 refusal: a polite limit notice (not an error card) shown until the auth dialog exists.
export function RefusalNotice({ reason }: { reason: RefusalReason }) {
  return <div className="notice">{refusalCopy(reason)}</div>;
}
