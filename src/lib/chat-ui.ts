import type { UIMessage } from "ai";
import { DataInsightSchema, type ChartType, type DataInsight } from "@shared/insight";
import type { ErrorKind, RefusalReason } from "@/lib/insight-format";

// The client-side reading of a chat turn. `useChat` (via the Trigger transport) exposes messages as
// `UIMessage[]` whose `parts` mix text with `data-*` parts; the store persists the same card payloads
// as opaque JSON. Both funnel through here so the renderer (MessageList) treats a freshly streamed
// card and a resumed one identically - one classifier, no drift. Pure (no React), so it is unit-tested
// in isolation.

/** A streaming skeleton part - the loading shape the agent writes before the tool returns. */
export interface SkeletonCard {
  kind: "skeleton";
  chartType?: ChartType;
}

/** The classification of a single `data-*` part's payload into what the UI should render. */
export type CardClass =
  | { kind: "insight"; insight: DataInsight }
  | SkeletonCard
  | { kind: "error"; errorKind: ErrorKind }
  | { kind: "refusal"; reason: RefusalReason }
  | { kind: "unknown" };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Classify a card payload (from a live `data-insight`/`data-error`/`data-refusal` part OR a resumed
 * store payload) into a render decision. The loading skeleton is detected first (its `status:"loading"`
 * fails the strict insight schema); then a valid insight; then the error / refusal markers. Anything
 * else is `unknown` (rendered as nothing) so a shape drift never throws in the render tree.
 */
export function classifyCardData(data: unknown): CardClass {
  if (isRecord(data) && data.status === "loading") {
    const chartType = data.kind === "chart" ? (data.chartType as ChartType | undefined) : undefined;
    return { kind: "skeleton", chartType };
  }
  const insight = DataInsightSchema.safeParse(data);
  if (insight.success) return { kind: "insight", insight: insight.data };
  if (isRecord(data)) {
    if (data.kind === "system" || data.kind === "unanswerable") {
      return { kind: "error", errorKind: data.kind };
    }
    if (data.reason === "guest_cap" || data.reason === "daily_budget") {
      return { kind: "refusal", reason: data.reason };
    }
  }
  return { kind: "unknown" };
}

/** True while a turn is in flight (composer disabled, stop shown, skeleton for the pending answer). */
export function isStreaming(status: string): boolean {
  return status === "submitted" || status === "streaming";
}

/** The concatenated text of a message's text parts (a plain answer or the one-line verdict prose). */
export function messageText(message: Pick<UIMessage, "parts">): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("")
    .trim();
}

// A resumed store message (AC-13). Structural, not the full `Store.Message` (which carries a Date and
// conversation_id the renderer never reads) - keeps this module free of the postgres/store import.
export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: unknown;
}

/** One store payload can hold a single card or an array of them; normalize to a list. */
function payloadList(parts: unknown): unknown[] {
  if (parts == null) return [];
  return Array.isArray(parts) ? parts : [parts];
}

/**
 * Hydrate persisted store messages into `UIMessage[]` for `useChat`'s initial state (AC-13 resume).
 * A user message becomes one text part; an assistant message becomes its prose text (if any) plus one
 * `data-*` part per persisted card payload, tagged by the payload's kind so the renderer classifies it
 * exactly as it would a freshly streamed part. Cards keep a stable per-message part id so tab / chip
 * state survives re-render.
 */
export function storeToUiMessages(messages: StoredMessage[]): UIMessage[] {
  return messages.map((m) => {
    const parts: UIMessage["parts"] = [];
    if (m.content.length > 0) parts.push({ type: "text", text: m.content });
    if (m.role === "assistant") {
      payloadList(m.parts).forEach((payload, i) => {
        const cls = classifyCardData(payload);
        // Never resume a stuck skeleton: a persisted loading payload (defensive - the agent already
        // drops these) or an unrecognized shape is skipped so a resumed turn shows its real card only.
        if (cls.kind === "unknown" || cls.kind === "skeleton") return;
        const type =
          cls.kind === "error" ? "data-error" : cls.kind === "refusal" ? "data-refusal" : "data-insight";
        parts.push({ type, id: `${m.id}-card-${i}`, data: payload } as UIMessage["parts"][number]);
      });
    }
    return { id: m.id, role: m.role, parts };
  });
}
