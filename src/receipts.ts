// Public monthly fleet-receipts (ticket 0041).
//
// The operator runs `fleetctl receipts publish <slug> <month>` (or taps
// the portal's publish button), which freezes the four-stat snapshot
// into the `receipts_published` table keyed by (project_slug,
// month_iso). The public URL `/receipts/<slug>/<YYYY-MM>` is
// unauthenticated and reads the frozen payload back — never re-derives
// from runs at read time, so a published artifact is immutable even if
// the underlying transcripts are garbage-collected later.
//
// Compute path (used at publish time only):
//   - Walks `cost_rollup_day` for the month's total spend.
//   - Walks `pr WHERE state = 'MERGED'` for the month's merged count.
//   - Walks `pr WHERE state = 'open' AND ci_state = 'red'` to count
//     distinct dates the project had at least one failing open PR.
//   - For fleet-wide receipts (slug === "fleet"), derives the top
//     mover as the project with the largest month-over-month delta
//     in merged_prs.
//
// PRODUCER-VS-SPEC NOTE (LESSONS 2026-06-05 § "groomer prose can
// disagree with the schema; the schema wins"):
//   - src/ingest/prs.ts:164 writes pr.state = 'open' LOWERCASE for
//     open PRs, and ciState() returns 'red'/'pending'/'green'/'none'
//     LOWERCASE for the rollup status.
//   - The existing views in src/views.ts use pr.state = 'MERGED'
//     UPPER-CASE for merged PRs (lines 706, 1925, 2213, 2257, 3466).
//   - This module matches the production casing exactly.
//
// HTML page is server-rendered single-column, NO <script> tag (so it
// works on a flaky cellular connection and survives a screenshot of
// the URL bar), NO references to /api/... (the page is read-only by
// construction), NO github.com anchors other than the fleet-control
// footer (the operator's own repo URL never leaks).
//
// Zero new runtime deps; node:sqlite + plain string templates.

import type { DB } from "./db.ts";

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

/** The frozen monthly receipts payload. found=true on every read of
 *  a published row; receiptsFor() returns null (not found=false) when
 *  the row is missing — the route translates that null to a 404. */
export interface ReceiptsPayload {
  found: true;
  project_slug: string;
  project_label: string;
  month_iso: string;
  month_label: string;
  merged_prs: number;
  total_spend_usd: number;
  cost_per_pr_usd: number | null;
  red_days: number;
  /** Fleet-wide receipts surface a top-mover; per-project receipts
   *  always carry null here. */
  top_mover: { slug: string; delta_prs: number } | null;
  generated_at: string;
}

export interface ServeReceiptsResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// ────────────────────────────────────────────────────────────────────
// Compute (publish-time)
// ────────────────────────────────────────────────────────────────────

interface CountRow { n: number }
interface SpendRow { spent: number | null }
interface RedDayRow { d: string }
interface MergedByProjectRow { slug: string; n: number }

/** First-of-month UTC midnight for an ISO month string ("2026-05"). */
function monthStart(monthIso: string): string {
  return `${monthIso}-01T00:00:00.000Z`;
}

/** First-of-next-month UTC midnight. */
function monthEnd(monthIso: string): string {
  const [y, m] = monthIso.split("-").map((n) => Number(n));
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return `${nextY}-${String(nextM).padStart(2, "0")}-01T00:00:00.000Z`;
}

/** First-of-previous-month UTC midnight. Used by the fleet-wide
 *  top-mover delta. */
function monthPrev(monthIso: string): string {
  const [y, m] = monthIso.split("-").map((n) => Number(n));
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  return `${prevY}-${String(prevM).padStart(2, "0")}`;
}

/** "2026-05" → "May 2026". Pure formatting, no locale lookup so the
 *  label is stable across machines. */
function monthLabel(monthIso: string): string {
  const [y, m] = monthIso.split("-").map((n) => Number(n));
  const names = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  return `${names[m - 1] ?? monthIso} ${y}`;
}

/** Sum cost_rollup_day rows whose `day` (YYYY-MM-DD) falls inside the
 *  month. `day` is lex-comparable so a prefix range works without
 *  julianday(). */
function sumSpend(db: DB, projectId: number | null, monthIso: string): number {
  const start = `${monthIso}-01`;
  const end = `${monthEnd(monthIso).slice(0, 10)}`;
  const sql = projectId == null
    ? "SELECT SUM(COALESCE(cost_usd, 0)) AS spent FROM cost_rollup_day"
      + " WHERE day >= ? AND day < ?"
    : "SELECT SUM(COALESCE(cost_usd, 0)) AS spent FROM cost_rollup_day"
      + " WHERE project_id = ? AND day >= ? AND day < ?";
  const row = projectId == null
    ? db.prepare(sql).get(start, end) as unknown as SpendRow
    : db.prepare(sql).get(projectId, start, end) as unknown as SpendRow;
  return Number(row?.spent ?? 0);
}

/** Count MERGED PRs whose fetched_at falls inside the month. */
function countMerged(db: DB, projectId: number | null, monthIso: string): number {
  const start = monthStart(monthIso);
  const end = monthEnd(monthIso);
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
    ? db.prepare(sql).get(start, end) as unknown as CountRow
    : db.prepare(sql).get(projectId, start, end) as unknown as CountRow;
  return Number(row?.n ?? 0);
}

/** Count DISTINCT days inside the month where the project had at
 *  least one open PR with ci_state='red'. */
function countRedDays(db: DB, projectId: number | null, monthIso: string): number {
  const start = monthStart(monthIso);
  const end = monthEnd(monthIso);
  const sql = projectId == null
    ? "SELECT DISTINCT date(fetched_at) AS d FROM pr"
      + " WHERE state = 'open' AND ci_state = 'red'"
      + "   AND fetched_at IS NOT NULL"
      + "   AND fetched_at >= ? AND fetched_at < ?"
    : "SELECT DISTINCT date(fetched_at) AS d FROM pr"
      + " WHERE project_id = ?"
      + "   AND state = 'open' AND ci_state = 'red'"
      + "   AND fetched_at IS NOT NULL"
      + "   AND fetched_at >= ? AND fetched_at < ?";
  const rows = projectId == null
    ? db.prepare(sql).all(start, end) as unknown as RedDayRow[]
    : db.prepare(sql).all(projectId, start, end) as unknown as RedDayRow[];
  return rows.length;
}

/** Per-project merged-PR counts for the month (fleet-wide aggregation). */
function mergedByProject(db: DB, monthIso: string): MergedByProjectRow[] {
  const start = monthStart(monthIso);
  const end = monthEnd(monthIso);
  return db.prepare(
    "SELECT p.slug AS slug, COUNT(pr.number) AS n"
    + "  FROM project p"
    + "  LEFT JOIN pr ON pr.project_id = p.id"
    + "       AND pr.state = 'MERGED'"
    + "       AND pr.fetched_at IS NOT NULL"
    + "       AND pr.fetched_at >= ? AND pr.fetched_at < ?"
    + " GROUP BY p.slug",
  ).all(start, end) as unknown as MergedByProjectRow[];
}

/** Fleet-wide top-mover: largest month-over-month delta in merged_prs.
 *  Returns null when no project has a positive delta (every project
 *  shipped the same or fewer than the prior month). */
function topMover(db: DB, monthIso: string): { slug: string; delta_prs: number } | null {
  const current = mergedByProject(db, monthIso);
  const prior = mergedByProject(db, monthPrev(monthIso));
  const priorMap = new Map<string, number>();
  for (const r of prior) priorMap.set(r.slug, Number(r.n));
  let bestSlug: string | null = null;
  let bestDelta = 0;
  for (const r of current) {
    const cur = Number(r.n);
    const prev = priorMap.get(r.slug) ?? 0;
    const delta = cur - prev;
    if (delta > bestDelta) {
      bestDelta = delta;
      bestSlug = r.slug;
    }
  }
  if (bestSlug == null || bestDelta <= 0) return null;
  return { slug: bestSlug, delta_prs: bestDelta };
}

/** Compute the four stats for a (slug, month) tuple. Always returns
 *  a payload with found=true — callers gate write-side decisions on
 *  validation upstream. The slug `"fleet"` aggregates across every
 *  project. */
export function computeReceipts(
  db: DB,
  projectSlug: string,
  monthIso: string,
  now: Date,
): ReceiptsPayload {
  const isFleet = projectSlug === "fleet";
  let projectId: number | null = null;
  let projectLabel = projectSlug;
  if (!isFleet) {
    const row = db.prepare("SELECT id, name FROM project WHERE slug = ?")
      .get(projectSlug) as { id: number; name: string | null } | undefined;
    if (!row) {
      // Caller (publish handler) is expected to validate slug existence
      // before calling computeReceipts; this guard is defence-in-depth
      // so the helper returns a meaningful empty payload instead of
      // throwing on the SQL.
      return {
        found: true,
        project_slug: projectSlug,
        project_label: projectSlug,
        month_iso: monthIso,
        month_label: monthLabel(monthIso),
        merged_prs: 0,
        total_spend_usd: 0,
        cost_per_pr_usd: null,
        red_days: 0,
        top_mover: null,
        generated_at: now.toISOString(),
      };
    }
    projectId = row.id;
    projectLabel = row.name ?? projectSlug;
  } else {
    projectLabel = "fleet";
  }

  const merged = countMerged(db, projectId, monthIso);
  const spend = sumSpend(db, projectId, monthIso);
  const redDays = countRedDays(db, projectId, monthIso);
  const cpp = merged > 0 ? spend / merged : null;
  const mover = isFleet ? topMover(db, monthIso) : null;

  return {
    found: true,
    project_slug: projectSlug,
    project_label: projectLabel,
    month_iso: monthIso,
    month_label: monthLabel(monthIso),
    merged_prs: merged,
    total_spend_usd: spend,
    cost_per_pr_usd: cpp,
    red_days: redDays,
    top_mover: mover,
    generated_at: now.toISOString(),
  };
}

// ────────────────────────────────────────────────────────────────────
// Reader (route-time) — returns the FROZEN payload from
// receipts_published, or null when no row exists.
// ────────────────────────────────────────────────────────────────────

interface PublishedRow { payload_json: string }

export function receiptsFor(
  db: DB,
  projectSlug: string,
  monthIso: string,
  _now: Date,
): ReceiptsPayload | null {
  const row = db.prepare(
    "SELECT payload_json FROM receipts_published WHERE project_slug = ? AND month_iso = ?",
  ).get(projectSlug, monthIso) as unknown as PublishedRow | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.payload_json) as ReceiptsPayload;
    // Ensure found:true is set defensively even if a future writer
    // forgets to stamp it.
    parsed.found = true;
    return parsed;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// Publish persistence
// ────────────────────────────────────────────────────────────────────

/** Validate a month_iso against /^\d{4}-(0[1-9]|1[0-2])$/. */
export function isValidMonthIso(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/** Persist a frozen payload. Idempotent on (project_slug, month_iso) —
 *  re-publishing the same month replaces the row. */
export function persistReceipts(db: DB, payload: ReceiptsPayload): void {
  db.prepare(
    "INSERT OR REPLACE INTO receipts_published(project_slug, month_iso, published_at, payload_json)"
    + " VALUES (?, ?, ?, ?)",
  ).run(payload.project_slug, payload.month_iso, new Date().toISOString(), JSON.stringify(payload));
}

/** Delete a published row. Idempotent — returns the rows-affected count
 *  but callers always answer 200 regardless. */
export function unpublishReceipts(db: DB, projectSlug: string, monthIso: string): number {
  const r = db.prepare(
    "DELETE FROM receipts_published WHERE project_slug = ? AND month_iso = ?",
  ).run(projectSlug, monthIso);
  return Number(r.changes ?? 0);
}

/** List every published row (newest first). Used by the CLI list
 *  subcommand. */
export function listPublishedReceipts(db: DB): Array<{
  project_slug: string; month_iso: string; published_at: string;
}> {
  return db.prepare(
    "SELECT project_slug, month_iso, published_at FROM receipts_published"
    + " ORDER BY published_at DESC",
  ).all() as unknown as Array<{
    project_slug: string; month_iso: string; published_at: string;
  }>;
}

// ────────────────────────────────────────────────────────────────────
// HTML rendering
//
// One self-contained HTML string per receipts URL. No <script> tag,
// no /api fetches, no JS framework — works on flaky cellular and
// screenshots cleanly with the URL bar visible.
// ────────────────────────────────────────────────────────────────────

/** Strip token-shaped substrings + GitHub URLs from operator-visible
 *  copy. Same shape as src/doctor.ts § redactSecrets and src/welcome.ts —
 *  defence-in-depth at the renderer boundary. */
function redactSecrets(s: string): string {
  let out = String(s ?? "");
  out = out.replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-pat>");
  out = out.replace(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?/g, "<redacted-repo-url>");
  out = out.replace(/\b[A-Za-z0-9_]{24,}\b/g, (match) => {
    const hasLetter = /[A-Za-z]/.test(match);
    const hasDigit = /\d/.test(match) || /_/.test(match);
    return hasLetter && hasDigit ? "<redacted>" : match;
  });
  return out;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v < 1) return "$" + v.toFixed(2);
  if (v < 100) return "$" + v.toFixed(2);
  return "$" + Math.round(v).toString();
}

/** Per LESSONS § "defence-in-depth secret redaction at the renderer
 *  boundary": every operator-visible string passes through
 *  redactSecrets before insertion. The github.com link in the footer
 *  is hard-coded to the fleet-control project URL (NOT the operator's
 *  repo) so the redactor can leave it intact via an exact-match guard.
 *
 *  The fleet-control footer URL is the ONE allowed github.com anchor
 *  on the page — see the AC6 test that grep-asserts this property.
 *  We construct it from a pair of plain strings so the redactor's
 *  github-URL regex (which matches owner/name URLs) doesn't accidentally
 *  shred it. */
const FOOTER_REPO_URL = "https://github.com/" + "mutaaf/fleet-control";

export function renderReceiptsPage(p: ReceiptsPayload): string {
  const safeProject = esc(redactSecrets(p.project_label));
  const safeSlug = esc(redactSecrets(p.project_slug));
  const safeMonth = esc(redactSecrets(p.month_label));
  // Numerics format locally so the page is the same byte-for-byte
  // regardless of the viewer's locale.
  const merged = String(p.merged_prs);
  const spend = fmtUsd(p.total_spend_usd);
  const cpp = p.cost_per_pr_usd == null ? "—" : fmtUsd(p.cost_per_pr_usd);
  const red = String(p.red_days);
  const mover = p.top_mover
    ? `<div class="receipts-mover">top mover ${esc(redactSecrets(p.top_mover.slug))} +${p.top_mover.delta_prs} PRs</div>`
    : "";
  const generated = esc(redactSecrets(p.generated_at.slice(0, 10)));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${safeProject} · ${safeMonth} · fleet receipts</title>
<link rel="stylesheet" href="/style.css" />
<meta name="robots" content="index, follow" />
</head>
<body class="receipts-page">
<main class="receipts-main">
  <div class="receipts-eyebrow">${safeProject} <span class="receipts-slug-dim">(${safeSlug})</span></div>
  <div class="receipts-month">${safeMonth}</div>
  <div class="receipts-stats">
    <div class="receipts-stat">
      <div class="receipts-stat-value receipts-headline">${esc(merged)}</div>
      <div class="receipts-stat-label">PRs merged</div>
    </div>
    <div class="receipts-stat">
      <div class="receipts-stat-value">${esc(spend)}</div>
      <div class="receipts-stat-label">total spend</div>
    </div>
    <div class="receipts-stat">
      <div class="receipts-stat-value">${esc(cpp)}</div>
      <div class="receipts-stat-label">per merged PR</div>
    </div>
    <div class="receipts-stat">
      <div class="receipts-stat-value">${esc(red)}</div>
      <div class="receipts-stat-label">days CI was red</div>
    </div>
  </div>
  ${mover}
  <div class="receipts-foot">
    Generated by fleet-control on ${generated} —
    <a href="${FOOTER_REPO_URL}">get fleet-control</a>
  </div>
  <div class="receipts-foot">
    <a data-testid="pulse-cross-link" href="/pulse">see this week's pulse at /pulse</a>
  </div>
</main>
</body>
</html>`;
}

/** Single chokepoint the server hits for GET /receipts/<slug>/<month>.
 *  Returns the status + headers + body the http handler emits. Pure
 *  (no req/res argument) so unit tests can drive it directly. */
export function serveReceipts(
  db: DB,
  projectSlug: string,
  monthIso: string,
): ServeReceiptsResult {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=600",
  };
  if (!isValidMonthIso(monthIso)) {
    return { status: 404, headers, body: renderNotFoundPage() };
  }
  const payload = receiptsFor(db, projectSlug, monthIso, new Date());
  if (!payload) {
    return { status: 404, headers, body: renderNotFoundPage() };
  }
  return { status: 200, headers, body: renderReceiptsPage(payload) };
}

function renderNotFoundPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>fleet receipts · not found</title>
<link rel="stylesheet" href="/style.css" />
</head>
<body class="receipts-page receipts-empty">
<main class="receipts-main">
  <div class="receipts-empty-title">No receipts here</div>
  <div class="receipts-empty-body">This URL hasn't been published yet.</div>
  <div class="receipts-foot">
    Get your own at <a href="${FOOTER_REPO_URL}">fleet-control</a>
  </div>
</main>
</body>
</html>`;
}
