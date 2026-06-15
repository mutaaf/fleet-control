// Tests for ticket 0025 — `fleetctl demo` one-command sandbox.
//
// Each test maps 1:1 to an acceptance-criteria checkbox in
// docs/backlog/0025-fleetctl-demo-sandbox.md. We exercise three
// layers:
//   1. The pure-SQL fixture loader (src/demo/fixture.ts) — seeds three
//      projects + 30d of runs + PRs + anomalies + cost rollups against
//      a fresh tmpdir DB. Idempotent: re-loading produces no duplicate
//      rows. Timestamps are relative to load-time so the seeded fleet
//      always looks "recent".
//   2. startServer(opts.demoMode=true) — boots the same server path as
//      `serve` but skips every side-effecting tick (no ingest walk over
//      the operator's real filesystem, no launchctl, no gh, no ntfy).
//      The runner seam from src/control.ts catches any accidental
//      shell-out.
//   3. The CLI subcommand `bin/fleetctl.ts demo` end-to-end via
//      spawnSync — proves the banner string is byte-exact, SIGINT
//      tears down (HTTP server closed, DB handle closed, tmpdir
//      removed), and refuses to bind a non-loopback host.
//
// Discipline carried over from LESSONS.md:
//   - in-process startServer() tests plant an empty-roots
//     fleet-control.config.json in cwd so the synchronous
//     runIngestPass() call inside startServer doesn't walk the
//     operator's real fleet (§ "in-process startServer tests need an
//     empty-roots config");
//   - CLI subprocess tests pass FLEET_DB_PATH to point at a tmpdir DB
//     (§ "CLI subprocess tests need a FLEET_DB_PATH env seam");
//   - the runner seam in src/control.ts is reset on test teardown
//     (§ "shell-out modules need an injectable runner from day one").
//
// Zero new runtime deps; stdlib + node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { openDb, type DB } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import {
  loadDemoFixture, DEMO_BANNER, DEMO_DEFAULT_PORT, DEMO_PROJECT_SLUGS,
} from "../src/demo/fixture.ts";
import { _setRunnerForTests, _resetRunnerForTests } from "../src/control.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; cleanup: () => void; dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-demo-"));
  const dbPath = join(dir, "fleet.db");
  const db = openDb(dbPath);
  return {
    db,
    dir,
    dbPath,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function freePort(): Promise<number> {
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

interface Booted {
  base: string;
  close: () => Promise<void>;
  cleanup: () => void;
}

let activeBoots = 0;
let savedConfigText: string | null = null;
const CONFIG_PATH = join(process.cwd(), "fleet-control.config.json");

async function bootDemo(): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-demo-srv-"));
  const dbPath = join(dir, "fleet.db");
  if (activeBoots === 0) {
    savedConfigText = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null;
  }
  activeBoots += 1;
  const emptyRoots = join(dir, "empty");
  mkdirSync(emptyRoots, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({
    projectRoots: [emptyRoots],
    installedRoot: emptyRoots,
    cacheBase: emptyRoots,
    claudeProjects: emptyRoots,
  }));
  process.env.FLEET_DB_PATH = dbPath;
  // Seed the fixture against the same DB the server will open.
  const seedDb = openDb(dbPath);
  try { loadDemoFixture(seedDb); } finally { seedDb.close(); }
  const port = await freePort();
  // `demoMode: true` MUST short-circuit the inline runIngestPass in
  // startServer so the fixture survives and no real fleet is walked.
  const server = startServer("127.0.0.1", port, { demoMode: true });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + "/api/whoami"); if (r.ok) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  return {
    base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    cleanup: () => {
      delete process.env.FLEET_DB_PATH;
      activeBoots -= 1;
      if (activeBoots === 0) {
        if (savedConfigText === null) {
          try { unlinkSync(CONFIG_PATH); } catch { /* gone already */ }
        } else {
          writeFileSync(CONFIG_PATH, savedConfigText);
        }
        savedConfigText = null;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// AC2 — loadDemoFixture seeds three projects + runs + PRs + anomaly;
// idempotent.
// ────────────────────────────────────────────────────────────────────

test("AC2: loadDemoFixture seeds three projects with the expected slugs", () => {
  const { db, cleanup } = tempDb();
  try {
    loadDemoFixture(db);
    const rows = db.prepare("SELECT slug FROM project ORDER BY slug").all() as Array<{ slug: string }>;
    const slugs = rows.map((r) => r.slug);
    assert.deepEqual(slugs.sort(), [...DEMO_PROJECT_SLUGS].sort());
    assert.deepEqual(slugs.sort(), ["fleet-demo-api", "fleet-demo-cli", "fleet-demo-web"]);
  } finally { cleanup(); }
});

test("AC2: loadDemoFixture seeds 30d of runs and a populated cost_rollup_day", () => {
  const { db, cleanup } = tempDb();
  try {
    loadDemoFixture(db);
    const runs = (db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n;
    assert.ok(runs >= 30, `expected at least 30 runs, got ${runs}`);
    const rollups = (db.prepare("SELECT COUNT(*) AS n FROM cost_rollup_day").get() as { n: number }).n;
    assert.ok(rollups > 0, `expected populated cost_rollup_day, got ${rollups} rows`);
    const prs = (db.prepare("SELECT COUNT(*) AS n FROM pr").get() as { n: number }).n;
    assert.equal(prs, 6, "fixture must seed exactly 6 PR rows");
    const merged = (db.prepare("SELECT COUNT(*) AS n FROM pr WHERE state='merged'").get() as { n: number }).n;
    assert.equal(merged, 4, "4 of the 6 PRs must be merged");
    const open = (db.prepare("SELECT COUNT(*) AS n FROM pr WHERE state='open'").get() as { n: number }).n;
    assert.equal(open, 2, "2 of the 6 PRs must be open");
    const anomalies = (db.prepare("SELECT COUNT(*) AS n FROM anomaly").get() as { n: number }).n;
    assert.ok(anomalies >= 1, "fixture must seed at least one anomaly");
  } finally { cleanup(); }
});

test("AC2: loadDemoFixture is idempotent — second load yields identical row counts", () => {
  const { db, cleanup } = tempDb();
  try {
    loadDemoFixture(db);
    const before = {
      project: (db.prepare("SELECT COUNT(*) AS n FROM project").get() as { n: number }).n,
      run: (db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n,
      pr: (db.prepare("SELECT COUNT(*) AS n FROM pr").get() as { n: number }).n,
      anomaly: (db.prepare("SELECT COUNT(*) AS n FROM anomaly").get() as { n: number }).n,
    };
    loadDemoFixture(db);
    const after = {
      project: (db.prepare("SELECT COUNT(*) AS n FROM project").get() as { n: number }).n,
      run: (db.prepare("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n,
      pr: (db.prepare("SELECT COUNT(*) AS n FROM pr").get() as { n: number }).n,
      anomaly: (db.prepare("SELECT COUNT(*) AS n FROM anomaly").get() as { n: number }).n,
    };
    assert.deepEqual(after, before, "re-loading the fixture must not duplicate rows");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — fixture timestamps are computed relative to "now" at load time.
// ────────────────────────────────────────────────────────────────────

test("AC3: latest run is within the last hour and oldest run is ~30 days ago", () => {
  const { db, cleanup } = tempDb();
  try {
    loadDemoFixture(db);
    const row = db.prepare(
      "SELECT MAX(started_at) AS max_ts, MIN(started_at) AS min_ts FROM run",
    ).get() as { max_ts: string; min_ts: string };
    const nowMs = Date.now();
    const maxMs = new Date(row.max_ts).getTime();
    const minMs = new Date(row.min_ts).getTime();
    assert.ok(maxMs >= nowMs - 3600_000,
      `MAX(run.ts) must be within the last hour; got ${row.max_ts}`);
    assert.ok(minMs >= nowMs - (30 * 86400_000) - 60_000,
      `MIN(run.ts) must be ≥ now - 30d (with 60s slack); got ${row.min_ts}`);
    // Anomaly fired ~2h ago per the ticket.
    const anomTs = (db.prepare("SELECT MIN(created_at) AS ts FROM anomaly").get() as { ts: string }).ts;
    const anomAge = (nowMs - new Date(anomTs).getTime()) / 1000;
    assert.ok(anomAge < 12 * 3600 && anomAge > 60,
      `anomaly age should sit between ~1m and ~12h; got ${anomAge}s`);
    // Open PR's gh_created_at-equivalent (`fetched_at`) is ~4h ago.
    const prRow = db.prepare("SELECT MIN(fetched_at) AS ts FROM pr WHERE state='open'").get() as { ts: string };
    if (prRow.ts) {
      const prAge = (nowMs - new Date(prRow.ts).getTime()) / 1000;
      assert.ok(prAge < 12 * 3600,
        `open PR fetched_at should be recent (< 12h); got ${prAge}s`);
    }
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC1 + AC4 — startServer({demoMode}) serves /api/projects from the
// fixture; binds 127.0.0.1:7071 by default; loopback bypasses auth.
// ────────────────────────────────────────────────────────────────────

test("AC1: GET /api/fleet returns the three seeded demo projects", async () => {
  const b = await bootDemo();
  try {
    const r = await fetch(b.base + "/api/fleet");
    assert.equal(r.status, 200);
    const body = await r.json() as { projects: Array<{ slug: string }> };
    const slugs = body.projects.map((p) => p.slug).sort();
    assert.deepEqual(slugs, [...DEMO_PROJECT_SLUGS].sort());
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: DEMO_DEFAULT_PORT is 7071 (not the production 7070)", () => {
  assert.equal(DEMO_DEFAULT_PORT, 7071,
    "demo default port must be 7071 so it doesn't shadow a real serve");
});

test("AC4: GET /api/fleet over loopback requires no token in demo mode", async () => {
  const b = await bootDemo();
  try {
    // Loopback already bypasses auth in production; we assert the
    // posture is unchanged in demo mode — i.e. the route still answers
    // 200 with no x-fleet-token header.
    const r = await fetch(b.base + "/api/fleet");
    assert.equal(r.status, 200);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — demo mode fires zero shell-outs (no launchctl/gh/git).
// ────────────────────────────────────────────────────────────────────

test("AC5: demoMode boot fires zero launchctl/gh/git invocations", async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  // src/control.ts's runner returns a stdout string and is sync; the
  // test stub just records each invocation and yields empty output.
  _setRunnerForTests((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return "";
  });
  try {
    const b = await bootDemo();
    try {
      // Hit a few read endpoints to give any background tick a chance
      // to fire. demo mode MUST short-circuit them all.
      await fetch(b.base + "/api/fleet");
      await fetch(b.base + "/api/fleet/inbox");
      // Wait briefly in case a setInterval-style tick was wired.
      await new Promise((r) => setTimeout(r, 250));
    } finally { await b.close(); b.cleanup(); }
    const shelly = calls.filter((c) => /^(launchctl|gh|git)$/.test(c.cmd));
    assert.equal(shelly.length, 0,
      `demo mode must fire zero launchctl/gh/git calls; saw: ${JSON.stringify(shelly)}`);
  } finally { _resetRunnerForTests(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — the banner string is byte-exact.
// ────────────────────────────────────────────────────────────────────

test("AC7: DEMO_BANNER is the exact two-line fixture from the ticket", () => {
  const expected =
    "fleet-control demo - sandbox fleet at http://127.0.0.1:7071\n"
    + "Three seeded projects, ephemeral DB. Press Ctrl-C to tear down.\n";
  assert.equal(DEMO_BANNER, expected,
    "DEMO_BANNER must match the ticket's specified two-line banner byte-for-byte");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — fixture data carries no real GitHub URLs, no real homedir
// substrings, no token-shaped substrings.
// ────────────────────────────────────────────────────────────────────

test("AC8: rendered fleet payload contains no token-shaped or homedir substrings", async () => {
  const b = await bootDemo();
  try {
    const r = await fetch(b.base + "/api/fleet");
    const raw = await r.text();
    assert.equal(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/.test(raw), false,
      "fixture render must not contain a GitHub PAT-shaped substring");
    assert.equal(raw.includes(process.env.HOME ?? "__NEVER_MATCH__"), false,
      "fixture render must not leak the developer's HOME directory");
    // No real github.com URLs either — the fixture is repo-URL-free.
    assert.equal(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(raw), false,
      "fixture render must not include a real github.com repo URL");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC9 — determinism: two boots produce structurally-identical
// /api/fleet payloads (modulo timestamps).
// ────────────────────────────────────────────────────────────────────

function stripTimestamps(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripTimestamps);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      // Drop any field whose name looks date/time-ish OR whose value
      // is itself an ISO-8601 string. Both are recomputed per boot.
      if (/(_at|At|started|ended|ts|date|day|generatedAt)$/i.test(k)) continue;
      if (typeof val === "string" && /^\d{4}-\d{2}-\d{2}T/.test(val)) continue;
      out[k] = stripTimestamps(val);
    }
    return out;
  }
  return v;
}

test("AC9: two demo boots produce a structurally-identical /api/fleet payload", async () => {
  const b1 = await bootDemo();
  let s1: unknown;
  try {
    const r = await fetch(b1.base + "/api/fleet");
    s1 = stripTimestamps(await r.json());
  } finally { await b1.close(); b1.cleanup(); }

  const b2 = await bootDemo();
  let s2: unknown;
  try {
    const r = await fetch(b2.base + "/api/fleet");
    s2 = stripTimestamps(await r.json());
  } finally { await b2.close(); b2.cleanup(); }

  assert.deepEqual(s2, s1,
    "the structural shape of /api/fleet (minus timestamps) must be identical across boots");
});

// ────────────────────────────────────────────────────────────────────
// AC1 (subprocess) + AC6 (SIGINT teardown) + AC4 (refuses non-loopback)
// — end-to-end via spawn().
// ────────────────────────────────────────────────────────────────────

function spawnDemo(extraArgs: string[], env: Record<string, string> = {}): ReturnType<typeof spawn> {
  return spawn(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    join(REPO_ROOT, "bin", "fleetctl.ts"),
    "demo",
    ...extraArgs,
  ], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForBanner(child: ReturnType<typeof spawn>, maxMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; reject(new Error("demo banner not seen within " + maxMs + "ms; buf=" + buf)); }
    }, maxMs);
    child.stdout?.on("data", (chunk) => {
      buf += String(chunk);
      // Banner's first line carries "sandbox fleet at".
      if (!done && buf.includes("sandbox fleet at")) {
        done = true; clearTimeout(timer); resolve(buf);
      }
    });
    child.on("exit", () => {
      if (!done) { done = true; clearTimeout(timer); reject(new Error("demo exited before banner; buf=" + buf)); }
    });
  });
}

test("AC1+AC6: `fleetctl demo` boots, serves /api/fleet, SIGINT cleans up tmpdir", async () => {
  const port = await freePort();
  // Capture the tmpdir the child reports so we can assert it was
  // removed after SIGINT. The child prints "demo-tmp=<path>" to
  // stderr right before listening, which the CLI handler will
  // implement alongside the user-facing banner.
  const child = spawnDemo([`--port=${port}`]);
  let stderrBuf = "";
  child.stderr?.on("data", (c) => { stderrBuf += String(c); });
  let banner = "";
  try {
    banner = await waitForBanner(child);
    // Hit the API to prove the server is up and the fixture is loaded.
    const r = await fetch(`http://127.0.0.1:${port}/api/fleet`);
    assert.equal(r.status, 200);
    const body = await r.json() as { projects: Array<{ slug: string }> };
    assert.ok(body.projects.length >= 3, "demo must serve >=3 seeded projects");
  } finally {
    child.kill("SIGINT");
  }
  // Wait for the child to exit cleanly.
  const code: number = await new Promise((resolve) => {
    child.on("exit", (c) => resolve(c ?? -1));
  });
  assert.equal(code, 0, "demo must exit 0 on SIGINT; stderr=" + stderrBuf);
  assert.match(banner, /sandbox fleet at/, "banner should contain the sandbox phrase");
  // Extract the tmpdir from stderr (the CLI prints "demo-tmp=<path>" on
  // boot so the test — and a curious operator — can assert teardown).
  const m = stderrBuf.match(/demo-tmp=(\S+)/);
  assert.ok(m, "CLI must print demo-tmp=<path> to stderr before listening");
  const tmpPath = m![1];
  assert.equal(existsSync(tmpPath), false,
    `tmpdir ${tmpPath} must be removed on SIGINT teardown`);
});

test("AC4: `FLEET_HOST=0.0.0.0 fleetctl demo` refuses non-loopback bind", () => {
  const r = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    join(REPO_ROOT, "bin", "fleetctl.ts"),
    "demo",
  ], {
    env: { ...process.env, FLEET_HOST: "0.0.0.0" },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.notEqual(r.status, 0, "demo must exit non-zero when asked to bind non-loopback");
  assert.match(
    (r.stderr ?? "") + (r.stdout ?? ""),
    /demo mode refuses non-loopback binds/,
    "must print the exact refusal string to stderr",
  );
});

// ────────────────────────────────────────────────────────────────────
// AC10 — no new runtime deps (dependencies is empty); no shell-string
// composition in the demo subcommand.
// ────────────────────────────────────────────────────────────────────

test("AC10: package.json dependencies stays empty (zero-dep contract)", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    "ticket 0025 must not add a runtime dependency; saw: " + JSON.stringify(deps));
});

test("AC10: src/demo/fixture.ts does not import child_process (no shell-out)", () => {
  const txt = readFileSync(join(REPO_ROOT, "src", "demo", "fixture.ts"), "utf8");
  assert.equal(/from\s+["']node:child_process["']/.test(txt), false,
    "the fixture module must be pure SQL — no child_process import");
  assert.equal(/require\(["']node:child_process["']\)/.test(txt), false,
    "the fixture module must not require child_process either");
});
