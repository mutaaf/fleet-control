---
id: 0024
title: First-run welcome — printed checklist after fleetctl serve cold start
status: proposed
priority: P2
area: infra
created: 2026-05-27
owner: gtm-innovation
---

## User story

As a brand-new operator who just cloned fleet-control and ran `fleetctl
serve` for the first time, I want the CLI to print a numbered "next 5
minutes" checklist — including my just-generated admin token, the
portal URL, and a copy-pastable example of registering my first
project — so that the cold-start moment between "the server is up" and
"I see something useful in the portal" disappears.

## Why now (four lenses)

### Product Owner
`fleetctl doctor` (0016) is a phenomenal *diagnosis* tool, but the
operator only learns it exists after they've gone through a confused
first run. The cold-start gap is between `serve` starting and the
operator finding the portal — which today requires reading the README
to find the URL and the token location. Closing that gap is one print
statement at startup, gated on a "have I seen this operator before"
flag. Subtract a step from the funnel; do not add a feature.

### Stakeholder
Widens the moat on `infra` and acquisition. The single best moat a
local-only tool has is "I cloned, ran one command, and it worked" —
because that property is hard to forge in a SaaS pitch and is what
gets a friend to adopt. The fleet has the install diagnostic (0016)
but no install *welcome*; the two complete each other.

### User (operator at 9am, fresh clone)
First `fleetctl serve` prints:

```
fleet-control v0.x — first run detected.

Next 5 minutes:
  1. Open the portal:        http://127.0.0.1:7070
  2. Loopback bypasses auth — no token needed locally.
     For LAN: x-fleet-token: <token-from-fleet-control.config.json>
  3. Add your first project:  fleetctl register <github-url>
  4. Verify with:             fleetctl doctor
  5. Watch the live tail:     fleetctl tail --follow

Hide this with: touch ~/.config/fleet-control/.welcome-seen
```

Subsequent runs print one line: `fleet-control serving on 127.0.0.1:7070`.

### Growth
The welcome screen is the single most screenshot-able artifact for a
README and a Show HN post. It also gives the autonomous-loop's review
agent a stable "first run looks like this" contract to grade against.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/welcome.ts` (new) exports `renderWelcome(opts)` returning
      the multi-line string. Pure function over its options
      (`{token: string, host: string, port: number, configPath: string,
      tokenSource: "config"|"env"|"new"}`). Test: snapshot the
      rendered string against a fixture; assert specific lines are
      present.
- [ ] First-run detection: a "seen" sentinel lives at
      `$XDG_CONFIG_HOME/fleet-control/.welcome-seen` (default
      `$HOME/.config/fleet-control/.welcome-seen`). On `fleetctl
      serve` startup, the welcome prints iff the sentinel is absent;
      printing it creates the sentinel. Test: with sentinel absent
      assert welcome was printed and sentinel exists; with sentinel
      present assert one-line message only.
- [ ] Override flags: `--welcome` forces the welcome regardless of
      sentinel; `--no-welcome` suppresses it regardless. Both flags
      handled by the existing `bin/fleetctl.ts` argv parser. Test:
      seed sentinel-absent + `--no-welcome` → suppressed; seed
      sentinel-present + `--welcome` → printed.
- [ ] The welcome MUST NOT print the admin token literal — only
      reference where it lives. The line "For LAN: x-fleet-token:
      <token-from-fleet-control.config.json>" carries a path, not the
      value. Test: render the welcome with a known token in the
      config, assert the token string does not appear in the output.
      Per `docs/LESSONS.md` § defence-in-depth secret redaction at
      the renderer boundary, route the rendered string through
      `redactSecrets` as a backstop before write.
- [ ] The welcome MUST be ANSI-coloured when stdout is a TTY and
      plain otherwise (the existing 0016 TTY-color helpers). Test:
      capture both modes via the test harness, assert presence /
      absence of escape codes.
- [ ] `bin/fleetctl.ts` calls `renderWelcome` after the HTTP server
      reports `listening` (so the URL it prints is correct) and
      before the daemon ticks start. The existing
      `fleetctl serve` happy-path output is otherwise unchanged.
      Test: subprocess-spawn the CLI per `docs/LESSONS.md` § CLI
      subprocess tests need a `FLEET_DB_PATH` env seam (and a
      `FLEET_HOME` for the sentinel — see engineering notes), assert
      stdout begins with the welcome and the server then accepts a
      request.
- [ ] Sentinel write failures (read-only home, missing parent dir)
      MUST NOT crash the serve startup — log a single warning line
      and continue. Test: point the sentinel path at a non-writable
      location, assert serve still listens and emits one
      `warn:` line.
- [ ] First-project hint: when the welcome runs AND the DB has zero
      projects, line 3 reads `fleetctl register <github-url>` as
      shown above. When the DB has ≥1 project (e.g. operator deleted
      the sentinel for a re-tour), line 3 reads `Your projects:
      <slug1>, <slug2>, …` (capped at 3, trailing `…` if more).
      Test: seed both cases, assert the rendered line.
- [ ] No new runtime deps. `tsc --noEmit` clean. No JSON-shape change
      to any existing `/api/...` route (this ticket is CLI-only).
      The welcome string MUST NOT exceed 24 lines and SHOULD NOT
      exceed 80 columns at any line (so it fits a standard terminal
      without wrap). Test: render, assert line count and max
      line-width.

## Out of scope

- A full TUI wizard with arrow-key project picking. Plain numbered
  list is the v1 — fast, scriptable, copy-paste friendly. A TUI is
  a separate ticket if anyone asks.
- Cross-machine welcome (e.g. "you have N projects synced from
  another host"). Local-only by design.
- Auto-opening the browser. Some operators run headless; printing
  the URL is enough.
- A portal-side first-run tour (e.g. an in-app coachmark). The CLI
  surface is where the operator already is; piling on a SPA tour
  doubles the maintenance surface for no extra reach.
- Localisation. English-only v1; the text is short enough that a
  future ticket can lift the strings into a table.

## Engineering notes

- `src/welcome.ts` — new module, pure render function plus a tiny
  `firstRun(opts)` that wraps sentinel detection and printing. Inject
  the filesystem surface (`{readFile, writeFile, mkdir, stat}`) per
  the dependency-injection pattern used in `src/doctor.ts` — same
  shape as the runner seam in 0010 / 0016. Per `docs/LESSONS.md` §
  shell-out modules need an injectable runner, this also keeps the
  test from touching the operator's real home directory.
- `bin/fleetctl.ts` — one new call after `server.listen` resolves;
  one new arg-parser line each for `--welcome` and `--no-welcome`.
- Sentinel path: derive from `process.env.XDG_CONFIG_HOME ??
  path.join(homedir(), ".config")`. Per the same lesson seam as
  `FLEET_DB_PATH`, accept a `FLEET_HOME` env override so subprocess
  tests can point both the sentinel and the config at a tmpdir
  without leaking into the operator's real `$HOME`.
- `src/auth.ts` — no changes. The token-source enum (`config | env |
  new`) is read from the existing config-load path, not synthesised
  here.
- `tests/welcome.test.ts` (new) — pure snapshot of the rendered
  string + sentinel write/read round-trip + the CLI subprocess test
  per `docs/LESSONS.md` § CLI subprocess tests need a `FLEET_DB_PATH`
  env seam.
- No new runtime deps. Pairs with 0016 (the welcome's line 4 nudges
  the operator to run `doctor` — those two together cover cold-start
  and silent-stop), and with the existing `README.md` which can be
  trimmed once the CLI carries the same content.

## Implementation log

(Appended by the implementation-dev agent during execution.)
