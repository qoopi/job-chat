import { describe, expect, it } from "vitest";
import { createChatRun } from "../../trigger/run";
import type { Store } from "@shared/store";
import type { CoverageProfile } from "@shared/analytics";

// 018 strand 5: createChatRun appends a one-line DATA SCOPE note (from the corpus profile) to the system
// prompt so the agent can qualify whole-market questions to the real sample. A minimal store stub lets
// the gate reach the model seam, where we capture the exact `system` string handed to the model.

function stubStore(): Store {
  const now = new Date();
  return {
    getConversationOwner: async () => ({ user_id: "u1", auth_user_id: null }),
    messageCounts: async () => 0,
    getConversation: async () => ({
      conversation: { id: "c1", user_id: "u1", title: "t", created_at: now },
      messages: [{ id: "m1", conversation_id: "c1", role: "user", content: "hi", parts: null, created_at: now }],
    }),
    appendMessage: async () => ({ id: "m", conversation_id: "c1", role: "user", content: "", parts: null, created_at: now }),
    getOrCreateUser: async () => ({ user_id: "u1", created_at: now, auth_user_id: null }),
    createConversation: async () => ({ id: "c1", user_id: "u1", title: "t", created_at: now }),
    findUserByAuthId: async () => null,
    linkAuthUser: async () => false,
    adoptGuest: async () => {},
    deleteConversation: async () => {},
    listConversations: async () => [],
  } as unknown as Store;
}

const profile: CoverageProfile = {
  total: 3488,
  distinctCompanies: 7,
  topCompany: "Google",
  topCompanyShare: 0.93,
  freshestAt: "2026-07-20 06:00:00",
  salaryCoverage: 0.65,
};

const base = {
  withStore: <T>(fn: (store: Store) => Promise<T>) => fn(stubStore()),
  guards: { guestCap: 1_000_000_000, dailyBudget: 1_000_000_000 },
  emit: () => {},
  now: () => new Date(),
  system: "BASE PROMPT",
};

const args = () => ({
  chatId: "c1",
  messages: [{ role: "user", content: "hi" }],
  tools: {},
  signal: new AbortController().signal,
});

describe("createChatRun DATA SCOPE injection (018 strand 5)", () => {
  it("appends a one-line DATA SCOPE note built from the coverage profile", async () => {
    let capturedSystem = "";
    const run = createChatRun({
      ...base,
      coverageProfile: async () => profile,
      streamModel: ({ system }) => {
        capturedSystem = system;
        return "ok" as const;
      },
    });
    const res = await run(args());
    expect(res).toBe("ok");
    expect(capturedSystem).toContain("BASE PROMPT"); // base prompt preserved
    expect(capturedSystem).toContain("DATA SCOPE");
    expect(capturedSystem).toContain("3,488 open postings");
    expect(capturedSystem).toContain("7 companies");
    expect(capturedSystem).toContain("93% are Google");
    expect(capturedSystem).toContain("salary is present on ~65%");
    expect(capturedSystem.toLowerCase()).toContain("qualify");
  });

  it("falls back to the base prompt if the coverage profile fails (never blocks the turn)", async () => {
    let capturedSystem = "";
    const run = createChatRun({
      ...base,
      coverageProfile: async () => {
        throw new Error("clickhouse unreachable");
      },
      streamModel: ({ system }) => {
        capturedSystem = system;
        return "ok" as const;
      },
    });
    await run(args());
    expect(capturedSystem).toBe("BASE PROMPT");
  });

  it("omits the note entirely when no coverageProfile dep is provided", async () => {
    let capturedSystem = "";
    const run = createChatRun({
      ...base,
      streamModel: ({ system }) => {
        capturedSystem = system;
        return "ok" as const;
      },
    });
    await run(args());
    expect(capturedSystem).toBe("BASE PROMPT");
  });
});
