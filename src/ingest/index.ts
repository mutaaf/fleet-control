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
  return { projects: manifests.length, runsIngested: total };
}
