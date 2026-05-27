// Assemble API payloads: cached history (SQLite) + fresh live state (live.ts).
import type { DB } from "./db.ts";
import type { FleetConfig } from "./config.ts";
import { jobLive, selfCancelDays } from "./live.ts";
import { openAlerts } from "./alerts.ts";
import { daemonStatus } from "./daemon.ts";
import { ingestProjectPRs, projectPRs } from "./ingest/prs.ts";
import { anomaliesForRun, recentAnomalies } from "./anomaly.ts";

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
