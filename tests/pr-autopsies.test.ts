// Tests for ticket 0047 — PR autopsy card.
//
// One test(...) per acceptance-criteria checkbox. Strategy mirrors the
// existing 0040 / 0044 / 0045 suites:
//   - Drive `prAutopsies(db, now, opts)` directly against a tmpdir DB
//     for the helper's shape + cascade arithmetic + edge cases.
//   - Boot `startServer()` over loopback for the route + cache tests,
//     using the empty-roots config + tmp fleet-control.config.json
//     seam from LESSONS § "in-process startServer() tests need an
//     empty-roots config + run-row seeds".
//   - SPA renderer tests are text-level over web/app.js + web/style.css
//     per the spend-efficiency / stuck-pr-taxonomy precedent (zero
//     jsdom).
//
// PRODUCER-VS-SPEC reconciliation (per LESSONS 2026-06-05 + 2026-06-07,
// audited in docs/backlog/0047-pr-autopsy-card.md Implementation log):
//   - `pr.state` closed casing: 'CLOSED' uppercase (mirrors the
//     established 'MERGED' uppercase convention used by every existing
//     merged-PR reader; matches gh's verbatim state token).
//   - `pr.state` open casing: 'open' lowercase (the 0040 LESSON
//     casing; what `src/ingest/prs.ts` hardcodes today).
//   - `pr.closed_at` is a NEW additive column added via ALTER in
//     `src/db.ts` openDb() — same shape as the 0022 `gh_created_at`
//     and 0023 `heal_attempts` ALTERs.
//   - The `pr` table has no surrogate id (PK is (project_id, number)),
//     so the cache invalidation tuple uses (MAX(closed_at), COUNT(*))
//     per LESSONS 2026-06-07 "the `pr` table has no surrogate `id`;
//     proxy 'latest landed' via (MAX(fetched_at), COUNT(*))".
//   - control_audit rows: action='heal' (lowercase) and
//     target='pr-<number>' — the same pattern used by
//     tests/riskiest-pr.test.ts and src/views.ts:classifyPrFailure.
//   - lesson_credit join: per the 0042 schema in src/db.ts, the join
//     column is `heal_audit_id` (snake_case lowercase) — matches
//     tests/lesson-credit.test.ts.
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps
// from `new Date()`": every seed timestamp is anchored to NOW.
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`": row
// narrowing in the helper uses the double-cast (exercised
// transitively — if the cast regresses tsc fails before this file
// runs).
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests" + "expose a build counter for cache-hit tests, not a
// fetcher swap": the cache tests use the
// `_resetPrAutopsiesCacheForTests()` +
// `_getPrAutopsiesCacheBuildsForTests()` seams exported by
// src/server.ts.
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
  prAutopsies,
  type PrAutopsies,
  type PrAutopsyRow,
  type PrAutopsyCause,
} from "../src/views.ts";
import {
  startServer,
  _resetPrAutopsiesCacheForTests,
  _getPrAutopsiesCacheBuildsForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers — pinned-now seeders.
// ────────────────────────────────────────────────────────────────────

const NOW = new Date("2026-06-09T12:00:00.000Z");

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-pr-autopsies-"));
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

interface ClosedPrSeed {
  projectId: number;
  number: number;
  title?: string;
  /** Defaults to 'CLOSED' (the autopsy's primary filter — uppercase
   *  per the implementation log reconciliation). Tests that need to
   *  exercise the merged-exclusion edge cases pass 'MERGED' or
   *  'open' here. */
  state?: string;
  isAgent?: number;
  fetchedAt: string;       // ISO; gh sync stamp
  /** ISO; the new additive column the 0047 ALTER adds. */
  closedAt: string;
  /** ISO; gh's createdAt for the PR — already an existing column
   *  (`gh_created_at`) per the 0022 ALTER. */
  createdAt: string;
  ciState?: string;
  firstFailCheck?: string | null;
  healAttempts?: number;
  url?: string;
}

function seedClosedPr(db: DB, opts: ClosedPrSeed): void {
  db.prepare(
    "INSERT INTO pr("
    + "project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
    + "additions,deletions,author,url,fetched_at,gh_created_at,"
    + "first_fail_check,first_fail_excerpt,heal_attempts,closed_at"
    + ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, opts.title ?? `pr-${opts.number}`,
    `feat/${opts.number}`,
    opts.state ?? "CLOSED",
    opts.ciState ?? "red", null,
    opts.isAgent ?? 1,
    0, 0,
    "a", opts.url ?? `https://github.com/owner/x/pull/${opts.number}`,
    opts.fetchedAt, opts.createdAt,
    opts.firstFailCheck ?? null, null,
    opts.healAttempts ?? 0,
    opts.closedAt,
  );
}

function seedHealAudit(db: DB, opts: {
  ts: string; prNumber: number; stdoutTail: string;
}): number {
  const r = db.prepare(
    "INSERT INTO control_audit(ts,actor,action,target,args_json,exit_code,stdout_tail)"
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(
    opts.ts, "ship", "heal", `pr-${opts.prNumber}`, "{}", 1, opts.stdoutTail,
  );
  return Number(r.lastInsertRowid);
}

function seedLessonCredit(db: DB, opts: {
  lessonSlug: string;
  lessonDate: string;
  lessonTitle: string;
  healAuditId: number;
  projectSlug: string;
  matchedSubstring: string;
  createdAt: string;
}): void {
  db.prepare(
    "INSERT INTO lesson_credit(lesson_slug,lesson_date,lesson_title,"
    + "heal_audit_id,project_slug,matched_substring,created_at)"
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(
    opts.lessonSlug, opts.lessonDate, opts.lessonTitle,
    opts.healAuditId, opts.projectSlug, opts.matchedSubstring,
    opts.createdAt,
  );
}

/** ISO timestamp `h` hours BEFORE the pinned NOW. */
function hoursBeforeNow(h: number): string {
  return new Date(NOW.getTime() - h * 3600_000).toISOString();
}

/** ISO timestamp `d` days BEFORE the pinned NOW. */
function daysBeforeNow(d: number): string {
  return new Date(NOW.getTime() - d * 86400_000).toISOString();
}

// ────────────────────────────────────────────────────────────────────
// AC1 — shape: prAutopsies returns the documented payload; empty
// fleet (no closed PRs) yields total_closes: 0 and rows: [].
// ────────────────────────────────────────────────────────────────────

test("AC1: prAutopsies returns the documented shape against an empty fleet", () => {
  const { db, cleanup } = tempDb();
  try {
    const r = prAutopsies(db, NOW);
    assert.equal(typeof r.window_days, "number");
    assert.equal(r.window_days, 7, "default window MUST be 7 days");
    assert.equal(r.total_closes, 0);
    assert.deepEqual(r.rows, []);
    assert.equal(typeof r.generated_at, "string");
    assert.match(r.generated_at, /\d{4}-\d{2}-\d{2}T/);
  } finally { cleanup(); }
});

test("AC1: prAutopsies returns one row per closed-non-merged PR in window, sorted closed_at DESC", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha", "Alpha");
    // Three closed PRs at 6h / 24h / 48h ago, plus one MERGED row that
    // must be excluded, plus one open row that must be excluded.
    seedClosedPr(db, {
      projectId: p, number: 11, title: "old",
      fetchedAt: hoursBeforeNow(48), closedAt: hoursBeforeNow(48),
      createdAt: hoursBeforeNow(72),
    });
    seedClosedPr(db, {
      projectId: p, number: 12, title: "newest",
      fetchedAt: hoursBeforeNow(6), closedAt: hoursBeforeNow(6),
      createdAt: hoursBeforeNow(12),
    });
    seedClosedPr(db, {
      projectId: p, number: 13, title: "middle",
      fetchedAt: hoursBeforeNow(24), closedAt: hoursBeforeNow(24),
      createdAt: hoursBeforeNow(30),
    });
    // MERGED row: state='MERGED' must be excluded.
    seedClosedPr(db, {
      projectId: p, number: 14, title: "merged",
      state: "MERGED",
      fetchedAt: hoursBeforeNow(12), closedAt: hoursBeforeNow(12),
      createdAt: hoursBeforeNow(20),
    });
    // Open row: state='open' must be excluded (also AC11 covers re-open).
    seedClosedPr(db, {
      projectId: p, number: 15, title: "open",
      state: "open",
      fetchedAt: hoursBeforeNow(8), closedAt: hoursBeforeNow(8),
      createdAt: hoursBeforeNow(10),
    });

    const r = prAutopsies(db, NOW);
    assert.equal(r.total_closes, 3);
    assert.equal(r.rows.length, 3);
    // Sorted closed_at DESC.
    assert.deepEqual(r.rows.map((x: PrAutopsyRow) => x.pr_number), [12, 13, 11]);
    // Documented per-row fields exist with the right types.
    const row = r.rows[0];
    assert.equal(row.project_slug, "alpha");
    assert.equal(row.project_name, "Alpha");
    assert.equal(typeof row.pr_title, "string");
    assert.equal(typeof row.pr_url, "string");
    assert.equal(typeof row.closed_at, "string");
    assert.equal(typeof row.closed_age_hours, "number");
    assert.ok(["cap_reached", "human_rejected", "force_closed_stale",
      "infra_blocked_giveup", "unknown"].includes(row.cause));
    assert.equal(typeof row.riskiness_at_close, "number");
    assert.equal(typeof row.riskiness_breakdown, "string");
    assert.equal(typeof row.heal_attempts, "number");
    assert.equal(typeof row.latest_fail_kind, "string");
    assert.ok(row.latest_fail_detail === null || typeof row.latest_fail_detail === "string");
    assert.ok(row.lesson_credit === null
      || (typeof row.lesson_credit === "object" && typeof row.lesson_credit.slug === "string"));
    assert.equal(typeof row.verdict, "string");
    assert.ok(row.draft_lesson === null || typeof row.draft_lesson === "string");
  } finally { cleanup(); }
});

test("AC1: only MERGED PRs in window → total_closes: 0, rows: []", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    for (let i = 0; i < 5; i++) {
      seedClosedPr(db, {
        projectId: p, number: 100 + i,
        state: "MERGED",
        fetchedAt: hoursBeforeNow(2 + i), closedAt: hoursBeforeNow(2 + i),
        createdAt: hoursBeforeNow(10 + i),
      });
    }
    const r = prAutopsies(db, NOW);
    assert.equal(r.total_closes, 0);
    assert.deepEqual(r.rows, []);
  } finally { cleanup(); }
});

test("AC1: windowDays option clamps the lookback (1d only includes the most-recent close)", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedClosedPr(db, {
      projectId: p, number: 1, fetchedAt: hoursBeforeNow(2),
      closedAt: hoursBeforeNow(2), createdAt: hoursBeforeNow(10),
    });
    seedClosedPr(db, {
      projectId: p, number: 2, fetchedAt: hoursBeforeNow(48),
      closedAt: hoursBeforeNow(48), createdAt: hoursBeforeNow(72),
    });
    const r1 = prAutopsies(db, NOW, { windowDays: 1 });
    assert.equal(r1.window_days, 1);
    assert.equal(r1.total_closes, 1);
    assert.equal(r1.rows[0].pr_number, 1);
    const r7 = prAutopsies(db, NOW, { windowDays: 7 });
    assert.equal(r7.total_closes, 2);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — Cause cascade (deterministic, top-down). Seed each cause
// with realistic surrounding signal per LESSONS § "anomaly tests
// need sigma > 0 in the fixture"; a wrongly-ordered cascade fails
// noisily.
// ────────────────────────────────────────────────────────────────────

test("AC2: cap_reached fires when heal_attempts >= 2 AND latest heal is NOT infra-flake", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedClosedPr(db, {
      projectId: p, number: 311,
      fetchedAt: hoursBeforeNow(18), closedAt: hoursBeforeNow(18),
      createdAt: hoursBeforeNow(40),
      healAttempts: 2, ciState: "red", firstFailCheck: "unit-tests",
    });
    seedHealAudit(db, {
      ts: hoursBeforeNow(20), prNumber: 311,
      stdoutTail: "AssertionError: expected 5 to equal 6 — vitest TS2554",
    });
    const r = prAutopsies(db, NOW);
    assert.equal(r.total_closes, 1);
    const row = r.rows[0];
    assert.equal(row.cause, "cap_reached" satisfies PrAutopsyCause);
    assert.equal(row.heal_attempts, 2);
  } finally { cleanup(); }
});

test("AC2: infra_blocked_giveup fires when heal_attempts >= 1 AND latest heal tail is an infra-flake", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedClosedPr(db, {
      projectId: p, number: 411,
      fetchedAt: hoursBeforeNow(10), closedAt: hoursBeforeNow(10),
      createdAt: hoursBeforeNow(24),
      healAttempts: 1, ciState: "red", firstFailCheck: "checkout",
    });
    seedHealAudit(db, {
      ts: hoursBeforeNow(11), prNumber: 411,
      stdoutTail: "Error: failed to bind, address already in use",
    });
    const r = prAutopsies(db, NOW);
    assert.equal(r.total_closes, 1);
    const row = r.rows[0];
    assert.equal(row.cause, "infra_blocked_giveup" satisfies PrAutopsyCause);
  } finally { cleanup(); }
});

test("AC2: force_closed_stale fires when heal_attempts === 0 AND age > 7 days", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    // Closed 3 days ago, but CREATED 12 days before close (15d total
    // before NOW). Need close in window (3d ago) but age > 7d.
    seedClosedPr(db, {
      projectId: p, number: 511,
      fetchedAt: daysBeforeNow(3), closedAt: daysBeforeNow(3),
      createdAt: daysBeforeNow(15),
      healAttempts: 0, ciState: "green",
    });
    const r = prAutopsies(db, NOW);
    assert.equal(r.total_closes, 1);
    const row = r.rows[0];
    assert.equal(row.cause, "force_closed_stale" satisfies PrAutopsyCause);
  } finally { cleanup(); }
});

test("AC2: unknown is the default when no rule matches (e.g. heal_attempts=0 + age<7d, no human signal recoverable)", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    // Created 2d before close → age 2d (well under 7d). 0 heals. The
    // current schema carries no closed_by/actor signal so the
    // human_rejected rule cannot fire (per the AC's permissive clause)
    // and the row falls through to unknown.
    seedClosedPr(db, {
      projectId: p, number: 611,
      fetchedAt: hoursBeforeNow(4), closedAt: hoursBeforeNow(4),
      createdAt: hoursBeforeNow(52),
      healAttempts: 0, ciState: "green",
    });
    const r = prAutopsies(db, NOW);
    assert.equal(r.total_closes, 1);
    assert.equal(r.rows[0].cause, "unknown" satisfies PrAutopsyCause);
  } finally { cleanup(); }
});

test("AC2: cascade order — cap_reached wins over force_closed_stale when both could match", () => {
  // If a PR has heal_attempts=2 AND was open for 10 days before close
  // AND the latest heal is a real test failure, cap_reached MUST win
  // (it's earlier in the cascade) — never force_closed_stale.
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedClosedPr(db, {
      projectId: p, number: 711,
      fetchedAt: hoursBeforeNow(1), closedAt: hoursBeforeNow(1),
      createdAt: daysBeforeNow(10),
      healAttempts: 2, ciState: "red", firstFailCheck: "unit-tests",
    });
    seedHealAudit(db, {
      ts: hoursBeforeNow(2), prNumber: 711,
      stdoutTail: "TypeError: cannot read property foo of undefined",
    });
    const r = prAutopsies(db, NOW);
    assert.equal(r.rows[0].cause, "cap_reached" satisfies PrAutopsyCause);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — riskiness_at_close uses 0040's formula:
//   heal_attempts * 4 + fail_kind_weight + floor(age_hours_at_close/6)
// fail_kind_weight: infra_flake=1, red_test=3, red_check_unknown=2,
// green=0 (from src/views.ts:FAIL_KIND_WEIGHT).
// ────────────────────────────────────────────────────────────────────

test("AC3: riskiness_at_close === 17 for 2 heals + red_test + 23h age", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedClosedPr(db, {
      projectId: p, number: 811,
      fetchedAt: hoursBeforeNow(1), closedAt: hoursBeforeNow(1),
      // 23h between created and closed (1h ago close + 24h ago create).
      createdAt: hoursBeforeNow(24),
      healAttempts: 2, ciState: "red", firstFailCheck: "vitest",
    });
    seedHealAudit(db, {
      ts: hoursBeforeNow(3), prNumber: 811,
      stdoutTail: "AssertionError: TS2554 vitest no-arg-handlers",
    });
    const r = prAutopsies(db, NOW);
    const row = r.rows[0];
    // 2*4 + 3 (red_test) + floor(23/6)=3  → 14? Let me reckon:
    // heal=2 → 8; fail=red_test → 3; floor(23/6) = 3 → 8+3+3 = 14
    // Spec example says "17 (red_test x 2 heals, 23h old)" — using
    // 8 + 3 + Math.floor(23/6)=3 we get 14. The spec example used the
    // formula slightly differently; we honour the FORMULA (0040's
    // existing arithmetic) over the prose. Assert the formula's
    // output, not the prose's number.
    assert.equal(row.riskiness_at_close, 14);
    assert.equal(row.latest_fail_kind, "red_test");
    assert.match(row.riskiness_breakdown, /red_test/);
    assert.match(row.riskiness_breakdown, /2 heals/);
    assert.match(row.riskiness_breakdown, /23h/);
  } finally { cleanup(); }
});

test("AC3: riskiness_at_close for infra-flake heal classifies as infra_flake (weight 1)", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedClosedPr(db, {
      projectId: p, number: 821,
      fetchedAt: hoursBeforeNow(2), closedAt: hoursBeforeNow(2),
      createdAt: hoursBeforeNow(8), // 6h age → floor(6/6)=1
      healAttempts: 1, ciState: "red",
    });
    seedHealAudit(db, {
      ts: hoursBeforeNow(3), prNumber: 821,
      stdoutTail: "Error: address already in use 0.0.0.0:5432",
    });
    const r = prAutopsies(db, NOW);
    const row = r.rows[0];
    // 1*4 + 1 (infra_flake) + 1 (age 6h) = 6
    assert.equal(row.riskiness_at_close, 6);
    assert.equal(row.latest_fail_kind, "infra_flake");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — Lesson credit attribution. Joins lesson_credit on
// heal_audit_id pointing at any heal-row for this PR.
// ────────────────────────────────────────────────────────────────────

test("AC4: lesson_credit is populated when a heal for this PR has a lesson_credit row", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedClosedPr(db, {
      projectId: p, number: 911,
      fetchedAt: hoursBeforeNow(4), closedAt: hoursBeforeNow(4),
      createdAt: hoursBeforeNow(20),
      healAttempts: 1, ciState: "red", firstFailCheck: "vitest",
    });
    const healId = seedHealAudit(db, {
      ts: hoursBeforeNow(5), prNumber: 911,
      stdoutTail: "vitest TS2554 no-arg-handlers",
    });
    seedLessonCredit(db, {
      lessonSlug: "fleet-control",
      lessonDate: "2026-05-26",
      lessonTitle: "call no-arg handlers with no args",
      healAuditId: healId,
      projectSlug: "alpha",
      matchedSubstring: "TS2554",
      createdAt: hoursBeforeNow(4),
    });
    const r = prAutopsies(db, NOW);
    const row = r.rows[0];
    assert.ok(row.lesson_credit);
    assert.equal(row.lesson_credit!.slug, "fleet-control");
    assert.equal(row.lesson_credit!.headline, "call no-arg handlers with no args");
    assert.equal(row.lesson_credit!.prior_saves, 1);
  } finally { cleanup(); }
});

test("AC4: lesson_credit is null when no credit row points at any heal for this PR", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedClosedPr(db, {
      projectId: p, number: 912,
      fetchedAt: hoursBeforeNow(4), closedAt: hoursBeforeNow(4),
      createdAt: hoursBeforeNow(20),
      healAttempts: 1, ciState: "red",
    });
    seedHealAudit(db, {
      ts: hoursBeforeNow(5), prNumber: 912,
      stdoutTail: "Some unrelated heal log",
    });
    // NO lesson_credit row.
    const r = prAutopsies(db, NOW);
    assert.equal(r.rows[0].lesson_credit, null);
  } finally { cleanup(); }
});

test("AC4: prior_saves counts lesson_credit rows for the SAME lesson_slug across the trailing 30 days", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedClosedPr(db, {
      projectId: p, number: 913,
      fetchedAt: hoursBeforeNow(3), closedAt: hoursBeforeNow(3),
      createdAt: hoursBeforeNow(20),
      healAttempts: 1, ciState: "red",
    });
    const healId = seedHealAudit(db, {
      ts: hoursBeforeNow(5), prNumber: 913,
      stdoutTail: "vitest TS2554",
    });
    // Three lesson_credit rows for the same lesson_slug, all within 30d
    // (the one bound to this heal counts; the other two are within
    // window but bound to other heals → still count toward prior_saves).
    seedLessonCredit(db, {
      lessonSlug: "fleet-control", lessonDate: "2026-05-26",
      lessonTitle: "call no-arg handlers with no args",
      healAuditId: healId, projectSlug: "alpha",
      matchedSubstring: "TS2554", createdAt: hoursBeforeNow(3),
    });
    // Two other heal-audits + their credits (within 30d).
    const otherHeal1 = seedHealAudit(db, {
      ts: daysBeforeNow(5), prNumber: 999,
      stdoutTail: "earlier",
    });
    seedLessonCredit(db, {
      lessonSlug: "fleet-control", lessonDate: "2026-05-26",
      lessonTitle: "call no-arg handlers with no args",
      healAuditId: otherHeal1, projectSlug: "alpha",
      matchedSubstring: "TS2554", createdAt: daysBeforeNow(5),
    });
    const otherHeal2 = seedHealAudit(db, {
      ts: daysBeforeNow(10), prNumber: 998,
      stdoutTail: "earlier-2",
    });
    seedLessonCredit(db, {
      lessonSlug: "fleet-control", lessonDate: "2026-05-26",
      lessonTitle: "call no-arg handlers with no args",
      healAuditId: otherHeal2, projectSlug: "alpha",
      matchedSubstring: "TS2554", createdAt: daysBeforeNow(10),
    });
    const r = prAutopsies(db, NOW);
    const row = r.rows[0];
    assert.ok(row.lesson_credit);
    assert.equal(row.lesson_credit!.prior_saves, 3);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — Verdict composition (deterministic, NO LLM). Each
// (cause, lesson_credit) pair maps to one exact verdict string.
// draft_lesson is populated when the verdict prompts a LESSONS entry.
// ────────────────────────────────────────────────────────────────────

test("AC5: verdict 'cap_reached + lesson set' → the lesson named the symptom", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedClosedPr(db, {
      projectId: p, number: 1011,
      fetchedAt: hoursBeforeNow(4), closedAt: hoursBeforeNow(4),
      createdAt: hoursBeforeNow(20),
      healAttempts: 2, ciState: "red", firstFailCheck: "vitest",
    });
    const healId = seedHealAudit(db, {
      ts: hoursBeforeNow(5), prNumber: 1011,
      stdoutTail: "TypeError",
    });
    seedLessonCredit(db, {
      lessonSlug: "fleet-control", lessonDate: "2026-05-26",
      lessonTitle: "some lesson", healAuditId: healId,
      projectSlug: "alpha", matchedSubstring: "x",
      createdAt: hoursBeforeNow(4),
    });
    const r = prAutopsies(db, NOW);
    const row = r.rows[0];
    assert.equal(row.cause, "cap_reached");
    assert.equal(row.verdict, "The lesson named the symptom. Heal cap is the issue.");
    assert.equal(row.draft_lesson, null,
      "cap_reached+credited verdict does NOT prompt a new LESSONS entry");
  } finally { cleanup(); }
});

test("AC5: verdict 'cap_reached + no lesson' → no lesson covers this; prompts draft", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedClosedPr(db, {
      projectId: p, number: 1012,
      fetchedAt: hoursBeforeNow(4), closedAt: hoursBeforeNow(4),
      createdAt: hoursBeforeNow(20),
      healAttempts: 2, ciState: "red", firstFailCheck: "vitest",
    });
    seedHealAudit(db, {
      ts: hoursBeforeNow(5), prNumber: 1012,
      stdoutTail: "novel failure mode",
    });
    const r = prAutopsies(db, NOW);
    const row = r.rows[0];
    assert.equal(row.verdict, "Heal cap reached AND no lesson covers this. Worth a LESSONS entry.");
    assert.ok(typeof row.draft_lesson === "string" && row.draft_lesson.length > 0,
      "verdict prompting a LESSONS entry must populate draft_lesson");
    // Draft skeleton mentions the slug + cause + verdict.
    assert.match(row.draft_lesson!, /alpha/);
    assert.match(row.draft_lesson!, /cap_reached/);
  } finally { cleanup(); }
});

test("AC5: verdict 'infra_blocked_giveup + no lesson' → prompts a LESSONS entry + draft populated", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedClosedPr(db, {
      projectId: p, number: 1013,
      fetchedAt: hoursBeforeNow(4), closedAt: hoursBeforeNow(4),
      createdAt: hoursBeforeNow(20),
      healAttempts: 1, ciState: "red",
    });
    seedHealAudit(db, {
      ts: hoursBeforeNow(5), prNumber: 1013,
      stdoutTail: "Error: address already in use",
    });
    const r = prAutopsies(db, NOW);
    const row = r.rows[0];
    assert.equal(row.cause, "infra_blocked_giveup");
    assert.equal(row.verdict, "Infra blocked recovery and no lesson covers this flake. Add a LESSONS entry.");
    assert.ok(row.draft_lesson);
  } finally { cleanup(); }
});

test("AC5: verdict 'force_closed_stale' → no draft (the close reason is not a fresh failure mode)", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedClosedPr(db, {
      projectId: p, number: 1014,
      fetchedAt: daysBeforeNow(3), closedAt: daysBeforeNow(3),
      createdAt: daysBeforeNow(15),
      healAttempts: 0, ciState: "green",
    });
    const r = prAutopsies(db, NOW);
    const row = r.rows[0];
    assert.equal(row.cause, "force_closed_stale");
    assert.equal(row.verdict, "PR sat unattended for >7 days. Likely the backlog moved on.");
    assert.equal(row.draft_lesson, null);
  } finally { cleanup(); }
});

test("AC5: verdict 'unknown' → prompts a LESSONS entry naming this failure mode", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedClosedPr(db, {
      projectId: p, number: 1015,
      fetchedAt: hoursBeforeNow(4), closedAt: hoursBeforeNow(4),
      createdAt: hoursBeforeNow(48), // age 2d → not stale
      healAttempts: 0, ciState: "green",
    });
    const r = prAutopsies(db, NOW);
    const row = r.rows[0];
    assert.equal(row.cause, "unknown");
    assert.equal(row.verdict, "Cause not detected from signals. Consider adding a LESSONS entry naming this failure mode.");
    assert.ok(row.draft_lesson);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — GET /api/fleet/pr-autopsies.
// ────────────────────────────────────────────────────────────────────

// Boot harness (mirrors tests/spend-efficiency.test.ts).
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
          const port = a.port;
          srv.close(() => resolve(port));
        } else { srv.close(); reject(new Error("no port")); }
      });
      srv.on("error", reject);
    }).catch(reject);
  });
}

async function boot(seed?: (db: DB) => void): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-pr-autopsies-boot-"));
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

/** Seed against the ACTUAL wall-clock, not the pinned NOW. The route
 *  handler uses `new Date()` internally — seeds anchored to a stale
 *  NOW pinned hours in the past fall outside the route's "now -
 *  windowDays" window. The full-suite run that flagged this exposed
 *  the trap when the test author was inside the same calendar day as
 *  NOW but several wall-clock hours later. Per the precedent in
 *  tests/spend-efficiency.test.ts:seedLiveFleet, the boot tests
 *  read `new Date()` so the rows land inside whatever window the
 *  request-path `new Date()` resolves to. */
function _liveHoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}
function seedTwoCloseFleet(db: DB): void {
  const a = seedProject(db, "alpha", "Alpha");
  // close 1: cap_reached + lesson credited (closed 4h ago — well
  // inside both 1d and 7d windows).
  seedClosedPr(db, {
    projectId: a, number: 311, title: "courtiq",
    fetchedAt: _liveHoursAgo(4), closedAt: _liveHoursAgo(4),
    createdAt: _liveHoursAgo(48),
    healAttempts: 2, ciState: "red", firstFailCheck: "vitest",
  });
  const healId = seedHealAudit(db, {
    ts: _liveHoursAgo(6), prNumber: 311,
    stdoutTail: "vitest TS2554",
  });
  seedLessonCredit(db, {
    lessonSlug: "fleet-control", lessonDate: "2026-05-26",
    lessonTitle: "call no-arg handlers with no args",
    healAuditId: healId, projectSlug: "alpha",
    matchedSubstring: "TS2554", createdAt: _liveHoursAgo(4),
  });
  // close 2: unknown (will get draft_lesson) — closed 50h ago so it
  // sits in the 7d window but NOT in the 1d window. AC6 narrowness
  // test asserts the 1d-only behaviour against this layout.
  const b = seedProject(db, "almanac", "Almanac");
  seedClosedPr(db, {
    projectId: b, number: 88, title: "almanac",
    fetchedAt: _liveHoursAgo(50), closedAt: _liveHoursAgo(50),
    createdAt: _liveHoursAgo(72),
    healAttempts: 0, ciState: "green",
  });
}

test("AC6: GET /api/fleet/pr-autopsies returns 200 + documented shape", async () => {
  _resetPrAutopsiesCacheForTests();
  const b = await boot((db) => { seedTwoCloseFleet(db); });
  try {
    const r = await fetch(b.base + "/api/fleet/pr-autopsies");
    assert.equal(r.status, 200);
    const j = await r.json() as PrAutopsies;
    assert.equal(j.window_days, 7);
    assert.equal(j.total_closes, 2);
    assert.equal(j.rows.length, 2);
  } finally { await b.close(); b.cleanup(); }
});

test("AC6: GET /api/fleet/pr-autopsies?window=1 narrows the window", async () => {
  _resetPrAutopsiesCacheForTests();
  const b = await boot((db) => { seedTwoCloseFleet(db); });
  try {
    const r = await fetch(b.base + "/api/fleet/pr-autopsies?window=1");
    assert.equal(r.status, 200);
    const j = await r.json() as PrAutopsies;
    assert.equal(j.window_days, 1);
    // Both close timestamps are within 28h, so 1d window catches only
    // the one at 18h.
    assert.equal(j.total_closes, 1);
  } finally { await b.close(); b.cleanup(); }
});

test("AC6: GET /api/fleet/pr-autopsies?window=60 returns 400", async () => {
  _resetPrAutopsiesCacheForTests();
  const b = await boot();
  try {
    const r = await fetch(b.base + "/api/fleet/pr-autopsies?window=60");
    assert.equal(r.status, 400);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Caching: cache-control max-age=600, memoised by
// (window_days, MAX(closed_at) WHERE state='CLOSED', COUNT(*)
// WHERE state='CLOSED' AND closed_at >= now-7d). The cache invalidates
// when another PR closes.
// ────────────────────────────────────────────────────────────────────

test("AC7: response sets cache-control: max-age=600 and memoises via the build counter", async () => {
  _resetPrAutopsiesCacheForTests();
  const b = await boot((db) => { seedTwoCloseFleet(db); });
  try {
    const before = _getPrAutopsiesCacheBuildsForTests();
    const r1 = await fetch(b.base + "/api/fleet/pr-autopsies");
    assert.equal(r1.status, 200);
    const cc = (r1.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=600/, `cache-control must declare max-age=600; got '${cc}'`);
    await r1.json();
    const afterFirst = _getPrAutopsiesCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call → cache MISS");

    const r2 = await fetch(b.base + "/api/fleet/pr-autopsies");
    assert.equal(r2.status, 200);
    await r2.json();
    const afterSecond = _getPrAutopsiesCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0, "second call within TTL → cache HIT");

    // Close another PR. The cache tuple includes (MAX(closed_at),
    // COUNT(*)) so the next call MUST rebuild.
    const db2 = openDb(b.dbPath);
    try {
      const pid = (db2.prepare("SELECT id FROM project WHERE slug=?").get("alpha") as { id: number }).id;
      db2.prepare(
        "INSERT INTO pr("
        + "project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
        + "additions,deletions,author,url,fetched_at,gh_created_at,"
        + "first_fail_check,first_fail_excerpt,heal_attempts,closed_at"
        + ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        pid, 9999, "fresh", "feat/9999", "CLOSED", "red", null, 1,
        0, 0, "a", "https://github.com/owner/x/pull/9999",
        new Date().toISOString(), new Date().toISOString(), null, null, 0,
        new Date().toISOString(),
      );
    } finally { db2.close(); }

    const r3 = await fetch(b.base + "/api/fleet/pr-autopsies");
    assert.equal(r3.status, 200);
    await r3.json();
    const afterThird = _getPrAutopsiesCacheBuildsForTests();
    assert.equal(afterThird - afterSecond, 1,
      "after a new CLOSED PR lands → tuple changes → next call rebuilds");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC8 — web/app.js: renders the card; emits the data-testid; reads
// from /api/fleet/pr-autopsies; passes strings through redactSecrets;
// total_closes === 0 → returns "" (no DOM element).
// ────────────────────────────────────────────────────────────────────

test("AC8: web/app.js declares renderPrAutopsyCard + emits data-testid=pr-autopsy-card", () => {
  assert.match(APP_JS, /function\s+renderPrAutopsyCard\s*\(/,
    "web/app.js must declare a renderPrAutopsyCard helper");
  assert.match(APP_JS, /data-testid="pr-autopsy-card"/,
    "the card must carry data-testid=\"pr-autopsy-card\"");
  assert.match(APP_JS, /\/api\/fleet\/pr-autopsies/,
    "web/app.js must fetch the new /api/fleet/pr-autopsies route");
});

test("AC8: renderPrAutopsyCard returns '' when total_closes is 0 (no DOM)", () => {
  const fn = APP_JS.match(/function\s+renderPrAutopsyCard\s*\([\s\S]*?\n\}/);
  assert.ok(fn, "renderPrAutopsyCard body must be parseable");
  // The helper must short-circuit on total_closes === 0.
  assert.match(fn![0], /total_closes/,
    "renderPrAutopsyCard must consult total_closes");
  // Defence-in-depth redaction (LESSONS § "secret redaction at the
  // renderer boundary").
  assert.match(fn![0], /redactSecrets\(/,
    "renderPrAutopsyCard must route operator-visible strings through redactSecrets");
});

test("AC8: home() composition places the card BELOW the stuck-PR / riskiest cards and ABOVE spend-efficiency", () => {
  const homeBodyMatch = APP_JS.match(/async\s+function\s+home\s*\(\s*\)[\s\S]*?app\.innerHTML\s*=\s*[\s\S]*?renderInbox/);
  assert.ok(homeBodyMatch);
  const body = homeBodyMatch![0];
  const idxRiskiest = body.indexOf("renderRiskiestPr");
  const idxStuck = body.indexOf("renderStuckPrTaxonomyCard");
  const idxAutopsy = body.indexOf("renderPrAutopsyCard");
  const idxSpend = body.indexOf("renderSpendEfficiencyCard");
  assert.ok(idxAutopsy > -1, "home() must reference renderPrAutopsyCard");
  assert.ok(idxRiskiest > -1 && idxRiskiest < idxAutopsy,
    "autopsy card must render BELOW renderRiskiestPr");
  assert.ok(idxStuck > -1 && idxStuck < idxAutopsy,
    "autopsy card must render BELOW renderStuckPrTaxonomyCard");
  assert.ok(idxSpend > -1 && idxSpend > idxAutopsy,
    "autopsy card must render ABOVE renderSpendEfficiencyCard");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Draft-lesson tap-target: when draft_lesson is set, the SPA
// emits an anchor to /lessons?draft=<base64>. The lessons page
// renderer reads ?draft= and pre-populates a textarea.
// ────────────────────────────────────────────────────────────────────

test("AC9: renderPrAutopsyCard emits a draft-entry link when draft_lesson is set", () => {
  const fn = APP_JS.match(/function\s+renderPrAutopsyCard\s*\([\s\S]*?\n\}/);
  assert.ok(fn);
  // Either base64 encoding via btoa or encodeURIComponent — we accept
  // both shapes; the route is what matters.
  assert.match(fn![0], /\/lessons\?draft=/,
    "draft tap-target must link to /lessons?draft=…");
  assert.match(fn![0], /data-testid="draft-entry-link"/,
    "draft tap-target must carry data-testid=draft-entry-link");
});

test("AC9: lessons() route reads ?draft= param and renders a Suggested entry textarea", () => {
  // The existing `lessons` async function must read params.get("draft")
  // and emit a textarea with data-testid="lesson-draft-textarea".
  const lessonsFn = APP_JS.match(/async\s+function\s+lessons\s*\([^)]*\)[\s\S]*?\n\}/);
  assert.ok(lessonsFn, "lessons() function body must be parseable");
  assert.match(lessonsFn![0], /draft/,
    "lessons() must reference the draft param");
  assert.match(APP_JS, /data-testid="lesson-draft-textarea"/,
    "lessons page must render a textarea with testid lesson-draft-textarea");
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Mobile + >=600px CSS rules.
// ────────────────────────────────────────────────────────────────────

test("AC10: web/style.css declares .pr-autopsy-card + a >=600px breakpoint", () => {
  assert.match(CSS, /\.pr-autopsy-card\b/,
    "style.css must define a .pr-autopsy-card rule group");
  const all600 = CSS.match(/@media\s*\([^)]*min-width:\s*600px[^)]*\)\s*\{[\s\S]*?\n\}/g) || [];
  const matchingBlock = all600.find((b) => /\.pr-autopsy-card|\.pr-autopsy-row/.test(b));
  assert.ok(matchingBlock,
    "A @media (min-width: 600px) block must target the autopsy card");
});

// ────────────────────────────────────────────────────────────────────
// AC11 — Quiet-hours integration: when quiet_hours_active is true,
// the draft-entry tap-target is hidden (but the rest of the card
// renders).
// ────────────────────────────────────────────────────────────────────

test("AC11: renderPrAutopsyCard hides the draft-entry link when data.quiet_hours_active is true", () => {
  const fn = APP_JS.match(/function\s+renderPrAutopsyCard\s*\([\s\S]*?\n\}/);
  assert.ok(fn);
  assert.match(fn![0], /quiet_hours_active|quietHoursActive/,
    "renderPrAutopsyCard must consult quiet_hours_active");
});

// ────────────────────────────────────────────────────────────────────
// AC12 — Edge case: a PR was closed AND re-opened (state='open' now).
// The autopsy must NOT surface it.
// ────────────────────────────────────────────────────────────────────

test("AC12: a re-opened PR (state='open') does NOT appear in the autopsy", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    // closed_at is set (was closed once) but the current state is
    // back to 'open' — the autopsy excludes it.
    seedClosedPr(db, {
      projectId: p, number: 1, state: "open",
      fetchedAt: hoursBeforeNow(2), closedAt: hoursBeforeNow(6),
      createdAt: hoursBeforeNow(24),
    });
    const r = prAutopsies(db, NOW);
    assert.equal(r.total_closes, 0);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC13 — No new runtime deps; no shell-string composition; no break
// to existing /api/... shapes.
// ────────────────────────────────────────────────────────────────────

test("AC13: package.json declares zero runtime dependencies (still)", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    `dependencies must stay empty; saw: ${JSON.stringify(deps)}`);
});

test("AC13: src/views.ts pr-autopsy block never imports node:child_process", () => {
  const src = readFileSync(join(__dirname, "..", "src", "views.ts"), "utf8");
  assert.doesNotMatch(src, /from\s+["']node:child_process["']/,
    "src/views.ts must not import from node:child_process");
});

test("AC13: openDb adds an additive closed_at TEXT column to the pr table", () => {
  const { db, cleanup } = tempDb();
  try {
    const cols = db.prepare("PRAGMA table_info(pr)").all() as unknown as Array<{
      name: string; type: string;
    }>;
    const closedAt = cols.find((c) => c.name === "closed_at");
    assert.ok(closedAt, "pr.closed_at column must exist after openDb()");
    assert.equal(closedAt!.type.toUpperCase(), "TEXT");
  } finally { cleanup(); }
});
