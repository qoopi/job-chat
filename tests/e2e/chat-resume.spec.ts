import { expect, test } from "@playwright/test";
import type { ScriptStep } from "./chat-mock";

const CHAT_ID = "00000000-0000-4000-8000-000000000000";
const CHAT = `/chat/${CHAT_ID}`;

// AC-13: a returning/reloading guest gets their conversation restored from the message store - every
// insight card rendered (verdict, chart, table, SQL intact) with NO re-run of analytics. In E2E the
// resume source is the fixture thread (no Postgres); the invariant under test is that the cards come
// from server-rendered stored state, and nothing hits ClickHouse to redraw them.
test("Should_RestoreCardsFromStore_When_GuestReturns", async ({ page }) => {
  const analyticsCalls: string[] = [];
  page.on("request", (r) => {
    if (/clickhouse|\/analytics|\/api\/query/i.test(r.url())) analyticsCalls.push(r.url());
  });

  await page.goto(CHAT);
  await page.reload(); // "returns or reloads"

  // every card restored: the four chart primitives + the one table, with the verdict number bolded
  await expect(page.locator("svg.recharts-surface")).toHaveCount(4);
  await expect(page.locator("table.data-table")).toHaveCount(1);
  await expect(page.locator(".verdict b").first()).toBeVisible();

  // SQL intact behind Show query
  const firstCard = page.locator(".insight").first();
  await firstCard.getByRole("button", { name: "Show query" }).click();
  await expect(firstCard.locator(".codeblock")).toContainText("FROM postings FINAL");

  // no analytics re-query on resume
  expect(analyticsCalls, `unexpected analytics calls:\n${analyticsCalls.join("\n")}`).toEqual([]);
});

// AC-1: reloading a settled conversation renders each message and each card EXACTLY once - the R1
// persisted session makes a reload's `reconnectToStream` no-op (isStreaming not set), so nothing replays
// the already-hydrated turns. The fixture holds 5 insight cards (4 charts + 1 table) across 7 turns.
test("Should_RenderEachMessageOnce_When_ReloadedMidStreamAndSettled", async ({ page }) => {
  await page.goto(CHAT);
  await page.reload();

  // Each card exactly once - no duplicate cards, no re-appended turn.
  await expect(page.locator(".insight")).toHaveCount(5);
  await expect(page.locator("svg.recharts-surface")).toHaveCount(4);
  await expect(page.locator("table.data-table")).toHaveCount(1);

  // Each user question renders exactly once (a replayed tail would double one of these).
  for (const q of [
    "Top companies hiring right now",
    "Remote vs onsite vs hybrid",
    "Show me the latest senior roles",
  ]) {
    await expect(page.locator(".bubble.user", { hasText: q })).toHaveCount(1);
  }
});

// AC-3 (mid-stream reload resumes the in-flight turn without duplicating earlier content) is proven at
// the component seam in tests/component/chat-resume-mid-stream.test.tsx: the AI SDK's `resumeStream`
// seeds its streaming state from the LAST message, so a faithful resume needs a thread ending in an
// in-flight assistant turn - which the shared read-only e2e fixture (ends in a settled error card) can
// not express. A fixture-backed e2e of the mid-stream case is left to 05-testing.

// AC-2: the first follow-up after a reload streams ONLY the new turn - no earlier turn is re-rendered,
// and the new answer appears exactly once. After R1/R2 the transport owns the cursor, so `sendMessages`
// subscribes from the right point and the mock never prepends a prior tail.
test("Should_StreamOnlyNewTurn_When_FollowUpAfterReload", async ({ page }) => {
  const newAnswer: ScriptStep[] = [
    { chunk: { type: "start", messageId: "followup-turn-1" } },
    { chunk: { type: "text-start", id: "n" } },
    { chunk: { type: "text-delta", id: "n", delta: "ONLY-THE-NEW-TURN streamed." } },
    { chunk: { type: "text-end", id: "n" } },
    { chunk: { type: "finish" } },
  ];
  await page.addInitScript((s) => {
    (window as unknown as { __CHAT_SCRIPT__?: unknown }).__CHAT_SCRIPT__ = s;
  }, newAnswer);

  await page.goto(CHAT);
  await page.reload();
  await expect(page.locator(".insight")).toHaveCount(5); // settled state before the follow-up

  const box = page.getByRole("textbox", { name: "Ask a follow-up" });
  await box.fill("And how about remote roles?");
  await box.press("Enter");

  // The new answer streams and appears exactly once.
  await expect(
    page.locator(".bubble.ai", { hasText: "ONLY-THE-NEW-TURN streamed." }),
  ).toHaveCount(1);
  // No earlier turn re-rendered: the 5 fixture insight cards are unchanged (a replayed tail would add copies).
  await expect(page.locator(".insight")).toHaveCount(5);
  await expect(page.locator(".bubble.user", { hasText: "And how about remote roles?" })).toHaveCount(1);
});
