// @vitest-environment jsdom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The landing tagline's posting count goes LIVE from ClickHouse via a cached read (getLivePostingCount).
// A fixture count renders locale-formatted; a fetch failure (the reader returns null) renders the line
// WITHOUT a number - never a stale or invented count. The Server Component is called directly (a plain
// async function), its external reads mocked, mirroring the sibling landing-page unit test.
const hadE2EFlag = "JOBCHAT_E2E" in process.env;
const priorE2EFlag = process.env.JOBCHAT_E2E;
process.env.JOBCHAT_E2E = ""; // force the production (resolveViewer) branch, not the E2E fixture path
afterAll(() => {
  if (hadE2EFlag) process.env.JOBCHAT_E2E = priorE2EFlag;
  else delete process.env.JOBCHAT_E2E;
});

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: import("react").ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/server-store", () => ({
  resolveViewer: () => Promise.resolve({ signedIn: false }),
  listOwnerConversations: () => Promise.resolve([]),
}));
vi.mock("@/components/landing/LandingComposer", () => ({ LandingComposer: () => <div /> }));
vi.mock("@/components/landing/LandingSignIn", () => ({ LandingSignIn: () => <div /> }));

const livePostingCountMock = vi.fn(async (): Promise<number | null> => null);
vi.mock("@/lib/landing-count", () => ({ getLivePostingCount: () => livePostingCountMock() }));

import Landing from "@/app/page";

beforeEach(() => livePostingCountMock.mockReset());
afterEach(cleanup);

describe("Landing tagline live posting count (rider)", () => {
  it("renders the locale-formatted live count in the tagline", async () => {
    livePostingCountMock.mockResolvedValue(12345);
    render(await Landing());
    expect(screen.getByText(/from 12,345 live postings\./)).toBeTruthy();
  });

  it("renders the tagline WITHOUT a number when the count is unavailable (never stale/invented)", async () => {
    livePostingCountMock.mockResolvedValue(null);
    render(await Landing());
    expect(screen.getByText(/from live postings\./)).toBeTruthy();
    expect(screen.queryByText(/from \d[\d,]* live postings/)).toBeNull();
  });
});
