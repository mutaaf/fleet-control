// Unit tests for src/views.ts:forecastFor — the 30-day cost projection per
// project (ticket 0005). Each test maps to one acceptance-criteria checkbox
// in docs/backlog/0005-cost-forecast.md.
//
// Notes:
//   - Zero new deps; stdlib only. We seed cost_rollup_day directly with raw
//     INSERTs rather than running the ingest pipeline because the helper
//     under test only reads that table — no need to materialize runs.
//   - We pin "today" via the date('now','-N day') SQLite expression that
//     forecastFor uses internally. The seed dates are computed in JS with the
//     same offset arithmetic so we don't drift from server-local midnight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db.ts";
import { forecastFor } from "../src/views.ts";

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-forecastdb-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace, repo_owner, repo_name) VALUES (?,?,?,?,?)",
  ).run(slug, slug, "test", "owner", slug);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as any).id;
}

/** Return an ISO yyyy-mm-dd string for `daysAgo` days before now (UTC).
 *  forecastFor uses SQLite's date('now','-N day') which is UTC by default,
 *  so we mirror that here to keep the rolling window aligned. */
function dayOffsetUTC(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function seedRollup(db: DB, projectId: number, day: string, costUsd: number) {
  db.prepare(
    "INSERT INTO cost_rollup_day(project_id, phase, day, runs, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(projectId, "ship", day, 1, 0, 0, 0, 0, costUsd);
}

test("forecastFor: 7 days at $1/day → projected_30d = $30, samples = 7", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "alpha");
    for (let i = 1; i <= 7; i++) seedRollup(db, pid, dayOffsetUTC(i), 1);

    const f = forecastFor(db, "alpha");
    assert.ok(f, "forecastFor must return an object for a known slug");
    assert.equal(f!.samples, 7, "samples is the number of distinct days in the 7d window");
    assert.equal(f!.daily_mean_7d, 1, "7d mean of seven $1 days is exactly $1");
    assert.equal(f!.projected_30d, 30, "30-day projection = daily_mean_7d × 30 = $30");
    // 14d mean also exposed for the tooltip — same single-rate fixture, so $1.
    assert.equal(f!.daily_mean_14d, 1);
    assert.equal(f!.reason, undefined, "happy path must not carry a reason field");
  } finally { cleanup(); }
});

test("forecastFor: 2 days of data → projected_30d null with reason 'not enough data'", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "beta");
    seedRollup(db, pid, dayOffsetUTC(1), 1);
    seedRollup(db, pid, dayOffsetUTC(2), 1);

    const f = forecastFor(db, "beta");
    assert.ok(f, "forecastFor must return an object for a known slug");
    assert.equal(f!.projected_30d, null, "fewer than 3 days → projected_30d MUST be null");
    assert.equal(f!.samples, 2);
    assert.equal(f!.reason, "not enough data", "reason string is the contract for the SPA");
  } finally { cleanup(); }
});

test("forecastFor: zero days of data → projected_30d null, samples=0, reason set", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "gamma"); // project exists but no rollup rows
    const f = forecastFor(db, "gamma");
    assert.ok(f);
    assert.equal(f!.samples, 0);
    assert.equal(f!.projected_30d, null);
    assert.equal(f!.daily_mean_7d, 0);
    assert.equal(f!.daily_mean_14d, 0);
    assert.equal(f!.reason, "not enough data");
  } finally { cleanup(); }
});

test("forecastFor: unknown slug returns null (so the route can 404)", () => {
  const { db, cleanup } = tempDb();
  try {
    const f = forecastFor(db, "no-such-project");
    assert.equal(f, null);
  } finally { cleanup(); }
});

test("forecastFor: 14d mean uses the wider window; 7d mean ignores days >7", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "delta");
    // 7 recent days at $2/day, plus 7 older days (8..14 days ago) at $4/day.
    for (let i = 1; i <= 7; i++) seedRollup(db, pid, dayOffsetUTC(i), 2);
    for (let i = 8; i <= 14; i++) seedRollup(db, pid, dayOffsetUTC(i), 4);

    const f = forecastFor(db, "delta");
    assert.ok(f);
    assert.equal(f!.daily_mean_7d, 2, "7d window only sees the $2/day rows");
    assert.equal(f!.daily_mean_14d, 3, "14d window averages 7×$2 + 7×$4 = $42/14 = $3");
    assert.equal(f!.projected_30d, 60, "projection follows the 7d mean → $2 × 30 = $60");
    assert.equal(f!.samples, 7, "samples counts the distinct days in the 7d window only");
  } finally { cleanup(); }
});

test("forecastFor: sums across phases on a single day (one rollup row per phase)", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "epsilon");
    // Three days, each with ship+groom+review rollup rows that sum to $1/day.
    for (let i = 1; i <= 3; i++) {
      const day = dayOffsetUTC(i);
      db.prepare("INSERT INTO cost_rollup_day(project_id,phase,day,runs,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(pid, "ship",   day, 1, 0, 0, 0, 0, 0.50);
      db.prepare("INSERT INTO cost_rollup_day(project_id,phase,day,runs,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(pid, "groom",  day, 1, 0, 0, 0, 0, 0.25);
      db.prepare("INSERT INTO cost_rollup_day(project_id,phase,day,runs,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(pid, "review", day, 1, 0, 0, 0, 0, 0.25);
    }
    const f = forecastFor(db, "epsilon");
    assert.ok(f);
    assert.equal(f!.samples, 3, "three distinct days even though there are 9 rollup rows");
    assert.equal(f!.daily_mean_7d, 1, "phases must collapse: $0.50+$0.25+$0.25 = $1/day");
    assert.equal(f!.projected_30d, 30);
  } finally { cleanup(); }
});
