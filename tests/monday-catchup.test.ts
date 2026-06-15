// Tests for ticket 0038 — Monday morning catch-up card.
//
// One test(...) per acceptance-criteria checkbox. Strategy mirrors the
// 0037 friday-wrap and 0033 yesterday-glance suites:
//   - Drive `mondayCatchUp(db, now, opts)` / `isMonday(now, tz)` /
//     `weekendWindowStart(now, tz, lastSeenAt?)` directly against a
//     tmpdir DB for shape, biggest-ship, needs-you cascade, window
//     anchor, and timezone tests.
//   - Boot `startServer()` over loopback for the route + cache tests,
//     using the empty-roots config + tmp fleet-control.config.json seam
//     from LESSONS § "in-process startServer() tests need an empty-roots
//     config + run-row seeds".
//   - SPA renderer tests are text-level over web/app.js + web/style.css
//     per the inbox / streak / glance / cost-per-pr / friday-wrap
//     precedent (zero jsdom).
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps from
// `new Date()`": every seed timestamp is anchored to the test's `NOW`
// constant.
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`": row
// narrowing in the helper uses the double-cast (exercised transitively
// by importing mondayCatchUp).
// Per LESSONS § "groomer prose can disagree with the schema; the
// schema wins": waiting_prs uses pr.state='open' (lower-case — what
// the production ingester writes); merged PRs use 'MERGED' (the
// codebase-wide convention every existing view shares).
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
  mondayCatchUp, isMonday, weekendWindowStart, type MondayCatchUp,
} from "../src/views.ts";
import {
  startServer,
  _resetMondayCatchUpCacheForTests,
  _getMondayCatchUpCacheBuildsForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers — pinned-now seeders.
// ────────────────────────────────────────────────────────────────────

// Pinned wall-clock anchor for every seed. 2026-06-08 (Monday) 13:14 UTC.
// In UTC that is Monday 13:14. In America/New_York (UTC-4 in June DST)
// that is Monday 09:14 ET — exactly the operator persona's "Monday 9am".
// In America/Los_Angeles (UTC-7) that is Monday 06:14 PT.
const NOW = new Date("2026-06-08T13:14:00.000Z");
const NOW_ISO = NOW.toISOString();

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-monday-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string, cadenceJson: string | null = null): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
  ).run(slug, slug, "test", cadenceJson);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

interface RunSeed {
  projectId: number; phase: string; sessionId?: string; startedAt: string;
  outcome?: string | null; prNumber?: number | null;
  costUsd?: number | null; durationMs?: number;
}
function seedRun(db: DB, r: RunSeed): number {
  const sid = r.sessionId ?? `s-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,duration_ms,outcome,pr_number,cost_usd,cost_source)"
    + " VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    r.projectId, r.phase, sid, r.startedAt,
    r.durationMs ?? 1000, r.outcome ?? null,
    r.prNumber ?? null, r.costUsd ?? 0, "live",
  );
  return Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id);
}

function seedAnomaly(db: DB, runId: number | null, opts: {
  createdAt: string; kind?: string; dismissedAt?: string | null;
  correlationSignature?: string | null; candidateReason?: string | null;
}): void {
  db.prepare(
    "INSERT INTO anomaly(run_id,kind,value,baseline_mean,baseline_stddev,sample_count,candidate_reason,created_at,dismissed_at,correlation_signature)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    runId, opts.kind ?? "duration", 1.0, 0.5, 0.1, 10,
    opts.candidateReason ?? null,
    opts.createdAt, opts.dismissedAt ?? null,
    opts.correlationSignature ?? null,
  );
}

function seedRollup(db: DB, projectId: number, day: string, costUsd: number, phase = "ship"): void {
  db.prepare(
    "INSERT INTO cost_rollup_day(project_id, phase, day, runs, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd)"
    + " VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(projectId, phase, day, 1, 0, 0, 0, 0, costUsd);
}

function seedPr(db: DB, opts: {
  projectId: number; number: number; state: string; fetchedAt: string;
  title?: string; additions?: number; deletions?: number; isAgent?: number;
  ghCreatedAt?: string;
}): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,additions,deletions,author,url,fetched_at,gh_created_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number,
    opts.title ?? `pr-${opts.number}`,
    `feat/${opts.number}`,
    opts.state, "green", null, opts.isAgent ?? 1,
    opts.additions ?? 0, opts.deletions ?? 0, "a",
    `https://github.com/owner/x/pull/${opts.number}`, opts.fetchedAt,
    opts.ghCreatedAt ?? opts.fetchedAt,
  );
}

function seedAlert(db: DB, opts: {
  projectId: number; type: string; severity?: string; title?: string;
  dedupKey: string; createdAt: string; resolvedAt?: string | null;
  phase?: string | null; detail?: string;
}): void {
  db.prepare(
    "INSERT INTO alert(project_id,phase,type,severity,title,detail,dedup_key,created_at,resolved_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.phase ?? null, opts.type,
    opts.severity ?? "warn", opts.title ?? "alert",
    opts.detail ?? "detail", opts.dedupKey,
    opts.createdAt, opts.resolvedAt ?? null,
  );
}

function seedTicketLink(db: DB, opts: {
  ticketId: string; projectSlug: string; commitSha: string;
  commitDate: string; prNumber: number;
}): void {
  db.prepare(
    "INSERT INTO ticket_commit_link("
    + "ticket_id, project_slug, commit_sha, commit_date, author,"
    + " message_subject, files_changed, insertions, deletions, pr_number)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.ticketId, opts.projectSlug, opts.commitSha, opts.commitDate,
    "a", "msg", 1, 1, 1, opts.prNumber,
  );
}

/** ISO timestamp `h` hours BEFORE the pinned NOW. */
function hoursBeforeNow(h: number): string {
  return new Date(NOW.getTime() - h * 3600_000).toISOString();
}

/** YYYY-MM-DD `d` days BEFORE NOW (UTC). */
function dayBeforeNow(d: number): string {
  return new Date(NOW.getTime() - d * 86400_000).toISOString().slice(0, 10);
}

// ────────────────────────────────────────────────────────────────────
// AC1 — mondayCatchUp returns the documented shape; the four headline
//        numbers reflect window-scoped reads of pr / cost_rollup_day /
//        alert tables (since Friday 17:00 ET, which is 21:00 UTC).
// ────────────────────────────────────────────────────────────────────

test("AC1: mondayCatchUp returns merged_prs=6, spent_usd=8.20, waiting_prs=2, open_alerts=1 against the seeded weekend fixture", () => {
  const { db, cleanup } = tempDb();
  try {
    const alpha = seedProject(db, "alpha");
    const beta = seedProject(db, "beta");
    // Window starts Friday 17:00 ET = Friday 21:00 UTC = 2026-06-05T21:00:00Z.
    // NOW is Monday 2026-06-08T13:14:00Z. So any fetched_at >=
    // 2026-06-05T21:00:00Z and <= NOW counts as "in window".
    //
    // 6 merged agent PRs in window, fetched at various times Friday eve
    // through Monday morning.
    seedPr(db, { projectId: alpha, number: 101, state: "MERGED",
      fetchedAt: "2026-06-05T22:00:00.000Z", additions: 30, deletions: 10 });
    seedPr(db, { projectId: alpha, number: 102, state: "MERGED",
      fetchedAt: "2026-06-06T10:00:00.000Z", additions: 80, deletions: 40 });
    seedPr(db, { projectId: alpha, number: 103, state: "MERGED",
      fetchedAt: "2026-06-06T18:00:00.000Z", additions: 20, deletions: 10 });
    seedPr(db, { projectId: beta, number: 201, state: "MERGED",
      fetchedAt: "2026-06-07T08:00:00.000Z", additions: 50, deletions: 15 });
    seedPr(db, { projectId: beta, number: 202, state: "MERGED",
      fetchedAt: "2026-06-07T22:30:00.000Z", additions: 12, deletions: 8 });
    seedPr(db, { projectId: alpha, number: 104, state: "MERGED",
      fetchedAt: "2026-06-08T11:00:00.000Z", additions: 5, deletions: 3 });
    // One pre-Friday merge that must NOT count.
    seedPr(db, { projectId: alpha, number: 50, state: "MERGED",
      fetchedAt: "2026-06-05T16:30:00.000Z", additions: 9, deletions: 9 });
    // 2 open agent PRs waiting for review (state='open' lower-case is what
    // the production ingester writes per the LESSONS schema-vs-prose entry).
    seedPr(db, { projectId: alpha, number: 401, state: "open",
      fetchedAt: "2026-06-08T11:30:00.000Z", additions: 1, deletions: 1 });
    seedPr(db, { projectId: beta, number: 402, state: "open",
      fetchedAt: "2026-06-08T12:00:00.000Z", additions: 1, deletions: 1 });
    // $8.20 across the window. cost_rollup_day stores yyyy-mm-dd buckets;
    // we sum the day buckets that overlap the Friday-17:00→Monday window.
    seedRollup(db, alpha, "2026-06-05", 1.20);
    seedRollup(db, alpha, "2026-06-06", 3.00);
    seedRollup(db, beta, "2026-06-07", 2.50);
    seedRollup(db, alpha, "2026-06-08", 1.50);
    // 1 open alert (resolved_at IS NULL).
    seedAlert(db, {
      projectId: alpha, type: "hung_run",
      dedupKey: "hung:alpha:ship:2026-06-08T11",
      createdAt: "2026-06-08T11:45:00.000Z",
    });
    // One resolved alert — must NOT count.
    seedAlert(db, {
      projectId: beta, type: "self_cancel",
      dedupKey: "self_cancel:beta:1", createdAt: "2026-06-07T10:00:00.000Z",
      resolvedAt: "2026-06-08T08:00:00.000Z",
    });
    const w = mondayCatchUp(db, NOW, { tz: "America/New_York" });
    assert.equal(w.merged_prs, 6, `merged_prs=${w.merged_prs}`);
    assert.ok(Math.abs(w.spent_usd - 8.20) < 1e-6, `spent_usd=${w.spent_usd}`);
    assert.equal(w.waiting_prs, 2, `waiting_prs=${w.waiting_prs}`);
    assert.equal(w.open_alerts, 1, `open_alerts=${w.open_alerts}`);
    assert.equal(w.window.anchor, "friday_17");
    assert.equal(w.window.end, NOW_ISO);
    assert.ok(typeof w.window.hours === "number" && w.window.hours > 0);
    assert.ok(w.generated_at && /\d{4}-\d{2}-\d{2}T/.test(w.generated_at));
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — biggest_ship picks the highest (additions + deletions) merged
//        PR in window; ticket_id resolves via ticket_commit_link.
// ────────────────────────────────────────────────────────────────────

test("AC2: biggest_ship picks the highest additions+deletions merged PR and resolves its ticket id from ticket_commit_link", () => {
  const { db, cleanup } = tempDb();
  try {
    const courtiq = seedProject(db, "courtiq");
    const fleet = seedProject(db, "fleet-control");
    // 5 merged PRs across the weekend with known sizes. The 0312 winner
    // gets a ticket_commit_link row pointing at ticket 0312.
    seedPr(db, { projectId: courtiq, number: 310, state: "MERGED",
      fetchedAt: "2026-06-06T10:00:00.000Z", additions: 80, deletions: 30,
      title: "minor refactor" });
    seedPr(db, { projectId: courtiq, number: 311, state: "MERGED",
      fetchedAt: "2026-06-06T20:00:00.000Z", additions: 200, deletions: 100,
      title: "mid win" });
    // Saturday merge — the biggest. fetched_at 2026-06-06 is a Saturday.
    seedPr(db, { projectId: courtiq, number: 312, state: "MERGED",
      fetchedAt: "2026-06-06T22:00:00.000Z", additions: 800, deletions: 600,
      title: "cost-per-pr summary" });
    seedPr(db, { projectId: fleet, number: 91, state: "MERGED",
      fetchedAt: "2026-06-07T08:00:00.000Z", additions: 100, deletions: 50,
      title: "fleet change" });
    seedPr(db, { projectId: fleet, number: 92, state: "MERGED",
      fetchedAt: "2026-06-08T11:00:00.000Z", additions: 12, deletions: 8,
      title: "tiny" });
    seedTicketLink(db, {
      ticketId: "0312", projectSlug: "courtiq",
      commitSha: "deadbeef", commitDate: "2026-06-06", prNumber: 312,
    });
    const w = mondayCatchUp(db, NOW, { tz: "America/New_York" });
    assert.ok(w.biggest_ship, "biggest_ship must be non-null");
    assert.equal(w.biggest_ship!.project_slug, "courtiq");
    assert.equal(w.biggest_ship!.pr_number, 312);
    assert.equal(w.biggest_ship!.size_score, 1400);
    assert.equal(w.biggest_ship!.ticket_id, "0312");
    assert.equal(w.biggest_ship!.pr_title, "cost-per-pr summary");
  } finally { cleanup(); }
});

test("AC2: biggest_ship is null when zero merged PRs in window", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "quiet");
    const w = mondayCatchUp(db, NOW, { tz: "America/New_York" });
    assert.equal(w.biggest_ship, null);
    assert.equal(w.merged_prs, 0);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — needs_you cascade: pr_review > self_drift > self_cancel_warn >
//        hung_run > null. First non-null match wins.
// ────────────────────────────────────────────────────────────────────

test("AC3: needs_you picks pr_review when an old open agent PR exists (age > 12h)", () => {
  const { db, cleanup } = tempDb();
  try {
    const fleet = seedProject(db, "fleet-control");
    // Old open agent PR — created 28h before NOW.
    seedPr(db, { projectId: fleet, number: 91, state: "open",
      fetchedAt: "2026-06-08T12:00:00.000Z",
      ghCreatedAt: new Date(NOW.getTime() - 28 * 3600_000).toISOString(),
      title: "pending pr" });
    const w = mondayCatchUp(db, NOW, { tz: "America/New_York" });
    assert.ok(w.needs_you, "needs_you must be non-null");
    assert.equal(w.needs_you!.kind, "pr_review");
    assert.equal(w.needs_you!.project_slug, "fleet-control");
    assert.ok(w.needs_you!.age_hours >= 27 && w.needs_you!.age_hours <= 29,
      `age_hours ~28 expected; got ${w.needs_you!.age_hours}`);
    assert.match(w.needs_you!.link, /91/);
  } finally { cleanup(); }
});

test("AC3: needs_you picks self_drift when no pr_review, but an active self_drift anomaly exists", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "courtiq");
    const r = seedRun(db, { projectId: p, phase: "ship",
      startedAt: hoursBeforeNow(2), outcome: "failure" });
    seedAnomaly(db, r, {
      kind: "self_drift",
      createdAt: hoursBeforeNow(2),
      correlationSignature: "bash_share",
      candidateReason: JSON.stringify({
        metric: "bash_share",
        baseline_mean: 0.3, baseline_sigma: 0.05,
        current: 0.6, sigmas: 6,
        first_seen_at: hoursBeforeNow(2),
        contributing_runs: [String(r)],
      }),
    });
    const w = mondayCatchUp(db, NOW, { tz: "America/New_York" });
    assert.ok(w.needs_you, "needs_you must be non-null");
    assert.equal(w.needs_you!.kind, "self_drift");
    assert.equal(w.needs_you!.project_slug, "courtiq");
    assert.match(w.needs_you!.message, /bash_share/);
  } finally { cleanup(); }
});

test("AC3: needs_you picks self_cancel_warn when no pr_review and no self_drift, but a self_cancel warn alert is open", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "courtiq");
    seedAlert(db, {
      projectId: p, type: "self_cancel", severity: "warn",
      title: "courtiq stops in 2d",
      detail: "Extend it to avoid pausing.",
      dedupKey: "self_cancel:courtiq:2",
      createdAt: hoursBeforeNow(4),
    });
    const w = mondayCatchUp(db, NOW, { tz: "America/New_York" });
    assert.ok(w.needs_you, "needs_you must be non-null");
    assert.equal(w.needs_you!.kind, "self_cancel_warn");
    assert.equal(w.needs_you!.project_slug, "courtiq");
    assert.match(w.needs_you!.message, /2d|days/i);
  } finally { cleanup(); }
});

test("AC3: needs_you picks hung_run when no higher-priority signal is present", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "fleet-control");
    seedAlert(db, {
      projectId: p, type: "hung_run", phase: "ship",
      title: "fleet-control: ship running 30m",
      detail: "Beyond the 18m adaptive threshold — auto-killing.",
      dedupKey: "hung:fleet-control:ship:2026-06-08T11",
      createdAt: hoursBeforeNow(1),
    });
    const w = mondayCatchUp(db, NOW, { tz: "America/New_York" });
    assert.ok(w.needs_you, "needs_you must be non-null");
    assert.equal(w.needs_you!.kind, "hung_run");
    assert.equal(w.needs_you!.project_slug, "fleet-control");
  } finally { cleanup(); }
});

test("AC3: needs_you is null when no branch matches", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "quiet");
    const w = mondayCatchUp(db, NOW, { tz: "America/New_York" });
    assert.equal(w.needs_you, null);
  } finally { cleanup(); }
});

test("AC3: pr_review wins when all four branches fire simultaneously", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha");
    const b = seedProject(db, "beta");
    // pr_review candidate (older than 12h).
    seedPr(db, { projectId: a, number: 7, state: "open",
      fetchedAt: NOW_ISO,
      ghCreatedAt: new Date(NOW.getTime() - 24 * 3600_000).toISOString(),
      title: "old pr" });
    // self_drift anomaly.
    const r = seedRun(db, { projectId: b, phase: "ship",
      startedAt: hoursBeforeNow(2), outcome: "failure" });
    seedAnomaly(db, r, {
      kind: "self_drift",
      createdAt: hoursBeforeNow(2),
      correlationSignature: "bash_share",
      candidateReason: JSON.stringify({
        metric: "bash_share",
        baseline_mean: 0.3, baseline_sigma: 0.05,
        current: 0.6, sigmas: 6,
        first_seen_at: hoursBeforeNow(2),
        contributing_runs: [String(r)],
      }),
    });
    // self_cancel_warn alert.
    seedAlert(db, {
      projectId: a, type: "self_cancel", severity: "warn",
      title: "stops in 2d", dedupKey: "self_cancel:alpha:2",
      createdAt: hoursBeforeNow(3),
    });
    // hung_run alert.
    seedAlert(db, {
      projectId: b, type: "hung_run", phase: "ship",
      title: "hung", dedupKey: "hung:beta:ship:1",
      createdAt: hoursBeforeNow(1),
    });
    const w = mondayCatchUp(db, NOW, { tz: "America/New_York" });
    assert.ok(w.needs_you);
    assert.equal(w.needs_you!.kind, "pr_review");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — isMonday helper. Local day-of-week via Intl.DateTimeFormat.
// ────────────────────────────────────────────────────────────────────

test("AC4: isMonday returns false at Monday 02:00 UTC + tz America/Los_Angeles (still Sunday 19:00 PT)", () => {
  const t = new Date("2026-06-08T02:00:00.000Z");
  assert.equal(isMonday(t, "America/Los_Angeles"), false);
});

test("AC4: isMonday returns true at Monday 18:00 UTC + tz America/New_York (Monday 14:00 ET)", () => {
  const t = new Date("2026-06-08T18:00:00.000Z");
  assert.equal(isMonday(t, "America/New_York"), true);
});

test("AC4: isMonday returns true at Monday 13:14 UTC + tz UTC", () => {
  assert.equal(isMonday(NOW, "UTC"), true);
});

test("AC4: isMonday returns false at Tuesday 12:00 UTC + tz UTC", () => {
  const t = new Date("2026-06-09T12:00:00.000Z");
  assert.equal(isMonday(t, "UTC"), false);
});

// ────────────────────────────────────────────────────────────────────
// AC5 — Window anchor: weekendWindowStart returns the LATER of (a) most
//        recent Friday 17:00 in tz and (b) lastSeenAt.
// ────────────────────────────────────────────────────────────────────

test("AC5: weekendWindowStart anchors at Friday 17:00 ET when no lastSeenAt is supplied", () => {
  // NOW = Monday 2026-06-08T13:14:00.000Z = Monday 09:14 ET.
  // Most recent Friday 17:00 ET = 2026-06-05T17:00 ET = 2026-06-05T21:00 UTC.
  const w = weekendWindowStart(NOW, "America/New_York");
  assert.equal(w.start, "2026-06-05T21:00:00.000Z");
  assert.equal(w.anchor, "friday_17");
});

test("AC5: weekendWindowStart prefers lastSeenAt when it is more recent than Friday 17:00", () => {
  // Sunday 8pm ET = Monday 00:00 UTC.
  const lastSeen = "2026-06-08T00:00:00.000Z";
  const w = weekendWindowStart(NOW, "America/New_York", lastSeen);
  assert.equal(w.start, lastSeen);
  assert.equal(w.anchor, "last_seen");
});

test("AC5: weekendWindowStart prefers Friday 17:00 when lastSeenAt is older", () => {
  // lastSeen = Thursday — way before Friday 17:00 anchor.
  const lastSeen = "2026-06-04T12:00:00.000Z";
  const w = weekendWindowStart(NOW, "America/New_York", lastSeen);
  assert.equal(w.start, "2026-06-05T21:00:00.000Z");
  assert.equal(w.anchor, "friday_17");
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Route: GET /api/fleet/monday-catchup returns
//        {visible, ..., stats} shape. 401 without auth on remote,
//        200 with visible boolean.
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
  const dir = mkdtempSync(join(tmpdir(), "fleet-monday-boot-"));
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

test("AC6: GET /api/fleet/monday-catchup on loopback returns 200 with the documented shape", async () => {
  _resetMondayCatchUpCacheForTests();
  const b = await boot((db) => { seedProject(db, "any"); });
  try {
    const r = await fetch(b.base + "/api/fleet/monday-catchup?tz=UTC");
    assert.equal(r.status, 200);
    const j = await r.json() as MondayCatchUp & { visible: boolean };
    assert.equal(typeof j.visible, "boolean", "visible must be a boolean");
    assert.ok(j.window && typeof j.window.start === "string"
      && typeof j.window.end === "string"
      && typeof j.window.hours === "number"
      && (j.window.anchor === "friday_17" || j.window.anchor === "last_seen"));
    assert.equal(typeof j.merged_prs, "number");
    assert.equal(typeof j.spent_usd, "number");
    assert.equal(typeof j.waiting_prs, "number");
    assert.equal(typeof j.open_alerts, "number");
    assert.ok("biggest_ship" in j, "biggest_ship key must be present (null or object)");
    assert.ok("needs_you" in j, "needs_you key must be present (null or object)");
    assert.ok(j.generated_at && typeof j.generated_at === "string");
  } finally { await b.close(); b.cleanup(); }
});

test("AC6: remote caller without a token gets 401 on /api/fleet/monday-catchup", async () => {
  // requireAuth() is the chokepoint; we exercise it directly with a fake
  // remote req per the cost-per-pr precedent (avoids depending on a real
  // non-loopback bind).
  const { requireAuth } = await import("../src/server.ts");
  const { db, cleanup } = tempDb();
  try {
    const fakeReq = {
      socket: { remoteAddress: "10.0.0.5" },
      headers: {},
    };
    const r = requireAuth(db, fakeReq as any, "read");
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Last-seen tracking: every authenticated GET to /api/fleet
//        upserts a `home_last_seen_<actor>` watermark row.
// ────────────────────────────────────────────────────────────────────

test("AC7: /api/fleet upserts a home_last_seen_loopback watermark row", async () => {
  _resetMondayCatchUpCacheForTests();
  const b = await boot();
  try {
    const r1 = await fetch(b.base + "/api/fleet");
    assert.equal(r1.status, 200);
    await r1.json();
    // Read the watermark directly from the same DB the server uses.
    const db = openDb(b.dbPath);
    try {
      const row = db.prepare(
        "SELECT cursor, updated_at FROM watermark WHERE source = 'home_last_seen_loopback'",
      ).get() as { cursor: string; updated_at: string } | undefined;
      assert.ok(row, "home_last_seen_loopback row must exist after one /api/fleet hit");
      assert.ok(row!.cursor && /\d{4}-\d{2}-\d{2}T/.test(row!.cursor),
        "cursor must be an ISO timestamp");
    } finally { db.close(); }
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Caching: Cache-Control max-age=180 and the build counter ticks
//        once per cache miss.
// ────────────────────────────────────────────────────────────────────

test("AC8: GET /api/fleet/monday-catchup sets cache-control max-age=180 and the build counter ticks once per cache miss", async () => {
  _resetMondayCatchUpCacheForTests();
  const b = await boot((db) => { seedProject(db, "cached"); });
  try {
    const before = _getMondayCatchUpCacheBuildsForTests();
    const r1 = await fetch(b.base + "/api/fleet/monday-catchup?tz=UTC");
    assert.equal(r1.status, 200);
    const cc = (r1.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=180/, `cache-control must declare max-age=180; got '${cc}'`);
    await r1.json();
    const afterFirst = _getMondayCatchUpCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call → cache MISS, build counter += 1");

    const r2 = await fetch(b.base + "/api/fleet/monday-catchup?tz=UTC");
    assert.equal(r2.status, 200);
    await r2.json();
    const afterSecond = _getMondayCatchUpCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0,
      "second call within the cache window → cache HIT, counter unchanged");

    _resetMondayCatchUpCacheForTests();
    const afterReset = _getMondayCatchUpCacheBuildsForTests();
    const r3 = await fetch(b.base + "/api/fleet/monday-catchup?tz=UTC");
    assert.equal(r3.status, 200);
    await r3.json();
    const afterThird = _getMondayCatchUpCacheBuildsForTests();
    assert.equal(afterThird - afterReset, 1,
      "after a cache reset, next call rebuilds → counter += 1");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC9 — web/app.js renders the catch-up card only when visible:true;
//        carries data-testid; passes operator strings through redactSecrets.
// ────────────────────────────────────────────────────────────────────

test("AC9: web/app.js declares renderMondayCatchUp; the card renders with data-testid=monday-catchup ABOVE friday-wrap; uses redactSecrets; tap-anywhere navigates to /inbox", () => {
  assert.match(APP_JS, /function\s+renderMondayCatchUp\s*\(/,
    "web/app.js must declare a renderMondayCatchUp helper");
  assert.match(APP_JS, /data-testid="monday-catchup"/,
    "the card must carry data-testid=\"monday-catchup\" for stable phone-test hooks");
  assert.match(APP_JS, /\/api\/fleet\/monday-catchup/,
    "web/app.js must fetch the new /api/fleet/monday-catchup route");
  // The biggest-ship PR title AND needs-you message must pass through
  // redactSecrets (defence-in-depth at the renderer boundary).
  assert.match(APP_JS,
    /redactSecrets\([^)]*pr_title[^)]*\)|redactSecrets\([^)]*biggest_ship[^)]*\)/,
    "biggest_ship.pr_title must pass through redactSecrets before insertion");
  assert.match(APP_JS,
    /redactSecrets\([^)]*needs_you[^)]*\)|redactSecrets\([^)]*message[^)]*\)/,
    "needs_you.message must pass through redactSecrets before insertion");
  // Above-friday-wrap (and therefore above yesterday-glance) positioning:
  // the home() render path must concatenate renderMondayCatchUp BEFORE
  // renderFridayWrap.
  const homeBodyMatch = APP_JS.match(/async\s+function\s+home\s*\(\s*\)[\s\S]*?app\.innerHTML\s*=\s*[\s\S]*?renderYesterdayGlance/);
  assert.ok(homeBodyMatch,
    "home() must include a renderYesterdayGlance call in its app.innerHTML composition");
  const homeBody = homeBodyMatch![0];
  const idxMonday = homeBody.indexOf("renderMondayCatchUp");
  const idxFriday = homeBody.indexOf("renderFridayWrap");
  assert.ok(idxMonday > -1, "home() must reference renderMondayCatchUp");
  assert.ok(idxFriday > -1, "home() must reference renderFridayWrap");
  assert.ok(idxMonday < idxFriday,
    "renderMondayCatchUp must appear ABOVE renderFridayWrap in the home() composition");
  // Tap-anywhere navigates to the inbox surface.
  const renderFn = APP_JS.match(/function\s+renderMondayCatchUp\s*\([\s\S]*?\n\}/);
  assert.ok(renderFn, "renderMondayCatchUp function body must be parseable");
  assert.match(renderFn![0], /#inbox|#\/inbox|href[^"]*inbox/,
    "the catch-up card body must link to /inbox");
  // Non-Monday / empty response branch: renderer returns "" so no DOM
  // element is emitted (no skeleton, no whitespace).
  assert.match(renderFn![0], /return\s*""|return\s*''/,
    "renderMondayCatchUp must return an empty string when not visible");
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Mobile: at 375px the four stats stack 2x2 (matching the 0033
//         / 0037 patterns); at >=600px the stats live in one row.
// ────────────────────────────────────────────────────────────────────

test("AC10: web/style.css declares a monday-catchup selector group with a 600px breakpoint for the single-row layout", () => {
  assert.match(CSS, /\.monday-catchup\b/,
    "style.css must define a .monday-catchup rule group");
  const hasMobileGrid =
    /\.monday-catchup[^{]*\{[^}]*grid-template-columns:\s*(1fr\s+1fr|repeat\(\s*2)/.test(CSS)
    || /\.monday-catchup\s+\.catchup-stats[^{]*\{[^}]*grid-template-columns:\s*(1fr\s+1fr|repeat\(\s*2)/.test(CSS)
    || /\.catchup-stats[^{]*\{[^}]*grid-template-columns:\s*(1fr\s+1fr|repeat\(\s*2)/.test(CSS);
  assert.ok(hasMobileGrid,
    ".monday-catchup must lay the stats out 2-per-row on phones");
  const all600 = CSS.match(/@media\s*\([^)]*min-width:\s*600px[^)]*\)\s*\{[\s\S]*?\n\}/g) || [];
  const matchingBlock = all600.find((b) => /\.monday-catchup|\.catchup-stats/.test(b));
  assert.ok(matchingBlock,
    "A @media (min-width: 600px) block must target .monday-catchup / .catchup-stats");
  const hasDesktopRow =
    /grid-template-columns:\s*(repeat\(\s*4|1fr\s+1fr\s+1fr\s+1fr)/.test(matchingBlock!)
    || /display:\s*flex[^;]*;[\s\S]*flex-direction:\s*row/.test(matchingBlock!);
  assert.ok(hasDesktopRow,
    ".monday-catchup at >=600px must collapse the stats into a single row");
});

// ────────────────────────────────────────────────────────────────────
// AC11 — Quiet-hours integration: the card still renders with full
//         stats even when quiet hours are active (pull surface).
// ────────────────────────────────────────────────────────────────────

test("AC11: mondayCatchUp returns the same shape with full stats even when quiet hours are active (the card is a pull surface)", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha");
    seedPr(db, { projectId: a, number: 1, state: "MERGED",
      fetchedAt: "2026-06-06T20:00:00.000Z", additions: 100, deletions: 50 });
    seedRollup(db, a, "2026-06-06", 1.50);
    // The helper does not accept cfg/quietHoursActive — it is intentionally
    // independent of quiet hours. We assert the shape matches a non-quiet
    // call to prove the pull-surface contract.
    const w = mondayCatchUp(db, NOW, { tz: "America/New_York" });
    assert.equal(w.merged_prs, 1);
    assert.ok(Math.abs(w.spent_usd - 1.50) < 1e-6);
    assert.ok(w.biggest_ship);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC12 — No new runtime deps. package.json dependencies stays empty.
// ────────────────────────────────────────────────────────────────────

test("AC12: package.json dependencies stays empty (zero runtime deps)", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    "package.json `dependencies` must remain empty (Hard NO in AGENTS.md)");
});
