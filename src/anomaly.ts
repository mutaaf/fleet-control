// Reactive anomaly detection (ticket 0008). Pure SQL + stdlib math; no
// shell-out, no transcript file I/O, no new runtime deps. Compares a single
// run's duration_ms and cost_usd against its (project, phase) baseline
// over the previous 14 days and inserts one `anomaly` row per metric that
// sits more than SIGMA_MULTIPLIER standard deviations above the mean.
//
// Idempotency: the anomaly table has UNIQUE(run_id, kind); re-running
// flagRun on the same run is a silent no-op and returns
// {flagged:false, reason:"already_flagged"}.
//
// Why "sample population stddev" (divisor N, not N-1): we treat the
// trailing window as the *entire* population the operator cares about —
// not a sample drawn from some larger distribution. With only ~5–20 runs
// per phase per fortnight, Bessel's correction overstates uncertainty;
// the operator just wants "is this run far from the recent norm". Hardcoded
// to 3 in v1 (see ticket §"Out of scope") so a single outlier doesn't fire
// on noisy projects.
import type { DB } from "./db.ts";

/** σ multiplier above the baseline mean that fires an anomaly. */
export const SIGMA_MULTIPLIER = 3;
/** Minimum samples in the trailing window required to compute a baseline. */
export const MIN_SAMPLES = 5;
/** Lookback window for baseline computation. */
export const BASELINE_DAYS = 14;

export type FlagKind = "duration" | "cost";

export interface FlagResult {
  flagged: boolean;
  /** When flagged: the metric kinds that fired (one or both). */
  kinds?: FlagKind[];
  /** When not flagged: why ("insufficient_baseline" | "already_flagged" |
   *  "within_threshold" | "missing_run"). */
  reason?: string;
}

interface BaselineRow {
  n: number;
  mean: number;
  stddev: number;
}

/** Mean + population stddev across the prior-N-day window for a given
 *  (project_id, phase, column). Excludes the candidate run by id. Returns
 *  {n:0} if the window is empty. SQL is two aggregates so the caller can
 *  decide whether MIN_SAMPLES is met before computing the σ multiplier. */
function baselineFor(
  db: DB,
  column: "duration_ms" | "cost",
  projectId: number,
  phase: string,
  excludeRunId: number,
): BaselineRow {
  // COALESCE(cost_usd, cost_usd_computed, 0) mirrors the rest of the codebase
  // (views.ts, fleetctl status) so the baseline reflects the same numbers
  // the operator sees in the portal.
  const expr = column === "cost"
    ? "COALESCE(cost_usd, cost_usd_computed, 0)"
    : "COALESCE(duration_ms, 0)";
  const sql =
    "SELECT " + expr + " AS v FROM run "
    + "WHERE project_id = ? AND phase = ? AND id != ? "
    + "  AND started_at IS NOT NULL "
    + "  AND started_at >= datetime('now', '-" + BASELINE_DAYS + " day') "
    + "  AND " + (column === "cost" ? "(cost_usd IS NOT NULL OR cost_usd_computed IS NOT NULL)" : "duration_ms IS NOT NULL");
  const rows = db.prepare(sql).all(projectId, phase, excludeRunId) as Array<{ v: number }>;
  const n = rows.length;
  if (n === 0) return { n: 0, mean: 0, stddev: 0 };
  let sum = 0;
  for (const r of rows) sum += Number(r.v) || 0;
  const mean = sum / n;
  let ss = 0;
  for (const r of rows) {
    const d = (Number(r.v) || 0) - mean;
    ss += d * d;
  }
  const stddev = Math.sqrt(ss / n); // population stddev (divisor n)
  return { n, mean, stddev };
}

/** Deterministic per-run heuristic. Scans the already-ingested run_event
 *  rows and returns the first matching string. No transcript file I/O —
 *  events come from src/ingest/transcripts.ts. */
export function candidateReason(db: DB, runId: number): string | null {
  const errCount = db.prepare(
    "SELECT COUNT(*) AS n FROM run_event WHERE run_id=? AND is_error=1",
  ).get(runId) as { n: number };
  if (errCount.n >= 3) return "repeated tool errors";

  // "no test gate output": no tool_use that fired Bash AND no event with
  // tsc/test/validate in its input_summary. We scan tool_use rows for the
  // presence of the gate-y bits.
  const hasGateSignal = db.prepare(
    "SELECT 1 FROM run_event "
    + "WHERE run_id=? AND ("
    + "  (kind='tool_use' AND tool_name='Bash') OR "
    + "  (input_summary IS NOT NULL AND ("
    + "    instr(lower(input_summary),'tsc')>0 OR "
    + "    instr(lower(input_summary),'test')>0 OR "
    + "    instr(lower(input_summary),'validate')>0))"
    + ") LIMIT 1",
  ).get(runId);
  if (!hasGateSignal) return "no test gate output";

  // "transcript truncated": last event is a tool_use that never received a
  // matching tool_result. Order by seq DESC, take 1, check for a successor
  // tool_result with the same tool_use_id.
  const last = db.prepare(
    "SELECT kind, tool_use_id FROM run_event WHERE run_id=? ORDER BY seq DESC LIMIT 1",
  ).get(runId) as { kind: string; tool_use_id: string | null } | undefined;
  if (last && last.kind === "tool_use" && last.tool_use_id) {
    const matched = db.prepare(
      "SELECT 1 FROM run_event WHERE run_id=? AND kind='tool_result' AND tool_use_id=? LIMIT 1",
    ).get(runId, last.tool_use_id);
    if (!matched) return "transcript truncated";
  } else if (last && last.kind === "tool_use" && !last.tool_use_id) {
    // No id to correlate with; still treat as truncated — a tool_use with
    // no result is the spec's intent.
    return "transcript truncated";
  }

  return null;
}

/** Flag a single run for anomalies against its (project, phase) baseline.
 *  Inserts one row per fired metric in `anomaly`. Idempotent via
 *  UNIQUE(run_id, kind). Returns a small result object so the caller (and
 *  the tests) can branch without re-querying the table. */
export function flagRun(db: DB, runId: number): FlagResult {
  const run = db.prepare(
    "SELECT id, project_id, phase, duration_ms, "
    + "  COALESCE(cost_usd, cost_usd_computed) AS cost "
    + "FROM run WHERE id = ?",
  ).get(runId) as { id: number; project_id: number; phase: string; duration_ms: number | null; cost: number | null } | undefined;
  if (!run) return { flagged: false, reason: "missing_run" };

  // Short-circuit if this run already has any anomaly row — we return the
  // "already_flagged" reason on the very first call to keep the spec's
  // contract simple. (If a downstream wants partial re-flag, that'd be a
  // new ticket; v1 says "once flagged, leave it.")
  const already = db.prepare(
    "SELECT COUNT(*) AS n FROM anomaly WHERE run_id = ?",
  ).get(runId) as { n: number };
  if (already.n > 0) return { flagged: false, reason: "already_flagged" };

  const metrics: Array<{ kind: FlagKind; value: number | null }> = [
    { kind: "duration", value: run.duration_ms },
    { kind: "cost", value: run.cost },
  ];

  // Compute baselines once per (kind) — both flow through the same
  // sample-count gate. If neither has enough samples, we report
  // insufficient_baseline (and write nothing).
  const baselines: Record<FlagKind, BaselineRow> = {
    duration: baselineFor(db, "duration_ms", run.project_id, run.phase, runId),
    cost: baselineFor(db, "cost", run.project_id, run.phase, runId),
  };

  // The spec's "no row inserted" for thin baselines: if BOTH baselines are
  // below MIN_SAMPLES, surface insufficient_baseline. If only one baseline
  // is thin we still check the other (e.g. duration is well-sampled but
  // cost isn't) — the spec treats baselines per metric.
  const enoughDur = baselines.duration.n >= MIN_SAMPLES;
  const enoughCost = baselines.cost.n >= MIN_SAMPLES;
  if (!enoughDur && !enoughCost) {
    return { flagged: false, reason: "insufficient_baseline" };
  }

  const reason = candidateReason(db, runId);
  const now = new Date().toISOString();
  const fired: FlagKind[] = [];

  const ins = db.prepare(
    "INSERT INTO anomaly(run_id, kind, value, baseline_mean, baseline_stddev, sample_count, candidate_reason, created_at) "
    + "VALUES (?,?,?,?,?,?,?,?)",
  );

  for (const m of metrics) {
    if (m.value == null) continue;
    const b = baselines[m.kind];
    if (b.n < MIN_SAMPLES) continue;
    // σ=0 means a perfectly flat baseline (no variability). Any value >
    // mean is technically infinite-σ above, but the operator-friendly
    // behavior is "don't fire on a one-off identical-runtime baseline" —
    // we require stddev > 0 to have a meaningful threshold.
    if (!(b.stddev > 0)) continue;
    const threshold = b.mean + SIGMA_MULTIPLIER * b.stddev;
    if (m.value <= threshold) continue;
    try {
      ins.run(runId, m.kind, m.value, b.mean, b.stddev, b.n, reason, now);
      fired.push(m.kind);
    } catch {
      // Race: another writer inserted the same (run_id, kind). Treat as
      // already flagged for this kind; keep going for the other metric.
    }
  }

  if (fired.length === 0) return { flagged: false, reason: "within_threshold" };
  return { flagged: true, kinds: fired };
}

/** Recent flagged runs for a project (most recent first). Used by
 *  /api/projects/:slug/anomalies. Each row carries enough context for the
 *  SPA to render without a second round-trip: run_id, phase, kind,
 *  value, baseline_mean, the computed stddev_multiplier (so the badge can
 *  say "5.2σ above baseline"), candidate_reason, and created_at. */
export interface AnomalyRow {
  run_id: number;
  phase: string;
  kind: string;
  value: number;
  baseline_mean: number;
  stddev_multiplier: number;
  candidate_reason: string | null;
  created_at: string;
}

export function recentAnomalies(db: DB, projectId: number, limit: number): AnomalyRow[] {
  const cap = Math.max(1, Math.min(Math.floor(limit), 50));
  const rows = db.prepare(
    "SELECT a.run_id AS run_id, r.phase AS phase, a.kind AS kind, a.value AS value, "
    + "  a.baseline_mean AS baseline_mean, a.baseline_stddev AS baseline_stddev, "
    + "  a.candidate_reason AS candidate_reason, a.created_at AS created_at "
    + "FROM anomaly a JOIN run r ON r.id = a.run_id "
    + "WHERE r.project_id = ? "
    + "ORDER BY a.created_at DESC LIMIT ?",
  ).all(projectId, cap) as Array<{
    run_id: number; phase: string; kind: string; value: number;
    baseline_mean: number; baseline_stddev: number;
    candidate_reason: string | null; created_at: string;
  }>;
  return rows.map((r) => ({
    run_id: r.run_id,
    phase: r.phase,
    kind: r.kind,
    value: r.value,
    baseline_mean: r.baseline_mean,
    stddev_multiplier: r.baseline_stddev > 0
      ? (r.value - r.baseline_mean) / r.baseline_stddev
      : 0,
    candidate_reason: r.candidate_reason,
    created_at: r.created_at,
  }));
}

/** Anomalies attached to a single run — used by runView to render the
 *  badge on the run-detail page. Returns at most one row per kind. */
export function anomaliesForRun(db: DB, runId: number): AnomalyRow[] {
  const rows = db.prepare(
    "SELECT a.run_id AS run_id, r.phase AS phase, a.kind AS kind, a.value AS value, "
    + "  a.baseline_mean AS baseline_mean, a.baseline_stddev AS baseline_stddev, "
    + "  a.candidate_reason AS candidate_reason, a.created_at AS created_at "
    + "FROM anomaly a JOIN run r ON r.id = a.run_id "
    + "WHERE a.run_id = ? ORDER BY a.kind",
  ).all(runId) as Array<{
    run_id: number; phase: string; kind: string; value: number;
    baseline_mean: number; baseline_stddev: number;
    candidate_reason: string | null; created_at: string;
  }>;
  return rows.map((r) => ({
    run_id: r.run_id, phase: r.phase, kind: r.kind, value: r.value,
    baseline_mean: r.baseline_mean,
    stddev_multiplier: r.baseline_stddev > 0
      ? (r.value - r.baseline_mean) / r.baseline_stddev
      : 0,
    candidate_reason: r.candidate_reason, created_at: r.created_at,
  }));
}
