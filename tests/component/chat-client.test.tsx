// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { UIMessage } from "ai";

// ChatClient.send() has TWO distinct paths that can produce a cap/budget refusal (decision 19 / 004
// handoff): the E2E/agent-side path (the transport streams a `data-refusal` part mid-run - covered by
// e2e `live-chat-loop.spec.ts::AC-15`) and the PROD action-side path (the `sendMessage` server action
// itself returns `{ ok: false, reason }` BEFORE any run starts, and ChatClient synthesizes the same
// `data-refusal` part via `setMessages`). Only the first path had a test; this closes the gap on the
// second one - it must render the identical notice, through the identical MessageList/RefusalNotice
// path, not a bespoke banner. The real transport and server action are mocked (external boundaries);
// ChatClient's own branching is what is under test.
//
// It also proves the send contract after R1/R2: the follow-up send threads NO session state - the
// transport owns the `.out` cursor and refreshes its token via `accessToken`, so `send` never calls
// `setSession`. A follow-up delivers + watches via `sendMessages` (the only SDK path that streams a
// freshly-triggered turn live); the peekSettled `reconnectToStream` is NOT used for follow-ups. Arrival
// still attaches via `setSession` + `reconnectToStream` (resumeStream on an in-flight run; 024 removes
// it). All three are spied.
const setSessionMock = vi.fn();
const reconnectMock = vi.fn(async () => null);
const sendMessagesMock = vi.fn(
  async () => new ReadableStream({ start: (c) => c.close() }),
);
vi.mock("@/lib/chat-transport", () => ({
  useJobChatTransport: () => ({
    sendMessages: sendMessagesMock,
    reconnectToStream: reconnectMock,
    setSession: setSessionMock,
  }),
}));

const sendMessageMock = vi.fn();
const mintChatTokenMock = vi.fn();
vi.mock("@/app/actions", () => ({
  sendMessage: (conversationId: string, text: string) =>
    sendMessageMock(conversationId, text),
  mintChatToken: (conversationId: string) => mintChatTokenMock(conversationId),
}));

const routerReplaceMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: routerReplaceMock }),
}));

import { ChatClient } from "@/components/chat/ChatClient";
import { closeAuthDialog } from "@/lib/auth-dialog";

const CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  cleanup();
  closeAuthDialog(); // a guest cap refusal auto-opens the shared auth dialog (module singleton) - reset it
  sendMessageMock.mockReset();
  mintChatTokenMock.mockReset();
  setSessionMock.mockClear();
  reconnectMock.mockClear();
  sendMessagesMock.mockClear();
  routerReplaceMock.mockClear();
});

test("action-refusal: the sendMessage action's cap refusal renders the SAME register card as the agent-side refusal", async () => {
  sendMessageMock.mockResolvedValue({ ok: false, reason: "guest_cap" });
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={[]}
      e2e={false}
    />,
  );

  const box = screen.getByRole("textbox", { name: "Ask a follow-up" });
  fireEvent.change(box, { target: { value: "One more question" } });
  fireEvent.keyDown(box, { key: "Enter" });

  expect(await screen.findByText(/reached the guest limit/i)).toBeTruthy(); // refresh #2 s8 register card
  expect(document.querySelector(".register-card")).toBeTruthy();
  expect(document.querySelector(".err-card")).toBeNull();
  expect(sendMessageMock).toHaveBeenCalledWith(
    CONVERSATION_ID,
    "One more question",
  );
  // A refusal short-circuits BEFORE any attach - the transport must never be touched.
  expect(setSessionMock).not.toHaveBeenCalled();
});

test("action-refusal: an ok send does NOT render a notice (control case)", async () => {
  sendMessageMock.mockResolvedValue({
    ok: true,
    conversationId: CONVERSATION_ID,
    messageId: "m1",
    publicAccessToken: "tok",
    runId: "run1",
  });
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={[]}
      e2e={false}
    />,
  );

  const box = screen.getByRole("textbox", { name: "Ask a follow-up" });
  fireEvent.change(box, { target: { value: "A normal question" } });
  fireEvent.keyDown(box, { key: "Enter" });

  await screen.findByText("A normal question"); // the optimistic user bubble renders
  expect(document.querySelector(".notice")).toBeNull();
});

// --- AC-22: optimistic echo (the user bubble renders at composer-clear time, not after the round trip) ---

test("Should_EchoUserBubbleSynchronously_When_Sent: the user bubble renders before any transport round trip; the server echo reconciles to one", async () => {
  // Hold the gate unresolved - the bubble must appear WITHOUT waiting for the server round trip (the
  // ~6s run-wake floor). Nothing is hydrated on the transport yet either.
  let release: (v: unknown) => void = () => {};
  sendMessageMock.mockReturnValue(new Promise((res) => (release = res)));
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={[]}
      e2e={false}
    />,
  );

  const box = screen.getByRole("textbox", { name: "Ask a follow-up" });
  fireEvent.change(box, { target: { value: "Median salary in Berlin?" } });
  fireEvent.keyDown(box, { key: "Enter" });

  // Synchronously present, before the gate resolves and before the transport is hydrated.
  expect(screen.getByText("Median salary in Berlin?")).toBeTruthy();
  expect(screen.getByRole("status", { name: "Answering" })).toBeTruthy(); // indicator follows immediately
  expect(setSessionMock).not.toHaveBeenCalled();

  // The gate passes: the SDK's sendMessage({ messageId }) replaces the SAME optimistic id in place (and
  // reconcileMessagesById is the backstop), so the server echo yields EXACTLY ONE bubble, no duplicate.
  release({ ok: true, publicAccessToken: "tok" });
  await waitFor(() => expect(sendMessagesMock).toHaveBeenCalled());
  expect(screen.getAllByText("Median salary in Berlin?")).toHaveLength(1);
});

// Gap closed in 05-testing: the dev's Completion Report claimed the refusal/failure rollback was covered
// by the test above, but that test only exercises the happy path - it never asserts the bubble is gone
// after a refusal or a thrown send. Pseudo-mutation check: commenting out both `rollbackEcho()` call
// sites left all 6 pre-existing tests in this file green, proving the orphan-bubble regression had no
// test that would catch it. These two close that gap (flow C: a blocked/failed message is not shown as sent).
test("Should_RollbackOptimisticBubble_When_SendRefused: a cap/budget refusal removes the optimistic bubble, not just shows the notice", async () => {
  sendMessageMock.mockResolvedValue({ ok: false, reason: "guest_cap" });
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={[]}
      e2e={false}
    />,
  );

  const box = screen.getByRole("textbox", { name: "Ask a follow-up" });
  fireEvent.change(box, { target: { value: "Refused question" } });
  fireEvent.keyDown(box, { key: "Enter" });

  expect(screen.getByText("Refused question")).toBeTruthy(); // the optimistic bubble is up first

  await screen.findByText(/reached the guest limit/i); // the refusal (register card) lands
  // The optimistic bubble must be gone - not orphaned as a "sent" message the refusal contradicts. Scoped
  // to the bubble class (not a bare queryByText): AC-11 correctly restores the same text into the
  // composer's textarea, which a bare document-wide text query would also match and hide the regression.
  expect(
    screen.queryByText("Refused question", { selector: ".bubble.user" }),
  ).toBeNull();
  expect(document.querySelectorAll(".msg.user")).toHaveLength(0);
});

test("Should_RollbackOptimisticBubble_When_SendThrows: a thrown/failed send removes the optimistic bubble (toast + draft, not a stuck bubble)", async () => {
  sendMessageMock.mockRejectedValue(new Error("network down"));
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={[]}
      e2e={false}
    />,
  );

  const box = screen.getByRole("textbox", { name: "Ask a follow-up" });
  fireEvent.change(box, { target: { value: "Send that will fail" } });
  fireEvent.keyDown(box, { key: "Enter" });

  expect(screen.getByText("Send that will fail")).toBeTruthy(); // the optimistic bubble is up first

  await screen.findByRole("alert"); // the send-failure toast lands
  expect(
    screen.getByText("Could not send - check your connection."),
  ).toBeTruthy();
  // The optimistic bubble must be gone - the failed turn is not left behind as a stuck "sent" message.
  // Scoped to the bubble class: the draft is correctly restored into the composer's textarea (interaction
  // spec section 4), which a bare document-wide text query would also match and hide the regression.
  expect(
    screen.queryByText("Send that will fail", { selector: ".bubble.user" }),
  ).toBeNull();
  expect(document.querySelectorAll(".msg.user")).toHaveLength(0);
});

// --- concurrent-send: TWO independent protections, verified by TWO tests ---
// Regression for the code-review should-fix: `send` had NO reentrancy guard and follow-up chips were
// `disabled={used}` ONLY (not gated by streaming/pending). A chip clicked while a turn is in flight
// fired a second concurrent `sendMessage({messageId})` which truncates-after-id (dropping the other
// send's optimistic bubble -> spurious "Could not send" + an orphan persisted turn + a duplicate run,
// the AC-16 class). The fix is BOTH pending-gated chips (the chip is `disabled` while a turn streams,
// matching the composer's own streaming-disabled state) AND a `sendingRef` reentrancy guard at the top
// of `send`. These are DISTINCT protections that need distinct tests: the disabled chip is proven here
// (jsdom never dispatches a click to a disabled button, so this path never even reaches `send`), and the
// `sendingRef` guard - which bites only a same-tick reentrant call before the control re-renders to its
// disabled state - is proven separately in the next test. Do NOT merge them: a single chip-click test
// leaves the guard un-exercised (reverting the guard line stays green), which overstates its coverage.
test("Should_DisableFollowupChip_When_TurnInFlight: a follow-up chip is pending-disabled mid-stream, so clicking it fires no 2nd send (the chip pending-gate; the reentrancy guard is proven separately)", async () => {
  // A settled prior turn with a follow-up chip is on screen.
  const initial: UIMessage[] = [
    {
      id: "u0",
      role: "user",
      parts: [{ type: "text", text: "Top companies?" }],
    },
    {
      id: "a0",
      role: "assistant",
      parts: [
        {
          type: "data-insight",
          id: "a0-c0",
          data: {
            id: "card0",
            kind: "chart",
            chartType: "bars",
            verdict: "Amazon leads hiring with 214 open roles.",
            series: [{ company: "Amazon", count: 214 }],
            followups: ["Only remote roles"],
            meta: {
              sql: "SELECT 1",
              sampleN: 3483,
              updatedAt: "2026-07-18 19:12:00",
            },
          },
        },
      ],
    },
  ];
  // Hold the gate unresolved so the first send stays in flight (pending) while the chip is clicked.
  let release: (v: unknown) => void = () => {};
  sendMessageMock.mockReturnValue(new Promise((res) => (release = res)));
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={initial}
      e2e={false}
    />,
  );

  // First send via the composer - it holds the turn open (gate unresolved), so pending stays true.
  const box = screen.getByRole("textbox", { name: "Ask a follow-up" });
  fireEvent.change(box, { target: { value: "First question" } });
  fireEvent.keyDown(box, { key: "Enter" });

  await screen.findByText("First question", { selector: ".bubble.user" }); // optimistic bubble up
  expect(sendMessageMock).toHaveBeenCalledTimes(1);

  // The turn is in flight: the chip is pending-gated (disabled), matching the composer's streaming state.
  const chip = screen.getByRole("button", { name: /Only remote roles/ });
  expect((chip as HTMLButtonElement).disabled).toBe(true);

  // Clicking a disabled button is a no-op in jsdom (matching real browsers): the event never dispatches,
  // so `onFollowup`/`send` are never reached. This proves the chip pending-gate holds - it is NOT a test
  // of the `sendingRef` guard (that path is unreachable here). See the reentrancy test below for the guard.
  fireEvent.click(chip);

  // Exactly one send proceeded: no 2nd action call, no orphan chip-text bubble, first bubble intact.
  expect(sendMessageMock).toHaveBeenCalledTimes(1);
  expect(sendMessageMock).toHaveBeenCalledWith(
    CONVERSATION_ID,
    "First question",
  );
  expect(
    screen.queryByText("Only remote roles", { selector: ".bubble.user" }),
  ).toBeNull();
  expect(
    screen.getByText("First question", { selector: ".bubble.user" }),
  ).toBeTruthy();

  // Settle cleanly (avoid a dangling act warning): the held gate resolves ok, the turn finishes.
  release({ ok: true });
  await waitFor(() => expect(sendMessagesMock).toHaveBeenCalled());
});

// The `sendingRef` guard in isolation, independent of any `disabled` gating. Two Send-button clicks are
// dispatched inside ONE `act()` batch, so React has not committed the first send's `pending` state
// between them: the Composer's Send button has not swapped to Stop, its onClick closure still sees
// `streaming === false` on BOTH clicks, and both therefore reach `send`. The disabled/pending gating
// cannot cover this same-tick double-submit race (the control flips only on the next render); the ONLY
// thing between one send and two here is `send`'s `sendingRef` reentrancy guard. Verified adversarially:
// reverting just the `if (sendingRef.current) return;` line turns this RED (two action calls, two
// bubbles), so it pins the guard mechanism the chip-gate test above cannot.
test("Should_IgnoreReenteredSend_When_SendAlreadyInFlight: two same-tick composer submits reach send, but the sendingRef guard lets exactly one proceed", async () => {
  // Hold the gate unresolved so the first send stays in flight (sendingRef stays armed) across both clicks.
  let release: (v: unknown) => void = () => {};
  sendMessageMock.mockReturnValue(new Promise((res) => (release = res)));
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={[]}
      e2e={false}
    />,
  );

  const box = screen.getByRole("textbox", { name: "Ask a follow-up" });
  fireEvent.change(box, { target: { value: "First question" } });

  // Same-tick double submit: both native clicks dispatch inside one act(), before React re-renders the
  // composer into its streaming (Send -> Stop) state, so both onClick closures still call `onSend`.
  const sendBtn = screen.getByRole("button", { name: "Send" });
  act(() => {
    sendBtn.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    sendBtn.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });

  // Exactly one send proceeded: the reentrant second call returned at the guard before touching the
  // action or appending a second optimistic bubble. Without the guard both assertions read 2.
  expect(sendMessageMock).toHaveBeenCalledTimes(1);
  expect(
    screen.getAllByText("First question", { selector: ".bubble.user" }),
  ).toHaveLength(1);

  // Settle cleanly (avoid a dangling act warning): the held gate resolves ok, the turn finishes.
  release({ ok: true });
  await waitFor(() => expect(sendMessagesMock).toHaveBeenCalled());
});

// --- R2: a follow-up delivers + watches via sendMessages and threads NO session state ---

test("follow-up send: threads no session state (no setSession on the send path) and streams via sendMessages, not the peekSettled reconnect", async () => {
  sendMessageMock.mockResolvedValue({ ok: true });
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={[]}
      e2e={false}
    />,
  );

  const box = screen.getByRole("textbox", { name: "Ask a follow-up" });
  fireEvent.change(box, { target: { value: "Any remote roles?" } });
  fireEvent.keyDown(box, { key: "Enter" });

  await screen.findByText("Any remote roles?"); // optimistic user bubble (useChat.sendMessage adds it)
  // Delivered + watched via sendMessages (append + subscribe-with-wait), NOT the peekSettled reconnect.
  await waitFor(() => expect(sendMessagesMock).toHaveBeenCalled());
  expect(reconnectMock).not.toHaveBeenCalled();
  // R2/F1/F7: the send path never touches the transport's session cache - the transport owns the `.out`
  // cursor and refreshes its token via `accessToken`. (Reverting the send-path deletion turns this RED.)
  expect(setSessionMock).not.toHaveBeenCalled();
});

test("instant feedback: the answering indicator + Stop show AT ONCE on send, through the run-wake gap before the run streams (006 ruling 1)", async () => {
  // Hold the sendMessage action unresolved: the window between hitting send and the run producing output
  // (the ~6s run-wake gap). During it the SDK has not moved status off "ready" yet, so the ONLY thing
  // that can give instant feedback is the local awaiting bridge.
  let release: (v: unknown) => void = () => {};
  sendMessageMock.mockReturnValue(
    new Promise((res) => {
      release = res;
    }),
  );
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={[]}
      e2e={false}
    />,
  );

  const box = screen.getByRole("textbox", { name: "Ask a follow-up" });
  fireEvent.change(box, { target: { value: "Top companies?" } });
  fireEvent.keyDown(box, { key: "Enter" });

  // Instant: the animated indicator is up and the composer is in its streaming state (Stop control) -
  // never a hollow skeleton card - even though no stream chunk has arrived and the action is still pending.
  expect(await screen.findByRole("status", { name: "Answering" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  expect(document.querySelector(".insight")).toBeNull();
  expect(document.querySelector(".skeleton")).toBeNull();

  // Let it settle (a cap refusal ends the turn without streaming) so the bridge clears cleanly.
  release({ ok: false, reason: "guest_cap" });
  await screen.findByText(/reached the guest limit/i);
  expect(screen.queryByRole("status", { name: "Answering" })).toBeNull();
});

test("arrival: a new chat mints its session token and hydrates the transport so the first run streams on mount (AC-3)", async () => {
  mintChatTokenMock.mockResolvedValue({ ok: true, token: "tok-arrival" });
  const initial: UIMessage[] = [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", text: "Which companies are hiring the most?" }],
    },
  ];
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={initial}
      autoStream
      e2e={false}
    />,
  );

  await waitFor(() => expect(setSessionMock).toHaveBeenCalled());
  expect(mintChatTokenMock).toHaveBeenCalledWith(CONVERSATION_ID);
  expect(setSessionMock).toHaveBeenCalledWith(
    CONVERSATION_ID,
    expect.objectContaining({
      publicAccessToken: "tok-arrival",
      isStreaming: true,
    }),
  );
  await waitFor(() => expect(reconnectMock).toHaveBeenCalled());
  expect(setSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
    reconnectMock.mock.invocationCallOrder[0],
  );
  // R2/F4: ?new=1 is stripped after the attach so a later reload cannot re-run it (a cursor-less resume
  // that replays settled turns as duplicates) - the reload resumes via the persisted session instead.
  await waitFor(() =>
    expect(routerReplaceMock).toHaveBeenCalledWith(`/chat/${CONVERSATION_ID}`),
  );
});
