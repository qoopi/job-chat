import type { UIMessage } from "ai";
import {
  AuthInviteSchema,
  DataInsightSchema,
  PostingsSchema,
  ProfileCardSchema,
  ProfileInviteSchema,
} from "@shared/insight";
import type { Store, MessageRole } from "@shared/store";
import { MAX_INPUT_CHARS } from "./guard";

type MessagePartLike = { type: string; text?: string; id?: string; data?: unknown };
type MessageLike = { id?: string; parts?: MessagePartLike[] };

// A persistable payload is a strict-valid insight/error/refusal marker; a loading skeleton is dropped so a failed/refused turn never resumes as a stuck spinner.
function isPersistablePayload(data: unknown): boolean {
  if (DataInsightSchema.safeParse(data).success) return true;
  if (ProfileCardSchema.safeParse(data).success) return true; // out-of-band profile card
  if (PostingsSchema.safeParse(data).success) return true;
  if (AuthInviteSchema.safeParse(data).success) return true;
  if (ProfileInviteSchema.safeParse(data).success) return true;
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  if (d.kind === "system" || d.kind === "unanswerable") return true; // error marker
  if (d.reason === "guest_cap" || d.reason === "daily_budget" || d.reason === "too_long") return true; // refusal marker
  return false;
}

/** Extract content + card payload from a turn's response. Card parts de-duped by id (last write wins), so a
 *  skeleton is superseded or dropped; a failed turn resumes as its error/refusal card, never a spinner. */
export function extractAssistantPersistence(message: MessageLike): {
  content: string;
  parts: unknown;
} {
  const parts = message.parts ?? [];
  // Persist the model's prose VERBATIM; render suppression + the model-facing verdict happen elsewhere, so Postgres stays faithful.
  const content = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();

  const byId = new Map<string, unknown>();
  let anon = 0;
  for (const p of parts) {
    if (
      p.type === "data-insight" ||
      p.type === "data-error" ||
      p.type === "data-refusal" ||
      p.type === "data-profile-card" ||
      p.type === "data-postings" ||
      p.type === "data-auth-invite" ||
      p.type === "data-profile-invite"
    ) {
      byId.set(p.id ?? `#${anon++}`, p.data);
    }
  }
  const payloads = [...byId.values()].filter(isPersistablePayload);
  const payload = payloads.length === 0 ? null : payloads.length === 1 ? payloads[0] : payloads;
  return { content, parts: payload };
}

/** Card synthesized for an errored turn with no card, so a failed turn persists and resumes with Retry. */
const SYSTEM_ERROR_CARD = { kind: "system" } as const;

/** Persist the assistant turn (normal, stopped, OR errored). Errors are turns (the SDK fires with `error` set);
 *  keyed by responseMessage.id (idempotent upsert), a synthesized error card takes a fresh uuid. */
export async function persistAssistantTurn(
  store: Store,
  args: { conversationId: string; responseMessage?: MessageLike; error?: unknown },
): Promise<void> {
  const { conversationId, responseMessage, error } = args;
  const failed = error !== undefined;

  if (!responseMessage) {
    if (!failed) return; // no response and no error: nothing to persist
    await store.appendMessage(conversationId, "assistant", "", SYSTEM_ERROR_CARD, crypto.randomUUID());
    return;
  }

  const { content, parts } = extractAssistantPersistence(responseMessage);
  // A partial errored turn with no card still persists the error card (resume with Retry); a real answer card is kept.
  const payload = failed && parts === null ? SYSTEM_ERROR_CARD : parts;
  await store.appendMessage(conversationId, "assistant", content, payload, responseMessage.id);
}

/** Read a model message's user text (content is a string or an array of text parts). */
function userMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (p): p is { type: string; text?: unknown } =>
        typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text",
    )
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join("");
}

export type RunMessage = { role: string; content?: unknown };

/** Persist newly-arrived user turn(s) BEFORE the guard counts them - run() is the single persist site (the SDK
 *  4.5.4 sendMessages path streams the new turn live). Count-based: no-op on turn-1/regenerate, idempotent on retry.
 *  Over-length backstop: a too-long new turn is refused HERE ("too_long", persists NOTHING) via the same MAX_INPUT_CHARS. */
export async function persistIncomingUserTurns(
  store: Store,
  chatId: string,
  messages: RunMessage[],
): Promise<"too_long" | null> {
  const incoming = messages.filter((m) => m.role === "user").map((m) => userMessageText(m.content));
  const loaded = await store.getConversation(chatId);
  const persistedUserCount = loaded ? loaded.messages.filter((m) => m.role === "user").length : 0;
  const newTurns = incoming.slice(persistedUserCount);
  if (newTurns.some((text) => text.trim().length > MAX_INPUT_CHARS)) return "too_long";
  for (const text of newTurns) {
    if (text.trim().length === 0) continue;
    await store.appendMessage(chatId, "user", text, null);
  }
  return null;
}

/** History the SDK's hydrateMessages seam returns (snapshot machinery OFF, Postgres sole store). Deliberately
 *  RAW - id preserved, content verbatim, NO coalescing - so the user COUNT stays identical (no coalesce drift). */
export function hydrateHistory(
  persisted: readonly { id: string; role: MessageRole; content: string }[],
  incoming: readonly UIMessage[],
): UIMessage[] {
  const rows: UIMessage[] = persisted.map((m) => ({
    id: m.id,
    role: m.role,
    parts: [{ type: "text", text: m.content }],
  }));
  const stored = new Set(persisted.map((m) => m.id));
  return [...rows, ...incoming.filter((m) => !stored.has(m.id))];
}
