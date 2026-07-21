import { describe, expect, it } from "vitest";
import {
  persistedSessionIsStreaming,
  readPersistedSession,
  writePersistedSession,
} from "@/lib/chat-session-store";

// R1: this module is imported into client components that ALSO render on the server, where `window` is
// undefined - every accessor must no-op / return a safe default there instead of throwing, or a chat
// page render would crash on the server (the module's own SSR-guard comment; task requirement 1). This
// file runs in vitest's DEFAULT "node" environment (no jsdom docblock), so `window` is genuinely absent
// - unlike chat-session-store.test.ts, which opts into jsdom and so never exercises this branch.
describe("chat-session-store - SSR guard (no window)", () => {
  it("confirms this file actually runs with no window (the guard's real precondition)", () => {
    expect(typeof window).toBe("undefined");
  });

  it("readPersistedSession returns undefined on the server, never throws", () => {
    expect(() => readPersistedSession("any-chat")).not.toThrow();
    expect(readPersistedSession("any-chat")).toBeUndefined();
  });

  it("writePersistedSession no-ops on the server, never throws", () => {
    expect(() =>
      writePersistedSession("any-chat", {
        publicAccessToken: "tok",
        isStreaming: true,
      }),
    ).not.toThrow();
    expect(() => writePersistedSession("any-chat", null)).not.toThrow();
  });

  it("persistedSessionIsStreaming is false on the server, never throws", () => {
    expect(() => persistedSessionIsStreaming("any-chat")).not.toThrow();
    expect(persistedSessionIsStreaming("any-chat")).toBe(false);
  });
});
