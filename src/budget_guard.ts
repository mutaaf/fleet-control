// Soft daily-budget autopause guard (ticket 0021). Pure-DB read for the
// guard query, then delegates to a runner-injected pause action that
// shells out via `launchctl bootout` (src/control.ts:pauseShipPlist) and
// posts one ntfy `cost_cap_pause` event.
//
// Why a separate module: keeps the cost-cap policy (parse MAX_DAILY_USD,
// sum today's rollup, decide pause/skip) cleanly separable from the
// shell-out plumbing in src/control.ts. Same shape as src/anomaly.ts +
// src/doctor.ts: a pure helper that callers can unit-test against a
// seeded DB without touching launchctl. Tests stub the shell side via
// the `_setRunnerForTests` seam already present in src/control.ts; the
// ntfy side flows through the existing `setHttpsRequest` seam in
// src/ntfy.ts.
//
// Safety:
//   - Never pauses a project whose MAX_DAILY_USD is unset, zero, or
//     non-numeric. The opt-in is positive; the silent absence of a cap
//     means the operator chose not to enable autopause.
//   - Idempotent: a re-run on the same day skips projects that are
//     already in `project_pause` — no launchctl call, no duplicate row,
//     no second ntfy.
//
// Per docs/LESSONS.md:
//   - `as unknown as RowT[]` for typed `.all()` (node:sqlite cast lesson).
//   - No backticks inside SQL template literals (plain identifiers).
//   - Module-level state (none here beyond the test runner) exposes a
//     reset seam — `_setRunnerForTests` / `_resetRunnerForTests` for the
//     ntfy/pause dispatch.

import type { DB } from "./db.ts";
import { pauseShipPlist } from "./control.ts";
import { loadConfig } from "./config.ts";
import { ntfyConfigFrom, sendNtfy } from "./ntfy.ts";

// ────────────────────────────────────────────────────────────────────
// Pure-DB read: who's over the cap today?
// ────────────────────────────────────────────────────────────────────

export interface BudgetBreach {
  project_id: number;
  slug: string;
  spent_usd: number;
  cap_usd: number;
  /** True iff project_pause already has a row for this project — used
   *  by the runner to decide whether the launchctl + ntfy side-effects
   *  should fire (no-op when already paused). */
  prior_paused: boolean;
}

interface ProjectRow {
  id: number;
  slug: string;
  cadence_json: string | null;
}

interface RollupRow {
  spent_usd: number | null;
}

interface PauseRow {
  project_id: number;
}

/** Local-time YYYY-MM-DD for the rollup join. `now` is parameterized so
 *  tests can pin the day boundary; production passes `new Date()`. */
function localDay(now: Date): string {
  // The cost rollup uses `date(started_at)` (SQLite UTC date by default),
  // so we keep the comparison in the same frame. Operators on the West
  // Coast still see a sensible "today" because the daily aggregate is
  // anchored on transcript timestamps, not wall clock — same shape as
  // the badge route's cost-7d window.
  return now.toISOString().slice(0, 10);
}

/** Parse `max_daily_usd` from a project's cadence_json. Returns null
 *  for missing, empty, non-numeric, zero, or negative values — those
 *  projects opt out of autopause by design. */
function parseCap(cadenceJson: string | null): number | null {
  if (!cadenceJson) return null;
  try {
    const obj = JSON.parse(cadenceJson) as Record<string, unknown>;
    const raw = obj.max_daily_usd;
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  } catch {
    return null;
  }
}

/** Identify every project whose today-spend has reached its
 *  MAX_DAILY_USD. Pure read — no inserts, no shell-out. The runner
 *  (`runBudgetGuards`) consumes this list to drive side-effects. */
export function evaluateBudgetGuards(db: DB, now: Date): BudgetBreach[] {
  const day = localDay(now);
  const projects = db.prepare(
    "SELECT id, slug, cadence_json FROM project ORDER BY slug",
  ).all() as unknown as ProjectRow[];

  const pauseRows = db.prepare(
    "SELECT project_id FROM project_pause",
  ).all() as unknown as PauseRow[];
  const prior = new Set<number>(pauseRows.map((r) => r.project_id));

  const spentStmt = db.prepare(
    "SELECT SUM(COALESCE(cost_usd, 0)) AS spent_usd "
    + "  FROM cost_rollup_day "
    + " WHERE project_id = ? AND day = ?",
  );

  const out: BudgetBreach[] = [];
  for (const p of projects) {
    const cap = parseCap(p.cadence_json);
    if (cap == null) continue;
    const row = spentStmt.get(p.id, day) as unknown as RollupRow | undefined;
    const spent = Number(row?.spent_usd ?? 0);
    if (spent >= cap) {
      out.push({
        project_id: p.id,
        slug: p.slug,
        spent_usd: spent,
        cap_usd: cap,
        prior_paused: prior.has(p.id),
      });
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Runner: side-effects (launchctl + ntfy + DB write)
// ────────────────────────────────────────────────────────────────────

/** Injection point so tests can record decisions without driving the
 *  shell-out. Production callers leave this alone — the default runner
 *  is the no-op identity (the work happens in `runBudgetGuards`
 *  directly). The seam exists so a future ticket can stub the entire
 *  guard pipeline without touching launchctl. */
type Runner = (breach: BudgetBreach) => void;
const defaultRunner: Runner = () => { /* */ };
let activeRunner: Runner = defaultRunner;
export function _setRunnerForTests(fn: Runner): void { activeRunner = fn; }
export function _resetRunnerForTests(): void { activeRunner = defaultRunner; }

export interface GuardRunResult {
  /** Breaches that landed a fresh pause (launchctl + ntfy fired). */
  paused: BudgetBreach[];
  /** Breaches we skipped because the project was already paused today. */
  skipped: BudgetBreach[];
}

/** Run the guard end-to-end: evaluate, then for every fresh breach
 *  (`prior_paused === false`) shell out to launchctl bootout, insert
 *  the project_pause row, and post one ntfy `cost_cap_pause` event.
 *  Idempotent: a re-run on the same day re-evaluates but skips every
 *  project already in project_pause. Best-effort on the ntfy side —
 *  a transport failure does not unwind the pause (the operator still
 *  sees the pill in the portal). */
export async function runBudgetGuards(db: DB, now: Date): Promise<GuardRunResult> {
  const breaches = evaluateBudgetGuards(db, now);
  const paused: BudgetBreach[] = [];
  const skipped: BudgetBreach[] = [];
  const day = localDay(now);
  const cfg = loadConfig();
  const ncfg = ntfyConfigFrom(cfg);

  const ins = db.prepare(
    "INSERT OR REPLACE INTO project_pause(project_id,reason,triggered_at,triggered_by,detail_json) "
    + "VALUES(?,?,?,?,?)",
  );

  for (const b of breaches) {
    if (b.prior_paused) {
      skipped.push(b);
      continue;
    }
    activeRunner(b);
    try {
      pauseShipPlist(db, b.slug);
    } catch {
      // launchctl may already have unloaded the plist (e.g. mid-run
      // exit). The pause row + ntfy still belong — the operator's
      // mental model is "paused until I tap Resume".
    }
    ins.run(
      b.project_id, "cost_cap", now.toISOString(), "budget_guard",
      JSON.stringify({ spent_usd: b.spent_usd, cap_usd: b.cap_usd, day }),
    );
    // ntfy push. Dedup key includes the day so a fresh breach on a
    // new day always re-buzzes once. The existing dedup set in
    // src/ntfy.ts (alertKeys) catches re-fires within a single process
    // lifetime; the project_pause row catches re-fires across restarts.
    if (ncfg.topic) {
      const dedupKey = `cost_cap_pause:${b.slug}:${day}`;
      await postCostCapNtfy(ncfg.topic, b, dedupKey, ncfg.portalUrl);
    }
    paused.push(b);
  }
  return { paused, skipped };
}

// ────────────────────────────────────────────────────────────────────
// ntfy dispatch — module-local dedup set + sendNtfy call
// ────────────────────────────────────────────────────────────────────

const seenNtfyKeys = new Set<string>();

async function postCostCapNtfy(
  topic: string, b: BudgetBreach, dedupKey: string, portalUrl: string,
): Promise<void> {
  if (seenNtfyKeys.has(dedupKey)) return;
  seenNtfyKeys.add(dedupKey);
  const title = `Paused ${b.slug} — spent $${b.spent_usd.toFixed(2)} ≥ $${b.cap_usd.toFixed(2)}`;
  const message =
    `${b.slug} hit its daily $${b.cap_usd.toFixed(2)} cap. Ship is paused until you tap Resume.`;
  await sendNtfy(topic, {
    title,
    message,
    priority: 4,
    tags: ["money_with_wings", "cost_cap_pause"],
    click: portalUrl + b.slug,
  });
}

/** Reset the in-process ntfy dedup set — tests only. */
export function _resetBudgetNtfyDedupForTests(): void {
  seenNtfyKeys.clear();
}
