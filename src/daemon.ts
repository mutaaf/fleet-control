// Always-on collector — OFF by default. When enabled, a launchd job keeps a
// long-running loop that ingests + evaluates alerts (with OS notifications) even
// when the dashboard is closed. Shares the exact same orchestrator + rules.
import { writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { runIngestPass } from "./ingest/index.ts";
import { evalAlerts } from "./alerts.ts";
import { runBudgetGuards } from "./budget_guard.ts";
import { runCorrelationHook } from "./correlate.ts";
import { runDriftHook } from "./drift.ts";

const UID = process.getuid?.() ?? 0;
const LABEL = "com.fleet.control.fleetd";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const REPO = join(fileURLToPath(import.meta.url), "..", "..");
const LOGDIR = join(homedir(), ".local", "state", "fleet-control", "logs");

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

/** The long-running loop (launchd ProgramArguments points here). */
export async function runDaemon(intervalSec = 60): Promise<void> {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  console.log(`fleetd up — every ${intervalSec}s`);
  for (;;) {
    try {
      runIngestPass(db, cfg);
      const n = evalAlerts(db, cfg, true);
      if (n) console.log(`${new Date().toISOString()} ${n} new alert(s)`);
      // Ticket 0021: soft daily-budget autopause runs once per ingest
      // tick AFTER the rollup recompute. Cheap query (one row per
      // project); fresh pauses fire launchctl bootout + one ntfy
      // push. Idempotent across ticks via the project_pause table.
      try {
        const guard = await runBudgetGuards(db, new Date());
        if (guard.paused.length) {
          console.log(`${new Date().toISOString()} autopaused ${guard.paused.length} project(s) over budget cap`);
        }
      } catch (e) { console.error("budget guard error:", e); }
      // Ticket 0027: cross-project failure correlation. Runs after the
      // ingest pass has refreshed the `pr` table (so first_fail_check
      // / first_fail_excerpt are current) and after evalAlerts +
      // budget guards so the per-project alerts don't shadow the
      // fleet-wide pattern. Idempotent across ticks via the partial
      // unique index on anomaly(correlation_signature) — running the
      // hook twice in the same 24h window for the same signature is
      // a no-op.
      try {
        const inserted = runCorrelationHook(db, new Date());
        if (inserted) console.log(`${new Date().toISOString()} ${inserted} new fleet correlation(s)`);
      } catch (e) { console.error("correlation hook error:", e); }
      // Ticket 0034: self-baseline drift detector. Runs after the
      // correlation hook so the inbox surfaces fleet-wide patterns
      // first when both fire on the same tick. Idempotent across
      // ticks via an application-level 24h aging-window lookup in
      // runDriftHook (per LESSONS § "re-fire-after-dismiss needs an
      // aging window, not a partial UNIQUE index"). Reads existing
      // run_event/run/anomaly tables only — no schema migration.
      try {
        const inserted = runDriftHook(db, new Date());
        if (inserted) console.log(`${new Date().toISOString()} ${inserted} new self-drift detection(s)`);
      } catch (e) { console.error("drift hook error:", e); }
    } catch (e) { console.error("pass error:", e); }
    await sleep(intervalSec);
  }
}

export function daemonStatus(): boolean {
  try { execFileSync("launchctl", ["print", `gui/${UID}/${LABEL}`], { stdio: "ignore" }); return true; } catch { return false; }
}

export function installDaemon(intervalSec = 60): void {
  mkdirSync(LOGDIR, { recursive: true });
  const node = process.execPath;
  writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>${join(REPO, "bin", "fleetctl.ts")}</string>
    <string>daemon-run</string>
    <string>${intervalSec}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(LOGDIR, "fleetd.out")}</string>
  <key>StandardErrorPath</key><string>${join(LOGDIR, "fleetd.err")}</string>
</dict></plist>`);
  try { execFileSync("launchctl", ["bootout", `gui/${UID}/${LABEL}`], { stdio: "ignore" }); } catch { /* */ }
  execFileSync("launchctl", ["bootstrap", `gui/${UID}`, PLIST]);
  execFileSync("launchctl", ["enable", `gui/${UID}/${LABEL}`]);
}

export function uninstallDaemon(): void {
  try { execFileSync("launchctl", ["bootout", `gui/${UID}/${LABEL}`], { stdio: "ignore" }); } catch { /* */ }
  if (existsSync(PLIST)) rmSync(PLIST);
}
