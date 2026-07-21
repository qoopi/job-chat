import { DataInsightSchema } from "@shared/insight";
import type { Store } from "@shared/store";
import { MAX_INPUT_CHARS } from "./guard";

// The chat store's persistence seam: turning a completed turn's response message into the durable
// assistant row and persisting the newly-arrived user turn(s) before the guard counts them. Split out
// of trigger/parts.ts (the part vocabulary) so persistence has one home, separate from the mappings and
// the history rebuild. Pure over an injected Store - unit-testable without Trigger or Bedrock.

type MessagePartLike = { type: string; text?: string; id?: string; data?: unknown };
type MessageLike = { id?: string; parts?: MessagePartLike[] };

// A persisted card payload is a strict-valid insight, an error marker, or a refusal marker - anything
// else (notably a loading skeleton, whose `status:"loading"` fails every branch) is dropped so a
// failed/refused turn never resumes as a stuck spinner.
function isPersistablePayload(data: unknown): boolean {
  if (DataInsightSchema.safeParse(data).success) return true;
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  if (d.kind === "system" || d.kind === "unanswerable") return true; // error marker
  if (d.reason === "guest_cap" || d.reason === "daily_budget" || d.reason === "too_long") return true; // refusal marker
  return false;
}

/**
 * Extract the persisted assistant content + card payload from a completed turn's response message.
 * Text parts are joined; the card parts (`data-insight`, `data-error`, `data-refusal`) are de-duped
 * by id - last write wins, so a skeleton is superseded by its filled insight (success) or by the
 * error/refusal emitted under the same id (failure). Loading skeletons that were never superseded are
 * then dropped (they fail `isPersistablePayload`), so a failed or refused turn resumes as its error /
 * refusal card, never a stuck skeleton. Payload: a single object for the usual one-card answer, an
 * array if several, `null` for a plain text-only answer. AC-13 resume source.
 */
export function extractAssistantPersistence(message: MessageLike): {
  content: string;
  parts: unknown;
} {
  const parts = message.parts ?? [];
  const content = parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();

  const byId = new Map<string, unknown>();
  let anon = 0;
  for (const p of parts) {
    if (p.type === "data-insight" || p.type === "data-error" || p.type === "data-refusal") {
      byId.set(p.id ?? `#${anon++}`, p.data);
    }
  }
  const payloads = [...byId.values()].filter(isPersistablePayload);
  const payload = payloads.length === 0 ? null : payloads.length === 1 ? payloads[0] : payloads;
  // 018 strand 2 (extends AC-25's single-surface rule to SUCCESS cards): when a turn emits a data card,
  // the CARD is the answer - the model's accompanying prose is dropped so a fabricated sentence (a
  // company/number with zero DB rows behind it) is never persisted or fed back into the next turn's
  // history. The turn instead persists the code-derived VERDICT (honest, from the real tool result),
  // which keeps the resumed thread and the rebuilt model history accurate and role-alternating. An
  // error/refusal card persists no prose (its own copy is the surface); a card-less turn keeps the
  // model's plain prose. The render layer applies the matching suppression live.
  const verdicts = payloads
    .map((p) => {
      const parsed = DataInsightSchema.safeParse(p);
      return parsed.success ? parsed.data.verdict : null;
    })
    .filter((v): v is string => v !== null);
  const finalContent = verdicts.length > 0 ? verdicts.join(" ") : payloads.length > 0 ? "" : content;
  return { content: finalContent, parts: payload };
}

/** The card synthesized for a turn that errored with no (or no card-bearing) response message, so a
 *  failed turn always persists as a turn and resumes with its Retry affordance (AC-7). */
const SYSTEM_ERROR_CARD = { kind: "system" } as const;

/**
 * Persist the assistant turn (content + card payload) via the store. Called from the agent's
 * `onTurnComplete` on normal, stopped, AND errored completion. Errors are turns (AC-6/7): the SDK fires
 * onTurnComplete for an errored turn with `error` set and the response message UNDEFINED-or-partial, so
 * persistence branches on `error` rather than bailing on a missing response - a failed turn persists its
 * error card (synthesized when the response carried none) so a reload renders the card with Retry.
 *
 * The row is keyed by `responseMessage.id` (a uuid minted once for the turn) when a response is present,
 * so a replayed or re-persisted completion upserts into the same row instead of duplicating; a synthesized
 * error card has no response id, so it takes a fresh uuid. A completion with neither a response nor an
 * error (a manual pipe) persists nothing.
 */
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
  // A partial errored turn whose response carried no persistable card still persists the error card, so
  // it resumes with Retry rather than a bare unanswered question; a genuine answer card produced before
  // the error is kept as-is.
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

/** A run's reconstructed history is model messages - only the role + user text matter for persistence. */
export type RunMessage = { role: string; content?: unknown };

/**
 * Persist the newly-arrived user turn(s) present in the run's reconstructed `messages` but not yet in
 * the store, BEFORE the guard backstop counts them. Mechanism (a): a follow-up is delivered by the
 * client transport's `sendMessages` (append to `.in` + subscribe-with-wait - the only SDK 4.5.4 path
 * that streams a freshly-triggered turn live; `reconnectToStream` forces peekSettled), so the user turn
 * is no longer persisted by the server action - the agent's `run()` is the single persist site.
 *
 * Count-based (persist the tail of user messages beyond what the store already holds), so it is a no-op
 * on turn-1 arrival (`startConversation` already persisted message #1 before triggering) and on
 * regenerate (no new user turn) - it never double-persists. Idempotent across a run retry for the same
 * reason: once persisted, the stored count catches up and the tail is empty.
 *
 * Input-size backstop (both-layers, mirrors the cap/budget guard): the client transport appends a
 * follow-up to `.in` with only a write-scoped token, bypassing the action's `TextSchema` gate. So an
 * over-length NEW turn is refused HERE - returning "too_long" and persisting NOTHING - before the
 * oversized payload can reach Postgres or Bedrock. The bound is the SAME `MAX_INPUT_CHARS` the action
 * enforces (imported from ./guard, no duplicate literal), applied to the trimmed text like `TextSchema`,
 * so the two layers cannot drift. `null` means the turn(s) were within bound and persisted (or a no-op).
 */
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
