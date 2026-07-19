import type { ThreadItem } from "@/lib/fixtures/conversation";
import { Bubble } from "./Bubble";
import { InsightCard } from "@/components/insight/InsightCard";
import { ErrorCard, RefusalNotice } from "@/components/insight/ErrorCard";

// Renders a conversation's thread: user/adviser bubbles, insight cards (bare in .msg.ai), and the
// error / refusal states. Data comes from a fixture in 005; 006 feeds the live message store.
export function Thread({ items }: { items: ThreadItem[] }) {
  return (
    <div className="thread">
      {items.map((item, i) => {
        if (item.role === "user") {
          return (
            <Bubble key={i} role="user" time={item.time}>
              {item.text}
            </Bubble>
          );
        }
        if ("insight" in item) {
          return (
            <div key={i} className="msg ai">
              <InsightCard insight={item.insight} usedFollowups={item.used} />
              {item.time ? <time>{item.time}</time> : null}
            </div>
          );
        }
        if ("error" in item) {
          return (
            <div key={i} className="msg ai">
              <ErrorCard kind={item.error} />
            </div>
          );
        }
        if ("refusal" in item) {
          return (
            <div key={i} className="msg ai">
              <RefusalNotice reason={item.refusal} />
            </div>
          );
        }
        return (
          <Bubble key={i} role="ai" time={item.time}>
            {item.text}
          </Bubble>
        );
      })}
    </div>
  );
}
