---
id: 0017
title: Today's inbox — cross-project "what needs me" view
status: in-progress
priority: P1
area: portal
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator at 9am who has 3-7 projects running autonomously
overnight, I want one page that answers "what needs me today?" across
the whole fleet — PRs awaiting my review, anomalies fired in the last
24h that I haven't dismissed, snapshots about to expire, projects whose
last run failed — so that I can land on the portal once and triage
everything in 60 seconds instead of clicking through 7 project cards
hoping nothing slipped.

## Why now (four lenses)

### Product Owner
The portal today is reactive — the operator must remember to check each
project. The inbox flips that: the portal answers the operator's one
real question ("anything I need to do?") on the home page. It's the
single highest-leverage retention surface in the backlog because it
re-anchors the "open the portal" habit on a concrete payoff every time.

### Stakeholder
Widens the moat on `portal`. The inbox is structurally only possible
because we own every project's telemetry locally; a per-project SaaS
dashboard would force the operator to context-switch. The aggregation
itself is the moat — once the operator's morning ritual is "open the
fleet inbox", switching away costs them the consolidation.

### User (operator at 9am, looking at the portal)
Home page grows a new top section "Inbox · 4 things need you". Each
row is one actionable item: PR title + project + age, anomaly + project
+ deviation, snapshot expiring in N hours. Each row has a one-click
action: open PR, dismiss anomaly, extend / revoke snapshot. After
acting, the row disappears. Empty inbox shows a single line: "Inbox
zero — fleet's healthy."

### Growth
The inbox screenshot is the most "this is what running an autonomous
fleet feels like" artifact the product can produce. It's also the
strongest signal to a prospective operator that the tool will save them
time — every other dashboard shows you data; this one tells you what
to do.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/views.ts` exports `fleetInbox(db)` returning
      `{items: Array<InboxItem>, generated_at: string}` where each
      `InboxItem` has `{kind, project_slug, title, age_seconds,
      action: {label, route}, payload: object}`. The four kinds in v1:
      * `pr_review` — open agent PR with no human approval yet
        (sourced from the same data the existing PR list uses).
      * `anomaly_open` — anomaly row with `dismissed_at IS NULL`,
        firing in the last 24h.
      * `snapshot_expiring` — snapshot row where `expires_at` is
        within the next 6h and `revoked_at IS NULL` (added by
        0013; query is no-op if the table doesn't exist yet).
      * `run_failed` — most-recent run for each project where
        `outcome=failure` AND no later `success` run exists.
      Items are sorted by `age_seconds` descending (oldest first).
      Test: seed each kind, assert ordering and shape.
- [ ] Items are deduplicated per `(kind, project_slug, payload.id)`
      so refreshing the inbox twice in a row returns the same set.
      Test: call twice, assert equal item arrays.
- [ ] `GET /api/fleet/inbox` returns the shape. Requires `read`
      scope. Test: hit without auth, assert 401; with `read`,
      assert 200 and the shape.
- [ ] `POST /api/fleet/inbox/dismiss` with body `{kind, project_slug,
      payload_id}` marks the item dismissed. For `anomaly_open` this
      sets `dismissed_at` on the anomaly row. For `pr_review` and
      `run_failed` it inserts a row in a new `inbox_dismissal`
      table keyed by `(kind, project_slug, payload_id, dismissed_at)`
      so the dismissal is purely additive (no UPDATE on referenced
      tables). For `snapshot_expiring` the action is `revoke` rather
      than `dismiss` (delegates to the existing snapshot-revoke
      action). Test: dismiss each kind, assert the next inbox call
      omits it.
- [ ] Schema migration: add `inbox_dismissal` table idempotently in
      `src/db.ts`:
      ```sql
      CREATE TABLE IF NOT EXISTS inbox_dismissal (
        kind TEXT NOT NULL,
        project_slug TEXT NOT NULL,
        payload_id TEXT NOT NULL,
        dismissed_at TEXT NOT NULL,
        PRIMARY KEY (kind, project_slug, payload_id)
      );
      ```
      Test: insert + select round-trip.
- [ ] `web/app.js` adds an "Inbox" section to the home page rendered
      above the project grid. Each item is one row with the action
      button. Empty state renders "Inbox zero — fleet's healthy."
      Test: stub the API with each item kind and the empty case,
      assert the expected DOM shape.
- [ ] Mobile: the inbox stacks single-column on screens < 600px (per
      ticket 0011 conventions) and remains usable. Test: assert no
      horizontal scroll at 375px viewport in the existing
      mobile-portal test harness.
- [ ] Query performance: `fleetInbox(db)` completes in under 100ms
      against a fleet of 10 projects with 1000 anomalies, 50 open
      PRs, and 5 active snapshots. Test: seed the dataset, time the
      call, assert <100ms (skip if `process.env.PERF !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-string
      composition. No JSON-shape change to any existing `/api/...`
      route (the new `inbox` routes are net-new).

## Out of scope

- Custom inbox-item kinds (operator-defined queries). v1 is the four
  fixed kinds above. A saved-search ticket is a clean follow-up.
- Push notifications when a new item lands. The ntfy module (0009)
  already handles per-event push; the inbox is the pull surface.
- Multi-operator inbox (assigning items to teammates). Single-operator
  by design.
- An "all dismissed items" history view. Dismissals are additive in
  the table, so the data is there for a future ticket.
- LLM-generated triage suggestions. Operator reads, operator decides.

## Engineering notes

- `src/views.ts` — new `fleetInbox(db)` helper composed of four
  sub-queries, one per kind, UNION ALL'd at the end. Each sub-query
  reads only existing tables (plus the conditional snapshot read).
  Use the `as unknown as RowT[]` cast pattern per
  `docs/LESSONS.md` § `node:sqlite`'s `.all()` needs `as unknown as
  T[]`.
- `src/server.ts` — two new routes (`GET /api/fleet/inbox`,
  `POST /api/fleet/inbox/dismiss`). Reuse the existing scope
  middleware.
- `src/db.ts` — append the `inbox_dismissal` table to the SCHEMA
  template. Per `docs/LESSONS.md` § no backticks inside template-
  literal SQL strings, keep identifiers plain.
- `web/app.js` — new `renderInbox(data)` and the home-page hook.
- `web/style.css` — one selector group for inbox rows; lean on
  existing CSS variables.
- No new runtime deps. The snapshot-expiring kind is a no-op until
  0013 lands the `snapshot` table; guard the query with
  `SELECT name FROM sqlite_master WHERE type='table' AND name='snapshot'`.
- Pairs with 0013 (the inbox surfaces expiring snapshots), 0014
  (leaderboard is the "exploratory" surface, the inbox is the
  "actionable" surface), and 0015 (badge is the passive surface; the
  inbox is the active one — together they bound the operator's daily
  touchpoints).

## Implementation log

- 2026-05-27 [implementation-dev] picked up groomed → in-progress on
  branch `feat/0017-todays-inbox-cross-project`. Plan: add the
  `inbox_dismissal` table to `src/db.ts`, write `fleetInbox(db)` +
  dismissal helpers in a new `src/inbox.ts` module (kept out of
  `views.ts` so the home view stays small), wire two routes
  (`GET /api/fleet/inbox`, `POST /api/fleet/inbox/dismiss`) into
  `src/server.ts`, and render the inbox section above the project
  grid in `web/app.js` with mobile-stacking styles in
  `web/style.css`. Tests live in `tests/inbox.test.ts` — one per AC
  box.
