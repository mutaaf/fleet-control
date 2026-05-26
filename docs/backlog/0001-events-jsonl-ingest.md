---
id: 0001
title: Ingest events.jsonl from each project
status: in-progress
priority: P0
area: ingest
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator, I want fleet-control to ingest each project's
`~/.cache/<slug>-agent/events.jsonl` directly, so that the portal stops
guessing run identity from transcripts and unlocks downstream tickets
(forecast, anomaly detection, push alerts).

## Why now (four lenses)

### Product Owner
The simplest unit of value — a stable typed event channel under everything
else. agent-fleet ticket 0002 produces it; this ticket consumes it.
Without this, half of fleet-control's roadmap reads transcripts heuristically.

### Stakeholder
Widens the moat on `ingest`. Replaces transcript scraping with a typed
contract. Future consumers (push alerts, forecast, anomaly) read the same
table.

### Operator
Today the "Now" panel guesses what's happening from a transcript tail. After
this, it reads the most recent `run_started` event and shows the exact
phase + pid with zero ambiguity.

### Growth
"Typed event stream → portal" is the kind of plumbing a careful builder
recognizes immediately.

## Acceptance criteria

- [ ] New table in `src/db.ts`: `event(slug TEXT, ts TEXT, phase TEXT,
      type TEXT, payload_json TEXT)` with an index on
      `(slug, ts DESC)`. Schema is created idempotently alongside the
      existing tables.
- [ ] `src/ingest/events.ts` (new file) — function `ingestEvents(db, slug)`
      that reads `~/.cache/<slug>-agent/events.jsonl`, dedupes against a
      `watermark` row (`kind='events'`, slug-scoped), inserts new lines.
      Tolerant of malformed lines (log and skip).
- [ ] `bin/fleetctl.ts backfill` calls `ingestEvents` for every discovered
      project after the existing `ingestTranscripts` pass.
- [ ] `src/server.ts` `/api/projects/:slug/events?limit=N` returns the last
      N events as JSON.
- [ ] `web/app.js` "Now" panel uses `/api/projects/:slug/events?limit=1` to
      determine current phase if a recent `run_started` (within 30 min) is
      present; falls back to the existing transcript-tail logic otherwise.
- [ ] `tests/ingest-events.test.ts` — write a fixture `events.jsonl` with
      3 lines (one malformed), call `ingestEvents`, assert 2 rows inserted;
      run again, assert 0 new rows (idempotent).
- [ ] No new runtime deps. `tsc --noEmit` clean.

## Out of scope

- Retention / GC of the `event` table. Future ticket.
- A separate UI for browsing events. v1 is "feed the Now panel + provide a
  JSON endpoint".

## Engineering notes

- `src/db.ts` — add the table next to the existing `run_event` block. Watch
  out for naming collision; suggest `agent_event` if needed.
- `src/ingest/events.ts` — mirror the shape of `src/ingest/transcripts.ts`:
  watermark + line-by-line scan. JSONL is one event per line.
- `src/server.ts` — add the route inside the existing project handler.
- `web/app.js` — small additive change to the "Now" panel.
- Blocked-by: agent-fleet ticket 0002 (the events.jsonl source).
- No new deps.

## Implementation log

- 2026-05-26 — implementation-dev: opened `feat/0001-events-jsonl-ingest`,
  flipped status to in-progress, drafted failing test
  `tests/ingest-events.test.ts` (fixture with 3 lines incl. one malformed,
  expects 2 inserts then 0 on a second pass). Plan: add `agent_event` table
  (avoid `event` reserved-keyword feel) + `(slug, ts DESC)` index, watermark
  source key `events:<slug>`, mirror `runs.jsonl` byte-offset cursor pattern
  for crash-safe re-reads. New file `src/ingest/events.ts` + wiring in
  `src/ingest/index.ts` and `bin/fleetctl.ts backfill`. New route
  `/api/projects/:slug/events?limit=N` (slug-scoped, no auth — read-only
  read-side). "Now" panel additive: when most recent `run_started` is within
  30 min, show `phase` from the event; else keep transcript-tail fallback.
