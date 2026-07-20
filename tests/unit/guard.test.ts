import { describe, expect, it, vi } from "vitest";
import type { Store } from "@shared/store";
import { checkConversationGuards, checkMessageGuards } from "../../trigger/guard";

// Cap-by-kind selection (AC-13), unit-tested with a fake store (no DB) - this is pure selection logic
// over GuardConfig + CallerKind, so a real Postgres round trip buys nothing. The dev made `kind`
// default to "guest" and `signedInCap` optional as a fail-safe (review note in 012's Completion
// Report); these tests prove the fallback direction only ever DEGRADES (a signed-in caller reading
// the lower guest cap - a safe annoyance) and never ELEVATES (a guest reading the higher signed-in
// cap - a cap bypass). Both guard-layer entry points are covered: the action layer's `kind` param
// (checkMessageGuards) and the run() backstop's owner-derived kind (checkConversationGuards).

const now = () => new Date();

function fakeStore(scoped: number, global = 0): Store {
  return {
    messageCounts: vi.fn(async ({ userId }: { userId?: string }) => (userId === undefined ? global : scoped)),
  } as unknown as Store;
}

describe("checkMessageGuards - cap-by-kind fallback direction (AC-13)", () => {
  it("defaults to the guest cap when kind is omitted, even with a higher signedInCap configured", async () => {
    const store = fakeStore(5);
    const guards = { guestCap: 5, signedInCap: 100, dailyBudget: 1000 };
    // No kind arg. If the default ever drifted to "account", scoped=5 would pass under signedInCap=100
    // instead of refusing - this is the elevation bug the fallback must not permit.
    expect(await checkMessageGuards({ store, guards, now }, "u1")).toBe("guest_cap");
  });

  it("never elevates an explicit guest to the signed-in cap, even when one is configured", async () => {
    const store = fakeStore(5);
    const guards = { guestCap: 5, signedInCap: 100, dailyBudget: 1000 };
    expect(await checkMessageGuards({ store, guards, now }, "u1", "guest")).toBe("guest_cap");
  });

  it("degrades an account to the guest cap when signedInCap is unset (fail-safe, not a bypass)", async () => {
    const store = fakeStore(5);
    const guards = { guestCap: 5, dailyBudget: 1000 }; // signedInCap intentionally absent
    // If the `?? guestCap` fallback were ever dropped, `scoped >= undefined` is always false in JS -
    // an UNCAPPED account, the worse failure mode. This proves the fallback actually fires and lands
    // on the lower cap, not on "no cap at all".
    expect(await checkMessageGuards({ store, guards, now }, "u1", "account")).toBe("guest_cap");
  });

  it("still grants an account its full signedInCap when one is configured (not over-degraded)", async () => {
    const store = fakeStore(5);
    const guards = { guestCap: 5, signedInCap: 100, dailyBudget: 1000 };
    expect(await checkMessageGuards({ store, guards, now }, "u1", "account")).toBeNull();
  });
});

describe("checkConversationGuards - kind derived from the owner's auth_user_id nullity", () => {
  function fakeOwnerStore(authUserId: string | null, scoped: number): Store {
    return {
      getConversationOwner: vi.fn(async () => ({ user_id: "u1", auth_user_id: authUserId })),
      messageCounts: vi.fn(async ({ userId }: { userId?: string }) => (userId === undefined ? 0 : scoped)),
    } as unknown as Store;
  }

  it("derives the guest cap from a null auth_user_id - never the signed-in cap", async () => {
    const store = fakeOwnerStore(null, 5);
    const guards = { guestCap: 5, signedInCap: 100, dailyBudget: 1000 };
    expect(await checkConversationGuards({ store, guards, now }, crypto.randomUUID())).toBe("guest_cap");
  });

  it("derives the signed-in cap from a set auth_user_id", async () => {
    const store = fakeOwnerStore("auth-1", 5);
    const guards = { guestCap: 5, signedInCap: 100, dailyBudget: 1000 };
    expect(await checkConversationGuards({ store, guards, now }, crypto.randomUUID())).toBeNull();
  });
});
