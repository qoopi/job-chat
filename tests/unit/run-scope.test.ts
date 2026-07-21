import { describe, expect, it, vi } from "vitest";
import { createChatRun, type StreamModelArgs } from "../../trigger/run";
import type { Store } from "@shared/store";
import type { CoverageProfile } from "@shared/analytics";

// 018 strand 5: createChatRun appends a one-line DATA SCOPE note (from the corpus profile) to the system
// prompt so the agent can qualify whole-market questions to the real sample. A minimal store stub lets
// the gate reach the model seam, where we capture the exact `system` string handed to the model.

function stubStore(
  seed: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: "hi" }],
): Store {
  const now = new Date();
  return {
    getConversationOwner: async () => ({ user_id: "u1", auth_user_id: null }),
    messageCounts: async () => 0,
    getConversation: async () => ({
      conversation: { id: "c1", user_id: "u1", title: "t", created_at: now },
      messages: seed.map((m, i) => ({
        id: `m${i + 1}`, conversation_id: "c1", role: m.role, content: m.content, parts: null, created_at: now,
      })),
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

// Live defect (2026-07-21): Trigger delivers the turn envelope at-least-once - an already-answered
// turn was redelivered ~7s after its answer persisted, and the re-run persisted the SAME answer twice.
// The gate reads the persisted tail (the same read that rebuilds the model input): a non-user last row
// means the latest user turn already has its answer, so the duplicate skips the model call and ALL
// persistence - before the guards, so it can never emit a spurious refusal either. Composes with
// persistAssistantTurn's empty-row skip: a FAILED turn keeps a user tail, so a legitimate Retry
// (regenerate - the same envelope, no new user turn) still runs.
describe("Should_SkipTurn_When_EnvelopeRedelivered (createChatRun redelivery guard)", () => {
  const seedAnswered: { role: "user" | "assistant"; content: string }[] = [
    { role: "user", content: "How does this look across all cities?" },
    { role: "assistant", content: "Sunnyvale leads with 465 of 3488 postings." },
  ];

  function recordingStore(seed: { role: "user" | "assistant"; content: string }[]) {
    const store = stubStore(seed);
    const appended: unknown[] = [];
    const counts = vi.fn(async () => 0);
    store.appendMessage = async (...call: unknown[]) => {
      appended.push(call);
      return {} as never;
    };
    store.messageCounts = counts;
    return { store, appended, counts };
  }

  it("skips the model call and persistence when the persisted tail is an assistant row", async () => {
    const { store, appended, counts } = recordingStore(seedAnswered);
    const streamModel = vi.fn(() => "answered" as const);
    const emitted: unknown[] = [];
    const run = createChatRun({
      ...base,
      withStore: <T>(fn: (s: Store) => Promise<T>) => fn(store),
      emit: (part) => emitted.push(part),
      streamModel,
    });
    const res = await run({
      chatId: "c1",
      messages: [{ role: "user", content: "How does this look across all cities?" }],
      tools: {},
      signal: new AbortController().signal,
    });
    expect(res).toBeUndefined();
    expect(streamModel).not.toHaveBeenCalled();
    expect(appended).toEqual([]); // no second answer row
    expect(emitted).toEqual([]); // no spurious refusal part
    expect(counts).not.toHaveBeenCalled(); // skipped BEFORE the guards
  });

  it("processes normally when the persisted tail is a user row (unanswered - incl. Retry after a failed turn)", async () => {
    const { store, appended } = recordingStore([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" }, // the failed turn persisted no assistant row - q2 is unanswered
    ]);
    let captured: StreamModelArgs | undefined;
    const streamModel = vi.fn((args: StreamModelArgs) => {
      captured = args;
      return "answered" as const;
    });
    const run = createChatRun({
      ...base,
      withStore: <T>(fn: (s: Store) => Promise<T>) => fn(store),
      streamModel,
    });
    const res = await run({
      chatId: "c1",
      messages: [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ],
      tools: {},
      signal: new AbortController().signal,
    });
    expect(res).toBe("answered");
    expect(streamModel).toHaveBeenCalledTimes(1);
    const history = captured!.messages;
    expect(history[history.length - 1]).toEqual({ role: "user", content: "q2" });
    expect(appended).toEqual([]); // count-based ingress: no re-persist of already-stored turns
  });
});
