// Alert rules — evaluated at the end of each ingest pass (on-demand + daemon).
// Easiest local notification: macOS osascript. Each alert has a dedup_key so the
// same condition notifies once per window.
import { execFile, execFileSync } from "node:child_process";
import type { DB } from "./db.ts";
import type { FleetConfig } from "./config.ts";
import { activeRun, selfCancelDays } from "./live.ts";

const HUNG_MIN: Record<string, number> = { ship: 15, groom: 45, review: 8, eng: 15 };

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

    // self-cancel approaching / passed
    const d = selfCancelDays(p.self_cancel);
    if (d != null && d < 0)
      fresh.push({ project_id: p.id, phase: null, type: "self_cancel", severity: "critical",
        title: `${p.name} has stopped`, detail: `Its safety limit passed — it won't work autonomously until you extend it.`, dedup_key: `self_cancel:${p.slug}:passed` });
    else if (d != null && d <= 3)
      fresh.push({ project_id: p.id, phase: null, type: "self_cancel", severity: "warn",
        title: `${p.name} stops in ${d}d`, detail: `Extend it ("keep it running") to avoid it pausing.`, dedup_key: `self_cancel:${p.slug}:${d}` });

    for (const ph of ["ship", "groom", "review", "eng"]) {
      const label = `${p.namespace}.agent-${ph}`;
      let running = false;
      try { running = /\bstate = running\b/.test(execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${label}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { continue; }
      if (!running) continue;
      const { elapsedMs } = activeRun(cfg, aliases, ph);
      const mins = elapsedMs ? elapsedMs / 60000 : 0;
      if (mins > (HUNG_MIN[ph] ?? 15))
        fresh.push({ project_id: p.id, phase: ph, type: "hung_run", severity: "warn",
          title: `${p.name}: ${ph} running ${Math.round(mins)}m`, detail: `Longer than usual — it may be stuck.`, dedup_key: `hung:${p.slug}:${ph}:${hour}` });
    }
  }

  const ins = db.prepare("INSERT INTO alert(project_id,phase,type,severity,title,detail,dedup_key,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(dedup_key) DO NOTHING");
  let added = 0;
  for (const a of fresh) {
    const r = ins.run(a.project_id, a.phase, a.type, a.severity, a.title, a.detail, a.dedup_key, now.toISOString());
    if (r.changes > 0) { added++; if (notify) osa(a.title, a.detail); }
  }
  return added;
}

function osa(title: string, detail: string) {
  execFile("osascript", ["-e", `display notification ${JSON.stringify(detail)} with title ${JSON.stringify("Fleet · " + title)} sound name "Submarine"`], () => {});
}

export function openAlerts(db: DB) {
  return db.prepare("SELECT id,project_id,phase,type,severity,title,detail,created_at FROM alert WHERE resolved_at IS NULL ORDER BY created_at DESC LIMIT 50").all();
}
