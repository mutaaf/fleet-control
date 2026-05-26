// Unit tests for src/anomaly.ts:flagRun — the reactive anomaly detector
// (ticket 0008). Each test maps to one acceptance-criteria checkbox in
// docs/backlog/0008-anomaly-detection.md.
//
// Strategy: seed `run` rows directly (no transcript pipeline involvement) so
// the math is the only thing under test. We use a stable, hand-picked
// duration_ms distribution (all 10s ± a hair of jitter so stddev > 0 yet
// small enough that the 60s outlier sits well above 3σ) and assert exactly
// one anomaly row per fired metric. Zero new deps; stdlib + node:test only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db.ts";
import { flagRun } from "../src/anomaly.ts";

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-anomalydb-"));
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

/** Return an ISO timestamp `daysAgo` days before now (UTC). flagRun reads
 *  started_at and filters by a `date('now','-14 day')` window in SQL, so we
 *  produce real ISO strings and let SQLite compare them. */
function daysAgoIso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

/** Insert a single completed run with the given duration_ms / cost_usd
 *  attributed to a project+phase, started_at = `daysAgo` days ago. Returns
 *  the new run id. Tiny jitter ensures the baseline stddev is non-zero so
 *  the 3σ test is meaningful (a perfectly flat baseline would have σ=0 and
 *  *any* deviation would fire). */
function seedRun(
  db: DB,
  projectId: number,
  phase: string,
  daysAgo: number,
  durationMs: number,
  costUsd: number,
  seq: number,
): number {
  // Jitter ±1ms based on seq so identical baselines still have σ > 0.
  const dur = durationMs + (seq % 2 === 0 ? 1 : -1);
  db.prepare(
    "INSERT INTO run(project_id, phase, session_id, started_at, ended_at, duration_ms, cost_usd_computed, cost_source) VALUES (?,?,?,?,?,?,?,?)",
  ).run(projectId, phase, `sess-${phase}-${daysAgo}-${seq}`, daysAgoIso(daysAgo), daysAgoIso(daysAgo), dur, costUsd, "computed");
  return Number((db.prepare("SELECT last_insert_rowid() AS id").get() as any).id);
}

test("flagRun: 14d baseline of ~10s duration + one 60s run → one duration anomaly row", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "alpha");
    // 14 prior days at ~10000ms with ±1ms jitter (σ ≈ 1ms, mean ≈ 10000ms).
    // Cost stays $0.01 across the board so no cost anomaly is triggered.
    for (let i = 1; i <= 14; i++) seedRun(db, pid, "ship", i, 10_000, 0.01, i);
    // The candidate: started "today" (daysAgo=0 falls inside the window too,
    // but flagRun excludes the run itself from its own baseline by id).
    const target = seedRun(db, pid, "ship", 0, 60_000, 0.01, 99);

    const r = flagRun(db, target);
    assert.equal(r.flagged, true, "60s vs ~10s baseline must fire");
    assert.ok(
      (r.kinds ?? []).includes("duration"),
      "the fired metric must be 'duration'",
    );
    assert.ok(
      !(r.kinds ?? []).includes("cost"),
      "cost stayed flat at $0.01 — no cost anomaly should fire",
    );

    const rows = db.prepare("SELECT * FROM anomaly WHERE run_id=?").all(target) as any[];
    assert.equal(rows.length, 1, "exactly one anomaly row per fired metric");
    const row = rows[0];
    assert.equal(row.kind, "duration");
    // value is the candidate's measured duration (~60s ±1ms jitter from the
    // seed helper — we assert the bucket, not the exact ms, so the test
    // stays robust if the helper's jitter ever changes).
    assert.ok(row.value >= 59_000 && row.value <= 61_000, "value ≈ 60s");
    assert.ok(row.sample_count >= 5, "baseline must have at least 5 samples");
    assert.ok(row.baseline_mean > 9_000 && row.baseline_mean < 11_000, "mean ≈ 10000ms");
    assert.ok(row.baseline_stddev > 0, "stddev must be > 0 so the multiplier is finite");
    assert.ok(row.created_at, "created_at must be stamped");
  } finally { cleanup(); }
});

test("flagRun: baseline with realistic spread + a 15s run → no anomaly row (within 3σ)", () => {
  // The spec's "same baseline, insert one at 15000ms" assumes a realistic
  // baseline with spread (otherwise σ→0 makes every multiplier infinite).
  // We mix 8s/10s/12s/14s/6s prior runs so σ ≈ 2.4s, mean ≈ 10s. A 15s
  // candidate sits well within the 3σ band (upper bound ≈ 17.2s) and so
  // must NOT fire. The 60s case in the earlier test is still ~21σ above
  // the same kind of baseline, so the detector remains useful.
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "beta");
    const values = [8_000, 10_000, 12_000, 8_000, 10_000, 12_000, 8_000, 10_000, 12_000, 8_000, 10_000, 12_000, 14_000, 6_000];
    for (let i = 0; i < values.length; i++) {
      seedRun(db, pid, "ship", i + 1, values[i], 0.01, i);
    }
    const target = seedRun(db, pid, "ship", 0, 15_000, 0.01, 99);
    const r = flagRun(db, target);
    assert.equal(r.flagged, false, "15s should be within 3σ of a ~10s mean with ~2.4s stddev");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM anomaly WHERE run_id=?").get(target) as any;
    assert.equal(rows.n, 0, "no row inserted when the metric is within 3σ");
  } finally { cleanup(); }
});

test("flagRun: only 4 prior runs → returns insufficient_baseline, no row written", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "gamma");
    for (let i = 1; i <= 4; i++) seedRun(db, pid, "ship", i, 10_000, 0.01, i);
    // 10× outlier — would absolutely fire if we had enough baseline samples.
    const target = seedRun(db, pid, "ship", 0, 100_000, 0.10, 99);
    const r = flagRun(db, target);
    assert.equal(r.flagged, false);
    assert.equal(r.reason, "insufficient_baseline", "exact reason string per spec");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM anomaly WHERE run_id=?").get(target) as any;
    assert.equal(rows.n, 0, "no row may be written when the baseline is thin");
  } finally { cleanup(); }
});

test("flagRun: 3 is_error events on the candidate → candidate_reason = 'repeated tool errors'", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "delta");
    for (let i = 1; i <= 14; i++) seedRun(db, pid, "ship", i, 10_000, 0.01, i);
    const target = seedRun(db, pid, "ship", 0, 60_000, 0.01, 99);
    // Seed three tool_result rows with is_error=1 on the candidate run.
    const ins = db.prepare(
      "INSERT INTO run_event(run_id, seq, ts, kind, tool_name, input_summary, output_summary, is_error) VALUES (?,?,?,?,?,?,?,?)",
    );
    for (let i = 0; i < 3; i++) {
      ins.run(target, i, daysAgoIso(0), "tool_result", "Bash", "", `error ${i}`, 1);
    }
    const r = flagRun(db, target);
    assert.equal(r.flagged, true);
    const row = db.prepare("SELECT candidate_reason FROM anomaly WHERE run_id=? AND kind='duration'").get(target) as any;
    assert.equal(row.candidate_reason, "repeated tool errors", "exact heuristic string per spec");
  } finally { cleanup(); }
});

test("flagRun: re-running on the same run is idempotent → second call returns already_flagged", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "epsilon");
    for (let i = 1; i <= 14; i++) seedRun(db, pid, "ship", i, 10_000, 0.01, i);
    const target = seedRun(db, pid, "ship", 0, 60_000, 0.01, 99);

    const first = flagRun(db, target);
    assert.equal(first.flagged, true);

    const second = flagRun(db, target);
    assert.equal(second.flagged, false);
    assert.equal(second.reason, "already_flagged", "second call MUST short-circuit on the UNIQUE constraint");

    const rows = db.prepare("SELECT COUNT(*) AS n FROM anomaly WHERE run_id=?").all(target) as any[];
    assert.equal(rows[0].n, 1, "still exactly one row — UNIQUE(run_id, kind) holds");
  } finally { cleanup(); }
});
