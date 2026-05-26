// Tests for ticket 0019: prs_merged count reads from `run` not
// `control_audit`. The headline strip in the portal's weekly-digest banner
// used to count rows in control_audit with action='pr-merge', which only
// fires when the operator clicks "Approve & publish" — so agent PRs that
// merged via `gh pr merge --auto --squash` (the normal path) never got
// counted and the operator saw "0 PRs merged" while GitHub showed dozens.
//
// New contract:
//   - `prs_merged` (both totals and per-project) counts DISTINCT
//     `pr_number` from the `run` table where outcome='shipped' AND
//     pr_number IS NOT NULL, scoped to the digest window.
//   - The audit-derived count stays available as
//     `prs_merged_via_portal` on the SAME JSON object so a future
//     ticket can split "via portal" vs "auto-merged" if useful.
//
// We exercise the helper directly — no http listener, no ingest pipeline.
// The same `tempDb`/`seedRun`/`seedAudit` shape as tests/digest.test.ts
// keeps the seed surface familiar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db.ts";
import { weeklyDigest, _resetDigestCacheForTests } from "../src/digest.ts";
import { fleetView } from "../src/views.ts";
import type { FleetConfig } from "../src/config.ts";

// ─── Fixtures ────────────────────────────────────────────────────────

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-prsmerged-"));
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

function daysAgoIso(daysAgo: number, hourUtc = 12): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

/** Seed a single run row. `prNumber` is the column the new prs_merged
 *  query reads — pass it explicitly to exercise the DISTINCT logic. */
function seedRun(db: DB, opts: {
  projectId: number; phase: string; startedAt: string; outcome?: string | null;
  prNumber?: number | null; costUsd?: number; sessionId?: string;
}): number {
  const sid = opts.sessionId ?? `sess-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,duration_ms,cost_usd,outcome,pr_number,cost_source) "
    + "VALUES(?,?,?,?,?,?,?,?, 'live')",
  ).run(
    opts.projectId, opts.phase, sid, opts.startedAt, 1000,
    opts.costUsd ?? 0, opts.outcome ?? null, opts.prNumber ?? null,
  );
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as any).id;
}

function seedAudit(db: DB, ts: string, action: string, target: string): void {
  db.prepare(
    "INSERT INTO control_audit(ts,actor,action,target,args_json,exit_code,stdout_tail) "
    + "VALUES(?, 'local', ?, ?, '{}', 0, '')",
  ).run(ts, action, target);
}

const NOW_ANCHOR = "2026-05-26T12:00:00.000Z";

// ─── AC1 — prs_merged is sourced from runs (NOT control_audit) ───────

test("prs_merged counts DISTINCT pr_number from shipped runs, ignoring control_audit", () => {
  // Spec: 3 shipped runs with pr_number {10,11,12} and 0 control_audit
  // rows → prs_merged: 3. The exact scenario the ticket describes.
  const { db, cleanup } = tempDb();
  try {
    _resetDigestCacheForTests();
    const a = seedProject(db, "alpha", "Alpha");
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(1), outcome: "shipped", prNumber: 10, costUsd: 0.50 });
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(2), outcome: "shipped", prNumber: 11, costUsd: 0.50 });
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(3), outcome: "shipped", prNumber: 12, costUsd: 0.50 });
    // No control_audit pr-merge rows — yesterday the operator never clicked
    // "Approve & publish". The auto-merge path is the only signal.

    const d = weeklyDigest(db, { now: NOW_ANCHOR });
    assert.equal(d.totals.prs_merged, 3, "headline strip must reflect auto-merged PRs from runs");
    const alpha = d.projects.find((p) => p.slug === "alpha");
    assert.ok(alpha, "alpha must appear in projects");
    assert.equal(alpha!.prs_merged, 3, "per-project prs_merged must reflect auto-merged PRs from runs");
  } finally { cleanup(); }
});

// ─── AC2 — DISTINCT pr_number (duplicate runs don't inflate the count) ─

test("prs_merged dedupes on pr_number — multiple shipped runs for the same PR count as 1", () => {
  // Spec: adds one duplicate run for pr_number 10; the count must stay 3.
  const { db, cleanup } = tempDb();
  try {
    _resetDigestCacheForTests();
    const a = seedProject(db, "alpha", "Alpha");
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(1), outcome: "shipped", prNumber: 10 });
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(1, 13), outcome: "shipped", prNumber: 10 }); // duplicate (same PR, different session)
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(2), outcome: "shipped", prNumber: 11 });
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(3), outcome: "shipped", prNumber: 12 });

    const d = weeklyDigest(db, { now: NOW_ANCHOR });
    assert.equal(d.totals.prs_merged, 3, "duplicate runs for the same pr_number must collapse via DISTINCT");
    const alpha = d.projects.find((p) => p.slug === "alpha");
    assert.equal(alpha!.prs_merged, 3);
  } finally { cleanup(); }
});

// ─── AC3 — outcome filter: non-shipped runs don't count, NULL pr doesn't count

test("prs_merged only counts runs with outcome='shipped' AND pr_number IS NOT NULL", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetDigestCacheForTests();
    const a = seedProject(db, "alpha", "Alpha");
    // Shipped with PR — counts.
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(1), outcome: "shipped", prNumber: 1 });
    // Shipped without PR (no-op / docs-only ship) — must NOT count.
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(2), outcome: "shipped", prNumber: null });
    // No-op outcome with a stale pr_number — must NOT count.
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(3), outcome: "no-op", prNumber: 99 });
    // Self-cancel — must NOT count (PR may not have merged).
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(4), outcome: "self-cancel", prNumber: 50 });
    // Failed — must NOT count.
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(5), outcome: "failed", prNumber: 70 });

    const d = weeklyDigest(db, { now: NOW_ANCHOR });
    assert.equal(d.totals.prs_merged, 1, "only the shipped+pr_number row counts");
  } finally { cleanup(); }
});

// ─── AC4 — window scoping: out-of-window runs don't count ────────────

test("prs_merged is scoped to the digest window — out-of-window shipped runs don't bleed in", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetDigestCacheForTests();
    const a = seedProject(db, "alpha", "Alpha");
    // Inside window (days 1..7 ago).
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(2), outcome: "shipped", prNumber: 1 });
    // Outside window (prior week — 9 days ago). MUST NOT count.
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(9), outcome: "shipped", prNumber: 2 });
    // Outside window (>2 weeks ago).
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(20), outcome: "shipped", prNumber: 3 });

    const d = weeklyDigest(db, { now: NOW_ANCHOR });
    assert.equal(d.totals.prs_merged, 1, "only the in-window pr_number must count");
  } finally { cleanup(); }
});

// ─── AC5 — prs_merged_via_portal exposes the audit-driven count ──────

test("prs_merged_via_portal is exposed alongside prs_merged (operator-driven count from control_audit)", () => {
  // The audit-derived count stays available for a future ticket that
  // wants to split "via portal" vs "auto-merged". Same JSON object so
  // the SPA can show both without a second round-trip.
  const { db, cleanup } = tempDb();
  try {
    _resetDigestCacheForTests();
    const a = seedProject(db, "alpha", "Alpha");
    // Two PRs merged via the portal button.
    seedAudit(db, daysAgoIso(1), "pr-merge", "alpha/100");
    seedAudit(db, daysAgoIso(2), "pr-merge", "alpha/101");
    // Three PRs auto-merged (the agent-fleet steady state).
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(1), outcome: "shipped", prNumber: 200 });
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(2), outcome: "shipped", prNumber: 201 });
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(3), outcome: "shipped", prNumber: 202 });

    const d = weeklyDigest(db, { now: NOW_ANCHOR });
    assert.equal(d.totals.prs_merged, 3, "prs_merged comes from runs (DISTINCT pr_number)");
    assert.equal(d.totals.prs_merged_via_portal, 2,
      "prs_merged_via_portal preserves the audit-derived count");

    const alpha = d.projects.find((p) => p.slug === "alpha");
    assert.ok(alpha);
    assert.equal(alpha!.prs_merged, 3);
    assert.equal(alpha!.prs_merged_via_portal, 2,
      "per-project prs_merged_via_portal mirrors the totals view");
  } finally { cleanup(); }
});

// ─── AC6 — fleetView exposes prs_merged_7d from the run table ────────

test("fleetView exposes prs_merged_7d per project, sourced from runs (not control_audit)", () => {
  // The home-grid card payload now carries a `prs_merged_7d` field so a
  // future SPA pass can surface auto-merged counts inline. The ticket's
  // engineering note specifically calls out src/views.ts as a place to
  // count merged PRs from `run` (not control_audit) — this test pins
  // that contract directly against the production helper.
  const { db, cleanup } = tempDb();
  try {
    const a = seedProject(db, "alpha", "Alpha");
    // 2 shipped PRs in the trailing 7d.
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(1), outcome: "shipped", prNumber: 100, costUsd: 0.10 });
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(3), outcome: "shipped", prNumber: 101, costUsd: 0.10 });
    // Duplicate run for the same PR — DISTINCT must collapse to 1.
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(4), outcome: "shipped", prNumber: 100, costUsd: 0.10 });
    // Out of window (>7 days ago) — must NOT count.
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(20), outcome: "shipped", prNumber: 200, costUsd: 0.10 });
    // Audit row should NOT contribute — we want the count from runs only.
    seedAudit(db, daysAgoIso(1), "pr-merge", "alpha/999");

    const cfg = {
      projectRoots: [], installedRoot: "/tmp/none", dbPath: ":memory:",
      cacheBase: "/tmp/none", claudeProjects: "/tmp/none",
    } as FleetConfig;
    const view = fleetView(db, cfg);
    const alpha = view.projects.find((p: any) => p.slug === "alpha");
    assert.ok(alpha, "alpha must appear in fleet view");
    assert.equal(alpha.prs_merged_7d, 2,
      "fleetView.prs_merged_7d must count DISTINCT pr_number from shipped runs in the trailing 7 days");
  } finally { cleanup(); }
});

// ─── AC7 — multi-project: counts attribute to the right project ──────

test("prs_merged splits cleanly across projects (no leakage between slugs)", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetDigestCacheForTests();
    const alpha = seedProject(db, "alpha", "Alpha");
    const beta  = seedProject(db, "beta",  "Beta");
    seedRun(db, { projectId: alpha, phase: "ship", startedAt: daysAgoIso(1), outcome: "shipped", prNumber: 1, costUsd: 0.10 });
    seedRun(db, { projectId: alpha, phase: "ship", startedAt: daysAgoIso(2), outcome: "shipped", prNumber: 2, costUsd: 0.10 });
    seedRun(db, { projectId: beta,  phase: "ship", startedAt: daysAgoIso(1), outcome: "shipped", prNumber: 1, costUsd: 0.10 });
    // beta reusing pr_number 1 for its own repo — must not collide with alpha's.

    const d = weeklyDigest(db, { now: NOW_ANCHOR });
    assert.equal(d.totals.prs_merged, 3,
      "fleet-wide total is the sum of per-project DISTINCT counts (alpha=2 + beta=1)");
    const a = d.projects.find((p) => p.slug === "alpha");
    const b = d.projects.find((p) => p.slug === "beta");
    assert.equal(a!.prs_merged, 2);
    assert.equal(b!.prs_merged, 1, "beta's pr_number=1 must not collide with alpha's pr_number=1");
  } finally { cleanup(); }
});
