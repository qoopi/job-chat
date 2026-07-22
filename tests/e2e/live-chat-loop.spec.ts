import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  armScript,
  insightScript,
  partialThenHangScript,
  errorScript,
  refusalScript,
  setScript,
} from "./chat-mock";

// The live chat loop, driven by the E2E mock transport (scripted UIMessageChunks - no Trigger.dev /
// Bedrock). Each test arms a script, sends, and asserts the client behavior the interaction-spec pins:
// the answering indicator (006 ruling), insight card, stop, retry, and the polite limit notice.

const freshChat = () => `/chat/${randomUUID()}`;
const composer = "Ask a follow-up";

// AC-11 (canonical arrival spec): turn 1 from the landing rides the SAME public send path as every
// follow-up (no server-side envelope). The landing carries the question in ?q=; the chat page delivers it
// via useChat.sendMessage on arrival. Prove it streams live end-to-end: message #1 shown, the answering
// indicator up through the run-wake gap, and the answer streams to completion.
test("AC-11 Should_DeliverTurnOneViaSendPath_When_ConversationStarts", async ({
  page,
}) => {
  await armScript(page, insightScript(500)); // brief fill: observe the indicator, then the streamed card
  await page.goto("/");

  await page
    .getByRole("textbox", { name: "What are you looking for" })
    .fill("Top companies hiring right now");
  await page.getByRole("button", { name: "Send" }).click();

  // Handoff: navigated into a chat carrying ?q=, message #1 shown, the answering indicator up on arrival
  // (006 ruling: an animated waiting indicator, never a hollow skeleton card, until real content streams).
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]+/);
  await expect(page.locator(".bubble.user")).toHaveText(
    "Top companies hiring right now",
  );
  await expect(page.locator(".answering").first()).toBeVisible();

  // Turn 1 streams to completion via the send path - the same rendering follow-ups get.
  await expect(page.locator(".insight .verdict")).toContainText(
    "Amazon leads hiring with",
  );
});

test("AC-4/AC-6 Should_RenderInsightCard_When_DataAnswerStreams", async ({
  page,
}) => {
  await armScript(page, insightScript(150));
  await page.goto(freshChat());

  const box = page.getByRole("textbox", { name: composer });
  await box.fill("Which companies are hiring the most?");
  await box.press("Enter");

  const card = page.locator(".insight").first();
  await expect(card.locator(".verdict")).toContainText(
    "Amazon leads hiring with",
  );
  await expect(card.locator(".verdict b")).toHaveText("214"); // key number bolded
  await expect(card.locator("svg.recharts-surface")).toBeVisible(); // one visual
  await expect(card.locator(".chip").first()).toBeVisible(); // follow-up chips
  await expect(card.locator(".src")).toContainText("3,483 postings"); // source line + count

  // AC-6: Show query reveals the exact executed SQL from the streamed part
  await card.getByRole("button", { name: "Show query" }).click();
  await expect(card.locator(".codeblock")).toContainText("FROM postings FINAL");
});

test("AC-8 Should_ShowAnsweringIndicatorAndDisableComposer_While_Streaming", async ({
  page,
}) => {
  await armScript(page, insightScript(3000));
  await page.goto(freshChat());

  const box = page.getByRole("textbox", { name: composer });
  await box.fill("Top companies?");
  await box.press("Enter");

  // 006 ruling: streaming shows the animated answering indicator (not a hollow skeleton card) + a
  // disabled composer + the Stop control.
  await expect(page.locator(".answering").first()).toBeVisible();
  await expect(page.getByRole("textbox", { name: composer })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  // the card mounts only when its data-insight part is complete (indicator -> full card, no hollow card)
  await expect(page.locator(".verdict")).toContainText(
    "Amazon leads hiring with",
    { timeout: 8000 },
  );
  await expect(page.locator(".answering")).toHaveCount(0); // indicator gone once real content lands
});

test("AC-9 Should_KeepPartialAnswer_When_Stopped", async ({ page }) => {
  await armScript(page, partialThenHangScript());
  await page.goto(freshChat());

  const box = page.getByRole("textbox", { name: composer });
  await box.fill("What is the median salary?");
  await box.press("Enter");

  // partial answer streamed, then the stream hangs
  await expect(page.locator(".bubble.ai")).toContainText(
    "The median salary is $182k",
  );
  await page.getByRole("button", { name: "Stop" }).click();

  // partial is kept, the rest never arrives, composer is usable again
  await expect(page.locator(".bubble.ai")).toContainText(
    "The median salary is $182k",
  );
  await expect(page.locator(".bubble.ai")).not.toContainText("climbing fast");
  await expect(page.getByRole("textbox", { name: composer })).toBeEnabled();
});

test("AC-10 Should_ShowErrorCardWithRetry_When_AgentFails (both copies)", async ({
  page,
}) => {
  // system failure copy
  await armScript(page, errorScript("system"));
  await page.goto(freshChat());
  const box = page.getByRole("textbox", { name: composer });
  await box.fill("Break something");
  await box.press("Enter");
  await expect(page.locator(".err-card")).toContainText(
    "Something went wrong on my side - try again",
  );

  // Retry re-runs the same question; this time it succeeds -> the error card is gone, an insight renders
  await setScript(page, insightScript(100));
  await page
    .locator(".err-card")
    .getByRole("button", { name: "Retry" })
    .click();
  await expect(page.locator(".insight .verdict")).toContainText(
    "Amazon leads hiring with",
  );
  await expect(page.locator(".err-card")).toHaveCount(0);
});

test("AC-10 Should_ShowUnanswerableCopy_When_QuestionCannotBeAnswered", async ({
  page,
}) => {
  await armScript(page, errorScript("unanswerable"));
  await page.goto(freshChat());
  const box = page.getByRole("textbox", { name: composer });
  await box.fill("asdf qwer zxcv");
  await box.press("Enter");
  await expect(page.locator(".err-card")).toContainText(
    "I could not answer that - try rephrasing",
  );
});

test("AC-7 Should_SendAndDisableChip_When_FollowupTapped", async ({ page }) => {
  await armScript(page, insightScript(120));
  await page.goto(freshChat());

  const box = page.getByRole("textbox", { name: composer });
  await box.fill("Which companies are hiring the most?");
  await box.press("Enter");

  const card = page.locator(".insight").first();
  await expect(card.locator(".verdict")).toContainText(
    "Amazon leads hiring with",
  );
  const chip = card.getByRole("button", {
    name: "Only remote roles",
    exact: true,
  });
  await expect(chip).toBeEnabled();

  await setScript(page, insightScript(120)); // the chip's own turn streams the next answer
  await chip.click();

  // the chip text is sent as the next user message
  await expect(
    page.locator(".bubble.user").filter({ hasText: "Only remote roles" }),
  ).toBeVisible();

  // wait for the SECOND turn's card to actually land (a real re-render) BEFORE re-checking the first
  // card's chip - an assertion made right after the click could pass even if the marking did not survive
  // the re-render, since it would already be true on the very first (near-instant) Playwright poll.
  await expect(
    page.locator(".insight").nth(1).locator(".verdict"),
  ).toContainText("Amazon leads hiring with");
  await expect(
    card.getByRole("button", { name: "Only remote roles ✓" }),
  ).toBeDisabled();
});

test("Should_Return404_When_ChatIdIsMalformed", async ({ page }) => {
  // A non-UUID :id is a bad route, not a blank new-chat shell (epic decision 2026-07-19, 006 review):
  // the page Zod-validates the param at the trust boundary and calls notFound().
  const res = await page.goto("/chat/not-a-uuid");
  expect(res?.status()).toBe(404);
});

test("AC-15 / refresh #2 s8 Should_ShowRegisterCard_When_CapRefused", async ({
  page,
}) => {
  await armScript(page, refusalScript("guest_cap"));
  await page.goto(freshChat());
  const box = page.getByRole("textbox", { name: composer });
  await box.fill("One more question");
  await box.press("Enter");

  // the warm accent-soft register card, not the error card
  await expect(page.locator(".register-card")).toContainText(
    "reached the guest limit",
  );
  await expect(
    page
      .locator(".register-card")
      .getByRole("button", { name: "Create account" }),
  ).toBeVisible();
  await expect(page.locator(".err-card")).toHaveCount(0);
});
