// Ingest ~/.cache/<slug>-agent/runs.jsonl (written by fleet_run_claude going
// forward). This is the AUTHORITATIVE cost source: total_cost_usd is measured.
// It overlays the transcript-computed run with the same session_id (live > computed).
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { FleetConfig } from "../config.ts";
import type { DB } from "../db.ts";

export function ingestProjectRuns(db: DB, cfg: FleetConfig, projectId: number, slug: string): number {
  const path = join(cfg.cacheBase, `${slug}-agent`, "runs.jsonl");
  if (!existsSync(path)) return 0;
  const size = statSync(path).size;
  const wmKey = `runs:${slug}`;
  const wm = db.prepare("SELECT cursor FROM watermark WHERE source=?").get(wmKey) as { cursor: string } | undefined;
  let offset = wm ? Number(wm.cursor) : 0;
  if (offset >= size) return 0;
  if (offset > size) offset = 0; // file shrank/rotated → re-read

  // read the new tail
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  const text = buf.toString("utf8");
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return 0; // no complete line yet
  const complete = text.slice(0, lastNl);

  const up = db.prepare(`
    INSERT INTO run(project_id,phase,session_id,started_at,ended_at,duration_ms,exit_code,num_turns,
      input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd,cost_source,model,summary,source)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?, 'live', ?,?, 'runs.jsonl')
    ON CONFLICT(project_id,phase,session_id) DO UPDATE SET
      ended_at=COALESCE(excluded.ended_at,ended_at), duration_ms=COALESCE(excluded.duration_ms,duration_ms),
      exit_code=excluded.exit_code, num_turns=COALESCE(excluded.num_turns,num_turns),
      cost_usd=excluded.cost_usd, cost_source='live'`);

  let n = 0;
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r.session_id) continue;
    const u = r.usage ?? {};
    up.run(projectId, r.phase ?? "ship", r.session_id, r.ts_start ?? null, r.ts_end ?? null,
      r.duration_ms ?? null, r.exit ?? null, r.num_turns ?? null,
      u.input_tokens ?? 0, u.output_tokens ?? 0, u.cache_creation_input_tokens ?? 0, u.cache_read_input_tokens ?? 0,
      r.total_cost_usd ?? null, r.model ?? null, (r.result_head ?? "").slice(0, 600));
    n++;
  }
  db.prepare("INSERT INTO watermark(source,cursor,updated_at) VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at")
    .run(wmKey, String(offset + Buffer.byteLength(complete, "utf8") + 1), new Date().toISOString());
  return n;
}
