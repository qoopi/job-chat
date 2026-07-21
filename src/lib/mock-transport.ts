"use client";

import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";

// The E2E transport. `useChat` accepts any `ChatTransport`; in E2E mode we swap the real Trigger.dev
// transport for this one, which replays a scripted `UIMessageChunk` sequence the Playwright spec pins
// on `window.__CHAT_SCRIPT__` before each send. That keeps the whole client loop (streaming, skeleton
// reconciliation, stop, retry) exercisable against the built app with ZERO Trigger.dev / Bedrock calls
// - the one thing the automated suite must never touch. The real integration is the manual smoke.

export interface ScriptStep {
  chunk: UIMessageChunk;
  /** Wait this long (ms) BEFORE emitting the chunk - lets a spec observe the skeleton / stop mid-stream. */
  delayMs?: number;
}

declare global {
  interface Window {
    /** The next turn's chunk script (consumed by `sendMessages`). Set by the e2e spec before a send. */
    __CHAT_SCRIPT__?: ScriptStep[];
    /**
     * An optional persisted-tail replay for `reconnectToStream` (resume of a still-streaming turn).
     * When a test arms it, the mock replays it as the session's `.out` tail - the honest way to
     * reproduce the real transport's resume-of-live-turn. Absent (or when the persisted session is
     * settled) -> reconnect no-ops (returns null), the default every existing e2e path relies on.
     */
    __CHAT_REPLAY__?: ScriptStep[];
  }
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

function replay(script: ScriptStep[], signal: AbortSignal | undefined): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      for (const step of script) {
        if (signal?.aborted) break; // stop() aborts: leave the partial answer already enqueued (AC-9)
        if (step.delayMs) await abortableSleep(step.delayMs, signal);
        if (signal?.aborted) break;
        controller.enqueue(step.chunk);
      }
      controller.close();
    },
  });
}

/** A tiny default so a bare send still streams a visible answer if a spec forgot to set a script. */
const DEFAULT_SCRIPT: ScriptStep[] = [
  { chunk: { type: "start" } as UIMessageChunk },
  { chunk: { type: "text-start", id: "t" } as UIMessageChunk },
  { chunk: { type: "text-delta", id: "t", delta: "OK." } as UIMessageChunk },
  { chunk: { type: "text-end", id: "t" } as UIMessageChunk },
  { chunk: { type: "finish" } as UIMessageChunk },
];

interface MockSession {
  publicAccessToken: string;
  isStreaming?: boolean;
}

export class MockChatTransport implements ChatTransport<UIMessage> {
  // The per-chat session state the arrival attach writes via `setSession`. `reconnectToStream` reads its
  // `isStreaming` flag: a settled session no-ops (as the real transport does), a live one may resume.
  private readonly sessions = new Map<string, MockSession>();

  private next(): ScriptStep[] {
    return (typeof window !== "undefined" && window.__CHAT_SCRIPT__) || DEFAULT_SCRIPT;
  }

  sendMessages = async (
    options: { abortSignal?: AbortSignal; chatId?: string },
  ): Promise<ReadableStream<UIMessageChunk>> => {
    // The transport owns the `.out` cursor internally now (R1/F1), so a follow-up subscribes from the
    // right point with no app-level threading: the mock just streams this turn's scripted chunks.
    return replay(this.next(), options.abortSignal);
  };

  reconnectToStream = async (
    options: { chatId?: string },
  ): Promise<ReadableStream<UIMessageChunk> | null> => {
    // Honor the persisted session: a settled turn (isStreaming: false) must not replay anything on a
    // reload - reconnect no-ops, exactly as the real transport does.
    if (options.chatId && this.sessions.get(options.chatId)?.isStreaming === false) return null;
    // Resume of a still-streaming turn: when a test arms `__CHAT_REPLAY__`, replay it as the `.out` tail
    // (the real transport's resume-of-live-turn). Absent -> nothing to reconnect to.
    const tail = typeof window !== "undefined" ? window.__CHAT_REPLAY__ : undefined;
    if (!tail || tail.length === 0) return null;
    return replay(tail, undefined);
  };

  // The arrival attach hydrates a freshly-minted token + `isStreaming` so `reconnectToStream` resumes
  // the just-triggered run (inert on the pure e2e path, which streams arrival via `sendMessages`).
  setSession = (chatId: string, session: MockSession): void => {
    this.sessions.set(chatId, {
      publicAccessToken: session.publicAccessToken,
      isStreaming: session.isStreaming,
    });
  };

  // Stop's backend signal. E2E has no backend and the AI SDK stop already aborts the scripted stream, so
  // this is inert here - it exists so the client's Stop path drives the SAME transport contract as prod.
  stopGeneration = async (): Promise<boolean> => true;
}
