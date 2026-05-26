---
id: NNNN
title: Short imperative title
status: proposed
priority: P2
area: portal
created: YYYY-MM-DD
owner: gtm-innovation
---

## User story

As a [specific persona — fleet operator at a glance, oncall during an
incident, new-project onboarder], I want [specific behavior], so that
[user-visible outcome — not engineering, not metrics].

## Why now (four lenses)

### Product Owner
What is the smallest meaningful unit of value? What gets *simpler* for the
operator, not just richer?

### Stakeholder
How does this widen the moat (uniform telemetry / cheaper observability /
safer control surface / faster onboarding)? If it doesn't widen the moat,
what specific pain does it cure that justifies the work?

### User (operator at 9am, looking at the portal)
What does this *feel* like? One glance or three? Resilient to a flaky run?
Does it work on the phone?

### Growth
Why does this make the control plane more pleasant to share or extend?
What's the "show me" moment?

## Acceptance criteria

Each box maps 1:1 to a test scenario. The dev agent writes the tests against
this list before writing code.

- [ ] [Observable behavior 1 — be specific.]
- [ ] [Observable behavior 2.]
- [ ] [A relevant regression check.]
- [ ] [Cross-cutting check — e.g. tsc still clean.]
- [ ] [Safety check — e.g. no shell-string composition.]

## Out of scope

Explicit anti-goals — the dev agent will not do these even if they seem
related.

- ...

## Engineering notes

Files / patterns the dev should touch. Specific enough that the dev doesn't
have to re-discover the architecture.

- `src/...` — what to change here
- `web/...` — if the SPA needs a tweak
- New deps: NO runtime deps (devDeps for tooling are fine). Lean on
  `node:sqlite`, `node:http`, the standard library, vanilla JS for SPA.
- Schema migration: yes/no, and at what version (db.ts schema is the source
  of truth — add `ALTER TABLE` lines under the existing schema block).

## Implementation log

(Appended by the implementation-dev agent during execution.)

- YYYY-MM-DD — branch `feat/NNNN-...` opened
- YYYY-MM-DD — failing test added in `tests/...`
- YYYY-MM-DD — PR #N opened, CI [state]
- YYYY-MM-DD — merged to main
