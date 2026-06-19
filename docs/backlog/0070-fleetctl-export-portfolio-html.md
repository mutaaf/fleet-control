---
id: 0070
title: fleetctl export portfolio command writes a single self-contained portfolio.html bundle - inlined CSS, data URI OG image, no external fetches - so the operator can email it / attach to a CV / archive offline and the accumulated-history moat becomes a portable artifact the operator owns forever
status: groomed
priority: P2
area: infra
created: 2026-06-19
owner: gtm-innovation
---

## User story

As a fleet operator who has been running fleet-control for 8 months,
who wants to attach my agent-fleet portfolio to a job application but
cannot email a live `/operator/<handle>` URL (the recipient's
firewall blocks loopback / LAN URLs, and the URL also goes dead the
moment my laptop sleeps), and who also wants an OFFLINE archival
artifact of my accumulated lessons + receipts + ships at the end of
each year, I want one CLI command `fleetctl export portfolio
[--out <path>]` that writes a SINGLE self-contained `portfolio.html`
file (one file, no sidecar assets, no external fetches at view
time) carrying my profile portfolio + last 12 months of receipts + 10
top-cited lessons + the OG card as a data: URI, so that I can email
the file to a recruiter / attach to a CV / git-commit it to a
personal-website repo / archive it on a USB stick — and the accumulated
history my local fleet-control DB has been carrying for 8 months
becomes a portable artifact I own forever even if I uninstall the
tool tomorrow.

## Why now (four lenses)

### Product Owner

0065 ships the operator profile at `/operator/<handle>`. 0067 ships
the share CLI. 0041 ships the receipts URL. 0050 ships the year-in-
review. EVERY existing surface assumes the operator's fleet-control
process is RUNNING when the artifact is consumed. That assumption
fails three ways:
  - the recipient is OFFLINE or behind a firewall that drops the
    loopback / LAN URL;
  - the operator's laptop is asleep / off when the recipient clicks;
  - the operator UNINSTALLS fleet-control next year and the URLs
    permanently 404 - the moat evaporates.

The smallest meaningful unit of value: ONE new CLI subcommand
`fleetctl export portfolio [--out <path>] [--include-lessons]
[--include-receipts]` that writes a single self-contained HTML
file:

1. **Reads the existing payload helpers**:
   `operatorProfilePayload(db, cfg, now)` (per 0065),
   `lessonCreditRollup(db, now, { windowDays: 365 })` (top
   10 by saves), the 12 most-recent `receipts_published`
   rows (per 0041 schema).
2. **Renders inline HTML**: composes a single HTML document
   with a `<style>` block inlining the existing 0061 / 0065
   CSS rules, a `<header>` with the profile portfolio, an
   `<ol>` of top 10 lessons (anonymised excerpt via the
   existing 0058 `anonymiseExcerpt` inline helper in
   views.ts), an `<ol>` of 12 monthly receipts, and a
   footer with the operator's `displayName` + the install
   link to fleet-control's repo.
3. **Inlines the OG card** as a `<img src="data:image/
   svg+xml;base64,...">` element rendered from the existing
   `renderOperatorOgSvg` (0065) - so the HTML file is
   visually identical whether viewed online or offline, no
   sidecar assets to lose.
4. **Writes to disk**: default path
   `./fleet-portfolio-<handle>-<YYYY-MM-DD>.html`. Operator
   overrides with `--out <path>`. The file is plain UTF-8,
   no compression, no Base64 outer wrapping - so the
   recipient just double-clicks and the browser opens it.
5. **Includes a manifest at the bottom**: an HTML comment
   block `<!-- fleet-control portfolio export, version 1,
   generated <ISO>, lifetime PRs <N>, lessons <N>, months
   <N> -->` so an automated tool (e.g. a personal-website
   build pipeline) can grep the file's freshness.

PRODUCER-VS-SPEC NOTE per LESSONS 2026-06-05: the
implementing dev MUST grep `src/views.ts` for the existing
`operatorProfilePayload` / `lessonCreditRollup` / `computeReceipts`
helper signatures and REUSE them verbatim - the export module is
a PURE consumer, not a parallel SQL surface. Per LESSONS
2026-06-13 the export module is `src/export.ts` (NEW) and
imports views.ts + receipts.ts ONE-WAY for the payload helpers;
neither imports back, so no function-import cycle. Per LESSONS
2026-05-26 the file-write boundary uses the standard
`writeFileSync` from node:fs (no shell-out, no
clipboard / pbcopy parallel - this is a different boundary).

The PORTABLE ARTIFACT property: the file has ZERO external
fetches at view time. No `<script src="">`, no `<link rel=
"stylesheet">`, no `<img src="http">`. Open it on an airplane,
on a USB stick, in a sandboxed browser - it renders identically.
That property is the entire point: the operator's lifetime
fleet history is now a SINGLE FILE they own.

### Stakeholder

Widens the moat on the ACCUMULATED-HISTORY axis. The reasoning:

- Every existing public surface (operator profile, receipts,
  year-in-review) is COUPLED to the operator's running
  fleet-control instance. If the operator uninstalls, the URLs
  permanently 404 and the moat evaporates.
- The portable export DECOUPLES the operator's accumulated
  history from the running tool. The operator who exports
  monthly now has a personal archive of their fleet's
  evolution that survives any uninstall, machine swap, or tool
  abandonment.
- Paradoxically, the portability INCREASES retention: an
  operator who knows they can leave anytime (their data is
  already exported) stays longer because the perceived lock-in
  is low. The cross-fleet courtiq lesson "the strongest
  retention surface is the one that REDUCES perceived lock-in -
  the operator who can leave easily never wants to leave"
  (CROSS_LESSONS section courtiq Entries 2026-05-21 family on
  portability-as-retention) applies directly here.

The hosted-competitor structural gap: a hosted observability
tool CANNOT ship a comparable export because:
  - the customer's history lives on the vendor's servers, not
    their laptop;
  - the vendor has commercial incentive to MAKE leaving hard
    (lock-in is their churn defence);
  - a "download my data" feature from a hosted tool is a JSON
    dump, not a human-readable artifact.

fleet-control's export is a SHAPED HTML artifact ready to email
or git-commit. The shape is the value.

The "show me" moment worth a screenshot: the operator's GitHub
personal-website repo with a commit "added 2026-Q2 fleet
portfolio export" landing the HTML file in `/portfolio/
fleet-portfolio-mutaaf-2026-06-30.html`. The file is browsable
from the repo's GitHub Pages URL. Every reader who opens it
sees the operator's autonomous-fleet history as a self-
contained one-pager.

Pairs with 0065 (operator profile - the export's data
source), 0067 (share CLI - the export is a sibling
subcommand), 0050 (year-in-review - the export reuses the
year totals), 0041 (receipts - the export reuses the monthly
shape), 0061 (OG card - the export embeds it as a data:
URI), 0058 (anonymisation - the lessons excerpt reuses the
inline helper).

### User (operator at 9am, looking at the portal)

Three operator scenarios:

1. **The one-time export** (one keystroke): operator types
   `fleetctl export portfolio`. The CLI prints "wrote
   ./fleet-portfolio-mutaaf-2026-06-19.html (152 KB)". The
   operator double-clicks the file; the browser opens it;
   they verify the layout; they attach it to a job
   application email. Total time: 30 seconds.

2. **The archival ritual** (quarterly): operator runs
   `fleetctl export portfolio --out ~/Documents/fleet-
   archive/2026-Q2.html`. The file lands in their archive.
   Operator commits the file to a private Git repo. Three
   years from now, even if fleet-control no longer exists,
   the operator can still open the file and see their 2026
   fleet history.

3. **The CV moment** (the high-leverage moment): the
   operator is interviewing for a senior engineering role.
   The interviewer asks "show me something you've built
   with autonomous agents". The operator pulls up the HTML
   file from their laptop's local filesystem, screen-shares
   it. The interviewer sees a tasteful 1-page portfolio
   with 60 PRs shipped, 12 monthly receipts, 10 top
   lessons. The portfolio IS the story.

Per LESSONS 2026-05-26 the file-write boundary uses
`writeFileSync` directly (no runner seam needed - the test
writes to a tmpdir path and reads back; the boundary is
deterministic). The CLI subprocess tests drive
`FLEET_DB_PATH` per LESSONS 2026-05-26.

Per LESSONS 2026-06-15 the export module does NOT shell out
(no execFile, no pbcopy), so the offline-gate discipline
does not apply.

### Growth

The growth bet: every exported portfolio is a long-lived
acquisition surface that survives the operator's daily share
rhythm. A LinkedIn post share fades from the feed in 48
hours; a portfolio HTML attached to a CV stays alive for the
duration of the operator's career - and every recruiter who
opens it lands on the "powered by fleet-control" footer.

A second growth surface: SEARCH. An operator who commits the
HTML to a public GitHub Pages site indexes the file in
search engines. The file's content (60 PR titles, 10 lesson
excerpts, 12 receipt months) becomes long-tail SEO content
for fleet-control's brand. Compounds with 0057 / 0058 SEO
surfaces.

Per the cross-fleet courtiq lesson "the highest-converting
acquisition surface is the one the operator OWNS - the
operator's personal website / GitHub Pages / portfolio
domain converts at 5-7% because the visitor is already
qualified" (CROSS_LESSONS section courtiq Entries 2026-05-
21 family on owned-surface-conversion), the portable
export is the first surface that lets the operator HOST
fleet-control's marketing on their own domain.

Pairs with 0065 / 0067 / 0041 / 0050 / 0061 / 0058 -
the surface reuses all the existing renderers.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] New subcommand `fleetctl export portfolio [--out
      <path>] [--include-lessons] [--include-receipts]` in
      `bin/fleetctl.ts` accepts `--out` (default
      `./fleet-portfolio-<handle>-<YYYY-MM-DD>.html` derived
      from `cfg.operator?.handle` and current date) and two
      optional `--include-*` flags (both default true; the
      operator opts OUT of either section by setting the
      flag to false via `--include-lessons=false` per
      LESSONS 2026-05-26 the existing CLI arg-parser
      convention). The subcommand sits ALONGSIDE `fleetctl
      share` (sibling per 0067). Test: invoke the
      subprocess with `FLEET_DB_PATH` pointing at a seeded
      tmpdir DB + operator cfg; assert exit 0 + the
      `--out` path file exists.

- [ ] New module `src/export.ts` exports
      `composePortfolioHtml({ profile, lessons, receipts,
      now, includeLessons, includeReceipts })` returning the
      full HTML string. The composer is PURE on its inputs.
      Per LESSONS 2026-06-13 the new module imports
      `views.ts` (for `operatorProfilePayload`,
      `lessonCreditRollup`, `renderOperatorOgSvg`) and
      `receipts.ts` (for the published receipt rows)
      ONE-WAY; neither imports `src/export.ts` back. Test:
      invoke `composePortfolioHtml` with a deterministic
      payload; assert the returned string starts with
      `<!DOCTYPE html>` AND contains `<style>` AND contains
      `<img src="data:image/svg+xml;base64,` AND ends with
      the manifest comment block.

- [ ] OG card data: URI inlined as
      `<img alt="<operator displayName>'s fleet portfolio
      card" src="data:image/svg+xml;base64,<base64>">`.
      The base64 is computed from
      `renderOperatorOgSvg(profile)` (per 0065). Test: hand
      a known profile payload to the composer; assert the
      rendered HTML contains a `<img src="data:image/svg+
      xml;base64," that decodes via `Buffer.from(b64,
      'base64').toString('utf8')` to a string containing
      `<svg`.

- [ ] No external fetches at view time: the rendered HTML
      contains ZERO `<script src=>` AND ZERO `<link rel=
      "stylesheet">` AND ZERO `<img src="http` (only
      `data:` URIs allowed for images). Per LESSONS
      2026-06-15 the static-grep test anchors on the EXACT
      shape `<script src=` and `<link rel="stylesheet"` so
      a prose comment mentioning the gate doesn't trip the
      assertion. Test: render with the seed; assert all
      three substrings absent.

- [ ] Manifest comment block at the END of the document:
      `<!-- fleet-control portfolio export, version 1,
      generated <ISO>, lifetime_prs <N>, lessons <N>,
      months <N> -->`. The values come from the profile
      payload's totals. Test: render; assert the manifest
      line present with version=1 and the totals matching
      the seed.

- [ ] Empty-state branches:
        - When the operator has 0 lifetime PRs, the
          portfolio renders the existing
          `data-testid="operator-profile-warming-up"` copy
          from 0065 alongside the empty receipts /
          lessons sections (each section renders an
          honest "no receipts published yet" line).
        - When `--include-lessons=false`, the lessons
          section is OMITTED entirely (no
          `data-testid="portfolio-lessons-section"` in
          the output).
        - When `--include-receipts=false`, the receipts
          section is OMITTED.
      Test: invoke with `--include-lessons=false`; assert
      the lessons testid is ABSENT.

- [ ] Missing-handle gate: when
      `cfg.operator?.handle` is undefined, the subcommand
      exits with code 1 AND writes to stderr "set
      operator.handle in fleet-control.config.json to
      enable the portfolio export". No file is written.
      Per the existing 0067 `fleetctl share profile` gate
      pattern. Test: invoke with cfg missing the operator
      field; assert exit 1 + stderr line + NO file at the
      default --out path.

- [ ] Path safety: when `--out <path>` is supplied, the
      CLI rejects any path containing `..` or `\0` and
      exits with code 1 + a stderr line "invalid --out
      path: traversal segments not allowed". Per AGENTS.md
      Hard NO on shell-string composition AND per the
      cross-fleet lesson on path-validation hygiene. Test:
      invoke with `--out=../etc/passwd`; assert exit 1 +
      the stderr line.

- [ ] Existing-file overwrite is INTENTIONAL: when the
      target path exists, the CLI overwrites it WITHOUT
      prompting AND prints a stderr line "overwrote
      existing file at <path>" so the operator notices.
      The overwrite is intentional because the operator
      who runs `fleetctl export portfolio` quarterly wants
      the new file to replace the stale one. Test: pre-
      create a file at --out; invoke; assert exit 0 + the
      stderr line + the new file content (assert the
      manifest's generated_at is fresh).

- [ ] Help surface: `fleetctl export` (no further args)
      prints a help block listing `portfolio` as the only
      v1 sub-surface + the supported flags + a one-line
      usage example. Per LESSONS 2026-06-11 the help
      block reads the same shape as `fleetctl share`'s
      help (per 0067 - grep `printShareHelp` or
      equivalent). Test: invoke `fleetctl export` with no
      arg; assert exit 0 (NOT a usage error) + the help
      block on stdout naming `portfolio`.

- [ ] tsc --noEmit clean. No new runtime deps - lean on
      `node:fs.writeFileSync`, `Buffer.from(..., 'base64')`,
      the existing payload helpers. No shell-string
      composition (no execFile). No JSON-shape break to
      `/api/...` routes. No schema migration. Per LESSONS
      2026-06-11 character-window source greps - the new
      module's leading comment block uses PLAIN PROSE for
      sibling-helper-grep-vulnerable identifiers. Per
      LESSONS 2026-06-15 the static-grep external-fetch
      assertion anchors on the EXACT statement shape, NOT
      a literal substring that could appear in a comment.

## Out of scope

- AUTOMATIC scheduled exports (the operator's daemon
  writes a fresh portfolio every Sunday). Auto-export is
  silent disk churn the operator may not want. v1 is
  manual; the operator runs the CLI when they want a
  fresh artifact.
- A PDF export (the operator wants to email a PDF, not
  HTML). PDF generation requires a headless browser /
  Puppeteer / `wkhtmltopdf` - all new runtime deps,
  hostile to the zero-dep posture. The recipient can
  print-to-PDF from any browser if they need PDF.
- A SIGNED export (the file carries a cryptographic
  signature proving authorship). Out of scope for v1;
  add a future ticket if recruiters demand
  attestation.
- A COMPRESSED bundle (the export is a `.zip` with
  multiple sidecar files). v1 is intentionally a
  SINGLE file - the whole point is portability.
- A PORTAL DOWNLOAD button (the operator clicks "export"
  from the SPA). v1 is CLI-only; portal-side download
  introduces authn / streaming complexity the CLI
  dodges.
- A MULTI-OPERATOR export (the operator exports a
  portfolio for a teammate). v1 exports the cfg.operator
  identity only.
- A FORMAT VERSIONING shim (the export carries a
  migration hint for future schema bumps). v1 stamps
  `version: 1`; a future ticket can ship a v2 with a
  documented migration.
- AN AUTO-COMMIT into a personal-website repo. Out of
  scope; the operator runs `git add` themselves.

## Engineering notes

- `bin/fleetctl.ts` - new subcommand `export portfolio
  [...]` mounted ALONGSIDE the existing `share`
  subcommand (per 0067). PRODUCER-VS-SPEC NOTE: grep
  `bin/fleetctl.ts` for the existing `share` subcommand
  argv parsing shape; mirror the dispatch pattern.
- `src/export.ts` (NEW) - exports
  `composePortfolioHtml({ profile, lessons, receipts,
  now, includeLessons, includeReceipts })` AND
  `runExportPortfolioCli(argv, deps)` (the in-process
  driver the bin shim wraps). The CLI driver returns
  `{ exitCode, stdout, stderr, writtenPath }` so tests
  assert without spawning a subprocess. Per LESSONS
  2026-06-13 the module imports `views.ts` +
  `receipts.ts` ONE-WAY for the payload helpers; neither
  imports back.
- `src/export.ts` - the file-write boundary is a
  function `writePortfolioFile(path, html)` that wraps
  `writeFileSync` and is replaceable via
  `_setExportWriterForTests(fn)` per LESSONS
  2026-05-26 (the tests drive the seam to record path +
  payload without touching disk).
- `src/views.ts` - REUSE the existing
  `operatorProfilePayload`, `lessonCreditRollup`,
  `renderOperatorOgSvg`, `anonymiseExcerpt` (inline
  private per 0058). No new exports from views.ts -
  the export module imports the already-public helpers.
- `src/receipts.ts` - REUSE the existing
  `computeReceipts` / `receiptsFor` helpers per 0041.
  The export reads the 12 most-recent published
  receipt rows from the `receipts_published` table.
- `tests/export-portfolio.test.ts` (NEW) - one
  `test(...)` per AC checkbox above. Per LESSONS
  2026-05-29 every test pins `now` and seeds
  timestamps off the same anchor. The CLI subprocess
  test drives `FLEET_DB_PATH` per LESSONS 2026-05-26.
  The file-write seam test drives
  `_setExportWriterForTests` so the test inspects the
  composed HTML without touching disk.
- `README.md` - one new subsection "Export your
  portfolio" under the `fleetctl` CLI table documents
  the subcommand and the flags.
- Schema migration: NO. The export is derived entirely
  from existing tables.
- No new runtime deps. Lean on `node:fs.writeFileSync`,
  `Buffer.from(...).toString('base64')`, the existing
  payload helpers. Pairs with 0065 (profile), 0067
  (share CLI - sibling subcommand), 0041 (receipts),
  0050 (year-in-review), 0061 (OG card),
  0058 (anonymisation).

## Implementation log

(Appended by the implementation-dev agent during execution.)
