// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";
import type { DataInsight } from "@shared/insight";

// MessageList maps `useChat` messages to the 005 components. Recharts needs real layout, so we stub the
// chart subtree (same device as the memo probe test) and assert the mapping: bubbles, insight card +
// one-shot chips, the streaming skeleton (both in-message and trailing), and the error / refusal cards.
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
    render(<MessageList messages={[userMsg("Top companies?")]} status="ready" usedFollowups={noSet} onFollowup={noop} onRetry={noop} />);
    expect(screen.getByText("Top companies?").closest(".msg")?.classList.contains("user")).toBe(true);
  });

  test("renders an assistant insight turn as a card with active chips", () => {
    const messages: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "data-insight", id: "a1-c0", data: insight }] },
    ];
    const { container } = render(<MessageList messages={messages} status="ready" usedFollowups={noSet} onFollowup={noop} onRetry={noop} />);
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
        status="ready"
        usedFollowups={new Set(["card-1::Only remote roles"])}
        onFollowup={onFollowup}
        onRetry={noop}
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
      <MessageList messages={messages} status="ready" usedFollowups={used} onFollowup={noop} onRetry={noop} />,
    );
    expect(btn("Only remote roles ✓").disabled).toBe(true);

    // a second turn arrives (its own card, DIFFERENT id) - a re-render, not a fresh mount
    const secondInsight: DataInsight = { ...insight, id: "card-2", verdict: "Stripe leads next quarter." };
    const messages2: UIMessage[] = [
      ...messages,
      { id: "u2", role: "user", parts: [{ type: "text", text: "Only remote roles" }] },
      { id: "a2", role: "assistant", parts: [{ type: "data-insight", id: "a2-c0", data: secondInsight }] },
    ];
    rerender(<MessageList messages={messages2} status="ready" usedFollowups={used} onFollowup={noop} onRetry={noop} />);

    const cards = container.querySelectorAll(".insight");
    expect(cards.length).toBe(2);
    const originalChip = cards[0].querySelector(".chip") as HTMLButtonElement;
    const freshChip = cards[1].querySelector(".chip") as HTMLButtonElement;
    expect(originalChip.disabled).toBe(true); // survived the re-render
    expect(originalChip.textContent).toBe("Only remote roles ✓");
    expect(freshChip.disabled).toBe(false); // per-card scoping: the new card's own chip starts fresh
    expect(freshChip.textContent).toBe("Only remote roles");
  });

  test("AC-8: a loading part renders the skeleton card, not a filled insight", () => {
    const messages: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "data-insight", id: "a1-c0", data: { id: "a1-c0", kind: "chart", chartType: "bars", status: "loading" } }] },
    ];
    const { container } = render(<MessageList messages={messages} status="streaming" usedFollowups={noSet} onFollowup={noop} onRetry={noop} />);
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    expect(container.querySelector(".verdict")).toBeNull();
  });

  test("AC-8: a trailing skeleton shows while the last turn is a lone user message", () => {
    const { container, rerender } = render(
      <MessageList messages={[userMsg("Top companies?")]} status="submitted" usedFollowups={noSet} onFollowup={noop} onRetry={noop} />,
    );
    expect(container.querySelectorAll(".msg.ai .skeleton").length).toBeGreaterThan(0);

    // once the answer is ready the trailing skeleton is gone
    rerender(<MessageList messages={[userMsg("Top companies?")]} status="ready" usedFollowups={noSet} onFollowup={noop} onRetry={noop} />);
    expect(container.querySelectorAll(".skeleton").length).toBe(0);
  });

  test("AC-10: an error part renders the error card and Retry calls onRetry", () => {
    const onRetry = vi.fn();
    const messages: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "data-error", id: "a1-e", data: { kind: "system" } }] },
    ];
    render(<MessageList messages={messages} status="ready" usedFollowups={noSet} onFollowup={noop} onRetry={onRetry} />);
    expect(screen.getByText("Something went wrong on my side - try again")).toBeTruthy();
    fireEvent.click(btn("Retry"));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test("AC-15: a refusal part renders the polite limit notice (not the error card)", () => {
    const messages: UIMessage[] = [
      { id: "a1", role: "assistant", parts: [{ type: "data-refusal", id: "a1-r", data: { reason: "guest_cap" } }] },
    ];
    const { container } = render(<MessageList messages={messages} status="ready" usedFollowups={noSet} onFollowup={noop} onRetry={noop} />);
    expect(screen.getByText(/reached the guest message limit/i)).toBeTruthy();
    expect(container.querySelector(".notice")).toBeTruthy();
    expect(container.querySelector(".err-card")).toBeNull();
  });
});
