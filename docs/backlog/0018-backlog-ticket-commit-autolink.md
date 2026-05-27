---
id: 0018
title: Backlog-ticket → merged-commit auto-link via git log
status: groomed
priority: P2
area: ingest
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator who reviews shipped tickets the morning after a
ship cycle, I want every backlog ticket page to show the exact merged
commits, the merging PR, and the diff stats for that ticket without me
typing the ticket id into a git log query, so that "did 0014 actually
ship cleanly and what did it touch?" is one click instead of a context
switch into the terminal.

## Why now (four lenses)

### Product Owner
The ticket → PR → commit relationship is the most-traversed link in
the operator's workflow but the one the portal doesn't yet draw. The
dev agent maintains it by hand today (appending to the "Implementation
log" section of each ticket), which is brittle — if the agent ever
stops writing that section the link rots silently. Sourcing it
deterministically from `git log` makes the connection structural and
removes a class of "ticket says shipped but no PR linked" failures the
review agent has flagged in the past.

### Stakeholder
Widens the moat on `ingest`. The link can only be drawn by software
with simultaneous access to the backlog files, the local git history
of every project, and the run telemetry. A SaaS dashboard would need
write access to every operator's git remote to even attempt this; the
local-first design makes it free. The auto-link also becomes a
truth-table the autonomous reviewer can use ("PR claims to close
ticket NNNN but no commit message references NNNN — request changes").

### User (operator at 9am, looking at the portal)
On every backlog ticket page, a new "Shipped as" section appears
beneath the acceptance criteria. For a shipped ticket: "PR #25
(merged 2026-05-26) · 3 commits · +312 / -47 across 8 files". Each
commit hash links to the GitHub commit page (when a `repo_url` is
known) or shows the message inline (when not). For a proposed or
groomed ticket: nothing appears (no noise).

### Growth
The auto-link is the strongest signal a prospective operator can read
from the portal that the tool actually ships things — every ticket
page becomes a small case study. Combined with 0014 (leaderboard) and
the existing weekly digest (0012), it forms a complete "what did the
fleet do this week" narrative the operator can share without
screenshots.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/ingest/git_ticket_links.ts` (new) exports
      `scanTicketLinks(repoPath, sinceRef)` returning
      `Array<{ticket_id: string, commit_sha: string, commit_date:
      string, author: string, message_subject: string,
      files_changed: number, insertions: number, deletions: number}>`.
      Implementation: shells out via `execFile("git", ["-C", repoPath,
      "log", sinceRef + "..HEAD", "--pretty=...", "--shortstat"])`,
      parses the output, extracts a 4-digit ticket id from each
      commit subject via the regex `/\b(\d{4})\b/` (matching the
      `feat/NNNN-` / `chore/NNNN-` / `(NNNN)` patterns AGENTS.md
      mandates). Test: stub the `execFile` runner per the runner-seam
      pattern (`docs/LESSONS.md` § shell-out modules need an
      injectable runner), feed canned git output, assert the parsed
      shape.
- [ ] Schema migration: add `ticket_commit_link` table idempotently
      in `src/db.ts`:
      ```sql
      CREATE TABLE IF NOT EXISTS ticket_commit_link (
        ticket_id TEXT NOT NULL,
        project_slug TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        commit_date TEXT NOT NULL,
        author TEXT NOT NULL,
        message_subject TEXT NOT NULL,
        files_changed INTEGER NOT NULL,
        insertions INTEGER NOT NULL,
        deletions INTEGER NOT NULL,
        pr_number INTEGER,
        PRIMARY KEY (project_slug, commit_sha, ticket_id)
      );
      ```
      Test: insert + select round-trip; assert idempotent re-insert
      (same primary key → REPLACE or INSERT OR IGNORE, no duplicate
      rows).
- [ ] Daemon hook: after each ingest tick for a project, run
      `scanTicketLinks` against the project repo with `sinceRef =
      max(commit_date)` from `ticket_commit_link` for that slug (or
      the project's first-ever commit if empty). Insert every new
      row. Test: stub a project repo with three new commits
      mentioning two different ticket ids, run the hook, assert three
      rows inserted across the two ticket ids.
- [ ] PR-number enrichment: when an inserted commit's SHA matches the
      head SHA of a row in the existing `pr` table, populate
      `pr_number`. (Pure SQL JOIN at insert time; no extra `gh`
      calls.) Test: seed a `pr` row, insert a matching commit, assert
      `pr_number` populated.
- [ ] `src/views.ts` exports `ticketShipReport(db, ticket_id)`
      returning `{commits: Array<{...}>, pr_number: number | null,
      total_insertions: number, total_deletions: number,
      total_files_changed: number, first_commit_date: string,
      last_commit_date: string} | null` (null if no commits link to
      the ticket). Test: seed 3 linked commits, assert aggregation.
- [ ] `GET /api/backlog/:id/ship-report` returns the shape. Requires
      `read` scope. Test: hit for a shipped vs un-shipped ticket id,
      assert shape vs 404.
- [ ] `web/app.js` adds a "Shipped as" section to the ticket detail
      page (existing route — does NOT change `/api/backlog/:id` JSON
      shape; renders from the new ship-report endpoint). For shipped
      tickets only — proposed / groomed / in-progress tickets render
      nothing. Test: stub each status, assert the section appears
      only for shipped.
- [ ] The git-log shell-out uses `execFile` with an argv array and
      `repoPath` is validated against `/^[\w./-]+$/` before being
      passed as `-C`. Test: feed a path containing `;` or `$()`,
      assert the helper throws before invoking exec.
- [ ] No new runtime deps. `tsc --noEmit` clean. No JSON-shape change
      to any existing `/api/...` route (the new ship-report route is
      net-new).

## Out of scope

- Cross-project ticket linkage (e.g. a commit in project A claiming
  to close a ticket in project B). Tickets live per-repo; the link
  is per-repo.
- Bidirectional sync (editing the ticket file from the portal).
  Read-only render of the auto-link in v1.
- Rich diff preview on the ticket page. The existing PR diff view
  (0007) is the place for that — the ticket page just links to it.
- A "tickets without ship-link" lint in CI. Useful follow-up, but
  scope creep here.
- Git remote URL inference. If the project carries a `repo_url`,
  link commits to it; otherwise show the SHA without a link.

## Engineering notes

- `src/ingest/git_ticket_links.ts` — new module. Use the runner-seam
  pattern (export `_setRunnerForTests` / `_resetRunnerForTests`) per
  `docs/LESSONS.md` § shell-out modules need an injectable runner.
  Parsing the `--shortstat` output is the one fiddly bit; pin the
  format with `--pretty=format:...` so the parser doesn't have to
  guess at locale-dependent labels.
- `src/db.ts` — append the `ticket_commit_link` table. Keep the
  SCHEMA template free of backticked identifiers (`docs/LESSONS.md`
  § no backticks inside template-literal SQL strings).
- `src/daemon.ts` — wire the post-ingest hook. Each ingest tick is
  already per-project; the hook is one extra call.
- `src/views.ts` — one new `ticketShipReport` helper. Use the `as
  unknown as RowT[]` cast.
- `src/server.ts` — one new route, reuse the `read` scope middleware.
- `web/app.js` — small "Shipped as" panel on the ticket detail view.
- `tests/git-ticket-links.test.ts` — runner-seam test with canned
  `git log` output covering: one ticket / many commits, many tickets
  / one commit body (multiple `\b\d{4}\b` matches), zero matches,
  malformed shortstat lines.
- No new runtime deps. Pairs with 0014 (the leaderboard's per-project
  view can link the top tickets) and 0012 (the weekly digest can
  include "tickets shipped this week" with diff totals from this
  table).

## Implementation log

(Appended by the implementation-dev agent during execution.)
