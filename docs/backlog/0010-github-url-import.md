---
id: 0010
title: One-click GitHub-URL project import
status: groomed
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

- [ ] New action `register-url` in `src/control.ts` accepting `{repo_url,
      slug?, name?}`. `repo_url` must match
      `^https://github.com/[\w.-]+/[\w.-]+$`.
- [ ] Action flow:
      1. Verify `gh repo view <owner/name>` succeeds (auth + exists).
      2. `git clone <repo_url> ~/Desktop/projects/<slug>`. If the dir
         already exists, abort with a clear message.
      3. Delegate to the existing `registerProject` with that path. (No
         logic duplication.)
- [ ] `web/app.js` wizard adds a second input "Or paste a GitHub URL" with
      a "Clone & connect" button.
- [ ] On failure mid-flow (clone fails, register fails), the partially-
      created `~/Desktop/projects/<slug>` is cleaned up via the safe
      cleaner (ticket 0006 path-prefix guard).
- [ ] `control_audit` row records `action=register-url` with the repo_url.
- [ ] `tests/register-url.test.ts` — stub `gh` and `git clone` to write
      a fixture dir, call the action, assert the manifest + AGENTS.md
      sections are present.
- [ ] Auth: requires `admin` scope (ticket 0003).

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
- Blocked-by: 0003 (scoped tokens, for admin scope enforcement) and 0006
  (the safe-rm path-prefix guard).
- No new deps.

## Implementation log

(Appended by the implementation-dev agent during execution.)
