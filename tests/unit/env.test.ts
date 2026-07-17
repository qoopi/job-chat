import { describe, expect, it } from "vitest";
import { getEnv, resetEnvCache } from "../../src/lib/env";

const complete: Record<string, string> = {
  TRIGGER_SECRET_KEY: "tr_dev_x",
  CLICKHOUSE_URL: "https://example.clickhouse.cloud:8443",
  CLICKHOUSE_USER: "default",
  CLICKHOUSE_PASSWORD: "secret",
  DATABASE_URL: "postgres://user:pass@host:5432/jobchat",
  AWS_REGION: "eu-central-1",
  AWS_ACCESS_KEY_ID: "AKIA_TEST",
  AWS_SECRET_ACCESS_KEY: "test",
  SEARCHNAPPLY_API_URL: "https://api.searchnapply.com",
  SEARCHNAPPLY_API_KEY: "sn_test",
};

describe("getEnv", () => {
  it("fails fast naming the missing variable", () => {
    const incomplete = { ...complete };
    delete incomplete.CLICKHOUSE_URL;
    resetEnvCache();
    expect(() => getEnv(incomplete)).toThrowError(/CLICKHOUSE_URL/);
  });

  it("returns the parsed config when all variables are present", () => {
    resetEnvCache();
    expect(getEnv(complete).CLICKHOUSE_URL).toBe(complete.CLICKHOUSE_URL);
  });
});
