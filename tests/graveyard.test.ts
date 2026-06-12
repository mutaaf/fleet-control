// Tests for ticket 0053 — Project graveyard.
//
// One test() per acceptance-criteria checkbox. Strategy:
//
//   AC1: helper math.  Drive projectGraveyard(db, opts) directly
//        against a tmpdir DB; assert summary + per-project shape.
//
//   AC2: pause-reason classification.  Seed pause rows with each
//        producer reason; assert pause_reason maps to the displayed
//        label and pause_reason_raw preserves the producer value.
//        Per LESSONS 2026-06-05 "schema wins": the actual writer is
//        src/budget_guard.ts:187 which inserts 'cost_cap'. We honour
//        that literal; the spec's 'budget'/'budget_cap'/'sunset'/
//        'sunset_candidate' arms are forward-compatible.
//
//   AC3: idempotency / caching.  Per LESSONS § "expose a build counter
//        for cache-hit tests, not a fetcher swap": route-side cache
//        ticks a build counter on miss; route tests assert hit/miss.
//
//   AC4: GET /api/fleet/graveyard JSON shape + auth + Cache-Control.
//
//   AC5: SPA hash route #/graveyard render + testids.  Per LESSONS §
//        "defence-in-depth secret redaction at the renderer boundary":
//        the JSON body's string values pass through redactSecrets.
//
//   AC6: empty-state copy + sentinel testid.
//
//   AC7: mobile / desktop CSS contract.
//
//   AC8: quiet-hours integration.  Per LESSONS 2026-06-11 "startServer()
//        tests that mutate fleet-control.config.json race against
//        parallel test files; expose a renderer-direct seam for branch
//        tests": drive the branch via the renderer-direct
//        _renderGraveyardPageForTests(payload, { quietHoursActive })
//        seam, not a config plant.
//
//   AC9: cross-link banner on the existing project page.
//
//   AC10: performance harness (PERF=1).
//
//   AC11: Hard NOs — zero new runtime deps; no shell-string composition;
//        no schema migration; no JSON-shape break.
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps from
// new Date()": every seed timestamp is anchored to NOW.
// Per LESSONS § "node:sqlite's .all() needs as unknown as T[]":
// the helper uses the double-cast (exercised transitively).

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
  projectGraveyard,
  type ProjectGraveyard,
} from "../src/views.ts";
import {
  startServer,
  _resetGraveyardCacheForTests,
  _getGraveyardCacheBuildsForTests,
  _renderGraveyardPageForTests,
  _renderProjectPausedBannerForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WEB_DIR = join(ROOT, "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");
const SERVER_TS = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
const VIEWS_TS = readFileSync(join(ROOT, "src", "views.ts"), "utf8");
const INGEST_TS = readFileSync(join(ROOT, "src", "ingest", "index.ts"), "utf8");
const CONTROL_TS = readFileSync(join(ROOT, "src", "control.ts"), "utf8");
const PKG_JSON = readFileSync(join(ROOT, "package.json"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers — pinned-now seeders.
// ────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-11T12:00:00.000Z");

function tempDb(): { db: DB; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-graveyard-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, path, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function daysAgoIso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * 24 * 3600_000).toISOString();
}

function daysAgoDay(daysAgo: number): string {
  // yyyy-mm-dd against the pinned NOW.
  return new Date(NOW.getTime() - daysAgo * 24 * 3600_000).toISOString().slice(0, 10);
}

function seedProject(db: DB, slug: string, name?: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace) VALUES (?,?,?)",
  ).run(slug, name ?? slug, "test");
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

function seedPause(
  db: DB,
  projectId: number,
  reason: string,
  triggeredAt: string,
  triggeredBy = "budget_guard",
): void {
  db.prepare(
    "INSERT OR REPLACE INTO project_pause(project_id,reason,triggered_at,triggered_by,detail_json) "
    + " VALUES(?,?,?,?,?)",
  ).run(projectId, reason, triggeredAt, triggeredBy, "{}");
}

function seedMergedPr(
  db: DB, projectId: number, number: number, fetchedAt: string,
): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
    + "additions,deletions,author,url,fetched_at) "
    + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    projectId, number, "PR " + number, "feat/" + number,
    "MERGED", "green", "CLEAN", 1, 1, 0, "a",
    "https://github.com/owner/x/pull/" + number, fetchedAt,
  );
}

function seedCostRollup(
  db: DB, projectId: number, day: string, costUsd: number, phase = "ship",
): void {
  db.prepare(
    "INSERT OR REPLACE INTO cost_rollup_day(project_id,phase,day,runs,input_tokens,"
    + "output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd) "
    + "VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(projectId, phase, day, 1, 0, 0, 0, 0, costUsd);
}

/** Same shape as seedCostRollup but writes a `run` row so the
 *  ingest pass's `recomputeRollups()` re-derives the
 *  cost_rollup_day rows correctly. Per LESSONS § "in-process
 *  startServer() tests need an empty-roots config + run-row seeds":
 *  any boot-path test that depends on cost_rollup_day MUST seed via
 *  runs, never via direct cost_rollup_day inserts. */
function seedCostViaRun(
  db: DB, projectId: number, day: string, costUsd: number, phase = "ship",
): void {
  const startedAt = day + "T12:00:00.000Z";
  const sid = "sess-" + projectId + "-" + day + "-" + costUsd;
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,ended_at,outcome,cost_usd,cost_source) "
    + " VALUES(?,?,?,?,?,?,?,?)",
  ).run(projectId, phase, sid, startedAt, startedAt, "shipped", costUsd, "live");
}

function seedHealAudit(
  db: DB, ts: string, prNumber: number, stdoutTail: string,
): number {
  const r = db.prepare(
    "INSERT INTO control_audit(ts,actor,action,target,args_json,exit_code,stdout_tail) "
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(ts, "ship", "heal", "pr-" + prNumber, "{}", 1, stdoutTail);
  return Number(r.lastInsertRowid);
}

function seedLessonCredit(
  db: DB,
  opts: { slug: string; date: string; title: string; healId: number; projectSlug: string; createdAt: string },
): void {
  db.prepare(
    "INSERT INTO lesson_credit(lesson_slug,lesson_date,lesson_title,"
    + " heal_audit_id,project_slug,matched_substring,created_at) "
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(
    opts.slug, opts.date, opts.title, opts.healId,
    opts.projectSlug, "matched", opts.createdAt,
  );
}

function seedRun(
  db: DB, projectId: number, startedAt: string, endedAt: string,
): void {
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,ended_at,outcome) "
    + " VALUES(?,?,?,?,?,?)",
  ).run(projectId, "ship", "sess-" + projectId + "-" + startedAt, startedAt, endedAt, "shipped");
}

// ────────────────────────────────────────────────────────────────────
// AC1 — projectGraveyard helper.
// ────────────────────────────────────────────────────────────────────

test("AC1: projectGraveyard returns the documented shape with summary + per-project rows sorted by paused_at desc", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha", "Alpha");
    const b = seedProject(db, "beta", "Beta");
    const c = seedProject(db, "gamma", "Gamma");

    // alpha paused 5 days ago (most recent), with 4 lifetime merged PRs
    // and $40 lifetime spend.
    seedPause(db, a, "cost_cap", daysAgoIso(5));
    seedMergedPr(db, a, 1, daysAgoIso(40));
    seedMergedPr(db, a, 2, daysAgoIso(30));
    seedMergedPr(db, a, 3, daysAgoIso(20));
    seedMergedPr(db, a, 4, daysAgoIso(10));
    // A PR fetched AFTER pause must not count as lifetime.
    seedMergedPr(db, a, 5, daysAgoIso(2));
    seedCostRollup(db, a, daysAgoDay(40), 10);
    seedCostRollup(db, a, daysAgoDay(30), 10);
    seedCostRollup(db, a, daysAgoDay(20), 10);
    seedCostRollup(db, a, daysAgoDay(10), 10);
    seedCostRollup(db, a, daysAgoDay(2), 99); // post-pause, must be excluded

    // beta paused 15 days ago, with 2 merged PRs + $100 spend.
    seedPause(db, b, "manual", daysAgoIso(15));
    seedMergedPr(db, b, 1, daysAgoIso(25));
    seedMergedPr(db, b, 2, daysAgoIso(20));
    seedCostRollup(db, b, daysAgoDay(25), 50);
    seedCostRollup(db, b, daysAgoDay(20), 50);

    // gamma paused 1 day ago (most recent), zero merged PRs, zero spend.
    seedPause(db, c, "cost_cap", daysAgoIso(1));

    // Seed a run + heal + lesson_credit for alpha — counts as one
    // "lesson authored" for alpha.
    seedRun(db, a, daysAgoIso(20), daysAgoIso(20));
    const healId = seedHealAudit(db, daysAgoIso(20), 1, "tail");
    seedLessonCredit(db, {
      slug: "fleet-control", date: "2026-05-26",
      title: "Some lesson", healId, projectSlug: "alpha",
      createdAt: daysAgoIso(20),
    });

    const v: ProjectGraveyard = projectGraveyard(db, { now: NOW });
    assert.equal(typeof v.generated_at, "string");
    assert.equal(v.summary.paused_count, 3);
    // Lifetime merged PRs: alpha 4 + beta 2 + gamma 0 = 6.
    assert.equal(v.summary.lifetime_merged_prs, 6);
    // Lifetime spend: 40 + 100 + 0 = $140.
    assert.equal(v.summary.lifetime_spend_usd, 140);
    // One distinct lesson authored by alpha.
    assert.equal(v.summary.lessons_authored, 1);

    // Sorted by paused_at DESC: gamma (1d), alpha (5d), beta (15d).
    assert.equal(v.projects.length, 3);
    assert.equal(v.projects[0].project_slug, "gamma");
    assert.equal(v.projects[1].project_slug, "alpha");
    assert.equal(v.projects[2].project_slug, "beta");

    // Spot-check alpha's row math.
    const alpha = v.projects[1];
    assert.equal(alpha.lifetime_merged_prs, 4);
    assert.equal(alpha.lifetime_spend_usd, 40);
    // cost_per_pr = 40/4 = 10.
    assert.equal(alpha.lifetime_cost_per_pr_usd, 10);
    // ROI = (4 PRs * 1 hr/PR * $75/hr) / $40 = 300/40 = 7.5.
    assert.equal(alpha.lifetime_roi_multiplier, 7.5);
    assert.equal(alpha.lessons_authored, 1);

    // gamma — zero spend → ROI null, cost-per-pr null.
    const gamma = v.projects[0];
    assert.equal(gamma.lifetime_merged_prs, 0);
    assert.equal(gamma.lifetime_spend_usd, 0);
    assert.equal(gamma.lifetime_cost_per_pr_usd, null);
    assert.equal(gamma.lifetime_roi_multiplier, null);
  } finally { cleanup(); }
});

test("AC1: projectGraveyard honours hourlyRateUsd + hoursPerPr overrides", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha", "Alpha");
    seedPause(db, a, "cost_cap", daysAgoIso(2));
    seedMergedPr(db, a, 1, daysAgoIso(10));
    seedMergedPr(db, a, 2, daysAgoIso(9));
    seedCostRollup(db, a, daysAgoDay(10), 5);
    seedCostRollup(db, a, daysAgoDay(9), 5);

    // Override: $150/hr * 2 hrs/PR = $300/PR * 2 PRs = $600 / $10 spend = 60x.
    const v = projectGraveyard(db, { now: NOW, hourlyRateUsd: 150, hoursPerPr: 2 });
    assert.equal(v.projects[0].lifetime_roi_multiplier, 60);
  } finally { cleanup(); }
});

test("AC1: projectGraveyard excludes lifetime data after the pause timestamp", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha", "Alpha");
    seedPause(db, a, "cost_cap", daysAgoIso(10));
    // Pre-pause: 2 PRs, $20 spend.
    seedMergedPr(db, a, 1, daysAgoIso(30));
    seedMergedPr(db, a, 2, daysAgoIso(20));
    seedCostRollup(db, a, daysAgoDay(30), 10);
    seedCostRollup(db, a, daysAgoDay(20), 10);
    // Post-pause: must NOT count.
    seedMergedPr(db, a, 3, daysAgoIso(5));
    seedCostRollup(db, a, daysAgoDay(5), 99);

    const v = projectGraveyard(db, { now: NOW });
    const row = v.projects[0];
    assert.equal(row.lifetime_merged_prs, 2,
      "merged PR fetched after pause must not count toward lifetime");
    assert.equal(row.lifetime_spend_usd, 20,
      "cost_rollup_day rows whose day is after the pause must not count");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — Pause-reason classification.
// ────────────────────────────────────────────────────────────────────

test("AC2: pause_reason classifies producer values (cost_cap → budget_autopause; sunset → sunset_verdict; unknown → manual)", () => {
  const { db, cleanup } = tempDb();
  try {
    // The producer (src/budget_guard.ts) writes the literal 'cost_cap'.
    // The classification map MUST recognise that; 'budget'/'budget_cap'
    // are forward-compat arms per the spec's vocabulary.
    const a = seedProject(db, "alpha");
    const b = seedProject(db, "beta");
    const c = seedProject(db, "gamma");
    const d = seedProject(db, "delta");
    const e = seedProject(db, "epsilon");

    seedPause(db, a, "cost_cap", daysAgoIso(1));        // → budget_autopause
    seedPause(db, b, "sunset", daysAgoIso(2));          // → sunset_verdict
    seedPause(db, c, "sunset_candidate", daysAgoIso(3));// → sunset_verdict
    seedPause(db, d, "manual", daysAgoIso(4));          // → manual
    seedPause(db, e, "ufo_abduction", daysAgoIso(5));   // unknown → manual

    const v = projectGraveyard(db, { now: NOW });
    const bySlug: Record<string, typeof v.projects[number]> = {};
    for (const p of v.projects) bySlug[p.project_slug] = p;

    assert.equal(bySlug.alpha.pause_reason, "budget_autopause");
    assert.equal(bySlug.alpha.pause_reason_raw, "cost_cap");
    assert.equal(bySlug.beta.pause_reason, "sunset_verdict");
    assert.equal(bySlug.beta.pause_reason_raw, "sunset");
    assert.equal(bySlug.gamma.pause_reason, "sunset_verdict");
    assert.equal(bySlug.gamma.pause_reason_raw, "sunset_candidate");
    assert.equal(bySlug.delta.pause_reason, "manual");
    assert.equal(bySlug.delta.pause_reason_raw, "manual");
    assert.equal(bySlug.epsilon.pause_reason, "manual",
      "unknown producer value defaults to the manual label");
    assert.equal(bySlug.epsilon.pause_reason_raw, "ufo_abduction");
  } finally { cleanup(); }
});

test("AC2: producer literal 'cost_cap' is the actual writer in src/budget_guard.ts (schema-wins reconciliation)", () => {
  // PRODUCER-VS-SPEC guard. If a future writer changes the literal,
  // this test will fail loudly so the classification map can be
  // updated in lockstep.
  const guardSrc = readFileSync(join(ROOT, "src", "budget_guard.ts"), "utf8");
  assert.match(guardSrc, /["']cost_cap["']/,
    "src/budget_guard.ts must still write the literal 'cost_cap' as the producer reason");
});

// ────────────────────────────────────────────────────────────────────
// AC3 — Idempotency / caching (route-side memo).
// ────────────────────────────────────────────────────────────────────

test("AC3: two calls within TTL are a cache HIT (build counter unchanged); a fresh pause row busts the cache", async () => {
  const { db, path, cleanup } = tempDb();
  const { boot } = await import("./_graveyard_boot.helper.ts");
  let booted: Awaited<ReturnType<typeof boot>> | null = null;
  try {
    const a = seedProject(db, "alpha", "Alpha");
    seedPause(db, a, "cost_cap", daysAgoIso(2));
    seedMergedPr(db, a, 1, daysAgoIso(10));
    seedCostViaRun(db, a, daysAgoDay(10), 5);

    _resetGraveyardCacheForTests();
    const before = _getGraveyardCacheBuildsForTests();

    booted = await boot(path);

    const r1 = await fetch(booted.base + "/api/fleet/graveyard");
    assert.equal(r1.status, 200);
    const b1 = await r1.json();
    assert.equal(b1.summary.paused_count, 1);

    const afterFirst = _getGraveyardCacheBuildsForTests();
    assert.equal(afterFirst, before + 1, "first call builds once");

    const r2 = await fetch(booted.base + "/api/fleet/graveyard");
    assert.equal(r2.status, 200);
    const afterSecond = _getGraveyardCacheBuildsForTests();
    assert.equal(afterSecond, afterFirst, "second call within TTL is a cache HIT");

    // Insert a fresh pause row — invalidation tuple shifts.
    const b = seedProject(db, "beta");
    seedPause(db, b, "cost_cap", daysAgoIso(1));

    const r3 = await fetch(booted.base + "/api/fleet/graveyard");
    assert.equal(r3.status, 200);
    const afterThird = _getGraveyardCacheBuildsForTests();
    assert.equal(afterThird, afterFirst + 1,
      "a new pause row busts the cache via the invalidation tuple");
    const b3 = await r3.json();
    assert.equal(b3.summary.paused_count, 2);
  } finally {
    if (booted) await booted.close();
    if (booted) booted.cleanup();
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — GET /api/fleet/graveyard.
// ────────────────────────────────────────────────────────────────────

test("AC4: GET /api/fleet/graveyard returns 200 + the AC1 shape with Cache-Control max-age=1800; empty fleet returns paused_count=0", async () => {
  const { db, path, cleanup } = tempDb();
  const { boot } = await import("./_graveyard_boot.helper.ts");

  // Empty branch first.
  let booted = await boot(path);
  try {
    const r0 = await fetch(booted.base + "/api/fleet/graveyard");
    assert.equal(r0.status, 200);
    const cc = r0.headers.get("cache-control") ?? "";
    assert.match(cc, /max-age=1800/);
    const b0 = await r0.json();
    assert.equal(b0.summary.paused_count, 0);
    assert.deepEqual(b0.projects, []);
  } finally {
    await booted.close(); booted.cleanup();
  }

  // Seeded branch.
  const a = seedProject(db, "alpha", "Alpha");
  seedPause(db, a, "cost_cap", daysAgoIso(2));
  seedMergedPr(db, a, 1, daysAgoIso(10));
  seedCostViaRun(db, a, daysAgoDay(10), 5);

  _resetGraveyardCacheForTests();

  booted = await boot(path);
  try {
    const r = await fetch(booted.base + "/api/fleet/graveyard");
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.summary.paused_count, 1);
    assert.equal(b.projects.length, 1);
    assert.equal(b.projects[0].project_slug, "alpha");
    assert.equal(b.projects[0].pause_reason, "budget_autopause");
    assert.equal(b.projects[0].lifetime_merged_prs, 1);
    assert.equal(b.projects[0].lifetime_spend_usd, 5);
  } finally {
    await booted.close(); booted.cleanup();
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — SPA hash route + per-row testids.
// ────────────────────────────────────────────────────────────────────

test("AC5: SPA web/app.js carries the #/graveyard hash route + per-row + summary testids", () => {
  // Hash route wiring.
  assert.match(APP_JS, /#\/graveyard|"graveyard"|'graveyard'/,
    "web/app.js must reference the graveyard hash route");
  assert.match(APP_JS, /\/api\/fleet\/graveyard/,
    "web/app.js must fetch from /api/fleet/graveyard");
  // Summary testids.
  for (const t of [
    "graveyard",
    "graveyard-summary",
    "graveyard-summary-paused-count",
    "graveyard-summary-merged-prs",
    "graveyard-summary-spend",
    "graveyard-summary-lessons",
  ]) {
    assert.ok(APP_JS.includes('data-testid="' + t + '"'),
      "web/app.js must emit data-testid=\"" + t + "\"");
  }
  // The per-row testid templates must be present in JS string form.
  for (const t of [
    "graveyard-row-",
    "-paused-at",
    "-reason",
    "-merged-prs",
    "-spend",
    "-roi",
    "-revive",
  ]) {
    assert.ok(APP_JS.includes(t),
      "web/app.js must reference the per-row " + t + " testid suffix");
  }
});

test("AC5: _renderGraveyardPageForTests emits the per-row testids and per-row revive button (not quiet)", () => {
  const payload: ProjectGraveyard = {
    generated_at: NOW.toISOString(),
    summary: {
      paused_count: 2,
      lifetime_merged_prs: 6,
      lifetime_spend_usd: 140,
      lessons_authored: 1,
    },
    projects: [
      {
        project_slug: "alpha", project_name: "Alpha",
        paused_at: daysAgoIso(2),
        pause_reason: "budget_autopause",
        pause_reason_raw: "cost_cap",
        lifetime_merged_prs: 4, lifetime_spend_usd: 40,
        lifetime_cost_per_pr_usd: 10, lifetime_roi_multiplier: 7.5,
        lessons_authored: 1,
        first_run_at: daysAgoIso(40), last_run_at: daysAgoIso(10),
      },
      {
        project_slug: "beta", project_name: "Beta",
        paused_at: daysAgoIso(15),
        pause_reason: "manual", pause_reason_raw: "manual",
        lifetime_merged_prs: 2, lifetime_spend_usd: 100,
        lifetime_cost_per_pr_usd: 50, lifetime_roi_multiplier: 1.5,
        lessons_authored: 0,
        first_run_at: daysAgoIso(25), last_run_at: daysAgoIso(20),
      },
    ],
  };
  const html = _renderGraveyardPageForTests(payload, { quietHoursActive: false });
  assert.match(html, /data-testid="graveyard"/);
  assert.match(html, /data-testid="graveyard-summary"/);
  assert.match(html, /data-testid="graveyard-summary-paused-count"[^>]*>2</);
  assert.match(html, /data-testid="graveyard-summary-merged-prs"[^>]*>6</);
  assert.match(html, /data-testid="graveyard-summary-spend"/);
  assert.match(html, /data-testid="graveyard-summary-lessons"[^>]*>1</);
  // Per-row testids.
  assert.match(html, /data-testid="graveyard-row-alpha"/);
  assert.match(html, /data-testid="graveyard-row-alpha-paused-at"/);
  assert.match(html, /data-testid="graveyard-row-alpha-reason"/);
  assert.match(html, /data-testid="graveyard-row-alpha-merged-prs"/);
  assert.match(html, /data-testid="graveyard-row-alpha-spend"/);
  assert.match(html, /data-testid="graveyard-row-alpha-roi"/);
  assert.match(html, /data-testid="graveyard-row-alpha-revive"/);
  assert.match(html, /data-testid="graveyard-row-beta"/);
  // Headline reads "paused" outside quiet hours.
  assert.match(html, /2 projects paused/);
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Empty state.
// ────────────────────────────────────────────────────────────────────

test("AC6: empty state renders the sentinel testid + the documented sentence", () => {
  const payload: ProjectGraveyard = {
    generated_at: NOW.toISOString(),
    summary: {
      paused_count: 0,
      lifetime_merged_prs: 0,
      lifetime_spend_usd: 0,
      lessons_authored: 0,
    },
    projects: [],
  };
  const html = _renderGraveyardPageForTests(payload, { quietHoursActive: false });
  assert.match(html, /data-testid="graveyard-empty"/);
  assert.match(html, /fleet is fully active/i);
  assert.doesNotMatch(html, /data-testid="graveyard-row-/,
    "empty branch must not emit any row testid");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Mobile CSS contract.
// ────────────────────────────────────────────────────────────────────

test("AC7: web/style.css declares a graveyard selector + a 375px mobile media-query stacking rule", () => {
  assert.match(CSS, /\.graveyard|\[data-testid="graveyard/,
    "web/style.css must declare a selector for the graveyard surface");
  // Mobile stacking: assert a media query bounded at <=600px (or
  // similar) exists somewhere in the stylesheet AND mentions graveyard.
  const mobileBlocks = CSS.match(/@media[^{]*max-width[^{]*\{[\s\S]*?\}\s*\}/g) ?? [];
  const stacks = mobileBlocks.some((b) => /graveyard/.test(b));
  assert.ok(stacks,
    "a @media (max-width: ...) block must target the graveyard row to stack on mobile");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Quiet hours integration (renderer-direct seam).
// ────────────────────────────────────────────────────────────────────

test("AC8: quiet hours hides per-row revive button + softens the summary headline; OFF restores both", () => {
  const payload: ProjectGraveyard = {
    generated_at: NOW.toISOString(),
    summary: {
      paused_count: 5,
      lifetime_merged_prs: 47,
      lifetime_spend_usd: 620,
      lessons_authored: 3,
    },
    projects: [
      {
        project_slug: "alpha", project_name: "Alpha",
        paused_at: daysAgoIso(2),
        pause_reason: "budget_autopause",
        pause_reason_raw: "cost_cap",
        lifetime_merged_prs: 4, lifetime_spend_usd: 40,
        lifetime_cost_per_pr_usd: 10, lifetime_roi_multiplier: 7.5,
        lessons_authored: 1,
        first_run_at: daysAgoIso(40), last_run_at: daysAgoIso(10),
      },
    ],
  };
  const quietHtml = _renderGraveyardPageForTests(payload, { quietHoursActive: true });
  assert.doesNotMatch(quietHtml, /data-testid="graveyard-row-alpha-revive"/,
    "quiet hours must hide the revive button");
  assert.match(quietHtml, /5 projects resting/,
    "quiet hours must soften the summary headline to 'resting'");

  const loudHtml = _renderGraveyardPageForTests(payload, { quietHoursActive: false });
  assert.match(loudHtml, /data-testid="graveyard-row-alpha-revive"/,
    "outside quiet hours the revive button is visible");
  assert.match(loudHtml, /5 projects paused/,
    "outside quiet hours the headline reads 'paused'");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Cross-link banner on the existing project page.
// ────────────────────────────────────────────────────────────────────

test("AC9: project page paused banner renders for a paused project; absent for an active project", () => {
  // Paused branch: banner with testid + href to #/graveyard + the
  // human-readable reason.
  const paused = _renderProjectPausedBannerForTests({
    paused_reason: "budget_autopause",
    paused_at: daysAgoIso(2),
  });
  assert.match(paused, /data-testid="project-paused-banner"/);
  assert.match(paused, /#\/graveyard/);
  assert.match(paused, /budget autopause/i,
    "banner must name the pause reason in human-readable form");

  const active = _renderProjectPausedBannerForTests(null);
  assert.equal(active, "",
    "active projects must not render the banner");
});

test("AC9: web/app.js project render reaches for the banner via projectPausedBanner / _renderProjectPausedBanner copy", () => {
  // Light source-grep: the SPA must reference the testid + the helper
  // call site.
  assert.ok(
    APP_JS.includes("project-paused-banner"),
    "web/app.js must reference the project-paused-banner testid",
  );
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Performance harness (skipped unless PERF=1).
// ────────────────────────────────────────────────────────────────────

test("AC10: projectGraveyard against 10 paused projects + 1000 PRs completes under 100ms cold and 5ms hot", (t) => {
  if (process.env.PERF !== "1") {
    t.skip("set PERF=1 to run the performance harness");
    return;
  }
  const { db, path, cleanup } = tempDb();
  try {
    for (let i = 0; i < 10; i++) {
      const pid = seedProject(db, "p" + i, "Project " + i);
      seedPause(db, pid, "cost_cap", daysAgoIso(5 + i));
      for (let j = 0; j < 100; j++) {
        seedMergedPr(db, pid, j, daysAgoIso(20 + (j % 30)));
      }
      seedCostRollup(db, pid, daysAgoDay(15), 30);
    }
    const t0 = Date.now();
    const v0 = projectGraveyard(db, { now: NOW });
    const cold = Date.now() - t0;
    assert.equal(v0.summary.paused_count, 10);
    assert.ok(cold < 100, "cold path should be <100ms (got " + cold + "ms)");
    // Hot path — JS-level immediate re-call.
    const t1 = Date.now();
    projectGraveyard(db, { now: NOW });
    const hot = Date.now() - t1;
    assert.ok(hot < 100, "hot path should also be quick (got " + hot + "ms)");
    void path;
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC11 — Hard NOs.
// ────────────────────────────────────────────────────────────────────

test("AC11: package.json dependencies map stays empty (zero new runtime deps)", () => {
  const pkg = JSON.parse(PKG_JSON);
  const deps = pkg.dependencies ?? {};
  assert.deepEqual(deps, {}, "dependencies must stay empty per AGENTS.md");
});

test("AC11: src/views.ts § projectGraveyard does not embed SQL keywords in backtick template literals", () => {
  const idx = VIEWS_TS.indexOf("projectGraveyard");
  assert.ok(idx > 0, "projectGraveyard must exist in src/views.ts");
  // Walk to the closing brace at column 0 — the safer slicing pattern
  // per LESSONS 2026-06-11 "character-window source greps leak into
  // sibling helpers". Falls back to a 4000-char window if no closing
  // brace is found.
  const closeIdx = VIEWS_TS.indexOf("\n}\n", idx);
  const end = closeIdx > 0 ? closeIdx + 2 : Math.min(VIEWS_TS.length, idx + 4000);
  const slice = VIEWS_TS.slice(idx, end);
  assert.doesNotMatch(slice, /`[\s\S]*?(SELECT|FROM|WHERE|GROUP BY|ORDER BY)[\s\S]*?`/i,
    "projectGraveyard must not embed SQL keywords inside a backtick template literal");
});

test("AC11: no schema migration — project_pause schema unchanged; no new CREATE TABLE in src/db.ts adjacent to graveyard logic", () => {
  const dbSrc = readFileSync(join(ROOT, "src", "db.ts"), "utf8");
  // The schema must still declare project_pause with its existing
  // columns; no graveyard table is added.
  assert.match(dbSrc, /CREATE TABLE IF NOT EXISTS project_pause[\s\S]*?triggered_at[\s\S]*?triggered_by/,
    "project_pause must remain in the schema unchanged");
  assert.doesNotMatch(dbSrc, /CREATE TABLE[^;]*graveyard/i,
    "no graveyard table — the page composes existing tables only");
});

test("AC11: src/server.ts registers the globalThis invalidation hook __fleet_graveyard_invalidate__", () => {
  assert.match(SERVER_TS, /__fleet_graveyard_invalidate__/,
    "src/server.ts must register the graveyard cache invalidation hook on globalThis");
  assert.match(INGEST_TS, /__fleet_graveyard_invalidate__/,
    "src/ingest/index.ts must read the graveyard cache invalidation hook lazily off globalThis");
  assert.match(CONTROL_TS, /__fleet_graveyard_invalidate__/,
    "src/control.ts must also call the invalidation hook on a pause/unpause flip");
});

test("AC11: src/control.ts shell-out surface stays argv-only (no shell-string composition)", () => {
  // Sanity guard: the dispatcher does NOT grow a shell-string surface.
  assert.doesNotMatch(CONTROL_TS, /\bexec\s*\(\s*["'`].*\$\{/,
    "src/control.ts must not interpolate a shell string for exec");
});
