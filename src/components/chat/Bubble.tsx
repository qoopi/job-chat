"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// A pill message bubble (user right / adviser left). A bubble that wraps past one line trades the pill radius
// for --r-lg; detection is a measured className toggle (catches SOFT wraps), client-only after paint (no SSR effect).
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

  // No deps: re-measure on every RE-RENDER so a growing streaming bubble updates its radius (settled bubbles are memoized upstream); the setState is a no-op when unchanged, so it can't loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 21; // one line-height (fs-base 14px x 1.5)
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const next = el.scrollHeight - padTop - padBottom > line * 1.5; // taller than ~1.5 line-heights => wrapped
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
