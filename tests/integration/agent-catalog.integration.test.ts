import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import { createWriterClient } from "@shared/clickhouse";
import { createAnalytics } from "@shared/analytics";
import { DataInsightSchema } from "@shared/insight";
import { buildCatalogTools, type EmitPart } from "../../trigger/tools";
import { loadFixtureTable } from "../fixtures/load";
import { LAUNCH_QUESTIONS } from "../fixtures/launch-questions";

// Demo gate: the agent's tool catalog, run against the seeded reference dataset in real
// ClickHouse, answers all 7 launch questions with the designated tool, the designated visual (Q5/Q6
// donut), and the expected verdict value from the fixture case table. This proves the tool ->
// visual -> value contract deterministically; the LLM's question->tool routing is verified in the
// live dev-server round trip and the e2e suite. Skipped without ClickHouse creds.
const hasCreds = Boolean(process.env.CLICKHOUSE_URL);
// A distinct table from analytics.integration.test's `postings_test` - vitest runs suites in
// parallel workers, so a shared fixture-table name would race (drop/create collisions).
const TABLE = "postings_agent_test";

describe.skipIf(!hasCreds)("agent catalog against the seeded reference dataset", () => {
  let writer: ClickHouseClient;

  beforeAll(async () => {
    writer = createWriterClient();
    await loadFixtureTable(writer, TABLE);
  });

  afterAll(async () => {
    await writer.command({
      query: `DROP TABLE IF EXISTS ${TABLE}`,
      clickhouse_settings: { wait_end_of_query: 1 },
    });
    await writer.close();
  });

  for (const q of LAUNCH_QUESTIONS) {
    it(`${q.id}: ${q.tool} -> ${q.chartType} with the fixture verdict value`, async () => {
      const analytics = createAnalytics({ client: writer, table: TABLE });
      const emitted: EmitPart[] = [];
      const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });

      await tools[q.tool].execute!(q.params, { toolCallId: `${q.id}-call`, messages: [] } as never);

      const insights = emitted.filter((p) => p.type === "data-insight");
      // Skeleton first (loading), filled insight last (same id) - the streaming contract.
      expect((insights[0].data as { status?: string }).status).toBe("loading");
      const data = insights[insights.length - 1].data;

      // Strict-valid data-insight (the filled part, not the skeleton).
      const insight = DataInsightSchema.parse(data);

      // Designated visual.
      if (q.chartType === "table") {
        expect(insight.kind).toBe("table");
      } else {
        expect(insight.kind).toBe("chart");
        if (insight.kind === "chart") expect(insight.chartType).toBe(q.chartType);
      }

      // Expected verdict value (and label where the case table pins one).
      expect(insight.verdict).toContain(String(q.expectedVerdict));
      if (q.expectedLabel !== undefined) expect(insight.verdict).toContain(q.expectedLabel);

      // Meta stays honest - the real sample size and the SQL that produced it.
      expect(insight.meta.sampleN).toBeGreaterThan(0);
      expect(insight.meta.sql).toContain(`FROM ${TABLE} FINAL`);
    });
  }
});
