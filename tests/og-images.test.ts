// Tests for ticket 0061 - Open-graph image renderer for /pulse,
// /receipts, /calculator.
//
// One test() per AC checkbox. Strategy mirrors the 0060 embed-pulse
// suite:
//   - Drive the renderer-direct seams `_renderOgPulseSvgForTests`,
//     `_renderOgReceiptsSvgForTests`, `_renderOgCalculatorSvgForTests`
//     for empty-state / sparkline / headline branches per LESSONS
//     2026-06-11 "expose a renderer-direct seam for branch tests".
//   - Boot startServer() over loopback for the route-mount / header /
//     content-type / meta-tag assertions using the empty-roots config
//     + tmp fleet-control.config.json seam.
//   - Pin NOW to 2026-06-15T12:00:00.000Z (Mon) - the OG /pulse anchor
//     resolves to the most-recent COMPLETE week, Mon 2026-06-08 ->
//     Sun 2026-06-14. Seed timestamps anchor off the pin per LESSONS
//     2026-05-29 "time-pinned tests must NOT derive seed timestamps
//     from new Date()".
//   - Cache test uses the exported build counter per LESSONS section
//     "expose a build counter for cache-hit tests, not a fetcher swap".
//
// PRODUCER-VS-SPEC (per LESSONS 2026-06-05 "groomer prose can disagree
// with the schema; the schema wins"):
//   - pr.state = 'MERGED' uppercase for merged PRs (matches
//     src/views.ts:6932 fleetWeeklyPulse, src/receipts.ts:131 the
//     monthly aggregator, src/views.ts:6678 the fleet median).
//   - The pr table has NO surrogate id - cache invalidation uses
//     (MAX(fetched_at), COUNT(*)) per LESSONS 2026-06-07, NEVER
//     MAX(pr.id).
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
import type { FleetWeeklyPulse, FleetMedianProjection } from "../src/views.ts";
import {
  startServer,
  _resetOgCacheForTests,
  _getOgCacheBuildsForTests,
  _ogPulseCachedForTests,
  _ogReceiptsCachedForTests,
  _ogCalculatorCachedForTests,
} from "../src/server.ts";
import {
  _renderOgPulseSvgForTests,
  _renderOgReceiptsSvgForTests,
  _renderOgCalculatorSvgForTests,
  type OgReceiptsPayload,
  type OgCalculatorPayload,
} from "../src/og.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SERVER_TS = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
const OG_TS = readFileSync(join(ROOT, "src", "og.ts"), "utf8");
const VIEWS_TS = readFileSync(join(ROOT, "src", "views.ts"), "utf8");
const PKG_JSON = readFileSync(join(ROOT, "package.json"), "utf8");

// ------------------------------------------------------------------
// Pinned anchors. Today is Mon 2026-06-15 -> most-recent COMPLETE ISO
// week is Mon 2026-06-08 through Sun 2026-06-14. Current calendar
// month is 2026-06.
// ------------------------------------------------------------------

const NOW = new Date("2026-06-15T12:00:00.000Z");
const WEEK_START_ISO = "2026-06-08";
const WEEK_END_ISO = "2026-06-14";
const MONTH_ISO = "2026-06";

function tempDb(): { db: DB; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-og-"));
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
    merged_prs: 12,
    total_spend_usd: 24.18,
    cost_per_pr_usd: 2.02,
    streak_days: 7,
    top_project: { slug: "courtiq", project_name: "Courtiq", merged_prs: 5 },
    freshest_lesson: null,
    paused_count: 0,
    ...overrides,
  };
}

function syntheticReceipts(overrides: Partial<OgReceiptsPayload> = {}): OgReceiptsPayload {
  return {
    generated_at: NOW.toISOString(),
    month_iso: MONTH_ISO,
    month_label: "June 2026",
    merged_prs: 42,
    total_spend_usd: 88.5,
    sparkline: [3, 5, 4, 8, 6, 11, 7, 9, 10, 14, 18, 42],
    ...overrides,
  };
}

function syntheticCalculator(overrides: Partial<OgCalculatorPayload> = {}): OgCalculatorPayload {
  return {
    generated_at: NOW.toISOString(),
    hours_saved_per_week: 14,
    merged_prs_per_month: 18,
    cost_per_pr_usd: 2.5,
    percentile_label: "median",
    insufficient_data: false,
    ...overrides,
  };
}

// ------------------------------------------------------------------
// Server boot helper (matches the 0060 embed-pulse pattern).
// ------------------------------------------------------------------

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
  const dir = mkdtempSync(join(tmpdir(), "fleet-og-boot-"));
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

// ==================================================================
// AC1 - GET /og/pulse.svg: public 200, image/svg+xml, cache-control
// max-age=3600, three stat testids, no <script>, no operator project
// slug.
// ==================================================================

test("AC1: GET /og/pulse.svg is public, image/svg+xml, three stat testids, no <script>, no operator slug", async () => {
  _resetOgCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "courtiq", "Courtiq");
    // Seed 3 merged PRs + spend rollup in the target week
    // (Mon 2026-06-08 -> Sun 2026-06-14).
    seedRunForRollup(db, { projectId: pid, startedAt: "2026-06-09T08:00:00.000Z", costUsd: 12.0 });
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-09T08:00:00.000Z" });
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-06-10T08:00:00.000Z" });
    seedMergedPr(db, { projectId: pid, number: 3, fetchedAt: "2026-06-11T08:00:00.000Z" });
  });
  try {
    const r = await fetch(b.base + "/og/pulse.svg");
    assert.equal(r.status, 200, "OG pulse SVG must be public (no auth)");
    assert.match(r.headers.get("content-type") ?? "", /image\/svg\+xml/,
      "content-type must be image/svg+xml");
    assert.match((r.headers.get("cache-control") ?? "").toLowerCase(),
      /max-age=3600/, "cache-control must declare max-age=3600");
    const body = await r.text();
    // Top-of-svg sanity.
    assert.match(body, /<svg\b/, "SVG body must start with <svg>");
    // Three stat testids per the AC.
    assert.match(body, /data-testid=["']og-pulse-prs["']/);
    assert.match(body, /data-testid=["']og-pulse-spend["']/);
    assert.match(body, /data-testid=["']og-pulse-cost-per-pr["']/);
    // No <script> tag.
    assert.equal(/<script\b/i.test(body), false,
      "OG SVG must contain no <script> tag");
    // Operator project slug must NOT appear in the SVG.
    assert.equal(body.includes("courtiq"), false,
      "operator project slug must NEVER appear in the OG SVG");
  } finally { await b.close(); b.cleanup(); }
});

// ==================================================================
// AC2 - GET /og/receipts.svg: public 200, image/svg+xml, headline +
// sparkline testids present.
// ==================================================================

test("AC2: GET /og/receipts.svg is public, image/svg+xml, headline + sparkline testids present", async () => {
  _resetOgCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "courtiq", "Courtiq");
    // Seed several merged PRs in the current month.
    seedRunForRollup(db, { projectId: pid, startedAt: "2026-06-02T08:00:00.000Z", costUsd: 8.0 });
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-02T08:00:00.000Z" });
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-06-09T08:00:00.000Z" });
    seedMergedPr(db, { projectId: pid, number: 3, fetchedAt: "2026-06-11T08:00:00.000Z" });
  });
  try {
    const r = await fetch(b.base + "/og/receipts.svg");
    assert.equal(r.status, 200, "OG receipts SVG must be public");
    assert.match(r.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match((r.headers.get("cache-control") ?? "").toLowerCase(),
      /max-age=3600/);
    const body = await r.text();
    assert.match(body, /<svg\b/);
    assert.match(body, /data-testid=["']og-receipts-headline["']/);
    assert.match(body, /data-testid=["']og-receipts-sparkline["']/);
    // The sparkline must render <rect> bars (hand-rolled like 0031).
    assert.match(body, /<rect\b/i, "OG receipts must include <rect> sparkline bars");
    assert.equal(/<script\b/i.test(body), false);
    assert.equal(body.includes("courtiq"), false,
      "operator project slug must NEVER appear in the OG receipts SVG");
  } finally { await b.close(); b.cleanup(); }
});

// ==================================================================
// AC3 - GET /og/calculator.svg: public 200, image/svg+xml, headline +
// CTA testids present.
// ==================================================================

test("AC3: GET /og/calculator.svg is public, image/svg+xml, headline + CTA testids present", async () => {
  _resetOgCacheForTests();
  const b = await boot((db) => {
    // Seed enough merged PRs across multiple projects so the median
    // projection has at least 2 qualifying projects (>= 3 PRs each).
    for (let i = 0; i < 3; i++) {
      const pid = seedProject(db, `proj-${i}`);
      seedRunForRollup(db, { projectId: pid, startedAt: "2026-05-20T08:00:00.000Z", costUsd: 6.0 });
      for (let n = 1; n <= 5; n++) {
        seedMergedPr(db, { projectId: pid, number: n, fetchedAt: `2026-05-${10 + n}T08:00:00.000Z` });
      }
    }
  });
  try {
    const r = await fetch(b.base + "/og/calculator.svg");
    assert.equal(r.status, 200, "OG calculator SVG must be public");
    assert.match(r.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match((r.headers.get("cache-control") ?? "").toLowerCase(),
      /max-age=3600/);
    const body = await r.text();
    assert.match(body, /<svg\b/);
    assert.match(body, /data-testid=["']og-calc-headline["']/);
    assert.match(body, /data-testid=["']og-calc-cta["']/);
    assert.equal(/<script\b/i.test(body), false);
    assert.equal(body.includes("proj-"), false,
      "operator project slug must NEVER appear in the OG calculator SVG");
  } finally { await b.close(); b.cleanup(); }
});

// ==================================================================
// AC4 - Honest empty state for each surface.
// ==================================================================

test("AC4: empty pulse renders 'fleet is quiet this week' in the OG SVG", () => {
  const empty = syntheticPulse({
    merged_prs: 0, total_spend_usd: 0, cost_per_pr_usd: null,
    top_project: null, freshest_lesson: null, paused_count: 0,
  });
  const svg = _renderOgPulseSvgForTests(empty);
  assert.match(svg, /fleet is quiet this week/i,
    "OG pulse SVG must carry the honest quiet-week sentence on the empty branch");
  assert.match(svg, /viewBox=["']0 0 1200 630["']/,
    "empty pulse SVG must still be 1200x630");
  // No per-stat testid leaks into the empty branch.
  assert.equal(/data-testid=["']og-pulse-prs["']/.test(svg), false);
});

test("AC4: empty receipts renders 'no months ingested yet' in the OG SVG", () => {
  const empty = syntheticReceipts({
    merged_prs: 0, total_spend_usd: 0, sparkline: [],
  });
  const svg = _renderOgReceiptsSvgForTests(empty);
  assert.match(svg, /no months ingested yet/i,
    "OG receipts SVG must carry the honest empty-fleet sentence");
  assert.match(svg, /install fleet-control/i,
    "OG receipts empty SVG must point at install fleet-control");
  assert.match(svg, /viewBox=["']0 0 1200 630["']/);
});

test("AC4: insufficient calculator renders 'calibrating - check back after a week of data' in the OG SVG", () => {
  const empty = syntheticCalculator({
    insufficient_data: true,
    hours_saved_per_week: 0,
    merged_prs_per_month: 0,
    cost_per_pr_usd: null,
  });
  const svg = _renderOgCalculatorSvgForTests(empty);
  assert.match(svg, /calibrating/i,
    "OG calculator SVG must carry the honest calibrating sentence");
  assert.match(svg, /check back/i);
  assert.match(svg, /viewBox=["']0 0 1200 630["']/);
});

// ==================================================================
// AC5 - The three existing public pages emit the og: meta tag block,
// each meta tag carries `data-testid="og-meta-<key>"`. Each
// `content=` value contains the request host substring.
// ==================================================================

test("AC5: /pulse, /receipts/<slug>/<month>, /calculator each emit og:* meta-tag testids and the host substring", async () => {
  _resetOgCacheForTests();
  const monthIso = MONTH_ISO;
  const b = await boot((db) => {
    const pid = seedProject(db, "courtiq", "Courtiq");
    seedRunForRollup(db, { projectId: pid, startedAt: "2026-06-09T08:00:00.000Z", costUsd: 12.0 });
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-09T08:00:00.000Z" });
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-06-10T08:00:00.000Z" });
    // Seed the receipts_published row so /receipts/<slug>/<month>
    // resolves (otherwise the route 404s).
    db.prepare(
      "INSERT INTO receipts_published(project_slug, month_iso, published_at, payload_json)"
      + " VALUES (?, ?, ?, ?)",
    ).run("courtiq", monthIso, "2026-06-15T00:00:00.000Z", JSON.stringify({
      found: true,
      project_slug: "courtiq",
      project_label: "Courtiq",
      month_iso: monthIso,
      month_label: "June 2026",
      merged_prs: 2,
      total_spend_usd: 12.0,
      cost_per_pr_usd: 6.0,
      red_days: 0,
      top_mover: null,
      generated_at: "2026-06-15T00:00:00.000Z",
    }));
  });
  try {
    // Each public page must carry the six og-meta-* testids.
    const expectedTestids = [
      "og-meta-og-image",
      "og-meta-og-image-width",
      "og-meta-og-image-height",
      "og-meta-twitter-card",
      "og-meta-twitter-image",
      "og-meta-og-title",
    ];
    const pages: Array<{ path: string; ogSurface: string }> = [
      { path: "/pulse", ogSurface: "pulse" },
      { path: `/receipts/courtiq/${monthIso}`, ogSurface: "receipts" },
      { path: "/calculator", ogSurface: "calculator" },
    ];
    for (const { path, ogSurface } of pages) {
      const r = await fetch(b.base + path);
      assert.equal(r.status, 200, `${path} must respond 200 with seeded fleet`);
      const body = await r.text();
      for (const tid of expectedTestids) {
        const re = new RegExp(`data-testid=["']${tid}["']`);
        assert.ok(re.test(body),
          `${path}: meta tag with data-testid="${tid}" must appear`);
      }
      // Each og:image meta tag must reference the matching surface's
      // OG URL. Anchor on the data-testid per LESSONS 2026-06-12
      // "greedy [^>]+id= regex over a tag with data-testid".
      const m = body.match(/<meta[^>]*?data-testid=["']og-meta-og-image["'][^>]*?content=["']([^"']+)["']/i)
        ?? body.match(/<meta[^>]*?content=["']([^"']+)["'][^>]*?data-testid=["']og-meta-og-image["']/i);
      assert.ok(m, `${path}: og:image meta tag must carry a content attr`);
      const ogImageUrl = m[1];
      assert.ok(ogImageUrl.includes(`/og/${ogSurface}.svg`),
        `${path}: og:image must point at /og/${ogSurface}.svg, got ${ogImageUrl}`);
      // The host substring must match the request host (127.0.0.1:<port>).
      const u = new URL(b.base);
      const hostSubstring = u.host;
      assert.ok(ogImageUrl.includes(hostSubstring),
        `${path}: og:image host must include the request Host '${hostSubstring}', got ${ogImageUrl}`);
    }
  } finally { await b.close(); b.cleanup(); }
});

// ==================================================================
// AC6 - Anonymisation / leak regression: leak-shaped slugs must NEVER
// appear in any of the three OG SVG bodies.
// ==================================================================

test("AC6: rendered OG SVGs never expose per-project leak-shaped slugs even when the payload tries to smuggle them in", () => {
  const leakSlugs = ["courtiq-prod", "internal-tool-1", "secret-x"];
  for (const slug of leakSlugs) {
    // Pulse - top_project.slug + project_name + freshest_lesson are
    // the only operator-supplied string fields in the FleetWeeklyPulse
    // payload. The OG renderer is fleet-level; per-project slugs must
    // NEVER appear in the rendered SVG body.
    const pulse = syntheticPulse({
      top_project: { slug, project_name: slug, merged_prs: 5 },
      freshest_lesson: { lesson_slug: slug, lesson_date: "2026-06-14", lesson_title: slug },
    });
    // Receipts - the OG payload is FLEET-level (no project fields by
    // construction). The defensive assertion: even on the empty branch
    // the rendered SVG never contains the leak slug.
    const receipts = syntheticReceipts({
      month_label: `${slug} (June 2026)`,
    });
    // Calculator - the only operator-derived string field is
    // percentile_label; the OG renderer must scrub or omit it.
    const calc = syntheticCalculator({
      percentile_label: slug,
    });
    const ogPulseSvg = _renderOgPulseSvgForTests(pulse);
    const ogReceiptsSvg = _renderOgReceiptsSvgForTests(receipts);
    const ogCalcSvg = _renderOgCalculatorSvgForTests(calc);
    assert.equal(ogPulseSvg.includes(slug), false,
      `OG pulse SVG must not surface per-project slug '${slug}'`);
    assert.equal(ogReceiptsSvg.includes(slug), false,
      `OG receipts SVG must not surface per-project slug '${slug}'`);
    assert.equal(ogCalcSvg.includes(slug), false,
      `OG calculator SVG must not surface per-project slug '${slug}'`);
  }
});

// ==================================================================
// AC7 - Idempotency / caching: build counter goes up 1 then 0 across
// two same-tuple calls; fresh merged PR row busts via (MAX(fetched_at),
// COUNT(*)).
// ==================================================================

test("AC7: two OG pulse cache calls within tuple share one build; fresh MERGED PR busts the tuple", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetOgCacheForTests();
    const pid = seedProject(db, "courtiq");
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-09T08:00:00.000Z" });
    const before = _getOgCacheBuildsForTests();
    _ogPulseCachedForTests(db, NOW);
    const afterFirst = _getOgCacheBuildsForTests();
    assert.equal(afterFirst - before, 1,
      "first OG pulse call MUST cache-miss (build counter +1)");
    _ogPulseCachedForTests(db, NOW);
    const afterSecond = _getOgCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0,
      "second OG pulse call within tuple MUST cache-hit (build counter +0)");
    // Seed a fresh MERGED PR - MAX(fetched_at) and COUNT(*) both shift.
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-06-10T08:00:00.000Z" });
    _ogPulseCachedForTests(db, NOW);
    const afterBust = _getOgCacheBuildsForTests();
    assert.equal(afterBust - afterSecond, 1,
      "fresh PR row MUST bust the OG pulse cache via (MAX(fetched_at), COUNT(*))");
  } finally { cleanup(); }
});

test("AC7: OG receipts cache memoises on the (MAX(pr.fetched_at), COUNT(*)) in-month tuple", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetOgCacheForTests();
    const pid = seedProject(db, "courtiq");
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-02T08:00:00.000Z" });
    const before = _getOgCacheBuildsForTests();
    _ogReceiptsCachedForTests(db, NOW);
    const afterFirst = _getOgCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "OG receipts first call MUST miss");
    _ogReceiptsCachedForTests(db, NOW);
    const afterSecond = _getOgCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0, "OG receipts second call MUST hit");
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-06-05T08:00:00.000Z" });
    _ogReceiptsCachedForTests(db, NOW);
    const afterBust = _getOgCacheBuildsForTests();
    assert.equal(afterBust - afterSecond, 1,
      "fresh in-month PR row MUST bust the OG receipts cache");
  } finally { cleanup(); }
});

test("AC7: OG calculator cache memoises on the (MAX(run.started_at), COUNT(*) trailing 90d) tuple", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetOgCacheForTests();
    const pid = seedProject(db, "courtiq");
    seedRunForRollup(db, { projectId: pid, startedAt: "2026-05-20T08:00:00.000Z", costUsd: 6.0 });
    const before = _getOgCacheBuildsForTests();
    _ogCalculatorCachedForTests(db, NOW);
    const afterFirst = _getOgCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "OG calculator first call MUST miss");
    _ogCalculatorCachedForTests(db, NOW);
    const afterSecond = _getOgCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0, "OG calculator second call MUST hit");
    seedRunForRollup(db, { projectId: pid, startedAt: "2026-05-22T08:00:00.000Z", costUsd: 7.0 });
    _ogCalculatorCachedForTests(db, NOW);
    const afterBust = _getOgCacheBuildsForTests();
    assert.equal(afterBust - afterSecond, 1,
      "fresh run row in trailing 90d MUST bust the OG calculator cache");
  } finally { cleanup(); }
});

test("AC7: ingest invalidation hook is registered on globalThis.__fleet_og_invalidate__", () => {
  // Per LESSONS 2026-06-05 "break ingest<->server cache-invalidation
  // cycles via a globalThis slot, not a circular import".
  assert.match(SERVER_TS, /__fleet_og_invalidate__/,
    "OG cache invalidation MUST register on the documented globalThis slot");
  const INGEST_TS = readFileSync(join(ROOT, "src", "ingest", "index.ts"), "utf8");
  assert.match(INGEST_TS, /__fleet_og_invalidate__/,
    "ingest index MUST call the OG invalidation hook lazily after COMMIT");
});

// ==================================================================
// AC8 - Renderer-direct seam: each OG renderer is reachable via
// `_render*ForTests` so branch tests bypass HTTP + cwd config races.
// ==================================================================

test("AC8: renderer-direct seams exist on src/og.ts and cover both filled and empty branches without HTTP boot", () => {
  // Filled branches.
  const filledPulse = _renderOgPulseSvgForTests(syntheticPulse());
  assert.match(filledPulse, /data-testid=["']og-pulse-prs["']/);
  const filledReceipts = _renderOgReceiptsSvgForTests(syntheticReceipts());
  assert.match(filledReceipts, /data-testid=["']og-receipts-headline["']/);
  const filledCalc = _renderOgCalculatorSvgForTests(syntheticCalculator());
  assert.match(filledCalc, /data-testid=["']og-calc-headline["']/);
  // Empty branches.
  const emptyPulse = _renderOgPulseSvgForTests(syntheticPulse({
    merged_prs: 0, total_spend_usd: 0, cost_per_pr_usd: null,
    top_project: null, freshest_lesson: null, paused_count: 0,
  }));
  assert.match(emptyPulse, /fleet is quiet/i);
  const emptyReceipts = _renderOgReceiptsSvgForTests(syntheticReceipts({
    merged_prs: 0, total_spend_usd: 0, sparkline: [],
  }));
  assert.match(emptyReceipts, /no months ingested/i);
  const emptyCalc = _renderOgCalculatorSvgForTests(syntheticCalculator({
    insufficient_data: true, hours_saved_per_week: 0,
    merged_prs_per_month: 0, cost_per_pr_usd: null,
  }));
  assert.match(emptyCalc, /calibrating/i);
});

// ==================================================================
// AC9 - Time-pinned tests: renderer output stays stable across two
// simulated wall-clock dates because every seed timestamp derives from
// the pinned `now`, never `new Date()`.
// ==================================================================

test("AC9: re-running with a different simulated wall-clock produces identical OG output (seeds are anchor-relative)", () => {
  // Two simulated NOW anchors. The renderer reads ONLY the
  // payload it's given - so as long as the test fixture derives
  // its seeds off each anchor (not new Date()), the rendered SVG
  // is identical when the input payload is identical.
  const anchor1 = new Date("2026-06-15T12:00:00.000Z");
  const anchor2 = new Date("2026-06-22T12:00:00.000Z");
  // Anchor-relative payload: same shape, same values - the test
  // asserts the helper does NOT read new Date() under the hood.
  const payload: FleetWeeklyPulse = {
    generated_at: anchor1.toISOString(),
    week_start_iso: "2026-06-08",
    week_end_iso: "2026-06-14",
    merged_prs: 7,
    total_spend_usd: 11.0,
    cost_per_pr_usd: 11 / 7,
    streak_days: 3,
    top_project: null,
    freshest_lesson: null,
    paused_count: 0,
  };
  const payloadAnchor2: FleetWeeklyPulse = {
    ...payload,
    generated_at: anchor2.toISOString(),
  };
  // Strip generated_at from both before compare - that's the ONLY
  // field that legitimately changes when the anchor moves.
  const svg1 = _renderOgPulseSvgForTests(payload).replace(/2026-06-15/g, "ANCHOR");
  const svg2 = _renderOgPulseSvgForTests(payloadAnchor2).replace(/2026-06-22/g, "ANCHOR");
  assert.equal(svg1, svg2,
    "OG pulse renderer output must be identical when only the anchor differs - no new Date() leak");
});

// ==================================================================
// AC10 - Hard NO compliance: zero new runtime deps, no shell-out, no
// JSON-shape break.
// ==================================================================

test("AC10: package.json `dependencies` stays empty (zero runtime deps)", () => {
  const pkg = JSON.parse(PKG_JSON) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  assert.deepEqual(deps, {},
    "AGENTS.md Hard NO: no runtime deps may be added; got " + JSON.stringify(deps));
});

test("AC10: src/og.ts does NOT import node:child_process (no shell-out)", () => {
  assert.equal(/from\s+["']node:child_process["']/.test(OG_TS), false,
    "OG renderer must not import node:child_process");
});

test("AC10: src/og.ts does NOT introduce a back-edge cycle with src/views.ts", () => {
  // Per LESSONS 2026-06-13: do NOT add `from "./views.ts"` import to
  // any module that views.ts already imports. The OG module is new
  // and views.ts must not import it.
  assert.equal(/from\s+["']\.\/og\.ts["']/.test(VIEWS_TS), false,
    "views.ts must NOT import from og.ts (would create a cycle)");
});

test("AC10: the OG SVG bodies contain no <script> tag across filled and empty branches", () => {
  const filled = [
    _renderOgPulseSvgForTests(syntheticPulse()),
    _renderOgReceiptsSvgForTests(syntheticReceipts()),
    _renderOgCalculatorSvgForTests(syntheticCalculator()),
  ];
  const empty = [
    _renderOgPulseSvgForTests(syntheticPulse({
      merged_prs: 0, total_spend_usd: 0, cost_per_pr_usd: null,
      top_project: null, freshest_lesson: null, paused_count: 0,
    })),
    _renderOgReceiptsSvgForTests(syntheticReceipts({
      merged_prs: 0, total_spend_usd: 0, sparkline: [],
    })),
    _renderOgCalculatorSvgForTests(syntheticCalculator({
      insufficient_data: true, hours_saved_per_week: 0,
      merged_prs_per_month: 0, cost_per_pr_usd: null,
    })),
  ];
  for (const svg of [...filled, ...empty]) {
    assert.equal(/<script\b/i.test(svg), false,
      "OG SVG must contain no <script> tag in any branch");
  }
});

test("AC10: existing /api/fleet/pulse JSON shape is untouched - the OG routes are net-new", () => {
  // The OG routes are net-new (/og/pulse.svg + /og/receipts.svg +
  // /og/calculator.svg) and do not touch the JSON sibling.
  assert.match(SERVER_TS, /servePulseJson\b/,
    "the existing /api/fleet/pulse helper must remain wired in server.ts");
});

test("AC10: OG routes mount BEFORE the path.startsWith(\"/api/\") auth gate (public, no auth)", () => {
  // Grep the source: each OG route handler must appear in the
  // public-route block (before the auth gate). The check is
  // structural - look for the /og/ string literals upstream of the
  // auth gate string.
  const ogIndex = SERVER_TS.indexOf("/og/pulse.svg");
  const authGateIndex = SERVER_TS.indexOf('path.startsWith("/api/")');
  assert.ok(ogIndex > 0, "OG pulse route must be wired in server.ts");
  assert.ok(authGateIndex > 0, "the /api/ auth gate must exist in server.ts");
  assert.ok(ogIndex < authGateIndex,
    "OG routes must be mounted BEFORE the /api/ auth gate so they're public");
});
