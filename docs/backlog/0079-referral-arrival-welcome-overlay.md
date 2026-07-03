---
id: 0079
title: Referral arrival welcome overlay auto-suggests operator.referredBy so the referral graph actually captures who introduced whom
status: groomed
priority: P1
area: portal
created: 2026-07-03
owner: gtm-innovation
---

## User story

As a new fleet operator who arrived at any public fleet-control share URL
via a `?ref=<slug>` link, then installed fleet-control and opened the
portal for the first time, I want the first-run coach card (0074) to show
me a one-tap "you arrived via `<slug>`'s share — record them as your
referrer?" overlay that writes `operator.referredBy` for me, so that the
referral graph shipped by 0068 actually captures the acquisition chain
instead of dying at the first hand-declared config edit nobody remembers
to do.

## Why now (four lenses)

### Product Owner
0068 shipped the referral graph — but it requires each new operator to
hand-edit `fleet-control.config.json` and add `"referredBy": "<slug>"`
before their profile page starts crediting the person who introduced
them. In practice nobody does that. The whole moat 0068 was designed to
build (operator-to-operator acquisition chain) is currently invisible.
The smallest unit of value is closing that gap: capture the referrer at
arrival, propose it at first-run, one tap to accept.

### Stakeholder
Operator-to-operator referral is the highest-leverage acquisition path
we have — one operator who introduces three peers is worth more than any
public landing surface. Making the referral capture automatic is what
turns the referral graph from a dry artifact into a compounding acquisition
loop.

### Operator (first-run, 9am, opening the portal after fresh install)
One overlay on top of the first-run coach card (0074): "You arrived via
`<slug>`'s share — record them as your referrer? [Yes] [Not now]." One
tap, no config editing, no docs to read. Never nags — dismissing hides
it forever.

### Capability — for the operator, NOT an audience
This is a growth capability for the fleet-wide acquisition graph, but
rendered only on the new operator's own loopback portal. Nothing about
the referrer is shown to anyone but the new operator until the operator
opens their own signed profile page (which is the existing 0068
surface). The "show me" moment is the referring operator seeing their
downstream count tick up because the new operator tapped Yes without
ever touching a config file.

## Acceptance criteria

- [ ] Every public share URL (`/share/*`, `/pulse`, `/receipts`,
      `/calculator`, `/lessons-public`, `/failures/*`, `/operator/*`,
      `/embed/*`) preserves any `?ref=<slug>` query param in the rendered
      page's `<meta name="fleet-ref" content="<slug>">` tag and in the
      copy-link paste-blurb.
- [ ] The `fleetctl onboard` wizard (0046) checks for a
      `~/.local/share/agent-fleet/pending-ref` file on first run; if
      present, its `<slug>` is loaded into a new `pending_referrer`
      table row `{ slug TEXT, captured_at INTEGER }` and the file is
      deleted.
- [ ] A new `GET /api/onboarding/pending-referrer` returns
      `{ slug: string | null, captured_at: number | null }` — additive
      JSON.
- [ ] The first-run coach card (0074) reads the pending-referrer row on
      home render; if `slug` is non-null AND
      `operator.referredBy` is not already set, it renders a small
      overlay on top of the day-1 tip with copy "You arrived via `<slug>`'s
      share — record them as your referrer? [Yes] [Not now]."
- [ ] Tapping [Yes] hits `POST /api/onboarding/accept-referrer` with
      `{ slug }`, which writes `operator.referredBy = "<slug>"` into
      `fleet-control.config.json` via the same code path 0068 uses when
      the operator hand-edits, then deletes the `pending_referrer` row.
- [ ] Tapping [Not now] hits `POST /api/onboarding/dismiss-referrer`
      which deletes the `pending_referrer` row without writing config —
      the overlay never re-appears.
- [ ] The overlay is hidden if `operator.referredBy` is already set
      (never re-prompt), if the pending-referrer row is missing, or if
      the coach card itself is past its 7-day window (0074).
- [ ] `pending_referrer` is a single-row table (PRIMARY KEY on a
      fixed sentinel column) — a second arrival with a different ref
      REPLACES the pending row rather than accumulating; the newest wins.
- [ ] The `?ref=` slug is validated against a strict regex
      (`^[a-z0-9][a-z0-9-]{0,62}$`) before being written anywhere; a
      malformed slug is silently dropped.
- [ ] Regression: existing 0074 first-week coach card copy renders
      unchanged when there is no pending referrer.
- [ ] Regression: existing 0068 referral graph rendering is untouched
      once `operator.referredBy` is written — the write goes through
      the same config path.
- [ ] Regression: `npx tsc --noEmit` clean; `node
      scripts/check-backlog.mjs` clean.
- [ ] Safety: no shell-string composition; the config write uses the
      existing atomic-write helper, not a new one; no new runtime deps.

## Out of scope

- Multi-hop referral attribution ("A referred B who referred C, credit
  half to A"). Direct-parent only, matching 0068.
- Signed / cryptographically-authenticated referral tokens. A `?ref=` in
  the URL is enough — nobody is arbitraging a graph the operator sees
  privately.
- Automatic detection of who the referrer is if `?ref=` is absent (e.g.
  parsing HTTP `Referer` header). If the sharing operator did not append
  `?ref=`, the graph misses that arrival — that is fine for v1.
- Editing an existing `operator.referredBy` value. Once set, this ticket
  never overwrites it.
- Prompting on any surface other than the first-run coach card.

## Engineering notes

- `src/db.ts` — add `CREATE TABLE pending_referrer (id INTEGER PRIMARY
  KEY CHECK(id = 1), slug TEXT NOT NULL, captured_at INTEGER NOT NULL)`
  under the existing schema block, bump `SCHEMA_VERSION`.
- `src/views.ts` — every existing public renderer picks up `?ref=` from
  the request URL and threads it into the paste-blurb + meta tag; keep
  the leading comment block free of backticked identifiers that overlap
  the 0052 / 0056 slice-grep windows (LESSONS 2026-06-11 sibling).
- `src/onboard.ts` — the `fleetctl onboard` wizard writes
  `~/.local/share/agent-fleet/pending-ref` when a `--ref=<slug>` flag or
  the `FLEET_PENDING_REF` env is present; on next `fleetctl serve`
  boot the DB row is populated from that file and the file is unlinked.
- `src/server.ts` — three new additive routes:
  `/api/onboarding/pending-referrer`,
  `/api/onboarding/accept-referrer`,
  `/api/onboarding/dismiss-referrer`. Memoise
  `pending_referrer` per boot; invalidate on any accept/dismiss via
  `globalThis.__fleet_pending_referrer_invalidate__`
  (LESSONS 2026-06-05); `_resetPendingReferrerForTests()`
  (LESSONS 2026-06-23).
- `src/views.ts` — new `renderReferrerOverlayForTests(payload, opts)`
  seam so the two config branches (`operator.referredBy` set vs unset)
  do not race the shared cwd config in tests (LESSONS 2026-06-11).
- Freshness detection on `pending_referrer` uses
  `(MAX(captured_at), COUNT(*))` — a surrogate id exists here but the
  single-row-check makes it moot (LESSONS 2026-06-07 pattern applies to
  new tables too).
- `redactSecrets` runs over `{ slug }` VALUES on every new route's
  response body before `JSON.stringify`, never over the serialised
  body (LESSONS 2026-06-10).
- The config write reuses the same atomic-write helper that 0068 uses
  when the operator hand-edits `fleet-control.config.json` — no new
  code path.
- `web/home.html` + the first-run coach card partial — additive DOM slot
  for the overlay; vanilla JS fetch.
- New deps: none (`node:` builtins only). JSON additive only — three
  new routes, no existing route JSON shape changes.

## Implementation log

(Appended by the implementation-dev agent during execution.)
