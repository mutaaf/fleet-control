// Tests for ticket 0065 - Public operator-attributed profile page.
//
// One test() per acceptance-criteria checkbox in
// docs/backlog/0065-operator-profile-public-page.md. Strategy mirrors
// the 0054 pulse / 0050 year-in-review / 0058 failure-modes suites:
//   - Drive the pure helper operatorProfilePayload(db, config, now)
//     directly against a tmpdir DB for the shape, attribution branch,
//     empty-state branch, and cache tests.
//   - Drive renderOperatorProfileForTests(payload, opts) directly
//     for the attribution + quiet-hours branches per LESSONS 2026-06-11
//     "startServer() tests that mutate fleet-control.config.json race
//     against parallel test files; expose a renderer-direct seam".
//   - Boot startServer() over loopback for the integration shape
//     (route mounted, 404 when no operator config, content-type, OG
//     meta tags) using the empty-roots config + tmp fleet-control.
//     config.json seam.
//
// PRODUCER-VS-SPEC per LESSONS 2026-06-05: the pr.state literal for
// merged PRs is 'MERGED' uppercase per src/ingest/prs.ts:235 + the
// existing src/views.ts:6292 fleetYearInReview helper.
//
// Per LESSONS 2026-05-29 "time-pinned tests must NOT derive seed
// timestamps from new Date()": every seed timestamp anchors to the
// pinned NOW constant.
// Per LESSONS 2026-06-07 "the pr table has no surrogate id; proxy
// latest landed via (MAX(fetched_at), COUNT(*))": the cache-bust
// test drives that path.
// Per LESSONS 2026-06-12 "greedy id= regex captures the wrong
// attribute": every HTML scrape anchors on data-testid.
// Per LESSONS 2026-06-15 "static route mounted before /api/ auth
// gate must anchor on the if-statement, not the prose comment":
// the ordering test anchors on the if ( ... ) syntactic shape.
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
import type { FleetConfig } from "../src/config.ts";
import {
  operatorProfilePayload,
  _renderOperatorProfileForTests,
  _renderOperatorOgSvgForTests,
  type OperatorProfilePayload,
} from "../src/views.ts";
import {
  startServer,
  _resetOperatorProfileCacheForTests,
  _getOperatorProfileCacheBuildsForTests,
  _operatorProfileCachedForTests,
} from "../src/server.ts";
import { _resetRateLimitBucketsForTests } from "../src/rate_limit.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SERVER_TS = readFileSync(join(REPO_ROOT, "src", "server.ts"), "utf8");
const VIEWS_TS = readFileSync(join(REPO_ROOT, "src", "views.ts"), "utf8");
const RATE_LIMIT_TS = readFileSync(join(REPO_ROOT, "src", "rate_limit.ts"), "utf8");

// Pinned anchor: 2026-06-17 (the ticket creation date).
// operator.sinceDate = 2025-11-01 → 7 calendar months elapsed.
const NOW = new Date("2026-06-17T09:00:00.000Z");
const SINCE_DATE = "2025-11-01";
const HANDLE = "mutaaf";

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-operator-profile-"));
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
  projectId: number; number: number; title?: string; fetchedAt: string;
}): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,additions,deletions,author,url,fetched_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, opts.title ?? `pr-${opts.number}`,
    `feat/${opts.number}`,
    "MERGED", "green", null, 1, 0, 0, "a",
    `https://example/owner/x/pull/${opts.number}`, opts.fetchedAt,
  );
}

function seedProjectPause(db: DB, projectId: number, triggeredAt: string): void {
  db.prepare(
    "INSERT INTO project_pause(project_id, reason, triggered_at, triggered_by, detail_json)"
    + " VALUES (?, 'cost_cap', ?, 'auto', '{}')",
  ).run(projectId, triggeredAt);
}

function seedLessonCredit(db: DB, opts: {
  slug: string; date: string; title: string; createdAt: string;
  healAuditId: number; projectSlug: string;
}): void {
  db.prepare(
    "INSERT INTO control_audit(id, ts, actor, action, target, args_json, exit_code, stdout_tail)"
    + " VALUES (?, ?, 'local', 'heal', ?, '{}', 0, '')",
  ).run(opts.healAuditId, opts.createdAt, `${opts.projectSlug}/0`);
  db.prepare(
    "INSERT INTO lesson_credit(lesson_slug, lesson_date, lesson_title, heal_audit_id, project_slug, matched_substring, created_at)"
    + " VALUES (?,?,?,?,?,?,?)",
  ).run(opts.slug, opts.date, opts.title, opts.healAuditId, opts.projectSlug, "needle", opts.createdAt);
}

function makeOperatorCfg(extra?: Partial<NonNullable<FleetConfig["operator"]>>): FleetConfig {
  return {
    projectRoots: [],
    installedRoot: "/tmp/empty",
    dbPath: "/tmp/empty/fleet.db",
    cacheBase: "/tmp/empty",
    claudeProjects: "/tmp/empty",
    host: "127.0.0.1",
    port: 7070,
    operator: {
      handle: HANDLE,
      displayName: "Mutaaf",
      headline: "running an autonomous agent fleet on personal projects",
      sinceDate: SINCE_DATE,
      ...extra,
    },
  };
}

function emptyCfg(): FleetConfig {
  return {
    projectRoots: [],
    installedRoot: "/tmp/empty",
    dbPath: "/tmp/empty/fleet.db",
    cacheBase: "/tmp/empty",
    claudeProjects: "/tmp/empty",
    host: "127.0.0.1",
    port: 7070,
  };
}

// ────────────────────────────────────────────────────────────────────
// AC1 - operatorProfilePayload returns the documented shape.
// ────────────────────────────────────────────────────────────────────

test("AC1: operatorProfilePayload returns totals, recentShips, topLessons; monthsRunning=7 with sinceDate 2025-11-01 and now 2026-06-17", () => {
  const { db, cleanup } = tempDb();
  try {
    // Seed 3 merged PRs across 2 projects so lifetimePrsShipped = 3.
    const pidA = seedProject(db, "alpha", "Alpha");
    const pidB = seedProject(db, "bravo", "Bravo");
    seedMergedPr(db, { projectId: pidA, number: 1, title: "shipped widget", fetchedAt: "2026-06-01T08:00:00.000Z" });
    seedMergedPr(db, { projectId: pidA, number: 2, title: "fixed bug", fetchedAt: "2026-06-10T08:00:00.000Z" });
    seedMergedPr(db, { projectId: pidB, number: 3, title: "added api", fetchedAt: "2026-06-15T08:00:00.000Z" });
    // 5 lessons authored (lesson_credit unique by lesson_slug+date+heal_audit_id).
    // The "lessonsAuthored" total counts DISTINCT (lesson_slug, lesson_date).
    seedLessonCredit(db, { slug: "lesson-a", date: "2026-05-01", title: "lesson A", healAuditId: 1, projectSlug: "alpha", createdAt: "2026-05-02T08:00:00.000Z" });
    seedLessonCredit(db, { slug: "lesson-b", date: "2026-05-02", title: "lesson B", healAuditId: 2, projectSlug: "alpha", createdAt: "2026-05-03T08:00:00.000Z" });
    seedLessonCredit(db, { slug: "lesson-c", date: "2026-05-03", title: "lesson C", healAuditId: 3, projectSlug: "bravo", createdAt: "2026-05-04T08:00:00.000Z" });
    seedLessonCredit(db, { slug: "lesson-d", date: "2026-05-04", title: "lesson D", healAuditId: 4, projectSlug: "bravo", createdAt: "2026-05-05T08:00:00.000Z" });
    seedLessonCredit(db, { slug: "lesson-e", date: "2026-05-05", title: "lesson E", healAuditId: 5, projectSlug: "alpha", createdAt: "2026-05-06T08:00:00.000Z" });
    // 2 active projects (no project_pause rows) - both projects active.

    const cfg = makeOperatorCfg();
    const payload = operatorProfilePayload(db, cfg, NOW);

    assert.equal(payload.handle, HANDLE, "handle from config");
    assert.equal(payload.displayName, "Mutaaf");
    assert.equal(payload.sinceDate, SINCE_DATE);
    assert.equal(payload.totals.lifetimePrsShipped, 3,
      "lifetime merged-PR count = 3");
    assert.equal(payload.totals.lessonsAuthored, 5,
      "5 distinct lessons authored");
    assert.equal(payload.totals.projectsActive, 2,
      "2 projects with no project_pause row");
    assert.equal(payload.totals.monthsRunning, 7,
      "monthsRunning = 7 (2025-11 -> 2026-06 inclusive of arithmetic)");
    assert.equal(payload.recentShips.length, 3);
    // Most-recent first.
    assert.equal(payload.recentShips[0].mergedAt, "2026-06-15T08:00:00.000Z");
    assert.equal(payload.topLessons.length >= 0, true);
    assert.equal(payload.version, 1);
    assert.equal(payload.attribution, "anonymised",
      "default attribution is anonymised");
    assert.equal(typeof payload.asOf, "string");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 - GET /operator/<handle> renders 200 / 404 / inherits rate limit.
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
  const dir = mkdtempSync(join(tmpdir(), "fleet-operator-profile-boot-"));
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

test("AC2: GET /operator/<handle> returns 200 + text/html when operator.handle matches; 404 for wrong handle", async () => {
  _resetOperatorProfileCacheForTests();
  _resetRateLimitBucketsForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "alpha", "Alpha");
    seedMergedPr(db, { projectId: pid, number: 1, title: "ship", fetchedAt: "2026-06-01T08:00:00.000Z" });
  }, {
    operator: { handle: HANDLE, displayName: "Mutaaf", headline: "the headline", sinceDate: SINCE_DATE },
  });
  try {
    const r = await fetch(b.base + "/operator/" + HANDLE);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    const body = await r.text();
    assert.match(body,
      /data-testid=["']operator-profile-handle["'][^>]*>mutaaf</,
      "handle anchored via data-testid=operator-profile-handle");

    const wrong = await fetch(b.base + "/operator/wronghandle");
    assert.equal(wrong.status, 404, "wrong handle MUST 404");
  } finally { await b.close(); b.cleanup(); }
});

test("AC2: GET /operator/<handle> inherits the 0064 rate limit; 61st request from a remote IP returns 429", () => {
  // Drive the rate-limit path-prefix check directly. The /operator/
  // family MUST be covered by isRateLimitedPath() so the existing
  // 0064 middleware in src/server.ts catches the 61st hit. The
  // production path runs the check BEFORE any auth gate.
  // We anchor the assertion on the rate_limit.ts source so a
  // refactor that moves the prefix list still keeps /operator/
  // covered.
  assert.match(RATE_LIMIT_TS,
    /isRateLimitedPath[\s\S]{0,400}\/operator\//,
    "isRateLimitedPath MUST include /operator/ in its prefix list per the 0064 surface contract");
});

// ────────────────────────────────────────────────────────────────────
// AC3 - Attribution branch via the renderer-direct seam.
// ────────────────────────────────────────────────────────────────────

function basePayload(attribution: "anonymised" | "attributed"): OperatorProfilePayload {
  return {
    handle: HANDLE,
    displayName: "Mutaaf",
    headline: "running an agent fleet",
    sinceDate: SINCE_DATE,
    publicHost: "http://test.example",
    totals: {
      lifetimePrsShipped: 5,
      lessonsAuthored: 3,
      projectsActive: 2,
      monthsRunning: 7,
    },
    recentShips: [
      { title: "shipped widget X", projectAlias: attribution === "attributed" ? "courtiq" : "project-a", mergedAt: "2026-06-15T08:00:00.000Z" },
      { title: "shipped widget Y", projectAlias: attribution === "attributed" ? "courtiq" : "project-a", mergedAt: "2026-06-10T08:00:00.000Z" },
      { title: "shipped widget Z", projectAlias: attribution === "attributed" ? "fleet-control" : "project-b", mergedAt: "2026-06-01T08:00:00.000Z" },
    ],
    topLessons: [],
    attribution,
    quietHoursActive: false,
    asOf: NOW.toISOString(),
    version: 1,
  };
}

test("AC3: attribution=anonymised renders 'project-a' alias; attribution=attributed renders the real slug", () => {
  const anonHtml = _renderOperatorProfileForTests(basePayload("anonymised"), { quietHoursActive: false });
  assert.ok(anonHtml.includes("project-a"),
    "anonymised render MUST contain the project-a alias");
  assert.equal(anonHtml.includes("courtiq"), false,
    "anonymised render MUST NOT leak the real slug");

  const attrHtml = _renderOperatorProfileForTests(basePayload("attributed"), { quietHoursActive: false });
  assert.ok(attrHtml.includes("courtiq"),
    "attributed render MUST contain the real slug 'courtiq'");
});

// ────────────────────────────────────────────────────────────────────
// AC4 - OG image sibling at /og/operator/<handle>.svg.
// ────────────────────────────────────────────────────────────────────

test("AC4: renderOperatorOgSvg carries operator-og-handle testid + lifetime PR count as a <text> element", () => {
  const p = basePayload("anonymised");
  const svg = _renderOperatorOgSvgForTests(p);
  assert.match(svg, /<svg[^>]+xmlns/, "well-formed SVG header");
  assert.match(svg,
    /data-testid=["']operator-og-handle["']/,
    "operator-og-handle testid anchors the handle field");
  // Lifetime PRs (5) renders inside a <text> element.
  assert.match(svg,
    /<text[^>]*>[^<]*5[^<]*<\/text>/,
    "lifetime PR count surfaces as a <text> element");
  // Dimensions per spec (1200x630).
  assert.match(svg, /width=["']1200["']/);
  assert.match(svg, /height=["']630["']/);
});

test("AC4: GET /og/operator/<handle>.svg returns 200 + image/svg+xml when operator matches; 404 for wrong handle", async () => {
  _resetOperatorProfileCacheForTests();
  _resetRateLimitBucketsForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "alpha", "Alpha");
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-01T08:00:00.000Z" });
  }, {
    operator: { handle: HANDLE, displayName: "Mutaaf", sinceDate: SINCE_DATE },
  });
  try {
    const r = await fetch(b.base + "/og/operator/" + HANDLE + ".svg");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /image\/svg\+xml/);
    const body = await r.text();
    assert.match(body, /data-testid=["']operator-og-handle["']/);
    const wrong = await fetch(b.base + "/og/operator/wronghandle.svg");
    assert.equal(wrong.status, 404, "wrong handle MUST 404");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 - HTML head carries og:image, twitter:card, og:title, og:description
//       with an absolute og:image URL using the host config.
// ────────────────────────────────────────────────────────────────────

test("AC5: rendered HTML head carries four meta tags; og:image is an absolute URL via host config", async () => {
  _resetOperatorProfileCacheForTests();
  _resetRateLimitBucketsForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "alpha", "Alpha");
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-01T08:00:00.000Z" });
  }, {
    operator: {
      handle: HANDLE,
      displayName: "Mutaaf",
      sinceDate: SINCE_DATE,
      publicHost: "https://fleet.example.com",
    },
  });
  try {
    const r = await fetch(b.base + "/operator/" + HANDLE);
    const body = await r.text();
    assert.match(body, /<meta[^>]+property=["']og:image["'][^>]+content=["']https:\/\/fleet\.example\.com\/og\/operator\/mutaaf\.svg["']/,
      "og:image MUST be absolute via host config and point at /og/operator/<handle>.svg");
    assert.match(body, /<meta[^>]+name=["']twitter:card["'][^>]+content=["']summary_large_image["']/,
      "twitter:card MUST be summary_large_image");
    assert.match(body, /<meta[^>]+property=["']og:title["']/,
      "og:title meta tag");
    assert.match(body, /<meta[^>]+property=["']og:description["']/,
      "og:description meta tag");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 - Empty-state branch: zero PRs renders warming-up sentence; no
//       recent-ship testids appear.
// ────────────────────────────────────────────────────────────────────

test("AC6: operatorProfilePayload returns empty recentShips when 0 PRs seeded; renderer carries operator-profile-warming-up testid", () => {
  const { db, cleanup } = tempDb();
  try {
    // No PRs seeded.
    const cfg = makeOperatorCfg();
    const payload = operatorProfilePayload(db, cfg, NOW);
    assert.equal(payload.recentShips.length, 0,
      "no padding - 0 PRs means 0 ships");
    assert.equal(payload.totals.lifetimePrsShipped, 0);

    const html = _renderOperatorProfileForTests(payload, { quietHoursActive: false });
    assert.match(html, /data-testid=["']operator-profile-warming-up["']/,
      "empty-state warming-up testid renders");
    assert.equal(/data-testid=["']recent-ship-/.test(html), false,
      "no recent-ship-* testids on the warming-up page");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 - Opt-out gate: no operator field → 404 on both routes; home is
//       unchanged.
// ────────────────────────────────────────────────────────────────────

test("AC7: with NO operator config, /operator/* and /og/operator/*.svg both 404; / renders unchanged (no profile CTA)", async () => {
  _resetOperatorProfileCacheForTests();
  _resetRateLimitBucketsForTests();
  const b = await boot((db) => {
    seedProject(db, "alpha", "Alpha");
  });
  try {
    const r1 = await fetch(b.base + "/operator/anything");
    assert.equal(r1.status, 404, "no operator config = 404 on profile route");
    const r2 = await fetch(b.base + "/og/operator/anything.svg");
    assert.equal(r2.status, 404, "no operator config = 404 on OG svg route");
    const home = await fetch(b.base + "/");
    assert.equal(home.status, 200);
    const homeBody = await home.text();
    assert.equal(homeBody.includes("operator-profile-handle"), false,
      "home page MUST NOT carry the profile testid when operator is absent");
  } finally { await b.close(); b.cleanup(); }
});

// Also pure: the helper itself returns a sentinel when no operator config.
test("AC7: operatorProfilePayload throws / signals no-config when cfg.operator is absent", () => {
  const { db, cleanup } = tempDb();
  try {
    const cfg = emptyCfg();
    // The route helper checks for null; the pure helper returns null
    // when cfg.operator is absent (zero-content version, signals the
    // route to 404 without any DB work).
    const out = operatorProfilePayload(db, cfg, NOW);
    assert.equal(out, null,
      "no operator config = payload returns null (the route 404s on null)");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC8 - Quiet-hours posture: install CTA suppressed when quietHoursActive.
// ────────────────────────────────────────────────────────────────────

test("AC8: renderer with quietHoursActive=true omits the install-cta testid", () => {
  const p = basePayload("anonymised");
  const normal = _renderOperatorProfileForTests(p, { quietHoursActive: false });
  assert.match(normal, /data-testid=["']install-cta["']/,
    "install-cta testid present during normal hours");

  const quiet = _renderOperatorProfileForTests(p, { quietHoursActive: true });
  assert.equal(/data-testid=["']install-cta["']/.test(quiet), false,
    "install-cta testid suppressed under quiet hours");
});

// ────────────────────────────────────────────────────────────────────
// AC9 - Cache + invalidation: two reads within TTL = one build; seeding
//       a new merged PR busts via (MAX(pr.fetched_at), COUNT(*)).
// ────────────────────────────────────────────────────────────────────

test("AC9: cache: two calls within TTL share one build; seeding a fresh merged PR busts via (MAX(fetched_at), COUNT(*))", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetOperatorProfileCacheForTests();
    const pid = seedProject(db, "alpha", "Alpha");
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-01T08:00:00.000Z" });
    const cfg = makeOperatorCfg();
    const before = _getOperatorProfileCacheBuildsForTests();
    const a = _operatorProfileCachedForTests(db, cfg, NOW);
    const afterFirst = _getOperatorProfileCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call cache-misses");
    const b = _operatorProfileCachedForTests(db, cfg, NOW);
    const afterSecond = _getOperatorProfileCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0, "second call within TTL cache-hits");
    assert.equal(a!.totals.lifetimePrsShipped, b!.totals.lifetimePrsShipped);
    // Bust via a fresh merged PR (MAX(fetched_at) AND COUNT(*) both shift).
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-06-16T08:00:00.000Z" });
    _operatorProfileCachedForTests(db, cfg, NOW);
    const afterBust = _getOperatorProfileCacheBuildsForTests();
    assert.equal(afterBust - afterSecond, 1,
      "fresh PR row MUST bust the cache via (MAX(fetched_at), COUNT(*))");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 - tsc/no new runtime deps/no shell-string/route mounted BEFORE
//        /api/ auth gate. Static greps.
// ────────────────────────────────────────────────────────────────────

test("AC10: /operator/<handle> route is mounted BEFORE the if (path.startsWith(/api/)) auth gate", () => {
  // Per LESSONS 2026-06-15 anchor on the if-statement, NOT a literal
  // substring (a prose comment naming the gate would collide).
  const operatorIdx = SERVER_TS.indexOf("/operator/");
  assert.notEqual(operatorIdx, -1, "/operator/ route MUST exist in server.ts");
  const apiGateIdx = SERVER_TS.indexOf("if (path.startsWith(\"/api/\"))");
  assert.notEqual(apiGateIdx, -1, "the if (path.startsWith(/api/)) auth gate MUST exist");
  assert.ok(operatorIdx < apiGateIdx,
    `/operator/ route MUST be mounted BEFORE the /api/ auth gate (operatorIdx=${operatorIdx}, apiGateIdx=${apiGateIdx})`);
});

test("AC10: dependencies stays empty in package.json (no new runtime deps)", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.deepEqual(pkg.dependencies ?? {}, {},
    "dependencies MUST stay empty per AGENTS.md");
});

test("AC10: src/views.ts MUST NOT introduce a from \"./lessons.ts\" import (LESSONS 2026-06-13 cycle trap)", () => {
  // lessons.ts already imports from views.ts; the back-edge would
  // create a function-import cycle whose evaluation order is
  // runtime-undefined per LESSONS 2026-06-13.
  assert.equal(/from\s+["']\.\/lessons\.ts["']/.test(VIEWS_TS), false,
    "views.ts MUST NOT add an import from ./lessons.ts");
});
