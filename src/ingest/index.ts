// One ingest pass: sync projects + aliases, ingest transcripts, recompute rollups.
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { FleetConfig } from "../config.ts";
import type { DB } from "../db.ts";
import { syncProjects } from "../discovery.ts";
import { seedPricing } from "../pricing.ts";
import { ingestProjectTranscripts } from "./transcripts.ts";
import { ingestProjectRuns } from "./runs.ts";
import { ingestEvents } from "./events.ts";
import { runTicketLinkHook } from "./git_ticket_links.ts";

export function recomputeRollups(db: DB): void {
  db.exec("DELETE FROM cost_rollup_day");
  db.exec(`
    INSERT INTO cost_rollup_day(project_id,phase,day,runs,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd)
    SELECT project_id, phase, date(started_at) AS day, COUNT(*),
      SUM(input_tokens), SUM(output_tokens), SUM(cache_creation_tokens), SUM(cache_read_tokens),
      SUM(COALESCE(cost_usd, cost_usd_computed, 0))
    FROM run WHERE started_at IS NOT NULL
    GROUP BY project_id, phase, date(started_at)`);
}

export function runIngestPass(db: DB, cfg: FleetConfig): { projects: number; runsIngested: number } {
  seedPricing(db);
  const manifests = syncProjects(db, cfg);
  const projects = db.prepare("SELECT id, slug FROM project").all() as Array<{ id: number; slug: string }>;
  const aliasesOf = db.prepare("SELECT alias_slug FROM project_alias WHERE project_id=?");

  let total = 0;
  db.exec("BEGIN");
  try {
    for (const p of projects) {
      const aliases = (aliasesOf.all(p.id) as Array<{ alias_slug: string }>).map((r) => r.alias_slug);
      if (!aliases.includes(p.slug)) aliases.push(p.slug);
      total += ingestProjectTranscripts(db, cfg, p.id, aliases);
      ingestProjectRuns(db, cfg, p.id, p.slug); // measured cost overlay (live > computed)
      // Typed event stream (agent-fleet ticket 0002). Read across every alias
      // slug so renamed projects keep flowing without a manual backfill.
      for (const aliasSlug of aliases) {
        try { ingestEvents(db, aliasSlug, cfg.cacheBase); } catch { /* keep ingesting */ }
      }
      // Ticket 0018: backlog-ticket → merged-commit auto-link. After
      // the transcript/run/event ingest for a project, scan the
      // project's local checkout for new commits and persist any
      // ticket-id auto-links. The hook is idempotent (PK collision
      // = no duplicate row) and silently skips when the checkout
      // doesn't exist (fresh installs, demo-mode fixtures). The
      // canonical "where does a project's checkout live?" answer
      // for the fleet is `<cacheBase>/<slug>-agent/checkout` (see
      // src/discovery.ts, src/ingest/transcripts.ts).
      const repoPath = join(cfg.cacheBase, `${p.slug}-agent`, "checkout");
      if (existsSync(join(repoPath, ".git"))) {
        try { runTicketLinkHook(db, p.id, p.slug, repoPath); }
        catch { /* keep ingesting */ }
      }
    }
    recomputeRollups(db);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  // Ticket 0039: changelog page memo cache lives in src/server.ts but
  // its invalidation chokepoint is here — completing an ingest pass
  // means the `pr` table may have new rows, and a freshly-merged PR
  // must surface on the next render without waiting out the 60s TTL.
  // We import lazily (via a dynamic call shape that avoids a cycle
  // with src/server.ts importing from src/ingest/index.ts) — the
  // helper is a no-op when the server module hasn't loaded.
  try {
    // Late-bind via the already-loaded module cache so the daemon
    // (which doesn't import server.ts) just skips this step. Using
    // a synchronous `await import()` here would block the ingest
    // pass; instead we read the live binding off the cached module
    // object set up by server.ts at load time.
    const hook = (globalThis as { __fleet_changelog_invalidate__?: () => void }).__fleet_changelog_invalidate__;
    if (typeof hook === "function") hook();
  } catch { /* never let an in-process cache fail the ingest */ }
  // Ticket 0047: PR autopsy card memo cache lives in src/server.ts;
  // its invalidation chokepoint is here for the same reason — a
  // freshly-closed PR row must surface on the next render without
  // waiting out the 10-min TTL. Same shape as the changelog hook
  // above: late-bind via the globalThis slot registered by
  // src/server.ts at module load (per LESSONS 2026-06-05 "break
  // ingest↔server cache-invalidation cycles via a globalThis slot,
  // not a circular import"). The hook is a no-op when the server
  // module hasn't loaded (the launchd daemon imports ingest but
  // not server).
  try {
    const hook = (globalThis as { __fleet_pr_autopsies_invalidate__?: () => void }).__fleet_pr_autopsies_invalidate__;
    if (typeof hook === "function") hook();
  } catch { /* never let an in-process cache fail the ingest */ }
  // Ticket 0048: per-project worth-it verdict memo cache. The cache
  // composes pr / cost_rollup_day / run / project — any of which an
  // ingest tick can touch — so the simplest correct behaviour is to
  // clear the whole map on every commit and let the next request
  // rebuild the row it needs. Same globalThis-slot pattern as the
  // changelog (0039) + autopsy (0047) hooks above.
  try {
    const hook = (globalThis as { __fleet_worth_it_invalidate__?: () => void }).__fleet_worth_it_invalidate__;
    if (typeof hook === "function") hook();
  } catch { /* never let an in-process cache fail the ingest */ }
  // Ticket 0050: fleet year-in-review memo cache. Same globalThis-slot
  // pattern as the changelog / autopsy / worth-it hooks above (per
  // LESSONS 2026-06-05 "break ingest↔server cache-invalidation cycles
  // via a globalThis slot, not a circular import"). A freshly-merged
  // or freshly-closed PR is the page's main signal to refresh; the
  // 1-hour TTL would otherwise stale the page for an hour.
  try {
    const hook = (globalThis as { __fleet_year_in_review_invalidate__?: () => void }).__fleet_year_in_review_invalidate__;
    if (typeof hook === "function") hook();
  } catch { /* never let an in-process cache fail the ingest */ }
  // Ticket 0051: pre-install ROI calculator memo cache. Same
  // globalThis-slot pattern as the changelog / autopsy / worth-it /
  // year-in-review hooks above (per LESSONS 2026-06-05 "break
  // ingest↔server cache-invalidation cycles via a globalThis slot,
  // not a circular import"). The median composes pr + cost_rollup_day
  // + run — any of which an ingest tick can touch — so the simplest
  // correct behaviour is to clear the cache on every commit and let
  // the next request rebuild. The /calculator HTML page reads from
  // the same memo so its 5-min Cache-Control TTL also gets refreshed
  // semantics on the server side.
  try {
    const hook = (globalThis as { __fleet_median_projection_invalidate__?: () => void }).__fleet_median_projection_invalidate__;
    if (typeof hook === "function") hook();
  } catch { /* never let an in-process cache fail the ingest */ }
  // Ticket 0052: lesson-pays-for-itself savings memo cache. Same
  // globalThis-slot pattern as the changelog / autopsy / worth-it /
  // year-in-review / median-projection hooks above. The savings
  // rollup composes lesson_credit + run — both of which an ingest
  // tick can touch (a freshly-landed run.outcome='failure' row
  // shifts the average-failed-ship-cost denominator), so the
  // simplest correct behaviour is to clear the cache on every
  // commit and let the next request rebuild.
  try {
    const hook = (globalThis as { __fleet_lesson_savings_invalidate__?: () => void }).__fleet_lesson_savings_invalidate__;
    if (typeof hook === "function") hook();
  } catch { /* never let an in-process cache fail the ingest */ }
  // Ticket 0054: public weekly fleet pulse memo cache. Same
  // globalThis-slot pattern as every other read-side cache. A
  // freshly-merged PR shifts merged_prs / top_project; a fresh
  // lesson_credit shifts freshest_lesson. Clearing the cache on
  // every commit lets the next /pulse render rebuild the row
  // without waiting out the 1-hour TTL.
  try {
    const hook = (globalThis as { __fleet_pulse_invalidate__?: () => void }).__fleet_pulse_invalidate__;
    if (typeof hook === "function") hook();
  } catch { /* never let an in-process cache fail the ingest */ }
  // Ticket 0055: lesson-of-the-day rotation memo cache. Same
  // globalThis-slot pattern; the rotation list is keyed off lesson_
  // credit ranking, so a freshly-landed credit row (from the route's
  // attribution pass during a cache-miss build) shifts the slot.
  try {
    const hook = (globalThis as { __fleet_lesson_of_the_day_invalidate__?: () => void }).__fleet_lesson_of_the_day_invalidate__;
    if (typeof hook === "function") hook();
  } catch { /* never let an in-process cache fail the ingest */ }
  // Ticket 0056: per-project lesson-savings memo cache. Same
  // globalThis-slot pattern; composes lesson_credit + run signals
  // both of which can shift on any ingest tick (a freshly-landed
  // run.outcome='failure' row moves the average-failed-ship-cost
  // denominator → per-project saved_usd shifts → home grid cards
  // re-render with the new ~Nh number on the next tick).
  try {
    const hook = (globalThis as { __fleet_lesson_savings_by_project_invalidate__?: () => void }).__fleet_lesson_savings_by_project_invalidate__;
    if (typeof hook === "function") hook();
  } catch { /* never let an in-process cache fail the ingest */ }
  // Ticket 0053: project graveyard memo cache. Same globalThis-slot
  // pattern; the rollup composes project_pause + pr +
  // cost_rollup_day + lesson_credit. A freshly-merged PR shifts the
  // (MAX(fetched_at), COUNT(*)) tuple, so clearing the cache on
  // every ingest commit lets the next render rebuild with the
  // fresh PR data without waiting out the 30-min TTL.
  try {
    const hook = (globalThis as { __fleet_graveyard_invalidate__?: () => void }).__fleet_graveyard_invalidate__;
    if (typeof hook === "function") hook();
  } catch { /* never let an in-process cache fail the ingest */ }
  // Ticket 0058: public failure-mode landing pages memo cache. Same
  // globalThis-slot pattern. The cache key tuple is (MAX(pr.fetched_at),
  // COUNT(*) over pr in window) so any fresh pr row landing during an
  // ingest tick should bust the cache and let the next /failures or
  // /api/failures request rebuild without waiting out the 1-hour TTL.
  try {
    const hook = (globalThis as { __fleet_failure_modes_invalidate__?: () => void }).__fleet_failure_modes_invalidate__;
    if (typeof hook === "function") hook();
  } catch { /* never let an in-process cache fail the ingest */ }
  return { projects: manifests.length, runsIngested: total };
}
