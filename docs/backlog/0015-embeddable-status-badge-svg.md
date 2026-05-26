---
id: 0015
title: Embeddable status badge SVG per project
status: groomed
priority: P1
area: portal
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator with 3-7 projects each carrying its own README, I
want a one-line SVG badge I can paste into any project's README that
shows the live state of that project's autonomous agent (last outcome,
recent cost, age of the last ship), so that every time the README is
opened on GitHub or in an editor the badge is a quiet acquisition
surface and a one-click path back to the portal.

## Why now (four lenses)

### Product Owner
The cheapest unit of acquisition the control plane can ship. One
handler, hand-rolled SVG, no schema. Every README that pastes the badge
produces a daily impression for free and the operator never has to think
about it again. Pairs with 0013 (shareable snapshot) under the same
"public surface, zero-PII" discipline — but cheaper because there's no
token to mint and no anonymization rules to maintain.

### Stakeholder
Widens the moat on `portal`. A SaaS dashboard cannot generate a badge
for a private repo without write access to it. Because fleet-control
runs locally, the operator can paste a URL pointing at their own laptop
and the badge works for private repos with zero auth wiring. The badge
URL is self-documenting — anyone curious about the badge clicks
through and lands on the portal home, the strongest possible "show me"
moment.

### User (operator at 9am, looking at the portal)
On any project page, a small "Embed" affordance reveals a copy-pastable
markdown snippet:
`![fleet-control](http://laptop:7070/badge/<slug>.svg)`. The badge is
Shields-style (left-half label, right-half value, flat color). Three
variants selectable via query: `?metric=status` (success / fail /
in-progress), `?metric=cost` (last 7d USD), `?metric=ship` ("3h ago"
since last shipped run). One glance, three colors, never broken.

### Growth
Every operator who pastes the badge becomes a passive distributor. The
badge is the most timeline-shareable artifact the product can produce
because it borrows a familiar form. Combined with 0013 (snapshot) an
interested viewer goes badge → snapshot in two clicks and sees the whole
fleet without the operator lifting a finger.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `src/badge.ts` (new) exports `renderBadge({label, value, color})`
      returning a complete SVG string sized to fit its content. The SVG
      is hand-rolled (no template engine), uses a single `<svg>` root,
      and embeds the text widths so the layout is stable. Test: render
      `{label: "fleet", value: "ok", color: "green"}`, assert the
      returned string starts with `<svg`, contains both label and value
      text, contains the color hex, and passes a regex-based
      well-formedness check (balanced tags, single root).
- [ ] `src/badge.ts` exports `projectBadge(db, slug, metric)` returning
      `{label, value, color}` for one of three metrics:
      * `status` — reads the most recent `run` row for the slug.
        `outcome=success` → green `ok`; `failure` → red `fail`;
        `in-progress` → yellow `running`; no rows → grey `unknown`.
      * `cost` — sums `cost_rollup_day.cost_usd` for the slug over the
        last 7 days; value is `$NN.NN`; color green if < $5, yellow if
        $5-$25, red if > $25 (static thresholds, no config in v1).
      * `ship` — relative age of the most recent shipped run; value is
        `Nm` / `Nh` / `Nd` ago; color green if < 24h, yellow if < 7d,
        red otherwise; `never` if no shipped runs.
      Test: seed each scenario into a tmp DB, assert the returned shape
      matches per the table above.
- [ ] `GET /badge/<slug>.svg?metric=<status|cost|ship>` returns
      `Content-Type: image/svg+xml`, `Cache-Control: public, max-age=60`,
      and an `ETag` derived from a sha256 of the rendered bytes.
      Default metric is `status` when the query is omitted. An unknown
      slug returns a grey `unknown` badge with HTTP 200 (NOT 404 — a
      404 inside an `<img>` is uglier than a placeholder badge). An
      invalid metric returns 400 with a plain-text error. Test each
      branch in `tests/badge-route.test.ts`.
- [ ] The badge route does NOT require auth (same posture as 0013's
      `/share/<token>` — public by design; the slug is not a secret on
      a LAN and a public deployment is the operator's choice). Test:
      hit without `x-fleet-token`, assert 200 and an SVG body.
- [ ] `web/app.js` adds an "Embed" affordance on the project page
      header that opens a small panel with three copy-buttons (one per
      metric), each producing the exact markdown to paste. Each button
      uses `navigator.clipboard.writeText` with a `prompt()` fallback
      for environments without the clipboard API. Test: render the
      panel against a stub project, assert each `<button
      data-metric="X">` exists and the textarea content matches the
      expected URL pattern.
- [ ] No new runtime deps. No schema migration (reads `run` and
      `cost_rollup_day` which already exist). `tsc --noEmit` clean. No
      shell-string composition. No `/api/...` JSON-shape change to any
      existing route.
- [ ] The SVG response body never includes the operator's hostname or
      IP — only paths. The `<img src>` URL the operator pastes contains
      the host, but the SVG bytes themselves stay host-neutral so a
      cached badge can be served from anywhere without leaking the
      origin. Test: render a badge, assert the body contains no IP
      literal, no `localhost`, no `127.0.0.1`, no `http://`.

## Out of scope

- Custom colors or themes per badge. v1 is three metrics, static
  thresholds, default Shields-style palette.
- Aggregating across projects in one badge ("fleet status"). The
  leaderboard (0014) is the appropriate surface for fleet-wide views;
  the cross-project badge is a future ticket once 0014 ships.
- Image formats other than SVG. PNG fallback adds rendering complexity
  for a vanishingly small audience.
- A `fleetctl badge` CLI subcommand. The operator already has the URL
  from the portal panel — a separate CLI is friction without value.
- Click tracking on the badge route. The product is local-only; the
  operator can read their own `access.log` if curious.

## Engineering notes

- `src/badge.ts` — new module, pure functions. Keep the SVG layout
  arithmetic in one place; approximate `measureTextWidth` as
  char-count × 6.5px for the default font (no font-metrics lib). Four
  colors are hardcoded constants: green `#3ba55d`, yellow `#dfb317`,
  red `#e05d44`, grey `#9f9f9f`.
- `src/server.ts` — one new route before the existing static-file
  handler. Reuse the response-builder helpers from the snapshot route
  (0013). Be careful with content negotiation: `Accept` may be `*/*`
  from `<img>` tags, so don't gate on it.
- `web/app.js` — small embed panel (~30 lines). Reuse the existing
  `el(...)` helper.
- `web/style.css` — one selector for the embed panel; lean on existing
  CSS variables.
- No new runtime deps. No schema migration.
- Pairs with 0013 (shareable snapshot — both are public-by-design GET
  routes with the same "no token in body" discipline) and 0014
  (leaderboard — once it ships, a fleet-wide badge becomes a natural
  follow-up ticket).

## Implementation log

(Appended by the implementation-dev agent during execution.)
