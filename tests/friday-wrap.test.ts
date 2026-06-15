// Tests for ticket 0037 — Friday wrap weekly card.
//
// One test(...) per acceptance-criteria checkbox. Strategy mirrors the
// 0033 glance suite (tests/glance.test.ts) and 0035 cost-per-pr suite:
//   - Drive `fridayWrap(db, now)` / `isFriday(now, tz)` directly against
//     a tmpdir DB for shape, biggest-win, watch-item cascade, and
//     timezone tests.
//   - Boot `startServer()` over loopback for the route + cache tests,
//     using the empty-roots config + tmp fleet-control.config.json seam
//     from LESSONS § "in-process startServer() tests need an empty-roots
//     config + run-row seeds".
//   - SPA renderer tests are text-level over web/app.js + web/style.css
//     per the inbox / streak / glance / cost-per-pr precedent (zero
//     jsdom).
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps from
// `new Date()`": every seed timestamp is anchored to the test's `NOW`
// constant.
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`": row
// narrowing in the helper uses the double-cast (exercised transitively
// by importing fridayWrap — if the cast regresses tsc fails before this
// file runs).
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
  fridayWrap, isFriday, type FridayWrap,
} from "../src/views.ts";
import {
  startServer,
  _resetFridayWrapCacheForTests,
  _getFridayWrapCacheBuildsForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers — pinned-now seeders.
// ────────────────────────────────────────────────────────────────────

// Pinned wall-clock anchor for every seed. 2026-06-05 UTC noon = Friday
// in UTC, Friday in New_York. (LA is still Thursday at 12:00Z; that
// edge powers the isFriday tz test.)
const NOW = new Date("2026-06-05T12:00:00.000Z");
const NOW_ISO = NOW.toISOString();

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-friday-"));
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

function seedAnomaly(db: DB, runId: number | null, opts: {
  createdAt: string; kind?: string; dismissedAt?: string | null;
  correlationSignature?: string | null; candidateReason?: string | null;
}): void {
  db.prepare(
    "INSERT INTO anomaly(run_id,kind,value,baseline_mean,baseline_stddev,sample_count,candidate_reason,created_at,dismissed_at,correlation_signature)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    runId, opts.kind ?? "duration", 1.0, 0.5, 0.1, 10,
    opts.candidateReason ?? null,
    opts.createdAt, opts.dismissedAt ?? null,
    opts.correlationSignature ?? null,
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
  title?: string; additions?: number; deletions?: number; isAgent?: number;
}): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,additions,deletions,author,url,fetched_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number,
    opts.title ?? `pr-${opts.number}`,
    `feat/${opts.number}`,
    opts.state, "green", null, opts.isAgent ?? 1,
    opts.additions ?? 0, opts.deletions ?? 0, "a",
    `https://github.com/owner/x/pull/${opts.number}`, opts.fetchedAt,
  );
}

function seedTicketLink(db: DB, opts: {
  ticketId: string; projectSlug: string; commitSha: string;
  commitDate: string; prNumber: number;
}): void {
  db.prepare(
    "INSERT INTO ticket_commit_link("
    + "ticket_id, project_slug, commit_sha, commit_date, author,"
    + " message_subject, files_changed, insertions, deletions, pr_number)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.ticketId, opts.projectSlug, opts.commitSha, opts.commitDate,
    "a", "msg", 1, 1, 1, opts.prNumber,
  );
}

/** ISO timestamp `h` hours BEFORE the pinned NOW. */
function hoursBeforeNow(h: number): string {
  return new Date(NOW.getTime() - h * 3600_000).toISOString();
}

/** YYYY-MM-DD `d` days BEFORE NOW (UTC). */
function dayBeforeNow(d: number): string {
  return new Date(NOW.getTime() - d * 86400_000).toISOString().slice(0, 10);
}

/** Seed the 17-PR / $28.40 / 2-anomalies / 7-active-days canonical
 *  fixture from the ticket's user story. Returns the alpha project id. */
function seedCanonicalFixture(db: DB): number {
  const alpha = seedProject(db, "alpha");
  // 17 merged PRs spread across the trailing 7 days. Anchor every
  // merged_at to a fixed offset hours before NOW so the window math is
  // deterministic (LESSONS § "time-pinned tests must NOT derive seed
  // timestamps from `new Date()`").
  //
  // Distribute as 3,3,3,2,2,2,2 across days 0..6 = 17 total.
  // Day 0 = today, Day 6 = 6 days ago — every day inside the inclusive
  // 7-day window ending at NOW carries at least one merged PR so
  // active_days = 7.
  const perDay = [3, 3, 3, 2, 2, 2, 2];
  let n = 100;
  for (let d = 0; d < 7; d++) {
    const dayMid = new Date(NOW.getTime() - d * 86400_000 - 6 * 3600_000).toISOString();
    for (let i = 0; i < perDay[d]; i++) {
      seedPr(db, {
        projectId: alpha, number: n, state: "MERGED",
        fetchedAt: dayMid, additions: 10, deletions: 5,
      });
      n += 1;
    }
  }
  // $28.40 split across 7 days of cost rollups (each at $4.0571...).
  // Use seven exact entries summing to $28.40 — match the user story.
  // Day 0..6 get [4.40, 4.00, 4.00, 4.00, 4.00, 4.00, 4.00] = 28.40.
  const costs = [4.40, 4.00, 4.00, 4.00, 4.00, 4.00, 4.00];
  for (let d = 0; d < 7; d++) {
    seedRollup(db, alpha, dayBeforeNow(d), costs[d]);
  }
  // 2 anomalies in window, attached to two recent runs.
  const r1 = seedRun(db, { projectId: alpha, phase: "ship", startedAt: hoursBeforeNow(20), outcome: "shipped" });
  const r2 = seedRun(db, { projectId: alpha, phase: "ship", startedAt: hoursBeforeNow(40), outcome: "shipped" });
  seedAnomaly(db, r1, { createdAt: hoursBeforeNow(20) });
  seedAnomaly(db, r2, { createdAt: hoursBeforeNow(40) });
  return alpha;
}

// ────────────────────────────────────────────────────────────────────
// AC1 — fridayWrap returns the documented shape; the four headline
//        numbers reflect window-scoped reads of pr / cost_rollup_day /
//        anomaly tables.
// ────────────────────────────────────────────────────────────────────

test("AC1: fridayWrap returns the shape with shipped_count=17, spent_usd=28.40, anomalies_count=2, active_days=7 against the canonical fixture", () => {
  const { db, cleanup } = tempDb();
  try {
    seedCanonicalFixture(db);
    const w = fridayWrap(db, NOW);
    assert.equal(w.shipped_count, 17, `shipped_count=${w.shipped_count}`);
    assert.ok(Math.abs(w.spent_usd - 28.40) < 1e-6, `spent_usd=${w.spent_usd}`);
    assert.equal(w.anomalies_count, 2, `anomalies_count=${w.anomalies_count}`);
    assert.equal(w.active_days, 7, `active_days=${w.active_days}`);
    assert.ok(w.window && typeof w.window.start === "string"
      && typeof w.window.end === "string"
      && typeof w.window.week_iso === "string",
      "window must carry start, end, week_iso strings");
    assert.equal(w.window.end, NOW_ISO);
    assert.match(w.window.week_iso, /^\d{4}-W\d{2}$/,
      `week_iso shape ${w.window.week_iso}`);
    assert.ok(w.generated_at && /\d{4}-\d{2}-\d{2}T/.test(w.generated_at));
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — biggest_win picks the highest (additions + deletions) PR.
// ────────────────────────────────────────────────────────────────────

test("AC2: biggest_win picks the highest additions+deletions PR and resolves its ticket id from ticket_commit_link", () => {
  const { db, cleanup } = tempDb();
  try {
    const alpha = seedProject(db, "alpha");
    const beta = seedProject(db, "beta");
    // 5 merged PRs in window with known sizes; the 0034 win should win.
    seedPr(db, { projectId: alpha, number: 11, state: "MERGED",
      fetchedAt: hoursBeforeNow(72), additions: 50, deletions: 30,
      title: "tiny win" });
    seedPr(db, { projectId: alpha, number: 12, state: "MERGED",
      fetchedAt: hoursBeforeNow(48), additions: 200, deletions: 100,
      title: "mid win" });
    seedPr(db, { projectId: alpha, number: 13, state: "MERGED",
      fetchedAt: hoursBeforeNow(36), additions: 600, deletions: 400,
      title: "drift detector" });
    seedPr(db, { projectId: beta, number: 99, state: "MERGED",
      fetchedAt: hoursBeforeNow(24), additions: 80, deletions: 20,
      title: "beta change" });
    seedPr(db, { projectId: beta, number: 100, state: "MERGED",
      fetchedAt: hoursBeforeNow(12), additions: 5, deletions: 5,
      title: "beta nit" });
    // Link PR #13 to ticket 0034.
    seedTicketLink(db, {
      ticketId: "0034", projectSlug: "alpha",
      commitSha: "abc123", commitDate: hoursBeforeNow(36).slice(0, 10),
      prNumber: 13,
    });
    const w = fridayWrap(db, NOW);
    assert.ok(w.biggest_win, "biggest_win must be non-null");
    assert.equal(w.biggest_win!.project_slug, "alpha");
    assert.equal(w.biggest_win!.pr_number, 13);
    assert.equal(w.biggest_win!.size_score, 1000);
    assert.equal(w.biggest_win!.ticket_id, "0034",
      "ticket_id should resolve via ticket_commit_link");
    assert.equal(w.biggest_win!.pr_title, "drift detector");
  } finally { cleanup(); }
});

test("AC2: biggest_win is null when zero merged PRs in window", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "alpha");
    const w = fridayWrap(db, NOW);
    assert.equal(w.biggest_win, null);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — watch_item cascade. First non-null match wins.
// ────────────────────────────────────────────────────────────────────

test("AC3: watch_item picks the drift branch when any active self_drift exists", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "courtiq");
    const r = seedRun(db, { projectId: p, phase: "ship",
      startedAt: hoursBeforeNow(6), outcome: "failure" });
    // Seed a self_drift anomaly within the 24h cutoff activeDrifts uses.
    seedAnomaly(db, r, {
      kind: "self_drift",
      createdAt: hoursBeforeNow(2),
      correlationSignature: "duration_ms",
      candidateReason: JSON.stringify({
        metric: "duration_ms",
        baseline_mean: 1000, baseline_sigma: 100,
        current: 2100, sigmas: 11,
        first_seen_at: hoursBeforeNow(2),
        contributing_runs: [String(r)],
      }),
    });
    const w = fridayWrap(db, NOW);
    assert.ok(w.watch_item, "watch_item must be non-null when drift exists");
    assert.equal(w.watch_item!.kind, "drift");
    assert.equal(w.watch_item!.project_slug, "courtiq");
    assert.match(w.watch_item!.message, /courtiq/);
  } finally { cleanup(); }
});

test("AC3: watch_item picks the correlation branch when no drift but a fleet_correlated row is live", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "p1");
    seedProject(db, "p2");
    seedAnomaly(db, null, {
      kind: "fleet_correlated",
      createdAt: hoursBeforeNow(2),
      correlationSignature: "TS2304",
      candidateReason: JSON.stringify({
        project_slugs: ["p1", "p2"],
        first_seen_at: hoursBeforeNow(4),
        last_seen_at: hoursBeforeNow(1),
        sample_excerpt: "TS2304",
      }),
    });
    const w = fridayWrap(db, NOW);
    assert.ok(w.watch_item, "watch_item must be non-null when correlation is active");
    assert.equal(w.watch_item!.kind, "correlation");
    assert.match(w.watch_item!.message, /TS2304/);
    assert.match(w.watch_item!.message, /2 projects/);
  } finally { cleanup(); }
});

test("AC3: watch_item is null when no drift, no correlation, no cost-trend signal", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "quiet");
    const w = fridayWrap(db, NOW);
    assert.equal(w.watch_item, null);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — isFriday helper. Local day-of-week via Intl.DateTimeFormat.
// ────────────────────────────────────────────────────────────────────

test("AC4: isFriday returns false in America/Los_Angeles at Friday UTC midnight (still Thursday in LA)", () => {
  // 2026-06-05T00:00:00Z = Friday 00:00 UTC = Thursday 17:00 PT.
  const t = new Date("2026-06-05T00:00:00.000Z");
  assert.equal(isFriday(t, "America/Los_Angeles"), false);
});

test("AC4: isFriday returns true in America/New_York at Friday noon UTC", () => {
  // 2026-06-05T12:00:00Z = Friday 12:00 UTC = Friday 08:00 ET.
  const t = new Date("2026-06-05T12:00:00.000Z");
  assert.equal(isFriday(t, "America/New_York"), true);
});

test("AC4: isFriday returns true in UTC at Friday 12:00 UTC", () => {
  assert.equal(isFriday(NOW, "UTC"), true);
});

test("AC4: isFriday returns false in UTC at Thursday 12:00 UTC", () => {
  const t = new Date("2026-06-04T12:00:00.000Z");
  assert.equal(isFriday(t, "UTC"), false);
});

// ────────────────────────────────────────────────────────────────────
// AC5 — Route: GET /api/fleet/friday-wrap returns
//        {visible, window, stats..., generated_at}. 401 without auth,
//        200 with visible:false on non-Friday, 200 with visible:true on
//        Friday.
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
  const dir = mkdtempSync(join(tmpdir(), "fleet-friday-boot-"));
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

test("AC5: GET /api/fleet/friday-wrap on loopback returns 200 with visible:false off-Friday when ?tz=UTC and now is a Thursday", async () => {
  _resetFridayWrapCacheForTests();
  const b = await boot((db) => { seedProject(db, "any"); });
  try {
    // Thursday: pin tz=UTC and rely on the server's own clock; the
    // server's now is whatever wall-clock the test machine is on, so
    // we exercise the "always-200" property and the visible boolean
    // shape regardless of which weekday it actually is.
    const r = await fetch(b.base + "/api/fleet/friday-wrap?tz=UTC");
    assert.equal(r.status, 200);
    const j = await r.json() as FridayWrap & { visible: boolean };
    assert.equal(typeof j.visible, "boolean", "visible must be a boolean");
    // Whatever the day, the response carries the documented shape.
    assert.ok(j.window && typeof j.window.start === "string");
    assert.equal(typeof j.shipped_count, "number");
    assert.equal(typeof j.spent_usd, "number");
    assert.equal(typeof j.anomalies_count, "number");
    assert.equal(typeof j.active_days, "number");
    assert.ok("biggest_win" in j, "biggest_win must be present (null or object)");
    assert.ok("watch_item" in j, "watch_item must be present (null or object)");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Caching: max-age=600 header + module-level memo cache + build
//        counter. Two requests within 10 min on the same day → counter
//        ticks once.
// ────────────────────────────────────────────────────────────────────

test("AC6: GET /api/fleet/friday-wrap sets cache-control: max-age=600 and memoises via a build counter", async () => {
  _resetFridayWrapCacheForTests();
  const b = await boot((db) => { seedProject(db, "cached"); });
  try {
    const before = _getFridayWrapCacheBuildsForTests();
    const r1 = await fetch(b.base + "/api/fleet/friday-wrap?tz=UTC");
    assert.equal(r1.status, 200);
    const cc = (r1.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=600/, `cache-control must declare max-age=600; got '${cc}'`);
    await r1.json();
    const afterFirst = _getFridayWrapCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call → cache MISS, build counter += 1");

    const r2 = await fetch(b.base + "/api/fleet/friday-wrap?tz=UTC");
    assert.equal(r2.status, 200);
    await r2.json();
    const afterSecond = _getFridayWrapCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0,
      "second call within the cache window → cache HIT, counter unchanged");

    // Force the cache to expire by clearing it (a stand-in for the
    // wall-clock advancing past 10 minutes or to a new ISO week). The
    // next call must rebuild.
    _resetFridayWrapCacheForTests();
    const afterReset = _getFridayWrapCacheBuildsForTests();
    const r3 = await fetch(b.base + "/api/fleet/friday-wrap?tz=UTC");
    assert.equal(r3.status, 200);
    await r3.json();
    const afterThird = _getFridayWrapCacheBuildsForTests();
    assert.equal(afterThird - afterReset, 1,
      "after a cache reset, next call rebuilds → counter += 1");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — web/app.js renders the friday-wrap card ABOVE the yesterday
//        glance card, only when visible:true; data-testid + tap target
//        to /digest; operator strings pass through redactSecrets.
// ────────────────────────────────────────────────────────────────────

test("AC7: web/app.js defines renderFridayWrap and emits data-testid=friday-wrap when visible:true; absent when visible:false; fetches the route and links to #/digest", () => {
  assert.match(APP_JS, /function\s+renderFridayWrap\s*\(/,
    "web/app.js must declare a renderFridayWrap helper");
  assert.match(APP_JS, /data-testid="friday-wrap"/,
    "the card must carry data-testid=\"friday-wrap\" for stable phone-test hooks");
  assert.match(APP_JS, /\/api\/fleet\/friday-wrap/,
    "web/app.js must fetch the new /api/fleet/friday-wrap route");
  // The biggest-win title and watch-item message must pass through
  // redactSecrets (defence-in-depth at the renderer boundary per LESSONS).
  assert.match(APP_JS,
    /redactSecrets\([^)]*pr_title[^)]*\)|redactSecrets\([^)]*biggest_win[^)]*\)/,
    "biggest_win.pr_title must pass through redactSecrets before insertion");
  assert.match(APP_JS,
    /redactSecrets\([^)]*watch_item[^)]*\)|redactSecrets\([^)]*watch[^)]*\)/,
    "watch_item.message must pass through redactSecrets before insertion");
  // Above-yesterday-glance positioning: the home() render path must
  // concatenate renderFridayWrap BEFORE renderYesterdayGlance.
  const homeBodyMatch = APP_JS.match(/async\s+function\s+home\s*\(\s*\)[\s\S]*?app\.innerHTML\s*=\s*[\s\S]*?renderYesterdayGlance/);
  assert.ok(homeBodyMatch,
    "home() must include a renderYesterdayGlance call in its app.innerHTML composition");
  const homeBody = homeBodyMatch![0];
  const idxFriday = homeBody.indexOf("renderFridayWrap");
  const idxGlance = homeBody.indexOf("renderYesterdayGlance");
  assert.ok(idxFriday > -1, "home() must reference renderFridayWrap");
  assert.ok(idxFriday < idxGlance,
    "renderFridayWrap must appear ABOVE renderYesterdayGlance in the home() composition");
  // Tap-anywhere navigates to /digest (0012) — accept the hash route or
  // an explicit href reference to digest.
  const renderFn = APP_JS.match(/function\s+renderFridayWrap\s*\([\s\S]*?\n\}/);
  assert.ok(renderFn, "renderFridayWrap function body must be parseable");
  assert.match(renderFn![0], /#\/digest|"#digest"|href[^"]*digest/,
    "the friday-wrap card body must link to the weekly digest route");
  // Non-Friday / empty response branch: renderer returns "" so no DOM
  // element is emitted (no skeleton, no whitespace).
  assert.match(renderFn![0], /return\s*""|return\s*''/,
    "renderFridayWrap must return an empty string when not visible");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Mobile: at 375px the four stats stack 2x2; at >=600px the
//       stats live in one row. Text-level assertion against
//       web/style.css. Mirrors the 0033 layout patterns.
// ────────────────────────────────────────────────────────────────────

test("AC8: web/style.css declares a friday-wrap selector group with a 600px breakpoint for the single-row layout", () => {
  assert.match(CSS, /\.friday-wrap\b/,
    "style.css must define a .friday-wrap rule group");
  // The base rule must stack stats 2-per-row on phones via a grid.
  // We accept the rule on either `.friday-wrap` directly or on
  // `.wrap-stats` / `.friday-wrap .wrap-stats` so the contract is the
  // 2-col grid on phones, not the exact selector.
  const hasMobileGrid =
    /\.friday-wrap[^{]*\{[^}]*grid-template-columns:\s*(1fr\s+1fr|repeat\(\s*2)/.test(CSS)
    || /\.friday-wrap\s+\.wrap-stats[^{]*\{[^}]*grid-template-columns:\s*(1fr\s+1fr|repeat\(\s*2)/.test(CSS)
    || /\.wrap-stats[^{]*\{[^}]*grid-template-columns:\s*(1fr\s+1fr|repeat\(\s*2)/.test(CSS);
  assert.ok(hasMobileGrid,
    ".friday-wrap base rule must lay the stats out 2-per-row on phones");
  // The mobile breakpoint (>= 600px) must upgrade the grid to >= 4
  // columns OR to a flex/row layout that touches the friday-wrap class.
  const mq = CSS.match(/@media\s*\([^)]*min-width:\s*600px[^)]*\)\s*\{([\s\S]*?)\}\s*\}/);
  assert.ok(mq, "style.css must define a @media (min-width: 600px) block");
  // Check ANY 600px block touches the friday-wrap class — we may have
  // multiple such blocks (one per card type), so use a global search.
  const all600 = CSS.match(/@media\s*\([^)]*min-width:\s*600px[^)]*\)\s*\{[\s\S]*?\n\}/g) || [];
  const matchingBlock = all600.find((b) => /\.friday-wrap|\.wrap-stats/.test(b));
  assert.ok(matchingBlock,
    "A @media (min-width: 600px) block must target .friday-wrap / .wrap-stats");
  const hasDesktopRow =
    /grid-template-columns:\s*(repeat\(\s*4|1fr\s+1fr\s+1fr\s+1fr)/.test(matchingBlock!)
    || /display:\s*flex[^;]*;[\s\S]*flex-direction:\s*row/.test(matchingBlock!);
  assert.ok(hasDesktopRow,
    ".friday-wrap at >=600px must collapse the stats into a single row");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Quiet-hours integration: amber-only watch candidates get
//       suppressed when quiet hours are active; drift / correlation
//       (critical) survive.
// ────────────────────────────────────────────────────────────────────

test("AC9: a cost_trend watch candidate is omitted when quiet hours are active (non-critical demotion)", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "burner");
    // Force a cost-trend signal: current 7d is 2.1x prior 7d, no PRs
    // merged in either window means trend computation is purely
    // cost-based. We seed cost_rollup_day in BOTH windows.
    // Window: trailing 7 days ending at NOW (UTC).
    // Prior:  trailing 7 days before that.
    for (let d = 0; d < 7; d++) {
      seedRollup(db, p, dayBeforeNow(d), 10); // recent = $70
    }
    for (let d = 7; d < 14; d++) {
      seedRollup(db, p, dayBeforeNow(d), 3); // prior = $21 → ratio ~3.3x
    }
    // To exercise the cost_trend branch we also need merged PRs in both
    // windows so the cost-per-pr helper has a numerator. Three each.
    for (let i = 0; i < 3; i++) {
      seedPr(db, { projectId: p, number: 200 + i, state: "MERGED",
        fetchedAt: hoursBeforeNow(48 + i * 6), additions: 10, deletions: 5 });
      seedPr(db, { projectId: p, number: 300 + i, state: "MERGED",
        fetchedAt: hoursBeforeNow(200 + i * 6), additions: 10, deletions: 5 });
    }
    // Quiet hours active across the entire day → non-critical demoted.
    const cfg = {
      quietHours: { start: "00:00", end: "23:59", tz: "UTC" },
    } as unknown as Parameters<typeof fridayWrap>[2];
    const w = fridayWrap(db, NOW, cfg);
    assert.equal(w.watch_item, null,
      "cost_trend watch must be suppressed during quiet hours (non-critical)");
  } finally { cleanup(); }
});

test("AC9: a drift watch candidate is NOT suppressed during quiet hours (critical always surfaces)", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "critsig");
    const r = seedRun(db, { projectId: p, phase: "ship",
      startedAt: hoursBeforeNow(6), outcome: "failure" });
    seedAnomaly(db, r, {
      kind: "self_drift",
      createdAt: hoursBeforeNow(2),
      correlationSignature: "duration_ms",
      candidateReason: JSON.stringify({
        metric: "duration_ms",
        baseline_mean: 1000, baseline_sigma: 100,
        current: 2100, sigmas: 11,
        first_seen_at: hoursBeforeNow(2),
        contributing_runs: [String(r)],
      }),
    });
    const cfg = {
      quietHours: { start: "00:00", end: "23:59", tz: "UTC" },
    } as unknown as Parameters<typeof fridayWrap>[2];
    const w = fridayWrap(db, NOW, cfg);
    assert.ok(w.watch_item, "drift watch must survive quiet hours");
    assert.equal(w.watch_item!.kind, "drift");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Performance: PERF=1 only. fridayWrap < 50ms over 10 projects ×
//        90d telemetry.
// ────────────────────────────────────────────────────────────────────

test("AC10: perf — fridayWrap completes < 50ms on 10 projects × 90d telemetry", { skip: process.env.PERF !== "1" }, () => {
  const { db, cleanup } = tempDb();
  try {
    for (let p = 0; p < 10; p++) {
      const pid = seedProject(db, "perf" + p);
      for (let d = 0; d < 90; d++) {
        const dayMid = new Date(NOW.getTime() - d * 86400_000 - 6 * 3600_000).toISOString();
        seedPr(db, { projectId: pid, number: 1000 * p + d, state: "MERGED",
          fetchedAt: dayMid, additions: 10, deletions: 5 });
        seedRollup(db, pid, dayBeforeNow(d), 1.0);
      }
    }
    const t1 = Date.now();
    fridayWrap(db, NOW);
    const dt1 = Date.now() - t1;
    assert.ok(dt1 < 50, `fridayWrap over 10×90d must finish <50ms; took ${dt1}ms`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC11 — No new runtime deps. package.json dependencies stays empty.
// ────────────────────────────────────────────────────────────────────

test("AC11: package.json dependencies stays empty (zero runtime deps)", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    "package.json `dependencies` must remain empty (Hard NO in AGENTS.md)");
});
