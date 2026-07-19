import type { StoredMessage } from "@/lib/chat-ui";
import { FIXTURE_CONVERSATION, type ThreadItem } from "@/lib/fixtures/conversation";

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

export function e2eFixtureThread(conversationId: string): FixtureThread | null {
  if (conversationId !== FIXTURE_ID) return null;
  return {
    title: FIXTURE_CONVERSATION.title,
    messages: FIXTURE_CONVERSATION.items.map(itemToStored),
  };
}
