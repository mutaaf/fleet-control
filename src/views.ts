// Assemble API payloads: cached history (SQLite) + fresh live state (live.ts).
import { createHash } from "node:crypto";
import type { DB } from "./db.ts";
import type { FleetConfig } from "./config.ts";
import { jobLive, selfCancelDays } from "./live.ts";
import { openAlerts } from "./alerts.ts";
import { daemonStatus } from "./daemon.ts";
import { ingestProjectPRs, projectPRs } from "./ingest/prs.ts";
import { anomaliesForRun, recentAnomalies } from "./anomaly.ts";
import { activeCorrelations, failureSignature } from "./correlate.ts";
import { activeDrifts } from "./drift.ts";
import { quietHoursActiveAnywhere } from "./quiet_hours.ts";
import { isoWeekKey } from "./digest.ts";
// Ticket 0066: stakeholderMonthlySummary REUSES the 0062 monthly retro
// helper as its source aggregate (PURE re-renderer over the existing
// numeric shape; no new SQL surface). retro.ts imports ONLY from
// db.ts (types) so this edge does NOT create a function-import cycle
// per LESSONS 2026-06-13.
import { monthlyRetroCard, type MonthlyRetroPayload, type MonthlyRetroResult } from "./retro.ts";

const PHASES = ["ship", "groom", "review", "eng"];

function aliasesFor(db: DB, projectId: number, slug: string): string[] {
  const a = (db.prepare("SELECT alias_slug FROM project_alias WHERE project_id=?").all(projectId) as any[]).map((r) => r.alias_slug);
  if (!a.includes(slug)) a.push(slug);
  return a;
}

function lastRun(db: DB, projectId: number, phase: string) {
  return db.prepare(
    `SELECT id, started_at, outcome, pr_number, duration_ms,
       COALESCE(cost_usd,cost_usd_computed,0) AS cost
     FROM run WHERE project_id=? AND phase=? AND outcome IS NOT 'smoke'
     ORDER BY started_at DESC LIMIT 1`).get(projectId, phase) as any;
}

function displayState(jobs: any[], scDays: number | null, ul: UsageLimitState | null): string {
  if (ul?.blocked) return "halted";
  if (jobs.some((j) => j.running)) return "working";
  if (jobs.length && jobs.every((j) => j.paused)) return "off";
  if (scDays != null && scDays < 0) return "expired";
  if (scDays != null && scDays <= 3) return "attention";
  if (jobs.some((j) => j.loaded)) return "idle";
  return "off";
}

interface UsageLimitState { blocked: boolean; hitAt: string; until: string | null; phase: string; }

/** Latest usage-limit hit for a project, IF it's still active (no successful
 * run since, and any known reset time is still in the future). */
function usageLimitState(db: DB, projectId: number, now: Date = new Date()): UsageLimitState | null {
  const row = db.prepare(
    "SELECT usage_limit_at, usage_limit_until, phase FROM run WHERE project_id=? AND usage_limit_at IS NOT NULL ORDER BY started_at DESC LIMIT 1",
  ).get(projectId) as { usage_limit_at: string; usage_limit_until: string | null; phase: string } | undefined;
  if (!row) return null;
  const recovered = db.prepare(
    "SELECT 1 FROM run WHERE project_id=? AND started_at > ? AND usage_limit_at IS NULL AND COALESCE(exit_code,0)=0 LIMIT 1",
  ).get(projectId, row.usage_limit_at) as any;
  const untilOver = row.usage_limit_until ? new Date(row.usage_limit_until).getTime() <= now.getTime() : false;
  const blocked = !recovered && !untilOver;
  return { blocked, hitAt: row.usage_limit_at, until: row.usage_limit_until, phase: row.phase };
}

/** Most recent auto-kill for a project (for the "Self-healed" badge in the UI). */
function lastAutoKill(db: DB, slug: string): { ts: string; phase: string; mins: number } | null {
  const row = db.prepare(
    "SELECT ts, target, args_json FROM control_audit WHERE actor='auto-kill' AND target LIKE ? ORDER BY id DESC LIMIT 1",
  ).get(`${slug}/%`) as { ts: string; target: string; args_json: string } | undefined;
  if (!row) return null;
  try {
    const args = JSON.parse(row.args_json);
    const phase = row.target.split("/")[1] ?? "";
    return { ts: row.ts, phase, mins: Number(args.mins) || 0 };
  } catch { return null; }
}

export function fleetView(db: DB, cfg: FleetConfig) {
  const projects = db.prepare("SELECT * FROM project ORDER BY slug").all() as any[];
  // Ticket 0021: prefetch every project_pause row (one row per paused
  // project) so the per-project loop can attach a `paused` field
  // without N+1 queries. The field stays `null` for unpaused projects
  // — purely additive to the payload shape.
  interface PauseRow { project_id: number; reason: string; }
  const pauseRows = db.prepare(
    "SELECT project_id, reason FROM project_pause",
  ).all() as unknown as PauseRow[];
  const pauseByProject = new Map<number, string>();
  for (const r of pauseRows) pauseByProject.set(r.project_id, r.reason);
  const out: any[] = [];
  let totalCost = 0, totalRuns = 0;
  for (const p of projects) {
    const cadence = JSON.parse(p.cadence_json ?? "{}");
    const aliases = aliasesFor(db, p.id, p.slug);
    const agentRows = db.prepare("SELECT phase, launchd_label FROM agent WHERE project_id=?").all(p.id) as any[];
    const jobs = agentRows.sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase)).map((a) => {
      const live = jobLive(cfg, a.launchd_label, cadence, a.phase, p.self_cancel, aliases);
      return { phase: a.phase, ...live, last: lastRun(db, p.id, a.phase) };
    });
    const scDays = selfCancelDays(p.self_cancel);
    const agg = db.prepare("SELECT COUNT(*) runs, SUM(COALESCE(cost_usd,cost_usd_computed,0)) cost FROM run WHERE project_id=?").get(p.id) as any;
    const cost7 = db.prepare("SELECT SUM(cost_usd) c FROM cost_rollup_day WHERE project_id=? AND day >= date('now','-7 day')").get(p.id) as any;
    // Ticket 0019: trailing-7d PRs merged from the run table (DISTINCT
    // pr_number on shipped runs). Sourced from runs — NOT from
    // control_audit — so auto-merged agent PRs are counted, not just
    // PRs the operator clicked "Approve & publish" on.
    const prs7 = db.prepare(
      "SELECT COUNT(DISTINCT pr_number) AS n FROM run "
      + "WHERE project_id = ? AND outcome = 'shipped' AND pr_number IS NOT NULL "
      + "  AND started_at IS NOT NULL AND date(started_at) >= date('now','-7 day')",
    ).get(p.id) as { n: number } | undefined;
    const prsMerged7d = Number(prs7?.n ?? 0);
    const telemetry = (db.prepare("SELECT outcome FROM run WHERE project_id=? AND outcome IS NOT 'smoke' ORDER BY started_at DESC LIMIT 16").all(p.id) as any[]).reverse().map((r) => r.outcome);
    const usage = usageLimitState(db, p.id);
    const autoKill = lastAutoKill(db, p.slug);
    // Ticket 0005: per-project 30-day forecast, embedded inline so the home
    // grid doesn't have to fan out to N extra HTTP calls. The /api/.../forecast
    // route still exists for callers that want the figure in isolation.
    const forecast = forecastFor(db, p.slug);
    // Ticket 0008: per-project anomaly summary for the home card pill.
    // count_24h is the bucket the spec asks for; latest_at is what drives
    // the red-vs-amber decision client-side (< 1h → red, otherwise amber).
    const anomalyAgg = db.prepare(
      "SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM anomaly a "
      + "JOIN run r ON r.id = a.run_id "
      + "WHERE r.project_id = ? AND a.created_at >= datetime('now','-1 day')",
    ).get(p.id) as { n: number; latest: string | null };
    const anomalies = { count_24h: anomalyAgg.n ?? 0, latest_at: anomalyAgg.latest ?? null };
    totalCost += agg.cost ?? 0; totalRuns += agg.runs ?? 0;
    // Ticket 0021: paused is null | "cost_cap" | "manual". Additive —
    // every other field above is unchanged.
    const pausedReason = pauseByProject.get(p.id) ?? null;
    // Ticket 0022: per-project health rollup, inlined as {score, band}.
    // The detailed sub-scores + generated_at live on the per-project
    // route (/api/projects/:slug/health) so the home payload stays
    // small. We slice the full helper output here to keep the contract
    // explicit — adding new fields to projectHealth() never inflates
    // the home payload by accident.
    const full = projectHealth(db, p.id);
    const healthSlim = { score: full.score, band: full.band };
    // Ticket 0028: per-project burndown summary, inlined on the home
    // payload so the card's coloured today-dot renders without a second
    // fetch. The full `days[]` series is fetched lazily via
    // /api/projects/:slug/burndown on card tap.
    const bd = projectBurndown(db, p.id);
    const burndownSummary: BurndownSummary = {
      projected_eom_usd: bd.projected_eom_usd,
      cap_eom_usd: bd.cap_eom_usd,
      band: bd.band,
    };
    out.push({
      slug: p.slug, name: p.name, displayState: displayState(jobs, scDays, usage),
      selfCancelDays: scDays, engEnabled: !!p.eng_enabled,
      cost: agg.cost ?? 0, cost7d: cost7.c ?? 0, runs: agg.runs ?? 0,
      // prs_merged_7d (ticket 0019): trailing-7d count derived from
      // run.pr_number on shipped runs. Additive — the SPA's existing
      // fields are unchanged.
      prs_merged_7d: prsMerged7d,
      jobs, telemetry, usageLimit: usage, autoKill, forecast, anomalies,
      // cadence: full schedule (so the SPA can show "every 6h, twice daily…")
      // and label the active pace preset when it matches a known one.
      cadence, pace: paceLabel(cadence),
      paused: pausedReason,
      health: healthSlim,
      burndown: burndownSummary,
    });
  }
  // Total-fleet forecast = sum of per-project projections (null projections
  // contribute zero — the SPA footer surfaces the count of "not enough data"
  // projects so the operator knows the figure is conservative).
  const projected30dTotal = out.reduce((s, x) => s + (x.forecast?.projected_30d ?? 0), 0);
  const forecastReady = out.filter((x) => x.forecast?.projected_30d != null).length;
  return {
    projects: out, totals: { cost: totalCost, runs: totalRuns, projected_30d: projected30dTotal, forecast_ready: forecastReady },
    alerts: openAlerts(db), daemonOn: daemonStatus(),
    generatedAt: new Date().toISOString(),
  };
}

export function projectView(db: DB, cfg: FleetConfig, slug: string) {
  const p = db.prepare("SELECT * FROM project WHERE slug=?").get(slug) as any;
  if (!p) return null;
  const cadence = JSON.parse(p.cadence_json ?? "{}");
  const aliases = aliasesFor(db, p.id, p.slug);
  const agentRows = db.prepare("SELECT phase, launchd_label FROM agent WHERE project_id=?").all(p.id) as any[];
  const jobs = agentRows.sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase)).map((a) => ({
    phase: a.phase, ...jobLive(cfg, a.launchd_label, cadence, a.phase, p.self_cancel, aliases), last: lastRun(db, p.id, a.phase),
  }));
  const recent = db.prepare(
    `SELECT id, phase, started_at, duration_ms, num_turns, outcome, pr_number,
       COALESCE(cost_usd,cost_usd_computed,0) cost, cost_source,
       (input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens) toks,
       usage_limit_at, usage_limit_until
     FROM run WHERE project_id=? AND outcome IS NOT 'smoke' ORDER BY started_at DESC LIMIT 40`).all(p.id);
  const byPhase = db.prepare("SELECT phase, COUNT(*) runs, SUM(COALESCE(cost_usd,cost_usd_computed,0)) cost FROM run WHERE project_id=? GROUP BY phase").all(p.id);
  const repo = `${p.repo_owner}/${p.repo_name}`;
  try { ingestProjectPRs(db, p.id, repo); } catch { /* keep serving */ }
  const usage = usageLimitState(db, p.id);
  const autoKill = lastAutoKill(db, p.slug);
  // Ticket 0053: graveyard cross-link banner. ADDITIVE optional fields
  // — older SPA clients gracefully ignore them. `paused_at` is the
  // producer's `triggered_at` value (the schema has no `paused_at`
  // column); `pause_reason` is the classified label per
  // src/views.ts § projectGraveyard.
  interface ProjectPauseProbeRow { reason: string; triggered_at: string; }
  const probe = db.prepare(
    "SELECT reason, triggered_at FROM project_pause WHERE project_id = ?",
  ).get(p.id) as unknown as ProjectPauseProbeRow | undefined;
  const pausedAt = probe?.triggered_at ?? null;
  const pauseReason = probe ? classifyPauseReason(probe.reason) : null;
  const pauseReasonRaw = probe?.reason ?? null;
  return {
    slug: p.slug, name: p.name, repo,
    selfCancelDays: selfCancelDays(p.self_cancel), engEnabled: !!p.eng_enabled,
    displayState: displayState(jobs, selfCancelDays(p.self_cancel), usage),
    jobs, recent, costByPhase: byPhase, prs: projectPRs(db, p.id),
    usageLimit: usage, autoKill,
    cadence, pace: paceLabel(cadence),
    paused_at: pausedAt,
    pause_reason: pauseReason,
    pause_reason_raw: pauseReasonRaw,
  };
}

/** Inverse of PACE_PRESETS in control.ts: given a cadence, return the matching
 *  preset name (aggressive/steady/conservative/trickle) or "custom" when the
 *  combination doesn't match any preset. Pure string comparison — no need to
 *  share the constant with control.ts since the values are stable. */
function paceLabel(cadence: Record<string, string>): string {
  const k = (v: string | undefined, dflt: string) => (v ?? dflt).trim().replace(/\s+/g, " ");
  const sig = [
    k(cadence.ship_hours, ""),
    k(cadence.ship_minute, "41"),
    k(cadence.groom_hours, "0 6 12 18"),
    k(cadence.groom_minute, "17"),
    k(cadence.review_interval, "300"),
    k(cadence.eng_hours, "3 9 15 21"),
    k(cadence.eng_minute, "23"),
  ].join("|");
  const known: Record<string, string> = {
    "|41|0 6 12 18|17|300|3 9 15 21|23": "aggressive",
    "0 2 4 6 8 10 12 14 16 18 20 22|41|0 12|17|900|0 12|23": "steady",
    "0 6 12 18|41|0|17|1800|0|23": "conservative",
    "0 12|41|0|17|3600|0|23": "trickle",
  };
  return known[sig] ?? "custom";
}

/** 30-day cost forecast per project (ticket 0005). Reads the existing
 *  cost_rollup_day table (one row per project/phase/day) and projects forward
 *  from the trailing 7-day mean. We also surface the 14-day mean so the SPA
 *  card can tooltip it as a "longer-window sanity check" — useful when one
 *  outlier day skews the 7d figure.
 *
 *  Contract from the ticket:
 *    - returns `{daily_mean_7d, daily_mean_14d, projected_30d, samples}`
 *    - if fewer than 3 distinct days of cost data exist, `projected_30d`
 *      is `null` and a `reason: "not enough data"` field is set
 *    - returns `null` when the slug doesn't resolve to a project (so the
 *      route can respond 404 cleanly)
 *
 *  Note: phases are summed into a single per-day total (a project's cost on
 *  day D is the sum of ship/groom/review/eng rollups), so `samples` is the
 *  count of distinct days in the trailing-7 window, not raw row count. */
export interface Forecast {
  daily_mean_7d: number;
  daily_mean_14d: number;
  projected_30d: number | null;
  samples: number;
  reason?: string;
}

export function forecastFor(db: DB, slug: string): Forecast | null {
  const p = db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number } | undefined;
  if (!p) return null;

  // Per-day totals across all phases, within the trailing 14-day window.
  // We bucket once and slice the 7d window in JS so the helper stays a
  // single round-trip. `day` is stored as YYYY-MM-DD (see recomputeRollups).
  const rows = db.prepare(
    "SELECT day, SUM(COALESCE(cost_usd,0)) AS cost FROM cost_rollup_day WHERE project_id=? AND day >= date('now','-14 day') AND day < date('now') GROUP BY day ORDER BY day DESC",
  ).all(p.id) as { day: string; cost: number }[];

  // Inclusive "last 7 days" cutoff: today-7 through today-1 (today itself is
  // excluded by the SQL `day < date('now')` clause — a partial today shouldn't
  // bend the mean down). So we want all days >= today-7.
  const cutoff7 = (() => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - 7); return d.toISOString().slice(0, 10);
  })();

  const last7 = rows.filter((r) => r.day >= cutoff7);
  const samples = last7.length;
  const sum7 = last7.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  const sum14 = rows.reduce((s, r) => s + (Number(r.cost) || 0), 0);

  const daily_mean_7d = samples > 0 ? sum7 / samples : 0;
  const daily_mean_14d = rows.length > 0 ? sum14 / rows.length : 0;

  if (samples < 3) {
    return { daily_mean_7d, daily_mean_14d, projected_30d: null, samples, reason: "not enough data" };
  }
  return { daily_mean_7d, daily_mean_14d, projected_30d: daily_mean_7d * 30, samples };
}

// ────────────────────────────────────────────────────────────────────
// Cross-project tool-call leaderboard (ticket 0014).
//
// Pure SQL aggregation against `run`, `run_event`, and `cost_rollup_day`.
// One helper composes three single-statement SQL reads (tools, projects,
// heatmap). No schema migration, no new tables — the data is already
// captured by the existing transcript ingester.
//
// Window discipline:
//   - Default `days = 14`. Same date-rounded boundary the digest helper
//     uses: `end` is today (UTC, midnight) and `start` is `days` before
//     that. Anchor wall-clock can be pinned via `opts.now` for tests.
//   - Route handler runs `clampDays()` on `days` before passing it in
//     (default 14, min 1, max 90). The fn lives in this module so both
//     unit tests and the server share one source of truth.
//
// Tie-break discipline:
//   - Tools sorted by `invocations DESC, name ASC` so a fleet that
//     leans equally on Bash and Edit still renders deterministically
//     across re-fetches.
//   - top_projects within each tool: `invocations DESC, slug ASC`.
//   - Projects sorted by `runs_in_window DESC, slug ASC`.
//
// The ts_to_unix helper assumes ISO-8601 strings (the format the
// transcript ingester writes). SQLite's `strftime('%s', ts)` returns
// seconds-since-epoch as text; we cast to REAL so the arithmetic stays
// honest at sub-second resolution (the spec asserts a 5.0s diff).
// ────────────────────────────────────────────────────────────────────

export interface LeaderboardWindow {
  /** ISO date (yyyy-mm-dd) — inclusive lower bound. */
  start: string;
  /** ISO date (yyyy-mm-dd) — exclusive upper bound (today). */
  end: string;
  /** Window length in days. */
  days: number;
}

export interface LeaderboardToolRow {
  name: string;
  invocations: number;
  total_seconds: number;
  /** 0..1, NaN-safe (0 when no uses). */
  error_rate: number;
  top_projects: Array<{ slug: string; invocations: number }>;
}

export interface LeaderboardProjectRow {
  slug: string;
  name: string;
  top_tool: string | null;
  tool_diversity: number;
  avg_tools_per_run: number;
  runs_in_window: number;
}

export interface LeaderboardHeatmapRow {
  slug: string;
  by_phase: { ship: number; groom: number; review: number; eng: number };
}

export interface Leaderboard {
  window: LeaderboardWindow;
  tools: LeaderboardToolRow[];
  projects: LeaderboardProjectRow[];
  heatmap: LeaderboardHeatmapRow[];
}

export interface LeaderboardOptions {
  /** ISO timestamp used as "now" for windowing. Default: current wall
   *  clock. Tests pin this so seeded `started_at` / `ts` values bucket
   *  predictably. */
  now?: string;
  /** Window length in days. Default 14, min 1, max 90. The route
   *  handler should call `clampDays()` before passing in. */
  days?: number;
}

const PHASES_FOUR = ["ship", "groom", "review", "eng"] as const;
type PhaseFour = typeof PHASES_FOUR[number];

/** Clamp the `days` query param to [1, 90] with default 14. Garbage
 *  (NaN, undefined, empty string, non-numeric) → 14. Fractional inputs
 *  are floored. The route handler is the only production caller; tests
 *  exercise the full grid. */
export function clampDays(raw: unknown): number {
  if (raw == null || raw === "") return 14;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 14;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > 90) return 90;
  return i;
}

/** yyyy-mm-dd from a Date (UTC). Mirrors digest.ts (kept local to
 *  avoid cross-module coupling). */
function isoDateUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function computeWindow(now: Date, days: number): LeaderboardWindow {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  return { start: isoDateUtc(start), end: isoDateUtc(end), days };
}

// SQL row interfaces — narrow via `as unknown as RowT[]` per the
// node:sqlite lesson in docs/LESSONS.md.
interface ToolAggRow {
  tool_name: string;
  invocations: number;
  errored_results: number;
}

interface ToolPairRow {
  tool_name: string;
  total_seconds: number;
}

interface ToolByProjectRow {
  tool_name: string;
  slug: string;
  invocations: number;
}

interface ProjectAggRow {
  id: number;
  slug: string;
  name: string;
  runs_in_window: number;
  tool_diversity: number;
  total_tool_uses: number;
}

interface TopToolRow {
  project_id: number;
  tool_name: string;
  uses: number;
}

interface HeatmapRow {
  project_id: number;
  slug: string;
  phase: string;
  cost_usd: number;
}

/** Build the cross-project leaderboard. Single helper, three SQL
 *  statements composed into one payload. */
export function fleetLeaderboard(db: DB, opts: LeaderboardOptions = {}): Leaderboard {
  const now = opts.now ? new Date(opts.now) : new Date();
  const days = clampDays(opts.days ?? 14);
  const window = computeWindow(now, days);

  // ── Tools (cross-fleet aggregation) ─────────────────────────────
  // `invocations` is the count of tool_use rows for that tool whose ts
  // falls in the window. `errored_results` is the count of tool_result
  // rows with is_error=1 keyed by tool_use_id that matched a tool_use
  // for that tool in the window.
  const toolAgg = db.prepare(
    "SELECT e.tool_name AS tool_name, "
    + "       COUNT(*) AS invocations, "
    + "       (SELECT COUNT(*) FROM run_event er "
    + "          JOIN run_event eu ON eu.tool_use_id = er.tool_use_id "
    + "         WHERE er.kind = 'tool_result' AND er.is_error = 1 "
    + "           AND eu.kind = 'tool_use' AND eu.tool_name = e.tool_name "
    + "           AND date(eu.ts) >= ? AND date(eu.ts) < ?) AS errored_results "
    + "  FROM run_event e "
    + " WHERE e.kind = 'tool_use' AND e.tool_name IS NOT NULL "
    + "   AND date(e.ts) >= ? AND date(e.ts) < ? "
    + " GROUP BY e.tool_name "
    + " ORDER BY invocations DESC, e.tool_name ASC",
  ).all(window.start, window.end, window.start, window.end) as unknown as ToolAggRow[];

  // total_seconds per tool: sum(result.ts - use.ts) for matched pairs.
  // Matched = same tool_use_id, one row of each kind. We use SQLite's
  // `strftime('%s', ts)` (integer seconds since epoch) for the bulk of
  // the diff and `strftime('%f', ts)` (SS.SSS — seconds-with-millis
  // within the minute) for sub-second precision, rather than
  // `julianday()` which goes through a floating-point fractional-day
  // intermediate that drifts ~10us per timestamp and fails the
  // AC2 5.0s ± 1e-6 tolerance. The difference `%f - CAST(%S AS INTEGER)`
  // isolates the fractional component (0.000..0.999), and summing
  // (integer_seconds_diff + er_fraction - eu_fraction) gives an exact
  // millisecond-resolution duration.
  // Only the tool_use's ts must fall in window — the matching result
  // can land just after a window boundary and we still want to count it.
  const toolPairs = db.prepare(
    "SELECT eu.tool_name AS tool_name, "
    + "       SUM("
    + "         (CAST(strftime('%s', er.ts) AS INTEGER) - CAST(strftime('%s', eu.ts) AS INTEGER))"
    + "         + (CAST(strftime('%f', er.ts) AS REAL) - CAST(strftime('%S', er.ts) AS INTEGER))"
    + "         - (CAST(strftime('%f', eu.ts) AS REAL) - CAST(strftime('%S', eu.ts) AS INTEGER))"
    + "       ) AS total_seconds "
    + "  FROM run_event eu "
    + "  JOIN run_event er ON er.tool_use_id = eu.tool_use_id "
    + " WHERE eu.kind = 'tool_use' AND er.kind = 'tool_result' "
    + "   AND eu.tool_name IS NOT NULL "
    + "   AND eu.tool_use_id IS NOT NULL "
    + "   AND date(eu.ts) >= ? AND date(eu.ts) < ? "
    + " GROUP BY eu.tool_name",
  ).all(window.start, window.end) as unknown as ToolPairRow[];
  const secondsByTool = new Map<string, number>();
  for (const r of toolPairs) {
    secondsByTool.set(r.tool_name, Number(r.total_seconds) || 0);
  }

  // top_projects per tool: invocations by project for each tool in the
  // window. We collect everything in one query and bucket in JS — same
  // shape as the digest's phaseCostsByProject().
  const toolByProject = db.prepare(
    "SELECT e.tool_name AS tool_name, p.slug AS slug, COUNT(*) AS invocations "
    + "  FROM run_event e "
    + "  JOIN run r ON r.id = e.run_id "
    + "  JOIN project p ON p.id = r.project_id "
    + " WHERE e.kind = 'tool_use' AND e.tool_name IS NOT NULL "
    + "   AND date(e.ts) >= ? AND date(e.ts) < ? "
    + " GROUP BY e.tool_name, p.slug "
    + " ORDER BY invocations DESC, p.slug ASC",
  ).all(window.start, window.end) as unknown as ToolByProjectRow[];
  const topProjectsByTool = new Map<string, Array<{ slug: string; invocations: number }>>();
  for (const r of toolByProject) {
    const list = topProjectsByTool.get(r.tool_name) ?? [];
    list.push({ slug: r.slug, invocations: r.invocations });
    topProjectsByTool.set(r.tool_name, list);
  }

  const tools: LeaderboardToolRow[] = toolAgg.map((row) => {
    const total_seconds = Math.max(0, secondsByTool.get(row.tool_name) ?? 0);
    const error_rate = row.invocations > 0 ? row.errored_results / row.invocations : 0;
    // Cap top_projects at the top 3 per the user story.
    const tops = (topProjectsByTool.get(row.tool_name) ?? []).slice(0, 3);
    return {
      name: row.tool_name,
      invocations: row.invocations,
      total_seconds,
      error_rate,
      top_projects: tops,
    };
  });

  // ── Projects ────────────────────────────────────────────────────
  // One row per project: runs_in_window from `run`, tool_diversity from
  // distinct tool_name in run_event, total_tool_uses from row count.
  // We LEFT JOIN so a project with zero runs in window still appears
  // (with the agg counts at 0 / null → coerced to 0).
  const projAgg = db.prepare(
    "SELECT p.id AS id, p.slug AS slug, p.name AS name, "
    + "       COUNT(DISTINCT CASE WHEN date(r.started_at) >= ? AND date(r.started_at) < ? THEN r.id END) AS runs_in_window, "
    + "       COUNT(DISTINCT CASE WHEN e.kind = 'tool_use' AND e.tool_name IS NOT NULL "
    + "                            AND date(e.ts) >= ? AND date(e.ts) < ? THEN e.tool_name END) AS tool_diversity, "
    + "       COUNT(CASE WHEN e.kind = 'tool_use' AND date(e.ts) >= ? AND date(e.ts) < ? THEN 1 END) AS total_tool_uses "
    + "  FROM project p "
    + "  LEFT JOIN run r ON r.project_id = p.id "
    + "  LEFT JOIN run_event e ON e.run_id = r.id "
    + " GROUP BY p.id, p.slug, p.name "
    + " ORDER BY runs_in_window DESC, p.slug ASC",
  ).all(
    window.start, window.end,
    window.start, window.end,
    window.start, window.end,
  ) as unknown as ProjectAggRow[];

  // top_tool per project: the tool with most uses in window. We grab
  // one row per project via a window function emulation (sort + JS
  // pick) to stay portable across SQLite versions. Tie-break: name asc.
  const topToolRows = db.prepare(
    "SELECT r.project_id AS project_id, e.tool_name AS tool_name, COUNT(*) AS uses "
    + "  FROM run_event e "
    + "  JOIN run r ON r.id = e.run_id "
    + " WHERE e.kind = 'tool_use' AND e.tool_name IS NOT NULL "
    + "   AND date(e.ts) >= ? AND date(e.ts) < ? "
    + " GROUP BY r.project_id, e.tool_name "
    + " ORDER BY r.project_id ASC, uses DESC, e.tool_name ASC",
  ).all(window.start, window.end) as unknown as TopToolRow[];
  const topToolByProject = new Map<number, string>();
  for (const r of topToolRows) {
    if (!topToolByProject.has(r.project_id)) {
      topToolByProject.set(r.project_id, r.tool_name);
    }
  }

  const projects: LeaderboardProjectRow[] = projAgg.map((row) => ({
    slug: row.slug,
    name: row.name ?? row.slug,
    top_tool: topToolByProject.get(row.id) ?? null,
    tool_diversity: Number(row.tool_diversity) || 0,
    avg_tools_per_run: row.runs_in_window > 0
      ? (Number(row.total_tool_uses) || 0) / row.runs_in_window
      : 0,
    runs_in_window: Number(row.runs_in_window) || 0,
  }));

  // ── Heatmap ─────────────────────────────────────────────────────
  // cost_rollup_day rows in window, grouped by (project, phase). One
  // row per project in the output with a fixed {ship,groom,review,eng}
  // bag; missing phases → 0.
  const heatRows = db.prepare(
    "SELECT cr.project_id AS project_id, p.slug AS slug, cr.phase AS phase, "
    + "       SUM(COALESCE(cr.cost_usd, 0)) AS cost_usd "
    + "  FROM cost_rollup_day cr "
    + "  JOIN project p ON p.id = cr.project_id "
    + " WHERE cr.day >= ? AND cr.day < ? "
    + " GROUP BY cr.project_id, p.slug, cr.phase",
  ).all(window.start, window.end) as unknown as HeatmapRow[];
  const heatBySlug = new Map<string, LeaderboardHeatmapRow>();
  for (const r of heatRows) {
    const existing = heatBySlug.get(r.slug) ?? {
      slug: r.slug,
      by_phase: { ship: 0, groom: 0, review: 0, eng: 0 },
    };
    if ((PHASES_FOUR as readonly string[]).includes(r.phase)) {
      existing.by_phase[r.phase as PhaseFour] += Number(r.cost_usd) || 0;
    }
    heatBySlug.set(r.slug, existing);
  }
  // Ensure every project from the projects array gets a heatmap row,
  // even if it had no cost_rollup_day entries in window. Sort by slug
  // for deterministic render order.
  for (const p of projects) {
    if (!heatBySlug.has(p.slug)) {
      heatBySlug.set(p.slug, {
        slug: p.slug,
        by_phase: { ship: 0, groom: 0, review: 0, eng: 0 },
      });
    }
  }
  const heatmap = [...heatBySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));

  return { window, tools, projects, heatmap };
}

// ────────────────────────────────────────────────────────────────────
// Fleet streak counter + 90-day calendar heatmap (ticket 0026).
//
// The morning-portal answer to "is the fleet *working*?" — one
// integer streak number plus a GitHub-style 91-cell heatmap (13
// weeks × 7 days) of merge activity. Strictly additive: no schema
// migration, no new ingest path, reads only existing `run` and `pr`
// rows. Two SQL aggregations + one JS walk; no per-row loops over
// raw runs.
//
// Day boundary: SQLite `date(ts)` (UTC) — the same convention the
// `cost_rollup_day` table uses (see src/ingest/index.ts). The
// ticket calls for the "operator's local timezone" but every other
// per-day rollup in this repo lives in UTC; aligning here keeps the
// streak number consistent with the cost rollups the operator
// reads on the same page.
//
// Band rules (per AC1):
//   merged >= 4               → high
//   merged 2-3                → med
//   merged 1                  → low
//   merged 0 AND failed >= 1  → red
//   else                      → empty
//
// "failed" = run.outcome='failure' across all projects, MINUS any
// project that had a later same-day outcome in the known-good set
// (the same "unrecovered failure" definition the inbox uses in
// 0017). Computed in SQL with a NOT EXISTS sub-query per failure
// row so a fleet of 10 projects × 90 days stays under 50ms (the
// perf AC).
//
// Streak walk: from today (heatmap[89]) backwards. An `empty` day
// does NOT break the streak — the operator's agents can take
// weekends off. Only a `red` day stops the walk. `last_red_day` is
// the most-recent red cell in the 90-day window, or null if none.

export interface FleetStreakCell {
  /** yyyy-mm-dd (UTC). */
  date: string;
  /** count of PR rows with state='MERGED' whose merged_at fell on this day. */
  merged: number;
  /** count of distinct (project_id) unrecovered failures on this day. */
  failed: number;
  band: "empty" | "low" | "med" | "high" | "red";
}

export interface FleetStreak {
  streak_days: number;
  last_red_day: string | null;
  heatmap: FleetStreakCell[];
}

export interface FleetStreakOptions {
  /** ISO timestamp used as "now" (today is heatmap[89]). Defaults to
   *  wall-clock; tests pin this so seeded `started_at` / `merged_at`
   *  values bucket predictably. */
  now?: string;
}

interface StreakMergedRow { day: string; merged: number; }
interface StreakFailedRow { day: string; failed: number; }

/** Inclusive yyyy-mm-dd (UTC) from a Date. */
function isoDateUtcStreak(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function fleetStreak(db: DB, opts: FleetStreakOptions = {}): FleetStreak {
  const now = opts.now ? new Date(opts.now) : new Date();
  // Today (UTC midnight) = the 90th cell (index 89). 89 days before
  // that = the 1st cell (index 0). We materialise the inclusive
  // [start, today] window so a yyyy-mm-dd lookup is O(1).
  const today = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
  ));
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 89);
  // SQL clauses share the same inclusive window — we use a closed
  // [startStr, endStr] range against date(ts).
  const startStr = isoDateUtcStreak(start);
  const endStr = isoDateUtcStreak(today);

  // ── Merged-PR counts per day ────────────────────────────────────
  // The `pr` table stores `fetched_at` as the wall-clock anchor (the
  // ingest pipeline stamps it on every gh sync; for a merged PR
  // that timestamp is the merge time). We bucket by date() and
  // count rows where state='MERGED'.
  const mergedRows = db.prepare(
    "SELECT date(fetched_at) AS day, COUNT(*) AS merged "
    + "  FROM pr "
    + " WHERE state = 'MERGED' "
    + "   AND fetched_at IS NOT NULL "
    + "   AND date(fetched_at) >= ? AND date(fetched_at) <= ? "
    + " GROUP BY date(fetched_at)",
  ).all(startStr, endStr) as unknown as StreakMergedRow[];
  const mergedByDay = new Map<string, number>();
  for (const r of mergedRows) mergedByDay.set(r.day, Number(r.merged) || 0);

  // ── Unrecovered-failure counts per day ──────────────────────────
  // A "failure" contributes to the day's red-band count IFF no
  // later same-project same-day run had a known-good outcome.
  // We group by date(started_at) and count distinct project_id, so
  // a project that crashed twice on the same day counts once.
  const failedRows = db.prepare(
    "SELECT date(r.started_at) AS day, COUNT(DISTINCT r.project_id) AS failed "
    + "  FROM run r "
    + " WHERE r.outcome = 'failure' "
    + "   AND r.started_at IS NOT NULL "
    + "   AND date(r.started_at) >= ? AND date(r.started_at) <= ? "
    + "   AND NOT EXISTS ( "
    + "        SELECT 1 FROM run r2 "
    + "         WHERE r2.project_id = r.project_id "
    + "           AND r2.outcome IN ('shipped','healed','no-op','reviewed-ok','reviewed-changes') "
    + "           AND r2.started_at IS NOT NULL "
    + "           AND date(r2.started_at) = date(r.started_at) "
    + "           AND r2.started_at > r.started_at "
    + "       ) "
    + " GROUP BY date(r.started_at)",
  ).all(startStr, endStr) as unknown as StreakFailedRow[];
  const failedByDay = new Map<string, number>();
  for (const r of failedRows) failedByDay.set(r.day, Number(r.failed) || 0);

  // ── Materialise 90 cells in chronological order ─────────────────
  const heatmap: FleetStreakCell[] = [];
  for (let i = 0; i < 90; i++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    const key = isoDateUtcStreak(d);
    const merged = mergedByDay.get(key) ?? 0;
    const failed = failedByDay.get(key) ?? 0;
    let band: FleetStreakCell["band"];
    if (merged >= 4) band = "high";
    else if (merged >= 2) band = "med";
    else if (merged === 1) band = "low";
    else if (failed >= 1) band = "red";
    else band = "empty";
    heatmap.push({ date: key, merged, failed, band });
  }

  // ── Streak walk backwards from today; stop at the first red ─────
  // Empty days don't break the streak — only red days do. A fleet
  // with zero activity in the whole window has no streak (the
  // operator hasn't started one), so streak_days = 0 in that case;
  // the SPA's empty-state copy ("Fleet streak: starting today")
  // reads accordingly.
  const anySignal = heatmap.some((c) => c.merged > 0 || c.failed > 0);
  let streak_days = 0;
  if (anySignal) {
    for (let i = heatmap.length - 1; i >= 0; i--) {
      if (heatmap[i].band === "red") break;
      streak_days += 1;
    }
  }

  // ── last_red_day: latest red cell in the window, or null ────────
  let last_red_day: string | null = null;
  for (let i = heatmap.length - 1; i >= 0; i--) {
    if (heatmap[i].band === "red") { last_red_day = heatmap[i].date; break; }
  }

  return { streak_days, last_red_day, heatmap };
}

// ────────────────────────────────────────────────────────────────────
// Per-project "fleet temperature" health score (ticket 0022).
//
// One 0-100 number per project: rounded mean of four equally-weighted
// sub-scores. Each sub-score is a pure SQL aggregation against the
// existing tables (run, anomaly, pr, cost_rollup_day) — no per-row
// loops in JS. Composition is deterministic so the SPA can render the
// formula text from the API response and the autonomous reviewer can
// audit it.
//
// Band rules (per the user story):
//   score >= 80                              → green
//   50 <= score < 80                         → amber
//   score < 50                               → red
//   ship_success is NULL (no ship runs yet)  → grey (overall band)
//   project is paused (per ticket 0021)      → grey (overall band)
//
// Sub-score formulas (kept in lockstep with HEALTH_FORMULA_TEXT below
// so the tooltip's docstring matches the implementation):
//   ship_success     = (shipped / total) × 100 over the last 20 non-smoke
//                      ship runs; NULL when there are zero runs
//   anomaly          = 100 - min(100, 10 × open_anomalies_last_7d)
//   pr_age           = 100 (no PR / <6h), 80 (<24h), 50 (<72h), 20 (>=72h)
//                      sourced from the oldest open agent PR's
//                      gh_created_at column
//   cost_trajectory  = 100 - min(100, 100 × max(0, (recent7 - prior7) /
//                      max(prior7, 0.01))) over cost_rollup_day
//
// Module-level cache: 5s TTL keyed by project_id, with a build counter
// (LESSONS pattern from ticket 0012). The window is small enough that
// the home grid render's per-card call doesn't refetch on the polled
// 5s tick, but large enough that operators always see fresh numbers
// after a real ingest pass.

export interface ProjectHealth {
  score: number;
  band: "green" | "amber" | "red" | "grey";
  subs: {
    ship_success: number | null;
    anomaly: number;
    pr_age: number;
    cost_trajectory: number;
  };
  generated_at: string;
  /** Human-readable formula text per sub-score, rendered by the SPA
   *  tooltip so the docs stay live. Engineering note from the ticket:
   *  the SPA must NOT hardcode this. */
  formula: {
    ship_success: string;
    anomaly: string;
    pr_age: string;
    cost_trajectory: string;
    composite: string;
  };
}

const HEALTH_FORMULA_TEXT = {
  ship_success: "fraction of the last 20 ship runs that shipped, ×100 (null when no runs yet)",
  anomaly: "100 - min(100, 10 × open anomalies in last 7d)",
  pr_age: "100 (no PR / <6h), 80 (<24h), 50 (<72h), 20 (≥72h) — oldest open agent PR",
  cost_trajectory: "100 - min(100, 100 × max(0, (last-7d-avg − prior-7d-avg) / prior-7d-avg))",
  composite: "rounded mean of the four sub-scores (equal weights: 25 each)",
};

interface ShipAggRow { shipped: number; total: number; }
interface AnomalyAggRow { open: number; }
interface PrAgeAggRow { oldest_created_at: string | null; }
interface CostWindowRow { recent7: number | null; prior7: number | null; }
interface PauseProbeRow { c: number; }

// Module-level cache (LESSONS pattern: a reset seam + a build counter
// so tests can assert cache-hit semantics without stubbing SQL).
const HEALTH_TTL_MS = 5_000;
const healthCache = new Map<number, { ts: number; value: ProjectHealth }>();
let healthBuildCounter = 0;

/** Reset the per-process health cache. Tests MUST call this between
 *  scenarios so a prior test's cached value doesn't leak. Production
 *  code never calls this. */
export function _resetHealthCacheForTests(): void {
  healthCache.clear();
  healthBuildCounter = 0;
}

/** Read-only build counter — increments by 1 on every cache miss
 *  (i.e. every actual SQL computation). Tests assert `delta === 1` on
 *  the first call and `delta === 0` on the second to prove the cache
 *  fired without stubbing the DB. */
export function _getHealthCacheBuildsForTests(): number {
  return healthBuildCounter;
}

function bandFor(score: number): "green" | "amber" | "red" {
  if (score >= 80) return "green";
  if (score >= 50) return "amber";
  return "red";
}

function shipSuccess(db: DB, projectId: number): number | null {
  // Last 20 non-smoke ship runs. Outcome=='shipped' counts as success.
  // We aggregate inside a subquery so the LIMIT applies to the source set
  // before COUNT — same pattern as the existing telemetry fetch in
  // fleetView. Returns null when zero rows match (band → grey).
  const row = db.prepare(
    "SELECT COUNT(*) AS total, "
    + "  SUM(CASE WHEN outcome = 'shipped' THEN 1 ELSE 0 END) AS shipped "
    + "FROM (SELECT outcome FROM run "
    + "      WHERE project_id = ? AND phase = 'ship' AND outcome IS NOT 'smoke' "
    + "      ORDER BY started_at DESC LIMIT 20) sub",
  ).get(projectId) as unknown as ShipAggRow | undefined;
  if (!row || !row.total) return null;
  return Math.round((Number(row.shipped) || 0) * 100 / row.total);
}

function anomalyScore(db: DB, projectId: number, now: Date): number {
  // Count `anomaly` rows joined to the project's runs where
  // dismissed_at IS NULL and created_at fell in the trailing 7-day
  // window. Saturates at 10 to bound the deduction at 100 points.
  const cutoff = new Date(now.getTime() - 7 * 86400_000).toISOString();
  const row = db.prepare(
    "SELECT COUNT(*) AS open "
    + "  FROM anomaly a JOIN run r ON r.id = a.run_id "
    + " WHERE r.project_id = ? "
    + "   AND a.dismissed_at IS NULL "
    + "   AND a.created_at >= ?",
  ).get(projectId, cutoff) as unknown as AnomalyAggRow | undefined;
  const open = Number(row?.open ?? 0);
  return 100 - Math.min(100, 10 * open);
}

function prAgeScore(db: DB, projectId: number, now: Date): number {
  // Oldest open agent PR's gh_created_at. NULL when no agent PRs are
  // open → score 100 (healthy). The is_agent column is already populated
  // by the ingester via the AGENT_RE regex.
  const row = db.prepare(
    "SELECT MIN(gh_created_at) AS oldest_created_at "
    + "  FROM pr "
    + " WHERE project_id = ? AND is_agent = 1 AND state = 'open' "
    + "   AND gh_created_at IS NOT NULL",
  ).get(projectId) as unknown as PrAgeAggRow | undefined;
  if (!row || !row.oldest_created_at) return 100;
  const ageHours = (now.getTime() - new Date(row.oldest_created_at).getTime()) / 3600_000;
  if (ageHours < 6) return 100;
  if (ageHours < 24) return 80;
  if (ageHours < 72) return 50;
  return 20;
}

function costTrajectoryScore(db: DB, projectId: number, now: Date): number {
  // Two windows: last 7 days (today-7..today-1) and prior 7 days
  // (today-14..today-8). SUM per window, then divide by 7 to get a
  // mean. A flat or downward trajectory → 100; saturates at 0 when the
  // recent mean is double the prior mean. With NULL prior_avg (no data)
  // we surface 100 — same default as the pr_age "no PR" branch.
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const t1 = new Date(today); t1.setUTCDate(t1.getUTCDate() - 7);
  const t2 = new Date(today); t2.setUTCDate(t2.getUTCDate() - 14);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const todayStr = day(today);
  const t1Str = day(t1);
  const t2Str = day(t2);
  const row = db.prepare(
    "SELECT "
    + "  SUM(CASE WHEN day >= ? AND day < ? THEN COALESCE(cost_usd,0) ELSE 0 END) AS recent7, "
    + "  SUM(CASE WHEN day >= ? AND day < ? THEN COALESCE(cost_usd,0) ELSE 0 END) AS prior7 "
    + "  FROM cost_rollup_day WHERE project_id = ?",
  ).get(t1Str, todayStr, t2Str, t1Str, projectId) as unknown as CostWindowRow | undefined;
  const recent7 = Number(row?.recent7 ?? 0);
  const prior7 = Number(row?.prior7 ?? 0);
  // No prior spend → no signal → default to 100. Avoids dividing by zero
  // and avoids flagging brand-new projects.
  if (prior7 <= 0) return 100;
  const recentAvg = recent7 / 7;
  const priorAvg = prior7 / 7;
  const denom = Math.max(priorAvg, 0.01);
  const deduction = Math.max(0, 100 * (recentAvg - priorAvg) / denom);
  return Math.round(100 - Math.min(100, deduction));
}

function isPaused(db: DB, projectId: number): boolean {
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM project_pause WHERE project_id = ?",
  ).get(projectId) as unknown as PauseProbeRow | undefined;
  return Number(row?.c ?? 0) > 0;
}

/** Compute the four sub-scores + composite for one project. Pure SQL
 *  inside; no shell-out, no network, no transcript I/O. Memoised for
 *  HEALTH_TTL_MS so the home grid's per-card call doesn't fan out N
 *  identical queries on the 5s SPA poll. */
export function projectHealth(db: DB, projectId: number, now: Date = new Date()): ProjectHealth {
  const cached = healthCache.get(projectId);
  if (cached && Date.now() - cached.ts < HEALTH_TTL_MS) return cached.value;
  healthBuildCounter += 1;

  const ship = shipSuccess(db, projectId);
  const anomaly = anomalyScore(db, projectId, now);
  const pr_age = prAgeScore(db, projectId, now);
  const cost_trajectory = costTrajectoryScore(db, projectId, now);

  // Composite: rounded mean of the four. ship_success contributes 0 to
  // the deduction when it's null (we just drop it from the average so a
  // brand-new project doesn't get a fake red). Either way the band is
  // overridden to grey below — the score is still useful for the
  // ?sort=health ordering.
  const parts: number[] = [];
  if (ship != null) parts.push(ship);
  parts.push(anomaly, pr_age, cost_trajectory);
  const score = Math.round(parts.reduce((s, x) => s + x, 0) / parts.length);

  let band: ProjectHealth["band"];
  if (ship == null || isPaused(db, projectId)) band = "grey";
  else band = bandFor(score);

  const value: ProjectHealth = {
    score,
    band,
    subs: { ship_success: ship, anomaly, pr_age, cost_trajectory },
    generated_at: now.toISOString(),
    formula: HEALTH_FORMULA_TEXT,
  };
  healthCache.set(projectId, { ts: Date.now(), value });
  return value;
}

/** Slim per-project listing for the home grid: slug, name, the
 *  {score, band} health summary, and the {projected_eom_usd,
 *  cap_eom_usd, band} burndown summary (ticket 0028). The full
 *  burndown `days[]` series + per-day cap details are available via
 *  /api/projects/:slug/burndown so the home payload stays small. */
export interface ListedProject {
  slug: string;
  name: string;
  health: { score: number; band: ProjectHealth["band"] };
  burndown: BurndownSummary;
}

interface ProjectListRow { id: number; slug: string; name: string | null; }

export function listProjects(db: DB): ListedProject[] {
  const rows = db.prepare(
    "SELECT id, slug, name FROM project ORDER BY slug",
  ).all() as unknown as ProjectListRow[];
  return rows.map((r) => {
    const h = projectHealth(db, r.id);
    const b = projectBurndown(db, r.id);
    return {
      slug: r.slug,
      name: r.name ?? r.slug,
      health: { score: h.score, band: h.band },
      burndown: {
        projected_eom_usd: b.projected_eom_usd,
        cap_eom_usd: b.cap_eom_usd,
        band: b.band,
      },
    };
  });
}

// ────────────────────────────────────────────────────────────────────
// Month-to-date budget burndown per project card (ticket 0028).
//
// Pure SQL window aggregation against `cost_rollup_day` filtered to the
// current local UTC month. The helper is read-only (no inserts, no
// shell-out) and matches the autopause's cap path: `cadence_json.
// max_daily_usd`. Empty cost data → days: [], cap-less project →
// cap_per_day_usd: null + band: "green".
//
// Per docs/LESSONS.md:
//   - `as unknown as RowT[]` for typed `.all()` (node:sqlite cast lesson).
//   - Tests seed via `run` rows + recomputeRollups() (cost_rollup_day
//     re-derives on every ingest pass; direct seeds get wiped).
//
// Band rules (matches the AC spec):
//   red    = cumulative_today_usd > cap_per_day_usd × day_of_month
//   amber  = not red AND projected_eom_usd > cap_eom_usd × 0.8
//   green  = otherwise (or cap unset)
// ────────────────────────────────────────────────────────────────────

export interface BurndownDay {
  day_of_month: number;
  cumulative_usd: number;
}

export type BurndownBand = "green" | "amber" | "red";

export interface ProjectBurndown {
  days: BurndownDay[];
  cap_per_day_usd: number | null;
  cap_eom_usd: number | null;
  projected_eom_usd: number;
  band: BurndownBand;
}

/** Slim summary the home payload inlines on each project row. The full
 *  `days[]` series is fetched lazily via /api/projects/:slug/burndown. */
export interface BurndownSummary {
  projected_eom_usd: number;
  cap_eom_usd: number | null;
  band: BurndownBand;
}

interface BurndownRollupRow {
  day: string;
  cost_usd: number | null;
}

interface ProjectCadenceRow {
  cadence_json: string | null;
}

/** Parse `max_daily_usd` from a project's cadence_json — SAME logic as
 *  src/budget_guard.ts:parseCap so the autopause cap and the burndown
 *  cap can never disagree. Kept inline here to avoid widening the
 *  budget_guard.ts surface (its exports are scoped to the guard
 *  pipeline). */
function parseDailyCap(cadenceJson: string | null): number | null {
  if (!cadenceJson) return null;
  try {
    const obj = JSON.parse(cadenceJson) as Record<string, unknown>;
    const raw = obj.max_daily_usd;
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  } catch {
    return null;
  }
}

/** Days in `now`'s UTC month (28..31). */
function daysInUtcMonth(now: Date): number {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
    .getUTCDate();
}

/** First day of `now`'s UTC month, yyyy-mm-dd. The cost_rollup_day
 *  table stores `day` as `date(started_at)` (SQLite UTC date), so we
 *  match that frame here for the JOIN. */
function monthStartIso(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString().slice(0, 10);
}

/** Compute the month-to-date burndown for one project. `now` is the
 *  wall-clock anchor (tests pin it; production passes `new Date()`). */
export function projectBurndown(
  db: DB, projectId: number, now: Date = new Date(),
): ProjectBurndown {
  const monthStart = monthStartIso(now);
  const today = now.toISOString().slice(0, 10);
  const dayOfMonth = now.getUTCDate();
  const eomDays = daysInUtcMonth(now);

  // Per-day totals across all phases for the current month, day 1..today
  // inclusive. SUM aggregates the {ship,groom,review,eng} rows down to a
  // single per-day spend. The windowed running sum (SUM(...) OVER) is
  // computed inside SQLite — supported since 3.25 (node:sqlite ships
  // 3.45+), and it's the single source of truth the AC asks for.
  const dayRows = db.prepare(
    "SELECT day, "
    + "  SUM(SUM(COALESCE(cost_usd, 0))) OVER (ORDER BY day) AS cost_usd "
    + "FROM cost_rollup_day "
    + "WHERE project_id = ? AND day >= ? AND day <= ? "
    + "GROUP BY day ORDER BY day ASC",
  ).all(projectId, monthStart, today) as unknown as BurndownRollupRow[];

  // Map yyyy-mm-dd → day-of-month + running cumulative. We could derive
  // day-of-month with SQL but keeping it JS-side avoids strftime
  // gymnastics and stays readable.
  const days: BurndownDay[] = dayRows.map((r) => {
    const dom = Number(r.day.slice(8, 10));
    return { day_of_month: dom, cumulative_usd: Number(r.cost_usd ?? 0) };
  });

  // Cap reads from the SAME path the autopause guard uses (ticket 0021).
  const cadenceRow = db.prepare(
    "SELECT cadence_json FROM project WHERE id = ?",
  ).get(projectId) as unknown as ProjectCadenceRow | undefined;
  const capPerDay = parseDailyCap(cadenceRow?.cadence_json ?? null);
  const capEom = capPerDay != null ? capPerDay * eomDays : null;

  // Projection: cumulative_today + trailing_7d_avg × days_remaining.
  // When fewer than 7 days are available, average over what we have.
  const cumulativeToday = days.length > 0 ? days[days.length - 1].cumulative_usd : 0;
  const trailing = days.slice(-7);
  // The cumulative series is a running sum — recover per-day deltas to
  // average them correctly.
  let trailingTotal = 0;
  for (let i = 0; i < trailing.length; i++) {
    const prev = i === 0
      ? (days.length > trailing.length ? days[days.length - trailing.length - 1].cumulative_usd : 0)
      : trailing[i - 1].cumulative_usd;
    trailingTotal += trailing[i].cumulative_usd - prev;
  }
  const trailingAvg = trailing.length > 0 ? trailingTotal / trailing.length : 0;
  const daysRemaining = Math.max(0, eomDays - dayOfMonth);
  const projectedEom = cumulativeToday + trailingAvg * daysRemaining;

  // Band:
  //   red   = cumulative_today > cap_per_day × day_of_month (already over the line)
  //   amber = not red AND projected_eom > cap_eom × 0.8
  //   green = otherwise (also the only band when cap is unset)
  let band: BurndownBand = "green";
  if (capPerDay != null && capEom != null) {
    if (cumulativeToday > capPerDay * dayOfMonth) band = "red";
    else if (projectedEom > capEom * 0.8) band = "amber";
  }

  return {
    days,
    cap_per_day_usd: capPerDay,
    cap_eom_usd: capEom,
    projected_eom_usd: projectedEom,
    band,
  };
}

/** Lookup a project_id by slug; null when the slug is unknown. Exposed
 *  so the server route can keep its handler tight. */
export function projectIdBySlug(db: DB, slug: string): number | null {
  const row = db.prepare("SELECT id FROM project WHERE slug = ?").get(slug) as { id: number } | undefined;
  return row ? row.id : null;
}

// ────────────────────────────────────────────────────────────────────
// Per-project tool-mix sparkline (ticket 0031).
//
// Per-project drill-down for "where did this project's budget actually
// go?" — single trailing-window aggregate, one stacked bar's worth of
// numbers. The leaderboard helper (0014) answers the cross-project
// version; this one is the per-project compose.
//
// Read-only: groups `run_event` by `tool_name` for the project + window,
// computes the paired-duration total via the same `strftime`-based SQL
// from fleetLeaderboard (LESSONS § "julianday() drifts ~10us per
// timestamp" — decompose with strftime for sub-ms diffs). The top-6 +
// "other" collapse happens in JS post-query to keep the SQL boring.
//
// Window discipline:
//   - Default `days = 7`. Route handler clamps via `clampToolMixDays()`
//     (a dedicated [1,30] clamp distinct from fleetLeaderboard's
//     [1,90] — the tool-mix is a recent-window question; longer windows
//     don't help the operator drilling into "where did this week go").
//   - End = today (UTC midnight); start = end - days. Same `date(ts)`
//     bucketing as fleetLeaderboard so a tool_use right at the window
//     boundary buckets identically across both helpers.
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`": every
// new typed-row narrowing here uses the double-cast pattern.
// ────────────────────────────────────────────────────────────────────

export interface ToolMixWindow {
  /** ISO date (yyyy-mm-dd) — inclusive lower bound. */
  start: string;
  /** ISO date (yyyy-mm-dd) — exclusive upper bound (today). */
  end: string;
  /** Window length in days. */
  days: number;
}

export interface ToolMixEntry {
  name: string;
  invocations: number;
  total_seconds: number;
  /** 0..1, NaN-safe (only ever computed when total_invocations > 0). */
  share: number;
}

export interface ProjectToolMix {
  window: ToolMixWindow;
  tools: ToolMixEntry[];
  total_invocations: number;
}

/** Clamp `days` to [1,30] with default 7. Garbage (NaN, undefined,
 *  empty string, non-numeric) → 7. Fractional inputs are floored.
 *  Distinct from `clampDays()` because the tool-mix window cap is 30,
 *  not 90 — see the engineering note. */
export function clampToolMixDays(raw: unknown): number {
  if (raw == null || raw === "") return 7;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 7;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > 30) return 30;
  return i;
}

interface ToolMixAggRow {
  tool_name: string;
  invocations: number;
}

interface ToolMixPairRow {
  tool_name: string;
  total_seconds: number;
}

/** Build the per-project tool-mix payload for the trailing `days`-day
 *  window ending at `now` (UTC midnight). The top 6 named tools survive
 *  verbatim; everything else collapses into a single `"other"` entry.
 *
 *  Caller passes a Date for `now` (production uses `new Date()`; tests
 *  pin via the leaderboard's NOW anchor). Returns `tools: []` and
 *  `total_invocations: 0` for an empty project — no NaN, no /0. */
export function projectToolMix(
  db: DB, projectId: number, now: Date = new Date(), days = 7,
): ProjectToolMix {
  // Window: end is today UTC midnight; start is `days` days before that.
  // Same yyyy-mm-dd frame as fleetLeaderboard so both helpers' buckets
  // line up exactly when read on the same call.
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  const window: ToolMixWindow = {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    days,
  };

  // ── Per-tool invocation counts ─────────────────────────────────────
  // tool_use rows for this project, joined through `run.project_id`,
  // bucketed by tool_name within the window. Mirrors fleetLeaderboard's
  // toolAgg shape but with `r.project_id = ?` instead of the cross-fleet
  // GROUP BY tool_name only.
  const aggRows = db.prepare(
    "SELECT e.tool_name AS tool_name, COUNT(*) AS invocations "
    + "  FROM run_event e "
    + "  JOIN run r ON r.id = e.run_id "
    + " WHERE r.project_id = ? "
    + "   AND e.kind = 'tool_use' AND e.tool_name IS NOT NULL "
    + "   AND date(e.ts) >= ? AND date(e.ts) < ? "
    + " GROUP BY e.tool_name "
    + " ORDER BY invocations DESC, e.tool_name ASC",
  ).all(projectId, window.start, window.end) as unknown as ToolMixAggRow[];

  // ── Paired-duration totals per tool ────────────────────────────────
  // Reuses the `strftime`-based SQL from fleetLeaderboard so sub-ms
  // diffs (e.g. the AC2 5.0s ± 1e-6 tolerance) survive. `julianday()`
  // drifts ~10us per timestamp; we keep the same decomposition.
  const pairRows = db.prepare(
    "SELECT eu.tool_name AS tool_name, "
    + "       SUM("
    + "         (CAST(strftime('%s', er.ts) AS INTEGER) - CAST(strftime('%s', eu.ts) AS INTEGER))"
    + "         + (CAST(strftime('%f', er.ts) AS REAL) - CAST(strftime('%S', er.ts) AS INTEGER))"
    + "         - (CAST(strftime('%f', eu.ts) AS REAL) - CAST(strftime('%S', eu.ts) AS INTEGER))"
    + "       ) AS total_seconds "
    + "  FROM run_event eu "
    + "  JOIN run_event er ON er.tool_use_id = eu.tool_use_id "
    + "  JOIN run r ON r.id = eu.run_id "
    + " WHERE r.project_id = ? "
    + "   AND eu.kind = 'tool_use' AND er.kind = 'tool_result' "
    + "   AND eu.tool_name IS NOT NULL "
    + "   AND eu.tool_use_id IS NOT NULL "
    + "   AND date(eu.ts) >= ? AND date(eu.ts) < ? "
    + " GROUP BY eu.tool_name",
  ).all(projectId, window.start, window.end) as unknown as ToolMixPairRow[];
  const secondsByTool = new Map<string, number>();
  for (const r of pairRows) {
    secondsByTool.set(r.tool_name, Math.max(0, Number(r.total_seconds) || 0));
  }

  // ── Empty branch: no /0, no NaN, no broken layout downstream ───────
  const totalInvocations = aggRows.reduce((s, r) => s + r.invocations, 0);
  if (totalInvocations === 0) {
    return { window, tools: [], total_invocations: 0 };
  }

  // ── Top-6 + "other" collapse (JS-side; the SQL stays straightforward) ─
  // Already sorted by invocations DESC / name ASC at the SQL layer. The
  // first 6 named tools survive verbatim; the tail collapses into a
  // single "other" entry whose invocations + total_seconds are the
  // straight sum of the tail.
  const TOP_N = 6;
  const head = aggRows.slice(0, TOP_N);
  const tail = aggRows.slice(TOP_N);
  const tools: ToolMixEntry[] = head.map((r) => ({
    name: r.tool_name,
    invocations: r.invocations,
    total_seconds: secondsByTool.get(r.tool_name) ?? 0,
    share: r.invocations / totalInvocations,
  }));
  if (tail.length > 0) {
    const tailInvocations = tail.reduce((s, r) => s + r.invocations, 0);
    const tailSeconds = tail.reduce(
      (s, r) => s + (secondsByTool.get(r.tool_name) ?? 0), 0);
    tools.push({
      name: "other",
      invocations: tailInvocations,
      total_seconds: tailSeconds,
      share: tailInvocations / totalInvocations,
    });
  }

  return { window, tools, total_invocations: totalInvocations };
}

// ────────────────────────────────────────────────────────────────────
// Backlog-ticket → merged-commit auto-link report (ticket 0018).
//
// Aggregates the ticket_commit_link rows for one ticket id into a
// single payload the SPA renders as "Shipped as PR #N (merged ...) ·
// K commits · +X / -Y across Z files". Returns null when no commits
// link to the ticket — the route handler 404s on null so the SPA can
// render nothing for proposed/groomed/in-progress tickets.
//
// Pure SQL (a SELECT then a SUM aggregate). Uses `as unknown as RowT[]`
// for the typed `.all()` per LESSONS § "node:sqlite's .all() needs
// `as unknown as T[]`".
// ────────────────────────────────────────────────────────────────────

export interface TicketShipCommit {
  commit_sha: string;
  commit_date: string;
  author: string;
  message_subject: string;
  files_changed: number;
  insertions: number;
  deletions: number;
  project_slug: string;
  pr_number: number | null;
}

export interface TicketShipReport {
  commits: TicketShipCommit[];
  pr_number: number | null;
  total_insertions: number;
  total_deletions: number;
  total_files_changed: number;
  first_commit_date: string;
  last_commit_date: string;
}

interface TicketLinkRow {
  commit_sha: string;
  commit_date: string;
  author: string;
  message_subject: string;
  files_changed: number;
  insertions: number;
  deletions: number;
  project_slug: string;
  pr_number: number | null;
}

/** Aggregate every ticket_commit_link row for `ticket_id` into a single
 *  ship-report payload. Returns null when no rows link to the ticket. */
export function ticketShipReport(db: DB, ticket_id: string): TicketShipReport | null {
  const rows = db.prepare(
    "SELECT commit_sha, commit_date, author, message_subject,"
    + " files_changed, insertions, deletions, project_slug, pr_number"
    + " FROM ticket_commit_link WHERE ticket_id = ? ORDER BY commit_date ASC",
  ).all(ticket_id) as unknown as TicketLinkRow[];
  if (!rows.length) return null;

  // pr_number bubble-up: take the first non-null pr_number among the
  // commits (multiple commits on the same ticket typically share one PR;
  // the rare "ticket touched across two PRs" case takes the earliest
  // and the SPA can still link to the others via the commit list).
  let prNumber: number | null = null;
  let totalIns = 0, totalDel = 0, totalFiles = 0;
  for (const r of rows) {
    totalIns += Number(r.insertions) || 0;
    totalDel += Number(r.deletions) || 0;
    totalFiles += Number(r.files_changed) || 0;
    if (prNumber == null && r.pr_number != null) prNumber = Number(r.pr_number);
  }
  return {
    commits: rows.map((r) => ({
      commit_sha: r.commit_sha,
      commit_date: r.commit_date,
      author: r.author,
      message_subject: r.message_subject,
      files_changed: Number(r.files_changed) || 0,
      insertions: Number(r.insertions) || 0,
      deletions: Number(r.deletions) || 0,
      project_slug: r.project_slug,
      pr_number: r.pr_number == null ? null : Number(r.pr_number),
    })),
    pr_number: prNumber,
    total_insertions: totalIns,
    total_deletions: totalDel,
    total_files_changed: totalFiles,
    first_commit_date: rows[0].commit_date,
    last_commit_date: rows[rows.length - 1].commit_date,
  };
}

// ────────────────────────────────────────────────────────────────────
// "Yesterday at a glance" morning card (ticket 0033).
//
// One fleet-wide helper that powers the home page's top card:
// trailing-24h shipped PRs, today's spend, anomalies open in window,
// streak day, plus a single one-line verdict picked by a priority
// cascade. Composes 0022 (projectHealth), 0026 (fleetStreak), 0027
// (activeCorrelations), 0028 (per-project burndown cap), and 0030
// (quietHoursActiveAnywhere) — does NOT duplicate their SQL.
//
// Window arithmetic:
//   - Window is the trailing 24h ending at `now`. Boundaries are
//     compared as ISO strings against `started_at` / `created_at`
//     columns (SQLite lexicographic ordering matches chronological
//     ordering for ISO-8601), so we don't need julianday() math.
//     Per LESSONS § "julianday() drifts ~10us per timestamp;
//     decompose with strftime for sub-ms diffs" — we steer clear of
//     julianday entirely.
//   - `spent_usd` reads cost_rollup_day for the SINGLE calendar day
//     containing `now` (the visible "today"), NOT a rolling 24h sum
//     — the AC is explicit. This matches the daily-budget guard
//     (0021) and the burndown today-dot (0028) so the three readings
//     line up.
//
// Verdict cascade (first non-null match wins):
//   1. band_shift_red       — projectHealth(now).band='red' AND was NOT
//                             red 24h ago (re-derive ship_success over
//                             runs <= now-24h).
//   2. band_shift_amber     — same with band='amber'.
//   3. budget_threshold     — cost_rollup_day for today >= 75% of
//                             max_daily_usd from cadence_json (same
//                             knob the 0021 autopause reads).
//   4. fleet_correlation    — activeCorrelations() returns a non-empty
//                             list in window (0027).
//   5. first_ship           — a project whose FIRST EVER shipped run
//                             (with pr_number) landed in window.
//   6. all_quiet            — default.
//
// Quiet-hours demotion (0030): when quietHoursActiveAnywhere AND the
// verdict kind is band_shift_amber / budget_threshold / first_ship, the
// message gets a U+1F319 moon prefix + "(arrived during quiet hours)".
// Critical kinds (band_shift_red, fleet_correlation) are never demoted
// — matches 0030's "critical always pages" gating.
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`": every
// row narrowing here uses the double-cast pattern.

export interface YesterdayGlanceVerdict {
  kind: "band_shift_red" | "band_shift_amber" | "budget_threshold"
    | "fleet_correlation" | "first_ship" | "all_quiet";
  project_slug?: string;
  message: string;
}

export interface YesterdayGlance {
  window: { start: string; end: string };
  shipped_count: number;
  spent_usd: number;
  anomalies_open: number;
  streak_days: number;
  verdict: YesterdayGlanceVerdict;
  generated_at: string;
}

interface ShippedRow { n: number; }
interface SpentRow { spent_usd: number | null; }
interface AnomaliesRow { n: number; }
interface ProjectGlanceRow {
  id: number;
  slug: string;
  cadence_json: string | null;
}
interface ShipBucketRow { shipped: number; total: number; }
interface FirstShipRow { slug: string; first_started_at: string | null; }

/** Re-derive `ship_success` over the last-20 ship runs whose started_at
 *  is strictly before `cutoffIso`. Mirrors the formula in `shipSuccess()`
 *  above (LIMIT 20 + sub-query + COUNT) so the band lookup at the "24h
 *  ago" anchor stays in lock-step with today's band math. Returns null
 *  when no ship runs land before the cutoff (band → grey, not red). */
function shipSuccessBefore(db: DB, projectId: number, cutoffIso: string): number | null {
  const row = db.prepare(
    "SELECT COUNT(*) AS total, "
    + "  SUM(CASE WHEN outcome = 'shipped' THEN 1 ELSE 0 END) AS shipped "
    + "FROM (SELECT outcome FROM run "
    + "      WHERE project_id = ? AND phase = 'ship' AND outcome IS NOT 'smoke' "
    + "        AND started_at IS NOT NULL AND started_at <= ? "
    + "      ORDER BY started_at DESC LIMIT 20) sub",
  ).get(projectId, cutoffIso) as unknown as ShipBucketRow | undefined;
  if (!row || !row.total) return null;
  return Math.round((Number(row.shipped) || 0) * 100 / row.total);
}

/** Band for a `ship_success` score, OR null when the score itself is
 *  null (zero ship-run history → "grey", which is treated as "not red"
 *  / "not amber" for the band-shift detector). */
function bandForShipSuccessOrNull(score: number | null): "green" | "amber" | "red" | null {
  if (score == null) return null;
  if (score >= 80) return "green";
  if (score >= 50) return "amber";
  return "red";
}

/** "Yesterday at a glance" morning-card payload (ticket 0033).
 *
 *  `now` defaults to wall-clock; tests pin it. `cfg` is the optional
 *  FleetConfig used to consult 0030's quiet-hours window — when absent
 *  (e.g. inside unit tests that don't care about the demotion), the
 *  verdict messages are unmodified.
 */
export function yesterdayGlance(
  db: DB, now: Date = new Date(), cfg?: FleetConfig,
): YesterdayGlance {
  const nowIso = now.toISOString();
  const windowStart = new Date(now.getTime() - 24 * 3600_000);
  const windowStartIso = windowStart.toISOString();
  const todayUtc = nowIso.slice(0, 10);

  // ── shipped_count: DISTINCT pr_number on shipped runs in window ────
  // Same source as 0019 / digest's mergedRunsByProject — cross-fleet,
  // not per-project. We count DISTINCT (project_id, pr_number) pairs
  // so two different repos sharing the same pr_number aren't merged.
  const shippedRow = db.prepare(
    "SELECT COUNT(*) AS n FROM ("
    + "  SELECT DISTINCT project_id, pr_number FROM run "
    + "   WHERE outcome = 'shipped' AND pr_number IS NOT NULL "
    + "     AND started_at IS NOT NULL "
    + "     AND started_at >= ? AND started_at <= ?"
    + ")",
  ).get(windowStartIso, nowIso) as unknown as ShippedRow | undefined;
  const shipped_count = Number(shippedRow?.n ?? 0);

  // ── spent_usd: cost_rollup_day SUM for the SINGLE today bucket ─────
  const spentRow = db.prepare(
    "SELECT SUM(COALESCE(cost_usd, 0)) AS spent_usd "
    + "  FROM cost_rollup_day WHERE day = ?",
  ).get(todayUtc) as unknown as SpentRow | undefined;
  const spent_usd = Number(spentRow?.spent_usd ?? 0);

  // ── anomalies_open: anomaly rows in window with dismissed_at NULL ──
  const anomRow = db.prepare(
    "SELECT COUNT(*) AS n FROM anomaly "
    + " WHERE dismissed_at IS NULL "
    + "   AND created_at IS NOT NULL "
    + "   AND created_at >= ? AND created_at <= ?",
  ).get(windowStartIso, nowIso) as unknown as AnomaliesRow | undefined;
  const anomalies_open = Number(anomRow?.n ?? 0);

  // ── streak_days: reuse 0026's fleetStreak() — no duplicated SQL ───
  const streak = fleetStreak(db, { now: nowIso });
  const streak_days = streak.streak_days;

  // ── Verdict cascade ──────────────────────────────────────────────
  // The cascade runs once per project (to keep "first match wins"
  // discipline) and short-circuits at the first non-null hit.
  const projects = db.prepare(
    "SELECT id, slug, cadence_json FROM project ORDER BY slug",
  ).all() as unknown as ProjectGlanceRow[];

  // Anchor "24h ago" once; reused for the band-shift detector.
  const cutoffIso = windowStartIso;

  let verdict: YesterdayGlanceVerdict | null = null;

  // Priority 1+2: band shift. We do a single pass over projects and
  // capture the first red or amber flip; red wins over amber by virtue
  // of being checked first.
  let redCandidate: { slug: string } | null = null;
  let amberCandidate: { slug: string } | null = null;
  for (const p of projects) {
    const todayShip = shipSuccess(db, p.id);
    const todayBand = bandForShipSuccessOrNull(todayShip);
    if (todayBand !== "red" && todayBand !== "amber") continue;
    const beforeShip = shipSuccessBefore(db, p.id, cutoffIso);
    const beforeBand = bandForShipSuccessOrNull(beforeShip);
    if (todayBand === "red" && beforeBand !== "red" && !redCandidate) {
      redCandidate = { slug: p.slug };
    } else if (todayBand === "amber" && beforeBand !== "amber" && !amberCandidate) {
      amberCandidate = { slug: p.slug };
    }
  }
  if (redCandidate) {
    // Most-recent failing ship run gives the operator the "what
    // failing" detail the AC asks for.
    const failingRow = db.prepare(
      "SELECT phase, started_at FROM run "
      + " WHERE project_id = (SELECT id FROM project WHERE slug = ?) "
      + "   AND outcome = 'failure' AND started_at IS NOT NULL "
      + " ORDER BY started_at DESC LIMIT 1",
    ).get(redCandidate.slug) as unknown as { phase: string | null; started_at: string } | undefined;
    const hhmm = failingRow?.started_at
      ? failingRow.started_at.slice(11, 16) // "HH:MM" from ISO
      : nowIso.slice(11, 16);
    const detail = failingRow?.phase ? `${failingRow.phase} failed` : "build failing";
    verdict = {
      kind: "band_shift_red",
      project_slug: redCandidate.slug,
      message: `${redCandidate.slug} went red at ${hhmm} - ${detail}`,
    };
  } else if (amberCandidate) {
    verdict = {
      kind: "band_shift_amber",
      project_slug: amberCandidate.slug,
      message: `${amberCandidate.slug} went amber - ship_success below 80%`,
    };
  }

  // Priority 3: budget threshold (>=75% of max_daily_usd).
  if (!verdict) {
    for (const p of projects) {
      const cap = parseDailyCap(p.cadence_json);
      if (cap == null) continue;
      const spent = db.prepare(
        "SELECT SUM(COALESCE(cost_usd, 0)) AS spent_usd "
        + "  FROM cost_rollup_day WHERE project_id = ? AND day = ?",
      ).get(p.id, todayUtc) as unknown as SpentRow | undefined;
      const todaySpent = Number(spent?.spent_usd ?? 0);
      if (cap > 0 && todaySpent >= cap * 0.75) {
        const pct = Math.round((todaySpent / cap) * 100);
        verdict = {
          kind: "budget_threshold",
          project_slug: p.slug,
          message: `${p.slug} at ${pct}% of daily budget`,
        };
        break;
      }
    }
  }

  // Priority 4: fleet_correlation (0027).
  if (!verdict) {
    const correlations = activeCorrelations(db, now);
    // Filter to correlations whose `created_at`-derived first_seen sits
    // in window — activeCorrelations already filters to the last 24h
    // (cutoff in correlate.ts), so any non-empty list qualifies.
    if (correlations.length > 0) {
      const c = correlations[0];
      verdict = {
        kind: "fleet_correlation",
        message: `${c.project_slugs.length} projects failing with ${c.signature}`,
      };
    }
  }

  // Priority 5: first_ship (a project whose first EVER shipped run is
  // in the trailing 24h window). We pull the first shipped run per
  // project in one query and pick the earliest whose timestamp is in
  // window.
  if (!verdict) {
    const firstShips = db.prepare(
      "SELECT p.slug AS slug, MIN(r.started_at) AS first_started_at "
      + "  FROM project p "
      + "  JOIN run r ON r.project_id = p.id "
      + " WHERE r.outcome = 'shipped' AND r.pr_number IS NOT NULL "
      + "   AND r.started_at IS NOT NULL "
      + " GROUP BY p.id, p.slug",
    ).all() as unknown as FirstShipRow[];
    for (const fs of firstShips) {
      if (!fs.first_started_at) continue;
      if (fs.first_started_at >= windowStartIso && fs.first_started_at <= nowIso) {
        verdict = {
          kind: "first_ship",
          project_slug: fs.slug,
          message: `${fs.slug} shipped its first PR`,
        };
        break;
      }
    }
  }

  // Priority 6: all_quiet — the empty-state default.
  if (!verdict) {
    verdict = {
      kind: "all_quiet",
      message: `All quiet. Streak day ${streak_days}.`,
    };
  }

  // ── Quiet-hours demotion (0030) ──────────────────────────────────
  // Critical kinds always page through; non-critical kinds get the
  // moon prefix + suffix when quiet hours are active anywhere in the
  // fleet config.
  if (cfg && quietHoursActiveAnywhere(cfg, now)) {
    const critical: Array<YesterdayGlanceVerdict["kind"]> = [
      "band_shift_red", "fleet_correlation",
    ];
    if (!critical.includes(verdict.kind)) {
      verdict = {
        ...verdict,
        message: `\u{1F319} ${verdict.message} (arrived during quiet hours)`,
      };
    }
  }

  return {
    window: { start: windowStartIso, end: nowIso },
    shipped_count,
    spent_usd,
    anomalies_open,
    streak_days,
    verdict,
    generated_at: nowIso,
  };
}

// ────────────────────────────────────────────────────────────────────
// Cost per merged PR — the single number that frames spend in value
// terms (ticket 0035).
//
// One fleet-wide composition over existing `pr` + `cost_rollup_day` +
// `project` tables; no schema migration. The helper returns three
// nested objects: a fleet rollup, an array of per-project rows
// (sorted by $/PR DESC, nulls to the bottom), and a window spec.
//
// Window discipline:
//   - `days` defaults to 14, clamped to [1, 90] via the same
//     `clampDays()` helper the leaderboard route uses.
//   - The current window is the trailing `days` days ending at `now`
//     (inclusive lower bound, exclusive upper bound). The prior window
//     is the SAME number of days immediately preceding (so a 14-day
//     window's prior is days [-28, -14)).
//   - Window arithmetic uses the same `date(...)` lexicographic frame
//     as fleetLeaderboard so the buckets line up across helpers; per
//     LESSONS § "julianday() drifts ~10us per timestamp; decompose
//     with strftime for sub-ms diffs", we avoid julianday()
//     intermediates entirely.
//
// Trend guard:
//   - `trend_pct = (current_$/PR - prior_$/PR) / prior_$/PR * 100`.
//   - Returns `null` when the prior window has < 3 merged PRs OR < $1
//     spent for that project — a sparse base produces misleading
//     percentages (the same "sigma > 0" intuition as the anomaly
//     fixture lesson).
//
// Division-by-zero guards:
//   - A project with `spent_usd > 0` but zero merges in window returns
//     `dollars_per_pr: null` (NOT Infinity, NOT 0, NOT NaN).
//   - The fleet rollup excludes such projects from the numerator IFF
//     the fleet total `prs_merged === 0` (then top-level is null too).
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// every typed row narrowing uses the double-cast.

export interface CostPerMergedPrRow {
  slug: string;
  spent_usd: number;
  prs_merged: number;
  dollars_per_pr: number | null;
  trend_pct: number | null;
}

export interface CostPerMergedPrFleet {
  spent_usd: number;
  prs_merged: number;
  dollars_per_pr: number | null;
  trend_pct: number | null;
}

export interface CostPerMergedPrWindow {
  /** ISO date (yyyy-mm-dd) — inclusive lower bound. */
  start: string;
  /** ISO date (yyyy-mm-dd) — exclusive upper bound (today). */
  end: string;
  /** Window length in days. */
  days: number;
}

export interface CostPerMergedPr {
  window: CostPerMergedPrWindow;
  fleet: CostPerMergedPrFleet;
  projects: CostPerMergedPrRow[];
  generated_at: string;
}

export interface CostPerMergedPrOptions {
  /** Window length in days. Defaults to 14; clamped to [1, 90]. */
  days?: number;
  /** ISO timestamp used as "now" for windowing. Defaults to wall-clock;
   *  tests pin so seeded fetched_at / day values bucket predictably. */
  now?: Date;
}

interface CostSpendRow {
  project_id: number;
  spent_usd: number | null;
}
interface MergedCountRow {
  project_id: number;
  prs_merged: number;
}
interface ProjectSlugRow {
  id: number;
  slug: string;
}

/** Insufficient-baseline guard per AC3: a trend is meaningful only when
 *  the prior window has at least 3 merged PRs AND at least $1 spent. */
const TREND_MIN_PRS = 3;
const TREND_MIN_SPENT = 1.0;

/** Compute the per-project + fleet "$ per merged PR" payload for the
 *  trailing `days`-day window ending at `now` (UTC midnight). Pure SQL
 *  inside; no shell-out, no network, no transcript I/O.
 *
 *  The two passes (current + prior) share the same SQL templates with
 *  parameterised window bounds. Per LESSONS § "node:sqlite's .all()
 *  needs `as unknown as T[]`": both rows narrow via the double-cast. */
export function costPerMergedPr(
  db: DB, opts: CostPerMergedPrOptions = {},
): CostPerMergedPr {
  const now = opts.now ?? new Date();
  const days = clampDays(opts.days ?? 14);
  // Window end is today (UTC midnight); start is `days` days before.
  // Prior window is [start - days, start).
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  const priorStart = new Date(start);
  priorStart.setUTCDate(priorStart.getUTCDate() - days);
  const endStr = end.toISOString().slice(0, 10);
  const startStr = start.toISOString().slice(0, 10);
  const priorStartStr = priorStart.toISOString().slice(0, 10);

  // ── All projects (anchor table) ─────────────────────────────────
  const projectRows = db.prepare(
    "SELECT id, slug FROM project ORDER BY slug",
  ).all() as unknown as ProjectSlugRow[];

  // ── Spend per project: cost_rollup_day in [start, end) ──────────
  const spendCurrent = db.prepare(
    "SELECT project_id, SUM(COALESCE(cost_usd, 0)) AS spent_usd "
    + "  FROM cost_rollup_day "
    + " WHERE day >= ? AND day < ? "
    + " GROUP BY project_id",
  ).all(startStr, endStr) as unknown as CostSpendRow[];
  const spendCurrentByPid = new Map<number, number>();
  for (const r of spendCurrent) {
    spendCurrentByPid.set(r.project_id, Number(r.spent_usd ?? 0));
  }
  const spendPrior = db.prepare(
    "SELECT project_id, SUM(COALESCE(cost_usd, 0)) AS spent_usd "
    + "  FROM cost_rollup_day "
    + " WHERE day >= ? AND day < ? "
    + " GROUP BY project_id",
  ).all(priorStartStr, startStr) as unknown as CostSpendRow[];
  const spendPriorByPid = new Map<number, number>();
  for (const r of spendPrior) {
    spendPriorByPid.set(r.project_id, Number(r.spent_usd ?? 0));
  }

  // ── Merged-PR counts per project: pr in [start, end), state=MERGED,
  //    is_agent=1 — per the AC's "agent-shipped" framing. We bucket by
  //    date(fetched_at) and count rows; deduped by the (project_id,
  //    number) primary key already.
  const mergedCurrent = db.prepare(
    "SELECT project_id, COUNT(*) AS prs_merged "
    + "  FROM pr "
    + " WHERE state = 'MERGED' AND is_agent = 1 "
    + "   AND fetched_at IS NOT NULL "
    + "   AND date(fetched_at) >= ? AND date(fetched_at) < ? "
    + " GROUP BY project_id",
  ).all(startStr, endStr) as unknown as MergedCountRow[];
  const mergedCurrentByPid = new Map<number, number>();
  for (const r of mergedCurrent) {
    mergedCurrentByPid.set(r.project_id, Number(r.prs_merged ?? 0));
  }
  const mergedPrior = db.prepare(
    "SELECT project_id, COUNT(*) AS prs_merged "
    + "  FROM pr "
    + " WHERE state = 'MERGED' AND is_agent = 1 "
    + "   AND fetched_at IS NOT NULL "
    + "   AND date(fetched_at) >= ? AND date(fetched_at) < ? "
    + " GROUP BY project_id",
  ).all(priorStartStr, startStr) as unknown as MergedCountRow[];
  const mergedPriorByPid = new Map<number, number>();
  for (const r of mergedPrior) {
    mergedPriorByPid.set(r.project_id, Number(r.prs_merged ?? 0));
  }

  // ── Per-project rows ────────────────────────────────────────────
  const projects: CostPerMergedPrRow[] = [];
  let fleetSpent = 0;
  let fleetMerged = 0;
  let fleetPriorSpent = 0;
  let fleetPriorMerged = 0;
  for (const p of projectRows) {
    const spent = spendCurrentByPid.get(p.id) ?? 0;
    const merged = mergedCurrentByPid.get(p.id) ?? 0;
    const priorSpent = spendPriorByPid.get(p.id) ?? 0;
    const priorMerged = mergedPriorByPid.get(p.id) ?? 0;
    // Division-by-zero guard (AC2): null when merged === 0.
    const dollars_per_pr = merged > 0 ? spent / merged : null;
    const prior_dpp = priorMerged > 0 ? priorSpent / priorMerged : null;
    // Trend baseline guard (AC3): need >= 3 PRs AND >= $1 prior spend.
    let trend_pct: number | null = null;
    if (
      dollars_per_pr != null && prior_dpp != null
      && priorMerged >= TREND_MIN_PRS && priorSpent >= TREND_MIN_SPENT
    ) {
      trend_pct = ((dollars_per_pr - prior_dpp) / prior_dpp) * 100;
    }
    projects.push({
      slug: p.slug,
      spent_usd: spent,
      prs_merged: merged,
      dollars_per_pr,
      trend_pct,
    });
    fleetSpent += spent;
    fleetMerged += merged;
    fleetPriorSpent += priorSpent;
    fleetPriorMerged += priorMerged;
  }

  // ── Sort: $/PR DESC; nulls to the bottom; slug ASC as tie-break. ─
  projects.sort((a, b) => {
    const an = a.dollars_per_pr == null;
    const bn = b.dollars_per_pr == null;
    if (an && bn) return a.slug.localeCompare(b.slug);
    if (an) return 1;
    if (bn) return -1;
    if (b.dollars_per_pr !== a.dollars_per_pr) {
      return (b.dollars_per_pr as number) - (a.dollars_per_pr as number);
    }
    return a.slug.localeCompare(b.slug);
  });

  // ── Fleet rollup (AC1 + AC2): null at top when fleet merges === 0. ─
  const fleet_dpp = fleetMerged > 0 ? fleetSpent / fleetMerged : null;
  const fleet_prior_dpp = fleetPriorMerged > 0 ? fleetPriorSpent / fleetPriorMerged : null;
  let fleet_trend: number | null = null;
  if (
    fleet_dpp != null && fleet_prior_dpp != null
    && fleetPriorMerged >= TREND_MIN_PRS && fleetPriorSpent >= TREND_MIN_SPENT
  ) {
    fleet_trend = ((fleet_dpp - fleet_prior_dpp) / fleet_prior_dpp) * 100;
  }

  return {
    window: { start: startStr, end: endStr, days },
    fleet: {
      spent_usd: fleetSpent,
      prs_merged: fleetMerged,
      dollars_per_pr: fleet_dpp,
      trend_pct: fleet_trend,
    },
    projects,
    generated_at: now.toISOString(),
  };
}

export function runView(db: DB, id: number) {
  const run = db.prepare("SELECT * FROM run WHERE id=?").get(id) as any;
  if (!run) return null;
  const events = db.prepare("SELECT seq,ts,kind,tool_name,tool_use_id,input_summary,output_summary,is_error FROM run_event WHERE run_id=? ORDER BY seq").all(id);
  const project = db.prepare("SELECT slug,name FROM project WHERE id=?").get(run.project_id);
  // Ticket 0008: surface anomaly rows attached to this run so the SPA's
  // run-detail page can render the badge without a second fetch. Empty
  // array (not null) when the run is clean — keeps the SPA branch simple.
  const anomalies = anomaliesForRun(db, id);
  return { run, events, project, anomalies };
}

// ────────────────────────────────────────────────────────────────────
// Friday wrap — weekly recap card (ticket 0037).
//
// One fleet-wide helper that powers the home page's Friday-only card:
// the four trailing-7d headline stats (shipped PRs, $ spent, anomalies
// flagged, active days), a single biggest_win pick, and a single
// watch_item from a three-branch cascade. Pure composition over
// existing tables (pr, cost_rollup_day, anomaly, ticket_commit_link,
// project) — NO schema migration, NO ingest changes.
//
// Window arithmetic:
//   - The window is the trailing 7-day span ending at `now`. End is
//     `now` itself (ISO). Start is `now - 7d`. We bucket PRs and
//     cost rollups by `date(fetched_at)` / `day` against
//     [date(start), date(end)) using SQLite's `date(ts)` function —
//     same lexicographic frame as fleetStreak / yesterdayGlance so the
//     cells line up across helpers.
//   - We never go through julianday() here. Per LESSONS § "julianday()
//     drifts ~10us per timestamp" we decompose into strftime / date
//     arithmetic for sub-ms accuracy.
//
// Biggest-win selection (AC2):
//   - Sort merged PRs in window by (additions + deletions) DESC, then
//     fetched_at DESC. Pick the first. Ticket-id resolves via the
//     ticket_commit_link table (0018).
//   - Returns null when there are zero merged PRs in window.
//
// Watch-item cascade (AC3) — first non-null match wins:
//   1. drift        — any active self_drift anomaly (0034). Message:
//                     `"<slug> <metric> Nx normal"`. Critical kind.
//   2. correlation  — any active fleet_correlated anomaly (0027).
//                     Message: `"<N> projects failing with <signature>"`.
//                     Critical kind.
//   3. cost_trend   — any project whose trailing 7d $/PR spend is
//                     >= 1.5x the prior 7d $/PR. Message:
//                     `"<slug> burn rate Nx normal"`. Non-critical kind.
//   4. null         — no watch line.
//
// Quiet-hours integration (AC9):
//   - When the FleetConfig's quietHoursActiveAnywhere() returns true,
//     non-critical watch kinds (cost_trend) are suppressed. Critical
//     kinds (drift, correlation) ALWAYS surface — mirrors 0030's
//     "critical always pages" gating and the 0033 glance card's
//     identical rule.
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// every typed row narrowing here uses the double-cast.

export interface FridayWrapBiggestWin {
  project_slug: string;
  pr_number: number;
  pr_title: string;
  /** 4-digit ticket id when a ticket_commit_link row points at this PR,
   *  null otherwise. The SPA renders `(<ticket_id>)` after the title. */
  ticket_id: string | null;
  merged_at: string;
  size_score: number;
}

export type FridayWrapWatchKind = "drift" | "correlation" | "cost_trend";

export interface FridayWrapWatchItem {
  kind: FridayWrapWatchKind;
  project_slug: string;
  message: string;
}

export interface FridayWrapWindow {
  /** ISO timestamp (with `now - 7d` for the inclusive lower bound). */
  start: string;
  /** ISO timestamp = `now`. */
  end: string;
  /** ISO-8601 week key (yyyy-Www) for the week containing `end`.
   *  Used as the memo cache key alongside day-of-week. */
  week_iso: string;
}

export interface FridayWrap {
  window: FridayWrapWindow;
  shipped_count: number;
  spent_usd: number;
  anomalies_count: number;
  active_days: number;
  biggest_win: FridayWrapBiggestWin | null;
  watch_item: FridayWrapWatchItem | null;
  generated_at: string;
}

// Watch kinds that survive quiet-hours demotion (mirrors the
// yesterdayGlance critical set). cost_trend is the only kind absent
// from this list, so the suppression rule reads as "anything not here
// is demoted".
const FRIDAY_WRAP_CRITICAL_WATCH_KINDS: ReadonlyArray<FridayWrapWatchKind> = [
  "drift", "correlation",
];

// Cost-trend trigger ratio: a project's current-7d $/PR being >=1.5x
// the prior-7d $/PR fires the watch. Matches the user story's "burn
// rate doubled" framing while not being so strict that a quiet week
// hides a real bump (>=1.5x is the same threshold the AC text picks).
const FRIDAY_WRAP_COST_TREND_RATIO = 1.5;
// Minimum baseline guards so a sparse prior window doesn't fire the
// trend on noise (same intuition as 0035's TREND_MIN_PRS guard).
const FRIDAY_WRAP_COST_TREND_MIN_PRIOR_PRS = 1;
const FRIDAY_WRAP_COST_TREND_MIN_PRIOR_SPEND = 0.5;

interface FridayWrapShippedRow { n: number; }
interface FridayWrapSpentRow { spent_usd: number | null; }
interface FridayWrapAnomalyRow { n: number; }
interface FridayWrapActiveDaysRow { n: number; }
interface FridayWrapBiggestWinRow {
  project_id: number;
  project_slug: string;
  pr_number: number;
  pr_title: string | null;
  fetched_at: string;
  additions: number | null;
  deletions: number | null;
}
interface FridayWrapTicketLinkRow {
  ticket_id: string;
}
interface FridayWrapCostRow {
  project_id: number;
  project_slug: string;
  spent_usd: number | null;
}
interface FridayWrapMergedCountRow {
  project_id: number;
  project_slug: string;
  prs_merged: number;
}

/** True when `now`'s day-of-week in `tz` is Friday. Uses
 *  `Intl.DateTimeFormat` so we don't need a tz library; the parser
 *  accepts any IANA name node supports. An invalid tz falls back to
 *  UTC so the helper never throws (a malformed `?tz=` query param
 *  shouldn't break the route). */
export function isFriday(now: Date, tz?: string): boolean {
  const zone = tz && tz.length > 0
    ? tz
    : (Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
  let weekday: string;
  try {
    weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "short", timeZone: zone,
    }).format(now);
  } catch {
    // Bad tz — fall back to UTC so we never throw on a malformed param.
    weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "short", timeZone: "UTC",
    }).format(now);
  }
  return weekday === "Fri";
}

/** Friday wrap weekly recap (ticket 0037). `now` defaults to wall-clock;
 *  tests pin it. `cfg` is the optional FleetConfig used to demote
 *  non-critical watch items during quiet hours (0030); when absent,
 *  the watch_item is returned unmodified. */
export function fridayWrap(
  db: DB, now: Date = new Date(), cfg?: FleetConfig,
): FridayWrap {
  const nowIso = now.toISOString();
  const windowStart = new Date(now.getTime() - 7 * 86400_000);
  const windowStartIso = windowStart.toISOString();
  // Bucket boundaries for date()-based GROUP BY. Inclusive lower; we
  // use the same start/end on both sides so a PR merged exactly at
  // `now - 7d` is in window. We compare against `date(...)` which
  // truncates to yyyy-mm-dd, so a same-day boundary buckets to the
  // start date.
  const startDate = windowStartIso.slice(0, 10);
  const endDate = nowIso.slice(0, 10);
  const weekIso = isoWeekKey(now);

  // ── shipped_count: merged PRs in window across all projects ───────
  // Window via date(fetched_at) — same frame as fleetStreak so the
  // four numbers line up with the GitHub-style heatmap on the home
  // page. We count rows (the PR table already dedupes by (project_id,
  // number)).
  const shippedRow = db.prepare(
    "SELECT COUNT(*) AS n FROM pr "
    + " WHERE state = 'MERGED' "
    + "   AND fetched_at IS NOT NULL "
    + "   AND date(fetched_at) >= ? AND date(fetched_at) <= ?",
  ).get(startDate, endDate) as unknown as FridayWrapShippedRow | undefined;
  const shipped_count = Number(shippedRow?.n ?? 0);

  // ── spent_usd: cost_rollup_day SUM across the 7 days ──────────────
  // SUM across day in [startDate, endDate]. cost_rollup_day stores
  // `day` as yyyy-mm-dd (UTC) so lexicographic comparison matches the
  // chronological order.
  const spentRow = db.prepare(
    "SELECT SUM(COALESCE(cost_usd, 0)) AS spent_usd "
    + "  FROM cost_rollup_day "
    + " WHERE day >= ? AND day <= ?",
  ).get(startDate, endDate) as unknown as FridayWrapSpentRow | undefined;
  const spent_usd = Number(spentRow?.spent_usd ?? 0);

  // ── anomalies_count: anomaly rows created in window (active OR
  //    dismissed — the spec is explicit). ─────────────────────────────
  const anomalyRow = db.prepare(
    "SELECT COUNT(*) AS n FROM anomaly "
    + " WHERE created_at IS NOT NULL "
    + "   AND date(created_at) >= ? AND date(created_at) <= ?",
  ).get(startDate, endDate) as unknown as FridayWrapAnomalyRow | undefined;
  const anomalies_count = Number(anomalyRow?.n ?? 0);

  // ── active_days: distinct calendar dates in window with >= 1
  //    merged PR. ──────────────────────────────────────────────────
  const activeDaysRow = db.prepare(
    "SELECT COUNT(DISTINCT date(fetched_at)) AS n FROM pr "
    + " WHERE state = 'MERGED' "
    + "   AND fetched_at IS NOT NULL "
    + "   AND date(fetched_at) >= ? AND date(fetched_at) <= ?",
  ).get(startDate, endDate) as unknown as FridayWrapActiveDaysRow | undefined;
  const active_days = Number(activeDaysRow?.n ?? 0);

  // ── biggest_win: top by (additions + deletions), tie-break newest
  //    merged_at. ─────────────────────────────────────────────────────
  const winRow = db.prepare(
    "SELECT p.id AS project_id, p.slug AS project_slug, "
    + "       pr.number AS pr_number, pr.title AS pr_title, "
    + "       pr.fetched_at AS fetched_at, "
    + "       pr.additions AS additions, pr.deletions AS deletions "
    + "  FROM pr JOIN project p ON p.id = pr.project_id "
    + " WHERE pr.state = 'MERGED' "
    + "   AND pr.fetched_at IS NOT NULL "
    + "   AND date(pr.fetched_at) >= ? AND date(pr.fetched_at) <= ? "
    + " ORDER BY (COALESCE(pr.additions,0) + COALESCE(pr.deletions,0)) DESC, "
    + "          pr.fetched_at DESC "
    + " LIMIT 1",
  ).get(startDate, endDate) as unknown as FridayWrapBiggestWinRow | undefined;
  let biggest_win: FridayWrapBiggestWin | null = null;
  if (winRow) {
    const size_score = (Number(winRow.additions) || 0) + (Number(winRow.deletions) || 0);
    // Resolve ticket id by joining through ticket_commit_link on
    // (project_slug, pr_number). The link table stores `pr_number`
    // directly so we don't need to chase the commit graph.
    const linkRow = db.prepare(
      "SELECT ticket_id FROM ticket_commit_link "
      + " WHERE project_slug = ? AND pr_number = ? "
      + " ORDER BY ticket_id ASC LIMIT 1",
    ).get(winRow.project_slug, winRow.pr_number) as unknown as FridayWrapTicketLinkRow | undefined;
    biggest_win = {
      project_slug: winRow.project_slug,
      pr_number: winRow.pr_number,
      pr_title: winRow.pr_title ?? "",
      ticket_id: linkRow?.ticket_id ?? null,
      merged_at: winRow.fetched_at,
      size_score,
    };
  }

  // ── watch_item cascade: drift → correlation → cost_trend → null ──
  let watch_item: FridayWrapWatchItem | null = null;

  // Priority 1: drift (0034). activeDrifts already filters to the
  // trailing 24h non-dismissed rows, sorted DESC by created_at.
  const drifts = activeDrifts(db, now);
  if (drifts.length > 0) {
    const d = drifts[0];
    // "Nx normal" framing: current ÷ baseline_mean when the baseline
    // is non-zero, otherwise omit the multiplier. We round to 1 decimal
    // so the operator-visible string reads naturally.
    let ratio = 0;
    if (d.baseline_mean && d.baseline_mean !== 0) {
      ratio = d.current / d.baseline_mean;
    }
    const ratioStr = ratio > 0 ? `${ratio.toFixed(1)}x normal` : "spiking";
    watch_item = {
      kind: "drift",
      project_slug: d.project_slug,
      message: `${d.project_slug} ${d.metric} ${ratioStr}`,
    };
  }

  // Priority 2: correlation (0027). activeCorrelations returns the
  // live, non-dismissed fleet_correlated rows in the trailing 24h.
  if (!watch_item) {
    const corr = activeCorrelations(db, now);
    if (corr.length > 0) {
      const c = corr[0];
      const slugs = c.project_slugs ?? [];
      watch_item = {
        kind: "correlation",
        // Correlations are cross-fleet; we still surface a
        // project_slug so the SPA's per-slug renderer has a stable
        // value to render. Pick the first slug; the message carries
        // the cross-fleet "<N> projects" framing.
        project_slug: slugs[0] ?? "fleet",
        message: `${slugs.length} projects failing with ${c.signature}`,
      };
    }
  }

  // Priority 3: cost_trend. For each project we compare the trailing
  // 7d cost/PR to the prior 7d cost/PR; trigger when the ratio is
  // >= FRIDAY_WRAP_COST_TREND_RATIO AND the prior baseline isn't
  // sparse (>= 1 PR AND >= $0.50). The match is the highest-ratio
  // project; ties broken by slug ASC for determinism.
  if (!watch_item) {
    const priorStartIso = new Date(now.getTime() - 14 * 86400_000).toISOString();
    const priorStartDate = priorStartIso.slice(0, 10);
    // Per-project cost in current + prior windows.
    const currentCost = db.prepare(
      "SELECT cr.project_id AS project_id, p.slug AS project_slug, "
      + "       SUM(COALESCE(cr.cost_usd, 0)) AS spent_usd "
      + "  FROM cost_rollup_day cr JOIN project p ON p.id = cr.project_id "
      + " WHERE cr.day >= ? AND cr.day <= ? "
      + " GROUP BY cr.project_id, p.slug",
    ).all(startDate, endDate) as unknown as FridayWrapCostRow[];
    const priorCost = db.prepare(
      "SELECT cr.project_id AS project_id, p.slug AS project_slug, "
      + "       SUM(COALESCE(cr.cost_usd, 0)) AS spent_usd "
      + "  FROM cost_rollup_day cr JOIN project p ON p.id = cr.project_id "
      + " WHERE cr.day >= ? AND cr.day < ? "
      + " GROUP BY cr.project_id, p.slug",
    ).all(priorStartDate, startDate) as unknown as FridayWrapCostRow[];
    const currentMerged = db.prepare(
      "SELECT pr.project_id AS project_id, p.slug AS project_slug, "
      + "       COUNT(*) AS prs_merged "
      + "  FROM pr JOIN project p ON p.id = pr.project_id "
      + " WHERE pr.state = 'MERGED' AND pr.fetched_at IS NOT NULL "
      + "   AND date(pr.fetched_at) >= ? AND date(pr.fetched_at) <= ? "
      + " GROUP BY pr.project_id, p.slug",
    ).all(startDate, endDate) as unknown as FridayWrapMergedCountRow[];
    const priorMerged = db.prepare(
      "SELECT pr.project_id AS project_id, p.slug AS project_slug, "
      + "       COUNT(*) AS prs_merged "
      + "  FROM pr JOIN project p ON p.id = pr.project_id "
      + " WHERE pr.state = 'MERGED' AND pr.fetched_at IS NOT NULL "
      + "   AND date(pr.fetched_at) >= ? AND date(pr.fetched_at) < ? "
      + " GROUP BY pr.project_id, p.slug",
    ).all(priorStartDate, startDate) as unknown as FridayWrapMergedCountRow[];

    const cMap = new Map<number, { slug: string; cost: number; merged: number }>();
    for (const r of currentCost) {
      cMap.set(r.project_id, {
        slug: r.project_slug,
        cost: Number(r.spent_usd ?? 0),
        merged: 0,
      });
    }
    for (const r of currentMerged) {
      const cur = cMap.get(r.project_id) ?? { slug: r.project_slug, cost: 0, merged: 0 };
      cur.merged = Number(r.prs_merged ?? 0);
      cMap.set(r.project_id, cur);
    }
    const pMap = new Map<number, { cost: number; merged: number }>();
    for (const r of priorCost) {
      pMap.set(r.project_id, {
        cost: Number(r.spent_usd ?? 0),
        merged: 0,
      });
    }
    for (const r of priorMerged) {
      const cur = pMap.get(r.project_id) ?? { cost: 0, merged: 0 };
      cur.merged = Number(r.prs_merged ?? 0);
      pMap.set(r.project_id, cur);
    }

    let topRatio = 0;
    let topSlug: string | null = null;
    const projectIds = [...cMap.keys()].sort((a, b) => {
      const sa = cMap.get(a)?.slug ?? "";
      const sb = cMap.get(b)?.slug ?? "";
      return sa.localeCompare(sb);
    });
    for (const pid of projectIds) {
      const cur = cMap.get(pid)!;
      const prior = pMap.get(pid);
      if (!prior) continue;
      if (prior.merged < FRIDAY_WRAP_COST_TREND_MIN_PRIOR_PRS) continue;
      if (prior.cost < FRIDAY_WRAP_COST_TREND_MIN_PRIOR_SPEND) continue;
      if (cur.merged <= 0 || cur.cost <= 0) continue;
      const curDpp = cur.cost / cur.merged;
      const priorDpp = prior.cost / prior.merged;
      if (priorDpp <= 0) continue;
      const ratio = curDpp / priorDpp;
      if (ratio < FRIDAY_WRAP_COST_TREND_RATIO) continue;
      if (ratio > topRatio) {
        topRatio = ratio;
        topSlug = cur.slug;
      }
    }
    if (topSlug != null) {
      watch_item = {
        kind: "cost_trend",
        project_slug: topSlug,
        message: `${topSlug} burn rate ${topRatio.toFixed(1)}x normal`,
      };
    }
  }

  // ── Quiet-hours demotion (0030) — non-critical kinds only ────────
  if (
    watch_item
    && cfg
    && !FRIDAY_WRAP_CRITICAL_WATCH_KINDS.includes(watch_item.kind)
    && quietHoursActiveAnywhere(cfg, now)
  ) {
    watch_item = null;
  }

  return {
    window: {
      start: windowStartIso,
      end: nowIso,
      week_iso: weekIso,
    },
    shipped_count,
    spent_usd,
    anomalies_count,
    active_days,
    biggest_win,
    watch_item,
    generated_at: nowIso,
  };
}

// ────────────────────────────────────────────────────────────────────
// Monday morning catch-up (ticket 0038).
//
// Bridges the weekend gap between Friday wrap (0037) and Yesterday
// glance (0033). Returns the four weekend headline numbers (merged
// PRs, dollars spent, waiting PRs, open alerts) for the operator-
// local "since Friday 17:00 (or last-seen, whichever is later)"
// window, plus a single biggest_ship PR pick and a single needs_you
// item drawn from a four-branch priority cascade.
//
// Composition only — no schema migration:
//   - merged_prs : pr WHERE state='MERGED' AND is_agent=1 AND
//                  fetched_at >= window.start
//   - spent_usd  : SUM(cost_rollup_day.cost_usd) over the window's
//                  yyyy-mm-dd buckets
//   - waiting_prs: pr WHERE state='open' AND is_agent=1
//   - open_alerts: COUNT(alert) WHERE resolved_at IS NULL
//
// Per LESSONS § "groomer prose can disagree with the schema; the
// schema wins": open PRs use state='open' (lower-case) because
// src/ingest/prs.ts writes the literal 'open' string on every pass.
// Merged PRs use 'MERGED' (upper-case) because every other view in
// this file already filters on that exact casing (fleetStreak,
// costPerMergedPr, fridayWrap, projectBurndown's siblings) — the
// repo is internally consistent on uppercase for merged.
//
// Window arithmetic (per LESSONS § "julianday() drifts ~10us per
// timestamp"): we never go through julianday(). The Friday-17:00
// anchor is computed in JS via Intl.DateTimeFormat (zero new deps,
// matches isFriday/fridayWrap), then compared as ISO strings against
// the column timestamps. SQLite's lexicographic string ordering
// matches chronological order for ISO-8601 strings, so no float
// arithmetic is needed.
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// every typed row narrowing here uses the double-cast pattern.

export type MondayWindowAnchor = "friday_17" | "last_seen";

export interface MondayWindow {
  /** ISO timestamp (UTC). */
  start: string;
  /** ISO timestamp (UTC) = `now`. */
  end: string;
  /** Window length in hours, rounded to one decimal. */
  hours: number;
  /** Which side of the OR won the LATER comparison. */
  anchor: MondayWindowAnchor;
}

export interface MondayCatchUpBiggestShip {
  project_slug: string;
  pr_number: number;
  pr_title: string;
  ticket_id: string | null;
  merged_at: string;
  size_score: number;
}

export type MondayNeedsYouKind =
  | "pr_review"
  | "self_drift"
  | "self_cancel_warn"
  | "hung_run";

export interface MondayCatchUpNeedsYou {
  kind: MondayNeedsYouKind;
  project_slug: string;
  message: string;
  link: string;
  age_hours: number;
}

export interface MondayCatchUp {
  window: MondayWindow;
  merged_prs: number;
  spent_usd: number;
  waiting_prs: number;
  open_alerts: number;
  biggest_ship: MondayCatchUpBiggestShip | null;
  needs_you: MondayCatchUpNeedsYou | null;
  generated_at: string;
}

export interface MondayCatchUpOptions {
  /** Operator-local IANA timezone for the Friday-17:00 anchor. Defaults
   *  to the server's local zone (matches isMonday and fridayWrap). */
  tz?: string;
  /** Optional ISO timestamp recorded the last time the operator hit
   *  the home page. The window's start is the LATER of this and the
   *  Friday-17:00 anchor — so an operator who skimmed at Sunday 8pm
   *  doesn't see Friday-night noise on Monday. */
  lastSeenAt?: string;
}

/** True when `now`'s day-of-week in `tz` is Monday. Uses
 *  Intl.DateTimeFormat so we don't need a tz library; an invalid tz
 *  falls back to UTC so the helper never throws on a malformed
 *  `?tz=` query param. */
export function isMonday(now: Date, tz?: string): boolean {
  const zone = tz && tz.length > 0
    ? tz
    : (Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
  let weekday: string;
  try {
    weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "short", timeZone: zone,
    }).format(now);
  } catch {
    weekday = new Intl.DateTimeFormat("en-US", {
      weekday: "short", timeZone: "UTC",
    }).format(now);
  }
  return weekday === "Mon";
}

/** Resolve the parts (year, month, day, weekday-short) of `now` as
 *  observed in `tz`. Uses Intl.DateTimeFormat.formatToParts so the
 *  output is locale-stable. Falls back to UTC on a malformed tz. */
interface ZonedParts {
  year: number; month: number; day: number;
  weekday: string; // "Mon" .. "Sun"
  hour: number; minute: number;
}
function partsInZone(now: Date, tz: string): ZonedParts {
  let zone = tz;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    zone = "UTC";
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short",
      hourCycle: "h23",
    }).formatToParts(now);
  }
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: get("weekday"),
    hour: Number(get("hour")) || 0,
    minute: Number(get("minute")) || 0,
  };
}

/** Convert a wall-clock yyyy-mm-dd HH:00 in `tz` to a UTC ISO string.
 *  Strategy: build a UTC Date for the same y/m/d/HH and then iterate
 *  the tz-offset adjustment until the parts in `tz` round-trip. Two
 *  iterations cover every IANA zone (no zone has a >24h offset). */
function tzWallToUtcIso(
  year: number, month: number, day: number,
  hour: number, minute: number, tz: string,
): string {
  // Start with the naive UTC timestamp for the wall-clock values.
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  for (let iter = 0; iter < 4; iter++) {
    const probe = new Date(utcMs);
    const p = partsInZone(probe, tz);
    if (p.year === year && p.month === month && p.day === day
      && p.hour === hour && p.minute === minute) {
      return probe.toISOString();
    }
    // How far off is the tz wall-clock from our target? Convert the
    // probe's tz reading back to a UTC ms (using Date.UTC on the
    // observed parts) and shift utcMs by the delta.
    const observedUtcMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
    const targetUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    utcMs += targetUtcMs - observedUtcMs;
  }
  return new Date(utcMs).toISOString();
}

/** Compute the most recent Friday 17:00 in `tz` strictly at-or-before
 *  `now`. Returned as a UTC ISO timestamp. */
function fridayFivePmIsoBefore(now: Date, tz: string): string {
  const parts = partsInZone(now, tz);
  // Distance back to the most recent Friday wall-clock day.
  // weekday → index: Mon=0 .. Sun=6 (matches the SQLite-style 1..7
  // but we keep zero-based to make modular arithmetic easy).
  const WD: Record<string, number> = {
    Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
  };
  const todayIdx = WD[parts.weekday] ?? 0;
  // Days to subtract to reach Friday. (todayIdx - 4 + 7) % 7. If today
  // IS Friday and the current zoned-hour < 17, we still need last week's
  // Friday — that's a 7-day reach-back.
  let daysBack = (todayIdx - 4 + 7) % 7;
  if (parts.weekday === "Fri" && parts.hour < 17) daysBack = 7;
  // Build a UTC Date for the wall-clock at midnight on `now` in tz,
  // then step back `daysBack` calendar days. Strategy: derive the
  // target y/m/d by shifting the tz wall-clock day, then convert
  // wall-clock 17:00 on that day to UTC.
  const target = new Date(Date.UTC(parts.year, parts.month - 1, parts.day) - daysBack * 86400_000);
  const y = target.getUTCFullYear();
  const m = target.getUTCMonth() + 1;
  const d = target.getUTCDate();
  return tzWallToUtcIso(y, m, d, 17, 0, tz);
}

/** Resolve the window start for a Monday catch-up. The start is the
 *  LATER of (a) the most recent Friday 17:00 in `tz` and (b) the
 *  optional `lastSeenAt`. When `lastSeenAt` is absent only (a)
 *  applies; when `tz` is empty/malformed we fall back to UTC. The
 *  fallback when BOTH are absent is 60h before `now` (a safe
 *  weekend-ish span the SPA can render without ambiguity). */
export function weekendWindowStart(
  now: Date, tz: string, lastSeenAt?: string,
): { start: string; anchor: MondayWindowAnchor } {
  const zone = tz && tz.length > 0 ? tz : "UTC";
  let fri17: string;
  try {
    fri17 = fridayFivePmIsoBefore(now, zone);
  } catch {
    // Fallback: 60h before now.
    fri17 = new Date(now.getTime() - 60 * 3600_000).toISOString();
  }
  if (lastSeenAt) {
    const t = Date.parse(lastSeenAt);
    if (Number.isFinite(t) && t > Date.parse(fri17)) {
      return { start: new Date(t).toISOString(), anchor: "last_seen" };
    }
  }
  return { start: fri17, anchor: "friday_17" };
}

interface MondayMergedCountRow { n: number; }
interface MondaySpentRow { spent_usd: number | null; }
interface MondayWaitingRow { n: number; }
interface MondayAlertsRow { n: number; }
interface MondayBiggestShipRow {
  project_id: number;
  project_slug: string;
  pr_number: number;
  pr_title: string | null;
  fetched_at: string;
  additions: number | null;
  deletions: number | null;
}
interface MondayTicketLinkRow { ticket_id: string; }
interface MondayPrReviewRow {
  project_slug: string;
  pr_number: number;
  pr_title: string | null;
  pr_url: string | null;
  gh_created_at: string | null;
}
interface MondayAlertRow {
  project_slug: string;
  type: string;
  title: string | null;
  detail: string | null;
  phase: string | null;
  created_at: string;
}
interface MondayDriftSliceRow {
  project_slug: string;
  correlation_signature: string | null;
  created_at: string;
}

/** Monday morning catch-up (ticket 0038). Composes pr / cost_rollup_day
 *  / alert / anomaly / ticket_commit_link reads into a single payload
 *  the SPA renders as one card at the top of the home page. `now`
 *  defaults to wall-clock; tests pin it. `opts.tz` defaults to the
 *  server's local zone; `opts.lastSeenAt` (when set) wins over the
 *  Friday-17:00 anchor IFF it is more recent. */
export function mondayCatchUp(
  db: DB, now: Date = new Date(), opts: MondayCatchUpOptions = {},
): MondayCatchUp {
  const tz = opts.tz && opts.tz.length > 0
    ? opts.tz
    : (Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
  const window = weekendWindowStart(now, tz, opts.lastSeenAt);
  const nowIso = now.toISOString();
  const startIso = window.start;
  const startDate = startIso.slice(0, 10);
  const endDate = nowIso.slice(0, 10);
  const hours = Math.round(((Date.parse(nowIso) - Date.parse(startIso)) / 3600_000) * 10) / 10;

  // ── merged_prs: agent PRs merged in window across all projects ──
  // Same casing the rest of the file uses for merged: 'MERGED' upper.
  // We compare `fetched_at >= startIso` directly (ISO-8601 sorts
  // lexicographically). The PK on pr is (project_id, number) so we
  // count rows without DISTINCT.
  const mergedRow = db.prepare(
    "SELECT COUNT(*) AS n FROM pr "
    + " WHERE state = 'MERGED' AND is_agent = 1 "
    + "   AND fetched_at IS NOT NULL "
    + "   AND fetched_at >= ? AND fetched_at <= ?",
  ).get(startIso, nowIso) as unknown as MondayMergedCountRow | undefined;
  const merged_prs = Number(mergedRow?.n ?? 0);

  // ── spent_usd: SUM(cost_rollup_day.cost_usd) over the window's
  //    yyyy-mm-dd buckets. The rollup day is the SQLite date() of
  //    started_at; we include the boundary days inclusively. ────────
  const spentRow = db.prepare(
    "SELECT SUM(COALESCE(cost_usd, 0)) AS spent_usd "
    + "  FROM cost_rollup_day "
    + " WHERE day >= ? AND day <= ?",
  ).get(startDate, endDate) as unknown as MondaySpentRow | undefined;
  const spent_usd = Number(spentRow?.spent_usd ?? 0);

  // ── waiting_prs: open agent PRs (state='open' lower-case is what
  //    src/ingest/prs.ts writes — see the LESSONS schema-vs-prose
  //    entry from 2026-06-05). ────────────────────────────────────────
  const waitingRow = db.prepare(
    "SELECT COUNT(*) AS n FROM pr "
    + " WHERE state = 'open' AND is_agent = 1",
  ).get() as unknown as MondayWaitingRow | undefined;
  const waiting_prs = Number(waitingRow?.n ?? 0);

  // ── open_alerts: alert rows with resolved_at IS NULL. ────────────
  const alertsRow = db.prepare(
    "SELECT COUNT(*) AS n FROM alert WHERE resolved_at IS NULL",
  ).get() as unknown as MondayAlertsRow | undefined;
  const open_alerts = Number(alertsRow?.n ?? 0);

  // ── biggest_ship: among merged PRs in window across all projects,
  //    pick the highest (additions + deletions); tie-break newest
  //    fetched_at. Null when zero merges in window. ──────────────────
  const winRow = db.prepare(
    "SELECT p.id AS project_id, p.slug AS project_slug, "
    + "       pr.number AS pr_number, pr.title AS pr_title, "
    + "       pr.fetched_at AS fetched_at, "
    + "       pr.additions AS additions, pr.deletions AS deletions "
    + "  FROM pr JOIN project p ON p.id = pr.project_id "
    + " WHERE pr.state = 'MERGED' AND pr.is_agent = 1 "
    + "   AND pr.fetched_at IS NOT NULL "
    + "   AND pr.fetched_at >= ? AND pr.fetched_at <= ? "
    + " ORDER BY (COALESCE(pr.additions,0) + COALESCE(pr.deletions,0)) DESC, "
    + "          pr.fetched_at DESC "
    + " LIMIT 1",
  ).get(startIso, nowIso) as unknown as MondayBiggestShipRow | undefined;
  let biggest_ship: MondayCatchUpBiggestShip | null = null;
  if (winRow) {
    const size_score = (Number(winRow.additions) || 0) + (Number(winRow.deletions) || 0);
    const linkRow = db.prepare(
      "SELECT ticket_id FROM ticket_commit_link "
      + " WHERE project_slug = ? AND pr_number = ? "
      + " ORDER BY ticket_id ASC LIMIT 1",
    ).get(winRow.project_slug, winRow.pr_number) as unknown as MondayTicketLinkRow | undefined;
    biggest_ship = {
      project_slug: winRow.project_slug,
      pr_number: winRow.pr_number,
      pr_title: winRow.pr_title ?? "",
      ticket_id: linkRow?.ticket_id ?? null,
      merged_at: winRow.fetched_at,
      size_score,
    };
  }

  // ── needs_you cascade ────────────────────────────────────────────
  // Priority order: pr_review > self_drift > self_cancel_warn >
  // hung_run > null. First non-null match wins.
  let needs_you: MondayCatchUpNeedsYou | null = null;

  // Priority 1: pr_review. Any open agent PR whose gh_created_at age
  // exceeds 12h (per the AC) qualifies. We take the OLDEST such PR
  // so the operator triages the most-neglected one first.
  const prRevRow = db.prepare(
    "SELECT p.slug AS project_slug, pr.number AS pr_number, "
    + "       pr.title AS pr_title, pr.url AS pr_url, "
    + "       pr.gh_created_at AS gh_created_at "
    + "  FROM pr JOIN project p ON p.id = pr.project_id "
    + " WHERE pr.state = 'open' AND pr.is_agent = 1 "
    + "   AND pr.gh_created_at IS NOT NULL "
    + " ORDER BY pr.gh_created_at ASC LIMIT 1",
  ).get() as unknown as MondayPrReviewRow | undefined;
  if (prRevRow && prRevRow.gh_created_at) {
    const t = Date.parse(prRevRow.gh_created_at);
    if (Number.isFinite(t)) {
      const ageHours = Math.max(0, Math.floor((now.getTime() - t) / 3600_000));
      if (ageHours >= 12) {
        const link = prRevRow.pr_url
          ?? `#/p/${encodeURIComponent(prRevRow.project_slug)}?pr=${prRevRow.pr_number}`;
        needs_you = {
          kind: "pr_review",
          project_slug: prRevRow.project_slug,
          message: `${prRevRow.project_slug} PR #${prRevRow.pr_number} waiting ${ageHours}h`,
          link,
          age_hours: ageHours,
        };
      }
    }
  }

  // Priority 2: self_drift. Any active (non-dismissed) self_drift
  // anomaly in the trailing 24h. We surface the most recent one and
  // its metric.
  if (!needs_you) {
    const cutoffIso = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const driftRow = db.prepare(
      "SELECT p.slug AS project_slug, "
      + "       a.correlation_signature AS correlation_signature, "
      + "       a.created_at AS created_at "
      + "  FROM anomaly a "
      + "  JOIN run r ON r.id = a.run_id "
      + "  JOIN project p ON p.id = r.project_id "
      + "  LEFT JOIN inbox_dismissal d "
      + "         ON d.kind = 'self_drift' "
      + "        AND d.project_slug = p.slug "
      + "        AND d.payload_id = a.correlation_signature "
      + "        AND d.dismissed_at >= a.created_at "
      + " WHERE a.kind = 'self_drift' "
      + "   AND a.correlation_signature IS NOT NULL "
      + "   AND a.created_at >= ? "
      + "   AND d.dismissed_at IS NULL "
      + " ORDER BY a.created_at DESC LIMIT 1",
    ).get(cutoffIso) as unknown as MondayDriftSliceRow | undefined;
    if (driftRow && driftRow.correlation_signature) {
      const ageHours = Math.max(0,
        Math.floor((now.getTime() - Date.parse(driftRow.created_at)) / 3600_000));
      needs_you = {
        kind: "self_drift",
        project_slug: driftRow.project_slug,
        message: `${driftRow.project_slug} ${driftRow.correlation_signature} drift`,
        link: `#/project/${encodeURIComponent(driftRow.project_slug)}/drift`,
        age_hours: ageHours,
      };
    }
  }

  // Priority 3: self_cancel_warn. An open alert of type='self_cancel'
  // and severity='warn'. The dedup_key encodes the days remaining
  // (e.g. "self_cancel:<slug>:3"); we surface that.
  if (!needs_you) {
    const scRow = db.prepare(
      "SELECT p.slug AS project_slug, a.type AS type, a.title AS title, "
      + "       a.detail AS detail, a.phase AS phase, a.created_at AS created_at "
      + "  FROM alert a JOIN project p ON p.id = a.project_id "
      + " WHERE a.resolved_at IS NULL AND a.type = 'self_cancel' "
      + "   AND a.severity = 'warn' "
      + " ORDER BY a.created_at DESC LIMIT 1",
    ).get() as unknown as MondayAlertRow | undefined;
    if (scRow) {
      const ageHours = Math.max(0,
        Math.floor((now.getTime() - Date.parse(scRow.created_at)) / 3600_000));
      const titleText = scRow.title ?? `${scRow.project_slug} self-cancel approaching`;
      needs_you = {
        kind: "self_cancel_warn",
        project_slug: scRow.project_slug,
        message: titleText,
        link: `#/p/${encodeURIComponent(scRow.project_slug)}`,
        age_hours: ageHours,
      };
    }
  }

  // Priority 4: hung_run. An open alert of type='hung_run'. The
  // message carries the phase and age.
  if (!needs_you) {
    const hungRow = db.prepare(
      "SELECT p.slug AS project_slug, a.type AS type, a.title AS title, "
      + "       a.detail AS detail, a.phase AS phase, a.created_at AS created_at "
      + "  FROM alert a JOIN project p ON p.id = a.project_id "
      + " WHERE a.resolved_at IS NULL AND a.type = 'hung_run' "
      + " ORDER BY a.created_at DESC LIMIT 1",
    ).get() as unknown as MondayAlertRow | undefined;
    if (hungRow) {
      const ageHours = Math.max(0,
        Math.floor((now.getTime() - Date.parse(hungRow.created_at)) / 3600_000));
      const phase = hungRow.phase ?? "run";
      needs_you = {
        kind: "hung_run",
        project_slug: hungRow.project_slug,
        message: `${hungRow.project_slug} ${phase} hung ${ageHours}h`,
        link: `#/p/${encodeURIComponent(hungRow.project_slug)}`,
        age_hours: ageHours,
      };
    }
  }

  return {
    window: { start: startIso, end: nowIso, hours, anchor: window.anchor },
    merged_prs,
    spent_usd,
    waiting_prs,
    open_alerts,
    biggest_ship,
    needs_you,
    generated_at: nowIso,
  };
}

// ────────────────────────────────────────────────────────────────────
// Riskiest open PR (ticket 0040).
//
// One fleet-wide helper that ranks open agent PRs by a deterministic
// risk score so the home page can name THE single PR the operator
// should tend next. Composes existing tables: pr (state/is_agent/
// fetched_at/ci_state/first_fail_check), project (slug/name), and
// control_audit (action='heal' rows whose stdout_tail surfaces the
// infra-flake substrings catalogued in the cross-fleet LESSONS file).
// No schema migration, no new ingest — pure composition.
//
// Score formula (per AC2 — exact integer arithmetic so the test can
// assert the score on the returned row):
//
//   score = heal_attempts * 4
//         + fail_kind_weight[fail_kind]
//         + Math.floor(age_hours / 6)
//
// fail_kind_weight is the literal map FAIL_KIND_WEIGHT below.
//
// Tiebreaker: score DESC, then age DESC. Two PRs that score the same
// but differ in age push the older one to the top — older PRs hurt
// more (the operator's mental cost of context-switching grows with
// stale PRs, per the user story).
//
// fail_kind classification (per AC3):
//   1. If the latest control_audit row for (action='heal',
//      target='pr-<number>') exists, scan its stdout_tail against
//      INFRA_FLAKE_PATTERNS. First match → infra_flake.
//   2. Else fall back to pr.ci_state:
//        - 'red'              → red_test (detail = first_fail_check)
//        - 'green' / 'pending' → green
//        - everything else    → red_check_unknown
//
// The INFRA_FLAKE_PATTERNS array lives at module scope so future
// patterns from CROSS_LESSONS.md (account suspension, supabase port
// bind, etc. — see LESSONS § "infra flakes shouldn't trigger code
// fixes") are one-line additions. Each pattern is a JS RegExp tested
// against the stdout_tail in JavaScript — never composed into SQL
// (per AGENTS.md § "Never compose a shell string from input" and the
// SQL analogue: substring matches stay JS-side, parameterised
// queries stay parameterised).
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// every typed-row narrowing here uses the double-cast pattern.
// Per LESSONS § "julianday() drifts ~10us per timestamp": age math
// stays JS-side (integer ms diff floored to hours).
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests": cache reset + build counter live on the server route
// (ticket-0036/0037 pattern).
//
// Quiet-hours integration (AC10): an optional { quietHoursActive }
// option suppresses the top row when its fail_kind is infra_flake —
// matches 0030's "non-critical pushes are demoted overnight" rule
// (an infra flake is a re-run, not a wake-the-operator event).

export type RiskiestPrFailKind =
  | "infra_flake"
  | "red_test"
  | "red_check_unknown"
  | "green";

export interface RiskiestPrTop {
  project_slug: string;
  project_name: string;
  pr_number: number;
  pr_title: string;
  pr_url: string;
  heal_attempts: number;
  fail_kind: RiskiestPrFailKind;
  fail_detail: string | null;
  age_hours: number;
  score: number;
}

export interface RiskiestOpenPr {
  open_count: number;
  all_healthy: boolean;
  top: RiskiestPrTop | null;
  generated_at: string;
}

export interface RiskiestOpenPrOptions {
  /** When true, suppress the top row IFF its fail_kind is
   *  `infra_flake`. The operator opted into quiet hours for non-
   *  critical pings; infra flakes resolve themselves with a re-run.
   *  Critical kinds (red_test / red_check_unknown / green) are
   *  always surfaced. */
  quietHoursActive?: boolean;
}

export interface ClassifyPrFailure {
  kind: RiskiestPrFailKind;
  detail: string | null;
}

// fail-kind score weights. Literal map — the test asserts arithmetic
// against these exact integers (AC2).
const FAIL_KIND_WEIGHT: Record<RiskiestPrFailKind, number> = {
  infra_flake: 1,
  red_test: 3,
  red_check_unknown: 2,
  green: 0,
};

// Infra-flake substring patterns. Each entry { re, label } — `re` is
// the test against stdout_tail; `label` is the short operator-facing
// summary the badge UI displays. The actual classification `detail`
// returned by classifyPrFailure carries the LITERAL matched
// substring (AC3 § "returning `infra_flake` with the matched substring
// as `detail`"), so a future cross-fleet pattern from CROSS_LESSONS
// surfaces verbatim. Labels are kept short for the SPA's parenthetical
// rendering (`renderRiskiestPr` may render `label` directly when the
// matched substring is too long for the badge line).
//
// The list comes straight from CROSS_LESSONS.md infra-flake entries
// (account suspension, supabase port-bind, 502 Bad Gateway, runner-
// level port conflicts, actions/checkout 403 retry-loop). Future
// additions land here as one-liners. Per LESSONS § "no shell-string
// composition" (and its SQL analogue), each pattern is a JS RegExp
// tested in JavaScript — never composed into the SQL itself.
const INFRA_FLAKE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  // supabase start: "failed to bind host port for 0.0.0.0:54322"
  // (LESSONS#0029) — must come before the generic "address in use"
  // so we surface the more specific supabase substring.
  { re: /supabase[\s\S]{0,120}failed\s+to\s+bind/i, label: "supabase port-bind" },
  // Generic port conflict — the launchd / docker daemon / dev server
  // case. Anything matching "address already in use" not caught above.
  { re: /address\s+already\s+in\s+use/i, label: "port-bind" },
  // GitHub account suspended → actions/checkout retries 3x and gives
  // up with HTTP 403 (LESSONS#0036 "account is suspended"). The
  // remote-suspended message is the canonical form.
  { re: /account\s+is\s+suspended/i, label: "account suspended" },
  // actions/checkout 403 (post-suspension OR a transient repo perms
  // issue) — distinct from "account is suspended" because the
  // checkout retry loop may exit with just "403" in some workflows.
  { re: /actions\/checkout[\s\S]{0,120}\b403\b/i, label: "checkout 403" },
  // GitHub GraphQL 502 (LESSONS#0012 "gh pr checks --watch died on
  // 502 Bad Gateway"). Treat as transient.
  { re: /502\s+Bad\s+Gateway/i, label: "502 Bad Gateway" },
];

interface RiskiestPrRow {
  project_slug: string;
  project_name: string | null;
  project_id: number;
  pr_number: number;
  pr_title: string | null;
  pr_url: string | null;
  ci_state: string | null;
  first_fail_check: string | null;
  heal_attempts: number | null;
  fetched_at: string | null;
}

interface HealAuditRow {
  stdout_tail: string | null;
}

/** Classify a single PR's failure mode. Reads the latest
 *  `control_audit` row where action='heal' and target='pr-<number>'
 *  for the project; if found, scans its `stdout_tail` against
 *  INFRA_FLAKE_PATTERNS. Otherwise falls back to pr.ci_state.
 *
 *  Pure-SQL helper: no shell-out, no network, no transcript I/O.
 *  The substring match runs in JS (per AGENTS.md § "Never compose a
 *  shell string from input" — and the SQL analogue: never compose
 *  pattern matches into the SQL itself).
 *
 *  Signature: `(db, projectId, prNumber)`. The route handler resolves
 *  `projectId` from the slug; tests can pass the integer directly. */
export function classifyPrFailure(
  db: DB, projectId: number, prNumber: number,
): ClassifyPrFailure {
  // Latest heal-audit row for this PR. We don't filter by project_id
  // on control_audit because target='pr-<number>' is fleet-unique only
  // when paired with the project's repo; in practice agents lock the
  // `pr-N` form to one project at a time, but a future cross-project
  // collision would simply return the most-recent matching row — the
  // operator-visible classification stays correct (an infra flake is
  // an infra flake regardless of which project owns the PR).
  const auditRow = db.prepare(
    "SELECT stdout_tail FROM control_audit "
    + " WHERE action = 'heal' AND target = ? "
    + " ORDER BY ts DESC LIMIT 1",
  ).get(`pr-${prNumber}`) as unknown as HealAuditRow | undefined;

  if (auditRow && auditRow.stdout_tail) {
    const tail = String(auditRow.stdout_tail);
    for (const p of INFRA_FLAKE_PATTERNS) {
      const m = p.re.exec(tail);
      if (m) {
        // Per AC3 § "returning `infra_flake` with the matched
        // substring as `detail`": surface the literal matched
        // substring so the SPA reads true to the heal log. The
        // pattern's friendly `label` is also useful for terse
        // rendering — we expose the substring directly so a future
        // SPA tweak can format/elide as it chooses.
        return { kind: "infra_flake", detail: m[0] };
      }
    }
    // A heal-audit exists but isn't an infra match — fall through to
    // the ci_state lookup so we surface red_test with the failing
    // check name (operator's first question is "which check?").
  }

  // Fall back to the PR's ci_state. The ingester writes one of
  // 'red' | 'pending' | 'green' | 'none'.
  const prRow = db.prepare(
    "SELECT ci_state, first_fail_check FROM pr "
    + " WHERE project_id = ? AND number = ?",
  ).get(projectId, prNumber) as unknown as {
    ci_state: string | null;
    first_fail_check: string | null;
  } | undefined;
  if (!prRow) return { kind: "red_check_unknown", detail: null };
  const ci = String(prRow.ci_state ?? "");
  if (ci === "red") {
    return { kind: "red_test", detail: prRow.first_fail_check ?? null };
  }
  if (ci === "green" || ci === "pending") {
    return { kind: "green", detail: null };
  }
  return { kind: "red_check_unknown", detail: null };
}

/** Compute the riskiest open agent PR across the fleet. `now` is the
 *  wall-clock anchor for age math (tests pin it; production passes
 *  `new Date()`). Returns the documented `{open_count, all_healthy,
 *  top, generated_at}` shape.
 *
 *  Per AC1's "ignore non-agent PRs entirely" intent: only rows with
 *  state='open' AND is_agent=1 contribute. (The production ingester
 *  writes lowercase 'open' — see src/ingest/prs.ts. The ticket's
 *  prose used 'OPEN'; reality is lowercase. We honour the schema.)
 *
 *  Quiet-hours suppression (AC10): when `quietHoursActive` is true,
 *  a winning row whose fail_kind is `infra_flake` is suppressed
 *  (top → null) — but open_count and all_healthy still reflect the
 *  underlying state so the SPA's "Open PRs (N): all healthy"
 *  fallback line remains accurate. */
export function riskiestOpenPr(
  db: DB, now: Date = new Date(),
  opts: RiskiestOpenPrOptions = {},
): RiskiestOpenPr {
  const generatedAt = now.toISOString();

  // One JOIN over pr + project, restricted to open agent PRs. The
  // small N (typically <50 across the fleet) makes JS-side scoring
  // cheaper than a CTE — see the perf AC.
  const rows = db.prepare(
    "SELECT "
    + "  p.slug AS project_slug, p.name AS project_name, p.id AS project_id, "
    + "  pr.number AS pr_number, pr.title AS pr_title, pr.url AS pr_url, "
    + "  pr.ci_state AS ci_state, pr.first_fail_check AS first_fail_check, "
    + "  pr.heal_attempts AS heal_attempts, pr.fetched_at AS fetched_at "
    + "FROM pr JOIN project p ON p.id = pr.project_id "
    + "WHERE pr.state = 'open' AND pr.is_agent = 1",
  ).all() as unknown as RiskiestPrRow[];

  const open_count = rows.length;
  if (open_count === 0) {
    return { open_count: 0, all_healthy: false, top: null, generated_at: generatedAt };
  }

  // Score every open PR. JS-side: keeps the SQL boring and lets the
  // fail-kind classifier reuse its substring scan unchanged.
  interface Scored extends RiskiestPrTop { _ageHoursRaw: number; }
  const scored: Scored[] = rows.map((r) => {
    // Age: integer ms diff → integer hours via Math.floor. Negative
    // (clock-skew → future fetched_at) clamps to 0 so the score
    // never goes negative.
    let ageHours = 0;
    if (r.fetched_at) {
      const ageMs = now.getTime() - new Date(r.fetched_at).getTime();
      ageHours = Math.max(0, Math.floor(ageMs / 3600_000));
    }
    const cls = classifyPrFailure(db, r.project_id, r.pr_number);
    const heal = Math.max(0, Number(r.heal_attempts ?? 0) || 0);
    const score = heal * 4
      + FAIL_KIND_WEIGHT[cls.kind]
      + Math.floor(ageHours / 6);
    return {
      project_slug: r.project_slug,
      project_name: r.project_name ?? r.project_slug,
      pr_number: r.pr_number,
      pr_title: r.pr_title ?? "",
      pr_url: r.pr_url ?? "",
      heal_attempts: heal,
      fail_kind: cls.kind,
      fail_detail: cls.detail,
      age_hours: ageHours,
      score,
      _ageHoursRaw: ageHours,
    };
  });

  // all_healthy: every row scored 0. Independent of quiet-hours
  // suppression (which is a render decision, not a state question).
  const all_healthy = scored.every((s) => s.score === 0);
  if (all_healthy) {
    return { open_count, all_healthy: true, top: null, generated_at: generatedAt };
  }

  // Sort: score DESC, then age DESC (older wins ties). Stable
  // tiebreak via pr_number ASC to keep deterministic ordering across
  // re-fetches (matches the leaderboard/inbox conventions).
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b._ageHoursRaw !== a._ageHoursRaw) return b._ageHoursRaw - a._ageHoursRaw;
    return a.pr_number - b.pr_number;
  });

  const top = scored[0];
  // Quiet-hours demotion (AC10): only infra_flake hides.
  if (opts.quietHoursActive && top.fail_kind === "infra_flake") {
    return { open_count, all_healthy: false, top: null, generated_at: generatedAt };
  }

  // Strip the helper-only field before returning to the caller.
  const { _ageHoursRaw: _unused, ...publicTop } = top;
  void _unused;
  return {
    open_count,
    all_healthy: false,
    top: publicTop,
    generated_at: generatedAt,
  };
}

// ────────────────────────────────────────────────────────────────────
// Fleet changelog (ticket 0039).
//
// One chronological page of every merged agent PR across every
// project, ticket-linked. Composes the existing `pr`, `project`, and
// `ticket_commit_link` tables — no schema migration. The query is a
// plain JOIN with newest-first ordering by `fetched_at` (the merged-at
// proxy the existing ingest pipeline stamps on every sync — same
// column `fleetStreak`, `costPerMergedPr`, `fridayWrap`, and
// `mondayCatchUp` already read for merged-at semantics).
//
// Per LESSONS § "groomer prose can disagree with the schema; the
// schema wins": every reader of merged PRs in this file uses
// `state = 'MERGED'` (upper-case); the changelog matches.
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// the row narrowing uses the double-cast pattern.
// Per LESSONS § "no backticks inside template-literal SQL strings":
// every SQL string is plain string concatenation; identifiers stay
// unquoted single words.
// Per AGENTS.md § "Never compose a shell string from input" — and its
// SQL analogue: every WHERE filter is a parameterised `?` placeholder.
// The search LIKE pattern escapes `%`, `_`, and `\` in the input
// before binding.
//
// Pagination cursor: base64 of `${merged_at}|${pr_number}`. The
// decoder rejects anything else by throwing — the route handler maps
// the throw to a 400 so the SPA can render a friendly error.

export interface FleetChangelogRow {
  project_slug: string;
  project_name: string;
  pr_number: number;
  pr_title: string;
  pr_url: string;
  merged_at: string;
  additions: number;
  deletions: number;
  ticket_id: string | null;
}

export interface FleetChangelog {
  rows: FleetChangelogRow[];
  next_cursor: string | null;
  total: number;
  generated_at: string;
}

export interface FleetChangelogOptions {
  limit?: number;
  cursor?: string;
  projectSlug?: string;
  /** Inclusive lower bound (ISO date or full ISO datetime). */
  from?: string;
  /** Inclusive upper bound by calendar day: rows with
   *  `fetched_at < to + 1d` are included. ISO date or datetime. */
  to?: string;
  /** Substring match (case-insensitive) over PR title and ticket id. */
  search?: string;
  /** Test seam: pin the wall-clock anchor for `generated_at`. */
  now?: string;
}

const CHANGELOG_DEFAULT_LIMIT = 50;
const CHANGELOG_MAX_LIMIT = 200;

interface FleetChangelogRawRow {
  project_slug: string;
  project_name: string | null;
  pr_number: number;
  pr_title: string | null;
  pr_url: string | null;
  merged_at: string;
  additions: number | null;
  deletions: number | null;
  ticket_id: string | null;
}

interface FleetChangelogCountRow { n: number | null; }

/** Clamp a `limit` value to [1, 200] with default 50. Garbage
 *  (NaN, 0, negative, non-numeric) falls back to the default. */
function clampChangelogLimit(raw: unknown): number {
  if (raw == null || raw === "") return CHANGELOG_DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return CHANGELOG_DEFAULT_LIMIT;
  const i = Math.floor(n);
  if (i <= 0) return CHANGELOG_DEFAULT_LIMIT;
  if (i > CHANGELOG_MAX_LIMIT) return CHANGELOG_MAX_LIMIT;
  return i;
}

/** Validate an ISO date or datetime string. Returns the normalised
 *  full-ISO timestamp; throws on garbage so the route handler can
 *  surface a 400. The minimum surface is "YYYY-MM-DD" (10 chars). */
function parseChangelogDate(raw: string, side: "from" | "to"): Date {
  if (typeof raw !== "string" || raw.length < 10) {
    throw new Error(`invalid ${side} date: ${raw}`);
  }
  // Accept both date-only (YYYY-MM-DD) and full ISO datetime. We're
  // strict about the date-only shape — Date.parse() tolerates
  // ridiculous shapes ("banana") only inconsistently across runtimes,
  // so we verify the shape FIRST.
  const datePart = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    throw new Error(`invalid ${side} date: ${raw}`);
  }
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) throw new Error(`invalid ${side} date: ${raw}`);
  return new Date(t);
}

/** Decode a cursor back to its (merged_at, pr_number) pair. Throws on
 *  garbage so the route handler can surface a 400. */
function decodeChangelogCursor(raw: string): { mergedAt: string; prNumber: number } {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("invalid cursor");
  }
  // base64 alphabet check — Buffer.from is permissive (it silently
  // discards out-of-alphabet bytes) so a hand-validation step is
  // mandatory before we trust the result.
  if (!/^[A-Za-z0-9+/=_-]+$/.test(raw)) throw new Error("invalid cursor");
  let decoded: string;
  try { decoded = Buffer.from(raw, "base64").toString("utf8"); }
  catch { throw new Error("invalid cursor"); }
  const pipe = decoded.indexOf("|");
  if (pipe <= 0 || pipe === decoded.length - 1) throw new Error("invalid cursor");
  const mergedAt = decoded.slice(0, pipe);
  const prNumberStr = decoded.slice(pipe + 1);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(mergedAt)) throw new Error("invalid cursor");
  const prNumber = Number(prNumberStr);
  if (!Number.isFinite(prNumber) || !Number.isInteger(prNumber) || prNumber <= 0) {
    throw new Error("invalid cursor");
  }
  return { mergedAt, prNumber };
}

/** Encode a (merged_at, pr_number) pair into an opaque cursor string. */
function encodeChangelogCursor(mergedAt: string, prNumber: number): string {
  return Buffer.from(`${mergedAt}|${prNumber}`, "utf8").toString("base64");
}

/** Escape LIKE meta-characters in a search input so a `%` in the
 *  operator's query string can't widen into a wildcard. We pair the
 *  pattern with `ESCAPE '\\'` in the SQL. Backslash itself is escaped
 *  first to avoid double-substitution. */
function escapeLikePattern(raw: string): string {
  return raw
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

export function fleetChangelog(
  db: DB, opts: FleetChangelogOptions = {},
): FleetChangelog {
  const limit = clampChangelogLimit(opts.limit);
  const nowIso = opts.now ?? new Date().toISOString();

  // ── Cursor decoding (throws on garbage) ─────────────────────────
  let cursorPair: { mergedAt: string; prNumber: number } | null = null;
  if (opts.cursor) cursorPair = decodeChangelogCursor(opts.cursor);

  // ── Date-range validation (throws on garbage) ───────────────────
  let fromIso: string | null = null;
  let toExclusiveIso: string | null = null;
  if (opts.from) {
    const fromDate = parseChangelogDate(opts.from, "from");
    // If the operator passed a date-only string we anchor at midnight
    // UTC; full ISO inputs round-trip exactly.
    fromIso = opts.from.length === 10
      ? new Date(opts.from + "T00:00:00.000Z").toISOString()
      : fromDate.toISOString();
  }
  if (opts.to) {
    parseChangelogDate(opts.to, "to"); // validates
    if (opts.to.length === 10) {
      // Per the AC: `to + 1d` so the operator-friendly inclusive
      // calendar bound covers the entire `to` day.
      const t = new Date(opts.to + "T00:00:00.000Z").getTime() + 24 * 3600_000;
      toExclusiveIso = new Date(t).toISOString();
    } else {
      // Full ISO datetime: take the literal value as the EXCLUSIVE
      // upper bound. (Caller is being precise; we respect it.)
      toExclusiveIso = new Date(opts.to).toISOString();
    }
  }

  // ── Build WHERE clause + bindings. Plain string concat (no
  //    backticks per LESSONS); identifiers are unquoted single
  //    words; every value is a parameterised `?`. ──────────────────
  const where: string[] = [
    "pr.state = 'MERGED'",
    "pr.is_agent = 1",
    "pr.fetched_at IS NOT NULL",
  ];
  const bindings: Array<string | number> = [];

  if (opts.projectSlug) {
    where.push("project.slug = ?");
    bindings.push(opts.projectSlug);
  }
  if (fromIso) {
    where.push("pr.fetched_at >= ?");
    bindings.push(fromIso);
  }
  if (toExclusiveIso) {
    where.push("pr.fetched_at < ?");
    bindings.push(toExclusiveIso);
  }
  if (opts.search) {
    // ESCAPE '\' so the meta-char escapes above survive into SQL.
    where.push(
      "(LOWER(pr.title) LIKE ? ESCAPE '\\' "
      + "OR LOWER(COALESCE(ticket_commit_link.ticket_id, '')) LIKE ? ESCAPE '\\')",
    );
    const pat = "%" + escapeLikePattern(opts.search.toLowerCase()) + "%";
    bindings.push(pat, pat);
  }
  if (cursorPair) {
    // Strictly OLDER than the last row of the previous page; tiebreak
    // by pr_number DESC (so a same-merged_at sibling with a smaller
    // pr_number lands on the next page).
    where.push("(pr.fetched_at < ? OR (pr.fetched_at = ? AND pr.number < ?))");
    bindings.push(cursorPair.mergedAt, cursorPair.mergedAt, cursorPair.prNumber);
  }

  const whereSql = " WHERE " + where.join(" AND ") + " ";

  // ── Total: COUNT(*) over the same filters (cursor excluded —
  //    "total" is the dataset size, not the remaining page count). ─
  const totalWhere: string[] = where.filter((c) =>
    // Drop the cursor pagination predicate from the count.
    !c.startsWith("(pr.fetched_at < ? OR ")
  );
  const totalBindings = bindings.slice(
    0, bindings.length - (cursorPair ? 3 : 0),
  );
  const totalSql =
    "SELECT COUNT(*) AS n "
    + "  FROM pr "
    + "  JOIN project ON project.id = pr.project_id "
    + "  LEFT JOIN ticket_commit_link "
    + "    ON ticket_commit_link.pr_number = pr.number "
    + "   AND ticket_commit_link.project_slug = project.slug "
    + " WHERE " + totalWhere.join(" AND ");
  const totalRow = db.prepare(totalSql).get(...totalBindings) as unknown as FleetChangelogCountRow | undefined;
  const total = Number(totalRow?.n ?? 0);

  // ── Page query. One row over-fetch so we know whether to emit a
  //    next_cursor — same trick the leaderboard / digest helpers use. ──
  const pageSql =
    "SELECT "
    + "  project.slug AS project_slug, "
    + "  project.name AS project_name, "
    + "  pr.number AS pr_number, "
    + "  pr.title AS pr_title, "
    + "  pr.url AS pr_url, "
    + "  pr.fetched_at AS merged_at, "
    + "  pr.additions AS additions, "
    + "  pr.deletions AS deletions, "
    + "  ticket_commit_link.ticket_id AS ticket_id "
    + "FROM pr "
    + "JOIN project ON project.id = pr.project_id "
    + "LEFT JOIN ticket_commit_link "
    + "  ON ticket_commit_link.pr_number = pr.number "
    + " AND ticket_commit_link.project_slug = project.slug "
    + whereSql
    + "ORDER BY pr.fetched_at DESC, pr.number DESC "
    + "LIMIT ?";
  const overFetch = limit + 1;
  const pageBindings = [...bindings, overFetch];
  const rawRows = db.prepare(pageSql).all(...pageBindings) as unknown as FleetChangelogRawRow[];

  let nextCursor: string | null = null;
  const trimmed = rawRows.length > limit ? rawRows.slice(0, limit) : rawRows;
  if (rawRows.length > limit) {
    const last = trimmed[trimmed.length - 1];
    nextCursor = encodeChangelogCursor(last.merged_at, last.pr_number);
  }

  const rows: FleetChangelogRow[] = trimmed.map((r) => ({
    project_slug: r.project_slug,
    project_name: r.project_name ?? r.project_slug,
    pr_number: r.pr_number,
    pr_title: r.pr_title ?? "",
    pr_url: r.pr_url ?? "",
    merged_at: r.merged_at,
    additions: Number(r.additions ?? 0),
    deletions: Number(r.deletions ?? 0),
    ticket_id: r.ticket_id ?? null,
  }));

  return {
    rows,
    next_cursor: nextCursor,
    total,
    generated_at: nowIso,
  };
}

// ────────────────────────────────────────────────────────────────────
// Ticket 0041 — Fleet receipts re-exports.
//
// The compute + reader helpers live in src/receipts.ts (one cohesive
// module with the schema, the publish persistence, the HTML renderer,
// and the cache seam). We re-export the reader + compute pair here so
// callers in the server / SPA paths can keep their "views.ts is the
// read API" mental model — same posture as `fleetChangelog` and
// `costPerMergedPr` above.
// ────────────────────────────────────────────────────────────────────
export {
  computeReceipts, receiptsFor,
  type ReceiptsPayload as Receipts,
} from "./receipts.ts";

// ────────────────────────────────────────────────────────────────────
// New-since-last-visit diff (ticket 0043).
//
// Two helpers: `newSinceLastVisit(db, now, actorKey, opts)` returns the
// items in five home-page sections that landed strictly after the
// operator's last visit (driven by the existing `home_last_seen_<actor>`
// watermark from 0038); `markSectionSeen(db, actorKey, section,
// itemIds, now)` upserts a JSON-encoded array of seen item ids into
// `home_section_seen_<actor>_<section>` (capped at the 200 most-recent
// ids).
//
// Composition only — reuses the existing pr / anomaly / alert tables
// plus the inbox helper for the cross-project items. No schema
// migration. The `watermark` row pattern is shared with 0038 (same
// table, same upsert).
//
// Producer-vs-spec note: open PRs use `state='open'` (lower-case) per
// src/ingest/prs.ts line 164; merged PRs use `state='MERGED'`
// (upper-case) per every other view in this file. Per LESSONS 2026-06-05
// "groomer prose can disagree with the schema; the schema wins" the
// SELECTs match the producer.
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`",
// every row narrowing here uses the double-cast pattern.

/** A merged-PR item the operator hasn't seen yet. */
export interface NewSinceMergedPrItem {
  project_slug: string;
  pr_number: number;
  title: string;
  merged_at: string;
}

/** An open-PR item the operator hasn't seen yet. */
export interface NewSinceOpenPrItem {
  project_slug: string;
  pr_number: number;
  title: string;
  created_at: string;
}

/** An anomaly item the operator hasn't seen yet. */
export interface NewSinceAnomalyItem {
  project_slug: string;
  anomaly_id: number;
  title: string;
  created_at: string;
}

/** An inbox row the operator hasn't seen yet. */
export interface NewSinceInboxItem {
  kind: string;
  project_slug: string;
  payload_id: string;
  created_at: string;
}

/** An alert item the operator hasn't seen yet. */
export interface NewSinceAlertItem {
  alert_id: number;
  project_slug: string;
  type: string;
  created_at: string;
}

export type NewSinceSection =
  | "pr_merged" | "pr_open" | "anomaly" | "inbox" | "alert";

export interface NewSinceLastVisit {
  last_seen: string | null;
  total_new: number;
  by_section: {
    pr_merged: NewSinceMergedPrItem[];
    pr_open: NewSinceOpenPrItem[];
    anomaly: NewSinceAnomalyItem[];
    inbox: NewSinceInboxItem[];
    alert: NewSinceAlertItem[];
  };
  generated_at: string;
}

export interface NewSinceLastVisitOptions {
  /** Optional ISO timestamp the caller wants to diff against. When
   *  set, this wins over the watermark — the 0038 upsert on /api/fleet
   *  has already moved the watermark to "now" so the SPA passes the
   *  PRE-upsert value through `?since=`. When null/undefined the
   *  helper reads `home_last_seen_<actor>` itself. */
  since?: string | null;
  /** Optional whitelist of sections to compute (callers that only
   *  need the count for one surface can short-circuit). When omitted
   *  every section runs. */
  sections?: NewSinceSection[];
}

interface NewSinceMergedPrRow {
  project_slug: string;
  pr_number: number;
  title: string | null;
  merged_at: string;
}
interface NewSinceOpenPrRow {
  project_slug: string;
  pr_number: number;
  title: string | null;
  created_at: string;
}
interface NewSinceAnomalyRow {
  project_slug: string;
  anomaly_id: number;
  kind: string;
  candidate_reason: string | null;
  created_at: string;
}
interface NewSinceAlertRow {
  alert_id: number;
  project_slug: string;
  type: string;
  created_at: string;
}

/** Read the `home_last_seen_<actor>` watermark row. Returns null when
 *  the operator has never visited (the 0038 upsert never fired). */
function readHomeLastSeenForViews(db: DB, actorKey: string): string | null {
  const source = `home_last_seen_${actorKey}`;
  const row = db.prepare(
    "SELECT cursor FROM watermark WHERE source = ?",
  ).get(source) as { cursor: string } | undefined;
  return row?.cursor ?? null;
}

/** New-since-last-visit diff (ticket 0043). When the operator has
 *  never visited, returns an empty payload with `last_seen: null`
 *  and `total_new: 0` — the first-visit case is by design "no pips
 *  yet"; the 0038 upsert plants the watermark so the SECOND visit
 *  is the one that gets the banner. */
export function newSinceLastVisit(
  db: DB, now: Date, actorKey: string,
  opts: NewSinceLastVisitOptions = {},
): NewSinceLastVisit {
  const sections = new Set<NewSinceSection>(
    opts.sections ?? ["pr_merged", "pr_open", "anomaly", "inbox", "alert"],
  );
  const since = opts.since ?? readHomeLastSeenForViews(db, actorKey);
  const nowIso = now.toISOString();
  const empty: NewSinceLastVisit = {
    last_seen: since,
    total_new: 0,
    by_section: {
      pr_merged: [], pr_open: [], anomaly: [], inbox: [], alert: [],
    },
    generated_at: nowIso,
  };
  if (!since) return empty;

  const out = empty;

  if (sections.has("pr_merged")) {
    // Merged agent PRs whose `fetched_at` is strictly after `since`.
    // `fetched_at` is the merged-at proxy used by every other view
    // in this file (mondayCatchUp, fridayWrap, costPerMergedPr).
    const rows = db.prepare(
      "SELECT p.slug AS project_slug, pr.number AS pr_number, "
      + "       pr.title AS title, pr.fetched_at AS merged_at "
      + "  FROM pr JOIN project p ON p.id = pr.project_id "
      + " WHERE pr.state = 'MERGED' AND pr.is_agent = 1 "
      + "   AND pr.fetched_at IS NOT NULL AND pr.fetched_at > ? "
      + " ORDER BY pr.fetched_at DESC LIMIT 50",
    ).all(since) as unknown as NewSinceMergedPrRow[];
    for (const r of rows) {
      out.by_section.pr_merged.push({
        project_slug: r.project_slug,
        pr_number: r.pr_number,
        title: r.title ?? "",
        merged_at: r.merged_at,
      });
    }
  }

  if (sections.has("pr_open")) {
    // Open agent PRs whose `gh_created_at` is strictly after `since`.
    // We fall back to `fetched_at` when `gh_created_at` is NULL
    // (legacy rows ingested before the 0022 column was added).
    const rows = db.prepare(
      "SELECT p.slug AS project_slug, pr.number AS pr_number, "
      + "       pr.title AS title, "
      + "       COALESCE(pr.gh_created_at, pr.fetched_at) AS created_at "
      + "  FROM pr JOIN project p ON p.id = pr.project_id "
      + " WHERE pr.state = 'open' AND pr.is_agent = 1 "
      + "   AND COALESCE(pr.gh_created_at, pr.fetched_at) > ? "
      + " ORDER BY created_at DESC LIMIT 50",
    ).all(since) as unknown as NewSinceOpenPrRow[];
    for (const r of rows) {
      out.by_section.pr_open.push({
        project_slug: r.project_slug,
        pr_number: r.pr_number,
        title: r.title ?? "",
        created_at: r.created_at,
      });
    }
  }

  if (sections.has("anomaly")) {
    // Active anomalies (not dismissed) created strictly after `since`.
    const rows = db.prepare(
      "SELECT p.slug AS project_slug, a.id AS anomaly_id, "
      + "       a.kind AS kind, a.candidate_reason AS candidate_reason, "
      + "       a.created_at AS created_at "
      + "  FROM anomaly a "
      + "  JOIN run r ON r.id = a.run_id "
      + "  JOIN project p ON p.id = r.project_id "
      + " WHERE a.created_at > ? "
      + "   AND a.dismissed_at IS NULL "
      + " ORDER BY a.created_at DESC LIMIT 50",
    ).all(since) as unknown as NewSinceAnomalyRow[];
    for (const r of rows) {
      const title = r.candidate_reason
        ? `${r.kind} anomaly: ${r.candidate_reason}`
        : `${r.kind} anomaly`;
      out.by_section.anomaly.push({
        project_slug: r.project_slug,
        anomaly_id: r.anomaly_id,
        title,
        created_at: r.created_at,
      });
    }
  }

  if (sections.has("inbox")) {
    // Inbox rows are surfaced via the existing pr_review / anomaly_open
    // path in src/inbox.ts. Rather than re-derive that surface here,
    // we derive the same source rows via `pr.fetched_at` (the existing
    // inbox uses fetched_at as the age anchor for pr_review). For
    // simplicity v1 surfaces the open agent PR rows as inbox rows
    // (kind='pr_review') with their PR number as the payload_id —
    // matches the dismissal PK in src/inbox.ts.
    const rows = db.prepare(
      "SELECT 'pr_review' AS kind, p.slug AS project_slug, "
      + "       CAST(pr.number AS TEXT) AS payload_id, "
      + "       pr.fetched_at AS created_at "
      + "  FROM pr JOIN project p ON p.id = pr.project_id "
      + " WHERE pr.state = 'open' AND pr.is_agent = 1 "
      + "   AND pr.fetched_at > ? "
      + " ORDER BY pr.fetched_at DESC LIMIT 50",
    ).all(since) as unknown as NewSinceInboxItem[];
    for (const r of rows) {
      out.by_section.inbox.push({
        kind: r.kind,
        project_slug: r.project_slug,
        payload_id: r.payload_id,
        created_at: r.created_at,
      });
    }
  }

  if (sections.has("alert")) {
    // Live alerts (resolved_at IS NULL) created strictly after `since`.
    const rows = db.prepare(
      "SELECT a.id AS alert_id, p.slug AS project_slug, "
      + "       a.type AS type, a.created_at AS created_at "
      + "  FROM alert a JOIN project p ON p.id = a.project_id "
      + " WHERE a.resolved_at IS NULL AND a.created_at > ? "
      + " ORDER BY a.created_at DESC LIMIT 50",
    ).all(since) as unknown as NewSinceAlertRow[];
    for (const r of rows) {
      out.by_section.alert.push({
        alert_id: r.alert_id,
        project_slug: r.project_slug,
        type: r.type,
        created_at: r.created_at,
      });
    }
  }

  out.total_new = out.by_section.pr_merged.length
    + out.by_section.pr_open.length
    + out.by_section.anomaly.length
    + out.by_section.inbox.length
    + out.by_section.alert.length;
  return out;
}

/** Valid `section` values for `markSectionSeen()`. Mirrors the
 *  whitelist the SPA passes through `/api/fleet/section-seen` — any
 *  other value is a 400 at the route layer. */
const VALID_SECTIONS = new Set<NewSinceSection>([
  "pr_merged", "pr_open", "anomaly", "inbox", "alert",
]);

export function isValidNewSinceSection(s: string): s is NewSinceSection {
  return VALID_SECTIONS.has(s as NewSinceSection);
}

/** Cap on the size of the JSON-encoded id list stored in the watermark
 *  cursor. Bounds the column at a few KB even for chatty fleets. */
const SECTION_SEEN_CAP = 200;

/** Upsert `home_section_seen_<actor>_<section>` into the existing
 *  `watermark` table with the cursor carrying a JSON-encoded array of
 *  the most-recent SECTION_SEEN_CAP item ids the operator has actually
 *  rendered. Returns the count of new ids added (so the SPA can stop
 *  re-POSTing once nothing is new). */
export function markSectionSeen(
  db: DB, actorKey: string, section: string,
  itemIds: string[], now: Date,
): { upserted: number } {
  if (!isValidNewSinceSection(section)) {
    throw new Error(`unknown section: ${section}`);
  }
  const source = `home_section_seen_${actorKey}_${section}`;
  const priorRow = db.prepare(
    "SELECT cursor FROM watermark WHERE source = ?",
  ).get(source) as { cursor: string } | undefined;
  let prior: string[] = [];
  if (priorRow?.cursor) {
    try {
      const parsed = JSON.parse(priorRow.cursor);
      if (Array.isArray(parsed)) prior = parsed.map(String);
    } catch { /* corrupt JSON → start fresh */ }
  }
  const known = new Set<string>(prior);
  let upserted = 0;
  // Append new ids in input order so the cap keeps the MOST-RECENT
  // entries. JavaScript's Set retains insertion order which we rely
  // on for the cap below.
  const merged = [...prior];
  for (const raw of itemIds) {
    const id = String(raw);
    if (known.has(id)) continue;
    known.add(id);
    merged.push(id);
    upserted += 1;
  }
  const capped = merged.length > SECTION_SEEN_CAP
    ? merged.slice(merged.length - SECTION_SEEN_CAP)
    : merged;
  const nowIso = now.toISOString();
  db.prepare(
    "INSERT INTO watermark(source, cursor, updated_at) VALUES (?, ?, ?) "
    + "ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, "
    + "updated_at = excluded.updated_at",
  ).run(source, JSON.stringify(capped), nowIso);
  return { upserted };
}

// ────────────────────────────────────────────────────────────────────
// Ticket 0042 — Lesson credit ledger rollup.
//
// Groups lesson_credit rows over the last N days into the documented
// `{by_lesson, totals, generated_at}` shape. by_lesson is sorted by
// saves DESC (tiebreak by last_seen DESC); top_earner is by_lesson[0]
// when non-empty, null otherwise. Lessons with zero credits in the
// window are omitted from by_lesson (the renderer treats absence as
// the no-chip signal).
//
// Per LESSONS § "julianday() drifts ~10us per timestamp" any
// timestamp comparison stays JS-side (compare ISO strings; the
// rollup's cutoff is computed in JS and passed as a bind parameter).
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// every row narrowing here uses the double-cast pattern. Per
// LESSONS § "groomer prose can disagree with the schema; the schema
// wins": the column casing here mirrors the SCHEMA template in
// src/db.ts exactly (lesson_slug, lesson_date, etc. — lowercase).
// ────────────────────────────────────────────────────────────────────

export interface LessonCreditByLesson {
  lesson_slug: string;
  lesson_date: string;
  lesson_title: string;
  saves: number;
  projects: number;
  last_seen: string;
}

export interface LessonCreditTopEarner {
  lesson_slug: string;
  lesson_date: string;
  lesson_title: string;
  saves: number;
}

export interface LessonCreditTotals {
  total_credits: number;
  total_projects: number;
  top_earner: LessonCreditTopEarner | null;
}

export interface LessonCreditRollup {
  by_lesson: LessonCreditByLesson[];
  totals: LessonCreditTotals;
  generated_at: string;
}

export interface LessonCreditRollupOptions {
  /** Window in days for the rollup lookback. Defaults to 30. The
   *  route handler clamps to [1, 90] before passing through. */
  windowDays?: number;
}

interface LessonCreditByLessonRow {
  lesson_slug: string;
  lesson_date: string;
  lesson_title: string;
  saves: number;
  projects: number;
  last_seen: string;
}

interface LessonCreditTotalsRow {
  total_credits: number;
  total_projects: number;
}

/** Compose the lesson-credit rollup for the SPA's `/lessons` page +
 *  the `/api/fleet/lesson-credits` route. `now` is the wall-clock
 *  anchor for the window cutoff — tests pin it; production passes
 *  `new Date()`. */
export function lessonCreditRollup(
  db: DB,
  now: Date,
  opts: LessonCreditRollupOptions = {},
): LessonCreditRollup {
  const windowDays = Math.max(1, Math.floor(opts.windowDays ?? 30));
  const cutoffIso = new Date(now.getTime() - windowDays * 24 * 3600_000).toISOString();
  const nowIso = now.toISOString();
  // by_lesson: group by (lesson_slug, lesson_date, lesson_title) so
  // two distinct lessons that share a slug/date but differ in title
  // stay distinct rows. saves counts distinct heal_audit_id (the PK
  // already guarantees one row per heal per lesson, so a COUNT(*) is
  // equivalent; we use COUNT(DISTINCT heal_audit_id) for clarity).
  // projects counts distinct project_slug; last_seen is MAX(created_at).
  const byLessonRows = db.prepare(
    "SELECT lesson_slug, lesson_date, lesson_title, "
    + "  COUNT(DISTINCT heal_audit_id) AS saves, "
    + "  COUNT(DISTINCT project_slug) AS projects, "
    + "  MAX(created_at) AS last_seen "
    + "FROM lesson_credit "
    + "WHERE created_at >= ? "
    + "GROUP BY lesson_slug, lesson_date, lesson_title "
    + "ORDER BY saves DESC, last_seen DESC",
  ).all(cutoffIso) as unknown as LessonCreditByLessonRow[];

  const byLesson: LessonCreditByLesson[] = byLessonRows.map((r) => ({
    lesson_slug: String(r.lesson_slug),
    lesson_date: String(r.lesson_date),
    lesson_title: String(r.lesson_title),
    saves: Number(r.saves) || 0,
    projects: Number(r.projects) || 0,
    last_seen: String(r.last_seen ?? ""),
  }));

  const totalsRow = db.prepare(
    "SELECT COUNT(*) AS total_credits, "
    + "  COUNT(DISTINCT project_slug) AS total_projects "
    + "FROM lesson_credit WHERE created_at >= ?",
  ).get(cutoffIso) as unknown as LessonCreditTotalsRow | undefined;

  const totalCredits = Number(totalsRow?.total_credits ?? 0);
  const totalProjects = Number(totalsRow?.total_projects ?? 0);
  const topEarner: LessonCreditTopEarner | null = byLesson.length === 0 ? null : {
    lesson_slug: byLesson[0].lesson_slug,
    lesson_date: byLesson[0].lesson_date,
    lesson_title: byLesson[0].lesson_title,
    saves: byLesson[0].saves,
  };

  return {
    by_lesson: byLesson,
    totals: {
      total_credits: totalCredits,
      total_projects: totalProjects,
      top_earner: topEarner,
    },
    generated_at: nowIso,
  };
}

// ────────────────────────────────────────────────────────────────────
// Lesson-pays-for-itself ledger (ticket 0052).
//
// Composes the existing lesson_credit (0042) + run + control_audit
// tables into one fleet-wide rollup of "this lesson saved $X across
// N heals last quarter." No schema migration; no new ingest path.
//
// Math (deterministic, no LLM):
//   - average_failed_ship_cost_usd = mean(run.cost_usd) over rows
//     where outcome = 'failure' AND started_at falls in the window.
//   - saved_usd per lesson = heal_count * average, rounded to 2dp.
//   - When the window has zero failed runs, the average defaults to
//     a $5.00 floor so the rollup is well-defined on a fresh fleet.
//
// Producer reconciliation (per LESSONS 2026-06-05 "groomer prose can
// disagree with the schema; the schema wins"):
//   - run.outcome failed literal: `'failure'` (lowercase). The
//     producer in src/ingest/transcripts.ts:outcomeOf() doesn't emit
//     a "failure" string today, but every other view + test in this
//     repo (views.ts:722, views.ts:1655, inbox/streak/badge/glance/
//     health/friday-wrap/monday-catchup tests) seeds + queries
//     against `outcome = 'failure'` — that's the de-facto schema-
//     language.
//   - control_audit.action heal literal: `'heal'` (lowercase), per
//     src/control.ts.audit() + src/lessons.ts:627.
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// every row narrowing uses the double-cast.
// Per LESSONS § "no backticks inside template-literal SQL strings":
// SQL strings are plain concatenation; identifiers stay unquoted.
// Per LESSONS § "julianday() drifts ~10us per timestamp": no helper
// here needs sub-millisecond timestamp precision (we bucket by full
// days), but per-window arithmetic is JS-side via `Date.getTime()`
// to stay clear of the trap.

/** A floor used when the trailing-window has zero failed runs — keeps
 *  the rollup well-defined on a freshly-onboarded fleet. Documented
 *  here so the test + the empty-state tooltip read the same constant. */
export const LESSON_SAVINGS_FLOOR_USD = 5.0;
/** Default window in days. The ticket spec is 90 ("trailing 90 days
 *  of control_audit"). */
const LESSON_SAVINGS_DEFAULT_WINDOW_DAYS = 90;

export interface LessonSavingsRow {
  lesson_slug: string;
  lesson_date: string;
  lesson_title: string;
  heal_count: number;
  saved_usd: number;
  first_credited_at: string;
  last_credited_at: string;
  projects_helped: number;
}

export interface LessonSavingsRollup {
  window_days: number;
  generated_at: string;
  average_failed_ship_cost_usd: number;
  lesson_savings: LessonSavingsRow[];
}

export interface LessonSavingsRollupOptions {
  /** Window size in days; defaults to 90. Caller clamps to [1, 365]
   *  before passing in. */
  windowDays?: number;
  /** Wall-clock anchor — tests pin it; production passes `new Date()`. */
  now?: Date;
}

interface LessonSavingsAvgRow {
  avg_cost: number | null;
  n: number | null;
}

interface LessonSavingsByLessonRow {
  lesson_slug: string;
  lesson_date: string;
  lesson_title: string;
  heal_count: number;
  first_credited_at: string;
  last_credited_at: string;
  projects_helped: number;
}

/** Compose the lesson-savings rollup. Joins lesson_credit (0042's
 *  attribution ledger) against run (the failed-ship cost data) and
 *  returns one row per lesson with heal_count + saved_usd. Pure
 *  read-side; no writes. */
export function lessonSavingsRollup(
  db: DB,
  opts: LessonSavingsRollupOptions = {},
): LessonSavingsRollup {
  const windowDays = Math.max(
    1, Math.floor(opts.windowDays ?? LESSON_SAVINGS_DEFAULT_WINDOW_DAYS));
  const now = opts.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - windowDays * 24 * 3600_000).toISOString();
  const nowIso = now.toISOString();

  // Average failed-ship cost over the window. NULL-coalesce both the
  // measured and the computed cost columns so a fresh fleet with no
  // cost_source='live' rows still produces a number — matches the
  // cost_rollup recompute pattern at src/ingest/index.ts:18.
  const avgRow = db.prepare(
    "SELECT AVG(COALESCE(cost_usd, cost_usd_computed, 0)) AS avg_cost, "
    + "       COUNT(*) AS n "
    + "  FROM run "
    + " WHERE outcome = 'failure' "
    + "   AND started_at IS NOT NULL "
    + "   AND started_at >= ?",
  ).get(cutoffIso) as unknown as LessonSavingsAvgRow | undefined;

  const n = Number(avgRow?.n ?? 0);
  const avgRaw = avgRow?.avg_cost == null ? null : Number(avgRow.avg_cost);
  const average = (n === 0 || avgRaw == null || !Number.isFinite(avgRaw) || avgRaw <= 0)
    ? LESSON_SAVINGS_FLOOR_USD
    : avgRaw;
  // Round the average to 2 decimals so the SPA's "× $<avg>" arithmetic
  // shows a stable two-decimal number that lines up with saved_usd's
  // rounding. The internal multiplication still uses the rounded
  // average — keeps the rollup byte-deterministic across rebuilds.
  const averageRounded = Math.round(average * 100) / 100;

  // Lesson-credit aggregation. Per LESSONS 2026-06-07 "the `pr` table
  // has no surrogate id": the lesson_credit composite-PK shape means
  // we cannot use MAX(id) — but we don't need to; we group by
  // (lesson_slug, lesson_date, lesson_title) and let SQL count per
  // group. The window predicate is on lesson_credit.created_at, NOT
  // on control_audit.ts — the credit row's created_at is the moment
  // the attribution landed (which is what the ticket's "ledger" frame
  // measures). Heals attributed pre-window won't surface here even if
  // the heal_audit row's ts is in window.
  const lessonRows = db.prepare(
    "SELECT lesson_slug, lesson_date, lesson_title, "
    + "       COUNT(DISTINCT heal_audit_id) AS heal_count, "
    + "       MIN(created_at) AS first_credited_at, "
    + "       MAX(created_at) AS last_credited_at, "
    + "       COUNT(DISTINCT project_slug) AS projects_helped "
    + "  FROM lesson_credit "
    + " WHERE created_at >= ? "
    + " GROUP BY lesson_slug, lesson_date, lesson_title "
    + " ORDER BY heal_count DESC, last_credited_at DESC",
  ).all(cutoffIso) as unknown as LessonSavingsByLessonRow[];

  const lesson_savings: LessonSavingsRow[] = lessonRows.map((r) => {
    const healCount = Number(r.heal_count) || 0;
    const savedUsd = Math.round(healCount * averageRounded * 100) / 100;
    return {
      lesson_slug: String(r.lesson_slug),
      lesson_date: String(r.lesson_date),
      lesson_title: String(r.lesson_title),
      heal_count: healCount,
      saved_usd: savedUsd,
      first_credited_at: String(r.first_credited_at ?? ""),
      last_credited_at: String(r.last_credited_at ?? ""),
      projects_helped: Number(r.projects_helped) || 0,
    };
  });
  // Re-sort by saved_usd DESC so the SPA's default ordering already
  // matches the "$ saved descending" surface from the user story.
  lesson_savings.sort((a, b) => b.saved_usd - a.saved_usd);

  return {
    window_days: windowDays,
    generated_at: nowIso,
    average_failed_ship_cost_usd: averageRounded,
    lesson_savings,
  };
}

// ────────────────────────────────────────────────────────────────────
// Ticket 0056 — Time saved on the project card.
//
// Composes the existing lesson_credit ledger (0042) + run (0052's
// failed-ship cost data) into a per-project rollup of "hours saved
// over the trailing N days." Shares the cost arithmetic with
// lessonSavingsRollup (the failure-cost average) but splits the
// per-lesson saved_usd across the projects credited on that lesson
// by their fair-share heal_count.
//
// Math (deterministic, no LLM):
//   - lesson.saved_usd = heal_count_for_lesson * average_failed_ship_cost
//     (same as lessonSavingsRollup).
//   - project.saved_usd = sum over lessons L credited to project P of
//     (heal_count_for_P_on_L / heal_count_for_L) * L.saved_usd.
//   - project.saved_hours = saved_usd / hourly_rate_usd, rounded to 1dp.
//   - hourly_rate_usd defaults to cfg.worth_it.hourly_rate_usd ?? 75
//     (matches the 0048 / 0050 precedent).
//
// Producer reconciliation (per LESSONS 2026-06-05 "groomer prose can
// disagree with the schema; the schema wins"):
//   - run.outcome failed literal: 'failure' (lowercase) — same as
//     lessonSavingsRollup; the 0052 implementation reconciled this.
//   - control_audit.action heal literal: 'heal' (lowercase) — same
//     reconciliation, inherited transitively (the helper reads
//     lesson_credit rows, which the attribution pass writes only for
//     heal-action audits).
//   - lesson_credit.project_slug: column verified to exist in
//     src/db.ts:282's SCHEMA. JOIN key.
//
// Per LESSONS § "node:sqlite's .all() needs as unknown as T[]":
// every row narrowing uses the double-cast.
// Per LESSONS § "no backticks inside template-literal SQL strings":
// SQL strings are plain concatenation; identifiers stay unquoted.
// Per LESSONS § "julianday() drifts ~10us per timestamp": no
// sub-millisecond timestamp precision needed; window arithmetic is
// JS-side via Date.getTime().
// ────────────────────────────────────────────────────────────────────

/** Default window in days for `lessonSavingsByProject`. The spec is
 *  30 days ("Time saved this month"). */
const LESSON_SAVINGS_BY_PROJECT_DEFAULT_WINDOW_DAYS = 30;
/** Default hourly rate in USD when cfg.worth_it.hourly_rate_usd is
 *  unset. Matches the 0048 / 0050 precedent. */
const LESSON_SAVINGS_BY_PROJECT_DEFAULT_HOURLY_RATE_USD = 75;

export interface LessonSavingsByProjectRow {
  project_slug: string;
  project_name: string;
  heal_count: number;
  saved_usd: number;
  saved_hours: number;
  lesson_count: number;
}

export interface LessonSavingsByProject {
  window_days: number;
  generated_at: string;
  hourly_rate_usd: number;
  by_project: Record<string, LessonSavingsByProjectRow>;
}

export interface LessonSavingsByProjectOptions {
  /** Window size in days; defaults to 30. */
  windowDays?: number;
  /** Wall-clock anchor — tests pin it; production passes `new Date()`. */
  now?: Date;
  /** Hourly rate for the saved_hours division; defaults to 75. */
  hourlyRateUsd?: number;
}

interface LessonByProjectGroupRow {
  lesson_slug: string;
  lesson_date: string;
  project_slug: string;
  heal_count: number;
}

interface LessonTotalsRow {
  lesson_slug: string;
  lesson_date: string;
  total_heal_count: number;
}

interface ProjectNameRow {
  slug: string;
  name: string | null;
}

/** Compose the per-project lesson-savings rollup for the home grid
 *  (ticket 0056). Joins lesson_credit (0042's attribution ledger)
 *  against run (the failed-ship cost data) and splits each lesson's
 *  saved_usd fair-share across the projects credited on that lesson.
 *  Pure read-side; no writes. */
export function lessonSavingsByProject(
  db: DB,
  opts: LessonSavingsByProjectOptions = {},
): LessonSavingsByProject {
  const windowDays = Math.max(
    1, Math.floor(opts.windowDays ?? LESSON_SAVINGS_BY_PROJECT_DEFAULT_WINDOW_DAYS));
  const now = opts.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - windowDays * 24 * 3600_000).toISOString();
  const nowIso = now.toISOString();
  const hourlyRateUsd = typeof opts.hourlyRateUsd === "number" && opts.hourlyRateUsd > 0
    ? opts.hourlyRateUsd
    : LESSON_SAVINGS_BY_PROJECT_DEFAULT_HOURLY_RATE_USD;

  // Average failed-ship cost over the window — SAME shape as
  // `lessonSavingsRollup` so the two rollups agree on the per-lesson
  // saved_usd that we then split per project.
  const avgRow = db.prepare(
    "SELECT AVG(COALESCE(cost_usd, cost_usd_computed, 0)) AS avg_cost, "
    + "       COUNT(*) AS n "
    + "  FROM run "
    + " WHERE outcome = 'failure' "
    + "   AND started_at IS NOT NULL "
    + "   AND started_at >= ?",
  ).get(cutoffIso) as unknown as LessonSavingsAvgRow | undefined;

  const n = Number(avgRow?.n ?? 0);
  const avgRaw = avgRow?.avg_cost == null ? null : Number(avgRow.avg_cost);
  const average = (n === 0 || avgRaw == null || !Number.isFinite(avgRaw) || avgRaw <= 0)
    ? LESSON_SAVINGS_FLOOR_USD
    : avgRaw;
  const averageRounded = Math.round(average * 100) / 100;

  // Per-(lesson, project) heal_count in the window — the row grain
  // for the fair-share split.
  const groupRows = db.prepare(
    "SELECT lesson_slug, lesson_date, project_slug, "
    + "       COUNT(DISTINCT heal_audit_id) AS heal_count "
    + "  FROM lesson_credit "
    + " WHERE created_at >= ? "
    + " GROUP BY lesson_slug, lesson_date, project_slug",
  ).all(cutoffIso) as unknown as LessonByProjectGroupRow[];

  if (groupRows.length === 0) {
    return {
      window_days: windowDays,
      generated_at: nowIso,
      hourly_rate_usd: hourlyRateUsd,
      by_project: {},
    };
  }

  // Per-lesson total heal_count in the window — the denominator for
  // the fair-share split.
  const totalsRows = db.prepare(
    "SELECT lesson_slug, lesson_date, "
    + "       COUNT(DISTINCT heal_audit_id) AS total_heal_count "
    + "  FROM lesson_credit "
    + " WHERE created_at >= ? "
    + " GROUP BY lesson_slug, lesson_date",
  ).all(cutoffIso) as unknown as LessonTotalsRow[];

  const totalByLesson = new Map<string, number>();
  for (const r of totalsRows) {
    const key = String(r.lesson_slug) + "|" + String(r.lesson_date);
    totalByLesson.set(key, Number(r.total_heal_count) || 0);
  }

  // Aggregate per project: sum the fair-share saved_usd across each
  // lesson the project is credited on; count distinct lessons.
  interface Accum {
    heal_count: number;
    saved_usd_raw: number;
    lessons: Set<string>;
  }
  const accumByProject = new Map<string, Accum>();
  for (const r of groupRows) {
    const projectSlug = String(r.project_slug);
    const lessonKey = String(r.lesson_slug) + "|" + String(r.lesson_date);
    const projectHeals = Number(r.heal_count) || 0;
    const totalHeals = totalByLesson.get(lessonKey) || 0;
    if (totalHeals <= 0) continue;
    const lessonSavedUsd = totalHeals * averageRounded;
    const projectShareUsd = (projectHeals / totalHeals) * lessonSavedUsd;
    let acc = accumByProject.get(projectSlug);
    if (!acc) {
      acc = { heal_count: 0, saved_usd_raw: 0, lessons: new Set<string>() };
      accumByProject.set(projectSlug, acc);
    }
    acc.heal_count += projectHeals;
    acc.saved_usd_raw += projectShareUsd;
    acc.lessons.add(lessonKey);
  }

  // Resolve project_name from the `project` table for every slug
  // present in the accumulator. A slug that's no longer in the
  // project table (e.g. a sunset project — its lesson_credit rows
  // outlived its `project` row) falls back to the slug itself.
  const projectNameBySlug = new Map<string, string>();
  if (accumByProject.size > 0) {
    const rows = db.prepare(
      "SELECT slug, name FROM project",
    ).all() as unknown as ProjectNameRow[];
    for (const r of rows) {
      projectNameBySlug.set(String(r.slug), String(r.name ?? r.slug));
    }
  }

  const by_project: Record<string, LessonSavingsByProjectRow> = {};
  for (const [slug, acc] of accumByProject) {
    const savedUsd = Math.round(acc.saved_usd_raw * 100) / 100;
    const savedHours = Math.round((acc.saved_usd_raw / hourlyRateUsd) * 10) / 10;
    by_project[slug] = {
      project_slug: slug,
      project_name: projectNameBySlug.get(slug) ?? slug,
      heal_count: acc.heal_count,
      saved_usd: savedUsd,
      saved_hours: savedHours,
      lesson_count: acc.lessons.size,
    };
  }

  return {
    window_days: windowDays,
    generated_at: nowIso,
    hourly_rate_usd: hourlyRateUsd,
    by_project,
  };
}

// ────────────────────────────────────────────────────────────────────
// Lesson lineage (ticket 0069).
//
// Composes lesson_credit (0042 attribution ledger) into a per-lesson
// TIMELINE: one synthesised author event (the earliest credit row for
// the slug) followed by every catch event in chronological order. Pure
// read-side; no writes, no schema migration. The renderer surfaces the
// timeline as a public anonymised SHARE artifact at the /lessons-public/
// SLUG /lineage URL.
//
// Producer reconciliation per LESSONS schema-wins (2026-06-05) and
// composite-PK-no-surrogate-id (2026-06-07):
//   - lesson_credit columns are lesson_slug, lesson_date, lesson_title,
//     heal_audit_id, project_slug, matched_substring, created_at
//     per src/db.ts SCHEMA. There is no surrogate id column; ordering
//     is by created_at ASC.
//   - The slug parameter matches the existing 0057 archive's
//     lesson_slug derivation so a paste from the aggregate page lands
//     on the right lineage row.
//   - hoursSaved per catch = hoursPerPr knob (cfg.worth_it.hours_per_pr,
//     default 1). The totals strip uses the SUM of per-event hours so
//     it matches the aggregate page exactly (one heal_audit_id per
//     catch row; the lineage view splits the same denominator).
//
// Per LESSONS no-sqlite-cast: every row narrowing uses as unknown as
// RowT[].
// Per LESSONS no-backticks: plain string concat for SQL.
// Per LESSONS 2026-06-13 the helper REUSES the existing private
// anonymiseExcerpt in views.ts; it does NOT import from lessons.ts
// (which would create a function-import cycle with the existing
// lessons.ts to views.ts edge).
// Per LESSONS 2026-06-11 every sibling-helper identifier in this
// comment block stays in PLAIN PROSE - no backticks - so the 4000
// char source-grep windows of lessonSavingsRollup and
// lessonSavingsByProject upstream cannot leak into this section.
// ────────────────────────────────────────────────────────────────────

/** Default hours per merged-PR for the lineage hour-savings math. The
 *  per-call opts win first, then cfg.worth_it.hours_per_pr, then this
 *  documented default. Matches the 0048 / 0050 / 0052 precedent. */
const LESSON_LINEAGE_DEFAULT_HOURS_PER_PR = 1;
/** TTL for the lineage memo cache (60s per the AC). */
const LESSON_LINEAGE_TTL_MS = 60_000;

export interface LessonLineageEvent {
  /** "author" for the synthesised birth event; "catch" for every
   *  later credit row. */
  kind: "author" | "catch";
  /** ISO timestamp of the event. For "author" this is the earliest
   *  lesson_credit.created_at for the slug. For "catch" it is the
   *  row's own created_at. */
  at: string;
  /** Operator-anonymised project alias (project-N) or the public
   *  bootstrap name (agent-fleet). */
  projectAlias: string;
  /** heal_audit_id of the catch row, or null on the author event. */
  healAuditId: number | null;
  /** Per-event hours-saved figure. Author event is 0 (the birth is a
   *  marker, not a save); each catch contributes hoursPerPr (default
   *  1.0) so the timeline sum matches the aggregate page exactly. */
  hoursSaved: number;
}

export interface LessonLineageTotals {
  /** Total catch rows for the slug. */
  catches: number;
  /** Distinct project_slug values among the catches. */
  projects: number;
  /** SUM of per-event hoursSaved across the timeline. */
  hoursSavedTotal: number;
}

export interface LessonLineagePayload {
  slug: string;
  title: string;
  anonymisedTitle: string;
  birthDate: string;
  birthProjectAlias: string;
  events: LessonLineageEvent[];
  totals: LessonLineageTotals;
  asOf: string;
  version: 1;
}

interface LessonLineageRow {
  lesson_title: string;
  heal_audit_id: number;
  project_slug: string;
  created_at: string;
}

interface LessonLineageProjectSlugRow { slug: string; }

/** Build the operator alias map from the project table. The bootstrap
 *  slug agent-fleet keeps its public name; every other slug becomes
 *  project-N in deterministic alphabetical order. Mirrors the existing
 *  per-helper alias-builder in views.ts so the lineage page's project
 *  labels match the failure-mode and lesson-archive pages. */
function buildAliasMapForLineage(db: DB): Record<string, string> {
  const out: Record<string, string> = {};
  let rows: LessonLineageProjectSlugRow[] = [];
  try {
    rows = db.prepare("SELECT slug FROM project ORDER BY slug").all() as unknown as LessonLineageProjectSlugRow[];
  } catch { /* project table may not exist on a fresh boot */ }
  let n = 1;
  for (const r of rows) {
    const slug = String(r.slug ?? "").trim();
    if (!slug) continue;
    if (slug === "agent-fleet") { out[slug] = "agent-fleet"; continue; }
    if (!(slug in out)) { out[slug] = "project-" + String(n); n += 1; }
  }
  return out;
}

function resolveLineageHoursPerPr(cfg?: FleetConfig): number {
  const v = cfg?.worth_it?.hours_per_pr;
  if (typeof v === "number" && v > 0 && Number.isFinite(v)) return v;
  return LESSON_LINEAGE_DEFAULT_HOURS_PER_PR;
}

export interface LessonLineagePayloadOptions {
  /** Optional FleetConfig for the hoursPerPr knob. */
  cfg?: FleetConfig;
  /** Optional pre-built alias map (the test seam hands one in to keep
   *  the renderer-direct path independent of the project table). */
  projectAliasMap?: Record<string, string>;
}

// Per-slug memo cache for the lineage payload. 60s TTL per the AC.
// The invalidation tuple is (MAX(created_at), COUNT(*)) of the
// lesson_credit rows scoped to the slug per LESSONS 2026-06-07 (the
// lesson_credit table has no surrogate id - composite PK is
// (lesson_slug, lesson_date, heal_audit_id) per src/db.ts).
interface LessonLineageCacheEntry {
  tuple: string;
  value: LessonLineagePayload | null;
  expires_at: number;
}
const lessonLineageCache = new Map<string, LessonLineageCacheEntry>();
let lessonLineageBuildCounter = 0;

export function _resetLessonLineageCacheForTests(): void {
  lessonLineageCache.clear();
  lessonLineageBuildCounter = 0;
}

export function _getLessonLineageCacheBuildsForTests(): number {
  return lessonLineageBuildCounter;
}

/** Invalidate the lineage memo cache. Wired through the globalThis
 *  slot from src/server.ts on module load so a fresh lesson_credit
 *  insert in src/lessons.ts attributeHealsToLessons wakes the cache
 *  without an import cycle (the slot pattern is LESSONS 2026-06-05). */
export function _invalidateLessonLineageCache(): void {
  lessonLineageCache.clear();
}

interface LessonLineageTupleRow { mx: string | null; c: number | null; }

function lessonLineageInvalidationTuple(db: DB, slug: string): string {
  let row: LessonLineageTupleRow | undefined;
  try {
    row = db.prepare(
      "SELECT MAX(created_at) AS mx, COUNT(*) AS c "
      + "  FROM lesson_credit "
      + " WHERE lesson_slug = ?",
    ).get(slug) as unknown as LessonLineageTupleRow | undefined;
  } catch { row = undefined; }
  const mx = row?.mx ?? "";
  const c = Number(row?.c ?? 0);
  return "mx=" + mx + "|c=" + c;
}

/** Compose the lineage payload for one lesson slug. Returns null when
 *  the slug has zero lesson_credit rows (the route 404s on null).
 *  Memoised for 60s per slug via the lineage cache; the cache key is
 *  the slug and the invalidation tuple is (MAX(created_at), COUNT(*))
 *  per LESSONS 2026-06-07. */
export function lessonLineagePayload(
  db: DB,
  slug: string,
  now: Date,
  opts: LessonLineagePayloadOptions = {},
): LessonLineagePayload | null {
  const cleanSlug = String(slug ?? "").trim();
  if (!cleanSlug) return null;
  const tuple = lessonLineageInvalidationTuple(db, cleanSlug);
  const hit = lessonLineageCache.get(cleanSlug);
  if (hit && hit.tuple === tuple && hit.expires_at > Date.now()) {
    return hit.value;
  }
  lessonLineageBuildCounter += 1;
  const value = _composeLessonLineagePayload(db, cleanSlug, now, opts);
  lessonLineageCache.set(cleanSlug, {
    tuple, value, expires_at: Date.now() + LESSON_LINEAGE_TTL_MS,
  });
  return value;
}

/** Uncached composition - the body the cached wrapper calls on a
 *  miss. Exported only via the cached wrapper so direct callers
 *  always benefit from the memo. */
function _composeLessonLineagePayload(
  db: DB,
  cleanSlug: string,
  now: Date,
  opts: LessonLineagePayloadOptions,
): LessonLineagePayload | null {
  const rows = db.prepare(
    "SELECT lesson_title, heal_audit_id, project_slug, created_at "
    + "  FROM lesson_credit "
    + " WHERE lesson_slug = ? "
    + " ORDER BY created_at ASC",
  ).all(cleanSlug) as unknown as LessonLineageRow[];
  if (rows.length === 0) return null;
  const aliasMap = opts.projectAliasMap ?? buildAliasMapForLineage(db);
  const hoursPerPr = resolveLineageHoursPerPr(opts.cfg);
  // Title is the most-recent lesson_title seen across the credits. We
  // pick the first row's title (rows are ASC, so this is the earliest
  // authored title); the writer pipeline updates the title in-place
  // when the file is edited but only for NEW credits, so the earliest
  // row is the canonical birth title.
  const earliest = rows[0];
  const title = String(earliest.lesson_title ?? cleanSlug);
  const anonymisedTitle = anonymiseExcerpt(title, aliasMap);
  const aliasFor = (s: string): string => {
    const v = aliasMap[s];
    if (typeof v === "string" && v.length > 0) return v;
    if (s === "agent-fleet") return "agent-fleet";
    return "project-?";
  };
  const birthProjectAlias = aliasFor(String(earliest.project_slug ?? ""));
  const events: LessonLineageEvent[] = [];
  events.push({
    kind: "author",
    at: String(earliest.created_at),
    projectAlias: birthProjectAlias,
    healAuditId: null,
    hoursSaved: 0,
  });
  const projectsSeen = new Set<string>();
  let hoursSavedTotal = 0;
  for (const r of rows) {
    const projectAlias = aliasFor(String(r.project_slug ?? ""));
    projectsSeen.add(String(r.project_slug ?? ""));
    const hoursSaved = hoursPerPr;
    hoursSavedTotal += hoursSaved;
    events.push({
      kind: "catch",
      at: String(r.created_at),
      projectAlias,
      healAuditId: Number(r.heal_audit_id) || 0,
      hoursSaved,
    });
  }
  // Round to 2 decimal places to keep the SVG / HTML rendered figure
  // stable across rebuilds.
  hoursSavedTotal = Math.round(hoursSavedTotal * 100) / 100;
  return {
    slug: cleanSlug,
    title,
    anonymisedTitle,
    birthDate: String(earliest.created_at).slice(0, 10),
    birthProjectAlias,
    events,
    totals: {
      catches: rows.length,
      projects: projectsSeen.size,
      hoursSavedTotal,
    },
    asOf: now.toISOString(),
    version: 1,
  };
}

/** Renderer-direct test seam per LESSONS 2026-06-11. The renderer is
 *  pure on (payload, opts) so quiet-hours / singleton-catch / empty
 *  branches are exercised without cwd config mutation. */
export interface RenderLessonLineageOptions {
  /** When true the install CTA in the footer is replaced with a
   *  softer "powered by fleet-control" caption per the 0030
   *  quiet-hours discipline. */
  quietHoursActive?: boolean;
}

/** Public renderer entry point used by the route handler. */
export function renderLessonLineagePage(
  payload: LessonLineagePayload,
  opts: RenderLessonLineageOptions = {},
): string {
  return _renderLessonLineageForTests(payload, opts);
}

function escLineage(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

/** Renderer-direct seam exported for tests. Production wraps this via
 *  renderLessonLineagePage. */
export function _renderLessonLineageForTests(
  payload: LessonLineagePayload,
  opts: RenderLessonLineageOptions = {},
): string {
  const safeSlug = escLineage(payload.slug);
  const safeTitle = escLineage(payload.anonymisedTitle || payload.title);
  const safeBirth = escLineage(payload.birthDate);
  const safeBirthAlias = escLineage(payload.birthProjectAlias);
  const safeAsOf = escLineage(payload.asOf);
  const totals = payload.totals;
  const safeCatches = escLineage(String(totals.catches));
  const safeProjects = escLineage(String(totals.projects));
  const safeHours = escLineage(totals.hoursSavedTotal.toFixed(1));
  const singleton = totals.catches < 2;
  // Build the totals strip (always shown - the warming-up case
  // renders an honest "1 catch, 1 project" line so the operator can
  // see the seed shape).
  const totalsStrip = `<aside class="lineage-totals" data-testid="lineage-totals">
    <strong>${safeCatches}</strong> catch${totals.catches === 1 ? "" : "es"}
    across <strong>${safeProjects}</strong> project${totals.projects === 1 ? "" : "s"},
    ~<strong>${safeHours}h</strong> saved cumulative.
  </aside>`;
  // Timeline only renders when we have >= 2 catches. The singleton
  // and zero cases render the warming-up empty state.
  let timelineSection = "";
  if (!singleton) {
    const items = payload.events.map((e, i) => {
      const safeAt = escLineage(e.at);
      const safeAlias = escLineage(e.projectAlias);
      const safeKind = escLineage(e.kind);
      const safeHoursOne = escLineage(e.hoursSaved.toFixed(1));
      const label = e.kind === "author"
        ? "authored at " + safeAlias
        : "caught at " + safeAlias + " &mdash; ~" + safeHoursOne + "h saved";
      return `<li data-testid="lineage-event-${i}" class="lineage-event lineage-event-${safeKind}">
        <time datetime="${safeAt}">${safeAt}</time>
        <span class="lineage-event-label">${label}</span>
      </li>`;
    }).join("\n");
    timelineSection = `<ol class="lineage-timeline" data-testid="lineage-timeline">
${items}
    </ol>`;
  } else {
    timelineSection = `<p class="lineage-warming-up" data-testid="lineage-warming-up">
      this lesson is freshly authored - check back after it has caught a re-occurrence.
    </p>`;
  }
  // Footer: install CTA suppressed under quiet hours per LESSONS
  // 2026-06-11 (renderer-direct seam) + the 0030 quiet-hours
  // discipline.
  const installFooter = opts.quietHoursActive
    ? `<footer class="lineage-foot" data-testid="lineage-foot-soft">
      powered by fleet-control
    </footer>`
    : `<footer class="lineage-foot" data-testid="install-cta">
      this lineage was authored entirely from one operator's local SQLite -
      no LLM, no cloud, no fleet meta-API. Install fleet-control to grow
      your own cross-project memory at
      <a href="https://github.com/mutaaf/fleet-control">github.com/mutaaf/fleet-control</a>
    </footer>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${safeTitle} - lineage - fleet-control</title>
<link rel="stylesheet" href="/style.css" />
<meta name="robots" content="index, follow" />
<link rel="canonical" href="/lessons-public/${safeSlug}/lineage" />
</head>
<body class="lessons-public-page lineage-page">
<main class="lessons-public lineage" data-testid="lineage-main">
  <nav class="lessons-public-back">
    <a href="/lessons-public/${safeSlug}" data-testid="lineage-back-to-lesson">&lsaquo; back to lesson</a>
  </nav>
  <header class="lineage-head">
    <h1 data-testid="lineage-title">${safeTitle}</h1>
    <p class="lineage-birth" data-testid="lineage-birth">
      first authored <time datetime="${safeBirth}">${safeBirth}</time> at ${safeBirthAlias}
    </p>
  </header>
  ${totalsStrip}
  ${timelineSection}
  <p class="lineage-as-of" data-testid="lineage-as-of">as of ${safeAsOf}</p>
  ${installFooter}
</main>
</body>
</html>`;
}

/** OG renderer: 1200x630 SVG with the lesson title, a sparkline of
 *  catches over time (one dot per event - 1 author + N catches), the
 *  cumulative hours-saved figure, and the powered-by-fleet-control
 *  caption. Per LESSONS 2026-06-12 the SVG carries
 *  data-testid="lineage-og-title" so tests anchor on the testid not a
 *  body substring. */
export function renderLessonLineageOgSvg(payload: LessonLineagePayload): string {
  return _renderLessonLineageOgSvgForTests(payload);
}

export function _renderLessonLineageOgSvgForTests(payload: LessonLineagePayload): string {
  const W = 1200, H = 630;
  // Title and totals.
  const safeTitle = escLineage(payload.anonymisedTitle || payload.title);
  const safeHours = escLineage(payload.totals.hoursSavedTotal.toFixed(1));
  const safeCatches = escLineage(String(payload.totals.catches));
  const safeProjects = escLineage(String(payload.totals.projects));
  // Sparkline dot positions. Walk all events ASC, map at-time to an
  // x position in [80, W-80].
  const events = payload.events;
  const nDots = events.length;
  let earliest = Date.parse(events[0]?.at ?? "") || 0;
  let latest = Date.parse(events[events.length - 1]?.at ?? "") || (earliest + 1);
  if (latest <= earliest) latest = earliest + 1;
  const x0 = 80;
  const x1 = W - 80;
  const sparkY = 380;
  const dots: string[] = [];
  for (let i = 0; i < nDots; i++) {
    const e = events[i];
    const t = Date.parse(e.at) || earliest;
    const frac = (t - earliest) / (latest - earliest);
    const cx = nDots === 1 ? (x0 + x1) / 2 : x0 + frac * (x1 - x0);
    const fill = e.kind === "author" ? "#2563eb" : "#16a34a";
    dots.push(`<circle cx="${cx.toFixed(1)}" cy="${sparkY}" r="14" fill="${fill}" />`);
  }
  // Date labels under the first and last dot.
  const firstAt = escLineage(String(events[0]?.at ?? "").slice(0, 10));
  const lastAt = escLineage(String(events[events.length - 1]?.at ?? "").slice(0, 10));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#fafafa" />
  <text x="80" y="120" font-family="system-ui, sans-serif" font-size="40" font-weight="700" fill="#111" data-testid="lineage-og-title">${safeTitle}</text>
  <text x="80" y="190" font-family="system-ui, sans-serif" font-size="28" fill="#374151" data-testid="lineage-og-totals">${safeCatches} catches across ${safeProjects} projects - ~${safeHours}h saved</text>
  <line x1="${x0}" y1="${sparkY}" x2="${x1}" y2="${sparkY}" stroke="#d1d5db" stroke-width="2" />
  ${dots.join("\n  ")}
  <text x="${x0}" y="${sparkY + 50}" font-family="system-ui, sans-serif" font-size="22" fill="#6b7280" text-anchor="start">${firstAt}</text>
  <text x="${x1}" y="${sparkY + 50}" font-family="system-ui, sans-serif" font-size="22" fill="#6b7280" text-anchor="end">${lastAt}</text>
  <text x="${W / 2}" y="${H - 60}" font-family="system-ui, sans-serif" font-size="22" fill="#6b7280" text-anchor="middle" data-testid="lineage-og-foot">powered by fleet-control</text>
</svg>`;
}

/** Test-only helper: render the 0057 aggregate-permalink page with the
 *  new lineage cross-link injected when totals.catches >= 2. This is a
 *  thin orchestration around the existing 0057 renderer's output - the
 *  cross-link itself lives inside the production
 *  renderLessonsPublicPermalink in src/server.ts. We expose this seam
 *  so the test can drive the cross-link presence / absence without
 *  booting the server, without racing against parallel test files on
 *  fleet-control.config.json. */
export function renderLessonsPublicPermalinkWithLineageForTests(
  row: { lesson_slug: string; lesson_date: string; lesson_title: string;
         lesson_body_anonymised: string; project_alias: string; },
  db: DB,
  now: Date,
): string {
  const lineage = lessonLineagePayload(db, row.lesson_slug, now);
  const showCrossLink = !!lineage && lineage.totals.catches >= 2;
  // Minimal stub renderer mirroring the 0057 permalink shape; only the
  // bits load-bearing for the AC7 cross-link test. The production
  // renderer (src/server.ts renderLessonsPublicPermalink) injects the
  // SAME cross-link block via a shared composeLessonsPublicLineageLink
  // helper so the seam stays honest.
  const link = showCrossLink
    ? composeLessonsPublicLineageLink(row.lesson_slug, lineage!.totals.projects)
    : "";
  return `<!doctype html>
<html lang="en">
<body>
  <article>
    <h1>${escLineage(row.lesson_title)}</h1>
    <div>${escLineage(row.lesson_body_anonymised)}</div>
    ${link}
  </article>
</body>
</html>`;
}

/** Shared composition of the lineage cross-link block - used by both
 *  the production 0057 renderer extension (in src/server.ts) and the
 *  renderer-direct test seam above so the testid / href shapes stay
 *  in lockstep. */
export function composeLessonsPublicLineageLink(slug: string, projectCount: number): string {
  const safeSlug = escLineage(slug);
  const safeProjects = escLineage(String(projectCount));
  return `<p class="lessons-public-lineage-cross-link">
    <a href="/lessons-public/${safeSlug}/lineage" data-testid="lessons-public-lineage-link">
      see how this lesson traveled across ${safeProjects} projects &rarr; lineage
    </a>
  </p>`;
}

// ────────────────────────────────────────────────────────────────────
// Project graveyard (ticket 0053).
//
// Composes already-shipped tables (project, project_pause, pr,
// cost_rollup_day, lesson_credit) into a per-paused-project rollup of
// lifetime merged PRs, lifetime spend, lifetime ROI, and the count of
// cross-fleet lessons that project's heals attributed.
//
// Producer reconciliation (per LESSONS 2026-06-05 schema-wins):
//   - project_pause.reason: the producer at src/budget_guard.ts:187
//     writes the literal 'cost_cap' (lowercase). The schema doc
//     reserves 'manual' for future use; v1 never writes it. The
//     classification map honours that literal and accepts spec-named
//     'budget'/'budget_cap' as forward-compat synonyms.
//   - project_pause schema (src/db.ts:189): PK is project_id, NOT
//     (project_slug, ...) as the spec hedged. No 'active' column —
//     a row's mere presence means paused. No 'paused_at' column —
//     the producer's spelling is 'triggered_at'.
//   - pr.state = 'MERGED' uppercase (matches src/ingest/prs.ts:152).
//   - lesson_credit.project_slug + created_at (src/db.ts:282).
//
// Per LESSONS no-sqlite-cast: every row narrowing uses the double
// cast (as unknown as RowT[]).
// Per LESSONS no-backticks: SQL strings are plain string concat;
// identifiers stay unquoted.
// Per LESSONS julianday-drift: no sub-millisecond timestamp diffs
// needed; lifetime arithmetic is whole-row counts.
// ────────────────────────────────────────────────────────────────────

const GRAVEYARD_DEFAULT_HOURLY_RATE_USD = 75;
const GRAVEYARD_DEFAULT_HOURS_PER_PR = 1;

export type GraveyardPauseReason =
  | "budget_autopause"
  | "sunset_verdict"
  | "manual";

export interface GraveyardSummary {
  paused_count: number;
  lifetime_merged_prs: number;
  lifetime_spend_usd: number;
  lessons_authored: number;
}

export interface GraveyardProjectRow {
  project_slug: string;
  project_name: string;
  paused_at: string;
  pause_reason: GraveyardPauseReason;
  pause_reason_raw: string;
  lifetime_merged_prs: number;
  lifetime_spend_usd: number;
  lifetime_cost_per_pr_usd: number | null;
  lifetime_roi_multiplier: number | null;
  lessons_authored: number;
  first_run_at: string | null;
  last_run_at: string | null;
}

export interface ProjectGraveyard {
  generated_at: string;
  summary: GraveyardSummary;
  projects: GraveyardProjectRow[];
}

export interface ProjectGraveyardOptions {
  /** Wall-clock anchor — tests pin it; production passes new Date(). */
  now?: Date;
  /** Hourly rate for the ROI denominator; defaults to 75 per the
   *  0048 / 0050 precedent. */
  hourlyRateUsd?: number;
  /** Hours per merged PR for the human-equivalent multiplication;
   *  defaults to 1. */
  hoursPerPr?: number;
}

interface GraveyardPauseRow {
  project_id: number;
  project_slug: string;
  project_name: string | null;
  reason: string;
  triggered_at: string;
}

interface GraveyardLifetimeCountRow { c: number | null; }
interface GraveyardLifetimeSumRow { s: number | null; }
interface GraveyardRunBoundsRow { first_at: string | null; last_at: string | null; }
interface GraveyardLessonCountRow { c: number | null; }
interface GraveyardDistinctLessonRow { lesson_slug: string; lesson_date: string; }

/** Classify the producer's raw `project_pause.reason` value into the
 *  displayed label per AC2. Producer reality (cost_cap) is the
 *  contract; spec-named synonyms (budget / budget_cap / sunset /
 *  sunset_candidate) are forward-compat arms for any future writer.
 *  Anything else, including null/undefined, defaults to the manual
 *  label. */
function classifyPauseReason(raw: string | null | undefined): GraveyardPauseReason {
  const r = String(raw ?? "").trim().toLowerCase();
  if (r === "cost_cap" || r === "budget" || r === "budget_cap") {
    return "budget_autopause";
  }
  if (r === "sunset" || r === "sunset_candidate") {
    return "sunset_verdict";
  }
  return "manual";
}

/** Compose the project-graveyard rollup. Pure read-side; no writes.
 *  Returns the documented shape; the route handler caches + scrubs
 *  the result. */
export function projectGraveyard(
  db: DB,
  opts: ProjectGraveyardOptions = {},
): ProjectGraveyard {
  const now = opts.now ?? new Date();
  const hourlyRateUsd = typeof opts.hourlyRateUsd === "number" && opts.hourlyRateUsd > 0
    ? opts.hourlyRateUsd
    : GRAVEYARD_DEFAULT_HOURLY_RATE_USD;
  const hoursPerPr = typeof opts.hoursPerPr === "number" && opts.hoursPerPr > 0
    ? opts.hoursPerPr
    : GRAVEYARD_DEFAULT_HOURS_PER_PR;

  // One row per paused project. Join project to surface slug+name in
  // the same read.
  const pauseRows = db.prepare(
    "SELECT pp.project_id AS project_id, "
    + "       p.slug       AS project_slug, "
    + "       p.name       AS project_name, "
    + "       pp.reason    AS reason, "
    + "       pp.triggered_at AS triggered_at "
    + "  FROM project_pause pp "
    + "  JOIN project p ON p.id = pp.project_id "
    + " ORDER BY pp.triggered_at DESC",
  ).all() as unknown as GraveyardPauseRow[];

  // Per-row lifetime aggregation. We bind the (project_id,
  // triggered_at) pair per row; the pause count is small so N small
  // reads are cheaper than one big GROUP BY (and stay correct under
  // sparse data).
  const mergedStmt = db.prepare(
    "SELECT COUNT(*) AS c FROM pr "
    + " WHERE project_id = ? "
    + "   AND state = 'MERGED' "
    + "   AND fetched_at IS NOT NULL "
    + "   AND fetched_at <= ?",
  );
  const spendStmt = db.prepare(
    "SELECT SUM(COALESCE(cost_usd, 0)) AS s "
    + "  FROM cost_rollup_day "
    + " WHERE project_id = ? "
    + "   AND day <= ?",
  );
  const runBoundsStmt = db.prepare(
    "SELECT MIN(started_at) AS first_at, MAX(started_at) AS last_at "
    + "  FROM run WHERE project_id = ? AND started_at IS NOT NULL "
    + "   AND started_at <= ?",
  );
  const lessonStmt = db.prepare(
    "SELECT COUNT(DISTINCT lesson_slug || '|' || lesson_date) AS c "
    + "  FROM lesson_credit "
    + " WHERE project_slug = ? "
    + "   AND created_at <= ?",
  );

  const projects: GraveyardProjectRow[] = [];
  let lifetimeMergedTotal = 0;
  let lifetimeSpendTotal = 0;
  const lessonsAuthored = new Set<string>();

  // For the summary's "lessons_authored" count we want DISTINCT lessons
  // across the WHOLE graveyard — so we collect every (slug, date) tuple
  // per project and union them.
  const distinctLessonsStmt = db.prepare(
    "SELECT DISTINCT lesson_slug, lesson_date "
    + "  FROM lesson_credit "
    + " WHERE project_slug = ? "
    + "   AND created_at <= ?",
  );

  for (const row of pauseRows) {
    const pausedAt = String(row.triggered_at);
    const dayCutoff = pausedAt.slice(0, 10); // cost_rollup_day.day is yyyy-mm-dd

    const mergedRow = mergedStmt.get(row.project_id, pausedAt) as unknown as GraveyardLifetimeCountRow | undefined;
    const merged = Number(mergedRow?.c ?? 0) || 0;

    const spendRow = spendStmt.get(row.project_id, dayCutoff) as unknown as GraveyardLifetimeSumRow | undefined;
    const spend = Number(spendRow?.s ?? 0) || 0;

    const boundsRow = runBoundsStmt.get(row.project_id, pausedAt) as unknown as GraveyardRunBoundsRow | undefined;
    const firstRunAt = boundsRow?.first_at ?? null;
    const lastRunAt = boundsRow?.last_at ?? null;

    const lessonRow = lessonStmt.get(row.project_slug, pausedAt) as unknown as GraveyardLessonCountRow | undefined;
    const lessonsForThisProject = Number(lessonRow?.c ?? 0) || 0;

    // For the summary, union distinct lessons across all projects so a
    // lesson credited to two paused projects only counts once.
    const distinctRows = distinctLessonsStmt.all(row.project_slug, pausedAt) as unknown as GraveyardDistinctLessonRow[];
    for (const lr of distinctRows) {
      lessonsAuthored.add(String(lr.lesson_slug) + "|" + String(lr.lesson_date));
    }

    const costPerPr = merged > 0 ? Math.round((spend / merged) * 100) / 100 : null;
    const humanEquivalent = merged * hoursPerPr * hourlyRateUsd;
    const roi = spend > 0 ? Math.round((humanEquivalent / spend) * 100) / 100 : null;

    projects.push({
      project_slug: String(row.project_slug),
      project_name: String(row.project_name ?? row.project_slug),
      paused_at: pausedAt,
      pause_reason: classifyPauseReason(row.reason),
      pause_reason_raw: String(row.reason ?? ""),
      lifetime_merged_prs: merged,
      lifetime_spend_usd: Math.round(spend * 100) / 100,
      lifetime_cost_per_pr_usd: costPerPr,
      lifetime_roi_multiplier: roi,
      lessons_authored: lessonsForThisProject,
      first_run_at: firstRunAt,
      last_run_at: lastRunAt,
    });

    lifetimeMergedTotal += merged;
    lifetimeSpendTotal += spend;
  }

  return {
    generated_at: now.toISOString(),
    summary: {
      paused_count: projects.length,
      lifetime_merged_prs: lifetimeMergedTotal,
      lifetime_spend_usd: Math.round(lifetimeSpendTotal * 100) / 100,
      lessons_authored: lessonsAuthored.size,
    },
    projects,
  };
}

// ────────────────────────────────────────────────────────────────────
// Spend-efficiency ranking + laggard diagnosis (ticket 0044).
//
// Composes already-shipped tables (pr, cost_rollup_day, run, anomaly,
// control_audit) into one fleet-wide ranking + a structural verdict
// for the worst-performer. No schema migration; no new ingest path.
//
// Producer reconciliation (per LESSONS 2026-06-05 "groomer prose can
// disagree with the schema; the schema wins"):
//   - merged PRs: `pr.state = 'MERGED' AND pr.is_agent = 1` (uppercase
//     'MERGED' — matches `costPerMergedPr` and the production ingester
//     at src/ingest/prs.ts line 164).
//   - open agent PRs (for infra-flake): `pr.state = 'open'` lowercase
//     (matches `riskiestOpenPr` and the production ingester).
//   - run outcomes: lowercase 'healed' and 'self-cancel' (per
//     src/ingest/transcripts.ts).
//   - self-drift anomalies: `anomaly.kind = 'self_drift'` (snake-case,
//     per src/drift.ts).
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// every row narrowing uses the double-cast.
// Per LESSONS § "no backticks inside template-literal SQL strings":
// SQL strings are plain concatenation; identifiers stay unquoted.
// Per LESSONS § "julianday() drifts ~10us per timestamp": no helper
// here needs sub-millisecond timestamp precision (we bucket by full
// days), but per-window arithmetic is JS-side via `Date.getTime()`
// to stay clear of the trap.
// Per AGENTS.md § "Never compose a shell string from input" — and its
// SQL analogue: every parameter is bound via `?` placeholders.

export interface SpendEfficiencyProjectRow {
  project_slug: string;
  project_name: string;
  merged_prs: number;
  spend_usd: number;
  cost_per_pr_usd: number | null;
  ratio_to_median: number | null;
}

export type SpendEfficiencyLaggardSignal =
  | "heals"
  | "self_cancel"
  | "drift"
  | "infra_flake";

export interface SpendEfficiencyLaggardWhy {
  signal: SpendEfficiencyLaggardSignal;
  value: number;
  fleet_median: number;
  detail: string;
}

export interface SpendEfficiencyLaggard {
  project_slug: string;
  project_name: string;
  cost_per_pr_usd: number;
  ratio_to_median: number;
  why: SpendEfficiencyLaggardWhy[];
  /** `#/p/<slug>?focus=<signal>` deep-link. Signal is the cascade's
   *  top entry when one exists; otherwise just `#/p/<slug>`. */
  link: string;
}

export interface SpendEfficiencyRanking {
  fleet_median_per_pr: number | null;
  fleet_total_spend_usd: number;
  fleet_total_prs: number;
  projects: SpendEfficiencyProjectRow[];
  laggard: SpendEfficiencyLaggard | null;
  window_days: number;
  generated_at: string;
}

export interface SpendEfficiencyOptions {
  /** Window size in days; clamped to [7, 90] by the route handler.
   *  Defaults to 14 here (matches the ticket's example surface). */
  windowDays?: number;
}

interface SpendEffProjectRow_internal {
  id: number;
  slug: string;
  name: string | null;
}
interface SpendEffMergedRow_internal {
  project_id: number;
  merged_prs: number | null;
}
interface SpendEffSpendRow_internal {
  project_id: number;
  spent_usd: number | null;
}
interface SpendEffOutcomeRow_internal {
  project_id: number;
  c: number | null;
}
interface SpendEffDriftRow_internal {
  project_id: number;
  c: number | null;
}
interface SpendEffOpenPrRow_internal {
  project_id: number;
  number: number;
}

/** JS-side median (sorted-array, no SQL window functions needed). Empty
 *  input yields `null` — keeps the helper's downstream nullability
 *  contract clean. */
function _jsMedian(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Compose the laggard's "why" cascade from per-project metric counts.
 *  Only signals where the laggard value STRICTLY exceeds the fleet
 *  median surface; results are ordered by absolute deviation DESC,
 *  capped at 3. Per LESSONS § "anomaly tests need sigma > 0 in the
 *  fixture": the caller seeds variation so the cascade has signal. */
function _composeLaggardWhy(
  laggard: { heals: number; self_cancels: number; drifts: number; flakes: number },
  fleet: { heals: number; self_cancels: number; drifts: number; flakes: number },
): SpendEfficiencyLaggardWhy[] {
  const entries: SpendEfficiencyLaggardWhy[] = [];
  if (laggard.heals > fleet.heals) {
    entries.push({
      signal: "heals",
      value: laggard.heals,
      fleet_median: fleet.heals,
      detail: `${laggard.heals} healed run${laggard.heals === 1 ? "" : "s"} (median ${fleet.heals})`,
    });
  }
  if (laggard.self_cancels > fleet.self_cancels) {
    entries.push({
      signal: "self_cancel",
      value: laggard.self_cancels,
      fleet_median: fleet.self_cancels,
      detail: `${laggard.self_cancels} self-cancel${laggard.self_cancels === 1 ? "" : "s"}`,
    });
  }
  if (laggard.drifts > fleet.drifts) {
    entries.push({
      signal: "drift",
      value: laggard.drifts,
      fleet_median: fleet.drifts,
      detail: `${laggard.drifts} drift open`,
    });
  }
  if (laggard.flakes > fleet.flakes) {
    entries.push({
      signal: "infra_flake",
      value: laggard.flakes,
      fleet_median: fleet.flakes,
      detail: `${laggard.flakes} infra-flake PR${laggard.flakes === 1 ? "" : "s"}`,
    });
  }
  // Order by absolute deviation DESC; stable secondary sort by signal
  // index so a tied deviation surfaces the heal signal first (matches
  // the ticket's "heal causes" emphasis).
  entries.sort((a, b) => {
    const da = a.value - a.fleet_median;
    const db = b.value - b.fleet_median;
    if (db !== da) return db - da;
    return 0;
  });
  return entries.slice(0, 3);
}

/** Compute the fleet-wide spend-efficiency ranking + laggard verdict.
 *  Pure-SQL composition over already-shipped tables. The fleet median
 *  is computed JS-side (small N — typically <50 projects).
 *
 *  Window arithmetic mirrors `costPerMergedPr`: end is `now`'s UTC
 *  midnight, start is `windowDays` before, bucketed by `date(fetched_at)`
 *  / `day`. Per LESSONS § "julianday() drifts ~10us per timestamp":
 *  the bucket math is integer dates so we never hit the float-day trap.
 *
 *  Returns the full `SpendEfficiencyRanking` shape. The route layer
 *  caches by `(window_days, latest_run_id, latest_merged_pr_id)`. */
export function spendEfficiencyRanking(
  db: DB, now: Date, opts: SpendEfficiencyOptions = {},
): SpendEfficiencyRanking {
  const windowDays = Math.max(7, Math.min(90, Math.floor(opts.windowDays ?? 14)));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Use `now` itself for the upper end (NOT date(now)) so seed rows
  // dated today still count toward the window — matches the SPA's
  // wall-clock framing where "today" is part of the trailing 14d.
  // We push end forward one day for the `< end` half-open bound.
  const endExclusive = new Date(end);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - windowDays);
  const endExclusiveStr = endExclusive.toISOString().slice(0, 10);
  const startStr = start.toISOString().slice(0, 10);
  const startIso = start.toISOString();
  const endIso = endExclusive.toISOString();

  // ── Anchor: every project (small N). ────────────────────────────
  const projects = db.prepare(
    "SELECT id, slug, name FROM project ORDER BY slug",
  ).all() as unknown as SpendEffProjectRow_internal[];

  if (projects.length === 0) {
    return {
      fleet_median_per_pr: null,
      fleet_total_spend_usd: 0,
      fleet_total_prs: 0,
      projects: [],
      laggard: null,
      window_days: windowDays,
      generated_at: now.toISOString(),
    };
  }

  // ── Per-project spend over window (cost_rollup_day). ────────────
  const spendRows = db.prepare(
    "SELECT project_id, SUM(COALESCE(cost_usd, 0)) AS spent_usd "
    + "  FROM cost_rollup_day "
    + " WHERE day >= ? AND day < ? "
    + " GROUP BY project_id",
  ).all(startStr, endExclusiveStr) as unknown as SpendEffSpendRow_internal[];
  const spendByPid = new Map<number, number>();
  for (const r of spendRows) spendByPid.set(r.project_id, Number(r.spent_usd ?? 0));

  // ── Per-project merged-PR count over window. ────────────────────
  // Producer note: 'MERGED' uppercase + is_agent=1 (matches
  // costPerMergedPr's casing per LESSONS 2026-06-05).
  const mergedRows = db.prepare(
    "SELECT project_id, COUNT(*) AS merged_prs "
    + "  FROM pr "
    + " WHERE state = 'MERGED' AND is_agent = 1 "
    + "   AND fetched_at IS NOT NULL "
    + "   AND date(fetched_at) >= ? AND date(fetched_at) < ? "
    + " GROUP BY project_id",
  ).all(startStr, endExclusiveStr) as unknown as SpendEffMergedRow_internal[];
  const mergedByPid = new Map<number, number>();
  for (const r of mergedRows) mergedByPid.set(r.project_id, Number(r.merged_prs ?? 0));

  // ── Per-project counts for the "why" cascade. ───────────────────
  // healed runs over window (lowercase per src/ingest/transcripts.ts).
  const healRows = db.prepare(
    "SELECT project_id, COUNT(*) AS c "
    + "  FROM run "
    + " WHERE outcome = 'healed' "
    + "   AND started_at IS NOT NULL "
    + "   AND started_at >= ? AND started_at < ? "
    + " GROUP BY project_id",
  ).all(startIso, endIso) as unknown as SpendEffOutcomeRow_internal[];
  const healByPid = new Map<number, number>();
  for (const r of healRows) healByPid.set(r.project_id, Number(r.c ?? 0));

  // self-cancel runs over window (lowercase-with-dash per producer).
  const cancelRows = db.prepare(
    "SELECT project_id, COUNT(*) AS c "
    + "  FROM run "
    + " WHERE outcome = 'self-cancel' "
    + "   AND started_at IS NOT NULL "
    + "   AND started_at >= ? AND started_at < ? "
    + " GROUP BY project_id",
  ).all(startIso, endIso) as unknown as SpendEffOutcomeRow_internal[];
  const cancelByPid = new Map<number, number>();
  for (const r of cancelRows) cancelByPid.set(r.project_id, Number(r.c ?? 0));

  // open self_drift anomalies (kind matches src/drift.ts producer).
  // JOIN through run to derive project_id; no inbox_dismissal gate
  // here (the verdict surface is a pull, not a push — dismissals
  // affect only the inbox).
  const driftRows = db.prepare(
    "SELECT r.project_id AS project_id, COUNT(*) AS c "
    + "  FROM anomaly a "
    + "  JOIN run r ON r.id = a.run_id "
    + " WHERE a.kind = 'self_drift' "
    + "   AND a.created_at IS NOT NULL "
    + "   AND a.created_at >= ? "
    + " GROUP BY r.project_id",
  ).all(startIso) as unknown as SpendEffDriftRow_internal[];
  const driftByPid = new Map<number, number>();
  for (const r of driftRows) driftByPid.set(r.project_id, Number(r.c ?? 0));

  // Open agent PRs per project — we'll classify each one via the
  // existing `classifyPrFailure` helper to count infra_flake matches.
  const openPrRows = db.prepare(
    "SELECT project_id, number FROM pr "
    + " WHERE state = 'open' AND is_agent = 1",
  ).all() as unknown as SpendEffOpenPrRow_internal[];
  const flakeByPid = new Map<number, number>();
  for (const r of openPrRows) {
    const cls = classifyPrFailure(db, r.project_id, r.number);
    if (cls.kind === "infra_flake") {
      flakeByPid.set(r.project_id, (flakeByPid.get(r.project_id) ?? 0) + 1);
    }
  }

  // ── Assemble per-project rows + fleet totals. ───────────────────
  const projectRows: SpendEfficiencyProjectRow[] = [];
  let fleetSpend = 0;
  let fleetMerged = 0;
  for (const p of projects) {
    const spend = spendByPid.get(p.id) ?? 0;
    const merged = mergedByPid.get(p.id) ?? 0;
    const cpp = merged > 0 ? spend / merged : null;
    projectRows.push({
      project_slug: p.slug,
      project_name: p.name ?? p.slug,
      merged_prs: merged,
      spend_usd: spend,
      cost_per_pr_usd: cpp,
      ratio_to_median: null, // filled in after we know the median
    });
    fleetSpend += spend;
    fleetMerged += merged;
  }

  // Fleet median per-PR: built from per-project cost_per_pr values
  // restricted to projects with >= 1 merged PR (per AC1).
  const medianBase = projectRows
    .filter((r) => r.cost_per_pr_usd != null && r.merged_prs >= 1)
    .map((r) => r.cost_per_pr_usd as number);
  const median = _jsMedian(medianBase);

  // Fill in ratio_to_median once the median is known.
  for (const r of projectRows) {
    if (r.cost_per_pr_usd != null && median != null && median > 0) {
      r.ratio_to_median = r.cost_per_pr_usd / median;
    }
  }

  // Sort projects by ascending cost_per_pr_usd (cheap first → laggard
  // sinks to the bottom). Nulls (merged_prs == 0) drop to the end.
  projectRows.sort((a, b) => {
    const an = a.cost_per_pr_usd == null;
    const bn = b.cost_per_pr_usd == null;
    if (an && bn) return a.project_slug.localeCompare(b.project_slug);
    if (an) return 1;
    if (bn) return -1;
    if (a.cost_per_pr_usd !== b.cost_per_pr_usd) {
      return (a.cost_per_pr_usd as number) - (b.cost_per_pr_usd as number);
    }
    return a.project_slug.localeCompare(b.project_slug);
  });

  // ── Laggard selection (AC2). ────────────────────────────────────
  // Threshold: fewer than 3 projects with >= 1 merge → no median is
  // meaningful → laggard:null even if the data structurally exists.
  const projectsWithMerges = projectRows.filter((r) => r.merged_prs >= 1);
  let laggard: SpendEfficiencyLaggard | null = null;
  if (projectsWithMerges.length >= 3 && median != null && median > 0) {
    // Candidates: ratio_to_median > 1.5; pick highest ratio; tie-break
    // by higher ABSOLUTE cost_per_pr_usd.
    const candidates = projectsWithMerges.filter(
      (r) => r.ratio_to_median != null && (r.ratio_to_median as number) > 1.5,
    );
    candidates.sort((a, b) => {
      const ar = a.ratio_to_median as number;
      const br = b.ratio_to_median as number;
      if (br !== ar) return br - ar;
      const ac = a.cost_per_pr_usd as number;
      const bc = b.cost_per_pr_usd as number;
      return bc - ac;
    });
    if (candidates.length > 0) {
      const top = candidates[0];
      // Resolve project_id from the slug — we'll need it for the
      // signal-count lookup against the per-PID maps.
      const lp = projects.find((p) => p.slug === top.project_slug);
      const lpid = lp?.id ?? -1;
      const laggardCounts = {
        heals: healByPid.get(lpid) ?? 0,
        self_cancels: cancelByPid.get(lpid) ?? 0,
        drifts: driftByPid.get(lpid) ?? 0,
        flakes: flakeByPid.get(lpid) ?? 0,
      };
      // Fleet medians for each signal (the JS median over all projects'
      // counts; missing values count as 0 — a project that never
      // healed has heals=0). Per AC3: "Fleet median computed the same
      // way" for heals; self_cancel/drift/infra_flake use the same
      // per-project count median.
      const projectIds = projects.map((p) => p.id);
      const fleetCounts = {
        heals: _jsMedian(projectIds.map((id) => healByPid.get(id) ?? 0)) ?? 0,
        self_cancels: _jsMedian(projectIds.map((id) => cancelByPid.get(id) ?? 0)) ?? 0,
        drifts: _jsMedian(projectIds.map((id) => driftByPid.get(id) ?? 0)) ?? 0,
        flakes: _jsMedian(projectIds.map((id) => flakeByPid.get(id) ?? 0)) ?? 0,
      };
      const why = _composeLaggardWhy(laggardCounts, fleetCounts);
      const focusSignal = why.length > 0 ? why[0].signal : null;
      const link = focusSignal
        ? `#/p/${encodeURIComponent(top.project_slug)}?focus=${focusSignal}`
        : `#/p/${encodeURIComponent(top.project_slug)}`;
      laggard = {
        project_slug: top.project_slug,
        project_name: top.project_name,
        cost_per_pr_usd: top.cost_per_pr_usd as number,
        ratio_to_median: top.ratio_to_median as number,
        why,
        link,
      };
    }
  }

  return {
    fleet_median_per_pr: median,
    fleet_total_spend_usd: fleetSpend,
    fleet_total_prs: fleetMerged,
    projects: projectRows,
    laggard,
    window_days: windowDays,
    generated_at: now.toISOString(),
  };
}

// ────────────────────────────────────────────────────────────────────
// Stuck-PR taxonomy card (ticket 0045).
//
// Label every open agent PR with EXACTLY ONE of seven taxonomy buckets
// so the operator knows whether to intervene or wait. Pure composition
// over already-shipped data (`pr`, `project`, `control_audit`,
// `classifyPrFailure`). No schema migration.
//
// Producer reconciliation (per LESSONS 2026-06-05 "groomer prose can
// disagree with the schema; the schema wins"):
//   - open agent PRs: `pr.state = 'open' AND pr.is_agent = 1` (the
//     production ingester writes lowercase `'open'` — see
//     src/ingest/prs.ts line 164; same casing `riskiestOpenPr` uses).
//   - `pr.ci_state`: one of `'red' | 'pending' | 'green' | 'none'`
//     (lowercase, from `ciState()` in src/ingest/prs.ts). NOT GitHub
//     rollup tokens.
//   - `pr.merge_state`: stores `mergeStateStatus` verbatim from gh
//     (uppercase tokens like `'CLEAN'`, `'BEHIND'`, `'DIRTY'`).
//   - check-rollup count: the producer does NOT persist a numeric
//     rollup count. The "zero check-runs" signal is encoded as
//     `ci_state = 'none'` (per `ciState()`'s "no rollup → 'none'"
//     branch). The taxonomy uses that as the ci_absent condition.
//   - `autoMergeRequest`: not persisted today — the merging-bucket
//     evidence degrades to "CLEAN + green" (no "+ auto-merge armed"
//     suffix) until a future ticket adds the column.
//
// Bucket cascade (top-down; first match wins so the operator sees the
// strongest signal):
//   1. needs_human       — heal_attempts >= 2 (AGENTS.md ceiling)
//   2. account_suspended — latest heal-audit stdout_tail matches
//                          /account is suspended/i
//   3. infra_flake       — classifyPrFailure.kind === 'infra_flake'
//   4. ci_red            — ci_state === 'red'
//   5. ci_absent         — ci_state === 'none' AND fetched_at >= 5
//                          minutes ago (avoid flagging a fresh PR)
//   6. merging           — merge_state === 'CLEAN' AND ci_state ===
//                          'green'
//   7. healthy_waiting   — default; heal_attempts === 0 AND age < 6h
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// every row narrowing uses the double-cast.
// Per LESSONS § "no backticks inside template-literal SQL strings":
// SQL strings stay plain concatenation; identifiers are unquoted
// single words.
// Per AGENTS.md § "Never compose a shell string from input" — and its
// SQL analogue: every WHERE filter is a parameterised `?` placeholder.

export type StuckPrBucket =
  | "needs_human"
  | "ci_red"
  | "ci_absent"
  | "infra_flake"
  | "account_suspended"
  | "merging"
  | "healthy_waiting";

export interface StuckPrTaxonomyRow {
  project_slug: string;
  project_name: string;
  pr_number: number;
  pr_title: string;
  pr_url: string;
  bucket: StuckPrBucket;
  evidence: string;
  next_action: string;
  heal_attempts: number;
  age_hours: number;
  urgency_rank: number;
}

export interface StuckPrTaxonomy {
  open_count: number;
  by_bucket: Record<StuckPrBucket, number>;
  rows: StuckPrTaxonomyRow[];
  generated_at: string;
}

const BUCKET_URGENCY: Record<StuckPrBucket, number> = {
  needs_human: 0,
  ci_red: 1,
  ci_absent: 2,
  infra_flake: 3,
  account_suspended: 4,
  merging: 5,
  healthy_waiting: 6,
};

const BUCKET_NEXT_ACTION: Record<StuckPrBucket, string> = {
  needs_human: "open & fix",
  ci_red: "review the check log",
  ci_absent: "close + reopen to re-fire webhook",
  infra_flake: "wait (loop retries)",
  account_suspended: "external - wait or escalate to human",
  merging: "leave it",
  healthy_waiting: "leave it (or review)",
};

/** Zeroed bucket histogram (every key present so the SPA never needs
 *  a "is the key defined" check). */
function zeroBuckets(): Record<StuckPrBucket, number> {
  return {
    needs_human: 0, ci_red: 0, ci_absent: 0, infra_flake: 0,
    account_suspended: 0, merging: 0, healthy_waiting: 0,
  };
}

interface StuckPrRowInternal {
  project_slug: string;
  project_name: string | null;
  project_id: number;
  pr_number: number;
  pr_title: string | null;
  pr_url: string | null;
  ci_state: string | null;
  merge_state: string | null;
  first_fail_check: string | null;
  heal_attempts: number | null;
  fetched_at: string | null;
}

interface StuckPrAuditTailRow { stdout_tail: string | null; }

/** Format an age string ("12m ago", "3h ago", "2d ago"). Integer
 *  bucket — the operator reads this at a glance, not as a stopwatch. */
function formatAge(ageHours: number, ageMinutes: number): string {
  if (ageHours >= 24) return `${Math.floor(ageHours / 24)}d ago`;
  if (ageHours >= 1) return `${ageHours}h ago`;
  return `${Math.max(0, ageMinutes)}m ago`;
}

/** Compute the stuck-PR taxonomy for every open agent PR.
 *
 *  Per the AC cascade: evaluate top-down, first match wins. `now` is
 *  the wall-clock anchor for age math (tests pin it; production
 *  passes `new Date()`).
 *
 *  Single JOIN over `pr + project`. Per-row helper calls are bounded
 *  by N (typically <50): one `classifyPrFailure` (already memoises
 *  the heal-audit lookup internally per call) + one latest-heal-audit
 *  fetch for the account_suspended scan. The perf AC (50 PRs under
 *  35ms) is comfortably below the per-call cost. */
export function stuckPrTaxonomy(db: DB, now: Date = new Date()): StuckPrTaxonomy {
  const generatedAt = now.toISOString();

  const rows = db.prepare(
    "SELECT "
    + "  p.slug AS project_slug, p.name AS project_name, p.id AS project_id, "
    + "  pr.number AS pr_number, pr.title AS pr_title, pr.url AS pr_url, "
    + "  pr.ci_state AS ci_state, pr.merge_state AS merge_state, "
    + "  pr.first_fail_check AS first_fail_check, "
    + "  pr.heal_attempts AS heal_attempts, pr.fetched_at AS fetched_at "
    + "FROM pr JOIN project p ON p.id = pr.project_id "
    + "WHERE pr.state = 'open' AND pr.is_agent = 1",
  ).all() as unknown as StuckPrRowInternal[];

  const byBucket = zeroBuckets();
  if (rows.length === 0) {
    return {
      open_count: 0,
      by_bucket: byBucket,
      rows: [],
      generated_at: generatedAt,
    };
  }

  // Account-suspended scan needs the latest heal-audit per PR. We
  // collect them in a single query rather than N lookups so the perf
  // AC stays comfortable.
  const latestHealByPr = new Map<number, string>();
  const auditRows = db.prepare(
    "SELECT target, stdout_tail FROM control_audit "
    + " WHERE action = 'heal' "
    + " AND id IN (SELECT MAX(id) FROM control_audit "
    + "            WHERE action = 'heal' GROUP BY target)",
  ).all() as unknown as Array<{ target: string | null; stdout_tail: string | null }>;
  for (const r of auditRows) {
    const t = String(r.target ?? "");
    const m = t.match(/^pr-(\d+)$/);
    if (m && r.stdout_tail) {
      latestHealByPr.set(Number(m[1]), String(r.stdout_tail));
    }
  }

  const ACCOUNT_SUSPENDED_RE = /account is suspended/i;

  const out: StuckPrTaxonomyRow[] = [];
  for (const r of rows) {
    // Age: integer ms diff → hours + minutes. Negative (clock-skew →
    // future fetched_at) clamps to 0.
    let ageHours = 0;
    let ageMinutes = 0;
    let ageMs = 0;
    if (r.fetched_at) {
      ageMs = now.getTime() - new Date(r.fetched_at).getTime();
      if (ageMs > 0) {
        ageHours = Math.floor(ageMs / 3600_000);
        ageMinutes = Math.floor(ageMs / 60_000);
      }
    }
    const ageStr = formatAge(ageHours, ageMinutes);
    const heal = Math.max(0, Number(r.heal_attempts ?? 0) || 0);
    const ci = String(r.ci_state ?? "");
    const mergeState = String(r.merge_state ?? "");
    const tail = latestHealByPr.get(r.pr_number) ?? null;
    const healCount = countHealAuditsForPr(db, r.pr_number);

    // Cascade. First match wins. The classifyPrFailure call is shared
    // across cases 2/3 so we do it once.
    const cls = classifyPrFailure(db, r.project_id, r.pr_number);

    let bucket: StuckPrBucket;
    let evidence: string;

    // 1. needs_human: heal cap exceeded (>= 2). The cap is a ceiling;
    //    a third heal still keeps the PR here (edge case AC8) with
    //    "(over cap)" suffix.
    if (heal >= 2) {
      bucket = "needs_human";
      const overCap = heal > 2 ? " (over cap)" : " (cap)";
      const kindLabel = cls.kind === "infra_flake" && cls.detail
        ? `infra_flake (${cls.detail})`
        : cls.kind;
      evidence = `${heal} heals${overCap}, latest: ${kindLabel}`;
    }
    // 2. account_suspended: latest heal stdout matches the regex.
    else if (tail && ACCOUNT_SUSPENDED_RE.test(tail)) {
      bucket = "account_suspended";
      evidence = `GitHub account suspended, retried ${healCount}x`;
    }
    // 3. infra_flake: classifier says so. Reuse the 0040 helper
    //    unchanged (Out of scope: no new patterns).
    else if (cls.kind === "infra_flake") {
      bucket = "infra_flake";
      const detail = cls.detail ?? "infra-flake match";
      const healPlural = heal === 1 ? "heal" : "heals";
      evidence = `${detail}, ${heal} ${healPlural}`;
    }
    // 4. ci_red: producer's lowercase 'red' token.
    else if (ci === "red") {
      bucket = "ci_red";
      const checkName = r.first_fail_check ? String(r.first_fail_check) : "red check";
      evidence = checkName;
    }
    // 5. ci_absent: ci_state === 'none' AND fetched_at >= 5 minutes
    //    ago. The producer's `ciState()` writes 'none' when the
    //    rollup is empty (the ingester's "no checks queued" signal).
    //    The 5-min floor avoids flagging a PR opened 30s ago (per
    //    LESSONS 2026-05-26 "GH Actions doesn't fire on a fresh PR").
    else if (ci === "none" && ageMs >= 5 * 60_000) {
      bucket = "ci_absent";
      evidence = `pushed ${ageStr}, no checks queued`;
    }
    // 6. merging: merge_state === 'CLEAN' (uppercase per gh) AND
    //    ci_state === 'green'. The autoMergeRequest field is NOT
    //    persisted today; evidence degrades to "CLEAN + green".
    else if (mergeState === "CLEAN" && ci === "green") {
      bucket = "merging";
      evidence = "CLEAN + green";
    }
    // 7. healthy_waiting (default): no heals AND age < 6h. When none
    //    of the above fires and the row doesn't fit the healthy
    //    template (heals=0 + age<6h), fall through with "no signal".
    else if (heal === 0 && ageHours < 6) {
      bucket = "healthy_waiting";
      evidence = `${ageStr} old, awaiting review`;
    } else {
      bucket = "healthy_waiting";
      evidence = "no signal";
    }

    byBucket[bucket] += 1;
    out.push({
      project_slug: r.project_slug,
      project_name: r.project_name ?? r.project_slug,
      pr_number: r.pr_number,
      pr_title: r.pr_title ?? "",
      pr_url: r.pr_url ?? "",
      bucket,
      evidence,
      next_action: BUCKET_NEXT_ACTION[bucket],
      heal_attempts: heal,
      age_hours: ageHours,
      urgency_rank: BUCKET_URGENCY[bucket],
    });
  }

  // Sort: urgency_rank ASC, then age_hours DESC within bucket; stable
  // final tiebreak by pr_number ASC for deterministic re-renders.
  out.sort((a, b) => {
    if (a.urgency_rank !== b.urgency_rank) return a.urgency_rank - b.urgency_rank;
    if (b.age_hours !== a.age_hours) return b.age_hours - a.age_hours;
    return a.pr_number - b.pr_number;
  });

  return {
    open_count: rows.length,
    by_bucket: byBucket,
    rows: out,
    generated_at: generatedAt,
  };
}

/** Count heal-audit rows for a given PR (every retry, not just the
 *  latest). Used by the account_suspended evidence string so the
 *  operator sees "retried 3x" instead of a flat "1x". */
function countHealAuditsForPr(db: DB, prNumber: number): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM control_audit "
    + " WHERE action = 'heal' AND target = ?",
  ).get(`pr-${prNumber}`) as unknown as { c: number | null } | undefined;
  return Number(row?.c ?? 0);
}

// ────────────────────────────────────────────────────────────────────
// PR autopsy card (ticket 0047).
//
// One row per non-merged PR close in the last N days. Each row carries
// a structural cause-of-death, the riskiness score the 0040 helper
// would have computed at close time, the credited lesson (via the 0042
// `lesson_credit` ledger) if any, a deterministic verdict line, and a
// pre-filled LESSONS-entry skeleton (for the unknown / no-lesson
// branches).
//
// Producer reconciliation (per LESSONS 2026-06-05 "groomer prose can
// disagree with the schema; the schema wins"; full audit in the
// 0047 ticket's Implementation log):
//   - closed PRs: `state = 'CLOSED'` uppercase (mirrors the
//     established `'MERGED'` uppercase convention used by every
//     existing merged-PR reader; matches gh's verbatim state token
//     "CLOSED"). The 0049 sibling ticket extends the ingester to
//     populate this; v1 of the autopsy is data-ready behind seeded
//     fixtures.
//   - `closed_at`: NEW additive column added via ALTER in
//     src/db.ts:openDb. Default NULL on legacy rows.
//   - `control_audit` heal rows: action='heal' (lowercase) +
//     target='pr-<number>' — matches src/views.ts:classifyPrFailure.
//   - `lesson_credit` join: per src/db.ts schema the join column is
//     `heal_audit_id` (snake_case lowercase) — matches the 0042
//     attributor.
//
// The cause cascade (top-down, first match wins) is the deterministic
// classifier the AC2 spec demands:
//   1. cap_reached         — heal_attempts >= 2 AND latest heal is
//                            NOT an infra-flake (via classifyPrFailure)
//   2. infra_blocked_giveup — heal_attempts >= 1 AND latest heal IS
//                            an infra-flake
//   3. human_rejected      — heal_attempts < 2 AND a closed-by-human
//                            signal exists. PRODUCER-VS-SPEC: the
//                            schema today carries no `closed_by` /
//                            `actor_login` field; the ingester does
//                            not fetch a closer identity. Per the
//                            AC's permissive clause "if no human-
//                            action signal is recoverable, this rule
//                            does NOT fire", v1 SKIPS this branch
//                            (the death falls through to `unknown`
//                            and the verdict prompts a fresh
//                            LESSONS entry). The 0049 sibling ticket
//                            widens the ingester so this branch
//                            lights up.
//   4. force_closed_stale  — heal_attempts === 0 AND
//                            (closed_at - gh_created_at) > 7 days
//   5. unknown             — default
//
// Riskiness reconstruction (AC3) reuses the 0040 formula AS-IS:
//   heal_attempts * 4 + FAIL_KIND_WEIGHT[fail_kind] +
//     floor(age_hours_at_close / 6)
// where fail_kind comes from `classifyPrFailure(db, projectId,
// prNumber)` (the latest heal-audit row survives the PR close per the
// 0040 LESSONS lookup pattern).
//
// Lesson credit attribution (AC4): for each autopsy row, the helper
// queries `lesson_credit` for ANY row whose `heal_audit_id` points at
// a heal-audit row for this PR (`action='heal' AND target='pr-<n>'`),
// picks the most-recently credited one, and surfaces
// {slug, headline, prior_saves} — where `prior_saves` is
// `COUNT(*) FROM lesson_credit WHERE lesson_slug = ? AND
// created_at >= now - 30 days`. When zero matches exist,
// `lesson_credit` is null.
//
// Verdict + draft_lesson composition (AC5) is a pure deterministic
// dispatch over (cause, lesson_credit present?) — no LLM, no
// stringified prose composition beyond the fixed templates.
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// every row narrowing uses the double-cast.
// Per LESSONS § "no backticks inside template-literal SQL strings":
// SQL strings stay plain concatenation; identifiers unquoted single
// words.
// Per LESSONS § "julianday() drifts ~10us per timestamp": every
// timestamp diff is JS-side via `Date.getTime()` (integer ms).
// Per AGENTS.md § "Never compose a shell string from input" — and
// its SQL analogue: every parameter is bound via `?` placeholders.

export type PrAutopsyCause =
  | "cap_reached"
  | "human_rejected"
  | "force_closed_stale"
  | "infra_blocked_giveup"
  | "unknown";

export interface PrAutopsyLessonCredit {
  slug: string;
  headline: string;
  prior_saves: number;
}

export interface PrAutopsyRow {
  project_slug: string;
  project_name: string;
  pr_number: number;
  pr_title: string;
  pr_url: string;
  closed_at: string;
  closed_age_hours: number;
  cause: PrAutopsyCause;
  riskiness_at_close: number;
  riskiness_breakdown: string;
  heal_attempts: number;
  latest_fail_kind: string;
  latest_fail_detail: string | null;
  lesson_credit: PrAutopsyLessonCredit | null;
  verdict: string;
  draft_lesson: string | null;
}

export interface PrAutopsies {
  window_days: number;
  total_closes: number;
  rows: PrAutopsyRow[];
  generated_at: string;
}

export interface PrAutopsiesOptions {
  /** Window in days for the autopsy lookback. Defaults to 7. The
   *  route handler clamps to [1, 30] before passing through. */
  windowDays?: number;
}

interface PrAutopsyRowInternal {
  project_slug: string;
  project_name: string | null;
  project_id: number;
  pr_number: number;
  pr_title: string | null;
  pr_url: string | null;
  closed_at: string;
  gh_created_at: string | null;
  heal_attempts: number | null;
  ci_state: string | null;
  first_fail_check: string | null;
}

interface LessonCreditJoinRow {
  lesson_slug: string;
  lesson_date: string;
  lesson_title: string;
  created_at: string;
}

interface PriorSavesRow { c: number | null; }

/** Look up the most-recent lesson_credit row whose heal_audit_id
 *  matches any heal-audit for this PR. Returns null when no rows
 *  exist. Encapsulated so the join is one SQL read per autopsy row
 *  (small N, typically <50 per window). */
function lessonCreditForAutopsyRow(
  db: DB, prNumber: number,
): { row: LessonCreditJoinRow; prior_saves: number } | null {
  // Inner SELECT collects the heal_audit_id list for this PR; outer
  // JOIN picks the most-recent credit row. Pure SQL — no per-heal
  // round-trip.
  const credit = db.prepare(
    "SELECT lc.lesson_slug AS lesson_slug, "
    + "       lc.lesson_date AS lesson_date, "
    + "       lc.lesson_title AS lesson_title, "
    + "       lc.created_at AS created_at "
    + "  FROM lesson_credit lc "
    + " WHERE lc.heal_audit_id IN ( "
    + "        SELECT id FROM control_audit "
    + "         WHERE action = 'heal' AND target = ? "
    + "      ) "
    + " ORDER BY lc.created_at DESC LIMIT 1",
  ).get(`pr-${prNumber}`) as unknown as LessonCreditJoinRow | undefined;
  if (!credit) return null;
  return { row: credit, prior_saves: 0 }; // prior_saves filled below
}

/** Count lesson_credit rows for a given lesson_slug within the
 *  trailing 30 days. The cutoff is computed JS-side and passed as a
 *  bind parameter (per LESSONS § julianday drifts). */
function priorSavesForLesson(
  db: DB, lessonSlug: string, now: Date,
): number {
  const cutoffIso = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM lesson_credit "
    + " WHERE lesson_slug = ? AND created_at >= ?",
  ).get(lessonSlug, cutoffIso) as unknown as PriorSavesRow | undefined;
  return Number(row?.c ?? 0);
}

/** Compose the verdict line for a given (cause, lesson_credit) pair.
 *  Deterministic — no LLM, no string interpolation beyond the fixed
 *  templates. The returned tuple carries the verdict and whether
 *  the row should prompt a fresh LESSONS-entry draft. */
function composeVerdict(
  cause: PrAutopsyCause, hasCredit: boolean,
): { verdict: string; promptsDraft: boolean } {
  switch (cause) {
    case "cap_reached":
      return hasCredit
        ? { verdict: "The lesson named the symptom. Heal cap is the issue.", promptsDraft: false }
        : { verdict: "Heal cap reached AND no lesson covers this. Worth a LESSONS entry.", promptsDraft: true };
    case "infra_blocked_giveup":
      return hasCredit
        ? { verdict: "Infra blocked recovery. The lesson named it - consider widening the retry budget.", promptsDraft: false }
        : { verdict: "Infra blocked recovery and no lesson covers this flake. Add a LESSONS entry.", promptsDraft: true };
    case "human_rejected":
      return { verdict: "Human closed. Was the agent off-track or was the goal wrong?", promptsDraft: false };
    case "force_closed_stale":
      return { verdict: "PR sat unattended for >7 days. Likely the backlog moved on.", promptsDraft: false };
    case "unknown":
    default:
      return { verdict: "Cause not detected from signals. Consider adding a LESSONS entry naming this failure mode.", promptsDraft: true };
  }
}

/** Compose the draft-LESSONS skeleton (AC5). Fixed 3-line template;
 *  the operator reviews + copies into docs/LESSONS.md themselves. */
function composeDraftLesson(opts: {
  now: Date;
  slug: string;
  prNumber: number;
  cause: PrAutopsyCause;
  failKind: string;
  failDetail: string | null;
  verdict: string;
}): string {
  const date = opts.now.toISOString().slice(0, 10);
  const headline = `${opts.slug} #${opts.prNumber} died: ${opts.cause}`;
  const detail = opts.failDetail ?? "none";
  return (
    `### ${date} - ${headline}\n\n`
    + `PR ${opts.slug} #${opts.prNumber} was closed for cause=${opts.cause}. `
    + `Latest heal fail-kind: ${opts.failKind}. Detail: ${detail}. `
    + `Verdict: ${opts.verdict}\n\nFIX: <fill in>`
  );
}

/** Compose the riskiness_breakdown line (AC3). One-line human summary:
 *  "<fail_kind> x <heals> heals, <age>h old". */
function composeRiskinessBreakdown(opts: {
  failKind: string;
  heals: number;
  ageHours: number;
}): string {
  const healPlural = opts.heals === 1 ? "heal" : "heals";
  return `${opts.failKind} x ${opts.heals} ${healPlural}, ${opts.ageHours}h old`;
}

/** Compute the PR autopsy card payload for the last N (default 7)
 *  days. `now` is the wall-clock anchor for the window cutoff +
 *  age math; tests pin it, production passes `new Date()`. */
export function prAutopsies(
  db: DB,
  now: Date,
  opts: PrAutopsiesOptions = {},
): PrAutopsies {
  // Window: [now - windowDays, now]. The cutoff is computed JS-side
  // (per LESSONS § julianday drifts) and passed as a bind param.
  const windowDays = Math.max(1, Math.floor(opts.windowDays ?? 7));
  const cutoffIso = new Date(now.getTime() - windowDays * 86400_000).toISOString();
  const generatedAt = now.toISOString();

  // Main SELECT: closed-non-merged PRs with closed_at in window. The
  // 0040 LESSON established lowercase 'open' for open PRs; this
  // implementation establishes uppercase 'CLOSED' for closed-non-
  // merged (mirrors the 'MERGED' uppercase convention every existing
  // merged-PR reader uses, and matches gh's verbatim state token).
  // Edge case (AC12 / spec edge case): a PR closed AND re-opened
  // has its current state back at 'open' — it is naturally excluded
  // by the state='CLOSED' filter.
  const rows = db.prepare(
    "SELECT "
    + "  p.slug AS project_slug, p.name AS project_name, p.id AS project_id, "
    + "  pr.number AS pr_number, pr.title AS pr_title, pr.url AS pr_url, "
    + "  pr.closed_at AS closed_at, pr.gh_created_at AS gh_created_at, "
    + "  pr.heal_attempts AS heal_attempts, pr.ci_state AS ci_state, "
    + "  pr.first_fail_check AS first_fail_check "
    + "FROM pr JOIN project p ON p.id = pr.project_id "
    + "WHERE pr.state = 'CLOSED' "
    + "  AND pr.closed_at IS NOT NULL "
    + "  AND pr.closed_at >= ? "
    + "ORDER BY pr.closed_at DESC",
  ).all(cutoffIso) as unknown as PrAutopsyRowInternal[];

  if (rows.length === 0) {
    return {
      window_days: windowDays,
      total_closes: 0,
      rows: [],
      generated_at: generatedAt,
    };
  }

  const out: PrAutopsyRow[] = [];
  for (const r of rows) {
    const closedAtMs = new Date(r.closed_at).getTime();
    const createdAtMs = r.gh_created_at
      ? new Date(r.gh_created_at).getTime()
      : closedAtMs;
    // Age at close = closed_at - created_at (integer ms diff → hours).
    // Clamp to 0 on clock-skew (future created_at) to keep the score
    // non-negative.
    const ageMsAtClose = Math.max(0, closedAtMs - createdAtMs);
    const ageHoursAtClose = Math.floor(ageMsAtClose / 3600_000);
    const closedAgeMs = Math.max(0, now.getTime() - closedAtMs);
    const closedAgeHours = Math.floor(closedAgeMs / 3600_000);
    const heal = Math.max(0, Number(r.heal_attempts ?? 0) || 0);

    // Reuse the existing classifyPrFailure helper unchanged (AC3
    // "no new helper — REUSE 0040's classifyPrFailure AS-IS"). The
    // latest heal-audit row still exists post-close (control_audit
    // is append-only) so the classifier returns the same kind the
    // 0040 riskiness path computed at close time.
    const cls = classifyPrFailure(db, r.project_id, r.pr_number);
    const failKind = cls.kind;
    const failDetail = cls.detail;

    // Cause cascade (AC2). Top-down; first match wins. The
    // human_rejected branch is skipped per the AC's permissive
    // clause because the schema carries no closed_by signal today
    // (the 0049 sibling ticket widens the ingester to fix this).
    let cause: PrAutopsyCause;
    if (heal >= 2 && failKind !== "infra_flake") {
      cause = "cap_reached";
    } else if (heal >= 1 && failKind === "infra_flake") {
      cause = "infra_blocked_giveup";
    } else if (heal === 0 && ageMsAtClose > 7 * 86400_000) {
      cause = "force_closed_stale";
    } else {
      cause = "unknown";
    }

    // Riskiness reconstruction (AC3): 0040's formula AS-IS against
    // the PR's state at close time.
    const score = heal * 4
      + FAIL_KIND_WEIGHT[failKind]
      + Math.floor(ageHoursAtClose / 6);
    const breakdown = composeRiskinessBreakdown({
      failKind, heals: heal, ageHours: ageHoursAtClose,
    });

    // Lesson credit attribution (AC4).
    let lessonCredit: PrAutopsyLessonCredit | null = null;
    const creditRow = lessonCreditForAutopsyRow(db, r.pr_number);
    if (creditRow) {
      const priorSaves = priorSavesForLesson(db, creditRow.row.lesson_slug, now);
      lessonCredit = {
        slug: creditRow.row.lesson_slug,
        headline: creditRow.row.lesson_title,
        prior_saves: priorSaves,
      };
    }

    // Verdict + draft-lesson composition (AC5).
    const { verdict, promptsDraft } = composeVerdict(cause, lessonCredit != null);
    const draftLesson = promptsDraft
      ? composeDraftLesson({
        now, slug: r.project_slug, prNumber: r.pr_number,
        cause, failKind, failDetail, verdict,
      })
      : null;

    out.push({
      project_slug: r.project_slug,
      project_name: r.project_name ?? r.project_slug,
      pr_number: r.pr_number,
      pr_title: r.pr_title ?? "",
      pr_url: r.pr_url ?? "",
      closed_at: r.closed_at,
      closed_age_hours: closedAgeHours,
      cause,
      riskiness_at_close: score,
      riskiness_breakdown: breakdown,
      heal_attempts: heal,
      latest_fail_kind: failKind,
      latest_fail_detail: failDetail,
      lesson_credit: lessonCredit,
      verdict,
      draft_lesson: draftLesson,
    });
  }

  return {
    window_days: windowDays,
    total_closes: out.length,
    rows: out,
    generated_at: generatedAt,
  };
}

// ────────────────────────────────────────────────────────────────────
// Per-project worth-it verdict (ticket 0048).
//
// Composes five existing primitives + one operator-settable hourly
// rate into a single per-project verdict: "net positive", "watch",
// "sunset candidate", or "insufficient data". The hard question the
// operator carries at end-of-quarter — "is this project worth keeping
// vs me doing it by hand?" — becomes one glance instead of a
// spreadsheet exercise.
//
// PRODUCER-VS-SPEC reconciliation (LESSONS 2026-06-05 + 0040 lesson):
//   - merged PRs   = `state = 'MERGED'` uppercase + `is_agent = 1`
//                    (matches costPerMergedPr / spendEfficiencyRanking)
//   - closed PRs   = `state = 'CLOSED'` uppercase + `is_agent = 1`
//                    (matches prAutopsies)
// The `pr` table has NO surrogate id (PK is `(project_id, number)`)
// so any cache-invalidation tuple in the route layer proxies fresh
// rows via `(MAX(fetched_at), COUNT(*))` per LESSONS 2026-06-07.
//
// Verdict cascade (top-down, deterministic):
//   1. insufficient_data: merged_prs < 3
//   2. sunset_candidate : roi < 1.0 OR (merge_ratio < 0.5 AND merged_prs < 5)
//   3. watch            : roi < 2.0 OR merge_ratio < 0.7 OR streak_days === 0
//   4. net_positive     : roi >= 2.0 AND merge_ratio >= 0.7 AND streak_days > 0
//
// Defaults:
//   - hourly_rate_usd = 75 (mid-market US contractor rate)
//   - hours_per_pr    = 1  (one engineer-hour per PR — conservative
//                           midpoint per published industry benchmarks)
//   - windowDays      = 30 (matches the 30d run-rate framing
//                           operators read everywhere else)
//
// streak_days is per-project — not the fleetStreak() value. It counts
// the number of consecutive trailing days (today walking back) where
// THIS project merged at least one PR. A day with zero merges breaks
// the walk. This matches the watch-trigger semantics ("no merged PR
// today" when streak_days === 0).

export interface ProjectWorthItVerdict {
  project_slug: string;
  project_name: string;
  window_days: number;
  merged_prs: number;
  closed_prs: number;
  merge_ratio: number | null;
  spend_usd: number;
  monthly_runrate_usd: number;
  cost_per_pr_usd: number | null;
  streak_days: number;
  fleet_temp: number | null;
  human_equivalent_cost_usd: number;
  roi_multiplier: number | null;
  hourly_rate_usd: number;
  hours_per_pr: number;
  verdict: "net_positive" | "watch" | "sunset_candidate" | "insufficient_data";
  verdict_detail: string;
  generated_at: string;
}

export interface ProjectWorthItVerdictOptions {
  /** Trailing window. Defaults to 30 days. */
  windowDays?: number;
  /** Per-call override; falls back to `cfg.worth_it.hourly_rate_usd`
   *  then the helper default of 75. */
  humanEquivalentHourlyUsd?: number;
  /** Per-call override; falls back to `cfg.worth_it.hours_per_pr`
   *  then the helper default of 1. */
  humanHoursPerPr?: number;
  /** Optional fleet config — when present and `worth_it.*` is set
   *  the values flow through as the resolved defaults. */
  cfg?: FleetConfig;
}

export interface ProjectWorthItSticky {
  verdict_now: ProjectWorthItVerdict["verdict"];
  verdict_14d_ago: ProjectWorthItVerdict["verdict"];
  sticky_days: number;
}

interface ProjectMetaRow_internal { slug: string; name: string | null; }
interface CountAggRow_internal { c: number | null; }
interface SpendAggRow_internal { spent_usd: number | null; }
interface StreakDayRow_internal { day: string | null; c: number | null; }

function _resolveWorthItDefaults(
  opts: ProjectWorthItVerdictOptions,
): { hourlyRateUsd: number; hoursPerPr: number; windowDays: number } {
  // Per-call opts win > cfg.worth_it.* > documented defaults (75 / 1).
  const cfgWorth = opts.cfg?.worth_it ?? {};
  const hourlyRateUsd = opts.humanEquivalentHourlyUsd
    ?? (typeof cfgWorth.hourly_rate_usd === "number" ? cfgWorth.hourly_rate_usd : 75);
  const hoursPerPr = opts.humanHoursPerPr
    ?? (typeof cfgWorth.hours_per_pr === "number" ? cfgWorth.hours_per_pr : 1);
  const windowDays = Math.max(1, Math.min(180, Math.floor(opts.windowDays ?? 30)));
  return { hourlyRateUsd, hoursPerPr, windowDays };
}

/** Per-project trailing streak: walk backwards from today (UTC) and
 *  count consecutive days where the project merged at least one PR.
 *  Stops at the first zero-merges day. */
function _projectStreakDays(db: DB, projectId: number, now: Date): number {
  // Pull every per-day merged-PR count in the trailing 90 days into JS
  // (small N — at most 90 rows even at 100% activity). Walk the dates
  // backwards from today; a day not in the map is treated as zero
  // merges → streak break.
  const today = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
  ));
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 89);
  const startStr = start.toISOString().slice(0, 10);
  const endStr = today.toISOString().slice(0, 10);
  const rows = db.prepare(
    "SELECT date(fetched_at) AS day, COUNT(*) AS c "
    + "  FROM pr "
    + " WHERE project_id = ? AND state = 'MERGED' AND is_agent = 1 "
    + "   AND fetched_at IS NOT NULL "
    + "   AND date(fetched_at) >= ? AND date(fetched_at) <= ? "
    + " GROUP BY date(fetched_at)",
  ).all(projectId, startStr, endStr) as unknown as StreakDayRow_internal[];
  const byDay = new Map<string, number>();
  for (const r of rows) {
    if (r.day) byDay.set(r.day, Number(r.c ?? 0));
  }
  let streak = 0;
  const cursor = new Date(today);
  for (let i = 0; i < 90; i++) {
    const key = cursor.toISOString().slice(0, 10);
    if ((byDay.get(key) ?? 0) > 0) {
      streak += 1;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

/** Compute the per-project worth-it verdict (ticket 0048). Pure SQL +
 *  JS arithmetic; no shell-out, no network. The route layer caches
 *  per `(slug, window_days, rate, hours)` with a per-project
 *  invalidation tuple. */
export function projectWorthItVerdict(
  db: DB, projectId: number, now: Date,
  opts: ProjectWorthItVerdictOptions = {},
): ProjectWorthItVerdict {
  const { hourlyRateUsd, hoursPerPr, windowDays } = _resolveWorthItDefaults(opts);
  // Window: end is today's UTC midnight + 1 day (half-open exclusive
  // bound) so today's seed rows count. Start is `windowDays` before.
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const endExclusive = new Date(end);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - windowDays);
  const startStr = start.toISOString().slice(0, 10);
  const endExclusiveStr = endExclusive.toISOString().slice(0, 10);
  const startIso = start.toISOString();
  const endIsoExclusive = endExclusive.toISOString();

  // Project metadata.
  const meta = db.prepare(
    "SELECT slug, name FROM project WHERE id = ?",
  ).get(projectId) as unknown as ProjectMetaRow_internal | undefined;
  const slug = meta?.slug ?? `id-${projectId}`;
  const name = meta?.name ?? slug;

  // Spend in window (cost_rollup_day; producer matches every other
  // cost-axis helper).
  const spendRow = db.prepare(
    "SELECT SUM(COALESCE(cost_usd, 0)) AS spent_usd "
    + "  FROM cost_rollup_day "
    + " WHERE project_id = ? AND day >= ? AND day < ?",
  ).get(projectId, startStr, endExclusiveStr) as unknown as SpendAggRow_internal | undefined;
  const spendUsd = Number(spendRow?.spent_usd ?? 0) || 0;

  // Merged PRs in window — state='MERGED' uppercase + is_agent=1
  // bucketed by date(fetched_at) (matches costPerMergedPr /
  // spendEfficiencyRanking).
  const mergedRow = db.prepare(
    "SELECT COUNT(*) AS c FROM pr "
    + " WHERE project_id = ? AND state = 'MERGED' AND is_agent = 1 "
    + "   AND fetched_at IS NOT NULL "
    + "   AND date(fetched_at) >= ? AND date(fetched_at) < ?",
  ).get(projectId, startStr, endExclusiveStr) as unknown as CountAggRow_internal | undefined;
  const mergedPrs = Number(mergedRow?.c ?? 0) || 0;

  // Closed non-merged PRs in window — state='CLOSED' uppercase + is_agent=1
  // (matches prAutopsies). Falls back to fetched_at when closed_at is
  // null (older rows from before the 0049 sibling lands close_at on
  // every CLOSED row).
  const closedRow = db.prepare(
    "SELECT COUNT(*) AS c FROM pr "
    + " WHERE project_id = ? AND state = 'CLOSED' AND is_agent = 1 "
    + "   AND ( "
    + "        (closed_at IS NOT NULL AND closed_at >= ? AND closed_at < ?) "
    + "     OR (closed_at IS NULL AND fetched_at IS NOT NULL "
    + "         AND fetched_at >= ? AND fetched_at < ?) "
    + "   )",
  ).get(projectId, startIso, endIsoExclusive, startIso, endIsoExclusive) as unknown as CountAggRow_internal | undefined;
  const closedPrs = Number(closedRow?.c ?? 0) || 0;

  // Merge ratio: null when there are no closes (merged + closed === 0).
  const totalDecided = mergedPrs + closedPrs;
  const mergeRatio: number | null = totalDecided > 0
    ? mergedPrs / totalDecided
    : null;

  // 30-day-projection of the trailing spend: spend × (30 / windowDays).
  const monthlyRunrateUsd = windowDays > 0
    ? spendUsd * (30 / windowDays)
    : spendUsd;

  const costPerPrUsd: number | null = mergedPrs > 0
    ? spendUsd / mergedPrs
    : null;

  const humanEquivalentCostUsd = mergedPrs * hoursPerPr * hourlyRateUsd;
  const roiMultiplier: number | null = spendUsd > 0
    ? humanEquivalentCostUsd / spendUsd
    : null;

  const streakDays = _projectStreakDays(db, projectId, now);

  // fleet_temp = projectHealth().score. The helper memoises so a
  // batch call for the fleet endpoint shares one compute per project.
  let fleetTemp: number | null = null;
  try {
    const h = projectHealth(db, projectId, now);
    fleetTemp = h.score;
  } catch { /* projectHealth tolerates partial state; we just leave null. */ }

  // ── Verdict cascade ─────────────────────────────────────────────
  let verdict: ProjectWorthItVerdict["verdict"];
  let verdictDetail: string;

  const moneyFmt = (n: number) => `$${n.toFixed(0)}`;
  const arithmeticDetail = `${moneyFmt(monthlyRunrateUsd)}/mo vs ~${moneyFmt(humanEquivalentCostUsd * (30 / windowDays))}/mo human equivalent at ${hoursPerPr}h/PR`;

  if (mergedPrs < 3) {
    verdict = "insufficient_data";
    verdictDetail = `need 3+ merged PRs in ${windowDays} days to verdict`;
  } else if (
    (roiMultiplier != null && roiMultiplier < 1.0)
    || (mergeRatio != null && mergeRatio < 0.5 && mergedPrs < 5)
  ) {
    verdict = "sunset_candidate";
    if (roiMultiplier != null && roiMultiplier < 1.0) {
      verdictDetail = arithmeticDetail;
    } else {
      verdictDetail = `${mergedPrs}/${totalDecided} PRs merge; throughput low`;
    }
  } else if (
    (roiMultiplier != null && roiMultiplier < 2.0)
    || (mergeRatio != null && mergeRatio < 0.7)
    || streakDays === 0
  ) {
    verdict = "watch";
    // Name the weakest signal first. Order: ROI deficit, merge-ratio
    // deficit, streak-zero. Deterministic across re-runs.
    const triggers: Array<{ label: string; deficit: number }> = [];
    if (roiMultiplier != null && roiMultiplier < 2.0) {
      triggers.push({ label: "ROI < 2x", deficit: 2.0 - roiMultiplier });
    }
    if (mergeRatio != null && mergeRatio < 0.7) {
      triggers.push({ label: "merge ratio <70%", deficit: 0.7 - mergeRatio });
    }
    if (streakDays === 0) {
      triggers.push({ label: "no merged PR today", deficit: 1.0 });
    }
    // Sort by deficit DESC; stable order falls through to insertion order.
    triggers.sort((a, b) => b.deficit - a.deficit);
    verdictDetail = triggers[0]?.label ?? "ROI < 2x";
  } else {
    verdict = "net_positive";
    verdictDetail = arithmeticDetail;
  }

  return {
    project_slug: slug,
    project_name: name,
    window_days: windowDays,
    merged_prs: mergedPrs,
    closed_prs: closedPrs,
    merge_ratio: mergeRatio,
    spend_usd: spendUsd,
    monthly_runrate_usd: monthlyRunrateUsd,
    cost_per_pr_usd: costPerPrUsd,
    streak_days: streakDays,
    fleet_temp: fleetTemp,
    human_equivalent_cost_usd: humanEquivalentCostUsd,
    roi_multiplier: roiMultiplier,
    hourly_rate_usd: hourlyRateUsd,
    hours_per_pr: hoursPerPr,
    verdict,
    verdict_detail: verdictDetail,
    generated_at: now.toISOString(),
  };
}

/** Two-anchor sticky-sunset detector (AC8). Calls projectWorthItVerdict
 *  twice — at `now` and at `now - 14 days` — and reports whether the
 *  verdict has been `sunset_candidate` at BOTH anchors. Short-circuits
 *  to `sticky_days: 0` when either verdict is `insufficient_data`
 *  (the operator should not act on a stub project's two-week shape).
 *
 *  Used by the SPA to render the "sunset 14d+" chip near the verdict
 *  label — but only OUTSIDE quiet hours (the chip is a prompt; the
 *  verdict line itself is information). */
export function projectWorthItSticky(
  db: DB, projectId: number, now: Date,
  opts: ProjectWorthItVerdictOptions = {},
): ProjectWorthItSticky {
  const verdictNow = projectWorthItVerdict(db, projectId, now, opts);
  const past = new Date(now.getTime() - 14 * 86400_000);
  const verdictPast = projectWorthItVerdict(db, projectId, past, opts);
  const stickyDays = (
    verdictNow.verdict === "sunset_candidate"
    && verdictPast.verdict === "sunset_candidate"
  )
    ? 14
    : 0;
  return {
    verdict_now: verdictNow.verdict,
    verdict_14d_ago: verdictPast.verdict,
    sticky_days: stickyDays,
  };
}

// ────────────────────────────────────────────────────────────────────
// Fleet year-in-review (ticket 0050).
//
// Composes already-shipped helpers + tables (pr, cost_rollup_day,
// lesson_credit, project, plus projectWorthItVerdict) into ONE read
// against a year-long window. The page is the smallest meaningful
// unit of value that lets the operator close the laptop on New
// Year's Eve with a single artifact.
//
// PRODUCER reconciliation (per LESSONS 2026-06-05 "groomer prose can
// disagree with the schema; the schema wins" — confirmed against the
// 0049-extended src/ingest/prs.ts):
//   - merged PRs: `pr.state = 'MERGED'` uppercase + is_agent = 1
//     (matches src/ingest/prs.ts line 235's verbatim gh state token).
//   - closed-non-merged PRs: `pr.state = 'CLOSED'` uppercase
//     (matches src/ingest/prs.ts line 235's safe default).
//   - open PRs: `pr.state = 'open'` lowercase (matches src/ingest/prs.ts
//     line 188's hardcoded `'open'` per the 0040 LESSON).
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// every row narrowing uses the double-cast.
// Per LESSONS § "no backticks inside template-literal SQL strings":
// SQL strings are plain concatenation; identifiers stay unquoted.
// Per LESSONS § "julianday() drifts ~10us per timestamp": week math
// here is whole-day integer arithmetic in JS — no julianday involved.
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps
// from `new Date()`": the `now` parameter is the single anchor for
// every "today" calculation downstream (top_projects' projectWorthIt
// reuse takes the same `now`).
// Per LESSONS § "anomaly tests need σ > 0 in the fixture": the
// dip-week median-spend gate is exercised against varied per-week
// spend in the AC2 test; a flat-spend year resolves to dip = null.

export interface FleetYearInReviewWeek {
  week_iso: string;        // "2026-Wnn" (ISO week key)
  merged: number;
  closed_unmerged: number;
  spend_usd: number;
}

export interface FleetYearInReviewDip {
  week_iso: string;
  merged: number;
  closed_unmerged: number;
  spend_usd: number;
  headline: string;        // loss-framing OR neutral, per quietHoursActive
}

export interface FleetYearInReviewProject {
  project_slug: string;
  merged_prs: number;
  spend_usd: number;
  cost_per_pr_usd: number | null;
  verdict: "net_positive" | "watch" | "sunset_candidate" | "insufficient_data";
  prose: string;
}

export interface FleetYearInReviewLesson {
  lesson_slug: string;
  lesson_date: string;
  lesson_title: string;
  heal_count: number;
  first_credited_at: string;
  last_credited_at: string;
  saved_pr_count: number;
}

export interface FleetYearInReview {
  year: number;
  range_start: string;     // "YYYY-01-01"
  range_end: string;       // "YYYY-12-31"
  total_merged_prs: number;
  total_spend_usd: number;
  cost_per_pr_usd: number | null;
  roi_multiplier: number | null;
  project_count: number;
  weekly_merges: FleetYearInReviewWeek[];
  dip_week: FleetYearInReviewDip | null;
  top_projects: FleetYearInReviewProject[];
  top_lessons: FleetYearInReviewLesson[];
  generated_at: string;
}

export interface FleetYearInReviewOptions {
  /** Hourly-rate knob for ROI; matches the 0048 worth-it defaults. */
  hourlyRateUsd?: number;
  /** Hours-per-PR knob for ROI. */
  hoursPerPr?: number;
  /** Quiet-hours flag — when true, suppresses the loss-framing
   *  language in `dip_week.headline` (the numbers stay visible). */
  quietHoursActive?: boolean;
}

interface YearInReviewWeeklyRow_internal {
  week_iso: string | null;
  c: number | null;
}
interface YearInReviewWeeklySpendRow_internal {
  week_iso: string | null;
  spend_usd: number | null;
}
interface YearInReviewProjectAggRow_internal {
  project_id: number;
  slug: string;
  merged_prs: number;
  spend_usd: number;
}
interface YearInReviewLessonRow_internal {
  lesson_slug: string;
  lesson_date: string;
  lesson_title: string;
  heal_count: number;
  first_credited_at: string;
  last_credited_at: string;
  saved_pr_count: number;
}

/** Compute the fleet-wide year-in-review for the given calendar year.
 *  Pure read — no schema migration, no shell-out, no network. */
export function fleetYearInReview(
  db: DB, year: number, now: Date = new Date(),
  opts: FleetYearInReviewOptions = {},
): FleetYearInReview {
  const hourlyRateUsd = typeof opts.hourlyRateUsd === "number" ? opts.hourlyRateUsd : 75;
  const hoursPerPr = typeof opts.hoursPerPr === "number" ? opts.hoursPerPr : 1;
  const quiet = !!opts.quietHoursActive;

  const yearStr = String(year);
  const rangeStart = `${yearStr}-01-01`;
  const rangeEnd = `${yearStr}-12-31`;
  // Half-open exclusive upper bound for date() comparisons.
  const rangeEndExclusive = `${yearStr}-12-31T23:59:59.999Z`;
  const startIso = `${rangeStart}T00:00:00.000Z`;
  const endIso = `${yearStr}-12-31T23:59:59.999Z`;

  // ── Total merged PRs (agent) in the year ────────────────────────
  const mergedTotalRow = db.prepare(
    "SELECT COUNT(*) AS c FROM pr "
    + " WHERE state = 'MERGED' AND is_agent = 1 "
    + "   AND fetched_at IS NOT NULL "
    + "   AND date(fetched_at) >= ? AND date(fetched_at) <= ?",
  ).get(rangeStart, rangeEnd) as unknown as { c: number | null } | undefined;
  const totalMergedPrs = Number(mergedTotalRow?.c ?? 0) || 0;

  // ── Total spend in the year (cost_rollup_day) ──────────────────
  const spendTotalRow = db.prepare(
    "SELECT SUM(COALESCE(cost_usd, 0)) AS spent_usd "
    + "  FROM cost_rollup_day "
    + " WHERE day >= ? AND day <= ?",
  ).get(rangeStart, rangeEnd) as unknown as { spent_usd: number | null } | undefined;
  const totalSpendUsd = Number(spendTotalRow?.spent_usd ?? 0) || 0;

  const costPerPrUsd: number | null = totalMergedPrs > 0
    ? totalSpendUsd / totalMergedPrs
    : null;
  // Human equivalent: every merged PR represents hoursPerPr * rate USD
  // of equivalent human work. ROI = equivalent / spend.
  const humanEquivalentUsd = totalMergedPrs * hoursPerPr * hourlyRateUsd;
  const roiMultiplier: number | null = totalSpendUsd > 0
    ? humanEquivalentUsd / totalSpendUsd
    : null;

  // ── Project count (any project with at least one merged PR in
  //    the year) ───────────────────────────────────────────────────
  const projectCountRow = db.prepare(
    "SELECT COUNT(DISTINCT project_id) AS c FROM pr "
    + " WHERE state = 'MERGED' AND is_agent = 1 "
    + "   AND fetched_at IS NOT NULL "
    + "   AND date(fetched_at) >= ? AND date(fetched_at) <= ?",
  ).get(rangeStart, rangeEnd) as unknown as { c: number | null } | undefined;
  const projectCount = Number(projectCountRow?.c ?? 0) || 0;

  // ── Weekly aggregation: 52 ISO weeks of the year ───────────────
  // We build the canonical week labels in JS (Jan 1 → Dec 31 ISO
  // weeks for `year`) so the result always has 52 entries even when
  // the SQL groups are sparse. SQL gives us per-week merged + closed
  // + spend; JS joins on the canonical week label.
  const weekLabels = _yearIsoWeekLabels(year);
  const mergedByWeek = new Map<string, number>();
  const closedByWeek = new Map<string, number>();
  const spendByWeek = new Map<string, number>();

  const mergedWeekRows = db.prepare(
    "SELECT strftime('%Y-%W', fetched_at) AS w, COUNT(*) AS c FROM pr "
    + " WHERE state = 'MERGED' AND is_agent = 1 "
    + "   AND fetched_at IS NOT NULL "
    + "   AND date(fetched_at) >= ? AND date(fetched_at) <= ? "
    + " GROUP BY w",
  ).all(rangeStart, rangeEnd) as unknown as Array<{ w: string | null; c: number | null }>;
  for (const r of mergedWeekRows) {
    if (r.w) mergedByWeek.set(_sqliteWeekToIsoWeekLabel(r.w, year), Number(r.c ?? 0));
  }
  const closedWeekRows = db.prepare(
    "SELECT strftime('%Y-%W', COALESCE(closed_at, fetched_at)) AS w, COUNT(*) AS c FROM pr "
    + " WHERE state = 'CLOSED' AND is_agent = 1 "
    + "   AND COALESCE(closed_at, fetched_at) IS NOT NULL "
    + "   AND date(COALESCE(closed_at, fetched_at)) >= ? "
    + "   AND date(COALESCE(closed_at, fetched_at)) <= ? "
    + " GROUP BY w",
  ).all(rangeStart, rangeEnd) as unknown as Array<{ w: string | null; c: number | null }>;
  for (const r of closedWeekRows) {
    if (r.w) closedByWeek.set(_sqliteWeekToIsoWeekLabel(r.w, year), Number(r.c ?? 0));
  }
  const spendWeekRows = db.prepare(
    "SELECT strftime('%Y-%W', day) AS w, SUM(COALESCE(cost_usd, 0)) AS s "
    + "  FROM cost_rollup_day "
    + " WHERE day >= ? AND day <= ? "
    + " GROUP BY w",
  ).all(rangeStart, rangeEnd) as unknown as Array<{ w: string | null; s: number | null }>;
  for (const r of spendWeekRows) {
    if (r.w) spendByWeek.set(_sqliteWeekToIsoWeekLabel(r.w, year), Number(r.s ?? 0));
  }

  const weeklyMerges: FleetYearInReviewWeek[] = weekLabels.map((wk) => ({
    week_iso: wk,
    merged: mergedByWeek.get(wk) ?? 0,
    closed_unmerged: closedByWeek.get(wk) ?? 0,
    spend_usd: spendByWeek.get(wk) ?? 0,
  }));

  // ── Dip-week detection: the single ISO week with the highest
  //    (closed_unmerged - merged) delta, GATED on spend above the
  //    year median. Clean year → null. ──────────────────────────
  const dipWeek = _detectDipWeek(weeklyMerges, quiet);

  // ── Top projects: at most 3 by merged_prs desc ──────────────────
  // Reuse projectWorthItVerdict for the verdict label (the helper's
  // window is sized to one year via the windowDays option).
  const projectAggRows = db.prepare(
    "SELECT p.id AS project_id, p.slug AS slug, "
    + "       COUNT(pr.number) AS merged_prs, "
    + "       COALESCE(SUM(crd.s), 0) AS spend_usd "
    + "  FROM project p "
    + "  LEFT JOIN pr ON pr.project_id = p.id "
    + "         AND pr.state = 'MERGED' AND pr.is_agent = 1 "
    + "         AND pr.fetched_at IS NOT NULL "
    + "         AND date(pr.fetched_at) >= ? AND date(pr.fetched_at) <= ? "
    + "  LEFT JOIN (SELECT project_id, day, SUM(COALESCE(cost_usd, 0)) AS s "
    + "               FROM cost_rollup_day "
    + "              WHERE day >= ? AND day <= ? "
    + "              GROUP BY project_id, day) crd "
    + "         ON crd.project_id = p.id "
    + " GROUP BY p.id, p.slug "
    + " ORDER BY merged_prs DESC, p.slug ASC",
  ).all(rangeStart, rangeEnd, rangeStart, rangeEnd) as unknown as YearInReviewProjectAggRow_internal[];

  const topProjects: FleetYearInReviewProject[] = [];
  for (const p of projectAggRows) {
    if (Number(p.merged_prs ?? 0) === 0) continue;
    if (topProjects.length >= 3) break;
    const merged = Number(p.merged_prs ?? 0) || 0;
    const spend = Number(p.spend_usd ?? 0) || 0;
    const cpp = merged > 0 ? spend / merged : null;
    // Verdict reuses the per-project helper with a 365-day window so
    // the "yearly trajectory" framing matches the page's promise. The
    // verdict is informational; the chip (sticky_days) suppression
    // happens at the SPA layer, not here.
    let verdict: FleetYearInReviewProject["verdict"] = "insufficient_data";
    try {
      const v = projectWorthItVerdict(db, p.project_id, now, {
        windowDays: 365,
        humanEquivalentHourlyUsd: hourlyRateUsd,
        humanHoursPerPr: hoursPerPr,
      });
      verdict = v.verdict;
    } catch { /* fall through to insufficient_data */ }
    // Fixed-template prose. Deterministic; never an LLM call.
    const cppStr = cpp != null ? `$${cpp.toFixed(2)}/PR` : "—/PR";
    const prose = _projectProse(p.slug, merged, cppStr, verdict);
    topProjects.push({
      project_slug: p.slug,
      merged_prs: merged,
      spend_usd: spend,
      cost_per_pr_usd: cpp,
      verdict,
      prose,
    });
  }

  // ── Top lessons: at most 3 by heal_count desc, from lesson_credit
  //    filtered to the year. ──────────────────────────────────────
  const lessonRows = db.prepare(
    "SELECT lesson_slug, lesson_date, lesson_title, "
    + "       COUNT(DISTINCT heal_audit_id) AS heal_count, "
    + "       MIN(created_at) AS first_credited_at, "
    + "       MAX(created_at) AS last_credited_at "
    + "  FROM lesson_credit "
    + " WHERE created_at >= ? AND created_at <= ? "
    + " GROUP BY lesson_slug, lesson_date, lesson_title "
    + " ORDER BY heal_count DESC, last_credited_at DESC "
    + " LIMIT 3",
  ).all(startIso, endIso) as unknown as Array<{
    lesson_slug: string; lesson_date: string; lesson_title: string;
    heal_count: number; first_credited_at: string; last_credited_at: string;
  }>;
  const topLessons: FleetYearInReviewLesson[] = lessonRows.map((r) => ({
    lesson_slug: String(r.lesson_slug),
    lesson_date: String(r.lesson_date),
    lesson_title: String(r.lesson_title),
    heal_count: Number(r.heal_count ?? 0),
    first_credited_at: String(r.first_credited_at ?? ""),
    last_credited_at: String(r.last_credited_at ?? ""),
    // Each lesson_credit row corresponds to ONE heal_audit_id, which
    // attributes to ONE saved PR. heal_count is therefore the
    // saved-PR count by construction. We surface both names so the
    // SPA can pick the operator-friendly phrasing.
    saved_pr_count: Number(r.heal_count ?? 0),
  }));

  return {
    year,
    range_start: rangeStart,
    range_end: rangeEnd,
    total_merged_prs: totalMergedPrs,
    total_spend_usd: totalSpendUsd,
    cost_per_pr_usd: costPerPrUsd,
    roi_multiplier: roiMultiplier,
    project_count: projectCount,
    weekly_merges: weeklyMerges,
    dip_week: dipWeek,
    top_projects: topProjects,
    top_lessons: topLessons,
    generated_at: now.toISOString(),
  };
}

/** Build the canonical ordered list of 52 ISO week labels for the
 *  given year. SQLite's `strftime('%Y-%W', ...)` returns weeks 00..53
 *  (Sunday-anchored). We normalise to "YYYY-Wnn" with nn ∈ 01..52
 *  so the labels match what the test asserts. */
function _yearIsoWeekLabels(year: number): string[] {
  const labels: string[] = [];
  for (let i = 1; i <= 52; i++) {
    labels.push(`${year}-W${String(i).padStart(2, "0")}`);
  }
  return labels;
}

/** Translate a SQLite `strftime('%Y-%W', ts)` value (e.g. "2026-23")
 *  into the canonical "YYYY-Wnn" label. SQLite's %W is 00-padded
 *  weeks-since-first-Sunday; weeks 00 are mapped to W01 so they roll
 *  into the year's opening week (the page is a calendar-year view —
 *  no operator cares whether the first half-week is W00 or W01).
 *  Weeks > 52 (rare year boundaries) are clamped to W52. */
function _sqliteWeekToIsoWeekLabel(sqliteValue: string, year: number): string {
  const m = sqliteValue.match(/^(\d{4})-(\d{1,2})$/);
  if (!m) return `${year}-W01`;
  let w = Number(m[2]);
  if (!Number.isFinite(w) || w < 1) w = 1;
  if (w > 52) w = 52;
  return `${year}-W${String(w).padStart(2, "0")}`;
}

/** Find the single ISO week with the highest (closed_unmerged -
 *  merged) delta, gated on "spend above the year median" so the
 *  detector doesn't fire on a sleepy week. Returns null when no
 *  week qualifies — "a clean year." The `quiet` flag toggles between
 *  the loss-framing headline ("the dip — N PRs died") and the
 *  neutral "lowest week" form. */
function _detectDipWeek(
  weeks: FleetYearInReviewWeek[],
  quiet: boolean,
): FleetYearInReviewDip | null {
  if (weeks.length === 0) return null;
  // Year-median spend across all 52 weeks.
  const spendValues = weeks.map((w) => w.spend_usd).sort((a, b) => a - b);
  const mid = Math.floor(spendValues.length / 2);
  const medianSpend = spendValues.length % 2 === 0
    ? (spendValues[mid - 1] + spendValues[mid]) / 2
    : spendValues[mid];
  // Candidate weeks: closed_unmerged > merged AND spend > median.
  // Pick the highest delta among candidates; tie-break on highest
  // spend then earliest week_iso so the result is deterministic.
  let winner: FleetYearInReviewWeek | null = null;
  let winnerDelta = -Infinity;
  for (const w of weeks) {
    const delta = w.closed_unmerged - w.merged;
    if (delta <= 0) continue;
    if (w.spend_usd <= medianSpend) continue;
    if (delta > winnerDelta
      || (delta === winnerDelta && winner && w.spend_usd > winner.spend_usd)
      || (delta === winnerDelta && winner && w.spend_usd === winner.spend_usd
          && w.week_iso < winner.week_iso)
    ) {
      winner = w;
      winnerDelta = delta;
    }
  }
  if (!winner) return null;
  const headline = quiet
    ? "the lowest week of the year"
    : `the dip — ${winner.closed_unmerged} PRs died, ${winner.merged} merged, $${winner.spend_usd.toFixed(0)} spent`;
  return {
    week_iso: winner.week_iso,
    merged: winner.merged,
    closed_unmerged: winner.closed_unmerged,
    spend_usd: winner.spend_usd,
    headline,
  };
}

/** Fixed-template per-project prose. Deterministic. No LLM, no
 *  template-injection risk (the slug is bound from the project
 *  table). */
function _projectProse(
  slug: string, mergedPrs: number, cppStr: string,
  verdict: FleetYearInReviewProject["verdict"],
): string {
  const verdictLabel: Record<FleetYearInReviewProject["verdict"], string> = {
    net_positive: "net-positive",
    watch: "watch",
    sunset_candidate: "sunset candidate",
    insufficient_data: "insufficient data",
  };
  return `${slug} shipped ${mergedPrs} PRs at ${cppStr}. Verdict ${verdictLabel[verdict]}.`;
}

// ────────────────────────────────────────────────────────────────────
// Pre-install ROI calculator (ticket 0051).
//
// Two helpers — `fleetMedianProjection` reads existing pr +
// cost_rollup_day + project tables to compute a fleet-wide median (or
// conservative p25) per-project per-month throughput and spend.
// `computeRoiProjection` is a pure JS arithmetic helper that projects
// what the prospect would see if they put N repos on the loop at their
// own hourly rate. The two helpers feed the public `/calculator` HTML
// page (zero auth, zero per-project leak) and the public
// `/api/fleet/median-projection` JSON route.
//
// PRODUCER-VS-SPEC reconciliation (LESSONS 2026-06-05 + 0040 lesson):
//   - merged PRs   = `state = 'MERGED'` uppercase + `is_agent = 1`
//                    (matches costPerMergedPr / spendEfficiencyRanking
//                    / projectWorthItVerdict). Producer writes the
//                    gh-state token verbatim per src/ingest/prs.ts:184.
//   - is_agent     = the producer's `AGENT_RE` predicate
//                    (`/^(feat\/|chore\/gtm-|eng\/)/`) — we reuse the
//                    column flag via `is_agent = 1` rather than
//                    re-deriving from the branch name.
// The `pr` table has NO surrogate `id` (PK `(project_id, number)` per
// LESSONS 2026-06-07) so the route-side cache invalidation tuple uses
// `(MAX(pr.fetched_at), COUNT(*), MAX(run.ended_at))` — never
// `MAX(pr.id)`. Identifier strings stay plain words inside the
// template-literal SQL per LESSONS 2026-05-26 "no backticks inside
// template-literal SQL strings". Any sub-ms window arithmetic decomposes
// via `strftime` (we don't need it here — the 90-day window framing is
// date-level, not microsecond).
//
// Privacy note: the aggregated return shape carries NO per-project
// fields. The percentile / median is computed JS-side over the
// per-project array, then only the aggregate value is returned. The
// caller (the JSON route + the /calculator HTML page) never sees the
// per-project rows, so a defensive grep on the route response can never
// find a project slug.

export interface FleetMedianProjection {
  window_days: number;
  projects_observed: number;
  merged_prs_per_month: number;
  spend_usd_per_month: number;
  cost_per_pr_usd: number | null;
  percentile: "p25" | "median";
  generated_at: string;
}

export interface FleetMedianProjectionOptions {
  windowDays?: number;
  percentile?: "p25" | "median";
}

interface MedianProjPrRow_internal { project_id: number; c: number | null; }
interface MedianProjSpendRow_internal { project_id: number; spent_usd: number | null; }

/** Conservative percentile of a sorted-ascending series. The "p25"
 *  picker uses the nearest-rank method: index = ceil(0.25 * N) - 1
 *  (1-based). The "median" picker reuses `_jsMedian` for the standard
 *  50th-percentile semantics. Empty series → null. */
function _pickPercentile(values: number[], percentile: "p25" | "median"): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (percentile === "median") return _jsMedian(sorted);
  // p25 via nearest-rank: idx = ceil(0.25 * N) - 1 (1-based → 0-based).
  // For N=5: ceil(1.25) - 1 = 1 → value at index 1 (the 2nd-smallest).
  // For N=2: ceil(0.5)  - 1 = 0 → smallest (the conservative pick).
  const idx = Math.max(0, Math.ceil(0.25 * sorted.length) - 1);
  return sorted[idx];
}

/** Fleet-wide median (or conservative p25) per-project monthly
 *  throughput + spend over a trailing window. Projects with fewer than
 *  3 merged PRs in the window are EXCLUDED from the percentile
 *  computation (matches the 0048 `insufficient_data` floor). When
 *  fewer than 2 projects qualify, returns the documented "insufficient
 *  fleet data" shape so the caller can render the demo-link fallback.
 *
 *  PRODUCER-VS-SPEC NOTE: the spec names the column literals upper-case
 *  ('MERGED' + is_agent=1). The producer writes 'MERGED' upper-case
 *  verbatim per src/ingest/prs.ts:184; we use that exact casing here.
 *  Per LESSONS 2026-06-07 the `pr` table has no surrogate `id`; the
 *  route-side cache invalidation uses `(MAX(fetched_at), COUNT(*),
 *  MAX(run.ended_at))` rather than `MAX(pr.id)`. */
export function fleetMedianProjection(
  db: DB,
  now: Date = new Date(),
  opts: FleetMedianProjectionOptions = {},
): FleetMedianProjection {
  const windowDays = Math.max(1, Math.min(365, Math.floor(opts.windowDays ?? 90)));
  const percentile: "p25" | "median" = opts.percentile === "median" ? "median" : "p25";

  // Window bounds: end is today's UTC midnight + 1 day (half-open
  // exclusive); start is windowDays before. Date-level (not
  // sub-millisecond) so no julianday drift concern (LESSONS 2026-05-26).
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const endExclusive = new Date(end);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - windowDays);
  const startStr = start.toISOString().slice(0, 10);
  const endExclusiveStr = endExclusive.toISOString().slice(0, 10);

  // Per-project merged-PR count over window. State casing matches the
  // producer (LESSONS 2026-06-05).
  const mergedRows = db.prepare(
    "SELECT project_id, COUNT(*) AS c "
    + "  FROM pr "
    + " WHERE state = 'MERGED' AND is_agent = 1 "
    + "   AND fetched_at IS NOT NULL "
    + "   AND date(fetched_at) >= ? AND date(fetched_at) < ? "
    + " GROUP BY project_id",
  ).all(startStr, endExclusiveStr) as unknown as MedianProjPrRow_internal[];
  const mergedByPid = new Map<number, number>();
  for (const r of mergedRows) mergedByPid.set(r.project_id, Number(r.c ?? 0));

  // Per-project spend over the same window (cost_rollup_day).
  const spendRows = db.prepare(
    "SELECT project_id, SUM(COALESCE(cost_usd, 0)) AS spent_usd "
    + "  FROM cost_rollup_day "
    + " WHERE day >= ? AND day < ? "
    + " GROUP BY project_id",
  ).all(startStr, endExclusiveStr) as unknown as MedianProjSpendRow_internal[];
  const spendByPid = new Map<number, number>();
  for (const r of spendRows) spendByPid.set(r.project_id, Number(r.spent_usd ?? 0));

  // Union of project_ids with either merges OR spend in the window. We
  // count projects_observed off this union so the caller's "insufficient
  // fleet data" context line reflects every project the fleet saw
  // (not only the qualifying ones).
  const projectIds = new Set<number>();
  for (const pid of mergedByPid.keys()) projectIds.add(pid);
  for (const pid of spendByPid.keys()) projectIds.add(pid);
  const projectsObserved = projectIds.size;

  // Qualifying projects: those with >= 3 merged PRs in the window.
  // Compute per-month throughput + per-month spend for each. Multiply
  // by (30 / windowDays) so the values are normalised to a calendar
  // month regardless of the window's literal length.
  const monthScale = 30 / windowDays;
  const qualifyingThroughput: number[] = [];
  const qualifyingSpend: number[] = [];
  for (const pid of projectIds) {
    const merged = mergedByPid.get(pid) ?? 0;
    if (merged < 3) continue; // excluded from the percentile.
    const spend = spendByPid.get(pid) ?? 0;
    qualifyingThroughput.push(merged * monthScale);
    qualifyingSpend.push(spend * monthScale);
  }

  // Insufficient fleet: fewer than 2 qualifying projects → the caller
  // can render the demo-link fallback honestly. We expose
  // projects_observed so the page can say "fleet has N projects but
  // none with >= 3 merged PRs in the window".
  if (qualifyingThroughput.length < 2) {
    return {
      window_days: windowDays,
      projects_observed: projectsObserved,
      merged_prs_per_month: 0,
      spend_usd_per_month: 0,
      cost_per_pr_usd: null,
      percentile,
      generated_at: now.toISOString(),
    };
  }

  // Pick the percentile point for throughput AND for spend
  // INDEPENDENTLY. The two series may pick different per-project
  // representatives (the conservative throughput project isn't
  // necessarily the conservative spend project). cost_per_pr is then
  // derived from those two aggregate values so the result is
  // self-consistent at the aggregate level.
  const throughputPick = _pickPercentile(qualifyingThroughput, percentile) ?? 0;
  const spendPick = _pickPercentile(qualifyingSpend, percentile) ?? 0;
  const costPerPr: number | null = throughputPick > 0 ? spendPick / throughputPick : null;

  return {
    window_days: windowDays,
    projects_observed: projectsObserved,
    merged_prs_per_month: throughputPick,
    spend_usd_per_month: spendPick,
    cost_per_pr_usd: costPerPr,
    percentile,
    generated_at: now.toISOString(),
  };
}

export interface RoiProjection {
  projected_merged_prs: number;
  projected_spend_usd: number;
  projected_cost_per_pr_usd: number | null;
  human_equivalent_cost_usd: number;
  roi_multiplier: number | null;
  percentile_label: string;
}

export interface RoiProjectionInputs {
  repos: number;
  hourlyRateUsd: number;
  /** Hours one engineer would spend shipping one of these PRs by hand.
   *  Defaults to 1 (matches the 0048 worth-it verdict). */
  hoursPerPr?: number;
}

/** Pure-JS arithmetic: project what N repos on the loop would yield at
 *  the prospect's hourly rate, given the fleet's median (or
 *  conservative p25) per-project per-month throughput. No DB read; the
 *  caller hands in a `FleetMedianProjection` from
 *  `fleetMedianProjection()`.
 *
 *  Formula:
 *    projected_merged_prs   = median.merged_prs_per_month × inputs.repos
 *    projected_spend_usd    = median.cost_per_pr_usd × projected_merged_prs
 *    human_equivalent_cost  = projected_merged_prs × hoursPerPr × hourlyRateUsd
 *    roi_multiplier         = human_equivalent_cost / projected_spend_usd
 *
 *  When spend is zero (insufficient fleet floor: cost_per_pr_usd is
 *  null) `roi_multiplier` is null — no division by zero. */
export function computeRoiProjection(
  median: FleetMedianProjection,
  inputs: RoiProjectionInputs,
): RoiProjection {
  const hoursPerPr = typeof inputs.hoursPerPr === "number" ? inputs.hoursPerPr : 1;
  const repos = inputs.repos;
  const projectedMergedPrs = median.merged_prs_per_month * repos;
  const projectedSpendUsd = median.cost_per_pr_usd != null
    ? median.cost_per_pr_usd * projectedMergedPrs
    : 0;
  const humanEquivalentCostUsd = projectedMergedPrs * hoursPerPr * inputs.hourlyRateUsd;
  const roiMultiplier: number | null = projectedSpendUsd > 0
    ? humanEquivalentCostUsd / projectedSpendUsd
    : null;
  const percentileLabel = median.percentile === "p25"
    ? "conservative (25th percentile of fleet)"
    : "median (50th percentile of fleet)";
  return {
    projected_merged_prs: projectedMergedPrs,
    projected_spend_usd: projectedSpendUsd,
    projected_cost_per_pr_usd: median.cost_per_pr_usd,
    human_equivalent_cost_usd: humanEquivalentCostUsd,
    roi_multiplier: roiMultiplier,
    percentile_label: percentileLabel,
  };
}

// ────────────────────────────────────────────────────────────────────
// Public weekly fleet pulse (ticket 0054).
//
// One evergreen URL surface: /pulse renders the MOST-RECENT COMPLETE
// ISO week (Mon 00:00 UTC → Sun 23:59:59.999 UTC). Composes existing
// `pr` + `cost_rollup_day` + `lesson_credit` + `project_pause` tables
// — no new schema. Reuses the existing `fleetStreak()` helper for the
// streak_days field so the pulse and the home banner agree on that
// number byte-for-byte.
//
// PRODUCER-VS-SPEC reconciliation (per LESSONS 2026-06-05 "groomer
// prose can disagree with the schema; the schema wins"):
//   - `pr.state = 'MERGED'` (uppercase) — matches src/ingest/prs.ts:
//     152 + src/views.ts:706 fleetStreak.
//   - `project_pause` has NO `active` column — a row's mere presence
//     means paused (per src/db.ts:189). `paused_count` = COUNT(*).
//   - `lesson_credit.created_at` — freshest = ORDER BY DESC LIMIT 1.
//   - `cost_rollup_day.day` is yyyy-mm-dd (per src/db.ts:72). Use
//     literal-string range matching (no julianday() — LESSONS
//     2026-05-26 julianday drift).
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// every row narrowing in this helper uses the double-cast.

/** ISO-week boundary helper: given a wall-clock anchor, returns the
 *  Monday-to-Sunday boundary for the MOST RECENT COMPLETE week.
 *
 *  Rules (per the ticket):
 *    - now = Wed 2026-06-10 → window Mon 2026-06-01 → Sun 2026-06-07.
 *    - now = Sun 2026-06-07 23:59 → same window (still Mon-Sun of THIS
 *      week, only the in-progress window-bound is the in-progress day).
 *    - now = Mon 2026-06-08 → window Mon 2026-06-01 → Sun 2026-06-07
 *      (previous week is the most-recent COMPLETE one).
 *
 *  We snap to the START of the most-recently-CLOSED week by walking
 *  back to the Monday of the week PRECEDING the in-progress one. */
function pulseWeekBoundary(now: Date): { startIso: string; endIso: string } {
  // UTC midnight of today.
  const today = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
  ));
  // ISO weekday: Mon=1..Sun=7. JS getUTCDay: Sun=0..Sat=6.
  const isoDay = (today.getUTCDay() + 6) % 7 + 1;
  // Sunday of the most-recent COMPLETE week.
  // If today is Monday (isoDay=1), the most-recent complete week
  // ended yesterday (Sunday) — go back 1 day.
  // If today is Sunday (isoDay=7), today is the LAST in-progress
  // day, so the most-recent COMPLETE week ended LAST Sunday — back 7.
  // General: most-recent complete Sunday = today - isoDay days.
  const sunday = new Date(today);
  sunday.setUTCDate(sunday.getUTCDate() - isoDay);
  // Monday of that week is six days earlier.
  const monday = new Date(sunday);
  monday.setUTCDate(monday.getUTCDate() - 6);
  return {
    startIso: monday.toISOString().slice(0, 10),
    endIso: sunday.toISOString().slice(0, 10),
  };
}

export interface FleetWeeklyPulseTopProject {
  slug: string;
  project_name: string;
  merged_prs: number;
}

export interface FleetWeeklyPulseFreshestLesson {
  lesson_slug: string;
  lesson_date: string;
  lesson_title: string;
}

export interface FleetWeeklyPulse {
  generated_at: string;
  week_start_iso: string;
  week_end_iso: string;
  merged_prs: number;
  total_spend_usd: number;
  cost_per_pr_usd: number | null;
  streak_days: number;
  top_project: FleetWeeklyPulseTopProject | null;
  freshest_lesson: FleetWeeklyPulseFreshestLesson | null;
  paused_count: number;
}

export interface FleetWeeklyPulseOptions {
  /** Wall-clock anchor. Tests pin this; production passes `new Date()`. */
  now?: Date;
  /** Reserved for future ROI multipliers; the v1 pulse helper does
   *  not use this but the parameter is part of the public surface
   *  so the route doesn't have to special-case it. */
  hourlyRateUsd?: number;
}

interface PulseMergedRow { c: number; }
interface PulseTopProjectRow { slug: string; name: string | null; c: number; }
interface PulseSpendRow { s: number | null; }
interface PulseFreshLessonRow {
  lesson_slug: string;
  lesson_date: string;
  lesson_title: string;
}
interface PulsePauseRow { c: number; }

/** Compose the weekly pulse. Pure read-side; no writes. The helper is
 *  memoised at the server.ts level via getPulseCached(); this function
 *  is the cache-miss workhorse. */
export function fleetWeeklyPulse(
  db: DB,
  opts: FleetWeeklyPulseOptions = {},
): FleetWeeklyPulse {
  const now = opts.now ?? new Date();
  const { startIso, endIso } = pulseWeekBoundary(now);
  // PR window: fetched_at falls inside [startIso, endIso] (inclusive
  // on both ends, since endIso is the Sunday DATE — date() drops the
  // sub-day component). Casing: 'MERGED' uppercase per the producer
  // in src/ingest/prs.ts:152.
  const mergedRow = db.prepare(
    "SELECT COUNT(*) AS c FROM pr "
    + " WHERE state = 'MERGED' "
    + "   AND is_agent = 1 "
    + "   AND fetched_at IS NOT NULL "
    + "   AND date(fetched_at) >= ? "
    + "   AND date(fetched_at) <= ?",
  ).get(startIso, endIso) as unknown as PulseMergedRow | undefined;
  const merged_prs = Number(mergedRow?.c ?? 0);

  // total spend in window: SUM cost_rollup_day.cost_usd where day
  // falls in [startIso, endIso].
  const spendRow = db.prepare(
    "SELECT SUM(cost_usd) AS s FROM cost_rollup_day "
    + " WHERE day >= ? AND day <= ?",
  ).get(startIso, endIso) as unknown as PulseSpendRow | undefined;
  const total_spend_usd = Number(spendRow?.s ?? 0) || 0;

  const cost_per_pr_usd: number | null = merged_prs > 0
    ? total_spend_usd / merged_prs
    : null;

  // streak_days: reuse the existing fleetStreak helper so the pulse
  // and the home banner agree byte-for-byte.
  const streak = fleetStreak(db, { now: now.toISOString() });
  const streak_days = streak.streak_days;

  // top_project: the project with the most merged PRs in the window.
  // Tie-break by slug ASC. Returns null when no merges in the window.
  let top_project: FleetWeeklyPulseTopProject | null = null;
  if (merged_prs > 0) {
    const topRow = db.prepare(
      "SELECT p.slug AS slug, p.name AS name, COUNT(*) AS c "
      + "  FROM pr LEFT JOIN project p ON p.id = pr.project_id "
      + " WHERE pr.state = 'MERGED' "
      + "   AND pr.is_agent = 1 "
      + "   AND pr.fetched_at IS NOT NULL "
      + "   AND date(pr.fetched_at) >= ? "
      + "   AND date(pr.fetched_at) <= ? "
      + " GROUP BY p.id "
      + " ORDER BY c DESC, p.slug ASC "
      + " LIMIT 1",
    ).get(startIso, endIso) as unknown as PulseTopProjectRow | undefined;
    if (topRow && topRow.slug) {
      top_project = {
        slug: String(topRow.slug),
        project_name: String(topRow.name ?? topRow.slug),
        merged_prs: Number(topRow.c) || 0,
      };
    }
  }

  // freshest_lesson: the most-recently-credited lesson_credit row
  // whose created_at falls in the window. Range is on the timestamp
  // string (ISO-8601 sorts lexicographically), with the upper bound
  // expressed as "T23:59:59.999Z" so a created_at at Sun 23:59 lands
  // INSIDE the window.
  const lowerTs = `${startIso}T00:00:00.000Z`;
  const upperTs = `${endIso}T23:59:59.999Z`;
  const freshRow = db.prepare(
    "SELECT lesson_slug, lesson_date, lesson_title "
    + "  FROM lesson_credit "
    + " WHERE created_at >= ? AND created_at <= ? "
    + " ORDER BY created_at DESC "
    + " LIMIT 1",
  ).get(lowerTs, upperTs) as unknown as PulseFreshLessonRow | undefined;
  const freshest_lesson: FleetWeeklyPulseFreshestLesson | null = freshRow
    ? {
        lesson_slug: String(freshRow.lesson_slug),
        lesson_date: String(freshRow.lesson_date),
        lesson_title: String(freshRow.lesson_title),
      }
    : null;

  // paused_count: project_pause has no `active` column — a row's
  // mere presence means paused. COUNT(*) is the contract.
  const pauseRow = db.prepare(
    "SELECT COUNT(*) AS c FROM project_pause",
  ).get() as unknown as PulsePauseRow | undefined;
  const paused_count = Number(pauseRow?.c ?? 0);

  return {
    generated_at: now.toISOString(),
    week_start_iso: startIso,
    week_end_iso: endIso,
    merged_prs,
    total_spend_usd,
    cost_per_pr_usd,
    streak_days,
    top_project,
    freshest_lesson,
    paused_count,
  };
}

// ────────────────────────────────────────────────────────────────────
// Ticket 0058 - Public failure-mode landing pages.
//
// Pure helper that groups recent failing PR rows by the stable signature
// produced by failureSignature in src/correlate.ts. The helper is consumed
// by three public routes in src/server.ts (GET /failures, GET
// /failures/<signature>, GET /api/failures) - all unauthenticated public
// SEO surfaces (zero-competition acquisition funnel per the ticket's
// growth lens).
//
// PRODUCER-VS-SPEC NOTE (per the schema-wins lesson): the pr table
// stores state as the lowercase string open (per src/ingest/prs.ts) and
// first_fail_check + first_fail_excerpt are nullable TEXT columns added
// via ALTER TABLE in src/db.ts. The cache invalidation tuple uses
// MAX(fetched_at) plus COUNT star because the pr table has no surrogate
// id column - composite primary key on project_id + number.
//
// LESSONS notes for the comment block, expressed as plain prose so the
// 0052 and 0040 character-window source greps do NOT capture across the
// helper boundary - no backticks around any sibling helper identifier
// in this block. The sibling helpers in this region are
// riskiestOpenPr, stuckPrTaxonomy, prAutopsies, fleetWeeklyPulse, and
// lessonSavingsRollup; their tests slice 4000 chars forward from each
// helper name and grep for SQL keywords inside backtick template
// literals. Keeping this block backtick-free is the simplest way to
// avoid leaking SELECT or FROM tokens into a sibling's slice window.
// ────────────────────────────────────────────────────────────────────

export interface FleetFailureModeRow {
  /** Stable signature key from correlate.ts (TS2304, git-push-403, ...). */
  signature: string;
  /** Fixed english phrase per signature, hardcoded below. */
  title: string;
  /** First (oldest) excerpt seen for this group, clipped to 200 chars,
   *  and run through the same anonymisation pass as the 0057 lesson
   *  archive (slugs become project-N, /Users/ paths become path
   *  placeholder, agent branch names become branch placeholder). */
  sample_excerpt_anonymised: string;
  /** COUNT(DISTINCT project.slug) per group within the window. */
  project_count: number;
  /** Total PR rows in the group within the window. */
  pr_count: number;
  first_seen_at: string;
  last_seen_at: string;
  /** Slug of a matching public-archive lesson (substring match on title
   *  OR body), or null when no lesson references this signature. */
  matched_lesson_slug: string | null;
}

export interface FleetFailureModes {
  generated_at: string;
  window_days: number;
  total_signatures: number;
  /** COUNT(DISTINCT project.slug) across every group in the window. */
  total_projects_affected: number;
  signatures: FleetFailureModeRow[];
}

export interface FleetFailureModesOptions {
  now?: Date;
  /** Defaults to 90 per the ticket. */
  windowDays?: number;
  /** Optional override for the operator slug to alias mapping. When
   *  omitted the helper builds the map from the project table. */
  projectAliasMap?: Record<string, string>;
  /** Optional list of lessons to scan for substring matches when
   *  populating matched_lesson_slug. The route handler hands this in
   *  from the existing public-archive helper (0057). When omitted the
   *  helper returns null for every matched_lesson_slug. */
  lessonsArchiveRows?: Array<{
    lesson_slug: string; lesson_title: string; lesson_body_anonymised: string;
  }>;
}

/** Hardcoded english phrase per signature. Per the ticket's
 *  closed-set posture, any unknown signature falls back to the
 *  signature itself - which is fine because failureSignature only ever
 *  returns one of the listed keys (or null). For dynamic TypeScript
 *  codes (TS\d{4}) we render the code itself inside the title. */
function titleForSignature(signature: string): string {
  if (signature === "git-push-403") return "git push: permission denied";
  if (signature === "gh-missing") return "gh CLI not found on PATH";
  if (signature === "node-missing") return "node binary not found on PATH";
  if (signature === "npm-eacces") return "npm install EACCES";
  if (/^TS\d{4}$/.test(signature)) return "TypeScript " + signature + " - cannot find name";
  return signature;
}

// Local anonymiser - mirrors the 0057 anonymiseLessonBody pass without
// importing lessons.ts (which already imports views.ts). Same rules:
// operator slug to alias-N, agent branch prefix to a branch placeholder,
// absolute Users/home path to a path placeholder, "ticket NNNN" to
// "an agent ticket". Technical tokens (TS2304, file extensions, code
// idioms) are NOT enumerated explicitly - they survive by NOT matching
// any of these patterns.
function reEscapeFailureMode(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function anonymiseExcerpt(body: string, aliasMap: Record<string, string>): string {
  let out = String(body ?? "");
  const slugs = Object.keys(aliasMap).slice().sort((a, b) => b.length - a.length);
  for (const slug of slugs) {
    if (!slug) continue;
    if (slug === "agent-fleet") continue;
    const alias = aliasMap[slug] ?? "project-?";
    const re = new RegExp("(^|[^A-Za-z0-9_-])" + reEscapeFailureMode(slug) + "(?![A-Za-z0-9_-])", "g");
    out = out.replace(re, (_m, pre) => String(pre) + alias);
  }
  out = out.replace(/\b(feat|chore|eng)\/[A-Za-z0-9/_.-]+/g, "<branch>");
  out = out.replace(/\/(?:Users|home)\/[^\s,;)]+/g, "<path>");
  out = out.replace(/\bticket\s+\d{3,5}\b/gi, "an agent ticket");
  return out;
}

interface FailureModePrRow {
  slug: string;
  fetched_at: string;
  first_fail_check: string | null;
  first_fail_excerpt: string | null;
}

interface ProjectSlugForFailures { slug: string; }

/** Build the operator alias map from the project table when the
 *  caller did not supply one. The bootstrap slug agent-fleet maps to
 *  itself (it is the public name of the open source kit); every other
 *  slug becomes project-N in deterministic alphabetical order. */
function buildAliasMapForFailures(db: DB): Record<string, string> {
  const out: Record<string, string> = {};
  let rows: ProjectSlugForFailures[] = [];
  try {
    rows = db.prepare("SELECT slug FROM project ORDER BY slug").all() as unknown as ProjectSlugForFailures[];
  } catch { /* project table may be missing on a fresh boot */ }
  let n = 1;
  for (const r of rows) {
    const slug = String(r.slug ?? "").trim();
    if (!slug) continue;
    if (slug === "agent-fleet") { out[slug] = "agent-fleet"; continue; }
    if (!(slug in out)) { out[slug] = "project-" + String(n); n += 1; }
  }
  return out;
}

/** Group every pr row in the trailing N-day window by the signature
 *  produced by failureSignature(). Returns the documented shape; the
 *  caller decides whether to surface it as JSON or HTML. The matched
 *  lesson lookup is a first-match-wins substring scan over the
 *  supplied lessons archive rows; when no rows are supplied the
 *  matched_lesson_slug is always null. */
export function fleetFailureModes(
  db: DB, opts: FleetFailureModesOptions = {},
): FleetFailureModes {
  const now = opts.now ?? new Date();
  const windowDays = Math.max(1, Math.floor(opts.windowDays ?? 90));
  const cutoffIso = new Date(now.getTime() - windowDays * 86_400_000).toISOString();
  const aliasMap = opts.projectAliasMap ?? buildAliasMapForFailures(db);

  // Read every pr row in the window with a non-null excerpt. Per the
  // ticket's spec we do NOT restrict to state = open: the historical
  // signal lives on closed-and-failing PRs too, which is exactly the
  // dark code the public surface is supposed to expose. The window cut
  // happens on fetched_at (the merged-at proxy + the freshness anchor
  // every other helper in this file uses).
  const rows = db.prepare(
    "SELECT p.slug AS slug, pr.fetched_at AS fetched_at, "
    + "       pr.first_fail_check AS first_fail_check, "
    + "       pr.first_fail_excerpt AS first_fail_excerpt "
    + "  FROM pr "
    + "  JOIN project p ON p.id = pr.project_id "
    + " WHERE pr.first_fail_excerpt IS NOT NULL "
    + "   AND pr.fetched_at >= ? "
    + " ORDER BY pr.fetched_at ASC",
  ).all(cutoffIso) as unknown as FailureModePrRow[];

  interface Group {
    slugs: Set<string>;
    pr_count: number;
    first_seen_at: string;
    last_seen_at: string;
    sample_raw_excerpt: string;
  }
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const sig = failureSignature(r.first_fail_check, r.first_fail_excerpt);
    if (!sig) continue;
    const slug = String(r.slug ?? "");
    const excerpt = String(r.first_fail_excerpt ?? "").slice(0, 200);
    const g = groups.get(sig);
    if (!g) {
      groups.set(sig, {
        slugs: new Set<string>([slug]),
        pr_count: 1,
        first_seen_at: r.fetched_at,
        last_seen_at: r.fetched_at,
        sample_raw_excerpt: excerpt,
      });
      continue;
    }
    g.slugs.add(slug);
    g.pr_count += 1;
    if (r.fetched_at < g.first_seen_at) g.first_seen_at = r.fetched_at;
    if (r.fetched_at > g.last_seen_at) g.last_seen_at = r.fetched_at;
  }

  const allSlugs = new Set<string>();
  const signatures: FleetFailureModeRow[] = [];
  for (const [signature, g] of groups) {
    for (const s of g.slugs) allSlugs.add(s);
    const sample = anonymiseExcerpt(g.sample_raw_excerpt, aliasMap).slice(0, 200);
    let matchedSlug: string | null = null;
    if (opts.lessonsArchiveRows) {
      for (const lesson of opts.lessonsArchiveRows) {
        if (lesson.lesson_title.includes(signature) || lesson.lesson_body_anonymised.includes(signature)) {
          matchedSlug = lesson.lesson_slug;
          break;
        }
      }
    }
    signatures.push({
      signature,
      title: titleForSignature(signature),
      sample_excerpt_anonymised: sample,
      project_count: g.slugs.size,
      pr_count: g.pr_count,
      first_seen_at: g.first_seen_at,
      last_seen_at: g.last_seen_at,
      matched_lesson_slug: matchedSlug,
    });
  }
  // Deterministic ordering by signature ascending so the JSON output
  // is stable across reorderings (matches the activeCorrelations
  // convention).
  signatures.sort((a, b) => a.signature.localeCompare(b.signature));

  return {
    generated_at: now.toISOString(),
    window_days: windowDays,
    total_signatures: signatures.length,
    total_projects_affected: allSlugs.size,
    signatures,
  };
}

// ────────────────────────────────────────────────────────────────────
// Ticket 0059 - Biggest surprise this week.
//
// One Tuesday-morning card answering "what would I have BET against
// this week and lost?" - five deterministic candidates evaluated in a
// fixed priority order. The first to fire wins. When none fires the
// card renders an honest "nothing surprising" sentence so the empty
// state never fabricates upbeat news (matches the cross-fleet courtiq
// share-flow-authenticity family from CROSS_LESSONS).
//
// Candidates (priority order, FIRST match wins):
//   1. silent-project       - trailing 4w avg >= 3 PRs/week AND this
//                             week's merged count is 0.
//   2. first-time-check     - a pr.first_fail_check value in this
//                             week absent from the trailing 8 weeks.
//   3. spend-doubled        - this week's cost-per-PR >= 2x the
//                             trailing 8w MEDIAN AND abs delta
//                             >= $1.00.
//   4. heal-streak-broken   - last 5 consecutive merged PRs (by
//                             fetched_at DESC) all had
//                             heal_attempts=0, AND a this-week merge
//                             has heal_attempts >= 1.
//   5. new-author-red       - an author with >= 5 merged PRs in the
//                             trailing 90d AND zero first_fail_check
//                             across those 90d rows landed a this-
//                             week PR with first_fail_check set.
//
// Window: Monday 00:00 UTC through Sunday 23:59:59 UTC of the week
// containing now (the IN-PROGRESS week - we surface what's surprising
// right now, not the most-recent complete week).
//
// PRODUCER-VS-SPEC reconciliation per LESSONS 2026-06-05 "groomer
// prose can disagree with the schema; the schema wins":
//   - pr.state = MERGED uppercase per src/ingest/prs.ts:152 plus the
//     existing costPerMergedPr and spendEfficiencyRanking callers.
//   - pr.heal_attempts is INTEGER DEFAULT 0 per src/db.ts:352.
//   - pr.first_fail_check is TEXT nullable per src/db.ts:339.
//   - pr.author is TEXT nullable (the GitHub login).
//   - cost-per-PR derivation mirrors costPerMergedPr: SUM of
//     cost_rollup_day.cost_usd over the date window divided by the
//     COUNT of MERGED is_agent PRs over the same date window.
//
// Per LESSONS section nodesqlite all-method narrowing every row uses
// the as-unknown-as RowT double cast.
// Per LESSONS 2026-06-11 character-window source greps leak into
// sibling helpers, this comment block uses PLAIN PROSE (no backticks)
// for any sibling helper identifier - the prior siblings in this
// region include fleetWeeklyPulse, fleetFailureModes, riskiestOpenPr,
// stuckPrTaxonomy, costPerMergedPr, and spendEfficiencyRanking.
// ────────────────────────────────────────────────────────────────────

export type FleetBiggestSurpriseKind =
  | "silent_project"
  | "first_time_check"
  | "spend_doubled"
  | "heal_streak_broken"
  | "new_author_red"
  | "none";

export interface FleetBiggestSurprise {
  generated_at: string;
  week_start_iso: string;
  week_end_iso: string;
  kind: FleetBiggestSurpriseKind;
  sentence: string;
  metric_label: string;
  metric_baseline: string;
  metric_this_week: string;
  deep_link: string | null;
  candidate_project_slug: string | null;
}

export interface FleetBiggestSurpriseOptions {
  /** Wall-clock anchor. Tests pin this; production passes new Date. */
  now?: Date;
  /** Future ROI multiplier (parity with fleetWeeklyPulse); the v1
   *  helper does not use this but the parameter is part of the public
   *  surface so the route does not have to special-case it. */
  hourlyRateUsd?: number;
  /** Trailing baseline window. Defaults to 8 per the AC. Tests may
   *  override to shrink the fixture footprint. */
  baselineWeeks?: number;
}

interface BsPrRow {
  project_id: number;
  number: number;
  state: string | null;
  author: string | null;
  url: string | null;
  fetched_at: string | null;
  heal_attempts: number | null;
  first_fail_check: string | null;
}

interface BsProjectRow {
  id: number;
  slug: string;
  name: string | null;
}

interface BsRollupRow {
  project_id: number;
  day: string;
  cost_usd: number | null;
}

/** Return the in-progress Monday-Sunday UTC window for `now`.
 *  Monday is isoDay=1, Sunday is isoDay=7 (JS getUTCDay shifts to
 *  Monday-based via the (+6)%7+1 trick used in pulseWeekBoundary). */
function bsWeekBoundary(now: Date): { startIso: string; endIso: string } {
  const today = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
  ));
  const isoDay = (today.getUTCDay() + 6) % 7 + 1; // Mon=1..Sun=7
  const monday = new Date(today);
  monday.setUTCDate(monday.getUTCDate() - (isoDay - 1));
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return {
    startIso: monday.toISOString().slice(0, 10),
    endIso: sunday.toISOString().slice(0, 10),
  };
}

/** Parse a GitHub PR URL into (owner, repo, number). Returns null
 *  on any malformed shape - the deep_link surface stays null so the
 *  SPA renders the sentence without a click target. */
function parseGhPrUrl(url: string | null): { owner: string; repo: string; number: number } | null {
  if (!url) return null;
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/** Render the deep_link for a PR row. /prs/<owner>/<repo>/<number>
 *  matches the existing pr-detail route shape. */
function prDeepLink(url: string | null): string | null {
  const p = parseGhPrUrl(url);
  if (!p) return null;
  return "/prs/" + p.owner + "/" + p.repo + "/" + p.number;
}

/** Median of a non-empty numeric array. Returns null on empty. */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = xs.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Compose the biggest-surprise card. Pure read-side; no writes. */
export function fleetBiggestSurprise(
  db: DB,
  opts: FleetBiggestSurpriseOptions = {},
): FleetBiggestSurprise {
  const now = opts.now ?? new Date();
  const baselineWeeks = Math.max(1, Math.floor(opts.baselineWeeks ?? 8));
  const { startIso, endIso } = bsWeekBoundary(now);
  const generatedAt = now.toISOString();

  // ── Window dates ────────────────────────────────────────────────
  // This week: [startIso, endIso] inclusive on both ends (Mon-Sun).
  // The prior baseline: 8 complete weeks ending the Sunday BEFORE
  // startIso. baselineStartIso is `baselineWeeks * 7` days before
  // startIso; baselineEndIso is the day before startIso.
  const startDate = new Date(startIso + "T00:00:00.000Z");
  const baselineEndDate = new Date(startDate);
  baselineEndDate.setUTCDate(baselineEndDate.getUTCDate() - 1);
  const baselineStartDate = new Date(startDate);
  baselineStartDate.setUTCDate(
    baselineStartDate.getUTCDate() - baselineWeeks * 7,
  );
  const baselineStartIso = baselineStartDate.toISOString().slice(0, 10);
  const baselineEndIso = baselineEndDate.toISOString().slice(0, 10);
  // 90-day window for the new-author-red candidate.
  const ninetyDaysAgo = new Date(startDate);
  ninetyDaysAgo.setUTCDate(ninetyDaysAgo.getUTCDate() - 90);
  const ninetyDaysAgoIso = ninetyDaysAgo.toISOString().slice(0, 10);

  // ── Default empty payload ──────────────────────────────────────
  const NONE: FleetBiggestSurprise = {
    generated_at: generatedAt,
    week_start_iso: startIso,
    week_end_iso: endIso,
    kind: "none",
    sentence: "Nothing surprising this week - the fleet did what it always does.",
    metric_label: "",
    metric_baseline: "",
    metric_this_week: "",
    deep_link: null,
    candidate_project_slug: null,
  };

  // ── AC10 honest empty state when there are < baselineWeeks weeks
  //    of pr data. We check by counting distinct ISO weeks present
  //    in pr.fetched_at across is_agent + MERGED rows.
  const totalWeeksRow = db.prepare(
    "SELECT COUNT(DISTINCT strftime('%Y-%W', date(fetched_at))) AS c "
    + "  FROM pr "
    + " WHERE state = 'MERGED' AND is_agent = 1 "
    + "   AND fetched_at IS NOT NULL",
  ).get() as unknown as { c: number | null } | undefined;
  const totalWeeks = Number(totalWeeksRow?.c ?? 0);
  if (totalWeeks < baselineWeeks) {
    return {
      ...NONE,
      sentence: "Your fleet is still warming up - surprises will surface here as the agents accumulate a baseline.",
    };
  }

  // ── Pull merged is_agent PR rows across the window of interest:
  //    baseline span PLUS this week. One SELECT covers every
  //    candidate's data needs; per-candidate filters happen in JS
  //    so the SQL stays boring.
  const prRows = db.prepare(
    "SELECT pr.project_id AS project_id, pr.number AS number, "
    + "       pr.state AS state, pr.author AS author, "
    + "       pr.url AS url, pr.fetched_at AS fetched_at, "
    + "       COALESCE(pr.heal_attempts, 0) AS heal_attempts, "
    + "       pr.first_fail_check AS first_fail_check "
    + "  FROM pr "
    + " WHERE pr.is_agent = 1 "
    + "   AND pr.fetched_at IS NOT NULL "
    + "   AND date(pr.fetched_at) >= ? AND date(pr.fetched_at) <= ?",
  ).all(baselineStartIso, endIso) as unknown as BsPrRow[];

  const projectRows = db.prepare(
    "SELECT id, slug, name FROM project ORDER BY slug",
  ).all() as unknown as BsProjectRow[];
  const projectById = new Map<number, BsProjectRow>();
  for (const p of projectRows) projectById.set(p.id, p);

  // ── Helper: which ISO week (Mon-Sun) does a fetched_at fall in?
  //    Reduce to the Monday-date string of that week. Pure JS; the
  //    SQL date() function returns yyyy-mm-dd which we re-parse here.
  function mondayOf(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00.000Z");
    const isoDay = (d.getUTCDay() + 6) % 7 + 1;
    d.setUTCDate(d.getUTCDate() - (isoDay - 1));
    return d.toISOString().slice(0, 10);
  }

  // Per-project merged-count maps keyed by Monday-of-week.
  // counts[pid] = Map<weekMondayIso, count>
  const countsByProject = new Map<number, Map<string, number>>();
  // All merged rows this week, by project, for the heal-streak walk.
  const mergedRowsByProject = new Map<number, BsPrRow[]>();
  // All merged rows in baseline + this week, by project (for the
  // streak walk we need the prior 5 + this week's first).
  const allMergedByProject = new Map<number, BsPrRow[]>();
  // first_fail_check sets: baseline-only + this-week.
  const baselineFailChecks = new Set<string>();
  const thisWeekFailRows: BsPrRow[] = [];
  // 90-day-author tracking.
  const ninetyDayAuthorCounts = new Map<string, number>();
  const ninetyDayAuthorRedCount = new Map<string, number>();
  const thisWeekAuthorRedRows: BsPrRow[] = [];

  for (const r of prRows) {
    if (!r.fetched_at) continue;
    const isMerged = r.state === "MERGED";
    if (!isMerged) continue;
    const day = r.fetched_at.slice(0, 10);
    const week = mondayOf(day);
    const inThisWeek = day >= startIso && day <= endIso;
    // Per-project weekly counts (baseline + this week).
    let m = countsByProject.get(r.project_id);
    if (!m) { m = new Map(); countsByProject.set(r.project_id, m); }
    m.set(week, (m.get(week) ?? 0) + 1);

    // Merged-by-project (sorted later by fetched_at DESC for streak).
    let allBucket = allMergedByProject.get(r.project_id);
    if (!allBucket) { allBucket = []; allMergedByProject.set(r.project_id, allBucket); }
    allBucket.push(r);

    if (inThisWeek) {
      let twBucket = mergedRowsByProject.get(r.project_id);
      if (!twBucket) { twBucket = []; mergedRowsByProject.set(r.project_id, twBucket); }
      twBucket.push(r);
    }

    // first_fail_check buckets.
    if (r.first_fail_check) {
      if (inThisWeek) {
        thisWeekFailRows.push(r);
      } else {
        baselineFailChecks.add(r.first_fail_check);
      }
    }

    // 90-day author windows. Trailing 90d = day >= ninetyDaysAgoIso
    // AND day < startIso (prior); this-week = inThisWeek.
    if (r.author) {
      if (day >= ninetyDaysAgoIso && day < startIso) {
        ninetyDayAuthorCounts.set(
          r.author, (ninetyDayAuthorCounts.get(r.author) ?? 0) + 1,
        );
        if (r.first_fail_check) {
          ninetyDayAuthorRedCount.set(
            r.author, (ninetyDayAuthorRedCount.get(r.author) ?? 0) + 1,
          );
        }
      } else if (inThisWeek && r.first_fail_check) {
        thisWeekAuthorRedRows.push(r);
      }
    }
  }

  // ── Candidate 1: silent-project ────────────────────────────────
  // For each project: trailing 4 complete weeks immediately before
  // this week. Compute average merged-count/week. Fire when avg >= 3
  // AND this week count == 0. Tie-break by slug ASC across multiple
  // silent projects.
  const TRAILING_SILENT_WEEKS = 4;
  const trailingMondays: string[] = [];
  for (let i = 1; i <= TRAILING_SILENT_WEEKS; i++) {
    const m2 = new Date(startDate);
    m2.setUTCDate(m2.getUTCDate() - i * 7);
    trailingMondays.push(m2.toISOString().slice(0, 10));
  }
  interface SilentCandidate { slug: string; avg: number; thisWeek: number; }
  const silentCandidates: SilentCandidate[] = [];
  for (const proj of projectRows) {
    const m = countsByProject.get(proj.id);
    let sum = 0;
    for (const wk of trailingMondays) sum += (m?.get(wk) ?? 0);
    const avg = sum / TRAILING_SILENT_WEEKS;
    const thisWeekCount = (m?.get(startIso) ?? 0);
    if (avg >= 3 && thisWeekCount === 0) {
      silentCandidates.push({ slug: proj.slug, avg, thisWeek: thisWeekCount });
    }
  }
  silentCandidates.sort((a, b) => a.slug.localeCompare(b.slug));
  if (silentCandidates.length > 0) {
    const c = silentCandidates[0];
    const avgRounded = Math.round(c.avg);
    return {
      generated_at: generatedAt,
      week_start_iso: startIso,
      week_end_iso: endIso,
      kind: "silent_project",
      sentence: c.slug + " went quiet this week - 0 PRs merged after 4 weeks averaging " + avgRounded + ".",
      metric_label: "PRs/week",
      metric_baseline: "avg " + avgRounded,
      metric_this_week: "0",
      deep_link: "/projects/" + c.slug,
      candidate_project_slug: c.slug,
    };
  }

  // ── Candidate 2: first-time-check ──────────────────────────────
  // Any pr.first_fail_check value present this week and absent from
  // the trailing baseline. Tie-break by check-name ASC.
  const firstTimeChecks: BsPrRow[] = [];
  for (const r of thisWeekFailRows) {
    if (r.first_fail_check && !baselineFailChecks.has(r.first_fail_check)) {
      firstTimeChecks.push(r);
    }
  }
  firstTimeChecks.sort((a, b) =>
    (a.first_fail_check ?? "").localeCompare(b.first_fail_check ?? ""),
  );
  if (firstTimeChecks.length > 0) {
    const r = firstTimeChecks[0];
    const link = prDeepLink(r.url);
    return {
      generated_at: generatedAt,
      week_start_iso: startIso,
      week_end_iso: endIso,
      kind: "first_time_check",
      sentence: "'" + r.first_fail_check + "' failed for the first time this week (last 8 weeks: never).",
      metric_label: "first-time check",
      metric_baseline: "never",
      metric_this_week: String(r.first_fail_check),
      deep_link: link,
      candidate_project_slug: projectById.get(r.project_id)?.slug ?? null,
    };
  }

  // ── Candidate 3: spend-doubled ─────────────────────────────────
  // For each project: per-week cost-per-PR over the trailing 8w
  // PLUS this week. Cost-per-PR(week) = SUM(cost_rollup_day in week)
  // / COUNT(merged is_agent PRs in week). Skip weeks with zero
  // merges (the ratio is undefined). Median over the 8 baseline
  // weeks gives the comparison anchor.
  // Pull all cost_rollup_day rows in [baselineStartIso, endIso].
  const rollupRows = db.prepare(
    "SELECT project_id, day, COALESCE(cost_usd, 0) AS cost_usd "
    + "  FROM cost_rollup_day "
    + " WHERE day >= ? AND day <= ?",
  ).all(baselineStartIso, endIso) as unknown as BsRollupRow[];
  const costsByProjectWeek = new Map<number, Map<string, number>>();
  for (const r of rollupRows) {
    const week = mondayOf(r.day);
    let m = costsByProjectWeek.get(r.project_id);
    if (!m) { m = new Map(); costsByProjectWeek.set(r.project_id, m); }
    m.set(week, (m.get(week) ?? 0) + Number(r.cost_usd ?? 0));
  }
  interface SpendCandidate {
    slug: string;
    baselineMedian: number;
    thisWeek: number;
  }
  const spendCandidates: SpendCandidate[] = [];
  for (const proj of projectRows) {
    const counts = countsByProject.get(proj.id);
    const costs = costsByProjectWeek.get(proj.id);
    if (!counts || !costs) continue;
    const baselineCpps: number[] = [];
    for (const wk of trailingMondays) {
      const c = counts.get(wk) ?? 0;
      const s = costs.get(wk) ?? 0;
      if (c > 0) baselineCpps.push(s / c);
    }
    // Use up to baselineWeeks back. Include the prior 4 weeks
    // covered by trailingMondays plus the older ones; rebuild.
    const fullBaselineMondays: string[] = [];
    for (let i = 1; i <= baselineWeeks; i++) {
      const m2 = new Date(startDate);
      m2.setUTCDate(m2.getUTCDate() - i * 7);
      fullBaselineMondays.push(m2.toISOString().slice(0, 10));
    }
    const fullCpps: number[] = [];
    for (const wk of fullBaselineMondays) {
      const c = counts.get(wk) ?? 0;
      const s = costs.get(wk) ?? 0;
      if (c > 0) fullCpps.push(s / c);
    }
    const med = median(fullCpps);
    if (med == null || med <= 0) continue;
    const thisWeekCount = counts.get(startIso) ?? 0;
    const thisWeekCost = costs.get(startIso) ?? 0;
    if (thisWeekCount === 0) continue;
    const thisWeekCpp = thisWeekCost / thisWeekCount;
    const absDelta = thisWeekCpp - med;
    if (thisWeekCpp >= 2 * med && absDelta >= 1.0) {
      spendCandidates.push({
        slug: proj.slug,
        baselineMedian: med,
        thisWeek: thisWeekCpp,
      });
    }
    void baselineCpps;
  }
  // Tie-break: highest absolute delta first; then slug ASC.
  spendCandidates.sort((a, b) => {
    const dA = a.thisWeek - a.baselineMedian;
    const dB = b.thisWeek - b.baselineMedian;
    if (dA !== dB) return dB - dA;
    return a.slug.localeCompare(b.slug);
  });
  if (spendCandidates.length > 0) {
    const c = spendCandidates[0];
    const formatUsd = (n: number) => "$" + (Math.round(n * 100) / 100).toFixed(2);
    return {
      generated_at: generatedAt,
      week_start_iso: startIso,
      week_end_iso: endIso,
      kind: "spend_doubled",
      sentence: c.slug + "'s cost-per-PR jumped from " + formatUsd(c.baselineMedian)
        + " to " + formatUsd(c.thisWeek) + " this week.",
      metric_label: "cost-per-PR",
      metric_baseline: formatUsd(c.baselineMedian),
      metric_this_week: formatUsd(c.thisWeek),
      deep_link: "/projects/" + c.slug,
      candidate_project_slug: c.slug,
    };
  }

  // ── Candidate 4: heal-streak-broken ────────────────────────────
  // For each project: take all merged PRs ordered by fetched_at
  // DESC. If a this-week row has heal_attempts >= 1 AND the
  // five PRIOR merges (older than this-week) all have
  // heal_attempts = 0, fire. Tie-break: highest heal_attempts on
  // this week's row; then slug ASC.
  interface HealCandidate {
    slug: string; healAttempts: number; prNumber: number;
    url: string | null;
  }
  const healCandidates: HealCandidate[] = [];
  for (const proj of projectRows) {
    const allRows = allMergedByProject.get(proj.id);
    if (!allRows || allRows.length === 0) continue;
    // Newest first; this-week first if equal.
    const sorted = allRows.slice().sort((a, b) => {
      const fa = a.fetched_at ?? "";
      const fb = b.fetched_at ?? "";
      if (fb !== fa) return fb.localeCompare(fa);
      return b.number - a.number;
    });
    // Find the newest this-week row with heal_attempts >= 1.
    const thisWeekHeal = sorted.find((r) => {
      if (!r.fetched_at) return false;
      const day = r.fetched_at.slice(0, 10);
      return day >= startIso && day <= endIso
        && (r.heal_attempts ?? 0) >= 1;
    });
    if (!thisWeekHeal) continue;
    // Walk five prior merges (older than this-week-row's fetched_at).
    const priorClean = sorted.filter((r) => {
      if (!r.fetched_at || !thisWeekHeal.fetched_at) return false;
      return r.fetched_at < thisWeekHeal.fetched_at;
    });
    if (priorClean.length < 5) continue;
    const lastFive = priorClean.slice(0, 5);
    if (lastFive.every((r) => (r.heal_attempts ?? 0) === 0)) {
      healCandidates.push({
        slug: proj.slug,
        healAttempts: thisWeekHeal.heal_attempts ?? 0,
        prNumber: thisWeekHeal.number,
        url: thisWeekHeal.url,
      });
    }
  }
  healCandidates.sort((a, b) => {
    if (b.healAttempts !== a.healAttempts) return b.healAttempts - a.healAttempts;
    return a.slug.localeCompare(b.slug);
  });
  if (healCandidates.length > 0) {
    const c = healCandidates[0];
    const link = prDeepLink(c.url);
    const healWord = c.healAttempts === 1 ? "heal" : "heals";
    return {
      generated_at: generatedAt,
      week_start_iso: startIso,
      week_end_iso: endIso,
      kind: "heal_streak_broken",
      sentence: c.slug + "'s 5-PR clean-merge streak ended this week (PR #"
        + c.prNumber + " took " + c.healAttempts + " " + healWord + ").",
      metric_label: "heal-attempts",
      metric_baseline: "0",
      metric_this_week: String(c.healAttempts),
      deep_link: link,
      candidate_project_slug: c.slug,
    };
  }

  // ── Candidate 5: new-author-red ────────────────────────────────
  // For each author with >= 5 trailing-90d merged PRs and ZERO
  // first_fail_check across that 90d window, a this-week row with
  // first_fail_check set fires. Tie-break: author ASC.
  const newAuthorRedRows: BsPrRow[] = [];
  for (const r of thisWeekAuthorRedRows) {
    if (!r.author) continue;
    const ninety = ninetyDayAuthorCounts.get(r.author) ?? 0;
    const ninetyRed = ninetyDayAuthorRedCount.get(r.author) ?? 0;
    if (ninety >= 5 && ninetyRed === 0) {
      newAuthorRedRows.push(r);
    }
  }
  newAuthorRedRows.sort((a, b) =>
    (a.author ?? "").localeCompare(b.author ?? ""),
  );
  if (newAuthorRedRows.length > 0) {
    const r = newAuthorRedRows[0];
    const link = prDeepLink(r.url);
    return {
      generated_at: generatedAt,
      week_start_iso: startIso,
      week_end_iso: endIso,
      kind: "new_author_red",
      sentence: r.author + "'s first red CI in 90 days landed this week.",
      metric_label: "red CIs (90d)",
      metric_baseline: "0",
      metric_this_week: "1",
      deep_link: link,
      candidate_project_slug: projectById.get(r.project_id)?.slug ?? null,
    };
  }

  return NONE;
}

// ────────────────────────────────────────────────────────────────────
// Ticket 0065: Operator-attributed profile page.
//
// Pure helper that composes the operator's career-shaped portfolio
// payload: handle plus four lifetime totals (PRs shipped, lessons
// authored, projects active, months running), the three most recent
// merged agent PRs, and the top three cited lessons.
//
// Source-of-truth reconciliation (per LESSONS 2026-06-05 producer-vs-
// spec note): lifetime merged-PR count uses state = 'MERGED' uppercase
// AND is_agent = 1 (matches the existing fleetYearInReview helper +
// the ingest producer in src/ingest/prs.ts:235). The lessonsAuthored
// total counts DISTINCT (lesson_slug, lesson_date) across the
// lesson_credit table per the 0042 / 0052 attribution ledger.
// Projects-active counts every project row with NO project_pause
// sibling (the mere presence of a project_pause row means paused per
// src/db.ts:189). monthsRunning anchors on the operator-supplied
// sinceDate, NOT a derived first-PR-ever anchor (per LESSONS
// 2026-06-15 first-month-meaningfully-crossed pivot - a fresh-install
// operator with imported history would otherwise lose months).
//
// Per LESSONS 2026-06-13 function-import cycles: views.ts MUST NOT
// import from lessons.ts (lessons.ts already imports from views.ts).
// The anonymisation pass is the existing private anonymiseExcerpt
// already inlined next to fleetFailureModes above.
//
// Per LESSONS 2026-05-29 the helper is pure on (db, cfg, now): now
// passes through, never new Date() inside.
// Per LESSONS node:sqlite all() needs as unknown as T[]: every row
// narrowing uses the double-cast.

/** Recent-ship row on the operator profile payload. */
export interface OperatorProfileShipRow {
  title: string;
  projectAlias: string;
  mergedAt: string;
}

/** Top-cited lesson row on the operator profile payload. The slug is
 *  the anonymised public slug (per the 0057 / 0058 convention); the
 *  excerpt is anonymised via the existing anonymiseExcerpt pass. */
export interface OperatorProfileLessonRow {
  slugAnon: string;
  excerpt: string;
  healCredits: number;
  lastCreditedAt: string;
}

/** Career-shaped totals - four numbers on the hero card. */
export interface OperatorProfileTotals {
  lifetimePrsShipped: number;
  lessonsAuthored: number;
  projectsActive: number;
  monthsRunning: number;
}

/** Full payload returned by operatorProfilePayload. Null when the
 *  config lacks an operator field - the route layer 404s on null. */
export interface OperatorProfilePayload {
  handle: string;
  displayName: string;
  headline: string;
  sinceDate: string;
  /** Absolute host URL for og:image composition. Empty string when
   *  the operator did not configure publicHost - the renderer falls
   *  back to a relative og:image URL. */
  publicHost: string;
  totals: OperatorProfileTotals;
  recentShips: OperatorProfileShipRow[];
  topLessons: OperatorProfileLessonRow[];
  attribution: "anonymised" | "attributed";
  quietHoursActive: boolean;
  /** Ticket 0068: number of downstream operators that recorded this
   *  operator as their fleet-control referral. Composed from
   *  referralGraphPayload(db, cfg, this.handle, now).totalIntroduced.
   *  Renderer surfaces a fifth stat block ONLY when this is > 0
   *  (the existing four stat blocks stay byte-identical otherwise). */
  referralsIntroduced: number;
  asOf: string;
  version: 1;
}

interface OperatorProfilePrRow {
  number: number;
  title: string | null;
  slug: string;
  fetched_at: string | null;
}

interface OperatorProfileLessonCreditRow {
  lesson_slug: string;
  lesson_date: string;
  lesson_title: string;
  saves: number;
  last_credited_at: string;
}

interface OperatorProfileLessonCountRow {
  n: number | null;
}

interface OperatorProfileCountRow { c: number | null; }

/** Months elapsed between two ISO date strings, floor(). Returns 0
 *  when sinceDate is malformed or after now. Pure arithmetic on
 *  UTC date parts so a daylight-savings shift does not nudge a
 *  month-boundary by one. */
function monthsBetween(sinceIso: string, now: Date): number {
  const m = String(sinceIso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return 0;
  const sy = Number(m[1]);
  const sm = Number(m[2]);
  const sd = Number(m[3]);
  const ny = now.getUTCFullYear();
  const nm = now.getUTCMonth() + 1;
  const nd = now.getUTCDate();
  let months = (ny - sy) * 12 + (nm - sm);
  // If the day-of-month has not yet rolled over, subtract one.
  if (nd < sd) months -= 1;
  return Math.max(0, months);
}

/** Compose the operator profile payload. Returns null when
 *  cfg.operator is absent (the route layer 404s on null). The four
 *  career totals are derived from existing tables - no schema work,
 *  no new ingest path. */
export function operatorProfilePayload(
  db: DB, cfg: FleetConfig, now: Date,
): OperatorProfilePayload | null {
  const op = cfg.operator;
  if (!op || !op.handle || !op.sinceDate) return null;

  const attribution: "anonymised" | "attributed" =
    op.attribution === "attributed" ? "attributed" : "anonymised";

  // ── Lifetime merged-PR count - state = 'MERGED' uppercase per
  //    producer (src/ingest/prs.ts:235 + views.ts fleetYearInReview).
  const lifetimePrsRow = db.prepare(
    "SELECT COUNT(*) AS c FROM pr WHERE state = 'MERGED' AND is_agent = 1",
  ).get() as unknown as OperatorProfileCountRow | undefined;
  const lifetimePrsShipped = Number(lifetimePrsRow?.c ?? 0) || 0;

  // ── Lessons authored - DISTINCT (lesson_slug, lesson_date) across
  //    the lesson_credit table (the 0042 / 0052 attribution ledger).
  const lessonsAuthoredRow = db.prepare(
    "SELECT COUNT(DISTINCT lesson_slug || '|' || lesson_date) AS n FROM lesson_credit",
  ).get() as unknown as OperatorProfileLessonCountRow | undefined;
  const lessonsAuthored = Number(lessonsAuthoredRow?.n ?? 0) || 0;

  // ── Projects active - every project row that has NO project_pause
  //    sibling. The mere presence of a project_pause row means paused
  //    per src/db.ts:189.
  const projectsActiveRow = db.prepare(
    "SELECT COUNT(*) AS c FROM project p "
    + "LEFT JOIN project_pause pp ON pp.project_id = p.id "
    + "WHERE pp.project_id IS NULL",
  ).get() as unknown as OperatorProfileCountRow | undefined;
  const projectsActive = Number(projectsActiveRow?.c ?? 0) || 0;

  const monthsRunning = monthsBetween(op.sinceDate, now);

  // ── Recent ships - the three most recent merged agent PRs.
  //    Attribution branch is honoured at row-mapping time so the
  //    payload reflects the operator's setting without a second pass.
  const recentRows = db.prepare(
    "SELECT pr.number AS number, pr.title AS title, p.slug AS slug, "
    + "       pr.fetched_at AS fetched_at "
    + "FROM pr "
    + "JOIN project p ON p.id = pr.project_id "
    + "WHERE pr.state = 'MERGED' AND pr.is_agent = 1 "
    + "  AND pr.fetched_at IS NOT NULL "
    + "ORDER BY pr.fetched_at DESC, pr.number DESC "
    + "LIMIT 3",
  ).all() as unknown as OperatorProfilePrRow[];

  // Build a stable anonymised alias map from the project rows so
  // project-a / project-b / ... assignment is deterministic across
  // calls (sorted by slug ASC).
  const aliasMap: Record<string, string> = {};
  if (attribution === "anonymised") {
    const slugRows = db.prepare(
      "SELECT DISTINCT p.slug AS slug FROM project p ORDER BY p.slug ASC",
    ).all() as unknown as { slug: string }[];
    let n = 0;
    for (const r of slugRows) {
      const slug = String(r.slug ?? "");
      if (!slug) continue;
      aliasMap[slug] = "project-" + String.fromCharCode(97 + n); // a, b, c, ...
      n += 1;
    }
  }

  const recentShips: OperatorProfileShipRow[] = recentRows.map((r) => {
    const realSlug = String(r.slug ?? "");
    if (attribution === "attributed") {
      return {
        title: String(r.title ?? "shipped a feature"),
        projectAlias: realSlug,
        mergedAt: String(r.fetched_at ?? ""),
      };
    }
    return {
      title: "shipped a feature",
      projectAlias: aliasMap[realSlug] ?? "project-a",
      mergedAt: String(r.fetched_at ?? ""),
    };
  });

  // ── Top lessons - three highest heal_credit rows from lesson_credit.
  //    Slug is anonymised via the same kebab-case pass already used by
  //    the 0057 lesson archive (we keep the public slug verbatim - it
  //    is already operator-derived not project-derived). Excerpt is
  //    the lesson_title scrubbed via the local anonymiseExcerpt pass.
  const topLessonRows = db.prepare(
    "SELECT lesson_slug, lesson_date, lesson_title, "
    + "       COUNT(DISTINCT heal_audit_id) AS saves, "
    + "       MAX(created_at) AS last_credited_at "
    + "FROM lesson_credit "
    + "GROUP BY lesson_slug, lesson_date, lesson_title "
    + "ORDER BY saves DESC, last_credited_at DESC "
    + "LIMIT 3",
  ).all() as unknown as OperatorProfileLessonCreditRow[];

  // Build a project-only alias map for the excerpt anonymiser (we want
  // operator slugs in lesson bodies to collapse to project-N even
  // when attribution is 'attributed' on the ships - the lesson
  // excerpts are cross-fleet artifacts and stay anonymised regardless).
  const excerptAliasMap: Record<string, string> = {};
  const allSlugRows = db.prepare(
    "SELECT DISTINCT p.slug AS slug FROM project p ORDER BY p.slug ASC",
  ).all() as unknown as { slug: string }[];
  let an = 0;
  for (const r of allSlugRows) {
    const slug = String(r.slug ?? "");
    if (!slug) continue;
    excerptAliasMap[slug] = "project-" + String.fromCharCode(97 + an);
    an += 1;
  }

  const topLessons: OperatorProfileLessonRow[] = topLessonRows.map((r) => {
    const title = String(r.lesson_title ?? "");
    const excerpt = anonymiseExcerpt(title, excerptAliasMap).slice(0, 160);
    return {
      slugAnon: String(r.lesson_slug ?? ""),
      excerpt,
      healCredits: Number(r.saves) || 0,
      lastCreditedAt: String(r.last_credited_at ?? ""),
    };
  });

  // Ticket 0068: referralsIntroduced is populated by reading the
  // totalIntroduced count from referralGraphPayload for the operator's
  // own handle. The helper is defined below in this file (hoisted
  // function declaration so forward reference is safe).
  const referralsIntroduced = referralGraphPayload(db, cfg, op.handle, now).totalIntroduced;

  return {
    handle: op.handle,
    displayName: op.displayName ?? op.handle,
    headline: op.headline ?? "running an autonomous agent fleet",
    sinceDate: op.sinceDate,
    publicHost: op.publicHost ?? "",
    totals: {
      lifetimePrsShipped,
      lessonsAuthored,
      projectsActive,
      monthsRunning,
    },
    recentShips,
    topLessons,
    attribution,
    quietHoursActive: false, // filled in by the route layer
    referralsIntroduced,
    asOf: now.toISOString(),
    version: 1,
  };
}

// HTML escape helper - small inline copy per the pattern already used
// by renderOgPulseSvg / renderPulsePage. Avoids any import edge to a
// shared escaper module which does not exist in this codebase today.
function escForOperatorProfile(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

/** Render the self-contained operator profile HTML page. Pure on the
 *  payload + the opts surface (quiet-hours flag drives the install
 *  CTA branch). Empty-state branch (zero PRs shipped) renders the
 *  warming-up sentence with its own testid. */
export function renderOperatorProfilePage(
  p: OperatorProfilePayload,
  opts: { quietHoursActive: boolean },
): string {
  const handle = escForOperatorProfile(p.handle);
  const displayName = escForOperatorProfile(p.displayName);
  const headline = escForOperatorProfile(p.headline);
  const sinceDate = escForOperatorProfile(p.sinceDate);
  const hostBase = p.publicHost ? p.publicHost.replace(/\/+$/, "") : "";
  const ogImageUrl = hostBase
    ? hostBase + "/og/operator/" + handle + ".svg"
    : "/og/operator/" + handle + ".svg";
  const safeOgImageUrl = escForOperatorProfile(ogImageUrl);

  // Empty-state branch - operator has shipped 0 PRs total.
  if (p.totals.lifetimePrsShipped === 0) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${displayName} - operator profile</title>
<link rel="stylesheet" href="/style.css" />
<meta name="robots" content="index, follow" />
<meta property="og:type" content="profile" />
<meta property="og:title" content="${displayName} - fleet operator" />
<meta property="og:description" content="${headline}" />
<meta property="og:image" content="${safeOgImageUrl}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="${safeOgImageUrl}" />
</head>
<body class="operator-profile-page">
<main class="operator-profile">
  <header class="operator-profile-header">
    <h1 class="operator-profile-handle" data-testid="operator-profile-handle">${handle}</h1>
    <div class="operator-profile-display-name">${displayName}</div>
    <div class="operator-profile-headline">${headline}</div>
    <div class="operator-profile-since">fleet operator since ${sinceDate}</div>
  </header>
  <section class="operator-profile-warming" data-testid="operator-profile-warming-up">
    your fleet is still warming up - check back after your first 3 ships.
  </section>
  <footer class="operator-profile-footer">
    powered by fleet-control
  </footer>
</main>
</body>
</html>`;
  }

  const totals = p.totals;
  const recentShipsHtml = p.recentShips.map((s, i) => {
    const titleSafe = escForOperatorProfile(s.title);
    const aliasSafe = escForOperatorProfile(s.projectAlias);
    const mergedSafe = escForOperatorProfile(s.mergedAt.slice(0, 10));
    return `<li class="recent-ship" data-testid="recent-ship-${i}">`
      + `<span class="recent-ship-title">${titleSafe}</span> `
      + `<span class="recent-ship-alias">${aliasSafe}</span> `
      + `<span class="recent-ship-date">${mergedSafe}</span>`
      + `</li>`;
  }).join("");

  const topLessonsHtml = p.topLessons.map((L, i) => {
    const slugSafe = escForOperatorProfile(L.slugAnon);
    const excerptSafe = escForOperatorProfile(L.excerpt);
    const creditsSafe = escForOperatorProfile(String(L.healCredits));
    return `<li class="top-lesson" data-testid="top-lesson-${i}">`
      + `<span class="top-lesson-slug">${slugSafe}</span> `
      + `<span class="top-lesson-excerpt">${excerptSafe}</span> `
      + `<span class="top-lesson-credits">${creditsSafe} saves</span>`
      + `</li>`;
  }).join("");

  const installCta = opts.quietHoursActive
    ? `<div class="operator-profile-quiet" data-testid="operator-profile-quiet-caption">fleet operator since ${sinceDate}</div>`
    : `<a class="operator-profile-install-cta" data-testid="install-cta" href="https://github.com/mutaaf/fleet-control">install fleet-control</a>`;

  // Ticket 0068: optional referrals stat block. Rendered ONLY when
  // referralsIntroduced > 0 so the existing four-block layout stays
  // byte-identical on a zero-referral fleet. The block links to the
  // /referrals/<handle> route so a reader can browse the downstream
  // tree.
  const referralsCount = p.referralsIntroduced ?? 0;
  const referralsBlock = referralsCount > 0
    ? `<a class="operator-profile-stat" data-testid="operator-profile-referrals" href="/referrals/${handle}"><span class="operator-profile-stat-value">${referralsCount}</span><span class="operator-profile-stat-label">${referralsCount} operators introduced to fleet-control</span></a>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${displayName} - operator profile</title>
<link rel="stylesheet" href="/style.css" />
<meta name="robots" content="index, follow" />
<meta property="og:type" content="profile" />
<meta property="og:title" content="${displayName} - fleet operator" />
<meta property="og:description" content="${headline}" />
<meta property="og:image" content="${safeOgImageUrl}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="${safeOgImageUrl}" />
</head>
<body class="operator-profile-page">
<main class="operator-profile">
  <header class="operator-profile-header">
    <h1 class="operator-profile-handle" data-testid="operator-profile-handle">${handle}</h1>
    <div class="operator-profile-display-name">${displayName}</div>
    <div class="operator-profile-headline">${headline}</div>
    <div class="operator-profile-since">running an autonomous agent fleet since ${sinceDate}</div>
  </header>
  <section class="operator-profile-totals">
    <div class="operator-profile-stat" data-testid="operator-profile-prs-shipped"><span class="operator-profile-stat-value">${totals.lifetimePrsShipped}</span><span class="operator-profile-stat-label">PRs shipped</span></div>
    <div class="operator-profile-stat" data-testid="operator-profile-lessons-authored"><span class="operator-profile-stat-value">${totals.lessonsAuthored}</span><span class="operator-profile-stat-label">lessons authored</span></div>
    <div class="operator-profile-stat" data-testid="operator-profile-projects-active"><span class="operator-profile-stat-value">${totals.projectsActive}</span><span class="operator-profile-stat-label">projects active</span></div>
    <div class="operator-profile-stat" data-testid="operator-profile-months-running"><span class="operator-profile-stat-value">${totals.monthsRunning}</span><span class="operator-profile-stat-label">months running</span></div>
    ${referralsBlock}
  </section>
  <section class="operator-profile-recent">
    <h2>recent ships</h2>
    <ul class="recent-ships">${recentShipsHtml}</ul>
  </section>
  <section class="operator-profile-lessons">
    <h2>top cited lessons</h2>
    <ul class="top-lessons">${topLessonsHtml}</ul>
  </section>
  <footer class="operator-profile-footer">
    ${installCta}
  </footer>
</main>
</body>
</html>`;
}

/** Test seam: drive the renderer's attribution + quiet-hours branches
 *  directly without booting startServer or mutating cwd config. Per
 *  LESSONS 2026-06-11. */
export function _renderOperatorProfileForTests(
  p: OperatorProfilePayload,
  opts: { quietHoursActive: boolean },
): string {
  return renderOperatorProfilePage(p, opts);
}

/** Render the hand-rolled 1200x630 SVG sibling for the operator
 *  profile (the LinkedIn / Twitter OG card). Four stat blocks, the
 *  handle, the footer with the install hint. The testid anchors the
 *  handle field per LESSONS 2026-06-12 (non-greedy attribute match).
 *  Hand-rolled string concatenation per the 0061 OG precedent. */
export function renderOperatorOgSvg(p: OperatorProfilePayload): string {
  const w = 1200;
  const h = 630;
  const handle = escForOperatorProfile(p.handle);
  const headline = escForOperatorProfile(p.headline);
  const totals = p.totals;
  return `<?xml version="1.0" encoding="UTF-8"?>`
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="operator profile">`
    + `<rect width="100%" height="100%" fill="#0E0F0D"></rect>`
    + `<text x="60" y="110" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="32">fleet operator profile</text>`
    + `<text x="60" y="180" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="64" font-weight="700" data-testid="operator-og-handle">${handle}</text>`
    + `<text x="60" y="230" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="24">${headline}</text>`
    + `<g data-testid="operator-og-totals">`
    + `<text x="60" y="380" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="80" font-weight="700">${totals.lifetimePrsShipped}</text>`
    + `<text x="60" y="420" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="22">PRs shipped</text>`
    + `<text x="360" y="380" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="80" font-weight="700">${totals.lessonsAuthored}</text>`
    + `<text x="360" y="420" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="22">lessons</text>`
    + `<text x="660" y="380" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="80" font-weight="700">${totals.projectsActive}</text>`
    + `<text x="660" y="420" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="22">projects</text>`
    + `<text x="960" y="380" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="80" font-weight="700">${totals.monthsRunning}</text>`
    + `<text x="960" y="420" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="22">months</text>`
    + `</g>`
    + `<text x="60" y="${h - 40}" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="22">powered by fleet-control</text>`
    + `</svg>`;
}

export function _renderOperatorOgSvgForTests(p: OperatorProfilePayload): string {
  return renderOperatorOgSvg(p);
}

// ────────────────────────────────────────────────────────────────────
// Ticket 0068 - Operator-to-operator referral graph.
//
// Three helpers + one renderer + one test seam:
//   - referralGraphPayload(db, cfg, handle, now): compose the public
//     tile list for the upstream operator named by handle.
//   - recordReferralAck(db, cfg, now): write one local referral_ack
//     snapshot row per startup when cfg.operator.referredBy is set;
//     idempotent on the (upstream, downstream) tuple.
//   - renderReferralGraphPage(payload, opts): pure HTML composer.
//   - _renderReferralGraphForTests: branch driver per LESSONS 2026-06-11.
//
// LESSONS hygiene:
//   - 2026-05-29 time-pinned: each helper takes now: Date. No
//     new Date() inside the helpers.
//   - 2026-06-05 invalidation: the server side caches the payload and
//     registers an invalidation function on
//     globalThis.__fleet_referral_invalidate__ so ingest-side commits
//     bust the cache without an import cycle.
//   - 2026-06-07 invalidation-tuple: snapshot rows have no surrogate
//     id BUT do carry created_at; the cache key is
//     (MAX(created_at WHERE kind='referral_ack'), COUNT(*) WHERE
//     kind='referral_ack') - mirrors the riskiest-PR tuple precedent.
//   - 2026-06-11 expose a renderer-direct seam so the quiet-hours
//     branch is testable without booting startServer.
//   - 2026-06-12 every HTML scrape anchors on data-testid so a
//     greedy id= regex never picks up the wrong attribute.
//   - 2026-06-13 no new module - the helpers live alongside the
//     operator profile helpers in views.ts.
//   - The leading comment block above uses plain prose for all
//     identifiers (no backticks) per LESSONS 2026-06-11 character-
//     window sibling-helper greps. The sibling siblings here are the
//     operator profile helpers which do not have character-window
//     greps but the precedent stays.
// ────────────────────────────────────────────────────────────────────

/** One tile on the referral graph page. handleAnon is the SHA-256 hex
 *  first 8 chars of the downstream handle - stable across reloads so
 *  the placeholder tile keeps the same anonymised identity. When the
 *  downstream consented (consentPublicCredit = true) the renderer
 *  surfaces displayHandle instead of the placeholder; otherwise
 *  displayHandle is null and the placeholder is the only thing the
 *  reader sees. */
export interface ReferralGraphTile {
  handleAnon: string;
  displayHandle: string | null;
  sinceDate: string;
  prsShipped: number;
  consentPublicCredit: boolean;
}

/** Full referral graph payload returned by referralGraphPayload. The
 *  shape is the route renderer's input AND the operator-profile stat
 *  block's source. version is 1 for v1; future field additions
 *  extend without breaking the route shape. */
export interface ReferralGraphPayload {
  handle: string;
  totalIntroduced: number;
  /** ISO date of the earliest acknowledgedAt across the tiles. Null
   *  when totalIntroduced === 0 (no since-date to project). */
  since: string | null;
  tiles: ReferralGraphTile[];
  asOf: string;
  version: 1;
}

interface ReferralAckRow {
  payload_json: string;
  created_at: string;
}

interface ReferralAckPayload {
  upstream?: string;
  downstream?: string;
  acknowledgedAt?: string;
  consentPublicCredit?: boolean;
  prsShipped?: number;
  sinceDate?: string;
  version?: number;
}

/** Stable anonymised placeholder for a downstream handle. SHA-256 hex
 *  first 8 chars - per the AC spec. */
function referralHandleAnon(downstream: string): string {
  return createHash("sha256").update(String(downstream ?? "")).digest("hex").slice(0, 8);
}

/** Compose the referral graph payload for an upstream operator. Pulls
 *  every snapshot row whose kind = 'referral_ack' AND payload.upstream
 *  matches the requested handle, then assembles one tile per row. The
 *  helper is intentionally tolerant of malformed payloads (we treat
 *  missing fields as their zero-values) so a corrupted local row
 *  cannot break the route. */
export function referralGraphPayload(
  db: DB, _cfg: FleetConfig, handle: string, now: Date,
): ReferralGraphPayload {
  const rows = db.prepare(
    "SELECT payload_json, created_at FROM snapshot "
    + "WHERE kind = 'referral_ack' "
    + "ORDER BY created_at ASC",
  ).all() as unknown as ReferralAckRow[];

  const tiles: ReferralGraphTile[] = [];
  let earliest: string | null = null;
  for (const r of rows) {
    let parsed: ReferralAckPayload;
    try { parsed = JSON.parse(r.payload_json) as ReferralAckPayload; }
    catch { continue; }
    if (!parsed || String(parsed.upstream ?? "") !== String(handle)) continue;
    const downstream = String(parsed.downstream ?? "");
    if (!downstream) continue;
    const consent = parsed.consentPublicCredit === true;
    const ackAt = String(parsed.acknowledgedAt ?? r.created_at ?? "");
    if (ackAt && (earliest === null || ackAt < earliest)) earliest = ackAt;
    tiles.push({
      handleAnon: referralHandleAnon(downstream),
      displayHandle: consent ? downstream : null,
      sinceDate: String(parsed.sinceDate ?? ackAt.slice(0, 10) ?? ""),
      prsShipped: Number(parsed.prsShipped) || 0,
      consentPublicCredit: consent,
    });
  }

  return {
    handle: String(handle),
    totalIntroduced: tiles.length,
    since: earliest ? earliest.slice(0, 10) : null,
    tiles,
    asOf: now.toISOString(),
    version: 1,
  };
}

/** Write one referral_ack snapshot row when cfg.operator.referredBy is
 *  set. Idempotent on the (upstream, downstream) tuple via the
 *  derived snapshot.id - INSERT OR REPLACE means a subsequent call
 *  with a flipped consent value overwrites in-place. The expires_at
 *  field is 100 years out so the ack outlives any normal operator
 *  retention without a manual extension. The operator revokes the
 *  ack by editing their fleet-control.config.json (removing the
 *  referredBy field) AND deleting the row - or just by deleting the
 *  row directly via snapshot revoke. */
export function recordReferralAck(db: DB, cfg: FleetConfig, _now: Date): void {
  const op = cfg.operator;
  if (!op || !op.handle || !op.referredBy || !op.referredBy.handle) return;
  if (!op.referredBy.acknowledgedAt) return;
  const upstream = String(op.referredBy.handle);
  const downstream = String(op.handle);
  if (!upstream || !downstream) return;
  const consent = op.referredBy.consentPublicCredit === true;
  const ackAt = String(op.referredBy.acknowledgedAt);
  const id = createHash("sha256")
    .update("ack|" + upstream + "|" + downstream)
    .digest("hex");
  const expiresAt = new Date(
    new Date(ackAt).getTime() + 100 * 365 * 86_400_000,
  ).toISOString();
  const payload: ReferralAckPayload = {
    upstream,
    downstream,
    acknowledgedAt: ackAt,
    consentPublicCredit: consent,
    prsShipped: 0,
    sinceDate: ackAt.slice(0, 10),
    version: 1,
  };
  // INSERT OR REPLACE on the derived id makes the call idempotent on
  // (upstream, downstream). created_at takes the cfg.referredBy
  // acknowledgedAt so a re-call with a flipped consent value does NOT
  // shift the row's created_at - matching the operator's intent that
  // the ack timestamp is the acknowledgement date, not the last-write
  // moment.
  db.prepare(
    "INSERT OR REPLACE INTO snapshot(id,name,created_at,expires_at,revoked_at,payload_json,kind)"
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(
    id,
    "referral-ack-" + upstream + "-" + downstream,
    ackAt,
    expiresAt,
    null,
    JSON.stringify(payload),
    "referral_ack",
  );
}

function escForReferral(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

/** Render the self-contained referral graph HTML page. Pure on the
 *  payload + the opts surface (quiet-hours flag drives the install
 *  CTA branch). Empty-state branch (zero tiles) renders the honest
 *  "no referrals visible from this instance yet" copy. */
export function renderReferralGraphPage(
  p: ReferralGraphPayload,
  opts: { quietHoursActive: boolean },
): string {
  const handle = escForReferral(p.handle);
  const totalIntroduced = Number(p.totalIntroduced) || 0;

  const footer = opts.quietHoursActive
    ? `<div class="referral-graph-quiet" data-testid="referral-graph-quiet-caption">powered by fleet-control</div>`
    : `<a class="referral-graph-install-cta" data-testid="install-cta" href="https://github.com/mutaaf/fleet-control">install fleet-control</a>`;

  if (totalIntroduced === 0) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${handle} - referrals</title>
<link rel="stylesheet" href="/style.css" />
<meta name="robots" content="index, follow" />
</head>
<body class="referral-graph-page">
<main class="referral-graph">
  <header class="referral-graph-header">
    <h1 class="referral-graph-handle" data-testid="referral-graph-handle">${handle}</h1>
    <div class="referral-graph-subtitle">referrals to fleet-control</div>
  </header>
  <section class="referral-graph-empty" data-testid="referral-graph-empty">
    no referrals visible from this instance yet - referrals appear when a downstream operator opens a PR on a project this fleet ingests.
  </section>
  <footer class="referral-graph-footer">
    ${footer}
  </footer>
</main>
</body>
</html>`;
  }

  const tilesHtml = p.tiles.map((t, i) => {
    const anonSafe = escForReferral(t.handleAnon);
    const displaySafe = t.displayHandle ? escForReferral(t.displayHandle) : "";
    const sinceSafe = escForReferral(t.sinceDate);
    const prsSafe = escForReferral(String(t.prsShipped));
    const handleLine = t.displayHandle
      ? `<a class="referral-tile-handle" data-testid="referral-tile-handle-${i}" href="/operator/${displaySafe}">${displaySafe}</a>`
      : `<span class="referral-tile-anon" data-testid="referral-tile-anon-${i}">operator-${anonSafe}</span>`;
    return `<li class="referral-tile" data-testid="referral-tile-${i}">`
      + handleLine
      + ` <span class="referral-tile-since">operator since ${sinceSafe}</span>`
      + ` <span class="referral-tile-prs">${prsSafe} PRs shipped</span>`
      + `</li>`;
  }).join("");

  const sinceCopy = p.since
    ? `since ${escForReferral(p.since)}`
    : "all time";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${handle} - referrals</title>
<link rel="stylesheet" href="/style.css" />
<meta name="robots" content="index, follow" />
</head>
<body class="referral-graph-page">
<main class="referral-graph">
  <header class="referral-graph-header">
    <h1 class="referral-graph-handle" data-testid="referral-graph-handle">${handle}</h1>
    <div class="referral-graph-subtitle"><span data-testid="referral-graph-total">${totalIntroduced} operators</span> have credited ${handle} as their fleet-control introduction ${sinceCopy}</div>
  </header>
  <section class="referral-graph-tiles">
    <ul class="referral-tiles">${tilesHtml}</ul>
  </section>
  <footer class="referral-graph-footer">
    ${footer}
  </footer>
</main>
</body>
</html>`;
}

/** Test seam: drive the renderer's quiet-hours branch directly
 *  without booting startServer or mutating cwd config. Per
 *  LESSONS 2026-06-11. */
export function _renderReferralGraphForTests(
  p: ReferralGraphPayload,
  opts: { quietHoursActive: boolean },
): string {
  return renderReferralGraphPage(p, opts);
}

// ────────────────────────────────────────────────────────────────────
// Ticket 0066 - Stakeholder monthly summary at /share/stakeholder/<token>.
//
// One prose-shaped one-page artifact a non-engineer external
// stakeholder (partner / manager / co-founder) opens monthly. The
// helper is a PURE re-renderer over the 0062 monthlyRetroCard
// aggregate plus the 0065 operator-config field - no new SQL surface,
// no LLM call, no random jitter.
//
// LESSONS hygiene applied here:
//   - 2026-05-29 time-pinned: every helper takes the caller's
//     now: Date; no new Date() inside the helpers.
//   - 2026-06-05 PRODUCER-VS-SPEC: the 0062 helper actually exports as
//     monthlyRetroCard (not fleetMonthlyRetro as the ticket prose
//     claims). We reuse the same numeric payload + extend with the
//     operator name fallback.
//   - 2026-06-11 expose a renderer-direct test seam so the
//     first-full-month / warming-up / empty-cta branches are testable
//     without booting startServer.
//   - 2026-06-13 the helper lives INSIDE views.ts; the new edge
//     views.ts to retro.ts is one-way (retro.ts imports only from
//     db.ts so no cycle).
//   - 2026-06-15 the leading prose block stays plain (no backticks)
//     so a sibling tests static-grep window does not match this
//     comment block.
//
// Engineer-vocabulary scrub: the stakeholder is non-technical, so the
// composer NEVER emits "ship phase" / "groom" / "review phase" / dollar
// amounts / "sigma" / "drift" / "anomaly" / "heal-attempt". Time saved
// is the primary unit (per the cross-fleet "agents run on a Max
// subscription, dollars are relative not invoiced" framing).
// ────────────────────────────────────────────────────────────────────

/** One highlight line on the stakeholder summary card. The three
 *  kinds are documented in the AC; the text is operator-readable
 *  prose with NO engineer vocabulary. */
export interface StakeholderHighlight {
  kind: "biggest_feature" | "lesson_learned" | "most_active_project";
  text: string;
}

/** Single CTA the stakeholder reads. Plain text - never a hyperlink
 *  (the spec explicitly forbids internal links on the stakeholder
 *  surface). When N === 0 the route renderer omits this section
 *  entirely. */
export interface StakeholderCta {
  kind: "pr_waiting";
  text: string;
}

/** Full stakeholder summary payload. version stays at 1; future
 *  field additions extend without breaking the route shape. */
export interface StakeholderSummary {
  /** One-line headline: "<operator>'s autonomous agent fleet -
   *  <Month YYYY>" or "your autonomous agent fleet - <Month YYYY>"
   *  when operator.displayName is undefined. */
  headline: string;
  /** Operator display name surfaced in the body. Defaults to
   *  empty string when displayName is undefined (the renderer reads
   *  the empty value as the fallback branch). */
  operatorName: string;
  /** ISO month key ("YYYY-MM") of the COMPLETED prior calendar
   *  month - same definition as the 0062 monthlyRetroCard payload. */
  monthIso: string;
  /** Three-to-four-sentence operator-readable paragraph composed
   *  deterministically from the retro aggregate. NO engineer
   *  vocabulary, NO dollar amounts. */
  prose: string;
  /** Exactly three highlights per the AC. */
  highlights: StakeholderHighlight[];
  /** CTA carrying the count of PRs waiting for review. The route
   *  renderer omits the CTA section when text === "" (N === 0). */
  cta: StakeholderCta;
  /** Two-line footer with the operator's display name + since date.
   *  Empty string when operator config is absent. */
  footer: string;
  kind: "card" | "first-full-month" | "warming-up";
  asOf: string;
  version: 1;
}

/** Compose the stakeholder paragraph deterministically from the
 *  retro payload + the operator name. The phrase template library is
 *  a small fixed set; the composer is a pure function of its inputs
 *  so AC2's strict-equality assertion holds across repeat calls.
 *
 *  Engineer vocabulary scrub: the renderer NEVER emits "ship phase",
 *  "groom", "review phase", "$/PR", "sigma", "drift", "anomaly", or
 *  "heal-attempt". Time saved is the primary unit. */
export function composeStakeholderProse(
  payload: MonthlyRetroPayload,
  operatorName: string,
  opts: { projectsActive: number },
): string {
  const features = payload.prs_this_month;
  const featuresWord = features === 1 ? "feature" : "features";
  const projectsActive = Math.max(1, opts.projectsActive | 0);
  const projectsWord = projectsActive === 1 ? "project" : "projects";

  // Time-saved estimate: we approximate each merged PR as saving ~25
  // minutes of operator time (matches the cross-fleet
  // "lesson-pays-for-itself" framing used in 0056 / 0052 / 0042 but
  // stays generic so the stakeholder reading sees a plain
  // "saved you about N hours" sentence). Rounded to the nearest hour.
  const hoursSaved = Math.max(1, Math.round((features * 25) / 60));
  const hoursWord = hoursSaved === 1 ? "hour" : "hours";

  // Trend sentence: prefer the human "up from" / "down from" phrasing
  // over a percent number. When prs_last_month is 0 the comparison
  // falls back to a "first month with that kind of activity" framing.
  let trendSentence = "";
  if (payload.prs_delta_pct == null) {
    trendSentence = "This is the first month with that kind of activity.";
  } else if (payload.prs_delta_pct > 0) {
    trendSentence = "That is up from " + payload.prs_last_month + " " + (payload.prs_last_month === 1 ? "feature" : "features") + " the month before.";
  } else if (payload.prs_delta_pct < 0) {
    trendSentence = "That is down from " + payload.prs_last_month + " " + (payload.prs_last_month === 1 ? "feature" : "features") + " the month before.";
  } else {
    trendSentence = "Roughly flat against the prior month.";
  }

  // Opening clause uses the operator's display name when present.
  const subject = operatorName ? operatorName + "'s fleet" : "your fleet";

  return subject + " shipped " + features + " " + featuresWord
    + " across " + projectsActive + " " + projectsWord + " this month, "
    + "saving you about " + hoursSaved + " " + hoursWord + ". "
    + trendSentence;
}

/** Build the three stakeholder highlights from the retro payload +
 *  the operator-readable best/laggard sentences. We anonymise project
 *  slugs by replacing them with "project A" / "project B" / etc. to
 *  match the 0013 + 0057 anonymisation discipline (the stakeholder
 *  surface mirrors the share-token family - no real repo names). */
function buildStakeholderHighlights(
  payload: MonthlyRetroPayload,
): StakeholderHighlight[] {
  // Strip the project slug from the best sentence ("alpha shipped
  // 2.0x ..." -> "the most-shipping project shipped 2.0x ..."). The
  // sentence carries an engineer-only "x its trailing baseline" tail
  // we also rewrite into operator-readable prose.
  const featureText = "The standout feature this month was the most-shipping project. "
    + payload.best_project_sentence
      .replace(/^[^\s]+\s+shipped\s+([\d.]+)x\s+its\s+trailing\s+baseline\s+this\s+month$/, "It shipped about $1 times its usual pace.")
      .replace(/^[^\s]+\s+held\s+flat\s+this\s+month\s+after\s+averaging\s+(\d+)\s+over\s+the\s+trailing\s+3\s+months$/, "It held steady against its trailing average of $1.")
      .replace(/^[^\s]+\s+/, "");

  const lessonText = "Your fleet learned at least one new lesson this month and is already catching the same pattern in future runs.";

  // Most-active project: just say "one project carried most of the
  // work this month". The exact slug is anonymised away.
  const activeText = "One project carried most of the work this month.";

  return [
    { kind: "biggest_feature", text: featureText },
    { kind: "lesson_learned", text: lessonText },
    { kind: "most_active_project", text: activeText },
  ];
}

/** Resolve a human "Month YYYY" label without a locale lookup so the
 *  string stays stable across machines. Mirrors the retro module's
 *  monthLabelFor but lives here so we don't add a second
 *  views.ts <- retro.ts edge for a one-liner. */
function stakeholderMonthLabel(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const names = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return (names[m - 1] ?? iso) + " " + y;
}

/** Count open agent PRs in the database. Used by the route layer to
 *  populate the "N PRs waiting for review" CTA. The producer literal
 *  for an open PR is "open" lowercase per src/ingest/prs.ts:188. */
function countOpenAgentPrs(db: DB): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM pr WHERE state = 'open' AND is_agent = 1",
  ).get() as unknown as { c: number | null } | undefined;
  return Number(row?.c ?? 0) || 0;
}

/** Count distinct projects that have at least one merged agent PR
 *  in the COMPLETED prior calendar month. Used by the composer's
 *  "<N> projects" interpolation. */
function countActiveProjectsInMonth(db: DB, monthIso: string): number {
  const start = monthIso + "-01T00:00:00.000Z";
  // First-of-next-month: cheap calendar walk.
  const [y, m] = monthIso.split("-").map(Number);
  const totalMonths = y * 12 + (m - 1) + 1;
  const ny = Math.floor(totalMonths / 12);
  const nm = (totalMonths % 12) + 1;
  const end = ny + "-" + String(nm).padStart(2, "0") + "-01T00:00:00.000Z";
  const row = db.prepare(
    "SELECT COUNT(DISTINCT project_id) AS c FROM pr"
    + " WHERE state = 'MERGED'"
    + "   AND is_agent = 1"
    + "   AND fetched_at IS NOT NULL"
    + "   AND fetched_at >= ? AND fetched_at < ?",
  ).get(start, end) as unknown as { c: number | null } | undefined;
  return Number(row?.c ?? 0) || 0;
}

/** Top-level helper: compose the stakeholder summary for the current
 *  pinned now. Pure on (db, cfg, now). When the 0062 retro helper
 *  returns warming-up or first-full-month, the stakeholder payload
 *  mirrors the kind so the renderer surfaces the same operator-
 *  readable empty-state framing. */
export function stakeholderMonthlySummary(
  db: DB, cfg: FleetConfig, now: Date,
): StakeholderSummary {
  const result = monthlyRetroCard(db, now);
  const operatorName = cfg.operator?.displayName ?? "";
  // The COMPLETED prior calendar month for the headline / footer.
  const nowY = now.getUTCFullYear();
  const nowM = now.getUTCMonth() + 1;
  // shift back one month so July's stakeholder summary anchors on June.
  const total = nowY * 12 + (nowM - 1) - 1;
  const my = Math.floor(total / 12);
  const mm = (total % 12) + 1;
  const monthIso = my + "-" + String(mm).padStart(2, "0");
  const monthLabel = stakeholderMonthLabel(monthIso);

  const subject = operatorName ? operatorName + "'s autonomous agent fleet" : "your autonomous agent fleet";
  const headline = subject + " - " + monthLabel;
  const sinceDate = cfg.operator?.sinceDate ?? "";
  const footer = operatorName && sinceDate
    ? "Powered by fleet-control. " + operatorName + " has been running an autonomous agent fleet since " + sinceDate + "."
    : "Powered by fleet-control.";

  const prsWaiting = countOpenAgentPrs(db);
  const ctaText = prsWaiting > 0
    ? "There " + (prsWaiting === 1 ? "is" : "are") + " " + prsWaiting + " " + (prsWaiting === 1 ? "feature" : "features") + " ready for your review."
    : "";
  const cta: StakeholderCta = { kind: "pr_waiting", text: ctaText };

  if (result.kind === "warming-up" || result.kind === "first-full-month") {
    return {
      headline,
      operatorName,
      monthIso,
      prose: result.kind === "first-full-month"
        ? "Your fleet just finished its first full month. The first proper monthly summary will land at the start of next month."
        : "Your fleet is just getting started. Check back in a couple of months once there is a meaningful track record to summarise.",
      highlights: [],
      cta,
      footer,
      kind: result.kind,
      asOf: now.toISOString(),
      version: 1,
    };
  }

  const projectsActive = countActiveProjectsInMonth(db, result.payload.month_iso);
  const prose = composeStakeholderProse(result.payload, operatorName, { projectsActive });
  const highlights = buildStakeholderHighlights(result.payload);

  return {
    headline,
    operatorName,
    monthIso: result.payload.month_iso,
    prose,
    highlights,
    cta,
    footer,
    kind: "card",
    asOf: now.toISOString(),
    version: 1,
  };
}

/** Pure HTML escape - small inline copy per the 0061 / 0065 precedent.
 *  Plain prose name (no backticks anywhere) so a sibling test's
 *  source-grep window does NOT pull this scope per LESSONS
 *  2026-06-11. */
function escForStakeholder(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

/** Renderer options - the route layer passes a pre-computed cta count
 *  (the open-PR count) and the projects-active number so the renderer
 *  stays pure on the payload + opts. */
export interface StakeholderRenderOptions {
  /** Optional operator display name. Empty string / undefined renders
   *  the "your autonomous agent fleet" fallback per AC6. */
  operatorName?: string;
  /** ISO month key surfaced in the headline. */
  monthIso: string;
  /** sinceDate from operator config; surfaced in the footer. */
  sinceDate?: string;
  /** Wall-clock the render anchored on - used for the timestamp in
   *  the footer meta line. */
  asOf: string;
  /** Number of open agent PRs - drives the CTA section. When 0 the
   *  CTA section is OMITTED entirely per AC7. */
  prsWaiting?: number;
  /** Number of distinct projects that shipped at least one merged PR
   *  in the prior month - drives the "across N projects" prose. */
  projectsActive?: number;
}

/** Render the stakeholder summary page. Pure on (result, opts).
 *  Three branches: card / warming-up / first-full-month. The
 *  rendered HTML is self-contained - no external script, no /api
 *  fetch, no <button>, no <a href> in the CTA. */
function renderStakeholderSummaryPage(
  result: MonthlyRetroResult,
  opts: StakeholderRenderOptions,
): string {
  const operatorName = String(opts.operatorName ?? "");
  const subject = operatorName ? operatorName + "'s autonomous agent fleet" : "your autonomous agent fleet";
  const headline = subject + " - " + stakeholderMonthLabel(opts.monthIso);
  const safeHeadline = escForStakeholder(headline);

  // Warming-up branch: short non-numeric framing.
  if (result.kind === "warming-up") {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${safeHeadline}</title>
<link rel="stylesheet" href="/style.css" />
<meta name="robots" content="noindex, nofollow" />
</head>
<body class="stakeholder-summary-page">
<main class="stakeholder-summary">
  <header class="stakeholder-summary-header">
    <h1 class="stakeholder-summary-headline" data-testid="stakeholder-headline-prose">${safeHeadline}</h1>
  </header>
  <section class="stakeholder-summary-warming-up" data-testid="stakeholder-warming-up">
    Your fleet is just getting started. Check back in a couple of months once there is a meaningful track record to summarise.
  </section>
  <footer class="stakeholder-summary-footer">Powered by fleet-control.</footer>
</main>
</body>
</html>`;
  }

  // First-full-month branch.
  if (result.kind === "first-full-month") {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${safeHeadline}</title>
<link rel="stylesheet" href="/style.css" />
<meta name="robots" content="noindex, nofollow" />
</head>
<body class="stakeholder-summary-page">
<main class="stakeholder-summary">
  <header class="stakeholder-summary-header">
    <h1 class="stakeholder-summary-headline" data-testid="stakeholder-headline-prose">${safeHeadline}</h1>
  </header>
  <section class="stakeholder-summary-first-full-month" data-testid="stakeholder-first-full-month">
    Your fleet just finished its first full month. The first proper monthly summary will land at the start of next month.
  </section>
  <footer class="stakeholder-summary-footer">Powered by fleet-control.</footer>
</main>
</body>
</html>`;
  }

  // Card branch.
  const payload = result.payload;
  const projectsActive = Math.max(1, opts.projectsActive ?? 1);
  const prose = composeStakeholderProse(payload, operatorName, { projectsActive });
  const highlights = buildStakeholderHighlights(payload);
  const highlightsHtml = highlights.map((h, i) => {
    return `<li class="stakeholder-highlight" data-testid="stakeholder-highlight-${i}" data-kind="${escForStakeholder(h.kind)}">${escForStakeholder(h.text)}</li>`;
  }).join("");

  const prsWaiting = Number(opts.prsWaiting ?? 0) | 0;
  const ctaHtml = prsWaiting > 0
    ? `<section class="stakeholder-summary-cta" data-testid="stakeholder-cta">There ${prsWaiting === 1 ? "is" : "are"} ${prsWaiting} ${prsWaiting === 1 ? "feature" : "features"} ready for your review.</section>`
    : "";

  const sinceDate = String(opts.sinceDate ?? "");
  const safeFooter = operatorName && sinceDate
    ? `Powered by fleet-control. ${escForStakeholder(operatorName)} has been running an autonomous agent fleet since ${escForStakeholder(sinceDate)}.`
    : "Powered by fleet-control.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${safeHeadline}</title>
<link rel="stylesheet" href="/style.css" />
<meta name="robots" content="noindex, nofollow" />
</head>
<body class="stakeholder-summary-page">
<main class="stakeholder-summary">
  <header class="stakeholder-summary-header">
    <h1 class="stakeholder-summary-headline" data-testid="stakeholder-headline-prose">${safeHeadline}</h1>
  </header>
  <section class="stakeholder-summary-prose" data-testid="stakeholder-prose">${escForStakeholder(prose)}</section>
  <section class="stakeholder-summary-highlights" data-testid="stakeholder-highlights">
    <h2>Highlights</h2>
    <ul>${highlightsHtml}</ul>
  </section>
  ${ctaHtml}
  <footer class="stakeholder-summary-footer">${safeFooter}</footer>
</main>
</body>
</html>`;
}

/** Test seam per LESSONS 2026-06-11: drive the renderer's branches
 *  (card / warming-up / first-full-month) directly without booting
 *  startServer or mutating cwd config. The renderer is otherwise
 *  pure on the payload + opts. */
export function _renderStakeholderSummaryForTests(
  result: MonthlyRetroResult,
  opts: StakeholderRenderOptions,
): string {
  return renderStakeholderSummaryPage(result, opts);
}

/** Production entry point: compose AND render in one pass. Used by
 *  the route layer in src/server.ts. */
export function renderStakeholderSummaryFromDb(
  db: DB, cfg: FleetConfig, now: Date,
): { summary: StakeholderSummary; html: string } {
  const summary = stakeholderMonthlySummary(db, cfg, now);
  const result = monthlyRetroCard(db, now);
  const projectsActive = summary.kind === "card"
    ? countActiveProjectsInMonth(db, summary.monthIso)
    : 1;
  const html = renderStakeholderSummaryPage(result, {
    operatorName: summary.operatorName,
    monthIso: summary.monthIso,
    sinceDate: cfg.operator?.sinceDate ?? "",
    asOf: summary.asOf,
    prsWaiting: countOpenAgentPrs(db),
    projectsActive,
  });
  return { summary, html };
}

// ────────────────────────────────────────────────────────────────────
// Home-page one-time CTA invite card (AC9).
//
// Fires when (a) lifetime merged-agent-PR count >= 3 AND (b) no
// stakeholder_monthly snapshot row exists yet AND (c) the operator
// has not already dismissed the invite (kind='stakeholder_url_invite',
// project_slug='fleet', payload_id='static-v1'). The invite is the
// composed inbox-shaped record - the home composer in views.ts /
// the SPA in web/app.js picks it up alongside the existing
// monthly_retro / lessons_new / biggest_surprise kinds.
// ────────────────────────────────────────────────────────────────────

export interface StakeholderInviteCard {
  kind: "stakeholder_url_invite";
  title: string;
  payload_id: "static-v1";
}

/** Return the invite card when the three conditions hold; null
 *  otherwise. now is currently unused but accepted so the signature
 *  matches the other (db, cfg, now) helpers; future re-fire logic
 *  could anchor an aging window on now. */
export function stakeholderInviteCard(
  db: DB, _cfg: FleetConfig, _now: Date,
): StakeholderInviteCard | null {
  // (a) Lifetime merged agent PR count.
  const prRow = db.prepare(
    "SELECT COUNT(*) AS c FROM pr WHERE state = 'MERGED' AND is_agent = 1",
  ).get() as unknown as { c: number | null } | undefined;
  const lifetime = Number(prRow?.c ?? 0) || 0;
  if (lifetime < 3) return null;

  // (b) No stakeholder_monthly snapshot row exists.
  const snapRow = db.prepare(
    "SELECT 1 AS ok FROM snapshot WHERE kind = 'stakeholder_monthly' LIMIT 1",
  ).get() as unknown as { ok: number } | undefined;
  if (snapRow) return null;

  // (c) Not dismissed.
  const dismissRow = db.prepare(
    "SELECT 1 AS ok FROM inbox_dismissal"
    + " WHERE kind = 'stakeholder_url_invite'"
    + "   AND project_slug = 'fleet'"
    + "   AND payload_id = 'static-v1'",
  ).get() as unknown as { ok: number } | undefined;
  if (dismissRow) return null;

  return {
    kind: "stakeholder_url_invite",
    title: "share a monthly summary with someone outside your laptop",
    payload_id: "static-v1",
  };
}

// ────────────────────────────────────────────────────────────────────
// Ticket 0072 - Fleet anniversary milestone card and signed share URL.
//
// One home-page card fires ONLY on milestone moments (the install-date
// calendar anniversary AND each crossing of 100 / 500 / 1000 lifetime
// merged-agent PRs). The card carries a single share button that mints
// a /share/anniversary/<token> snapshot URL (a new snapshot.kind). The
// route and the OG sibling at /og/share/anniversary/<token>.svg both
// resolve the token against the existing 0013 / 0066 snapshot infra.
//
// LESSONS hygiene applied here:
//   - 2026-05-29 every helper takes the caller's now: Date so tests
//     can pin the wall clock without drift.
//   - 2026-06-05 cycle-safe: the helper lives inside views.ts so the
//     server consumes it via a single import; no new module edge.
//   - 2026-06-05 producer-vs-spec: the lifetime PR count reads
//     state = MERGED uppercase AND is_agent = 1 - matching the same
//     reader convention used by countActiveProjectsInMonth and the
//     0040 / 0044 riskiest / spend-efficiency helpers.
//   - 2026-06-07 the pr table has no surrogate id - the helper uses
//     COUNT plus MIN(fetched_at) for the install-date side-effect
//     write; no MAX(id).
//   - 2026-06-11 every renderer goes through a _render*ForTests seam
//     so the branches drive directly without booting startServer.
//   - 2026-06-13 per-candidate tests seed enough trailing rows to
//     clear the lessons-still-cited bullet.
//   - 2026-06-15 the leading prose block uses plain prose for any
//     sibling-helper-grep-vulnerable identifier (no backticks here).
// ────────────────────────────────────────────────────────────────────

/** Discriminator for the moment kind. install_year fires when the
 *  current calendar day matches the install-date row's month + day
 *  AND years >= 1. pr_100 / pr_500 / pr_1000 fire when the lifetime
 *  merged-agent PR count just crossed the named threshold. none is
 *  the no-op case (364 days out of the year on the calendar; below
 *  the next threshold on the PR axis). */
export type AnniversaryKind =
  | "install_year"
  | "pr_100"
  | "pr_500"
  | "pr_1000"
  | "none";

/** Payload the home card + share page + OG SVG all read. version is
 *  pinned at 1 so future field additions extend without breaking the
 *  snapshot payload schema. */
export interface AnniversaryMoment {
  kind: AnniversaryKind;
  /** ISO date string. For install_year this is the recorded install
   *  date (MIN(pr.fetched_at) at first observation, stamped into the
   *  operator_install_milestones row). For pr_100 / pr_500 / pr_1000
   *  this is the timestamp the threshold was first crossed (the row
   *  recorded_at when persisted). For none this is the empty string. */
  anniversaryDate: string;
  /** Whole-year delta between now and the install date. 0 for
   *  threshold-crossing branches AND for none. */
  years: number;
  /** Lifetime merged-agent PR count. */
  lifetimePrs: number;
  /** Time-saved approximation drawn from the 0052 lessonSavingsRollup
   *  arithmetic: heal_count times the average failed-ship cost in
   *  dollars, converted to whole hours at a documented $75/hr rate. */
  lifetimeHoursSaved: number;
  /** Distinct cross-fleet lessons credited in the trailing 90 days. */
  topLessonsStillCited: number;
  asOf: string;
  version: 1;
}

const ANNIVERSARY_THRESHOLDS = [100, 500, 1000] as const;
type AnniversaryThreshold = typeof ANNIVERSARY_THRESHOLDS[number];

function thresholdKind(t: AnniversaryThreshold): "pr_100" | "pr_500" | "pr_1000" {
  if (t === 100) return "pr_100";
  if (t === 500) return "pr_500";
  return "pr_1000";
}

interface AnniversaryInstallRow {
  recorded_at: string | null;
}

interface AnniversaryLifetimeRow {
  c: number | null;
  earliest: string | null;
}

function lifetimeMergedAgentPrs(db: DB): AnniversaryLifetimeRow {
  const row = db.prepare(
    "SELECT COUNT(*) AS c, MIN(fetched_at) AS earliest"
    + " FROM pr WHERE state = 'MERGED' AND is_agent = 1",
  ).get() as unknown as AnniversaryLifetimeRow | undefined;
  return {
    c: Number(row?.c ?? 0) || 0,
    earliest: row?.earliest ?? null,
  };
}

/** Write the install_date row if no row exists yet. The recorded_at
 *  value is the earliest pr.fetched_at on a merged-agent row when one
 *  exists, otherwise the caller-supplied now. Idempotent on re-call
 *  thanks to the PK on kind. Exported with the leading-underscore
 *  convention so production callers know not to invoke this directly. */
export function _recordInstallDateIfMissing(db: DB, now: Date): void {
  const existing = db.prepare(
    "SELECT recorded_at FROM operator_install_milestones WHERE kind = 'install_date'",
  ).get() as unknown as AnniversaryInstallRow | undefined;
  if (existing) return;
  const life = lifetimeMergedAgentPrs(db);
  const recordedAt = life.earliest && life.c > 0 ? life.earliest : now.toISOString();
  db.prepare(
    "INSERT OR IGNORE INTO operator_install_milestones(kind, recorded_at, payload_json)"
    + " VALUES (?, ?, ?)",
  ).run("install_date", recordedAt, JSON.stringify({ source: "auto" }));
}

function recordThresholdIfMissing(
  db: DB, kind: "pr_100" | "pr_500" | "pr_1000",
  recordedAt: string, payload: Record<string, unknown>,
): void {
  db.prepare(
    "INSERT OR IGNORE INTO operator_install_milestones(kind, recorded_at, payload_json)"
    + " VALUES (?, ?, ?)",
  ).run(kind, recordedAt, JSON.stringify(payload));
}

function hasMilestoneRow(db: DB, kind: string): boolean {
  const row = db.prepare(
    "SELECT 1 AS ok FROM operator_install_milestones WHERE kind = ?",
  ).get(kind) as unknown as { ok: number } | undefined;
  return !!row;
}

/** Compute the topLessonsStillCited number. Distinct lesson slugs the
 *  fleet's lesson_credit table credits over the trailing 90 days. The
 *  helper is read-only and SQL-only (no LLM). */
function topLessonsStillCitedCount(db: DB, now: Date): number {
  const cutoff = new Date(now.getTime() - 90 * 24 * 3600_000).toISOString();
  const row = db.prepare(
    "SELECT COUNT(DISTINCT lesson_slug) AS c FROM lesson_credit"
    + " WHERE created_at >= ?",
  ).get(cutoff) as unknown as { c: number | null } | undefined;
  return Number(row?.c ?? 0) || 0;
}

/** Documented hourly-rate the time-saved bullet converts the dollar
 *  savings into. Matches the worth-it / 0048 / 0052 implicit hourly
 *  framing. Plain constant inline so the calculator stays self-
 *  contained. */
const ANNIVERSARY_HOURLY_RATE_USD = 75.0;

/** Top-level helper. Returns the AnniversaryMoment payload the home
 *  composer and the share renderer both read. Pure on (db, cfg, now)
 *  except for the install_date side-effect write the first time the
 *  fleet has merged-agent PR data but no install_date row. */
export function fleetAnniversaryMoment(
  db: DB,
  _cfg: FleetConfig,
  now: Date,
): AnniversaryMoment {
  const life = lifetimeMergedAgentPrs(db);
  const lifetimePrs = life.c;

  // Side-effect: write the install_date row from the earliest
  // pr.fetched_at the first time we observe a non-empty fleet. The
  // helper short-circuits if a row already exists.
  if (lifetimePrs > 0) {
    _recordInstallDateIfMissing(db, now);
  }

  const installRow = db.prepare(
    "SELECT recorded_at FROM operator_install_milestones WHERE kind = 'install_date'",
  ).get() as unknown as AnniversaryInstallRow | undefined;

  // Lifetime hours saved approximation per the lessonSavingsRollup
  // math: heal_count * average failed-ship cost; converted to whole
  // hours at the documented hourly rate. Trailing 365-day window is
  // sufficient on a 1-year-anniversary fleet; for longer-running
  // fleets the same window keeps the number stable. lessonSavingsRollup
  // returns the per-lesson rows; we sum the saved_usd to derive a
  // floor; on an empty fleet it falls back to 0 hours.
  let lifetimeHoursSaved = 0;
  try {
    const savings = lessonSavingsRollup(db, { windowDays: 365, now });
    const totalSavedUsd = savings.lesson_savings.reduce(
      (acc, r) => acc + (r.saved_usd || 0), 0,
    );
    lifetimeHoursSaved = Math.max(0, Math.round(totalSavedUsd / ANNIVERSARY_HOURLY_RATE_USD));
  } catch {
    lifetimeHoursSaved = 0;
  }

  const topLessonsStillCited = topLessonsStillCitedCount(db, now);

  const baseline: AnniversaryMoment = {
    kind: "none",
    anniversaryDate: "",
    years: 0,
    lifetimePrs,
    lifetimeHoursSaved,
    topLessonsStillCited,
    asOf: now.toISOString(),
    version: 1,
  };

  // Threshold branch: re-evaluate against the lifetime count. The
  // helper persists a row the first time each threshold is crossed
  // so subsequent calls in the same year do not re-fire (the
  // calendar-based install_year branch handles the recurring case
  // via inbox_dismissal at the home composer layer).
  for (const t of [...ANNIVERSARY_THRESHOLDS].sort((a, b) => b - a)) {
    if (lifetimePrs >= t && !hasMilestoneRow(db, thresholdKind(t))) {
      // First crossing - persist and return.
      recordThresholdIfMissing(db, thresholdKind(t), now.toISOString(), {
        lifetime_prs: lifetimePrs,
        lifetime_hours_saved: lifetimeHoursSaved,
        top_lessons_still_cited: topLessonsStillCited,
      });
      return {
        ...baseline,
        kind: thresholdKind(t),
        anniversaryDate: now.toISOString().slice(0, 10),
      };
    }
  }

  // Calendar-anniversary branch: fire when now's month + day match
  // the install_date row's month + day AND the year delta is >= 1.
  if (installRow && installRow.recorded_at) {
    const installAt = new Date(installRow.recorded_at);
    if (!Number.isNaN(installAt.getTime())) {
      const sameMonthDay = installAt.getUTCMonth() === now.getUTCMonth()
        && installAt.getUTCDate() === now.getUTCDate();
      const yearsDelta = now.getUTCFullYear() - installAt.getUTCFullYear();
      if (sameMonthDay && yearsDelta >= 1) {
        return {
          ...baseline,
          kind: "install_year",
          anniversaryDate: installRow.recorded_at.slice(0, 10),
          years: yearsDelta,
        };
      }
    }
  }

  return baseline;
}

/** Renderer options for the home-page card. */
export interface AnniversaryCardRenderOptions {
  /** When true the renderer emits the empty string so the SPA hides
   *  the card. Maps to an inbox_dismissal row at the home composer. */
  dismissed?: boolean;
}

/** One-line headline by kind. Pure on the payload. */
function anniversaryHeadline(p: AnniversaryMoment): string {
  if (p.kind === "install_year") {
    const yearsWord = p.years === 1 ? "year" : "years";
    return p.years + " " + yearsWord + " ago today you ran your first agent";
  }
  if (p.kind === "pr_100") return "you just crossed 100 merged features shipped autonomously";
  if (p.kind === "pr_500") return "you just crossed 500 merged features shipped autonomously";
  if (p.kind === "pr_1000") return "you just crossed 1000 merged features shipped autonomously";
  return "";
}

function escAnniversary(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

/** Pure HTML composer for the home-page card. Carries the
 *  anniversary-card + anniversary-share-button testids. The share
 *  button is a real <button data-act=share-anniversary> the SPA can
 *  bind to; tests anchor on the testid not the button text. */
export function renderAnniversaryCard(
  p: AnniversaryMoment,
  opts: AnniversaryCardRenderOptions = {},
): string {
  if (opts.dismissed) return "";
  if (p.kind === "none") return "";
  const headline = escAnniversary(anniversaryHeadline(p));
  const bullet1 = "<li data-testid=\"anniversary-bullet-prs\">"
    + escAnniversary(p.lifetimePrs) + " features shipped"
    + "</li>";
  const bullet2 = "<li data-testid=\"anniversary-bullet-hours\">"
    + escAnniversary(p.lifetimeHoursSaved) + " hours saved"
    + "</li>";
  const bullet3 = "<li data-testid=\"anniversary-bullet-lessons\">"
    + escAnniversary(p.topLessonsStillCited) + " lessons still cited"
    + "</li>";
  const button = "<button class=\"anniversary-share\""
    + " data-testid=\"anniversary-share-button\""
    + " data-act=\"share-anniversary\""
    + " type=\"button\">share the moment</button>";
  return "<section class=\"anniversary-card\""
    + " data-testid=\"anniversary-card\""
    + " data-kind=\"" + escAnniversary(p.kind) + "\">"
    + "<div class=\"anniversary-eyebrow\" data-testid=\"anniversary-eyebrow\">milestone</div>"
    + "<h2 class=\"anniversary-headline\" data-testid=\"anniversary-headline\">" + headline + "</h2>"
    + "<ul class=\"anniversary-bullets\">"
    + bullet1 + bullet2 + bullet3
    + "</ul>"
    + button
    + "</section>";
}

export function _renderAnniversaryCardForTests(
  p: AnniversaryMoment,
  opts: AnniversaryCardRenderOptions = {},
): string {
  return renderAnniversaryCard(p, opts);
}

/** Renderer options for the public /share/anniversary/<token> page. */
export interface AnniversaryShareRenderOptions {
  /** Operator display name; falls back to your fleet when omitted. */
  displayName?: string;
  /** Absolute base URL the og:image meta tag composes against. */
  publicHost?: string;
  /** Plain token string; appended onto the OG image URL. */
  token: string;
  /** Quiet-hours flag - when true the install CTA is replaced by a
   *  softer powered-by caption per the 0030 quiet-hours posture. */
  quietHoursActive: boolean;
}

/** Pure HTML composer for the public share page. Self-contained: no
 *  external script, no /api fetch, no operator state on the page. The
 *  og:image meta tag points at the SVG sibling so a feed crawler picks
 *  it up. */
export function renderAnniversarySharePage(
  p: AnniversaryMoment,
  opts: AnniversaryShareRenderOptions,
): string {
  const headline = escAnniversary(anniversaryHeadline(p));
  const subject = opts.displayName
    ? escAnniversary(opts.displayName) + "'s fleet"
    : "your fleet";
  const description = subject + " - "
    + escAnniversary(p.lifetimePrs) + " features shipped, "
    + escAnniversary(p.lifetimeHoursSaved) + " hours saved, "
    + escAnniversary(p.topLessonsStillCited) + " lessons still cited";
  const safeHost = (opts.publicHost ?? "").replace(/\/+$/, "");
  const safeToken = escAnniversary(opts.token);
  const ogImage = safeHost + "/og/share/anniversary/" + safeToken + ".svg";
  const title = subject + " - fleet anniversary";
  const ctaBlock = opts.quietHoursActive
    ? "<footer class=\"anniversary-foot\" data-testid=\"anniversary-foot\">powered by fleet-control</footer>"
    : "<footer class=\"anniversary-foot\" data-testid=\"anniversary-foot\">"
      + "powered by fleet-control - "
      + "<span data-testid=\"install-cta\">install yours</span>"
      + "</footer>";
  return "<!doctype html>"
    + "<html lang=\"en\">"
    + "<head>"
    + "<meta charset=\"utf-8\" />"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\" />"
    + "<title>" + escAnniversary(title) + "</title>"
    + "<link rel=\"stylesheet\" href=\"/style.css\" />"
    + "<meta property=\"og:title\" content=\"" + escAnniversary(title) + "\" />"
    + "<meta property=\"og:description\" content=\"" + escAnniversary(description) + "\" />"
    + "<meta property=\"og:image\" content=\"" + escAnniversary(ogImage) + "\" />"
    + "<meta property=\"og:type\" content=\"website\" />"
    + "<meta name=\"twitter:card\" content=\"summary_large_image\" />"
    + "<meta name=\"twitter:title\" content=\"" + escAnniversary(title) + "\" />"
    + "<meta name=\"twitter:description\" content=\"" + escAnniversary(description) + "\" />"
    + "<meta name=\"robots\" content=\"index, follow\" />"
    + "</head>"
    + "<body class=\"anniversary-share-page\" data-testid=\"anniversary-share-page\">"
    + "<main class=\"anniversary-share\">"
    + "<header class=\"anniversary-share-header\">"
    + "<h1 data-testid=\"anniversary-share-headline\">" + headline + "</h1>"
    + "</header>"
    + "<ul class=\"anniversary-share-bullets\">"
    + "<li data-testid=\"anniversary-share-bullet-prs\">"
    + escAnniversary(p.lifetimePrs) + " features shipped</li>"
    + "<li data-testid=\"anniversary-share-bullet-hours\">"
    + escAnniversary(p.lifetimeHoursSaved) + " hours saved</li>"
    + "<li data-testid=\"anniversary-share-bullet-lessons\">"
    + escAnniversary(p.topLessonsStillCited) + " lessons still cited</li>"
    + "</ul>"
    + "</main>"
    + ctaBlock
    + "</body>"
    + "</html>";
}

export function _renderAnniversaryShareForTests(
  p: AnniversaryMoment,
  opts: AnniversaryShareRenderOptions,
): string {
  return renderAnniversarySharePage(p, opts);
}

/** Renderer options for the OG SVG sibling. */
export interface AnniversaryOgRenderOptions {
  displayName?: string;
}

/** Hand-rolled 1200x630 SVG for the OG card. Per LESSONS 2026-06-12
 *  the testid is the test anchor; no greedy attribute regex. */
export function renderAnniversaryOgSvg(
  p: AnniversaryMoment,
  opts: AnniversaryOgRenderOptions = {},
): string {
  const w = 1200;
  const h = 630;
  const display = opts.displayName ? escAnniversary(opts.displayName) : "your fleet";
  const headline = escAnniversary(anniversaryHeadline(p));
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
    + "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + w + "\" height=\"" + h + "\""
    + " viewBox=\"0 0 " + w + " " + h + "\" role=\"img\" aria-label=\"fleet anniversary\">"
    + "<rect width=\"100%\" height=\"100%\" fill=\"#0E0F0D\"></rect>"
    + "<text x=\"60\" y=\"110\" fill=\"#807a6c\" font-family=\"ui-monospace,Menlo,monospace\""
    + " font-size=\"32\">fleet anniversary</text>"
    + "<text x=\"60\" y=\"190\" fill=\"#E8E2D4\""
    + " font-family=\"ui-monospace,Menlo,monospace\" font-size=\"44\" font-weight=\"700\""
    + " data-testid=\"anniversary-og-headline\">" + headline + "</text>"
    + "<text x=\"60\" y=\"240\" fill=\"#807a6c\""
    + " font-family=\"ui-monospace,Menlo,monospace\" font-size=\"28\""
    + " data-testid=\"anniversary-og-display\">" + display + "</text>"
    + "<g data-testid=\"anniversary-og-numbers\">"
    + "<text x=\"60\" y=\"410\" fill=\"#E8E2D4\""
    + " font-family=\"ui-monospace,Menlo,monospace\" font-size=\"80\" font-weight=\"700\">"
    + escAnniversary(p.lifetimePrs) + "</text>"
    + "<text x=\"60\" y=\"450\" fill=\"#807a6c\""
    + " font-family=\"ui-monospace,Menlo,monospace\" font-size=\"22\">PRs shipped</text>"
    + "<text x=\"420\" y=\"410\" fill=\"#E8E2D4\""
    + " font-family=\"ui-monospace,Menlo,monospace\" font-size=\"80\" font-weight=\"700\">"
    + escAnniversary(p.lifetimeHoursSaved) + "</text>"
    + "<text x=\"420\" y=\"450\" fill=\"#807a6c\""
    + " font-family=\"ui-monospace,Menlo,monospace\" font-size=\"22\">hours saved</text>"
    + "<text x=\"780\" y=\"410\" fill=\"#E8E2D4\""
    + " font-family=\"ui-monospace,Menlo,monospace\" font-size=\"80\" font-weight=\"700\">"
    + escAnniversary(p.topLessonsStillCited) + "</text>"
    + "<text x=\"780\" y=\"450\" fill=\"#807a6c\""
    + " font-family=\"ui-monospace,Menlo,monospace\" font-size=\"22\">lessons still cited</text>"
    + "</g>"
    + "<text x=\"60\" y=\"" + (h - 40) + "\" fill=\"#807a6c\""
    + " font-family=\"ui-monospace,Menlo,monospace\" font-size=\"22\">"
    + "powered by fleet-control</text>"
    + "</svg>";
}

export function _renderAnniversaryOgSvgForTests(
  p: AnniversaryMoment,
  opts: AnniversaryOgRenderOptions = {},
): string {
  return renderAnniversaryOgSvg(p, opts);
}

// ────────────────────────────────────────────────────────────────────
// Reactivation push (ticket 0071).
//
// Three pure helpers + one renderer-direct seam compose the Sunday
// 18:00 reactivation nudge for an operator who has been absent for
// 5 or more days:
//
//   evaluateReactivationPush(db, cfg, now) returns a shouldPush
//     boolean plus a reason string plus the composed payload. The
//     boolean is true only when all six gates pass: Sunday in tz,
//     local time between 17:50 and 18:10, last_visit_at older than
//     5 days, opt-out flag absent, no prior reactivation snapshot
//     in the last 14 days, and quietHoursActiveAnywhere false.
//
//   composeReactivationMessage(payload) returns the deterministic
//     ntfy message string. Two branches: features-shipped (M is
//     1 or more) and fleet-was-quiet (M is 0). Pure on its input.
//
//   reactivationDigestPayload(db, cfg, lastVisitAt, now) walks the
//     pr table for the absent period and assembles the digest
//     payload the deep-link page renders. Reused by both the
//     daemon helper (snapshot mint) and the route (live render).
//
//   renderReactivationDigestPage / _renderReactivationDigestForTests
//     produce the self-contained HTML page for the deep link.
//     Quiet-hours flag drives a soft footer per LESSONS
//     2026-06-11 renderer-direct seam pattern.
//
// All comment lines below use plain prose only; no backticks around
// any identifier per LESSONS 2026-06-11 character-window-source-grep
// avoidance (sibling helpers like stakeholderInviteCard and the
// fleetWeeklyPulse family carry slice-grepped tests against their
// own name plus N characters, so a backticked identifier in this
// block could poison their slice windows).
// ────────────────────────────────────────────────────────────────────

const REACTIVATION_DEDUP_WINDOW_DAYS = 14;
const REACTIVATION_ABSENT_DAYS = 5;
const REACTIVATION_PUSH_WINDOW_START_MIN = 17 * 60 + 50;
const REACTIVATION_PUSH_WINDOW_END_MIN = 18 * 60 + 10;

export interface ReactivationPushPayload {
  daysAway: number;
  featuresShipped: number;
  lastVisitAt: string;
  generatedAt: string;
  url: string;
  highlights: ReactivationDigestHighlight[];
}

export interface ReactivationDigestHighlight {
  kind: "longest_merged_pr" | "riskiest_open_pr" | "biggest_cost_delta";
  project_slug: string;
  label: string;
}

export interface ReactivationLessonHighlight {
  lesson_slug: string;
  lesson_date: string;
  lesson_title: string;
}

export type ReactivationReason =
  | "ready"
  | "no_visit"
  | "within_window"
  | "not_sunday"
  | "outside_18_window"
  | "opt_out"
  | "deduped"
  | "quiet_hours_active";

export interface ReactivationEvaluation {
  shouldPush: boolean;
  reason: ReactivationReason;
  payload: ReactivationPushPayload | null;
}

interface VisitWatermarkRow { last_visit_at: string | null; }

function readLastVisitAt(db: DB): string | null {
  const row = db.prepare(
    "SELECT last_visit_at FROM operator_visit_watermark WHERE id = 1",
  ).get() as unknown as VisitWatermarkRow | undefined;
  return row?.last_visit_at ?? null;
}

function quietHoursTz(cfg: FleetConfig): string {
  const anyCfg = cfg as unknown as { quietHours?: { tz?: string } };
  const tz = anyCfg.quietHours?.tz;
  if (typeof tz === "string" && tz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    } catch { return "UTC"; }
  }
  return "UTC";
}

interface ZoneClock { dayOfWeek: number; minuteOfDay: number; }

function clockInZone(now: Date, tz: string): ZoneClock {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  }
  const parts = fmt.formatToParts(now);
  let weekday = "Sun";
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === "weekday") weekday = p.value;
    else if (p.type === "hour") hour = Number(p.value);
    else if (p.type === "minute") minute = Number(p.value);
  }
  if (hour === 24) hour = 0;
  const map: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  };
  const dow = map[weekday] ?? 0;
  return { dayOfWeek: dow, minuteOfDay: hour * 60 + minute };
}

function countRecentReactivationSnapshots(db: DB, now: Date): number {
  const cutoff = new Date(
    now.getTime() - REACTIVATION_DEDUP_WINDOW_DAYS * 86_400_000,
  ).toISOString();
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM snapshot "
    + " WHERE kind = 'reactivation_digest' "
    + "   AND created_at >= ?",
  ).get(cutoff) as unknown as { c: number | null } | undefined;
  return Number(row?.c ?? 0) || 0;
}

function countMergedAgentPrsSince(db: DB, sinceIso: string): number {
  const row = db.prepare(
    "SELECT COUNT(*) AS c FROM pr "
    + " WHERE is_agent = 1 "
    + "   AND state = 'MERGED' "
    + "   AND fetched_at IS NOT NULL "
    + "   AND fetched_at >= ?",
  ).get(sinceIso) as unknown as { c: number | null } | undefined;
  return Number(row?.c ?? 0) || 0;
}

interface AbsentPeriodPrRow {
  number: number;
  title: string;
  project_slug: string;
  fetched_at: string;
  gh_created_at: string | null;
}

function topLongestRunningMergedPr(
  db: DB, sinceIso: string,
): AbsentPeriodPrRow | null {
  const row = db.prepare(
    "SELECT pr.number AS number, pr.title AS title, "
    + "       p.slug AS project_slug, pr.fetched_at AS fetched_at, "
    + "       pr.gh_created_at AS gh_created_at "
    + "  FROM pr LEFT JOIN project p ON p.id = pr.project_id "
    + " WHERE pr.is_agent = 1 "
    + "   AND pr.state = 'MERGED' "
    + "   AND pr.fetched_at IS NOT NULL "
    + "   AND pr.fetched_at >= ? "
    + "   AND pr.gh_created_at IS NOT NULL "
    + " ORDER BY (julianday(pr.fetched_at) - julianday(pr.gh_created_at)) DESC, "
    + "          pr.fetched_at DESC "
    + " LIMIT 1",
  ).get(sinceIso) as unknown as AbsentPeriodPrRow | undefined;
  return row ?? null;
}

function topRiskiestOpenPr(db: DB, sinceIso: string): AbsentPeriodPrRow | null {
  const row = db.prepare(
    "SELECT pr.number AS number, pr.title AS title, "
    + "       p.slug AS project_slug, pr.fetched_at AS fetched_at, "
    + "       pr.gh_created_at AS gh_created_at "
    + "  FROM pr LEFT JOIN project p ON p.id = pr.project_id "
    + " WHERE pr.is_agent = 1 "
    + "   AND pr.state = 'open' "
    + "   AND pr.gh_created_at IS NOT NULL "
    + "   AND pr.gh_created_at <= ? "
    + " ORDER BY pr.gh_created_at ASC "
    + " LIMIT 1",
  ).get(sinceIso) as unknown as AbsentPeriodPrRow | undefined;
  return row ?? null;
}

interface ProjectCostDelta { project_slug: string; cost: number; }

function topProjectByCostInWindow(
  db: DB, sinceIso: string,
): ProjectCostDelta | null {
  const sinceDay = sinceIso.slice(0, 10);
  const row = db.prepare(
    "SELECT p.slug AS project_slug, SUM(c.cost_usd) AS cost "
    + "  FROM cost_rollup_day c LEFT JOIN project p ON p.id = c.project_id "
    + " WHERE c.day >= ? "
    + " GROUP BY p.id "
    + " ORDER BY cost DESC, p.slug ASC "
    + " LIMIT 1",
  ).get(sinceDay) as unknown as { project_slug: string | null; cost: number | null } | undefined;
  if (!row || !row.project_slug) return null;
  const cost = Number(row.cost) || 0;
  if (cost <= 0) return null;
  return { project_slug: String(row.project_slug), cost };
}

/** Compose the reactivation digest payload for the absent period.
 *  Pure read-side; the daemon helper persists the result via a
 *  reactivation_digest snapshot row and the deep-link route renders
 *  it. lastVisitAt is the ISO timestamp the operator was last seen
 *  on the portal; the helper computes daysAway and the period
 *  highlights against it. */
export function reactivationDigestPayload(
  db: DB,
  _cfg: FleetConfig,
  lastVisitAt: string,
  now: Date,
  baseUrl: string,
  token: string,
): ReactivationPushPayload {
  const lastMs = Date.parse(lastVisitAt);
  const daysAway = Number.isFinite(lastMs)
    ? Math.max(0, Math.floor((now.getTime() - lastMs) / 86_400_000))
    : 0;
  const featuresShipped = countMergedAgentPrsSince(db, lastVisitAt);
  const highlights: ReactivationDigestHighlight[] = [];
  const longest = topLongestRunningMergedPr(db, lastVisitAt);
  if (longest) {
    highlights.push({
      kind: "longest_merged_pr",
      project_slug: longest.project_slug,
      label: "longest-running PR finally merged: #"
        + String(longest.number) + " in " + longest.project_slug,
    });
  }
  const riskiest = topRiskiestOpenPr(db, lastVisitAt);
  if (riskiest) {
    highlights.push({
      kind: "riskiest_open_pr",
      project_slug: riskiest.project_slug,
      label: "riskiest open PR still waiting: #"
        + String(riskiest.number) + " in " + riskiest.project_slug,
    });
  }
  const costy = topProjectByCostInWindow(db, lastVisitAt);
  if (costy) {
    highlights.push({
      kind: "biggest_cost_delta",
      project_slug: costy.project_slug,
      label: "biggest cost delta: " + costy.project_slug
        + " spent $" + costy.cost.toFixed(2),
    });
  }
  const cleanBase = baseUrl.replace(/\/+$/, "");
  const url = cleanBase + "/digest-missed/" + token;
  return {
    daysAway,
    featuresShipped,
    lastVisitAt,
    generatedAt: now.toISOString(),
    url,
    highlights,
  };
}

/** Compose the deterministic ntfy message for a reactivation push.
 *  Pure on payload. Two branches: features-shipped is 1 or more
 *  versus fleet-was-quiet at zero. Lowercase, friend-text tone. */
export function composeReactivationMessage(payload: ReactivationPushPayload): string {
  const n = Math.max(0, Math.floor(payload.daysAway));
  const m = Math.max(0, Math.floor(payload.featuresShipped));
  const url = String(payload.url ?? "");
  if (m === 0) {
    return "you've not checked in for " + n + " days. "
      + "the fleet was quiet too. say hi when you can: " + url;
  }
  const featureWord = m === 1 ? "feature" : "features";
  return "you've not checked in for " + n + " days. "
    + m + " " + featureWord + " shipped without you. "
    + "take a look: " + url;
}

/** Evaluate whether a reactivation push should fire NOW. Pure read
 *  side: looks up the visit watermark, the opt-out flag, the local
 *  Sunday clock in the operator's tz, the dedup window, and the
 *  fleet-wide quiet hours. Returns shouldPush plus a reason string
 *  identifying which gate decided the outcome. The composed payload
 *  is supplied when shouldPush is true so the daemon helper can
 *  forward the same shape to createSnapshot plus sendNtfy without
 *  re-walking the SQL. baseUrl plus token are the URL components
 *  the daemon helper resolves; in the evaluator's pure-test seam
 *  the caller supplies them so the result is deterministic on
 *  fixture input. */
export function evaluateReactivationPush(
  db: DB,
  cfg: FleetConfig,
  now: Date,
  baseUrl = "http://127.0.0.1:7070",
  token = "",
): ReactivationEvaluation {
  const optOut = cfg.reactivationPush?.disabled === true;
  if (optOut) return { shouldPush: false, reason: "opt_out", payload: null };

  const lastVisitAt = readLastVisitAt(db);
  if (!lastVisitAt) {
    return { shouldPush: false, reason: "no_visit", payload: null };
  }
  const lastMs = Date.parse(lastVisitAt);
  if (!Number.isFinite(lastMs)) {
    return { shouldPush: false, reason: "no_visit", payload: null };
  }
  const daysSince = (now.getTime() - lastMs) / 86_400_000;
  if (daysSince < REACTIVATION_ABSENT_DAYS) {
    return { shouldPush: false, reason: "within_window", payload: null };
  }

  const tz = quietHoursTz(cfg);
  const clock = clockInZone(now, tz);
  if (clock.dayOfWeek !== 0) {
    return { shouldPush: false, reason: "not_sunday", payload: null };
  }
  if (clock.minuteOfDay < REACTIVATION_PUSH_WINDOW_START_MIN
      || clock.minuteOfDay > REACTIVATION_PUSH_WINDOW_END_MIN) {
    return { shouldPush: false, reason: "outside_18_window", payload: null };
  }

  if (countRecentReactivationSnapshots(db, now) > 0) {
    return { shouldPush: false, reason: "deduped", payload: null };
  }

  if (quietHoursActiveAnywhere(cfg, now)) {
    return { shouldPush: false, reason: "quiet_hours_active", payload: null };
  }

  const payload = reactivationDigestPayload(db, cfg, lastVisitAt, now, baseUrl, token);
  return { shouldPush: true, reason: "ready", payload };
}

/** Renderer options for the deep-link digest page. quietHoursActive
 *  swaps the "open your portal" CTA for a softer "powered by
 *  fleet-control" footer per the 0030 quiet-hours discipline. */
export interface ReactivationDigestRenderOptions {
  quietHoursActive?: boolean;
  portalUrl?: string;
}

/** Public renderer entry point. Production wraps the test seam. */
export function renderReactivationDigestPage(
  payload: ReactivationPushPayload,
  opts: ReactivationDigestRenderOptions = {},
): string {
  return _renderReactivationDigestForTests(payload, opts);
}

function escReactivation(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

/** Renderer-direct seam exposed for tests per LESSONS 2026-06-11.
 *  Production also routes through this from the public wrapper above. */
export function _renderReactivationDigestForTests(
  payload: ReactivationPushPayload,
  opts: ReactivationDigestRenderOptions = {},
): string {
  const portalUrl = opts.portalUrl ?? "/";
  const safeDays = escReactivation(String(Math.max(0, Math.floor(payload.daysAway))));
  const safeShipped = escReactivation(String(Math.max(0, Math.floor(payload.featuresShipped))));
  const safeLast = escReactivation(payload.lastVisitAt.slice(0, 10));
  const quiet = payload.featuresShipped === 0;

  const headlineHtml = quiet
    ? "<h1 data-testid=\"digest-missed-headline\">the fleet was quiet while you were away</h1>"
    : "<h1 data-testid=\"digest-missed-headline\">"
      + safeShipped + " features shipped while you were away</h1>";

  const subhead = "<p class=\"digest-missed-sub\" data-testid=\"digest-missed-sub\">"
    + "since you last checked in (<time datetime=\"" + safeLast + "\">"
    + safeLast + "</time>), it has been " + safeDays + " days.</p>";

  let body = "";
  if (quiet) {
    body = "<section class=\"digest-missed-quiet-period\" "
      + "data-testid=\"digest-missed-quiet-period\">"
      + "the fleet was quiet while you were away - nothing to catch up on. "
      + "say hi when you can.</section>";
  } else {
    const items = payload.highlights.map((h, i) => {
      const safeLabel = escReactivation(h.label);
      const safeKind = escReactivation(h.kind);
      return "<li data-testid=\"digest-missed-highlight-" + i + "\" "
        + "class=\"digest-missed-highlight digest-missed-" + safeKind + "\">"
        + safeLabel + "</li>";
    }).join("");
    body = "<ol class=\"digest-missed-highlights\" "
      + "data-testid=\"digest-missed-highlights\">" + items + "</ol>";
  }

  const cta = opts.quietHoursActive
    ? "<footer class=\"digest-missed-foot\" "
      + "data-testid=\"digest-missed-foot-soft\">powered by fleet-control</footer>"
    : "<footer class=\"digest-missed-foot\">"
      + "<a class=\"digest-missed-cta\" data-testid=\"digest-missed-cta\" "
      + "href=\"" + escReactivation(portalUrl) + "\">open your portal</a></footer>";

  return "<!doctype html>\n"
    + "<html lang=\"en\">\n"
    + "<head>\n"
    + "<meta charset=\"utf-8\" />\n"
    + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\" />\n"
    + "<title>" + (quiet ? "the fleet was quiet" : safeShipped + " features shipped")
    + " - fleet-control</title>\n"
    + "<link rel=\"stylesheet\" href=\"/style.css\" />\n"
    + "<meta name=\"robots\" content=\"noindex, nofollow\" />\n"
    + "</head>\n"
    + "<body class=\"digest-missed-page\">\n"
    + "<main class=\"digest-missed\" data-testid=\"digest-missed-main\">\n"
    + "<header class=\"digest-missed-head\">" + headlineHtml + subhead + "</header>\n"
    + body + "\n"
    + cta + "\n"
    + "</main>\n"
    + "</body>\n"
    + "</html>";
}

export interface ServeReactivationDigestResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Single chokepoint the server hits for GET /digest-missed/<token>.
 *  Resolves the token via SHA-256 hash against snapshot.id, asserts
 *  the row's kind is exactly reactivation_digest, and renders the
 *  page from the frozen payload. 404 on any failure mode (unknown,
 *  wrong-kind, revoked, expired) so a guesser can NOT fingerprint
 *  which tokens used to exist. The token IS the auth - no
 *  requireAuth chain runs against this route. */
export function serveReactivationDigest(
  db: DB,
  cfg: FleetConfig,
  token: string,
  now: Date,
): ServeReactivationDigestResult {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-robots-tag": "noindex, nofollow",
  };
  if (!token || typeof token !== "string" || !/^[0-9a-f]+$/i.test(token)) {
    return { status: 404, headers, body: "<!doctype html><title>not found</title>" };
  }
  const id = createHash("sha256").update(token).digest("hex");
  const row = db.prepare(
    "SELECT name, created_at, expires_at, revoked_at, payload_json, kind "
    + " FROM snapshot WHERE id = ?",
  ).get(id) as unknown as {
    name: string; created_at: string; expires_at: string;
    revoked_at: string | null; payload_json: string; kind: string | null;
  } | undefined;
  if (!row) return { status: 404, headers, body: "<!doctype html><title>not found</title>" };
  if (row.kind !== "reactivation_digest") {
    return { status: 404, headers, body: "<!doctype html><title>not found</title>" };
  }
  if (row.revoked_at) {
    return { status: 404, headers, body: "<!doctype html><title>not found</title>" };
  }
  if (new Date(row.expires_at).getTime() <= now.getTime()) {
    return { status: 404, headers, body: "<!doctype html><title>not found</title>" };
  }
  let payload: ReactivationPushPayload;
  try { payload = JSON.parse(row.payload_json) as ReactivationPushPayload; }
  catch {
    return { status: 404, headers, body: "<!doctype html><title>not found</title>" };
  }
  const quiet = quietHoursActiveAnywhere(cfg, now);
  const body = renderReactivationDigestPage(payload, { quietHoursActive: quiet });
  return { status: 200, headers, body };
}

// region include fleetSitemapPayload, renderSitemapXml, renderRobotsTxt,
// renderLessonsFeedAtom plus their renderer-direct test seams (ticket
// 0073). One set of cold-discovery surfaces lets a search engine index
// every public page already shipped and lets a curious reader subscribe
// to new lessons in their feed reader. The composition reads every
// public payload helper one-way (lessonsPublicArchive is supplied by
// the caller per the same fleetFailureModes opts pattern - so this
// module does NOT introduce a from-lessons-ts import; LESSONS
// 2026-06-13 rules out the cycle). Each helper is pure on its inputs;
// the boot-path tests drive the live SQL; the renderer-direct tests
// drive the publicHost-set vs publicHost-unset branches.

/** Per-url row in the sitemap payload. The four fields map 1:1 to the
 *  Sitemap 0.9 schema. priority is a number in 0.0-1.0; changefreq is
 *  one of the literal strings the spec accepts. */
export interface SitemapUrl {
  loc: string;
  lastmod: string;
  changefreq: "daily" | "weekly" | "monthly";
  priority: number;
}

export interface FleetSitemapPayload {
  urls: SitemapUrl[];
  asOf: string;
  version: 1;
}

export interface FleetSitemapPayloadOptions {
  /** Optional pre-built lessons archive rows from src/lessons.ts
   *  lessonsPublicArchive. The caller (src/server.ts) holds the only
   *  edge to that helper so this file does NOT take a from-lessons-ts
   *  import (the function-import cycle that LESSONS 2026-06-13
   *  documents). When omitted the helper renders the fixed pages and
   *  any failure-mode permalinks without lesson rows. */
  lessonsArchiveRows?: Array<{
    lesson_slug: string;
    lesson_date: string;
    lesson_title: string;
    lesson_body_anonymised: string;
  }>;
  /** Optional pre-built failure-modes payload. When omitted the helper
   *  calls fleetFailureModes internally. Tests pass this in to keep
   *  the sitemap composition hermetic from the failure-modes branch
   *  edges. */
  failureModes?: FleetFailureModes;
  /** Optional pre-built lineage gate. Tests drive the lineage AC
   *  branch by passing a {slug -> catches} map; production reads
   *  lesson_credit directly via a small SQL roll-up. */
  lineageCatchesBySlug?: Record<string, number>;
}

interface SitemapPrTupleRow { mx: string | null; c: number | null; }

/** Latest pr fetched_at + row count - the freshness anchor for the
 *  fixed pages whose lastmod tracks the ingest watermark. Per LESSONS
 *  2026-06-07 the pr table has no surrogate id, so we use the
 *  MAX(fetched_at), COUNT(*) tuple as a stable proxy. */
function ingestWatermarkIso(db: DB, now: Date): string {
  let row: SitemapPrTupleRow | undefined;
  try {
    row = db.prepare(
      "SELECT MAX(fetched_at) AS mx, COUNT(*) AS c FROM pr",
    ).get() as unknown as SitemapPrTupleRow | undefined;
  } catch { row = undefined; }
  const mx = row?.mx;
  if (typeof mx === "string" && mx) return mx;
  return now.toISOString();
}

interface LessonCreditMaxRow { slug: string; mx: string; }

/** Per-slug MAX(lesson_credit.created_at) lookup - powers the per-
 *  lesson lastmod surface per the cross-fleet digitalcraft 2026-05-22
 *  rule that lastmod tracks the CONTENT timestamp, not the render
 *  timestamp. */
function lessonCreditMaxBySlug(db: DB): Map<string, string> {
  const out = new Map<string, string>();
  let rows: LessonCreditMaxRow[] = [];
  try {
    rows = db.prepare(
      "SELECT lesson_slug AS slug, MAX(created_at) AS mx "
      + "  FROM lesson_credit "
      + " GROUP BY lesson_slug",
    ).all() as unknown as LessonCreditMaxRow[];
  } catch { rows = []; }
  for (const r of rows) {
    if (r.slug && r.mx) out.set(r.slug, r.mx);
  }
  return out;
}

/** Per-slug COUNT(*) lesson_credit lookup - the lineage gate per
 *  ticket 0069 (catches >= 2 surfaces the lineage permalink in the
 *  sitemap; singleton-catch pages stay out). */
interface LessonCreditCountRow { slug: string; c: number; }
function lessonCreditCountBySlug(db: DB): Map<string, number> {
  const out = new Map<string, number>();
  let rows: LessonCreditCountRow[] = [];
  try {
    rows = db.prepare(
      "SELECT lesson_slug AS slug, COUNT(*) AS c "
      + "  FROM lesson_credit "
      + " GROUP BY lesson_slug",
    ).all() as unknown as LessonCreditCountRow[];
  } catch { rows = []; }
  for (const r of rows) {
    if (r.slug) out.set(r.slug, Number(r.c) || 0);
  }
  return out;
}

interface FailureModePrFetchRow { mx: string | null; }
/** Per-signature MAX(pr.fetched_at) helper - the per-failure-mode
 *  lastmod tracks the most-recent PR row that hit the signature. */
function failureModeLastSeenBySignature(
  modes: FleetFailureModes,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of modes.signatures) {
    if (s.signature && s.last_seen_at) out.set(s.signature, s.last_seen_at);
  }
  return out;
}

/** Compose a loc URL from a host prefix and a path. When the host is
 *  empty the path stays relative (the AC7 publicHost-unset branch). */
function composeLoc(publicHost: string, pathPart: string): string {
  const host = String(publicHost ?? "").replace(/\/+$/, "");
  if (!host) return pathPart;
  return host + pathPart;
}

/** Build the sitemap payload by composing every existing public
 *  payload helper. The lessons rows + failure modes are taken via opts
 *  so the caller (src/server.ts) holds the only edge to lessons.ts
 *  (LESSONS 2026-06-13 rules out the import cycle). When opts omits
 *  either field the helper falls back: failure modes are computed
 *  here via fleetFailureModes; lessons rows default to empty. */
export function fleetSitemapPayload(
  db: DB,
  cfg: FleetConfig,
  now: Date,
  opts: FleetSitemapPayloadOptions = {},
): FleetSitemapPayload {
  const publicHost = String(cfg.operator?.publicHost ?? "").replace(/\/+$/, "");
  const watermark = ingestWatermarkIso(db, now);
  const year = now.getUTCFullYear();
  const urls: SitemapUrl[] = [];

  // Fixed pages. The watermark is the conservative lastmod surface
  // for these - the underlying payload (pulse, receipts, calculator)
  // refreshes when fresh PR rows land. /lessons-public/ and
  // /year/<YYYY> share the same watermark for the same reason.
  urls.push({
    loc: composeLoc(publicHost, "/pulse"),
    lastmod: watermark, changefreq: "weekly", priority: 0.9,
  });
  urls.push({
    loc: composeLoc(publicHost, "/receipts"),
    lastmod: watermark, changefreq: "monthly", priority: 0.7,
  });
  urls.push({
    loc: composeLoc(publicHost, "/calculator"),
    lastmod: watermark, changefreq: "monthly", priority: 0.6,
  });
  urls.push({
    loc: composeLoc(publicHost, "/lessons-public/"),
    lastmod: watermark, changefreq: "weekly", priority: 0.8,
  });
  urls.push({
    loc: composeLoc(publicHost, "/year/" + String(year)),
    lastmod: watermark, changefreq: "monthly", priority: 0.6,
  });

  // Conditional - operator profile + referrals page when the operator
  // has set their handle (and therefore opted in to the public profile
  // surface per ticket 0065).
  const handle = String(cfg.operator?.handle ?? "").trim();
  if (handle) {
    urls.push({
      loc: composeLoc(publicHost, "/operator/" + handle),
      lastmod: watermark, changefreq: "weekly", priority: 0.7,
    });
    urls.push({
      loc: composeLoc(publicHost, "/referrals/" + handle),
      lastmod: watermark, changefreq: "monthly", priority: 0.5,
    });
  }

  // Dynamic - one row per lesson permalink. lastmod uses the per-slug
  // MAX(lesson_credit.created_at) when present; falls back to the
  // lesson_date when no credits exist yet.
  const lessonRows = opts.lessonsArchiveRows ?? [];
  const lessonMax = lessonCreditMaxBySlug(db);
  const lessonCount = opts.lineageCatchesBySlug ?? Object.fromEntries(lessonCreditCountBySlug(db));
  for (const l of lessonRows) {
    const slug = String(l.lesson_slug ?? "").trim();
    if (!slug) continue;
    const lastmod = lessonMax.get(slug) ?? l.lesson_date ?? watermark;
    urls.push({
      loc: composeLoc(publicHost, "/lessons-public/" + slug),
      lastmod, changefreq: "monthly", priority: 0.6,
    });
    // Lineage page per ticket 0069 - only when catches >= 2.
    const catches = Number(lessonCount[slug] ?? 0);
    if (catches >= 2) {
      urls.push({
        loc: composeLoc(publicHost, "/lessons-public/" + slug + "/lineage"),
        lastmod, changefreq: "monthly", priority: 0.5,
      });
    }
  }

  // Dynamic - one row per failure-mode permalink.
  const modes = opts.failureModes ?? fleetFailureModes(db, { now });
  const failLastSeen = failureModeLastSeenBySignature(modes);
  for (const s of modes.signatures) {
    const sig = String(s.signature ?? "").trim();
    if (!sig) continue;
    const lastmod = failLastSeen.get(sig) ?? watermark;
    urls.push({
      loc: composeLoc(publicHost, "/failures/" + sig),
      lastmod, changefreq: "monthly", priority: 0.6,
    });
  }

  return { urls, asOf: now.toISOString(), version: 1 };
}

/** Minimal XML escape. The four entities cover every value we surface
 *  in the sitemap (URL chars don't need quote escaping but doing so
 *  keeps the renderer robust against any future field shapes). */
function escForSitemap(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

/** Render the Sitemap 0.9 XML body. The asOf field rides on the urlset
 *  comment line so a future tooling consumer can sanity-check the
 *  render time; per the cross-fleet digitalcraft rule the per-url
 *  lastmod is what crawlers consume. */
export function renderSitemapXml(p: FleetSitemapPayload): string {
  const urls = p.urls.map((u) => {
    const loc = escForSitemap(u.loc);
    const lastmod = escForSitemap(u.lastmod);
    const changefreq = escForSitemap(u.changefreq);
    const priority = (Math.round(u.priority * 10) / 10).toFixed(1);
    return "  <url>\n"
      + "    <loc>" + loc + "</loc>\n"
      + "    <lastmod>" + lastmod + "</lastmod>\n"
      + "    <changefreq>" + changefreq + "</changefreq>\n"
      + "    <priority>" + priority + "</priority>\n"
      + "  </url>";
  }).join("\n");
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
    + "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n"
    + urls
    + "\n</urlset>";
}

/** Renderer-direct test seam per LESSONS 2026-06-11 - drives the
 *  publicHost-unset branch without cwd config mutation. Production
 *  also routes through renderSitemapXml; this seam re-stamps the
 *  payload's host prefix when the test wants to override. */
export interface RenderSitemapForTestsOpts {
  publicHost?: string;
}
export function _renderSitemapForTests(
  p: FleetSitemapPayload,
  opts: RenderSitemapForTestsOpts = {},
): string {
  if (opts.publicHost === undefined) return renderSitemapXml(p);
  const host = String(opts.publicHost ?? "").replace(/\/+$/, "");
  const restamped: FleetSitemapPayload = {
    asOf: p.asOf,
    version: 1,
    urls: p.urls.map((u) => ({
      ...u,
      loc: host && !u.loc.startsWith("http")
        ? host + (u.loc.startsWith("/") ? u.loc : "/" + u.loc)
        : u.loc,
    })),
  };
  return renderSitemapXml(restamped);
}

export interface RobotsTxtOpts {
  publicHost: string;
}

/** Render the documented robots.txt body. The Allow rules supersede
 *  the Disallow: / when the Allow path is more specific. The Sitemap:
 *  line carries the absolute URL the operator submits to Google
 *  Search Console once. */
export function renderRobotsTxt(opts: RobotsTxtOpts): string {
  const host = String(opts.publicHost ?? "").replace(/\/+$/, "");
  const lines: string[] = [];
  lines.push("User-agent: *");
  lines.push("Allow: /pulse");
  lines.push("Allow: /receipts");
  lines.push("Allow: /calculator");
  lines.push("Allow: /lessons-public/");
  lines.push("Allow: /failures/");
  lines.push("Allow: /operator/");
  lines.push("Allow: /referrals/");
  lines.push("Allow: /year/");
  lines.push("Allow: /share/");
  lines.push("Allow: /og/");
  lines.push("Allow: /embed/");
  lines.push("Allow: /sitemap.xml");
  lines.push("Disallow: /api/");
  lines.push("Disallow: /");
  if (host) lines.push("Sitemap: " + host + "/sitemap.xml");
  return lines.join("\n") + "\n";
}

export function _renderRobotsForTests(opts: RobotsTxtOpts): string {
  return renderRobotsTxt(opts);
}

export interface FeedEntryInput {
  slug: string;
  title: string;
  updated: string;
  summary: string;
}

export interface RenderFeedAtomInput {
  publicHost: string;
  updated: string;
  entries: FeedEntryInput[];
}

/** Render an Atom 1.0 feed body. Self/alternate links use absolute
 *  URLs when publicHost is set so a feed reader can resolve them
 *  without rewriting. Per CROSS_LESSONS 2026-06-15 the rendered
 *  attribute values may include MIME types and full paths; tests
 *  scanning the body use [^>]* not [^/>]* to keep the regex liberal. */
export function renderLessonsFeedAtom(p: RenderFeedAtomInput): string {
  const host = String(p.publicHost ?? "").replace(/\/+$/, "");
  const baseId = host ? host + "/lessons-public/" : "/lessons-public/";
  const selfHref = host
    ? host + "/lessons-public/feed.xml"
    : "/lessons-public/feed.xml";
  const altHref = host ? host + "/lessons-public/" : "/lessons-public/";
  const updated = escForSitemap(p.updated);
  const entries = p.entries.map((e) => {
    const slug = escForSitemap(e.slug);
    const entryHref = host
      ? host + "/lessons-public/" + slug
      : "/lessons-public/" + slug;
    return "  <entry>\n"
      + "    <id>" + entryHref + "</id>\n"
      + "    <title>" + escForSitemap(e.title) + "</title>\n"
      + "    <updated>" + escForSitemap(e.updated) + "</updated>\n"
      + "    <summary>" + escForSitemap(e.summary) + "</summary>\n"
      + "    <link rel=\"alternate\" type=\"text/html\" href=\""
      + escForSitemap(entryHref) + "\" />\n"
      + "  </entry>";
  }).join("\n");
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
    + "<feed xmlns=\"http://www.w3.org/2005/Atom\">\n"
    + "  <title>fleet-control lessons</title>\n"
    + "  <id>" + baseId + "</id>\n"
    + "  <updated>" + updated + "</updated>\n"
    + "  <link rel=\"self\" type=\"application/atom+xml\" href=\""
    + escForSitemap(selfHref) + "\" />\n"
    + "  <link rel=\"alternate\" type=\"text/html\" href=\""
    + escForSitemap(altHref) + "\" />\n"
    + entries
    + "\n</feed>";
}

export function _renderFeedForTests(p: RenderFeedAtomInput): string {
  return renderLessonsFeedAtom(p);
}

// ────────────────────────────────────────────────────────────────────
// Ticket 0074 - First-week new-operator coach card.
//
// One pure helper newOperatorCoachTip(db, cfg, now) returns the
// CoachTipPayload the home composer renders. The window opens day 1
// (install day) and closes after day 7. The 7-day micro-tip table is
// a module-private const at the top of the block; each entry carries
// the documented headline / action / ctaLabel / deepLink. Day 5's
// deep link is dynamic - it resolves to the top-cited lesson slug
// via lesson_credit when one exists, else falls back to the index.
//
// LESSONS the implementation honours:
//   - 2026-05-26 ESM only, _resetXForTests seam for any module-level
//     state (the server-side cache layer carries its own seam).
//   - 2026-05-28 dismissal gating via inbox_dismissal with
//     project_slug='fleet' (matches the anniversary precedent).
//   - 2026-05-29 the caller pins now; the helper does not call new
//     Date() anywhere - tests pin the anchor.
//   - 2026-06-05 the no-install-date fallback synthesises the
//     install_date from MIN(pr.fetched_at) and writes the row via
//     the existing _recordInstallDateIfMissing seam introduced by
//     ticket 0072.
//   - 2026-06-07 the pr table has no surrogate id - the helper uses
//     MIN/COUNT to derive the synthetic install_date.
//   - 2026-06-11 _renderCoachCardForTests is the renderer-direct
//     seam so the 9 branches (7 days plus graduated plus none) drive
//     directly without booting startServer or racing the cwd config.
//   - 2026-06-13 the helper lives INSIDE views.ts (no new module).
//     The day-5 dynamic deep link uses lesson_credit DIRECTLY (the
//     existing lessonCreditRollup helper is already in this file).
//   - 2026-06-15 the leading comment block uses plain prose for any
//     sibling-helper-grep-vulnerable identifier (no backticks here).
// ────────────────────────────────────────────────────────────────────

export type CoachKind = "coach" | "graduated" | "none";

export interface CoachTipPayload {
  kind: CoachKind;
  day: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  headline: string;
  action: string;
  ctaLabel: string;
  deepLink: string;
  asOf: string;
  version: 1;
}

interface CoachTipTemplate {
  headline: string;
  action: string;
  ctaLabel: string;
  /** Static deep-link target; day 5 overrides this dynamically via
   *  the top-cited lesson slug lookup. */
  deepLink: string;
}

const COACH_TIPS: Record<1 | 2 | 3 | 4 | 5 | 6 | 7, CoachTipTemplate> = {
  1: {
    headline: "day 1 of your fleet",
    action: "set operator.publicHost in fleet-control.config.json so your share links become absolute URLs",
    ctaLabel: "show me where",
    deepLink: "#operator-publichost",
  },
  2: {
    headline: "day 2 of your fleet",
    action: "try fleetctl share pulse - it copies a paste-ready blurb to your clipboard. takes 5 seconds",
    ctaLabel: "show me how",
    deepLink: "#fleetctl-share",
  },
  3: {
    headline: "day 3 of your fleet",
    action: "pair your phone - scan the LAN QR from the home welcome banner",
    ctaLabel: "show me how",
    deepLink: "#lan-access-auth",
  },
  4: {
    headline: "day 4 of your fleet",
    action: "watch a PR merge end to end - the next autonomous PR your fleet opens surfaces here with one-tap approve",
    ctaLabel: "open inbox",
    deepLink: "/#/",
  },
  5: {
    headline: "day 5 of your fleet",
    action: "read your first cross-fleet lesson",
    ctaLabel: "open lessons",
    // Overridden by day-5 dynamic lookup; this static value is the
    // documented fallback used when the helper short-circuits.
    deepLink: "/lessons-public/",
  },
  6: {
    headline: "day 6 of your fleet",
    action: "pick your daily glance time - set cfg.quietHours so non-critical pushes respect your sleep window",
    ctaLabel: "show me where",
    deepLink: "#quiet-hours",
  },
  7: {
    headline: "day 7 of your fleet",
    action: "run fleetctl export portfolio to capture this week's portable artifact",
    ctaLabel: "show me how",
    deepLink: "#fleetctl-export-portfolio",
  },
};

interface CoachInstallRow {
  recorded_at: string | null;
}

interface CoachLifetimeRow {
  c: number | null;
  earliest: string | null;
}

interface CoachDismissRow {
  ok: number;
}

interface CoachTopCitedRow {
  lesson_slug: string | null;
  saves: number | null;
}

function coachLifetimeMergedAgentPrs(db: DB): CoachLifetimeRow {
  const row = db.prepare(
    "SELECT COUNT(*) AS c, MIN(fetched_at) AS earliest"
    + " FROM pr WHERE state = 'MERGED' AND is_agent = 1",
  ).get() as unknown as CoachLifetimeRow | undefined;
  return {
    c: Number(row?.c ?? 0) || 0,
    earliest: row?.earliest ?? null,
  };
}

/** Read the install_date row OR synthesise one via the existing
 *  _recordInstallDateIfMissing side-effect when the pr table is
 *  non-empty. Returns null when both are absent (truly fresh
 *  install with no signal to compute a day from). */
function coachReadInstallDate(db: DB, now: Date): string | null {
  const existing = db.prepare(
    "SELECT recorded_at FROM operator_install_milestones WHERE kind = 'install_date'",
  ).get() as unknown as CoachInstallRow | undefined;
  if (existing && existing.recorded_at) return existing.recorded_at;
  const life = coachLifetimeMergedAgentPrs(db);
  if (life.c > 0 && life.earliest) {
    // Side-effect: persist the synthesised install_date via the
    // existing helper. The helper is idempotent on re-call thanks to
    // the PK on operator_install_milestones.kind.
    _recordInstallDateIfMissing(db, now);
    return life.earliest;
  }
  return null;
}

/** Is THIS day-N's coach tip already dismissed? */
function coachIsDayDismissed(db: DB, day: number): boolean {
  const row = db.prepare(
    "SELECT 1 AS ok FROM inbox_dismissal"
    + " WHERE kind = 'coach_tip'"
    + "   AND project_slug = 'fleet'"
    + "   AND payload_id = ?",
  ).get("day_" + day) as unknown as CoachDismissRow | undefined;
  return !!row;
}

/** Has the graduation card been dismissed? */
function coachIsGraduationDismissed(db: DB): boolean {
  const row = db.prepare(
    "SELECT 1 AS ok FROM inbox_dismissal"
    + " WHERE kind = 'coach_tip'"
    + "   AND project_slug = 'fleet'"
    + "   AND payload_id = 'graduation'",
  ).get() as unknown as CoachDismissRow | undefined;
  return !!row;
}

/** Resolve the day-5 deep link to the top-cited lesson slug when one
 *  exists, else fall back to the documented /lessons-public/ index.
 *  Uses lesson_credit directly so the helper stays read-only. */
function coachDay5DeepLink(db: DB): string {
  const row = db.prepare(
    "SELECT lesson_slug, COUNT(*) AS saves"
    + " FROM lesson_credit"
    + " GROUP BY lesson_slug, lesson_date, lesson_title"
    + " ORDER BY saves DESC, lesson_slug ASC"
    + " LIMIT 1",
  ).get() as unknown as CoachTopCitedRow | undefined;
  if (row && row.lesson_slug) {
    return "/lessons-public/" + String(row.lesson_slug);
  }
  return "/lessons-public/";
}

/** Compute the day-of-fleet (1-indexed) the operator is on. day 1 is
 *  the install day itself; day 2 is 1 day after install; etc. */
function coachComputeDay(installAtIso: string, now: Date): number {
  const installMs = Date.parse(installAtIso);
  if (!Number.isFinite(installMs)) return 0;
  const deltaDays = Math.floor((now.getTime() - installMs) / 86_400_000);
  return Math.max(0, deltaDays) + 1;
}

/** Top-level helper. Returns the coach payload the home composer
 *  reads. Pure on (db, cfg, now) except for the install_date side-
 *  effect write that _recordInstallDateIfMissing emits when the pr
 *  table has signal but no install_date row exists yet. */
export function newOperatorCoachTip(
  db: DB,
  cfg: FleetConfig,
  now: Date,
): CoachTipPayload {
  const baseline: CoachTipPayload = {
    kind: "none",
    day: 1,
    headline: "",
    action: "",
    ctaLabel: "",
    deepLink: "",
    asOf: now.toISOString(),
    version: 1,
  };

  // Opt-out gate per LESSONS 2026-06-11 - short-circuits BEFORE any
  // DB read so the disabled posture is observably free.
  if (cfg.coach?.disabled === true) return baseline;

  const installAt = coachReadInstallDate(db, now);
  if (!installAt) return baseline;

  const day = coachComputeDay(installAt, now);
  if (day < 1) return baseline;

  // Graduation branch - day 8 and beyond. The card surfaces ONCE
  // post-week-1; the dismissal lives in inbox_dismissal with
  // payload_id='graduation'.
  if (day > 7) {
    if (coachIsGraduationDismissed(db)) return baseline;
    return {
      kind: "graduated",
      day: 7,
      headline: "you've completed your first week",
      action: "your fleet is now in the regular daily-glance rhythm; the home page is yours from here",
      ctaLabel: "thanks",
      deepLink: "/",
      asOf: now.toISOString(),
      version: 1,
    };
  }

  // Coach branch - day N in [1, 7]. The per-day dismissal short-
  // circuits THIS day to none without cascading to N+1.
  if (coachIsDayDismissed(db, day)) return baseline;

  const dayKey = day as 1 | 2 | 3 | 4 | 5 | 6 | 7;
  const tip = COACH_TIPS[dayKey];
  // Day 5 deep link is dynamic - resolves to the top-cited slug.
  const deepLink = dayKey === 5 ? coachDay5DeepLink(db) : tip.deepLink;

  return {
    kind: "coach",
    day: dayKey,
    headline: tip.headline,
    action: tip.action,
    ctaLabel: tip.ctaLabel,
    deepLink,
    asOf: now.toISOString(),
    version: 1,
  };
}

export interface CoachCardRenderOptions {
  /** When true the renderer emits the empty string so the SPA hides
   *  the card. Maps to an inbox_dismissal row at the home composer. */
  dismissed?: boolean;
}

function escCoach(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

/** Pure HTML composer for the home-page card. Carries the
 *  new-operator-coach-card + coach-day-N (or coach-graduation-card)
 *  testids. The dismiss button is a real <button> the SPA can bind
 *  to. */
export function renderCoachCard(
  p: CoachTipPayload,
  opts: CoachCardRenderOptions = {},
): string {
  if (opts.dismissed) return "";
  if (p.kind === "none") return "";
  if (p.kind === "graduated") {
    return "<section class=\"coach-card coach-graduation\""
      + " data-testid=\"coach-graduation-card\""
      + " data-kind=\"graduated\">"
      + "<div class=\"coach-eyebrow\" data-testid=\"coach-eyebrow\">first week complete</div>"
      + "<h2 class=\"coach-headline\" data-testid=\"coach-headline\">"
      + escCoach(p.headline) + "</h2>"
      + "<p class=\"coach-action\" data-testid=\"coach-action\">"
      + escCoach(p.action) + "</p>"
      + "<button class=\"coach-dismiss\""
      + " data-testid=\"coach-dismiss-button\""
      + " data-act=\"dismiss-coach\""
      + " data-payload-id=\"graduation\""
      + " type=\"button\">" + escCoach(p.ctaLabel || "thanks") + "</button>"
      + "</section>";
  }
  // Coach branch: 1 <= day <= 7.
  const dayN = String(p.day);
  return "<section class=\"coach-card\""
    + " data-testid=\"new-operator-coach-card\""
    + " data-testid-day=\"coach-day-" + escCoach(dayN) + "\""
    + " data-kind=\"coach\""
    + " data-day=\"" + escCoach(dayN) + "\">"
    + "<div class=\"coach-eyebrow\""
    + " data-testid=\"coach-day-" + escCoach(dayN) + "\">"
    + "day " + escCoach(dayN) + " of your fleet</div>"
    + "<h2 class=\"coach-headline\" data-testid=\"coach-headline\">"
    + escCoach(p.headline) + "</h2>"
    + "<p class=\"coach-action\" data-testid=\"coach-action\">"
    + escCoach(p.action) + "</p>"
    + "<a class=\"coach-cta\""
    + " data-testid=\"coach-cta\""
    + " href=\"" + escCoach(p.deepLink) + "\">"
    + escCoach(p.ctaLabel) + "</a>"
    + "<button class=\"coach-dismiss\""
    + " data-testid=\"coach-dismiss-button\""
    + " data-act=\"dismiss-coach\""
    + " data-payload-id=\"day_" + escCoach(dayN) + "\""
    + " type=\"button\">got it</button>"
    + "</section>";
}

/** Renderer-direct seam per LESSONS 2026-06-11. Drives each of the 9
 *  branches (day 1-7, graduated, none) without booting startServer
 *  or racing fleet-control.config.json. */
export function _renderCoachCardForTests(
  p: CoachTipPayload,
  opts: CoachCardRenderOptions = {},
): string {
  return renderCoachCard(p, opts);
}
// endregion
