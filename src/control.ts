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

const UID = process.getuid?.() ?? 0;
const KIT = join(homedir(), "Desktop", "projects", "agent-fleet");
const KIT_INSTALL = join(KIT, "lib", "install.sh");
const PHASES = ["ship", "groom", "review", "eng"];
// Actions that need a real project; everything else (register, tokens-*)
// is handled specially below before the per-project work begins.
const KNOWN_ACTIONS = new Set([
  "kickstart", "pause", "resume", "keep-running", "eng-toggle",
  "pr-merge", "pr-changes", "pr-close", "create-ticket", "register",
  "tokens-add", "tokens-revoke",
]);

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
function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
}
function isRunning(p: Proj): boolean {
  return PHASES.some((ph) => {
    try { return /\bstate = running\b/.test(run("launchctl", ["print", `gui/${UID}/${label(p, ph)}`])); }
    catch { return false; }
  });
}
function audit(db: DB, actor: string, action: string, target: string, args: unknown, exit: number, out: string, actorName?: string) {
  db.prepare("INSERT INTO control_audit(ts,actor,action,target,args_json,exit_code,stdout_tail,actor_name) VALUES(?,?,?,?,?,?,?,?)")
    .run(
      new Date().toISOString(), actor, action, target, JSON.stringify(args),
      exit, out.slice(-500),
      actorName ?? (actor === "local" ? "local" : null),
    );
}

export interface ActionResult { ok: boolean; message: string; output?: string; }

export function doAction(db: DB, actor: string, action: string, body: any, actorName?: string): ActionResult {
  if (!KNOWN_ACTIONS.has(action)) throw new Error(`unknown action '${action}'`);
  if (action === "register") return registerProject(db, body); // no existing project
  if (action === "tokens-add" || action === "tokens-revoke") return tokensAction(db, action, body, actor, actorName);
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
        if (isRunning(p)) { ok = false; message = "A job is running right now — try again in a minute."; break; }
        const d = new Date(Date.now() + days * 86_400_000);
        const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
        const mdir = manifestDirFor(p);
        editManifest(manifestFileFor(p), "SELF_CANCEL", ymd);
        out = run("bash", [KIT_INSTALL, mdir]);
        message = `${slug} will keep running for ${days} more days.`; break;
      }
      case "eng-toggle": {            // turn the eng (tidy-the-code) queue on/off
        if (isRunning(p)) { ok = false; message = "A job is running right now — try again in a minute."; break; }
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
      default: throw new Error(`unknown action '${action}'`);
    }
  } catch (e: any) {
    ok = false; message = String(e?.message ?? e); out = (e?.stderr ?? "") + (e?.stdout ?? "");
  }
  audit(db, actor, action, `${slug}/${body?.phase ?? "*"}`, body, ok ? 0 : 1, out, actorName);
  return { ok, message, output: out.slice(-400) || undefined };
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
  const days = Math.max(1, Math.min(365, Number(body.days) || 30));
  const d = new Date(Date.now() + days * 86_400_000);
  const sc = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

  // 1) manifest
  const manifest = join(path, "agents.config.sh");
  if (!existsSync(manifest))
    writeFileSync(manifest, `PROJECT_NAME="${name}"\nSLUG="${slug}"\nNAMESPACE="com.${slug}"\nREPO_URL="${remote.replace(/\.git$/, "")}"\nMODEL="claude-opus-4-7"\nGIT_AUTHOR_NAME="${name} Agent"\nGIT_AUTHOR_EMAIL="noreply@anthropic.com"\nSELF_CANCEL="${sc}"\nSHIP_MINUTE=41\nGROOM_HOURS="0 6 12 18"\nGROOM_MINUTE=17\nREVIEW_INTERVAL=300\nENG_ENABLED=${body.eng ? 1 : 0}\n`);
  // 2) backlog scaffold + validator
  const bdir = join(path, "docs", "backlog");
  if (!existsSync(bdir)) {
    mkdirSync(bdir, { recursive: true });
    cpSync(join(KIT, "templates", "backlog", "_template.md"), join(bdir, "_template.md"));
    writeFileSync(join(bdir, "README.md"), `# Backlog\n\n| id | title | priority | status | area |\n|----|-------|----------|--------|------|\n`);
  }
  const sdir = join(path, "scripts");
  if (!existsSync(join(sdir, "check-backlog.mjs"))) { mkdirSync(sdir, { recursive: true }); cpSync(join(KIT, "templates", "scripts", "check-backlog.mjs"), join(sdir, "check-backlog.mjs")); }
  // 3) AGENTS.md § Agent parameters
  const agents = join(path, "AGENTS.md");
  const section = existsSync(join(KIT, "templates", "AGENTS.section.md")) ? readFileSync(join(KIT, "templates", "AGENTS.section.md"), "utf8") : "## Agent parameters\n";
  if (!existsSync(agents)) writeFileSync(agents, `# AGENTS.md\n\n${section}`);
  else if (!/##\s*Agent parameters/.test(readFileSync(agents, "utf8"))) writeFileSync(agents, readFileSync(agents, "utf8") + "\n\n" + section);
  // 4) install launchd
  const out = run("bash", [KIT_INSTALL, path]);
  audit(db, "register", "register", slug, { path }, 0, out);
  return { ok: true, message: `Connected ${name}. It will start working on its schedule. Review its AGENTS.md § Agent parameters before its first run.`, output: out.slice(-300) };
}

/** Key-targeted line rewrite of a shell manifest (preserves comments/order). */
function editManifest(path: string, key: string, value: string): void {
  if (!existsSync(path)) throw new Error("manifest not found");
  const text = readFileSync(path, "utf8");
  const re = new RegExp(`^(${key}=)("?)([^"#\\n]*)("?)(.*)$`, "m");
  if (!re.test(text)) throw new Error(`${key} not in manifest`);
  writeFileSync(path, text.replace(re, `$1"${value}"$5`));
}
