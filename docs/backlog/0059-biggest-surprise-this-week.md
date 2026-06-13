---
id: 0059
title: Biggest surprise this week - one Tuesday-morning card surfaces the single thing the operator would have missed so the daily glance becomes a habit ritual
status: groomed
priority: P1
area: observability
created: 2026-06-13
owner: gtm-innovation
---

## User story

As a fleet operator who already opens the portal every weekday morning
(per the 0033 yesterday-glance habit) but has stopped truly READING the
home page because most days everything looks like every other day, I
want ONE compact "biggest surprise this week" card that surfaces the
single thing the fleet did this week I would NOT have predicted - a
project that quietly stopped shipping, a check name that has never
failed before suddenly going red, a spend-per-PR that doubled, a heal-
attempts streak that ended - computed deterministically from existing
telemetry with no LLM call, so that the daily glance becomes a habit
ritual ("what's this week's surprise?") rather than a status check that
becomes wallpaper.

## Why now (four lenses)

### Product Owner

Today's home-page cards (0017 inbox, 0033 yesterday glance, 0037
Friday wrap, 0038 Monday catch-up, 0040 riskiest PR, 0043 new-since-
visit, 0055 lesson-of-the-day) all answer "WHAT HAPPENED" - the
status of the recent past. None of them answer "WHAT WAS
UNEXPECTED" - the divergence between what happened and what the
operator's prior would have predicted. The operator who shipped 5
PRs/week consistently for 4 weeks then shipped 1 last week needs a
nudge that says "this week was unusually quiet" - none of the
existing cards spot that.

The smallest meaningful unit of value: ONE card per week computing
the single highest-novelty signal among 5 deterministic candidates:

1. **Project went silent**: a project that shipped >= 3 PRs/week
   for the trailing 4 weeks shipped 0 this week.
2. **First-time check failure**: a `pr.first_fail_check` value that
   appears in this week's data but NEVER in the prior 8 weeks.
3. **Spend-per-PR doubled**: this week's `cost_per_merged_pr`
   for any one project is >= 2x the trailing 8-week median for
   that project (and at least $1.00 absolute delta).
4. **Heal-streak broken**: a project that merged the last 5
   consecutive PRs with `heal_attempts = 0` had a heal-required
   merge this week.
5. **New-author PR**: a `pr.author` value that has authored >= 5
   PRs in the trailing quarter has a PR in this week's data with a
   `first_fail_check` set (the trustworthy author's first red CI
   in 90 days).

The card picks the SINGLE highest-novelty candidate (a fixed
priority order: silent-project > first-time-check > spend-doubled
> heal-streak-broken > new-author-red) and renders ONE sentence
explaining it: "courtiq quietly went silent this week - 0 PRs
merged after 4 weeks averaging 5." If NO candidate fires, the
card renders one honest sentence: "Nothing surprising this week
- the fleet did what it always does." (Per CROSS_LESSONS section
courtiq share-flow authenticity 2026-05-25 family, honest empty-
states earn trust.)

No new schema. No new ingest path. No new LLM call. Pure
composition over `pr` (state, first_fail_check, heal_attempts,
author), `run` (cost_usd, project_id), and `project` (slug)
tables that 0033 / 0035 / 0040 / 0044 / 0047 already read.

PRODUCER-VS-SPEC NOTE: per LESSONS 2026-06-05 "groomer prose can
disagree with the schema" and 2026-06-10 "PRODUCER-VS-SPEC for
column-value casing" - the `pr.state` literal is `'open'` (lower)
for open and `'MERGED'` (upper) for merged per the existing
`src/ingest/prs.ts` writer; `pr.heal_attempts` is INTEGER DEFAULT
0 (per ALTER TABLE - grep `src/db.ts` to confirm); `pr.author`
is TEXT (the GitHub login); `pr.first_fail_check` is TEXT
nullable. Grep `src/views.ts` for `costPerMergedPr` and
`spendEfficiencyRanking` for the existing cost-per-PR derivation
shape before computing #3.

### Stakeholder

Widens the moat on the SURPRISE-DETECTION axis where no other
existing surface invests. 0008 (anomaly detection) flags ONE-RUN
outliers; 0034 (self-baseline drift) flags multi-day shape
divergence; 0040 (riskiest open PR) flags ONE open PR; 0044
(spend-efficiency ranking) flags the laggard project. None of
them compute the "thing the operator would have BET against this
week and lost" question - the candidate is the most operator-
specific question fleet-control can answer because it requires
the operator's OWN trailing baseline.

Per the cross-fleet courtiq lesson "the artifact that pushes
itself into the operator's daily attention is the one that
compounds adoption" (CROSS_LESSONS section courtiq Entries
2026-05-21 family on share surfaces), the biggest-surprise card
is exactly that shape applied to the operator's OWN behaviour
model. The screenshot worth sharing: a portal home page with a
single subdued card "this week's surprise: a never-failed check
suddenly went red" - structurally impossible for any tool that
doesn't own both the trailing baseline AND the live ingest.

Pairs with 0033 (yesterday glance - the daily counterpart), 0037
(Friday wrap - the weekly summary; this card is the weekly
SURPRISE), 0055 (lesson of the day - the home-card cadence
matches).

### User (operator at 9am Tuesday morning, on a phone)

The card appears on the home page below the lesson-of-the-day
(0055) card, with `data-testid="biggest-surprise-card"`. The card
carries: a small eyebrow label "this week's surprise", one
sentence (max 140 chars) naming the candidate, an inline metric
(the prior-baseline + this-week-value pair: "avg 5 PRs/week, this
week 0"), and ONE deep-link button that navigates to the
relevant existing surface:
- candidate 1 (silent project) -> `/projects/<slug>`
- candidate 2 (first-time check fail) -> `/prs/<repo>/<n>`
- candidate 3 (spend-doubled) -> `/projects/<slug>` with cost tab
- candidate 4 (heal-streak broken) -> `/prs/<repo>/<n>`
- candidate 5 (new-author red) -> `/prs/<repo>/<n>`

The card is shown Tuesday morning (the week boundary) and
remains visible through Sunday; on Monday it's hidden (Monday is
0038's catch-up card surface; the two cards don't compete). The
card has a dismiss chevron - one tap hides it for the rest of
the week.

At 375px the card is full-width with the metric stacked beneath
the sentence; at >=600px the metric is right-aligned inline.
Quiet hours softens the eyebrow label to "this week's surprise
(quiet)" - the card stays visible because it's informational,
not promissory (per 0030 / 0048 / 0055 precedent).

When the fleet has fewer than 8 weeks of data (a freshly-
onboarded fleet), the card renders one honest sentence: "Your
fleet is still warming up - surprises will surface here as the
agents accumulate a baseline."

### Growth

The "show me" moment is the conversion from glance habit to
ritual habit. Per the cross-fleet courtiq lesson "the prospect's
churn risk is concentrated in the moment they look at the
surface and decide 'this tool only shows me wins'" (CROSS_LESSONS
section courtiq Entries 2026-05-25 family), the surprise card
preserves trust by SOMETIMES rendering a surprise that's bad
news (a project went silent, a check failed for the first time).
That honest-mirror posture is the load-bearing acquisition
signal - a prospect who sees "this week's surprise: my agent
fleet was quieter than usual" trusts the numbers more than a
prospect who sees only wins.

Pairs with 0033 (yesterday glance - the daily anchor), 0037
(Friday wrap - the weekly summary), 0050 (year-in-review - the
annual surprise reel; this is the WEEKLY version of the same
honest-summary shape).

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: per
LESSONS 2026-06-05 "groomer prose can disagree with the schema;
the schema wins" the implementing dev MUST grep `src/db.ts` for
column casing AND `src/ingest/prs.ts` for value casing BEFORE
writing the SELECT. The `pr.state` literal is `'MERGED'`
(uppercase) for merged rows (per `src/ingest/prs.ts:164` and the
existing `costPerMergedPr` / `spendEfficiencyRanking` callers);
`pr.heal_attempts` is INTEGER NOT NULL DEFAULT 0;
`pr.first_fail_check` is TEXT nullable; `pr.author` is TEXT
nullable. The week boundary is Monday 00:00 UTC to Sunday
23:59:59 UTC (matches 0054 `fleetWeeklyPulse` - grep
`src/views.ts` for the existing week-boundary helper). Per
LESSONS 2026-06-07 "the pr table has no surrogate id" - any
cache invalidation tuple uses `(MAX(pr.fetched_at),
COUNT(*) over pr in window)`.

- [ ] `src/views.ts` exports `fleetBiggestSurprise(db: DB,
      opts?: {now?: Date, hourlyRateUsd?: number, baselineWeeks?:
      number}): FleetBiggestSurprise` returning `{generated_at:
      string, week_start_iso: string, week_end_iso: string,
      kind: 'silent_project' | 'first_time_check' |
      'spend_doubled' | 'heal_streak_broken' | 'new_author_red'
      | 'none', sentence: string, metric_label: string,
      metric_baseline: string, metric_this_week: string,
      deep_link: string | null, candidate_project_slug:
      string | null}`. Default `baselineWeeks = 8`. The helper
      evaluates the five candidates in the documented priority
      order; the FIRST one to fire wins. When none fires,
      `kind: 'none'` with `sentence: "Nothing surprising this
      week - the fleet did what it always does."`. Per LESSONS
      section "node:sqlite's .all() needs `as unknown as T[]`"
      every row narrowing uses the double cast. Per LESSONS
      section "anomaly tests need sigma > 0 in the fixture" -
      the spend-doubled test fixture has prior-week spend with
      enough spread that 2x is geometrically meaningful (NOT a
      flat baseline where any deviation looks 1000x). Per
      LESSONS section "time-pinned tests must NOT derive seed
      timestamps from `new Date()`" every seed anchors to the
      pinned `now`. Test: seed 5 candidate-specific fixtures
      and assert each fires in isolation; seed a fixture that
      satisfies BOTH candidate 1 AND candidate 3, assert
      candidate 1 wins (priority order); seed a fixture with
      no signal, assert `kind: 'none'`.

- [ ] Silent-project candidate (candidate 1) detection: for
      each project, compute `prs_per_week` over the trailing
      4 weeks (Mon-Sun windows ending at `now - 1 week`). If
      ANY project has trailing avg >= 3 AND this week's count
      == 0, that project is a silent-project candidate. The
      `sentence` is "<slug> went quiet this week - 0 PRs
      merged after 4 weeks averaging N." The deep_link is
      `/projects/<slug>`. PRODUCER-VS-SPEC NOTE: count merged
      PRs only (`pr.state = 'MERGED'` uppercase per
      `src/ingest/prs.ts`). Test: seed a project with 5/5/5/5
      merged PRs across the trailing 4 weeks and 0 this week;
      assert kind == 'silent_project'; assert
      candidate_project_slug == the seeded slug.

- [ ] First-time-check candidate (candidate 2) detection: any
      `pr.first_fail_check` value present in this week's
      `pr.fetched_at` data and ABSENT from the trailing 8
      weeks of `pr.first_fail_check` values. The `sentence`
      is "'<check_name>' failed for the first time this week
      (last 8 weeks: never)." The deep_link is the PR's URL
      `/prs/<repo>/<number>`. Test: seed 8 weeks of trailing
      data with `typecheck` / `validate` as failed checks
      only, then a this-week PR with `first_fail_check =
      'e2e'`; assert kind == 'first_time_check'.

- [ ] Spend-doubled candidate (candidate 3) detection: for
      each project this week, `cost_per_merged_pr` >= 2x the
      trailing 8-week MEDIAN cost_per_merged_pr for the same
      project AND absolute delta >= $1.00 (so a $0.10 -> $0.30
      cost-per-PR doesn't spam the card). PRODUCER-VS-SPEC
      NOTE: cost_per_merged_pr derivation must mirror
      `costPerMergedPr` per `src/views.ts` - grep for the
      existing helper's SUM/COUNT shape. The `sentence` is
      "<slug>'s cost-per-PR jumped from $X.XX to $Y.YY this
      week." Test: seed prior 8 weeks of $1.00/PR for a
      project, then a $3.00/PR this-week row; assert kind ==
      'spend_doubled'.

- [ ] Heal-streak-broken candidate (candidate 4) detection:
      for each project, find the most-recent 5 consecutive
      merged PRs ordered by `fetched_at` (or by close date if
      `closed_at` populated). If all 5 had `heal_attempts =
      0` AND a this-week merge has `heal_attempts >= 1`, the
      streak is broken. The `sentence` is "<slug>'s 5-PR
      clean-merge streak ended this week (PR #N took N heals)."
      The deep_link is the PR's URL. Test: seed 5 prior-week
      merged PRs with heal_attempts=0, this week one with
      heal_attempts=2; assert kind == 'heal_streak_broken'.

- [ ] New-author-red candidate (candidate 5) detection: for
      each `pr.author` with >= 5 merged PRs in the trailing
      90 days AND zero `first_fail_check` set in any of those
      90-day rows, if a this-week row from the same author
      has `first_fail_check` set, fire. The `sentence` is
      "<author>'s first red CI in 90 days landed this week."
      The deep_link is the PR's URL. Test: seed 5 prior 90-
      day merged PRs by author "alice" with
      first_fail_check NULL, then a this-week row with
      first_fail_check='typecheck'; assert kind ==
      'new_author_red'.

- [ ] `GET /api/fleet/biggest-surprise` (auth required, same
      posture as `/api/fleet/inbox`, `/api/fleet/glance`)
      returns the AC1 shape as JSON. Per LESSONS 2026-06-10
      "redactSecrets on a JSON body shreds your KEYS" - scrub
      `sentence` and `metric_*` VALUES BEFORE
      `JSON.stringify`, NEVER the body string. Test: hit
      with valid token -> 200; hit without -> 401.

- [ ] Home-page card render: the SPA home page renders the
      card below the lesson-of-the-day card with
      `data-testid="biggest-surprise-card"`. The dismiss
      chevron writes to `inbox_dismissal` with `kind =
      'biggest_surprise'` and `payload_id =
      week_start_iso` (matches the 0017 inbox-dismissal
      shape). The card stays dismissed for the rest of the
      week; a fresh week un-hides it. Per LESSONS section
      "in-process dedup sets need an explicit reset hook
      for tests", expose
      `_resetBiggestSurpriseCacheForTests()` AND
      `_getBiggestSurpriseCacheBuildsForTests()`. Test:
      hit the home page, assert the card testid is present;
      POST a dismissal, hit again, assert the card is
      hidden; advance time one week, hit again, assert a
      fresh card appears.

- [ ] Monday hide: when `now` falls on a Monday (in the
      configured tz), the card is hidden (0038 Monday catch-
      up owns Monday). Per LESSONS 2026-06-11 "startServer()
      tests that mutate `fleet-control.config.json` race
      against parallel test files; expose a renderer-direct
      seam for branch tests" - the Monday-hide branch is
      driven via a renderer-direct
      `_renderBiggestSurpriseForTests(payload, {today:
      'monday'})` seam, NOT a cwd config mutation.

- [ ] Empty-fleet honest empty state: when the fleet has <8
      weeks of `pr` data, the helper returns `kind: 'none'`
      with `sentence: "Your fleet is still warming up -
      surprises will surface here as the agents accumulate
      a baseline."`. Per CROSS_LESSONS section courtiq
      share-flow authenticity 2026-05-25 family, the empty
      state is honest and explicit. Test: seed a fixture
      with 4 weeks of data, assert the warming-up sentence.

- [ ] Mobile (per 0011): at 375px the card is full-width
      with the metric stacked beneath the sentence; at
      >=600px the metric is right-aligned inline. Per
      LESSONS 2026-06-11 "startServer() tests that mutate
      `fleet-control.config.json` race against parallel
      test files; expose a renderer-direct seam" - viewport
      branches are driven via the renderer-direct seam.

- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-
      string composition. The new `/api/fleet/biggest-
      surprise` route is NET-NEW (no JSON-shape break to
      any existing `/api/...` route). Home-page card is
      additive HTML on the existing home SPA. No schema
      migration - composes existing `pr`, `run`, `project`,
      `inbox_dismissal` tables. Per LESSONS section "no
      backticks inside template-literal SQL strings",
      identifiers stay plain words. Per LESSONS 2026-06-11
      "character-window source greps leak into sibling
      helpers" - the new helper's comment block uses PLAIN
      PROSE (no backticks) for any identifier that a 0052-
      family slice-and-grep test might capture.

## Out of scope

- An LLM-generated explanation of WHY the surprise occurred.
  The deep_link to the PR is the why-investigation surface;
  LLM summarisation invites cost, hallucination, and
  phone-home posture.
- An ntfy push when the candidate fires. Pushes belong to
  0009 (high-severity events); the biggest-surprise is a
  passive glance card by design.
- A "share this surprise" public-link surface. The card
  carries an operator-specific signal and would leak
  project-level data; the public weekly pulse (0054) is the
  share surface.
- A "weekly surprise history" page archiving prior weeks'
  surprises. v1 surfaces the CURRENT week only; a history
  page is a follow-up.
- Widening the candidate set beyond the 5 documented
  candidates. The priority order is fixed for v1; adding a
  6th candidate is a follow-up ticket.
- Tuning the candidate thresholds at runtime via config.
  v1 hardcodes the thresholds (`>= 3 PRs/week`, `>= 2x`,
  `>= $1.00 delta`, `>= 5 consecutive`) - per the cross-
  fleet courtiq lesson on schema-vs-prose, a config knob
  invites drift; a follow-up can introduce one if
  operator feedback demands it.
- Cross-project surprise correlation (e.g. "ALL projects
  went quiet this week"). 0027 already handles cross-
  project correlation for failure modes; this card is
  per-project-or-fleet, not cross-project. A follow-up
  can synthesise a fleet-level rollup.

## Engineering notes

- `src/views.ts` - new `fleetBiggestSurprise(db, opts)`
  helper next to the existing `yesterdayGlance` /
  `fridayWrap` / `mondayCatchUp` family. PRODUCER-VS-SPEC
  NOTE: grep `src/views.ts` for the existing week-boundary
  helper (`fleetWeeklyPulse` from 0054 uses ISO Mon 00:00
  UTC to Sun 23:59:59 UTC) and mirror the boundary
  exactly. The helper composes existing query shapes from
  `costPerMergedPr`, `spendEfficiencyRanking`, and
  `riskiestOpenPr` - reuse rather than reimplement. Per
  LESSONS 2026-06-11 "character-window source greps leak
  into sibling helpers" - the new helper sits next to
  several existing helpers; its comment block uses PLAIN
  PROSE (no backticks around `fleetWeeklyPulse`,
  `costPerMergedPr`, etc.).
- `src/server.ts` - one new handler near the existing
  `/api/fleet/glance` / `/api/fleet/friday-wrap` /
  `/api/fleet/monday-catchup`: `GET /api/fleet/biggest-
  surprise` (JSON, auth required). PRODUCER-VS-SPEC NOTE:
  grep `src/server.ts` for the existing `/api/fleet/inbox/
  dismiss` POST handler - the new card reuses the same
  dismissal shape, but with a new `kind = 'biggest_
  surprise'`; no schema change needed (the
  `inbox_dismissal` table's `kind` column is TEXT NOT
  NULL with no CHECK constraint).
- `web/app.js` - one new home-page card section below
  the lesson-of-the-day card. PRODUCER-VS-SPEC NOTE:
  grep `web/app.js` for the existing lesson-of-the-day
  card render path and place the new card immediately
  after. The card's dismiss button POSTs to the existing
  `/api/fleet/inbox/dismiss` route with `kind =
  'biggest_surprise'`.
- `web/style.css` - one selector group for the card,
  reusing existing CSS variables for color and font; do
  NOT add new ones.
- `tests/biggest-surprise.test.ts` (new) - one
  `test(...)` per AC checkbox. Per LESSONS section
  "time-pinned tests must NOT derive seed timestamps
  from `new Date()`", every seed anchors to the pinned
  `now`. Per LESSONS section "anomaly tests need sigma
  > 0 in the fixture" - the spend-doubled fixture has
  realistic spread. Per LESSONS section "in-process
  startServer() tests need an empty-roots config + run-
  row seeds", server-boot tests plant a tmp `fleet-
  control.config.json` in cwd. Per LESSONS 2026-06-11
  "startServer() tests that mutate `fleet-control.
  config.json` race against parallel test files" -
  Monday-hide / empty-fleet / mobile-breakpoint branches
  are driven via the renderer-direct
  `_renderBiggestSurpriseForTests` seam.
- Schema migration: NO new tables. Composes existing
  `pr`, `run`, `project`, `inbox_dismissal` tables.
- No new runtime deps. Pairs with 0033 (yesterday
  glance), 0037 (Friday wrap), 0038 (Monday catch-up),
  0055 (lesson of the day - same daily-card cadence),
  0017 (inbox dismissal shape).

## Implementation log

(Appended by the implementation-dev agent during execution.)
