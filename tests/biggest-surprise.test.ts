// Tests for ticket 0059 — Biggest surprise this week.
//
// One test() per acceptance-criteria checkbox. Strategy mirrors the
// 0054 pulse + 0055 lesson-of-the-day suites:
//   - Drive the pure helper fleetBiggestSurprise(db, opts) directly
//     against a tmpdir DB for the five candidate-detection ACs plus
//     priority and the empty-fleet honest empty-state.
//   - Boot startServer() once for the JSON-route AC and once for the
//     home-page-card AC. Per LESSONS § "in-process startServer() tests
//     need an empty-roots config + run-row seeds" the boot helper
//     plants a tmp fleet-control.config.json in cwd and restores on
//     cleanup.
//   - Monday-hide AC and Mobile-breakpoint AC drive the renderer-
//     direct _renderBiggestSurpriseForTests seam per LESSONS
//     2026-06-11 "startServer() tests that mutate fleet-control.
//     config.json race against parallel test files".
//   - The "no new runtime deps" AC is a static grep over package.json.
//
// PRODUCER-VS-SPEC: per LESSONS 2026-06-05 "groomer prose can disagree
// with the schema; the schema wins":
//   - pr.state = 'MERGED' (uppercase) per src/ingest/prs.ts:152 and
//     the existing costPerMergedPr / spendEfficiencyRanking callers.
//   - pr.heal_attempts is INTEGER DEFAULT 0 per src/db.ts:352.
//   - pr.first_fail_check + pr.first_fail_excerpt are TEXT nullable.
//   - pr.author is TEXT nullable (the GitHub login).
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps
// from new Date()": every seed timestamp anchors to NOW.
// Per LESSONS § "anomaly tests need sigma > 0 in the fixture": the
// spend-doubled fixture spreads prior-week costs so the 2x band is
// geometrically meaningful.
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests": the cache reset + build counter live on the server.
// Per LESSONS 2026-06-10 "redactSecrets on a JSON body shreds your
// KEYS": the JSON route scrubs string VALUES, not the body string.
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
  fleetBiggestSurprise, type FleetBiggestSurprise,
} from "../src/views.ts";
import {
  startServer,
  _resetBiggestSurpriseCacheForTests,
  _getBiggestSurpriseCacheBuildsForTests,
  _renderBiggestSurpriseForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const WEB_DIR = join(ROOT, "web");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const VIEWS_TS = readFileSync(join(ROOT, "src", "views.ts"), "utf8");
const PKG_JSON = readFileSync(join(ROOT, "package.json"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Pinned anchors + seeders
// ────────────────────────────────────────────────────────────────────

// Tuesday 2026-06-09 12:00 UTC sits inside the in-progress week of
// Mon 2026-06-08 to Sun 2026-06-14 (Monday is hidden by AC9, so the
// helper-level tests pin a Tuesday). The most-recent COMPLETE week
// ending at now is Mon 2026-06-01 to Sun 2026-06-07. The 8-week
// trailing baseline therefore covers 8 weeks ending Sun 2026-06-07.
const NOW = new Date("2026-06-09T12:00:00.000Z");
const THIS_WEEK_START = "2026-06-08"; // Monday of in-progress week
const THIS_WEEK_END = "2026-06-14";   // Sunday of in-progress week

// A Monday anchor for AC9 (Monday-hide branch).
const MONDAY_NOW = new Date("2026-06-08T12:00:00.000Z");

function tempDb(): { db: DB; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-surprise-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return {
    db, path,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
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
  author?: string;
  healAttempts?: number;
  firstFailCheck?: string | null;
  url?: string;
}

function seedPr(db: DB, opts: SeedPrOpts): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,"
    + "is_agent,additions,deletions,author,url,fetched_at,heal_attempts,first_fail_check)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, `pr-${opts.number}`, `feat/${opts.number}`,
    opts.state ?? "MERGED", "green", null, 1, 0, 0,
    opts.author ?? "alice",
    opts.url ?? `https://github.com/owner/x/pull/${opts.number}`,
    opts.fetchedAt,
    opts.healAttempts ?? 0,
    opts.firstFailCheck ?? null,
  );
}

function seedRollup(
  db: DB, projectId: number, day: string, costUsd: number, phase = "ship",
): void {
  db.prepare(
    "INSERT INTO cost_rollup_day(project_id, phase, day, runs, input_tokens, "
    + "output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd) "
    + " VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(projectId, phase, day, 1, 0, 0, 0, 0, costUsd);
}

// ────────────────────────────────────────────────────────────────────
// AC1 — fleetBiggestSurprise(db, opts) returns the documented shape.
//        Priority order is silent-project > first-time-check >
//        spend-doubled > heal-streak-broken > new-author-red.
//        Empty signal returns kind: 'none'.
// ────────────────────────────────────────────────────────────────────

test("AC1: empty fleet with sufficient baseline weeks returns kind='none' with the documented sentence", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetBiggestSurpriseCacheForTests();
    // Seed a project with PR rows spanning >=8 trailing weeks of data
    // — one PR per week at exactly 1 merged PR/week so no candidate
    // fires. The trailing avg is 1 (< 3), no first-fail-check, no
    // heal-streak-broken (5 zeros + one zero this week), no
    // spend change.
    const pid = seedProject(db, "stable", "Stable");
    // 8 prior weeks (one merged PR each, all healthy).
    for (let w = 1; w <= 8; w++) {
      const day = new Date(NOW.getTime() - w * 7 * 24 * 3600_000);
      const iso = day.toISOString().slice(0, 10);
      seedPr(db, { projectId: pid, number: 100 + w, fetchedAt: iso + "T08:00:00.000Z" });
    }
    // This week — one healthy merge with heal_attempts=0.
    seedPr(db, { projectId: pid, number: 200, fetchedAt: "2026-06-09T08:00:00.000Z" });
    const v = fleetBiggestSurprise(db, { now: NOW });
    assert.equal(v.kind, "none",
      `no candidate should fire on a stable fleet; got ${v.kind}`);
    assert.equal(
      v.sentence,
      "Nothing surprising this week - the fleet did what it always does.",
      "kind=none must carry the documented honest sentence",
    );
    assert.equal(v.deep_link, null);
    assert.equal(v.candidate_project_slug, null);
    // Documented top-level fields.
    assert.equal(typeof v.generated_at, "string");
    assert.equal(v.week_start_iso, THIS_WEEK_START,
      `week_start_iso must snap to the in-progress Monday; got ${v.week_start_iso}`);
    assert.equal(v.week_end_iso, THIS_WEEK_END,
      `week_end_iso must snap to the in-progress Sunday; got ${v.week_end_iso}`);
  } finally { cleanup(); }
});

test("AC1: priority order — silent-project beats spend-doubled when both fire", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetBiggestSurpriseCacheForTests();
    // Project A: 4 trailing weeks at 5 PRs/week, ZERO this week →
    //   silent-project candidate.
    const pidA = seedProject(db, "alpha", "Alpha");
    for (let w = 1; w <= 4; w++) {
      const wkStart = new Date(NOW.getTime() - w * 7 * 24 * 3600_000);
      const isoDay = wkStart.toISOString().slice(0, 10);
      for (let k = 0; k < 5; k++) {
        seedPr(db, {
          projectId: pidA, number: w * 10 + k,
          fetchedAt: isoDay + "T08:00:00.000Z",
        });
      }
    }
    // Project B: 8 trailing weeks of merged PRs + spend, then this
    // week with double cost-per-PR → spend-doubled candidate (would
    // fire if priority were swapped).
    const pidB = seedProject(db, "bravo", "Bravo");
    // Prior 8 weeks: vary cost-per-PR around $1 (spread keeps median
    // meaningful per the anomaly-σ lesson). 5 PRs/week, $5 total
    // cost → $1.00/PR median.
    for (let w = 1; w <= 8; w++) {
      const wkStart = new Date(NOW.getTime() - w * 7 * 24 * 3600_000);
      const isoDay = wkStart.toISOString().slice(0, 10);
      for (let k = 0; k < 5; k++) {
        seedPr(db, {
          projectId: pidB, number: 1000 + w * 10 + k,
          fetchedAt: isoDay + "T08:00:00.000Z",
        });
      }
      // Per-week cost varies from $4 to $6.5 so σ > 0.
      const weeklyCost = 4 + (w % 5) * 0.5; // 4, 4.5, 5, 5.5, 6, 4, 4.5, 5
      seedRollup(db, pidB, isoDay, weeklyCost);
    }
    // This week: 2 PRs at $5/PR → cost-per-PR = $2.50, baseline ≈ $1.
    seedPr(db, { projectId: pidB, number: 2000, fetchedAt: "2026-06-09T08:00:00.000Z" });
    seedPr(db, { projectId: pidB, number: 2001, fetchedAt: "2026-06-09T08:00:00.000Z" });
    seedRollup(db, pidB, "2026-06-09", 5.0);

    const v = fleetBiggestSurprise(db, { now: NOW });
    assert.equal(v.kind, "silent_project",
      "silent-project must beat spend-doubled per the priority order");
    assert.equal(v.candidate_project_slug, "alpha",
      "the silent project's slug must surface");
    assert.equal(v.deep_link, "/projects/alpha",
      "silent-project deep_link points at /projects/<slug>");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — Silent-project candidate detection.
// ────────────────────────────────────────────────────────────────────

test("AC2: silent-project fires when trailing 4w avg >= 3 and this week is 0", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetBiggestSurpriseCacheForTests();
    const pid = seedProject(db, "courtiq", "Courtiq");
    // 5/5/5/5 across the trailing 4 weeks; zero this week. Per AC10
    // the helper requires >=8 weeks of pr data to escape the warming-
    // up branch, so we extend the prior baseline back another 4 weeks
    // with 1 merged PR/week (low enough to not look like silent
    // breakage on its own; the silent-project check uses ONLY the
    // trailing 4 weeks for its average).
    for (let w = 5; w <= 8; w++) {
      const wkStart = new Date(NOW.getTime() - w * 7 * 24 * 3600_000);
      const isoDay = wkStart.toISOString().slice(0, 10);
      seedPr(db, {
        projectId: pid, number: 500 + w,
        fetchedAt: isoDay + "T08:00:00.000Z",
      });
    }
    for (let w = 1; w <= 4; w++) {
      const wkStart = new Date(NOW.getTime() - w * 7 * 24 * 3600_000);
      const isoDay = wkStart.toISOString().slice(0, 10);
      for (let k = 0; k < 5; k++) {
        seedPr(db, {
          projectId: pid, number: w * 10 + k,
          fetchedAt: isoDay + "T08:00:00.000Z",
        });
      }
    }
    const v = fleetBiggestSurprise(db, { now: NOW });
    assert.equal(v.kind, "silent_project");
    assert.equal(v.candidate_project_slug, "courtiq");
    assert.equal(v.deep_link, "/projects/courtiq");
    assert.match(v.sentence, /courtiq/);
    assert.match(v.sentence, /quiet|silent|0 PRs/i,
      "sentence names the silent-project framing");
  } finally { cleanup(); }
});

test("AC2: silent-project does NOT fire when trailing avg < 3 PRs/week", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetBiggestSurpriseCacheForTests();
    const pid = seedProject(db, "slowpoke", "Slowpoke");
    // 2/2/2/2 across 4 weeks (avg 2 < 3) and zero this week. No fire.
    for (let w = 1; w <= 4; w++) {
      const wkStart = new Date(NOW.getTime() - w * 7 * 24 * 3600_000);
      const isoDay = wkStart.toISOString().slice(0, 10);
      for (let k = 0; k < 2; k++) {
        seedPr(db, {
          projectId: pid, number: w * 10 + k,
          fetchedAt: isoDay + "T08:00:00.000Z",
        });
      }
    }
    const v = fleetBiggestSurprise(db, { now: NOW });
    assert.notEqual(v.kind, "silent_project",
      "trailing avg < 3 PRs/week must NOT fire silent-project");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — First-time-check candidate detection.
// ────────────────────────────────────────────────────────────────────

test("AC3: first-time-check fires when a never-before-seen first_fail_check appears this week", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetBiggestSurpriseCacheForTests();
    const pid = seedProject(db, "courtiq", "Courtiq");
    // 8 weeks of trailing data — every failure is 'typecheck' or
    // 'validate'. No 'e2e'. We need a non-silent baseline so the
    // silent-project candidate does NOT pre-empt: seed enough each
    // week (use 1/week — silent-project requires >=3 avg).
    for (let w = 1; w <= 8; w++) {
      const wkStart = new Date(NOW.getTime() - w * 7 * 24 * 3600_000);
      const isoDay = wkStart.toISOString().slice(0, 10);
      seedPr(db, {
        projectId: pid, number: w,
        fetchedAt: isoDay + "T08:00:00.000Z",
        firstFailCheck: (w % 2 === 0) ? "typecheck" : "validate",
      });
    }
    // This week: a PR with first_fail_check='e2e' — never seen
    // before.
    seedPr(db, {
      projectId: pid, number: 999,
      fetchedAt: "2026-06-09T08:00:00.000Z",
      firstFailCheck: "e2e",
      url: "https://github.com/owner/x/pull/999",
    });
    const v = fleetBiggestSurprise(db, { now: NOW });
    assert.equal(v.kind, "first_time_check",
      `expected first_time_check; got ${v.kind}`);
    assert.equal(v.deep_link, "/prs/owner/x/999",
      "first-time-check deep_link is /prs/<repo>/<number>");
    assert.match(v.sentence, /e2e/,
      "sentence names the new check");
    assert.match(v.sentence, /first time|never/i,
      "sentence carries 'first time' framing");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — Spend-doubled candidate detection.
// ────────────────────────────────────────────────────────────────────

test("AC4: spend-doubled fires when this week's cost-per-PR is >= 2x trailing 8w median with >=$1 delta", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetBiggestSurpriseCacheForTests();
    const pid = seedProject(db, "courtiq", "Courtiq");
    // Prior 8 weeks: 5 PRs/week (silent-project would fire if this
    // week were zero — so make this week non-zero), $5 total/week →
    // $1.00/PR baseline. Vary cost across weeks for σ > 0 per the
    // anomaly-fixture lesson: 4.5 / 5 / 5.5 / 4 / 5 / 6 / 4 / 6.
    const weeklyCosts = [4.5, 5, 5.5, 4, 5, 6, 4, 6];
    for (let w = 1; w <= 8; w++) {
      const wkStart = new Date(NOW.getTime() - w * 7 * 24 * 3600_000);
      const isoDay = wkStart.toISOString().slice(0, 10);
      for (let k = 0; k < 5; k++) {
        seedPr(db, {
          projectId: pid, number: w * 10 + k,
          fetchedAt: isoDay + "T08:00:00.000Z",
        });
      }
      seedRollup(db, pid, isoDay, weeklyCosts[w - 1]);
    }
    // This week: 2 PRs at $6 = $3.00/PR (3x the $1 baseline; abs
    // delta $2.00 > $1.00).
    seedPr(db, { projectId: pid, number: 9001, fetchedAt: "2026-06-09T08:00:00.000Z" });
    seedPr(db, { projectId: pid, number: 9002, fetchedAt: "2026-06-09T08:00:00.000Z" });
    seedRollup(db, pid, "2026-06-09", 6.0);

    const v = fleetBiggestSurprise(db, { now: NOW });
    assert.equal(v.kind, "spend_doubled",
      `expected spend_doubled; got ${v.kind}`);
    assert.equal(v.candidate_project_slug, "courtiq");
    assert.equal(v.deep_link, "/projects/courtiq",
      "spend-doubled deep_link points at /projects/<slug>");
    assert.match(v.sentence, /courtiq/);
    assert.match(v.sentence, /\$/,
      "sentence renders a $ amount");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — Heal-streak-broken candidate detection.
// ────────────────────────────────────────────────────────────────────

test("AC5: heal-streak-broken fires when last 5 clean merges are followed by a heal-required merge this week", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetBiggestSurpriseCacheForTests();
    const pid = seedProject(db, "courtiq", "Courtiq");
    // Per AC10 the helper requires >=8 weeks of pr data to escape
    // the warming-up branch. Seed one merged PR per week across all
    // 8 trailing weeks; the helper's heal-streak walk picks the 5
    // newest prior merges regardless of pacing.
    for (let w = 1; w <= 8; w++) {
      const day = new Date(NOW.getTime() - w * 7 * 24 * 3600_000);
      seedPr(db, {
        projectId: pid, number: 100 + w,
        fetchedAt: day.toISOString(),
        healAttempts: 0,
      });
    }
    // This week: one merge with heal_attempts=2 — streak broken.
    seedPr(db, {
      projectId: pid, number: 999,
      fetchedAt: "2026-06-09T08:00:00.000Z",
      healAttempts: 2,
      url: "https://github.com/owner/x/pull/999",
    });
    const v = fleetBiggestSurprise(db, { now: NOW });
    assert.equal(v.kind, "heal_streak_broken",
      `expected heal_streak_broken; got ${v.kind}`);
    assert.equal(v.deep_link, "/prs/owner/x/999");
    assert.match(v.sentence, /courtiq/);
    assert.match(v.sentence, /streak|heal/i);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — New-author-red candidate detection.
// ────────────────────────────────────────────────────────────────────

test("AC6: new-author-red fires when an author with 5+ clean trailing PRs lands a red CI this week", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetBiggestSurpriseCacheForTests();
    const pid = seedProject(db, "courtiq", "Courtiq");
    // Per AC10 the helper requires >=8 weeks of pr data to escape
    // the warming-up branch. Spread eight prior 90-day merges by
    // 'alice' across weeks 2..9 (one per week) with no
    // first_fail_check; the AC's threshold is >=5 trailing PRs.
    for (let i = 0; i < 8; i++) {
      const day = new Date(NOW.getTime() - (i + 2) * 7 * 24 * 3600_000);
      seedPr(db, {
        projectId: pid, number: 200 + i,
        fetchedAt: day.toISOString(),
        author: "alice",
        firstFailCheck: null,
      });
    }
    // Seed a baseline 'typecheck' failure in the trailing weeks so
    // the first-time-check candidate does NOT pre-empt this week's
    // 'typecheck' (which we want to surface as new-author-red).
    // Different author so the 90d clean-author count for 'alice'
    // stays at zero red CIs.
    seedPr(db, {
      projectId: pid, number: 777,
      fetchedAt: new Date(NOW.getTime() - 5 * 7 * 24 * 3600_000).toISOString(),
      author: "bob",
      firstFailCheck: "typecheck",
    });
    // This week: an 'alice' PR with first_fail_check='typecheck'.
    seedPr(db, {
      projectId: pid, number: 555,
      fetchedAt: "2026-06-09T08:00:00.000Z",
      author: "alice",
      firstFailCheck: "typecheck",
      url: "https://github.com/owner/x/pull/555",
    });
    const v = fleetBiggestSurprise(db, { now: NOW });
    assert.equal(v.kind, "new_author_red",
      `expected new_author_red; got ${v.kind}`);
    assert.equal(v.deep_link, "/prs/owner/x/555");
    assert.match(v.sentence, /alice/);
    assert.match(v.sentence, /first red|90 days/i);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — GET /api/fleet/biggest-surprise returns AC1 shape JSON.
//        Auth: same posture as /api/fleet/inbox.
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

async function boot(
  seed?: (db: DB) => void,
  extraConfig?: Record<string, unknown>,
): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-surprise-boot-"));
  const dbPath = join(dir, "fleet.db");
  if (activeBoots === 0) {
    savedConfigText = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null;
  }
  activeBoots += 1;
  const emptyRoots = join(dir, "empty");
  mkdirSync(emptyRoots, { recursive: true });
  // adminToken seeds an explicit token so non-loopback paths can be
  // exercised with x-fleet-token; the route is otherwise loopback-
  // bypassed.
  writeFileSync(CONFIG_PATH, JSON.stringify({
    projectRoots: [emptyRoots],
    installedRoot: emptyRoots,
    cacheBase: emptyRoots,
    claudeProjects: emptyRoots,
    adminToken: "test-admin-token-for-0059",
    ...(extraConfig ?? {}),
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

test("AC7: GET /api/fleet/biggest-surprise returns 200 JSON over loopback with the documented shape", async () => {
  _resetBiggestSurpriseCacheForTests();
  const b = await boot((db) => {
    const pid = seedProject(db, "stable", "Stable");
    for (let w = 1; w <= 8; w++) {
      const day = new Date(NOW.getTime() - w * 7 * 24 * 3600_000);
      const iso = day.toISOString().slice(0, 10);
      seedPr(db, { projectId: pid, number: 100 + w, fetchedAt: iso + "T08:00:00.000Z" });
    }
    seedPr(db, { projectId: pid, number: 200, fetchedAt: "2026-06-09T08:00:00.000Z" });
  });
  try {
    const r = await fetch(b.base + "/api/fleet/biggest-surprise");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /application\/json/);
    const j = await r.json() as FleetBiggestSurprise;
    assert.equal(typeof j.generated_at, "string");
    assert.equal(typeof j.week_start_iso, "string");
    assert.equal(typeof j.week_end_iso, "string");
    assert.equal(typeof j.kind, "string");
    assert.equal(typeof j.sentence, "string");
    assert.equal(typeof j.metric_label, "string");
    assert.equal(typeof j.metric_baseline, "string");
    assert.equal(typeof j.metric_this_week, "string");
  } finally { await b.close(); b.cleanup(); }
});

test("AC7: GET /api/fleet/biggest-surprise is gated by the read-scope auth chokepoint", () => {
  // server.ts's isLoopback() reads the socket's remoteAddress so a
  // fetch from 127.0.0.1 always bypasses auth; spawning a real
  // remote test bench is out-of-scope for a unit test. We instead
  // verify the architecture: every /api/* path inside the GET
  // dispatcher walks through ONE shared requireAuth(db, req, 'read',
  // url) chokepoint at the top of the block, and the new route lives
  // INSIDE that block. The test below asserts both invariants from
  // the source.
  const SERVER_TS_LOCAL = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
  const guardIdx = SERVER_TS_LOCAL.indexOf(
    'const rauth = requireAuth(db, req, "read"',
  );
  assert.notEqual(guardIdx, -1,
    "server.ts must declare the read-scope requireAuth chokepoint for /api/* GETs");
  const routeIdx = SERVER_TS_LOCAL.indexOf('/api/fleet/biggest-surprise');
  assert.notEqual(routeIdx, -1,
    "server.ts must register the /api/fleet/biggest-surprise route");
  assert.ok(routeIdx > guardIdx,
    "the /api/fleet/biggest-surprise handler MUST sit AFTER the read-scope chokepoint");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Home-page card render + dismissal round-trip.
// ────────────────────────────────────────────────────────────────────

test("AC8: dismissing kind='biggest_surprise' lands an inbox_dismissal row keyed by week_start_iso; route surfaces dismissed=true", async () => {
  _resetBiggestSurpriseCacheForTests();
  const b = await boot();
  try {
    // First, read the route to learn the current in-progress week
    // boundary the server is using (which is REAL `now`, not the
    // helper-test NOW pin — the route uses new Date()). We use that
    // week_start as the dismissal's payload_id.
    const r1 = await fetch(b.base + "/api/fleet/biggest-surprise");
    assert.equal(r1.status, 200);
    const j1 = await r1.json() as FleetBiggestSurprise & { dismissed?: boolean };
    const weekStart = j1.week_start_iso;
    assert.ok(weekStart, "the route must surface a week_start_iso");
    // Pre-dismissal: the dismissed flag is false.
    assert.equal(j1.dismissed, false,
      "pre-dismissal: the route must surface dismissed=false");

    // POST a dismissal with kind='biggest_surprise' and
    // payload_id=week_start_iso (the AC's documented shape).
    const dr = await fetch(b.base + "/api/fleet/inbox/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "biggest_surprise",
        project_slug: "fleet",
        payload_id: weekStart,
      }),
    });
    assert.equal(dr.status, 200, `dismiss must accept 'biggest_surprise' kind; got ${dr.status}`);
    const dj = await dr.json() as { ok: boolean };
    assert.equal(dj.ok, true);

    // Confirm the inbox_dismissal row landed via SQLite.
    const tdb = openDb(b.dbPath);
    try {
      const row = tdb.prepare(
        "SELECT kind, project_slug, payload_id FROM inbox_dismissal "
        + " WHERE kind = ? AND project_slug = ? AND payload_id = ?",
      ).get("biggest_surprise", "fleet", weekStart) as {
        kind: string; project_slug: string; payload_id: string;
      } | undefined;
      assert.ok(row, "inbox_dismissal MUST carry the dismissal row");
      assert.equal(row!.kind, "biggest_surprise");
      assert.equal(row!.project_slug, "fleet");
      assert.equal(row!.payload_id, weekStart);
    } finally { tdb.close(); }

    // GET again — the route must surface `dismissed: true`. Bust
    // the in-process memo so the next GET re-reads the dismissal.
    _resetBiggestSurpriseCacheForTests();
    const r2 = await fetch(b.base + "/api/fleet/biggest-surprise");
    const j2 = await r2.json() as FleetBiggestSurprise & { dismissed?: boolean };
    assert.equal(j2.dismissed, true,
      "after POST dismiss the next GET must surface dismissed=true");
  } finally { await b.close(); b.cleanup(); }

  // The home SPA renders a card section with the documented testid.
  assert.match(APP_JS, /data-testid=["']biggest-surprise-card["']/,
    "web/app.js MUST render an element with data-testid='biggest-surprise-card'");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Monday-hide branch via renderer-direct seam.
// ────────────────────────────────────────────────────────────────────

test("AC9: Monday-hide branch — renderer returns empty when today='monday'", () => {
  const synthetic: FleetBiggestSurprise = {
    generated_at: MONDAY_NOW.toISOString(),
    week_start_iso: "2026-06-08",
    week_end_iso: "2026-06-14",
    kind: "silent_project",
    sentence: "alpha went quiet this week - 0 PRs merged after 4 weeks averaging 5.",
    metric_label: "PRs/week",
    metric_baseline: "avg 5",
    metric_this_week: "0",
    deep_link: "/projects/alpha",
    candidate_project_slug: "alpha",
  };
  const body = _renderBiggestSurpriseForTests(synthetic, { today: "monday" });
  assert.equal(
    body, "",
    "Monday-hide branch must emit an empty string so the SPA renders nothing",
  );
});

test("AC9: non-Monday renders the card with the documented testid", () => {
  const synthetic: FleetBiggestSurprise = {
    generated_at: NOW.toISOString(),
    week_start_iso: THIS_WEEK_START,
    week_end_iso: THIS_WEEK_END,
    kind: "silent_project",
    sentence: "alpha went quiet this week - 0 PRs merged after 4 weeks averaging 5.",
    metric_label: "PRs/week",
    metric_baseline: "avg 5",
    metric_this_week: "0",
    deep_link: "/projects/alpha",
    candidate_project_slug: "alpha",
  };
  const body = _renderBiggestSurpriseForTests(synthetic, { today: "tuesday" });
  assert.match(body, /data-testid=["']biggest-surprise-card["']/,
    "non-Monday render must emit data-testid='biggest-surprise-card'");
  assert.match(body, /alpha went quiet/,
    "the sentence must be visible in the rendered card");
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Empty-fleet honest empty state (< 8 weeks of data).
// ────────────────────────────────────────────────────────────────────

test("AC10: <8 weeks of pr data → kind='none' with the warming-up sentence", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetBiggestSurpriseCacheForTests();
    const pid = seedProject(db, "fresh", "Fresh");
    // Only 4 weeks of data — not yet 8.
    for (let w = 1; w <= 4; w++) {
      const day = new Date(NOW.getTime() - w * 7 * 24 * 3600_000);
      const iso = day.toISOString().slice(0, 10);
      seedPr(db, { projectId: pid, number: w, fetchedAt: iso + "T08:00:00.000Z" });
    }
    const v = fleetBiggestSurprise(db, { now: NOW });
    assert.equal(v.kind, "none");
    assert.match(
      v.sentence,
      /warming up|still warming/i,
      "warming-up empty state must be honest and explicit per the spec",
    );
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC11 — Mobile viewport: 375px stacks metric beneath sentence;
//        >=600px right-aligns metric inline. Renderer-direct seam.
// ────────────────────────────────────────────────────────────────────

test("AC11: CSS contract — .biggest-surprise-card stacks metric on narrow viewport and inlines at >=600px", () => {
  // The card's stats container stacks on narrow viewports and inlines
  // on >=600px. We assert both shapes exist in the CSS source.
  assert.match(CSS, /\.biggest-surprise-card\b/,
    "web/style.css must declare a .biggest-surprise-card selector");
  // Narrow override: a max-width: (599|600)px block must declare the
  // stacked column layout for the card's metric region OR the card
  // itself.
  const narrow = CSS.match(/@media\s*\(\s*max-width:\s*(?:599|600)px\s*\)\s*\{[\s\S]*?\.biggest-surprise-(?:card|metric)[\s\S]*?\}/);
  assert.ok(narrow,
    "@media (max-width: 599px|600px) must scope a stacked layout for the biggest-surprise card");
  // Wide override: a min-width: 600px block must restore the inline /
  // right-aligned shape.
  const wide = CSS.match(/@media\s*\(\s*min-width:\s*600px\s*\)\s*\{[\s\S]*?\.biggest-surprise-(?:card|metric)[\s\S]*?\}/);
  assert.ok(wide,
    "@media (min-width: 600px) must restore the inline / right-aligned biggest-surprise layout");
});

// ────────────────────────────────────────────────────────────────────
// AC12 — Zero new runtime deps; no schema migration; tsc-clean; the
//        new route is net-new (no JSON-shape break).
// ────────────────────────────────────────────────────────────────────

test("AC12: package.json carries no new runtime dependencies", () => {
  const pkg = JSON.parse(PKG_JSON) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    "ticket 0059 MUST add ZERO runtime dependencies; package.json `dependencies` must stay empty");
});

test("AC12: src/views.ts new helper avoids backticked SQL strings + sibling-grep poison patterns", () => {
  const idx = VIEWS_TS.indexOf("fleetBiggestSurprise");
  assert.notEqual(idx, -1, "src/views.ts must export fleetBiggestSurprise");
  // The helper must compose existing SQL via string concatenation,
  // never a backtick template literal containing SQL keywords. This
  // is the LESSONS 2026-05-26 "no backticks inside template-literal
  // SQL strings" guard applied to the new helper. We slice a window
  // from the helper's name and grep for the disallowed shape.
  const slice = VIEWS_TS.slice(idx, idx + 6000);
  const inBackticks = slice.match(/`[\s\S]*?(SELECT|FROM|WHERE|GROUP BY|ORDER BY)[\s\S]*?`/i);
  assert.equal(inBackticks, null,
    "fleetBiggestSurprise must not embed SQL keywords inside a backtick template literal");
});
