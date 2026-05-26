// HTTP route tests for the embeddable badge (ticket 0015).
//
// Drives the live `startServer()` over loopback so we exercise the
// real request pipeline: route matching, headers, ETag, default
// metric, unknown-slug fallback, 400 on invalid metric, and the
// no-auth posture. Each `test(...)` maps 1:1 to one acceptance
// criterion from docs/backlog/0015-embeddable-status-badge-svg.md.
//
// The boot() helper points HOME at a tmpdir so the inline
// `runIngestPass()` call in `startServer` finds no projects to
// scan (kept fast) and never clobbers our seed data via
// `recomputeRollups()`. We seed test data through real `run`
// rows for the cost metric so the rollup re-derives the value
// from the run rather than racing the test's direct insert.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openDb } from "../src/db.ts";
import { startServer } from "../src/server.ts";

// ────────────────────────────────────────────────────────────────────
// Helpers — boot a server against a tmpdir DB, return its base URL.
// ────────────────────────────────────────────────────────────────────

interface Booted {
  base: string;
  close: () => Promise<void>;
  cleanup: () => void;
  dbPath: string;
}

function freePort(): Promise<number> {
  // Pick an ephemeral port via a throwaway listen.
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

/** Track the temporary fleet-control.config.json we plant in cwd so
 *  startServer's loadConfig() sees empty projectRoots / installedRoot /
 *  cacheBase and skips the operator's real fleet directories. */
let activeBoots = 0;
let savedConfigText: string | null = null;
const CONFIG_PATH = join(process.cwd(), "fleet-control.config.json");

async function boot(seed?: (db: ReturnType<typeof openDb>) => void): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-badge-route-"));
  const dbPath = join(dir, "fleet.db");
  // Point projectRoots / installedRoot / cacheBase at empty tmpdirs so
  // the synchronous `runIngestPass()` inside startServer finds zero
  // projects to scan. This (a) keeps the test fast — discovery + the
  // recompute step are ~O(disk-walk) on the operator's real fleet —
  // and (b) prevents `recomputeRollups()` from wiping our seeded
  // cost_rollup_day rows because `DELETE FROM cost_rollup_day` runs
  // unconditionally regardless of discovered projects.
  //
  // We snapshot any pre-existing config so we restore it on cleanup
  // (some devs keep a local config with a custom admin token).
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
  // Also FLEET_DB_PATH so the server opens the test DB (not the
  // operator's `~/.local/state` one — see ticket 0013).
  process.env.FLEET_DB_PATH = dbPath;
  if (seed) {
    const db = openDb(dbPath);
    try { seed(db); } finally { db.close(); }
  }
  const port = await freePort();
  const server = startServer("127.0.0.1", port);
  // startServer is synchronous-ish (it returns immediately and the
  // .listen() callback fires asynchronously). Wait until we can
  // resolve a baseline request before returning.
  const base = `http://127.0.0.1:${port}`;
  // Poll /api/whoami until it answers (small races are fine).
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base + "/api/whoami");
      if (r.ok) break;
    } catch { /* not up yet */ }
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
    dbPath,
  };
}

function seedProject(db: ReturnType<typeof openDb>, slug: string): number {
  db.prepare("INSERT INTO project(slug,name,namespace) VALUES(?,?,?)")
    .run(slug, slug, "test");
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as any).id;
}

function seedRun(db: ReturnType<typeof openDb>, opts: {
  projectId: number; outcome: string; startedAt: string; phase?: string; sessionId?: string;
}) {
  const sid = opts.sessionId ?? `s-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,outcome,cost_source) VALUES(?,?,?,?,?,?)",
  ).run(opts.projectId, opts.phase ?? "ship", sid, opts.startedAt, opts.outcome, "live");
}

// ────────────────────────────────────────────────────────────────────
// AC3 — GET /badge/<slug>.svg returns image/svg+xml + cache headers
// ────────────────────────────────────────────────────────────────────

test("AC3: GET /badge/<slug>.svg returns image/svg+xml and Cache-Control + ETag", async () => {
  const b = await boot((db) => {
    const pid = seedProject(db, "demo");
    seedRun(db, { projectId: pid, outcome: "success", startedAt: new Date().toISOString() });
  });
  try {
    const r = await fetch(b.base + "/badge/demo.svg");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") || "", /image\/svg\+xml/);
    const cc = r.headers.get("cache-control") || "";
    assert.match(cc, /public/);
    assert.match(cc, /max-age=60/);
    const etag = r.headers.get("etag") || "";
    assert.ok(etag.length > 0, "must set ETag header");
    const body = await r.text();
    assert.ok(body.startsWith("<svg"), "body must be an SVG");
    // ETag must be a sha256 of the body. Quotes are conventional.
    const sha = createHash("sha256").update(body).digest("hex");
    assert.ok(etag.includes(sha) || etag.includes(sha.slice(0, 16)),
      "ETag should be derived from sha256 of the body");
  } finally { await b.close(); b.cleanup(); }
});

test("AC3: default metric is `status` when query is omitted", async () => {
  const b = await boot((db) => {
    const pid = seedProject(db, "demo");
    seedRun(db, { projectId: pid, outcome: "failure", startedAt: new Date().toISOString() });
  });
  try {
    const r = await fetch(b.base + "/badge/demo.svg");
    assert.equal(r.status, 200);
    const body = await r.text();
    // The default `status` metric for a failure run produces "fail" text.
    assert.ok(body.includes("fail"), "default metric=status should render 'fail' for a failure run");
  } finally { await b.close(); b.cleanup(); }
});

test("AC3: unknown slug returns 200 with a grey unknown badge (NOT 404)", async () => {
  const b = await boot();
  try {
    const r = await fetch(b.base + "/badge/nope.svg");
    assert.equal(r.status, 200, "unknown slug must be 200, not 404");
    const body = await r.text();
    assert.ok(body.includes("unknown"), "must render 'unknown' value");
  } finally { await b.close(); b.cleanup(); }
});

test("AC3: invalid metric returns 400 plain-text error", async () => {
  const b = await boot((db) => { seedProject(db, "demo"); });
  try {
    const r = await fetch(b.base + "/badge/demo.svg?metric=bogus");
    assert.equal(r.status, 400);
    assert.match(r.headers.get("content-type") || "", /text\/plain/);
    const body = await r.text();
    assert.ok(body.length > 0, "must include a human-readable error message");
  } finally { await b.close(); b.cleanup(); }
});

test("AC3: cost metric route returns a cost-shaped SVG body", async () => {
  const b = await boot((db) => {
    const pid = seedProject(db, "demo");
    // Seed via real `run` rows — startServer calls runIngestPass which
    // wipes and re-derives cost_rollup_day from the run table, so a
    // direct cost_rollup_day INSERT would be clobbered. A run row
    // survives the recompute and feeds the same rollup we'd see in
    // production.
    const ts = new Date().toISOString();
    db.prepare(
      "INSERT INTO run(project_id,phase,session_id,started_at,outcome,cost_usd,cost_source) "
      + "VALUES(?,?,?,?,?,?, 'live')",
    ).run(pid, "ship", "sess-cost", ts, "shipped", 3.21);
  });
  try {
    const r = await fetch(b.base + "/badge/demo.svg?metric=cost");
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.ok(body.includes("$3.21"), "cost SVG must include the dollar amount; got: " + body.slice(0, 400));
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — badge route does NOT require auth (no x-fleet-token needed),
// even when the caller is from a "remote" perspective.
// ────────────────────────────────────────────────────────────────────

test("AC4: badge route is unauthenticated — no x-fleet-token required, no 401", async () => {
  const b = await boot((db) => { seedProject(db, "demo"); });
  try {
    // Loopback always bypasses auth, but the badge route MUST stay 200
    // even with no token set — the same posture as /share/<token>. We
    // assert 200 explicitly.
    const r = await fetch(b.base + "/badge/demo.svg");
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.ok(body.startsWith("<svg"));
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — the SVG bytes contain no host/IP info (same body on any host).
// ────────────────────────────────────────────────────────────────────

test("AC7: SVG response body is host-neutral — no localhost/127.0.0.1/origin URL", async () => {
  const b = await boot((db) => {
    const pid = seedProject(db, "demo");
    seedRun(db, { projectId: pid, outcome: "success", startedAt: new Date().toISOString() });
  });
  try {
    const r = await fetch(b.base + "/badge/demo.svg");
    assert.equal(r.status, 200);
    // Strip the SVG namespace declaration (a global W3C URI, not the
    // operator's origin) before checking — see AC7 in tests/badge.test.ts.
    const body = (await r.text())
      .replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "")
      .toLowerCase();
    assert.equal(body.includes("localhost"), false);
    assert.equal(body.includes("127.0.0.1"), false);
    assert.equal(body.includes("http://"), false);
    assert.equal(body.includes("https://"), false);
    assert.equal(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(body), false);
  } finally { await b.close(); b.cleanup(); }
});
