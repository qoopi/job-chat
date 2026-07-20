import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  ComposedQueryParams,
  TEMPLATE_PARAM_SCHEMAS,
  type Analytics,
  type TemplateName,
} from "@shared/analytics";
import { ChartTypeSchema, type ChartType } from "@shared/insight";
import {
  buildComposedInsight,
  buildComposedSkeleton,
  buildInsight,
  buildSkeleton,
  chartTypeForShape,
  emptyModelOutput,
  emptyPart,
  errorPart,
  toModelOutput,
  type ErrorPart,
  type RefusalPart,
} from "./parts";

// The agent's tool catalog: one tool per question shape, each a thin wrapper over analytics.runQuery
// (the ONLY path to ClickHouse). On call a tool emits the loading skeleton, runs the parameterized
// query, emits the filled data-insight part (same id -> the UI reconciles in place), and hands the
// model a compact view. A failure is caught and taxonomized as a `system` error part (AC-10) rather
// than thrown, so the agent keeps control. There is NO scope escape-hatch tool: the 2026-07-21 vision
// refinement retired report_unanswerable - the agent answers anything in plain prose then steers back
// to jobs (prompt behavior), so the red error card is reserved for genuine SYSTEM failures.

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
// Every part the agent writes to the chat stream: the tools emit insight/error; the run-level guard
// backstop emits refusal (below).
export type EmitPart = InsightPart | ErrorPart | RefusalPart;
export type { ErrorPart, RefusalPart };
export type Emit = (part: EmitPart) => void;

export interface CatalogDeps {
  analytics: Analytics;
  emit: Emit;
}

function catalogTool(name: TemplateName, deps: CatalogDeps) {
  // Cast the indexed schema to one concrete Zod type: indexing by the TemplateName union otherwise
  // collapses tool()'s input inference to `never`. Runtime is unaffected - analytics.runQuery
  // re-validates params against the same schema.
  const inputSchema = TEMPLATE_PARAM_SCHEMAS[name] as z.ZodType<Record<string, unknown>>;
  return tool({
    description: DESCRIPTIONS[name],
    inputSchema,
    execute: async (params, { toolCallId }) => {
      const id = toolCallId;
      deps.emit({ type: "data-insight", id, data: buildSkeleton(id, name) });
      try {
        const result = await deps.analytics.runQuery(name, params);
        // Empty result = plain mode (spec: one data-insight part per answer). Clear the skeleton with an
        // empty marker so no dangling "No data" card is left - even across an internal retry - and hand
        // the model a plain-prose signal instead of an empty insight card.
        if (result.rows.length === 0) {
          deps.emit(emptyPart(id));
          return emptyModelOutput(name);
        }
        const insight = buildInsight({ id, tool: name, params, result });
        deps.emit({ type: "data-insight", id, data: insight });
        return toModelOutput(insight);
      } catch (err) {
        // Never leak the raw error to the model or the user (AC-10) - tag it `system` and move on.
        // But DO log it server-side (Trigger.dev captures console.error) so a prod failure is not
        // invisible when the user only ever sees the taxonomized card.
        console.error(`[catalog:${name}] query failed`, err);
        deps.emit(errorPart(id, "system"));
        return { error: "The query failed - tell the user something went wrong and to try again." };
      }
    },
  });
}

// The seventh tool: query_postings composes a whitelisted aggregate (008's buildComposedSql) for any
// question the six fixed templates do not fit, and lets the agent pick the chart type behind the
// deterministic chartTypeForShape fallback. Its own parallel parts path - it is NOT a TemplateName.
const COMPOSED_DESCRIPTION =
  "Compose a custom aggregate over the postings when none of the six fixed tools fit. Pick 1-2 measures " +
  "(count, median_salary, p25_salary, p75_salary), group by up to two dimensions (company, city, region, " +
  "country, experience_level, employment_type, location_kind, title) and/or one time bucket (day/week/month), " +
  "filter (role, company, city, region, country, experience_level, employment_type, location_kind, days, " +
  "min_salary, max_salary), and choose a chartType. Use for questions like 'top companies in the US', " +
  "'median salary by experience level in Berlin', or 'which roles are hiring most'.";

// The composed tool input: the shared strict composed schema (008) plus the agent's chartType pick.
const ComposedToolInput = ComposedQueryParams.extend({
  chartType: ChartTypeSchema.or(z.literal("table")),
});

function composedTool(deps: CatalogDeps) {
  // Cast to one concrete Zod type so tool()'s input inference does not collapse (as with the templates);
  // runComposedQuery re-validates, and the tool re-parses below, so runtime safety is unaffected.
  const inputSchema = ComposedToolInput as unknown as z.ZodType<Record<string, unknown>>;
  return tool({
    description: COMPOSED_DESCRIPTION,
    inputSchema,
    execute: async (input, { toolCallId }) => {
      const id = toolCallId;
      const { chartType: rawPick, ...queryParams } = input as {
        chartType: ChartType | "table";
      } & Record<string, unknown>;
      // Skeleton from the agent's RAW pick (known at call time); the filled insight reconciles it in
      // place under the same id once the served (shape-fit) type is known from the actual rows.
      deps.emit({ type: "data-insight", id, data: buildComposedSkeleton(id, rawPick) });
      try {
        // Re-validate + apply the schema defaults (dimensions/limit), then run the 008 composed path (the
        // ONLY route to ClickHouse for query_postings). The composed schema is strict, so chartType was
        // stripped above; runComposedQuery re-parses too (idempotent).
        const params = ComposedQueryParams.parse(queryParams);
        const result = await deps.analytics.runComposedQuery(params);
        if (result.rows.length === 0) {
          deps.emit(emptyPart(id));
          return { ...emptyModelOutput("query_postings"), rawChartType: rawPick };
        }
        const served = chartTypeForShape(params, rawPick, result.rows.length);
        const insight = buildComposedInsight({ id, params, chartType: served, result });
        deps.emit({ type: "data-insight", id, data: insight });
        // Record the RAW chartType pick on the tool result: AC-4 scores the pick BEFORE any fallback (the
        // 010 harness reads it here); the served chart may differ where the fallback corrected an unfit pick.
        return { ...toModelOutput(insight), rawChartType: rawPick };
      } catch (err) {
        console.error(`[catalog:query_postings] query failed`, err);
        deps.emit(errorPart(id, "system"));
        return { error: "The query failed - tell the user something went wrong and to try again." };
      }
    },
  });
}

export function buildCatalogTools(deps: CatalogDeps): ToolSet {
  const tools: ToolSet = {};
  for (const name of CATALOG_TOOL_NAMES) tools[name] = catalogTool(name, deps);
  tools.query_postings = composedTool(deps);
  return tools;
}
