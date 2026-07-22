# Design-sync inbox (from Claude Code)

## REQUEST 3 (2026-07-22, NEW - urgent, pre-video): two new cards + two invite variants

Context: Job.Chat adds profile-driven job matching before the demo video. The user signs in,
uploads a resume (PDF or text) + a GitHub username, we extract a structured profile, show it as a
card, and "find me a job that fits" then returns actual matching postings. We need the cards.
Use the shipped design system (design_handoff_jobchat tokens/components), BOTH themes, the same
visual language as the insight cards. Deadline pressure: today if at all possible - we will ship
a fallback in the existing insight style and reskin from your designs when they land.

### Card 1: PROFILE CARD (the centerpiece)
Shown in-chat right after profile extraction; expandable into the LCP (left panel).
Data available:
- titles[] ("Senior Backend Engineer"), seniority (junior/mid/senior/lead), yearsExp
- skills[] each tagged source: resume | github | both (github = proven by their code)
- locations[], remotePref (bool), salaryMin (optional)
- domains[] ("distributed systems", "data tooling") - inferred from GitHub problems solved
- ossHighlights[] (1-3 short lines, e.g. "Merged PRs to trigger.dev: retry backoff fix")
In-chat compact: identity line (title - years - location - remote), top ~6 skills with a subtle
source distinction (github-proven vs resume-claimed), domains as chips, one OSS highlight, an
"Open in panel" affordance. LCP expanded: everything - full skills with sources, all domains, all
OSS highlights, salary expectation, GitHub username; Edit (re-save) + Delete actions.
State variant: a "GitHub skipped" note when enrichment failed.

### Card 2: JOB-POSTINGS CARD (the payoff)
Shown in-chat when the agent returns matching postings; expands to the LCP when >8 rows.
Data per row: title, company, city or Remote, salary range (often ABSENT - design that empty
state), experience level. Internally rows are score-ordered - decide if/how rank shows (subtle
ordering only; no fake match-percentages).
In-chat: up to 8 rows + a scope line ("8 of 23 matches - from 3,488 postings"). LCP: full list.
Honesty matters: the corpus is ~93% one company - the card must not fake variety.

### Small variants (quick): two invite cards
- auth-invite: "Sign in with Google to get matched" - one-button accent card (the cap->register
  card from refresh #2 is the reference pattern).
- profile-invite: "Add your resume + GitHub and I'll find roles that fit" - one button, opens
  the left-panel profile form.

### Also (if capacity): the LCP profile FORM states
empty / saving / saved-with-summary / github-skipped / error; PDF upload control + paste
textarea + GitHub username field + a "we only read public GitHub data" notice; Save/Delete.

Deliverables: HTML mocks per card (both themes) under design-spec/ (split files as before) +
a HANDOFF.md phase note. Ping back via the project chat when ready.

---

## Request 1 (2026-07-21): design refresh #2 - polish + flow  [DELIVERED - see HANDOFF.md]
Full brief: `design-sync/refresh-brief.md`. Headlines: chart-label overlap, Show-query SQL
palette, Sign in/out prominence, cap->register moment, sidebar polish, sign-out transition.

## Request 2 (2026-07-21): landing signed-in state  [DELIVERED - shipped in 019]

## Context for your code review (still true)
Auth is Google-ONLY. Data reality: 3,488 postings, 7 companies (93% Google), near-unique titles;
design around answers that look good on THIS data: salary distributions/comparisons, experience
mix, remote/onsite split, per-city counts.
