// Ingest Claude Code session transcripts (*.jsonl) -> run + run_event rows.
// One transcript file == one session == one run. Tokens are summed per
// assistant turn; cost is computed (transcripts never store total_cost_usd).
import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FleetConfig } from "../config.ts";
import { transcriptDirFor } from "../config.ts";
import type { DB } from "../db.ts";
import { computeCost } from "../pricing.ts";
import { detectUsageLimit } from "../usage_limits.ts";

const SUBS = ["checkout", "review-checkout", "eng-checkout", "groom-checkout"];
const MAX_EVENTS = 1500;
const trunc = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + "…" : s);

function phaseFromSub(sub: string): string | null {
  if (sub.includes("review")) return "review";
  if (sub.includes("eng")) return "eng";
  if (sub.includes("groom")) return "groom";
  return null; // bare "checkout" — shared by ship & groom, disambiguate by content
}

interface Parsed {
  sessionId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  model: string | null;
  numTurns: number;
  input: number; output: number; cacheCreate: number; cacheRead: number;
  firstUserText: string;
  lastAssistantText: string;
  events: Array<{ seq: number; ts: string | null; kind: string; tool?: string; tuid?: string; inp?: string; out?: string; err?: number }>;
}

function parseTranscript(text: string): Parsed {
  const p: Parsed = {
    sessionId: null, startedAt: null, endedAt: null, model: null, numTurns: 0,
    input: 0, output: 0, cacheCreate: 0, cacheRead: 0,
    firstUserText: "", lastAssistantText: "", events: [],
  };
  let seq = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (!p.sessionId && o.sessionId) p.sessionId = o.sessionId;
    const ts = o.timestamp ?? null;
    if (ts) { if (!p.startedAt) p.startedAt = ts; p.endedAt = ts; }
    const msg = o.message;
    if (!msg) continue;
    if (msg.model) p.model = msg.model;
    if (msg.usage) {
      p.input += msg.usage.input_tokens ?? 0;
      p.output += msg.usage.output_tokens ?? 0;
      p.cacheCreate += msg.usage.cache_creation_input_tokens ?? 0;
      p.cacheRead += msg.usage.cache_read_input_tokens ?? 0;
    }
    if (o.type === "assistant") p.numTurns++;
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const c of content) {
        if (c.type === "text" && typeof c.text === "string") {
          if (o.type === "user" && !p.firstUserText) p.firstUserText = c.text;
          if (o.type === "assistant") p.lastAssistantText = c.text;
        } else if (c.type === "tool_use" && p.events.length < MAX_EVENTS) {
          const inp = typeof c.input === "object" ? (c.input.command ?? c.input.file_path ?? c.input.description ?? JSON.stringify(c.input)) : String(c.input ?? "");
          p.events.push({ seq: seq++, ts, kind: "tool_use", tool: c.name, tuid: c.id, inp: trunc(String(inp)) });
        } else if (c.type === "tool_result" && p.events.length < MAX_EVENTS) {
          const out = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
          p.events.push({ seq: seq++, ts, kind: "tool_result", tuid: c.tool_use_id, out: trunc(out), err: c.is_error ? 1 : 0 });
        }
      }
    } else if (typeof content === "string") {
      if (o.type === "user" && !p.firstUserText) p.firstUserText = content;
      if (o.type === "assistant") p.lastAssistantText = content;
    }
  }
  return p;
}

function inferShipOrGroom(firstUser: string): string {
  // Match the specific prompt headers, not stray words ("groom"/"gtm-" appear in
  // the ship prompt's healing instructions, which previously mis-tagged ship runs).
  if (/Ship runner/i.test(firstUser)) return "ship";
  if (/Innovation runner|GTM ?\/ ?Innovation/i.test(firstUser)) return "groom";
  return "ship"; // legacy gtm-worker (the shipper) lands here
}

function outcomeOf(t: string): string | null {
  if (/^SMOKE-OK/m.test(t)) return "smoke";
  // usage-limit short-circuits — if the run died on a limit, it didn't actually
  // ship/heal/etc., even if the text mentions those words in passing.
  if (detectUsageLimit(t).hit) return "usage-limit";
  if (/\bSHIP\s+\d{4}/.test(t) || /shipped/i.test(t)) return "shipped";
  if (/\bHEAL\b/.test(t)) return "healed";
  if (/\bNOOP\b|no actionable|nothing to (do|ship)/i.test(t)) return "no-op";
  if (/request-changes/i.test(t)) return "reviewed-changes";
  if (/\b--comment\b|signed off|sign-off/i.test(t)) return "reviewed-ok";
  if (/expired|self-cancel/i.test(t)) return "self-cancel";
  return null;
}

/** Ingest every transcript for one project (across all its alias slugs). */
export function ingestProjectTranscripts(db: DB, cfg: FleetConfig, projectId: number, aliasSlugs: string[]): number {
  let n = 0;
  const seen = db.prepare("SELECT size,mtime,complete FROM ingested_file WHERE path=?");
  const markFile = db.prepare(
    "INSERT INTO ingested_file(path,size,mtime,complete,run_id,ingested_at) VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET size=excluded.size,mtime=excluded.mtime,complete=excluded.complete,run_id=excluded.run_id,ingested_at=excluded.ingested_at",
  );
  const runUp = db.prepare(`
    INSERT INTO run(project_id,phase,session_id,started_at,ended_at,duration_ms,num_turns,
      input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd_computed,cost_source,
      model,summary,outcome,pr_number,transcript_path,source,usage_limit_at,usage_limit_until)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id,phase,session_id) DO UPDATE SET
      ended_at=excluded.ended_at, duration_ms=excluded.duration_ms, num_turns=excluded.num_turns,
      input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
      cache_creation_tokens=excluded.cache_creation_tokens, cache_read_tokens=excluded.cache_read_tokens,
      cost_usd_computed=excluded.cost_usd_computed,
      summary=excluded.summary, outcome=excluded.outcome, pr_number=excluded.pr_number, transcript_path=excluded.transcript_path,
      usage_limit_at=excluded.usage_limit_at, usage_limit_until=excluded.usage_limit_until`);
  const runIdOf = db.prepare("SELECT id FROM run WHERE project_id=? AND phase=? AND session_id=?");
  const evDel = db.prepare("DELETE FROM run_event WHERE run_id=?");
  const evIns = db.prepare(
    "INSERT INTO run_event(run_id,seq,ts,kind,tool_name,tool_use_id,input_summary,output_summary,is_error) VALUES(?,?,?,?,?,?,?,?,?)",
  );

  for (const slug of aliasSlugs) {
    for (const sub of SUBS) {
      const checkout = join(cfg.cacheBase, `${slug}-agent`, sub);
      const dir = join(cfg.claudeProjects, transcriptDirFor(checkout));
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const path = join(dir, f);
        const st = statSync(path);
        const prev = seen.get(path) as { size: number; mtime: string; complete: number } | undefined;
        const mtime = st.mtimeMs.toString();
        if (prev && prev.complete === 1 && prev.size === st.size && prev.mtime === mtime) continue;

        const parsed = parseTranscript(readFileSync(path, "utf8"));
        if (!parsed.sessionId) { markFile.run(path, st.size, mtime, 0, null, new Date().toISOString()); continue; }
        let phase = phaseFromSub(sub) ?? inferShipOrGroom(parsed.firstUserText);
        const dur = parsed.startedAt && parsed.endedAt
          ? new Date(parsed.endedAt).getTime() - new Date(parsed.startedAt).getTime() : null;
        const cost = computeCost(db, parsed.model, {
          input_tokens: parsed.input, output_tokens: parsed.output,
          cache_creation_tokens: parsed.cacheCreate, cache_read_tokens: parsed.cacheRead,
        });
        const prMatch = parsed.lastAssistantText.match(/(?:PR #?|pull\/)(\d+)/);
        const prNum = prMatch ? Number(prMatch[1]) : null;
        // Scan the assistant text + any tool_result errors for usage-limit signatures.
        const errorBlob = parsed.events.filter((e) => e.kind === "tool_result" && e.err).map((e) => e.out ?? "").join("\n");
        const usage = detectUsageLimit(parsed.lastAssistantText + "\n" + errorBlob);
        const ulAt = usage.hit ? (parsed.endedAt ?? parsed.startedAt) : null;
        const ulUntil = usage.hit ? usage.until : null;
        runUp.run(projectId, phase, parsed.sessionId, parsed.startedAt, parsed.endedAt, dur, parsed.numTurns,
          parsed.input, parsed.output, parsed.cacheCreate, parsed.cacheRead, cost, "computed",
          parsed.model, trunc(parsed.lastAssistantText, 600), outcomeOf(parsed.lastAssistantText), prNum, path, "transcript",
          ulAt, ulUntil);
        const rid = (runIdOf.get(projectId, phase, parsed.sessionId) as { id: number }).id;
        evDel.run(rid);
        for (const e of parsed.events)
          evIns.run(rid, e.seq, e.ts, e.kind, e.tool ?? null, e.tuid ?? null, e.inp ?? null, e.out ?? null, e.err ?? 0);
        markFile.run(path, st.size, mtime, 1, rid, new Date().toISOString());
        n++;
      }
    }
  }
  return n;
}
