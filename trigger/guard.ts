import type { Store } from "@shared/store";
import type { GuardConfig } from "@shared/env";
import type { GuardRefusal } from "@shared/insight";

// Guards (per-user cap + daily budget) counted via the store: the SAME backstop on both the actions and the agent run (one home, can't drift).

export type CallerKind = "guest" | "account";

/** Caller kind from a conversation owner: a null auth_user_id is a guest, else an account. */
export function callerKindFor(owner: { auth_user_id: string | null }): CallerKind {
  return owner.auth_user_id === null ? "guest" : "account";
}

function capFor(kind: CallerKind, guards: GuardConfig): number {
  // Fail-safe: an account with no signedInCap configured falls back to the (lower) guest cap.
  return kind === "account" ? (guards.signedInCap ?? guards.guestCap) : guards.guestCap;
}

// Input-size bound at the trust boundary, enforced on BOTH layers (one home): a hostile payload must never reach Bedrock or the store.
export const MAX_INPUT_CHARS = 2000;

export interface GuardDeps {
  store: Store;
  guards: GuardConfig;
  now: () => Date;
}

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Daily budget (kill switch) first, then the per-user cap by kind (default guest); both counts in ONE round trip. */
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

/** Agent-side backstop: resolve the owner, cap picked from the OWNER's auth_user_id nullity; unknown conversation returns null. */
export async function checkConversationGuards(
  deps: GuardDeps,
  conversationId: string,
): Promise<GuardRefusal | null> {
  const owner = await deps.store.getConversationOwner(conversationId);
  if (!owner) return null;
  const kind: CallerKind = callerKindFor(owner);
  return checkMessageGuards(deps, owner.user_id, kind);
}
