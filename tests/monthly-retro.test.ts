// Tests for ticket 0062 — Monthly fleet retro card.
//
// One test() per acceptance-criteria checkbox. Strategy mirrors the
// 0059 biggest-surprise suite:
//   - Drive the pure helper monthlyRetroCard(db, now) directly against
//     a tmpdir DB for the kind-dispatch / per-comparison / best-laggard
//     ACs plus the warming-up and first-full-month branches.
//   - Drive the pure isMonthlyRetroDay(now) gate with anchor dates for
//     the first-weekday gating AC.
//   - Boot startServer() once for the dismiss endpoint round-trip AC
//     plus the home-page testid assertion. Per LESSONS § "in-process
//     startServer() tests need an empty-roots config" the boot helper
//     plants a tmp fleet-control.config.json in cwd and restores on
//     cleanup.
//   - The cache-invalidation AC exercises the build counter via two
//     same-tuple calls (counter goes up by 1 then 0) and then a fresh
//     PR row (counter goes up again) per LESSONS § "expose a build
//     counter for cache-hit tests".
//   - Renderer-direct seam (_renderMonthlyRetroCardForTests) drives the
//     card / warming-up / first-full-month / dismissed branches per
//     LESSONS 2026-06-11 "renderer-direct seam for branch tests".
//
// PRODUCER-VS-SPEC: per LESSONS 2026-06-05 + 2026-06-10 "groomer prose
// can disagree with the schema; the schema wins":
//   - pr.state = 'MERGED' (uppercase) per src/ingest/prs.ts:188 and
//     every existing src/views.ts caller.
//   - pr.heal_attempts is INTEGER DEFAULT 0 per src/db.ts:352.
//   - cost_rollup_day.day is TEXT 'YYYY-MM-DD' (lex-comparable).
// Per LESSONS 2026-05-29 "time-pinned tests must NOT derive seed
// timestamps from new Date()": every seed timestamp anchors to NOW.
// Per LESSONS 2026-06-13 "per-candidate detection fixtures must also
// satisfy the global empty-fleet gate": every per-comparison fixture
// seeds enough trailing data to clear BOTH the 8-week empty-fleet gate
// AND the per-comparison threshold.
// Per LESSONS 2026-06-07 the pr table has no surrogate id; the cache
// invalidation tuple uses (MAX(fetched_at), COUNT(*)) over pr.
// Per LESSONS 2026-06-12 "greedy [^>]+id= regex over a <h2 id=... data-
// testid=...>": tests scrape via the data-testid anchor.
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
  monthlyRetroCard, isMonthlyRetroDay,
  type MonthlyRetroResult, type MonthlyRetroPayload,
} from "../src/retro.ts";
import {
  startServer,
  _resetMonthlyRetroCacheForTests,
  _getMonthlyRetroCacheBuildsForTests,
  _renderMonthlyRetroCardForTests,
  getMonthlyRetroCardCached,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WEB_DIR = join(ROOT, "web");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const PKG_JSON = readFileSync(join(ROOT, "package.json"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Pinned anchors + seeders
// ────────────────────────────────────────────────────────────────────

// Wednesday 2026-07-01 12:00 UTC. The first weekday of July 2026 is
// Wednesday 2026-07-01 — so isMonthlyRetroDay(NOW) is TRUE and the
// comparison window is June (this_month, the COMPLETED prior month)
// vs May (last_month).
const NOW = new Date("2026-07-01T12:00:00.000Z");

function tempDb(): { db: DB; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-retro-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return {
    db, path,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function seedProject(db: DB, slug: string, name?: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
  ).run(slug, name ?? slug, "test", null);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

interface SeedPrOpts {
  projectId: number;
  number: number;
  fetchedAt: string;
  state?: string;
  healAttempts?: number;
  author?: string;
}

function seedPr(db: DB, opts: SeedPrOpts): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,"
    + "is_agent,additions,deletions,author,url,fetched_at,heal_attempts)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, `pr-${opts.number}`, `feat/${opts.number}`,
    opts.state ?? "MERGED", "green", null, 1, 0, 0,
    opts.author ?? "alice",
    `https://github.com/owner/x/pull/${opts.number}`,
    opts.fetchedAt,
    opts.healAttempts ?? 0,
  );
}

function seedRollup(
  db: DB, projectId: number, day: string, costUsd: number, phase = "ship",
): void {
  db.prepare(
    "INSERT INTO cost_rollup_day(project_id, phase, day, runs, input_tokens, "
    + "output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd) "
    + " VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(projectId, phase, day, 1, 0, 0, 0, 0, costUsd);
}

/** Seed N merged PRs spread across weeks STRICTLY BEFORE the
 *  given monthIso (e.g. before May 2026), one per ISO week walking
 *  backwards from monthIso-01. Used to clear the global 8-distinct-
 *  weeks empty-fleet gate WITHOUT polluting May or June counts.
 *  Per LESSONS 2026-06-13 every per-comparison fixture seeds enough
 *  trailing data to clear BOTH the 8-week gate AND its own
 *  threshold. */
function seedBaselineWeeksBefore(
  db: DB,
  projectId: number,
  beforeMonthIso: string,
  weeks: number,
  baseNumber: number,
): void {
  const d0 = new Date(beforeMonthIso + "-01T08:00:00.000Z");
  for (let w = 1; w <= weeks; w++) {
    const d = new Date(d0);
    d.setUTCDate(d.getUTCDate() - w * 7);
    seedPr(db, {
      projectId, number: baseNumber + w,
      fetchedAt: d.toISOString(),
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// AC1 — monthlyRetroCard kind dispatch: warming-up, first-full-month,
//        full card.
// ────────────────────────────────────────────────────────────────────

test("AC1: warming-up: < 8 distinct trailing weeks of merged-PR data returns kind='warming-up'", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetMonthlyRetroCacheForTests();
    const pid = seedProject(db, "fresh", "Fresh");
    // Only 4 weeks of merged-PR data — fails the global 8-week gate.
    for (let w = 1; w <= 4; w++) {
      const d = new Date(NOW.getTime() - w * 7 * 24 * 3600_000);
      seedPr(db, {
        projectId: pid, number: w,
        fetchedAt: d.toISOString().slice(0, 10) + "T08:00:00.000Z",
      });
    }
    const v = monthlyRetroCard(db, NOW);
    assert.equal(v.kind, "warming-up",
      `expected warming-up; got ${v.kind}`);
  } finally { cleanup(); }
});

test("AC1: first-full-month: trailing data clears the 8-week gate but ONLY thisMonth crosses the full-month threshold (no PRIOR full month to compare)", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetMonthlyRetroCacheForTests();
    const pid = seedProject(db, "courtiq", "Courtiq");
    // Helper is called with now = 2026-06-01 → thisMonth = May.
    // We seed:
    //   - May 2026: 6 merged PRs (a "full" month, >= 3 threshold).
    //   - Late March / April fringe: ≤2 PRs/month each (NOT a full
    //     month) but spread across distinct ISO weeks so the global
    //     8-distinct-trailing-weeks gate clears. The fringe rows
    //     also keep April from being a comparison anchor under the
    //     >= 3 threshold so first-full-month fires.
    // Per LESSONS 2026-06-13 the per-candidate fixture seeds enough
    // trailing data to clear BOTH the 8-week gate AND its own
    // threshold (here: thisMonth crosses the full-month bar; no
    // earlier month does).
    // May: 6 merges, one per Monday across the 5 ISO weeks May 4..31
    // plus one straggler.
    const mayDays = ["2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25", "2026-05-08", "2026-05-15"];
    for (let i = 0; i < mayDays.length; i++) {
      seedPr(db, {
        projectId: pid, number: 600 + i,
        fetchedAt: mayDays[i] + "T08:00:00.000Z",
      });
    }
    // April: 2 fringe merges (below the 3-threshold), each on a
    // different ISO week.
    seedPr(db, { projectId: pid, number: 401, fetchedAt: "2026-04-06T08:00:00.000Z" });
    seedPr(db, { projectId: pid, number: 402, fetchedAt: "2026-04-20T08:00:00.000Z" });
    // March/Feb: 2 fringe merges each on different weeks to clear
    // the 8-distinct-week gate. (Distinct weeks so far: 6 May + 2
    // April + extra below = 10+ distinct ISO weeks.)
    const fringeDays = ["2026-03-02", "2026-03-23", "2026-02-09", "2026-02-23"];
    for (let i = 0; i < fringeDays.length; i++) {
      seedPr(db, {
        projectId: pid, number: 300 + i,
        fetchedAt: fringeDays[i] + "T08:00:00.000Z",
      });
    }
    const v = monthlyRetroCard(db, new Date("2026-06-01T09:00:00.000Z"));
    assert.equal(v.kind, "first-full-month",
      `expected first-full-month when thisMonth is the first month to clear the 3-merge full-month bar; got ${v.kind}`);
  } finally { cleanup(); }
});

test("AC1: full card: 8+ trailing weeks plus two prior full months returns kind='card' with the documented payload shape", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetMonthlyRetroCacheForTests();
    const pid = seedProject(db, "courtiq", "Courtiq");
    // May 2026: 9 merged PRs; one per day at $1 cost = $9 total.
    for (let i = 0; i < 9; i++) {
      const day = `2026-05-${String(i + 1).padStart(2, "0")}`;
      seedPr(db, {
        projectId: pid, number: 500 + i,
        fetchedAt: day + "T08:00:00.000Z",
      });
      seedRollup(db, pid, day, 1.0);
    }
    // June 2026: 12 merged PRs at $1 cost = $12 total.
    for (let i = 0; i < 12; i++) {
      const day = `2026-06-${String(i + 1).padStart(2, "0")}`;
      seedPr(db, {
        projectId: pid, number: 600 + i,
        fetchedAt: day + "T08:00:00.000Z",
      });
      seedRollup(db, pid, day, 1.0);
    }
    // Per LESSONS 2026-06-13 — clear the global 8-week DISTINCT-
    // weeks gate by seeding 6 fringe baseline weeks BEFORE May. The
    // gate needs ≥8 distinct ISO weeks of merged PR data anywhere;
    // May 1-9 + June 1-12 span ~6 distinct weeks alone. Seeding 6
    // more in Jan-April brings the total comfortably above 8 without
    // polluting May or June counts.
    seedBaselineWeeksBefore(db, pid, "2026-05", 6, 100);
    const v = monthlyRetroCard(db, NOW);
    assert.equal(v.kind, "card", `expected kind=card; got ${v.kind}`);
    assert.ok(v.payload, "kind=card must carry a payload");
    const p = v.payload!;
    assert.equal(p.month_iso, "2026-06",
      "month_iso names the COMPLETED prior month (June)");
    assert.equal(p.prs_this_month, 12);
    assert.equal(p.prs_last_month, 9);
    assert.equal(typeof p.prs_delta_pct, "number");
    assert.equal(typeof p.spend_this_month, "number");
    assert.equal(typeof p.spend_last_month, "number");
    assert.equal(typeof p.spend_delta_pct, "number");
    assert.equal(typeof p.cost_per_pr_this, "number");
    assert.equal(typeof p.cost_per_pr_last, "number");
    assert.equal(typeof p.cost_per_pr_delta_pct, "number");
    assert.equal(typeof p.heal_avg_this, "number");
    assert.equal(typeof p.heal_avg_last, "number");
    assert.equal(typeof p.best_project_sentence, "string");
    assert.equal(typeof p.laggard_project_sentence, "string");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — First-weekday gating: isMonthlyRetroDay(now) returns true ONLY
//        on the first Monday-Friday of the calendar month. Saturday /
//        Sunday slide to the following Monday.
// ────────────────────────────────────────────────────────────────────

test("AC2: 2026-06-01 (Monday) — first weekday of June, gate fires true", () => {
  // UTC weekday of 2026-06-01: Monday.
  assert.equal(
    isMonthlyRetroDay(new Date("2026-06-01T12:00:00.000Z")),
    true,
    "2026-06-01 is Monday — gate must fire",
  );
});

test("AC2: 2026-07-01 (Wednesday) — first weekday of July, gate fires true", () => {
  assert.equal(
    isMonthlyRetroDay(new Date("2026-07-01T12:00:00.000Z")),
    true,
    "2026-07-01 is Wednesday — gate must fire",
  );
});

test("AC2: 2026-08-01 (Saturday) — gate does NOT fire; the card slides to the next Monday", () => {
  assert.equal(
    isMonthlyRetroDay(new Date("2026-08-01T12:00:00.000Z")),
    false,
    "2026-08-01 is Saturday — gate must NOT fire",
  );
});

test("AC2: 2026-08-03 (Monday) — first weekday of August (Sat 08-01 + Sun 08-02 slide forward), gate fires true", () => {
  assert.equal(
    isMonthlyRetroDay(new Date("2026-08-03T12:00:00.000Z")),
    true,
    "2026-08-03 is the first weekday of August after the weekend; gate fires",
  );
});

test("AC2: 2026-08-04 (Tuesday) — past the first-weekday window, gate does NOT fire", () => {
  assert.equal(
    isMonthlyRetroDay(new Date("2026-08-04T12:00:00.000Z")),
    false,
    "2026-08-04 is the SECOND weekday of August — gate must NOT fire",
  );
});

// ────────────────────────────────────────────────────────────────────
// AC3 — PRs-shipped delta over the May vs June fixture.
// ────────────────────────────────────────────────────────────────────

test("AC3: PRs-shipped delta computes correctly across month boundaries", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetMonthlyRetroCacheForTests();
    const pid = seedProject(db, "courtiq", "Courtiq");
    // May 2026: 9 merged PRs.
    for (let i = 0; i < 9; i++) {
      const day = `2026-05-${String(i + 1).padStart(2, "0")}`;
      seedPr(db, {
        projectId: pid, number: 500 + i,
        fetchedAt: day + "T08:00:00.000Z",
      });
    }
    // June 2026: 12 merged PRs.
    for (let i = 0; i < 12; i++) {
      const day = `2026-06-${String(i + 1).padStart(2, "0")}`;
      seedPr(db, {
        projectId: pid, number: 600 + i,
        fetchedAt: day + "T08:00:00.000Z",
      });
    }
    // Per LESSONS 2026-06-13 — clear the global 8-week gate.
    seedBaselineWeeksBefore(db, pid, "2026-05", 6, 100);
    const v = monthlyRetroCard(db, NOW);
    assert.equal(v.kind, "card");
    const p = v.payload!;
    assert.equal(p.prs_this_month, 12,
      "this month = June; 12 merged PRs");
    assert.equal(p.prs_last_month, 9,
      "last month = May; 9 merged PRs");
    // (12-9)/9*100 = 33.33 → rounded to 33.
    assert.equal(p.prs_delta_pct, 33,
      "PRs delta % should round to +33");
    // The renderer's sentence carries the documented form.
    const r = _renderMonthlyRetroCardForTests({ kind: "card", payload: p });
    assert.match(r, /12 PRs this month, up 33% from 9/,
      "PRs sentence: '12 PRs this month, up 33% from 9'");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — Spend / $-per-PR / heal-attempt deltas across month boundaries
//        plus the zero-denominator edge case.
// ────────────────────────────────────────────────────────────────────

test("AC4: spend / $-per-PR / heal-attempt deltas compute across month boundaries", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetMonthlyRetroCacheForTests();
    const pid = seedProject(db, "courtiq", "Courtiq");
    // May 2026: 9 merged PRs at heal_attempts in {0,0,0,0,0,1,1,2,3}
    // (avg ~= 0.78). $43.04 total spend → cost/PR ~= $4.7822.
    const mayHeals = [0, 0, 0, 0, 0, 1, 1, 2, 3]; // avg 0.778
    for (let i = 0; i < 9; i++) {
      const day = `2026-05-${String(i + 1).padStart(2, "0")}`;
      seedPr(db, {
        projectId: pid, number: 500 + i,
        fetchedAt: day + "T08:00:00.000Z",
        healAttempts: mayHeals[i],
      });
      // 9 rollups summing to $43.04. Spread evenly: $4.782... each.
      seedRollup(db, pid, day, 43.04 / 9);
    }
    // June 2026: 12 merged PRs at heal_attempts in 12 entries averaging
    // 0.4 (sum 5 across 12 → 0.4166). $48.21 total spend → cost/PR
    // ~= $4.0175.
    const juneHeals = [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1]; // sum=5
    for (let i = 0; i < 12; i++) {
      const day = `2026-06-${String(i + 1).padStart(2, "0")}`;
      seedPr(db, {
        projectId: pid, number: 600 + i,
        fetchedAt: day + "T08:00:00.000Z",
        healAttempts: juneHeals[i],
      });
      seedRollup(db, pid, day, 48.21 / 12);
    }
    // Per LESSONS 2026-06-13 — clear the global 8-week gate.
    seedBaselineWeeksBefore(db, pid, "2026-05", 6, 100);
    const v = monthlyRetroCard(db, NOW);
    assert.equal(v.kind, "card");
    const p = v.payload!;
    // Spend.
    assert.ok(Math.abs(p.spend_this_month - 48.21) < 0.01,
      `spend_this_month ~ $48.21; got ${p.spend_this_month}`);
    assert.ok(Math.abs(p.spend_last_month - 43.04) < 0.01,
      `spend_last_month ~ $43.04; got ${p.spend_last_month}`);
    // (48.21-43.04)/43.04*100 ~= 12.01 → rounded to 12.
    assert.equal(p.spend_delta_pct, 12,
      `spend_delta_pct expected ~12; got ${p.spend_delta_pct}`);
    // $/PR.
    assert.ok(Math.abs(p.cost_per_pr_this - 48.21 / 12) < 0.01,
      `cost_per_pr_this ~ $4.02; got ${p.cost_per_pr_this}`);
    assert.ok(Math.abs(p.cost_per_pr_last - 43.04 / 9) < 0.01,
      `cost_per_pr_last ~ $4.78; got ${p.cost_per_pr_last}`);
    // ($4.02 - $4.78)/$4.78*100 ~= -15.94 → rounded to -16 (or -17 if
    // we use stricter values). Accept either rounding direction within
    // a 2-percentage-point band.
    assert.ok(p.cost_per_pr_delta_pct <= -15 && p.cost_per_pr_delta_pct >= -18,
      `cost_per_pr_delta_pct expected ~-17; got ${p.cost_per_pr_delta_pct}`);
    // Heal attempts.
    assert.ok(Math.abs(p.heal_avg_this - 5 / 12) < 0.01,
      `heal_avg_this ~ 0.42; got ${p.heal_avg_this}`);
    assert.ok(Math.abs(p.heal_avg_last - 7 / 9) < 0.01,
      `heal_avg_last ~ 0.78; got ${p.heal_avg_last}`);
  } finally { cleanup(); }
});

test("AC4: zero-denominator edge — last month had 0 PRs renders 'no comparison' framing instead of dividing by zero", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetMonthlyRetroCacheForTests();
    const pid = seedProject(db, "courtiq", "Courtiq");
    // Last month (May) has ZERO merged PRs but the fleet has 8+
    // trailing weeks of data earlier so the warming-up gate passes
    // AND the first-full-month gate passes (we need a baseline month
    // BEFORE May = April with data). Seed April with 5 merged PRs
    // and June (this month) with 8 merged PRs. May stays empty.
    for (let i = 0; i < 5; i++) {
      const day = `2026-04-${String(i + 1).padStart(2, "0")}`;
      seedPr(db, {
        projectId: pid, number: 400 + i,
        fetchedAt: day + "T08:00:00.000Z",
      });
    }
    for (let i = 0; i < 8; i++) {
      const day = `2026-06-${String(i + 1).padStart(2, "0")}`;
      seedPr(db, {
        projectId: pid, number: 600 + i,
        fetchedAt: day + "T08:00:00.000Z",
      });
    }
    // Add stragglers across distinct ISO weeks so the 8-week
    // distinct-weeks gate clears even with May empty. Also spread
    // the April rows so they don't all cluster into one ISO week.
    seedBaselineWeeksBefore(db, pid, "2026-04", 8, 200);
    const v = monthlyRetroCard(db, NOW);
    assert.equal(v.kind, "card");
    const p = v.payload!;
    assert.equal(p.prs_last_month, 0,
      "May had zero merged PRs");
    assert.equal(p.prs_this_month, 8,
      "June had 8 merged PRs");
    // delta_pct should be null / sentinel, not Infinity / NaN.
    assert.equal(p.prs_delta_pct, null,
      "zero-denominator → prs_delta_pct must be null");
    // The renderer carries the documented 'no comparison' sentence.
    const r = _renderMonthlyRetroCardForTests({ kind: "card", payload: p });
    assert.match(r, /no comparison/i,
      "renderer must surface a 'no comparison' framing when last month had 0 PRs");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — Best & laggard project sentences.
// ────────────────────────────────────────────────────────────────────

test("AC5: best & laggard project sentences pick courtiq (2x baseline) and almanac (zero)", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetMonthlyRetroCacheForTests();
    // The trailing-3-month baseline requires the prior 3 calendar
    // months (March, April, May) to have data for each candidate
    // project; otherwise the helper excludes the project from the
    // pool.
    const pidC = seedProject(db, "courtiq", "Courtiq");
    const pidA = seedProject(db, "almanac", "Almanac");
    const pidS = seedProject(db, "sportsiq", "Sportsiq");
    // Trailing 3-month baselines (Mar/Apr/May) per project:
    //   courtiq: 2 PRs/month each → baseline median = 2; June = 4 (2x).
    //   almanac: 3 PRs/month each → baseline median = 3; June = 0.
    //   sportsiq: 2 PRs/month each → baseline median = 2; June = 2 (flat).
    for (const proj of [
      { pid: pidC, mar: 2, apr: 2, may: 2, jun: 4, base: 100 },
      { pid: pidA, mar: 3, apr: 3, may: 3, jun: 0, base: 200 },
      { pid: pidS, mar: 2, apr: 2, may: 2, jun: 2, base: 300 },
    ]) {
      for (const [monthIdx, count] of [
        [3, proj.mar], [4, proj.apr], [5, proj.may], [6, proj.jun],
      ] as Array<[number, number]>) {
        for (let i = 0; i < count; i++) {
          const day = `2026-${String(monthIdx).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`;
          seedPr(db, {
            projectId: proj.pid, number: proj.base + monthIdx * 10 + i,
            fetchedAt: day + "T08:00:00.000Z",
          });
        }
      }
    }
    // Clear the global 8-week DISTINCT-weeks gate per LESSONS
    // 2026-06-13. The Mar-Jun PRs above all cluster on days 1-4 of
    // each month (one ISO week per month → ~4 distinct weeks). Seed
    // 6 baseline weeks before March on a fourth project so the
    // global gate clears without polluting the per-project best /
    // laggard ratios on courtiq / almanac / sportsiq.
    const pidB = seedProject(db, "baseline", "Baseline");
    seedBaselineWeeksBefore(db, pidB, "2026-03", 6, 900);
    const v = monthlyRetroCard(db, NOW);
    assert.equal(v.kind, "card");
    const p = v.payload!;
    assert.match(p.best_project_sentence, /courtiq/,
      "best sentence names courtiq (2x baseline)");
    assert.match(p.best_project_sentence, /2x|doubled|2\.0x/i,
      "best sentence carries the 2x framing");
    assert.match(p.laggard_project_sentence, /almanac/,
      "laggard sentence names almanac (0 PRs)");
    assert.match(p.laggard_project_sentence, /0|zero/i,
      "laggard sentence names the zero shipping");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Honest empty state: warming up (< 8 weeks of merged-PR data).
// ────────────────────────────────────────────────────────────────────

test("AC6: warming-up renderer surfaces an honest 'fleet warming up' sentence (no fabricated numbers)", () => {
  // Drive the renderer directly via the seam — the helper-side gate is
  // already exercised by AC1. This test asserts the RENDERED prose.
  const body = _renderMonthlyRetroCardForTests({ kind: "warming-up" });
  assert.match(body, /data-testid=["']monthly-retro-card["']/,
    "warming-up render still emits the documented testid");
  assert.match(body, /warming up|warm up|warming/i,
    "warming-up renderer must surface the honest empty-state copy");
  // No fabricated comparison numbers — there must be no $ figure and
  // no 'PRs this month' delta in the warming-up rendering.
  assert.equal(body.includes("up 33%"), false,
    "warming-up render MUST NOT include any fabricated delta numbers");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Honest empty state: first full month (only one complete prior
//        calendar month exists; no prior baseline).
// ────────────────────────────────────────────────────────────────────

test("AC7: first-full-month renderer surfaces 'first full month' framing", () => {
  const body = _renderMonthlyRetroCardForTests({ kind: "first-full-month" });
  assert.match(body, /data-testid=["']monthly-retro-card["']/,
    "first-full-month render still emits the documented testid");
  assert.match(body, /first full month/i,
    "first-full-month renderer must surface the documented copy");
  assert.match(body, /next month/i,
    "renderer hints that the comparison lands next month");
  // No fabricated zero-baseline numbers per CROSS_LESSONS courtiq
  // 2026-05-25 family.
  assert.equal(body.includes("up 0%"), false,
    "first-full-month render MUST NOT include fabricated zero-baseline numbers");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Dismissal: POST /api/control/dismiss-monthly-retro writes an
//        inbox_dismissal row keyed by (kind='monthly_retro',
//        payload_id=<month_iso>). Dismissing June's card does NOT
//        suppress July's.
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

async function boot(seed?: (db: DB) => void): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-retro-boot-"));
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
    adminToken: "test-admin-token-for-0062",
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

test("AC8: POST /api/control/dismiss-monthly-retro writes inbox_dismissal keyed by (kind='monthly_retro', payload_id=<month_iso>)", async () => {
  _resetMonthlyRetroCacheForTests();
  const b = await boot();
  try {
    const dr = await fetch(b.base + "/api/control/dismiss-monthly-retro", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ month_iso: "2026-06" }),
    });
    assert.equal(dr.status, 200,
      `dismiss must accept the documented body; got ${dr.status}`);
    const dj = await dr.json() as { ok: boolean };
    assert.equal(dj.ok, true);
    // Confirm the inbox_dismissal row landed.
    const tdb = openDb(b.dbPath);
    try {
      const row = tdb.prepare(
        "SELECT kind, project_slug, payload_id FROM inbox_dismissal "
        + " WHERE kind = ? AND payload_id = ?",
      ).get("monthly_retro", "2026-06") as {
        kind: string; project_slug: string; payload_id: string;
      } | undefined;
      assert.ok(row, "inbox_dismissal MUST carry the monthly_retro row");
      assert.equal(row!.kind, "monthly_retro");
      assert.equal(row!.payload_id, "2026-06");
      // Dismissing July is independent of June.
      const julyRow = tdb.prepare(
        "SELECT 1 AS ok FROM inbox_dismissal "
        + " WHERE kind = ? AND payload_id = ?",
      ).get("monthly_retro", "2026-07") as { ok: number } | undefined;
      assert.equal(julyRow, undefined,
        "dismissing June MUST NOT pre-emptively suppress July");
    } finally { tdb.close(); }
  } finally { await b.close(); b.cleanup(); }
});

test("AC8: dismissed-for-current-month suppresses the home card; next month re-fires", () => {
  // Drive the renderer-direct seam. The dismissed=true opt for the
  // current month renders an empty string (card hidden); next month's
  // render still emits the card because the dismissal key is keyed by
  // month_iso (per LESSONS 2026-05-28 aging-window-not-UNIQUE).
  const junePayload: MonthlyRetroPayload = {
    month_iso: "2026-06",
    prs_this_month: 12,
    prs_last_month: 9,
    prs_delta_pct: 33,
    spend_this_month: 48.21,
    spend_last_month: 43.04,
    spend_delta_pct: 12,
    cost_per_pr_this: 4.02,
    cost_per_pr_last: 4.78,
    cost_per_pr_delta_pct: -16,
    heal_avg_this: 0.42,
    heal_avg_last: 0.78,
    best_project_sentence: "courtiq shipped 2x its trailing baseline this month",
    laggard_project_sentence: "almanac shipped 0 this month after averaging 3",
  };
  const dismissedBody = _renderMonthlyRetroCardForTests(
    { kind: "card", payload: junePayload },
    { dismissed: true },
  );
  assert.equal(dismissedBody, "",
    "dismissed=true must emit an empty string (the card is hidden)");
  // Next month: a fresh payload keyed by 2026-07 renders the card
  // even when the (dismissed=true) opt is absent.
  const julyPayload: MonthlyRetroPayload = {
    ...junePayload,
    month_iso: "2026-07",
  };
  const liveBody = _renderMonthlyRetroCardForTests({ kind: "card", payload: julyPayload });
  assert.match(liveBody, /data-testid=["']monthly-retro-card["']/,
    "next month re-fires the card");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Cache invalidation: memoised behind (MAX(pr.fetched_at),
//        COUNT(pr), MAX(run.started_at), COUNT(run), month_iso).
//        Per LESSONS 2026-06-07 NOT MAX(id) on pr.
// ────────────────────────────────────────────────────────────────────

test("AC9: cache build counter goes up 1 then 0 across two same-tuple calls; a fresh PR row busts the cache", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetMonthlyRetroCacheForTests();
    const pid = seedProject(db, "courtiq", "Courtiq");
    // Seed enough trailing data so the helper returns kind=card.
    for (let i = 0; i < 9; i++) {
      const day = `2026-05-${String(i + 1).padStart(2, "0")}`;
      seedPr(db, {
        projectId: pid, number: 500 + i,
        fetchedAt: day + "T08:00:00.000Z",
      });
    }
    for (let i = 0; i < 12; i++) {
      const day = `2026-06-${String(i + 1).padStart(2, "0")}`;
      seedPr(db, {
        projectId: pid, number: 600 + i,
        fetchedAt: day + "T08:00:00.000Z",
      });
    }
    seedBaselineWeeksBefore(db, pid, "2026-05", 6, 100);
    // Per LESSONS § "expose a build counter for cache-hit tests":
    // two same-tuple calls compute the value ONCE; a fresh PR row
    // bumps the (MAX(fetched_at), COUNT(*)) tuple and forces a
    // re-build on the next call.
    const buildsAtStart = _getMonthlyRetroCacheBuildsForTests();
    const v1 = getMonthlyRetroCardCached(db, NOW);
    const buildsAfterFirst = _getMonthlyRetroCacheBuildsForTests();
    assert.equal(buildsAfterFirst - buildsAtStart, 1,
      "first call must increment the cache build counter (cache miss)");
    const v2 = getMonthlyRetroCardCached(db, NOW);
    const buildsAfterSecond = _getMonthlyRetroCacheBuildsForTests();
    assert.equal(buildsAfterSecond - buildsAfterFirst, 0,
      "second call with same tuple must NOT increment (cache hit)");
    assert.deepEqual(v1, v2,
      "cached value MUST equal the first computation");
    // Add a fresh PR row — the (MAX(fetched_at), COUNT(*)) tuple
    // shifts and the next call rebuilds. Per LESSONS 2026-06-07
    // the pr table has no surrogate id so the invalidation tuple
    // is (MAX(fetched_at), COUNT(*)), NEVER MAX(id).
    seedPr(db, {
      projectId: pid, number: 9999,
      fetchedAt: "2026-06-15T08:00:00.000Z",
    });
    void getMonthlyRetroCardCached(db, NOW);
    const buildsAfterFresh = _getMonthlyRetroCacheBuildsForTests();
    assert.equal(buildsAfterFresh - buildsAfterSecond, 1,
      "a fresh PR row must bust the cache and force a re-build");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Renderer-direct seam + portal integration: every branch
//        (card / warming-up / first-full-month / dismissed) drives
//        through _renderMonthlyRetroCardForTests; the home-page
//        smoke test asserts the testid is anchored on data-testid
//        (NOT a greedy id=) per LESSONS 2026-06-12.
// ────────────────────────────────────────────────────────────────────

test("AC10: web/app.js renders the monthly retro card with the documented data-testid anchor and dismiss button", () => {
  // The SPA's home page mounts the card with data-testid attributes
  // that the portal smoke tests can scrape via the testid anchor
  // (NOT via a greedy [^>]+id= regex per LESSONS 2026-06-12).
  assert.match(APP_JS, /data-testid=["']monthly-retro-card["']/,
    "web/app.js MUST render an element with data-testid='monthly-retro-card'");
  assert.match(APP_JS, /data-testid=["']monthly-retro-dismiss["']/,
    "web/app.js MUST render an element with data-testid='monthly-retro-dismiss'");
});

test("AC10: renderer-direct seam emits the card body with month-over-month deltas in the documented prose", () => {
  const payload: MonthlyRetroPayload = {
    month_iso: "2026-06",
    prs_this_month: 12,
    prs_last_month: 9,
    prs_delta_pct: 33,
    spend_this_month: 48.21,
    spend_last_month: 43.04,
    spend_delta_pct: 12,
    cost_per_pr_this: 4.02,
    cost_per_pr_last: 4.78,
    cost_per_pr_delta_pct: -16,
    heal_avg_this: 0.4,
    heal_avg_last: 0.9,
    best_project_sentence: "courtiq shipped 2x its trailing baseline this month",
    laggard_project_sentence: "almanac shipped 0 this month after averaging 3",
  };
  const body = _renderMonthlyRetroCardForTests({ kind: "card", payload });
  assert.match(body, /data-testid=["']monthly-retro-card["']/,
    "card render must carry the documented testid");
  assert.match(body, /data-testid=["']monthly-retro-dismiss["']/,
    "card render must carry the documented dismiss testid");
  assert.match(body, /12 PRs this month, up 33% from 9/,
    "PRs delta sentence in the documented form");
  assert.match(body, /\$48/,
    "spend figure rendered as a $ amount");
  assert.match(body, /\$4\.02/,
    "$/PR figure rendered with 2-decimal precision");
  assert.match(body, /courtiq/,
    "best-project sentence is rendered");
  assert.match(body, /almanac/,
    "laggard-project sentence is rendered");
  assert.match(body, /June 2026|2026-06/,
    "card surfaces the human-readable month label");
});

// ────────────────────────────────────────────────────────────────────
// AC11 — No new runtime deps; tsc clean; no shell-string composition;
//        the endpoint is net-new; no schema migration; CSS group exists.
// ────────────────────────────────────────────────────────────────────

test("AC11: package.json carries no new runtime dependencies", () => {
  const pkg = JSON.parse(PKG_JSON) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    "ticket 0062 MUST add ZERO runtime dependencies; package.json `dependencies` must stay empty");
});

test("AC11: web/style.css carries a .monthly-retro-card selector group reusing existing CSS variables", () => {
  assert.match(CSS, /\.monthly-retro-card\b/,
    "web/style.css must declare a .monthly-retro-card selector");
});

test("AC11: src/retro.ts is the only place that imports node:child_process exec / execSync (it MUST NOT — pure SQL helper)", () => {
  const RETRO_TS = readFileSync(join(ROOT, "src", "retro.ts"), "utf8");
  assert.equal(
    /from\s+["']node:child_process["']/.test(RETRO_TS),
    false,
    "src/retro.ts is a pure helper — no node:child_process import",
  );
});
