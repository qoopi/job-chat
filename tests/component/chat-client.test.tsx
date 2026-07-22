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

// ChatClient.send() has TWO distinct paths that can produce a cap/budget refusal: the E2E/agent-side
// path (the transport streams a `data-refusal` part mid-run - covered by
// e2e `live-chat-loop`) and the PROD action-side path (the `sendMessage` server action
// itself returns `{ ok: false, reason }` BEFORE any run starts, and ChatClient synthesizes the same
// `data-refusal` part via `setMessages`). Only the first path had a test; this closes the gap on the
// second one - it must render the identical notice, through the identical MessageList/RefusalNotice
// path, not a bespoke banner. The real transport and server action are mocked (external boundaries);
// ChatClient's own branching is what is under test.
//
// It also proves the send contract: every turn - including turn 1 on arrival - rides the public
// send path via the transport's `sendMessages` (append + subscribe-with-wait). The peekSettled
// `reconnectToStream` is NOT used to deliver a fresh turn. The transport owns its own session (there is
// no `setSession` seam). Both `sendMessages` and `reconnectToStream` are spied.
const reconnectMock = vi.fn(async () => null);
const sendMessagesMock = vi.fn(
  async () => new ReadableStream({ start: (c) => c.close() }),
);
vi.mock("@/lib/chat-transport", () => ({
  useJobChatTransport: () => ({
    sendMessages: sendMessagesMock,
    reconnectToStream: reconnectMock,
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
  reconnectMock.mockClear();
  sendMessagesMock.mockClear();
  routerReplaceMock.mockClear();
  window.sessionStorage.clear(); // the mid-arrival-reload test seeds a persisted session - never leak it
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

  expect(await screen.findByText(/reached the guest limit/i)).toBeTruthy(); // register card
  expect(document.querySelector(".register-card")).toBeTruthy();
  expect(document.querySelector(".err-card")).toBeNull();
  expect(sendMessageMock).toHaveBeenCalledWith(
    CONVERSATION_ID,
    "One more question",
  );
  // A refusal short-circuits BEFORE any delivery - the transport's send path must never be touched.
  expect(sendMessagesMock).not.toHaveBeenCalled();
});

test("action-refusal: an ok send does NOT render a notice (control case)", async () => {
  sendMessageMock.mockResolvedValue({ ok: true });
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

// --- optimistic echo: the user bubble renders at composer-clear time, not after the round trip ---

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

  // Synchronously present, before the gate resolves and before the transport streams.
  expect(screen.getByText("Median salary in Berlin?")).toBeTruthy();
  expect(screen.getByRole("status", { name: "Answering" })).toBeTruthy(); // indicator follows immediately

  // The gate passes: the SDK's sendMessage({ messageId }) replaces the SAME optimistic id in place (and
  // reconcileMessagesById is the backstop), so the server echo yields EXACTLY ONE bubble, no duplicate.
  release({ ok: true });
  await waitFor(() => expect(sendMessagesMock).toHaveBeenCalled());
  expect(screen.getAllByText("Median salary in Berlin?")).toHaveLength(1);
});

// The happy-path test above never asserts the bubble is gone after a refusal or a thrown send -
// commenting out both `rollbackEcho()` call sites left every older test green. These two pin the
// rollback: a blocked/failed message is not shown as sent.
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
  // to the bubble class (not a bare queryByText): the send path correctly restores the same text into the
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
// --- concurrent-send: TWO independent protections, verified by TWO tests ---
// A chip clicked while a turn is in flight fired a second concurrent `sendMessage({messageId})` which
// truncates-after-id (dropping the other send's optimistic bubble -> spurious "Could not send" + an
// orphan persisted turn + a duplicate run). The fix is BOTH pending-gated chips (disabled while a
// turn streams, matching the composer) AND a `sendingRef` reentrancy guard at the top of `send`. These
// are DISTINCT protections needing distinct tests: the disabled chip is proven here (jsdom never
// dispatches a click to a disabled button, so this path never reaches `send`), and the `sendingRef`
// guard - which bites only a same-tick reentrant call before the control re-renders - is proven
// separately in the next test. Do NOT merge them: a single chip-click test leaves the guard
// un-exercised (reverting the guard line stays green).
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

// --- a follow-up delivers + watches via sendMessages, not the peekSettled reconnect ---

test("follow-up send: streams via sendMessages (append + subscribe-with-wait), not the peekSettled reconnect", async () => {
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

test("arrival (AC-11): turn 1 is delivered through the public send path - sendMessages, not the peekSettled reconnect - and ?q= is stripped so a reload cannot re-deliver", async () => {
  // Message #1 is SSR-loaded (startConversation persisted it before navigating); the pending question is
  // carried in ?q= (pendingQuestion). deliverArrival delivers it via useChat.sendMessage with msg#1's id.
  const initial: UIMessage[] = [
    {
      id: "msg-1-uuid",
      role: "user",
      parts: [{ type: "text", text: "Which companies are hiring the most?" }],
    },
  ];
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={initial}
      pendingQuestion="Which companies are hiring the most?"
      e2e={false}
    />,
  );

  // Turn 1 rides the send path (append + subscribe), NOT the peekSettled reconnect (which never delivers
  // a freshly-triggered turn live). No token minting / setSession attach.
  await waitFor(() => expect(sendMessagesMock).toHaveBeenCalled());
  expect(reconnectMock).not.toHaveBeenCalled();
  expect(mintChatTokenMock).not.toHaveBeenCalled();

  // id continuity: delivering with msg#1's id reconciles the streamed turn onto the SSR bubble - the
  // question renders EXACTLY ONCE, not a duplicate under a fresh optimistic id.
  expect(
    screen.getAllByText("Which companies are hiring the most?", {
      selector: ".bubble.user",
    }),
  ).toHaveLength(1);

  // ?q= is stripped after delivery so a later reload cannot re-deliver turn 1 (it resumes via the
  // persisted session instead).
  await waitFor(() =>
    expect(routerReplaceMock).toHaveBeenCalledWith(`/chat/${CONVERSATION_ID}`),
  );
});

// The transport's `startSession` option (the lazy createStartSessionAction)
// runs INSIDE `sendMessages` on the first send for an uncached chatId - it is not a separately awaited
// call ChatClient can catch. When it fails (network drop / a 500 from the action), the AI SDK's own
// request loop (ai's `makeRequest`) catches the transport error internally, sets `useChat`'s `error`
// state, and resolves (does not reject) the outer `sendMessage()` promise - so `deliverArrival`'s
// try/catch never fires for this failure class. The user must still see it: through `liveError`, the
// SAME ErrorCard + Retry the live agent-side error class renders (message-list-live-error.test.tsx),
// never a silent no-op that leaves the composer looking like nothing happened.
test("arrival failure: a lazy startSession failure on turn 1 (network/500) surfaces the live error card, not silently", async () => {
  sendMessagesMock.mockRejectedValueOnce(new Error("network down"));
  const initial: UIMessage[] = [
    {
      id: "msg-1-uuid",
      role: "user",
      parts: [{ type: "text", text: "Which companies are hiring the most?" }],
    },
  ];
  const { container } = render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={initial}
      pendingQuestion="Which companies are hiring the most?"
      e2e={false}
    />,
  );

  await waitFor(() => expect(sendMessagesMock).toHaveBeenCalled());
  // The live error card (not a data-error part - none streamed) + Retry, from useChat's error state.
  await waitFor(() => expect(container.querySelector(".err-card")).toBeTruthy());
  expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  // The SSR-persisted question bubble is untouched - it was never optimistic, so there is nothing to
  // roll back; the failure is surfaced, not hidden by silently dropping the visible question.
  expect(
    screen.getAllByText("Which companies are hiring the most?", {
      selector: ".bubble.user",
    }),
  ).toHaveLength(1);
});

// deliverArrival's own effect only fires `if (pendingQuestion && !resume)` -
// the `!resume` guard is what keeps a mid-arrival reload safe (session-persistence: the transport's
// onSessionChange writes `isStreaming: true` the moment turn 1's stream starts, so a reload before it
// settles restores `resume=true`). Prove the guard actually wins even in the race where `?q=` has not
// yet been stripped from the URL by the time of reload (pendingQuestion still present): the persisted
// session must take precedence, resuming via `reconnectToStream` instead of re-delivering turn 1 via
// `sendMessages` a second time (which would duplicate the question / retrigger the run).
test("mid-arrival reload: a still-streaming persisted session resumes turn 1 instead of re-delivering it (020 session-persistence)", async () => {
  window.sessionStorage.setItem(
    `jobchat_session:${CONVERSATION_ID}`,
    JSON.stringify({ publicAccessToken: "tok", isStreaming: true }),
  );
  const initial: UIMessage[] = [
    {
      id: "msg-1-uuid",
      role: "user",
      parts: [{ type: "text", text: "Which companies are hiring the most?" }],
    },
  ];
  render(
    <ChatClient
      conversationId={CONVERSATION_ID}
      initialMessages={initial}
      // Simulates the reload racing ahead of the router.replace strip: ?q= is still on the URL.
      pendingQuestion="Which companies are hiring the most?"
      e2e={false}
    />,
  );

  // Resumes via the persisted session's cursor - never re-delivers turn 1 through the send path.
  await waitFor(() => expect(reconnectMock).toHaveBeenCalled());
  expect(sendMessagesMock).not.toHaveBeenCalled();
  // Exactly one bubble for the question - a re-delivery would have appended/replaced a second one.
  expect(
    screen.getAllByText("Which companies are hiring the most?", {
      selector: ".bubble.user",
    }),
  ).toHaveLength(1);
});
