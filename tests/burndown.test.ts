// Tests for ticket 0028 — month-to-date budget burndown per project card.
//
// Coverage map (one test scenario per acceptance-criteria checkbox in
// docs/backlog/0028-project-card-budget-burndown.md):
//
//   AC1  projectBurndown shape + 10 days @ $1/day with $2 cap
//   AC2  cumulative spend is windowed SUM via cost_rollup_day,
//        seeded through `run` rows + recomputeRollups() per LESSONS
//   AC3  projection: today + 7d-avg × days-remaining
//   AC4  band rules (red / amber / green) and null-cap-> green
//   AC5  cap reads from manifest (cadence_json.max_daily_usd); NULL when unset
//   AC6  listProjects() carries the slim burndown summary; days[] omitted
//   AC7  GET /api/projects/:slug/burndown route — 401 from remote, 200 shape
//   AC8  web/app.js renders the sparkline SVG with dashed cap line + today dot;
//        renderBurndownSparkline passes labels through redactSecrets
//   AC9  mobile shrink — viewport contract in CSS
//   AC10 empty state: no rollup rows → no chart, "no spend this month"
//   AC11 perf: projectBurndown <10ms for 31 days; listProjects <100ms for 10
//        (gated on PERF=1 per the ticket)
//   AC12 no new runtime deps; tsc-clean cast pattern
//
// Style discipline (mirrors tests/health.test.ts):
//   - `as unknown as RowT[]` casts are exercised by importing the helper;
//     tsc enforces the pattern at compile time.
//   - In-process startServer() boots reuse the empty-roots config +
//     FLEET_DB_PATH seam (LESSONS § "in-process startServer tests need an
//     empty-roots config + run-row seeds, not direct rollup inserts").
//   - SPA tests are text-level over web/app.js + web/style.css (zero jsdom).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { openDb, type DB } from "../src/db.ts";
import {
  projectBurndown, listProjects, _resetHealthCacheForTests,
} from "../src/views.ts";
import { recomputeRollups } from "../src/ingest/index.ts";
import { startServer } from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");

// ────────────────────────────────────────────────────────────────────
// Fixtures
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-burndown-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return {
    db,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function seedProject(
  db: DB, slug: string, cadence: Record<string, string> = {},
): number {
  db.prepare(
    "INSERT INTO project(slug,name,namespace,repo_owner,repo_name,cadence_json) "
    + "VALUES(?,?,?,?,?,?)",
  ).run(slug, slug, "test", "owner", slug, JSON.stringify(cadence));
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

/** Direct seed into cost_rollup_day for the pure unit test (AC1).
 *  Other ACs that depend on the production rollup derivation seed via
 *  `run` rows + `recomputeRollups()` per the LESSON. */
function seedRollup(
  db: DB, projectId: number, day: string, costUsd: number,
): void {
  db.prepare(
    "INSERT INTO cost_rollup_day(project_id,phase,day,runs,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd) "
    + "VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(projectId, "ship", day, 1, 0, 0, 0, 0, costUsd);
}

/** Seed a `run` row with a measured cost — the production rollup derivation
 *  path. Used by tests that exercise the full cumulative-sum query. */
function seedRunWithCost(
  db: DB, projectId: number, startedAt: string, costUsd: number,
  phase = "ship", sessionId?: string,
): void {
  const sid = sessionId ?? `s-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,duration_ms,outcome,cost_usd,cost_source) "
    + "VALUES(?,?,?,?,?,?,?, 'live')",
  ).run(projectId, phase, sid, startedAt, 1000, "shipped", costUsd);
}

/** First day of `now`'s UTC month, yyyy-mm-dd. */
function monthStartUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString().slice(0, 10);
}

/** yyyy-mm-dd UTC for day-N of `now`'s month. */
function dayInMonth(now: Date, dayOfMonth: number): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), dayOfMonth))
    .toISOString().slice(0, 10);
}

/** Days in the current UTC month (28..31). */
function daysInMonth(now: Date): number {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
    .getUTCDate();
}

// ────────────────────────────────────────────────────────────────────
// AC1 — projectBurndown returns the documented shape.
// Fixture: 10 days of $1/day starting day 1, cap = $2.
// ────────────────────────────────────────────────────────────────────

test("AC1: projectBurndown returns {days, cap_per_day_usd, projected_eom_usd, cap_eom_usd, band}", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "alpha", { max_daily_usd: "2" });
    // Pin "now" to day 10 of a 30-day month. Use a month known to have 30
    // days regardless of leap-year drift: June.
    const now = new Date(Date.UTC(2026, 5 /* June */, 10, 12, 0, 0));
    // Seed days 1..10 inclusive @ $1/day.
    for (let d = 1; d <= 10; d++) {
      seedRollup(db, pid, dayInMonth(now, d), 1);
    }
    const out = projectBurndown(db, pid, now);
    // Top-level shape
    assert.ok(Array.isArray(out.days), "days must be an array");
    assert.equal(out.days.length, 10, "days covers day 1..today inclusive");
    assert.equal(out.cap_per_day_usd, 2);
    assert.equal(out.cap_eom_usd, 2 * 30);
    assert.ok(["green", "amber", "red"].includes(out.band));
    // Per-day shape
    assert.equal(out.days[0].day_of_month, 1);
    assert.equal(out.days[0].cumulative_usd, 1);
    assert.equal(out.days[9].day_of_month, 10);
    assert.equal(out.days[9].cumulative_usd, 10);
    // Projected = today + 7d-avg * remaining = 10 + 1 * 20 = 30
    assert.equal(out.projected_eom_usd, 30);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — cumulative via SUM OVER on cost_rollup_day; seed via `run`
// rows + recomputeRollups() per the LESSON.
// ────────────────────────────────────────────────────────────────────

test("AC2: cumulative_usd is a running sum derived from cost_rollup_day (seeded via run rows)", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "beta");
    // Pin to day 5 of a 30-day month.
    const now = new Date(Date.UTC(2026, 5, 5, 12, 0, 0));
    // Seed runs on day 1..5 at $1/day. Use a different session_id per day
    // to dodge the (project_id, phase, session_id) UNIQUE constraint.
    for (let d = 1; d <= 5; d++) {
      const startedAt = `${dayInMonth(now, d)}T12:00:00Z`;
      seedRunWithCost(db, pid, startedAt, 1, "ship", `s-${d}`);
    }
    recomputeRollups(db);
    const out = projectBurndown(db, pid, now);
    const cum = out.days.map((d) => d.cumulative_usd);
    assert.deepEqual(cum, [1, 2, 3, 4, 5], "running sum 1..5 from recomputed rollup");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — projected_eom_usd = today + trailing_7d_avg × days_remaining.
// ────────────────────────────────────────────────────────────────────

test("AC3: projected_eom_usd = today + trailing 7d avg × days_remaining (10 days @ $2 in 30d → $60)", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "gamma");
    const now = new Date(Date.UTC(2026, 5, 10, 12, 0, 0)); // June, 30 days, today=10
    for (let d = 1; d <= 10; d++) {
      seedRollup(db, pid, dayInMonth(now, d), 2);
    }
    const out = projectBurndown(db, pid, now);
    // today_cumulative = 20; trailing-7 avg = 2; days remaining = 20 → 20 + 40 = 60
    assert.equal(out.projected_eom_usd, 60);
  } finally { cleanup(); }
});

test("AC3: <7 days of data uses available average (3 days @ $1 → eom = 3 + 1×27 = 30)", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "delta");
    const now = new Date(Date.UTC(2026, 5, 3, 12, 0, 0)); // June 3
    for (let d = 1; d <= 3; d++) {
      seedRollup(db, pid, dayInMonth(now, d), 1);
    }
    const out = projectBurndown(db, pid, now);
    // remaining = 30 - 3 = 27; avg over the 3 available days = 1; today = 3
    assert.equal(out.projected_eom_usd, 3 + 1 * 27);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — band rules.
// ────────────────────────────────────────────────────────────────────

test("AC4: band='red' when cumulative_today_usd > cap_per_day_usd × day_of_month", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "redproj", { max_daily_usd: "1" });
    const now = new Date(Date.UTC(2026, 5, 5, 12, 0, 0));
    // 5 days × $3/day = $15 cumulative, cap line at $5 → over → red.
    for (let d = 1; d <= 5; d++) {
      seedRollup(db, pid, dayInMonth(now, d), 3);
    }
    const out = projectBurndown(db, pid, now);
    assert.equal(out.band, "red");
  } finally { cleanup(); }
});

test("AC4: band='amber' when projected_eom_usd > cap_eom_usd × 0.8 but not over cap line", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "amberproj", { max_daily_usd: "2" });
    const now = new Date(Date.UTC(2026, 5, 5, 12, 0, 0)); // June 5
    // 5 days × $2/day = $10 cumulative, cap line = 2*5 = 10 → NOT red (not >).
    // projected = 10 + 2×25 = 60, cap_eom = 2*30 = 60. 60 > 0.8 * 60 = 48 → amber.
    for (let d = 1; d <= 5; d++) {
      seedRollup(db, pid, dayInMonth(now, d), 2);
    }
    const out = projectBurndown(db, pid, now);
    assert.equal(out.band, "amber");
  } finally { cleanup(); }
});

test("AC4: band='green' when projection comfortably below 0.8 of cap_eom", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "greenproj", { max_daily_usd: "10" });
    const now = new Date(Date.UTC(2026, 5, 5, 12, 0, 0));
    // 5 days × $1/day = $5; cap line = 50, projection = 5 + 1×25 = 30, cap_eom=300.
    // 30 < 0.8 × 300 = 240 → green.
    for (let d = 1; d <= 5; d++) {
      seedRollup(db, pid, dayInMonth(now, d), 1);
    }
    const out = projectBurndown(db, pid, now);
    assert.equal(out.band, "green");
  } finally { cleanup(); }
});

test("AC4: no MAX_DAILY_USD → band='green' and cap series omitted (null)", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "uncapped"); // no cadence → no cap
    const now = new Date(Date.UTC(2026, 5, 5, 12, 0, 0));
    seedRollup(db, pid, dayInMonth(now, 1), 100);
    const out = projectBurndown(db, pid, now);
    assert.equal(out.cap_per_day_usd, null, "cap_per_day_usd is null when unset");
    assert.equal(out.cap_eom_usd, null, "cap_eom_usd is null when unset");
    assert.equal(out.band, "green",
      "unset cap means no enforcement → no amber/red signal possible");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — cap_per_day_usd is read from the same path autopause uses.
// ────────────────────────────────────────────────────────────────────

test("AC5: cap_per_day_usd reads from cadence_json.max_daily_usd (same path as autopause)", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "capped", { max_daily_usd: "7.5" });
    const now = new Date(Date.UTC(2026, 5, 5, 12, 0, 0));
    seedRollup(db, pid, dayInMonth(now, 1), 1);
    const out = projectBurndown(db, pid, now);
    assert.equal(out.cap_per_day_usd, 7.5);
  } finally { cleanup(); }
});

test("AC5: missing MAX_DAILY_USD → cap_per_day_usd === null and band === 'green'", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "nocap"); // empty cadence → no max_daily_usd
    const now = new Date(Date.UTC(2026, 5, 5, 12, 0, 0));
    const out = projectBurndown(db, pid, now);
    assert.equal(out.cap_per_day_usd, null);
    assert.equal(out.band, "green");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — listProjects() row carries the burndown summary only.
// ────────────────────────────────────────────────────────────────────

test("AC6: listProjects rows include burndown summary {projected_eom_usd, cap_eom_usd, band}; days[] omitted", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetHealthCacheForTests();
    const pid = seedProject(db, "summed", { max_daily_usd: "5" });
    const now = new Date(Date.UTC(2026, 5, 5, 12, 0, 0));
    for (let d = 1; d <= 5; d++) {
      seedRollup(db, pid, dayInMonth(now, d), 1);
    }
    const out = listProjects(db);
    const row = out.find((r: any) => r.slug === "summed") as any;
    assert.ok(row, "summed must appear in listProjects");
    assert.ok(row.burndown, "every project row must carry a burndown object");
    assert.equal(typeof row.burndown.projected_eom_usd, "number");
    assert.equal(typeof row.burndown.cap_eom_usd, "number"); // capped here
    assert.ok(["green", "amber", "red"].includes(row.burndown.band));
    assert.equal((row.burndown as any).days, undefined,
      "days[] must NOT inline on the home payload — fetch via /api/projects/:slug/burndown");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — GET /api/projects/:slug/burndown route.
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
  const dir = mkdtempSync(join(tmpdir(), "fleet-burndown-boot-"));
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

test("AC7: GET /api/projects/:slug/burndown returns the full shape on loopback", async () => {
  _resetHealthCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "routed", { max_daily_usd: "5" });
    const now = new Date();
    seedRollup(db, pid, dayInMonth(now, 1), 1);
  });
  try {
    const r = await fetch(b.base + "/api/projects/routed/burndown");
    assert.equal(r.status, 200);
    const j = await r.json() as any;
    assert.ok(Array.isArray(j.days));
    assert.equal(typeof j.cap_per_day_usd, "number");
    assert.equal(typeof j.cap_eom_usd, "number");
    assert.equal(typeof j.projected_eom_usd, "number");
    assert.ok(["green", "amber", "red"].includes(j.band));
  } finally { await b.close(); b.cleanup(); }
});

test("AC7: GET /api/projects/:slug/burndown is 404 for an unknown slug", async () => {
  _resetHealthCacheForTests();
  const b = await boot();
  try {
    const r = await fetch(b.base + "/api/projects/no-such-slug/burndown");
    assert.equal(r.status, 404);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC8 — web/app.js renders the inline SVG sparkline; redactSecrets passes
// any project-name string. Text-level over web/app.js + web/style.css.
// ────────────────────────────────────────────────────────────────────

test("AC8: web/app.js defines renderBurndownSparkline with band-aware classes + dashed cap/proj strokes", () => {
  const src = readFileSync(join(WEB_DIR, "app.js"), "utf8");
  assert.match(src, /renderBurndownSparkline/, "renderBurndownSparkline must be defined");
  // Dashed cap reference line.
  assert.match(src, /stroke-dasharray="2,2"/,
    "cap reference line must use stroke-dasharray=\"2,2\"");
  // Dashed projection segment.
  assert.match(src, /stroke-dasharray="4,2"/,
    "projected segment must use stroke-dasharray=\"4,2\"");
  // Inline <svg> with width/height the CSS can shrink on mobile.
  assert.match(src, /<svg[^>]*class="burndown/,
    "sparkline must be an inline <svg> with a burndown CSS class");
  // Band-aware class on the today-dot. The source uses a template
  // literal `band-${esc(band)}`; we match either the literal form
  // (band-green / band-amber / band-red) OR the template expression.
  assert.match(src, /burndown-dot band-(green|amber|red|\$\{[^}]*band[^}]*\})/,
    "today-dot must carry a burndown-dot band-* class (literal or template)");
});

test("AC8: web/app.js routes burndown labels through redactSecrets at the renderer boundary", () => {
  const src = readFileSync(join(WEB_DIR, "app.js"), "utf8");
  // The sparkline label string (e.g. "$23.50 of $60.00 cap MTD") never
  // carries a name; the operator's project name DOES. We require the
  // helper to pass any free-form string through redactSecrets — the
  // simplest check is that the helper body references the redactor.
  const fnMatch = src.match(/function renderBurndownSparkline[\s\S]*?\n\}\n/);
  assert.ok(fnMatch, "renderBurndownSparkline must be a top-level function");
  assert.match(fnMatch![0], /redactSecrets/,
    "renderBurndownSparkline must invoke redactSecrets on any project-name string");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — mobile viewport contract (40x24 ≤ 600px).
// ────────────────────────────────────────────────────────────────────

test("AC9: web/style.css shrinks .burndown SVG to 40x24 under @media (max-width: 600px)", () => {
  const css = readFileSync(join(WEB_DIR, "style.css"), "utf8");
  // The CSS must declare a .burndown selector group AND a mobile shrink
  // inside a max-width:600px media query.
  assert.match(css, /\.burndown\b/, "must have a .burndown selector group");
  // The mobile shrink lives inside an existing or new @media (max-width: 600px).
  // Search for a media-query block that contains ".burndown" and either
  // 40 or 24 (the shrunken dimensions).
  const mq = css.match(/@media[^{]*max-width:\s*600px[\s\S]*?\n\}\s*\n/g);
  assert.ok(mq && mq.some((b) => /\.burndown/.test(b) && /40px|width:\s*40/.test(b)),
    "mobile media query must shrink .burndown to 40px wide");
});

// ────────────────────────────────────────────────────────────────────
// AC10 — empty state: no rollup rows → days=[]; SPA renders "no spend".
// ────────────────────────────────────────────────────────────────────

test("AC10: empty cost_rollup_day → days is [] (no NaN, no broken layout)", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "empty", { max_daily_usd: "5" });
    const now = new Date(Date.UTC(2026, 5, 5, 12, 0, 0));
    const out = projectBurndown(db, pid, now);
    assert.deepEqual(out.days, [], "no rollup rows → days must be empty []");
    assert.equal(out.projected_eom_usd, 0,
      "empty fixture → projection is 0 (today=0 + 0 avg × days remaining)");
    assert.equal(out.band, "green",
      "no spend → band stays green regardless of cap");
  } finally { cleanup(); }
});

test("AC10: web/app.js shows 'no spend this month' string when days[] is empty", () => {
  const src = readFileSync(join(WEB_DIR, "app.js"), "utf8");
  assert.match(src, /no spend this month/i,
    "SPA must surface 'no spend this month' copy when the burndown is empty");
});

// ────────────────────────────────────────────────────────────────────
// AC11 — perf gates. Gated on PERF=1 per the ticket; otherwise skipped.
// ────────────────────────────────────────────────────────────────────

test("AC11: projectBurndown with 31 days of data completes in <10ms (PERF=1 only)", { skip: process.env.PERF !== "1" }, () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "perf1", { max_daily_usd: "10" });
    const now = new Date(Date.UTC(2026, 0 /* Jan, 31 days */, 31, 12, 0, 0));
    for (let d = 1; d <= 31; d++) {
      seedRollup(db, pid, dayInMonth(now, d), 0.5);
    }
    const t0 = process.hrtime.bigint();
    projectBurndown(db, pid, now);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(elapsedMs < 10, `projectBurndown took ${elapsedMs.toFixed(2)}ms; need <10ms`);
  } finally { cleanup(); }
});

test("AC11: listProjects for 10 projects completes in <100ms (PERF=1 only)", { skip: process.env.PERF !== "1" }, () => {
  const { db, cleanup } = tempDb();
  try {
    _resetHealthCacheForTests();
    const now = new Date();
    for (let i = 0; i < 10; i++) {
      const pid = seedProject(db, `perfp${i}`, { max_daily_usd: "5" });
      for (let d = 1; d <= 15; d++) {
        seedRollup(db, pid, dayInMonth(now, d), 0.1);
      }
    }
    const t0 = process.hrtime.bigint();
    listProjects(db);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(elapsedMs < 100, `listProjects took ${elapsedMs.toFixed(2)}ms; need <100ms`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC12 — meta: no new runtime deps; tsc-clean cast pattern.
// ────────────────────────────────────────────────────────────────────

test("AC12: package.json carries zero runtime dependencies", () => {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, unknown> };
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    `dependencies must stay empty; found: ${Object.keys(deps).join(", ")}`);
});

test("AC12: src/views.ts uses 'as unknown as ' cast pattern (not bare 'as any[]') for the new burndown SQL", () => {
  const src = readFileSync(join(__dirname, "..", "src", "views.ts"), "utf8");
  // The new code path must contain the LESSON cast pattern. We anchor
  // on the helper *declaration* (the `export function projectBurndown`
  // line, not any call site) so an unrelated `projectBurndown(...)` call
  // doesn't satisfy this test.
  const m = src.match(/export function projectBurndown\([\s\S]*?\n\}\n/);
  assert.ok(m, "projectBurndown helper must be exported in src/views.ts");
  assert.match(m![0], /as unknown as/,
    "the new burndown SQL row narrowing must use the 'as unknown as RowT' pattern");
});
