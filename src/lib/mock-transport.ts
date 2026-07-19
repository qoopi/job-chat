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
     * An optional persisted-tail replay for `reconnectToStream` (resume / reconnect). The real Trigger
     * transport, on a fresh reconnect with no `lastEventId` cursor, replays the session's `.out` log
     * from the start - which re-emits already-hydrated turns under their original ids. Set this to make
     * the mock reproduce that replay honestly. Absent -> reconnect no-ops (returns null), the default
     * every existing e2e path relies on (E2E arrival streams via `sendMessages`, never a reconnect).
     */
    __CHAT_REPLAY__?: ScriptStep[];
    /**
     * The PRIOR turn's `.out` chunks the server re-delivers on a follow-up `sendMessages` when the
     * subscription opens with NO `lastEventId` cursor (the real transport reads `state.lastEventId` as
     * the `.out` SSE cursor - undefined replays the session log from the start). Armed with this, the
     * mock prepends these chunks to the current turn's script IFF the session has no cursor, mirroring
     * the live-stream replay artifact (006). When the session DOES carry a cursor (the client threaded
     * the prior turn's `lastEventId` into `setSession`), the prior tail is suppressed - only the new
     * turn streams. Absent -> the current turn's script streams alone, as every existing path expects.
     */
    __CHAT_PRIOR_TAIL__?: ScriptStep[];
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
  lastEventId?: string;
}

export class MockChatTransport implements ChatTransport<UIMessage> {
  // Mirrors the real transport's per-chat session cache: `setSession`/`getSession` read and write it,
  // and `sendMessages` reads its `lastEventId` as the `.out` subscription cursor (see below).
  private readonly sessions = new Map<string, MockSession>();

  private next(): ScriptStep[] {
    return (typeof window !== "undefined" && window.__CHAT_SCRIPT__) || DEFAULT_SCRIPT;
  }

  sendMessages = async (
    options: { abortSignal?: AbortSignal; chatId?: string },
  ): Promise<ReadableStream<UIMessageChunk>> => {
    // Model the real transport's `.out` cursor exactly. `TriggerChatTransport.subscribeToSessionStream`
    // opens the SSE with `lastEventId: state.lastEventId`; when that cursor is undefined the server
    // replays the session log from the START, re-delivering the PRIOR turn's chunks ahead of this
    // turn's - the 006 live-stream artifact. A follow-up that threads the prior turn's `lastEventId`
    // into `setSession` (the fix) carries a cursor, so the prior tail is never re-sent.
    const cursor = options.chatId ? this.sessions.get(options.chatId)?.lastEventId : undefined;
    const prior = typeof window !== "undefined" ? window.__CHAT_PRIOR_TAIL__ : undefined;
    const script = prior && prior.length > 0 && !cursor ? [...prior, ...this.next()] : this.next();
    return replay(script, options.abortSignal);
  };

  reconnectToStream = async (): Promise<ReadableStream<UIMessageChunk> | null> => {
    // E2E arrival is driven by a mount-time send (not a resumed stream), so by default there is nothing
    // to reconnect to. When a test arms `__CHAT_REPLAY__`, replay it as the session's `.out` tail - the
    // honest way to reproduce the real transport's replay-on-reconnect (which re-delivers hydrated turns).
    const tail = typeof window !== "undefined" ? window.__CHAT_REPLAY__ : undefined;
    if (!tail || tail.length === 0) return null;
    return replay(tail, undefined);
  };

  // Session state parity with the real transport (the `JobChatTransport` seam ChatClient drives). E2E
  // arrival streams via `sendMessages`, so these are inert on the pure e2e path; they exist so the
  // non-e2e component tests exercise the SAME cursor-threading contract the production transport uses.
  getSession = (chatId: string): MockSession | undefined => this.sessions.get(chatId);

  setSession = (chatId: string, session: MockSession): void => {
    this.sessions.set(chatId, {
      publicAccessToken: session.publicAccessToken,
      isStreaming: session.isStreaming,
      lastEventId: session.lastEventId,
    });
  };
}
