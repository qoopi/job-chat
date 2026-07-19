// CLI: apply the Postgres migrations (migrations/*.sql) in filename order. Run: bun run pg:migrate
// Mirrors scripts/ch-migrate.ts for the OLTP side. Statements are idempotent (CREATE TABLE IF NOT
// EXISTS), so re-running is safe. A file may hold several statements; postgres.js needs the simple
// query protocol (.simple()) to send more than one command per round-trip.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
try {
  for (const file of files) {
    await sql.unsafe(readFileSync(join(dir, file), "utf8")).simple();
    console.log(`Applied ${file}`);
  }
  console.log(`Applied ${files.length} Postgres migration(s): ${files.join(", ")}`);
} finally {
  await sql.end();
}
