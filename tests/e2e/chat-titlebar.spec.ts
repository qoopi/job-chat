import { expect, test } from "@playwright/test";

const CHAT = "/chat/00000000-0000-4000-8000-000000000000";

// AC-14: a conversation with messages shows its generated title in the canvas title bar, and the guest
// sidebar keeps the design's teaser state.
test("Should_ShowTitleInTitleBar_When_MessagesExist", async ({ page }) => {
  await page.goto(CHAT);

  const titleBar = page.getByTestId("title-bar");
  await expect(titleBar).toHaveText("Data Engineer pay in SF");

  // guest sidebar still shows the teaser (history is a signed-in feature)
  await expect(page.getByText("Sign in to keep your conversations.")).toBeVisible();
});
