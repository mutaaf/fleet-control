#!/usr/bin/env node
// fleetctl — Phase 0 CLI. Backfill the cache from local transcripts/logs and
// report runs + cost. Run: node --disable-warning=ExperimentalWarning bin/fleetctl.ts <cmd>
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { runIngestPass } from "../src/ingest/index.ts";
import { startServer } from "../src/server.ts";
import { runDaemon, installDaemon, uninstallDaemon, daemonStatus } from "../src/daemon.ts";
import { evalAlerts, openAlerts } from "../src/alerts.ts";
import { mintToken, listTokens, revokeToken, type Scope } from "../src/auth.ts";
import { syncPricing, pricingRows, DEFAULT_PRICING_FILE } from "../src/pricing.ts";
import { flagRun } from "../src/anomaly.ts";
import { ntfyConfigFrom, ntfyTestCommand } from "../src/ntfy.ts";
import { weeklyDigest, renderDigestMarkdown, isoWeekKey } from "../src/digest.ts";
import { listSnapshots } from "../src/snapshot.ts";
import { doAction } from "../src/control.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { homedir } from "node:os";

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
const argv = process.argv.slice(2);
const [cmd, arg] = argv;

/** Tiny flag parser: returns the value following --flag (or undefined).
 *  Lets `tokens add laptop --scope admin` work without dragging in a CLI dep. */
function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function backfill() {
  const t0 = Date.now();
  process.stdout.write("ingesting transcripts… ");
  const r = runIngestPass(db, cfg);
  // Ticket 0008: reactive anomaly flagging runs AFTER the ingest pass so
  // cost_usd / cost_usd_computed / run_event rows are all current. We only
  // call flagRun on runs that don't already carry a flag — the helper is
  // idempotent (UNIQUE(run_id, kind)) but the no-op pre-check saves N
  // round-trips per backfill on large histories.
  let flagged = 0;
  const candidates = db.prepare(
    "SELECT r.id FROM run r WHERE r.started_at IS NOT NULL "
    + "  AND NOT EXISTS (SELECT 1 FROM anomaly a WHERE a.run_id = r.id) "
    + "  AND r.started_at >= datetime('now','-14 day')",
  ).all() as Array<{ id: number }>;
  for (const row of candidates) {
    try {
      const res = flagRun(db, row.id);
      if (res.flagged) flagged++;
    } catch { /* keep the backfill going on any single-run failure */ }
  }
  console.log(`${c.grn}done${c.rst} (${r.projects} projects, ${r.runsIngested} runs touched, ${flagged} new anomal${flagged === 1 ? "y" : "ies"}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
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

/** `fleetctl tokens <add|list|revoke> ...` — mint, list, and revoke the
 *  per-device scoped tokens that gate the LAN portal. Plaintext is printed
 *  once on `add`; after that only the 8-char id-prefix is visible anywhere. */
function tokens() {
  const sub = arg;
  if (sub === "add") {
    const name = argv[2];
    const scope = (flag("scope") ?? "read") as Scope;
    if (!name) return console.log("usage: fleetctl tokens add <name> --scope <read|control|admin>");
    try {
      const m = mintToken(db, name, scope);
      // Print to STDERR-visible-but-distinct lines so a careless pipe doesn't
      // capture the secret. The operator sees it ONCE; no copy lives on disk.
      console.log(`${c.grn}minted${c.rst} ${c.bold}${m.name}${c.rst} ${c.dim}(${m.scope}, id ${m.id_prefix})${c.rst}`);
      console.log(`${c.ylw}token (shown once — copy it now):${c.rst}\n  ${m.token}`);
    } catch (e: any) {
      console.error(`${c.red}error:${c.rst} ${e?.message ?? e}`); process.exitCode = 1;
    }
    return;
  }
  if (sub === "list" || sub === undefined) {
    const rows = listTokens(db);
    if (!rows.length) return console.log(`${c.dim}no tokens. mint one with: fleetctl tokens add <name> --scope read${c.rst}`);
    console.log(`\n${c.bold}ID-PREFIX  NAME                  SCOPE     LAST USED       REVOKED${c.rst}`);
    console.log(c.dim + "─".repeat(70) + c.rst);
    for (const r of rows) {
      const rev = r.revoked_at ? c.red + "revoked" + c.rst : c.grn + "active" + c.rst;
      const last = r.last_used_at ? ago(r.last_used_at) : c.dim + "never" + c.rst;
      console.log(`${r.id_prefix}   ${r.name.padEnd(20)}  ${r.scope.padEnd(8)}  ${String(last).padEnd(14)}  ${rev}`);
    }
    console.log();
    return;
  }
  if (sub === "revoke") {
    const prefix = argv[2];
    if (!prefix) return console.log("usage: fleetctl tokens revoke <id-prefix>");
    try {
      const ok = revokeToken(db, prefix);
      if (ok) console.log(`${c.grn}revoked${c.rst} ${prefix}`);
      else { console.log(`${c.ylw}no live token with prefix${c.rst} ${prefix}`); process.exitCode = 1; }
    } catch (e: any) {
      console.error(`${c.red}error:${c.rst} ${e?.message ?? e}`); process.exitCode = 1;
    }
    return;
  }
  console.log("usage: fleetctl tokens <add <name> --scope read|control|admin | list | revoke <id-prefix>>");
}

/** `fleetctl pricing <sync|show>` — manage the model rate table that turns
 *  raw token counts into the cost figures the portal renders. `sync` reloads
 *  data/anthropic-pricing.json (path overridable with --file); `show` prints
 *  the current table including each row's last-synced timestamp. */
function pricing() {
  const sub = arg;
  if (sub === "sync") {
    const file = flag("file") ?? DEFAULT_PRICING_FILE;
    const n = syncPricing(db, file);
    if (n === 0) {
      console.log(`${c.ylw}no rows synced${c.rst} ${c.dim}(missing or malformed ${file})${c.rst}`);
      process.exitCode = 1;
      return;
    }
    console.log(`${c.grn}synced${c.rst} ${n} model${n === 1 ? "" : "s"} ${c.dim}from ${file}${c.rst}`);
    return;
  }
  if (sub === "show" || sub === undefined) {
    const rows = pricingRows(db);
    if (!rows.length) {
      console.log(`${c.dim}no pricing rows. run: fleetctl pricing sync${c.rst}`);
      return;
    }
    console.log(`\n${c.bold}MODEL                 IN/Mtok  OUT/Mtok  CACHE-RD  CACHE-WR  SYNCED${c.rst}`);
    console.log(c.dim + "─".repeat(72) + c.rst);
    for (const r of rows) {
      console.log(
        `${r.model.padEnd(20)}  ${("$" + r.input_per_mtok.toFixed(2)).padStart(7)}  `
        + `${("$" + r.output_per_mtok.toFixed(2)).padStart(8)}  `
        + `${("$" + r.cache_read_per_mtok.toFixed(2)).padStart(8)}  `
        + `${("$" + r.cache_write_per_mtok.toFixed(2)).padStart(8)}  `
        + `${ago(r.fetched_at)}`,
      );
    }
    console.log();
    return;
  }
  console.log("usage: fleetctl pricing <sync [--file path] | show>");
}

/** `fleetctl digest [--week|--last-7] [--save]` — ticket 0012. Prints the
 *  rolling 7-day digest as markdown to stdout. `--save` additionally
 *  writes the markdown to `$FLEET_STATE_DIR/digests/<isoweek>.md` (env
 *  override exists for tests; production falls back to
 *  `~/.local/state/fleet-control/digests/`). `--week` and `--last-7`
 *  are aliases for the same window — both spellings appear in the
 *  ticket so we accept either. */
function digest() {
  const wantSave = argv.includes("--save");
  // --week / --last-7 are aliases. We don't differentiate; both just
  // confirm the operator wants "last 7 days" (which is the only window
  // we support in v1; daily is explicitly out of scope per the ticket).
  // noCache: true so the CLI never reports stale numbers after a fresh
  // backfill on the same shell line.
  const d = weeklyDigest(db, { noCache: true });
  const md = renderDigestMarkdown(d);
  process.stdout.write(md);
  if (wantSave) {
    const stateDir = process.env.FLEET_STATE_DIR
      ?? pathJoin(homedir(), ".local", "state", "fleet-control");
    const digestsDir = pathJoin(stateDir, "digests");
    mkdirSync(digestsDir, { recursive: true });
    // Filename = ISO week of the period's *start* (we want the
    // post-Monday digest to keep landing in the same file across the
    // week — recompute is idempotent because we overwrite). Without
    // this, a Sunday recompute could shift into the next ISO week and
    // create a second file.
    const wk = isoWeekKey(new Date(d.period.start + "T12:00:00Z"));
    const path = pathJoin(digestsDir, `${wk}.md`);
    writeFileSync(path, md);
    console.error(`${c.grn}saved${c.rst} ${path}`);
  }
}

/** `fleetctl snapshot <create <name> | list | revoke <id-prefix>>` — ticket
 *  0013. Mints a shareable read-only snapshot (anonymized fleet view),
 *  prints the share URL once, and lists / revokes existing ones. The
 *  plaintext token is printed ONCE on create — same discipline as
 *  `fleetctl tokens add`. The audit row carries only the id_prefix. */
async function snapshot() {
  const sub = arg;
  if (sub === "create") {
    const name = argv.slice(2).join(" ").trim();
    if (!name) {
      console.log("usage: fleetctl snapshot create <name>");
      process.exitCode = 1; return;
    }
    try {
      // Honour an explicit FLEET_BASE_URL so an operator running the
      // server on a LAN host can mint share links their friends can
      // actually reach. Default 127.0.0.1:7070 matches the loopback
      // SPA's footer assumption.
      const baseUrl = process.env.FLEET_BASE_URL;
      const r = await doAction(db, "local", "snapshot-create",
        baseUrl ? { name, base_url: baseUrl } : { name },
        "local");
      if (!r.ok) {
        console.error(`${c.red}error:${c.rst} ${r.message}`);
        process.exitCode = 1; return;
      }
      const m = JSON.parse(r.output ?? "{}") as {
        id_prefix: string; token: string; share_url: string; name: string; expires_at: string;
      };
      console.log(`${c.grn}minted${c.rst} ${c.bold}${m.name}${c.rst} ${c.dim}(id ${m.id_prefix}, expires ${m.expires_at})${c.rst}`);
      console.log(`${c.ylw}share URL (shown once — anyone with this link can view the snapshot):${c.rst}\n  ${m.share_url}`);
    } catch (e: any) {
      console.error(`${c.red}error:${c.rst} ${e?.message ?? e}`); process.exitCode = 1;
    }
    return;
  }
  if (sub === "list" || sub === undefined) {
    const rows = listSnapshots(db);
    if (!rows.length) return console.log(`${c.dim}no snapshots. mint one with: fleetctl snapshot create <name>${c.rst}`);
    console.log(`\n${c.bold}ID-PREFIX  NAME                          CREATED          EXPIRES          STATE${c.rst}`);
    console.log(c.dim + "─".repeat(80) + c.rst);
    for (const r of rows) {
      const state = r.revoked_at
        ? c.red + "revoked" + c.rst
        : (new Date(r.expires_at).getTime() <= Date.now() ? c.dim + "expired" + c.rst : c.grn + "active" + c.rst);
      console.log(
        `${r.id_prefix}   ${r.name.padEnd(28)}  ${ago(r.created_at).padEnd(14)}   ${ago(r.expires_at).padEnd(14)}   ${state}`,
      );
    }
    console.log();
    return;
  }
  if (sub === "revoke") {
    const prefix = argv[2];
    if (!prefix) {
      console.log("usage: fleetctl snapshot revoke <id-prefix>");
      process.exitCode = 1; return;
    }
    try {
      const r = await doAction(db, "local", "snapshot-revoke", { id_prefix: prefix }, "local");
      if (r.ok) console.log(`${c.grn}revoked${c.rst} ${prefix}`);
      else { console.log(`${c.ylw}${r.message}${c.rst}`); process.exitCode = 1; }
    } catch (e: any) {
      console.error(`${c.red}error:${c.rst} ${e?.message ?? e}`); process.exitCode = 1;
    }
    return;
  }
  console.log("usage: fleetctl snapshot <create <name> | list | revoke <id-prefix>>");
  process.exitCode = 1;
}

switch (cmd) {
  case "backfill": backfill(); break;
  case "status": case undefined: status(); break;
  case "runs": runsFor(arg ?? ""); break;
  case "show": show(arg ?? ""); break;
  case "pricing": pricing(); break;
  case "snapshot": await snapshot(); break;
  case "serve": {
    db.close(); // server opens its own handle
    const host = process.env.FLEET_HOST ?? loadConfig().host ?? "127.0.0.1";
    startServer(host, Number(process.env.FLEET_PORT ?? 7070));
    break; // keep process alive (http server is listening)
  }
  case "daemon-run": { db.close(); runDaemon(Number(arg) || 60); break; } // launchd entry (long-running)
  case "daemon": {
    if (arg === "on") { installDaemon(); console.log(`${c.grn}always-on monitoring enabled${c.rst} (com.fleet.control.fleetd). Logs: ~/.local/state/fleet-control/logs/`); }
    else if (arg === "off") { uninstallDaemon(); console.log("always-on monitoring disabled."); }
    else console.log("daemon is " + (daemonStatus() ? c.grn + "ON" + c.rst : c.dim + "off (default)" + c.rst) + " — use: fleetctl daemon on|off");
    break;
  }
  case "alerts": {
    const a = openAlerts(db) as any[];
    if (!a.length) console.log("no open alerts.");
    for (const x of a) console.log(`  ${x.severity === "critical" ? c.red : c.ylw}●${c.rst} ${x.title} ${c.dim}— ${x.detail}${c.rst}`);
    break;
  }
  case "tokens": tokens(); break;
  case "digest": digest(); break;
  case "ntfy": {
    if (arg === "test") {
      const code = await ntfyTestCommand(ntfyConfigFrom(cfg));
      if (code !== 0) process.exitCode = code;
    } else {
      console.log("usage: fleetctl ntfy test");
      process.exitCode = 1;
    }
    break;
  }
  default: console.log("usage: fleetctl [backfill|status|runs <slug>|show <id>|serve|daemon on|off|alerts|tokens add|list|revoke|pricing sync|show|ntfy test|digest [--week|--last-7] [--save]|snapshot create <name>|list|revoke <id-prefix>]");
}
if (cmd !== "serve" && cmd !== "daemon-run") db.close();
