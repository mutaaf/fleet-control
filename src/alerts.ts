// Alert rules — evaluated at the end of each ingest pass (on-demand + daemon).
// Two responsibilities now:
//   1. Raise new alerts (self-cancel, hung-run, usage-limit).
//   2. Auto-resolve stale alerts whose underlying condition has cleared, so the
//      open-alerts list reflects reality instead of accumulating forever.
//   3. Self-heal: when a run is hung past its threshold, SIGTERM/SIGKILL the
//      launchd job so the next scheduled fire isn't blocked. Logged to
//      control_audit as actor=auto-kill.
import { execFile, execFileSync } from "node:child_process";
import type { DB } from "./db.ts";
import type { FleetConfig } from "./config.ts";
import { activeRun, selfCancelDays } from "./live.ts";
import { ntfyConfigFrom, ntfyForAlert, ntfyForAnomaly } from "./ntfy.ts";

const UID = process.getuid?.() ?? 0;
// "Too long" *floors* (minutes). The real threshold is adaptive: p95 of this
// (project, phase)'s historical successful runs × HUNG_P95_MULTIPLIER, with a
// floor at these values and a hard cap at 8 hours. Matters because legit ship
// runs on some projects routinely take 30–115m; a flat fleet-wide 15m would
// auto-kill healthy work. Floor is the original conservative default so a
// brand-new project (no history yet) still benefits from auto-heal.
const HUNG_FLOOR_MIN: Record<string, number> = { ship: 15, groom: 45, review: 8, eng: 15 };
const HUNG_CAP_MIN = 480; // 8 hours — anything past this really is stuck.
// Multiplier on p95. Bumped from 1.5 → 2.0 after a retro on 14 days of
// digitalcraft/ship data: the two-PR shipping pattern clusters legit run times
// at 28–34m right around p95, so a 1.5× multiplier was killing healthy work
// 1–2 minutes shy of completion. 2× gives ~44m headroom over a 22m p95 while
// still catching genuinely hung work at the 60m+ tail.
const HUNG_P95_MULTIPLIER = 2.0;
// Re-kill grace: don't auto-kill again within this window per (slug,phase) so a
// child that's mid-SIGTERM has time to wind down before we escalate to SIGKILL.
const KILL_COOLDOWN_MS = 90_000;
const lastKill = new Map<string, number>();

/** Adaptive hung threshold for (project, phase). Returns minutes.
 * Uses p95 of past successful runs × HUNG_P95_MULTIPLIER; bounded by
 * HUNG_FLOOR_MIN[phase] and HUNG_CAP_MIN. Falls back to floor for projects
 * with little history. */
function hungThresholdMin(db: DB, projectId: number, phase: string): number {
  const floor = HUNG_FLOOR_MIN[phase] ?? 15;
  const count = (db.prepare(
    "SELECT COUNT(*) AS n FROM run WHERE project_id=? AND phase=? AND duration_ms IS NOT NULL AND outcome IN ('shipped','healed','reviewed-ok','reviewed-changes','no-op')",
  ).get(projectId, phase) as { n: number }).n;
  if (count < 5) return floor;
  const offset = Math.max(0, Math.floor(count * 0.95) - 1);
  const row = db.prepare(
    `SELECT duration_ms FROM run WHERE project_id=? AND phase=? AND duration_ms IS NOT NULL
       AND outcome IN ('shipped','healed','reviewed-ok','reviewed-changes','no-op')
     ORDER BY duration_ms ASC LIMIT 1 OFFSET ?`,
  ).get(projectId, phase, offset) as { duration_ms: number } | undefined;
  if (!row) return floor;
  const p95Min = row.duration_ms / 60_000;
  return Math.min(HUNG_CAP_MIN, Math.max(floor, Math.round(p95Min * HUNG_P95_MULTIPLIER)));
}

interface NewAlert { project_id: number; phase: string | null; type: string; severity: string; title: string; detail: string; dedup_key: string; }

export function evalAlerts(db: DB, cfg: FleetConfig, notify = true): number {
  const now = new Date();
  const hour = now.toISOString().slice(0, 13);
  const projects = db.prepare("SELECT * FROM project").all() as any[];
  const fresh: NewAlert[] = [];

  for (const p of projects) {
    const cadence = JSON.parse(p.cadence_json ?? "{}");
    const aliases = (db.prepare("SELECT alias_slug FROM project_alias WHERE project_id=?").all(p.id) as any[]).map((r) => r.alias_slug);
    if (!aliases.includes(p.slug)) aliases.push(p.slug);

    // --- self-cancel approaching / passed -------------------------------
    const d = selfCancelDays(p.self_cancel);
    if (d != null && d < 0)
      fresh.push({ project_id: p.id, phase: null, type: "self_cancel", severity: "critical",
        title: `${p.name} has stopped`, detail: `Its safety limit passed — it won't work autonomously until you extend it.`, dedup_key: `self_cancel:${p.slug}:passed` });
    else if (d != null && d <= 3)
      fresh.push({ project_id: p.id, phase: null, type: "self_cancel", severity: "warn",
        title: `${p.name} stops in ${d}d`, detail: `Extend it ("keep it running") to avoid it pausing.`, dedup_key: `self_cancel:${p.slug}:${d}` });

    // --- usage-limit (Claude rate / 5h window) --------------------------
    // Treat the project as halted if its most-recent run hit a usage limit AND
    // either no reset time is known OR the reset time is still in the future.
    const ul = db.prepare(
      "SELECT usage_limit_at, usage_limit_until, phase, id FROM run WHERE project_id=? AND usage_limit_at IS NOT NULL ORDER BY started_at DESC LIMIT 1",
    ).get(p.id) as { usage_limit_at: string | null; usage_limit_until: string | null; phase: string; id: number } | undefined;
    if (ul) {
      const until = ul.usage_limit_until ? new Date(ul.usage_limit_until) : null;
      const stillBlocked = !until || until.getTime() > now.getTime();
      // also: any successful run AFTER the limit hit means it's lifted
      const recovered = db.prepare(
        "SELECT 1 FROM run WHERE project_id=? AND started_at > ? AND usage_limit_at IS NULL AND COALESCE(exit_code,0) = 0 LIMIT 1",
      ).get(p.id, ul.usage_limit_at) as any;
      if (stillBlocked && !recovered) {
        const detail = until
          ? `Claude usage window resets ${formatRel(until, now)} — runs will fail until then.`
          : `Claude usage limit hit on the last run — runs will keep failing until the window resets.`;
        fresh.push({ project_id: p.id, phase: ul.phase, type: "usage_limit", severity: "warn",
          title: `${p.name}: hit Claude usage limit`, detail,
          dedup_key: `usage_limit:${p.slug}:${ul.usage_limit_at}` });
      }
    }

    // --- hung runs (+ self-heal kill) -----------------------------------
    for (const ph of ["ship", "groom", "review", "eng"]) {
      const label = `${p.namespace}.agent-${ph}`;
      let running = false;
      try { running = /\bstate = running\b/.test(execFileSync("launchctl", ["print", `gui/${UID}/${label}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { continue; }
      if (!running) continue;
      const { elapsedMs } = activeRun(cfg, aliases, ph);
      const mins = elapsedMs ? elapsedMs / 60000 : 0;
      const threshold = hungThresholdMin(db, p.id, ph);
      if (mins > threshold) {
        // Raise the alert (dedup per hour so it doesn't spam).
        fresh.push({ project_id: p.id, phase: ph, type: "hung_run", severity: "warn",
          title: `${p.name}: ${ph} running ${Math.round(mins)}m`,
          detail: `Beyond the ${Math.round(threshold)}m adaptive threshold (1.5× p95) — auto-killing so the next run can fire.`,
          dedup_key: `hung:${p.slug}:${ph}:${hour}` });
        // Self-heal: kill the job so subsequent scheduled fires aren't blocked.
        const cooldownKey = `${p.slug}:${ph}`;
        const since = Date.now() - (lastKill.get(cooldownKey) ?? 0);
        const sig = since > KILL_COOLDOWN_MS ? "SIGTERM" : "SIGKILL";
        try {
          execFileSync("launchctl", ["kill", sig, `gui/${UID}/${label}`], { stdio: ["ignore", "pipe", "ignore"] });
          lastKill.set(cooldownKey, Date.now());
          db.prepare("INSERT INTO control_audit(ts,actor,action,target,args_json,exit_code,stdout_tail) VALUES(?,?,?,?,?,?,?)")
            .run(now.toISOString(), "auto-kill", "kill-hung", `${p.slug}/${ph}`,
              JSON.stringify({ mins: Math.round(mins), signal: sig, threshold: Math.round(threshold) }), 0,
              `${sig}'d ${label} after ${Math.round(mins)}m (adaptive threshold ${Math.round(threshold)}m)`);
        } catch (e: any) {
          db.prepare("INSERT INTO control_audit(ts,actor,action,target,args_json,exit_code,stdout_tail) VALUES(?,?,?,?,?,?,?)")
            .run(now.toISOString(), "auto-kill", "kill-hung", `${p.slug}/${ph}`,
              JSON.stringify({ mins: Math.round(mins), signal: sig, threshold: Math.round(threshold) }), 1,
              String(e?.message ?? e).slice(0, 400));
        }
      }
    }
  }

  // --- write new alerts (dedup-keyed; second-write is a no-op) --------
  const ins = db.prepare(
    "INSERT INTO alert(project_id,phase,type,severity,title,detail,dedup_key,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(dedup_key) DO NOTHING",
  );
  let added = 0;
  const ncfg = ntfyConfigFrom(cfg);
  for (const a of fresh) {
    const r = ins.run(a.project_id, a.phase, a.type, a.severity, a.title, a.detail, a.dedup_key, now.toISOString());
    if (r.changes > 0) {
      added++;
      if (notify) {
        osa(a.title, a.detail);
        // Best-effort ntfy fan-out — dispatcher dedups per (dedup_key) for
        // the process lifetime and returns silently when ntfyTopic is
        // unset. We fire-and-forget so a slow remote doesn't stall the
        // ingest pass; transport failures are logged in src/ntfy.ts.
        void ntfyForAlert(db, cfg, ncfg, a);
      }
    }
  }

  // --- ntfy fan-out for newly-inserted anomaly rows (ticket 0009) -----
  // We scan recent anomalies whose run_id belongs to one of the projects
  // we just touched. The in-memory dedup in src/ntfy.ts ensures we never
  // POST the same (run_id, kind) twice in one daemon lifetime, even if
  // multiple evalAlerts ticks see the same row.
  if (notify && ncfg.topic) {
    const recent = db.prepare(
      "SELECT a.run_id AS run_id, a.kind AS kind, a.value AS value, "
      + "  a.baseline_mean AS baseline_mean, a.baseline_stddev AS baseline_stddev, "
      + "  a.candidate_reason AS candidate_reason, r.project_id AS project_id "
      + "FROM anomaly a JOIN run r ON r.id = a.run_id "
      + "WHERE a.created_at >= datetime('now','-1 day') "
      + "ORDER BY a.created_at DESC LIMIT 50",
    ).all() as Array<{
      run_id: number; kind: string; value: number; baseline_mean: number;
      baseline_stddev: number; candidate_reason: string | null; project_id: number;
    }>;
    for (const row of recent) {
      const sigma = row.baseline_stddev > 0
        ? (row.value - row.baseline_mean) / row.baseline_stddev : 0;
      void ntfyForAnomaly(db, cfg, ncfg, {
        project_id: row.project_id,
        run_id: row.run_id,
        kind: row.kind,
        value: row.value,
        baseline_mean: row.baseline_mean,
        stddev_multiplier: sigma,
        candidate_reason: row.candidate_reason,
      });
    }
  }

  // --- auto-resolve: close alerts whose condition has cleared ---------
  // Hung_run: launchctl is no longer running OR the run that triggered it ended.
  // Self_cancel: bumped past the threshold encoded in dedup_key.
  // Usage_limit: a successful run has happened since, or the reset time has passed.
  resolveStaleAlerts(db, now);

  return added;
}

function resolveStaleAlerts(db: DB, now: Date): void {
  const open = db.prepare("SELECT id, project_id, phase, type, dedup_key, created_at FROM alert WHERE resolved_at IS NULL").all() as any[];
  if (!open.length) return;
  const close = db.prepare("UPDATE alert SET resolved_at=? WHERE id=?");
  const projOf = (id: number) => db.prepare("SELECT slug, namespace, self_cancel FROM project WHERE id=?").get(id) as { slug: string; namespace: string; self_cancel: string } | undefined;
  for (const a of open) {
    const p = projOf(a.project_id);
    if (!p) { close.run(now.toISOString(), a.id); continue; } // project deleted

    if (a.type === "hung_run") {
      // Resolve when the launchctl job isn't running anymore. Catches the case
      // where we auto-killed it, or it finished on its own.
      let stillRunning = false;
      if (a.phase) {
        try {
          const out = execFileSync("launchctl", ["print", `gui/${UID}/${p.namespace}.agent-${a.phase}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
          stillRunning = /\bstate = running\b/.test(out);
        } catch { stillRunning = false; }
      }
      if (!stillRunning) close.run(now.toISOString(), a.id);
      continue;
    }

    if (a.type === "self_cancel") {
      const d = selfCancelDays(p.self_cancel, now);
      const wasPassed = a.dedup_key.endsWith(":passed");
      const wasDays = Number((a.dedup_key.match(/:(\d+)$/) || [])[1]);
      // Resolved if extended past 3 days, or if a "passed" alert is no longer past.
      if (wasPassed && d != null && d >= 0) close.run(now.toISOString(), a.id);
      else if (!isNaN(wasDays) && (d == null || d > Math.max(3, wasDays))) close.run(now.toISOString(), a.id);
      continue;
    }

    if (a.type === "usage_limit") {
      // dedup_key is `usage_limit:<slug>:<usage_limit_at>` — find that row, see
      // if its until-time has passed or a successful run has happened since.
      const hitAt = a.dedup_key.split(":").slice(2).join(":");
      const row = db.prepare(
        "SELECT usage_limit_until FROM run WHERE project_id=? AND usage_limit_at=? LIMIT 1",
      ).get(a.project_id, hitAt) as { usage_limit_until: string | null } | undefined;
      const untilOver = !row || !row.usage_limit_until || new Date(row.usage_limit_until).getTime() <= now.getTime();
      const recovered = db.prepare(
        "SELECT 1 FROM run WHERE project_id=? AND started_at > ? AND usage_limit_at IS NULL AND COALESCE(exit_code,0)=0 LIMIT 1",
      ).get(a.project_id, hitAt) as any;
      if (untilOver || recovered) close.run(now.toISOString(), a.id);
      continue;
    }
  }
}

/** Cheap UI helper: "in 23 minutes" / "in 2 hours" / "5 minutes ago". */
function formatRel(target: Date, now: Date): string {
  const mins = Math.round((target.getTime() - now.getTime()) / 60000);
  if (mins > 60 * 24) return `in ${Math.round(mins / (60 * 24))}d`;
  if (mins > 60) return `in ${Math.round(mins / 60)}h`;
  if (mins > 0) return `in ${mins}m`;
  if (mins > -60) return `${-mins}m ago`;
  return `${Math.round(-mins / 60)}h ago`;
}

function osa(title: string, detail: string) {
  execFile("osascript", ["-e", `display notification ${JSON.stringify(detail)} with title ${JSON.stringify("Fleet · " + title)} sound name "Submarine"`], () => {});
}

export function openAlerts(db: DB) {
  return db.prepare("SELECT id,project_id,phase,type,severity,title,detail,created_at FROM alert WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 50").all();
}
