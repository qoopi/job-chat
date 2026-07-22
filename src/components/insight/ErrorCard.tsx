import { InfoIcon } from "@/components/icons";
import {
  errorCopy,
  refusalCopy,
  type ErrorKind,
  type RefusalReason,
} from "@/lib/insight-format";

// AC-10 error card: compact message + Retry (re-runs the same question). Distinct copy for a system
// failure vs an unanswerable question; never a stack trace. Retry is shown ONLY when an onRetry handler
// is supplied - a mid-thread error card gets none (regenerate re-answers the tail, not this turn).
export function ErrorCard({
  kind,
  onRetry,
}: {
  kind: ErrorKind;
  onRetry?: () => void;
}) {
  return (
    <div className="err-card">
      <InfoIcon />
      {errorCopy(kind)}
      {onRetry ? (
        <button className="btn btn-outline btn-sm" type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
    </div>
  );
}

// AC-13/AC-15/AC-20 refusal. The GUEST cap (refresh #2 s8) is a warm register moment, NOT a red error:
// an accent-soft in-thread card inviting a free account (which also saves the conversation), with a
// primary "Create account" that opens the lazy dialog (`onSignIn`). Every other refusal - a signed-in
// cap with no sign-in remedy, the daily budget, an over-length turn - stays the plain grey notice.
export function RefusalNotice({
  reason,
  onSignIn,
}: {
  reason: RefusalReason;
  onSignIn?: () => void;
}) {
  if (onSignIn && reason === "guest_cap") {
    return (
      <div className="register-card">
        <p>
          You&rsquo;ve reached the guest limit &mdash; create a free account to
          keep going and save this conversation.
        </p>
        <button
          className="btn btn-primary btn-sm"
          type="button"
          onClick={onSignIn}
        >
          Create account
        </button>
      </div>
    );
  }
  return <div className="notice">{refusalCopy(reason)}</div>;
}
