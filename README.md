# Job.Chat

**Ask the job market anything — and get charts, not paragraphs.**

Job.Chat is a chat agent for the ClickHouse x Trigger.dev Virtual Summer Hackathon 2026
("Beyond the Wall of Text"): every answer is a visual, interactive component — salary
distributions, skill trends, demand maps — with a one-line verdict. Live at
[jobchat.dev](https://jobchat.dev).

## Architecture

```
Next.js (this repo, Vercel)          Trigger.dev cloud                Data
  chat UI (useChat over  ─────────►  chat.agent() - one durable       ClickHouse Cloud
  useTriggerChatTransport)           task per conversation;             postings corpus +
  server actions: session            tools query ClickHouse +           all analytical reads
  tokens, start-chat                 searchnapply                     ClickHouse Managed
                                     scheduled ingestion tasks:        Postgres (OLTP:
                                     searchnapply REST -> normalize    user state) --CDC-->
                                     -> LLM enrichment -> ClickHouse   ClickHouse
```

- **Trigger.dev** (`trigger/`): the `chat.agent()` conversation loop and the scheduled ingestion
  pipeline — the orchestration layer required by the hackathon.
- **ClickHouse** is the primary database: every analytical read behind every chart.
- **ClickHouse Managed Postgres** holds transactional user state, synced into ClickHouse via the
  built-in CDC wizard (the OLTP + OLAP pairing).
- **LLM**: Claude via AWS Bedrock (`@ai-sdk/amazon-bedrock`).

### About searchnapply.com

[searchnapply.com](https://searchnapply.com) is a pre-existing, independent job-search platform
operated by this team. Job.Chat consumes it strictly as an **external REST API** — a job-postings
aggregator used as a data source (bulk ingestion + live search). None of its code is part of this
repository or this submission; everything here was built during the hackathon window.

## Run it

```bash
bun install
cp .env.example .env        # fill in your values
bun run dev                 # Next.js app
bunx trigger.dev@latest dev # Trigger.dev tasks (local dev, needs a project ref)
```

Checks: `bun run build` · `bun run lint` · `bunx tsc --noEmit` · `bun run test`

Postgres schema lives in `migrations/*.sql` (applied in order).

## License

MIT — see [LICENSE](LICENSE).
