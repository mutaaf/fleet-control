# LESSONS

Operational memory for the autonomous loop. Append, never reorder. Each entry
is one paragraph: symptom → cause → fix. Lessons here are read at the start
of every ship/groom run.

## 2026-05-26 — bootstrap

The control plane is dogfooding itself. The seatbelts: CI gates on
`typecheck` + `validate`, branch protection requires both contexts, and the
review subagent enforces AGENTS.md § Hard NOs. Lessons below are the agents'
collective memory across all runs on this repo.

## 2026-05-26 — keep `dependencies` empty

This project ships as zero-runtime-dep on purpose. The shape of the codebase
(node:sqlite, node:http, vanilla SPA, TypeScript via type-stripping) is the
distinguishing property. Any PR that adds a `dependencies` entry — even an
"obviously useful" one like `zod` or `chalk` — is a reject. Use the standard
library or write the small helper.

## 2026-05-26 — no backticks inside template-literal SQL strings

Symptom: a fresh `src/db.ts` edit caused
`ERR_INVALID_TYPESCRIPT_SYNTAX: Expected a semicolon` from node's type
stripper, with a stack pointing into `parseTypeScript`. Cause: I had added
a SQL comment inside the existing backtick-delimited `SCHEMA` template that
itself contained backticked identifiers (e.g. `` Named `agent_event` (not
`event`) ``). Node v25's type-stripping parser misreads inner backticks as
nested template-literal delimiters and the whole module fails to load —
including the upstream test that just imports it. Fix: never put backticks
inside the SCHEMA template (quote SQL identifiers with plain words instead),
or hoist the comment outside the template. The TypeScript compiler doesn't
catch this because `tsc --noEmit` parses the file fine — only the runtime
type-stripper fails, so tests are the only signal.

## 2026-05-26 — async streaming tails: snapshot the path before each read

Symptom: the SSE tail's rotation test (`tests/sse-stream.test.ts`) passed
when run as a standalone script but failed under `node --test` with the
parser receiving zero events from the rotated file — only the OLD file's
content showed up, then nothing. Cause: my `drainFrom()` closure captured a
`path` argument, but when an `fs.watch` callback fired mid-read and a
rotation poll also fired, the `attach(newPath)` ran in between — resetting
`offset=0` and `currentPath=newPath`. The previous read's `stream.on("end")`
then overwrote `offset` with the OLD file's size and the next drain read
past EOF of the new file. Fix: in any tail that can rotate, snapshot the
path at the start of each read (`const readingPath = currentPath`) and on
`end`, bail out without mutating offset/partial if `readingPath !==
currentPath`. The general lesson: a tail's "current file" state is mutable
across awaits, so every async boundary inside the drain loop must
re-validate which file the in-flight bytes belong to.

## 2026-05-26 — node test-runner timing is jittery; poll, don't sleep

Symptom: `tests/sse-stream.test.ts` passed in isolation but flaked under
the full `tests/*.test.ts` run — backfill needed >80ms when other test
files were also scheduling readline streams. Cause: sequential `wait(80)`
guesses are brittle under load. Fix: helper `waitFor(predicate, maxMs)`
that polls every 20ms up to a generous timeout, then asserts. Same
principle as flaky web-driver tests — assert on the *condition*, not on a
sleep length.

## 2026-05-26 — GitHub Actions sometimes doesn't fire on a freshly-opened PR

Symptom: PR #10 for ticket 0006 sat for several minutes after both the
initial `git push -u` AND an empty "ci: trigger checks" follow-up push with
zero workflow runs queued for the head commit. `gh pr checks` printed "no
checks reported on the branch"; `gh api /commits/HEAD/check-suites`
returned only the unrelated Vercel app suite, never a GitHub-Actions suite
for `ci.yml` or `auto-merge.yml`. The workflow file is correct
(`on: pull_request: branches: [main]` is matched by the PR's
`base=main / head=feat/0006-...`), Actions are enabled at the repo level,
and the same workflow had fired for every prior agent PR. Cause: most
likely a transient GitHub-side delivery hiccup on the `pull_request`
webhook — re-pushing didn't recover it within a single ship slot. Fix
options for the heal step:
  1. push another empty commit to nudge `synchronize` (cheapest first try),
  2. close + reopen the PR via `gh pr close && gh pr reopen` to force a
     fresh `pull_request.opened` event,
  3. as a last resort, add `workflow_dispatch:` to `ci.yml` so the heal
     agent can `gh workflow run` directly.
General rule: distinguish "CI red" (a run completed and failed — read the
log, fix, push) from "CI absent" (no run was queued at all — re-trigger
the webhook). The current heal loop only knows how to handle the first
case; until it grows the second, leave a PR comment naming the situation
so the next ship run treats this as a re-trigger rather than re-doing the
work from scratch.

## 2026-05-26 — don't fake a "lazy require" in an ESM file; just import

Symptom: while wiring `src/control.ts` to call into the new `src/auth.ts`
I started writing a `require_auth_lazy()` indirection because I half-
remembered the "don't eagerly import" pattern from CJS. Caught it before
push because the file uses `import` everywhere else and `require` isn't
in scope. Fix: `import * as auth from "./auth.ts"` at the top. node's
type-stripper hoists named imports and tree-shaking is not our problem
here — every consumer of `control.ts` already imports the DB module, so
the marginal cost of pulling in `node:crypto` is invisible. General rule
for this repo: there is exactly one module system (ESM via `.ts`); reach
for `import`, never `require`, never `await import()` unless you
genuinely need the laziness.

## 2026-05-26 — route regex for "owner/name" slugs needs an embedded slash

Symptom: when wiring `GET /api/prs/:repo/:number/diff` (ticket 0007) I
reached for the same `[\w-]+` capture every other route in `src/server.ts`
uses for slugs, then realised `:repo` is `owner/name` and carries a literal
slash. The naive `[\w-]+` won't match `mutaaf/fleet-control`. Cause: every
other slug we capture (project slug, run id) is a single path segment by
design; GitHub repo identifiers are two. Fix: capture the pair explicitly
with `([^/]+\/[^/]+)`, and rely on a separate `validatePrParams()` for the
character-set / `..` / shell-meta checks. General rule: the route regex
is just "did this URL shape want this handler?" — keep it permissive on
contents and defer real validation to a typed helper so error messages
stay precise (400 "bad repo" vs a confusing 404). Same pattern will help
when adding any future route that takes a GitHub identifier.
