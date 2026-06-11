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
import { fleetView, projectView, runView, forecastFor, fleetLeaderboard, clampDays, fleetStreak, projectHealth, projectIdBySlug, projectBurndown, ticketShipReport, projectToolMix, clampToolMixDays, yesterdayGlance, costPerMergedPr, fridayWrap, isFriday, riskiestOpenPr, mondayCatchUp, isMonday, fleetChangelog, newSinceLastVisit, markSectionSeen, isValidNewSinceSection, lessonCreditRollup, lessonSavingsRollup, lessonSavingsByProject, spendEfficiencyRanking, stuckPrTaxonomy, prAutopsies, projectWorthItVerdict, projectWorthItSticky, fleetYearInReview, fleetMedianProjection, computeRoiProjection, fleetWeeklyPulse, type YesterdayGlance, type CostPerMergedPr, type FridayWrap, type RiskiestOpenPr, type MondayCatchUp, type FleetChangelog, type FleetChangelogOptions, type NewSinceLastVisitOptions, type LessonCreditRollup, type LessonSavingsRollup, type LessonSavingsRow, type LessonSavingsByProject, type LessonSavingsByProjectRow, type SpendEfficiencyRanking, type StuckPrTaxonomy, type PrAutopsies, type ProjectWorthItVerdict, type ProjectWorthItSticky, type FleetYearInReview, type FleetMedianProjection, type FleetWeeklyPulse } from "./views.ts";
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
  attributeHealsToLessons,
  lessonOfTheDay,
  type CrossLessonsLoadResult,
  type LessonOfTheDay,
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

// Ticket 0042: lesson credit ledger memo cache.
//
// 5-minute TTL keyed by the three-value tuple
// (window_days, latest_heal_audit_id, lessons_total) — either component
// moving invalidates the cache the moment the next request lands so a
// freshly-landed heal credit surfaces without waiting out the TTL.
// Per LESSONS § "in-process dedup sets need an explicit reset hook for
// tests" we expose `_resetLessonCreditCacheForTests()`. Per LESSONS §
// "expose a build counter for cache-hit tests, not a fetcher swap" we
// also expose a read-only `_getLessonCreditCacheBuildsForTests()` that
// ticks on every cache MISS so route tests can assert hit/miss
// semantics without stubbing SQL.
interface LessonCreditCacheEntry {
  tuple: string;
  value: LessonCreditRollup;
  expires_at: number;
}
const LESSON_CREDIT_TTL_MS = 300_000; // 5 minutes per the AC
const lessonCreditCache = new Map<string, LessonCreditCacheEntry>();
let lessonCreditBuildCounter = 0;

export function _resetLessonCreditCacheForTests(): void {
  lessonCreditCache.clear();
  lessonCreditBuildCounter = 0;
}

export function _getLessonCreditCacheBuildsForTests(): number {
  return lessonCreditBuildCounter;
}

interface LessonCreditLatestHealRow { id: number | null; }

/** Three-value cache-invalidation tuple. Cheap: both DB reads hit
 *  existing primary keys / indexes; the lessons-total read is a
 *  memoised parse (the lessons cache above). */
function lessonCreditInvalidationTuple(
  db: DB, windowDays: number, lessonsTotal: number,
): string {
  const latest = db.prepare(
    "SELECT MAX(id) AS id FROM control_audit WHERE action = 'heal'",
  ).get() as unknown as LessonCreditLatestHealRow | undefined;
  const id = Number(latest?.id ?? 0);
  return `w=${windowDays}|h=${id}|n=${lessonsTotal}`;
}

/** Look up a fresh lesson-credit rollup from the memo cache;
 *  attribute + rebuild on miss. The attribution step runs on the
 *  same tick as the rollup so a freshly-landed heal that pattern-
 *  matches a lesson gets credited inside the TTL without waiting for
 *  the daemon hook to fire. */
function getLessonCreditCached(
  db: DB, windowDays: number, parsed: CrossLessonsLoadResult, now: Date,
): LessonCreditRollup {
  const tuple = lessonCreditInvalidationTuple(db, windowDays, parsed.total);
  const hit = lessonCreditCache.get(tuple);
  if (hit && hit.expires_at > Date.now()) return hit.value;
  lessonCreditBuildCounter += 1;
  // Run the attributor on cache miss so newly-landed heals get
  // credited within the TTL. Skipped silently when the file is
  // missing/oversized — attributeHealsToLessons itself short-circuits
  // in those cases (same guard as the daemon hook).
  try {
    attributeHealsToLessons(db, parsed, now, { windowDays });
  } catch { /* keep serving — the rollup below will surface whatever is in the table */ }
  const value = lessonCreditRollup(db, now, { windowDays });
  lessonCreditCache.set(tuple, { tuple, value, expires_at: Date.now() + LESSON_CREDIT_TTL_MS });
  return value;
}

/** Parse + clamp the ?window=<days> query param. Defaults to 30;
 *  clamps to [1, 90]. Same shape as clampDays() in views.ts but
 *  inlined here so the route stays a one-liner. */
function clampLessonCreditWindow(raw: string | null): number {
  if (!raw) return 30;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 30;
  return Math.max(1, Math.min(90, n));
}

// Ticket 0052: lesson-pays-for-itself ledger memo cache.
//
// 15-minute TTL (matches Cache-Control: max-age=900 — the savings
// rollup moves on two signals: a fresh lesson_credit row OR a fresh
// failed run, and both are minute-scale in practice). Keyed by
// (windowDays, lessons_total). Invalidation tuple is FOUR-VALUE:
//
//   - lessonCreditMaxCreatedAt = SELECT MAX(created_at) FROM
//                                lesson_credit
//   - lessonCreditCount        = SELECT COUNT(*)        FROM
//                                lesson_credit
//   - runMaxEndedAt            = SELECT MAX(ended_at)   FROM run
//                                WHERE outcome = 'failure'
//   - runFailureCount          = SELECT COUNT(*)        FROM run
//                                WHERE outcome = 'failure'
//
// Per LESSONS 2026-06-07 "the `pr` table has no surrogate `id`; proxy
// 'latest landed' via (MAX(fetched_at), COUNT(*))": the lesson_credit
// table's PK is composite (lesson_slug, lesson_date, heal_audit_id)
// — NO surrogate id — so we proxy "fresh credit row landed" via the
// (MAX(created_at), COUNT(*)) pair. Either side moving busts the
// cache. The same shape applies to the failed-run signal.
//
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests" we expose `_resetLessonSavingsCacheForTests()`. Per
// LESSONS § "expose a build counter for cache-hit tests, not a
// fetcher swap" we also expose
// `_getLessonSavingsCacheBuildsForTests()` that ticks on every cache
// MISS so route tests can assert hit/miss semantics without stubbing
// SQL. Production code never reads either.
interface LessonSavingsCacheEntry {
  tuple: string;
  value: LessonSavingsRollup & { quiet_hours_active: boolean };
  expires_at: number;
}
const LESSON_SAVINGS_TTL_MS = 900_000; // 15 minutes per AC3.
const lessonSavingsCache = new Map<string, LessonSavingsCacheEntry>();
let lessonSavingsBuildCounter = 0;

export function _resetLessonSavingsCacheForTests(): void {
  lessonSavingsCache.clear();
  lessonSavingsBuildCounter = 0;
}

export function _getLessonSavingsCacheBuildsForTests(): number {
  return lessonSavingsBuildCounter;
}

interface LessonSavingsCreditTupleRow { mx: string | null; c: number | null; }
interface LessonSavingsFailedRunTupleRow { mx: string | null; c: number | null; }

function lessonSavingsInvalidationTuple(
  db: DB, windowDays: number, lessonsTotal: number,
): string {
  const credit = db.prepare(
    "SELECT MAX(created_at) AS mx, COUNT(*) AS c FROM lesson_credit",
  ).get() as unknown as LessonSavingsCreditTupleRow | undefined;
  const failed = db.prepare(
    "SELECT MAX(ended_at) AS mx, COUNT(*) AS c "
    + "  FROM run WHERE outcome = 'failure'",
  ).get() as unknown as LessonSavingsFailedRunTupleRow | undefined;
  const cmx = credit?.mx ?? "";
  const cc = Number(credit?.c ?? 0);
  const fmx = failed?.mx ?? "";
  const fc = Number(failed?.c ?? 0);
  return "w=" + windowDays + "|cmx=" + cmx + "|cc=" + cc
    + "|fmx=" + fmx + "|fc=" + fc + "|n=" + lessonsTotal;
}

/** Look up a fresh lesson-savings rollup from the memo cache;
 *  attribute + rebuild on miss. The attribution step runs on the
 *  same tick as the rollup so a freshly-landed heal that pattern-
 *  matches a lesson gets credited inside the TTL without waiting for
 *  the daemon hook to fire — same shape as getLessonCreditCached. */
function getLessonSavingsCached(
  db: DB, cfg: FleetConfig, windowDays: number,
  parsed: CrossLessonsLoadResult, now: Date,
): LessonSavingsRollup & { quiet_hours_active: boolean } {
  const tuple = lessonSavingsInvalidationTuple(db, windowDays, parsed.total);
  const hit = lessonSavingsCache.get(String(windowDays));
  if (hit && hit.tuple === tuple && hit.expires_at > Date.now()) return hit.value;
  lessonSavingsBuildCounter += 1;
  try {
    attributeHealsToLessons(db, parsed, now, { windowDays });
  } catch { /* keep serving — the rollup will surface whatever is in the table */ }
  const inner = lessonSavingsRollup(db, { now, windowDays });
  const quiet = quietHoursActiveAnywhere(cfg, now);
  const value = { ...inner, quiet_hours_active: quiet };
  lessonSavingsCache.set(String(windowDays), {
    tuple, value, expires_at: Date.now() + LESSON_SAVINGS_TTL_MS,
  });
  return value;
}

/** Cache-invalidation hook fired from `runIngestPass` (after the
 *  ingest pass COMMITs) AND from `attributeHealsToLessons` (after a
 *  non-zero lesson_credit insert). The cycle-break is registered on
 *  `globalThis.__fleet_lesson_savings_invalidate__` so the producer
 *  modules (ingest/index.ts, lessons.ts) don't have to import
 *  server.ts (which would deadlock — server.ts already imports both).
 *  Per LESSONS 2026-06-05 "break ingest↔server cache-invalidation
 *  cycles via a globalThis slot, not a circular import". */
export function _invalidateLessonSavingsCacheAfterIngest(): void {
  lessonSavingsCache.clear();
}

(globalThis as { __fleet_lesson_savings_invalidate__?: () => void })
  .__fleet_lesson_savings_invalidate__ = _invalidateLessonSavingsCacheAfterIngest;

// Ticket 0056 — per-project lesson-savings memo cache.
//
// 15-minute TTL (matches the parent 0052 savings cache — the per-
// project rollup composes the SAME lesson_credit / failed-run signals,
// so the TTL and invalidation tuple match shape). Keyed by
// (windowDays, hourlyRateUsd, lessonsCreditCount). Invalidation is
// FIVE-VALUE per the spec's literal wording:
//
//   - date(now) UTC               — rolls over at midnight UTC so the
//                                   "this month" / "last 30 days"
//                                   framing doesn't bleed across days
//                                   inside the TTL.
//   - MAX(lesson_credit.created_at) — a fresh credit may re-rank.
//   - COUNT(*) FROM lesson_credit  — composite-PK proxy (no surrogate
//                                   id on lesson_credit per LESSONS
//                                   2026-06-07).
//   - MAX(run.ended_at)            — a fresh failed run shifts the
//                                   average-failed-ship-cost.
//   - COUNT(*) FROM run WHERE outcome='failure' — same proxy on the
//                                   failed-run signal.
//
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests" we expose `_resetLessonSavingsByProjectCacheForTests()`.
// Per LESSONS § "expose a build counter for cache-hit tests, not a
// fetcher swap" we also expose
// `_getLessonSavingsByProjectCacheBuildsForTests()` that ticks on
// every cache MISS so route tests can assert hit/miss semantics
// without stubbing SQL. Production code never reads either.
interface LessonSavingsByProjectCacheEntry {
  tuple: string;
  value: LessonSavingsByProject;
  expires_at: number;
}
const LESSON_SAVINGS_BY_PROJECT_TTL_MS = 900_000; // 15 minutes per the AC.
const lessonSavingsByProjectCache = new Map<string, LessonSavingsByProjectCacheEntry>();
let lessonSavingsByProjectBuildCounter = 0;

export function _resetLessonSavingsByProjectCacheForTests(): void {
  lessonSavingsByProjectCache.clear();
  lessonSavingsByProjectBuildCounter = 0;
}

export function _getLessonSavingsByProjectCacheBuildsForTests(): number {
  return lessonSavingsByProjectBuildCounter;
}

interface LessonSavingsByProjectTupleRow { mx: string | null; c: number | null; }

function lessonSavingsByProjectInvalidationTuple(
  db: DB, windowDays: number, hourlyRateUsd: number, now: Date,
): string {
  const credit = db.prepare(
    "SELECT MAX(created_at) AS mx, COUNT(*) AS c FROM lesson_credit",
  ).get() as unknown as LessonSavingsByProjectTupleRow | undefined;
  const failed = db.prepare(
    "SELECT MAX(ended_at) AS mx, COUNT(*) AS c "
    + "  FROM run WHERE outcome = 'failure'",
  ).get() as unknown as LessonSavingsByProjectTupleRow | undefined;
  const cmx = credit?.mx ?? "";
  const cc = Number(credit?.c ?? 0);
  const fmx = failed?.mx ?? "";
  const fc = Number(failed?.c ?? 0);
  const utcDay = now.toISOString().slice(0, 10);
  return "d=" + utcDay + "|w=" + windowDays + "|r=" + hourlyRateUsd
    + "|cmx=" + cmx + "|cc=" + cc + "|fmx=" + fmx + "|fc=" + fc;
}

/** Strip token-shaped substrings from `project_name` VALUES on the
 *  per-project rollup BEFORE the rollup is JSON-encoded. Per LESSONS
 *  2026-06-10 "redactSecrets on a JSON body shreds your KEYS": we
 *  scrub VALUES, never the body string. project_name originates from
 *  operator-supplied repo metadata (the `project.name` column is
 *  populated by the ingester from `agents.config.sh` / `gh repo
 *  view`) — defence-in-depth at the rollup boundary. The numeric
 *  fields (saved_usd, saved_hours, lesson_count) and the project_slug
 *  pass through unchanged. */
function redactLessonSavingsByProject(
  rollup: LessonSavingsByProject,
): LessonSavingsByProject {
  const out: Record<string, LessonSavingsByProjectRow> = {};
  for (const slug of Object.keys(rollup.by_project)) {
    const row = rollup.by_project[slug];
    out[slug] = {
      ...row,
      project_name: redactSecretsForLessonSavings(row.project_name),
      project_slug: redactSecretsForLessonSavings(row.project_slug),
    };
  }
  return {
    window_days: rollup.window_days,
    generated_at: rollup.generated_at,
    hourly_rate_usd: rollup.hourly_rate_usd,
    by_project: out,
  };
}

/** Look up a fresh per-project lesson-savings rollup from the memo
 *  cache; rebuild on miss. The build counter ticks on every miss so
 *  route tests can assert hit/miss semantics without stubbing SQL.
 *  Per LESSONS 2026-06-10 "redactSecrets on a JSON body shreds your
 *  KEYS": project_name VALUES are scrubbed BEFORE the rollup is
 *  serialised into /api/fleet — at the route boundary, not on the
 *  body string. */
function getLessonSavingsByProjectCached(
  db: DB, cfg: FleetConfig, now: Date,
): LessonSavingsByProject {
  const { rate } = worthItResolvedKnobs(cfg);
  const windowDays = 30;
  const tuple = lessonSavingsByProjectInvalidationTuple(db, windowDays, rate, now);
  const cacheKey = "w=" + windowDays + "|r=" + rate;
  const hit = lessonSavingsByProjectCache.get(cacheKey);
  if (hit && hit.tuple === tuple && hit.expires_at > Date.now()) return hit.value;
  lessonSavingsByProjectBuildCounter += 1;
  const inner = lessonSavingsByProject(db, { now, windowDays, hourlyRateUsd: rate });
  const value = redactLessonSavingsByProject(inner);
  lessonSavingsByProjectCache.set(cacheKey, {
    tuple, value, expires_at: Date.now() + LESSON_SAVINGS_BY_PROJECT_TTL_MS,
  });
  return value;
}

/** Cache-invalidation hook fired from `runIngestPass` (after the
 *  ingest pass COMMITs) AND from `attributeHealsToLessons` (after a
 *  non-zero lesson_credit insert). Registered on the globalThis slot
 *  per LESSONS 2026-06-05 "break ingest↔server cache-invalidation
 *  cycles via a globalThis slot, not a circular import". */
export function _invalidateLessonSavingsByProjectCacheAfterIngest(): void {
  lessonSavingsByProjectCache.clear();
}

(globalThis as { __fleet_lesson_savings_by_project_invalidate__?: () => void })
  .__fleet_lesson_savings_by_project_invalidate__ = _invalidateLessonSavingsByProjectCacheAfterIngest;

/** Renderer-direct test seam (ticket 0056 AC7) for the per-card
 *  time-saved line. Mirrors `formatHoursSaved()` + the wrapping
 *  anchor / span the SPA emits in `web/app.js`. The seam is exported
 *  from this file (rather than imported from web/app.js, which is
 *  vanilla JS the bundler-less SPA consumes directly) because:
 *
 *  - Per LESSONS 2026-06-11 "startServer() tests that mutate
 *    fleet-control.config.json race against parallel test files":
 *    driving the quiet-hours branch via a non-default config.json in
 *    cwd causes test-file collisions across the suite. The
 *    renderer-direct seam exposes the branch deterministically — zero
 *    cwd mutation, zero HTTP, zero race.
 *
 *  - The SPA's `formatHoursSaved()` is identical text shape to this
 *    helper; the AC7 grep over web/app.js asserts the SPA also carries
 *    the same copy literals ("this month", "last 30 days", "fleet is
 *    still learning"), so a future drift between the SPA renderer and
 *    this seam shows up as a failing AC5 / AC7 grep before it can
 *    silently diverge.
 *
 *  Production code never calls this function — it exists only for
 *  the test suite. The leading underscore + `ForTests` suffix matches
 *  the `_reset…ForTests` convention used elsewhere in the repo. */
export function _renderTimeSavedLineForTests(
  saved_hours: number,
  slug: string,
  quietHoursActive: boolean,
): string {
  const safeSlug = String(slug ?? "")
    .replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  if (!Number.isFinite(saved_hours) || saved_hours <= 0) {
    const empty = quietHoursActive
      ? "lessons have saved you 0h over the last 30 days — fleet is still learning"
      : "lessons saving you 0h this month — fleet is still learning";
    return "<span class=\"project-card-time-saved project-card-time-saved-empty\""
      + " data-testid=\"project-card-time-saved-empty-" + safeSlug + "\">"
      + empty + "</span>";
  }
  const hours = (Math.round(saved_hours * 10) / 10).toFixed(1);
  const framing = quietHoursActive ? "over the last 30 days" : "this month";
  return "<a class=\"project-card-time-saved\" href=\"/lessons?project=" + safeSlug + "\""
    + " data-testid=\"project-card-time-saved-" + safeSlug + "\">"
    + "~" + hours + "h saved " + framing + "</a>";
}

// Ticket 0055: lesson-of-the-day memo cache.
//
// Keyed by the four-value invalidation tuple:
//   - date(now) in UTC  — rolls over at midnight UTC so a 9am visit
//                         doesn't reuse the previous day's tip.
//   - MAX(created_at) FROM lesson_credit — a fresh credit may re-rank.
//   - COUNT(*)        FROM lesson_credit — same composite-PK proxy.
//   - mtime(lessons-file) — a fresh `fleet lessons-sync` writes the
//                         file; the next call must re-parse.
//
// Per LESSONS 2026-06-07 "the `pr` table has no surrogate `id`; proxy
// 'latest landed' via (MAX(fetched_at), COUNT(*))": the lesson_credit
// table is composite-PK too — we use the same (MAX, COUNT) pair.
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests" we expose `_resetLessonOfTheDayCacheForTests()`. Per
// LESSONS § "expose a build counter for cache-hit tests, not a
// fetcher swap" we also expose
// `_getLessonOfTheDayCacheBuildsForTests()` that ticks on every cache
// MISS. Production code never reads either.
interface LessonOfTheDayCacheEntry {
  tuple: string;
  value: LessonOfTheDay | null;
  built_at: number;
}
const lessonOfTheDayCache = new Map<string, LessonOfTheDayCacheEntry>();
let lessonOfTheDayBuildCounter = 0;

export function _resetLessonOfTheDayCacheForTests(): void {
  lessonOfTheDayCache.clear();
  lessonOfTheDayBuildCounter = 0;
}

export function _getLessonOfTheDayCacheBuildsForTests(): number {
  return lessonOfTheDayBuildCounter;
}

interface LessonOfTheDayCreditTupleRow { mx: string | null; c: number | null; }

function lessonOfTheDayInvalidationTuple(db: DB, lessonsPath: string, now: Date): string {
  const credit = db.prepare(
    "SELECT MAX(created_at) AS mx, COUNT(*) AS c FROM lesson_credit",
  ).get() as unknown as LessonOfTheDayCreditTupleRow | undefined;
  let mtimeMs = 0;
  try { mtimeMs = statSync(lessonsPath).mtimeMs; } catch { mtimeMs = 0; }
  const utcDay = now.toISOString().slice(0, 10);
  const cmx = credit?.mx ?? "";
  const cc = Number(credit?.c ?? 0);
  return "d=" + utcDay + "|cmx=" + cmx + "|cc=" + cc + "|m=" + mtimeMs;
}

/** Look up a fresh lesson-of-the-day pick from the memo cache; rebuild
 *  on miss. The build counter ticks on every miss so route tests can
 *  assert hit/miss semantics without stubbing SQL. */
function getLessonOfTheDayCached(db: DB, now: Date): LessonOfTheDay | null {
  const lessonsPath = defaultLessonsPath();
  const tuple = lessonOfTheDayInvalidationTuple(db, lessonsPath, now);
  const hit = lessonOfTheDayCache.get("v1");
  if (hit && hit.tuple === tuple) return hit.value;
  lessonOfTheDayBuildCounter += 1;
  const value = lessonOfTheDay(db, { now });
  lessonOfTheDayCache.set("v1", { tuple, value, built_at: Date.now() });
  return value;
}

/** Cache-invalidation hook fired from `runIngestPass` (after the
 *  ingest pass COMMITs) AND from `attributeHealsToLessons` (after a
 *  non-zero lesson_credit insert). Registered on the globalThis slot
 *  per LESSONS 2026-06-05 "break ingest↔server cache-invalidation
 *  cycles via a globalThis slot, not a circular import". */
export function _invalidateLessonOfTheDayCacheAfterIngest(): void {
  lessonOfTheDayCache.clear();
}

(globalThis as { __fleet_lesson_of_the_day_invalidate__?: () => void })
  .__fleet_lesson_of_the_day_invalidate__ = _invalidateLessonOfTheDayCacheAfterIngest;

/** Strip token-shaped substrings from operator-visible STRING VALUES
 *  on the lesson-of-the-day pick BEFORE the payload is JSON-encoded.
 *  Same posture as `redactSecretsForLessonSavings`: scrub the values,
 *  NOT the body string — per LESSONS 2026-06-10 "redactSecrets on a
 *  JSON body shreds your KEYS". The token-shape heuristic gates on
 *  `\d` (a real digit) so JSON keys like `total_lessons_indexed` (22
 *  chars, letters + underscores only) survive intact. */
function redactSecretsForLessonOfTheDay(s: string): string {
  let out = String(s ?? "");
  out = out.replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-pat>");
  out = out.replace(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?/g, "<redacted-repo-url>");
  out = out.replace(/\b[A-Za-z0-9_]{24,}\b/g, (match) => {
    const hasLetter = /[A-Za-z]/.test(match);
    const hasDigit = /\d/.test(match);
    return hasLetter && hasDigit ? "<redacted>" : match;
  });
  return out;
}

/** Apply the renderer-boundary redactor to every operator-supplied
 *  string field on the lesson-of-the-day pick. Numeric + structural
 *  fields stay byte-identical; only the upstream-data values
 *  (lesson_slug / lesson_date / lesson_title / lesson_excerpt) get
 *  the scrub. Returns null untouched. */
function redactLessonOfTheDayPick(
  pick: LessonOfTheDay | null,
): LessonOfTheDay | null {
  if (!pick) return null;
  return {
    ...pick,
    lesson_slug: redactSecretsForLessonOfTheDay(pick.lesson_slug),
    lesson_date: redactSecretsForLessonOfTheDay(pick.lesson_date),
    lesson_title: redactSecretsForLessonOfTheDay(pick.lesson_title),
    lesson_excerpt: redactSecretsForLessonOfTheDay(pick.lesson_excerpt),
  };
}

/** Clamp the ?window=<days> query param for the savings route.
 *  Defaults to 90 per the ticket spec; clamps to [1, 365] so the
 *  operator can ask for a full-year view if they want. */
function clampLessonSavingsWindow(raw: string | null): number {
  if (!raw) return 90;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 90;
  return Math.max(1, Math.min(365, n));
}

/** Strip token-shaped substrings from individual operator-visible
 *  STRING VALUES embedded in the savings rollup (lesson_title,
 *  matched_substring, etc.) BEFORE the rollup is JSON-encoded. We do
 *  the scrub on the values, not on the JSON body string, because a
 *  whole-body sweep would happily match long JSON KEY names (e.g.
 *  `average_failed_ship_cost_usd` is 27 chars with letters+`_`) and
 *  shred the shape. Same character classes as src/receipts.ts §
 *  redactSecrets — defence-in-depth at the renderer boundary per
 *  LESSONS § "defence-in-depth secret redaction at the renderer
 *  boundary". A lesson title or matched_substring drawn from an
 *  upstream heal stdout tail can in theory carry a leaked token;
 *  this is the chokepoint. */
function redactSecretsForLessonSavings(s: string): string {
  let out = String(s ?? "");
  out = out.replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-pat>");
  out = out.replace(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?/g, "<redacted-repo-url>");
  // Long alphanumeric (token-shaped) runs that mix letters AND digits
  // (NOT just letters + underscores — JSON keys like
  // `average_failed_ship_cost_usd` are letters-and-underscores ONLY
  // and must survive the scrub). The `\d` check is what gates this
  // — a real underscore-separated JSON key has no digits.
  out = out.replace(/\b[A-Za-z0-9_]{24,}\b/g, (match) => {
    const hasLetter = /[A-Za-z]/.test(match);
    const hasDigit = /\d/.test(match);
    return hasLetter && hasDigit ? "<redacted>" : match;
  });
  return out;
}

/** Apply the renderer-boundary redactor to every operator-supplied
 *  string field on the rollup. The keys + the numeric fields stay
 *  byte-identical; only the values that originate in upstream data
 *  (lesson_title, lesson_slug, lesson_date) get the scrub. */
function redactLessonSavingsRollup<
  T extends LessonSavingsRollup & { quiet_hours_active?: boolean },
>(rollup: T): T {
  return {
    ...rollup,
    lesson_savings: rollup.lesson_savings.map((row) => ({
      ...row,
      lesson_slug: redactSecretsForLessonSavings(row.lesson_slug),
      lesson_date: redactSecretsForLessonSavings(row.lesson_date),
      lesson_title: redactSecretsForLessonSavings(row.lesson_title),
    })),
  };
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

// Ticket 0044: "Spend-efficiency ranking" memo cache.
//
// 15-min TTL (matches Cache-Control: max-age=900 — the median moves
// slowly; the laggard rarely flips within a 15-min window). The cache
// is invalidated by a three-value tuple computed BEFORE the main query:
//
//   - windowDays              = the resolved ?window= value
//   - latestRunId             = SELECT MAX(id) FROM run
//   - latestMergedFetch       = SELECT MAX(fetched_at), COUNT(*) FROM
//                               pr WHERE state='MERGED' AND is_agent=1
//
// The `pr` table has no surrogate id (PK is (project_id, number)) so
// we proxy "latest merged PR landed" via MAX(fetched_at) + COUNT(*) —
// either signal moving (a fresh sync OR an additional row) busts the
// cache. Any tuple component moving (a fresh run, a fresh merge, or
// the operator changing the window) busts the cache the moment the
// next request arrives — no poll-the-full-result required. Per LESSONS §
// "in-process dedup sets need an explicit reset hook for tests" we
// expose `_resetSpendEfficiencyCacheForTests()`. Per LESSONS § "expose
// a build counter for cache-hit tests, not a fetcher swap" we also
// expose a read-only `_getSpendEfficiencyCacheBuildsForTests()` that
// ticks on every cache MISS so route tests assert hit/miss semantics
// without stubbing SQL. Production code never reads either.
interface SpendEfficiencyCacheEntry {
  tuple: string;
  value: SpendEfficiencyRanking & { quiet_hours_active: boolean };
  expires_at: number;
}
const SPEND_EFFICIENCY_TTL_MS = 900_000;
const spendEfficiencyCache = new Map<string, SpendEfficiencyCacheEntry>();
let spendEfficiencyBuildCounter = 0;

export function _resetSpendEfficiencyCacheForTests(): void {
  spendEfficiencyCache.clear();
  spendEfficiencyBuildCounter = 0;
}

export function _getSpendEfficiencyCacheBuildsForTests(): number {
  return spendEfficiencyBuildCounter;
}

interface SpendEffMaxRunRow { x: number | null; }
interface SpendEffMergedPrSummaryRow { mx: string | null; c: number | null; }

function spendEfficiencyInvalidationTuple(db: DB, windowDays: number): string {
  const runRow = db.prepare(
    "SELECT MAX(id) AS x FROM run",
  ).get() as unknown as SpendEffMaxRunRow | undefined;
  // The pr table has no surrogate id (PK is (project_id, number)) so
  // we proxy "fresh merge landed" via the (MAX(fetched_at), COUNT(*))
  // pair — either moving busts the cache.
  const prRow = db.prepare(
    "SELECT MAX(fetched_at) AS mx, COUNT(*) AS c "
    + "  FROM pr WHERE state = 'MERGED' AND is_agent = 1",
  ).get() as unknown as SpendEffMergedPrSummaryRow | undefined;
  const r = Number(runRow?.x ?? 0);
  const mx = prRow?.mx ?? "";
  const c = Number(prRow?.c ?? 0);
  return `${windowDays}|${r}|${mx}|${c}`;
}

function getSpendEfficiencyCached(
  db: DB, cfg: FleetConfig, now: Date, windowDays: number,
): SpendEfficiencyRanking & { quiet_hours_active: boolean } {
  const tuple = spendEfficiencyInvalidationTuple(db, windowDays);
  const hit = spendEfficiencyCache.get(String(windowDays));
  if (hit && hit.tuple === tuple && hit.expires_at > Date.now()) {
    return hit.value;
  }
  spendEfficiencyBuildCounter += 1;
  const quiet = quietHoursActiveAnywhere(cfg, now);
  const inner = spendEfficiencyRanking(db, now, { windowDays });
  // Surface quiet_hours_active in the payload so the SPA can hide the
  // "look here" call-to-action overnight per AC9 (the 0030 pull-vs-
  // push contract: information visible, action suppressed).
  const value = { ...inner, quiet_hours_active: quiet };
  spendEfficiencyCache.set(String(windowDays), {
    tuple, value, expires_at: Date.now() + SPEND_EFFICIENCY_TTL_MS,
  });
  return value;
}

// Ticket 0045: "Stuck-PR taxonomy" memo cache.
//
// 30s TTL (matches Cache-Control: max-age=30 — any of the seven
// inputs can shift the verdict on the next tick). The cache is
// invalidated by a THREE-VALUE tuple:
//
//   - openPrMaxFetchedAt = SELECT MAX(fetched_at) FROM pr
//                           WHERE state='open' AND is_agent=1
//   - openPrCount        = SELECT COUNT(*)        FROM pr
//                           WHERE state='open' AND is_agent=1
//   - latestHealTs       = SELECT MAX(ts)         FROM control_audit
//                           WHERE action='heal'
//
// The `pr` table has no surrogate id (PK is (project_id, number)) so
// we proxy "fresh open-PR row landed" via the (MAX(fetched_at),
// COUNT(*)) pair (per LESSONS 2026-06-07 "the `pr` table has no
// surrogate id; proxy 'latest landed' via (MAX(fetched_at), COUNT(*))")
// — either side moving busts the cache. The third tuple value
// captures every new heal-audit row, so a fresh heal (which can
// shift a PR from ci_red to needs_human) also busts the cache.
//
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests" we expose `_resetStuckPrTaxonomyCacheForTests()`. Per
// LESSONS § "expose a build counter for cache-hit tests, not a
// fetcher swap" we also expose
// `_getStuckPrTaxonomyCacheBuildsForTests()`; it ticks on every
// cache MISS so route tests assert hit/miss semantics without
// stubbing SQL. Production code never reads either.
interface StuckPrTaxonomyCacheEntry {
  tuple: string;
  value: StuckPrTaxonomy & { quiet_hours_active: boolean };
  expires_at: number;
}
const STUCK_PR_TAXONOMY_TTL_MS = 30_000;
let stuckPrTaxonomyCache: StuckPrTaxonomyCacheEntry | null = null;
let stuckPrTaxonomyBuildCounter = 0;

export function _resetStuckPrTaxonomyCacheForTests(): void {
  stuckPrTaxonomyCache = null;
  stuckPrTaxonomyBuildCounter = 0;
}

export function _getStuckPrTaxonomyCacheBuildsForTests(): number {
  return stuckPrTaxonomyBuildCounter;
}

interface StuckPrOpenSummaryRow { mx: string | null; c: number | null; }
interface StuckPrLatestHealRow { t: string | null; }

function stuckPrTaxonomyInvalidationTuple(db: DB): string {
  const openRow = db.prepare(
    "SELECT MAX(fetched_at) AS mx, COUNT(*) AS c "
    + "  FROM pr WHERE state = 'open' AND is_agent = 1",
  ).get() as unknown as StuckPrOpenSummaryRow | undefined;
  const healRow = db.prepare(
    "SELECT MAX(ts) AS t FROM control_audit WHERE action = 'heal'",
  ).get() as unknown as StuckPrLatestHealRow | undefined;
  const mx = openRow?.mx ?? "";
  const c = Number(openRow?.c ?? 0);
  const t = healRow?.t ?? "";
  return `${mx}|${c}|${t}`;
}

function getStuckPrTaxonomyCached(
  db: DB, cfg: FleetConfig, now: Date,
): StuckPrTaxonomy & { quiet_hours_active: boolean } {
  const tuple = stuckPrTaxonomyInvalidationTuple(db);
  if (
    stuckPrTaxonomyCache
    && stuckPrTaxonomyCache.tuple === tuple
    && stuckPrTaxonomyCache.expires_at > Date.now()
  ) {
    return stuckPrTaxonomyCache.value;
  }
  stuckPrTaxonomyBuildCounter += 1;
  const quiet = quietHoursActiveAnywhere(cfg, now);
  const inner = stuckPrTaxonomy(db, now);
  // Surface quiet_hours_active in the payload so the SPA can hide the
  // infra_flake / merging / healthy_waiting rows overnight per AC6
  // (the 0030 pull-vs-push contract: information visible, noise
  // demoted — the action-urgent rows still render).
  const value = { ...inner, quiet_hours_active: quiet };
  stuckPrTaxonomyCache = {
    tuple, value, expires_at: Date.now() + STUCK_PR_TAXONOMY_TTL_MS,
  };
  return value;
}

// Ticket 0047: "PR autopsy card" memo cache.
//
// 10-min TTL (matches Cache-Control: max-age=600 — autopsies are
// historical and only change when a PR closes). The cache is
// invalidated by a THREE-VALUE tuple:
//
//   - windowDays         = the route's ?window= parameter (per-window
//                          cache row so the operator can flip between
//                          7d / 30d without polluting either entry)
//   - latestClosedAt     = SELECT MAX(closed_at) FROM pr
//                          WHERE state='CLOSED'
//   - closedCountInWin   = SELECT COUNT(*)       FROM pr
//                          WHERE state='CLOSED' AND
//                                closed_at >= now - windowDays days
//
// The `pr` table has no surrogate id (PK is (project_id, number)) so
// we proxy "fresh closed-PR row landed" via the (MAX(closed_at),
// COUNT(*)) pair per LESSONS 2026-06-07 "the `pr` table has no
// surrogate `id`; proxy 'latest landed' via (MAX(fetched_at),
// COUNT(*))" — the same pattern the spend-efficiency cache uses for
// merges. Either side moving busts the cache the moment the next
// request arrives.
//
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests" we expose `_resetPrAutopsiesCacheForTests()`. Per
// LESSONS § "expose a build counter for cache-hit tests, not a
// fetcher swap" we also expose
// `_getPrAutopsiesCacheBuildsForTests()`; it ticks on every cache
// MISS so route tests assert hit/miss semantics without stubbing
// SQL. Production code never reads either.
//
// Per LESSONS 2026-06-05 "break ingest↔server cache-invalidation
// cycles via a globalThis slot, not a circular import": the ingest
// pass (`runIngestPass` in src/ingest/index.ts) calls a hook
// registered on `globalThis.__fleet_pr_autopsies_invalidate__` so a
// freshly-closed PR clears the cache without waiting out the TTL.
// The slot is registered below at module load time and read lazily
// by the ingest module — same shape as the 0039 changelog hook.
interface PrAutopsiesCacheEntry {
  tuple: string;
  value: PrAutopsies & { quiet_hours_active: boolean };
  expires_at: number;
}
const PR_AUTOPSIES_TTL_MS = 600_000;
const prAutopsiesCache = new Map<string, PrAutopsiesCacheEntry>();
let prAutopsiesBuildCounter = 0;

export function _resetPrAutopsiesCacheForTests(): void {
  prAutopsiesCache.clear();
  prAutopsiesBuildCounter = 0;
}

export function _getPrAutopsiesCacheBuildsForTests(): number {
  return prAutopsiesBuildCounter;
}

interface PrAutopsiesClosedSummaryRow {
  mx: string | null;
  c: number | null;
}

function prAutopsiesInvalidationTuple(db: DB, windowDays: number, now: Date): string {
  // MAX(closed_at) over ALL closed rows: catches the case where the
  // same row's closed_at advances (a re-close after re-open scenario).
  const latestRow = db.prepare(
    "SELECT MAX(closed_at) AS mx FROM pr "
    + " WHERE state = 'CLOSED' AND closed_at IS NOT NULL",
  ).get() as unknown as PrAutopsiesClosedSummaryRow | undefined;
  // COUNT(*) over closed rows IN WINDOW: catches a new row that
  // happens to share the same MAX(closed_at).
  const cutoffIso = new Date(now.getTime() - windowDays * 86400_000).toISOString();
  const countRow = db.prepare(
    "SELECT COUNT(*) AS c FROM pr "
    + " WHERE state = 'CLOSED' AND closed_at IS NOT NULL "
    + "   AND closed_at >= ?",
  ).get(cutoffIso) as unknown as PrAutopsiesClosedSummaryRow | undefined;
  const mx = latestRow?.mx ?? "";
  const c = Number(countRow?.c ?? 0);
  return `${windowDays}|${mx}|${c}`;
}

function getPrAutopsiesCached(
  db: DB, cfg: FleetConfig, now: Date, windowDays: number,
): PrAutopsies & { quiet_hours_active: boolean } {
  const tuple = prAutopsiesInvalidationTuple(db, windowDays, now);
  const key = String(windowDays);
  const hit = prAutopsiesCache.get(key);
  if (hit && hit.tuple === tuple && hit.expires_at > Date.now()) {
    return hit.value;
  }
  prAutopsiesBuildCounter += 1;
  const quiet = quietHoursActiveAnywhere(cfg, now);
  const inner = prAutopsies(db, now, { windowDays });
  // Surface quiet_hours_active in the payload so the SPA can hide
  // the [draft entry →] tap-target overnight per AC11 (the 0030
  // pull-vs-push contract: information visible, action prompt
  // suppressed). The verdict + draft-skeleton are still computed
  // server-side so a re-render at 6am has the data ready.
  const value = { ...inner, quiet_hours_active: quiet };
  prAutopsiesCache.set(key, {
    tuple, value, expires_at: Date.now() + PR_AUTOPSIES_TTL_MS,
  });
  return value;
}

/** Clear the autopsies memo so the next request rebuilds. Called by
 *  the ingest pass via the globalThis slot below — the changelog
 *  cache invalidator's pattern (registered at module load), so the
 *  ingest module never imports server.ts. */
export function _invalidatePrAutopsiesCacheAfterIngest(): void {
  prAutopsiesCache.clear();
}

// Register the autopsy invalidation hook on the global object so
// `runIngestPass` (in src/ingest/index.ts) can call it without
// importing this module (which would create a cycle — server.ts
// imports runIngestPass at the top). Per LESSONS 2026-06-05 the
// slot is suffix-prefix'd with underscores to avoid collisions.
(globalThis as { __fleet_pr_autopsies_invalidate__?: () => void })
  .__fleet_pr_autopsies_invalidate__ = _invalidatePrAutopsiesCacheAfterIngest;

// Ticket 0048: "Per-project worth-it verdict" memo cache.
//
// 15-min TTL (matches Cache-Control: max-age=900 — the verdict moves
// slowly; same window as 0044's spend-efficiency). The cache is
// keyed per-project per-(window, rate, hours) so a global rate change
// or per-call override doesn't collide with the default-knob cache
// row. Invalidation is a THREE-VALUE per-project tuple:
//
//   - latestPrFetchedAt = SELECT MAX(fetched_at) FROM pr WHERE project_id = ?
//   - prRowCount        = SELECT COUNT(*)        FROM pr WHERE project_id = ?
//   - latestRunEndedAt  = SELECT MAX(ended_at)   FROM run WHERE project_id = ?
//
// The `pr` table has no surrogate id (PK is (project_id, number)) so
// we proxy "fresh pr row landed for this project" via the
// (MAX(fetched_at), COUNT(*)) pair per LESSONS 2026-06-07. Any of the
// three moving busts the cache on the next call.
//
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests" we expose `_resetWorthItCacheForTests()`. Per LESSONS §
// "expose a build counter for cache-hit tests, not a fetcher swap"
// we also expose `_getWorthItCacheBuildsForTests()`; it ticks on
// every cache MISS so route tests assert hit/miss semantics without
// stubbing SQL. Production code never reads either.
//
// Per LESSONS 2026-06-05 "break ingest↔server cache-invalidation
// cycles via a globalThis slot, not a circular import": the ingest
// pass calls a hook registered on `globalThis.__fleet_worth_it_invalidate__`
// so a fresh PR ingest tick clears the cache without waiting out the TTL.
// The slot is registered below at module load time and read lazily
// by the ingest module — same shape as the 0039 changelog hook and
// 0047 autopsy hook.
interface WorthItCacheEntry {
  tuple: string;
  value: ProjectWorthItVerdict;
  expires_at: number;
}
const WORTH_IT_TTL_MS = 900_000;
const worthItCache = new Map<string, WorthItCacheEntry>();
let worthItBuildCounter = 0;

export function _resetWorthItCacheForTests(): void {
  worthItCache.clear();
  worthItBuildCounter = 0;
}

export function _getWorthItCacheBuildsForTests(): number {
  return worthItBuildCounter;
}

interface WorthItPrSummaryRow { mx: string | null; c: number | null; }
interface WorthItRunSummaryRow { mx: string | null; }

function worthItInvalidationTuple(db: DB, projectId: number): string {
  const prRow = db.prepare(
    "SELECT MAX(fetched_at) AS mx, COUNT(*) AS c "
    + "  FROM pr WHERE project_id = ?",
  ).get(projectId) as unknown as WorthItPrSummaryRow | undefined;
  const runRow = db.prepare(
    "SELECT MAX(ended_at) AS mx FROM run WHERE project_id = ?",
  ).get(projectId) as unknown as WorthItRunSummaryRow | undefined;
  const mx = prRow?.mx ?? "";
  const c = Number(prRow?.c ?? 0);
  const rmx = runRow?.mx ?? "";
  return `${mx}|${c}|${rmx}`;
}

function worthItCacheKey(
  slug: string, windowDays: number, rate: number, hours: number,
): string {
  return `${slug}|w=${windowDays}|r=${rate}|h=${hours}`;
}

function getWorthItCached(
  db: DB, cfg: FleetConfig, now: Date,
  projectId: number, slug: string, windowDays: number,
  rate: number, hours: number,
): ProjectWorthItVerdict {
  void cfg; // resolution happens inside the helper via opts; here we
  // pass the explicit numbers through so the cache key matches the
  // shape of the computed value (no implicit dependence on the
  // ambient config).
  const tuple = worthItInvalidationTuple(db, projectId);
  const key = worthItCacheKey(slug, windowDays, rate, hours);
  const hit = worthItCache.get(key);
  if (hit && hit.tuple === tuple && hit.expires_at > Date.now()) {
    return hit.value;
  }
  worthItBuildCounter += 1;
  const value = projectWorthItVerdict(db, projectId, now, {
    windowDays,
    humanEquivalentHourlyUsd: rate,
    humanHoursPerPr: hours,
  });
  worthItCache.set(key, { tuple, value, expires_at: Date.now() + WORTH_IT_TTL_MS });
  return value;
}

/** Clear the worth-it memo so the next request rebuilds. Called by
 *  the ingest pass via the globalThis slot below — the changelog /
 *  autopsy cache invalidator's pattern (registered at module load),
 *  so the ingest module never imports server.ts. */
export function _invalidateWorthItCacheAfterIngest(): void {
  worthItCache.clear();
}

(globalThis as { __fleet_worth_it_invalidate__?: () => void })
  .__fleet_worth_it_invalidate__ = _invalidateWorthItCacheAfterIngest;

/** Resolve the (rate, hours) defaults the cache + handler use. Reads
 *  cfg.worth_it.* if present; otherwise the documented defaults
 *  (75 / 1) bake in. The helper signature mirrors what the
 *  ProjectWorthItVerdictOptions resolution does inside the helper —
 *  but the route layer needs the explicit numbers to compose the
 *  cache key. */
function worthItResolvedKnobs(cfg: FleetConfig): { rate: number; hours: number } {
  const wt = cfg.worth_it ?? {};
  const rate = typeof wt.hourly_rate_usd === "number" ? wt.hourly_rate_usd : 75;
  const hours = typeof wt.hours_per_pr === "number" ? wt.hours_per_pr : 1;
  return { rate, hours };
}

// Ticket 0051: "Pre-install ROI calculator" memo cache.
//
// 15-min TTL (matches Cache-Control: max-age=900 — the median moves
// slowly; same window as 0044 / 0048). The cache is keyed per
// (windowDays, percentile) so the public route's default (90d / p25)
// and any future override request don't collide. Invalidation is a
// THREE-VALUE tuple:
//
//   - latestPrFetchedAt = SELECT MAX(fetched_at) FROM pr
//                           WHERE state='MERGED' AND is_agent=1
//   - mergedPrCount     = SELECT COUNT(*)        FROM pr
//                           WHERE state='MERGED' AND is_agent=1
//   - latestRunEndedAt  = SELECT MAX(ended_at)   FROM run
//
// The `pr` table has NO surrogate `id` (PK is `(project_id, number)`)
// so we proxy "fresh merge landed" via the (MAX(fetched_at), COUNT(*))
// pair per LESSONS 2026-06-07 "the `pr` table has no surrogate `id`;
// proxy 'latest landed' via (MAX(fetched_at), COUNT(*))" — NEVER
// `MAX(pr.id)`. The third tuple value captures a fresh run-end so the
// spend axis (which composes via cost_rollup_day, derived from `run`
// rows on every ingest pass) also busts the cache when it shifts.
//
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests" we expose `_resetMedianProjectionCacheForTests()`. Per
// LESSONS § "expose a build counter for cache-hit tests, not a
// fetcher swap" we also expose
// `_getMedianProjectionCacheBuildsForTests()`; it ticks on every
// cache MISS so route tests assert hit/miss semantics without
// stubbing SQL. Production code never reads either.
//
// Per LESSONS 2026-06-05 "break ingest↔server cache-invalidation
// cycles via a globalThis slot, not a circular import": the ingest
// pass calls a hook registered on
// `globalThis.__fleet_median_projection_invalidate__` so a fresh PR
// ingest tick clears the cache without waiting out the TTL. The slot
// is registered below at module load time and read lazily by the
// ingest module — same shape as the 0039 changelog / 0047 autopsy /
// 0048 worth-it / 0050 year-in-review hooks.
interface MedianProjectionCacheEntry {
  tuple: string;
  value: FleetMedianProjection;
  expires_at: number;
}
const MEDIAN_PROJECTION_TTL_MS = 900_000;
const medianProjectionCache = new Map<string, MedianProjectionCacheEntry>();
let medianProjectionBuildCounter = 0;

export function _resetMedianProjectionCacheForTests(): void {
  medianProjectionCache.clear();
  medianProjectionBuildCounter = 0;
}

export function _getMedianProjectionCacheBuildsForTests(): number {
  return medianProjectionBuildCounter;
}

interface MedianProjectionPrSummaryRow { mx: string | null; c: number | null; }
interface MedianProjectionRunSummaryRow { mx: string | null; }

function medianProjectionInvalidationTuple(
  db: DB, windowDays: number, percentile: "p25" | "median",
): string {
  // (MAX(fetched_at), COUNT(*)) over merged agent PRs — the canonical
  // "fresh merge landed" pair per LESSONS 2026-06-07. NEVER MAX(pr.id)
  // (the column doesn't exist; PK is (project_id, number)).
  const prRow = db.prepare(
    "SELECT MAX(fetched_at) AS mx, COUNT(*) AS c "
    + "  FROM pr WHERE state = 'MERGED' AND is_agent = 1",
  ).get() as unknown as MedianProjectionPrSummaryRow | undefined;
  // MAX(run.ended_at) captures a fresh run-end so the spend axis
  // (derived from `run` rows on every ingest pass via
  // recomputeRollups) busts the cache when it advances.
  const runRow = db.prepare(
    "SELECT MAX(ended_at) AS mx FROM run",
  ).get() as unknown as MedianProjectionRunSummaryRow | undefined;
  const mx = prRow?.mx ?? "";
  const c = Number(prRow?.c ?? 0);
  const rmx = runRow?.mx ?? "";
  return `${windowDays}|${percentile}|${mx}|${c}|${rmx}`;
}

function medianProjectionCacheKey(windowDays: number, percentile: "p25" | "median"): string {
  return `${windowDays}|${percentile}`;
}

function getMedianProjectionCached(
  db: DB, now: Date, windowDays: number, percentile: "p25" | "median",
): FleetMedianProjection {
  const tuple = medianProjectionInvalidationTuple(db, windowDays, percentile);
  const key = medianProjectionCacheKey(windowDays, percentile);
  const hit = medianProjectionCache.get(key);
  if (hit && hit.tuple === tuple && hit.expires_at > Date.now()) {
    return hit.value;
  }
  medianProjectionBuildCounter += 1;
  const value = fleetMedianProjection(db, now, { windowDays, percentile });
  medianProjectionCache.set(key, {
    tuple, value, expires_at: Date.now() + MEDIAN_PROJECTION_TTL_MS,
  });
  return value;
}

/** Clear the median-projection memo so the next request rebuilds.
 *  Called by the ingest pass via the globalThis slot below — same
 *  shape as the changelog / autopsy / worth-it / year-in-review hooks
 *  (registered at module load), so the ingest module never imports
 *  server.ts. */
export function _invalidateMedianProjectionCacheAfterIngest(): void {
  medianProjectionCache.clear();
}

(globalThis as { __fleet_median_projection_invalidate__?: () => void })
  .__fleet_median_projection_invalidate__ = _invalidateMedianProjectionCacheAfterIngest;

// ────────────────────────────────────────────────────────────────────
// /calculator HTML page (ticket 0051).
//
// Self-contained single-column document — NO external JS, NO bundled
// SPA, NO new runtime deps. Inline <style> block carries the mobile-
// first layout per the 0011 contract. Pure HTML form: action=/calculator
// method=GET so the result URL is bookmarkable / shareable. The form
// renders identically every time; when the URL carries query params we
// additionally render a result block below.
// ────────────────────────────────────────────────────────────────────

/** Strip token-shaped substrings + GitHub URLs from operator-visible
 *  copy. Same shape as src/receipts.ts § redactSecrets — defence in
 *  depth at the renderer boundary (LESSONS § "defence-in-depth secret
 *  redaction at the renderer boundary"). The aggregated calculator
 *  carries no operator data by design, but a future regression that
 *  embeds a token-shaped substring (e.g. a project slug that looks
 *  like base64) is caught here before res.end. */
function redactSecretsForCalculator(s: string): string {
  let out = String(s ?? "");
  out = out.replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-pat>");
  out = out.replace(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?/g, "<redacted-repo-url>");
  out = out.replace(/\b[A-Za-z0-9_]{24,}\b/g, (match) => {
    const hasLetter = /[A-Za-z]/.test(match);
    const hasDigit = /\d/.test(match) || /_/.test(match);
    return hasLetter && hasDigit ? "<redacted>" : match;
  });
  return out;
}

function escForCalculator(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

/** Constants for input validation — matched in both the route handler
 *  and the test suite. */
const REPOS_MIN = 1;
const REPOS_MAX = 20;
const RATE_MIN = 1;
const RATE_MAX = 1000;
const USERNAME_RE = /^[A-Za-z0-9-]{1,39}$/;

interface CalculatorParsed {
  repos: number;        // clamped to [REPOS_MIN, REPOS_MAX]
  hourlyRateUsd: number; // clamped if valid
  username: string;
  // The raw values are kept for error rendering so the form retains
  // the offending input rather than silently replacing it with the
  // clamp.
  rawRepos: string;
  rawRate: string;
  rawUsername: string;
  errors: string[];
  hasParams: boolean;
}

/** Parse + validate query params for /calculator. Separates the
 *  URL-shape parse from the value-validation logic so error messages
 *  stay precise (LESSONS § "route regex for 'owner/name' slugs needs
 *  an embedded slash" — different surface, same principle: keep the
 *  shape match permissive and the value validation strict). */
function parseCalculatorParams(url: URL): CalculatorParsed {
  const params = url.searchParams;
  const rawUsername = params.get("u") ?? "";
  const rawRepos = params.get("n") ?? "";
  const rawRate = params.get("r") ?? "";
  const hasParams = params.has("u") || params.has("n") || params.has("r");
  const errors: string[] = [];

  // Username validation: cosmetic (no GitHub API call). Empty is
  // allowed so an unfilled form doesn't render the error block.
  let username = rawUsername;
  if (rawUsername && !USERNAME_RE.test(rawUsername)) {
    errors.push(
      "username must match GitHub rules: 1–39 chars, letters/digits/hyphens only",
    );
    // Keep the raw value for the form (the input retains it); the
    // result-block render path skips when there are errors.
    username = rawUsername;
  }

  // Repos: integer in [REPOS_MIN, REPOS_MAX]. Out-of-range numbers
  // CLAMP silently (the AC's "submit n=999, assert clamps to 20"
  // contract); non-numeric / negative values are an error.
  let repos = 3; // default
  if (rawRepos) {
    const n = Number(rawRepos);
    if (!Number.isFinite(n) || Math.floor(n) !== n || n < 0) {
      errors.push("repos must be a positive integer");
    } else if (n < REPOS_MIN) {
      // Below the floor: clamp UP to the floor silently. (Sub-1 is
      // not strictly "invalid" but is meaningless; the spec calls for
      // a clamp at both ends.)
      repos = REPOS_MIN;
    } else if (n > REPOS_MAX) {
      repos = REPOS_MAX;
    } else {
      repos = Math.floor(n);
    }
  }

  // Hourly rate: number in [RATE_MIN, RATE_MAX]. Negative values are
  // an error (the AC's "submit r=-5, assert form shows an error").
  let hourlyRateUsd = 75; // default
  if (rawRate) {
    const r = Number(rawRate);
    if (!Number.isFinite(r) || r < 0) {
      errors.push("hourly rate must be a positive number");
    } else if (r < RATE_MIN) {
      hourlyRateUsd = RATE_MIN;
    } else if (r > RATE_MAX) {
      hourlyRateUsd = RATE_MAX;
    } else {
      hourlyRateUsd = r;
    }
  }

  return {
    repos, hourlyRateUsd, username,
    rawRepos, rawRate, rawUsername,
    errors, hasParams,
  };
}

const CALCULATOR_FOOTER_REPO_URL = "https://github.com/" + "mutaaf/fleet-control";

function fmtUsdForCalculator(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 1) return "$" + n.toFixed(2);
  if (n < 100) return "$" + n.toFixed(2);
  return "$" + Math.round(n).toString();
}

function fmtNumberForCalculator(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 1 && n > 0) return n.toFixed(2);
  if (n < 10) return n.toFixed(1);
  return Math.round(n).toString();
}

/** Render the self-contained /calculator HTML page. Pure HTML form;
 *  optional result block when query params are present. Inline <style>
 *  carries the mobile-first layout per the 0011 contract. */
function renderCalculatorPage(
  parsed: CalculatorParsed,
  median: FleetMedianProjection,
): string {
  const insufficient = median.projects_observed < 2
    || median.merged_prs_per_month <= 0
    || median.cost_per_pr_usd == null;

  const safeUsername = escForCalculator(parsed.rawUsername);
  // For the repos + rate inputs: when validation succeeded we render
  // the CLAMPED value (so `?n=999` shows `value="20"` per the AC's
  // clamp contract); when validation failed we keep the raw value so
  // the user can correct the offending input.
  const reposErrorRaised = parsed.errors.some((e) => /repos/i.test(e));
  const rateErrorRaised = parsed.errors.some((e) => /rate/i.test(e));
  const safeRepos = escForCalculator(
    reposErrorRaised
      ? (parsed.rawRepos || String(parsed.repos))
      : (parsed.rawRepos ? String(parsed.repos) : String(parsed.repos)),
  );
  const safeRate = escForCalculator(
    rateErrorRaised
      ? (parsed.rawRate || String(parsed.hourlyRateUsd))
      : (parsed.rawRate ? String(parsed.hourlyRateUsd) : String(parsed.hourlyRateUsd)),
  );

  const errorBlock = parsed.errors.length > 0
    ? `<div class="calc-error" data-testid="calculator-error">`
      + parsed.errors.map((e) => `<div>${escForCalculator(e)}</div>`).join("")
      + `</div>`
    : "";

  let resultBlock = "";
  if (parsed.hasParams && parsed.errors.length === 0) {
    if (insufficient) {
      // Honest empty-fleet copy. Links to /demo for seeded numbers.
      resultBlock = `<section class="calc-result" data-testid="calculator-result">`
        + `<div class="calc-empty">`
        + `<div class="calc-empty-title">This fleet is too small to compute a median yet.</div>`
        + `<div class="calc-empty-body">Try the demo at <a href="/demo">/demo</a> for seeded numbers, or install fleet-control and let it observe your own runs.</div>`
        + `</div></section>`;
    } else {
      const projection = computeRoiProjection(median, {
        repos: parsed.repos,
        hourlyRateUsd: parsed.hourlyRateUsd,
      });
      const prsLine = fmtNumberForCalculator(projection.projected_merged_prs);
      const spendLine = fmtUsdForCalculator(projection.projected_spend_usd);
      const cppLine = projection.projected_cost_per_pr_usd != null
        ? fmtUsdForCalculator(projection.projected_cost_per_pr_usd)
        : "—";
      const roiLine = projection.roi_multiplier != null
        ? projection.roi_multiplier.toFixed(1) + "x"
        : "—";
      const humanLine = fmtUsdForCalculator(projection.human_equivalent_cost_usd);
      const usernameGreeting = parsed.username
        ? escForCalculator(parsed.username) + ", here's your projection"
        : "Your projection";
      const medianLine = `Based on the ${escForCalculator(projection.percentile_label)}: ${fmtNumberForCalculator(median.merged_prs_per_month)} merged PRs/month at ${fmtUsdForCalculator(median.cost_per_pr_usd ?? 0)} per PR per project.`;
      resultBlock = `<section class="calc-result" data-testid="calculator-result">`
        + `<div class="calc-result-greeting">${usernameGreeting}</div>`
        + `<div class="calc-result-stats">`
        + `<div class="calc-stat"><div class="calc-stat-value calc-headline">${escForCalculator(prsLine)}</div><div class="calc-stat-label">projected merged PRs / month</div></div>`
        + `<div class="calc-stat"><div class="calc-stat-value">${escForCalculator(spendLine)}</div><div class="calc-stat-label">projected spend / month</div></div>`
        + `<div class="calc-stat"><div class="calc-stat-value">${escForCalculator(cppLine)}</div><div class="calc-stat-label">projected $ / PR</div></div>`
        + `<div class="calc-stat"><div class="calc-stat-value">${escForCalculator(roiLine)}</div><div class="calc-stat-label">ROI multiplier</div></div>`
        + `</div>`
        + `<div class="calc-result-foot">vs ${escForCalculator(humanLine)} of engineer time at ${escForCalculator("$" + parsed.hourlyRateUsd)}/hr. ${escForCalculator(medianLine)}</div>`
        + `</section>`;
    }
  }

  const installCta = `<a class="calc-install-cta" data-testid="calculator-install-cta" href="${CALCULATOR_FOOTER_REPO_URL}">install fleet-control</a>`;

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>fleet-control · pre-install ROI calculator</title>
<meta name="robots" content="index, follow" />
<style>
  :root {
    --bg: #0e0e0e; --fg: #fafafa; --dim: #888; --good: #36d399;
    --warn: #fbbd23; --bad: #f87272; --accent: #67e8f9;
    --card: #1a1a1a; --border: #2a2a2a;
  }
  * { box-sizing: border-box; }
  body { font: 16px/1.5 -apple-system, system-ui, sans-serif;
    margin: 0; padding: 16px; background: var(--bg); color: var(--fg); }
  main { max-width: 560px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .calc-sub { color: var(--dim); margin: 0 0 24px; font-size: 14px; }
  form { display: flex; flex-direction: column; gap: 12px; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 14px; color: var(--dim); }
  input { font: inherit; padding: 12px 14px; background: var(--card);
    color: var(--fg); border: 1px solid var(--border); border-radius: 8px;
    min-height: 44px; width: 100%; }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { font: inherit; padding: 12px 16px; background: var(--accent);
    color: #0a0a0a; border: 0; border-radius: 8px; min-height: 44px;
    width: 100%; font-weight: 600; cursor: pointer; }
  .calc-error { background: rgba(248,114,114,0.12); border: 1px solid var(--bad);
    color: var(--bad); padding: 12px 14px; border-radius: 8px;
    margin-top: 16px; font-size: 14px; }
  .calc-result { margin-top: 28px; padding: 20px;
    background: var(--card); border: 1px solid var(--border); border-radius: 12px; }
  .calc-result-greeting { color: var(--dim); font-size: 14px; margin-bottom: 8px; }
  .calc-result-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 16px;
    margin-top: 4px; }
  .calc-stat-value { font-size: 22px; font-weight: 600; color: var(--fg); }
  .calc-headline { color: var(--good); font-size: 28px; }
  .calc-stat-label { font-size: 12px; color: var(--dim); margin-top: 2px; }
  .calc-result-foot { margin-top: 16px; padding-top: 16px;
    border-top: 1px solid var(--border); font-size: 13px; color: var(--dim); }
  .calc-empty { padding: 4px; }
  .calc-empty-title { font-size: 16px; font-weight: 600; }
  .calc-empty-body { font-size: 14px; color: var(--dim); margin-top: 6px; }
  .calc-empty-body a { color: var(--accent); }
  .calc-install-cta { display: block; text-align: center; margin-top: 24px;
    padding: 14px 16px; background: transparent; border: 1px solid var(--border);
    color: var(--fg); text-decoration: none; border-radius: 8px;
    min-height: 44px; font-weight: 500; }
  .calc-install-cta:hover { border-color: var(--accent); color: var(--accent); }
  .calc-foot { margin-top: 32px; font-size: 12px; color: var(--dim); text-align: center; }
  @media (max-width: 375px) {
    body { padding: 12px; }
    h1 { font-size: 20px; }
    .calc-result-stats { grid-template-columns: 1fr; }
    .calc-headline { font-size: 24px; }
  }
  @media (min-width: 768px) {
    main { max-width: 640px; }
    h1 { font-size: 26px; }
  }
</style>
</head>
<body>
<main>
  <h1>Pre-install ROI calculator</h1>
  <p class="calc-sub">Three inputs. One projection. Decide in 30 seconds.</p>
  <form action="/calculator" method="GET">
    <label>your GitHub username
      <input type="text" name="u" value="${safeUsername}" data-testid="calculator-username" autocomplete="username" placeholder="octocat" />
    </label>
    <label>repos you would put on the loop (1–${REPOS_MAX})
      <input type="number" name="n" value="${safeRepos}" min="${REPOS_MIN}" max="${REPOS_MAX}" data-testid="calculator-repos" inputmode="numeric" />
    </label>
    <label>your hourly rate (USD)
      <input type="number" name="r" value="${safeRate}" min="${RATE_MIN}" max="${RATE_MAX}" data-testid="calculator-rate" inputmode="decimal" />
    </label>
    <button type="submit" data-testid="calculator-submit">calculate</button>
  </form>
  ${errorBlock}
  ${resultBlock}
  ${installCta}
  <div class="calc-foot">Numbers are aggregated across the entire fleet — never per-project.</div>
</main>
</body>
</html>`;
  return redactSecretsForCalculator(body);
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

// Ticket 0050: fleet year-in-review memo cache.
//
// 1-hour TTL (the page moves slowly — it's a year-scale artifact).
// Keyed by `year` + the cross-table tuple
//   (year, MAX(pr.fetched_at), COUNT(*) FROM pr WHERE state IN
//      ('MERGED','open','CLOSED'), MAX(run.ended_at), COUNT(*) FROM run)
// per the AC. Per LESSONS 2026-06-07 "the `pr` table has no surrogate
// `id`", the PR signal uses (MAX(fetched_at), COUNT(*)), NEVER
// MAX(pr.id). Per LESSONS § "in-process dedup sets need an explicit
// reset hook for tests" we expose `_resetYearInReviewCacheForTests()`.
// Per LESSONS § "expose a build counter for cache-hit tests, not a
// fetcher swap" we expose `_getYearInReviewCacheBuildsForTests()`
// that ticks on every cache MISS.
interface YearInReviewCacheEntry {
  tuple: string;
  value: FleetYearInReview;
  expires_at: number;
}
const YEAR_IN_REVIEW_TTL_MS = 3600_000; // 1 hour
const yearInReviewCache = new Map<number, YearInReviewCacheEntry>();
let yearInReviewBuildCounter = 0;

export function _resetYearInReviewCacheForTests(): void {
  yearInReviewCache.clear();
  yearInReviewBuildCounter = 0;
}

export function _getYearInReviewCacheBuildsForTests(): number {
  return yearInReviewBuildCounter;
}

interface YearInReviewPrSummaryRow { mx: string | null; c: number | null; }
interface YearInReviewRunSummaryRow { mx: string | null; c: number | null; }

function yearInReviewInvalidationTuple(db: DB, year: number): string {
  // PR signal: (MAX(fetched_at), COUNT(*)) across MERGED/open/CLOSED —
  // either moving busts the cache.
  const prRow = db.prepare(
    "SELECT MAX(fetched_at) AS mx, COUNT(*) AS c FROM pr "
    + " WHERE state IN ('MERGED', 'open', 'CLOSED')",
  ).get() as unknown as YearInReviewPrSummaryRow | undefined;
  const runRow = db.prepare(
    "SELECT MAX(ended_at) AS mx, COUNT(*) AS c FROM run",
  ).get() as unknown as YearInReviewRunSummaryRow | undefined;
  const prMx = prRow?.mx ?? "";
  const prC = Number(prRow?.c ?? 0);
  const runMx = runRow?.mx ?? "";
  const runC = Number(runRow?.c ?? 0);
  return `${year}|${prMx}|${prC}|${runMx}|${runC}`;
}

/** Production cache-invalidation hook — called from the
 *  `runIngestPass` post-COMMIT tail via the `globalThis` slot
 *  (per LESSONS 2026-06-05 "break ingest↔server cache-invalidation
 *  cycles via a globalThis slot"). Clearing the map (not the build
 *  counter) lets tests observe a counter increment on the next call
 *  after an ingest. */
export function _invalidateYearInReviewCacheAfterIngest(): void {
  yearInReviewCache.clear();
}

// Register the year-in-review invalidation hook on the global object
// so `runIngestPass` (in src/ingest/index.ts) can call it without
// importing this module (which would create a cycle — server.ts
// imports runIngestPass at the top). Same convention as the
// changelog hook above; the double-underscore-prefix-and-suffix
// reads as "do not collide".
(globalThis as { __fleet_year_in_review_invalidate__?: () => void })
  .__fleet_year_in_review_invalidate__ = _invalidateYearInReviewCacheAfterIngest;

/** Look up a fresh year-in-review from the memo cache; rebuild on
 *  miss. The invalidation tuple busts the entry the moment any of
 *  the underlying signals advances (a fresh PR, run, or ingest tick
 *  via the globalThis hook). */
export function _yearInReviewCachedForTests(
  db: DB, year: number, now: Date, opts?: { hourlyRateUsd?: number; hoursPerPr?: number; quietHoursActive?: boolean },
): FleetYearInReview {
  return getYearInReviewCached(db, year, now, opts);
}

function getYearInReviewCached(
  db: DB, year: number, now: Date,
  opts?: { hourlyRateUsd?: number; hoursPerPr?: number; quietHoursActive?: boolean },
): FleetYearInReview {
  const tuple = yearInReviewInvalidationTuple(db, year)
    + `|${opts?.quietHoursActive ? "Q" : "L"}`
    + `|${opts?.hourlyRateUsd ?? ""}`
    + `|${opts?.hoursPerPr ?? ""}`;
  const hit = yearInReviewCache.get(year);
  if (hit && hit.tuple === tuple && hit.expires_at > Date.now()) return hit.value;
  yearInReviewBuildCounter += 1;
  const value = fleetYearInReview(db, year, now, opts);
  yearInReviewCache.set(year, {
    tuple, value, expires_at: Date.now() + YEAR_IN_REVIEW_TTL_MS,
  });
  return value;
}

/** Validate the `:year` route segment: must be a 4-digit integer.
 *  Returns the parsed year, OR `null` for non-matching shapes so
 *  the caller can 404. */
function validateYearParam(raw: string): number | null {
  if (!/^\d{4}$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n;
}

/** Strip token-shaped substrings + GitHub URLs from operator-visible
 *  copy. Same shape as src/receipts.ts § redactSecrets — defence in
 *  depth at the renderer boundary (LESSONS § "defence-in-depth secret
 *  redaction at the renderer boundary"). */
function redactSecretsForYearPage(s: string): string {
  let out = String(s ?? "");
  out = out.replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-pat>");
  out = out.replace(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?/g, "<redacted-repo-url>");
  out = out.replace(/\b[A-Za-z0-9_]{24,}\b/g, (match) => {
    const hasLetter = /[A-Za-z]/.test(match);
    const hasDigit = /\d/.test(match) || /_/.test(match);
    return hasLetter && hasDigit ? "<redacted>" : match;
  });
  return out;
}

function escForYearPage(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

/** Render the self-contained year-in-review HTML page. Inline
 *  <style> reuses the existing portal style.css block (linked, NOT
 *  inlined — the SW caches it via the shell strategy). No external
 *  JS. */
function renderYearInReviewPage(r: FleetYearInReview): string {
  const year = r.year;
  // Empty-fleet branch: zero projects, zero PRs.
  if (r.project_count === 0 && r.total_merged_prs === 0) {
    const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Fleet year-in-review ${escForYearPage(year)}</title>
<link rel="stylesheet" href="/style.css" />
</head>
<body class="year-in-review-page">
<main class="year-in-review" data-testid="year-in-review">
  <div class="year-hero" data-testid="year-hero">
    <div class="year-hero-headline">Nothing shipped in ${escForYearPage(year)}.</div>
    <div class="year-hero-sub">Run <code>fleetctl onboard</code> to register your first project.</div>
  </div>
  <ul class="year-projects" data-testid="top-projects"></ul>
  <ul class="year-lessons" data-testid="top-lessons"></ul>
  <div class="year-sparkline" data-testid="year-sparkline">${renderSparklineSvg(r)}</div>
  <button class="year-share" data-testid="copy-share-link" type="button">copy share link</button>
  <div class="year-foot">
    <a data-testid="pulse-cross-link" href="/pulse">see this week's pulse at /pulse</a>
  </div>
</main>
</body>
</html>`;
    return redactSecretsForYearPage(body);
  }
  // Hero numbers.
  const heroPrs = String(r.total_merged_prs);
  const heroSpend = "$" + (r.total_spend_usd >= 100
    ? Math.round(r.total_spend_usd).toString()
    : r.total_spend_usd.toFixed(2));
  const heroRoi = r.roi_multiplier != null
    ? `${r.roi_multiplier.toFixed(1)}x ROI`
    : "ROI —";
  const heroProjects = `${r.project_count} project${r.project_count === 1 ? "" : "s"}`;
  // Top projects.
  const projectCards = r.top_projects.map((p) => {
    const slugSafe = escForYearPage(p.project_slug);
    return `<li class="year-project" data-testid="top-project-${slugSafe}">`
      + `<div class="year-project-slug">${slugSafe}</div>`
      + `<div class="year-project-prose">${escForYearPage(p.prose)}</div>`
      + `</li>`;
  }).join("");
  // Top lessons.
  const lessonCards = r.top_lessons.map((L) => {
    const slugSafe = escForYearPage(L.lesson_slug);
    return `<li class="year-lesson" data-testid="top-lesson-${slugSafe}">`
      + `<div class="year-lesson-slug">${slugSafe}</div>`
      + `<div class="year-lesson-title">${escForYearPage(L.lesson_title)}</div>`
      + `<div class="year-lesson-count">${escForYearPage(String(L.heal_count))} saves</div>`
      + `<div class="year-lesson-date">${escForYearPage(L.lesson_date)}</div>`
      + `</li>`;
  }).join("");
  const dipHeadline = r.dip_week
    ? `<div class="year-dip-headline">${escForYearPage(r.dip_week.headline)}</div>`
    : "";
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>Fleet year-in-review ${escForYearPage(year)}</title>
<link rel="stylesheet" href="/style.css" />
</head>
<body class="year-in-review-page">
<main class="year-in-review" data-testid="year-in-review">
  <section class="year-hero" data-testid="year-hero">
    <div class="year-hero-headline">in ${escForYearPage(year)} the fleet shipped ${escForYearPage(heroPrs)} PRs at ${escForYearPage(heroSpend)} spent</div>
    <div class="year-hero-stats">
      <span class="year-hero-stat">${escForYearPage(heroPrs)} PRs</span>
      <span class="year-hero-stat">${escForYearPage(heroSpend)}</span>
      <span class="year-hero-stat">${escForYearPage(heroRoi)}</span>
      <span class="year-hero-stat">${escForYearPage(heroProjects)}</span>
    </div>
  </section>
  <section class="year-sparkline" data-testid="year-sparkline">
    ${renderSparklineSvg(r)}
    ${dipHeadline}
  </section>
  <ul class="year-projects" data-testid="top-projects">${projectCards}</ul>
  <ul class="year-lessons" data-testid="top-lessons">${lessonCards}</ul>
  <button class="year-share" data-testid="copy-share-link" type="button">copy share link</button>
  <div class="year-foot">
    <a data-testid="pulse-cross-link" href="/pulse">see this week's pulse at /pulse</a>
  </div>
</main>
</body>
</html>`;
  return redactSecretsForYearPage(body);
}

/** Build the SVG sparkline for the weekly_merges series. 52 <rect>
 *  children, one per ISO week. The dip-week bar (when present) gets
 *  the `dip-week` testid + a red fill. */
function renderSparklineSvg(r: FleetYearInReview): string {
  // We always render exactly 52 bars even when the helper returned
  // more (rare year-boundary spillover) so the test contract holds.
  const series = r.weekly_merges.slice(0, 52);
  while (series.length < 52) {
    series.push({ week_iso: `${r.year}-W${String(series.length + 1).padStart(2, "0")}`, merged: 0, closed_unmerged: 0, spend_usd: 0 });
  }
  const max = Math.max(1, ...series.map((s) => s.merged));
  const w = 4;
  const gap = 2;
  const h = 40;
  const totalW = series.length * (w + gap);
  const dipWeek = r.dip_week?.week_iso;
  const bars = series.map((s, i) => {
    const barH = Math.max(1, Math.round((s.merged / max) * h));
    const x = i * (w + gap);
    const y = h - barH;
    const isDip = s.week_iso === dipWeek;
    const fill = isDip ? "#c0392b" : "#7aa";
    const testid = isDip ? ` data-testid="dip-week"` : "";
    return `<rect x="${x}" y="${y}" width="${w}" height="${barH}" fill="${fill}"${testid}></rect>`;
  }).join("");
  return `<svg viewBox="0 0 ${totalW} ${h}" width="100%" height="${h}" role="img" aria-label="weekly merges">${bars}</svg>`;
}

/** Single chokepoint the server hits for GET /year/<YYYY>. Returns the
 *  status + headers + body the http handler emits. Pure so unit tests
 *  can drive it directly. */
function serveYearPage(
  db: DB, cfg: FleetConfig, year: number, now: Date,
): { status: number; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=3600",
  };
  const quiet = quietHoursActiveAnywhere(cfg, now);
  const payload = getYearInReviewCached(db, year, now, { quietHoursActive: quiet });
  const body = renderYearInReviewPage(payload);
  return { status: 200, headers, body };
}

// ────────────────────────────────────────────────────────────────────
// Ticket 0054: public weekly fleet pulse.
//
// Two routes (both public, no auth):
//   GET /pulse              → self-contained HTML, no <script>, no
//                             /api/control/ surface.
//   GET /api/fleet/pulse    → JSON payload matching FleetWeeklyPulse.
//
// Both routes share a per-week memo cache. The cache key embeds the
// week_start_iso so the cache transparently rolls over at the Monday
// boundary without an explicit invalidation. The cache tuple uses
// (MAX(pr.fetched_at), COUNT(*) FROM pr WHERE state='MERGED',
//  MAX(lesson_credit.created_at), COUNT(*) FROM lesson_credit,
//  week_start_iso) per LESSONS 2026-06-07 "the `pr` table has no
// surrogate `id`; proxy 'latest landed' via (MAX(fetched_at),
// COUNT(*))".
//
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests" we expose `_resetPulseCacheForTests()`. Per LESSONS §
// "expose a build counter for cache-hit tests, not a fetcher swap"
// we expose `_getPulseCacheBuildsForTests()` that ticks on every
// cache MISS.
const PULSE_TTL_MS = 3600_000; // 1 hour — page moves slowly within a week.
interface PulseCacheEntry {
  tuple: string;
  value: FleetWeeklyPulse;
  expires_at: number;
}
const pulseCache = new Map<string, PulseCacheEntry>();
let pulseBuildCounter = 0;

export function _resetPulseCacheForTests(): void {
  pulseCache.clear();
  pulseBuildCounter = 0;
}

export function _getPulseCacheBuildsForTests(): number {
  return pulseBuildCounter;
}

interface PulsePrSummaryRow { mx: string | null; c: number | null; }
interface PulseLessonSummaryRow { mx: string | null; c: number | null; }

function pulseInvalidationTuple(db: DB, weekStartIso: string): string {
  // PR signal: (MAX(fetched_at), COUNT(*)) over MERGED rows. Per
  // LESSONS 2026-06-07, NEVER MAX(pr.id) — the `pr` table has no
  // surrogate id.
  const prRow = db.prepare(
    "SELECT MAX(fetched_at) AS mx, COUNT(*) AS c FROM pr "
    + " WHERE state = 'MERGED'",
  ).get() as unknown as PulsePrSummaryRow | undefined;
  // Lesson signal: (MAX(created_at), COUNT(*)) over the whole table.
  // The freshest_lesson field depends on lesson_credit churn.
  const lessonRow = db.prepare(
    "SELECT MAX(created_at) AS mx, COUNT(*) AS c FROM lesson_credit",
  ).get() as unknown as PulseLessonSummaryRow | undefined;
  const prMx = prRow?.mx ?? "";
  const prC = Number(prRow?.c ?? 0);
  const lMx = lessonRow?.mx ?? "";
  const lC = Number(lessonRow?.c ?? 0);
  return `${weekStartIso}|${prMx}|${prC}|${lMx}|${lC}`;
}

/** Production cache-invalidation hook — called from the
 *  `runIngestPass` post-COMMIT tail via the `globalThis` slot
 *  (per LESSONS 2026-06-05 "break ingest↔server cache-invalidation
 *  cycles via a globalThis slot, not a circular import"). Clearing
 *  the map (not the build counter) lets tests observe a counter
 *  increment on the next call after an ingest. */
export function _invalidatePulseCacheAfterIngest(): void {
  pulseCache.clear();
}

(globalThis as { __fleet_pulse_invalidate__?: () => void })
  .__fleet_pulse_invalidate__ = _invalidatePulseCacheAfterIngest;

/** Test-only handle on the cached pulse path. The AC3 cache test
 *  imports this so it can observe the build counter increment on
 *  miss / not-increment on hit, without touching SQL or hitting the
 *  HTTP layer. Production code uses `servePulsePage` /
 *  `servePulseJson`. */
export function _pulseCachedForTests(db: DB, now: Date): FleetWeeklyPulse {
  return getPulseCached(db, now);
}

/** Look up a fresh pulse from the memo cache; rebuild on miss. The
 *  cache key is the week_start_iso so the entry naturally rolls over
 *  at the Monday boundary. */
function getPulseCached(db: DB, now: Date): FleetWeeklyPulse {
  const value0 = fleetWeeklyPulse(db, { now });
  const key = value0.week_start_iso;
  const tuple = pulseInvalidationTuple(db, key);
  const hit = pulseCache.get(key);
  if (hit && hit.tuple === tuple && hit.expires_at > Date.now()) return hit.value;
  pulseBuildCounter += 1;
  pulseCache.set(key, {
    tuple, value: value0, expires_at: Date.now() + PULSE_TTL_MS,
  });
  return value0;
}

/** Strip token-shaped substrings from individual operator-supplied
 *  STRING VALUES on the pulse payload (project_name, lesson_title,
 *  lesson_slug). Per LESSONS 2026-06-10 "redactSecrets on a JSON
 *  body shreds your KEYS, not just your values": scrub the VALUES
 *  BEFORE composition into HTML / JSON. Never scrub the body
 *  string — a top-level JSON key like `cost_per_pr_usd` is letters-
 *  and-underscores ONLY and would match the lenient `_`-as-digit
 *  heuristic in receipts.ts / doctor.ts.
 *
 *  This redactor uses the tightened `hasDigit = /\d/.test(match)`
 *  gate (no underscore special-case) — operator string values that
 *  carry legitimate underscores (a lesson_title like
 *  `average_failed_ship_cost_usd_lives_here`) survive intact, but a
 *  real token-shape substring (always carries at least one numeric
 *  digit) gets scrubbed.
 *
 *  Same character classes as src/server.ts § redactSecretsForLessonSavings. */
function redactSecretsForPulse(s: string): string {
  let out = String(s ?? "");
  out = out.replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-pat>");
  out = out.replace(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?/g, "<redacted-repo-url>");
  out = out.replace(/\b[A-Za-z0-9_]{24,}\b/g, (match) => {
    const hasLetter = /[A-Za-z]/.test(match);
    const hasDigit = /\d/.test(match);
    return hasLetter && hasDigit ? "<redacted>" : match;
  });
  return out;
}

/** Apply the renderer-boundary redactor to every operator-supplied
 *  string field on the pulse payload. Numeric fields + JSON keys stay
 *  byte-identical; only the values that originate in upstream data
 *  (project_name, lesson_*) get the scrub. */
function redactPulsePayload(p: FleetWeeklyPulse): FleetWeeklyPulse {
  return {
    ...p,
    top_project: p.top_project ? {
      ...p.top_project,
      slug: redactSecretsForPulse(p.top_project.slug),
      project_name: redactSecretsForPulse(p.top_project.project_name),
    } : null,
    freshest_lesson: p.freshest_lesson ? {
      lesson_slug: redactSecretsForPulse(p.freshest_lesson.lesson_slug),
      lesson_date: redactSecretsForPulse(p.freshest_lesson.lesson_date),
      lesson_title: redactSecretsForPulse(p.freshest_lesson.lesson_title),
    } : null,
  };
}

function escForPulse(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

function fmtPulseUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return "$" + v.toFixed(2);
}

/** Test-only handle on the pulse renderer. Exported so tests can
 *  drive the quiet-hours branch without booting startServer + the
 *  cwd-mutating config seam (which is racy when test files run in
 *  parallel processes). */
export function _renderPulsePageForTests(
  p: FleetWeeklyPulse,
  opts: { quietHoursActive: boolean },
): string {
  return renderPulsePage(p, opts);
}

/** Render the self-contained /pulse HTML page. NO <script>, NO
 *  `/api/control/` references, NO project list beyond `top_project`.
 *  When merged_prs is zero the page renders the "fleet is quiet"
 *  sentence per AC2 — honest copy, no fabricated upbeat language. */
function renderPulsePage(p: FleetWeeklyPulse, opts: { quietHoursActive: boolean }): string {
  const scrubbed = redactPulsePayload(p);
  const weekStart = escForPulse(scrubbed.week_start_iso);
  const weekEnd = escForPulse(scrubbed.week_end_iso);
  // Empty-week branch — no per-stat testids, no CTA.
  if (scrubbed.merged_prs === 0) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>fleet pulse · week of ${weekStart}</title>
<link rel="stylesheet" href="/style.css" />
<meta name="robots" content="index, follow" />
</head>
<body class="pulse-page">
<main class="pulse-main">
  <div class="pulse-eyebrow">week of ${weekStart}</div>
  <div class="pulse-empty" data-testid="pulse-empty">The fleet is quiet this week — nothing shipped.</div>
</main>
</body>
</html>`;
  }
  const merged = String(scrubbed.merged_prs);
  const spend = fmtPulseUsd(scrubbed.total_spend_usd);
  const cpp = scrubbed.cost_per_pr_usd == null ? "—" : fmtPulseUsd(scrubbed.cost_per_pr_usd);
  const streak = String(scrubbed.streak_days);
  const topProject = scrubbed.top_project
    ? `<div class="pulse-line" data-testid="pulse-top-project">top project: ${escForPulse(scrubbed.top_project.slug)} (${escForPulse(String(scrubbed.top_project.merged_prs))} PRs)</div>`
    : `<div class="pulse-line" data-testid="pulse-top-project">top project: —</div>`;
  const freshestLesson = scrubbed.freshest_lesson
    ? `<div class="pulse-line" data-testid="pulse-freshest-lesson">freshest lesson: ${escForPulse(scrubbed.freshest_lesson.lesson_date)} · ${escForPulse(scrubbed.freshest_lesson.lesson_title)}</div>`
    : `<div class="pulse-line" data-testid="pulse-freshest-lesson">freshest lesson: —</div>`;
  const pausedLine = scrubbed.paused_count > 0
    ? `<div class="pulse-line" data-testid="pulse-paused-count">${escForPulse(String(scrubbed.paused_count))} paused — see /graveyard</div>`
    : `<div class="pulse-line" data-testid="pulse-paused-count">0 sunset projects this week</div>`;
  // CTA: quiet hours suppress the nudge per 0030 precedent.
  const cta = opts.quietHoursActive
    ? ""
    : `<a class="pulse-cta" data-testid="pulse-cta" href="/calculator">see the full receipts at /calculator</a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>fleet pulse · week of ${weekStart}</title>
<link rel="stylesheet" href="/style.css" />
<meta name="robots" content="index, follow" />
</head>
<body class="pulse-page">
<main class="pulse-main">
  <div class="pulse-eyebrow">week of ${weekStart} → ${weekEnd}</div>
  <h1 class="pulse-headline" data-testid="pulse-headline">${merged} PRs shipped · ${spend} spent · ${cpp} per merged PR · streak ${streak} days</h1>
  <div class="pulse-stats">
    <div class="pulse-stat" data-testid="pulse-merged-prs"><span class="pulse-stat-value">${merged}</span><span class="pulse-stat-label">PRs merged</span></div>
    <div class="pulse-stat" data-testid="pulse-spend"><span class="pulse-stat-value">${spend}</span><span class="pulse-stat-label">spent</span></div>
    <div class="pulse-stat" data-testid="pulse-cost-per-pr"><span class="pulse-stat-value">${cpp}</span><span class="pulse-stat-label">per merged PR</span></div>
    <div class="pulse-stat" data-testid="pulse-streak"><span class="pulse-stat-value">${streak}</span><span class="pulse-stat-label">streak days</span></div>
  </div>
  ${topProject}
  ${freshestLesson}
  ${pausedLine}
  ${cta}
</main>
</body>
</html>`;
}

/** Single chokepoint the server hits for GET /pulse. Returns the
 *  status + headers + body the http handler emits. */
function servePulsePage(
  db: DB, cfg: FleetConfig, now: Date,
): { status: number; headers: Record<string, string>; body: string } {
  const payload = getPulseCached(db, now);
  const quiet = quietHoursActiveAnywhere(cfg, now);
  const body = renderPulsePage(payload, { quietHoursActive: quiet });
  return {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
    body,
  };
}

/** Single chokepoint for GET /api/fleet/pulse. Returns the scrubbed
 *  JSON payload. */
function servePulseJson(db: DB, now: Date): { body: string; headers: Record<string, string> } {
  const payload = getPulseCached(db, now);
  const scrubbed = redactPulsePayload(payload);
  return {
    body: JSON.stringify(scrubbed),
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=3600",
    },
  };
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
      // Ticket 0054: public weekly fleet pulse JSON. PUBLIC — NO auth,
      // NO loopback gate (the page + JSON are the same public surface;
      // the bookmark is the value). Handled BEFORE the
      // `path.startsWith("/api/")` auth gate so a remote caller without
      // a token gets 200 — same posture as the /pulse HTML route below
      // and the existing /receipts / /year / /calculator routes (which
      // are HTML; this is the JSON sibling).
      if (path === "/api/fleet/pulse" && req.method === "GET") {
        const result = servePulseJson(db, new Date());
        res.writeHead(200, result.headers);
        return res.end(result.body);
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
          // Ticket 0056: per-project lesson-savings rollup, inlined
          // as `time_saved_this_month` on each project row. ADDITIVE
          // optional field per AGENTS.md — older SPA clients
          // gracefully ignore it; no existing field changes type,
          // meaning, or removal. Per LESSONS 2026-06-10 "redactSecrets
          // on a JSON body shreds your KEYS", we scrub the
          // project_name VALUES BEFORE the home-grid payload is
          // serialised — never the body string. The savings cache
          // memoises behind the same daily-rotation tuple as 0052 so
          // the home grid hits a hot cache on 99% of opens.
          try {
            const savings = getLessonSavingsByProjectCached(db, cfg, new Date());
            const projects = v.projects as Array<Record<string, unknown>>;
            for (const p of projects) {
              const slug = String(p.slug ?? "");
              const row = savings.by_project[slug];
              if (row && row.heal_count > 0) {
                p.time_saved_this_month = {
                  saved_usd: row.saved_usd,
                  saved_hours: row.saved_hours,
                  lesson_count: row.lesson_count,
                };
              } else {
                p.time_saved_this_month = null;
              }
            }
          } catch { /* keep serving — never let the savings rollup fail /api/fleet */ }
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
        // Ticket 0044: spend-efficiency ranking + laggard diagnosis.
        // Composes pr + cost_rollup_day + run + anomaly + control_audit
        // — no schema migration. 15-min memo cache keyed by
        // (windowDays, latestRunId, latestMergedPrId) so a fresh run or
        // merged PR busts the entry on the next call. Quiet hours (0030)
        // suppress only the "Look here" call-to-action — the verdict
        // surface (laggard verdict + leaderboard) stays visible because
        // the card is a pull surface, not a push (per the 0030 contract).
        // Net-new route — no existing JSON shape to preserve.
        if (path === "/api/fleet/spend-efficiency") {
          const raw = url.searchParams.get("window");
          let windowDays = 14;
          if (raw != null) {
            const n = Number(raw);
            if (!Number.isFinite(n) || Math.floor(n) !== n || n < 7 || n > 90) {
              return json(res, { error: "window must be an integer in [7, 90]" }, 400);
            }
            windowDays = n;
          }
          const v = getSpendEfficiencyCached(db, cfg, new Date(), windowDays);
          const body = JSON.stringify(v);
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=900",
          });
          return res.end(body);
        }
        // Ticket 0045: stuck-PR taxonomy card. Labels every open agent
        // PR with one of seven taxonomy buckets so the operator knows
        // whether to intervene or wait. Pure composition over pr +
        // project + control_audit; no schema migration. 30s memo
        // cache keyed by (MAX(pr.fetched_at), COUNT(*), MAX(audit.ts))
        // — any of the three moving busts the cache on the next call.
        // Quiet-hours suppression (AC6) is signalled via
        // `quiet_hours_active`; the SPA hides non-urgent rows.
        if (path === "/api/fleet/stuck-pr-taxonomy") {
          const v = getStuckPrTaxonomyCached(db, cfg, new Date());
          const body = JSON.stringify(v);
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=30",
          });
          return res.end(body);
        }
        // Ticket 0047: PR autopsy card. One row per non-merged PR
        // close in the last N days (default 7, clamped to [1, 30]).
        // Pure composition over pr + project + control_audit + 0042's
        // lesson_credit — no schema migration beyond the additive
        // `pr.closed_at TEXT` ALTER. 10-min memo cache keyed by
        // (windowDays, MAX(closed_at) WHERE state='CLOSED',
        //  COUNT(*) WHERE state='CLOSED' AND closed_at >= now-window) —
        // either tuple value moving busts the cache, and the ingest
        // pass calls the globalThis invalidation hook so a freshly-
        // closed PR surfaces on the next render without waiting out
        // the TTL. Net-new route; no existing JSON shape to preserve.
        if (path === "/api/fleet/pr-autopsies") {
          const raw = url.searchParams.get("window");
          let windowDays = 7;
          if (raw != null) {
            const n = Number(raw);
            if (!Number.isFinite(n) || Math.floor(n) !== n || n < 1 || n > 30) {
              return json(res, { error: "window must be an integer in [1, 30]" }, 400);
            }
            windowDays = n;
          }
          const v = getPrAutopsiesCached(db, cfg, new Date(), windowDays);
          const body = JSON.stringify(v);
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=600",
          });
          return res.end(body);
        }
        // Ticket 0050: fleet year-in-review JSON route. Composes pr,
        // cost_rollup_day, lesson_credit + the per-project worth-it
        // verdict (0048) into the documented payload. 1-hour memo
        // cache keyed by year + the cross-table invalidation tuple
        // (PR signal = (MAX(fetched_at), COUNT(*)) per LESSONS
        // 2026-06-07 "the pr table has no surrogate id"; run signal =
        // (MAX(ended_at), COUNT(*))). Net-new route; no existing JSON
        // shape to preserve. Empty / never-ingested years return 200
        // with zero totals — a legit question with a legit answer.
        // Years > now+1 year return 400.
        const yearJsonMatch = path.match(/^\/api\/fleet\/year\/([^/]+)$/);
        if (yearJsonMatch) {
          const yr = validateYearParam(yearJsonMatch[1]);
          if (yr == null) return json(res, { error: "year not found" }, 404);
          const nowDate = new Date();
          if (yr > nowDate.getUTCFullYear() + 1) {
            return json(res, { error: "year out of range" }, 400);
          }
          const quiet = quietHoursActiveAnywhere(cfg, nowDate);
          const v = getYearInReviewCached(db, yr, nowDate, { quietHoursActive: quiet });
          const body = JSON.stringify(v);
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=3600",
          });
          return res.end(body);
        }
        // Ticket 0048: per-project worth-it verdict — composes 0035
        // (cost-per-PR), 0022 (fleet temp), 0026 (streak), 0044
        // (spend-efficiency framing) plus a worth_it config block
        // into a single per-project verdict
        // (`net_positive | watch | sunset_candidate |
        // insufficient_data`). Pure composition — no schema migration.
        // 15-min memo cache keyed per `(slug, window, rate, hours)`;
        // invalidated by `(MAX(pr.fetched_at), COUNT(*),
        // MAX(run.ended_at))` per project. Quiet-hours suppression of
        // the SUNSET-STICKY chip happens in the SPA renderer — the
        // verdict line itself is information (always visible).
        if (path === "/api/fleet/worth-it") {
          const { rate, hours } = worthItResolvedKnobs(cfg);
          // One row per project in slug order. The fleet endpoint
          // shares the per-project cache: each entry comes from
          // `getWorthItCached(db, ..., pid, slug, 30, rate, hours)`
          // so a per-project route hit + a fleet-wide route hit
          // never double-build.
          const projectRows = db.prepare(
            "SELECT id, slug FROM project ORDER BY slug",
          ).all() as Array<{ id: number; slug: string }>;
          const now = new Date();
          const projectsList = projectRows.map(
            (p) => getWorthItCached(db, cfg, now, p.id, p.slug, 30, rate, hours),
          );
          const body = JSON.stringify({
            projects: projectsList,
            generated_at: now.toISOString(),
          });
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=900",
          });
          return res.end(body);
        }
        // Ticket 0051: pre-install ROI calculator JSON API.
        //
        // PUBLIC route — NO auth, NO loopback gate (the page is the
        // top-of-funnel acquisition surface; anyone with the URL can
        // hit it). Returns the AGGREGATED median / p25 ONLY — never
        // per-project rows, never project slugs, never any data that
        // could be used to deanonymise a fleet. The
        // fleetMedianProjection helper is designed so its return shape
        // carries no per-project field; we additionally route the
        // rendered string through `redactSecretsForCalculator` as a
        // defence-in-depth backstop per LESSONS § "defence-in-depth
        // secret redaction at the renderer boundary".
        //
        // 15-min memo cache keyed per (windowDays, percentile);
        // invalidated by `(MAX(pr.fetched_at), COUNT(*),
        // MAX(run.ended_at))` per LESSONS 2026-06-07 (the `pr` table
        // has no surrogate id — NEVER MAX(pr.id)).
        if (path === "/api/fleet/median-projection") {
          const v = getMedianProjectionCached(db, new Date(), 90, "p25");
          const body = redactSecretsForCalculator(JSON.stringify(v));
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=900",
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
          // Ticket 0052: amend the existing 0036 lessons payload with
          // ONE additive optional `savings` field per lesson entry.
          // Per AGENTS.md "Never break the JSON shape of an existing
          // /api/... route without bumping a version", an ADDITIVE
          // optional field is allowed under the existing shape
          // contract — no existing field changes type, meaning, or
          // removal. Older SPA clients gracefully ignore the field.
          //
          // The savings join is by (lesson_slug, lesson_date) where
          // the parser's project slug is the slug-component and the
          // entry's `date` is the date-component. Lessons with zero
          // credits surface `savings: null` so the SPA can render
          // "--" uniformly (per AC7).
          let projectsOut = v.projects;
          try {
            const savings = getLessonSavingsCached(db, cfg, 90, v, new Date());
            const byKey = new Map<string, LessonSavingsRow>();
            for (const row of savings.lesson_savings) {
              byKey.set(row.lesson_slug + "|" + row.lesson_date, row);
            }
            projectsOut = v.projects.map((p) => ({
              ...p,
              lessons: p.lessons.map((l) => {
                const key = p.slug + "|" + (l.date ?? "");
                const row = byKey.get(key);
                return {
                  ...l,
                  savings: row
                    ? { lesson_slug: row.lesson_slug, saved_usd: row.saved_usd }
                    : null,
                };
              }),
            }));
          } catch { /* keep the legacy payload shape — the savings cache surfaces
                       its own JSON error from its own route */ }
          const body = JSON.stringify({
            projects: projectsOut,
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
        // Ticket 0052: lesson-pays-for-itself ledger. Returns one row
        // per cross-fleet lesson with heal_count + saved_usd over the
        // requested window (default 90 days, clamped to [1, 365]).
        // Composes lesson_credit (populated by the daemon hook +
        // route-side attribution on cache miss) and run rows with
        // outcome='failure' (the failed-ship cost data). Cache-Control:
        // max-age=900 mirrors the 15-min memo TTL; the memo
        // invalidates on every fresh lesson_credit row OR fresh failed
        // run (per the four-value tuple in
        // lessonSavingsInvalidationTuple). Per LESSONS § "defence-in-
        // depth secret redaction at the renderer boundary" the body
        // routes through redactSecretsForLessonSavings before
        // res.end — a lesson title drawn from upstream heal stdout
        // tails can in theory carry a leaked token.
        if (path === "/api/fleet/lessons/savings") {
          const windowDays = clampLessonSavingsWindow(url.searchParams.get("window"));
          const lessonsPath = defaultLessonsPath();
          const parsed = getLessonsCached(lessonsPath);
          // getLessonSavingsCached() appends `quiet_hours_active` to
          // the payload so the SPA can hide the SORT control overnight
          // per AC8 (the 0030 pull-vs-push contract: information
          // visible, prompts suppressed). Same shape as 0044's spend-
          // efficiency, 0045's stuck-PR taxonomy, 0047's PR autopsy.
          const value = getLessonSavingsCached(db, cfg, windowDays, parsed, new Date());
          const body = JSON.stringify(redactLessonSavingsRollup(value));
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=900",
          });
          return res.end(body);
        }
        // Ticket 0055: lesson-of-the-day rotation card. Composes the
        // cross-fleet lessons file (0036) with the lessonSavingsRollup
        // helper (0052) to deterministically surface ONE lesson per
        // UTC day, weighted by the lesson_credit-based savings ledger.
        // Empty fleets (<5 indexed lessons) get a `{ lesson: null,
        // total_lessons_indexed: N }` body so the SPA can render the
        // "still learning" honest empty state. Cache-Control:
        // max-age=3600 — the rotation rolls over once per UTC day, so
        // an hourly client cache is generous AND safe (the in-process
        // memo busts on any fresh lesson_credit row OR a fresh
        // lessons-file mtime, so the at-the-edge re-fetch picks up
        // changes before the 1h horizon). The redactor scrubs
        // operator-supplied STRING VALUES (lesson_title +
        // lesson_excerpt + slug/date) BEFORE JSON.stringify so a
        // future ingester regression that smuggles a token-shape
        // substring is defanged at the renderer boundary; per
        // LESSONS 2026-06-10 we scrub the VALUES, not the JSON body,
        // so the 22-char `total_lessons_indexed` field name survives.
        // The handler appends `quiet_hours_active` to the payload so
        // the SPA can suppress the dismiss chevron overnight per the
        // 0030 pull-vs-push contract (same posture as 0048 / 0050 /
        // 0053).
        if (path === "/api/fleet/lesson-of-the-day") {
          const now = new Date();
          const pick = getLessonOfTheDayCached(db, now);
          const quiet = quietHoursActiveAnywhere(cfg, now);
          // Determine total_lessons_indexed even on the null branch so
          // the SPA can render "N lessons indexed" copy in the empty
          // state. We re-parse via the existing getLessonsCached memo
          // (mtime-keyed; effectively free).
          const lessonsPath = defaultLessonsPath();
          const parsed = getLessonsCached(lessonsPath);
          let totalIndexed = 0;
          for (const p of parsed.projects) {
            for (const l of p.lessons) {
              if (l.date) totalIndexed += 1;
            }
          }
          const body = pick
            ? JSON.stringify({
                ...(redactLessonOfTheDayPick(pick) as LessonOfTheDay),
                quiet_hours_active: quiet,
              })
            : JSON.stringify({
                lesson: null,
                total_lessons_indexed: totalIndexed,
                quiet_hours_active: quiet,
              });
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=3600",
          });
          return res.end(body);
        }
        // Ticket 0042: lesson credit ledger. Returns the rollup over
        // the requested window (default 30 days, clamped to [1,90]).
        // Composes lesson_credit (populated by the daemon hook +
        // route-side attribution on cache miss) and the cross-fleet
        // lessons file (parsed via the existing getLessonsCached memo).
        // Cache-Control: max-age=300 mirrors the route's 5-min TTL;
        // the memo invalidates the moment a new heal lands OR the
        // lessons file's total entry count changes (per the
        // three-value tuple in lessonCreditInvalidationTuple).
        if (path === "/api/fleet/lesson-credits") {
          const windowDays = clampLessonCreditWindow(url.searchParams.get("window"));
          const lessonsPath = defaultLessonsPath();
          const parsed = getLessonsCached(lessonsPath);
          const value = getLessonCreditCached(db, windowDays, parsed, new Date());
          const body = JSON.stringify(value);
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=300",
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
        // Ticket 0048: per-project worth-it verdict. Reads `read`
        // scope (loopback bypasses); same posture as every other
        // per-project GET. Shares the per-(slug,window,rate,hours)
        // memo cache with the fleet endpoint so a card-level fetch
        // doesn't double-build a freshly-cached fleet row. The
        // 404 body uses the spec's "project not found" phrasing
        // (matches the AC's "clear" framing).
        const wim = path.match(/^\/api\/projects\/([\w-]+)\/worth-it$/);
        if (wim) {
          const pid = projectIdBySlug(db, wim[1]);
          if (pid == null) return json(res, { error: "project not found" }, 404);
          const { rate, hours } = worthItResolvedKnobs(cfg);
          const v = getWorthItCached(db, cfg, new Date(), pid, wim[1], 30, rate, hours);
          const body = JSON.stringify(v);
          res.writeHead(200, {
            "content-type": "application/json",
            "access-control-allow-origin": "*",
            "cache-control": "max-age=900",
          });
          return res.end(body);
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
      // Ticket 0051: pre-install ROI calculator HTML page.
      // GET /calculator renders a self-contained single-column HTML
      // page (NO external JS, NO bundled SPA route — pure HTML form).
      // The form's action is /calculator and method=GET so the result
      // URL is bookmarkable / shareable. PUBLIC — NO auth, NO loopback
      // gate (top-of-funnel acquisition surface). Per LESSONS §
      // "defence-in-depth secret redaction at the renderer boundary",
      // the rendered HTML passes through `redactSecretsForCalculator`
      // inside the renderer before we end the response. The route is
      // mounted here alongside /receipts and /year so it inherits the
      // no-token bypass posture.
      if (path === "/calculator" && req.method === "GET") {
        const parsed = parseCalculatorParams(url);
        const median = getMedianProjectionCached(db, new Date(), 90, "p25");
        const body = renderCalculatorPage(parsed, median);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
        });
        return res.end(body);
      }
      // Ticket 0050: fleet year-in-review HTML page. Self-contained
      // single-column document (no external JS — the SPA does NOT
      // own this rendering; the SW caches the page opportunistically
      // via the existing cache-first shell strategy). No auth — the
      // URL is intentionally local-only-by-default but loopback-safe
      // (no operator state on the page). Mirrors the /receipts/<slug>/
      // <month> precedent.
      const ym = path.match(/^\/year\/(\d{4})$/);
      if (ym && req.method === "GET") {
        const yr = validateYearParam(ym[1]);
        if (yr == null) {
          res.writeHead(404, { "content-type": "text/plain" });
          return res.end("year not found");
        }
        const now = new Date();
        if (yr > now.getUTCFullYear() + 1) {
          res.writeHead(400, { "content-type": "text/plain" });
          return res.end("year out of range");
        }
        const result = serveYearPage(db, cfg, yr, now);
        res.writeHead(result.status, result.headers);
        return res.end(result.body);
      }
      // Ticket 0054: public weekly fleet pulse — stable /pulse URL.
      // Public, unauthenticated — the URL is the bookmark shape and
      // the cadence is the value. Mirrors the /receipts + /year
      // precedent (mounted in the no-token bypass block alongside
      // the other public surfaces). Cache-Control: public,
      // max-age=3600 — the page moves slowly within a week; the
      // cache key embeds week_start_iso so the entry naturally rolls
      // over at the Monday boundary.
      //
      // NB: the JSON sibling `/api/fleet/pulse` is mounted EARLIER
      // (before the `if (path.startsWith("/api/"))` auth gate) so it
      // shares the same no-auth posture as this HTML route.
      if (path === "/pulse" && req.method === "GET") {
        const result = servePulsePage(db, cfg, new Date());
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
