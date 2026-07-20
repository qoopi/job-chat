# Claude Design brief #2 - polish + flow refresh (2026-07-21)

Feed this to claude.ai/design (the existing "jobchat.dev" design project). This is a REFINEMENT of
the shipped design system, NOT a redesign. Keep everything in
`Job.Chat/.claude/design-spec/design_handoff_jobchat/` as the base: teal accent #0e7466, amber
secondary, light default + dark, the insight-card anatomy, the two answer modes, the LCP mechanics.
Change only what this brief names.

## Product in one line
jobchat.dev - a chat adviser on the jobs market. Ask anything, get a one-line verdict + an
interactive chart/table (never a wall of text). Guest-open; sign in to keep your history.

## The user story to design around (operator ruling 2026-07-21 - guest access KEPT)
1. New visitor opens jobchat.dev -> landing -> can chat immediately AS A GUEST (no signup wall).
2. When the guest hits the message cap, we invite them to create an account for more - a friendly
   prompt in the chat, not a hard block.
3. They click "Create account" -> auth dialog (Continue with Google OR email + password). On
   success their current guest conversation is SAVED to the new account (adoption), and the blocked
   message they were trying to send goes through.
4. A signed-in user can SIGN OUT -> returns to the landing/main screen. From there they can still
   chat as a guest, but those guest chats are NOT saved to their account unless they sign back in.
5. Sign in / Sign out must be VISIBLE and EASY TO LOCATE at all times (the current placement is too
   subtle - this is a named complaint).

## Surfaces to (re)design - and the specific defects to fix

### 1. Sign-in / Sign-out affordance (PRIORITY - "hard to locate" complaint)
- Landing: a clear "Sign in" top-right (exists) - keep prominent.
- Chat, GUEST: a visible "Sign in" affordance that does not look like a disabled "soon" chip
  (today it reads as inert). Make it an obvious button.
- Chat, SIGNED-IN: the account identity + a clearly labeled "Sign out" - today it is a small
  bottom-left item that is easy to miss. Make signing out obvious and one click.
- After Sign out: the app returns to the LANDING page (today it wrongly stays in the chat view -
  design the transition explicitly).

### 2. The cap -> register moment
- When a guest reaches the limit, design the in-chat prompt: a warm one-line "You've reached the
  guest limit - create a free account to keep going and save this conversation" with a primary
  "Create account" button that opens the auth dialog. Not a red error, not a hard wall.

### 3. Auth dialog (exists - refine)
- Continue with Google (primary) + email/password. Loading + inline-error states. On success it
  closes and the queued message sends. Keep the lazy, in-place behavior.

### 4. Insight card - CHART LEGIBILITY (PRIORITY - the worst visual defect)
The horizontal bar chart currently OVERLAPS its category labels into an unreadable smear when there
are many long, un-normalized titles (e.g. "Data Center Facilities Technician, Electrical" stacked
on the next). Design the fix:
- Cap the visible categories to a readable number (~8-10 bars); if there are more, show a "+N more"
  or a "See all" into the Left Chat Part table (the LCP already exists for big tables).
- Truncate long category labels (~26-30 chars) with an ellipsis; full label on hover/tooltip.
- Give each bar row enough vertical space that labels never collide; labels left-aligned, single
  line.
- Keep the value at the bar end (that part works).

### 5. Insight card - "Show query" legibility (PRIORITY)
The revealed SQL block currently renders some tokens (table + column identifiers) in a color that
matches the background, so they are INVISIBLE - the honesty feature is half-illegible. Design a code
block with a syntax-highlight palette that has proper contrast for EVERY token type (keywords,
identifiers, strings, functions) in BOTH light and dark themes. It must read as clean, complete SQL.

### 6. Verdict + source line honesty (design guidance, small)
The verdict says "leads with 11 of 77" where 77 is only the sum of the visible bars, while the
source line says "1,863 open postings". Design how the verdict frames a capped/top-N result so it
does not imply the visible slice is the whole market (e.g. "the top roles" framing, or show the
real total). Keep verdict-leads-with-the-number.

### 7. Sidebar / history polish
- History rows: title (may wrap) + relative date, comfortable spacing, clear active state.
- Repeated identical titles (same question asked across sessions) should still be distinguishable -
  consider a subtle timestamp/preview so three "Median salary for a Data Engineer in SF" rows are
  not indistinguishable.
- Guest: the teaser + Sign in. Signed-in: the list + New chat on top.

## Deliverables
Updated mocks (light AND dark, desktop) for: landing; chat guest state; chat signed-in state; the
auth dialog; the cap->register prompt; the insight card WITH the fixed chart-label handling and
legible Show query; the sidebar. Keep the tokens/components; extend only where a fix needs it (e.g.
a truncation rule, a code-block palette, a sign-out button).

## Out of scope
No new color system, no new typography, no new page architecture. P2 (profile/matches) is separate.
The multi-run duplicate is a known backend issue, not a design problem.
