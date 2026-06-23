---
id: 0074
title: First-week new-operator coach card on the portal home - one day-tailored micro-tip per day for the first 7 days after install (set publicHost / try fleetctl share / pair your phone / open one PR autonomously / read your first cross-fleet lesson / pick a daily glance time / export your first portfolio) so the new operator who installed yesterday crosses every activation cliff before the friction sets in and the daily-check-in rhythm becomes a habit before day 7
status: in-progress
priority: P1
area: portal
created: 2026-06-23
owner: gtm-innovation
---

## User story

As a new fleet operator who installed fleet-control yesterday, ran
`fleetctl onboard` per 0046 (which got me to "first ingested project"
in 3 minutes), and now have an EMPTY-FEELING portal home that doesn't
quite know me yet (the project cards are warming up, the lessons
ledger is empty, the receipts page would be hilarious if I shared it
today) - who would have LOVED a single home-page card this morning
reading "day 2 of your fleet - try `fleetctl share pulse` (it copies
a paste-ready blurb to your clipboard); takes 5 seconds" with a tiny
"got it" button that dismisses it for today and queues tomorrow's
day-3 tip, but who today gets NOTHING after onboarding (every
existing home card 0033 / 0037 / 0038 / 0043 / 0055 / 0059 / 0062
fires on patterns the new operator's empty fleet doesn't satisfy
yet), I want a single day-tailored coach card visible ONLY on days
1-7 since `install_date` carrying ONE specific micro-action per day
(day 1 = set `operator.publicHost`; day 2 = try `fleetctl share
pulse`; day 3 = pair your phone via the LAN QR per 0032; day 4 =
watch an autonomous PR merge end-to-end; day 5 = open your first
cross-fleet lesson; day 6 = pick a daily-glance time; day 7 = run
`fleetctl export portfolio` per 0070) so the new operator who would
have churned at day 4 (the "I installed it but I don't know what to
DO with it" cliff) gets a SINGLE friendly nudge per day that turns
the empty-feeling home into a 7-day activation runway, and the
daily-check-in rhythm becomes a habit BEFORE the operator hits the
0071 reactivation-push threshold (which assumes the operator is
already a regular).

## Why now (four lenses)

### Product Owner

0046 ships the install-time wizard. 0024 ships the first-run welcome
checklist printed AFTER `fleetctl serve` cold-starts. 0032 ships the
LAN-pairing QR banner. 0071 ships the reactivation push for operators
absent 5+ days. EVERY existing onboarding surface fires ONCE on the
install or first boot - none of them is a DAILY COMPANION across the
first week when the new operator most needs a "what should I try
next?" nudge. The activation cliff is real and well-documented in
every developer-tool product: the 7-day retention curve drops
steeply at day 2-4 because the operator hits the "I installed it,
the cards are empty, I'm not sure what to do" moment - and without
a coaching surface that operator just stops opening the portal.

The smallest meaningful unit of value: ONE new helper +
ONE conditional home-page card + ONE small library of 7 hard-coded
micro-tip templates + ONE dismissal axis (per-day, not per-week).

1. **Detect the new-operator window**: a new helper
   `newOperatorCoachTip(db, cfg, now)` in `src/views.ts`
   returns `{ kind: 'coach' | 'graduated' | 'none',
   day: 1 | 2 | 3 | 4 | 5 | 6 | 7, headline: string,
   action: string, ctaLabel: string, deepLink: string,
   asOf: string, version: 1 }`. The window opens when the
   `operator_install_milestones.install_date` row (per 0072
   - PRODUCER-VS-SPEC NOTE: 0072 introduces the table; if
   0072 hasn't shipped yet, this ticket inherits the
   table creation and the conditional ordering implies
   0072 ships first per the index ordering) is < 7 days
   old AND there exists ANY ingested project. The
   window closes (kind = 'graduated') when day > 7 OR
   the operator has dismissed coaching entirely via the
   `cfg.coach?.disabled` opt-out OR the operator has
   crossed BOTH milestones (set publicHost + run a CLI
   share command) in advance of the day-7 graduation.

2. **The 7-day micro-tip library**: hard-coded
   deterministically in a small array inside views.ts.
   PURE on its inputs. NO LLM. Each entry:
     - day 1: "set `operator.publicHost` so your share
       links become absolute URLs" - deep-links to a
       short README anchor `#operator-publichost`.
     - day 2: "try `fleetctl share pulse` (it copies a
       paste-ready blurb to your clipboard)" - deep-
       links to `#fleetctl-share`.
     - day 3: "pair your phone - scan the LAN QR from
       the home welcome banner per 0032" - deep-links
       to `#lan-access-auth`.
     - day 4: "watch a PR merge end-to-end - the next
       autonomous PR your fleet opens will surface
       here with one-tap approve" - deep-links to the
       inbox surface 0017.
     - day 5: "read your first cross-fleet lesson" -
       deep-links to `/lessons-public/<top-cited-
       lesson-slug>` (if any) OR the rotating lesson
       widget 0063 OR a static README anchor.
     - day 6: "pick your daily glance time - set
       `cfg.quietHours` so non-critical pushes
       respect your sleep window per 0030" - deep-
       links to `#quiet-hours`.
     - day 7: "run `fleetctl export portfolio` per
       0070 to capture this week's portable
       artifact" - deep-links to `#fleetctl-export`.
   Per LESSONS 2026-06-15 on character-shaped
   operator-facing copy, the tone is friendly and
   lowercase (a friend's text, not marketing).

3. **The home-page card**: the existing home handler
   grows ONE NEW conditional card rendered ONLY when
   `newOperatorCoachTip(db, cfg, now).kind === 'coach'`
   AND the operator has NOT dismissed THIS day's tip
   (per the `inbox_dismissal(kind, project_slug,
   payload_id)` PK per LESSONS 2026-05-28 -
   PRODUCER-VS-SPEC NOTE: grep `src/db.ts` for the
   actual table-name casing). The card carries
   `data-testid="new-operator-coach-card"` and
   `data-testid="coach-day-<N>"` where N is the day.
   The dismissal button POSTs to the existing
   `inbox_dismissal` infra with `kind = 'coach_tip'`
   AND `payload_id = 'day_<N>'`.

4. **The graduation moment**: when day > 7 the card
   transforms ONCE into a graduation card "you've
   completed your first week - your fleet is now in
   the regular daily-glance rhythm; the home page is
   yours from here" with NO further tips. The
   graduation card is dismissable like the others;
   once dismissed, the card never re-appears.

5. **The opt-out**: a new optional config field
   `cfg.coach?: { disabled?: boolean }` short-circuits
   the helper at evaluation. The defaulting pattern
   matches the 0071 `reactivationPush.disabled`
   precedent.

PRODUCER-VS-SPEC NOTE per LESSONS 2026-06-05: the
implementing dev MUST grep `src/views.ts` for the
existing inbox-card render helpers (per 0017 / 0033 /
0062) AND the existing `inbox_dismissal` table's
column casing per LESSONS 2026-05-28. The coach card
is a CONDITIONAL render in the home handler, NOT a
new inbox kind (the inbox surface per 0017 is for
PR-shaped items; the coach card is a separate
home-page block). Per LESSONS 2026-06-13 the helper
lives INSIDE `src/views.ts` (no new module - the
helper is a pure date-arithmetic + hardcoded-tip
lookup with no SQL beyond the existing
`operator_install_milestones` read per 0072 AND the
`inbox_dismissal` read per 0017). Per LESSONS
2026-06-13 the per-candidate test fixture must
satisfy the global empty-fleet gate where applicable
- the coach-day-4 fixture seeds an open PR so the
deep-link reference resolves; the coach-day-5
fixture seeds a lessons archive entry so the
deep-link target exists.

### Stakeholder

Widens the moat on the FIRST-WEEK ACTIVATION axis
where the cross-fleet pattern is universally
documented and where fleet-control today has the
WEAKEST signal-response coverage. The reasoning:

- Every existing home card (yesterday-glance,
  Friday wrap, Monday catch-up, biggest-surprise,
  monthly retro) assumes the operator has WEEKS of
  data behind them. A new operator on day 2 sees
  every one of those cards in their empty-state /
  warming-up framing - which is HONEST but
  COLD. The empty-state framings tell the new
  operator "your fleet is warming up" but don't
  tell them WHAT TO DO IN THE MEANTIME.
- The first-7-days surface is the SINGLE point in
  the operator's lifetime where the right
  intervention multiplies retention by 3-5x and
  the wrong intervention (silence) churns them.
  Every other retention surface (anniversary,
  reactivation push, stakeholder URL) compounds
  AFTER the operator is already a regular - they
  cannot SAVE the day-4 dropout.
- The coaching surface is structurally only
  buildable by a LOCAL tool that knows the
  install date with second-precision (the
  `operator_install_milestones.install_date` per
  0072 is the source of truth). A hosted tool's
  account-creation date isn't the same thing -
  it's when the customer signed up for the
  hosted vendor, not when they started doing
  autonomous-agent work locally.

The hosted-competitor structural gap: hosted
observability tools ship in-app onboarding tours
("step 1: connect your repo, step 2: see your
first event") that fire ONCE. They cannot ship
a 7-day daily-cadence coach because their
business model is a per-seat subscription that
already monetises the first session - their
incentive is to maximise immediate engagement,
not slow-burn activation. fleet-control's
incentive is RETENTION OVER MONTHS (the
operator's repeated daily-glance habit), so the
slow-burn coach is aligned with the moat.

The "show me" moment worth a screenshot: a
Bluesky post from an operator's day-7 graduation
"I love that fleet-control nudged me with one
small thing per day for a week - by day 7 I had
set publicHost, paired my phone, run my first
share, and watched two autonomous PRs land
without intervention. this is what onboarding
should feel like". Every reader recognises the
contrast with the 47-step SaaS onboarding tour.

Per the cross-fleet courtiq lesson "the
first-week activation curve is the single
highest-leverage retention surface for any
developer tool - one well-placed nudge per day
for 7 days lifts month-2 retention by 40-60%
because the operator has CROSSED the activation
cliff by the time the daily-glance pattern
becomes natural" (CROSS_LESSONS section
courtiq Entries 2026-05-21 family on first-
week-activation-leverage), the coach card is
exactly the slow-burn activation surface
fleet-control has not yet shipped.

A subtle moat property: the coach surface
cannot be back-filled. An operator on day 30 who
never saw the day-3 nudge has already paid the
churn risk for that day; the surface only
operates DURING the activation window. The
window is permanent infrastructure but its value
flows entirely from being SHOWN AT THE RIGHT
MOMENT - which only the local tool with the
install date can deliver.

Pairs with 0046 (onboard wizard - the install
moment), 0024 (first-run welcome - the boot
moment), 0032 (LAN QR - the day-3 tip's deep-
link target), 0017 (inbox - the day-4 tip's
deep-link target), 0063 / 0055 (lesson rotator
- the day-5 tip's target), 0030 (quiet hours -
the day-6 tip's config target), 0067 (share
CLI - the day-2 tip's CLI target), 0070
(portfolio export - the day-7 tip's CLI
target), 0072 (install_date table -
prerequisite), 0071 (reactivation push - the
coach hands off to the reactivation surface
at day 7+).

### User (operator at 9am, looking at the portal)

Three operator scenarios:

1. **The new operator on day 2** (the target
   persona): the operator installed fleet-control
   yesterday, opens the portal at 9am, sees a
   single warm card at the top "day 2 of your
   fleet - try `fleetctl share pulse` (it copies
   a paste-ready blurb to your clipboard); takes
   5 seconds". They tap the "open in terminal"
   CTA (a copy-able command line per the existing
   share CLI 0067 deep-link). They try it. They
   feel competent. Day 3 surfaces tomorrow.

2. **The day-8-and-beyond operator** (zero
   impact): the operator opens the portal on day
   8, sees ZERO coach card. The card has either
   shown its 1-time graduation message and been
   dismissed, OR the operator has crossed the
   day-7 boundary and the helper short-circuits
   to `kind: 'graduated'` which renders nothing
   if previously dismissed. The portal is back
   to its non-coach steady state.

3. **The opt-out operator** (the explicit no):
   the operator who finds coaching tips
   patronising sets `cfg.coach?.disabled = true`
   in `fleet-control.config.json`. The helper
   short-circuits at evaluation; no card ever
   renders. Per the 0071 reactivation precedent
   the opt-out is config-file-only (no UI knob)
   to keep the home page uncluttered.

Per LESSONS 2026-06-11 the renderer-direct seam
`_renderCoachCardForTests(payload, opts)`
exercises the 7 day-tip branches + graduated +
opted-out branches without cwd config mutation.
The boot-path test exercises the integration
shape (card present on day N, dismissable, then
absent on next render).

### Growth

The growth bet: the first-week activation curve
is the single highest-leverage retention
surface for ANY developer tool, and
fleet-control today has zero coverage of it.
Per the cross-fleet courtiq lesson "the
first-week activation curve is the single
highest-leverage retention surface for any
developer tool - one well-placed nudge per day
for 7 days lifts month-2 retention by 40-60%
because the operator has CROSSED the activation
cliff by the time the daily-glance pattern
becomes natural" (CROSS_LESSONS section courtiq
Entries 2026-05-21 family on first-week-
activation-leverage, AND the digitalcraft
section's 2026-05-25 family on
explicit-action-versus-empty-state framing),
the coach card converts the activation cliff
into a 7-day runway.

A second growth surface: the SHARED screenshot.
The graduation card (day 7+) is implicitly
shareable - "I just completed week 1 of
fleet-control, here's what my new fleet looks
like" is a natural Bluesky / LinkedIn post and
the screenshot's caption sells the
slow-burn-onboarding moat. The cross-fleet
courtiq pattern on slow-burn activation as a
competitive narrative ("hosted tools demand
your attention in the first session;
fleet-control earns it over a week") applies.

A third compounding surface: the coach card's
day-1 tip is "set `operator.publicHost`" -
which directly enables the 0073 sitemap
ticket's cold-discovery acquisition. A new
operator who sets publicHost on day 1
contributes to the public-surface SEO
footprint within their first week of
ownership. The retention surface and the
acquisition surface compound.

Per the cross-fleet courtiq lesson "the
SEQUENCE of activation tips matters more than
the COUNT - day 1 should be the smallest-effort
config win (publicHost is one line), day 2-4
should be the shareable wins, day 5-7 should be
the habit-shaped wins (quiet hours, portfolio,
lessons)" (CROSS_LESSONS courtiq Entries
2026-05-21 family on activation-sequence
design), the 7-day order in this ticket
deliberately escalates from low-effort to
habit-forming.

Pairs with 0046 / 0024 / 0032 / 0017 / 0063 /
0030 / 0067 / 0070 / 0072 / 0071.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] New helper `newOperatorCoachTip(db, cfg, now)`
      in `src/views.ts` returns `{ kind: 'coach' |
      'graduated' | 'none', day: 1 | 2 | 3 | 4 | 5 |
      6 | 7, headline: string, action: string,
      ctaLabel: string, deepLink: string, asOf:
      string, version: 1 }`. The helper reads the
      `operator_install_milestones.install_date` row
      (per 0072's table). When no row exists, falls
      back to MIN(pr.fetched_at) WHERE is_agent=1
      AND state='MERGED' per LESSONS 2026-06-05 (per
      LESSONS 2026-06-07 the `pr` table has no
      surrogate id; MIN(fetched_at) is the safe
      proxy). Day is computed as `Math.floor((now -
      installDate) / 86400000) + 1`. The 7 hard-
      coded tips live in a const at the top of the
      helper. Test: seed install_date 2 days ago;
      assert kind === 'coach', day === 3 (day 1 was
      install day; day 3 is 2 days after install).
      Seed install_date 10 days ago; assert kind ===
      'graduated'. Seed `cfg.coach?.disabled = true`;
      assert kind === 'none'.

- [ ] Dismissal gate: when an `inbox_dismissal` row
      exists with `kind = 'coach_tip'` AND
      `payload_id = 'day_<N>'` for the current day
      AND `project_slug = ''` (empty - the coach is
      fleet-wide, not per-project), the helper
      returns kind = 'none' AND the home card is
      OMITTED. Per LESSONS 2026-05-28 the gate is a
      365-day soft window per the existing
      `inbox_dismissal` precedent. PRODUCER-VS-SPEC
      NOTE: grep `src/db.ts` for the
      `inbox_dismissal` column casing. Test: seed
      install_date 2 days ago AND an inbox_dismissal
      row with `kind = 'coach_tip'`, `payload_id =
      'day_3'`; assert kind === 'none'. Dismiss day
      3 but advance now by 24h; assert kind ===
      'coach', day === 4 (the day-3 dismissal does
      not cascade).

- [ ] The 7 tip templates: each day has a fixed
      `headline`, `action`, `ctaLabel`, `deepLink`.
      The deepLink for day 1 is a README anchor
      `#operator-publichost`; day 2 is
      `#fleetctl-share`; day 3 is `#lan-access-
      auth`; day 4 is the `/#/` inbox section;
      day 5 is `/lessons-public/<topSlug>` (when
      `lessonsPublicArchive(db, now)` returns a
      top entry) OR `/lessons-public/` (fallback);
      day 6 is `#quiet-hours`; day 7 is
      `#fleetctl-export-portfolio`. PRODUCER-VS-
      SPEC NOTE per LESSONS 2026-06-05: grep the
      existing README anchors before authoring;
      the README anchor names must match the
      actual headings shipped per 0046 / 0032 /
      0030 / 0067 / 0070. Test: invoke the helper
      for each day 1-7; assert the returned
      headline / action / ctaLabel / deepLink
      contain the day-specific keywords (day 2
      contains "share"; day 6 contains "quiet
      hours"; etc).

- [ ] Day-5 deep-link fallback: when
      `lessonsPublicArchive(db, now)` returns 0
      entries, the day-5 tip's deepLink falls
      back to `/lessons-public/` (the index page
      per 0057) which renders the
      `data-testid="lessons-public-warming-up"`
      empty state. When 1+ entries exist, the
      deepLink targets the slug of the
      top-cited entry per the 0052
      `lessonSavingsRollup` ordering. Test: seed
      0 lessons; assert deepLink === '/lessons-
      public/'. Seed 3 lessons with varying
      cite counts; assert deepLink ===
      '/lessons-public/<top-cited-slug>'.

- [ ] Home-page card: the existing home handler
      in `src/server.ts` (per the 0062 home card
      precedent) grows ONE NEW conditional render
      block emitting the coach card ONLY when
      `newOperatorCoachTip(db, cfg, now).kind ===
      'coach'`. The card carries `data-testid=
      "new-operator-coach-card"` AND `data-
      testid="coach-day-<N>"` where N is 1-7. The
      dismiss button POSTs to a new endpoint
      `POST /api/coach/dismiss` carrying
      `{ day: N }` which writes the
      `inbox_dismissal` row. PRODUCER-VS-SPEC
      NOTE: grep `src/server.ts` for the existing
      `POST /api/inbox/dismiss` precedent and
      mirror its handler shape. Test: render home
      with kind = 'coach', day = 2; assert both
      testids present. POST to the dismiss
      endpoint; assert 200 + the inbox_dismissal
      row landed. Re-render home; assert the
      coach card ABSENT.

- [ ] Graduation card: when
      `newOperatorCoachTip` returns kind ===
      'graduated' AND no prior dismissal exists
      for `payload_id = 'graduation'`, the home
      handler renders a ONE-TIME graduation card
      "you've completed your first week" carrying
      `data-testid="coach-graduation-card"`.
      Dismissing it writes
      `inbox_dismissal(payload_id =
      'graduation')`. Re-render: ABSENT. Test:
      seed install_date 10 days ago; render
      home; assert the graduation testid PRESENT.
      Dismiss; re-render; assert ABSENT.

- [ ] Opt-out gate: when `cfg.coach?.disabled ===
      true`, the helper returns kind === 'none'
      AND no card renders (neither coach nor
      graduation). Test: seed install_date 2 days
      ago AND `cfg.coach = { disabled: true }`;
      assert kind === 'none' AND no testid in
      the home render.

- [ ] Config field: new optional
      `cfg.coach?: { disabled?: boolean }`
      field in `src/config.ts`'s FleetConfig.
      Defaulting pattern matches the existing
      0071 `reactivationPush?.disabled` and
      0064 `embedRateLimit?` nested fields.
      Test: per LESSONS 2026-06-19 spawn a
      subprocess pinned to a tmpdir cwd via
      `spawnSync` to drive `loadConfig()` with
      a `fleet-control.config.json` carrying
      the field; assert it parses. NEVER write
      to the test runner's shared cwd.

- [ ] Renderer-direct seam: per LESSONS 2026-06-11
      `_renderCoachCardForTests(payload, opts)` is
      the renderer-direct seam for the 7-day
      branches + graduated + quiet-hours
      branches. Test: drive the seam with each of
      9 payloads (day 1-7 + graduated + none);
      assert the expected testid and the absence
      of the others. The seam does NOT mutate
      cwd config.

- [ ] No-install-date fallback: when
      `operator_install_milestones.install_date`
      is missing AND the `pr` table is non-empty,
      the helper synthesises an install_date from
      `MIN(pr.fetched_at)` per LESSONS 2026-06-05
      AND writes the row via the existing
      `_recordInstallDateIfMissing(db, now)` from
      0072. When BOTH are empty (truly fresh
      install with no ingested PRs yet), the
      helper returns kind === 'none'. Test: seed
      a DB with 0 install_date and 5 PRs the
      oldest of which is 3 days ago; assert kind
      === 'coach', day === 4. Seed empty DB;
      assert kind === 'none'.

- [ ] Per-candidate fixture clears global gates:
      per LESSONS 2026-06-13 each per-day test
      fixture seeds enough trailing data that
      the day-specific deep-link target
      resolves. Day-5's fixture seeds at least
      one lessons-public entry. Day-4's fixture
      seeds at least one open agent PR so the
      inbox link is non-empty. Test: invoke the
      day-5 helper against an empty fleet;
      assert deepLink === '/lessons-public/'
      (the fallback). Invoke against a fleet
      with 3 lessons; assert deepLink ===
      '/lessons-public/<top-cited-slug>'.

- [ ] Cache + invalidation: the
      `newOperatorCoachTip` payload is memo-cached
      for 60s keyed by `(installDate, day,
      dismissalCount, lessonsTopSlug)`. Per LESSONS
      2026-06-07 the invalidation tuple includes
      `(COUNT(*) FROM inbox_dismissal WHERE kind =
      'coach_tip')` so a fresh dismissal busts the
      cache. Hook on
      `globalThis.__fleet_coach_invalidate__`
      registered from `src/server.ts` on module
      load per LESSONS 2026-06-05. Test: render
      with day 3; insert a coach_tip dismissal
      row; assert the next render returns kind =
      'none' within the next invalidation tick.

- [ ] tsc --noEmit clean. No new runtime deps -
      lean on the existing `inbox_dismissal`
      writer, `operator_install_milestones`
      reader (per 0072), `lessonsPublicArchive`
      / `lessonSavingsRollup` (per 0057 / 0052)
      helpers. No shell-string composition. No
      JSON-shape break - the new `POST
      /api/coach/dismiss` endpoint is NEW + the
      new `coach_tip` inbox_dismissal kind
      extends the existing TEXT column. No
      schema migration (0072 already adds
      `operator_install_milestones`). Per
      LESSONS 2026-05-26 no backticks inside
      template-literal SCHEMA strings. Per
      LESSONS 2026-06-11 character-window
      source greps - the new helper's leading
      comment block uses PLAIN PROSE for
      sibling-helper-grep-vulnerable
      identifiers. Per LESSONS 2026-06-13
      per-candidate fixtures clear the global
      empty-fleet gate AND the day-specific
      deep-link target. Per LESSONS 2026-06-19
      any test that drives `loadConfig()` for
      the `cfg.coach` field runs the parser in
      a subprocess pinned to a tmpdir cwd.

## Out of scope

- A 14-DAY or 30-DAY coach window. The
  activation cliff lives in days 2-7; extending
  the window dilutes signal. Future ticket if
  retention data shows otherwise.
- A PERSONALISED tip ordering (the helper picks
  the next-most-relevant tip based on what the
  operator has already done). v1 is a fixed
  day-N order so the surface is predictable and
  the renderer is pure.
- AN LLM-AUTHORED daily tip. The hardcoded
  templates are the moat (no per-render LLM
  call, no editorial labour, deterministic).
- A PUSH NOTIFICATION channel for the coach
  tips. The 0071 reactivation push handles the
  drift case; the coach is portal-only because
  a new operator is BY DEFINITION opening the
  portal during the activation window.
- A SECONDARY tip-of-the-day rotation for
  weeks 2-4. The graduation card hands off
  cleanly to the steady-state portal; the
  operator who wants more lessons opens the
  rotating 0055 / 0063 surfaces.
- A PER-PROJECT coach (separate tips for each
  project the operator has registered). The
  coach is fleet-wide; per-project tips would
  fire 7 cards per day for an operator with
  multiple projects.
- A GAMIFICATION layer (badges for completing
  each day). Per LESSONS 2026-06-15 on
  character-shaped operator-facing copy, the
  tone is a friend's text, not a Duolingo
  streak.
- A COMPLETION RATE telemetry ("the operator
  completed 5 of 7 tips"). Out of scope for
  v1; the operator dismisses each tip when
  they're done with it, and the dismissal
  rows ARE the completion log.
- AN AUTO-CHECK that confirms the operator
  actually DID the day-N action (e.g. day 1
  re-fires if publicHost is still unset on
  day 2). The coach is informational, not
  enforcing; the operator who chose to skip
  publicHost shouldn't be nagged the next
  day.

## Engineering notes

- `src/config.ts` - extend `FleetConfig` with
  the new optional `coach?: { disabled?:
  boolean }` field. Defaulting pattern matches
  the existing `reactivationPush?.disabled`
  (per 0071) and `embedRateLimit?` (per 0064)
  nested fields.
- `src/views.ts` - new helpers
  `newOperatorCoachTip(db, cfg, now)`,
  `renderCoachCard(payload, opts)`,
  `_renderCoachCardForTests(payload, opts)`.
  Per LESSONS 2026-06-13 the helpers live
  INSIDE `src/views.ts` (no new module - the
  helper is pure date arithmetic plus a
  hardcoded tip table plus two existing
  payload reads). The 7-tip table is a
  module-private const at the top of the
  helper block. Per LESSONS 2026-06-05 the
  helper reuses the
  `_recordInstallDateIfMissing(db, now)`
  side-effect introduced by 0072 - if 0072
  hasn't shipped yet (the index ordering
  suggests it ships first), the implementation
  dev inherits the table creation per the
  0072 ticket scope.
- `src/server.ts` - extend the home handler
  with the conditional coach card render. Mount
  the new authenticated endpoint `POST
  /api/coach/dismiss` inside the `/api/` block.
  PRODUCER-VS-SPEC NOTE: grep `src/server.ts`
  for the existing `POST /api/inbox/dismiss`
  handler and mirror its shape. Register
  `globalThis.__fleet_coach_invalidate__` on
  module load per LESSONS 2026-06-05; consume
  it from the `POST /api/coach/dismiss`
  handler after the dismissal write.
- `tests/new-operator-coach-card.test.ts`
  (NEW) - one `test(...)` per AC checkbox
  above. Per LESSONS 2026-05-29 every test
  pins `now` and seeds timestamps off the same
  anchor. Per LESSONS 2026-06-11 branch tests
  use the renderer-direct seam, NOT cwd
  config mutation. Per LESSONS 2026-06-13
  every per-day fixture seeds enough trailing
  data that the day-specific deep-link
  target resolves. Per LESSONS 2026-06-19
  the `cfg.coach.disabled` parser test runs
  in a subprocess pinned to a tmpdir cwd.
- `README.md` - one new subsection "First-week
  coach" under the home-card family documents
  the 7-day cadence and the opt-out config
  field. The README also gains explicit
  anchors `#operator-publichost`,
  `#fleetctl-share`, `#lan-access-auth`,
  `#quiet-hours`, `#fleetctl-export-portfolio`
  (some of these may already exist from
  prior tickets - PRODUCER-VS-SPEC NOTE:
  grep the README for the actual anchor
  names; the coach helper's deepLink table
  must match).
- Schema migration: NO (this ticket reuses
  the `operator_install_milestones` table
  added by 0072 AND the existing
  `inbox_dismissal` table). PRODUCER-VS-SPEC
  NOTE: if 0072 has not yet shipped when
  this ticket reaches implementation, the
  implementing dev MUST stack on top of
  0072 and not duplicate the table
  creation. The backlog index ordering
  places 0072 above 0074 explicitly.
- No new runtime deps. Pairs with 0046
  (onboard), 0024 (welcome), 0032 (LAN QR -
  day-3 target), 0017 (inbox - day-4
  target), 0063 / 0055 (lesson rotator -
  day-5 target), 0030 (quiet hours - day-6
  target), 0067 (share CLI - day-2 target),
  0070 (portfolio export - day-7 target),
  0072 (install_date table - prerequisite),
  0071 (reactivation push - hands off at
  day 7+).

## Implementation log

- 2026-06-23 implementation-dev: branched feat/0074-first-week-coach-card.
  Approach: new helper `newOperatorCoachTip(db, cfg, now)` and
  `_renderCoachCardForTests(payload, opts)` in `src/views.ts`; new
  endpoints `GET /api/fleet/coach` + `POST /api/coach/dismiss` in
  `src/server.ts` with a 60s memo cache invalidated on dismissal via
  `globalThis.__fleet_coach_invalidate__`. New optional config field
  `cfg.coach?: { disabled?: boolean }` extends `FleetConfig`.
  PRODUCER-VS-SPEC reconciliations:
    - The `inbox_dismissal` PK is (kind, project_slug, payload_id) per
      `src/db.ts` line 207. The coach uses `project_slug = 'fleet'` to
      match the existing fleet-wide dismissal convention (anniversary
      uses the same 'fleet' literal at server.ts:1262). The spec said
      `project_slug = ''` (empty) but the existing convention is the
      literal 'fleet'; we use 'fleet' for consistency with anniversary
      dismissals.
    - `lessonsPublicArchive` is sourced from the lessons FILE (no `db`
      argument) - the helper signature in src/lessons.ts is
      `lessonsPublicArchive(opts: { now?: Date; projectAliasMap?: ...})`.
      The day-5 deepLink calls it accordingly. Top-cited slug is derived
      via `lessonCreditRollup`'s `top_earner.lesson_slug`; when both are
      empty the fallback is `/lessons-public/`.
    - README anchors: the existing README has no `#operator-publichost`,
      `#fleetctl-share`, `#lan-access-auth`, `#quiet-hours`,
      `#fleetctl-export-portfolio` headings. Per the ticket's spec
      ("The README also gains explicit anchors") we add a new
      "First-week coach" subsection with five named anchors via
      explicit `<a id=...></a>` tags so the deep-links resolve.
    - Day-3 LAN-pairing target: spec said `#lan-access-auth` but the
      existing README's `## LAN access + auth` markdown auto-anchor is
      `#lan-access--auth` (two hyphens for the "+ "); we add an
      explicit `<a id="lan-access-auth"></a>` to bridge the difference.
