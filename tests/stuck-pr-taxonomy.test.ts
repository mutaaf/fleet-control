// Tests for ticket 0045 — Stuck-PR taxonomy card.
//
// One test(...) per acceptance-criteria checkbox. Strategy mirrors the
// 0040 riskiest-PR + 0044 spend-efficiency suites:
//   - Drive `stuckPrTaxonomy(db, now)` directly against a tmpdir DB for
//     the helper's shape + cascade arithmetic + edge cases.
//   - Boot `startServer()` over loopback for the route + cache tests,
//     using the empty-roots config + tmp fleet-control.config.json seam
//     from LESSONS § "in-process startServer() tests need an empty-roots
//     config + run-row seeds".
//   - SPA renderer tests are text-level over web/app.js + web/style.css
//     per the inbox / streak / glance / cost-per-pr / friday-wrap /
//     riskiest-PR / spend-efficiency precedent (zero jsdom).
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps from
// `new Date()`": every seed timestamp is anchored to the test's `NOW`
// constant via hoursBeforeNow / minutesBeforeNow helpers.
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`": row
// narrowing in the helper uses the double-cast (exercised transitively
// — if the cast regresses tsc fails before this file runs).
// Per LESSONS § "in-process dedup sets need an explicit reset hook for
// tests" + "expose a build counter for cache-hit tests, not a fetcher
// swap": the cache tests use the
// `_resetStuckPrTaxonomyCacheForTests()` +
// `_getStuckPrTaxonomyCacheBuildsForTests()` seams exported by
// src/server.ts.
//
// Zero new runtime deps; stdlib + node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync,
  unlinkSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../src/db.ts";
import {
  stuckPrTaxonomy,
  type StuckPrTaxonomy,
  type StuckPrBucket,
} from "../src/views.ts";
import {
  startServer,
  _resetStuckPrTaxonomyCacheForTests,
  _getStuckPrTaxonomyCacheBuildsForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers — pinned-now seeders.
// ────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-05T12:00:00.000Z");

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-stuck-pr-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string, name?: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace) VALUES (?,?,?)",
  ).run(slug, name ?? slug, "test");
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

interface OpenPrSeed {
  projectId: number;
  number: number;
  title?: string;
  ciState?: string;     // 'red' | 'pending' | 'green' | 'none'
  mergeState?: string | null; // gh raw e.g. 'CLEAN' | 'BEHIND' | 'DIRTY'
  isAgent?: number;
  fetchedAt: string;
  firstFailCheck?: string | null;
  healAttempts?: number;
}

function seedOpenPr(db: DB, opts: OpenPrSeed): void {
  db.prepare(
    "INSERT INTO pr("
    + "project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
    + "additions,deletions,author,url,fetched_at,gh_created_at,"
    + "first_fail_check,first_fail_excerpt,heal_attempts"
    + ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, opts.title ?? `pr-${opts.number}`,
    `feat/${opts.number}`,
    "open",
    opts.ciState ?? "green",
    opts.mergeState ?? null,
    opts.isAgent ?? 1,
    0, 0,
    "a", `https://github.com/owner/x/pull/${opts.number}`,
    opts.fetchedAt, opts.fetchedAt,
    opts.firstFailCheck ?? null, null,
    opts.healAttempts ?? 0,
  );
}

function seedHealAudit(db: DB, opts: {
  ts: string; prNumber: number; stdoutTail: string;
}): void {
  db.prepare(
    "INSERT INTO control_audit(ts,actor,action,target,args_json,exit_code,stdout_tail)"
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(
    opts.ts, "ship", "heal", `pr-${opts.prNumber}`, "{}", 1, opts.stdoutTail,
  );
}

/** ISO timestamp `h` hours BEFORE the pinned NOW. */
function hoursBeforeNow(h: number): string {
  return new Date(NOW.getTime() - h * 3600_000).toISOString();
}

/** ISO timestamp `m` minutes BEFORE the pinned NOW. */
function minutesBeforeNow(m: number): string {
  return new Date(NOW.getTime() - m * 60_000).toISOString();
}

/** Seed a PR for each of the 7 buckets against the same project. The
 *  seeds carry realistic surrounding signal (per LESSONS § "anomaly
 *  tests need sigma > 0 in the fixture") so a wrongly-ordered cascade
 *  fails noisily. Returns the project id. */
function seedOneOfEachBucket(db: DB): number {
  const p = seedProject(db, "alpha", "Alpha");
  // 1. needs_human: heal_attempts=2 + red+failing check.
  seedOpenPr(db, { projectId: p, number: 100, fetchedAt: hoursBeforeNow(20),
    ciState: "red", healAttempts: 2, firstFailCheck: "unit-tests" });
  seedHealAudit(db, { ts: hoursBeforeNow(2), prNumber: 100,
    stdoutTail: "AssertionError: expected 5 to equal 6" });
  // 2. account_suspended: heal_attempts=1, latest heal tail mentions
  //    the suspension regex.
  seedOpenPr(db, { projectId: p, number: 101, fetchedAt: hoursBeforeNow(10),
    ciState: "red", healAttempts: 1, firstFailCheck: "checkout" });
  seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 101,
    stdoutTail: "remote: Your account is suspended. Please visit https://support" });
  // 3. infra_flake: classifyPrFailure returns 'infra_flake' via the
  //    supabase port-bind pattern (LESSONS#0029).
  seedOpenPr(db, { projectId: p, number: 102, fetchedAt: hoursBeforeNow(8),
    ciState: "red", healAttempts: 1, firstFailCheck: "e2e" });
  seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 102,
    stdoutTail: "supabase start: failed to bind host port for 0.0.0.0:54322" });
  // 4. ci_red: ci_state='red' with no heal-audit (so classifier falls
  //    through to red_test, not infra_flake).
  seedOpenPr(db, { projectId: p, number: 103, fetchedAt: hoursBeforeNow(4),
    ciState: "red", healAttempts: 0, firstFailCheck: "lint" });
  // 5. ci_absent: ci_state='none' + age > 5min.
  seedOpenPr(db, { projectId: p, number: 104, fetchedAt: minutesBeforeNow(12),
    ciState: "none", healAttempts: 0 });
  // 6. merging: merge_state='CLEAN' + ci_state='green'.
  seedOpenPr(db, { projectId: p, number: 105, fetchedAt: hoursBeforeNow(2),
    ciState: "green", mergeState: "CLEAN", healAttempts: 0 });
  // 7. healthy_waiting: green, age<6h, 0 heals.
  seedOpenPr(db, { projectId: p, number: 106, fetchedAt: hoursBeforeNow(3),
    ciState: "green", healAttempts: 0 });
  return p;
}

// ────────────────────────────────────────────────────────────────────
// AC1 — stuckPrTaxonomy returns the documented shape; rows sorted by
//        urgency_rank ASC then age_hours DESC within bucket;
//        by_bucket carries every bucket with a 0 default.
// ────────────────────────────────────────────────────────────────────

test("AC1: stuckPrTaxonomy seeds 7 open PRs (one per bucket), returns each row's bucket", () => {
  const { db, cleanup } = tempDb();
  try {
    seedOneOfEachBucket(db);
    const result = stuckPrTaxonomy(db, NOW);
    assert.equal(result.open_count, 7, `open_count=${result.open_count}`);
    // by_bucket carries every key with at least zero so the SPA can
    // render without an "is-defined" check.
    const expectedKeys: StuckPrBucket[] = [
      "needs_human", "ci_red", "ci_absent", "infra_flake",
      "account_suspended", "merging", "healthy_waiting",
    ];
    for (const k of expectedKeys) {
      assert.ok(k in result.by_bucket, `by_bucket missing ${k}`);
      assert.equal(result.by_bucket[k], 1, `${k} bucket should have count 1`);
    }
    // Each PR landed in its expected bucket.
    const byPrNumber = new Map(result.rows.map((r) => [r.pr_number, r]));
    assert.equal(byPrNumber.get(100)?.bucket, "needs_human");
    assert.equal(byPrNumber.get(101)?.bucket, "account_suspended");
    assert.equal(byPrNumber.get(102)?.bucket, "infra_flake");
    assert.equal(byPrNumber.get(103)?.bucket, "ci_red");
    assert.equal(byPrNumber.get(104)?.bucket, "ci_absent");
    assert.equal(byPrNumber.get(105)?.bucket, "merging");
    assert.equal(byPrNumber.get(106)?.bucket, "healthy_waiting");
    assert.ok(result.generated_at && /^\d{4}-\d{2}-\d{2}T/.test(result.generated_at));
  } finally { cleanup(); }
});

test("AC1: stuckPrTaxonomy returns empty payload + zero buckets when no open PRs exist", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "calm");
    const result = stuckPrTaxonomy(db, NOW);
    assert.equal(result.open_count, 0);
    assert.deepEqual(result.rows, []);
    const buckets: StuckPrBucket[] = [
      "needs_human", "ci_red", "ci_absent", "infra_flake",
      "account_suspended", "merging", "healthy_waiting",
    ];
    for (const k of buckets) {
      assert.equal(result.by_bucket[k], 0, `${k} must default to 0`);
    }
  } finally { cleanup(); }
});

test("AC1: stuckPrTaxonomy sorts rows by urgency_rank ASC then age_hours DESC", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    // Three healthy_waiting at different ages — order should be age DESC.
    seedOpenPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(1), ciState: "green" });
    seedOpenPr(db, { projectId: p, number: 2, fetchedAt: hoursBeforeNow(5), ciState: "green" });
    seedOpenPr(db, { projectId: p, number: 3, fetchedAt: hoursBeforeNow(3), ciState: "green" });
    const result = stuckPrTaxonomy(db, NOW);
    assert.equal(result.rows.length, 3);
    // All healthy_waiting → urgency_rank=6 for each. Within bucket: 5h, 3h, 1h.
    assert.equal(result.rows[0].pr_number, 2, "5h-old should come first");
    assert.equal(result.rows[1].pr_number, 3, "3h-old should come second");
    assert.equal(result.rows[2].pr_number, 1, "1h-old should come last");
  } finally { cleanup(); }
});

test("AC1: stuckPrTaxonomy ignores non-agent PRs entirely", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedOpenPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(2),
      ciState: "red", healAttempts: 5, isAgent: 0 });
    seedOpenPr(db, { projectId: p, number: 2, fetchedAt: hoursBeforeNow(1),
      ciState: "green", healAttempts: 0, isAgent: 1 });
    const result = stuckPrTaxonomy(db, NOW);
    assert.equal(result.open_count, 1);
    assert.equal(result.rows[0].pr_number, 2);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — Bucket cascade is deterministic & evaluated top-down. Each
//        rule wins over any later rule; evidence strings carry the
//        documented substrings.
// ────────────────────────────────────────────────────────────────────

test("AC2: needs_human wins when heal_attempts >= 2 even with a red/infra signal", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    // Heal cap reached AND an infra-flake stdout. needs_human wins.
    seedOpenPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(2),
      ciState: "red", healAttempts: 2, firstFailCheck: "unit" });
    seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 1,
      stdoutTail: "supabase start: failed to bind host port for 0.0.0.0:54322" });
    const r = stuckPrTaxonomy(db, NOW);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].bucket, "needs_human");
    assert.match(r.rows[0].evidence, /2 heals/);
    assert.match(r.rows[0].evidence, /cap/);
    assert.equal(r.rows[0].next_action, "open & fix");
  } finally { cleanup(); }
});

test("AC2: account_suspended evidence carries the retry count", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedOpenPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(3),
      ciState: "red", healAttempts: 1, firstFailCheck: "checkout" });
    seedHealAudit(db, { ts: hoursBeforeNow(2), prNumber: 1,
      stdoutTail: "remote: Your account is suspended. Visit https://support.github.com" });
    seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 1,
      stdoutTail: "remote: Your account is suspended. Visit https://support.github.com" });
    const r = stuckPrTaxonomy(db, NOW);
    assert.equal(r.rows[0].bucket, "account_suspended");
    assert.match(r.rows[0].evidence, /account suspended/i);
    assert.match(r.rows[0].evidence, /2x/);
    assert.match(r.rows[0].next_action, /external/i);
  } finally { cleanup(); }
});

test("AC2: infra_flake fires from classifyPrFailure for a 502 stdout", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedOpenPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(2),
      ciState: "red", healAttempts: 1, firstFailCheck: "graphql" });
    seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 1,
      stdoutTail: "HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)" });
    const r = stuckPrTaxonomy(db, NOW);
    assert.equal(r.rows[0].bucket, "infra_flake");
    assert.match(r.rows[0].evidence, /502/i);
    assert.match(r.rows[0].evidence, /1 heal\b/);
    assert.match(r.rows[0].next_action, /wait/i);
  } finally { cleanup(); }
});

test("AC2: ci_red fires when ci_state='red' with no heal-audit", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedOpenPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(1),
      ciState: "red", healAttempts: 0, firstFailCheck: "lint-check" });
    const r = stuckPrTaxonomy(db, NOW);
    assert.equal(r.rows[0].bucket, "ci_red");
    assert.match(r.rows[0].evidence, /lint-check/);
    assert.match(r.rows[0].next_action, /check log/i);
  } finally { cleanup(); }
});

test("AC2: ci_absent fires for ci_state='none' AND age >= 5min; under 5min stays healthy_waiting", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    // Old enough → ci_absent.
    seedOpenPr(db, { projectId: p, number: 1, fetchedAt: minutesBeforeNow(10),
      ciState: "none", healAttempts: 0 });
    // Brand new → still healthy_waiting (under 5min floor).
    seedOpenPr(db, { projectId: p, number: 2, fetchedAt: minutesBeforeNow(1),
      ciState: "none", healAttempts: 0 });
    const r = stuckPrTaxonomy(db, NOW);
    const byNum = new Map(r.rows.map((row) => [row.pr_number, row]));
    assert.equal(byNum.get(1)?.bucket, "ci_absent");
    assert.match(byNum.get(1)!.evidence, /no checks queued/i);
    assert.match(byNum.get(1)!.next_action, /close.*reopen/i);
    assert.equal(byNum.get(2)?.bucket, "healthy_waiting");
  } finally { cleanup(); }
});

test("AC2: merging fires for merge_state='CLEAN' AND ci_state='green'", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedOpenPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(1),
      ciState: "green", mergeState: "CLEAN", healAttempts: 0 });
    const r = stuckPrTaxonomy(db, NOW);
    assert.equal(r.rows[0].bucket, "merging");
    assert.match(r.rows[0].evidence, /CLEAN/);
    assert.match(r.rows[0].next_action, /leave it/i);
  } finally { cleanup(); }
});

test("AC2: healthy_waiting is the default for green, no heals, age < 6h", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedOpenPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(3),
      ciState: "green", healAttempts: 0 });
    const r = stuckPrTaxonomy(db, NOW);
    assert.equal(r.rows[0].bucket, "healthy_waiting");
    assert.match(r.rows[0].evidence, /awaiting review/i);
    assert.match(r.rows[0].next_action, /leave it/i);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — GET /api/fleet/stuck-pr-taxonomy — loopback returns 200 with
//        the documented shape; zero PRs → open_count:0 + rows:[].
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
  const dir = mkdtempSync(join(tmpdir(), "fleet-stuck-pr-boot-"));
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
  const base = `http://127.0.0.1:${port}`;
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

test("AC3: GET /api/fleet/stuck-pr-taxonomy on loopback returns 200 with 7 bucket-labelled rows", async () => {
  _resetStuckPrTaxonomyCacheForTests();
  const b = await boot((db) => { seedOneOfEachBucket(db); });
  try {
    const r = await fetch(b.base + "/api/fleet/stuck-pr-taxonomy");
    assert.equal(r.status, 200);
    const j = await r.json() as StuckPrTaxonomy & { quiet_hours_active: boolean };
    assert.equal(j.open_count, 7);
    assert.equal(j.rows.length, 7);
    // First row must be the needs_human one (urgency_rank=0).
    assert.equal(j.rows[0].bucket, "needs_human");
    // Spot-check that every bucket has count 1.
    assert.equal(j.by_bucket.needs_human, 1);
    assert.equal(j.by_bucket.account_suspended, 1);
    assert.equal(j.by_bucket.merging, 1);
    // quiet_hours_active is part of the response payload.
    assert.equal(typeof j.quiet_hours_active, "boolean");
  } finally { await b.close(); b.cleanup(); }
});

test("AC3: GET /api/fleet/stuck-pr-taxonomy returns open_count:0 + rows:[] when no PRs exist", async () => {
  _resetStuckPrTaxonomyCacheForTests();
  const b = await boot((db) => { seedProject(db, "quiet"); });
  try {
    const r = await fetch(b.base + "/api/fleet/stuck-pr-taxonomy");
    assert.equal(r.status, 200);
    const j = await r.json() as StuckPrTaxonomy;
    assert.equal(j.open_count, 0);
    assert.deepEqual(j.rows, []);
    // Every bucket present with zero.
    const buckets: StuckPrBucket[] = [
      "needs_human", "ci_red", "ci_absent", "infra_flake",
      "account_suspended", "merging", "healthy_waiting",
    ];
    for (const k of buckets) assert.equal(j.by_bucket[k], 0);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — Caching: max-age=30 header + module-level memo via
//        (MAX(pr.fetched_at), COUNT(*), MAX(audit.ts)) tuple.
// ────────────────────────────────────────────────────────────────────

test("AC4: route sets cache-control: max-age=30 and memoises within the window", async () => {
  _resetStuckPrTaxonomyCacheForTests();
  const b = await boot((db) => {
    const p = seedProject(db, "cached");
    seedOpenPr(db, { projectId: p, number: 1,
      fetchedAt: new Date(Date.now() - 8 * 3600_000).toISOString(),
      ciState: "green", healAttempts: 0 });
  });
  try {
    const before = _getStuckPrTaxonomyCacheBuildsForTests();
    const r1 = await fetch(b.base + "/api/fleet/stuck-pr-taxonomy");
    assert.equal(r1.status, 200);
    const cc = (r1.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=30/, `cache-control must declare max-age=30; got '${cc}'`);
    await r1.json();
    const afterFirst = _getStuckPrTaxonomyCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call → cache MISS → build counter += 1");

    const r2 = await fetch(b.base + "/api/fleet/stuck-pr-taxonomy");
    await r2.json();
    const afterSecond = _getStuckPrTaxonomyCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0,
      "second call within window → cache HIT, counter unchanged");
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: a new heal-audit row busts the cache", async () => {
  _resetStuckPrTaxonomyCacheForTests();
  const b = await boot((db) => {
    const p = seedProject(db, "heal-bust");
    seedOpenPr(db, { projectId: p, number: 1,
      fetchedAt: new Date(Date.now() - 8 * 3600_000).toISOString(),
      ciState: "red", healAttempts: 0 });
  });
  try {
    await (await fetch(b.base + "/api/fleet/stuck-pr-taxonomy")).json();
    const builds1 = _getStuckPrTaxonomyCacheBuildsForTests();
    // Insert a new heal-audit row.
    const db2 = openDb(b.dbPath);
    try {
      db2.prepare(
        "INSERT INTO control_audit(ts,actor,action,target,args_json,exit_code,stdout_tail)"
        + " VALUES(?,?,?,?,?,?,?)",
      ).run(new Date().toISOString(), "ship", "heal", "pr-1", "{}", 1, "anything");
    } finally { db2.close(); }
    await (await fetch(b.base + "/api/fleet/stuck-pr-taxonomy")).json();
    const builds2 = _getStuckPrTaxonomyCacheBuildsForTests();
    assert.equal(builds2 - builds1, 1, "new heal-audit row should rebuild the cache");
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: a new open agent PR (COUNT moves) busts the cache", async () => {
  _resetStuckPrTaxonomyCacheForTests();
  const b = await boot((db) => {
    const p = seedProject(db, "count-bust");
    seedOpenPr(db, { projectId: p, number: 1,
      fetchedAt: new Date(Date.now() - 8 * 3600_000).toISOString(),
      ciState: "green" });
  });
  try {
    await (await fetch(b.base + "/api/fleet/stuck-pr-taxonomy")).json();
    const builds1 = _getStuckPrTaxonomyCacheBuildsForTests();
    const db2 = openDb(b.dbPath);
    try {
      const pid = (db2.prepare("SELECT id FROM project WHERE slug='count-bust'").get() as { id: number }).id;
      seedOpenPr(db2, { projectId: pid, number: 2,
        fetchedAt: new Date(Date.now() - 7 * 3600_000).toISOString(), ciState: "green" });
    } finally { db2.close(); }
    await (await fetch(b.base + "/api/fleet/stuck-pr-taxonomy")).json();
    const builds2 = _getStuckPrTaxonomyCacheBuildsForTests();
    assert.equal(builds2 - builds1, 1, "new open agent PR should bust the cache via COUNT(*)");
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: advancing fetched_at on an existing PR busts the cache", async () => {
  _resetStuckPrTaxonomyCacheForTests();
  const b = await boot((db) => {
    const p = seedProject(db, "fetched-bust");
    seedOpenPr(db, { projectId: p, number: 1,
      fetchedAt: new Date(Date.now() - 8 * 3600_000).toISOString(),
      ciState: "green" });
  });
  try {
    await (await fetch(b.base + "/api/fleet/stuck-pr-taxonomy")).json();
    const builds1 = _getStuckPrTaxonomyCacheBuildsForTests();
    const db2 = openDb(b.dbPath);
    try {
      // Advance fetched_at on the existing row.
      db2.prepare("UPDATE pr SET fetched_at = ? WHERE number = 1")
        .run(new Date().toISOString());
    } finally { db2.close(); }
    await (await fetch(b.base + "/api/fleet/stuck-pr-taxonomy")).json();
    const builds2 = _getStuckPrTaxonomyCacheBuildsForTests();
    assert.equal(builds2 - builds1, 1,
      "fetched_at advancing on an existing PR should bust the cache via MAX(fetched_at)");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — web/app.js renders the card on the home page; container
//        carries data-testid="stuck-pr-taxonomy-card"; rows carry
//        per-bucket testids; redacts secrets; returns "" when open_count===0.
// ────────────────────────────────────────────────────────────────────

test("AC5: web/app.js defines renderStuckPrTaxonomyCard and emits data-testid=stuck-pr-taxonomy-card", () => {
  assert.match(APP_JS, /function\s+renderStuckPrTaxonomyCard\s*\(/,
    "web/app.js must declare a renderStuckPrTaxonomyCard helper");
  assert.match(APP_JS, /data-testid="stuck-pr-taxonomy-card"/,
    "the card container must carry data-testid=\"stuck-pr-taxonomy-card\"");
  assert.match(APP_JS, /\/api\/fleet\/stuck-pr-taxonomy/,
    "web/app.js must fetch the new /api/fleet/stuck-pr-taxonomy route");
  // The renderer must route operator-visible strings through redactSecrets.
  const renderFn = APP_JS.match(/function\s+renderStuckPrTaxonomyCard\s*\([\s\S]*?\n\}/);
  assert.ok(renderFn, "renderStuckPrTaxonomyCard function body must be parseable");
  assert.match(renderFn![0], /redactSecrets\(/,
    "renderStuckPrTaxonomyCard must route operator-visible strings through redactSecrets");
  // Returns "" when open_count===0.
  assert.match(renderFn![0], /open_count[^\n]*===\s*0|openCount\s*===\s*0/,
    "renderStuckPrTaxonomyCard must short-circuit when open_count===0");
  // home() composition wires it in BELOW renderRiskiestPr and ABOVE
  // renderSpendEfficiencyCard / renderStreak.
  const homeBodyMatch = APP_JS.match(/async\s+function\s+home\s*\(\s*\)[\s\S]*?app\.innerHTML\s*=\s*[\s\S]*?renderInbox/);
  assert.ok(homeBodyMatch, "home() must include a renderInbox call");
  const homeBody = homeBodyMatch![0];
  const riskiestIdx = homeBody.indexOf("renderRiskiestPr");
  const stuckIdx = homeBody.indexOf("renderStuckPrTaxonomyCard");
  const spendIdx = homeBody.indexOf("renderSpendEfficiencyCard");
  assert.ok(stuckIdx > -1, "home() must reference renderStuckPrTaxonomyCard");
  assert.ok(riskiestIdx > -1 && riskiestIdx < stuckIdx,
    "renderStuckPrTaxonomyCard must come AFTER renderRiskiestPr in the home() composition");
  assert.ok(spendIdx > -1 && stuckIdx < spendIdx,
    "renderStuckPrTaxonomyCard must come BEFORE renderSpendEfficiencyCard in the home() composition");
});

test("AC5: web/app.js emits per-bucket data-testids for individual rows", () => {
  const renderFn = APP_JS.match(/function\s+renderStuckPrTaxonomyCard\s*\([\s\S]*?\n\}/);
  assert.ok(renderFn);
  // The row testid pattern: stuck-pr-row-<bucket>-<slug>-<n>
  assert.match(renderFn![0], /stuck-pr-row-/,
    "each row must carry a data-testid prefixed with stuck-pr-row-");
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Mobile / >=600px layout. The merging + healthy_waiting rows
//        are hidden behind a "+N healthy or merging" toggle on phones;
//        action-urgent rows always render. At >=600px every row renders
//        inline. Asserted via the style.css contract + the renderer's
//        emitted toggle markup.
// ────────────────────────────────────────────────────────────────────

test("AC6: style.css hides merging+healthy_waiting rows on phones via a max-width breakpoint", () => {
  assert.match(CSS, /\.stuck-pr-taxonomy-card\b/,
    "style.css must define a .stuck-pr-taxonomy-card selector");
  // Single max-width: 599px (or smaller) media block must hide the
  // merging + healthy_waiting rows.
  const allMobile = CSS.match(/@media\s*\([^)]*max-width:\s*\d+px[^)]*\)\s*\{[\s\S]*?\n\}/g) || [];
  const matchingMobile = allMobile.find((b) =>
    /\.stuck-pr-row\[data-bucket="merging"\]|\.stuck-pr-row\[data-bucket=.merging.\]/.test(b)
    && /display:\s*none/.test(b),
  );
  assert.ok(matchingMobile,
    "a phone-width @media block must hide merging-bucket rows by default");
  // Desktop block places rows inline.
  const allDesktop = CSS.match(/@media\s*\([^)]*min-width:\s*600px[^)]*\)\s*\{[\s\S]*?\n\}/g) || [];
  const matchingDesktop = allDesktop.find((b) => /\.stuck-pr-taxonomy-card|\.stuck-pr-row/.test(b));
  assert.ok(matchingDesktop,
    "a @media (min-width: 600px) block must target the taxonomy card");
});

test("AC6: renderer emits the +N healthy or merging toggle when at least one mobile-hidden row exists", () => {
  const renderFn = APP_JS.match(/function\s+renderStuckPrTaxonomyCard\s*\([\s\S]*?\n\}/);
  assert.ok(renderFn);
  assert.match(renderFn![0], /stuck-pr-mobile-toggle/,
    "the renderer must emit a .stuck-pr-mobile-toggle button");
  assert.match(renderFn![0], /healthy or merging/i,
    "the toggle label must read 'healthy or merging'");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Quiet-hours integration. Hide infra_flake / merging /
//        healthy_waiting when quiet hours active; action-urgent rows
//        always visible.
// ────────────────────────────────────────────────────────────────────

test("AC7: renderer hides infra_flake/merging/healthy_waiting rows when quiet_hours_active:true", () => {
  const renderFn = APP_JS.match(/function\s+renderStuckPrTaxonomyCard\s*\([\s\S]*?\n\}/);
  assert.ok(renderFn);
  // The renderer must read data.quiet_hours_active.
  assert.match(renderFn![0], /quiet_hours_active|quietHours/,
    "renderStuckPrTaxonomyCard must read data.quiet_hours_active");
  // The hidden-bucket constant (declared at module scope) must list
  // infra_flake, merging, and healthy_waiting.
  const quietHiddenDecl = APP_JS.match(
    /STUCK_PR_QUIET_HIDDEN_BUCKETS\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/,
  );
  assert.ok(quietHiddenDecl, "STUCK_PR_QUIET_HIDDEN_BUCKETS must be declared");
  const decl = quietHiddenDecl![1];
  assert.match(decl, /"infra_flake"/, "quiet-hours hidden bucket set must include infra_flake");
  assert.match(decl, /"merging"/, "quiet-hours hidden bucket set must include merging");
  assert.match(decl, /"healthy_waiting"/, "quiet-hours hidden bucket set must include healthy_waiting");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Project page anchor: the row's link uses ?pr=<n>, reusing the
//        existing 0040 pr-card-flash highlight pattern.
// ────────────────────────────────────────────────────────────────────

test("AC8: row links use the ?pr=<n> deep-link pattern and pr-card-flash CSS is reused", () => {
  const renderFn = APP_JS.match(/function\s+renderStuckPrTaxonomyCard\s*\([\s\S]*?\n\}/);
  assert.ok(renderFn);
  // The "→ <next_action>" link uses encodeURIComponent(slug) + "?pr=" + n.
  assert.match(renderFn![0], /encodeURIComponent\(slug\)\s*\+\s*"\?pr=/,
    "row link must use the 0040 ?pr=<n> deep-link pattern");
  // The pr-card-flash class is reused unchanged — present in CSS already.
  assert.match(CSS, /\.pr-card-flash\b/,
    "style.css must still define the .pr-card-flash highlight class");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Edge case: heal_attempts=3 (over cap) stays in needs_human;
//        evidence reads "(over cap)".
// ────────────────────────────────────────────────────────────────────

test("AC9: heal_attempts=3 stays needs_human with evidence containing '(over cap)'", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedOpenPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(2),
      ciState: "red", healAttempts: 3, firstFailCheck: "unit" });
    seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 1,
      stdoutTail: "FAIL src/foo.test.ts" });
    const r = stuckPrTaxonomy(db, NOW);
    assert.equal(r.rows[0].bucket, "needs_human");
    assert.match(r.rows[0].evidence, /3 heals/);
    assert.match(r.rows[0].evidence, /\(over cap\)/);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Performance: stuckPrTaxonomy against 50 open PRs (each with
//         up to 2 heal-audit rows) completes in under 35ms. Skipped
//         unless PERF=1.
// ────────────────────────────────────────────────────────────────────

test("AC10: stuckPrTaxonomy against 50 open PRs completes in under 35ms (PERF=1)", () => {
  if (process.env.PERF !== "1") return;
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "perf");
    for (let i = 0; i < 50; i++) {
      seedOpenPr(db, { projectId: p, number: 1000 + i, fetchedAt: hoursBeforeNow(i % 24),
        ciState: i % 3 === 0 ? "red" : (i % 3 === 1 ? "green" : "none"),
        healAttempts: i % 4 });
      seedHealAudit(db, { ts: hoursBeforeNow((i % 24) - 1), prNumber: 1000 + i,
        stdoutTail: i % 5 === 0 ? "supabase start: failed to bind host port for 0.0.0.0:54322"
                    : "AssertionError: expected" });
      if (i % 2 === 0) {
        seedHealAudit(db, { ts: hoursBeforeNow((i % 24) - 2), prNumber: 1000 + i,
          stdoutTail: "earlier attempt" });
      }
    }
    const t0 = process.hrtime.bigint();
    stuckPrTaxonomy(db, NOW);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(elapsedMs < 35, `expected <35ms, got ${elapsedMs.toFixed(2)}ms`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC11 — No new runtime deps; helper composes existing tables.
//         Asserted by package.json (deps stay empty) + the schema
//         being unchanged (the helper SELECTs only declared columns).
// ────────────────────────────────────────────────────────────────────

test("AC11: package.json carries no runtime dependencies", () => {
  const pkgPath = join(__dirname, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    "package.json `dependencies` must remain empty per AGENTS.md Hard NO");
});
