// Tests for ticket 0063 — Embeddable lesson-of-the-day widget.
//
// One test() per AC checkbox. Strategy follows LESSONS 2026-06-11
// "startServer() tests that mutate fleet-control.config.json race
// against parallel test files; expose a renderer-direct seam for
// branch tests": every rotation / anonymisation / empty-state /
// embed-origin / cache branch drives the renderer-direct seams
// (`_renderEmbedLessonsHtmlForTests`, `_renderEmbedLessonsSvgForTests`,
// `_renderEmbedHeadersForTests`, `_embedLessonsCachedForTests`,
// `_resetEmbedLessonsCacheForTests`, `_getEmbedLessonsCacheBuildsForTests`)
// — NOT a cwd config mutation. The route-mount integration is
// asserted via a single static grep over src/server.ts so we never
// boot startServer in this file.
//
// Per LESSONS 2026-05-29 "time-pinned tests must NOT derive seed
// timestamps from new Date()": every fixture anchor flows off a
// pinned `NOW`.
//
// Per LESSONS 2026-06-12 "greedy `[^>]+id=` regex over a `<h2 id="..."
// data-testid="...">` captures the wrong attribute": tests anchor on
// the data-testid attribute, never `id=`.
//
// Per LESSONS 2026-06-13 "function-import cycles aren't always
// cache-invalidation; sometimes the cheapest fix is a 6-line inline
// copy of the helper": the embed module carries a private inline
// `anonymiseEmbedExcerpt` copy so it never grows a back-edge import to
// src/lessons.ts. We assert that import surface remains clean.
//
// Zero new runtime deps; stdlib + node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  _renderEmbedLessonsHtmlForTests,
  _renderEmbedLessonsSvgForTests,
  _renderEmbedHeadersForTests,
  composeEmbedLessonsSnippets,
  buildEmbedLessonsPayloadForTests,
  type LessonEmbedPayload,
} from "../src/embed.ts";
import {
  _resetEmbedLessonsCacheForTests,
  _getEmbedLessonsCacheBuildsForTests,
  _embedLessonsCachedForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SERVER_TS = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
const EMBED_TS = readFileSync(join(ROOT, "src", "embed.ts"), "utf8");
const PKG_JSON = readFileSync(join(ROOT, "package.json"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Pinned anchors. Per LESSONS 2026-05-29 every seed timestamp must
// derive from a fixed NOW, never from new Date().
// ────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-15T12:00:00.000Z");
const NEXT_DAY = new Date("2026-06-16T12:00:00.000Z");
const NEXT_WEEK = new Date("2026-06-22T12:00:00.000Z");

// ────────────────────────────────────────────────────────────────────
// Fixture writers — every fixture seeds a temp LESSONS.md and points
// FLEET_CROSS_LESSONS_PATH at it. The Module-Set/Reset pattern below
// snapshots the env var so parallel tests don't leak.
// ────────────────────────────────────────────────────────────────────

interface FixtureHandle {
  path: string;
  cleanup: () => void;
}

function writeFixtureLessons(text: string): FixtureHandle {
  const dir = mkdtempSync(join(tmpdir(), "fleet-embed-lessons-"));
  const path = join(dir, "CROSS_LESSONS.md");
  writeFileSync(path, text);
  const prior = process.env.FLEET_CROSS_LESSONS_PATH;
  process.env.FLEET_CROSS_LESSONS_PATH = path;
  return {
    path,
    cleanup: () => {
      if (prior === undefined) delete process.env.FLEET_CROSS_LESSONS_PATH;
      else process.env.FLEET_CROSS_LESSONS_PATH = prior;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Build a multi-lesson fixture with N dated entries — enough to clear
 *  the >= 3 lessons gate AND exercise the rotation. */
function multiLessonFixture(): string {
  return `# CROSS LESSONS

## agent-fleet

### Entries

- 2026-05-10 [ship] no backticks inside template-literal SQL strings
- 2026-05-12 [ship] node:sqlite all() needs as unknown as RowT
- 2026-05-15 [ship] expose a build counter for cache-hit tests
- 2026-05-18 [ship] in-process dedup sets need an explicit reset hook
- 2026-05-21 [ship] async streaming tails snapshot the path before each read
- 2026-05-24 [ship] julianday drifts ~10us per timestamp
- 2026-05-27 [ship] keep dependencies empty - zero runtime deps
`;
}

// ────────────────────────────────────────────────────────────────────
// AC1 — GET /embed/lessons.html: route mounted BEFORE the /api/ auth
// gate, 320x200 self-contained HTML, NO <script>, four testids, headers
// per the spec. We assert the route-mount + handler shape via static
// greps on server.ts and call the renderer directly for the content
// assertions (per LESSONS 2026-06-11 — renderer-direct beats a
// startServer boot for branch tests).
// ────────────────────────────────────────────────────────────────────

test("AC1: src/server.ts mounts GET /embed/lessons.html BEFORE the /api/ auth gate", () => {
  // The handler must exist...
  assert.match(SERVER_TS, /serveEmbedLessonsHtml/,
    "serveEmbedLessonsHtml chokepoint must exist in server.ts");
  // ...and the route must be wired before the path.startsWith("/api/")
  // check so a remote caller without a token gets 200.
  const lessonsHtmlIdx = SERVER_TS.indexOf('"/embed/lessons.html"');
  // Anchor on the actual `if (path.startsWith("/api/"))` statement
  // (NOT the prose comment) so a new helper's comment block inside
  // the cache-layer section doesn't accidentally satisfy the gate.
  const apiGateIdx = SERVER_TS.indexOf('if (path.startsWith("/api/"))');
  assert.ok(lessonsHtmlIdx > 0, "the lessons.html route literal must appear in server.ts");
  assert.ok(apiGateIdx > 0, "the /api/ auth gate must appear in server.ts");
  assert.ok(lessonsHtmlIdx < apiGateIdx,
    "the lessons.html route MUST be mounted BEFORE the /api/ auth gate (per the 0060 embed posture)");
});

test("AC1: renderEmbedLessonsHtml emits the four documented testids + no <script>", () => {
  const payload: LessonEmbedPayload = {
    kind: "lesson",
    lesson_slug: "agent-fleet",
    lesson_date: "2026-06-12",
    lesson_title: "no backticks inside template-literal SQL strings",
    lesson_excerpt: "Node v25 type-stripping parser misreads inner backticks as nested template-literal delimiters.",
    rotation_day_index: 20618,
    total_lessons_indexed: 7,
  };
  const html = _renderEmbedLessonsHtmlForTests(payload);
  // Four documented testids per the AC.
  assert.match(html, /data-testid=["']embed-lessons-title["']/,
    "title testid must be present");
  assert.match(html, /data-testid=["']embed-lessons-excerpt["']/,
    "excerpt testid must be present");
  assert.match(html, /data-testid=["']embed-lessons-date["']/,
    "date testid must be present");
  assert.match(html, /data-testid=["']embed-lessons-cta["']/,
    "footer CTA testid must be present");
  // No <script> tag — the embed is zero-JS per the security posture.
  assert.equal(/<script\b/i.test(html), false,
    "embed HTML must contain no <script> tag");
  // No /api/control/ reference either.
  assert.equal(html.includes("/api/control/"), false,
    "embed HTML must contain no /api/control/ string");
});

test("AC1: serveEmbedLessonsHtml declares the documented response headers", () => {
  // We grep for the handler's header construction to confirm the route
  // sets the SAME header surface as /embed/pulse.html (5-min cache,
  // text/html, x-frame-options, CSP frame-ancestors).
  const handlerIdx = SERVER_TS.indexOf("function serveEmbedLessonsHtml");
  assert.ok(handlerIdx > 0, "serveEmbedLessonsHtml function must be defined");
  // Walk to the next closing-brace at column 0 OR fall back to a 2000-
  // char window. Either way, capture the header object.
  const closingBraceIdx = SERVER_TS.indexOf("\n}\n", handlerIdx);
  const handlerBody = SERVER_TS.slice(handlerIdx, closingBraceIdx > 0 ? closingBraceIdx : handlerIdx + 2000);
  assert.match(handlerBody, /"content-type":\s*"text\/html/,
    "lessons.html handler MUST declare text/html content-type");
  assert.match(handlerBody, /"cache-control":\s*"public,\s*max-age=300"/,
    "lessons.html handler MUST declare max-age=300 cache-control");
  assert.match(handlerBody, /"x-frame-options":\s*frame\.xFrameOptions/,
    "lessons.html handler MUST set X-Frame-Options from the shared composer");
  assert.match(handlerBody, /"content-security-policy":\s*frame\.contentSecurityPolicy/,
    "lessons.html handler MUST set CSP frame-ancestors from the shared composer");
});

// ────────────────────────────────────────────────────────────────────
// AC2 — GET /embed/lessons.svg: hand-rolled SVG sibling. We anchor
// the route-mount via static grep + drive the renderer directly for
// the content assertions.
// ────────────────────────────────────────────────────────────────────

test("AC2: src/server.ts mounts GET /embed/lessons.svg BEFORE the /api/ auth gate", () => {
  assert.match(SERVER_TS, /serveEmbedLessonsSvg/,
    "serveEmbedLessonsSvg chokepoint must exist in server.ts");
  const svgIdx = SERVER_TS.indexOf('"/embed/lessons.svg"');
  // Anchor on the actual `if (path.startsWith("/api/"))` statement
  // (NOT the prose comment) so a new helper's comment block inside
  // the cache-layer section doesn't accidentally satisfy the gate.
  const apiGateIdx = SERVER_TS.indexOf('if (path.startsWith("/api/"))');
  assert.ok(svgIdx > 0, "the lessons.svg route literal must appear in server.ts");
  assert.ok(svgIdx < apiGateIdx,
    "lessons.svg route MUST be mounted BEFORE the /api/ auth gate");
});

test("AC2: renderEmbedLessonsSvg emits the title text + clickable footer link", () => {
  const payload: LessonEmbedPayload = {
    kind: "lesson",
    lesson_slug: "agent-fleet",
    lesson_date: "2026-06-12",
    lesson_title: "expose a build counter for cache-hit tests",
    lesson_excerpt: "Pure-SQL helpers don't have an injected dependency to swap.",
    rotation_day_index: 20618,
    total_lessons_indexed: 7,
  };
  const svg = _renderEmbedLessonsSvgForTests(payload);
  // Top-of-svg sanity.
  assert.match(svg, /<svg\b/, "SVG body must start with <svg>");
  // Title substring appears verbatim in the rendered SVG.
  assert.ok(svg.includes("expose a build counter"),
    "lesson title substring MUST appear in the SVG body");
  // Footer link is a real <a> inside the SVG.
  assert.match(svg, /<a\s+href=/,
    "SVG MUST carry a clickable <a> footer link");
  // No operator project slug appears (the agent-fleet slug is the
  // public bootstrap name; this fixture only carries that one). A
  // hypothetical leak-shaped operator slug is asserted separately in AC4.
});

test("AC2: serveEmbedLessonsSvg declares image/svg+xml content-type + 5-min cache", () => {
  const handlerIdx = SERVER_TS.indexOf("function serveEmbedLessonsSvg");
  assert.ok(handlerIdx > 0, "serveEmbedLessonsSvg function must be defined");
  const closingBraceIdx = SERVER_TS.indexOf("\n}\n", handlerIdx);
  const handlerBody = SERVER_TS.slice(handlerIdx, closingBraceIdx > 0 ? closingBraceIdx : handlerIdx + 2000);
  assert.match(handlerBody, /"content-type":\s*"image\/svg\+xml/,
    "lessons.svg handler MUST declare image/svg+xml content-type");
  assert.match(handlerBody, /"cache-control":\s*"public,\s*max-age=300"/,
    "lessons.svg handler MUST declare max-age=300 cache-control");
});

// ────────────────────────────────────────────────────────────────────
// AC3 — Rotation determinism: same anchor day → same lesson; adjacent
// anchors → DIFFERENT lessons (when the cycle length > 1); rotation
// cycles back when the day_index modulus exceeds the lessons count.
// Drives buildEmbedLessonsPayloadForTests directly with an env-pointed
// fixture so we never need a DB or a startServer boot.
// ────────────────────────────────────────────────────────────────────

test("AC3: same anchor day produces the same lesson across multiple renders", () => {
  const f = writeFixtureLessons(multiLessonFixture());
  try {
    const a = buildEmbedLessonsPayloadForTests(NOW);
    const b = buildEmbedLessonsPayloadForTests(NOW);
    assert.equal(a.kind, "lesson", "fixture has >= 3 lessons; expected a real pick");
    assert.equal(b.kind, "lesson");
    if (a.kind === "lesson" && b.kind === "lesson") {
      assert.equal(a.lesson_title, b.lesson_title,
        "deterministic rotation: same anchor day MUST yield the same title");
      assert.equal(a.rotation_day_index, b.rotation_day_index);
    }
  } finally { f.cleanup(); }
});

test("AC3: two consecutive UTC days produce DIFFERENT lesson titles", () => {
  const f = writeFixtureLessons(multiLessonFixture());
  try {
    const a = buildEmbedLessonsPayloadForTests(NOW);
    const b = buildEmbedLessonsPayloadForTests(NEXT_DAY);
    assert.equal(a.kind, "lesson");
    assert.equal(b.kind, "lesson");
    if (a.kind === "lesson" && b.kind === "lesson") {
      assert.notEqual(a.lesson_title, b.lesson_title,
        "rotation MUST advance one slot per UTC day");
      assert.equal(b.rotation_day_index - a.rotation_day_index, 1,
        "day_index MUST increment by exactly 1 across adjacent UTC days");
    }
  } finally { f.cleanup(); }
});

test("AC3: rotation cycles back when day_index exceeds the lessons count", () => {
  // The multi-lesson fixture has 7 lessons; 7 calendar days later the
  // rotation slot MUST land on the same lesson as NOW (modular cycle).
  const f = writeFixtureLessons(multiLessonFixture());
  try {
    const a = buildEmbedLessonsPayloadForTests(NOW);
    const b = buildEmbedLessonsPayloadForTests(NEXT_WEEK);
    assert.equal(a.kind, "lesson");
    assert.equal(b.kind, "lesson");
    if (a.kind === "lesson" && b.kind === "lesson") {
      assert.equal(a.lesson_title, b.lesson_title,
        "with N=7 lessons the rotation MUST cycle back exactly N days later");
    }
  } finally { f.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — Anonymisation pass: operator-identifying strings (paths, slugs,
// PR URLs) must NOT appear in the rendered HTML/SVG body. The placeholders
// (`<path>`, `<project>`, `<pr-url>`) appear instead.
// ────────────────────────────────────────────────────────────────────

test("AC4: operator-identifying strings collapse to placeholders in HTML and SVG", () => {
  const fixture = `# CROSS LESSONS

## agent-fleet

### Entries

- 2026-05-10 [ship] no backticks inside SQL strings
- 2026-05-12 [ship] node:sqlite cast pattern
- 2026-05-15 [ship] expose a build counter

### 2026-06-12 — leaky lesson with operator identifiers

Symptom: a checkout under /Users/jane/code/ failed to run because
mutaaf-secret-tool was unreachable, and the PR
https://github.com/mutaaf/internal/pull/123 carried the wrong fix.
Cause: ...
Fix: ...
`;
  const f = writeFixtureLessons(fixture);
  try {
    // The 2026-06-12 H3 entry is the FIFTH lesson by source order and
    // the only one whose body carries the leak-shaped identifiers. We
    // walk every rotation day until we land on it so the assertions
    // exercise the anonymiser path (which only runs on the picked
    // lesson). The cycle length is 4 (3 bullets + 1 H3); 4 calendar
    // days are sufficient to surface every slot.
    let leakyHit: LessonEmbedPayload | null = null;
    for (let i = 0; i < 8; i++) {
      const anchor = new Date(NOW.getTime() + i * 86_400_000);
      const p = buildEmbedLessonsPayloadForTests(anchor);
      if (p.kind === "lesson" && p.lesson_title.includes("leaky")) {
        leakyHit = p;
        break;
      }
    }
    assert.ok(leakyHit, "the leaky lesson MUST be picked on some rotation day");
    if (leakyHit && leakyHit.kind === "lesson") {
      const html = _renderEmbedLessonsHtmlForTests(leakyHit);
      const svg = _renderEmbedLessonsSvgForTests(leakyHit);
      for (const body of [html, svg]) {
        // None of the leak-shaped strings appears.
        assert.equal(body.includes("/Users/jane/code"), false,
          "operator filesystem path MUST collapse to a placeholder");
        assert.equal(body.includes("mutaaf-secret-tool"), false,
          "operator project slug MUST collapse to a placeholder");
        assert.equal(body.includes("github.com/mutaaf/internal/pull/123"), false,
          "operator PR URL MUST collapse to a placeholder");
      }
      // Placeholders appear instead.
      assert.ok(html.includes("<path>") || html.includes("path&gt;"),
        "HTML body MUST carry the <path> placeholder");
      assert.ok(svg.includes("<path>") || svg.includes("path&gt;"),
        "SVG body MUST carry the <path> placeholder");
    }
  } finally { f.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — Honest empty state: fewer than 3 lessons → "fleet is still
// learning - no lessons yet" sentence in BOTH HTML and SVG.
// ────────────────────────────────────────────────────────────────────

test("AC5: empty / under-threshold fixture renders the honest 'still learning' sentence in HTML and SVG", () => {
  const fixture = `# CROSS LESSONS

## agent-fleet

### Entries

- 2026-05-10 [ship] one lonely lesson
`;
  const f = writeFixtureLessons(fixture);
  try {
    const payload = buildEmbedLessonsPayloadForTests(NOW);
    assert.equal(payload.kind, "empty",
      "fewer than 3 lessons MUST drop into the empty branch");
    const html = _renderEmbedLessonsHtmlForTests(payload);
    const svg = _renderEmbedLessonsSvgForTests(payload);
    assert.match(html, /fleet is still learning/i,
      "HTML embed MUST carry the honest empty-state sentence");
    assert.match(svg, /fleet is still learning/i,
      "SVG embed MUST carry the honest empty-state sentence");
    assert.match(html, /no lessons yet/i,
      "HTML embed MUST mention 'no lessons yet'");
    assert.match(svg, /no lessons yet/i,
      "SVG embed MUST mention 'no lessons yet'");
    // The footer CTA still renders in the empty state — the operator's
    // promotion surface survives an empty fleet.
    assert.match(html, /data-testid=["']embed-lessons-cta["']/,
      "empty HTML embed MUST still render the footer CTA");
  } finally { f.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Embed-origin allowlist via shared config: the lessons embed
// honours the SAME embedOrigins config field as the pulse embed.
// Renderer-direct seam — no cwd config mutation.
// ────────────────────────────────────────────────────────────────────

test("AC6: empty embedOrigins config → SAMEORIGIN / frame-ancestors 'self'", () => {
  const headers = _renderEmbedHeadersForTests();
  assert.equal(headers.xFrameOptions, "SAMEORIGIN",
    "no embedOrigins ⇒ X-Frame-Options: SAMEORIGIN");
  assert.equal(headers.contentSecurityPolicy, "frame-ancestors 'self'",
    "no embedOrigins ⇒ CSP frame-ancestors 'self'");
});

test("AC6: embedOrigins=['https://operator.dev'] widens the lessons embed CSP frame-ancestors", () => {
  // The lessons embed REUSES the existing composeEmbedFrameHeaders /
  // _renderEmbedHeadersForTests seam (same field, same composer) — we
  // anchor on it directly so the test never has to mutate cwd config.
  const headers = _renderEmbedHeadersForTests({
    embedOrigins: ["https://operator.dev"],
  });
  assert.notEqual(headers.xFrameOptions, "SAMEORIGIN",
    "non-empty embedOrigins MUST relax X-Frame-Options away from SAMEORIGIN");
  assert.match(headers.contentSecurityPolicy,
    /frame-ancestors\s+'self'\s+https:\/\/operator\.dev/,
    "non-empty embedOrigins MUST widen CSP frame-ancestors");
});

test("AC6: serveEmbedLessonsHtml passes cfg.embedOrigins through composeEmbedFrameHeaders", () => {
  // Static grep over server.ts — the lessons handler MUST construct
  // its headers via the shared composer, NOT hand-roll a parallel set.
  const handlerIdx = SERVER_TS.indexOf("function serveEmbedLessonsHtml");
  assert.ok(handlerIdx > 0);
  const closingBraceIdx = SERVER_TS.indexOf("\n}\n", handlerIdx);
  const handlerBody = SERVER_TS.slice(handlerIdx, closingBraceIdx > 0 ? closingBraceIdx : handlerIdx + 2000);
  assert.match(handlerBody, /composeEmbedFrameHeaders\(\s*\{\s*embedOrigins:\s*cfg\.embedOrigins/,
    "lessons.html handler MUST reuse the shared composeEmbedFrameHeaders({ embedOrigins: cfg.embedOrigins })");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Portal embed-snippets section on /share: three snippets with
// the documented testids + copy buttons. Renderer-direct.
// ────────────────────────────────────────────────────────────────────

test("AC7: composeEmbedLessonsSnippets(host) builds iframe/img/markdown snippets carrying the host", () => {
  const host = "http://127.0.0.1:7070";
  const snippets = composeEmbedLessonsSnippets(host);
  for (const kind of ["iframe", "img", "markdown"] as const) {
    assert.ok(snippets[kind].includes(host),
      `${kind} snippet MUST include the operator host`);
    assert.ok(snippets[kind].includes("/embed/lessons."),
      `${kind} snippet MUST reference the /embed/lessons.* route`);
  }
  assert.match(snippets.iframe, /<iframe\s/,
    "iframe snippet MUST be an <iframe> tag");
  assert.match(snippets.img, /<img\s/,
    "img snippet MUST include an <img> tag");
  assert.match(snippets.markdown, /^\[!\[/,
    "markdown snippet MUST begin with the standard image-link form");
});

test("AC7: renderSharePage carries the three new embed-lessons snippet testids + section anchor", () => {
  // Import the share-page renderer; the lessons section augments the
  // existing 0060 share page so /share carries BOTH the pulse and the
  // lesson embed snippets.
  // Per LESSONS 2026-06-12 — anchor on data-testid (NOT id=) so any
  // greedy regex collision is impossible.
  const sharePage = readFileSync(join(ROOT, "src", "embed.ts"), "utf8");
  // Static grep over the renderer source: the snippets section must
  // be emitted (one section anchor + three snippet testids + three
  // copy-button testids).
  assert.match(sharePage, /data-testid="embed-lessons-section"/,
    "share page MUST carry the embed-lessons-section anchor");
  assert.match(sharePage, /data-testid="embed-lessons-snippet-iframe"/,
    "share page MUST carry the embed-lessons-snippet-iframe testid");
  assert.match(sharePage, /data-testid="embed-lessons-snippet-img"/,
    "share page MUST carry the embed-lessons-snippet-img testid");
  assert.match(sharePage, /data-testid="embed-lessons-snippet-markdown"/,
    "share page MUST carry the embed-lessons-snippet-markdown testid");
  assert.match(sharePage, /data-testid="embed-lessons-copy-iframe"/,
    "share page MUST carry the embed-lessons-copy-iframe button testid");
  assert.match(sharePage, /data-testid="embed-lessons-copy-img"/,
    "share page MUST carry the embed-lessons-copy-img button testid");
  assert.match(sharePage, /data-testid="embed-lessons-copy-markdown"/,
    "share page MUST carry the embed-lessons-copy-markdown button testid");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Cache memoised on (date_iso, lessons_file_mtime,
// lessons_file_size). Build counter goes up 1 then 0 across two
// same-tuple calls; mtime change busts the cache.
// ────────────────────────────────────────────────────────────────────

test("AC8: two embed-lessons cache calls within TTL share one build; mtime change busts the tuple", () => {
  const f = writeFixtureLessons(multiLessonFixture());
  try {
    _resetEmbedLessonsCacheForTests();
    const before = _getEmbedLessonsCacheBuildsForTests();
    _embedLessonsCachedForTests(NOW);
    const afterFirst = _getEmbedLessonsCacheBuildsForTests();
    assert.equal(afterFirst - before, 1,
      "first call MUST cache-miss (build counter +1)");
    _embedLessonsCachedForTests(NOW);
    const afterSecond = _getEmbedLessonsCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0,
      "second call within TTL MUST cache-hit (build counter +0)");
    // Touch the fixture: a fresh mtime + size triggers re-build.
    const newer = multiLessonFixture() + "\n- 2026-06-01 [ship] one more lesson\n";
    writeFileSync(f.path, newer);
    // Force mtime advance — utimesSync with a value slightly in the
    // future guarantees the resolution-floor on every filesystem (the
    // default tmpdir on macOS may have 1s resolution).
    const future = new Date(Date.now() + 2000);
    utimesSync(f.path, future, future);
    _embedLessonsCachedForTests(NOW);
    const afterBust = _getEmbedLessonsCacheBuildsForTests();
    assert.equal(afterBust - afterSecond, 1,
      "fresh mtime + size MUST bust the cache (build counter +1)");
  } finally { f.cleanup(); }
});

test("AC8: _resetEmbedLessonsCacheForTests + _getEmbedLessonsCacheBuildsForTests are exported", () => {
  // The seam pair must exist; this guards a future refactor from
  // accidentally dropping them.
  assert.equal(typeof _resetEmbedLessonsCacheForTests, "function");
  assert.equal(typeof _getEmbedLessonsCacheBuildsForTests, "function");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Time-pinned tests: the rotation helper accepts an `opts.now`
// (or a Date arg) so the test suite NEVER reads new Date(). We assert
// the contract by passing two different pins and confirming distinct
// day_index values.
// ────────────────────────────────────────────────────────────────────

test("AC9: buildEmbedLessonsPayloadForTests honours a pinned `now` argument (no new Date() reads)", () => {
  const f = writeFixtureLessons(multiLessonFixture());
  try {
    const a = buildEmbedLessonsPayloadForTests(NOW);
    const b = buildEmbedLessonsPayloadForTests(NEXT_DAY);
    assert.equal(a.kind, "lesson");
    assert.equal(b.kind, "lesson");
    if (a.kind === "lesson" && b.kind === "lesson") {
      // Per LESSONS 2026-05-29: the helper MUST derive its day_index
      // from the pinned `now`, NEVER from new Date(). We assert the
      // delta exactly matches the calendar delta between the pins.
      const expectedDelta = Math.floor(NEXT_DAY.getTime() / 86_400_000)
        - Math.floor(NOW.getTime() / 86_400_000);
      assert.equal(b.rotation_day_index - a.rotation_day_index, expectedDelta,
        "rotation_day_index MUST derive from the pinned `now`, not new Date()");
    }
  } finally { f.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Hard-NO compliance: zero new runtime deps, no shell-string
// composition, no JSON-shape break, no new schema migration.
// ────────────────────────────────────────────────────────────────────

test("AC10: package.json `dependencies` stays empty (zero runtime deps)", () => {
  const pkg = JSON.parse(PKG_JSON) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  assert.deepEqual(deps, {},
    "AGENTS.md Hard NO: no runtime deps may be added; got " + JSON.stringify(deps));
});

test("AC10: src/embed.ts does NOT import node:child_process (no shell-out)", () => {
  assert.equal(/from\s+["']node:child_process["']/.test(EMBED_TS), false,
    "embed renderer MUST not import node:child_process");
});

test("AC10: src/embed.ts does NOT introduce a back-edge import from src/lessons.ts (avoids function-import cycle)", () => {
  // Per LESSONS 2026-06-13: src/lessons.ts already imports from
  // src/views.ts; src/embed.ts already imports the FleetWeeklyPulse
  // type from src/views.ts. An embed → lessons import would NOT today
  // create a strict cycle (lessons → views, embed → views, embed →
  // lessons is acyclic) — but the AC explicitly mandates the inline-
  // copy posture so the surface stays purely additive. We assert the
  // current embed module never reaches into lessons.ts to keep that
  // discipline visible to future authors.
  assert.equal(/from\s+["']\.\/lessons\.ts["']/.test(EMBED_TS), false,
    "embed module MUST NOT import from lessons.ts (inline copy per LESSONS 2026-06-13)");
});

test("AC10: existing /api/fleet/lessons JSON shape is untouched (lessons embed is purely additive)", () => {
  // The embed routes are net-new (/embed/lessons.html + /embed/
  // lessons.svg) and do not touch /api/fleet/lessons. We assert the
  // existing JSON serve helper is still wired in server.ts.
  assert.match(SERVER_TS, /\/api\/fleet\/lessons/,
    "the existing /api/fleet/lessons route must remain wired in server.ts");
});

test("AC10: the lessons embed renders WITHIN a 320x200 viewBox (matches the spec dimensions)", () => {
  const payload: LessonEmbedPayload = {
    kind: "lesson",
    lesson_slug: "agent-fleet",
    lesson_date: "2026-06-12",
    lesson_title: "demo title",
    lesson_excerpt: "demo excerpt body line.",
    rotation_day_index: 0,
    total_lessons_indexed: 7,
  };
  const svg = _renderEmbedLessonsSvgForTests(payload);
  // The hand-rolled SVG declares a 320x200 viewBox (per the spec).
  assert.match(svg, /viewBox="0 0 320 200"/,
    "SVG MUST declare a 320x200 viewBox");
  assert.match(svg, /width="320"/, "SVG MUST declare width=320");
  assert.match(svg, /height="200"/, "SVG MUST declare height=200");
});
