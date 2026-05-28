---
id: 0027
title: Cross-project failure correlation - same error in N projects fires a fleet alert
status: in-progress
priority: P1
area: observability
created: 2026-05-28
owner: gtm-innovation
---

## User story

As a fleet operator who maintains 5 projects that share a Node version,
a TypeScript config, and an `agent-fleet` kit, I want fleet-control to
notice when the SAME failure mode (a specific TS error code, a
`git push` 403, a `gh: command not found`) hits two or more projects
within 24 hours and raise ONE fleet-level alert naming the affected
projects, so that I diagnose the shared root cause once instead of
playing whack-a-mole across five identical-looking red PRs.

## Why now (four lenses)

### Product Owner
The anomaly detector (0008) catches per-project outliers; the inbox
(0017) lists per-project actionables. Neither sees the *fleet
pattern*: that the same root cause is breaking three projects at
once. A correlation pass that groups recent failures by a normalised
signature ("TS2304 - Cannot find name") and fires a single
`anomaly.kind='fleet_correlated'` row when N>=2 turns five
indistinguishable red PRs into one diagnostic question. This is
strict subtraction of operator work, not addition of features.

### Stakeholder
This is the single strongest moat-deepening ticket in the backlog.
The correlation can ONLY be drawn by software with simultaneous
read access to every project's transcripts, CI logs, and run
telemetry - and that is precisely the property fleet-control has
that no SaaS dashboard does. A per-repo CI integration cannot see
that the SAME `gh: 403` hit two operator's projects this morning;
fleet-control sees both as rows in the same database. Every
correlated alert it fires is a feature no competing tool can
honestly ship.

### User (operator at 9am)
On the inbox section, a new item kind appears at the top when a
correlation fires: "3 projects failing with TS2304 since 03:12" -
with the project slugs as chips and a one-tap "investigate" action
that opens a new `/api/fleet/correlations/:id` page showing the
three first-fail check excerpts side-by-side. When no
correlations are active, the inbox is unchanged. Dismissing a
correlation hides it from the inbox; the row persists in the
`anomaly` table for the leaderboard (0014) to count.

### Growth
"It notices when the same thing is breaking across all your
projects" is the strongest sentence about why this tool isn't
just a per-repo dashboard with extra steps. The screenshot of
three project chips clustered under one root cause is the
clearest possible "show me" for what local-only telemetry buys.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/correlate.ts` (new) exports `detectCorrelations(db, now)`
      returning `Array<{signature: string, project_slugs: string[],
      first_seen_at: string, last_seen_at: string, sample_excerpt:
      string}>`. A "correlation" is a `signature` that appears in
      >=2 distinct project slugs' failures within the last 24h.
      Test: seed three projects with `first_fail_check='typecheck'`
      and `first_fail_excerpt` containing `TS2304`, run the
      detector, assert one row with all three slugs.
- [ ] Signature derivation: a single helper
      `failureSignature(check_name, excerpt)` extracts a stable
      key from a CI failure. Rules:
      * TS error: `/TS\d{4}/` -> `"TS####"` (e.g. `"TS2304"`).
      * Git push auth: `/remote: (Permission denied|HTTP 403)/`
        -> `"git-push-403"`.
      * gh CLI missing: `/gh: command not found/` -> `"gh-missing"`.
      * Node not found: `/node: command not found/`
        -> `"node-missing"`.
      * npm install fail with EACCES: `/EACCES.*npm/`
        -> `"npm-eacces"`.
      * Any unmatched excerpt -> `null` (no signature, not
        correlated).
      Test: each pattern returns the expected signature; an
      unmatched excerpt returns `null`.
- [ ] Schema migration: extend the `pr` table with a
      `first_fail_excerpt TEXT` column (idempotent ALTER per the
      existing pattern). Update `src/ingest/prs.ts` to read the
      first 200 chars of the first failing check's log output via
      `gh run view --log-failed` (already an argv-array
      `execFile` call - keep the runner seam injectable). NULL
      when no failing check. Test: stub the runner with a canned
      log payload, assert the column populated; old rows with
      NULL excerpt are untouched.
- [ ] Schema migration: extend the `anomaly` table with two new
      columns - `kind TEXT DEFAULT 'duration_outlier'` and
      `correlation_signature TEXT` (idempotent ALTERs). All
      existing anomaly rows carry `kind='duration_outlier'`
      (NULL-tolerant default) so prior writes survive. Test:
      open a DB without the columns, assert the migration adds
      them and existing rows still read.
- [ ] Daemon hook: after each ingest tick, run
      `detectCorrelations` and INSERT one `anomaly` row per
      NEW correlation (matched by `correlation_signature` and
      a 24h window). Re-detecting the same correlation in the
      same window does NOT insert a duplicate. Test: run the
      hook twice in a row, assert exactly one anomaly row.
- [ ] `GET /api/fleet/correlations` returns the active list
      (correlations fired in the last 24h, not dismissed).
      Requires `read` scope. Test: hit without auth -> 401,
      with `read` -> 200 plus the array.
- [ ] `fleetInbox` (0017) gains a new item kind
      `fleet_correlation` for each active correlation, sorted
      above other kinds (a fleet-wide pattern is more urgent
      than a single project issue). Test: seed one
      correlation, assert it appears as the first inbox item.
- [ ] `web/app.js` renders the correlation inbox item with the
      affected project chips inline and an "investigate" action
      that navigates to `/correlation/:signature`. The detail
      view shows the signature, the affected projects, and the
      first 200 chars of each project's failure excerpt side-by-
      side. Per LESSONS § "defence-in-depth secret redaction at
      the renderer boundary", excerpts pass through
      `redactSecrets` before render. Test: stub two projects'
      excerpts containing a fake `ghp_...` token, assert the
      rendered DOM does not include the literal.
- [ ] Dismissal: the inbox's existing dismiss action accepts
      `kind='fleet_correlation'`, which inserts an
      `inbox_dismissal` row (per 0017) for the signature and
      hides it from the inbox until a NEW correlation with the
      same signature is detected outside the dismissed window.
      Test: dismiss, assert the next inbox call omits the item;
      seed a fresh correlation 25h later, assert it reappears.
- [ ] Performance: `detectCorrelations` against a fleet with 10
      projects and 200 failing PRs in the last 24h completes
      in under 75ms. Test: seed the dataset, time the call,
      assert <75ms (skip if `process.env.PERF !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No new shell-
      out from `src/correlate.ts` (it's pure SQL + the
      signature helper). The `gh run view --log-failed` call
      lives in `src/ingest/prs.ts` only, via the existing
      runner seam. No JSON-shape break to any existing
      `/api/...` route - the inbox's new kind is additive and
      consumers must already tolerate unknown kinds (they
      already render the four 0017 kinds via a switch).

## Out of scope

- LLM-authored root-cause analysis. v1 surfaces the signature
  and the excerpts; the operator diagnoses. A future ticket
  could add a "explain this correlation" hint, but that costs
  tokens and is opt-in only.
- Cross-operator correlation (a SaaS-shaped feature that
  contradicts the local-only design).
- Auto-pausing all affected projects on correlation. The
  budget-autopause (0021) is the only auto-control surface for
  now; correlation is purely diagnostic.
- A "correlations history" page. Dismissed correlations live in
  the `anomaly` table; a viewer is a follow-up.
- Custom signature rules from operator config. v1 ships the
  five regexes above; a knob is a follow-up if operators ask.
- Streaming correlation updates via SSE. The 60s ingest tick is
  the floor for now.

## Engineering notes

- `src/correlate.ts` - new module. The detector is one SQL
  query that GROUP BYs on `correlation_signature` (derived
  in-application from `first_fail_excerpt` via the
  `failureSignature` helper) with HAVING `COUNT(DISTINCT
  project_slug) >= 2`. The helper itself is pure functions
  over strings - no I/O, no shell - so it's directly unit-
  testable without seams.
- `src/ingest/prs.ts` - one new `gh run view --log-failed`
  call gated on `first_fail_check` being non-null. Per
  AGENTS.md, argv array only; per LESSONS § "shell-out
  modules need an injectable runner from day one", reuse the
  existing runner seam in the module (already present from
  0023's iteration).
- `src/db.ts` - three idempotent ALTERs:
  `ALTER TABLE pr ADD COLUMN first_fail_excerpt TEXT`,
  `ALTER TABLE anomaly ADD COLUMN kind TEXT DEFAULT
  'duration_outlier'`,
  `ALTER TABLE anomaly ADD COLUMN correlation_signature TEXT`.
  Per LESSONS § "no backticks inside template-literal SQL
  strings", keep identifiers plain. Per LESSONS § "migration
  that adds a column to a table with existing rows must be
  idempotent NULL-tolerant", existing anomaly rows must
  continue to read without error.
- `src/daemon.ts` - one new call to `detectCorrelations` after
  the existing post-ingest hooks; one INSERT loop. Idempotency
  is enforced by an `INSERT OR IGNORE` on
  `(kind, correlation_signature, date(now,'unixepoch'))`.
- `src/inbox.ts` (or wherever 0017 lives) - one new sub-query
  branch for the `fleet_correlation` kind.
- `src/server.ts` - one new route `GET
  /api/fleet/correlations`, plus the inbox dismiss handler
  already accepts arbitrary kinds.
- `web/app.js` - `renderCorrelationItem(item)` + the detail
  view at `/correlation/:signature`. Mobile per 0011.
- `tests/correlate.test.ts` - unit tests for
  `failureSignature` (one per regex), an end-to-end test that
  seeds three projects, runs the detector, and asserts the
  resulting anomaly + inbox item shapes. For the in-process
  startServer boot, follow LESSONS § "in-process
  startServer() tests need an empty-roots config + run-row
  seeds".
- No new runtime deps. Pairs with 0008 (anomaly table is the
  storage; this just adds a new kind), 0017 (inbox is the
  surface), 0014 (leaderboard can count correlated failures
  per signature across the fleet), and 0023 (the
  `first_fail_check` column 0023 added is the lookup key for
  the new `first_fail_excerpt`).

## Implementation log

- 2026-05-28 — picked up by implementation-dev on branch
  `feat/0027-cross-project-failure-correlation`. Status flipped to
  in-progress.
- 2026-05-28 — prerequisite check: ticket 0023 (which would add
  `pr.first_fail_check`) is still `groomed`. Taking option (a) per the
  ship prompt's guidance and adding the minimal `first_fail_check TEXT`
  column + its population from the existing `statusCheckRollup`
  payload in `src/ingest/prs.ts` as part of this ticket. Scope kept
  tight — no UI surface for `first_fail_check` itself (that remains
  0023's job). The column is derived from the same `gh pr list` JSON
  the module already fetches (no new shell-out): the first rollup
  entry whose conclusion matches /FAIL|ERROR|CANCEL/i wins, with its
  `name` (or `context`) becoming `first_fail_check`. The
  `first_fail_excerpt` is populated via a NEW `gh run view
  --log-failed` call gated on `first_fail_check` being non-null, per
  this ticket's AC#3. Both reuse the existing
  `_setPrRunnerForTests` seam.
