// Live-state engine — probed FRESH per request (never cached): is a job running
// now + its current action, and when it fires next. Zero LLM calls.
//
// Also home to the SSE tail (ticket 0002): tailTranscript() backfills the
// active jsonl with readline + watches it with fs.watch for incremental
// updates, re-opens against a newer file when a run rotates, and self-closes
// after a configurable idle window. parseTranscriptLine() is exported for
// unit tests and is the single point that turns a Claude transcript JSONL
// entry into the wire events the SSE stream emits.
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync, statSync, readFileSync, createReadStream, watch as fsWatch, type FSWatcher } from "node:fs";
import { createInterface } from "node:readline";
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

/** Find the live transcript for a running phase + summarize its current action + elapsed. */
export function activeRun(cfg: FleetConfig, aliasSlugs: string[], phase: string): { action: string | null; elapsedMs: number | null } {
  const wantSub = phase === "review" ? "review-checkout" : phase === "eng" ? "eng-checkout" : "checkout";
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
    const lines = readFileSync(newest.path, "utf8").trimEnd().split("\n");
    let startMs: number | null = null;
    for (const ln of lines) { try { const o = JSON.parse(ln); if (o.timestamp) { startMs = new Date(o.timestamp).getTime(); break; } } catch { /* */ } }
    let action: string | null = null;
    for (let i = lines.length - 1; i >= 0 && !action; i--) {
      try {
        const content = JSON.parse(lines[i]).message?.content;
        if (Array.isArray(content))
          for (let j = content.length - 1; j >= 0; j--) {
            const c = content[j];
            if (c.type === "tool_use") {
              const d = typeof c.input === "object" ? (c.input.description ?? c.input.command ?? c.input.file_path ?? "") : "";
              action = `${c.name}${d ? ": " + String(d).slice(0, 80) : ""}`; break;
            }
          }
      } catch { /* */ }
    }
    return { action, elapsedMs: startMs ? Date.now() - startMs : null };
  }
  return { action: null, elapsedMs: null };
}
function currentAction(cfg: FleetConfig, aliasSlugs: string[], phase: string): string | null {
  return activeRun(cfg, aliasSlugs, phase).action;
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
    // SHIP_HOURS is optional. When set, ship behaves like groom/eng (fires only
    // at the listed hours). When empty, the original "every hour at :MM" path.
    const hours = (cadence.ship_hours ?? "").trim();
    if (hours) return at(hours.split(/\s+/).map(Number), min).toISOString();
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

// ───── SSE live tool-call tail (ticket 0002) ──────────────────────────────

/** One event in the live SSE tail stream. The shape that
 *  /api/projects/:slug/stream forwards to the browser. */
export interface TailEvent {
  /** Wire name for the SSE `event:` field. */
  type: "open" | "tool-call" | "text" | "rotate" | "idle-close" | "error";
  /** Payload for the SSE `data:` field (when applicable). */
  data?: any;
  /** Absolute path of the transcript file (set on open + rotate). */
  path?: string;
}

export interface TailController {
  /** Stop watching and release the underlying fd/timers. Idempotent. */
  close: () => void;
}

interface TailOptions {
  /** Close the stream after this long without new bytes. Default 5 min. */
  idleMs?: number;
  /** Rotation poll interval (ms). Default 2s. */
  pollMs?: number;
  /** Override the alias slugs scanned for transcript dirs. Default [slug]. */
  aliasSlugs?: string[];
  /** Restrict scanning to a single phase's checkout subdir
   *  (`checkout` | `review-checkout` | `eng-checkout` | `groom-checkout`).
   *  Default: scan all four and pick the newest. */
  phase?: string;
}

const PHASE_SUBS = ["checkout", "review-checkout", "eng-checkout", "groom-checkout"];

/** Locate the most recently-modified .jsonl transcript for `slug`.
 *  Returns null when no transcript exists for any of the slug's checkout dirs. */
export function findActiveTranscript(
  cfg: FleetConfig,
  slug: string,
  aliasSlugs?: string[],
  phase?: string,
): { path: string; mtimeMs: number } | null {
  const slugs = aliasSlugs && aliasSlugs.length ? aliasSlugs : [slug];
  const subs = phase ? [phaseToSub(phase)] : PHASE_SUBS;
  let best: { path: string; mtimeMs: number } | null = null;
  for (const s of slugs) {
    for (const sub of subs) {
      const dir = join(cfg.claudeProjects, transcriptDirFor(join(cfg.cacheBase, `${s}-agent`, sub)));
      if (!existsSync(dir)) continue;
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith(".jsonl")) continue;
        const full = join(dir, f);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (!best || st.mtimeMs > best.mtimeMs) best = { path: full, mtimeMs: st.mtimeMs };
      }
    }
  }
  return best;
}

function phaseToSub(phase: string): string {
  if (phase === "review") return "review-checkout";
  if (phase === "eng") return "eng-checkout";
  if (phase === "groom") return "groom-checkout";
  return "checkout";
}

/** Parse one transcript JSONL entry into 0..N wire events.
 *  Returns [] for malformed lines so the caller can skip silently. */
export function parseTranscriptLine(line: string): TailEvent[] {
  const s = line.trim();
  if (!s) return [];
  let o: any;
  try { o = JSON.parse(s); } catch { return []; }
  if (!o || typeof o !== "object") return [];
  const content = o.message?.content;
  if (!Array.isArray(content)) return [];
  const out: TailEvent[] = [];
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "tool_use") {
      const name = typeof c.name === "string" ? c.name : "tool";
      const head = renderToolInputHead(c.input);
      out.push({ type: "tool-call", data: { name, input_head: head } });
    } else if (c.type === "text" && typeof c.text === "string") {
      out.push({ type: "text", data: { text: c.text.slice(0, 500) } });
    }
  }
  return out;
}

function renderToolInputHead(input: unknown): string {
  if (input == null) return "";
  let s: string;
  if (typeof input === "string") s = input;
  else if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    const pick = o.command ?? o.file_path ?? o.path ?? o.description ?? o.pattern ?? o.url;
    if (typeof pick === "string") s = pick;
    else { try { s = JSON.stringify(input); } catch { s = String(input); } }
  } else s = String(input);
  return s.slice(0, 200);
}

/**
 * Tail the active transcript jsonl for `slug` and call `onEvent` for each
 * parsed entry (and for lifecycle events: open/rotate/idle-close).
 *
 * Mechanics:
 *  - Backfill: createReadStream + readline streams the file from byte 0,
 *    so the operator sees what's already happened on connect.
 *  - Incremental: fs.watch wakes us when the file grows; we read only the
 *    new bytes and parse complete lines.
 *  - Rotation: a poll loop (every `pollMs`, default 2s) checks for a
 *    different newest .jsonl; if found, we close the current tail and
 *    re-open against the new one. This also covers the "new run started"
 *    case from ticket 0001 — fresh mtime is the universal signal.
 *  - Idle: a rolling timer closes the tail after `idleMs` of no new bytes,
 *    emitting an `idle-close` event first so the SSE peer can react.
 */
export function tailTranscript(
  cfg: FleetConfig,
  slug: string,
  onEvent: (e: TailEvent) => void,
  opts: TailOptions = {},
): TailController {
  const idleMs = Math.max(1, opts.idleMs ?? 5 * 60_000);
  const pollMs = Math.max(20, opts.pollMs ?? 2_000);
  const aliasSlugs = opts.aliasSlugs;
  const phase = opts.phase;

  let closed = false;
  let watcher: FSWatcher | null = null;
  let currentPath: string | null = null;
  let offset = 0;
  let partial = "";
  let reading = false;
  let pending = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let rotateTimer: NodeJS.Timeout | null = null;
  let firstAttach = true;

  const safeEmit = (e: TailEvent) => { if (!closed) { try { onEvent(e); } catch { /* swallow */ } } };

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (closed) return;
      safeEmit({ type: "idle-close" });
      close();
    }, idleMs);
  };

  const drainFrom = () => {
    if (closed) return;
    const path = currentPath;
    if (!path) return;
    if (reading) { pending = true; return; }
    reading = true;
    // Snapshot the path we're draining; if attach() rotates us before this
    // read finishes, we must discard the result rather than corrupt offset.
    const readingPath = path;
    let size = 0;
    try { size = statSync(readingPath).size; } catch { reading = false; return; }
    if (size === offset) { reading = false; if (pending) { pending = false; drainFrom(); } return; }
    if (size < offset) {
      // File was truncated — rare for jsonl but be defensive: re-read from 0.
      offset = 0;
      partial = "";
    }
    const stream = createReadStream(readingPath, { start: offset, end: size - 1, encoding: "utf8" });
    let buf = partial;
    partial = "";
    stream.on("data", (chunk: string | Buffer) => { buf += typeof chunk === "string" ? chunk : chunk.toString("utf8"); });
    stream.on("end", () => {
      // If we rotated mid-read, drop everything we just read — the new
      // attach() already reset offset/partial for the new file.
      if (readingPath !== currentPath) {
        reading = false;
        if (pending) { pending = false; drainFrom(); }
        return;
      }
      const lastNl = buf.lastIndexOf("\n");
      if (lastNl >= 0) {
        const complete = buf.slice(0, lastNl);
        partial = buf.slice(lastNl + 1);
        for (const line of complete.split("\n")) {
          for (const ev of parseTranscriptLine(line)) safeEmit(ev);
        }
      } else {
        partial = buf;
      }
      offset = size;
      armIdle();
      reading = false;
      if (pending) { pending = false; drainFrom(); }
    });
    stream.on("error", () => { reading = false; if (pending) { pending = false; drainFrom(); } });
  };

  const attach = (path: string) => {
    if (watcher) { try { watcher.close(); } catch { /* */ } watcher = null; }
    currentPath = path;
    offset = 0;
    partial = "";
    safeEmit({ type: firstAttach ? "open" : "rotate", path });
    firstAttach = false;
    try {
      watcher = fsWatch(path, { persistent: false }, () => { drainFrom(); });
    } catch {
      // fs.watch may fail (e.g. very old macOS/Linux without inotify). Fall
      // back to the poll loop already running below.
      watcher = null;
    }
    drainFrom();
    armIdle();
  };

  // Initial attach (if a transcript already exists) and rotation poll.
  const tryRotate = () => {
    if (closed) return;
    const found = findActiveTranscript(cfg, slug, aliasSlugs, phase);
    if (found && found.path !== currentPath) {
      attach(found.path);
    } else if (found && found.path === currentPath) {
      // No rotation, but the file may have grown without fs.watch firing
      // (e.g. on some networked filesystems). Drain defensively.
      drainFrom();
    }
  };
  tryRotate();
  rotateTimer = setInterval(tryRotate, pollMs);

  function close() {
    if (closed) return;
    closed = true;
    if (watcher) { try { watcher.close(); } catch { /* */ } watcher = null; }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (rotateTimer) { clearInterval(rotateTimer); rotateTimer = null; }
  }

  return { close };
}

// readline is required by the contract (ticket engineering note) but the
// streaming drain above uses createReadStream + manual newline split, which
// is more efficient for small appends and avoids creating a readline
// Interface on every fs.watch event. We use readline here for the one-shot
// backfill helper below — exposed for callers that prefer line-callbacks.
export async function readTranscriptLines(path: string, onLine: (line: string) => void): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => onLine(line));
    rl.on("close", () => resolve());
    rl.on("error", reject);
    stream.on("error", reject);
  });
}
