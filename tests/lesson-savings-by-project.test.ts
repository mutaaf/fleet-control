// Tests for ticket 0056 — Time saved this month on the project card.
//
// One test() per acceptance-criteria checkbox. Strategy mirrors the
// existing 0052 lesson-savings suite:
//
//   - AC1 (helper math): drive `lessonSavingsByProject(db, opts)`
//     directly against a tmpdir DB, asserting the documented
//     fair-share split (saved_usd for project P on lesson L =
//     heal_count_for_P_on_L / heal_count_for_L * lesson.saved_usd)
//     and the hourly-rate division.
//
//   - AC2 (empty fleet): drive the helper against a fresh DB; assert
//     the empty by_project map and the SPA renderer's empty-state
//     copy via text-level greps over web/app.js.
//
//   - AC3 (cache idempotency + invalidation): two calls within TTL
//     are a HIT (build counter unchanged); a fresh lesson_credit row
//     OR a fresh failed run busts the cache. The invalidation
//     function lives on `globalThis.__fleet_lesson_savings_by_
//     project_invalidate__` and is read lazily by ingest+lessons.
//
//   - AC4 (additive JSON field on /api/fleet): boot startServer()
//     over loopback against an empty-roots config, seed the data,
//     and assert every project row carries `time_saved_this_month`.
//     Dropping the new field reproduces the pre-ticket shape per the
//     AGENTS.md additive contract.
//
//   - AC5 (SPA render): text-level greps over web/app.js + web/style.css
//     for the `data-testid="project-card-time-saved-<slug>"` line,
//     the `formatHoursSaved()` helper, the lessons-portal navigation
//     target, and the muted-grey styling.
//
//   - AC6 (mobile): media-query gates exist in web/style.css.
//
//   - AC7 (quiet-hours integration): drive the renderer-direct seam
//     `_renderTimeSavedLineForTests(saved_hours, slug,
//     quietHoursActive)` per LESSONS 2026-06-11 — booting
//     startServer() with a non-default quietHours in cwd config races
//     parallel test files.
//
//   - AC8 (performance, PERF=1 only): seed 10 projects + 200
//     lesson_credit rows; cache-miss < 50ms, cache-hit < 5ms over
//     baseline.
//
//   - AC9 (PWA / offline): static greps confirm the home-grid
//     response is the SAME cache entry the service worker already
//     caches; no service-worker change required.
//
//   - AC10 (Hard NOs): zero new runtime deps; no shell-string
//     composition; no backticks inside SQL template literals; no
//     schema migration (lesson_credit.project_slug already exists).
//
// PRODUCER-VS-SPEC (per LESSONS 2026-06-05): The spec hedges the
// home-grid route as "likely /api/fleet/home or /api/fleet/projects".
// `grep "/api/" web/app.js` confirms the actual route is `/api/fleet`,
// composed by `fleetView()` (src/views.ts:70). We inject the new
// `time_saved_this_month` field per project row inside fleetView so
// the existing handler does not need to grow a second JOIN.
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps
// from new Date()": every seed timestamp is anchored to NOW.
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// row narrowing in the helper uses the double-cast (exercised
// transitively).
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests": cache reset + build counter exposed.
// Per LESSONS § "anomaly tests need sigma > 0 in the fixture": AC1's
// fixture spreads per-project savings geometrically so the
// fair-share split is observable (alpha: 7 heals; beta: 3 heals on
// the same lesson — different shares).
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
  lessonSavingsByProject,
  type LessonSavingsByProject,
} from "../src/views.ts";
import {
  startServer,
  _resetLessonSavingsByProjectCacheForTests,
  _getLessonSavingsByProjectCacheBuildsForTests,
  _renderTimeSavedLineForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WEB_DIR = join(ROOT, "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");
const SERVER_TS = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
const VIEWS_TS = readFileSync(join(ROOT, "src", "views.ts"), "utf8");
const LESSONS_TS = readFileSync(join(ROOT, "src", "lessons.ts"), "utf8");
const INGEST_TS = readFileSync(join(ROOT, "src", "ingest", "index.ts"), "utf8");
const PKG_JSON = readFileSync(join(ROOT, "package.json"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers — pinned-now seeders.
// ────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-10T12:00:00.000Z");

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-lesson-savings-by-project-"));
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

function seedPr(db: DB, projectId: number, number: number, fetchedAt: string): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
    + "additions,deletions,author,url,fetched_at,gh_created_at) "
    + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    projectId, number, "PR " + number, "feat/" + number,
    "open", "red", "BLOCKED", 1, 0, 0, "a",
    "https://github.com/owner/x/pull/" + number, fetchedAt, fetchedAt,
  );
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

function daysAgoIso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * 24 * 3600_000).toISOString();
}

function hoursAgoIso(hoursAgo: number): string {
  return new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();
}

function seedFailedRun(db: DB, projectId: number, costUsd: number, daysAgo: number): void {
  const sid = "sess-" + projectId + "-" + daysAgo + "-" + costUsd;
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,ended_at,outcome,cost_usd,cost_source) "
    + " VALUES(?,?,?,?,?,?,?, 'live')",
  ).run(
    projectId, "ship", sid,
    daysAgoIso(daysAgo), daysAgoIso(daysAgo),
    "failure", costUsd,
  );
}

function seedLessonCredit(
  db: DB,
  opts: { slug: string; date: string; title: string; healId: number; projectSlug: string; createdAt: string; matched?: string },
): void {
  db.prepare(
    "INSERT INTO lesson_credit(lesson_slug,lesson_date,lesson_title,"
    + " heal_audit_id,project_slug,matched_substring,created_at) "
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(
    opts.slug, opts.date, opts.title, opts.healId,
    opts.projectSlug, opts.matched ?? "matched-substring", opts.createdAt,
  );
}

// ────────────────────────────────────────────────────────────────────
// AC1 — lessonSavingsByProject helper:
//   * Documented shape: window_days, generated_at, hourly_rate_usd,
//     by_project: Record<slug, {project_slug, project_name,
//       heal_count, saved_usd, saved_hours, lesson_count}>.
//   * Default windowDays = 30.
//   * Default hourlyRateUsd from cfg.worth_it?.hourly_rate_usd ?? 75.
//   * Per-project saved_usd = fair-share split — heal_count_for_
//     project_on_lesson / heal_count_for_lesson * lesson.saved_usd.
//   * saved_hours = saved_usd / hourly_rate_usd, rounded to 1 dp.
//   * by_project keyed by project_slug for O(1) lookup.
// ────────────────────────────────────────────────────────────────────

test("AC1: lessonSavingsByProject splits each lesson's saved_usd fair-share across projects by heal_count", () => {
  const { db, cleanup } = tempDb();
  try {
    const alpha = seedProject(db, "alpha", "Alpha Project");
    const beta = seedProject(db, "beta", "Beta Project");

    // Same lesson, attributed 7 heals to alpha + 3 heals to beta.
    // Total heals on the lesson = 10. Per fair share:
    //   alpha gets 7/10 of the lesson's saved_usd
    //   beta gets 3/10 of the lesson's saved_usd
    // 10 failed runs at $30 → avg = $30 → lesson.saved_usd = 10 * 30 = $300.
    // alpha share: $210; beta share: $90.
    for (let i = 0; i < 7; i++) {
      const prNum = 100 + i;
      seedPr(db, alpha, prNum, hoursAgoIso(i + 2));
      const healId = seedHealAudit(db, hoursAgoIso(i + 1), prNum, "tail-alpha-" + i);
      seedLessonCredit(db, {
        slug: "fleet-control", date: "2026-05-26",
        title: "Some lesson",
        healId, projectSlug: "alpha", createdAt: hoursAgoIso(i + 1),
      });
    }
    for (let i = 0; i < 3; i++) {
      const prNum = 200 + i;
      seedPr(db, beta, prNum, hoursAgoIso(i + 2));
      const healId = seedHealAudit(db, hoursAgoIso(i + 1), prNum, "tail-beta-" + i);
      seedLessonCredit(db, {
        slug: "fleet-control", date: "2026-05-26",
        title: "Some lesson",
        healId, projectSlug: "beta", createdAt: hoursAgoIso(i + 1),
      });
    }
    // 10 failed runs at $30 (sigma>0 not necessary for this AC, but
    // the fixture is realistic).
    for (let i = 0; i < 10; i++) {
      seedFailedRun(db, i % 2 === 0 ? alpha : beta, 30, 3 + i);
    }

    const rollup = lessonSavingsByProject(db, { now: NOW });
    assert.equal(rollup.window_days, 30, "default windowDays = 30");
    assert.equal(typeof rollup.generated_at, "string");
    assert.equal(rollup.hourly_rate_usd, 75,
      "default hourly_rate_usd = 75 per the 0048 / 0050 precedent");

    const a = rollup.by_project["alpha"];
    assert.ok(a, "alpha must be present in by_project");
    assert.equal(a.project_slug, "alpha");
    assert.equal(a.project_name, "Alpha Project");
    assert.equal(a.heal_count, 7, "alpha contributed 7 heals on the lesson");
    assert.equal(a.lesson_count, 1, "one distinct lesson");
    // 7/10 of $300 = $210.
    assert.equal(a.saved_usd, 210.0,
      "alpha's fair share = heal_count_for_alpha / heal_count_for_lesson * lesson.saved_usd");
    // 210 / 75 = 2.8h.
    assert.equal(a.saved_hours, 2.8,
      "saved_hours = saved_usd / 75, rounded to 1 decimal");

    const b = rollup.by_project["beta"];
    assert.ok(b, "beta must be present in by_project");
    assert.equal(b.heal_count, 3);
    assert.equal(b.lesson_count, 1);
    assert.equal(b.saved_usd, 90.0,
      "beta's fair share = 3/10 of $300 = $90");
    assert.equal(b.saved_hours, 1.2,
      "90 / 75 = 1.2h");
  } finally { cleanup(); }
});

test("AC1: lessonSavingsByProject honours opts.hourlyRateUsd override", () => {
  const { db, cleanup } = tempDb();
  try {
    const alpha = seedProject(db, "alpha", "Alpha");
    seedPr(db, alpha, 10, hoursAgoIso(5));
    const h = seedHealAudit(db, hoursAgoIso(3), 10, "tail");
    seedLessonCredit(db, {
      slug: "fleet-control", date: "2026-05-26", title: "Some lesson",
      healId: h, projectSlug: "alpha", createdAt: hoursAgoIso(3),
    });
    // ONE failed run at $30 → avg = $30 → lesson.saved_usd = 1 * $30 = $30.
    seedFailedRun(db, alpha, 30, 2);

    const r150 = lessonSavingsByProject(db, { now: NOW, hourlyRateUsd: 150 });
    assert.equal(r150.hourly_rate_usd, 150);
    assert.equal(r150.by_project["alpha"].saved_usd, 30.0);
    // 30 / 150 = 0.2h.
    assert.equal(r150.by_project["alpha"].saved_hours, 0.2);
  } finally { cleanup(); }
});

test("AC1: lessonSavingsByProject honours opts.windowDays — narrowing drops out-of-window heals", () => {
  const { db, cleanup } = tempDb();
  try {
    const alpha = seedProject(db, "alpha", "Alpha");
    seedPr(db, alpha, 1, hoursAgoIso(5));
    seedPr(db, alpha, 2, hoursAgoIso(5));
    // Recent heal (3 days ago) — inside 7-day window.
    const recent = seedHealAudit(db, daysAgoIso(3), 1, "tail recent");
    seedLessonCredit(db, {
      slug: "fleet-control", date: "2026-05-26", title: "Some lesson",
      healId: recent, projectSlug: "alpha", createdAt: daysAgoIso(3),
    });
    // Older heal (40 days ago) — outside 30-day window.
    const old = seedHealAudit(db, daysAgoIso(40), 2, "tail old");
    seedLessonCredit(db, {
      slug: "fleet-control", date: "2026-05-26", title: "Some lesson",
      healId: old, projectSlug: "alpha", createdAt: daysAgoIso(40),
    });
    seedFailedRun(db, alpha, 30, 5);

    const narrow = lessonSavingsByProject(db, { now: NOW, windowDays: 7 });
    assert.equal(narrow.window_days, 7);
    assert.equal(narrow.by_project["alpha"]?.heal_count, 1,
      "7-day window only counts the 3-day-old heal");

    const wide = lessonSavingsByProject(db, { now: NOW, windowDays: 90 });
    assert.equal(wide.by_project["alpha"]?.heal_count, 2,
      "90-day window counts both heals");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — Empty-fleet behaviour: zero lesson_credit rows returns an
// empty by_project map; the SPA renderer carries the empty-state
// copy for every project card.
// ────────────────────────────────────────────────────────────────────

test("AC2: lessonSavingsByProject against a fresh DB returns an empty by_project map", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "alpha", "Alpha");
    seedProject(db, "beta", "Beta");
    const rollup = lessonSavingsByProject(db, { now: NOW });
    assert.deepEqual(rollup.by_project, {},
      "empty fleet returns empty by_project map");
    assert.equal(rollup.window_days, 30);
    assert.equal(rollup.hourly_rate_usd, 75);
  } finally { cleanup(); }
});

test("AC2: web/app.js carries the empty-state copy and per-card empty testid", () => {
  // The renderer carries the "lessons saving you 0h this month —
  // fleet is still learning" copy AND the
  // `project-card-time-saved-empty-<slug>` testid pattern.
  assert.match(APP_JS, /fleet is still learning/,
    "the empty-state copy 'fleet is still learning' is present in web/app.js");
  assert.match(APP_JS, /project-card-time-saved-empty-/,
    "per-card empty-state testid pattern 'project-card-time-saved-empty-<slug>' is present");
});

// ────────────────────────────────────────────────────────────────────
// AC3 — Cache idempotency + invalidation tuple.
// ────────────────────────────────────────────────────────────────────

test("AC3: GET /api/fleet shows a build-counter delta of 1 on first hit, 0 on second hit; a fresh lesson_credit row busts the cache", async () => {
  _resetLessonSavingsByProjectCacheForTests();
  const b = await boot({
    seed: (db) => {
      const alpha = seedProject(db, "alpha", "Alpha");
      seedPr(db, alpha, 42, hoursAgoIso(5));
      const h = seedHealAudit(db, hoursAgoIso(3), 42, "tail");
      seedLessonCredit(db, {
        slug: "fleet-control", date: "2026-05-26", title: "Some lesson",
        healId: h, projectSlug: "alpha", createdAt: hoursAgoIso(3),
      });
      seedFailedRun(db, alpha, 30, 2);
    },
  });
  try {
    const before = _getLessonSavingsByProjectCacheBuildsForTests();

    const r1 = await fetch(b.base + "/api/fleet");
    assert.equal(r1.status, 200);
    await r1.json();
    assert.equal(_getLessonSavingsByProjectCacheBuildsForTests() - before, 1,
      "first /api/fleet hit is a cache MISS, build counter += 1");

    const r2 = await fetch(b.base + "/api/fleet");
    assert.equal(r2.status, 200);
    await r2.json();
    assert.equal(_getLessonSavingsByProjectCacheBuildsForTests() - before, 1,
      "second /api/fleet hit is a cache HIT, build counter unchanged");

    // Insert a fresh lesson_credit row directly into the DB; the next
    // /api/fleet hit must rebuild.
    const db = openDb(b.dbPath);
    try {
      const h2 = seedHealAudit(db, hoursAgoIso(1), 42, "another tail");
      seedLessonCredit(db, {
        slug: "fleet-control", date: "2026-05-29", title: "Other lesson",
        healId: h2, projectSlug: "alpha", createdAt: hoursAgoIso(1),
      });
    } finally { db.close(); }

    const r3 = await fetch(b.base + "/api/fleet");
    assert.equal(r3.status, 200);
    await r3.json();
    assert.equal(_getLessonSavingsByProjectCacheBuildsForTests() - before, 2,
      "fresh lesson_credit row busts the cache → MISS, build counter += 1");
  } finally { await b.close(); b.cleanup(); }
});

test("AC3: a fresh failed run row (outcome='failure') busts the by_project savings cache on the next /api/fleet hit", async () => {
  _resetLessonSavingsByProjectCacheForTests();
  const b = await boot({
    seed: (db) => {
      const alpha = seedProject(db, "alpha", "Alpha");
      seedPr(db, alpha, 99, hoursAgoIso(5));
      const h = seedHealAudit(db, hoursAgoIso(3), 99, "tail");
      seedLessonCredit(db, {
        slug: "fleet-control", date: "2026-05-26", title: "Some lesson",
        healId: h, projectSlug: "alpha", createdAt: hoursAgoIso(3),
      });
      seedFailedRun(db, alpha, 30, 2);
    },
  });
  try {
    const before = _getLessonSavingsByProjectCacheBuildsForTests();
    await (await fetch(b.base + "/api/fleet")).json();
    await (await fetch(b.base + "/api/fleet")).json();
    assert.equal(_getLessonSavingsByProjectCacheBuildsForTests() - before, 1,
      "two calls within TTL: one MISS, one HIT");

    // Insert a fresh failed run — must bust the cache via the
    // MAX(run.ended_at) component of the invalidation tuple.
    const db = openDb(b.dbPath);
    try {
      const aId = (db.prepare("SELECT id FROM project WHERE slug='alpha'").get() as { id: number }).id;
      seedFailedRun(db, aId, 50, 1);
    } finally { db.close(); }

    await (await fetch(b.base + "/api/fleet")).json();
    assert.equal(_getLessonSavingsByProjectCacheBuildsForTests() - before, 2,
      "fresh failed-run row busts the cache");
  } finally { await b.close(); b.cleanup(); }
});

test("AC3: src/lessons.ts attributeHealsToLessons fires the by_project cache invalidator via the globalThis slot", () => {
  // The attributor fires the globalThis-slot hook after non-zero
  // inserts so the by_project cache is invalidated without a server→
  // lessons import cycle.
  assert.match(LESSONS_TS, /__fleet_lesson_savings_by_project_invalidate__/,
    "src/lessons.ts must reference __fleet_lesson_savings_by_project_invalidate__");
});

test("AC3: src/server.ts registers the by_project invalidator on the globalThis slot at module load", () => {
  assert.match(SERVER_TS, /__fleet_lesson_savings_by_project_invalidate__/,
    "src/server.ts must register the by_project invalidator on the globalThis slot");
});

test("AC3: runIngestPass reads the by_project invalidator off globalThis after COMMIT", () => {
  assert.match(INGEST_TS, /__fleet_lesson_savings_by_project_invalidate__/,
    "src/ingest/index.ts must late-bind the by_project invalidator via globalThis");
});

// ────────────────────────────────────────────────────────────────────
// AC4 — /api/fleet grows ONE additive optional `time_saved_this_month`
// field per project row. The field is OPTIONAL (older SPA clients
// gracefully ignore it). No existing field changes meaning, type, or
// removal.
// ────────────────────────────────────────────────────────────────────

test("AC4: GET /api/fleet returns every project row with a `time_saved_this_month` field", async () => {
  _resetLessonSavingsByProjectCacheForTests();
  const b = await boot({
    seed: (db) => {
      const alpha = seedProject(db, "alpha", "Alpha");
      const beta = seedProject(db, "beta", "Beta");
      // alpha gets 4 heals, beta gets 1 heal on the same lesson; 5
      // failed runs at $20 each → avg $20 → lesson saved = 5 * 20 =
      // $100; alpha share 4/5 = $80; beta share 1/5 = $20.
      for (let i = 0; i < 4; i++) {
        const prNum = 100 + i;
        seedPr(db, alpha, prNum, hoursAgoIso(i + 2));
        const healId = seedHealAudit(db, hoursAgoIso(i + 1), prNum, "tail-alpha-" + i);
        seedLessonCredit(db, {
          slug: "fleet-control", date: "2026-05-26", title: "Some lesson",
          healId, projectSlug: "alpha", createdAt: hoursAgoIso(i + 1),
        });
      }
      const prNum = 200;
      seedPr(db, beta, prNum, hoursAgoIso(2));
      const healId = seedHealAudit(db, hoursAgoIso(1), prNum, "tail-beta");
      seedLessonCredit(db, {
        slug: "fleet-control", date: "2026-05-26", title: "Some lesson",
        healId, projectSlug: "beta", createdAt: hoursAgoIso(1),
      });
      for (let i = 0; i < 5; i++) {
        seedFailedRun(db, i % 2 === 0 ? alpha : beta, 20, 3 + i);
      }
    },
  });
  try {
    const r = await fetch(b.base + "/api/fleet");
    assert.equal(r.status, 200);
    const j = await r.json() as {
      projects: Array<{
        slug: string;
        time_saved_this_month: {
          saved_usd: number;
          saved_hours: number;
          lesson_count: number;
        } | null;
      }>;
    };
    assert.ok(Array.isArray(j.projects));
    for (const p of j.projects) {
      assert.ok("time_saved_this_month" in p,
        "every project row carries the additive `time_saved_this_month` field; slug=" + p.slug);
    }
    const alpha = j.projects.find((p) => p.slug === "alpha");
    assert.ok(alpha?.time_saved_this_month, "alpha must have a non-null time_saved_this_month");
    assert.equal(alpha!.time_saved_this_month!.saved_usd, 80.0,
      "alpha share = 4/5 of $100 = $80");
    // 80/75 = 1.066... rounded to 1dp = 1.1.
    assert.equal(alpha!.time_saved_this_month!.saved_hours, 1.1,
      "alpha saved_hours = 80 / 75 = 1.1 (rounded to 1dp)");
    assert.equal(alpha!.time_saved_this_month!.lesson_count, 1);
    const beta = j.projects.find((p) => p.slug === "beta");
    assert.equal(beta?.time_saved_this_month?.saved_usd, 20.0,
      "beta share = 1/5 of $100 = $20");
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: /api/fleet against an empty fleet returns time_saved_this_month: null for every project row", async () => {
  _resetLessonSavingsByProjectCacheForTests();
  const b = await boot({
    seed: (db) => {
      seedProject(db, "alpha", "Alpha");
      seedProject(db, "beta", "Beta");
    },
  });
  try {
    const r = await fetch(b.base + "/api/fleet");
    assert.equal(r.status, 200);
    const j = await r.json() as {
      projects: Array<{ slug: string; time_saved_this_month: unknown }>;
    };
    for (const p of j.projects) {
      assert.equal(p.time_saved_this_month, null,
        "project " + p.slug + " carries time_saved_this_month: null on a fresh fleet");
    }
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: stripping `time_saved_this_month` from /api/fleet's project rows reproduces the pre-ticket structural keys", async () => {
  _resetLessonSavingsByProjectCacheForTests();
  const b = await boot({
    seed: (db) => {
      seedProject(db, "alpha", "Alpha");
    },
  });
  try {
    const r = await fetch(b.base + "/api/fleet");
    assert.equal(r.status, 200);
    const j = await r.json() as { projects: Array<Record<string, unknown>> };
    const PRE_TICKET_KEYS = new Set([
      "slug", "name", "displayState", "selfCancelDays", "engEnabled",
      "cost", "cost7d", "runs", "prs_merged_7d", "jobs", "telemetry",
      "usageLimit", "autoKill", "forecast", "anomalies", "cadence",
      "pace", "paused", "health", "burndown",
    ]);
    for (const p of j.projects) {
      const { time_saved_this_month, ...rest } = p;
      void time_saved_this_month;
      for (const k of Object.keys(rest)) {
        assert.ok(PRE_TICKET_KEYS.has(k),
          "stripped project row must only contain pre-ticket keys; saw '" + k + "'");
      }
    }
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — SPA renders the time-saved line below the spend stat on each
// project card. We do text-level assertions over web/app.js +
// web/style.css.
// ────────────────────────────────────────────────────────────────────

test("AC5: web/app.js carries the formatHoursSaved helper, the per-card testid, and the lessons-portal navigation", () => {
  // formatHoursSaved helper is exported / defined.
  assert.match(APP_JS, /function formatHoursSaved/,
    "the SPA defines a formatHoursSaved(saved_hours) helper");
  // Per-card testid pattern.
  assert.match(APP_JS, /project-card-time-saved-/,
    "per-card testid pattern 'project-card-time-saved-<slug>' is present");
  // Lessons-portal navigation with the project filter.
  assert.match(APP_JS, /\/lessons\?project=/,
    "the time-saved line wraps in a /lessons?project=<slug> link");
  // Renderer passes operator-visible strings through redactSecrets.
  assert.match(APP_JS, /redactSecrets[\s\S]{0,400}saved/i,
    "the time-saved renderer routes operator-visible strings through redactSecrets");
});

test("AC5: web/style.css declares the .project-card-time-saved styling (muted-grey)", () => {
  assert.match(CSS, /\.project-card-time-saved/,
    "web/style.css declares a .project-card-time-saved selector");
  // Muted-grey color — reuse existing --dim / --faint tokens (no new
  // CSS variables).
  assert.match(CSS, /\.project-card-time-saved[\s\S]{0,300}(var\(--dim\)|var\(--faint\))/,
    "the time-saved cell uses an existing muted-grey CSS variable (var(--dim) or var(--faint))");
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Mobile vs desktop: at 375px the time-saved line is inline
// with the spend stat; at >=600px it's on its own row right-aligned.
// We assert the media-query gate exists.
// ────────────────────────────────────────────────────────────────────

test("AC6: web/style.css gates the time-saved line layout on (min-width: 600px)", () => {
  assert.match(CSS, /@media\s*\(\s*min-width\s*:\s*600px\s*\)[\s\S]{0,5000}\.project-card-time-saved/,
    "the time-saved line is gated on (min-width: 600px) in web/style.css");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Quiet-hours integration: when quiet_hours_active is true, the
// copy softens from "this month" to "last 30 days". We use a
// renderer-direct seam to drive the branch deterministically — per
// LESSONS 2026-06-11, booting startServer() with a non-default
// quietHours config in cwd races parallel test files.
// ────────────────────────────────────────────────────────────────────

test("AC7: _renderTimeSavedLineForTests softens 'this month' → 'last 30 days' when quietHoursActive is true (non-zero saved_hours)", () => {
  const active = _renderTimeSavedLineForTests(3.2, "alpha", true);
  assert.match(active, /last 30 days/,
    "quiet-hours-active branch renders 'last 30 days'");
  assert.doesNotMatch(active, /this month/,
    "quiet-hours-active branch must NOT render 'this month'");

  const inactive = _renderTimeSavedLineForTests(3.2, "alpha", false);
  assert.match(inactive, /this month/,
    "quiet-hours-inactive branch renders 'this month'");
  assert.doesNotMatch(inactive, /last 30 days/,
    "quiet-hours-inactive branch must NOT render 'last 30 days'");

  // Both branches carry the formatted hours.
  assert.match(active, /~3\.2h/, "active branch carries the ~3.2h figure");
  assert.match(inactive, /~3\.2h/, "inactive branch carries the ~3.2h figure");
});

test("AC7: _renderTimeSavedLineForTests softens the empty-state copy when quietHoursActive is true (saved_hours === 0)", () => {
  const active = _renderTimeSavedLineForTests(0, "alpha", true);
  assert.match(active, /have saved you 0h over the last 30 days/,
    "quiet-hours-active empty-state uses past-tense + 'last 30 days'");

  const inactive = _renderTimeSavedLineForTests(0, "alpha", false);
  assert.match(inactive, /lessons saving you 0h this month/,
    "quiet-hours-inactive empty-state uses present-tense + 'this month'");

  // Both carry the project-specific empty testid.
  assert.match(active, /data-testid="project-card-time-saved-empty-alpha"/,
    "active empty-state carries the empty testid");
  assert.match(inactive, /data-testid="project-card-time-saved-empty-alpha"/,
    "inactive empty-state carries the empty testid");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Performance (PERF=1 only). Cache-miss < 50ms across 10
// projects + 200 lesson_credit rows. Cache-hit is exercised by AC3.
// ────────────────────────────────────────────────────────────────────

test("AC8: lessonSavingsByProject across 10 projects + 200 lesson_credit rows meets the cache-miss threshold", { skip: process.env.PERF !== "1" }, () => {
  const { db, cleanup } = tempDb();
  try {
    const projects: number[] = [];
    for (let p = 0; p < 10; p++) {
      projects.push(seedProject(db, "proj-" + p, "Project " + p));
    }
    for (let i = 0; i < 500; i++) {
      seedFailedRun(db, projects[i % 10], 10 + (i % 50), 1 + (i % 29));
    }
    for (let i = 0; i < 200; i++) {
      const prNum = 1000 + i;
      const pid = projects[i % 10];
      seedPr(db, pid, prNum, hoursAgoIso(1 + (i % 100)));
      const h = seedHealAudit(db, hoursAgoIso(1 + (i % 100)), prNum, "tail " + i);
      seedLessonCredit(db, {
        slug: "fleet-control",
        date: i % 2 === 0 ? "2026-05-26" : "2026-05-29",
        title: i % 2 === 0 ? "Lesson A" : "Lesson B",
        healId: h, projectSlug: "proj-" + (i % 10),
        createdAt: hoursAgoIso(1 + (i % 100)),
      });
    }
    const t0 = process.hrtime.bigint();
    lessonSavingsByProject(db, { now: NOW });
    const missMs = Number((process.hrtime.bigint() - t0) / BigInt(1_000_000));
    assert.ok(missMs < 50, "cache-miss must complete in <50ms; got " + missMs + "ms");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC9 — PWA / offline: the home-grid response is already cached by
// the SW; the additive `time_saved_this_month` field rides on the
// existing cache entry — no SW change needed. We assert
// web/sw.js (if present) still references /api/fleet and doesn't add
// a new cache entry name for the savings data.
// ────────────────────────────────────────────────────────────────────

test("AC9: web/sw.js cache contract is unchanged (the time-saved field rides on the existing /api/fleet cache entry)", () => {
  const swPath = join(WEB_DIR, "sw.js");
  if (!existsSync(swPath)) {
    // No SW file → nothing to assert. The spec's "rides on existing
    // cache entry" claim is vacuously true.
    return;
  }
  const sw = readFileSync(swPath, "utf8");
  // The SW must NOT carry a new dedicated cache key for the savings
  // data — the contract is "rides on existing /api/fleet entry".
  assert.doesNotMatch(sw, /time_saved_this_month/,
    "web/sw.js must NOT carry a new cache entry for time_saved_this_month");
  assert.doesNotMatch(sw, /lesson_savings_by_project/,
    "web/sw.js must NOT carry a new cache entry for lesson_savings_by_project");
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Hard NOs.
// ────────────────────────────────────────────────────────────────────

test("AC10: package.json `dependencies` stays empty (zero-runtime-dep contract)", () => {
  const pkg = JSON.parse(PKG_JSON) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  assert.deepEqual(deps, {}, "dependencies must stay empty per AGENTS.md");
});

test("AC10: lessonSavingsByProject never composes SQL via backtick template literals", () => {
  const idx = VIEWS_TS.indexOf("lessonSavingsByProject");
  assert.ok(idx > 0, "lessonSavingsByProject must exist in src/views.ts");
  const slice = VIEWS_TS.slice(idx, idx + 4000);
  assert.doesNotMatch(slice, /`[\s\S]*?(SELECT|FROM|WHERE|GROUP BY|ORDER BY)[\s\S]*?`/i,
    "lessonSavingsByProject must not embed SQL keywords inside a backtick template literal");
});

test("AC10: no schema migration — lesson_credit.project_slug already exists; no new CREATE TABLE", () => {
  const dbSrc = readFileSync(join(ROOT, "src", "db.ts"), "utf8");
  // The schema must still declare lesson_credit with project_slug.
  assert.match(dbSrc, /CREATE TABLE IF NOT EXISTS lesson_credit[\s\S]*?project_slug\s+TEXT/,
    "lesson_credit.project_slug must remain in the schema (no migration needed)");
});

// ────────────────────────────────────────────────────────────────────
// Boot harness — empty-roots config + tmp fleet-control.config.json
// per LESSONS § "in-process startServer() tests need an empty-roots
// config + run-row seeds".
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

async function boot(opts: { seed?: (db: DB) => void } = {}): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-lesson-savings-by-project-boot-"));
  const dbPath = join(dir, "fleet.db");
  if (opts.seed) {
    const seedDb = openDb(dbPath);
    try { opts.seed(seedDb); } finally { seedDb.close(); }
  }
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

// Suppress unused-import lint for the type-only import.
void (null as unknown as LessonSavingsByProject);
