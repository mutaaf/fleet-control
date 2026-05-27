// Control actions — the "management" layer. Every action shells out with an
// argv array (execFile, never a shell string → no injection), reuses the
// agent-fleet kit + launchctl, and writes a control_audit row. Reinstall-type
// actions are guarded against a currently-firing run.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, readdirSync, mkdirSync, cpSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { DB } from "./db.ts";
import { loadConfig } from "./config.ts";
import * as auth from "./auth.ts";
import { cleanCheckouts, safeRmUnder } from "./infra.ts";
import { createSnapshot, revokeSnapshot } from "./snapshot.ts";
import { fleetView } from "./views.ts";

const UID = process.getuid?.() ?? 0;
const KIT = join(homedir(), "Desktop", "projects", "agent-fleet");
const KIT_INSTALL = join(KIT, "lib", "install.sh");
const PHASES = ["ship", "groom", "review", "eng"];
// Actions that need a real project; everything else (register, tokens-*)
// is handled specially below before the per-project work begins.
const KNOWN_ACTIONS = new Set([
  "kickstart", "pause", "resume", "keep-running", "eng-toggle",
  "pr-merge", "pr-changes", "pr-close", "create-ticket", "register",
  "register-url",
  "tokens-add", "tokens-revoke",
  "clean-checkouts",
  // Ticket 0013: read-only share snapshots. snapshot-create freezes
  // the anonymized fleet view; snapshot-revoke kills a live link.
  "snapshot-create", "snapshot-revoke",
  // Cadence control (this PR). set-cadence is per-(project,phase) fine
  // control; set-pace is a named preset for one project; set-pace-fleet
  // applies a preset across every project at once.
  "set-cadence", "set-pace", "set-pace-fleet",
  // Budget cap control — writes MAX_DAILY_USD to the manifest so the
  // operator doesn't have to hand-edit agents.config.sh + reinstall.
  "set-budget",
]);

/** Strict regex for GitHub HTTPS repo URLs (ticket 0010). Owner/name must
 *  match GitHub's own character set (letters, digits, `.`, `_`, `-`) and
 *  the URL must terminate at the repo (with an optional bare `.git`
 *  suffix). Anything else — SSH, http, query strings, extra path segments,
 *  shell metas — is rejected upstream of any child process. */
const GH_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\.git)?$/;

// Cadence keys that set-cadence / set-pace may write to the manifest. Any key
// not in this list is rejected — keeps the action from being a generic
// manifest-editor that could clobber identity fields.
const CADENCE_KEYS = new Set([
  "SHIP_HOURS", "SHIP_MINUTE", "GROOM_HOURS", "GROOM_MINUTE",
  "REVIEW_INTERVAL", "ENG_HOURS", "ENG_MINUTE",
]);

/** Four named paces. Each maps to a full cadence set so the operator can
 * slow a project (or the whole fleet) down with one click. Aggressive is the
 * historical default (no SHIP_HOURS → ship every hour). Steady, conservative
 * and trickle dial things down progressively — used when a project is under
 * rate-limit or account-suspension pressure. */
const PACE_PRESETS: Record<string, Record<string, string>> = {
  aggressive: {
    SHIP_HOURS: "", SHIP_MINUTE: "41",
    GROOM_HOURS: "0 6 12 18", GROOM_MINUTE: "17",
    REVIEW_INTERVAL: "300",
    ENG_HOURS: "3 9 15 21", ENG_MINUTE: "23",
  },
  steady: {
    SHIP_HOURS: "0 2 4 6 8 10 12 14 16 18 20 22", SHIP_MINUTE: "41",
    GROOM_HOURS: "0 12", GROOM_MINUTE: "17",
    REVIEW_INTERVAL: "900",
    ENG_HOURS: "0 12", ENG_MINUTE: "23",
  },
  conservative: {
    SHIP_HOURS: "0 6 12 18", SHIP_MINUTE: "41",
    GROOM_HOURS: "0", GROOM_MINUTE: "17",
    REVIEW_INTERVAL: "1800",
    ENG_HOURS: "0", ENG_MINUTE: "23",
  },
  trickle: {
    SHIP_HOURS: "0 12", SHIP_MINUTE: "41",
    GROOM_HOURS: "0", GROOM_MINUTE: "17",
    REVIEW_INTERVAL: "3600",
    ENG_HOURS: "0", ENG_MINUTE: "23",
  },
};

function applyCadence(p: Proj, values: Record<string, string>): string {
  const mdir = manifestDirFor(p);
  const mfile = manifestFileFor(p);
  for (const [key, value] of Object.entries(values)) {
    if (!CADENCE_KEYS.has(key)) continue; // ignore unknown keys silently
    editOrAppendManifest(mfile, key, String(value));
  }
  return run("bash", [KIT_INSTALL, mdir]);
}

/** Prefer the working-tree manifest if it still exists (so edits land where the
 * user can `git commit` them, and install.sh has a distinct src/dst for cp).
 * Fall back to whatever path the DB has (e.g. installed copy if the working
 * tree was deleted). */
function manifestDirFor(p: Proj): string {
  const cfg = loadConfig();
  for (const root of cfg.projectRoots) {
    const candidate = join(root, p.slug);
    if (existsSync(join(candidate, "agents.config.sh"))) return candidate;
  }
  return dirname(p.manifest_path);
}
function manifestFileFor(p: Proj): string {
  return join(manifestDirFor(p), "agents.config.sh");
}

interface Proj { id: number; slug: string; namespace: string; manifest_path: string; repo_owner: string; repo_name: string; repo_url: string; }
const VALID = (s: string, re: RegExp) => typeof s === "string" && re.test(s);
const repoOf = (p: Proj) => `${p.repo_owner}/${p.repo_name}`;

function project(db: DB, slug: string): Proj {
  const p = db.prepare("SELECT id,slug,namespace,manifest_path,repo_owner,repo_name,repo_url FROM project WHERE slug=?").get(slug) as unknown as Proj | undefined;
  if (!p) throw new Error(`unknown project '${slug}'`);
  return p;
}
function label(p: Proj, phase: string): string {
  if (!PHASES.includes(phase)) throw new Error(`bad phase '${phase}'`);
  return `${p.namespace}.agent-${phase}`;
}
/** Shell-out indirection (ticket 0010). Production code paths all execFile
 *  with an argv array — never a shell string — and the test suite swaps
 *  this for a recording stub via `_setRunnerForTests()`. The leading
 *  underscore on the swap helpers signals "test seam only, never call in
 *  production" (same convention as `_resetDedupForTests` in src/ntfy.ts). */
type Runner = (cmd: string, args: string[]) => string;
const defaultRunner: Runner = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
let activeRunner: Runner = defaultRunner;
function run(cmd: string, args: string[]): string { return activeRunner(cmd, args); }
export function _setRunnerForTests(fn: Runner): void { activeRunner = fn; }
export function _resetRunnerForTests(): void { activeRunner = defaultRunner; }
function isRunning(p: Proj): boolean {
  return runningPhases(p).length > 0;
}

/** Names of phases currently `state = running` under launchd, for friendlier
 *  error messages: "ship is mid-run — apply anyway?" beats a generic block. */
function runningPhases(p: Proj): string[] {
  const r: string[] = [];
  for (const ph of PHASES) {
    try {
      if (/\bstate = running\b/.test(run("launchctl", ["print", `gui/${UID}/${label(p, ph)}`]))) r.push(ph);
    } catch { /* not loaded */ }
  }
  return r;
}

/** "running, retry with force" result shape. The SPA recognizes
 *  `code: "running"` and prompts the operator with a confirm before retrying
 *  the same action with `force: true`. Always include the list of phases so
 *  the prompt can say "ship is running" rather than the vague original
 *  "a job is running". */
function runningResult(phases: string[]): ActionResult {
  const list = phases.join(" + ");
  return {
    ok: false,
    message: `${list} ${phases.length === 1 ? "is" : "are"} mid-run — applying now will cut the current run short.`,
    code: "running",
    running: phases,
  };
}
function audit(db: DB, actor: string, action: string, target: string, args: unknown, exit: number, out: string, actorName?: string) {
  db.prepare("INSERT INTO control_audit(ts,actor,action,target,args_json,exit_code,stdout_tail,actor_name) VALUES(?,?,?,?,?,?,?,?)")
    .run(
      new Date().toISOString(), actor, action, target, JSON.stringify(args),
      exit, out.slice(-500),
      actorName ?? (actor === "local" ? "local" : null),
    );
}

export interface ActionResult {
  ok: boolean;
  message: string;
  output?: string;
  /** When `ok=false` and `code` is set, the SPA can branch on the reason
   *  rather than parsing the human message. Today the only code is
   *  "running" — the operator can retry the same call with `force=true`
   *  to terminate the in-flight job and apply anyway. */
  code?: string;
  running?: string[];
}

export async function doAction(db: DB, actor: string, action: string, body: any, actorName?: string): Promise<ActionResult> {
  if (!KNOWN_ACTIONS.has(action)) throw new Error(`unknown action '${action}'`);
  if (action === "register") return registerProject(db, body); // no existing project
  if (action === "register-url") return registerFromUrl(db, body, actor, actorName);
  if (action === "tokens-add" || action === "tokens-revoke") return tokensAction(db, action, body, actor, actorName);
  if (action === "snapshot-create" || action === "snapshot-revoke") {
    return snapshotAction(db, action, body, actor, actorName);
  }
  if (action === "set-pace-fleet") return setPaceFleet(db, body, actor, actorName);
  const slug = body?.slug;
  if (!VALID(slug, /^[\w-]{1,40}$/)) throw new Error("bad slug");
  const p = project(db, slug);
  let out = "", ok = true, message = "";

  try {
    switch (action) {
      case "kickstart": {            // run a job now
        const lbl = label(p, body.phase);
        out = run("launchctl", ["kickstart", "-k", `gui/${UID}/${lbl}`]);
        message = `Started ${body.phase} for ${slug}.`; break;
      }
      case "pause": {                // pause one job (or all if phase omitted)
        const phs = body.phase ? [body.phase] : PHASES;
        for (const ph of phs) { try { out += run("launchctl", ["disable", `gui/${UID}/${label(p, ph)}`]); } catch { /* phase may not exist */ } }
        message = body.phase ? `Paused ${body.phase} for ${slug}.` : `Paused ${slug}.`; break;
      }
      case "resume": {
        const phs = body.phase ? [body.phase] : PHASES;
        for (const ph of phs) { try { out += run("launchctl", ["enable", `gui/${UID}/${label(p, ph)}`]); } catch { /* */ } }
        message = body.phase ? `Resumed ${body.phase} for ${slug}.` : `Resumed ${slug}.`; break;
      }
      case "keep-running": {          // bump SELF_CANCEL + reinstall
        const days = Math.max(1, Math.min(365, Number(body.days) || 30));
        if (!body?.force) {
          const phs = runningPhases(p);
          if (phs.length) { audit(db, actor, action, `${slug}/*`, body, 1, "", actorName); return runningResult(phs); }
        }
        const d = new Date(Date.now() + days * 86_400_000);
        const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
        const mdir = manifestDirFor(p);
        editManifest(manifestFileFor(p), "SELF_CANCEL", ymd);
        out = run("bash", [KIT_INSTALL, mdir]);
        message = `${slug} will keep running for ${days} more days.`; break;
      }
      case "eng-toggle": {            // turn the eng (tidy-the-code) queue on/off
        if (!body?.force) {
          const phs = runningPhases(p);
          if (phs.length) { audit(db, actor, action, `${slug}/*`, body, 1, "", actorName); return runningResult(phs); }
        }
        const on = body.enabled ? "1" : "0";
        const mdir = manifestDirFor(p);
        editManifest(manifestFileFor(p), "ENG_ENABLED", on);
        out = run("bash", [KIT_INSTALL, mdir]);
        message = `Code-tidying ${on === "1" ? "enabled" : "disabled"} for ${slug}.`; break;
      }
      case "pr-merge": {              // "Approve & publish" — arm auto-merge (lands when CI green)
        const n = Number(body.number); if (!n) throw new Error("bad PR number");
        out = run("gh", ["pr", "merge", String(n), "--repo", repoOf(p), "--squash", "--auto"]);
        message = `PR #${n} approved — it will publish when checks pass.`; break;
      }
      case "pr-changes": {            // "Send back with a note"
        const n = Number(body.number); if (!n) throw new Error("bad PR number");
        out = run("gh", ["pr", "review", String(n), "--repo", repoOf(p), "--request-changes", "--body", String(body.note || "Changes requested via fleet-control.")]);
        message = `Sent PR #${n} back with your note.`; break;
      }
      case "pr-close": {              // "Discard this work"
        const n = Number(body.number); if (!n) throw new Error("bad PR number");
        out = run("gh", ["pr", "close", String(n), "--repo", repoOf(p)]);
        message = `Discarded PR #${n}.`; break;
      }
      case "create-ticket": {         // "Tell it what to build"
        const url = createTicket(p, body);
        message = `Added to ${slug}'s build list — opened as ${url.trim()}`; out = url; break;
      }
      case "set-cadence": {           // per-phase fine control over how often each agent runs
        if (!body?.force) {
          const phs = runningPhases(p);
          if (phs.length) { audit(db, actor, action, `${slug}/*`, body, 1, "", actorName); return runningResult(phs); }
        }
        out = applyCadence(p, body || {});
        message = `Schedule updated for ${slug}.`; break;
      }
      case "set-pace": {              // named preset (aggressive | steady | conservative | trickle)
        const preset = String(body?.preset || "").toLowerCase();
        const cfg = PACE_PRESETS[preset];
        if (!cfg) throw new Error(`unknown pace '${preset}' — use aggressive, steady, conservative, or trickle`);
        if (!body?.force) {
          const phs = runningPhases(p);
          if (phs.length) { audit(db, actor, action, `${slug}/*`, body, 1, "", actorName); return runningResult(phs); }
        }
        out = applyCadence(p, cfg);
        message = `${slug} set to ${preset} pace.`; break;
      }
      case "set-budget": {            // daily $ cap (MAX_DAILY_USD)
        // body.max_daily_usd: number > 0 sets a cap; 0 / "" / null unsets it.
        // The engine reads MAX_DAILY_USD via `${MAX_DAILY_USD:-}` so an
        // empty string is treated as "no cap" — we don't need a separate
        // remove path.
        //
        // Crucially, set-budget does NOT need to run install.sh: the cap is
        // a plain manifest env var read at fire time, not a launchd plist
        // setting. So this action is safe even while a job is running —
        // the running job keeps its already-sourced env, and the next fire
        // picks up the new cap. We just copy the working-tree manifest
        // straight to the installed location with cpSync.
        const raw = body?.max_daily_usd;
        let cap = "";
        if (raw !== null && raw !== undefined && raw !== "") {
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) throw new Error("max_daily_usd must be a non-negative number");
          if (n > 0) cap = (Math.round(n * 100) / 100).toString();
        }
        const mfile = manifestFileFor(p);
        editOrAppendManifest(mfile, "MAX_DAILY_USD", cap);
        const installed = join(homedir(), ".local", "share", "agent-fleet", "projects", p.slug, "agents.config.sh");
        if (existsSync(dirname(installed))) cpSync(mfile, installed);
        out = "";
        message = cap
          ? `Daily cap set to $${cap} for ${slug}.`
          : `Daily cap cleared for ${slug}.`;
        break;
      }
      case "clean-checkouts": {       // janitor pass over ~/.cache/<slug>-agent-*-checkout
        // Refuse while a job is in flight — its checkout is presumably the
        // working tree, and `rm -rf` underneath a running process is exactly
        // the kind of footgun this ticket exists to prevent.
        if (isRunning(p)) { ok = false; message = "A job is running right now — try again in a minute."; break; }
        const days = Number.isFinite(Number(body?.older_than_days))
          ? Math.max(0, Math.min(365, Number(body.older_than_days)))
          : 14;
        const report = await cleanCheckouts(slug, days);
        out = report.removed.join("\n");
        message = report.removed.length
          ? `Removed ${report.removed.length} stale checkout${report.removed.length === 1 ? "" : "s"} (>${days}d) for ${slug}.`
          : `No stale checkouts older than ${days}d for ${slug}.`;
        break;
      }
      default: throw new Error(`unknown action '${action}'`);
    }
  } catch (e: any) {
    ok = false; message = String(e?.message ?? e); out = (e?.stderr ?? "") + (e?.stdout ?? "");
  }
  audit(db, actor, action, `${slug}/${body?.phase ?? "*"}`, body, ok ? 0 : 1, out, actorName);
  return { ok, message, output: out.slice(-400) || undefined };
}

/** API surface for the share-snapshot CLI/portal (ticket 0013).
 *  snapshot-create returns the plaintext token + share_url ONCE; the
 *  control_audit row carries the 8-char id_prefix only. snapshot-revoke
 *  takes an id-prefix and flips revoked_at. Both go through the same
 *  audit() helper as the rest of doAction so a stolen admin token's
 *  misuse leaves an inspectable trail. */
function snapshotAction(db: DB, action: string, body: any, actor: string, actorName?: string): ActionResult {
  try {
    if (action === "snapshot-create") {
      const name = String(body?.name ?? "").trim();
      // Resolve the fleet view: the server passes the freshly-computed
      // one via body.fleet_view (so the snapshot freezes exactly what
      // the operator just saw on the home page). The CLI doesn't pass
      // one — we compute it here from the live DB + config.
      const view = body?.fleet_view ?? fleetView(db, loadConfig());
      const baseUrl = typeof body?.base_url === "string" ? body.base_url : undefined;
      const m = createSnapshot(db, {
        name,
        fleetView: view,
        ttl_hours: body?.ttl_hours,
        baseUrl,
      });
      // Audit args carry the id_prefix + name + ttl — NEVER the plaintext
      // token. We construct the audit args explicitly so a careless
      // body.token smuggled in by a future caller can't leak.
      audit(db, actor, "snapshot-create", m.id_prefix, {
        name: m.name, id_prefix: m.id_prefix, expires_at: m.expires_at,
      }, 0, "", actorName);
      return {
        ok: true,
        message: `minted snapshot '${m.name}'`,
        // The CLI prints token + share_url from this JSON. The server's
        // /api/control/snapshot-create handler proxies the same JSON to
        // the SPA so the operator's screen shows the URL once.
        output: JSON.stringify({
          id_prefix: m.id_prefix,
          token: m.token,
          share_url: m.share_url,
          name: m.name,
          expires_at: m.expires_at,
        }),
      };
    }
    if (action === "snapshot-revoke") {
      const prefix = String(body?.id_prefix ?? body?.prefix ?? "");
      const ok = revokeSnapshot(db, prefix);
      audit(db, actor, "snapshot-revoke", prefix, { id_prefix: prefix }, ok ? 0 : 1, "", actorName);
      return ok
        ? { ok: true, message: `revoked snapshot ${prefix}` }
        : { ok: false, message: `no live snapshot with prefix ${prefix}` };
    }
    return { ok: false, message: `unknown snapshot action '${action}'` };
  } catch (e: any) {
    audit(db, actor, action, String(body?.id_prefix ?? body?.name ?? "?"), { name: body?.name }, 1, String(e?.message ?? e), actorName);
    return { ok: false, message: String(e?.message ?? e) };
  }
}

/** API surface for the token CLI/portal. tokens-add returns the plaintext
 *  ONCE in the response (the caller must show it to the operator and never
 *  log it). tokens-revoke takes an id-prefix. Both write a control_audit
 *  row so we can see who minted/revoked what. */
function tokensAction(db: DB, action: string, body: any, actor: string, actorName?: string): ActionResult {
  try {
    if (action === "tokens-add") {
      const name = String(body?.name ?? "");
      const scope = String(body?.scope ?? "");
      // Cast widens the runtime string into the Scope literal type;
      // mintToken does its own validation and throws on a bad scope.
      const m = auth.mintToken(db, name, scope as auth.Scope);
      audit(db, actor, "tokens-add", `${m.name}/${m.scope}`, { name: m.name, scope: m.scope, id_prefix: m.id_prefix }, 0, "", actorName);
      // The plaintext token IS in the response body — the caller (CLI or
      // portal) shows it once. The audit row above carries only id_prefix.
      return { ok: true, message: `minted token '${m.name}' (${m.scope})`, output: JSON.stringify(m) };
    }
    if (action === "tokens-revoke") {
      const prefix = String(body?.id_prefix ?? body?.prefix ?? "");
      const ok = auth.revokeToken(db, prefix);
      audit(db, actor, "tokens-revoke", prefix, { id_prefix: prefix }, ok ? 0 : 1, "", actorName);
      return ok
        ? { ok: true, message: `revoked token ${prefix}` }
        : { ok: false, message: `no live token with prefix ${prefix}` };
    }
    return { ok: false, message: `unknown tokens action '${action}'` };
  } catch (e: any) {
    audit(db, actor, action, String(body?.name ?? body?.id_prefix ?? "?"), body, 1, String(e?.message ?? e), actorName);
    return { ok: false, message: String(e?.message ?? e) };
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** "Tell it what to build" — write a ticket + index row in a temp clone, PR it. */
function createTicket(p: Proj, body: any): string {
  const title = String(body.title || "").trim();
  if (!title) throw new Error("a title is required");
  const tmp = mkdtempSync(join(tmpdir(), "fleet-tkt-"));
  try {
    run("git", ["clone", "--depth=1", p.repo_url, tmp]);
    const bdir = join(tmp, "docs", "backlog");
    if (!existsSync(bdir)) throw new Error("this project has no docs/backlog/ yet");
    const ids = readdirSync(bdir).filter((f) => /^\d{4}-.*\.md$/.test(f)).map((f) => +f.slice(0, 4));
    const id = String(Math.max(0, ...ids) + 1).padStart(4, "0");
    const status = body.idea ? "proposed" : "groomed";
    const pri = /^P[0-3]$/.test(body.priority) ? body.priority : "P2";
    const area = VALID(body.area, /^[\w-]{1,30}$/) ? body.area : "growth";
    const crit: string[] = Array.isArray(body.criteria) ? body.criteria.filter((c: string) => c && c.trim()) : [];
    const file = `---
id: ${id}
title: ${title}
status: ${status}
priority: ${pri}
area: ${area}
created: ${today()}
owner: gtm-innovation
---

## User story

${body.story?.trim() || title}

## Why now (four lenses)

(Added via the control plane. The groom agent will enrich the Product Owner /
Stakeholder / User / Growth lenses on its next pass.)

## Acceptance criteria

${crit.length ? crit.map((c) => `- [ ] ${c.trim()}`).join("\n") : "- [ ] TODO"}

## Out of scope

- ${body.outOfScope?.trim() || "..."}

## Engineering notes

- (to be detailed by the dev agent)

## Implementation log
`;
    writeFileSync(join(bdir, `${id}-${kebab(title)}.md`), file);

    // append a row to the README index table (validator requires file<->index sync)
    const rpath = join(bdir, "README.md");
    let r = readFileSync(rpath, "utf8");
    const row = `| ${id} | ${title} | ${pri} | ${status} | ${area} |`;
    const lines = r.split("\n");
    let at = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (/^\|\s*\d{4}\s*\|/.test(lines[i])) { at = i; break; }
    if (at < 0) for (let i = 0; i < lines.length; i++) if (/^\|\s*-+\s*\|/.test(lines[i])) { at = i; break; }
    if (at < 0) throw new Error("couldn't find the backlog index table");
    lines.splice(at + 1, 0, row);
    writeFileSync(rpath, lines.join("\n"));

    // validate locally before pushing (don't open a broken PR)
    const validator = join(tmp, "scripts", "check-backlog.mjs");
    if (existsSync(validator)) run("node", ["--disable-warning=ExperimentalWarning", validator]);

    const branch = `chore/gtm-tkt-${id}`;
    run("git", ["-C", tmp, "checkout", "-b", branch]);
    run("git", ["-C", tmp, "add", "-A"]);
    run("git", ["-C", tmp, "-c", "user.name=Fleet Control", "-c", "user.email=noreply@anthropic.com", "commit", "-m", `GTM: add ticket ${id} — ${title}`]);
    run("git", ["-C", tmp, "push", "-u", "origin", branch]);
    return run("gh", ["pr", "create", "--repo", repoOf(p), "--base", "main", "--head", branch,
      "--title", `GTM: ${title}`, "--body", `Ticket ${id} added via fleet-control.\n\nStatus: ${status} · ${pri} · ${area}`]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** "Add a project" (Path A: connect a folder) — set up fleet files + install. */
function registerProject(db: DB, body: any): ActionResult {
  const path = String(body.path || "");
  if (!path.startsWith("/") || !existsSync(path)) return { ok: false, message: "give an absolute path to an existing folder" };
  if (!existsSync(join(path, ".git"))) return { ok: false, message: "that folder isn't a git repo" };
  const remote = (readFileSync(join(path, ".git", "config"), "utf8").match(/^\s*url\s*=\s*(.+)$/m) || [])[1]?.trim();
  if (!remote) return { ok: false, message: "couldn't find a git remote (push it to GitHub first)" };
  const slug = kebab(body.slug || basename(path));
  const name = String(body.name || basename(path));
  const { out } = scaffoldAndInstall(path, { slug, name, remote, days: body.days, eng: !!body.eng });
  audit(db, "register", "register", slug, { path }, 0, out);
  return { ok: true, message: `Connected ${name}. It will start working on its schedule. Review its AGENTS.md § Agent parameters before its first run.`, output: out.slice(-300) };
}

/** Post-clone scaffold + launchd install — shared between Path A
 *  (register) and Path B (register-url). Pure side-effects on the
 *  filesystem + a single `bash install.sh` shell-out. Throws on install
 *  failure so the caller can choose whether to clean up the dest dir
 *  (register-url does; register doesn't because the operator owns the
 *  folder). */
interface ScaffoldOpts { slug: string; name: string; remote: string; days?: number; eng?: boolean; }
function scaffoldAndInstall(path: string, opts: ScaffoldOpts): { out: string } {
  const days = Math.max(1, Math.min(365, Number(opts.days) || 30));
  const d = new Date(Date.now() + days * 86_400_000);
  const sc = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  // 1) manifest
  const manifest = join(path, "agents.config.sh");
  if (!existsSync(manifest))
    writeFileSync(manifest, `PROJECT_NAME="${opts.name}"\nSLUG="${opts.slug}"\nNAMESPACE="com.${opts.slug}"\nREPO_URL="${opts.remote.replace(/\.git$/, "")}"\nMODEL="claude-opus-4-7"\nGIT_AUTHOR_NAME="${opts.name} Agent"\nGIT_AUTHOR_EMAIL="noreply@anthropic.com"\nSELF_CANCEL="${sc}"\nSHIP_MINUTE=41\nGROOM_HOURS="0 6 12 18"\nGROOM_MINUTE=17\nREVIEW_INTERVAL=300\nENG_ENABLED=${opts.eng ? 1 : 0}\n`);
  // 2) backlog scaffold + validator
  const bdir = join(path, "docs", "backlog");
  if (!existsSync(bdir)) {
    mkdirSync(bdir, { recursive: true });
    const tmpl = join(KIT, "templates", "backlog", "_template.md");
    if (existsSync(tmpl)) cpSync(tmpl, join(bdir, "_template.md"));
    else writeFileSync(join(bdir, "_template.md"), "# ticket template\n");
    writeFileSync(join(bdir, "README.md"), `# Backlog\n\n| id | title | priority | status | area |\n|----|-------|----------|--------|------|\n`);
  }
  const sdir = join(path, "scripts");
  if (!existsSync(join(sdir, "check-backlog.mjs"))) {
    mkdirSync(sdir, { recursive: true });
    const v = join(KIT, "templates", "scripts", "check-backlog.mjs");
    if (existsSync(v)) cpSync(v, join(sdir, "check-backlog.mjs"));
  }
  // 3) AGENTS.md § Agent parameters
  const agents = join(path, "AGENTS.md");
  const section = existsSync(join(KIT, "templates", "AGENTS.section.md"))
    ? readFileSync(join(KIT, "templates", "AGENTS.section.md"), "utf8")
    : "## Agent parameters\n";
  if (!existsSync(agents)) writeFileSync(agents, `# AGENTS.md\n\n${section}`);
  else if (!/##\s*Agent parameters/.test(readFileSync(agents, "utf8"))) writeFileSync(agents, readFileSync(agents, "utf8") + "\n\n" + section);
  // 4) install launchd
  const out = run("bash", [KIT_INSTALL, path]);
  return { out };
}

/** "Add a project" (Path B: paste a GitHub URL, ticket 0010) — verify, clone,
 *  scaffold + install. Strict regex on `repo_url` is the FIRST line so a
 *  shell-meta payload never reaches a child process. On any mid-flow
 *  failure (gh, clone, install) the partial `<projectRoots[0]>/<slug>`
 *  dir is removed via `safeRmUnder()` (path-prefix guarded on
 *  projectRoots[0]). The control_audit row carries `repo_url`+`slug` only
 *  — no tokens are persisted even if the caller smuggled one through. */
async function registerFromUrl(db: DB, body: any, actor: string, actorName?: string): Promise<ActionResult> {
  const repoUrl = String(body?.repo_url ?? "");
  // Hard gate BEFORE any work — the regex is anchored on both ends and only
  // permits GitHub's own character set for owner/name, so a `;rm -rf /`
  // tail can't slip past it and we never compose a shell string anyway.
  if (!GH_URL_RE.test(repoUrl)) {
    audit(db, actor, "register-url", "?", { repo_url: repoUrl, slug: null, error: "bad_url" }, 1, "", actorName);
    return { ok: false, message: "bad_url — must look like https://github.com/<owner>/<name>" };
  }
  // owner/name extraction is regex-validated above; `.git` suffix is
  // optional in the URL and stripped from the slug derivation.
  const cleaned = repoUrl.replace(/\.git$/, "");
  const ownerName = cleaned.slice("https://github.com/".length); // <owner>/<name>
  const repoName = ownerName.split("/")[1];
  const slug = kebab(body?.slug || repoName);
  if (!slug || !/^[\w-]{1,40}$/.test(slug)) {
    audit(db, actor, "register-url", "?", { repo_url: repoUrl, slug }, 1, "", actorName);
    return { ok: false, message: "bad slug derived from URL" };
  }
  const name = String(body?.name || repoName);
  const cfg = loadConfig();
  const root = cfg.projectRoots[0];
  if (!root) {
    audit(db, actor, "register-url", slug, { repo_url: repoUrl, slug }, 1, "", actorName);
    return { ok: false, message: "no projectRoots configured" };
  }
  const dest = join(root, slug);
  // Collision check: existing dir on disk OR existing DB row.
  const existsDb = db.prepare("SELECT 1 FROM project WHERE slug=?").get(slug);
  if (existsSync(dest) || existsDb) {
    audit(db, actor, "register-url", slug, { repo_url: repoUrl, slug, error: "slug_exists" }, 1, "", actorName);
    return { ok: false, message: `slug_exists — '${slug}' is already registered` };
  }
  // 1) gh repo view — proves the operator has access without leaking creds
  //    into our argv. Failure → repo_unreachable; never proceed to clone.
  try { run("gh", ["repo", "view", ownerName, "--json", "name"]); }
  catch (e: any) {
    const tail = String(e?.stderr ?? e?.stdout ?? e?.message ?? "").slice(-300);
    audit(db, actor, "register-url", slug, { repo_url: repoUrl, slug, error: "repo_unreachable" }, 1, tail, actorName);
    return { ok: false, message: "repo_unreachable — `gh repo view` could not see the repo", output: tail };
  }
  // 2) git clone into projectRoots[0]/<slug>. --depth=50 keeps the clone small
  //    enough for first run while leaving the agent room to look back.
  try { run("git", ["clone", "--depth=50", repoUrl, dest]); }
  catch (e: any) {
    const tail = String(e?.stderr ?? e?.stdout ?? e?.message ?? "").slice(-300);
    // Belt-and-braces: if a stray dest dir slipped through, clean it up.
    try { await safeRmUnder(root, dest); } catch { /* */ }
    audit(db, actor, "register-url", slug, { repo_url: repoUrl, slug, error: "clone_failed" }, 1, tail, actorName);
    return { ok: false, message: "clone_failed — git clone exited non-zero", output: tail };
  }
  // 3) Delegate to scaffoldAndInstall — same code path Path A uses.
  try {
    const { out } = scaffoldAndInstall(dest, { slug, name, remote: cleaned, days: body?.days, eng: !!body?.eng });
    audit(db, actor, "register-url", slug, { repo_url: repoUrl, slug }, 0, out, actorName);
    return {
      ok: true,
      message: `Connected ${name}. It will start working on its schedule. Review its AGENTS.md § Agent parameters before its first run.`,
      output: out.slice(-300),
    };
  } catch (e: any) {
    const tail = String(e?.stderr ?? e?.stdout ?? e?.message ?? "").slice(-300);
    try { await safeRmUnder(root, dest); } catch { /* */ }
    audit(db, actor, "register-url", slug, { repo_url: repoUrl, slug, error: "register_failed" }, 1, tail, actorName);
    return { ok: false, message: "register_failed — post-clone scaffold/install threw", output: tail };
  }
}

/** Key-targeted line rewrite of a shell manifest (preserves comments/order).
 *  Errors if the key is missing — used for required fields like SELF_CANCEL. */
function editManifest(path: string, key: string, value: string): void {
  if (!existsSync(path)) throw new Error("manifest not found");
  const text = readFileSync(path, "utf8");
  const re = new RegExp(`^(${key}=)("?)([^"#\\n]*)("?)(.*)$`, "m");
  if (!re.test(text)) throw new Error(`${key} not in manifest`);
  writeFileSync(path, text.replace(re, `$1"${value}"$5`));
}

/** Same as editManifest, but appends a new line when the key isn't present.
 *  Needed for optional cadence keys (e.g. SHIP_HOURS) that older manifests
 *  pre-dated; set-cadence / set-pace use this so a fresh slowdown works on
 *  any manifest regardless of vintage. */
function editOrAppendManifest(path: string, key: string, value: string): void {
  if (!existsSync(path)) throw new Error("manifest not found");
  const text = readFileSync(path, "utf8");
  const re = new RegExp(`^(${key}=)("?)([^"#\\n]*)("?)(.*)$`, "m");
  if (re.test(text)) {
    writeFileSync(path, text.replace(re, `$1"${value}"$5`));
  } else {
    const pad = text.endsWith("\n") ? "" : "\n";
    writeFileSync(path, text + pad + `${key}="${value}"\n`);
  }
}

/** Apply a named pace preset to every project that isn't currently running.
 *  Returns an aggregated result so the UI can show "applied to 3 of 5 — 2 had
 *  a job firing." Running projects are reported so the operator can retry. */
function setPaceFleet(db: DB, body: any, actor: string, actorName?: string): ActionResult {
  const preset = String(body?.preset || "").toLowerCase();
  const cfg = PACE_PRESETS[preset];
  if (!cfg) return { ok: false, message: `unknown pace '${preset}' — use aggressive, steady, conservative, or trickle` };
  const projects = db.prepare("SELECT id,slug,namespace,manifest_path,repo_owner,repo_name,repo_url FROM project").all() as unknown as Proj[];
  const applied: string[] = [], skipped: Array<{ slug: string; reason: string }> = [];
  for (const p of projects) {
    try {
      applyCadence(p, cfg);
      applied.push(p.slug);
      audit(db, actor, "set-pace", `${p.slug}/*`, { preset, source: "fleet" }, 0, "ok", actorName);
    } catch (e: any) {
      const reason = String(e?.message ?? e).slice(0, 200);
      skipped.push({ slug: p.slug, reason });
      audit(db, actor, "set-pace", `${p.slug}/*`, { preset, source: "fleet" }, 1, reason, actorName);
    }
  }
  const ok = skipped.length === 0;
  const parts: string[] = [];
  if (applied.length) parts.push(`set ${applied.length} project${applied.length === 1 ? "" : "s"} to ${preset}`);
  if (skipped.length) parts.push(`skipped ${skipped.length} (${skipped.map((s) => s.slug).join(", ")} — try again in a minute)`);
  return { ok, message: parts.join("; "), output: JSON.stringify({ applied, skipped }) };
}
