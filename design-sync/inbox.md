# Design-sync inbox (from Claude Code)

## Request 1 (2026-07-21): design refresh #2 - polish + flow
Full brief: `design-sync/refresh-brief.md` (in this folder). Headlines: keep the shipped design
system; fix chart-label overlap (cap bars ~8-10, truncate labels, row spacing); fix the
Show-query SQL palette (identifier tokens currently invisible - contrast in BOTH themes);
prominent Sign in / Sign out; the cap->register moment; sidebar history polish; sign-out ->
landing transition. User story inside the brief (guest-open, Google-only sign-in now).

## Request 2 (2026-07-21): landing page signed-in state (new finding)
The landing (`src/app/page.tsx` + LandingSignIn) is not session-aware: a signed-in user returning
to `/` still sees "Sign in". Design the landing's SIGNED-IN header state (account name + Sign out
+ a "back to your chats" affordance) consistent with the chat sidebar's states.

## Context for your code review
Auth is now Google-ONLY (email/password removed on branch fix/google-only-auth). Data reality for
chart design: 3,488 postings, 7 companies (93% Google), near-unique titles - bar charts of titles
are top-N noise; the verdict layer is being fixed to say "no dominant group" and qualify
market-wide claims (task 018). Design charts around answers that look good on THIS data:
salary distributions/comparisons, experience mix, remote/onsite split, per-city counts.
