---
id: 0029
title: PWA installable portal with offline shell and stale-snapshot banner
status: in-progress
priority: P1
area: portal
created: 2026-05-30
owner: gtm-innovation
---

## User story

As a fleet operator who pulls out their phone over morning coffee to ask
"is the fleet OK?", I want to install the fleet-control portal as a
home-screen icon that opens straight into the inbox view and renders the
last-known fleet state even when my laptop is asleep, so that the daily
glance stops requiring me to remember the loopback URL and survives the
ten-second window where my laptop is still waking up or my home wifi just
flapped.

## Why now (four lenses)

### Product Owner
0011 made the portal mobile-friendly; the operator can read it on the
phone. But every visit still starts with "find the URL or the
mDNS hostname, type it, wait for the API." A web app manifest plus a
minimal service worker shell turns that into a one-tap home-screen
launch. This is pure subtraction of friction on a surface the operator
already uses every day - no new data, no new APIs, no new schema. The
smallest meaningful unit of value is "the portal is now an icon."

### Stakeholder
Widens the moat on glance UX, the same property 0011 invested in. The
"works on the phone" promise in the agent brief is half-kept today;
making the portal an installable, offline-tolerant app finishes it and
matches what every operator-tier SaaS dashboard does, while staying
zero-runtime-dep. Crucially, the service worker is hand-rolled vanilla
JS - no Workbox, no PWA-builder - which keeps the "credible builder"
signal that anyone forking this notices. The home-screen icon is also
the single highest-impact acquisition artifact: the next operator sees
it on a friend's phone and gets the picture in one second.

### User (operator at 9am)
At 9am on the kitchen counter, one tap on the fleet-control home-screen
icon. The portal launches in standalone mode (no Safari chrome), the
service worker serves the cached `index.html`/`app.js`/`style.css`
shell instantly, and the SPA does its usual `/api/fleet` fetch. If the
laptop is asleep or unreachable, the operator sees the previous render
under a small amber banner: "Fleet snapshot from 7 minutes ago - laptop
may be asleep." Tapping the banner retries. When the API comes back the
banner clears. No spinner-on-blank-page, no white flash, no "this site
can't be reached" Chrome error.

### Growth
The screenshot worth sharing is "this is my agent fleet, as a
home-screen icon" - which is the single most concrete "this is a real
tool, not a tab I keep open" signal. It also slots cleanly into the
"show a friend" install flow: `npm run fleetctl serve`, scan the QR for
the LAN URL on the phone, tap "Add to Home Screen", done. The before is
"a localhost URL"; the after is "a fleet icon on my phone." That
delta is the strongest single acquisition lever in the four-lens scan.

## Acceptance criteria

Each box maps 1:1 to a test scenario.

- [ ] `web/manifest.webmanifest` (new) exists and is valid JSON with
      `name="fleet-control"`, `short_name="fleet"`, `start_url="/"`,
      `display="standalone"`, `background_color` and `theme_color`
      pinned to the existing dark CSS variables (read the literals
      from `web/style.css` so the values cannot drift), an `icons`
      array with at least one 192x192 and one 512x512 PNG entry, and
      `scope="/"`. Test: `JSON.parse` the file, assert each required
      field is present and the icon sizes are correct.
- [ ] `web/icon-192.png` and `web/icon-512.png` (new) ship as static
      assets. Generated as solid-background PNGs containing the
      letter "F" (or an equivalent low-byte mark) so the operator
      sees a recognisable icon in the home-screen grid without
      pulling in any image-generation toolchain. Test: assert both
      files exist and their PNG header bytes (`89 50 4E 47`) match.
- [ ] `web/index.html` adds exactly one
      `<link rel="manifest" href="/manifest.webmanifest">` and one
      `<meta name="theme-color" content="...">` matching the
      manifest. The existing viewport meta from 0011 stays unchanged.
      Test: parse the head for the new tags, assert no duplicates.
- [ ] `web/sw.js` (new) is a vanilla service worker, no imports, no
      build step. On `install` it pre-caches the shell:
      `["/", "/app.js", "/style.css", "/index.html",
      "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"]`
      under a versioned cache name (e.g. `fleet-shell-v1`). On
      `activate` it deletes any cache whose name starts with
      `fleet-shell-` but does not match the current version. Test:
      load `sw.js` as text, assert the install/activate handlers and
      the asset list match the AC.
- [ ] `web/sw.js` `fetch` handler implements **network-first for
      `/api/*`** (so live data wins when the laptop is awake) and
      **cache-first for everything else** (so the shell loads
      instantly). A failed `/api/*` fetch returns a synthetic
      `Response` with `503` status and a JSON body
      `{"stale": true, "reason": "offline"}` so the SPA can detect
      the offline case. Test: stub a `fetch` event with a `/api/fleet`
      request and a thrown network error, assert the synthetic 503
      shape; stub `/style.css`, assert the cached body wins on a
      second call.
- [ ] `web/app.js` registers the service worker on load only when
      `"serviceWorker" in navigator`. Registration failure (e.g.
      Safari private mode) is swallowed silently. Test: stub
      `navigator.serviceWorker.register` to throw, assert no
      uncaught exception reaches the harness.
- [ ] `web/app.js` reads the `stale` flag from any failed `/api/*`
      response and renders a single amber banner above the inbox:
      "Fleet snapshot may be stale - laptop unreachable. Tap to
      retry." The banner has `data-testid="stale-banner"` so the
      SPA test can assert it appears/disappears precisely (per
      cross-fleet pattern: stable test hooks for duplicate-name
      surfaces). Tapping it triggers a re-fetch; if the re-fetch
      succeeds the banner is removed. Test: stub the API with one
      503 then a 200, assert the banner appears, then disappears
      after tap.
- [ ] All operator-rendered strings flowing into the stale-banner
      path (e.g. cached project names, error reasons) pass through
      `redactSecrets` per LESSONS § "defence-in-depth secret
      redaction at the renderer boundary" before being inserted
      into the DOM. Test: stub a cached payload containing a
      `ghp_...` token in a project name, assert the rendered DOM
      does not include the literal.
- [ ] `src/server.ts` serves the three new static files
      (`/manifest.webmanifest`, `/sw.js`, `/icon-192.png`,
      `/icon-512.png`) with the right MIME types
      (`application/manifest+json`, `application/javascript`,
      `image/png`). The `/sw.js` response includes the
      `Service-Worker-Allowed: /` header. Test: hit each path
      against an in-process `startServer()` (per LESSONS §
      "in-process startServer() tests need an empty-roots config
      + run-row seeds"), assert 200 and the correct content-type.
- [ ] No new runtime deps. `tsc --noEmit` clean. No JSON-shape break
      to any existing `/api/...` route (the synthetic 503 lives in
      the service-worker layer, never on the wire from the server).
      No shell-string composition. Mobile viewport contract from
      0011 holds: at 375x812 the stale banner does not introduce
      horizontal scroll.

## Out of scope

- Push notifications via the service worker. The ntfy module (0009)
  is the only push surface; the SW is for shell caching only.
- Background sync of `/api/fleet` while the app is closed. v1 is
  on-foreground only.
- A custom install prompt in the SPA (the "Add to Home Screen"
  button). v1 relies on the browser's built-in prompt; an in-app
  banner is a clean follow-up if operators ask.
- Offline mutations (queuing pause/resume calls while disconnected
  and replaying them). v1 is read-only when offline; all control
  actions hard-require the API to be reachable.
- LAN auto-discovery / mDNS hostname publishing. The operator
  enters the LAN URL once at install time.
- Caching `/api/*` responses for offline read. v1 only renders the
  last in-memory SPA state under the stale banner - no IndexedDB,
  no localStorage snapshot. Keeps the failure mode simple.

## Engineering notes

- `web/manifest.webmanifest` - new. Pin colours to literal hex
  values matching the `--bg` and `--panel` CSS variables; a small
  text-fixture in the test reads `style.css` and asserts the
  manifest's colours match, so a future palette change forces a
  manifest sync rather than silent drift.
- `web/sw.js` - new. Vanilla service worker, no imports. Versioned
  cache name so the activate handler can purge old shells; bump
  the version literal when any shell asset changes. Per LESSONS §
  "in-process dedup sets need an explicit reset hook for tests",
  if the SW grows any module-level Set/Map state in a follow-up,
  it must expose a `_resetForTests()` seam - but v1 keeps state
  inside the cache API only, so no seam needed yet.
- `web/icon-192.png`, `web/icon-512.png` - new. Generate once,
  commit. Solid background + a single glyph; no font dependency
  (rasterise from a `<canvas>` one-off and check in the bytes).
- `web/index.html` - one new `<link rel="manifest">`, one
  `<meta name="theme-color">`. Both pinned at exactly one
  occurrence each.
- `web/app.js` - one new `registerServiceWorker()` helper called
  on load, plus a small `renderStaleBanner({reason})` helper and
  a `clearStaleBanner()` wired to the existing fetch error path.
  The banner uses a stable `data-testid="stale-banner"` per the
  cross-fleet pattern for duplicate-name surfaces.
- `src/server.ts` - extend the existing static-asset router with
  the four new paths. The MIME table is small (already handles
  `.js`, `.css`, `.html`); add `.webmanifest`, `.png`. The
  `Service-Worker-Allowed: /` header is added on the `/sw.js`
  branch only.
- New deps: none. PNG bytes ship as committed binaries, manifest
  is hand-written JSON, service worker is vanilla.
- Schema migration: no.
- `tests/pwa.test.ts` (new) - one `test(...)` per AC checkbox.
  The in-process `startServer()` tests follow LESSONS §
  "in-process startServer() tests need an empty-roots config +
  run-row seeds, not direct rollup inserts" - plant a temporary
  `fleet-control.config.json` in cwd pointing roots at an empty
  tmpdir, snapshot/restore on cleanup. The service-worker
  handler tests are text-level (assert the install/activate/fetch
  shapes by parsing `sw.js` as a string) rather than booting a
  real SW runtime - that keeps the test dep-free.
- Pairs with 0011 (mobile-first portal pass is the prerequisite;
  this ticket extends it from "renders on phone" to "lives on
  phone"), 0017 (the inbox is the natural landing page after
  install - the SW serves the shell so the inbox glance is sub-
  second on cold start), and 0024 (first-run welcome - a future
  follow-up could print the LAN install URL + QR command in the
  welcome banner).

## Implementation log

- 2026-05-30 — implementation-dev: flipped status groomed → in-progress and
  opened `feat/0029-pwa-installable-portal`. Plan:
  add `web/manifest.webmanifest`, `web/icon-192.png`, `web/icon-512.png`,
  `web/sw.js`; patch `web/index.html` with the manifest link; patch
  `web/app.js` to register the SW + render the stale banner via
  `redactSecrets`; extend the static-asset router in `src/server.ts` with
  the four new paths and the `Service-Worker-Allowed: /` header on
  `/sw.js`; add `tests/pwa.test.ts` with one `test()` per AC checkbox
  (server-route tests follow LESSONS § empty-roots config seed, SW handler
  tests stay text-level).
