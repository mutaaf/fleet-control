// Weekly "what shipped" digest (ticket 0012). Pure SQL + string templates;
// no LLM, no shell-out, no schema migrations. The helper returns a
// structured object the SPA banner and `fleetctl digest` markdown writer
// share. A small in-memory cache keyed by the period (start|end) saves a
// fistful of round-trips when the home banner re-renders on the 5s poll.
//
// Why all the figures live in one helper:
//   - The portal banner + the CLI markdown + (later) the ntfy weekly post
//     all want the SAME numbers and the SAME bullet phrasings. Centralising
//     them here means a phrasing tweak doesn't have to be ported to three
//     places, and the cache pays for every consumer at once.
//   - Every count is a single SELECT against an existing table. We do not
//     materialise a digest table; the data is cheap to recompute and the
//     ticket's "Out of scope" explicitly rules out new schema.
//
// Cache discipline (lessons from src/ntfy.ts and src/diff.ts):
//   - Module-level cache survives between tests, so we expose
//     `_resetDigestCacheForTests()` and a `_getDigestCacheBuildsForTests()`
//     counter. The leading underscore signals "test seam only".
//   - Cache miss recomputes everything and stamps `_buildCounter += 1`,
//     making the AC5 cache-hit test a single integer assertion.
import type { DB } from "./db.ts";

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface DigestPeriod {
  /** ISO date (yyyy-mm-dd) — inclusive lower bound of the window. */
  start: string;
  /** ISO date (yyyy-mm-dd) — exclusive upper bound. */
  end: string;
}

export interface DigestTotals {
  runs: number;
  /** Count of DISTINCT pr_number on shipped runs in the window. This is
   *  the operator-visible "PRs merged" number — it reflects auto-merged
   *  PRs (the agent-fleet normal path) AS WELL AS PRs the operator
   *  approved via the portal. See ticket 0019. */
  prs_merged: number;
  /** The audit-derived count (rows in control_audit with
   *  action='pr-merge', i.e. PRs the operator explicitly approved via
   *  the portal's "Approve & publish" button). Kept on the JSON object
   *  so a future ticket can split "via portal" vs "auto-merged". */
  prs_merged_via_portal: number;
  prs_sent_back: number;
  cost_usd: number;
  self_cancels: number;
  anomalies: number;
}

export interface DigestProject {
  slug: string;
  name: string;
  runs: number;
  /** Per-project version of DigestTotals.prs_merged — DISTINCT pr_number
   *  on shipped runs in the window, scoped to this project. */
  prs_merged: number;
  /** Per-project version of DigestTotals.prs_merged_via_portal. */
  prs_merged_via_portal: number;
  prs_sent_back: number;
  cost_usd: number;
  top_phase: string;
  /** Percent change in cost_usd vs the prior 7-day window, rounded to 1
   *  decimal. `null` when the prior window has zero cost (avoid
   *  divide-by-zero — the SPA renders "new this week" instead). */
  delta_cost_vs_prior_week_pct: number | null;
  /** Free-form notable strings (self-cancels, anomalies). Empty when
   *  nothing notable; the narrative bullets above the project blocks
   *  cover the headline phrases. */
  notable: string[];
}

export interface Digest {
  period: DigestPeriod;
  totals: DigestTotals;
  projects: DigestProject[];
  /** 3..7 plain-English bullets summarising the week. Built from a fixed
   *  template set — no LLM, no AI prose. */
  narrative: string[];
}

export interface DigestOptions {
  /** ISO timestamp used as "now" for windowing. Default: current wall
   *  clock. Tests pin this so seeded `started_at`/`ts` values bucket
   *  predictably. */
  now?: string;
  /** Bypass the cache for this call. Useful for the CLI which writes
   *  to disk: we don't want a stale 5-minute-old digest if the
   *  operator just merged a PR a second ago. */
  noCache?: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Cache (5-minute TTL per period). Module-level state — see top-of-file
// note about the `_reset*ForTests` seam.
// ────────────────────────────────────────────────────────────────────

/** 5 minutes — the home banner refreshes on the SPA's 5s poll, so the
 *  cache absorbs ~60 redundant calls per visit while staying fresh
 *  enough that a just-merged PR shows up in well under a minute. */
export const DIGEST_CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry { digest: Digest; expiresAt: number; }
const cache = new Map<string, CacheEntry>();
let buildCounter = 0;

export function _resetDigestCacheForTests(): void {
  cache.clear();
  buildCounter = 0;
}

export function _getDigestCacheBuildsForTests(): number {
  return buildCounter;
}

// ────────────────────────────────────────────────────────────────────
// Date math — pure stdlib. No deps; we use UTC everywhere so the
// digest reads the same on a CI runner in any timezone.
// ────────────────────────────────────────────────────────────────────

/** yyyy-mm-dd from a Date (UTC). */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Compute the [start, end) window for the digest given a wall-clock
 *  anchor. End is today (exclusive of in-progress day) and start is
 *  7 days before that. Same convention as the forecast helper. */
function computeWindow(now: Date): DigestPeriod {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 7);
  return { start: isoDate(start), end: isoDate(end) };
}

/** Prior window — same length as the current window, immediately
 *  preceding it. Used for the delta_cost_vs_prior_week_pct figure. */
function priorWindow(period: DigestPeriod): DigestPeriod {
  const end = new Date(period.start + "T00:00:00Z");
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 7);
  return { start: isoDate(start), end: isoDate(end) };
}

/** ISO-8601 week of a Date in `YYYY-Www` form (W zero-padded to 2
 *  digits). Used as the filename for `fleetctl digest --save`. Pure
 *  arithmetic — no Intl, no deps. The week containing the first
 *  Thursday of January is week 1. */
export function isoWeekKey(d: Date): string {
  // Copy and reset to UTC noon to avoid DST edges on the JS Date math.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday in current ISO week — getUTCDay: Sun=0..Sat=6, ISO uses Mon=1..Sun=7.
  const isoDay = (t.getUTCDay() + 6) % 7 + 1; // 1..7
  t.setUTCDate(t.getUTCDate() + 4 - isoDay);
  const year = t.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil((((t.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// ────────────────────────────────────────────────────────────────────
// SQL helpers — each returns a typed row set scoped to [start, end)
// for the given project (or fleet-wide).
// ────────────────────────────────────────────────────────────────────

interface ProjectRollupRow {
  id: number;
  slug: string;
  name: string;
  runs: number;
  cost_usd: number;
}

function projectRollup(db: DB, period: DigestPeriod): ProjectRollupRow[] {
  // datetime(d, 'start of day') vs date(started_at) for the range check —
  // we want [start, end) on the DATE, matching how the rollup table buckets.
  return db.prepare(
    "SELECT p.id AS id, p.slug AS slug, p.name AS name, "
    + "  COUNT(r.id) AS runs, "
    + "  SUM(COALESCE(r.cost_usd, r.cost_usd_computed, 0)) AS cost_usd "
    + "FROM project p LEFT JOIN run r "
    + "  ON r.project_id = p.id "
    + "  AND r.started_at IS NOT NULL "
    + "  AND date(r.started_at) >= ? AND date(r.started_at) < ? "
    + "GROUP BY p.id "
    + "ORDER BY cost_usd DESC, p.slug ASC",
  ).all(period.start, period.end) as unknown as ProjectRollupRow[];
}

interface PhaseCostRow { project_id: number; phase: string; cost_usd: number; }

function phaseCostsByProject(db: DB, period: DigestPeriod): Map<number, PhaseCostRow[]> {
  const rows = db.prepare(
    "SELECT project_id, phase, SUM(COALESCE(cost_usd, cost_usd_computed, 0)) AS cost_usd "
    + "FROM run "
    + "WHERE started_at IS NOT NULL "
    + "  AND date(started_at) >= ? AND date(started_at) < ? "
    + "GROUP BY project_id, phase "
    + "ORDER BY cost_usd DESC",
  ).all(period.start, period.end) as unknown as PhaseCostRow[];
  const byProject = new Map<number, PhaseCostRow[]>();
  for (const r of rows) {
    const list = byProject.get(r.project_id) ?? [];
    list.push(r);
    byProject.set(r.project_id, list);
  }
  return byProject;
}

interface SelfCancelRow { project_id: number; n: number; }

function selfCancelsByProject(db: DB, period: DigestPeriod): Map<number, number> {
  const rows = db.prepare(
    "SELECT project_id, COUNT(*) AS n FROM run "
    + "WHERE outcome = 'self-cancel' "
    + "  AND started_at IS NOT NULL "
    + "  AND date(started_at) >= ? AND date(started_at) < ? "
    + "GROUP BY project_id",
  ).all(period.start, period.end) as unknown as SelfCancelRow[];
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.project_id, r.n);
  return m;
}

interface AnomalyRow { project_id: number; n: number; }

function anomaliesByProject(db: DB, period: DigestPeriod): Map<number, number> {
  // anomaly.created_at carries a full timestamp; the run JOIN scopes
  // it to a project via the run row's project_id.
  const rows = db.prepare(
    "SELECT r.project_id AS project_id, COUNT(*) AS n "
    + "FROM anomaly a JOIN run r ON r.id = a.run_id "
    + "WHERE a.created_at IS NOT NULL "
    + "  AND date(a.created_at) >= ? AND date(a.created_at) < ? "
    + "GROUP BY r.project_id",
  ).all(period.start, period.end) as unknown as AnomalyRow[];
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.project_id, r.n);
  return m;
}

/** PR-merge / PR-changes counts per project, derived from control_audit
 *  rows. The audit `target` is "<slug>/<number>" for PR actions so we
 *  parse the leading slug. (We don't try to reconcile against the `pr`
 *  table — that's a snapshot of current state, not a historical event
 *  log; the audit table IS the per-week event log.)
 *
 *  Note (ticket 0019): the audit `merged` count is what we expose as
 *  `prs_merged_via_portal`. The operator-visible `prs_merged` figure
 *  uses `mergedRunsByProject()` instead — the audit table only records
 *  PRs the operator explicitly approved via the portal's button, so
 *  auto-merged agent PRs never landed here and the count read as 0
 *  even when GitHub showed dozens of merges. */
interface AuditRow { slug: string; action: string; n: number; }

function prActionsByProject(db: DB, period: DigestPeriod): Map<string, { merged_via_portal: number; sent_back: number }> {
  const rows = db.prepare(
    "SELECT substr(target, 1, instr(target, '/') - 1) AS slug, action, COUNT(*) AS n "
    + "FROM control_audit "
    + "WHERE action IN ('pr-merge', 'pr-changes') "
    + "  AND ts IS NOT NULL "
    + "  AND date(ts) >= ? AND date(ts) < ? "
    + "  AND instr(target, '/') > 0 "
    + "GROUP BY slug, action",
  ).all(period.start, period.end) as unknown as AuditRow[];
  const m = new Map<string, { merged_via_portal: number; sent_back: number }>();
  for (const r of rows) {
    const entry = m.get(r.slug) ?? { merged_via_portal: 0, sent_back: 0 };
    if (r.action === "pr-merge") entry.merged_via_portal += r.n;
    else if (r.action === "pr-changes") entry.sent_back += r.n;
    m.set(r.slug, entry);
  }
  return m;
}

/** Merged-PR counts per project, derived from the `run` table. We count
 *  DISTINCT pr_number among rows where outcome='shipped' AND pr_number
 *  IS NOT NULL — DISTINCT because the same PR can be touched by more
 *  than one run (e.g. a heal retry that lands on the same number), and
 *  we don't want re-runs to inflate the headline. Scoped to the digest
 *  window via started_at. Returns a Map keyed by project_id (the digest
 *  joins it onto the rollup row by id, since two projects can share a
 *  pr_number for their own repos). */
interface MergedRunsRow { project_id: number; n: number; }

export function mergedRunsByProject(db: DB, period: DigestPeriod): Map<number, number> {
  const rows = db.prepare(
    "SELECT project_id, COUNT(DISTINCT pr_number) AS n "
    + "FROM run "
    + "WHERE outcome = 'shipped' "
    + "  AND pr_number IS NOT NULL "
    + "  AND started_at IS NOT NULL "
    + "  AND date(started_at) >= ? AND date(started_at) < ? "
    + "GROUP BY project_id",
  ).all(period.start, period.end) as unknown as MergedRunsRow[];
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.project_id, Number(r.n) || 0);
  return m;
}

/** Cost in the prior window for one project (delta-vs-last-week math).
 *  Falls back to 0 if no rows. */
function priorCostFor(db: DB, projectId: number, prior: DigestPeriod): number {
  const row = db.prepare(
    "SELECT SUM(COALESCE(cost_usd, cost_usd_computed, 0)) AS c FROM run "
    + "WHERE project_id = ? "
    + "  AND started_at IS NOT NULL "
    + "  AND date(started_at) >= ? AND date(started_at) < ?",
  ).get(projectId, prior.start, prior.end) as { c: number | null } | undefined;
  return Number(row?.c ?? 0);
}

// ────────────────────────────────────────────────────────────────────
// Narrative templates — deterministic; no LLM.
//
// Per the ticket, the bullet shape is fixed:
//   "<slug> shipped <N> PRs"
//   "<slug> spent $<X>, ±<Y>% vs last week"
//   "<slug> self-cancelled <N> times — caught a runaway"
//   "<N> anomal{y|ies} flagged on <slug>"
//
// We emit at most ~7 bullets total (one of each kind, prioritising the
// highest-cost / most-active project). Each bullet is the EXACT string
// the ticket lists — the test pins this.
// ────────────────────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  return "$" + n.toFixed(2);
}

function buildNarrative(period: DigestPeriod, projects: DigestProject[]): string[] {
  const bullets: string[] = [];
  // PRs shipped — emit one bullet per project that merged ≥ 1 PR, capped
  // at 3 lines so the narrative stays scannable even on a busy week.
  const shippers = projects.filter((p) => p.prs_merged > 0).slice(0, 3);
  for (const p of shippers) {
    bullets.push(`${p.slug} shipped ${p.prs_merged} PR${p.prs_merged === 1 ? "" : "s"}`);
  }
  // Spend vs last week — only when both this-week cost > 0 AND we have a
  // delta (i.e. the prior window wasn't $0).
  const movers = projects.filter((p) => p.cost_usd > 0 && p.delta_cost_vs_prior_week_pct != null).slice(0, 2);
  for (const p of movers) {
    const delta = p.delta_cost_vs_prior_week_pct!;
    const sign = delta >= 0 ? "+" : "";
    bullets.push(`${p.slug} spent ${fmtUsd(p.cost_usd)}, ${sign}${delta.toFixed(1)}% vs last week`);
  }
  // Self-cancels — one bullet per project that self-cancelled.
  for (const p of projects) {
    const sc = p.notable.find((n) => n.startsWith("self-cancels:"));
    if (!sc) continue;
    const n = Number(sc.slice("self-cancels:".length));
    if (!Number.isFinite(n) || n <= 0) continue;
    bullets.push(`${p.slug} self-cancelled ${n} time${n === 1 ? "" : "s"} — caught a runaway`);
  }
  // Anomalies — singular/plural aware.
  for (const p of projects) {
    const an = p.notable.find((n) => n.startsWith("anomalies:"));
    if (!an) continue;
    const n = Number(an.slice("anomalies:".length));
    if (!Number.isFinite(n) || n <= 0) continue;
    bullets.push(`${n} anomal${n === 1 ? "y" : "ies"} flagged on ${p.slug}`);
  }
  // Floor: even a quiet week emits one line so the banner has copy.
  if (bullets.length === 0) {
    bullets.push(`Quiet week — no PRs merged, no anomalies between ${period.start} and ${period.end}`);
  }
  // Cap at 7. The ticket says 3–7; the floor above guarantees ≥ 1 in the
  // pathological case, and we never emit more than ~3+2+N(scs)+N(an).
  return bullets.slice(0, 7);
}

// ────────────────────────────────────────────────────────────────────
// Main helper
// ────────────────────────────────────────────────────────────────────

export function weeklyDigest(db: DB, opts: DigestOptions = {}): Digest {
  const now = opts.now ? new Date(opts.now) : new Date();
  const period = computeWindow(now);
  const cacheKey = period.start + "|" + period.end;

  if (!opts.noCache) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) return hit.digest;
  }

  const prior = priorWindow(period);

  // Per-project rollup (one row per known project, even zero-runs ones).
  const rollup = projectRollup(db, period);
  const phaseMap = phaseCostsByProject(db, period);
  const scMap = selfCancelsByProject(db, period);
  const anMap = anomaliesByProject(db, period);
  const prMap = prActionsByProject(db, period);
  const mergedRunsMap = mergedRunsByProject(db, period);

  const projects: DigestProject[] = [];
  for (const r of rollup) {
    const prior_cost = priorCostFor(db, r.id, prior);
    let delta: number | null = null;
    if (prior_cost > 0) {
      // 1-decimal rounding so the SPA doesn't render "+24.99999999%".
      delta = Math.round(((r.cost_usd - prior_cost) / prior_cost) * 1000) / 10;
    }
    const phases = phaseMap.get(r.id) ?? [];
    const top_phase = phases.length > 0 ? phases[0].phase : "";
    const sc = scMap.get(r.id) ?? 0;
    const an = anMap.get(r.id) ?? 0;
    const prCounts = prMap.get(r.slug) ?? { merged_via_portal: 0, sent_back: 0 };
    // Ticket 0019: prs_merged comes from the run table (DISTINCT
    // pr_number on shipped runs), keyed by project_id since two
    // different repos can share the same pr_number. The audit-derived
    // figure stays available as prs_merged_via_portal.
    const merged_from_runs = mergedRunsMap.get(r.id) ?? 0;
    const notable: string[] = [];
    if (sc > 0) notable.push(`self-cancels:${sc}`);
    if (an > 0) notable.push(`anomalies:${an}`);
    projects.push({
      slug: r.slug,
      name: r.name ?? r.slug,
      runs: r.runs,
      prs_merged: merged_from_runs,
      prs_merged_via_portal: prCounts.merged_via_portal,
      prs_sent_back: prCounts.sent_back,
      cost_usd: Number(r.cost_usd ?? 0),
      top_phase,
      delta_cost_vs_prior_week_pct: delta,
      notable,
    });
  }

  // Filter out zero-run projects from the array we report — quiet
  // projects shouldn't pad the digest. The rollup keeps them to compute
  // fleet-level "<N> projects ran" totals, so we sum before filtering.
  const totalRuns = projects.reduce((s, p) => s + p.runs, 0);
  const totalCost = projects.reduce((s, p) => s + p.cost_usd, 0);
  const totalSc = projects.reduce((s, p) => {
    const n = p.notable.find((x) => x.startsWith("self-cancels:"));
    return s + (n ? Number(n.slice("self-cancels:".length)) : 0);
  }, 0);
  const totalAn = projects.reduce((s, p) => {
    const n = p.notable.find((x) => x.startsWith("anomalies:"));
    return s + (n ? Number(n.slice("anomalies:".length)) : 0);
  }, 0);
  const totalPrMerged = projects.reduce((s, p) => s + p.prs_merged, 0);
  const totalPrMergedViaPortal = projects.reduce((s, p) => s + p.prs_merged_via_portal, 0);
  const totalPrSentBack = projects.reduce((s, p) => s + p.prs_sent_back, 0);

  const visibleProjects = projects.filter(
    (p) => p.runs > 0 || p.prs_merged > 0 || p.prs_merged_via_portal > 0 || p.prs_sent_back > 0,
  );

  const totals: DigestTotals = {
    runs: totalRuns,
    prs_merged: totalPrMerged,
    prs_merged_via_portal: totalPrMergedViaPortal,
    prs_sent_back: totalPrSentBack,
    cost_usd: totalCost,
    self_cancels: totalSc,
    anomalies: totalAn,
  };

  const narrative = buildNarrative(period, visibleProjects);

  const digest: Digest = { period, totals, projects: visibleProjects, narrative };

  cache.set(cacheKey, { digest, expiresAt: Date.now() + DIGEST_CACHE_TTL_MS });
  buildCounter += 1;
  return digest;
}

// ────────────────────────────────────────────────────────────────────
// Markdown rendering — stable, diff-clean.
//
// Shape:
//   # Weekly digest <start> → <end>
//
//   **Totals** · runs: N · PRs merged: N · PRs sent back: N · $X.XX · self-cancels: N · anomalies: N
//
//   ## <slug>
//
//   - runs: N
//   - PRs merged: N (sent back: N)
//   - cost: $X.XX (top phase: <phase>)
//   - vs last week: ±Y% (or "new this week")
//
//   ## Narrative
//
//   - bullet 1
//   - bullet 2
//   ...
//
// No trailing whitespace; ends with exactly one newline.
// ────────────────────────────────────────────────────────────────────

export function renderDigestMarkdown(d: Digest): string {
  const lines: string[] = [];
  lines.push(`# Weekly digest ${d.period.start} → ${d.period.end}`);
  lines.push("");
  const tParts = [
    `runs: ${d.totals.runs}`,
    `PRs merged: ${d.totals.prs_merged}`,
    `PRs sent back: ${d.totals.prs_sent_back}`,
    fmtUsd(d.totals.cost_usd),
    `self-cancels: ${d.totals.self_cancels}`,
    `anomalies: ${d.totals.anomalies}`,
  ];
  lines.push(`**Totals** · ${tParts.join(" · ")}`);
  lines.push("");

  for (const p of d.projects) {
    lines.push(`## ${p.slug}`);
    lines.push("");
    lines.push(`- runs: ${p.runs}`);
    lines.push(`- PRs merged: ${p.prs_merged} (sent back: ${p.prs_sent_back})`);
    const topPhaseSuffix = p.top_phase ? ` (top phase: ${p.top_phase})` : "";
    lines.push(`- cost: ${fmtUsd(p.cost_usd)}${topPhaseSuffix}`);
    if (p.delta_cost_vs_prior_week_pct == null) {
      lines.push(`- vs last week: new this week`);
    } else {
      const sign = p.delta_cost_vs_prior_week_pct >= 0 ? "+" : "";
      lines.push(`- vs last week: ${sign}${p.delta_cost_vs_prior_week_pct.toFixed(1)}%`);
    }
    lines.push("");
  }

  lines.push(`## Narrative`);
  lines.push("");
  for (const b of d.narrative) lines.push(`- ${b}`);
  lines.push("");

  // Stitch with `\n`, then ensure the result ends in EXACTLY one newline
  // and carries no trailing-whitespace lines (each `lines.push("")` adds
  // a blank line, never a space-padded one).
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}
