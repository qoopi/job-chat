import { AccountMenu } from "./AccountMenu";

// The canvas title bar (48px). Left: the conversation title; "New chat" muted when empty.
// Right: a guest sees an obvious "Sign in" button; a
// signed-in user sees the account chip + menu (profile, dark mode, sign out). The title keeps the
// `title-bar` test id so its text is asserted independently of the new right slot.
export function TitleBar({
  title,
  signedIn = false,
  accountName,
  email,
  onSignIn,
  onOpenProfile,
  onSignOut,
}: {
  title?: string;
  signedIn?: boolean;
  accountName?: string;
  email?: string;
  onSignIn?: () => void;
  onOpenProfile?: () => void;
  onSignOut?: () => void;
}) {
  const empty = !title || title.trim().length === 0;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--sp-4)",
        height: 48,
        padding: "0 16px 0 24px",
        borderBottom: "1px solid var(--border)",
        flexShrink: 0,
      }}
    >
      <span
        data-testid="title-bar"
        style={{
          fontSize: "var(--fs-sm)",
          fontWeight: 600,
          color: empty ? "var(--text-3)" : undefined,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {empty ? "New chat" : title}
      </span>
      {signedIn ? (
        <AccountMenu
          accountName={accountName}
          email={email}
          onOpenProfile={() => onOpenProfile?.()}
          onSignOut={() => onSignOut?.()}
        />
      ) : (
        <button
          className="btn btn-outline btn-sm"
          type="button"
          onClick={() => onSignIn?.()}
        >
          Sign in
        </button>
      )}
    </div>
  );
}
