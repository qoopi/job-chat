// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  persistedSessionIsStreaming,
  readPersistedSession,
  writePersistedSession,
} from "@/lib/chat-session-store";

// R1 (F1): the transport's per-conversation session state must survive a reload so `reconnectToStream`
// can resume a live turn (or no-op a settled one) and a follow-up subscribes from the persisted cursor
// instead of replaying the prior turn. This pins the browser-durable store the SDK's `onSessionChange`
// writes and the `sessions` hydration reads - keyed per conversation, cleared when the session closes.

const CHAT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

afterEach(() => window.sessionStorage.clear());

describe("chat-session-store", () => {
  it("round-trips a persisted session by conversation id", () => {
    writePersistedSession(CHAT, {
      publicAccessToken: "tok",
      lastEventId: "evt-42",
      isStreaming: true,
    });
    expect(readPersistedSession(CHAT)).toEqual({
      publicAccessToken: "tok",
      lastEventId: "evt-42",
      isStreaming: true,
    });
  });

  it("scopes storage per conversation - one id's state never leaks into another", () => {
    writePersistedSession(CHAT, { publicAccessToken: "tok-a", isStreaming: true });
    expect(readPersistedSession(OTHER)).toBeUndefined();
  });

  it("returns undefined when nothing is stored", () => {
    expect(readPersistedSession(CHAT)).toBeUndefined();
  });

  it("clears the stored key when the session closes (null)", () => {
    writePersistedSession(CHAT, { publicAccessToken: "tok", isStreaming: false });
    writePersistedSession(CHAT, null);
    expect(readPersistedSession(CHAT)).toBeUndefined();
  });

  it("treats a corrupt stored entry as no session (never throws)", () => {
    window.sessionStorage.setItem(`jobchat_session:${CHAT}`, "{not json");
    expect(readPersistedSession(CHAT)).toBeUndefined();
  });

  it("persistedSessionIsStreaming is true only for a mid-stream persisted session", () => {
    expect(persistedSessionIsStreaming(CHAT)).toBe(false); // nothing stored
    writePersistedSession(CHAT, { publicAccessToken: "tok", isStreaming: false });
    expect(persistedSessionIsStreaming(CHAT)).toBe(false); // settled
    writePersistedSession(CHAT, { publicAccessToken: "tok", isStreaming: true });
    expect(persistedSessionIsStreaming(CHAT)).toBe(true); // live
  });
});
