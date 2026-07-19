# Job.Chat

Job.Chat is a chat agent over live job-market data, built for the ClickHouse x Trigger.dev Virtual
Summer Hackathon 2026 ("Beyond the Wall of Text"). Every data question gets one insight card
(verdict + chart/table + Show query), not a paragraph. P1 status: functionally complete locally
(chat loop, charts, resume, guards); not yet deployed.

## Architecture

```
Next.js (this repo, Vercel)          Trigger.dev cloud                Data
  chat UI (useChat over  ─────────►  chat.agent() - one durable       ClickHouse Cloud
  useTriggerChatTransport)           task per conversation;             postings corpus +
  server actions: guest             tools = a fixed SQL-template        all analytical reads
  cookie, session tokens,           catalog (analytics.ts) against    ClickHouse Managed
  start-chat/send                   ClickHouse; scheduled ingest:     Postgres (OLTP: users,
                                     searchnapply REST -> ClickHouse   conversations, messages)
                                                                       --CDC--> ClickHouse
```

- **Trigger.dev** (`trigger/`): the `chat.agent()` conversation loop (Bedrock, catalog tools,
  turn/step ceilings, guard backstop, persistence) and the scheduled postings ingestion task.
- **ClickHouse** is the primary database: the `postings` table (ReplacingMergeTree) and every
  analytical read behind every chart, via a fixed query-template catalog (`shared/analytics.ts`,
  read-only `jobchat_ro` user) — no free-form/generative SQL.
- **ClickHouse Managed Postgres** holds transactional state — `users`, `conversations`, `messages`
  (`migrations/*.sql`) — synced into ClickHouse via the built-in CDC wizard (the OLTP + OLAP
  pairing).
- **LLM**: Claude via AWS Bedrock (`@ai-sdk/amazon-bedrock`, `eu.` inference profile).

### About searchnapply.com

[searchnapply.com](https://searchnapply.com) is a pre-existing, independent job-search platform
operated by this team. Job.Chat consumes it strictly as an **external REST API** — a job-postings
source for scheduled ingestion into ClickHouse. None of its code is part of this repository or
this submission; everything here was built during the hackathon window.

## Run it

```bash
bun install
cp .env.example .env        # fill in your values (ClickHouse, Postgres, AWS Bedrock, searchnapply)
bun run ch:migrate           # ClickHouse DDL (migrations/clickhouse/*.sql)
bun run pg:migrate           # Postgres DDL (migrations/*.sql)
bunx trigger.dev@latest dev  # Trigger.dev tasks (local dev, needs a project ref + login)
bun run dev                  # Next.js app
```

`bun run build` produces the production build.

## Checks

```bash
bun run lint
bunx tsc --noEmit
bun run test           # vitest (unit + integration; integration needs live ClickHouse/Postgres/searchnapply creds)
bunx playwright test   # e2e against the built app
```

## License

MIT — see [LICENSE](LICENSE).
