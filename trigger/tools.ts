import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  ComposedQueryParams,
  TEMPLATE_PARAM_SCHEMAS,
  type Analytics,
  type TemplateName,
} from "@shared/analytics";
import { ChartTypeSchema, type ChartType } from "@shared/insight";
import type { Profile } from "@shared/profile";
import type { CallerKind } from "./guard";
import {
  buildComposedInsight,
  buildComposedSkeleton,
  buildInsight,
  buildSkeleton,
  chartTypeForShape,
  emptyModelOutput,
  emptyPart,
  errorPart,
  sumCount,
  toModelOutput,
  type ErrorPart,
  type RefusalPart,
} from "./parts";

// The agent's tool catalog: one tool per question shape over analytics.runQuery (the ONLY path to
// ClickHouse). A failure is caught and taxonomized as a `system` error part, never thrown.

export const CATALOG_TOOL_NAMES = [
  "salary_distribution",
  "salary_compare",
  "postings_trend",
  "top_companies",
  "share_split",
  "latest_postings",
] as const satisfies readonly TemplateName[];

const DESCRIPTIONS: Record<TemplateName, string> = {
  salary_distribution:
    "Salary distribution (histogram) for an optional role and/or city. Use for 'what is the typical/median salary' questions.",
  salary_compare:
    "Compare median salary across exactly two cities for an optional role. Use for 'do they pay more in X or Y' questions.",
  postings_trend:
    "New postings per day over the last `days` for an optional role. Use for 'how many jobs opened this week / hiring trend' questions.",
  top_companies:
    "The companies with the most postings, optionally within the last `days` and/or a city. Use for 'who is hiring the most' questions.",
  share_split:
    "The share split of postings by `experience` level or `location_kind` (remote/onsite/hybrid) for an optional role. Use for 'what is the mix/breakdown' questions.",
  latest_postings:
    "The most recent postings, optionally filtered by company and/or experience level. Use for 'latest/newest roles at X' questions.",
};

export type InsightPart = { type: "data-insight"; id: string; data: unknown };
export type PostingsEmitPart = { type: "data-postings"; id: string; data: unknown };
/** The fit-intent invite wire parts: the server picks which by identity. */
export type InviteEmitPart = {
  type: "data-auth-invite" | "data-profile-invite";
  id: string;
  data: unknown;
};
export type EmitPart = InsightPart | ErrorPart | RefusalPart | PostingsEmitPart | InviteEmitPart;
export type { ErrorPart, RefusalPart };
export type Emit = (part: EmitPart) => void;

export interface CatalogDeps {
  analytics: Analytics;
  emit: Emit;
  /** Identity kind (request_profile picks the card); unset => the guest sign-in card - the fail-safe. */
  callerKind?: CallerKind;
  /** The owner's structured profile (search_postings merges terms against it server-side); null = no profile.
   *  SECURITY: the profile object stays in this layer, never reaching the ClickHouse path - only derived VALUES do. */
  profile?: Profile | null;
}

/** Tool-failure tail: never leak the raw error - log it server-side, emit a `system` error part, return the
 *  model-facing canned message. One home for every catalog tool's catch block. */
function emitToolError(
  deps: CatalogDeps,
  id: string,
  label: string,
  err: unknown,
  message: string,
): { error: string } {
  console.error(`[${label}] query failed`, err);
  deps.emit(errorPart(id, "system"));
  return { error: message };
}

function catalogTool(name: TemplateName, deps: CatalogDeps) {
  // Cast to one concrete Zod type: indexing the union collapses tool()'s inference to `never`. Runtime re-validates.
  const inputSchema = TEMPLATE_PARAM_SCHEMAS[name] as z.ZodType<Record<string, unknown>>;
  return tool({
    description: DESCRIPTIONS[name],
    inputSchema,
    execute: async (params, { toolCallId }) => {
      const id = toolCallId;
      deps.emit({ type: "data-insight", id, data: buildSkeleton(id, name) });
      try {
        const result = await deps.analytics.runQuery(name, params);
        // Empty result = plain mode: clear the skeleton with an empty marker (no dangling card) + a plain-prose signal.
        if (result.rows.length === 0) {
          deps.emit(emptyPart(id));
          return emptyModelOutput(name);
        }
        const insight = buildInsight({ id, tool: name, params, result });
        deps.emit({ type: "data-insight", id, data: insight });
        return toModelOutput(insight);
      } catch (err) {
        return emitToolError(deps, id, `catalog:${name}`, err, "The query failed - tell the user something went wrong and to try again.");
      }
    },
  });
}

// The seventh tool: query_postings composes a whitelisted aggregate for questions the six templates don't fit.
const COMPOSED_DESCRIPTION =
  "Compose a custom aggregate over the postings when none of the six fixed tools fit. Pick 1-2 measures " +
  "(count, median_salary, p25_salary, p75_salary), group by up to two dimensions (company, city, region, " +
  "country, experience_level, employment_type, location_kind, title) and/or one time bucket (day/week/month), " +
  "filter (role, company, city, cities [a list, for 'in LA or NYC'], region, country, experience_level, " +
  "employment_type, location_kind, days, min_salary, max_salary), and choose a chartType. Use for questions like 'top companies in the US', " +
  "'median salary by experience level in Berlin', or 'which roles are hiring most'.";

const ComposedToolInput = ComposedQueryParams.extend({
  chartType: ChartTypeSchema.or(z.literal("table")),
});

function composedTool(deps: CatalogDeps) {
  // Cast to one concrete Zod type so tool()'s inference doesn't collapse; re-validated below.
  const inputSchema = ComposedToolInput as unknown as z.ZodType<Record<string, unknown>>;
  return tool({
    description: COMPOSED_DESCRIPTION,
    inputSchema,
    execute: async (input, { toolCallId }) => {
      const id = toolCallId;
      const { chartType: rawPick, ...queryParams } = input as {
        chartType: ChartType | "table";
      } & Record<string, unknown>;
      // Skeleton from the agent's RAW pick; the filled insight reconciles it under the same id once the served type is known.
      deps.emit({ type: "data-insight", id, data: buildComposedSkeleton(id, rawPick) });
      try {
        // Re-validate + apply defaults, then run the composed path (the ONLY route to ClickHouse for query_postings).
        const params = ComposedQueryParams.parse(queryParams);
        const result = await deps.analytics.runComposedQuery(params);
        if (result.rows.length === 0) {
          deps.emit(emptyPart(id));
          return { ...emptyModelOutput("query_postings"), rawChartType: rawPick };
        }
        // Pass the slice sum + sample so a donut is served only for a TRUE whole.
        const served = chartTypeForShape(params, rawPick, result.rows.length, {
          sliceSum: sumCount(result.rows),
          sampleN: result.meta.sampleN,
        });
        const insight = buildComposedInsight({ id, params, chartType: served, result });
        deps.emit({ type: "data-insight", id, data: insight });
        // Record the RAW chartType pick: the eval scores the pick before any fallback; the served chart may differ.
        return { ...toModelOutput(insight), rawChartType: rawPick };
      } catch (err) {
        return emitToolError(deps, id, "catalog:query_postings", err, "The query failed - tell the user something went wrong and to try again.");
      }
    },
  });
}

// The two fit-intent tools. request_profile: the SERVER picks the card from identity (the model can't emit
// the wrong one). search_postings: the server MERGES terms with the profile - experience/salary floor are always the profile's.

/** Model-facing search_postings input: search intent + refinements only. The authoritative filters
 *  (experience, salary floor) are NOT here - the server takes them from the profile (the model can't invent them). */
const SearchPostingsToolInput = z
  .object({
    titleTerms: z.array(z.string().min(1)).max(10).optional(),
    cities: z.array(z.string().min(1)).max(20).optional(),
    remoteOk: z.boolean().optional(),
  })
  .strict();
type SearchToolInput = z.infer<typeof SearchPostingsToolInput>;

// Generic title tokens that must never become a standalone search term (they'd match the whole board).
const GENERIC_TITLE_TOKENS = new Set([
  "full",
  "engineer",
  "developer",
  "manager",
  "senior",
  "staff",
  "junior",
  "principal",
  "lead",
]);

// Family-crossing tokens: distinctive enough to survive the generic stoplist, but bare they match across
// unrelated job families (a bare "Automation" recalled "UX Designer, Tools Automation and Infrastructure").
// Never emit them alone: pair with the phrase's preceding distinctive token AND a canonical
// pairing (so "QA Automation Engineer" contributes "QA Automation" + "Test Automation", never "Automation").
const CONTEXT_REQUIRED_TOKENS: Record<string, string> = { automation: "Test Automation" };

/** Broaden title terms for the whole-phrase ILIKE scorer, which recalls almost nothing against
 *  real-world titles ("Software Engineer III, Full Stack" never matches '%Full-Stack Developer%'). Per term
 *  emit the phrase, its hyphen->space normalization, and its DISTINCTIVE tokens (the generic-token stoplist
 *  dropped, so a bare "Engineer"/"Developer" never widens the match). Deterministic, case-insensitively
 *  deduped, capped at 10 (the analytics titleTerms bound). */
export function expandTitleTerms(terms: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const term = raw.trim();
    if (!term) return;
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(term);
  };
  for (const term of terms) {
    const phrase = term.trim();
    if (!phrase) continue;
    push(phrase);
    const normalized = phrase.replace(/-/g, " ").replace(/\s+/g, " ").trim();
    push(normalized);
    const tokens = normalized.split(" ");
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const lower = token.toLowerCase();
      if (GENERIC_TITLE_TOKENS.has(lower)) continue;
      const canonical = CONTEXT_REQUIRED_TOKENS[lower];
      if (canonical) {
        // Never bare: emit the phrase's own bigram with the preceding distinctive token, plus the canonical pairing.
        const prev = tokens[i - 1];
        if (prev && !GENERIC_TITLE_TOKENS.has(prev.toLowerCase())) push(`${prev} ${token}`);
        push(canonical);
        continue;
      }
      push(token);
    }
  }
  return out.slice(0, 10);
}

/** Merge the model's terms with the profile. SERVER-authoritative (model cannot set): `experience`, `salaryMin`.
 *  Model-refinable (else the profile's value): `titleTerms`, `cities`, `remoteOk`. `limit` is the hard cap (50). */
export function mergeSearchParams(input: SearchToolInput, profile: Profile) {
  const baseTitles = input.titleTerms && input.titleTerms.length > 0 ? input.titleTerms : profile.titles;
  return {
    titleTerms: expandTitleTerms(baseTitles), // recall-broadened before the scorer sees them
    experience: profile.seniority ?? undefined, // authoritative - never from the model
    cities: input.cities && input.cities.length > 0 ? input.cities : profile.locations,
    remoteOk: input.remoteOk ?? profile.remotePref ?? undefined,
    salaryMin: profile.salaryMin ?? undefined, // authoritative - never from the model
    limit: 50, // the inherited contract: carry ALL matches up to the hard cap of 50
  };
}

const SEARCH_POSTINGS_DESCRIPTION =
  "Return the job postings that fit the signed-in user's stored profile, as the postings card. Call " +
  "this on a personal fit-intent WHEN a PROFILE note is present. Supply titleTerms drawn from the " +
  "profile's titles; optionally add cities or remoteOk to refine a follow-up ('only remote', 'in " +
  "Berlin'). The server applies the profile's seniority and salary floor itself. The card is the whole " +
  "answer - add no prose.";

function searchPostingsTool(deps: CatalogDeps) {
  return tool({
    description: SEARCH_POSTINGS_DESCRIPTION,
    inputSchema: SearchPostingsToolInput,
    execute: async (rawInput, { toolCallId }) => {
      const id = toolCallId;
      // No profile on file: degrade safely - emit no card, signal the model to re-route (never a fabricated shortlist).
      if (!deps.profile) {
        return { error: "No profile on file - call request_profile so the user can create one." };
      }
      const params = mergeSearchParams(rawInput as SearchToolInput, deps.profile);
      try {
        const { rows, total } = await deps.analytics.searchPostings(params);
        deps.emit({ type: "data-postings", id, data: { kind: "postings", rows, total } });
        return {
          total,
          shown: rows.length,
          note:
            total === 0
              ? "No postings match this profile - the card states this. Add no prose and invent no postings."
              : "The postings card is the complete answer - add no prose beside it.",
        };
      } catch (err) {
        return emitToolError(deps, id, "search_postings", err, "The search failed - tell the user something went wrong and to try again.");
      }
    },
  });
}

const REQUEST_PROFILE_DESCRIPTION =
  "The user asked for a personal job fit but has no usable profile yet (NO PROFILE note is present). " +
  "Call this to invite them to set one up - the server emits the right card (sign in with Google for a " +
  "guest, create-profile for a signed-in user). Takes no arguments; the card is the whole answer, add " +
  "no prose.";

function requestProfileTool(deps: CatalogDeps) {
  return tool({
    description: REQUEST_PROFILE_DESCRIPTION,
    inputSchema: z.object({}).strict(),
    execute: async (_input, { toolCallId }) => {
      const id = toolCallId;
      // Guardrail: a profile is already on file (the PROFILE note forbids reaching here, but the model
      // sometimes does). Emit NO card and steer to search_postings so the owner is matched in THIS turn -
      // reuse the profile already in deps, never a second DB read.
      if (deps.profile) {
        return { invite: null, note: "A profile is already on file - do NOT invite. Call search_postings with the profile's titles to match now." };
      }
      // Fail-safe: an unknown identity gets the guest (sign-in) card - the server decides, never the model.
      const kind: CallerKind = deps.callerKind ?? "guest";
      if (kind === "guest") {
        deps.emit({ type: "data-auth-invite", id, data: { kind: "auth-invite" } });
        return { invite: "auth", note: "The sign-in invite card is the whole answer - add no prose." };
      }
      deps.emit({ type: "data-profile-invite", id, data: { kind: "profile-invite" } });
      return { invite: "profile", note: "The create-profile invite card is the whole answer - add no prose." };
    },
  });
}

export function buildCatalogTools(deps: CatalogDeps): ToolSet {
  const tools: ToolSet = {};
  for (const name of CATALOG_TOOL_NAMES) tools[name] = catalogTool(name, deps);
  tools.query_postings = composedTool(deps);
  tools.search_postings = searchPostingsTool(deps);
  tools.request_profile = requestProfileTool(deps);
  return tools;
}
