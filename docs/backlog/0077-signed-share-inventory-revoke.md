---
id: 0077
title: Signed share inventory and one-tap revoke page so the operator trusts every token they mint
status: groomed
priority: P2
area: control
created: 2026-07-03
owner: gtm-innovation
---

## User story

As a fleet operator who has minted a growing pile of signed share tokens
(operator profile, stakeholder summary, anniversary card, portfolio,
snapshot, receipts, lesson-lineage, failure pages), I want a single loopback
page that lists every live token I have out in the wild and lets me revoke
any one of them with a single tap, so that I keep sharing without the low
background dread that a token I forgot about is still handing strangers a
view of my fleet.

## Why now (four lenses)

### Product Owner
Every ticket in the share family (0013, 0041, 0054, 0065, 0066, 0067, 0068,
0069, 0070, 0072) mints tokens the operator never sees again. The smallest
unit of value is a single loopback page — `/settings/shares` — that renders
one row per live token with kind, created-at, expires-at, view-count (from
0076 once it lands), and a revoke button. Un-minting is the missing half
of minting.

### Stakeholder
Trust is the moat's floor. The operator will only keep authoring signed
artifacts if they know they can un-author. A revoke table also caps the
blast radius of a leaked config: any leaked token can be killed from the
phone. This deepens the "safer control surface" moat.

### Operator (9am phone glance)
One page. One row per token. A prominent red revoke button. Confirm modal
that spells the kind + created-at back so the operator does not fat-finger
the wrong row on mobile. Zero technical language.

### Capability — for the operator, NOT an audience
Pure operator-facing control surface — never rendered publicly, never
shareable, never inventable as vanity surface. The "show me" moment is the
operator revoking a stale anniversary token from their phone in three
seconds while walking.

## Acceptance criteria

- [ ] A new `share_revocation` table (columns: `token TEXT PRIMARY KEY`,
      `revoked_at INTEGER NOT NULL`, `kind TEXT NOT NULL`,
      `reason TEXT`) is created.
- [ ] Every existing signed-share route (`/share/*`, `/embed/*`) checks
      `share_revocation` before rendering and returns HTTP 404 with the
      existing not-found body when the token is present in the table.
- [ ] `GET /settings/shares` (loopback-only, admin token required for LAN)
      renders one HTML row per live signed token the operator has minted,
      showing `kind`, `created_at`, `expires_at`, and (if 0076 has
      shipped) `views_last_30d`. Rows are sorted by `created_at DESC`.
- [ ] `POST /api/share/revoke` with `{ token }` inserts a row into
      `share_revocation` and returns `{ revoked: true }` (additive JSON,
      not a mutation of any existing route).
- [ ] The revoke button on `/settings/shares` fires a confirm modal that
      spells back the kind and created-at, then hits `POST /api/share/revoke`
      and re-renders the row as struck-through with a "revoked NNNN-NN-NN"
      chip.
- [ ] Revoking twice is idempotent — a second POST for the same token
      returns HTTP 200 with `{ revoked: true, already: true }` and does not
      duplicate the row.
- [ ] Every signed-share renderer that finds a token in `share_revocation`
      logs one line at `WARN` level and short-circuits BEFORE hitting any
      DB read that would compose share payload — no wasted work.
- [ ] Regression: unrevoked signed URLs still return byte-identical HTML
      for the public reader.
- [ ] Regression: `npx tsc --noEmit` clean; `node scripts/check-backlog.mjs`
      clean.
- [ ] Safety: no shell-string composition; no new runtime deps; admin
      token check on the LAN path is not weakened.

## Out of scope

- Time-boxed auto-expiry of tokens by policy. The operator revokes
  intentionally — no cron.
- Bulk-revoke ("kill every token older than N days"). Per-row for v1.
- Undo-revoke. A revoked token stays revoked — mint a new one.
- Revocation-audit page beyond the `share_revocation` table itself.

## Engineering notes

- `src/db.ts` — add `CREATE TABLE share_revocation (...)` under the
  existing schema block, bump `SCHEMA_VERSION`.
- `src/server.ts` — one shared helper `isRevoked(token: string): boolean`
  called from every `/share/*` and `/embed/*` handler ahead of the
  existing signature-check path. Memoise per-boot, invalidate on POST via
  the `globalThis.__fleet_share_revocation_invalidate__` slot
  (LESSONS 2026-06-05); expose `_resetShareRevocationForTests()`
  (LESSONS 2026-06-23).
- `src/views.ts` — new `renderShareInventoryPageForTests(rows, opts)` seam
  so the config-branch (LAN vs loopback badge visibility) tests do not
  race the shared cwd config (LESSONS 2026-06-11). Keep the leading
  comment block free of backticked identifiers that overlap the 0052 /
  0056 slice-grep windows (LESSONS 2026-06-11 sibling).
- `web/settings-shares.html` — new vanilla page, no framework, no bundler,
  no external fetches; existing shared CSS.
- Freshness detection on `share_revocation` uses
  `(MAX(revoked_at), COUNT(*))` — the table has no surrogate id
  (LESSONS 2026-06-07).
- `redactSecrets` over `{ token }` VALUES on the `/api/share/revoke`
  response before `JSON.stringify`, never over the serialised body
  (LESSONS 2026-06-10).
- New deps: none (`node:` builtins only). JSON additive only —
  `/api/share/revoke` is new; no existing route JSON shape changes.

## Implementation log

(Appended by the implementation-dev agent during execution.)
