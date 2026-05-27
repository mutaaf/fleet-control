---
id: 0020
title: keep-running and eng-toggle clobber installed manifest when working tree is stale
status: in-progress
priority: P1
area: control
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator, I want "Keep it running (+30 days)" and "Also tidy
the code" to be safe even when my local working tree is behind
origin/main, so that clicking those buttons doesn't silently revert
unrelated manifest fields (cadence, MAX_DAILY_USD) to their pre-merge
values.

## Why now

Same root cause that hit set-budget (fixed in PR #42): the action edits
the working-tree manifest, then `install.sh` cp's it over the installed
copy. When local main is behind origin/main — which happens easily when
autonomous agents merge PRs faster than the operator pulls —
`install.sh` faithfully copies a stale manifest over a current one,
silently reverting whatever the operator changed since the local
checkout last pulled.

Concrete blast radius today (agent-fleet, fleet-control): one click on
"Keep it running" or "Tidy the code" could undo `set-cadence-fleet`,
prompt-SHA pins, and any other field touched by an automerged PR since
local last pulled. Loud failure mode — and easy to miss because
launchctl re-bootstraps cleanly with the stale plist.

### Product Owner
"Keep it running" should mean *only* "bump SELF_CANCEL". It does that
plus an invisible side effect right now.

### Stakeholder
Widens `control` safety. The portal stops being a footgun on a stale
machine.

### Operator
Trust restored. The buttons do what their labels say.

### Growth
"Stale local? Doesn't matter — the portal writes to the installed copy
that launchd actually reads" is the kind of robustness story worth
telling.

## Acceptance criteria

- [ ] `keep-running`:
  - Reads the **installed** manifest path
    (`~/.local/share/agent-fleet/projects/<slug>/agents.config.sh`).
  - Calls `editManifest(installed, "SELF_CANCEL", ymd)`. SELF_CANCEL is
    a plain env var read by `fleet_self_cancel`; no plist regeneration
    is needed. Skip `install.sh` entirely.
  - Mirrors into the working-tree manifest best-effort (same pattern
    as set-budget after PR #42) so the operator can `git commit` it.
- [ ] `eng-toggle`:
  - DOES need install.sh because the eng plist appears/disappears.
  - But sources from the installed manifest dir. Sequence:
    1. `editManifest(installed, "ENG_ENABLED", on)`
    2. `bash KIT_INSTALL <installed-dir>` (so install.sh re-reads from
       there; the cp inside install.sh is a no-op via the `-ef` guard).
    3. Best-effort mirror into the working tree.
  - Verify against the existing `-ef` short-circuit in install.sh; this
    relies on it staying.
- [ ] `tests/control-staleness.test.ts` —
  - Fixture: working-tree manifest with `SHIP_HOURS="0 12"`, installed
    manifest with `SHIP_HOURS="0 6 12 18"` (working tree is stale).
  - Call `keep-running` action. Assert installed `SHIP_HOURS` is
    unchanged AND `SELF_CANCEL` was bumped.
  - Call `eng-toggle` (enabled=1). Assert installed `SHIP_HOURS` is
    unchanged AND `ENG_ENABLED=1`.
- [ ] No new runtime deps. tsc clean.

## Out of scope

- `set-cadence` / `set-pace` / `set-pace-fleet` — those *intentionally*
  rewrite cadence fields, so they need a different strategy (probably
  a working-tree pre-fetch + ff-only pull, OR write to installed
  primary with working-tree mirror). Separate ticket; design discussion
  needed.
- A general "all manifest writes go to installed-only" refactor. The
  scope is the two actions that today have the most-visible bug.

## Engineering notes

- `src/control.ts` — `keep-running` and `eng-toggle` cases.
- Pattern is the same as the set-budget fix in PR #42: prefer the
  installed manifest; mirror into the working tree best-effort.
- Reuse the existing `editOrAppendManifest` / `editManifest` helpers.
- For eng-toggle, double-check that passing the installed dir to
  install.sh re-runs `launchctl bootout`/`bootstrap` cleanly. The
  `-ef` guard added earlier in agent-fleet's `lib/install.sh` is what
  makes this safe — verify it's still in place when this ticket lands.

## Implementation log

- 2026-05-27 — picked up by implementation-dev. Branch
  `feat/0020-keep-running-eng-toggle-stale-tree`. Plan: route both
  actions through the installed manifest (the one launchd actually reads)
  and only mirror into the working tree best-effort, mirroring the
  set-budget fix from PR #42. `keep-running` skips `install.sh` entirely
  (SELF_CANCEL is a plain env var); `eng-toggle` keeps `install.sh` but
  passes the installed manifest dir so the cp inside is a no-op via
  the `-ef` guard. New `tests/control-staleness.test.ts` seeds a stale
  working tree + a current installed manifest and asserts neither
  action loses the operator's unrelated cadence edit.
