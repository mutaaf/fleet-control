// One ingest pass: sync projects + aliases, ingest transcripts, recompute rollups.
import type { FleetConfig } from "../config.ts";
import type { DB } from "../db.ts";
import { syncProjects } from "../discovery.ts";
import { seedPricing } from "../pricing.ts";
import { ingestProjectTranscripts } from "./transcripts.ts";

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
    }
    recomputeRollups(db);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { projects: manifests.length, runsIngested: total };
}
