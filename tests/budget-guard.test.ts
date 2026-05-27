// Unit tests for src/budget_guard.ts — the soft daily-budget autopause
// guard (ticket 0021). Each test maps 1:1 to one acceptance-criteria
// checkbox in docs/backlog/0021-soft-budget-autopause.md.
//
// Strategy: seed `project` rows whose `cadence_json` carries (or omits)
// `max_daily_usd`, then seed `cost_rollup_day` rows for today against
// them. The guard reads from those two surfaces. Pause side-effects
// (launchctl bootout) flow through the `_setRunnerForTests` seam in
// src/control.ts — same shape as 0010 / 0016 / 0020. The ntfy push
// is asserted via the existing `setHttpsRequest` seam in src/ntfy.ts.
//
// Zero new deps; stdlib + node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { openDb, type DB } from "../src/db.ts";
import {
  evaluateBudgetGuards,
  _setRunnerForTests as _setGuardRunnerForTests,
  _resetRunnerForTests as _resetGuardRunnerForTests,
} from "../src/budget_guard.ts";
import { _setRunnerForTests, _resetRunnerForTests } from "../src/control.ts";
import {
  setHttpsRequest, resetHttpsRequest, _resetDedupForTests,
  type HttpsLikeRequest,
} from "../src/ntfy.ts";

interface Captured { cmd: string; args: string[]; }

function tempDb(): { db: DB; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-budget-"));
  // install.sh shell-out used by resume — point HOME at the tmpdir so a
  // missing kit doesn't matter (the runner is stubbed anyway).
  const db = openDb(join(dir, "fleet.db"));
  return {
    db, dir,
    cleanup: () => {
      try { db.close(); } catch { /* */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedProject(
  db: DB,
  slug: string,
  cadence: Record<string, string> = {},
): number {
  db.prepare(
    "INSERT INTO project(slug,name,namespace,repo_owner,repo_name,cadence_json,manifest_path) VALUES(?,?,?,?,?,?,?)",
  ).run(slug, slug, `com.${slug}`, "owner", slug, JSON.stringify(cadence), `/tmp/${slug}/agents.config.sh`);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

function seedRollupToday(
  db: DB, projectId: number, costUsd: number, day?: string,
): void {
  const d = day ?? new Date().toISOString().slice(0, 10);
  db.prepare(
    "INSERT INTO cost_rollup_day(project_id,phase,day,runs,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(projectId, "ship", d, 1, 0, 0, 0, 0, costUsd);
}

const TODAY = new Date().toISOString().slice(0, 10);

// ────────────────────────────────────────────────────────────────────
// AC2 — evaluateBudgetGuards returns one row per over-cap project
// ────────────────────────────────────────────────────────────────────

test("AC2: evaluateBudgetGuards returns one row per project whose today-spend ≥ MAX_DAILY_USD", () => {
  const t = tempDb();
  try {
    const overId = seedProject(t.db, "over", { max_daily_usd: "5" });
    const underId = seedProject(t.db, "under", { max_daily_usd: "10" });
    seedRollupToday(t.db, overId, 6.0);
    seedRollupToday(t.db, underId, 1.0);

    const rows = evaluateBudgetGuards(t.db, new Date());
    assert.equal(rows.length, 1, "exactly one row should be over the cap");
    assert.equal(rows[0].slug, "over");
    assert.equal(rows[0].project_id, overId);
    assert.ok(rows[0].spent_usd >= 5);
    assert.equal(rows[0].cap_usd, 5);
    assert.equal(rows[0].prior_paused, false);
  } finally { t.cleanup(); }
});

test("AC2: a project at exactly the cap is OVER (>=, not >)", () => {
  const t = tempDb();
  try {
    const pid = seedProject(t.db, "atcap", { max_daily_usd: "5" });
    seedRollupToday(t.db, pid, 5.0);
    const rows = evaluateBudgetGuards(t.db, new Date());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].slug, "atcap");
  } finally { t.cleanup(); }
});

test("AC9 (safety): project with unset MAX_DAILY_USD is never returned, even on huge spend", () => {
  const t = tempDb();
  try {
    const pid = seedProject(t.db, "noop", { /* no max_daily_usd */ });
    seedRollupToday(t.db, pid, 9999);
    const rows = evaluateBudgetGuards(t.db, new Date());
    assert.equal(rows.length, 0, "no cap → never paused");
  } finally { t.cleanup(); }
});

test("AC9 (safety): MAX_DAILY_USD=0 / non-numeric / negative → never paused", () => {
  const t = tempDb();
  try {
    const p1 = seedProject(t.db, "zero", { max_daily_usd: "0" });
    const p2 = seedProject(t.db, "junk", { max_daily_usd: "abc" });
    const p3 = seedProject(t.db, "neg", { max_daily_usd: "-5" });
    seedRollupToday(t.db, p1, 100);
    seedRollupToday(t.db, p2, 100);
    seedRollupToday(t.db, p3, 100);
    const rows = evaluateBudgetGuards(t.db, new Date());
    assert.equal(rows.length, 0, "zero/junk/negative caps are opt-outs");
  } finally { t.cleanup(); }
});

test("AC2: rollups from a prior day do NOT count against today's spend", () => {
  const t = tempDb();
  try {
    const pid = seedProject(t.db, "yest", { max_daily_usd: "5" });
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    seedRollupToday(t.db, pid, 100, yesterday); // big spend, but yesterday
    seedRollupToday(t.db, pid, 1, TODAY);       // today is under
    const rows = evaluateBudgetGuards(t.db, new Date());
    assert.equal(rows.length, 0, "only today's rollup counts");
  } finally { t.cleanup(); }
});

test("AC2: today's spend is summed across phases", () => {
  const t = tempDb();
  try {
    const pid = seedProject(t.db, "multi", { max_daily_usd: "5" });
    // Two rows for today on different phases — together they cross the cap.
    t.db.prepare(
      "INSERT INTO cost_rollup_day(project_id,phase,day,runs,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(pid, "ship", TODAY, 1, 0, 0, 0, 0, 3.0);
    t.db.prepare(
      "INSERT INTO cost_rollup_day(project_id,phase,day,runs,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(pid, "groom", TODAY, 1, 0, 0, 0, 0, 2.5);
    const rows = evaluateBudgetGuards(t.db, new Date());
    assert.equal(rows.length, 1);
    assert.ok(rows[0].spent_usd >= 5.5);
  } finally { t.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — runActions calls launchctl bootout via execFile + argv
// ────────────────────────────────────────────────────────────────────

test("AC3: runBudgetGuards calls launchctl bootout via argv array (no shell string composition)", async () => {
  const t = tempDb();
  try {
    const pid = seedProject(t.db, "boom", { max_daily_usd: "5" });
    seedRollupToday(t.db, pid, 6);

    const calls: Captured[] = [];
    _setRunnerForTests((cmd, args) => { calls.push({ cmd, args }); return ""; });
    _setGuardRunnerForTests(() => {/* unused for shell side; control's runner is canonical */});
    try {
      const { runBudgetGuards } = await import("../src/budget_guard.ts");
      const result = await runBudgetGuards(t.db, new Date());
      assert.equal(result.paused.length, 1);
      assert.equal(result.paused[0].slug, "boom");

      const launchctlCalls = calls.filter((c) => c.cmd === "launchctl");
      assert.ok(launchctlCalls.length > 0, "must shell out to launchctl");
      // The very first launchctl call from the pause path must be `bootout`.
      const bootouts = launchctlCalls.filter((c) => c.args[0] === "bootout");
      assert.ok(bootouts.length >= 1, "must call launchctl bootout to pause the ship plist");
      // argv-array form: the second arg must be the gui label, NOT a shell string.
      assert.ok(bootouts[0].args[1].startsWith("gui/"), "argv form: gui/<uid>/<label>");
      assert.ok(!bootouts[0].args.some((a) => /[;&|]/.test(a)),
        "no shell metacharacters smuggled into argv");

      // Pause row landed with the expected shape.
      const row = t.db.prepare("SELECT * FROM project_pause WHERE project_id=?").get(pid) as any;
      assert.ok(row, "project_pause row must be inserted");
      assert.equal(row.reason, "cost_cap");
      assert.equal(row.triggered_by, "budget_guard");
      const detail = JSON.parse(row.detail_json);
      assert.equal(detail.cap_usd, 5);
      assert.ok(detail.spent_usd >= 6);
      assert.equal(detail.day, TODAY);
    } finally {
      _resetRunnerForTests();
      _resetGuardRunnerForTests();
    }
  } finally { t.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — idempotence: a second pass does NOT re-pause an already-paused
// ────────────────────────────────────────────────────────────────────

test("AC4: second pass on an already-paused project does NOT re-call launchctl or insert a duplicate row", async () => {
  const t = tempDb();
  try {
    const pid = seedProject(t.db, "rep", { max_daily_usd: "5" });
    seedRollupToday(t.db, pid, 6);

    const calls: Captured[] = [];
    _setRunnerForTests((cmd, args) => { calls.push({ cmd, args }); return ""; });
    try {
      const { runBudgetGuards } = await import("../src/budget_guard.ts");
      await runBudgetGuards(t.db, new Date());
      const firstCalls = calls.length;
      const bootoutsFirst = calls.filter((c) => c.cmd === "launchctl" && c.args[0] === "bootout").length;

      await runBudgetGuards(t.db, new Date());
      const bootoutsSecond = calls.filter((c) => c.cmd === "launchctl" && c.args[0] === "bootout").length;
      assert.equal(bootoutsSecond, bootoutsFirst,
        "second pass must NOT call launchctl bootout again");

      const count = t.db.prepare("SELECT COUNT(*) AS n FROM project_pause WHERE project_id=?").get(pid) as { n: number };
      assert.equal(count.n, 1, "exactly one project_pause row");
    } finally { _resetRunnerForTests(); }
  } finally { t.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — ntfy push fires once per (slug, day)
// ────────────────────────────────────────────────────────────────────

interface NtfyCall { url: string; body: string; }

function fakeHttps(): { calls: NtfyCall[]; factory: HttpsLikeRequest } {
  const calls: NtfyCall[] = [];
  const factory: HttpsLikeRequest = (urlStr, init, cb) => {
    let body = "";
    const req: any = new EventEmitter();
    req.write = (chunk: any) => { body += chunk?.toString() ?? ""; };
    req.end = () => {
      calls.push({ url: urlStr, body });
      const res: any = new EventEmitter();
      res.statusCode = 200;
      setImmediate(() => { cb(res); res.emit("end"); });
    };
    req.setTimeout = () => {};
    req.destroy = () => {};
    return req;
  };
  return { calls, factory };
}

test("AC5: ntfy fires exactly once for (slug, day) even if the guard runs twice", async () => {
  const t = tempDb();
  try {
    const pid = seedProject(t.db, "spam", { max_daily_usd: "5" });
    seedRollupToday(t.db, pid, 7.5);

    _resetDedupForTests();
    const { calls, factory } = fakeHttps();
    setHttpsRequest(factory);
    _setRunnerForTests(() => ""); // stub launchctl
    // Plant a config so the dispatcher knows the topic.
    const cwd = process.cwd();
    const cfgDir = mkdtempSync(join(tmpdir(), "fleet-budget-cfg-"));
    process.chdir(cfgDir);
    writeFileSync(join(cfgDir, "fleet-control.config.json"), JSON.stringify({
      projectRoots: [join(cfgDir, "empty")],
      installedRoot: join(cfgDir, "empty"),
      cacheBase: join(cfgDir, "empty"),
      claudeProjects: join(cfgDir, "empty"),
      ntfyTopic: "fleet-budget-test",
    }));
    mkdirSync(join(cfgDir, "empty"), { recursive: true });

    try {
      const { runBudgetGuards } = await import("../src/budget_guard.ts");
      await runBudgetGuards(t.db, new Date());
      await runBudgetGuards(t.db, new Date());
      // Drain microtasks so the async ntfy POST in pass 1 settles before we count.
      await new Promise((r) => setImmediate(r));
      assert.equal(calls.length, 1, "exactly one ntfy POST across two passes");
      const body = JSON.parse(calls[0].body);
      assert.match(body.title, /spam/i, "title names the slug");
      assert.match(body.title, /5/, "title shows the cap");
    } finally {
      process.chdir(cwd);
      rmSync(cfgDir, { recursive: true, force: true });
      resetHttpsRequest();
      _resetRunnerForTests();
      _resetDedupForTests();
    }
  } finally { t.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC1 — schema round-trip
// ────────────────────────────────────────────────────────────────────

test("AC1: project_pause table round-trips with INSERT OR REPLACE idempotency", () => {
  const t = tempDb();
  try {
    const pid = seedProject(t.db, "x", { max_daily_usd: "5" });
    const ts = new Date().toISOString();
    t.db.prepare(
      "INSERT OR REPLACE INTO project_pause(project_id,reason,triggered_at,triggered_by,detail_json) VALUES(?,?,?,?,?)",
    ).run(pid, "cost_cap", ts, "budget_guard", JSON.stringify({ spent_usd: 6, cap_usd: 5, day: TODAY }));
    // Re-insert the same project_id — INSERT OR REPLACE keeps a single row.
    t.db.prepare(
      "INSERT OR REPLACE INTO project_pause(project_id,reason,triggered_at,triggered_by,detail_json) VALUES(?,?,?,?,?)",
    ).run(pid, "cost_cap", ts, "budget_guard", JSON.stringify({ spent_usd: 7, cap_usd: 5, day: TODAY }));
    const rows = t.db.prepare("SELECT * FROM project_pause WHERE project_id=?").all(pid) as any[];
    assert.equal(rows.length, 1, "INSERT OR REPLACE keeps a single row per project_id");
    const detail = JSON.parse(rows[0].detail_json);
    assert.equal(detail.spent_usd, 7, "REPLACE updated detail_json");
  } finally { t.cleanup(); }
});
