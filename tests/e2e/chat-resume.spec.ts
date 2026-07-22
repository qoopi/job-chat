import { expect, test } from "@playwright/test";
import type { ScriptStep } from "./chat-mock";

const CHAT_ID = "00000000-0000-4000-8000-000000000000";
const CHAT = `/chat/${CHAT_ID}`;

// A returning/reloading guest gets their conversation restored from the message store - every
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

// Reloading a SETTLED conversation renders each message and each card EXACTLY once. A
// settled persisted session (isStreaming:false) makes `resume` false, so useChat never calls
// `reconnectToStream` - nothing replays the already-hydrated turns. This seeds that settled session AND
// arms a distinctive `__CHAT_REPLAY__` tail, then asserts the tail NEVER streams: that is what bites the
// gate (without it, a reload would replay the tail as duplicate bubbles). The fixture holds 5 insight
// cards (4 charts + 1 table) across 7 turns.
test("Should_RenderEachMessageOnce_When_ReloadedSettled", async ({ page }) => {
  const REPLAY_MARKER = "SETTLED-REPLAY-SHOULD-NOT-APPEAR";
  await page.addInitScript(
    ({ sessionKey, sessionValue, replay }) => {
      window.sessionStorage.setItem(sessionKey, sessionValue);
      (window as unknown as { __CHAT_REPLAY__?: unknown }).__CHAT_REPLAY__ = replay;
    },
    {
      sessionKey: `jobchat_session:${CHAT_ID}`,
      sessionValue: JSON.stringify({ publicAccessToken: "e2e-tok", isStreaming: false }),
      replay: [
        { chunk: { type: "start", messageId: "settled-replay" } },
        { chunk: { type: "text-start", id: "s" } },
        { chunk: { type: "text-delta", id: "s", delta: REPLAY_MARKER } },
        { chunk: { type: "text-end", id: "s" } },
        { chunk: { type: "finish" } },
      ] satisfies ScriptStep[],
    },
  );

  await page.goto(CHAT);
  await page.reload();

  // Each card exactly once - no duplicate cards, no re-appended turn.
  await expect(page.locator(".insight")).toHaveCount(5);
  await expect(page.locator("svg.recharts-surface")).toHaveCount(4);
  await expect(page.locator("table.data-table")).toHaveCount(1);

  // The settled-session gate bit: the armed replay tail never streamed (resume=false -> no reconnect).
  await expect(page.locator(".bubble.ai", { hasText: REPLAY_MARKER })).toHaveCount(0);

  // Each user question renders exactly once (a replayed tail would double one of these).
  for (const q of [
    "Top companies hiring right now",
    "Remote vs onsite vs hybrid",
    "Show me the latest senior roles",
  ]) {
    await expect(page.locator(".bubble.user", { hasText: q })).toHaveCount(1);
  }
});

// Reloading MID-STREAM resumes the in-flight turn and completes it without duplicating any
// earlier content. The shared FIXTURE_ID thread always ends settled (reused verbatim by other specs), so
// this uses the second, additive fixture id (tests/e2e/chat-fixtures.ts MIDSTREAM_FIXTURE_ID) whose thread
// ends in a lone user question with no assistant reply yet - the state a genuine mid-stream reload
// leaves behind. `resumeStream` seeds from that last message. The persisted session is seeded straight
// into sessionStorage via addInitScript (exactly what the real transport's `onSessionChange` would have
// written before the reload) and `__CHAT_REPLAY__` supplies the resumed tail - this exercises the real
// `chat-transport.ts` hydration + `ChatClient`'s `resume` wiring end-to-end (unlike the component seam in
// tests/component/chat-resume-mid-stream.test.tsx, which mocks `@/lib/chat-transport` out entirely).
const MIDSTREAM_CHAT_ID = "00000000-0000-4000-8000-000000000001";
const MIDSTREAM_CHAT = `/chat/${MIDSTREAM_CHAT_ID}`;

test("Should_ResumeStreamWithoutDuplicating_When_ReloadedMidStream", async ({ page }) => {
  const resumedReplay: ScriptStep[] = [
    { chunk: { type: "start", messageId: "resumed-assistant" } },
    { chunk: { type: "text-start", id: "r" } },
    { chunk: { type: "text-delta", id: "r", delta: "RESUMED-ANSWER completing after the reload." } },
    { chunk: { type: "text-end", id: "r" } },
    { chunk: { type: "finish" } },
  ];
  await page.addInitScript(
    ({ replay, sessionKey, sessionValue }) => {
      (window as unknown as { __CHAT_REPLAY__?: unknown }).__CHAT_REPLAY__ = replay;
      window.sessionStorage.setItem(sessionKey, sessionValue);
    },
    {
      replay: resumedReplay,
      sessionKey: `jobchat_session:${MIDSTREAM_CHAT_ID}`,
      sessionValue: JSON.stringify({ publicAccessToken: "e2e-tok", isStreaming: true }),
    },
  );

  await page.goto(MIDSTREAM_CHAT);

  // The in-flight turn resumes and completes - the resumed answer appears exactly once.
  await expect(
    page.locator(".bubble.ai", { hasText: "RESUMED-ANSWER completing after the reload." }),
  ).toHaveCount(1);

  // No earlier content duplicated: the settled card and both questions render exactly once each.
  await expect(page.locator(".insight")).toHaveCount(1);
  await expect(
    page.locator(".bubble.user", { hasText: "Top companies hiring right now" }),
  ).toHaveCount(1);
  await expect(page.locator(".bubble.user", { hasText: "And remote roles?" })).toHaveCount(1);
});

// The first follow-up after a reload streams ONLY the new turn - no earlier turn is re-rendered,
// and the new answer appears exactly once. The transport owns the cursor, so `sendMessages`
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
