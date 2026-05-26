// Ingest ~/.cache/<slug>-agent/events.jsonl — the typed event stream emitted
// by agent-fleet ticket 0002. One JSONL line per event; we record each as a
// row in `agent_event` and advance a byte-offset watermark so subsequent
// passes only read the new tail. Malformed lines are logged and skipped —
// the contract favours forward progress over strictness.
//
// Mirrors src/ingest/runs.ts in shape; the difference is we don't impose a
// schema on the payload (it's stored verbatim in `payload_json`), only
// project the well-known top-level fields onto columns for cheap queries.
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "../db.ts";

/** Read new events.jsonl lines for `slug` and insert them. Returns the count
 *  of newly-inserted rows. Safe to call repeatedly. */
export function ingestEvents(db: DB, slug: string, cacheBase: string): number {
  const path = join(cacheBase, `${slug}-agent`, "events.jsonl");
  if (!existsSync(path)) return 0;
  const size = statSync(path).size;
  const wmKey = `events:${slug}`;
  const wm = db.prepare("SELECT cursor FROM watermark WHERE source=?").get(wmKey) as { cursor: string } | undefined;
  let offset = wm ? Number(wm.cursor) : 0;
  if (offset === size) return 0;          // nothing new
  if (offset > size) offset = 0;          // file shrank/rotated → re-read from the top

  const fd = openSync(path, "r");
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  const text = buf.toString("utf8");
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return 0; // no complete line yet — wait for the next pass

  const complete = text.slice(0, lastNl);
  const ins = db.prepare(
    "INSERT INTO agent_event(slug, ts, phase, type, payload_json) VALUES(?,?,?,?,?)",
  );

  let n = 0;
  for (const line of complete.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch (e: any) {
      // Tolerant: log on stderr and skip. Don't abort the batch.
      console.error(`[ingest:events:${slug}] skipping malformed line: ${String(e?.message ?? e).slice(0, 120)}`);
      continue;
    }
    if (!o || typeof o !== "object") continue;
    const ts = typeof o.ts === "string" ? o.ts : (typeof o.timestamp === "string" ? o.timestamp : null);
    const phase = typeof o.phase === "string" ? o.phase : null;
    const type = typeof o.type === "string" ? o.type : null;
    ins.run(slug, ts, phase, type, line);
    n++;
  }

  // Advance the watermark by the bytes we actually consumed (the complete-line
  // prefix). The trailing partial line (if any) stays for next pass.
  const advanced = offset + Buffer.byteLength(complete, "utf8") + 1; // +1 for the \n
  db.prepare(
    "INSERT INTO watermark(source,cursor,updated_at) VALUES(?,?,?) ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at",
  ).run(wmKey, String(advanced), new Date().toISOString());
  return n;
}

/** Return the last `limit` events for a slug, newest first. Used by the
 *  /api/projects/:slug/events route and by the "Now" panel. */
export function recentEvents(db: DB, slug: string, limit: number): Array<{
  ts: string | null; phase: string | null; type: string | null; payload: any;
}> {
  const rows = db.prepare(
    "SELECT ts, phase, type, payload_json FROM agent_event WHERE slug=? ORDER BY ts DESC, id DESC LIMIT ?",
  ).all(slug, Math.max(0, Math.min(limit, 500))) as Array<{ ts: string; phase: string; type: string; payload_json: string }>;
  return rows.map((r) => {
    let payload: any = null;
    try { payload = JSON.parse(r.payload_json); } catch { /* leave null */ }
    return { ts: r.ts, phase: r.phase, type: r.type, payload };
  });
}
