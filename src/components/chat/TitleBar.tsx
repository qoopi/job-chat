// The canvas title bar (48px). Shows the conversation title; "New chat" muted when empty (AC-14).
export function TitleBar({ title }: { title?: string }) {
  const empty = !title || title.trim().length === 0;
  return (
    <div
      data-testid="title-bar"
      style={{
        display: "flex",
        alignItems: "center",
        height: 48,
        padding: "0 24px",
        borderBottom: "1px solid var(--border)",
        fontSize: "var(--fs-sm)",
        fontWeight: 600,
        color: empty ? "var(--text-3)" : undefined,
        flexShrink: 0,
      }}
    >
      {empty ? "New chat" : title}
    </div>
  );
}
