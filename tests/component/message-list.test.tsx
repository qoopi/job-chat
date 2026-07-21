// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import type { DataInsight } from "@shared/insight";
import { storeToUiMessages, type StoredMessage } from "@/lib/chat-ui";

// MessageList maps `useChat` messages to the 005 components. Recharts needs real layout, so we stub the
// chart subtree (same device as the memo probe test) and assert the mapping: bubbles, insight card +
// one-shot chips, the answering indicator (both the loading-part and the trailing pending states - 006
// ruling: a loading part shows the indicator, never a hollow card), and the error / refusal cards.
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

afterEach(cleanup);

describe("MessageList", () => {
  test("renders a user turn as a right-aligned bubble", () => {
    render(<MessageList messages={[userMsg("Top companies?")]} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />);
    expect(screen.getByText("Top companies?").closest(".msg")?.classList.contains("user")).toBe(true);
  });

  test("renders an assistant insight turn as a card with active chips", () => {
    const messages: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "data-insight", id: "a1-c0", data: insight }] },
    ];
    const { container } = render(<MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />);
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
        onOpenLcp={noop}
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
      <MessageList messages={messages} pending={false} usedFollowups={used} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />,
    );
    expect(btn("Only remote roles ✓").disabled).toBe(true);

    // a second turn arrives (its own card, DIFFERENT id) - a re-render, not a fresh mount
    const secondInsight: DataInsight = { ...insight, id: "card-2", verdict: "Stripe leads next quarter." };
    const messages2: UIMessage[] = [
      ...messages,
      { id: "u2", role: "user", parts: [{ type: "text", text: "Only remote roles" }] },
      { id: "a2", role: "assistant", parts: [{ type: "data-insight", id: "a2-c0", data: secondInsight }] },
    ];
    rerender(<MessageList messages={messages2} pending={false} usedFollowups={used} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />);

    const cards = container.querySelectorAll(".insight");
    expect(cards.length).toBe(2);
    const originalChip = cards[0].querySelector(".chip") as HTMLButtonElement;
    const freshChip = cards[1].querySelector(".chip") as HTMLButtonElement;
    expect(originalChip.disabled).toBe(true); // survived the re-render
    expect(originalChip.textContent).toBe("Only remote roles ✓");
    expect(freshChip.disabled).toBe(false); // per-card scoping: the new card's own chip starts fresh
    expect(freshChip.textContent).toBe("Only remote roles");
  });

  // 018 strand 2: a SUCCESS turn (an insight card) suppresses the model's accompanying prose too - the
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
      <MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />,
    );
    expect(container.querySelector(".insight")).toBeTruthy(); // the card is the single surface
    expect(container.querySelector(".bubble.ai")).toBeNull(); // the model prose bubble is suppressed
    expect(container.textContent).not.toContain("Apple and Netflix");
  });

  // 05-testing audit gap fill (018 strand 2): the two tests above prove suppression for a LIVE-shaped
  // insight turn and for the RESUMED error-card path (AC-25, inherited from 016) - but strand 2 extends
  // suppression to SUCCESS cards, and no test drove that extension through the real resume/hydration
  // function for a row persisted BEFORE this fix shipped (extractAssistantPersistence used to persist the
  // model's fabricated prose alongside the insight card). This proves the exact backward-compat case.
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
      <MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />,
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
      <MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />,
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
    const { container } = render(<MessageList messages={messages} pending={true} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />);
    // the animated indicator stands in for the loading part - never the old skeleton card body/tabs
    expect(container.querySelector(".answering")).toBeTruthy();
    expect(container.querySelector(".answering-dot")).toBeTruthy();
    expect(container.querySelector(".insight")).toBeNull();
    expect(container.querySelector(".skeleton")).toBeNull();
    expect(container.querySelector(".verdict")).toBeNull();
  });

  test("AC-8: a trailing answering indicator shows while the last turn is a lone user message", () => {
    const { container, rerender } = render(
      <MessageList messages={[userMsg("Top companies?")]} pending={true} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />,
    );
    const indicator = container.querySelector(".msg.ai .answering");
    expect(indicator).toBeTruthy();
    expect((indicator as HTMLElement).getAttribute("role")).toBe("status"); // announced to assistive tech

    // once the turn settles the trailing indicator is gone
    rerender(<MessageList messages={[userMsg("Top companies?")]} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />);
    expect(container.querySelector(".answering")).toBeNull();
  });

  test("AC-10: an error part renders the error card and Retry calls onRetry", () => {
    const onRetry = vi.fn();
    const messages: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "data-error", id: "a1-e", data: { kind: "system" } }] },
    ];
    render(<MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={onRetry} onOpenLcp={noop} />);
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
    const { container } = render(<MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />);
    expect(container.querySelector(".err-card")).toBeTruthy(); // the single surface
    expect(container.querySelector(".bubble.ai")).toBeNull(); // the prose bubble is suppressed
    expect(container.textContent).not.toContain("Something went wrong on my side - please try again.");
  });

  // 05-testing gap fill: the AC-25 test above proves the render-layer suppression on a LIVE-shaped
  // message. This proves the RESUMED path too, via the real hydration function (storeToUiMessages),
  // for a row persisted BEFORE this fix shipped (extractAssistantPersistence used to persist the prose
  // alongside the error kind) - the exact backward-compat case the render-layer fix exists for.
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
    const { container } = render(<MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />);
    expect(container.querySelector(".err-card")).toBeTruthy();
    expect(container.querySelector(".bubble.ai")).toBeNull();
    expect(container.textContent).not.toContain("Something went wrong on my side - please try again.");
  });

  // The post-fix shape: extractAssistantPersistence now persists content "" for an error turn, so a
  // freshly-fixed row never even hydrates a text part - belt and suspenders with the render-layer guard.
  test("AC-25 resume: a post-fix error turn (content already dropped at persistence) hydrates with no prose part", () => {
    const stored: StoredMessage[] = [{ id: "a2", role: "assistant", content: "", parts: { kind: "system" } }];
    const messages = storeToUiMessages(stored);
    expect(messages[0].parts).toEqual([{ type: "data-error", id: "a2-card-0", data: { kind: "system" } }]);
    const { container } = render(<MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />);
    expect(container.querySelector(".err-card")).toBeTruthy();
    expect(container.querySelector(".bubble.ai")).toBeNull();
  });

  test("AC-15: a refusal part renders the polite limit notice (not the error card)", () => {
    const messages: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "data-refusal", id: "a1-r", data: { reason: "guest_cap" } }] },
    ];
    const { container } = render(<MessageList messages={messages} pending={false} usedFollowups={noSet} onFollowup={noop} onRetry={noop} onOpenLcp={noop} />);
    expect(screen.getByText(/reached the guest message limit/i)).toBeTruthy();
    expect(container.querySelector(".notice")).toBeTruthy();
    expect(container.querySelector(".err-card")).toBeNull();
  });
});
