---
id: 0066
title: Monthly stakeholder summary at a signed share URL - one prose-shaped non-engineer-readable page the operator emails to a partner / manager / co-founder once a month so an external stakeholder expects the artifact and locks in retention
status: in-progress
priority: P1
area: observability
created: 2026-06-17
owner: gtm-innovation
---

## User story

As a fleet operator whose partner / manager / co-founder / accountability
buddy keeps asking "so how are those agents going?" and gets an awkward
verbal summary because no existing surface is readable by a non-engineer
(the portal home is too dense, /pulse is too granular, /receipts is too
numeric, /year is once a year), I want a SIGNED stakeholder-summary URL
`/share/stakeholder/<token>` that renders a single prose-shaped one-page
monthly retrospective in plain English ("this month your fleet shipped
14 features across 3 projects, saved you about 6 hours via 2 lessons it
learned, and currently has 1 PR waiting for your review") with no
engineering jargon, no agent phase names, no $/PR / heal-attempt / drift-
band terminology - so that I can paste the URL once and the
non-engineer stakeholder bookmarks it AND opens it on the 1st of every
month, turning a one-time install into a recurring external commitment
the operator cannot quietly stop.

## Why now (four lenses)

### Product Owner

Every existing card / surface is operator-readable. 0033 yesterday-
glance and 0037 Friday wrap use phase names ("ship / groom / review
shipped 4 features"). 0041 receipts uses $/PR. 0050 year-in-review
uses "the project with the best heal-attempt streak". 0059 biggest-
surprise uses "the project deviated > 2sigma from its trailing
median". A non-engineer stakeholder reading any of those bounces in 5
seconds. There is NO surface in the codebase that renders the same
data in stakeholder-readable prose.

The smallest meaningful unit of value: ONE new signed-token route
`/share/stakeholder/<token>` that renders a STATIC HTML page with:

1. **Header**: "<operator displayName>'s autonomous agent fleet -
   <Month YYYY>". Operator-supplied operator name (reuses the 0065
   `operator: { displayName }` config field). If 0065 has NOT
   shipped yet, falls back to "your autonomous agent fleet".
2. **One paragraph of prose** (3-4 sentences) summarising the
   month in plain English. NO phase names. NO $ amounts (per
   the cross-fleet "agents run on a Max subscription, $ is
   relative not invoiced" framing). Uses TIME SAVED as the
   primary unit ("saved you about 6 hours") and FEATURES
   SHIPPED as the count ("14 features across 3 projects").
   The prose is composed from a small library of phrase
   templates - PURE deterministic shape, NO LLM call.
3. **Three highlights** (one-line each):
   - The single feature shipped this month worth bragging
     about (the longest-running PR that finally merged, OR
     the riskiest open PR that finally got auto-approved).
     Anonymised per 0013 / 0057 discipline (project alias,
     no real repo names).
   - The single lesson the fleet learned this month that's
     most cited (top heal-credit lesson from 0042 / 0052,
     summary in plain English: "the fleet learned that X
     causes Y; it has caught Y in 3 future PRs").
   - The most-active project this month (alias only).
4. **One waiting-for-you call to action**: "you have N PR(s)
   waiting for your review" - a single number derived from the
   existing inbox helper (0017). The CTA does NOT link to the
   actual PRs (no internal portal links - this is a
   stakeholder surface; the OPERATOR clicks through to their
   own portal from somewhere else). The CTA is informational:
   "there are 2 features ready for your review".
5. **Footer**: "powered by fleet-control - <operator
   displayName> has been running an autonomous agent fleet
   since <sinceDate>". No install CTA on this surface (this
   is a stakeholder-facing artifact - the install hint would
   feel like the operator's tool advertising to their
   stakeholder).

The token is signed via the existing 0013 snapshot-token infra
(same `snapshot` table; new `kind: "stakeholder_monthly"` row).
The signed URL is STABLE - the same token returns the latest
completed month's summary each visit (the URL stops needing
re-issuing). The token can be revoked by the operator at any
time via the existing 0013 revoke surface.

PRODUCER-VS-SPEC NOTE per LESSONS 2026-06-05: the implementing
dev MUST grep `src/views.ts` for the existing 0062 monthly-retro
helper signature (`fleetMonthlyRetro(db, now)` per the shipped
ticket) - the stakeholder summary REUSES the same numeric
aggregates and ONLY re-renders them in prose form. The
stakeholder helper is a PURE re-renderer over the 0062 payload,
NOT a parallel SQL surface. Per LESSONS 2026-06-13 the
stakeholder helper lives INSIDE `src/views.ts` (no new module);
the import direction stays clean. Per LESSONS 2026-06-15 on
first-meaningful-month pivot - if 0062 returns
`kind: 'first-full-month'` for the current month, the
stakeholder summary surfaces the same "your fleet is in its
first full month - check back next month" empty-state framing
(stakeholder-readable prose).

### Stakeholder

Widens the moat on the OPERATOR-RETENTION axis where no existing
surface invests. The strongest retention force is EXTERNAL
COMMITMENT - the operator who can quietly stop using a tool
WON'T stop if a partner / manager / co-founder expects the
monthly artifact. Every other observability tool in this space
has internal-only surfaces; fleet-control's local-only telemetry
+ signed-token infra is uniquely positioned to ship an external
stakeholder surface WITHOUT requiring a SaaS hop.

The hosted-competitor structural gap: every SaaS observability
tool ships a "share with your team" surface that costs $19/seat
per stakeholder. fleet-control ships the same surface as a
signed URL the operator emails ONCE, and the stakeholder
bookmarks it forever. Zero per-seat cost. Zero account creation.
The hosted tools can't compete because their entire business
model REQUIRES the per-seat friction; fleet-control's local
SQLite + signed token bypasses it entirely.

The "show me" moment worth a screenshot: the operator's
co-founder pinning the stakeholder URL to their Slack
bookmarks bar. Every monthly visit is an unrenewed retention
event for the operator that the operator didn't have to
orchestrate.

Per the cross-fleet courtiq lesson "external commitments
outperform internal motivation for any solo operator running
multiple side projects, because external commitments invoke
SOCIAL accountability AND DEFAULT-PRESERVATION instincts that
internal motivation can't" (CROSS_LESSONS section courtiq
Entries 2026-05-21 family on retention forces), the stakeholder
URL is the canonical externalising surface. The operator who
considers pausing fleet-control has to also email the
stakeholder "I'm stopping", which is hard.

Pairs with 0013 (signed snapshot token - reuses the infra),
0062 (monthly retro helper - reuses the aggregate), 0065
(operator profile - shares the operator config field), 0064
(rate-limit middleware - the new `/share/` route inherits the
throttle), 0017 (inbox - the "waiting for review" CTA reuses
the existing helper).

### User (operator at 9am, looking at the portal)

Three operator scenarios:

1. **First-time setup** (one-time, < 90 seconds): the operator
   navigates to the portal home page, sees a new card "share a
   monthly summary with someone outside your laptop" (this is
   the ONE new card on home - prominent on month-1 of feature
   shipping, dismissable, never re-appears after the operator
   either sets up the URL OR dismisses the card). The operator
   clicks "create stakeholder URL", confirms the operator
   displayName (auto-filled from the 0065 config), gets a
   one-time-rendered URL `http://<host>/share/stakeholder/
   <token>`. The operator copies the URL and emails it to
   their partner / manager / co-founder with a sentence of
   context.

2. **Daily glance** (zero impact): the operator's portal home
   is unchanged after the one-time card is dismissed. The
   monthly retro card (0062) STILL fires on the 1st of each
   month - the stakeholder URL is a sibling artifact, not a
   replacement.

3. **Monthly stakeholder visit** (the high-leverage moment):
   on the 5th of each month, the operator's partner opens
   their Slack bookmarks, clicks the stakeholder URL,
   reads the one-paragraph prose ("your fleet shipped 14
   features this month, saved you about 6 hours, has 1 PR
   waiting for review"), bookmarks it, sees the same URL
   again on the 5th of next month. The operator never has
   to remember to send a monthly update - the URL is the
   recurring artifact.

Per LESSONS 2026-06-11 expose
`_renderStakeholderSummaryForTests(payload, opts)` so the
prose-composition branches (first-full-month, full-month,
empty-month) are testable without HTTP round-trip. Per
LESSONS 2026-06-12 the rendered HTML carries
`data-testid="stakeholder-headline-prose"` and tests anchor
on that, NOT a body substring match.

### Growth

The growth bet: every stakeholder URL is a RETENTION lever, not
an acquisition lever - but retention is the multiplier on
acquisition. An operator who keeps running fleet-control for 18
months because their partner expects the monthly summary is
worth N first-time installs from /pulse impressions, because
the operator's longitudinal portfolio (0065 profile, 0050 year-
in-review, 0041 receipts trail) compounds with every shipped
ticket they author.

Per the cross-fleet courtiq lesson "the operator's retention
curve is the single biggest leverage point for a single-user
tool because acquisition is one-time but retention is monthly"
(CROSS_LESSONS section courtiq Entries 2026-05-21 family on
retention-multiplier-on-acquisition), the stakeholder URL is
the single most-leveraged retention surface this codebase can
ship - one helper, one route, one prose composer, infinite
recurring impressions on the operator's external
accountability.

The DOWNSIDE acknowledgment: an operator with no stakeholder
to share with sees this card on home, dismisses it, never
encounters it again. The card MUST be dismissable forever, NOT
re-fire. Per the existing 0017 inbox dismissal posture - the
dismiss is persistent in `inbox_dismissal`.

Pairs with 0013 (signed token infra), 0062 (monthly retro),
0017 (dismissal posture), 0065 (operator config), 0064 (rate-
limit middleware).

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE per
LESSONS 2026-06-05: the implementing dev MUST grep
`src/views.ts` for the shipped 0062 `fleetMonthlyRetro` helper
signature AND payload shape before authoring the stakeholder
re-renderer (the re-renderer is a PURE function over the 0062
payload + the operator config, NOT a new SQL surface). Per
LESSONS 2026-06-13 the helper lives in views.ts - no new module.
Per LESSONS 2026-06-10 the rendered HTML response does NOT pass
through body-string redactSecrets (the input is operator-
authored prose + numbers, no token leak risk); if defence-in-
depth is desired, redact the VALUES before composition, not the
body.

- [ ] New helper `stakeholderMonthlySummary(db, config, now)`
      in `src/views.ts` returns `{ headline, operatorName,
      monthIso, prose: string, highlights: [{ kind, text },
      { kind, text }, { kind, text }], cta: { kind, text },
      footer, kind: "card" | "first-full-month" |
      "warming-up", asOf, version: 1 }`. The `prose` field is
      composed by `composeStakeholderProse(retroPayload,
      operatorName)` - a PURE renderer over the 0062 helper's
      output. The helper is pure on `(db, config, now)` per
      LESSONS 2026-05-29; seed timestamps anchor on the
      passed `now`, never `new Date()`. Test: seed 14 merged
      PRs across 3 projects in the trailing month, run the
      0062 helper to confirm `kind === 'card'`, then
      `stakeholderMonthlySummary(db, config, now)` returns
      `kind === 'card'` AND `prose` contains the literal
      "14 features" AND the literal "3 projects" AND NO
      occurrences of "ship" "groom" "review" "$" "$/PR"
      "heal" "sigma" "drift" "anomaly" (the engineer-only
      vocabulary).

- [ ] Prose is deterministic over identical input: calling
      `composeStakeholderProse(payload, operatorName)`
      twice on identical inputs returns identical strings.
      The composer is a small library of phrase templates
      (`features_shipped`, `projects_active`, `time_saved`,
      `lesson_learned`, `pr_waiting`) keyed off the
      payload's numeric shape. No LLM call, no random
      jitter. Test: invoke the composer twice on the same
      input; assert strict string equality.

- [ ] New route `GET /share/stakeholder/<token>` in
      `src/server.ts` looks up the token in the `snapshot`
      table (kind = "stakeholder_monthly") and renders the
      summary page when the token is valid AND not revoked.
      404s on unknown / revoked tokens. The route is PUBLIC
      (no auth gate) and inherits the 0064 rate-limit
      middleware via the existing `/share/` prefix family.
      PRODUCER-VS-SPEC NOTE: grep `src/snapshots.ts` (or
      equivalent per 0013) for the existing
      `lookupSnapshot(token)` helper - REUSE the function,
      do NOT re-author. Test: create a token via the 0013
      infra with `kind: "stakeholder_monthly"`; hit the
      route - assert 200 + content-type + the rendered
      HTML contains `data-testid="stakeholder-headline-
      prose"`. Revoke the token via the existing 0013
      revoke surface; hit again - assert 404.

- [ ] First-full-month branch: when the 0062 helper returns
      `kind: 'first-full-month'`, the stakeholder summary
      renders a softer "your fleet is in its first full
      month - the first monthly summary will land at the
      start of next month" prose. Per LESSONS 2026-06-11
      drive the branch via `_renderStakeholderSummaryFor
      Tests(payload, { kind: 'first-full-month' })`. Test:
      seed a one-month-old fleet (per LESSONS 2026-06-15
      on first-meaningful-month pivot - the seed clears the
      0062 first-full-month threshold); assert the
      rendered HTML contains the warming-up framing AND
      no "<N> features shipped" number.

- [ ] Empty-month / warming-up branch: when the 0062
      helper returns `kind: 'warming-up'` (fewer than 8
      trailing weeks of PR data per 0062's global gate),
      the stakeholder summary renders a non-numeric
      "your fleet is just getting started - check back
      after a couple of months" framing. Per LESSONS
      2026-06-15 on per-candidate fixtures - the
      stakeholder test fixture EXPLICITLY seeds <8 weeks
      of PR data to clear the warming-up branch. Test:
      seed 3 weeks of PR data; assert the rendered HTML
      contains `data-testid="stakeholder-warming-up"`
      and no "<N> features shipped" number.

- [ ] Operator name fallback: when `config.operator?.
      displayName` is undefined (the 0065 config field
      not set), the headline renders as "your autonomous
      agent fleet" (NOT "<undefined>'s fleet" or
      "anonymous's fleet"). Test: render with
      `operatorName: undefined` AND with
      `operatorName: 'Mutaaf'`; assert each headline.

- [ ] CTA is informational only: the "<N> PRs waiting
      for review" line renders as plain text, NOT a
      hyperlink (this is a stakeholder surface; no
      internal links). When N === 0, the CTA line is
      omitted entirely. Test: render with 2 open agent
      PRs (per the existing 0017 inbox seed shape);
      assert the CTA text appears AND contains NO
      `<a href=` tag. Render with 0 open agent PRs;
      assert the CTA line is omitted.

- [ ] Token issuance via existing CLI / portal seam:
      the operator creates a stakeholder URL via the
      existing 0013 snapshot CLI command (e.g.
      `fleetctl snapshot create --kind stakeholder-
      monthly --name "co-founder summary"`) OR via the
      portal's existing snapshot UI. The new
      `--kind stakeholder-monthly` argv flag wires
      through to the existing snapshot writer. NO new
      CLI subcommand. PRODUCER-VS-SPEC NOTE: grep
      `bin/fleetctl.ts` for the existing `snapshot
      create` argv shape - extend with the new kind
      flag, do NOT introduce a parallel subcommand.
      Test: invoke the existing snapshot CLI with the
      new kind flag; assert a row lands in `snapshot`
      with `kind = 'stakeholder_monthly'` AND the
      returned URL hits the new route shape.

- [ ] Home-page one-time CTA card: `src/views.ts`
      `homeOverview` (or equivalent per the existing
      home composer) grows a NEW dismissable inbox-
      shaped card `{ kind: "stakeholder_url_invite",
      title: "share a monthly summary with someone
      outside your laptop", payload_id: "static-v1"
      }` that fires WHEN (a) operator has shipped >= 3
      PRs lifetime AND (b) no stakeholder_monthly
      snapshot exists yet AND (c) the operator has
      not already dismissed this kind. Per LESSONS
      2026-06-15 on first-month / zero-denominator
      pivot - the firing threshold uses LIFETIME PR
      count (a fleet that has shipped < 3 PRs hasn't
      got enough story yet). Test: seed 5 merged PRs +
      no snapshot row; assert the card appears in
      home overview. Dismiss the card via the existing
      0017 dismiss helper; advance the fixture and
      re-render; assert the card does NOT re-appear.

- [ ] Cache + invalidation: the stakeholder summary
      payload is memo-cached for 5 minutes (the
      stakeholder visits less often than the operator;
      a slightly longer cache is fine). The cache
      keyed by token. Per LESSONS 2026-06-07 the
      invalidation tuple uses `(MAX(pr.fetched_at),
      COUNT(*) FROM pr, MAX(run.ended_at), COUNT(*)
      FROM run)`. Per LESSONS 2026-06-05 the
      invalidation hook lives on
      `globalThis.__fleet_stakeholder_summary_
      invalidate__` and is registered from
      `src/server.ts` on module load; `runIngestPass`
      reads it lazily. Test: render the summary, seed
      a new merged PR, assert the next render
      reflects the new count within the next
      invalidation tick.

- [ ] tsc --noEmit clean. No new runtime deps. No
      shell-string composition. The new
      `/share/stakeholder/*` route is NET-NEW (no
      JSON shape break to existing routes). The
      `snapshot.kind` column already exists (per
      0013 schema); the new value `'stakeholder_
      monthly'` extends the existing enum WITHOUT
      schema migration. PRODUCER-VS-SPEC NOTE: grep
      `src/db.ts` for the existing `snapshot` table
      schema to confirm the `kind` column is TEXT
      with no CHECK constraint that would block the
      new value. Per LESSONS 2026-06-11 character-
      window source greps - the new helper's leading
      comment block uses PLAIN PROSE (no backticks)
      for sibling-helper-grep-vulnerable identifiers.

## Out of scope

- AUTOMATED EMAIL DELIVERY (the operator typing the
  URL into their own email client is the v1 - a
  monthly auto-email would require SMTP config +
  new runtime deps + per-instance scheduling that
  the zero-dep posture is hostile to).
- A WEEKLY stakeholder cadence. v1 is monthly. A
  weekly cadence would compete with 0037 Friday
  wrap for operator attention and confuse the
  stakeholder.
- A MULTI-STAKEHOLDER mechanic (different signed
  URLs per stakeholder, each with different scope).
  v1 is one token per operator; the operator who
  wants two stakeholders issues two tokens manually
  via 0013 CLI.
- A REPLY / COMMENT surface (the stakeholder leaves
  a note that surfaces to the operator). v1 is read-
  only.
- INCLUDING NUMERIC $ AMOUNTS. The cross-fleet
  framing is "agents run on a Max subscription, $
  is relative not invoiced". A stakeholder reading
  "your fleet spent $48.21 this month" is
  misleading; the v1 omits $ entirely in favour of
  "hours saved" and "features shipped".
- A WEEKLY DIGEST EMAIL. 0012 is the operator-
  facing weekly digest; this is the stakeholder-
  facing monthly summary - different audience,
  different cadence, different vocabulary.
- A PROFILE PHOTO / AVATAR for the operator. Per
  0065's out-of-scope.
- A DASHBOARD WIDGET ("how is your fleet doing")
  for the stakeholder. v1 is a single static
  monthly page; a real dashboard would invite
  per-stakeholder accounts which collapse the
  whole zero-dep posture.

## Engineering notes

- `src/views.ts` - new helper
  `stakeholderMonthlySummary(db, config, now)` and
  a PURE composer
  `composeStakeholderProse(retroPayload,
  operatorName)`. The composer is a small library
  of phrase templates keyed off the numeric shape;
  NO new SQL, NO LLM, NO runtime deps. The helper
  REUSES the 0062 `fleetMonthlyRetro` SQL surface
  + adds the operator-config fallback. Per LESSONS
  2026-06-13 stays inside views.ts (no new module,
  no cycle risk).
- `src/views.ts` -
  `_renderStakeholderSummaryForTests(payload, opts)`
  exposes the kind branches (first-full-month,
  warming-up, full-month) directly per LESSONS
  2026-06-11.
- `src/server.ts` - new public route `GET /share/
  stakeholder/<token>` mounted BEFORE the `/api/`
  auth gate. Per LESSONS 2026-06-15 the static-
  grep ordering assertion anchors on
  `if (path.startsWith("/api/"))`. Per LESSONS
  2026-06-05 the route's memo cache uses
  `globalThis.__fleet_stakeholder_summary_
  invalidate__`.
- `src/snapshots.ts` (or the existing 0013 module
  per the actual filename) - extend the
  `kind` column to accept the new value `'stake
  holder_monthly'`. The existing token-creation
  helper takes a `kind` parameter; pass it
  through. No schema migration (the column is
  already TEXT).
- `bin/fleetctl.ts` - extend the existing
  `snapshot create` argv with `--kind` (default:
  the existing kind). When `--kind=stakeholder-
  monthly`, the issuer prints the resolved URL
  shape `<host>/share/stakeholder/<token>`. NO
  new subcommand.
- `src/views.ts` `homeOverview` (or equivalent) -
  ADD the new dismissable card per AC8. PRODUCER-
  VS-SPEC NOTE: grep `src/inbox.ts` for the
  existing dismissable card composition helper
  before authoring the new kind. Reuse the
  composer.
- `tests/stakeholder-summary.test.ts` (new) - one
  `test(...)` per AC checkbox. Per LESSONS
  2026-05-29 every test pins `now` and seeds
  timestamps off the same anchor. Per LESSONS
  2026-06-11 the branch tests use the renderer-
  direct seam, NOT cwd config mutation.
- `web/app.js` - NO new SPA surface (the
  stakeholder page is server-rendered HTML). The
  one-time home-page card uses the existing 0017
  inbox dismiss helper, no new JS.
- `README.md` - one new subsection "Stakeholder
  monthly summary" under the share-token family
  documents the kind flag, the URL shape, and the
  stakeholder framing.
- Schema migration: NO. The new value extends an
  existing TEXT column.
- No new runtime deps. Pairs with 0013 (signed
  token infra), 0062 (monthly retro - source of
  the aggregate), 0065 (operator name fallback),
  0017 (one-time card dismissal), 0064 (rate-
  limit prefix).

## Implementation log

- 2026-06-17 impl-dev: opened feat/0066-stakeholder-monthly-summary off
  main. Pre-flight grep of the repo for the spec's promised seams:
  - 0062 helper actually exports as `monthlyRetroCard(db, now)` in
    `src/retro.ts` (NOT `fleetMonthlyRetro` per the spec; matches the
    ticket's PRODUCER-VS-SPEC note). The retro module imports ONLY
    from `src/db.ts` so a new `views.ts` -> `retro.ts` edge is cycle-
    safe (LESSONS 2026-06-13).
  - The existing `snapshot` table (src/db.ts:173) does NOT carry a
    `kind` column - the ticket's "the column is already TEXT" claim
    is wrong. Adding `ALTER TABLE snapshot ADD COLUMN kind TEXT` to
    the openDb migration block so legacy rows tolerate NULL (treated
    as the default "fleet_view" kind by lookup helpers).
  - The existing `serveShare(db, token)` regex is `^/share/([0-9a-fA-F]+)$`
    so `/share/stakeholder/<token>` does NOT collide; the new route
    is mounted BEFORE the existing matcher.
  - `cfg.operator.displayName` is the field the headline reads per
    AC6 (the 0065 config field).
- 2026-06-17 impl-dev: shipped behind 17 tests (one per AC + AC9
  fan-out into three branches + AC11 fan-out across deps / schema).
  Implementation summary:
  - `src/db.ts`: ALTER TABLE snapshot ADD COLUMN kind TEXT.
  - `src/snapshot.ts`: SnapshotCreateOpts grows an optional
    `kind: "stakeholder_monthly"` field; the writer persists it and
    emits a `/share/stakeholder/<token>` URL when set. New
    `getStakeholderSnapshot()` helper filters by kind so a legacy
    /share/<token> route 404s on a stakeholder token (and vice
    versa).
  - `src/views.ts`: new `stakeholderMonthlySummary(db, cfg, now)` +
    `composeStakeholderProse(payload, name, opts)` +
    `renderStakeholderSummaryPage` + the
    `_renderStakeholderSummaryForTests` seam + the
    `stakeholderInviteCard` helper for the home-page one-time card.
    All pure on inputs; LESSONS 2026-05-29 time-pinned discipline
    honoured.
  - `src/server.ts`: GET /share/stakeholder/<token> mounted BEFORE
    the `if (path.startsWith("/api/"))` auth gate. 5-min memo cache
    keyed by token, bust tuple = `(MAX(pr.fetched_at), COUNT(*) FROM
    pr)` per LESSONS 2026-06-07. globalThis-slot invalidation hook
    (`__fleet_stakeholder_summary_invalidate__`) per LESSONS
    2026-06-05.
  - `bin/fleetctl.ts`: existing `snapshot create` subcommand grows
    a `--kind=stakeholder-monthly` argv flag (translated to the
    schema's `stakeholder_monthly` enum). NO parallel subcommand.
  - `src/control.ts`: the existing `snapshot-create` action passes
    `kind` through to createSnapshot.
- 2026-06-17 impl-dev: full local gate green
  (npx tsc --noEmit clean; node scripts/check-backlog.mjs clean;
  17/17 new tests pass; full `node --test tests/*.test.ts` only
  carries pre-existing fails on `main` - streak + welcome subprocess
  timeouts under parallel load + operator-profile boot races per
  LESSONS 2026-06-11). Per LESSONS 2026-05-29: pre-existing fails
  that are NOT in the gating typecheck/validate set are documented
  and left alone.
