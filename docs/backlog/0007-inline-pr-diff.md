---
id: 0007
title: Inline PR diff with sticky action bar
status: in-progress
priority: P1
area: portal
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator reviewing an agent PR from my phone, I want to see the
PR diff and the Approve / Send back / Discard buttons in the portal,
without bouncing to github.com.

## Why now (four lenses)

### Product Owner
The control plane already exposes Approve / Send back / Discard (P5 in the
existing build). The missing piece is the diff right above them. One
context, one tap.

### Stakeholder
Widens the moat on the portal as a complete review surface. Today the
operator opens GitHub for the diff and the portal for the action — two
contexts.

### Operator
On the train, glance at the PR diff, tap "Approve". Done.

### Growth
The screenshot of "agent PR diff + action bar in the portal" is the demo.

## Acceptance criteria

- [ ] `/api/prs/:repo/:number/diff` returns `text/plain` from
      `gh pr diff <number> --repo <owner/name>`. Cached in-memory for 30s
      per (repo,number). Auth: `read` scope (from ticket 0003).
- [ ] `web/app.js` PRs section: each PR row expands to show the diff
      inline. A sticky bottom bar inside the expanded section holds
      "Approve & publish", "Send back", "Discard" — the same actions
      that already live elsewhere in the portal.
- [ ] Diff rendering: monospace, server-side `<` / `>` escape, one
      `<div>` per line, `+` lines green, `-` lines red, hunk headers
      bold. No syntax highlighter (no new deps).
- [ ] Long diffs: server caps at 200 KB, then sends a "truncated, open in
      GitHub" link.
- [ ] Mobile: the sticky bar stays visible while scrolling the diff.
- [ ] `tests/pr-diff.test.ts` — call the route with a stub `gh` that
      returns a known diff, assert the response shape and the cache hit
      on the second call.

## Out of scope

- File-by-file collapsing. Single flat diff in v1.
- Comment threads inline. The operator's actions are PR-level only.
- Editing the diff in the portal. Read-only.

## Engineering notes

- `src/server.ts` — add the route. `execFile("gh", ["pr", "diff",
  number, "--repo", repo])`.
- `web/app.js` — update the PRs section; small `renderDiff(text)` helper.
- `web/style.css` — add a few lines for diff colors and the sticky bar.
- No new deps.

## Implementation log

- 2026-05-26 (implementation-dev): branched feat/0007-inline-pr-diff;
  moved to in-progress before the failing test pass.
