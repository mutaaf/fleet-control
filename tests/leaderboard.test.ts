// Tests for the cross-project tool-call leaderboard (ticket 0014).
//
// Each `test(...)` maps 1:1 to one acceptance-criteria checkbox in
// docs/backlog/0014-cross-project-tool-leaderboard.md. We seed `project`,
// `run`, `run_event`, and `cost_rollup_day` directly because the helper
// under test only SELECTs from those tables — no need to run the full
// ingest pipeline for a unit assertion.
//
// Conventions (lifted from tests/digest.test.ts):
//   - The default window is the last 14 days. `opts.now` lets the test
//     pin the wall clock so seeded `started_at` / `ts` values bucket
//     predictably.
//   - We use `as unknown as RowT[]` semantics in the production code per
//     the LESSON about node:sqlite typed casts; here in tests we don't
//     need to declare row interfaces (we read fields via `as any`).
//   - For AC9 (perf) we keep the call behind `process.env.PERF === "1"`
//     so CI stays fast.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db.ts";
import { fleetLeaderboard } from "../src/views.ts";

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-leaderdb-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string, name?: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace, repo_owner, repo_name) VALUES (?,?,?,?,?)",
  ).run(slug, name ?? slug, "test", "owner", slug);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as any).id;
}

/** Days-ago ISO timestamp (UTC), pinned to noon so date() buckets in
 *  SQL don't wobble across local midnights when checked against
 *  datetime('now','-N day'). */
function daysAgoIso(daysAgo: number, hourUtc = 12): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

function seedRun(db: DB, opts: {
  projectId: number; phase: string; startedAt: string;
  costUsd?: number; sessionId?: string;
}): number {
  const sid = opts.sessionId ?? `sess-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,duration_ms,cost_usd,outcome,cost_source) "
    + "VALUES(?,?,?,?,?,?,?, 'live')",
  ).run(opts.projectId, opts.phase, sid, opts.startedAt, 1000,
        opts.costUsd ?? 0, "shipped");
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as any).id;
}

function seedEvent(db: DB, opts: {
  runId: number; seq: number; ts: string; kind: string;
  toolName?: string | null; toolUseId?: string | null; isError?: number;
}) {
  db.prepare(
    "INSERT INTO run_event(run_id, seq, ts, kind, tool_name, tool_use_id, input_summary, output_summary, is_error) "
    + "VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(opts.runId, opts.seq, opts.ts, opts.kind,
        opts.toolName ?? null, opts.toolUseId ?? null,
        "", "", opts.isError ?? 0);
}

function seedCostRollup(db: DB, opts: {
  projectId: number; phase: string; day: string; costUsd: number;
}) {
  db.prepare(
    "INSERT OR REPLACE INTO cost_rollup_day(project_id, phase, day, runs, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd) "
    + "VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(opts.projectId, opts.phase, opts.day, 1, 0, 0, 0, 0, opts.costUsd);
}

/** A stable "now" — Tuesday 2026-05-26 12:00 UTC. Same anchor as the
 *  digest tests so the seed timing math is identical. */
const NOW = "2026-05-26T12:00:00.000Z";

// ────────────────────────────────────────────────────────────────────
// AC1 — shape + tools sorted by invocations desc, top_projects sorted
// similarly. Seed two projects with three tool events each.
// ────────────────────────────────────────────────────────────────────

test("AC1: fleetLeaderboard returns the documented shape; tools sorted by invocations desc; top_projects sorted similarly", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha", "Alpha");
    const b = seedProject(db, "beta",  "Beta");

    // Alpha: 3 events — 2 Bash + 1 Edit.
    const ra = seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(2), costUsd: 1 });
    seedEvent(db, { runId: ra, seq: 1, ts: daysAgoIso(2), kind: "tool_use", toolName: "Bash", toolUseId: "u-a1" });
    seedEvent(db, { runId: ra, seq: 2, ts: daysAgoIso(2), kind: "tool_use", toolName: "Bash", toolUseId: "u-a2" });
    seedEvent(db, { runId: ra, seq: 3, ts: daysAgoIso(2), kind: "tool_use", toolName: "Edit", toolUseId: "u-a3" });

    // Beta: 3 events — 1 Bash + 2 Edit.
    const rb = seedRun(db, { projectId: b, phase: "ship", startedAt: daysAgoIso(3), costUsd: 0.5 });
    seedEvent(db, { runId: rb, seq: 1, ts: daysAgoIso(3), kind: "tool_use", toolName: "Bash", toolUseId: "u-b1" });
    seedEvent(db, { runId: rb, seq: 2, ts: daysAgoIso(3), kind: "tool_use", toolName: "Edit", toolUseId: "u-b2" });
    seedEvent(db, { runId: rb, seq: 3, ts: daysAgoIso(3), kind: "tool_use", toolName: "Edit", toolUseId: "u-b3" });

    const d = fleetLeaderboard(db, { now: NOW });

    // Window object
    assert.equal(typeof d.window.start, "string");
    assert.equal(typeof d.window.end, "string");
    assert.equal(d.window.days, 14);
    assert.equal(d.window.end > d.window.start, true);

    // Tools sorted by invocations desc. Bash=3, Edit=3 — ties broken by name asc.
    assert.equal(d.tools.length, 2, "two distinct tools");
    // Both have 3 invocations; the ticket says "sorted by invocations desc"
    // so either order is technically valid — but we lock a stable tiebreak
    // (name asc) so the leaderboard render is deterministic week-to-week.
    assert.equal(d.tools[0].name, "Bash");
    assert.equal(d.tools[0].invocations, 3);
    assert.equal(d.tools[1].name, "Edit");
    assert.equal(d.tools[1].invocations, 3);

    // top_projects per tool: sorted by invocations desc, with stable tiebreak.
    const bashTops = d.tools[0].top_projects;
    assert.equal(bashTops[0].slug, "alpha", "alpha used Bash 2x (most)");
    assert.equal(bashTops[0].invocations, 2);
    assert.equal(bashTops[1].slug, "beta");
    assert.equal(bashTops[1].invocations, 1);

    const editTops = d.tools[1].top_projects;
    assert.equal(editTops[0].slug, "beta", "beta used Edit 2x (most)");
    assert.equal(editTops[0].invocations, 2);
    assert.equal(editTops[1].slug, "alpha");
    assert.equal(editTops[1].invocations, 1);

    // Projects array exists and has both projects
    assert.equal(d.projects.length, 2);
    // Heatmap has one row per project
    assert.equal(d.heatmap.length, 2);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — total_seconds = sum of (tool_result.ts - tool_use.ts) per
// matched pair within the window. Unmatched tool_use contributes 0.
// ────────────────────────────────────────────────────────────────────

test("AC2: total_seconds = sum(matched (result.ts - use.ts)); orphan tool_use contributes 0", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha");
    const r = seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(2), costUsd: 0 });

    // Matched pair: use at t=0s, result at t=5s → 5s
    const t0 = "2026-05-24T12:00:00.000Z";
    const t5 = "2026-05-24T12:00:05.000Z";
    seedEvent(db, { runId: r, seq: 1, ts: t0, kind: "tool_use",    toolName: "Bash", toolUseId: "u-1" });
    seedEvent(db, { runId: r, seq: 2, ts: t5, kind: "tool_result", toolName: null,   toolUseId: "u-1" });

    // Orphan tool_use — no matching result.
    const t10 = "2026-05-24T12:00:10.000Z";
    seedEvent(db, { runId: r, seq: 3, ts: t10, kind: "tool_use", toolName: "Bash", toolUseId: "u-2" });

    const d = fleetLeaderboard(db, { now: NOW });
    const bash = d.tools.find((t: any) => t.name === "Bash");
    assert.ok(bash);
    assert.equal(bash!.invocations, 2);
    // 5.0s from the matched pair, 0s from the orphan.
    assert.ok(Math.abs(bash!.total_seconds - 5.0) < 1e-6,
      `total_seconds ≈ 5.0, got ${bash!.total_seconds}`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — error_rate = errored_results / uses for the tool
// ────────────────────────────────────────────────────────────────────

test("AC3: error_rate = errored tool_results / tool_uses (3 uses, 1 errored result → 1/3)", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha");
    const r = seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(2), costUsd: 0 });

    // 3 tool_use of Bash; one matching tool_result is_error=1.
    seedEvent(db, { runId: r, seq: 1, ts: daysAgoIso(2), kind: "tool_use",    toolName: "Bash", toolUseId: "u-1" });
    seedEvent(db, { runId: r, seq: 2, ts: daysAgoIso(2), kind: "tool_result", toolUseId: "u-1", isError: 1 });
    seedEvent(db, { runId: r, seq: 3, ts: daysAgoIso(2), kind: "tool_use",    toolName: "Bash", toolUseId: "u-2" });
    seedEvent(db, { runId: r, seq: 4, ts: daysAgoIso(2), kind: "tool_result", toolUseId: "u-2", isError: 0 });
    seedEvent(db, { runId: r, seq: 5, ts: daysAgoIso(2), kind: "tool_use",    toolName: "Bash", toolUseId: "u-3" });

    const d = fleetLeaderboard(db, { now: NOW });
    const bash = d.tools.find((t: any) => t.name === "Bash");
    assert.ok(bash);
    assert.equal(bash!.invocations, 3);
    assert.ok(Math.abs(bash!.error_rate - (1 / 3)) < 1e-6,
      `error_rate ≈ 0.333, got ${bash!.error_rate}`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — tool_diversity = distinct tool_name per project in window
// ────────────────────────────────────────────────────────────────────

test("AC4: tool_diversity is the count of distinct tool_name within the window", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha");
    const r = seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(2), costUsd: 0 });
    seedEvent(db, { runId: r, seq: 1, ts: daysAgoIso(2), kind: "tool_use", toolName: "Bash", toolUseId: "u-1" });
    seedEvent(db, { runId: r, seq: 2, ts: daysAgoIso(2), kind: "tool_use", toolName: "Edit", toolUseId: "u-2" });
    seedEvent(db, { runId: r, seq: 3, ts: daysAgoIso(2), kind: "tool_use", toolName: "Read", toolUseId: "u-3" });

    const d = fleetLeaderboard(db, { now: NOW });
    const alpha = d.projects.find((p: any) => p.slug === "alpha");
    assert.ok(alpha);
    assert.equal(alpha!.tool_diversity, 3, "Bash + Edit + Read → 3");
    assert.equal(alpha!.top_tool, "Bash", "tied counts (1 each) → name asc → Bash");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — avg_tools_per_run = total tool_use / total runs in window
// ────────────────────────────────────────────────────────────────────

test("AC5: avg_tools_per_run = total tool_use / total runs (3 runs, 6 uses → 2.0)", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha");
    // 3 runs in window; 2 tool_use per run → 6 uses / 3 runs = 2.0
    for (let i = 1; i <= 3; i++) {
      const r = seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(i), costUsd: 0,
                              sessionId: `sess-${i}` });
      seedEvent(db, { runId: r, seq: 1, ts: daysAgoIso(i), kind: "tool_use", toolName: "Bash", toolUseId: `u-${i}-1` });
      seedEvent(db, { runId: r, seq: 2, ts: daysAgoIso(i), kind: "tool_use", toolName: "Edit", toolUseId: `u-${i}-2` });
    }

    const d = fleetLeaderboard(db, { now: NOW });
    const alpha = d.projects.find((p: any) => p.slug === "alpha");
    assert.ok(alpha);
    assert.equal(alpha!.runs_in_window, 3);
    assert.ok(Math.abs(alpha!.avg_tools_per_run - 2.0) < 1e-6,
      `avg_tools_per_run ≈ 2.0, got ${alpha!.avg_tools_per_run}`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — /api/fleet/leaderboard?days=N route; days clamped to [1, 90],
// default 14. We don't spin up a server here (out-of-scope for the
// unit test); instead we test the parameter normalization on the
// helper directly. The route's days clamp is asserted by the
// `clampDays()` exported alongside the helper.
// ────────────────────────────────────────────────────────────────────

test("AC6: clampDays normalises route input — default 14, min 1, max 90", async () => {
  const { clampDays } = await import("../src/views.ts");
  assert.equal(clampDays(undefined), 14, "undefined → 14");
  assert.equal(clampDays(null as any), 14, "null → 14");
  assert.equal(clampDays(""), 14, "empty string → 14");
  assert.equal(clampDays("not-a-number"), 14, "garbage → 14");
  assert.equal(clampDays("999"), 90, "above max clamps to 90");
  assert.equal(clampDays("0"), 1, "below min clamps to 1");
  assert.equal(clampDays("-5"), 1, "negative clamps to 1");
  assert.equal(clampDays("7"), 7, "in-range integer passes through");
  assert.equal(clampDays("14.7"), 14, "fractional → floor");
});

test("AC6: fleetLeaderboard honours the days option (window length matches)", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "alpha");
    const d7  = fleetLeaderboard(db, { now: NOW, days: 7 });
    const d30 = fleetLeaderboard(db, { now: NOW, days: 30 });
    assert.equal(d7.window.days, 7);
    assert.equal(d30.window.days, 30);
    // start = end - days
    const s7  = new Date(d7.window.start  + "T00:00:00Z").getTime();
    const e7  = new Date(d7.window.end    + "T00:00:00Z").getTime();
    const s30 = new Date(d30.window.start + "T00:00:00Z").getTime();
    const e30 = new Date(d30.window.end   + "T00:00:00Z").getTime();
    assert.equal(Math.round((e7 - s7) / 86_400_000), 7);
    assert.equal(Math.round((e30 - s30) / 86_400_000), 30);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — web/app.js adds the #/leaderboard hash route, renders all
// three sections. Source-level (no jsdom — zero-dep contract).
// ────────────────────────────────────────────────────────────────────

test("AC7: web/app.js wires #/leaderboard route + renderLeaderboard with three sections", () => {
  const js = readFileSync(join(import.meta.dirname ?? ".", "..", "web", "app.js"), "utf8");
  assert.match(js, /\/api\/fleet\/leaderboard/, "must fetch /api/fleet/leaderboard");
  assert.match(js, /renderLeaderboard\s*\(/, "must define renderLeaderboard(...)");
  assert.match(js, /leaderboard/i, "must reference leaderboard");
  // Three section headings: Tools, Projects, Heatmap
  assert.match(js, /Tools/, "tools section heading");
  assert.match(js, /Projects/, "projects section heading");
  assert.match(js, /Heatmap|by phase/i, "heatmap section heading");
  // Hash route hook (matches startsWith("leaderboard"))
  assert.match(js, /leaderboard["']?\s*\)/, "hash route checks for leaderboard");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — empty state: when tools.length === 0, the SPA renders a
// friendly message pointing operators at `fleetctl backfill`.
//
// Source-level: the renderLeaderboard fn must contain a branch that
// emits the documented empty-state copy.
// ────────────────────────────────────────────────────────────────────

test("AC8: renderLeaderboard emits a friendly empty-state when tools array is empty", () => {
  const js = readFileSync(join(import.meta.dirname ?? ".", "..", "web", "app.js"), "utf8");
  // Look for the renderLeaderboard function body; assert it contains a
  // backfill hint string when no tools are present.
  const fnMatch = /function\s+renderLeaderboard\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(js);
  assert.ok(fnMatch, "renderLeaderboard function must exist");
  const body = fnMatch![1];
  // The empty-state copy must mention `fleetctl backfill` so a fresh
  // operator knows what to do next.
  assert.match(body, /fleetctl backfill/i,
    "renderLeaderboard must include a 'fleetctl backfill' hint in its empty-state branch");
  // And it must guard on tools.length === 0 (or equivalently !tools.length).
  assert.ok(
    /tools\.length\s*===\s*0/.test(body) || /!\s*tools\.length/.test(body) ||
    /tools\.length\s*<\s*1/.test(body) || /tools\.length\s*==\s*0/.test(body),
    "renderLeaderboard must check tools.length === 0 (or equivalent) to gate the empty state",
  );
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Perf budget: 50k run_event rows across 10 projects → < 150ms.
// Gated by PERF=1 so the regular CI run stays fast.
// ────────────────────────────────────────────────────────────────────

test("AC9: leaderboard query under 150ms on 50k run_event rows across 10 projects (PERF=1)", () => {
  if (process.env.PERF !== "1") return; // skipped by default
  const { db, cleanup } = tempDb();
  try {
    const projectIds: number[] = [];
    for (let i = 0; i < 10; i++) projectIds.push(seedProject(db, `proj-${i}`));
    // 10 runs per project = 100 runs; 500 events per run = 50k events.
    const insertEv = db.prepare(
      "INSERT INTO run_event(run_id, seq, ts, kind, tool_name, tool_use_id, input_summary, output_summary, is_error) "
      + "VALUES (?,?,?,?,?,?,?,?,?)",
    );
    const tools = ["Bash", "Edit", "Read", "Grep", "Write"];
    for (const pid of projectIds) {
      for (let rn = 0; rn < 10; rn++) {
        const rid = seedRun(db, { projectId: pid, phase: "ship", startedAt: daysAgoIso(rn % 14 + 1), costUsd: 1,
                                  sessionId: `sess-${pid}-${rn}` });
        for (let ev = 0; ev < 500; ev++) {
          const tool = tools[ev % tools.length];
          const useId = `u-${pid}-${rn}-${ev}`;
          const isUse = ev % 2 === 0;
          insertEv.run(rid, ev, daysAgoIso(rn % 14 + 1),
                       isUse ? "tool_use" : "tool_result",
                       isUse ? tool : null, useId, "", "", 0);
        }
      }
    }

    const t0 = Date.now();
    const d = fleetLeaderboard(db, { now: NOW });
    const elapsed = Date.now() - t0;
    assert.ok(d.tools.length > 0, "tools array must be populated");
    assert.ok(elapsed < 150, `leaderboard query took ${elapsed}ms — must be < 150ms`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 — zero new runtime deps. Same check as digest/mobile.
// ────────────────────────────────────────────────────────────────────

test("AC10: package.json has zero runtime dependencies (no new deps added by 0014)", () => {
  const pkg = JSON.parse(readFileSync(
    join(import.meta.dirname ?? ".", "..", "package.json"),
    "utf8",
  ));
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    `dependencies must stay empty; found: ${Object.keys(deps).join(", ")}`);
});

// ────────────────────────────────────────────────────────────────────
// Bonus — heatmap shape: one row per project, cost_usd per phase
// pulled from cost_rollup_day rows in window.
// ────────────────────────────────────────────────────────────────────

test("heatmap rows aggregate cost_rollup_day by phase per project in window", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha");
    seedCostRollup(db, { projectId: a, phase: "ship",   day: "2026-05-25", costUsd: 1.5 });
    seedCostRollup(db, { projectId: a, phase: "groom",  day: "2026-05-24", costUsd: 0.5 });
    seedCostRollup(db, { projectId: a, phase: "review", day: "2026-05-23", costUsd: 0.25 });
    // Out-of-window — must NOT contribute (35 days ago).
    seedCostRollup(db, { projectId: a, phase: "ship", day: "2026-04-21", costUsd: 99 });

    const d = fleetLeaderboard(db, { now: NOW });
    const row = d.heatmap.find((h: any) => h.slug === "alpha");
    assert.ok(row);
    assert.ok(Math.abs(row!.by_phase.ship   - 1.5)  < 1e-9, `ship: ${row!.by_phase.ship}`);
    assert.ok(Math.abs(row!.by_phase.groom  - 0.5)  < 1e-9, `groom: ${row!.by_phase.groom}`);
    assert.ok(Math.abs(row!.by_phase.review - 0.25) < 1e-9, `review: ${row!.by_phase.review}`);
    assert.equal(row!.by_phase.eng, 0, "no eng rows → 0");
  } finally { cleanup(); }
});
