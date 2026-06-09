---
id: 0045
title: Stuck-PR taxonomy card - label every open agent PR so the operator knows whether to intervene or wait
status: in-progress
priority: P1
area: observability
created: 2026-06-09
owner: gtm-innovation
---

## User story

As a fleet operator at 9am scrolling the portal home page with 5
open agent PRs across three projects, I want one inline card that
labels each PR with EXACTLY ONE of seven taxonomy buckets -
`ci_red` | `ci_absent` | `infra_flake` | `account_suspended` |
`needs_human` | `merging` | `healthy_waiting` - so that I know in
ONE glance which PRs are in the heal loop (no action), which are
stuck on infra (re-trigger), and which need my hands (open and
fix). Today I have to open each PR, read its checks, count its
heal-rows, and mentally classify - the portal already has every
signal it needs to do that for me.

## Why now (four lenses)

### Product Owner
0040 (riskiest open PR badge) already names the SINGLE PR most
worth tending - but it answers "which one first," not "what KIND
of intervention does each open PR need." The cross-fleet lessons
make the distinction load-bearing: `ci_red` (heal it),
`ci_absent` (LESSONS 2026-05-26 "GH Actions doesn't fire on a
fresh PR" - re-trigger the webhook), `infra_flake` (cross-LESSONS
"supabase start port-bind", "address already in use" - re-run,
don't heal), `account_suspended` (cross-LESSONS 2026-05-26
"account is suspended" - external, wait), `needs_human` (>= 2
heal attempts per AGENTS.md Hard NO - escalate), `merging`
(`mergeStateStatus=CLEAN` + green + autoMerge armed - leave it),
`healthy_waiting` (no heals, no failed checks, age < 6h -
default). The operator currently does this classification in
their head against five PRs every morning; the card collapses it
to one glance. The smallest meaningful unit of value: ONE card
that takes the entire open-PR list and stamps a deterministic
verdict on each. Pure composition over already-shipped data
(`pr.ci_state`, `pr.mergeStateStatus`, `pr.heal_attempts`,
`control_audit` heal rows, `classifyPrFailure` from 0040). No new
schema. No new ingest path.

### Stakeholder
Widens the moat on the safety + triage axis. Per the cross-fleet
courtiq lesson "PRs getting stuck on infra flakes need a
different response from PRs failing real tests" (and the related
"the share-worthy moment is the structural impossibility for
other tools"), this card is THE structural surface that encodes
the distinction across the whole fleet at once. GitHub-native
gives you one PR's check rollup, with no concept of
heal-attempts, no concept of infra-flake taxonomy, no concept of
"this is the SECOND heal so escalate." Anthropic's dashboard has
none of the PR signals. Only fleet-control's SQLite has all
seven signals coexisting: `pr.ci_state`, `pr.mergeStateStatus`,
`pr.heal_attempts`, `control_audit.stdout_tail`,
`pr.fetched_at`, `pr.autoMergeRequest` (if recorded), and
`project.slug`. The fused taxonomy is structurally impossible
outside fleet-control. Same moat-signal as 0040 (priority) and
0044 (efficiency), now on the TRIAGE-KIND axis. The screenshot
worth sharing: one card that classifies every open agent PR
across the fleet with a one-word verdict and a deterministic
reason - the kind of opinionated surface only a fused-signal
tool can produce.

### User (operator at 9am, 5 open PRs)
On the home page, BELOW any visible 0033/0037/0038 cards, BELOW
the 0040 riskiest-PR badge, ABOVE the project grid, an inline
card:

<!--
Open PR triage (5 across 3 projects)

  needs_human  courtiq #314    2 heals (cap), latest: red_test
                 -> open & fix

  ci_absent    fleet-ctrl #117 pushed 12m ago, no checks queued
                 -> close + reopen

  infra_flake  almanac #88     port 54322 bound, 1 heal
                 -> wait (loop retries)

  merging      courtiq #318    CLEAN + auto-merge armed
                 -> leave it

  healthy_waiting  digitalcraft #41   3h old, awaiting review
                                                       (3 more)
-->

The card lists every open agent PR, one per row, ordered by
"urgency rank" (needs_human first, then ci_red, ci_absent,
infra_flake, account_suspended, merging, healthy_waiting). Each
row carries: bucket label, slug + PR number, one-line evidence
(heal count, fail kind, age, mergeStateStatus, etc.), and a
deterministic "next action" verb chosen from a fixed map (NEVER
LLM-authored - see Out of scope). On phone, the card collapses
to ONLY the buckets that need operator action (`needs_human`,
`ci_red`, `ci_absent`, `account_suspended`), with the rest
counted behind a "+N healthy / merging" tap-target.

### Growth
The screenshot worth sharing: one card that grades five open PRs
with a single-word verdict each, naming the structural reason.
That artifact answers the prospective-operator question "what
does it FEEL like when your agents have five PRs in flight" in a
way a per-PR card cannot. The "show me" pitch: "you don't open
five PRs to figure out which one needs you. The portal tells
you - and tells you WHY for each one." More compelling than
0040's single-PR triage because it shows the whole fleet at a
glance. Per the cross-fleet courtiq lesson "the share-worthy
moment is the opinionated verdict," the per-PR verdict cascade
is the kind of surface that makes a prospective adopter ask
"how does it know that?"

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: when
this spec names a column value literally (`pr.state = 'OPEN'`,
`pr.ci_state`, `pr.mergeStateStatus`, `control_audit.action =
'heal'`), the implementing dev MUST grep `src/ingest/prs.ts` and
`src/control.ts` for the producer's actual casing before writing
the SELECT. Per LESSONS 2026-06-05 "groomer prose can disagree
with the schema; the schema wins": the producer is the contract.
The existing 0040 `riskiestOpenPr` + `classifyPrFailure` helpers
are precedent - copy their casing (the 0040 spec said
`state = 'OPEN'` and the ingester writes `'open'` lowercase;
ship discovered the reconciliation, the implementing dev for
this ticket must do the same audit BEFORE writing the SELECT).

- [ ] `src/views.ts` exports `stuckPrTaxonomy(db, now: Date):
      {open_count: number, by_bucket: Record<Bucket, number>,
      rows: Array<{project_slug: string, project_name: string,
      pr_number: number, pr_title: string, pr_url: string,
      bucket: Bucket, evidence: string, next_action: string,
      heal_attempts: number, age_hours: number,
      urgency_rank: number}>, generated_at: string}` where
      `Bucket = "needs_human" | "ci_red" | "ci_absent" |
      "infra_flake" | "account_suspended" | "merging" |
      "healthy_waiting"`. Selects all `pr WHERE <open-casing>
      AND is_agent = 1` joined to `project`. For each row,
      computes the bucket via the cascade in AC2. Rows are
      sorted by `urgency_rank` ascending (needs_human=0,
      ci_red=1, ci_absent=2, infra_flake=3, account_suspended=4,
      merging=5, healthy_waiting=6) then by `age_hours`
      descending within bucket. `by_bucket` carries the count
      per bucket (zero buckets included so the SPA can render
      "0" without a key check). When `open_count === 0`,
      returns `{open_count: 0, by_bucket: <all zero>, rows:
      []}`. Per LESSONS § "node:sqlite's .all() needs `as
      unknown as T[]`", every row narrowing uses the double-
      cast. Per LESSONS § "time-pinned tests must NOT derive
      seed timestamps from `new Date()`", every seed in the
      tests anchors to the pinned `now`. Test: seed 7 open
      PRs covering each bucket, assert each row's bucket;
      seed 0 PRs, assert empty; seed only healthy_waiting,
      assert sort order.
- [ ] Bucket cascade (deterministic, evaluate top-down; the
      FIRST matching rule wins so the operator sees the
      strongest signal, not a noisier later one):
      1. **needs_human**: `pr.heal_attempts >= 2` (AGENTS.md
         Hard NO: "Never exceed 2 heal attempts on one PR -
         escalate via a human comment"). `evidence` = "<N>
         heals (cap), latest: <fail_kind from
         classifyPrFailure>". `next_action` = "open & fix".
      2. **account_suspended**: the latest `control_audit`
         heal row's `stdout_tail` matches the literal regex
         `/account is suspended/i` (per cross-LESSONS 2026-
         05-26 "account is suspended" + LESSONS 2026-05-26
         "GH Actions infra"). `evidence` = "GitHub account
         suspended, retried <N>x". `next_action` = "external
         - wait or escalate to human".
      3. **infra_flake**: `classifyPrFailure(db, projectId,
         prNumber).kind === 'infra_flake'` (the existing
         0040 helper - reuse it untouched, NO NEW PATTERNS
         in this ticket). `evidence` = "<detail substring
         from classifier>, <N> heal<s?>". `next_action` =
         "wait (loop retries)".
      4. **ci_red**: `pr.ci_state` matches the producer's
         red casing (PRODUCER-VS-SPEC NOTE: grep `src/
         ingest/prs.ts` line ~164 for the exact lowercase
         token - the 0040 LESSON established it's `'red'`,
         not `'FAILURE'`). `evidence` = "<first failed
         check name OR 'red check'>". `next_action` =
         "review the check log".
      5. **ci_absent**: zero rows in the PR's recent check-
         runs AND `pr.fetched_at` was at least 5 minutes
         ago (per LESSONS 2026-05-26 "GH Actions doesn't
         fire on a fresh PR" - the 5-min floor avoids
         flagging a PR opened 30s ago). The "zero check-
         runs" signal reads from whatever existing column
         carries it (PRODUCER-VS-SPEC NOTE: grep `src/
         ingest/prs.ts` for the field that stores the
         check-run count or rollup, typically
         `checkRollupCount`, `check_rollup`, or
         `statusCheckRollupContexts` - the implementing
         dev MUST audit before writing the SELECT and
         document the reconciliation in the Implementation
         log). `evidence` = "pushed <age> ago, no checks
         queued". `next_action` = "close + reopen to
         re-fire webhook".
      6. **merging**: `pr.mergeStateStatus` matches the
         producer's clean casing AND `pr.ci_state` matches
         the producer's green casing (PRODUCER-VS-SPEC
         NOTE: grep the ingester for both - the green token
         per 0040 is `'green'` lowercase). `evidence` =
         "CLEAN + auto-merge armed" when the
         autoMergeRequest field is non-null, else "CLEAN
         + green". `next_action` = "leave it".
      7. **healthy_waiting** (default, no test rule fires):
         `pr.heal_attempts === 0` AND age < 6h.
         `evidence` = "<age> old, awaiting review".
         `next_action` = "leave it (or review)".
      When none of 1-7 matches, the row falls into
      `healthy_waiting` with `evidence = "no signal"`. Per
      LESSONS § "anomaly tests need sigma > 0 in the
      fixture" - the test seeds at least one PR per bucket
      with realistic surrounding signal so a wrongly-ordered
      cascade fails noisily. Test: for each of the 7
      buckets, seed exactly the matching condition, assert
      the row carries the expected bucket and `evidence`
      string substrings.
- [ ] `GET /api/fleet/stuck-pr-taxonomy` returns the shape
      from AC1. Requires `read` scope. Test: hit without
      auth -> 401; with `read` and 7 seeded open PRs (one
      per bucket) -> 200 with the expected shape; with
      zero open PRs -> 200 with `open_count: 0` and `rows:
      []`.
- [ ] Caching: the route response sets `Cache-Control:
      max-age=30` (30s - any of the seven inputs can shift
      the verdict). The handler memoises by `(open_pr_max_
      fetched_at, open_pr_count, latest_heal_ts)` - a
      three-value tuple cheaper than the main query. Per
      LESSONS 2026-06-07 "the `pr` table has no surrogate
      `id`; proxy 'latest landed' via (MAX(fetched_at),
      COUNT(*))" - the open-PR signal MUST use the
      `(MAX(pr.fetched_at), COUNT(*))` pair (WHERE
      state=<open-casing>), NEVER `MAX(pr.id)` (the column
      does not exist). The third tuple value is `SELECT
      MAX(ts) FROM control_audit WHERE action = 'heal'`.
      Per LESSONS § "in-process dedup sets need an
      explicit reset hook for tests", expose
      `_resetStuckPrTaxonomyCacheForTests()` AND
      `_getStuckPrTaxonomyCacheBuildsForTests()` per
      LESSONS § "expose a build counter for cache-hit
      tests, not a fetcher swap". Test: two calls within
      30s assert one build; insert a new heal-audit row,
      assert next call rebuilds; insert a new open PR
      (changes COUNT), assert next call rebuilds;
      advance only `fetched_at` on an existing PR,
      assert next call rebuilds.
- [ ] `web/app.js` renders the card on the home page
      BELOW any 0033/0037/0038 cards, BELOW the 0040
      riskiest-PR badge, ABOVE the project grid (and
      ABOVE the 0044 spend-efficiency card if both
      render - this card is action-urgent, that one is
      reflective). Container `data-testid="stuck-pr-
      taxonomy-card"`. Each row gets `data-testid="stuck-
      pr-row-<bucket>-<slug>-<n>"` so tests can grab a
      specific one. Layout: title "Open PR triage
      (<open_count> across <project_count> projects)",
      then rows in `urgency_rank` order, each with the
      bucket label (color-coded - red for needs_human,
      orange for ci_red/ci_absent/account_suspended,
      yellow for infra_flake, green for merging, neutral
      for healthy_waiting), slug + #number link, evidence
      line, and the right-arrow "-> <next_action>" tap-
      target linked to `/p/<slug>?pr=<n>` (reuses the
      existing 0040 scroll-and-highlight pattern). When
      `open_count === 0`, render NOTHING (no DOM
      element, no testid). Per LESSONS § "defence-in-
      depth secret redaction at the renderer boundary",
      every operator-visible string (evidence,
      next_action, pr_title) passes through
      `redactSecrets` before insertion. Test: stub each
      bucket, assert the DOM row matches; stub
      `open_count: 0`, assert the testid is absent.
- [ ] Mobile: at 375px viewport the card hides every
      row whose bucket is `merging` or `healthy_waiting`,
      collapsing them into a single trailing line "+<N>
      healthy or merging" that expands inline on tap.
      The action-urgent rows (`needs_human`, `ci_red`,
      `ci_absent`, `infra_flake`, `account_suspended`)
      remain fully visible. Bucket label, slug+number,
      and the next-action link stack vertically per row.
      No horizontal scroll (per 0011 conventions). At
      >=600px every row renders inline. Test: assert via
      the existing mobile-portal text-level CSS contract
      at 375px (count of visible rows when fleet has
      mixed buckets) and 600px (every row visible).
- [ ] Quiet-hours integration: when 0030's
      `quietHoursActive` is `true`, the card hides every
      row whose bucket is `infra_flake`, `merging`, or
      `healthy_waiting` (none of these need the operator
      mid-sleep). The action-urgent rows (`needs_human`,
      `ci_red`, `ci_absent`, `account_suspended`) remain
      visible because the operator opened the portal
      voluntarily and these are the ones a human must
      handle. The `next_action` arrow link is still
      rendered (visible information; no push). Per the
      existing 0030 pull-vs-push contract, this matches
      the 0044 quiet-hours behaviour: information visible,
      noise demoted. Test: stub quiet hours active +
      mixed-bucket fleet, assert only the action-urgent
      rows render; stub quiet hours inactive, assert
      every row renders.
- [ ] Project page anchor: when the "-> <next_action>"
      link is tapped, the project page opens with
      `?pr=<number>` and the matching PR card flashes
      via the existing 0040 `pr-card-flash` CSS class.
      No new CSS variable. Test: navigate to
      `/p/courtiq?pr=314` with the PR seeded, assert
      the card has the highlight class; navigate
      without the param, assert no highlight.
- [ ] Edge case - the PR was bucketed `needs_human` but
      a third heal landed anyway (race / human override):
      the cascade still puts it in `needs_human` (the
      AGENTS.md cap is a CEILING - `>= 2` means the PR
      already crossed the line; more heals don't move
      it to `ci_red`). The `evidence` string updates to
      "<actual N> heals (over cap)". Test: seed a PR
      with `heal_attempts = 3`, assert bucket is
      `needs_human` and evidence contains "(over cap)".
- [ ] Performance: `stuckPrTaxonomy(db, now)` against a
      fleet of 50 open PRs (each with up to 2 heal-
      audit rows) completes in under 35ms. The HTTP
      route end-to-end (cache miss) completes in under
      90ms. Per LESSONS § "in-process startServer()
      tests need an empty-roots config + run-row seeds",
      server-boot tests plant a tmp
      `fleet-control.config.json` in cwd and restore on
      cleanup. Test: seed the dataset, time both,
      assert thresholds (skip if `process.env.PERF !==
      "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No
      shell-string composition. No JSON-shape break to
      any existing `/api/...` route - the new
      `/api/fleet/stuck-pr-taxonomy` is net-new; the
      home payload is unchanged (the card fetches the
      new route on render). No schema migration -
      composes existing `pr`, `project`, and
      `control_audit` tables. Per LESSONS § "no
      backticks inside template-literal SQL strings",
      identifiers stay plain. Per LESSONS § "julianday()
      drifts ~10us per timestamp", any age math uses
      strftime decomposition or JS-side integer ms.

## Out of scope

- LLM-authored prose for the evidence or next-action
  strings. Both are composed from fixed templates so
  the verdict stays deterministic and runtime-free.
- An eighth bucket for "PR has merge conflicts vs main"
  (`mergeStateStatus = DIRTY`). The cross-fleet
  courtiq lessons distinguish union-mergeable orphans
  from real conflicts and the rule needs more design;
  v1 lumps DIRTY into `needs_human`.
- An auto-action button ("close + reopen now") for the
  `ci_absent` bucket. The card is a SIGNAL surface; the
  action is the existing `/p/<slug>` page's PR card.
  Mixing them weakens both.
- A per-project taxonomy card (each project shows its
  own row split). The fleet-wide single card IS the
  value; per-project splits fragment the glance.
- An ntfy push for "you have a new needs_human PR." The
  0009 ntfy budget already covers heal-cap escalations
  via a different surface; doubling here would race.
- A historical "taxonomy distribution over the last 14
  days" trend chart. The card is point-in-time; trend
  lives in the digest (0012) or wrap (0037).
- Adding NEW infra-flake patterns to
  `classifyPrFailure`. The 0040 helper is reused
  AS-IS; any new pattern is a separate ticket so the
  regression surface for that helper stays focused.
- Cross-fleet (multi-operator) bucketing surface.
  Single-fleet by design.
- A "snooze this bucket for 1h" surface. The 0017
  inbox-dismissal mechanic covers transient hides;
  reusing it would be a follow-up if asked, not v1.
- An override knob that lets the operator manually
  re-bucket a PR. The cascade is deterministic; an
  override would invite drift between the operator's
  mental model and the next morning's verdict.

## Engineering notes

- `src/views.ts` - new `stuckPrTaxonomy(db, now)`
  helper next to the existing `riskiestOpenPr` (0040)
  and `spendEfficiencyRanking` (0044). The main query
  is `SELECT pr.*, project.slug, project.name FROM pr
  JOIN project ON pr.project_id = project.id WHERE
  pr.state = <open-casing> AND pr.is_agent = 1`. For
  each row, compute the bucket in JS via the cascade
  in AC2 (no CTE - faster for small N, and the cascade
  reads two side queries per row that don't fit a CTE
  cleanly). PRODUCER-VS-SPEC NOTE: grep
  `src/ingest/prs.ts` for the actual casing of `state`,
  `ci_state`, `mergeStateStatus`, and any check-run
  count column before writing the SELECT. Per
  LESSONS 2026-06-05 "groomer prose can disagree with
  the schema; the schema wins" - the producer is the
  contract.
- `src/views.ts` - REUSE the existing
  `classifyPrFailure(db, projectId, prNumber)` helper
  from 0040 untouched. The bucket cascade calls it for
  the `infra_flake` and `account_suspended` rules. NO
  new infra-flake patterns are added in this ticket
  (out of scope above).
- `src/server.ts` - one new route `GET
  /api/fleet/stuck-pr-taxonomy`. Reuse the existing
  `read` scope middleware. The cache invalidation
  tuple is `(MAX(pr.fetched_at) WHERE
  state=<open-casing>, COUNT(*) WHERE
  state=<open-casing>, MAX(control_audit.ts) WHERE
  action = 'heal')`. Per LESSONS 2026-06-07 "the `pr`
  table has no surrogate `id`; proxy 'latest landed'
  via (MAX(fetched_at), COUNT(*))" - NEVER use
  `MAX(pr.id)`. Per LESSONS § "expose a build counter
  for cache-hit tests, not a fetcher swap" - expose
  `_resetStuckPrTaxonomyCacheForTests()` and
  `_getStuckPrTaxonomyCacheBuildsForTests()`. Per
  LESSONS 2026-06-05 "break ingest<->server cache-
  invalidation cycles via a globalThis slot" - if
  the ingest-pass needs to bust this cache (it
  doesn't for v1; the (MAX(fetched_at), COUNT(*))
  tuple captures every relevant change), use the
  globalThis slot pattern, NEVER a return-trip import.
- `web/app.js` - new
  `renderStuckPrTaxonomyCard(data)` helper called
  from the existing home-page render path. Inserted
  BELOW any 0033/0037/0038 cards and the 0040
  riskiest-PR badge, ABOVE the 0044 spend-efficiency
  card and ABOVE the project grid. When `open_count
  === 0` the helper returns an empty string. Per
  LESSONS § "defence-in-depth secret redaction at
  the renderer boundary", every operator-visible
  string passes through `redactSecrets`. The "->
  <next_action>" link uses the existing 0040
  `?pr=<n>` query-param pattern for scroll-and-
  highlight on the project page.
- `web/style.css` - one selector group for the card
  layout (vertical stack on mobile, inline on
  >=600px); one for the bucket-label color chips
  (red / orange / yellow / green / neutral - reuse
  existing CSS color variables, do NOT add new ones);
  one for the "+N healthy or merging" expand toggle
  on mobile. Reuse the existing 0040 `pr-card-flash`
  CSS class for the project-page anchor highlight.
- `tests/stuck-pr-taxonomy.test.ts` (new) - one
  `test(...)` per AC checkbox. Per LESSONS § "time-
  pinned tests must NOT derive seed timestamps from
  `new Date()`", every seed anchors to the test's
  pinned `now`. Per LESSONS § "in-process
  startServer() tests need an empty-roots config +
  run-row seeds", server-boot tests plant a tmp
  `fleet-control.config.json` in cwd and restore on
  cleanup. Per LESSONS § "anomaly tests need
  sigma > 0 in the fixture" - seed at least one PR
  per bucket with realistic surrounding signal so a
  wrongly-ordered cascade fails noisily. Per LESSONS
  § "node:sqlite's .all() needs `as unknown as
  T[]`", every row narrowing uses the double-cast.
- Schema migration: NO new tables. Composes existing
  `pr`, `project`, `control_audit` tables. Per
  LESSONS § "no backticks inside template-literal
  SQL strings", identifiers stay plain.
- No new runtime deps. Pairs with 0040 (single-
  riskiest is the "what FIRST", this is the "what
  KIND for each"), 0023 (heal-attempts column is
  the primary `needs_human` signal), 0017 (the
  inbox lists open PRs; this card classifies them),
  0030 (quiet-hours suppresses non-urgent rows),
  and 0044 (spend-efficiency is the parallel
  per-PROJECT reflective surface; this is the
  per-PR action surface - both render, this one
  above).

## Implementation log

- 2026-06-09 (in-progress): producer-vs-spec reconciliation grepped
  `src/ingest/prs.ts`:
  - `pr.state`: `'open'` lowercase (line 164) + `'MERGED'` uppercase
    (the prs ingester deletes on every pass and only inserts state
    `'open'`; the merged casing is established by sibling helpers
    `costPerMergedPr` / `spendEfficiencyRanking` / `fridayWrap`).
  - `pr.ci_state`: one of `'red' | 'pending' | 'green' | 'none'`
    (lowercase from `ciState()` in `src/ingest/prs.ts`, NOT GitHub
    rollup tokens).
  - check-rollup count: the producer DOES NOT persist a numeric
    rollup count column on `pr`. The signal "zero check-runs" is
    encoded via `ci_state = 'none'` (per `ciState()`'s `!Array
    .isArray(rollup) || !rollup.length` branch). The taxonomy
    helper therefore reads `ci_state = 'none'` as the ci_absent
    bucket condition.
  - `pr.merge_state` stores `mergeStateStatus` verbatim from `gh`
    (e.g. `'CLEAN'`, `'BEHIND'`, `'DIRTY'`) - uppercase.
  - `pr.autoMergeRequest` is NOT persisted to the schema; the
    "auto-merge armed" evidence cue therefore degrades to
    `"CLEAN + green"` (the AC2 #6 fallback string) until a future
    ticket persists the field.
- 2026-06-09: helper, route, cache, SPA renderer added per ACs.
