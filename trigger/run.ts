import type { ToolSet } from "ai";
import type { Store } from "@shared/store";
import type { GuardConfig } from "@shared/env";
import type { CoverageProfile, CorpusSummary } from "@shared/analytics";
import type { Profile } from "@shared/profile";
import { isProfileCardPayload, type RefusalReason } from "@shared/insight";
import { checkConversationGuards } from "./guard";
import { buildModelHistory, refusalPart, type ModelMessage } from "./parts";
import { persistIncomingUserTurns, type RunMessage } from "./persistence";
import type { EmitPart } from "./tools";

// Durable run orchestration (unit-testable without Bedrock/Trigger): persist, backstop, REBUILD model input from the store (not SDK replay), stream; a refusal returns without calling the model.

export interface StreamModelArgs {
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  signal: AbortSignal;
}

export type StreamModel<R> = (args: StreamModelArgs) => R;

export type ChatTrigger = "submit-message" | "regenerate-message" | "preload" | "action" | "close";

export interface ChatRunArgs {
  chatId: string;
  messages: RunMessage[];
  trigger: ChatTrigger;
  tools: ToolSet;
  signal: AbortSignal;
}

export interface ChatRunDeps<R> {
  withStore: <T>(fn: (store: Store) => Promise<T>) => Promise<T>;
  guards: GuardConfig;
  emit: (part: EmitPart) => void;
  now: () => Date;
  system: string;
  coverageProfile?: () => Promise<CoverageProfile>;
  /** The owner's structured profile, resolved PER TURN (never memoized); a failure never blocks the turn. */
  profile?: (chatId: string) => Promise<Profile | null>;
  /** The live corpus summary for the CORPUS note, fetched ONCE per conversation and reused
   *  across its turns (createChatRun memoizes by chatId); a failure degrades to NO note, never a turn failure. */
  corpus?: (chatId: string) => Promise<CorpusSummary | null>;
  streamModel: StreamModel<R>;
}

type Gate =
  | { kind: "refuse"; reason: RefusalReason }
  | { kind: "skip" }
  | { kind: "run"; history: ModelMessage[] };

/** The PROFILE note (STRUCTURED profile only, never the raw resume): the agent draws titleTerms from the
 *  titles; authoritative filters (seniority, salary floor) stay server-side. Omitted line = unknown. */
function profileNote(p: Profile): string {
  const lines = [
    "PROFILE: this signed-in user has a saved profile - route a personal fit-intent to search_postings, NEVER request_profile.",
  ];
  if (p.titles.length) lines.push(`Titles: ${p.titles.join(", ")}.`);
  if (p.seniority) lines.push(`Seniority: ${p.seniority}.`);
  if (p.skills.length) lines.push(`Top skills: ${p.skills.slice(0, 8).map((s) => s.name).join(", ")}.`);
  if (p.locations.length) lines.push(`Locations: ${p.locations.join(", ")}.`);
  if (p.remotePref !== null) lines.push(`Open to remote: ${p.remotePref ? "yes" : "no"}.`);
  if (p.salaryMin !== null) lines.push(`Salary floor: ${p.salaryMin}.`);
  lines.push(
    "Draw search_postings titleTerms from these titles; the server applies the seniority and salary floor itself. The postings card is the whole answer - add no prose.",
  );
  return lines.join(" ");
}

function dataScopeNote(p: CoverageProfile): string {
  const sharePct = Math.round(p.topCompanyShare * 100);
  const salaryPct = Math.round(p.salaryCoverage * 100);
  const updated = p.freshestAt.slice(0, 10); // YYYY-MM-DD
  return (
    `DATA SCOPE: you answer from ${p.total.toLocaleString()} open postings across ${p.distinctCompanies} companies` +
    ` - ${sharePct}% are ${p.topCompany} - updated ${updated}; salary is present on ~${salaryPct}%.` +
    ` When a question implies the WHOLE job market ("the US job market", "who pays most in tech"), QUALIFY` +
    ` your answer to this sample ("across our current sample, which is mostly ${p.topCompany}...") - never` +
    ` present the sample as the whole market. Questions about what is IN the sample ("at ${p.topCompany}", "in SF") stay unqualified.`
  );
}

/** The CORPUS note: a compact text block listing what the live data actually contains, so the
 *  agent draws filter spellings from real values and can be honest when a requested value is absent.
 *  Omitted line = that dimension had no values. Prompt v3 teaches how to use it. */
function corpusNote(c: CorpusSummary): string {
  const snapshot = c.freshestAt.slice(0, 10); // YYYY-MM-DD
  const salaryPct = Math.round(c.salaryCoverage * 100);
  // Defense-in-depth: corpus values are ingest-sourced free text entering a prompt - collapse
  // any whitespace/newlines and cap length so a pathological value can't inject line structure into the note.
  const clean = (v: string) => v.replace(/\s+/g, " ").trim().slice(0, 60);
  const lines = [
    `CORPUS: the live data you answer from right now - ${c.total.toLocaleString()} open postings, snapshot ${snapshot}.` +
      ` These are the values that EXIST; filter matching is case-insensitive (use any casing).`,
  ];
  if (c.sources.length)
    lines.push(`Sources: ${c.sources.map((s) => `${clean(s.source)} ${Math.round(s.share * 100)}%`).join(", ")}.`);
  // Countries, like cities, are a top-N sample (buildCorpusSql caps both) - label them "busiest" so v3 does
  // not falsely refuse a country ranked past the cap.
  if (c.topCities.length) lines.push(`Busiest cities: ${c.topCities.map(clean).join(", ")}.`);
  if (c.countries.length) lines.push(`Busiest countries: ${c.countries.map(clean).join(", ")}.`);
  if (c.experienceLevels.length) lines.push(`experience_level values: ${c.experienceLevels.map(clean).join(", ")}.`);
  if (c.employmentTypes.length) lines.push(`employment_type values: ${c.employmentTypes.map(clean).join(", ")}.`);
  if (c.locationKinds.length) lines.push(`location_kind values: ${c.locationKinds.map(clean).join(", ")}.`);
  lines.push(`Salary present on ~${salaryPct}% of postings.`);
  return lines.join(" ");
}

export function createChatRun<R>(deps: ChatRunDeps<R>) {
  // The CORPUS summary is fetched ONCE per conversation and reused across its turns, so the note
  // (and the cached system prefix it rides in) stays byte-stable while a chat is active; a NEW chat
  // (new chatId) re-fetches fresh corpus facts. Held for the life of this run factory (a module singleton
  // in trigger/chat.ts). A rejected fetch is NOT pinned - a later turn retries.
  const corpusByChat = new Map<string, Promise<CorpusSummary | null>>();
  const CORPUS_MEMO_CAP = 1000; // bound the worker-lifetime memo (chatId is unbounded)
  const resolveCorpus = (
    chatId: string,
    fetch: (id: string) => Promise<CorpusSummary | null>,
  ): Promise<CorpusSummary | null> => {
    const cached = corpusByChat.get(chatId);
    if (cached) return cached;
    // Clear-all (not evict-one) past the cap: a re-fetch of the stable corpus re-renders byte-identically,
    // so an active conversation's cached system prefix stays warm across the rare clear.
    if (corpusByChat.size >= CORPUS_MEMO_CAP) corpusByChat.clear();
    const pending = fetch(chatId).catch((err) => {
      corpusByChat.delete(chatId);
      throw err;
    });
    corpusByChat.set(chatId, pending);
    return pending;
  };

  return async (args: ChatRunArgs): Promise<R | undefined> => {
    const { chatId, messages, trigger, tools, signal } = args;

    // Gate order (ONE connection): guards FIRST (a refused turn persists nothing, cap counts prior rows
    // only), then persist, then the already-answered dedup - keyed off the WIRE trigger, not the tail role.
    const gate = await deps.withStore<Gate>(async (store) => {
      const refusal = await checkConversationGuards(
        { store, guards: deps.guards, now: deps.now },
        chatId,
      );
      if (refusal) return { kind: "refuse", reason: refusal };

      const tooLong = await persistIncomingUserTurns(store, chatId, messages);
      if (tooLong) return { kind: "refuse", reason: tooLong };

      // Regenerate (Retry) supersedes the row it re-answers: mirror the SDK's trailing-assistant pop in the
      // DURABLE store BEFORE the read, so history + reload show exactly ONE assistant reply per user turn.
      if (trigger === "regenerate-message") await store.deleteTrailingAssistant(chatId);

      const loaded = await store.getConversation(chatId);
      const persisted = loaded?.messages ?? [];

      // The LOAD-BEARING dedup: crash re-dispatch re-EXECUTES a turn with a NEW assistant id (the upsert only
      // stops SAME-id replays), so only this gate stops that duplicate; an already-answered submit is a
      // redelivery (skip). Tail computed over NON-profile-card rows (a card is out-of-band, not a turn).
      const tail = [...persisted].reverse().find((m) => !isProfileCardPayload(m.parts));
      const alreadyAnswered = tail !== undefined && tail.role !== "user";
      if (trigger !== "regenerate-message" && alreadyAnswered) return { kind: "skip" };

      return { kind: "run", history: buildModelHistory(persisted) };
    });

    if (gate.kind === "skip") {
      console.log("[turn] already answered - skipped redelivered submit envelope");
      return undefined;
    }

    if (gate.kind === "refuse") {
      deps.emit(refusalPart(crypto.randomUUID(), gate.reason));
      return undefined;
    }

    // Append the DATA SCOPE note; on any failure keep the base prompt (never block the turn).
    let system = deps.system;
    if (deps.coverageProfile) {
      try {
        system = `${system}\n\n${dataScopeNote(await deps.coverageProfile())}`;
      } catch {
        // keep the base prompt
      }
    }

    if (deps.profile) {
      try {
        const prof = await deps.profile(chatId);
        if (prof) system = `${system}\n\n${profileNote(prof)}`;
      } catch {
        // keep the prompt as-is
      }
    }

    // The CORPUS note (once per conversation, reused across turns); a failed fetch degrades to no note.
    if (deps.corpus) {
      try {
        const summary = await resolveCorpus(chatId, deps.corpus);
        if (summary) system = `${system}\n\n${corpusNote(summary)}`;
      } catch {
        // keep the prompt as-is (fetch failed) - never block the turn
      }
    }

    return deps.streamModel({ system, messages: gate.history, tools, signal });
  };
}
