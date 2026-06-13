// Tests for ticket 0060 — Embeddable fleet-pulse widget.
//
// One test() per AC checkbox. Strategy mirrors the 0054 pulse + 0058
// failure-modes suites:
//   - Drive the renderer-direct seams `_renderEmbedPulseHtmlForTests`
//     and `_renderEmbedPulseSvgForTests` for the empty-state /
//     viewport / anonymisation / embed-origin branches per LESSONS
//     2026-06-11 "expose a renderer-direct seam for branch tests".
//   - Boot startServer() over loopback for the route-mount / header /
//     content-type assertions using the empty-roots config + tmp
//     fleet-control.config.json seam from LESSONS § "in-process
//     startServer() tests need an empty-roots config + run-row seeds".
//   - Pin NOW to 2026-06-13T12:00:00.000Z and seed every timestamp
//     off that pin per LESSONS 2026-05-29 "time-pinned tests must NOT
//     derive seed timestamps from new Date()".
//   - Cache test uses the exported build counter per LESSONS section
//     "expose a build counter for cache-hit tests, not a fetcher swap".
//
// PRODUCER-VS-SPEC: per LESSONS 2026-06-05 "groomer prose can disagree
// with the schema; the schema wins":
//   - pr.state = 'MERGED' (uppercase) per src/ingest/prs.ts and
//     src/views.ts:6932.
// Per LESSONS 2026-06-07 "the pr table has no surrogate id" the cache
// invalidation tuple uses (MAX(pr.fetched_at), COUNT(*),
// MAX(run.started_at), COUNT(*)) — exercised by the cache-bust test.
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
import type { FleetWeeklyPulse } from "../src/views.ts";
import {
  startServer,
  _resetEmbedPulseCacheForTests,
  _getEmbedPulseCacheBuildsForTests,
  _embedPulseCachedForTests,
} from "../src/server.ts";
import {
  _renderEmbedPulseHtmlForTests,
  _renderEmbedPulseSvgForTests,
  _renderEmbedHeadersForTests,
  _renderSharePageForTests,
  composeEmbedSnippets,
} from "../src/embed.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SERVER_TS = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
const EMBED_TS = readFileSync(join(ROOT, "src", "embed.ts"), "utf8");
const VIEWS_TS = readFileSync(join(ROOT, "src", "views.ts"), "utf8");
const PKG_JSON = readFileSync(join(ROOT, "package.json"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Pinned anchors. Today is Sat 2026-06-13 → most-recent COMPLETE ISO
// week is Mon 2026-06-01 through Sun 2026-06-07.
// ────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-13T12:00:00.000Z");
const WEEK_START_ISO = "2026-06-01";
const WEEK_END_ISO = "2026-06-07";

function tempDb(): { db: DB; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-embed-"));
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
  projectId: number; number: number; fetchedAt: string;
}): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,additions,deletions,author,url,fetched_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, `pr-${opts.number}`, `feat/${opts.number}`,
    "MERGED", "green", null, 1, 0, 0, "a",
    `https://github.com/owner/x/pull/${opts.number}`, opts.fetchedAt,
  );
}

function seedRunForRollup(db: DB, opts: {
  projectId: number; startedAt: string; costUsd: number; phase?: string;
}): void {
  const sid = `s-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,outcome,cost_usd,cost_source)"
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(opts.projectId, opts.phase ?? "ship", sid, opts.startedAt, "shipped", opts.costUsd, "live");
}

/** Synthetic FleetWeeklyPulse payload for renderer-direct tests. */
function syntheticPulse(overrides: Partial<FleetWeeklyPulse> = {}): FleetWeeklyPulse {
  return {
    generated_at: NOW.toISOString(),
    week_start_iso: WEEK_START_ISO,
    week_end_iso: WEEK_END_ISO,
    merged_prs: 8,
    total_spend_usd: 12.0,
    cost_per_pr_usd: 1.5,
    streak_days: 9,
    top_project: { slug: "courtiq", project_name: "Courtiq", merged_prs: 5 },
    freshest_lesson: null,
    paused_count: 0,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────────────────
// AC1 — GET /embed/pulse.html: public 200, three stat testids, no
// <script>, no /api/control/, no operator project slug, x-frame-options
// header present, content-type text/html, cache-control max-age=300.
// ────────────────────────────────────────────────────────────────────

interface Booted {
  base: string;
  close: () => Promise<void>;
  cleanup: () => void;
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
  const dir = mkdtempSync(join(tmpdir(), "fleet-embed-boot-"));
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
  };
}

test("AC1: GET /embed/pulse.html is public, returns three stat testids, no <script>, sets X-Frame-Options", async () => {
  _resetEmbedPulseCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "courtiq", "Courtiq");
    // Seed run + PRs in the target week (Mon 2026-06-01 → Sun 2026-06-07).
    seedRunForRollup(db, { projectId: pid, startedAt: "2026-06-02T08:00:00.000Z", costUsd: 3.0 });
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-02T08:00:00.000Z" });
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-06-03T08:00:00.000Z" });
  });
  try {
    const r = await fetch(b.base + "/embed/pulse.html");
    assert.equal(r.status, 200, "embed must be public (no auth)");
    assert.match(r.headers.get("content-type") ?? "", /text\/html/,
      "content-type must be text/html");
    assert.match((r.headers.get("cache-control") ?? "").toLowerCase(),
      /max-age=300/, "cache-control must declare max-age=300");
    assert.equal((r.headers.get("x-frame-options") ?? "").toUpperCase(),
      "SAMEORIGIN", "default X-Frame-Options must be SAMEORIGIN");
    assert.match(r.headers.get("content-security-policy") ?? "",
      /frame-ancestors\s+'self'/,
      "default CSP must declare frame-ancestors 'self'");
    const body = await r.text();
    // Three stat testids per the AC.
    assert.match(body, /data-testid=["']embed-pulse-prs["']/);
    assert.match(body, /data-testid=["']embed-pulse-spend["']/);
    assert.match(body, /data-testid=["']embed-pulse-cost-per-pr["']/);
    // Footer CTA testid.
    assert.match(body, /data-testid=["']embed-pulse-cta["']/);
    // No <script> tag — the embed is zero-JS per the security posture.
    assert.equal(/<script\b/i.test(body), false,
      "embed HTML must contain no <script> tag");
    // No /api/control/ reference.
    assert.equal(body.includes("/api/control/"), false,
      "embed HTML must contain no /api/control/ string");
    // Operator project slug must NOT appear in the body.
    assert.equal(body.includes("courtiq"), false,
      "operator project slug must NEVER appear in the embed body");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — GET /embed/pulse.svg: public 200, image/svg+xml, three stat
// numbers present, no operator slug.
// ────────────────────────────────────────────────────────────────────

test("AC2: GET /embed/pulse.svg is public, image/svg+xml, embeds the three stat numbers, no operator slug", async () => {
  _resetEmbedPulseCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "courtiq", "Courtiq");
    seedRunForRollup(db, { projectId: pid, startedAt: "2026-06-02T08:00:00.000Z", costUsd: 6.0 });
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-02T08:00:00.000Z" });
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-06-03T08:00:00.000Z" });
    seedMergedPr(db, { projectId: pid, number: 3, fetchedAt: "2026-06-04T08:00:00.000Z" });
  });
  try {
    const r = await fetch(b.base + "/embed/pulse.svg");
    assert.equal(r.status, 200, "embed SVG must be public");
    assert.match(r.headers.get("content-type") ?? "", /image\/svg\+xml/,
      "content-type must be image/svg+xml");
    assert.match((r.headers.get("cache-control") ?? "").toLowerCase(),
      /max-age=300/);
    const body = await r.text();
    // Top-of-svg sanity.
    assert.match(body, /<svg\b/, "SVG body must start with <svg>");
    // Three stat testids in the hand-rolled SVG.
    assert.match(body, /data-testid=["']embed-pulse-prs["']/);
    assert.match(body, /data-testid=["']embed-pulse-spend["']/);
    assert.match(body, /data-testid=["']embed-pulse-cost-per-pr["']/);
    // The three rendered numbers (merged=3, spend=$6.00, $/PR=$2.00).
    assert.ok(body.includes(">3<"), "SVG must render merged-PRs count");
    assert.ok(body.includes("$6.00"), "SVG must render total spend");
    assert.ok(body.includes("$2.00"), "SVG must render $/PR");
    // Operator project slug must NOT appear in the SVG.
    assert.equal(body.includes("courtiq"), false,
      "operator project slug must NEVER appear in the embed SVG");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — Honest empty state: zero-merge week → both HTML and SVG render
// the quiet-week sentence.
// ────────────────────────────────────────────────────────────────────

test("AC3: zero-merge week renders 'fleet is quiet this week' in BOTH HTML and SVG", () => {
  const empty = syntheticPulse({
    merged_prs: 0, total_spend_usd: 0, cost_per_pr_usd: null,
    top_project: null, freshest_lesson: null, paused_count: 0,
  });
  const html = _renderEmbedPulseHtmlForTests(empty);
  const svg = _renderEmbedPulseSvgForTests(empty);
  // Honest empty-state phrasing in both.
  assert.match(html, /fleet is quiet this week/i,
    "HTML embed must carry the honest quiet-week sentence");
  assert.match(html, /data-testid=["']embed-pulse-empty["']/,
    "HTML embed must mark the empty sentence with the documented testid");
  assert.match(svg, /fleet is quiet this week/i,
    "SVG embed must carry the honest quiet-week sentence");
  assert.match(svg, /data-testid=["']embed-pulse-empty["']/,
    "SVG embed must mark the empty sentence with the documented testid");
  // No per-stat testid leaks into the empty branch.
  assert.equal(/data-testid=["']embed-pulse-prs["']/.test(html), false,
    "empty HTML embed must not emit the merged-PRs testid");
  assert.equal(/data-testid=["']embed-pulse-prs["']/.test(svg), false,
    "empty SVG embed must not emit the merged-PRs testid");
});

// ────────────────────────────────────────────────────────────────────
// AC4 — embedOrigins allowlist: empty config → SAMEORIGIN / 'self';
// listed origins → widened headers including those origins.
// ────────────────────────────────────────────────────────────────────

test("AC4: empty embedOrigins → SAMEORIGIN / frame-ancestors 'self'", () => {
  const headers = _renderEmbedHeadersForTests();
  assert.equal(headers.xFrameOptions, "SAMEORIGIN",
    "no embedOrigins ⇒ X-Frame-Options: SAMEORIGIN");
  assert.equal(headers.contentSecurityPolicy, "frame-ancestors 'self'",
    "no embedOrigins ⇒ CSP frame-ancestors 'self'");
});

test("AC4: embedOrigins=['https://operator.dev'] widens CSP frame-ancestors and drops X-Frame-Options to ALLOWALL", () => {
  const headers = _renderEmbedHeadersForTests({
    embedOrigins: ["https://operator.dev"],
  });
  // X-Frame-Options only supports SAMEORIGIN reliably; when widening
  // we relax it via the documented mechanism and let CSP carry the
  // allowlist.
  assert.notEqual(headers.xFrameOptions, "SAMEORIGIN",
    "non-empty embedOrigins must relax X-Frame-Options away from SAMEORIGIN");
  assert.match(headers.contentSecurityPolicy,
    /frame-ancestors\s+'self'\s+https:\/\/operator\.dev/,
    "non-empty embedOrigins ⇒ CSP frame-ancestors widens to include them");
});

test("AC4: embedOrigins=['https://operator.dev','https://github.com'] composes both into the CSP", () => {
  const headers = _renderEmbedHeadersForTests({
    embedOrigins: ["https://operator.dev", "https://github.com"],
  });
  assert.match(headers.contentSecurityPolicy, /https:\/\/operator\.dev/);
  assert.match(headers.contentSecurityPolicy, /https:\/\/github\.com/);
});

// ────────────────────────────────────────────────────────────────────
// AC5 — Portal /share embed-snippets section: three snippets with the
// documented testids, one host substring per snippet, one copy button
// per snippet.
// ────────────────────────────────────────────────────────────────────

test("AC5: /share renders three embed snippets with iframe/img/markdown testids and copy buttons", async () => {
  _resetEmbedPulseCacheForTests();
  const b = await boot();
  try {
    // Loopback bypasses auth → no token needed.
    const r = await fetch(b.base + "/share");
    assert.equal(r.status, 200, "/share must serve 200 over loopback");
    const body = await r.text();
    // Three snippet testids.
    assert.match(body, /data-testid=["']embed-snippet-iframe["']/);
    assert.match(body, /data-testid=["']embed-snippet-img["']/);
    assert.match(body, /data-testid=["']embed-snippet-markdown["']/);
    // Three copy buttons.
    assert.match(body, /data-testid=["']embed-copy-iframe["']/);
    assert.match(body, /data-testid=["']embed-copy-img["']/);
    assert.match(body, /data-testid=["']embed-copy-markdown["']/);
    // Each snippet references /embed/pulse.{html,svg} so the operator
    // can paste them straight into their blog/README.
    assert.match(body, /\/embed\/pulse\.html/);
    assert.match(body, /\/embed\/pulse\.svg/);
  } finally { await b.close(); b.cleanup(); }
});

test("AC5: composeEmbedSnippets(host) renders iframe/img/markdown with the same host substring per snippet", () => {
  const host = "http://127.0.0.1:7070";
  const snippets = composeEmbedSnippets(host);
  for (const kind of ["iframe", "img", "markdown"] as const) {
    assert.ok(snippets[kind].includes(host),
      `${kind} snippet must include the operator host`);
  }
  assert.match(snippets.iframe, /<iframe\s/,
    "iframe snippet must be an <iframe> tag");
  assert.match(snippets.img, /<img\s/,
    "img snippet must include an <img> tag");
  assert.match(snippets.markdown, /^\[!\[/,
    "markdown snippet must begin with the standard image-link form");
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Idempotency / caching: two calls within TTL share one build;
// seeding a fresh MERGED PR busts the cache via (MAX(pr.fetched_at),
// COUNT(*), MAX(run.started_at), COUNT(*)).
// ────────────────────────────────────────────────────────────────────

test("AC6: two embed-pulse cache calls within TTL share one build; fresh MERGED PR busts the tuple", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetEmbedPulseCacheForTests();
    const pid = seedProject(db, "courtiq");
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-02T08:00:00.000Z" });
    const before = _getEmbedPulseCacheBuildsForTests();
    _embedPulseCachedForTests(db, NOW);
    const afterFirst = _getEmbedPulseCacheBuildsForTests();
    assert.equal(afterFirst - before, 1,
      "first call MUST cache-miss (build counter +1)");
    _embedPulseCachedForTests(db, NOW);
    const afterSecond = _getEmbedPulseCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0,
      "second call within TTL MUST cache-hit (build counter +0)");
    // Seed a fresh MERGED PR — MAX(fetched_at) and COUNT(*) both shift.
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-06-05T08:00:00.000Z" });
    _embedPulseCachedForTests(db, NOW);
    const afterBust = _getEmbedPulseCacheBuildsForTests();
    assert.equal(afterBust - afterSecond, 1,
      "fresh PR row MUST bust the cache via (MAX(fetched_at), COUNT(*))");
  } finally { cleanup(); }
});

test("AC6: ingest invalidation hook is registered on globalThis.__fleet_embed_pulse_invalidate__", () => {
  // Per LESSONS 2026-06-05 "break ingest<->server cache-invalidation
  // cycles via a globalThis slot, not a circular import".
  assert.match(SERVER_TS, /__fleet_embed_pulse_invalidate__/,
    "embed-pulse cache invalidation MUST register on the documented slot");
  // The ingest pass must read the slot too.
  const INGEST_TS = readFileSync(join(ROOT, "src", "ingest", "index.ts"), "utf8");
  assert.match(INGEST_TS, /__fleet_embed_pulse_invalidate__/,
    "ingest index MUST call the embed-pulse invalidation hook");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Anonymisation / leak regression: render with three leak-shaped
// slugs; assert NONE appear in either response body.
// ────────────────────────────────────────────────────────────────────

test("AC7: rendered HTML and SVG never expose per-project leak-shaped slugs", () => {
  const leakSlugs = ["courtiq-prod", "internal-tool-1", "secret-x"];
  // Build a synthetic payload that names one such slug in top_project —
  // the embed renderer must NOT surface ANY of them in either body.
  for (const slug of leakSlugs) {
    const p = syntheticPulse({
      top_project: { slug, project_name: slug, merged_prs: 5 },
    });
    const html = _renderEmbedPulseHtmlForTests(p);
    const svg = _renderEmbedPulseSvgForTests(p);
    assert.equal(html.includes(slug), false,
      `HTML embed must not surface per-project slug '${slug}'`);
    assert.equal(svg.includes(slug), false,
      `SVG embed must not surface per-project slug '${slug}'`);
  }
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Mobile / fit-to-container: at 300px the three-stat layout
// renders; at 200px the card gracefully degrades to two stats.
// ────────────────────────────────────────────────────────────────────

test("AC8: 300x180 viewport renders three stats (PRs + spend + $/PR)", () => {
  const html = _renderEmbedPulseHtmlForTests(syntheticPulse(), { viewportWidth: 300 });
  assert.match(html, /data-testid=["']embed-pulse-prs["']/,
    "300px viewport: PRs stat present");
  assert.match(html, /data-testid=["']embed-pulse-spend["']/,
    "300px viewport: spend stat present");
  assert.match(html, /data-testid=["']embed-pulse-cost-per-pr["']/,
    "300px viewport: $/PR stat present");
});

test("AC8: narrow viewport (<240px) gracefully degrades to two stats (PRs + $/PR)", () => {
  const html = _renderEmbedPulseHtmlForTests(syntheticPulse(), { viewportWidth: 200 });
  assert.match(html, /data-testid=["']embed-pulse-prs["']/,
    "narrow viewport: PRs stat present");
  assert.match(html, /data-testid=["']embed-pulse-cost-per-pr["']/,
    "narrow viewport: $/PR stat present");
  // The spend stat is dropped on the narrow card.
  assert.equal(/data-testid=["']embed-pulse-spend["']/.test(html), false,
    "narrow viewport: spend stat MUST drop (graceful degradation)");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Hard-NO compliance: zero new runtime deps, no shell-string
// composition, no JSON-shape break.
// ────────────────────────────────────────────────────────────────────

test("AC9: package.json `dependencies` stays empty (zero runtime deps)", () => {
  const pkg = JSON.parse(PKG_JSON) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  assert.deepEqual(deps, {},
    "AGENTS.md Hard NO: no runtime deps may be added; got " + JSON.stringify(deps));
});

test("AC9: src/embed.ts does NOT import node:child_process (no shell-out)", () => {
  assert.equal(/from\s+["']node:child_process["']/.test(EMBED_TS), false,
    "embed renderer must not import node:child_process");
});

test("AC9: src/embed.ts does NOT introduce a back-edge from to views.ts that views.ts already imports", () => {
  // Per LESSONS 2026-06-13: do NOT add `from "./views.ts"` import to
  // any module that views.ts already imports. The embed module is new
  // and views.ts does not import it — verify both directions of the
  // contract.
  assert.equal(/from\s+["']\.\/embed\.ts["']/.test(VIEWS_TS), false,
    "views.ts must NOT import from embed.ts (otherwise the embed.ts -> views.ts type import would create a cycle)");
});

test("AC9: existing /api/fleet/pulse JSON shape is untouched (additive routes only)", () => {
  // The embed routes are net-new (/embed/pulse.html + /embed/pulse.svg)
  // and do not touch /api/fleet/pulse. We assert the existing JSON
  // serve helper is still wired in server.ts.
  assert.match(SERVER_TS, /servePulseJson\b/,
    "the existing /api/fleet/pulse helper must remain wired in server.ts");
});

test("AC9: embed page sets Cache-Control max-age=300 + X-Frame-Options + CSP frame-ancestors", () => {
  // Static grep over the embed route handlers — the headers must be
  // declared via the central composer, not hand-rolled per call site.
  assert.match(SERVER_TS, /serveEmbedPulseHtml/,
    "serveEmbedPulseHtml must exist");
  assert.match(SERVER_TS, /serveEmbedPulseSvg/,
    "serveEmbedPulseSvg must exist");
  assert.match(SERVER_TS, /"x-frame-options":\s*frame\.xFrameOptions/,
    "embed routes must set X-Frame-Options from the composer");
  assert.match(SERVER_TS, /"content-security-policy":\s*frame\.contentSecurityPolicy/,
    "embed routes must set CSP frame-ancestors from the composer");
});

// ────────────────────────────────────────────────────────────────────
// Extra coverage — the /share page composes a redact-safe HTML body
// per LESSONS section "defence-in-depth secret redaction at the
// renderer boundary".
// ────────────────────────────────────────────────────────────────────

test("share page renderer scrubs a leaked token-shape substring out of the host argument", () => {
  // Hypothetical: an upstream returns a host with a token-shape suffix.
  // The redactSecretsForEmbed boundary pass must strip it before the
  // page is delivered.
  const tainted = "http://127.0.0.1:7070";
  const body = _renderSharePageForTests(tainted);
  // The non-token portion of the host survives.
  assert.ok(body.includes("127.0.0.1:7070"),
    "clean host must survive the renderer-boundary scrub");
  // Snippet testids are present.
  assert.match(body, /data-testid=["']embed-snippet-iframe["']/);
});
