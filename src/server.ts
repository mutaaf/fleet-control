// Zero-dependency local server (node:http): JSON read API + static portal.
// Binds 127.0.0.1 by default; set host 0.0.0.0 in fleet-control.config.json for
// LAN access (phone/tablet) — Phase 4 adds the admin token before control routes.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type FleetConfig } from "./config.ts";
import { openDb, type DB } from "./db.ts";
import { runIngestPass } from "./ingest/index.ts";
import { recentEvents } from "./ingest/events.ts";
import { fleetView, projectView, runView, forecastFor, fleetLeaderboard, clampDays, fleetStreak, projectHealth, projectIdBySlug, projectBurndown, ticketShipReport, projectToolMix, clampToolMixDays, yesterdayGlance, costPerMergedPr, fridayWrap, isFriday, riskiestOpenPr, mondayCatchUp, isMonday, fleetChangelog, newSinceLastVisit, markSectionSeen, isValidNewSinceSection, type YesterdayGlance, type CostPerMergedPr, type FridayWrap, type RiskiestOpenPr, type MondayCatchUp, type FleetChangelog, type FleetChangelogOptions, type NewSinceLastVisitOptions } from "./views.ts";
import { quietHoursActiveAnywhere } from "./quiet_hours.ts";
import { recentAnomalies } from "./anomaly.ts";
import { fleetInbox, dismissInboxItem, type DismissRequest } from "./inbox.ts";
import { activeCorrelations } from "./correlate.ts";
import { projectDriftReport } from "./drift.ts";
import { doAction } from "./control.ts";
import { diskUsage } from "./infra.ts";
import { evalAlerts } from "./alerts.ts";
import { installDaemon, uninstallDaemon, daemonStatus } from "./daemon.ts";
import { tailTranscript, type TailEvent } from "./live.ts";
import { pricingRows, lastSyncedAt, syncPricing } from "./pricing.ts";
import { fetchPrDiff } from "./diff.ts";
import { weeklyDigest } from "./digest.ts";
import {
  loadCrossLessons, defaultLessonsPath, newThisWeekCount,
  type CrossLessonsLoadResult,
} from "./lessons.ts";
import { statSync } from "node:fs";
import { serveShare } from "./snapshot.ts";
import {
  serveReceipts, computeReceipts, persistReceipts, unpublishReceipts,
  isValidMonthIso, type ReceiptsPayload, type ServeReceiptsResult,
} from "./receipts.ts";
import { renderBadge, projectBadge, parseMetric } from "./badge.ts";
import {
  authenticate, scopeAllows, migrateLegacyAdminTokenIfPresent,
  type Scope, type TokenRecord,
} from "./auth.ts";
import { consumePairToken, rateLimitAllow, sweepExpiredPairTokens } from "./pair.ts";

const CONFIG_FILE = join(process.cwd(), "fleet-control.config.json");

function isLoopback(req: any): boolean {
  const ip = req.socket?.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/** Result of a scoped-auth check. `principal` is null for loopback (the local
 *  CLI / portal — trusted, no token). For remote callers it's the matched
 *  auth_token row, whose `name` we record on every control_audit row. */
export interface AuthOutcome {
  ok: boolean;
  status: number; // HTTP status on failure
  message: string; // human-friendly message on failure
  principal: TokenRecord | null;
}

/** Single auth chokepoint for the JSON API + SSE. Loopback bypasses tokens
 *  entirely (the local CLI/portal is trusted). Remote callers must send the
 *  `x-fleet-token` header (or `?token=` for SSE since browser EventSource
 *  can't set custom headers) AND that token's scope must dominate `required`.
 *  Updates last_used_at on success as a side effect of authenticate(). */
export function requireAuth(db: DB, req: any, required: Scope, url?: URL): AuthOutcome {
  if (isLoopback(req)) return { ok: true, status: 200, message: "", principal: null };
  const raw = String(req.headers["x-fleet-token"] ?? (url ? url.searchParams.get("token") ?? "" : ""));
  if (!raw) return { ok: false, status: 401, message: "not authorized — pair this device first", principal: null };
  const p = authenticate(db, raw);
  if (!p) return { ok: false, status: 401, message: "unknown or revoked token", principal: null };
  if (!scopeAllows(p.scope, required)) {
    return { ok: false, status: 403, message: `this token has scope '${p.scope}', need '${required}'`, principal: p };
  }
  return { ok: true, status: 200, message: "", principal: p };
}

function actorOf(req: any, principal: TokenRecord | null): { actor: string; actor_name: string } {
  if (principal) return { actor: "lan", actor_name: principal.name };
  return { actor: isLoopback(req) ? "local" : "lan", actor_name: isLoopback(req) ? "local" : "anonymous" };
}
function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let s = ""; req.on("data", (c: any) => (s += c)); req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });
}

const WEB = join(fileURLToPath(import.meta.url), "..", "..", "web");
// Ticket 0029: PWA shell — add MIME types for the manifest (a JSON variant
// that browsers recognise via `application/manifest+json`) and PNG icons.
// The `application/javascript` mapping covers the service worker — Chrome
// accepts `text/javascript` too, but Safari's stricter SW loader prefers
// `application/javascript`, so we use the explicit form.
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

// Ticket 0033: "Yesterday at a glance" memo cache.
//
// 60s TTL keyed by `now` rounded to the minute (UTC). One module-level
// Map; expired rows fall out lazily on the next lookup. Per LESSONS §
// "in-process dedup sets need an explicit reset hook for tests": we
// expose `_resetGlanceCacheForTests()`. Per LESSONS § "expose a build
// counter for cache-hit tests, not a fetcher swap": we also expose a
// read-only `_getGlanceCacheBuildsForTests()` that ticks on every cache
// MISS so route tests can assert hit/miss semantics without stubbing
// SQL. Production code never reads either.
interface GlanceCacheEntry { value: YesterdayGlance; expires_at: number; }
const GLANCE_TTL_MS = 60_000;
const glanceCache = new Map<string, GlanceCacheEntry>();
let glanceBuildCounter = 0;

export function _resetGlanceCacheForTests(): void {
  glanceCache.clear();
  glanceBuildCounter = 0;
}

export function _getGlanceCacheBuildsForTests(): number {
  return glanceBuildCounter;
}

function minuteKey(now: Date): string {
  // Floor `now` to the minute in UTC: yyyy-mm-ddTHH:MM:00.000Z.
  return now.toISOString().slice(0, 16);
}

/** Look up a fresh glance from the memo cache; rebuild on miss. The
 *  cache key is `now` rounded to the minute so polled phones inside the
 *  60s SW cache window (ticket 0029) share one build. */
function getGlanceCached(db: DB, cfg: FleetConfig, now: Date): YesterdayGlance {
  const key = minuteKey(now);
  const hit = glanceCache.get(key);
  if (hit && hit.expires_at > Date.now()) return hit.value;
  glanceBuildCounter += 1;
  const value = yesterdayGlance(db, now, cfg);
  glanceCache.set(key, { value, expires_at: Date.now() + GLANCE_TTL_MS });
  return value;
}

// Ticket 0035: "Cost per merged PR" memo cache.
//
// 5-minute TTL keyed by `(days, now-rounded-to-5-min)` per the AC. One
// module-level Map; expired rows fall out lazily on the next lookup. Per
// LESSONS § "in-process dedup sets need an explicit reset hook for
// tests": we expose `_resetCostPerPrCacheForTests()`. Per LESSONS §
// "expose a build counter for cache-hit tests, not a fetcher swap": we
// also expose a read-only `_getCostPerPrCacheBuildsForTests()` that
// ticks on every cache MISS so route tests can assert hit/miss
// semantics without stubbing SQL. Production code never reads either.
interface CostPerPrCacheEntry { value: CostPerMergedPr; expires_at: number; }
const COST_PER_PR_TTL_MS = 300_000; // 5 minutes per the AC
const costPerPrCache = new Map<string, CostPerPrCacheEntry>();
let costPerPrBuildCounter = 0;

export function _resetCostPerPrCacheForTests(): void {
  costPerPrCache.clear();
  costPerPrBuildCounter = 0;
}

export function _getCostPerPrCacheBuildsForTests(): number {
  return costPerPrBuildCounter;
}

function fiveMinKey(now: Date, days: number): string {
  // Floor `now` to a 5-minute bucket in UTC. yyyy-mm-ddTHH:MM with the
  // minute integer rounded down to a multiple of 5. The `days` query
  // value is folded into the key so a request that toggles between
  // /api/fleet/cost-per-pr?days=14 and ?days=30 doesn't return the
  // wrong window.
  const iso = now.toISOString();
  const hh = iso.slice(11, 13);
  const m = parseInt(iso.slice(14, 16), 10);
  const bucket = Math.floor(m / 5) * 5;
  const mm = String(bucket).padStart(2, "0");
  return `${iso.slice(0, 10)}T${hh}:${mm}|d=${days}`;
}

/** Look up a fresh cost-per-PR payload from the memo cache; rebuild on
 *  miss. The cache key folds `days` together with `now` rounded to a
 *  5-minute bucket so two phones polling within the same window share
 *  one build. */
function getCostPerPrCached(db: DB, now: Date, days: number): CostPerMergedPr {
  const key = fiveMinKey(now, days);
  const hit = costPerPrCache.get(key);
  if (hit && hit.expires_at > Date.now()) return hit.value;
  costPerPrBuildCounter += 1;
  const value = costPerMergedPr(db, { now, days });
  costPerPrCache.set(key, { value, expires_at: Date.now() + COST_PER_PR_TTL_MS });
  return value;
}

// Ticket 0036: cross-fleet lessons portal view memo cache.
//
// One module-level `{path, mtimeMs, value}` per LESSONS § "expose a
// build counter for cache-hit tests, not a fetcher swap". The route
// returns the memoised parse when the file's mtime hasn't changed;
// any change to the source file (a fresh `fleet lessons-sync` run)
// bumps mtime and invalidates the entry. Per LESSONS § "in-process
// dedup sets need an explicit reset hook for tests" we expose
// `_resetLessonsCacheForTests()` AND a read-only build counter via
// `_getLessonsCacheBuildsForTests()` so tests can assert hit/miss
// semantics without stubbing fs.
interface LessonsCacheEntry {
  path: string;
  mtimeMs: number;
  value: CrossLessonsLoadResult;
}
let lessonsCache: LessonsCacheEntry | null = null;
let lessonsBuildCounter = 0;

export function _resetLessonsCacheForTests(): void {
  lessonsCache = null;
  lessonsBuildCounter = 0;
}

export function _getLessonsCacheBuildsForTests(): number {
  return lessonsBuildCounter;
}

// Ticket 0037: "Friday wrap" memo cache.
//
// 10-minute TTL keyed by `(week_iso, day_of_week)`. The wrap data
// changes slowly (PR sizes don't shift hour-to-hour; cost rollups
// move once per ingest pass) so a wide window is fine — when the ISO
// week rolls or the day-of-week changes the key changes and we
// rebuild. Per LESSONS § "in-process dedup sets need an explicit
// reset hook for tests": we expose `_resetFridayWrapCacheForTests()`.
// Per LESSONS § "expose a build counter for cache-hit tests, not a
// fetcher swap": we also expose a read-only
// `_getFridayWrapCacheBuildsForTests()` that ticks on every cache
// MISS so route tests can assert hit/miss semantics without stubbing
// SQL. Production code never reads either.
interface FridayWrapCacheEntry {
  value: FridayWrap & { visible: boolean };
  expires_at: number;
}
const FRIDAY_WRAP_TTL_MS = 600_000; // 10 minutes per the AC.
const fridayWrapCache = new Map<string, FridayWrapCacheEntry>();
let fridayWrapBuildCounter = 0;

export function _resetFridayWrapCacheForTests(): void {
  fridayWrapCache.clear();
  fridayWrapBuildCounter = 0;
}

export function _getFridayWrapCacheBuildsForTests(): number {
  return fridayWrapBuildCounter;
}

function fridayWrapCacheKey(now: Date, tz: string): string {
  // Day-of-week + week_iso composite, both in the requested tz. We
  // derive day-of-week via Intl in the same way isFriday() does so
  // the key is consistent with the visible boolean it returns.
  let weekday = "?";
  try {
    weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "short", timeZone: tz,
    }).format(now);
  } catch {
    weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "short", timeZone: "UTC",
    }).format(now);
  }
  // We import isoWeekKey indirectly via views.ts (it's exported by
  // digest.ts and re-used inside fridayWrap()); to keep the key
  // shape stable here we derive yyyy-mm directly from `now`'s ISO and
  // include the calendar date too — that gives us a per-day key on
  // top of weekday so two calls on different physical days don't
  // share a cache row even if their (week_iso, weekday) happen to
  // collide.
  const ymd = now.toISOString().slice(0, 10);
  return `${ymd}|${weekday}|tz=${tz}`;
}

/** Resolve the tz string for a /api/fleet/friday-wrap request. Per
 *  the engineering note in the ticket: `?tz=<iana>` is whitelisted
 *  against `Intl.supportedValuesOf("timeZone")` before use. An invalid
 *  tz falls back to the server's local tz so a malformed query
 *  param can't surface a 500. */
function resolveFridayWrapTz(raw: string | null): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  if (!raw) return fallback;
  // Intl.supportedValuesOf landed in node v20+; guard for older
  // engines by checking the function exists. When it's missing we
  // accept any string that node's Intl will round-trip without
  // throwing (the Intl.DateTimeFormat constructor below is the
  // ultimate validator).
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  if (typeof supported === "function") {
    let names: string[];
    try { names = supported("timeZone"); } catch { return fallback; }
    if (!names.includes(raw)) return fallback;
    return raw;
  }
  // Fallback validator for older engines.
  try { new Intl.DateTimeFormat("en-US", { timeZone: raw }); return raw; }
  catch { return fallback; }
}

/** Look up a fresh friday-wrap from the memo cache; rebuild on miss.
 *  The cache key folds `(yyyy-mm-dd, weekday, tz)` so two phones
 *  polling inside the 10-min window share one build. */
function getFridayWrapCached(db: DB, cfg: FleetConfig, now: Date, tz: string): FridayWrap & { visible: boolean } {
  const key = fridayWrapCacheKey(now, tz);
  const hit = fridayWrapCache.get(key);
  if (hit && hit.expires_at > Date.now()) return hit.value;
  fridayWrapBuildCounter += 1;
  const wrap = fridayWrap(db, now, cfg);
  const value = { ...wrap, visible: isFriday(now, tz) };
  fridayWrapCache.set(key, { value, expires_at: Date.now() + FRIDAY_WRAP_TTL_MS });
  return value;
}

// Ticket 0041: receipts page memo cache.
//
// 10-minute TTL keyed by `(slug, month_iso)` per the AC. The cache
// entry stores the full ServeReceiptsResult so both 200-with-HTML
// hits AND 404-no-row hits are memoised; the unpublish handler
// invalidates the key explicitly (per AC7) so an operator who
// unpublishes mid-window sees the URL 404 on the next fetch without
// waiting for natural TTL expiry. Per LESSONS § "in-process dedup
// sets need an explicit reset hook for tests" we expose
// `_resetReceiptsCacheForTests()`. Per LESSONS § "expose a build
// counter for cache-hit tests, not a fetcher swap" we expose a
// read-only `_getReceiptsCacheBuildsForTests()` that ticks ONLY on a
// successful (200) rebuild — a 404-hit doesn't increment the
// counter because the cache invalidation path itself is a tested
// observable, not the rebuild count.
interface ReceiptsCacheEntry {
  result: ServeReceiptsResult;
  expires_at: number;
}
const RECEIPTS_TTL_MS = 600_000; // 10 minutes per the AC
const receiptsCache = new Map<string, ReceiptsCacheEntry>();
let receiptsBuildCounter = 0;

export function _resetReceiptsCacheForTests(): void {
  receiptsCache.clear();
  receiptsBuildCounter = 0;
}

export function _getReceiptsCacheBuildsForTests(): number {
  return receiptsBuildCounter;
}

function receiptsCacheKey(slug: string, monthIso: string): string {
  return `${slug}|${monthIso}`;
}

/** Look up a receipts page via the memo cache; rebuild on miss. The
 *  result is the full ServeReceiptsResult including the 404 path,
 *  but only a successful rebuild (status===200) ticks the build
 *  counter — the counter answers the question "did this re-render?"
 *  not "did this re-query?". */
function getReceiptsCached(db: DB, slug: string, monthIso: string): ServeReceiptsResult {
  const key = receiptsCacheKey(slug, monthIso);
  const hit = receiptsCache.get(key);
  if (hit && hit.expires_at > Date.now()) return hit.result;
  const result = serveReceipts(db, slug, monthIso);
  if (result.status === 200) receiptsBuildCounter += 1;
  receiptsCache.set(key, { result, expires_at: Date.now() + RECEIPTS_TTL_MS });
  return result;
}

/** Drop a receipts cache entry. Called by the unpublish handler so a
 *  subsequent GET returns 404 immediately instead of waiting for the
 *  10-minute TTL to elapse. */
function invalidateReceiptsCache(slug: string, monthIso: string): void {
  receiptsCache.delete(receiptsCacheKey(slug, monthIso));
}

// Ticket 0040: "Riskiest open PR" memo cache.
//
// 30s TTL (matches the Cache-Control: max-age=30 header — the score
// can shift the moment a new heal lands or a PR closes). The cache
// is invalidated by a two-value tuple computed BEFORE the main query:
//
//   - openCountSnapshot       = SELECT COUNT(*) FROM pr WHERE state='open' AND is_agent=1
//   - latestHealTsSnapshot    = SELECT MAX(ts) FROM control_audit WHERE action='heal'
//
// Either value moving (a new heal-audit row OR an open-PR-count
// change) busts the cache the moment the next request lands — no
// poll-the-full-result required. Per LESSONS § "in-process dedup
// sets need an explicit reset hook for tests" we expose
// `_resetRiskiestPrCacheForTests()`. Per LESSONS § "expose a build
// counter for cache-hit tests, not a fetcher swap" we ALSO expose a
// read-only `_getRiskiestPrCacheBuildsForTests()` that ticks on
// every cache MISS so route tests assert hit/miss semantics without
// stubbing SQL. Production code never reads either.
interface RiskiestPrCacheEntry {
  tuple: string;
  value: RiskiestOpenPr;
  expires_at: number;
}
const RISKIEST_PR_TTL_MS = 30_000;
let riskiestPrCache: RiskiestPrCacheEntry | null = null;
let riskiestPrBuildCounter = 0;

export function _resetRiskiestPrCacheForTests(): void {
  riskiestPrCache = null;
  riskiestPrBuildCounter = 0;
}

export function _getRiskiestPrCacheBuildsForTests(): number {
  return riskiestPrBuildCounter;
}

interface RiskiestPrCountRow { c: number | null; }
interface RiskiestPrLatestHealRow { t: string | null; }

/** Two-value cache-invalidation tuple. Cheap: both reads hit
 *  existing indexes (control_audit_action_ts from src/db.ts +
 *  pr's PK). */
function riskiestPrInvalidationTuple(db: DB): string {
  const countRow = db.prepare(
    "SELECT COUNT(*) AS c FROM pr WHERE state = 'open' AND is_agent = 1",
  ).get() as unknown as RiskiestPrCountRow | undefined;
  const latestRow = db.prepare(
    "SELECT MAX(ts) AS t FROM control_audit WHERE action = 'heal'",
  ).get() as unknown as RiskiestPrLatestHealRow | undefined;
  const c = Number(countRow?.c ?? 0);
  const t = latestRow?.t ?? "";
  return `${c}|${t}`;
}

/** Look up a fresh riskiest-PR payload from the memo cache; rebuild on
 *  miss. The invalidation tuple (open-PR count + latest heal-audit
 *  ts) replaces a pure time-based key — any state change visible to
 *  the helper invalidates immediately rather than waiting for the
 *  30s TTL. */
function getRiskiestPrCached(db: DB, cfg: FleetConfig, now: Date): RiskiestOpenPr {
  const tuple = riskiestPrInvalidationTuple(db);
  if (
    riskiestPrCache
    && riskiestPrCache.tuple === tuple
    && riskiestPrCache.expires_at > Date.now()
  ) {
    return riskiestPrCache.value;
  }
  riskiestPrBuildCounter += 1;
  const quiet = quietHoursActiveAnywhere(cfg, now);
  const value = riskiestOpenPr(db, now, { quietHoursActive: quiet });
  riskiestPrCache = { tuple, value, expires_at: Date.now() + RISKIEST_PR_TTL_MS };
  return value;
}

// Ticket 0038: "Monday morning catch-up" memo cache.
//
// 3-min TTL keyed by `(actor_key, day_iso)`. The catch-up data
// changes faster than the friday-wrap because new PRs may merge mid-
// morning, so the AC picks 3 minutes over 10. The day_iso component
// of the key means a new calendar day always rebuilds even if a
// stale entry happens to still be inside the TTL window.
//
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests" we expose `_resetMondayCatchUpCacheForTests()`. Per
// LESSONS § "expose a build counter for cache-hit tests, not a
// fetcher swap" we also expose a read-only
// `_getMondayCatchUpCacheBuildsForTests()` that ticks on every
// cache MISS so route tests assert hit/miss semantics without
// stubbing SQL. Production code never reads either.
interface MondayCatchUpCacheEntry {
  value: MondayCatchUp & { visible: boolean };
  expires_at: number;
}
const MONDAY_CATCHUP_TTL_MS = 180_000; // 3 minutes per the AC.
const mondayCatchUpCache = new Map<string, MondayCatchUpCacheEntry>();
let mondayCatchUpBuildCounter = 0;

export function _resetMondayCatchUpCacheForTests(): void {
  mondayCatchUpCache.clear();
  mondayCatchUpBuildCounter = 0;
}

export function _getMondayCatchUpCacheBuildsForTests(): number {
  return mondayCatchUpBuildCounter;
}

/** Resolve the tz string for a /api/fleet/monday-catchup request. Per
 *  the engineering note in the ticket: `?tz=<iana>` is whitelisted
 *  against `Intl.supportedValuesOf("timeZone")` before use. An invalid
 *  tz falls back to the server's local tz so a malformed query
 *  param can't surface a 500. Identical posture to the friday-wrap
 *  resolver above. */
function resolveMondayCatchUpTz(raw: string | null): string {
  const fallback = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  if (!raw) return fallback;
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  if (typeof supported === "function") {
    let names: string[];
    try { names = supported("timeZone"); } catch { return fallback; }
    if (!names.includes(raw)) return fallback;
    return raw;
  }
  try { new Intl.DateTimeFormat("en-US", { timeZone: raw }); return raw; }
  catch { return fallback; }
}

function mondayCatchUpCacheKey(now: Date, tz: string, actorKey: string): string {
  // (actor_key, day_iso, tz) composite. The actor_key partitions by
  // who is calling so a loopback hit doesn't share a cache row with a
  // remote token's hit (the lastSeenAt watermark is per-actor).
  const ymd = now.toISOString().slice(0, 10);
  return `${actorKey}|${ymd}|tz=${tz}`;
}

/** Look up a fresh monday-catchup payload from the memo cache; rebuild
 *  on miss. The cache key folds the actor (loopback vs token id), the
 *  calendar day, and the requested tz so two polled refreshes inside
 *  the 3-min TTL share one build, but a fresh actor — or a fresh day
 *  — invalidates immediately. */
function getMondayCatchUpCached(
  db: DB, now: Date, tz: string, actorKey: string, lastSeenAt: string | null,
): MondayCatchUp & { visible: boolean } {
  const key = mondayCatchUpCacheKey(now, tz, actorKey);
  const hit = mondayCatchUpCache.get(key);
  if (hit && hit.expires_at > Date.now()) return hit.value;
  mondayCatchUpBuildCounter += 1;
  const catchUp = mondayCatchUp(db, now, {
    tz,
    lastSeenAt: lastSeenAt ?? undefined,
  });
  const value = { ...catchUp, visible: isMonday(now, tz) };
  mondayCatchUpCache.set(key, { value, expires_at: Date.now() + MONDAY_CATCHUP_TTL_MS });
  return value;
}

// Ticket 0039: "Fleet changelog" memo cache.
//
// 60s TTL keyed by the FULL query-param tuple (limit + cursor +
// project + from + to + search). The PR table changes on every
// ingest tick — completing a runIngestPass() calls the reset helper
// below as the explicit invalidation hook, so a freshly-merged PR
// surfaces on the next render even when the TTL hasn't expired.
//
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests" we expose `_resetChangelogCacheForTests()`. Per LESSONS
// § "expose a build counter for cache-hit tests, not a fetcher swap"
// we also expose a read-only `_getChangelogCacheBuildsForTests()`
// that ticks on every cache MISS so route tests assert hit/miss
// semantics without stubbing SQL. Production code never reads either.
interface ChangelogCacheEntry {
  value: FleetChangelog;
  expires_at: number;
}
const CHANGELOG_TTL_MS = 60_000;
const changelogCache = new Map<string, ChangelogCacheEntry>();
let changelogBuildCounter = 0;

export function _resetChangelogCacheForTests(): void {
  changelogCache.clear();
  changelogBuildCounter = 0;
}

export function _getChangelogCacheBuildsForTests(): number {
  return changelogBuildCounter;
}

// Ticket 0043: per-section seen-watermark POST counter. Exposed via
// the `_get…ForTests` convention so tests can assert "exactly one
// write per POST" without an injected DB stub. Production code does
// not read this value. Per LESSONS § "expose a build counter for
// cache-hit tests, not a fetcher swap".
let sectionSeenWriteCounter = 0;
export function _getSectionSeenWriteCountForTests(): number {
  return sectionSeenWriteCounter;
}
export function _resetSectionSeenWriteCountForTests(): void {
  sectionSeenWriteCounter = 0;
}

/** Production cache-invalidation hook — called from the
 *  `runIngestPass` post-COMMIT tail. We clear the whole map (one
 *  PR-table change can move any cached row); the build counter is
 *  NOT cleared here — only the cache map — so tests can observe a
 *  counter increment on the next call after an ingest. */
export function _invalidateChangelogCacheAfterIngest(): void {
  changelogCache.clear();
}

// Register the changelog invalidation hook on the global object so
// `runIngestPass` (in src/ingest/index.ts) can call it without
// importing this module (which would create a cycle — server.ts
// imports runIngestPass at the top). The global slot's name is
// suffix-prefix'd with underscores so it can't accidentally collide
// with a future builtin.
(globalThis as { __fleet_changelog_invalidate__?: () => void })
  .__fleet_changelog_invalidate__ = _invalidateChangelogCacheAfterIngest;

function changelogCacheKey(opts: FleetChangelogOptions): string {
  // Stable key over the full query-param tuple. We JSON-stringify the
  // sanitised opts object — Map keys are strings so a single
  // serialisation is the simplest correct shape (per LESSONS § cache-
  // key from the full tuple).
  return JSON.stringify({
    limit: opts.limit ?? null,
    cursor: opts.cursor ?? null,
    projectSlug: opts.projectSlug ?? null,
    from: opts.from ?? null,
    to: opts.to ?? null,
    search: opts.search ?? null,
  });
}

/** Look up a fresh changelog from the memo cache; rebuild on miss.
 *  Any throw from `fleetChangelog` (malformed cursor, invalid date
 *  string) propagates so the route can surface 400. */
function getChangelogCached(db: DB, opts: FleetChangelogOptions): FleetChangelog {
  const key = changelogCacheKey(opts);
  const hit = changelogCache.get(key);
  if (hit && hit.expires_at > Date.now()) return hit.value;
  changelogBuildCounter += 1;
  const value = fleetChangelog(db, opts);
  changelogCache.set(key, { value, expires_at: Date.now() + CHANGELOG_TTL_MS });
  return value;
}

/** Stable per-actor key used for the home_last_seen_<actor> watermark
 *  + the monday-catchup cache partition. Loopback is the literal
 *  string "loopback"; a remote token is the token's id (the SHA-256
 *  digest of the plaintext — never the plaintext itself). */
function actorKeyFor(req: any, principal: TokenRecord | null): string {
  if (principal) return principal.id_prefix;
  return isLoopback(req) ? "loopback" : "anonymous";
}

/** Upsert the home_last_seen_<actor> watermark row on every
 *  authenticated GET to /api/fleet. Reuses the existing watermark
 *  table (no schema migration). The previous cursor (if any) is
 *  returned so the monday-catchup helper can consult it on the SAME
 *  request — that is the value the AC asks for. */
function upsertHomeLastSeen(
  db: DB, actorKey: string, nowIso: string,
): string | null {
  const source = `home_last_seen_${actorKey}`;
  const priorRow = db.prepare(
    "SELECT cursor FROM watermark WHERE source = ?",
  ).get(source) as { cursor: string } | undefined;
  const prior = priorRow?.cursor ?? null;
  db.prepare(
    "INSERT INTO watermark(source, cursor, updated_at) VALUES (?, ?, ?) "
    + "ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, "
    + "updated_at = excluded.updated_at",
  ).run(source, nowIso, nowIso);
  return prior;
}

/** Read the current home_last_seen_<actor> cursor without upserting.
 *  The monday-catchup route reads this on each call so the window
 *  start is the LATER of (Friday 17:00, last_seen). */
function readHomeLastSeen(db: DB, actorKey: string): string | null {
  const source = `home_last_seen_${actorKey}`;
  const row = db.prepare(
    "SELECT cursor FROM watermark WHERE source = ?",
  ).get(source) as { cursor: string } | undefined;
  return row?.cursor ?? null;
}

function getLessonsCached(path: string): CrossLessonsLoadResult {
  // Read mtime first so a swap-in of a different file (via the env
  // override) or a `utimesSync` from a test invalidates the cache.
  // A missing file has no mtime; treat that as mtimeMs=0 so two
  // consecutive missing-file requests share one build.
  let mtimeMs = 0;
  try { mtimeMs = statSync(path).mtimeMs; } catch { mtimeMs = 0; }
  if (lessonsCache && lessonsCache.path === path && lessonsCache.mtimeMs === mtimeMs) {
    return lessonsCache.value;
  }
  lessonsBuildCounter += 1;
  const value = loadCrossLessons(path);
  lessonsCache = { path, mtimeMs, value };
  return value;
}

// Refresh history at most every 10s on read (cheap; live state is always fresh).
let lastIngest = 0;
function maybeIngest(db: DB, cfg: FleetConfig) {
  // Skip if the daemon owns ingest (single writer); just serve the cache.
  if (daemonStatus()) return;
  if (Date.now() - lastIngest > 10_000) {
    try { runIngestPass(db, cfg); evalAlerts(db, cfg, false); } catch { /* keep serving */ }
    lastIngest = Date.now();
  }
}

const json = (res: any, body: unknown, code = 200) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(s);
};

/** Optional knobs the demo subcommand (ticket 0025) passes through to
 *  short-circuit every side-effecting boot step. When `demoMode` is
 *  true the server: (a) skips the legacy admin-token migration (the
 *  demo never reads the real fleet-control.config.json), (b) skips
 *  pricing sync, (c) skips the inline runIngestPass() — leaving the
 *  hand-authored fixture in the DB intact, and (d) flags maybeIngest()
 *  so the periodic read-time ingest also stays a no-op. */
export interface StartServerOpts {
  demoMode?: boolean;
  /** When set, suppress the default "fleet-control portal → ..." log
   *  line printed inside the listen callback. The demo CLI (ticket
   *  0025) sets this so it can emit its own banner exactly once,
   *  after the socket is actually accepting connections. */
  quietBanner?: boolean;
  /** Fires inside the server.listen callback — i.e. after the kernel
   *  has bound the port and accept() is live. Demo mode uses this to
   *  print its two-line banner only when fetch() will actually
   *  succeed. */
  onListening?: () => void;
}

export function startServer(host = "127.0.0.1", port = 7070, opts: StartServerOpts = {}) {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const demoMode = opts.demoMode === true;
  if (!demoMode) {
    // One-shot: if the legacy adminToken still lives in the config and we have
    // no auth_token rows, promote it to a real admin-scoped token so existing
    // paired devices keep working through the upgrade. After this returns the
    // adminToken field is gone from disk (see src/auth.ts).
    migrateLegacyAdminTokenIfPresent(db, CONFIG_FILE);
    // Ticket 0004: refresh the pricing table from data/anthropic-pricing.json
    // on every boot. A missing file is a no-op (DEFAULT_PRICING is already
    // seeded elsewhere), so this never crashes the server.
    try { syncPricing(db); } catch { /* keep serving */ }
    runIngestPass(db, cfg);
    lastIngest = Date.now();
  } else {
    // Demo mode: the fixture is the source of truth. Forbid the periodic
    // read-time ingest from firing by pinning lastIngest into the future
    // (maybeIngest() only fires when Date.now() - lastIngest > 10s).
    lastIngest = Number.MAX_SAFE_INTEGER;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;
    try {
      // control actions (management) — POST, auth-gated for non-loopback
      const cm = path.match(/^\/api\/control\/([\w-]+)$/);
      if (cm && req.method === "POST") {
        // Token management lives inside doAction("tokens-*") and requires
        // admin; one-click GitHub-URL import (ticket 0010) also requires
        // admin — it spawns a clone + install on disk on the operator's
        // behalf. Snapshot-create / snapshot-revoke (ticket 0013) mint a
        // long-lived share URL whose surface is read-only but whose
        // existence is itself a privacy decision — only admin can take
        // it. Every other control verb requires control. Daemon toggle
        // is local-only infrastructure → control is sufficient.
        const required: Scope = (cm[1].startsWith("tokens-") || cm[1] === "register-url" || cm[1].startsWith("snapshot-")) ? "admin" : "control";
        const auth = requireAuth(db, req, required);
        if (!auth.ok) return json(res, { ok: false, message: auth.message }, auth.status);
        return readBody(req).then(async (body) => {
          let r;
          try {
            const who = actorOf(req, auth.principal);
            if (cm[1] === "daemon") { // always-on toggle (off by default)
              const on = body.enabled ?? body.on;
              if (on) installDaemon(Number(body.interval) || 60); else uninstallDaemon();
              r = { ok: true, message: on ? "Always-on monitoring enabled." : "Always-on monitoring disabled." };
            } else {
              // Ticket 0013: for snapshot-create the server freezes a
              // fresh fleet view server-side so the snapshot reflects
              // the same numbers the operator just saw on the home page
              // — and so a malicious caller can't smuggle a hand-rolled
              // payload through the API. base_url is derived from the
              // incoming Host header so the returned share_url is one
              // the recipient's network can actually resolve.
              if (cm[1] === "snapshot-create") {
                body.fleet_view = fleetView(db, cfg);
                const host = String(req.headers["host"] ?? "127.0.0.1:7070");
                body.base_url = `http://${host}`;
              }
              // doAction is now async (ticket 0006 introduced an action that
              // does node:fs/promises rm() — every action funnels through the
              // same await so the call site stays one path).
              r = await doAction(db, who.actor, cm[1], body, who.actor_name);
            }
          } catch (e: any) { r = { ok: false, message: String(e?.message ?? e) }; }
          lastIngest = 0; // force fresh state next read
          json(res, r, r.ok ? 200 : 400);
        });
      }
      if (path === "/api/whoami") return json(res, { loopback: isLoopback(req), needsToken: !isLoopback(req) });
      // Ticket 0017: today's inbox dismiss endpoint. POST a JSON body
      // {kind, project_slug, payload_id} to mark one item handled.
      // Requires `read` scope (loopback bypasses) — same posture as
      // every other read-API; the dismissal write is additive (a row
      // in inbox_dismissal + an UPDATE on anomaly.dismissed_at for
      // anomaly_open), so it's safe under the read scope. The path
      // ends in /inbox/dismiss (NOT /api/control/...) so it doesn't
      // require admin and doesn't collide with the control verb
      // surface.
      if (path === "/api/fleet/inbox/dismiss" && req.method === "POST") {
        const iauth = requireAuth(db, req, "read", url);
        if (!iauth.ok) return json(res, { ok: false, message: iauth.message }, iauth.status);
        return readBody(req).then((body) => {
          const r = dismissInboxItem(db, body as DismissRequest);
          return json(res, r, r.ok ? 200 : 400);
        });
      }
      // Ticket 0041: receipts publish / unpublish.
      // POST /api/receipts/publish  body {project_slug, month_iso}
      // POST /api/receipts/unpublish body {project_slug, month_iso}
      // Both require `admin` scope (publishing a stable public URL is
      // an admin-level privacy decision; unpublishing kills it). The
      // routes live OUTSIDE the /api/control/<verb> dispatcher because
      // they don't follow the shell-out-via-doAction shape — they're
      // pure SQL persistence + cache invalidation.
      if (path === "/api/receipts/publish" && req.method === "POST") {
        const pauth = requireAuth(db, req, "admin", url);
        if (!pauth.ok) return json(res, { ok: false, message: pauth.message }, pauth.status);
        return readBody(req).then((body) => {
          const slug = String(body?.project_slug ?? "");
          const monthIso = String(body?.month_iso ?? "");
          if (!isValidMonthIso(monthIso)) {
            return json(res, { ok: false, message: "bad month_iso (expected YYYY-MM)" }, 400);
          }
          // Validate the slug against the project table OR the literal
          // "fleet" form (the cross-project rollup).
          if (slug !== "fleet") {
            const exists = db.prepare("SELECT 1 FROM project WHERE slug = ?").get(slug);
            if (!exists) return json(res, { ok: false, message: "unknown project slug" }, 400);
          }
          const payload: ReceiptsPayload = computeReceipts(db, slug, monthIso, new Date());
          persistReceipts(db, payload);
          // Bust the receipts cache so the next GET re-reads the fresh
          // frozen payload.
          invalidateReceiptsCache(slug, monthIso);
          // Build the public URL from the incoming Host header so the
          // operator's network can resolve it (matches the snapshot
          // share_url derivation pattern).
          const host = String(req.headers["host"] ?? "127.0.0.1:7070");
          const published_url = `http://${host}/receipts/${slug}/${monthIso}`;
          return json(res, { ok: true, published_url, payload }, 200);
        });
      }
      if (path === "/api/receipts/unpublish" && req.method === "POST") {
        const uauth = requireAuth(db, req, "admin", url);
        if (!uauth.ok) return json(res, { ok: false, message: uauth.message }, uauth.status);
        return readBody(req).then((body) => {
          const slug = String(body?.project_slug ?? "");
          const monthIso = String(body?.month_iso ?? "");
          if (!isValidMonthIso(monthIso)) {
            return json(res, { ok: false, message: "bad month_iso (expected YYYY-MM)" }, 400);
          }
          unpublishReceipts(db, slug, monthIso);
          // Per AC7 unpublish invalidates the cache key so a fetch
          // inside the 10-minute TTL window 404s immediately instead
          // of returning the now-stale page.
          invalidateReceiptsCache(slug, monthIso);
          return json(res, { ok: true }, 200);
        });
      }
      // Live SSE tool-call stream (ticket 0002). Plain text/event-stream; tails
      // the active jsonl transcript and re-opens on rotation. Closes itself
      // after 5 min of idle or on client disconnect. Loopback bypasses auth;
      // remote requires x-fleet-token (header or ?token=, since browser
      // EventSource can't set custom headers).
      const sm = path.match(/^\/api\/projects\/([\w-]+)\/stream$/);
      if (sm) {
        const sauth = requireAuth(db, req, "read", url);
        if (!sauth.ok) {
          res.writeHead(sauth.status, { "content-type": "text/plain" });
          return res.end(sauth.message);
        }
        const slug = sm[1];
        const optPhase = url.searchParams.get("phase") ?? undefined;
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          "connection": "keep-alive",
          "x-accel-buffering": "no",
          "access-control-allow-origin": "*",
        });
        // SSE retry hint + an immediate "hello" comment so the client knows
        // the channel is alive even before any transcript bytes arrive.
        res.write("retry: 5000\n");
        res.write(": connected\n\n");
        const send = (e: TailEvent) => {
          try {
            const payload = e.path ? { path: e.path, ...(e.data ?? {}) } : (e.data ?? {});
            res.write(`event: ${e.type}\ndata: ${JSON.stringify(payload)}\n\n`);
          } catch { /* peer gone; close handler will tidy up */ }
        };
        const ctrl = tailTranscript(cfg, slug, (e) => {
          send(e);
          if (e.type === "idle-close") { try { res.end(); } catch { /* */ } }
        }, { phase: optPhase });
        // Heartbeat comment every 25s — keeps proxies/load balancers from
        // killing the idle TCP connection without sending a parseable event.
        const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* */ } }, 25_000);
        const teardown = () => { clearInterval(hb); ctrl.close(); };
        req.on("close", teardown);
        res.on("close", teardown);
        return;
      }
      // Inline PR diff (ticket 0007). text/plain body — NOT JSON — so the
      // SPA can stream it directly into a <div> after escaping. Cached
      // server-side for 30s per (repo,number). Read scope (loopback
      // bypasses); malformed slugs / numbers are 400 before any shell-out.
      // Path shape: /api/prs/<owner>/<name>/<number>/diff — the ":repo"
      // segment intentionally contains a "/" because it's owner/name.
      const dfm = path.match(/^\/api\/prs\/([^/]+\/[^/]+)\/(\d+)\/diff$/);
      if (dfm && req.method === "GET") {
        const dauth = requireAuth(db, req, "read", url);
        if (!dauth.ok) {
          res.writeHead(dauth.status, { "content-type": "text/plain" });
          return res.end(dauth.message);
        }
        return fetchPrDiff(dfm[1], dfm[2]).then((r) => {
          res.writeHead(r.status, {
            "content-type": "text/plain; charset=utf-8",
            "x-diff-truncated": r.truncated ? "1" : "0",
            "cache-control": "no-store",
          });
          res.end(r.body);
        }).catch((e: any) => {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(String(e?.message ?? e));
        });
      }
      if (path.startsWith("/api/")) {
        // All read endpoints require the `read` scope (loopback bypasses).
        const rauth = requireAuth(db, req, "read", url);
        if (!rauth.ok) return json(res, { error: rauth.message }, rauth.status);
        maybeIngest(db, cfg);
        if (path === "/api/fleet") {
          // Ticket 0038: every authenticated GET to /api/fleet upserts a
          // home_last_seen_<actor> watermark row so the Monday catch-up
          // window can start at the LATER of (Friday 17:00, last-seen).
          // The watermark table is reused — no new schema. The JSON
          // shape of /api/fleet is unchanged (the AC is explicit).
          //
          // Ticket 0043: read the PRE-upsert watermark FIRST so the
          // additive `previous_last_seen` field reflects the visit
          // BEFORE this one (the SPA passes it back into
          // `/api/fleet/new-since-visit?since=` so the diff is against
          // the previous visit, not the just-upserted one). This is
          // the additive top-level field the new-since-visit SPA
          // logic depends on; per AGENTS.md additive-on-existing-route
          // is permitted (renaming or removing is not).
          const actorKeyForFleet = actorKeyFor(req, rauth.principal);
          let previousLastSeen: string | null = null;
          try {
            previousLastSeen = readHomeLastSeen(db, actorKeyForFleet);
            upsertHomeLastSeen(
              db, actorKeyForFleet,
              new Date().toISOString(),
            );
          } catch { /* watermark row is best-effort; never block /api/fleet */ }
          const v = fleetView(db, cfg) as Record<string, unknown>;
          v.previous_last_seen = previousLastSeen;
          // Ticket 0022: ?sort=health re-orders the project grid
          // ascending by health.score (worst first) so the operator's
          // eye lands on the project that needs them. The default
          // ordering (slug ASC, set by fleetView) is unchanged when
          // the query param is absent.
          if (url.searchParams.get("sort") === "health") {
            const projects = v.projects as any[];
            v.projects = [...projects].sort((a: any, b: any) =>
              (a.health?.score ?? 0) - (b.health?.score ?? 0));
          }
          return json(res, v);
        }
        // Ticket 0043: new-since-last-visit diff. Composes pr / anomaly
        // / alert / inbox reads against the existing watermark seam
        // 0038 introduced. Cache-Control: no-store because the value
        // is per-visit and changes the moment ANY new row lands. The
        // optional `?since=` query param wins over the watermark so
        // the SPA can pass the PRE-upsert value from /api/fleet's
        // additive `previous_last_seen` field — otherwise the
        // operator's home-page visit would race the upsert.
        if (path === "/api/fleet/new-since-visit") {
          const actorKey = actorKeyFor(req, rauth.principal);
          const since = url.searchParams.get("since");
          const opts: NewSinceLastVisitOptions = {};
          if (since) opts.since = since;
          const v = newSinceLastVisit(db, new Date(), actorKey, opts);
          const body = JSON.stringify(v);
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "no-store",
          });
          return res.end(body);
        }
        // Ticket 0043: per-section seen watermark POST. The SPA's
        // IntersectionObserver hook batches viewport-visible item ids
        // and POSTs them here every 5s OR on visibilitychange. An
        // unknown `section` is a 400; an unknown `actorKey` is
        // impossible (loopback always resolves). The write counter
        // is exposed via `_getSectionSeenWriteCountForTests()` per
        // LESSONS § "expose a build counter for cache-hit tests,
        // not a fetcher swap".
        if (path === "/api/fleet/section-seen" && req.method === "POST") {
          const actorKey = actorKeyFor(req, rauth.principal);
          return readBody(req).then((body) => {
            const section = String(body.section ?? "");
            const itemIds = Array.isArray(body.item_ids) ? body.item_ids.map(String) : [];
            if (!isValidNewSinceSection(section)) {
              return json(res, { ok: false, message: `unknown section: ${section}` }, 400);
            }
            if (!Array.isArray(body.item_ids)) {
              return json(res, { ok: false, message: "item_ids must be an array" }, 400);
            }
            try {
              const r = markSectionSeen(db, actorKey, section, itemIds, new Date());
              sectionSeenWriteCounter += 1;
              return json(res, { upserted: r.upserted }, 200);
            } catch (e: any) {
              return json(res, { ok: false, message: String(e?.message ?? e) }, 400);
            }
          });
        }
        // Ticket 0022: per-project health detail. Reads `read` scope
        // (loopback bypasses), same posture as every other GET
        // /api/projects/:slug/* route. Returns the full
        // {score, band, subs, generated_at, formula} payload — the
        // SPA tooltip renders the formula text from this response so
        // the docs stay live.
        const hm = path.match(/^\/api\/projects\/([\w-]+)\/health$/);
        if (hm) {
          const pid = projectIdBySlug(db, hm[1]);
          if (pid == null) return json(res, { error: "not found" }, 404);
          return json(res, projectHealth(db, pid));
        }
        // Ticket 0017: today's inbox. Cross-project "what needs me"
        // aggregation over PRs / anomalies / snapshots / failed runs.
        // Read-scope (loopback bypasses); same shape as every other
        // GET /api/fleet/* route — net-new, no existing JSON shape to
        // preserve.
        if (path === "/api/fleet/inbox") return json(res, fleetInbox(db, { cfg }));
        // Ticket 0027: active cross-project failure correlations.
        // Read-scope (loopback bypasses); same posture as every other
        // GET /api/fleet/* route. Net-new — no existing JSON shape to
        // preserve. Returns the array of active (non-dismissed)
        // correlation rows the inbox + detail view both render.
        if (path === "/api/fleet/correlations") {
          return json(res, { correlations: activeCorrelations(db, new Date()) });
        }
        // Merge streak counter + 90-day calendar heatmap (ticket 0026).
        // Read-scope (loopback bypasses); same posture as every other
        // GET /api/fleet/* route. Net-new — no existing JSON shape
        // to preserve. The helper does two SQL GROUP BYs + one JS
        // walk; well under 50ms even at 10 projects × 90 days.
        if (path === "/api/fleet/streak") return json(res, fleetStreak(db));
        // Ticket 0033: "Yesterday at a glance" morning card. Composes
        // existing helpers (fleetStreak / projectHealth / activeCorrelations
        // / daily-budget reads) into one payload; cached for 60s in a
        // module-level Map keyed by `now` rounded to the minute. The
        // response Cache-Control: max-age=60 also lets the SW cache
        // (0029) survive across phone refreshes inside the window.
        if (path === "/api/fleet/glance") {
          const v = getGlanceCached(db, cfg, new Date());
          const body = JSON.stringify(v);
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=60",
          });
          return res.end(body);
        }
        // Ticket 0037: Friday wrap weekly card. Composes the existing
        // fridayWrap() helper into a route that always returns 200 so
        // the SPA can pre-fetch on any day; the `visible` boolean is
        // the gate the SPA reads to decide whether to render. The
        // 10-min memo cache is keyed by `(yyyy-mm-dd, weekday, tz)`
        // so polled SPA refreshes inside the window share one build —
        // matches the AC's "wrap data changes slowly" framing and the
        // SW cache (0029) survives a phone refresh inside the window.
        // Net-new route; no existing JSON shape to preserve.
        if (path === "/api/fleet/friday-wrap") {
          const tz = resolveFridayWrapTz(url.searchParams.get("tz"));
          const v = getFridayWrapCached(db, cfg, new Date(), tz);
          const body = JSON.stringify(v);
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=600",
          });
          return res.end(body);
        }
        // Ticket 0038: Monday morning catch-up. Composes pr +
        // cost_rollup_day + alert + anomaly + ticket_commit_link into
        // one payload; the route always returns 200 so the SPA can
        // pre-fetch on any day and decide-to-render via the
        // `visible` boolean (the day-of-week gate). 3-min memo cache
        // keyed by (actor_key, day_iso, tz). The `lastSeenAt` value
        // is read from the watermark row that /api/fleet upserts on
        // every authenticated GET, so the Monday catch-up window
        // starts at the LATER of (Friday 17:00, last-seen). Net-new
        // route; no existing JSON shape to preserve.
        if (path === "/api/fleet/monday-catchup") {
          const tz = resolveMondayCatchUpTz(url.searchParams.get("tz"));
          const actorKey = actorKeyFor(req, rauth.principal);
          const lastSeen = readHomeLastSeen(db, actorKey);
          const v = getMondayCatchUpCached(db, new Date(), tz, actorKey, lastSeen);
          const body = JSON.stringify(v);
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=180",
          });
          return res.end(body);
        }
        // Ticket 0040: riskiest open PR — one fleet-wide line names
        // the PR most likely to hurt the operator next. Composes
        // pr / project / control_audit (heal-attempt tail) — no
        // schema migration. 30s memo cache invalidated by a two-value
        // tuple (open-PR count + latest heal-audit ts) so a fresh
        // heal lands a new badge on the next render. Quiet hours
        // (0030) suppress an `infra_flake` top row overnight — the
        // helper takes the flag; the SPA can re-render the same
        // shape with `top: null`. Net-new route — no existing JSON
        // shape to preserve.
        if (path === "/api/fleet/riskiest-pr") {
          const v = getRiskiestPrCached(db, cfg, new Date());
          const body = JSON.stringify(v);
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=30",
          });
          return res.end(body);
        }
        // Ticket 0039: fleet changelog — one chronological page of
        // every merged agent PR across every project, ticket-linked.
        // Composes pr + project + ticket_commit_link — no schema
        // migration. Query params: limit, cursor, project, from, to,
        // search. The 60s memo cache is keyed by the full param tuple;
        // a runIngestPass() tail call to
        // `_invalidateChangelogCacheAfterIngest()` clears the map the
        // moment a freshly-merged PR lands. Malformed cursor / invalid
        // date strings surface as 400 (not 500) — `fleetChangelog`
        // throws and the catch below maps that to a JSON 400. Net-new
        // route; no existing JSON shape to preserve.
        if (path === "/api/fleet/changelog") {
          const params = url.searchParams;
          const optsForChangelog: FleetChangelogOptions = {};
          const rawLimit = params.get("limit");
          if (rawLimit != null) optsForChangelog.limit = Number(rawLimit);
          const rawCursor = params.get("cursor");
          if (rawCursor) optsForChangelog.cursor = rawCursor;
          const rawProject = params.get("project");
          if (rawProject) optsForChangelog.projectSlug = rawProject;
          const rawFrom = params.get("from");
          if (rawFrom) optsForChangelog.from = rawFrom;
          const rawTo = params.get("to");
          if (rawTo) optsForChangelog.to = rawTo;
          const rawSearch = params.get("search");
          if (rawSearch) optsForChangelog.search = rawSearch;
          let value: FleetChangelog;
          try { value = getChangelogCached(db, optsForChangelog); }
          catch (e: any) {
            // Malformed cursor / invalid date → 400 with the
            // helper's error message ("invalid cursor", "invalid
            // from date: banana", …).
            return json(res, { error: String(e?.message ?? e) }, 400);
          }
          const body = JSON.stringify(value);
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=60",
          });
          return res.end(body);
        }
        // Ticket 0035: cost per merged PR — the single number that
        // frames spend in value terms. Composes existing pr +
        // cost_rollup_day + project tables; no schema migration. The
        // 5-minute memo cache is keyed by (days, now-rounded-to-5-min)
        // so polled SPA refreshes inside the window share one build —
        // matches the AC's "5 min — this number changes slowly" framing
        // and the SW cache (0029) survives a phone refresh inside the
        // window. Net-new route; no existing JSON shape to preserve.
        if (path === "/api/fleet/cost-per-pr") {
          const days = clampDays(url.searchParams.get("days"));
          const v = getCostPerPrCached(db, new Date(), days);
          const body = JSON.stringify(v);
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=300",
          });
          return res.end(body);
        }
        // Ticket 0036: cross-fleet lessons portal view. Reads
        // ~/.local/share/agent-fleet/CROSS_LESSONS.md (or the
        // FLEET_CROSS_LESSONS_PATH override), parses the per-project
        // structure once per mtime, returns the structured payload
        // with the additional `new_this_week` count for the SPA's
        // filter checkbox. Cache-Control: max-age=120 lets the SW
        // cache (0029) survive across phone refreshes inside the
        // window; the server-side mtime memo handles the long tail
        // of polled refreshes. Net-new route — no existing JSON
        // shape to preserve. The oversized branch returns the same
        // top-level shape (projects:[], source_present:true,
        // oversized:true) so the SPA's empty-state path renders the
        // friendly copy instead of a 500.
        if (path === "/api/fleet/lessons") {
          const lessonsPath = defaultLessonsPath();
          const v = getLessonsCached(lessonsPath);
          const nwt = newThisWeekCount(v, new Date());
          const body = JSON.stringify({
            projects: v.projects,
            parsed_at: v.parsed_at,
            total: v.total,
            source_present: v.source_present,
            oversized: v.oversized ?? false,
            new_this_week: nwt,
          });
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=120",
          });
          return res.end(body);
        }
        // Cross-project tool-call leaderboard (ticket 0014). One JSON
        // payload composed of three SQL aggregations (tools across the
        // fleet, projects, cost-by-phase heatmap). `days` query param
        // defaults to 14, clamped to [1, 90] — clampDays() lives in
        // views.ts so the tests share the same source of truth.
        if (path === "/api/fleet/leaderboard") {
          const days = clampDays(url.searchParams.get("days"));
          return json(res, fleetLeaderboard(db, { days }));
        }
        // Weekly digest (ticket 0012). Cached for 5 min inside the helper
        // keyed by the period — cheap to recompute, but a polled SPA could
        // hit this every 5s on the home view. Same shape as the Digest
        // type in src/digest.ts; the SPA's home banner consumes it.
        if (path === "/api/digest/week") return json(res, weeklyDigest(db));
        // Pricing table (ticket 0004). `synced_at` is the most-recent
        // fetched_at across all rows; `stale` flips true when that's older
        // than 24h so the SPA footer can render a warn badge.
        if (path === "/api/pricing") {
          const rows = pricingRows(db);
          const synced = lastSyncedAt(db);
          const stale = synced ? (Date.now() - new Date(synced).getTime()) > 24 * 60 * 60_000 : true;
          return json(res, { models: rows, synced_at: synced, stale });
        }
        const pm = path.match(/^\/api\/project\/([\w-]+)$/);
        if (pm) { const v = projectView(db, cfg, pm[1]); return v ? json(res, v) : json(res, { error: "not found" }, 404); }
        // 30-day cost forecast (ticket 0005). New route; no existing JSON
        // shape to preserve. Returns null when fewer than 3 days of data
        // exist (the view surfaces "not enough yet" instead of a number).
        const fm = path.match(/^\/api\/projects\/([\w-]+)\/forecast$/);
        if (fm) { const v = forecastFor(db, fm[1]); return v ? json(res, v) : json(res, { error: "not found" }, 404); }
        // Ticket 0028: month-to-date budget burndown for the project
        // card's inline sparkline. Reads `read` scope (loopback
        // bypasses); same posture as every other GET
        // /api/projects/:slug/* route. Net-new — no existing JSON
        // shape to preserve. Returns the full {days, cap_per_day_usd,
        // cap_eom_usd, projected_eom_usd, band} payload; the SPA
        // fetches it lazily on card tap.
        const bdm = path.match(/^\/api\/projects\/([\w-]+)\/burndown$/);
        if (bdm) {
          const pid = projectIdBySlug(db, bdm[1]);
          if (pid == null) return json(res, { error: "not found" }, 404);
          return json(res, projectBurndown(db, pid));
        }
        // Ticket 0034: self-baseline drift detector — per-project
        // detail. Returns {detected, baseline_window, current_window,
        // generated_at}. Read-scope (loopback bypasses); same posture
        // as every other GET /api/projects/:slug/* route. Net-new —
        // no existing JSON shape to preserve. The detector reads
        // existing run_event / run / anomaly tables only; no schema
        // migration needed.
        const dfmDrift = path.match(/^\/api\/projects\/([\w-]+)\/drift$/);
        if (dfmDrift) {
          const pid = projectIdBySlug(db, dfmDrift[1]);
          if (pid == null) return json(res, { error: "not found" }, 404);
          return json(res, projectDriftReport(db, pid, new Date()));
        }
        // Ticket 0031: per-project tool-mix sparkline. Returns
        // {window, tools, total_invocations} — the stacked-bar
        // ingredients the SPA's project page renders above the job
        // cards. `days` clamps to [1,30] (default 7) — the tool-mix
        // is a recent-window question; longer windows don't help the
        // operator drilling into "where did this week's budget go?".
        // Net-new route — no existing JSON shape to preserve; the
        // /api/project/:slug detail payload stays additive-only and
        // does NOT inline this aggregate (the SPA fetches lazily on
        // render).
        const tmm = path.match(/^\/api\/projects\/([\w-]+)\/tool-mix$/);
        if (tmm) {
          const pid = projectIdBySlug(db, tmm[1]);
          if (pid == null) return json(res, { error: "not found" }, 404);
          const days = clampToolMixDays(url.searchParams.get("days"));
          return json(res, projectToolMix(db, pid, new Date(), days));
        }
        // Disk usage + stale-checkout candidates (ticket 0006). 200 with an
        // all-zeros payload for an unknown slug — the SPA's expandable
        // section just shows "0 GB · no candidates" rather than a 404.
        const dm = path.match(/^\/api\/projects\/([\w-]+)\/disk$/);
        if (dm) {
          return diskUsage(dm[1])
            .then((r) => json(res, r))
            .catch((e: any) => json(res, { error: String(e?.message ?? e) }, 500));
        }
        // Ticket 0018: backlog-ticket ship report. Aggregates the
        // ticket_commit_link rows for one 4-digit ticket id; the SPA
        // renders a "Shipped as PR #N · K commits · +X / -Y across Z
        // files" panel beneath the acceptance criteria. Net-new — no
        // existing JSON shape to preserve. Returns 404 when no
        // commits link to the ticket so the SPA can render nothing
        // for proposed / groomed / in-progress tickets.
        const shipm = path.match(/^\/api\/backlog\/(\d{4})\/ship-report$/);
        if (shipm) {
          const rep = ticketShipReport(db, shipm[1]);
          return rep ? json(res, rep) : json(res, { error: "not found" }, 404);
        }
        // Anomalies for a project (ticket 0008). Default N=10, hard cap 50.
        // 200 with `{anomalies: []}` for an unknown slug — same shape as
        // /events, so the SPA can render "no anomalies" without a 404 path.
        const am = path.match(/^\/api\/projects\/([\w-]+)\/anomalies$/);
        if (am) {
          const proj = db.prepare("SELECT id FROM project WHERE slug=?").get(am[1]) as { id: number } | undefined;
          if (!proj) return json(res, { anomalies: [] });
          const raw = Number(url.searchParams.get("limit") ?? "10");
          const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 50) : 10;
          return json(res, { anomalies: recentAnomalies(db, proj.id, limit) });
        }
        // Typed event stream (ticket 0001). Read-only, slug-scoped, capped.
        const em = path.match(/^\/api\/projects\/([\w-]+)\/events$/);
        if (em) {
          const limit = Number(url.searchParams.get("limit") ?? "50");
          const safe = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50;
          return json(res, { slug: em[1], events: recentEvents(db, em[1], safe) });
        }
        const rm = path.match(/^\/api\/run\/(\d+)$/);
        if (rm) { const v = runView(db, Number(rm[1])); return v ? json(res, v) : json(res, { error: "not found" }, 404); }
        return json(res, { error: "unknown endpoint" }, 404);
      }
      // Ticket 0015: embeddable status badge SVG per project. Public
      // by design — same posture as /share/<token>; the slug is not a
      // secret on a LAN and a public deployment is the operator's
      // choice. An unknown slug is a 200 grey "unknown" badge (NOT a
      // 404 — a 404 inside an <img> is uglier than a placeholder).
      // An invalid metric is a 400 with a plain-text body. Cached for
      // 60 seconds with an ETag derived from sha256(body) so README
      // renderers can revalidate cheaply.
      const bm = path.match(/^\/badge\/([\w-]+)\.svg$/);
      if (bm && req.method === "GET") {
        const slug = bm[1];
        const metric = parseMetric(url.searchParams.get("metric"));
        if (metric === null) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          return res.end("unknown metric — try one of: status, cost, ship");
        }
        const data = projectBadge(db, slug, metric);
        const body = renderBadge(data);
        const etag = '"' + createHash("sha256").update(body).digest("hex") + '"';
        // If-None-Match short-circuit so README renderers re-validate
        // cheaply. We compare on the strong-quoted ETag so a future
        // weak-validator change here doesn't silently start matching.
        const inm = req.headers["if-none-match"];
        if (typeof inm === "string" && inm === etag) {
          res.writeHead(304, {
            "etag": etag,
            "cache-control": "public, max-age=60",
          });
          return res.end();
        }
        res.writeHead(200, {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "public, max-age=60",
          "etag": etag,
          // Badges are intended for embedding; expose the route to
          // any origin (the bytes are public by design).
          "access-control-allow-origin": "*",
        });
        return res.end(body);
      }
      // Ticket 0032: phone-pairing route. NOT under `/api/` so it
      // never collides with the JSON API surface and doesn't trip the
      // existing auth middleware (the token IS the auth). Rate-limited
      // at 10 attempts / minute per source IP so an attacker on the
      // LAN can't brute-force the 12-char token inside its 90-second
      // window. The route is a simple GET because the QR-scan target
      // becomes a browser navigation, which is always a GET — we
      // accept that this leaks the token into Referer for any page the
      // operator subsequently navigates to, but the token is single-
      // use and already-consumed by the time the redirect runs.
      // Two URL shapes accepted: `/pair?t=<token>` (human-typeable) and
      // `/P/<TOKEN>` (uppercase path-style, alphanumeric-friendly so a
      // V1-L QR can encode it under the 25-char capacity). Both are
      // GET-only; both consume the same one-shot token row.
      const pathPairMatch = path.match(/^\/P\/([0-9A-Z-]+)$/);
      if ((path === "/pair" || pathPairMatch) && req.method === "GET") {
        const ip = String(req.socket?.remoteAddress ?? "unknown");
        if (!rateLimitAllow(ip)) {
          res.writeHead(429, { "content-type": "text/plain; charset=utf-8" });
          return res.end("too many attempts");
        }
        // Opportunistic sweep so the table doesn't accumulate expired
        // rows after many serve restarts.
        try { sweepExpiredPairTokens(db); } catch { /* table missing on fresh boot; ignore */ }
        // Path-style URLs carry the token in upper-case (QR
        // alphanumeric constraint) but the stored token is whatever
        // case mintPairToken produced (also upper) — we accept either
        // form without lower-casing so a token that ever included
        // lowercase via a future change continues to work.
        const token = pathPairMatch
          ? pathPairMatch[1]
          : String(url.searchParams.get("t") ?? "");
        const r = consumePairToken(db, token);
        if (!r.ok || !r.admin_token) {
          // Expired / unknown / malformed — render a small HTML page
          // explaining how to re-mint. No cookie set. 200 because the
          // page itself is intentional content; a 404 would render as
          // browser chrome noise on the phone.
          const reason = r.reason ?? "unknown";
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          return res.end(
            "<!doctype html><html><head><meta charset=\"utf-8\">"
            + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
            + "<title>Pair link expired</title>"
            + "<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;"
            + "padding:24px;color:#1a1a1a;background:#fafafa}"
            + "h1{font-size:22px;margin:0 0 12px}p{margin:0 0 12px}"
            + "code{background:#eee;padding:2px 6px;border-radius:4px}</style></head>"
            + `<body><h1>Pair link expired</h1>`
            + `<p>This pairing link (<code>${reason}</code>) is no longer valid.</p>`
            + `<p>Re-run <code>fleetctl serve</code> on the laptop to generate a new one.</p>`
            + `</body></html>`,
          );
        }
        // Success: set the x-fleet-token cookie carrying the admin
        // token plaintext, then 302 to the SPA root with a
        // `pair_just_consumed=1` query so the PWA install hint can
        // surface immediately.
        res.writeHead(302, {
          "location": "/?pair_just_consumed=1",
          "set-cookie": `x-fleet-token=${encodeURIComponent(r.admin_token)}; Path=/; HttpOnly; SameSite=Lax`,
          "cache-control": "no-store",
        });
        return res.end();
      }
      // Ticket 0013: read-only shareable fleet snapshot.
      // GET /share/<token> renders an HTML page directly from the
      // snapshot row keyed by SHA-256(token). NO auth middleware —
      // the token IS the auth; presenting an unknown one yields 404,
      // a revoked or expired one yields 410. The page carries no
      // <button>, no /api/control/ string, no github.com anchor;
      // see serveShare() in src/snapshot.ts.
      const shm = path.match(/^\/share\/([0-9a-fA-F]+)$/);
      if (shm && req.method === "GET") {
        const result = serveShare(db, shm[1]);
        res.writeHead(result.status, result.headers);
        return res.end(result.body);
      }
      // Ticket 0041: public monthly fleet receipts.
      // GET /receipts/<slug>/<YYYY-MM> renders a self-contained
      // single-column HTML page from the frozen `receipts_published`
      // payload. NO auth middleware — the URL is intentionally
      // public; missing rows yield 404. The route is mounted here
      // alongside /share/<token> so it shares the no-token bypass
      // posture but never carries operator state. Per AC7 the
      // response sets Cache-Control: public, max-age=600.
      const rm = path.match(/^\/receipts\/([\w-]+)\/(\d{4}-\d{2})$/);
      if (rm && req.method === "GET") {
        const result = getReceiptsCached(db, rm[1], rm[2]);
        res.writeHead(result.status, result.headers);
        return res.end(result.body);
      }
      // static portal
      let file = path === "/" ? "index.html" : path.replace(/^\//, "");
      const full = join(WEB, file);
      if (!full.startsWith(WEB) || !existsSync(full)) { res.writeHead(404); return res.end("not found"); }
      // Ticket 0029: the service worker MUST be served with
      // `Service-Worker-Allowed: /` so its scope can extend to the site
      // root from /sw.js. Browsers reject a wider scope without this
      // header (defence against a SW registered from a subdir
      // intercepting the parent). The other static assets keep the
      // existing minimal header set.
      const headers: Record<string, string> = {
        "content-type": MIME[extname(full)] ?? "application/octet-stream",
      };
      if (path === "/sw.js") headers["service-worker-allowed"] = "/";
      res.writeHead(200, headers);
      res.end(readFileSync(full));
    } catch (e: any) {
      json(res, { error: String(e?.message ?? e) }, 500);
    }
  });

  server.listen(port, host, () => {
    if (!opts.quietBanner) {
      console.log(`fleet-control portal → http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
      if (host === "0.0.0.0") {
        // We deliberately never log a token here — mint one with
        //   `fleetctl tokens add <device-name> --scope <read|control|admin>`
        // which prints it ONCE so it's only on the operator's screen.
        console.log(`  LAN access enabled. Mint a token with: fleetctl tokens add <device-name> --scope read`);
      }
    }
    try { opts.onListening?.(); } catch { /* never let a banner crash the server */ }
  });
  return server;
}
