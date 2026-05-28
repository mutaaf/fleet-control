// Tests for the merge streak counter + 90-day calendar heatmap
// (ticket 0026). One `test(...)` per acceptance-criteria checkbox.
//
// Strategy: drive `fleetStreak(db, opts)` directly against a tmpdir DB
// for the band-bucket / streak-walk / day-boundary / merged-PR /
// unrecovered-failure / perf / empty-state tests. Boot the real
// `startServer()` over loopback for the route + auth-scope test
// (AC6). The SPA renderer (AC7) is a text-level check against
// `web/app.js` + `web/style.css`, mirroring the inbox.test.ts pattern
// — no jsdom, no playwright, zero new deps.
//
// Day buckets use SQLite's `date(ts)` (UTC), the same convention the
// existing `cost_rollup_day` table uses (see src/ingest/index.ts).
// Tests pin `opts.now` so a wall-clock test never depends on the time
// the suite runs.
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
import { fleetStreak } from "../src/views.ts";
import { startServer, requireAuth } from "../src/server.ts";
import { mintToken, revokeToken } from "../src/auth.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-streak-"));
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

interface RunSeed {
  projectId: number; phase: string; sessionId: string; startedAt: string;
  outcome: string; prNumber?: number | null;
}
function seedRun(db: DB, r: RunSeed): number {
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,outcome,pr_number,cost_source) "
    + "VALUES(?,?,?,?,?,?,?)",
  ).run(r.projectId, r.phase, r.sessionId, r.startedAt, r.outcome, r.prNumber ?? null, "live");
  return Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

interface PrMergeSeed {
  projectId: number; number: number; title?: string; mergedAt: string;
}
/** Seed a merged-state PR row. The heatmap reads `state='MERGED'` AND
 *  `fetched_at` is treated as merged_at (the existing ingest pipeline
 *  stamps fetched_at on every sync; merged_at is derived from gh's
 *  mergedAt field via the same column). For 0026 we store the merged
 *  wall-clock in `fetched_at` for SQL bucketing — that matches the
 *  `pr` table's columns today and stays additive. */
function seedMergedPr(db: DB, p: PrMergeSeed): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
    + "additions,deletions,author,url,fetched_at) "
    + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    p.projectId, p.number, p.title ?? `feat/${p.number}`, `feat/${p.number}-x`,
    "MERGED", "green", "clean", 1, 1, 0, "agent",
    `https://github.com/owner/x/pull/${p.number}`, p.mergedAt,
  );
}

// ────────────────────────────────────────────────────────────────────
// AC1 — fleetStreak shape + band bucketing for each band.
// ────────────────────────────────────────────────────────────────────

test("AC1: fleetStreak returns 90 heatmap cells and band buckets cover empty/low/med/high/red", () => {
  const { db, cleanup } = tempDb();
  try {
    // Pin "now" to a UTC noon so date() buckets stay stable across the
    // test machine's local midnight. We seed:
    //   today      → 5 merged PRs (band: high)
    //   today-1    → 2 merged PRs (band: med)
    //   today-2    → 1 merged PR  (band: low)
    //   today-3    → 0 activity   (band: empty)
    //   today-4    → 1 failure + 0 merges (band: red)
    const now = new Date("2026-05-27T12:00:00.000Z");
    const pid = seedProject(db, "alpha");

    const dayIso = (delta: number) => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + delta);
      d.setUTCHours(12, 0, 0, 0);
      return d.toISOString();
    };
    const dayStr = (delta: number) => dayIso(delta).slice(0, 10);

    // today: 5 merged PRs
    for (let n = 0; n < 5; n++) {
      seedMergedPr(db, { projectId: pid, number: 100 + n, mergedAt: dayIso(0) });
    }
    // today-1: 2 merged
    for (let n = 0; n < 2; n++) {
      seedMergedPr(db, { projectId: pid, number: 200 + n, mergedAt: dayIso(-1) });
    }
    // today-2: 1 merged
    seedMergedPr(db, { projectId: pid, number: 300, mergedAt: dayIso(-2) });
    // today-4: 1 failure, no merges -> red
    seedRun(db, {
      projectId: pid, phase: "ship", sessionId: "sess-fail-4",
      startedAt: dayIso(-4), outcome: "failure",
    });

    const r = fleetStreak(db, { now: now.toISOString() });
    assert.equal(typeof r.streak_days, "number", "streak_days is a number");
    assert.ok(r.last_red_day === null || typeof r.last_red_day === "string",
      "last_red_day is string|null");
    assert.ok(Array.isArray(r.heatmap), "heatmap is an array");
    assert.equal(r.heatmap.length, 90,
      `heatmap must cover the last 90 days (today inclusive); got ${r.heatmap.length}`);

    // Last cell = today (chronological), so heatmap[89] == today.
    const byDate = new Map(r.heatmap.map((c) => [c.date, c]));
    const cellToday = byDate.get(dayStr(0))!;
    const cellMinus1 = byDate.get(dayStr(-1))!;
    const cellMinus2 = byDate.get(dayStr(-2))!;
    const cellMinus3 = byDate.get(dayStr(-3))!;
    const cellMinus4 = byDate.get(dayStr(-4))!;
    assert.ok(cellToday && cellMinus1 && cellMinus2 && cellMinus3 && cellMinus4,
      "every seeded date must be present in the heatmap");
    assert.equal(cellToday.band, "high", `today (5 merged) → high; got ${cellToday.band}`);
    assert.equal(cellToday.merged, 5);
    assert.equal(cellMinus1.band, "med", `today-1 (2 merged) → med; got ${cellMinus1.band}`);
    assert.equal(cellMinus1.merged, 2);
    assert.equal(cellMinus2.band, "low", `today-2 (1 merged) → low; got ${cellMinus2.band}`);
    assert.equal(cellMinus2.merged, 1);
    assert.equal(cellMinus3.band, "empty", `today-3 (no activity) → empty; got ${cellMinus3.band}`);
    assert.equal(cellMinus3.merged, 0);
    assert.equal(cellMinus3.failed, 0);
    assert.equal(cellMinus4.band, "red", `today-4 (failure, no merge) → red; got ${cellMinus4.band}`);
    assert.equal(cellMinus4.failed, 1);
    assert.equal(cellMinus4.merged, 0);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — Streak walks back from today; empty days don't break;
// only an unrecovered failure (red band) breaks the streak.
// ────────────────────────────────────────────────────────────────────

test("AC2: streak walks back over empty days and stops at the most recent red day", () => {
  const { db, cleanup } = tempDb();
  try {
    // Pin now to a UTC noon. Seed:
    //   today    (-0): empty
    //   today-1: low (1 merged)
    //   today-2: empty
    //   today-3: red (failure, no merge)
    //   today-4: low (1 merged)
    // Expected: streak_days = 3 (today + today-1 + today-2; the loop
    // walks back from today and stops AT the red day, which is the
    // 4th step). last_red_day = today-3.
    const now = new Date("2026-05-27T12:00:00.000Z");
    const pid = seedProject(db, "beta");
    const dayIso = (delta: number) => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + delta);
      d.setUTCHours(12, 0, 0, 0);
      return d.toISOString();
    };
    const dayStr = (delta: number) => dayIso(delta).slice(0, 10);

    seedMergedPr(db, { projectId: pid, number: 1, mergedAt: dayIso(-1) });
    seedRun(db, {
      projectId: pid, phase: "ship", sessionId: "sess-fail-3",
      startedAt: dayIso(-3), outcome: "failure",
    });
    seedMergedPr(db, { projectId: pid, number: 2, mergedAt: dayIso(-4) });

    const r = fleetStreak(db, { now: now.toISOString() });
    assert.equal(r.streak_days, 3,
      `streak should walk today + today-1 + today-2 (3 days); got ${r.streak_days}`);
    assert.equal(r.last_red_day, dayStr(-3),
      `last_red_day should be the seeded failure's date; got ${r.last_red_day}`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — Day boundary: a 23:59 run sticks to the day it STARTED on.
// We bucket on date(started_at) which is SQLite UTC — the seed
// timestamps are also in UTC so 23:59 UTC stays inside that day.
// ────────────────────────────────────────────────────────────────────

test("AC3: a run started at 23:59 UTC attributes to that day, not the next", () => {
  const { db, cleanup } = tempDb();
  try {
    // Pin now to 2026-05-13T12:00:00Z so May 12 is today-1. Seed a
    // failure at 2026-05-12T23:59:00Z. The day bucket for May 12
    // must contain that failure (band=red, failed=1); May 13 stays
    // empty.
    const now = new Date("2026-05-13T12:00:00.000Z");
    const pid = seedProject(db, "boundary");
    seedRun(db, {
      projectId: pid, phase: "ship", sessionId: "sess-bound",
      startedAt: "2026-05-12T23:59:00.000Z", outcome: "failure",
    });

    const r = fleetStreak(db, { now: now.toISOString() });
    const byDate = new Map(r.heatmap.map((c) => [c.date, c]));
    const may12 = byDate.get("2026-05-12")!;
    const may13 = byDate.get("2026-05-13")!;
    assert.ok(may12, "May 12 cell must exist");
    assert.ok(may13, "May 13 cell must exist");
    assert.equal(may12.failed, 1, "the 23:59 run must attribute to May 12");
    assert.equal(may12.band, "red", "May 12 with a failure + zero merges is red");
    assert.equal(may13.failed, 0, "May 13 stays clean — the cross-midnight run is not double-counted");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — Merged-PR count sourced from the `pr` table where
// state='MERGED' AND merged_at falls in the day.
// ────────────────────────────────────────────────────────────────────

test("AC4: two MERGED PRs on the same day surface as merged=2 for that day's cell", () => {
  const { db, cleanup } = tempDb();
  try {
    const now = new Date("2026-05-13T12:00:00.000Z");
    const pid = seedProject(db, "gamma");
    seedMergedPr(db, { projectId: pid, number: 41, mergedAt: "2026-05-12T09:15:00.000Z" });
    seedMergedPr(db, { projectId: pid, number: 42, mergedAt: "2026-05-12T17:42:00.000Z" });
    // Also a non-merged (open) PR same day — must NOT count.
    db.prepare(
      "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
      + "additions,deletions,author,url,fetched_at) "
      + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(pid, 43, "open one", "feat/43", "open", "green", "clean", 1, 1, 0,
      "agent", "https://github.com/owner/x/pull/43", "2026-05-12T18:00:00.000Z");

    const r = fleetStreak(db, { now: now.toISOString() });
    const may12 = r.heatmap.find((c) => c.date === "2026-05-12")!;
    assert.ok(may12, "May 12 cell must exist");
    assert.equal(may12.merged, 2,
      `only state='MERGED' rows count; got ${may12.merged}`);
    assert.equal(may12.band, "med", "2 merged → med band");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — Unrecovered failure rule: a failure followed by a same-project
// same-day success doesn't count toward `failed`.
// ────────────────────────────────────────────────────────────────────

test("AC5: a same-day same-project success recovers the failure → failed=0", () => {
  const { db, cleanup } = tempDb();
  try {
    const now = new Date("2026-05-13T12:00:00.000Z");
    const pid = seedProject(db, "delta");
    // Failure at 10am, success at 11am — same project, same day.
    seedRun(db, {
      projectId: pid, phase: "ship", sessionId: "sess-fail",
      startedAt: "2026-05-12T10:00:00.000Z", outcome: "failure",
    });
    seedRun(db, {
      projectId: pid, phase: "ship", sessionId: "sess-ok",
      startedAt: "2026-05-12T11:00:00.000Z", outcome: "shipped",
    });
    // And a separate project on the same day that ONLY failed → still red.
    const pid2 = seedProject(db, "epsilon");
    seedRun(db, {
      projectId: pid2, phase: "ship", sessionId: "sess-2fail",
      startedAt: "2026-05-12T13:00:00.000Z", outcome: "failure",
    });

    const r = fleetStreak(db, { now: now.toISOString() });
    const may12 = r.heatmap.find((c) => c.date === "2026-05-12")!;
    assert.ok(may12, "May 12 cell must exist");
    assert.equal(may12.failed, 1,
      `delta recovered its failure but epsilon's stuck; expected 1 failed; got ${may12.failed}`);
    // band: 1 unrecovered failure AND 0 merges → red.
    assert.equal(may12.band, "red");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — GET /api/fleet/streak: 401 without auth, 200 with read scope.
// Uses the same boot harness as tests/inbox.test.ts (empty-roots
// config + FLEET_DB_PATH seam).
// ────────────────────────────────────────────────────────────────────

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

interface Booted {
  base: string;
  close: () => Promise<void>;
  cleanup: () => void;
  dbPath: string;
}

async function boot(seed?: (db: DB) => void): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-streak-route-"));
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
  const server = startServer("127.0.0.1", port);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base + "/api/whoami");
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((rs) => setTimeout(rs, 20));
  }
  return {
    base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    cleanup: () => {
      delete process.env.FLEET_DB_PATH;
      activeBoots -= 1;
      if (activeBoots === 0) {
        if (savedConfigText === null) {
          try { unlinkSync(CONFIG_PATH); } catch { /* gone already */ }
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

test("AC6: GET /api/fleet/streak is gated by the read scope and returns the documented shape", async () => {
  const b = await boot((db) => {
    const pid = seedProject(db, "alpha", "Alpha");
    seedMergedPr(db, { projectId: pid, number: 1, mergedAt: new Date().toISOString() });
  });
  try {
    // ── Scope-gate proof ───────────────────────────────────────────
    const dbOpen = openDb(b.dbPath);
    try {
      const nope = requireAuth(dbOpen, {
        socket: { remoteAddress: "10.0.0.5" }, headers: {},
      } as any, "read");
      assert.equal(nope.ok, false);
      assert.equal(nope.status, 401, "no-token remote must be 401");

      const minted = mintToken(dbOpen, "phone", "read");
      revokeToken(dbOpen, minted.id_prefix);
      const revoked = requireAuth(dbOpen, {
        socket: { remoteAddress: "10.0.0.5" },
        headers: { "x-fleet-token": minted.token },
      } as any, "read");
      assert.equal(revoked.ok, false);
      assert.equal(revoked.status, 401);
    } finally { dbOpen.close(); }

    // ── 200 shape on the live route over loopback ─────────────────
    const rOk = await fetch(b.base + "/api/fleet/streak");
    assert.equal(rOk.status, 200);
    const body = await rOk.json() as {
      streak_days: number;
      last_red_day: string | null;
      heatmap: Array<{ date: string; merged: number; failed: number; band: string }>;
    };
    assert.equal(typeof body.streak_days, "number");
    assert.ok(body.last_red_day === null || typeof body.last_red_day === "string");
    assert.equal(body.heatmap.length, 90, "exactly 90 cells");
    for (const cell of body.heatmap) {
      assert.match(cell.date, /^\d{4}-\d{2}-\d{2}$/, "date is yyyy-mm-dd");
      assert.equal(typeof cell.merged, "number");
      assert.equal(typeof cell.failed, "number");
      assert.ok(["empty", "low", "med", "high", "red"].includes(cell.band),
        `unknown band: ${cell.band}`);
    }
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — SPA renders streak line + heatmap above the inbox. Text-level
// checks against web/app.js + web/style.css (mirrors inbox.test.ts).
// ────────────────────────────────────────────────────────────────────

test("AC7: web/app.js wires renderStreak above the inbox and the CSS heatmap grid is 13x7", () => {
  // The render entry point is renderStreak(data) — that's the wiring
  // point we assert on.
  assert.match(APP_JS, /function\s+renderStreak\s*\(/,
    "renderStreak(data) helper must be defined");
  assert.match(APP_JS, /function\s+renderHeatmap\s*\(/,
    "renderHeatmap(cells) helper must be defined");
  // Empty state copy per the ticket.
  assert.ok(APP_JS.includes("Fleet streak: starting today"),
    "empty-state line must read exactly: Fleet streak: starting today");
  // home() must call renderStreak before renderInbox so the heatmap
  // sits ABOVE the inbox (per the ticket's "above the existing inbox").
  const homeStart = APP_JS.indexOf("async function home(");
  assert.ok(homeStart > 0, "home() must exist");
  const slice = APP_JS.slice(homeStart, homeStart + 4000);
  const idxStreak = slice.indexOf("renderStreak(");
  const idxInbox = slice.indexOf("renderInbox(");
  assert.ok(idxStreak > 0, "home() must call renderStreak(...)");
  assert.ok(idxInbox > 0, "home() must still call renderInbox(...)");
  assert.ok(idxStreak < idxInbox,
    "renderStreak must run BEFORE renderInbox so the heatmap sits above the inbox");
  // The data fetcher must hit /api/fleet/streak.
  assert.ok(APP_JS.includes("/api/fleet/streak"),
    "app.js must fetch from /api/fleet/streak");
  // Heatmap cells are <button>s with aria-label for keyboard a11y.
  assert.match(APP_JS, /<button[^>]*class="heatmap-cell/,
    "heatmap cells must be <button>s with class heatmap-cell");
  assert.ok(/aria-label/.test(APP_JS.slice(APP_JS.indexOf("heatmap-cell"), APP_JS.indexOf("heatmap-cell") + 600)),
    "heatmap-cell <button>s must carry an aria-label with the date + counts");
  // CSS: a .heatmap selector with 13 columns × 7 rows.
  assert.match(CSS, /\.heatmap\s*\{[^}]*grid-template-columns\s*:\s*repeat\s*\(\s*13/,
    "heatmap grid must declare grid-template-columns: repeat(13, …)");
  assert.match(CSS, /\.heatmap\s*\{[^}]*grid-template-rows\s*:\s*repeat\s*\(\s*7/,
    "heatmap grid must declare grid-template-rows: repeat(7, …)");
  // Mobile MQ: no horizontal-scroll regression at 375px. The
  // .heatmap container must not pin a min-width > 375.
  const ruleRe = /\.heatmap\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(CSS)) !== null) {
    const ruleBody = m[1];
    const mw = /min-width\s*:\s*(\d+)px/.exec(ruleBody);
    if (mw) {
      assert.ok(+mw[1] <= 375,
        `.heatmap min-width: ${mw[1]}px would overflow a 375px viewport`);
    }
  }
});

// ────────────────────────────────────────────────────────────────────
// AC8 — perf: 10 projects + 90 days of activity → fleetStreak < 50ms.
// Skipped unless PERF=1 so CI stays fast.
// ────────────────────────────────────────────────────────────────────

test("AC8: fleetStreak runs in under 50ms over 10 projects × 90 days of activity",
  { skip: process.env.PERF !== "1" }, () => {
  const { db, cleanup } = tempDb();
  try {
    const now = new Date("2026-05-27T12:00:00.000Z");
    const dayIso = (delta: number) => {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + delta);
      d.setUTCHours(12, 0, 0, 0);
      return d.toISOString();
    };
    const projectIds: number[] = [];
    for (let i = 0; i < 10; i++) projectIds.push(seedProject(db, `proj-${i}`));
    let prCounter = 1;
    for (let d = 0; d < 90; d++) {
      for (let i = 0; i < projectIds.length; i++) {
        const pid = projectIds[i];
        // 2 merged PRs per project per day → 1800 PRs total.
        seedMergedPr(db, { projectId: pid, number: prCounter++, mergedAt: dayIso(-d) });
        seedMergedPr(db, { projectId: pid, number: prCounter++, mergedAt: dayIso(-d) });
        // A run every other day so SQL has plenty to GROUP BY.
        if (d % 2 === 0) {
          seedRun(db, {
            projectId: pid, phase: "ship",
            sessionId: `sess-${pid}-${d}`,
            startedAt: dayIso(-d), outcome: "shipped",
          });
        }
      }
    }
    const t0 = Date.now();
    const r = fleetStreak(db, { now: now.toISOString() });
    const elapsed = Date.now() - t0;
    assert.equal(r.heatmap.length, 90);
    assert.ok(elapsed < 50, `fleetStreak took ${elapsed}ms — must be under 50ms`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC9 — empty DB: streak_days=0, last_red_day=null, 90 empty cells.
// SPA renders "Fleet streak: starting today".
// ────────────────────────────────────────────────────────────────────

test("AC9: an empty fleet produces streak_days=0 + 90 empty cells + the documented empty-state line", () => {
  const { db, cleanup } = tempDb();
  try {
    const now = new Date("2026-05-27T12:00:00.000Z");
    const r = fleetStreak(db, { now: now.toISOString() });
    assert.equal(r.streak_days, 0, "fresh DB → streak_days=0");
    assert.equal(r.last_red_day, null, "fresh DB → last_red_day=null");
    assert.equal(r.heatmap.length, 90);
    for (const cell of r.heatmap) {
      assert.equal(cell.merged, 0, "every cell starts at 0 merged");
      assert.equal(cell.failed, 0, "every cell starts at 0 failed");
      assert.equal(cell.band, "empty", "every cell is empty");
    }
    // The SPA's empty-state copy is asserted in AC7; we don't repeat
    // the assertion here — but we DO confirm the helper produces a
    // shape that the SPA can render with no errors.
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 — no new runtime deps; no schema migration; existing /api/...
// JSON shapes unchanged. The /api/fleet/streak route is net-new.
// ────────────────────────────────────────────────────────────────────

test("AC10: package.json carries zero runtime dependencies; SQL reads use as unknown as RowT[] cast", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    `dependencies must stay empty; found: ${Object.keys(deps).join(", ")}`);
  // The fleetStreak helper uses the cast pattern per LESSONS.
  const viewsTs = readFileSync(join(__dirname, "..", "src", "views.ts"), "utf8");
  const streakStart = viewsTs.indexOf("export function fleetStreak");
  assert.ok(streakStart > 0, "fleetStreak must be exported from src/views.ts");
  const streakEnd = viewsTs.indexOf("\n}\n", streakStart);
  const streakBody = viewsTs.slice(streakStart, streakEnd > 0 ? streakEnd : streakStart + 4000);
  assert.ok(/as unknown as\s+\w+(\[\])?/.test(streakBody),
    "fleetStreak must use the `as unknown as RowT[]` cast for SQL rows");
  // No new schema migration — fleetStreak reads existing tables only.
  assert.ok(!/CREATE TABLE.*streak/i.test(viewsTs),
    "no streak-table schema; fleetStreak reads existing run + pr tables");
});
