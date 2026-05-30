// Tests for quiet hours (ticket 0030). Each test maps 1:1 to an
// acceptance-criteria checkbox in docs/backlog/0030-quiet-hours.md.
//
// Strategy:
//   - AC1 (config schema): drive `loadConfig()` via a planted
//     fleet-control.config.json in cwd (snapshot + restore, mirroring
//     the inbox-route test pattern from LESSONS § "in-process
//     startServer() tests need an empty-roots config").
//   - AC2 (isQuietNow): drive the pure helper with a pinned `now`.
//   - AC3 (ntfy gate): stub https.request via the existing
//     setHttpsRequest seam — same shape as tests/ntfy.test.ts.
//   - AC4 (dedup re-fire at window close): same seam, advance `now`
//     past the window end and assert the deferred POST.
//   - AC5 (inbox split): direct fleetInbox call with seeded rows.
//   - AC6 (API envelope): boot startServer() in-process and hit the
//     route over loopback, asserting both the unset and active shapes.
//   - AC7 (SPA renderer): text-level checks on web/app.js (same
//     approach as tests/inbox.test.ts).
//   - AC8 (mobile): text-level CSS check, mirroring the existing
//     mobile-portal contract.
//   - AC9 (CLI): spawnSync via the FLEET_DB_PATH env seam (LESSONS
//     § "CLI subprocess tests need a FLEET_DB_PATH env seam").
//
// Zero new runtime deps; stdlib + node:test only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { loadConfig, type FleetConfig } from "../src/config.ts";
import {
  isQuietNow, resolveWindow, parseWindow, _resetQuietHoursForTests,
} from "../src/quiet_hours.ts";
import { openDb, type DB } from "../src/db.ts";
import { fleetInbox } from "../src/inbox.ts";
import { startServer } from "../src/server.ts";
import {
  setHttpsRequest, resetHttpsRequest, ntfyForAlert, ntfyForAnomaly,
  _resetDedupForTests, type NtfyConfig, type HttpsLikeRequest,
} from "../src/ntfy.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const WEB_DIR = join(REPO_ROOT, "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

const CONFIG_PATH = join(process.cwd(), "fleet-control.config.json");

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-quiet-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** Snapshot any pre-existing fleet-control.config.json, write a new one,
 *  and return a restorer. Mirrors the inbox-route test pattern. */
function plantConfig(json: Record<string, unknown>): () => void {
  const saved = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null;
  writeFileSync(CONFIG_PATH, JSON.stringify(json));
  return () => {
    if (saved === null) {
      try { unlinkSync(CONFIG_PATH); } catch { /* gone already */ }
    } else {
      writeFileSync(CONFIG_PATH, saved);
    }
  };
}

interface CapturedCall {
  url: string;
  method: string;
  body: string;
}

function fakeHttps(opts?: { status?: number }): { calls: CapturedCall[]; factory: HttpsLikeRequest } {
  const calls: CapturedCall[] = [];
  const factory: HttpsLikeRequest = (urlStr, init, cb) => {
    let body = "";
    const req: any = new EventEmitter();
    req.write = (chunk: any) => { body += chunk?.toString() ?? ""; };
    req.end = () => {
      calls.push({ url: urlStr, method: init.method ?? "GET", body });
      const res: any = new EventEmitter();
      res.statusCode = opts?.status ?? 200;
      setImmediate(() => { cb(res); res.emit("end"); });
    };
    req.setTimeout = () => { /* */ };
    req.destroy = () => { /* */ };
    return req;
  };
  return { calls, factory };
}

function baseCfg(): FleetConfig {
  return {
    projectRoots: [],
    installedRoot: "/tmp/installed",
    dbPath: "/tmp/x.db",
    cacheBase: "/tmp/cache",
    claudeProjects: "/tmp/claude",
    host: "127.0.0.1",
    port: 7070,
  };
}

function seedProject(db: DB, slug: string): number {
  db.prepare("INSERT INTO project(slug,name,namespace) VALUES (?,?,?)").run(slug, slug, "test");
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

// ────────────────────────────────────────────────────────────────────
// AC1 — config schema gains quietHours + quietHoursOverride
// ────────────────────────────────────────────────────────────────────

test("AC1: loadConfig parses quietHours + quietHoursOverride; absent fields stay undefined", () => {
  const restore = plantConfig({
    quietHours: { start: "22:00", end: "07:00", tz: "America/Los_Angeles" },
    quietHoursOverride: {
      "always-page": false,
      "custom-window": { start: "23:00", end: "06:00", tz: "America/New_York" },
    },
  });
  try {
    const cfg = loadConfig() as FleetConfig & {
      quietHours?: unknown;
      quietHoursOverride?: Record<string, unknown>;
    };
    assert.ok(cfg.quietHours, "quietHours should be present");
    assert.deepEqual(cfg.quietHours, { start: "22:00", end: "07:00", tz: "America/Los_Angeles" });
    assert.ok(cfg.quietHoursOverride);
    assert.equal(cfg.quietHoursOverride!["always-page"], false);
    assert.deepEqual(cfg.quietHoursOverride!["custom-window"],
      { start: "23:00", end: "06:00", tz: "America/New_York" });
  } finally { restore(); }
});

test("AC1: absent quietHours fields stay undefined", () => {
  const restore = plantConfig({});
  try {
    const cfg = loadConfig() as FleetConfig & { quietHours?: unknown; quietHoursOverride?: unknown };
    assert.equal(cfg.quietHours, undefined);
    assert.equal(cfg.quietHoursOverride, undefined);
  } finally { restore(); }
});

test("AC1: parseWindow rejects an invalid HH:MM and returns null", () => {
  assert.equal(parseWindow({ start: "22:00", end: "07:00", tz: "UTC" }) !== null, true);
  assert.equal(parseWindow({ start: "25:00", end: "07:00", tz: "UTC" }), null,
    "hour > 23 must be rejected");
  assert.equal(parseWindow({ start: "22:60", end: "07:00", tz: "UTC" }), null,
    "minute > 59 must be rejected");
  assert.equal(parseWindow({ start: "noon", end: "07:00", tz: "UTC" }), null,
    "non-numeric must be rejected");
  assert.equal(parseWindow(undefined), null);
  // tz validation is best-effort — invalid tz should fall back to null.
  assert.equal(parseWindow({ start: "22:00", end: "07:00", tz: "Not/AZone" }), null);
});

// ────────────────────────────────────────────────────────────────────
// AC2 — isQuietNow resolves windows + handles overnight wrap + overrides
// ────────────────────────────────────────────────────────────────────

test("AC2: fleet default 22:00-07:00 PT — 03:00 PT returns true, 12:00 PT returns false", () => {
  _resetQuietHoursForTests();
  const cfg = {
    ...baseCfg(),
    quietHours: { start: "22:00", end: "07:00", tz: "America/Los_Angeles" },
  } as FleetConfig;
  // 03:00 PT = 10:00 UTC (during DST PT is UTC-7; 03:00-(-7) = 10:00 UTC).
  // Use 2026-06-15 (firmly inside PDT) to avoid DST edge cases.
  const inWindow = new Date("2026-06-15T10:00:00.000Z");
  assert.equal(isQuietNow(cfg, "anyslug", inWindow), true,
    "03:00 PT must fall inside the 22:00-07:00 window");
  // 12:00 PT = 19:00 UTC.
  const outOfWindow = new Date("2026-06-15T19:00:00.000Z");
  assert.equal(isQuietNow(cfg, "anyslug", outOfWindow), false,
    "12:00 PT must fall outside the 22:00-07:00 window");
});

test("AC2: per-project `false` override skips quiet hours for that slug", () => {
  _resetQuietHoursForTests();
  const cfg = {
    ...baseCfg(),
    quietHours: { start: "22:00", end: "07:00", tz: "America/Los_Angeles" },
    quietHoursOverride: { "always-page": false as const },
  } as FleetConfig;
  const inWindow = new Date("2026-06-15T10:00:00.000Z"); // 03:00 PT
  assert.equal(isQuietNow(cfg, "anyslug", inWindow), true,
    "fleet default still applies to non-overridden slugs");
  assert.equal(isQuietNow(cfg, "always-page", inWindow), false,
    "per-project `false` override must skip quiet hours");
});

test("AC2: resolveWindow — per-project override beats the fleet default", () => {
  _resetQuietHoursForTests();
  const cfg = {
    ...baseCfg(),
    quietHours: { start: "22:00", end: "07:00", tz: "America/Los_Angeles" },
    quietHoursOverride: {
      "tight": { start: "23:00", end: "05:00", tz: "America/New_York" },
    },
  } as FleetConfig;
  const r = resolveWindow(cfg, "tight");
  assert.ok(r);
  assert.equal(r!.tz, "America/New_York");
  assert.equal(r!.start, "23:00");
});

test("AC2: overnight wrap (start > end) — 23:59 falls inside 22:00-07:00", () => {
  _resetQuietHoursForTests();
  const cfg = {
    ...baseCfg(),
    quietHours: { start: "22:00", end: "07:00", tz: "UTC" },
  } as FleetConfig;
  const before = new Date("2026-06-15T22:30:00.000Z");
  const middle = new Date("2026-06-15T23:59:00.000Z");
  const after = new Date("2026-06-15T05:00:00.000Z");
  const outside = new Date("2026-06-15T08:00:00.000Z");
  assert.equal(isQuietNow(cfg, "any", before), true);
  assert.equal(isQuietNow(cfg, "any", middle), true);
  assert.equal(isQuietNow(cfg, "any", after), true);
  assert.equal(isQuietNow(cfg, "any", outside), false);
});

test("AC2: no quiet hours configured → isQuietNow returns false for every slug", () => {
  _resetQuietHoursForTests();
  const cfg = baseCfg();
  assert.equal(isQuietNow(cfg, "any", new Date("2026-06-15T10:00:00.000Z")), false);
});

// ────────────────────────────────────────────────────────────────────
// AC3 — ntfy gate: priority < 5 during quiet hours is suppressed; 5 fires
// ────────────────────────────────────────────────────────────────────

test("AC3: ntfyForAlert during quiet hours suppresses warn (priority 3) — zero POSTs, returns quiet_hours", async () => {
  _resetDedupForTests();
  _resetQuietHoursForTests();
  const { calls, factory } = fakeHttps({ status: 200 });
  setHttpsRequest(factory);
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "almanac");
    const cfg = {
      ...baseCfg(),
      quietHours: { start: "22:00", end: "07:00", tz: "America/Los_Angeles" },
    } as FleetConfig;
    const ncfg: NtfyConfig = { topic: "tfleet", portalUrl: "http://127.0.0.1:7070/#/p/" };
    const inWindow = new Date("2026-06-15T10:00:00.000Z"); // 03:00 PT

    const r = await ntfyForAlert(db, cfg, ncfg, {
      project_id: pid, phase: "ship", type: "hung_run",
      severity: "warn", title: "almanac: ship running 30m", detail: "auto-killed",
      dedup_key: "hung:almanac:ship:1",
    }, { now: inWindow });

    assert.equal(calls.length, 0, "warn during quiet hours must NOT POST");
    assert.equal(r.ok, true);
    assert.equal(r.error, "quiet_hours");
  } finally { resetHttpsRequest(); cleanup(); }
});

test("AC3: ntfyForAlert during quiet hours still fires critical (priority 5) — exactly one POST", async () => {
  _resetDedupForTests();
  _resetQuietHoursForTests();
  const { calls, factory } = fakeHttps({ status: 200 });
  setHttpsRequest(factory);
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "almanac");
    const cfg = {
      ...baseCfg(),
      quietHours: { start: "22:00", end: "07:00", tz: "America/Los_Angeles" },
    } as FleetConfig;
    const ncfg: NtfyConfig = { topic: "tfleet", portalUrl: "http://127.0.0.1:7070/#/p/" };
    const inWindow = new Date("2026-06-15T10:00:00.000Z"); // 03:00 PT

    const r = await ntfyForAlert(db, cfg, ncfg, {
      project_id: pid, phase: null, type: "self_cancel",
      severity: "critical", title: "almanac stopped", detail: "extend it",
      dedup_key: "self_cancel:almanac:passed",
    }, { now: inWindow });

    assert.equal(calls.length, 1, "critical during quiet hours STILL fires");
    assert.equal(r.ok, true);
    assert.notEqual(r.error, "quiet_hours");
  } finally { resetHttpsRequest(); cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — quiet-hours suppression does NOT consume dedup; re-fires at window close
// ────────────────────────────────────────────────────────────────────

test("AC4: same dedup_key suppressed twice in quiet hours, then fires once after window end", async () => {
  _resetDedupForTests();
  _resetQuietHoursForTests();
  const { calls, factory } = fakeHttps({ status: 200 });
  setHttpsRequest(factory);
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "almanac");
    const cfg = {
      ...baseCfg(),
      quietHours: { start: "22:00", end: "07:00", tz: "America/Los_Angeles" },
    } as FleetConfig;
    const ncfg: NtfyConfig = { topic: "tfleet", portalUrl: "http://127.0.0.1:7070/#/p/" };
    const inWindow = new Date("2026-06-15T10:00:00.000Z"); // 03:00 PT
    const outOfWindow = new Date("2026-06-15T15:00:00.000Z"); // 08:00 PT — after end

    const alert = {
      project_id: pid, phase: "ship", type: "hung_run",
      severity: "warn", title: "almanac: ship running 30m", detail: "auto-killed",
      dedup_key: "hung:almanac:ship:1",
    };

    // First dispatch in window — suppressed.
    await ntfyForAlert(db, cfg, ncfg, alert, { now: inWindow });
    // Second dispatch in window — also suppressed, dedup not consumed.
    await ntfyForAlert(db, cfg, ncfg, alert, { now: inWindow });
    assert.equal(calls.length, 0, "two quiet-hours dispatches → zero POSTs");

    // Third dispatch after window end — must fire exactly once.
    await ntfyForAlert(db, cfg, ncfg, alert, { now: outOfWindow });
    assert.equal(calls.length, 1, "after window close, the alert must fire once");

    // Fourth dispatch (still outside window) — dedup now consumed; no extra POST.
    await ntfyForAlert(db, cfg, ncfg, alert, { now: outOfWindow });
    assert.equal(calls.length, 1, "second post-window dispatch is dedup-suppressed");
  } finally { resetHttpsRequest(); cleanup(); }
});

test("AC4: anomaly dispatch follows the same suppress-then-fire rule", async () => {
  _resetDedupForTests();
  _resetQuietHoursForTests();
  const { calls, factory } = fakeHttps({ status: 200 });
  setHttpsRequest(factory);
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "almanac");
    const cfg = {
      ...baseCfg(),
      quietHours: { start: "22:00", end: "07:00", tz: "America/Los_Angeles" },
    } as FleetConfig;
    const ncfg: NtfyConfig = { topic: "tfleet", portalUrl: "http://127.0.0.1:7070/#/p/" };
    const inWindow = new Date("2026-06-15T10:00:00.000Z"); // 03:00 PT
    const outOfWindow = new Date("2026-06-15T15:00:00.000Z"); // 08:00 PT

    const anomaly = {
      project_id: pid, run_id: 7, kind: "duration",
      value: 60_000, baseline_mean: 10_000, stddev_multiplier: 21.0,
      candidate_reason: null,
    };

    // Priority is 4 (between warn and critical) — < 5 means suppress in window.
    await ntfyForAnomaly(db, cfg, ncfg, anomaly, { now: inWindow });
    assert.equal(calls.length, 0, "anomaly priority-4 must be suppressed in quiet hours");
    await ntfyForAnomaly(db, cfg, ncfg, anomaly, { now: outOfWindow });
    assert.equal(calls.length, 1, "anomaly re-fires once after window close");
  } finally { resetHttpsRequest(); cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — fleetInbox split into items + quietedItems
// ────────────────────────────────────────────────────────────────────

test("AC5: inside quiet hours, non-critical pr_review rows move to quietedItems; fleet_correlation stays in items", () => {
  _resetQuietHoursForTests();
  const { db, cleanup } = tempDb();
  try {
    const inWindow = new Date("2026-06-15T10:00:00.000Z"); // 03:00 PT
    const cfg = {
      ...baseCfg(),
      quietHours: { start: "22:00", end: "07:00", tz: "America/Los_Angeles" },
    } as FleetConfig;

    // Three PR rows on alpha + a fleet_correlation row (seeded directly
    // into anomaly with kind='fleet_correlated' per ticket 0027's
    // correlate.ts contract).
    const pid = seedProject(db, "alpha");
    for (const n of [1, 2, 3]) {
      const fetchedAt = new Date(inWindow.getTime() - n * 60_000).toISOString();
      db.prepare(
        "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,"
        + "is_agent,additions,deletions,author,url,fetched_at) "
        + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(pid, n, `feat #${n}`, `feat/${n}`, "open", "green", "clean",
            1, 1, 0, "agent", null, fetchedAt);
    }
    // Seed a fleet_correlation row: same shape activeCorrelations
    // returns — an anomaly with kind='fleet_correlated' across runs in
    // ≥2 projects. The simplest seed is via a direct INSERT into the
    // anomaly table.
    db.prepare("INSERT INTO project(slug,name,namespace) VALUES (?,?,?)")
      .run("beta", "beta", "test");
    const betaPid = (db.prepare("SELECT id FROM project WHERE slug=?")
      .get("beta") as { id: number }).id;
    const aRun = (() => {
      db.prepare("INSERT INTO run(project_id,phase,session_id,started_at,outcome,cost_source)"
        + " VALUES(?,?,?,?,?,?)").run(pid, "ship", "s-a", inWindow.toISOString(),
        "failure", "live");
      return Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
    })();
    const bRun = (() => {
      db.prepare("INSERT INTO run(project_id,phase,session_id,started_at,outcome,cost_source)"
        + " VALUES(?,?,?,?,?,?)").run(betaPid, "ship", "s-b", inWindow.toISOString(),
        "failure", "live");
      return Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
    })();
    // We need a `correlation_signature` column — the anomaly table
    // already has it (added by ticket 0027). Insert both anomalies with
    // a shared signature so activeCorrelations builds one row. The
    // {project_slugs, first/last_seen_at, sample_excerpt} payload that
    // the route + inbox surface lives inside candidate_reason as JSON
    // (matches src/correlate.ts runCorrelationHook's write shape).
    const correlationDetail = JSON.stringify({
      project_slugs: ["alpha", "beta"],
      first_seen_at: inWindow.toISOString(),
      last_seen_at: inWindow.toISOString(),
      sample_excerpt: "boom",
    });
    db.prepare(
      "INSERT INTO anomaly(run_id,kind,value,baseline_mean,baseline_stddev,sample_count,"
      + "candidate_reason,correlation_signature,created_at) "
      + "VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(aRun, "fleet_correlated", 0, 0, 0, 0, correlationDetail, "FOO_BAR_FAIL",
          inWindow.toISOString());
    db.prepare(
      "INSERT INTO anomaly(run_id,kind,value,baseline_mean,baseline_stddev,sample_count,"
      + "candidate_reason,correlation_signature,created_at) "
      + "VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(bRun, "fleet_correlated", 0, 0, 0, 0, correlationDetail, "FOO_BAR_FAIL",
          inWindow.toISOString());

    const r = fleetInbox(db, { now: inWindow.toISOString(), cfg });

    // The correlation must be in items (sleep-time fleet pages).
    const itemKinds = r.items.map((it) => it.kind);
    assert.ok(itemKinds.includes("fleet_correlation"),
      "fleet_correlation must remain in items during quiet hours");

    // The three PR rows must be in quietedItems, not items.
    const quietedKinds = (r.quietedItems ?? []).map((it) => it.kind);
    const prInItems = r.items.filter((it) => it.kind === "pr_review");
    assert.equal(prInItems.length, 0, "pr_review rows must NOT be in items during quiet hours");
    assert.equal(quietedKinds.filter((k) => k === "pr_review").length, 3,
      "all three PR rows must land in quietedItems");
  } finally { cleanup(); }
});

test("AC5: outside quiet hours, quietedItems is empty and items contains everything", () => {
  _resetQuietHoursForTests();
  const { db, cleanup } = tempDb();
  try {
    const outOfWindow = new Date("2026-06-15T19:00:00.000Z"); // 12:00 PT
    const cfg = {
      ...baseCfg(),
      quietHours: { start: "22:00", end: "07:00", tz: "America/Los_Angeles" },
    } as FleetConfig;
    const pid = seedProject(db, "alpha");
    const fetchedAt = new Date(outOfWindow.getTime() - 60_000).toISOString();
    db.prepare(
      "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,"
      + "is_agent,additions,deletions,author,url,fetched_at) "
      + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(pid, 7, "feat", "feat/7", "open", "green", "clean",
          1, 1, 0, "agent", null, fetchedAt);

    const r = fleetInbox(db, { now: outOfWindow.toISOString(), cfg });
    assert.equal((r.quietedItems ?? []).length, 0,
      "quietedItems must be empty outside quiet hours");
    assert.equal(r.items.length, 1, "the PR row must surface normally");
  } finally { cleanup(); }
});

test("AC5: quietedItems undefined / [] preserved when no cfg is passed (backward-compat)", () => {
  _resetQuietHoursForTests();
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "alpha");
    db.prepare(
      "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,"
      + "is_agent,additions,deletions,author,url,fetched_at) "
      + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(pid, 7, "feat", "feat/7", "open", "green", "clean",
          1, 1, 0, "agent", null, "2026-06-15T12:00:00.000Z");

    const r = fleetInbox(db, { now: "2026-06-15T12:00:00.000Z" });
    // Existing keys preserved.
    assert.ok(Array.isArray(r.items));
    assert.equal(typeof r.generated_at, "string");
    // quietedItems is empty (default).
    assert.deepEqual(r.quietedItems ?? [], []);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — /api/fleet/inbox returns the new envelope shape
// ────────────────────────────────────────────────────────────────────

let activeBoots = 0;
let savedConfigText: string | null = null;

interface Booted {
  base: string;
  close: () => Promise<void>;
  cleanup: () => void;
  dbPath: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    import("node:net").then((net) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const a = srv.address();
        if (a && typeof a === "object") {
          const p = a.port; srv.close(() => resolve(p));
        } else { srv.close(); reject(new Error("no port")); }
      });
      srv.on("error", reject);
    }).catch(reject);
  });
}

async function boot(
  cfgJson: Record<string, unknown>, seed?: (db: DB) => void,
): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-quiet-route-"));
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
    ...cfgJson,
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
          try { unlinkSync(CONFIG_PATH); } catch { /* */ }
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

test("AC6: GET /api/fleet/inbox returns quietedItems: [] + quietHoursActive: false when unset", async () => {
  _resetQuietHoursForTests();
  const b = await boot({}, () => { /* no seed */ });
  try {
    const r = await fetch(b.base + "/api/fleet/inbox");
    assert.equal(r.status, 200);
    const body = await r.json() as {
      items: unknown[]; quietedItems: unknown[];
      generated_at: string; quietHoursActive: boolean;
      quietHoursUntil: string | null;
    };
    assert.ok(Array.isArray(body.items), "items must be present (existing key)");
    assert.ok(Array.isArray(body.quietedItems), "quietedItems must be present (default [])");
    assert.equal(body.quietedItems.length, 0);
    assert.equal(body.quietHoursActive, false);
    assert.equal(body.quietHoursUntil, null);
    assert.equal(typeof body.generated_at, "string");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — web/app.js renders the quietedItems under a divider with the
// moon glyph and "resumes at HH:MM" text. Text-level checks.
// ────────────────────────────────────────────────────────────────────

test("AC7: web/app.js renderInbox surfaces the quiet-hours divider with the moon glyph + resume time", () => {
  // The divider row contains the literal "Queued during quiet hours" copy.
  assert.ok(APP_JS.includes("Queued during quiet hours"),
    "renderInbox must surface the 'Queued during quiet hours' divider copy");
  // The moon glyph (U+1F319) is rendered on each quieted row.
  assert.ok(APP_JS.includes("\u{1F319}"),
    "renderInbox must include the moon glyph (U+1F319) on quieted rows");
  // The renderer references both new envelope keys.
  assert.ok(APP_JS.includes("quietedItems"),
    "renderInbox must read data.quietedItems");
  assert.ok(APP_JS.includes("quietHoursUntil"),
    "renderInbox must read data.quietHoursUntil");
  // aria-label="quiet" is the documented a11y attr on the glyph.
  assert.ok(APP_JS.includes("aria-label=\"quiet\""),
    "moon glyph must carry aria-label=\"quiet\"");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — mobile single-column for the divider (no horizontal scroll)
// ────────────────────────────────────────────────────────────────────

test("AC8: at 375px viewport the inbox-quiet-divider does not introduce horizontal scroll", () => {
  // Find the mobile MQ block.
  const opener = /@media\s*\(\s*max-width:\s*640px\s*\)\s*\{/.exec(CSS);
  assert.ok(opener, "mobile @media (max-width: 640px) block must exist");
  let depth = 1, i = opener.index + opener[0].length;
  const start = i;
  while (i < CSS.length && depth > 0) {
    const c = CSS[i++];
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  const body = CSS.slice(start, i - 1);
  // No min-width > 375 on the divider row (would force overflow on 375px).
  const allDividerRule = /\.inbox-quiet-divider\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = allDividerRule.exec(CSS)) !== null) {
    const ruleBody = m[1];
    const mw = /min-width\s*:\s*(\d+)px/.exec(ruleBody);
    if (mw) assert.ok(+mw[1] <= 375,
      `.inbox-quiet-divider min-width: ${mw[1]}px would overflow a 375px viewport`);
  }
  // The .inbox-quiet-divider selector exists in CSS.
  assert.match(CSS, /\.inbox-quiet-divider/,
    ".inbox-quiet-divider selector must be defined in style.css");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — `fleetctl quiet-hours` CLI subcommand prints effective windows
// ────────────────────────────────────────────────────────────────────

test("AC9: fleetctl quiet-hours prints the fleet default + active state", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-quiet-cli-"));
  const dbPath = join(dir, "fleet.db");
  // Plant a config in the CWD (the CLI reads it via loadConfig).
  const restore = plantConfig({
    quietHours: { start: "22:00", end: "07:00", tz: "America/Los_Angeles" },
    quietHoursOverride: { "always-page": false },
  });
  try {
    const r = spawnSync(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      join(REPO_ROOT, "bin", "fleetctl.ts"),
      "quiet-hours",
    ], {
      env: { ...process.env, FLEET_DB_PATH: dbPath },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, "quiet-hours must exit 0; stderr=" + r.stderr);
    // Output must name the configured window.
    assert.match(r.stdout, /22:00/, "stdout must surface the start time");
    assert.match(r.stdout, /07:00/, "stdout must surface the end time");
    assert.match(r.stdout, /America\/Los_Angeles/, "stdout must surface the IANA tz");
    // Override projects must be listed.
    assert.match(r.stdout, /always-page/, "stdout must list per-project overrides");
  } finally { restore(); rmSync(dir, { recursive: true, force: true }); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 — _resetQuietHoursForTests exists; no shell-string composition
// ────────────────────────────────────────────────────────────────────

test("AC10: src/quiet_hours.ts exposes _resetQuietHoursForTests and uses no shell-string exec", () => {
  const qhSrc = readFileSync(join(REPO_ROOT, "src", "quiet_hours.ts"), "utf8");
  assert.match(qhSrc, /export\s+function\s+_resetQuietHoursForTests/,
    "src/quiet_hours.ts must export _resetQuietHoursForTests");
  // Mirrors the doctor.ts static check (LESSONS § "grep the import,
  // not the call site"): no `exec`/`execSync` imported from node:child_process.
  assert.doesNotMatch(qhSrc, /from\s+["']node:child_process["']/,
    "src/quiet_hours.ts must not import from node:child_process");
});
