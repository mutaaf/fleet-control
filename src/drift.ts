// Self-baseline drift detector (ticket 0034).
//
// Compares the project's last-24h shape against its own trailing-14d
// baseline on three metrics:
//
//   1. bash_share         — share of tool_use rows with tool_name='Bash'.
//   2. edit_read_ratio    — Edit count / max(Read count, 1). Capped at 50.
//   3. median_run_cost_usd — median of run.cost_usd in the window.
//
// A metric is "drifted" when |sigmas| >= 2.5 AND the baseline has at
// least 7 data points AND the baseline sigma exceeds a per-metric floor
// (per LESSONS § "anomaly tests need σ > 0 in the fixture, not just
// mean ≠ value" — a flat baseline would otherwise produce
// "1000σ above" on any deviation).
//
// Architecture:
//   - `detectProjectDrift(db, projectId, now)`: pure read; aggregates
//     per-day baseline values + a current-window value, computes
//     population sigma over the baseline, emits one entry per drifted
//     metric.
//   - `runDriftHook(db, now)`: writes one `anomaly` row per NEW drift
//     (matched by project + correlation_signature=<metric> in a 24h
//     window). Per LESSONS § "re-fire-after-dismiss needs an aging
//     window, not a partial UNIQUE index", idempotency lives in the
//     application — never a SQL UNIQUE constraint.
//   - `activeDrifts(db, now)`: returns the live, non-dismissed drift
//     list — the inbox + route both call this.
//
// Zero new runtime deps; pure SQL + standard-library math. Per
// LESSONS § "node:sqlite's .all() needs `as unknown as T[]`", every
// typed read goes through the double-cast. Per LESSONS § "julianday()
// drifts ~10us per timestamp", window arithmetic uses strftime/date()
// decomposition — never julianday().
import type { DB } from "./db.ts";

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export type DriftMetric =
  | "bash_share"
  | "edit_read_ratio"
  | "median_run_cost_usd";

export interface DriftEntry {
  /** Which metric drifted. */
  metric: DriftMetric;
  /** Mean of the per-day baseline values (14 points). */
  baseline_mean: number;
  /** Population stddev of the per-day baseline values. */
  baseline_sigma: number;
  /** The current-window (24h) value. */
  current: number;
  /** Standardised distance: (current - baseline_mean) / baseline_sigma.
   *  Signed — positive means current > baseline. */
  sigmas: number;
  /** ISO timestamp of the oldest contributing current-window event for
   *  this metric — the "since HH:MM" copy the operator sees on the
   *  inbox row. */
  first_seen_at: string;
  /** Top-3 run.id values (descending by per-metric contribution). The
   *  ids are stringified so the SPA can render them inside a chip
   *  without dropping precision. */
  contributing_runs: string[];
}

export interface DriftRow extends DriftEntry {
  /** Project slug — joined in by activeDrifts for the inbox/route. */
  project_slug: string;
  /** ISO timestamp of the anomaly row's created_at. */
  created_at: string;
}

// ────────────────────────────────────────────────────────────────────
// Tunables — fixed for v1; operator-configurable is out of scope per
// the ticket "Out of scope" list.
// ────────────────────────────────────────────────────────────────────

const SIGMA_THRESHOLD = 2.5;
const MIN_BASELINE_DAYS = 7;
const BASELINE_DAYS = 14;
const CURRENT_HOURS = 24;
const EDIT_READ_CAP = 50;

/** Per-metric noise floor on baseline sigma. Below this the metric is
 *  treated as "flat" and never drifts — even a wildly different
 *  current value yields no fire. Picked so a real ship-phase project's
 *  natural day-to-day jitter clears the floor; a synthetic perfectly-
 *  flat fixture (zero variance) does not. */
const SIGMA_FLOOR: Record<DriftMetric, number> = {
  bash_share: 0.005,           // 0.5 share points
  edit_read_ratio: 0.05,       // 0.05 ratio points
  median_run_cost_usd: 0.01,   // $0.01
};

// ────────────────────────────────────────────────────────────────────
// Stats helpers (pure, no I/O)
// ────────────────────────────────────────────────────────────────────

/** Population standard deviation. Returns 0 for a 0/1-element array
 *  so callers can pair with the SIGMA_FLOOR guard rather than guarding
 *  for NaN. */
function popStddev(xs: number[]): number {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Median for the current-window cost. Returns 0 on empty so the
 *  baseline comparison stays numerically sane (the variance-floor
 *  guard will suppress the spurious "0σ" case downstream). */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

// ────────────────────────────────────────────────────────────────────
// SQL row types — double-cast at the .all() / .get() boundary.
// ────────────────────────────────────────────────────────────────────

interface DailyToolCountRow {
  day: string;
  bash_count: number;
  edit_count: number;
  read_count: number;
  total_count: number;
}

interface DailyCostRow {
  day: string;
  median_cost: number;
}

interface RunCostRow {
  cost_usd: number | null;
}

interface RunContribBashRow {
  id: number;
  bash_count: number;
  ts: string;
}

interface RunContribEditReadRow {
  id: number;
  edit_count: number;
  read_count: number;
  ts: string;
}

interface RunContribCostRow {
  id: number;
  cost_usd: number | null;
  started_at: string;
}

// ────────────────────────────────────────────────────────────────────
// detectProjectDrift — pure read; emits one DriftEntry per drifted
// metric.
// ────────────────────────────────────────────────────────────────────

export interface DetectOpts {
  /** Inject a sigma threshold for tests; defaults to SIGMA_THRESHOLD. */
  sigmaThreshold?: number;
}

export function detectProjectDrift(
  db: DB,
  projectId: number,
  now: Date,
  opts: DetectOpts = {},
): DriftEntry[] {
  const sigmaThreshold = opts.sigmaThreshold ?? SIGMA_THRESHOLD;
  // Window bounds — ISO so the SQL comparison stays lexicographic
  // (ISO-8601 is sortable as a string). Per LESSONS § "julianday()
  // drifts ~10us per timestamp", we never roundtrip through julianday;
  // SQLite's date()/datetime()/strftime suffice for 24h / 14d math.
  const currentStart = new Date(now.getTime() - CURRENT_HOURS * 3600_000).toISOString();
  const baselineEnd = currentStart; // "everything before the current window"
  const baselineStart = new Date(now.getTime() - (BASELINE_DAYS + 1) * 24 * 3600_000).toISOString();

  // ── Per-day tool counts across the baseline + current windows ────
  // We bucket by date(ts) — one row per UTC day. Bash / Edit / Read
  // counts come from one scan via SUM(CASE WHEN ...). The query
  // touches run + run_event only — no schema migration needed.
  const dailyToolRows = db.prepare(
    "SELECT date(e.ts) AS day, "
    + "       SUM(CASE WHEN e.tool_name='Bash' THEN 1 ELSE 0 END) AS bash_count, "
    + "       SUM(CASE WHEN e.tool_name='Edit' THEN 1 ELSE 0 END) AS edit_count, "
    + "       SUM(CASE WHEN e.tool_name='Read' THEN 1 ELSE 0 END) AS read_count, "
    + "       COUNT(*) AS total_count "
    + "  FROM run_event e "
    + "  JOIN run r ON r.id = e.run_id "
    + " WHERE r.project_id = ? "
    + "   AND e.kind = 'tool_use' AND e.tool_name IS NOT NULL "
    + "   AND e.ts >= ? AND e.ts < ? "
    + " GROUP BY date(e.ts) "
    + " ORDER BY day",
  ).all(projectId, baselineStart, baselineEnd) as unknown as DailyToolCountRow[];

  // Per-day median cost: SQLite has no native median, so we pull the
  // baseline runs grouped by day and compute the median in JS.
  const baselineRunRows = db.prepare(
    "SELECT date(r.started_at) AS day, r.cost_usd AS cost_usd "
    + "  FROM run r "
    + " WHERE r.project_id = ? "
    + "   AND r.started_at >= ? AND r.started_at < ? "
    + "   AND r.cost_usd IS NOT NULL",
  ).all(projectId, baselineStart, baselineEnd) as unknown as Array<{ day: string; cost_usd: number | null }>;
  const costsByDay = new Map<string, number[]>();
  for (const r of baselineRunRows) {
    if (r.cost_usd == null) continue;
    const list = costsByDay.get(r.day) ?? [];
    list.push(r.cost_usd);
    costsByDay.set(r.day, list);
  }
  const dailyCostRows: DailyCostRow[] = [];
  for (const [day, costs] of costsByDay) {
    dailyCostRows.push({ day, median_cost: median(costs) });
  }

  // Build per-day baseline samples for each metric.
  const bashShareByDay: number[] = [];
  const editReadRatioByDay: number[] = [];
  for (const r of dailyToolRows) {
    if (r.total_count > 0) {
      bashShareByDay.push(r.bash_count / r.total_count);
    }
    if (r.edit_count > 0 || r.read_count > 0) {
      const denom = Math.max(r.read_count, 1);
      const ratio = Math.min(r.edit_count / denom, EDIT_READ_CAP);
      editReadRatioByDay.push(ratio);
    }
  }
  const medianCostByDay: number[] = dailyCostRows.map((r) => r.median_cost);

  // ── Current-window aggregates ────────────────────────────────────
  const currentEnd = now.toISOString();
  const curToolRow = db.prepare(
    "SELECT SUM(CASE WHEN e.tool_name='Bash' THEN 1 ELSE 0 END) AS bash_count, "
    + "       SUM(CASE WHEN e.tool_name='Edit' THEN 1 ELSE 0 END) AS edit_count, "
    + "       SUM(CASE WHEN e.tool_name='Read' THEN 1 ELSE 0 END) AS read_count, "
    + "       COUNT(*) AS total_count, "
    + "       MIN(e.ts) AS first_ts "
    + "  FROM run_event e "
    + "  JOIN run r ON r.id = e.run_id "
    + " WHERE r.project_id = ? "
    + "   AND e.kind = 'tool_use' AND e.tool_name IS NOT NULL "
    + "   AND e.ts >= ? AND e.ts <= ?",
  ).get(projectId, currentStart, currentEnd) as unknown as {
    bash_count: number | null; edit_count: number | null;
    read_count: number | null; total_count: number | null;
    first_ts: string | null;
  } | undefined;

  const curBash = curToolRow?.bash_count ?? 0;
  const curEdit = curToolRow?.edit_count ?? 0;
  const curRead = curToolRow?.read_count ?? 0;
  const curTotal = curToolRow?.total_count ?? 0;
  const curFirstTs = curToolRow?.first_ts ?? null;

  const currentBashShare = curTotal > 0 ? curBash / curTotal : 0;
  const currentEditReadRatio = Math.min(
    curEdit / Math.max(curRead, 1), EDIT_READ_CAP,
  );

  const currentCostRows = db.prepare(
    "SELECT cost_usd FROM run "
    + " WHERE project_id = ? "
    + "   AND started_at >= ? AND started_at <= ? "
    + "   AND cost_usd IS NOT NULL",
  ).all(projectId, currentStart, currentEnd) as unknown as RunCostRow[];
  const currentCosts: number[] = currentCostRows
    .map((r) => r.cost_usd)
    .filter((c): c is number => c != null);
  const currentMedianCost = median(currentCosts);

  // Earliest current-window run start (used for the cost-metric
  // first_seen_at since cost is a run-level signal).
  const currentRunFirstRow = db.prepare(
    "SELECT MIN(started_at) AS first_ts FROM run "
    + " WHERE project_id = ? AND started_at >= ? AND started_at <= ?",
  ).get(projectId, currentStart, currentEnd) as unknown as
    { first_ts: string | null } | undefined;
  const currentRunFirstTs = currentRunFirstRow?.first_ts ?? null;

  // ── Per-metric drift evaluation ──────────────────────────────────
  const out: DriftEntry[] = [];

  function maybeEmit(
    metric: DriftMetric,
    baseline: number[],
    current: number,
    firstSeenAt: string | null,
    contributorsFn: () => string[],
  ) {
    if (baseline.length < MIN_BASELINE_DAYS) return;
    const bMean = mean(baseline);
    const bSigma = popStddev(baseline);
    if (bSigma < SIGMA_FLOOR[metric]) return;
    const sigmas = (current - bMean) / bSigma;
    if (Math.abs(sigmas) < sigmaThreshold) return;
    out.push({
      metric,
      baseline_mean: bMean,
      baseline_sigma: bSigma,
      current,
      sigmas,
      first_seen_at: firstSeenAt ?? currentStart,
      contributing_runs: contributorsFn(),
    });
  }

  // bash_share — contribution per run = its Bash count.
  maybeEmit("bash_share", bashShareByDay, currentBashShare, curFirstTs, () => {
    const rows = db.prepare(
      "SELECT r.id AS id, "
      + "       SUM(CASE WHEN e.tool_name='Bash' THEN 1 ELSE 0 END) AS bash_count, "
      + "       MIN(e.ts) AS ts "
      + "  FROM run_event e "
      + "  JOIN run r ON r.id = e.run_id "
      + " WHERE r.project_id = ? "
      + "   AND e.kind = 'tool_use' AND e.tool_name IS NOT NULL "
      + "   AND e.ts >= ? AND e.ts <= ? "
      + " GROUP BY r.id "
      + " ORDER BY bash_count DESC, r.id DESC "
      + " LIMIT 3",
    ).all(projectId, currentStart, currentEnd) as unknown as RunContribBashRow[];
    return rows.map((r) => String(r.id));
  });

  // edit_read_ratio — contribution per run = Edit - Read (positive
  // means this run pushed the ratio up).
  maybeEmit("edit_read_ratio", editReadRatioByDay, currentEditReadRatio, curFirstTs, () => {
    const rows = db.prepare(
      "SELECT r.id AS id, "
      + "       SUM(CASE WHEN e.tool_name='Edit' THEN 1 ELSE 0 END) AS edit_count, "
      + "       SUM(CASE WHEN e.tool_name='Read' THEN 1 ELSE 0 END) AS read_count, "
      + "       MIN(e.ts) AS ts "
      + "  FROM run_event e "
      + "  JOIN run r ON r.id = e.run_id "
      + " WHERE r.project_id = ? "
      + "   AND e.kind = 'tool_use' AND e.tool_name IS NOT NULL "
      + "   AND e.ts >= ? AND e.ts <= ? "
      + " GROUP BY r.id "
      + " ORDER BY (edit_count - read_count) DESC, r.id DESC "
      + " LIMIT 3",
    ).all(projectId, currentStart, currentEnd) as unknown as RunContribEditReadRow[];
    return rows.map((r) => String(r.id));
  });

  // median_run_cost_usd — contribution per run = its cost in dollars.
  maybeEmit("median_run_cost_usd", medianCostByDay, currentMedianCost,
    currentRunFirstTs, () => {
      const rows = db.prepare(
        "SELECT id, cost_usd, started_at "
        + "  FROM run "
        + " WHERE project_id = ? "
        + "   AND started_at >= ? AND started_at <= ? "
        + "   AND cost_usd IS NOT NULL "
        + " ORDER BY cost_usd DESC, id DESC "
        + " LIMIT 3",
      ).all(projectId, currentStart, currentEnd) as unknown as RunContribCostRow[];
      return rows.map((r) => String(r.id));
    });

  return out;
}

// ────────────────────────────────────────────────────────────────────
// runDriftHook — daemon side. One anomaly row per NEW drift per
// (project, metric) in a 24h window. Idempotency lives in the
// application — never a SQL UNIQUE constraint. Per LESSONS § "re-fire-
// after-dismiss needs an aging window, not a partial UNIQUE index".
// ────────────────────────────────────────────────────────────────────

interface ActiveProjectRow {
  id: number;
  slug: string;
}

/** Run drift detection against every project; insert one fresh
 *  anomaly row per (project, metric) pair that is NOT already live
 *  in the 24h window. Returns the count of new rows inserted. */
export function runDriftHook(db: DB, now: Date): number {
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const projects = db.prepare(
    "SELECT id, slug FROM project ORDER BY slug",
  ).all() as unknown as ActiveProjectRow[];

  const liveCheck = db.prepare(
    "SELECT a.id AS id, a.created_at AS created_at "
    + "  FROM anomaly a "
    + "  JOIN run r ON r.id = a.run_id "
    + " WHERE a.kind = 'self_drift' "
    + "   AND a.correlation_signature = ? "
    + "   AND r.project_id = ? "
    + "   AND a.created_at >= ? "
    + " ORDER BY a.created_at DESC "
    + " LIMIT 1",
  );

  // We tag each anomaly row to a single representative run — the
  // first contributing run for the drift. This keeps the FK constraint
  // happy AND lets the existing inbox JOIN
  // (anomaly → run → project) reach the project slug without a
  // schema change. The "true" cause is the rolled-up metric, not the
  // single run; the contributing_runs list (stored in
  // candidate_reason JSON) carries the full top-3 picture.
  const ins = db.prepare(
    "INSERT INTO anomaly("
    + "  run_id, kind, value, baseline_mean, baseline_stddev, "
    + "  sample_count, candidate_reason, created_at, correlation_signature"
    + ") VALUES(?, 'self_drift', ?, ?, ?, ?, ?, ?, ?)",
  );

  let inserted = 0;
  for (const p of projects) {
    const drifts = detectProjectDrift(db, p.id, now);
    for (const d of drifts) {
      const existing = liveCheck.get(d.metric, p.id, cutoff) as
        { id: number; created_at: string } | undefined;
      if (existing) continue;
      if (d.contributing_runs.length === 0) continue;
      const runId = Number(d.contributing_runs[0]);
      if (!Number.isFinite(runId) || runId <= 0) continue;
      const detail = JSON.stringify({
        metric: d.metric,
        baseline_mean: d.baseline_mean,
        baseline_sigma: d.baseline_sigma,
        current: d.current,
        sigmas: d.sigmas,
        first_seen_at: d.first_seen_at,
        contributing_runs: d.contributing_runs,
      });
      ins.run(
        runId,
        d.current,
        d.baseline_mean,
        d.baseline_sigma,
        d.contributing_runs.length,
        detail,
        nowIso,
        d.metric,
      );
      inserted += 1;
    }
  }
  return inserted;
}

// ────────────────────────────────────────────────────────────────────
// activeDrifts — read live (non-dismissed) drift rows for the inbox /
// route. Mirrors the activeCorrelations shape: a LEFT JOIN onto
// inbox_dismissal so a dismissal within the row's 24h window
// suppresses it.
// ────────────────────────────────────────────────────────────────────

interface AnomalyDriftRow {
  id: number;
  correlation_signature: string;
  created_at: string;
  candidate_reason: string | null;
  baseline_mean: number;
  baseline_stddev: number;
  value: number;
  project_slug: string;
}

export function activeDrifts(db: DB, now: Date): DriftRow[] {
  const cutoff = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const rows = db.prepare(
    "SELECT a.id AS id, a.correlation_signature AS correlation_signature, "
    + "       a.created_at AS created_at, a.candidate_reason AS candidate_reason, "
    + "       a.baseline_mean AS baseline_mean, a.baseline_stddev AS baseline_stddev, "
    + "       a.value AS value, p.slug AS project_slug "
    + "  FROM anomaly a "
    + "  JOIN run r ON r.id = a.run_id "
    + "  JOIN project p ON p.id = r.project_id "
    + "  LEFT JOIN inbox_dismissal d "
    + "         ON d.kind = 'self_drift' "
    + "        AND d.project_slug = p.slug "
    + "        AND d.payload_id = a.correlation_signature "
    + "        AND d.dismissed_at >= a.created_at "
    + " WHERE a.kind = 'self_drift' "
    + "   AND a.correlation_signature IS NOT NULL "
    + "   AND a.created_at >= ? "
    + "   AND d.dismissed_at IS NULL "
    + " ORDER BY a.created_at DESC, a.id DESC",
  ).all(cutoff) as unknown as AnomalyDriftRow[];

  const out: DriftRow[] = [];
  for (const r of rows) {
    let detail: {
      metric?: DriftMetric;
      baseline_mean?: number;
      baseline_sigma?: number;
      current?: number;
      sigmas?: number;
      first_seen_at?: string;
      contributing_runs?: string[];
    } = {};
    if (r.candidate_reason) {
      try { detail = JSON.parse(r.candidate_reason); }
      catch { /* fall through with empty detail */ }
    }
    const metric = (detail.metric ?? r.correlation_signature) as DriftMetric;
    const baselineMean = detail.baseline_mean ?? r.baseline_mean ?? 0;
    const baselineSigma = detail.baseline_sigma ?? r.baseline_stddev ?? 0;
    const current = detail.current ?? r.value ?? 0;
    const sigmas = detail.sigmas
      ?? (baselineSigma > 0 ? (current - baselineMean) / baselineSigma : 0);
    out.push({
      metric,
      baseline_mean: baselineMean,
      baseline_sigma: baselineSigma,
      current,
      sigmas,
      first_seen_at: detail.first_seen_at ?? r.created_at,
      contributing_runs: detail.contributing_runs ?? [],
      project_slug: r.project_slug,
      created_at: r.created_at,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// projectDriftReport — payload for GET /api/projects/:slug/drift.
// ────────────────────────────────────────────────────────────────────

export interface DriftWindow {
  start: string;
  end: string;
  days?: number;
  hours?: number;
}

export interface ProjectDriftReport {
  detected: DriftEntry[];
  baseline_window: { start: string; end: string; days: number };
  current_window: { start: string; end: string; hours: number };
  generated_at: string;
}

export function projectDriftReport(
  db: DB, projectId: number, now: Date,
): ProjectDriftReport {
  const currentStart = new Date(now.getTime() - CURRENT_HOURS * 3600_000).toISOString();
  const currentEnd = now.toISOString();
  const baselineEnd = currentStart;
  const baselineStart = new Date(now.getTime() - (BASELINE_DAYS + 1) * 24 * 3600_000).toISOString();
  return {
    detected: detectProjectDrift(db, projectId, now),
    baseline_window: { start: baselineStart, end: baselineEnd, days: BASELINE_DAYS },
    current_window: { start: currentStart, end: currentEnd, hours: CURRENT_HOURS },
    generated_at: currentEnd,
  };
}
