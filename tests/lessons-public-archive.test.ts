// Tests for ticket 0057 — Public lesson archive.
//
// One test() per acceptance-criteria checkbox. Strategy mirrors the 0054
// pulse suite + the 0050 year-in-review suite:
//   - Drive the pure helper `lessonsPublicArchive(opts)` directly against
//     a CROSS_LESSONS.md fixture written under FLEET_CROSS_LESSONS_PATH
//     for AC1 (shape + anonymisation), AC2 (slug derivation), AC4 (leak
//     regression), AC6 (caching + counter), AC8 (perf, gated).
//   - Drive the renderer directly via `_renderLessonsPublicForTests` for
//     AC3 (index HTML), AC4 (the rendered-HTML leak chokepoint), and
//     `_renderLessonsPublicPermalinkForTests` for AC4 (per-lesson page)
//     so the branch tests never race against parallel test files
//     writing to fleet-control.config.json in the same cwd (per LESSONS
//     2026-06-11 startServer-race).
//   - Boot startServer() over loopback for the route shape tests:
//     AC3 (route exists, content-type, cache-control, testids), AC4
//     (404 friendly page), AC5 (JSON route shape), AC9 (cross-link
//     on /lessons SPA).
//   - Mobile (AC7) is text-level CSS contract over web/style.css per the
//     0011 / receipts / pulse precedent (zero jsdom).
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps from
// new Date()": every seed timestamp is anchored to the test's pinned
// NOW constant.
// Per LESSONS § "in-process startServer() tests need an empty-roots
// config + run-row seeds": boot helper plants a tmp config in cwd and
// restores on cleanup; an activeBoots refcount makes that safe across
// concurrent boot()s within this file.
// Per LESSONS § "in-process dedup sets need an explicit reset hook for
// tests" + "expose a build counter for cache-hit tests, not a fetcher
// swap": AC6 uses both seams.
// Per LESSONS 2026-06-10 "redactSecrets on a JSON body shreds your KEYS":
// AC5 asserts the JSON keys survive the scrub.
// Per LESSONS 2026-06-11 "startServer() tests that mutate
// fleet-control.config.json race": AC3/AC4 use renderer-direct seams
// for branch coverage; boot() is only for the integration shape.
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
  lessonsPublicArchive,
  type LessonsPublicArchive,
} from "../src/lessons.ts";
import {
  startServer,
  _resetLessonsPublicArchiveCacheForTests,
  _getLessonsPublicArchiveCacheBuildsForTests,
  _renderLessonsPublicForTests,
  _renderLessonsPublicPermalinkForTests,
  _lessonsPublicArchiveCachedForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WEB_DIR = join(ROOT, "web");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");
const SERVER_TS = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
const LESSONS_TS = readFileSync(join(ROOT, "src", "lessons.ts"), "utf8");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const PKG_JSON = readFileSync(join(ROOT, "package.json"), "utf8");
const CONFIG_PATH = join(process.cwd(), "fleet-control.config.json");

const NOW = new Date("2026-06-12T12:00:00.000Z");

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; path: string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-public-lessons-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, path, dir, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string, name?: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
  ).run(slug, name ?? slug, "test", null);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

/** Write a CROSS_LESSONS.md fixture file and set the FLEET_CROSS_LESSONS_PATH
 *  env override so every helper / route under test reads it. Returns the
 *  fixture path so the test can touch its mtime later. */
function writeLessonsFixture(dir: string, content: string): string {
  const path = join(dir, "CROSS_LESSONS.md");
  writeFileSync(path, content);
  process.env.FLEET_CROSS_LESSONS_PATH = path;
  return path;
}

/** Standard fixture covering the anonymisation surfaces: an operator
 *  project slug (courtiq), a branch name (feat/secret-feature-x), an
 *  absolute filesystem path (/Users/alice/code/courtiq), a PR number
 *  (#1234), a ticket reference (ticket 0057), and a legitimate
 *  technical-term lesson body that must survive verbatim
 *  (node:sqlite, redactSecrets, Record<string, SQLOutputValue>). */
const LEAK_FIXTURE = `# CROSS_LESSONS

## agent-fleet

### 2026-06-10 — redactSecrets on a JSON body shreds your KEYS

While shipping ticket 0057 the new public lesson archive serialised
its rollup through redactSecrets to defang token-shape substrings.
The regex \`[A-Za-z0-9_]{24,}\` plus the lenient hasDigit = /\\d/ ||
/_/ heuristic treated underscores as digit-qualifiers, so my own
top-level JSON keys (average_failed_ship_cost_usd_lives_here, 27
chars, letters-and-underscores ONLY) matched the shape AND the
gate. Cause: the redactor was authored for narrative TEXT; on a
JSON body it shreds the KEYS too. Fix: route the redactor through
operator-supplied VALUES BEFORE \`JSON.stringify\`, not over the
body string.

## courtiq

### 2026-06-09 — node:sqlite's .all() needs \`as unknown as T[]\` when narrowing

While shipping a ticket on the feat/secret-feature-x branch in
/Users/alice/code/courtiq, wrapping db.prepare(...).all(...) rows in
a typed FooRow[] cast failed tsc with TS2352. Cause: node:sqlite's
declared return type for StatementSync.all() is
Record<string, SQLOutputValue>[] — an index signature, not an open
object. Fix: \`as unknown as FooRow[]\`. The double-cast through
unknown is TypeScript's officially-blessed escape hatch. See PR
#1234 for the rollout across courtiq-prod.

### 2026-06-08 — webhook silently stops firing for a PR

While debugging a stuck PR on the feat/secret-feature-x branch in
/Users/alice/code/courtiq, four consecutive pushes registered ZERO
workflow runs. The repo's owning GitHub account was transiently
suspended at run time. Fix: re-run the workflow with \`gh run rerun
<run-id> --failed\` once the account is back. See ticket 0057 for
the moot follow-up.

## courtiq-prod

### 2026-06-07 — same title across two projects produces distinct slugs

This title is intentionally identical to the next entry so the
test can assert globally-unique slug derivation. Body text differs
to keep the fixtures honest.

### 2026-06-07 — same title across two projects produces distinct slugs

Second copy under courtiq-prod with the same date AND title; the
slug derivation MUST make these distinct (e.g. by appending a
suffix once the slug map sees a collision).
`;

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

async function boot(
  seedFn?: (db: DB) => void,
  extraConfig?: Record<string, unknown>,
): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-public-lessons-boot-"));
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

// ────────────────────────────────────────────────────────────────────
// AC1 — lessonsPublicArchive() returns the documented shape AND
// anonymises operator-leaking values while preserving technical text.
// ────────────────────────────────────────────────────────────────────

test("AC1: lessonsPublicArchive returns the documented top-level shape", () => {
  const { db, dir, cleanup } = tempDb();
  try {
    _resetLessonsPublicArchiveCacheForTests();
    writeLessonsFixture(dir, LEAK_FIXTURE);
    seedProject(db, "courtiq", "courtiq");
    seedProject(db, "courtiq-prod", "courtiq-prod");
    const archive = lessonsPublicArchive({ now: NOW });
    assert.equal(typeof archive.generated_at, "string", "generated_at present");
    assert.equal(typeof archive.total_lessons, "number", "total_lessons present");
    assert.equal(typeof archive.earliest_lesson_date, "string", "earliest_lesson_date present");
    assert.equal(typeof archive.latest_lesson_date, "string", "latest_lesson_date present");
    assert.ok(Array.isArray(archive.lessons), "lessons is an array");
    assert.ok(archive.total_lessons >= 4,
      `expected >= 4 dated lessons in the fixture; got ${archive.total_lessons}`);
    for (const l of archive.lessons) {
      assert.equal(typeof l.lesson_slug, "string", "lesson_slug present per row");
      assert.equal(typeof l.lesson_date, "string", "lesson_date present per row");
      assert.equal(typeof l.lesson_title, "string", "lesson_title present per row");
      assert.equal(typeof l.lesson_body_anonymised, "string", "lesson_body_anonymised present per row");
      assert.equal(typeof l.project_alias, "string", "project_alias present per row");
    }
  } finally { cleanup(); }
});

test("AC1: anonymiser replaces project slugs / branches / paths / ticket refs but preserves technical terms", () => {
  const { db, dir, cleanup } = tempDb();
  try {
    _resetLessonsPublicArchiveCacheForTests();
    writeLessonsFixture(dir, LEAK_FIXTURE);
    seedProject(db, "courtiq", "courtiq");
    seedProject(db, "courtiq-prod", "courtiq-prod");
    const archive = lessonsPublicArchive({
      now: NOW,
      projectAliasMap: { "agent-fleet": "agent-fleet", "courtiq": "project-1", "courtiq-prod": "project-2" },
    });
    const allBodies = archive.lessons.map((l) => l.lesson_body_anonymised).join("\n");
    // Operator-leaking patterns must NOT appear in the anonymised body.
    assert.equal(allBodies.includes("courtiq"), false,
      "operator project slug 'courtiq' MUST be stripped from anonymised bodies");
    assert.equal(allBodies.includes("courtiq-prod"), false,
      "operator project slug 'courtiq-prod' MUST be stripped");
    assert.equal(allBodies.includes("feat/secret-feature-x"), false,
      "branch name MUST be replaced with <branch>");
    assert.equal(allBodies.includes("/Users/alice"), false,
      "absolute /Users/ path MUST be replaced with <path>");
    assert.equal(/ticket\s+0057/i.test(allBodies), false,
      "explicit 'ticket NNNN' reference MUST be replaced with 'an agent ticket'");
    // Technical / SEO-load-bearing terms MUST survive verbatim.
    assert.ok(allBodies.includes("node:sqlite"),
      "technical term 'node:sqlite' MUST survive the anonymiser");
    assert.ok(allBodies.includes("redactSecrets"),
      "function identifier 'redactSecrets' MUST survive verbatim");
    assert.ok(allBodies.includes("Record<string, SQLOutputValue>"),
      "TypeScript type expression MUST survive verbatim");
    assert.ok(allBodies.includes("TS2352"),
      "error code 'TS2352' MUST survive verbatim");
    assert.ok(allBodies.includes("as unknown as"),
      "code idiom 'as unknown as' MUST survive verbatim");
    // project_alias is `project-N` shape OR `agent-fleet`.
    for (const l of archive.lessons) {
      assert.match(l.project_alias, /^(project-\d+|agent-fleet)$/,
        `project_alias must be alias-shape; got ${l.project_alias}`);
    }
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — Per-lesson permalink slug derivation: URL-safe, kebab-case,
// globally unique across the archive.
// ────────────────────────────────────────────────────────────────────

test("AC2: lesson_slug is kebab-case, lowercase, URL-safe; identical titles produce distinct slugs", () => {
  const { db, dir, cleanup } = tempDb();
  try {
    _resetLessonsPublicArchiveCacheForTests();
    // Two lessons sharing the same date AND title — slug derivation
    // MUST disambiguate them. Also includes a title with characters
    // that must be stripped (`:`, `/`, parentheses).
    const fx = `# CROSS_LESSONS
## a
### 2026-06-01 — node:sqlite/all() needs (double cast) when narrowing
First body — drops the colon/slash/parens to a clean kebab slug.

## b
### 2026-06-01 — Same Title To Disambiguate
Body for the first dup.

## c
### 2026-06-01 — Same Title To Disambiguate
Body for the second dup (must produce a distinct slug).
`;
    writeLessonsFixture(dir, fx);
    seedProject(db, "a", "a");
    seedProject(db, "b", "b");
    seedProject(db, "c", "c");
    const archive = lessonsPublicArchive({ now: NOW });
    const slugs = archive.lessons.map((l) => l.lesson_slug);
    // All slugs must be lowercase kebab-case URL-safe.
    for (const s of slugs) {
      assert.match(s, /^[a-z0-9-]+$/,
        `slug must match /^[a-z0-9-]+$/; got ${s}`);
    }
    // Globally unique.
    const unique = new Set(slugs);
    assert.equal(unique.size, slugs.length,
      `expected ${slugs.length} unique slugs; got ${unique.size}: ${JSON.stringify(slugs)}`);
    // The disallowed chars from the colon/slash/parens title were stripped.
    const colonSlug = slugs.find((s) => s.includes("node-sqlite") || s.includes("nodesqlite"));
    assert.ok(colonSlug, `slug for the node:sqlite/all() title MUST exist; got ${JSON.stringify(slugs)}`);
    assert.equal(/[:/()]/.test(colonSlug!), false,
      "slug MUST NOT carry ':' or '/' or '(' or ')'");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — GET /lessons-public renders a self-contained single-column HTML
// page with the documented testids, no auth, robots + canonical meta,
// Cache-Control: max-age=3600, no <script>, no /api/control/ string.
// ────────────────────────────────────────────────────────────────────

test("AC3: GET /lessons-public renders 200 text/html with no auth; header + footer testids present", async () => {
  _resetLessonsPublicArchiveCacheForTests();
  const fxDir = mkdtempSync(join(tmpdir(), "fleet-public-lessons-fx-"));
  writeLessonsFixture(fxDir, LEAK_FIXTURE);
  const b = await boot((db) => {
    seedProject(db, "courtiq", "courtiq");
    seedProject(db, "courtiq-prod", "courtiq-prod");
  });
  try {
    const r = await fetch(b.base + "/lessons-public");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    const cc = (r.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=3600/, `cache-control must declare max-age=3600; got '${cc}'`);
    const body = await r.text();
    // Required testids.
    assert.match(body, /data-testid=["']lessons-public-header["']/,
      "page top must carry lessons-public-header testid");
    assert.match(body, /data-testid=["']lessons-public-cta["']/,
      "page footer must carry lessons-public-cta testid");
    // Per-lesson section anchors.
    assert.match(body, /<h2[^>]+id=["'][a-z0-9-]+["'][^>]+data-testid=["']lesson-public-[a-z0-9-]+["']/,
      "each lesson section must carry <h2 id> + data-testid='lesson-public-<slug>'");
    // SEO meta tags.
    assert.match(body, /<meta\s+name=["']robots["']\s+content=["']index,\s*follow["']/i,
      "page must declare robots: index, follow");
    assert.match(body, /<link\s+rel=["']canonical["']\s+href=["']\/lessons-public["']/,
      "index page must carry canonical pointing at /lessons-public");
    // Privacy posture: no <script>, no /api/control/.
    assert.equal(/<script\b/i.test(body), false, "no <script> tag in lessons-public");
    assert.equal(body.includes("/api/control/"), false, "no /api/control/ string");
    // No operator project slug leaks into the response.
    assert.equal(body.includes("courtiq-prod"), false,
      "operator slug must not appear in the response body");
  } finally {
    await b.close();
    b.cleanup();
    rmSync(fxDir, { recursive: true, force: true });
    delete process.env.FLEET_CROSS_LESSONS_PATH;
  }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — Per-lesson permalink: /lessons-public/<slug> renders ONE lesson;
// unknown slug returns 404 friendly page; assert <h1> contains the
// anonymised title verbatim; canonical points at the permalink form.
// Also the anonymisation regression at the HTML chokepoint.
// ────────────────────────────────────────────────────────────────────

test("AC4: GET /lessons-public/<known-slug> renders 200 with the lesson as primary content; canonical = permalink", async () => {
  _resetLessonsPublicArchiveCacheForTests();
  const fxDir = mkdtempSync(join(tmpdir(), "fleet-public-lessons-fx-"));
  writeLessonsFixture(fxDir, LEAK_FIXTURE);
  const b = await boot((db) => {
    seedProject(db, "courtiq", "courtiq");
    seedProject(db, "courtiq-prod", "courtiq-prod");
  });
  try {
    // First load /lessons-public, scrape one slug out, then hit the permalink.
    // The regex anchors on the data-testid (which carries the slug
    // suffixed) so the parser is robust against future attribute
    // ordering inside the <h2>.
    const indexBody = await (await fetch(b.base + "/lessons-public")).text();
    const m = indexBody.match(/data-testid=["']lesson-public-([a-z0-9-]+)["']/);
    assert.ok(m, "expected at least one lesson-public-<slug> data-testid in /lessons-public");
    const slug = m![1];
    const r = await fetch(b.base + "/lessons-public/" + slug);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    const cc = (r.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=3600/, `cache-control must declare max-age=3600; got '${cc}'`);
    const body = await r.text();
    // The lesson title becomes the <h1>.
    assert.match(body, /<h1\b/, "permalink page must include an <h1>");
    // Back-to-archive link is present.
    assert.match(body, /href=["']\/lessons-public["']/,
      "permalink page must carry a back-to-archive link to /lessons-public");
    // Canonical points to the permalink form.
    const canonRe = new RegExp(
      "<link\\s+rel=[\"']canonical[\"']\\s+href=[\"']/lessons-public/" + slug + "[\"']",
    );
    assert.match(body, canonRe,
      "permalink page must declare canonical pointing at /lessons-public/<slug>");
    assert.match(body, /<meta\s+name=["']robots["']\s+content=["']index,\s*follow["']/i,
      "permalink page must declare robots: index, follow");
  } finally {
    await b.close();
    b.cleanup();
    rmSync(fxDir, { recursive: true, force: true });
    delete process.env.FLEET_CROSS_LESSONS_PATH;
  }
});

test("AC4: GET /lessons-public/foo-not-real returns 404 with a friendly HTML page", async () => {
  _resetLessonsPublicArchiveCacheForTests();
  const fxDir = mkdtempSync(join(tmpdir(), "fleet-public-lessons-fx-"));
  writeLessonsFixture(fxDir, LEAK_FIXTURE);
  const b = await boot((db) => {
    seedProject(db, "courtiq", "courtiq");
  });
  try {
    const r = await fetch(b.base + "/lessons-public/foo-not-real-xyz");
    assert.equal(r.status, 404);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    const body = await r.text();
    // Friendly page — not a plain "not found" string. It must be a real
    // HTML document with a back-link to /lessons-public.
    assert.match(body, /<!doctype html/i, "404 page must be a real HTML document");
    assert.match(body, /href=["']\/lessons-public["']/,
      "404 page must link back to /lessons-public");
  } finally {
    await b.close();
    b.cleanup();
    rmSync(fxDir, { recursive: true, force: true });
    delete process.env.FLEET_CROSS_LESSONS_PATH;
  }
});

test("AC4: anonymisation regression — rendered HTML body never contains operator leak patterns", () => {
  const { dir, db, cleanup } = tempDb();
  try {
    _resetLessonsPublicArchiveCacheForTests();
    // Plant a worst-case leak fixture: project slug, /Users/ path, feat/
    // branch, AND a token-shape substring (ghp_... long hex). The
    // anonymiser handles the structural leaks; redactSecrets is the
    // defence-in-depth backstop for the token.
    const LEAKS = `# CROSS_LESSONS
## courtiq-prod

### 2026-06-09 — operator leaks in the body

Everything below MUST be scrubbed at the HTML boundary. The branch
feat/secret-feature-x was deployed from /Users/alice/code/courtiq.
A debug log accidentally printed the token ghp_abcdef1234567890abcdef123456
to stdout. The PR was #4242 — ticket 0057 captured it as a postmortem.
`;
    writeLessonsFixture(dir, LEAKS);
    seedProject(db, "courtiq-prod", "courtiq-prod");
    const archive = lessonsPublicArchive({
      now: NOW,
      projectAliasMap: { "courtiq-prod": "project-1" },
    });
    const html = _renderLessonsPublicForTests(archive);
    // Operator-leaking patterns must NOT appear in the rendered HTML body.
    assert.equal(html.includes("courtiq-prod"), false,
      "operator slug 'courtiq-prod' must not appear in rendered HTML");
    assert.equal(html.includes("/Users/alice"), false,
      "absolute path '/Users/alice' must not appear in rendered HTML");
    assert.equal(html.includes("feat/secret-feature-x"), false,
      "branch name 'feat/secret-feature-x' must not appear in rendered HTML");
    // Token-shape substring (handled by the redactSecrets backstop).
    assert.equal(html.includes("ghp_abcdef1234567890abcdef123456"), false,
      "GitHub PAT shape must be scrubbed by the renderer-boundary redactor");
    // Lesson STRUCTURE survives — at least one lesson <h2 id> is present.
    assert.match(html, /<h2[^>]+id=["'][a-z0-9-]+["']/,
      "anonymisation must NOT shred the lesson <h2 id> anchor structure");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — GET /api/lessons-public returns the AC1 shape as JSON.
// No auth. Cache-Control: max-age=3600. JSON keys survive the scrub.
// ────────────────────────────────────────────────────────────────────

test("AC5: GET /api/lessons-public returns the AC1 JSON shape with no auth; JSON keys survive the scrub", async () => {
  _resetLessonsPublicArchiveCacheForTests();
  const fxDir = mkdtempSync(join(tmpdir(), "fleet-public-lessons-fx-"));
  writeLessonsFixture(fxDir, LEAK_FIXTURE);
  const b = await boot((db) => {
    seedProject(db, "courtiq", "courtiq");
    seedProject(db, "courtiq-prod", "courtiq-prod");
  });
  try {
    const r = await fetch(b.base + "/api/lessons-public");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /application\/json/);
    const cc = (r.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=3600/, `cache-control must declare max-age=3600; got '${cc}'`);
    const j = await r.json() as LessonsPublicArchive;
    // Top-level keys per AC1 — these MUST survive the redactor pass
    // (per LESSONS 2026-06-10: scrub the VALUES, not the JSON body).
    assert.equal(typeof j.generated_at, "string", "generated_at key survives");
    assert.equal(typeof j.total_lessons, "number", "total_lessons key survives");
    assert.equal(typeof j.earliest_lesson_date, "string", "earliest_lesson_date key survives");
    assert.equal(typeof j.latest_lesson_date, "string", "latest_lesson_date key survives");
    assert.ok(Array.isArray(j.lessons), "lessons key survives as an array");
    assert.ok(j.lessons.length > 0, "at least one lesson row");
    // Per-row keys survive AND project_alias is alias-shape.
    for (const l of j.lessons) {
      assert.equal(typeof l.lesson_slug, "string", "lesson_slug per row");
      assert.equal(typeof l.lesson_date, "string", "lesson_date per row");
      assert.equal(typeof l.lesson_title, "string", "lesson_title per row");
      assert.equal(typeof l.lesson_body_anonymised, "string", "lesson_body_anonymised per row");
      assert.match(l.project_alias, /^(project-\d+|agent-fleet)$/,
        `project_alias must be alias-shape; got '${l.project_alias}'`);
    }
    // No operator slug leaks into the body.
    const bodyText = JSON.stringify(j);
    assert.equal(bodyText.includes("courtiq-prod"), false,
      "no operator slug in the JSON body");
    assert.equal(bodyText.includes("/Users/alice"), false,
      "no /Users/ path in the JSON body");
  } finally {
    await b.close();
    b.cleanup();
    rmSync(fxDir, { recursive: true, force: true });
    delete process.env.FLEET_CROSS_LESSONS_PATH;
  }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Idempotency / caching: memoise per (lessons file mtime, alias map).
// Expose `_resetLessonsPublicArchiveCacheForTests` AND
// `_getLessonsPublicArchiveCacheBuildsForTests`. Touching the file's
// mtime invalidates the next call.
// ────────────────────────────────────────────────────────────────────

test("AC6: two calls within TTL share one build; touching the file mtime rebuilds", () => {
  const { db, dir, cleanup } = tempDb();
  try {
    _resetLessonsPublicArchiveCacheForTests();
    const path = writeLessonsFixture(dir, LEAK_FIXTURE);
    seedProject(db, "courtiq", "courtiq");
    seedProject(db, "courtiq-prod", "courtiq-prod");
    const builds0 = _getLessonsPublicArchiveCacheBuildsForTests();
    _lessonsPublicArchiveCachedForTests(db, NOW);
    const builds1 = _getLessonsPublicArchiveCacheBuildsForTests();
    assert.equal(builds1, builds0 + 1, "first call must increment build counter");
    _lessonsPublicArchiveCachedForTests(db, NOW);
    const builds2 = _getLessonsPublicArchiveCacheBuildsForTests();
    assert.equal(builds2, builds1,
      "second call within TTL must NOT increment the build counter (cache hit)");
    // Touch the file mtime → next call rebuilds.
    const future = new Date(NOW.getTime() + 60_000);
    utimesSync(path, future, future);
    _lessonsPublicArchiveCachedForTests(db, NOW);
    const builds3 = _getLessonsPublicArchiveCacheBuildsForTests();
    assert.equal(builds3, builds2 + 1,
      "mtime change must invalidate the cache (next call rebuilds)");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Mobile (per 0011): single column at 375px; centred max-width
// 80ch on >= 900px.
// ────────────────────────────────────────────────────────────────────

test("AC7: web/style.css declares .lessons-public layout — centred max-width 80ch on desktop, full-width on mobile", () => {
  // The page must declare a CSS rule for `.lessons-public` (or its main
  // container) that caps the width on wide viewports and goes full-width
  // on narrow ones. We assert the source carries both shapes.
  const baseMatch = CSS.match(/\.lessons-public\b[^{]*\{[^}]*\}/);
  assert.ok(baseMatch, ".lessons-public base CSS rule must exist");
  // Desktop cap: max-width somewhere around 80ch (allow ch / rem / px to
  // be future-tweakable; the spirit is "centred, capped").
  assert.match(baseMatch![0], /max-width\s*:\s*(80ch|[5-9]\d+rem|7\d\dpx|8\d\dpx|9\d\dpx)/,
    ".lessons-public must declare a max-width cap (target 80ch)");
  assert.match(baseMatch![0], /margin\s*:[^;]*auto/,
    ".lessons-public must centre via auto margins");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Performance (skipped unless PERF=1) + page size sanity.
// ────────────────────────────────────────────────────────────────────

test("AC8: lessonsPublicArchive(150 lessons) — cache miss < 100ms, cache hit < 5ms (PERF=1 only)", { skip: process.env.PERF !== "1" }, () => {
  const { db, dir, cleanup } = tempDb();
  try {
    _resetLessonsPublicArchiveCacheForTests();
    const lines: string[] = ["# CROSS_LESSONS", "", "## agent-fleet", ""];
    for (let i = 0; i < 150; i++) {
      const day = String(1 + (i % 28)).padStart(2, "0");
      lines.push(`### 2026-05-${day} — perf lesson ${i}`);
      lines.push(`Body for perf lesson ${i}. node:sqlite, redactSecrets, ${i} bytes.`);
      lines.push("");
    }
    writeLessonsFixture(dir, lines.join("\n"));
    seedProject(db, "agent-fleet", "agent-fleet");
    const t0 = Date.now();
    const archive = lessonsPublicArchive({ now: NOW });
    const missMs = Date.now() - t0;
    assert.ok(missMs < 100, `cache miss must be < 100ms; got ${missMs}ms`);
    const t1 = Date.now();
    lessonsPublicArchive({ now: NOW });
    const hitMs = Date.now() - t1;
    assert.ok(hitMs < 5, `cache hit must be < 5ms; got ${hitMs}ms`);
    // Page size sanity: rendered HTML for 150 lessons < 200KB.
    const html = _renderLessonsPublicForTests(archive);
    assert.ok(html.length < 200 * 1024,
      `rendered HTML must be < 200KB uncompressed; got ${html.length} bytes`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Cross-link from existing authenticated /lessons SPA page
// surfaces ONE footer line with data-testid='lessons-public-cross-link'
// + href='/lessons-public'.
// ────────────────────────────────────────────────────────────────────

test("AC9: SPA lessons renderer carries lessons-public-cross-link footer → /lessons-public", () => {
  // The /lessons page is SPA-rendered (hash route #/lessons) from
  // web/app.js. We grep the source for the testid + href pair as a
  // text-level assertion (zero jsdom needed — the SPA renders identical
  // bytes everywhere).
  assert.match(APP_JS, /data-testid=["']lessons-public-cross-link["']/,
    "web/app.js must include the lessons-public-cross-link testid");
  // The same source must reference /lessons-public as the href target,
  // close to the testid (within ~500 chars of source so the link is on
  // the same node).
  const idx = APP_JS.indexOf("lessons-public-cross-link");
  assert.ok(idx >= 0, "testid must be present");
  const window = APP_JS.slice(Math.max(0, idx - 500), idx + 500);
  assert.match(window, /\/lessons-public/,
    "the cross-link node must reference href=/lessons-public near the testid");
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

test("AC10: src/lessons.ts public archive code does not import node:child_process", () => {
  // The new helper is pure I/O against the lessons file + DB; no shell-out.
  // Static-grep the import surface per LESSONS § "'no shell-string exec'
  // static checks should grep the import, not the call site".
  assert.equal(/from\s+["']node:child_process["']/.test(LESSONS_TS), false,
    "src/lessons.ts must not import node:child_process");
});

test("AC10: lessonsPublicArchive helper is exported from src/lessons.ts (net-new surface, no shape break)", () => {
  assert.match(LESSONS_TS, /export\s+function\s+lessonsPublicArchive\b/,
    "lessonsPublicArchive must be exported");
  // The new HTML routes are mounted in src/server.ts as net-new paths.
  // Their existence (route literal) is the contract; the JSON shape of
  // any pre-existing /api/* route is untouched (no shape break).
  assert.match(SERVER_TS, /"\/lessons-public"|'\/lessons-public'/,
    "src/server.ts must mount the /lessons-public HTML route");
  assert.match(SERVER_TS, /"\/api\/lessons-public"|'\/api\/lessons-public'/,
    "src/server.ts must mount the /api/lessons-public JSON route");
});
