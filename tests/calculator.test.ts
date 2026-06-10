// Tests for ticket 0051 — Pre-install ROI calculator.
//
// Public /calculator page projects fleet-control's value before install.
// One test(...) per acceptance-criteria checkbox; same strategy as the
// 0044 spend-efficiency + 0048 worth-it suites:
//   - Drive `fleetMedianProjection(db, now, opts)` and
//     `computeRoiProjection(median, inputs)` directly against a tmpdir
//     DB for the helper's shape + percentile arithmetic + projection
//     arithmetic.
//   - Boot `startServer()` over loopback for the route + cache tests,
//     using the empty-roots config + tmp fleet-control.config.json seam
//     from LESSONS § "in-process startServer() tests need an empty-roots
//     config + run-row seeds".
//   - Validate the /calculator HTML page renders form + result block by
//     scanning the response body for the documented data-testid
//     attributes (the page is pure HTML, no JS — text-level checks are
//     sufficient).
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps from
// `new Date()`": every seed timestamp anchors to the test's NOW constant
// via daysBeforeNow / dayBeforeNow helpers that read NOW, never
// `new Date()`.
// Per LESSONS 2026-06-05 / 0040 reconciliation: the producer's literal
// casing is the contract — merged PRs are `state='MERGED'` uppercase +
// `is_agent=1` (matches spendEfficiencyRanking / projectWorthItVerdict).
// The `pr` table has NO surrogate `id` (PK is `(project_id, number)`)
// per LESSONS 2026-06-07 — the cache invalidation tuple in the route
// proxies via `(MAX(pr.fetched_at), COUNT(*), MAX(run.ended_at))`.
// Per LESSONS § "expose a build counter for cache-hit tests, not a
// fetcher swap": AC6 uses `_getMedianProjectionCacheBuildsForTests()`.
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
  fleetMedianProjection,
  computeRoiProjection,
  type FleetMedianProjection,
  type RoiProjection,
} from "../src/views.ts";
import {
  startServer,
  _resetMedianProjectionCacheForTests,
  _getMedianProjectionCacheBuildsForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ────────────────────────────────────────────────────────────────────
// Helpers — pinned-now seeders (LESSONS 2026-05-29).
// ────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-10T12:00:00.000Z");

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-calc-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string, name?: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace) VALUES (?,?,?)",
  ).run(slug, name ?? slug, "test");
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

function daysBeforeNow(d: number, base: Date = NOW): string {
  return new Date(base.getTime() - d * 86400_000).toISOString();
}

function dayBeforeNow(d: number, base: Date = NOW): string {
  return daysBeforeNow(d, base).slice(0, 10);
}

interface PrSeed {
  projectId: number;
  number: number;
  state?: string;
  isAgent?: number;
  fetchedAt: string;
  closedAt?: string | null;
}

function seedMergedPr(db: DB, opts: PrSeed): void {
  db.prepare(
    "INSERT INTO pr("
    + "project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
    + "additions,deletions,author,url,fetched_at,gh_created_at,"
    + "first_fail_check,first_fail_excerpt,heal_attempts,closed_at"
    + ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, `pr-${opts.number}`,
    `feat/${opts.number}`,
    opts.state ?? "MERGED",
    "green", null,
    opts.isAgent ?? 1,
    0, 0,
    "a", `https://github.com/owner/x/pull/${opts.number}`,
    opts.fetchedAt, opts.fetchedAt,
    null, null,
    0,
    opts.closedAt ?? null,
  );
}

function seedCost(db: DB, projectId: number, day: string, costUsd: number, phase: string = "ship"): void {
  db.prepare(
    "INSERT INTO cost_rollup_day(project_id, phase, day, runs, input_tokens, output_tokens, "
    + "cache_creation_tokens, cache_read_tokens, cost_usd) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(projectId, phase, day, 1, 0, 0, 0, 0, costUsd);
}

let _sessionCounter = 0;
function seedRun(db: DB, opts: {
  projectId: number; outcome: string; startedAt: string; phase?: string;
}): number {
  _sessionCounter += 1;
  const sid = `sess-${_sessionCounter}-${opts.projectId}-${opts.outcome}`;
  db.prepare(
    "INSERT INTO run(project_id, phase, session_id, started_at, ended_at, duration_ms, exit_code, "
    + "num_turns, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, "
    + "cost_usd, cost_source, model, summary, outcome, pr_number, source) "
    + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.phase ?? "ship", sid, opts.startedAt, opts.startedAt,
    1000, 0, 1, 0, 0, 0, 0,
    null, "live", "claude-opus-4-7", "ok", opts.outcome, null, "runs.jsonl",
  );
  return (db.prepare(
    "SELECT id FROM run WHERE project_id=? AND phase=? AND session_id=?",
  ).get(opts.projectId, opts.phase ?? "ship", sid) as { id: number }).id;
}

/** Seed `n` merged PRs distributed across the trailing windowDays so
 *  per-month throughput sums to roughly `n × (30/windowDays)`. Used by
 *  the percentile tests to compose a project with a known
 *  per-month-merged value. */
function seedNMergedAcrossWindow(
  db: DB, projectId: number, n: number, opts: {
    windowDays: number; base?: Date; startNumber?: number;
  },
): void {
  const base = opts.base ?? NOW;
  const startNumber = opts.startNumber ?? 1000;
  const wd = opts.windowDays;
  for (let i = 0; i < n; i++) {
    const dayOffset = Math.min(wd - 1, Math.floor((i * wd) / Math.max(1, n)));
    seedMergedPr(db, {
      projectId,
      number: startNumber + i,
      fetchedAt: daysBeforeNow(dayOffset, base),
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// AC1 — fleetMedianProjection shape + p25 percentile + insufficient
//        fleet floor.
// ────────────────────────────────────────────────────────────────────

test("AC1: fleetMedianProjection returns the documented shape with default p25 percentile and 90-day window", () => {
  const { db, cleanup } = tempDb();
  try {
    // Seed 5 projects with 10/15/21/30/45 merged PRs over 90d so the
    // per-project merged-PRs-per-month values are
    // 10×(30/90)=3.33, 15×(30/90)=5, 21×(30/90)=7,
    // 30×(30/90)=10, 45×(30/90)=15.
    // Sorted ASC: [3.33, 5, 7, 10, 15]; p25 index = ceil(0.25*5)-1 = 1
    // → value 5. So p25 ≈ 5. (The conservative contract: under-promise.)
    const slugs = ["a-ten", "b-fifteen", "c-twentyone", "d-thirty", "e-fortyfive"];
    const counts = [10, 15, 21, 30, 45];
    for (let i = 0; i < slugs.length; i++) {
      const pid = seedProject(db, slugs[i]);
      seedNMergedAcrossWindow(db, pid, counts[i], { windowDays: 90 });
      // Modest spend so cost_per_pr is positive but small (we don't
      // assert spend here; AC2 covers spend arithmetic).
      for (let d = 0; d < 90; d += 30) {
        seedCost(db, pid, dayBeforeNow(d), 10);
      }
    }
    const v = fleetMedianProjection(db, NOW) as FleetMedianProjection;
    assert.equal(v.window_days, 90);
    assert.equal(v.percentile, "p25");
    assert.equal(v.projects_observed, 5);
    // p25 of [3.33, 5, 7, 10, 15] = 5 (within ±0.5 to account for the
    // exact percentile selection rule). The conservative under-promise:
    // we surface the 25th-percentile project, NOT the median (which
    // would be 7).
    assert.ok(
      v.merged_prs_per_month >= 4.5 && v.merged_prs_per_month <= 6.5,
      `p25 should be ~5; got ${v.merged_prs_per_month}`,
    );
    assert.ok(v.spend_usd_per_month >= 0, `spend per month must be non-negative; got ${v.spend_usd_per_month}`);
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(v.generated_at));
  } finally { cleanup(); }
});

test("AC1: fleetMedianProjection with opts.percentile='median' returns the 50th-percentile project", () => {
  const { db, cleanup } = tempDb();
  try {
    const slugs = ["a-ten", "b-fifteen", "c-twentyone", "d-thirty", "e-fortyfive"];
    const counts = [10, 15, 21, 30, 45];
    for (let i = 0; i < slugs.length; i++) {
      const pid = seedProject(db, slugs[i]);
      seedNMergedAcrossWindow(db, pid, counts[i], { windowDays: 90 });
    }
    const v = fleetMedianProjection(db, NOW, { percentile: "median" });
    assert.equal(v.percentile, "median");
    // Per-month series: [3.33, 5, 7, 10, 15]; median = 7.
    assert.ok(
      v.merged_prs_per_month >= 6.5 && v.merged_prs_per_month <= 7.5,
      `median should be ~7; got ${v.merged_prs_per_month}`,
    );
  } finally { cleanup(); }
});

test("AC1: fewer than 2 qualifying projects → merged_prs_per_month=0, spend=0, cost_per_pr=null", () => {
  const { db, cleanup } = tempDb();
  try {
    // ONE qualifying project (with >= 3 merged PRs).
    const pid = seedProject(db, "alpha");
    for (let i = 1; i <= 10; i++) {
      seedMergedPr(db, { projectId: pid, number: i, fetchedAt: daysBeforeNow(i) });
    }
    // Another project with only 2 merged PRs → below the 3-PR floor →
    // excluded from the percentile. Net: 1 qualifying project.
    const pid2 = seedProject(db, "bravo");
    seedMergedPr(db, { projectId: pid2, number: 1, fetchedAt: daysBeforeNow(1) });
    seedMergedPr(db, { projectId: pid2, number: 2, fetchedAt: daysBeforeNow(2) });

    const v = fleetMedianProjection(db, NOW);
    assert.equal(v.merged_prs_per_month, 0);
    assert.equal(v.spend_usd_per_month, 0);
    assert.equal(v.cost_per_pr_usd, null);
    // projects_observed counts the total seen (we expose the raw count
    // so the caller can render "insufficient fleet data" with context).
    assert.ok(v.projects_observed >= 1);
  } finally { cleanup(); }
});

test("AC1: empty DB returns all-zero / null shape (insufficient fleet)", () => {
  const { db, cleanup } = tempDb();
  try {
    const v = fleetMedianProjection(db, NOW);
    assert.equal(v.merged_prs_per_month, 0);
    assert.equal(v.spend_usd_per_month, 0);
    assert.equal(v.cost_per_pr_usd, null);
    assert.equal(v.projects_observed, 0);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — computeRoiProjection arithmetic (pure helper, no DB).
// ────────────────────────────────────────────────────────────────────

test("AC2: computeRoiProjection: median 15 PRs/mo @ $2.10/PR × 3 repos × $100/h × 1h/PR → ROI ≈ 47.6x", () => {
  const median: FleetMedianProjection = {
    window_days: 90,
    projects_observed: 5,
    merged_prs_per_month: 15,
    spend_usd_per_month: 31.5, // = 15 × 2.10
    cost_per_pr_usd: 2.10,
    percentile: "p25",
    generated_at: NOW.toISOString(),
  };
  const r = computeRoiProjection(median, { repos: 3, hourlyRateUsd: 100 }) as RoiProjection;
  assert.equal(r.projected_merged_prs, 45);
  // 15 × 2.10 × 3 = 94.50
  assert.ok(Math.abs(r.projected_spend_usd - 94.5) < 1e-9, `spend should be 94.5; got ${r.projected_spend_usd}`);
  // 45 × 1 × 100 = 4500
  assert.equal(r.human_equivalent_cost_usd, 4500);
  // 4500 / 94.5 = 47.619...
  assert.ok(r.roi_multiplier != null);
  assert.ok(
    Math.abs((r.roi_multiplier as number) - (4500 / 94.5)) < 1e-9,
    `ROI should be ~47.6; got ${r.roi_multiplier}`,
  );
  assert.equal(r.projected_cost_per_pr_usd, 2.10);
  assert.match(r.percentile_label, /conservative/i);
  assert.match(r.percentile_label, /25th/i);
});

test("AC2: computeRoiProjection: hoursPerPr defaults to 1 and can be overridden", () => {
  const median: FleetMedianProjection = {
    window_days: 90,
    projects_observed: 5,
    merged_prs_per_month: 10,
    spend_usd_per_month: 20,
    cost_per_pr_usd: 2,
    percentile: "p25",
    generated_at: NOW.toISOString(),
  };
  const a = computeRoiProjection(median, { repos: 1, hourlyRateUsd: 75 });
  // 10 × 1 × 75 = 750 human-equiv; spend = 10 × 2 × 1 = 20; ROI = 37.5
  assert.equal(a.human_equivalent_cost_usd, 750);
  assert.ok(Math.abs((a.roi_multiplier as number) - 37.5) < 1e-9);
  const b = computeRoiProjection(median, { repos: 1, hourlyRateUsd: 75, hoursPerPr: 2 });
  // 10 × 2 × 75 = 1500
  assert.equal(b.human_equivalent_cost_usd, 1500);
});

test("AC2: computeRoiProjection: roi_multiplier is null when spend is zero (insufficient fleet)", () => {
  const median: FleetMedianProjection = {
    window_days: 90,
    projects_observed: 1,
    merged_prs_per_month: 0,
    spend_usd_per_month: 0,
    cost_per_pr_usd: null,
    percentile: "p25",
    generated_at: NOW.toISOString(),
  };
  const r = computeRoiProjection(median, { repos: 3, hourlyRateUsd: 100 });
  assert.equal(r.projected_merged_prs, 0);
  assert.equal(r.projected_spend_usd, 0);
  assert.equal(r.roi_multiplier, null);
  assert.equal(r.projected_cost_per_pr_usd, null);
});

// ────────────────────────────────────────────────────────────────────
// AC3 — GET /api/fleet/median-projection JSON; public (no auth); never
//        leaks per-project rows.
// ────────────────────────────────────────────────────────────────────

test("AC3: GET /api/fleet/median-projection returns 200 + aggregated shape WITHOUT auth headers", async () => {
  _resetMedianProjectionCacheForTests();
  const b = await boot((db) => {
    // Seed 5 named projects so we can later assert NO slug appears in
    // the response body.
    const slugs = ["alpha", "bravo", "charlie", "delta", "echo"];
    const counts = [10, 15, 21, 30, 45];
    const recent = NOW.toISOString();
    for (let i = 0; i < slugs.length; i++) {
      const pid = seedProject(db, slugs[i]);
      for (let k = 0; k < counts[i]; k++) {
        seedRun(db, { projectId: pid, outcome: "shipped", startedAt: recent });
        seedMergedPr(db, { projectId: pid, number: k + 1, fetchedAt: recent });
      }
    }
  });
  try {
    // NO x-fleet-token header — public route.
    const r = await fetch(b.base + "/api/fleet/median-projection");
    assert.equal(r.status, 200);
    const text = await r.text();
    const j = JSON.parse(text) as FleetMedianProjection;
    assert.equal(typeof j.merged_prs_per_month, "number");
    assert.equal(typeof j.spend_usd_per_month, "number");
    assert.equal(typeof j.window_days, "number");
    assert.equal(typeof j.projects_observed, "number");
    assert.ok(j.percentile === "p25" || j.percentile === "median");
    // Privacy: no per-project rows / slugs / names in the JSON.
    assert.doesNotMatch(text, /"project_slug"/);
    assert.doesNotMatch(text, /"project_name"/);
    assert.doesNotMatch(text, /"is_agent"/);
    assert.doesNotMatch(text, /"slug":/);
    assert.doesNotMatch(text, /"name":/);
    // Privacy: none of the seeded project slugs appear anywhere in the
    // response body (defence-in-depth grep on the rendered string).
    for (const seedSlug of ["alpha", "bravo", "charlie", "delta", "echo"]) {
      assert.ok(
        !text.includes(seedSlug),
        `response leaked seeded slug '${seedSlug}': ${text}`,
      );
    }
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — GET /calculator HTML page renders form + (optionally) result
//        block; pre-fills from query params; install-CTA present.
// ────────────────────────────────────────────────────────────────────

test("AC4: GET /calculator without query params renders the form, no result block", async () => {
  _resetMedianProjectionCacheForTests();
  const b = await boot();
  try {
    const r = await fetch(b.base + "/calculator");
    assert.equal(r.status, 200);
    const ct = (r.headers.get("content-type") ?? "").toLowerCase();
    assert.match(ct, /text\/html/);
    const html = await r.text();
    // Form testids must be present.
    assert.match(html, /data-testid="calculator-username"/);
    assert.match(html, /data-testid="calculator-repos"/);
    assert.match(html, /data-testid="calculator-rate"/);
    assert.match(html, /data-testid="calculator-submit"/);
    assert.match(html, /data-testid="calculator-install-cta"/);
    // form action=/calculator method=GET (bookmarkable URL).
    assert.match(html, /action="\/calculator"/);
    assert.match(html, /method="get"/i);
    // No result block when there are no query params.
    assert.doesNotMatch(html, /data-testid="calculator-result"/);
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: GET /calculator?u=foo&n=3&r=100 pre-fills the form AND renders the result block", async () => {
  _resetMedianProjectionCacheForTests();
  const b = await boot((db) => {
    // Seed enough projects for the median to be meaningful (≥ 2
    // qualifying projects).
    const recent = NOW.toISOString();
    for (const slug of ["aa", "bb", "cc", "dd"]) {
      const pid = seedProject(db, slug);
      for (let i = 1; i <= 12; i++) {
        seedRun(db, { projectId: pid, outcome: "shipped", startedAt: recent });
        seedMergedPr(db, { projectId: pid, number: i, fetchedAt: recent });
      }
    }
  });
  try {
    const r = await fetch(b.base + "/calculator?u=foo&n=3&r=100");
    assert.equal(r.status, 200);
    const html = await r.text();
    // Form pre-fill: input values must contain the supplied params.
    assert.match(html, /value="foo"/);
    assert.match(html, /value="3"/);
    assert.match(html, /value="100"/);
    // Result block rendered.
    assert.match(html, /data-testid="calculator-result"/);
    // Username personalisation prefix.
    assert.match(html, /foo/);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — Input validation: clamp / reject / preserve.
// ────────────────────────────────────────────────────────────────────

test("AC5: GET /calculator?n=999 clamps repos to 20 (the upper bound)", async () => {
  _resetMedianProjectionCacheForTests();
  const b = await boot((db) => {
    const recent = NOW.toISOString();
    for (const slug of ["aa", "bb", "cc"]) {
      const pid = seedProject(db, slug);
      for (let i = 1; i <= 8; i++) {
        seedRun(db, { projectId: pid, outcome: "shipped", startedAt: recent });
        seedMergedPr(db, { projectId: pid, number: i, fetchedAt: recent });
      }
    }
  });
  try {
    const r = await fetch(b.base + "/calculator?u=foo&n=999&r=100");
    assert.equal(r.status, 200);
    const html = await r.text();
    // The repos input must carry the clamped value '20' (not 999).
    assert.match(html, /name="n"[^>]*value="20"|value="20"[^>]*name="n"/);
    // No error block — clamping is silent (the value sits between
    // valid bounds; the form just shows the clamp).
    // (We don't assert absence of calculator-error because the spec is
    // silent on whether clamps emit a soft notice — the AC only says
    // "submit n=999, assert the result clamps to 20".)
  } finally { await b.close(); b.cleanup(); }
});

test("AC5: GET /calculator?r=-5 renders an error and retains the offending input", async () => {
  _resetMedianProjectionCacheForTests();
  const b = await boot();
  try {
    const r = await fetch(b.base + "/calculator?u=foo&n=3&r=-5");
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /data-testid="calculator-error"/);
    // The rate input retains the offending value so the user can see
    // and correct it.
    assert.match(html, /value="-5"/);
  } finally { await b.close(); b.cleanup(); }
});

test("AC5: GET /calculator?u=foo%20bar renders an error and retains the offending username", async () => {
  _resetMedianProjectionCacheForTests();
  const b = await boot();
  try {
    const r = await fetch(b.base + "/calculator?u=foo%20bar&n=3&r=100");
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /data-testid="calculator-error"/);
    // The username input retains the offending value (escaped — &nbsp;
    // or " " stays in the value, escaped via &amp; if needed). The
    // space gets through because percent-decoding happened on the
    // server.
    assert.match(html, /value="foo bar"/);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Caching: HTML page = max-age=300; JSON route = max-age=900;
//        median memoises per (MAX(fetched_at), COUNT(*),
//        MAX(run.ended_at)). New PR busts cache.
// ────────────────────────────────────────────────────────────────────

test("AC6: GET /api/fleet/median-projection sets cache-control: max-age=900 and memoises via build counter", async () => {
  _resetMedianProjectionCacheForTests();
  const b = await boot((db) => {
    const recent = NOW.toISOString();
    for (const slug of ["aa", "bb", "cc"]) {
      const pid = seedProject(db, slug);
      for (let i = 1; i <= 8; i++) {
        seedRun(db, { projectId: pid, outcome: "shipped", startedAt: recent });
        seedMergedPr(db, { projectId: pid, number: i, fetchedAt: recent });
      }
    }
  });
  try {
    const before = _getMedianProjectionCacheBuildsForTests();
    const r1 = await fetch(b.base + "/api/fleet/median-projection");
    assert.equal(r1.status, 200);
    const cc = (r1.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=900/, `cache-control must declare max-age=900; got '${cc}'`);
    await r1.json();
    const afterFirst = _getMedianProjectionCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call → cache MISS, build counter += 1");

    const r2 = await fetch(b.base + "/api/fleet/median-projection");
    assert.equal(r2.status, 200);
    await r2.json();
    const afterSecond = _getMedianProjectionCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0,
      "second call within window → cache HIT, counter unchanged");

    // Insert a new MERGED PR for any project → the (MAX(fetched_at),
    // COUNT(*)) component of the cache tuple advances → the next call
    // must rebuild.
    const db2 = openDb(b.dbPath);
    try {
      const pid = (db2.prepare("SELECT id FROM project WHERE slug=?").get("aa") as { id: number }).id;
      db2.prepare(
        "INSERT INTO pr("
        + "project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
        + "additions,deletions,author,url,fetched_at,gh_created_at,"
        + "first_fail_check,first_fail_excerpt,heal_attempts,closed_at"
        + ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        pid, 9999, "fresh", "feat/9999", "MERGED", "green", null, 1,
        0, 0, "a", "https://github.com/owner/x/pull/9999",
        NOW.toISOString(), NOW.toISOString(), null, null, 0, null,
      );
    } finally { db2.close(); }

    const r3 = await fetch(b.base + "/api/fleet/median-projection");
    assert.equal(r3.status, 200);
    await r3.json();
    const afterThird = _getMedianProjectionCacheBuildsForTests();
    assert.equal(afterThird - afterSecond, 1,
      "after a new PR lands, next call rebuilds → counter += 1");
  } finally { await b.close(); b.cleanup(); }
});

test("AC6: GET /calculator HTML page sets cache-control: max-age=300", async () => {
  _resetMedianProjectionCacheForTests();
  const b = await boot();
  try {
    const r = await fetch(b.base + "/calculator");
    assert.equal(r.status, 200);
    const cc = (r.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=300/, `cache-control must declare max-age=300; got '${cc}'`);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Empty-fleet behaviour: <2 qualifying projects → honest
//        "insufficient fleet data" message + demo link; form remains
//        usable.
// ────────────────────────────────────────────────────────────────────

test("AC7: GET /calculator?u=foo&n=3&r=100 against an empty DB renders the empty-fleet message + demo link", async () => {
  _resetMedianProjectionCacheForTests();
  const b = await boot(); // no seeds
  try {
    const r = await fetch(b.base + "/calculator?u=foo&n=3&r=100");
    assert.equal(r.status, 200);
    const html = await r.text();
    // Honest fallback copy: "too small to compute" / "insufficient
    // fleet data" / "try the demo at /demo".
    assert.match(html, /\/demo/);
    assert.match(html, /(insufficient|too small|fleet data|try the demo)/i);
    // The form remains usable: every input testid still present.
    assert.match(html, /data-testid="calculator-username"/);
    assert.match(html, /data-testid="calculator-repos"/);
    assert.match(html, /data-testid="calculator-rate"/);
    // No broken numeric result block (the "result" testid may or may
    // not appear depending on whether we use it as the empty-fleet
    // wrapper; but if it appears it must not contain a numeric ROI
    // multiplier line like "47.6x" or similar).
    // We assert no '<NaN' / '$NaN' / 'x ROI' broken renders.
    assert.doesNotMatch(html, /NaN/);
    assert.doesNotMatch(html, /\$Infinity/);
    assert.doesNotMatch(html, /undefined/);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Mobile: 375px / 768px viewport rules in the inline style.
// ────────────────────────────────────────────────────────────────────

test("AC8: /calculator HTML contains a viewport meta + mobile-first inline style rules at 375px", async () => {
  const b = await boot();
  try {
    const r = await fetch(b.base + "/calculator");
    assert.equal(r.status, 200);
    const html = await r.text();
    // Viewport meta tag enables proper mobile rendering.
    assert.match(html, /<meta[^>]+name="viewport"/);
    // Inline <style> block exists and mentions mobile (375px) breakpoint
    // OR has a single-column form layout that works at narrow widths.
    assert.match(html, /<style/);
    // Either a @media (max-width: 375px) rule or a tablet-+ breakpoint
    // at 768px must be present so the form has a deliberate mobile
    // contract per the 0011 mobile-first pass.
    assert.match(html, /max-width:\s*375px|min-width:\s*768px|max-width:\s*768px/);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Defensive privacy: response NEVER includes per-project
//        identifying data; static-string grep against the JSON body.
// ────────────────────────────────────────────────────────────────────

test("AC9: /api/fleet/median-projection response NEVER includes per-project identifying strings", async () => {
  _resetMedianProjectionCacheForTests();
  const b = await boot((db) => {
    // Seed 5 distinctly-named projects so a leak would be obvious.
    const slugs = ["distinctive-slug-1", "distinctive-slug-2", "distinctive-slug-3",
      "distinctive-slug-4", "distinctive-slug-5"];
    const recent = NOW.toISOString();
    for (let i = 0; i < slugs.length; i++) {
      const pid = seedProject(db, slugs[i], `Display Name ${i}`);
      for (let k = 1; k <= 12; k++) {
        seedRun(db, { projectId: pid, outcome: "shipped", startedAt: recent });
        seedMergedPr(db, { projectId: pid, number: k, fetchedAt: recent });
      }
    }
  });
  try {
    const r = await fetch(b.base + "/api/fleet/median-projection");
    assert.equal(r.status, 200);
    const text = await r.text();
    // None of the seeded slug strings or display names appear anywhere
    // in the JSON body — defence-in-depth at the renderer boundary.
    for (let i = 1; i <= 5; i++) {
      assert.ok(
        !text.includes(`distinctive-slug-${i}`),
        `response leaked seed slug 'distinctive-slug-${i}'`,
      );
      assert.ok(
        !text.includes(`Display Name ${i - 1}`),
        `response leaked seed display name 'Display Name ${i - 1}'`,
      );
    }
    // The aggregated keys themselves must NOT include any per-project
    // identifier shapes (the AC's static grep list).
    assert.doesNotMatch(text, /"project_slug"/);
    assert.doesNotMatch(text, /"project_name"/);
    assert.doesNotMatch(text, /"slug":/);
    assert.doesNotMatch(text, /"name":/);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Engineering invariants: no shell-string composition; helper
//         is pure (no child_process); cache registers the globalThis
//         invalidation slot.
// ────────────────────────────────────────────────────────────────────

test("AC10: src/views.ts never composes a shell string for the median block (no child_process imports added)", () => {
  const src = readFileSync(join(__dirname, "..", "src", "views.ts"), "utf8");
  assert.doesNotMatch(src, /from\s+["']node:child_process["']/,
    "src/views.ts must not import from node:child_process");
});

test("AC10: src/server.ts registers globalThis.__fleet_median_projection_invalidate__ for the calculator block", () => {
  const src = readFileSync(join(__dirname, "..", "src", "server.ts"), "utf8");
  assert.match(src, /__fleet_median_projection_invalidate__/,
    "src/server.ts must register the median-projection invalidation slot on globalThis per LESSONS 2026-06-05");
});

test("AC10: src/ingest/index.ts late-binds the median-projection cache hook via globalThis", () => {
  const src = readFileSync(join(__dirname, "..", "src", "ingest", "index.ts"), "utf8");
  assert.match(src, /__fleet_median_projection_invalidate__/,
    "src/ingest/index.ts must late-bind the median-projection invalidator via the globalThis slot");
});

// ════════════════════════════════════════════════════════════════════
// Boot harness — empty-roots config + tmp fleet-control.config.json.
// (Lives at the bottom so the test list above stays scannable.)
// ════════════════════════════════════════════════════════════════════

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
  const dir = mkdtempSync(join(tmpdir(), "fleet-calc-boot-"));
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
