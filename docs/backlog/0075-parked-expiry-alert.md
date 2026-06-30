---
id: 0075
title: Portal flags parked / near-expiry projects so a silent fleet-wide stall is impossible to miss
status: groomed
priority: P1
area: observability
created: 2026-06-30
owner: operator
---

## User story

As a fleet operator glancing at the portal each morning, I want every project
to show how close it is to its `SELF_CANCEL` cliff — and shout when it has
already passed it — so that a fleet-wide silent stall is impossible to miss
instead of something I discover days later.

## Why now (four lenses)

### Product Owner
This is a real incident, not a hypothetical: on 2026-06-25 every project's
`SELF_CANCEL` lapsed and the fleet stopped shipping for ~5 days before the
operator noticed. `fleetd` even logged "self-drift detection," but the portal —
the thing the operator actually looks at — gave no glanceable signal. The
smallest unit of value is a per-project countdown + a loud EXPIRED/PARKED state
on the card.

### Stakeholder
"Live telemetry without an LLM" is the moat; a stall the dashboard can't see is
the moat leaking. Surfacing self-cancel state turns the portal from a
fair-weather view into one the operator can trust to catch the worst case — the
whole fleet quietly off.

### Operator (9am phone glance)
A green-but-idle fleet must never look the same as a healthy one. A `parks in 3d`
chip that flips to a red `PARKED — re-arm` banner answers "why is nothing
shipping?" in one glance, with the re-arm command one tap away.

### Capability — for the operator, NOT an audience
Pure operator trust, no shareable surface. The "show me" moment is the operator
seeing the cliff before they fall off it.

## Acceptance criteria

- [ ] Each project card shows days-until-`SELF_CANCEL`, read from the same
      manifest the loop uses (`~/.local/share/agent-fleet/projects/<slug>/agents.config.sh`),
      with no LLM call.
- [ ] When `today >= SELF_CANCEL`, the card renders a prominent `PARKED` state
      (distinct color/badge) and the project sorts to the top of the list.
- [ ] When within a warning window (default 5 days), the card shows a `parks in
      Nd` chip.
- [ ] A fleet-level banner appears when ANY project is parked or in-window,
      summarizing "N project(s) parked, M near expiry," with the exact re-arm
      command (or a wired re-arm control if one exists).
- [ ] The expiry view degrades gracefully when a project's installed manifest is
      missing or `SELF_CANCEL` is unparseable (shows "unknown", never crashes).
- [ ] No new runtime deps; no breaking change to existing `/api/...` JSON shapes
      (add a field/route, don't repurpose one). Test scenarios cover parked,
      in-window, healthy, and missing-manifest cases.

## Out of scope

- Auto-re-arming (operator decides to extend — the switch is intentional).
- Re-implementing `fleetd`'s alert rules; this is the *visual* portal surface.
  If `fleetd` already emits a self-cancel alert, consume it; don't duplicate the
  detection logic.

## Engineering notes

- `src/live.ts` / `src/views.ts` — compute days-to-expiry per project from the
  installed manifest already discovered by `src/discovery.ts`.
- `src/server.ts` + `web/` — expose the field and render the card chip / banner;
  reuse the existing project-card and telemetry-strip components.
- New deps: none (`node:` builtins only). JSON additive only.

## Implementation log

(Appended by the implementation-dev agent during execution.)
