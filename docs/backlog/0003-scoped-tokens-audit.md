---
id: 0003
title: Per-user scoped tokens with audit log
status: groomed
priority: P1
area: control
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator who shares the portal across devices (laptop + phone +
tablet), I want each device to use its own scoped token, so that a lost
device can be revoked without invalidating the others.

## Why now (four lenses)

### Product Owner
A single shared admin token is fine for local use; the moment a second
device appears, it's a liability. Replace with named tokens scoped to
read / control / admin.

### Stakeholder
Widens the moat on `control` safety. Pairs with the existing
`control_audit` table — actions now carry `who` instead of an anonymous
shared identity.

### Operator
"I left my phone at the gym" — revoke that one token in the portal, the
laptop keeps working.

### Growth
Multi-device-by-design is a real property. People notice.

## Acceptance criteria

- [ ] New table `auth_token(id TEXT PRIMARY KEY, name TEXT, scope TEXT,
      created_at TEXT, last_used_at TEXT, revoked_at TEXT)`. Scopes:
      `read`, `control`, `admin`.
- [ ] `bin/fleetctl.ts tokens add <name> --scope <scope>` mints a new
      token, prints it once, never stores plaintext (store SHA256 in the
      `id` field).
- [ ] `bin/fleetctl.ts tokens list` shows id-prefix (first 8 chars), name,
      scope, last-used, revoked status. Never prints the full token.
- [ ] `bin/fleetctl.ts tokens revoke <id-prefix>` sets `revoked_at`.
- [ ] `src/server.ts` auth middleware: loopback still bypasses. Remote
      callers send `x-fleet-token`; server hashes and looks up. Reject if
      not found or revoked. Update `last_used_at`.
- [ ] Scope enforcement: GET routes need `read`. Control actions (POST
      `/api/control`) need `control`. Token management needs `admin`.
- [ ] `control_audit` rows now write the token's `name` to a new
      `actor_name` column (additive — existing rows back-fill as
      `"admin (legacy)"`).
- [ ] Backward-compat: if the legacy `adminToken` in
      `fleet-control.config.json` is present and the `auth_token` table is
      empty, it's accepted as a single-shot admin token AND auto-migrated
      into the table on first use. After migration, the config field is
      cleared.
- [ ] `tests/auth-tokens.test.ts` — mint a token, hit a route with it,
      assert success; revoke it, assert 401.

## Out of scope

- A web UI for token management. CLI only in v1.
- Token expiration. Manual revoke only.

## Engineering notes

- `src/db.ts` — new table, ALTER TABLE for the `actor_name` column.
- `src/server.ts` — refactor the existing `requireAuth` helper.
- `bin/fleetctl.ts` — new `tokens` subcommand.
- No new deps. Hash with `crypto.createHash('sha256')` from `node:crypto`.

## Implementation log

(Appended by the implementation-dev agent during execution.)
