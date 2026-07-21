// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { UIMessage } from "ai";
import type { DataInsight } from "@shared/insight";
import { setAuthDialogOpen } from "@/lib/layers";

// AC-8/AC-9: the table Left Chat Part, driven through the REAL ChatClient (its lcpTarget state, the
// dock, and the close paths are what is under test). The transport + server action are external
// boundaries and mocked exactly as chat-client.test.tsx does; here no turn is sent, so they are inert.
const setSessionMock = vi.fn();
const reconnectMock = vi.fn(async () => null);
const sendMessagesMock = vi.fn(
  async () => new ReadableStream({ start: (c) => c.close() }),
);
const getSessionMock = vi.fn(() => undefined);
vi.mock("@/lib/chat-transport", () => ({
  useJobChatTransport: () => ({
    sendMessages: sendMessagesMock,
    reconnectToStream: reconnectMock,
    setSession: setSessionMock,
    getSession: getSessionMock,
  }),
}));
vi.mock("@/app/actions", () => ({
  sendMessage: vi.fn(),
  mintChatToken: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

import { ChatClient } from "@/components/chat/ChatClient";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

function tableInsight(n: number): DataInsight {
  return {
    id: "t1",
    kind: "table",
    verdict: "Amazon leads hiring across the market.",
    rows: Array.from({ length: n }, (_, i) => ({
      company: `Co ${i + 1}`,
      count: 100 - i,
    })),
    followups: [],
    meta: { sql: "SELECT 1", sampleN: 3483, updatedAt: "2026-07-18 19:12:00" },
  };
}

function threadWithTable(n: number): UIMessage[] {
  return [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Top companies?" }],
    },
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "data-insight", id: "a1-c0", data: tableInsight(n) }],
    },
  ];
}

const lcpRows = () =>
  document.querySelector(".lcp")?.querySelectorAll("tbody tr").length ?? 0;
const composer = () =>
  screen.getByRole("textbox", {
    name: "Ask a follow-up",
  }) as HTMLTextAreaElement;
// The Esc listener is on `window`; dispatch there and wrap in act so React flushes the close.
const pressEsc = () =>
  act(
    () =>
      void window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape" }),
      ),
  );

async function openLcp(rows: number) {
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={threadWithTable(rows)}
      e2e={false}
    />,
  );
  const affordance = await screen.findByRole("button", {
    name: `Open full table (${rows} rows)`,
  });
  fireEvent.click(affordance);
}

afterEach(() => {
  cleanup();
  setAuthDialogOpen(false); // reset the module-level layer seam between cases
});

describe("table LCP (AC-8)", () => {
  test("Should_PreviewAndOpenLcp_When_TableExceedsThreshold", async () => {
    render(
      <ChatClient
        conversationId={CONVERSATION_ID}
        initialMessages={threadWithTable(9)}
        e2e={false}
      />,
    );

    // In-thread: a 5-row preview + affordance; the LCP is not open yet, the canvas is not docked.
    const affordance = await screen.findByRole("button", {
      name: "Open full table (9 rows)",
    });
    expect(document.querySelector(".lcp")).toBeNull();
    expect(document.querySelector(".canvas.docked")).toBeNull();

    fireEvent.click(affordance);

    // The LCP opens with the FULL 9-row body and the chat docks to the right rail.
    expect(document.querySelector(".lcp")).toBeTruthy();
    expect(lcpRows()).toBe(9);
    expect(document.querySelector(".canvas.docked")).toBeTruthy();
  });

  test("Should_NotOpenLcp_When_TableAtThreshold", async () => {
    render(
      <ChatClient
        conversationId={CONVERSATION_ID}
        initialMessages={threadWithTable(8)}
        e2e={false}
      />,
    );
    await screen.findByText("Top companies?");
    expect(
      screen.queryByRole("button", { name: /Open full table/ }),
    ).toBeNull();
    expect(document.querySelector(".lcp")).toBeNull();
  });
});

describe("table LCP close paths (AC-9)", () => {
  test.each([
    [
      "close control",
      () =>
        fireEvent.click(
          screen.getByRole("button", { name: "Close full table" }),
        ),
    ],
    ["Esc", () => pressEsc()],
    [
      "New chat",
      () => fireEvent.click(screen.getByRole("button", { name: "New chat" })),
    ],
  ])("Should_CloseLcp_OnEachCloseTrigger: %s", async (_label, act) => {
    await openLcp(9);
    expect(document.querySelector(".lcp")).toBeTruthy();
    expect(composer().disabled).toBe(false); // composer stays usable while the LCP is open

    act();

    expect(document.querySelector(".lcp")).toBeNull();
    expect(document.querySelector(".canvas.docked")).toBeNull();
    expect(composer().disabled).toBe(false);
  });

  test("Should_RouteEscToAuthDialog_When_DialogAboveLcp", async () => {
    await openLcp(9);
    expect(document.querySelector(".lcp")).toBeTruthy();

    // The dialog-open flag is the seam until 013's real auth dialog exists: with it forced true, the
    // dialog is topmost and consumes Esc, so the LCP stays open (interaction-spec layer priority).
    setAuthDialogOpen(true);
    pressEsc();
    expect(document.querySelector(".lcp")).toBeTruthy();

    // Once the dialog is gone, Esc closes the LCP again.
    setAuthDialogOpen(false);
    pressEsc();
    expect(document.querySelector(".lcp")).toBeNull();
  });
});

// refresh #2 s7: the account menu's "Your profile" opens the profile empty state in the LCP (docking the
// chat), and it closes on the LCP close paths just like a table.
describe("profile LCP (refresh #2 s7)", () => {
  test("'Your profile' opens the profile empty state in the LCP; Esc closes it", () => {
    render(
      <ChatClient
        conversationId={CONVERSATION_ID}
        initialMessages={[]}
        e2e={false}
        signedIn
        accountName="Ada"
        accountEmail="ada@example.com"
      />,
    );
    expect(document.querySelector(".lcp")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Account: Ada/ })); // open the account menu
    fireEvent.click(screen.getByRole("button", { name: "Your profile" }));

    // the designed empty state is open and the canvas docks
    expect(screen.getByText("No profile yet")).toBeTruthy();
    expect(screen.getByText(/coming soon/i)).toBeTruthy(); // the dropzone accepts no upload yet (P2)
    expect(document.querySelector(".canvas.docked")).toBeTruthy();

    pressEsc();
    expect(screen.queryByText("No profile yet")).toBeNull();
    expect(document.querySelector(".canvas.docked")).toBeNull();
  });

  test("profileOnArrival opens the profile on mount (landing 'Your profile' -> /chat/new?profile=1, s10)", () => {
    render(
      <ChatClient
        conversationId={CONVERSATION_ID}
        initialMessages={[]}
        e2e={false}
        newChat
        signedIn
        accountName="Ada"
        profileOnArrival
      />,
    );
    expect(screen.getByText("No profile yet")).toBeTruthy();
    expect(document.querySelector(".canvas.docked")).toBeTruthy();
  });

  test("opening a table LCP replaces the open profile (one LCP at a time)", () => {
    render(
      <ChatClient
        conversationId={CONVERSATION_ID}
        initialMessages={threadWithTable(9)}
        e2e={false}
        signedIn
        accountName="Ada"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Account: Ada/ }));
    fireEvent.click(screen.getByRole("button", { name: "Your profile" }));
    expect(screen.getByText("No profile yet")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Open full table (9 rows)" }),
    );
    expect(screen.queryByText("No profile yet")).toBeNull(); // the profile gave way to the table
    expect(document.querySelector(".lcp")).toBeTruthy();
  });

  // Audit (05-testing): the mutual-exclusion pair above only exercised profile-then-table. Ruling 3 (one
  // panel, one at a time) must hold in the OTHER direction too - opening the profile while a table LCP is
  // already open must replace it, not stack a second panel.
  test("opening the profile replaces an open table LCP (reverse direction, one at a time)", () => {
    render(
      <ChatClient
        conversationId={CONVERSATION_ID}
        initialMessages={threadWithTable(9)}
        e2e={false}
        signedIn
        accountName="Ada"
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open full table (9 rows)" }),
    );
    expect(screen.getByRole("region", { name: "Full table" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Account: Ada/ }));
    fireEvent.click(screen.getByRole("button", { name: "Your profile" }));

    // the table gave way to the profile - only one LCP body at a time
    expect(screen.queryByRole("region", { name: "Full table" })).toBeNull();
    expect(screen.getByRole("region", { name: "Your profile" })).toBeTruthy();
  });
});

// Audit (05-testing, ruling 4): "the account menu is a transient - Esc/outside-click closes the MENU
// first when open (menu > LCP; dialog > menu)". Both the LCP's table view and the profile view dock the
// canvas but the TitleBar (and its account menu) stay mounted throughout, so a user CAN have the menu open
// above an open LCP. A single Esc must close only the topmost layer (the menu), leaving the LCP for a
// second Esc - exactly like the dialog-above-LCP case already covered in auth-dialog.test.tsx.
describe("Esc layer priority: account menu above the LCP (ruling 4)", () => {
  test("Should_CloseMenuFirst_LeavingLcpOpen_When_BothAreOpen", async () => {
    render(
      <ChatClient
        conversationId={CONVERSATION_ID}
        initialMessages={threadWithTable(9)}
        e2e={false}
        signedIn
        accountName="Ada"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open full table (9 rows)" }),
    );
    expect(document.querySelector(".lcp")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Account: Ada/ }));
    expect(screen.getByText("Personal account")).toBeTruthy();

    pressEsc();
    // the menu (topmost) closes on this Esc; the LCP beneath it must stay open
    expect(screen.queryByText("Personal account")).toBeNull();
    expect(document.querySelector(".lcp")).toBeTruthy();

    pressEsc(); // with the menu gone, Esc now reaches the LCP
    expect(document.querySelector(".lcp")).toBeNull();
  });
});
