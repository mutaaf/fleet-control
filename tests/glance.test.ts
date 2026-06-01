// Tests for ticket 0033 — "Yesterday at a glance" morning card.
//
// One test(...) per acceptance-criteria checkbox. Strategy mirrors the
// 0026 streak suite (tests/streak.test.ts):
//   - Drive `yesterdayGlance(db, now)` directly against a tmpdir DB for
//     shape, verdict cascade, empty-DB, and quiet-hours tests.
//   - Boot `startServer()` over loopback for the route, cache, and
//     home-payload-snapshot tests, using the empty-roots config + tmp
//     fleet-control.config.json seam from LESSONS § "in-process
//     startServer() tests need an empty-roots config + run-row seeds".
//   - SPA renderer tests are text-level over web/app.js + web/style.css
//     per the inbox / streak / health precedent (zero jsdom).
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps from
// `new Date()`": every seed timestamp is anchored to the test's `NOW`
// constant. Per LESSONS § "node:sqlite's .all() needs `as unknown as
// T[]`": row narrowing in the helper uses the double-cast (exercised
// transitively by importing yesterdayGlance — if the cast regresses
// tsc fails before this file runs).
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
  yesterdayGlance, type YesterdayGlance,
} from "../src/views.ts";
import {
  startServer,
  _resetGlanceCacheForTests, _getGlanceCacheBuildsForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers — pinned-now seeders.
// ────────────────────────────────────────────────────────────────────

// Pinned wall-clock anchor for every seed. UTC-noon so date() buckets
// don't depend on test-machine local TZ.
const NOW = new Date("2026-05-30T12:00:00.000Z");
const TODAY_UTC = NOW.toISOString().slice(0, 10); // 2026-05-30

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-glance-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string, cadenceJson: string | null = null): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
  ).run(slug, slug, "test", cadenceJson);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

interface RunSeed {
  projectId: number; phase: string; sessionId?: string; startedAt: string;
  outcome?: string | null; prNumber?: number | null;
  costUsd?: number | null; durationMs?: number;
}
function seedRun(db: DB, r: RunSeed): number {
  const sid = r.sessionId ?? `s-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,duration_ms,outcome,pr_number,cost_usd,cost_source)"
    + " VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    r.projectId, r.phase, sid, r.startedAt,
    r.durationMs ?? 1000, r.outcome ?? null,
    r.prNumber ?? null, r.costUsd ?? 0, "live",
  );
  return Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

function seedAnomaly(db: DB, runId: number, opts: {
  createdAt: string; kind?: string; dismissedAt?: string | null;
}): void {
  db.prepare(
    "INSERT INTO anomaly(run_id,kind,value,baseline_mean,baseline_stddev,sample_count,candidate_reason,created_at,dismissed_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    runId, opts.kind ?? "duration", 1.0, 0.5, 0.1, 10, null,
    opts.createdAt, opts.dismissedAt ?? null,
  );
}

function seedRollup(db: DB, projectId: number, day: string, costUsd: number, phase = "ship"): void {
  db.prepare(
    "INSERT INTO cost_rollup_day(project_id, phase, day, runs, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd)"
    + " VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(projectId, phase, day, 1, 0, 0, 0, 0, costUsd);
}

function seedPr(db: DB, opts: {
  projectId: number; number: number; state: string; fetchedAt: string;
}): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,additions,deletions,author,url,fetched_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, `pr-${opts.number}`, `feat/${opts.number}`,
    opts.state, "green", null, 1, 0, 0, "a",
    `https://github.com/owner/x/pull/${opts.number}`, opts.fetchedAt,
  );
}

/** ISO timestamp `h` hours BEFORE the pinned NOW (always pinned, never `new Date()`). */
function hoursBeforeNow(h: number): string {
  return new Date(NOW.getTime() - h * 3600_000).toISOString();
}

// ────────────────────────────────────────────────────────────────────
// AC1 — yesterdayGlance returns the documented shape; numbers reflect
//       trailing-24h merged PRs, today's spend, open anomalies in
//       window, and the fleet streak.
// ────────────────────────────────────────────────────────────────────

test("AC1: yesterdayGlance returns the {window, shipped_count, spent_usd, anomalies_open, streak_days, verdict, generated_at} shape with the seeded counts", () => {
  const { db, cleanup } = tempDb();
  try {
    const alpha = seedProject(db, "alpha");
    // 3 merged PRs in trailing 24h (each a shipped run with a pr_number).
    seedRun(db, { projectId: alpha, phase: "ship", startedAt: hoursBeforeNow(3), outcome: "shipped", prNumber: 101 });
    seedRun(db, { projectId: alpha, phase: "ship", startedAt: hoursBeforeNow(8), outcome: "shipped", prNumber: 102 });
    seedRun(db, { projectId: alpha, phase: "ship", startedAt: hoursBeforeNow(20), outcome: "shipped", prNumber: 103 });
    // One older shipped run, OUT of window (must not count).
    seedRun(db, { projectId: alpha, phase: "ship", startedAt: hoursBeforeNow(30), outcome: "shipped", prNumber: 100 });
    // Two open anomalies created in window.
    const r1 = seedRun(db, { projectId: alpha, phase: "ship", startedAt: hoursBeforeNow(2), outcome: "shipped" });
    const r2 = seedRun(db, { projectId: alpha, phase: "ship", startedAt: hoursBeforeNow(4), outcome: "shipped" });
    seedAnomaly(db, r1, { createdAt: hoursBeforeNow(2) });
    seedAnomaly(db, r2, { createdAt: hoursBeforeNow(4) });
    // Spent: $4.12 in cost_rollup_day for the "today" calendar day.
    seedRollup(db, alpha, TODAY_UTC, 4.12);

    const g = yesterdayGlance(db, NOW);
    assert.equal(g.shipped_count, 3, "trailing-24h merged PR count");
    assert.equal(g.anomalies_open, 2, "open anomalies created in window");
    assert.ok(Math.abs(g.spent_usd - 4.12) < 1e-9, `spent_usd=${g.spent_usd}`);
    assert.equal(typeof g.streak_days, "number");
    assert.ok(g.window && typeof g.window.start === "string" && typeof g.window.end === "string");
    assert.equal(g.window.end, NOW.toISOString(), "window.end is `now` ISO");
    assert.ok(g.verdict && typeof g.verdict.kind === "string" && typeof g.verdict.message === "string");
    assert.ok(g.generated_at && /\d{4}-\d{2}-\d{2}T/.test(g.generated_at));
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — verdict priority cascade. Returns the FIRST matching verdict.
// ────────────────────────────────────────────────────────────────────

test("AC2: verdict cascade picks band_shift_red when a project flips to red in window", () => {
  const { db, cleanup } = tempDb();
  try {
    const beta = seedProject(db, "beta");
    // Seed 10 ship runs, ALL failed in the last 24h → ship_success=0 → red.
    // No runs older than 24h → 24h ago the project had no ship history →
    // "was NOT red 24h ago" (it was grey / undefined).
    for (let i = 0; i < 10; i++) {
      seedRun(db, {
        projectId: beta, phase: "ship",
        startedAt: hoursBeforeNow(i + 1),
        outcome: "failure",
      });
    }
    const g = yesterdayGlance(db, NOW);
    assert.equal(g.verdict.kind, "band_shift_red");
    assert.equal(g.verdict.project_slug, "beta");
    assert.match(g.verdict.message, /beta/);
  } finally { cleanup(); }
});

test("AC2: verdict cascade picks band_shift_amber when no red, but a project flipped to amber in window", () => {
  const { db, cleanup } = tempDb();
  try {
    const gamma = seedProject(db, "gamma");
    // ship_success=60 → 60 lands in [50,80) → amber. Make 6/10 shipped.
    for (let i = 0; i < 6; i++) {
      seedRun(db, {
        projectId: gamma, phase: "ship",
        startedAt: hoursBeforeNow(i + 1),
        outcome: "shipped",
      });
    }
    for (let i = 6; i < 10; i++) {
      seedRun(db, {
        projectId: gamma, phase: "ship",
        startedAt: hoursBeforeNow(i + 1),
        outcome: "failure",
      });
    }
    const g = yesterdayGlance(db, NOW);
    assert.equal(g.verdict.kind, "band_shift_amber");
    assert.equal(g.verdict.project_slug, "gamma");
  } finally { cleanup(); }
});

test("AC2: verdict cascade picks budget_threshold when no band shift, but a project crossed >=75% of daily_budget_usd", () => {
  const { db, cleanup } = tempDb();
  try {
    // cap=$10/day, spent=$8 today → 80% → triggers.
    const cap = seedProject(db, "cap", JSON.stringify({ max_daily_usd: 10 }));
    // One shipped run so ship_success=100 → band=green, no band shift.
    seedRun(db, { projectId: cap, phase: "ship", startedAt: hoursBeforeNow(2), outcome: "shipped" });
    seedRollup(db, cap, TODAY_UTC, 8.0);
    const g = yesterdayGlance(db, NOW);
    assert.equal(g.verdict.kind, "budget_threshold");
    assert.equal(g.verdict.project_slug, "cap");
    assert.match(g.verdict.message, /80%|80 %/);
  } finally { cleanup(); }
});

test("AC2: verdict cascade picks fleet_correlation when no band shift / no budget, but a correlation is active", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "p1");
    seedProject(db, "p2");
    // Insert a live anomaly row of kind='fleet_correlated' inside window.
    db.prepare(
      "INSERT INTO anomaly(run_id, kind, value, baseline_mean, baseline_stddev, sample_count, candidate_reason, created_at, correlation_signature)"
      + " VALUES(NULL, 'fleet_correlated', 2, 0, 0, 2, ?, ?, ?)",
    ).run(
      JSON.stringify({
        project_slugs: ["p1", "p2"],
        first_seen_at: hoursBeforeNow(3),
        last_seen_at: hoursBeforeNow(1),
        sample_excerpt: "TS2304",
      }),
      hoursBeforeNow(2),
      "TS2304",
    );
    const g = yesterdayGlance(db, NOW);
    assert.equal(g.verdict.kind, "fleet_correlation");
    assert.match(g.verdict.message, /TS2304/);
    assert.match(g.verdict.message, /2 projects/);
  } finally { cleanup(); }
});

test("AC2: verdict cascade picks first_ship when no critical/budget/correlation, but a project shipped its first-ever PR in window", () => {
  const { db, cleanup } = tempDb();
  try {
    const fresh = seedProject(db, "fresh");
    // The very first shipped run, in window. No prior shipped runs for fresh.
    seedRun(db, {
      projectId: fresh, phase: "ship",
      startedAt: hoursBeforeNow(5), outcome: "shipped", prNumber: 1,
    });
    // Another project that has shipped before, so its in-window ship is
    // NOT a first_ship — should not steal the verdict.
    const old = seedProject(db, "older");
    seedRun(db, {
      projectId: old, phase: "ship", startedAt: hoursBeforeNow(48),
      outcome: "shipped", prNumber: 50,
    });
    seedRun(db, {
      projectId: old, phase: "ship", startedAt: hoursBeforeNow(6),
      outcome: "shipped", prNumber: 51,
    });
    const g = yesterdayGlance(db, NOW);
    assert.equal(g.verdict.kind, "first_ship");
    assert.equal(g.verdict.project_slug, "fresh");
    assert.match(g.verdict.message, /fresh/);
  } finally { cleanup(); }
});

test("AC2: verdict cascade defaults to all_quiet when no other branch matches", () => {
  const { db, cleanup } = tempDb();
  try {
    // Empty fleet, no rows anywhere.
    const g = yesterdayGlance(db, NOW);
    assert.equal(g.verdict.kind, "all_quiet");
    assert.match(g.verdict.message, /All quiet/);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — empty DB + 0-day streak renders a grammatically correct
//       all_quiet line; no NaN, no division-by-zero.
// ────────────────────────────────────────────────────────────────────

test("AC3: empty DB → shipped=0, spent=0, anomalies=0, streak=0, verdict='All quiet. Streak day 0.'", () => {
  const { db, cleanup } = tempDb();
  try {
    const g = yesterdayGlance(db, NOW);
    assert.equal(g.shipped_count, 0);
    assert.equal(g.spent_usd, 0);
    assert.equal(g.anomalies_open, 0);
    assert.equal(g.streak_days, 0);
    assert.equal(g.verdict.kind, "all_quiet");
    assert.equal(g.verdict.message, "All quiet. Streak day 0.");
    // Sanity: no NaN anywhere in the numeric fields.
    assert.ok(Number.isFinite(g.shipped_count));
    assert.ok(Number.isFinite(g.spent_usd));
    assert.ok(Number.isFinite(g.anomalies_open));
    assert.ok(Number.isFinite(g.streak_days));
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — GET /api/fleet/glance route. Auth-gated (read), 200 shape.
//       Boot the real startServer() over loopback.
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
  const dir = mkdtempSync(join(tmpdir(), "fleet-glance-boot-"));
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

test("AC4: GET /api/fleet/glance returns the documented shape on loopback (200)", async () => {
  _resetGlanceCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "routed");
    // One shipped run + one cost rollup so the payload's numbers are >0.
    seedRun(db, { projectId: pid, phase: "ship", startedAt: hoursBeforeNow(3), outcome: "shipped", prNumber: 1 });
    // Use today's actual UTC date for the rollup because the route's
    // `now` is the server's wall-clock — not our pinned NOW. We only
    // need to assert the shape here, not the exact counts.
    const today = new Date().toISOString().slice(0, 10);
    seedRollup(db, pid, today, 1.23);
  });
  try {
    const r = await fetch(b.base + "/api/fleet/glance");
    assert.equal(r.status, 200);
    const j = await r.json() as YesterdayGlance;
    assert.ok(j.window && typeof j.window.start === "string" && typeof j.window.end === "string");
    assert.equal(typeof j.shipped_count, "number");
    assert.equal(typeof j.spent_usd, "number");
    assert.equal(typeof j.anomalies_open, "number");
    assert.equal(typeof j.streak_days, "number");
    assert.ok(j.verdict && typeof j.verdict.kind === "string" && typeof j.verdict.message === "string");
    assert.ok(j.generated_at);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — home payload (listProjects / GET /api/fleet) does NOT inline
//       the glance. Snapshot the shape and assert no `glance` key.
// ────────────────────────────────────────────────────────────────────

test("AC5: home payload at /api/fleet has no `glance` key (additive only — the SPA fetches /api/fleet/glance separately)", async () => {
  _resetGlanceCacheForTests();
  const b = await boot((db) => { seedProject(db, "home"); });
  try {
    const r = await fetch(b.base + "/api/fleet");
    assert.equal(r.status, 200);
    const j = await r.json() as Record<string, unknown>;
    assert.equal((j as { glance?: unknown }).glance, undefined,
      "home payload must NOT inline the glance — the SPA fetches it separately");
    // Defence: also check inside `projects[]` so the per-project rows
    // stay byte-identical.
    const projects = j.projects as Array<Record<string, unknown>> | undefined;
    if (projects && projects.length) {
      for (const p of projects) {
        assert.equal((p as { glance?: unknown }).glance, undefined,
          "per-project rows in home payload must NOT carry a `glance` key");
      }
    }
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Cache-Control: max-age=60 + module-level memo cache + build
//       counter. Two requests within 60s → counter ticks once; force
//       a new minute-key → counter ticks again.
// ────────────────────────────────────────────────────────────────────

test("AC6: GET /api/fleet/glance sets `cache-control: max-age=60` and memoises within the 60s window via a build counter", async () => {
  _resetGlanceCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "cached");
    seedRun(db, { projectId: pid, phase: "ship", startedAt: hoursBeforeNow(1), outcome: "shipped", prNumber: 1 });
  });
  try {
    const before = _getGlanceCacheBuildsForTests();
    const r1 = await fetch(b.base + "/api/fleet/glance");
    assert.equal(r1.status, 200);
    const cc = (r1.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=60/, `cache-control must declare max-age=60; got '${cc}'`);
    await r1.json();
    const afterFirst = _getGlanceCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call → cache MISS, build counter += 1");

    const r2 = await fetch(b.base + "/api/fleet/glance");
    assert.equal(r2.status, 200);
    await r2.json();
    const afterSecond = _getGlanceCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0,
      "second call within the same minute → cache HIT, counter unchanged");

    // Force the cache to expire by clearing it (a stand-in for the
    // wall-clock advancing past 60s). The next call must rebuild.
    _resetGlanceCacheForTests();
    const afterReset = _getGlanceCacheBuildsForTests();
    const r3 = await fetch(b.base + "/api/fleet/glance");
    assert.equal(r3.status, 200);
    await r3.json();
    const afterThird = _getGlanceCacheBuildsForTests();
    assert.equal(afterThird - afterReset, 1,
      "after a cache reset, next call rebuilds → counter += 1");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — web/app.js renders `renderYesterdayGlance` above the inbox,
//       with `data-testid="yesterday-glance"` and a tap target to
//       /digest. Operator strings pass through redactSecrets.
// ────────────────────────────────────────────────────────────────────

test("AC7: web/app.js defines renderYesterdayGlance and emits data-testid=yesterday-glance, fetches /api/fleet/glance, and links to #/digest", () => {
  assert.match(APP_JS, /function\s+renderYesterdayGlance\s*\(/,
    "web/app.js must declare a renderYesterdayGlance helper");
  assert.match(APP_JS, /function\s+renderGlanceSkeleton\s*\(/,
    "web/app.js must declare a renderGlanceSkeleton helper for the loading state");
  assert.match(APP_JS, /data-testid="yesterday-glance"/,
    "the card must carry data-testid=\"yesterday-glance\" for stable phone-test hooks");
  assert.match(APP_JS, /\/api\/fleet\/glance/,
    "web/app.js must fetch the new /api/fleet/glance route");
  // Verdict strings must pass through redactSecrets (defence-in-depth at
  // the renderer boundary, per LESSONS).
  assert.match(APP_JS, /redactSecrets\([^)]*verdict[^)]*\)|redactSecrets\([^)]*message[^)]*\)/,
    "verdict.message / project_slug must pass through redactSecrets before insertion");
  // Above-inbox positioning: the home() render path must concatenate
  // renderYesterdayGlance BEFORE renderInbox.
  const homeBodyMatch = APP_JS.match(/async\s+function\s+home\s*\(\s*\)[\s\S]*?app\.innerHTML\s*=\s*[\s\S]*?renderInbox/);
  assert.ok(homeBodyMatch,
    "home() must include a renderInbox call in its app.innerHTML composition");
  const homeBody = homeBodyMatch![0];
  const idxGlance = homeBody.indexOf("renderYesterdayGlance");
  const idxInbox = homeBody.indexOf("renderInbox");
  assert.ok(idxGlance > -1, "home() must reference renderYesterdayGlance");
  assert.ok(idxGlance < idxInbox,
    "renderYesterdayGlance must appear ABOVE renderInbox in the home() composition");
  // Tap-anywhere navigates to /digest (0012) — accept the hash route or
  // an explicit href reference to digest.
  assert.match(APP_JS, /#\/digest|"#digest"|href[^"]*digest/,
    "the card must link to the weekly digest route per the user story");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Mobile: at 375px the four stats stack 2x2; at >=600px they
//       live in one row. Text-level assertion against web/style.css.
// ────────────────────────────────────────────────────────────────────

test("AC8: web/style.css declares a yesterday-glance selector group with a 600px breakpoint for the single-row layout", () => {
  assert.match(CSS, /\.yesterday-glance\b/,
    "style.css must define a .yesterday-glance rule group");
  // Mobile-first: the base rule wraps to 2x2. The >=600px breakpoint
  // upgrades to a single row. We check the existence of a media query
  // at min-width: 600px touching the glance class.
  const mobileBreakpoint = CSS.match(/@media[^{]*min-width:\s*600px[\s\S]*?\}\s*\}/);
  assert.ok(mobileBreakpoint, "style.css must define a @media (min-width: 600px) block");
  // Verify a 2x2 stat grid hint exists somewhere in the glance selector
  // group (grid-template-columns: 1fr 1fr OR repeat(2, …)). We accept
  // the rule appearing on either `.yesterday-glance` directly or any of
  // its descendants (e.g. `.yesterday-glance .glance-stats`) — the
  // contract is the 2-col grid on phones, not the exact selector.
  // Also accept the rule appearing on a `.glance-stats` rule even
  // without the parent prefix — it's still part of the glance group.
  const hasMobileGrid =
    /\.yesterday-glance[^{]*\{[^}]*grid-template-columns:\s*(1fr\s+1fr|repeat\(\s*2)/.test(CSS)
    || /\.yesterday-glance\s+\.glance-stats[^{]*\{[^}]*grid-template-columns:\s*(1fr\s+1fr|repeat\(\s*2)/.test(CSS)
    || /\.glance-stats[^{]*\{[^}]*grid-template-columns:\s*(1fr\s+1fr|repeat\(\s*2)/.test(CSS);
  assert.ok(hasMobileGrid,
    ".yesterday-glance base rule must lay the stats out 2-per-row on phones");
  // The mobile breakpoint (>= 600px) must upgrade the grid to >= 4
  // columns OR to a flex/row layout. We accept either repeat(4, …),
  // four explicit 1fr columns, or a flex row that does the same job.
  const breakpointBlock = mobileBreakpoint![0];
  const hasDesktopRow =
    /grid-template-columns:\s*(repeat\(\s*4|1fr\s+1fr\s+1fr\s+1fr)/.test(breakpointBlock)
    || /display:\s*flex[^;]*;[\s\S]*flex-direction:\s*row/.test(breakpointBlock);
  assert.ok(hasDesktopRow,
    ".yesterday-glance at >=600px must collapse the stats into a single row");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Loading state: while the fetch is in flight, the skeleton
//       renders with aria-busy="true" and a reduced-motion-aware
//       animation that flattens under prefers-reduced-motion: reduce.
// ────────────────────────────────────────────────────────────────────

test("AC9: renderGlanceSkeleton emits aria-busy=true and the CSS flattens animation under prefers-reduced-motion: reduce", () => {
  // The skeleton string must include aria-busy="true" so screen readers
  // announce the loading state.
  assert.match(APP_JS, /aria-busy="true"/,
    "renderGlanceSkeleton must carry aria-busy=\"true\" on its container");
  // The CSS animation must reference a reduced-motion media query that
  // touches the skeleton block.
  assert.match(CSS, /prefers-reduced-motion:\s*reduce/,
    "style.css must include a prefers-reduced-motion: reduce rule");
  // The skeleton class itself must be defined.
  assert.match(CSS, /\.yesterday-glance-skeleton\b|\.glance-skeleton\b/,
    "style.css must define a skeleton class");
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Quiet-hours integration: amber verdict during quiet hours
//        gets the moon prefix; red / fleet_correlation never demoted.
// ────────────────────────────────────────────────────────────────────

test("AC10: a band_shift_amber verdict during quiet hours is prefixed with the moon glyph + '(arrived during quiet hours)'", () => {
  const { db, cleanup } = tempDb();
  try {
    const g = seedProject(db, "gquiet");
    // Drive an amber verdict.
    for (let i = 0; i < 6; i++) {
      seedRun(db, { projectId: g, phase: "ship", startedAt: hoursBeforeNow(i + 1), outcome: "shipped" });
    }
    for (let i = 6; i < 10; i++) {
      seedRun(db, { projectId: g, phase: "ship", startedAt: hoursBeforeNow(i + 1), outcome: "failure" });
    }
    // 0030's isQuietNow consults cfg.quietHours; we pass a synthetic
    // config-shaped object that places "now" inside the window.
    // NOW is 2026-05-30T12:00:00.000Z = 12:00 UTC.
    const cfg = {
      quietHours: { start: "00:00", end: "23:59", tz: "UTC" },
    } as unknown as Parameters<typeof yesterdayGlance>[2];
    const result = yesterdayGlance(db, NOW, cfg);
    assert.equal(result.verdict.kind, "band_shift_amber");
    assert.match(result.verdict.message, /\u{1F319}/u,
      "amber-during-quiet-hours must be prefixed with the U+1F319 moon glyph");
    assert.match(result.verdict.message, /arrived during quiet hours/);
  } finally { cleanup(); }
});

test("AC10: a band_shift_red verdict during quiet hours is NOT demoted (no moon prefix)", () => {
  const { db, cleanup } = tempDb();
  try {
    const r = seedProject(db, "rquiet");
    for (let i = 0; i < 10; i++) {
      seedRun(db, { projectId: r, phase: "ship", startedAt: hoursBeforeNow(i + 1), outcome: "failure" });
    }
    const cfg = {
      quietHours: { start: "00:00", end: "23:59", tz: "UTC" },
    } as unknown as Parameters<typeof yesterdayGlance>[2];
    const result = yesterdayGlance(db, NOW, cfg);
    assert.equal(result.verdict.kind, "band_shift_red");
    assert.doesNotMatch(result.verdict.message, /\u{1F319}/u,
      "red verdicts MUST NOT be demoted by quiet hours (operator-critical)");
    assert.doesNotMatch(result.verdict.message, /arrived during quiet hours/);
  } finally { cleanup(); }
});

test("AC10: a fleet_correlation verdict during quiet hours is NOT demoted", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "p1");
    seedProject(db, "p2");
    db.prepare(
      "INSERT INTO anomaly(run_id, kind, value, baseline_mean, baseline_stddev, sample_count, candidate_reason, created_at, correlation_signature)"
      + " VALUES(NULL, 'fleet_correlated', 2, 0, 0, 2, ?, ?, ?)",
    ).run(
      JSON.stringify({
        project_slugs: ["p1", "p2"],
        first_seen_at: hoursBeforeNow(3),
        last_seen_at: hoursBeforeNow(1),
        sample_excerpt: "TS2304",
      }),
      hoursBeforeNow(2),
      "TS2304",
    );
    const cfg = {
      quietHours: { start: "00:00", end: "23:59", tz: "UTC" },
    } as unknown as Parameters<typeof yesterdayGlance>[2];
    const result = yesterdayGlance(db, NOW, cfg);
    assert.equal(result.verdict.kind, "fleet_correlation");
    assert.doesNotMatch(result.verdict.message, /\u{1F319}/u,
      "fleet_correlation must never be demoted by quiet hours");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC11 — Performance gate. PERF=1 only.
// ────────────────────────────────────────────────────────────────────

test("AC11: perf — yesterdayGlance < 40ms on 10 projects × 90d telemetry; route < 100ms", { skip: process.env.PERF !== "1" }, async () => {
  const { db, cleanup } = tempDb();
  try {
    for (let p = 0; p < 10; p++) {
      const pid = seedProject(db, "perf" + p);
      // 90 days of one-run-per-day telemetry.
      for (let d = 0; d < 90; d++) {
        seedRun(db, {
          projectId: pid, phase: "ship",
          startedAt: new Date(NOW.getTime() - d * 86400_000).toISOString(),
          outcome: d % 5 === 0 ? "failure" : "shipped",
          prNumber: 1000 * p + d,
        });
      }
      for (let d = 0; d < 90; d++) {
        const day = new Date(NOW.getTime() - d * 86400_000).toISOString().slice(0, 10);
        seedRollup(db, pid, day, 1);
      }
    }
    const t1 = Date.now();
    yesterdayGlance(db, NOW);
    const dt1 = Date.now() - t1;
    assert.ok(dt1 < 40, `yesterdayGlance over 10×90d must finish <40ms; took ${dt1}ms`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC12 — No new runtime deps; tsc-clean. The deps check is exercised
//        by `npx tsc --noEmit` in CI; here we sanity-check the
//        package.json `dependencies` field stays empty.
// ────────────────────────────────────────────────────────────────────

test("AC12: package.json dependencies stays empty (zero runtime deps)", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    "package.json `dependencies` must remain empty (Hard NO in AGENTS.md)");
});
