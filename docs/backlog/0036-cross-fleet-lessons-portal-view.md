---
id: 0036
title: Cross-fleet lessons portal view - the file the operator never sees becomes a daily surface
status: in-progress
priority: P1
area: portal
created: 2026-06-03
owner: gtm-innovation
---

## User story

As a fleet operator triaging a fresh red PR on Tuesday at 11pm whose
symptom rings a faint bell ("haven't I seen this exact
`mergeStateStatus: BEHIND` before?"), I want a `/lessons` page in
the portal that renders the contents of
`~/.local/share/agent-fleet/CROSS_LESSONS.md` (the cross-project
fleet memory the autonomous agents already maintain) with full-text
search and a "this week's new lessons" filter, so that the wisdom
the agents accumulate across every project becomes a surface I
actually open - instead of a markdown file I forget exists living
in a path I can't remember.

## Why now (four lenses)

### Product Owner
The file at `~/.local/share/agent-fleet/CROSS_LESSONS.md` is auto-
synced by `fleet lessons-sync` from every project's
`docs/LESSONS.md`. It's 630+ lines today across 4+ projects and
grows every ship. The contents are EXACTLY the operator's
collective debugging memory - "GitHub Actions silently stops
firing on a PR," "shallow-clone artifacts make orphan PRs look
healable," "vitest mock queue overflows after editing a shared
route." But the file is invisible to the operator unless they
`cat` it manually. The portal shows live runs, cost, anomalies,
inbox - and zero accumulated wisdom. A `/lessons` page that
parses the file's known structure (per-project `##` headers,
date-prefixed `###` entries OR dash-prefixed inline entries),
indexes it for client-side search, and lets the operator filter
to "this week's new entries" turns the asset into a daily
surface. Pure read - no edits, no schema. The dev agent's
weekly groom would naturally check the new-this-week filter
before proposing tickets, closing a loop on the autonomous
loop itself.

### Stakeholder
Widens the moat on `portal` and retention with the strongest
moat-deepening surface in this batch. The cross-project lessons
file is the SINGULAR fleet-control asset whose value compounds
with every ship across every project - 0008's anomaly detector
fires more accurately because it learned "anomaly tests need
sigma > 0 in the fixture"; 0009's ntfy bridge dedupes correctly
because it learned "in-process dedup sets need an explicit reset
hook for tests." This is institutional memory the operator has
already PAID for in time-spent-debugging. Making it browseable
in the same SPA the operator already opens daily is the cheapest
moat-widening move in the backlog: structurally impossible for
any tool that doesn't already manage the operator's fleet (the
file is on-disk; a SaaS would need to ingest it, and the operator
would never upload their failure log to a vendor). Per the
cross-fleet courtiq lesson "the share-worthy moment is the
structural impossibility for other tools," a screenshot of "the
portal that remembers every bug your AI ever caused" is a
distinct angle from cost ($/PR is 0035) or drift (0034).

### User (operator at 11pm during a red-PR incident)
A new top-bar link `LESSONS` appears between the existing brand
and the fleet-summary. Tap it; `/lessons` renders:

```
LESSONS                                          [search: ___]
                                                 [x] new this week (3)

agent-fleet  (8 lessons)
  2026-05-26  GitHub Actions can silently stop firing for a PR
  2026-05-26  bash scripts launched with & cannot be SIGINT-tested
  ...

courtiq  (47 lessons)
  2026-05-21  An e2e spec mocked /api/share/<token> via page.route()...
  ...

fleet-control  (24 lessons)
  2026-05-26  in-process startServer() tests need empty-roots config
  2026-05-29  time-pinned tests must NOT derive seed timestamps...
```

Tap any entry to expand the full paragraph in-line. The search
input filters by substring across symptom + cause + fix (case-
insensitive); the "new this week" checkbox filters to entries
whose ISO date is within the last 7 days. Empty search + no
filter shows the full file (collapsed to titles for fast scan).
Mobile: the project sections collapse to accordion headers tap-
to-expand. The page reads from a new `GET /api/fleet/lessons`
that parses the file once per request and returns structured
JSON; the SPA does the search/filter client-side so it stays
snappy on a phone.

### Growth
The screenshot worth sharing is the search box typed with
"GitHub Actions" - returning 3 hits across 2 projects with the
full failure mode and the fix inline. The pitch sentence:
"fleet-control remembers every gnarly bug your agents ever
caused, across every project, and lets you grep them at 11pm
when the same one re-fires." This is a categorically different
share-worthy moment from cost ($/PR is 0035), drift (0034), or
streak (0026) - it sells the LEARNING surface, which is what
distinguishes an autonomous loop from a one-shot script. A
prospective operator who sees this understands the time-saved
proposition viscerally - it's the artifact you can't fake.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/lessons.ts` (new) exports
      `parseCrossLessons(text: string): {projects: Array<{slug:
      string, lessons: Array<{date: string | null, title: string,
      body: string, kind: "h3" | "bullet"}>}>, parsed_at: string,
      total: number}`. The parser recognises TWO entry styles
      from CROSS_LESSONS.md: (a) `### YYYY-MM-DD - <title>`
      headers followed by paragraph body until the next `###`
      or `##`, and (b) `- YYYY-MM-DD [phase] SYMPTOM -> CAUSE
      -> FIX` single-line bullets under a project's `### Entries`
      section. The project boundary is the `## <slug>` H2
      header. Entries without a parseable date carry `date:
      null` and are still included. Per LESSONS § "node:sqlite's
      .all() needs `as unknown as T[]`", no SQL is involved so
      no narrowing - pure string parsing. Test: feed a fixture
      with one project of each entry style + one undated entry,
      assert the parsed shape including counts.
- [ ] Path resolution: `src/lessons.ts` exports
      `defaultLessonsPath(): string` returning
      `path.join(homedir(), ".local", "share", "agent-fleet",
      "CROSS_LESSONS.md")` by default, overridable via env
      `FLEET_CROSS_LESSONS_PATH`. When the file does not exist,
      `loadCrossLessons(path)` returns `{projects: [], parsed_at:
      <now>, total: 0, source_present: false}` (does NOT throw).
      Test: stub the env to a tmpdir with no file, assert the
      empty shape with `source_present: false`; stub to a real
      fixture file, assert `source_present: true` and the
      parsed contents.
- [ ] `GET /api/fleet/lessons` returns
      `{projects: [...], parsed_at: string, total: number,
      source_present: boolean, new_this_week: number}` where
      `new_this_week` is the count of entries whose `date` is
      within the last 7 ISO days. Requires `read` scope. Test:
      hit without auth -> 401; with `read` -> 200 plus the shape;
      assert `new_this_week` matches a fixture with 3 recent
      entries.
- [ ] Caching: the route response sets `Cache-Control: max-age=
      120` (2 min) AND the handler memoises by file mtime - if
      the file's mtime hasn't changed, return the cached parse.
      Per LESSONS § "in-process dedup sets need an explicit reset
      hook for tests", expose `_resetLessonsCacheForTests()` AND
      `_getLessonsCacheBuildsForTests()`. Test: two requests in
      a row assert the build counter increments once; touch the
      file's mtime via `fs.utimesSync`, assert the next request
      increments again.
- [ ] File-size safety: when the source file is larger than 2MB,
      `loadCrossLessons` returns `{projects: [], parsed_at: <now>,
      total: 0, source_present: true, oversized: true}` and the
      route returns 200 with the oversized payload (NOT a 500).
      This prevents a runaway file from OOMing the server. Per
      AGENTS.md Hard NOs, no shell-out to read the file - use
      `fs.readFileSync` with the size precheck via `fs.statSync`.
      Test: stub a 3MB fixture, assert the oversized payload and
      a 200 response.
- [ ] `web/app.js` adds a new top-bar link `LESSONS` between the
      brand and the fleet-summary, and a hash route `/lessons`
      that renders the page. Project sections render as `<h2>
      <slug> (<count>)</h2>` with a `<details>` per entry whose
      `<summary>` is `<date> <title>` and whose body is the full
      paragraph. The search input filters client-side by
      substring (case-insensitive) across `title + body`; the
      "new this week" checkbox filters by the entry's `date`
      being within 7 days of `Date.now()`. Per LESSONS §
      "defence-in-depth secret redaction at the renderer
      boundary", every entry title and body passes through
      `redactSecrets` before insertion - the lessons file
      historically contains token-shaped artifacts (SHAs, file
      paths, repo URLs) that the redactor's existing patterns
      should NOT trigger on, AND any future leak of an actual
      token in a lesson is silently stripped. The page container
      has `data-testid="cross-lessons"` for stable phone-test
      hooks. Test: stub the API with 2 projects of 3 entries
      each, type "GitHub" in the search, assert only matching
      entries are visible; check "new this week", assert only
      recent entries remain.
- [ ] Empty / missing state: when `source_present: false`, the
      page renders a friendly empty state: a short paragraph
      explaining `~/.local/share/agent-fleet/CROSS_LESSONS.md`
      doesn't exist yet, plus a link to the agent-fleet kit's
      `lessons-sync` doc (one anchor `<a>` to the agent-fleet
      repo README on GitHub). NO error, NO crash. Test: stub
      the API with `source_present: false`, assert the empty-
      state copy and the anchor are rendered.
- [ ] Mobile: at 375px viewport the project sections render as
      collapsed accordion headers (closed by default). The
      search input sits sticky at the top so the operator can
      type while scrolling. No horizontal scroll (per 0011
      conventions). The "new this week" checkbox sits below
      the search input on phone, beside it on >=600px. Test:
      assert via the existing mobile-portal text-level CSS
      contract at 375px and 600px.
- [ ] Performance: `parseCrossLessons` on a 200KB fixture (the
      current production file size + 3x growth headroom)
      completes in under 30ms. The HTTP route end-to-end (cache
      miss) completes in under 80ms. Per LESSONS § "in-process
      startServer() tests need an empty-roots config + run-row
      seeds", the server-boot tests plant a tmp
      `fleet-control.config.json` in cwd and restore on
      cleanup. Test: time both, assert thresholds (skip if
      `process.env.PERF !== "1"`).
- [ ] Daemon hook: `src/daemon.ts` gains a once-per-day
      check that compares `total` against the previous day's
      `total` (persisted in a new `kv` row OR reuse the
      existing `watermark` table with a fixed key
      `cross_lessons_total`). When the count increases by
      >=1, emit ONE inbox row (kind `lessons_new`) with the
      headline "N new fleet lessons since yesterday" linking
      to `/lessons?filter=new`. Per LESSONS § "re-fire-after-
      dismiss needs an aging window, not a partial UNIQUE
      index", idempotency uses a `WHERE created_at >=
      now - 24h` lookup before INSERT. Test: seed yesterday's
      watermark at 100; load a file with 103 entries; assert
      one inbox row with the count `3`; run again same tick,
      assert no duplicate.
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-string
      composition. No JSON-shape break to any existing
      `/api/...` route - the new `/api/fleet/lessons` route is
      net-new; the inbox kind `lessons_new` is additive (the
      SPA's existing switch tolerates unknown kinds per the
      0027 ship pattern). No schema migration in v1 - the
      daemon hook reuses the existing `watermark` table with
      a new key. Per LESSONS § "no backticks inside template-
      literal SQL strings", identifiers in any new SQL stay
      plain. The parser is pure-JS regex over the file text -
      no AST library, no markdown parser dep.

## Out of scope

- An EDIT surface (operator types a new lesson in the portal,
  it gets appended to the file). The file is auto-managed by
  `fleet lessons-sync` from per-project `docs/LESSONS.md`;
  letting the portal write to it bypasses the canonical
  per-project authorship trail. A clean follow-up if asked.
- Cross-fleet lesson SEARCH from the CLI (`fleetctl lessons
  search 'github actions'`). The portal is the v1 surface;
  a CLI subcommand is a natural follow-up after the parser
  ships.
- LLM-authored "this lesson applies to your current incident"
  suggestions. The search input + the operator's eyes is
  sufficient; an LLM-summarisation surface adds runtime cost
  and a dependency.
- Lessons attribution / authorship metadata (which agent
  wrote the entry). The lessons file is per-project, not
  per-agent; attribution belongs upstream in the per-project
  LESSONS.md.
- A "mark this lesson as obsolete" surface. Lessons file
  pruning is an explicit `groom`-phase activity per the
  cross-fleet rules; a portal surface for pruning would
  fragment the workflow.
- Syncing the file from this portal (calling out to
  `fleet lessons-sync`). That bridges into agent-fleet's
  control surface, which lives outside fleet-control's
  shell-out boundary per AGENTS.md Hard NOs.
- Real-time updates (file-watch + SSE). The 2min mtime
  cache is responsive enough for a non-real-time surface;
  file-watch adds an `fs.watch` lifecycle bug surface
  documented in LESSONS § "async streaming tails: snapshot
  the path before each read" that we don't need to
  re-introduce.

## Engineering notes

- `src/lessons.ts` (new) - the parser + loader. Pure
  functions; the only I/O is one `fs.readFileSync` gated
  by `fs.statSync` for the size check. The parser is two
  regex passes: one for `## <slug>` boundaries, one for
  `### YYYY-MM-DD - <title>` headers + `- YYYY-MM-DD
  [phase] ...` bullets within each project block. Per
  LESSONS § "node:sqlite's .all() needs `as unknown as
  T[]`", no SQL is involved here - the lesson is N/A.
- `src/server.ts` - one new route `GET /api/fleet/lessons`.
  Reuse the existing `read` scope middleware. The mtime
  cache is a module-level `{path, mtimeMs, value}` per
  LESSONS § "expose a build counter for cache-hit tests,
  not a fetcher swap" - expose `_resetLessonsCacheForTests()`
  and `_getLessonsCacheBuildsForTests()`.
- `src/daemon.ts` - one new daily check that diffs the
  parsed total against the previous day's watermark and
  emits one inbox row when the delta is >=1. Per LESSONS
  § "re-fire-after-dismiss needs an aging window, not a
  partial UNIQUE index", the inbox idempotency lives in
  the application via a 24h lookup, not a UNIQUE
  constraint.
- `src/inbox.ts` - one new sub-query branch for the
  `lessons_new` kind. The row's payload is `{count, since:
  string}` so the SPA can render the headline without a
  second fetch. Sorted below `fleet_correlation` (0027) and
  `self_drift` (0034), above `pr_review`.
- `src/server.ts` route handler reads
  `process.env.FLEET_CROSS_LESSONS_PATH` first, falls back
  to the homedir default per `defaultLessonsPath()`. Per
  LESSONS § "CLI subprocess tests need a FLEET_DB_PATH env
  seam", the env seam is the single test override.
- `web/app.js` - new top-bar `LESSONS` link wired into the
  existing hash router. New `renderLessonsPage(data)`
  helper that builds the `<details>` tree from the parsed
  shape. Search and filter are vanilla `addEventListener`
  on the inputs; the handler walks the existing DOM and
  toggles `hidden` on non-matching `<details>` (NO
  re-render). Per LESSONS § "defence-in-depth secret
  redaction at the renderer boundary", every operator-
  visible string passes through `redactSecrets` before
  insertion.
- `web/style.css` - one selector group for the lessons
  page (project H2 spacing, `<details>` summary affordance,
  sticky search input on mobile). Reuse existing CSS
  variables - no new palette.
- `tests/lessons.test.ts` (new) - unit tests for the
  parser (per AC1/AC5), env-resolution tests (per AC2),
  HTTP tests for the new route (per AC3/AC4), the empty-
  state test (per AC7), the SPA filter tests (per AC6),
  the daemon-hook test (per AC9). Per LESSONS § "in-
  process startServer() tests need an empty-roots config
  + run-row seeds", the server tests plant a tmp
  `fleet-control.config.json` in cwd and restore on
  cleanup. Per LESSONS § "time-pinned tests must NOT derive
  seed timestamps from `new Date()`", every seed entry's
  date in the fixture anchors to the test's pinned `now`.
- `tests/fixtures/cross-lessons-sample.md` (new) - a small
  copy of the production file structure (2 projects, 6
  entries, mix of `###` and `-` styles, one undated entry)
  used by the parser tests. Committing a fixture (not
  reading the real file in CI) keeps tests deterministic.
- No new runtime deps. No schema migration. Pairs with
  0017 (inbox is the daemon-hook surface for new lessons),
  0027 + 0034 (the existing observability surfaces feed
  the same inbox - lessons sit below them), 0011 (mobile-
  first portal conventions), 0024 (welcome could grow a
  "you have N fleet lessons" footer line in a follow-up),
  and 0033 (the morning glance's verdict cascade could
  add a `lessons_new` branch in a follow-up).

## Implementation log

(Appended by the implementation-dev agent during execution.)

- 2026-06-03 - branch `feat/0036-lessons-portal-view` opened
