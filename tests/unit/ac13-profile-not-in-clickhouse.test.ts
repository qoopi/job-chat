import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// AC-13 structural gate: the profile TYPE and FIELDS never enter the ClickHouse path. Profiles are
// Postgres-only; selection sends DERIVED filter VALUES (title terms, cities as plain strings) into CH
// inside whitelisted predicates - never the profile object. This gate greps the CH read/write/ingest
// files for any import of the profile module or its store symbols and fails if one appears. (The word
// "profile" itself is allowed - e.g. `coverageProfile`, the CORPUS profile, is a ClickHouse concept.)

// The files that build/execute ClickHouse SQL or ingest into it - the "ClickHouse path".
const CLICKHOUSE_PATH_FILES = [
  "shared/clickhouse.ts",
  "shared/analytics.ts",
  "shared/ingest.ts",
  "trigger/ingest.ts",
  "migrations/clickhouse/0001_postings.sql",
];

// Forbidden references: an import of the profile module, or a profile store/schema symbol.
const FORBIDDEN = [
  /from\s+["'](?:@shared\/profile|\.\.?\/(?:\.\.\/)?shared\/profile|\.\/profile)["']/,
  /\bProfileSchema\b/,
  /\bsaveProfileInputs\b/,
  /\bsaveExtractedProfile\b/,
  /\bappendProfileCard\b/,
  /\bgetProfile\b/,
  /\bdeleteProfile\b/,
];

describe("AC-13: no profile type/fields in the ClickHouse path", () => {
  for (const rel of CLICKHOUSE_PATH_FILES) {
    it(`${rel} does not import or reference the profile type`, () => {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      for (const pattern of FORBIDDEN) {
        expect(src, `${rel} must not match ${pattern}`).not.toMatch(pattern);
      }
    });
  }
});
