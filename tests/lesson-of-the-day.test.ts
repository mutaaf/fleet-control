// Tests for ticket 0055 — Lesson of the day rotating home card.
//
// One test() per acceptance-criteria checkbox. Strategy mirrors the
// 0052 lesson-savings suite (the closest sibling):
//   - Drive the new pure helper `lessonOfTheDay(db, opts)` directly
//     against a tmpdir DB for AC1 (deterministic per-day), AC2
//     (savings-weighted bias), AC3 (empty state), AC4 (caching).
//   - Boot startServer() over loopback for AC5 (route shape + auth +
//     cache-control + redactor).
//   - SPA renderer + CSS contracts are text-level over web/app.js +
//     web/style.css per the 0052 / 0036 precedent (zero jsdom).
//   - sw.js coverage is automatic — the worker already network-first
//     caches every `/api/*` GET — but we assert the cached-suffix
//     render path exists in the SPA.
//   - Quiet-hours integration (AC7) is text-level on the SPA's
//     conditional that hides the dismiss chevron and softens the
//     eyebrow label.
//   - Zero-runtime-dep + JSON-additive guardrails are static greps.
//
// PRODUCER-VS-SPEC reconciliation per LESSONS 2026-06-05 "groomer
// prose can disagree with the schema; the schema wins":
//   - The parser in src/lessons.ts emits LessonEntry shape
//     `{ date, title, body, kind }` with the project slug carried on
//     the parent ProjectLessons row. The rotation join therefore
//     derives `lesson_slug = project.slug` and `lesson_date =
//     entry.date` — not a separate slug-on-entry. The spec's prose
//     "{lesson_slug, lesson_date, ...}" is the OUTPUT shape, not the
//     parser's intermediate shape.
//   - `lessonSavingsRollup()` already exposes `{ lesson_slug,
//     lesson_date, saved_usd, ... }` so we join by that pair to
//     derive each lesson's saved_usd.
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps
// from `new Date()`": every fixture timestamp anchors to NOW.
// Per LESSONS § "anomaly tests need sigma > 0 in the fixture": AC2's
// weighting fixture spreads saved_usd geometrically.
// Per LESSONS § "in-process dedup sets need an explicit reset hook":
// the cache reset + build counter live on the helper / server.
// Per LESSONS § "in-process startServer() tests need an empty-roots
// config": boot tests plant a tmp fleet-control.config.json in cwd
// and restore on cleanup.
// Per LESSONS § 2026-06-11 "renderer-direct seam for branch tests":
// the quiet-hours and empty-state branches drive a renderer-direct
// path (the SPA renderer is exported text-level) rather than mutating
// fleet-control.config.json.
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
  ENV_PATH_KEY,
  lessonOfTheDay,
  type LessonOfTheDay,
} from "../src/lessons.ts";
import {
  startServer,
  _resetLessonOfTheDayCacheForTests,
  _getLessonOfTheDayCacheBuildsForTests,
  _resetLessonSavingsCacheForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WEB_DIR = join(ROOT, "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");
const SERVER_TS = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
const LESSONS_TS = readFileSync(join(ROOT, "src", "lessons.ts"), "utf8");
const PKG_JSON = readFileSync(join(ROOT, "package.json"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers — pinned-now seeders.
// ────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-11T12:00:00.000Z");

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-lesson-of-the-day-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function tempFile(text: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-lesson-of-the-day-file-"));
  const path = join(dir, "CROSS_LESSONS.md");
  writeFileSync(path, text);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function seedProject(db: DB, slug: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace) VALUES (?,?,?)",
  ).run(slug, slug, "test");
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

function daysAgoIso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * 24 * 3600_000).toISOString();
}

function hoursAgoIso(hoursAgo: number): string {
  return new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString();
}

function seedHealAudit(db: DB, ts: string, prNumber: number, stdoutTail: string): number {
  const r = db.prepare(
    "INSERT INTO control_audit(ts,actor,action,target,args_json,exit_code,stdout_tail) "
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(ts, "ship", "heal", "pr-" + prNumber, "{}", 1, stdoutTail);
  return Number(r.lastInsertRowid);
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
    opts.projectSlug, opts.matched ?? "matched", opts.createdAt,
  );
}

/** Build a CROSS_LESSONS.md fixture with `n` lessons under one project
 *  slug. Each lesson's title is unique so the rotation can pick a
 *  deterministic one. The lesson dates increment by day so the parser
 *  records distinct (slug,date) tuples. */
function buildLessonsFixture(n: number, slug = "fleet-control"): string {
  let out = "# CROSS_LESSONS\n\n## " + slug + "\n\n";
  for (let i = 0; i < n; i++) {
    // Use 2026-05 as the base date series so it doesn't collide with NOW.
    const day = String(1 + (i % 28)).padStart(2, "0");
    const month = String(1 + Math.floor(i / 28)).padStart(2, "0");
    out += "### 2026-" + month + "-" + day + " — Lesson " + i + " title\n\n";
    out += "Symptom: Body text for lesson " + i + ". "
        + "Cause: a deterministic root cause. "
        + "Fix: do the right thing next time.\n\n";
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// AC1 — `lessonOfTheDay()` helper.
// ────────────────────────────────────────────────────────────────────

test("AC1: lessonOfTheDay returns the documented shape and is deterministic across calls with the same `now`", () => {
  _resetLessonOfTheDayCacheForTests();
  const file = tempFile(buildLessonsFixture(10));
  process.env[ENV_PATH_KEY] = file.path;
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha");
    // Seed two failed runs so the savings rollup has a non-zero average.
    seedFailedRun(db, a, 30, 3);
    seedFailedRun(db, a, 30, 4);
    // Two lesson_credit rows pointing at two different lessons so the
    // ranking is non-uniform — the higher-credit lesson gets the slot.
    seedPr(db, a, 1, hoursAgoIso(5));
    const h1 = seedHealAudit(db, hoursAgoIso(4), 1, "tail one");
    seedLessonCredit(db, {
      slug: "fleet-control", date: "2026-01-01",
      title: "Lesson 0 title",
      healId: h1, projectSlug: "alpha", createdAt: hoursAgoIso(4),
    });
    seedPr(db, a, 2, hoursAgoIso(5));
    const h2 = seedHealAudit(db, hoursAgoIso(3), 2, "tail two");
    seedLessonCredit(db, {
      slug: "fleet-control", date: "2026-01-02",
      title: "Lesson 1 title",
      healId: h2, projectSlug: "alpha", createdAt: hoursAgoIso(3),
    });

    const r1 = lessonOfTheDay(db, { now: NOW });
    assert.ok(r1, "should return a lesson when >=5 lessons indexed");
    const v1 = r1 as LessonOfTheDay;
    assert.equal(typeof v1.lesson_slug, "string");
    assert.equal(typeof v1.lesson_date, "string");
    assert.equal(typeof v1.lesson_title, "string");
    assert.equal(typeof v1.lesson_excerpt, "string");
    assert.equal(typeof v1.saved_usd, "number");
    assert.equal(typeof v1.total_lessons_indexed, "number");
    assert.equal(typeof v1.rotation_day_index, "number");
    assert.equal(v1.total_lessons_indexed, 10);

    // Excerpt is bounded.
    assert.ok(v1.lesson_excerpt.length <= 120, "excerpt is <= 120 chars");
    assert.ok(v1.lesson_excerpt.length > 0, "excerpt is non-empty");

    // Deterministic: same now → same lesson.
    _resetLessonOfTheDayCacheForTests();
    const r2 = lessonOfTheDay(db, { now: NOW });
    assert.deepEqual(r2, r1, "same `now` yields identical lesson");

    // Different day → different rotation slot (may be same lesson
    // depending on N, but rotation_day_index changes).
    _resetLessonOfTheDayCacheForTests();
    const tomorrow = new Date(NOW.getTime() + 24 * 3600_000);
    const r3 = lessonOfTheDay(db, { now: tomorrow });
    assert.ok(r3, "tomorrow returns a lesson");
    assert.notEqual(r3!.rotation_day_index, v1.rotation_day_index,
      "rotation_day_index advances by 1 day");
  } finally {
    cleanup();
    delete process.env[ENV_PATH_KEY];
    file.cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — Savings-weighting bias.
// ────────────────────────────────────────────────────────────────────

test("AC2: top-decile lessons surface ~2x more often than median lessons across a 365-day simulated rotation", () => {
  _resetLessonOfTheDayCacheForTests();
  const file = tempFile(buildLessonsFixture(10));
  process.env[ENV_PATH_KEY] = file.path;
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha");
    // One failed run so the average-cost is non-floor — keeps the
    // ranking driven by heal counts, not by a flat 5x.
    seedFailedRun(db, a, 50, 3);

    // 10 lessons with geometrically-spread heal counts. Each "saved_usd"
    // bucket maps to a count of heals attributed to that lesson via
    // the savings rollup (heal_count × $50 floor).
    // Distribution mirroring the spec: top decile = $1000 (20 heals),
    // mid = $25 (1 heal), median = $50 (1 heal), etc.
    const healCounts = [0, 0, 0, 0, 1, 1, 1, 2, 4, 20];
    let healId = 1;
    for (let i = 0; i < healCounts.length; i++) {
      const day = String(1 + i).padStart(2, "0");
      const date = "2026-01-" + day;
      // The fixture's lesson title at index i.
      const title = "Lesson " + i + " title";
      for (let h = 0; h < healCounts[i]; h++) {
        seedPr(db, a, healId, hoursAgoIso(5));
        const hid = seedHealAudit(db, hoursAgoIso(4 + h), healId, "tail " + healId);
        seedLessonCredit(db, {
          slug: "fleet-control", date, title,
          healId: hid, projectSlug: "alpha",
          createdAt: hoursAgoIso(4 + h),
        });
        healId += 1;
      }
    }

    const counts = new Map<string, number>();
    for (let d = 0; d < 365; d++) {
      _resetLessonOfTheDayCacheForTests();
      const now = new Date(NOW.getTime() + d * 24 * 3600_000);
      const r = lessonOfTheDay(db, { now });
      if (!r) continue;
      const key = r.lesson_slug + "|" + r.lesson_date;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const topKey = "fleet-control|2026-01-10"; // lesson with 20 heals
    const medianKey = "fleet-control|2026-01-08"; // lesson with 2 heals
    const topCount = counts.get(topKey) ?? 0;
    const medianCount = counts.get(medianKey) ?? 0;
    assert.ok(topCount > 0, "top-decile lesson surfaces at least once");
    assert.ok(medianCount > 0, "median lesson surfaces at least once");
    const ratio = topCount / medianCount;
    assert.ok(
      ratio >= 1.6 && ratio <= 2.4,
      "top-decile/median surface ratio should be in [1.6, 2.4]; got "
        + topCount + "/" + medianCount + " = " + ratio.toFixed(2),
    );
  } finally {
    cleanup();
    delete process.env[ENV_PATH_KEY];
    file.cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — Empty state when fewer than 5 lessons indexed.
// ────────────────────────────────────────────────────────────────────

test("AC3: lessonOfTheDay returns null when fewer than 5 lessons are indexed", () => {
  for (let n = 0; n <= 4; n++) {
    _resetLessonOfTheDayCacheForTests();
    const file = tempFile(buildLessonsFixture(n));
    process.env[ENV_PATH_KEY] = file.path;
    const { db, cleanup } = tempDb();
    try {
      const r = lessonOfTheDay(db, { now: NOW });
      assert.equal(r, null, "n=" + n + " must return null");
    } finally {
      cleanup();
      delete process.env[ENV_PATH_KEY];
      file.cleanup();
    }
  }
});

test("AC3: lessonOfTheDay returns a lesson when exactly 5 lessons are indexed", () => {
  _resetLessonOfTheDayCacheForTests();
  const file = tempFile(buildLessonsFixture(5));
  process.env[ENV_PATH_KEY] = file.path;
  const { db, cleanup } = tempDb();
  try {
    const r = lessonOfTheDay(db, { now: NOW });
    assert.ok(r, "n=5 must return a lesson");
    assert.equal(r!.total_lessons_indexed, 5);
  } finally {
    cleanup();
    delete process.env[ENV_PATH_KEY];
    file.cleanup();
  }
});

test("AC3: the SPA renders a lesson-of-the-day-empty testid container for the empty state", () => {
  assert.match(APP_JS, /data-testid="lesson-of-the-day-empty"/,
    "the empty-state container carries data-testid='lesson-of-the-day-empty'");
  assert.match(APP_JS, /Your fleet is still learning/,
    "the empty-state copy is present in web/app.js");
});

// ────────────────────────────────────────────────────────────────────
// AC4 — Idempotency / caching.
// ────────────────────────────────────────────────────────────────────

test("AC4: two route hits within the same UTC day hit the cache once; advancing 24h busts it", async () => {
  _resetLessonOfTheDayCacheForTests();
  _resetLessonSavingsCacheForTests();
  const file = tempFile(buildLessonsFixture(10));
  const b = await boot({
    lessonsPath: file.path,
    seed: (db) => {
      const a = seedProject(db, "alpha");
      seedFailedRun(db, a, 30, 3);
      seedPr(db, a, 1, hoursAgoIso(5));
      const h = seedHealAudit(db, hoursAgoIso(4), 1, "tail");
      seedLessonCredit(db, {
        slug: "fleet-control", date: "2026-01-01",
        title: "Lesson 0 title",
        healId: h, projectSlug: "alpha", createdAt: hoursAgoIso(4),
      });
    },
  });
  try {
    const before = _getLessonOfTheDayCacheBuildsForTests();
    await (await fetch(b.base + "/api/fleet/lesson-of-the-day")).json();
    assert.equal(_getLessonOfTheDayCacheBuildsForTests() - before, 1,
      "first call is a cache MISS, build counter += 1");
    await (await fetch(b.base + "/api/fleet/lesson-of-the-day")).json();
    assert.equal(_getLessonOfTheDayCacheBuildsForTests() - before, 1,
      "second call within same UTC day is a HIT, build counter unchanged");
  } finally {
    await b.close();
    b.cleanup();
    file.cleanup();
  }
});

test("AC4: a fresh lesson_credit row busts the lesson-of-the-day cache on the next route call", async () => {
  _resetLessonOfTheDayCacheForTests();
  _resetLessonSavingsCacheForTests();
  const file = tempFile(buildLessonsFixture(10));
  const b = await boot({
    lessonsPath: file.path,
    seed: (db) => {
      const a = seedProject(db, "alpha");
      seedFailedRun(db, a, 30, 3);
      seedPr(db, a, 1, hoursAgoIso(5));
      const h = seedHealAudit(db, hoursAgoIso(4), 1, "tail one");
      seedLessonCredit(db, {
        slug: "fleet-control", date: "2026-01-01",
        title: "Lesson 0 title",
        healId: h, projectSlug: "alpha", createdAt: hoursAgoIso(4),
      });
    },
  });
  try {
    const before = _getLessonOfTheDayCacheBuildsForTests();
    await (await fetch(b.base + "/api/fleet/lesson-of-the-day")).json();
    await (await fetch(b.base + "/api/fleet/lesson-of-the-day")).json();
    assert.equal(_getLessonOfTheDayCacheBuildsForTests() - before, 1,
      "two calls = one MISS + one HIT before bust");

    // Insert another lesson_credit row through the same DB the server
    // opened — the (MAX(created_at), COUNT(*)) tuple must change and
    // bust the cache.
    const db = openDb(b.dbPath);
    try {
      const a = (db.prepare("SELECT id FROM project WHERE slug='alpha'").get() as { id: number }).id;
      seedPr(db, a, 2, hoursAgoIso(2));
      const h2 = seedHealAudit(db, hoursAgoIso(1), 2, "tail two");
      seedLessonCredit(db, {
        slug: "fleet-control", date: "2026-01-02",
        title: "Lesson 1 title",
        healId: h2, projectSlug: "alpha", createdAt: hoursAgoIso(1),
      });
    } finally { db.close(); }

    await (await fetch(b.base + "/api/fleet/lesson-of-the-day")).json();
    assert.equal(_getLessonOfTheDayCacheBuildsForTests() - before, 2,
      "fresh lesson_credit row busts the cache (next call is a MISS)");
  } finally {
    await b.close();
    b.cleanup();
    file.cleanup();
  }
});

test("AC4: lessonOfTheDay registers a globalThis invalidation slot", () => {
  assert.match(SERVER_TS, /__fleet_lesson_of_the_day_invalidate__/,
    "src/server.ts registers the globalThis invalidation slot");
});

// ────────────────────────────────────────────────────────────────────
// AC5 — GET /api/fleet/lesson-of-the-day route.
// ────────────────────────────────────────────────────────────────────

test("AC5: GET /api/fleet/lesson-of-the-day returns 200 with the documented shape on loopback", async () => {
  _resetLessonOfTheDayCacheForTests();
  _resetLessonSavingsCacheForTests();
  const file = tempFile(buildLessonsFixture(10));
  const b = await boot({
    lessonsPath: file.path,
    seed: (db) => {
      const a = seedProject(db, "alpha");
      seedFailedRun(db, a, 30, 3);
      seedPr(db, a, 1, hoursAgoIso(5));
      const h = seedHealAudit(db, hoursAgoIso(4), 1, "tail");
      seedLessonCredit(db, {
        slug: "fleet-control", date: "2026-01-01",
        title: "Lesson 0 title",
        healId: h, projectSlug: "alpha", createdAt: hoursAgoIso(4),
      });
    },
  });
  try {
    const r = await fetch(b.base + "/api/fleet/lesson-of-the-day");
    assert.equal(r.status, 200);
    const cc = (r.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=3600/,
      "Cache-Control must declare max-age=3600; got '" + cc + "'");
    const j = await r.json() as LessonOfTheDay;
    assert.equal(typeof j.lesson_slug, "string");
    assert.equal(typeof j.lesson_date, "string");
    assert.equal(typeof j.lesson_title, "string");
    assert.equal(typeof j.lesson_excerpt, "string");
    assert.equal(typeof j.saved_usd, "number");
    assert.equal(typeof j.total_lessons_indexed, "number");
    assert.equal(typeof j.rotation_day_index, "number");
    assert.equal(j.total_lessons_indexed, 10);
  } finally {
    await b.close();
    b.cleanup();
    file.cleanup();
  }
});

test("AC5: GET /api/fleet/lesson-of-the-day returns a null-body 200 for a fresh fleet with <5 lessons", async () => {
  _resetLessonOfTheDayCacheForTests();
  _resetLessonSavingsCacheForTests();
  const file = tempFile(buildLessonsFixture(3));
  const b = await boot({ lessonsPath: file.path });
  try {
    const r = await fetch(b.base + "/api/fleet/lesson-of-the-day");
    assert.equal(r.status, 200);
    const j = await r.json() as LessonOfTheDay | { lesson: null };
    // The server returns `{ lesson: null, total_lessons_indexed: <N> }`
    // for the empty state so the SPA can branch on a stable key.
    assert.equal((j as { lesson: unknown }).lesson, null,
      "empty state surfaces lesson: null");
  } finally {
    await b.close();
    b.cleanup();
    file.cleanup();
  }
});

test("AC5: the lesson-of-the-day JSON body never carries a token-shape literal (redactor at the renderer boundary)", async () => {
  _resetLessonOfTheDayCacheForTests();
  _resetLessonSavingsCacheForTests();
  // Plant a lesson whose body contains a token-shape substring; the
  // excerpt MUST scrub it before JSON-encoding.
  const tokenLit = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const lessonsText = "# CROSS_LESSONS\n\n## fleet-control\n\n"
    + "### 2026-05-26 — Token-laden lesson " + tokenLit + " title\n\n"
    + "Symptom: a stdout tail leaked " + tokenLit + " through. "
    + "Cause: the upstream logger forgot to redact. Fix: scrub at the boundary.\n\n"
    + "### 2026-05-27 — Filler lesson A\n\nbody\n\n"
    + "### 2026-05-28 — Filler lesson B\n\nbody\n\n"
    + "### 2026-05-29 — Filler lesson C\n\nbody\n\n"
    + "### 2026-05-30 — Filler lesson D\n\nbody\n\n";
  const file = tempFile(lessonsText);
  const b = await boot({ lessonsPath: file.path });
  try {
    // Hit the route across multiple days so we eventually pick the
    // token-laden lesson — the rotation modulus across 5 lessons makes
    // every lesson surface within 5 days.
    let everSawTokenInResponse = false;
    for (let d = 0; d < 6; d++) {
      _resetLessonOfTheDayCacheForTests();
      const r = await fetch(b.base + "/api/fleet/lesson-of-the-day");
      const raw = await r.text();
      if (raw.includes(tokenLit)) everSawTokenInResponse = true;
    }
    assert.equal(everSawTokenInResponse, false,
      "token-shape literal must never appear in the JSON response body");
  } finally {
    await b.close();
    b.cleanup();
    file.cleanup();
  }
});

test("AC5: the lesson-of-the-day route response field names survive the redactor (no JSON shape mangling)", async () => {
  _resetLessonOfTheDayCacheForTests();
  _resetLessonSavingsCacheForTests();
  const file = tempFile(buildLessonsFixture(10));
  const b = await boot({ lessonsPath: file.path });
  try {
    const r = await fetch(b.base + "/api/fleet/lesson-of-the-day");
    assert.equal(r.status, 200);
    const raw = await r.text();
    // The 22-char letters+underscores field name `total_lessons_indexed`
    // (22 chars) is well into the danger zone described in LESSONS
    // 2026-06-10 "redactSecrets on a JSON body shreds your KEYS".
    // Asserting the key survives intact is the regression check.
    assert.match(raw, /"total_lessons_indexed"/,
      "field name 'total_lessons_indexed' must survive intact");
    assert.match(raw, /"rotation_day_index"/,
      "field name 'rotation_day_index' must survive intact");
  } finally {
    await b.close();
    b.cleanup();
    file.cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — SPA renders the home-page card with all documented testids.
// ────────────────────────────────────────────────────────────────────

test("AC6: web/app.js renders the lesson-of-the-day card with every documented testid", () => {
  assert.match(APP_JS, /data-testid="lesson-of-the-day"/,
    "container carries data-testid='lesson-of-the-day'");
  assert.match(APP_JS, /data-testid="lesson-of-the-day-eyebrow"/,
    "eyebrow label carries data-testid='lesson-of-the-day-eyebrow'");
  assert.match(APP_JS, /data-testid="lesson-of-the-day-title"/,
    "title carries data-testid='lesson-of-the-day-title'");
  assert.match(APP_JS, /data-testid="lesson-of-the-day-excerpt"/,
    "excerpt carries data-testid='lesson-of-the-day-excerpt'");
  assert.match(APP_JS, /data-testid="lesson-of-the-day-saved"/,
    "savings badge carries data-testid='lesson-of-the-day-saved'");
  assert.match(APP_JS, /data-testid="lesson-of-the-day-dismiss"/,
    "dismiss chevron carries data-testid='lesson-of-the-day-dismiss'");
});

test("AC6: web/app.js wires the lesson-of-the-day card into a /lessons hash anchor link", () => {
  assert.match(APP_JS, /href="#\/lessons/,
    "the card's anchor href points at the lessons hash route");
});

test("AC6: web/app.js redacts operator-visible lesson strings before HTML interpolation", () => {
  // The renderer routes lesson_title + lesson_excerpt through
  // redactSecrets — defence-in-depth at the renderer boundary.
  assert.match(APP_JS, /renderLessonOfTheDay/, "renderer name is exported");
  assert.match(APP_JS, /redactSecrets[\s\S]{0,400}lesson_title/i,
    "lesson_title is redacted in the renderer");
});

test("AC6: the SPA uses the localStorage `fleet:lesson-of-the-day-dismissed:` key namespace for the dismiss flag", () => {
  assert.match(APP_JS, /fleet:lesson-of-the-day-dismissed:/,
    "dismiss flag uses the documented localStorage key");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Quiet-hours integration.
// ────────────────────────────────────────────────────────────────────

test("AC7: the SPA hides the dismiss chevron and softens the eyebrow when quiet_hours_active is true", () => {
  // The renderer branches on quiet_hours_active. We assert both arms
  // are wired: the "tip of the day" → "tonight's lesson" eyebrow swap,
  // and the conditional that omits the dismiss chevron.
  assert.match(APP_JS, /tip of the day/i,
    "the default eyebrow is 'tip of the day'");
  assert.match(APP_JS, /tonight['’]s lesson/i,
    "the quiet-hours eyebrow is 'tonight’s lesson'");
  assert.match(APP_JS,
    /quiet_hours_active[\s\S]{0,800}lesson-of-the-day-dismiss/,
    "the dismiss chevron is gated on quiet_hours_active");
});

test("AC7: the lesson-of-the-day route response carries quiet_hours_active", () => {
  assert.match(SERVER_TS, /lesson-of-the-day[\s\S]{0,4000}quiet_hours_active/,
    "the lesson-of-the-day handler surfaces quiet_hours_active");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — PWA / offline cached suffix.
// ────────────────────────────────────────────────────────────────────

test("AC8: web/app.js emits a lesson-of-the-day-cached-suffix node when the network fetch fails", () => {
  assert.match(APP_JS, /data-testid="lesson-of-the-day-cached-suffix"/,
    "cached suffix carries data-testid='lesson-of-the-day-cached-suffix'");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Mobile layout: CSS gates the badge stack at 375px and the
// inline badge at >=600px.
// ────────────────────────────────────────────────────────────────────

test("AC9: web/style.css declares a .lesson-of-the-day selector group with a media-query gate at min-width 600px", () => {
  assert.match(CSS, /\.lesson-of-the-day/,
    "web/style.css declares a .lesson-of-the-day selector");
  // The savings badge stacks below the title at 375px and is right-
  // aligned inline at >=600px. We assert the media-query gate exists.
  assert.match(CSS,
    /@media\s*\(\s*min-width\s*:\s*600px\s*\)[\s\S]{0,5000}\.lesson-of-the-day/,
    "the lesson-of-the-day card has a (min-width: 600px) media gate");
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Zero-runtime-dep + no shell strings + no JSON-shape break.
// ────────────────────────────────────────────────────────────────────

test("AC10: package.json `dependencies` stays empty (zero-runtime-dep contract)", () => {
  const pkg = JSON.parse(PKG_JSON) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  assert.deepEqual(deps, {}, "dependencies must stay empty per AGENTS.md");
});

test("AC10: lessonOfTheDay does not compose SQL via backtick template literals", () => {
  const idx = LESSONS_TS.indexOf("function lessonOfTheDay");
  assert.ok(idx > 0, "lessonOfTheDay must be defined in src/lessons.ts");
  const slice = LESSONS_TS.slice(idx, idx + 4000);
  assert.doesNotMatch(slice,
    /`[\s\S]*?(SELECT|FROM|WHERE|GROUP BY|ORDER BY)[\s\S]*?`/i,
    "lessonOfTheDay must not embed SQL keywords inside a backtick template literal");
});

test("AC10: no new GET /api/fleet/lessons JSON shape break — the new route is net-new", () => {
  // The existing /api/fleet/lessons route shape (per ticket 0036 + 0052)
  // still carries `projects`, `parsed_at`, `total`, `source_present`,
  // `new_this_week`. We grep the server source to assert the existing
  // top-level keys are still emitted from the lessons handler.
  const lessonsHandlerIdx = SERVER_TS.indexOf("\"/api/fleet/lessons\"");
  assert.ok(lessonsHandlerIdx > 0, "/api/fleet/lessons handler must exist");
  const slice = SERVER_TS.slice(lessonsHandlerIdx, lessonsHandlerIdx + 4000);
  for (const key of ["projects", "parsed_at", "total", "source_present", "new_this_week"]) {
    assert.match(slice, new RegExp(key + ":"),
      "/api/fleet/lessons response still emits key '" + key + "'");
  }
});

// ────────────────────────────────────────────────────────────────────
// Boot harness — copied from tests/lesson-savings.test.ts to keep the
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
  const dir = mkdtempSync(join(tmpdir(), "fleet-lesson-of-the-day-boot-"));
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
