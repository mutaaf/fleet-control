---
id: 0067
title: fleetctl share CLI subcommand - one command snapshots the current state signs a token and prints a paste-ready multi-line blurb plus copies it to the clipboard so the operator's "look what shipped" moment lands on LinkedIn or Slack in under 5 seconds
status: groomed
priority: P2
area: infra
created: 2026-06-17
owner: gtm-innovation
---

## User story

As a fleet operator who just watched my agents merge a feature, wants to
post about it on Slack / LinkedIn / Bluesky AT THAT MOMENT (the
emotional peak), but who has to currently (a) open the portal, (b)
navigate to the snapshot panel from 0013, (c) name the snapshot, (d)
copy the URL, (e) tab over to Slack, (f) compose a sentence around the
URL - five context switches that kill the impulse, I want one CLI
command `fleetctl share <surface>` (where surface is one of `pulse`,
`receipts`, `calculator`, `lessons`, `profile`) that (a) issues a
signed snapshot token via the existing 0013 infra, (b) renders a paste-
ready 3-line blurb to stdout AND copies it to the macOS pasteboard
(`pbcopy`), and (c) reminds me of the existing revoke command, so that
the share moment is one keystroke + one Cmd-V in Slack instead of five
context switches the impulse never survives.

## Why now (four lenses)

### Product Owner

0013 ships the SHARE INFRA (signed token, anonymised view, /share/
route, revoke surface). 0041 / 0050 / 0051 / 0054 / 0057 / 0058 ship
the PUBLIC SURFACES the operator might share. 0061 ships the OG
image renderer so every shared URL auto-renders a card preview.
What's MISSING is the FRICTION-REMOVAL layer that turns the existing
infra into a one-keystroke action. Today every share requires:

  1. Open browser tab on portal.
  2. Navigate to snapshot panel (0013 portal surface).
  3. Name the snapshot.
  4. Click create.
  5. Copy the URL.
  6. Tab to Slack / LinkedIn.
  7. Compose a sentence around the URL.

Seven steps. The "emotional peak" of a freshly-merged feature lasts
about 30 seconds. The seven-step flow takes 90+ seconds. Most shares
die in step 2 or 3.

The smallest meaningful unit of value: ONE new CLI subcommand
`fleetctl share <surface> [--name "<label>"]` that:

1. ISSUES a signed snapshot token via the existing 0013 helper
   (`createSnapshot(db, { kind, label })`). PRODUCER-VS-SPEC
   NOTE: grep `src/snapshots.ts` (per the 0013 module path) for
   the existing helper signature - REUSE, do NOT re-author.
2. RESOLVES the share URL based on `<surface>`:
   - `pulse` -> `<host>/share/pulse/<token>` (the existing
     0054 /pulse surface, snapshotted as-of-now).
   - `receipts` -> `<host>/share/receipts/<token>` (0041).
   - `calculator` -> `<host>/share/calculator/<token>` (0051).
   - `lessons` -> `<host>/share/lessons/<token>` (0057 - the
     LATEST lesson permalink AT TIME OF SNAPSHOT).
   - `profile` -> `<host>/operator/<handle>` (0065 - no
     token needed; profile URL is already stable per 0065).
3. COMPOSES a paste-ready 3-line blurb deterministically from
   the snapshot's payload + the surface kind:
   ```
   Just shipped <N> features this week with my autonomous agent fleet.

   This week's fleet pulse: <URL>

   (powered by fleet-control)
   ```
   The blurb is PURE deterministic - no LLM, no randomness, no
   templating that the operator must edit. Each `<surface>`
   has its own template tuned for the surface's emotional
   beat (pulse = this-week numbers; receipts = this-month
   numbers; calculator = the time-saved claim; lessons = the
   most-cited lesson title; profile = lifetime totals).
4. COPIES the blurb to the macOS pasteboard via
   `execFile('pbcopy', [])` with the blurb piped to stdin.
   PRODUCER-VS-SPEC NOTE per AGENTS.md Hard NOs: NEVER
   compose a shell string. The pbcopy call uses
   `execFile('pbcopy', [], { input: blurb })` - argv array,
   stdin string. NO shell. NO interpolation. On non-Mac
   (Linux test environments), the helper logs "pbcopy not
   available - blurb printed to stdout" and exits 0; the
   blurb is still on stdout for manual copy.
5. PRINTS to stdout: the blurb itself + a footer "URL copied
   to clipboard - revoke any time with: fleetctl share
   revoke <token>".

The operator's experience: type `fleetctl share pulse` (3
seconds), Cmd-Tab to Slack (1 second), Cmd-V (1 second).
Total: 5 seconds. From emotional peak to shared post.

PRODUCER-VS-SPEC NOTE per LESSONS 2026-06-05: the implementing
dev MUST grep `bin/fleetctl.ts` for the existing `snapshot`
subcommand argv shape (per 0013) - the new `share` subcommand
is a SIBLING, NOT a replacement. The existing `snapshot
create / list / revoke` flows stay intact for the operator
who wants the verbose form. Per LESSONS 2026-05-26 "shell-
out modules need an injectable runner for tests" - the
pbcopy shell-out uses the existing runner seam OR a NEW
one-purpose seam `_setShareClipboardForTests(fn)`.

### Stakeholder

Widens the moat on the ACQUISITION-VIRAL-LOOP axis where no
existing surface invests. The cross-fleet courtiq lesson
"every share is a hand-crafted micro-marketing action; the
tool that REMOVES the hand-crafting wins the viral loop"
(CROSS_LESSONS section courtiq Entries 2026-05-21 family on
friction-reduction) applies directly: today the operator
who SHARES once a week is the upper bound; the operator who
shares ONCE A DAY (because each ship is now a 5-second
action) is the moat compound.

The hosted-competitor structural gap: hosted observability
tools COULD ship the same CLI - but the CLI would have to
hit the hosted API, which means authn + per-call cost +
latency. fleet-control's CLI ships locally against the local
SQLite + the local snapshot helper - one process, one DB
read, one pbcopy. Zero round-trip. The hosted tools can't
match the latency without losing money on every call.

The "show me" moment worth a screenshot: the operator's
Slack thread with five back-to-back fleet-control shares
in one week (vs the previous "I'll share next week"
months). Every Slack reader who clicks any of those URLs
is a high-intent fleet-control impression.

Pairs with 0013 (token infra), 0054 / 0041 / 0051 / 0057 /
0065 (the shared surfaces), 0061 (OG image - the rendered
LinkedIn card is the impression, the blurb is the caption),
0046 (onboard wizard - the README addendum names the
share CLI as a day-one win).

### User (operator at 9am, looking at the portal)

Two operator scenarios:

1. **The impulse share** (the high-leverage moment): the
   operator's terminal still has the `fleetctl status`
   output showing the freshly-merged PR. The operator
   types `fleetctl share pulse`. The CLI prints:
   ```
   Just shipped 4 features this week with my autonomous agent fleet.

   This week's fleet pulse: http://192.168.1.42:7070/share/pulse/8f3c...

   (powered by fleet-control)

   URL copied to clipboard - revoke any time with: fleetctl share revoke 8f3c...
   ```
   Cmd-Tab to Slack. Cmd-V. Done. 5 seconds end-to-end.

2. **The deliberate share** (less common but real): the
   operator wants to share the year-in-review at end-of-
   year. Types `fleetctl share year`. (NOTE: v1 does NOT
   ship a `year` surface - operator uses
   `fleetctl share profile` or composes manually for
   /year. A future v2 ticket could add `year` as a
   surface; out of scope here.)

Per LESSONS 2026-05-26 "CLI subprocess tests need a
FLEET_DB_PATH env seam" - the new subcommand tests drive
the CLI as a subprocess with `FLEET_DB_PATH` pointing at
a tmpdir DB. Per the same lesson the pbcopy shell-out is
swapped via the runner seam so the test doesn't actually
write to the operator's clipboard.

### Growth

The growth bet: every removed step in the share flow is a
multiplier on the share-frequency curve. An operator who
shares once a week becomes an operator who shares twice
a week. Twice-a-week share frequency is the threshold
above which the operator's surrounding network starts
RECOGNISING the brand - "ah, that's the autonomous-agent-
fleet person again" becomes a passive impression that
compounds with the active impressions.

Per the cross-fleet courtiq lesson "the conversion lift
from removing one friction step is asymmetric -
removing the LAST step (the copy/paste switch) lifts
share frequency 2-3x; removing the middle steps lifts
it 1.2x; removing the first step (deciding to share at
all) lifts it 1.05x" (CROSS_LESSONS section courtiq
Entries 2026-05-21 family on friction-step asymmetry),
the share CLI is exactly the LAST-STEP intervention.
The pbcopy plumbing is the multiplier.

A subtle moat property: the CLI surface is INVISIBLE TO
COMPETITORS - it doesn't show up on a public web page,
it doesn't surface in a marketing comparison, it's the
quiet thing the operator notices on day three of
ownership when they're posting their second share of
the day. Competitive moats built on quiet ergonomic
wins compound silently.

Pairs with 0013 (token infra), 0054 / 0041 / 0051 /
0057 / 0065 (the surfaces), 0046 (onboard wizard
references the new CLI), 0016 (doctor - a future
follow-up check could verify pbcopy is available).

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC
NOTE per LESSONS 2026-06-05: the implementing dev MUST
grep `bin/fleetctl.ts` for the existing `snapshot`
subcommand argv shape (per 0013) AND grep
`src/snapshots.ts` (per 0013's actual module path) for
the existing `createSnapshot` helper signature - REUSE
both, do NOT re-author. Per LESSONS 2026-05-26 the
pbcopy shell-out uses the existing `_setRunnerForTests`
seam OR a new one-purpose
`_setShareClipboardRunnerForTests` seam (the latter
is preferred per LESSONS 2026-06-10 on tightening
stubs to discriminate on the specific axis the real
binary uses - here the axis is "pbcopy vs anything
else"). NO new runtime deps; the CLI composes the
blurb in pure code.

- [ ] New subcommand `fleetctl share <surface>` in
      `bin/fleetctl.ts` accepts surface in
      `{ pulse, receipts, calculator, lessons, profile,
      revoke }`. The revoke surface is a special case:
      `fleetctl share revoke <token>` calls the
      existing 0013 revoke helper directly. Test:
      invoke each of the 5 share surfaces as a
      subprocess with `FLEET_DB_PATH` pointing at a
      tmpdir DB + minimal config; assert each returns
      exit 0 + a non-empty blurb on stdout.

- [ ] Blurb composition: a new pure helper
      `composeShareBlurb({ surface, payload, url })`
      in `src/share.ts` (new module) returns a
      deterministic 3-line string. Each surface
      has its own template (pulse uses "<N>
      features this week"; receipts uses "<N> this
      month for ~$<X>"; calculator uses the median
      time-saved claim; lessons uses the most-
      cited lesson title; profile uses lifetime
      totals). Per LESSONS 2026-06-13 the helper
      lives in a NEW module `src/share.ts` (NOT
      `src/views.ts`) because the blurb composer
      doesn't share a SQL surface with views and a
      new module avoids the function-import cycle
      risk (the share module imports views.ts
      one-way for the payload helpers; views.ts
      does NOT import share.ts). Test: invoke
      `composeShareBlurb` twice with identical
      input; assert strict equality. Invoke with
      each of the 5 surface kinds; assert the
      output contains the surface-specific
      signature phrase.

- [ ] Clipboard plumbing: the subcommand invokes
      pbcopy via `execFile('pbcopy', [], { input:
      blurb })`. The exec is gated through a
      runner seam `_setShareClipboardRunnerFor
      Tests(fn)` per LESSONS 2026-05-26 so the
      test can assert the argv shape AND the
      stdin string without writing to the real
      clipboard. Per AGENTS.md Hard NOs: argv is
      an array literal `[]`, NEVER a composed
      shell string. Test: drive the subcommand
      via the seam; assert the seam saw
      `cmd === 'pbcopy'` AND `argv.length === 0`
      AND `opts.input === <blurb>`.

- [ ] Non-Mac fallback: when the pbcopy binary
      returns ENOENT (Linux CI), the subcommand
      logs "pbcopy not available - blurb printed
      to stdout" to stderr and exits 0 (NOT 1 -
      the blurb is still useful on stdout for
      manual copy). PRODUCER-VS-SPEC NOTE per
      LESSONS 2026-06-15 on the doctor-check
      offline-gate discipline - the
      `FLEET_SHARE_NO_CLIPBOARD=1` env var
      explicitly forces the no-pbcopy branch for
      tests so the test doesn't have to actually
      shell out to a missing binary. Test: drive
      the subcommand with
      `FLEET_SHARE_NO_CLIPBOARD=1`; assert exit
      0 + the stderr line + the blurb on stdout.

- [ ] URL resolution: each surface's URL uses the
      `host` + `port` from `loadConfig()` AND
      embeds the snapshot token. The CLI resolves
      the URL as `http://<host>:<port>/share/
      <surface>/<token>`. When `host === '0.0.0.0'`,
      the CLI SUBSTITUTES the loopback IP for the
      stdout URL (a `0.0.0.0` URL is unparseable
      by Slack); per LESSONS 2026-06-15 on the
      doctor-check offline-gate discipline - the
      substitution is a pure function `resolveShare
      Host(config)` that's testable directly. Test:
      drive `resolveShareHost` with three configs
      (`127.0.0.1`, `0.0.0.0`, `192.168.1.42`);
      assert the loopback case returns
      `127.0.0.1`, the wildcard case returns
      `127.0.0.1`, and the LAN-bound case returns
      the LAN IP.

- [ ] Snapshot token issuance: each share
      subcommand creates a SNAPSHOT row via the
      existing 0013 helper. The token kind
      depends on surface (`pulse` -> kind `share_
      pulse`; etc). PRODUCER-VS-SPEC NOTE: grep
      `src/db.ts` for the `snapshot.kind` column
      to confirm TEXT with no CHECK constraint
      blocking the new values. The `profile`
      surface SKIPS the token issuance (the
      0065 profile URL is unauthenticated and
      handle-scoped, no token needed); the CLI
      resolves the URL from `config.operator?
      .handle` and 404s with a helpful message
      if the handle is undefined ("set operator.
      handle in fleet-control.config.json to
      enable the profile share"). Test: invoke
      `fleetctl share pulse`; assert a snapshot
      row with kind=`share_pulse` lands in the
      DB. Invoke `fleetctl share profile` with
      no operator handle; assert exit 1 + the
      stderr help message. Invoke with the
      handle set; assert exit 0 + the URL on
      stdout WITHOUT a token segment.

- [ ] Revoke subcommand: `fleetctl share revoke
      <token>` calls the existing 0013 revoke
      helper directly. PRODUCER-VS-SPEC NOTE:
      grep `src/snapshots.ts` for the existing
      revoke signature - REUSE, do NOT
      re-author. Test: create a snapshot via
      the share subcommand; assert the
      snapshot row is present. Invoke
      `fleetctl share revoke <token>`; assert
      the snapshot's revoked_at is set
      (matching the 0013 producer's column
      name - PRODUCER-VS-SPEC: grep the
      schema).

- [ ] Help surface: `fleetctl share` (no
      surface) prints a help block listing the
      5 supported surfaces + revoke + a one-
      sentence usage example. The help block
      is composed in `bin/fleetctl.ts` using
      the same style as the existing
      `snapshot` help (per 0013 - PRODUCER-VS-
      SPEC: grep for the existing
      `printSnapshotHelp` or equivalent and
      mirror the style). Test: drive
      `fleetctl share` with NO arg; assert
      exit 0 (NOT a usage error) + the help
      block on stdout naming all 5 surfaces +
      the revoke action.

- [ ] tsc --noEmit clean. No new runtime deps.
      No shell-string composition (the pbcopy
      call uses argv-array form). No JSON-
      shape break (the CLI prints to stdout/
      stderr; the only DB write is a NEW
      snapshot row matching the existing
      schema). No schema migration. Per
      LESSONS 2026-06-11 character-window
      source greps - the new module's
      comment block uses plain prose for
      sibling-helper-grep-vulnerable
      identifiers. Per LESSONS 2026-06-15
      on static "before /api/" greps - the
      share module has no server.ts
      interaction so no ordering grep is
      relevant. Per LESSONS 2026-05-26
      "shell-out modules need an injectable
      runner for tests" - the clipboard
      shell-out exposes a one-purpose
      runner seam.

- [ ] Doctor extension (optional but
      strongly recommended): the existing
      `fleetctl doctor` per 0016 grows ONE
      new check "share clipboard available"
      that probes pbcopy via the injected
      `deps.exec` runner. Per LESSONS
      2026-06-15 the new doctor check sits
      INSIDE the `if (!opts.offline)`
      branch alongside the other I/O
      checks - the CLI subprocess test
      with `FLEET_DOCTOR_OFFLINE=1`
      bypasses the check. Test: drive
      `fleetctl doctor` with a stub
      runner returning ENOENT; assert
      the check renders as warn (NOT
      fail - the no-pbcopy fallback is
      degraded-but-working). Drive with
      a stub returning success; assert
      the check renders as ok.

## Out of scope

- AUTOMATIC sharing (the operator's `ship`
  phase auto-shares every merge). Auto-
  share is creepy and brittle (every share
  is a permanent public artifact); the
  operator MUST trigger the share manually.
- A WEBHOOK-shaped share (the CLI posts
  directly to Slack / LinkedIn). Requires
  authn + per-instance webhook config + new
  runtime deps. The pbcopy + Cmd-V flow is
  good enough for v1 and stays zero-dep.
- A TEMPLATE EDITOR (the operator
  customises the blurb prose). v1 is the
  5 hard-coded templates; per the cross-
  fleet courtiq lesson on
  "configurability is a friction tax for
  the median operator" - most operators
  will paste the default verbatim.
- A SECOND SURFACE for "share an open PR"
  (the operator wants to share a PR
  link directly). The PR URL is already
  one click from `fleetctl status`; no
  new infra needed.
- A SHARE HISTORY ("show me my last 10
  shares"). The existing 0013 `snapshot
  list` command surfaces all snapshots
  including the new share-kind ones.
- A PWA-INSTALLED clipboard alternative
  (the portal-shaped surface that uses
  the browser's clipboard API instead
  of pbcopy). v1 is CLI-only; a
  portal-side share button is a future
  ticket if operator feedback demands.
- A MULTI-SURFACE SHARE ("post BOTH
  pulse AND receipts in one blurb").
  v1 is one surface per share; the
  operator who wants both posts twice.
- A YEAR SURFACE. The /year/<YYYY>
  surface (0050) is annual; a CLI
  share for the year is a future v2
  ticket.

## Engineering notes

- `bin/fleetctl.ts` - new subcommand
  `share <surface> [--name <label>] |
  revoke <token>`. PRODUCER-VS-SPEC
  NOTE: grep the existing `snapshot`
  subcommand for the argv parsing
  shape; mirror it. The subcommand
  is SIBLING to `snapshot`, not a
  replacement.
- `src/share.ts` (new module) - the
  blurb composer + URL resolver +
  pbcopy plumbing. PURE on its inputs
  except for the clipboard call. Per
  LESSONS 2026-06-13 a new module
  (NOT views.ts) avoids the function-
  import cycle. The module imports
  views.ts ONE WAY for the payload
  helpers (`fleetWeeklyPulse`,
  `lessonSavingsRollup`,
  `operatorProfilePayload` per 0065);
  views.ts does NOT import share.ts.
- `src/share.ts` - exports
  `composeShareBlurb({ surface,
  payload, url })`,
  `resolveShareHost(config)`,
  `_setShareClipboardRunnerForTests
  (fn)`, `_resetShareClipboardRunner
  ForTests()`. The clipboard runner
  seam matches the existing
  `_setPrRunnerForTests` /
  `_setRunnerForTests` convention
  per LESSONS 2026-05-26.
- `src/snapshots.ts` (existing per
  0013) - REUSE the existing
  `createSnapshot(db, { kind,
  label })` and
  `revokeSnapshot(db, token)`
  helpers. The new `kind` values
  (`share_pulse`, `share_receipts`,
  `share_calculator`,
  `share_lessons`) extend the
  existing TEXT column with no
  schema migration.
- `src/server.ts` - existing
  `/share/<surface>/<token>`
  routes (per 0013 + 0054 / 0041
  / 0051 / 0057 - PRODUCER-VS-SPEC
  NOTE: confirm each surface
  already serves a tokened
  variant; if not, the share CLI
  for that surface falls back to
  pointing at the public stable
  URL and skipping token
  issuance). The `lessons`
  surface might point at the
  most-recent /lessons-public
  /<lesson-slug> permalink (per
  0057) - the share helper picks
  the most-recent lesson at
  snapshot time and pins the
  token to that slug.
- `src/doctor.ts` - one new
  check "share clipboard
  available" inside the
  `if (!opts.offline)` branch
  per LESSONS 2026-06-15.
- `tests/share.test.ts` (new) -
  one `test(...)` per AC
  checkbox above. Per LESSONS
  2026-05-26 the subprocess
  tests drive
  `FLEET_DB_PATH` and seed a
  minimal config. The
  clipboard-write tests use
  the runner seam, NOT a
  real pbcopy. The non-Mac
  fallback test drives
  `FLEET_SHARE_NO_CLIPBOARD=1`.
- `tests/doctor.test.ts`
  (existing) - extend with
  the new check assertion
  per AC9.
- `README.md` - one new
  subsection "Share with one
  command" under the
  `fleetctl` CLI table
  documents the subcommand
  and the 5 supported
  surfaces.
- Schema migration: NO. The
  new `snapshot.kind`
  values extend the existing
  TEXT column.
- No new runtime deps.
  Pairs with 0013 (token
  infra), 0054 / 0041 /
  0051 / 0057 / 0065 (the
  share surfaces), 0046
  (onboard wizard
  references the new CLI),
  0016 (doctor surface),
  0061 (OG image - the
  rendered card preview
  paired with the blurb
  caption).

## Implementation log

(Appended by the implementation-dev agent during execution.)
