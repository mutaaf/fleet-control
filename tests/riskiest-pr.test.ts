// Tests for ticket 0040 — Riskiest open PR badge.
//
// One test(...) per acceptance-criteria checkbox. Strategy mirrors the
// 0037 friday-wrap suite (tests/friday-wrap.test.ts) and the 0033 glance
// suite:
//   - Drive `riskiestOpenPr(db, now)` and `classifyPrFailure(db, ...)`
//     directly against a tmpdir DB for shape, score arithmetic,
//     fail-kind classification, and age-clamp tests.
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
// by importing riskiestOpenPr — if the cast regresses tsc fails before
// this file runs).
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
  riskiestOpenPr, classifyPrFailure, type RiskiestOpenPr,
} from "../src/views.ts";
import {
  startServer,
  _resetRiskiestPrCacheForTests,
  _getRiskiestPrCacheBuildsForTests,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers — pinned-now seeders.
// ────────────────────────────────────────────────────────────────────

// Pinned wall-clock anchor for every seed. Same anchor as the friday-wrap
// suite for cross-test consistency.
const NOW = new Date("2026-06-05T12:00:00.000Z");

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-riskiest-"));
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
  projectId: number;
  number: number;
  title?: string;
  state?: string; // defaults to 'open' (lowercase — matches the production ingester)
  ciState?: string; // 'red' | 'pending' | 'green' | 'none'
  isAgent?: number; // 1 by default
  fetchedAt: string; // ISO; used as "age anchor" per the ticket
  firstFailCheck?: string | null;
  healAttempts?: number;
  additions?: number;
  deletions?: number;
}
function seedPr(db: DB, opts: PrSeed): void {
  db.prepare(
    "INSERT INTO pr("
    + "project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
    + "additions,deletions,author,url,fetched_at,gh_created_at,"
    + "first_fail_check,first_fail_excerpt,heal_attempts"
    + ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, opts.title ?? `pr-${opts.number}`,
    `feat/${opts.number}`,
    opts.state ?? "open",
    opts.ciState ?? "green",
    null,
    opts.isAgent ?? 1,
    opts.additions ?? 0, opts.deletions ?? 0,
    "a", `https://github.com/owner/x/pull/${opts.number}`,
    opts.fetchedAt, opts.fetchedAt,
    opts.firstFailCheck ?? null, null,
    opts.healAttempts ?? 0,
  );
}

/** Seed a control_audit row for a heal attempt against a given PR.
 *  `target` matches the convention `pr-<number>` from the ticket. */
function seedHealAudit(db: DB, opts: {
  ts: string; prNumber: number; stdoutTail: string;
}): void {
  db.prepare(
    "INSERT INTO control_audit(ts,actor,action,target,args_json,exit_code,stdout_tail)"
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(
    opts.ts, "ship", "heal", `pr-${opts.prNumber}`, "{}", 1, opts.stdoutTail,
  );
}

/** ISO timestamp `h` hours BEFORE the pinned NOW. */
function hoursBeforeNow(h: number): string {
  return new Date(NOW.getTime() - h * 3600_000).toISOString();
}

// ────────────────────────────────────────────────────────────────────
// AC1 — riskiestOpenPr returns the documented shape; the top row wins
//        on score DESC, tiebreak age DESC; open_count + all_healthy
//        edge cases honoured.
// ────────────────────────────────────────────────────────────────────

test("AC1: riskiestOpenPr picks the highest-score PR among 4 open agent PRs", () => {
  const { db, cleanup } = tempDb();
  try {
    const courtiq = seedProject(db, "courtiq", "Courtiq");
    const fleet = seedProject(db, "fleet", "Fleet");
    // PR #312 — 2 heals + infra_flake (supabase port-bind) + 18h old:
    //   score = 8 + 1 + 3 = 12
    seedPr(db, { projectId: courtiq, number: 312, fetchedAt: hoursBeforeNow(18),
      ciState: "red", healAttempts: 2, firstFailCheck: "e2e-tests" });
    seedHealAudit(db, { ts: hoursBeforeNow(2), prNumber: 312,
      stdoutTail: "supabase start failed to bind host port for 0.0.0.0:54322" });
    // PR #301 — 1 heal + red_test (no infra match) + 4h old:
    //   score = 4 + 3 + 0 = 7
    seedPr(db, { projectId: courtiq, number: 301, fetchedAt: hoursBeforeNow(4),
      ciState: "red", healAttempts: 1, firstFailCheck: "unit-tests" });
    seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 301,
      stdoutTail: "AssertionError: expected 5 to equal 6" });
    // PR #88 — 0 heals + green + 72h old: score = 0 + 0 + 12 = 12
    // tiebreak: same score 12 as #312, older (72h vs 18h) wins by age DESC.
    seedPr(db, { projectId: fleet, number: 88, fetchedAt: hoursBeforeNow(72),
      ciState: "green", healAttempts: 0 });
    // PR #50 — 0 heals + green + 1h old: score = 0 + 0 + 0 = 0
    seedPr(db, { projectId: fleet, number: 50, fetchedAt: hoursBeforeNow(1),
      ciState: "green", healAttempts: 0 });

    const result = riskiestOpenPr(db, NOW);
    assert.equal(result.open_count, 4, `open_count=${result.open_count}`);
    assert.equal(result.all_healthy, false, "all_healthy must be false when scores > 0");
    assert.ok(result.top, "top must be populated");
    // #88 wins by tiebreak (older).
    assert.equal(result.top!.pr_number, 88,
      `expected #88 (score 12, 72h old) to win tiebreak vs #312 (score 12, 18h old)`);
    assert.equal(result.top!.project_slug, "fleet");
    assert.equal(result.top!.score, 12);
    assert.equal(result.top!.fail_kind, "green");
    assert.equal(result.top!.heal_attempts, 0);
    assert.equal(result.top!.age_hours, 72);
    assert.ok(result.generated_at && /^\d{4}-\d{2}-\d{2}T/.test(result.generated_at));
  } finally { cleanup(); }
});

test("AC1: riskiestOpenPr returns empty payload when zero open PRs exist", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "alpha");
    const result = riskiestOpenPr(db, NOW);
    assert.equal(result.open_count, 0);
    assert.equal(result.all_healthy, false);
    assert.equal(result.top, null);
  } finally { cleanup(); }
});

test("AC1: riskiestOpenPr returns all_healthy=true when every open PR has score 0", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    // Three brand-new, green, no-heal PRs all under 6h old → each scores 0.
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(1), ciState: "green" });
    seedPr(db, { projectId: p, number: 2, fetchedAt: hoursBeforeNow(2), ciState: "pending" });
    seedPr(db, { projectId: p, number: 3, fetchedAt: hoursBeforeNow(5), ciState: "green" });
    const result = riskiestOpenPr(db, NOW);
    assert.equal(result.open_count, 3);
    assert.equal(result.all_healthy, true, "all_healthy must be true when every score is 0");
    assert.equal(result.top, null, "top must be null in the all-healthy branch");
  } finally { cleanup(); }
});

test("AC1: riskiestOpenPr ignores non-agent PRs entirely", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    // A non-agent PR with a "high score" shape must NOT appear at all.
    seedPr(db, { projectId: p, number: 9, fetchedAt: hoursBeforeNow(96),
      ciState: "red", healAttempts: 5, isAgent: 0 });
    seedPr(db, { projectId: p, number: 10, fetchedAt: hoursBeforeNow(1),
      ciState: "green", healAttempts: 0, isAgent: 1 });
    const result = riskiestOpenPr(db, NOW);
    assert.equal(result.open_count, 1, "non-agent rows must not count toward open_count");
    assert.equal(result.all_healthy, true);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — Score arithmetic: heal_attempts * 4 + fail_kind_weight +
//        Math.floor(age_hours / 6). Deterministic; the score is on
//        the returned row so the test asserts the integer.
// ────────────────────────────────────────────────────────────────────

test("AC2: score = 2 heals + red_test + 18h → 8 + 3 + 3 = 14", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(18),
      ciState: "red", healAttempts: 2, firstFailCheck: "unit-tests" });
    seedHealAudit(db, { ts: hoursBeforeNow(2), prNumber: 1,
      stdoutTail: "TypeError: cannot read property foo" });
    const result = riskiestOpenPr(db, NOW);
    assert.ok(result.top);
    assert.equal(result.top!.score, 14, `expected 14, got ${result.top!.score}`);
    assert.equal(result.top!.fail_kind, "red_test");
    assert.equal(result.top!.heal_attempts, 2);
    assert.equal(result.top!.age_hours, 18);
  } finally { cleanup(); }
});

test("AC2: score = 0 heals + green + 24h → 0 + 0 + 4 = 4", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(24),
      ciState: "green", healAttempts: 0 });
    const result = riskiestOpenPr(db, NOW);
    assert.ok(result.top);
    assert.equal(result.top!.score, 4, `expected 4, got ${result.top!.score}`);
    assert.equal(result.top!.fail_kind, "green");
  } finally { cleanup(); }
});

test("AC2: score arithmetic for 1 heal + infra_flake + 6h → 4 + 1 + 1 = 6", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(6),
      ciState: "red", healAttempts: 1, firstFailCheck: "e2e-tests" });
    seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 1,
      stdoutTail: "Error response from daemon: address already in use" });
    const result = riskiestOpenPr(db, NOW);
    assert.ok(result.top);
    assert.equal(result.top!.fail_kind, "infra_flake");
    assert.equal(result.top!.score, 6, `expected 6, got ${result.top!.score}`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — Fail-kind classification. Reads the latest heal-audit row for
//        scan; falls back to pr.ci_state.
// ────────────────────────────────────────────────────────────────────

test("AC3: classifyPrFailure detects 'address already in use' as infra_flake", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(2), ciState: "red" });
    seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 1,
      stdoutTail: "Error: bind: address already in use\n  at server.listen" });
    const out = classifyPrFailure(db, p, 1);
    assert.equal(out.kind, "infra_flake");
    assert.ok(out.detail && /address already in use/i.test(out.detail));
  } finally { cleanup(); }
});

test("AC3: classifyPrFailure detects 'account is suspended' as infra_flake", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(2), ciState: "red" });
    seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 1,
      stdoutTail: "remote: Your account is suspended. Please visit https://support.github.com" });
    const out = classifyPrFailure(db, p, 1);
    assert.equal(out.kind, "infra_flake");
    assert.ok(out.detail && /account is suspended/i.test(out.detail));
  } finally { cleanup(); }
});

test("AC3: classifyPrFailure detects supabase port-bind as infra_flake", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(2), ciState: "red" });
    seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 1,
      stdoutTail: "supabase start: failed to bind host port for 0.0.0.0:54322" });
    const out = classifyPrFailure(db, p, 1);
    assert.equal(out.kind, "infra_flake");
    assert.ok(out.detail && /supabase/i.test(out.detail));
  } finally { cleanup(); }
});

test("AC3: classifyPrFailure detects '502 Bad Gateway' as infra_flake", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(2), ciState: "red" });
    seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 1,
      stdoutTail: "HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)" });
    const out = classifyPrFailure(db, p, 1);
    assert.equal(out.kind, "infra_flake");
    assert.ok(out.detail && /502 bad gateway/i.test(out.detail));
  } finally { cleanup(); }
});

test("AC3: classifyPrFailure detects actions/checkout 403 as infra_flake", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(2), ciState: "red" });
    seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 1,
      stdoutTail: "Run actions/checkout@v4 ... remote: 403 forbidden" });
    const out = classifyPrFailure(db, p, 1);
    assert.equal(out.kind, "infra_flake");
    assert.ok(out.detail);
  } finally { cleanup(); }
});

test("AC3: classifyPrFailure falls back to red_test for a plain heal-audit + red ci_state", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(2),
      ciState: "red", firstFailCheck: "unit-tests" });
    seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 1,
      stdoutTail: "FAIL src/foo.test.ts > expected 1 to equal 2" });
    const out = classifyPrFailure(db, p, 1);
    assert.equal(out.kind, "red_test");
    assert.equal(out.detail, "unit-tests");
  } finally { cleanup(); }
});

test("AC3: classifyPrFailure returns red_test from pr.ci_state when no heal-audit row exists", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(2),
      ciState: "red", firstFailCheck: "lint" });
    const out = classifyPrFailure(db, p, 1);
    assert.equal(out.kind, "red_test");
    assert.equal(out.detail, "lint");
  } finally { cleanup(); }
});

test("AC3: classifyPrFailure returns green for a SUCCESS ci_state with no heal-audit", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(2), ciState: "green" });
    const out = classifyPrFailure(db, p, 1);
    assert.equal(out.kind, "green");
    assert.equal(out.detail, null);
  } finally { cleanup(); }
});

test("AC3: classifyPrFailure returns green for PENDING ci_state", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(2), ciState: "pending" });
    const out = classifyPrFailure(db, p, 1);
    assert.equal(out.kind, "green");
  } finally { cleanup(); }
});

test("AC3: classifyPrFailure returns red_check_unknown for an unknown ci_state with no heal-audit", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(2), ciState: "none" });
    const out = classifyPrFailure(db, p, 1);
    assert.equal(out.kind, "red_check_unknown");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — Age computation: age_hours = (now - pr.fetched_at)/3600000,
//        floored; clock-skew clamps to 0.
// ────────────────────────────────────────────────────────────────────

test("AC4: age_hours = 18 when fetched_at is exactly 18h before now", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(18), ciState: "green" });
    const result = riskiestOpenPr(db, NOW);
    assert.ok(result.top);
    assert.equal(result.top!.age_hours, 18);
  } finally { cleanup(); }
});

test("AC4: age_hours clamps to 0 when pr.fetched_at is in the future (clock skew)", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    const future = new Date(NOW.getTime() + 4 * 3600_000).toISOString();
    seedPr(db, { projectId: p, number: 1, fetchedAt: future, ciState: "green" });
    const result = riskiestOpenPr(db, NOW);
    // PR is in the future → age 0 → score 0 → all_healthy=true / top=null.
    assert.equal(result.open_count, 1);
    assert.equal(result.all_healthy, true,
      "future fetched_at must clamp age to 0 so score stays 0 and all_healthy stays true");
    assert.equal(result.top, null);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — GET /api/fleet/riskiest-pr — auth, four-PR populated case, zero
//        open PRs, all-healthy.
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
  const dir = mkdtempSync(join(tmpdir(), "fleet-riskiest-boot-"));
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

test("AC5: GET /api/fleet/riskiest-pr on loopback returns 200 with top populated when an at-risk agent PR exists", async () => {
  _resetRiskiestPrCacheForTests();
  const b = await boot((db) => {
    const p = seedProject(db, "courtiq", "Courtiq");
    seedPr(db, { projectId: p, number: 312, fetchedAt: new Date(Date.now() - 18 * 3600_000).toISOString(),
      ciState: "red", healAttempts: 2, firstFailCheck: "e2e-tests" });
    seedHealAudit(db, { ts: new Date(Date.now() - 1 * 3600_000).toISOString(), prNumber: 312,
      stdoutTail: "supabase start: failed to bind host port for 0.0.0.0:54322" });
  });
  try {
    const r = await fetch(b.base + "/api/fleet/riskiest-pr");
    assert.equal(r.status, 200);
    const j = await r.json() as RiskiestOpenPr;
    assert.equal(j.open_count, 1);
    assert.ok(j.top, "top must be populated");
    assert.equal(j.top!.project_slug, "courtiq");
    assert.equal(j.top!.pr_number, 312);
    assert.equal(j.top!.fail_kind, "infra_flake");
  } finally { await b.close(); b.cleanup(); }
});

test("AC5: GET /api/fleet/riskiest-pr returns 200 with top:null + open_count:0 when no PRs exist", async () => {
  _resetRiskiestPrCacheForTests();
  const b = await boot((db) => { seedProject(db, "quiet"); });
  try {
    const r = await fetch(b.base + "/api/fleet/riskiest-pr");
    assert.equal(r.status, 200);
    const j = await r.json() as RiskiestOpenPr;
    assert.equal(j.open_count, 0);
    assert.equal(j.top, null);
    assert.equal(j.all_healthy, false);
  } finally { await b.close(); b.cleanup(); }
});

test("AC5: GET /api/fleet/riskiest-pr returns top:null + all_healthy:true when every open PR scores 0", async () => {
  _resetRiskiestPrCacheForTests();
  const b = await boot((db) => {
    const p = seedProject(db, "calm");
    seedPr(db, { projectId: p, number: 1, fetchedAt: new Date(Date.now() - 1 * 3600_000).toISOString(),
      ciState: "green" });
    seedPr(db, { projectId: p, number: 2, fetchedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
      ciState: "pending" });
  });
  try {
    const r = await fetch(b.base + "/api/fleet/riskiest-pr");
    assert.equal(r.status, 200);
    const j = await r.json() as RiskiestOpenPr;
    assert.equal(j.open_count, 2);
    assert.equal(j.all_healthy, true);
    assert.equal(j.top, null);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Caching: max-age=30 header + module-level memo via the
//        (open_pr_count_snapshot, latest_heal_ts_snapshot) tuple.
//        Inserting a new heal-audit row invalidates the cache.
// ────────────────────────────────────────────────────────────────────

test("AC6: GET /api/fleet/riskiest-pr sets cache-control: max-age=30 and memoises via a build counter", async () => {
  _resetRiskiestPrCacheForTests();
  const b = await boot((db) => {
    const p = seedProject(db, "cached");
    seedPr(db, { projectId: p, number: 1, fetchedAt: new Date(Date.now() - 12 * 3600_000).toISOString(),
      ciState: "green" });
  });
  try {
    const before = _getRiskiestPrCacheBuildsForTests();
    const r1 = await fetch(b.base + "/api/fleet/riskiest-pr");
    assert.equal(r1.status, 200);
    const cc = (r1.headers.get("cache-control") ?? "").toLowerCase();
    assert.match(cc, /max-age=30/, `cache-control must declare max-age=30; got '${cc}'`);
    await r1.json();
    const afterFirst = _getRiskiestPrCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call → cache MISS, build counter += 1");

    const r2 = await fetch(b.base + "/api/fleet/riskiest-pr");
    assert.equal(r2.status, 200);
    await r2.json();
    const afterSecond = _getRiskiestPrCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0,
      "second call within the cache window → cache HIT, counter unchanged");

    // Insert a new heal-audit row. The cache invalidation tuple (which
    // includes MAX(control_audit.ts) for action='heal') must change,
    // forcing the next call to rebuild.
    const db2 = openDb(b.dbPath);
    try {
      db2.prepare(
        "INSERT INTO control_audit(ts,actor,action,target,args_json,exit_code,stdout_tail)"
        + " VALUES(?,?,?,?,?,?,?)",
      ).run(new Date().toISOString(), "ship", "heal", "pr-1", "{}", 1, "anything");
    } finally { db2.close(); }

    const r3 = await fetch(b.base + "/api/fleet/riskiest-pr");
    assert.equal(r3.status, 200);
    await r3.json();
    const afterThird = _getRiskiestPrCacheBuildsForTests();
    assert.equal(afterThird - afterSecond, 1,
      "after a new heal-audit row lands, next call rebuilds → counter += 1");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — web/app.js renders the badge on the home page; emits data-
//        testid="riskiest-pr"; fetches /api/fleet/riskiest-pr; uses
//        redactSecrets on operator-visible strings; returns "" when
//        open_count===0.
// ────────────────────────────────────────────────────────────────────

test("AC7: web/app.js defines renderRiskiestPr and emits data-testid=riskiest-pr; fetches the route; redacts secrets", () => {
  assert.match(APP_JS, /function\s+renderRiskiestPr\s*\(/,
    "web/app.js must declare a renderRiskiestPr helper");
  assert.match(APP_JS, /data-testid="riskiest-pr"/,
    "the badge must carry data-testid=\"riskiest-pr\" for stable phone-test hooks");
  assert.match(APP_JS, /\/api\/fleet\/riskiest-pr/,
    "web/app.js must fetch the new /api/fleet/riskiest-pr route");
  // The label + fail-detail strings must pass through redactSecrets.
  const renderFn = APP_JS.match(/function\s+renderRiskiestPr\s*\([\s\S]*?\n\}/);
  assert.ok(renderFn, "renderRiskiestPr function body must be parseable");
  assert.match(renderFn![0], /redactSecrets\(/,
    "renderRiskiestPr must route operator-visible strings through redactSecrets");
  // Empty branch: returns "" so no DOM is emitted when open_count===0.
  assert.match(renderFn![0], /return\s*""|return\s*''/,
    "renderRiskiestPr must return an empty string when open_count===0");
  // home() composition wires it in.
  const homeBodyMatch = APP_JS.match(/async\s+function\s+home\s*\(\s*\)[\s\S]*?app\.innerHTML\s*=\s*[\s\S]*?renderInbox/);
  assert.ok(homeBodyMatch, "home() must include a renderInbox call");
  const homeBody = homeBodyMatch![0];
  assert.ok(homeBody.indexOf("renderRiskiestPr") > -1,
    "home() must reference renderRiskiestPr in its app.innerHTML composition");
});

test("AC7: renderRiskiestPr emits the 'all healthy' branch text when all_healthy:true and open_count>0", () => {
  const renderFn = APP_JS.match(/function\s+renderRiskiestPr\s*\([\s\S]*?\n\}/);
  assert.ok(renderFn);
  // The "Open PRs (N): all healthy" branch surfaces an /inbox link.
  assert.match(renderFn![0], /all.healthy|all_healthy/i,
    "renderRiskiestPr must handle the all_healthy:true branch");
  assert.match(renderFn![0], /#inbox|#\/inbox/,
    "renderRiskiestPr must link the all-healthy branch to the inbox");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Project page anchor: ?pr=<number> in the URL hash adds the
//        pr-card-flash highlight class to the matching PR card.
// ────────────────────────────────────────────────────────────────────

test("AC8: project page scrolls + highlights the matching PR card when ?pr=<n> is on the URL", () => {
  // The renderer must read params.get("pr") inside project() and (when
  // present) attach the pr-card-flash class to the matching card. We
  // grep for the class name + the params lookup; full DOM exercise
  // happens in mobile-portal text-level tests when stable.
  assert.match(APP_JS, /pr-card-flash/,
    "web/app.js must reference the pr-card-flash highlight class");
  assert.match(APP_JS, /params(\.get\(\s*["']pr["']\s*\)|\.has\(\s*["']pr["']\s*\))/,
    "project() must read params.get(\"pr\") to drive the highlight");
  // The CSS must define the pr-card-flash class with a fade rule.
  assert.match(CSS, /\.pr-card-flash\b/,
    "style.css must define a .pr-card-flash selector");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Mobile / >=600px layout. Single line at >=600px; wraps to two
//        lines at 375px.
// ────────────────────────────────────────────────────────────────────

test("AC9: web/style.css declares a .riskiest-pr selector group with a 600px breakpoint single-row layout", () => {
  assert.match(CSS, /\.riskiest-pr\b/,
    "style.css must define a .riskiest-pr rule group");
  // The mobile breakpoint (>= 600px) must place the badge text + the
  // tend-it-now link on one row.
  const all600 = CSS.match(/@media\s*\([^)]*min-width:\s*600px[^)]*\)\s*\{[\s\S]*?\n\}/g) || [];
  const matchingBlock = all600.find((b) => /\.riskiest-pr/.test(b));
  assert.ok(matchingBlock,
    "A @media (min-width: 600px) block must target .riskiest-pr");
});

// ────────────────────────────────────────────────────────────────────
// AC10 — Quiet-hours integration. Hidden when quiet hours active AND
//         fail_kind is infra_flake. Always visible for red_test /
//         red_check_unknown / green.
// ────────────────────────────────────────────────────────────────────

test("AC10: riskiestOpenPr accepts a quiet-hours-active flag and hides the badge when fail_kind=infra_flake", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(18),
      ciState: "red", healAttempts: 1, firstFailCheck: "e2e-tests" });
    seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 1,
      stdoutTail: "supabase start: failed to bind host port for 0.0.0.0:54322" });
    // No-quiet-hours: badge surfaces normally.
    const open = riskiestOpenPr(db, NOW, { quietHoursActive: false });
    assert.ok(open.top);
    assert.equal(open.top!.fail_kind, "infra_flake");
    // Quiet hours active + infra_flake → suppressed.
    const quiet = riskiestOpenPr(db, NOW, { quietHoursActive: true });
    assert.equal(quiet.top, null,
      "infra_flake top must be suppressed when quietHoursActive is true");
    // open_count should still reflect the underlying count so the
    // SPA's all_healthy / count text remains honest.
    assert.equal(quiet.open_count, 1);
  } finally { cleanup(); }
});

test("AC10: red_test top is NOT suppressed during quiet hours (critical kinds always surface)", () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "alpha");
    seedPr(db, { projectId: p, number: 1, fetchedAt: hoursBeforeNow(18),
      ciState: "red", healAttempts: 1, firstFailCheck: "unit-tests" });
    seedHealAudit(db, { ts: hoursBeforeNow(1), prNumber: 1,
      stdoutTail: "AssertionError: expected 5 to equal 6" });
    const quiet = riskiestOpenPr(db, NOW, { quietHoursActive: true });
    assert.ok(quiet.top, "red_test top must survive quiet hours");
    assert.equal(quiet.top!.fail_kind, "red_test");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC11 — Performance. PERF=1 only. < 25ms for the helper over 50 open
//         PRs with 10 heal-audit rows each.
// ────────────────────────────────────────────────────────────────────

test("AC11: perf — riskiestOpenPr completes < 25ms on 50 open PRs × 10 heal audits each", { skip: process.env.PERF !== "1" }, () => {
  const { db, cleanup } = tempDb();
  try {
    const p = seedProject(db, "perf");
    for (let i = 0; i < 50; i++) {
      seedPr(db, { projectId: p, number: 1000 + i,
        fetchedAt: hoursBeforeNow(i + 1),
        ciState: i % 3 === 0 ? "red" : "green",
        healAttempts: i % 4 });
      for (let j = 0; j < 10; j++) {
        seedHealAudit(db, {
          ts: hoursBeforeNow(0.1 * (j + 1)),
          prNumber: 1000 + i,
          stdoutTail: j === 0 ? "address already in use" : "real test failure",
        });
      }
    }
    const t1 = Date.now();
    riskiestOpenPr(db, NOW);
    const dt = Date.now() - t1;
    assert.ok(dt < 25, `riskiestOpenPr must finish <25ms; took ${dt}ms`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC12 — No new runtime deps.
// ────────────────────────────────────────────────────────────────────

test("AC12: package.json dependencies stays empty (zero runtime deps)", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    "package.json `dependencies` must remain empty (Hard NO in AGENTS.md)");
});
