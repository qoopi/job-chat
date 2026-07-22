import type { DataInsight } from "@shared/insight";
import type { StoredMessage } from "@/lib/chat-ui";
import { FIXTURE_CONVERSATION, type ThreadItem } from "./conversation";

// E2E resume fixtures (server side). In E2E mode the chat page resolves its initial conversation from
// here instead of Postgres, so the built app renders a deterministic thread with no DB. The 005 static
// fixture is reused verbatim (same cards, same order) so the existing chart / table / a11y e2e specs
// keep passing once the page runs off the live path. Chip "used" markers are dropped - one-shot chip
// state is now live session state, not persisted.

function itemToStored(item: ThreadItem, i: number): StoredMessage {
  const id = `fx-${i}`;
  if (item.role === "user") return { id, role: "user", content: item.text, parts: null };
  if ("insight" in item) return { id, role: "assistant", content: "", parts: item.insight };
  if ("error" in item) return { id, role: "assistant", content: "", parts: { kind: item.error } };
  if ("refusal" in item) return { id, role: "assistant", content: "", parts: { reason: item.refusal } };
  return { id, role: "assistant", content: item.text, parts: null };
}

export interface FixtureThread {
  title: string;
  messages: StoredMessage[];
}

/** The one seeded conversation the e2e specs resume; other ids resolve as brand-new (no messages). */
const FIXTURE_ID = "00000000-0000-4000-8000-000000000000";

// 020/05-testing (AC-3): a SECOND, additive fixture id - a conversation reloaded MID-STREAM. The shared
// FIXTURE_ID thread above always ends settled (reused verbatim by other specs), but the AI SDK's
// `resumeStream` seeds its resumed state from the LAST message, so a faithful mid-stream reload needs a
// thread ending in an in-flight turn (a user question with no assistant reply yet) - this id supplies
// that, leaving FIXTURE_CONVERSATION untouched.
const MIDSTREAM_FIXTURE_ID = "00000000-0000-4000-8000-000000000001";

const MIDSTREAM_SETTLED_CARD: DataInsight = {
  id: "fx-mid-card",
  kind: "chart",
  chartType: "bars",
  verdict: "Amazon leads hiring with 214 open roles.",
  series: [{ company: "Amazon", count: 214 }],
  followups: ["Only remote roles"],
  meta: { sql: "SELECT 1", sampleN: 3483, updatedAt: "2026-07-18 19:12:00" },
};

const MIDSTREAM_THREAD: FixtureThread = {
  title: "Top companies hiring right now",
  messages: [
    { id: "fx-mid-0", role: "user", content: "Top companies hiring right now", parts: null },
    { id: "fx-mid-1", role: "assistant", content: "", parts: MIDSTREAM_SETTLED_CARD },
    // No assistant reply yet - the in-flight turn a genuine mid-stream reload leaves behind.
    { id: "fx-mid-2", role: "user", content: "And remote roles?", parts: null },
  ],
};

export function e2eFixtureThread(conversationId: string): FixtureThread | null {
  if (conversationId === MIDSTREAM_FIXTURE_ID) return MIDSTREAM_THREAD;
  if (conversationId !== FIXTURE_ID) return null;
  return {
    title: FIXTURE_CONVERSATION.title,
    messages: FIXTURE_CONVERSATION.items.map(itemToStored),
  };
}
