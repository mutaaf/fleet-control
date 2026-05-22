// Assemble API payloads: cached history (SQLite) + fresh live state (live.ts).
import type { DB } from "./db.ts";
import type { FleetConfig } from "./config.ts";
import { jobLive, selfCancelDays } from "./live.ts";
import { openAlerts } from "./alerts.ts";
import { daemonStatus } from "./daemon.ts";
import { ingestProjectPRs, projectPRs } from "./ingest/prs.ts";

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

function displayState(jobs: any[], scDays: number | null): string {
  if (jobs.some((j) => j.running)) return "working";
  if (jobs.length && jobs.every((j) => j.paused)) return "off";
  if (scDays != null && scDays < 0) return "expired";
  if (scDays != null && scDays <= 3) return "attention";
  if (jobs.some((j) => j.loaded)) return "idle";
  return "off";
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
    totalCost += agg.cost ?? 0; totalRuns += agg.runs ?? 0;
    out.push({
      slug: p.slug, name: p.name, displayState: displayState(jobs, scDays),
      selfCancelDays: scDays, engEnabled: !!p.eng_enabled,
      cost: agg.cost ?? 0, cost7d: cost7.c ?? 0, runs: agg.runs ?? 0,
      jobs, telemetry,
    });
  }
  return {
    projects: out, totals: { cost: totalCost, runs: totalRuns },
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
       (input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens) toks
     FROM run WHERE project_id=? AND outcome IS NOT 'smoke' ORDER BY started_at DESC LIMIT 40`).all(p.id);
  const byPhase = db.prepare("SELECT phase, COUNT(*) runs, SUM(COALESCE(cost_usd,cost_usd_computed,0)) cost FROM run WHERE project_id=? GROUP BY phase").all(p.id);
  const repo = `${p.repo_owner}/${p.repo_name}`;
  try { ingestProjectPRs(db, p.id, repo); } catch { /* keep serving */ }
  return {
    slug: p.slug, name: p.name, repo,
    selfCancelDays: selfCancelDays(p.self_cancel), engEnabled: !!p.eng_enabled,
    displayState: displayState(jobs, selfCancelDays(p.self_cancel)),
    jobs, recent, costByPhase: byPhase, prs: projectPRs(db, p.id),
  };
}

export function runView(db: DB, id: number) {
  const run = db.prepare("SELECT * FROM run WHERE id=?").get(id) as any;
  if (!run) return null;
  const events = db.prepare("SELECT seq,ts,kind,tool_name,tool_use_id,input_summary,output_summary,is_error FROM run_event WHERE run_id=? ORDER BY seq").all(id);
  const project = db.prepare("SELECT slug,name FROM project WHERE id=?").get(run.project_id);
  return { run, events, project };
}
