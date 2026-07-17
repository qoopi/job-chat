# 001 - Bootstrap the Job.Chat product repo scaffold

## Epic

`job-chat/Job.Chat.Playbook/tracker/epics/devops/bootstrap-scaffold-epic-2026-07-17.md`
Covers AC: AC-1 .. AC-13 (all).

## Dependencies

None. First task in the repo.

## User story

As the Job.Chat team, we want a verified, production-posture skeleton of the product repo, so that
every following feature lands on working rails (build/lint/type/test gates + git guardrails) from
day one of the build window.

## Goal

Execute bootstrap-plan section B (as amended by spec-review) in `Job.Chat/`: scaffold, deps,
structure, env seam, hooks, verification, one commit on main.

## Scope

Repo: `Job.Chat/` (fresh; git init + `main` exist). Branch: `main` (first commit in an empty repo -
deliberate, flagged in the epic's constitution check; later work branches).
IN: everything in Requirements. OUT: cloud accounts/services, deploy, chat feature, ingestion,
chart lib, TanStack, auth, `clickhouse.ts`/`db.ts` factories (deferred - see epic Scope).

## Context to read

Paths are repo-relative to `Job.Chat/`; cross-repo paths start from the workspace root `job-chat/`.

- Rules: `job-chat/Job.Chat.Playbook/rules/{conduct,house-rules,engineering}.md` + `workflows/CONVENTIONS.md`.
- The epic (above) - ACs, technical design, domain model, tests.
- Skills: `job-chat/Job.Chat.Playbook/skills/triggerdev/trigger-setup` + `trigger-tasks` (config +
  hello task shape); `skills/devops/git-guardrails-claude-code` (hook script + settings wiring);
  `skills/devops/setup-pre-commit` (husky + lint-staged); `skills/clickhouse/managed-postgres-cdc`
  (users-table conventions); `skills/testing/tdd` (env test red first).
- Source of decisions: `job-chat/Job.Chat.Playbook/docs/bootstrap-plan.md` sections B/C.

## Requirements

Strand 1 - scaffold + structure:

1. `bun create next-app` in place: TypeScript, Tailwind, ESLint, App Router, src dir.
2. Add runtime deps `@trigger.dev/sdk@^4.5.4 ai @ai-sdk/amazon-bedrock @ai-sdk/react zod
@clickhouse/client postgres`; dev deps `vitest prettier husky lint-staged`.
3. Author `trigger.config.ts` (placeholder `proj_` ref, dirs ["./trigger"]) + `trigger/hello.ts`
   (plain `task()` per trigger-tasks skill).
4. TDD the env seam: write the failing AC-5 vitest test first, then `src/lib/env.ts` (zod schema
   over the AC-8 names; lazy `getEnv()`; no parse at import).
5. `migrations/0001_init.sql` per the epic's domain model.
6. `LICENSE` (MIT), `README.md` (architecture, searchnapply.com role, run steps), `.env.example`
   (exact AC-8 list + commented AWS_PROFILE), `.gitignore` + `.env*` exclusion.
   Validate strand (build/lint/tsc/test), then proceed (single commit at task end).
   Strand 2 - guardrails + verification + commit:
7. Install git guardrails: copy the hook from the skill, wire `Job.Chat/.claude/settings.json`,
   verify AC-11's echo test exits 2.
8. Install pre-commit: husky + lint-staged (prettier) + `tsc --noEmit` gate.
9. Run the full Validation checklist below; then ONE commit on main, message ending with the
   `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer (AC-12 observed on this commit).
   Do NOT push (operator-only).

## Technical details

- `env.ts` shape: `const schema = z.object({ TRIGGER_SECRET_KEY: z.string().min(1), ... });
let cached; export function getEnv() { cached ??= schema.parse(process.env); return cached; }` -
  zod's error output names missing keys (AC-5 asserts the name appears).
- Hello task: `export const hello = task({ id: "hello", run: async (p: { name: string }) => ({ greeting: \`hello \${p.name}\` }) })`.
- create-next-app may refuse a non-empty dir (git init'd): scaffold with `--skip-install` into the
  existing dir; if it balks on existing files, scaffold to a temp dir and move contents in.
- vitest: `bun add -d vitest`, script `"test": "vitest run"`, test at `src/lib/env.test.ts`.

## Testing

The epic's Tests-from-AC table, verbatim (AC-1..13). AC-5 is the one unit test (vitest); the rest
are command checks run in Validation.

## Validation

- [ ] `bun run build` clean with no `.env` (AC-1)
- [ ] `bun run lint` clean (AC-2) - [ ] `bunx tsc --noEmit` clean (AC-3)
- [ ] `bun run test` all green (AC-4, includes AC-5 test)
- [ ] LICENSE/README/.env.example/.gitignore contents per AC-6..9
- [ ] `trigger/hello.ts` + config compile; SDK `^4.5.4` in package.json (AC-10)
- [ ] Guardrail echo test exits 2 (AC-11)
- [ ] Commit output shows pre-commit gates ran (AC-12) - [ ] `0001_init.sql` per model (AC-13)

## Fix log

(rounds append here)

## Completion Report

(written when done)
