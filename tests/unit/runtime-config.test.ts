import { describe, expect, it } from "vitest";
import { getAgentLimits, getGuardConfig } from "@shared/env";

// AC-17 (config slice) + guard config. These accessors read only their own env slice (ISP), so the
// server actions and the agent can read them WITHOUT the AWS/ClickHouse creds getEnv() requires -
// and they fall back to the conservative defaults from the epic when the vars are unset.

describe("getGuardConfig", () => {
  it("defaults to guest cap 10 and daily budget 200 when unset", () => {
    expect(getGuardConfig({})).toEqual({ guestCap: 10, dailyBudget: 200 });
  });

  it("reads and coerces overrides from the (string) environment", () => {
    expect(getGuardConfig({ GUEST_MESSAGE_CAP: "3", DAILY_MESSAGE_BUDGET: "50" })).toEqual({
      guestCap: 3,
      dailyBudget: 50,
    });
  });
});

describe("getAgentLimits", () => {
  it("defaults to maxTurns 10 and maxSteps 8 when unset (AC-17)", () => {
    expect(getAgentLimits({})).toEqual({ maxTurns: 10, maxSteps: 8 });
  });

  it("reads and coerces overrides from the (string) environment", () => {
    expect(getAgentLimits({ AGENT_MAX_TURNS: "4", AGENT_MAX_STEPS: "2" })).toEqual({
      maxTurns: 4,
      maxSteps: 2,
    });
  });
});
