import { describe, expect, it, vi } from "vitest";

// The system block is marked as a Bedrock prompt-cache point. The
// toStreamTextOptions `systemProviderOptions` route SILENTLY NO-OPS in our wiring (the SDK builds a
// system block only when chat.prompt.set() was used, and our explicit `system:` after the spread
// overrides it anyway), so the cache point must ride a STRUCTURED SystemModelMessage passed straight
// to streamText. This test asserts the structured message actually REACHES streamText - asserting an
// option was passed to toStreamTextOptions would pass on the silent no-op.
const streamTextSpy = vi.fn<(opts: unknown) => unknown>(() => ({}));
vi.mock("ai", () => ({
  streamText: (opts: unknown) => streamTextSpy(opts),
  stepCountIs: (n: number) => n,
}));

// Keep the SDK inert: agent registration returns its config, toStreamTextOptions contributes nothing,
// so the only `system` streamText sees is the one streamModel builds.
vi.mock("@trigger.dev/sdk/ai", () => ({
  chat: {
    agent: (cfg: unknown) => cfg,
    toStreamTextOptions: () => ({}),
    response: { write: () => {} },
  },
}));

import { streamModel } from "../../trigger/chat";

describe("Should_PassStructuredSystemWithCachePoint_When_ModelCalled", () => {
  it("passes the STRUCTURED system message (bedrock cachePoint) to streamText, not a bare string", () => {
    streamModel({
      system: "SYSTEM PROMPT",
      messages: [],
      tools: {},
      signal: new AbortController().signal,
    });

    expect(streamTextSpy).toHaveBeenCalledOnce();
    const opts = streamTextSpy.mock.calls[0][0] as { system: unknown };
    // The structured SystemModelMessage the SDK itself emits for a provider cache point - not a bare
    // string, and not an option quietly dropped by toStreamTextOptions.
    expect(opts.system).toEqual({
      role: "system",
      content: "SYSTEM PROMPT",
      providerOptions: { bedrock: { cachePoint: { type: "default" } } },
    });
  });
});
