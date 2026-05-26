---
id: 0011
title: Mobile-first portal pass for home and project pages
status: in-progress
priority: P1
area: portal
created: 2026-05-26
owner: gtm-innovation
---

## User story

As a fleet operator glancing at the portal on my phone over morning
coffee, I want the home and project pages to render legibly and respond
to one-thumb taps without zooming, so that the once-or-twice-a-day phone
check stays a 10-second action and never escalates into "let me find my
laptop".

## Why now (four lenses)

### Product Owner
This is the smallest meaningful subtraction in the whole roadmap.
Today the home page lays out project cards in a fixed multi-column grid
that ends up wider than a phone viewport — the operator pinch-zooms,
mis-taps, or just bounces to the desktop later. Shipped 0007 made the PR
review surface phone-friendly; this ticket finishes the job for the two
pages that get hit on every visit. One pass, one PR, no new concepts —
just CSS, a couple of layout class swaps in `app.js`, and a `<meta
viewport>` audit. Every future feature lands into a better baseline.

### Stakeholder
Widens the moat on glance UX. "Works on the phone" is one of the four
distinguishing properties named in the agent brief, and right now the
portal only half-delivers on it. Competing tools that get pulled toward
mobile inevitably bring in Tailwind or a UI kit; we keep zero deps and
ship a deliberate hand-tuned mobile pass. That's a credible-builder
signal whenever someone forks this.

### User (operator at 9am, looking at the portal)
At 9am on the train, one-handed: home page renders one project per row,
state badge + last-outcome + 30d cost + alert pill visible without
scrolling per card. Tap a card → project page renders job cards stacked,
PRs section directly below, the sticky action bar from 0007 still works.
No horizontal scroll anywhere. Tap targets are at least 44pt. Dark
ambient — no white flash on open.

### Growth
The phone screenshot is the share-worthy artifact. Today the portal
screenshots are desktop-only; once the mobile pass lands, every operator
who installs fleet-control has a memorable image they can paste into a
group chat: "this is what controlling my agent fleet looks like from
the couch." That's the acquisition lever for the next operator.

## Acceptance criteria

Each box maps 1:1 to a test scenario the dev agent writes against the
SPA in headless mode (node test using `node:test` + a JSDOM-style local
fetch — or a hand-rolled DOM smoke runner; pick what stays zero-dep).

- [ ] `web/index.html` has `<meta name="viewport" content="width=device-width,
      initial-scale=1, viewport-fit=cover">` exactly once. Test: assert
      the meta tag exists and matches.
- [ ] `web/style.css` introduces a single `@media (max-width: 640px)`
      block that: stacks project cards one per row, drops card padding
      to a defined `--card-pad-mobile`, scales the headline font down
      one step, and increases all clickable element min-height to 44px.
      Test: load `style.css` as text, assert the media query exists and
      the rules above are present.
- [ ] At a 375×812 viewport (iPhone 13 mini), the home page renders no
      horizontal scrollbar. Test: render `web/index.html` under a
      headless DOM with viewport 375 wide, run `app.js` against a
      stubbed `/api/fleet` response, assert `document.documentElement
      .scrollWidth <= 375`.
- [ ] Same test at 414×896 (iPhone 14 Plus). Same assertion.
- [ ] The project page renders job cards stacked one per row at 375
      wide. Test: same headless harness, navigate to `#/p/<slug>` with
      a stubbed `/api/project/<slug>`, assert the job-card container has
      `flex-direction: column` (or its grid-template-columns resolves
      to a single column) in the computed style.
- [ ] PR rows at 375 wide keep the sticky action bar from 0007 visible
      while scrolling the inline diff. Test: scroll the diff container,
      assert the action bar's bounding rect bottom is within the
      viewport.
- [ ] Tap target audit: every `<button>` and `<a class="action">` has
      computed `min-height >= 44` and `min-width >= 44`. Test: walk the
      DOM after each page renders, assert.
- [ ] Color contrast on the state badges (Working / Idle / Paused /
      Stopped) is at least 4.5:1 against the card background in both
      desktop and mobile media queries. Test: compute the contrast ratio
      from the CSS variables, assert >= 4.5.
- [ ] Desktop layouts are not regressed: at viewport widths >= 960px,
      the home page keeps the existing multi-column grid (snapshot
      compare against the current DOM structure for that breakpoint).
- [ ] `tsc --noEmit` clean. No new runtime deps. No changes to any
      `/api/...` JSON shape (SPA layout only).

## Out of scope

Explicit anti-goals — do not do these, even if they look related.

- A theme switcher / light mode. The portal is dark; mobile pass
  inherits the dark theme verbatim.
- A bottom-nav bar, hamburger menu, or any new navigation primitive.
  Hash routing stays; this ticket is layout discipline only.
- Touch gestures (swipe-to-pause, swipe-to-merge). Tap-only in v1.
- Service worker / offline mode / PWA install banner. Separate ticket
  if the operator ever asks.
- Renaming or restructuring any existing CSS variable that other
  surfaces (the diff renderer in 0007, the cost board) depend on.
  Additive only.

## Engineering notes

- `web/index.html` — add the viewport meta tag if missing; verify the
  `<head>` doesn't already pin a width.
- `web/style.css` — one new media query block at the bottom of the
  file. Use CSS custom properties (`--card-pad-mobile`,
  `--tap-min: 44px`) so future tickets can tune them.
- `web/app.js` — likely no JS changes; if any layout decision is in JS
  rather than CSS, fix the JS by moving the rule into CSS classes.
- A small test helper: `tests/dom-harness.ts` (new) that uses
  `node:test` + a tiny stub DOM. The simplest path is to parse
  `index.html` with `node:html` (built-in in Node 23+) or a hand-rolled
  attribute scanner — do NOT pull in jsdom or happy-dom. If a full DOM
  is impractical without a dep, the dev agent should split tests into
  (a) pure CSS-rule assertions (regex on the stylesheet text) and (b)
  manual checklist items recorded in the PR description.
- No new runtime deps. No new devDeps either unless the dev agent
  cannot satisfy the headless-render assertion with the standard
  library — in which case prefer text-level CSS assertions.
- Schema migration: no.
- Touches: `web/index.html`, `web/style.css`, possibly
  `web/app.js`. The implementation-dev agent's `gtm-innovation` boundary
  forbids me from editing these myself — this ticket is the handoff.

## Implementation log

(Appended by the implementation-dev agent during execution.)
