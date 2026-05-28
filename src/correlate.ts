// Cross-project failure correlation (ticket 0027).
//
// One "correlation" is a stable failure signature (e.g. "TS2304",
// "git-push-403") that shows up in two or more distinct projects'
// open failing PRs within the last 24h. Surfaces a fleet-wide
// "diagnose the root cause once" hook instead of N indistinguishable
// red PRs the operator chases per-project.
//
// Architecture:
//   - `failureSignature(check, excerpt)`: pure function (no I/O, no
//     shell) over the CI log excerpt — directly unit-testable.
//   - `detectCorrelations(db, now)`: pure SQL over the `pr` table.
//     Groups by the in-application-derived signature, returns rows
//     with >=2 distinct project slugs.
//   - `runCorrelationHook(db, now)`: writes one `anomaly` row per
//     NEW correlation (idempotent via the partial unique index on
//     correlation_signature WHERE kind='fleet_correlated' added in
//     src/db.ts).
//   - `activeCorrelations(db, now)`: reads the live, non-dismissed
//     correlation list — the route and inbox both call this.
//
// Zero new runtime deps; pure SQL + the signature helper. Per
// AGENTS.md and the ticket's engineering notes this module does NOT
// shell out — the `gh run view --log-failed` call lives in
// src/ingest/prs.ts only.
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`",
// every typed read goes through the double-cast.
import type { DB } from "./db.ts";

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface Correlation {
  /** Stable per-failure key derived by `failureSignature`. */
  signature: string;
  /** Distinct slugs that hit this signature in the last 24h. */
  project_slugs: string[];
  /** First (oldest) failing PR fetched_at in the window. */
  first_seen_at: string;
  /** Last (newest) failing PR fetched_at in the window. */
  last_seen_at: string;
  /** First 200 chars of one of the contributing excerpts. */
  sample_excerpt: string;
}

// ────────────────────────────────────────────────────────────────────
// Signature derivation — one regex per failure family.
// ────────────────────────────────────────────────────────────────────

/** Extract a stable signature from a CI failure excerpt. Each regex
 *  is anchored on the specific failure shape the operator routinely
 *  sees across projects (Node version drift, missing tooling, auth
 *  flakes). Returns null for any unmatched excerpt — those don't
 *  participate in correlation. */
export function failureSignature(
  _check: string | null | undefined,
  excerpt: string | null | undefined,
): string | null {
  if (!excerpt) return null;
  const s = String(excerpt);
  // TypeScript error code: TS\d{4}. We keep the exact code so
  // "TS2304" doesn't collide with "TS2322" — each error family
  // deserves its own diagnostic conversation.
  const ts = s.match(/TS(\d{4})/);
  if (ts) return "TS" + ts[1];
  // Git push auth — both forms surface from the same root cause
  // (the agent's token can't push to main).
  if (/remote:\s*(Permission denied|HTTP 403)/i.test(s)) return "git-push-403";
  // gh CLI missing — PATH not propagated to the runner shell.
  if (/gh:\s*command not found/i.test(s)) return "gh-missing";
  // Node binary missing — same shape, different binary.
  if (/\bnode:\s*command not found/i.test(s)) return "node-missing";
  // npm install EACCES — global install attempting a system path.
  if (/EACCES.*npm|npm[\s\S]*EACCES/i.test(s)) return "npm-eacces";
  return null;
}

// ────────────────────────────────────────────────────────────────────
// Detection — pure SQL + the signature helper.
// ────────────────────────────────────────────────────────────────────

interface PrFailureRow {
  slug: string;
  fetched_at: string;
  first_fail_check: string | null;
  first_fail_excerpt: string | null;
}

/** Detect every signature that appears in >=2 distinct project slugs'
 *  failing PRs within the last 24h. The `now` parameter is injected
 *  so tests can pin the window. We pull the candidate set via one
 *  SQL read, then group in-application — the signature derivation
 *  is JavaScript (regex), so we can't push it into SQL without
 *  hard-coding each pattern as a CASE branch (which would split the
 *  rule set across two languages and make a future regex tweak a
 *  cross-cutting edit). */
export function detectCorrelations(db: DB, now: Date): Correlation[] {
  const cutoff = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  // Read every "potentially correlatable" row in the window: an open
  // PR with a known first_fail_check AND a non-null excerpt. NULL on
  // either side means "we don't yet know how this is failing" and is
  // a legitimate skip.
  const rows = db.prepare(
    "SELECT p.slug AS slug, pr.fetched_at AS fetched_at, "
    + "       pr.first_fail_check AS first_fail_check, "
    + "       pr.first_fail_excerpt AS first_fail_excerpt "
    + "  FROM pr "
    + "  JOIN project p ON p.id = pr.project_id "
    + " WHERE pr.state = 'open' "
    + "   AND pr.first_fail_excerpt IS NOT NULL "
    + "   AND pr.fetched_at >= ?",
  ).all(cutoff) as unknown as PrFailureRow[];

  // Group by signature. For each group track the unique slugs, the
  // min/max fetched_at, and a sample excerpt (first one seen so the
  // result is stable across reorderings — SQLite returns rows in
  // insertion order absent an ORDER BY which is good enough for a
  // sample).
  interface Group {
    slugs: Set<string>;
    first_seen_at: string;
    last_seen_at: string;
    sample_excerpt: string;
  }
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const sig = failureSignature(r.first_fail_check, r.first_fail_excerpt);
    if (!sig) continue;
    const g = groups.get(sig);
    const excerpt = (r.first_fail_excerpt ?? "").slice(0, 200);
    if (!g) {
      groups.set(sig, {
        slugs: new Set<string>([r.slug]),
        first_seen_at: r.fetched_at,
        last_seen_at: r.fetched_at,
        sample_excerpt: excerpt,
      });
      continue;
    }
    g.slugs.add(r.slug);
    if (r.fetched_at < g.first_seen_at) g.first_seen_at = r.fetched_at;
    if (r.fetched_at > g.last_seen_at) g.last_seen_at = r.fetched_at;
  }

  const out: Correlation[] = [];
  for (const [signature, g] of groups) {
    if (g.slugs.size < 2) continue; // N>=2 required
    out.push({
      signature,
      project_slugs: [...g.slugs].sort(),
      first_seen_at: g.first_seen_at,
      last_seen_at: g.last_seen_at,
      sample_excerpt: g.sample_excerpt,
    });
  }
  // Stable ordering by signature for deterministic API output.
  out.sort((a, b) => a.signature.localeCompare(b.signature));
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Daemon hook + active-list helpers.
// ────────────────────────────────────────────────────────────────────

interface AnomalyCorrelationRow {
  id: number;
  correlation_signature: string;
  created_at: string;
  candidate_reason: string | null;
  baseline_mean: number;
  baseline_stddev: number;
  value: number;
}

/** Write one `anomaly` row per NEW correlation. Idempotency rule: if
 *  an anomaly with the same correlation_signature already exists in
 *  the 24h window AND it hasn't been dismissed since being created,
 *  the hook is a no-op for that signature. This shape lets a fresh
 *  correlation re-fire after a dismissal once a NEW occurrence
 *  arrives (the dismissal is bounded to the existing row's lifetime
 *  in the window). Re-detecting the same correlation in the same
 *  un-dismissed window does NOT insert a duplicate. */
export function runCorrelationHook(db: DB, now: Date): number {
  const live = detectCorrelations(db, now);
  if (live.length === 0) return 0;
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  // Look up the most-recent anomaly row for each signature in the
  // window AND any dismissal for it. If a row exists AND no
  // dismissal occurred after its created_at, the signature is
  // "live-already" — skip it. Otherwise insert a fresh row
  // (re-fire), which the inbox surfaces above any older dismissed
  // row because activeCorrelations only returns rows whose
  // created_at is after the last dismissal.
  const liveCheck = db.prepare(
    "SELECT a.id AS id, a.created_at AS created_at, "
    + "       MAX(d.dismissed_at) AS last_dismissed_at "
    + "  FROM anomaly a "
    + "  LEFT JOIN inbox_dismissal d "
    + "         ON d.kind = 'fleet_correlation' "
    + "        AND d.project_slug = 'fleet' "
    + "        AND d.payload_id = a.correlation_signature "
    + " WHERE a.kind = 'fleet_correlated' "
    + "   AND a.correlation_signature = ? "
    + "   AND a.created_at >= ? "
    + " GROUP BY a.id "
    + " ORDER BY a.created_at DESC "
    + " LIMIT 1",
  );
  const ins = db.prepare(
    "INSERT INTO anomaly("
    + "  run_id, kind, value, baseline_mean, baseline_stddev, "
    + "  sample_count, candidate_reason, created_at, correlation_signature"
    + ") VALUES(NULL, 'fleet_correlated', ?, 0, 0, ?, ?, ?, ?)",
  );
  let inserted = 0;
  for (const c of live) {
    const existing = liveCheck.get(c.signature, cutoff) as {
      id: number; created_at: string; last_dismissed_at: string | null;
    } | undefined;
    if (existing) {
      // A row already exists in the window. If it hasn't been
      // dismissed since creation, this is the idempotent path —
      // skip. If it HAS been dismissed, the existing row is
      // suppressed by activeCorrelations' LEFT JOIN; we still
      // don't insert a fresh row because the underlying
      // correlation is the same one the operator already
      // dismissed — only a NEW correlation (i.e. a fresh signal
      // outside the 24h window of the dismissed row) re-fires.
      // The "25h later" re-surface path therefore depends on the
      // existing row aging out of the 24h window first.
      const dismissed = existing.last_dismissed_at !== null;
      if (!dismissed) continue;
      // Dismissed within-window: don't insert (the existing row is
      // suppressed already). The re-surface happens when the
      // existing row falls outside `cutoff` on a future tick.
      continue;
    }
    const detail = JSON.stringify({
      project_slugs: c.project_slugs,
      first_seen_at: c.first_seen_at,
      last_seen_at: c.last_seen_at,
      sample_excerpt: c.sample_excerpt,
    });
    ins.run(
      c.project_slugs.length,         // value = N (count of slugs)
      c.project_slugs.length,         // sample_count = N
      detail,                          // candidate_reason = JSON blob
      nowIso,
      c.signature,
    );
    inserted += 1;
  }
  return inserted;
}

/** Return the currently-active correlations: any `anomaly` row with
 *  kind='fleet_correlated' AND created_at in the last 24h AND not
 *  dismissed. Reconstructs the {project_slugs, sample_excerpt,
 *  first/last_seen_at} payload from the JSON blob stored in
 *  `candidate_reason` so the route + inbox + SPA all see the same
 *  shape `detectCorrelations` produces. */
export function activeCorrelations(db: DB, now: Date): Correlation[] {
  const cutoff = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
  // Dismissals live in `inbox_dismissal` keyed by
  // (kind='fleet_correlation', project_slug='fleet', payload_id=signature).
  // We LEFT JOIN so a NULL dismissal row means "still live".
  const rows = db.prepare(
    "SELECT a.id AS id, a.correlation_signature AS correlation_signature, "
    + "       a.created_at AS created_at, a.candidate_reason AS candidate_reason, "
    + "       a.baseline_mean AS baseline_mean, a.baseline_stddev AS baseline_stddev, "
    + "       a.value AS value "
    + "  FROM anomaly a "
    + "  LEFT JOIN inbox_dismissal d "
    + "         ON d.kind = 'fleet_correlation' "
    + "        AND d.project_slug = 'fleet' "
    + "        AND d.payload_id = a.correlation_signature "
    + "        AND d.dismissed_at >= a.created_at "
    + " WHERE a.kind = 'fleet_correlated' "
    + "   AND a.correlation_signature IS NOT NULL "
    + "   AND a.created_at >= ? "
    + "   AND d.dismissed_at IS NULL "
    + " ORDER BY a.correlation_signature ASC",
  ).all(cutoff) as unknown as AnomalyCorrelationRow[];

  const out: Correlation[] = [];
  for (const r of rows) {
    let detail: {
      project_slugs?: string[];
      first_seen_at?: string;
      last_seen_at?: string;
      sample_excerpt?: string;
    } = {};
    if (r.candidate_reason) {
      try { detail = JSON.parse(r.candidate_reason); }
      catch { /* fall through with empty detail */ }
    }
    out.push({
      signature: r.correlation_signature,
      project_slugs: detail.project_slugs ?? [],
      first_seen_at: detail.first_seen_at ?? r.created_at,
      last_seen_at: detail.last_seen_at ?? r.created_at,
      sample_excerpt: detail.sample_excerpt ?? "",
    });
  }
  return out;
}
