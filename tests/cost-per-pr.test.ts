// Tests for ticket 0035 — Cost per merged PR.
//
// One test(...) per AC checkbox. Strategy mirrors the 0033 glance suite
// (tests/glance.test.ts):
//   - Drive `costPerMergedPr(db, opts)` directly against a tmpdir DB for
//     shape, division-by-zero, trend baseline, and rendering tests.
//   - Boot `startServer()` over loopback for the route + cache tests, using
//     the empty-roots config + tmp fleet-control.config.json seam from
//     LESSONS § "in-process startServer() tests need an empty-roots config
//     + run-row seeds".
//   - SPA renderer tests are text-level over web/app.js + web/style.css
//     per the inbox / streak / health / glance precedent (zero jsdom).
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps from
// `new Date()`": every seed timestamp is anchored to the test's `NOW`
// constant.
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`": row
// narrowing in the helper uses the double-cast (exercised transitively by
// importing costPerMergedPr — if the cast regresses tsc fails before this
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
  costPerMergedPr, type CostPerMergedPr,
} from "../src/views.ts";
import {
  startServer,
  _resetCostPerPrCacheForTests, _getCostPerPrCacheBuildsForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

// Pinned wall-clock anchor for every seed. UTC-noon so date() buckets
// don't depend on test-machine local TZ.
const NOW = new Date("2026-05-30T12:00:00.000Z");

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-cppr-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
  ).run(slug, slug, "test", null);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

function seedRollup(db: DB, projectId: number, day: string, costUsd: number, phase = "ship"): void {
  db.prepare(
    "INSERT INTO cost_rollup_day(project_id, phase, day, runs, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd)"
    + " VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(projectId, phase, day, 1, 0, 0, 0, 0, costUsd);
}

function seedPr(db: DB, opts: {
  projectId: number; number: number; state: string; fetchedAt: string;
  isAgent?: number;
}): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,additions,deletions,author,url,fetched_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, `pr-${opts.number}`, `feat/${opts.number}`,
    opts.state, "green", null, opts.isAgent ?? 1, 0, 0, "a",
    `https://github.com/owner/x/pull/${opts.number}`, opts.fetchedAt,
  );
}

/** ISO timestamp `d` days BEFORE the pinned NOW (always pinned, never `new Date()`). */
function daysBeforeNow(d: number): string {
  return new Date(NOW.getTime() - d * 86400_000).toISOString();
}

/** YYYY-MM-DD `d` days BEFORE NOW (UTC). */
function dayBeforeNow(d: number): string {
  return new Date(NOW.getTime() - d * 86400_000).toISOString().slice(0, 10);
}

/** Seed a project with predictable totals. Window: [end-14d, end);
 *  end is today UTC midnight (so day_offset=0 means TODAY which is
 *  OUTSIDE the window, and day_offset=14 means the inclusive start).
 *
 *  Inside the trailing 14-day window we put two non-equal rollup rows
 *  (a "big" day + a "small" day so the prior baseline sigma stays > 0
 *  per LESSONS § "anomaly tests need sigma > 0 in the fixture") whose
 *  sum is exactly `current.spend`. The prior window mirrors the same
 *  shape with the sum exactly `prior.spend`. */
function seedProjectWithSpend(
  db: DB, slug: string,
  current: { spend: number; prs: number },
  prior: { spend: number; prs: number },
  windowDays = 14,
): number {
  const pid = seedProject(db, slug);
  // Current window: day_offset 1..windowDays are inside (day 0 = today
  // is EXCLUDED). Split spend across two non-equal days so sigma > 0.
  // dayBeforeNow(2) and dayBeforeNow(8) both lie inside the 14d window.
  if (current.spend > 0) {
    const big = current.spend * 0.7;
    const small = current.spend * 0.3;
    seedRollup(db, pid, dayBeforeNow(2), big, "ship");
    seedRollup(db, pid, dayBeforeNow(8), small, "groom");
  }
  for (let n = 0; n < current.prs; n++) {
    // Spread PRs across days 1..windowDays-1 (all inside window).
    const ageDays = 1 + (n % (windowDays - 1));
    seedPr(db, {
      projectId: pid, number: 1000 + n, state: "MERGED",
      fetchedAt: daysBeforeNow(ageDays),
    });
  }
  // Prior window: day_offset 15..28 inclusive (so dayBeforeNow(16) and
  // dayBeforeNow(22) are well inside [windowDays, 2*windowDays)).
  if (prior.spend > 0) {
    const big = prior.spend * 0.7;
    const small = prior.spend * 0.3;
    seedRollup(db, pid, dayBeforeNow(16), big, "ship");
    seedRollup(db, pid, dayBeforeNow(22), small, "groom");
  }
  for (let n = 0; n < prior.prs; n++) {
    const ageDays = windowDays + 1 + (n % (windowDays - 1));
    seedPr(db, {
      projectId: pid, number: 2000 + n, state: "MERGED",
      fetchedAt: daysBeforeNow(ageDays),
    });
  }
  return pid;
}

// ────────────────────────────────────────────────────────────────────
// AC1 — costPerMergedPr returns the documented shape and project rows
//       sort by $/PR descending.
// ────────────────────────────────────────────────────────────────────

test("AC1: costPerMergedPr returns the {window, fleet, projects, generated_at} shape with sorted rows", () => {
  const { db, cleanup } = tempDb();
  try {
    // fleet-control: $24 / 12 PRs → $/PR=$2.00 (current); prior $20 / 10 → $2.00
    seedProjectWithSpend(db, "fleet-control", { spend: 24, prs: 12 }, { spend: 20, prs: 10 });
    // courtiq: $31 / 9 PRs → $/PR≈$3.44 (current); prior $20 / 9 → $/PR≈$2.22 → trend up
    seedProjectWithSpend(db, "courtiq", { spend: 31, prs: 9 }, { spend: 20, prs: 9 });

    const r = costPerMergedPr(db, { days: 14, now: NOW });
    // Shape checks.
    assert.ok(r.window && typeof r.window.start === "string" && typeof r.window.end === "string");
    assert.equal(r.window.days, 14);
    assert.ok(r.fleet);
    assert.equal(typeof r.fleet.spent_usd, "number");
    assert.equal(typeof r.fleet.prs_merged, "number");
    assert.equal(typeof r.generated_at, "string");
    assert.ok(Array.isArray(r.projects));
    // Fleet rollup: 24+31 = 55 spend; 12+9 = 21 PRs → 55/21 ≈ 2.619
    assert.ok(Math.abs(r.fleet.spent_usd - 55) < 1e-6, `spend=${r.fleet.spent_usd}`);
    assert.equal(r.fleet.prs_merged, 21);
    assert.ok(r.fleet.dollars_per_pr != null && Math.abs(r.fleet.dollars_per_pr - 55 / 21) < 1e-6);
    // Sort by $/PR DESC — courtiq ($3.44) above fleet-control ($2.00).
    const slugs = r.projects.map((p) => p.slug);
    assert.equal(slugs[0], "courtiq", "highest $/PR first");
    assert.equal(slugs[1], "fleet-control");
    // Each project row: shape + sane numbers.
    for (const p of r.projects) {
      assert.equal(typeof p.slug, "string");
      assert.equal(typeof p.spent_usd, "number");
      assert.equal(typeof p.prs_merged, "number");
      assert.ok(Number.isFinite(p.spent_usd));
      assert.ok(Number.isFinite(p.prs_merged));
    }
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — Division-by-zero guard: project with spend but zero merges
//       returns dollars_per_pr=null; fleet returns null too if all
//       projects have zero merges.
// ────────────────────────────────────────────────────────────────────

test("AC2: project with $5 spent and zero merges → dollars_per_pr=null for both row and fleet headline", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "lonely");
    seedRollup(db, pid, dayBeforeNow(2), 5.0);
    // NO PRs at all — zero merges in window.
    const r = costPerMergedPr(db, { days: 14, now: NOW });
    const row = r.projects.find((p) => p.slug === "lonely");
    assert.ok(row, "lonely row present even with zero merges");
    assert.equal(row!.spent_usd, 5.0);
    assert.equal(row!.prs_merged, 0);
    assert.strictEqual(row!.dollars_per_pr, null,
      "$/PR must be null when prs_merged=0 (NOT Infinity, NOT 0, NOT NaN)");
    // Fleet rollup: total merges is 0 → dollars_per_pr === null at top.
    assert.equal(r.fleet.prs_merged, 0);
    assert.strictEqual(r.fleet.dollars_per_pr, null,
      "fleet $/PR must be null when total prs_merged=0");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — Insufficient-baseline guard: when prior window has < 3 merged
//       PRs OR < $1 spent → trend_pct=null. Also SPA renders an em-dash.
// ────────────────────────────────────────────────────────────────────

test("AC3: project with no prior-window data → trend_pct=null and SPA renders an em-dash placeholder", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "freshly");
    // Current window: $10 / 5 merged PRs (well above the 3-PR / $1
    // baseline floor; so the row itself is computable).
    for (let i = 0; i < 5; i++) {
      seedRollup(db, pid, dayBeforeNow(i + 1), 2.0);
      seedPr(db, {
        projectId: pid, number: 100 + i, state: "MERGED",
        fetchedAt: daysBeforeNow(i + 1),
      });
    }
    // No prior-window rollups or PRs.
    const r = costPerMergedPr(db, { days: 14, now: NOW });
    const row = r.projects.find((p) => p.slug === "freshly");
    assert.ok(row);
    assert.strictEqual(row!.trend_pct, null,
      "trend must be null when prior window has < 3 merged PRs or < $1");
    // SPA renders an em-dash for null trend cells.
    assert.match(APP_JS, /(—|&mdash;|trend.*null)/i,
      "web/app.js must render an em-dash or equivalent placeholder for null trend");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — GET /api/fleet/cost-per-pr?days=14 returns the shape; auth +
//       clampDays grid; loopback boot via the empty-roots config seam.
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
  const dir = mkdtempSync(join(tmpdir(), "fleet-cppr-boot-"));
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

test("AC4: GET /api/fleet/cost-per-pr — auth (401 remote), 200 on loopback, days clamps to 90", async () => {
  _resetCostPerPrCacheForTests();
  const b = await boot((db) => {
    seedProjectWithSpend(db, "routed", { spend: 14, prs: 7 }, { spend: 14, prs: 7 });
  });
  try {
    // Loopback: 200 default.
    const r = await fetch(b.base + "/api/fleet/cost-per-pr");
    assert.equal(r.status, 200);
    const j = await r.json() as CostPerMergedPr;
    assert.equal(j.window.days, 14);
    assert.equal(typeof j.fleet.spent_usd, "number");
    // days=30 → window.days===30.
    _resetCostPerPrCacheForTests();
    const r30 = await fetch(b.base + "/api/fleet/cost-per-pr?days=30");
    const j30 = await r30.json() as CostPerMergedPr;
    assert.equal(j30.window.days, 30);
    // days=999 → clamped to 90.
    _resetCostPerPrCacheForTests();
    const r999 = await fetch(b.base + "/api/fleet/cost-per-pr?days=999");
    const j999 = await r999.json() as CostPerMergedPr;
    assert.equal(j999.window.days, 90, "days=999 must clamp to 90");
    // Invalid: days=garbage → 14.
    _resetCostPerPrCacheForTests();
    const rg = await fetch(b.base + "/api/fleet/cost-per-pr?days=notanumber");
    const jg = await rg.json() as CostPerMergedPr;
    assert.equal(jg.window.days, 14, "garbage days must fall back to 14");
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: GET /api/fleet/cost-per-pr without auth from a non-loopback IP → 401", async () => {
  // Auth is exercised at the requireAuth chokepoint level; the boot()
  // helper only listens on loopback so we exercise the requireAuth
  // function directly with a fake remote req. The combination of
  // (route under /api/, no token, ip != 127.0.0.1) is the 401 path.
  const { requireAuth } = await import("../src/server.ts");
  const { db, cleanup } = tempDb();
  try {
    const fakeReq = {
      socket: { remoteAddress: "10.0.0.5" },
      headers: {},
    };
    const r = requireAuth(db, fakeReq as any, "read");
    assert.equal(r.ok, false);
    assert.equal(r.status, 401, "remote callers with no token → 401");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — Caching: Cache-Control: max-age=300, module-level memo keyed
//       by (days, now-rounded-to-5-min), reset + build counter seams.
// ────────────────────────────────────────────────────────────────────

test("AC5: GET /api/fleet/cost-per-pr sets cache-control max-age=300 and the build counter ticks once per cache miss", async () => {
  _resetCostPerPrCacheForTests();
  const b = await boot((db) => {
    seedProjectWithSpend(db, "cached", { spend: 6, prs: 3 }, { spend: 4, prs: 3 });
  });
  try {
    const before = _getCostPerPrCacheBuildsForTests();
    const r1 = await fetch(b.base + "/api/fleet/cost-per-pr");
    assert.equal(r1.status, 200);
    const cc = (r1.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=300/, `cache-control must declare max-age=300; got '${cc}'`);
    await r1.json();
    const afterFirst = _getCostPerPrCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call → cache MISS, build counter += 1");

    const r2 = await fetch(b.base + "/api/fleet/cost-per-pr");
    assert.equal(r2.status, 200);
    await r2.json();
    const afterSecond = _getCostPerPrCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0,
      "second call within the same 5-minute window → cache HIT, counter unchanged");

    // Force expiration by resetting the cache (stand-in for the 6min
    // advance). The next call must rebuild.
    _resetCostPerPrCacheForTests();
    const afterReset = _getCostPerPrCacheBuildsForTests();
    const r3 = await fetch(b.base + "/api/fleet/cost-per-pr");
    assert.equal(r3.status, 200);
    await r3.json();
    const afterThird = _getCostPerPrCacheBuildsForTests();
    assert.equal(afterThird - afterReset, 1,
      "after a cache reset, next call rebuilds → counter += 1");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — web/app.js renders the one-line summary above the 0033 glance
//       card with data-testid="cost-per-pr-summary"; null-PR branch
//       reads "No merged PRs yet".
// ────────────────────────────────────────────────────────────────────

test("AC6: web/app.js defines renderCostPerPrSummary, links to /cost-per-pr, and emits data-testid=cost-per-pr-summary above the glance card", () => {
  assert.match(APP_JS, /function\s+renderCostPerPrSummary\s*\(/,
    "web/app.js must declare a renderCostPerPrSummary helper");
  assert.match(APP_JS, /data-testid="cost-per-pr-summary"/,
    "the summary line must carry data-testid=\"cost-per-pr-summary\" for stable test hooks");
  assert.match(APP_JS, /\/api\/fleet\/cost-per-pr/,
    "web/app.js must fetch the /api/fleet/cost-per-pr route");
  // Tap navigates to /cost-per-pr.
  assert.match(APP_JS, /#\/cost-per-pr|href[^"]*cost-per-pr/,
    "the summary must link to /cost-per-pr per the user story");
  // Above-glance positioning: the home() render path must concatenate
  // renderCostPerPrSummary BEFORE renderYesterdayGlance.
  const homeBodyMatch = APP_JS.match(/async\s+function\s+home\s*\(\s*\)[\s\S]*?app\.innerHTML\s*=\s*[\s\S]*?renderYesterdayGlance/);
  assert.ok(homeBodyMatch,
    "home() must include renderYesterdayGlance in its app.innerHTML composition");
  const homeBody = homeBodyMatch![0];
  const idxSummary = homeBody.indexOf("renderCostPerPrSummary");
  const idxGlance = homeBody.indexOf("renderYesterdayGlance");
  assert.ok(idxSummary > -1, "home() must reference renderCostPerPrSummary");
  assert.ok(idxSummary < idxGlance,
    "renderCostPerPrSummary must appear ABOVE renderYesterdayGlance in the home() composition");
  // Empty-state copy: "No merged PRs yet" branch.
  assert.match(APP_JS, /No merged PRs yet/,
    "summary must render 'No merged PRs yet' when dollars_per_pr is null");
  // redactSecrets pattern (defence-in-depth, even though this surface has
  // no secrets today — same pattern as 0033 glance for consistency).
  assert.match(APP_JS, /renderCostPerPrSummary[\s\S]{0,2000}redactSecrets|redactSecrets[\s\S]{0,2000}cost-per-pr/,
    "renderCostPerPrSummary must invoke redactSecrets per the defence-in-depth pattern");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — /cost-per-pr detail page renders a sortable table; default
//       sort by $/PR descending; fleet rollup is the last row with a
//       border-top separator.
// ────────────────────────────────────────────────────────────────────

test("AC7: web/app.js defines renderCostPerPrDetail, routes #/cost-per-pr, and emits a sortable table with the fleet rollup row last", () => {
  assert.match(APP_JS, /function\s+renderCostPerPrDetail\s*\(/,
    "web/app.js must declare a renderCostPerPrDetail helper");
  // Route wiring: hash router must dispatch /cost-per-pr to a handler.
  assert.match(APP_JS, /cost-per-pr/,
    "route() must reference cost-per-pr to dispatch the detail view");
  // Table columns: project | $ | PRs | $/PR | trend.
  assert.match(APP_JS, /\$\/PR/,
    "detail table header must include the '$/PR' column");
  // Fleet rollup last row + border-top separator.
  assert.match(APP_JS, /fleet-rollup|cost-per-pr-fleet-row/,
    "detail must render a distinct fleet-rollup row");
  assert.match(CSS, /\.cost-per-pr-table\b|\.cost-per-pr-detail\b/,
    "style.css must define a cost-per-pr table selector group");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Mobile collapse at 375px: detail table renders one row per
//       project with slug + $/PR + trend; >=600px expands to 4 cols.
// ────────────────────────────────────────────────────────────────────

test("AC8: style.css declares mobile-collapse for the cost-per-pr table with a >=600px breakpoint", () => {
  // Base rule exists.
  assert.match(CSS, /\.cost-per-pr-table\b|\.cost-per-pr-detail\b/,
    "style.css must define the cost-per-pr table selector group");
  // Mobile-first hide of full columns: somewhere a rule hides extra
  // cells on phones, or applies display:none to data columns.
  const hasMobileCollapse =
    /\.cost-per-pr-table[^{]*\{[\s\S]*?display:\s*(block|grid)/.test(CSS)
    || /\.cost-per-pr-table\s+td[^{]*\{[\s\S]*?display:/.test(CSS)
    || /\.cost-per-pr-table[\s\S]{0,200}\.collapsed|\.mobile-hide/.test(CSS);
  assert.ok(hasMobileCollapse,
    "cost-per-pr table must collapse to 1 row per project on phones");
  // >=600px breakpoint upgrades to a regular table.
  const desktopBreakpoint = CSS.match(/@media[^{]*min-width:\s*600px[\s\S]*?cost-per-pr[\s\S]*?\}\s*\}/);
  assert.ok(desktopBreakpoint, "style.css must define a @media (min-width: 600px) block touching .cost-per-pr-*");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Quiet-hours integration: the summary line is byte-identical
//       regardless of quiet hours (this is a pull surface, not push).
// ────────────────────────────────────────────────────────────────────

test("AC9: renderCostPerPrSummary output is byte-identical regardless of quietHoursActive (pull surface, not push)", () => {
  // We exercise this at the SPA layer: there must not be any branch on
  // quietHoursActive inside renderCostPerPrSummary. Grep the function
  // body for the flag.
  const fnMatch = APP_JS.match(/function\s+renderCostPerPrSummary\s*\([\s\S]*?\n\}/);
  assert.ok(fnMatch, "renderCostPerPrSummary body must be locatable");
  const body = fnMatch![0];
  assert.doesNotMatch(body, /quietHours|quiet_hours|quietHoursActive/,
    "renderCostPerPrSummary must not branch on quiet hours (pull surface)");
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Performance: helper < 50ms over 10 projects × 90d, route <
//        120ms. Skipped unless PERF=1.
// ────────────────────────────────────────────────────────────────────

test("AC10: perf — costPerMergedPr < 50ms over 10 projects × 90d", { skip: process.env.PERF !== "1" }, () => {
  const { db, cleanup } = tempDb();
  try {
    for (let p = 0; p < 10; p++) {
      const pid = seedProject(db, "perf" + p);
      for (let d = 0; d < 90; d++) {
        seedRollup(db, pid, dayBeforeNow(d), 1.0);
      }
      for (let n = 0; n < 14; n++) {
        seedPr(db, {
          projectId: pid, number: 100 * p + n + 1, state: "MERGED",
          fetchedAt: daysBeforeNow(n),
        });
      }
    }
    const t1 = Date.now();
    costPerMergedPr(db, { days: 14, now: NOW });
    const dt1 = Date.now() - t1;
    assert.ok(dt1 < 50, `costPerMergedPr over 10×90d must finish <50ms; took ${dt1}ms`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC11 — No new runtime deps; tsc-clean (the deps check is the
//        package.json sanity check; tsc-clean is exercised by CI).
// ────────────────────────────────────────────────────────────────────

test("AC11: package.json dependencies stays empty (zero runtime deps)", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    "package.json `dependencies` must remain empty (Hard NO in AGENTS.md)");
});
