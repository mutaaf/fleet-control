---
id: 0010
title: One-click GitHub-URL project import
status: in-progress
priority: P2
area: control
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator, I want to paste a GitHub URL into the portal's "Add
a project" wizard and have fleet-control clone, scaffold the kit, and
install, so that onboarding a new project is one input field instead of
a six-step shell session.

## Why now (four lenses)

### Product Owner
The existing register flow (P6) expects a folder that already exists
locally and has a `.git`. That's the "Path A" of two original options.
This is "Path B" — give a URL, get a running agent.

### Stakeholder
Widens the moat on `control` — onboarding friction is the difference
between an operator running 3 projects and 8.

### Operator
"My new side project should have an agent" — paste URL, name a slug,
tap. Done.

### Growth
The most-likely-to-be-shared screenshot. Compare to setting up the kit
manually.

## Acceptance criteria

- [ ] New action `register-url` in `src/control.ts` accepting
      `{repo_url, slug?, name?, days?, eng?}`. `repo_url` must match
      the strict regex `^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+(\.git)?$`.
      A non-matching URL returns `{ok: false, error: "bad_url"}` with
      HTTP 400 — no shell-out. Test: pass
      `https://github.com/foo;rm -rf /` and assert rejection before any
      child process spawns.
- [ ] `slug` defaults to the URL's repo name lowercased; if it collides
      with an existing project slug, the action returns
      `{ok: false, error: "slug_exists"}`. Test: register the same URL
      twice, assert second call rejected.
- [ ] Action flow:
      1. Verify with `execFile("gh", ["repo", "view", "<owner/name>",
         "--json", "name"])` that the repo exists and the operator has
         access. Argv array only — no shell-string composition. Test:
         stub gh to return non-zero, assert the action surfaces
         `error: "repo_unreachable"`.
      2. `execFile("git", ["clone", "--depth=50", repo_url,
         dest_path])` into `<projectRoots[0]>/<slug>`. Test: stub git to
         succeed against a tmpdir fixture, assert clone called with
         exactly that argv.
      3. Delegate to the existing `registerProject(path, opts)` with the
         cloned dir. No scaffold logic duplication.
- [ ] `web/app.js` wizard adds a second input "Or paste a GitHub URL"
      with a "Clone & connect" button. On click, POSTs to
      `/api/control/register-url`. Shows inline error messages on the
      400 cases above.
- [ ] On failure mid-flow (clone fails, register fails), the partially-
      created `<projectRoots[0]>/<slug>` is removed by calling the same
      safe-rm helper landed in 0006 (path-prefix guard on
      `<projectRoots[0]>`). Test: stub register to throw after clone,
      assert the dest dir is gone after the action returns.
- [ ] `control_audit` row records `action=register-url`, `target=<slug>`,
      `args_json` containing only `repo_url` + `slug` (not any token).
- [ ] `tests/register-url.test.ts` — stub `gh` and `git clone` to write
      a fixture dir under a tmpdir override of `projectRoots`, call the
      action, assert `agents.config.sh`, `AGENTS.md` (Agent parameters
      section), and `docs/backlog/{README,_template}.md` exist after.
- [ ] Auth: requires `admin` scope (ticket 0003 — shipped).
- [ ] No new runtime deps. `tsc --noEmit` clean.

## Out of scope

- SSH URLs. HTTPS only.
- Importing a repo that isn't on GitHub.
- Auto-detecting language to choose subagent templates. The fleet-standard
  subagents are written once per repo by the operator.

## Engineering notes

- `src/control.ts` — new `register-url` case, plus a small helper to clone
  safely.
- Reuse `registerProject` for the post-clone work. Don't duplicate the
  scaffold logic.
- `web/app.js` — extend the existing wizard.
- Blocked-by: 0006 (the safe-rm path-prefix guard) — currently
  in-progress; ship after it merges. 0003 (admin scope) already shipped.
- No new deps.

## Implementation log

- 2026-05-26 — implementation-dev: branched `feat/0010-github-url-import`,
  ticket flipped to `in-progress`. Plan: new `register-url` action in
  `src/control.ts` (admin scope) with strict regex on `repo_url`, gh+git
  shell-out via `execFile` argv arrays, delegates post-clone scaffolding
  to existing `registerProject(path, opts)`. Failure mid-flow removes
  partial `<projectRoots[0]>/<slug>` via the safe-rm helper from 0006.
  SPA wizard in `web/app.js` grows a second input "Or paste a GitHub URL"
  with a "Clone & connect" button. Bundling drift fix: 0006 file +
  index row both flip to `shipped` in the same branch (PR #10 landed
  but no follow-up `chore(0006)` ever ran). Tests:
  `tests/register-url.test.ts` covers the bad-url rejection (no
  shell-out), slug collision, gh-unreachable surfacing, partial cleanup
  on register failure, audit row shape (no token), and the
  "register the URL → scaffold files appear" happy path.
