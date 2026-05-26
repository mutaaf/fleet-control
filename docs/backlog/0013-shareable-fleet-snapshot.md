---
id: 0013
title: Shareable read-only fleet snapshot with anonymized slugs
status: shipped
priority: P2
area: portal
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator who wants to show a friend what fleet-control looks
like without exposing my actual project names or repo URLs, I want to
generate a single-use read-only snapshot link backed by sanitized data,
so that the "show me" moment is one URL and the recipient cannot
discover anything about my real repos or trigger any control action.

## Why now (four lenses)

### Product Owner
The agent brief calls out the screenshot worth sharing as a recurring
test for ticket value, but every time the operator wants to share, they
have to manually crop project names out of a screenshot or worry that a
LAN URL exposes too much. A first-class "snapshot" surface — one
command, one tokened URL, anonymized slugs, no write actions reachable —
removes the friction and turns sharing into a casual act. It's small
(one new route, one new table, one CLI subcommand) but unlocks every
"acquisition" theme downstream.

### Stakeholder
Widens the moat on `control` by demonstrating that the local-only
model can still produce share-safe outputs without an LLM, a CDN, or a
SaaS hop. Every snapshot link is proof that the product respects the
operator's privacy by default. The shared artifact itself is also free
marketing — every recipient who follows the link is one impression of
the portal.

### User (operator at 9am, looking at the portal)
Operator hits "Share fleet snapshot" in the portal footer, names the
snapshot ("Couch demo"), gets a URL like
`http://<laptop-ip>:7070/share/<token>`. Opens it on the friend's
phone — the friend sees a fleet with `project-a`, `project-b`,
`project-c` instead of the real slugs, no PR titles, no repo URLs, no
control buttons. The snapshot is static (frozen at creation time, not
live-updating) and expires after 24 hours by default. Operator can
revoke at any time.

### Growth
This is the single feature most likely to produce inbound interest.
Every recipient of a snapshot link is a high-intent prospective
operator. The snapshot route is also indexable internally for the
operator's own "what did the fleet look like a week ago?" archive — a
secondary moat property the same surface unlocks.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] New table `snapshot` (schema added idempotently to `src/db.ts`):
      ```sql
      CREATE TABLE IF NOT EXISTS snapshot (
        id TEXT PRIMARY KEY,              -- sha256 of the secret token
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        payload_json TEXT NOT NULL        -- the frozen, anonymized fleet view
      );
      ```
      Test: insert a row, query back, assert all fields round-trip.
- [ ] `src/snapshot.ts` (new) exports:
      - `createSnapshot(db, {name, ttl_hours?})` → `{token: string,
        share_url: string}`. Default TTL 24h. Token is 24 hex bytes;
        only the SHA-256 hash is stored. Test: call twice, assert
        distinct tokens.
      - `getSnapshot(db, token)` → `{payload, expired: boolean}` or
        `null` if not found / revoked.
      - `revokeSnapshot(db, id_prefix)` → boolean.
      - `anonymize(fleetView)` → deep clone that:
          * replaces each project's `slug` with `project-N` (stable
            within one snapshot via an integer counter).
          * replaces `name`, `repo_url`, `repo_owner`, `repo_name`,
            `branch`, `pr.title`, `pr.url`, `pr.author` with placeholders
            (`Project N`, `null`, `pr-XX`, etc.).
          * drops `transcript_path`, `log_path`, `manifest_path`, any
            absolute filesystem path entirely.
          * preserves all numeric fields (runs, tokens, cost, durations)
            and all enum fields (phase, outcome, ci_state).
        Test: feed a realistic fleet view, assert no placeholder string
        remains containing `/Users/`, no real slug appears, all numeric
        totals are preserved bit-for-bit.
- [ ] `POST /api/control/snapshot-create` with body `{name, ttl_hours?}`
      mints a snapshot and returns the share URL. Requires `admin`
      scope. Test: call without admin scope, assert 403; with admin
      scope, assert 200 + token in response.
- [ ] `POST /api/control/snapshot-revoke` with body `{id_prefix}`.
      Requires `admin`. Test: create then revoke, assert subsequent GET
      returns 410 Gone.
- [ ] `GET /share/<token>` returns a self-contained HTML page (no auth
      required) rendering the anonymized payload. The page:
      - imports the same `web/style.css` (read-only — no buttons).
      - shows a banner at the top: "Read-only snapshot of <name>,
        created <relative-time>, expires <relative-time>."
      - does NOT load `web/app.js` and does NOT fetch any `/api/...`
        routes. All data is inlined as a single `<script
        type="application/json" id="snapshot-data">` block.
      - has no `<form>`, no `<button>` with an action handler, no
        outbound links to GitHub.
      Test: render the page, parse the HTML, assert there is no
      `<button>` matching the action class set, no anchor pointing to
      `github.com`, no `/api/control/` string anywhere in the body.
- [ ] Expired snapshots return HTTP 410 Gone with a friendly message.
      Test: insert a row with `expires_at` in the past, fetch, assert
      410.
- [ ] `bin/fleetctl.ts snapshot create <name>` mints + prints the URL.
      `snapshot list` shows id-prefix, name, expires-at, revoked. `snapshot
      revoke <id-prefix>` sets `revoked_at`. Test each subcommand.
- [ ] Snapshots are written to `control_audit` with action
      `snapshot-create` / `snapshot-revoke`. The audit row's
      `args_json` MUST NOT contain the raw token — only the id-prefix.
      Test: assert the audit row's args_json does not contain the
      plaintext token.
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-string
      composition. No `/api/...` JSON-shape change to any existing
      route.

## Out of scope

- Live-updating snapshots. Snapshot is frozen at creation; if the
  operator wants a fresh view they create a new one.
- Public web hosting. The snapshot URL is only reachable on whatever
  host/port the operator's fleet-control is bound to. (If they want
  internet exposure they tunnel themselves — out of scope.)
- Sharing controls (per-recipient analytics). Static page, no tracking.
- Multi-snapshot diff view ("show me the fleet a week ago vs. now").
  Future ticket.
- Editing the anonymization rules from the UI. Hardcoded mapping in v1.

## Engineering notes

- `src/db.ts` — new `snapshot` table next to `auth_token`. Same SHA-256
  pattern as 0003 (store the hash, return plaintext once).
- `src/snapshot.ts` — pure helpers. The `anonymize()` function is the
  load-bearing piece; keep it small and test-driven. Walk the fleet-view
  object with a switch on field names, allowlist the numeric / enum
  fields, drop or replace everything else.
- `src/server.ts` — three additions:
  * `POST /api/control/snapshot-create` and `/snapshot-revoke` via the
    existing `doAction` dispatcher.
  * `GET /share/<token>` — a separate handler that does NOT use the
    auth middleware (intentional: the token IS the auth).
- `web/app.js` — small "Share fleet snapshot" affordance in the footer.
- `web/share.html` (new) or templated inside the server response. Keep
  the HTML hand-rolled (no template engine).
- No new runtime deps. No schema migration to existing tables — purely
  additive.
- Pairs naturally with the mobile pass (0011): the share page should
  inherit the same media queries so the recipient on a phone sees the
  same crisp layout.

## Implementation log

- 2026-05-26 — `implementation-dev` started on branch
  `feat/0013-shareable-fleet-snapshot`. Frontmatter and README index moved
  to `in-progress`. Test-first work begins with `tests/snapshot.test.ts`.
- 2026-05-26 — Landed the slice. New `snapshot` table (idempotent CREATE in
  `src/db.ts`), `src/snapshot.ts` with `createSnapshot` / `getSnapshot` /
  `revokeSnapshot` / `anonymize` / `listSnapshots` / `serveShare` / pure
  HTML renderer (no DOM, no template engine, no `<button>`, no
  `/api/control/`, no `github.com` anchors). New control verbs
  `snapshot-create` and `snapshot-revoke` wired through `doAction`;
  `/api/control/snapshot-*` gated on `admin` scope in `src/server.ts`.
  New `GET /share/<token>` route emits the self-contained HTML page;
  expired/revoked snapshots return 410 Gone with a friendly message,
  unknown tokens return 404. CLI surface: `fleetctl snapshot
  create|list|revoke`. Audit rows carry the 8-char `id_prefix` only —
  the plaintext token is shown ONCE and never persisted. `tsc --noEmit`
  clean, `node scripts/check-backlog.mjs` green, 17 new tests + 118
  pre-existing tests pass. Zero new runtime dependencies. Added
  `FLEET_DB_PATH` env override in `src/config.ts` so the subprocess CLI
  tests can target a tmpdir DB without touching the operator's real
  state tree.

