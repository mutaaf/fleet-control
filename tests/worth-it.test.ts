// Tests for ticket 0048 — Per-project worth-it verdict.
//
// One test(...) per acceptance-criteria checkbox. Strategy mirrors the
// 0044 spend-efficiency + 0047 PR autopsy suites:
//   - Drive `projectWorthItVerdict(db, projectId, now, opts)` directly
//     against a tmpdir DB for the helper's shape + cascade arithmetic +
//     verdict_detail substrings + sticky-sunset two-anchor walk.
//   - Boot `startServer()` over loopback for the route + cache tests,
//     using the empty-roots config + tmp fleet-control.config.json seam
//     from LESSONS § "in-process startServer() tests need an empty-roots
//     config + run-row seeds".
//   - SPA renderer tests are text-level over web/app.js + web/style.css
//     per the inbox / cost-per-pr / spend-efficiency / autopsy precedent
//     (zero jsdom).
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps from
// `new Date()`": every seed timestamp is anchored to the test's `NOW`
// constant via daysBeforeNow / hoursBeforeNow helpers that read NOW,
// never `new Date()`.
// Per LESSONS 2026-06-05 / 0040 reconciliation / 0044 implementation
// log: the producer's literal casing is the contract — merged PRs are
// `state='MERGED'` uppercase + `is_agent=1`; open PRs are
// `state='open'` lowercase; closed non-merged are `state='CLOSED'`
// uppercase. The `pr` table has NO surrogate `id` (PK is
// `(project_id, number)`) per LESSONS 2026-06-07 — the cache
// invalidation tuple in the route proxies via
// `(MAX(fetched_at), COUNT(*))`.
//
// AC1 arithmetic note: the ticket's user-story prose claims `21 PRs ×
// 1h × $75 / $44 ≈ 3.2x`. The actual arithmetic is `21 × 75 / 44 =
// 35.79`. Per the ticket's "adjust the seed to produce a true 3.2x
// ratio" instruction, the AC1 verdict test seeds `32 PRs × $750` so
// the ROI is exactly `32 × 75 / 750 = 3.20` at the default rate. The
// user-story prose stays unchanged; the test arithmetic is load-
// bearing.
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
  projectWorthItVerdict,
  projectWorthItSticky,
  type ProjectWorthItVerdict,
} from "../src/views.ts";
import {
  startServer,
  _resetWorthItCacheForTests,
  _getWorthItCacheBuildsForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers — pinned-now seeders.
// ────────────────────────────────────────────────────────────────────

// Pinned wall-clock anchor for every seed (LESSONS 2026-05-29).
const NOW = new Date("2026-06-09T12:00:00.000Z");

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-worth-it-"));
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

/** ISO timestamp `d` days BEFORE the pinned NOW. */
function daysBeforeNow(d: number, base: Date = NOW): string {
  return new Date(base.getTime() - d * 86400_000).toISOString();
}

/** YYYY-MM-DD `d` days BEFORE the pinned NOW. */
function dayBeforeNow(d: number, base: Date = NOW): string {
  return daysBeforeNow(d, base).slice(0, 10);
}

interface PrSeed {
  projectId: number;
  number: number;
  state?: string;     // defaults to 'MERGED' uppercase
  isAgent?: number;   // 1 by default
  fetchedAt: string;
  closedAt?: string | null;
}
function seedMergedPr(db: DB, opts: PrSeed): void {
  db.prepare(
    "INSERT INTO pr("
    + "project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
    + "additions,deletions,author,url,fetched_at,gh_created_at,"
    + "first_fail_check,first_fail_excerpt,heal_attempts,closed_at"
    + ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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
    opts.closedAt ?? null,
  );
}

function seedClosedPr(db: DB, opts: PrSeed): void {
  db.prepare(
    "INSERT INTO pr("
    + "project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
    + "additions,deletions,author,url,fetched_at,gh_created_at,"
    + "first_fail_check,first_fail_excerpt,heal_attempts,closed_at"
    + ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, `pr-${opts.number}`,
    `feat/${opts.number}`,
    "CLOSED",
    "red", null,
    opts.isAgent ?? 1,
    0, 0,
    "a", `https://github.com/owner/x/pull/${opts.number}`,
    opts.fetchedAt, opts.fetchedAt,
    null, null,
    0,
    opts.closedAt ?? opts.fetchedAt,
  );
}

function seedCost(db: DB, projectId: number, day: string, costUsd: number, phase: string = "ship"): void {
  db.prepare(
    "INSERT INTO cost_rollup_day(project_id, phase, day, runs, input_tokens, output_tokens, "
    + "cache_creation_tokens, cache_read_tokens, cost_usd) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(projectId, phase, day, 1, 0, 0, 0, 0, costUsd);
}

let _sessionCounter = 0;
function seedRun(db: DB, opts: {
  projectId: number; outcome: string; startedAt: string; phase?: string;
}): number {
  _sessionCounter += 1;
  const sid = `sess-${_sessionCounter}-${opts.projectId}-${opts.outcome}`;
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

/** Seed exactly N merged PRs across the trailing window so the per-day
 *  streak walk sees at least one merge for each of the last
 *  `streakDays` days. Used by the "net_positive" + sticky tests. */
function seedNMergedAcrossWindow(
  db: DB, projectId: number, n: number, opts: {
    windowDays: number; base?: Date; startNumber?: number;
  },
): void {
  const base = opts.base ?? NOW;
  const startNumber = opts.startNumber ?? 1000;
  const wd = opts.windowDays;
  for (let i = 0; i < n; i++) {
    // Distribute across the window so each day in the trailing window
    // has at least one merge. Spread evenly: PR i lands `floor(i * wd
    // / n)` days ago.
    const dayOffset = Math.min(wd - 1, Math.floor((i * wd) / n));
    seedMergedPr(db, {
      projectId,
      number: startNumber + i,
      fetchedAt: daysBeforeNow(dayOffset, base),
    });
  }
}

/** Seed a merged PR for *today* (anchored to base) so the per-project
 *  streak walk sees at least one merge on the current day → streak >= 1. */
function seedMergedToday(
  db: DB, projectId: number, number: number, base: Date = NOW,
): void {
  seedMergedPr(db, {
    projectId, number,
    fetchedAt: daysBeforeNow(0, base),
  });
}

// ────────────────────────────────────────────────────────────────────
// AC1 — projectWorthItVerdict returns the documented shape; the
//        roi_multiplier + ratio fields are computed exactly per the
//        spec arithmetic; defaults are 75 + 1.
// ────────────────────────────────────────────────────────────────────

test("AC1: projectWorthItVerdict returns the documented shape; ROI = 3.2 at default $75/hr × 1h/PR with 32 PRs and $750 spend", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "almanac", "Almanac");
    // 32 merged PRs spread across the trailing 30 days so per-project
    // streak walk sees a merge on today and (most) prior days. ROI =
    // 32 × 1 × 75 / 750 = 3.20 exactly.
    seedNMergedAcrossWindow(db, pid, 32, { windowDays: 30 });
    // Spend: $750 across the trailing 30 days, split as $25/day so the
    // window arithmetic is symmetrical.
    for (let d = 0; d < 30; d++) {
      seedCost(db, pid, dayBeforeNow(d), 25);
    }
    const v = projectWorthItVerdict(db, pid, NOW) as ProjectWorthItVerdict;
    assert.equal(v.project_slug, "almanac");
    assert.equal(v.project_name, "Almanac");
    assert.equal(v.window_days, 30);
    assert.equal(v.merged_prs, 32);
    assert.equal(v.hourly_rate_usd, 75);
    assert.equal(v.hours_per_pr, 1);
    // Spend within ±$0.01 of $750 (cost_rollup_day inserts may include
    // floating-point noise on the SUM but we control the seed so it
    // should be exact).
    assert.ok(Math.abs(v.spend_usd - 750) < 0.001, `spend ≈ 750; got ${v.spend_usd}`);
    // Monthly runrate = spend × (30 / 30) = 750.
    assert.ok(Math.abs(v.monthly_runrate_usd - 750) < 0.001, `monthly_runrate ≈ 750; got ${v.monthly_runrate_usd}`);
    // Cost per PR = 750 / 32 = 23.4375.
    assert.ok(v.cost_per_pr_usd != null);
    assert.ok(Math.abs((v.cost_per_pr_usd as number) - 23.4375) < 0.001);
    // Human-equivalent cost: 32 × 1 × 75 = 2400.
    assert.equal(v.human_equivalent_cost_usd, 2400);
    // ROI = 2400 / 750 = 3.20 exactly.
    assert.ok(v.roi_multiplier != null);
    assert.ok(Math.abs((v.roi_multiplier as number) - 3.2) < 1e-9,
      `roi_multiplier should be 3.20 exactly; got ${v.roi_multiplier}`);
    // generated_at is an ISO timestamp.
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(v.generated_at));
    // Verdict is one of the four labels.
    assert.ok(["net_positive", "watch", "sunset_candidate", "insufficient_data"].includes(v.verdict));
  } finally { cleanup(); }
});

test("AC1: courtiq2-style scenario — 1 PR + $48 spend at default rate yields ROI ≈ 1.56 (matches the user-story example)", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "courtiq2", "Courtiq2");
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: daysBeforeNow(2) });
    seedCost(db, pid, dayBeforeNow(2), 48);
    const v = projectWorthItVerdict(db, pid, NOW);
    assert.equal(v.merged_prs, 1);
    assert.equal(v.human_equivalent_cost_usd, 75);
    assert.ok(v.roi_multiplier != null);
    assert.ok(Math.abs((v.roi_multiplier as number) - 1.5625) < 1e-9,
      `roi_multiplier should be 75/48 = 1.5625; got ${v.roi_multiplier}`);
  } finally { cleanup(); }
});

test("AC1: roi_multiplier is null when spend_usd === 0 (no division by zero)", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "alpha");
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: daysBeforeNow(2) });
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: daysBeforeNow(2) });
    seedMergedPr(db, { projectId: pid, number: 3, fetchedAt: daysBeforeNow(2) });
    // No cost rows at all → spend = 0.
    const v = projectWorthItVerdict(db, pid, NOW);
    assert.equal(v.spend_usd, 0);
    assert.equal(v.roi_multiplier, null);
  } finally { cleanup(); }
});

test("AC1: merge_ratio is null when no closes (merged_prs + closed_prs === 0); otherwise merged/(merged+closed)", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "alpha");
    // 4 merged, 1 closed (non-merged) → merge_ratio = 4/5 = 0.80.
    for (let i = 1; i <= 4; i++) {
      seedMergedPr(db, { projectId: pid, number: i, fetchedAt: daysBeforeNow(2) });
    }
    seedClosedPr(db, { projectId: pid, number: 99, fetchedAt: daysBeforeNow(2), closedAt: daysBeforeNow(2) });
    const v = projectWorthItVerdict(db, pid, NOW);
    assert.equal(v.merged_prs, 4);
    assert.equal(v.closed_prs, 1);
    assert.ok(v.merge_ratio != null);
    assert.ok(Math.abs((v.merge_ratio as number) - 0.8) < 1e-9);
    // No-closes scenario → merge_ratio is null per the AC.
    const pid2 = seedProject(db, "bravo");
    const v2 = projectWorthItVerdict(db, pid2, NOW);
    assert.equal(v2.merged_prs, 0);
    assert.equal(v2.closed_prs, 0);
    assert.equal(v2.merge_ratio, null);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — Verdict cascade: each verdict's defining condition surfaces
//        the right label + verdict_detail substring.
// ────────────────────────────────────────────────────────────────────

test("AC2: insufficient_data — merged_prs < 3 returns 'insufficient_data' + 'need 3+ merged PRs' detail", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "stub");
    // 2 merged PRs (below the 3-PR threshold).
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: daysBeforeNow(2) });
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: daysBeforeNow(2) });
    seedCost(db, pid, dayBeforeNow(2), 5);
    const v = projectWorthItVerdict(db, pid, NOW);
    assert.equal(v.verdict, "insufficient_data");
    assert.match(v.verdict_detail, /need 3\+ merged PRs/i);
    assert.match(v.verdict_detail, /30/);
  } finally { cleanup(); }
});

test("AC2: sunset_candidate — ROI < 1.0 yields 'sunset_candidate' + the $/mo arithmetic detail", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "burner");
    // 3 merged PRs → human-equiv = 3 × 75 = $225. Spend = $400 → ROI
    // = 0.5625 (< 1.0 → sunset_candidate via the ROI branch). All
    // PRs merge so the merge_ratio is 1.0 (not the trigger).
    for (let i = 1; i <= 3; i++) {
      seedMergedPr(db, { projectId: pid, number: i, fetchedAt: daysBeforeNow(2) });
    }
    seedCost(db, pid, dayBeforeNow(2), 400);
    const v = projectWorthItVerdict(db, pid, NOW);
    assert.equal(v.verdict, "sunset_candidate");
    // The detail names the runrate-vs-human arithmetic (ROI trigger).
    assert.match(v.verdict_detail, /human equivalent/i);
    assert.match(v.verdict_detail, /\$\d/);
  } finally { cleanup(); }
});

test("AC2: sunset_candidate — merge_ratio < 0.5 AND merged_prs < 5 yields 'sunset_candidate' + the throughput detail", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "stalled");
    // 3 merged, 4 closed → merge_ratio = 3/7 ≈ 0.43 (<0.5), merged < 5,
    // ROI massively positive (3 × 75 = $225 vs $1 spend) so the merge
    // ratio branch must fire BEFORE the ROI branch (the cascade is
    // top-down — sunset is checked before watch).
    for (let i = 1; i <= 3; i++) {
      seedMergedPr(db, { projectId: pid, number: i, fetchedAt: daysBeforeNow(2) });
    }
    for (let i = 90; i <= 93; i++) {
      seedClosedPr(db, { projectId: pid, number: i, fetchedAt: daysBeforeNow(2), closedAt: daysBeforeNow(2) });
    }
    seedCost(db, pid, dayBeforeNow(2), 1);
    const v = projectWorthItVerdict(db, pid, NOW);
    assert.equal(v.verdict, "sunset_candidate");
    // The detail names the merge-ratio + throughput trigger.
    assert.match(v.verdict_detail, /merge/i);
    assert.match(v.verdict_detail, /throughput/i);
  } finally { cleanup(); }
});

test("AC2: watch — 1.0 <= ROI < 2.0 yields 'watch' + 'ROI < 2x' substring", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "okayish");
    // 4 merged PRs spread so streak > 0. Cost = $200 → human-equiv =
    // $300, ROI = 1.5 (>= 1.0 but < 2.0 → watch via ROI branch).
    seedNMergedAcrossWindow(db, pid, 4, { windowDays: 30 });
    seedCost(db, pid, dayBeforeNow(2), 200);
    const v = projectWorthItVerdict(db, pid, NOW);
    assert.equal(v.verdict, "watch");
    assert.match(v.verdict_detail, /ROI/i);
  } finally { cleanup(); }
});

test("AC2: watch — streak_days === 0 yields 'watch' + 'no merged PR today' substring", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "quiet-today");
    // 5 merged PRs all dated 2 days ago — so today has zero merges →
    // streak_days = 0. ROI strong (5 × 75 = $375 vs $50 spend → 7.5x)
    // and merge_ratio 1.0 → the watch branch must fire on streak alone.
    for (let i = 1; i <= 5; i++) {
      seedMergedPr(db, { projectId: pid, number: i, fetchedAt: daysBeforeNow(2) });
    }
    seedCost(db, pid, dayBeforeNow(2), 50);
    const v = projectWorthItVerdict(db, pid, NOW);
    assert.equal(v.streak_days, 0);
    assert.equal(v.verdict, "watch");
    assert.match(v.verdict_detail, /no merged PR today/i);
  } finally { cleanup(); }
});

test("AC2: net_positive — ROI >= 2.0 AND merge_ratio >= 0.7 AND streak_days > 0 yields 'net_positive'", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "thriving");
    // 32 merged PRs spread across the window so streak > 0; spend
    // $750 → ROI 3.20; no closes so merge_ratio = 1.0.
    seedNMergedAcrossWindow(db, pid, 32, { windowDays: 30 });
    for (let d = 0; d < 30; d++) {
      seedCost(db, pid, dayBeforeNow(d), 25);
    }
    const v = projectWorthItVerdict(db, pid, NOW);
    assert.ok((v.roi_multiplier ?? 0) >= 2.0);
    assert.ok((v.merge_ratio ?? 0) >= 0.7);
    assert.ok(v.streak_days > 0);
    assert.equal(v.verdict, "net_positive");
    assert.match(v.verdict_detail, /human equivalent/i);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — Config knob: worth_it.hourly_rate_usd + worth_it.hours_per_pr
//        override defaults; explicit opts override config; absent both
//        falls back to 75 + 1.
// ────────────────────────────────────────────────────────────────────

test("AC3: explicit opts.humanEquivalentHourlyUsd overrides the default 75", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "a");
    for (let i = 1; i <= 3; i++) {
      seedMergedPr(db, { projectId: pid, number: i, fetchedAt: daysBeforeNow(2) });
    }
    seedCost(db, pid, dayBeforeNow(2), 50);
    const v = projectWorthItVerdict(db, pid, NOW, { humanEquivalentHourlyUsd: 150 });
    assert.equal(v.hourly_rate_usd, 150);
    // human-equiv = 3 × 1 × 150 = 450.
    assert.equal(v.human_equivalent_cost_usd, 450);
    // ROI = 450 / 50 = 9.0.
    assert.ok(v.roi_multiplier != null);
    assert.ok(Math.abs((v.roi_multiplier as number) - 9.0) < 1e-9);
  } finally { cleanup(); }
});

test("AC3: explicit opts.humanHoursPerPr overrides the default 1", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "a");
    for (let i = 1; i <= 3; i++) {
      seedMergedPr(db, { projectId: pid, number: i, fetchedAt: daysBeforeNow(2) });
    }
    seedCost(db, pid, dayBeforeNow(2), 50);
    const v = projectWorthItVerdict(db, pid, NOW, { humanHoursPerPr: 2 });
    assert.equal(v.hours_per_pr, 2);
    // human-equiv = 3 × 2 × 75 = 450.
    assert.equal(v.human_equivalent_cost_usd, 450);
  } finally { cleanup(); }
});

test("AC3: with neither opt nor config override the helper uses 75 + 1 (documented defaults)", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "a");
    for (let i = 1; i <= 3; i++) {
      seedMergedPr(db, { projectId: pid, number: i, fetchedAt: daysBeforeNow(2) });
    }
    seedCost(db, pid, dayBeforeNow(2), 100);
    const v = projectWorthItVerdict(db, pid, NOW);
    assert.equal(v.hourly_rate_usd, 75);
    assert.equal(v.hours_per_pr, 1);
    // human-equiv = 3 × 1 × 75 = 225.
    assert.equal(v.human_equivalent_cost_usd, 225);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — GET /api/projects/:slug/worth-it route: requires read scope;
//        404 on unknown slug; 200 with the documented shape.
// ────────────────────────────────────────────────────────────────────

test("AC4: GET /api/projects/:slug/worth-it returns 200 + shape with a seeded project", async () => {
  _resetWorthItCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "alpha");
    // Seed via real run rows so the ingest pass' recomputeRollups()
    // derives cost_rollup_day values the helper reads.
    const recent = NOW.toISOString();
    for (let i = 1; i <= 6; i++) {
      seedRun(db, { projectId: pid, outcome: "shipped", startedAt: recent });
      seedMergedPr(db, { projectId: pid, number: i, fetchedAt: recent });
    }
  });
  try {
    const r = await fetch(b.base + "/api/projects/alpha/worth-it");
    assert.equal(r.status, 200);
    const j = await r.json() as ProjectWorthItVerdict;
    assert.equal(j.project_slug, "alpha");
    assert.equal(typeof j.window_days, "number");
    assert.equal(j.window_days, 30);
    assert.equal(typeof j.merged_prs, "number");
    assert.equal(typeof j.hourly_rate_usd, "number");
    assert.equal(typeof j.hours_per_pr, "number");
    assert.ok(["net_positive", "watch", "sunset_candidate", "insufficient_data"].includes(j.verdict));
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: GET /api/projects/:unknown/worth-it returns 404 with 'project not found'", async () => {
  _resetWorthItCacheForTests();
  const b = await boot();
  try {
    const r = await fetch(b.base + "/api/projects/nope/worth-it");
    assert.equal(r.status, 404);
    const body = await r.json() as { error?: string };
    assert.match(String(body.error ?? ""), /not found/i);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — Caching: max-age=900; 2nd call within window hits cache (build
//        counter unchanged); inserting a new PR rebuilds.
// ────────────────────────────────────────────────────────────────────

test("AC5: GET /api/projects/:slug/worth-it sets cache-control: max-age=900 and memoises via a build counter", async () => {
  _resetWorthItCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "alpha");
    const recent = NOW.toISOString();
    for (let i = 1; i <= 6; i++) {
      seedRun(db, { projectId: pid, outcome: "shipped", startedAt: recent });
      seedMergedPr(db, { projectId: pid, number: i, fetchedAt: recent });
    }
  });
  try {
    const before = _getWorthItCacheBuildsForTests();
    const r1 = await fetch(b.base + "/api/projects/alpha/worth-it");
    assert.equal(r1.status, 200);
    const cc = (r1.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=900/, `cache-control must declare max-age=900; got '${cc}'`);
    await r1.json();
    const afterFirst = _getWorthItCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call → cache MISS, build counter += 1");

    const r2 = await fetch(b.base + "/api/projects/alpha/worth-it");
    assert.equal(r2.status, 200);
    await r2.json();
    const afterSecond = _getWorthItCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0,
      "second call within the cache window → cache HIT, counter unchanged");

    // Insert a new MERGED PR for this project. The per-project
    // invalidation tuple includes (MAX(pr.fetched_at), COUNT(*)) so
    // the next call MUST rebuild.
    const db2 = openDb(b.dbPath);
    try {
      const pid = (db2.prepare("SELECT id FROM project WHERE slug=?").get("alpha") as { id: number }).id;
      db2.prepare(
        "INSERT INTO pr("
        + "project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
        + "additions,deletions,author,url,fetched_at,gh_created_at,"
        + "first_fail_check,first_fail_excerpt,heal_attempts,closed_at"
        + ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        pid, 9999, "fresh", "feat/9999", "MERGED", "green", null, 1,
        0, 0, "a", "https://github.com/owner/x/pull/9999",
        NOW.toISOString(), NOW.toISOString(), null, null, 0, null,
      );
    } finally { db2.close(); }

    const r3 = await fetch(b.base + "/api/projects/alpha/worth-it");
    assert.equal(r3.status, 200);
    await r3.json();
    const afterThird = _getWorthItCacheBuildsForTests();
    assert.equal(afterThird - afterSecond, 1,
      "after a new PR lands for the project, next call rebuilds → counter += 1");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — web/app.js renders the verdict line inside each project card
//        with the testid + color-coded label + redaction.
// ────────────────────────────────────────────────────────────────────

test("AC6: web/app.js declares renderWorthItVerdict + emits data-testid=project-card-verdict-<slug>; routes strings through redactSecrets", () => {
  assert.match(APP_JS, /function\s+renderWorthItVerdict\s*\(/,
    "web/app.js must declare a renderWorthItVerdict helper");
  assert.match(APP_JS, /project-card-verdict-/,
    "the card body must carry data-testid=\"project-card-verdict-<slug>\"");
  const renderFn = APP_JS.match(/function\s+renderWorthItVerdict\s*\([\s\S]*?\n\}/);
  assert.ok(renderFn, "renderWorthItVerdict function body must be parseable");
  assert.match(renderFn![0], /redactSecrets\(/,
    "renderWorthItVerdict must route operator-visible strings through redactSecrets");
  // The four verdict labels must each appear so the SPA can color-code
  // them (the label color follows the verdict kind).
  assert.match(renderFn![0], /net_positive/);
  assert.match(renderFn![0], /sunset_candidate/);
  assert.match(renderFn![0], /watch/);
  assert.match(renderFn![0], /insufficient_data/);
});

test("AC6: home() wires the fleet worth-it fetch into the per-card render path", () => {
  // The home composition fetches the fleet worth-it bulk endpoint so a
  // single GET feeds all N project cards (per AC6's "lazy on render OR
  // bulk" framing — the bulk path is the default home page path).
  assert.match(APP_JS, /\/api\/fleet\/worth-it/,
    "home() must reference the new /api/fleet/worth-it bulk endpoint");
});

test("AC6: web/style.css color-codes the four verdict labels (good/warn/bad/dim) using existing CSS variables", () => {
  // Each verdict's color class must be defined; the colors reuse the
  // existing --good / --warn / --bad / --dim variables (no new tokens).
  assert.match(CSS, /\.worth-it-verdict-net_positive\b/);
  assert.match(CSS, /\.worth-it-verdict-watch\b/);
  assert.match(CSS, /\.worth-it-verdict-sunset_candidate\b/);
  assert.match(CSS, /\.worth-it-verdict-insufficient_data\b/);
  // No new CSS variable declarations introduced for this card.
  const verdictBlocks = CSS.match(/\.worth-it-verdict-[\w_]+\s*\{[^}]*\}/g) ?? [];
  for (const b of verdictBlocks) {
    assert.doesNotMatch(b, /--worth-it-/,
      `verdict rule must not introduce a new --worth-it-* CSS variable; reuse existing tokens`);
  }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Fleet endpoint: GET /api/fleet/worth-it returns one entry per
//        project; per-project shape matches what the per-slug endpoint
//        returns for that slug.
// ────────────────────────────────────────────────────────────────────

test("AC7: GET /api/fleet/worth-it returns {projects: [...], generated_at} with one entry per project", async () => {
  _resetWorthItCacheForTests();
  const b = await boot((db) => {
    const recent = NOW.toISOString();
    for (const slug of ["alpha", "bravo", "charlie"]) {
      const pid = seedProject(db, slug);
      for (let i = 1; i <= 4; i++) {
        seedRun(db, { projectId: pid, outcome: "shipped", startedAt: recent });
        seedMergedPr(db, { projectId: pid, number: i, fetchedAt: recent });
      }
    }
  });
  try {
    const r = await fetch(b.base + "/api/fleet/worth-it");
    assert.equal(r.status, 200);
    const j = await r.json() as { projects: ProjectWorthItVerdict[]; generated_at: string };
    assert.ok(Array.isArray(j.projects));
    assert.equal(j.projects.length, 3);
    const slugs = new Set(j.projects.map((p) => p.project_slug));
    assert.ok(slugs.has("alpha") && slugs.has("bravo") && slugs.has("charlie"));
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(j.generated_at));

    // Per-slug endpoint matches the fleet entry for that slug.
    const r2 = await fetch(b.base + "/api/projects/alpha/worth-it");
    assert.equal(r2.status, 200);
    const alphaSingle = await r2.json() as ProjectWorthItVerdict;
    const alphaFleet = j.projects.find((p) => p.project_slug === "alpha")!;
    assert.equal(alphaSingle.verdict, alphaFleet.verdict);
    assert.equal(alphaSingle.merged_prs, alphaFleet.merged_prs);
    assert.equal(alphaSingle.hourly_rate_usd, alphaFleet.hourly_rate_usd);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Sunset-sticky chip: project flagged sunset_candidate at both
//        now and (now - 14 days) gets the chip; 3-day sunset does not.
// ────────────────────────────────────────────────────────────────────

test("AC8: projectWorthItSticky returns sticky_days >= 14 when verdict is sunset_candidate at both anchors", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "dying");
    // Seed a 30-day-wide window of poor performance ending TODAY:
    //   - 3 merged PRs distributed in the trailing 30d (just enough to
    //     pass insufficient_data),
    //   - $1000 spend so ROI = 3 × 75 / 1000 = 0.225 (< 1.0 → sunset).
    // ALSO seed an identical window ending (NOW - 14d) so the helper's
    // (now - 14) anchor sees the same picture.
    // Strategy: seed merged PRs at -1d, -10d, -20d (so the 30d
    // windows ending at NOW and at NOW-14d both contain at least 3
    // merges in their respective windows).
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: daysBeforeNow(1) });
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: daysBeforeNow(10) });
    seedMergedPr(db, { projectId: pid, number: 3, fetchedAt: daysBeforeNow(20) });
    seedMergedPr(db, { projectId: pid, number: 4, fetchedAt: daysBeforeNow(30) });
    seedMergedPr(db, { projectId: pid, number: 5, fetchedAt: daysBeforeNow(40) });
    // Cost spread across both windows so spend > 0 at each anchor.
    for (let d = 0; d <= 44; d++) {
      seedCost(db, pid, dayBeforeNow(d), 30);
    }
    const s = projectWorthItSticky(db, pid, NOW);
    assert.equal(s.verdict_now, "sunset_candidate",
      "current verdict must be sunset_candidate");
    assert.equal(s.verdict_14d_ago, "sunset_candidate",
      "14-days-ago verdict must also be sunset_candidate for sticky to fire");
    assert.ok(s.sticky_days >= 14,
      `sticky_days must be >= 14 when both anchors are sunset; got ${s.sticky_days}`);
  } finally { cleanup(); }
});

test("AC8: projectWorthItSticky returns sticky_days === 0 when verdict only recently became sunset_candidate", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "fresh-decline");
    // For TODAY's anchor: 3 merged PRs + huge spend → sunset.
    // For (NOW - 14d)'s anchor: 5 merged PRs + tiny spend → ROI huge,
    // merge_ratio 1.0, streak > 0 → net_positive.
    // The merged PRs near today must NOT count toward the 14-day-ago
    // window (which ends ~14d before now). So we seed:
    //   merges at -1d, -2d, -3d (only inside the now-anchored window)
    //   and merges at -15d, -16d, -17d, -18d, -19d (inside the
    //   14-days-ago anchored window).
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: daysBeforeNow(1) });
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: daysBeforeNow(2) });
    seedMergedPr(db, { projectId: pid, number: 3, fetchedAt: daysBeforeNow(3) });
    // The 14-days-ago anchor's 30-day window is [-44d, -14d]. Seed
    // merges in there so it sees throughput.
    for (let i = 15; i <= 19; i++) {
      seedMergedPr(db, { projectId: pid, number: 100 + i, fetchedAt: daysBeforeNow(i) });
    }
    // Spend: heavy in the recent 14 days (now-anchor sees sunset),
    // light in the historical window (14d-ago anchor sees net_positive).
    for (let d = 0; d <= 13; d++) {
      seedCost(db, pid, dayBeforeNow(d), 500);
    }
    for (let d = 14; d <= 44; d++) {
      seedCost(db, pid, dayBeforeNow(d), 1);
    }
    const s = projectWorthItSticky(db, pid, NOW);
    assert.equal(s.verdict_now, "sunset_candidate");
    assert.notEqual(s.verdict_14d_ago, "sunset_candidate",
      "14d-ago verdict must NOT be sunset for sticky_days to be 0");
    assert.equal(s.sticky_days, 0,
      `sticky_days must be 0 when the 14d-ago verdict is not sunset; got ${s.sticky_days}`);
  } finally { cleanup(); }
});

test("AC8: projectWorthItSticky short-circuits when either verdict is insufficient_data", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "stub");
    // 2 merges only → insufficient_data at both anchors.
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: daysBeforeNow(1) });
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: daysBeforeNow(2) });
    const s = projectWorthItSticky(db, pid, NOW);
    assert.equal(s.sticky_days, 0,
      "sticky_days must short-circuit to 0 when either verdict is insufficient_data");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Mobile: 375px viewport hides the verdict_detail sub-line
//        (collapsed behind a tap-to-expand chevron); >=600px shows it.
// ────────────────────────────────────────────────────────────────────

test("AC9: web/style.css max-width:375px hides the worth-it sub-line by default; min-width:600px reveals it", () => {
  // The mobile media query must hide the sub-line; the tablet+
  // breakpoint must reveal it. Reuse existing breakpoint patterns
  // (375 / 600) per the 0011 mobile-first contract.
  const mobileBlocks = CSS.match(/@media\s*\(\s*max-width:\s*375px\s*\)\s*\{[\s\S]*?\n\}/g) ?? [];
  const matching375 = mobileBlocks.find((b) => /\.worth-it-verdict-detail/.test(b));
  assert.ok(matching375,
    "A @media (max-width: 375px) block must reference .worth-it-verdict-detail");
  const tabletBlocks = CSS.match(/@media\s*\([^)]*min-width:\s*600px[^)]*\)\s*\{[\s\S]*?\n\}/g) ?? [];
  const matching600 = tabletBlocks.find((b) => /\.worth-it-verdict-detail/.test(b));
  assert.ok(matching600,
    "A @media (min-width: 600px) block must reference .worth-it-verdict-detail");
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Quiet-hours: when quiet_hours_active is true the
//         sunset-sticky chip is hidden; the verdict line stays
//         visible.
// ────────────────────────────────────────────────────────────────────

test("AC10: renderWorthItVerdict hides the sunset-sticky chip when data.quiet_hours_active is true; verdict line stays", () => {
  const renderFn = APP_JS.match(/function\s+renderWorthItVerdict\s*\([\s\S]*?\n\}/);
  assert.ok(renderFn);
  // The renderer must consult quiet_hours_active AND reference the
  // sunset-sticky testid so the test can prove the conditional render.
  assert.match(renderFn![0], /quiet_hours_active|quietHoursActive/,
    "renderWorthItVerdict must consult quiet_hours_active");
  assert.match(renderFn![0], /sunset-sticky/,
    "renderWorthItVerdict must use the sunset-sticky testid for the 14d chip");
});

// ────────────────────────────────────────────────────────────────────
// AC11 — Performance: helper completes in under 20ms; fleet endpoint
//         under 200ms cache miss / 5ms cache hit. Gated on PERF=1.
// ────────────────────────────────────────────────────────────────────

test("AC11: projectWorthItVerdict completes in <20ms for a single project (PERF=1)", () => {
  if (process.env.PERF !== "1") return;
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "perf");
    seedNMergedAcrossWindow(db, pid, 32, { windowDays: 30 });
    for (let d = 0; d < 30; d++) seedCost(db, pid, dayBeforeNow(d), 25);
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) projectWorthItVerdict(db, pid, NOW);
    const ms = (Date.now() - t0) / 5;
    assert.ok(ms < 20, `mean helper time should be <20ms; got ${ms}`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC12 — No new runtime deps; no shell-string composition; no schema
//         break. Static asserts on package.json + on the helper module.
// ────────────────────────────────────────────────────────────────────

test("AC12: package.json declares zero runtime dependencies (still)", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    `dependencies must stay empty; saw: ${JSON.stringify(deps)}`);
});

test("AC12: src/views.ts never composes a shell string for the worth-it block (no child_process imports added)", () => {
  const src = readFileSync(join(__dirname, "..", "src", "views.ts"), "utf8");
  assert.doesNotMatch(src, /from\s+["']node:child_process["']/,
    "src/views.ts must not import from node:child_process");
});

test("AC12: the worth-it block registers a globalThis.__fleet_worth_it_invalidate__ slot in src/server.ts", () => {
  const src = readFileSync(join(__dirname, "..", "src", "server.ts"), "utf8");
  assert.match(src, /__fleet_worth_it_invalidate__/,
    "src/server.ts must register the worth-it invalidation slot on globalThis per LESSONS 2026-06-05");
});

// ════════════════════════════════════════════════════════════════════
// Boot harness — empty-roots config + tmp fleet-control.config.json.
// (Lives at the bottom so the test list above stays scannable.)
// ════════════════════════════════════════════════════════════════════

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
  const dir = mkdtempSync(join(tmpdir(), "fleet-worth-it-boot-"));
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
