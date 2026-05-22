// Live-state engine — probed FRESH per request (never cached): is a job running
// now + its current action, and when it fires next. Zero LLM calls.
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FleetConfig } from "./config.ts";
import { transcriptDirFor } from "./config.ts";

const UID = process.getuid?.() ?? 0;
const SUBS = ["checkout", "review-checkout", "eng-checkout", "groom-checkout"];

export interface JobLive {
  running: boolean;
  loaded: boolean;
  paused: boolean;
  lastExit: number | null;
  currentAction: string | null;
  next: string | null; // ISO, or null if won't fire
}

// launchctl disabled-state (paused) set, cached briefly (one call covers all jobs).
let _disabled: { at: number; set: Set<string> } | null = null;
function disabledSet(): Set<string> {
  if (_disabled && Date.now() - _disabled.at < 4000) return _disabled.set;
  const set = new Set<string>();
  try {
    const out = execFileSync("launchctl", ["print-disabled", `gui/${UID}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const m of out.matchAll(/"([^"]+)"\s*=>\s*(?:true|disabled)/g)) set.add(m[1]);
  } catch { /* none */ }
  _disabled = { at: Date.now(), set };
  return set;
}

function launchctlState(label: string): { running: boolean; loaded: boolean; lastExit: number | null } {
  try {
    const out = execFileSync("launchctl", ["print", `gui/${UID}/${label}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const running = /\bstate = running\b/.test(out);
    const m = out.match(/last exit code = (-?\d+)/);
    return { running, loaded: true, lastExit: m ? Number(m[1]) : null };
  } catch {
    return { running: false, loaded: false, lastExit: null };
  }
}

/** Tail the active transcript for this phase to summarize the current action. */
function currentAction(cfg: FleetConfig, aliasSlugs: string[], phase: string): string | null {
  const wantSub =
    phase === "review" ? "review-checkout" : phase === "eng" ? "eng-checkout" : "checkout";
  for (const slug of aliasSlugs) {
    const dir = join(cfg.claudeProjects, transcriptDirFor(join(cfg.cacheBase, `${slug}-agent`, wantSub)));
    if (!existsSync(dir)) continue;
    let newest: { path: string; mtime: number } | null = null;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const st = statSync(join(dir, f));
      if (!newest || st.mtimeMs > newest.mtime) newest = { path: join(dir, f), mtime: st.mtimeMs };
    }
    if (!newest || Date.now() - newest.mtime > 3 * 60_000) continue; // stale → not the live run
    const tail = readFileSync(newest.path, "utf8").trimEnd().split("\n").slice(-40);
    for (let i = tail.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(tail[i]);
        const content = o.message?.content;
        if (Array.isArray(content))
          for (let j = content.length - 1; j >= 0; j--) {
            const c = content[j];
            if (c.type === "tool_use") {
              const d = typeof c.input === "object" ? (c.input.description ?? c.input.command ?? c.input.file_path ?? "") : "";
              return `${c.name}${d ? ": " + String(d).slice(0, 80) : ""}`;
            }
          }
      } catch { /* skip */ }
    }
  }
  return null;
}

/** Next scheduled fire (local time), or null if self-cancelled. */
export function nextFire(cadence: Record<string, string>, phase: string, selfCancel: string, now = new Date()): string | null {
  if (selfCancel && /^\d{8}$/.test(selfCancel)) {
    const y = +selfCancel.slice(0, 4), mo = +selfCancel.slice(4, 6) - 1, d = +selfCancel.slice(6, 8);
    if (now.getTime() >= Date.UTC(y, mo, d)) return null; // past self-cancel → won't fire
  }
  const at = (hours: number[], minute: number): Date => {
    for (let add = 0; add < 8; add++) {
      const day = new Date(now); day.setDate(now.getDate() + (add > 0 ? 1 : 0));
      for (const h of hours.sort((a, b) => a - b)) {
        const t = new Date(day); t.setHours(h, minute, 0, 0);
        if (t.getTime() > now.getTime()) return t;
      }
    }
    return now;
  };
  if (phase === "ship") {
    const min = +(cadence.ship_minute ?? 41);
    const t = new Date(now); t.setMinutes(min, 0, 0);
    if (t.getTime() <= now.getTime()) t.setHours(now.getHours() + 1);
    return t.toISOString();
  }
  if (phase === "groom") return at((cadence.groom_hours ?? "0 6 12 18").split(/\s+/).map(Number), +(cadence.groom_minute ?? 17)).toISOString();
  if (phase === "eng" && cadence.eng_hours) return at(cadence.eng_hours.split(/\s+/).map(Number), +(cadence.eng_minute ?? 23)).toISOString();
  if (phase === "review") return new Date(now.getTime() + (+(cadence.review_interval ?? 300)) * 1000).toISOString(); // ≈ every N s
  return null;
}

export function jobLive(cfg: FleetConfig, label: string, cadence: Record<string, string>, phase: string, selfCancel: string, aliasSlugs: string[]): JobLive {
  const s = launchctlState(label);
  const paused = disabledSet().has(label);
  return {
    running: s.running,
    loaded: s.loaded,
    paused,
    lastExit: s.lastExit,
    currentAction: s.running ? currentAction(cfg, aliasSlugs, phase) : null,
    next: paused ? null : (s.loaded ? nextFire(cadence, phase, selfCancel) : null),
  };
}

export function selfCancelDays(selfCancel: string, now = new Date()): number | null {
  if (!selfCancel || !/^\d{8}$/.test(selfCancel)) return null;
  const y = +selfCancel.slice(0, 4), mo = +selfCancel.slice(4, 6) - 1, d = +selfCancel.slice(6, 8);
  return Math.floor((Date.UTC(y, mo, d) - now.getTime()) / 86_400_000);
}
