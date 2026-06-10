// Tests for ticket 0050 — Fleet year-in-review (one shareable annual
// page only the local SQLite can author).
//
// One `test(...)` per acceptance-criteria checkbox in
// docs/backlog/0050-fleet-year-in-review.md. Strategy mirrors the 0041
// receipts and 0048 worth-it suites:
//   - Drive `fleetYearInReview(db, year, now, opts?)` directly against a
//     tmpdir DB for the shape, dip detection, top_projects, top_lessons,
//     and empty-fleet branches.
//   - Boot `startServer()` over loopback for the route + cache tests,
//     using the empty-roots config + tmp fleet-control.config.json seam
//     from LESSONS § "in-process startServer() tests need an empty-roots
//     config + run-row seeds".
//   - PWA / SW / mobile CSS contracts are text-level over web/sw.js +
//     web/style.css (zero jsdom).
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps from
// `new Date()`": every seed timestamp is anchored to the test's pinned
// NOW (and the helpers that derive ISO weeks anchor off NOW too).
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`": every
// row narrowing in the helper under test uses the double-cast (exercised
// transitively — if the cast regresses tsc fails before this file runs).
//
// Per LESSONS § "groomer prose can disagree with the schema; the
// schema wins": the producer in src/ingest/prs.ts writes lowercase
// `'open'` (line 188) and uppercase `'MERGED'` / `'CLOSED'` (line 235)
// — these seeds match the producer's casing exactly.
//
// Per LESSONS § "the `pr` table has no surrogate `id`; proxy 'latest
// landed' via (MAX(fetched_at), COUNT(*))": the cache-invalidation
// assertion drives that path.
//
// Per LESSONS § "anomaly tests need σ > 0 in the fixture": the dip-week
// fixture seeds varied weekly throughput so the median-spend gate is
// meaningfully exercised.
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
import { fleetYearInReview } from "../src/views.ts";
import {
  startServer,
  _resetYearInReviewCacheForTests,
  _getYearInReviewCacheBuildsForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const WEB_DIR = join(REPO_ROOT, "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const SW_JS = readFileSync(join(WEB_DIR, "sw.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

// Pinned wall-clock anchor for every seed. Mid-July 2026 so the
// year-in-review for 2026 covers ~half the year of seeded weeks
// before NOW and ~half "future weeks" (still in 2026 but past NOW).
const NOW = new Date("2026-07-15T12:00:00.000Z");
const YEAR = 2026;

// ────────────────────────────────────────────────────────────────────
// Tmpdir DB helper.
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-year-"));
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

/** Seed a merged agent PR with the producer's exact column conventions.
 *  state='MERGED' uppercase, is_agent=1. */
function seedMergedPr(db: DB, opts: {
  projectId: number; number: number; fetchedAt: string;
}): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,additions,deletions,author,url,fetched_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, `pr-${opts.number}`, `feat/${opts.number}`,
    "MERGED", "green", null, 1, 0, 0, "a",
    `https://example/owner/x/pull/${opts.number}`, opts.fetchedAt,
  );
}

/** Closed-non-merged agent PR. state='CLOSED' uppercase per the
 *  producer (src/ingest/prs.ts line 235). */
function seedClosedPr(db: DB, opts: {
  projectId: number; number: number; fetchedAt: string; closedAt: string;
}): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,additions,deletions,author,url,fetched_at,closed_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, `pr-${opts.number}`, `feat/${opts.number}`,
    "CLOSED", "red", null, 1, 0, 0, "a",
    `https://example/owner/x/pull/${opts.number}`, opts.fetchedAt, opts.closedAt,
  );
}

/** Seed cost_rollup_day directly — for pure-helper tests this is the
 *  cheapest path; the server-boot path requires run-row seeds (see
 *  seedRunForRollup). */
function seedRollup(db: DB, projectId: number, day: string, costUsd: number, phase = "ship"): void {
  db.prepare(
    "INSERT INTO cost_rollup_day(project_id, phase, day, runs, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd)"
    + " VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(projectId, phase, day, 1, 0, 0, 0, 0, costUsd);
}

/** Seed a run row so the boot-time `recomputeRollups()` re-derives the
 *  same spend in the boot-path tests. Per LESSONS § "in-process
 *  startServer() tests need ... run-row seeds". */
function seedRunForRollup(db: DB, opts: {
  projectId: number; startedAt: string; costUsd: number; phase?: string;
}): void {
  const sid = `s-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,outcome,cost_usd,cost_source)"
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(opts.projectId, opts.phase ?? "ship", sid, opts.startedAt, "shipped", opts.costUsd, "live");
}

/** Insert a control_audit heal row + a lesson_credit attribution
 *  (paired so the FK survives). The lesson_credit table is the data
 *  source for top_lessons. */
function seedLessonCredit(db: DB, opts: {
  lessonSlug: string; lessonDate: string; lessonTitle: string;
  projectSlug: string; matched: string; createdAt: string;
}): void {
  const r = db.prepare(
    "INSERT INTO control_audit(ts, actor, action, target, args_json, exit_code, stdout_tail) VALUES(?,?,?,?,?,?,?)",
  ).run(opts.createdAt, "auto-heal", "heal", `${opts.projectSlug}/pr`, "{}", 0, "");
  const id = Number(r.lastInsertRowid);
  db.prepare(
    "INSERT INTO lesson_credit(lesson_slug, lesson_date, lesson_title, heal_audit_id, project_slug, matched_substring, created_at)"
    + " VALUES (?,?,?,?,?,?,?)",
  ).run(opts.lessonSlug, opts.lessonDate, opts.lessonTitle, id, opts.projectSlug, opts.matched, opts.createdAt);
}

// ────────────────────────────────────────────────────────────────────
// AC1 — Shape + hero math. Seed 312 merged PRs / $1,310 across 6
//       projects in 2026 and assert the hero fields + ROI multiplier.
// ────────────────────────────────────────────────────────────────────

test("AC1: fleetYearInReview returns the documented shape with correct hero totals + ROI", () => {
  const { db, cleanup } = tempDb();
  try {
    // Six projects, 52 weekly merged PRs each (cumulative 312) spread
    // across the year. Spend split across all six. We anchor every
    // seed timestamp to NOW (pinned 2026-07-15) per LESSONS.
    const slugs = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
    const pids = slugs.map((s) => seedProject(db, s));
    // 312 PRs / 6 projects = 52 each. Distribute 1 per week per project
    // across weeks 1..52 of 2026 so the dip-week math has σ > 0 (we
    // vary per-week below by skipping one week per project so the
    // baseline isn't perfectly flat).
    let prNumber = 1;
    for (let i = 0; i < 6; i++) {
      const pid = pids[i];
      for (let w = 1; w <= 52; w++) {
        // Skip week 12 for the first project so weekly totals vary
        // (ensures σ > 0 for any anomaly-style test pulling this fixture).
        if (i === 0 && w === 12) continue;
        seedMergedPr(db, {
          projectId: pid, number: prNumber++,
          fetchedAt: `2026-${String(Math.floor((w - 1) / 4.345) + 1).padStart(2, "0")}-${String(((w - 1) % 4) * 7 + 3).padStart(2, "0")}T12:00:00.000Z`,
        });
      }
    }
    // Top up project 0 with one extra PR in week 13 so the cumulative
    // count is exactly 312 (one skip + one add — and the same project
    // shows different weekly totals so dip detection isn't trivial).
    seedMergedPr(db, {
      projectId: pids[0], number: prNumber++, fetchedAt: "2026-04-01T12:00:00.000Z",
    });
    // Spend: $1,310 across 12 months of cost_rollup_day rows.
    // ~$109.17/month. Use varied per-week amounts to give σ > 0.
    let remaining = 1310.0;
    for (let m = 1; m <= 12; m++) {
      const monthSpend = m === 12 ? remaining : 109.17;
      seedRollup(db, pids[m % 6], `2026-${String(m).padStart(2, "0")}-15`, monthSpend, "ship");
      remaining -= monthSpend;
    }

    const r = fleetYearInReview(db, YEAR, NOW);
    // Shape assertions.
    assert.equal(r.year, 2026);
    assert.equal(r.range_start, "2026-01-01");
    assert.equal(r.range_end, "2026-12-31");
    assert.equal(r.total_merged_prs, 312, "exactly 312 merged PRs in 2026");
    // Spend within a cent (one rollup row uses the float remainder).
    assert.ok(Math.abs(r.total_spend_usd - 1310.0) < 0.01,
      `total_spend_usd should be ~$1310, got ${r.total_spend_usd}`);
    // cost_per_pr_usd = 1310 / 312 ≈ $4.199
    assert.ok(r.cost_per_pr_usd != null);
    assert.ok(Math.abs(r.cost_per_pr_usd! - (1310 / 312)) < 0.01,
      `cost_per_pr_usd should be ~$4.20, got ${r.cost_per_pr_usd}`);
    // roi_multiplier = (312 * 1 hr * $75) / 1310 ≈ 17.86
    const expectedRoi = (312 * 1 * 75) / 1310;
    assert.ok(r.roi_multiplier != null);
    assert.ok(Math.abs(r.roi_multiplier! - expectedRoi) < 0.05,
      `roi_multiplier should be ~${expectedRoi.toFixed(2)}, got ${r.roi_multiplier}`);
    assert.equal(r.project_count, 6);
    // weekly_merges spans 52 weeks.
    assert.ok(Array.isArray(r.weekly_merges));
    assert.ok(r.weekly_merges.length >= 52,
      `weekly_merges should span at least 52 ISO weeks; got ${r.weekly_merges.length}`);
    // Every weekly entry carries the documented fields.
    for (const w of r.weekly_merges) {
      assert.ok(typeof w.week_iso === "string");
      assert.ok(typeof w.merged === "number");
      assert.ok(typeof w.closed_unmerged === "number");
      assert.ok(typeof w.spend_usd === "number");
    }
    // top_projects: at most 3 entries, sorted desc by merged_prs.
    assert.ok(Array.isArray(r.top_projects));
    assert.ok(r.top_projects.length <= 3);
    for (let i = 1; i < r.top_projects.length; i++) {
      assert.ok(r.top_projects[i - 1].merged_prs >= r.top_projects[i].merged_prs);
    }
    for (const p of r.top_projects) {
      assert.ok(typeof p.project_slug === "string");
      assert.ok(typeof p.merged_prs === "number");
      assert.ok(typeof p.spend_usd === "number");
      assert.ok(["net_positive", "watch", "sunset_candidate", "insufficient_data"]
        .includes(p.verdict));
      assert.ok(typeof p.prose === "string" && p.prose.length > 0,
        "prose template must compose a non-empty string");
    }
    // top_lessons array is present (may be empty in this fixture — no
    // lesson_credit rows were seeded).
    assert.ok(Array.isArray(r.top_lessons));
    assert.equal(r.top_lessons.length, 0, "no lessons seeded → empty top_lessons");
    assert.ok(typeof r.generated_at === "string");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — Dip-week detection. Seed a year with one losing high-spend
//       week, assert dip_week names it; seed a clean year, dip = null.
// ────────────────────────────────────────────────────────────────────

test("AC2: dip_week names the worst losing high-spend week; clean year → null", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "alpha");
    // 12 weeks of "winning" activity (merged > closed_unmerged) +
    // ONE losing week in March where closed_unmerged > merged AND
    // spend is well above the year-median. Varied throughput so the
    // median is meaningfully placed (LESSONS § "anomaly tests need σ > 0").
    // Winning weeks: 4 merged, 0 closed.
    let n = 1;
    for (let m = 1; m <= 12; m++) {
      if (m === 3) continue; // reserved for the dip
      for (let d of [3, 10, 17, 24]) {
        seedMergedPr(db, {
          projectId: pid, number: n++,
          fetchedAt: `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T12:00:00.000Z`,
        });
      }
      seedRollup(db, pid, `2026-${String(m).padStart(2, "0")}-15`, 50.0, "ship");
    }
    // The dip: in March week 2 (around 2026-03-10), 1 merged, 5 closed.
    seedMergedPr(db, {
      projectId: pid, number: n++, fetchedAt: "2026-03-10T12:00:00.000Z",
    });
    for (let i = 0; i < 5; i++) {
      seedClosedPr(db, {
        projectId: pid, number: n++,
        fetchedAt: "2026-03-10T12:00:00.000Z",
        closedAt: "2026-03-10T13:00:00.000Z",
      });
    }
    // High spend that week — 4x the median.
    seedRollup(db, pid, "2026-03-10", 200.0, "ship");

    const r = fleetYearInReview(db, YEAR, NOW);
    assert.ok(r.dip_week, "year with a losing high-spend week must surface dip_week");
    assert.ok(r.dip_week!.week_iso.startsWith("2026-W"),
      `dip_week iso must look like 2026-Wnn, got ${r.dip_week!.week_iso}`);
    assert.ok(r.dip_week!.closed_unmerged > r.dip_week!.merged,
      "dip week has closed_unmerged > merged");
    assert.match(r.dip_week!.headline, /the dip/i,
      "dip headline must use the loss-framing phrase");
    assert.match(r.dip_week!.headline, /\$/,
      "dip headline must surface the spend");
  } finally { cleanup(); }
});

test("AC2: clean year (no losing week) returns dip_week === null", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "alpha");
    // 52 weeks of winning activity, varied counts so the median is well-defined.
    let n = 1;
    for (let m = 1; m <= 12; m++) {
      for (let d of [3, 10, 17, 24]) {
        // Vary count per week so σ > 0.
        const count = ((m + d) % 3) + 2; // 2..4
        for (let i = 0; i < count; i++) {
          seedMergedPr(db, {
            projectId: pid, number: n++,
            fetchedAt: `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T12:00:00.000Z`,
          });
        }
      }
      seedRollup(db, pid, `2026-${String(m).padStart(2, "0")}-15`, 50.0, "ship");
    }
    const r = fleetYearInReview(db, YEAR, NOW);
    assert.strictEqual(r.dip_week, null,
      "clean year (no losing week) → dip_week is null");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — GET /api/fleet/year/:year JSON route shape + auth + bounds.
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
  const dir = mkdtempSync(join(tmpdir(), "fleet-year-boot-"));
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

test("AC3: GET /api/fleet/year/:year — loopback returns shape JSON", async () => {
  _resetYearInReviewCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "alpha");
    seedRunForRollup(db, { projectId: pid, startedAt: "2026-05-10T12:00:00.000Z", costUsd: 10.0 });
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-05-11T12:00:00.000Z" });
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-05-12T12:00:00.000Z" });
  });
  try {
    const r = await fetch(b.base + "/api/fleet/year/2026");
    assert.equal(r.status, 200);
    const j = await r.json() as {
      year: number; range_start: string; range_end: string;
      total_merged_prs: number; total_spend_usd: number;
      weekly_merges: unknown[]; top_projects: unknown[];
      top_lessons: unknown[]; generated_at: string;
    };
    assert.equal(j.year, 2026);
    assert.equal(j.range_start, "2026-01-01");
    assert.equal(j.range_end, "2026-12-31");
    assert.equal(j.total_merged_prs, 2);
    assert.ok(Array.isArray(j.weekly_merges));
    assert.ok(Array.isArray(j.top_projects));
    assert.ok(Array.isArray(j.top_lessons));
    assert.ok(typeof j.generated_at === "string");
    const cc = (r.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=3600/, `cache-control must declare max-age=3600; got '${cc}'`);
  } finally { await b.close(); b.cleanup(); }
});

test("AC3: GET /api/fleet/year/:year — far-future year → 400 'year out of range'", async () => {
  _resetYearInReviewCacheForTests();
  const b = await boot();
  try {
    // NOW = 2026; "more than one calendar-year in the future" means
    // 2028+ is out of range.
    const r = await fetch(b.base + "/api/fleet/year/2099");
    assert.equal(r.status, 400);
    const j = await r.json() as { error: string };
    assert.match(j.error, /year out of range/i);
  } finally { await b.close(); b.cleanup(); }
});

test("AC3: GET /api/fleet/year/:year — empty year → 200 with zero totals", async () => {
  _resetYearInReviewCacheForTests();
  const b = await boot(); // no seeds → no PRs, no rollups
  try {
    const r = await fetch(b.base + "/api/fleet/year/2026");
    assert.equal(r.status, 200, "an empty year is a legitimate question");
    const j = await r.json() as { total_merged_prs: number; weekly_merges: unknown[]; top_projects: unknown[] };
    assert.equal(j.total_merged_prs, 0);
    assert.ok(Array.isArray(j.weekly_merges));
    assert.equal((j.top_projects as unknown[]).length, 0);
  } finally { await b.close(); b.cleanup(); }
});

test("AC3: GET /api/fleet/year/:year — non-loopback no token → 401", async () => {
  const { requireAuth } = await import("../src/server.ts");
  const { db, cleanup } = tempDb();
  try {
    const fakeReq = { socket: { remoteAddress: "10.0.0.5" }, headers: {} };
    const r = requireAuth(db, fakeReq as any, "read");
    assert.equal(r.ok, false);
    assert.ok(r.status === 401 || r.status === 403);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — GET /year/:year HTML page: testids, 52-rect SVG, no <script>.
// ────────────────────────────────────────────────────────────────────

test("AC4: GET /year/:year renders self-contained HTML with the six testids + 52-bar SVG", async () => {
  _resetYearInReviewCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "alpha", "Alpha");
    seedRunForRollup(db, { projectId: pid, startedAt: "2026-05-10T12:00:00.000Z", costUsd: 5.0 });
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-05-11T12:00:00.000Z" });
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-05-12T12:00:00.000Z" });
    seedMergedPr(db, { projectId: pid, number: 3, fetchedAt: "2026-05-13T12:00:00.000Z" });
  });
  try {
    const r = await fetch(b.base + "/year/2026");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    const body = await r.text();
    // Six required testids.
    assert.match(body, /data-testid=["']year-in-review["']/);
    assert.match(body, /data-testid=["']year-hero["']/);
    assert.match(body, /data-testid=["']year-sparkline["']/);
    assert.match(body, /data-testid=["']top-projects["']/);
    assert.match(body, /data-testid=["']top-lessons["']/);
    assert.match(body, /data-testid=["']copy-share-link["']/);
    // Exactly 52 <rect> children inside the sparkline SVG (one per ISO week).
    const sparkMatch = body.match(/data-testid=["']year-sparkline["'][\s\S]*?<\/svg>/);
    assert.ok(sparkMatch, "year-sparkline SVG block must be parseable");
    const rects = (sparkMatch![0].match(/<rect\b/g) ?? []).length;
    assert.equal(rects, 52, `sparkline must declare 52 <rect> children; got ${rects}`);
    // No external JS, no /api/ fetches.
    assert.equal(/<script\b/i.test(body), false, "no <script> tag on the self-contained page");
    assert.equal(body.includes("/api/"), false, "no /api/ fetches");
    // Cache-Control: max-age=3600.
    const cc = (r.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=3600/, `cache-control must declare max-age=3600; got '${cc}'`);
    // Per-project / per-lesson cards carry slug-qualified testids when
    // present. We have at least one project so the per-project testid
    // for alpha must exist.
    assert.match(body, /data-testid=["']top-project-alpha["']/);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — Cache: invalidation tuple bumps on PR fetched_at advance.
// ────────────────────────────────────────────────────────────────────

test("AC5: cache hit/miss via the exported _getYearInReviewCacheBuildsForTests counter", async () => {
  _resetYearInReviewCacheForTests();
  const mod = await import("../src/server.ts") as typeof import("../src/server.ts") & {
    _yearInReviewCachedForTests: (db: DB, year: number, now: Date) => unknown;
  };
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "alpha");
    seedRollup(db, pid, "2026-05-10", 5.0, "ship");
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-05-11T12:00:00.000Z" });
    const before = _getYearInReviewCacheBuildsForTests();
    mod._yearInReviewCachedForTests(db, YEAR, NOW);
    const afterFirst = _getYearInReviewCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call → MISS, build counter += 1");
    mod._yearInReviewCachedForTests(db, YEAR, NOW);
    const afterSecond = _getYearInReviewCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0, "second call → HIT, counter unchanged");
    // Advance the PR table: insert another PR with a fresher fetched_at.
    // Either MAX(fetched_at) moving OR COUNT(*) moving busts the cache.
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-05-13T12:00:00.000Z" });
    mod._yearInReviewCachedForTests(db, YEAR, NOW);
    const afterThird = _getYearInReviewCacheBuildsForTests();
    assert.equal(afterThird - afterSecond, 1,
      "PR insert advances (MAX(fetched_at), COUNT(*)) → MISS → counter += 1");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Empty-fleet behaviour: a fresh DB renders the friendly sentence.
// ────────────────────────────────────────────────────────────────────

test("AC6: empty fleet renders the 'Nothing shipped' sentence + onboard CTA", async () => {
  _resetYearInReviewCacheForTests();
  const b = await boot(); // no seeds at all
  try {
    const r = await fetch(b.base + "/year/2026");
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /Nothing shipped in 2026/i,
      "empty-fleet page must surface the documented sentence");
    assert.match(body, /fleetctl onboard/i,
      "empty-fleet page must name the onboard command");
    // No per-project testid leaks when zero projects exist.
    assert.doesNotMatch(body, /data-testid=["']top-project-/,
      "no top-project-<slug> testid when zero projects");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — PWA / offline integration: SW caches /year/ via the existing
//        cache-first shell strategy (any same-origin non-/api/ GET is
//        opportunistically cached). The page carries a stale-banner
//        testid for SW-driven offline rendering.
// ────────────────────────────────────────────────────────────────────

test("AC7: web/sw.js caches /year/ via the cache-first shell strategy", () => {
  // The SW's cache-first branch handles ANY same-origin GET that
  // isn't /api/, which includes /year/<YYYY>. We assert the SW
  // shape declares the cache-first strategy and the year page
  // carries the stale-banner testid for the SPA renderer.
  assert.match(SW_JS, /cacheFirstShell/, "sw.js must declare the cache-first shell strategy");
  assert.match(SW_JS, /\/api\//, "sw.js must branch on /api/ for network-first");
  // The year page itself carries the stale banner testid so a SW-
  // served cached copy can light up the banner.
  assert.match(APP_JS, /data-testid=["']stale-banner["']/,
    "stale-banner testid must exist (set up by the SPA renderer per 0029)");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Mobile: 375px single column; >=900px three-column grid for
//        the top-projects block.
// ────────────────────────────────────────────────────────────────────

test("AC8: style.css declares .year-* layout with mobile single-column + >=900px 3-col grid", () => {
  assert.match(CSS, /\.year-(in-review|hero|sparkline|projects|lessons)/,
    "style.css must declare a year-* selector group");
  // >=900px breakpoint that touches a year-* selector.
  const desktop = CSS.match(/@media[^{]*min-width:\s*900px[\s\S]*?year-[\s\S]*?\}\s*\}/);
  assert.ok(desktop, "style.css must define a >=900px breakpoint that upgrades the year-* layout");
  // The desktop block uses a 3-column grid somewhere in the year-* group.
  assert.match(desktop![0], /grid-template-columns[^;]*(1fr\s+1fr\s+1fr|repeat\(3,)/i,
    ">=900px must promote year-projects to a 3-column grid");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Quiet hours: dip-week SVG bar still renders but the headline
//        switches to the neutral form. (Drive the helper directly with
//        an explicit quietHoursActive option.)
// ────────────────────────────────────────────────────────────────────

test("AC9: dip headline uses the neutral label when quietHoursActive=true; loss-framing when false", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "alpha");
    // Seed a year with one losing high-spend week (same shape as AC2).
    let n = 1;
    for (let m = 1; m <= 12; m++) {
      if (m === 3) continue;
      for (let d of [3, 10, 17, 24]) {
        seedMergedPr(db, {
          projectId: pid, number: n++,
          fetchedAt: `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T12:00:00.000Z`,
        });
      }
      seedRollup(db, pid, `2026-${String(m).padStart(2, "0")}-15`, 50.0, "ship");
    }
    seedMergedPr(db, { projectId: pid, number: n++, fetchedAt: "2026-03-10T12:00:00.000Z" });
    for (let i = 0; i < 5; i++) {
      seedClosedPr(db, {
        projectId: pid, number: n++,
        fetchedAt: "2026-03-10T12:00:00.000Z",
        closedAt: "2026-03-10T13:00:00.000Z",
      });
    }
    seedRollup(db, pid, "2026-03-10", 200.0, "ship");

    const loud = fleetYearInReview(db, YEAR, NOW, { quietHoursActive: false });
    assert.ok(loud.dip_week);
    assert.match(loud.dip_week!.headline, /the dip/i, "loud mode uses loss framing");

    const quiet = fleetYearInReview(db, YEAR, NOW, { quietHoursActive: true });
    assert.ok(quiet.dip_week);
    assert.doesNotMatch(quiet.dip_week!.headline, /died|the dip/i,
      "quiet mode must not use loss-framing language");
    assert.match(quiet.dip_week!.headline, /lowest week/i,
      "quiet mode must use the neutral 'lowest week' label");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 — top_lessons surfaces the lesson_credit rollup, capped at 3.
// ────────────────────────────────────────────────────────────────────

test("AC10: top_lessons surfaces the lesson_credit rollup, sorted desc, capped at 3", () => {
  const { db, cleanup } = tempDb();
  try {
    // No PR seeds — we only care about the lesson aggregation here.
    // Three lessons with descending heal counts in 2026.
    for (let i = 0; i < 5; i++) {
      seedLessonCredit(db, {
        lessonSlug: "lesson-a", lessonDate: "2026-01-15", lessonTitle: "Lesson A",
        projectSlug: "alpha", matched: "foo",
        createdAt: `2026-02-${String(1 + i).padStart(2, "0")}T12:00:00.000Z`,
      });
    }
    for (let i = 0; i < 3; i++) {
      seedLessonCredit(db, {
        lessonSlug: "lesson-b", lessonDate: "2026-02-15", lessonTitle: "Lesson B",
        projectSlug: "bravo", matched: "bar",
        createdAt: `2026-03-${String(1 + i).padStart(2, "0")}T12:00:00.000Z`,
      });
    }
    for (let i = 0; i < 2; i++) {
      seedLessonCredit(db, {
        lessonSlug: "lesson-c", lessonDate: "2026-03-15", lessonTitle: "Lesson C",
        projectSlug: "charlie", matched: "baz",
        createdAt: `2026-04-${String(1 + i).padStart(2, "0")}T12:00:00.000Z`,
      });
    }
    // A fourth lesson with one credit — must NOT appear in top 3.
    seedLessonCredit(db, {
      lessonSlug: "lesson-d", lessonDate: "2026-04-15", lessonTitle: "Lesson D",
      projectSlug: "delta", matched: "qux",
      createdAt: "2026-05-01T12:00:00.000Z",
    });

    const r = fleetYearInReview(db, YEAR, NOW);
    assert.equal(r.top_lessons.length, 3, "top_lessons capped at 3");
    assert.equal(r.top_lessons[0].lesson_slug, "lesson-a");
    assert.equal(r.top_lessons[0].heal_count, 5);
    assert.equal(r.top_lessons[1].lesson_slug, "lesson-b");
    assert.equal(r.top_lessons[1].heal_count, 3);
    assert.equal(r.top_lessons[2].lesson_slug, "lesson-c");
    assert.equal(r.top_lessons[2].heal_count, 2);
    // Each row carries the documented fields.
    for (const L of r.top_lessons) {
      assert.ok(typeof L.lesson_date === "string");
      assert.ok(typeof L.lesson_title === "string");
      assert.ok(typeof L.first_credited_at === "string");
      assert.ok(typeof L.last_credited_at === "string");
      assert.ok(typeof L.saved_pr_count === "number");
    }
  } finally { cleanup(); }
});
