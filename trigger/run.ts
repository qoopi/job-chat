import type { ToolSet } from "ai";
import type { Store } from "@shared/store";
import type { GuardConfig } from "@shared/env";
import type { CoverageProfile } from "@shared/analytics";
import type { Profile } from "@shared/profile";
import { isProfileCardPayload, type RefusalReason } from "@shared/insight";
import { checkConversationGuards } from "./guard";
import { buildModelHistory, refusalPart, type ModelMessage } from "./parts";
import { persistIncomingUserTurns, type RunMessage } from "./persistence";
import type { EmitPart } from "./tools";

// The durable chat run's orchestration seam, extracted from trigger/chat.ts so the whole per-turn loop
// is unit-testable WITHOUT Bedrock or the Trigger runtime (the model is an injected dependency). Per
// turn it: (1) persists the newly-arrived user turn(s) - the single persist site for a follow-up, with
// the input-size backstop; (2) applies the cap/budget backstop on the write-token's real path to the
// model; (3) REBUILDS the model input from the store (Postgres, source of truth) so the model always
// sees the full alternating user+assistant history - NOT the SDK's cross-turn replay, which drops the
// assistant answers and made every turn re-answer all prior questions; (4) hands that
// history to the injected model seam. A refusal streams a taxonomized part and returns WITHOUT calling
// the model, so a guest can never drive the model past the cap/budget or with an unbounded payload.

/** The arguments the injected model seam receives - the rebuilt history plus the turn's tools/signal. */
export interface StreamModelArgs {
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  signal: AbortSignal;
}

/** The model seam: given the rebuilt history, produce the streamed response (real: `streamText`). */
export type StreamModel<R> = (args: StreamModelArgs) => R;

/** The wire trigger for a run (SDK `ChatTaskRunPayload.trigger`). The gate keys Retry off this, never
 *  guessing from the persisted tail. Only `submit-message` / `regenerate-message` reach a turn run. */
export type ChatTrigger = "submit-message" | "regenerate-message" | "preload" | "action" | "close";

/** The subset of the SDK's chat-agent run payload this orchestrator consumes. */
export interface ChatRunArgs {
  chatId: string;
  messages: RunMessage[];
  trigger: ChatTrigger;
  tools: ToolSet;
  signal: AbortSignal;
}

export interface ChatRunDeps<R> {
  /** Open a short-lived single-connection store for one turn (open, use, close). */
  withStore: <T>(fn: (store: Store) => Promise<T>) => Promise<T>;
  guards: GuardConfig;
  emit: (part: EmitPart) => void;
  now: () => Date;
  system: string;
  /** The corpus shape, memoized at the source. When present, a one-line DATA SCOPE note
   *  is appended to the system prompt so the agent can qualify whole-market questions to the real sample. */
  coverageProfile?: () => Promise<CoverageProfile>;
  /**
   * The conversation OWNER's structured profile, resolved PER TURN (never memoized - a save mid-session
   * must take effect on the very next turn). When it resolves non-null, a PROFILE note is appended to the
   * system prompt so the agent routes a fit-intent to search_postings (not request_profile). Only the
   * STRUCTURED profile reaches the model - the raw resume never does. A failure never blocks the turn.
   */
  profile?: (chatId: string) => Promise<Profile | null>;
  streamModel: StreamModel<R>;
}

type Gate =
  | { kind: "refuse"; reason: RefusalReason }
  | { kind: "skip" }
  | { kind: "run"; history: ModelMessage[] };

/**
 * The PROFILE note appended to the system prompt when the conversation owner has a profile. Carries the
 * STRUCTURED profile only (never the raw resume) so the agent routes a fit-intent to search_postings and
 * draws its titleTerms from the real titles; the authoritative filters (seniority, salary floor) stay
 * server-side. Null scalar fields are simply omitted (an omitted line = unknown).
 */
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

/** The one-line DATA SCOPE note appended to the system prompt from the corpus profile. */
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

export function createChatRun<R>(deps: ChatRunDeps<R>) {
  return async (args: ChatRunArgs): Promise<R | undefined> => {
    const { chatId, messages, trigger, tools, signal } = args;

    // Gate order (all on ONE connection so the reads are consistent): guards FIRST, then persist the
    // incoming turn(s), then the already-answered dedup. Guards-first means a refused turn persists
    // nothing - not even its own user row - and the cap counts the PRIOR rows only, exactly like the
    // action gate (never one message stricter). The dedup runs AFTER persist so the tail reflects the
    // new turn, and it keys Retry off the WIRE trigger, not the tail role: a failed turn now leaves a
    // trailing assistant error row, so a tail-role guess would wrongly skip a legitimate Retry.
    const gate = await deps.withStore<Gate>(async (store) => {
      // Cap / daily-budget backstop (counts prior rows only - the new turn is not yet persisted).
      const refusal = await checkConversationGuards(
        { store, guards: deps.guards, now: deps.now },
        chatId,
      );
      if (refusal) return { kind: "refuse", reason: refusal };

      // Persist the newly-arrived user turn(s) (count-based, so a redelivery is a no-op). The input-size
      // backstop refuses an over-length turn here, before it reaches Postgres or Bedrock - still nothing
      // persisted.
      const tooLong = await persistIncomingUserTurns(store, chatId, messages);
      if (tooLong) return { kind: "refuse", reason: tooLong };

      // A regenerate (Retry) supersedes the row it re-answers: mirror the SDK's trailing-assistant pop
      // (it trims trailing assistant messages from its accumulator until the tail is a user, then
      // re-runs) in the DURABLE store, BEFORE the read below - so the superseded error card (or a prior
      // answer) is gone, and both the rebuilt history and a later reload show exactly ONE assistant reply
      // per user turn. A no-op on submit (nothing trails the just-persisted user turn).
      if (trigger === "regenerate-message") await store.deleteTrailingAssistant(chatId);

      const loaded = await store.getConversation(chatId);
      const persisted = loaded?.messages ?? [];

      // The LOAD-BEARING dedup. Crash-continuation re-dispatch re-EXECUTES a turn with a NEW assistant id
      // (the upsert only stops SAME-id replays), so only this gate stops that duplicate. A regenerate
      // (Retry) always runs (its superseded tail was popped above). A submit whose turn is already
      // answered (a non-user tail) is a redelivery - skip.
      //
      // The tail is computed over NON-profile-card rows: a profile-card is appended out-of-band by the
      // save flow (never a turn), so a save landing mid-turn must not make a redispatched envelope skip a
      // still-unanswered question. buildModelHistory already drops the card from the model input, so this
      // only aligns the dedup's view of "the last real turn".
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

    // Append the DATA SCOPE note so the agent qualifies whole-market questions honestly. A profile
    // failure must never block the turn - `system` still holds the base prompt (set above), so on any
    // error we simply skip the note.
    let system = deps.system;
    if (deps.coverageProfile) {
      try {
        system = `${system}\n\n${dataScopeNote(await deps.coverageProfile())}`;
      } catch {
        // keep the base prompt
      }
    }

    // The PROFILE note (per turn, owner-keyed): a saved profile flips fit-intent routing to
    // search_postings. Resolved fresh each turn - never memoized - so a save mid-session takes effect on
    // the next turn. A resolution failure must never block the turn (keep the prompt as-is).
    if (deps.profile) {
      try {
        const prof = await deps.profile(chatId);
        if (prof) system = `${system}\n\n${profileNote(prof)}`;
      } catch {
        // keep the prompt as-is
      }
    }

    return deps.streamModel({ system, messages: gate.history, tools, signal });
  };
}
