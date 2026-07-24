import type { UIMessage } from "ai";
import {
  DataInsightSchema,
  isErrorKind,
  isRefusalReason,
  PostingsSchema,
  ProfileCardSchema,
  SuggestionsSchema,
  type ChartType,
  type DataInsight,
  type ErrorKind,
  type PostingDetail,
  type RefusalReason,
  type ScoredPostingRow,
  type SuggestionItem,
} from "@shared/insight";
import type { Profile } from "@shared/profile";

// The client-side reading of a chat turn: a freshly streamed card and a resumed (persisted) one funnel
// through one classifier here, so the renderer treats them identically (no drift). Pure (no React).

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
  | { kind: "profile-card"; profile: Profile }
  | { kind: "postings"; rows: ScoredPostingRow[]; total: number }
  | { kind: "auth-invite" }
  | { kind: "profile-invite" }
  | { kind: "suggestions"; items: SuggestionItem[] }
  | { kind: "unknown" };

/** The `data-<kind>` wire type per card kind; one home so resume + live writer tag parts identically. */
const PART_TYPE_BY_KIND: Record<string, string> = {
  insight: "data-insight",
  error: "data-error",
  refusal: "data-refusal",
  "profile-card": "data-profile-card",
  postings: "data-postings",
  "auth-invite": "data-auth-invite",
  "profile-invite": "data-profile-invite",
  suggestions: "data-suggestions",
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** The `data-*` parts of a message, each with a STABLE id (own id or `${message.id}-p${i}`); one home so MessageList + the detail panel target don't drift. */
export function dataParts(message: UIMessage): { id: string; data: unknown }[] {
  return message.parts
    .filter((p) => typeof p.type === "string" && p.type.startsWith("data-"))
    .map((p, i) => ({ id: (p as { id?: string }).id ?? `${message.id}-p${i}`, data: (p as { data?: unknown }).data }));
}

/** The open detail panel is identified by which message's which card it shows (not the payload). */
export interface DetailTarget {
  messageId: string;
  partId: string;
}

/** The single-posting detail's fetch lifecycle (getPostingDetail is async, off the payload). "" description
 *  still renders a valid loaded detail (forward-compat). Held in ChatClient state, not resolved from a card. */
export type PostingDetailState =
  | { status: "loading" }
  | { status: "not-found" }
  | { status: "loaded"; detail: PostingDetail };

export type DetailContent =
  | { kind: "table"; insight: DataInsight }
  | { kind: "profile-card"; profile: Profile }
  | { kind: "postings"; rows: ScoredPostingRow[]; total: number }
  // The on-demand single posting: NOT resolved from a message payload (getPostingDetail feeds it), so
  // resolveDetailContent never yields this - ChatClient builds it from its own fetch state.
  | { kind: "posting"; state: PostingDetailState };

/** Resolve a detail panel target to content: stored by identity, so it re-resolves from the persisted payload (resume renders the same detail panel). */
export function resolveDetailContent(messages: UIMessage[], target: DetailTarget): DetailContent | null {
  const message = messages.find((m) => m.id === target.messageId);
  if (!message) return null;
  const part = dataParts(message).find((p) => p.id === target.partId);
  if (!part) return null;
  const cls = classifyCardData(part.data);
  if (cls.kind === "insight") return { kind: "table", insight: cls.insight };
  if (cls.kind === "profile-card") return { kind: "profile-card", profile: cls.profile };
  if (cls.kind === "postings") return { kind: "postings", rows: cls.rows, total: cls.total };
  return null;
}

/** Classify a card payload (live OR resumed) into a render decision: skeleton first, then a valid insight,
 *  then error/refusal markers; anything else is `unknown` (rendered as nothing) so a shape drift never throws. */
export function classifyCardData(data: unknown): CardClass {
  if (isRecord(data) && data.status === "loading") {
    const chartType = data.kind === "chart" ? (data.chartType as ChartType | undefined) : undefined;
    return { kind: "skeleton", chartType };
  }
  const insight = DataInsightSchema.safeParse(data);
  if (insight.success) return { kind: "insight", insight: insight.data };
  if (isRecord(data)) {
    if (isErrorKind(data.kind)) {
      return { kind: "error", errorKind: data.kind };
    }
    if (isRefusalReason(data.reason)) {
      return { kind: "refusal", reason: data.reason };
    }
    // Each validates strictly - a malformed profile-card/postings payload falls through to `unknown`, never throwing.
    if (data.kind === "profile-card") {
      const pc = ProfileCardSchema.safeParse(data);
      if (pc.success) return { kind: "profile-card", profile: pc.data.profile };
    }
    if (data.kind === "postings") {
      const p = PostingsSchema.safeParse(data);
      if (p.success) return { kind: "postings", rows: p.data.rows, total: p.data.total };
    }
    if (data.kind === "auth-invite") return { kind: "auth-invite" };
    if (data.kind === "profile-invite") return { kind: "profile-invite" };
    if (data.kind === "suggestions") {
      const s = SuggestionsSchema.safeParse(data);
      if (s.success) return { kind: "suggestions", items: s.data.items };
    }
  }
  return { kind: "unknown" };
}

/** True while a turn is in flight (composer disabled, stop shown, skeleton for the pending answer). */
export function isStreaming(status: string): boolean {
  return status === "submitted" || status === "streaming";
}

/** Collapse duplicate message ids: replace in place (latest wins), first-seen order kept, never append a
 *  second copy. reconnectToStream subscribes cursor-less and replays the `.out` tail, re-emitting an
 *  already-hydrated turn under its id (a duplicate React key); reconciling by id renders each turn exactly once. */
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

/** The fit-intent invite kind of a `data-*` part, or null. One home so the dedup pass and the renderer agree. */
function invitePartKind(part: UIMessage["parts"][number]): "auth-invite" | "profile-invite" | null {
  if (typeof part.type !== "string" || !part.type.startsWith("data-")) return null;
  const kind = classifyCardData((part as { data?: unknown }).data).kind;
  return kind === "auth-invite" || kind === "profile-invite" ? kind : null;
}

/** Presentation pass AFTER reconcileMessagesById: the idempotent invite cards are re-emitted from several
 *  uncoordinated sources under DIFFERENT ids (client inject, resume re-stream, .out cursor replay), so an
 *  id-fold can't collapse them. Keep the FIRST card of each invite kind; drop later duplicate invite parts,
 *  and drop an assistant message the drop left with nothing to render. Unchanged messages keep identity (memo-safe). */
export function dedupeInviteCards(messages: UIMessage[]): UIMessage[] {
  const seen = new Set<string>();
  const out: UIMessage[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") {
      out.push(m);
      continue;
    }
    let dropped = false;
    const parts = m.parts.filter((p) => {
      const kind = invitePartKind(p);
      if (kind === null) return true; // not an invite part - untouched
      if (seen.has(kind)) {
        dropped = true;
        return false; // a later duplicate of a kind already shown
      }
      seen.add(kind);
      return true;
    });
    if (!dropped) {
      out.push(m); // identity preserved so the MessageList memo still bails
      continue;
    }
    if (parts.length === 0) continue; // the invite was this message's whole content - drop the empty message
    out.push({ ...m, parts } as UIMessage);
  }
  return out;
}

/** Presentation pass (AFTER reconcileMessagesById): a persisted data card carries a STABLE id, and a
 *  stalled run that reconnects cursor-less replays the `.out` tail - re-emitting an already-hydrated turn's
 *  card under that SAME part id inside a DIFFERENT message, a copy the message-id fold cannot collapse. Keep
 *  the FIRST message's copy of each data-part id, drop a later message's repeat, and drop an assistant
 *  message the drop left with nothing to render. Ids commit per message, so a part id repeated WITHIN one
 *  message (the skeleton->filled reconciliation) is never compared against its own message and always
 *  survives. Distinct cards of the same kind carry different ids and are untouched. Unchanged messages keep
 *  identity (memo-safe). */
export function dedupeDataPartsById(messages: UIMessage[]): UIMessage[] {
  const seen = new Set<string>();
  const out: UIMessage[] = [];
  for (const m of messages) {
    const committed: string[] = [];
    let dropped = false;
    const parts = m.parts.filter((p) => {
      if (typeof p.type !== "string" || !p.type.startsWith("data-")) return true; // not a card part
      const id = (p as { id?: string }).id;
      if (id === undefined) return true; // unkeyed part - cannot dedupe by id
      if (seen.has(id)) {
        dropped = true;
        return false; // a copy an earlier message already showed
      }
      committed.push(id);
      return true;
    });
    // Commit AFTER the filter so a within-message repeat of an id is never dropped as its own duplicate.
    for (const id of committed) seen.add(id);
    if (!dropped) {
      out.push(m); // identity preserved so the MessageList memo still bails
      continue;
    }
    if (parts.length === 0) continue; // the duplicate was this message's whole content - drop the empty message
    out.push({ ...m, parts } as UIMessage);
  }
  return out;
}

export function messageText(message: Pick<UIMessage, "parts">): string {
  const texts = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text);
  // Preserve the boundary between adjacent text parts: a plain `join("")` glued word-to-word ("market.The
  // market..."). Insert a single space only where neither side already carries boundary whitespace.
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

/** Split assistant prose into bold/plain spans: render `**bold**`, strip other inline markers (no markdown library). User text never passes here. */
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

// A resumed store message; structural (not the full `Store.Message`) to keep this module free of the postgres/store import.
export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts: unknown;
}

function payloadList(parts: unknown): unknown[] {
  if (parts == null) return [];
  return Array.isArray(parts) ? parts : [parts];
}

/** Hydrate persisted store messages into `UIMessage[]` (resume): each card becomes a `data-*` part tagged by its kind, so the renderer classifies it exactly as a streamed one. */
export function storeToUiMessages(messages: StoredMessage[]): UIMessage[] {
  return messages.map((m) => {
    const parts: UIMessage["parts"] = [];
    if (m.content.length > 0) parts.push({ type: "text", text: m.content });
    if (m.role === "assistant") {
      payloadList(m.parts).forEach((payload, i) => {
        const cls = classifyCardData(payload);
        // Never resume a stuck skeleton or unknown shape - a resumed turn shows its real card only.
        if (cls.kind === "unknown" || cls.kind === "skeleton") return;
        // Re-tag by the classified kind so a resumed part reads back exactly as the live stream wrote it.
        const type = PART_TYPE_BY_KIND[cls.kind] ?? "data-insight";
        parts.push({ type, id: `${m.id}-card-${i}`, data: payload } as UIMessage["parts"][number]);
      });
    }
    return { id: m.id, role: m.role, parts };
  });
}
