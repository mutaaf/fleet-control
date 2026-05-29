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
  return { projects: manifests.length, runsIngested: total };
}
