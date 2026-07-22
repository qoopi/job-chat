import { describe, expect, it, vi } from "vitest";
import type { Store, ProfileRow } from "@shared/store";
import type { Profile } from "@shared/profile";

// Keep the Trigger SDK inert so trigger/chat.ts imports without registering the chat.agent task (same
// pattern as agent-cache-point.test.ts) - we only exercise the pure resolveOwnerContext seam.
vi.mock("@trigger.dev/sdk/ai", () => ({
  chat: {
    agent: (cfg: unknown) => cfg,
    toStreamTextOptions: () => ({}),
    response: { write: () => {} },
  },
}));

import { resolveOwnerContext } from "../../trigger/chat";

// The per-turn owner-context resolution behind the fit tools + PROFILE note. Two behaviours the 030
// review-fixes pinned: (S1) a GUEST turn must NOT read getProfile (guests can never own one - a wasted
// read every guest turn), and (S2) any store failure DEGRADES to guest/no-profile so a transient DB blip
// never fails the whole turn (request_profile then fail-safes to the sign-in card; search_postings
// re-routes) - symmetric with run.ts's already-guarded profile dep.

const PROFILE: Profile = {
  titles: ["Backend Engineer"],
  seniority: "senior",
  skills: [],
  locations: [],
  remotePref: null,
  salaryMin: null,
  yearsExp: null,
  domains: [],
  ossHighlights: [],
  experience: [],
};

function profileRow(profile: Profile | null): ProfileRow {
  return {
    user_id: "u1",
    raw_resume_text: null,
    resume_pdf: null,
    github_username: null,
    profile,
    extracted_at: null,
    extraction_failed: false,
  } as ProfileRow;
}

function fakeStore(over: Partial<Store>): Store {
  return over as Store;
}

describe("resolveOwnerContext (030 review-fix S1 guest-skip + S2 degrade)", () => {
  it("skips getProfile for a GUEST owner (auth_user_id null) - guests never own a profile", async () => {
    const getProfile = vi.fn(async () => null);
    const store = fakeStore({
      getConversationOwner: vi.fn(async () => ({ user_id: "u1", auth_user_id: null })),
      getProfile,
    });

    const ctx = await resolveOwnerContext(store, "chat-1");

    expect(ctx).toEqual({ callerKind: "guest", profile: null });
    expect(getProfile).not.toHaveBeenCalled(); // the wasted read is gone
  });

  it("reads getProfile ONCE for a signed-in account and returns its structured profile", async () => {
    const getProfile = vi.fn(async () => profileRow(PROFILE));
    const store = fakeStore({
      getConversationOwner: vi.fn(async () => ({ user_id: "u1", auth_user_id: "auth-1" })),
      getProfile,
    });

    const ctx = await resolveOwnerContext(store, "chat-1");

    expect(ctx).toEqual({ callerKind: "account", profile: PROFILE });
    expect(getProfile).toHaveBeenCalledTimes(1);
  });

  it("returns the guest fallback for an unknown conversation (no owner) without touching getProfile", async () => {
    const getProfile = vi.fn(async () => null);
    const store = fakeStore({
      getConversationOwner: vi.fn(async () => null),
      getProfile,
    });

    expect(await resolveOwnerContext(store, "nope")).toEqual({ callerKind: "guest", profile: null });
    expect(getProfile).not.toHaveBeenCalled();
  });

  it("degrades to guest/no-profile when getConversationOwner throws (a DB blip never fails the turn)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = fakeStore({
      getConversationOwner: vi.fn(async () => {
        throw new Error("pg down");
      }),
      getProfile: vi.fn(async () => null),
    });

    expect(await resolveOwnerContext(store, "chat-1")).toEqual({ callerKind: "guest", profile: null });
    expect(errSpy).toHaveBeenCalled(); // logged, not invisible
    errSpy.mockRestore();
  });

  it("degrades to guest/no-profile when getProfile throws for a signed-in account", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = fakeStore({
      getConversationOwner: vi.fn(async () => ({ user_id: "u1", auth_user_id: "auth-1" })),
      getProfile: vi.fn(async () => {
        throw new Error("pg down");
      }),
    });

    expect(await resolveOwnerContext(store, "chat-1")).toEqual({ callerKind: "guest", profile: null });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
