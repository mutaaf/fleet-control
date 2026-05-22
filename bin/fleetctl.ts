#!/usr/bin/env node
// fleetctl — Phase 0 CLI. Backfill the cache from local transcripts/logs and
// report runs + cost. Run: node --disable-warning=ExperimentalWarning bin/fleetctl.ts <cmd>
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { runIngestPass } from "../src/ingest/index.ts";

const c = {
  dim: "\x1b[2m", bold: "\x1b[1m", grn: "\x1b[32m", ylw: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", rst: "\x1b[0m",
};
const usd = (n: number | null) => (n == null ? "—" : "$" + n.toFixed(2));
const k = (n: number) => (n >= 1000 ? (n / 1000).toFixed(0) + "k" : String(n));
const ago = (iso: string | null) => {
  if (!iso) return "—";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 3600) return Math.round(d / 60) + "m ago";
  if (d < 86400) return Math.round(d / 3600) + "h ago";
  return Math.round(d / 86400) + "d ago";
};

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const [cmd, arg] = process.argv.slice(2);

function backfill() {
  const t0 = Date.now();
  process.stdout.write("ingesting transcripts… ");
  const r = runIngestPass(db, cfg);
  console.log(`${c.grn}done${c.rst} (${r.projects} projects, ${r.runsIngested} runs touched, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  status();
}

function status() {
  const rows = db.prepare(`
    SELECT p.slug, p.name, p.self_cancel,
      COUNT(r.id) AS runs,
      SUM(COALESCE(r.cost_usd, r.cost_usd_computed, 0)) AS cost,
      SUM(r.input_tokens+r.output_tokens+r.cache_creation_tokens+r.cache_read_tokens) AS toks,
      MAX(r.started_at) AS last_run
    FROM project p LEFT JOIN run r ON r.project_id=p.id
    GROUP BY p.id ORDER BY cost DESC`).all() as any[];
  console.log(`\n${c.bold}PROJECT       RUNS   TOKENS    EST. COST   LAST RUN${c.rst}`);
  console.log(c.dim + "─".repeat(58) + c.rst);
  let tc = 0, tr = 0;
  for (const r of rows) {
    tc += r.cost ?? 0; tr += r.runs ?? 0;
    console.log(
      `${(r.slug as string).padEnd(13)} ${String(r.runs).padStart(4)}   ${k(r.toks ?? 0).padStart(7)}   ${usd(r.cost).padStart(9)}   ${ago(r.last_run)}`,
    );
  }
  console.log(c.dim + "─".repeat(58) + c.rst);
  console.log(`${"TOTAL".padEnd(13)} ${String(tr).padStart(4)}   ${"".padStart(7)}   ${c.cyan}${usd(tc).padStart(9)}${c.rst}`);
  console.log(`${c.dim}est. cost = tokens × pricing (Max plan: no real bill — relative effort)${c.rst}\n`);
}

function runsFor(slug: string) {
  const p = db.prepare("SELECT id,name FROM project WHERE slug=?").get(slug) as any;
  if (!p) return console.log(`no project '${slug}'. known: ` + (db.prepare("SELECT slug FROM project").all() as any[]).map((x) => x.slug).join(", "));
  const rows = db.prepare(`
    SELECT id, phase, started_at, duration_ms, num_turns, outcome,
      COALESCE(cost_usd,cost_usd_computed,0) AS cost,
      (input_tokens+output_tokens+cache_creation_tokens+cache_read_tokens) AS toks
    FROM run WHERE project_id=? ORDER BY started_at DESC LIMIT 30`).all(p.id) as any[];
  console.log(`\n${c.bold}${p.name} — recent runs${c.rst}`);
  console.log(`${c.dim}ID    PHASE   WHEN        DUR   TOKENS  COST    OUTCOME${c.rst}`);
  for (const r of rows) {
    const dur = r.duration_ms ? Math.round(r.duration_ms / 1000) + "s" : "—";
    const oc = r.outcome === "shipped" ? c.grn + r.outcome + c.rst : r.outcome === "no-op" ? c.dim + r.outcome + c.rst : (r.outcome ?? "—");
    console.log(`${String(r.id).padStart(4)}  ${(r.phase as string).padEnd(6)}  ${ago(r.started_at).padEnd(10)}  ${dur.padStart(4)}  ${k(r.toks).padStart(6)}  ${usd(r.cost).padStart(6)}  ${oc}`);
  }
  console.log();
}

function show(id: string) {
  const r = db.prepare("SELECT * FROM run WHERE id=?").get(Number(id)) as any;
  if (!r) return console.log(`no run #${id}`);
  console.log(`\n${c.bold}run #${r.id}${c.rst}  ${r.phase}  ${ago(r.started_at)}  ${usd(r.cost_usd ?? r.cost_usd_computed)}  (${r.cost_source})`);
  console.log(`${c.dim}tokens: in ${k(r.input_tokens)} · out ${k(r.output_tokens)} · cache-write ${k(r.cache_creation_tokens)} · cache-read ${k(r.cache_read_tokens)} · turns ${r.num_turns}${c.rst}`);
  if (r.outcome) console.log(`outcome: ${r.outcome}`);
  if (r.summary) console.log(`\n${r.summary}\n`);
  const ev = db.prepare("SELECT * FROM run_event WHERE run_id=? ORDER BY seq LIMIT 60").all(r.id) as any[];
  if (ev.length) {
    console.log(`${c.bold}trace${c.rst} ${c.dim}(${ev.length} of the run's tool calls)${c.rst}`);
    for (const e of ev) {
      if (e.kind === "tool_use") console.log(`  ${c.cyan}${(e.tool_name ?? "").padEnd(6)}${c.rst} ${e.input_summary ?? ""}`);
      else if (e.kind === "tool_result" && e.is_error) console.log(`  ${c.red}  ↳ error${c.rst} ${(e.output_summary ?? "").slice(0, 120)}`);
    }
  }
  console.log();
}

switch (cmd) {
  case "backfill": backfill(); break;
  case "status": case undefined: status(); break;
  case "runs": runsFor(arg ?? ""); break;
  case "show": show(arg ?? ""); break;
  default: console.log("usage: fleetctl [backfill|status|runs <slug>|show <id>]");
}
db.close();
