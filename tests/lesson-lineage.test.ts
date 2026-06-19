// Tests for ticket 0069 - Public lesson lineage page.
//
// One test() per acceptance-criteria checkbox per the ticket. Strategy
// mirrors the 0057 lessons-public-archive + 0058 failure-modes suites:
//   - Drive the pure helper lessonLineagePayload(db, slug, now) directly
//     against a seeded lesson_credit + control_audit + pr fixture. AC1
//     (shape + arithmetic), AC2 (empty), AC9 (cache + invalidation).
//   - Drive the renderer-direct seam _renderLessonLineageForTests for
//     AC3 (singleton), AC8 (quiet-hours). Per LESSONS 2026-06-11 the
//     renderer-direct seam exercises cfg-dependent branches without
//     mutating fleet-control.config.json (which races across parallel
//     test files in the same cwd).
//   - Boot startServer() over loopback for AC4 (HTML route shape),
//     AC5 (OG SVG route), AC6 (og:* meta tags), AC7 (rate-limit
//     prefix coverage). AC7 also asserts the rate_limit.ts prefix
//     list as a static grep so the integration test stays narrow.
//
// Per LESSONS 2026-05-29: every test pins NOW and seeds timestamps off
// that anchor; never `new Date()`.
// Per LESSONS 2026-06-12: HTML-attribute regexes anchor on data-testid,
// not a greedy id= regex.
// Per LESSONS 2026-06-15: the "route mounted before /api/" grep anchors
// on `if (path.startsWith("/api/"))`, not a literal substring.
// Per LESSONS 2026-06-13: views.ts MUST NOT grow a from "./lessons.ts"
// import for the anonymisation - the existing private anonymiseExcerpt
// in views.ts is reused inline.
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
  lessonLineagePayload,
  _renderLessonLineageForTests,
  _renderLessonLineageOgSvgForTests,
  renderLessonsPublicPermalinkWithLineageForTests,
} from "../src/views.ts";
import {
  startServer,
  _resetLessonLineageCacheForTests,
  _getLessonLineageCacheBuildsForTests,
  _invalidateLessonLineageCache,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SERVER_TS = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
const VIEWS_TS = readFileSync(join(ROOT, "src", "views.ts"), "utf8");
const RATE_LIMIT_TS = readFileSync(join(ROOT, "src", "rate_limit.ts"), "utf8");
const README = readFileSync(join(ROOT, "README.md"), "utf8");
const CONFIG_PATH = join(process.cwd(), "fleet-control.config.json");

const NOW = new Date("2026-06-19T12:00:00.000Z");
// Seed-base anchor: every fixture timestamp is derived from this via
// arithmetic on NOW.getTime() per LESSONS 2026-05-29.
function daysBefore(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

// ────────────────────────────────────────────────────────────────────
// Fixture helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; path: string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-lesson-lineage-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, path, dir, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
  ).run(slug, slug, "test", null);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

/** Insert one lesson_credit row. We mirror the ingest pass shape: the
 *  credit row references a fake heal_audit_id (we seed a corresponding
 *  control_audit row so the FK is happy). */
function seedLessonCredit(
  db: DB,
  args: {
    lessonSlug: string;
    lessonDate: string;
    lessonTitle: string;
    projectSlug: string;
    createdAt: string;
  },
): number {
  // Seed the heal_audit row first so the FK is valid.
  const r = db.prepare(
    "INSERT INTO control_audit(ts, action, target, exit_code, stdout_tail, actor) "
    + "VALUES (?, 'heal', ?, 0, 'fixture', 'test')",
  ).run(args.createdAt, "pr-" + Math.floor(Math.random() * 1_000_000));
  const healAuditId = Number(r.lastInsertRowid);
  db.prepare(
    "INSERT INTO lesson_credit("
    + "lesson_slug, lesson_date, lesson_title, heal_audit_id, "
    + "project_slug, matched_substring, created_at"
    + ") VALUES (?,?,?,?,?,?,?)",
  ).run(
    args.lessonSlug, args.lessonDate, args.lessonTitle, healAuditId,
    args.projectSlug, "x", args.createdAt,
  );
  return healAuditId;
}

/** Seed a 4-catch fixture against the same lesson slug across 3
 *  projects (project-a, project-b, project-c) spanning ~90 days back
 *  from NOW. The earliest credit row is the synthetic birth event. */
function seedFourCatchFixture(db: DB): {
  slug: string;
  title: string;
  birthDate: string;
} {
  seedProject(db, "project-a");
  seedProject(db, "project-b");
  seedProject(db, "project-c");
  const slug = "typescript-cycle-import";
  const title = "TypeScript cycle import lesson";
  const lessonDate = "2026-03-21"; // file H3 date - distinct from the credit timestamps
  seedLessonCredit(db, {
    lessonSlug: slug, lessonDate, lessonTitle: title,
    projectSlug: "project-a", createdAt: daysBefore(60),
  });
  seedLessonCredit(db, {
    lessonSlug: slug, lessonDate, lessonTitle: title,
    projectSlug: "project-b", createdAt: daysBefore(40),
  });
  seedLessonCredit(db, {
    lessonSlug: slug, lessonDate, lessonTitle: title,
    projectSlug: "project-c", createdAt: daysBefore(20),
  });
  seedLessonCredit(db, {
    lessonSlug: slug, lessonDate, lessonTitle: title,
    projectSlug: "project-b", createdAt: daysBefore(5),
  });
  return { slug, title, birthDate: daysBefore(60) };
}

// ────────────────────────────────────────────────────────────────────
// AC1 — lessonLineagePayload returns the documented shape; the 4-catch
// fixture produces 1 author + 4 catch events, 3 distinct projects, and
// totals.hoursSavedTotal === 4.0 at the default 1h/PR knob.
// ────────────────────────────────────────────────────────────────────

test("AC1: lessonLineagePayload returns shape with 1 author + 4 catches; totals match", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetLessonLineageCacheForTests();
    const { slug, title } = seedFourCatchFixture(db);
    const payload = lessonLineagePayload(db, slug, NOW);
    assert.ok(payload, "lessonLineagePayload must return a payload for a slug with catches");
    assert.equal(payload.slug, slug);
    assert.equal(typeof payload.title, "string");
    assert.equal(payload.title, title);
    assert.equal(typeof payload.anonymisedTitle, "string", "anonymisedTitle present");
    assert.equal(typeof payload.birthDate, "string", "birthDate present");
    assert.equal(typeof payload.birthProjectAlias, "string", "birthProjectAlias present");
    assert.ok(Array.isArray(payload.events), "events is an array");
    assert.equal(payload.events.length, 5,
      `expected 1 author + 4 catches = 5 events; got ${payload.events.length}`);
    // Event 0 is the author event.
    assert.equal(payload.events[0].kind, "author",
      "first event must be the synthesised author event");
    // Events 1..4 are catches, in chronological order (ASC).
    for (let i = 1; i < 5; i++) {
      assert.equal(payload.events[i].kind, "catch",
        `event ${i} must be a catch`);
      assert.equal(typeof payload.events[i].projectAlias, "string");
      assert.equal(typeof payload.events[i].at, "string");
      assert.equal(typeof payload.events[i].hoursSaved, "number");
      assert.ok(payload.events[i].hoursSaved >= 0,
        `event ${i} hoursSaved must be non-negative`);
    }
    // Events 1..N MUST be ordered ASC by `at`.
    for (let i = 2; i < 5; i++) {
      assert.ok(payload.events[i].at >= payload.events[i - 1].at,
        `catch event ${i} must be at or after the previous`);
    }
    // Totals.
    assert.equal(payload.totals.catches, 4);
    assert.equal(payload.totals.projects, 3);
    assert.equal(payload.totals.hoursSavedTotal, 4.0,
      `totals.hoursSavedTotal must be 4.0 at the default 1h/PR knob; got ${payload.totals.hoursSavedTotal}`);
    assert.equal(typeof payload.asOf, "string");
    assert.equal(payload.version, 1);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 - Empty-state branch: when the lesson has 0 catch rows,
// lessonLineagePayload returns null.
// ────────────────────────────────────────────────────────────────────

test("AC2: lessonLineagePayload returns null for a slug with zero catches", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetLessonLineageCacheForTests();
    // No fixture seeding - the DB is empty.
    const payload = lessonLineagePayload(db, "no-such-lesson", NOW);
    assert.equal(payload, null,
      "lessonLineagePayload must return null when zero lesson_credit rows match the slug");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 - Singleton-catch branch: when the lesson has exactly 1 catch row
// the page renders the warming-up testid and HIDES the timeline testid.
// ────────────────────────────────────────────────────────────────────

test("AC3: singleton-catch payload renders warming-up testid AND hides the timeline testid", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetLessonLineageCacheForTests();
    seedProject(db, "project-a");
    const slug = "lonely-lesson";
    seedLessonCredit(db, {
      lessonSlug: slug, lessonDate: "2026-04-10",
      lessonTitle: "Lonely lesson", projectSlug: "project-a",
      createdAt: daysBefore(10),
    });
    const payload = lessonLineagePayload(db, slug, NOW);
    assert.ok(payload, "singleton catch still produces a payload");
    assert.equal(payload!.totals.catches, 1);
    const html = _renderLessonLineageForTests(payload!, { quietHoursActive: false });
    assert.match(html, /data-testid=["']lineage-warming-up["']/,
      "singleton-catch render must carry data-testid=lineage-warming-up");
    assert.equal(/data-testid=["']lineage-timeline["']/.test(html), false,
      "singleton-catch render must NOT carry data-testid=lineage-timeline");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 - New public route GET /lessons-public/<slug>/lineage mounted
// BEFORE the if (path.startsWith("/api/")) auth gate, 404s when payload
// is null, 200 + correct content-type + lineage-timeline with 5
// children for the 4-catch fixture.
// ────────────────────────────────────────────────────────────────────

test("AC4: route /lessons-public/<slug>/lineage mounts BEFORE the /api/ auth gate (static grep)", () => {
  // Per LESSONS 2026-06-15 anchor on the if-statement shape, not a
  // literal substring (which would match a sibling comment block).
  const routeIdx = SERVER_TS.indexOf("/lessons-public/");
  const lineageRouteIdx = SERVER_TS.indexOf("/lineage");
  const apiGateIdx = SERVER_TS.indexOf('if (path.startsWith("/api/"))');
  assert.ok(routeIdx > 0, "src/server.ts must reference /lessons-public/");
  assert.ok(lineageRouteIdx > 0, "src/server.ts must reference /lineage");
  assert.ok(apiGateIdx > 0,
    "src/server.ts must contain the if (path.startsWith(\"/api/\")) gate");
  // The lineage handler must appear before the auth gate in source
  // order so the public route reaches its handler without an auth
  // bounce.
  assert.ok(lineageRouteIdx < apiGateIdx,
    "/lineage route mount must precede the /api/ auth gate in source order");
});

// AC4 - boot helper for the HTTP integration tests. Mirrors the
// 0057 boot pattern (empty-roots config + FLEET_DB_PATH + refcount
// for parallel safety).
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
  const dir = mkdtempSync(join(tmpdir(), "fleet-lesson-lineage-boot-"));
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

test("AC4: GET /lessons-public/<unknown>/lineage returns 404", async () => {
  _resetLessonLineageCacheForTests();
  const b = await boot();
  try {
    const r = await fetch(b.base + "/lessons-public/no-such-lesson/lineage");
    assert.equal(r.status, 404,
      "lineage route must 404 when the slug has no lesson_credit rows");
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: GET /lessons-public/<slug>/lineage returns 200 + 5-event timeline for a 4-catch fixture", async () => {
  _resetLessonLineageCacheForTests();
  let fixture: { slug: string; title: string; birthDate: string } | null = null;
  const b = await boot((db) => {
    fixture = seedFourCatchFixture(db);
  });
  try {
    assert.ok(fixture, "boot helper seeded the fixture");
    const r = await fetch(b.base + "/lessons-public/" + fixture!.slug + "/lineage");
    assert.equal(r.status, 200, "200 for a slug with 4 catches");
    assert.match(
      r.headers.get("content-type") ?? "",
      /text\/html;\s*charset=utf-8/i,
      "content-type must be text/html; charset=utf-8",
    );
    const body = await r.text();
    assert.match(body, /data-testid=["']lineage-timeline["']/,
      "200 body must carry data-testid=lineage-timeline");
    // Count the timeline children. The renderer emits one <li
    // data-testid="lineage-event-..."> per event. Author + 4 catches.
    const eventTestids = body.match(/data-testid=["']lineage-event-/g) ?? [];
    assert.equal(eventTestids.length, 5,
      `timeline must contain 5 events (1 author + 4 catches); got ${eventTestids.length}`);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 - OG card sibling /og/lessons-public/<slug>/lineage.svg renders
// 1200x630 SVG with the lesson title, 5 dots, cumulative ~Xh saved
// figure, the footer "powered by fleet-control". Carries
// data-testid="lineage-og-title". 404 when payload null.
// ────────────────────────────────────────────────────────────────────

test("AC5: GET /og/lessons-public/<unknown>/lineage.svg returns 404", async () => {
  _resetLessonLineageCacheForTests();
  const b = await boot();
  try {
    const r = await fetch(b.base + "/og/lessons-public/no-such-lesson/lineage.svg");
    assert.equal(r.status, 404,
      "OG lineage route must 404 when the slug has no lesson_credit rows");
  } finally { await b.close(); b.cleanup(); }
});

test("AC5: GET /og/lessons-public/<slug>/lineage.svg renders 1200x630 SVG with 5 dots + lineage-og-title testid", async () => {
  _resetLessonLineageCacheForTests();
  let fixture: { slug: string; title: string; birthDate: string } | null = null;
  const b = await boot((db) => {
    fixture = seedFourCatchFixture(db);
  });
  try {
    assert.ok(fixture, "fixture seeded");
    const r = await fetch(b.base + "/og/lessons-public/" + fixture!.slug + "/lineage.svg");
    assert.equal(r.status, 200, "200 for a slug with 4 catches");
    assert.match(
      r.headers.get("content-type") ?? "",
      /image\/svg\+xml/i,
      "content-type must be image/svg+xml",
    );
    const body = await r.text();
    assert.match(body, /data-testid=["']lineage-og-title["']/,
      "SVG body must carry data-testid=lineage-og-title");
    // Per LESSONS 2026-06-12 anchor on the testid, not a body substring.
    const circles = body.match(/<circle\b/g) ?? [];
    assert.equal(circles.length, 5,
      `SVG must contain 5 <circle> dots (1 author + 4 catches); got ${circles.length}`);
    // Dimensions per the AC.
    assert.match(body, /\bwidth=["']1200["']/, "SVG width must be 1200");
    assert.match(body, /\bheight=["']630["']/, "SVG height must be 630");
    // Footer must mention the fleet-control attribution.
    assert.match(body, /powered by fleet-control/i,
      "SVG footer must read 'powered by fleet-control'");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 - OG meta tags on the HTML page: og:image, twitter:card,
// og:title, og:description.
// ────────────────────────────────────────────────────────────────────

test("AC6: HTML lineage page carries og:image + twitter:card + og:title + og:description meta tags", async () => {
  _resetLessonLineageCacheForTests();
  let fixture: { slug: string; title: string; birthDate: string } | null = null;
  const b = await boot((db) => {
    fixture = seedFourCatchFixture(db);
  });
  try {
    const r = await fetch(b.base + "/lessons-public/" + fixture!.slug + "/lineage");
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.match(body, /<meta\s+[^>]*property=["']og:image["'][^>]*content=[^>]*\/og\/lessons-public\/[^>]*\/lineage\.svg/i,
      "og:image must point at /og/lessons-public/<slug>/lineage.svg");
    assert.match(body, /<meta\s+[^>]*name=["']twitter:card["'][^>]*content=["']summary_large_image["']/i,
      "twitter:card must be summary_large_image");
    assert.match(body, /<meta\s+[^>]*property=["']og:title["']/i,
      "og:title must be present");
    assert.match(body, /<meta\s+[^>]*property=["']og:description["']/i,
      "og:description must be present");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 - Cross-link from the aggregate page (0057): when the lineage
// payload's totals.catches >= 2, the existing /lessons-public/<slug>
// renderer grows a "see how this lesson traveled" link with the
// data-testid=lessons-public-lineage-link.
// ────────────────────────────────────────────────────────────────────

test("AC7: 4-catch aggregate page carries data-testid=lessons-public-lineage-link", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetLessonLineageCacheForTests();
    const { slug } = seedFourCatchFixture(db);
    const html = renderLessonsPublicPermalinkWithLineageForTests(
      {
        lesson_slug: slug,
        lesson_date: "2026-03-21",
        lesson_title: "Lesson title goes here",
        lesson_body_anonymised: "Body of lesson",
        project_alias: "project-1",
      },
      db,
      NOW,
    );
    assert.match(html, /data-testid=["']lessons-public-lineage-link["']/,
      "aggregate page MUST carry the lineage cross-link when catches >= 2");
    assert.match(html, /\/lessons-public\/[a-z0-9-]+\/lineage/,
      "cross-link href must point at /lessons-public/<slug>/lineage");
  } finally { cleanup(); }
});

test("AC7: 0-catch aggregate page hides the lineage cross-link", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetLessonLineageCacheForTests();
    // No catches seeded - the cross-link must be absent.
    const html = renderLessonsPublicPermalinkWithLineageForTests(
      {
        lesson_slug: "lonely-lesson",
        lesson_date: "2026-04-10",
        lesson_title: "Lonely lesson",
        lesson_body_anonymised: "Body",
        project_alias: "project-1",
      },
      db,
      NOW,
    );
    assert.equal(/data-testid=["']lessons-public-lineage-link["']/.test(html), false,
      "aggregate page MUST NOT carry the cross-link when catches < 2");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC8 - Rate-limit prefix: isRateLimitedPath in src/rate_limit.ts MUST
// cover /lessons-public/ so the lineage route inherits the 0064
// per-IP throttle.
// ────────────────────────────────────────────────────────────────────

test("AC8: isRateLimitedPath covers /lessons-public/ prefix", () => {
  assert.ok(RATE_LIMIT_TS.includes('"/lessons-public/"'),
    "rate_limit.ts MUST guard on /lessons-public/ prefix (otherwise the lineage route is unprotected)");
});

// ────────────────────────────────────────────────────────────────────
// AC9 - Quiet-hours posture: drive _renderLessonLineageForTests with
// quietHoursActive: true; assert data-testid=install-cta ABSENT.
// ────────────────────────────────────────────────────────────────────

test("AC9: quiet-hours render hides data-testid=install-cta", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetLessonLineageCacheForTests();
    const { slug } = seedFourCatchFixture(db);
    const payload = lessonLineagePayload(db, slug, NOW);
    assert.ok(payload, "payload exists for 4-catch fixture");
    const htmlActive = _renderLessonLineageForTests(payload!, { quietHoursActive: true });
    assert.equal(/data-testid=["']install-cta["']/.test(htmlActive), false,
      "quiet-hours render MUST hide the install CTA");
    // Sanity: the non-quiet branch DOES carry the install CTA so the
    // assertion above is meaningful.
    const htmlIdle = _renderLessonLineageForTests(payload!, { quietHoursActive: false });
    assert.match(htmlIdle, /data-testid=["']install-cta["']/,
      "non-quiet render MUST carry the install CTA");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 - Cache + invalidation: lineage payload memo-cached for 60s
// keyed by slug. Inserting a fresh lesson_credit row + calling the
// globalThis invalidation hook surfaces the new event on the next
// render.
// ────────────────────────────────────────────────────────────────────

test("AC10: cache + globalThis invalidation surfaces a fresh catch event", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetLessonLineageCacheForTests();
    const { slug } = seedFourCatchFixture(db);
    const buildsBefore = _getLessonLineageCacheBuildsForTests();
    // First call - fills the cache.
    const a = lessonLineagePayload(db, slug, NOW);
    assert.ok(a);
    assert.equal(a!.events.length, 5);
    const buildsAfterFirst = _getLessonLineageCacheBuildsForTests();
    assert.equal(buildsAfterFirst, buildsBefore + 1,
      "first call increments build counter");
    // Second call within TTL - cache hit, no increment.
    const a2 = lessonLineagePayload(db, slug, NOW);
    assert.ok(a2);
    assert.equal(a2!.events.length, 5);
    const buildsAfterCached = _getLessonLineageCacheBuildsForTests();
    assert.equal(buildsAfterCached, buildsAfterFirst,
      "second call within TTL is a cache hit");
    // Insert a fresh catch row.
    seedLessonCredit(db, {
      lessonSlug: slug, lessonDate: "2026-03-21",
      lessonTitle: "TypeScript cycle import lesson",
      projectSlug: "project-a", createdAt: new Date(NOW.getTime() - 86_400_000).toISOString(),
    });
    // Without invalidation the cache would still serve 5 events.
    // Fire the globalThis-registered invalidator the way the production
    // attributeHealsToLessons consumer does.
    const hook = (globalThis as { __fleet_lesson_lineage_invalidate__?: () => void })
      .__fleet_lesson_lineage_invalidate__;
    assert.equal(typeof hook, "function",
      "globalThis.__fleet_lesson_lineage_invalidate__ must be registered by src/server.ts on module load");
    hook!();
    const b = lessonLineagePayload(db, slug, NOW);
    assert.ok(b);
    assert.equal(b!.events.length, 6,
      "after invalidation, the next call surfaces the fresh catch");
    const buildsAfterInvalidate = _getLessonLineageCacheBuildsForTests();
    assert.equal(buildsAfterInvalidate, buildsAfterCached + 1,
      "the post-invalidate call rebuilds and increments the counter");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC11 - tsc/no-deps/no-shell-string/no-views-from-lessons-import
// hygiene. The validate + typecheck CI gates cover most of this; we
// assert the two specific things this file is the natural home for:
//   (a) views.ts does NOT add a new `from "./lessons.ts"` import that
//       would re-create the function-import cycle (LESSONS 2026-06-13).
//   (b) the README documents the new /lineage URL.
// ────────────────────────────────────────────────────────────────────

test("AC11: views.ts does NOT add a new from \"./lessons.ts\" import (no cycle)", () => {
  // The 0058 lesson is explicit: lessons.ts already imports from
  // views.ts (lessonSavingsRollup); a back-edge from views.ts to
  // lessons.ts creates a function-import cycle whose evaluation order
  // is runtime-undefined.
  assert.equal(/from\s+["']\.\/lessons\.ts["']/.test(VIEWS_TS), false,
    "src/views.ts MUST NOT import from ./lessons.ts (cycle); reuse the inline anonymiseExcerpt instead");
});

test("AC11: README documents the new /lessons-public/<slug>/lineage URL", () => {
  assert.match(README, /\/lessons-public\/[^\s]*lineage/i,
    "README must mention the new /lessons-public/<slug>/lineage URL");
});

// Belt-and-braces: assert the lineage payload's defensive null-handling
// after invalidation. Avoids a regression where the cache stores
// `null` and later silently returns it for a slug that grew catches.
test("AC10 follow-up: cache key is per-slug; one slug's invalidation does not poison another", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetLessonLineageCacheForTests();
    const { slug: slugA } = seedFourCatchFixture(db);
    const slugB = "another-lesson";
    seedProject(db, "project-d");
    seedLessonCredit(db, {
      lessonSlug: slugB, lessonDate: "2026-04-01",
      lessonTitle: "Another lesson", projectSlug: "project-d",
      createdAt: daysBefore(30),
    });
    seedLessonCredit(db, {
      lessonSlug: slugB, lessonDate: "2026-04-01",
      lessonTitle: "Another lesson", projectSlug: "project-d",
      createdAt: daysBefore(15),
    });
    const a = lessonLineagePayload(db, slugA, NOW);
    const b = lessonLineagePayload(db, slugB, NOW);
    assert.ok(a);
    assert.ok(b);
    assert.equal(a!.events.length, 5);
    assert.equal(b!.events.length, 3); // 1 author + 2 catches
    // Both slugs return distinct payloads.
    assert.notEqual(a!.slug, b!.slug);
  } finally { cleanup(); }
});

// Belt-and-braces: the cache invalidation export is wired so direct
// callers (the daemon, the test seam) can bust without the globalThis
// dance.
test("AC10 follow-up: _invalidateLessonLineageCache clears the cache", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetLessonLineageCacheForTests();
    const { slug } = seedFourCatchFixture(db);
    lessonLineagePayload(db, slug, NOW);
    const before = _getLessonLineageCacheBuildsForTests();
    lessonLineagePayload(db, slug, NOW); // cache hit
    assert.equal(_getLessonLineageCacheBuildsForTests(), before,
      "second call is a cache hit");
    _invalidateLessonLineageCache();
    lessonLineagePayload(db, slug, NOW);
    assert.equal(_getLessonLineageCacheBuildsForTests(), before + 1,
      "post-invalidate call rebuilds");
  } finally { cleanup(); }
});
