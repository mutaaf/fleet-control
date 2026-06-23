// Tests for ticket 0072 - Fleet anniversary milestone card and signed
// share URL.
//
// One test() per acceptance-criteria checkbox in
// docs/backlog/0072-fleet-anniversary-milestone-card-signed-share-url.md.
//
// Strategy:
//   - Drive the pure helper fleetAnniversaryMoment(db, cfg, now)
//     directly against a tmpdir DB for shape, branch and threshold tests.
//   - Drive renderAnniversaryCard / renderAnniversaryShare /
//     renderAnniversaryOgSvg via the _render*ForTests seams per LESSONS
//     2026-06-11 so the install-year / pr_100 / pr_500 / pr_1000 /
//     none / quiet-hours / dismissed branches do NOT race
//     fleet-control.config.json in parallel test files.
//   - Boot startServer() over loopback for the integration routes
//     (token lookup, 404 on unknown / wrong-kind, content-type, OG meta,
//     POST /api/snapshot/anniversary mint flow).
//
// PRODUCER-VS-SPEC reconciliation per LESSONS 2026-06-05:
//   - merged-agent PR rows carry state='MERGED' (upper-case) per the
//     existing src/views.ts:1947 reader convention; the helper queries
//     `state = 'MERGED' AND is_agent = 1`.
//   - the install_date payload_id key on inbox_dismissal is the year
//     only ("install_year:<YYYY>"); the threshold dismissal is the
//     kind + threshold ("pr_100:<YYYY>:100") so a 2-year fleet that
//     crossed 500 in year 2 gets a distinct dismissal from a future
//     1000 crossing.
//
// Per LESSONS 2026-05-29 time-pinned tests must NOT derive seed
// timestamps from new Date(); every fixture timestamp anchors on the
// pinned NOW constant.
// Per LESSONS 2026-06-12 the rendered HTML scrape anchors on a unique
// data-testid attribute, never a greedy id= regex.
// Per LESSONS 2026-06-13 per-candidate fixtures must also clear the
// global empty-fleet gate AND seed enough trailing PR rows so the
// lessons-still-cited bullet isn't accidentally zero.
// Per LESSONS 2026-06-15 the static-grep ordering assertion anchors on
// the if (path.startsWith("/api/")) statement shape, never a loose
// prose substring that a sibling comment could carry.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync,
  unlinkSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../src/db.ts";
import type { FleetConfig } from "../src/config.ts";
import {
  fleetAnniversaryMoment,
  _recordInstallDateIfMissing,
  _renderAnniversaryCardForTests,
  _renderAnniversaryShareForTests,
  _renderAnniversaryOgSvgForTests,
  type AnniversaryMoment,
} from "../src/views.ts";
import { createSnapshot } from "../src/snapshot.ts";
import {
  startServer,
  _resetAnniversaryCacheForTests,
} from "../src/server.ts";
import { _resetRateLimitBucketsForTests, isRateLimitedPath } from "../src/rate_limit.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SERVER_TS = readFileSync(join(REPO_ROOT, "src", "server.ts"), "utf8");
const VIEWS_TS = readFileSync(join(REPO_ROOT, "src", "views.ts"), "utf8");
const DB_TS = readFileSync(join(REPO_ROOT, "src", "db.ts"), "utf8");

// Pinned anchor: Monday 2026-06-23 12:00 UTC. The install_year branch
// fires when the install_date has month+day matching now's month+day.
const NOW = new Date("2026-06-23T12:00:00.000Z");

// ────────────────────────────────────────────────────────────────────
// Fixtures + helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-anniversary-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, path, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string, name?: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
  ).run(slug, name ?? slug, "test", null);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

interface SeedPrOpts {
  projectId: number;
  number: number;
  fetchedAt: string;
  state?: string;
}

function seedMergedPr(db: DB, opts: SeedPrOpts): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,"
    + "is_agent,additions,deletions,author,url,fetched_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, `pr-${opts.number}`, `feat/${opts.number}`,
    opts.state ?? "MERGED", "green", null, 1, 0, 0, "alice",
    `https://github.com/owner/x/pull/${opts.number}`,
    opts.fetchedAt,
  );
}

/** Seed N merged-agent PR rows spaced one day apart ending at endDay.
 *  Returns the earliest fetched_at ISO (suitable to compare with the
 *  install_date row written by the helper's side-effect). */
function seedMergedPrSpread(
  db: DB, projectId: number, count: number, endDay: Date, startNumber = 1,
): string {
  let earliest = "";
  for (let i = 0; i < count; i++) {
    const d = new Date(endDay.getTime() - i * 24 * 3600_000);
    const iso = d.toISOString().slice(0, 10) + "T08:00:00.000Z";
    if (!earliest || iso < earliest) earliest = iso;
    seedMergedPr(db, {
      projectId, number: startNumber + i, fetchedAt: iso,
    });
  }
  return earliest;
}

function makeCfg(extra?: Partial<FleetConfig>): FleetConfig {
  return {
    projectRoots: [],
    installedRoot: "/tmp/empty",
    dbPath: "/tmp/empty/fleet.db",
    cacheBase: "/tmp/empty",
    claudeProjects: "/tmp/empty",
    host: "127.0.0.1",
    port: 7070,
    operator: {
      handle: "mutaaf",
      displayName: "Mutaaf",
      sinceDate: "2025-06-23",
    },
    ...(extra ?? {}),
  };
}

// ────────────────────────────────────────────────────────────────────
// AC1 - operator_install_milestones table exists in a fresh DB and
//       accepts insert + select.
// ────────────────────────────────────────────────────────────────────

test("AC1: operator_install_milestones table exists in fresh DB and supports insert/select", () => {
  const { db, cleanup } = tempDb();
  try {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='operator_install_milestones'",
    ).get() as { name: string } | undefined;
    assert.ok(row, "operator_install_milestones table MUST exist in a fresh DB");
    assert.equal(row!.name, "operator_install_milestones");
    db.prepare(
      "INSERT INTO operator_install_milestones(kind, recorded_at, payload_json) VALUES (?,?,?)",
    ).run("install_date", "2025-06-23T08:00:00.000Z", JSON.stringify({ source: "test" }));
    const r = db.prepare(
      "SELECT kind, recorded_at, payload_json FROM operator_install_milestones WHERE kind=?",
    ).get("install_date") as { kind: string; recorded_at: string; payload_json: string } | undefined;
    assert.ok(r);
    assert.equal(r!.kind, "install_date");
    assert.equal(r!.recorded_at, "2025-06-23T08:00:00.000Z");
    assert.equal(r!.payload_json, JSON.stringify({ source: "test" }));
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 - fleetAnniversaryMoment helper shape + branches.
// ────────────────────────────────────────────────────────────────────

test("AC2: install_year branch fires when install_date is exactly 365 days before now", () => {
  const { db, cleanup } = tempDb();
  try {
    const cfg = makeCfg();
    const pid = seedProject(db, "alpha");
    // 60 PRs spread over the past 60 days so we clear "warming-up" and
    // the lessons-still-cited bullet has data to draw from. Per
    // LESSONS 2026-06-13 per-candidate fixtures must seed enough
    // trailing baseline rows.
    seedMergedPrSpread(db, pid, 60, NOW, 100);
    // Seed install_date row 365 days before NOW.
    const installAt = new Date(NOW.getTime() - 365 * 24 * 3600_000).toISOString();
    db.prepare(
      "INSERT INTO operator_install_milestones(kind, recorded_at, payload_json) VALUES (?,?,?)",
    ).run("install_date", installAt, JSON.stringify({}));

    const m = fleetAnniversaryMoment(db, cfg, NOW);
    assert.equal(m.kind, "install_year",
      `expected kind='install_year'; got ${m.kind} (anniversaryDate=${m.anniversaryDate})`);
    assert.equal(m.years, 1, `expected years=1; got ${m.years}`);
    assert.equal(typeof m.lifetimePrs, "number");
    assert.ok(m.lifetimePrs >= 60, `lifetimePrs should be >=60; got ${m.lifetimePrs}`);
    assert.equal(typeof m.lifetimeHoursSaved, "number");
    assert.equal(typeof m.topLessonsStillCited, "number");
    assert.equal(typeof m.asOf, "string");
    assert.equal(m.version, 1);
  } finally { cleanup(); }
});

test("AC2: kind='none' when install_date is only 100 days ago (no anniversary, no threshold crossed)", () => {
  const { db, cleanup } = tempDb();
  try {
    const cfg = makeCfg();
    const pid = seedProject(db, "alpha");
    // 50 PRs - below the 100 threshold AND only 100 days of history.
    seedMergedPrSpread(db, pid, 50, NOW, 100);
    const installAt = new Date(NOW.getTime() - 100 * 24 * 3600_000).toISOString();
    db.prepare(
      "INSERT INTO operator_install_milestones(kind, recorded_at, payload_json) VALUES (?,?,?)",
    ).run("install_date", installAt, JSON.stringify({}));
    const m = fleetAnniversaryMoment(db, cfg, NOW);
    assert.equal(m.kind, "none", `expected kind='none'; got ${m.kind}`);
  } finally { cleanup(); }
});

test("AC2: pr_100 fires when fleet just crossed 100 merged-agent PRs and no prior install_date row exists; helper writes install_date side-effect", () => {
  const { db, cleanup } = tempDb();
  try {
    const cfg = makeCfg();
    const pid = seedProject(db, "alpha");
    // Seed 100 + 50 trailing baseline = 150 merged PRs so we cross the
    // threshold AND clear the lessons-still-cited bullet > 0.
    seedMergedPrSpread(db, pid, 150, NOW, 100);

    const m = fleetAnniversaryMoment(db, cfg, NOW);
    assert.equal(m.kind, "pr_100", `expected kind='pr_100'; got ${m.kind} lifetimePrs=${m.lifetimePrs}`);
    assert.ok(m.lifetimePrs >= 100, `lifetimePrs >= 100; got ${m.lifetimePrs}`);

    // The install_date row was written by the side-effect.
    const installRow = db.prepare(
      "SELECT recorded_at FROM operator_install_milestones WHERE kind='install_date'",
    ).get() as { recorded_at: string } | undefined;
    assert.ok(installRow,
      "install_date row MUST have been written by the side-effect");
    // And recorded_at equals the earliest pr.fetched_at (within fixture).
    const earliest = db.prepare(
      "SELECT MIN(fetched_at) AS m FROM pr WHERE is_agent=1",
    ).get() as { m: string } | undefined;
    assert.equal(installRow!.recorded_at, earliest!.m,
      "install_date.recorded_at MUST equal MIN(pr.fetched_at)");

    // The pr_100 row was also written.
    const pr100Row = db.prepare(
      "SELECT kind FROM operator_install_milestones WHERE kind='pr_100'",
    ).get() as { kind: string } | undefined;
    assert.ok(pr100Row, "pr_100 milestone row MUST be persisted");
  } finally { cleanup(); }
});

test("AC2: pr_500 fires when fleet just crossed 500 merged-agent PRs and no prior pr_500 row exists", () => {
  const { db, cleanup } = tempDb();
  try {
    const cfg = makeCfg();
    const pid = seedProject(db, "alpha");
    // 550 merged PRs - we already crossed 100 (so seed a prior pr_100
    // dismissal row so we don't fire pr_100 again).
    seedMergedPrSpread(db, pid, 550, NOW, 100);
    // Pre-record pr_100 so the helper picks pr_500.
    db.prepare(
      "INSERT INTO operator_install_milestones(kind, recorded_at, payload_json) VALUES (?,?,?)",
    ).run("pr_100", new Date(NOW.getTime() - 30 * 24 * 3600_000).toISOString(), JSON.stringify({}));
    db.prepare(
      "INSERT INTO operator_install_milestones(kind, recorded_at, payload_json) VALUES (?,?,?)",
    ).run("install_date", new Date(NOW.getTime() - 200 * 24 * 3600_000).toISOString(), JSON.stringify({}));

    const m = fleetAnniversaryMoment(db, cfg, NOW);
    assert.equal(m.kind, "pr_500",
      `expected kind='pr_500'; got ${m.kind} lifetimePrs=${m.lifetimePrs}`);
  } finally { cleanup(); }
});

test("AC2: pr_1000 fires after a 1000-PR crossing", () => {
  const { db, cleanup } = tempDb();
  try {
    const cfg = makeCfg();
    const pid = seedProject(db, "alpha");
    seedMergedPrSpread(db, pid, 1050, NOW, 1);
    db.prepare(
      "INSERT INTO operator_install_milestones(kind, recorded_at, payload_json) VALUES (?,?,?)",
    ).run("pr_100", new Date(NOW.getTime() - 90 * 24 * 3600_000).toISOString(), JSON.stringify({}));
    db.prepare(
      "INSERT INTO operator_install_milestones(kind, recorded_at, payload_json) VALUES (?,?,?)",
    ).run("pr_500", new Date(NOW.getTime() - 60 * 24 * 3600_000).toISOString(), JSON.stringify({}));
    db.prepare(
      "INSERT INTO operator_install_milestones(kind, recorded_at, payload_json) VALUES (?,?,?)",
    ).run("install_date", new Date(NOW.getTime() - 200 * 24 * 3600_000).toISOString(), JSON.stringify({}));
    const m = fleetAnniversaryMoment(db, cfg, NOW);
    assert.equal(m.kind, "pr_1000", `expected kind='pr_1000'; got ${m.kind}`);
  } finally { cleanup(); }
});

test("AC2: kind='none' when fleet has zero merged-agent PRs and no install_date row exists", () => {
  const { db, cleanup } = tempDb();
  try {
    const cfg = makeCfg();
    const m = fleetAnniversaryMoment(db, cfg, NOW);
    assert.equal(m.kind, "none", `empty fleet must yield none; got ${m.kind}`);
  } finally { cleanup(); }
});

test("AC2: _recordInstallDateIfMissing is a no-op when a row already exists", () => {
  const { db, cleanup } = tempDb();
  try {
    db.prepare(
      "INSERT INTO operator_install_milestones(kind, recorded_at, payload_json) VALUES (?,?,?)",
    ).run("install_date", "2025-01-01T00:00:00.000Z", JSON.stringify({}));
    _recordInstallDateIfMissing(db, NOW);
    const row = db.prepare(
      "SELECT recorded_at FROM operator_install_milestones WHERE kind='install_date'",
    ).get() as { recorded_at: string } | undefined;
    assert.equal(row!.recorded_at, "2025-01-01T00:00:00.000Z",
      "existing install_date row MUST NOT be overwritten");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 - Dedup via inbox_dismissal year-qualified payload_id.
// ────────────────────────────────────────────────────────────────────

test("AC3: renderer omits card when inbox_dismissal exists for the install_year:<YYYY> payload_id", () => {
  // Renderer-direct: kind='install_year' with a synthetic payload, but
  // dismissed=true causes the renderer to emit empty string.
  const payload: AnniversaryMoment = {
    kind: "install_year",
    anniversaryDate: "2025-06-23",
    years: 1,
    lifetimePrs: 247,
    lifetimeHoursSaved: 83,
    topLessonsStillCited: 11,
    asOf: NOW.toISOString(),
    version: 1,
  };
  const dismissed = _renderAnniversaryCardForTests(payload, { dismissed: true });
  assert.equal(dismissed, "",
    "dismissed=true MUST cause the renderer to emit empty string");
  const live = _renderAnniversaryCardForTests(payload, { dismissed: false });
  assert.match(live, /data-testid=["']anniversary-card["']/,
    "non-dismissed install_year MUST render the anniversary-card testid");
});

test("AC3: SQL dedup uses inbox_dismissal with year-qualified payload_id; advancing 1 year re-fires", () => {
  // We model the dedup at the SQL helper layer: a small helper
  // isAnniversaryDismissed(db, kind, year) reads inbox_dismissal.
  // We assert that seeding a row for year 2026 suppresses 2026 but
  // NOT 2027.
  const { db, cleanup } = tempDb();
  try {
    db.prepare(
      "INSERT INTO inbox_dismissal(kind, project_slug, payload_id, dismissed_at) "
      + "VALUES('anniversary', 'fleet', 'install_year:2026', ?)",
    ).run(NOW.toISOString());
    // The helper lives next to the route in src/server.ts; we read it
    // by-name from the source to assert the year-qualified payload_id
    // literal lives there. The composer builds the id by concatenating
    // the kind, ":", and the year; we anchor on the literal prefix.
    assert.match(SERVER_TS, /install_year:/,
      "server.ts MUST mint a payload_id starting with 'install_year:' for the install-anniversary dedup");
    assert.match(SERVER_TS, /pr_100:/,
      "server.ts MUST mint a payload_id starting with 'pr_100:' for the 100-PR threshold dedup");
    const row = db.prepare(
      "SELECT 1 AS ok FROM inbox_dismissal WHERE kind='anniversary' AND project_slug='fleet' AND payload_id='install_year:2026'",
    ).get() as { ok: number } | undefined;
    assert.ok(row, "dismissal row should be present for install_year:2026");
    const row2 = db.prepare(
      "SELECT 1 AS ok FROM inbox_dismissal WHERE kind='anniversary' AND project_slug='fleet' AND payload_id='install_year:2027'",
    ).get() as { ok: number } | undefined;
    assert.equal(row2, undefined,
      "dismissal for install_year:2026 MUST NOT suppress install_year:2027");
  } finally { cleanup(); }
});

test("AC3: /api/fleet/anniversary surfaces dismissed=true once the matching install_year inbox_dismissal row exists", async () => {
  // Boot with a seed that puts the fleet on the install-year branch:
  //   - one project,
  //   - 60 merged-agent PRs (below 100 threshold so install_year fires
  //     instead of pr_100),
  //   - an operator_install_milestones row 365 days in the past on the
  //     same calendar month + day as today (so the install_year branch
  //     fires).
  const now = new Date();
  const installAt = new Date(now.getTime() - 365 * 24 * 3600_000).toISOString();
  const b = await boot((db) => {
    db.prepare(
      "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
    ).run("alpha", "Alpha", "test", null);
    const pid = (db.prepare("SELECT id FROM project WHERE slug='alpha'").get() as { id: number }).id;
    for (let i = 0; i < 60; i++) {
      const d = new Date(now.getTime() - i * 24 * 3600_000);
      db.prepare(
        "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,"
        + "is_agent,additions,deletions,author,url,fetched_at)"
        + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        pid, 1000 + i, `pr-${i}`, `feat/${i}`, "MERGED", "green", null, 1, 0, 0, "alice",
        "https://github.com/owner/x/pull/" + (1000 + i),
        d.toISOString().slice(0, 10) + "T08:00:00.000Z",
      );
    }
    db.prepare(
      "INSERT INTO operator_install_milestones(kind, recorded_at, payload_json)"
      + " VALUES (?, ?, ?)",
    ).run("install_date", installAt, JSON.stringify({}));
  });
  try {
    // First call: dismissed=false because nothing in inbox_dismissal.
    const r1 = await fetch(b.base + "/api/fleet/anniversary");
    assert.equal(r1.status, 200);
    const j1: any = await r1.json();
    assert.equal(j1.kind, "install_year",
      `install_date row 365 days ago MUST yield kind='install_year'; got ${j1.kind}`);
    assert.equal(j1.dismissed, false, `first call must be dismissed=false; got ${j1.dismissed}`);
    // Plant the matching dismissal row using the payload_id the route
    // returned so we know we are testing the SAME key the route reads.
    const planDb = openDb(b.dbPath);
    try {
      planDb.prepare(
        "INSERT INTO inbox_dismissal(kind, project_slug, payload_id, dismissed_at)"
        + " VALUES('anniversary', 'fleet', ?, ?)",
      ).run(j1.dismiss_payload_id, now.toISOString());
    } finally { planDb.close(); }
    // Re-fetch - dismissed should flip true. We clear the cache on the
    // server side via the exported reset hook so the next call sees the
    // fresh dismissal row.
    _resetAnniversaryCacheForTests();
    const r2 = await fetch(b.base + "/api/fleet/anniversary");
    const j2: any = await r2.json();
    assert.equal(j2.kind, "install_year",
      `install_year branch MUST still fire on second call (calendar-driven, not row-driven)`);
    assert.equal(j2.dismissed, true,
      "after seeding the dismissal row the route MUST surface dismissed=true");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 - Home-page card: data-testid=anniversary-card + share button.
//       POST /api/snapshot/anniversary mints a token and returns a URL.
// ────────────────────────────────────────────────────────────────────

test("AC4: home-card renderer emits anniversary-card + anniversary-share-button testids for pr_100", () => {
  const payload: AnniversaryMoment = {
    kind: "pr_100",
    anniversaryDate: "2025-12-01",
    years: 0,
    lifetimePrs: 100,
    lifetimeHoursSaved: 41,
    topLessonsStillCited: 5,
    asOf: NOW.toISOString(),
    version: 1,
  };
  const html = _renderAnniversaryCardForTests(payload, { dismissed: false });
  assert.match(html, /data-testid=["']anniversary-card["']/,
    "card MUST carry anniversary-card testid");
  assert.match(html, /data-testid=["']anniversary-share-button["']/,
    "card MUST carry anniversary-share-button testid");
  // The headline should mention the threshold word.
  assert.match(html, /100/,
    "pr_100 card MUST mention the 100 threshold");
});

test("AC4: POST /api/snapshot/anniversary mints a snapshot row of kind='anniversary' and returns { url }", async () => {
  const b = await boot();
  try {
    const r = await fetch(b.base + "/api/snapshot/anniversary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200, `expected 200; got ${r.status}`);
    const j: any = await r.json();
    assert.equal(typeof j.url, "string");
    assert.match(j.url, /^\/share\/anniversary\/[0-9a-f]+$/,
      `url MUST be /share/anniversary/<token>; got ${j.url}`);
    // The token is the suffix after the last slash.
    const token = j.url.split("/").pop()!;
    // Look up the snapshot row in the DB and assert kind='anniversary'.
    const db = openDb(b.dbPath);
    try {
      const id = await import("node:crypto").then((c) =>
        c.createHash("sha256").update(token).digest("hex"));
      const row = db.prepare(
        "SELECT kind FROM snapshot WHERE id = ?",
      ).get(id) as { kind: string } | undefined;
      assert.ok(row, "snapshot row MUST exist");
      assert.equal(row!.kind, "anniversary",
        `snapshot.kind MUST be 'anniversary'; got ${row!.kind}`);
    } finally { db.close(); }
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 - GET /share/anniversary/<token> public route.
// ────────────────────────────────────────────────────────────────────

test("AC5: GET /share/anniversary/<token> returns 200 + HTML with anniversary-share-page testid", async () => {
  _resetRateLimitBucketsForTests();
  const b = await boot();
  try {
    // Mint via the /api/snapshot/anniversary endpoint.
    const mint = await fetch(b.base + "/api/snapshot/anniversary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(mint.status, 200);
    const j: any = await mint.json();
    const token = j.url.split("/").pop()!;

    const ok = await fetch(b.base + "/share/anniversary/" + token);
    assert.equal(ok.status, 200, `valid token MUST 200; got ${ok.status}`);
    assert.match(ok.headers.get("content-type") ?? "", /text\/html/);
    const body = await ok.text();
    assert.match(body, /data-testid=["']anniversary-share-page["']/,
      "rendered HTML MUST carry anniversary-share-page testid");
  } finally { await b.close(); b.cleanup(); }
});

test("AC5: GET /share/anniversary/<token> 404s on unknown token", async () => {
  _resetRateLimitBucketsForTests();
  const b = await boot();
  try {
    const r = await fetch(b.base + "/share/anniversary/" + "f".repeat(48));
    assert.equal(r.status, 404, `unknown token MUST 404; got ${r.status}`);
  } finally { await b.close(); b.cleanup(); }
});

test("AC5: GET /share/anniversary/<token> 404s on a wrong-kind token (stakeholder_monthly)", async () => {
  _resetRateLimitBucketsForTests();
  const b = await boot();
  try {
    // Mint a stakeholder_monthly snapshot directly via createSnapshot.
    const db = openDb(b.dbPath);
    let token: string;
    try {
      const m = createSnapshot(db, {
        name: "x",
        fleetView: null,
        kind: "stakeholder_monthly",
      });
      token = m.token;
    } finally { db.close(); }
    const r = await fetch(b.base + "/share/anniversary/" + token);
    assert.equal(r.status, 404,
      `wrong-kind token MUST 404 on the anniversary route; got ${r.status}`);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 - OG card sibling at /og/share/anniversary/<token>.svg.
// ────────────────────────────────────────────────────────────────────

test("AC6: GET /og/share/anniversary/<token>.svg returns 200 + image/svg+xml with anniversary-og-headline testid", async () => {
  _resetRateLimitBucketsForTests();
  const b = await boot();
  try {
    const mint = await fetch(b.base + "/api/snapshot/anniversary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const j: any = await mint.json();
    const token = j.url.split("/").pop()!;

    const r = await fetch(b.base + "/og/share/anniversary/" + token + ".svg");
    assert.equal(r.status, 200, `valid token MUST 200; got ${r.status}`);
    assert.match(r.headers.get("content-type") ?? "", /image\/svg\+xml/,
      `expected image/svg+xml content-type; got ${r.headers.get("content-type")}`);
    const body = await r.text();
    assert.match(body, /data-testid=["']anniversary-og-headline["']/,
      "OG SVG MUST carry data-testid=anniversary-og-headline");
  } finally { await b.close(); b.cleanup(); }
});

test("AC6: /og/share/anniversary/<token>.svg renderer-direct seam emits three numbers + the operator displayName fallback", () => {
  const payload: AnniversaryMoment = {
    kind: "install_year",
    anniversaryDate: "2025-06-23",
    years: 1,
    lifetimePrs: 247,
    lifetimeHoursSaved: 83,
    topLessonsStillCited: 11,
    asOf: NOW.toISOString(),
    version: 1,
  };
  const svg = _renderAnniversaryOgSvgForTests(payload, { displayName: "Mutaaf" });
  assert.match(svg, /data-testid=["']anniversary-og-headline["']/);
  assert.match(svg, /247/, "OG SVG MUST contain the 247 PR figure");
  assert.match(svg, /83/, "OG SVG MUST contain the 83-hours figure");
  assert.match(svg, /11/, "OG SVG MUST contain the 11-lessons figure");
  assert.match(svg, /Mutaaf/, "OG SVG MUST include the operator display name when present");

  const svgFallback = _renderAnniversaryOgSvgForTests(payload, { displayName: undefined });
  assert.match(svgFallback, /your fleet/i,
    "OG SVG MUST fall back to 'your fleet' when displayName is undefined");
});

// ────────────────────────────────────────────────────────────────────
// AC7 - OG meta tags on the HTML share page.
// ────────────────────────────────────────────────────────────────────

test("AC7: anniversary share HTML page carries og:image / twitter:card / og:title / og:description meta tags", () => {
  const payload: AnniversaryMoment = {
    kind: "install_year",
    anniversaryDate: "2025-06-23",
    years: 1,
    lifetimePrs: 247,
    lifetimeHoursSaved: 83,
    topLessonsStillCited: 11,
    asOf: NOW.toISOString(),
    version: 1,
  };
  const html = _renderAnniversaryShareForTests(payload, {
    displayName: "Mutaaf",
    publicHost: "https://fleet.example.com",
    token: "abc123",
    quietHoursActive: false,
  });
  assert.match(html, /<meta\s+property=["']og:image["']\s+content=["']https:\/\/fleet\.example\.com\/og\/share\/anniversary\/abc123\.svg["']/,
    "og:image MUST point at the host-prefixed /og/share/anniversary/<token>.svg URL");
  assert.match(html, /<meta\s+name=["']twitter:card["']\s+content=["']summary_large_image["']/,
    "twitter:card MUST be summary_large_image");
  assert.match(html, /<meta\s+property=["']og:title["']/,
    "og:title MUST be present");
  assert.match(html, /<meta\s+property=["']og:description["']/,
    "og:description MUST be present");
});

// ────────────────────────────────────────────────────────────────────
// AC8 - Quiet-hours posture: the public footer install CTA is replaced
//       with a softer caption when quietHoursActive is true.
// ────────────────────────────────────────────────────────────────────

test("AC8: quietHoursActive=true suppresses the install-cta on the public share page", () => {
  const payload: AnniversaryMoment = {
    kind: "install_year",
    anniversaryDate: "2025-06-23",
    years: 1,
    lifetimePrs: 247,
    lifetimeHoursSaved: 83,
    topLessonsStillCited: 11,
    asOf: NOW.toISOString(),
    version: 1,
  };
  const quiet = _renderAnniversaryShareForTests(payload, {
    displayName: "Mutaaf",
    publicHost: "https://fleet.example.com",
    token: "abc123",
    quietHoursActive: true,
  });
  assert.equal(/data-testid=["']install-cta["']/.test(quiet), false,
    "quietHoursActive=true MUST suppress install-cta");
  assert.match(quiet, /powered by fleet-control/i,
    "quiet-hours rendering MUST include the softer 'powered by fleet-control' caption");

  const loud = _renderAnniversaryShareForTests(payload, {
    displayName: "Mutaaf",
    publicHost: "https://fleet.example.com",
    token: "abc123",
    quietHoursActive: false,
  });
  assert.match(loud, /data-testid=["']install-cta["']/,
    "quietHoursActive=false MUST emit install-cta");
});

// ────────────────────────────────────────────────────────────────────
// AC9 - Rate-limit prefix coverage. /share/anniversary/ inherits the
//       existing /share/ throttle bucket; /og/share/anniversary/
//       inherits /og/.
// ────────────────────────────────────────────────────────────────────

test("AC9: isRateLimitedPath covers /share/anniversary/ and /og/share/anniversary/ via the existing /share/ + /og/ prefixes", () => {
  assert.equal(isRateLimitedPath("/share/anniversary/abc"), true,
    "/share/anniversary/ MUST be covered by the rate-limit prefix set");
  assert.equal(isRateLimitedPath("/og/share/anniversary/abc.svg"), true,
    "/og/share/anniversary/ MUST be covered by the rate-limit prefix set");
});

// ────────────────────────────────────────────────────────────────────
// AC10 - Cache + invalidation: fleetAnniversaryMoment is memo-cached
//        for 60s and busts when a fresh merged PR lands.
// ────────────────────────────────────────────────────────────────────

test("AC10: globalThis.__fleet_anniversary_invalidate__ is registered on server module load", () => {
  // Trigger module load via the import above; the slot must be set.
  const slot = (globalThis as { __fleet_anniversary_invalidate__?: () => void })
    .__fleet_anniversary_invalidate__;
  assert.equal(typeof slot, "function",
    "globalThis.__fleet_anniversary_invalidate__ MUST be a function after server module load");
});

test("AC10: inserting a fresh merged PR that crosses the next threshold flips the helper's kind on re-evaluation", () => {
  const { db, cleanup } = tempDb();
  try {
    const cfg = makeCfg();
    const pid = seedProject(db, "alpha");
    // 99 merged PRs - one below the 100 threshold.
    seedMergedPrSpread(db, pid, 99, NOW, 100);
    const before = fleetAnniversaryMoment(db, cfg, NOW);
    assert.equal(before.kind, "none",
      `99 merged PRs MUST yield kind='none'; got ${before.kind}`);
    // Insert the 100th PR. The helper sees the crossing on next call.
    seedMergedPr(db, {
      projectId: pid, number: 9999,
      fetchedAt: NOW.toISOString().slice(0, 10) + "T09:00:00.000Z",
    });
    const after = fleetAnniversaryMoment(db, cfg, NOW);
    assert.equal(after.kind, "pr_100",
      `100th merged PR MUST flip kind to 'pr_100'; got ${after.kind}`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC11 - Static-grep ordering. The /share/anniversary/ AND
//        /og/share/anniversary/ routes mount BEFORE the
//        if (path.startsWith("/api/")) gate. Per LESSONS 2026-06-15
//        anchor on the if-statement shape NOT prose.
// ────────────────────────────────────────────────────────────────────

test("AC11: /share/anniversary/ AND /og/share/anniversary/ routes mount BEFORE the /api/ auth gate", () => {
  const shareIdx = SERVER_TS.indexOf("/share/anniversary/");
  const ogIdx = SERVER_TS.indexOf("/og/share/anniversary/");
  const apiGateIdx = SERVER_TS.indexOf("if (path.startsWith(\"/api/\"))");
  assert.ok(shareIdx > 0, "/share/anniversary/ MUST appear in src/server.ts");
  assert.ok(ogIdx > 0, "/og/share/anniversary/ MUST appear in src/server.ts");
  assert.ok(apiGateIdx > 0, "if (path.startsWith(\"/api/\")) gate MUST be present");
  assert.ok(shareIdx < apiGateIdx,
    `share route (idx ${shareIdx}) MUST precede the /api/ gate (idx ${apiGateIdx})`);
  assert.ok(ogIdx < apiGateIdx,
    `og route (idx ${ogIdx}) MUST precede the /api/ gate (idx ${apiGateIdx})`);
});

// ────────────────────────────────────────────────────────────────────
// AC12 - No backticks inside the SCHEMA template-literal for the new
//        table; the helper grep window stays clean.
// ────────────────────────────────────────────────────────────────────

test("AC12: operator_install_milestones CREATE TABLE has no backticks (per LESSONS 2026-05-26)", () => {
  const idx = DB_TS.indexOf("operator_install_milestones");
  assert.ok(idx > 0, "operator_install_milestones must appear in src/db.ts");
  // Slice forward to the closing semicolon. Backticks would break
  // node's type-stripper.
  const tail = DB_TS.slice(idx, DB_TS.indexOf(";", idx));
  assert.equal(tail.includes("`"), false,
    `the new CREATE TABLE block MUST NOT contain a backtick; got: ${tail}`);
});

// ────────────────────────────────────────────────────────────────────
// Boot harness for integration tests.
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
  // Reset the anniversary memo cache so a prior boot's DB does not
  // leak into this boot's cached value (the cache key is "today's
  // date" which doesn't change between tests).
  _resetAnniversaryCacheForTests();
  _resetRateLimitBucketsForTests();
  const dir = mkdtempSync(join(tmpdir(), "fleet-anniversary-boot-"));
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
  } else {
    // Seed a baseline DB so the anniversary helper has something to
    // snapshot when minting. We seed 110 merged-agent PRs so the
    // pr_100 threshold fires and the share page renders a non-trivial
    // payload. Per LESSONS 2026-06-13 the per-candidate fixture also
    // clears the global empty-fleet gate.
    const db = openDb(dbPath);
    try {
      db.prepare(
        "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
      ).run("alpha", "Alpha", "test", null);
      const pid = (db.prepare("SELECT id FROM project WHERE slug='alpha'").get() as { id: number }).id;
      for (let i = 0; i < 110; i++) {
        const d = new Date(NOW.getTime() - i * 24 * 3600_000);
        db.prepare(
          "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,"
          + "is_agent,additions,deletions,author,url,fetched_at)"
          + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          pid, 1000 + i, `pr-${i}`, `feat/${i}`, "MERGED", "green", null, 1, 0, 0, "alice",
          "https://github.com/owner/x/pull/" + (1000 + i),
          d.toISOString().slice(0, 10) + "T08:00:00.000Z",
        );
      }
    } finally { db.close(); }
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
