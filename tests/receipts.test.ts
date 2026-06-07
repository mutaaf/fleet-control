// Tests for ticket 0041 — Fleet receipts (public monthly artifact).
//
// One test(...) per acceptance-criteria checkbox in
// docs/backlog/0041-fleet-receipts-public-monthly.md. Strategy mirrors
// the 0013 snapshot suite and the 0035 cost-per-pr suite:
//   - Drive `computeReceipts(db, slug, month, now)` directly against a
//     tmpdir DB for compute-path shape, schema persistence, and the
//     receiptsFor() reader's 404/200 distinction.
//   - Boot `startServer()` over loopback for the route + cache tests,
//     using the empty-roots config + tmp fleet-control.config.json
//     seam from LESSONS § "in-process startServer() tests need an
//     empty-roots config + run-row seeds".
//   - SPA renderer + CSS contract tests are text-level over web/app.js
//     + web/style.css per the inbox / glance / cost-per-pr precedent
//     (zero jsdom).
//   - CLI subprocess tests spawn `bin/fleetctl.ts receipts ...` with
//     FLEET_DB_PATH planted, per LESSONS § "CLI subprocess tests need
//     a FLEET_DB_PATH env seam".
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps
// from `new Date()`": every seed timestamp is anchored to the test's
// pinned NOW constant.
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// every row narrowing in the helpers under test uses the double-cast
// (exercised transitively by importing receiptsFor / computeReceipts —
// if the cast regresses tsc fails before this file runs).
//
// Per LESSONS § "groomer prose can disagree with the schema; the
// schema wins": the producer writes `pr.state='open'` lowercase for
// open PRs (src/ingest/prs.ts:164) and the existing views write
// `pr.state='MERGED'` upper-case for merged ones — these tests seed
// rows in the same casing the production ingester would produce.
//
// Zero new runtime deps; stdlib + node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync,
  unlinkSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { openDb, type DB } from "../src/db.ts";
import {
  computeReceipts, receiptsFor, type Receipts,
} from "../src/views.ts";
import {
  startServer,
  _resetReceiptsCacheForTests, _getReceiptsCacheBuildsForTests,
} from "../src/server.ts";
import { serveReceipts } from "../src/receipts.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const WEB_DIR = join(REPO_ROOT, "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

// Pinned wall-clock anchor for every seed. UTC noon mid-month so the
// date() buckets don't depend on the test-machine local TZ.
const NOW = new Date("2026-06-07T12:00:00.000Z");
// Target month for the receipts under test.
const MONTH = "2026-05";

function tempDb(): { db: DB; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-receipts-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, path, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
  ).run(slug, slug, "test", null);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

function seedRollup(db: DB, projectId: number, day: string, costUsd: number, phase = "ship"): void {
  db.prepare(
    "INSERT INTO cost_rollup_day(project_id, phase, day, runs, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd)"
    + " VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(projectId, phase, day, 1, 0, 0, 0, 0, costUsd);
}

/** Seed a `run` row so startServer's `runIngestPass`/`recomputeRollups`
 *  step (which DELETEs cost_rollup_day unconditionally and re-derives
 *  from `run`) preserves the same spend in the boot-path tests. Per
 *  LESSONS § "in-process startServer() tests need ... run-row seeds"
 *  this is the right shape for any test that drives a route that reads
 *  cost_rollup_day after a startServer boot. */
function seedRunForRollup(db: DB, opts: {
  projectId: number; startedAt: string; costUsd: number; phase?: string;
}): void {
  const sid = `s-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,outcome,cost_usd,cost_source)"
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(opts.projectId, opts.phase ?? "ship", sid, opts.startedAt, "shipped", opts.costUsd, "live");
}

function seedMergedPr(db: DB, opts: {
  projectId: number; number: number; fetchedAt: string;
}): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,additions,deletions,author,url,fetched_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, `pr-${opts.number}`, `feat/${opts.number}`,
    "MERGED", "green", null, 1, 0, 0, "a",
    `https://github.com/owner/x/pull/${opts.number}`, opts.fetchedAt,
  );
}

function seedFailingOpenPr(db: DB, opts: {
  projectId: number; number: number; fetchedAt: string;
}): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,additions,deletions,author,url,fetched_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, `pr-${opts.number}`, `feat/${opts.number}`,
    "open", "red", null, 1, 0, 0, "a",
    `https://github.com/owner/x/pull/${opts.number}`, opts.fetchedAt,
  );
}

// ────────────────────────────────────────────────────────────────────
// AC1 — schema: receipts_published table exists, is idempotent.
// ────────────────────────────────────────────────────────────────────

test("AC1: receipts_published table is created on fresh DB with the documented columns", () => {
  const { db, cleanup } = tempDb();
  try {
    // PRAGMA table_info returns one row per column with name + type.
    const cols = db.prepare("PRAGMA table_info(receipts_published)").all() as unknown as Array<{
      name: string; type: string;
    }>;
    const names = cols.map((c) => c.name).sort();
    assert.deepEqual(names, ["month_iso", "payload_json", "project_slug", "published_at"],
      "table must have project_slug, month_iso, published_at, payload_json columns");
    // INSERT round-trip works.
    db.prepare(
      "INSERT INTO receipts_published(project_slug, month_iso, published_at, payload_json) VALUES(?,?,?,?)",
    ).run("courtiq", "2026-05", NOW.toISOString(), JSON.stringify({ merged_prs: 47 }));
    const row = db.prepare(
      "SELECT project_slug, month_iso, payload_json FROM receipts_published WHERE project_slug=? AND month_iso=?",
    ).get("courtiq", "2026-05") as { project_slug: string; month_iso: string; payload_json: string };
    assert.equal(row.project_slug, "courtiq");
    assert.equal(row.month_iso, "2026-05");
    assert.equal(JSON.parse(row.payload_json).merged_prs, 47);
  } finally { cleanup(); }
});

test("AC1: opening a DB twice keeps receipts_published intact (CREATE TABLE IF NOT EXISTS is idempotent)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-receipts-idem-"));
  const path = join(dir, "fleet.db");
  try {
    const db1 = openDb(path);
    db1.prepare(
      "INSERT INTO receipts_published(project_slug, month_iso, published_at, payload_json) VALUES(?,?,?,?)",
    ).run("courtiq", "2026-05", NOW.toISOString(), "{}");
    db1.close();
    // Re-open — must not throw, must not wipe the row.
    const db2 = openDb(path);
    const n = (db2.prepare("SELECT COUNT(*) AS n FROM receipts_published").get() as { n: number }).n;
    assert.equal(n, 1, "re-opening DB must keep the existing receipts_published row");
    db2.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — receiptsFor(db, slug, month, now) reads frozen payload OR null.
// ────────────────────────────────────────────────────────────────────

test("AC2: receiptsFor returns the frozen payload when the row exists, null otherwise", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "courtiq");
    // Unpublished month → null.
    assert.equal(receiptsFor(db, "courtiq", "2026-05", NOW), null,
      "no published row → null (route translates to 404)");
    // Publish a frozen payload directly via the SQL path.
    const frozen = {
      found: true,
      project_slug: "courtiq",
      project_label: "courtiq",
      month_iso: "2026-05",
      month_label: "May 2026",
      merged_prs: 47,
      total_spend_usd: 8.42,
      cost_per_pr_usd: 0.18,
      red_days: 6,
      top_mover: null,
      generated_at: NOW.toISOString(),
    };
    db.prepare(
      "INSERT INTO receipts_published(project_slug, month_iso, published_at, payload_json) VALUES(?,?,?,?)",
    ).run("courtiq", "2026-05", NOW.toISOString(), JSON.stringify(frozen));
    const got = receiptsFor(db, "courtiq", "2026-05", NOW);
    assert.ok(got, "published row must resolve");
    assert.equal(got!.found, true);
    assert.equal(got!.merged_prs, 47, "must return the FROZEN payload, not a re-compute");
    assert.equal(got!.total_spend_usd, 8.42);
    assert.equal(got!.cost_per_pr_usd, 0.18);
    assert.equal(got!.red_days, 6);
  } finally { cleanup(); }
});

test("AC2: receiptsFor returns null after the published row is deleted", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "courtiq");
    db.prepare(
      "INSERT INTO receipts_published(project_slug, month_iso, published_at, payload_json) VALUES(?,?,?,?)",
    ).run("courtiq", "2026-05", NOW.toISOString(), JSON.stringify({ merged_prs: 1 }));
    assert.ok(receiptsFor(db, "courtiq", "2026-05", NOW));
    db.prepare("DELETE FROM receipts_published WHERE project_slug=? AND month_iso=?")
      .run("courtiq", "2026-05");
    assert.equal(receiptsFor(db, "courtiq", "2026-05", NOW), null,
      "post-delete read → null");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — computeReceipts walks cost_rollup_day + pr to derive the four
//       stats. Test asserts each stat to the exact value.
// ────────────────────────────────────────────────────────────────────

test("AC3: computeReceipts derives merged_prs, total_spend_usd, cost_per_pr_usd, red_days from cost_rollup_day + pr", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "courtiq");
    // Seed cost_rollup_day for May 2026: $1, $2, $3, $4 across four days.
    seedRollup(db, pid, "2026-05-05", 1.0, "ship");
    seedRollup(db, pid, "2026-05-10", 2.0, "ship");
    seedRollup(db, pid, "2026-05-15", 3.0, "ship");
    seedRollup(db, pid, "2026-05-20", 4.0, "ship");
    // Plus a June row that MUST NOT count.
    seedRollup(db, pid, "2026-06-01", 99.0, "ship");
    // Seed 5 MERGED PRs whose fetched_at falls inside May 2026.
    for (let n = 0; n < 5; n++) {
      seedMergedPr(db, {
        projectId: pid, number: 100 + n,
        fetchedAt: `2026-05-${String(5 + n).padStart(2, "0")}T12:00:00.000Z`,
      });
    }
    // Plus a June MERGED PR that MUST NOT count.
    seedMergedPr(db, {
      projectId: pid, number: 200, fetchedAt: "2026-06-01T12:00:00.000Z",
    });
    // Two failing open PRs on TWO distinct May days → red_days = 2.
    seedFailingOpenPr(db, {
      projectId: pid, number: 300, fetchedAt: "2026-05-08T09:00:00.000Z",
    });
    seedFailingOpenPr(db, {
      projectId: pid, number: 301, fetchedAt: "2026-05-25T09:00:00.000Z",
    });
    const r = computeReceipts(db, "courtiq", "2026-05", NOW);
    assert.equal(r.found, true);
    assert.equal(r.project_slug, "courtiq");
    assert.equal(r.month_iso, "2026-05");
    assert.equal(r.merged_prs, 5, "only PRs whose fetched_at falls inside May 2026 count");
    assert.equal(r.total_spend_usd, 10.0, "sum of $1+$2+$3+$4 in May, June excluded");
    assert.equal(r.cost_per_pr_usd, 10.0 / 5, "total_spend_usd / merged_prs");
    assert.equal(r.red_days, 2, "two distinct May days had at least one open red PR");
  } finally { cleanup(); }
});

test("AC3: computeReceipts returns cost_per_pr_usd=null when merged_prs===0", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "lonely");
    seedRollup(db, pid, "2026-05-10", 5.0, "ship");
    // No merged PRs in May.
    const r = computeReceipts(db, "lonely", "2026-05", NOW);
    assert.equal(r.merged_prs, 0);
    assert.equal(r.total_spend_usd, 5.0);
    assert.strictEqual(r.cost_per_pr_usd, null,
      "cost_per_pr_usd must be null (NOT Infinity / NaN / 0) when merged_prs=0");
  } finally { cleanup(); }
});

test("AC3: fleet-wide receipts pick top_mover by month-over-month delta in merged_prs", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "courtiq");
    const b = seedProject(db, "other");
    // courtiq: 5 merged in May, 2 in April → delta +3.
    for (let n = 0; n < 5; n++) {
      seedMergedPr(db, { projectId: a, number: 100 + n,
        fetchedAt: `2026-05-${String(5 + n).padStart(2, "0")}T12:00:00.000Z` });
    }
    for (let n = 0; n < 2; n++) {
      seedMergedPr(db, { projectId: a, number: 200 + n,
        fetchedAt: `2026-04-${String(5 + n).padStart(2, "0")}T12:00:00.000Z` });
    }
    // other: 1 merged in May, 0 in April → delta +1.
    seedMergedPr(db, { projectId: b, number: 300, fetchedAt: "2026-05-12T12:00:00.000Z" });
    // Some spend so the fleet rollup isn't trivial.
    seedRollup(db, a, "2026-05-10", 4.0, "ship");
    seedRollup(db, b, "2026-05-12", 2.0, "ship");
    const r = computeReceipts(db, "fleet", "2026-05", NOW);
    assert.equal(r.merged_prs, 6, "fleet-wide aggregate: 5+1");
    assert.equal(r.total_spend_usd, 6.0, "fleet-wide aggregate: $4+$2");
    assert.ok(r.top_mover, "fleet receipts surface a top_mover");
    assert.equal(r.top_mover!.slug, "courtiq", "biggest delta wins");
    assert.equal(r.top_mover!.delta_prs, 3);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — POST /api/receipts/publish requires admin, validates input,
//       returns published_url + frozen payload, persists the row.
// ────────────────────────────────────────────────────────────────────

interface Booted {
  base: string;
  close: () => Promise<void>;
  cleanup: () => void;
  dbPath: string;
}

let activeBoots = 0;
let savedConfigText: string | null = null;
const CONFIG_PATH = join(process.cwd(), "fleet-control.config.json");

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

async function boot(seed?: (db: DB) => void): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-receipts-boot-"));
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
  if (seed) {
    const db = openDb(dbPath);
    try { seed(db); } finally { db.close(); }
  }
  const port = await freePort();
  const server = startServer("127.0.0.1", port, { quietBanner: true });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + "/api/whoami"); if (r.ok) break; } catch { /* not up */ }
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
          try { unlinkSync(CONFIG_PATH); } catch { /* gone */ }
        } else {
          writeFileSync(CONFIG_PATH, savedConfigText);
        }
        savedConfigText = null;
      }
      rmSync(dir, { recursive: true, force: true });
    },
    dbPath,
  };
}

test("AC4: POST /api/receipts/publish — loopback 200 returns published_url + payload, persists row", async () => {
  _resetReceiptsCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "courtiq");
    // Seed via `run` rows (LESSONS § "in-process startServer() tests
    // need ... run-row seeds") so the boot-time recomputeRollups()
    // re-derives the same spend the test asserts on the publish
    // payload.
    seedRunForRollup(db, { projectId: pid, startedAt: "2026-05-10T12:00:00.000Z", costUsd: 4.0 });
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-05-11T12:00:00.000Z" });
    seedMergedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-05-12T12:00:00.000Z" });
  });
  try {
    const r = await fetch(b.base + "/api/receipts/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_slug: "courtiq", month_iso: "2026-05" }),
    });
    assert.equal(r.status, 200, "loopback publish must succeed");
    const j = await r.json() as { published_url: string; payload: { merged_prs: number; total_spend_usd: number } };
    assert.match(j.published_url, /\/receipts\/courtiq\/2026-05$/,
      "published_url must end with /receipts/<slug>/<month>");
    assert.equal(j.payload.merged_prs, 2);
    assert.equal(j.payload.total_spend_usd, 4);
    // Row persisted.
    const db = openDb(b.dbPath);
    try {
      const row = db.prepare(
        "SELECT payload_json FROM receipts_published WHERE project_slug=? AND month_iso=?",
      ).get("courtiq", "2026-05") as { payload_json: string } | undefined;
      assert.ok(row, "row must persist on publish");
      const parsed = JSON.parse(row!.payload_json) as { merged_prs: number };
      assert.equal(parsed.merged_prs, 2, "frozen payload carries the compute result");
    } finally { db.close(); }
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: POST /api/receipts/publish rejects unknown slug with 400; malformed month_iso with 400", async () => {
  _resetReceiptsCacheForTests();
  const b = await boot((db) => { seedProject(db, "courtiq"); });
  try {
    const bad1 = await fetch(b.base + "/api/receipts/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_slug: "does-not-exist", month_iso: "2026-05" }),
    });
    assert.equal(bad1.status, 400, "unknown slug → 400");
    const bad2 = await fetch(b.base + "/api/receipts/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_slug: "courtiq", month_iso: "may-2026" }),
    });
    assert.equal(bad2.status, 400, "malformed month_iso → 400");
    // 'fleet' is always accepted as a slug per AC2.
    const ok = await fetch(b.base + "/api/receipts/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_slug: "fleet", month_iso: "2026-05" }),
    });
    assert.equal(ok.status, 200, "literal 'fleet' slug must publish");
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: POST /api/receipts/publish from non-loopback without admin token → 403/401", async () => {
  // Auth is enforced at requireAuth; same shape as the cost-per-pr
  // 401 test — drive requireAuth directly with a fake remote req.
  const { requireAuth } = await import("../src/server.ts");
  const { db, cleanup } = tempDb();
  try {
    const fakeReq = { socket: { remoteAddress: "10.0.0.5" }, headers: {} };
    const r = requireAuth(db, fakeReq as any, "admin");
    assert.equal(r.ok, false);
    assert.ok(r.status === 401 || r.status === 403,
      "remote no-token publish must be 401/403; got " + r.status);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — POST /api/receipts/unpublish requires admin, deletes the row,
//       idempotent on a missing row.
// ────────────────────────────────────────────────────────────────────

test("AC5: POST /api/receipts/unpublish removes the row; subsequent GET → 404; idempotent on missing row", async () => {
  _resetReceiptsCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "courtiq");
    seedRunForRollup(db, { projectId: pid, startedAt: "2026-05-10T12:00:00.000Z", costUsd: 1.0 });
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-05-11T12:00:00.000Z" });
  });
  try {
    // Publish first.
    const pub = await fetch(b.base + "/api/receipts/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_slug: "courtiq", month_iso: "2026-05" }),
    });
    assert.equal(pub.status, 200);
    // Unpublish.
    const un = await fetch(b.base + "/api/receipts/unpublish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_slug: "courtiq", month_iso: "2026-05" }),
    });
    assert.equal(un.status, 200);
    const unBody = await un.json() as { ok: boolean };
    assert.equal(unBody.ok, true);
    // Now the public URL must 404.
    const ghost = await fetch(b.base + "/receipts/courtiq/2026-05");
    assert.equal(ghost.status, 404, "post-unpublish GET → 404");
    // Idempotent: unpublishing an absent row returns 200 ok:true.
    const again = await fetch(b.base + "/api/receipts/unpublish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_slug: "courtiq", month_iso: "2026-05" }),
    });
    assert.equal(again.status, 200, "idempotent unpublish on missing row → 200");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — GET /receipts/<slug>/<YYYY-MM> is unauthenticated, returns
//       200 text/html with the four stats and no leaks, 404 when absent.
// ────────────────────────────────────────────────────────────────────

test("AC6: GET /receipts/<slug>/<YYYY-MM> returns 200 text/html with the four stats and no leaks", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "courtiq");
    // Publish a frozen payload directly.
    const frozen = {
      found: true,
      project_slug: "courtiq",
      project_label: "courtiq",
      month_iso: "2026-05",
      month_label: "May 2026",
      merged_prs: 47,
      total_spend_usd: 8.42,
      cost_per_pr_usd: 0.18,
      red_days: 6,
      top_mover: null,
      generated_at: NOW.toISOString(),
    };
    db.prepare(
      "INSERT INTO receipts_published(project_slug, month_iso, published_at, payload_json) VALUES(?,?,?,?)",
    ).run("courtiq", "2026-05", NOW.toISOString(), JSON.stringify(frozen));

    const result = serveReceipts(db, "courtiq", "2026-05");
    assert.equal(result.status, 200);
    assert.match(result.headers["content-type"] ?? "", /text\/html/);
    const body = result.body;
    // Four stats present.
    assert.ok(body.includes("47"), "merged_prs surface");
    assert.ok(body.includes("8.42"), "total_spend_usd surface");
    assert.ok(body.includes("0.18"), "cost_per_pr_usd surface");
    assert.ok(body.includes("6"), "red_days surface");
    // Month + project label visible.
    assert.ok(body.includes("May 2026"), "month label rendered");
    assert.ok(body.toLowerCase().includes("courtiq"), "project label rendered");
    // No script, no /api/, no admin token leak.
    assert.equal(/<script\b/i.test(body), false, "no <script> tag");
    assert.equal(body.includes("/api/control/"), false, "no /api/control/ string");
    assert.equal(body.includes("/api/"), false, "no /api/ fetches");
    // Footer github anchor is the fleet-control project, never the operator's repo.
    const ghAnchors = body.match(/href=["'][^"']*github\.com\/[^"']+["']/gi) ?? [];
    for (const a of ghAnchors) {
      assert.match(a, /mutaaf\/fleet-control/, "only allowed github anchor is fleet-control footer; got: " + a);
    }
  } finally { cleanup(); }
});

test("AC6: GET /receipts/<slug>/<YYYY-MM> returns 404 when no row exists", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "courtiq");
    const result = serveReceipts(db, "courtiq", "2026-05");
    assert.equal(result.status, 404, "unpublished month → 404");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Caching: Cache-Control: max-age=600 + memoised by (slug,
//       month_iso); unpublish invalidates the cache key.
// ────────────────────────────────────────────────────────────────────

test("AC7: GET /receipts/<slug>/<YYYY-MM> sets cache-control max-age=600 and the build counter ticks once per cache miss", async () => {
  _resetReceiptsCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "courtiq");
    seedRunForRollup(db, { projectId: pid, startedAt: "2026-05-10T12:00:00.000Z", costUsd: 1.0 });
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-05-11T12:00:00.000Z" });
  });
  try {
    // Publish so the row exists.
    await fetch(b.base + "/api/receipts/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_slug: "courtiq", month_iso: "2026-05" }),
    });
    const before = _getReceiptsCacheBuildsForTests();
    const r1 = await fetch(b.base + "/receipts/courtiq/2026-05");
    assert.equal(r1.status, 200);
    const cc = (r1.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=600/, `cache-control must declare max-age=600; got '${cc}'`);
    await r1.text();
    const afterFirst = _getReceiptsCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call → cache MISS, build counter += 1");
    const r2 = await fetch(b.base + "/receipts/courtiq/2026-05");
    assert.equal(r2.status, 200);
    await r2.text();
    const afterSecond = _getReceiptsCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0,
      "second call within the window → cache HIT, counter unchanged");
    // Unpublish must invalidate the cache key.
    const un = await fetch(b.base + "/api/receipts/unpublish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_slug: "courtiq", month_iso: "2026-05" }),
    });
    assert.equal(un.status, 200);
    const afterUn = _getReceiptsCacheBuildsForTests();
    // After unpublish the next fetch returns 404 (cache invalidated, fresh
    // SQL miss). The counter must NOT increment because no successful
    // render happened — the cache stays in "no row" state.
    const r3 = await fetch(b.base + "/receipts/courtiq/2026-05");
    assert.equal(r3.status, 404, "post-unpublish fetch must 404 (cache key invalidated)");
    await r3.text();
    const afterThird = _getReceiptsCacheBuildsForTests();
    assert.equal(afterThird - afterUn, 0,
      "unpublish must NOT increment the build counter (cache invalidated, not rebuilt)");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Portal publish UI: web/app.js exposes the publish button +
//       modal that POSTs to /api/receipts/publish.
// ────────────────────────────────────────────────────────────────────

test("AC8: web/app.js declares renderReceiptsButton + a publish modal that POSTs to /api/receipts/publish", () => {
  assert.match(APP_JS, /renderReceiptsButton|receipts-publish-btn/,
    "web/app.js must declare a receipts publish button helper");
  assert.match(APP_JS, /\/api\/receipts\/publish/,
    "web/app.js must POST to /api/receipts/publish");
  assert.match(APP_JS, /\/api\/receipts\/unpublish/,
    "web/app.js must POST to /api/receipts/unpublish on the unpublish path");
  // The preview modal uses a sandboxed iframe to render the public URL.
  assert.match(APP_JS, /sandbox=["']allow-same-origin["']/,
    "publish modal must preview the public URL via a sandboxed iframe");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — fleetctl receipts subcommand: publish | unpublish | list.
// ────────────────────────────────────────────────────────────────────

function runCli(args: string[], env: Record<string, string>): {
  code: number; stdout: string; stderr: string;
} {
  const r = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    join(REPO_ROOT, "bin", "fleetctl.ts"),
    ...args,
  ], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

test("AC9: fleetctl receipts publish/list/unpublish (offline path via FLEET_DB_PATH)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-receipts-cli-"));
  const dbPath = join(dir, "fleet.db");
  try {
    // Seed the project so the publish validates.
    const seed = openDb(dbPath);
    try {
      seed.prepare("INSERT INTO project(slug,name,namespace) VALUES(?,?,?)")
        .run("courtiq", "Courtiq", "com.courtiq");
      seed.prepare(
        "INSERT INTO cost_rollup_day(project_id,phase,day,runs,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd)"
        + " VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(1, "ship", "2026-05-10", 1, 0, 0, 0, 0, 1.0);
      seed.prepare(
        "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,additions,deletions,author,url,fetched_at)"
        + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(1, 1, "t", "b", "MERGED", "green", null, 1, 0, 0, "a", "u", "2026-05-11T12:00:00.000Z");
    } finally { seed.close(); }

    const pub = runCli(["receipts", "publish", "courtiq", "2026-05"], {
      HOME: dir, FLEET_DB_PATH: dbPath,
    });
    assert.equal(pub.code, 0, "publish must exit 0: stdout=" + pub.stdout + " stderr=" + pub.stderr);
    assert.match(pub.stdout, /\/receipts\/courtiq\/2026-05/,
      "publish must print the public URL");

    const list = runCli(["receipts", "list"], {
      HOME: dir, FLEET_DB_PATH: dbPath,
    });
    assert.equal(list.code, 0, "list must exit 0");
    assert.match(list.stdout, /courtiq/, "list must surface the published slug");
    assert.match(list.stdout, /2026-05/, "list must surface the published month");

    const un = runCli(["receipts", "unpublish", "courtiq", "2026-05"], {
      HOME: dir, FLEET_DB_PATH: dbPath,
    });
    assert.equal(un.code, 0, "unpublish must exit 0");

    const list2 = runCli(["receipts", "list"], {
      HOME: dir, FLEET_DB_PATH: dbPath,
    });
    assert.equal(list2.code, 0);
    assert.doesNotMatch(list2.stdout, /courtiq.*2026-05|2026-05.*courtiq/,
      "list after unpublish must NOT name the removed row");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Mobile: 375px single column; >=600px 2x2 grid; minimum 36px
//        headline.
// ────────────────────────────────────────────────────────────────────

test("AC10: style.css declares .receipts layout, mobile single-column + >=600px 2x2 grid + headline >= 36px", () => {
  assert.match(CSS, /\.receipts(-page|-stats|-stat|-headline)?\b/,
    "style.css must define receipts selectors");
  // A min-width: 600px breakpoint that touches a receipts selector.
  const desktop = CSS.match(/@media[^{]*min-width:\s*600px[\s\S]*?receipts[\s\S]*?\}\s*\}/);
  assert.ok(desktop, "style.css must define a >=600px breakpoint that upgrades the receipts layout");
  // Headline font-size >= 36px somewhere in the receipts selector group.
  const headlineRule = CSS.match(/\.receipts-(headline|stat-value|big)[^{]*\{[\s\S]*?font-size:\s*(\d+)px/);
  assert.ok(headlineRule, "receipts headline rule must declare a font-size");
  assert.ok(Number(headlineRule![2]) >= 36, "headline font-size must be >= 36px; got " + headlineRule![2]);
});

// ────────────────────────────────────────────────────────────────────
// AC11 — Quiet-hours integration: publish doesn't check quiet hours;
//        the public page never surfaces quiet-hours-gated alert text.
// ────────────────────────────────────────────────────────────────────

test("AC11: publish + serveReceipts behave identically regardless of quiet hours (pull surface, not push)", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "courtiq");
    // Whether quiet hours are active or not, the publish path writes
    // the row and the serve path returns the same HTML. We assert via
    // grep on the receipts source — there must be no quietHours branch
    // in serveReceipts or computeReceipts.
    const receiptsSrc = readFileSync(join(REPO_ROOT, "src", "receipts.ts"), "utf8");
    assert.doesNotMatch(receiptsSrc, /quietHours|quiet_hours|quietHoursActive/,
      "receipts module must not branch on quiet hours (publish is operator-initiated)");
    // serveReceipts on a published row never references any alert text.
    db.prepare(
      "INSERT INTO receipts_published(project_slug, month_iso, published_at, payload_json) VALUES(?,?,?,?)",
    ).run("courtiq", "2026-05", NOW.toISOString(), JSON.stringify({
      found: true, project_slug: "courtiq", project_label: "courtiq",
      month_iso: "2026-05", month_label: "May 2026",
      merged_prs: 1, total_spend_usd: 1, cost_per_pr_usd: 1, red_days: 0,
      top_mover: null, generated_at: NOW.toISOString(),
    }));
    const r = serveReceipts(db, "courtiq", "2026-05");
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.body, /quiet hours/i,
      "public receipts page must not surface quiet-hours alert text");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC12 — No new runtime deps; no JSON-shape break; admin token never
//        appears in receipts payloads or HTML.
// ────────────────────────────────────────────────────────────────────

test("AC12: package.json dependencies stays empty (zero runtime deps)", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    "package.json `dependencies` must remain empty (Hard NO in AGENTS.md)");
});

test("AC12: receipts source uses argv-array execFile shape (no shell strings)", () => {
  const receiptsSrc = readFileSync(join(REPO_ROOT, "src", "receipts.ts"), "utf8");
  // The receipts module composes SQL + HTML — there is no shell-out.
  // If a future regression introduces one, it MUST use execFile with an
  // argv array, never a shell string. This grep asserts the negative.
  assert.doesNotMatch(receiptsSrc, /\bexec\(\s*["'`]/,
    "receipts module must not use exec() with a shell string");
  assert.doesNotMatch(receiptsSrc, /\bspawn\(\s*["'`][^"'`]*\s+[^"'`]*["'`]/,
    "receipts module must not compose a shell string into spawn()");
});

// Touch the Receipts type so an unused-import lint stays quiet.
const _typecheck: Receipts | null = null;
void _typecheck;
