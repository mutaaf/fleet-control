// Tests for ticket 0074 - First-week new-operator coach card.
//
// One test() per acceptance-criteria checkbox in
// docs/backlog/0074-first-week-new-operator-coach-card.md.
//
// Strategy per LESSONS:
//   - LESSONS 2026-05-29: every fixture timestamp anchors on the
//     pinned NOW constant.
//   - LESSONS 2026-06-11: branch tests drive _renderCoachCardForTests
//     directly so the renderer branches do not race
//     fleet-control.config.json in parallel test files.
//   - LESSONS 2026-06-13: per-day fixtures seed enough trailing data
//     that the day-specific deep-link target resolves.
//   - LESSONS 2026-06-19: the cfg.coach.disabled parser test runs in
//     a subprocess pinned to a tmpdir cwd.
//   - LESSONS 2026-06-23: every boot() resets the coach memo cache so
//     a prior test's DB does not leak into this boot's cached value.
//
// PRODUCER-VS-SPEC reconciliations (per ticket Implementation log):
//   - inbox_dismissal.project_slug uses 'fleet' (matches the
//     anniversary precedent at server.ts:1262), not '' (empty).
//   - lessonsPublicArchive is imported from src/lessons.ts and takes
//     opts (no db arg). Top-cited slug comes via lessonCreditRollup's
//     top_earner.lesson_slug.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync,
  unlinkSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { openDb, type DB } from "../src/db.ts";
import type { FleetConfig } from "../src/config.ts";
import {
  newOperatorCoachTip,
  renderCoachCard,
  _renderCoachCardForTests,
  type CoachTipPayload,
} from "../src/views.ts";
import {
  startServer,
  _resetCoachCacheForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SERVER_TS = readFileSync(join(REPO_ROOT, "src", "server.ts"), "utf8");
const VIEWS_TS = readFileSync(join(REPO_ROOT, "src", "views.ts"), "utf8");
const CONFIG_TS = readFileSync(join(REPO_ROOT, "src", "config.ts"), "utf8");

// Pinned anchor for arithmetic. Per LESSONS 2026-05-29 every
// fixture timestamp arithmetic-derives from this anchor.
const NOW = new Date("2026-06-23T12:00:00.000Z");

// ────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-coach-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, path, cleanup: () => { try { db.close(); } catch { /* */ } rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
  ).run(slug, slug, "test", null);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

function seedMergedAgentPr(db: DB, projectId: number, num: number, fetchedAt: string): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,"
    + "is_agent,additions,deletions,author,url,fetched_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    projectId, num, "pr-" + num, "feat/" + num,
    "MERGED", "green", null, 1, 0, 0, "alice",
    "https://github.com/owner/x/pull/" + num, fetchedAt,
  );
}

function seedInstallDate(db: DB, daysAgo: number): void {
  const installAt = new Date(NOW.getTime() - daysAgo * 24 * 3600_000).toISOString();
  db.prepare(
    "INSERT INTO operator_install_milestones(kind, recorded_at, payload_json) VALUES (?,?,?)",
  ).run("install_date", installAt, JSON.stringify({}));
}

function seedAnyProjectWithPr(db: DB, daysAgo = 1): void {
  const pid = seedProject(db, "alpha");
  const fetchedAt = new Date(NOW.getTime() - daysAgo * 24 * 3600_000).toISOString();
  seedMergedAgentPr(db, pid, 1, fetchedAt);
}

function makeCfg(extra?: Partial<FleetConfig>): FleetConfig {
  return {
    projectRoots: [],
    installedRoot: "/tmp/empty",
    dbPath: "/tmp/empty/fleet.db",
    cacheBase: "/tmp/empty",
    claudeProjects: "/tmp/empty",
    host: "127.0.0.1",
    port: 7070,
    ...(extra ?? {}),
  };
}

// ────────────────────────────────────────────────────────────────────
// AC: helper shape + 7-day window + opt-out + graduated
// ────────────────────────────────────────────────────────────────────

test("AC: newOperatorCoachTip helper returns the documented payload shape on a 2-days-ago install (day 3)", () => {
  const ctx = tempDb();
  try {
    const cfg = makeCfg();
    seedAnyProjectWithPr(ctx.db, 1);
    seedInstallDate(ctx.db, 2);
    const p = newOperatorCoachTip(ctx.db, cfg, NOW);
    assert.equal(p.kind, "coach", "kind MUST be 'coach' on day 3 of 7");
    assert.equal(p.day, 3, "day MUST be 3 (install was 2 days ago; day 1 was install day)");
    assert.equal(typeof p.headline, "string");
    assert.equal(typeof p.action, "string");
    assert.equal(typeof p.ctaLabel, "string");
    assert.equal(typeof p.deepLink, "string");
    assert.equal(typeof p.asOf, "string");
    assert.equal(p.version, 1);
  } finally { ctx.cleanup(); }
});

test("AC: graduated branch fires when install_date is 10 days ago", () => {
  const ctx = tempDb();
  try {
    const cfg = makeCfg();
    seedAnyProjectWithPr(ctx.db, 1);
    seedInstallDate(ctx.db, 10);
    const p = newOperatorCoachTip(ctx.db, cfg, NOW);
    assert.equal(p.kind, "graduated", "kind MUST be 'graduated' on day 11 (past day 7)");
  } finally { ctx.cleanup(); }
});

test("AC: opt-out gate - cfg.coach.disabled=true short-circuits to kind='none'", () => {
  const ctx = tempDb();
  try {
    seedAnyProjectWithPr(ctx.db, 1);
    seedInstallDate(ctx.db, 2);
    const cfg = makeCfg({ coach: { disabled: true } });
    const p = newOperatorCoachTip(ctx.db, cfg, NOW);
    assert.equal(p.kind, "none", "opt-out MUST short-circuit to kind='none'");
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC: dismissal gate - day-N dismissal suppresses TODAY but not
// tomorrow's day N+1.
// ────────────────────────────────────────────────────────────────────

test("AC: dismissal gate - inbox_dismissal row for day_3 suppresses kind to 'none' today", () => {
  const ctx = tempDb();
  try {
    const cfg = makeCfg();
    seedAnyProjectWithPr(ctx.db, 1);
    seedInstallDate(ctx.db, 2);
    // Confirm baseline: day 3 fires.
    let p = newOperatorCoachTip(ctx.db, cfg, NOW);
    assert.equal(p.kind, "coach");
    assert.equal(p.day, 3);

    // Seed dismissal for day_3.
    ctx.db.prepare(
      "INSERT INTO inbox_dismissal(kind, project_slug, payload_id, dismissed_at)"
      + " VALUES('coach_tip', 'fleet', 'day_3', ?)",
    ).run(NOW.toISOString());

    p = newOperatorCoachTip(ctx.db, cfg, NOW);
    assert.equal(p.kind, "none", "dismissed day_3 MUST yield kind='none'");
  } finally { ctx.cleanup(); }
});

test("AC: dismissal does NOT cascade - day_3 dismissed but next day (day 4) still fires", () => {
  const ctx = tempDb();
  try {
    const cfg = makeCfg();
    seedAnyProjectWithPr(ctx.db, 1);
    seedInstallDate(ctx.db, 2);
    // Dismiss day_3.
    ctx.db.prepare(
      "INSERT INTO inbox_dismissal(kind, project_slug, payload_id, dismissed_at)"
      + " VALUES('coach_tip', 'fleet', 'day_3', ?)",
    ).run(NOW.toISOString());
    // Advance 24h.
    const tomorrow = new Date(NOW.getTime() + 24 * 3600_000);
    const p = newOperatorCoachTip(ctx.db, cfg, tomorrow);
    assert.equal(p.kind, "coach", "day 4 MUST still fire");
    assert.equal(p.day, 4);
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC: 7 hard-coded tips - each day has the documented keywords.
// ────────────────────────────────────────────────────────────────────

test("AC: each of the 7 days yields the documented keywords in headline/action/deepLink", () => {
  // Per the ticket spec the day-N keywords are stable. We drive the
  // helper by varying install date so each day-N branch fires.
  const expectations: Array<{ day: number; mustContain: RegExp; deepLink: RegExp }> = [
    { day: 1, mustContain: /publicHost/i, deepLink: /#operator-publichost/i },
    { day: 2, mustContain: /share/i, deepLink: /#fleetctl-share/i },
    { day: 3, mustContain: /phone|pair/i, deepLink: /#lan-access-auth/i },
    { day: 4, mustContain: /PR|merge|inbox/i, deepLink: /\/#?\/?$|inbox/i },
    { day: 5, mustContain: /lesson/i, deepLink: /\/lessons-public\//i },
    { day: 6, mustContain: /quiet|glance/i, deepLink: /#quiet-hours/i },
    { day: 7, mustContain: /portfolio|export/i, deepLink: /#fleetctl-export/i },
  ];
  for (const exp of expectations) {
    const ctx = tempDb();
    try {
      const cfg = makeCfg();
      seedAnyProjectWithPr(ctx.db, 1);
      // day 1 = install day; day N is N-1 days after install.
      seedInstallDate(ctx.db, exp.day - 1);
      const p = newOperatorCoachTip(ctx.db, cfg, NOW);
      assert.equal(p.kind, "coach", "day " + exp.day + " kind MUST be 'coach'");
      assert.equal(p.day, exp.day, "computed day MUST be " + exp.day);
      const joined = p.headline + " " + p.action + " " + p.ctaLabel;
      assert.match(
        joined, exp.mustContain,
        "day " + exp.day + " copy MUST mention " + exp.mustContain + "; got " + joined,
      );
      assert.match(
        p.deepLink, exp.deepLink,
        "day " + exp.day + " deepLink MUST match " + exp.deepLink + "; got " + p.deepLink,
      );
    } finally { ctx.cleanup(); }
  }
});

// ────────────────────────────────────────────────────────────────────
// AC: Day-5 deep-link fallback.
// ────────────────────────────────────────────────────────────────────

test("AC: day-5 deepLink falls back to /lessons-public/ when there are 0 lesson_credit entries", () => {
  const ctx = tempDb();
  try {
    const cfg = makeCfg();
    seedAnyProjectWithPr(ctx.db, 1);
    seedInstallDate(ctx.db, 4); // day 5
    const p = newOperatorCoachTip(ctx.db, cfg, NOW);
    assert.equal(p.day, 5);
    assert.equal(p.deepLink, "/lessons-public/",
      "day 5 with 0 lessons MUST fall back to /lessons-public/");
  } finally { ctx.cleanup(); }
});

test("AC: day-5 deepLink targets the top-cited slug when lesson_credit rollup has entries", () => {
  const ctx = tempDb();
  try {
    const cfg = makeCfg();
    seedAnyProjectWithPr(ctx.db, 1);
    seedInstallDate(ctx.db, 4); // day 5
    // Seed lesson_credit rows so the rollup has a top entry.
    // The rollup orders by saves DESC; we seed three lessons, the
    // top one with 5 saves, the others with 1.
    const baseTs = new Date(NOW.getTime() - 1 * 3600_000).toISOString();
    // Seed a control_audit parent row each lesson_credit row references
    // via FK (heal_audit_id REFERENCES control_audit(id)). We seed
    // distinct audit rows for distinct saves.
    let auditId = 1;
    function insertAudit(): number {
      ctx.db.prepare(
        "INSERT INTO control_audit(ts, actor, action, target, args_json, exit_code, stdout_tail) "
        + " VALUES(?,?,?,?,?,?,?)",
      ).run(baseTs, "agent", "heal", "alpha", "{}", 0, "ok");
      const row = ctx.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
      return row.id;
    }
    function insertCredit(slug: string, audit: number): void {
      ctx.db.prepare(
        "INSERT INTO lesson_credit(lesson_slug, lesson_date, lesson_title, heal_audit_id, project_slug, matched_substring, created_at) "
        + " VALUES(?,?,?,?,?,?,?)",
      ).run(slug, "2026-05-01", "title-" + slug, audit, "alpha", "match", baseTs);
    }
    for (let i = 0; i < 5; i++) {
      auditId = insertAudit();
      insertCredit("top-cited-lesson", auditId);
    }
    auditId = insertAudit();
    insertCredit("other-lesson-1", auditId);
    auditId = insertAudit();
    insertCredit("other-lesson-2", auditId);

    const p = newOperatorCoachTip(ctx.db, cfg, NOW);
    assert.equal(p.day, 5);
    assert.equal(p.deepLink, "/lessons-public/top-cited-lesson",
      "day 5 deepLink MUST target /lessons-public/<top-cited-slug>; got " + p.deepLink);
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC: No-install-date fallback - MIN(pr.fetched_at) synthesises the
// install_date when missing.
// ────────────────────────────────────────────────────────────────────

test("AC: no install_date + PRs present synthesises install_date from MIN(pr.fetched_at) and writes the row", () => {
  const ctx = tempDb();
  try {
    const cfg = makeCfg();
    const pid = seedProject(ctx.db, "alpha");
    // 5 PRs the oldest of which is 3 days ago (= day 4).
    for (let i = 0; i < 5; i++) {
      const d = new Date(NOW.getTime() - (3 - 0.4 * i) * 24 * 3600_000);
      seedMergedAgentPr(ctx.db, pid, 100 + i, d.toISOString());
    }
    // Confirm: no install_date row yet.
    const before = ctx.db.prepare(
      "SELECT recorded_at FROM operator_install_milestones WHERE kind='install_date'",
    ).get();
    assert.equal(before, undefined);
    const p = newOperatorCoachTip(ctx.db, cfg, NOW);
    assert.equal(p.kind, "coach");
    assert.equal(p.day, 4, "day MUST be 4 (oldest PR 3 days ago)");
    // The side-effect write planted an install_date row.
    const after = ctx.db.prepare(
      "SELECT recorded_at FROM operator_install_milestones WHERE kind='install_date'",
    ).get() as { recorded_at: string } | undefined;
    assert.ok(after, "install_date row MUST have been written by the side-effect");
  } finally { ctx.cleanup(); }
});

test("AC: truly empty DB (no install_date, no PRs) returns kind='none'", () => {
  const ctx = tempDb();
  try {
    const cfg = makeCfg();
    const p = newOperatorCoachTip(ctx.db, cfg, NOW);
    assert.equal(p.kind, "none",
      "empty DB MUST return kind='none' (no signal to compute a day from)");
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC: Renderer-direct seam - drives each of the 9 branches without
// booting startServer or mutating cwd config.
// ────────────────────────────────────────────────────────────────────

test("AC: _renderCoachCardForTests emits new-operator-coach-card + coach-day-N testids on each day-N payload", () => {
  for (let day = 1; day <= 7; day++) {
    const payload: CoachTipPayload = {
      kind: "coach",
      day: day as 1 | 2 | 3 | 4 | 5 | 6 | 7,
      headline: "day " + day + " of your fleet",
      action: "try the documented action",
      ctaLabel: "got it",
      deepLink: "/lessons-public/",
      asOf: NOW.toISOString(),
      version: 1,
    };
    const html = _renderCoachCardForTests(payload);
    assert.match(html, /data-testid=["']new-operator-coach-card["']/,
      "day " + day + " MUST carry new-operator-coach-card testid");
    const reDayN = new RegExp("data-testid=[\"']coach-day-" + day + "[\"']");
    assert.match(html, reDayN, "day " + day + " MUST carry coach-day-" + day + " testid");
  }
});

test("AC: _renderCoachCardForTests emits graduation testid on the graduated payload", () => {
  const payload: CoachTipPayload = {
    kind: "graduated",
    day: 7,
    headline: "you've completed your first week",
    action: "the home is yours from here",
    ctaLabel: "thanks",
    deepLink: "/",
    asOf: NOW.toISOString(),
    version: 1,
  };
  const html = _renderCoachCardForTests(payload);
  assert.match(html, /data-testid=["']coach-graduation-card["']/,
    "graduated payload MUST carry coach-graduation-card testid");
  // The coach-day-N testid MUST NOT appear on graduation.
  assert.equal(/data-testid=["']coach-day-\d+["']/.test(html), false,
    "graduation card MUST NOT carry coach-day-N testid");
});

test("AC: _renderCoachCardForTests emits empty string on kind='none' (no card rendered)", () => {
  const payload: CoachTipPayload = {
    kind: "none",
    day: 1,
    headline: "",
    action: "",
    ctaLabel: "",
    deepLink: "",
    asOf: NOW.toISOString(),
    version: 1,
  };
  const html = _renderCoachCardForTests(payload);
  assert.equal(html, "",
    "kind='none' MUST render the empty string (no testid present)");
});

test("AC: dismissed=true renders the empty string regardless of kind", () => {
  const payload: CoachTipPayload = {
    kind: "coach",
    day: 2,
    headline: "day 2",
    action: "try share",
    ctaLabel: "got it",
    deepLink: "#fleetctl-share",
    asOf: NOW.toISOString(),
    version: 1,
  };
  const html = _renderCoachCardForTests(payload, { dismissed: true });
  assert.equal(html, "",
    "dismissed=true MUST render the empty string");
});

// ────────────────────────────────────────────────────────────────────
// AC: Config field - cfg.coach?.disabled parses via loadConfig().
// Per LESSONS 2026-06-19 the parser test runs in a subprocess pinned
// to a tmpdir cwd; we NEVER write to the test runner's shared cwd.
// ────────────────────────────────────────────────────────────────────

test("AC: loadConfig() parses cfg.coach.disabled=true (subprocess pinned to tmpdir cwd)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-coach-config-"));
  const configPath = join(dir, "fleet-control.config.json");
  const dbPath = join(dir, "fleet.db");
  writeFileSync(configPath, JSON.stringify({
    coach: { disabled: true },
    projectRoots: [dir],
    installedRoot: dir,
    cacheBase: dir,
    claudeProjects: dir,
  }));
  try {
    const configAbs = join(REPO_ROOT, "src", "config.ts");
    const script = "import { loadConfig } from "
      + JSON.stringify(configAbs)
      + "; const c = loadConfig(); process.stdout.write(JSON.stringify({ coach: c.coach }));";
    const out = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
      { cwd: dir, env: { ...process.env, FLEET_DB_PATH: dbPath }, encoding: "utf8" },
    );
    assert.equal(out.status, 0, "subprocess MUST exit 0; stderr=" + out.stderr);
    const parsed = JSON.parse(out.stdout);
    assert.deepEqual(parsed.coach, { disabled: true },
      "loadConfig() MUST surface cfg.coach.disabled=true; got " + JSON.stringify(parsed));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────
// Static contract: cfg.coach type declared in src/config.ts.
// ────────────────────────────────────────────────────────────────────

test("AC: src/config.ts declares the cfg.coach?: { disabled?: boolean } field on FleetConfig", () => {
  assert.match(CONFIG_TS, /coach\?:\s*\{[\s\S]*?disabled\?:\s*boolean[\s\S]*?\}/,
    "FleetConfig MUST declare optional coach?: { disabled?: boolean }");
});

// ────────────────────────────────────────────────────────────────────
// Static contract: views.ts exports newOperatorCoachTip + the
// _renderCoachCardForTests seam.
// ────────────────────────────────────────────────────────────────────

test("AC: src/views.ts exports newOperatorCoachTip and _renderCoachCardForTests", () => {
  assert.match(VIEWS_TS, /export function newOperatorCoachTip/,
    "views.ts MUST export newOperatorCoachTip");
  assert.match(VIEWS_TS, /export function _renderCoachCardForTests/,
    "views.ts MUST export _renderCoachCardForTests (LESSONS 2026-06-11 renderer-direct seam)");
});

// ────────────────────────────────────────────────────────────────────
// Static contract: server.ts wires the /api/fleet/coach + dismiss
// routes and registers the globalThis cache invalidation hook.
// ────────────────────────────────────────────────────────────────────

test("AC: server.ts mounts /api/fleet/coach and /api/coach/dismiss; registers globalThis.__fleet_coach_invalidate__", () => {
  assert.match(SERVER_TS, /\/api\/fleet\/coach/,
    "server.ts MUST mount /api/fleet/coach");
  assert.match(SERVER_TS, /\/api\/coach\/dismiss/,
    "server.ts MUST mount /api/coach/dismiss");
  assert.match(SERVER_TS, /__fleet_coach_invalidate__/,
    "server.ts MUST register globalThis.__fleet_coach_invalidate__ per LESSONS 2026-06-05");
});

// ────────────────────────────────────────────────────────────────────
// Integration: boot startServer; assert the JSON route + dismiss
// endpoint flow round-trips end to end.
// ────────────────────────────────────────────────────────────────────

interface Booted {
  base: string;
  close: () => Promise<void>;
  cleanup: () => void;
  dbPath: string;
}

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

async function boot(seed?: (db: DB) => void): Promise<Booted> {
  // Per LESSONS 2026-06-23 - reset the coach memo cache so a prior
  // boot's DB does not leak into this boot's cached value.
  _resetCoachCacheForTests();
  const dir = mkdtempSync(join(tmpdir(), "fleet-coach-boot-"));
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
  const server = startServer("127.0.0.1", port, { quietBanner: true });
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + "/api/whoami"); if (r.ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  return {
    base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    cleanup: () => {
      delete process.env.FLEET_DB_PATH;
      activeBoots -= 1;
      if (activeBoots === 0) {
        if (savedConfigText === null) {
          try { unlinkSync(CONFIG_PATH); } catch { /* gone */ }
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

test("AC: GET /api/fleet/coach surfaces day-2 payload when install_date is 1 day ago; POST /api/coach/dismiss flips dismissed", async () => {
  const b = await boot((db) => {
    db.prepare(
      "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
    ).run("alpha", "Alpha", "test", null);
    const pid = (db.prepare("SELECT id FROM project WHERE slug='alpha'").get() as { id: number }).id;
    db.prepare(
      "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,"
      + "is_agent,additions,deletions,author,url,fetched_at)"
      + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      pid, 1, "pr-1", "feat/1", "MERGED", "green", null, 1, 0, 0, "alice",
      "https://github.com/owner/x/pull/1",
      new Date(Date.now() - 12 * 3600_000).toISOString(),
    );
    // install_date 1 day ago -> day 2.
    db.prepare(
      "INSERT INTO operator_install_milestones(kind, recorded_at, payload_json) VALUES (?,?,?)",
    ).run("install_date", new Date(Date.now() - 24 * 3600_000).toISOString(), JSON.stringify({}));
  });
  try {
    const r1 = await fetch(b.base + "/api/fleet/coach");
    assert.equal(r1.status, 200, "GET /api/fleet/coach MUST 200; got " + r1.status);
    const j1: any = await r1.json();
    assert.equal(j1.kind, "coach", "MUST be on coach branch; got " + j1.kind);
    assert.equal(j1.day, 2, "MUST be day 2; got " + j1.day);
    assert.equal(j1.dismissed, false, "MUST be dismissed=false on first call");

    // POST dismiss for day 2.
    const r2 = await fetch(b.base + "/api/coach/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ day: 2 }),
    });
    assert.equal(r2.status, 200, "POST /api/coach/dismiss MUST 200; got " + r2.status);
    const j2: any = await r2.json();
    assert.equal(j2.ok, true, "dismiss response MUST be ok=true; got " + JSON.stringify(j2));

    // Confirm: inbox_dismissal row exists.
    const planDb = openDb(b.dbPath);
    try {
      const row = planDb.prepare(
        "SELECT kind, project_slug, payload_id FROM inbox_dismissal"
        + " WHERE kind='coach_tip' AND payload_id='day_2'",
      ).get();
      assert.ok(row, "inbox_dismissal row MUST exist for day_2 after POST");
    } finally { planDb.close(); }

    // Re-fetch: the dismissal hook MUST have invalidated the cache,
    // so the second call sees dismissed=true (kind='none' after gate).
    const r3 = await fetch(b.base + "/api/fleet/coach");
    const j3: any = await r3.json();
    assert.equal(j3.kind, "none",
      "after dismissal cache invalidation MUST surface kind='none'; got " + j3.kind);
  } finally { await b.close(); b.cleanup(); }
});

test("AC: GET /api/fleet/coach surfaces graduated payload when install_date is 10 days ago", async () => {
  const b = await boot((db) => {
    db.prepare(
      "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
    ).run("alpha", "Alpha", "test", null);
    const pid = (db.prepare("SELECT id FROM project WHERE slug='alpha'").get() as { id: number }).id;
    db.prepare(
      "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,"
      + "is_agent,additions,deletions,author,url,fetched_at)"
      + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      pid, 1, "pr-1", "feat/1", "MERGED", "green", null, 1, 0, 0, "alice",
      "https://github.com/owner/x/pull/1",
      new Date(Date.now() - 12 * 3600_000).toISOString(),
    );
    db.prepare(
      "INSERT INTO operator_install_milestones(kind, recorded_at, payload_json) VALUES (?,?,?)",
    ).run("install_date", new Date(Date.now() - 10 * 24 * 3600_000).toISOString(), JSON.stringify({}));
  });
  try {
    const r = await fetch(b.base + "/api/fleet/coach");
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.equal(j.kind, "graduated",
      "10-days-ago install MUST yield kind='graduated'; got " + j.kind);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC: Direct renderCoachCard exposure (the production renderer, not
// just the seam) keeps the same testid contract.
// ────────────────────────────────────────────────────────────────────

test("AC: production renderCoachCard emits the same testid contract as the seam", () => {
  const payload: CoachTipPayload = {
    kind: "coach",
    day: 5,
    headline: "day 5 of your fleet",
    action: "read your first cross-fleet lesson",
    ctaLabel: "open",
    deepLink: "/lessons-public/",
    asOf: NOW.toISOString(),
    version: 1,
  };
  const html = renderCoachCard(payload);
  assert.match(html, /data-testid=["']new-operator-coach-card["']/);
  assert.match(html, /data-testid=["']coach-day-5["']/);
});
