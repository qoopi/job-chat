import { InfoIcon } from "@/components/icons";
import { InlinePromptCard } from "./InlinePromptCard";
import {
  errorCopy,
  refusalCopy,
  type ErrorKind,
  type RefusalReason,
} from "@/lib/insight-format";

// The error card: compact message + Retry (re-runs the same question). Distinct copy for a system
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

// The GUEST cap is a warm register moment, NOT a red error:
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
      <InlinePromptCard
        text="You’ve reached the guest limit — create a free account to keep going and save this conversation."
        buttonLabel="Create account"
        onAction={onSignIn}
      />
    );
  }
  return <div className="notice">{refusalCopy(reason)}</div>;
}
