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
