// The ONE inline nudge card (accent-soft prompt + one button): unifies the guest-cap moment and the two fit-intent invites (shared .register-card anatomy).
export function InlinePromptCard({
  text,
  buttonLabel,
  onAction,
}: {
  text: string;
  buttonLabel: string;
  onAction?: () => void;
}) {
  return (
    <div className="register-card">
      <p>{text}</p>
      <button className="btn btn-primary btn-sm" type="button" onClick={onAction}>
        {buttonLabel}
      </button>
    </div>
  );
}
