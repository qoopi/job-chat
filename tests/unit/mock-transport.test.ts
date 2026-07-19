// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { MockChatTransport } from "@/lib/mock-transport";

// AC-9 (stop keeps partial) depends entirely on the E2E mock transport honoring the abort signal: the
// "ai" package's consumeStream() just loops `reader.read()` until the stream itself closes/errors - it
// never independently cancels the reader on abort (checked in node_modules/ai/dist/index.js: stop() only
// calls `abortController.abort()`; the read loop has no signal listener of its own). So if this mock's
// ReadableStream ignored the signal, clicking Stop would leave the composer disabled until the NEXT
// chunk's delay elapsed regardless. The e2e spec (live-chat-loop.spec.ts AC-9) only proves this
// indirectly, by racing Playwright's default 5s assertion timeout against a 10s hang chunk - this test
// proves it directly and fast: read past the abort point and confirm the stream closes WITHOUT ever
// enqueueing the chunk that was scheduled after it.
describe("MockChatTransport - honors the caller's AbortSignal (AC-9)", () => {
  it("stops emitting further chunks once the caller aborts mid-stream", async () => {
    window.__CHAT_SCRIPT__ = [
      { chunk: { type: "start" } },
      { chunk: { type: "text-delta", id: "t", delta: "partial" }, delayMs: 5 },
      // scheduled well after the abort; must never be observed by the reader below
      { chunk: { type: "text-delta", id: "t", delta: " MORE-AFTER-ABORT" }, delayMs: 10_000 },
      { chunk: { type: "finish" } },
    ];

    const transport = new MockChatTransport();
    const controller = new AbortController();
    const stream = await transport.sendMessages({ abortSignal: controller.signal });
    const reader = stream.getReader();

    const seen: unknown[] = [];
    seen.push((await reader.read()).value);
    seen.push((await reader.read()).value);

    // by now the executor is inside the 10s delay for the third step - abort it
    controller.abort();
    const next = await reader.read();

    expect(seen).toEqual([{ type: "start" }, { type: "text-delta", id: "t", delta: "partial" }]);
    expect(next.done).toBe(true); // the stream closed on abort, not on the hang chunk
  });

  it("emits the full script untouched when never aborted (control case)", async () => {
    window.__CHAT_SCRIPT__ = [
      { chunk: { type: "start" } },
      { chunk: { type: "text-end", id: "t" } },
      { chunk: { type: "finish" } },
    ];
    const transport = new MockChatTransport();
    const stream = await transport.sendMessages({ abortSignal: new AbortController().signal });
    const reader = stream.getReader();

    const chunks: unknown[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    expect(chunks).toEqual([{ type: "start" }, { type: "text-end", id: "t" }, { type: "finish" }]);
  });
});
