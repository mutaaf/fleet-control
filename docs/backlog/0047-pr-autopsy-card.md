---
id: 0047
title: PR autopsy card - surface why each non-merged PR died and which signal would have predicted it
status: groomed
priority: P2
area: observability
created: 2026-06-09
owner: gtm-innovation
---

## User story

As a fleet operator at 10am on a Tuesday, having watched two
PRs close yesterday without merging - one I rejected manually,
one the agent gave up on after the 2-heal cap - I want one
inline card on the home page that, for each non-merged close in
the last 7 days, lists the PR slug + number, the structural
cause of death (`cap_reached` | `human_rejected` |
`force_closed_stale` | `infra_blocked_giveup` |
`unknown`), which SIGNAL would have predicted it (the 0040
riskiness score at close time, the 0023 heal count, the count
of `infra_flake` rows in `control_audit`), and which cross-fleet
LESSON got credit for it (per 0042's ledger) - so that closing
the learning loop is automatic: the autopsy either confirms a
lesson worked OR flags this death as a candidate for a fresh
LESSONS entry.

## Why now (four lenses)

### Product Owner
0017 (inbox), 0023 (heal-attempts), 0040 (riskiest PR), 0042
(lesson credit ledger), and 0044 (spend efficiency) all surface
LIVE and FUTURE risk. None of them surface what happened when
risk became reality - the PR that closed without merging. Today
the operator notices a closed PR in passing (in the changelog
0039, in their email inbox, in `gh pr list --state closed`)
but never sees a structured "here's what killed it AND here's
the signal we already had that predicted it." The 0042 lesson
credit ledger is the natural companion: every autopsy either
attributes the death to a lesson that should have caught it
(closing the loop) OR flags that NO lesson covers this failure
mode (opening a new entry). Pure composition - the `pr` table
already records `state = 'CLOSED'` + `closed_at`; the heal
count is in `pr.heal_attempts`; the riskiness score at close
time is reconstructible via `riskiestOpenPr`'s formula against
the PR's last-known state; the lesson credit join is exactly
the 0042 `lesson_credit` table. No new schema. The smallest
meaningful unit of value: ONE card listing 7 days of non-merge
closes with a structural cause and a lesson-attribution per
row.

### Stakeholder
Widens the moat on the LEARNING-LOOP axis. The cross-fleet
lessons file is the moat (per 0042's stakeholder lens), and
the lesson credit ledger turns it into a live ROI signal -
but only for heals that the loop ALREADY recovered from. The
PRs that DIED are the data the lessons file most needs: each
death is either a confirmation ("we knew this failure mode,
the lesson named it, but we couldn't recover") or a gap
("this failure mode is novel - add a LESSONS entry"). Per the
cross-fleet courtiq lesson "lessons that re-fire weekly are
the moat; lessons that never re-fire are debt; failure modes
that have no lesson at all are the next moat brick to add,"
the autopsy card is the SURFACE that names the third
category. The structural impossibility for other tools is
the same as 0042's: GitHub-native sees one closed PR with no
heal context; Anthropic sees tokens with no PR linkage. Only
fleet-control fuses (a) `pr.state = 'CLOSED'` + `closed_at`,
(b) `pr.heal_attempts`, (c) the historical
`control_audit` heal-rows for that PR, (d) the 0042
`lesson_credit` ledger, and (e) the cross-fleet LESSONS
symptom dictionary into one verdict per death. The
screenshot worth sharing: a card listing the week's PR
deaths with a cause, a predictor, and a lesson attribution
(or a "NO LESSON COVERS THIS" flag) - the kind of
opinionated post-mortem surface only a tool with all five
signals can build.

### User (operator at 10am Tuesday, two closes yesterday)
On the home page, BELOW the action-urgent surfaces (0040
riskiest, 0045 stuck-PR taxonomy) and BELOW the 0033/0037/
0038 morning cards, ABOVE the 0044 spend-efficiency card, an
inline card visible ONLY when at least one non-merged close
happened in the last 7 days:

<!--
PR autopsies (last 7 days, 2 closes)

  cap_reached         courtiq #311        closed 18h ago
    Riskiness at close: 17 (red_test x 2 heals, 23h old)
    Heals: 2 (both red_test, latest: vitest TS2554)
    Lesson credited: "call no-arg handlers with no args"
                                            (1 prior save)
    -> The lesson named the symptom. Heal cap is the issue.

  human_rejected      almanac #88         closed yesterday
    Riskiness at close: 4 (green, 6h old)
    Heals: 0
    Lesson credited: NONE - failure mode is novel
    -> Add a LESSONS entry naming the rejection reason.
                                          [draft entry ->]
-->

The card lists each non-merged close in the last 7 days, one
per row, ordered by closed_at descending. Each row carries:
cause-of-death label, slug + PR number + age-since-close,
the riskiness score the 0040 helper would have computed at
close time (so the operator sees whether the live surface
was already screaming), the heal count + latest heal's
fail-kind, the credited lesson (via the 0042 ledger - if
any heal-row for this PR has a row in `lesson_credit`,
report it; otherwise `NONE`), and a deterministic verdict
line. When the lesson is `NONE` the row carries a "[draft
entry ->]" tap-target that pre-fills a LESSONS entry
skeleton (NOT auto-publishing - the operator reviews
before saving; see Out of scope for the bounds).

### Growth
The screenshot worth sharing: the autopsy card listing two
deaths with the structural cause and the credited lesson per
row. That artifact answers the prospective-operator question
"what happens when an agent CAN'T fix it" with structure
instead of silence. The "show me" pitch: "fleet-control
doesn't pretend agents never fail - it tells you exactly why
the failures happened and whether your lessons file already
covered them." More compelling than 0042's credit ledger
alone because it shows the COMPLEMENT - the cases where the
lesson book didn't save the PR - and turns each one into a
next-action prompt. Per the cross-fleet courtiq lesson "the
share-worthy moment is the loop closing visibly," each
autopsy row IS the visible close of the loop.

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE:
when this spec names a column value literally (`pr.state =
'CLOSED'`, `pr.closed_at`, `control_audit.action = 'heal'`,
`lesson_credit.lesson_slug`), the implementing dev MUST grep
`src/ingest/prs.ts` and `src/control.ts` and (for the
ledger) the 0042 helper `src/views.ts` for the producer's
actual casing before writing the SELECT. Per LESSONS 2026-
06-05 "groomer prose can disagree with the schema; the
schema wins": the producer is the contract. In particular:
the closed-but-not-merged distinction is per the producer's
state values (typically `'closed'` lowercase, with a
SEPARATE `'merged'` value - the 0040 LESSON established the
lowercase pattern); the autopsy reads `state = <closed-
casing> AND <merged-flag-is-false>` rather than guessing.

- [ ] `src/views.ts` exports `prAutopsies(db, now: Date,
      opts?: {windowDays?: number}): {window_days: number,
      total_closes: number, rows: Array<{project_slug:
      string, project_name: string, pr_number: number,
      pr_title: string, pr_url: string, closed_at: string,
      closed_age_hours: number, cause: "cap_reached" |
      "human_rejected" | "force_closed_stale" |
      "infra_blocked_giveup" | "unknown", riskiness_at_
      close: number, riskiness_breakdown: string,
      heal_attempts: number, latest_fail_kind: string,
      latest_fail_detail: string | null, lesson_credit:
      {slug: string, headline: string, prior_saves:
      number} | null, verdict: string, draft_lesson:
      string | null}>, generated_at: string}`. Selects
      all `pr WHERE <closed-casing> AND <not-merged> AND
      closed_at >= now - <opts.windowDays || 7> days`.
      For each, computes the cause via AC2, the
      riskiness via AC3, the lesson credit via AC4, and
      the verdict via AC5. Rows sorted by `closed_at`
      descending. When `total_closes === 0`, returns
      `{window_days: <N>, total_closes: 0, rows: []}`.
      Per LESSONS § "node:sqlite's .all() needs `as
      unknown as T[]`", every row narrowing uses the
      double-cast. Per LESSONS § "time-pinned tests must
      NOT derive seed timestamps from `new Date()`",
      every seed anchors to the pinned `now`. Test:
      seed 4 closed PRs (one per cause), assert each
      row's cause; seed only merged PRs in the window,
      assert empty.
- [ ] Cause cascade (deterministic, top-down):
      1. **cap_reached**: `pr.heal_attempts >= 2` AND
         the latest `control_audit` heal row's
         `stdout_tail` does NOT match the infra-flake
         patterns from 0040's `classifyPrFailure`.
         (The cap was reached on REAL test failures,
         not flakes.)
      2. **infra_blocked_giveup**: `pr.heal_attempts
         >= 1` AND the latest `control_audit` heal
         row's `stdout_tail` MATCHES `classifyPrFailure
         === 'infra_flake'` OR `account_suspended` per
         the same patterns. (The PR died waiting on
         infra to recover.)
      3. **human_rejected**: `pr.heal_attempts < 2`
         AND `pr.merged === false` AND a SIGNAL exists
         that a human acted - the cheapest such signal
         the schema carries (PRODUCER-VS-SPEC NOTE:
         grep `src/ingest/prs.ts` for a `closed_by` or
         `actor_login` field; if neither exists, the
         signal is "closed within 2h of last review
         activity from a non-agent user" via the
         existing review/comment ingest - the
         implementing dev MUST audit the schema and
         document which signal is used). The autopsy
         is permissive here: if no human-action signal
         is recoverable, this rule does NOT fire.
      4. **force_closed_stale**: `pr.heal_attempts ===
         0` AND `pr.closed_at - pr.created_at > 7 *
         24 * 3600 * 1000` (the PR sat over a week
         with no heal attempts before being closed).
      5. **unknown** (default): none of the above
         match. The row still renders; the verdict
         in AC5 explicitly flags "unknown - consider
         adding a LESSONS entry."
      Per LESSONS § "anomaly tests need sigma > 0 in
      the fixture" - seed each cause with realistic
      surrounding signal so a wrongly-ordered cascade
      fails noisily. Test: for each cause, seed
      exactly the matching condition, assert the
      cause is set.
- [ ] Riskiness reconstruction: `riskiness_at_close`
      is computed using the SAME formula as 0040's
      `riskiestOpenPr` - `heal_attempts * 4 +
      fail_kind_weight + Math.floor(age_hours_at_
      close / 6)` - against the PR's state AT CLOSE
      TIME. The `fail_kind` is computed via the same
      `classifyPrFailure(db, projectId, prNumber)`
      helper (which reads the latest heal row's
      `stdout_tail` - that row still exists post-
      close). The `age_hours_at_close` is `(closed_
      at - created_at) / 3600000`. The
      `riskiness_breakdown` is a one-line human
      summary: `"<fail_kind> x <heals> heals,
      <age>h old"`. NO new helper - REUSE 0040's
      `classifyPrFailure` AS-IS, and inline the
      score arithmetic. Per LESSONS § "julianday()
      drifts ~10us per timestamp", any SQL-side age
      math uses strftime decomposition; JS-side
      uses integer ms. Test: seed a PR with 2
      heals + red_test classification + 23h
      created-to-closed span, assert
      `riskiness_at_close === 17` (8 + 3 + 3).
- [ ] Lesson credit attribution: for each autopsy
      row, query the 0042 `lesson_credit` table for
      ANY row whose `heal_audit_id` points at a
      heal-row for this PR. If one or more matches
      exist, pick the most-recently credited one
      and populate `lesson_credit = {slug,
      headline, prior_saves}` where `prior_saves`
      is `COUNT(*) FROM lesson_credit WHERE
      lesson_slug = ? AND created_at >= now - 30
      days`. If zero matches exist, `lesson_credit
      = null`. PRODUCER-VS-SPEC NOTE: grep `src/
      views.ts` for the 0042 helper's exact table
      and column names before writing the JOIN -
      the spec used `lesson_slug` but the 0042
      implementation may have settled on a different
      column name. Per LESSONS § "node:sqlite's
      .all() needs `as unknown as T[]`", the join's
      row narrowing uses the double-cast. Test:
      seed a PR with 1 heal and 1
      `lesson_credit` row pointing at it, assert
      the `lesson_credit` field is populated with
      the lesson slug + headline + prior_saves; seed
      a PR with 1 heal and NO `lesson_credit`,
      assert the field is `null`.
- [ ] Verdict composition (deterministic, NO LLM):
      based on `cause` + `lesson_credit`:
      - cause=`cap_reached` + lesson_credit set:
        `"The lesson named the symptom. Heal cap
        is the issue."`
      - cause=`cap_reached` + lesson_credit null:
        `"Heal cap reached AND no lesson covers
        this. Worth a LESSONS entry."`
      - cause=`infra_blocked_giveup` + lesson_
        credit set: `"Infra blocked recovery. The
        lesson named it - consider widening the
        retry budget."`
      - cause=`infra_blocked_giveup` + lesson_
        credit null: `"Infra blocked recovery and
        no lesson covers this flake. Add a
        LESSONS entry."`
      - cause=`human_rejected`: `"Human closed.
        Was the agent off-track or was the goal
        wrong?"`
      - cause=`force_closed_stale`: `"PR sat
        unattended for >7 days. Likely the
        backlog moved on."`
      - cause=`unknown`: `"Cause not detected
        from signals. Consider adding a LESSONS
        entry naming this failure mode."`
      When the verdict ends with "Add a LESSONS
      entry" or "consider adding a LESSONS entry",
      the `draft_lesson` field is populated with a
      pre-filled skeleton (a 3-line template:
      `"### YYYY-MM-DD - <one-line headline>\n\
      n<symptom paragraph - PR <slug> #<n> was
      closed for cause=<cause>. Latest heal
      fail-kind: <fail_kind>. Detail:
      <fail_detail or 'none'>. Verdict:
      <verdict>>\n\nFIX: <fill in>"`). Otherwise
      `draft_lesson` is null. Test: seed each
      (cause, lesson_credit) combination, assert
      the exact verdict string and whether
      draft_lesson is null vs populated.
- [ ] `GET /api/fleet/pr-autopsies` returns the
      shape from AC1. Requires `read` scope.
      Accepts `?window=<days>` (1-30, default 7).
      Test: hit without auth -> 401; with `read`
      -> 200 with the expected shape;
      `?window=1`, assert narrower window;
      `?window=60`, assert 400.
- [ ] Caching: response sets `Cache-Control:
      max-age=600` (10 min - autopsies are
      historical and change only when a PR
      closes). The handler memoises by
      `(window_days, MAX(closed_at) FROM pr
      WHERE state=<closed-casing>, COUNT(*) FROM
      pr WHERE state=<closed-casing> AND
      closed_at >= now - 7 days)`. Per LESSONS
      2026-06-07 "the `pr` table has no
      surrogate `id`; proxy 'latest landed' via
      (MAX(fetched_at), COUNT(*))" - this cache
      MUST use the `(MAX(closed_at), COUNT(*))`
      pair, NEVER `MAX(pr.id)` (the column does
      not exist). Per LESSONS § "in-process
      dedup sets need an explicit reset hook
      for tests", expose
      `_resetPrAutopsiesCacheForTests()` AND
      `_getPrAutopsiesCacheBuildsForTests()` per
      LESSONS § "expose a build counter for
      cache-hit tests, not a fetcher swap".
      Test: two calls within 10 min assert one
      build; close another PR (advance both
      tuple values), assert next call rebuilds.
- [ ] `web/app.js` renders the card on the
      home page BELOW the 0040 riskiest-PR
      badge and 0045 stuck-PR taxonomy card,
      BELOW any 0033/0037/0038 morning cards,
      ABOVE the 0044 spend-efficiency card.
      Container `data-testid="pr-autopsy-
      card"`. Each row: `data-testid="pr-
      autopsy-row-<slug>-<n>"`. Layout: title
      "PR autopsies (last <window> days,
      <total> closes)", then rows in
      closed_at-descending order. Each row
      shows: cause label (color-coded - red
      for cap_reached, orange for
      infra_blocked_giveup, neutral for
      human_rejected / force_closed_stale /
      unknown), slug + #number + age-since-
      close, the riskiness_breakdown line, the
      heal count + latest_fail line, the
      lesson_credit line ("Lesson credited:
      <headline> (<N> prior saves)" or "Lesson
      credited: NONE - failure mode is novel"),
      the verdict line, and (when
      draft_lesson is set) a "[draft entry
      ->]" tap-target. When `total_closes ===
      0`, render NOTHING (no DOM element).
      Per LESSONS § "defence-in-depth secret
      redaction at the renderer boundary",
      every operator-visible string
      (pr_title, latest_fail_detail, verdict,
      draft_lesson) passes through
      `redactSecrets`. Test: stub a 2-close
      fleet (one with credited lesson, one
      without), assert the DOM rows match;
      stub `total_closes: 0`, assert the
      testid is absent.
- [ ] Draft-lesson tap-target: when the
      operator taps "[draft entry ->]" on a
      row, the SPA navigates to the existing
      0036 `/lessons` page with a query param
      `?draft=<base64-encoded-skeleton>`. The
      lessons page reads the param and pre-
      populates a "Suggested entry" textarea
      at the top of the page; the operator
      reviews and copies into their local
      `docs/LESSONS.md` manually (the
      autopsy NEVER writes to LESSONS.md
      itself - see Out of scope). The
      base64 encoding is to avoid URL-
      escaping quirks. Test: tap the draft
      link on a seeded autopsy, assert the
      URL transition + the lessons page
      renders the textarea pre-populated
      with the decoded skeleton.
- [ ] Mobile: at 375px viewport the card
      shows ONLY the most recent 3 autopsies
      by default, with a "+<N> more" tap-
      target that expands the rest inline.
      Each row stacks vertically (cause
      label on top, evidence lines below).
      No horizontal scroll (per 0011
      conventions). At >=600px every row
      renders with the lines aligned. Test:
      assert via the existing mobile-portal
      text-level CSS contract at 375px and
      600px.
- [ ] Quiet-hours integration: when 0030's
      `quietHoursActive` is `true`, the
      "[draft entry ->]" tap-target is
      hidden (the operator should not be
      authoring LESSONS entries at midnight);
      the rest of the card renders normally.
      Per the existing 0030 pull-vs-push
      contract, this matches the 0044
      precedent: information visible, action
      prompt suppressed. Test: stub quiet
      hours active, assert no `draft-entry-
      link` testid in the DOM; stub
      inactive, assert it's present (on
      rows that have a draft).
- [ ] Edge case - a PR was closed AND
      re-opened within the window: the
      autopsy excludes any PR whose current
      `state` is `<open-casing>` (re-opened
      PRs are LIVE, not autopsied; they're
      covered by 0045's open-PR surfaces).
      The autopsy reads only `WHERE state =
      <closed-casing> AND <not-merged>`. Test:
      seed a PR closed then re-opened
      (state=<open-casing>), assert it does
      NOT appear in the autopsy.
- [ ] Performance: `prAutopsies(db, now)`
      against a fleet of 50 projects with 200
      closed PRs in the window completes in
      under 50ms. The HTTP route end-to-end
      (cache miss) completes in under 100ms.
      Per LESSONS § "in-process startServer()
      tests need an empty-roots config +
      run-row seeds", server-boot tests
      plant a tmp `fleet-control.config.
      json` in cwd and restore on cleanup.
      Test: seed the dataset, time both,
      assert thresholds (skip if `process.
      env.PERF !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit`
      clean. No shell-string composition. No
      JSON-shape break to any existing
      `/api/...` route - the new
      `/api/fleet/pr-autopsies` is net-new;
      the home payload is unchanged (the
      card fetches the new route on render);
      the existing `/lessons` page accepts a
      new optional `?draft=` query param
      that pre-populates a textarea but
      otherwise renders byte-identically. No
      schema migration - composes existing
      `pr`, `project`, `control_audit`, and
      0042's `lesson_credit` tables. Per
      LESSONS § "no backticks inside
      template-literal SQL strings",
      identifiers stay plain. Per LESSONS §
      "julianday() drifts ~10us per
      timestamp", any timestamp diff uses
      strftime decomposition.

## Out of scope

- Auto-publishing the draft LESSONS entry
  to `docs/LESSONS.md`. The autopsy SHOWS
  the skeleton; the operator copies and
  refines it themselves. Auto-write would
  pollute the lessons file with low-
  quality entries.
- LLM-authored verdicts or draft-lesson
  skeletons. Both are composed from fixed
  templates so the surface stays
  deterministic and runtime-free.
- An autopsy for MERGED PRs that were
  "regression-prone" (e.g. caused a
  subsequent revert). That's a categorically
  different post-merge problem; v1 is
  non-merge closes only.
- An "auto-reopen" button on the autopsy
  card. The autopsy is reflective; reopen
  is the operator's manual decision.
- A `cause = 'rebase_collision'` bucket
  that names PR deaths via merge conflict.
  Worth a future ticket once the 0045
  taxonomy card has shipped a DIRTY-handling
  bucket; v1 falls these into `unknown`.
- A weekly digest (0012) integration that
  emails autopsies. The home-page card is
  the surface; digest integration is a
  follow-up if asked.
- Auto-attributing a death to MULTIPLE
  lessons. The 0042 ledger picks ONE
  most-recent credit per heal; the autopsy
  shows ONE per PR. Multi-attribution
  invites bikeshedding without value.
- Cross-fleet (multi-operator) autopsy
  surface. Single-fleet by design.
- An ntfy push for "you have a new PR
  death." Autopsies are reflective; pushing
  them would race the 0009 heal-cap push
  that already fires when a PR hits the
  cap (which is the same moment most
  cap_reached deaths land).

## Engineering notes

- `src/views.ts` - new `prAutopsies(db,
  now, opts)` helper next to the existing
  `riskiestOpenPr` (0040),
  `spendEfficiencyRanking` (0044), and the
  0042 lesson-credit helper. The main
  query is `SELECT pr.*, project.slug,
  project.name FROM pr JOIN project ON
  pr.project_id = project.id WHERE
  pr.state = <closed-casing> AND <not-
  merged> AND pr.closed_at >= ?`. For
  each row, compute the cause via the
  cascade in AC2 in JS (the rules need
  per-row heal-audit lookups - cleaner in
  JS than a SQL CTE for small N). Per
  LESSONS § "node:sqlite's .all() needs
  `as unknown as T[]`", every row
  narrowing uses the double-cast.
  PRODUCER-VS-SPEC NOTE: grep `src/
  ingest/prs.ts` for the actual casing
  of `pr.state` (closed vs CLOSED) and
  the merged-flag column (`pr.merged`
  boolean? `pr.merged_at IS NOT NULL`?
  `pr.state = 'merged'` vs `'closed'`?)
  before writing the SELECT.
- `src/views.ts` - REUSE the existing
  `classifyPrFailure` (0040) helper for
  the latest-heal fail-kind. REUSE 0042's
  lesson_credit query helper (whichever
  function exposes "all credits for a
  given heal_audit_id"); if 0042 only
  exposes the per-lesson aggregate, add
  a tiny new helper `lessonCreditsFor
  Heal(db, healAuditId)` in `src/views.
  ts` next to 0042's existing surface.
- `src/server.ts` - one new route `GET
  /api/fleet/pr-autopsies`. Reuse the
  existing `read` scope middleware. The
  cache invalidation tuple is `(window_
  days, MAX(closed_at) WHERE state=
  <closed-casing>, COUNT(*) WHERE
  state=<closed-casing> AND closed_at
  >= now - 7 days)`. Per LESSONS 2026-
  06-07 "the `pr` table has no
  surrogate `id`; proxy 'latest landed'
  via (MAX(fetched_at), COUNT(*))" -
  this MUST use the `(MAX(closed_at),
  COUNT(*))` pair, NEVER `MAX(pr.id)`.
  Per LESSONS § "expose a build counter
  for cache-hit tests, not a fetcher
  swap" - expose `_resetPrAutopsies
  CacheForTests()` and `_getPrAutopsies
  CacheBuildsForTests()`. Per LESSONS
  2026-06-05 "break ingest<->server
  cache-invalidation cycles via a
  globalThis slot" - if the ingest-pass
  needs to bust this cache (it does -
  a freshly-closed PR should appear on
  the next render, not wait out 10
  min), register an invalidation
  function on `globalThis.__fleet_pr_
  autopsies_invalidate__` from
  `src/server.ts` and have
  `runIngestPass` call it lazily off
  globalThis after COMMIT. NEVER a
  return-trip import.
- `web/app.js` - new
  `renderPrAutopsyCard(data)` helper
  called from the existing home-page
  render path. Inserted BELOW the 0040
  badge, BELOW the 0045 stuck-PR card,
  BELOW any 0033/0037/0038 cards,
  ABOVE the 0044 spend-efficiency
  card. When `total_closes === 0` the
  helper returns an empty string. Per
  LESSONS § "defence-in-depth secret
  redaction at the renderer boundary",
  every operator-visible string
  passes through `redactSecrets`. The
  "[draft entry ->]" tap-target
  links to `/lessons?draft=<base64>`
  where the base64 encodes the
  skeleton from AC5.
- `web/app.js` (lessons page handler)
  - extend the existing 0036
  `/lessons` page renderer to read
  the `?draft=<base64>` query param,
  base64-decode it, and pre-populate
  a `<textarea data-testid="lesson-
  draft-textarea">` at the top of the
  page with a "Suggested entry"
  header. The textarea is read-only-
  ish (the operator copies the text;
  no save button - see Out of scope).
  When the param is absent, the
  textarea is NOT rendered. Per
  LESSONS § "defence-in-depth secret
  redaction at the renderer
  boundary", the decoded text passes
  through `redactSecrets` before
  rendering. Test: navigate to
  `/lessons?draft=<valid-base64>`,
  assert the textarea is present and
  contains the decoded text; navigate
  without the param, assert the
  textarea is absent.
- `web/style.css` - one selector
  group for the autopsy card layout
  (vertical stack on mobile, inline
  on >=600px); one for the cause-
  label color chips (reuse existing
  CSS color variables, do NOT add
  new ones); one for the "+<N> more"
  expand toggle on mobile; one for
  the "Suggested entry" textarea on
  the lessons page (reuse existing
  textarea styling). NO new CSS
  variables.
- `tests/pr-autopsies.test.ts` (new)
  - one `test(...)` per AC
  checkbox. Per LESSONS § "time-
  pinned tests must NOT derive seed
  timestamps from `new Date()`",
  every seed anchors to the
  pinned `now`. Per LESSONS § "in-
  process startServer() tests need
  an empty-roots config + run-row
  seeds", server-boot tests plant
  a tmp `fleet-control.config.json`
  in cwd and restore on cleanup.
  Per LESSONS § "anomaly tests
  need sigma > 0 in the fixture" -
  seed a fleet with realistic
  surrounding signal (each cause
  with at least one PR plus a few
  merged controls) so a wrongly-
  ordered cascade fails noisily.
- Schema migration: NO new tables.
  Composes existing `pr`,
  `project`, `control_audit`, and
  0042's `lesson_credit` tables.
  Per LESSONS § "no backticks
  inside template-literal SQL
  strings", identifiers stay plain.
- No new runtime deps. Pairs with
  0040 (riskiness formula reused
  for `riskiness_at_close`), 0023
  (heal-attempts column is the
  primary cause signal), 0042
  (lesson_credit table is the
  attribution source), 0036
  (lessons page hosts the draft-
  entry textarea), 0017 (inbox is
  the live-state analogue; this
  is the death-state analogue),
  0030 (quiet-hours suppresses
  the draft-entry prompt).

## Implementation log

(Appended by the implementation-dev agent during execution.)
