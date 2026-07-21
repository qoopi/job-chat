import { describe, expect, it, vi } from "vitest";
import {
  createChatRun,
  type ChatRunArgs,
  type ChatRunDeps,
  type StreamModel,
  type StreamModelArgs,
} from "../../trigger/run";
import type { Message, Store } from "@shared/store";

import type { CoverageProfile } from "@shared/analytics";

// 018 strand 5: createChatRun appends a one-line DATA SCOPE note (from the corpus profile) to the system
// prompt so the agent can qualify whole-market questions to the real sample. A minimal store stub lets
// the gate reach the model seam, where we capture the exact `system` string handed to the model.

type Seed = { role: "user" | "assistant"; content: string; parts?: unknown };

function stubStore(seed: Seed[] = [{ role: "user", content: "hi" }]): Store {
  const now = new Date();
  return {
    getConversationOwner: async () => ({ user_id: "u1", auth_user_id: null }),
    messageCounts: async () => 0,
    getConversation: async () => ({
      conversation: { id: "c1", user_id: "u1", title: "t", created_at: now },
      messages: seed.map((m, i) => ({
        id: `m${i + 1}`, conversation_id: "c1", role: m.role, content: m.content, parts: m.parts ?? null, created_at: now,
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

const args = (): ChatRunArgs => ({
  chatId: "c1",
  messages: [{ role: "user", content: "hi" }],
  trigger: "submit-message",
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

// R3 gate (AC-4/8/9): the load-bearing dedup + the refuse-before-persist order. Order in createChatRun
// is guards FIRST (a refused turn persists nothing - not even its user row), THEN persist the incoming
// user turn(s), THEN the already-answered check. Retry is recognized by the WIRE trigger, never guessed
// from the persisted tail - a failed turn now leaves a trailing assistant error row, so a tail-role
// guess would wrongly skip a legitimate Retry.
describe("createChatRun gate: dedup + refuse-before-persist (R3)", () => {
  function recordingStore(seed: Seed[], count = 0) {
    const store = stubStore(seed);
    const appended: Array<{ role: string; content: string }> = [];
    const counts = vi.fn(async () => count);
    store.appendMessage = (async (
      _c: string,
      role: "user" | "assistant",
      content: string,
    ) => {
      appended.push({ role, content });
      return { role, content } as unknown as Message;
    }) as Store["appendMessage"];
    store.messageCounts = counts;
    return { store, appended, counts };
  }

  const runWith = <R>(
    store: Store,
    overrides: Partial<ChatRunDeps<R>> & { streamModel: StreamModel<R> },
  ) =>
    createChatRun<R>({ ...base, withStore: <T>(fn: (s: Store) => Promise<T>) => fn(store), ...overrides });

  const argsFor = (
    trigger: ChatRunArgs["trigger"],
    messages: { role: string; content: string }[],
  ): ChatRunArgs => ({ chatId: "c1", messages, trigger, tools: {}, signal: new AbortController().signal });

  it("Should_SkipModelCall_When_SubmitEnvelopeAlreadyAnswered (AC-4)", async () => {
    // Tail is an assistant answer: a redelivered submit envelope (crash-continuation re-dispatch) is a
    // duplicate - the model is never called and nothing new is persisted.
    const { store, appended } = recordingStore([
      { role: "user", content: "How does this look across all cities?" },
      { role: "assistant", content: "Sunnyvale leads with 465 of 3488 postings." },
    ]);
    const streamModel = vi.fn(() => "answered" as const);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const run = runWith(store, { streamModel });

    const res = await run(argsFor("submit-message", [{ role: "user", content: "How does this look across all cities?" }]));

    expect(res).toBeUndefined();
    expect(streamModel).not.toHaveBeenCalled();
    expect(appended).toEqual([]); // no second answer, no re-persisted user row
    expect(logSpy).toHaveBeenCalledTimes(1); // one log line for the skip
    logSpy.mockRestore();
  });

  it("Should_RunTurn_When_RegenerateTriggerArrives (AC-8): regenerate runs even over a trailing assistant error row", async () => {
    // A FAILED turn left an assistant error row (content ""). A tail-role guess would skip it; keying off
    // the wire trigger, regenerate ALWAYS runs, and the empty error row drops from the rebuilt history.
    const { store, appended } = recordingStore([
      { role: "user", content: "Median salary in SF?" },
      { role: "assistant", content: "", parts: { kind: "system" } },
    ]);
    let captured: StreamModelArgs | undefined;
    const streamModel = vi.fn((a: StreamModelArgs) => {
      captured = a;
      return "answered" as const;
    });
    const run = runWith(store, { streamModel });

    const res = await run(argsFor("regenerate-message", [{ role: "user", content: "Median salary in SF?" }]));

    expect(res).toBe("answered");
    expect(streamModel).toHaveBeenCalledTimes(1);
    // the trailing error row is gone; the user question is the sole trailing turn handed to the model
    expect(captured!.messages).toEqual([{ role: "user", content: "Median salary in SF?" }]);
    expect(appended).toEqual([]); // Should_NotDuplicateUserRow_When_Retry: no new user row on regenerate
  });

  it("Should_NotDuplicateUserRow_When_Retry (AC-8): a regenerate over an answered tail still re-runs, no new user row", async () => {
    // Even when the tail is a SUCCESSFUL answer, a regenerate is honored (the user asked to redo it) and
    // never appends a second user row - the redo keys off the trigger, not the tail.
    const { store, appended } = recordingStore([
      { role: "user", content: "Who is hiring the most?" },
      { role: "assistant", content: "Google leads with 4 of 10 postings." },
    ]);
    const streamModel = vi.fn(() => "answered" as const);
    const run = runWith(store, { streamModel });

    const res = await run(argsFor("regenerate-message", [{ role: "user", content: "Who is hiring the most?" }]));

    expect(res).toBe("answered");
    expect(streamModel).toHaveBeenCalledTimes(1);
    expect(appended.filter((m) => m.role === "user")).toEqual([]);
  });

  it("Should_PersistNothing_When_BackstopRefuses (AC-9): the cap backstop refuses BEFORE the incoming user row persists", async () => {
    // Guards run FIRST: the cap counts the PRIOR rows only (matching the action gate), and the refused
    // follow-up persists nothing - not even its own user row (D6). The notice streams as a refusal part.
    const { store, appended, counts } = recordingStore(
      [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }],
      1, // one prior user turn already counted; cap is 1, so the new turn is refused
    );
    const streamModel = vi.fn(() => "answered" as const);
    const emitted: unknown[] = [];
    const run = runWith(store, {
      guards: { guestCap: 1, dailyBudget: 1_000_000_000 },
      emit: (p) => emitted.push(p),
      streamModel,
    });

    const res = await run(
      argsFor("submit-message", [
        { role: "user", content: "q1" },
        { role: "user", content: "q2" }, // the over-cap follow-up
      ]),
    );

    expect(res).toBeUndefined();
    expect(streamModel).not.toHaveBeenCalled();
    expect(appended).toEqual([]); // NOTHING persisted - the refused turn never enters the thread
    expect(counts).toHaveBeenCalled(); // guards ran first
    expect(emitted).toHaveLength(1); // exactly the refusal part
    expect((emitted[0] as { type: string; data: { reason: string } }).type).toBe("data-refusal");
    expect((emitted[0] as { data: { reason: string } }).data.reason).toBe("guest_cap");
  });
});
