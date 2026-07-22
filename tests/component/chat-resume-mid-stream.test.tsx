// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { UIMessage, UIMessageChunk } from "ai";
import type { DataInsight } from "@shared/insight";

// Reloading mid-stream resumes the in-flight turn and completes the answer WITHOUT duplicating any
// earlier content. At reload the settled turns are hydrated from the store and the in-flight turn's user
// message is the tail (its answer is not persisted yet); the persisted session (isStreaming: true) drives
// useChat `resume` -> `reconnectToStream`, which streams the answer. This drives the real useChat merge
// against a transport whose reconnect replays that resumed turn, and asserts the settled card still
// renders exactly once. (The e2e fixture ends in a settled turn, so this seam is tested here - see
// tests/e2e/chat-resume.spec.ts.)

vi.mock("@/components/insight/charts/InsightChart", () => ({
  InsightChart: () => <div data-testid="chart-subtree" />,
}));

const RESUMED = "RESUMED-ANSWER completing after the reload.";
const resumedChunks: UIMessageChunk[] = [
  { type: "start", messageId: "resumed-assistant-1" } as UIMessageChunk,
  { type: "text-start", id: "r" } as UIMessageChunk,
  { type: "text-delta", id: "r", delta: RESUMED } as UIMessageChunk,
  { type: "text-end", id: "r" } as UIMessageChunk,
  { type: "finish" } as UIMessageChunk,
];

const reconnectMock = vi.fn(
  async () =>
    new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const c of resumedChunks) controller.enqueue(c);
        controller.close();
      },
    }),
);
const sendMessagesMock = vi.fn(
  async () => new ReadableStream<UIMessageChunk>({ start: (c) => c.close() }),
);

vi.mock("@/lib/chat-transport", () => ({
  useJobChatTransport: () => ({
    sendMessages: sendMessagesMock,
    reconnectToStream: reconnectMock,
    stopGeneration: vi.fn(async () => true),
  }),
}));

vi.mock("@/app/actions", () => ({
  sendMessage: vi.fn(),
  mintChatToken: vi.fn(async () => ({ ok: true, token: "tok" })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

import { ChatClient } from "@/components/chat/ChatClient";

const CONVERSATION_ID = "66666666-6666-4666-8666-666666666666";

const card: DataInsight = {
  id: "settled-card",
  kind: "chart",
  chartType: "bars",
  verdict: "Amazon leads hiring with 214 open roles.",
  series: [{ company: "Amazon", count: 214 }],
  followups: ["Only remote roles"],
  meta: { sql: "SELECT 1", sampleN: 3483, updatedAt: "2026-07-18 19:12:00" },
};

// A conversation reloaded mid-stream: one settled turn (Q1 + its card), then the in-flight turn's user
// message (Q2) - its answer was streaming and is not persisted yet.
const hydrated: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Top companies?" }] },
  {
    id: "a1",
    role: "assistant",
    parts: [{ type: "data-insight", id: "a1-card-0", data: card }],
  },
  { id: "u2", role: "user", parts: [{ type: "text", text: "And remote roles?" }] },
];

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  reconnectMock.mockClear();
  sendMessagesMock.mockClear();
});

test("Should_ResumeStreamWithoutDuplicating_When_ReloadedMidStream (AC-3)", async () => {
  // The persisted mid-stream session: `resume` is true, so useChat resumes via reconnectToStream on mount.
  window.sessionStorage.setItem(
    `jobchat_session:${CONVERSATION_ID}`,
    JSON.stringify({ publicAccessToken: "tok", isStreaming: true }),
  );

  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={hydrated}
      e2e={false}
    />,
  );

  // The in-flight turn resumes and completes.
  await waitFor(() => expect(reconnectMock).toHaveBeenCalled());
  expect(await screen.findByText(RESUMED)).toBeTruthy();

  // No earlier content duplicated: the settled card renders exactly once, each question exactly once.
  expect(document.querySelectorAll(".verdict")).toHaveLength(1);
  expect(
    screen.getAllByText("Top companies?", { selector: ".bubble.user" }),
  ).toHaveLength(1);
  expect(
    screen.getAllByText("And remote roles?", { selector: ".bubble.user" }),
  ).toHaveLength(1);
});
