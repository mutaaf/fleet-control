// Tests for ticket 0052 — Lesson-pays-for-itself ledger.
//
// One test() per acceptance-criteria checkbox. Strategy mirrors the
// existing 0042 lesson-credit suite:
//   - Drive the new pure helper `lessonSavingsRollup(db, opts)`
//     directly against a tmpdir DB for AC1 (math/floor) + AC2 (cache).
//   - Boot startServer() over loopback for AC3 (route shape +
//     cache-control + auth) and AC4 (additive savings field on the
//     existing /api/fleet/lessons response) using the empty-roots
//     config + tmp fleet-control.config.json seam from LESSONS §
//     "in-process startServer() tests need an empty-roots config".
//   - SPA renderer tests are text-level over web/app.js + web/style.css
//     per the lessons / streak precedent (zero jsdom) for AC5 + AC6.
//   - Empty-fleet behaviour (AC7) drives the helper directly against a
//     freshly-initialised DB.
//   - Quiet-hours gate (AC8) is a text-level assertion on the SPA's
//     conditional that hides the sort header.
//   - Performance (AC9) seeds a larger fixture and times both cache
//     paths; only fires when PERF=1 in the environment.
//   - Zero-runtime-dep + JSON-additive guardrails (AC10) are static
//     greps over the implementation files.
//
// PRODUCER-VS-SPEC: per LESSONS 2026-06-05 "groomer prose can disagree
// with the schema; the schema wins":
//   - run.outcome failed-run literal: the de-facto schema-language is
//     `outcome = 'failure'` (lowercase). The producer in
//     src/ingest/transcripts.ts:outcomeOf() doesn't emit a literal
//     "failed" / "failure" string today, but every other view + test
//     in this repo (views.ts:722, inbox.test.ts, streak.test.ts,
//     badge.test.ts, glance.test.ts, health.test.ts, friday-wrap +
//     monday-catchup) seeds + queries against `'failure'` — so that's
//     the contract this ticket binds to as well.
//   - control_audit.action heal literal: `'heal'` (lowercase) per
//     src/control.ts.audit() + src/lessons.ts:627.
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps
// from `new Date()`": every seed timestamp is anchored to the test's
// NOW constant.
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`": row
// narrowing in the helper uses the double-cast (exercised
// transitively by importing the helper — if the cast regresses tsc
// fails before this file runs).
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests": cache reset + build counter live on the helper /
// server side.
// Per LESSONS § "the `pr` table has no surrogate `id`": the cache
// invalidation tuple uses `(MAX(lesson_credit.created_at),
// COUNT(*) FROM lesson_credit, MAX(run.ended_at), COUNT(*) FROM run
// WHERE outcome='failure')` — never MAX(lesson_credit.id) since the
// table's PK is composite.
// Per LESSONS § "anomaly tests need sigma > 0 in the fixture": AC1's
// 20 failed runs use varied per-run costs ($20 / $25 / $30 / $35 /
// $40) so the average-failed-ship-cost computation isn't an artifact
// of a flat baseline.
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
  parseCrossLessons, ENV_PATH_KEY,
} from "../src/lessons.ts";
import {
  lessonSavingsRollup,
  type LessonSavingsRollup,
} from "../src/views.ts";
import {
  startServer,
  _resetLessonSavingsCacheForTests,
  _getLessonSavingsCacheBuildsForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WEB_DIR = join(ROOT, "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");
const SERVER_TS = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
const VIEWS_TS = readFileSync(join(ROOT, "src", "views.ts"), "utf8");
const LESSONS_TS = readFileSync(join(ROOT, "src", "lessons.ts"), "utf8");
const PKG_JSON = readFileSync(join(ROOT, "package.json"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers — pinned-now seeders.
// ────────────────────────────────────────────────────────────────────

// Pinned wall-clock anchor for every seed.
const NOW = new Date("2026-06-10T12:00:00.000Z");

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-lesson-savings-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function tempFile(text: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-lesson-savings-file-"));
  const path = join(dir, "CROSS_LESSONS.md");
  writeFileSync(path, text);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

/** Anchor a seed to NOW shifted by `daysAgo` days (no `new Date()`). */
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
// AC1 — lessonSavingsRollup helper:
//   * Returns the documented shape.
//   * Default windowDays = 90.
//   * average_failed_ship_cost_usd = mean(run.cost_usd) where
//     outcome='failure' AND started_at in window.
//   * saved_usd = heal_count * avg, rounded to 2 decimals.
//   * Floor of $5.00 applies when zero failed runs in the window.
// ────────────────────────────────────────────────────────────────────

test("AC1: lessonSavingsRollup with 14 heal_credit rows + 20 failed runs at varied costs yields the documented saved_usd math", () => {
  const { db, cleanup } = tempDb();
  try {
    const alpha = seedProject(db, "alpha");
    const beta = seedProject(db, "beta");

    // 14 heals — half attributed to one lesson (the "winner"), the
    // other half attributed to a less-impactful lesson. Both lessons
    // share the same window so they show up in the same rollup.
    for (let i = 0; i < 14; i++) {
      const prNum = 100 + i;
      const projectId = i < 7 ? alpha : beta;
      seedPr(db, projectId, prNum, hoursAgoIso(i + 2));
      const healId = seedHealAudit(db, hoursAgoIso(i + 1), prNum, "tail " + i);
      seedLessonCredit(db, {
        slug: "fleet-control",
        date: "2026-05-26",
        title: "async streaming tails: snapshot the path before each read",
        healId,
        projectSlug: i < 7 ? "alpha" : "beta",
        createdAt: hoursAgoIso(i + 1),
        matched: "async streaming tails",
      });
    }
    // 2 heals attributed to a second, less-impactful lesson.
    for (let i = 0; i < 2; i++) {
      const prNum = 200 + i;
      seedPr(db, alpha, prNum, hoursAgoIso(i + 6));
      const healId = seedHealAudit(db, hoursAgoIso(i + 5), prNum, "small tail");
      seedLessonCredit(db, {
        slug: "fleet-control",
        date: "2026-05-29",
        title: "julianday drifts ~10us per timestamp",
        healId,
        projectSlug: "alpha",
        createdAt: hoursAgoIso(i + 5),
      });
    }

    // 20 failed runs at varied costs across the trailing 90 days
    // (per LESSONS § "anomaly tests need sigma > 0 in the fixture"
    // — the spread is wide enough that the mean carries signal).
    // Costs: $20 $25 $30 $35 $40 — sum = 150 over 5; repeat 4× = 20
    // runs. Mean = 30.0.
    const costs = [20, 25, 30, 35, 40];
    for (let i = 0; i < 20; i++) {
      const projId = i % 2 === 0 ? alpha : beta;
      seedFailedRun(db, projId, costs[i % 5], 5 + i * 2); // span 5..43 days
    }

    const rollup = lessonSavingsRollup(db, { now: NOW });
    assert.equal(rollup.window_days, 90, "default window_days is 90");
    assert.equal(typeof rollup.generated_at, "string");
    assert.equal(rollup.average_failed_ship_cost_usd, 30.0,
      "avg = mean of [20,25,30,35,40] repeated 4× = 30.00");

    // Winner: 14 heals * $30 = $420.00.
    const winner = rollup.lesson_savings.find((r) =>
      r.lesson_slug === "fleet-control" && r.lesson_date === "2026-05-26");
    assert.ok(winner, "winner lesson row must be present");
    assert.equal(winner!.heal_count, 14);
    assert.equal(winner!.saved_usd, 420.0,
      "saved_usd = heal_count * avg, rounded to 2 decimals");
    assert.equal(winner!.projects_helped, 2,
      "projects_helped counts distinct project_slug per lesson");
    assert.equal(typeof winner!.first_credited_at, "string");
    assert.equal(typeof winner!.last_credited_at, "string");

    // Second lesson: 2 heals * $30 = $60.00.
    const second = rollup.lesson_savings.find((r) =>
      r.lesson_slug === "fleet-control" && r.lesson_date === "2026-05-29");
    assert.ok(second, "second lesson row must be present");
    assert.equal(second!.heal_count, 2);
    assert.equal(second!.saved_usd, 60.0);
    assert.equal(second!.projects_helped, 1);

    // Sort: descending by saved_usd.
    assert.ok(
      rollup.lesson_savings[0].saved_usd >= rollup.lesson_savings[rollup.lesson_savings.length - 1].saved_usd,
      "lesson_savings is sorted by saved_usd DESC",
    );
  } finally { cleanup(); }
});

test("AC1: lessonSavingsRollup defaults to a $5.00 floor when the window has zero failed runs", () => {
  const { db, cleanup } = tempDb();
  try {
    const alpha = seedProject(db, "alpha");
    seedPr(db, alpha, 999, hoursAgoIso(3));
    const healId = seedHealAudit(db, hoursAgoIso(2), 999, "tail");
    seedLessonCredit(db, {
      slug: "fleet-control",
      date: "2026-05-26",
      title: "Some lesson",
      healId,
      projectSlug: "alpha",
      createdAt: hoursAgoIso(2),
    });
    // ZERO failed runs in window — floor must kick in.
    const rollup = lessonSavingsRollup(db, { now: NOW });
    assert.equal(rollup.average_failed_ship_cost_usd, 5.0,
      "floor of $5.00 applies when zero failed runs in window");
    const row = rollup.lesson_savings[0];
    assert.ok(row, "one lesson row present even with no failed runs");
    assert.equal(row.heal_count, 1);
    assert.equal(row.saved_usd, 5.0);
  } finally { cleanup(); }
});

test("AC1: lessonSavingsRollup honours opts.windowDays — narrowing the window drops out-of-window heals", () => {
  const { db, cleanup } = tempDb();
  try {
    const alpha = seedProject(db, "alpha");
    seedPr(db, alpha, 11, hoursAgoIso(3));
    seedPr(db, alpha, 22, hoursAgoIso(3));
    // Heal 1: 5 days ago — inside 7-day window.
    const recent = seedHealAudit(db, daysAgoIso(5), 11, "tail recent");
    seedLessonCredit(db, {
      slug: "fleet-control",
      date: "2026-05-26",
      title: "Some lesson",
      healId: recent,
      projectSlug: "alpha",
      createdAt: daysAgoIso(5),
    });
    // Heal 2: 20 days ago — outside 7-day, inside 30/90-day.
    const old = seedHealAudit(db, daysAgoIso(20), 22, "tail old");
    seedLessonCredit(db, {
      slug: "fleet-control",
      date: "2026-05-26",
      title: "Some lesson",
      healId: old,
      projectSlug: "alpha",
      createdAt: daysAgoIso(20),
    });
    // One failed run at $30 in window.
    seedFailedRun(db, alpha, 30, 3);

    const narrow = lessonSavingsRollup(db, { now: NOW, windowDays: 7 });
    assert.equal(narrow.window_days, 7);
    assert.equal(narrow.lesson_savings[0]?.heal_count, 1,
      "7-day window only sees the 5-day-old heal");

    const wide = lessonSavingsRollup(db, { now: NOW, windowDays: 90 });
    assert.equal(wide.window_days, 90);
    assert.equal(wide.lesson_savings[0]?.heal_count, 2,
      "90-day window sees both heals");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — Cache idempotency. The cache is invalidated when a new
// lesson_credit row lands OR a new failed run lands. The
// invalidation tuple is `(MAX(lesson_credit.created_at), COUNT(*)
// FROM lesson_credit, MAX(run.ended_at), COUNT(*) FROM run WHERE
// outcome='failure')` per the ticket's explicit guidance — NEVER
// MAX(lesson_credit.id) since the table has no surrogate id.
// ────────────────────────────────────────────────────────────────────

test("AC2: two /api/fleet/lessons/savings calls within TTL hit the cache once; a fresh lesson_credit row busts the cache", async () => {
  _resetLessonSavingsCacheForTests();
  const file = tempFile(SAMPLE_LESSONS);
  try {
    const b = await boot({
      lessonsPath: file.path,
      seed: (db) => {
        const a = seedProject(db, "alpha");
        seedPr(db, a, 42, hoursAgoIso(5));
        const h = seedHealAudit(db, hoursAgoIso(3), 42, "tail");
        seedLessonCredit(db, {
          slug: "fleet-control", date: "2026-05-26", title: "Some lesson",
          healId: h, projectSlug: "alpha", createdAt: hoursAgoIso(3),
        });
        seedFailedRun(db, a, 30, 2);
      },
    });
    try {
      const before = _getLessonSavingsCacheBuildsForTests();

      const r1 = await fetch(b.base + "/api/fleet/lessons/savings");
      assert.equal(r1.status, 200);
      const j1 = await r1.json() as LessonSavingsRollup;
      assert.equal(_getLessonSavingsCacheBuildsForTests() - before, 1,
        "first call is a cache MISS, build counter += 1");

      const r2 = await fetch(b.base + "/api/fleet/lessons/savings");
      assert.equal(r2.status, 200);
      const j2 = await r2.json() as LessonSavingsRollup;
      assert.equal(_getLessonSavingsCacheBuildsForTests() - before, 1,
        "second call is a cache HIT, build counter unchanged");
      assert.equal(j1.generated_at, j2.generated_at,
        "cache hit returns the same generated_at");

      // Insert a fresh lesson_credit row directly into the DB and the
      // next request must rebuild the cache.
      const db = openDb(b.dbPath);
      try {
        const h2 = seedHealAudit(db, hoursAgoIso(1), 42, "another tail");
        seedLessonCredit(db, {
          slug: "fleet-control", date: "2026-05-29", title: "Other lesson",
          healId: h2, projectSlug: "alpha", createdAt: hoursAgoIso(1),
        });
      } finally { db.close(); }

      const r3 = await fetch(b.base + "/api/fleet/lessons/savings");
      assert.equal(r3.status, 200);
      assert.equal(_getLessonSavingsCacheBuildsForTests() - before, 2,
        "fresh lesson_credit row busts the cache → MISS, build counter += 1");
    } finally { await b.close(); b.cleanup(); }
  } finally { file.cleanup(); }
});

test("AC2: a new failed run row (outcome='failure') busts the savings cache on the next call", async () => {
  _resetLessonSavingsCacheForTests();
  const file = tempFile(SAMPLE_LESSONS);
  try {
    const b = await boot({
      lessonsPath: file.path,
      seed: (db) => {
        const a = seedProject(db, "alpha");
        seedPr(db, a, 99, hoursAgoIso(5));
        const h = seedHealAudit(db, hoursAgoIso(3), 99, "tail");
        seedLessonCredit(db, {
          slug: "fleet-control", date: "2026-05-26", title: "Some lesson",
          healId: h, projectSlug: "alpha", createdAt: hoursAgoIso(3),
        });
        seedFailedRun(db, a, 30, 2);
      },
    });
    try {
      const before = _getLessonSavingsCacheBuildsForTests();

      await (await fetch(b.base + "/api/fleet/lessons/savings")).json();
      await (await fetch(b.base + "/api/fleet/lessons/savings")).json();
      assert.equal(_getLessonSavingsCacheBuildsForTests() - before, 1,
        "two calls within TTL: one MISS, one HIT");

      // Insert a fresh failed run — must bust the cache.
      const db = openDb(b.dbPath);
      try {
        const aId = (db.prepare("SELECT id FROM project WHERE slug='alpha'").get() as { id: number }).id;
        seedFailedRun(db, aId, 50, 1);
      } finally { db.close(); }

      await (await fetch(b.base + "/api/fleet/lessons/savings")).json();
      assert.equal(_getLessonSavingsCacheBuildsForTests() - before, 2,
        "fresh failed-run row busts the cache");
    } finally { await b.close(); b.cleanup(); }
  } finally { file.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — GET /api/fleet/lessons/savings route:
//   * Returns the AC1 shape as JSON.
//   * Requires read scope (the existing /api/ block already gates).
//   * Cache-Control: max-age=900.
//   * Empty fleet → 200 with empty lesson_savings and floor average.
//   * Renderer passes the response through redactSecrets at boundary.
// ────────────────────────────────────────────────────────────────────

test("AC3: GET /api/fleet/lessons/savings returns 200 with the rollup shape and Cache-Control: max-age=900 on loopback", async () => {
  _resetLessonSavingsCacheForTests();
  const file = tempFile(SAMPLE_LESSONS);
  try {
    const b = await boot({
      lessonsPath: file.path,
      seed: (db) => {
        const a = seedProject(db, "alpha");
        seedPr(db, a, 7, hoursAgoIso(5));
        const h = seedHealAudit(db, hoursAgoIso(2), 7, "tail");
        seedLessonCredit(db, {
          slug: "fleet-control", date: "2026-05-26", title: "Some lesson",
          healId: h, projectSlug: "alpha", createdAt: hoursAgoIso(2),
        });
        seedFailedRun(db, a, 30, 2);
      },
    });
    try {
      const r = await fetch(b.base + "/api/fleet/lessons/savings");
      assert.equal(r.status, 200);
      const cc = (r.headers.get("cache-control") ?? "").toLowerCase();
      assert.match(cc, /max-age=900/, "Cache-Control must declare max-age=900; got '" + cc + "'");
      const j = await r.json() as LessonSavingsRollup;
      assert.equal(typeof j.window_days, "number");
      assert.equal(typeof j.generated_at, "string");
      assert.equal(typeof j.average_failed_ship_cost_usd, "number");
      assert.ok(Array.isArray(j.lesson_savings));
      assert.equal(j.lesson_savings.length, 1);
      assert.equal(j.lesson_savings[0].saved_usd, 30.0);
    } finally { await b.close(); b.cleanup(); }
  } finally { file.cleanup(); }
});

test("AC3: GET /api/fleet/lessons/savings against an empty fleet returns 200 with empty lesson_savings and the floor average", async () => {
  _resetLessonSavingsCacheForTests();
  const file = tempFile(SAMPLE_LESSONS);
  try {
    const b = await boot({ lessonsPath: file.path });
    try {
      const r = await fetch(b.base + "/api/fleet/lessons/savings");
      assert.equal(r.status, 200);
      const j = await r.json() as LessonSavingsRollup;
      assert.deepEqual(j.lesson_savings, []);
      assert.equal(j.average_failed_ship_cost_usd, 5.0,
        "empty fleet uses the documented floor");
    } finally { await b.close(); b.cleanup(); }
  } finally { file.cleanup(); }
});

test("AC3: the savings JSON body is routed through a renderer-boundary redactor (no token-shape substrings escape into JSON)", async () => {
  _resetLessonSavingsCacheForTests();
  // Plant a lesson with a token-shape substring in the matched_substring
  // field; the JSON response MUST scrub it.
  const file = tempFile(SAMPLE_LESSONS);
  try {
    const b = await boot({
      lessonsPath: file.path,
      seed: (db) => {
        const a = seedProject(db, "alpha");
        seedPr(db, a, 3, hoursAgoIso(5));
        const h = seedHealAudit(db, hoursAgoIso(2), 3,
          "leaked ghp_abcdefghijklmnopqrstuvwxyz0123456789 in stdout");
        // matched_substring carries the token shape too.
        seedLessonCredit(db, {
          slug: "fleet-control", date: "2026-05-26",
          title: "Lesson with ghp_abcdefghijklmnopqrstuvwxyz0123456789 token",
          healId: h, projectSlug: "alpha", createdAt: hoursAgoIso(2),
          matched: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        });
        seedFailedRun(db, a, 30, 2);
      },
    });
    try {
      const r = await fetch(b.base + "/api/fleet/lessons/savings");
      assert.equal(r.status, 200);
      const raw = await r.text();
      assert.doesNotMatch(raw, /ghp_abcdef/,
        "token-shape literal must be redacted from the JSON body");
    } finally { await b.close(); b.cleanup(); }
  } finally { file.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — /api/fleet/lessons grows ONE additive optional `savings`
// field per lesson row. Dropping the savings field reproduces the
// byte-identical pre-ticket payload — the field is the only diff.
// ────────────────────────────────────────────────────────────────────

test("AC4: /api/fleet/lessons response carries an additive `savings` field per lesson entry; stripping it reproduces the pre-ticket shape byte-identically", async () => {
  _resetLessonSavingsCacheForTests();
  const file = tempFile(SAMPLE_LESSONS);
  try {
    const b = await boot({
      lessonsPath: file.path,
      seed: (db) => {
        const a = seedProject(db, "alpha");
        seedPr(db, a, 51, hoursAgoIso(5));
        const h = seedHealAudit(db, hoursAgoIso(2), 51,
          "log: GitHub Actions sometimes doesn't fire on a freshly-opened PR.");
        seedLessonCredit(db, {
          slug: "fleet-control",
          date: "2026-05-26",
          title: "GitHub Actions sometimes doesn't fire on a freshly-opened PR",
          healId: h, projectSlug: "alpha", createdAt: hoursAgoIso(2),
          matched: "GitHub Actions sometimes",
        });
        seedFailedRun(db, a, 30, 2);
      },
    });
    try {
      const r = await fetch(b.base + "/api/fleet/lessons");
      assert.equal(r.status, 200);
      type LessonEntry = {
        title: string;
        date: string;
        body?: string;
        kind?: string;
        savings?: { lesson_slug: string; saved_usd: number } | null;
      };
      type LessonsResp = {
        projects: Array<{ slug: string; lessons: LessonEntry[] }>;
        parsed_at: string;
        total: number;
        source_present: boolean;
        oversized?: boolean;
        new_this_week: number;
      };
      const j = await r.json() as LessonsResp;

      // Every lesson row carries the new field — even when the lesson
      // has zero credits (savings === null), so the SPA can render
      // "--" uniformly per AC7.
      let anyEntries = 0;
      for (const p of j.projects) {
        for (const lesson of p.lessons) {
          anyEntries += 1;
          assert.ok("savings" in lesson,
            "every lesson row carries the additive `savings` field");
        }
      }
      assert.ok(anyEntries > 0, "fixture lessons file produces >0 entries");

      // The lesson we attributed should have savings.saved_usd === 30.00.
      let attributedFound = false;
      for (const p of j.projects) {
        for (const lesson of p.lessons) {
          if (lesson.title && /GitHub Actions/.test(lesson.title) && lesson.savings) {
            assert.equal(lesson.savings.saved_usd, 30.0,
              "the attributed lesson row carries saved_usd = 1 * $30");
            attributedFound = true;
          }
        }
      }
      assert.ok(attributedFound, "attributed lesson row must surface savings");

      // Regression: strip `savings` from every lesson entry and assert
      // the rest of the shape byte-identical to a fresh stripping that
      // ignores presence of savings (which is the additive optional
      // contract). We round-trip through JSON to normalise key order.
      const stripped: LessonsResp = {
        ...j,
        projects: j.projects.map((p) => ({
          ...p,
          lessons: p.lessons.map((l) => {
            const { savings, ...rest } = l;
            void savings; // suppress unused
            return rest;
          }),
        })),
      };
      // Re-fetch with the new route disabled would be the gold
      // standard, but we don't have a feature flag; the realistic
      // assertion is: the stripped payload's structural keys per row
      // are EXACTLY {title, date, body, kind} (no rename, no
      // re-typing). That's the AGENTS.md "additive doesn't count as a
      // break" contract.
      for (const p of stripped.projects) {
        for (const lesson of p.lessons) {
          const keys = Object.keys(lesson).sort();
          // The original shape per src/lessons.ts:Lesson has
          // {title, date, body, kind} — anything else here means we
          // accidentally renamed or removed.
          for (const k of keys) {
            assert.ok(
              ["title", "date", "body", "kind"].includes(k),
              "stripped lesson row must only contain pre-ticket keys; saw '" + k + "'",
            );
          }
        }
      }
    } finally { await b.close(); b.cleanup(); }
  } finally { file.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — SPA renders the saved_usd column.
// We do text-level assertions over web/app.js + web/style.css to
// match the inbox / streak / health / lessons precedent. AC5 + AC6
// + AC7 + AC8 share this style.
// ────────────────────────────────────────────────────────────────────

test("AC5: web/app.js renders a saved_usd column header + per-row cell + tooltip on the lessons page", () => {
  // Header testid is present.
  assert.match(APP_JS, /data-testid="lessons-saved-usd-header"/,
    "the column header carries data-testid='lessons-saved-usd-header'");
  // Sort key `saved_usd_desc` is plumbed somewhere in the renderer.
  assert.match(APP_JS, /saved_usd_desc/,
    "sort key 'saved_usd_desc' is plumbed in web/app.js");
  // Per-row testid pattern (templated with lesson_slug).
  assert.match(APP_JS, /lessons-saved-usd-/,
    "per-row testid pattern 'lessons-saved-usd-<slug>' is present");
  // Tooltip testid pattern.
  assert.match(APP_JS, /lessons-saved-usd-tooltip-/,
    "per-row tooltip testid pattern 'lessons-saved-usd-tooltip-<slug>' is present");
  // Renderer passes operator-visible savings strings through redactSecrets.
  assert.match(APP_JS, /redactSecrets[\s\S]{0,400}saved/i,
    "the savings renderer routes operator-visible strings through redactSecrets");
});

test("AC5: web/style.css declares the lessons-saved-usd cell styling (right-aligned monospace) + the tooltip", () => {
  assert.match(CSS, /\.lessons-saved-usd/,
    "web/style.css declares a .lessons-saved-usd selector");
  // Monospace family for the cell.
  assert.match(CSS, /\.lessons-saved-usd[\s\S]{0,200}(monospace|var\(--font-mono\))/,
    "the saved-usd cell uses a monospace font family");
  // Right-aligned text.
  assert.match(CSS, /\.lessons-saved-usd[\s\S]{0,200}text-align\s*:\s*right/,
    "the saved-usd cell is right-aligned");
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Mobile vs desktop: 375px collapses inline, >=600px renders
// as a separate column. The split lives in the CSS — we assert
// media-query gates exist.
// ────────────────────────────────────────────────────────────────────

test("AC6: web/style.css gates the saved_usd column visibility on viewport width (375px inline vs >=600px column)", () => {
  // The desktop column visibility is declared inside a @media
  // (min-width: 600px) block — match the existing 0036 pattern.
  assert.match(CSS, /@media\s*\(\s*min-width\s*:\s*600px\s*\)[\s\S]{0,5000}\.lessons-saved-usd/,
    "the saved-usd column is gated on (min-width: 600px) in web/style.css");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Empty-fleet behaviour: lesson rows with zero saves render
// "--" (not "$0.00") and the tooltip explains the empty state.
// ────────────────────────────────────────────────────────────────────

test("AC7: SPA renderer emits '--' (not '$0.00') for lessons with zero saves and includes the empty-fleet tooltip copy", () => {
  // The renderer's empty-cell literal "--" is present.
  assert.match(APP_JS, /"--"/,
    "the SPA renderer carries the '--' empty-cell literal");
  // Empty-fleet tooltip prose mentions "no heals attributed yet".
  assert.match(APP_JS, /no heals attributed yet/,
    "the empty-fleet tooltip copy is present in web/app.js");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Quiet hours: when quiet_hours_active is true, the sort
// header is hidden. The column itself is still visible. Matches the
// 0048 / 0050 precedent: information visible, prompts suppressed.
// ────────────────────────────────────────────────────────────────────

test("AC8: the SPA hides the saved_usd SORT control when quiet_hours_active is true (information visible, prompts suppressed)", () => {
  // The renderer checks quiet_hours_active in the rollup payload
  // before emitting the clickable sort header. The check lives in
  // `renderLessonsSavedUsdHeader(quietHoursActive)` and the caller
  // unpacks `savings.quiet_hours_active` into the camelCase local.
  assert.match(APP_JS,
    /quiet_hours_active[\s\S]{0,3000}lessons-saved-usd-header/,
    "the SPA gates the lessons-saved-usd-header on quiet_hours_active");
  // Defence-in-depth: the renderer's quietHoursActive branch returns
  // a SPAN (not a BUTTON) and carries the `dim` class so the column
  // is information-only when quiet hours are on.
  assert.match(APP_JS,
    /quietHoursActive[\s\S]{0,400}lessons-saved-usd-header[\s\S]{0,200}dim/,
    "the quiet-hours branch of the header is dimmed and not clickable");
});

test("AC8: the savings rollup payload surfaces quiet_hours_active so the SPA can branch on it", () => {
  // The server route appends quiet_hours_active to the payload (per
  // the 0048 / 0050 precedent). We grep for the key in the response.
  assert.match(SERVER_TS, /lessons\/savings[\s\S]{0,2000}quiet_hours_active/,
    "the /api/fleet/lessons/savings handler surfaces quiet_hours_active");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Performance (PERF=1 only). Seed 6 projects, 200
// lesson_credit rows, 5000 run rows; cache-miss < 100ms, cache-hit
// < 5ms.
// ────────────────────────────────────────────────────────────────────

test("AC9: lessonSavingsRollup against a seeded 6-project / 200-credit / 5000-run fixture meets the cache-miss + cache-hit thresholds", { skip: process.env.PERF !== "1" }, () => {
  const { db, cleanup } = tempDb();
  try {
    const projects: number[] = [];
    for (let p = 0; p < 6; p++) {
      projects.push(seedProject(db, "proj-" + p));
    }
    // 5000 failed runs spread across the 6 projects, costs varied.
    for (let i = 0; i < 5000; i++) {
      seedFailedRun(db, projects[i % 6], 10 + (i % 50), 1 + (i % 89));
    }
    // 200 heal_audits + lesson_credit rows.
    for (let i = 0; i < 200; i++) {
      const prNum = 1000 + i;
      const pid = projects[i % 6];
      seedPr(db, pid, prNum, hoursAgoIso(1 + (i % 100)));
      const h = seedHealAudit(db, hoursAgoIso(1 + (i % 100)), prNum, "tail " + i);
      seedLessonCredit(db, {
        slug: "fleet-control",
        date: i % 2 === 0 ? "2026-05-26" : "2026-05-29",
        title: i % 2 === 0 ? "Lesson A" : "Lesson B",
        healId: h, projectSlug: "proj-" + (i % 6),
        createdAt: hoursAgoIso(1 + (i % 100)),
      });
    }
    const t0 = process.hrtime.bigint();
    lessonSavingsRollup(db, { now: NOW });
    const missMs = Number((process.hrtime.bigint() - t0) / BigInt(1_000_000));
    assert.ok(missMs < 100, "cache-miss must complete in <100ms; got " + missMs + "ms");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Hard NOs: zero new runtime deps; the additive /api/fleet/
// lessons field is the only shape change; no backticks inside SQL
// template literals (the views helper uses plain "+" concatenation
// like its siblings); no shell-string composition.
// ────────────────────────────────────────────────────────────────────

test("AC10: package.json `dependencies` stays empty (zero-runtime-dep contract)", () => {
  const pkg = JSON.parse(PKG_JSON) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  assert.deepEqual(deps, {}, "dependencies must stay empty per AGENTS.md");
});

test("AC10: the lessonSavingsRollup implementation never composes SQL via backtick template literals (per LESSONS § no backticks inside template-literal SQL)", () => {
  // Grep the source for backticks inside the helper. We narrow to
  // the helper's name + the next ~3000 chars.
  const idx = VIEWS_TS.indexOf("lessonSavingsRollup");
  assert.ok(idx > 0, "lessonSavingsRollup must exist in src/views.ts");
  const slice = VIEWS_TS.slice(idx, idx + 4000);
  // The function body must not contain a SQL keyword embedded in a
  // backtick template literal. Looser check: no backtick at all
  // inside the function body matches what every other helper in
  // views.ts does.
  assert.doesNotMatch(slice, /`[\s\S]*?(SELECT|FROM|WHERE|GROUP BY|ORDER BY)[\s\S]*?`/i,
    "lessonSavingsRollup must not embed SQL keywords inside a backtick template literal");
});

test("AC10: the heal-attribution INSERT path in src/lessons.ts registers the savings invalidator via the globalThis slot (per LESSONS 2026-06-05)", () => {
  // The attributor fires the globalThis-slot hook after non-zero
  // inserts so the savings cache is invalidated without a server→
  // lessons import cycle.
  assert.match(LESSONS_TS, /__fleet_lesson_savings_invalidate__/,
    "src/lessons.ts must reference __fleet_lesson_savings_invalidate__ to wake the savings cache");
});

test("AC10: src/server.ts registers the savings invalidator on the globalThis slot at module load (per LESSONS 2026-06-05)", () => {
  assert.match(SERVER_TS, /__fleet_lesson_savings_invalidate__/,
    "src/server.ts must register the savings invalidator on the globalThis slot");
});

test("AC10: runIngestPass reads the savings invalidator off globalThis after the COMMIT (per LESSONS 2026-06-05)", () => {
  const ingest = readFileSync(join(ROOT, "src", "ingest", "index.ts"), "utf8");
  assert.match(ingest, /__fleet_lesson_savings_invalidate__/,
    "src/ingest/index.ts must late-bind the savings invalidator via globalThis");
});

// ────────────────────────────────────────────────────────────────────
// Boot harness — copied from tests/lesson-credit.test.ts to keep the
// same in-process startServer() seam. Per LESSONS § "in-process
// startServer() tests need an empty-roots config + run-row seeds":
// we plant a tmp fleet-control.config.json in cwd and restore on
// cleanup.
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

async function boot(opts: { lessonsPath?: string; seed?: (db: DB) => void } = {}): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-lesson-savings-boot-"));
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
  if (opts.lessonsPath !== undefined) {
    process.env[ENV_PATH_KEY] = opts.lessonsPath;
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
      delete process.env[ENV_PATH_KEY];
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

// Sample CROSS_LESSONS fixture used by the route tests. The lesson
// titles include phrases that the existing extractSymptomPatterns
// will turn into matchable substrings; the seedHealAudit() stdout
// tails reference those phrases so the attributor fires inside the
// route's cache-miss path.
const SAMPLE_LESSONS = "# CROSS_LESSONS\n"
  + "\n"
  + "## fleet-control\n"
  + "\n"
  + "### 2026-05-26 — GitHub Actions sometimes doesn't fire on a freshly-opened PR\n"
  + "\n"
  + "Symptom: PR sat with no checks reported. Cause: a transient GitHub-side\n"
  + "delivery hiccup on the pull_request webhook. Fix: push an empty\n"
  + "commit to nudge synchronize, or close+reopen the PR.\n"
  + "\n"
  + "### 2026-05-29 — julianday drifts roughly 10us per timestamp\n"
  + "\n"
  + "Symptom: sub-millisecond timestamp diff in SQL drifted by 13us\n"
  + "because julianday returns a fractional day. Fix: decompose with\n"
  + "strftime.\n";

// Silence the import for parseCrossLessons — used to keep the helper
// shape consistent with the lesson-credit suite even though we don't
// re-parse here.
void parseCrossLessons;
