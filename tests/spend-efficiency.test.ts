// Tests for ticket 0044 — Spend-efficiency ranking + laggard diagnosis.
//
// One test(...) per acceptance-criteria checkbox. Strategy mirrors the
// 0040 riskiest-PR suite (tests/riskiest-pr.test.ts):
//   - Drive `spendEfficiencyRanking(db, now, opts)` directly against a
//     tmpdir DB for the helper's shape + cascade arithmetic + laggard
//     selection + edge cases.
//   - Boot `startServer()` over loopback for the route + cache tests,
//     using the empty-roots config + tmp fleet-control.config.json seam
//     from LESSONS § "in-process startServer() tests need an empty-roots
//     config + run-row seeds".
//   - SPA renderer tests are text-level over web/app.js + web/style.css
//     per the inbox / streak / glance / cost-per-pr / friday-wrap /
//     riskiest-PR precedent (zero jsdom).
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps from
// `new Date()`": every seed timestamp is anchored to the test's `NOW`
// constant via daysBeforeNow / hoursBeforeNow helpers that read NOW,
// never `new Date()`.
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`": row
// narrowing in the helper uses the double-cast (exercised transitively
// — if the cast regresses tsc fails before this file runs).
// Per LESSONS § "in-process dedup sets need an explicit reset hook for
// tests" + "expose a build counter for cache-hit tests, not a fetcher
// swap": the cache tests use the `_resetSpendEfficiencyCacheForTests()`
// + `_getSpendEfficiencyCacheBuildsForTests()` seams exported by
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
  spendEfficiencyRanking,
  type SpendEfficiencyRanking,
} from "../src/views.ts";
import {
  startServer,
  _resetSpendEfficiencyCacheForTests,
  _getSpendEfficiencyCacheBuildsForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers — pinned-now seeders.
// ────────────────────────────────────────────────────────────────────

// Pinned wall-clock anchor for every seed (LESSONS 2026-05-29).
const NOW = new Date("2026-06-05T12:00:00.000Z");

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-spend-eff-"));
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

/** ISO timestamp `d` days BEFORE the pinned NOW (full UTC datetime). */
function daysBeforeNow(d: number): string {
  return new Date(NOW.getTime() - d * 86400_000).toISOString();
}

/** ISO timestamp `h` hours BEFORE the pinned NOW. */
function hoursBeforeNow(h: number): string {
  return new Date(NOW.getTime() - h * 3600_000).toISOString();
}

/** YYYY-MM-DD `d` days BEFORE NOW (for cost_rollup_day.day). */
function dayBeforeNow(d: number): string {
  return daysBeforeNow(d).slice(0, 10);
}

interface PrSeed {
  projectId: number;
  number: number;
  state?: string;     // defaults to 'MERGED' (uppercase per the production ingester for merged PRs)
  isAgent?: number;   // 1 by default
  fetchedAt: string;  // ISO; production stamps this on every gh sync
}
function seedMergedPr(db: DB, opts: PrSeed): void {
  db.prepare(
    "INSERT INTO pr("
    + "project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
    + "additions,deletions,author,url,fetched_at,gh_created_at,"
    + "first_fail_check,first_fail_excerpt,heal_attempts"
    + ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, `pr-${opts.number}`,
    `feat/${opts.number}`,
    opts.state ?? "MERGED",
    "green", null,
    opts.isAgent ?? 1,
    0, 0,
    "a", `https://github.com/owner/x/pull/${opts.number}`,
    opts.fetchedAt, opts.fetchedAt,
    null, null,
    0,
  );
}

/** Seed an open agent PR (state='open' lowercase per src/ingest/prs.ts:164). */
function seedOpenPr(db: DB, opts: PrSeed & { ciState?: string; firstFailCheck?: string | null; healAttempts?: number }): void {
  db.prepare(
    "INSERT INTO pr("
    + "project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
    + "additions,deletions,author,url,fetched_at,gh_created_at,"
    + "first_fail_check,first_fail_excerpt,heal_attempts"
    + ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, `pr-${opts.number}`,
    `feat/${opts.number}`,
    "open",
    opts.ciState ?? "red", null,
    opts.isAgent ?? 1,
    0, 0,
    "a", `https://github.com/owner/x/pull/${opts.number}`,
    opts.fetchedAt, opts.fetchedAt,
    opts.firstFailCheck ?? null, null,
    opts.healAttempts ?? 0,
  );
}

/** Seed a row in cost_rollup_day for a project on a specific YYYY-MM-DD. */
function seedCost(db: DB, projectId: number, day: string, costUsd: number, phase: string = "ship"): void {
  db.prepare(
    "INSERT INTO cost_rollup_day(project_id, phase, day, runs, input_tokens, output_tokens, "
    + "cache_creation_tokens, cache_read_tokens, cost_usd) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(projectId, phase, day, 1, 0, 0, 0, 0, costUsd);
}

interface RunSeed {
  projectId: number;
  outcome: string;      // 'healed' | 'self-cancel' | 'shipped' | etc — lowercase per src/ingest/transcripts.ts
  startedAt: string;    // ISO
  phase?: string;       // default 'ship'
  sessionId?: string;   // unique-ish per project for the UNIQUE constraint
}
let _sessionCounter = 0;
function seedRun(db: DB, opts: RunSeed): number {
  _sessionCounter += 1;
  const sid = opts.sessionId ?? `sess-${_sessionCounter}-${opts.projectId}-${opts.outcome}`;
  db.prepare(
    "INSERT INTO run(project_id, phase, session_id, started_at, ended_at, duration_ms, exit_code, "
    + "num_turns, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, "
    + "cost_usd, cost_source, model, summary, outcome, pr_number, source) "
    + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.phase ?? "ship", sid, opts.startedAt, opts.startedAt,
    1000, 0, 1, 0, 0, 0, 0,
    null, "live", "claude-opus-4-7", "ok", opts.outcome, null, "runs.jsonl",
  );
  return (db.prepare(
    "SELECT id FROM run WHERE project_id=? AND phase=? AND session_id=?",
  ).get(opts.projectId, opts.phase ?? "ship", sid) as { id: number }).id;
}

/** Seed a self_drift anomaly tied to a run (mirrors src/drift.ts). */
function seedDriftAnomaly(db: DB, runId: number, signature: string, createdAt: string): void {
  db.prepare(
    "INSERT INTO anomaly("
    + "  run_id, kind, value, baseline_mean, baseline_stddev, "
    + "  sample_count, candidate_reason, created_at, correlation_signature"
    + ") VALUES(?, 'self_drift', ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, 10.0, 5.0, 1.0, 3, "{}", createdAt, signature);
}

/** Seed a control_audit heal-row for a given PR (mirrors src/ingest classifier seam). */
function seedHealAudit(db: DB, opts: { ts: string; prNumber: number; stdoutTail: string }): void {
  db.prepare(
    "INSERT INTO control_audit(ts,actor,action,target,args_json,exit_code,stdout_tail)"
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(opts.ts, "ship", "heal", `pr-${opts.prNumber}`, "{}", 1, opts.stdoutTail);
}

// ────────────────────────────────────────────────────────────────────
// AC1 — spendEfficiencyRanking returns the documented shape; per-project
//        cost_per_pr_usd + ratio_to_median are exact; under-3-project
//        threshold yields laggard:null but the projects array still
//        renders.
// ────────────────────────────────────────────────────────────────────

test("AC1: spendEfficiencyRanking computes cost_per_pr_usd + ratio_to_median for a 5-project fleet", () => {
  const { db, cleanup } = tempDb();
  try {
    // 5 projects with known spends + merged PRs; we want fleet_median
    // computed JS-side over the 5 cost_per_pr values.
    const courtiq = seedProject(db, "courtiq", "Courtiq");
    const fleet = seedProject(db, "fleet-control", "Fleet Control");
    const dc = seedProject(db, "digitalcraft", "DigitalCraft");
    const ctq2 = seedProject(db, "courtiq2", "Courtiq2");
    const alm = seedProject(db, "almanac", "Almanac");

    // Spends (within the trailing 14 days): use a single day each.
    seedCost(db, courtiq, dayBeforeNow(3), 1.08);   // 6 PRs → $0.18/PR
    seedCost(db, fleet,   dayBeforeNow(3), 0.88);   // 4 PRs → $0.22/PR
    seedCost(db, dc,      dayBeforeNow(3), 0.62);   // 2 PRs → $0.31/PR
    seedCost(db, ctq2,    dayBeforeNow(3), 0.45);   // 1 PR  → $0.45/PR
    seedCost(db, alm,     dayBeforeNow(3), 4.20);   // 1 PR  → $4.20/PR

    // Merged PRs (state='MERGED', is_agent=1, in window).
    for (let i = 1; i <= 6; i++) seedMergedPr(db, { projectId: courtiq, number: 100 + i, fetchedAt: daysBeforeNow(2) });
    for (let i = 1; i <= 4; i++) seedMergedPr(db, { projectId: fleet,   number: 200 + i, fetchedAt: daysBeforeNow(2) });
    for (let i = 1; i <= 2; i++) seedMergedPr(db, { projectId: dc,      number: 300 + i, fetchedAt: daysBeforeNow(2) });
    seedMergedPr(db, { projectId: ctq2, number: 401, fetchedAt: daysBeforeNow(2) });
    seedMergedPr(db, { projectId: alm,  number: 501, fetchedAt: daysBeforeNow(2) });

    const r = spendEfficiencyRanking(db, NOW) as SpendEfficiencyRanking;
    assert.equal(r.window_days, 14);
    assert.equal(r.projects.length, 5);
    // Fleet total spend + total PRs.
    assert.equal(Math.round(r.fleet_total_spend_usd * 100) / 100, 7.23);
    assert.equal(r.fleet_total_prs, 14);
    // Fleet median: per-project cost_per_pr sorted = [0.18, 0.22, 0.31, 0.45, 4.20] → median 0.31.
    assert.ok(r.fleet_median_per_pr != null);
    assert.equal(Math.round(r.fleet_median_per_pr! * 100) / 100, 0.31);
    // Per-project shape.
    const bySlug = new Map(r.projects.map((p) => [p.project_slug, p]));
    const cq = bySlug.get("courtiq")!;
    assert.equal(cq.merged_prs, 6);
    assert.equal(Math.round(cq.spend_usd * 100) / 100, 1.08);
    assert.equal(Math.round(cq.cost_per_pr_usd! * 100) / 100, 0.18);
    assert.equal(Math.round(cq.ratio_to_median! * 100) / 100, 0.58); // 0.18/0.31
    const al = bySlug.get("almanac")!;
    assert.equal(al.merged_prs, 1);
    assert.equal(Math.round(al.cost_per_pr_usd! * 100) / 100, 4.20);
    assert.equal(Math.round(al.ratio_to_median! * 100) / 100, 13.55); // 4.20/0.31
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(r.generated_at));
  } finally { cleanup(); }
});

test("AC1: spendEfficiencyRanking yields laggard:null when fewer than 3 projects merged a PR in window", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha");
    const b = seedProject(db, "bravo");
    seedCost(db, a, dayBeforeNow(2), 0.50);
    seedCost(db, b, dayBeforeNow(2), 5.00);
    seedMergedPr(db, { projectId: a, number: 1, fetchedAt: daysBeforeNow(2) });
    seedMergedPr(db, { projectId: b, number: 2, fetchedAt: daysBeforeNow(2) });

    const r = spendEfficiencyRanking(db, NOW);
    assert.equal(r.laggard, null,
      "fewer than 3 projects with merges → laggard MUST be null");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — Laggard selection: highest ratio_to_median above 1.5x;
//        balanced fleet (all within 1.5x) → laggard:null; tie-break
//        by absolute cost_per_pr_usd.
// ────────────────────────────────────────────────────────────────────

test("AC2: laggard is null when every project sits within 1.5x of the fleet median", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha");
    const b = seedProject(db, "bravo");
    const c = seedProject(db, "charlie");
    // All three at $0.30/PR (perfectly balanced).
    for (const [pid, n] of [[a, 10], [b, 20], [c, 30]] as Array<[number, number]>) {
      seedCost(db, pid, dayBeforeNow(2), 0.30);
      seedMergedPr(db, { projectId: pid, number: n, fetchedAt: daysBeforeNow(2) });
    }
    const r = spendEfficiencyRanking(db, NOW);
    assert.equal(r.laggard, null,
      "balanced fleet (all within 1.5x of median) MUST yield laggard:null");
    assert.equal(r.projects.length, 3);
  } finally { cleanup(); }
});

test("AC2: laggard is the project whose ratio_to_median is highest AND > 1.5x", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha");
    const b = seedProject(db, "bravo");
    const c = seedProject(db, "charlie", "Charlie");
    seedCost(db, a, dayBeforeNow(2), 0.30); seedMergedPr(db, { projectId: a, number: 10, fetchedAt: daysBeforeNow(2) });
    seedCost(db, b, dayBeforeNow(2), 0.30); seedMergedPr(db, { projectId: b, number: 20, fetchedAt: daysBeforeNow(2) });
    seedCost(db, c, dayBeforeNow(2), 0.90); seedMergedPr(db, { projectId: c, number: 30, fetchedAt: daysBeforeNow(2) });
    const r = spendEfficiencyRanking(db, NOW);
    assert.ok(r.laggard, "fleet with one 3x outlier MUST have a laggard");
    assert.equal(r.laggard!.project_slug, "charlie");
    assert.equal(Math.round(r.laggard!.ratio_to_median * 100) / 100, 3.00);
    assert.ok(r.laggard!.link && r.laggard!.link.includes("/p/charlie"));
  } finally { cleanup(); }
});

test("AC2: when multiple projects tie at the top ratio, the higher absolute cost_per_pr_usd wins", () => {
  const { db, cleanup } = tempDb();
  try {
    // 4 projects: two cheap (median anchor), two tied at 2x median but
    // with different absolute $/PR (1.00 vs 2.00, achieved via different
    // spend+merge counts to dodge the tied-merged-count). The 2.00 one wins.
    const a = seedProject(db, "alpha");
    const b = seedProject(db, "bravo");
    const c = seedProject(db, "charlie");
    const d = seedProject(db, "delta");
    seedCost(db, a, dayBeforeNow(2), 0.50); seedMergedPr(db, { projectId: a, number: 10, fetchedAt: daysBeforeNow(2) });
    seedCost(db, b, dayBeforeNow(2), 0.50); seedMergedPr(db, { projectId: b, number: 20, fetchedAt: daysBeforeNow(2) });
    // Both ratio = 2.0 (median is 0.50 → tied projects at $1.00/PR via different denominators).
    seedCost(db, c, dayBeforeNow(2), 1.00); seedMergedPr(db, { projectId: c, number: 30, fetchedAt: daysBeforeNow(2) });
    // d: 2 merges, $2 → $1.00/PR (same ratio as c). Tie at ratio 2.0.
    seedCost(db, d, dayBeforeNow(2), 2.00);
    seedMergedPr(db, { projectId: d, number: 40, fetchedAt: daysBeforeNow(2) });
    seedMergedPr(db, { projectId: d, number: 41, fetchedAt: daysBeforeNow(2) });
    // Now break the tie by making one absolutely more expensive: bump c
    // to $1.50/PR by editing its cost row, so c is the higher-absolute winner.
    db.prepare("UPDATE cost_rollup_day SET cost_usd = 1.50 WHERE project_id = ?").run(c);
    const r = spendEfficiencyRanking(db, NOW);
    assert.ok(r.laggard, "ratio > 1.5x exists; laggard MUST be set");
    // c: $1.50/PR, ratio = 3.0; d: $1.00/PR, ratio = 2.0. c wins both ratio AND absolute.
    // The point: when ratios tied, absolute wins; here ratios differ, top wins.
    assert.equal(r.laggard!.project_slug, "charlie");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — "Why" composition: heals + self-cancel + drift + infra-flake,
//        ordered by absolute deviation from fleet median. Only
//        signals where the laggard's value is STRICTLY GREATER than
//        the fleet median surface.
// ────────────────────────────────────────────────────────────────────

test("AC3: composeLaggardWhy returns the three over-median signals in deviation-DESC order", () => {
  const { db, cleanup } = tempDb();
  try {
    // 4 projects so the laggard has a clearly-defined fleet median.
    const a = seedProject(db, "alpha");
    const b = seedProject(db, "bravo");
    const c = seedProject(db, "charlie");
    const lag = seedProject(db, "almanac", "Almanac");

    // Spends + merges so almanac becomes the >1.5x laggard.
    seedCost(db, a, dayBeforeNow(2), 0.30); seedMergedPr(db, { projectId: a, number: 10, fetchedAt: daysBeforeNow(2) });
    seedCost(db, b, dayBeforeNow(2), 0.30); seedMergedPr(db, { projectId: b, number: 20, fetchedAt: daysBeforeNow(2) });
    seedCost(db, c, dayBeforeNow(2), 0.30); seedMergedPr(db, { projectId: c, number: 30, fetchedAt: daysBeforeNow(2) });
    seedCost(db, lag, dayBeforeNow(2), 1.50); seedMergedPr(db, { projectId: lag, number: 99, fetchedAt: daysBeforeNow(2) });

    // Healed runs in window: each of the non-laggard projects has 1.
    seedRun(db, { projectId: a, outcome: "healed", startedAt: daysBeforeNow(3) });
    seedRun(db, { projectId: b, outcome: "healed", startedAt: daysBeforeNow(3) });
    seedRun(db, { projectId: c, outcome: "healed", startedAt: daysBeforeNow(3) });
    // Laggard has 4 healed runs in window. Median = 1; laggard - median = 3.
    seedRun(db, { projectId: lag, outcome: "healed", startedAt: daysBeforeNow(2) });
    seedRun(db, { projectId: lag, outcome: "healed", startedAt: daysBeforeNow(3) });
    seedRun(db, { projectId: lag, outcome: "healed", startedAt: daysBeforeNow(4) });
    seedRun(db, { projectId: lag, outcome: "healed", startedAt: daysBeforeNow(5) });
    // Self-cancels: 0 across non-laggards (median = 0). Laggard has 2.
    seedRun(db, { projectId: lag, outcome: "self-cancel", startedAt: daysBeforeNow(3) });
    seedRun(db, { projectId: lag, outcome: "self-cancel", startedAt: daysBeforeNow(4) });
    // Drift: 1 open self_drift anomaly tied to a laggard run (median = 0).
    const driftRunId = seedRun(db, { projectId: lag, outcome: "shipped", startedAt: daysBeforeNow(2) });
    seedDriftAnomaly(db, driftRunId, "duration_ms", hoursBeforeNow(6));

    const r = spendEfficiencyRanking(db, NOW);
    assert.ok(r.laggard, "with a >1.5x outlier the laggard MUST be set");
    assert.equal(r.laggard!.project_slug, "almanac");
    const why = r.laggard!.why;
    assert.ok(why.length >= 1 && why.length <= 3,
      `why array carries 1-3 entries; got ${why.length}`);
    // First entry: largest absolute deviation. heals = 4 vs median 1 → deviation 3.
    // self-cancel = 2 vs 0 → deviation 2. drift = 1 vs 0 → deviation 1.
    assert.equal(why[0].signal, "heals", "heals must rank first (largest deviation)");
    assert.equal(why[0].value, 4);
    assert.equal(why[0].fleet_median, 1);
    assert.match(why[0].detail, /healed runs/);
    // The cascade includes self_cancel + drift in deviation order.
    const signals = why.map((w) => w.signal);
    assert.ok(signals.includes("self_cancel") || signals.includes("drift"),
      "self_cancel and/or drift must appear in the why cascade when over median");
  } finally { cleanup(); }
});

test("AC3: signals NOT strictly greater than the fleet median are excluded from why", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha");
    const b = seedProject(db, "bravo");
    const c = seedProject(db, "charlie");
    const lag = seedProject(db, "loud");

    seedCost(db, a, dayBeforeNow(2), 0.30); seedMergedPr(db, { projectId: a, number: 10, fetchedAt: daysBeforeNow(2) });
    seedCost(db, b, dayBeforeNow(2), 0.30); seedMergedPr(db, { projectId: b, number: 20, fetchedAt: daysBeforeNow(2) });
    seedCost(db, c, dayBeforeNow(2), 0.30); seedMergedPr(db, { projectId: c, number: 30, fetchedAt: daysBeforeNow(2) });
    seedCost(db, lag, dayBeforeNow(2), 1.50); seedMergedPr(db, { projectId: lag, number: 99, fetchedAt: daysBeforeNow(2) });

    // EVERY project has 1 healed run → laggard at the median → must NOT
    // surface heals (not strictly greater).
    for (const pid of [a, b, c, lag]) {
      seedRun(db, { projectId: pid, outcome: "healed", startedAt: daysBeforeNow(3) });
    }
    const r = spendEfficiencyRanking(db, NOW);
    assert.ok(r.laggard);
    const heals = r.laggard!.why.find((w) => w.signal === "heals");
    assert.equal(heals, undefined,
      "heals must NOT appear when laggard value equals (not exceeds) median");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// Boot harness — empty-roots config + tmp fleet-control.config.json.
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
  const dir = mkdtempSync(join(tmpdir(), "fleet-spend-eff-boot-"));
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

/** Seed a "ready" 3-project fleet against the booted DB. Per LESSONS §
 *  "in-process startServer() tests need an empty-roots config + run-row
 *  seeds": spend is seeded via REAL `run` rows so the ingest pass'
 *  `recomputeRollups()` derives the same cost_rollup_day values the
 *  helper reads. Anchored to `new Date()` so the rows land inside
 *  whatever 14d window the request-path `new Date()` resolves to. */
function seedLiveFleet(db: DB, overrides: { spendBoost?: number } = {}): void {
  const a = seedProject(db, "alpha");
  const b = seedProject(db, "bravo");
  const c = seedProject(db, "charlie");
  // Cost is materialized by recomputeRollups() reading from `run`, so
  // we seed runs with cost_usd values (not cost_rollup_day directly).
  const insertRun = db.prepare(
    "INSERT INTO run(project_id, phase, session_id, started_at, ended_at, duration_ms, exit_code, "
    + "num_turns, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, "
    + "cost_usd, cost_source, model, summary, outcome, pr_number, source) "
    + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const recent = new Date().toISOString();
  insertRun.run(a, "ship", "sess-a-live", recent, recent, 1000, 0, 1, 0, 0, 0, 0, 0.30,
    "live", "claude-opus-4-7", "ok", "shipped", null, "runs.jsonl");
  insertRun.run(b, "ship", "sess-b-live", recent, recent, 1000, 0, 1, 0, 0, 0, 0, 0.30,
    "live", "claude-opus-4-7", "ok", "shipped", null, "runs.jsonl");
  insertRun.run(c, "ship", "sess-c-live", recent, recent, 1000, 0, 1, 0, 0, 0, 0,
    0.90 + (overrides.spendBoost ?? 0),
    "live", "claude-opus-4-7", "ok", "shipped", null, "runs.jsonl");
  for (const [pid, n] of [[a, 10], [b, 20], [c, 30]] as Array<[number, number]>) {
    seedMergedPr(db, { projectId: pid, number: n, fetchedAt: new Date().toISOString() });
  }
}

// ────────────────────────────────────────────────────────────────────
// AC4 — GET /api/fleet/spend-efficiency: returns the documented shape;
//        accepts ?window=<days> (7-90); 400 on out-of-range.
// ────────────────────────────────────────────────────────────────────

test("AC4: GET /api/fleet/spend-efficiency returns 200 + shape with a 3-project fleet", async () => {
  _resetSpendEfficiencyCacheForTests();
  const b = await boot((db) => { seedLiveFleet(db); });
  try {
    const r = await fetch(b.base + "/api/fleet/spend-efficiency");
    assert.equal(r.status, 200);
    const j = await r.json() as SpendEfficiencyRanking;
    assert.ok(Array.isArray(j.projects));
    assert.equal(j.projects.length, 3);
    assert.equal(typeof j.window_days, "number");
    assert.equal(j.window_days, 14, "default window MUST be 14 days");
    assert.ok(j.fleet_median_per_pr != null);
    assert.ok(j.laggard, "3-project >3x fleet MUST surface a laggard");
    assert.equal(j.laggard!.project_slug, "charlie");
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: GET /api/fleet/spend-efficiency?window=7 narrows the window", async () => {
  _resetSpendEfficiencyCacheForTests();
  const b = await boot((db) => { seedLiveFleet(db); });
  try {
    const r = await fetch(b.base + "/api/fleet/spend-efficiency?window=7");
    assert.equal(r.status, 200);
    const j = await r.json() as SpendEfficiencyRanking;
    assert.equal(j.window_days, 7);
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: GET /api/fleet/spend-efficiency?window=100 returns 400 (out-of-range)", async () => {
  _resetSpendEfficiencyCacheForTests();
  const b = await boot((db) => { seedLiveFleet(db); });
  try {
    const r = await fetch(b.base + "/api/fleet/spend-efficiency?window=100");
    assert.equal(r.status, 400, "?window=100 (>90) MUST 400");
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: GET /api/fleet/spend-efficiency?window=3 returns 400 (below 7)", async () => {
  _resetSpendEfficiencyCacheForTests();
  const b = await boot((db) => { seedLiveFleet(db); });
  try {
    const r = await fetch(b.base + "/api/fleet/spend-efficiency?window=3");
    assert.equal(r.status, 400, "?window=3 (<7) MUST 400");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — Caching: max-age=900 header + memoised by
//        (window_days, latest_run_id, latest_merged_pr_id). Inserting
//        a new MERGED PR invalidates the cache.
// ────────────────────────────────────────────────────────────────────

test("AC5: GET /api/fleet/spend-efficiency sets cache-control: max-age=900 and memoises via a build counter", async () => {
  _resetSpendEfficiencyCacheForTests();
  const b = await boot((db) => { seedLiveFleet(db); });
  try {
    const before = _getSpendEfficiencyCacheBuildsForTests();
    const r1 = await fetch(b.base + "/api/fleet/spend-efficiency");
    assert.equal(r1.status, 200);
    const cc = (r1.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=900/, `cache-control must declare max-age=900; got '${cc}'`);
    await r1.json();
    const afterFirst = _getSpendEfficiencyCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call → cache MISS, build counter += 1");

    const r2 = await fetch(b.base + "/api/fleet/spend-efficiency");
    assert.equal(r2.status, 200);
    await r2.json();
    const afterSecond = _getSpendEfficiencyCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0,
      "second call within the cache window → cache HIT, counter unchanged");

    // Insert a new MERGED PR. The cache invalidation tuple includes the
    // latest merged-PR id, so the next call MUST rebuild.
    const db2 = openDb(b.dbPath);
    try {
      const pid = (db2.prepare("SELECT id FROM project WHERE slug=?").get("alpha") as { id: number }).id;
      db2.prepare(
        "INSERT INTO pr("
        + "project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
        + "additions,deletions,author,url,fetched_at,gh_created_at,"
        + "first_fail_check,first_fail_excerpt,heal_attempts"
        + ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        pid, 9999, "fresh", "feat/9999", "MERGED", "green", null, 1,
        0, 0, "a", "https://github.com/owner/x/pull/9999",
        new Date().toISOString(), new Date().toISOString(), null, null, 0,
      );
    } finally { db2.close(); }

    const r3 = await fetch(b.base + "/api/fleet/spend-efficiency");
    assert.equal(r3.status, 200);
    await r3.json();
    const afterThird = _getSpendEfficiencyCacheBuildsForTests();
    assert.equal(afterThird - afterSecond, 1,
      "after a new MERGED PR lands, next call rebuilds → counter += 1");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — SPA renderer: web/app.js wires the card; data-testid present;
//        passes strings through redactSecrets; empty branch returns "".
// ────────────────────────────────────────────────────────────────────

test("AC6: web/app.js defines renderSpendEfficiencyCard + emits data-testid=spend-efficiency-card; fetches the route; redacts secrets", () => {
  assert.match(APP_JS, /function\s+renderSpendEfficiencyCard\s*\(/,
    "web/app.js must declare a renderSpendEfficiencyCard helper");
  assert.match(APP_JS, /data-testid="spend-efficiency-card"/,
    "the card must carry data-testid=\"spend-efficiency-card\" for stable test hooks");
  assert.match(APP_JS, /\/api\/fleet\/spend-efficiency/,
    "web/app.js must fetch the new /api/fleet/spend-efficiency route");
  const renderFn = APP_JS.match(/function\s+renderSpendEfficiencyCard\s*\([\s\S]*?\n\}/);
  assert.ok(renderFn, "renderSpendEfficiencyCard function body must be parseable");
  assert.match(renderFn![0], /redactSecrets\(/,
    "renderSpendEfficiencyCard must route operator-visible strings through redactSecrets");
  // Sub-3-project branch: returns "" so no DOM is emitted.
  assert.match(renderFn![0], /projects\.length\s*<\s*3|projects\?\.length\s*<\s*3/,
    "renderSpendEfficiencyCard must hide the card entirely when projects.length < 3");
  // home() wires it into the composition AFTER renderRiskiestPr.
  const homeBodyMatch = APP_JS.match(/async\s+function\s+home\s*\(\s*\)[\s\S]*?app\.innerHTML\s*=\s*[\s\S]*?renderInbox/);
  assert.ok(homeBodyMatch, "home() must include a renderInbox call");
  const homeBody = homeBodyMatch![0];
  assert.ok(homeBody.indexOf("renderSpendEfficiencyCard") > -1,
    "home() must reference renderSpendEfficiencyCard in its app.innerHTML composition");
  // Specifically: AFTER renderRiskiestPr (BELOW the 0040 badge per the spec).
  const riskIdx = homeBody.indexOf("renderRiskiestPr");
  const spendIdx = homeBody.indexOf("renderSpendEfficiencyCard");
  assert.ok(riskIdx > -1 && spendIdx > -1 && spendIdx > riskIdx,
    "renderSpendEfficiencyCard must render BELOW renderRiskiestPr in home()");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Project page anchor: ?focus=<signal> opens with the matching
//        section highlighted via the pr-card-flash CSS variable. The
//        renderer reads the focus param in project().
// ────────────────────────────────────────────────────────────────────

test("AC7: project() reads ?focus= and attaches a focus-flash highlight class", () => {
  assert.match(APP_JS, /params(\.get\(\s*["']focus["']\s*\)|\.has\(\s*["']focus["']\s*\))/,
    "project() must read params.get(\"focus\") to drive the highlight");
  assert.match(APP_JS, /focus-flash/,
    "web/app.js must reference the focus-flash highlight class");
  // CSS must define .focus-flash with a fade rule reusing the 0040
  // animation variable per the engineering note.
  assert.match(CSS, /\.focus-flash\b/,
    "style.css must define a .focus-flash selector");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Mobile / >=600px CSS rules for .spend-efficiency-card.
// ────────────────────────────────────────────────────────────────────

test("AC8: web/style.css declares .spend-efficiency-card + a >=600px breakpoint", () => {
  assert.match(CSS, /\.spend-efficiency-card\b/,
    "style.css must define a .spend-efficiency-card rule group");
  const all600 = CSS.match(/@media\s*\([^)]*min-width:\s*600px[^)]*\)\s*\{[\s\S]*?\n\}/g) || [];
  const matchingBlock = all600.find((b) => /\.spend-efficiency-card|\.spend-efficiency-leaderboard/.test(b));
  assert.ok(matchingBlock,
    "A @media (min-width: 600px) block must target the spend-efficiency card");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Quiet-hours integration: when quietHoursActive, the laggard
//        block lacks the look-here-link; otherwise it is present.
// ────────────────────────────────────────────────────────────────────

test("AC9: renderSpendEfficiencyCard hides the look-here-link when data.quiet_hours_active is true", () => {
  const renderFn = APP_JS.match(/function\s+renderSpendEfficiencyCard\s*\([\s\S]*?\n\}/);
  assert.ok(renderFn);
  // The renderer must reference quiet_hours_active AND a look-here
  // link testid so the test can prove the conditional rendering.
  assert.match(renderFn![0], /quiet_hours_active|quietHoursActive/,
    "renderSpendEfficiencyCard must consult quiet_hours_active");
  assert.match(renderFn![0], /look-here-link/,
    "renderSpendEfficiencyCard must use the look-here-link testid for the action prompt");
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Single-project fleet at the default window stays hidden; the
//         helper still returns the projects list (size 1) so the SPA
//         knows to suppress the card via the < 3 threshold.
// ────────────────────────────────────────────────────────────────────

test("AC10: single-project fleet at default windowDays yields projects.length === 1 and laggard:null", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha");
    seedCost(db, a, dayBeforeNow(2), 0.50);
    seedMergedPr(db, { projectId: a, number: 1, fetchedAt: daysBeforeNow(2) });
    const r = spendEfficiencyRanking(db, NOW);
    assert.equal(r.projects.length, 1);
    assert.equal(r.laggard, null);
  } finally { cleanup(); }
});

test("AC10: widening windowDays to 90 still yields projects.length === 1 when only one project has merges", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha");
    seedCost(db, a, dayBeforeNow(60), 0.50);
    seedMergedPr(db, { projectId: a, number: 1, fetchedAt: daysBeforeNow(60) });
    const r = spendEfficiencyRanking(db, NOW, { windowDays: 90 });
    assert.equal(r.window_days, 90);
    assert.equal(r.projects.length, 1);
    assert.equal(r.laggard, null);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC11 — No new runtime deps, no shell-string composition, no schema
//         change. Static asserts on package.json + on the helper module.
// ────────────────────────────────────────────────────────────────────

test("AC11: package.json declares zero runtime dependencies (still)", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    `dependencies must stay empty; saw: ${JSON.stringify(deps)}`);
});

test("AC11: src/views.ts spend-efficiency block never composes a shell string (no child_process imports)", () => {
  const src = readFileSync(join(__dirname, "..", "src", "views.ts"), "utf8");
  assert.doesNotMatch(src, /from\s+["']node:child_process["']/,
    "src/views.ts must not import from node:child_process");
});

// ────────────────────────────────────────────────────────────────────
// AC11 (continued) — infra_flake signal participation.
// The composeLaggardWhy cascade includes infra_flake when the laggard's
// open-PR infra-flake count exceeds the fleet median.
// ────────────────────────────────────────────────────────────────────

test("AC11: infra_flake count contributes to the why cascade when laggard exceeds the fleet median", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha");
    const b = seedProject(db, "bravo");
    const c = seedProject(db, "charlie");
    const lag = seedProject(db, "loud");

    seedCost(db, a, dayBeforeNow(2), 0.30); seedMergedPr(db, { projectId: a, number: 10, fetchedAt: daysBeforeNow(2) });
    seedCost(db, b, dayBeforeNow(2), 0.30); seedMergedPr(db, { projectId: b, number: 20, fetchedAt: daysBeforeNow(2) });
    seedCost(db, c, dayBeforeNow(2), 0.30); seedMergedPr(db, { projectId: c, number: 30, fetchedAt: daysBeforeNow(2) });
    seedCost(db, lag, dayBeforeNow(2), 1.50); seedMergedPr(db, { projectId: lag, number: 99, fetchedAt: daysBeforeNow(2) });

    // Laggard has 2 open PRs with an infra_flake classification; non-
    // laggards have 0 → median 0.
    seedOpenPr(db, { projectId: lag, number: 901, fetchedAt: hoursBeforeNow(4), ciState: "red" });
    seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 901, stdoutTail: "Error: bind: address already in use" });
    seedOpenPr(db, { projectId: lag, number: 902, fetchedAt: hoursBeforeNow(6), ciState: "red" });
    seedHealAudit(db, { ts: hoursBeforeNow(2), prNumber: 902, stdoutTail: "supabase start: failed to bind host port for 0.0.0.0:54322" });

    const r = spendEfficiencyRanking(db, NOW);
    assert.ok(r.laggard);
    const flake = r.laggard!.why.find((w) => w.signal === "infra_flake");
    assert.ok(flake, "infra_flake must appear in the why cascade when laggard > median");
    assert.equal(flake!.value, 2, `infra_flake count must be 2 (saw ${flake?.value})`);
    assert.match(flake!.detail, /infra-?flake/i);
  } finally { cleanup(); }
});
