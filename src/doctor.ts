// `fleetctl doctor` — one-shot install + ingest diagnostic (ticket 0016).
//
// Doctor walks a closed set of well-known failure modes (runtime, config,
// discovery, ingest, control, network) and prints one prescriptive line
// per check. Every check returns the same shape so the human renderer
// and the `--json` renderer share one source of truth, and every check
// is unit-testable because the side-effects are routed through an
// injected `DoctorDeps` dependency surface — same pattern as the
// `_setRunnerForTests` seam in src/control.ts (LESSONS.md §
// "shell-out modules need an injectable runner for tests").
//
// Zero new runtime deps. All shell-outs use `execFile` with an argv
// array (per AGENTS.md — never compose a shell string). All HTTP probes
// use node:http; no fetch polyfill, no new package.
//
// Secrets discipline: doctor reads `fleet-control.config.json` to
// confirm an admin token EXISTS, but the value is never read into a
// rendered string. As a belt-and-braces second layer, both renderers
// run output through `redactSecrets()` which strips token-shaped
// substrings and GitHub repo URLs before printing.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import type { DB } from "./db.ts";
import { loadConfig } from "./config.ts";

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  category: string;
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  ok: boolean;
}

/** Injected dependency surface — every side-effecting call routes
 *  through one of these so every check is unit-testable. Production
 *  code wires the defaults from `defaultDeps(db)` below. */
export interface DoctorDeps {
  /** Async exec wrapper around execFile. Returns stdout + exit code;
   *  never throws on a non-zero exit. */
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>;
  /** Plain string read; returns null on any error so checks branch
   *  cleanly without try/catch. */
  readFile: (path: string) => string | null;
  /** existsSync wrapper — null-safe by construction. */
  fileExists: (path: string) => boolean;
  /** SQL helper. Returns rows as plain objects. Tests stub this to
   *  return a fixed shape; production wraps node:sqlite. */
  dbQuery: <T = unknown>(sql: string, params?: unknown[]) => T[];
  /** Process env mirror (set by caller; defaults to process.env). */
  env: Record<string, string | undefined>;
  /** Node runtime version string (e.g. "v23.5.0"). Injected so tests
   *  can pin a value without spawning. */
  nodeVersion: string;
  /** GET probe — returns {ok, status, error?}. Never throws. */
  fetchUrl: (url: string) => Promise<{ ok: boolean; status: number; error?: string }>;
  /** Resolve project roots from the operator's config. Wrapped behind
   *  a function so tests can pin a fixture without writing a config
   *  file. */
  loadConfigFn: () => { projectRoots: string[]; installedRoot: string };
  /** Optional readdir hook — defaults to fs.readdirSync. Tests stub
   *  this to enumerate fake project roots without touching the real
   *  filesystem. */
  readdir?: (path: string) => string[];
  /** Optional flag set by the config loader to indicate ntfy is wired
   *  up. Tests set this directly; production reads it from the
   *  fleet-control.config.json `ntfyTopic` field. */
  ntfyTopicConfigured?: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Default DoctorDeps wiring
// ────────────────────────────────────────────────────────────────────

/** Wrap execFile in a never-throwing async function. */
function execAsync(cmd: string, args: string[]): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: 5_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      const code = err && typeof (err as any).code === "number" ? (err as any).code : (err ? 1 : 0);
      // Concatenate stdout + stderr so callers that grep for output
      // (e.g. fleetd in launchctl list) see whichever stream the binary
      // chose to write to.
      resolve({ stdout: (stdout ?? "") + (stderr ?? ""), code });
      // Avoid unused var lint.
      void stderr;
    });
  });
}

function fetchUrlAsync(url: string): Promise<{ ok: boolean; status: number; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (r: { ok: boolean; status: number; error?: string }) => {
      if (!settled) { settled = true; resolve(r); }
    };
    try {
      const req = httpRequest(url, { method: "GET" }, (res) => {
        const status = res.statusCode ?? 0;
        res.on("data", () => { /* drain */ });
        res.on("end", () => settle({ ok: status >= 200 && status < 300, status }));
        res.on("error", (e) => settle({ ok: false, status, error: e.message }));
      });
      req.on("error", (e) => settle({ ok: false, status: 0, error: e.message }));
      req.on("timeout", () => { try { req.destroy(); } catch { /* */ } settle({ ok: false, status: 0, error: "timeout" }); });
      try { req.setTimeout(1_500); } catch { /* */ }
      req.end();
    } catch (e: any) {
      settle({ ok: false, status: 0, error: String(e?.message ?? e) });
    }
  });
}

/** Construct the production DoctorDeps from a live DB handle. */
export function defaultDeps(db: DB): DoctorDeps {
  // Inspect the on-disk config ONCE to learn whether ntfy is wired
  // (without holding the token in a closure).
  let ntfyTopicConfigured = false;
  try {
    const cfgPath = join(process.cwd(), "fleet-control.config.json");
    if (existsSync(cfgPath)) {
      const raw = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
      const t = raw.ntfyTopic;
      ntfyTopicConfigured = typeof t === "string" && t.trim().length > 0;
    }
  } catch { /* leave ntfyTopicConfigured=false */ }

  return {
    exec: execAsync,
    readFile: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
    fileExists: (p) => { try { return existsSync(p); } catch { return false; } },
    dbQuery: <T,>(sql: string, params: unknown[] = []): T[] => {
      const stmt = db.prepare(sql);
      const rows = stmt.all(...(params as any[]));
      return rows as unknown as T[];
    },
    env: process.env,
    nodeVersion: process.version,
    fetchUrl: fetchUrlAsync,
    loadConfigFn: () => {
      const c = loadConfig();
      return { projectRoots: c.projectRoots, installedRoot: c.installedRoot };
    },
    readdir: (p) => { try { return readdirSync(p); } catch { return []; } },
    ntfyTopicConfigured,
  };
}

// ────────────────────────────────────────────────────────────────────
// Individual checks
// ────────────────────────────────────────────────────────────────────

const CAT_RUNTIME = "runtime";
const CAT_CONFIG = "config";
const CAT_DISCOVERY = "discovery";
const CAT_INGEST = "ingest";
const CAT_CONTROL = "control";
const CAT_NETWORK = "network";

const HOME = homedir();
const CONFIG_FILE = "fleet-control.config.json";

export async function checkNodeVersion(deps: DoctorDeps): Promise<DoctorCheck> {
  // Parse "v23.5.0" → 23. Anything older than 23 fails — this project
  // depends on node:sqlite (>=22.5) AND the type-stripping loader,
  // which got promoted to stable in 23.
  const m = deps.nodeVersion.match(/^v?(\d+)\./);
  const major = m ? Number(m[1]) : 0;
  if (major >= 23) {
    return { category: CAT_RUNTIME, name: "node version", status: "ok", detail: `${deps.nodeVersion} (≥23)` };
  }
  return {
    category: CAT_RUNTIME,
    name: "node version",
    status: "fail",
    detail: `${deps.nodeVersion} is too old; need ≥23`,
    fix: "brew upgrade node@23 (or `nvm install 23 && nvm use 23`)",
  };
}

export async function checkTscAvailable(deps: DoctorDeps): Promise<DoctorCheck> {
  // `npx tsc --version` resolves the typescript devDep from node_modules.
  // Failure usually means `npm ci` was skipped.
  const r = await deps.exec("npx", ["--no-install", "tsc", "--version"]);
  if (r.code === 0) {
    return { category: CAT_RUNTIME, name: "tsc available", status: "ok", detail: r.stdout.trim().slice(0, 40) };
  }
  return {
    category: CAT_RUNTIME,
    name: "tsc available",
    status: "fail",
    detail: "`npx tsc --version` failed",
    fix: "run `npm ci` in the repo root",
  };
}

export async function checkSqliteAvailable(deps: DoctorDeps): Promise<DoctorCheck> {
  try {
    const rows = deps.dbQuery<{ v: string }>("SELECT sqlite_version() AS v");
    if (rows.length > 0) {
      return { category: CAT_RUNTIME, name: "node:sqlite available", status: "ok", detail: `sqlite ${rows[0].v}` };
    }
    return {
      category: CAT_RUNTIME,
      name: "node:sqlite available",
      status: "fail",
      detail: "sqlite_version() returned no rows",
      fix: "ensure node ≥23 (node:sqlite is part of stdlib)",
    };
  } catch (e: any) {
    return {
      category: CAT_RUNTIME,
      name: "node:sqlite available",
      status: "fail",
      detail: String(e?.message ?? e).slice(0, 120),
      fix: "ensure node ≥23 with node:sqlite enabled",
    };
  }
}

export async function checkConfigFile(deps: DoctorDeps): Promise<DoctorCheck> {
  // The config is auto-generated by `fleetctl serve` on first run. If
  // it's missing, the operator just hasn't booted the server once.
  const cfgPath = join(process.cwd(), CONFIG_FILE);
  if (!deps.fileExists(cfgPath)) {
    return {
      category: CAT_CONFIG,
      name: CONFIG_FILE,
      status: "fail",
      detail: `not found at ${cfgPath}`,
      fix: "run `fleetctl serve` once — it auto-generates the file with an admin token",
    };
  }
  const raw = deps.readFile(cfgPath);
  if (raw == null) {
    return {
      category: CAT_CONFIG,
      name: CONFIG_FILE,
      status: "fail",
      detail: "found but unreadable",
      fix: "check file permissions on fleet-control.config.json",
    };
  }
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; }
  catch (e: any) {
    return {
      category: CAT_CONFIG,
      name: CONFIG_FILE,
      status: "fail",
      detail: `failed to parse json: ${String(e?.message ?? e).slice(0, 60)}`,
      fix: "fix the json syntax or delete the file and re-run `fleetctl serve`",
    };
  }
  // Admin-token PRESENCE only — never read the value into a check field.
  const tokenField = parsed.adminToken;
  if (typeof tokenField !== "string" || tokenField.length < 8) {
    return {
      category: CAT_CONFIG,
      name: CONFIG_FILE,
      status: "warn",
      detail: "no `adminToken` set — LAN clients will be rejected",
      fix: "delete the file and re-run `fleetctl serve` to regenerate",
    };
  }
  return { category: CAT_CONFIG, name: CONFIG_FILE, status: "ok", detail: "present + parses + has admin token" };
}

export async function checkGitignoreCoversConfig(deps: DoctorDeps): Promise<DoctorCheck> {
  const giPath = join(process.cwd(), ".gitignore");
  if (!deps.fileExists(giPath)) {
    return {
      category: CAT_CONFIG,
      name: ".gitignore",
      status: "fail",
      detail: ".gitignore missing",
      fix: `add a .gitignore and include the line: ${CONFIG_FILE}`,
    };
  }
  const txt = deps.readFile(giPath) ?? "";
  if (!new RegExp(`(^|\\n)\\s*${CONFIG_FILE.replace(/\./g, "\\.")}\\s*(\\n|$)`).test(txt)) {
    return {
      category: CAT_CONFIG,
      name: ".gitignore",
      status: "fail",
      detail: `does not list ${CONFIG_FILE}`,
      fix: `add this line to .gitignore: ${CONFIG_FILE}`,
    };
  }
  return { category: CAT_CONFIG, name: ".gitignore", status: "ok", detail: `covers ${CONFIG_FILE}` };
}

export async function checkProjectRoots(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const { projectRoots } = deps.loadConfigFn();
  const checks: DoctorCheck[] = [];
  const readdir = deps.readdir ?? (() => []);
  for (const root of projectRoots) {
    if (!deps.fileExists(root)) {
      checks.push({
        category: CAT_DISCOVERY,
        name: "project root",
        status: "warn",
        detail: `${root} (missing — no discovery from this root)`,
        fix: `mkdir -p ${root} or remove it from projectRoots in ${CONFIG_FILE}`,
      });
      continue;
    }
    const entries = readdir(root);
    if (entries.length === 0) {
      checks.push({
        category: CAT_DISCOVERY,
        name: "project root",
        status: "warn",
        detail: `${root} (empty — no projects discovered)`,
      });
      continue;
    }
    let validCount = 0;
    for (const name of entries) {
      const dir = join(root, name);
      const manifest = join(dir, "agents.config.sh");
      if (deps.fileExists(manifest)) {
        validCount++;
        checks.push({
          category: CAT_DISCOVERY,
          name: `project ${name}`,
          status: "ok",
          detail: `manifest present at ${manifest}`,
        });
      } else {
        // Heuristic: if the dir is a git checkout (has .git) but no
        // manifest, surface it as a near-miss the operator probably
        // wanted to register.
        const isGit = deps.fileExists(join(dir, ".git"));
        checks.push({
          category: CAT_DISCOVERY,
          name: `project ${name}`,
          status: isGit ? "fail" : "warn",
          detail: `${dir} ${isGit ? "is a git checkout but" : ""} has no agents.config.sh`,
          fix: `paste its GitHub URL in the portal's Add Project panel to scaffold one`,
        });
      }
    }
    if (validCount === 0 && entries.length > 0) {
      checks.push({
        category: CAT_DISCOVERY,
        name: "project root",
        status: "warn",
        detail: `${root} (zero valid projects out of ${entries.length} dirs)`,
      });
    }
  }
  return checks;
}

export async function checkIngestFreshness(deps: DoctorDeps): Promise<DoctorCheck[]> {
  // Query: every project + the timestamp of its most recent
  // agent_event row. The LEFT JOIN keeps projects with zero events.
  const rows = deps.dbQuery<{ slug: string; last_ts: string | null }>(
    "SELECT p.slug AS slug, MAX(e.ts) AS last_ts "
    + "FROM project p LEFT JOIN agent_event e ON e.slug = p.slug "
    + "GROUP BY p.slug",
  );
  const checks: DoctorCheck[] = [];
  for (const r of rows) {
    if (!r.last_ts) {
      checks.push({
        category: CAT_INGEST,
        name: `ingest ${r.slug}`,
        status: "fail",
        detail: `${r.slug} has zero agent_event rows`,
        fix: `tail ~/.cache/${r.slug}-agent/events.jsonl to confirm the agent is writing, then run \`fleetctl backfill\``,
      });
      continue;
    }
    const ageMs = Date.now() - new Date(r.last_ts).getTime();
    if (ageMs > 24 * 60 * 60 * 1000) {
      // Look at launchctl for the loaded state — if loaded but stale,
      // the fix is `launchctl kickstart`.
      const lc = await deps.exec("launchctl", ["list"]);
      const loaded = new RegExp(`\\bcom\\.${r.slug}\\.`).test(lc.stdout);
      checks.push({
        category: CAT_INGEST,
        name: `ingest ${r.slug}`,
        status: "warn",
        detail: `${r.slug}: last event ${Math.round(ageMs / 3600 / 1000)}h ago${loaded ? " (plist loaded)" : ""}`,
        fix: `launchctl list | grep com.${r.slug} and then `
          + `\`launchctl kickstart -k gui/$(id -u)/com.${r.slug}.agent-ship\``,
      });
      continue;
    }
    checks.push({
      category: CAT_INGEST,
      name: `ingest ${r.slug}`,
      status: "ok",
      detail: `${r.slug}: last event ${Math.round(ageMs / 60 / 1000)}m ago`,
    });
  }
  return checks;
}

export async function checkFleetdLoaded(deps: DoctorDeps): Promise<DoctorCheck> {
  const r = await deps.exec("launchctl", ["list"]);
  if (r.code === 0 && /\bcom\.fleet\.control\.fleetd\b/.test(r.stdout)) {
    return { category: CAT_CONTROL, name: "fleetd loaded", status: "ok", detail: "com.fleet.control.fleetd present" };
  }
  return {
    category: CAT_CONTROL,
    name: "fleetd loaded",
    status: "fail",
    detail: "com.fleet.control.fleetd not in launchctl list",
    fix: "run `fleetctl daemon on` (or `launchctl load ~/Library/LaunchAgents/com.fleet.control.fleetd.plist`)",
  };
}

export async function checkAdminSocket(deps: DoctorDeps): Promise<DoctorCheck> {
  // Probe loopback. We accept either 200 (healthy) or a 4xx body that
  // proves the server is at least listening; only transport-level
  // failures (ECONNREFUSED, timeout) are reported as ✗.
  const url = "http://127.0.0.1:7070/api/health";
  const r = await deps.fetchUrl(url);
  if (r.status > 0) {
    return { category: CAT_CONTROL, name: "admin socket", status: "ok", detail: `loopback responded with ${r.status}` };
  }
  return {
    category: CAT_CONTROL,
    name: "admin socket",
    status: "fail",
    detail: r.error ?? "no response from 127.0.0.1:7070",
    fix: "run `fleetctl serve` (or check that the fleetd daemon is up)",
  };
}

export async function checkGhAuth(deps: DoctorDeps): Promise<DoctorCheck> {
  const r = await deps.exec("gh", ["auth", "status"]);
  if (r.code === 0) {
    return { category: CAT_NETWORK, name: "gh auth", status: "ok", detail: "logged in" };
  }
  return {
    category: CAT_NETWORK,
    name: "gh auth",
    status: "warn",
    detail: "gh CLI not authenticated — projects that open PRs won't be able to",
    fix: "run `gh auth login`",
  };
}

export async function checkNtfyReachable(deps: DoctorDeps): Promise<DoctorCheck> {
  if (!deps.ntfyTopicConfigured) {
    return {
      category: CAT_NETWORK,
      name: "ntfy reachable",
      status: "ok",
      detail: "ntfy not configured (skipped)",
    };
  }
  const r = await deps.fetchUrl("https://ntfy.sh/");
  if (r.ok) return { category: CAT_NETWORK, name: "ntfy reachable", status: "ok", detail: "https://ntfy.sh/ responded" };
  return {
    category: CAT_NETWORK,
    name: "ntfy reachable",
    status: "warn",
    detail: r.error ?? "ntfy.sh not reachable from this network",
    fix: "check that this host can reach https://ntfy.sh/ (firewall / VPN)",
  };
}

// ────────────────────────────────────────────────────────────────────
// runDoctor — compose every check
// ────────────────────────────────────────────────────────────────────

export interface RunDoctorOptions {
  /** Skip the long-running probes (network, launchctl). Used by the
   *  hermetic in-process CLI tests. */
  offline?: boolean;
}

export async function runDoctor(deps: DoctorDeps, opts: RunDoctorOptions = {}): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  // Runtime
  checks.push(await checkNodeVersion(deps));
  if (!opts.offline) checks.push(await checkTscAvailable(deps));
  checks.push(await checkSqliteAvailable(deps));
  // Config
  checks.push(await checkConfigFile(deps));
  checks.push(await checkGitignoreCoversConfig(deps));
  // Discovery
  for (const c of await checkProjectRoots(deps)) checks.push(c);
  // Ingest
  for (const c of await checkIngestFreshness(deps)) checks.push(c);
  // Control
  if (!opts.offline) {
    checks.push(await checkFleetdLoaded(deps));
    checks.push(await checkAdminSocket(deps));
  }
  // Network
  if (!opts.offline) {
    checks.push(await checkGhAuth(deps));
    checks.push(await checkNtfyReachable(deps));
  }
  // ok = no fails. warns are allowed.
  const ok = checks.every((c) => c.status !== "fail");
  return { checks, ok };
}

// ────────────────────────────────────────────────────────────────────
// Renderers (human + json) with secrets redaction
// ────────────────────────────────────────────────────────────────────

/** Strip token-shaped substrings and GitHub HTTPS repo URLs. The
 *  regexes are belt-and-braces: doctor checks NEVER read these into
 *  their output strings on purpose, but in case a future check
 *  forgets, this layer is the second line of defence. */
function redactSecrets(s: string): string {
  // GitHub PATs (ghp_, gho_, ghu_, ghs_, ghr_) followed by ≥20 chars.
  let out = s.replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-pat>");
  // GitHub repo URLs.
  out = out.replace(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?/g, "<redacted-repo-url>");
  // Long base64-ish tokens (>=24 chars of [A-Za-z0-9_-]) — best-effort
  // catch for the admin token. Tuned to avoid mangling pricing dollar
  // figures and short ids by requiring a long contiguous alnum/underscore
  // run with at least one digit AND one letter.
  out = out.replace(/\b[A-Za-z0-9_]{24,}\b/g, (match) => {
    const hasLetter = /[A-Za-z]/.test(match);
    const hasDigit = /\d/.test(match) || /_/.test(match);
    return hasLetter && hasDigit ? "<redacted>" : match;
  });
  return out;
}

export interface RenderHumanOptions {
  /** Colorize when stdout is a TTY. */
  color?: boolean;
}

const C = {
  dim: "\x1b[2m", bold: "\x1b[1m",
  grn: "\x1b[32m", ylw: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
  rst: "\x1b[0m",
};

function paint(color: boolean, code: string, s: string): string {
  return color ? `${code}${s}${C.rst}` : s;
}

const MARK: Record<CheckStatus, string> = {
  ok: "✓",
  warn: "⚠",
  fail: "✗",
};

export function renderHuman(r: DoctorResult, opts: RenderHumanOptions = {}): string {
  const color = opts.color ?? false;
  const lines: string[] = [];
  // Group by category in the order checks were emitted.
  const seen = new Set<string>();
  const cats: string[] = [];
  for (const c of r.checks) {
    if (!seen.has(c.category)) { seen.add(c.category); cats.push(c.category); }
  }
  for (const cat of cats) {
    lines.push(paint(color, C.bold, cat));
    for (const c of r.checks.filter((c) => c.category === cat)) {
      const mark = c.status === "ok"
        ? paint(color, C.grn, MARK.ok)
        : c.status === "warn"
          ? paint(color, C.ylw, MARK.warn)
          : paint(color, C.red, MARK.fail);
      const detail = c.detail ? ` ${paint(color, C.dim, "— " + c.detail)}` : "";
      lines.push(`  ${mark} ${c.name}${detail}`);
      if (c.fix) lines.push(`      ${paint(color, C.cyan, "fix:")} ${c.fix}`);
    }
  }
  lines.push("");
  const totals = `${r.checks.filter((c) => c.status === "ok").length} ok, `
    + `${r.checks.filter((c) => c.status === "warn").length} warn, `
    + `${r.checks.filter((c) => c.status === "fail").length} fail`;
  lines.push(paint(color, C.dim, totals));
  lines.push("");
  return redactSecrets(lines.join("\n"));
}

export function renderJson(r: DoctorResult): string {
  return redactSecrets(JSON.stringify(r, null, 2));
}

/** Map a doctor result to a process exit code. 0 = all green (warns
 *  ok), 1 = one or more ✗, 2 = doctor itself threw (handled by the
 *  CLI's catch block). */
export function exitCodeFor(r: DoctorResult): 0 | 1 {
  return r.ok ? 0 : 1;
}

// Silence unused-import flag for HOME constant — exposed for future
// callers that want to compute a paths-default outside loadConfig.
void HOME;
