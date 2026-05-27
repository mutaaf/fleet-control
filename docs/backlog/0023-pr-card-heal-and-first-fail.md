---
id: 0023
title: PR card shows heal-attempts and first-fail reason inline
status: groomed
priority: P2
area: portal
created: 2026-05-27
owner: gtm-innovation
---

## User story

As a fleet operator triaging open agent PRs on the portal, I want each
PR card to show "heal #2 of 2" and "first failed: typecheck — TS2304"
inline, so that the question "is this PR worth a human nudge or should
I let the agent self-heal?" is answered without clicking into GitHub
checks.

## Why now (four lenses)

### Product Owner
AGENTS.md caps heal attempts at 2. The operator's only signal today
that a PR is on its last life is to remember to count `heal:` commits
on the PR — easy to miss, especially on the phone. Surfacing the count
where the PR already lives turns an undocumented gotcha into a clear
state. Same for first-fail: every red PR's *first* failure is what
matters; the cascade after is noise.

### Stakeholder
Widens the moat on `portal`. The PR card becomes a self-contained
status for the autonomous loop's most common failure mode (CI red,
heal in flight, did it work yet?). A SaaS dashboard would need to
re-implement check-run parsing per provider; we already ingest it
because `gh pr list --json statusCheckRollup` is one field away.

### User (operator at 9am)
On every agent PR row in the project page: a small `heal 1/2` chip
(amber if =max, green-grey if < max) next to the existing CI badge.
On the first red check, a one-line "first failed: typecheck" link
that opens the run log. If neither applies (PR has no heals, CI
green), neither chip renders — no noise on healthy PRs.

### Growth
The chip is small but it's the most "this product knows what's going
on" detail you can put on the screen. Pairs with the inbox (0017) and
the health dot (0022) to make the portal feel *alive* rather than
static.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] Schema migration: extend the `pr` table with two new columns:
      `heal_attempts INTEGER DEFAULT 0`, `first_fail_check TEXT`.
      Idempotent ALTERs in `src/db.ts` per the existing pattern. Test:
      open a DB without the columns, assert the migration adds them
      and a select round-trips both values.
- [ ] `src/ingest/prs.ts` updated: include `commits` in the `gh pr
      list --json` field list. Count commits whose `messageHeadline`
      starts with `heal:` (case-insensitive; the agents'
      AGENTS.md-mandated heal commit convention). Persist the count
      in `heal_attempts`. Test: stub the runner per
      `docs/LESSONS.md` § shell-out modules need an injectable runner,
      feed a payload with 3 `heal:`-prefixed commit headlines, assert
      `heal_attempts=3`.
- [ ] Same ingest pass: from `statusCheckRollup`, find the first
      check (by `startedAt` ascending) whose `conclusion` matches
      `FAILURE|ERROR|CANCELLED`. Persist its `name` in
      `first_fail_check` (NULL if no failing check). Test: feed a
      payload with three checks where the second failed, assert the
      column holds the second's `name`.
- [ ] Re-ingest is idempotent: running the ingest twice in a row on
      the same `gh` payload MUST yield the same `heal_attempts` and
      `first_fail_check`. (Per `docs/LESSONS.md` patterns around
      replace-vs-merge — the existing `DELETE FROM pr WHERE
      project_id=?` then INSERT pattern is fine; just verify both
      columns survive the round trip.) Test: ingest twice, assert
      stable rows.
- [ ] `projectPRs(db, projectId)` (in `src/ingest/prs.ts`) adds
      `heal_attempts` and `first_fail_check` to the returned shape.
      Existing fields unchanged in name and type. Test: snapshot the
      shape against a pre-ticket fixture; assert only additive
      changes.
- [ ] `web/app.js` renders the `heal X/2` chip when `heal_attempts >
      0` (chip is amber when `heal_attempts >= 2`, neutral
      otherwise). Renders a "first failed: <name>" link when
      `first_fail_check` is non-null. The link target is the
      project's GitHub Actions tab for the PR (constructible from
      `pr.url`); no separate API call needed. Test: stub each combo,
      assert the DOM shape and chip colour class.
- [ ] When `heal_attempts === 0` and `first_fail_check === null`,
      neither chip renders. Test: stub the empty case, assert no new
      DOM appears beyond what the existing PR card has.
- [ ] Mobile: chips wrap below the title on screens < 600px per 0011
      conventions; no horizontal scroll at 375px. Test: assert the
      viewport contract.
- [ ] Privacy: the `first_fail_check` value MUST go through the
      existing `redactSecrets` boundary if any (or a similar plain
      string check) before render — check names shouldn't carry
      tokens, but the defence-in-depth pattern from `docs/LESSONS.md`
      § secret redaction at the renderer boundary applies anyway.
      Test: stub a check name containing a token-shaped substring,
      assert the rendered DOM does not include the literal.
- [ ] No new runtime deps. `tsc --noEmit` clean. No JSON-shape break
      to any existing `/api/...` route — the `heal_attempts` and
      `first_fail_check` fields are net-new on the PR row.

## Out of scope

- Streaming heal-progress (the daemon doesn't yet track in-flight
  heal events; the existing 60s `gh` ingest cadence is the floor).
- A heal-attempts trend chart per project. Useful, but a separate
  ticket; v1 surfaces the current count, not the history.
- Auto-escalating a PR that has used both heal attempts to the inbox
  (0017). Clean follow-up, out of scope here.
- Cross-PR check failure clustering ("typecheck failed on 3 PRs this
  week"). Useful for the leaderboard (0014) follow-up, not here.
- A custom heal-prefix configuration. AGENTS.md mandates the `heal:`
  convention; ticket honours that one shape.

## Engineering notes

- `src/db.ts` — two new idempotent ALTERs in the `for (const ddl of
  [...])` block. Per `docs/LESSONS.md` § no backticks inside
  template-literal SQL strings, keep identifiers plain.
- `src/ingest/prs.ts` — extend the `gh pr list --json` field list to
  include `commits` and the existing `statusCheckRollup`. Add two
  small parsing helpers; both should be exported for direct test
  coverage. The existing module already shells via `execFileSync`
  with an argv array — keep it that way (AGENTS.md § no shell-string
  composition).
- `web/app.js` — small additions to the PR card renderer; one new
  helper `renderHealChip(n, max)`. Reuse existing chip styling from
  the telemetry strip if available.
- `web/style.css` — one new selector group for the heal chip and the
  "first failed" link.
- `tests/prs-ingest.test.ts` (extend or new) — runner-seam test per
  the 0010 / 0016 pattern. Canned `gh pr list --json` payload with
  edge cases: zero heals, one heal, two heals, mixed-case `Heal:`
  prefix, multi-line commit message where only the first line is the
  heal marker, statusCheckRollup with no failures, statusCheckRollup
  with all failures (still want the first).
- No new runtime deps. Pairs with 0017 (a future inbox kind
  `pr_heal_exhausted` could ride on `heal_attempts === 2`), 0022
  (the health dot's `pr_age` sub-score can read the same row), and
  0014 (the leaderboard can grow a "most-healed PRs" column).

## Implementation log

(Appended by the implementation-dev agent during execution.)
