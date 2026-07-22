# Job.Chat

Job.Chat is a chat agent over live job-market data, built for the ClickHouse x Trigger.dev Virtual
Summer Hackathon 2026 ("Beyond the Wall of Text"). Ask it anything about the market and the answer
is one insight card - a one-line verdict plus an interactive chart or table, with "Show query"
revealing the exact ClickHouse SQL - never a wall of text. Signed-in users can drop in a resume to
get a structured profile (enriched with public GitHub signals) matched against live postings. Live
at jobchat.dev.

## Architecture

```
Next.js (this repo, Vercel)          Trigger.dev cloud                Data
  chat UI (useChat over    ----->    chat.agent() - one durable       ClickHouse Cloud
  useTriggerChatTransport)           run per conversation;              postings corpus +
  server actions: guest              tools = fixed + composed SQL       all analytical reads
  cookie, session tokens,            catalog (analytics.ts) against   ClickHouse Managed Postgres
  start-chat/send                    ClickHouse; scheduled ingest      (OLTP: users, conversations,
                                     + profile-extraction tasks         messages, profiles);
                                                                        users --CDC--> ClickHouse
```

- **Trigger.dev** (`trigger/`): the `chat.agent()` conversation loop (Bedrock, catalog tools,
  turn/step ceilings, guard backstop, persistence), the durable resume-to-profile extraction task
  (with GitHub enrichment), and the scheduled postings ingestion task.
- **ClickHouse** is the primary database: the `postings` table (ReplacingMergeTree) and every
  analytical read behind every chart, via `shared/analytics.ts` (read-only `jobchat_ro` user) -
  six fixed query templates plus a schema-validated composed-query builder (whitelisted
  measures/dimensions/filters) for anything else the postings columns can answer - no
  free-form/generative SQL either way.
- **ClickHouse Managed Postgres** holds transactional state - `users`, `conversations`, `messages`,
  `profiles` (`migrations/*.sql`). The `users` table is mirrored into ClickHouse via the built-in
  CDC ClickPipe; `postings` is the OLAP core (the OLTP + OLAP pairing).
- **Auth** (`src/lib/auth.ts`): Better Auth with Google OAuth. Guests chat with no account; signing
  in adopts any guest conversations into the account (sidebar history, any device) and raises the
  per-user message cap.
- **LLM**: Claude via AWS Bedrock (`@ai-sdk/amazon-bedrock`, `eu.` inference profile) - Sonnet 4.5
  for the chat agent, Haiku 4.5 for profile extraction.

### About searchnapply.com

[searchnapply.com](https://searchnapply.com) is a pre-existing, independent job-search platform
operated by this team. Job.Chat consumes it strictly as an **external REST API** — a job-postings
source for scheduled ingestion into ClickHouse. None of its code is part of this repository or
this submission; everything here was built during the hackathon window.

## Run it

```bash
bun install
cp .env.example .env        # fill in your values (ClickHouse, Postgres, AWS Bedrock, searchnapply,
                             # Better Auth secret + Google OAuth client - Google is optional; without
                             # it, sign-in is unavailable but guests can still chat)
bun run ch:migrate           # ClickHouse DDL (migrations/clickhouse/*.sql)
bun run pg:migrate           # Postgres DDL (migrations/*.sql)
bunx trigger.dev@latest dev  # Trigger.dev tasks (local dev, needs a project ref + login)
bun run dev                  # Next.js app
```

`bun run build` produces the production build.

## Checks

```bash
bun run lint
bun run typecheck
bun run test        # vitest (unit + integration; integration needs live ClickHouse/Postgres/searchnapply creds)
bun run test:e2e    # playwright (builds + runs the app with network mocks - no cloud services)
```

## Eval harness (dev only)

`JOBCHAT_EVAL=1 bun run eval` drives the real prompt + Bedrock through the 40-case fixture set,
scoring tool choice, mode, chart type, and format conformance. Flag-gated (`JOBCHAT_EVAL=1` +
Bedrock env) and never run in CI - it costs real model credits, so it's an on-demand dev check, not
a build gate.

## License

MIT — see [LICENSE](LICENSE).
