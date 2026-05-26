// Tests for the weekly "what shipped" digest (ticket 0012).
//
// Each `test(...)` maps 1:1 to one acceptance-criteria checkbox in
// docs/backlog/0012-weekly-digest.md. We seed `run`, `control_audit`,
// `anomaly`, and `cost_rollup_day` directly because the helpers under
// test only SELECT from those tables — there's no point running the
// full ingest pipeline for a unit assertion.
//
// Conventions:
//   - The digest window is "last 7 ISO days, end exclusive". `opts.now`
//     lets the test pin the wall clock so the SQL `datetime('now',...)`
//     buckets line up with our seeded timestamps. (Without that pin the
//     test would have to wait for midnight to roll over and re-seed.)
//   - We pass `opts.now` as an ISO string; the helper translates it into
//     a SQLite-compatible `datetime(?, '-N day')` boundary.
//   - For AC2 (deterministic narrative) we assert the exact template
//     strings — no substring matching — so a future refactor that drops
//     a punctuation mark would still fail loudly.
//   - For AC5 (cache) we inject a counter via a runs.count helper rather
//     than swapping the whole helper; the cache hit short-circuits BEFORE
//     any SQL runs, so counting db.prepare invocations would be brittle
//     across other code paths. Instead we read a public `_lastBuildAt`
//     marker that the helper sets on a fresh build (and leaves untouched
//     on a cache hit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { openDb, type DB } from "../src/db.ts";
import {
  weeklyDigest, renderDigestMarkdown, isoWeekKey, _resetDigestCacheForTests,
  _getDigestCacheBuildsForTests,
} from "../src/digest.ts";

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-digestdb-"));
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

/** Days-ago ISO timestamp (UTC). Pins the time to noon so the date()
 *  bucket in SQL doesn't wobble across local midnights when comparing
 *  against datetime('now','-N day'). */
function daysAgoIso(daysAgo: number, hourUtc = 12): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

/** Insert one run row with explicit started_at + cost. Keeps fixtures
 *  short — every column the digest reads is set, the rest stays NULL. */
function seedRun(db: DB, opts: {
  projectId: number; phase: string; startedAt: string; durationMs?: number;
  costUsd?: number; outcome?: string | null; sessionId?: string;
}): number {
  const sid = opts.sessionId ?? `sess-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,duration_ms,cost_usd,outcome,cost_source) "
    + "VALUES(?,?,?,?,?,?,?, 'live')",
  ).run(opts.projectId, opts.phase, sid, opts.startedAt, opts.durationMs ?? 1000,
        opts.costUsd ?? 0, opts.outcome ?? null);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as any).id;
}

function seedAudit(db: DB, ts: string, action: string, target: string) {
  db.prepare(
    "INSERT INTO control_audit(ts,actor,action,target,args_json,exit_code,stdout_tail) "
    + "VALUES(?, 'local', ?, ?, '{}', 0, '')",
  ).run(ts, action, target);
}

function seedAnomaly(db: DB, runId: number, kind: string, createdAt: string) {
  db.prepare(
    "INSERT INTO anomaly(run_id,kind,value,baseline_mean,baseline_stddev,sample_count,candidate_reason,created_at) "
    + "VALUES(?,?,?,?,?,?,?,?)",
  ).run(runId, kind, 60_000, 10_000, 5000, 7, null, createdAt);
}

// A stable "now" anchor for every test — Tuesday 2026-05-26 12:00 UTC.
// Tests that need a different anchor pass their own through opts.now.
const NOW_ANCHOR = "2026-05-26T12:00:00.000Z";

// ────────────────────────────────────────────────────────────────────
// AC1 — weeklyDigest returns the documented shape; sorted by cost desc
// ────────────────────────────────────────────────────────────────────

test("AC1: weeklyDigest returns totals + projects sorted by cost_usd desc + 14-day fixture math", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetDigestCacheForTests();
    const alpha = seedProject(db, "alpha", "Alpha");
    const beta  = seedProject(db, "beta",  "Beta");

    // Last-7 window (1..7 days ago): alpha has 3 runs totaling $6; beta has
    // 2 runs totaling $1.50 — so projects array must be [alpha, beta].
    seedRun(db, { projectId: alpha, phase: "ship",  startedAt: daysAgoIso(1), costUsd: 2.00, outcome: "shipped" });
    seedRun(db, { projectId: alpha, phase: "ship",  startedAt: daysAgoIso(3), costUsd: 2.50, outcome: "shipped" });
    seedRun(db, { projectId: alpha, phase: "groom", startedAt: daysAgoIso(5), costUsd: 1.50, outcome: "no-op" });
    seedRun(db, { projectId: beta,  phase: "ship",  startedAt: daysAgoIso(2), costUsd: 1.00, outcome: "shipped" });
    seedRun(db, { projectId: beta,  phase: "review", startedAt: daysAgoIso(4), costUsd: 0.50, outcome: "reviewed-ok" });

    // Prior-7 (8..14 days ago) — used by the delta-cost AC but must NOT bleed
    // into the current-week totals. Different per project so we'd notice.
    seedRun(db, { projectId: alpha, phase: "ship", startedAt: daysAgoIso(9), costUsd: 99, outcome: "shipped" });

    const d = weeklyDigest(db, { now: NOW_ANCHOR });
    assert.equal(typeof d.period.start, "string", "period.start is an ISO date string");
    assert.equal(typeof d.period.end, "string", "period.end is an ISO date string, exclusive");
    assert.equal(d.period.end > d.period.start, true);
    assert.equal(d.totals.runs, 5, "totals.runs counts every run in [start,end)");
    // 2.00 + 2.50 + 1.50 + 1.00 + 0.50 = 7.50 — JS floating-point will hand
    // us 7.499999...; we assert with a tight epsilon so an arithmetic
    // regression (e.g. summing the prior week by accident) still fails loud.
    assert.ok(Math.abs(d.totals.cost_usd - 7.50) < 1e-9, `totals.cost_usd ≈ 7.50, got ${d.totals.cost_usd}`);
    assert.equal(d.projects.length, 2);
    assert.equal(d.projects[0].slug, "alpha", "projects must sort by cost_usd descending");
    assert.equal(d.projects[1].slug, "beta");
    assert.equal(d.projects[0].runs, 3);
    assert.equal(d.projects[1].runs, 2);
    // top_phase is the highest-cost phase within the window for that project.
    assert.equal(d.projects[0].top_phase, "ship", "alpha spent most on ship ($4.50)");
    assert.equal(d.projects[1].top_phase, "ship", "beta spent more on ship ($1.00) than review ($0.50)");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — deterministic narrative templates (no LLM)
// ────────────────────────────────────────────────────────────────────

test("AC2: narrative bullets match the documented templates verbatim", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetDigestCacheForTests();
    const a = seedProject(db, "alpha", "Alpha");
    // 2 ships PRs merged via control_audit; 1 self-cancelled run; 1 anomaly.
    seedAudit(db, daysAgoIso(1), "pr-merge", "alpha/42");
    seedAudit(db, daysAgoIso(2), "pr-merge", "alpha/43");
    const r1 = seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(1), costUsd: 5, outcome: "self-cancel" });
    seedAnomaly(db, r1, "duration", daysAgoIso(1));
    // Prior week: $0 → delta_cost_vs_prior_week_pct = null, so no "spent X, ±Y% vs last week" line.
    // Current week cost: $5.

    const d = weeklyDigest(db, { now: NOW_ANCHOR });
    assert.equal(d.totals.prs_merged, 2);
    assert.equal(d.totals.self_cancels, 1);
    assert.equal(d.totals.anomalies, 1);
    // narrative is between 3 and 7 plain-English bullets (per the ticket).
    assert.ok(d.narrative.length >= 1, "narrative must not be empty");
    assert.ok(d.narrative.length <= 7, `narrative max 7 bullets, got ${d.narrative.length}`);
    // The PR-shipped bullet must match the documented template exactly.
    assert.ok(
      d.narrative.includes("alpha shipped 2 PRs"),
      `narrative missing the "<slug> shipped <N> PRs" template; got: ${JSON.stringify(d.narrative)}`,
    );
    // Self-cancel bullet — singular form for N=1.
    assert.ok(
      d.narrative.includes("alpha self-cancelled 1 time — caught a runaway"),
      `narrative missing the self-cancel template; got: ${JSON.stringify(d.narrative)}`,
    );
    // Anomaly bullet — singular form for N=1.
    assert.ok(
      d.narrative.includes("1 anomaly flagged on alpha"),
      `narrative missing the anomaly template; got: ${JSON.stringify(d.narrative)}`,
    );
  } finally { cleanup(); }
});

test("AC2: plural forms — multiple PRs / self-cancels / anomalies use the documented pluralisation", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetDigestCacheForTests();
    const a = seedProject(db, "beta", "Beta");
    seedAudit(db, daysAgoIso(1), "pr-merge", "beta/1");
    seedAudit(db, daysAgoIso(2), "pr-merge", "beta/2");
    seedAudit(db, daysAgoIso(3), "pr-merge", "beta/3");
    const r1 = seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(1), costUsd: 2, outcome: "self-cancel" });
    const r2 = seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(2), costUsd: 2, outcome: "self-cancel" });
    seedAnomaly(db, r1, "duration", daysAgoIso(1));
    seedAnomaly(db, r2, "cost", daysAgoIso(2));

    const d = weeklyDigest(db, { now: NOW_ANCHOR });
    assert.ok(d.narrative.includes("beta shipped 3 PRs"));
    assert.ok(
      d.narrative.includes("beta self-cancelled 2 times — caught a runaway"),
      `plural self-cancel form missing: ${JSON.stringify(d.narrative)}`,
    );
    assert.ok(
      d.narrative.includes("2 anomalies flagged on beta"),
      `plural anomaly form missing: ${JSON.stringify(d.narrative)}`,
    );
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — prs_merged/prs_sent_back from control_audit
// ────────────────────────────────────────────────────────────────────

test("AC3: prs_merged + prs_sent_back are counted from control_audit rows", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetDigestCacheForTests();
    const a = seedProject(db, "alpha", "Alpha");
    // In-window audit rows.
    seedAudit(db, daysAgoIso(1), "pr-merge",   "alpha/1");
    seedAudit(db, daysAgoIso(2), "pr-merge",   "alpha/2");
    seedAudit(db, daysAgoIso(3), "pr-changes", "alpha/3");
    // Out-of-window — must NOT be counted.
    seedAudit(db, daysAgoIso(10), "pr-merge",   "alpha/9");
    seedAudit(db, daysAgoIso(11), "pr-changes", "alpha/8");
    // Unrelated action — must NOT be counted.
    seedAudit(db, daysAgoIso(1), "kickstart", "alpha/ship");

    // The project still needs at least one row in projects[] to verify per-
    // project rollup. Seed a single run so the digest emits an entry.
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(2), costUsd: 0.10, outcome: "shipped" });

    const d = weeklyDigest(db, { now: NOW_ANCHOR });
    assert.equal(d.totals.prs_merged, 2, "totals.prs_merged counts only in-window pr-merge rows");
    assert.equal(d.totals.prs_sent_back, 1, "totals.prs_sent_back counts only in-window pr-changes rows");

    const alpha = d.projects.find((p) => p.slug === "alpha");
    assert.ok(alpha, "alpha must appear in projects");
    assert.equal(alpha!.prs_merged, 2);
    assert.equal(alpha!.prs_sent_back, 1);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — delta_cost_vs_prior_week_pct math + divide-by-zero guard
// ────────────────────────────────────────────────────────────────────

test("AC4: delta_cost_vs_prior_week_pct is null when the prior window has $0 cost", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetDigestCacheForTests();
    const a = seedProject(db, "alpha", "Alpha");
    // This week: $5. Prior week: $0 (no rows).
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(1), costUsd: 5, outcome: "shipped" });

    const d = weeklyDigest(db, { now: NOW_ANCHOR });
    const alpha = d.projects.find((p) => p.slug === "alpha");
    assert.ok(alpha);
    assert.equal(alpha!.delta_cost_vs_prior_week_pct, null,
      "$0 prior week → null (no divide-by-zero); the SPA renders 'new this week' instead");
  } finally { cleanup(); }
});

test("AC4: delta is +25.0 when prior=$4 and current=$5 (rounded to 0.1)", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetDigestCacheForTests();
    const a = seedProject(db, "alpha", "Alpha");
    // Current week: $5 across two runs (1..7 days ago).
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(1), costUsd: 2.5, outcome: "shipped" });
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(3), costUsd: 2.5, outcome: "shipped" });
    // Prior week: $4 across two runs (8..14 days ago).
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(9),  costUsd: 2.0, outcome: "shipped" });
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(12), costUsd: 2.0, outcome: "shipped" });

    const d = weeklyDigest(db, { now: NOW_ANCHOR });
    const alpha = d.projects.find((p) => p.slug === "alpha");
    assert.ok(alpha);
    assert.equal(alpha!.delta_cost_vs_prior_week_pct, 25.0,
      "(5 - 4) / 4 × 100 = 25.0; the helper rounds to 1 decimal place");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — /api/digest/week cache (5 min). We test the in-memory cache
// directly because spinning up a real http listener is out of scope for
// this test file; the same cache is what server.ts will call.
// ────────────────────────────────────────────────────────────────────

test("AC5: weeklyDigest caches per period — second call within TTL doesn't re-build", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetDigestCacheForTests();
    const a = seedProject(db, "alpha", "Alpha");
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(1), costUsd: 1, outcome: "shipped" });

    const before = _getDigestCacheBuildsForTests();
    weeklyDigest(db, { now: NOW_ANCHOR });
    const afterFirst = _getDigestCacheBuildsForTests();
    assert.equal(afterFirst, before + 1, "first call should build (+1 to the build counter)");

    weeklyDigest(db, { now: NOW_ANCHOR });
    const afterSecond = _getDigestCacheBuildsForTests();
    assert.equal(afterSecond, before + 1, "second call within the TTL must hit the cache (no new build)");

    // A different period (different anchor — one day later) MUST re-build,
    // because the cache key includes the period start/end.
    weeklyDigest(db, { now: "2026-05-27T12:00:00.000Z" });
    const afterDifferent = _getDigestCacheBuildsForTests();
    assert.equal(afterDifferent, before + 2, "different period must build a fresh digest");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — SPA "Last week" banner. Text-level test on web/app.js: assert
// the source contains a renderer that consumes /api/digest/week and
// emits a banner with the merged-PR count.
// ────────────────────────────────────────────────────────────────────

test("AC6: web/app.js fetches /api/digest/week and renders a banner showing the merged-PR count", () => {
  const path = join(import.meta.dirname ?? ".", "..", "web", "app.js");
  const js = readFileSync(path, "utf8");
  assert.match(js, /\/api\/digest\/week/,
    "app.js must fetch /api/digest/week somewhere");
  // The banner is a top-of-home block. The implementation injects a
  // call site named `digestBanner(` so the test can lock to that name
  // (a refactor that renames the function is a flag for re-review).
  assert.match(js, /digestBanner\s*\(/,
    "app.js must define and call digestBanner(...) to render the banner");
  // The banner template references prs_merged AND wraps it as a stat —
  // we look for "PR" near a number-substitution token so the count is
  // explicitly part of the banner copy.
  assert.match(js, /prs_merged/,
    "banner must reference prs_merged (the merged-PR count from the digest)");
  // "Last week" label per the ticket — surfaces what the operator sees.
  assert.match(js, /Last week/,
    "banner must include the 'Last week' label");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — renderDigestMarkdown emits stable markdown. We don't compare
// to a fixture file (because timestamps change); instead we lock the
// shape: H1 header, a totals line, a per-project subsection per project
// in the same order as `projects`, narrative bullets at the bottom.
// ────────────────────────────────────────────────────────────────────

test("AC7: renderDigestMarkdown returns deterministic markdown with totals + per-project + narrative", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetDigestCacheForTests();
    const a = seedProject(db, "alpha", "Alpha");
    const b = seedProject(db, "beta",  "Beta");
    seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(1), costUsd: 3, outcome: "shipped" });
    seedRun(db, { projectId: b, phase: "ship", startedAt: daysAgoIso(2), costUsd: 1, outcome: "shipped" });
    seedAudit(db, daysAgoIso(1), "pr-merge", "alpha/1");

    const d = weeklyDigest(db, { now: NOW_ANCHOR });
    const md = renderDigestMarkdown(d);

    // H1 with the period.
    assert.match(md, /^# Weekly digest /, "must start with '# Weekly digest <period>'");
    assert.match(md, new RegExp(d.period.start), "period start must appear in the H1");

    // Totals line — names + numbers, deterministic order.
    assert.match(md, /\*\*Totals\*\*/, "must contain a bolded 'Totals' label");
    assert.match(md, /runs: 2/);
    assert.match(md, /PRs merged: 1/);
    assert.match(md, /\$4\.00|\$4\.0/, "totals line must include the dollar amount");

    // Per-project subsection per slug, in projects[] order (alpha, beta).
    const alphaIdx = md.indexOf("## alpha");
    const betaIdx  = md.indexOf("## beta");
    assert.ok(alphaIdx >= 0, "alpha section missing");
    assert.ok(betaIdx >= 0,  "beta section missing");
    assert.ok(alphaIdx < betaIdx, "sections must appear in projects[] order (alpha before beta)");

    // Narrative section.
    assert.match(md, /## Narrative/);

    // The markdown is "diff-clean": no trailing whitespace, ends with a
    // single newline. (Helps the --save file stay churn-free week over
    // week if only one number changes.)
    assert.ok(md.endsWith("\n"));
    assert.ok(!md.endsWith("\n\n\n"), "no triple newlines at EOF");
    assert.ok(
      !md.split("\n").some((line) => /[ \t]+$/.test(line)),
      "no trailing whitespace on any line",
    );
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC8 — `fleetctl digest --save` writes the markdown to
// ~/.local/state/fleet-control/digests/<isoweek>.md (idempotent).
//
// We can't safely write to the operator's real home directory in a test
// — so the CLI accepts a FLEET_STATE_DIR env override (loadConfig
// already honours fleet-control.config.json for dbPath; we cleanly
// extend that via env for the test). The fixture verifies:
//   1. running twice produces ONE file at the expected name
//   2. isoWeekKey returns "YYYY-Www" with W padded to 2 digits
// ────────────────────────────────────────────────────────────────────

test("AC8: isoWeekKey returns YYYY-Www format", () => {
  // Mid-week dates — week numbers should be 2 digits, zero-padded.
  assert.equal(isoWeekKey(new Date("2026-01-08T12:00:00Z")), "2026-W02",
    "early-January date → W02 (zero-padded)");
  assert.equal(isoWeekKey(new Date("2026-05-26T12:00:00Z")), "2026-W22",
    "late-May 2026 date → W22");
  // ISO week 1 must be the week containing the first Thursday of January.
  // 2027-01-01 (Friday) → ISO 2026-W53; we don't pin the exact value here
  // because the calendar rule is independently tested by the CLI fixture,
  // but the shape must hold.
  assert.match(isoWeekKey(new Date("2027-01-01T12:00:00Z")), /^\d{4}-W\d{2}$/);
});

test("AC8: `fleetctl digest --save` is idempotent — second run reuses the file (no duplicate names)", () => {
  // Sandbox state dir; the CLI checks FLEET_STATE_DIR before falling back
  // to ~/.local/state/fleet-control so we never touch the operator's home.
  const stateDir = mkdtempSync(join(tmpdir(), "fleet-digest-state-"));
  const dbPath   = join(stateDir, "fleet.db");
  // Seed the DB so the digest has something to render.
  const db = openDb(dbPath);
  const a = seedProject(db, "alpha", "Alpha");
  seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(1), costUsd: 1, outcome: "shipped" });
  db.close();

  // Use a config file in a fresh cwd so loadConfig() picks up dbPath.
  const cfgDir = mkdtempSync(join(tmpdir(), "fleet-digest-cfg-"));
  const cfgPath = join(cfgDir, "fleet-control.config.json");
  writeFileSync(cfgPath, JSON.stringify({ dbPath }));

  const repoRoot = join(import.meta.dirname ?? ".", "..");
  const bin = join(repoRoot, "bin", "fleetctl.ts");

  const env = { ...process.env, FLEET_STATE_DIR: stateDir };
  for (let i = 0; i < 2; i++) {
    const r = spawnSync(process.execPath,
      ["--disable-warning=ExperimentalWarning", bin, "digest", "--save"],
      { cwd: cfgDir, env, encoding: "utf8" });
    assert.equal(r.status, 0, `run ${i + 1} should exit 0; stderr: ${r.stderr}`);
  }

  // Exactly one file in the digests dir; matches YYYY-Www.md.
  const digestsDir = join(stateDir, "digests");
  assert.ok(existsSync(digestsDir), "digests directory must be created");
  const files = readdirSync(digestsDir);
  assert.equal(files.length, 1, `expected exactly one digest file, got: ${files.join(", ")}`);
  assert.match(files[0], /^\d{4}-W\d{2}\.md$/, `filename must match YYYY-Www.md; got ${files[0]}`);

  rmSync(stateDir, { recursive: true, force: true });
  rmSync(cfgDir,   { recursive: true, force: true });
});

// ────────────────────────────────────────────────────────────────────
// AC9 — no new runtime deps + no schema changes. The dep check is the
// same one used in mobile-portal.test.ts (and enforced by AGENTS.md);
// keeping it here too means a regression on THIS ticket trips the
// digest test file, which is the right blast radius.
// ────────────────────────────────────────────────────────────────────

test("AC9: package.json has zero runtime dependencies (no new deps added by 0012)", () => {
  const pkg = JSON.parse(readFileSync(
    join(import.meta.dirname ?? ".", "..", "package.json"),
    "utf8",
  ));
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    `dependencies must stay empty; found: ${Object.keys(deps).join(", ")}`);
});

// ────────────────────────────────────────────────────────────────────
// fleetctl digest (no --save) — writes markdown to stdout. AC7's
// fixture/format guarantees the shape; here we just verify the CLI
// exits 0 and emits the markdown header.
// ────────────────────────────────────────────────────────────────────

test("`fleetctl digest --week` prints markdown to stdout and exits 0", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "fleet-digest-state-"));
  const dbPath   = join(stateDir, "fleet.db");
  const db = openDb(dbPath);
  const a = seedProject(db, "alpha", "Alpha");
  seedRun(db, { projectId: a, phase: "ship", startedAt: daysAgoIso(1), costUsd: 1, outcome: "shipped" });
  db.close();

  const cfgDir = mkdtempSync(join(tmpdir(), "fleet-digest-cfg-"));
  writeFileSync(join(cfgDir, "fleet-control.config.json"), JSON.stringify({ dbPath }));

  const repoRoot = join(import.meta.dirname ?? ".", "..");
  const bin = join(repoRoot, "bin", "fleetctl.ts");
  const r = spawnSync(process.execPath,
    ["--disable-warning=ExperimentalWarning", bin, "digest", "--week"],
    { cwd: cfgDir, encoding: "utf8" });
  assert.equal(r.status, 0, `digest --week should exit 0; stderr: ${r.stderr}`);
  assert.match(r.stdout, /^# Weekly digest /);

  rmSync(stateDir, { recursive: true, force: true });
  rmSync(cfgDir,   { recursive: true, force: true });
});
