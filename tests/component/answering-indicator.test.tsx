// @vitest-environment jsdom
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

// The answering indicator (instant send feedback). It is the animated typing-dots bubble
// that stands in for a pending answer through the run-wake gap. It must read as an adviser (ai) bubble -
// same shape tokens as a real answer - carry the animated dots, and announce itself to assistive tech.
import { AnsweringIndicator } from "@/components/chat/AnsweringIndicator";

afterEach(cleanup);

describe("AnsweringIndicator", () => {
  test("renders an ai-shaped bubble announced as a status region", () => {
    const { container } = render(<AnsweringIndicator />);
    // left-aligned adviser row + the ai bubble shape (same tokens as a real answer, not a hollow card)
    expect(container.querySelector(".msg.ai")).toBeTruthy();
    const bubble = container.querySelector(".bubble.ai.answering");
    expect(bubble).toBeTruthy();
    // announced to assistive tech while the answer is on its way
    expect(screen.getByRole("status", { name: "Answering" })).toBe(bubble);
    // no hollow insight card / skeleton chrome
    expect(container.querySelector(".insight")).toBeNull();
    expect(container.querySelector(".skeleton")).toBeNull();
  });

  test("renders three animated dots", () => {
    const { container } = render(<AnsweringIndicator />);
    expect(container.querySelectorAll(".answering-dot").length).toBe(3);
  });
});
