// Per-IP token-bucket rate limiter for the public embed surfaces
// (ticket 0064).
//
// Scope: the /embed/*, /og/*, /share/* path prefixes share one bucket
// per source IP. Loopback callers (the operator's own portal on
// 127.0.0.1 / ::1 / ::ffff:127.0.0.1) are exempt - the same set the
// existing src/server.ts isLoopback(req) helper treats as trusted.
//
// Posture: this module is PURE on (ip, now, opts). The bucket map
// lives on globalThis under a documented slot per LESSONS 2026-06-05
// "break ingest<->server cache-invalidation cycles via a globalThis
// slot, not a circular import" - here the rationale is test-seam
// stability across module re-imports (a hot-reload during dev must
// NOT reset every operator's bucket). The reset / inspect seams
// follow the LESSONS section "in-process dedup sets need an explicit
// reset hook for tests" convention (leading underscore + ForTests
// suffix). The `now` argument is always explicit per LESSONS
// 2026-05-29 "time-pinned tests must NOT derive seed timestamps from
// new Date()" - the helper never reaches for Date.now() inside the
// refill math.
//
// Zero runtime deps, no SQL, no shell-out. The 429 response shapes
// (HTML + SVG) are emitted by the same module so the content-type
// branching stays in one chokepoint.

/** Configurable bucket parameters. tokensPerMinute is the steady-state
 *  refill rate; burst is the maximum ceiling at any one moment. Both
 *  default to 60 per the ticket spec. */
export interface RateLimitOpts {
  tokensPerMinute: number;
  burst: number;
}

export const DEFAULT_RATE_LIMIT_OPTS: RateLimitOpts = {
  tokensPerMinute: 60,
  burst: 60,
};

/** Loopback IP set - matches the existing src/server.ts isLoopback(req)
 *  helper byte-for-byte per the ticket's PRODUCER-VS-SPEC reconciliation
 *  note. The middleware exposes this set so a caller with only an IP
 *  string in hand (not a full req object) can exempt without re-walking
 *  the auth gate. */
export const LOOPBACK_IPS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

/** Per-IP bucket state. lastRefilled is a unix millisecond timestamp so
 *  the refill math is integer arithmetic. totalRequests counts every
 *  call this bucket has seen (allowed or 429ed); total429s counts only
 *  the rejected calls. Both surface in the admin diagnostic endpoint. */
export interface RateLimitBucket {
  tokens: number;
  lastRefilled: number;
  totalRequests: number;
  total429s: number;
}

/** Public shape returned to a caller. The bucket sub-object is a snapshot
 *  for diagnostics; production callers ignore it. retryAfterSec is
 *  populated only when allowed:false. */
export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec?: number;
  bucket: {
    tokens: number;
    lastRefilled: string;
  };
}

// ────────────────────────────────────────────────────────────────────
// globalThis bucket slot
//
// Lives on globalThis.__fleet_rate_limit_buckets__ so hot-reloading the
// module during dev doesn't drop the operator's bucket state (a fresh
// module load would otherwise look like an instant amnesty for every
// in-flight 429). The convention (double-underscore prefix + suffix)
// matches the other __fleet_*_invalidate__ slots that already live on
// globalThis per LESSONS 2026-06-05.
// ────────────────────────────────────────────────────────────────────

const BUCKETS_KEY = "__fleet_rate_limit_buckets__";

interface GlobalWithBuckets {
  __fleet_rate_limit_buckets__?: Map<string, RateLimitBucket>;
}

function bucketMap(): Map<string, RateLimitBucket> {
  const g = globalThis as GlobalWithBuckets;
  if (!g[BUCKETS_KEY]) g[BUCKETS_KEY] = new Map<string, RateLimitBucket>();
  return g[BUCKETS_KEY]!;
}

/** Idle-bucket cleanup window (24h). Any bucket whose lastRefilled is
 *  older than this is pruned on the next check. Inline sweep on every
 *  call - no timers - per the ticket's "lightweight sweep, no separate
 *  timer" requirement. */
const STALE_BUCKET_AGE_MS = 24 * 60 * 60 * 1000;

function sweepStale(now: Date): void {
  const map = bucketMap();
  const cutoff = now.getTime() - STALE_BUCKET_AGE_MS;
  for (const [ip, b] of map) {
    if (b.lastRefilled < cutoff) map.delete(ip);
  }
}

// ────────────────────────────────────────────────────────────────────
// checkRateLimit - the chokepoint
// ────────────────────────────────────────────────────────────────────

function bucketSnapshot(b: RateLimitBucket): RateLimitResult["bucket"] {
  return {
    tokens: b.tokens,
    lastRefilled: new Date(b.lastRefilled).toISOString(),
  };
}

/** Production entry point. Production code calls this with the default
 *  options - the renderer-direct seam exposes the opts knob for the
 *  configurable-bucket-parameter branch tests. */
export function checkRateLimit(ip: string, now: Date): RateLimitResult {
  return _checkRateLimitForTests(ip, now, DEFAULT_RATE_LIMIT_OPTS);
}

/** Renderer-direct test seam per LESSONS 2026-06-11. Production also
 *  routes through this with DEFAULT_RATE_LIMIT_OPTS. The function is
 *  pure on (ip, now, opts) so tests can drive every branch without
 *  setTimeout or fleet-control.config.json mutation. */
export function _checkRateLimitForTests(
  ip: string,
  now: Date,
  opts: RateLimitOpts = DEFAULT_RATE_LIMIT_OPTS,
): RateLimitResult {
  // Loopback exemption: ALWAYS allowed, NEVER recorded in the bucket
  // map. The Infinity sentinel signals "not throttled" to any caller
  // that introspects the snapshot.
  if (LOOPBACK_IPS.has(ip)) {
    return {
      allowed: true,
      bucket: { tokens: Infinity, lastRefilled: now.toISOString() },
    };
  }

  // Sweep stale buckets BEFORE the bucket-map read so a long-idle IP
  // doesn't carry forward exhausted state across the 24h boundary.
  sweepStale(now);

  const map = bucketMap();
  const tokensPerMinute = opts.tokensPerMinute;
  const burst = opts.burst;
  const refillPerMs = tokensPerMinute / 60_000;

  let b = map.get(ip);
  if (!b) {
    b = {
      tokens: burst,
      lastRefilled: now.getTime(),
      totalRequests: 0,
      total429s: 0,
    };
    map.set(ip, b);
  } else {
    // Refill: tokens += elapsed_ms * (tokensPerMinute / 60_000),
    // clamped to burst. Per LESSONS 2026-05-29 the elapsed time is
    // computed from the explicit `now` arg, NEVER Date.now().
    const elapsedMs = Math.max(0, now.getTime() - b.lastRefilled);
    const refill = elapsedMs * refillPerMs;
    b.tokens = Math.min(burst, b.tokens + refill);
    b.lastRefilled = now.getTime();
  }

  b.totalRequests += 1;

  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { allowed: true, bucket: bucketSnapshot(b) };
  }

  // Bucket empty - 429. retryAfterSec is the seconds until ONE token
  // is available (ceil so a sub-second deficit still tells the caller
  // to wait at least 1s).
  b.total429s += 1;
  const needed = 1 - b.tokens; // 0 < needed <= 1
  const retryAfterSec = Math.max(1, Math.ceil(needed / (refillPerMs * 1000)));
  return {
    allowed: false,
    retryAfterSec,
    bucket: bucketSnapshot(b),
  };
}

/** Test seam: clear the globalThis bucket map. Per LESSONS section
 *  "in-process dedup sets need an explicit reset hook for tests" -
 *  every test that exercises this module MUST call this at the top so
 *  sibling tests can't poison the shared state. */
export function _resetRateLimitBucketsForTests(): void {
  bucketMap().clear();
}

/** Test seam: read-only handle on the bucket map so a test can assert
 *  size / contents without re-implementing the lookup. The leading
 *  underscore + ForTests suffix matches the convention. */
export function _getRateLimitBucketsForTests(): Map<string, RateLimitBucket> {
  return bucketMap();
}

// ────────────────────────────────────────────────────────────────────
// 429 renderers (HTML + SVG)
//
// Both shapes carry a Retry-After header per RFC 7231. The HTML shape
// includes data-testid="rate-limit-429" so tests anchor on the testid
// not a body substring per LESSONS 2026-06-12 "greedy id= regex over a
// data-testid attribute captures the wrong attribute". The SVG shape
// is minimal so a browser-rendered img tag shows the throttle message
// inline (no broken-image icon).
// ────────────────────────────────────────────────────────────────────

export type RateLimitContentKind = "html" | "svg";

export interface RateLimit429Result {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function render429Html(retryAfterSec: number): RateLimit429Result {
  const body =
    "<!doctype html><html lang=en><head><meta charset=utf-8>"
    + "<title>rate limited</title>"
    + "<style>body{font-family:system-ui;color:#333;padding:24px}p{margin:0}</style>"
    + "</head><body>"
    + `<p data-testid="rate-limit-429">rate limited &mdash; try again in ${retryAfterSec}s</p>`
    + "</body></html>";
  return {
    status: 429,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "retry-after": String(retryAfterSec),
      "cache-control": "no-store",
    },
    body,
  };
}

function render429Svg(retryAfterSec: number): RateLimit429Result {
  // Hand-rolled minimal SVG. The text element renders "rate limited"
  // so an img-tag embedder sees the throttle message inline.
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>'
    + '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180" viewBox="0 0 300 180">'
    + '<rect width="300" height="180" fill="#fafafa"/>'
    + '<text x="150" y="92" text-anchor="middle" font-family="system-ui" '
    + 'font-size="14" fill="#666" data-testid="rate-limit-429">'
    + `rate limited - retry in ${retryAfterSec}s</text>`
    + "</svg>";
  return {
    status: 429,
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "retry-after": String(retryAfterSec),
      "cache-control": "no-store",
    },
    body,
  };
}

/** Production chokepoint for emitting a 429 in the correct content-type
 *  for the route family. Callers pass "html" for /embed/*.html and the
 *  /share/* page; "svg" for /embed/*.svg, /og/*.svg. */
export function render429(
  kind: RateLimitContentKind,
  retryAfterSec: number,
): RateLimit429Result {
  return kind === "svg" ? render429Svg(retryAfterSec) : render429Html(retryAfterSec);
}

/** Test seam: same shape as the production helper, named per the
 *  ForTests convention so it's grep-distinguishable. */
export function _render429ForTests(
  kind: RateLimitContentKind,
  retryAfterSec: number,
): RateLimit429Result {
  return render429(kind, retryAfterSec);
}

// ────────────────────────────────────────────────────────────────────
// Admin diagnostic JSON shape
//
// The bucket list is sorted by (total429s desc, totalRequests desc) so
// a misbehaving IP appears at the top. The IP value passes through the
// value-side redactor BEFORE serialisation per LESSONS 2026-06-10
// "redactSecrets on a JSON body shreds your KEYS, not just your values"
// - the redactor scrubs token-shape substrings from the VALUE, never
// from the JSON body string itself, so the documented top-level keys
// (buckets, config, version) survive.
// ────────────────────────────────────────────────────────────────────

export interface RateLimitStateRow {
  ip: string;
  tokens: number;
  lastRefilled: string;
  totalRequests: number;
  total429s: number;
}

export interface RateLimitStatePayload {
  buckets: RateLimitStateRow[];
  config: {
    tokensPerMinute: number;
    burst: number;
    exemptIps: string[];
  };
  version: 1;
}

/** Scrub token-shape substrings from a single VALUE string before it
 *  enters the JSON body. Same regex shape as the embed redactor in
 *  src/embed.ts; specialised here so the rate-limit module doesn't take
 *  an embed.ts import (which would couple two unrelated public-surface
 *  modules). */
function redactIpValue(s: string): string {
  let out = String(s ?? "");
  out = out.replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-pat>");
  out = out.replace(/\b[A-Za-z0-9_]{24,}\b/g, (match) => {
    const hasLetter = /[A-Za-z]/.test(match);
    const hasDigit = /\d/.test(match);
    return hasLetter && hasDigit ? "<redacted>" : match;
  });
  return out;
}

function buildPayload(
  rows: RateLimitStateRow[],
  opts: RateLimitOpts,
): RateLimitStatePayload {
  const sorted = rows.slice().sort((a, b) => {
    if (b.total429s !== a.total429s) return b.total429s - a.total429s;
    return b.totalRequests - a.totalRequests;
  });
  // Value-side redaction on the IP string only. The rest of the row
  // is repo-authored / numeric.
  const safe = sorted.map((r) => ({ ...r, ip: redactIpValue(r.ip) }));
  return {
    buckets: safe,
    config: {
      tokensPerMinute: opts.tokensPerMinute,
      burst: opts.burst,
      exemptIps: Array.from(LOOPBACK_IPS).sort(),
    },
    version: 1,
  };
}

/** Render the diagnostic payload as a JSON string. Used by the
 *  /api/admin/rate-limit-state route in src/server.ts. */
export function renderRateLimitState(opts: RateLimitOpts): string {
  const map = bucketMap();
  const rows: RateLimitStateRow[] = [];
  for (const [ip, b] of map) {
    rows.push({
      ip,
      tokens: Math.floor(b.tokens * 100) / 100,
      lastRefilled: new Date(b.lastRefilled).toISOString(),
      totalRequests: b.totalRequests,
      total429s: b.total429s,
    });
  }
  return JSON.stringify(buildPayload(rows, opts));
}

/** Test seam for the renderer's branches (sort order + value-side
 *  redaction). Takes the rows directly so a test can forge a row whose
 *  IP string looks like a token without going through the production
 *  bucket map. */
export function _renderRateLimitStateForTests(
  rows: RateLimitStateRow[],
  opts: RateLimitOpts = DEFAULT_RATE_LIMIT_OPTS,
): string {
  return JSON.stringify(buildPayload(rows, opts));
}

/** Resolve the effective options from a config-shaped object. Missing
 *  fields fall back to the documented defaults. The defaulting pattern
 *  matches the existing embedOrigins field in src/config.ts (added by
 *  ticket 0060): omitted = defaults applied; both sub-fields default
 *  when only one is provided. */
export function resolveRateLimitOpts(
  cfg: { embedRateLimit?: { tokensPerMinute?: number; burst?: number } },
): RateLimitOpts {
  const r = cfg.embedRateLimit ?? {};
  const tpm = typeof r.tokensPerMinute === "number" && r.tokensPerMinute > 0
    ? r.tokensPerMinute : DEFAULT_RATE_LIMIT_OPTS.tokensPerMinute;
  const burst = typeof r.burst === "number" && r.burst > 0
    ? r.burst : DEFAULT_RATE_LIMIT_OPTS.burst;
  return { tokensPerMinute: tpm, burst };
}

/** Returns true when the URL path falls under one of the public
 *  surfaces the rate-limit covers. Production callers gate on this so
 *  the middleware adds zero overhead to /api/*, /, the SPA assets, etc.
 *  The set is documented in the ticket's "Engineering notes" section
 *  and matches the existing public-route mounts in src/server.ts.
 *  Ticket 0065 adds /operator/ to inherit the same per-IP throttle
 *  as the rest of the public surface family.
 *  Ticket 0069 adds /lessons-public/ so the public lesson-lineage
 *  page (and the 0057 archive + permalink it siblings) inherit the
 *  same per-IP throttle as the other public surfaces. The 0057
 *  surface predates 0064 and did not opt in; the lineage ticket
 *  closes that gap (a single popular paste of a lineage URL on
 *  Hacker News must not starve the operator's own loopback portal).
 *  Ticket 0068 adds /referrals/ so the public operator-referral
 *  graph page inherits the same per-IP throttle as the rest of the
 *  /operator/ family.
 *  Ticket 0071 adds /digest-missed/ so the reactivation-push deep
 *  link (the new signed-token surface that resolves a stored
 *  reactivation_digest snapshot) inherits the same per-IP throttle.
 *  A drift-period digest URL is a public token-bearing surface
 *  shaped identically to /share/ from the rate-limit's point of
 *  view - the token IS the auth and the only legitimate caller is
 *  the operator who tapped their own ntfy notification. */
export function isRateLimitedPath(path: string): boolean {
  return path.startsWith("/embed/")
    || path.startsWith("/og/")
    || path.startsWith("/share/")
    || path.startsWith("/operator/")
    || path.startsWith("/referrals/")
    || path.startsWith("/lessons-public/")
    || path.startsWith("/digest-missed/")
    // Ticket 0073: the cold-discovery routes ride the same per-IP
    // bucket so a popular crawler paste cannot starve the operator's
    // own loopback portal. /sitemap.xml and /robots.txt are exact-
    // match paths (no trailing slash so they don't fan out to a wider
    // surface); /lessons-public/feed.xml is technically already
    // covered by the /lessons-public/ prefix above but the explicit
    // prefix keeps the matcher honest under refactor.
    || path === "/sitemap.xml"
    || path === "/robots.txt"
    || path === "/lessons-public/feed.xml";
}
