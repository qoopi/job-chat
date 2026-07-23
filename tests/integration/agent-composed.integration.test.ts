import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ClickHouseClient } from "@clickhouse/client";
import { createWriterClient } from "@shared/clickhouse";
import { createAnalytics } from "@shared/analytics";
import { DataInsightSchema } from "@shared/insight";
import { buildCatalogTools, type EmitPart } from "../../trigger/tools";
import { loadFixtureTable } from "../fixtures/load";

// The seventh tool answers a composed question no template fits -
// "top companies in the US" - against the seeded reference dataset in real ClickHouse. A scripted model
// call invokes query_postings with a country filter + company dimension + a chart pick. Assert a filled
// insight part is emitted, its meta.sql (the "Show query" reveal) carries the country filter AND the
// open-set predicate, and the meta flags openSet (a windowless current-state read). A distinct fixture
// table from the other integration suites so parallel workers do not race
// on drop/create. Skipped without ClickHouse creds.
const hasCreds = Boolean(process.env.CLICKHOUSE_URL);
const TABLE = "postings_composed_test";

describe.skipIf(!hasCreds)("query_postings composed tool against the seeded reference dataset", () => {
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

  it("Should_AnswerComposedQuestion_When_NoTemplateFits: top companies in the US", async () => {
    const analytics = createAnalytics({ client: writer, table: TABLE });
    const emitted: EmitPart[] = [];
    const tools = buildCatalogTools({ analytics, emit: (p) => emitted.push(p) });

    const out = await tools.query_postings.execute!(
      { measures: ["count"], dimensions: ["company"], country: "United States", chartType: "bars" },
      { toolCallId: "composed-call", messages: [] } as never,
    );

    const insights = emitted.filter((p) => p.type === "data-insight");
    // Skeleton first (loading), filled insight last (same id) - the streaming contract.
    expect((insights[0].data as { status?: string }).status).toBe("loading");
    const insight = DataInsightSchema.parse(insights[insights.length - 1].data);

    // A composed chart insight was produced (not an empty/error part); the agent's fit pick is served.
    expect(insight.kind).toBe("chart");
    if (insight.kind === "chart") expect(insight.chartType).toBe("bars");

    // The revealed SQL carries the country filter (case-insensitive, 044 AC-1) AND the open-set predicate.
    expect(insight.meta.sql).toContain("lowerUTF8(country) = lowerUTF8('United States')");
    expect(insight.meta.sql).toContain(`ingested_at = (SELECT max(ingested_at) FROM ${TABLE})`);
    expect(insight.meta.openSet).toBe(true);

    // Honest headline: Google leads the US postings (4), from a positive sample.
    expect(insight.verdict).toContain("Google");
    expect(insight.verdict).toContain("4");
    expect(insight.meta.sampleN).toBeGreaterThan(0);

    // The RAW chart pick is recorded on the tool result (the eval harness reads it here).
    expect((out as { rawChartType?: string }).rawChartType).toBe("bars");
  });
});
