---
id: 0009
title: ntfy push notifications for high-priority events
status: groomed
priority: P2
area: observability
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator away from my laptop, I want a phone push when the
fleet hits a self-cancel, an open PR sits >2h with green CI, or an anomaly
fires, so that I can intervene without checking the portal proactively.

## Why now (four lenses)

### Product Owner
The local daemon already does osascript alerts (P7 in the existing
build); they're useless when the operator isn't at the desk. ntfy.sh is
free, anonymous, and HTTP-only — perfect for this.

### Stakeholder
Widens the moat on `observability`. Pairs with anomaly detection (0008)
and budget caps (agent-fleet 0004).

### Operator
Phone buzzes: "almanac: PR #82 sat 2h with green CI — tap to approve."

### Growth
The kit becomes operable from anywhere, on any device, with zero infra.

## Acceptance criteria

- [ ] `src/alerts.ts` gains an `ntfyRule(rule, payload)` function that
      POSTs to `https://ntfy.sh/<topic>` with a JSON body
      `{title, message, priority, tags, click}`.
- [ ] Topic comes from a new field in `fleet-control.config.json`:
      `ntfyTopic`. If unset, ntfy is silently disabled (osascript only).
- [ ] Rules that fire ntfy in v1:
      - `self_cancel_trip` event from any slug
      - `budget_block` event from any slug (depends on agent-fleet 0004)
      - `anomaly` row inserted (depends on 0008)
      - PR sat >2h on `mergeStateStatus=CLEAN` with no merge (existing
        daemon already checks; add the ntfy channel as a parallel alert)
- [ ] The `click` URL points at the operator's portal
      (default: `http://127.0.0.1:7070/project/<slug>`; configurable via
      `portalUrl` in config).
- [ ] Best-effort: HTTP failure logs and continues. The daemon never
      crashes because ntfy is down.
- [ ] `tests/ntfy.test.ts` — stub `node:https` request, call `ntfyRule`
      with a known payload, assert the body matches.
- [ ] `bin/fleetctl.ts ntfy test` POSTs a test message to verify the
      operator's setup.

## Out of scope

- Per-rule topics. One topic for all rules in v1.
- Authenticated ntfy. Free public topics only.
- iOS-specific actions. Plain notifications.

## Engineering notes

- `src/alerts.ts` — extend the existing alert dispatch.
- `src/daemon.ts` — wire up the new rules.
- `fleet-control.config.json` — add `ntfyTopic`, `portalUrl`.
- No new deps. Use `https.request` from `node:https`.

## Implementation log

(Appended by the implementation-dev agent during execution.)
