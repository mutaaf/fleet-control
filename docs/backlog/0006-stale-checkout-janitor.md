---
id: 0006
title: Stale-checkout janitor with disk view
status: in-progress
priority: P1
area: infra
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator, I want fleet-control to show how much disk each
project's checkouts are using and offer a one-click cleanup, so that the
cache directories don't quietly fill the SSD.

## Why now (four lenses)

### Product Owner
`~/.cache/<slug>-agent-*-checkout` and `~/.cache/<slug>-agent` dirs grow
with every branch the agents touch and never get GC'd. One operator,
several projects, months → tens of GB. The portal should make this
visible.

### Stakeholder
Widens the moat on `infra`. The kit gets cheaper to run forever.

### Operator
Sees "agent-fleet: 1.2 GB across 18 stale checkouts" in the portal; one
tap cleans them.

### Growth
"Auto-janitor for agent caches" is the kind of polish that signals a
real product.

## Acceptance criteria

- [ ] `src/infra.ts` (new) — `diskUsage(slug)` returns
      `{bytes, checkout_count, oldest_age_days, candidates: [{path, age_days,
      bytes}]}` for everything under `~/.cache/<slug>-agent*`. Uses
      `node:fs/promises` `du`-equivalent (recursive `stat`).
- [ ] New action in `src/control.ts`: `clean-checkouts` with `older_than_days`
      param (default 14). Removes only stale checkouts; never touches
      `runs.jsonl`, `events.jsonl`, or `logs/`. Writes a `control_audit`
      row. Refuses to operate if any of the slug's launchd jobs is
      currently in `state = running` (reuse `isRunning`).
- [ ] `/api/projects/:slug/disk` returns the `diskUsage` shape.
- [ ] `web/app.js` per-project expandable section shows the disk view +
      "Clean checkouts older than 14 days" button.
- [ ] `tests/disk.test.ts` — create a fixture under a tmpdir with two
      checkout directories (one stale by mtime, one fresh), assert
      `diskUsage` counts them correctly; call `clean-checkouts` and
      assert only the stale one is removed.
- [ ] Safety: the cleaner refuses any path that doesn't start with
      `$HOME/.cache/<slug>-agent`. Strict regex check before `rm -rf`.

## Out of scope

- Cleaning `~/.claude/projects/*` transcript files. Separate ticket.
- Auto-clean on a schedule. Manual + portal button in v1.

## Engineering notes

- `src/infra.ts` — recursive disk usage, watch performance on large trees.
- `src/control.ts` — new action. Strict regex on the path before
  `rm -rf`. Use `node:fs/promises` `rm({recursive: true, force: true})`,
  not shelling out.
- `web/app.js` — small expandable section.
- No new deps.

## Implementation log

- 2026-05-26 — implementation-dev: branched `feat/0006-stale-checkout-janitor`,
  ticket flipped to `in-progress`. Plan: `src/infra.ts` for `diskUsage(slug)`
  via `node:fs/promises` recursive `stat` + a `clean-checkouts` action in
  `src/control.ts` guarded by `isRunning` and a strict `$HOME/.cache/<slug>-agent`
  prefix regex. `/api/projects/:slug/disk` exposes the shape; SPA grows an
  expandable section with the cleanup button. Tests: `tests/disk.test.ts`
  drives both the disk view and the cleaner end-to-end via a tmpdir fixture.
