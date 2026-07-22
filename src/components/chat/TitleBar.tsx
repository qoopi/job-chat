import { AccountMenu } from "./AccountMenu";

// The canvas title bar: the conversation title left ("New chat" when empty), Sign in / account menu right.
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
