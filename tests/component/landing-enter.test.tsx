// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// AC-25b: the landing composer submits on Enter (Shift+Enter inserts a newline), mirroring the chat
// composer, so a visitor can send their first question without reaching for the mouse (AC-23 research
// note flagged Enter not submitting on the P1 landing). External boundaries are mocked.
const startConversationMock = vi.fn();
vi.mock("@/app/actions", () => ({
  startConversation: (t: string) => startConversationMock(t),
  ensureGuest: vi.fn(async () => "guest-1"),
}));

const pushMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }));

import { LandingComposer } from "@/components/landing/LandingComposer";

afterEach(() => {
  cleanup();
  startConversationMock.mockReset();
  pushMock.mockReset();
});

test("Should_Submit_When_EnterPressed: Enter sends the draft through startConversation", async () => {
  startConversationMock.mockResolvedValue({ ok: true, conversationId: "conv-42" });
  render(<LandingComposer e2e={false} />);

  const box = screen.getByRole("textbox", { name: "What are you looking for" }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "Top companies hiring right now" } });
  fireEvent.keyDown(box, { key: "Enter" });

  await waitFor(() => expect(startConversationMock).toHaveBeenCalledWith("Top companies hiring right now"));
  await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/chat/conv-42?new=1"));
});

test("Should_NotSubmit_When_ShiftEnterPressed: Shift+Enter is a newline, not a send", () => {
  render(<LandingComposer e2e={false} />);

  const box = screen.getByRole("textbox", { name: "What are you looking for" }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "line one" } });
  fireEvent.keyDown(box, { key: "Enter", shiftKey: true });

  expect(startConversationMock).not.toHaveBeenCalled();
  expect(pushMock).not.toHaveBeenCalled();
});
