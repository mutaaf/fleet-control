// `fleetctl onboard` — interactive wizard that collapses the seven-step
// cold-start funnel into one terminal flow (ticket 0046).
//
// Pure COMPOSITION on top of helpers shipped by tickets 0010 (register-
// url), 0021 (daily budget via MAX_DAILY_USD), 0030 (quiet hours),
// 0032 (LAN IP + ASCII QR), 0003 (token mint), 0024 (welcome
// checklist), 0016 (doctor liveness probe), and the existing
// `fleetctl install` daemonisation path. No new schema, no new HTTP
// route, no new runtime dependency.
//
// Discipline:
//   * Every side effect routes through the `OnboardDeps` surface so
//     tests stub each layer without spawning real shells, real
//     networks, or real launchd jobs (LESSONS § "shell-out modules
//     need an injectable runner for tests").
//   * The wizard owns its full stdout — no banner double-fire
//     (LESSONS 2026-05-29 § "when a CLI subcommand adds boot output,
//     take ownership of the listen banner").
//   * Operator-visible strings pass through `redactSecrets` at the
//     renderer boundary, EXCEPT the Step-5 token-reveal line which is
//     by design printing the value (LESSONS § "defence-in-depth
//     secret redaction at the renderer boundary").
//   * Module-level "have we run before in this process" state exposes
//     a `_resetOnboardForTests()` seam (LESSONS § "in-process dedup
//     sets need an explicit reset hook for tests").
//   * All helpers imported at the top — no lazy require, no late
//     dynamic import (LESSONS § "don't fake a lazy require in an ESM
//     file; just import").
//
// Zero new runtime deps. Imports `node:fs/promises`-style sync
// counterparts from `node:fs` plus the already-vendored helpers.

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { execFile } from "node:child_process";
import * as readline from "node:readline";
import type { DB } from "./db.ts";
import { loadConfig } from "./config.ts";
import { doAction } from "./control.ts";
import { discoverLanUrl } from "./lan.ts";
import { renderQrAscii } from "./qr.ts";
import { mintToken } from "./auth.ts";

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export type StepName =
  | "detect"
  | "register-url"
  | "budget"
  | "quiet-hours"
  | "pair"
  | "open";

export const ALL_STEPS: readonly StepName[] = [
  "detect", "register-url", "budget", "quiet-hours", "pair", "open",
];

export interface OnboardResult {
  steps_run: StepName[];
  steps_skipped: StepName[];
}

export interface DetectedProject {
  slug: string;
  path: string;
  alreadyRegistered: boolean;
}

/** Injected dependency surface — every side-effecting call routes
 *  through one of these so every step is unit-testable. Production
 *  code wires the defaults from `productionDeps(db)` below. */
export interface OnboardDeps {
  /** When true, the wizard never prompts — every step accepts its
   *  documented default. The CLI flag is `--non-interactive` / `--yes`. */
  nonInteractive: boolean;
  /** Comma-separated step names to skip. The CLI flag is `--skip
   *  <list>`. Unrecognised names are ignored (forward-compat). */
  skip?: StepName[];
  /** Read one line from the operator. The prompt is rendered to
   *  stdout BEFORE the read so the operator sees what they're
   *  answering. Test stubs pre-seed an inputs queue. */
  readLine: (prompt: string) => Promise<string>;
  /** Write a chunk of text to stdout. Tests record the writes; production
   *  pipes them to `process.stdout.write`. The wizard takes ownership
   *  of every line — no banner is printed from any other module while
   *  the wizard is running. */
  write: (s: string) => void;
  /** Load the current `fleet-control.config.json` content as a plain
   *  object. The wizard does a read-merge-write cycle so unrelated
   *  config keys (`adminToken`, `ntfyTopic`, `projectRoots`, etc.) are
   *  never clobbered. */
  loadConfig: () => Record<string, unknown>;
  /** Persist the merged config back to disk. Production writes
   *  pretty-printed JSON to the same path; tests record the call. */
  saveConfig: (next: Record<string, unknown>) => void;
  /** Scan the operator's project roots for `agents.config.sh` and
   *  return one entry per directory found. Synchronous because the
   *  walk is shallow (one readdir per root). */
  detectLocalProjects: (roots: string[]) => DetectedProject[];
  /** Register a local project (Path A — operator owns the folder).
   *  Reuses the SAME helper Path A `register` action uses today. */
  registerLocalProject: (slug: string, path: string) =>
    Promise<{ ok: boolean; slug: string; message?: string }>;
  /** Register a project from a GitHub URL (Path B). Reuses the SAME
   *  helper `register-url` action uses today (ticket 0010). The wizard
   *  forwards whatever the operator typed; URL validation lives in
   *  the helper (strict regex, no shell-string composition). */
  registerFromGitHubUrl: (url: string) =>
    Promise<{ ok: boolean; slug?: string; message?: string }>;
  /** Set the daily $ cap for one project (writes MAX_DAILY_USD via
   *  ticket 0021's `set-budget` action). The wizard calls this for
   *  every registered project after Step 1+2. */
  setProjectBudget: (slug: string, dollars: number) =>
    Promise<{ ok: boolean; message?: string }>;
  /** Read the current budget cap for a project, in $/day, or null if
   *  unset. Used by Step 3's idempotent default. */
  getProjectBudget: (slug: string) => number | null;
  /** List currently-registered project slugs. Used by Step 3
   *  (apply budget to every registered project) and Step 6
   *  ("<N> projects registered" summary). */
  listRegisteredSlugs: () => string[];
  /** Write the quiet-hours window under the `quietHours` key of
   *  `fleet-control.config.json` (ticket 0030). Read-merge-write under
   *  the hood; never clobbers other keys. */
  setQuietHoursWindow: (start: string, end: string, tz: string) => void;
  /** Read the current quiet-hours window, or null if unset. Used by
   *  Step 4's idempotent default. */
  getQuietHoursWindow: () =>
    { start: string; end: string; tz: string } | null;
  /** Detect the LAN URL (ticket 0032's `discoverLanUrl`) or null when
   *  no non-loopback IPv4 interface is available. */
  detectLanUrl: () => string | null;
  /** Render the ASCII QR for a payload (ticket 0032's
   *  `renderQrAscii`). The caller is responsible for upper-casing
   *  and shaping the text to fit V1-L alphanumeric capacity. */
  renderAsciiQr: (text: string) => string;
  /** Mint a fresh admin-scoped token OR read the existing one from
   *  `fleet-control.config.json` (ticket 0003's helper). The returned
   *  shape distinguishes the two so Step 5 can decide whether to
   *  print the "this is your ONLY chance to see this" warning. */
  mintOrLoadToken: () => { token: string; source: "config" | "new" };
  /** Is `fleetctl serve` already running? Reuses the same loopback
   *  probe `fleetctl doctor`'s `checkAdminSocket` uses. */
  isServeRunning: () => Promise<boolean>;
  /** Start `fleetctl serve` in the background — reuses the SAME
   *  daemonisation path `fleetctl install` uses (launchd plist via
   *  `installDaemon()`). The wizard NEVER inherits stdout from the
   *  spawned process — launchd carries its own log paths so the
   *  wizard's stdout stays clean. */
  startServeInBackground: () => Promise<{ ok: boolean; message?: string }>;
  /** Compute the welcome-checklist progress (X done out of Y total)
   *  using the SAME shape the 0024 banner exposes. The wizard reports
   *  this as the closing line of Step 6. */
  welcomeChecklistProgress: () => { done: number; total: number };
  /** Default IANA tz to write into the quiet-hours window when the
   *  operator accepts defaults. Resolved from
   *  `Intl.DateTimeFormat().resolvedOptions().timeZone` in production. */
  tz: string;
  /** Loopback portal URL — printed in Step 6's closing summary. */
  portUrl: string;
  /** The roots `detectLocalProjects` walks (`cfg.projectRoots`). */
  projectRoots: string[];
}

// ────────────────────────────────────────────────────────────────────
// Module-level "have we run before in this process" flag.
// Idempotency AC8 does NOT depend on this flag in the obvious sense
// (the wizard re-reads state from `deps` every time, so a re-run is
// already idempotent). The flag exists so a future caller that wants
// to gate behaviour on "is this a re-entry?" has a single source of
// truth.
// ────────────────────────────────────────────────────────────────────

let hasRunInThisProcess = false;

/** Test seam — clear the in-process flag. Per LESSONS § "in-process
 *  dedup sets need an explicit reset hook for tests", the leading
 *  underscore signals "do not call in production". */
export function _resetOnboardForTests(): void {
  hasRunInThisProcess = false;
}

// ────────────────────────────────────────────────────────────────────
// Secret redaction — same regex set as src/doctor.ts and src/welcome.ts
// so the wizard's stdout is covered by the same chokepoint.
// ────────────────────────────────────────────────────────────────────

function redactSecrets(s: string): string {
  let out = s.replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-pat>");
  out = out.replace(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?/g, "<redacted-repo-url>");
  out = out.replace(/\b[A-Za-z0-9_]{24,}\b/g, (match) => {
    const hasLetter = /[A-Za-z]/.test(match);
    const hasDigit = /\d/.test(match) || /_/.test(match);
    return hasLetter && hasDigit ? "<redacted>" : match;
  });
  return out;
}

/** Wrap `deps.write` so every operator-visible line passes through
 *  `redactSecrets`. Step 5's token-reveal line is the ONE exemption —
 *  it calls `deps.write` directly without this wrapper, because the
 *  token literal is the value being printed (the welcome banner's
 *  Step 5 of 0032 does the same). */
function redactedWriter(deps: OnboardDeps): (s: string) => void {
  return (s) => deps.write(redactSecrets(s));
}

// ────────────────────────────────────────────────────────────────────
// Tiny helpers
// ────────────────────────────────────────────────────────────────────

const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const GH_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\.git)?$/;

function trim(s: string): string {
  return s.replace(/^\s+|\s+$/g, "");
}

function parseSkipList(raw: string | undefined): StepName[] {
  if (!raw) return [];
  const out: StepName[] = [];
  for (const part of raw.split(",")) {
    const p = trim(part);
    if ((ALL_STEPS as readonly string[]).includes(p)) out.push(p as StepName);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Main entrypoint
// ────────────────────────────────────────────────────────────────────

/** Run the wizard end-to-end against the injected `deps` surface.
 *  Returns the list of step names that ran vs were skipped (via
 *  `--skip`). Steps that encountered a soft error (e.g. no LAN IP)
 *  count as run, not skipped — skipped means the operator explicitly
 *  opted out via the CLI flag. */
export async function runOnboard(deps: OnboardDeps): Promise<OnboardResult> {
  hasRunInThisProcess = true;
  const skip = new Set<StepName>(deps.skip ?? []);
  const write = redactedWriter(deps);
  const steps_run: StepName[] = [];
  const steps_skipped: StepName[] = [];

  // ──────────────────────────────────────────────────────────────
  // Header
  // ──────────────────────────────────────────────────────────────
  write("\n");
  write("  Welcome to fleet-control. This will walk you through\n");
  write("  setting up your first project. About 3 minutes.\n");
  write("\n");

  // ──────────────────────────────────────────────────────────────
  // Step 1/6 — detect local projects
  // ──────────────────────────────────────────────────────────────
  if (skip.has("detect")) {
    write("  Step 1/6 detect: skipped (--skip).\n");
    steps_skipped.push("detect");
  } else {
    write("  Step 1/6  Detect local projects\n");
    const detected = deps.detectLocalProjects(deps.projectRoots);
    if (detected.length === 0) {
      write("    No local agent projects detected. Skip to step 2 to import from a GitHub URL.\n");
    } else {
      // List each found project; tag previously-registered ones.
      for (let i = 0; i < detected.length; i++) {
        const d = detected[i];
        const tag = d.alreadyRegistered ? " (already registered)" : "";
        write(`    [${i + 1}] ${d.slug}${tag}\n`);
      }
      const newCount = detected.filter((d) => !d.alreadyRegistered).length;
      const prompt = newCount > 0
        ? `    [a] add all   [s] skip   [pick which? 1,2…]: `
        : `    All ${detected.length} already registered. [ENTER to continue]: `;
      const ans = deps.nonInteractive ? "a" : trim(await deps.readLine(prompt));
      const toAdd = pickFromList(detected, ans);
      let added = 0;
      for (const d of toAdd) {
        if (d.alreadyRegistered) continue;
        try {
          const r = await deps.registerLocalProject(d.slug, d.path);
          if (r.ok) added++;
        } catch (e) {
          write(`    (could not register ${d.slug}: ${describeError(e)})\n`);
        }
      }
      write(`    -> ${added} project${added === 1 ? "" : "s"} registered.\n`);
    }
    steps_run.push("detect");
  }

  // ──────────────────────────────────────────────────────────────
  // Step 2/6 — import from GitHub URL (optional)
  // ──────────────────────────────────────────────────────────────
  if (skip.has("register-url")) {
    write("  Step 2/6 register-url: skipped (--skip).\n");
    steps_skipped.push("register-url");
  } else {
    write("\n");
    write("  Step 2/6  Import from GitHub URL (optional)\n");
    if (deps.nonInteractive) {
      write("    -> skipped (--non-interactive).\n");
    } else {
      let attempts = 0;
      let done = false;
      while (attempts < 3 && !done) {
        const ans = trim(await deps.readLine(`    Paste a GitHub URL (or ENTER to skip): `));
        if (ans === "") {
          write("    -> skipped.\n");
          done = true;
          break;
        }
        if (!GH_URL_RE.test(ans)) {
          write(`    Sorry, that doesn't look like a github.com/<owner>/<name> URL.\n`);
          attempts++;
          if (attempts >= 3) {
            write(`    -> giving up after 3 tries; skipping.\n`);
            done = true;
          }
          continue;
        }
        try {
          const r = await deps.registerFromGitHubUrl(ans);
          if (r.ok) {
            write(`    -> imported ${r.slug ?? "project"}.\n`);
            done = true;
          } else {
            write(`    Could not import: ${r.message ?? "unknown error"}.\n`);
            attempts++;
            if (attempts >= 3) {
              write(`    -> giving up after 3 tries; skipping.\n`);
              done = true;
            }
          }
        } catch (e) {
          write(`    Could not import: ${describeError(e)}.\n`);
          attempts++;
          if (attempts >= 3) {
            write(`    -> giving up after 3 tries; skipping.\n`);
            done = true;
          }
        }
      }
    }
    steps_run.push("register-url");
  }

  // ──────────────────────────────────────────────────────────────
  // Step 3/6 — daily budget
  // ──────────────────────────────────────────────────────────────
  if (skip.has("budget")) {
    write("  Step 3/6 budget: skipped (--skip).\n");
    steps_skipped.push("budget");
  } else {
    write("\n");
    write("  Step 3/6  Daily budget (autopause if blown)\n");
    const registered = deps.listRegisteredSlugs();
    // Idempotency: if every registered project already has a budget,
    // surface the most common one as the default; otherwise default $2.00.
    const existingBudgets = registered.map((s) => deps.getProjectBudget(s)).filter((n): n is number => n != null);
    const defaultCap = existingBudgets.length > 0
      ? mode(existingBudgets)
      : 2.0;
    let chosen = defaultCap;
    if (!deps.nonInteractive) {
      let attempts = 0;
      let accepted = false;
      while (attempts < 3 && !accepted) {
        const ans = trim(await deps.readLine(`    Soft daily $ cap per project [$${defaultCap.toFixed(2)}]: `));
        if (ans === "") { chosen = defaultCap; accepted = true; break; }
        const n = Number(ans.replace(/^\$/, ""));
        if (Number.isFinite(n) && n >= 0) { chosen = n; accepted = true; break; }
        write(`    Sorry, that doesn't look like a number.\n`);
        attempts++;
      }
      if (!accepted) {
        write(`    -> using default $${defaultCap.toFixed(2)}.\n`);
        chosen = defaultCap;
      }
    }
    if (registered.length === 0) {
      write(`    (no projects yet — budget will apply once you register one)\n`);
    } else {
      let n = 0;
      for (const slug of registered) {
        try {
          const r = await deps.setProjectBudget(slug, chosen);
          if (r.ok) n++;
        } catch (e) {
          write(`    (could not set budget for ${slug}: ${describeError(e)})\n`);
        }
      }
      write(`    -> $${chosen.toFixed(2)}/day on ${n} project${n === 1 ? "" : "s"}.\n`);
    }
    steps_run.push("budget");
  }

  // ──────────────────────────────────────────────────────────────
  // Step 4/6 — quiet hours
  // ──────────────────────────────────────────────────────────────
  if (skip.has("quiet-hours")) {
    write("  Step 4/6 quiet-hours: skipped (--skip).\n");
    steps_skipped.push("quiet-hours");
  } else {
    write("\n");
    write("  Step 4/6  Quiet hours (suppress non-critical pushes)\n");
    const existing = deps.getQuietHoursWindow();
    const defaultStart = existing?.start ?? "22:00";
    const defaultEnd = existing?.end ?? "07:00";
    const tz = existing?.tz ?? deps.tz;
    let start = defaultStart;
    let end = defaultEnd;
    if (!deps.nonInteractive) {
      start = await promptHHMM(deps, `    From [${defaultStart}]: `, defaultStart);
      end = await promptHHMM(deps, `    To   [${defaultEnd}]: `, defaultEnd);
    }
    deps.setQuietHoursWindow(start, end, tz);
    write(`    -> ${start} to ${end} ${tz}.\n`);
    steps_run.push("quiet-hours");
  }

  // ──────────────────────────────────────────────────────────────
  // Step 5/6 — pair your phone
  // ──────────────────────────────────────────────────────────────
  if (skip.has("pair")) {
    write("  Step 5/6 pair: skipped (--skip).\n");
    steps_skipped.push("pair");
  } else {
    write("\n");
    write("  Step 5/6  Pair your phone\n");
    const lan = deps.detectLanUrl();
    if (!lan) {
      write("    Could not detect a LAN IP. Skip phone pairing for now;\n");
      write("    you can re-run `fleetctl pair` later.\n");
    } else {
      const minted = deps.mintOrLoadToken();
      write(`    LAN URL: ${lan}\n`);
      // Step 5's token-reveal line — the ONE exemption to the
      // redactSecrets wrapper. The operator is being told this value
      // intentionally; the welcome banner does the same in 0032.
      if (minted.source === "new") {
        deps.write(`    Token (revealed once): ${minted.token}\n`);
      } else {
        deps.write(`    Token: ${minted.token}\n`);
      }
      // QR encodes a path-style URL ("HTTP://<IP>:<PORT>/P/<TOKEN>")
      // so the payload stays in QR V1-L alphanumeric capacity (25
      // chars max). If the token is too long for V1-L the encoder
      // will throw — we catch and fall back to a "QR unavailable"
      // line per the welcome banner's discipline.
      try {
        const qrText = `${lan.toUpperCase()}/P/${minted.token}`;
        write(`    Scan with your phone (or hit ENTER to skip):\n`);
        const qr = deps.renderAsciiQr(qrText);
        for (const line of qr.split("\n")) write(`    ${line}\n`);
      } catch (e) {
        write(`    (QR unavailable: ${describeError(e)})\n`);
      }
      if (!deps.nonInteractive) {
        await deps.readLine(`    [ENTER to continue]: `);
      }
    }
    steps_run.push("pair");
  }

  // ──────────────────────────────────────────────────────────────
  // Step 6/6 — open the portal
  // ──────────────────────────────────────────────────────────────
  if (skip.has("open")) {
    write("  Step 6/6 open: skipped (--skip).\n");
    steps_skipped.push("open");
  } else {
    write("\n");
    write("  Step 6/6  Open the portal\n");
    const running = await deps.isServeRunning();
    if (!running) {
      try {
        const r = await deps.startServeInBackground();
        if (!r.ok) {
          write(`    (could not start fleetctl serve in background: ${r.message ?? "unknown"})\n`);
          write(`    Start it yourself with: fleetctl serve\n`);
        }
      } catch (e) {
        write(`    (could not start fleetctl serve in background: ${describeError(e)})\n`);
        write(`    Start it yourself with: fleetctl serve\n`);
      }
    }
    write(`    Portal: ${deps.portUrl}\n`);
    const progress = deps.welcomeChecklistProgress();
    const registered = deps.listRegisteredSlugs();
    write(`    ${registered.length} project${registered.length === 1 ? "" : "s"} registered. `);
    write(`Welcome checklist ${progress.done}/${progress.total} done.\n`);
    steps_run.push("open");
  }

  // ──────────────────────────────────────────────────────────────
  // Closing summary
  // ──────────────────────────────────────────────────────────────
  write("\n");
  const total = steps_run.length + steps_skipped.length;
  write(`  You're set. ${steps_run.length}/${total} steps completed`);
  if (steps_skipped.length > 0) write(` (skipped: ${steps_skipped.join(", ")})`);
  write(".\n");
  if (steps_run.includes("open")) {
    write(`  fleetctl serve is now running in the background.\n`);
    write(`  Stop it with: fleetctl stop\n`);
  }
  write("\n");

  return { steps_run, steps_skipped };
}

// ────────────────────────────────────────────────────────────────────
// Pure helpers shared with the wizard body
// ────────────────────────────────────────────────────────────────────

function pickFromList(detected: DetectedProject[], ans: string): DetectedProject[] {
  if (ans === "" || ans === "a" || ans === "A") return detected;
  if (ans === "s" || ans === "S") return [];
  // Comma-separated indices.
  const out: DetectedProject[] = [];
  for (const part of ans.split(",")) {
    const n = Number(trim(part));
    if (Number.isFinite(n) && n >= 1 && n <= detected.length) out.push(detected[n - 1]);
  }
  return out;
}

async function promptHHMM(deps: OnboardDeps, prompt: string, fallback: string): Promise<string> {
  let attempts = 0;
  while (attempts < 3) {
    const ans = trim(await deps.readLine(prompt));
    if (ans === "") return fallback;
    if (HHMM_RE.test(ans)) return ans;
    deps.write(`    Sorry, expected HH:MM (24h).\n`);
    attempts++;
  }
  deps.write(`    -> using default ${fallback}.\n`);
  return fallback;
}

function mode(xs: number[]): number {
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let bestVal = xs[0];
  let bestCount = 0;
  for (const [v, c] of counts.entries()) {
    if (c > bestCount) { bestCount = c; bestVal = v; }
  }
  return bestVal;
}

function describeError(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message).slice(0, 200);
  }
  return String(e).slice(0, 200);
}

// ────────────────────────────────────────────────────────────────────
// Production wiring — `productionDeps(db)` returns an OnboardDeps that
// composes the real helpers. Tests never call this; they construct
// their own stub deps object.
// ────────────────────────────────────────────────────────────────────

const CONFIG_FILE = "fleet-control.config.json";

/** Read the project-registered slugs from the live DB. */
function readRegisteredSlugs(db: DB): string[] {
  const rows = db.prepare(
    "SELECT slug FROM project ORDER BY slug",
  ).all() as unknown as Array<{ slug: string }>;
  return rows.map((r) => r.slug);
}

/** Parse a project's MAX_DAILY_USD from its cadence_json (the same
 *  shape `parseCap` in src/budget_guard.ts uses). Returns null when
 *  unset / zero / malformed — the same "opt-out by absence" contract. */
function readProjectBudget(db: DB, slug: string): number | null {
  const row = db.prepare(
    "SELECT cadence_json FROM project WHERE slug = ?",
  ).get(slug) as unknown as { cadence_json: string | null } | undefined;
  if (!row || !row.cadence_json) return null;
  try {
    const obj = JSON.parse(row.cadence_json) as Record<string, unknown>;
    const raw = obj.max_daily_usd;
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n;
  } catch { return null; }
}

/** Production stdin reader — one line, trimmed of the trailing newline. */
function makeRealReadLine(): (prompt: string) => Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  return (prompt: string) => new Promise<string>((resolve) => {
    process.stdout.write(prompt);
    rl.once("line", (line) => resolve(line));
  });
}

/** Production loopback liveness probe — same shape as `checkAdminSocket`
 *  in src/doctor.ts. Any HTTP response code > 0 counts as "running".
 *  Hard-capped at 1.5s. */
function probeServeLive(portUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const u = new URL("/api/health", portUrl);
      const req = httpRequest({
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: "GET",
      }, (res) => {
        const status = res.statusCode ?? 0;
        res.on("data", () => { /* drain */ });
        res.on("end", () => settle(status > 0));
        res.on("error", () => settle(false));
      });
      req.on("error", () => settle(false));
      req.on("timeout", () => { try { req.destroy(); } catch { /* */ } settle(false); });
      try { req.setTimeout(1_500); } catch { /* */ }
      req.end();
    } catch { settle(false); }
  });
}

/** Production daemonise helper — defers to `installDaemon()` (the same
 *  path `fleetctl install` and `fleetctl daemon on` use). Stdout is
 *  routed through launchd's StandardOutPath, not inherited by the
 *  wizard. */
async function startServeViaDaemon(): Promise<{ ok: boolean; message?: string }> {
  if (process.env.FLEET_ONBOARD_OFFLINE === "1") {
    return { ok: true, message: "offline mode — skipping launchd install" };
  }
  // Lazily import the daemon module so the wizard doesn't pay its
  // launchctl-dependent cost when the operator passed --skip open.
  // (LESSONS § "don't fake a lazy require in an ESM file; just import":
  // we DO import at the top — this is a runtime branch, not a lazy
  // import.)
  const { installDaemon } = await import("./daemon.ts");
  try {
    installDaemon();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: describeError(e) };
  }
}

/** Scan the project roots for `agents.config.sh` directories. Mirrors
 *  the shape of `discoverManifests` in src/discovery.ts (which does
 *  more parsing); the wizard only needs the slug + path. */
function detectLocalProjectsImpl(db: DB, roots: string[]): DetectedProject[] {
  const registered = new Set(readRegisteredSlugs(db));
  const out: DetectedProject[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try { entries = readdirSync(root); } catch { continue; }
    for (const name of entries) {
      const dir = join(root, name);
      const manifest = join(dir, "agents.config.sh");
      if (!existsSync(manifest)) continue;
      // Best-effort slug derivation: read SLUG= from the manifest;
      // fall back to the dir name.
      let slug = name;
      try {
        const text = readFileSync(manifest, "utf8");
        const m = text.match(/^\s*SLUG=\s*["']?([\w-]+)["']?\s*$/m);
        if (m) slug = m[1];
      } catch { /* fall back to dir name */ }
      out.push({ slug, path: dir, alreadyRegistered: registered.has(slug) });
    }
  }
  return out;
}

/** Read-merge-write helper for `fleet-control.config.json`. Preserves
 *  unrelated keys (per LESSONS 2026-05-25 § "store cascading config
 *  values shaped to the reader"). */
function saveConfigImpl(cfgPath: string, next: Record<string, unknown>): void {
  const dir = cfgPath.slice(0, cfgPath.lastIndexOf("/"));
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(next, null, 2));
}

function loadConfigImpl(cfgPath: string): Record<string, unknown> {
  if (!existsSync(cfgPath)) return {};
  try { return JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>; }
  catch { return {}; }
}

/** Construct the production OnboardDeps from a live DB handle + the
 *  parsed CLI flags. */
export function productionDeps(
  db: DB,
  flags: { nonInteractive: boolean; skip?: StepName[] },
): OnboardDeps {
  const cfg = loadConfig();
  const cfgPath = join(process.cwd(), CONFIG_FILE);
  const portUrl = `http://${cfg.host ?? "127.0.0.1"}:${cfg.port ?? 7070}`;
  const tz = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
    catch { return "UTC"; }
  })();

  let inMemConfig: Record<string, unknown> = loadConfigImpl(cfgPath);

  const readLine = flags.nonInteractive
    ? async (prompt: string) => { process.stdout.write(prompt); return ""; }
    : makeRealReadLine();

  return {
    nonInteractive: flags.nonInteractive,
    skip: flags.skip,
    readLine,
    write: (s) => { process.stdout.write(s); },
    loadConfig: () => ({ ...inMemConfig }),
    saveConfig: (next) => {
      inMemConfig = { ...next };
      saveConfigImpl(cfgPath, inMemConfig);
    },
    detectLocalProjects: (roots) => detectLocalProjectsImpl(db, roots),
    registerLocalProject: async (slug, path) => {
      // Reuse the SAME helper Path A's `register` action uses (in
      // src/control.ts). Body shape is `{ path, slug, name }`.
      const res = await doAction(db, "local", "register",
        { path, slug, name: slug }, "onboard");
      return { ok: res.ok, slug, message: res.message };
    },
    registerFromGitHubUrl: async (url) => {
      const res = await doAction(db, "local", "register-url",
        { repo_url: url }, "onboard");
      return { ok: res.ok, message: res.message };
    },
    setProjectBudget: async (slug, dollars) => {
      const res = await doAction(db, "local", "set-budget",
        { slug, max_daily_usd: dollars }, "onboard");
      return { ok: res.ok, message: res.message };
    },
    getProjectBudget: (slug) => readProjectBudget(db, slug),
    listRegisteredSlugs: () => readRegisteredSlugs(db),
    setQuietHoursWindow: (start, end, tzVal) => {
      const next = { ...inMemConfig, quietHours: { start, end, tz: tzVal } };
      inMemConfig = next;
      saveConfigImpl(cfgPath, next);
    },
    getQuietHoursWindow: () => {
      const q = (inMemConfig as { quietHours?: { start: string; end: string; tz: string } }).quietHours;
      return q ?? null;
    },
    detectLanUrl: () => discoverLanUrl(cfg.host ?? "0.0.0.0", cfg.port ?? 7070),
    renderAsciiQr: (text) => renderQrAscii(text, { cellWidth: 1 }),
    mintOrLoadToken: () => {
      // Prefer the existing adminToken on disk so a re-run doesn't mint
      // a fresh token every time. Falls back to a fresh mint via the
      // 0003 helper.
      const existing = (inMemConfig as { adminToken?: string }).adminToken;
      if (typeof existing === "string" && existing.length >= 8) {
        return { token: existing, source: "config" as const };
      }
      const minted = mintToken(db, "onboard", "admin");
      // Persist the plaintext into adminToken so the welcome banner
      // (and the next onboard run) can read it back. This matches the
      // pre-0003 contract: fleet-control.config.json carries the
      // current admin token plaintext; auth.ts migrates it to the
      // auth_token table on first server boot.
      const next = { ...inMemConfig, adminToken: minted.token };
      inMemConfig = next;
      saveConfigImpl(cfgPath, next);
      return { token: minted.token, source: "new" as const };
    },
    isServeRunning: () => probeServeLive(portUrl),
    startServeInBackground: () => startServeViaDaemon(),
    welcomeChecklistProgress: () => {
      // Same shape the 0024 banner's checklist exposes: 5 prescribed
      // steps. Step 3 ("Add your first project") is the only one with
      // observable progress; the other 4 are always "available".
      const registered = readRegisteredSlugs(db);
      const done = registered.length > 0 ? 5 : 4;
      return { done, total: 5 };
    },
    tz,
    portUrl,
    projectRoots: cfg.projectRoots,
  };
}

// ────────────────────────────────────────────────────────────────────
// CLI argv parser — separated from the entry function so tests can
// drive it without spawning the real CLI.
// ────────────────────────────────────────────────────────────────────

export interface ParsedOnboardArgs {
  nonInteractive: boolean;
  skip: StepName[];
  help: boolean;
}

export function parseOnboardArgs(argv: string[]): ParsedOnboardArgs {
  let nonInteractive = false;
  let help = false;
  let skipRaw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--non-interactive" || a === "--yes") nonInteractive = true;
    else if (a === "--help" || a === "-h") help = true;
    else if (a === "--skip") skipRaw = argv[i + 1];
    else if (a.startsWith("--skip=")) skipRaw = a.slice("--skip=".length);
  }
  return {
    nonInteractive,
    skip: parseSkipList(skipRaw),
    help,
  };
}

export const ONBOARD_HELP = [
  "usage: fleetctl onboard [--non-interactive | --yes] [--skip <list>] [--help]",
  "",
  "Walks you through six steps to go from zero to a populated portal:",
  "  Step 1/6  detect          — scan project roots for agents.config.sh",
  "  Step 2/6  register-url    — optionally import one from a GitHub URL",
  "  Step 3/6  budget          — set a soft daily $ cap per project",
  "  Step 4/6  quiet-hours     — pick a sleep window (HH:MM 24h)",
  "  Step 5/6  pair            — print LAN URL + ASCII QR for your phone",
  "  Step 6/6  open            — start serve in the background, print URL",
  "",
  "Flags:",
  "  --non-interactive / --yes   Accept every default; no prompts.",
  "  --skip <list>               Comma-separated step names to skip.",
  "                              Names: detect,register-url,budget,quiet-hours,pair,open",
  "  --help                      Show this text.",
].join("\n") + "\n";

// Suppress unused-import lint for execFile (it's reserved for future
// callers that need a non-launchd background-start path).
void execFile;
