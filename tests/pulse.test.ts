// Tests for ticket 0054 — Public weekly fleet pulse.
//
// One test() per acceptance-criteria checkbox. Strategy mirrors the
// 0041 receipts + 0050 year-in-review suites:
//   - Drive the pure helper `fleetWeeklyPulse(db, opts)` directly against
//     a tmpdir DB for AC1 (shape), AC2 (empty-week), AC3 (cache), and
//     parts of AC10 (perf).
//   - Boot startServer() over loopback for AC4 (HTML page),
//     AC5 (JSON route), AC8 (defensive privacy), AC9 (cross-link from
//     receipts / year pages) using the empty-roots config + tmp
//     fleet-control.config.json seam from LESSONS § "in-process
//     startServer() tests need an empty-roots config + run-row seeds".
//   - Mobile (AC6) is text-level over web/style.css per the 0011 /
//     receipts precedent (zero jsdom).
//   - Quiet hours (AC7) flips the cfg in cwd and re-boots.
//   - AC11 is a static grep over the implementation files.
//
// PRODUCER-VS-SPEC: per LESSONS 2026-06-05 "groomer prose can disagree
// with the schema; the schema wins":
//   - `pr.state = 'MERGED'` (uppercase, per src/ingest/prs.ts:152 and
//     the existing src/views.ts:706 fleetStreak helper).
//   - `project_pause` has NO `active` column — a row's mere presence
//     means paused (per src/db.ts:189).
//   - `lesson_credit.created_at` is the freshness signal.
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps
// from `new Date()`": every seed timestamp is anchored to the test's
// pinned NOW constant.
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// the helper does this internally; exercised transitively here.
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests": cache reset + build counter live on the helper side.
// Per LESSONS 2026-06-07 "the `pr` table has no surrogate `id`":
// the cache invalidation tuple uses (MAX(pr.fetched_at), COUNT(*))
// — exercised by the AC3 cache-bust test.
// Per LESSONS 2026-06-10 "redactSecrets on a JSON body shreds your
// KEYS": AC5 asserts that an underscore-laden lesson title survives
// the scrub intact.
// Per LESSONS § "anomaly tests need sigma > 0 in the fixture": AC1
// seeds varied per-project PR counts so top_project selection is
// geometrically meaningful (not a tie).
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
  fleetWeeklyPulse, type FleetWeeklyPulse,
} from "../src/views.ts";
import {
  startServer,
  _resetPulseCacheForTests,
  _getPulseCacheBuildsForTests,
  _pulseCachedForTests,
  _renderPulsePageForTests,
} from "../src/server.ts";
import { serveReceipts } from "../src/receipts.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WEB_DIR = join(ROOT, "web");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");
const SERVER_TS = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
const VIEWS_TS = readFileSync(join(ROOT, "src", "views.ts"), "utf8");
const PKG_JSON = readFileSync(join(ROOT, "package.json"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Pinned anchors + helpers
// ────────────────────────────────────────────────────────────────────

// Wed 2026-06-10 12:00 UTC → most-recent COMPLETE ISO week is
// Mon 2026-06-01 through Sun 2026-06-07 (23:59:59.999 UTC).
const NOW = new Date("2026-06-10T12:00:00.000Z");
const WEEK_START_ISO = "2026-06-01";
const WEEK_END_ISO = "2026-06-07";

function tempDb(): { db: DB; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-pulse-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, path, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string, name?: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
  ).run(slug, name ?? slug, "test", null);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

function seedMergedPr(db: DB, opts: {
  projectId: number; number: number; fetchedAt: string;
}): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,additions,deletions,author,url,fetched_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, `pr-${opts.number}`, `feat/${opts.number}`,
    "MERGED", "green", null, 1, 0, 0, "a",
    `https://github.com/owner/x/pull/${opts.number}`, opts.fetchedAt,
  );
}

function seedRollup(db: DB, projectId: number, day: string, costUsd: number, phase = "ship"): void {
  db.prepare(
    "INSERT INTO cost_rollup_day(project_id, phase, day, runs, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd)"
    + " VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(projectId, phase, day, 1, 0, 0, 0, 0, costUsd);
}

function seedRunForRollup(db: DB, opts: {
  projectId: number; startedAt: string; costUsd: number; phase?: string;
}): void {
  const sid = `s-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,outcome,cost_usd,cost_source)"
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(opts.projectId, opts.phase ?? "ship", sid, opts.startedAt, "shipped", opts.costUsd, "live");
}

function seedLessonCredit(db: DB, opts: {
  slug: string; date: string; title: string; createdAt: string;
  healAuditId: number; projectSlug: string;
}): void {
  // The lesson_credit composite PK requires a heal_audit_id. We
  // pre-seed a control_audit row so the FK passes.
  db.prepare(
    "INSERT INTO control_audit(id, ts, actor, action, target, args_json, exit_code, stdout_tail)"
    + " VALUES (?, ?, 'local', 'heal', ?, '{}', 0, '')",
  ).run(opts.healAuditId, opts.createdAt, `${opts.projectSlug}/0`);
  db.prepare(
    "INSERT INTO lesson_credit(lesson_slug, lesson_date, lesson_title, heal_audit_id, project_slug, matched_substring, created_at)"
    + " VALUES (?,?,?,?,?,?,?)",
  ).run(opts.slug, opts.date, opts.title, opts.healAuditId, opts.projectSlug, "needle", opts.createdAt);
}

function seedProjectPause(db: DB, projectId: number, triggeredAt: string): void {
  db.prepare(
    "INSERT INTO project_pause(project_id, reason, triggered_at, triggered_by, detail_json)"
    + " VALUES (?, 'cost_cap', ?, 'auto', '{}')",
  ).run(projectId, triggeredAt);
}

// ────────────────────────────────────────────────────────────────────
// AC1 — fleetWeeklyPulse(db, opts) returns the documented shape.
// ────────────────────────────────────────────────────────────────────

test("AC1: fleetWeeklyPulse counts merged PRs in the most-recent COMPLETE week and excludes prior-week rows", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetPulseCacheForTests();
    const pid = seedProject(db, "courtiq", "courtiq");
    // 12 merged in target week (Mon 2026-06-01 → Sun 2026-06-07 UTC).
    for (let n = 0; n < 12; n++) {
      const dayOffset = n % 7; // spread across the week
      const day = String(1 + dayOffset).padStart(2, "0");
      seedMergedPr(db, {
        projectId: pid, number: 100 + n,
        fetchedAt: `2026-06-${day}T08:00:00.000Z`,
      });
    }
    // 3 merged in the PRIOR week (Mon 2026-05-25 → Sun 2026-05-31).
    for (let n = 0; n < 3; n++) {
      seedMergedPr(db, {
        projectId: pid, number: 200 + n,
        fetchedAt: `2026-05-${String(25 + n).padStart(2, "0")}T08:00:00.000Z`,
      });
    }
    // A future-week row (after now) — must not count.
    seedMergedPr(db, {
      projectId: pid, number: 999, fetchedAt: "2026-06-09T08:00:00.000Z",
    });
    const p = fleetWeeklyPulse(db, { now: NOW });
    assert.equal(p.week_start_iso, WEEK_START_ISO,
      `week_start_iso must snap to Mon ${WEEK_START_ISO}; got ${p.week_start_iso}`);
    assert.equal(p.week_end_iso, WEEK_END_ISO,
      `week_end_iso must snap to Sun ${WEEK_END_ISO}; got ${p.week_end_iso}`);
    assert.equal(p.merged_prs, 12,
      "only target-week merged PRs count");
  } finally { cleanup(); }
});

test("AC1: top_project picks the project with the most merged PRs in the window (varied counts, sigma > 0)", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetPulseCacheForTests();
    const pidA = seedProject(db, "alpha", "Alpha");
    const pidB = seedProject(db, "bravo", "Bravo");
    const pidC = seedProject(db, "charlie", "Charlie");
    // alpha: 2, bravo: 5, charlie: 3 — bravo wins.
    for (let n = 0; n < 2; n++) seedMergedPr(db, { projectId: pidA, number: 10 + n, fetchedAt: "2026-06-02T08:00:00.000Z" });
    for (let n = 0; n < 5; n++) seedMergedPr(db, { projectId: pidB, number: 20 + n, fetchedAt: "2026-06-03T08:00:00.000Z" });
    for (let n = 0; n < 3; n++) seedMergedPr(db, { projectId: pidC, number: 30 + n, fetchedAt: "2026-06-04T08:00:00.000Z" });
    const p = fleetWeeklyPulse(db, { now: NOW });
    assert.equal(p.merged_prs, 10);
    assert.ok(p.top_project, "top_project must not be null when merges > 0");
    assert.equal(p.top_project!.slug, "bravo", "highest-count project wins");
    assert.equal(p.top_project!.merged_prs, 5);
    assert.equal(p.top_project!.project_name, "Bravo");
  } finally { cleanup(); }
});

test("AC1: total_spend_usd sums cost_rollup_day in the window; cost_per_pr_usd divides; paused_count counts rows", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetPulseCacheForTests();
    const pid = seedProject(db, "courtiq");
    // Spend: $1 + $2 + $3 = $6 across three days in window. A prior-week
    // row at $99 must NOT count.
    seedRollup(db, pid, "2026-06-02", 1.0);
    seedRollup(db, pid, "2026-06-03", 2.0);
    seedRollup(db, pid, "2026-06-05", 3.0);
    seedRollup(db, pid, "2026-05-28", 99.0);
    // 4 merged in window.
    for (let n = 0; n < 4; n++) seedMergedPr(db, { projectId: pid, number: 1 + n, fetchedAt: "2026-06-02T08:00:00.000Z" });
    // Two paused projects (rows in project_pause).
    const pid2 = seedProject(db, "other");
    seedProjectPause(db, pid, "2026-06-05T08:00:00.000Z");
    seedProjectPause(db, pid2, "2026-06-05T08:00:00.000Z");

    const p = fleetWeeklyPulse(db, { now: NOW });
    assert.equal(p.total_spend_usd, 6.0,
      "sum cost_rollup_day in window; June 2-5 = $6; May 28 excluded");
    assert.equal(p.merged_prs, 4);
    assert.equal(p.cost_per_pr_usd, 6.0 / 4,
      "cost_per_pr_usd = total_spend_usd / merged_prs");
    assert.equal(p.paused_count, 2,
      "paused_count = COUNT(*) FROM project_pause");
  } finally { cleanup(); }
});

test("AC1: freshest_lesson is the most-recently-credited lesson_credit in the window", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetPulseCacheForTests();
    const pid = seedProject(db, "courtiq");
    // Two lessons in the window — the LATER one wins.
    seedLessonCredit(db, {
      slug: "2026-05-26-lesson-a", date: "2026-05-26",
      title: "older lesson", createdAt: "2026-06-02T08:00:00.000Z",
      healAuditId: 1, projectSlug: "courtiq",
    });
    seedLessonCredit(db, {
      slug: "2026-06-04-lesson-b", date: "2026-06-04",
      title: "freshest_in_window", createdAt: "2026-06-05T18:00:00.000Z",
      healAuditId: 2, projectSlug: "courtiq",
    });
    // A prior-week lesson — must NOT win even though slug is later
    // alphabetically.
    seedLessonCredit(db, {
      slug: "zzz-prior", date: "2026-05-20",
      title: "prior week", createdAt: "2026-05-29T18:00:00.000Z",
      healAuditId: 3, projectSlug: "courtiq",
    });
    const p = fleetWeeklyPulse(db, { now: NOW });
    assert.ok(p.freshest_lesson, "freshest_lesson must surface");
    assert.equal(p.freshest_lesson!.lesson_slug, "2026-06-04-lesson-b");
    assert.equal(p.freshest_lesson!.lesson_title, "freshest_in_window");
    assert.equal(p.freshest_lesson!.lesson_date, "2026-06-04");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — empty-week behaviour: zero PRs → null fields, page shows
// "fleet is quiet this week" with data-testid="pulse-empty".
// ────────────────────────────────────────────────────────────────────

test("AC2: empty-week → merged_prs=0, cost_per_pr_usd=null, top_project=null, freshest_lesson=null", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetPulseCacheForTests();
    // Freshly-initialised DB, no projects, no PRs.
    const p = fleetWeeklyPulse(db, { now: NOW });
    assert.equal(p.merged_prs, 0);
    assert.strictEqual(p.cost_per_pr_usd, null,
      "null (NOT 0 / NaN / Infinity) when merged_prs = 0");
    assert.strictEqual(p.top_project, null);
    assert.strictEqual(p.freshest_lesson, null);
    assert.equal(p.paused_count, 0);
    assert.equal(p.total_spend_usd, 0);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — idempotency / caching: memo keyed by
// (MAX(pr.fetched_at), COUNT(*) FROM pr WHERE state='MERGED',
//  MAX(lesson_credit.created_at), COUNT(*) FROM lesson_credit,
//  week_start_iso). Two calls within TTL → one build. Seeding a fresh
// PR busts the cache.
// ────────────────────────────────────────────────────────────────────

test("AC3: two calls within TTL share one build; seeding a new MERGED PR busts the cache", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetPulseCacheForTests();
    const pid = seedProject(db, "courtiq");
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-02T08:00:00.000Z" });
    const before = _getPulseCacheBuildsForTests();
    const a = _pulseCachedForTests(db, NOW);
    const afterFirst = _getPulseCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call MUST cache-miss (build counter +1)");
    const b = _pulseCachedForTests(db, NOW);
    const afterSecond = _getPulseCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0, "second call within TTL MUST cache-hit (build counter +0)");
    assert.equal(a.merged_prs, b.merged_prs);
    // Seed a fresh merged PR → MAX(fetched_at) and COUNT(*) both shift.
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-06-05T08:00:00.000Z" });
    _pulseCachedForTests(db, NOW);
    const afterBust = _getPulseCacheBuildsForTests();
    assert.equal(afterBust - afterSecond, 1,
      "fresh PR row must bust the cache via (MAX(fetched_at), COUNT(*))");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 + AC5 + AC7 + AC8 — boot startServer and exercise HTML/JSON
// routes over loopback.
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

async function boot(
  seed?: (db: DB) => void,
  extraConfig?: Record<string, unknown>,
): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-pulse-boot-"));
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
    ...(extraConfig ?? {}),
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

test("AC4: GET /pulse renders 200 text/html with pulse-headline testid; no <script>; no /api/control/ string", async () => {
  _resetPulseCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "courtiq", "Courtiq");
    seedRunForRollup(db, { projectId: pid, startedAt: "2026-06-02T08:00:00.000Z", costUsd: 2.5 });
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-02T08:00:00.000Z" });
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-06-03T08:00:00.000Z" });
  });
  try {
    const r = await fetch(b.base + "/pulse");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    const cc = (r.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=3600/, `cache-control must declare max-age=3600; got '${cc}'`);
    const body = await r.text();
    assert.match(body, /data-testid=["']pulse-headline["']/);
    assert.match(body, /data-testid=["']pulse-merged-prs["']/);
    assert.match(body, /data-testid=["']pulse-spend["']/);
    assert.match(body, /data-testid=["']pulse-cost-per-pr["']/);
    assert.match(body, /data-testid=["']pulse-streak["']/);
    assert.match(body, /data-testid=["']pulse-top-project["']/);
    assert.match(body, /data-testid=["']pulse-paused-count["']/);
    // CTA links to /calculator.
    assert.match(body, /data-testid=["']pulse-cta["']/);
    assert.match(body, /href=["']\/calculator["']/, "CTA must link to /calculator");
    // No script tag, no /api/control/ string, no project list other than top_project.
    assert.equal(/<script\b/i.test(body), false, "no <script> tag");
    assert.equal(body.includes("/api/control/"), false, "no /api/control/ string");
  } finally { await b.close(); b.cleanup(); }
});

test("AC2: GET /pulse on a quiet (zero-merge) week renders pulse-empty sentence; no per-stat testid is emitted", async () => {
  _resetPulseCacheForTests();
  const b = await boot(); // freshly-initialised DB, no projects.
  try {
    const r = await fetch(b.base + "/pulse");
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /data-testid=["']pulse-empty["']/,
      "empty-week page MUST carry data-testid='pulse-empty'");
    assert.match(body, /quiet/i,
      "empty-week sentence must use the honest 'quiet' phrasing (no fabricated upbeat language)");
    // Per the AC: no per-stat testid appears on the empty page.
    assert.equal(/data-testid=["']pulse-merged-prs["']/.test(body), false,
      "no merged-prs testid on the empty page");
    assert.equal(/data-testid=["']pulse-cost-per-pr["']/.test(body), false,
      "no cost-per-pr testid on the empty page");
  } finally { await b.close(); b.cleanup(); }
});

test("AC5: GET /api/fleet/pulse returns the documented JSON shape with no auth; underscore-laden lesson_title survives the scrub", async () => {
  _resetPulseCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "courtiq", "Courtiq");
    seedRunForRollup(db, { projectId: pid, startedAt: "2026-06-02T08:00:00.000Z", costUsd: 4.0 });
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-02T08:00:00.000Z" });
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-06-03T08:00:00.000Z" });
    // The 2026-06-10 LESSONS regression: an underscore-laden lesson
    // title (letters + underscores ONLY, 24+ chars) must SURVIVE the
    // scrub. The 0052 redactSecrets bug shredded these.
    seedLessonCredit(db, {
      slug: "2026-06-04-underscored",
      date: "2026-06-04",
      title: "average_failed_ship_cost_usd_lives_here",
      createdAt: "2026-06-05T08:00:00.000Z",
      healAuditId: 1, projectSlug: "courtiq",
    });
  });
  try {
    const r = await fetch(b.base + "/api/fleet/pulse");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /application\/json/);
    const cc = (r.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=3600/, `cache-control must declare max-age=3600; got '${cc}'`);
    const j = await r.json() as FleetWeeklyPulse;
    // Shape: every documented top-level field is present.
    assert.equal(typeof j.generated_at, "string", "generated_at present");
    assert.equal(typeof j.week_start_iso, "string", "week_start_iso present");
    assert.equal(typeof j.week_end_iso, "string", "week_end_iso present");
    assert.equal(typeof j.merged_prs, "number", "merged_prs present");
    assert.equal(typeof j.total_spend_usd, "number", "total_spend_usd present");
    assert.equal(typeof j.streak_days, "number", "streak_days present");
    assert.equal(typeof j.paused_count, "number", "paused_count present");
    // freshest_lesson surfaces — the underscore-laden title MUST survive.
    assert.ok(j.freshest_lesson, "freshest_lesson must surface");
    assert.equal(j.freshest_lesson!.lesson_title,
      "average_failed_ship_cost_usd_lives_here",
      "underscore-laden lesson_title must survive the renderer-boundary scrub (LESSONS 2026-06-10)");
    // No per-project rows beyond top_project — the JSON shape is the
    // privacy surface.
    const bodyText = JSON.stringify(j);
    assert.equal(bodyText.includes("\"projects\":"), false,
      "no 'projects' array on the pulse JSON");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Mobile (per 0011): at 375px stack vertically; at >= 600px
// inline as a single-row tile. Text-level CSS contract.
// ────────────────────────────────────────────────────────────────────

test("AC6: mobile CSS — pulse-stats stack flex-direction:column inside @media max-width:599px; row at >=600px", () => {
  // The pulse-stats container must render as a vertical stack on the
  // narrow viewport and as a single-row tile on >=600px. We assert the
  // CSS source declares both shapes — a pulse-stats rule with row
  // direction outside any narrow media block, AND a column override
  // inside a max-width: 599px (or 600px) media block.
  // Default (>=600px implicit): row.
  const baseMatch = CSS.match(/\.pulse-stats\s*\{[^}]*\}/);
  assert.ok(baseMatch, ".pulse-stats base rule must exist");
  assert.match(baseMatch![0], /flex-direction\s*:\s*row|display\s*:\s*flex/,
    "base .pulse-stats must render as a flex row (>=600px tile)");
  // Narrow override: any @media (max-width: 5xx or 600px) block must
  // flip pulse-stats to column.
  const narrowMatch = CSS.match(/@media\s*\(\s*max-width:\s*(?:599|600)px\s*\)\s*\{[\s\S]*?\.pulse-stats[\s\S]*?\}/);
  assert.ok(narrowMatch,
    "@media (max-width: 599px|600px) must override .pulse-stats to a vertical stack");
  assert.match(narrowMatch![0], /flex-direction\s*:\s*column/,
    "narrow override must declare flex-direction: column");
  // CTA tap-target: 44px min-height at 375px.
  const ctaMatch = CSS.match(/\.pulse-cta\s*\{[^}]*\}/);
  assert.ok(ctaMatch, ".pulse-cta rule must exist");
  assert.match(ctaMatch![0], /min-height\s*:\s*44px/,
    ".pulse-cta must declare min-height: 44px (tap target)");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Quiet hours integration: CTA hidden when quietHoursActive.
// ────────────────────────────────────────────────────────────────────

// Drive the renderer directly (zero HTTP, zero cwd-config seam) so the
// quiet-hours branch test doesn't race against parallel test files
// that write fleet-control.config.json to the SAME cwd in their own
// subprocess (the boot() helper's savedConfigText snapshot is per-
// process; the file is global).
const SYNTHETIC_PULSE: FleetWeeklyPulse = {
  generated_at: NOW.toISOString(),
  week_start_iso: WEEK_START_ISO,
  week_end_iso: WEEK_END_ISO,
  merged_prs: 5,
  total_spend_usd: 4.0,
  cost_per_pr_usd: 0.8,
  streak_days: 12,
  top_project: { slug: "courtiq", project_name: "Courtiq", merged_prs: 5 },
  freshest_lesson: null,
  paused_count: 0,
};

test("AC7: quiet-hours active hides the pulse-cta; stats stay visible", () => {
  const body = _renderPulsePageForTests(SYNTHETIC_PULSE, { quietHoursActive: true });
  // Headline + stats remain visible.
  assert.match(body, /data-testid=["']pulse-headline["']/,
    "headline stays visible during quiet hours");
  assert.match(body, /data-testid=["']pulse-merged-prs["']/,
    "stats stay visible during quiet hours (informational, not nudge)");
  // CTA is suppressed (no testid in the body).
  assert.equal(/data-testid=["']pulse-cta["']/.test(body), false,
    "pulse-cta MUST be suppressed during quiet hours");
});

test("AC7: quiet-hours inactive surfaces the pulse-cta", () => {
  const body = _renderPulsePageForTests(SYNTHETIC_PULSE, { quietHoursActive: false });
  assert.match(body, /data-testid=["']pulse-cta["']/,
    "pulse-cta MUST be visible when quiet hours are inactive");
  assert.match(body, /href=["']\/calculator["']/,
    "CTA must link to /calculator");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Defensive privacy: neither the HTML page nor the JSON route
// surfaces transcript_path / repo_url / branch / admin_token / pr_title.
// ────────────────────────────────────────────────────────────────────

test("AC8: neither /pulse nor /api/fleet/pulse leaks transcript_path|repo_url|branch|admin_token|pr_title", async () => {
  _resetPulseCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "courtiq", "Courtiq");
    // Seed a real fleet with a PR that has a title + URL + branch —
    // the privacy surface is what gets RENDERED, not what's in the DB.
    seedRunForRollup(db, { projectId: pid, startedAt: "2026-06-02T08:00:00.000Z", costUsd: 1.0 });
    seedMergedPr(db, { projectId: pid, number: 42, fetchedAt: "2026-06-02T08:00:00.000Z" });
  });
  try {
    const htmlBody = await (await fetch(b.base + "/pulse")).text();
    const jsonBody = await (await fetch(b.base + "/api/fleet/pulse")).text();
    const leaks = ["transcript_path", "repo_url", "branch", "admin_token", "pr_title"];
    for (const leak of leaks) {
      assert.equal(htmlBody.includes(leak), false,
        `/pulse HTML body must not contain the literal '${leak}'`);
      assert.equal(jsonBody.includes(leak), false,
        `/api/fleet/pulse body must not contain the literal '${leak}'`);
    }
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Cross-link from existing surfaces: /receipts/<slug>/<month>
// and /year/<YYYY> HTML pages carry data-testid="pulse-cross-link"
// with href="/pulse".
// ────────────────────────────────────────────────────────────────────

test("AC9: published /receipts/<slug>/<month> HTML carries pulse-cross-link → /pulse", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "courtiq");
    const frozen = {
      found: true,
      project_slug: "courtiq",
      project_label: "courtiq",
      month_iso: "2026-05",
      month_label: "May 2026",
      merged_prs: 5,
      total_spend_usd: 1.0,
      cost_per_pr_usd: 0.2,
      red_days: 0,
      top_mover: null,
      generated_at: NOW.toISOString(),
    };
    db.prepare(
      "INSERT INTO receipts_published(project_slug, month_iso, published_at, payload_json) VALUES(?,?,?,?)",
    ).run("courtiq", "2026-05", NOW.toISOString(), JSON.stringify(frozen));
    const result = serveReceipts(db, "courtiq", "2026-05");
    assert.equal(result.status, 200);
    const body = result.body;
    assert.match(body, /data-testid=["']pulse-cross-link["']/,
      "/receipts/<slug>/<month> must carry pulse-cross-link testid");
    assert.match(body, /href=["']\/pulse["']/,
      "pulse-cross-link must point at /pulse");
  } finally { cleanup(); }
});

test("AC9: GET /year/<YYYY> HTML carries pulse-cross-link → /pulse", async () => {
  _resetPulseCacheForTests();
  const b = await boot((db) => {
    // Year-in-review needs at least one merged PR + cost rollup so the
    // page renders the non-empty branch where our footer lives.
    const pid = seedProject(db, "alpha", "Alpha");
    seedRunForRollup(db, { projectId: pid, startedAt: "2026-03-02T08:00:00.000Z", costUsd: 1.5 });
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-03-02T08:00:00.000Z" });
  });
  try {
    const r = await fetch(b.base + "/year/2026");
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /data-testid=["']pulse-cross-link["']/,
      "/year/<YYYY> must carry pulse-cross-link testid");
    assert.match(body, /href=["']\/pulse["']/,
      "pulse-cross-link must point at /pulse");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Performance (skipped unless PERF=1).
// ────────────────────────────────────────────────────────────────────

test("AC10: fleetWeeklyPulse(6 projects, 500 PRs) — cache miss < 50ms, cache hit < 5ms (PERF=1 only)", { skip: process.env.PERF !== "1" }, () => {
  const { db, cleanup } = tempDb();
  try {
    _resetPulseCacheForTests();
    const pids: number[] = [];
    for (let i = 0; i < 6; i++) pids.push(seedProject(db, `proj-${i}`, `Project ${i}`));
    // 500 PRs spread across projects, all in the target week.
    for (let n = 0; n < 500; n++) {
      const pid = pids[n % 6];
      const day = String(1 + (n % 7)).padStart(2, "0");
      seedMergedPr(db, {
        projectId: pid, number: 1000 + n,
        fetchedAt: `2026-06-${day}T08:00:00.000Z`,
      });
    }
    const t0 = Date.now();
    fleetWeeklyPulse(db, { now: NOW });
    const missMs = Date.now() - t0;
    assert.ok(missMs < 50, `cache miss must be < 50ms; got ${missMs}ms`);
    const t1 = Date.now();
    fleetWeeklyPulse(db, { now: NOW });
    const hitMs = Date.now() - t1;
    assert.ok(hitMs < 5, `cache hit must be < 5ms; got ${hitMs}ms`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC11 — No new runtime deps; no shell-string composition; net-new
// route does not break any existing /api/... shape.
// ────────────────────────────────────────────────────────────────────

test("AC11: package.json `dependencies` stays empty (zero runtime deps)", () => {
  const pkg = JSON.parse(PKG_JSON) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  assert.deepEqual(deps, {},
    "AGENTS.md Hard NO: no runtime deps may be added; got " + JSON.stringify(deps));
});

test("AC11: src/views.ts pulse helper does not import node:child_process (no shell-out)", () => {
  // The pulse helper lives in views.ts — pure SQL. The "no shell-string
  // exec" Hard NO is checked at the IMPORT chokepoint per LESSONS §
  // "no shell-string exec static checks should grep the import, not
  // the call site".
  assert.equal(/from\s+["']node:child_process["']/.test(VIEWS_TS), false,
    "src/views.ts must not import node:child_process");
});

test("AC11: src/server.ts pulse cache invalidation registers on globalThis.__fleet_pulse_invalidate__", () => {
  // Per LESSONS 2026-06-05 "break ingest↔server cache-invalidation
  // cycles via a globalThis slot, not a circular import".
  assert.match(SERVER_TS, /__fleet_pulse_invalidate__/,
    "pulse cache invalidation MUST register on globalThis.__fleet_pulse_invalidate__");
});
