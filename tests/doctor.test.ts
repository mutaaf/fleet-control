// Tests for `fleetctl doctor` (ticket 0016).
//
// Each `test(...)` maps 1:1 to one acceptance-criteria checkbox in
// docs/backlog/0016-fleetctl-doctor.md. The doctor module is built
// around an injected dependency surface (DoctorDeps) so every check
// runs without spawning a real binary, touching the operator's real
// HOME, or hitting the network. The CLI integration test drives the
// `doctor` subcommand via `spawnSync` so the argv parser, exit-code
// logic, and `--json` output are all exercised end-to-end.
//
// Zero new runtime deps; stdlib + node:test only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../src/db.ts";
import {
  runDoctor,
  checkNodeVersion,
  checkTscAvailable,
  checkSqliteAvailable,
  checkConfigFile,
  checkGitignoreCoversConfig,
  checkProjectRoots,
  checkIngestFreshness,
  checkFleetdLoaded,
  checkAdminSocket,
  checkGhAuth,
  checkNtfyReachable,
  type DoctorDeps,
  type DoctorCheck,
} from "../src/doctor.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

interface ExecCall { cmd: string; args: string[]; }

interface ExecStub {
  /** Map of `${cmd} ${args.join(" ")}` → handler, returns stdout or throws. */
  responses?: Map<string, () => { stdout: string; code: number } | { stdout: string; code: number }>;
  /** Fallback for any unmatched call. */
  fallback?: (cmd: string, args: string[]) => { stdout: string; code: number };
}

interface BuiltDeps {
  deps: DoctorDeps;
  calls: ExecCall[];
}

function buildDeps(opts: {
  exec?: (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>;
  readFile?: (path: string) => string | null;
  fileExists?: (path: string) => boolean;
  dbQuery?: <T = unknown>(sql: string, params?: unknown[]) => T[];
  env?: Record<string, string | undefined>;
  nodeVersion?: string;
  fetchUrl?: (url: string) => Promise<{ ok: boolean; status: number; error?: string }>;
  loadConfigFn?: () => { projectRoots: string[]; installedRoot: string };
} = {}): BuiltDeps {
  const calls: ExecCall[] = [];
  const deps: DoctorDeps = {
    exec: opts.exec ?? (async (cmd, args) => {
      calls.push({ cmd, args });
      return { stdout: "", code: 0 };
    }),
    readFile: opts.readFile ?? (() => null),
    fileExists: opts.fileExists ?? (() => false),
    dbQuery: opts.dbQuery ?? (() => []),
    env: opts.env ?? {},
    nodeVersion: opts.nodeVersion ?? "v23.5.0",
    fetchUrl: opts.fetchUrl ?? (async () => ({ ok: true, status: 200 })),
    loadConfigFn: opts.loadConfigFn ?? (() => ({
      projectRoots: ["/tmp/no-such-root"],
      installedRoot: "/tmp/no-such-installed",
    })),
  };
  // Wrap the user-provided exec so we always record calls.
  if (opts.exec) {
    const userExec = opts.exec;
    deps.exec = async (cmd, args) => {
      calls.push({ cmd, args });
      return userExec(cmd, args);
    };
  }
  return { deps, calls };
}

// ────────────────────────────────────────────────────────────────────
// AC1 — runDoctor returns the documented shape; ok aggregates correctly
// ────────────────────────────────────────────────────────────────────

test("AC1: runDoctor returns {checks: [...], ok: boolean} and aggregates ok via every-check-ok-or-warn", async () => {
  // All-OK scenario: every dep returns the happy result.
  const { deps } = buildDeps({
    exec: async (cmd) => {
      if (cmd === "npx") return { stdout: "5.6.3\n", code: 0 };
      if (cmd === "launchctl") return { stdout: "12345 0 com.fleet.control.fleetd\n", code: 0 };
      if (cmd === "gh") return { stdout: "Logged in to github.com as foo", code: 0 };
      return { stdout: "", code: 0 };
    },
    fileExists: (p) => p.endsWith("fleet-control.config.json") || p.endsWith(".gitignore"),
    readFile: (p) => {
      if (p.endsWith("fleet-control.config.json")) {
        return JSON.stringify({ adminToken: "secret_test_token_for_doctor", projectRoots: [] });
      }
      if (p.endsWith(".gitignore")) return "node_modules\nfleet-control.config.json\n";
      return null;
    },
    dbQuery: <T,>(sql: string): T[] => {
      if (sql.includes("sqlite_version")) return [{ v: "3.45.0" }] as unknown as T[];
      return [] as T[];
    },
    loadConfigFn: () => ({ projectRoots: [], installedRoot: "/tmp/no-such-installed" }),
  });
  const r = await runDoctor(deps);
  assert.ok(Array.isArray(r.checks), "checks must be an array");
  for (const c of r.checks) {
    assert.ok(typeof c.category === "string" && c.category.length > 0, "category");
    assert.ok(typeof c.name === "string" && c.name.length > 0, "name");
    assert.ok(["ok", "warn", "fail"].includes(c.status), `bad status: ${c.status}`);
  }
  assert.equal(typeof r.ok, "boolean");
  // No failing dep here → ok must be true (warns are allowed).
  assert.equal(r.ok, true, "all-ok scenario should aggregate to ok:true");
});

test("AC1: any single ✗ in the check list flips runDoctor.ok to false", async () => {
  // Force the node-version check to fail by pinning an old version.
  const { deps } = buildDeps({
    nodeVersion: "v18.0.0",
    exec: async () => ({ stdout: "", code: 0 }),
  });
  const r = await runDoctor(deps);
  assert.equal(r.ok, false, "with a failing check, runDoctor.ok must be false");
  assert.ok(r.checks.some((c) => c.status === "fail"), "must contain at least one fail");
});

// ────────────────────────────────────────────────────────────────────
// AC2 — runtime checks (node ≥23, tsc resolves, sqlite_version)
// ────────────────────────────────────────────────────────────────────

test("AC2: node version <23 fails with a fix line that names a concrete upgrade", async () => {
  const { deps } = buildDeps({ nodeVersion: "v22.5.0" });
  const c = await checkNodeVersion(deps);
  assert.equal(c.status, "fail");
  assert.ok(c.fix, "fail must carry a fix line");
  assert.match(c.fix!, /node/i, "fix line must mention node");
});

test("AC2: node version >=23 passes", async () => {
  const { deps } = buildDeps({ nodeVersion: "v23.5.0" });
  const c = await checkNodeVersion(deps);
  assert.equal(c.status, "ok");
});

test("AC2: `npx tsc --version` failure surfaces a fix line that names `npm ci`", async () => {
  const { deps } = buildDeps({
    exec: async (cmd) => {
      if (cmd === "npx") return { stdout: "", code: 127 };
      return { stdout: "", code: 0 };
    },
  });
  const c = await checkTscAvailable(deps);
  assert.equal(c.status, "fail");
  assert.ok(c.fix, "fail must carry a fix line");
  assert.match(c.fix!, /npm ci/, "fix should suggest `npm ci`");
});

test("AC2: sqlite_version unavailable fails with a fix line", async () => {
  const { deps } = buildDeps({
    dbQuery: () => { throw new Error("sqlite_version() not callable"); },
  });
  const c = await checkSqliteAvailable(deps);
  assert.equal(c.status, "fail");
  assert.ok(c.fix && c.fix.length > 0, "fail must carry a fix line");
});

test("AC2: sqlite_version returns a row → ok", async () => {
  const { deps } = buildDeps({
    dbQuery: <T,>() => [{ v: "3.45.0" }] as unknown as T[],
  });
  const c = await checkSqliteAvailable(deps);
  assert.equal(c.status, "ok");
});

// ────────────────────────────────────────────────────────────────────
// AC3 — config checks (fleet-control.config.json + gitignore)
// ────────────────────────────────────────────────────────────────────

test("AC3: missing fleet-control.config.json fails; fix line names `fleetctl` init flow", async () => {
  const { deps } = buildDeps({ fileExists: () => false });
  const c = await checkConfigFile(deps);
  assert.equal(c.status, "fail");
  assert.ok(c.fix, "fail must carry a fix line");
  // The fix line must name something the operator can copy/paste.
  // "fleetctl serve" auto-generates the config on first run.
  assert.match(c.fix!, /fleetctl/, "fix should name fleetctl");
});

test("AC3: present-but-malformed config fails with a parse-error fix", async () => {
  const { deps } = buildDeps({
    fileExists: (p) => p.endsWith("fleet-control.config.json"),
    readFile: () => "{ not valid json",
  });
  const c = await checkConfigFile(deps);
  assert.equal(c.status, "fail");
  assert.match(c.detail ?? "", /parse|json/i);
});

test("AC3: present + parses + has admin token → ok", async () => {
  const { deps } = buildDeps({
    fileExists: (p) => p.endsWith("fleet-control.config.json"),
    readFile: () => JSON.stringify({ adminToken: "some_real_token_value" }),
  });
  const c = await checkConfigFile(deps);
  assert.equal(c.status, "ok");
});

test("AC3: gitignore missing config entry fails with a fix line that names the entry", async () => {
  const { deps } = buildDeps({
    fileExists: (p) => p.endsWith(".gitignore"),
    readFile: (p) => {
      if (p.endsWith(".gitignore")) return "node_modules\n";
      return null;
    },
  });
  const c = await checkGitignoreCoversConfig(deps);
  assert.equal(c.status, "fail");
  assert.ok(c.fix, "fail must carry a fix line");
  assert.match(c.fix!, /fleet-control\.config\.json/);
});

test("AC3: gitignore present and lists fleet-control.config.json → ok", async () => {
  const { deps } = buildDeps({
    fileExists: (p) => p.endsWith(".gitignore"),
    readFile: () => "node_modules\nfleet-control.config.json\n",
  });
  const c = await checkGitignoreCoversConfig(deps);
  assert.equal(c.status, "ok");
});

// ────────────────────────────────────────────────────────────────────
// AC4 — discovery checks (walk roots; valid project + near-miss)
// ────────────────────────────────────────────────────────────────────

test("AC4: discovery — valid project + near-miss dir → one ok + one fail/warn line", async () => {
  // Stub a project root that has TWO subdirs: one with agents.config.sh
  // (valid), one without (near-miss).
  const validDir = "/tmp/fakeroot/valid-project";
  const nearMissDir = "/tmp/fakeroot/near-miss";
  const validManifest = join(validDir, "agents.config.sh");
  const { deps } = buildDeps({
    loadConfigFn: () => ({
      projectRoots: ["/tmp/fakeroot"],
      installedRoot: "/tmp/no-such-installed",
    }),
    fileExists: (p) => p === "/tmp/fakeroot" || p === validDir || p === nearMissDir || p === validManifest,
    readFile: (p) => {
      if (p === validManifest) {
        return `PROJECT_NAME="valid"\nSLUG="valid-project"\nNAMESPACE="com.valid"\nREPO_URL="https://github.com/example/valid"\n`;
      }
      return null;
    },
  });
  // Provide a list of children — the test stub does so via a special
  // readdir hook on the deps.
  deps.readdir = (p: string): string[] => {
    if (p === "/tmp/fakeroot") return ["valid-project", "near-miss"];
    return [];
  };
  const checks = await checkProjectRoots(deps);
  assert.ok(checks.length >= 2, `expected at least 2 check lines, got ${checks.length}`);
  const ok = checks.find((c) => c.status === "ok");
  const notOk = checks.find((c) => c.status === "fail" || c.status === "warn");
  assert.ok(ok, "must surface the valid project as ok");
  assert.ok(notOk, "must surface the near-miss as fail or warn");
});

test("AC4: discovery — empty project root → warn (not fail)", async () => {
  const { deps } = buildDeps({
    loadConfigFn: () => ({
      projectRoots: ["/tmp/empty-root"],
      installedRoot: "/tmp/no-such-installed",
    }),
    fileExists: (p) => p === "/tmp/empty-root",
  });
  deps.readdir = () => [];
  const checks = await checkProjectRoots(deps);
  const rootCheck = checks.find((c) => c.detail?.includes("/tmp/empty-root"));
  assert.ok(rootCheck, "must surface a check for the empty root");
  assert.equal(rootCheck!.status, "warn", "empty root is a warning, not a failure");
});

// ────────────────────────────────────────────────────────────────────
// AC5 — ingest freshness (per-project last agent_event)
// ────────────────────────────────────────────────────────────────────

test("AC5: project with zero agent_event rows → fail", async () => {
  // The dbQuery stub returns the slug + 0 events.
  const { deps } = buildDeps({
    dbQuery: <T,>(sql: string): T[] => {
      if (sql.includes("FROM project")) {
        return [{ slug: "fresh", last_ts: null }] as unknown as T[];
      }
      return [] as T[];
    },
    exec: async (cmd) => {
      if (cmd === "launchctl") return { stdout: "12345 0 com.fresh.agent-ship\n", code: 0 };
      return { stdout: "", code: 0 };
    },
  });
  const checks = await checkIngestFreshness(deps);
  const fresh = checks.find((c) => c.detail?.includes("fresh"));
  assert.ok(fresh, "must surface a per-project check");
  assert.equal(fresh!.status, "fail");
});

test("AC5: project with last event >24h old → warn; fix names launchctl kickstart", async () => {
  const stale = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  const { deps } = buildDeps({
    dbQuery: <T,>(sql: string): T[] => {
      if (sql.includes("FROM project")) {
        return [{ slug: "stale", last_ts: stale }] as unknown as T[];
      }
      return [] as T[];
    },
    exec: async (cmd, args) => {
      // launchctl list grep returns one matching line per phase so the
      // checker can say "loaded but stale".
      if (cmd === "launchctl" && args[0] === "list") {
        return { stdout: "12345 0 com.stale.agent-ship\n", code: 0 };
      }
      return { stdout: "", code: 0 };
    },
  });
  const checks = await checkIngestFreshness(deps);
  const stl = checks.find((c) => c.detail?.includes("stale"));
  assert.ok(stl, "stale project must surface a check");
  assert.equal(stl!.status, "warn");
  assert.ok(stl!.fix, "warn must carry a fix line");
  assert.match(stl!.fix!, /launchctl kickstart/, "fix line must name launchctl kickstart");
});

test("AC5: project with recent event (< 24h) → ok", async () => {
  const recent = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const { deps } = buildDeps({
    dbQuery: <T,>(sql: string): T[] => {
      if (sql.includes("FROM project")) {
        return [{ slug: "live", last_ts: recent }] as unknown as T[];
      }
      return [] as T[];
    },
  });
  const checks = await checkIngestFreshness(deps);
  const live = checks.find((c) => c.detail?.includes("live"));
  assert.ok(live);
  assert.equal(live!.status, "ok");
});

// ────────────────────────────────────────────────────────────────────
// AC6 — control checks (fleetd loaded; /api/health responds)
// ────────────────────────────────────────────────────────────────────

test("AC6: fleetd missing from launchctl → fail with a fix line", async () => {
  const { deps } = buildDeps({
    exec: async (cmd) => {
      if (cmd === "launchctl") return { stdout: "", code: 0 };
      return { stdout: "", code: 0 };
    },
  });
  const c = await checkFleetdLoaded(deps);
  assert.equal(c.status, "fail");
  assert.ok(c.fix);
  assert.match(c.fix!, /fleetctl daemon on|launchctl load/i);
});

test("AC6: fleetd present in launchctl → ok", async () => {
  const { deps } = buildDeps({
    exec: async (cmd) => {
      if (cmd === "launchctl") return { stdout: "12345 0 com.fleet.control.fleetd\n", code: 0 };
      return { stdout: "", code: 0 };
    },
  });
  const c = await checkFleetdLoaded(deps);
  assert.equal(c.status, "ok");
});

test("AC6: admin socket /api/health unreachable → fail with a fix line", async () => {
  const { deps } = buildDeps({
    fetchUrl: async () => ({ ok: false, status: 0, error: "ECONNREFUSED" }),
  });
  const c = await checkAdminSocket(deps);
  assert.equal(c.status, "fail");
  assert.ok(c.fix);
  assert.match(c.fix!, /fleetctl serve|daemon/);
});

test("AC6: admin socket /api/health returns 200 → ok", async () => {
  const { deps } = buildDeps({
    fetchUrl: async () => ({ ok: true, status: 200 }),
  });
  const c = await checkAdminSocket(deps);
  assert.equal(c.status, "ok");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — network checks (gh, ntfy)
// ────────────────────────────────────────────────────────────────────

test("AC7: gh auth status non-zero → warn (gh is optional)", async () => {
  const { deps } = buildDeps({
    exec: async (cmd) => {
      if (cmd === "gh") return { stdout: "", code: 1 };
      return { stdout: "", code: 0 };
    },
  });
  const c = await checkGhAuth(deps);
  assert.equal(c.status, "warn", "gh missing must warn, not fail");
  assert.ok(c.fix);
  assert.match(c.fix!, /gh auth login/);
});

test("AC7: gh auth status ok → ok", async () => {
  const { deps } = buildDeps({
    exec: async (cmd) => {
      if (cmd === "gh") return { stdout: "Logged in to github.com as foo", code: 0 };
      return { stdout: "", code: 0 };
    },
  });
  const c = await checkGhAuth(deps);
  assert.equal(c.status, "ok");
});

test("AC7: ntfy.sh unreachable when push enabled → warn", async () => {
  const { deps } = buildDeps({
    loadConfigFn: () => ({ projectRoots: [], installedRoot: "/tmp/x" }),
    fetchUrl: async () => ({ ok: false, status: 0, error: "ETIMEDOUT" }),
  });
  // Indicate push is enabled via a synthetic ntfyTopic in the config dep.
  deps.ntfyTopicConfigured = true;
  const c = await checkNtfyReachable(deps);
  assert.equal(c.status, "warn", "unreachable ntfy is a warn, not a fail");
});

test("AC7: ntfy not configured → ok (skipped)", async () => {
  const { deps } = buildDeps({
    fetchUrl: async () => ({ ok: false, status: 0, error: "should not be called" }),
  });
  deps.ntfyTopicConfigured = false;
  const c = await checkNtfyReachable(deps);
  assert.equal(c.status, "ok");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — bin/fleetctl.ts `doctor` subcommand (exit codes + --json)
// ────────────────────────────────────────────────────────────────────

interface CliRun { code: number; stdout: string; stderr: string; }
function runCli(args: string[], env: Record<string, string> = {}): CliRun {
  const r = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    join(REPO_ROOT, "bin", "fleetctl.ts"),
    ...args,
  ], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("AC8: `fleetctl doctor` runs and prints human-readable output", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-doctor-cli-"));
  const dbPath = join(dir, "fleet.db");
  try {
    // Seed a clean DB so the doctor has a real handle to query.
    const seed = openDb(dbPath);
    seed.close();
    const r = runCli(["doctor"], {
      HOME: dir,
      FLEET_DB_PATH: dbPath,
      // Disable real shell-out / network probes so the test stays hermetic.
      FLEET_DOCTOR_OFFLINE: "1",
    });
    // Exit code 0 (all ok) or 1 (some ✗) — both prove the CLI ran.
    // 2 would mean "doctor itself crashed" which would fail the test.
    assert.ok(r.code === 0 || r.code === 1, `unexpected exit code ${r.code}: stderr=${r.stderr}`);
    // Must look like a checklist — at least one category header word.
    assert.ok(
      /runtime|config|discovery|ingest|control|network/i.test(r.stdout),
      "human output should contain at least one category word",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("AC8: `fleetctl doctor --json` emits parseable JSON with checks[]+ok", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-doctor-json-"));
  const dbPath = join(dir, "fleet.db");
  try {
    const seed = openDb(dbPath);
    seed.close();
    const r = runCli(["doctor", "--json"], {
      HOME: dir,
      FLEET_DB_PATH: dbPath,
      FLEET_DOCTOR_OFFLINE: "1",
    });
    assert.ok(r.code === 0 || r.code === 1, `unexpected exit ${r.code}: stderr=${r.stderr}`);
    // Stdout must be parseable JSON, top-level shape matches.
    let parsed: any;
    try { parsed = JSON.parse(r.stdout); }
    catch (e: any) { assert.fail(`--json output not parseable: ${e?.message}\nstdout:\n${r.stdout}`); }
    assert.ok(Array.isArray(parsed.checks), "json.checks must be an array");
    assert.equal(typeof parsed.ok, "boolean", "json.ok must be a boolean");
    for (const c of parsed.checks) {
      assert.ok(typeof c.category === "string");
      assert.ok(typeof c.name === "string");
      assert.ok(["ok", "warn", "fail"].includes(c.status));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("AC8: exit code is 1 when any check fails", async () => {
  // Drive the in-process runDoctor with a guaranteed fail, then assert
  // the helper that maps result → exit code returns 1. We import the
  // mapping helper so we don't have to spawn a subprocess just for this.
  const { exitCodeFor } = await import("../src/doctor.ts");
  assert.equal(exitCodeFor({ checks: [{ category: "x", name: "y", status: "fail" }], ok: false }), 1);
  assert.equal(exitCodeFor({ checks: [{ category: "x", name: "y", status: "ok" }], ok: true }), 0);
  assert.equal(exitCodeFor({ checks: [{ category: "x", name: "y", status: "warn" }], ok: true }), 0);
});

// ────────────────────────────────────────────────────────────────────
// AC9 — perf: 7-project fleet under 2s (gated by PERF=1)
// ────────────────────────────────────────────────────────────────────

test("AC9: 7-project fleet runs doctor under 2s (PERF=1)", { skip: process.env.PERF !== "1" }, async () => {
  const dbRows = Array.from({ length: 7 }, (_, i) => ({
    slug: `proj-${i}`,
    last_ts: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  }));
  const { deps } = buildDeps({
    dbQuery: <T,>(sql: string): T[] => {
      if (sql.includes("FROM project")) return dbRows as unknown as T[];
      if (sql.includes("sqlite_version")) return [{ v: "3.45.0" }] as unknown as T[];
      return [] as T[];
    },
    exec: async () => ({ stdout: "12345 0 com.fleet.control.fleetd\n", code: 0 }),
    fetchUrl: async () => ({ ok: true, status: 200 }),
  });
  const t0 = Date.now();
  await runDoctor(deps);
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `doctor took ${ms}ms on a 7-project fleet (must be <2000)`);
});

// ────────────────────────────────────────────────────────────────────
// AC10 — never prints admin token, repo URLs, or gh PAT
// ────────────────────────────────────────────────────────────────────

test("AC10: token/repo-url/PAT literals never appear in human or JSON output", async () => {
  const TOKEN = "secret_admin_token_aaaaaaaaaaaaaaaaaaaaaaaaa";
  const PAT = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const REPO_URL = "https://github.com/private-owner/private-repo";
  const { deps } = buildDeps({
    fileExists: (p) => p.endsWith("fleet-control.config.json"),
    readFile: (p) => {
      if (p.endsWith("fleet-control.config.json")) {
        return JSON.stringify({
          adminToken: TOKEN,
          ghToken: PAT,
        });
      }
      return null;
    },
    dbQuery: <T,>(sql: string): T[] => {
      if (sql.includes("FROM project")) {
        return [{ slug: "secret-proj", last_ts: new Date().toISOString(), repo_url: REPO_URL }] as unknown as T[];
      }
      if (sql.includes("sqlite_version")) {
        return [{ v: "3.45.0" }] as unknown as T[];
      }
      return [] as T[];
    },
    env: { GH_TOKEN: PAT },
  });
  const r = await runDoctor(deps);

  // Build BOTH renderings — the human and the json — and assert neither
  // contains the secrets verbatim.
  const { renderHuman, renderJson } = await import("../src/doctor.ts");
  const human = renderHuman(r, { color: false });
  const json = renderJson(r);
  for (const secret of [TOKEN, PAT, REPO_URL]) {
    assert.ok(!human.includes(secret), `human output leaked: ${secret}`);
    assert.ok(!json.includes(secret), `json output leaked: ${secret}`);
  }
});

// ────────────────────────────────────────────────────────────────────
// AC11 — zero-dep, execFile-only (asserted statically via source)
// ────────────────────────────────────────────────────────────────────

test("AC11: src/doctor.ts only uses execFile / spawn argv-array shell-outs (no shell strings)", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(join(REPO_ROOT, "src", "doctor.ts"), "utf8");
  // Must not IMPORT the shell-string variants of exec/execSync from
  // node:child_process. (We allow `deps.exec(...)` method calls on the
  // injected dependency surface — those route through execFile.)
  assert.ok(
    !/from\s+["']node:child_process["'][^;]*\b(exec|execSync)\b(?![A-Za-z])/.test(src.replace(/\n/g, " ")),
    "src/doctor.ts must not import { exec, execSync } from node:child_process",
  );
  // Must not call spawn with {shell:true}.
  assert.ok(!/\bspawn\s*\([^,]*,\s*\{[^}]*shell\s*:\s*true/.test(src),
    "src/doctor.ts must not call spawn with {shell:true}");
});

// ────────────────────────────────────────────────────────────────────
// Ticket 0064 AC9 — doctor surface advertises the rate-limit middleware
// ────────────────────────────────────────────────────────────────────

test("0064 AC9: rate-limit doctor check hits /embed/pulse.html 5x and reports ok when the response is non-429", async () => {
  const { checkRateLimitWired } = await import("../src/doctor.ts");
  const calls: string[] = [];
  const { deps } = buildDeps({
    fetchUrl: async (url) => { calls.push(url); return { ok: true, status: 200 }; },
  });
  const c = await checkRateLimitWired(deps);
  assert.equal(c.status, "ok",
    "loopback 200 responses 5x in a row must report ok");
  // Five probes are documented in the AC.
  assert.equal(calls.length, 5,
    `expected exactly 5 probes, got ${calls.length}`);
  for (const u of calls) {
    assert.match(u, /\/embed\/pulse\.html$/,
      "every probe must target /embed/pulse.html");
  }
});

test("0064 AC9: rate-limit doctor check fails when the loopback /embed/pulse.html returns 429", async () => {
  const { checkRateLimitWired } = await import("../src/doctor.ts");
  const { deps } = buildDeps({
    fetchUrl: async () => ({ ok: false, status: 429 }),
  });
  const c = await checkRateLimitWired(deps);
  assert.equal(c.status, "fail",
    "a 429 from the loopback context means the loopback exemption is broken");
  assert.ok(c.fix, "fail must carry a fix line");
});

test("0064 AC9: new doctor check appears in BOTH human and JSON renderings of runDoctor", async () => {
  const { runDoctor, renderHuman, renderJson } = await import("../src/doctor.ts");
  const { deps } = buildDeps({
    fetchUrl: async () => ({ ok: true, status: 200 }),
    exec: async (cmd) => {
      // Drive launchctl towards a happy "fleetd loaded" response so
      // the suite stays green on the doctor-aggregate.
      if (cmd === "launchctl") return { stdout: "12345 0 com.fleet.control.fleetd\n", code: 0 };
      return { stdout: "", code: 0 };
    },
  });
  // Run in ONLINE mode (offline: false) so the new check is included;
  // every dep is stubbed via the injected surface so no real network
  // / shell-out happens.
  const r = await runDoctor(deps);
  const human = renderHuman(r, { color: false });
  const json = renderJson(r);
  assert.match(human, /rate-limit/i,
    "human output must surface the new check");
  assert.match(json, /rate-limit/i,
    "JSON output must surface the new check");
});

test("AC11: package.json `dependencies` stays empty", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    `dependencies must stay empty; found: ${Object.keys(deps).join(", ")}`);
});

// Silence unused imports — DoctorCheck is re-exported by typescript via the
// import statement above and pulled in by the test fixtures' inferred types.
void ({} as DoctorCheck);
void mkdirSync;
void writeFileSync;
