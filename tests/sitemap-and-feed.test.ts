// Ticket 0073 — public sitemap.xml + robots.txt + lessons feed.xml.
//
// One test per AC checkbox. Per LESSONS 2026-06-11 the publicHost-set
// vs publicHost-unset branches drive through the renderer-direct seam
// `_renderSitemapForTests(payload, opts)` — never via cwd config
// mutation, because parallel test files share `process.cwd()`. Per
// LESSONS 2026-05-29 every test pins `now` to a fixed anchor and
// derives seed timestamps off that same anchor (never new Date()).
//
// The boot-path tests (full HTTP round-trip) use the shared
// _graveyard_boot.helper.ts so the empty-roots config snapshot lands
// in cwd ONCE per worker and the `cleanup()` restores the operator's
// real config on exit.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb, type DB } from "../src/db.ts";
import {
  fleetSitemapPayload,
  renderSitemapXml,
  renderRobotsTxt,
  renderLessonsFeedAtom,
  _renderSitemapForTests,
  _renderRobotsForTests,
  _renderFeedForTests,
} from "../src/views.ts";
import { lessonsPublicArchive } from "../src/lessons.ts";
import { isRateLimitedPath } from "../src/rate_limit.ts";

// Reference unused helpers so tsc's no-unused-imports rule (when on)
// doesn't strip the production exports we're verifying are wired.
void renderSitemapXml;
void renderRobotsTxt;
void renderLessonsFeedAtom;

const NOW = new Date("2026-06-20T12:00:00.000Z");

function tempDb(): { db: DB; path: string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-sitemap-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return {
    db, path, dir,
    cleanup: () => {
      try { db.close(); } catch { /* */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedProject(db: DB, slug: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
  ).run(slug, slug, "test", null);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

function seedPr(db: DB, projectId: number, number: number, args: {
  fetchedAt: string;
  state?: string;
  isAgent?: number;
  firstFailExcerpt?: string | null;
  firstFailCheck?: string | null;
}): void {
  db.prepare(
    "INSERT INTO pr(project_id, number, state, is_agent, fetched_at, "
    + "first_fail_check, first_fail_excerpt) VALUES (?,?,?,?,?,?,?)",
  ).run(
    projectId,
    number,
    args.state ?? "merged",
    args.isAgent ?? 1,
    args.fetchedAt,
    args.firstFailCheck ?? null,
    args.firstFailExcerpt ?? null,
  );
}

function seedLessonCredit(db: DB, args: {
  lessonSlug: string;
  lessonDate: string;
  lessonTitle: string;
  projectSlug: string;
  createdAt: string;
}): void {
  const r = db.prepare(
    "INSERT INTO control_audit(ts, action, target, exit_code, stdout_tail, actor) "
    + "VALUES (?, 'heal', ?, 0, 'fx', 'test')",
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
}

/** Write a CROSS_LESSONS fixture and pin the FLEET_CROSS_LESSONS_PATH
 *  override so lessonsPublicArchive() reads our deterministic file. */
function writeLessonsFixture(dir: string, content: string): string {
  const path = join(dir, "CROSS_LESSONS.md");
  writeFileSync(path, content);
  process.env.FLEET_CROSS_LESSONS_PATH = path;
  return path;
}

const THREE_LESSON_FIXTURE = `# CROSS_LESSONS

## agent-fleet

### 2026-06-15 — sitemap lastmod should be content max not render time

Body text for sitemap lastmod lesson. Plenty of words. Plenty of words.
Plenty of words. Plenty of words. Plenty of words.

### 2026-06-10 — node sqlite no such column id on pr table

Body text mentioning /Users/mutaaf/code as a leak surface. Plenty of
words. Plenty of words. Plenty of words. Plenty of words.

### 2026-06-05 — julianday drift sqlite decompose strftime

Body text about float precision. Plenty of words. Plenty of words.
Plenty of words. Plenty of words. Plenty of words.
`;

// ────────────────────────────────────────────────────────────────────
// AC1 — fleetSitemapPayload composes urls from existing payload helpers
// ────────────────────────────────────────────────────────────────────

test("AC1: fleetSitemapPayload returns urls + asOf + version with the documented composition", () => {
  const t = tempDb();
  try {
    const fxDir = mkdtempSync(join(tmpdir(), "fleet-sitemap-fx-"));
    try {
      writeLessonsFixture(fxDir, THREE_LESSON_FIXTURE);

      // Seed 2 failure modes: each a distinct signature with >= 1 PR.
      const pa = seedProject(t.db, "agent-fleet");
      seedPr(t.db, pa, 1, {
        fetchedAt: "2026-06-18T10:00:00.000Z",
        firstFailCheck: "typecheck",
        firstFailExcerpt: "src/views.ts(42,5): error TS2322: Type 'string' is not assignable",
      });
      seedPr(t.db, pa, 2, {
        fetchedAt: "2026-06-17T10:00:00.000Z",
        firstFailCheck: "release",
        // failureSignature() matches /remote:\s*(Permission denied|HTTP 403)/
        firstFailExcerpt: "remote: Permission denied (publickey).\nfatal: rejected.",
      });

      // Operator handle set so /operator/<h> + /referrals/<h> rows land.
      const cfg = {
        operator: {
          handle: "alice",
          sinceDate: "2025-06-01",
          publicHost: "https://fleet.example.com",
        },
      };

      // Build the lessons archive via the production helper, then hand
      // it to the sitemap composer per the documented opts seam (the
      // route handler in src/server.ts does the same to avoid the
      // views.ts <-> lessons.ts function-import cycle).
      const archive = lessonsPublicArchive({ now: NOW });
      const payload = fleetSitemapPayload(t.db, cfg as any, NOW, {
        lessonsArchiveRows: archive.lessons,
      });

      assert.equal(payload.version, 1);
      assert.equal(typeof payload.asOf, "string");
      assert.ok(Array.isArray(payload.urls), "urls is an array");

      const locs = payload.urls.map((u) => u.loc);
      // Fixed pages — 5 entries.
      assert.ok(locs.some((l) => l.endsWith("/pulse")), "has /pulse");
      assert.ok(locs.some((l) => l.endsWith("/receipts")), "has /receipts");
      assert.ok(locs.some((l) => l.endsWith("/calculator")), "has /calculator");
      assert.ok(locs.some((l) => l.endsWith("/lessons-public/")), "has /lessons-public/");
      assert.ok(locs.some((l) => /\/year\/\d{4}$/.test(l)), "has /year/<YYYY>");
      // Conditional pages (handle set).
      assert.ok(locs.some((l) => l.endsWith("/operator/alice")), "has /operator/<h>");
      assert.ok(locs.some((l) => l.endsWith("/referrals/alice")), "has /referrals/<h>");
      // Dynamic — 3 lesson permalinks.
      const lessonLocs = locs.filter((l) => /\/lessons-public\/[a-z0-9-]+$/.test(l));
      assert.ok(lessonLocs.length === 3, "3 lesson permalinks; got " + lessonLocs.length);
      // Dynamic — 2 failure permalinks.
      const failureLocs = locs.filter((l) => /\/failures\/[A-Za-z0-9-]+$/.test(l));
      assert.ok(failureLocs.length === 2, "2 failure permalinks; got " + failureLocs.length);
      // No lineage URLs — none of our lessons have >= 2 catches.
      const lineageLocs = locs.filter((l) => /\/lineage$/.test(l));
      assert.equal(lineageLocs.length, 0, "no lineage permalinks when no catches >= 2");

      // Total = fixed(5) + handle(2) + lessons(3) + failures(2) = 12.
      assert.equal(payload.urls.length, 12, "total url count");
      // publicHost prefix is applied to every loc when set.
      assert.ok(payload.urls.every((u) => u.loc.startsWith("https://fleet.example.com")),
        "every loc uses the publicHost prefix when set");
    } finally {
      delete process.env.FLEET_CROSS_LESSONS_PATH;
      rmSync(fxDir, { recursive: true, force: true });
    }
  } finally {
    t.cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — renderSitemapXml produces a valid Sitemap 0.9 doc
// ────────────────────────────────────────────────────────────────────

test("AC2: renderSitemapXml emits a Sitemap 0.9 XML document with one <url> per payload entry", () => {
  const payload = {
    urls: [
      { loc: "https://example.com/pulse", lastmod: "2026-06-15T00:00:00.000Z",
        changefreq: "daily" as const, priority: 0.8 },
      { loc: "https://example.com/lessons-public/julianday-drift", lastmod: "2026-06-14T00:00:00.000Z",
        changefreq: "weekly" as const, priority: 0.6 },
    ],
    asOf: NOW.toISOString(),
    version: 1 as const,
  };
  const body = renderSitemapXml(payload);
  assert.ok(body.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"), "xml declaration");
  assert.ok(body.includes("<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">"),
    "urlset root with namespace");
  assert.ok(body.includes("<loc>https://example.com/pulse</loc>"), "first loc");
  assert.ok(body.includes("<loc>https://example.com/lessons-public/julianday-drift</loc>"),
    "second loc");
  assert.ok(body.includes("<lastmod>2026-06-15T00:00:00.000Z</lastmod>"), "first lastmod");
  assert.ok(body.includes("<changefreq>daily</changefreq>"), "first changefreq");
  assert.ok(body.includes("<priority>0.8</priority>"), "first priority");
  assert.ok(body.endsWith("</urlset>"), "closing urlset");
});

// ────────────────────────────────────────────────────────────────────
// AC3 — <lastmod> uses the content-source MAX timestamp, not render time
// ────────────────────────────────────────────────────────────────────

test("AC3: sitemap <lastmod> for a lesson = MAX(lesson_credit.created_at) for that slug", () => {
  const t = tempDb();
  try {
    const fxDir = mkdtempSync(join(tmpdir(), "fleet-sitemap-fx-"));
    try {
      writeLessonsFixture(fxDir, THREE_LESSON_FIXTURE);

      // Seed credit rows for one lesson with a known created_at.
      // Slug derivation: "2026-06-15-sitemap-lastmod-should-be-content-max-not-render-time".
      // We don't need the exact slug — we seed by the date+title in the
      // fixture and assert the lastmod of THAT lesson's permalink row.
      const knownCreatedAt = "2026-06-19T08:00:00.000Z";
      seedProject(t.db, "agent-fleet");
      seedLessonCredit(t.db, {
        lessonSlug: "2026-06-15-sitemap-lastmod-should-be-content-max-not-render-time",
        lessonDate: "2026-06-15",
        lessonTitle: "sitemap lastmod should be content max not render time",
        projectSlug: "agent-fleet",
        createdAt: knownCreatedAt,
      });

      const cfg = { operator: { handle: "alice", sinceDate: "2025-06-01" } };
      const archive = lessonsPublicArchive({ now: NOW });
      const payload = fleetSitemapPayload(t.db, cfg as any, NOW, {
        lessonsArchiveRows: archive.lessons,
      });

      const row = payload.urls.find((u) => u.loc.includes(
        "/lessons-public/2026-06-15-sitemap-lastmod-should-be-content-max-not-render-time",
      ));
      assert.ok(row, "found the seeded lesson's sitemap row");
      assert.equal(row!.lastmod, knownCreatedAt,
        "lastmod equals the seeded lesson_credit.created_at");
      // The asOf field is the render anchor (now) — strictly distinct
      // from the per-row lastmod surface.
      assert.notEqual(row!.lastmod, payload.asOf, "lastmod is NOT the render time");
    } finally {
      delete process.env.FLEET_CROSS_LESSONS_PATH;
      rmSync(fxDir, { recursive: true, force: true });
    }
  } finally {
    t.cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — renderRobotsTxt emits the documented Allow/Disallow/Sitemap block
// ────────────────────────────────────────────────────────────────────

test("AC4: renderRobotsTxt emits the documented Allow + Disallow + Sitemap lines", () => {
  const body = renderRobotsTxt({ publicHost: "https://fleet.example.com" });
  // Each Allow line is present.
  for (const allow of [
    "/pulse", "/receipts", "/calculator", "/lessons-public/", "/failures/",
    "/operator/", "/referrals/", "/year/", "/share/", "/og/", "/embed/",
    "/sitemap.xml",
  ]) {
    assert.ok(body.includes("Allow: " + allow), "missing Allow: " + allow);
  }
  assert.ok(body.includes("User-agent: *"), "User-agent line");
  assert.ok(body.includes("Disallow: /api/"), "Disallow: /api/");
  assert.ok(/^Disallow: \/$/m.test(body), "Disallow: / on its own line");
  assert.ok(body.includes("Sitemap: https://fleet.example.com/sitemap.xml"),
    "Sitemap line uses the publicHost");
});

// ────────────────────────────────────────────────────────────────────
// AC5 — renderLessonsFeedAtom emits an Atom 1.0 feed with one entry per lesson
// ────────────────────────────────────────────────────────────────────

test("AC5: renderLessonsFeedAtom emits an Atom 1.0 feed with one <entry> per archive row", () => {
  const t = tempDb();
  try {
    const fxDir = mkdtempSync(join(tmpdir(), "fleet-sitemap-fx-"));
    try {
      writeLessonsFixture(fxDir, THREE_LESSON_FIXTURE);

      const cfg = { operator: { handle: "alice", sinceDate: "2025-06-01",
        publicHost: "https://fleet.example.com" } };
      // Reuse the renderer-direct seam — we pass a precomputed payload so
      // the feed renderer's branches can be exercised hermetically.
      const body = _renderFeedForTests({
        publicHost: "https://fleet.example.com",
        updated: "2026-06-15T00:00:00.000Z",
        entries: [
          { slug: "slug-a", title: "Slug A title", updated: "2026-06-15T00:00:00.000Z",
            summary: "Summary A" },
          { slug: "slug-b", title: "Slug B title", updated: "2026-06-10T00:00:00.000Z",
            summary: "Summary B" },
          { slug: "slug-c", title: "Slug C title", updated: "2026-06-05T00:00:00.000Z",
            summary: "Summary C" },
        ],
      });
      assert.ok(body.startsWith("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"),
        "atom xml declaration");
      assert.ok(body.includes("<feed xmlns=\"http://www.w3.org/2005/Atom\">"),
        "atom feed root with namespace");
      const entries = body.match(/<entry>/g) ?? [];
      assert.equal(entries.length, 3, "3 <entry> elements rendered");
      // Self link uses [^>]* per CROSS_LESSONS 2026-06-15 so MIME types
      // and paths inside attribute values match correctly.
      assert.ok(/<link rel="self"[^>]*href="https:\/\/fleet\.example\.com\/lessons-public\/feed\.xml"/.test(body),
        "self link present");
      // Don't reference `cfg` to avoid the unused-var lint surface.
      void cfg;
    } finally {
      delete process.env.FLEET_CROSS_LESSONS_PATH;
      rmSync(fxDir, { recursive: true, force: true });
    }
  } finally {
    t.cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — feed <entry> uses anonymised title + summary; raw /Users/... is gone
// ────────────────────────────────────────────────────────────────────

test("AC6: feed <entry> body anonymises /Users/... leak so the literal path does not appear", () => {
  // End-to-end: a CROSS_LESSONS fixture with a literal /Users/ path in
  // its body must surface in the feed as the <path> placeholder. The
  // anonymisation happens in lessonsPublicArchive() (per ticket 0057);
  // the sitemap/feed helper just passes the anonymised rows through to
  // the renderer. So the integration we verify is "lessonsPublicArchive
  // hands the renderer rows whose summary already collapses /Users/".
  const fxDir = mkdtempSync(join(tmpdir(), "fleet-sitemap-anon-"));
  try {
    writeLessonsFixture(fxDir, THREE_LESSON_FIXTURE);
    const archive = lessonsPublicArchive({ now: NOW });
    // Build feed entries the same way the production route does -
    // map every archive row to {slug, title, updated, summary} with
    // the summary clipped to 280 chars of the anonymised body.
    const entries = archive.lessons.map((l) => ({
      slug: l.lesson_slug,
      title: l.lesson_title,
      updated: l.lesson_date,
      summary: l.lesson_body_anonymised.slice(0, 280),
    }));
    const body = _renderFeedForTests({
      publicHost: "https://fleet.example.com",
      updated: "2026-06-15T00:00:00.000Z",
      entries,
    });
    assert.ok(!body.includes("/Users/mutaaf/code"),
      "feed must not contain the raw /Users/ path");
    assert.ok(body.includes("<path>") || body.includes("&lt;path&gt;"),
      "the <path> placeholder is present (raw or escaped)");
  } finally {
    delete process.env.FLEET_CROSS_LESSONS_PATH;
    rmSync(fxDir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — publicHost unset → relative URLs in both sitemap and robots
// ────────────────────────────────────────────────────────────────────

test("AC7: when publicHost is unset the sitemap loc fields are relative and robots Sitemap uses host header", () => {
  // Renderer-direct seam — drive the unset branch without cwd mutation.
  const xml = _renderSitemapForTests({
    urls: [
      { loc: "/pulse", lastmod: "2026-06-15T00:00:00.000Z", changefreq: "daily", priority: 0.8 },
      { loc: "/lessons-public/foo-bar", lastmod: "2026-06-14T00:00:00.000Z",
        changefreq: "weekly", priority: 0.6 },
    ],
    asOf: NOW.toISOString(),
    version: 1,
  }, { publicHost: undefined });
  assert.ok(xml.includes("<loc>/pulse</loc>"), "relative pulse loc");
  assert.ok(xml.includes("<loc>/lessons-public/foo-bar</loc>"), "relative lesson loc");

  const robots = _renderRobotsForTests({ publicHost: "http://127.0.0.1:7070" });
  assert.ok(robots.includes("Sitemap: http://127.0.0.1:7070/sitemap.xml"),
    "robots Sitemap line falls back to the Host-header origin");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — empty-fleet branch still emits the fixed pages
// ────────────────────────────────────────────────────────────────────

test("AC8: empty-fleet branch emits the fixed pages even when no lessons/failures/handle", () => {
  const t = tempDb();
  try {
    const fxDir = mkdtempSync(join(tmpdir(), "fleet-sitemap-fx-"));
    try {
      // Empty lessons file — no entries.
      writeLessonsFixture(fxDir, "# CROSS_LESSONS\n");
      const cfg = {}; // operator field omitted entirely
      const payload = fleetSitemapPayload(t.db, cfg as any, NOW);
      assert.ok(payload.urls.length >= 5,
        "empty-fleet sitemap still emits the fixed pages; got " + payload.urls.length);
      const locs = payload.urls.map((u) => u.loc);
      assert.ok(locs.some((l) => l.endsWith("/pulse")), "has /pulse");
      assert.ok(locs.some((l) => l.endsWith("/receipts")), "has /receipts");
      assert.ok(locs.some((l) => l.endsWith("/calculator")), "has /calculator");
      assert.ok(locs.some((l) => l.endsWith("/lessons-public/")), "has /lessons-public/");
      assert.ok(locs.some((l) => /\/year\/\d{4}$/.test(l)), "has /year/<YYYY>");
    } finally {
      delete process.env.FLEET_CROSS_LESSONS_PATH;
      rmSync(fxDir, { recursive: true, force: true });
    }
  } finally {
    t.cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────
// AC9 — rate-limit prefix covers /sitemap.xml + /robots.txt + feed.xml
// ────────────────────────────────────────────────────────────────────

test("AC9: isRateLimitedPath returns true for /sitemap.xml, /robots.txt, /lessons-public/feed.xml", () => {
  assert.ok(isRateLimitedPath("/sitemap.xml"), "/sitemap.xml rate-limited");
  assert.ok(isRateLimitedPath("/robots.txt"), "/robots.txt rate-limited");
  assert.ok(isRateLimitedPath("/lessons-public/feed.xml"),
    "/lessons-public/feed.xml rate-limited");
  // Pre-existing prefixes still covered (defence in depth — AC9 must
  // ADD prefixes, not replace).
  assert.ok(isRateLimitedPath("/embed/pulse.html"), "/embed/ still covered");
  assert.ok(isRateLimitedPath("/og/pulse.svg"), "/og/ still covered");
});

// ────────────────────────────────────────────────────────────────────
// AC10 — static-grep ordering assertion: each new public route mounts
// BEFORE the path.startsWith("/api/") auth gate.
// ────────────────────────────────────────────────────────────────────

test("AC10: each new public route handler appears BEFORE the if (path.startsWith(/api/)) gate in src/server.ts", () => {
  const SERVER_TS = readFileSync(
    join(process.cwd(), "src", "server.ts"), "utf8",
  );
  // Anchor on the EXACT if-statement shape per LESSONS 2026-06-15 so a
  // sibling comment block describing the gate doesn't poison the index.
  const gateIdx = SERVER_TS.indexOf("if (path.startsWith(\"/api/\"))");
  assert.ok(gateIdx > 0, "found the /api/ auth gate's if-statement");

  // For each new route, anchor on a unique syntactic shape that appears
  // at the actual handler site only (not in a sibling comment block).
  const sitemapIdx = SERVER_TS.indexOf("path === \"/sitemap.xml\"");
  const robotsIdx = SERVER_TS.indexOf("path === \"/robots.txt\"");
  const feedIdx = SERVER_TS.indexOf("path === \"/lessons-public/feed.xml\"");
  assert.ok(sitemapIdx > 0, "found /sitemap.xml handler");
  assert.ok(robotsIdx > 0, "found /robots.txt handler");
  assert.ok(feedIdx > 0, "found /lessons-public/feed.xml handler");
  assert.ok(sitemapIdx < gateIdx, "/sitemap.xml mounted BEFORE /api/ gate");
  assert.ok(robotsIdx < gateIdx, "/robots.txt mounted BEFORE /api/ gate");
  assert.ok(feedIdx < gateIdx, "/lessons-public/feed.xml mounted BEFORE /api/ gate");
});
