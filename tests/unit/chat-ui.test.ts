import { describe, expect, it } from "vitest";
import type { DataInsight } from "@shared/insight";
import type { UIMessage } from "ai";
import type { Profile } from "@shared/profile";
import {
  classifyCardData,
  isStreaming,
  messageText,
  proseSpans,
  reconcileMessagesById,
  resolveDetailContent,
  storeToUiMessages,
  type StoredMessage,
} from "@/lib/chat-ui";

// The client's reading of a chat turn: classify a card payload (live part or resumed store payload)
// and hydrate persisted messages into the `useChat` initial shape. Both are the resume path and
// the live-stream reconciliation path, so they are locked with a unit test.

const insight: DataInsight = {
  id: "insight-1",
  kind: "chart",
  chartType: "bars",
  verdict: "Amazon leads hiring with 214 open roles.",
  series: [{ company: "Amazon", count: 214 }],
  followups: ["Only remote roles"],
  meta: { sql: "SELECT 1", sampleN: 3483, updatedAt: "2026-07-18 19:12:00" },
};

describe("classifyCardData", () => {
  it("classifies a strict-valid insight payload", () => {
    const c = classifyCardData(insight);
    expect(c.kind).toBe("insight");
    if (c.kind === "insight") expect(c.insight.verdict).toBe("Amazon leads hiring with 214 open roles.");
  });

  it("classifies a loading skeleton (never a stuck insight), carrying its chartType", () => {
    expect(classifyCardData({ id: "x", kind: "chart", chartType: "donut", status: "loading" })).toEqual({
      kind: "skeleton",
      chartType: "donut",
    });
    expect(classifyCardData({ id: "x", kind: "table", status: "loading" })).toEqual({
      kind: "skeleton",
      chartType: undefined,
    });
  });

  it("classifies the error markers (AC-10) by kind", () => {
    expect(classifyCardData({ kind: "system" })).toEqual({ kind: "error", errorKind: "system" });
    expect(classifyCardData({ kind: "unanswerable" })).toEqual({ kind: "error", errorKind: "unanswerable" });
  });

  it("classifies the refusal markers (AC-15/AC-20 + too_long) by reason", () => {
    expect(classifyCardData({ reason: "guest_cap" })).toEqual({ kind: "refusal", reason: "guest_cap" });
    expect(classifyCardData({ reason: "daily_budget" })).toEqual({ kind: "refusal", reason: "daily_budget" });
    expect(classifyCardData({ reason: "too_long" })).toEqual({ kind: "refusal", reason: "too_long" });
  });

  it("falls to unknown for an unrecognized shape (never throws in render)", () => {
    expect(classifyCardData({ foo: "bar" })).toEqual({ kind: "unknown" });
    expect(classifyCardData(null)).toEqual({ kind: "unknown" });
  });

  // A 0-row tool result emits the empty marker; it is neither skeleton nor insight, so it renders NOTHING -
  // an empty insight never becomes a hollow chart body (the answer is the model's plain prose instead).
  it("classifies the empty (0-row) marker as unknown - no chart is ever rendered for it", () => {
    expect(classifyCardData({ status: "empty" })).toEqual({ kind: "unknown" });
  });

  // The 029 part vocabulary: profile-card / postings / auth-invite / profile-invite.
  const profile: Profile = {
    titles: ["Senior Backend Engineer"],
    seniority: "senior",
    skills: [{ name: "Go", source: "both" }],
    locations: ["Berlin"],
    remotePref: true,
    salaryMin: 120000,
    yearsExp: 8,
    domains: ["distributed systems"],
    ossHighlights: ["Merged PRs to trigger.dev"],
    experience: [],
    canonicalRoles: [],
  };

  it("classifies a valid profile-card payload, carrying the profile", () => {
    const c = classifyCardData({ kind: "profile-card", profile });
    expect(c.kind).toBe("profile-card");
    if (c.kind === "profile-card") expect(c.profile.titles).toEqual(["Senior Backend Engineer"]);
  });

  it("drops a malformed profile-card to unknown (no profile)", () => {
    expect(classifyCardData({ kind: "profile-card" })).toEqual({ kind: "unknown" });
  });

  it("classifies a valid postings payload, carrying rows + total", () => {
    const rows = [
      {
        title: "Senior Backend Engineer",
        company: "Google",
        city: "Munich",
        remote: false,
        salaryMin: 95000,
        salaryMax: 140000,
        experience: "Senior",
        publishedAt: "2026-07-20",
        score: 0.91,
      },
    ];
    const c = classifyCardData({ kind: "postings", rows, total: 23 });
    expect(c.kind).toBe("postings");
    if (c.kind === "postings") {
      expect(c.total).toBe(23);
      expect(c.rows[0].company).toBe("Google");
    }
  });

  it("classifies the two invite markers by kind", () => {
    expect(classifyCardData({ kind: "auth-invite" })).toEqual({ kind: "auth-invite" });
    expect(classifyCardData({ kind: "profile-invite" })).toEqual({ kind: "profile-invite" });
  });
});

// The detail panel superset resolver: a card-backed panel is a table, the expanded profile, or the full postings
// list, re-resolved from the immutable part payload (identical resume semantics to the table path).
describe("resolveDetailContent", () => {
  const profile: Profile = {
    titles: ["Senior Backend Engineer"],
    seniority: "senior",
    skills: [{ name: "Go", source: "both" }],
    locations: ["Berlin"],
    remotePref: true,
    salaryMin: 120000,
    yearsExp: 8,
    domains: [],
    ossHighlights: [],
    experience: [],
    canonicalRoles: [],
  };
  const postingsRows = [
    {
      title: "Senior Backend Engineer",
      company: "Google",
      city: "Munich",
      remote: false,
      salaryMin: 95000,
      salaryMax: 140000,
      experience: "Senior",
      publishedAt: "2026-07-20",
      score: 0.9,
    },
  ];
  const messages: UIMessage[] = [
    { id: "a1", role: "assistant", parts: [{ type: "data-insight", id: "a1-c0", data: insight } as UIMessage["parts"][number]] },
    { id: "a2", role: "assistant", parts: [{ type: "data-profile-card", id: "a2-c0", data: { kind: "profile-card", profile } } as UIMessage["parts"][number]] },
    { id: "a3", role: "assistant", parts: [{ type: "data-postings", id: "a3-c0", data: { kind: "postings", rows: postingsRows, total: 23 } } as UIMessage["parts"][number]] },
  ];

  it("resolves an insight part to a table", () => {
    const c = resolveDetailContent(messages, { messageId: "a1", partId: "a1-c0" });
    expect(c?.kind).toBe("table");
  });
  it("resolves a profile-card part to the profile", () => {
    const c = resolveDetailContent(messages, { messageId: "a2", partId: "a2-c0" });
    expect(c?.kind).toBe("profile-card");
    if (c?.kind === "profile-card") expect(c.profile.titles).toEqual(["Senior Backend Engineer"]);
  });
  it("resolves a postings part to the rows + total", () => {
    const c = resolveDetailContent(messages, { messageId: "a3", partId: "a3-c0" });
    expect(c?.kind).toBe("postings");
    if (c?.kind === "postings") expect(c.total).toBe(23);
  });
  it("returns null for a missing target", () => {
    expect(resolveDetailContent(messages, { messageId: "zzz", partId: "a1-c0" })).toBeNull();
  });
});

describe("isStreaming", () => {
  it("is true while submitted or streaming, false when ready/error", () => {
    expect(isStreaming("submitted")).toBe(true);
    expect(isStreaming("streaming")).toBe(true);
    expect(isStreaming("ready")).toBe(false);
    expect(isStreaming("error")).toBe(false);
  });
});

describe("messageText", () => {
  it("joins text parts and ignores data parts", () => {
    expect(
      messageText({
        parts: [
          { type: "text", text: "Postings are up 12% " },
          { type: "data-insight", id: "c", data: insight },
          { type: "text", text: "this quarter." },
        ] as never,
      }),
    ).toBe("Postings are up 12% this quarter.");
  });

  it("preserves the sentence boundary between adjacent text parts (live-walk #4b)", () => {
    // Regression: two prose parts glued: "...across the market.The market has seen...".
    expect(
      messageText({
        parts: [
          { type: "text", text: "Hiring cooled across the market." },
          { type: "text", text: "The market has seen a 12% drop." },
        ] as never,
      }),
    ).toBe("Hiring cooled across the market. The market has seen a 12% drop.");
  });

  it("does not double a space already present at a part boundary", () => {
    expect(
      messageText({
        parts: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ] as never,
      }),
    ).toBe("Hello world");
  });
});

describe("proseSpans (ai bubble prose, live-walk #4a)", () => {
  it("renders **bold** as a bold span with the asterisks removed (operator example)", () => {
    expect(proseSpans("**3,315 new postings over the last 90 days**")).toEqual([
      { text: "3,315 new postings over the last 90 days", bold: true },
    ]);
  });

  it("splits mixed bold and plain text, keeping order and surrounding spaces", () => {
    expect(proseSpans("There are **214** open roles")).toEqual([
      { text: "There are ", bold: false },
      { text: "214", bold: true },
      { text: " open roles", bold: false },
    ]);
  });

  it("strips other inline markdown to plain text (no literal markers)", () => {
    expect(proseSpans("A `code` and *emph* note")).toEqual([{ text: "A code and emph note", bold: false }]);
  });

  it("returns plain text untouched when there is no markdown", () => {
    expect(proseSpans("Amazon leads hiring with 214 open roles.")).toEqual([
      { text: "Amazon leads hiring with 214 open roles.", bold: false },
    ]);
  });
});

describe("reconcileMessagesById (hydrated + replayed duplicate seam)", () => {
  const mk = (id: string, role: "user" | "assistant", text: string): UIMessage => ({
    id,
    role,
    parts: [{ type: "text", text }],
  });

  it("returns the list untouched (same refs, same order) when every id is unique", () => {
    const list = [mk("u1", "user", "q"), mk("a1", "assistant", "answer")];
    const out = reconcileMessagesById(list);
    expect(out.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(out[0]).toBe(list[0]);
    expect(out[1]).toBe(list[1]);
  });

  it("folds a duplicate id into one, keeping its FIRST position and the LATEST content (replace, never append)", () => {
    // A hydrated turn (id a1) that the SDK's reconnect replays re-appends under the same id.
    const stale = mk("a1", "assistant", "hydrated");
    const replayed = mk("a1", "assistant", "replayed");
    const out = reconcileMessagesById([mk("u1", "user", "q"), stale, mk("u2", "user", "q2"), replayed]);
    expect(out.map((m) => m.id)).toEqual(["u1", "a1", "u2"]); // one a1, order preserved
    expect(out[1]).toBe(replayed); // latest content wins, at the original a1 position
  });

  it("does not mutate the input array", () => {
    const list = [mk("a1", "assistant", "x"), mk("a1", "assistant", "y")];
    const copy = [...list];
    reconcileMessagesById(list);
    expect(list).toEqual(copy);
  });
});

describe("storeToUiMessages (AC-13 resume hydration)", () => {
  it("hydrates a user turn as a single text part", () => {
    const stored: StoredMessage[] = [{ id: "m1", role: "user", content: "Top companies?", parts: null }];
    expect(storeToUiMessages(stored)).toEqual([
      { id: "m1", role: "user", parts: [{ type: "text", text: "Top companies?" }] },
    ]);
  });

  it("hydrates an assistant insight turn as prose text + a data-insight part with a stable id", () => {
    const stored: StoredMessage[] = [{ id: "m2", role: "assistant", content: "Here you go.", parts: insight }];
    const [ui] = storeToUiMessages(stored);
    expect(ui.role).toBe("assistant");
    expect(ui.parts).toEqual([
      { type: "text", text: "Here you go." },
      { type: "data-insight", id: "m2-card-0", data: insight },
    ]);
  });

  it("hydrates a resumed error turn as a data-error part (never a stuck skeleton)", () => {
    const stored: StoredMessage[] = [{ id: "m3", role: "assistant", content: "", parts: { kind: "unanswerable" } }];
    const [ui] = storeToUiMessages(stored);
    expect(ui.parts).toEqual([{ type: "data-error", id: "m3-card-0", data: { kind: "unanswerable" } }]);
  });

  it("hydrates a multi-card assistant turn (array payload) into one part per card", () => {
    const stored: StoredMessage[] = [{ id: "m4", role: "assistant", content: "", parts: [insight, insight] }];
    const [ui] = storeToUiMessages(stored);
    expect(ui.parts.map((p) => p.type)).toEqual(["data-insight", "data-insight"]);
    expect(ui.parts.map((p) => (p as { id: string }).id)).toEqual(["m4-card-0", "m4-card-1"]);
  });

  it("drops an unrecognized/loading payload rather than resuming a stuck card", () => {
    const stored: StoredMessage[] = [
      { id: "m5", role: "assistant", content: "plain answer", parts: { status: "loading", kind: "chart" } },
    ];
    const [ui] = storeToUiMessages(stored);
    expect(ui.parts).toEqual([{ type: "text", text: "plain answer" }]);
  });

  it("re-tags a resumed profile-card payload as a data-profile-card part (029)", () => {
    const profile: Profile = {
      titles: ["Senior Backend Engineer"],
      seniority: "senior",
      skills: [],
      locations: [],
      remotePref: null,
      salaryMin: null,
      yearsExp: null,
      domains: [],
      ossHighlights: [],
      experience: [],
      canonicalRoles: [],
    };
    const payload = { kind: "profile-card", profile };
    const stored: StoredMessage[] = [{ id: "m6", role: "assistant", content: "", parts: payload }];
    const [ui] = storeToUiMessages(stored);
    expect(ui.parts).toEqual([{ type: "data-profile-card", id: "m6-card-0", data: payload }]);
  });

  it("preserves each posting row's natural key (source, externalId) through hydration + resolveDetailContent (053)", () => {
    // A resumed postings card must carry its rows' keys intact end to end - hydrate re-tags by kind, and the
    // panel resolver re-reads the SAME payload - so a click on a resumed row opens the RIGHT posting. A dropped
    // or renamed key here is the 053 "posting unavailable" bug at the persistence seam.
    const keyedRow = {
      title: "Platform Reliability Engineer",
      company: "Acme",
      city: "Berlin",
      remote: true,
      salaryMin: 150000,
      salaryMax: 190000,
      experience: "Senior",
      publishedAt: "2026-07-20",
      score: 9,
      source: "Greenhouse",
      externalId: "1432006520",
    };
    const payload = { kind: "postings", rows: [keyedRow], total: 1 };
    const stored: StoredMessage[] = [{ id: "m7", role: "assistant", content: "", parts: payload }];
    const [ui] = storeToUiMessages(stored);
    expect(ui.parts).toEqual([{ type: "data-postings", id: "m7-card-0", data: payload }]);
    // The panel path a title click walks: resolve the same part, the row still carries its exact key.
    const content = resolveDetailContent([ui], { messageId: "m7", partId: "m7-card-0" });
    expect(content?.kind).toBe("postings");
    if (content?.kind === "postings") {
      expect(content.rows[0].source).toBe("Greenhouse");
      expect(content.rows[0].externalId).toBe("1432006520");
    }
  });
});
