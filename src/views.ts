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
