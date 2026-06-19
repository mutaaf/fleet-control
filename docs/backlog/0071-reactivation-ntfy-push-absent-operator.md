---
id: 0071
title: Reactivation ntfy push when the operator has not opened the portal in 5+ days - one Sunday 18:00 nudge with a deep link to a "what you would have missed" digest page so the operator who drifted gets a single character-shaped notification that pulls them back without nagging
status: in-progress
priority: P2
area: observability
created: 2026-06-19
owner: gtm-innovation
---

## User story

As a fleet operator who normally checks the portal every morning,
who had a busy week and did not open it Mon-Fri, who would have
LOVED to see a single nudge Sunday evening reminding me the
agents shipped 6 features I have not seen yet but who today gets
NOTHING (the existing ntfy push notifications per 0009 fire on
high-priority events like budget caps and red CI, not on
attention-drift), I want a single ntfy push delivered Sunday at
18:00 local time ONLY WHEN the portal has not been opened in
5+ days, carrying a character-shaped one-line summary ("you have
not checked in for 7 days; 6 features shipped without you - take
a look") and a deep link to `/digest-missed/<token>` (a new
signed page rendering the period's would-have-missed highlights),
so that the operator who drifts gets ONE personality-laden
notification per absence period instead of either silence (the
current state) or daily nagging (what most retention systems
default to), and the deep link is the reactivation moment that
pulls them back into the daily glance rhythm.

## Why now (four lenses)

### Product Owner

0009 ships the ntfy push channel. 0030 ships quiet-hours
suppression. 0033 / 0037 / 0038 / 0059 / 0062 ship daily / weekly
/ monthly cards on the portal home. EVERY existing notification
channel fires on EVENT signals (a budget cap, a red CI, a stuck
PR). NOTHING fires on ATTENTION signals (the operator hasn't
looked).

The smallest meaningful unit of value: ONE new daemon-tick
helper + ONE new signed-token snapshot kind + ONE new public
page.

1. **Visit tracking** (the signal): a tiny new table
   `operator_visit_watermark(last_visit_at TEXT)` carries one
   row max. The existing portal home page (`GET /`) UPDATEs
   the row on each authenticated visit from the operator
   (loopback or token-bearing). Per LESSONS 2026-05-26 the
   visit-update is gated to NOT fire on the embeddable /
   public surfaces (/embed/, /og/, /share/, /referrals/,
   /operator/, /lessons-public/, /receipts/, /pulse/,
   /calculator/, /failures/, /year/) - those visitors are
   COLD READERS, not the operator. The /api/ family is also
   skipped (the daemon polls it; counting daemon polls as
   operator visits defeats the entire signal).

2. **Daemon Sunday-18:00 evaluator**: a new helper
   `evaluateReactivationPush(db, cfg, now)` is wired into
   the existing daemon-tick (per 0009 / 0030 pattern) and
   checks all of:
     - `now` is Sunday between 17:50 and 18:10 local time
       in the operator's quiet-hours tz (or UTC if no
       quiet-hours tz set);
     - `last_visit_at` is > 5 days ago;
     - quiet-hours is NOT currently active (Sunday 18:00
       falls outside almost everyone's quiet hours, but
       respect it anyway);
     - no prior reactivation push has fired in the LAST
       14 days (dedup so an operator who took a 3-week
       vacation gets one push at the start, not three).
   When ALL conditions hold, the helper mints a signed
   snapshot row of kind `reactivation_digest`, composes a
   character-shaped ntfy message, and POSTs it via the
   existing 0009 `sendNtfy` helper.

3. **The push message**: PURE deterministic shape, NO LLM
   call. Template:
   ```
   you've not checked in for <N> days. <M> features shipped
   without you. take a look: <url>
   ```
   Where N is the days-since-visit (rounded down) and M is
   the merged-PR count over the period (from `pr` WHERE
   `is_agent = 1 AND state = 'MERGED' AND fetched_at >=
   last_visit_at`). The url is `<host>/digest-missed/
   <token>`. Per LESSONS 2026-06-15 on character-shaped
   operator-facing copy the message is intentionally
   lowercase, no "Hi" / "Hello" / "Don't miss out" - the
   tone is a friend's text, not a marketing blast. The
   variant for `M === 0` (the fleet was idle while the
   operator was idle) is "you've not checked in for <N>
   days. the fleet was quiet too. say hi when you can:
   <url>" - acknowledges the silence honestly.

4. **The deep-link page** at `GET /digest-missed/<token>`
   resolves the signed token (per 0013 snapshot infra,
   `kind = 'reactivation_digest'`) and renders a single
   page summarising the period the operator was absent:
     - "since you last checked in (<date>): <M> features
       shipped";
     - the 3 most-significant ships (longest-running PR
       that finally merged + the riskiest open PR that's
       still waiting + the project with the biggest cost
       delta);
     - the 1 cross-fleet lesson the fleet learned in the
       window (top heal-credit from 0042);
     - a single "open your portal" link to the loopback
       URL.
   Per LESSONS 2026-06-15 on first-meaningful-month pivot
   the empty-state branch (period has 0 ships) renders an
   honest "the fleet was quiet while you were away -
   nothing to catch up on" framing.

PRODUCER-VS-SPEC NOTE per LESSONS 2026-06-05: the
implementing dev MUST grep `src/ntfy.ts` for the existing
`sendNtfy(topic, payload)` signature and `ntfyConfigFrom
(cfg)` per 0009. REUSE both; do NOT re-author. The dedup
window of 14 days is enforced via a SELECT against
`snapshot WHERE kind = 'reactivation_digest' AND
created_at >= now - 14 days`. Per LESSONS 2026-06-13 the
reactivation helper lives in `src/views.ts` (no new
module - the helper composes existing payload helpers).
Per LESSONS 2026-06-15 the daemon-tick wiring carries
an offline / opt-out gate: the `cfg.reactivationPush?:
{ disabled?: boolean }` field defaults to enabled; the
operator opts out by setting `disabled: true`.

### Stakeholder

Widens the moat on the GENTLE-RETENTION axis where every
hosted observability tool defaults to NAGGING. The reasoning:

- Hosted tools page operators via email digests / Slack
  webhooks / mobile push on EVERY event because their
  business model is engagement-as-revenue.
- fleet-control's model is OPERATOR-AS-OWNER: the
  operator owns the tool, the data, and the relationship
  with their own attention. The reactivation push fires
  EXACTLY ONCE per drift period, after 5+ days of
  absence, with a 14-day dedup floor.
- The tone of the push is COMRADELY (a friend's text),
  not COMMERCIAL (a SaaS prompt). This is a moat
  property: the operator who got a "hi, the fleet's been
  quiet too" push at the right moment is the operator
  who recommends fleet-control to their friend the next
  week.

The hosted-competitor structural gap: a hosted tool
COULD ship the same dedup math, but its commercial
incentive aligns toward MORE pushes, not fewer. The
zero-dep posture lets fleet-control ship a push channel
the operator trusts because they configured the ntfy
topic themselves; the operator can revoke the topic any
time with no vendor relationship.

The "show me" moment worth a screenshot: a Bluesky post
"I love that fleet-control sent me one (one!) gentle
nudge after a week away instead of 7 daily emails -
this is what a tool that respects me looks like".
Every reader who clicks lands on fleet-control's repo.

Pairs with 0009 (ntfy infra), 0030 (quiet hours),
0013 (snapshot tokens), 0033 / 0037 / 0038 / 0059
(the digest content), 0042 (lesson_credit source),
0064 (rate-limit on the public page).

### User (operator at 9am, looking at the portal)

Three operator scenarios:

1. **The drifted operator** (the target persona): the
   operator opens Bluesky on a Sunday evening at 18:01,
   sees an ntfy notification on their phone "you've not
   checked in for 7 days. 6 features shipped without
   you. take a look: <url>". They tap. The phone opens
   the digest page. They see the 3 most-significant
   ships. They feel re-engaged. Monday morning they
   open the portal again.

2. **The daily-checker operator** (the no-op): the
   operator who opens the portal every weekday morning
   never sees the reactivation push because `last_
   visit_at` is always < 5 days ago. The helper's daemon
   tick is a cheap COUNT(*) read; zero overhead for the
   typical operator.

3. **The opt-out operator** (the explicit no): the
   operator who finds reactivation pushes annoying
   sets `reactivationPush.disabled: true` in
   fleet-control.config.json. The daemon helper checks
   the flag first; never fires. The portal home renders
   no UI for this setting (it's intentionally a
   config-file-only knob to keep the portal home
   uncluttered).

Per LESSONS 2026-06-11 the renderer-direct seam
`_renderReactivationDigestForTests(payload, opts)`
exercises the empty-state / non-empty / quiet-hours
branches without cwd config mutation. The daemon
helper's test drives `evaluateReactivationPush(db,
cfg, now)` directly with seeded snapshot + cfg
combinations.

### Growth

The growth bet: every reactivation push is a SAVE
on an operator who would otherwise have CHURNED
SILENTLY. Per the cross-fleet courtiq lesson "the
cheapest retention save is the operator who drifted
3 weeks ago - they had a relationship with the tool
and a single nudge is the most economical channel
to re-engage" (CROSS_LESSONS section courtiq
Entries 2026-05-21 family on drift-as-leading-
indicator), the reactivation push is the highest-
ROI retention surface fleet-control can ship.

A second growth surface: the SHARED screenshot. An
operator who appreciates the gentle tone of the
push shares the screenshot ("look at this respectful
push - this is what I want from my tools"). The
screenshot is the marketing artifact.

Pairs with 0009 (ntfy), 0030 (quiet hours), 0013
(snapshot infra), 0033 / 0037 / 0038 (digest
content).

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] New table `operator_visit_watermark(last_visit_at
      TEXT, last_user_agent TEXT)` with at most one row.
      Created via `CREATE TABLE IF NOT EXISTS` in
      `src/db.ts`'s SCHEMA template (per LESSONS
      2026-05-26 "no backticks inside template-literal
      SQL strings" - the identifier stays plain). Test:
      open a fresh DB; assert the table exists. Insert
      a row; assert SELECT returns it.

- [ ] New middleware in `src/server.ts` UPDATEs
      `operator_visit_watermark.last_visit_at` to now on
      every request that satisfies ALL of:
        - request path is NOT in the public-surface
          prefix list (NOT /embed/, /og/, /share/,
          /referrals/, /operator/, /lessons-public/,
          /receipts/, /pulse/, /calculator/, /failures/,
          /year/, /digest-missed/);
        - request path is NOT under /api/ (the daemon
          polls /api/ continuously; counting daemon polls
          as operator visits defeats the signal);
        - request is loopback OR carries a valid token
          (per the existing `requireAuth` helper).
      The UPDATE uses INSERT OR REPLACE on a SINGLETON
      row (PK on a constant value like `id INTEGER
      PRIMARY KEY CHECK (id = 1)`) so concurrent updates
      stay consistent. Test: hit `GET /` from loopback;
      assert the watermark row was updated. Hit
      `/embed/pulse.html`; assert the watermark was NOT
      updated.

- [ ] New helper `evaluateReactivationPush(db, cfg,
      now)` in `src/views.ts` returns
      `{ shouldPush: boolean, reason: string,
      payload: ReactivationPushPayload | null }`. The
      shouldPush boolean is true ONLY when ALL of:
        - `now.getDay()` is Sunday (=0 in JS) in the
          operator's quiet-hours tz;
        - `now`'s local-time HH:MM is between 17:50 and
          18:10;
        - `last_visit_at` is non-null AND > 5 days ago;
        - `cfg.reactivationPush?.disabled !== true`;
        - no prior `snapshot WHERE kind = 'reactivation_
          digest' AND created_at >= now - 14 days`
          exists;
        - `quietHoursActiveAnywhere(cfg, now) === false`.
      Test: seed 6 conditions; assert shouldPush true.
      Flip each condition one at a time; assert
      shouldPush false with the corresponding reason.

- [ ] New helper `composeReactivationMessage(payload)`
      in `src/views.ts` returns the deterministic ntfy
      message string. The two branches are
      M-features-shipped (`>= 1`) and the-fleet-was-
      quiet (`=== 0`). PURE on its inputs. Test: invoke
      with `{ daysAway: 7, featuresShipped: 6, url:
      "..." }`; assert the string contains "7 days" AND
      "6 features". Invoke with `featuresShipped: 0`;
      assert "the fleet was quiet too" appears.

- [ ] Daemon-tick wiring: a new function call
      `await maybeFireReactivationPush(db, cfg, now,
      deps)` is added to the existing daemon tick (per
      0009 / 0030 / 0062 pattern - PRODUCER-VS-SPEC
      NOTE: grep `src/daemon.ts` for the existing tick-
      function names and mirror the call shape). The
      function:
        1. Calls `evaluateReactivationPush(db, cfg, now)`;
        2. If shouldPush, mints a `reactivation_digest`
           snapshot row via the existing
           `createSnapshot(db, { name, kind, ttl_hours:
           24 * 30 })` per 0013 / 0066;
        3. Calls `sendNtfy(ncfg.topic, { message,
           title, priority: "default", click: <url> })`
           via the existing 0009 helper. Per LESSONS
           2026-05-26 the ntfy helper is gated through
           the existing 0009 runner seam so tests don't
           POST to the real ntfy.sh.
      Test: drive the daemon-tick with a stub `deps.
      sendNtfy` that records the call; assert the ntfy
      call AND the snapshot row AND the helper returns
      `{ fired: true }`. Re-drive the tick at now + 1h;
      assert NO new ntfy call (the snapshot row dedups).

- [ ] New public route `GET /digest-missed/<token>`
      in `src/server.ts` resolves the signed token
      against the existing `resolveSnapshotToken`
      helper (per 0013) AND additionally checks the
      row's kind is `'reactivation_digest'` (per the
      0066 dispatcher pattern). The route renders a
      single static HTML page with the period summary
      composed from the payload. 404s on
      invalid/wrong-kind/expired/revoked tokens. The
      route is mounted BEFORE the `/api/` auth gate
      (the static-grep ordering assertion anchors on
      `if (path.startsWith("/api/"))` per LESSONS
      2026-06-15). Rate-limited via the existing
      `isRateLimitedPath` family (add
      `/digest-missed/` to the OR chain in
      `src/rate_limit.ts`). Test: mint a valid
      reactivation token via the helper; hit the
      route; assert 200 + HTML. Hit with a
      stakeholder_monthly token (wrong kind); assert
      404.

- [ ] Empty-period branch: when the period has 0
      merged-PR rows, the digest page renders an
      honest "the fleet was quiet while you were
      away - nothing to catch up on" framing (per
      LESSONS 2026-06-15). The render carries
      `data-testid="digest-missed-quiet-period"`.
      Test: mint a token for a fleet with 0 ships
      in the absent period; render the page; assert
      the testid present.

- [ ] Opt-out gate: when
      `cfg.reactivationPush?.disabled === true`, the
      daemon helper's `evaluateReactivationPush`
      returns `shouldPush: false, reason:
      "opt_out"`. No ntfy call, no snapshot mint.
      The public route still resolves prior tokens
      (the operator might be revisiting an old
      digest); only future pushes are suppressed.
      Test: seed cfg with `disabled: true`; assert
      `evaluateReactivationPush` returns `shouldPush:
      false, reason: "opt_out"`.

- [ ] Config field added to `src/config.ts`'s
      FleetConfig: `reactivationPush?:
      { disabled?: boolean }`. Defaulting pattern
      matches the existing `embedRateLimit` /
      `worth_it` nested fields. Test: load a config
      with the field set; assert it parses. Load a
      config without the field; assert
      `cfg.reactivationPush` is undefined AND the
      daemon helper treats undefined as enabled.

- [ ] tsc --noEmit clean. No new runtime deps - lean
      on the existing `sendNtfy` / `createSnapshot` /
      `resolveSnapshotToken` helpers. No shell-string
      composition. No JSON-shape break - the new
      `/digest-missed/<token>` route is NEW + the new
      `reactivation_digest` snapshot kind extends the
      existing TEXT column (no CHECK). Schema
      migration: YES, ONE new table
      `operator_visit_watermark` added to SCHEMA in
      `src/db.ts`. Per LESSONS 2026-05-26 "no
      backticks inside template-literal SQL strings"
      - the new CREATE TABLE statement uses plain
      identifiers. Per LESSONS 2026-06-11
      character-window source greps - the new
      helper's leading comment block uses PLAIN
      PROSE. Per LESSONS 2026-06-15 the daemon
      helper sits ALONGSIDE existing tick helpers
      and inherits their offline-test posture
      (`FLEET_DAEMON_OFFLINE=1` short-circuits per
      the existing convention - PRODUCER-VS-SPEC
      NOTE: grep `src/daemon.ts` for the existing
      offline env var name; mirror it).

## Out of scope

- A PER-DAY-OF-WEEK schedule (the push fires on
  Tuesday for some operators, Sunday for others). v1
  is Sunday 18:00 only; the operator who hates Sunday
  push opts out entirely.
- A REPEATING push (fires weekly until the operator
  returns). v1 fires ONCE per 14-day dedup window. An
  operator absent 3 weeks gets ONE push, not three.
- A CONFIGURABLE message template. The deterministic
  shape is the moat (no LLM, no editorial labour).
- A WEB-PUSH channel (the portal opens a web-push
  registration). Out of scope; ntfy is the existing
  push channel.
- An EMAIL channel. fleet-control has never had email
  infra; adding it here is feature-creep.
- A PORTAL-SIDE notification panel showing past
  reactivation pushes. The `snapshot list` CLI
  surface already lists every kind including the new
  one.
- A MULTI-TZ push (the operator's quiet-hours has one
  tz but they travel - they want the push in their
  CURRENT tz). v1 uses the configured tz; a future
  ticket can integrate browser geolocation if
  demanded.
- AN ATTRIBUTED-DIGEST variant (the digest page shows
  real PR titles). v1 uses the operator's existing
  `attribution: 'anonymised' | 'attributed'` field
  per 0065. The digest reuses the same gate.

## Engineering notes

- `src/db.ts` - add ONE new CREATE TABLE statement to
  the SCHEMA template:
  `CREATE TABLE IF NOT EXISTS operator_visit_watermark
  (id INTEGER PRIMARY KEY CHECK (id = 1), last_visit_at
  TEXT, last_user_agent TEXT);`. Per LESSONS
  2026-05-26 NO backticks; plain identifiers.
- `src/config.ts` - extend `FleetConfig` with the new
  optional `reactivationPush?: { disabled?: boolean }`
  field. Defaulting pattern matches the existing
  `embedRateLimit` / `worth_it`.
- `src/server.ts` - add visit-tracking middleware
  EARLY in the handler chain (after rate-limit but
  before the route dispatcher). The middleware
  UPDATEs `operator_visit_watermark` on EVERY non-
  public, non-/api/, loopback-or-token-bearing
  request. Per LESSONS 2026-06-15 the static-grep
  test for ordering anchors on the EXACT `if
  (path.startsWith` statement shape NOT a comment.
  Also add the new route `GET /digest-missed/
  <token>` mounted BEFORE the `/api/` auth gate.
- `src/views.ts` - new helpers
  `evaluateReactivationPush(db, cfg, now)`,
  `composeReactivationMessage(payload)`,
  `reactivationDigestPayload(db, cfg, lastVisitAt,
  now)`, `renderReactivationDigestPage(payload,
  opts)`, `_renderReactivationDigestForTests
  (payload, opts)`. Per LESSONS 2026-06-13 the
  helpers live in `src/views.ts` (no new module).
- `src/daemon.ts` - add a new call site for
  `maybeFireReactivationPush(db, cfg, now, deps)`
  alongside the existing 0009 / 0030 tick helpers.
  PRODUCER-VS-SPEC NOTE: grep the existing tick
  function for the deps-injection shape and
  mirror it. Per LESSONS 2026-06-15 the offline
  gate (`FLEET_DAEMON_OFFLINE=1`) short-circuits
  the helper at the daemon tick boundary.
- `src/snapshot.ts` - REUSE the existing
  `createSnapshot(db, { name, kind: 'reactivation_
  digest', ttl_hours: 24*30, ... })` helper (per
  0013 / 0066 / 0067). The new kind extends the
  TEXT column with no CHECK constraint.
- `src/rate_limit.ts` - add
  `path.startsWith("/digest-missed/")` to the
  `isRateLimitedPath` OR chain.
- `tests/reactivation-push.test.ts` (NEW) - one
  `test(...)` per AC checkbox above. Per LESSONS
  2026-05-29 every test pins `now` and seeds
  timestamps off the same anchor. Per LESSONS
  2026-06-13 each per-condition test fixture
  satisfies the global "fleet has 8 weeks of data"
  gate (where applicable) so the helper does NOT
  short-circuit into the empty-state branch
  unintentionally. The daemon-tick test drives
  the stub `deps.sendNtfy` via the existing 0009
  runner seam.
- `tests/db.test.ts` (existing) - extend with
  one assertion that the new table exists in a
  fresh DB.
- `README.md` - one new subsection "Reactivation
  push" under the ntfy / notifications family
  documents the schedule (Sunday 18:00 + 5-day
  absence + 14-day dedup), the message tone, and
  the opt-out config field.
- Schema migration: YES, ONE new
  `operator_visit_watermark` table added to the
  SCHEMA in `src/db.ts`. Per LESSONS 2026-05-26
  no backticks inside the template-literal SCHEMA
  string. Per the 0066 schema-extension precedent
  the new table sits at the END of the SCHEMA
  block with a comment naming the ticket id.
- No new runtime deps. Lean on the existing
  `sendNtfy` (per 0009), `createSnapshot` /
  `resolveSnapshotToken` (per 0013 / 0066), and
  the existing payload helpers. Pairs with 0009
  (ntfy), 0030 (quiet hours), 0013 / 0066 / 0067
  (snapshot kinds), 0033 / 0037 / 0038 / 0059
  (digest content patterns), 0064 (rate-limit).

## Implementation log

(Appended by the implementation-dev agent during execution.)

- 2026-06-19 - implementation-dev: flipped status from groomed to
  in-progress; branch feat/0071-reactivation-ntfy-push-absent-operator
  cut from origin/main.
