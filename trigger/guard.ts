import type { Store } from "@shared/store";
import type { GuardConfig } from "@shared/env";

// The message guards (cap AC-15 + global daily budget AC-20), counted via the store so the same
// backstop holds on BOTH paths: the "use server" actions (early typed refusal, UX) and the durable
// agent run (the hard backstop on the write-token's real path to Bedrock). One home for the count
// logic so the two layers can never drift.

// `guest_cap` is the per-user message-cap refusal (whichever cap applied - the reason name is the UI
// contract 013 owns; the cap VALUE differs by kind). `daily_budget` is the global kill switch.
export type GuardRefusal = "guest_cap" | "daily_budget";

/**
 * Which per-user cap applies: a signed-in account gets the higher `signedInCap`, a guest the lower
 * `guestCap` (AC-13). The action layer knows the kind from the resolved Identity; the run() backstop
 * derives it from the owner's auth_user_id nullity (see `checkConversationGuards`).
 */
export type CallerKind = "guest" | "account";

function capFor(kind: CallerKind, guards: GuardConfig): number {
  // Fail-safe: an account with no signedInCap configured falls back to the (lower) guest cap.
  return kind === "account" ? (guards.signedInCap ?? guards.guestCap) : guards.guestCap;
}

// The input-size bound at the trust boundary, enforced on BOTH layers (like the cap/budget count):
// the "use server" actions (TextSchema, early UX refusal) and the agent run's ingress backstop
// (persistIncomingUserTurns, the write-token's real path). One home so the two can never drift - a
// hostile oversized payload must never reach Bedrock (token cost) or the message store (DB bloat).
export const MAX_INPUT_CHARS = 2000;

export interface GuardDeps {
  store: Store;
  guards: GuardConfig;
  now: () => Date;
}

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * The global daily budget (the spend kill switch, AC-20) is checked first, then the per-user cap
 * (AC-13/AC-15) selected by caller `kind` (defaults to the guest cap - the fail-safe when a legacy
 * caller passes none). The two counts run in ONE round trip (Promise.all); the scoped count is
 * computed even when the budget is already blown - the rare case - so the common allow path is a
 * single trip.
 */
export async function checkMessageGuards(
  deps: GuardDeps,
  userId: string,
  kind: CallerKind = "guest",
): Promise<GuardRefusal | null> {
  const since = utcMidnight(deps.now());
  const [global, scoped] = await Promise.all([
    deps.store.messageCounts({ sinceUtcMidnight: since }),
    deps.store.messageCounts({ userId, sinceUtcMidnight: since }),
  ]);
  if (global >= deps.guards.dailyBudget) return "daily_budget";
  if (scoped >= capFor(kind, deps.guards)) return "guest_cap";
  return null;
}

/**
 * The agent-side backstop: the durable chat run holds only the conversation id, so resolve the owner
 * (one indexed lookup) then apply the same guards. The cap is picked from the OWNER's auth_user_id
 * nullity (null = guest cap, set = signed-in cap) - the run() layer has no caller context. An unknown
 * conversation returns null (nothing to guard - the real path always has an owner).
 */
export async function checkConversationGuards(
  deps: GuardDeps,
  conversationId: string,
): Promise<GuardRefusal | null> {
  const owner = await deps.store.getConversationOwner(conversationId);
  if (!owner) return null;
  const kind: CallerKind = owner.auth_user_id === null ? "guest" : "account";
  return checkMessageGuards(deps, owner.user_id, kind);
}
