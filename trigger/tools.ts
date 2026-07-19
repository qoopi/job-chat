import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  TEMPLATE_PARAM_SCHEMAS,
  type Analytics,
  type TemplateName,
} from "@shared/analytics";
import {
  buildInsight,
  buildSkeleton,
  errorPart,
  toModelOutput,
  type ErrorPart,
} from "./parts";

// The agent's tool catalog: one tool per question shape, each a thin wrapper over analytics.runQuery
// (the ONLY path to ClickHouse). On call a tool emits the loading skeleton, runs the parameterized
// query, emits the filled data-insight part (same id -> the UI reconciles in place), and hands the
// model a compact view. A failure is caught and taxonomized as a `system` error part (AC-10) rather
// than thrown, so the agent keeps control. `report_unanswerable` is the escape hatch for questions
// the postings data cannot answer.

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
export type EmitPart = InsightPart | ErrorPart;
export type { ErrorPart };
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
        const insight = buildInsight({ id, tool: name, params, result });
        deps.emit({ type: "data-insight", id, data: insight });
        return toModelOutput(insight);
      } catch {
        // Never leak the raw error to the model or the user (AC-10) - tag it `system` and move on.
        deps.emit(errorPart(id, "system"));
        return { error: "The query failed - tell the user something went wrong and to try again." };
      }
    },
  });
}

export function buildCatalogTools(deps: CatalogDeps): ToolSet {
  const tools: ToolSet = {};
  for (const name of CATALOG_TOOL_NAMES) tools[name] = catalogTool(name, deps);

  tools.report_unanswerable = tool({
    description:
      "Call this when the question cannot be answered from the job-postings data (out of scope, no matching signal). Do NOT guess.",
    inputSchema: z.object({ reason: z.string().optional() }),
    execute: async (_params: unknown, { toolCallId }) => {
      deps.emit(errorPart(toolCallId, "unanswerable"));
      return { acknowledged: true };
    },
  });

  return tools;
}
