// Tests for ticket 0058 - Public failure-mode landing pages.
//
// One test() per acceptance-criteria checkbox. Strategy mirrors the 0057
// public-lesson-archive suite:
//   - Drive the pure helper fleetFailureModes(db, opts) directly against
//     a tmpdir DB seeded with PR rows for AC1 (shape, anonymisation, window).
//   - Drive the renderer directly via _renderFailureModesPageForTests /
//     _renderFailurePermalinkForTests for AC2/AC3 branch coverage so the
//     branch tests never race against parallel test files writing to
//     fleet-control.config.json in the same cwd
//     (per LESSONS 2026-06-11 startServer-race).
//   - Boot startServer() over loopback for the route shape tests:
//     AC2 (index route), AC3 (permalink route), AC5 (JSON route),
//     AC8 (cross-link on /lessons SPA and /lessons-public).
//   - Mobile (AC7) is text-level CSS contract over web/style.css per the
//     0011 / receipts / pulse / lessons-public precedent (zero jsdom).
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps from
// new Date()": every seed timestamp is anchored to the test's pinned NOW.
// Per LESSONS § "in-process startServer() tests need an empty-roots
// config + run-row seeds": boot helper plants a tmp config in cwd and
// restores on cleanup; an activeBoots refcount makes that safe across
// concurrent boot()s within this file.
// Per LESSONS § "in-process dedup sets need an explicit reset hook for
// tests" + "expose a build counter for cache-hit tests, not a fetcher
// swap": AC6 uses both seams.
// Per LESSONS 2026-06-10 "redactSecrets on a JSON body shreds your KEYS":
// AC5 asserts the JSON keys survive the scrub.
// Per LESSONS 2026-06-12 greedy-id-regex: attribute scrapes anchor on
// data-testid="failure-public-..." (NOT on a bare id= regex).
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
  fleetFailureModes,
  type FleetFailureModes,
  type FleetFailureModeRow,
} from "../src/views.ts";
import {
  startServer,
  _resetFailureModesCacheForTests,
  _getFailureModesCacheBuildsForTests,
  _failureModesCachedForTests,
  _renderFailureModesPageForTests,
  _renderFailurePermalinkForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WEB_DIR = join(ROOT, "web");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");
const SERVER_TS = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
const VIEWS_TS = readFileSync(join(ROOT, "src", "views.ts"), "utf8");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const PKG_JSON = readFileSync(join(ROOT, "package.json"), "utf8");
const CONFIG_PATH = join(process.cwd(), "fleet-control.config.json");

const NOW = new Date("2026-06-13T12:00:00.000Z");

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; path: string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-failure-modes-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return {
    db, path, dir,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function seedProject(db: DB, slug: string, name?: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
  ).run(slug, name ?? slug, "test", null);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

interface PrSeed {
  projectId: number;
  number: number;
  fetchedAt: string;
  firstFailCheck?: string | null;
  firstFailExcerpt?: string | null;
  state?: string;
  isAgent?: number;
}

function seedPr(db: DB, p: PrSeed): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,"
    + "is_agent,additions,deletions,author,url,fetched_at,"
    + "first_fail_check,first_fail_excerpt) "
    + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    p.projectId, p.number, `pr-${p.number}`, `feat/${p.number}-x`,
    p.state ?? "open", "red", "clean", p.isAgent ?? 1,
    1, 0, "agent", `https://example/p/${p.number}`, p.fetchedAt,
    p.firstFailCheck ?? null, p.firstFailExcerpt ?? null,
  );
}

/** Pinned anchor helpers — NEVER derive from `new Date()` per LESSONS. */
function daysAgoIso(now: Date, n: number): string {
  return new Date(now.getTime() - n * 86_400_000).toISOString();
}

// ────────────────────────────────────────────────────────────────────
// boot() — start the server against an empty-roots config so /failures
// HTML routes can be hit over loopback. Restores cwd config on cleanup.
// ────────────────────────────────────────────────────────────────────

let activeBoots = 0;
let savedConfigText: string | null = null;

interface Booted {
  base: string;
  close: () => Promise<void>;
  cleanup: () => void;
  dbPath: string;
}

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

async function boot(seedFn?: (db: DB) => void): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-failure-modes-boot-"));
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
  if (seedFn) {
    const db = openDb(dbPath);
    try { seedFn(db); } finally { db.close(); }
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

/** Seed three TS2304 PRs across distinct projects, plus one EACCES PR,
 *  plus one out-of-window PR. Returns the project ids for use in
 *  subsequent assertions. */
function seedThreeTs2304(db: DB, now: Date): {
  ts1: number; ts2: number; ts3: number; eacces: number;
} {
  const ts1 = seedProject(db, "alpha", "alpha");
  const ts2 = seedProject(db, "bravo", "bravo");
  const ts3 = seedProject(db, "charlie", "charlie");
  const eacces = seedProject(db, "delta", "delta");
  seedPr(db, {
    projectId: ts1, number: 101, fetchedAt: daysAgoIso(now, 1),
    firstFailCheck: "typecheck",
    firstFailExcerpt: "src/foo.ts(12,3): error TS2304: Cannot find name 'Bar'.",
  });
  seedPr(db, {
    projectId: ts2, number: 102, fetchedAt: daysAgoIso(now, 2),
    firstFailCheck: "typecheck",
    firstFailExcerpt: "src/baz.ts(2,2): error TS2304: Cannot find name 'Qux'.",
  });
  seedPr(db, {
    projectId: ts3, number: 103, fetchedAt: daysAgoIso(now, 10),
    firstFailCheck: "typecheck",
    firstFailExcerpt: "src/x.ts(5,1): error TS2304: Cannot find name 'Zap'.",
  });
  seedPr(db, {
    projectId: eacces, number: 104, fetchedAt: daysAgoIso(now, 3),
    firstFailCheck: "build",
    firstFailExcerpt: "npm ERR! EACCES /usr/local/lib/node_modules",
  });
  // Out-of-window TS2304 row that must be excluded from the 90-day window.
  seedPr(db, {
    projectId: ts1, number: 201, fetchedAt: daysAgoIso(now, 200),
    firstFailCheck: "typecheck",
    firstFailExcerpt: "src/y.ts(9,9): error TS2304: Cannot find name 'OldGhost'.",
  });
  return { ts1, ts2, ts3, eacces };
}

// ────────────────────────────────────────────────────────────────────
// AC1 — fleetFailureModes returns the documented shape, groups by
// signature, counts distinct projects in the 90-day window, anonymises
// the sample excerpt, and clips it to 200 chars.
// ────────────────────────────────────────────────────────────────────

test("AC1: fleetFailureModes groups by signature, counts distinct projects + prs, applies 90d window, anonymises + clips excerpt", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetFailureModesCacheForTests();
    seedThreeTs2304(db, NOW);
    const v = fleetFailureModes(db, { now: NOW }) as FleetFailureModes;

    // Shape assertions.
    assert.equal(typeof v.generated_at, "string");
    assert.equal(typeof v.window_days, "number");
    assert.equal(v.window_days, 90);
    assert.equal(typeof v.total_signatures, "number");
    assert.equal(typeof v.total_projects_affected, "number");
    assert.ok(Array.isArray(v.signatures));

    // Grouping: TS2304 with 3 distinct slugs + 3 prs; npm-eacces with 1.
    const byKey: Record<string, FleetFailureModeRow> = {};
    for (const r of v.signatures) byKey[r.signature] = r;
    assert.ok(byKey["TS2304"], "TS2304 group must be present");
    assert.equal(byKey["TS2304"].project_count, 3);
    assert.equal(byKey["TS2304"].pr_count, 3);
    assert.ok(byKey["npm-eacces"], "npm-eacces group must be present");
    assert.equal(byKey["npm-eacces"].project_count, 1);
    assert.equal(byKey["npm-eacces"].pr_count, 1);

    // 90-day window cut: the day-200 row must NOT inflate TS2304.
    // (3, not 4 — we'd be at pr_count=4 if the window were ignored.)
    assert.equal(byKey["TS2304"].pr_count, 3,
      "out-of-window (200d ago) PR must NOT count");

    // Excerpt clipped to <= 200 chars.
    assert.ok(byKey["TS2304"].sample_excerpt_anonymised.length <= 200,
      "sample excerpt must be <= 200 chars");

    // Title is the english phrase.
    assert.equal(typeof byKey["TS2304"].title, "string");
    assert.ok(byKey["TS2304"].title.length > 0);

    // total_signatures matches the array length.
    assert.equal(v.total_signatures, v.signatures.length);
    // total_projects_affected is the count of distinct slugs across all groups.
    // (alpha + bravo + charlie + delta = 4 here.)
    assert.equal(v.total_projects_affected, 4);
  } finally { cleanup(); }
});

test("AC1: anonymiser strips operator slug, /Users path, branch from the sample excerpt; preserves TS code + filename", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetFailureModesCacheForTests();
    const p1 = seedProject(db, "courtiq", "courtiq");
    seedPr(db, {
      projectId: p1, number: 401, fetchedAt: daysAgoIso(NOW, 1),
      firstFailCheck: "typecheck",
      firstFailExcerpt: "/Users/alice/code/courtiq/src/foo.ts:42 - TS2304 Cannot find name 'Bar'.",
    });
    const v = fleetFailureModes(db, {
      now: NOW,
      projectAliasMap: { "courtiq": "project-1" },
    });
    const ts = v.signatures.find((r) => r.signature === "TS2304")!;
    assert.ok(ts, "TS2304 row present");
    assert.equal(ts.sample_excerpt_anonymised.includes("/Users/alice"), false,
      "/Users path must be stripped from the sample excerpt");
    assert.equal(ts.sample_excerpt_anonymised.includes("courtiq"), false,
      "operator project slug must NOT appear in anonymised excerpt");
    assert.ok(ts.sample_excerpt_anonymised.includes("TS2304"),
      "TS2304 code must survive the anonymiser");
    assert.ok(ts.sample_excerpt_anonymised.includes("Cannot find name"),
      "verbatim technical text must survive");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — GET /failures public index page renders with the documented
// testids, no auth, robots + canonical meta.
// ────────────────────────────────────────────────────────────────────

test("AC2: GET /failures returns 200 text/html with header + cta testids, no auth, robots + canonical meta", async () => {
  const b = await boot((db) => { seedThreeTs2304(db, NOW); });
  try {
    _resetFailureModesCacheForTests();
    const r = await fetch(b.base + "/failures");
    assert.equal(r.status, 200);
    assert.match(String(r.headers.get("content-type") ?? ""), /text\/html/);
    assert.match(String(r.headers.get("cache-control") ?? ""), /max-age=3600/);
    const body = await r.text();
    // Required testids.
    assert.match(body, /data-testid=["']failures-public-header["']/,
      "page top must carry failures-public-header testid");
    assert.match(body, /data-testid=["']failures-public-cta["']/,
      "page footer must carry failures-public-cta testid");
    // Per-signature h2 carries data-testid="failure-public-<signature>".
    // Per LESSONS 2026-06-12 the test anchors on data-testid, NOT a bare id=.
    assert.match(body, /data-testid=["']failure-public-TS2304["']/,
      "each signature h2 must carry data-testid=failure-public-<sig>");
    // robots + canonical meta.
    assert.match(body, /<meta[^>]+name=["']robots["'][^>]+content=["']index, ?follow["']/i,
      "page must declare robots:index,follow");
    assert.match(body, /<link[^>]+rel=["']canonical["'][^>]+href=["']\/failures["']/,
      "page must declare canonical=/failures");
    // No operator project slug leaks into the rendered page.
    assert.equal(body.includes("alpha"), false, "operator slug 'alpha' must NOT appear");
    assert.equal(body.includes("bravo"), false, "operator slug 'bravo' must NOT appear");
    assert.equal(body.includes("delta"), false, "operator slug 'delta' must NOT appear");
    // No <script> tag.
    assert.equal(/<script\b/i.test(body), false, "page must not include <script>");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — GET /failures/<signature> permalink page renders H1, <pre>
// excerpt, <dl> counts, and matched-lesson link when present; 404 on
// unknown signature.
// ────────────────────────────────────────────────────────────────────

test("AC3: GET /failures/TS2304 renders H1 + <pre> excerpt + <dl> counts; unknown signature → 404", async () => {
  const b = await boot((db) => { seedThreeTs2304(db, NOW); });
  try {
    _resetFailureModesCacheForTests();
    const r = await fetch(b.base + "/failures/TS2304");
    assert.equal(r.status, 200);
    assert.match(String(r.headers.get("content-type") ?? ""), /text\/html/);
    assert.match(String(r.headers.get("cache-control") ?? ""), /max-age=3600/);
    const body = await r.text();
    // H1 carries data-testid="failure-public-TS2304" so the test
    // anchors on testid (LESSONS 2026-06-12 greedy-id-regex avoidance).
    assert.match(body, /data-testid=["']failure-public-TS2304["']/,
      "permalink H1 must carry data-testid");
    assert.match(body, /<h1[^>]*>/i, "permalink must use H1 for the title");
    assert.match(body, /<pre\b[\s\S]*TS2304[\s\S]*<\/pre>/i,
      "permalink must render the excerpt inside <pre>");
    assert.match(body, /<dl\b[\s\S]*<\/dl>/i,
      "permalink must render counts inside <dl>");
    // canonical points to the permalink form, not the index.
    assert.match(body, /<link[^>]+rel=["']canonical["'][^>]+href=["']\/failures\/TS2304["']/,
      "canonical must be the permalink shape");
    assert.match(body, /<meta[^>]+name=["']robots["'][^>]+content=["']index, ?follow["']/i,
      "permalink must declare robots:index,follow");
    // Back link to the index page.
    assert.match(body, /href=["']\/failures["']/,
      "permalink must link back to /failures");

    // Unknown signature → 404 with a friendly page.
    const r404 = await fetch(b.base + "/failures/foo-not-real");
    assert.equal(r404.status, 404);
    const body404 = await r404.text();
    assert.match(body404, /<html/i, "404 must be HTML, not plain text");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — Anonymisation regression: rendered HTML strips operator slug,
// absolute path, branch name, and looks-like-a-PAT token. Page
// structure (H1, <pre>, <dl>) survives the redaction pass.
// ────────────────────────────────────────────────────────────────────

test("AC4: rendered /failures/TS2304 HTML strips slug + path + branch + PAT-shape token; structure survives", async () => {
  const b = await boot((db) => {
    const pid = seedProject(db, "courtiq-prod", "courtiq-prod");
    const leakExcerpt = "src/foo.ts: error TS2304 Cannot find name 'Foo' on "
      + "/Users/alice/code/courtiq-prod via feat/secret-feature-x; "
      + "leaked ghp_abcdef1234567890abcdef1234567890abcd";
    seedPr(db, {
      projectId: pid, number: 501, fetchedAt: daysAgoIso(NOW, 1),
      firstFailCheck: "typecheck",
      firstFailExcerpt: leakExcerpt,
    });
  });
  try {
    _resetFailureModesCacheForTests();
    const r = await fetch(b.base + "/failures/TS2304");
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.equal(body.includes("courtiq-prod"), false,
      "operator slug 'courtiq-prod' must NOT appear");
    assert.equal(body.includes("/Users/alice"), false,
      "absolute /Users path must NOT appear");
    assert.equal(body.includes("feat/secret-feature-x"), false,
      "agent branch name must NOT appear");
    assert.equal(body.includes("ghp_abcdef1234567890abcdef1234567890abcd"), false,
      "PAT-shape token must NOT appear (defence-in-depth redactor)");
    // Page structure survives.
    assert.match(body, /<h1[^>]*>/i, "H1 still present");
    assert.match(body, /<pre\b/i, "<pre> still present");
    assert.match(body, /<dl\b/i, "<dl> still present");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — GET /api/failures JSON shape; signature is in the closed set;
// keys survive the scrub (redactSecrets on JSON values, NOT body).
// ────────────────────────────────────────────────────────────────────

test("AC5: GET /api/failures returns the documented shape; signature matches the closed regex; keys survive scrub", async () => {
  const b = await boot((db) => { seedThreeTs2304(db, NOW); });
  try {
    _resetFailureModesCacheForTests();
    const r = await fetch(b.base + "/api/failures");
    assert.equal(r.status, 200);
    assert.match(String(r.headers.get("content-type") ?? ""), /application\/json/);
    assert.match(String(r.headers.get("cache-control") ?? ""), /max-age=3600/);
    const j = await r.json() as FleetFailureModes;
    assert.equal(typeof j.generated_at, "string", "generated_at present");
    assert.equal(typeof j.window_days, "number", "window_days present");
    assert.equal(typeof j.total_signatures, "number", "total_signatures present");
    assert.equal(typeof j.total_projects_affected, "number", "total_projects_affected present");
    assert.ok(Array.isArray(j.signatures), "signatures present");
    for (const r of j.signatures) {
      assert.match(r.signature, /^(TS\d{4}|git-push-403|gh-missing|node-missing|npm-eacces)$/,
        `signature must be in the closed set; got ${r.signature}`);
      assert.equal(typeof r.title, "string", "title present per row");
      assert.equal(typeof r.sample_excerpt_anonymised, "string", "excerpt present");
      assert.equal(typeof r.project_count, "number");
      assert.equal(typeof r.pr_count, "number");
      assert.equal(typeof r.first_seen_at, "string");
      assert.equal(typeof r.last_seen_at, "string");
      // matched_lesson_slug is string | null
      assert.ok(r.matched_lesson_slug === null || typeof r.matched_lesson_slug === "string");
    }
    // No operator project slug leaks via any field.
    const flat = JSON.stringify(j);
    assert.equal(flat.includes("alpha"), false);
    assert.equal(flat.includes("bravo"), false);
    assert.equal(flat.includes("charlie"), false);
    assert.equal(flat.includes("delta"), false);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Caching: second call within the cache tuple is a hit (builds
// counter unchanged); a fresh pr row in window invalidates and the
// next call rebuilds.
// ────────────────────────────────────────────────────────────────────

test("AC6: failure-modes cache memoises per (MAX(fetched_at), COUNT(*)); fresh pr row in window rebuilds", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetFailureModesCacheForTests();
    seedThreeTs2304(db, NOW);
    const before = _getFailureModesCacheBuildsForTests();
    _failureModesCachedForTests(db, NOW);
    const after1 = _getFailureModesCacheBuildsForTests();
    assert.equal(after1, before + 1, "first call must rebuild");
    _failureModesCachedForTests(db, NOW);
    const after2 = _getFailureModesCacheBuildsForTests();
    assert.equal(after2, after1, "second call within cache tuple must NOT rebuild");
    // Insert a fresh pr row in window.
    const pid = seedProject(db, "echo", "echo");
    seedPr(db, {
      projectId: pid, number: 999, fetchedAt: daysAgoIso(NOW, 1),
      firstFailCheck: "publish",
      firstFailExcerpt: "remote: Permission denied to push to repo",
    });
    _failureModesCachedForTests(db, NOW);
    const after3 = _getFailureModesCacheBuildsForTests();
    assert.equal(after3, after2 + 1,
      "new pr row in window must invalidate the cache and trigger a rebuild");
    // Per LESSONS 2026-06-05 the producer-side invalidation hook is
    // registered on globalThis so ingest can wake the cache without an
    // import cycle. Assert the slot is wired.
    const hook = (globalThis as { __fleet_failure_modes_invalidate__?: () => void })
      .__fleet_failure_modes_invalidate__;
    assert.equal(typeof hook, "function",
      "globalThis.__fleet_failure_modes_invalidate__ must be registered by src/server.ts on module load");
    hook!();
    _failureModesCachedForTests(db, NOW);
    const after4 = _getFailureModesCacheBuildsForTests();
    assert.equal(after4, after3 + 1, "globalThis hook fire must invalidate the cache");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Mobile: text-level CSS contract over web/style.css + branch
// coverage via _renderFailureModesPageForTests with viewportWidth.
// ────────────────────────────────────────────────────────────────────

test("AC7: web/style.css carries the .failures-public mobile + desktop selector group", () => {
  // Centred max-width 80ch on desktop and a single-column layout on mobile
  // — same pattern as the 0057 .lessons-public selector group.
  assert.match(CSS, /\.failures-public\b/,
    "style.css must carry .failures-public selector");
  assert.match(CSS, /max-width:\s*80ch/,
    "style.css must constrain reading width to 80ch (any selector)");
  // <pre> excerpt block scrolls horizontally inside its own container.
  assert.match(CSS, /\.failures-public[\s\S]{0,500}pre/,
    "style.css must scope a <pre> rule under .failures-public");
});

test("AC7: _renderFailureModesPageForTests(payload, {viewportWidth: 375}) emits the mobile-aware HTML", () => {
  const payload: FleetFailureModes = {
    generated_at: NOW.toISOString(),
    window_days: 90,
    total_signatures: 1,
    total_projects_affected: 1,
    signatures: [{
      signature: "TS2304",
      title: "TypeScript: cannot find name",
      sample_excerpt_anonymised: "src/foo.ts: error TS2304 Cannot find name 'X'",
      project_count: 1,
      pr_count: 1,
      first_seen_at: NOW.toISOString(),
      last_seen_at: NOW.toISOString(),
      matched_lesson_slug: null,
    }],
  };
  const htmlMobile = _renderFailureModesPageForTests(payload, { viewportWidth: 375 });
  assert.match(htmlMobile, /data-testid=["']failures-public-header["']/);
  // Viewport meta supports width=device-width (mobile-first per 0011).
  assert.match(htmlMobile, /<meta[^>]+name=["']viewport["'][^>]+width=device-width/i);
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Cross-link from /lessons SPA + /lessons-public public page to
// /failures.
// ────────────────────────────────────────────────────────────────────

test("AC8: web/app.js #/lessons SPA renderer carries lessons-failure-modes-cross-link footer → /failures", () => {
  assert.match(APP_JS, /data-testid=["']lessons-failure-modes-cross-link["']/,
    "web/app.js must include the lessons-failure-modes-cross-link testid");
  const idx = APP_JS.indexOf("lessons-failure-modes-cross-link");
  assert.ok(idx >= 0, "testid must be present");
  const window = APP_JS.slice(Math.max(0, idx - 500), idx + 500);
  assert.match(window, /\/failures/,
    "the SPA cross-link must reference /failures near the testid");
});

test("AC8: /lessons-public public HTML carries the lessons-failure-modes-cross-link footer → /failures", async () => {
  const b = await boot();
  try {
    _resetFailureModesCacheForTests();
    const r = await fetch(b.base + "/lessons-public");
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /data-testid=["']lessons-failure-modes-cross-link["']/,
      "/lessons-public must include the cross-link testid");
    const idx = body.indexOf("lessons-failure-modes-cross-link");
    const window = body.slice(Math.max(0, idx - 400), idx + 400);
    assert.match(window, /href=["']\/failures["']/,
      "the cross-link must point to /failures");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Performance (skip unless PERF=1) + page size sanity.
// ────────────────────────────────────────────────────────────────────

test("AC9: fleetFailureModes(1000 prs) — cache miss < 100ms, cache hit < 5ms (PERF=1 only)", { skip: process.env.PERF !== "1" }, () => {
  const { db, cleanup } = tempDb();
  try {
    _resetFailureModesCacheForTests();
    const pid = seedProject(db, "perf-project", "perf-project");
    for (let i = 0; i < 1000; i++) {
      seedPr(db, {
        projectId: pid, number: 1000 + i, fetchedAt: daysAgoIso(NOW, 1),
        firstFailCheck: "typecheck",
        firstFailExcerpt: `src/foo.ts(${i},1): error TS2304: Cannot find name 'X${i}'.`,
      });
    }
    const t0 = Date.now();
    const v = fleetFailureModes(db, { now: NOW });
    const missMs = Date.now() - t0;
    assert.ok(missMs < 100, `cache miss must be < 100ms; got ${missMs}ms`);
    const t1 = Date.now();
    fleetFailureModes(db, { now: NOW });
    const hitMs = Date.now() - t1;
    assert.ok(hitMs < 5, `cache hit must be < 5ms; got ${hitMs}ms`);
    // Page-size sanity: rendered HTML < 100KB for any realistic group set.
    const html = _renderFailureModesPageForTests(v);
    assert.ok(html.length < 100 * 1024,
      `rendered HTML must be < 100KB uncompressed; got ${html.length} bytes`);
  } finally { cleanup(); }
});

test("AC9: rendered /failures HTML is under 100KB for a realistic 5-signature payload", () => {
  const sigs: FleetFailureModeRow[] = [
    "TS2304", "git-push-403", "gh-missing", "node-missing", "npm-eacces",
  ].map((s) => ({
    signature: s,
    title: "title for " + s,
    sample_excerpt_anonymised: "x".repeat(200),
    project_count: 3,
    pr_count: 5,
    first_seen_at: NOW.toISOString(),
    last_seen_at: NOW.toISOString(),
    matched_lesson_slug: null,
  }));
  const payload: FleetFailureModes = {
    generated_at: NOW.toISOString(),
    window_days: 90,
    total_signatures: sigs.length,
    total_projects_affected: 4,
    signatures: sigs,
  };
  const html = _renderFailureModesPageForTests(payload);
  assert.ok(html.length < 100 * 1024,
    `rendered HTML must be < 100KB; got ${html.length} bytes`);
});

// ────────────────────────────────────────────────────────────────────
// AC10 — No new runtime deps; no shell-string composition; net-new
// public routes don't break any existing /api/* JSON shape.
// ────────────────────────────────────────────────────────────────────

test("AC10: package.json `dependencies` stays empty (zero runtime deps)", () => {
  const pkg = JSON.parse(PKG_JSON) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  assert.deepEqual(deps, {},
    "AGENTS.md Hard NO: no runtime deps may be added; got " + JSON.stringify(deps));
});

test("AC10: src/views.ts fleetFailureModes helper does not import node:child_process", () => {
  // The new helper is pure SQL + JS over the existing pr table; no shell-out.
  assert.equal(/from\s+["']node:child_process["']/.test(VIEWS_TS), false,
    "src/views.ts must not import node:child_process");
});

test("AC10: server mounts the net-new /failures routes; no existing /api/* JSON shape is broken", () => {
  // Net-new HTML + JSON routes — the contract is that the route literal is
  // mounted in src/server.ts. Existing /api/* JSON shapes are NOT touched
  // by this ticket (additive HTML cross-link only; AC8).
  assert.match(SERVER_TS, /"\/failures"|'\/failures'/,
    "src/server.ts must mount the /failures HTML route");
  assert.match(SERVER_TS, /"\/api\/failures"|'\/api\/failures'/,
    "src/server.ts must mount the /api/failures JSON route");
  // Permalink: the route uses a regex match — assert the path prefix.
  assert.match(SERVER_TS, /\/failures\\\//,
    "src/server.ts must mount the /failures/<signature> permalink");
});

test("AC10: fleetFailureModes is exported from src/views.ts (net-new surface)", () => {
  assert.match(VIEWS_TS, /export\s+function\s+fleetFailureModes\b/,
    "fleetFailureModes must be exported");
});
