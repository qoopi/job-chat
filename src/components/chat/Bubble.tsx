"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// A pill message bubble: user (accent-tinted, right) or adviser (neutral, left). The timestamp
// reveals on .msg:hover (components.css). Insight cards render bare in .msg.ai, not in a bubble.
//
// AC-17 polish: a bubble whose content wraps past one line trades the pill radius (--r-pill) for the
// gentler --r-lg (a stadium radius looks wrong on a tall multi-line bubble). Detection is a measured
// className toggle so it catches SOFT wraps (long text), not just hard line breaks; the radius swap
// itself is pure CSS (.bubble.wrapped). Runs on the client only, after paint - no SSR/hydration effect.
export function Bubble({
  role,
  time,
  children,
}: {
  role: "user" | "ai";
  time?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [wrapped, setWrapped] = useState(false);

  // No deps: re-measure on every render so a STREAMING bubble that grows past one line updates. The
  // setState is guarded to a no-op when unchanged, so it cannot loop - eslint's infinite-chain
  // heuristic is a false positive here (same disable pattern as ChatClient's mount effect).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 21; // one line-height (fs-base 14px x 1.5)
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    // Content is taller than ~1.5 line-heights => it wrapped past a single line.
    const next = el.scrollHeight - padTop - padBottom > line * 1.5;
    setWrapped((prev) => (prev === next ? prev : next));
  });

  return (
    <div className={`msg ${role}`}>
      <div ref={ref} className={`bubble ${role}${wrapped ? " wrapped" : ""}`}>
        {children}
      </div>
      {time ? <time>{time}</time> : null}
    </div>
  );
}
