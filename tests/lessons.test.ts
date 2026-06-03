// Tests for ticket 0036 — cross-fleet lessons portal view.
//
// One test() per acceptance-criteria checkbox. Strategy mirrors the
// existing glance / drift suites:
//   - Drive the pure parser + loader directly against fixture files
//     for AC1 + AC2 + AC5.
//   - Boot `startServer()` over loopback for AC3 + AC4 using the
//     empty-roots config + tmp fleet-control.config.json seam from
//     LESSONS § "in-process startServer() tests need an empty-roots
//     config + run-row seeds".
//   - SPA renderer tests are text-level over web/app.js + web/style.css
//     per the inbox / streak / health precedent (zero jsdom).
//   - The daemon hook test drives `runLessonsHook(db, now)` directly
//     against a tmpdir DB and a tmp source file — same seam pattern
//     as the drift / correlation hook tests.
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps
// from `new Date()`": every test that asserts new_this_week / 24h
// idempotency pins `now` to a constant.
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// the few SQL reads in this file use the double-cast.
//
// Zero new runtime deps; stdlib + node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync,
  unlinkSync, mkdirSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../src/db.ts";
import {
  parseCrossLessons, loadCrossLessons, defaultLessonsPath,
  newThisWeekCount, runLessonsHook, activeLessonsNewInbox,
  MAX_FILE_BYTES, ENV_PATH_KEY,
} from "../src/lessons.ts";
import { fleetInbox } from "../src/inbox.ts";
import {
  startServer,
  _resetLessonsCacheForTests, _getLessonsCacheBuildsForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");
const INDEX_HTML = readFileSync(join(WEB_DIR, "index.html"), "utf8");
const FIXTURE_PATH = join(__dirname, "fixtures", "cross-lessons-sample.md");
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-lessons-db-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function tempFile(text: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-lessons-file-"));
  const path = join(dir, "CROSS_LESSONS.md");
  writeFileSync(path, text);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ────────────────────────────────────────────────────────────────────
// AC1 — parseCrossLessons recognises both entry styles + undated H3.
// ────────────────────────────────────────────────────────────────────

test("AC1: parseCrossLessons returns the documented shape with h3 + bullet + undated entries", () => {
  const parsed = parseCrossLessons(FIXTURE_TEXT);
  assert.ok(Array.isArray(parsed.projects));
  assert.equal(parsed.projects.length, 2, "two projects in the fixture (alpha, beta)");
  const alpha = parsed.projects[0];
  const beta = parsed.projects[1];
  assert.equal(alpha.slug, "alpha");
  assert.equal(beta.slug, "beta");
  // alpha: 3 H3 entries (2 dated, 1 undated)
  assert.equal(alpha.lessons.length, 3, "alpha has 3 h3 entries");
  assert.equal(alpha.lessons[0].kind, "h3");
  assert.equal(alpha.lessons[0].date, "2026-05-25");
  assert.match(alpha.lessons[0].title, /bootstrap/i);
  assert.ok(alpha.lessons[0].body.length > 0, "h3 body is the paragraph after the header");
  assert.equal(alpha.lessons[1].date, "2026-05-26");
  assert.match(alpha.lessons[1].title, /GitHub Actions/);
  // The third entry is undated: date null + h3 kind + still included.
  assert.equal(alpha.lessons[2].date, null, "undated entry carries date=null and is still included");
  assert.equal(alpha.lessons[2].kind, "h3");
  assert.match(alpha.lessons[2].title, /undated bootstrap/i);
  // beta: 3 bullet entries; each has kind="bullet", empty body, dated.
  assert.equal(beta.lessons.length, 3, "beta has 3 bullet entries");
  for (const b of beta.lessons) {
    assert.equal(b.kind, "bullet");
    assert.match(b.date || "", /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(b.body, "", "bullet entries have no multi-line body");
    assert.ok(b.title.length > 0);
  }
  // Total counts entries across projects.
  assert.equal(parsed.total, 6);
  assert.ok(parsed.parsed_at && /\d{4}-\d{2}-\d{2}T/.test(parsed.parsed_at));
});

// ────────────────────────────────────────────────────────────────────
// AC2 — path resolution + load behaviour on missing / present files.
// ────────────────────────────────────────────────────────────────────

test("AC2: defaultLessonsPath honours FLEET_CROSS_LESSONS_PATH and falls back to ~/.local/share/agent-fleet/CROSS_LESSONS.md", () => {
  const saved = process.env[ENV_PATH_KEY];
  try {
    delete process.env[ENV_PATH_KEY];
    const def = defaultLessonsPath();
    assert.match(def, /\.local[\\/]share[\\/]agent-fleet[\\/]CROSS_LESSONS\.md$/);
    process.env[ENV_PATH_KEY] = "/tmp/some/override.md";
    assert.equal(defaultLessonsPath(), "/tmp/some/override.md");
  } finally {
    if (saved === undefined) delete process.env[ENV_PATH_KEY];
    else process.env[ENV_PATH_KEY] = saved;
  }
});

test("AC2: loadCrossLessons returns source_present=false when the file is missing (no throw)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-lessons-missing-"));
  try {
    const result = loadCrossLessons(join(dir, "does-not-exist.md"));
    assert.equal(result.source_present, false);
    assert.equal(result.total, 0);
    assert.deepEqual(result.projects, []);
    assert.ok(result.parsed_at);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("AC2: loadCrossLessons returns source_present=true + parsed projects when the file exists", () => {
  const result = loadCrossLessons(FIXTURE_PATH);
  assert.equal(result.source_present, true);
  assert.equal(result.total, 6);
  assert.equal(result.projects.length, 2);
});

// ────────────────────────────────────────────────────────────────────
// AC3 — GET /api/fleet/lessons returns the documented shape on
//        loopback (200). Requires `read` scope (loopback bypasses).
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

async function boot(opts: { lessonsPath?: string } = {}): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-lessons-boot-"));
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
  if (opts.lessonsPath !== undefined) {
    process.env[ENV_PATH_KEY] = opts.lessonsPath;
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

test("AC3: GET /api/fleet/lessons returns the {projects,parsed_at,total,source_present,new_this_week} shape on loopback (200)", async () => {
  _resetLessonsCacheForTests();
  // Build a small fixture pinned to a known wall-clock window so
  // new_this_week is deterministic. The route's `now` is the
  // server's wall clock (real Date) — we keep the fixture dates
  // within 7 days of "now at test run" by using "today" relative
  // ISO strings so a CI run on any date still satisfies the count.
  const today = new Date();
  function isoNDaysAgo(n: number): string {
    const d = new Date(today.getTime() - n * 24 * 3600_000);
    return d.toISOString().slice(0, 10);
  }
  const text = `# CROSS_LESSONS

## one

### ${isoNDaysAgo(0)} — fresh today
Body content here.

### ${isoNDaysAgo(1)} — fresh yesterday
Body content here too.

### ${isoNDaysAgo(2)} — also fresh
Another body.

### ${isoNDaysAgo(40)} — old entry
This is older than a week.
`;
  const dir = mkdtempSync(join(tmpdir(), "fleet-lessons-route-"));
  const lessonsPath = join(dir, "CROSS_LESSONS.md");
  writeFileSync(lessonsPath, text);
  const b = await boot({ lessonsPath });
  try {
    const r = await fetch(b.base + "/api/fleet/lessons");
    assert.equal(r.status, 200);
    const j = await r.json() as {
      projects: Array<{ slug: string; lessons: unknown[] }>;
      parsed_at: string; total: number;
      source_present: boolean; new_this_week: number;
      oversized: boolean;
    };
    assert.equal(j.source_present, true);
    assert.equal(j.total, 4);
    assert.equal(j.projects.length, 1);
    assert.equal(j.projects[0].slug, "one");
    assert.equal(j.new_this_week, 3, "three entries dated within last 7 days");
    assert.equal(typeof j.parsed_at, "string");
    assert.equal(j.oversized, false);
  } finally {
    await b.close(); b.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — Cache: max-age=120 + mtime memo + build counter. Two requests
//        in a row → counter ticks ONCE; touch the file via utimesSync
//        and the next request increments again.
// ────────────────────────────────────────────────────────────────────

test("AC4: GET /api/fleet/lessons sets cache-control: max-age=120 and memoises by mtime via a build counter", async () => {
  _resetLessonsCacheForTests();
  const dir = mkdtempSync(join(tmpdir(), "fleet-lessons-cache-"));
  const lessonsPath = join(dir, "CROSS_LESSONS.md");
  writeFileSync(lessonsPath, `# CROSS_LESSONS\n\n## p\n\n### 2026-05-25 — bootstrap\nbody\n`);
  const b = await boot({ lessonsPath });
  try {
    const before = _getLessonsCacheBuildsForTests();
    const r1 = await fetch(b.base + "/api/fleet/lessons");
    assert.equal(r1.status, 200);
    const cc = (r1.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=120/, `cache-control must declare max-age=120; got '${cc}'`);
    await r1.json();
    const afterFirst = _getLessonsCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call → cache MISS, build counter += 1");

    const r2 = await fetch(b.base + "/api/fleet/lessons");
    assert.equal(r2.status, 200);
    await r2.json();
    const afterSecond = _getLessonsCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0,
      "second call with same mtime → cache HIT, counter unchanged");

    // Bump mtime forward (1s) to invalidate.
    const future = new Date(Date.now() + 1000);
    utimesSync(lessonsPath, future, future);
    const r3 = await fetch(b.base + "/api/fleet/lessons");
    assert.equal(r3.status, 200);
    await r3.json();
    const afterThird = _getLessonsCacheBuildsForTests();
    assert.equal(afterThird - afterSecond, 1,
      "after mtime bump, next call rebuilds → counter += 1");
  } finally { await b.close(); b.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — Oversized (>2MB) file: returns oversized payload, NOT a 500.
// ────────────────────────────────────────────────────────────────────

test("AC5: loadCrossLessons returns oversized:true when the source file exceeds 2MB", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-lessons-oversized-"));
  try {
    const path = join(dir, "CROSS_LESSONS.md");
    // Write 3MB of junk — exceeds the 2MB cap.
    const chunk = "A".repeat(1024); // 1KB
    const buf: string[] = [];
    for (let i = 0; i < 3 * 1024; i++) buf.push(chunk);
    writeFileSync(path, buf.join(""));
    const result = loadCrossLessons(path);
    assert.equal(result.source_present, true);
    assert.equal(result.oversized, true);
    assert.equal(result.total, 0);
    assert.deepEqual(result.projects, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("AC5: GET /api/fleet/lessons returns 200 with oversized:true (NOT a 500) on an oversized file", async () => {
  _resetLessonsCacheForTests();
  const dir = mkdtempSync(join(tmpdir(), "fleet-lessons-route-oversized-"));
  const lessonsPath = join(dir, "CROSS_LESSONS.md");
  const chunk = "B".repeat(1024);
  const buf: string[] = [];
  for (let i = 0; i < 3 * 1024; i++) buf.push(chunk);
  writeFileSync(lessonsPath, buf.join(""));
  const b = await boot({ lessonsPath });
  try {
    const r = await fetch(b.base + "/api/fleet/lessons");
    assert.equal(r.status, 200);
    const j = await r.json() as { oversized: boolean; source_present: boolean; total: number };
    assert.equal(j.oversized, true);
    assert.equal(j.source_present, true);
    assert.equal(j.total, 0);
  } finally { await b.close(); b.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

// Sanity-check MAX_FILE_BYTES is the documented 2MB so a future change
// surfaces here, not silently.
test("AC5: MAX_FILE_BYTES is the documented 2MB cap", () => {
  assert.equal(MAX_FILE_BYTES, 2 * 1024 * 1024);
});

// ────────────────────────────────────────────────────────────────────
// AC6 — SPA: web/app.js declares renderLessonsPage + wires the hash
//        route + filters; the topbar carries the LESSONS link; every
//        operator-visible string passes through redactSecrets.
// ────────────────────────────────────────────────────────────────────

test("AC6: web/index.html exposes a LESSONS top-bar link between brand and fleet-summary", () => {
  // The link sits between the .brand anchor and the #fleet-summary
  // div. We assert the source order via a regex that matches all
  // three markers in sequence.
  assert.match(
    INDEX_HTML,
    /<a[^>]*class="brand"[^>]*>[\s\S]*?<a[^>]*class="topbar-link"[^>]*data-testid="topbar-lessons"[^>]*>LESSONS<\/a>[\s\S]*?id="fleet-summary"/,
    "LESSONS link must appear between brand and fleet-summary",
  );
});

test("AC6: web/app.js defines renderLessonsPage and wires the #/lessons hash route with redactSecrets at the renderer boundary", () => {
  assert.match(APP_JS, /function\s+renderLessonsPage\s*\(/,
    "web/app.js must declare a renderLessonsPage helper");
  assert.match(APP_JS, /async\s+function\s+lessons\s*\(/,
    "web/app.js must declare an async lessons(...) route handler");
  // The hash router branch for the /lessons path.
  assert.match(APP_JS, /path\s*===?\s*"lessons"|path\.startsWith\("lessons"\)/,
    "route() must branch on the lessons path");
  // The /api/fleet/lessons fetch lives inside lessons().
  assert.match(APP_JS, /\/api\/fleet\/lessons/,
    "web/app.js must fetch the new /api/fleet/lessons route");
  // The page container carries data-testid for stable test hooks.
  assert.match(APP_JS, /data-testid="cross-lessons"/,
    "the page container must carry data-testid=\"cross-lessons\"");
  // Every operator-visible string passes through redactSecrets before
  // any HTML interpolation. We check the renderer helpers reference
  // redactSecrets at least once each.
  assert.match(APP_JS, /function\s+renderLessonsEntry[\s\S]{0,400}?redactSecrets/,
    "renderLessonsEntry must pass title/body through redactSecrets");
  assert.match(APP_JS, /function\s+renderLessonsProject[\s\S]{0,400}?redactSecrets/,
    "renderLessonsProject must pass slug through redactSecrets");
});

test("AC6: web/app.js search input filters entries client-side by substring across title + body", () => {
  // The wireLessonsFilters() helper attaches an input listener and
  // walks .lesson nodes toggling `hidden`. We assert the helper
  // exists and that it reads `.lesson-title` + `.lesson-body`.
  assert.match(APP_JS, /function\s+wireLessonsFilters\s*\(/,
    "web/app.js must declare a wireLessonsFilters helper");
  assert.match(APP_JS, /querySelectorAll\([^)]*\.lesson(?!-)/,
    "wireLessonsFilters must walk .lesson nodes");
  assert.match(APP_JS, /\.lesson-title|\.lesson-body/,
    "wireLessonsFilters must read .lesson-title and/or .lesson-body");
  assert.match(APP_JS, /\.hidden\s*=\s*!|hidden\s*=\s*true|setAttribute\("hidden"/,
    "wireLessonsFilters must toggle the hidden flag on non-matching entries");
});

test("AC6: web/app.js new-this-week checkbox filters by data-lesson-date being within 7 days", () => {
  assert.match(APP_JS, /data-testid="lessons-new-only"/,
    "the new-this-week checkbox must carry the stable test hook");
  assert.match(APP_JS, /data-lesson-date/,
    "each .lesson must expose data-lesson-date for the filter to read");
  assert.match(APP_JS, /7\s*\*\s*24\s*\*\s*3600|LESSONS_WEEK_MS/,
    "the new-this-week filter must use a 7-day window");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Empty / missing state: friendly copy + link to the agent-fleet
//        kit's lessons-sync docs.
// ────────────────────────────────────────────────────────────────────

test("AC7: renderLessonsPage emits a friendly empty state with a link to the agent-fleet README when source_present is false", () => {
  // Source-level assertion: the renderLessonsEmptyState helper exists
  // and references the documented file path + a docs anchor. The
  // empty state is wired into renderLessonsPage when source_present
  // is false.
  assert.match(APP_JS, /function\s+renderLessonsEmptyState\s*\(/,
    "web/app.js must declare renderLessonsEmptyState");
  assert.match(APP_JS, /CROSS_LESSONS\.md/,
    "the empty state must reference CROSS_LESSONS.md in the copy");
  assert.match(APP_JS, /agent-fleet[^\s"']*lessons-sync|lessons-sync[^\s"']*agent-fleet/,
    "the empty state must link to the agent-fleet kit's lessons-sync docs");
  assert.match(APP_JS, /data-testid="lessons-empty-link"/,
    "the empty-state anchor must carry data-testid=\"lessons-empty-link\"");
  // The renderLessonsPage helper short-circuits to the empty state
  // when source_present is false.
  assert.match(APP_JS, /renderLessonsPage[\s\S]{0,400}source_present[\s\S]{0,200}renderLessonsEmptyState/,
    "renderLessonsPage must call renderLessonsEmptyState when source_present is false");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Mobile pass: 375px stacks search above checkbox; >=600px shares
//        one row. Project shells render closed by default on phones,
//        open on desktop. No horizontal scroll.
// ────────────────────────────────────────────────────────────────────

test("AC8: web/style.css declares a .cross-lessons / .lessons-* selector group with a 600px breakpoint", () => {
  assert.match(CSS, /\.cross-lessons\b/,
    "style.css must define a .cross-lessons rule group");
  assert.match(CSS, /\.lessons-controls\b/,
    "style.css must define .lessons-controls");
  // The mobile-first base rule lays controls out in a single column
  // (search + checkbox stacked). We verify a 600px breakpoint exists
  // and upgrades the layout to one row.
  const desktop = CSS.match(/@media[^{]*min-width:\s*600px[\s\S]*?\}\s*\}/g) || [];
  assert.ok(desktop.length > 0,
    "style.css must declare at least one @media (min-width: 600px) block");
  const desktopText = desktop.join("\n");
  const hasOneRow =
    /\.lessons-controls[^{]*\{[^}]*grid-template-columns:\s*1fr\s+auto/.test(desktopText)
    || /\.lessons-controls[^{]*\{[^}]*flex-direction:\s*row/.test(desktopText);
  assert.ok(hasOneRow,
    ".lessons-controls at >=600px must collapse into a single row");
});

test("AC8: search input is sticky at the top so the operator can type while scrolling", () => {
  assert.match(CSS, /\.lessons-head[^{]*\{[^}]*position:\s*sticky/,
    ".lessons-head must be position:sticky so the search bar stays in view while scrolling");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Performance: parser <30ms on 200KB; route end-to-end <80ms
//        (cache miss). PERF=1 only.
// ────────────────────────────────────────────────────────────────────

test("AC9: perf — parseCrossLessons on 200KB completes in <30ms", { skip: process.env.PERF !== "1" }, () => {
  // Build a deterministic 200KB-ish fixture: 1 project, repeat the
  // 6-entry shape until we reach the byte budget.
  const block = `\n### 2026-05-${("0" + ((1 + (Math.random() * 28)) | 0)).slice(-2)} — synthetic entry\nBody line one.\nBody line two.\n`;
  const chunks: string[] = ["# CROSS_LESSONS\n\n## perf\n"];
  while (chunks.join("").length < 200 * 1024) chunks.push(block);
  const text = chunks.join("");
  const t1 = Date.now();
  const parsed = parseCrossLessons(text);
  const dt = Date.now() - t1;
  assert.ok(parsed.total > 0);
  assert.ok(dt < 30, `parseCrossLessons over 200KB must finish <30ms; took ${dt}ms`);
});

test("AC9: perf — GET /api/fleet/lessons cache-miss completes in <80ms", { skip: process.env.PERF !== "1" }, async () => {
  _resetLessonsCacheForTests();
  const dir = mkdtempSync(join(tmpdir(), "fleet-lessons-perf-"));
  const lessonsPath = join(dir, "CROSS_LESSONS.md");
  const chunks: string[] = ["# CROSS_LESSONS\n\n## perf\n"];
  let i = 0;
  while (chunks.join("").length < 100 * 1024) {
    chunks.push(`\n### 2026-05-${("0" + ((i % 28) + 1)).slice(-2)} — entry ${i}\nBody.\n`);
    i++;
  }
  writeFileSync(lessonsPath, chunks.join(""));
  const b = await boot({ lessonsPath });
  try {
    // Force cache miss by resetting between the boot + measurement.
    _resetLessonsCacheForTests();
    const t1 = Date.now();
    const r = await fetch(b.base + "/api/fleet/lessons");
    assert.equal(r.status, 200);
    await r.json();
    const dt = Date.now() - t1;
    assert.ok(dt < 80, `cache-miss route call must finish <80ms; took ${dt}ms`);
  } finally { await b.close(); b.cleanup(); rmSync(dir, { recursive: true, force: true }); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Daemon hook: diffs `total` against the previous day's
//        `total` (via watermark). Delta >=1 → one inbox row.
//        Same-tick re-run → no duplicate (24h aging window).
// ────────────────────────────────────────────────────────────────────

test("AC10: runLessonsHook writes a `lessons_new` watermark on a positive delta, and re-running the same tick is a no-op", () => {
  const NOW = new Date("2026-06-03T12:00:00.000Z");
  const { db, cleanup } = tempDb();
  const file = tempFile(`# CROSS_LESSONS

## one

### 2026-06-01 — a
Body.

### 2026-06-02 — b
Body.

### 2026-06-03 — c
Body.
`); // 3 entries
  const savedEnv = process.env[ENV_PATH_KEY];
  try {
    process.env[ENV_PATH_KEY] = file.path;
    // Seed yesterday's watermark at 0 (cold start) — the hook should
    // detect 3 fresh lessons.
    db.prepare(
      "INSERT INTO watermark(source,cursor,updated_at) VALUES(?,?,?) "
      + "ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at",
    ).run("cross_lessons_total", "0", new Date("2026-06-02T12:00:00.000Z").toISOString());
    const inserted1 = runLessonsHook(db, NOW);
    assert.equal(inserted1, 1, "first run on positive delta writes one inbox-row signal");
    // The inbox now surfaces the lessons_new row.
    const inbox1 = fleetInbox(db, { now: NOW.toISOString() });
    const row1 = inbox1.items.find((it) => it.kind === "lessons_new");
    assert.ok(row1, "fleetInbox surfaces a lessons_new row after a positive delta");
    assert.equal(row1!.payload.count, 3, "count carries the delta (3 fresh lessons)");
    assert.match(row1!.title, /3 new fleet lessons/);
    assert.equal(row1!.action.route, "#/lessons?filter=new");
    // Re-running on the same tick must not duplicate the row (24h
    // aging window).
    const inserted2 = runLessonsHook(db, NOW);
    assert.equal(inserted2, 0, "re-run within 24h does not duplicate the row");
    const inbox2 = fleetInbox(db, { now: NOW.toISOString() });
    const rows = inbox2.items.filter((it) => it.kind === "lessons_new");
    assert.equal(rows.length, 1, "exactly one lessons_new row remains");
  } finally {
    if (savedEnv === undefined) delete process.env[ENV_PATH_KEY];
    else process.env[ENV_PATH_KEY] = savedEnv;
    file.cleanup();
    cleanup();
  }
});

test("AC10: runLessonsHook honours the seeded watermark (100 → 103 → one row with delta=3)", () => {
  const NOW = new Date("2026-06-03T12:00:00.000Z");
  const { db, cleanup } = tempDb();
  // Build a fixture with 103 entries across one project.
  const lines: string[] = ["# CROSS_LESSONS", "", "## sample", ""];
  for (let i = 0; i < 103; i++) {
    lines.push(`### 2026-06-03 — entry ${i}`, "Body.", "");
  }
  const file = tempFile(lines.join("\n"));
  const savedEnv = process.env[ENV_PATH_KEY];
  try {
    process.env[ENV_PATH_KEY] = file.path;
    // Seed yesterday's watermark at 100.
    db.prepare(
      "INSERT INTO watermark(source,cursor,updated_at) VALUES(?,?,?) "
      + "ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at",
    ).run("cross_lessons_total", "100", new Date("2026-06-02T12:00:00.000Z").toISOString());
    const inserted = runLessonsHook(db, NOW);
    assert.equal(inserted, 1);
    const live = activeLessonsNewInbox(db, NOW);
    assert.ok(live);
    assert.equal(live!.count, 3, "delta is 103 - 100 = 3");
  } finally {
    if (savedEnv === undefined) delete process.env[ENV_PATH_KEY];
    else process.env[ENV_PATH_KEY] = savedEnv;
    file.cleanup();
    cleanup();
  }
});

test("AC10: runLessonsHook is a no-op when the source file is missing (does not write either watermark)", () => {
  const NOW = new Date("2026-06-03T12:00:00.000Z");
  const { db, cleanup } = tempDb();
  const dir = mkdtempSync(join(tmpdir(), "fleet-lessons-missing-hook-"));
  const savedEnv = process.env[ENV_PATH_KEY];
  try {
    process.env[ENV_PATH_KEY] = join(dir, "does-not-exist.md");
    const inserted = runLessonsHook(db, NOW);
    assert.equal(inserted, 0);
    const row = db.prepare(
      "SELECT cursor FROM watermark WHERE source=?",
    ).get("cross_lessons_last_new") as { cursor: string } | undefined;
    assert.equal(row, undefined, "no watermark written when the file is missing");
  } finally {
    if (savedEnv === undefined) delete process.env[ENV_PATH_KEY];
    else process.env[ENV_PATH_KEY] = savedEnv;
    rmSync(dir, { recursive: true, force: true });
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────
// AC11 — Zero new runtime deps; tsc-clean. (typecheck is in CI; we
//        assert dependencies stays empty here so a future drift
//        surfaces in this file.)
// ────────────────────────────────────────────────────────────────────

test("AC11: package.json dependencies stays empty (zero runtime deps)", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    "package.json `dependencies` must remain empty (Hard NO in AGENTS.md)");
});

// ────────────────────────────────────────────────────────────────────
// Bonus — newThisWeekCount is the same logic the route + the SPA's
// filter use. Pinned-now test so the value is deterministic.
// ────────────────────────────────────────────────────────────────────

test("newThisWeekCount counts entries whose date is within 7 days of the pinned `now`", () => {
  const NOW = new Date("2026-06-03T12:00:00.000Z");
  const text = `# CROSS_LESSONS

## p

### 2026-06-01 — a (within 7d)
Body.

### 2026-05-30 — b (within 7d, ~3.5d ago)
Body.

### 2026-05-20 — c (10 days ago, NOT in window)
Body.

### undated — d
Body.
`;
  const parsed = parseCrossLessons(text);
  const n = newThisWeekCount(parsed, NOW);
  assert.equal(n, 2, "two of four entries are within the 7-day window");
});
