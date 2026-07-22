import { afterAll, describe, expect, it, vi } from "vitest";

// The fixtures seam, symmetric with chat-transport.test.ts. The chat shell
// (chat/[id]/page.tsx) statically imports `e2eFixtureThread` from the production stub
// `src/lib/e2e-fixtures.ts`, whose body throws unconditionally ("e2eFixtureThread is available only in an
// E2E build"). The stub is safe only because page.tsx calls it behind the `e2e` flag (isE2E(), always
// false in prod) - the prod-never-calls-it half is already proven by chat-page-resume-gate.test.ts (it
// drives ChatPage with JOBCHAT_E2E="" through every branch and never throws). This file proves the OTHER
// half, exactly as the transport test does: the stub's throw is a real fail-closed guard, and page.tsx's
// fixtures seam resolves to the STUB without the build-time alias in place - the precise reason the
// Playwright e2e build needs next.config's turbopack.resolveAlias swap, not a runtime import.

// ChatClient pulls in @ai-sdk/react; server-store touches postgres/next-headers at import. Neither is
// reached in the e2e branch before e2eFixtureThread throws - stubbed only so importing the page module is
// side-effect-free (identical boundaries to chat-page-resume-gate.test.ts).
vi.mock("@/components/chat/ChatClient", () => ({
  ChatClient: (props: Record<string, unknown>) => ({ type: "ChatClient", props }),
}));
vi.mock("@/lib/server-store", () => ({
  loadConversation: vi.fn(),
  listOwnerConversations: vi.fn(),
  resolveViewer: vi.fn(),
}));

import { e2eFixtureThread } from "@/lib/e2e-fixtures";
import ChatPage from "@/app/chat/[id]/page";

const FIXTURE_ID = "00000000-0000-4000-8000-000000000000";

const hadE2EFlag = "JOBCHAT_E2E" in process.env;
const priorE2EFlag = process.env.JOBCHAT_E2E;
afterAll(() => {
  if (hadE2EFlag) process.env.JOBCHAT_E2E = priorE2EFlag;
  else delete process.env.JOBCHAT_E2E;
});

describe("e2eFixtureThread stub - the E2E-only fail-closed guard (027 review-fix)", () => {
  it("throws when called directly: the prod stub carries zero fixture data", () => {
    expect(() => e2eFixtureThread(FIXTURE_ID)).toThrow(
      /e2eFixtureThread is available only in an E2E build/,
    );
  });

  // Mirrors chat-transport.test.ts's "e2e=true without the build-time alias hits the stub's throw": with
  // no Turbopack resolveAlias in a plain vitest run, page.tsx's `@/lib/e2e-fixtures` import IS the prod
  // stub, so resuming a fixture id under the e2e flag reaches its fail-closed throw - the exact reason the
  // real e2e build must alias-swap the seam, not flip a runtime flag alone.
  it("e2e page (JOBCHAT_E2E=1) resuming a fixture id hits the stub's fail-closed throw", async () => {
    process.env.JOBCHAT_E2E = "1";
    await expect(
      ChatPage({
        params: Promise.resolve({ id: FIXTURE_ID }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow(/e2eFixtureThread is available only in an E2E build/);
  });
});
