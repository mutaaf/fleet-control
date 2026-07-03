---
id: 0078
title: On-this-day nostalgia card rotates a daily fleet memory so the operator has a reason to open the portal every morning
status: groomed
priority: P1
area: portal
created: 2026-07-03
owner: gtm-innovation
---

## User story

As a fleet operator who already glances at the portal every morning, I want
one home-page card that surfaces a single "on this day" memory drawn from my
actual fleet history — "1 year ago today you shipped your first PR on
`<project>`" or "180 days ago you learned `<lesson-slug>`" or "6 months ago
you crossed 10 merged PRs" — so that the daily open has a small
intellectually-warm reward that makes the habit stick.

## Why now (four lenses)

### Product Owner
0072 shipped an anniversary milestone card that fires only on the exact
year-boundary of a specific event. That leaves 364 days a year where the
same accumulated history contributes nothing to the daily glance. The
smallest unit of value is one rotating memory per day, drawn from
`run`, `pr`, and `lesson` — a card that is always present, never repeats
the same memory twice in 30 days, and does not require a milestone.

### Stakeholder
Retention is the weakest link in the moat. Every retention-shipping ticket
so far (0026 streak, 0033 yesterday, 0037 Friday, 0038 Monday, 0043
new-since, 0055 lesson-of-the-day, 0059 biggest-surprise, 0062 monthly
retro, 0074 first-week coach) answers "what happened recently." None
answer "what did I do that I have forgotten." The accumulated history is
the moat only fleet-control can render — this ticket makes it a daily
surface.

### Operator (9am phone glance)
One card. One sentence. Optional link to the underlying artifact (the PR,
the lesson page, the receipts month). Loads with the rest of the home
page; never blocks. Feels like a small, warm surprise, not a data
dashboard.

### Capability — for the operator, NOT an audience
Pure operator retention surface. The card is rendered on the loopback
home page only; it is NEVER minted as a signed share URL and never
included in any public artifact. The "show me" moment is the operator
opening the portal Tuesday and reading "1 year ago today your fleet
shipped its first cross-project lesson — you have compounded 47 more
since."

## Acceptance criteria

- [ ] A new selector `pickOnThisDayMemory(today: Date, seenTokens:
      Set<string>): Memory | null` returns one of:
      `{ kind: 'first-pr', project, at }`,
      `{ kind: 'lesson-learned', slug, at }`,
      `{ kind: 'pr-milestone', threshold: 10|100|500|1000, at }`,
      `{ kind: 'first-run', project, at }`,
      `{ kind: 'first-heal', project, at }`.
- [ ] The selector reads from `run`, `pr`, `lesson` only; no LLM call.
- [ ] The selector prefers memories that land exactly on
      `today - Nyears` for the largest N possible; falls back to
      `today - N*30days` then `today - N*7days` when no year boundary
      matches; returns `null` on a truly cold fleet (no rows).
- [ ] A memory is skipped if its `token` (stable string like
      `first-pr:<project>` or `pr-milestone:100`) appears in the
      per-operator `home_memory_seen` table with `seen_at >= today - 30d`.
- [ ] The home page renders the card between the Yesterday card (0033)
      and the Lesson-of-the-day card (0055) with copy shaped as
      "N years ago today ..." / "N months ago ..." / "N days ago ...",
      plus an optional link to the underlying artifact.
- [ ] `home_memory_seen` (columns: `token TEXT PRIMARY KEY`,
      `seen_at INTEGER NOT NULL`) records every rendered token so the
      30-day no-repeat window works.
- [ ] The card degrades to hidden (not "empty state" — literally absent
      from the DOM) when the selector returns `null`.
- [ ] `GET /api/home/on-this-day` returns
      `{ memory: Memory | null, rendered_at }` as an additive JSON route.
- [ ] Regression: existing home-page card order is preserved (Yesterday
      still first, Lesson-of-the-day still where it was); no existing
      `/api/...` JSON shape changes.
- [ ] Regression: `npx tsc --noEmit` clean; `node
      scripts/check-backlog.mjs` clean.
- [ ] Safety: no shell-string composition; no new runtime deps.

## Out of scope

- Signed / public share URL for the memory. This is loopback-only.
- Editable memories or user-authored notes on a memory.
- Per-project variants of the card. One fleet-level card only.
- Multiple memories in one day. One card, one memory.
- Push notifications on memory (ntfy already covers 0071 reactivation).

## Engineering notes

- `src/db.ts` — add `CREATE TABLE home_memory_seen (...)` under the
  existing schema block, bump `SCHEMA_VERSION`.
- `src/on-this-day.ts` — new module for the `pickOnThisDayMemory`
  selector; pure function, no HTTP, no globals; tested standalone.
- `src/server.ts` — new `/api/home/on-this-day` route; memoise per boot,
  invalidate on `pr` / `run` / `lesson` mutation via
  `globalThis.__fleet_on_this_day_invalidate__`
  (LESSONS 2026-06-05); `_resetOnThisDayForTests()`
  (LESSONS 2026-06-23).
- `src/views.ts` — new `renderOnThisDayCardForTests(memory, opts)` seam
  so per-boot memoisation + quiet-hours branch tests do not race the
  shared cwd config (LESSONS 2026-06-11). Keep the leading comment block
  free of backticked identifiers that overlap the 0052 / 0056 slice-grep
  windows (LESSONS 2026-06-11 sibling).
- Freshness detection on `pr` uses `(MAX(fetched_at), COUNT(*))`, not
  `MAX(id)` — the `pr` table has no surrogate id (LESSONS 2026-06-07).
  Same trap check on `home_memory_seen` (`(MAX(seen_at), COUNT(*))`).
- `pr.state` filters use lowercase `'merged'`; `run.outcome` uses the
  producer-side literal case (LESSONS 2026-06-05).
- `web/home.html` — one additive DOM slot for the card between Yesterday
  and Lesson-of-the-day. Vanilla JS fetch of `/api/home/on-this-day`.
- New deps: none (`node:` builtins only). JSON additive only.

## Implementation log

(Appended by the implementation-dev agent during execution.)
