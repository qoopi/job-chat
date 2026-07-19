// CLI: apply the ClickHouse migrations (migrations/clickhouse/*.sql). Run: bun run ch:migrate
import { applyClickhouseMigrations, createWriterClient } from "../shared/clickhouse";

const client = createWriterClient();
try {
  const applied = await applyClickhouseMigrations(client);
  console.log(`Applied ${applied.length} ClickHouse migration(s): ${applied.join(", ")}`);
} finally {
  await client.close();
}
