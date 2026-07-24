import { describe, expect, it } from "vitest";
import { SuggestionsSchema } from "@shared/insight";
import type { Analytics } from "@shared/analytics";
import { buildCatalogTools, type EmitPart } from "../../trigger/tools";
import { extractAssistantPersistence, persistAssistantTurn } from "../../trigger/persistence";
import type { Store } from "@shared/store";
import { classifyCardData, storeToUiMessages, type StoredMessage } from "@/lib/chat-ui";

// The additive discovery-suggestions part: a lightweight tool emits it (mirroring the postings/invite
// emit conventions), it persists + hydrates like the other card parts, and the client classifies it into
// actionable chips. This locks the full wire -> persist -> reload path so a capability turn's chips survive.

const opts = { toolCallId: "call-sugg", messages: [] } as unknown as Parameters<
  NonNullable<ReturnType<typeof buildCatalogTools>["salary_distribution"]["execute"]>
>[1];

const ITEMS = [
  { label: "Find me a job that fits", question: "Find me a job that fits" },
  { label: "Who is hiring the most?", question: "Which companies are hiring the most right now?" },
  { label: "Median salary in Berlin", question: "What is the median salary in Berlin?" },
];

describe("suggest_questions tool emits the additive data-suggestions part", () => {
  it("is registered alongside the other catalog tools", () => {
    const tools = buildCatalogTools({ analytics: {} as Analytics, emit: () => {} });
    expect(tools).toHaveProperty("suggest_questions");
  });

  it("emits a single strict-valid data-suggestions part carrying the items", async () => {
    const emitted: EmitPart[] = [];
    const tools = buildCatalogTools({ analytics: {} as Analytics, emit: (p) => emitted.push(p) });
    const out = await tools.suggest_questions.execute!({ items: ITEMS }, opts);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "data-suggestions",
      id: "call-sugg",
      data: { kind: "suggestions", items: ITEMS },
    });
    // The emitted payload validates against the shared schema (persistable + classifiable).
    expect(SuggestionsSchema.safeParse((emitted[0] as { data: unknown }).data).success).toBe(true);
    // The model view is a compact acknowledgement (the chips are the surface, not prose).
    expect((out as { count: number }).count).toBe(3);
  });

  it("rejects an empty or oversized suggestion set (schema caps at 1..4)", async () => {
    const tools = buildCatalogTools({ analytics: {} as Analytics, emit: () => {} });
    await expect(tools.suggest_questions.execute!({ items: [] }, opts)).rejects.toThrow();
    const five = Array.from({ length: 5 }, (_, i) => ({ label: `L${i}`, question: `Q${i}?` }));
    await expect(tools.suggest_questions.execute!({ items: five }, opts)).rejects.toThrow();
  });
});

describe("suggestions persist + hydrate like the other card parts", () => {
  it("keeps the brief reply prose AND the suggestions payload on extraction", () => {
    const message = {
      role: "assistant",
      parts: [
        { type: "text", text: "I answer job-market questions with a chart, and match your resume to live roles." },
        { type: "data-suggestions", id: "s1", data: { kind: "suggestions", items: ITEMS } },
      ],
    };
    const { content, parts } = extractAssistantPersistence(message);
    // The 2-sentence reply is persisted verbatim (suggestions do NOT suppress the prose)...
    expect(content).toContain("I answer job-market questions");
    // ...alongside the suggestions payload (a real answer part, not a failure marker).
    expect(parts).toEqual({ kind: "suggestions", items: ITEMS });
  });

  it("persists a suggestions turn (a real answer part with its reply)", async () => {
    const appended: Array<{ role: string; content: string; parts: unknown }> = [];
    const store = {
      appendMessage: async (_c: string, role: string, content: string, parts: unknown) => {
        appended.push({ role, content, parts });
        return { role, content, parts } as never;
      },
    } as unknown as Store;
    const responseMessage = {
      role: "assistant",
      parts: [
        { type: "text", text: "Here is what I can do." },
        { type: "data-suggestions", id: "s1", data: { kind: "suggestions", items: ITEMS } },
      ],
    };
    await persistAssistantTurn(store, { conversationId: "c1", responseMessage });
    expect(appended).toEqual([
      { role: "assistant", content: "Here is what I can do.", parts: { kind: "suggestions", items: ITEMS } },
    ]);
  });

  it("classifies a suggestions payload into its items (live OR resumed)", () => {
    const c = classifyCardData({ kind: "suggestions", items: ITEMS });
    expect(c.kind).toBe("suggestions");
    if (c.kind === "suggestions") expect(c.items).toEqual(ITEMS);
  });

  it("drops a malformed suggestions payload to unknown (never throws in render)", () => {
    expect(classifyCardData({ kind: "suggestions" })).toEqual({ kind: "unknown" });
    expect(classifyCardData({ kind: "suggestions", items: [{ label: "" }] })).toEqual({ kind: "unknown" });
  });

  it("re-tags a resumed suggestions payload as a data-suggestions part (reload-safe)", () => {
    const payload = { kind: "suggestions", items: ITEMS };
    const stored: StoredMessage[] = [
      { id: "m1", role: "assistant", content: "Here is what I can do.", parts: payload },
    ];
    const [ui] = storeToUiMessages(stored);
    expect(ui.parts).toEqual([
      { type: "text", text: "Here is what I can do." },
      { type: "data-suggestions", id: "m1-card-0", data: payload },
    ]);
  });
});
