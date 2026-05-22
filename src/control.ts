// Control actions — the "management" layer. Every action shells out with an
// argv array (execFile, never a shell string → no injection), reuses the
// agent-fleet kit + launchctl, and writes a control_audit row. Reinstall-type
// actions are guarded against a currently-firing run.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { DB } from "./db.ts";

const UID = process.getuid?.() ?? 0;
const KIT_INSTALL = join(homedir(), "Desktop", "projects", "agent-fleet", "lib", "install.sh");
const PHASES = ["ship", "groom", "review", "eng"];

interface Proj { id: number; slug: string; namespace: string; manifest_path: string; }
const VALID = (s: string, re: RegExp) => typeof s === "string" && re.test(s);

function project(db: DB, slug: string): Proj {
  const p = db.prepare("SELECT id,slug,namespace,manifest_path FROM project WHERE slug=?").get(slug) as Proj | undefined;
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
function audit(db: DB, actor: string, action: string, target: string, args: unknown, exit: number, out: string) {
  db.prepare("INSERT INTO control_audit(ts,actor,action,target,args_json,exit_code,stdout_tail) VALUES(?,?,?,?,?,?,?)")
    .run(new Date().toISOString(), actor, action, target, JSON.stringify(args), exit, out.slice(-500));
}

export interface ActionResult { ok: boolean; message: string; output?: string; }

export function doAction(db: DB, actor: string, action: string, body: any): ActionResult {
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
        editManifest(p.manifest_path, "SELF_CANCEL", ymd);
        out = run("bash", [KIT_INSTALL, dirname(p.manifest_path)]);
        message = `${slug} will keep running for ${days} more days.`; break;
      }
      case "eng-toggle": {            // turn the eng (tidy-the-code) queue on/off
        if (isRunning(p)) { ok = false; message = "A job is running right now — try again in a minute."; break; }
        const on = body.enabled ? "1" : "0";
        editManifest(p.manifest_path, "ENG_ENABLED", on);
        out = run("bash", [KIT_INSTALL, dirname(p.manifest_path)]);
        message = `Code-tidying ${on === "1" ? "enabled" : "disabled"} for ${slug}.`; break;
      }
      default: throw new Error(`unknown action '${action}'`);
    }
  } catch (e: any) {
    ok = false; message = String(e?.message ?? e); out = (e?.stderr ?? "") + (e?.stdout ?? "");
  }
  audit(db, actor, action, `${slug}/${body?.phase ?? "*"}`, body, ok ? 0 : 1, out);
  return { ok, message, output: out.slice(-400) || undefined };
}

/** Key-targeted line rewrite of a shell manifest (preserves comments/order). */
function editManifest(path: string, key: string, value: string): void {
  if (!existsSync(path)) throw new Error("manifest not found");
  const text = readFileSync(path, "utf8");
  const re = new RegExp(`^(${key}=)("?)([^"#\\n]*)("?)(.*)$`, "m");
  if (!re.test(text)) throw new Error(`${key} not in manifest`);
  writeFileSync(path, text.replace(re, `$1"${value}"$5`));
}
