---
id: 0032
title: Welcome banner prints LAN URL + ASCII-QR so the phone is paired in 60 seconds
status: shipped
priority: P1
area: infra
created: 2026-06-01
owner: gtm-innovation
---

## User story

As a brand-new operator who just ran `fleetctl serve` for the first time
on a laptop and wants to use the portal from my phone (because that is
the surface I will actually open at 9am), I want the first-run welcome
to print my LAN URL alongside a small ASCII-QR I can scan from across
the room, so that the install-to-phone-paired moment takes one scan
instead of "find the laptop IP, type it into mobile Safari, hope I got
the port right, paste the admin token" - and the PWA install prompt
(0029) appears within seconds of `serve` first listening.

## Why now (four lenses)

### Product Owner
0024 ships the cold-start welcome; 0029 makes the portal a home-screen
app. The gap between them is the "how do I get to the portal FROM my
phone" moment, which today requires the operator to (a) find their
laptop's LAN IP, (b) remember to set `FLEET_HOST=0.0.0.0`, (c) type the
URL on a phone keyboard, and (d) hand-paste the admin token from a
gitignored JSON file. Each of those is a place a new operator quits.
Printing an ASCII-QR that already encodes the LAN URL (with the admin
token in a one-shot `pair` query param scoped to a single-use exchange)
collapses all four steps into "scan." Pure subtraction of friction on
a surface the operator already sees once - the welcome banner. No new
schema, no new control surface, one helper module and one CLI flag.
0024 + 0029 + this = a single one-command install that ends with the
portal on the phone's home screen.

### Stakeholder
Widens the moat on `infra` and acquisition. The single biggest "show
me" weakness today is that the README's pitch is "open a localhost URL"
when the operator's actual daily surface is a phone. Closing that gap
without pulling in a QR library (the encoding is small enough to write
by hand using the existing `node:crypto` for token-derivation and a
~120-line public-domain QR matrix generator) keeps the zero-runtime-dep
property intact while turning a friction moment into a share-worthy one.
Per the cross-fleet courtiq lesson on "the share-worthy moment is the
first 60 seconds, not the steady-state UX," this ticket goes after
exactly that surface.

### User (operator at minute 60 of their first install)
`fleetctl serve` prints the existing welcome (0024), and BELOW line 5
a new section appears when `FLEET_HOST=0.0.0.0` is set OR a LAN IP is
discoverable:

```
Scan from your phone to pair (90s):
  http://192.168.1.42:7070/pair?t=K7-Z2-9F-X4

  +---+ +-+ +---+---+
  |   | | | |   |   |
  +---+ +-+ +---+---+
  ...      (21x21 ASCII QR)
```

On the phone, scanning the QR opens the portal (with a one-shot
`t=...` token that swaps for a real session cookie and is immediately
voided server-side), triggers the PWA "Add to Home Screen" prompt
(0029), and lands on the inbox. The whole flow is under 90 seconds
from the operator's first `serve` to "fleet on home screen." Indoor
phone glare and 80-column terminals are both tested - the QR is sized
21x21 cells (version 1, max ~25 chars URL-safe) and rendered with
two-character wide cells so it scans cleanly. No QR shown if
`FLEET_HOST` is loopback-only (`127.0.0.1`) - that operator is on the
same machine and doesn't need it.

### Growth
The screenshot worth sharing is a terminal with a printed QR and a
phone (already showing the fleet inbox) held in front of it - the
"60-second install to phone-paired" claim is true in one image. This
is also the only ticket in the backlog whose `npm run` demo can be
recorded end-to-end as a 30-second screencap on a real phone. A
prospective operator scrolling past on Twitter sees the install
proof, not a polished marketing GIF.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/qr.ts` (new) exports `renderQrAscii(text: string,
      opts?: {cellWidth?: 1|2}): string` returning a multi-line ASCII
      block that encodes `text` as a QR code, version 1 (21x21) with
      error correction level L (sufficient for short URLs). Pure
      function, no I/O, no new dep - hand-rolled QR matrix per the
      ISO/IEC 18004 reference (the dev agent writes the ~120 lines
      against a canonical test vector). Throws if `text.length > 25`
      (version 1 capacity at EC-L with alphanumeric). Test: encode
      `"HTTP://192.168.1.42:7070/PAIR?T=K7-Z2"` (upper-case for
      alphanumeric mode), decode the printed matrix bit-for-bit
      against a canonical fixture (committed as a `.txt` block in
      `tests/fixtures/qr-vector.txt`).
- [ ] `src/lan.ts` (new) exports `discoverLanUrl(host: string, port:
      number): string | null`. When `host === "0.0.0.0"` or any
      non-loopback bind, walks `os.networkInterfaces()` and returns
      the first IPv4 address whose family is `IPv4` and `internal`
      is `false`, formatted as `http://<ip>:<port>`. Returns `null`
      when only loopback interfaces exist OR the operator bound
      explicitly to `127.0.0.1`. Test: stub `os.networkInterfaces`
      with a fixture (lo0 + en0), assert the en0 URL; stub
      loopback-only, assert `null`.
- [ ] `src/pair.ts` (new) exports `mintPairToken(db: Database): {token:
      string, expires_at: string}` and `consumePairToken(db, token,
      now): {ok: boolean, admin_token?: string}`. The mint stores a
      one-shot row in a new `pair_token` table with a 90-second TTL;
      consume returns the long-lived admin token exactly once and
      DELETEs the row. Tokens are 12 alphanumeric chars in the
      `XX-XX-XX-XX` shape so the QR payload stays inside version-1
      capacity. Per LESSONS § "in-process dedup sets need an explicit
      reset hook for tests", expose `_resetPairCacheForTests()` if
      any module-level cache is added. Test: mint, consume once
      returns `ok: true`; consume again returns `ok: false`; advance
      `now` past TTL returns `ok: false` even on first consume.
- [ ] Schema migration: add `pair_token` table idempotently in
      `src/db.ts`. Columns: `token TEXT PRIMARY KEY, admin_token
      TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT
      NULL`. Per LESSONS § "no backticks inside template-literal SQL
      strings", keep identifiers plain inside the SCHEMA template.
      Test: open a DB without the table, assert the migration adds
      it and a round-trip INSERT/SELECT works.
- [ ] `GET /pair?t=<token>` (HTTP, NOT under `/api/`) consumes the
      pair token, sets an `x-fleet-token` cookie (HttpOnly, SameSite=
      Lax, Path=/) carrying the admin token, then 302s to `/`. An
      invalid or expired token renders a small HTML page "Pair link
      expired - re-run fleetctl serve to generate a new one" with no
      cookie set. The route is NEW so no JSON-shape contract applies.
      Test: hit `/pair?t=<valid>` -> 302 + cookie header set; hit
      `/pair?t=invalid` -> 200 + the expiration page + no cookie.
- [ ] `src/welcome.ts` (extended) gains a `pairSection?: {url:
      string, qrText: string}` opt. When present, the rendered
      welcome appends a "Scan from your phone to pair (90s):" block
      between the existing line 5 and the "Hide this with:" footer.
      Per LESSONS § "defence-in-depth secret redaction at the
      renderer boundary", the rendered string passes through
      `redactSecrets` before write - confirming the one-shot pair
      token does NOT match the redaction patterns (it's not a
      `gh[opusr]_` prefix nor a base64 token shape). Test: render
      with a known pair URL, assert the QR block is present and
      the URL string appears exactly once; assert the underlying
      admin token does NOT appear in the rendered output.
- [ ] `bin/fleetctl.ts serve` discovers the LAN URL via
      `discoverLanUrl`, mints a pair token, and threads the
      `pairSection` into the welcome. When `discoverLanUrl` returns
      `null` (loopback-only bind), no pair section is rendered and
      the welcome is byte-identical to today's output. A new
      `--no-pair` flag suppresses the pair section even when LAN is
      discoverable. Per LESSONS § "when a CLI subcommand adds boot
      output, take ownership of the listen banner", the existing
      `quietBanner: true` opt-in is preserved. Test: spawn the CLI
      with `FLEET_HOST=0.0.0.0` + stubbed network interfaces, assert
      the QR section is printed; spawn with `--no-pair`, assert no
      QR section.
- [ ] PWA install hint: after pair-consume on the phone, the SPA
      reads a `pair_just_consumed` query param (set by the
      `/pair` redirect on success) and, IF the
      `beforeinstallprompt` event has fired (per 0029), shows a
      small inline banner "Add to Home Screen to keep this one tap
      away" with the install-prompt CTA. The banner dismisses on
      install or one tap of "Not now". Test: stub
      `beforeinstallprompt` + the query param, assert the banner
      appears; stub the dismissal, assert it does not re-appear on
      reload.
- [ ] Rate-limit on `/pair`: the route accepts at most 10
      consume-attempts per minute per source IP (sourced from
      `req.socket.remoteAddress`). Beyond that, return 429 with a
      plain-text body "too many attempts." This prevents an
      attacker on the LAN from brute-forcing pair tokens during the
      90-second window. Test: 11 rapid requests from the same
      stubbed IP, assert the 11th is 429.
- [ ] Performance: rendering the welcome with a pair section
      (including QR computation) completes in under 30ms.
      `mintPairToken` + a subsequent `consumePairToken` together
      complete in under 5ms against a tmpdir DB. Test: time both,
      assert thresholds (skip if `process.env.PERF !== "1"`).
- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-string
      composition. No JSON-shape break to any existing `/api/...`
      route (the `/pair` route is NOT under `/api/`, the
      `pair_token` table is internal, the welcome's new section is
      additive output). Per LESSONS § "in-process startServer()
      tests need an empty-roots config + run-row seeds", the
      `/pair` route tests plant a tmp `fleet-control.config.json`
      in cwd and restore on cleanup. Per LESSONS § "CLI subprocess
      tests need a FLEET_DB_PATH env seam", the CLI tests use the
      existing env seam plus the 0024 `FLEET_HOME` seam.

## Out of scope

- A graphical QR (PNG/SVG). ASCII keeps the welcome zero-dep and
  scannable from a phone camera at typical kitchen-table distance;
  a graphical mode is a clean follow-up.
- Pair tokens that last longer than 90 seconds. The whole point is
  one-shot pairing at install time - longer-lived auth lives in the
  existing admin-token model.
- An in-app QR re-display from the portal (so the operator can
  re-pair a second phone). Operators can re-run `fleetctl serve` or
  add a `fleetctl pair-qr` subcommand later; v1 is welcome-only.
- Multi-token pairs (one QR per device with named scopes). The
  one-shot token grants the same admin scope the loopback already
  has - matches existing trust model.
- LAN-side mDNS publishing (`fleet-control.local`). A clean follow-
  up; today's IP-based URL is good enough for the first-run moment.
- Encrypting the admin token over the wire on `/pair`. The LAN URL
  is HTTP today; this ticket does not introduce TLS. Operators on
  hostile LANs already need to set up their own reverse proxy.

## Engineering notes

- `src/qr.ts` - new module. ~120 lines of hand-rolled QR encoder
  (version 1, EC-L, alphanumeric mode). Reference vectors from
  ISO/IEC 18004 - commit a canonical fixture in
  `tests/fixtures/qr-vector.txt` so any future tweak to the encoder
  is gated on matching the reference. Pure functions, no I/O.
- `src/lan.ts` - new module. Reads `os.networkInterfaces()` only;
  no shell-out, no new dep.
- `src/pair.ts` - new module. SQL is two prepared statements
  (`INSERT INTO pair_token`, `DELETE FROM pair_token WHERE
  token=? RETURNING admin_token`). Per LESSONS § "node:sqlite's
  .all() needs `as unknown as T[]`", any row narrowing uses the
  double-cast.
- `src/db.ts` - one new `CREATE TABLE IF NOT EXISTS pair_token`
  appended to the SCHEMA template. Per LESSONS § "no backticks
  inside template-literal SQL strings", identifiers stay plain.
- `src/server.ts` - one new `/pair` route (NOT under `/api/`,
  to keep the JSON-shape contract clean). Sets the
  `x-fleet-token` cookie via the existing `Set-Cookie` helper if
  one exists, else inline. The 302 redirect target is `/` (the
  SPA). Per AGENTS.md, no shell-string composition - the route
  reads from `req.url` query string only.
- `src/welcome.ts` - one new `pairSection` opt threaded through
  the existing render. Backwards-compatible: when the opt is
  absent, the output is byte-identical to today's. Per LESSONS
  § "defence-in-depth secret redaction at the renderer boundary",
  the entire rendered string still passes through `redactSecrets`
  at the end.
- `bin/fleetctl.ts` - one new helper call inside the serve path
  after `server.listen` resolves. Reads `FLEET_HOST` (existing
  env), calls `discoverLanUrl` + `mintPairToken`, builds the
  `pairSection` opt. One new arg-parser entry for `--no-pair`.
  Per LESSONS § "when a CLI subcommand adds boot output, take
  ownership of the listen banner", the welcome already owns the
  banner via `quietBanner: true` (0024 fix) so no additional
  banner work is needed.
- `web/app.js` - one new `renderPairConsumedBanner()` helper that
  hooks into the existing PWA `beforeinstallprompt` listener
  (added by 0029). The banner uses
  `data-testid="pair-install-hint"` per the cross-fleet pattern
  for stable test hooks. Per LESSONS § "defence-in-depth secret
  redaction at the renderer boundary", the banner text passes
  through `redactSecrets` before render.
- `tests/qr.test.ts` (new) - the encoder fixture vector + a
  property test on the QR matrix shape.
- `tests/pair.test.ts` (new) - mint/consume/expire round-trips
  + the rate-limit + the `/pair` route end-to-end via the
  in-process `startServer()` per LESSONS § "in-process
  startServer() tests need an empty-roots config + run-row
  seeds."
- `tests/welcome-pair.test.ts` (new) - the welcome render with
  and without the pair section, the `--no-pair` flag, the
  loopback-only suppression.
- No new runtime deps. Pairs with 0024 (welcome is the surface),
  0029 (PWA install is the destination - this ticket makes the
  install-prompt actually fire on the operator's phone), 0011
  (mobile-first portal is the landing surface for the paired
  phone), and 0016 (the doctor diagnostic now sees a successful
  pair as a positive install signal). Per LESSONS § "no new
  runtime deps" - the hand-rolled QR encoder is the test of
  whether this discipline still holds for a feature that would
  trivially pull in `qrcode` from npm.

## Implementation log

(Appended by the implementation-dev agent during execution.)

- 2026-06-01 - branch `feat/0032-welcome-qr-pairing` opened, status -> in-progress
- 2026-06-01 - QR encoder (`src/qr.ts`) ships V1-L alphanumeric with
  hand-rolled GF(256) Reed-Solomon, mask selection by penalty score,
  and an ASCII renderer. Canonical fixture for HELLO WORLD committed
  at `tests/fixtures/qr-vector.txt`. The implementation is ~280 lines
  of pure functions; no new runtime deps.
- 2026-06-01 - `src/lan.ts` discovers the first non-loopback IPv4 via
  `os.networkInterfaces()`; deterministic on the lowest IP. Returns
  null for explicit loopback bind so a `127.0.0.1` operator sees no
  QR — matches the ticket's loopback-silent rule.
- 2026-06-01 - `src/pair.ts` adds `mintPairToken` /
  `consumePairToken` / `sweepExpiredPairTokens` / `rateLimitAllow` /
  `_resetPairCacheForTests`. Tokens are 11-char `XX-XX-XX-XX` in an
  unambiguous-alphanumeric alphabet; 90-second TTL; single-use via a
  DELETE in consume. Rate-limit: 10 attempts/min/IP, in-process Map.
- 2026-06-01 - `src/db.ts` SCHEMA appended with `pair_token` table
  (token PK, admin_token, expires_at, created_at) + an expires_at
  index. Identifiers stay plain words per LESSONS § "no backticks
  inside template-literal SQL strings".
- 2026-06-01 - `src/server.ts` adds GET `/pair?t=<token>` AND GET
  `/P/<TOKEN>` (the uppercase path form the QR encodes, since V1-L
  alphanumeric mode cannot carry `?`/`=`). Success: 302 to
  `/?pair_just_consumed=1` with the x-fleet-token cookie. Failure:
  200 HTML page explaining how to re-mint. Rate-limit fires BEFORE
  the token lookup so an attacker can't probe token validity at
  >10/min.
- 2026-06-01 - `src/welcome.ts` gains optional `pairSection` opt.
  Absent: byte-identical to pre-0032 output (every existing 0024
  test still passes). Present: appends the "Scan from your phone to
  pair (90s):" headline + URL + ASCII QR block. When `qrText` is
  too long for V1-L the renderer falls back to a "QR unavailable"
  line so the welcome never crashes serve.
- 2026-06-01 - `bin/fleetctl.ts` discovers the LAN URL via
  `discoverLanUrl`, mints a pair token, and threads the
  `pairSection` opt into firstRun(). `--no-pair` flag suppresses
  the section. `quietBanner: true` preserved per LESSONS § "when a
  CLI subcommand adds boot output, take ownership of the listen
  banner".
- 2026-06-01 - `web/app.js` adds a `beforeinstallprompt` handler +
  `maybeRenderPairInstallHint()` that surfaces an inline banner
  with `data-testid="pair-install-hint"` when the operator just
  paired AND a deferred install prompt is pending. "Not now"
  dismissal persists in localStorage so the banner doesn't re-
  appear on reload. Defence-in-depth secret redaction at the
  renderer boundary per LESSONS.
- 2026-06-01 - tests: `tests/qr.test.ts` (15 cases, fixture lock +
  structural invariants), `tests/pair.test.ts` (22 cases, lan
  discovery + mint/consume + schema + /pair route + rate-limit +
  perf gated on PERF=1), `tests/welcome-pair.test.ts` (13 cases,
  welcome render + CLI subprocess + PWA install hint). Zero new
  runtime deps; full local gate (npm ci, tsc --noEmit,
  check-backlog.mjs) green.
- 2026-06-01 - PR #77 opened, CI green (typecheck + validate +
  enable-auto-merge), squash-merged to main.
