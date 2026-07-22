import { beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@clickhouse/client";
import {
  CLICKHOUSE_REQUEST_TIMEOUT_MS,
  createReadOnlyClient,
  createWriterClient,
} from "@shared/clickhouse";

vi.mock("@clickhouse/client", () => ({ createClient: vi.fn(() => ({})) }));

// ClickHouse Cloud idles the service and its wake exceeds the client's 30s request_timeout default -
// the first query after idle dies with a socket-pool "Timeout error" before the service is awake.
// Both clients must configure a request timeout that survives the wake, so a cold first query
// answers instead of erroring the turn.
describe("Should_ConfigureSixtySecondTimeout_When_ClientCreated (request_timeout)", () => {
  const writerEnv = {
    CLICKHOUSE_URL: "https://example.clickhouse.cloud:8443",
    CLICKHOUSE_USER: "default",
    CLICKHOUSE_PASSWORD: "test-password",
  };
  const roEnv = {
    CLICKHOUSE_URL: "https://example.clickhouse.cloud:8443",
    CLICKHOUSE_RO_USER: "jobchat_ro",
    CLICKHOUSE_RO_PASSWORD: "test-ro-password",
  };

  beforeEach(() => {
    vi.mocked(createClient).mockClear();
  });

  it("the shared timeout is 60s - past the 30s client default the idle wake overruns", () => {
    expect(CLICKHOUSE_REQUEST_TIMEOUT_MS).toBe(60_000);
  });

  it("the writer client configures the wake-surviving request_timeout", () => {
    createWriterClient(writerEnv);
    expect(vi.mocked(createClient)).toHaveBeenCalledWith(
      expect.objectContaining({ request_timeout: CLICKHOUSE_REQUEST_TIMEOUT_MS }),
    );
  });

  it("the read-only client configures the wake-surviving request_timeout", () => {
    createReadOnlyClient(roEnv);
    expect(vi.mocked(createClient)).toHaveBeenCalledWith(
      expect.objectContaining({ request_timeout: CLICKHOUSE_REQUEST_TIMEOUT_MS }),
    );
  });
});
