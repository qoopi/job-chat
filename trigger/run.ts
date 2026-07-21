import type { ToolSet } from "ai";
import type { Store } from "@shared/store";
import type { GuardConfig } from "@shared/env";
import type { CoverageProfile } from "@shared/analytics";
import { checkConversationGuards } from "./guard";
import {
  buildModelHistory,
  persistIncomingUserTurns,
  refusalPart,
  type ModelMessage,
  type RefusalPartReason,
  type RunMessage,
} from "./parts";
import type { EmitPart } from "./tools";

// The durable chat run's orchestration seam, extracted from trigger/chat.ts so the whole per-turn loop
// is unit-testable WITHOUT Bedrock or the Trigger runtime (the model is an injected dependency). Per
// turn it: (1) persists the newly-arrived user turn(s) - the single persist site for a follow-up, with
// the input-size backstop; (2) applies the cap/budget backstop on the write-token's real path to the
// model; (3) REBUILDS the model input from the store (Postgres, source of truth) so the model always
// sees the full alternating user+assistant history - NOT the SDK's cross-turn replay, which drops the
// assistant answers and made every turn re-answer all prior questions (004 round 4); (4) hands that
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

/** The subset of the SDK's chat-agent run payload this orchestrator consumes. */
export interface ChatRunArgs {
  chatId: string;
  messages: RunMessage[];
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
  /** The corpus shape, memoized at the source (018 strand 5). When present, a one-line DATA SCOPE note
   *  is appended to the system prompt so the agent can qualify whole-market questions to the real sample. */
  coverageProfile?: () => Promise<CoverageProfile>;
  streamModel: StreamModel<R>;
}

type Gate = { kind: "refuse"; reason: RefusalPartReason } | { kind: "run"; history: ModelMessage[] };

/** The one-line DATA SCOPE note appended to the system prompt from the corpus profile (018 strand 5). */
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
    const { chatId, messages, tools, signal } = args;

    // Persist the newly-arrived user turn(s) BEFORE the guard counts them, then apply the backstop,
    // then rebuild the model input from the now-current store - all on ONE connection so persist ->
    // count -> rebuild is atomic and reads the same history.
    const gate = await deps.withStore<Gate>(async (store) => {
      const tooLong = await persistIncomingUserTurns(store, chatId, messages);
      if (tooLong) return { kind: "refuse", reason: tooLong };

      const refusal = await checkConversationGuards(
        { store, guards: deps.guards, now: deps.now },
        chatId,
      );
      if (refusal) return { kind: "refuse", reason: refusal };

      const loaded = await store.getConversation(chatId);
      return { kind: "run", history: buildModelHistory(loaded?.messages ?? []) };
    });

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
        system = `${deps.system}\n\n${dataScopeNote(await deps.coverageProfile())}`;
      } catch {
        // keep the base prompt
      }
    }

    return deps.streamModel({ system, messages: gate.history, tools, signal });
  };
}
