import { describe, expect, it } from "vitest";
import { DataInsightSchema } from "@shared/insight";
import type { QueryResult } from "@shared/analytics";
import {
  buildComposedInsight,
  buildComposedSkeleton,
  buildInsight,
  buildModelHistory,
  buildSkeleton,
  chartTypeFor,
  chartTypeForShape,
  composedFollowups,
  emptyModelOutput,
  emptyPart,
  errorPart,
  refusalPart,
  toModelOutput,
} from "../../trigger/parts";
import { extractAssistantPersistence, persistAssistantTurn } from "../../trigger/persistence";
import type { Store } from "@shared/store";

// Synthetic query results mirroring the reference fixture's hand-computed rows (tests/fixtures), so the
// pure part-building is unit-testable without a ClickHouse client. The live 7/7 run lives in the
// integration suite.
function result(rows: Record<string, unknown>[], sampleN: number): QueryResult {
  return { sql: "SELECT 1", rows, meta: { sampleN, freshestAt: "2026-07-18 06:00:00" } };
}

// An error/refusal turn persists EMPTY content, and buildModelHistory
// drops empty rows - so an error turn immediately followed by a user follow-up used to rebuild as two
// CONSECUTIVE user messages, which Bedrock's strict role-alternation rejects. This pins that the rebuilt
// model input stays validly alternating (no two same-role messages adjacent) across that error->followup
// shape, WITHOUT restructuring persistence (the store still holds the empty error row).
describe("buildModelHistory keeps valid role alternation across a dropped error turn (018 review-fix)", () => {
  const alternates = (msgs: { role: string }[]) =>
    msgs.every((m, i) => i === 0 || m.role !== msgs[i - 1].role);

  it("an error turn (empty content) between two user turns does NOT leave consecutive user messages", () => {
    const rebuilt = buildModelHistory([
      { role: "user", content: "Who is hiring the most?" },
      { role: "assistant", content: "" }, // the errored turn - persisted empty, dropped by the filter
      { role: "user", content: "How many of those are in SF?" },
    ]);
    // Both user questions survive (nothing lost), and the sequence alternates for Bedrock.
    expect(rebuilt.map((m) => m.role)).toEqual(["user"]); // the two users coalesce into one alternation-safe turn
    expect(alternates(rebuilt)).toBe(true);
    expect(rebuilt[0].content).toContain("Who is hiring the most?");
    expect(rebuilt[0].content).toContain("How many of those are in SF?");
  });

  it("a normal alternating history is unchanged (no spurious coalescing)", () => {
    const rebuilt = buildModelHistory([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "q3" },
    ]);
    expect(rebuilt).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "q3" },
    ]);
    expect(alternates(rebuilt)).toBe(true);
  });
});

// With persistence now storing prose VERBATIM, buildModelHistory is the
// home that substitutes the code-derived verdict for a card turn's model-facing content - so the model
// still sees the honest verdict, never the model's own (possibly fabricated) prose, and never the error
// narration. Reads the persisted card off `parts`; a card-less turn keeps its prose.
describe("buildModelHistory substitutes the verdict for card turns (F8)", () => {
  it("hands the model the code-derived verdict for an insight-card turn, never the persisted prose", () => {
    const card = buildInsight({
      id: "m1",
      tool: "top_companies",
      params: {},
      result: result([{ company: "Google", count: 4 }], 10),
    });
    const rebuilt = buildModelHistory([
      { role: "user", content: "Who is hiring the most?" },
      { role: "assistant", content: "Apple and Meta are also ramping up hiring.", parts: card }, // verbatim
      { role: "user", content: "How many in SF?" },
    ]);
    expect(rebuilt).toEqual([
      { role: "user", content: "Who is hiring the most?" },
      { role: "assistant", content: card.verdict },
      { role: "user", content: "How many in SF?" },
    ]);
    expect(rebuilt[1].content).not.toContain("Apple"); // the fabricated prose never reaches the model
  });

  it("drops an error-card turn (no verdict) so the model never sees the error narration", () => {
    const rebuilt = buildModelHistory([
      { role: "user", content: "Median salary in SF?" },
      { role: "assistant", content: "Something went wrong - please try again.", parts: { kind: "system" } },
      { role: "user", content: "Who is hiring the most?" },
    ]);
    // the error narration is not model-facing; the surrounding users coalesce (alternation-safe)
    expect(rebuilt.map((m) => m.role)).toEqual(["user"]);
    expect(rebuilt[0].content.toLowerCase()).not.toContain("went wrong");
  });

  it("keeps a plain (card-less) assistant turn's prose verbatim for the model", () => {
    const rebuilt = buildModelHistory([
      { role: "user", content: "q1" },
      { role: "assistant", content: "Two words.", parts: null },
      { role: "user", content: "q2" },
    ]);
    expect(rebuilt).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "Two words." },
      { role: "user", content: "q2" },
    ]);
  });

  it("substitutes the verdict from an array (multi-card) payload, joining them", () => {
    const c1 = buildInsight({ id: "a", tool: "top_companies", params: {}, result: result([{ company: "Google", count: 4 }], 10) });
    const c2 = buildInsight({ id: "b", tool: "top_companies", params: {}, result: result([{ company: "Meta", count: 2 }], 10) });
    const rebuilt = buildModelHistory([
      { role: "user", content: "q1" },
      { role: "assistant", content: "some prose", parts: [c1, c2] },
    ]);
    expect(rebuilt[1].content).toBe(`${c1.verdict} ${c2.verdict}`);
  });

  // The test above compares against `card.verdict` - a value computed by the
  // SAME builder call under test, so a wrong-but-consistent verdict would still pass. This pins the
  // model-facing text against an INDEPENDENT literal (verdictFor's top_companies branch, trigger/parts.ts
  // line ~163: "${company} is hiring the most, with ${count} openings.") over a fixed two-turn history,
  // proving byte-identical model input for a card turn without relying on the code's own output as the
  // expectation.
  it("pins the model-facing verdict for a top_companies card to a known-good literal, not the persisted prose", () => {
    const card = buildInsight({
      id: "m1",
      tool: "top_companies",
      params: {},
      result: result([{ company: "Google", count: 4 }], 10),
    });
    const rebuilt = buildModelHistory([
      { role: "user", content: "Who is hiring the most?" },
      { role: "assistant", content: "Apple and Meta are also ramping up hiring.", parts: card }, // persisted verbatim prose
      { role: "user", content: "How many in SF?" },
    ]);
    expect(rebuilt).toEqual([
      { role: "user", content: "Who is hiring the most?" },
      { role: "assistant", content: "Google is hiring the most, with 4 openings." }, // independent literal
      { role: "user", content: "How many in SF?" },
    ]);
  });
});

// A strict-valid postings-card payload (PostingsSchema): the shape persisted for a listing turn. `mode` absent
// = the profile-fit card; `mode:"latest"` = a plain latest-list. Carries one valid ScoredPostingRow so the
// safeParse matches on realistic data, not an empty-rows shortcut.
function postingsPayload(total: number, mode?: "latest") {
  const row = {
    title: "Senior Software Engineer",
    company: "YouTube",
    city: "San Bruno",
    remote: false,
    salaryMin: 180000,
    salaryMax: 220000,
    experience: "senior",
    publishedAt: "2026-07-20",
    score: 0.9,
  };
  return { kind: "postings" as const, rows: [row], total, ...(mode ? { mode } : {}) };
}

// A postings/listing card matches PostingsSchema, NOT DataInsightSchema, so modelFacingContent used to return
// "" for it - buildModelHistory then DROPPED the whole turn and coalesced the two surrounding user questions
// into one. The model never saw the prior listing and re-ran the postings tool, persisting a SECOND postings
// card (the observed listing-only duplication). The fix summarizes a postings turn into a concise, code-derived
// sentence so the listing is visible. Nothing here keys on a company name - the fix is general.
describe("buildModelHistory makes a prior postings/listing turn visible to the model (postings-turn visibility fix)", () => {
  it("summarizes a profile-fit postings turn (mode absent) into a non-empty assistant message, not the prose", () => {
    const rebuilt = buildModelHistory([
      { role: "user", content: "Show me jobs that fit my profile" },
      { role: "assistant", content: "Here are some roles you might like.", parts: postingsPayload(42) },
      { role: "user", content: "What about remote ones?" },
    ]);
    expect(rebuilt).toEqual([
      { role: "user", content: "Show me jobs that fit my profile" },
      { role: "assistant", content: "Already listed job postings (42 matching the profile)." },
      { role: "user", content: "What about remote ones?" },
    ]);
    expect(rebuilt[1].content).not.toContain("might like"); // the model's own prose never reaches the model
  });

  it("summarizes a latest-list postings turn (mode 'latest') with the neutral, non-fit wording", () => {
    const rebuilt = buildModelHistory([
      { role: "user", content: "Latest jobs at YouTube" },
      { role: "assistant", content: "prose", parts: postingsPayload(9, "latest") },
    ]);
    expect(rebuilt[1].content).toBe("Already listed job postings (9 total), most recent first.");
    expect(rebuilt[1].content).not.toContain("profile"); // a plain latest-list is not a profile fit
  });

  // The exact defect scenario: a listing turn between two questions. Pre-fix, the assistant turn was dropped
  // and "Show me jobs at YouTube" + "What about ClickHouse?" coalesced into ONE user message, so the model
  // re-answered the YouTube listing. Post-fix the listing is a distinct assistant message and the questions
  // stay separate. General, not company-specific: the same holds for any (listing-turn, next-query) pair.
  it("keeps a postings turn as a DISTINCT assistant message so the surrounding user questions are not coalesced/re-asked", () => {
    const rebuilt = buildModelHistory([
      { role: "user", content: "Show me jobs at YouTube" },
      { role: "assistant", content: "Here are YouTube openings.", parts: postingsPayload(7, "latest") },
      { role: "user", content: "What about ClickHouse?" },
    ]);
    expect(rebuilt.map((m) => m.role)).toEqual(["user", "assistant", "user"]); // role-alternating, listing visible
    expect(rebuilt[1].content).toBe("Already listed job postings (7 total), most recent first.");
    expect(rebuilt[0].content).toBe("Show me jobs at YouTube");
    expect(rebuilt[2].content).toBe("What about ClickHouse?"); // NOT merged with the YouTube question
    expect(rebuilt[2].content).not.toContain("YouTube");
  });

  it("still hands the model the VERDICT for a chart/table card, and drops an unknown payload to '' (coalesced away)", () => {
    const chart = buildInsight({
      id: "c1",
      tool: "top_companies",
      params: {},
      result: result([{ company: "Google", count: 4 }], 10),
    });
    const rebuilt = buildModelHistory([
      { role: "user", content: "Who is hiring most?" },
      { role: "assistant", content: "prose", parts: chart }, // chart card -> its verdict (path unchanged)
      { role: "user", content: "First unknown-payload probe" },
      { role: "assistant", content: "prose", parts: { kind: "mystery" } }, // unknown -> "" -> dropped
      { role: "user", content: "Second unknown-payload probe" },
    ]);
    expect(rebuilt[1].content).toBe(chart.verdict); // DataInsight path untouched
    // the unknown-payload assistant row is dropped, so its two surrounding users coalesce (proving "")
    expect(rebuilt.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(rebuilt[2].content).toContain("First unknown-payload probe");
    expect(rebuilt[2].content).toContain("Second unknown-payload probe");
  });

  it("yields non-empty text for a turn carrying BOTH a chart and a postings card (verdict + summary joined)", () => {
    const chart = buildInsight({
      id: "c1",
      tool: "top_companies",
      params: {},
      result: result([{ company: "Google", count: 4 }], 10),
    });
    const rebuilt = buildModelHistory([
      { role: "user", content: "q" },
      { role: "assistant", content: "prose", parts: [chart, postingsPayload(5, "latest")] },
    ]);
    expect(rebuilt[1].content).toBe(`${chart.verdict} Already listed job postings (5 total), most recent first.`);
  });
});

describe("chartTypeFor maps each catalog tool to its designated visual (AC-11)", () => {
  it("pins the visuals from the brief case table", () => {
    expect(chartTypeFor("salary_distribution")).toBe("histogram");
    expect(chartTypeFor("salary_compare")).toBe("bars");
    expect(chartTypeFor("postings_trend")).toBe("trend");
    expect(chartTypeFor("top_companies")).toBe("bars");
    expect(chartTypeFor("share_split")).toBe("donut");
    expect(chartTypeFor("latest_postings")).toBe("table");
  });
});

describe("buildInsight produces a strict-valid data-insight with the headline value in the verdict", () => {
  it("salary_distribution -> histogram, median in the verdict", () => {
    const r = result(
      [
        { bucket: 160000, count: 1, median: 180000 },
        { bucket: 180000, count: 1, median: 180000 },
        { bucket: 200000, count: 1, median: 180000 },
      ],
      3,
    );
    const insight = buildInsight({ id: "m1", tool: "salary_distribution", params: {}, result: r });
    expect(() => DataInsightSchema.parse(insight)).not.toThrow();
    expect(insight.kind).toBe("chart");
    if (insight.kind === "chart") expect(insight.chartType).toBe("histogram");
    expect(insight.verdict).toContain("180000");
    expect(insight.meta).toEqual({ sql: "SELECT 1", sampleN: 3, updatedAt: "2026-07-18 06:00:00" });
  });

  it("salary_compare -> bars, winning city + median in the verdict", () => {
    const r = result(
      [
        { city: "San Francisco", median: 180000, n: 3 },
        { city: "Los Angeles", median: 140000, n: 3 },
      ],
      6,
    );
    const insight = buildInsight({ id: "m2", tool: "salary_compare", params: {}, result: r });
    expect(insight.verdict).toContain("San Francisco");
    expect(insight.verdict).toContain("180000");
    if (insight.kind === "chart") expect(insight.chartType).toBe("bars");
  });

  // Honesty nit: with only one city row (the other city had no salaried postings) there was no
  // comparison, so the verdict must NOT claim one city "pays more" than an absent other.
  it("salary_compare stays honest on a single city row - no false 'pays more' comparison", () => {
    const r = result([{ city: "San Francisco", median: 180000, n: 3 }], 3);
    const insight = buildInsight({ id: "m2b", tool: "salary_compare", params: {}, result: r });
    expect(insight.verdict).not.toContain("pays more");
    expect(insight.verdict).toContain("San Francisco");
    expect(insight.verdict).toContain("180000");
  });

  it("postings_trend -> trend, total count in the verdict", () => {
    const r = result(
      [
        { day: "2026-07-16", count: 2 },
        { day: "2026-07-17", count: 2 },
        { day: "2026-07-18", count: 6 },
      ],
      10,
    );
    const insight = buildInsight({ id: "m3", tool: "postings_trend", params: { days: 7 }, result: r });
    expect(insight.verdict).toContain("10");
    if (insight.kind === "chart") expect(insight.chartType).toBe("trend");
  });

  it("top_companies -> bars, top company + count in the verdict", () => {
    const r = result([{ company: "Google", count: 4 }, { company: "Meta", count: 2 }], 10);
    const insight = buildInsight({ id: "m4", tool: "top_companies", params: {}, result: r });
    expect(insight.verdict).toContain("Google");
    expect(insight.verdict).toContain("4");
  });

  it("share_split -> donut, dominant label + count in the verdict", () => {
    const r = result([{ label: "Senior", count: 5 }, { label: "Junior", count: 3 }, { label: "Staff", count: 2 }], 10);
    const insight = buildInsight({ id: "m5", tool: "share_split", params: { dimension: "experience" }, result: r });
    expect(insight.verdict).toContain("Senior");
    expect(insight.verdict).toContain("5");
    if (insight.kind === "chart") expect(insight.chartType).toBe("donut");
  });

  it("latest_postings -> table (kind table, no chartType), count + latest title in the verdict", () => {
    const r = result(
      [
        { title: "Senior Software Engineer", company: "Google" },
        { title: "Data Scientist", company: "Google" },
        { title: "Senior Engineer", company: "Google" },
      ],
      3,
    );
    const insight = buildInsight({ id: "m6", tool: "latest_postings", params: {}, result: r });
    expect(insight.kind).toBe("table");
    expect(insight.verdict).toContain("3");
    expect(insight.verdict).toContain("Senior Software Engineer");
  });

  it("stays honest on empty results - a no-data verdict, still strict-valid", () => {
    const insight = buildInsight({ id: "m7", tool: "salary_distribution", params: {}, result: result([], 0) });
    expect(() => DataInsightSchema.parse(insight)).not.toThrow();
    if (insight.kind === "chart") expect(insight.series).toEqual([]);
  });

  // The open-set flag threads from the analytics result through buildInsight into the insight
  // meta, so InsightCard can render "N open postings" for a current-state read.
  it("carries the openSet flag into the insight meta for a current-state result", () => {
    const r: QueryResult = {
      sql: "SELECT 1",
      rows: [{ company: "Google", count: 4 }],
      meta: { sampleN: 10, freshestAt: "2026-07-18 06:00:00", openSet: true },
    };
    const insight = buildInsight({ id: "os1", tool: "top_companies", params: {}, result: r });
    expect(insight.meta.openSet).toBe(true);
    expect(() => DataInsightSchema.parse(insight)).not.toThrow();
  });

  // A full-history result has no openSet on its meta - buildInsight must NOT default-inject the key
  // (optionality is the compatibility contract for old persisted payloads).
  it("omits openSet from the insight meta for a full-history result", () => {
    const insight = buildInsight({
      id: "os2",
      tool: "postings_trend",
      params: { days: 7 },
      result: result([{ day: "2026-07-18", count: 3 }], 3),
    });
    expect(insight.meta).not.toHaveProperty("openSet");
  });
});

describe("buildSkeleton is the loading part written before the tool returns", () => {
  it("carries the visual and a loading state, no rows", () => {
    const skel = buildSkeleton("m1", "salary_distribution");
    expect(skel).toMatchObject({ id: "m1", kind: "chart", chartType: "histogram", status: "loading" });
    const table = buildSkeleton("m6", "latest_postings");
    expect(table).toMatchObject({ id: "m6", kind: "table", status: "loading" });
  });
});

describe("emptyPart clears a tool's skeleton on a 0-row result (empty = plain mode, no card)", () => {
  it("supersedes the skeleton in place and carries no insight payload", () => {
    const part = emptyPart("call-1");
    expect(part).toEqual({ type: "data-insight", id: "call-1", data: { status: "empty" } });
    // It must NOT classify as a valid insight (would render an empty card) ...
    expect(DataInsightSchema.safeParse(part.data).success).toBe(false);
    // ... nor as the loading skeleton (would render a stuck spinner).
    expect((part.data as { status: string }).status).not.toBe("loading");
  });

  it("emptyModelOutput signals the model to answer in plain prose, not a chart", () => {
    const out = emptyModelOutput("salary_distribution");
    expect(out.empty).toBe(true);
    expect(out.note.toLowerCase()).toContain("plain");
  });
});

describe("toModelOutput is compact - the model sees the verdict + labels, not the raw rows", () => {
  it("returns the verdict, sample size, row count, and entity labels only", () => {
    const r = result([{ company: "Google", count: 4 }, { company: "YouTube", count: 2 }], 10);
    const insight = buildInsight({ id: "m4", tool: "top_companies", params: {}, result: r });
    const out = toModelOutput(insight);
    expect(out.verdict).toBe(insight.verdict);
    expect(out.sampleN).toBe(10);
    expect(out).not.toHaveProperty("series");
    // The row LABELS (entities) ground the model's chip/follow-up reasoning.
    expect(out.labels).toEqual(["Google", "YouTube"]);
  });

  it("coalesces a null/empty entity label to 'unspecified' (never a bare null)", () => {
    const r = result([{ city: null, count: 5 }, { city: "", count: 3 }], 8);
    const insight = buildComposedInsight({
      id: "m4b",
      params: { measures: ["count"], dimensions: ["city"] },
      chartType: "bars",
      result: r,
    });
    expect(toModelOutput(insight).labels).toEqual(["unspecified", "unspecified"]);
  });
});

describe("errorPart carries the taxonomy kind for the UI to copy (AC-10)", () => {
  it("emits system vs unanswerable kinds", () => {
    expect(errorPart("m1", "system")).toEqual({ type: "data-error", id: "m1", data: { kind: "system" } });
    expect(errorPart("m1", "unanswerable")).toEqual({
      type: "data-error",
      id: "m1",
      data: { kind: "unanswerable" },
    });
  });
});

describe("refusalPart carries the guard reason for the UI to render like an action refusal (AC-15/AC-20)", () => {
  it("emits guest_cap vs daily_budget reasons on a distinct data-refusal part", () => {
    expect(refusalPart("m1", "guest_cap")).toEqual({
      type: "data-refusal",
      id: "m1",
      data: { reason: "guest_cap" },
    });
    expect(refusalPart("m1", "daily_budget")).toEqual({
      type: "data-refusal",
      id: "m1",
      data: { reason: "daily_budget" },
    });
  });

  // The input-size backstop reuses the same data-refusal part so an over-length turn refused at the
  // agent-run ingress renders as a polite notice, identically to a cap/budget refusal.
  it("emits the too_long reason on the same data-refusal part", () => {
    expect(refusalPart("m1", "too_long")).toEqual({
      type: "data-refusal",
      id: "m1",
      data: { reason: "too_long" },
    });
  });
});

describe("extractAssistantPersistence pulls the persisted content + card payload (AC-13)", () => {
  // Persistence stores what HAPPENED - the model's prose VERBATIM plus the
  // card payload. The verdict substitution moves to buildModelHistory (model input) and the render layer
  // suppresses the prose when a card renders, so Postgres stays a faithful record with no rewritten history.
  it("persists the model's prose VERBATIM alongside the card (no verdict substitution at persist)", () => {
    const insight = buildInsight({
      id: "i1",
      tool: "top_companies",
      params: {},
      result: result([{ company: "Google", count: 4 }], 10),
    });
    const message = {
      role: "assistant",
      parts: [
        { type: "text", text: "Apple, Amazon, and Meta are also hiring aggressively right now." },
        { type: "data-insight", id: "i1", data: insight },
      ],
    };
    const { content, parts } = extractAssistantPersistence(message);
    expect(content).toBe("Apple, Amazon, and Meta are also hiring aggressively right now."); // verbatim
    expect(content).not.toBe(insight.verdict); // no longer rewritten to the verdict at persist
    expect(parts).toEqual(insight);
  });

  it("keeps only the final (filled) part when a skeleton shares its id", () => {
    const insight = buildInsight({
      id: "i1",
      tool: "top_companies",
      params: {},
      result: result([{ company: "Google", count: 4 }], 10),
    });
    const message = {
      role: "assistant",
      parts: [
        { type: "data-insight", id: "i1", data: buildSkeleton("i1", "top_companies") },
        { type: "data-insight", id: "i1", data: insight },
      ],
    };
    const { parts } = extractAssistantPersistence(message);
    expect(parts).toEqual(insight);
  });

  it("returns null parts for a plain (text-only) answer", () => {
    const message = { role: "assistant", parts: [{ type: "text", text: "Two words." }] };
    const { content, parts } = extractAssistantPersistence(message);
    expect(content).toBe("Two words.");
    expect(parts).toBeNull();
  });

  // Regression: on a tool failure the tool emits a loading skeleton then a data-error
  // under the SAME id. The persisted card must be the ERROR marker, never the stuck loading skeleton
  // (which would resume as a spinner that never resolves and lose the error).
  it("persists the error marker, not the loading skeleton, when a tool fails", () => {
    const message = {
      role: "assistant",
      parts: [
        { type: "data-insight", id: "call-1", data: buildSkeleton("call-1", "salary_distribution") },
        { type: "data-error", id: "call-1", data: { kind: "system" } },
      ],
    };
    const { parts } = extractAssistantPersistence(message);
    expect(parts).toEqual({ kind: "system" });
  });

  // An error-card turn persists its prose VERBATIM too (the store is a faithful record). The single
  // answer surface is enforced downstream - the render layer suppresses the prose when the error card
  // renders, and buildModelHistory drops it from the model input - never at persist.
  it("persists the accompanying prose verbatim when a turn ends in a system error card", () => {
    const message = {
      role: "assistant",
      parts: [
        { type: "text", text: "Something went wrong on my side - please try again." },
        { type: "data-insight", id: "call-1", data: buildSkeleton("call-1", "top_companies") },
        { type: "data-error", id: "call-1", data: { kind: "system" } },
      ],
    };
    const { content, parts } = extractAssistantPersistence(message);
    expect(content).toBe("Something went wrong on my side - please try again."); // verbatim, not ""
    expect(parts).toEqual({ kind: "system" });
  });

  // Defensive: a skeleton that was never superseded (neither filled nor errored) is dropped rather
  // than persisted, so resume never restores a stuck spinner.
  it("drops an orphan loading skeleton rather than persisting it", () => {
    const message = {
      role: "assistant",
      parts: [{ type: "data-insight", id: "x", data: buildSkeleton("x", "top_companies") }],
    };
    expect(extractAssistantPersistence(message).parts).toBeNull();
  });

  // A 0-row tool result emits a skeleton then an empty marker under the same id. The empty
  // marker supersedes the skeleton and is NOT persistable, so the turn persists no card (plain-prose
  // answer) - never a stuck skeleton nor an empty "No data" card.
  it("drops a skeleton superseded by an empty marker - the empty turn persists no card", () => {
    const message = {
      role: "assistant",
      parts: [
        { type: "text", text: "I could not find any matching postings." },
        { type: "data-insight", id: "call-1", data: buildSkeleton("call-1", "salary_distribution") },
        { type: "data-insight", id: "call-1", data: emptyPart("call-1").data },
      ],
    };
    const { content, parts } = extractAssistantPersistence(message);
    expect(content).toBe("I could not find any matching postings.");
    expect(parts).toBeNull();
  });

  // The one-part-per-answer invariant across an internal retry: a first tool call that matched nothing
  // (skeleton -> empty) followed by a retry that landed rows (skeleton -> insight) persists EXACTLY the
  // one filled insight - the empty first attempt leaves no dangling card.
  it("keeps only the filled insight when an empty attempt precedes a successful retry", () => {
    const insight = buildInsight({
      id: "call-2",
      tool: "salary_distribution",
      params: {},
      result: result([{ bucket: 160000, count: 3, median: 180000 }], 3),
    });
    const message = {
      role: "assistant",
      parts: [
        { type: "data-insight", id: "call-1", data: buildSkeleton("call-1", "salary_distribution") },
        { type: "data-insight", id: "call-1", data: emptyPart("call-1").data },
        { type: "data-insight", id: "call-2", data: buildSkeleton("call-2", "salary_distribution") },
        { type: "data-insight", id: "call-2", data: insight },
      ],
    };
    const { parts } = extractAssistantPersistence(message);
    expect(parts).toEqual(insight);
  });

  // A guard refusal (cap/budget) streamed by the agent backstop persists as its marker, so a returning
  // guest still sees the polite limit notice rather than an empty assistant turn.
  it("persists a refusal marker from the agent backstop", () => {
    const message = {
      role: "assistant",
      parts: [{ type: "data-refusal", id: "r1", data: { reason: "guest_cap" } }],
    };
    expect(extractAssistantPersistence(message).parts).toEqual({ reason: "guest_cap" });
  });

  it("persists the too_long refusal marker so the notice survives resume", () => {
    const message = {
      role: "assistant",
      parts: [{ type: "data-refusal", id: "r1", data: { reason: "too_long" } }],
    };
    expect(extractAssistantPersistence(message).parts).toEqual({ reason: "too_long" });
  });
});

// Live defect (2026-07-21): a turn whose every tool call timed out completed with NO final text, and
// the empty assistant row it persisted (a) lost the streamed prose on reload and (b) would make the
// run's redelivery guard read the turn as "already answered" - blocking a legitimate Retry. So an
// empty-text turn persists NOTHING: the tail stays the unanswered user row and resume renders the
// retry state.
describe("Should_PersistNoAssistantRow_When_TurnFinalTextEmpty (persistAssistantTurn)", () => {
  function recordingStore() {
    const appended: Array<{ role: string; content: string; parts: unknown }> = [];
    const store = {
      appendMessage: async (_conversationId: string, role: string, content: string, parts: unknown) => {
        appended.push({ role, content, parts });
        return { role, content, parts } as never;
      },
    } as unknown as Store;
    return { store, appended };
  }

  it("skips the insert when the tool-failure turn produced no text and no persistable card", async () => {
    const { store, appended } = recordingStore();
    // The live shape: the skeleton was never superseded (every query timed out), so extraction yields
    // content "" and a null payload - nothing worth a row.
    const responseMessage = {
      role: "assistant",
      parts: [{ type: "data-insight", id: "call-1", data: buildSkeleton("call-1", "top_companies") }],
    };
    await persistAssistantTurn(store, { conversationId: "c1", responseMessage });
    expect(appended).toEqual([]);
  });

  it("skips the insert when the final text is whitespace only", async () => {
    const { store, appended } = recordingStore();
    const responseMessage = { role: "assistant", parts: [{ type: "text", text: "  \n " }] };
    await persistAssistantTurn(store, { conversationId: "c1", responseMessage });
    expect(appended).toEqual([]);
  });

  it("skips the insert for an error-card turn (empty content) so Retry never reads as a duplicate", async () => {
    const { store, appended } = recordingStore();
    // An error card persists empty content; a persisted assistant tail would make the redelivery
    // guard skip the Retry regenerate (same envelope, no new user turn) as a duplicate.
    const responseMessage = {
      role: "assistant",
      parts: [{ type: "data-error", id: "call-1", data: { kind: "system" } }],
    };
    await persistAssistantTurn(store, { conversationId: "c1", responseMessage });
    expect(appended).toEqual([]);
  });

  it("still persists a normal answered turn (a real answer card) with its card payload", async () => {
    const { store, appended } = recordingStore();
    const insight = buildInsight({
      id: "i1",
      tool: "top_companies",
      params: {},
      result: result([{ company: "Google", count: 4 }], 10),
    });
    const responseMessage = {
      role: "assistant",
      parts: [{ type: "data-insight", id: "i1", data: insight }],
    };
    await persistAssistantTurn(store, { conversationId: "c1", responseMessage });
    // Prose is persisted VERBATIM (text parts only), so a card-only turn stores content "" - the verdict
    // substitution is buildModelHistory's job, not persistence's - with the full insight as the answer card.
    expect(appended).toEqual([{ role: "assistant", content: "", parts: insight }]);
  });
});

// ---- query_postings composed path (parallel to the TemplateName-keyed template path) --------------

// chartTypeForShape is the deterministic server-side fallback. The agent proposes a chartType
// (the RAW pick, recorded by the tool); this returns the SERVED type - the agent's pick when it fits
// the data shape, else the shape's fit type. Case table + override behavior.
describe("Should_FallBackToFitChartType_When_RawPickUnfit (chartTypeForShape, AC-4)", () => {
  it("a time bucket is always a trend (any non-trend pick is overridden)", () => {
    expect(chartTypeForShape({ dimensions: [], bucket: "week" }, "bars", 5)).toBe("trend");
    expect(chartTypeForShape({ dimensions: [], bucket: "day" }, "donut", 3)).toBe("trend");
    expect(chartTypeForShape({ dimensions: [], bucket: "month" }, "trend", 12)).toBe("trend");
  });

  it("a single categorical dimension + count is bars by default", () => {
    expect(chartTypeForShape({ dimensions: ["company"] }, "bars", 10)).toBe("bars");
    expect(chartTypeForShape({ dimensions: ["title"] }, "bars", 20)).toBe("bars");
  });

  it("honors a donut pick only for a readable share-of-whole (<= 6 slices) of a COUNT measure", () => {
    expect(chartTypeForShape({ dimensions: ["experience_level"], measures: ["count"] }, "donut", 4)).toBe("donut");
    expect(chartTypeForShape({ dimensions: ["location_kind"], measures: ["count"] }, "donut", 6)).toBe("donut");
    // > 6 slices: a donut is unreadable, so the unfit pick is corrected to bars.
    expect(chartTypeForShape({ dimensions: ["company"], measures: ["count"] }, "donut", 7)).toBe("bars");
    expect(chartTypeForShape({ dimensions: ["company"], measures: ["count"] }, "donut", 12)).toBe("bars");
  });

  // A donut is a share of a whole, meaningful only for a COUNT/share measure.
  // A single-dimension NON-count result (median/p25/p75) NEVER renders as a donut - it falls back to
  // bars even at <= 6 slices. A 2-measure result (count + a salary) is not a pure share either -> bars.
  it("restricts donut to a count measure - a non-count share-of-whole falls back to bars (ruling 29)", () => {
    expect(chartTypeForShape({ dimensions: ["experience_level"], measures: ["median_salary"] }, "donut", 4)).toBe("bars");
    expect(chartTypeForShape({ dimensions: ["location_kind"], measures: ["p25_salary"] }, "donut", 3)).toBe("bars");
  });

  // Two measures on one categorical axis have no shared scale (a count next to a salary),
  // so a single-dimension 2-measure result routes to a TABLE, never grouped shared-axis bars.
  it("routes a two-measure single-dimension result to a table (no shared-axis nonsense)", () => {
    expect(chartTypeForShape({ dimensions: ["experience_level"], measures: ["count", "median_salary"] }, "donut", 4)).toBe("table");
    expect(chartTypeForShape({ dimensions: ["experience_level"], measures: ["p25_salary", "p75_salary"] }, "bars", 4)).toBe("table");
  });

  // A trend needs >= 3 points to read as a line; fewer routes to a table.
  it("routes a time bucket with fewer than 3 points to a table (a trend needs >= 3 points)", () => {
    expect(chartTypeForShape({ dimensions: [], bucket: "month" }, "trend", 2)).toBe("table");
    expect(chartTypeForShape({ dimensions: [], bucket: "month" }, "trend", 1)).toBe("table");
    expect(chartTypeForShape({ dimensions: [], bucket: "month" }, "trend", 3)).toBe("trend");
  });

  // A donut is honest only for a TRUE whole - its slices must sum to the sample. A
  // truncated top-N (slices summing below sampleN) falls back to bars even at <= 6 slices.
  it("serves a donut only when the slices sum to the sample (a true whole), else bars", () => {
    expect(
      chartTypeForShape({ dimensions: ["location_kind"], measures: ["count"] }, "donut", 3, { sliceSum: 10, sampleN: 10 }),
    ).toBe("donut");
    expect(
      chartTypeForShape({ dimensions: ["company"], measures: ["count"] }, "donut", 5, { sliceSum: 40, sampleN: 3488 }),
    ).toBe("bars");
  });

  // donutIsWhole uses a strict `sliceSum === sampleN` equality; pin the exact boundary - slices summing
  // to EXACTLY the sample (a true whole) vs one short of it - so an off-by-one wholeness check is caught.
  it("pins the donut wholeness boundary: slices == sampleN is a whole, one short of it is not", () => {
    expect(
      chartTypeForShape({ dimensions: ["experience_level"], measures: ["count"] }, "donut", 3, { sliceSum: 10, sampleN: 10 }),
    ).toBe("donut");
    expect(
      chartTypeForShape({ dimensions: ["experience_level"], measures: ["count"] }, "donut", 3, { sliceSum: 9, sampleN: 10 }),
    ).toBe("bars");
  });

  it("corrects an unfit pick on a single-dimension shape to bars", () => {
    expect(chartTypeForShape({ dimensions: ["company"] }, "trend", 5)).toBe("bars");
    expect(chartTypeForShape({ dimensions: ["title"] }, "histogram", 5)).toBe("bars");
    expect(chartTypeForShape({ dimensions: ["company"] }, "table", 5)).toBe("bars");
  });

  it("two grouping keys (2 dims, or a dim + bucket) are an entity-ish table", () => {
    expect(chartTypeForShape({ dimensions: ["company", "city"] }, "bars", 5)).toBe("table");
    expect(chartTypeForShape({ dimensions: ["company"], bucket: "month" }, "trend", 5)).toBe("table");
  });

  it("a bare aggregate (no dimension, no bucket) is a single-row table", () => {
    expect(chartTypeForShape({ dimensions: [] }, "bars", 1)).toBe("table");
  });
});

describe("buildComposedSkeleton builds the loading part from the agent's chartType pick", () => {
  it("a chart pick -> chart skeleton with that chartType", () => {
    expect(buildComposedSkeleton("c1", "bars")).toEqual({
      id: "c1",
      kind: "chart",
      chartType: "bars",
      status: "loading",
    });
    expect(buildComposedSkeleton("c2", "donut")).toMatchObject({ kind: "chart", chartType: "donut" });
  });

  it("a table pick -> table skeleton, no chartType", () => {
    expect(buildComposedSkeleton("c3", "table")).toEqual({ id: "c3", kind: "table", status: "loading" });
  });
});

describe("buildComposedInsight builds a strict-valid insight for the seventh tool (no faked template)", () => {
  const composedResult = (
    rows: Record<string, unknown>[],
    sampleN: number,
    openSet = true,
  ): QueryResult => ({
    sql: "SELECT company, count() AS count FROM postings FINAL WHERE ...",
    rows,
    meta: { sampleN, freshestAt: "2026-07-18 06:00:00", ...(openSet ? { openSet: true } : {}) },
  });

  it("count by company (bars): leads with the top company + its count, threads meta + openSet", () => {
    const result = composedResult(
      [
        { company: "Google", count: 4 },
        { company: "Meta", count: 2 },
        { company: "Amazon", count: 2 },
      ],
      8,
    );
    const insight = buildComposedInsight({
      id: "q1",
      params: { measures: ["count"], dimensions: ["company"] },
      chartType: "bars",
      result,
    });
    expect(() => DataInsightSchema.parse(insight)).not.toThrow();
    expect(insight.kind).toBe("chart");
    if (insight.kind === "chart") {
      expect(insight.chartType).toBe("bars");
      expect(insight.series).toEqual(result.rows);
    }
    expect(insight.verdict).toContain("Google");
    expect(insight.verdict).toContain("4");
    expect(insight.meta).toMatchObject({ sampleN: 8, updatedAt: "2026-07-18 06:00:00", openSet: true });
  });

  it("a share-of-whole served as a donut is a strict-valid chart insight", () => {
    const insight = buildComposedInsight({
      id: "q2",
      params: { measures: ["count"], dimensions: ["experience_level"] },
      chartType: "donut",
      result: composedResult([{ experience_level: "Senior", count: 5 }, { experience_level: "Junior", count: 3 }], 8),
    });
    expect(insight.kind).toBe("chart");
    if (insight.kind === "chart") expect(insight.chartType).toBe("donut");
    expect(() => DataInsightSchema.parse(insight)).not.toThrow();
  });

  it("an entity-ish two-dimension result served as a table carries rows, not a series", () => {
    const insight = buildComposedInsight({
      id: "q3",
      params: { measures: ["count"], dimensions: ["company", "city"] },
      chartType: "table",
      result: composedResult([{ company: "Google", city: "San Francisco", count: 3 }], 3),
    });
    expect(insight.kind).toBe("table");
    if (insight.kind === "table") expect(insight.rows).toHaveLength(1);
    expect(() => DataInsightSchema.parse(insight)).not.toThrow();
  });

  it("a salary measure by dimension names the leader with its value", () => {
    const insight = buildComposedInsight({
      id: "q4",
      params: { measures: ["median_salary"], dimensions: ["experience_level"] },
      chartType: "bars",
      result: composedResult([{ experience_level: "Staff", median_salary: 200000 }, { experience_level: "Senior", median_salary: 175000 }], 8),
    });
    expect(insight.verdict).toContain("Staff");
    expect(insight.verdict).toContain("200000");
  });

  it("omits openSet from meta for a full-history (windowed) composed result", () => {
    const insight = buildComposedInsight({
      id: "q5",
      params: { measures: ["count"], bucket: "week", days: 30 },
      chartType: "trend",
      result: composedResult([{ bucket: "2026-07-06", count: 4 }, { bucket: "2026-07-13", count: 6 }], 10, false),
    });
    expect(insight.meta).not.toHaveProperty("openSet");
    // A trend leads with the total, the honest headline for a time series.
    expect(insight.verdict).toContain("10");
  });

  // A bare salary aggregate (no dimension, no bucket) - the branch distinct from both the
  // ranked-leader and the bucketed-range phrasing.
  it("a bare salary aggregate (no dimension, no bucket) states the single value plainly", () => {
    const insight = buildComposedInsight({
      id: "q7",
      params: { measures: ["median_salary"] },
      chartType: "table",
      result: composedResult([{ median_salary: 165000 }], 40),
    });
    expect(insight.verdict).toContain("165000");
    expect(insight.verdict.toLowerCase()).toContain("median salary");
  });

  // A bucketed (time-series) salary measure must report the observed range, never a single leader
  // (there is no dimension to rank by).
  it("a bucketed salary measure reports the observed range, not a leader", () => {
    const insight = buildComposedInsight({
      id: "q8",
      params: { measures: ["median_salary"], bucket: "month" },
      chartType: "trend",
      result: composedResult(
        [{ bucket: "2026-05-01", median_salary: 150000 }, { bucket: "2026-06-01", median_salary: 170000 }],
        20,
      ),
    });
    expect(insight.verdict).toContain("150000");
    expect(insight.verdict).toContain("170000");
  });

  // A 2-dimension cross-tab's top ROW is one cell, NOT the group leader - a group's other rows can sum
  // higher (Meta's single row of 6 outranks Google's 5 and 3, but Google's true total of 8 exceeds 6).
  // The verdict must report the total, never crown rows[0].
  it("does NOT name a false leader for a 2-dimension cross-tab (honesty: no superlative across a group-by pair)", () => {
    const insight = buildComposedInsight({
      id: "q6",
      params: { measures: ["count"], dimensions: ["company", "city"] },
      chartType: "table",
      result: composedResult(
        [
          { company: "Meta", city: "San Francisco", count: 6 },
          { company: "Google", city: "New York", count: 5 },
          { company: "Google", city: "San Francisco", count: 3 },
        ],
        14,
      ),
    });
    expect(insight.verdict).not.toContain("Meta leads");
    expect(insight.verdict).toContain("14");
  });

  // ROUND-2 REGRESSION (honesty): the agent may request an ASCENDING sort - the natural pick for
  // "which city has the FEWEST / pays the LEAST" - so the executor returns rows in ascending order and
  // rows[0] is the LOWEST, not the leader. The verdict must verify the extreme FROM the rows (never
  // assume the default measure-desc sort produced rows[0]): it must name the honest extreme (the lowest,
  // which is exactly what the user asked for) and must NEVER claim rows[0] "leads" or is "highest".
  it("count with sort dir:asc names the FEWEST, never a false 'leads' (rows[0] is the minimum)", () => {
    const insight = buildComposedInsight({
      id: "q9",
      params: { measures: ["count"], dimensions: ["city"], sort: { by: "count", dir: "asc" } },
      chartType: "bars",
      result: composedResult(
        [
          { city: "Akron", count: 1 },
          { city: "Austin", count: 40 },
          { city: "New York", count: 5000 },
        ],
        5041,
      ),
    });
    expect(insight.verdict).not.toContain("leads");
    expect(insight.verdict.toLowerCase()).not.toContain("highest");
    expect(insight.verdict).toContain("Akron"); // rows[0], the genuine minimum, is the honest headline
    expect(insight.verdict.toLowerCase()).toContain("fewest");
    expect(insight.verdict).not.toContain("New York"); // the real max is NOT named as the leader
  });

  it("a salary measure with sort dir:asc names the LOWEST, never a false 'highest'", () => {
    const insight = buildComposedInsight({
      id: "q10",
      params: {
        measures: ["median_salary"],
        dimensions: ["city"],
        sort: { by: "median_salary", dir: "asc" },
      },
      chartType: "bars",
      result: composedResult(
        [
          { city: "Detroit", median_salary: 60000 },
          { city: "Austin", median_salary: 130000 },
          { city: "San Francisco", median_salary: 220000 },
        ],
        30,
      ),
    });
    expect(insight.verdict.toLowerCase()).not.toContain("highest");
    expect(insight.verdict).not.toContain("leads");
    expect(insight.verdict).toContain("Detroit"); // rows[0], the genuine minimum
    expect(insight.verdict.toLowerCase()).toContain("lowest");
    expect(insight.verdict).toContain("60000");
    expect(insight.verdict).not.toContain("San Francisco"); // the real max is NOT named as the leader
  });
});

// sampleN (the whole) is the ONE denominator every verdict shows, never the sum of the
// shown rows - a top-N LIMIT truncates that sum below the true total, and the source line shows sampleN,
// so the two would disagree. These pin the verdict "of N" to sampleN when the shown rows sum LESS.
describe("Strand 1: sampleN is the sole denominator (verdict matches the source line)", () => {
  const truncated = (
    rows: Record<string, unknown>[],
    sampleN: number,
  ): QueryResult => ({ sql: "SELECT 1", rows, meta: { sampleN, freshestAt: "2026-07-18 06:00:00", openSet: true } });

  it("composed count-ranked names the leader over sampleN, not the sum of the shown top-N", () => {
    // 20 titles shown summing to 300, but 3,257 postings total (many titles below the LIMIT).
    const insight = buildComposedInsight({
      id: "d1",
      params: { measures: ["count"], dimensions: ["company"] },
      chartType: "bars",
      result: truncated([{ company: "Google", count: 200 }, { company: "Meta", count: 100 }], 3257),
    });
    expect(insight.verdict).toContain("of 3257");
    expect(insight.verdict).not.toContain("of 300");
  });

  it("composed non-ranked count totals sampleN, not the shown sum", () => {
    const insight = buildComposedInsight({
      id: "d2",
      params: { measures: ["count"], dimensions: ["company", "city"] },
      chartType: "table",
      result: truncated([{ company: "Google", city: "NYC", count: 50 }], 3488),
    });
    expect(insight.verdict).toContain("3488 postings in total");
  });

  it("template share_split uses sampleN as the share base, not the sum of the shown slices", () => {
    const insight = buildInsight({
      id: "d3",
      tool: "share_split",
      params: { dimension: "experience" },
      result: truncated([{ label: "Senior", count: 40 }, { label: "Junior", count: 30 }], 3488),
    });
    // "of 3488", never "of 70" (the shown slices) - matches the source line's sampleN.
    expect(insight.verdict).toContain("of 3488");
    expect(insight.verdict).not.toContain("of 70");
  });

  it("template postings_trend totals sampleN, not the sum of the shown (LIMITed) day buckets", () => {
    const insight = buildInsight({
      id: "d4",
      tool: "postings_trend",
      params: { days: 3650 },
      result: { sql: "SELECT 1", rows: [{ day: "2026-07-20", count: 9 }], meta: { sampleN: 3315, freshestAt: "2026-07-18 06:00:00" } },
    });
    expect(insight.verdict).toContain("3315 new postings");
  });

  it("composed range names it as the span across the shown rows, not an implied full-corpus range", () => {
    const insight = buildComposedInsight({
      id: "d5",
      params: { measures: ["median_salary"], bucket: "month" },
      chartType: "trend",
      result: truncated([{ bucket: "2026-05-01", median_salary: 150000 }, { bucket: "2026-06-01", median_salary: 170000 }], 900),
    });
    expect(insight.verdict).toContain("across the 2 shown");
  });
});

// Signal-quality gates - fragmentation, honest ties, currency threading, and the
// template-side visual corrections (min trend points, donut only for a true whole).
describe("Strand 3: signal-quality gates", () => {
  const composed = (
    rows: Record<string, unknown>[],
    sampleN: number,
    extra: Partial<QueryResult["meta"]> = {},
  ): QueryResult => ({ sql: "SELECT 1", rows, meta: { sampleN, freshestAt: "2026-07-18 06:00:00", openSet: true, ...extra } });

  it("does NOT crown a fragmented grouping - the leader's share is below the floor (no dominant group)", () => {
    // The top title holds 40 of 3,257 (~1.2%), far below the floor: many near-equal titles, no leader.
    const insight = buildComposedInsight({
      id: "f1",
      params: { measures: ["count"], dimensions: ["title"] },
      chartType: "bars",
      result: composed([{ title: "Software Engineer", count: 40 }, { title: "Data Scientist", count: 35 }], 3257),
    });
    expect(insight.verdict.toLowerCase()).toContain("no single role");
    expect(insight.verdict).not.toContain("leads");
    expect(insight.verdict).toContain("40 of 3257");
    // The card still renders the top-N bars, honestly labeled.
    if (insight.kind === "chart") expect(insight.series.length).toBe(2);
  });

  // The two tests above sit far below (1.2%) and far above (93%) the 0.1 floor; this pins the
  // BOUNDARY: minLeaderShare compares with strict `<`, so a share exactly AT the floor must NOT fragment
  // and a share just below it must.
  it("pins the fragmentation floor boundary: exactly at 0.1 is a normal leader, just below it fragments", () => {
    const atFloor = buildComposedInsight({
      id: "fb1",
      params: { measures: ["count"], dimensions: ["company"] },
      chartType: "bars",
      result: composed([{ company: "Google", count: 10 }, { company: "Meta", count: 5 }], 100),
    });
    expect(atFloor.verdict).toContain("Google leads with 10 of 100");
    expect(atFloor.verdict.toLowerCase()).not.toContain("no single");

    const justBelow = buildComposedInsight({
      id: "fb2",
      params: { measures: ["count"], dimensions: ["company"] },
      chartType: "bars",
      result: composed([{ company: "Google", count: 9 }, { company: "Meta", count: 5 }], 100),
    });
    expect(justBelow.verdict.toLowerCase()).toContain("no single company");
    expect(justBelow.verdict).not.toContain("leads");
  });

  it("keeps the normal leader verdict when one group genuinely dominates (share above the floor)", () => {
    const insight = buildComposedInsight({
      id: "f2",
      params: { measures: ["count"], dimensions: ["company"] },
      chartType: "bars",
      result: composed([{ company: "Google", count: 3257 }, { company: "YouTube", count: 135 }], 3488),
    });
    expect(insight.verdict).toContain("Google leads with 3257 of 3488");
    expect(insight.verdict.toLowerCase()).not.toContain("no single");
  });

  // A top-two count tie above the fragmentation floor is a tie, not a leader - phrase it "level",
  // never a false "leads with" superlative (matching salary_compare's explicit "about the same" tie).
  it("a top-two count tie is reported as level, never a false 'leads with' superlative (rec 9 for counts)", () => {
    const insight = buildComposedInsight({
      id: "tie1",
      params: { measures: ["count"], dimensions: ["company"] },
      chartType: "bars",
      // Google and Meta both at 40 of 100 (share 0.4, well above the 0.1 floor - not fragmented, a real tie).
      result: composed([{ company: "Google", count: 40 }, { company: "Meta", count: 40 }, { company: "Amazon", count: 20 }], 100),
    });
    expect(insight.verdict).not.toContain("leads");
    expect(insight.verdict.toLowerCase()).toContain("level");
    expect(insight.verdict).toContain("Google");
    expect(insight.verdict).toContain("Meta");
    expect(insight.verdict).toContain("40 of 100");
  });

  it("salary_compare on an exact tie says 'about the same', never a false 'pays more'", () => {
    const insight = buildInsight({
      id: "t1",
      tool: "salary_compare",
      params: {},
      result: composed([{ city: "San Francisco", median: 180000, n: 10 }, { city: "Los Angeles", median: 180000, n: 8 }], 18),
    });
    expect(insight.verdict.toLowerCase()).toContain("about the same");
    expect(insight.verdict).not.toContain("pays more");
  });

  it("threads the salary currency into the insight meta (for the source line + money formatter)", () => {
    const insight = buildComposedInsight({
      id: "c1",
      params: { measures: ["median_salary"], dimensions: ["experience_level"] },
      chartType: "bars",
      result: composed([{ experience_level: "Senior", median_salary: 180000 }], 500, { currency: "USD" }),
    });
    expect(insight.meta.currency).toBe("USD");
  });

  it("corrects a template trend with < 3 points to a table, and a non-whole share_split donut to bars", () => {
    const trend = buildInsight({
      id: "v1",
      tool: "postings_trend",
      params: { days: 7 },
      result: composed([{ day: "2026-07-20", count: 9 }, { day: "2026-07-19", count: 5 }], 14, { openSet: undefined }),
    });
    expect(trend.kind).toBe("table"); // only 2 points

    // share_split slices summing BELOW sampleN (a truncated/partial whole) -> bars, not a false donut.
    const donut = buildInsight({
      id: "v2",
      tool: "share_split",
      params: { dimension: "experience" },
      result: composed([{ label: "Senior", count: 40 }, { label: "Junior", count: 30 }], 3488),
    });
    expect(donut.kind).toBe("chart");
    if (donut.kind === "chart") expect(donut.chartType).toBe("bars");
  });

  it("coalesces null/empty group labels in a chart series to 'unspecified' (never a bare null axis)", () => {
    const insight = buildComposedInsight({
      id: "n1",
      params: { measures: ["count"], dimensions: ["city"] },
      chartType: "bars",
      result: composed([{ city: "San Francisco", count: 5 }, { city: null, count: 3 }, { city: "", count: 2 }], 10),
    });
    if (insight.kind === "chart") {
      const cities = insight.series.map((r) => r.city);
      expect(cities).toEqual(["San Francisco", "unspecified", "unspecified"]);
    }
  });
});

describe("composedFollowups derives two deterministic chips from the params (no LLM)", () => {
  it("widens by dropping the most-selective filter and pivots to an unused dimension", () => {
    const chips = composedFollowups({ measures: ["count"], dimensions: ["company"], country: "United States" });
    expect(chips).toHaveLength(2);
    expect(chips[0]).toBe("How does this look worldwide?"); // drop the country filter
    expect(chips[1]).toBe("Break this down by experience level."); // an unused, unpinned dimension
  });

  it("respects the most-selective precedence (role beats company beats country)", () => {
    const chips = composedFollowups({
      measures: ["count"],
      dimensions: ["city"],
      role: "engineer",
      company: "Google",
      country: "United States",
    });
    expect(chips[0]).toBe("How does this look across all roles?");
  });

  it("falls back to a time pivot when there is no filter to widen, and stays at two chips", () => {
    const chips = composedFollowups({ measures: ["count"], dimensions: ["title"] });
    expect(chips).toHaveLength(2);
    expect(chips).toContain("How has this changed over time?");
  });

  it("is deterministic - the same params yield the same chips", () => {
    const params = { measures: ["median_salary"], dimensions: ["experience_level"], city: "Berlin" };
    expect(composedFollowups(params)).toEqual(composedFollowups(params));
  });
});
