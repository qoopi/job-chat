// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import type { DataInsight } from "@shared/insight";
import { storeToUiMessages, type StoredMessage } from "@/lib/chat-ui";

// MessageList maps `useChat` messages to the thread components. Recharts needs real layout, so we stub the
// chart subtree (same device as the memo probe test) and assert the mapping: bubbles, insight card +
// one-shot chips, the answering indicator (both the loading-part and the trailing pending states: a
// loading part shows the indicator, never a hollow card), and the error / refusal cards.
// Plain DOM assertions only (this repo does not wire jest-dom matchers).
vi.mock("@/components/insight/charts/InsightChart", () => ({
  InsightChart: () => <div data-testid="chart-subtree" />,
}));

import { MessageList } from "@/components/chat/MessageList";

const insight: DataInsight = {
  id: "card-1",
  kind: "chart",
  chartType: "bars",
  verdict: "Amazon leads hiring with 214 open roles.",
  series: [{ company: "Amazon", count: 214 }],
  followups: ["Only remote roles", "Amazon's open roles"],
  meta: { sql: "SELECT 1", sampleN: 3483, updatedAt: "2026-07-18 19:12:00" },
};

function userMsg(text: string, id = "u1"): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

const noop = () => {};
const noSet = new Set<string>();
const btn = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
const base = { pending: false, usedFollowups: noSet, onFollowup: noop, onOpenDetailPanel: noop };
const userMsgId = (text: string, id: string): UIMessage => ({ id, role: "user", parts: [{ type: "text", text }] });
const insightMsg = (id: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "data-insight", id: `${id}-c0`, data: insight }],
});

afterEach(cleanup);

describe("MessageList", () => {
  test("renders a user turn as a right-aligned bubble", () => {
    render(<MessageList messages={[userMsg("Top companies?")]} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenDetailPanel={noop} />);
    expect(screen.getByText("Top companies?").closest(".msg")?.classList.contains("user")).toBe(true);
  });

  test("renders an assistant insight turn as a card with active chips", () => {
    const messages: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "data-insight", id: "a1-c0", data: insight }] },
    ];
    const { container } = render(<MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenDetailPanel={noop} />);
    // the verdict number is bolded in its own <b>, so the sentence spans nodes - read it off .verdict
    expect(container.querySelector(".verdict")?.textContent).toBe("Amazon leads hiring with 214 open roles.");
    expect(btn("Only remote roles").disabled).toBe(false);
  });

  test("AC-7: a used chip renders disabled with a check, and a tap calls onFollowup with the card id", () => {
    const onFollowup = vi.fn();
    const messages: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "data-insight", id: "a1-c0", data: insight }] },
    ];
    render(
      <MessageList
        messages={messages}
        pending={false}
        usedFollowups={new Set(["card-1::Only remote roles"])}
        onFollowup={onFollowup}
        onRetry={noop}
        onOpenDetailPanel={noop}
      />,
    );
    expect(btn("Only remote roles ✓").disabled).toBe(true);

    fireEvent.click(btn("Amazon's open roles"));
    expect(onFollowup).toHaveBeenCalledWith("card-1", "Amazon's open roles");
  });

  test("AC-7: a used chip's one-shot marking survives a re-render (a new turn appends a second card)", () => {
    const used = new Set(["card-1::Only remote roles"]);
    const messages: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "data-insight", id: "a1-c0", data: insight }] },
    ];
    const { container, rerender } = render(
      <MessageList messages={messages} pending={false} usedFollowups={used} onFollowup={noop} onRetry={noop} onOpenDetailPanel={noop} />,
    );
    expect(btn("Only remote roles ✓").disabled).toBe(true);

    // a second turn arrives (its own card, DIFFERENT id) - a re-render, not a fresh mount
    const secondInsight: DataInsight = { ...insight, id: "card-2", verdict: "Stripe leads next quarter." };
    const messages2: UIMessage[] = [
      ...messages,
      { id: "u2", role: "user", parts: [{ type: "text", text: "Only remote roles" }] },
      { id: "a2", role: "assistant", parts: [{ type: "data-insight", id: "a2-c0", data: secondInsight }] },
    ];
    rerender(<MessageList messages={messages2} pending={false} usedFollowups={used} onFollowup={noop} onRetry={noop} onOpenDetailPanel={noop} />);

    const cards = container.querySelectorAll(".insight");
    expect(cards.length).toBe(2);
    const originalChip = cards[0].querySelector(".chip") as HTMLButtonElement;
    const freshChip = cards[1].querySelector(".chip") as HTMLButtonElement;
    expect(originalChip.disabled).toBe(true); // survived the re-render
    expect(originalChip.textContent).toBe("Only remote roles ✓");
    expect(freshChip.disabled).toBe(false); // per-card scoping: the new card's own chip starts fresh
    expect(freshChip.textContent).toBe("Only remote roles");
  });

  // A SUCCESS turn (an insight card) suppresses the model's accompanying prose too - the
  // card is the single answer surface, so a fabricated framing sentence is never shown beside it.
  test("an insight-card turn shows only the card, not the accompanying model prose", () => {
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Apple and Netflix are also hiring heavily right now." },
          { type: "data-insight", id: "a1-c0", data: insight },
        ],
      },
    ];
    const { container } = render(
      <MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenDetailPanel={noop} />,
    );
    expect(container.querySelector(".insight")).toBeTruthy(); // the card is the single surface
    expect(container.querySelector(".bubble.ai")).toBeNull(); // the model prose bubble is suppressed
    expect(container.textContent).not.toContain("Apple and Netflix");
  });

  // The two tests above prove suppression for a LIVE-shaped insight turn and the RESUMED error-card
  // path. This drives the real resume/hydration function for a row persisted BEFORE suppression
  // shipped (fabricated prose + card stored together) - the exact backward-compat case.
  test("018 strand 2 resume: a legacy-persisted insight turn (fabricated prose + card stored together) suppresses the prose on resume", () => {
    const stored: StoredMessage[] = [
      {
        id: "a1",
        role: "assistant",
        content: "Apple and Netflix are also hiring heavily right now.",
        parts: insight,
      },
    ];
    const messages = storeToUiMessages(stored);
    // Hydration itself is agnostic to the card kind: it carries both the legacy prose and the card.
    expect(messages[0].parts).toEqual([
      { type: "text", text: "Apple and Netflix are also hiring heavily right now." },
      { type: "data-insight", id: "a1-card-0", data: insight },
    ]);
    const { container } = render(
      <MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenDetailPanel={noop} />,
    );
    expect(container.querySelector(".insight")).toBeTruthy(); // the card is the single surface
    expect(container.querySelector(".bubble.ai")).toBeNull(); // the fabricated prose bubble is suppressed
    expect(container.textContent).not.toContain("Apple and Netflix");
  });

  test("live-walk #4a: an assistant text turn renders **bold** as <strong> with no literal asterisks", () => {
    const messages: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "**3,315 new postings** over 90 days" }] },
    ];
    const { container } = render(
      <MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenDetailPanel={noop} />,
    );
    const bubble = container.querySelector(".bubble.ai");
    expect(bubble?.querySelector("strong")?.textContent).toBe("3,315 new postings");
    expect(bubble?.textContent).toBe("3,315 new postings over 90 days");
    expect(bubble?.textContent).not.toContain("*");
  });

  test("AC-8: a still-loading insight part renders the answering indicator, NOT a hollow card (006: charts only when ready)", () => {
    const messages: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "data-insight", id: "a1-c0", data: { id: "a1-c0", kind: "chart", chartType: "bars", status: "loading" } }] },
    ];
    const { container } = render(<MessageList messages={messages} pending={true} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenDetailPanel={noop} />);
    // the animated indicator stands in for the loading part - never the old skeleton card body/tabs
    expect(container.querySelector(".answering")).toBeTruthy();
    expect(container.querySelector(".answering-dot")).toBeTruthy();
    expect(container.querySelector(".insight")).toBeNull();
    expect(container.querySelector(".skeleton")).toBeNull();
    expect(container.querySelector(".verdict")).toBeNull();
  });

  test("AC-8: a trailing answering indicator shows while the last turn is a lone user message", () => {
    const { container, rerender } = render(
      <MessageList messages={[userMsg("Top companies?")]} pending={true} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenDetailPanel={noop} />,
    );
    const indicator = container.querySelector(".msg.ai .answering");
    expect(indicator).toBeTruthy();
    expect((indicator as HTMLElement).getAttribute("role")).toBe("status"); // announced to assistive tech

    // once the turn settles the trailing indicator is gone
    rerender(<MessageList messages={[userMsg("Top companies?")]} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenDetailPanel={noop} />);
    expect(container.querySelector(".answering")).toBeNull();
  });

  test("AC-10: an error part renders the error card and Retry calls onRetry", () => {
    const onRetry = vi.fn();
    const messages: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "data-error", id: "a1-e", data: { kind: "system" } }] },
    ];
    render(<MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={onRetry} onOpenDetailPanel={noop} />);
    expect(screen.getByText("Something went wrong on my side - try again")).toBeTruthy();
    fireEvent.click(btn("Retry"));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test("AC-25: a system-error turn shows only the error card, not the doubled model prose", () => {
    // The model both wrote an apology AND the tool emitted a system error card. Exactly one refusal
    // surface must render: the error card. The prose bubble is suppressed (no doubled text).
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Something went wrong on my side - please try again." },
          { type: "data-error", id: "a1-e", data: { kind: "system" } },
        ],
      },
    ];
    const { container } = render(<MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenDetailPanel={noop} />);
    expect(container.querySelector(".err-card")).toBeTruthy(); // the single surface
    expect(container.querySelector(".bubble.ai")).toBeNull(); // the prose bubble is suppressed
    expect(container.textContent).not.toContain("Something went wrong on my side - please try again.");
  });

  // The test above proves render-layer suppression on a LIVE-shaped message. This proves the RESUMED
  // path too, via the real hydration function (storeToUiMessages), for a row persisted BEFORE the fix
  // (prose + error kind stored together) - the backward-compat case the render-layer guard exists for.
  test("AC-25 resume: a legacy-persisted error turn (prose + error kind stored together) still renders one surface", () => {
    const stored: StoredMessage[] = [
      { id: "a1", role: "assistant", content: "Something went wrong on my side - please try again.", parts: { kind: "system" } },
    ];
    const messages = storeToUiMessages(stored);
    // Hydration itself is agnostic to the error kind: it carries both the legacy prose and the card.
    expect(messages[0].parts).toEqual([
      { type: "text", text: "Something went wrong on my side - please try again." },
      { type: "data-error", id: "a1-card-0", data: { kind: "system" } },
    ]);
    const { container } = render(<MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenDetailPanel={noop} />);
    expect(container.querySelector(".err-card")).toBeTruthy();
    expect(container.querySelector(".bubble.ai")).toBeNull();
    expect(container.textContent).not.toContain("Something went wrong on my side - please try again.");
  });

  // Backward-compat: a LEGACY-persisted error card (empty content, from before the empty-turn flip stopped
  // persisting failed turns) still hydrates with no text part and renders as the error card - belt and
  // suspenders with the render-layer suppression. New failed turns persist nothing (see the reload-after-
  // failure suite); this proves an already-stored error row still renders correctly.
  test("AC-25 resume: a legacy synthesized error turn (empty content) hydrates with no prose part", () => {
    const stored: StoredMessage[] = [{ id: "a2", role: "assistant", content: "", parts: { kind: "system" } }];
    const messages = storeToUiMessages(stored);
    expect(messages[0].parts).toEqual([{ type: "data-error", id: "a2-card-0", data: { kind: "system" } }]);
    const { container } = render(<MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenDetailPanel={noop} />);
    expect(container.querySelector(".err-card")).toBeTruthy();
    expect(container.querySelector(".bubble.ai")).toBeNull();
  });

  // Backward-compat: a LEGACY-persisted failed turn (an error card stored before the empty-turn flip) still
  // resumes as the error card WITH a working Retry. New failed turns persist nothing and resume as a bare
  // user tail (covered in the reload-after-failure suite); this proves an already-stored error row still works.
  test("Should_ResumeErrorCard_When_LegacyFailedTurnReloaded", () => {
    const onRetry = vi.fn();
    const stored: StoredMessage[] = [
      { id: "u1", role: "user", content: "Who is hiring the most?", parts: null },
      { id: "a1", role: "assistant", content: "", parts: { kind: "system" } }, // the persisted failed turn
    ];
    const messages = storeToUiMessages(stored);
    render(<MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={onRetry} onOpenDetailPanel={noop} />);
    // the question survives, and its failed answer resumes as the error card with a working Retry
    expect(screen.getByText("Who is hiring the most?")).toBeTruthy();
    expect(screen.getByText("Something went wrong on my side - try again")).toBeTruthy();
    fireEvent.click(btn("Retry"));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  // Discovery suggestions: an additive part rendered as tappable chips BESIDE the brief reply (never a
  // suppressing answer card). The chip shows its label; a tap sends the full question; used chips disable.
  test("a suggestions turn renders the reply prose AND the chips (label shown, prose not suppressed)", () => {
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "I answer market questions with a chart and match your resume to roles." },
          {
            type: "data-suggestions",
            id: "a1-s",
            data: {
              kind: "suggestions",
              items: [
                { label: "Find me a job that fits", question: "Find me a job that fits" },
                { label: "Who is hiring most?", question: "Which companies are hiring the most right now?" },
              ],
            },
          },
        ],
      },
    ];
    const { container } = render(
      <MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenDetailPanel={noop} />,
    );
    // the brief reply is shown (suggestions are additive, they do NOT suppress prose)...
    expect(container.querySelector(".bubble.ai")?.textContent).toContain("I answer market questions");
    // ...and the chips render by their short label
    expect(btn("Find me a job that fits").disabled).toBe(false);
    expect(btn("Who is hiring most?").disabled).toBe(false);
  });

  test("a suggestions chip tap sends its full question via onFollowup, and a used chip disables", () => {
    const onFollowup = vi.fn();
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "data-suggestions",
            id: "a1-s",
            data: {
              kind: "suggestions",
              items: [
                { label: "Who is hiring most?", question: "Which companies are hiring the most right now?" },
              ],
            },
          },
        ],
      },
    ];
    render(
      <MessageList
        messages={messages}
        pending={false}
        usedFollowups={new Set(["a1-s::Which companies are hiring the most right now?"])}
        onFollowup={onFollowup}
        onRetry={noop}
        onOpenDetailPanel={noop}
      />,
    );
    // the used chip is disabled with a check, keyed by the SENT question (not the label)
    expect(btn("Who is hiring most? ✓").disabled).toBe(true);
  });

  test("a suggestions chip tap sends its full question (label != question)", () => {
    const onFollowup = vi.fn();
    const messages: UIMessage[] = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "data-suggestions",
            id: "a1-s",
            data: {
              kind: "suggestions",
              items: [{ label: "Median salary in Berlin", question: "What is the median salary in Berlin?" }],
            },
          },
        ],
      },
    ];
    render(<MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={onFollowup} onRetry={noop} onOpenDetailPanel={noop} />);
    fireEvent.click(btn("Median salary in Berlin"));
    expect(onFollowup).toHaveBeenCalledWith("a1-s", "What is the median salary in Berlin?");
  });

  test("AC-15: a refusal part renders the polite limit notice (not the error card)", () => {
    const messages: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "data-refusal", id: "a1-r", data: { reason: "guest_cap" } }] },
    ];
    const { container } = render(<MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenDetailPanel={noop} />);
    expect(screen.getByText(/reached the guest message limit/i)).toBeTruthy();
    expect(container.querySelector(".notice")).toBeTruthy();
    expect(container.querySelector(".err-card")).toBeNull();
  });
});

// Under the empty-turn persistence contract a FAILED turn persists NO assistant row, so a reload of a failed
// turn hydrates as a bare unanswered user tail (no error card in the store). MessageList surfaces the SAME
// error card + Retry from that settled user tail - the reload-after-failure affordance the persisted error
// card used to provide. Retry routes through onRetry -> regenerate(); regenerate() over a user tail keeps the
// question and fires trigger "regenerate-message", which the run gate answers (deleteTrailingAssistant no-ops).
describe("MessageList reload-after-failure Retry (settled unanswered user tail)", () => {
  test("Should_ShowRetry_When_SettledTailIsUnansweredUser", () => {
    const onRetry = vi.fn();
    render(<MessageList messages={[userMsgId("Who is hiring?", "u1")]} onRetry={onRetry} {...base} />);
    expect(screen.getByText("Something went wrong on my side - try again")).toBeTruthy();
    fireEvent.click(btn("Retry"));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test("Should_ShowRetry_When_ReloadedFailedTurnHasUserTail (real hydration shape)", () => {
    const onRetry = vi.fn();
    const stored: StoredMessage[] = [{ id: "u1", role: "user", content: "Median salary in SF?", parts: null }];
    render(<MessageList messages={storeToUiMessages(stored)} onRetry={onRetry} {...base} />);
    expect(screen.getByText("Median salary in SF?")).toBeTruthy(); // the question survives
    fireEvent.click(btn("Retry"));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test("Should_NotShowRetry_When_TailIsAnsweredAssistant", () => {
    render(<MessageList messages={[userMsgId("Q", "u1"), insightMsg("a1")]} onRetry={noop} {...base} />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull(); // nothing failed - no Retry
  });

  test("Should_NotShowRetry_When_UserTailIsPending", () => {
    const { container } = render(
      <MessageList messages={[userMsgId("Q", "u1")]} onRetry={noop} {...base} pending />,
    );
    // While the turn is in flight the trailing indicator stands in, never a premature Retry.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(container.querySelector(".answering")).toBeTruthy();
  });

  test("Should_NotShowRetry_When_LiveErrorAlreadyOwnsTheUserTail", () => {
    // An in-session SDK error already surfaces the live error card + Retry off the user tail; the settled
    // affordance must not double-render on top of it.
    const { container } = render(
      <MessageList messages={[userMsgId("Q", "u1")]} onRetry={noop} liveError {...base} />,
    );
    expect(container.querySelectorAll(".err-card").length).toBe(1);
  });
});
