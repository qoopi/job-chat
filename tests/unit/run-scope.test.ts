import { describe, expect, it, vi } from "vitest";
import {
  createChatRun,
  type ChatRunArgs,
  type ChatRunDeps,
  type StreamModel,
  type StreamModelArgs,
} from "../../trigger/run";
import type { Message, Store } from "@shared/store";

import type { CorpusSummary, CoverageProfile } from "@shared/analytics";
import type { Profile } from "@shared/profile";

// createChatRun appends a one-line DATA SCOPE note (from the corpus profile) to the system
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
    deleteTrailingAssistant: async () => {},
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

// createChatRun appends a PROFILE note (structured profile only, owner-keyed) PER TURN when the
// conversation owner has a profile, so the agent routes a fit-intent to search_postings. Resolved fresh
// each turn (never memoized) and never allowed to block the turn.
const OWNER_PROFILE: Profile = {
  titles: ["Senior Backend Engineer", "Staff Engineer"],
  seniority: "senior",
  skills: [{ name: "TypeScript", source: "both" }, { name: "ClickHouse", source: "github" }],
  locations: ["Berlin"],
  remotePref: true,
  salaryMin: 120000,
  yearsExp: 8,
  domains: ["fintech"],
  ossHighlights: [],
  experience: [],
};

describe("createChatRun PROFILE note injection (030)", () => {
  it("appends the structured PROFILE note (owner-keyed) so fit-intents route to search_postings", async () => {
    let capturedSystem = "";
    const run = createChatRun({
      ...base,
      profile: async () => OWNER_PROFILE,
      streamModel: ({ system }) => {
        capturedSystem = system;
        return "ok" as const;
      },
    });
    await run(args());
    expect(capturedSystem).toContain("BASE PROMPT"); // base prompt preserved
    expect(capturedSystem).toContain("PROFILE:");
    expect(capturedSystem).toContain("search_postings");
    expect(capturedSystem).toContain("Senior Backend Engineer, Staff Engineer"); // the titles the model draws terms from
    expect(capturedSystem).toContain("Seniority: senior");
    expect(capturedSystem).toContain("Salary floor: 120000");
    // The raw resume must NEVER reach the model - only the structured shape.
    expect(capturedSystem).not.toContain("resume");
  });

  it("resolves the profile PER TURN (never memoized) and passes the conversation id", async () => {
    const seen: string[] = [];
    const run = createChatRun({
      ...base,
      profile: async (chatId) => {
        seen.push(chatId);
        return OWNER_PROFILE;
      },
      streamModel: () => "ok" as const,
    });
    await run(args());
    await run(args());
    expect(seen).toEqual(["c1", "c1"]); // resolved fresh on each turn, keyed by the chat id
  });

  it("omits the note when the owner has no profile (the request_profile path stays)", async () => {
    let capturedSystem = "";
    const run = createChatRun({
      ...base,
      profile: async () => null,
      streamModel: ({ system }) => {
        capturedSystem = system;
        return "ok" as const;
      },
    });
    await run(args());
    expect(capturedSystem).toBe("BASE PROMPT");
    expect(capturedSystem).not.toContain("PROFILE:");
  });

  it("never blocks the turn if the profile resolution fails", async () => {
    let capturedSystem = "";
    const run = createChatRun({
      ...base,
      profile: async () => {
        throw new Error("postgres unreachable");
      },
      streamModel: ({ system }) => {
        capturedSystem = system;
        return "ok" as const;
      },
    });
    const res = await run(args());
    expect(res).toBe("ok");
    expect(capturedSystem).toBe("BASE PROMPT"); // the prompt is intact, the turn ran
  });
});

// createChatRun appends a per-conversation CORPUS note (044 AC-2/3): what the live data contains, fetched
// ONCE per conversation (memoized by chatId) and reused byte-identically across its turns so the cached
// system prefix stays warm; a NEW conversation re-fetches fresh facts; a failed fetch degrades to NO note.
const OWNER_CORPUS: CorpusSummary = {
  total: 3488,
  freshestAt: "2026-07-18 06:00:00",
  salaryCoverage: 0.65,
  sources: [{ source: "searchnapply", share: 0.98 }, { source: "fixture", share: 0.02 }],
  topCities: ["San Francisco", "Los Angeles", "Berlin"],
  countries: ["United States", "Germany"],
  experienceLevels: ["Senior", "Junior", "Staff"],
  employmentTypes: ["full-time", "contract"],
  locationKinds: ["onsite", "remote", "hybrid"],
};

describe("createChatRun CORPUS note injection (044 AC-2/3)", () => {
  it("renders a compact CORPUS note from the fixture summary (the values that EXIST)", async () => {
    let capturedSystem = "";
    const run = createChatRun({
      ...base,
      corpus: async () => OWNER_CORPUS,
      streamModel: ({ system }) => {
        capturedSystem = system;
        return "ok" as const;
      },
    });
    const res = await run(args());
    expect(res).toBe("ok");
    expect(capturedSystem).toContain("BASE PROMPT"); // base prompt preserved
    expect(capturedSystem).toContain("CORPUS:");
    expect(capturedSystem).toContain("3,488 open postings");
    expect(capturedSystem).toContain("snapshot 2026-07-18");
    expect(capturedSystem).toContain("Sources: searchnapply 98%, fixture 2%.");
    expect(capturedSystem).toContain("Busiest cities: San Francisco, Los Angeles, Berlin.");
    expect(capturedSystem).toContain("Busiest countries: United States, Germany.");
    expect(capturedSystem).toContain("experience_level values: Senior, Junior, Staff.");
    expect(capturedSystem).toContain("employment_type values: full-time, contract.");
    expect(capturedSystem).toContain("location_kind values: onsite, remote, hybrid.");
    expect(capturedSystem).toContain("Salary present on ~65%");
    expect(capturedSystem.toLowerCase()).toContain("case-insensitive");
  });

  it("sanitizes ingest-sourced corpus values: collapses newlines and caps length (044 review, defense-in-depth)", async () => {
    let capturedSystem = "";
    const dirty: CorpusSummary = { ...OWNER_CORPUS, topCities: ["Bad\nCity", "x".repeat(200)] };
    const run = createChatRun({
      ...base,
      corpus: async () => dirty,
      streamModel: ({ system }) => {
        capturedSystem = system;
        return "ok" as const;
      },
    });
    await run(args());
    // A newline inside a value never leaks into the note as line structure...
    expect(capturedSystem).toContain("Busiest cities: Bad City,");
    // ...and an overlong value is capped, never emitted at full length.
    expect(capturedSystem).not.toContain("x".repeat(61));
  });

  it("falls back to the base prompt if the corpus fetch fails (never blocks the turn)", async () => {
    let capturedSystem = "";
    const run = createChatRun({
      ...base,
      corpus: async () => {
        throw new Error("clickhouse unreachable");
      },
      streamModel: ({ system }) => {
        capturedSystem = system;
        return "ok" as const;
      },
    });
    const res = await run(args());
    expect(res).toBe("ok");
    expect(capturedSystem).toBe("BASE PROMPT");
  });

  it("omits the note entirely when no corpus dep is provided", async () => {
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

  it("fetches the corpus ONCE per conversation and reuses it byte-identically across turns (AC-3)", async () => {
    let calls = 0;
    const captured: string[] = [];
    const run = createChatRun({
      ...base,
      corpus: async () => {
        calls++;
        return OWNER_CORPUS;
      },
      streamModel: ({ system }) => {
        captured.push(system);
        return "ok" as const;
      },
    });
    await run(args());
    await run(args());
    expect(calls).toBe(1); // fetched on the first turn only, reused on the second
    expect(captured).toHaveLength(2);
    expect(captured[0]).toContain("CORPUS:");
    expect(captured[1]).toBe(captured[0]); // byte-identical -> the cached system prefix stays warm
  });

  it("re-fetches fresh corpus facts for a NEW conversation (a different chatId)", async () => {
    const seen: string[] = [];
    const run = createChatRun({
      ...base,
      corpus: async (chatId) => {
        seen.push(chatId);
        return OWNER_CORPUS;
      },
      streamModel: () => "ok" as const,
    });
    await run(args()); // chatId c1
    await run({ ...args(), chatId: "c2" });
    expect(seen).toEqual(["c1", "c2"]); // c1 memoized, c2 fetched fresh (not served from c1's memo)
  });
});

// The load-bearing dedup + the refuse-before-persist order. Order in createChatRun
// is guards FIRST (a refused turn persists nothing - not even its user row), THEN persist the incoming
// user turn(s), THEN the already-answered check. Retry is recognized by the WIRE trigger, never guessed
// from the persisted tail - a regenerate over a SUCCESSFUL answer has an assistant tail, so a tail-role
// guess would wrongly skip that legitimate Retry.
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

  it("Should_RunTurn_When_RegenerateTriggerArrives (AC-8): regenerate runs even over a trailing empty assistant row", async () => {
    // A legacy/defensive shape - a trailing assistant row with empty content (e.g. a pre-flip error row).
    // A tail-role guess would skip it; keying off the wire trigger, regenerate ALWAYS runs, and the empty
    // row drops from the rebuilt history.
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
    // Row-count stability, not merely "no error": nothing at all is appended during a regenerate (run()
    // never persists an assistant row either - that's onTurnComplete's job) - so the store's row count
    // is UNCHANGED across the retry, not just absent a duplicate user row.
    expect(appended).toEqual([]);
  });

  // Out-of-band append invariant: a profile-card row appended mid-turn (the save flow lands while a
  // submit is in flight) must NOT make a crash-redispatched submit envelope skip the turn. The gate
  // computes its already-answered tail over NON-profile-card rows, so the user question - still
  // unanswered - is the effective tail and the turn runs. buildModelHistory already drops the card, so
  // the model sees only the question.
  it("Should_AnswerTurn_When_SaveLandsMidTurn: a redispatched submit still runs when a profile-card trails the unanswered user turn", async () => {
    const profileCard = {
      kind: "profile-card",
      profile: {
        titles: ["Senior Backend Engineer"],
        seniority: "senior",
        skills: [],
        locations: ["Berlin"],
        remotePref: null,
        salaryMin: null,
        yearsExp: 8,
        domains: [],
        ossHighlights: [],
        experience: [],
      },
    };
    const { store, appended } = recordingStore([
      { role: "user", content: "Median salary in SF?" },
      { role: "assistant", content: "", parts: profileCard }, // the out-of-band card, not an answer
    ]);
    let captured: StreamModelArgs | undefined;
    const streamModel = vi.fn((a: StreamModelArgs) => {
      captured = a;
      return "answered" as const;
    });
    const run = runWith(store, { streamModel });

    const res = await run(argsFor("submit-message", [{ role: "user", content: "Median salary in SF?" }]));

    expect(res).toBe("answered"); // NOT skipped - the card is invisible to the dedup
    expect(streamModel).toHaveBeenCalledTimes(1);
    // The card drops from the rebuilt history; the question is the sole trailing turn the model sees.
    expect(captured!.messages).toEqual([{ role: "user", content: "Median salary in SF?" }]);
    expect(appended).toEqual([]); // a redelivery persists nothing new
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

  // Documented edge: guards run BEFORE the already-answered skip
  // check, so a REDELIVERED submit envelope for a turn that is already answered - landing when the
  // caller is EXACTLY at the cap (the crash-continuation-at-cap corner) - is refused instead of silently
  // skipped. This is harmless ONLY if the refusal is stream-only: nothing persists, so neither a
  // duplicate of the existing answer nor a spurious refusal row ever lands in the thread, and the
  // notice re-derives cleanly on the next real send.
  it("Should_PersistNothing_When_AlreadyAnsweredSubmitArrivesAtCap: a redelivered answered turn refuses harmlessly (stream-only, nothing persists)", async () => {
    const { store, appended, counts } = recordingStore(
      [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }],
      1, // exactly at the cap: one prior user turn already counted
    );
    const streamModel = vi.fn(() => "answered" as const);
    const emitted: unknown[] = [];
    const run = runWith(store, {
      guards: { guestCap: 1, dailyBudget: 1_000_000_000 },
      emit: (p) => emitted.push(p),
      streamModel,
    });

    // The redelivered envelope: the SAME already-answered question, not a new one.
    const res = await run(argsFor("submit-message", [{ role: "user", content: "q1" }]));

    expect(res).toBeUndefined();
    expect(streamModel).not.toHaveBeenCalled();
    expect(counts).toHaveBeenCalled(); // the guard ran before the already-answered tail was ever consulted
    expect(appended).toEqual([]); // nothing persists - the answered row is untouched, no refusal row either
    expect(emitted).toHaveLength(1); // the harmless stream-only refusal
    expect((emitted[0] as { type: string; data: { reason: string } }).type).toBe("data-refusal");
    expect((emitted[0] as { data: { reason: string } }).data.reason).toBe("guest_cap");
  });

  // Composes with persistAssistantTurn's empty-turn skip (ruling #2): a FAILED turn persists no assistant
  // row, so its user question stays the tail. A submit over that unanswered user tail runs the model (it is
  // NOT a redelivery of an answered turn) and re-persists nothing (count-based ingress - q1/q2 already stored).
  it("Should_RunTurn_When_SubmitTailIsUnansweredUser: a submit over a trailing (failed-turn) user row still runs", async () => {
    const { store, appended } = recordingStore([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" }, // the failed turn persisted no assistant row - q2 is unanswered
    ]);
    let captured: StreamModelArgs | undefined;
    const streamModel = vi.fn((a: StreamModelArgs) => {
      captured = a;
      return "answered" as const;
    });
    const run = runWith(store, { streamModel });

    const res = await run(
      argsFor("submit-message", [
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
      ]),
    );

    expect(res).toBe("answered");
    expect(streamModel).toHaveBeenCalledTimes(1);
    const history = captured!.messages;
    expect(history[history.length - 1]).toEqual({ role: "user", content: "q2" });
    expect(appended).toEqual([]); // count-based ingress: no re-persist of already-stored turns
  });
});
