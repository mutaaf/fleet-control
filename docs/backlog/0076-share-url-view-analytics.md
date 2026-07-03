---
id: 0076
title: Share URL view analytics so the operator sees whether the artifacts they paste are actually being opened
status: groomed
priority: P1
area: observability
created: 2026-07-03
owner: gtm-innovation
---

## User story

As a fleet operator who has already pasted a signed `/share/<kind>/<token>`
link into LinkedIn, a CV, or a stakeholder email, I want the portal to tell me
how many times each of my live share links has actually been opened (and
roughly when + from what kind of client), so that I know whether my share-first
loop is landing before I decide to keep authoring more of them.

## Why now (four lenses)

### Product Owner
The smallest unit of value is a single number per live token: "your operator
profile: 12 views over 30d." Without it, every share ticket already shipped
(0013, 0041, 0054, 0065, 0066, 0067, 0068, 0069, 0072, 0070) is a one-way
broadcast — the operator authors and pastes but never learns whether the paste
did anything. That silence is what causes the operator to stop sharing.

### Stakeholder
The moat is "artifacts only the local SQLite can author." Right now the moat is
invisible: the operator has no evidence their moat-shaped artifacts are being
read. A per-token view counter turns the accumulated share surface into a
measurable retention loop — the operator sees the artifacts landing, so they
keep pasting, so cold acquisition keeps compounding.

### Operator (9am phone glance)
One line on `/pulse` and one small badge on each signed page the operator
authors: "12 views · last from mobile Safari · 2d ago." Glanceable, one tap
to the full breakdown. No dashboards to configure. Never requires the operator
to leave the portal.

### Capability — for the operator, NOT an audience
Pure operator-facing signal. The counter is shown to the operator on their
loopback portal only; it is NOT rendered on the public share pages themselves
(no vanity counter for strangers). The "show me" moment is the operator
opening the portal on Tuesday and seeing "your Monday LinkedIn paste got 47
views" — evidence the loop works, without inviting a stranger to see it.

## Acceptance criteria

- [ ] A new `share_view` table (columns: `token TEXT`, `kind TEXT`, `day TEXT`
      (YYYY-MM-DD, UTC), `count INTEGER`, `last_seen_at INTEGER`,
      `last_ua_class TEXT`) is created; PRIMARY KEY `(token, day)`.
- [ ] Every existing `/share/<kind>/<token>` and `/embed/*` route increments
      `share_view` by 1 on GET, keyed by `(token, today-UTC)`, and updates
      `last_seen_at` + `last_ua_class` (one of `mobile`, `desktop`, `bot`,
      `unknown` — derived from a small in-repo UA regex, no external lib).
- [ ] `GET /api/share/views?token=<t>` returns
      `{ token, kind, total, last30d, last_seen_at, last_ua_class, by_day: [{day,count}...] }`
      (30 days of daily rows, additive JSON shape).
- [ ] The portal's `/pulse` page (loopback only) renders a "shared N times
      this month" line derived from `SUM(count)` across all tokens owned by
      the operator over the current month.
- [ ] Every page that authors a signed URL (operator profile, stakeholder
      summary, anniversary, portfolio, lesson-lineage, snapshot, receipts,
      failure pages) shows the operator a small "N views" badge next to the
      copy-link button in the LOOPBACK portal — never on the public rendered
      page.
- [ ] Bot traffic (UA class = `bot`) is counted into a separate
      `count_bot INTEGER` column so the operator-facing total excludes it.
- [ ] Regression: existing `/share/*`, `/embed/*`, `/pulse` HTTP responses are
      byte-identical for the public reader (headers + body); the counter runs
      as a side effect only.
- [ ] Regression: `npx tsc --noEmit` clean; `node scripts/check-backlog.mjs`
      clean.
- [ ] Safety: no shell-string composition; no new runtime deps.

## Out of scope

- Per-referrer breakdown (utm_source, referer chains). Kind + UA class is
  enough for v1.
- Public "N views" badges rendered on the share pages themselves — this is a
  private-operator signal, not vanity metrics for readers.
- Geo/IP breakdown. We do not want to touch IPs at rest.
- Real-time push of new views (SSE). A poll on portal open is enough.
- Historical backfill for shares minted before this ticket lands — count
  starts at zero on ship day.

## Engineering notes

- `src/db.ts` — add `CREATE TABLE share_view (...)` under the existing schema
  block, bump `SCHEMA_VERSION`, add the standard idempotent `ALTER TABLE ADD
  COLUMN` guards for `count_bot`, `last_ua_class`, `last_seen_at` so a
  re-boot on an older DB is safe.
- `src/server.ts` — one shared middleware `recordShareView(req, token, kind)`
  called from every existing `/share/*` and `/embed/*` handler; UA
  classification lives in a new `src/ua.ts` (tiny regex table, no deps).
- `src/views.ts` — one new helper `renderShareViewsBadgeForTests(payload,
  opts)` for the loopback badge so quiet-hours / config-branch tests do not
  race the shared cwd config (LESSONS 2026-06-11).
- `web/pulse.html` (loopback variant) + `web/share-inbox.html` — one line
  each, additive DOM.
- Cache invalidation: any memo of "views by token" in `server.ts` uses the
  `globalThis.__fleet_share_views_invalidate__` slot pattern
  (LESSONS 2026-06-05); per-boot memos add a `_resetShareViewsForTests()`
  hook (LESSONS 2026-06-23).
- Any JSON body written by `/api/share/views` runs `redactSecrets` over the
  operator-supplied VALUES before `JSON.stringify` — never over the
  serialised body string (LESSONS 2026-06-10).
- Freshness detection on `share_view` uses `(MAX(last_seen_at), COUNT(*))`,
  not `MAX(id)` — the table has no surrogate id (LESSONS 2026-06-07).
- New deps: none (`node:` builtins only). JSON additive only — new route
  `/api/share/views`, no existing route changed.

## Implementation log

(Appended by the implementation-dev agent during execution.)
