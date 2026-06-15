// Ticket 0062 — Monthly fleet retro card.
//
// One compact home-page card on the first weekday of each calendar
// month that surfaces five month-over-month deltas (PRs shipped,
// spend, $/PR, heal-attempt avg, best & laggard project sentences)
// computed deterministically from existing telemetry. No LLM call.
// No new schema. Pure composition over pr / cost_rollup_day / project.
//
// PRODUCER-VS-SPEC NOTE (LESSONS 2026-06-05 + 2026-06-10):
//   - src/ingest/prs.ts:188 hardcodes pr.state = 'open' (lowercase)
//     for open rows; closed/merged rows write the gh state verbatim
//     ('CLOSED' / 'MERGED' uppercase). EVERY merged-PR reader in
//     src/views.ts and src/receipts.ts uses pr.state = 'MERGED'.
//     This helper matches.
//   - src/db.ts:352 declares pr.heal_attempts INTEGER DEFAULT 0; the
//     SELECT COALESCEs to 0 defensively for any pre-0023 rows that
//     might predate the column. AVG over INTEGER returns REAL in
//     sqlite — no float roundtrip concerns at the day-grain we care
//     about.
//   - src/receipts.ts:127-138 groups by month via LEX-COMPARABLE
//     monthStart / monthEnd ISO ranges over pr.fetched_at (no
//     strftime — the column is TEXT ISO8601 and a 'YYYY-MM-DDT...'
//     literal is lex-comparable). This helper reuses the same shape
//     for the May vs June comparison.
//
// LESSONS hygiene applied:
//   - 2026-05-29 time-pinned: every comparison takes the caller's
//     `now: Date`; no `new Date()` inside the helper. Tests pin
//     `now` and seed timestamps anchored to it.
//   - 2026-06-07 the pr table has no surrogate id: the cache
//     invalidation tuple (in src/server.ts) uses (MAX(fetched_at),
//     COUNT(*)) over pr — NEVER MAX(id).
//   - 2026-06-13 per-candidate fixtures must also clear the global
//     empty-fleet gate: the helper enforces the 8-distinct-trailing-
//     weeks-of-merged-PR-data gate BEFORE evaluating the per-
//     comparison logic.
//   - 2026-06-13 function-import cycle: src/retro.ts imports ONLY
//     from src/db.ts (types). It does NOT import from src/views.ts,
//     and src/views.ts does NOT import from src/retro.ts. Consumers
//     (src/server.ts, tests) go to src/retro.ts directly.
//   - 2026-05-26 no backticks inside template-literal SQL strings:
//     every SQL string in this file is plain double-quoted
//     concatenation, never a backtick template.

import type { DB } from "./db.ts";

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

/** The card payload returned when the helper has enough data to
 *  compose a month-over-month comparison. month_iso names the
 *  COMPLETED prior calendar month (i.e. June when now is July 1). */
export interface MonthlyRetroPayload {
  month_iso: string;
  prs_this_month: number;
  prs_last_month: number;
  /** Integer-rounded percent delta (+33 means up 33%). Null when the
   *  last-month denominator is zero — the renderer surfaces a "no
   *  comparison" framing instead of dividing by infinity. */
  prs_delta_pct: number | null;
  spend_this_month: number;
  spend_last_month: number;
  spend_delta_pct: number | null;
  cost_per_pr_this: number;
  cost_per_pr_last: number;
  cost_per_pr_delta_pct: number | null;
  heal_avg_this: number;
  heal_avg_last: number;
  /** Best project sentence: "<slug> shipped 2x its trailing baseline
   *  this month". Pre-computed prose so the renderer is a pure
   *  string-interpolator. */
  best_project_sentence: string;
  /** Laggard project sentence: "<slug> shipped 0 this month after
   *  averaging 3". */
  laggard_project_sentence: string;
}

export type MonthlyRetroResult =
  | { kind: "card"; payload: MonthlyRetroPayload }
  | { kind: "warming-up" }
  | { kind: "first-full-month" };

// ────────────────────────────────────────────────────────────────────
// isMonthlyRetroDay — pure-function gate
// ────────────────────────────────────────────────────────────────────

/** Returns true when `now` falls on the first Monday-Friday of the
 *  calendar month. The gate slides past Saturday + Sunday so an
 *  August whose 1st lands on a Saturday fires on Monday 2026-08-03
 *  instead. Pure function — no DB, no I/O.
 *
 *  UTC weekday convention: 0 = Sunday, 1 = Monday, ..., 6 = Saturday.
 *  We compute the first weekday of the month by walking from day 1
 *  forward until we hit a Monday-Friday slot, then assert `now`'s
 *  UTC day-of-month matches. The gate is intentionally STRICT — it
 *  fires on a single day each month so the operator sees the card
 *  once and never again until next month. */
export function isMonthlyRetroDay(now: Date): boolean {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed
  // Walk from day 1 forward to find the first weekday slot.
  for (let day = 1; day <= 7; day++) {
    const candidate = new Date(Date.UTC(y, m, day));
    const dow = candidate.getUTCDay(); // 0..6
    if (dow >= 1 && dow <= 5) {
      // First weekday found. Compare to `now`'s UTC day-of-month.
      return now.getUTCDate() === day;
    }
  }
  // Unreachable — any 7-day prefix of a calendar month contains at
  // least one Mon-Fri slot. Defensive return.
  return false;
}

// ────────────────────────────────────────────────────────────────────
// Month arithmetic
// ────────────────────────────────────────────────────────────────────

/** YYYY-MM key for a Date (UTC). */
function monthIso(d: Date): string {
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
}

/** Take an ISO month key ("2026-06") + a delta (negative for prior
 *  months) and return the YYYY-MM of the result. */
function shiftMonth(iso: string, delta: number): string {
  const [y, m] = iso.split("-").map(Number);
  // m is 1..12; convert to absolute month count, shift, convert back.
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return ny + "-" + String(nm).padStart(2, "0");
}

/** First-of-month UTC midnight ISO timestamp for "YYYY-MM". */
function monthStartIso(iso: string): string {
  return iso + "-01T00:00:00.000Z";
}

/** First-of-next-month UTC midnight ISO timestamp. */
function monthEndIso(iso: string): string {
  return monthStartIso(shiftMonth(iso, 1));
}

/** Human-readable label ("June 2026") for an ISO month key. Pure
 *  formatting, no locale lookup so the label is stable across
 *  machines. Used by the renderer; lives here so the helper output
 *  is self-contained. */
export function monthLabelFor(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const names = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return (names[m - 1] ?? iso) + " " + y;
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers (delta math)
// ────────────────────────────────────────────────────────────────────

/** Integer-rounded percent delta. Returns null when prev is 0
 *  (preserves the renderer's "no comparison" framing per the AC4
 *  zero-denominator edge case). */
function pctDelta(cur: number, prev: number): number | null {
  if (prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

// ────────────────────────────────────────────────────────────────────
// SQL helpers
// ────────────────────────────────────────────────────────────────────

interface CountRow { n: number | null }
interface SumRow { s: number | null }
interface HealSumRow { sum_heals: number | null; n: number | null }

/** Count of MERGED PRs whose fetched_at falls inside the [start, end)
 *  half-open ISO range. PRODUCER-VS-SPEC: state literal is 'MERGED'
 *  uppercase per src/ingest/prs.ts. */
function countMergedInMonth(db: DB, projectId: number | null, monthKey: string): number {
  const start = monthStartIso(monthKey);
  const end = monthEndIso(monthKey);
  const sql = projectId == null
    ? "SELECT COUNT(*) AS n FROM pr"
      + " WHERE state = 'MERGED'"
      + "   AND fetched_at IS NOT NULL"
      + "   AND fetched_at >= ? AND fetched_at < ?"
    : "SELECT COUNT(*) AS n FROM pr"
      + " WHERE state = 'MERGED'"
      + "   AND project_id = ?"
      + "   AND fetched_at IS NOT NULL"
      + "   AND fetched_at >= ? AND fetched_at < ?";
  const row = projectId == null
    ? db.prepare(sql).get(start, end) as unknown as CountRow | undefined
    : db.prepare(sql).get(projectId, start, end) as unknown as CountRow | undefined;
  return Number(row?.n ?? 0);
}

/** Sum cost_rollup_day.cost_usd for the month. `day` is TEXT
 *  YYYY-MM-DD and lex-comparable; the prefix range works without
 *  julianday roundtrips. */
function spendInMonth(db: DB, projectId: number | null, monthKey: string): number {
  const startDay = monthKey + "-01";
  const endDay = shiftMonth(monthKey, 1) + "-01";
  const sql = projectId == null
    ? "SELECT SUM(COALESCE(cost_usd, 0)) AS s FROM cost_rollup_day"
      + " WHERE day >= ? AND day < ?"
    : "SELECT SUM(COALESCE(cost_usd, 0)) AS s FROM cost_rollup_day"
      + " WHERE project_id = ? AND day >= ? AND day < ?";
  const row = projectId == null
    ? db.prepare(sql).get(startDay, endDay) as unknown as SumRow | undefined
    : db.prepare(sql).get(projectId, startDay, endDay) as unknown as SumRow | undefined;
  return Number(row?.s ?? 0);
}

/** Mean of pr.heal_attempts over MERGED PRs in the month. Returns 0
 *  when the month has zero merged PRs (so the delta-math is well
 *  defined even on a deserted month). */
function healAvgInMonth(db: DB, monthKey: string): number {
  const start = monthStartIso(monthKey);
  const end = monthEndIso(monthKey);
  const row = db.prepare(
    "SELECT SUM(COALESCE(heal_attempts, 0)) AS sum_heals, COUNT(*) AS n FROM pr"
    + " WHERE state = 'MERGED'"
    + "   AND fetched_at IS NOT NULL"
    + "   AND fetched_at >= ? AND fetched_at < ?",
  ).get(start, end) as unknown as HealSumRow | undefined;
  const n = Number(row?.n ?? 0);
  if (n === 0) return 0;
  return Number(row?.sum_heals ?? 0) / n;
}

interface DistinctWeeksRow { c: number | null }

/** Global empty-fleet gate: count DISTINCT ISO weeks present in
 *  pr.fetched_at across MERGED rows. The card renders "warming up"
 *  when this count is < 8. Matches the 0059 biggest-surprise gate
 *  shape (LESSONS 2026-06-13). */
function distinctTrailingMergedWeeks(db: DB): number {
  const row = db.prepare(
    "SELECT COUNT(DISTINCT strftime('%Y-%W', date(fetched_at))) AS c"
    + "  FROM pr"
    + " WHERE state = 'MERGED'"
    + "   AND fetched_at IS NOT NULL",
  ).get() as unknown as DistinctWeeksRow | undefined;
  return Number(row?.c ?? 0);
}

interface PriorMonthRow { m: string; n: number | null }

/** Threshold for considering a calendar month a "full" month (i.e.
 *  one whose merged-PR count is meaningful enough to be the anchor
 *  of a month-over-month comparison). The first-full-month branch
 *  fires when `thisMonth` is the first full month chronologically;
 *  partial fringe rows in earlier months are tolerated but don't
 *  unlock the comparison. */
const MIN_FULL_MONTH_PRS = 3;

/** Return the per-month merged-PR counts, ordered by month key
 *  ASCENDING. Used by the first-full-month gate to find the first
 *  calendar month that crossed MIN_FULL_MONTH_PRS. */
function monthCounts(db: DB): Array<{ m: string; n: number }> {
  // We use strftime('%Y-%m', date(fetched_at)) to bucket by calendar
  // month. date(fetched_at) strips the time component; strftime
  // emits the canonical YYYY-MM string. Plain SQL — no julianday()
  // roundtrip.
  const rows = db.prepare(
    "SELECT strftime('%Y-%m', date(fetched_at)) AS m, COUNT(*) AS n"
    + "  FROM pr"
    + " WHERE state = 'MERGED'"
    + "   AND fetched_at IS NOT NULL"
    + " GROUP BY m"
    + " ORDER BY m ASC",
  ).all() as unknown as PriorMonthRow[];
  return rows.map((r) => ({ m: String(r.m ?? ""), n: Number(r.n ?? 0) }));
}

// ────────────────────────────────────────────────────────────────────
// Best & laggard projects
// ────────────────────────────────────────────────────────────────────

interface ProjectRow { id: number; slug: string }
interface PerProjectCountRow { project_id: number; n: number | null }

/** Per-project merged-PR counts for a single month. */
function perProjectMonthCounts(db: DB, monthKey: string): Map<number, number> {
  const start = monthStartIso(monthKey);
  const end = monthEndIso(monthKey);
  const rows = db.prepare(
    "SELECT project_id, COUNT(*) AS n FROM pr"
    + " WHERE state = 'MERGED'"
    + "   AND fetched_at IS NOT NULL"
    + "   AND fetched_at >= ? AND fetched_at < ?"
    + " GROUP BY project_id",
  ).all(start, end) as unknown as PerProjectCountRow[];
  const m = new Map<number, number>();
  for (const r of rows) m.set(Number(r.project_id), Number(r.n ?? 0));
  return m;
}

interface BestLaggard {
  best: string;          // sentence
  laggard: string;       // sentence
}

/** Pick the single best and single laggard project for the month.
 *  Best = largest ratio of (this month count / trailing 3-month
 *  median) across projects that have data in all THREE prior
 *  calendar months. Laggard = smallest ratio under the same
 *  eligibility rule, or "shipped 0 this month after averaging N"
 *  when the project shipped zero. Tie-break: slug alphabetical.
 *
 *  Projects with < 3 prior months of data are EXCLUDED from the
 *  pool per AC5; if neither pool has eligible members the helper
 *  falls back to a "newest project" sentence. */
function pickBestAndLaggard(
  db: DB, monthKey: string,
): BestLaggard {
  const projects = db.prepare(
    "SELECT id, slug FROM project ORDER BY slug",
  ).all() as unknown as ProjectRow[];

  // Counts for this month + the trailing three months.
  const thisCounts = perProjectMonthCounts(db, monthKey);
  const m1 = perProjectMonthCounts(db, shiftMonth(monthKey, -1));
  const m2 = perProjectMonthCounts(db, shiftMonth(monthKey, -2));
  const m3 = perProjectMonthCounts(db, shiftMonth(monthKey, -3));

  interface Candidate {
    slug: string;
    thisCount: number;
    baselineMedian: number;
    ratio: number; // thisCount / max(baselineMedian, 1)
  }
  const eligible: Candidate[] = [];
  for (const p of projects) {
    const c1 = m1.get(p.id) ?? 0;
    const c2 = m2.get(p.id) ?? 0;
    const c3 = m3.get(p.id) ?? 0;
    // Eligibility: each of the three prior months had data. We use
    // "non-zero in each" as the "had data" signal — a project with a
    // zero shipped month is genuinely a laggard candidate only when
    // it had recent baseline activity. Per AC5 < 3 prior months of
    // data → excluded.
    if (c1 === 0 || c2 === 0 || c3 === 0) continue;
    const sorted = [c1, c2, c3].sort((a, b) => a - b);
    const baseline = sorted[1]; // 3-element median
    const thisCount = thisCounts.get(p.id) ?? 0;
    const ratio = thisCount / Math.max(baseline, 1);
    eligible.push({
      slug: p.slug, thisCount, baselineMedian: baseline, ratio,
    });
  }

  if (eligible.length === 0) {
    // Fallback per AC5: name the "newest project" (most recent
    // first_seen_at OR slug-alphabetical newest). We pick the first
    // project ordered by slug DESC as a deterministic fallback.
    const newest = [...projects].sort((a, b) => b.slug.localeCompare(a.slug))[0];
    const slug = newest?.slug ?? "fleet";
    return {
      best: "newest project: " + slug,
      laggard: "newest project: " + slug,
    };
  }

  // Best: largest ratio, slug-alphabetical tie-break.
  const byBest = [...eligible].sort((a, b) => {
    if (b.ratio !== a.ratio) return b.ratio - a.ratio;
    return a.slug.localeCompare(b.slug);
  });
  const best = byBest[0];
  // Laggard: smallest ratio, slug-alphabetical tie-break.
  const byLaggard = [...eligible].sort((a, b) => {
    if (a.ratio !== b.ratio) return a.ratio - b.ratio;
    return a.slug.localeCompare(b.slug);
  });
  const laggard = byLaggard[0];

  const bestRatioRounded = (Math.round(best.ratio * 10) / 10).toFixed(1);
  const bestSentence = best.thisCount === 0
    ? best.slug + " held flat this month after averaging " + best.baselineMedian + " over the trailing 3 months"
    : best.slug + " shipped " + bestRatioRounded + "x its trailing baseline this month";

  const laggardSentence = laggard.thisCount === 0
    ? laggard.slug + " shipped 0 this month after averaging " + laggard.baselineMedian
    : laggard.slug + " shipped " + laggard.thisCount + " this month after averaging " + laggard.baselineMedian;

  return { best: bestSentence, laggard: laggardSentence };
}

// ────────────────────────────────────────────────────────────────────
// monthlyRetroCard — main composer
// ────────────────────────────────────────────────────────────────────

/** Compose the monthly retro card payload for the COMPLETED prior
 *  calendar month relative to `now`. Returns one of three kinds:
 *    - 'warming-up' when the fleet has < 8 distinct trailing weeks
 *      of merged-PR data.
 *    - 'first-full-month' when the gate passes but no PRIOR full
 *      calendar month of data exists (only the completed month
 *      itself has data).
 *    - 'card' with the documented payload otherwise. */
export function monthlyRetroCard(db: DB, now: Date): MonthlyRetroResult {
  // The COMPLETED prior calendar month relative to `now`.
  // When now = 2026-07-01 → thisMonth = 2026-06; lastMonth = 2026-05.
  const nowMonth = monthIso(now);
  const thisMonth = shiftMonth(nowMonth, -1);
  const lastMonth = shiftMonth(thisMonth, -1);

  // ── Global empty-fleet gate ─────────────────────────────────────
  // Counts DISTINCT ISO weeks of merged PR data across all time.
  // < 8 means the fleet hasn't shipped enough to draw conclusions
  // yet — render the "warming up" honest empty state.
  if (distinctTrailingMergedWeeks(db) < 8) {
    return { kind: "warming-up" };
  }

  // ── First-full-month gate ───────────────────────────────────────
  // A month is "full" when it carries >= MIN_FULL_MONTH_PRS merged
  // PRs — the threshold separates an active month from a fringe
  // straggler row. The discriminator between 'first-full-month' and
  // the card's zero-denominator framing (AC4) is:
  //   - first-full-month: the fleet's FIRST full calendar month
  //     (chronologically) is `thisMonth` itself. There's no prior
  //     full month to anchor the comparison; the renderer surfaces
  //     "first full month - we'll have a comparison next month".
  //   - card with zero-denominator: an EARLIER full month exists
  //     (so the fleet has matured) but `lastMonth` itself happens
  //     to be a dry month. The renderer surfaces a "no comparison
  //     - last month had 0 PRs" framing on the affected deltas
  //     while keeping the rest of the card alive.
  const monthly = monthCounts(db);
  let firstFullMonth: string | null = null;
  for (const r of monthly) {
    if (r.n >= MIN_FULL_MONTH_PRS) { firstFullMonth = r.m; break; }
  }
  if (firstFullMonth == null || firstFullMonth >= thisMonth) {
    return { kind: "first-full-month" };
  }

  // ── Compose the five comparisons ─────────────────────────────────
  const prsThis = countMergedInMonth(db, null, thisMonth);
  const prsLast = countMergedInMonth(db, null, lastMonth);
  const spendThis = spendInMonth(db, null, thisMonth);
  const spendLast = spendInMonth(db, null, lastMonth);
  const cppThis = prsThis > 0 ? spendThis / prsThis : 0;
  const cppLast = prsLast > 0 ? spendLast / prsLast : 0;
  const healThis = healAvgInMonth(db, thisMonth);
  const healLast = healAvgInMonth(db, lastMonth);
  const bl = pickBestAndLaggard(db, thisMonth);

  const payload: MonthlyRetroPayload = {
    month_iso: thisMonth,
    prs_this_month: prsThis,
    prs_last_month: prsLast,
    prs_delta_pct: pctDelta(prsThis, prsLast),
    spend_this_month: round2(spendThis),
    spend_last_month: round2(spendLast),
    spend_delta_pct: pctDelta(spendThis, spendLast),
    cost_per_pr_this: round2(cppThis),
    cost_per_pr_last: round2(cppLast),
    cost_per_pr_delta_pct: pctDelta(cppThis, cppLast),
    heal_avg_this: round2(healThis),
    heal_avg_last: round2(healLast),
    best_project_sentence: bl.best,
    laggard_project_sentence: bl.laggard,
  };
  return { kind: "card", payload };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
