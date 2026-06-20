// Always-on collector — OFF by default. When enabled, a launchd job keeps a
// long-running loop that ingests + evaluates alerts (with OS notifications) even
// when the dashboard is closed. Shares the exact same orchestrator + rules.
import { writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, type FleetConfig } from "./config.ts";
import { openDb, type DB } from "./db.ts";
import { runIngestPass } from "./ingest/index.ts";
import { evalAlerts } from "./alerts.ts";
import { runBudgetGuards } from "./budget_guard.ts";
import { runCorrelationHook } from "./correlate.ts";
import { runDriftHook } from "./drift.ts";
import {
  runLessonsHook, loadCrossLessons, defaultLessonsPath, attributeHealsToLessons,
} from "./lessons.ts";
import {
  evaluateReactivationPush, composeReactivationMessage,
  type ReactivationPushPayload,
} from "./views.ts";
import { ntfyConfigFrom, sendNtfy, type NtfyResult } from "./ntfy.ts";

const UID = process.getuid?.() ?? 0;
const LABEL = "com.fleet.control.fleetd";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const REPO = join(fileURLToPath(import.meta.url), "..", "..");
const LOGDIR = join(homedir(), ".local", "state", "fleet-control", "logs");

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

// ────────────────────────────────────────────────────────────────────
// Reactivation push (ticket 0071) - one daemon-tick helper.
//
// Mints a reactivation_digest snapshot row plus POSTs the deterministic
// ntfy message when the operator has been absent for 5 or more days AND
// the local clock falls inside the Sunday 17:50 to 18:10 window. The
// 14-day dedup floor lives inside evaluateReactivationPush so a re-tick
// at now + 1h sees the just-minted row and short-circuits with reason
// deduped - mirroring the alert dedup pattern in src/ntfy.ts. The deps
// shape mirrors the 0009 / 0030 tick helpers - sendNtfy is injectable
// so tests record a synthetic call instead of POSTing to ntfy.sh. Per
// LESSONS 2026-06-15 the offline gate FLEET_DAEMON_OFFLINE=1 short-
// circuits the helper at the daemon-tick boundary so the AC8
// subprocess test never reaches the real ntfy transport.
// ────────────────────────────────────────────────────────────────────

export interface ReactivationPushDeps {
  sendNtfy: (topic: string, payload: {
    title: string;
    message: string;
    priority: number;
    click?: string;
    tags?: string[];
  }) => Promise<NtfyResult>;
  mintToken: () => string;
  hostForUrl?: string;
}

export interface ReactivationPushResult {
  fired: boolean;
  reason: string;
}

const REACTIVATION_TTL_HOURS = 24 * 30;

function defaultReactivationDeps(): ReactivationPushDeps {
  return {
    sendNtfy: (topic, payload) => sendNtfy(topic, {
      title: payload.title,
      message: payload.message,
      priority: payload.priority,
      tags: payload.tags,
      click: payload.click,
    }),
    mintToken: () => randomBytes(24).toString("hex"),
  };
}

/** Daemon-tick helper for the reactivation push (ticket 0071). Calls
 *  evaluateReactivationPush, mints a reactivation_digest snapshot row
 *  on the firing branch, then POSTs the deterministic ntfy message via
 *  the injected sendNtfy seam. Returns fired plus the reason string
 *  so the daemon log line stays diagnosable without re-running the
 *  evaluator. Offline gate: FLEET_DAEMON_OFFLINE=1 short-circuits with
 *  reason offline so a hermetic subprocess test (or a workstation
 *  with no network) never touches the ntfy.sh transport. */
export async function maybeFireReactivationPush(
  db: DB,
  cfg: FleetConfig,
  now: Date,
  deps?: Partial<ReactivationPushDeps>,
): Promise<ReactivationPushResult> {
  if (process.env.FLEET_DAEMON_OFFLINE === "1") {
    return { fired: false, reason: "offline" };
  }
  const ncfg = ntfyConfigFrom(cfg);
  if (!ncfg.topic) {
    return { fired: false, reason: "ntfy_disabled" };
  }
  const merged: ReactivationPushDeps = {
    ...defaultReactivationDeps(),
    ...(deps ?? {}),
  };
  const host = merged.hostForUrl ?? ncfg.portalUrl.replace(/\/+$/, "").replace(/\/#\/p\/?$/, "");
  const baseUrl = host || "http://127.0.0.1:7070";
  const token = merged.mintToken();
  const evaluation = evaluateReactivationPush(db, cfg, now, baseUrl, token);
  if (!evaluation.shouldPush || !evaluation.payload) {
    return { fired: false, reason: evaluation.reason };
  }
  const payload: ReactivationPushPayload = evaluation.payload;
  const id = createHash("sha256").update(token).digest("hex");
  const createdAt = now.toISOString();
  const expiresAt = new Date(
    now.getTime() + REACTIVATION_TTL_HOURS * 3600_000,
  ).toISOString();
  const name = "reactivation-" + createdAt.slice(0, 10);
  db.prepare(
    "INSERT INTO snapshot(id,name,created_at,expires_at,revoked_at,payload_json,kind)"
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(
    id, name, createdAt, expiresAt, null,
    JSON.stringify(payload), "reactivation_digest",
  );
  const message = composeReactivationMessage(payload);
  const title = payload.featuresShipped === 0
    ? "the fleet was quiet too"
    : payload.featuresShipped + " shipped while you were away";
  await merged.sendNtfy(ncfg.topic, {
    title,
    message,
    priority: 3,
    click: payload.url,
    tags: ["wave", "reactivation"],
  });
  return { fired: true, reason: "ready" };
}

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
      // Ticket 0036: cross-fleet lessons once-per-day diff. Reads the
      // CROSS_LESSONS.md file via loadCrossLessons, diffs the total
      // against the `cross_lessons_total` watermark, and writes a
      // fresh `cross_lessons_last_new` watermark when a positive
      // delta exists. Idempotent across ticks via the 24h aging
      // window per LESSONS § "re-fire-after-dismiss needs an aging
      // window, not a partial UNIQUE index". Cheap (one file read +
      // two watermark reads/writes); safe to run every tick — the
      // aging window keeps the inbox row stable.
      try {
        const inserted = runLessonsHook(db, new Date());
        if (inserted) console.log(`${new Date().toISOString()} ${inserted} new fleet-lessons batch detected`);
      } catch (e) { console.error("lessons hook error:", e); }
      // Ticket 0042: lesson credit ledger. Once per tick, attribute
      // any new heal-audit rows to the cross-fleet lesson whose
      // symptom substring matches the heal's stdout_tail. Idempotent
      // across ticks via the composite PK on lesson_credit
      // (lesson_slug, lesson_date, heal_audit_id) — re-running over
      // the same heal-audit row is a silent no-op. Guarded by the
      // same source_present / oversized checks the 0036 lessons hook
      // uses: a missing file is a fresh-install signal (no lessons
      // to attribute against) and an oversized file is a runaway-log
      // signal (the parser already skips it).
      try {
        const parsed = loadCrossLessons(defaultLessonsPath());
        if (parsed.source_present && !parsed.oversized) {
          const r = attributeHealsToLessons(db, parsed, new Date());
          if (r.credits_inserted) {
            console.log(`${new Date().toISOString()} ${r.credits_inserted} new lesson credit(s)`);
          }
        }
      } catch (e) { console.error("lesson-credit hook error:", e); }
      // Ticket 0071: reactivation push. Cheap evaluator (one SQL read
      // on operator_visit_watermark + one COUNT on snapshot kind =
      // reactivation_digest); only the Sunday 17:50-18:10 branch
      // actually mints a snapshot row + POSTs to ntfy. The 14-day
      // dedup window inside the evaluator means a re-tick at now + 1h
      // sees the just-minted row and short-circuits. Offline gate
      // (FLEET_DAEMON_OFFLINE=1) short-circuits at the helper's
      // entry point so the hermetic subprocess tests never reach
      // the ntfy transport.
      try {
        const r = await maybeFireReactivationPush(db, cfg, new Date());
        if (r.fired) {
          console.log(`${new Date().toISOString()} reactivation push fired`);
        }
      } catch (e) { console.error("reactivation push hook error:", e); }
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
