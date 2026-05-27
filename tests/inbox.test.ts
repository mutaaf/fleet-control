// Tests for today's inbox (ticket 0017). One test per AC checkbox.
//
// Strategy: drive the helper directly (fleetInbox / dismissInboxItem)
// against a tmpdir DB for AC1/AC2/AC4/AC5/AC8, and boot the real
// startServer() over loopback for the route-level AC3 (auth + 200
// shape). The SPA AC6 + mobile AC7 are text-level checks against
// web/app.js + web/style.css, matching the mobile-portal.test.ts
// pattern (zero new deps, no jsdom).
//
// Each `test(...)` carries the AC reference in its name so a failure
// points straight at the spec line that broke.
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
import { createHash, randomBytes } from "node:crypto";
import { openDb, type DB } from "../src/db.ts";
import { fleetInbox, dismissInboxItem } from "../src/inbox.ts";
import { startServer, requireAuth } from "../src/server.ts";
import { mintToken, revokeToken } from "../src/auth.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-inbox-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string, name?: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace) VALUES (?,?,?)",
  ).run(slug, name ?? slug, "test");
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

interface PrSeed {
  projectId: number; number: number; title: string; url?: string;
  fetchedAt: string; isAgent?: number;
}
function seedPr(db: DB, p: PrSeed): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,additions,deletions,author,url,fetched_at) "
    + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    p.projectId, p.number, p.title, `feat/${p.number}-x`,
    "open", "green", "clean", p.isAgent ?? 1,
    1, 0, "agent", p.url ?? null, p.fetchedAt,
  );
}

interface RunSeed {
  projectId: number; phase: string; sessionId: string; startedAt: string;
  outcome: string; prNumber?: number | null;
}
function seedRun(db: DB, r: RunSeed): number {
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,outcome,pr_number,cost_source) "
    + "VALUES(?,?,?,?,?,?,?)",
  ).run(r.projectId, r.phase, r.sessionId, r.startedAt, r.outcome, r.prNumber ?? null, "live");
  return Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

interface AnomalySeed {
  runId: number; kind: string; createdAt: string; value: number;
  baselineMean: number; baselineStddev: number; sampleCount: number;
  candidateReason?: string;
}
function seedAnomaly(db: DB, a: AnomalySeed): number {
  db.prepare(
    "INSERT INTO anomaly(run_id,kind,value,baseline_mean,baseline_stddev,sample_count,candidate_reason,created_at) "
    + "VALUES(?,?,?,?,?,?,?,?)",
  ).run(a.runId, a.kind, a.value, a.baselineMean, a.baselineStddev,
        a.sampleCount, a.candidateReason ?? null, a.createdAt);
  return Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

interface SnapshotSeed {
  id: string; name: string; createdAt: string; expiresAt: string;
  revokedAt?: string | null;
}
function seedSnapshot(db: DB, s: SnapshotSeed): void {
  db.prepare(
    "INSERT INTO snapshot(id,name,created_at,expires_at,revoked_at,payload_json) "
    + "VALUES(?,?,?,?,?,?)",
  ).run(s.id, s.name, s.createdAt, s.expiresAt, s.revokedAt ?? null, "{}");
}

/** Build a deterministic fixture that exercises all four inbox kinds.
 *  Returns the helper handles tests use to assert shape + ordering. */
function seedAllKinds(db: DB, now: Date): {
  prSlug: string; prNumber: number;
  anomalySlug: string; anomalyId: number;
  snapshotIdPrefix: string;
  runFailedSlug: string; runFailedId: number;
} {
  const tMinus = (mins: number) => new Date(now.getTime() - mins * 60_000).toISOString();
  const tPlus = (mins: number) => new Date(now.getTime() + mins * 60_000).toISOString();

  // PR review — fetched 3h ago (oldest of our four items).
  const prPid = seedProject(db, "alpha", "Alpha");
  seedPr(db, {
    projectId: prPid, number: 42, title: "feat/0099 example",
    url: "https://github.com/owner/alpha/pull/42",
    fetchedAt: tMinus(180),
  });

  // Anomaly open — created 1h ago.
  const anomPid = seedProject(db, "beta", "Beta");
  const runForAnom = seedRun(db, {
    projectId: anomPid, phase: "ship", sessionId: "sess-anom",
    startedAt: tMinus(60), outcome: "shipped",
  });
  const anomalyId = seedAnomaly(db, {
    runId: runForAnom, kind: "duration", createdAt: tMinus(60),
    value: 60_000, baselineMean: 10_000, baselineStddev: 2_000,
    sampleCount: 14, candidateReason: "repeated tool errors",
  });

  // Snapshot expiring — created 24h ago, expires in 2h. snapshot.id is
  // a 64-char SHA-256 hex; we hash a known token so we control the prefix.
  const tokenHex = "a".repeat(48);
  const id = createHash("sha256").update(tokenHex).digest("hex");
  seedSnapshot(db, {
    id, name: "demo",
    createdAt: tMinus(60 * 24),
    expiresAt: tPlus(120),
  });

  // Run failed — most recent run for project gamma is a failure with
  // no later success. Started 30m ago.
  const failPid = seedProject(db, "gamma", "Gamma");
  // Add an older successful run so we exercise the "MAX(failed run)"
  // filter without it accidentally suppressing the failure.
  seedRun(db, {
    projectId: failPid, phase: "ship", sessionId: "sess-ok",
    startedAt: tMinus(60 * 6), outcome: "shipped",
  });
  const runFailedId = seedRun(db, {
    projectId: failPid, phase: "ship", sessionId: "sess-fail",
    startedAt: tMinus(30), outcome: "failure",
  });

  return {
    prSlug: "alpha", prNumber: 42,
    anomalySlug: "beta", anomalyId,
    snapshotIdPrefix: id.slice(0, 8),
    runFailedSlug: "gamma", runFailedId,
  };
}

// ────────────────────────────────────────────────────────────────────
// AC1 — fleetInbox(db) shape + four kinds + ordering by age desc
// ────────────────────────────────────────────────────────────────────

test("AC1: fleetInbox returns the four kinds with correct shape, sorted by age_seconds DESC (oldest first)", () => {
  const { db, cleanup } = tempDb();
  try {
    const now = new Date("2026-05-27T12:00:00.000Z");
    const seeds = seedAllKinds(db, now);

    const r = fleetInbox(db, { now: now.toISOString() });
    assert.equal(typeof r.generated_at, "string");
    assert.equal(r.generated_at, now.toISOString());
    assert.ok(Array.isArray(r.items));
    assert.equal(r.items.length, 4, "must surface all four kinds");

    // Every item carries the required shape.
    for (const it of r.items) {
      assert.ok(["pr_review", "anomaly_open", "snapshot_expiring", "run_failed"].includes(it.kind),
        "unknown kind: " + it.kind);
      assert.equal(typeof it.project_slug, "string");
      assert.equal(typeof it.title, "string");
      assert.equal(typeof it.age_seconds, "number");
      assert.ok(it.action && typeof it.action.label === "string" && typeof it.action.route === "string",
        "action {label,route} required");
      assert.ok(it.payload && typeof it.payload.id === "string",
        "payload.id required for dedup + dismissal");
    }

    // Ordering: oldest first (snapshot 24h > PR 3h > anomaly 1h > run 30m).
    const kinds = r.items.map((it) => it.kind);
    assert.deepEqual(
      kinds,
      ["snapshot_expiring", "pr_review", "anomaly_open", "run_failed"],
      `unexpected ordering: ${JSON.stringify(kinds)}`,
    );

    // Spot-check payload ids — these are the dedup keys.
    const pr = r.items.find((it) => it.kind === "pr_review")!;
    assert.equal(pr.payload.id, String(seeds.prNumber));
    const ano = r.items.find((it) => it.kind === "anomaly_open")!;
    assert.equal(ano.payload.id, String(seeds.anomalyId));
    const snap = r.items.find((it) => it.kind === "snapshot_expiring")!;
    assert.equal(snap.payload.id, seeds.snapshotIdPrefix);
    const rf = r.items.find((it) => it.kind === "run_failed")!;
    assert.equal(rf.payload.id, String(seeds.runFailedId));
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — idempotent: two consecutive calls with no DB change return equal
// item arrays (same dedup keys, same ordering).
// ────────────────────────────────────────────────────────────────────

test("AC2: refreshing the inbox twice returns identical items (dedup by kind+slug+payload.id)", () => {
  const { db, cleanup } = tempDb();
  try {
    const now = new Date("2026-05-27T12:00:00.000Z");
    seedAllKinds(db, now);
    const a = fleetInbox(db, { now: now.toISOString() });
    const b = fleetInbox(db, { now: now.toISOString() });
    const keyOf = (it: { kind: string; project_slug: string; payload: { id: string } }) =>
      `${it.kind} ${it.project_slug} ${it.payload.id}`;
    assert.deepEqual(a.items.map(keyOf), b.items.map(keyOf),
      "same dedup keys + ordering across consecutive calls");
    // age_seconds should also match — same pinned `now`.
    assert.deepEqual(
      a.items.map((it) => it.age_seconds),
      b.items.map((it) => it.age_seconds),
    );
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — GET /api/fleet/inbox returns the shape; requires read scope.
// ────────────────────────────────────────────────────────────────────

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

interface Booted {
  base: string;
  close: () => Promise<void>;
  cleanup: () => void;
  dbPath: string;
}

async function boot(seed?: (db: DB) => void): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-inbox-route-"));
  const dbPath = join(dir, "fleet.db");
  // Snapshot any pre-existing fleet-control.config.json and plant a
  // minimal one pointing at empty roots so startServer's synchronous
  // runIngestPass doesn't walk the operator's real filesystem
  // (LESSONS § "in-process startServer() tests need an empty-roots
  // config + run-row seeds").
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
  const server = startServer("127.0.0.1", port);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base + "/api/whoami");
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((rs) => setTimeout(rs, 20));
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
    dbPath,
  };
}

test("AC3: GET /api/fleet/inbox is gated by read scope, and returns the documented shape", async () => {
  // The route handler is gated by the same `requireAuth(db, req,
  // "read")` chokepoint every other GET /api/* route uses. We test
  // the scope gate directly with synthetic req objects (the
  // auth-server.test.ts pattern) — that's the chokepoint that fires
  // for /api/fleet/inbox just as it does for /api/fleet — and we
  // test the route end-to-end over loopback for the 200 shape.
  const b = await boot((db) => {
    // Seed an inbox-worthy fixture: one PR review row, fetched 30 min ago.
    const now = new Date();
    const t = (mins: number) => new Date(now.getTime() - mins * 60_000).toISOString();
    const pid = seedProject(db, "demo", "Demo");
    seedPr(db, { projectId: pid, number: 7, title: "feat/0007 inline diff",
      url: "https://github.com/owner/demo/pull/7", fetchedAt: t(30) });
  });
  try {
    // ── Scope-gate proof ───────────────────────────────────────
    // requireAuth is the chokepoint; the /api/fleet/inbox handler
    // calls it with required="read". A synthetic non-loopback req
    // with no token must be 401.
    const dbOpen = openDb(b.dbPath);
    try {
      const nope = requireAuth(dbOpen, {
        socket: { remoteAddress: "10.0.0.5" }, headers: {},
      } as any, "read");
      assert.equal(nope.ok, false);
      assert.equal(nope.status, 401, "no-token remote must be 401");

      // A revoked token also 401s — proves the chokepoint is live
      // (and not a hard-coded pass-through).
      const minted = mintToken(dbOpen, "phone", "read");
      revokeToken(dbOpen, minted.id_prefix);
      const revoked = requireAuth(dbOpen, {
        socket: { remoteAddress: "10.0.0.5" },
        headers: { "x-fleet-token": minted.token },
      } as any, "read");
      assert.equal(revoked.ok, false);
      assert.equal(revoked.status, 401);
    } finally { dbOpen.close(); }

    // ── 200 shape on the live route over loopback ─────────────
    const rOk = await fetch(b.base + "/api/fleet/inbox");
    assert.equal(rOk.status, 200);
    const body = await rOk.json() as { items: unknown[]; generated_at: string };
    assert.equal(typeof body.generated_at, "string");
    assert.ok(Array.isArray(body.items));
    assert.equal(body.items.length, 1, "the seeded PR row should surface");
    const item = body.items[0] as { kind: string; project_slug: string; payload: { id: string } };
    assert.equal(item.kind, "pr_review");
    assert.equal(item.project_slug, "demo");
    assert.equal(item.payload.id, "7");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — POST /api/fleet/inbox/dismiss for each kind; next inbox omits it.
// ────────────────────────────────────────────────────────────────────

test("AC4: dismissing each kind removes it from the next fleetInbox call", () => {
  const { db, cleanup } = tempDb();
  try {
    const now = new Date("2026-05-27T12:00:00.000Z");
    const seeds = seedAllKinds(db, now);
    const before = fleetInbox(db, { now: now.toISOString() });
    assert.equal(before.items.length, 4);

    // Dismiss the PR.
    let r = dismissInboxItem(db, {
      kind: "pr_review", project_slug: seeds.prSlug, payload_id: String(seeds.prNumber),
    });
    assert.equal(r.ok, true);
    // Dismiss the anomaly — this should also stamp anomaly.dismissed_at.
    r = dismissInboxItem(db, {
      kind: "anomaly_open", project_slug: seeds.anomalySlug, payload_id: String(seeds.anomalyId),
    });
    assert.equal(r.ok, true);
    const stamp = (db.prepare(
      "SELECT dismissed_at FROM anomaly WHERE id=?",
    ).get(seeds.anomalyId) as { dismissed_at: string | null });
    assert.ok(stamp.dismissed_at, "anomaly.dismissed_at must be stamped by the dismissal");

    // Dismiss the snapshot (synthetic project_slug "fleet").
    r = dismissInboxItem(db, {
      kind: "snapshot_expiring", project_slug: "fleet", payload_id: seeds.snapshotIdPrefix,
    });
    assert.equal(r.ok, true);
    // Dismiss the failed run.
    r = dismissInboxItem(db, {
      kind: "run_failed", project_slug: seeds.runFailedSlug, payload_id: String(seeds.runFailedId),
    });
    assert.equal(r.ok, true);

    const after = fleetInbox(db, { now: now.toISOString() });
    assert.equal(after.items.length, 0, "every dismissed kind must drop out of the next inbox");

    // Idempotency: dismissing the same item again is a silent no-op.
    const again = dismissInboxItem(db, {
      kind: "pr_review", project_slug: seeds.prSlug, payload_id: String(seeds.prNumber),
    });
    assert.equal(again.ok, true, "second dismissal is a silent no-op");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — schema migration: inbox_dismissal round-trip
// ────────────────────────────────────────────────────────────────────

test("AC5: inbox_dismissal table accepts an insert + select round-trip", () => {
  const { db, cleanup } = tempDb();
  try {
    const dismissedAt = new Date().toISOString();
    db.prepare(
      "INSERT INTO inbox_dismissal(kind, project_slug, payload_id, dismissed_at) "
      + "VALUES(?,?,?,?)",
    ).run("pr_review", "alpha", "42", dismissedAt);
    const row = db.prepare(
      "SELECT kind, project_slug, payload_id, dismissed_at FROM inbox_dismissal "
      + "WHERE kind=? AND project_slug=? AND payload_id=?",
    ).get("pr_review", "alpha", "42") as {
      kind: string; project_slug: string; payload_id: string; dismissed_at: string;
    };
    assert.equal(row.kind, "pr_review");
    assert.equal(row.project_slug, "alpha");
    assert.equal(row.payload_id, "42");
    assert.equal(row.dismissed_at, dismissedAt);
    // PK enforces idempotency — second insert with same triple must fail
    // (the helper uses ON CONFLICT DO NOTHING; the raw insert here
    // should raise so we know the constraint is real).
    assert.throws(() => db.prepare(
      "INSERT INTO inbox_dismissal(kind, project_slug, payload_id, dismissed_at) VALUES(?,?,?,?)",
    ).run("pr_review", "alpha", "42", dismissedAt));
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — web/app.js renders an Inbox section above the project grid;
// empty state copy is "Inbox zero — fleet's healthy."
// Text-level checks (no jsdom) — same approach as mobile-portal.test.ts.
// ────────────────────────────────────────────────────────────────────

test("AC6: web/app.js wires the inbox above the project grid with the documented empty-state line", () => {
  // renderInbox is referenced by name in home() — that's the wiring
  // point we assert. The order check confirms the inbox renders
  // BEFORE the "Your projects" eyebrow.
  assert.match(APP_JS, /function\s+renderInbox\s*\(/,
    "renderInbox(data) helper must be defined");
  // The empty-state copy is verbatim per the ticket.
  assert.ok(APP_JS.includes("Inbox zero — fleet's healthy."),
    "empty-state copy must read exactly: Inbox zero — fleet's healthy.");
  // Each item kind has a human label so the SPA isn't just echoing
  // the enum string. Test the four kinds.
  for (const kind of ["pr_review", "anomaly_open", "snapshot_expiring", "run_failed"]) {
    assert.ok(APP_JS.includes(kind),
      `app.js must reference the "${kind}" inbox kind`);
  }
  // home() must call renderInbox before mapping data.projects (i.e.
  // inbox renders above the project grid).
  const homeStart = APP_JS.indexOf("async function home(");
  assert.ok(homeStart > 0, "home() must exist");
  const slice = APP_JS.slice(homeStart, homeStart + 4000);
  const idxRenderInbox = slice.indexOf("renderInbox(");
  const idxProjects = slice.indexOf("data.projects.map(card)");
  assert.ok(idxRenderInbox > 0, "home() must call renderInbox(...)");
  assert.ok(idxProjects > 0, "home() must still render the project grid");
  assert.ok(idxRenderInbox < idxProjects,
    "renderInbox must run BEFORE data.projects.map(card) so the inbox sits above the grid");
  // A dismiss handler must be wired (posts to /api/fleet/inbox/dismiss).
  assert.ok(APP_JS.includes("/api/fleet/inbox/dismiss"),
    "app.js must POST to /api/fleet/inbox/dismiss");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — mobile (375px viewport): inbox stacks single-column, no
// horizontal scroll. Source-level guarantee (mirror of
// mobile-portal.test.ts AC3).
// ────────────────────────────────────────────────────────────────────

test("AC7: at 375px viewport the inbox row stacks single-column (grid-template-columns: 1fr inside the mobile MQ)", () => {
  // The mobile MQ from ticket 0011 lives at (max-width: 640px). The
  // inbox row baseline is a 2-column grid (`1fr auto`); inside the
  // mobile MQ it must collapse to one column.
  // Find the (max-width: 640px) block body — same extractMediaBlock
  // shape as the mobile-portal test, but inlined here so we don't
  // share state across test files.
  const opener = /@media\s*\(\s*max-width:\s*640px\s*\)\s*\{/.exec(CSS);
  assert.ok(opener, "mobile @media (max-width: 640px) block must exist");
  let depth = 1, i = opener.index + opener[0].length;
  const start = i;
  while (i < CSS.length && depth > 0) {
    const c = CSS[i++];
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  const body = CSS.slice(start, i - 1);
  // Inside the mobile MQ, an `.inbox-row` selector resets the grid
  // to one column.
  assert.match(
    body,
    /\.inbox-row\s*\{[^}]*grid-template-columns\s*:\s*1fr/,
    "mobile MQ must collapse .inbox-row to grid-template-columns: 1fr",
  );
  // Sanity: no rule anywhere pins a fixed min-width > 375 on the
  // inbox row (would force overflow at iPhone 13 mini).
  const allInboxRule = /\.inbox-row\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = allInboxRule.exec(CSS)) !== null) {
    const ruleBody = m[1];
    const mw = /min-width\s*:\s*(\d+)px/.exec(ruleBody);
    if (mw) assert.ok(+mw[1] <= 375,
      `.inbox-row min-width: ${mw[1]}px would overflow a 375px viewport`);
  }
});

// ────────────────────────────────────────────────────────────────────
// AC8 — performance: 10 projects, 1000 anomalies, 50 PRs, 5 snapshots
// → fleetInbox completes in < 100ms. Skipped unless PERF=1.
// ────────────────────────────────────────────────────────────────────

test("AC8: fleetInbox runs in under 100ms against a synthetic 10-project / 1000-anomaly / 50-PR / 5-snapshot fleet", { skip: process.env.PERF !== "1" }, () => {
  const { db, cleanup } = tempDb();
  try {
    const now = new Date("2026-05-27T12:00:00.000Z");
    const t = (mins: number) => new Date(now.getTime() - mins * 60_000).toISOString();
    const projectIds: number[] = [];
    for (let i = 0; i < 10; i++) projectIds.push(seedProject(db, `proj-${i}`, `Project ${i}`));
    // 50 open agent PRs distributed across projects, all fetched in
    // the last 3 hours.
    for (let n = 0; n < 50; n++) {
      const pid = projectIds[n % projectIds.length];
      seedPr(db, { projectId: pid, number: 1000 + n, title: `pr-${n}`,
        url: `https://github.com/owner/x/pull/${1000 + n}`, fetchedAt: t(n + 5) });
    }
    // 1000 anomalies across projects in the last 24h.
    for (let n = 0; n < 1000; n++) {
      const pid = projectIds[n % projectIds.length];
      const rid = seedRun(db, {
        projectId: pid, phase: "ship",
        sessionId: `s-perf-${n}-${randomBytes(3).toString("hex")}`,
        startedAt: t(Math.floor(n / 5)), outcome: "shipped",
      });
      seedAnomaly(db, {
        runId: rid, kind: "duration", createdAt: t(Math.floor(n / 5)),
        value: 60_000 + n, baselineMean: 10_000, baselineStddev: 2_000,
        sampleCount: 14,
      });
    }
    // 5 active snapshots expiring in the next 6h.
    for (let n = 0; n < 5; n++) {
      const id = createHash("sha256").update(`tok-${n}`).digest("hex");
      seedSnapshot(db, {
        id, name: `snap-${n}`,
        createdAt: t(60 * 12),
        expiresAt: new Date(now.getTime() + (n + 1) * 60 * 60_000).toISOString(),
      });
    }
    const t0 = Date.now();
    const r = fleetInbox(db, { now: now.toISOString() });
    const elapsed = Date.now() - t0;
    assert.ok(r.items.length > 0, "the synthetic fleet should produce inbox rows");
    assert.ok(elapsed < 100, `fleetInbox took ${elapsed}ms — must be under 100ms`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC9 — no new runtime deps; no JSON-shape change to existing /api routes.
// ────────────────────────────────────────────────────────────────────

test("AC9: package.json carries zero runtime dependencies (inbox is built on stdlib + node:sqlite)", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    `dependencies must stay empty; found: ${Object.keys(deps).join(", ")}`);
});
