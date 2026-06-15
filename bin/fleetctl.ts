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
import { resolveWindow, isQuietNow, nextWindowEnd } from "../src/quiet_hours.ts";
import { weeklyDigest, renderDigestMarkdown, isoWeekKey } from "../src/digest.ts";
import { listSnapshots } from "../src/snapshot.ts";
import {
  computeReceipts, persistReceipts, unpublishReceipts,
  listPublishedReceipts, isValidMonthIso,
} from "../src/receipts.ts";
import { doAction } from "../src/control.ts";
import { defaultDeps, runDoctor, renderHuman, renderJson, exitCodeFor } from "../src/doctor.ts";
import { runOnboard, productionDeps as onboardProductionDeps, parseOnboardArgs, ONBOARD_HELP } from "../src/onboard.ts";
import { loadDemoFixture, DEMO_BANNER, DEMO_DEFAULT_PORT } from "../src/demo/fixture.ts";
import { firstRun, sentinelPathFor, type WelcomeOpts, type WelcomeDeps } from "../src/welcome.ts";
import { discoverLanUrl } from "../src/lan.ts";
import { mintPairToken } from "../src/pair.ts";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync as fsWriteFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { homedir, tmpdir } from "node:os";

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

/** `fleetctl receipts <publish <slug> <month> | unpublish <slug> <month> |
 *   list>` — ticket 0041. Publishes / unpublishes / lists the public
 *  monthly-receipts artifacts surfaced at /receipts/<slug>/<YYYY-MM>.
 *  Per LESSONS § "CLI subprocess tests need a FLEET_DB_PATH env seam":
 *  the helper uses the same DB the rest of the CLI does (driven by
 *  FLEET_DB_PATH in tests). The publish path is the OFFLINE direct-
 *  write shape — no HTTP round-trip required — so this CLI works
 *  whether or not `fleetctl serve` is running.
 *
 *  Why the CLI doesn't auto-detect a running server: the production
 *  use case is "operator runs fleetctl on the laptop where serve is
 *  also running" — both processes open the same SQLite file via WAL
 *  (single-writer with non-blocking readers, per src/db.ts), so a
 *  direct write here is correctly serialised against the server's
 *  reads. The shape stays simple and the same `FLEET_DB_PATH` seam
 *  drives both the test path and the production path. */
function receipts() {
  const sub = arg;
  if (sub === "publish") {
    const slug = argv[2];
    const month = argv[3];
    if (!slug || !month) {
      console.log("usage: fleetctl receipts publish <slug> <YYYY-MM>");
      process.exitCode = 1; return;
    }
    if (!isValidMonthIso(month)) {
      console.error(`${c.red}error:${c.rst} bad month_iso (expected YYYY-MM); got ${month}`);
      process.exitCode = 1; return;
    }
    if (slug !== "fleet") {
      const exists = db.prepare("SELECT 1 FROM project WHERE slug = ?").get(slug);
      if (!exists) {
        console.error(`${c.red}error:${c.rst} unknown project slug '${slug}'`);
        process.exitCode = 1; return;
      }
    }
    const baseUrl = process.env.FLEET_BASE_URL || "http://127.0.0.1:7070";
    const payload = computeReceipts(db, slug, month, new Date());
    persistReceipts(db, payload);
    const url = `${baseUrl.replace(/\/+$/, "")}/receipts/${slug}/${month}`;
    console.log(`${c.grn}published${c.rst} ${c.bold}${slug}${c.rst} ${c.dim}(${month})${c.rst}`);
    console.log(`  URL: ${url}`);
    console.log(`  ${c.dim}${payload.merged_prs} PR${payload.merged_prs === 1 ? "" : "s"} merged · ${usd(payload.total_spend_usd)} spent · ${usd(payload.cost_per_pr_usd)}/PR · ${payload.red_days} red day${payload.red_days === 1 ? "" : "s"}${c.rst}`);
    return;
  }
  if (sub === "unpublish") {
    const slug = argv[2];
    const month = argv[3];
    if (!slug || !month) {
      console.log("usage: fleetctl receipts unpublish <slug> <YYYY-MM>");
      process.exitCode = 1; return;
    }
    const n = unpublishReceipts(db, slug, month);
    if (n > 0) console.log(`${c.grn}unpublished${c.rst} ${slug} (${month})`);
    else console.log(`${c.dim}no published row for ${slug} (${month}); nothing to do${c.rst}`);
    return;
  }
  if (sub === "list" || sub === undefined) {
    const rows = listPublishedReceipts(db);
    if (!rows.length) {
      console.log(`${c.dim}no published receipts. publish one with: fleetctl receipts publish <slug> <YYYY-MM>${c.rst}`);
      return;
    }
    const baseUrl = process.env.FLEET_BASE_URL || "http://127.0.0.1:7070";
    console.log(`\n${c.bold}SLUG            MONTH     PUBLISHED         URL${c.rst}`);
    console.log(c.dim + "─".repeat(72) + c.rst);
    for (const r of rows) {
      const url = `${baseUrl.replace(/\/+$/, "")}/receipts/${r.project_slug}/${r.month_iso}`;
      console.log(`${r.project_slug.padEnd(15)} ${r.month_iso}  ${ago(r.published_at).padEnd(14)}    ${url}`);
    }
    console.log();
    return;
  }
  console.log("usage: fleetctl receipts <publish <slug> <YYYY-MM> | unpublish <slug> <YYYY-MM> | list>");
  process.exitCode = 1;
}

switch (cmd) {
  case "backfill": backfill(); break;
  case "status": case undefined: status(); break;
  case "runs": runsFor(arg ?? ""); break;
  case "show": show(arg ?? ""); break;
  case "pricing": pricing(); break;
  case "snapshot": await snapshot(); break;
  case "receipts": receipts(); break;
  case "serve": {
    db.close(); // server opens its own handle
    const serveCfg = loadConfig();
    const host = process.env.FLEET_HOST ?? serveCfg.host ?? "127.0.0.1";
    const port = Number(process.env.FLEET_PORT ?? 7070);
    // Ticket 0024 — first-run welcome. `--welcome` forces, `--no-welcome`
    // suppresses. We resolve everything we need (sentinel path, project
    // list, token source) BEFORE startServer fires onListening so the
    // callback stays a thin trigger.
    const forceWelcome = argv.includes("--welcome");
    const suppressWelcome = argv.includes("--no-welcome");
    // Ticket 0032 — `--no-pair` suppresses the pair section even when
    // the LAN URL is discoverable. Useful for headless boots and demos
    // where the QR would clutter logs.
    const suppressPair = argv.includes("--no-pair");
    const sentinelPath = sentinelPathFor(process.env);
    // Re-open a short-lived handle ONLY to read project slugs for step 3
    // and to mint the pair token if we'll be showing a QR. Using the
    // same DB the server is about to open is fine because sqlite
    // serialises writers and this is a quick SELECT + INSERT.
    let projectSlugs: string[] = [];
    let cfgAdminToken = "";
    let pairSection: { url: string; qrText: string } | undefined;
    try {
      const peekDb = openDb(serveCfg.dbPath);
      try {
        const rows = peekDb.prepare("SELECT slug FROM project ORDER BY slug LIMIT 4").all() as Array<{ slug: string }>;
        projectSlugs = rows.map((r) => r.slug);
      } finally { peekDb.close(); }
    } catch { /* fresh install — no project table yet, render the register hint */ }
    try {
      const cfgFile = pathJoin(process.cwd(), "fleet-control.config.json");
      if (existsSync(cfgFile)) {
        const raw = JSON.parse(readFileSync(cfgFile, "utf8")) as Record<string, unknown>;
        if (typeof raw.adminToken === "string") cfgAdminToken = raw.adminToken;
      }
    } catch { /* config absent — auth.ts will mint one on first serve */ }
    // Pair-section wiring. Only fires when:
    //   * --no-pair was NOT passed, AND
    //   * discoverLanUrl returns a non-null URL (operator bound LAN-side
    //     AND a non-loopback IPv4 interface is discoverable), AND
    //   * we have a plaintext admin token to mint the pair against
    //     (fresh installs without a config-file token skip the QR; the
    //     operator pairs manually until they re-run serve).
    if (!suppressPair) {
      try {
        const lanUrl = discoverLanUrl(host, port);
        if (lanUrl && cfgAdminToken) {
          const mintDb = openDb(serveCfg.dbPath);
          try {
            const mint = mintPairToken(mintDb, cfgAdminToken);
            // Human-readable URL keeps the `?t=` form so the operator
            // can type it if scanning fails. The QR-encoded variant
            // uses path-style routing (`/P/<TOKEN>`) and uppercase
            // alphanumeric so it stays inside V1-L's 25-char capacity
            // — the server's /pair route accepts both forms via the
            // same query parser (the SPA's URL after redirect is the
            // `?t=` form).
            const url = `${lanUrl}/pair?t=${mint.token}`;
            // Uppercase LAN URL plus path-style token. We accept that
            // for many home IPs (e.g. 192.168.x.y plus port 7070) the
            // QR text will exceed 25 chars; in that case the QR render
            // throws and the welcome falls back to "QR unavailable".
            const qrText = `${lanUrl.toUpperCase()}/P/${mint.token}`;
            pairSection = { url, qrText };
          } finally { mintDb.close(); }
        }
      } catch { /* never let a pair-mint failure crash serve */ }
    }
    const welcomeOpts: WelcomeOpts = {
      token: cfgAdminToken,
      host,
      port,
      configPath: pathJoin(process.cwd(), "fleet-control.config.json"),
      tokenSource: cfgAdminToken ? "config" : "new",
      color: process.stdout.isTTY === true,
      projects: projectSlugs,
      sentinelPath,
      pairSection,
    };
    const welcomeDeps: WelcomeDeps = {
      fileExists: (p) => { try { return existsSync(p); } catch { return false; } },
      writeFile: (p, body) => fsWriteFileSync(p, body),
      mkdir: (p) => mkdirSync(p, { recursive: true }),
      log: (line) => process.stdout.write(line + "\n"),
      warn: (line) => process.stderr.write(line + "\n"),
    };
    // Suppress the server's stock "fleet-control portal → ..." banner so
    // the welcome (or, on subsequent runs, its one-line quiet form) is
    // the sole stdout artifact at boot. When `--no-welcome` is set we
    // re-emit a minimal line ourselves so a daemon-style operator still
    // sees confirmation that serve actually listened.
    startServer(host, port, {
      quietBanner: true,
      onListening: () => {
        try {
          firstRun(welcomeOpts, welcomeDeps, {
            force: forceWelcome,
            suppress: suppressWelcome,
          });
          if (suppressWelcome) {
            // Mirror the legacy banner so existing scrapers don't break.
            const shown = host === "0.0.0.0" ? "localhost" : host;
            process.stdout.write(`fleet-control portal → http://${shown}:${port}\n`);
          }
        } catch { /* never let a welcome render crash the server */ }
      },
    });
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
  case "quiet-hours": {
    // `fleetctl quiet-hours` — print the effective windows for the
    // fleet default + each per-project override + the current active
    // state. No subcommand for SETTING; operators edit
    // fleet-control.config.json directly (per ticket 0030 § "matches
    // the ntfyTopic / portalUrl precedent"). Exits 0 unconditionally.
    const anyCfg = cfg as unknown as Record<string, unknown>;
    const fleetDefault = anyCfg.quietHours as
      { start: string; end: string; tz: string } | undefined;
    const overrides = (anyCfg.quietHoursOverride
      ?? {}) as Record<string, false | { start: string; end: string; tz: string }>;
    const now = new Date();
    console.log(`${c.bold}quiet-hours${c.rst} ${c.dim}— fleet-control.config.json${c.rst}`);
    if (fleetDefault) {
      const active = isQuietNow(cfg, "__fleet__", now);
      const tail = active
        ? `${c.grn}ACTIVE${c.rst} ${c.dim}— resumes ${(nextWindowEnd(cfg, "__fleet__", now) ?? new Date()).toISOString()}${c.rst}`
        : `${c.dim}inactive${c.rst}`;
      console.log(`  fleet default: ${fleetDefault.start}–${fleetDefault.end} ${c.dim}${fleetDefault.tz}${c.rst}  ${tail}`);
    } else {
      console.log(`  fleet default: ${c.dim}(none — set quietHours in fleet-control.config.json)${c.rst}`);
    }
    const slugs = Object.keys(overrides);
    if (slugs.length === 0) {
      console.log(`  per-project overrides: ${c.dim}(none)${c.rst}`);
    } else {
      console.log(`  per-project overrides:`);
      for (const slug of slugs) {
        const v = overrides[slug];
        if (v === false) {
          console.log(`    ${slug}: ${c.ylw}always page${c.rst} ${c.dim}(quiet hours disabled)${c.rst}`);
        } else {
          const win = resolveWindow(cfg, slug);
          const active = isQuietNow(cfg, slug, now);
          const tail = active ? `${c.grn}ACTIVE${c.rst}` : `${c.dim}inactive${c.rst}`;
          if (win) {
            console.log(`    ${slug}: ${win.start}–${win.end} ${c.dim}${win.tz}${c.rst}  ${tail}`);
          } else {
            console.log(`    ${slug}: ${c.red}invalid window${c.rst} ${c.dim}(falls back to fleet default)${c.rst}`);
          }
        }
      }
    }
    break;
  }
  case "demo": {
    // `fleetctl demo` — one-command sandbox (ticket 0025). Boots the
    // same server path as `serve` but against an ephemeral tmpdir DB
    // pre-seeded with the three-project demo fixture, on port 7071
    // (deliberately NOT 7070 so a real serve isn't shadowed). All
    // daemon side-effects are short-circuited via the demoMode flag
    // on startServer().
    db.close(); // server opens its own handle against the demo DB
    const wantHost = process.env.FLEET_HOST ?? "127.0.0.1";
    if (wantHost !== "127.0.0.1" && wantHost !== "localhost" && wantHost !== "::1") {
      // The fixture is not a sensitive surface, but exposing it to
      // the LAN by default makes the operator's threat model murky —
      // and a real fleet bound to 0.0.0.0 should be the production
      // serve, not the demo. Refuse the bind with a one-line message
      // and a non-zero exit so a CI sandbox can't accidentally
      // publish the demo to the network.
      process.stderr.write("demo mode refuses non-loopback binds (got FLEET_HOST=" + wantHost + ")\n");
      process.exit(2);
    }
    // Support both `--port 7071` (the existing flag()-style) and the
    // `--port=7071` shape the ticket spec uses, since the demo
    // subcommand is the first to advertise `--port=N` in its
    // user-facing usage line. Other flags can stay simple.
    const eqPort = argv.find((a) => a.startsWith("--port="))?.slice("--port=".length);
    const portFlag = eqPort ?? flag("port");
    const port = Number(portFlag ?? process.env.FLEET_PORT ?? DEMO_DEFAULT_PORT);
    // Spin up a tmpdir for the ephemeral DB. We deliberately use
    // mkdtempSync (not the operator's real ~/.local/state path) so
    // the demo never touches the real fleet history.
    const demoDir = mkdtempSync(pathJoin(tmpdir(), "fleet-demo-"));
    const demoDbPath = pathJoin(demoDir, "fleet.db");
    process.env.FLEET_DB_PATH = demoDbPath;
    // Seed the fixture BEFORE startServer opens its handle so the
    // first /api/fleet call answers with populated data.
    {
      const seedDb = openDb(demoDbPath);
      try { loadDemoFixture(seedDb); } finally { seedDb.close(); }
    }
    // Print the tmpdir to stderr so curious operators can poke at it
    // and so the SIGINT-teardown test can assert removal. Banner
    // itself goes to stdout per AC7.
    process.stderr.write("demo-tmp=" + demoDir + "\n");
    const server = startServer("127.0.0.1", port, {
      demoMode: true,
      quietBanner: true,
      onListening: () => {
        // Print the banner ONLY after the socket is actually accepting
        // connections — otherwise a fast test (or a curl pipeline) can
        // race the listen callback and hit ECONNREFUSED before the
        // first packet is accepted.
        process.stdout.write(DEMO_BANNER);
      },
    });
    // SIGINT teardown: close HTTP, close any incidental handle (the
    // server owns its own DB connection internally), rm the tmpdir,
    // exit 0. Idempotent across repeated signals — a second Ctrl-C
    // mid-teardown is a no-op.
    let tearingDown = false;
    const teardown = (): void => {
      if (tearingDown) return;
      tearingDown = true;
      try {
        server.close(() => {
          try { rmSync(demoDir, { recursive: true, force: true }); } catch { /* gone already */ }
          process.exit(0);
        });
      } catch {
        try { rmSync(demoDir, { recursive: true, force: true }); } catch { /* */ }
        process.exit(0);
      }
      // Safety net: if the server.close callback never fires (a
      // misbehaving keep-alive connection), force-exit after 500ms.
      setTimeout(() => {
        try { rmSync(demoDir, { recursive: true, force: true }); } catch { /* */ }
        process.exit(0);
      }, 500).unref();
    };
    process.on("SIGINT", teardown);
    process.on("SIGTERM", teardown);
    break;
  }
  case "onboard": {
    // `fleetctl onboard [--non-interactive] [--skip <list>] [--help]` —
    // interactive wizard (ticket 0046). Composes existing helpers
    // (0010 register-url, 0021 budget, 0030 quiet hours, 0032 LAN+QR,
    // 0003 token mint, 0016 doctor liveness probe, 0024 welcome
    // checklist). Per LESSONS 2026-05-29 "when a CLI subcommand adds
    // boot output, take ownership of the listen banner" — the onboard
    // branch owns its full stdout; no other module prints during the
    // wizard.
    const parsed = parseOnboardArgs(argv.slice(1));
    if (parsed.help) {
      process.stdout.write(ONBOARD_HELP);
      break;
    }
    try {
      const deps = onboardProductionDeps(db, {
        nonInteractive: parsed.nonInteractive,
        skip: parsed.skip,
      });
      await runOnboard(deps);
      process.exitCode = 0;
    } catch (e: any) {
      process.stderr.write(`onboard: crashed — ${String(e?.message ?? e)}\n`);
      process.exitCode = 2;
    }
    break;
  }
  case "doctor": {
    // `fleetctl doctor [--json]` — one-shot install + ingest diagnostic
    // (ticket 0016). Wraps runDoctor() in a try/catch so a doctor crash
    // exits 2 (per spec) without dragging the rest of the CLI down.
    try {
      const wantJson = argv.includes("--json");
      // FLEET_DOCTOR_OFFLINE=1 short-circuits the network / launchctl
      // probes so the CLI subprocess tests stay hermetic (no real
      // `gh`, `launchctl`, or loopback connect attempts).
      const offline = process.env.FLEET_DOCTOR_OFFLINE === "1";
      const result = await runDoctor(defaultDeps(db), { offline });
      if (wantJson) process.stdout.write(renderJson(result) + "\n");
      else process.stdout.write(renderHuman(result, { color: process.stdout.isTTY === true }));
      process.exitCode = exitCodeFor(result);
    } catch (e: any) {
      process.stderr.write(`doctor: crashed — ${String(e?.message ?? e)}\n`);
      process.exitCode = 2;
    }
    break;
  }
  default: console.log("usage: fleetctl [backfill|status|runs <slug>|show <id>|serve|demo [--port=N]|daemon on|off|alerts|tokens add|list|revoke|pricing sync|show|ntfy test|quiet-hours|digest [--week|--last-7] [--save]|snapshot create <name>|list|revoke <id-prefix>|receipts publish <slug> <YYYY-MM>|unpublish <slug> <YYYY-MM>|list|doctor [--json]|onboard [--non-interactive] [--skip <list>] [--help]]");
}
if (cmd !== "serve" && cmd !== "daemon-run" && cmd !== "demo") db.close();
