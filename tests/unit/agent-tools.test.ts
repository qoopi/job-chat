import { describe, expect, it, vi } from "vitest";
import type { Analytics } from "@shared/analytics";
import type { Profile } from "@shared/profile";
import { buildCatalogTools, CATALOG_TOOL_NAMES, mergeSearchParams } from "../../trigger/tools";
import type { EmitPart } from "../../trigger/tools";

const opts = { toolCallId: "call-1", messages: [] } as unknown as Parameters<
  NonNullable<ReturnType<typeof buildCatalogTools>["salary_distribution"]["execute"]>
>[1];

describe("buildCatalogTools", () => {
  it("exposes the 6 catalog tools plus the composed query_postings, and NO report_unanswerable (retired)", () => {
    const tools = buildCatalogTools({ analytics: {} as Analytics, emit: () => {} });
    for (const name of CATALOG_TOOL_NAMES) expect(tools).toHaveProperty(name);
    expect(tools).toHaveProperty("query_postings");
    // report_unanswerable is retired from the scope path - the agent
    // answers anything then steers, so there is no scope escape-hatch tool to over-fire an error card.
    expect(tools).not.toHaveProperty("report_unanswerable");
  });

  it("emits a loading skeleton then the filled insight, and hands the model a compact view", async () => {
    const emitted: EmitPart[] = [];
    const analytics: Analytics = {
      runQuery: vi.fn(async () => ({
        sql: "SELECT 1",
        rows: [{ company: "Google", count: 4 }],
        meta: { sampleN: 10, freshestAt: "2026-07-18 06:00:00" },
      })),
      runComposedQuery: vi.fn(),
      coverageProfile: vi.fn(),
      searchPostings: vi.fn(),
    };
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });
    const out = await tools.top_companies.execute!({}, opts);

    expect(emitted[0]).toMatchObject({ type: "data-insight", id: "call-1", data: { status: "loading" } });
    expect(emitted[1]).toMatchObject({ type: "data-insight", id: "call-1" });
    expect((out as { verdict: string }).verdict).toContain("Google");
  });

  // A 0-row result emits NO card. The tool clears its loading skeleton with an empty marker
  // (same id -> supersedes the skeleton in place, no dangling card) and hands the model a plain-mode
  // signal so the answer is plain prose, not an empty "No data" insight card.
  it("emits an empty marker (no filled card) and a plain-mode output when the query returns no rows", async () => {
    const emitted: EmitPart[] = [];
    const analytics: Analytics = {
      runQuery: vi.fn(async () => ({
        sql: "SELECT 1",
        rows: [],
        meta: { sampleN: 0, freshestAt: "1970-01-01 00:00:00" },
      })),
      runComposedQuery: vi.fn(),
      coverageProfile: vi.fn(),
      searchPostings: vi.fn(),
    };
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });
    const out = await tools.salary_distribution.execute!({ city: "SF" }, opts);

    expect(emitted[0]).toMatchObject({ type: "data-insight", id: "call-1", data: { status: "loading" } });
    expect(emitted[1]).toMatchObject({ type: "data-insight", id: "call-1", data: { status: "empty" } });
    // No filled insight (no verdict/series/rows) was ever emitted for the empty result.
    expect(emitted.some((p) => p.type === "data-insight" && (p.data as { verdict?: unknown }).verdict !== undefined)).toBe(false);
    expect((out as { empty?: boolean }).empty).toBe(true);
  });

  // A tool/infra failure is taxonomized as a `system` error part, and the tool does NOT throw
  // (the agent keeps control to apologize) - it hands the model a compact error marker.
  it("emits a system error part when the query fails, without throwing", async () => {
    const emitted: EmitPart[] = [];
    const analytics: Analytics = {
      runQuery: vi.fn(async () => {
        throw new Error("ClickHouse unreachable");
      }),
      runComposedQuery: vi.fn(),
      coverageProfile: vi.fn(),
      searchPostings: vi.fn(),
    };
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });
    const out = await tools.salary_distribution.execute!({ city: "SF" }, opts);

    expect(emitted.some((p) => p.type === "data-error" && p.data.kind === "system")).toBe(true);
    expect((out as { error: string }).error).toBeTruthy();
  });
});

// The seventh tool: a composed aggregate with an agent-chosen chartType behind the deterministic
// fallback. It runs the composed path (analytics.runComposedQuery), not a template.
describe("buildCatalogTools query_postings (composed tool, AC-1/AC-3/AC-4)", () => {
  function composedAnalytics(rows: Record<string, unknown>[], openSet = true): Analytics {
    return {
      runQuery: vi.fn(),
      coverageProfile: vi.fn(),
      searchPostings: vi.fn(),
      runComposedQuery: vi.fn(async () =>({
        sql: "SELECT company, count() AS count FROM postings FINAL WHERE country = 'United States'",
        rows,
        meta: { sampleN: rows.reduce((s, r) => s + Number(r.count ?? 1), 0), freshestAt: "2026-07-18 06:00:00", ...(openSet ? { openSet: true } : {}) },
      })),
    };
  }

  it("is registered alongside the six templates", () => {
    const tools = buildCatalogTools({ analytics: {} as Analytics, emit: () => {} });
    expect(tools).toHaveProperty("query_postings");
  });

  it("emits a skeleton from the RAW chart pick, then the filled composed insight (same id), and strips chartType from the query params", async () => {
    const emitted: EmitPart[] = [];
    const analytics = composedAnalytics([
      { company: "Google", count: 4 },
      { company: "Meta", count: 2 },
    ]);
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });

    const out = await tools.query_postings.execute!(
      { measures: ["count"], dimensions: ["company"], country: "United States", chartType: "bars" },
      opts,
    );

    // Skeleton first (loading, carries the raw pick), filled insight last (same id).
    expect(emitted[0]).toMatchObject({ type: "data-insight", id: "call-1", data: { status: "loading", chartType: "bars" } });
    expect(emitted[1]).toMatchObject({ type: "data-insight", id: "call-1" });
    const filled = emitted[emitted.length - 1].data as { verdict?: string; chartType?: string };
    expect(filled.verdict).toContain("Google");
    expect(filled.chartType).toBe("bars");

    // The composed schema is strict, so the chartType field must be stripped before runComposedQuery.
    const arg = (analytics.runComposedQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg).not.toHaveProperty("chartType");
    expect(arg).toMatchObject({ measures: ["count"], dimensions: ["company"], country: "United States" });

    // The RAW pick is recorded on the tool result (the eval harness reads it here).
    expect((out as { rawChartType?: string }).rawChartType).toBe("bars");
  });

  it("records the raw pick but serves a shape-fit chart when the pick is unfit (donut over > 6 slices -> bars)", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({ company: `C${i}`, count: 8 - i }));
    const emitted: EmitPart[] = [];
    const analytics = composedAnalytics(rows);
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });

    const out = await tools.query_postings.execute!(
      { measures: ["count"], dimensions: ["company"], chartType: "donut" },
      opts,
    );

    const filled = emitted[emitted.length - 1].data as { chartType?: string };
    expect(filled.chartType).toBe("bars"); // served type corrected
    expect((out as { rawChartType?: string; visual?: string }).rawChartType).toBe("donut"); // raw pick recorded
    expect((out as { visual?: string }).visual).toBe("bars"); // served type in the model view
  });

  it("emits an empty marker (no card) and a plain-mode output when the composed query returns no rows", async () => {
    const emitted: EmitPart[] = [];
    const analytics = composedAnalytics([]);
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });

    const out = await tools.query_postings.execute!(
      { measures: ["count"], dimensions: ["company"], country: "Atlantis", chartType: "bars" },
      opts,
    );

    expect(emitted[0]).toMatchObject({ data: { status: "loading" } });
    expect(emitted[1]).toMatchObject({ type: "data-insight", id: "call-1", data: { status: "empty" } });
    expect(emitted.some((p) => p.type === "data-insight" && (p.data as { verdict?: unknown }).verdict !== undefined)).toBe(false);
    expect((out as { empty?: boolean }).empty).toBe(true);
  });

  it("taxonomizes a composed query failure as a system error without throwing", async () => {
    const emitted: EmitPart[] = [];
    const analytics: Analytics = {
      runQuery: vi.fn(),
      coverageProfile: vi.fn(),
      searchPostings: vi.fn(),
      runComposedQuery: vi.fn(async () =>{
        throw new Error("ClickHouse unreachable");
      }),
    };
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });

    const out = await tools.query_postings.execute!(
      { measures: ["count"], dimensions: ["company"], chartType: "bars" },
      opts,
    );

    expect(emitted.some((p) => p.type === "data-error" && p.data.kind === "system")).toBe(true);
    expect((out as { error?: string }).error).toBeTruthy();
  });
});

// The profile-driven fit tools (030): search_postings emits the postings card + merges the model's
// terms against the stored profile server-side; request_profile emits the invite the SERVER picks from
// identity. Both are always registered so the prompt can route fit-intents to them.
const PROFILE: Profile = {
  titles: ["Backend Engineer"],
  seniority: "senior",
  skills: [{ name: "TypeScript", source: "both" }],
  locations: ["Berlin"],
  remotePref: true,
  salaryMin: 120000,
  yearsExp: 8,
  domains: ["fintech"],
  ossHighlights: [],
  experience: [],
};

describe("buildCatalogTools registers the fit tools (search_postings + request_profile)", () => {
  it("exposes search_postings and request_profile alongside the query tools", () => {
    const tools = buildCatalogTools({ analytics: {} as Analytics, emit: () => {} });
    expect(tools).toHaveProperty("search_postings");
    expect(tools).toHaveProperty("request_profile");
  });
});

describe("mergeSearchParams (server-authoritative profile merge)", () => {
  it("takes experience + salaryMin from the profile ONLY - the model cannot inject them", () => {
    const merged = mergeSearchParams(
      // A hostile model tries to widen the salary floor / seniority via extra keys - they are ignored:
      // the tool schema is strict (they never arrive) and the merge reads the profile for those fields.
      { titleTerms: ["staff engineer"] },
      PROFILE,
    );
    expect(merged.experience).toBe("senior"); // from the profile band
    expect(merged.salaryMin).toBe(120000); // from the profile floor
    expect(merged.titleTerms).toEqual(["staff engineer"]); // the model supplies the search intent
    expect(merged.cities).toEqual(["Berlin"]); // falls back to the profile's own locations
    expect(merged.remoteOk).toBe(true); // falls back to the profile's remotePref
    expect(merged.limit).toBe(50); // the emitter's hard cap
  });

  it("honors a model refinement for cities/remoteOk (the follow-up path), falls back to the profile otherwise", () => {
    const refined = mergeSearchParams({ cities: ["Munich"], remoteOk: false }, PROFILE);
    expect(refined.cities).toEqual(["Munich"]);
    expect(refined.remoteOk).toBe(false);
    expect(refined.titleTerms).toEqual(["Backend Engineer"]); // no model terms -> the profile's titles
  });
});

describe("Should_EmitPostingsPart_When_SearchPostingsRuns (AC-7)", () => {
  function searchAnalytics(rows: unknown[], total: number): Analytics {
    return {
      runQuery: vi.fn(),
      runComposedQuery: vi.fn(),
      coverageProfile: vi.fn(),
      searchPostings: vi.fn(async () => ({
        rows: rows as never,
        total,
        meta: { freshestAt: "2026-07-18 06:00:00", topCompany: "Google", topShare: 0.5 },
      })),
    };
  }

  it("emits a data-postings part with the scored rows + total and merges terms against the profile", async () => {
    const emitted: EmitPart[] = [];
    const rows = [
      { title: "Senior Backend Engineer", company: "Google", city: "Berlin", remote: true, salaryMin: 150000, salaryMax: 190000, experience: "Senior", publishedAt: "2026-07-18 10:00:00", score: 9 },
    ];
    const analytics = searchAnalytics(rows, 23);
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p), profile: PROFILE });

    const out = await tools.search_postings.execute!({ titleTerms: ["backend"] }, opts);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ type: "data-postings", id: "call-1", data: { kind: "postings", rows, total: 23 } });
    // The scorer received the profile-authoritative fields, not model-injected ones.
    const passed = (analytics.searchPostings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(passed).toMatchObject({ titleTerms: ["backend"], experience: "senior", salaryMin: 120000, limit: 50 });
    // The card is the whole answer (the model view carries the count, not prose).
    expect((out as { total: number }).total).toBe(23);
  });

  it("emits no card and signals request_profile when there is no profile on file", async () => {
    const emitted: EmitPart[] = [];
    const analytics = searchAnalytics([], 0);
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) }); // no profile

    const out = await tools.search_postings.execute!({ titleTerms: ["backend"] }, opts);

    expect(emitted).toEqual([]); // never a fabricated shortlist
    expect(analytics.searchPostings).not.toHaveBeenCalled();
    expect((out as { error: string }).error).toContain("request_profile");
  });

  it("taxonomizes a search failure as a system error without throwing", async () => {
    const emitted: EmitPart[] = [];
    const analytics: Analytics = {
      runQuery: vi.fn(),
      runComposedQuery: vi.fn(),
      coverageProfile: vi.fn(),
      searchPostings: vi.fn(async () => {
        throw new Error("ClickHouse unreachable");
      }),
    };
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p), profile: PROFILE });

    const out = await tools.search_postings.execute!({ titleTerms: ["backend"] }, opts);

    expect(emitted.some((p) => p.type === "data-error" && (p.data as { kind?: string }).kind === "system")).toBe(true);
    expect((out as { error?: string }).error).toBeTruthy();
  });
});

describe("Should_EmitInvitePart_When_RequestProfileRuns (AC-1, callerKind branches)", () => {
  it("emits the auth-invite (sign-in) card for a guest", async () => {
    const emitted: EmitPart[] = [];
    const tools = buildCatalogTools({ analytics: {} as Analytics, emit: (p) => emitted.push(p), callerKind: "guest" });
    const out = await tools.request_profile.execute!({}, opts);
    expect(emitted).toEqual([{ type: "data-auth-invite", id: "call-1", data: { kind: "auth-invite" } }]);
    expect((out as { invite: string }).invite).toBe("auth");
  });

  it("emits the create-profile invite card for a signed-in account", async () => {
    const emitted: EmitPart[] = [];
    const tools = buildCatalogTools({ analytics: {} as Analytics, emit: (p) => emitted.push(p), callerKind: "account" });
    const out = await tools.request_profile.execute!({}, opts);
    expect(emitted).toEqual([{ type: "data-profile-invite", id: "call-1", data: { kind: "profile-invite" } }]);
    expect((out as { invite: string }).invite).toBe("profile");
  });

  it("fails safe to the guest (sign-in) card when the identity is unknown", async () => {
    const emitted: EmitPart[] = [];
    const tools = buildCatalogTools({ analytics: {} as Analytics, emit: (p) => emitted.push(p) }); // no callerKind
    await tools.request_profile.execute!({}, opts);
    expect(emitted[0]).toMatchObject({ type: "data-auth-invite" });
  });
});
