import { InfoIcon } from "@/components/icons";
import { InlinePromptCard } from "./InlinePromptCard";
import {
  errorCopy,
  refusalCopy,
  type ErrorKind,
  type RefusalReason,
} from "@/lib/insight-format";

// The error card: compact message + Retry (never a stack trace); Retry shows ONLY when onRetry is supplied (the tail card, not a mid-thread one).
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

// The GUEST cap is a warm register card (invites a free account); every other refusal stays the plain grey notice.
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
