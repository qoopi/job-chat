import type { ReactNode } from "react";

// A pill message bubble: user (accent-tinted, right) or adviser (neutral, left). The timestamp
// reveals on .msg:hover (components.css). Insight cards render bare in .msg.ai, not in a bubble.
export function Bubble({
  role,
  time,
  children,
}: {
  role: "user" | "ai";
  time?: string;
  children: ReactNode;
}) {
  return (
    <div className={`msg ${role}`}>
      <div className={`bubble ${role}`}>{children}</div>
      {time ? <time>{time}</time> : null}
    </div>
  );
}
