// Assemble API payloads: cached history (SQLite) + fresh live state (live.ts).
import type { DB } from "./db.ts";
import type { FleetConfig } from "./config.ts";
import { jobLive, selfCancelDays } from "./live.ts";
import { openAlerts } from "./alerts.ts";
import { daemonStatus } from "./daemon.ts";
import { ingestProjectPRs, projectPRs } from "./ingest/prs.ts";
import { anomaliesForRun, recentAnomalies } from "./anomaly.ts";
import { activeCorrelations } from "./correlate.ts";
import { activeDrifts } from "./drift.ts";
import { quietHoursActiveAnywhere } from "./quiet_hours.ts";
import { isoWeekKey } from "./digest.ts";

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
  return {
    slug: p.slug, name: p.name, repo,
    selfCancelDays: selfCancelDays(p.self_cancel), engEnabled: !!p.eng_enabled,
    displayState: displayState(jobs, selfCancelDays(p.self_cancel), usage),
    jobs, recent, costByPhase: byPhase, prs: projectPRs(db, p.id),
    usageLimit: usage, autoKill,
    cadence, pace: paceLabel(cadence),
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
