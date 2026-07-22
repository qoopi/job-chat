// Manual dev-server round trip - NOT a vitest test (lives outside
// tests/{unit,integration}). Drives ONE real turn through the deployed dev worker: LLM routing on
// Bedrock -> catalog tool -> streamed data-insight part -> Postgres persistence. Run it with
// `bunx trigger.dev@latest dev` already up:  `bun run tests/manual/live-chat-smoke.ts`.
import postgres from "postgres";
import { createStore } from "../../shared/store";
import { AgentChat } from "@trigger.dev/sdk/chat";
import type { jobChatAgent } from "../../trigger/chat";
import { AGENT_ID } from "../../trigger/agent-id";

const QUESTION = process.argv[2] ?? "Which companies are hiring the most right now?";

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const store = createStore(sql);

async function main() {
  const guest = `live-smoke-${crypto.randomUUID()}`;
  await store.getOrCreateUser(guest);
  const conv = await store.createConversation(guest, QUESTION);
  await store.appendMessage(conv.id, "user", QUESTION, null);
  console.log("[smoke] conversation", conv.id, "\n[smoke] question:", QUESTION);

  const chat = new AgentChat<typeof jobChatAgent>({ agent: AGENT_ID, id: conv.id });
  const stream = await chat.sendRaw([
    { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text: QUESTION }] },
  ]);

  let sawInsight = false;
  let text = "";
  // ReadableStream is async-iterable at runtime (bun/node); the DOM lib type omits it.
  for await (const chunk of stream as unknown as AsyncIterable<Record<string, unknown>>) {
    if (chunk.type === "data-insight") {
      sawInsight = true;
      const data = chunk.data as { kind?: string; chartType?: string; verdict?: string };
      console.log(`[smoke] data-insight kind=${data.kind} chartType=${data.chartType} verdict=${data.verdict ?? "(loading)"}`);
    }
    if (chunk.type === "data-error") console.log("[smoke] data-error", JSON.stringify(chunk.data));
    if (chunk.type === "text-delta" && typeof chunk.delta === "string") text += chunk.delta;
    if (chunk.type === "error") console.log("[smoke] stream error", JSON.stringify(chunk));
  }
  console.log("[smoke] assistant text:", text.trim() || "(none)");
  console.log("[smoke] sawInsight:", sawInsight);

  await new Promise((r) => setTimeout(r, 2000)); // let onTurnComplete persist
  const reloaded = await store.getConversation(conv.id);
  console.log(
    "[smoke] persisted messages:",
    reloaded?.messages.map((m) => `${m.role}:${m.parts ? "card" : "null"}`).join(", "),
  );
}

main()
  .catch((e) => console.error("[smoke] FAILED", e))
  .finally(() => sql.end());
