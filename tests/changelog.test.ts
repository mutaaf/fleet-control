// Tests for ticket 0039 — Fleet changelog page.
//
// One test(...) per acceptance-criteria checkbox in
// docs/backlog/0039-fleet-changelog-page.md. Strategy mirrors the 0040
// (riskiest-pr) and 0038 (monday-catchup) suites:
//   - Drive `fleetChangelog(db, opts?)` directly against a tmpdir DB
//     for shape, pagination, filters, search-escape and cache-counter
//     assertions.
//   - Boot `startServer()` over loopback for the route + cache tests,
//     using the empty-roots config + tmp fleet-control.config.json
//     seam from LESSONS § "in-process startServer() tests need an
//     empty-roots config + run-row seeds".
//   - SPA renderer tests are text-level over web/app.js + web/style.css
//     per the inbox / streak / glance / cost-per-pr / friday-wrap /
//     riskiest-pr precedent (zero jsdom).
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps
// from `new Date()`": every seed timestamp is anchored to the test's
// `NOW` constant.
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`": row
// narrowing in the helper uses the double-cast (exercised
// transitively by importing fleetChangelog — if the cast regresses
// tsc fails before this file runs).
// Per LESSONS § "groomer prose can disagree with the schema; the
// schema wins": every seeded PR uses state='MERGED' upper-case to
// match the repo-wide convention every other reader in
// src/views.ts (fleetStreak, costPerMergedPr, fridayWrap,
// mondayCatchUp) shares.
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
import { openDb, type DB } from "../src/db.ts";
import {
  fleetChangelog, type FleetChangelog,
} from "../src/views.ts";
import {
  startServer,
  _resetChangelogCacheForTests,
  _getChangelogCacheBuildsForTests,
} from "../src/server.ts";
import { createSnapshot, getSnapshot } from "../src/snapshot.ts";
import { doAction } from "../src/control.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");
const INDEX_HTML = readFileSync(join(WEB_DIR, "index.html"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers — pinned-now seeders.
// ────────────────────────────────────────────────────────────────────

// Pinned wall-clock anchor for every seed. Same anchor as the 0040
// suite so cross-suite reasoning stays simple.
const NOW = new Date("2026-06-05T12:00:00.000Z");

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-changelog-"));
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

interface MergedPrSeed {
  projectId: number;
  number: number;
  title?: string;
  mergedAt: string; // ISO; lands in fetched_at (the merged-at proxy)
  additions?: number;
  deletions?: number;
  isAgent?: number; // 1 by default
  state?: string;   // defaults to 'MERGED'
  url?: string;
}
function seedMergedPr(db: DB, opts: MergedPrSeed): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
    + "additions,deletions,author,url,fetched_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number,
    opts.title ?? `pr ${opts.number}`,
    `feat/${opts.number}-x`,
    opts.state ?? "MERGED", "green", "clean", opts.isAgent ?? 1,
    opts.additions ?? 0, opts.deletions ?? 0, "agent",
    opts.url ?? `https://github.com/owner/x/pull/${opts.number}`,
    opts.mergedAt,
  );
}

function seedTicketLink(db: DB, opts: {
  ticketId: string; projectSlug: string; prNumber: number; commitSha?: string;
  commitDate?: string;
}): void {
  db.prepare(
    "INSERT INTO ticket_commit_link("
    + "ticket_id, project_slug, commit_sha, commit_date, author, message_subject,"
    + " files_changed, insertions, deletions, pr_number"
    + ") VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.ticketId, opts.projectSlug,
    opts.commitSha ?? `sha-${opts.ticketId}-${opts.prNumber}`,
    opts.commitDate ?? NOW.toISOString(),
    "agent", `feat/${opts.ticketId} thing`,
    1, 10, 2, opts.prNumber,
  );
}

/** ISO timestamp `h` hours BEFORE the pinned NOW. */
function hoursBeforeNow(h: number): string {
  return new Date(NOW.getTime() - h * 3600_000).toISOString();
}
/** ISO timestamp `d` whole days BEFORE the pinned NOW, at NOW's hour. */
function daysBeforeNow(d: number): string {
  return new Date(NOW.getTime() - d * 24 * 3600_000).toISOString();
}

// ────────────────────────────────────────────────────────────────────
// AC1 — fleetChangelog returns the documented shape and newest-first
//       row ordering with ticket ids resolved.
// ────────────────────────────────────────────────────────────────────

test("AC1: fleetChangelog returns rows newest-first with ticket ids resolved", () => {
  const { db, cleanup } = tempDb();
  try {
    const fc = seedProject(db, "fleet-control", "Fleet Control");
    const cq = seedProject(db, "courtiq", "Courtiq");

    // Five merged PRs across two projects, distinct merge times.
    seedMergedPr(db, { projectId: fc, number: 88, title: "Friday wrap", mergedAt: hoursBeforeNow(2),
      additions: 312, deletions: 18 });
    seedMergedPr(db, { projectId: fc, number: 86, title: "Lessons portal view", mergedAt: hoursBeforeNow(4),
      additions: 488, deletions: 22 });
    seedMergedPr(db, { projectId: cq, number: 312, title: "Coach drill signals", mergedAt: hoursBeforeNow(6),
      additions: 118, deletions: 7 });
    seedMergedPr(db, { projectId: fc, number: 85, title: "Cost per merged PR", mergedAt: hoursBeforeNow(28),
      additions: 201, deletions: 9 });
    seedMergedPr(db, { projectId: cq, number: 67, title: "Hero gradient", mergedAt: hoursBeforeNow(30),
      additions: 24, deletions: 12 });

    seedTicketLink(db, { ticketId: "0037", projectSlug: "fleet-control", prNumber: 88 });
    seedTicketLink(db, { ticketId: "0036", projectSlug: "fleet-control", prNumber: 86 });
    seedTicketLink(db, { ticketId: "0152", projectSlug: "courtiq", prNumber: 312 });
    seedTicketLink(db, { ticketId: "0035", projectSlug: "fleet-control", prNumber: 85 });
    // PR #67 left intentionally without a ticket link to assert null.

    const r = fleetChangelog(db, { now: NOW.toISOString() });
    assert.equal(r.rows.length, 5, `expected 5 rows; got ${r.rows.length}`);
    assert.equal(r.total, 5, "total reflects the unfiltered merged-PR count");
    assert.equal(r.next_cursor, null, "fewer rows than limit → next_cursor: null");
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(r.generated_at), "generated_at is ISO");

    // Newest-first ordering by merged_at DESC, tiebreak by pr_number DESC.
    assert.equal(r.rows[0].pr_number, 88, "row 0 must be #88 (most recent)");
    assert.equal(r.rows[0].project_slug, "fleet-control");
    assert.equal(r.rows[0].project_name, "Fleet Control");
    assert.equal(r.rows[0].pr_title, "Friday wrap");
    assert.equal(r.rows[0].additions, 312);
    assert.equal(r.rows[0].deletions, 18);
    assert.equal(r.rows[0].ticket_id, "0037");
    assert.equal(r.rows[0].pr_url, "https://github.com/owner/x/pull/88");
    assert.equal(r.rows[0].merged_at, hoursBeforeNow(2));

    assert.equal(r.rows[1].pr_number, 86);
    assert.equal(r.rows[1].ticket_id, "0036");
    assert.equal(r.rows[2].pr_number, 312);
    assert.equal(r.rows[2].project_slug, "courtiq");
    assert.equal(r.rows[2].ticket_id, "0152");
    assert.equal(r.rows[3].pr_number, 85);
    assert.equal(r.rows[3].ticket_id, "0035");
    assert.equal(r.rows[4].pr_number, 67);
    assert.equal(r.rows[4].ticket_id, null, "PR without a ticket-link must surface ticket_id=null");
  } finally { cleanup(); }
});

test("AC1: fleetChangelog ignores non-MERGED and non-agent PRs", () => {
  const { db, cleanup } = tempDb();
  try {
    const fc = seedProject(db, "fleet-control");
    seedMergedPr(db, { projectId: fc, number: 1, mergedAt: hoursBeforeNow(1) });
    // Open PR — must be ignored.
    seedMergedPr(db, { projectId: fc, number: 2, mergedAt: hoursBeforeNow(1), state: "open" });
    // Merged but non-agent — must be ignored.
    seedMergedPr(db, { projectId: fc, number: 3, mergedAt: hoursBeforeNow(1), isAgent: 0 });

    const r = fleetChangelog(db, { now: NOW.toISOString() });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].pr_number, 1);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — Pagination: cursor handoff over 75 rows; malformed cursor 400.
// ────────────────────────────────────────────────────────────────────

test("AC2: pagination — 75 merged PRs / limit=50 → 50 then 25 via cursor; no duplicates", () => {
  const { db, cleanup } = tempDb();
  try {
    const fc = seedProject(db, "fleet-control");
    // 75 distinct merge times — one per hour back, so merged_at is
    // strictly monotonic and the (merged_at, pr_number) cursor is
    // unambiguous.
    for (let i = 0; i < 75; i++) {
      seedMergedPr(db, {
        projectId: fc, number: 100 + i,
        title: `pr ${100 + i}`,
        mergedAt: hoursBeforeNow(i + 1),
      });
    }

    const page1 = fleetChangelog(db, { limit: 50, now: NOW.toISOString() });
    assert.equal(page1.rows.length, 50, "page 1 must carry exactly 50 rows");
    assert.equal(page1.total, 75, "total reflects the full count");
    assert.ok(page1.next_cursor, "next_cursor must be populated when more rows remain");

    const page2 = fleetChangelog(db, { limit: 50, cursor: page1.next_cursor!, now: NOW.toISOString() });
    assert.equal(page2.rows.length, 25, "page 2 must carry the remaining 25");
    assert.equal(page2.next_cursor, null, "last page → next_cursor: null");

    // No duplicates across the two pages.
    const seen = new Set<number>();
    for (const r of page1.rows) seen.add(r.pr_number);
    for (const r of page2.rows) {
      assert.ok(!seen.has(r.pr_number), `pr_number ${r.pr_number} appeared on both pages`);
      seen.add(r.pr_number);
    }
    assert.equal(seen.size, 75, "union of both pages must cover all 75 rows");

    // Page 1 is newest-first; page 2 is older still.
    assert.equal(page1.rows[0].pr_number, 100, "newest merge is #100 (1h ago)");
    assert.equal(page2.rows[page2.rows.length - 1].pr_number, 174, "oldest merge is #174 (75h ago)");
  } finally { cleanup(); }
});

test("AC2: limit clamps to [1, 200] silently", () => {
  const { db, cleanup } = tempDb();
  try {
    const fc = seedProject(db, "x");
    for (let i = 0; i < 3; i++) {
      seedMergedPr(db, { projectId: fc, number: 1 + i, mergedAt: hoursBeforeNow(i + 1) });
    }
    // Default → 50.
    assert.equal(fleetChangelog(db, { now: NOW.toISOString() }).rows.length, 3);
    // limit=2 → 2.
    assert.equal(fleetChangelog(db, { limit: 2, now: NOW.toISOString() }).rows.length, 2);
    // limit=1000 clamps to 200 (still returns 3 rows because that's all there is).
    assert.equal(fleetChangelog(db, { limit: 1000, now: NOW.toISOString() }).rows.length, 3);
    // limit=0 / NaN / negative → default.
    assert.equal(fleetChangelog(db, { limit: 0, now: NOW.toISOString() }).rows.length, 3);
  } finally { cleanup(); }
});

test("AC2: malformed cursor surfaces a thrown error (route maps to 400)", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "x");
    let threw: Error | null = null;
    try { fleetChangelog(db, { cursor: "@@@not-base64@@@", now: NOW.toISOString() }); }
    catch (e) { threw = e as Error; }
    assert.ok(threw, "malformed cursor must throw");
    assert.match(threw!.message, /cursor/i, "error message must mention 'cursor'");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — Project filter: only rows for the matching slug. Unknown slug
//        → empty list, no error.
// ────────────────────────────────────────────────────────────────────

test("AC3: project filter narrows to one slug; unknown slug → empty silently", () => {
  const { db, cleanup } = tempDb();
  try {
    const fc = seedProject(db, "fleet-control");
    const cq = seedProject(db, "courtiq");
    const dc = seedProject(db, "digitalcraft");
    seedMergedPr(db, { projectId: fc, number: 1, mergedAt: hoursBeforeNow(1) });
    seedMergedPr(db, { projectId: cq, number: 2, mergedAt: hoursBeforeNow(2) });
    seedMergedPr(db, { projectId: cq, number: 3, mergedAt: hoursBeforeNow(3) });
    seedMergedPr(db, { projectId: dc, number: 4, mergedAt: hoursBeforeNow(4) });
    seedMergedPr(db, { projectId: fc, number: 5, mergedAt: hoursBeforeNow(5) });

    const courtiqRows = fleetChangelog(db, { projectSlug: "courtiq", now: NOW.toISOString() });
    assert.equal(courtiqRows.rows.length, 2, "only courtiq rows");
    for (const r of courtiqRows.rows) assert.equal(r.project_slug, "courtiq");
    assert.equal(courtiqRows.total, 2, "total reflects the filtered count");

    const unknown = fleetChangelog(db, { projectSlug: "nope-not-real", now: NOW.toISOString() });
    assert.deepEqual(unknown.rows, [], "unknown slug → empty list");
    assert.equal(unknown.total, 0);
    assert.equal(unknown.next_cursor, null);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — Date range filter: from + to ISO strings. Invalid → throws
//       (route maps to 400).
// ────────────────────────────────────────────────────────────────────

test("AC4: date-range filter narrows rows; invalid date throws", () => {
  const { db, cleanup } = tempDb();
  try {
    const fc = seedProject(db, "x");
    // 6 rows spread across 6 calendar days back from NOW noon UTC.
    for (let d = 0; d < 6; d++) {
      seedMergedPr(db, { projectId: fc, number: 100 + d, mergedAt: daysBeforeNow(d) });
    }
    // NOW = 2026-06-05T12:00:00Z, so the rows' YYYY-MM-DDs are
    // 2026-06-05, -04, -03, -02, -01, 2026-05-31.
    const win = fleetChangelog(db, {
      from: "2026-06-02", to: "2026-06-04",
      now: NOW.toISOString(),
    });
    // Window: fetched_at >= 2026-06-02 AND fetched_at < 2026-06-05
    // (to + 1d). 2026-06-04 row + 2026-06-03 row + 2026-06-02 row = 3.
    assert.equal(win.rows.length, 3, `expected 3 rows in 2026-06-02..04 window; got ${win.rows.length}`);
    const days = win.rows.map((r) => r.merged_at.slice(0, 10)).sort();
    assert.deepEqual(days, ["2026-06-02", "2026-06-03", "2026-06-04"]);

    // One-sided from only.
    const fromOnly = fleetChangelog(db, { from: "2026-06-04", now: NOW.toISOString() });
    assert.equal(fromOnly.rows.length, 2, "from=2026-06-04 → 2026-06-04 + 2026-06-05");

    // Invalid date → throws.
    let threwFrom: Error | null = null;
    try { fleetChangelog(db, { from: "banana", now: NOW.toISOString() }); }
    catch (e) { threwFrom = e as Error; }
    assert.ok(threwFrom, "invalid from must throw");
    let threwTo: Error | null = null;
    try { fleetChangelog(db, { to: "2026-13-99", now: NOW.toISOString() }); }
    catch (e) { threwTo = e as Error; }
    assert.ok(threwTo, "invalid to must throw");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — Search filter: case-insensitive substring against title OR
//        ticket_id; LIKE meta-chars escaped.
// ────────────────────────────────────────────────────────────────────

test("AC5: search filters by title (case-insensitive)", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "x");
    seedMergedPr(db, { projectId: p, number: 1, title: "Cost per merged PR", mergedAt: hoursBeforeNow(1) });
    seedMergedPr(db, { projectId: p, number: 2, title: "Friday wrap weekly card", mergedAt: hoursBeforeNow(2) });
    seedMergedPr(db, { projectId: p, number: 3, title: "Lessons portal", mergedAt: hoursBeforeNow(3) });

    const r = fleetChangelog(db, { search: "cost", now: NOW.toISOString() });
    assert.equal(r.rows.length, 1, "only the Cost per merged PR row");
    assert.equal(r.rows[0].pr_number, 1);

    // Case-insensitive.
    const r2 = fleetChangelog(db, { search: "WRAP", now: NOW.toISOString() });
    assert.equal(r2.rows.length, 1);
    assert.equal(r2.rows[0].pr_number, 2);
  } finally { cleanup(); }
});

test("AC5: search matches against ticket_id", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "fleet-control");
    seedMergedPr(db, { projectId: p, number: 88, title: "X", mergedAt: hoursBeforeNow(1) });
    seedMergedPr(db, { projectId: p, number: 86, title: "Y", mergedAt: hoursBeforeNow(2) });
    seedTicketLink(db, { ticketId: "0035", projectSlug: "fleet-control", prNumber: 88 });
    seedTicketLink(db, { ticketId: "0036", projectSlug: "fleet-control", prNumber: 86 });

    const r = fleetChangelog(db, { search: "0035", now: NOW.toISOString() });
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].pr_number, 88);
    assert.equal(r.rows[0].ticket_id, "0035");
  } finally { cleanup(); }
});

test("AC5: search escapes LIKE meta-chars (% _ \\) — '100%' returns 0 false positives", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "x");
    seedMergedPr(db, { projectId: p, number: 1, title: "first row", mergedAt: hoursBeforeNow(1) });
    seedMergedPr(db, { projectId: p, number: 2, title: "second row", mergedAt: hoursBeforeNow(2) });
    seedMergedPr(db, { projectId: p, number: 3, title: "third 100% row", mergedAt: hoursBeforeNow(3) });

    // Without escaping, '%' would be a wildcard matching everything;
    // proper escape means we only match the literal '100%' substring.
    const r = fleetChangelog(db, { search: "100%", now: NOW.toISOString() });
    assert.equal(r.rows.length, 1, "must match only the literal '100%' substring");
    assert.equal(r.rows[0].pr_number, 3);

    // Same protection for '_' (LIKE single-char wildcard).
    seedMergedPr(db, { projectId: p, number: 4, title: "with_underscore here", mergedAt: hoursBeforeNow(4) });
    const u = fleetChangelog(db, { search: "with_under", now: NOW.toISOString() });
    assert.equal(u.rows.length, 1, "underscore must be escaped — only the literal match");
    assert.equal(u.rows[0].pr_number, 4);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 + AC7 — Route + caching. Boot the server in-process per the
//             empty-roots config seam from LESSONS.
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
  const dir = mkdtempSync(join(tmpdir(), "fleet-changelog-boot-"));
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

test("AC6: GET /api/fleet/changelog returns 200 + shape on loopback; filters via project=", async () => {
  _resetChangelogCacheForTests();
  const b = await boot((db) => {
    const fc = seedProject(db, "fleet-control");
    const cq = seedProject(db, "courtiq");
    seedMergedPr(db, { projectId: fc, number: 88, title: "Friday wrap",
      mergedAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
    seedMergedPr(db, { projectId: fc, number: 86, title: "Lessons portal view",
      mergedAt: new Date(Date.now() - 4 * 3600_000).toISOString() });
    seedMergedPr(db, { projectId: cq, number: 312, title: "Coach drill",
      mergedAt: new Date(Date.now() - 6 * 3600_000).toISOString() });
    seedTicketLink(db, { ticketId: "0037", projectSlug: "fleet-control", prNumber: 88 });
  });
  try {
    const r = await fetch(b.base + "/api/fleet/changelog");
    assert.equal(r.status, 200);
    const j = await r.json() as FleetChangelog;
    assert.ok(Array.isArray(j.rows));
    assert.equal(j.total, 3);
    assert.equal(j.rows.length, 3);
    // Filter by project.
    const r2 = await fetch(b.base + "/api/fleet/changelog?project=fleet-control");
    assert.equal(r2.status, 200);
    const j2 = await r2.json() as FleetChangelog;
    assert.equal(j2.rows.length, 2);
    for (const row of j2.rows) assert.equal(row.project_slug, "fleet-control");
    // Search by title.
    const r3 = await fetch(b.base + "/api/fleet/changelog?search=wrap");
    assert.equal(r3.status, 200);
    const j3 = await r3.json() as FleetChangelog;
    assert.equal(j3.rows.length, 1);
    assert.equal(j3.rows[0].pr_number, 88);
  } finally { await b.close(); b.cleanup(); }
});

test("AC6: GET /api/fleet/changelog with malformed cursor returns 400 (NOT 500)", async () => {
  _resetChangelogCacheForTests();
  const b = await boot((db) => {
    const p = seedProject(db, "x");
    seedMergedPr(db, { projectId: p, number: 1,
      mergedAt: new Date(Date.now() - 1 * 3600_000).toISOString() });
  });
  try {
    const r = await fetch(b.base + "/api/fleet/changelog?cursor=@@@bad@@@");
    assert.equal(r.status, 400, `malformed cursor must surface 400; got ${r.status}`);
    const j = await r.json() as { error?: string };
    assert.ok(j.error && /cursor/i.test(j.error), "error must mention cursor");

    // Also assert invalid from= surfaces 400.
    const r2 = await fetch(b.base + "/api/fleet/changelog?from=banana");
    assert.equal(r2.status, 400);
  } finally { await b.close(); b.cleanup(); }
});

test("AC7: GET /api/fleet/changelog sets cache-control: max-age=60 and memoises via build counter; param tuple bumps counter", async () => {
  _resetChangelogCacheForTests();
  const b = await boot((db) => {
    const p = seedProject(db, "cached");
    seedMergedPr(db, { projectId: p, number: 1,
      mergedAt: new Date(Date.now() - 1 * 3600_000).toISOString() });
  });
  try {
    const before = _getChangelogCacheBuildsForTests();
    const r1 = await fetch(b.base + "/api/fleet/changelog");
    assert.equal(r1.status, 200);
    const cc = (r1.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=60/, `cache-control must declare max-age=60; got '${cc}'`);
    await r1.json();
    const afterFirst = _getChangelogCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call → cache MISS, build counter += 1");

    const r2 = await fetch(b.base + "/api/fleet/changelog");
    await r2.json();
    const afterSecond = _getChangelogCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0,
      "identical second call → cache HIT, counter unchanged");

    // Vary a param → counter bumps.
    const r3 = await fetch(b.base + "/api/fleet/changelog?project=cached");
    await r3.json();
    const afterThird = _getChangelogCacheBuildsForTests();
    assert.equal(afterThird - afterSecond, 1,
      "different param tuple → cache MISS, counter += 1");
  } finally { await b.close(); b.cleanup(); }
});

test("AC7: completing a runIngestPass clears the changelog cache (next call rebuilds)", async () => {
  _resetChangelogCacheForTests();
  const b = await boot((db) => {
    const p = seedProject(db, "live");
    seedMergedPr(db, { projectId: p, number: 1,
      mergedAt: new Date(Date.now() - 1 * 3600_000).toISOString() });
  });
  try {
    const before = _getChangelogCacheBuildsForTests();
    const r1 = await fetch(b.base + "/api/fleet/changelog");
    await r1.json();
    const afterFirst = _getChangelogCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call rebuilds");

    const r2 = await fetch(b.base + "/api/fleet/changelog");
    await r2.json();
    const afterCached = _getChangelogCacheBuildsForTests();
    assert.equal(afterCached - afterFirst, 0, "cache HIT");

    // Simulate an ingest tail by running runIngestPass directly. The
    // hook lives at the end of runIngestPass and calls the reset
    // helper — so the next call rebuilds.
    const { runIngestPass } = await import("../src/ingest/index.ts");
    const { loadConfig } = await import("../src/config.ts");
    const db = openDb(b.dbPath);
    try { runIngestPass(db, loadConfig()); } finally { db.close(); }

    const r3 = await fetch(b.base + "/api/fleet/changelog");
    await r3.json();
    const afterIngest = _getChangelogCacheBuildsForTests();
    assert.equal(afterIngest - afterCached, 1,
      "post-ingest the cache must be cleared so the next call rebuilds");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC8 — web/app.js renders a #/changelog route and a top-bar link;
//        DOM contains data-testid="fleet-changelog"; PR title +
//        ticket id pass through redactSecrets.
// ────────────────────────────────────────────────────────────────────

test("AC8: web/index.html exposes a CHANGELOG top-bar link beside LESSONS", () => {
  assert.match(INDEX_HTML, /href="#\/changelog"[^>]*data-testid="topbar-changelog"/,
    "index.html must add a top-bar link with href=\"#/changelog\" and data-testid=\"topbar-changelog\"");
});

test("AC8: web/app.js routes #/changelog to a renderChangelogPage; emits data-testid=\"fleet-changelog\"; uses redactSecrets", () => {
  assert.match(APP_JS, /function\s+renderChangelogPage\s*\(/,
    "web/app.js must declare a renderChangelogPage helper");
  assert.match(APP_JS, /data-testid="fleet-changelog"/,
    "the page container must carry data-testid=\"fleet-changelog\"");
  assert.match(APP_JS, /\/api\/fleet\/changelog/,
    "web/app.js must fetch the new /api/fleet/changelog route");
  // The hash router must dispatch to a changelog handler.
  assert.match(APP_JS, /path\s*===\s*"changelog"|path\.startsWith\("changelog"\)/,
    "the hash router must dispatch to a changelog handler");
  // The render function must redact secrets on operator-visible
  // strings (PR titles + ticket ids).
  const renderFn = APP_JS.match(/function\s+renderChangelogPage\s*\([\s\S]*?\n\}/);
  assert.ok(renderFn, "renderChangelogPage function body must be parseable");
  assert.match(renderFn![0], /redactSecrets\(/,
    "renderChangelogPage must route operator-visible strings through redactSecrets");
});

test("AC9: web/app.js renderChangelogPage handles the empty state without crashing", () => {
  const renderFn = APP_JS.match(/function\s+renderChangelogPage\s*\([\s\S]*?\n\}/);
  assert.ok(renderFn);
  // The function must mention "No merged PRs" OR "No matches" string —
  // the empty-state copy.
  assert.match(renderFn![0], /No merged PRs|No matches/i,
    "renderChangelogPage must include an empty-state copy");
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Mobile: 375px collapses, 600px is one row. Assert via the
//         existing text-level CSS contract.
// ────────────────────────────────────────────────────────────────────

test("AC10: web/style.css declares .changelog-row + a 600px breakpoint", () => {
  assert.match(CSS, /\.changelog-row\b/,
    "style.css must define a .changelog-row selector");
  // The page CSS must declare a >= 600px media block targeting the row.
  const blocks = CSS.match(/@media\s*\([^)]*min-width:\s*600px[^)]*\)\s*\{[\s\S]*?\n\}/g) || [];
  const matchingBlock = blocks.find((b) => /\.changelog-row|\.changelog-filters/.test(b));
  assert.ok(matchingBlock,
    "a @media (min-width: 600px) block must target .changelog-row or .changelog-filters");
});

// ────────────────────────────────────────────────────────────────────
// AC11 — Performance: 1000 merged PRs across 10 projects, limit=50,
//         under 30ms. Skip unless PERF=1.
// ────────────────────────────────────────────────────────────────────

test("AC11: perf — fleetChangelog completes < 30ms on 1000 merged PRs × 10 projects", { skip: process.env.PERF !== "1" }, () => {
  const { db, cleanup } = tempDb();
  try {
    const pids: number[] = [];
    for (let i = 0; i < 10; i++) pids.push(seedProject(db, `p${i}`));
    for (let i = 0; i < 1000; i++) {
      seedMergedPr(db, {
        projectId: pids[i % 10],
        number: 10000 + i,
        mergedAt: hoursBeforeNow(i + 1),
      });
    }
    const t1 = Date.now();
    fleetChangelog(db, { limit: 50, now: NOW.toISOString() });
    const dt = Date.now() - t1;
    assert.ok(dt < 30, `fleetChangelog must finish <30ms; took ${dt}ms`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC12 — Snapshot integration. include_changelog?: boolean flag on
//         createSnapshot — default false. When true, payload.changelog
//         carries anonymized rows. When false, the payload is
//         byte-identical to today's (no `changelog` key).
// ────────────────────────────────────────────────────────────────────

test("AC12: createSnapshot WITHOUT include_changelog leaves the payload byte-identical (no changelog key)", () => {
  const { db, cleanup } = tempDb();
  try {
    const view = {
      projects: [{ slug: "p1", name: "P1", runs: 1, cost: 0 }],
      totals: { runs: 1, cost: 0 },
    };
    const m = createSnapshot(db, { name: "default", fleetView: view });
    const resolved = getSnapshot(db, m.token);
    assert.ok(resolved);
    const payload = resolved!.payload as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(payload, "changelog"), false,
      "default mint must NOT add a `changelog` key (backward-compatible byte shape)");
  } finally { cleanup(); }
});

test("AC12: createSnapshot WITH include_changelog:true adds anonymized changelog rows", () => {
  const { db, cleanup } = tempDb();
  try {
    const fc = seedProject(db, "fleet-control", "Fleet Control");
    seedMergedPr(db, { projectId: fc, number: 88, title: "Friday wrap",
      mergedAt: hoursBeforeNow(2), additions: 312, deletions: 18 });
    seedMergedPr(db, { projectId: fc, number: 86, title: "Lessons portal",
      mergedAt: hoursBeforeNow(4), additions: 488, deletions: 22 });
    seedTicketLink(db, { ticketId: "0037", projectSlug: "fleet-control", prNumber: 88 });

    const view = {
      projects: [{ slug: "fleet-control", name: "Fleet Control", runs: 0, cost: 0 }],
      totals: { runs: 0, cost: 0 },
    };
    const m = createSnapshot(db, {
      name: "with-changelog",
      fleetView: view,
      include_changelog: true,
      changelog: fleetChangelog(db, { now: NOW.toISOString() }),
    });
    const resolved = getSnapshot(db, m.token);
    assert.ok(resolved);
    const payload = resolved!.payload as { changelog?: { rows?: any[] } };
    assert.ok(payload.changelog, "include_changelog:true must add a `changelog` key");
    assert.ok(Array.isArray(payload.changelog!.rows), "changelog.rows must be an array");
    assert.equal(payload.changelog!.rows!.length, 2);
    // Slugs must be anonymized to `project-N` placeholders.
    for (const row of payload.changelog!.rows!) {
      assert.match(String(row.project_slug), /^project-\d+$/,
        `changelog row slugs must be anonymized; saw '${row.project_slug}'`);
      // Title must NOT be the real PR title (the anonymizer replaces).
      assert.equal(row.pr_title, "PR #XX",
        "changelog row pr_title must be the anonymized placeholder");
      // PR URL stripped.
      assert.equal(row.pr_url, "");
    }
  } finally { cleanup(); }
});

test("AC12: doAction snapshot-create accepts include_changelog and computes it server-side", async () => {
  const { db, cleanup } = tempDb();
  try {
    const fc = seedProject(db, "fleet-control", "Fleet Control");
    seedMergedPr(db, { projectId: fc, number: 88, title: "Friday wrap",
      mergedAt: hoursBeforeNow(2), additions: 312, deletions: 18 });
    seedTicketLink(db, { ticketId: "0037", projectSlug: "fleet-control", prNumber: 88 });

    const view = {
      projects: [{ slug: "fleet-control", name: "Fleet Control", runs: 0, cost: 0 }],
      totals: { runs: 0, cost: 0 },
    };
    const r = await doAction(db, "local", "snapshot-create", {
      name: "via-action",
      fleet_view: view,
      include_changelog: true,
    }, "local");
    assert.ok(r.ok, `doAction must succeed: ${r.message}`);
    assert.ok(r.output, "doAction output JSON expected");
    const m = JSON.parse(r.output!);
    const resolved = getSnapshot(db, m.token);
    assert.ok(resolved);
    const payload = resolved!.payload as { changelog?: { rows?: any[] } };
    assert.ok(payload.changelog, "snapshot-create must embed changelog when include_changelog:true");
    assert.equal(payload.changelog!.rows!.length, 1);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC13 — No new runtime deps. (Mirrors the riskiest-pr AC12.)
// ────────────────────────────────────────────────────────────────────

test("AC13: package.json dependencies stays empty (zero runtime deps)", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    "package.json `dependencies` must remain empty (Hard NO in AGENTS.md)");
});

test("AC13: src/views.ts changelog SELECT uses 'MERGED' (upper-case) matching the schema convention", () => {
  const src = readFileSync(join(__dirname, "..", "src", "views.ts"), "utf8");
  // The fleetChangelog helper's body must filter on state = 'MERGED'.
  const fn = src.match(/export\s+function\s+fleetChangelog\s*\([\s\S]*?\n\}/);
  assert.ok(fn, "fleetChangelog function body must be parseable");
  assert.match(fn![0], /state\s*=\s*'MERGED'/,
    "fleetChangelog must filter on state = 'MERGED' to match the repo's schema convention");
  // Defence: must NOT use the lower-case 'merged' literal anywhere in the SELECT.
  assert.ok(!/state\s*=\s*'merged'/.test(fn![0]),
    "fleetChangelog must not use lower-case 'merged' (schema is upper-case)");
});
