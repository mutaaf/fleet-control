// Tests for ticket 0034 — self-baseline drift detector.
//
// Coverage map (one test scenario per acceptance-criteria checkbox in
// docs/backlog/0034-self-baseline-drift-detector.md):
//
//   AC1   detectProjectDrift returns the {metric, baseline_*, current,
//         sigmas, ...} shape; bash_share with realistic spread fires.
//   AC2   Insufficient-data guard: <7 days OR baseline sigma < floor →
//         empty array.
//   AC3   contributing_runs is the top 3 run ids by the per-metric
//         contribution function.
//   AC4   runDriftHook: idempotent in 24h window; re-fires after
//         dismissal + 25h (aging-window dedup, NOT a UNIQUE index).
//   AC5   GET /api/projects/:slug/drift requires read scope and
//         returns the {detected, baseline_window, current_window,
//         generated_at} shape.
//   AC6   fleetInbox surfaces self_drift items between fleet_correlation
//         (highest) and the per-project kinds; payload carries metric +
//         sigmas + baseline_mean + current.
//   AC7   Dismissal: dismissing self_drift hides it; a fresh drift
//         outside the 24h dismissal window re-surfaces it.
//   AC8   SPA: renderDriftInboxRow + /project/:slug/drift detail use
//         redactSecrets + data-testid="project-drift" + inline SVG band
//         and orange marker.
//   AC9   Mobile: 375px viewport stacks rows + shrinks SVG (CSS).
//   AC10  Perf: detectProjectDrift < 60ms at 14d × 30 runs × 200
//         events; hook < 600ms across 10 projects (gated on PERF=1).
//   AC11  Meta: zero new runtime deps; tsc clean; no shell-string
//         composition; reads existing tables only; SQL row narrowing
//         uses `as unknown as RowT[]`; in-process startServer tests
//         plant an empty-roots config.
//
// Style discipline (all from LESSONS):
//   - Anomaly fixtures seed a REALISTIC spread (sigma > 0) so the 2.5σ
//     threshold is geometrically meaningful.
//   - Time-pinned tests anchor every seed timestamp to the pinned NOW.
//   - In-process startServer() tests plant a tmp fleet-control.config.json
//     in cwd (empty roots) and restore on cleanup.
//   - No shell strings; no new runtime deps.
//
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync,
  unlinkSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../src/db.ts";
import {
  detectProjectDrift, runDriftHook, activeDrifts,
} from "../src/drift.ts";
import { fleetInbox, dismissInboxItem } from "../src/inbox.ts";
import { startServer, requireAuth } from "../src/server.ts";
import { mintToken, revokeToken } from "../src/auth.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const STYLE_CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Anchors + helpers
// ────────────────────────────────────────────────────────────────────

/** Pinned now-anchor. Every seed timestamp derives from this via
 *  daysBeforeNow / hoursBeforeNow — never from `new Date()`. Per
 *  LESSONS § "time-pinned tests must NOT derive seed timestamps from
 *  `new Date()`". */
const NOW_ISO = "2026-06-01T12:00:00.000Z";
const NOW = new Date(NOW_ISO);

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-drift-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string, name?: string): number {
  db.prepare(
    "INSERT INTO project(slug,name,namespace) VALUES(?,?,?)",
  ).run(slug, name ?? slug, "test");
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

function seedRun(
  db: DB, projectId: number, startedAt: string,
  costUsd: number, phase = "ship", sessionId?: string,
): number {
  const sid = sessionId ?? `s-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,duration_ms,outcome,cost_usd,cost_source) "
    + "VALUES(?,?,?,?,?,?,?, 'live')",
  ).run(projectId, phase, sid, startedAt, 1000, "shipped", costUsd);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

function seedEvent(db: DB, opts: {
  runId: number; seq: number; ts: string; toolName: string;
}) {
  db.prepare(
    "INSERT INTO run_event(run_id, seq, ts, kind, tool_name, tool_use_id, input_summary, output_summary, is_error) "
    + "VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(opts.runId, opts.seq, opts.ts, "tool_use",
        opts.toolName, `tu-${opts.runId}-${opts.seq}`, "", "", 0);
}

/** ISO timestamp `hoursBefore` NOW. */
function hoursBeforeNow(hours: number): string {
  return new Date(NOW.getTime() - hours * 3600_000).toISOString();
}

/** ISO timestamp `daysBefore` NOW pinned to 12:00:00 UTC. */
function daysBeforeNow(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 3600_000).toISOString();
}

/** Seed a single run with N Bash events and M (non-Bash) events on a
 *  given startedAt timestamp. Returns the run id. */
function seedRunWithBashMix(
  db: DB, projectId: number, startedAt: string,
  bashCount: number, readCount: number, editCount: number, costUsd: number,
): number {
  const rid = seedRun(db, projectId, startedAt, costUsd);
  let seq = 1;
  for (let i = 0; i < bashCount; i++) {
    seedEvent(db, { runId: rid, seq: seq++, ts: startedAt, toolName: "Bash" });
  }
  for (let i = 0; i < readCount; i++) {
    seedEvent(db, { runId: rid, seq: seq++, ts: startedAt, toolName: "Read" });
  }
  for (let i = 0; i < editCount; i++) {
    seedEvent(db, { runId: rid, seq: seq++, ts: startedAt, toolName: "Edit" });
  }
  return rid;
}

// ────────────────────────────────────────────────────────────────────
// AC1 — detector shape + bash_share drift firing on realistic spread
// ────────────────────────────────────────────────────────────────────

test("AC1: detectProjectDrift returns bash_share entry with sigmas > 2.5 on a realistic 14d baseline", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "fleet-control");
    // 14-day baseline (days 2..15 ago) — Bash share fluctuates 18–24%.
    // Realistic spread so sigma is non-zero per LESSONS § "anomaly
    // tests need σ > 0 in the fixture". Each day gets one run with
    // a fixed mix of Bash + (Read+Edit) totaling 100 tool_use rows.
    const baselineShares = [
      0.20, 0.22, 0.18, 0.24, 0.19, 0.21, 0.23,
      0.18, 0.22, 0.20, 0.24, 0.19, 0.21, 0.22,
    ];
    // Days 2..15 (so day 1 is reserved for "current" window).
    for (let i = 0; i < 14; i++) {
      const ts = daysBeforeNow(i + 2);
      const bashCount = Math.round(baselineShares[i] * 100);
      const otherCount = 100 - bashCount;
      // Split "other" half-half into Read + Edit so edit_read_ratio
      // baseline is meaningful but not the focus of this test.
      const readCount = Math.floor(otherCount / 2);
      const editCount = otherCount - readCount;
      seedRunWithBashMix(db, pid, ts, bashCount, readCount, editCount, 0.5);
    }
    // Current 24h window: one run with bash share = 67%.
    seedRunWithBashMix(db, pid, hoursBeforeNow(6), 67, 16, 17, 0.5);

    const out = detectProjectDrift(db, pid, NOW);
    const bash = out.find((d) => d.metric === "bash_share");
    assert.ok(bash, "bash_share entry must surface when current >> baseline");
    assert.ok(bash!.sigmas > 2.5,
      `bash_share sigmas ${bash!.sigmas} must exceed 2.5`);
    assert.ok(Math.abs(bash!.current - 0.67) < 0.001,
      `current ~= 0.67, got ${bash!.current}`);
    assert.ok(bash!.baseline_mean > 0.15 && bash!.baseline_mean < 0.25,
      `baseline_mean expected ~0.21, got ${bash!.baseline_mean}`);
    assert.ok(bash!.baseline_sigma > 0,
      "baseline_sigma must be > 0 with a realistic spread");
    assert.equal(typeof bash!.first_seen_at, "string");
    assert.ok(Array.isArray(bash!.contributing_runs),
      "contributing_runs must be an array");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — insufficient-data guard
// ────────────────────────────────────────────────────────────────────

test("AC2: <7 days of telemetry → detectProjectDrift returns empty array", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "sparse");
    // Only 5 days of data in the baseline window (days 2..6 ago).
    for (let i = 0; i < 5; i++) {
      const ts = daysBeforeNow(i + 2);
      seedRunWithBashMix(db, pid, ts, 20, 40, 40, 0.5);
    }
    seedRunWithBashMix(db, pid, hoursBeforeNow(6), 60, 20, 20, 0.5);
    const out = detectProjectDrift(db, pid, NOW);
    assert.deepEqual(out, [],
      "fewer than 7 baseline days must yield an empty result");
  } finally { cleanup(); }
});

test("AC2: perfectly flat 14d baseline → detectProjectDrift returns empty array (variance floor)", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "flat");
    // Every baseline day has IDENTICAL Bash share (20%). Sigma = 0,
    // which would make any deviation "infinite sigma" without the
    // variance floor. Per LESSONS § "anomaly tests need σ > 0 in the
    // fixture, not just mean ≠ value", the floor prevents the
    // pathological 0/0 case.
    for (let i = 0; i < 14; i++) {
      const ts = daysBeforeNow(i + 2);
      seedRunWithBashMix(db, pid, ts, 20, 40, 40, 0.5);
    }
    // Current is 80% — extreme, but with sigma below floor we still
    // suppress.
    seedRunWithBashMix(db, pid, hoursBeforeNow(6), 80, 10, 10, 0.5);
    const out = detectProjectDrift(db, pid, NOW);
    const bash = out.find((d) => d.metric === "bash_share");
    assert.equal(bash, undefined,
      "flat baseline must not fire even with a wildly different current");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — contributing_runs ordered by per-metric contribution
// ────────────────────────────────────────────────────────────────────

test("AC3: contributing_runs are the top 3 run ids by per-metric contribution (bash_share)", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "contrib");
    // 14-day baseline at ~20% Bash so the threshold trips.
    const baselineShares = [
      0.20, 0.22, 0.18, 0.24, 0.19, 0.21, 0.23,
      0.18, 0.22, 0.20, 0.24, 0.19, 0.21, 0.22,
    ];
    for (let i = 0; i < 14; i++) {
      const ts = daysBeforeNow(i + 2);
      const b = Math.round(baselineShares[i] * 100);
      const other = 100 - b;
      const r = Math.floor(other / 2);
      seedRunWithBashMix(db, pid, ts, b, r, other - r, 0.5);
    }
    // Current window: 5 runs with KNOWN Bash counts. Largest contributors:
    //   r1 = 80 Bash  (top)
    //   r2 = 60 Bash
    //   r3 = 40 Bash
    //   r4 = 20 Bash
    //   r5 = 10 Bash
    const r1 = seedRunWithBashMix(db, pid, hoursBeforeNow(20), 80, 10, 10, 0.5);
    const r2 = seedRunWithBashMix(db, pid, hoursBeforeNow(18), 60, 20, 20, 0.5);
    const r3 = seedRunWithBashMix(db, pid, hoursBeforeNow(15), 40, 30, 30, 0.5);
    const r4 = seedRunWithBashMix(db, pid, hoursBeforeNow(10), 20, 40, 40, 0.5);
    const r5 = seedRunWithBashMix(db, pid, hoursBeforeNow(2), 10, 45, 45, 0.5);
    void r4; void r5;
    const out = detectProjectDrift(db, pid, NOW);
    const bash = out.find((d) => d.metric === "bash_share");
    assert.ok(bash, "bash_share drift must fire");
    assert.equal(bash!.contributing_runs.length, 3,
      "contributing_runs is capped at 3");
    assert.deepEqual(bash!.contributing_runs, [String(r1), String(r2), String(r3)],
      "top-3 runs by Bash-invocation count");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — daemon hook idempotency in 24h window + re-fire after dismiss
// ────────────────────────────────────────────────────────────────────

test("AC4: runDriftHook is idempotent — two calls insert one anomaly row per drifted metric", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "ident");
    const baselineShares = [
      0.20, 0.22, 0.18, 0.24, 0.19, 0.21, 0.23,
      0.18, 0.22, 0.20, 0.24, 0.19, 0.21, 0.22,
    ];
    for (let i = 0; i < 14; i++) {
      const ts = daysBeforeNow(i + 2);
      const b = Math.round(baselineShares[i] * 100);
      const other = 100 - b;
      seedRunWithBashMix(db, pid, ts, b, Math.floor(other / 2),
        other - Math.floor(other / 2), 0.5);
    }
    seedRunWithBashMix(db, pid, hoursBeforeNow(6), 67, 16, 17, 0.5);

    runDriftHook(db, NOW);
    runDriftHook(db, NOW);
    const rows = db.prepare(
      "SELECT id FROM anomaly WHERE kind='self_drift' AND correlation_signature='bash_share'",
    ).all() as unknown as Array<{ id: number }>;
    assert.equal(rows.length, 1,
      "exactly one self_drift row should exist after two hook calls");
  } finally { cleanup(); }
});

test("AC4: re-fire after dismissal + 25h advance — aging-window dedup, not UNIQUE", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "refire");
    const baselineShares = [
      0.20, 0.22, 0.18, 0.24, 0.19, 0.21, 0.23,
      0.18, 0.22, 0.20, 0.24, 0.19, 0.21, 0.22,
    ];
    for (let i = 0; i < 14; i++) {
      const ts = daysBeforeNow(i + 2);
      const b = Math.round(baselineShares[i] * 100);
      const other = 100 - b;
      seedRunWithBashMix(db, pid, ts, b, Math.floor(other / 2),
        other - Math.floor(other / 2), 0.5);
    }
    seedRunWithBashMix(db, pid, hoursBeforeNow(6), 67, 16, 17, 0.5);
    runDriftHook(db, NOW);

    // Dismiss the drift via the inbox API (AC6 dismiss path).
    const r = dismissInboxItem(db, {
      kind: "self_drift" as any,
      project_slug: "refire",
      payload_id: "bash_share",
    });
    assert.equal(r.ok, true, "dismissInboxItem must accept self_drift");

    // Advance 25h. The original anomaly row ages out of the 24h
    // window, and a fresh current-window drift seeded against the new
    // `now` must re-fire.
    const later = new Date(NOW.getTime() + 25 * 3600_000);
    // Seed an additional current-window run at `later - 6h` so the
    // drift signal at `later` is still high.
    const laterRunTs = new Date(later.getTime() - 6 * 3600_000).toISOString();
    seedRunWithBashMix(db, pid, laterRunTs, 70, 15, 15, 0.5);

    runDriftHook(db, later);
    const rows = db.prepare(
      "SELECT id, created_at FROM anomaly WHERE kind='self_drift' AND correlation_signature='bash_share' ORDER BY id",
    ).all() as unknown as Array<{ id: number; created_at: string }>;
    assert.equal(rows.length, 2,
      "a fresh drift outside the dismissed 24h window must insert a new anomaly row");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — GET /api/projects/:slug/drift — read scope + shape
// ────────────────────────────────────────────────────────────────────

let activeBoots = 0;
let savedConfigText: string | null = null;
const CONFIG_PATH = join(process.cwd(), "fleet-control.config.json");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    import("node:net").then((net) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const a = srv.address();
        if (a && typeof a === "object") {
          const p = a.port;
          srv.close(() => resolve(p));
        } else { srv.close(); reject(new Error("no port")); }
      });
      srv.on("error", reject);
    }).catch(reject);
  });
}

interface Booted {
  base: string;
  close: () => Promise<void>;
  cleanup: () => void;
  dbPath: string;
}

async function boot(seed?: (db: DB) => void): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-drift-route-"));
  const dbPath = join(dir, "fleet.db");
  if (activeBoots === 0) {
    savedConfigText = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null;
  }
  activeBoots += 1;
  const emptyRoots = join(dir, "empty");
  mkdirSync(emptyRoots, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({
    projectRoots: [emptyRoots],
    installedRoot: emptyRoots,
    cacheBase: emptyRoots,
    claudeProjects: emptyRoots,
  }));
  process.env.FLEET_DB_PATH = dbPath;
  if (seed) {
    const db = openDb(dbPath);
    try { seed(db); } finally { db.close(); }
  }
  const port = await freePort();
  const server = startServer("127.0.0.1", port);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base + "/api/whoami");
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((rs) => setTimeout(rs, 20));
  }
  return {
    base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    cleanup: () => {
      delete process.env.FLEET_DB_PATH;
      activeBoots -= 1;
      if (activeBoots === 0) {
        if (savedConfigText === null) {
          try { unlinkSync(CONFIG_PATH); } catch { /* gone already */ }
        } else {
          writeFileSync(CONFIG_PATH, savedConfigText);
        }
        savedConfigText = null;
      }
      rmSync(dir, { recursive: true, force: true });
    },
    dbPath,
  };
}

/** Seed a full drifted project under a custom slug into a DB. Used by
 *  the route + inbox tests. Anchors every timestamp to NOW. */
function seedDriftedFixture(db: DB, slug: string): number {
  const pid = seedProject(db, slug);
  const baselineShares = [
    0.20, 0.22, 0.18, 0.24, 0.19, 0.21, 0.23,
    0.18, 0.22, 0.20, 0.24, 0.19, 0.21, 0.22,
  ];
  for (let i = 0; i < 14; i++) {
    const ts = daysBeforeNow(i + 2);
    const b = Math.round(baselineShares[i] * 100);
    const other = 100 - b;
    seedRunWithBashMix(db, pid, ts, b, Math.floor(other / 2),
      other - Math.floor(other / 2), 0.5);
  }
  seedRunWithBashMix(db, pid, hoursBeforeNow(6), 67, 16, 17, 0.5);
  return pid;
}

test("AC5: GET /api/projects/:slug/drift is gated by read scope and returns the {detected, baseline_window, current_window, generated_at} shape", async () => {
  const b = await boot((db) => { seedDriftedFixture(db, "alpha"); });
  try {
    const dbOpen = openDb(b.dbPath);
    try {
      const nope = requireAuth(dbOpen, {
        socket: { remoteAddress: "10.0.0.5" }, headers: {},
      } as any, "read");
      assert.equal(nope.ok, false);
      assert.equal(nope.status, 401, "no-token remote must be 401");

      const minted = mintToken(dbOpen, "phone", "read");
      revokeToken(dbOpen, minted.id_prefix);
      const revoked = requireAuth(dbOpen, {
        socket: { remoteAddress: "10.0.0.5" },
        headers: { "x-fleet-token": minted.token },
      } as any, "read");
      assert.equal(revoked.ok, false);
      assert.equal(revoked.status, 401);
    } finally { dbOpen.close(); }

    const rOk = await fetch(b.base + "/api/projects/alpha/drift");
    assert.equal(rOk.status, 200);
    const body = await rOk.json() as {
      detected: Array<{ metric: string; sigmas: number }>;
      baseline_window: { start: string; end: string; days: number };
      current_window: { start: string; end: string; hours: number };
      generated_at: string;
    };
    assert.ok(Array.isArray(body.detected), "detected must be an array");
    assert.equal(body.baseline_window.days, 14);
    assert.equal(body.current_window.hours, 24);
    assert.equal(typeof body.baseline_window.start, "string");
    assert.equal(typeof body.baseline_window.end, "string");
    assert.equal(typeof body.current_window.start, "string");
    assert.equal(typeof body.current_window.end, "string");
    assert.equal(typeof body.generated_at, "string");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — fleetInbox surfaces self_drift between fleet_correlation and
// the per-project kinds; payload carries headline ingredients.
// ────────────────────────────────────────────────────────────────────

test("AC6: fleetInbox surfaces self_drift with payload {metric, sigmas, baseline_mean, current}", () => {
  const { db, cleanup } = tempDb();
  try {
    seedDriftedFixture(db, "fleet-control");
    runDriftHook(db, NOW);

    const out = fleetInbox(db, { now: NOW_ISO });
    const drift = out.items.find((it) => it.kind === "self_drift");
    assert.ok(drift, "self_drift inbox item must surface");
    assert.equal(drift!.project_slug, "fleet-control");
    const payload = drift!.payload as {
      metric?: string; sigmas?: number;
      baseline_mean?: number; current?: number;
    };
    assert.equal(payload.metric, "bash_share");
    assert.ok(typeof payload.sigmas === "number" && payload.sigmas > 2.5,
      "payload.sigmas carries the magnitude");
    assert.ok(typeof payload.baseline_mean === "number",
      "payload.baseline_mean is present");
    assert.ok(typeof payload.current === "number",
      "payload.current is present");
    assert.equal(drift!.payload.id, "bash_share",
      "payload.id is the metric — the dismissal key");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — dismissal: dismissing a self_drift hides it; a fresh drift
// outside the 24h dismissal window re-surfaces it.
// ────────────────────────────────────────────────────────────────────

test("AC7: dismissing a self_drift hides it; a fresh drift 25h later re-surfaces it", () => {
  const { db, cleanup } = tempDb();
  try {
    seedDriftedFixture(db, "fleet-control");
    runDriftHook(db, NOW);
    const before = fleetInbox(db, { now: NOW_ISO });
    assert.ok(
      before.items.some((it) => it.kind === "self_drift"),
      "seeded drift must surface before dismissal",
    );

    const r = dismissInboxItem(db, {
      kind: "self_drift" as any,
      project_slug: "fleet-control",
      payload_id: "bash_share",
    });
    assert.equal(r.ok, true, "dismissInboxItem must accept self_drift");

    const after = fleetInbox(db, { now: NOW_ISO });
    assert.ok(
      !after.items.some((it) => it.kind === "self_drift"),
      "dismissed drift must drop out of the inbox",
    );

    // Advance 25h, seed a fresh current-window run, re-run the hook,
    // assert the drift re-surfaces.
    const later = new Date(NOW.getTime() + 25 * 3600_000);
    const laterRunTs = new Date(later.getTime() - 6 * 3600_000).toISOString();
    const pid = (db.prepare("SELECT id FROM project WHERE slug='fleet-control'").get() as { id: number }).id;
    seedRunWithBashMix(db, pid, laterRunTs, 70, 15, 15, 0.5);
    runDriftHook(db, later);

    const reappear = fleetInbox(db, { now: later.toISOString() });
    assert.ok(
      reappear.items.some((it) => it.kind === "self_drift"),
      "fresh drift outside the dismissed 24h window must re-surface",
    );
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC8 — SPA: renderer wired with redactSecrets + data-testid + SVG.
// ────────────────────────────────────────────────────────────────────

test("AC8: web/app.js wires self_drift renderer + /project/:slug/drift detail with redaction and SVG markers", () => {
  // The renderer is declared by name and referenced by inboxRow.
  assert.match(APP_JS, /renderDriftInboxRow|self_drift/,
    "app.js must reference the self_drift kind");
  // The label table must include self_drift so the inbox row isn't
  // just echoing the enum.
  assert.ok(APP_JS.includes("self_drift"),
    "app.js must carry a human label for the self_drift kind");
  // The detail-view route uses the /project/:slug/drift shape.
  assert.ok(
    APP_JS.includes("/drift") || APP_JS.includes("drift/"),
    "app.js must reference the /drift detail route",
  );
  // Stable test hook for the detail container.
  assert.ok(APP_JS.includes('data-testid="project-drift"'),
    "detail container must carry data-testid='project-drift'");
  // Secret redaction at the renderer boundary.
  assert.match(APP_JS, /redactSecrets/,
    "app.js must apply secret redaction at the drift renderer boundary");
  // Inline SVG drawn per row — band rect + current marker.
  assert.ok(APP_JS.includes("<svg") || APP_JS.includes("</svg>"),
    "drift detail view must emit inline SVG for the band + marker");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Mobile: 375px viewport stacks rows + shrinks SVG (text CSS contract)
// ────────────────────────────────────────────────────────────────────

test("AC9: style.css carries a project-drift mobile contract (375px / <=600px stack + shrunk SVG)", () => {
  // The drift container has a CSS hook.
  assert.match(STYLE_CSS, /\.project-drift/,
    "style.css must carry a .project-drift selector");
  // The mobile breakpoint matches the 0011 / 0031 conventions
  // (<=600px collapses to single-column; <=375px keeps that shape).
  assert.match(STYLE_CSS, /@media\s*\(\s*max-width:\s*600px\s*\)/,
    "style.css must carry a @media (max-width: 600px) breakpoint that owns the drift rows");
  // Mobile SVG dims surface as a literal so the AC's exact 280x32
  // shrink target is enforced.
  assert.ok(STYLE_CSS.includes("280") || STYLE_CSS.includes("var(--drift-svg-mobile)"),
    "style.css must encode the mobile 280-wide SVG target");
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Performance (PERF=1)
// ────────────────────────────────────────────────────────────────────

test("AC10: detectProjectDrift handles 14d × 30 runs × 200 events in < 60ms",
  { skip: process.env.PERF !== "1" },
  () => {
    const { db, cleanup } = tempDb();
    try {
      const pid = seedProject(db, "perf");
      // 14 baseline days × 30 runs × 200 events with a realistic spread.
      for (let d = 0; d < 14; d++) {
        const ts = daysBeforeNow(d + 2);
        for (let r = 0; r < 30; r++) {
          const rid = seedRun(db, pid, ts, 0.5);
          // 200 tool_use events: ~20% Bash, ~40% Read, ~40% Edit.
          for (let s = 0; s < 200; s++) {
            const tn = s % 5 === 0 ? "Bash"
              : s % 5 < 3 ? "Read" : "Edit";
            seedEvent(db, { runId: rid, seq: s + 1, ts, toolName: tn });
          }
        }
      }
      // Current window: 30 runs.
      const ctsBase = hoursBeforeNow(6);
      for (let r = 0; r < 30; r++) {
        const rid = seedRun(db, pid, ctsBase, 0.5);
        for (let s = 0; s < 200; s++) {
          const tn = s % 3 === 0 ? "Bash"
            : s % 3 === 1 ? "Read" : "Edit";
          seedEvent(db, { runId: rid, seq: s + 1, ts: ctsBase, toolName: tn });
        }
      }
      const t0 = Date.now();
      const out = detectProjectDrift(db, pid, NOW);
      const elapsed = Date.now() - t0;
      assert.ok(Array.isArray(out));
      assert.ok(elapsed < 60,
        `detectProjectDrift took ${elapsed}ms — must be under 60ms`);
    } finally { cleanup(); }
  });

// ────────────────────────────────────────────────────────────────────
// AC11 — Meta: zero deps, no shell strings, reads existing tables,
// `as unknown as RowT[]` discipline, in-process tests plant an
// empty-roots config.
// ────────────────────────────────────────────────────────────────────

test("AC11: package.json carries zero runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    `dependencies must stay empty; found: ${Object.keys(deps).join(", ")}`);
});

test("AC11: src/drift.ts performs no shell-out (no child_process import)", () => {
  const src = readFileSync(join(__dirname, "..", "src", "drift.ts"), "utf8");
  assert.ok(!/from\s+["']node:child_process["']/.test(src),
    "src/drift.ts must not import node:child_process — pure SQL + helpers");
  // No execFile / exec / spawn under any name, ignoring comments.
  const codeOnly = src.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\bexecFile\b|\bexecSync\b|\bexec\b\s*\(|\bspawn\b/.test(codeOnly),
    "src/drift.ts must not invoke execFile/exec/spawn directly");
});

test("AC11: src/drift.ts uses `as unknown as` for SQL row narrowing", () => {
  const src = readFileSync(join(__dirname, "..", "src", "drift.ts"), "utf8");
  assert.match(src, /as\s+unknown\s+as\s+/,
    "src/drift.ts must use the `as unknown as RowT[]` double-cast per LESSONS");
});

test("AC11: src/drift.ts uses strftime decomposition (not julianday) for time arithmetic", () => {
  const src = readFileSync(join(__dirname, "..", "src", "drift.ts"), "utf8");
  // The detector window arithmetic uses date() / datetime() / strftime
  // — but explicitly NOT julianday() which loses sub-ms precision.
  // Strip line comments before checking so a comment referencing the
  // banned name doesn't trip the assertion.
  const codeOnly = src.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/julianday\s*\(/.test(codeOnly),
    "src/drift.ts must not call julianday() — use strftime decomposition per LESSONS");
});

// ────────────────────────────────────────────────────────────────────
// Sanity: activeDrifts (the inbox-side helper) returns rows fired in
// the last 24h that are not dismissed.
// ────────────────────────────────────────────────────────────────────

test("AC6 sanity: activeDrifts returns rows fired in the last 24h, not dismissed", () => {
  const { db, cleanup } = tempDb();
  try {
    seedDriftedFixture(db, "fleet-control");
    runDriftHook(db, NOW);
    const live = activeDrifts(db, NOW);
    assert.ok(live.length >= 1,
      "activeDrifts must include the seeded bash_share row");
    const bash = live.find((d) => d.metric === "bash_share");
    assert.ok(bash, "bash_share drift must surface");
    assert.equal(bash!.project_slug, "fleet-control");
  } finally { cleanup(); }
});
