---
id: 0002
title: SSE live tool-call stream from active transcripts
status: in-progress
priority: P0
area: portal
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator watching the portal, I want to see the current run's
tool calls in real time, so that "is it stuck?" has a definitive answer
without me opening a terminal.

## Why now (four lenses)

### Product Owner
The single biggest UX win on the table. Today the portal polls and shows
"running" — opaque. With this, the operator sees "editing src/foo.ts" or
"running npm run typecheck" live.

### Stakeholder
Widens the moat on the portal as a glanceable surface. Demos better than
any other feature.

### Operator
Refreshes the page once an hour and immediately knows whether to intervene.
On a phone, the stream is just text — works on a flaky connection.

### Growth
The screenshot worth sharing. "My agent's tool calls, live, in my browser"
is memorable.

## Acceptance criteria

- [ ] New endpoint `GET /api/projects/:slug/stream` returns
      `text/event-stream`. On connect, finds the active transcript jsonl
      file (most recent under
      `~/.claude/projects/-Users-mutaafaziz--cache-<slug>-agent*/`) and tails
      it; sends one `event: tool-call` per `tool_use` entry with
      `{name, input_head: first 200 chars}` and `event: text` per assistant
      text turn (truncated to 500 chars).
- [ ] The endpoint closes the SSE connection when the transcript file is
      idle for >5 min (no new bytes) or when the client disconnects.
- [ ] Re-opens automatically against the new transcript file when a new
      run starts (detected by the `run_started` event from ticket 0001 OR
      a freshly mtime'd jsonl file).
- [ ] `web/app.js` "Now" panel shows a live "Current tool call:" line under
      each running project; updates without page reload.
- [ ] No buffering beyond what `node:http` provides; ResponseWriter sends
      events as they're parsed. Tail uses `fs.watch` (or
      `chokidar`-equivalent built on `fs.watch` — no new deps).
- [ ] Auth: loopback bypasses; remote requires `x-fleet-token` (existing
      pattern in `src/server.ts`).
- [ ] `tests/sse-stream.test.ts` — write 3 jsonl lines to a fixture,
      simulate the parser, assert the right event sequence is emitted.

## Out of scope

- Historical replay over SSE (open a transcript file from yesterday). Live
  only.
- Tool-call argument rendering beyond the head. v2 problem.
- Server-side multi-client fan-out optimization. Each operator gets their
  own tail.

## Engineering notes

- `src/server.ts` — add the route. The SSE write pattern:
  `res.setHeader("Content-Type", "text/event-stream")`,
  `res.write("event: tool-call\ndata: {json}\n\n")`.
- `src/live.ts` — new helper `tailTranscript(slug, onEvent)` that resolves
  the active jsonl path and streams entries. Use `fs.createReadStream` +
  `readline` for backfill, then `fs.watch` for incremental.
- `web/app.js` — `new EventSource('/api/projects/' + slug + '/stream')`.
  Append to the "Now" panel.
- No new runtime deps. `node:fs` `fs.watch` is sufficient on macOS.
- Blocked-by: 0001 (uses the event marker as a hint when a new run starts).

## Implementation log

- 2026-05-26 — implementation-dev: branched `feat/0002-sse-toolcall-stream`,
  flipped status to `in-progress`. Plan: extend `src/live.ts` with a
  `tailTranscript(slug, onEvent, opts)` helper (readline backfill + fs.watch
  incremental, 5-min idle timeout, re-open on rotation), add
  `GET /api/projects/:slug/stream` (text/event-stream; loopback bypass or
  `x-fleet-token`) in `src/server.ts`, wire an `EventSource` into
  `web/app.js`'s "Now" panel. Zero new runtime deps — node:fs + node:readline
  + node:http only.
