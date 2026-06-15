// Tests for ticket 0024 — first-run welcome printed by `fleetctl serve`.
//
// Each test maps 1:1 to one acceptance-criteria checkbox in
// docs/backlog/0024-first-run-welcome-checklist.md. We exercise three
// layers:
//   1. The pure render — `renderWelcome(opts)` is a deterministic
//      function over its options. Snapshot the multi-line string and
//      assert specific lines are present, the token is never embedded,
//      and the geometry (≤24 lines, ≤80 cols) is respected.
//   2. The sentinel round-trip — `firstRun(opts)` decides whether to
//      print, writes the sentinel on first run, and gracefully degrades
//      on a non-writable sentinel path.
//   3. The CLI subprocess — `fleetctl serve` cold-start prints the
//      welcome, listens, and accepts a request; the override flags
//      `--welcome` / `--no-welcome` are honoured. We pass FLEET_HOME +
//      FLEET_DB_PATH per the LESSONS.md env-seam discipline so the
//      subprocess never touches the operator's real $HOME.
//
// Zero new runtime deps; stdlib + node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { openDb, type DB } from "../src/db.ts";
import {
  renderWelcome, firstRun, sentinelPathFor, type WelcomeOpts, type WelcomeDeps,
} from "../src/welcome.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-welcome-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function tempDb(): { db: DB; cleanup: () => void; dir: string; dbPath: string } {
  const t = tempDir();
  const dbPath = join(t.dir, "fleet.db");
  const db = openDb(dbPath);
  return {
    db,
    dir: t.dir,
    dbPath,
    cleanup: () => { db.close(); t.cleanup(); },
  };
}

function baseOpts(over: Partial<WelcomeOpts> = {}): WelcomeOpts {
  return {
    token: "secret_admin_token_value_xyz_1234567890",
    host: "127.0.0.1",
    port: 7070,
    configPath: "/tmp/fake/fleet-control.config.json",
    tokenSource: "new",
    color: false,
    projects: [],
    sentinelPath: "/tmp/fake/.welcome-seen",
    ...over,
  };
}

function fakeDeps(over: Partial<WelcomeDeps> = {}): {
  deps: WelcomeDeps;
  state: {
    written: Map<string, string>;
    existing: Set<string>;
    mkdirs: string[];
    warns: string[];
    logs: string[];
  };
} {
  const state = {
    written: new Map<string, string>(),
    existing: new Set<string>(),
    mkdirs: [] as string[],
    warns: [] as string[],
    logs: [] as string[],
  };
  const deps: WelcomeDeps = {
    fileExists: (p) => state.existing.has(p),
    writeFile: (p, body) => { state.written.set(p, body); state.existing.add(p); },
    mkdir: (p) => { state.mkdirs.push(p); },
    log: (line) => { state.logs.push(line); },
    warn: (line) => { state.warns.push(line); },
    ...over,
  };
  return { deps, state };
}

// ────────────────────────────────────────────────────────────────────
// AC1 — renderWelcome returns a multi-line string with the expected sections
// ────────────────────────────────────────────────────────────────────

test("AC1: renderWelcome produces a multi-line string with the documented sections", () => {
  const out = renderWelcome(baseOpts());
  // Header.
  assert.match(out, /first run/i, "header must mention first run");
  assert.match(out, /fleet-control/i, "header must name fleet-control");
  // Numbered checklist 1..5.
  assert.match(out, /1\.\s+Open the portal:\s+http:\/\/127\.0\.0\.1:7070/,
    "step 1 must print the portal URL");
  assert.match(out, /2\.\s+Loopback bypasses auth/,
    "step 2 must mention loopback auth bypass");
  assert.match(out, /x-fleet-token:\s+<token-from-fleet-control\.config\.json>/,
    "step 2 must reference the token file path, not the value");
  assert.match(out, /3\.\s+/, "step 3 must exist");
  assert.match(out, /4\.\s+Verify with:\s+fleetctl doctor/,
    "step 4 must point to fleetctl doctor");
  assert.match(out, /5\.\s+Watch the live tail:\s+fleetctl tail --follow/,
    "step 5 must mention the live tail");
  // Footer with the hide-hint.
  assert.match(out, /Hide this with:\s+touch /, "footer must show how to hide future welcomes");
});

test("AC1: renderWelcome echoes the requested host:port in step 1", () => {
  const out = renderWelcome(baseOpts({ host: "0.0.0.0", port: 4040 }));
  assert.match(out, /http:\/\/localhost:4040|http:\/\/0\.0\.0\.0:4040/,
    "0.0.0.0 should render as localhost (or 0.0.0.0 verbatim) and port must match");
});

// ────────────────────────────────────────────────────────────────────
// AC2 — sentinel-based first-run detection
// ────────────────────────────────────────────────────────────────────

test("AC2: firstRun prints welcome AND creates the sentinel when sentinel is absent", () => {
  const { dir, cleanup } = tempDir();
  try {
    const sentinel = join(dir, ".config", "fleet-control", ".welcome-seen");
    const { deps, state } = fakeDeps();
    firstRun(baseOpts({ sentinelPath: sentinel }), deps);
    // The welcome MUST have been printed.
    const joined = state.logs.join("\n");
    assert.match(joined, /first run/i, "welcome must be printed on first run");
    // The sentinel parent dir must have been created.
    assert.ok(state.mkdirs.includes(join(dir, ".config", "fleet-control")),
      `expected mkdir for sentinel parent dir; got: ${JSON.stringify(state.mkdirs)}`);
    // The sentinel MUST exist after firstRun returns.
    assert.ok(state.written.has(sentinel),
      `sentinel ${sentinel} must be created on first run; written: ${[...state.written.keys()].join(", ")}`);
  } finally { cleanup(); }
});

test("AC2: firstRun prints the one-line message when the sentinel is present", () => {
  const { dir, cleanup } = tempDir();
  try {
    const sentinel = join(dir, ".welcome-seen");
    const { deps, state } = fakeDeps();
    state.existing.add(sentinel);
    firstRun(baseOpts({ sentinelPath: sentinel }), deps);
    const joined = state.logs.join("\n");
    assert.equal(/first run/i.test(joined), false,
      "the full welcome must NOT print when the sentinel exists");
    // One-line message names the host + port.
    assert.equal(state.logs.length, 1,
      `expected exactly one log line; got ${state.logs.length}: ${JSON.stringify(state.logs)}`);
    assert.match(state.logs[0], /127\.0\.0\.1:7070/,
      "one-line message must include the host:port");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — override flags
// ────────────────────────────────────────────────────────────────────

test("AC3: force=true prints the welcome even when the sentinel exists", () => {
  const sentinel = "/tmp/fleet-welcome-already-seen";
  const { deps, state } = fakeDeps();
  state.existing.add(sentinel);
  firstRun(baseOpts({ sentinelPath: sentinel }), deps, { force: true });
  const joined = state.logs.join("\n");
  assert.match(joined, /first run/i, "force=true must reprint the full welcome");
});

test("AC3: suppress=true skips the welcome even when the sentinel is absent", () => {
  const sentinel = "/tmp/fleet-welcome-not-seen";
  const { deps, state } = fakeDeps();
  firstRun(baseOpts({ sentinelPath: sentinel }), deps, { suppress: true });
  // No welcome lines whatsoever — the one-line message MAY still be printed,
  // but the multi-line "first run" header must NOT.
  const joined = state.logs.join("\n");
  assert.equal(/first run/i.test(joined), false,
    "suppress=true must skip the full welcome");
  // The sentinel must NOT be created either (suppress is read-only).
  assert.equal(state.written.has(sentinel), false,
    "suppress=true must not write the sentinel");
});

// ────────────────────────────────────────────────────────────────────
// AC4 — the admin token literal MUST NEVER appear in the rendered string
// ────────────────────────────────────────────────────────────────────

test("AC4: the rendered welcome MUST NOT contain the admin token literal", () => {
  const token = "extremely_secret_admin_token_value_DO_NOT_LEAK_12345";
  const out = renderWelcome(baseOpts({ token }));
  assert.equal(out.includes(token), false,
    "the admin token must NEVER appear in renderWelcome output");
});

test("AC4: even a token shaped like our long base64 alphabet is redacted at the boundary", () => {
  // Simulate a future regression where someone accidentally wires the
  // token into a detail line — redactSecrets must catch it as a
  // defence-in-depth layer.
  const leakyOpts = baseOpts({
    token: "AbCdEfGh1234567890_AbCdEfGh1234567890_AbCdEfGh1234567890",
  });
  const out = renderWelcome(leakyOpts);
  assert.equal(out.includes("AbCdEfGh1234567890_AbCdEfGh1234567890_AbCdEfGh1234567890"), false,
    "leaky token-shaped substrings must be redacted by renderWelcome's renderer-boundary backstop");
});

// ────────────────────────────────────────────────────────────────────
// AC5 — colour iff TTY
// ────────────────────────────────────────────────────────────────────

test("AC5: color=true output contains ANSI escape codes", () => {
  const out = renderWelcome(baseOpts({ color: true }));
  assert.match(out, /\x1b\[\d+m/,
    "color=true should produce at least one ANSI escape sequence");
});

test("AC5: color=false output contains NO ANSI escape codes", () => {
  const out = renderWelcome(baseOpts({ color: false }));
  assert.equal(/\x1b\[\d+m/.test(out), false,
    "color=false must NOT produce any ANSI escape sequence");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — sentinel write failures degrade gracefully
// ────────────────────────────────────────────────────────────────────

test("AC7: a non-writable sentinel does not crash; emits one warn line and continues", () => {
  const sentinel = "/proc/cannot/write/here/.welcome-seen";
  const writeErr = new Error("EACCES: permission denied");
  const { deps, state } = fakeDeps({
    writeFile: () => { throw writeErr; },
    mkdir: () => { throw writeErr; },
  });
  // Must NOT throw.
  assert.doesNotThrow(() => {
    firstRun(baseOpts({ sentinelPath: sentinel }), deps);
  }, "firstRun must swallow sentinel-write failures");
  // Must emit a single warning line.
  assert.equal(state.warns.length, 1,
    `expected exactly one warn line; got ${state.warns.length}: ${JSON.stringify(state.warns)}`);
  assert.match(state.warns[0], /warn:/i, "warn line must be tagged 'warn:'");
  // The welcome itself was still printed (the warning is a side-channel,
  // not a substitute for the user-facing message).
  assert.match(state.logs.join("\n"), /first run/i,
    "welcome must still print even when the sentinel write fails");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — first-project hint
// ────────────────────────────────────────────────────────────────────

test("AC8: zero projects → step 3 prints `fleetctl register <github-url>`", () => {
  const out = renderWelcome(baseOpts({ projects: [] }));
  assert.match(out, /3\.\s+Add your first project:\s+fleetctl register <github-url>/,
    "with no projects, step 3 must show the registration nudge");
});

test("AC8: >=1 project → step 3 lists existing slugs (capped at 3, ellipsis if more)", () => {
  // Three projects → no ellipsis.
  const three = renderWelcome(baseOpts({ projects: ["alpha", "bravo", "charlie"] }));
  assert.match(three, /3\.\s+Your projects:\s+alpha, bravo, charlie/,
    "three projects must render all three names without ellipsis");
  assert.equal(/\bfleetctl register <github-url>\b/.test(three), false,
    "with projects present, the register nudge must NOT appear in step 3");
  // Five projects → first 3 + ellipsis.
  const five = renderWelcome(baseOpts({
    projects: ["alpha", "bravo", "charlie", "delta", "echo"],
  }));
  assert.match(five, /3\.\s+Your projects:\s+alpha, bravo, charlie\s*…/,
    "more than three projects must list first 3 with a trailing ellipsis");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — geometry: ≤24 lines, ≤80 columns each
// ────────────────────────────────────────────────────────────────────

test("AC9: rendered welcome is ≤24 lines and no line exceeds 80 visible columns", () => {
  const out = renderWelcome(baseOpts());
  const lines = out.split("\n");
  // Trim a single trailing blank line if present — common from a final \n.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  assert.ok(lines.length <= 24,
    `welcome must be ≤24 lines; got ${lines.length}:\n${out}`);
  // Strip ANSI for visible-column counting.
  const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
  for (const line of lines) {
    const visible = stripAnsi(line);
    assert.ok(visible.length <= 80,
      `line exceeds 80 visible cols (${visible.length}): ${JSON.stringify(line)}`);
  }
});

// ────────────────────────────────────────────────────────────────────
// AC: sentinel path defaults
// ────────────────────────────────────────────────────────────────────

test("sentinelPathFor honours XDG_CONFIG_HOME when set", () => {
  const p = sentinelPathFor({ XDG_CONFIG_HOME: "/tmp/xdg", HOME: "/home/who" });
  assert.equal(p, "/tmp/xdg/fleet-control/.welcome-seen",
    "XDG_CONFIG_HOME wins over $HOME/.config");
});

test("sentinelPathFor honours FLEET_HOME (test seam) over XDG / HOME", () => {
  const p = sentinelPathFor({
    FLEET_HOME: "/tmp/fleet-home",
    XDG_CONFIG_HOME: "/tmp/xdg",
    HOME: "/home/who",
  });
  assert.equal(p, "/tmp/fleet-home/fleet-control/.welcome-seen",
    "FLEET_HOME test seam must win over XDG_CONFIG_HOME and HOME");
});

test("sentinelPathFor falls back to $HOME/.config when neither override is set", () => {
  const p = sentinelPathFor({ HOME: "/home/who" });
  assert.equal(p, "/home/who/.config/fleet-control/.welcome-seen",
    "default sentinel path = $HOME/.config/fleet-control/.welcome-seen");
});

// ────────────────────────────────────────────────────────────────────
// AC6 — CLI subprocess: `fleetctl serve` cold start prints the welcome
// before any request handler runs. Uses FLEET_HOME + FLEET_DB_PATH per
// LESSONS.md so the operator's real $HOME is never touched.
// ────────────────────────────────────────────────────────────────────

interface ServeChildHandle {
  child: ReturnType<typeof spawn>;
  stdoutBuf: string;
  stderrBuf: string;
  fleetHome: string;
  dbPath: string;
  port: number;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    import("node:net").then((net) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const a = srv.address();
        if (a && typeof a === "object") {
          const p = a.port;
          srv.close(() => resolve(p));
        } else { srv.close(); reject(new Error("no port")); }
      });
      srv.on("error", reject);
    }).catch(reject);
  });
}

function spawnServe(extraArgs: string[], env: Record<string, string>): ServeChildHandle {
  const handle: ServeChildHandle = {
    child: spawn(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      join(REPO_ROOT, "bin", "fleetctl.ts"),
      "serve",
      ...extraArgs,
    ], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: env.FLEET_CWD ?? mkdtempSync(join(tmpdir(), "fleet-cwd-")),
    }),
    stdoutBuf: "",
    stderrBuf: "",
    fleetHome: env.FLEET_HOME ?? "",
    dbPath: env.FLEET_DB_PATH ?? "",
    port: Number(env.FLEET_PORT ?? "0"),
  };
  handle.child.stdout?.on("data", (c) => { handle.stdoutBuf += String(c); });
  handle.child.stderr?.on("data", (c) => { handle.stderrBuf += String(c); });
  return handle;
}

async function waitForLine(h: ServeChildHandle, needle: RegExp, maxMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = (): void => {
      if (needle.test(h.stdoutBuf) || needle.test(h.stderrBuf)) return resolve();
      if (Date.now() - t0 > maxMs) {
        return reject(new Error(`needle ${needle} not seen in ${maxMs}ms; stdout=${h.stdoutBuf}; stderr=${h.stderrBuf}`));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function killAndWait(child: ReturnType<typeof spawn>): Promise<void> {
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    let done = false;
    const settle = (): void => { if (!done) { done = true; resolve(); } };
    child.on("exit", settle);
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } settle(); }, 1500);
  });
}

test("AC6: `fleetctl serve` cold start prints the welcome BEFORE accepting requests", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "fleet-cwd-"));
  const fleetHome = mkdtempSync(join(tmpdir(), "fleet-home-"));
  const dbPath = join(cwd, "fleet.db");
  // Plant an empty-roots config so the synchronous runIngestPass in
  // startServer doesn't walk the operator's real fleet (LESSONS.md §
  // in-process startServer tests need an empty-roots config).
  const emptyRoots = join(cwd, "empty");
  mkdirSync(emptyRoots, { recursive: true });
  writeFileSync(join(cwd, "fleet-control.config.json"), JSON.stringify({
    projectRoots: [emptyRoots],
    installedRoot: emptyRoots,
    cacheBase: emptyRoots,
    claudeProjects: emptyRoots,
  }));
  const port = await freePort();
  const h = spawnServe([], {
    FLEET_PORT: String(port),
    FLEET_HOME: fleetHome,
    FLEET_DB_PATH: dbPath,
    FLEET_CWD: cwd,
  });
  try {
    await waitForLine(h, /first run/i);
    // The welcome must precede the server's own listen banner (or at
    // worst, be intermixed — we assert by checking the welcome appears
    // anywhere in stdout, plus the server then accepts a connection).
    const r = await fetch(`http://127.0.0.1:${port}/api/whoami`);
    assert.equal(r.status, 200, "serve must accept a request after the welcome prints");
    // The sentinel file must now exist under FLEET_HOME.
    const sentinel = join(fleetHome, "fleet-control", ".welcome-seen");
    assert.ok(existsSync(sentinel),
      `sentinel must be created at ${sentinel}; FLEET_HOME=${fleetHome}`);
  } finally {
    await killAndWait(h.child);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fleetHome, { recursive: true, force: true });
  }
});

test("AC6: `fleetctl serve --no-welcome` suppresses the welcome on a fresh sentinel", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "fleet-cwd-"));
  const fleetHome = mkdtempSync(join(tmpdir(), "fleet-home-"));
  const dbPath = join(cwd, "fleet.db");
  const emptyRoots = join(cwd, "empty");
  mkdirSync(emptyRoots, { recursive: true });
  writeFileSync(join(cwd, "fleet-control.config.json"), JSON.stringify({
    projectRoots: [emptyRoots],
    installedRoot: emptyRoots,
    cacheBase: emptyRoots,
    claudeProjects: emptyRoots,
  }));
  const port = await freePort();
  const h = spawnServe(["--no-welcome"], {
    FLEET_PORT: String(port),
    FLEET_HOME: fleetHome,
    FLEET_DB_PATH: dbPath,
    FLEET_CWD: cwd,
  });
  try {
    // Wait for the regular listen banner instead of the welcome.
    await waitForLine(h, /fleet-control portal/);
    assert.equal(/first run/i.test(h.stdoutBuf), false,
      "--no-welcome must suppress the cold-start welcome");
    // Sentinel must NOT have been created either (suppress is read-only).
    const sentinel = join(fleetHome, "fleet-control", ".welcome-seen");
    assert.equal(existsSync(sentinel), false,
      "--no-welcome must NOT create the sentinel");
  } finally {
    await killAndWait(h.child);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(fleetHome, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────
// AC10 — no new runtime deps; CLI-only (no /api shape change)
// ────────────────────────────────────────────────────────────────────

test("AC10: package.json dependencies stays empty (zero-dep contract)", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    "ticket 0024 must not add a runtime dependency; saw: " + JSON.stringify(deps));
});

test("AC10: src/welcome.ts does not import child_process (CLI render only — no shell-out)", () => {
  const txt = readFileSync(join(REPO_ROOT, "src", "welcome.ts"), "utf8");
  assert.equal(/from\s+["']node:child_process["']/.test(txt), false,
    "welcome module must not shell out");
  assert.equal(/require\(["']node:child_process["']\)/.test(txt), false,
    "welcome module must not require child_process either");
});
