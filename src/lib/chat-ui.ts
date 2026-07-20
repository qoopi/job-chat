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
 * The `data-*` parts of a message, each with a STABLE id: the part's own id, or `${message.id}-p${i}`.
 * MessageList keys its cards on this id and the LCP target references it (AC-8), so both must derive it
 * the same way - one home here keeps them from drifting.
 */
export function dataParts(message: UIMessage): { id: string; data: unknown }[] {
  return message.parts
    .filter((p) => typeof p.type === "string" && p.type.startsWith("data-"))
    .map((p, i) => ({ id: (p as { id?: string }).id ?? `${message.id}-p${i}`, data: (p as { data?: unknown }).data }));
}

/** The open LCP is identified by which message's which card it shows (epic-pinned; not the payload). */
export interface LcpTarget {
  messageId: string;
  partId: string;
}

/**
 * Resolve an LCP target back to its insight from the current messages (AC-8). The panel body is stored
 * by identity, not value, so it re-resolves from the immutable persisted payload - a resumed
 * conversation renders the same LCP. Null when the message/part is gone or is not an insight.
 */
export function resolveInsightTarget(messages: UIMessage[], target: LcpTarget): DataInsight | null {
  const message = messages.find((m) => m.id === target.messageId);
  if (!message) return null;
  const part = dataParts(message).find((p) => p.id === target.partId);
  if (!part) return null;
  const cls = classifyCardData(part.data);
  return cls.kind === "insight" ? cls.insight : null;
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
    if (data.reason === "guest_cap" || data.reason === "daily_budget" || data.reason === "too_long") {
      return { kind: "refusal", reason: data.reason };
    }
  }
  return { kind: "unknown" };
}

/** True while a turn is in flight (composer disabled, stop shown, skeleton for the pending answer). */
export function isStreaming(status: string): boolean {
  return status === "submitted" || status === "streaming";
}

/**
 * Collapse duplicate message ids into a single entry, keeping first-seen order and replacing in place
 * with the latest occurrence (never appending a second copy).
 *
 * The merge seam: an existing conversation is hydrated into `useChat` from the store
 * (`storeToUiMessages` -> `initialMessages`). On a follow-up, `ChatClient` appends the user turn and
 * calls `resumeStream()`; the SDK's `reconnectToStream` subscribes with no `lastEventId` cursor, so the
 * server replays the session's `.out` tail from the start - re-emitting the ALREADY-HYDRATED assistant
 * turn under its original id. The AI SDK's write then `pushMessage`s that replayed turn (its id != the
 * just-appended user turn's id, so it is not treated as a continuation), landing a turn that is already
 * in the list a SECOND time under the same id. That is the operator's "two children with the same key"
 * at `MessageList` (`AssistantMessage key={m.id}`) and the old card visibly re-appearing.
 *
 * Reconciling by id here - replace, never append, order preserved - renders each turn exactly once
 * without suffixing keys (suffixing would key the duplicate uniquely and render the card twice).
 */
export function reconcileMessagesById(messages: UIMessage[]): UIMessage[] {
  const indexById = new Map<string, number>();
  const out: UIMessage[] = [];
  for (const m of messages) {
    const at = indexById.get(m.id);
    if (at === undefined) {
      indexById.set(m.id, out.length);
      out.push(m);
    } else {
      out[at] = m; // replace in place: latest content wins, original position kept
    }
  }
  return out;
}

/** The concatenated text of a message's text parts (a plain answer or the one-line verdict prose). */
export function messageText(message: Pick<UIMessage, "parts">): string {
  const texts = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text);
  // Preserve the boundary between adjacent text parts. The stream and the store both split prose into
  // separate text parts (a data part or a step boundary ends one and starts the next); a plain `join("")`
  // glued the last word of one part to the first of the next ("...market.The market..."). Insert a single
  // space only where neither side already carries boundary whitespace, so existing spacing is never doubled.
  let out = "";
  for (const t of texts) {
    if (out.length > 0 && !/\s$/.test(out) && !/^\s/.test(t)) out += " ";
    out += t;
  }
  return out.trim();
}

export interface ProseSpan {
  text: string;
  bold: boolean;
}

/**
 * Split assistant prose into bold / plain spans for the ai bubble. The agent's answers arrive as light
 * markdown; render `**bold**` as a real bold span and strip the remaining inline markers (`code`,
 * *emph*, ATX headings) to plain text - no markdown library, the surface is one bubble of short prose.
 * User text is never passed through here (their question renders verbatim). Pure, so it is unit-tested.
 */
export function proseSpans(text: string): ProseSpan[] {
  const spans: ProseSpan[] = [];
  const bold = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = bold.exec(text)) !== null) {
    if (m.index > last) spans.push({ text: stripInlineMarkers(text.slice(last, m.index)), bold: false });
    spans.push({ text: stripInlineMarkers(m[1]), bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) spans.push({ text: stripInlineMarkers(text.slice(last)), bold: false });
  return spans.filter((s) => s.text.length > 0);
}

function stripInlineMarkers(s: string): string {
  return s
    .replace(/`([^`]*)`/g, "$1") // inline `code` -> plain
    .replace(/^\s*#{1,6}\s+/gm, "") // ATX heading markers -> plain
    .replace(/\*([^*]+)\*/g, "$1") // leftover *emph* -> plain
    .replace(/\*\*/g, ""); // any unmatched bold marker
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
