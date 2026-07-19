import { beforeEach, describe, expect, it, vi } from "vitest";

// mintChatToken (src/app/actions.ts) is the ONE piece of actions.ts with logic of its own - everything
// else is a thin pass-through to trigger/session.ts (tested in session.integration.test.ts) or e2e-owned
// (AC-12 guest cookie). This is the auth boundary the AI SDK transport (006) trusts: the token must be
// scoped read+write to the ONE conversation it was minted for, never broader. The Trigger.dev SDK is
// mocked (vi.hoisted so the mock factories can reference it) - this proves the scope SHAPE mintChatToken
// builds, not a live call; per the cost/safety guard, no real Trigger.dev API call happens here.
type PublicTokenArgs = { scopes: { read: { sessions: string }; write: { sessions: string } } };
const { createPublicToken } = vi.hoisted(() => ({
  createPublicToken: vi.fn<(args: PublicTokenArgs) => Promise<string>>(async () => "pat_mocked"),
}));

vi.mock("@trigger.dev/sdk", () => ({
  auth: { createPublicToken },
}));
// actions.ts also constructs a start-session action from this subpath at module load; stub it so
// importing actions.ts never touches the real SDK.
vi.mock("@trigger.dev/sdk/ai", () => ({
  chat: { createStartSessionAction: () => vi.fn() },
}));

import { mintChatToken } from "../../src/app/actions";

describe("mintChatToken", () => {
  beforeEach(() => {
    createPublicToken.mockClear();
  });

  it("scopes read+write to exactly the given conversation - no broader grant", async () => {
    const conversationId = "conv-under-test";
    const token = await mintChatToken(conversationId);

    expect(token).toBe("pat_mocked");
    expect(createPublicToken).toHaveBeenCalledTimes(1);
    const [args] = createPublicToken.mock.calls[0];
    // Would fail if the scope were widened (e.g. `sessions: true`) or narrowed to read-only.
    expect(args.scopes).toEqual({
      read: { sessions: conversationId },
      write: { sessions: conversationId },
    });
  });

  it("mints a distinct scope per conversation - one guest's token never grants another's session", async () => {
    await mintChatToken("conv-a");
    await mintChatToken("conv-b");

    const [[argsA], [argsB]] = createPublicToken.mock.calls;
    expect(argsA.scopes.read.sessions).toBe("conv-a");
    expect(argsB.scopes.read.sessions).toBe("conv-b");
    expect(argsA).not.toEqual(argsB);
  });
});
