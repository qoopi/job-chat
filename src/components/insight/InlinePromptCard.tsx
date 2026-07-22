// The ONE inline nudge card: an accent-soft prompt (accent-line border, --r-lg) with one line of copy
// and one primary button. It unifies the guest-cap "register" moment (ErrorCard's RefusalNotice) and
// the two fit-intent invites (auth-invite / profile-invite) - identical anatomy, only the text +
// button label + action differ (implement-cards.md #4; cards-handoff decision 7). The `.register-card`
// class is the shared anatomy, so the cap card stays pixel-identical after the refactor.
export function InlinePromptCard({
  text,
  buttonLabel,
  onAction,
}: {
  text: string;
  buttonLabel: string;
  /** The single action - opens the auth dialog (cap / auth-invite) or the profile form (profile-invite). */
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
