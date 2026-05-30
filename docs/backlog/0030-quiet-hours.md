---
id: 0030
title: Quiet hours - sleep-window suppress non-critical pushes and demote inbox kinds
status: in-progress
priority: P1
area: control
created: 2026-05-30
owner: gtm-innovation
---

## User story

As a fleet operator who let the ntfy bridge (0009) onto my phone and now
wakes up at 3am because the ship slot tripped an anomaly two timezones
away, I want a per-operator quiet-hours window (e.g. 22:00-07:00 local)
during which non-critical ntfy pushes are suppressed and the inbox kinds
they would have produced sit beneath a "queued during quiet hours"
divider, so that I can keep the phone push channel turned on without
fearing it - the only thing that wakes me up is a true critical, and
everything else is still visible at 7:01am with no information loss.

## Why now (four lenses)

### Product Owner
0009 (ntfy) wired the phone push channel but only gates by severity -
which means the moment an operator adds a second project, the "warn"
class fires often enough overnight that they either silence ntfy
entirely (losing the channel) or live with 3am buzzes (losing sleep).
The retention question this surfaces is binary: an operator who silences
ntfy stops trusting the portal as their primary touchpoint and the
glance-UX moat collapses. A single per-operator quiet-hours window
turns the push channel back into a tool the operator actually keeps on.
No new data, one config field, one boolean gate in ntfy dispatch, one
sort tweak in the inbox. Strict subtraction of operator pain.

### Stakeholder
Widens the moat on `control`. The notification channels owned by
SaaS dashboards (Slack apps, email, in-app bells) all have a per-user
"do not disturb" window because the operator pain is universal -
shipping it here keeps fleet-control at parity with the table-stakes
notification UX while staying zero-runtime-dep. The lesson learned
from courtiq's CROSS_LESSONS (alerts that fire during a known
maintenance window erode trust faster than a missed alert) generalises
here: a 3am false alarm costs more trust than a 9am one delivers.

### User (operator at 9am)
At 9am they open the inbox. The "queued during quiet hours" divider sits
near the top with the count: "3 items arrived overnight." Below it,
the three rows are the usual inbox kinds (a `pr_review` from 03:14, a
`run_failed` from 04:02, an `anomaly_open` from 06:18) - same shape,
same actions, just demoted in sort order and marked with a small moon
glyph. Critical kinds (`fleet_correlation` from 0027) are never demoted -
they sat at the top as soon as they fired and the phone buzzed at 03:12
because that one really did need them. After 07:00 local, the divider
disappears and the inbox reverts to its usual sort. Per-project override
lives in the project page settings for the rare project that warrants
24/7 paging.

### Growth
"Yes, the phone push works - it just doesn't wake me up unless it's
critical" is the single sentence that gets the next operator past the
"will this thing buzz me at 3am" question. It also matters that the
window is per-operator config, not a vendor-imposed schedule: the
share-worthy moment is "here is my 22:00-07:00 strip in
fleet-control.config.json" not a screenshot of a settings modal.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `fleet-control.config.json` schema gains two optional fields:
      `quietHours: { start: "HH:MM", end: "HH:MM", tz: string }` (the
      operator-wide default, `tz` is an IANA zone name like
      "America/Los_Angeles") and `quietHoursOverride: { [slug:
      string]: false | { start, end, tz } }` (per-project override; the
      literal `false` means "always page for this project, never
      quiet"). Both default to undefined (= no quiet hours). Test:
      `loadConfig()` parses the new shape; an absent field returns
      `undefined`; an invalid `HH:MM` returns a validation error.
- [ ] `src/quiet_hours.ts` (new) exports
      `isQuietNow(cfg, projectSlug, now): boolean`. It resolves the
      effective window (per-project override beats fleet default;
      `false` override skips entirely), interprets `start`/`end` in
      the resolved `tz` via `Intl.DateTimeFormat` (no new deps), and
      handles overnight windows (start > end means the window wraps
      midnight). Test: a fleet default 22:00-07:00 PT and a `now` of
      03:00 PT returns `true`; `now` of 12:00 PT returns `false`; a
      per-project `false` override returns `false` for that slug even
      at 03:00.
- [ ] `src/ntfy.ts` ntfy dispatch gates on `isQuietNow`: when the
      function returns `true` for the alert's/anomaly's project AND
      the payload's `priority < 5` (i.e. anything below ntfy's
      "critical"), the dispatch returns
      `{ok: true, status: 0, error: "quiet_hours"}` and does NOT
      POST. `priority === 5` (the only level used for `critical`
      alerts and `fleet_correlation` per 0027) always pages.
      Test: stub https.request, set quiet hours and a `now` in-window,
      dispatch a warn-level alert, assert zero POSTs and the
      `quiet_hours` return; dispatch a critical alert, assert one POST.
- [ ] Quiet-hours suppression deduplicates against re-fire: when an
      alert is suppressed by quiet hours, its `dedup_key` is NOT
      added to `seenAlertKeys` so that if quiet hours end and the
      alert is still open, it fires once at window close. Test:
      dispatch the same `dedup_key` twice during quiet hours (zero
      POSTs both times), then advance `now` past `end` and dispatch
      again (one POST). Per LESSONS § "in-process dedup sets need
      an explicit reset hook for tests", call
      `_resetDedupForTests()` between cases.
- [ ] `src/inbox.ts` `fleetInbox(db, opts?)` accepts an optional
      `now` parameter and a `cfg` reference; when quiet hours are
      active for the operator (any project's window catches `now`
      OR the fleet default does), the inbox split goes:
      * `items` (top): all `kind='fleet_correlation'` rows, plus any
        kind whose original `priority` would have been `critical`
        (per the existing severity map).
      * `quietedItems` (below): every other kind that arrived
        WITHIN the active quiet window (rendered with
        `quieted_at` = the row's existing created_at). Sort within
        the quieted section is identical to the existing inbox sort
        (age desc).
      Outside quiet hours, `quietedItems` is always empty and the
      response shape is byte-identical to today's. Test: seed three
      `pr_review` + one `fleet_correlation`, with `now` inside quiet
      hours; assert the correlation sits in `items` and the three
      PR rows in `quietedItems`; with `now` outside, assert all four
      sit in `items` and `quietedItems` is empty.
- [ ] `GET /api/fleet/inbox` returns the new shape `{items: [...],
      quietedItems: [...], generated_at: string, quietHoursActive:
      boolean, quietHoursUntil: string | null}`. The `items` array
      remains the same shape it has today (additive change only -
      `quietedItems` is net-new, default `[]`, so SPA versions that
      don't know about it continue to work). Test: hit the route
      with quiet hours unset, assert `quietedItems: []` and
      `quietHoursActive: false`; with quiet hours set + `now`
      in-window, assert the split. Cross-cutting check: no JSON-
      shape break - existing keys are preserved, new keys are
      additive, per AGENTS.md hard NO.
- [ ] `web/app.js` `renderInbox(data)` renders the `quietedItems`
      under a divider row with the text "Queued during quiet
      hours - resumes at HH:MM" (using `data.quietHoursUntil`),
      and prefixes each quieted row with a small moon glyph
      (Unicode `U+1F319` rendered with `aria-label="quiet"`).
      Items in `quietedItems` are clickable + dismissable exactly
      like normal items. When `data.quietedItems.length === 0` the
      divider is absent. All strings (including `quietHoursUntil`)
      pass through `redactSecrets` per LESSONS § "defence-in-
      depth secret redaction at the renderer boundary". Test:
      stub the API with both shapes, assert the DOM contains the
      divider when expected and only then.
- [ ] Mobile: the divider row stays single-column at 375px and
      does not introduce horizontal scroll (per 0011 conventions
      - inherits inbox row styles). Test: assert via the existing
      mobile-portal text-level CSS contract.
- [ ] `bin/fleetctl.ts quiet-hours` CLI prints the current
      effective windows: the fleet default, each project's
      override, and whether quiet hours are active right now.
      Exit 0 always. Test: spawn via the FLEET_DB_PATH seam
      (LESSONS § "CLI subprocess tests need a FLEET_DB_PATH env
      seam"), assert the printed output names the config'd
      window. No subcommand for SETTING quiet hours - the operator
      edits `fleet-control.config.json` directly (matches the
      ntfyTopic / portalUrl precedent).
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-string
      composition. The `_resetDedupForTests` and a new
      `_resetQuietHoursForTests` (if the resolver adds any
      module-level cache) are exposed per the cross-fleet pattern
      "in-process dedup sets need an explicit reset hook." Per
      LESSONS § "node:sqlite's .all() needs `as unknown as T[]`",
      any new SQL row narrowing uses the double-cast.

## Out of scope

- Per-severity quiet-hours rules ("suppress warn but not critical
  between 18:00 and 09:00, suppress everything between 22:00 and
  07:00"). v1 is one window, one severity gate (`< 5`).
- A "snooze for 1h" one-tap action from the inbox or ntfy
  notification. Useful follow-up; v1 is the static window only.
- Calendar-aware quiet hours (read the operator's gcal, suppress
  during meetings). Out of scope - too much new surface.
- Multi-operator quiet hours (different windows for different
  people). Single-operator by design.
- A portal-side editor for the quiet-hours window. Config-file
  only in v1 (matches the ntfyTopic / portalUrl precedent).
- Auto-pausing projects during quiet hours. The autopause (0021)
  is the only auto-control surface; quiet hours is purely
  notification policy.
- Surfacing the quiet-hours state in the welcome banner (0024).
  Could be a future tweak; v1 keeps welcome unchanged.

## Engineering notes

- `src/quiet_hours.ts` - new module. Pure functions: `parseWindow`,
  `resolveWindow(cfg, slug)`, `isQuietNow(cfg, slug, now)`,
  `nextWindowEnd(cfg, slug, now)`. Time arithmetic via
  `Intl.DateTimeFormat` with the resolved `tz` (zero new deps;
  node's ICU covers IANA zones). Overnight wrap is handled by
  comparing `start` and `end` as minutes-since-midnight in the
  resolved zone. If the module needs any cache (e.g. memoising
  the parsed window per ten-second tick), expose
  `_resetQuietHoursForTests()` per LESSONS § "in-process dedup
  sets need an explicit reset hook for tests."
- `src/config.ts` - extend the `FleetConfig` interface with
  `quietHours?` and `quietHoursOverride?`, add lenient
  parsing/validation (a bad `HH:MM` falls back to undefined with
  a one-line `fleetd.err` log; invalid `tz` falls back the same
  way). No new disk file - lives in
  `fleet-control.config.json`.
- `src/ntfy.ts` - one new gate at the top of `ntfyForAlert` and
  `ntfyForAnomaly` after the topic check: call `isQuietNow` with
  the project slug + payload priority, return early with
  `error: "quiet_hours"` when both conditions hold. The
  important detail (per AC4) is that the early return does NOT
  add the dedup key to the seen set - so the alert can re-fire
  at window close.
- `src/inbox.ts` - take an optional `now` param + `cfg`. Split
  the existing items array into `items` + `quietedItems` based
  on `isQuietNow(cfg, item.project_slug, now)` AND item kind
  (correlation / critical always wins). Existing sort within
  each section preserved.
- `src/server.ts` - one new param threaded into the
  `/api/fleet/inbox` handler (the `cfg` is already available;
  `now` defaults to `new Date()`). Per LESSONS § "time-pinned
  tests must NOT derive seed timestamps from `new Date()`", the
  tests pass a fixed `now` through the handler test seam, never
  reading the wall clock.
- `web/app.js` - one new `renderQuietDivider(until)` helper and
  a small DOM tweak in `renderInbox` to split into two sections.
  All operator strings pass through `redactSecrets` (per
  LESSONS § "defence-in-depth secret redaction at the renderer
  boundary").
- `web/style.css` - one selector group for the divider row
  (`.inbox-quiet-divider`) and the moon-glyph prefix. Reuse
  existing CSS variables - no new palette.
- `bin/fleetctl.ts` - one new `quiet-hours` subcommand that
  prints the resolved windows. Per LESSONS § "CLI subprocess
  tests need a FLEET_DB_PATH env seam", the existing env-var
  seam covers this; the new command takes no new env knobs.
  Per LESSONS § "CLI subcommands that print at boot must own
  the listen banner" - irrelevant here (no `startServer` call)
  but worth re-reading before touching any subcommand that
  prints alongside serve.
- `tests/quiet_hours.test.ts` (new) - unit tests for
  `isQuietNow` (one per AC2 case), the ntfy gate (one per
  AC3/AC4), and the inbox split (per AC5). The in-process
  `startServer()` tests for the inbox route follow LESSONS §
  "in-process startServer() tests need an empty-roots config +
  run-row seeds" - plant a tmp `fleet-control.config.json` in
  cwd, snapshot/restore on cleanup so a dev's live admin token
  is never clobbered.
- No new runtime deps. Pairs with 0009 (ntfy is the channel
  this gates), 0017 (the inbox is the surface), 0021 (the
  autopause is the only auto-control - quiet hours is
  explicitly NOT one), and 0027 (correlations are the one kind
  that always pages, validated by the AC3 critical test).

## Implementation log

- 2026-05-30: implementation-dev started. Branch `feat/0030-quiet-hours`.
  Plan: new `src/quiet_hours.ts` module (pure functions with
  `Intl.DateTimeFormat` for IANA tz arithmetic), extend `FleetConfig`
  with `quietHours` + `quietHoursOverride`, gate `ntfyForAlert` /
  `ntfyForAnomaly` early without consuming the dedup key, extend
  `fleetInbox` to split into `items` + `quietedItems`, add the
  `quietHoursActive` / `quietHoursUntil` envelope keys to the API
  response (additive, preserves existing keys), render the moon-glyph
  divider in `web/app.js`, add the `fleetctl quiet-hours` subcommand.
