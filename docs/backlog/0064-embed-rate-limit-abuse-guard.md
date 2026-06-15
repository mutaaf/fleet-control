---
id: 0064
title: Embed rate-limit + abuse guard - per-IP token bucket on the public /embed/* and /og/* routes so a popular blog paste does not starve the operator's own loopback portal
status: groomed
priority: P2
area: infra
created: 2026-06-15
owner: gtm-innovation
---

## User story

As a fleet operator whose 0060 pulse widget AND (when 0061 ships) OG card
AND (when 0063 ships) lessons widget all serve PUBLIC unauthenticated
routes to ANY caller on the LAN-accessible host, who has zero defence
against a misconfigured blog crawler hammering `/embed/pulse.html` at 50
requests per second AND would notice my own portal stuttering long
before I figured out why, I want a SINGLE per-IP token-bucket rate-
limiter sitting in front of every `/embed/*` and `/og/*` route plus a
single `/share` admin view exposing the current bucket state, so that
the public embed surfaces stay available to legitimate readers but a
runaway crawler is throttled before it starves the operator's own
loopback experience.

## Why now (four lenses)

### Product Owner

0060 (pulse widget) shipped without any rate-limit. 0061 (OG images,
groomed) and 0063 (lessons widget, groomed) follow the same posture -
all are public, unauthenticated, served by the same `node:http` server
that also serves the operator's authenticated portal. The shared
server is the choke point: a blog crawler that mis-parses
`Cache-Control: max-age=300` and re-fetches every second pulls
attention from the same node event loop that the operator's loopback
SPA fetches `/api/fleet` from. There is no current defence; the
operator's only mitigation today is `lsof -iTCP:7070` and a manual
`launchctl bootout` of the server.

The smallest meaningful unit of value: ONE per-IP token-bucket
middleware applied to the path prefixes `/embed/`, `/og/`, and
`/share/` (the existing 0013 snapshot-token-anchored share path),
PLUS a `/api/admin/rate-limit-state` JSON endpoint (auth-required)
that returns the current bucket population so the operator can
diagnose throttle events. The middleware:

1. Maintains a `Map<ip, { tokens, lastRefilled }>` per-IP at module
   scope. Per LESSONS 2026-06-05 "break ingest<->server cache-
   invalidation cycles via a globalThis slot" - the bucket map lives
   on `globalThis.__fleet_rate_limit_buckets__` so the test seam can
   inspect AND reset it cleanly, AND so a future hot-reload doesn't
   reset the buckets on every module re-import.
2. Token bucket parameters: 60 tokens per minute per IP (the
   default), refilled at 1 token / second. Each request consumes 1
   token. When the bucket is empty, the response is HTTP 429 Too
   Many Requests with a `Retry-After: <seconds>` header AND a
   trivially-small response body (a one-line SVG comment for SVG
   routes, a 5-line static HTML page for HTML routes - NOT a JSON
   payload, because the routes that return SVG / HTML need
   429-shaped responses that match their content-type).
3. The LOOPBACK IPs (`127.0.0.1`, `::1`, `::ffff:127.0.0.1` - the
   same set the existing auth surface in `src/server.ts` treats as
   trusted) are EXEMPT from rate-limiting. The operator's own
   portal never throttles.
4. The bucket-size and refill-rate are configurable via OPTIONAL
   new config fields `embedRateLimit: { tokensPerMinute, burst }`
   in `fleet-control.config.json` (default values applied when the
   field is omitted).

The middleware applies to `/embed/*`, `/og/*`, `/share/*` because
all three are PUBLIC unauthenticated surfaces; the existing
`/api/*` routes already require auth on non-loopback, and the
home SPA at `/` is loopback-friendly so unlikely to be hammered.

PRODUCER-VS-SPEC NOTE: per LESSONS 2026-06-05 "groomer prose can
disagree with the schema; the schema wins" the implementing dev
MUST grep `src/server.ts` for the existing IP-derivation logic
(the auth gate already determines whether the request is loopback;
the rate-limit middleware MUST reuse that same derivation, NOT a
new IP-parsing helper) BEFORE writing the middleware. The
loopback-exempt IPs MUST match the existing auth surface's set.
Per LESSONS 2026-06-10 "PRODUCER-VS-SPEC for column-value casing"
- this ticket does NOT compare `pr.state` literals; no schema
casing risk.

### Stakeholder

Widens the moat on the OPERATIONAL-RESILIENCE axis where no
existing surface invests. Every public surface 0041 / 0050 / 0051
/ 0054 / 0055 / 0057 / 0058 / 0060 / 0061 (groomed) / 0063
(groomed) has shipped with the implicit assumption that LAN
exposure is the only access vector AND a misbehaving caller is
unlikely. As the public surface area grows (each new public route
is another vector), the assumption becomes thinner. A rate-limit
is the single piece of infra that retroactively hardens EVERY
public route - both shipped and unshipped.

Per LESSONS 2026-06-13 "function-import cycles aren't always
cache-invalidation; sometimes the cheapest fix is a 6-line inline
copy of the helper" - the rate-limit middleware is a tiny pure
function plus a globalThis-scoped mutable map; it doesn't need
to reach into views.ts / lessons.ts / control.ts for anything.
The dependency graph stays clean.

Per the cross-fleet courtiq lesson "infra-shaped tickets that
retroactively protect every public surface compound the moat
faster than feature-shaped tickets that ship one new surface"
(CROSS_LESSONS section courtiq Entries 2026-05-21 family on
infra-vs-feature trade-offs), the rate-limit ticket is exactly
that shape. Once landed, every future public surface inherits
the protection by virtue of the path prefix.

The screenshot worth sharing is operational (not viral): a
GitHub issue closing comment "yes, fleet-control rate-limits
the embed routes - here's the bucket state at the moment your
crawler hit the 429" - the SHOWING of a real defence converts a
sceptical adopter who has been burned by tools that ship public
surfaces without throttling.

Pairs with 0060 (the route family this protects), 0061 / 0063
(siblings that inherit the protection), 0013 (share token
surface - sibling rate-limit target), 0003 (scoped tokens with
audit log - the authenticated-surface analog).

### User (operator on the portal AND third-party hammering reader)

Two distinct users:

1. The operator (zero impact on the happy path): visits the portal
   on the laptop loopback. The middleware sees `127.0.0.1` and
   exempts the request. The operator's portal experience is
   IDENTICAL to before the ticket - same latency, same response
   shape. The operator can OPTIONALLY tune `embedRateLimit` in
   config but the defaults are sensible enough that 99% of
   operators never touch the knob.

2. The third-party reader (legitimate single-page-load): visits the
   operator's blog with the pulse widget embedded. The browser
   fetches `/embed/pulse.html` ONCE. The middleware consumes 1
   token from a fresh 60-token bucket. The reader sees the embed
   normally. The 60-per-minute default is generous enough that a
   reader who refreshes the blog 10 times in 5 minutes still gets
   served.

3. The third-party crawler (misbehaving): a misconfigured RSS
   reader fetches `/embed/pulse.html` 200 times per minute. The
   first 60 requests succeed; requests 61-200 return HTTP 429 with
   a `Retry-After: <seconds>` header. The crawler that respects
   `Retry-After` slows down; the crawler that doesn't is unblocked
   by neighbouring legitimate readers (the per-IP bucket isolates
   the misbehaving IP from everyone else).

The operator diagnoses any 429s via the new
`/api/admin/rate-limit-state` endpoint (auth required, returns
JSON with `{ buckets: [{ip, tokens, lastRefilled, totalRequests,
total429s}, ...], config: { tokensPerMinute, burst } }`). Per
LESSONS 2026-06-10 "redactSecrets on a JSON body shreds your
KEYS" - the JSON values are VALUE-side redacted (IP strings can
contain tokens if a misconfigured caller sends a token in the
path); per LESSONS section "in-process dedup sets need an
explicit reset hook for tests" - the rate-limit state exposes a
`_resetRateLimitBucketsForTests()` AND a
`_getRateLimitBucketsForTests()` seam.

Per LESSONS 2026-06-11 "startServer() tests that mutate `fleet-
control.config.json` race against parallel test files; expose a
renderer-direct seam for branch tests" - the rate-limit
parameters (tokensPerMinute, burst) are exercised via a renderer-
direct `_checkRateLimitForTests(ip, opts)` seam, NOT via cwd
config mutation.

### Growth

The "show me" moment is the OPERATIONAL TRUST moment: a sceptical
operator considering installing fleet-control on a public-IP host
sees the rate-limit documentation, sees the `/api/admin/rate-
limit-state` endpoint, sees the per-IP bucket inspection, and
INSTALLS the tool because the public-surface posture is
defensible. Per the cross-fleet courtiq lesson "the prospect's
first concern about adopting a public-surface tool is 'will this
get me ddos'd', and the right answer is to publish the throttle
documentation BEFORE the prospect asks" (CROSS_LESSONS section
courtiq Entries 2026-05-21 family on operational-trust signals),
the rate-limit ticket is exactly that publication.

A subtle but important moat property: the rate-limit middleware
is ENTIRELY LOCAL - no third-party rate-limit service, no
Cloudflare-shaped CDN proxy, no API keys to manage. The
zero-dep posture extends to operational infra: an operator who
trusts the source can audit the 100-line middleware in 5
minutes.

Pairs with 0046 (onboard wizard - the README addendum
documents the rate-limit as a default-on protection), 0016
(fleetctl doctor - the doctor check verifies the middleware
is wired by hitting `/embed/pulse.html` from a known IP and
asserting the response is non-429), 0009 (ntfy push - a future
follow-up could fire a ntfy alert when a single IP exhausts
the bucket more than N times per hour).

## Acceptance criteria

Each box maps 1:1 to a test scenario. PRODUCER-VS-SPEC NOTE: per
LESSONS 2026-06-05 "groomer prose can disagree with the schema"
the implementing dev MUST grep `src/server.ts` for the existing
loopback-IP detection logic (the auth surface's `isLoopback(req)`
or equivalent) BEFORE writing the middleware - the loopback set
must match the existing auth surface's set, NOT a freshly-
authored helper. Per LESSONS 2026-06-13 "function-import cycles" -
the middleware module is pure (no SQL, no views.ts imports), so
no cycle risk.

- [ ] `src/rate_limit.ts` (new module) exports
      `checkRateLimit(ip, now)` returning `{ allowed: boolean,
      retryAfterSec?: number, bucket: { tokens: number,
      lastRefilled: string } }`. The bucket map lives on
      `globalThis.__fleet_rate_limit_buckets__` per LESSONS
      2026-06-05 "break ingest<->server cache-invalidation
      cycles via a globalThis slot" (here the rationale is the
      test-seam stability across module re-imports). Per
      LESSONS section "in-process dedup sets need an explicit
      reset hook for tests" - exports
      `_resetRateLimitBucketsForTests()` AND
      `_getRateLimitBucketsForTests()`. Test: 60 calls with the
      same IP within 1 second; assert the 61st returns
      `allowed: false` with a positive `retryAfterSec`; assert
      after a 60-second simulated wait (driven via a `now`
      param, NEVER `new Date()` per LESSONS 2026-05-29) the
      bucket refills and the 62nd call returns
      `allowed: true`.

- [ ] Loopback exemption: a call with `ip='127.0.0.1'` is
      ALWAYS allowed (the function returns
      `allowed: true, bucket.tokens: Infinity` or equivalent
      sentinel) regardless of prior bucket state. Same for
      `'::1'` and `'::ffff:127.0.0.1'`. The exemption set
      MUST match the existing `src/server.ts` loopback-auth
      surface (PRODUCER-VS-SPEC: grep `src/server.ts` for the
      existing helper). Test: 1000 rapid calls with each
      loopback IP; assert all 1000 return `allowed: true`;
      assert the bucket map does NOT grow an entry for any
      loopback IP (the loopback path bypasses bucket
      bookkeeping entirely).

- [ ] Middleware wiring: `src/server.ts` invokes
      `checkRateLimit()` at the top of the request handler
      ONLY when the path starts with `/embed/`, `/og/`, or
      `/share/`. The middleware runs BEFORE the auth gate
      (because the `/embed/*` and `/og/*` routes are public)
      AND BEFORE the route dispatcher (so a 429 short-
      circuits before any helper runs). For non-matching
      paths the middleware does NOT execute (zero overhead
      on `/api/fleet`, `/`, etc.). Test: hit `/embed/pulse.
      html` 61 times from a simulated remote IP; assert the
      61st returns HTTP 429 with `Retry-After`; hit `/api/
      fleet` 100 times in parallel from the same simulated
      IP; assert NONE return 429 (the rate-limit doesn't
      apply to `/api/*`).

- [ ] 429 response shape: for an SVG route, the 429 response
      Content-Type is `image/svg+xml` AND the body is a
      minimal `<svg>...<text>rate limited</text></svg>` shape
      (so a browser-rendered `<img>` tag doesn't show a
      broken-image icon - it shows the throttle message
      inline). For an HTML route, the 429 response Content-
      Type is `text/html; charset=utf-8` AND the body is a
      5-line static HTML page rendering "rate limited - try
      again in <N>s". Both 429s set `Retry-After:
      <seconds>`. Per LESSONS 2026-06-12 "greedy `[^>]+id=`
      regex" - the 429 HTML carries `data-testid="rate-
      limit-429"` and tests anchor on that, NOT a body
      substring match. Test: trigger a 429 on each of
      `/embed/pulse.html`, `/embed/pulse.svg`, `/og/pulse.
      svg`; assert each returns the correct content-type
      AND the testid (for HTML) or the `<text>` element
      (for SVG).

- [ ] Configurable bucket parameters: a NEW optional config
      field `embedRateLimit: { tokensPerMinute?: number,
      burst?: number }` in `fleet-control.config.json`. When
      omitted, defaults are `tokensPerMinute: 60, burst:
      60`. PRODUCER-VS-SPEC NOTE: grep `src/config.ts` for
      the existing `embedOrigins` field shape (added by
      0060) and place the new field with the same defaulting
      pattern. Per LESSONS 2026-06-11 "startServer() tests
      that mutate `fleet-control.config.json` race against
      parallel test files; expose a renderer-direct seam" -
      the parameter branches are exercised via the
      `_checkRateLimitForTests(ip, now, opts)` seam (where
      opts carries the config override), NOT via cwd config
      mutation. Test: drive the renderer-direct seam with
      two config values (defaults; `{ tokensPerMinute: 6 }`);
      assert the defaults case allows 60 calls before 429
      AND the override case allows only 6 before 429.

- [ ] Admin diagnostic endpoint: `GET /api/admin/rate-limit-
      state` (AUTH REQUIRED - loopback OR `x-fleet-token`)
      returns JSON `{ buckets: [{ ip, tokens, lastRefilled,
      totalRequests, total429s }, ...], config: {
      tokensPerMinute, burst, exemptIps: [...] }, version:
      1 }`. The bucket list is sorted by `total429s desc,
      totalRequests desc` (so a misbehaving IP appears at
      the top). Per LESSONS 2026-06-10 "redactSecrets on a
      JSON body shreds your KEYS" - VALUE-side redaction is
      applied to each `ip` string (some misconfigured
      callers send tokens in the path that end up parsed as
      IPs; the redactor scrubs token-shape substrings from
      the value before serialisation, NOT body-string
      redaction over the JSON). Test: hit the endpoint
      without auth from a simulated remote IP - assert 401
      / 403; hit with auth - assert 200 + the documented
      JSON shape + a sorted bucket list when prior calls
      have populated it.

- [ ] Bucket cleanup: stale buckets (no requests in the
      trailing 24h) are pruned on each rate-limit check via
      a lightweight sweep (NOT a separate timer - timers
      add complexity; the inline sweep on each check is
      O(n) but n is small for any realistic public-surface
      scale). Test: populate 100 bucket entries with
      `lastRefilled` 25h in the past; trigger a single
      check from a fresh IP; assert the bucket map size
      drops to 1 (the new IP) after the sweep.

- [ ] Time-pinned tests: the rate-limit logic takes `now`
      as an explicit parameter; tests drive the parameter
      with anchor-derived timestamps per LESSONS 2026-05-
      29 "time-pinned tests must NOT derive seed timestamps
      from `new Date()`". The bucket refill math
      (`tokens += (now - lastRefilled) * refillRate`) MUST
      use the explicit `now` argument, NEVER `Date.now()`
      inside the helper - the helper is pure on
      `(ip, now, opts)` so the test can simulate hour-long
      idle periods without `setTimeout`. Test: simulate a
      bucket exhausted at `t0`, advance `now` by 30 seconds
      (anchor-derived), assert the bucket refills 30 tokens
      (1 per second).

- [ ] Documentation in the doctor surface: the existing
      `fleetctl doctor` (per 0016) grows ONE new check
      "rate-limit middleware wired" that hits
      `/embed/pulse.html` 5 times from the loopback context
      (so the responses bypass the rate-limit AND confirm
      the route exists). Per LESSONS 2026-05-26 "shell-out
      modules need an injectable runner for tests" - the
      doctor check uses the existing injected
      `deps.httpGet` (or equivalent) seam; the test
      injects a fake response. Per LESSONS 2026-05-26 "no
      shell-string exec static checks should grep the
      import, not the call site" - the test asserts the
      new doctor check honours the existing no-shell-
      string posture. Test: drive `fleetctl doctor` with a
      stub HTTP runner; assert the new check appears in
      both the human and JSON outputs; assert the check
      passes when `/embed/pulse.html` returns 200.

- [ ] No new runtime deps. `tsc --noEmit` clean. No shell-
      string composition (the middleware is pure code; no
      `child_process` exec). The new `/api/admin/rate-
      limit-state` endpoint is NET-NEW (no JSON-shape
      break to any existing route). The `embedRateLimit`
      config field is optional (defaults applied when
      omitted; existing configs work unchanged). No
      schema migration - the bucket state is in-memory on
      globalThis, NOT in SQLite (per the zero-dep posture;
      SQLite-backed rate-limiting would survive a restart
      but adds write contention to the same DB the ingest
      writes to). Per LESSONS section "no backticks
      inside template-literal SQL/HTML strings" -
      identifiers stay plain words. Per LESSONS 2026-06-
      11 "character-window source greps leak into sibling
      helpers" - the new module's comment block uses
      PLAIN PROSE (no backticks) for any identifier that
      a 0052-family slice-and-grep test in a sibling
      module might capture.

## Out of scope

- A DISTRIBUTED rate-limiter across multiple fleet-control
  instances. v1 is per-instance, in-memory. If an operator
  runs two instances behind a single LAN-host (rare), each
  enforces its own bucket. Distributed is a follow-up only
  if multi-instance becomes a real use case.
- A PER-ROUTE rate-limit (different limits for /embed/pulse
  vs /og/pulse). v1 applies one bucket per IP across all
  protected paths; per-route bucketing is duplicative until
  abuse patterns prove otherwise.
- A SQLite-persisted bucket state. The in-memory bucket
  resets on server restart, which is the right trade-off
  for a single-operator local-only tool - a restart is rare
  AND a fresh bucket on restart is operator-friendly (a
  reader who was being throttled gets a fresh chance).
- A challenge-shaped throttle (CAPTCHA, proof-of-work).
  These add user-facing friction AND new runtime deps;
  v1 is a simple 429-with-Retry-After.
- An admin endpoint to MANUALLY reset a bucket. The
  operator can restart the server (cheap) or wait out the
  refill (60 seconds). A manual reset is a future follow-
  up if operator feedback demands.
- A POST-shaped allowlist (operator marks specific IPs as
  exempt). Loopback exemption is enough for v1; per-IP
  allowlisting is duplicative of the existing
  `embedOrigins` cross-origin-frame-ancestors config.
- An ntfy alert when a bucket exhausts. Future follow-up
  per the cross-reference to 0009.
- A retroactive log of all 429 events. The
  `/api/admin/rate-limit-state` endpoint surfaces CURRENT
  state plus `total429s` per IP; a full audit log is
  duplicative of the existing `control_audit` table for
  authenticated actions (which 429s are NOT).

## Engineering notes

- `src/rate_limit.ts` (new module) - the token-bucket
  middleware. PURE on `(ip, now, opts)`. Maintains the
  bucket map on `globalThis.__fleet_rate_limit_buckets__`
  per LESSONS 2026-06-05 (here the rationale is test-
  seam stability across module re-imports, NOT cache-
  invalidation cycle avoidance). Exports
  `checkRateLimit(ip, now)`,
  `_checkRateLimitForTests(ip, now, opts)`,
  `_resetRateLimitBucketsForTests()`,
  `_getRateLimitBucketsForTests()`. The module has NO
  imports from `src/views.ts` or `src/lessons.ts` (zero
  cycle risk).
- `src/server.ts` - wire the middleware into the request
  handler at the TOP of the dispatcher, before the auth
  gate. The middleware ONLY runs for paths starting with
  `/embed/`, `/og/`, or `/share/`. For other paths the
  request flows unchanged. PRODUCER-VS-SPEC NOTE: grep
  `src/server.ts` for the existing IP-derivation logic
  (the auth surface already determines whether a request
  is loopback); the middleware MUST reuse that derivation
  and the same loopback IP set. NEW endpoint
  `GET /api/admin/rate-limit-state` (auth-required)
  exposes the bucket map for diagnostics. The endpoint
  JSON's values pass through the value-side redaction
  per LESSONS 2026-06-10 (sanitise the `ip` strings
  BEFORE `JSON.stringify`, NOT body-string redaction
  over the JSON).
- `src/config.ts` - new optional `embedRateLimit: {
  tokensPerMinute?: number, burst?: number }` field.
  Defaulting pattern matches the existing `embedOrigins`
  field (per 0060). Empty object when omitted; both
  sub-fields default when only one is provided.
- `src/doctor.ts` - one new check "rate-limit middleware
  wired" that hits `/embed/pulse.html` 5 times via the
  existing `deps.httpGet` (or equivalent injected
  helper) and asserts the response is non-429 in the
  loopback context. Per LESSONS 2026-05-26 "shell-out
  modules need an injectable runner for tests" - the
  check uses the existing injected runner.
- `tests/rate-limit.test.ts` (new) - one `test(...)`
  per AC checkbox. Per LESSONS 2026-05-29, every test
  drives `now` as an anchor-derived parameter. Per
  LESSONS 2026-06-11 "startServer() tests that mutate
  `fleet-control.config.json` race against parallel
  test files; expose a renderer-direct seam for branch
  tests" - parameter branches drive the renderer-
  direct seam, NOT cwd config mutation. The boot-path
  test (middleware wired into server.ts) stays
  valuable for the integration shape but the
  bucket-math branches drive the
  `_checkRateLimitForTests` seam directly.
- `tests/doctor.test.ts` (existing) - extend with the
  one new check assertion per AC checkbox 9.
- `web/app.js` - NO new SPA surface (the admin endpoint
  is JSON-only; operator inspects via curl or browser
  devtools). A future v2 ticket could add a portal
  diagnostic page if operator feedback demands.
- `README.md` (existing) - one new subsection under
  "LAN access + auth" titled "Rate limiting" documents
  the bucket defaults, the config knob, and the admin
  endpoint. This is the operational-trust documentation
  the prospect reads.
- Schema migration: NO. The bucket state is in-memory.
- No new runtime deps. Lean on `node:http`, the standard
  library. Pairs with 0060 (the route family this
  protects), 0061 / 0063 (siblings that inherit the
  protection by virtue of the path prefix), 0013 (share
  path - sibling rate-limit target), 0016 (doctor - the
  diagnostic surface that surfaces the middleware to the
  operator), 0046 (onboard wizard - the README addendum
  the prospect reads).

## Implementation log

(Appended by the implementation-dev agent during execution.)
