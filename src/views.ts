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
    out.push({
      slug: p.slug, name: p.name, displayState: displayState(jobs, scDays, usage),
      selfCancelDays: scDays, engEnabled: !!p.eng_enabled,
      cost: agg.cost ?? 0, cost7d: cost7.c ?? 0, runs: agg.runs ?? 0,
      jobs, telemetry, usageLimit: usage, autoKill, forecast, anomalies,
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
  };
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
