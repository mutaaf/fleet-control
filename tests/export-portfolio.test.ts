// Tests for fleetctl export portfolio (ticket 0070).
//
// One test() per acceptance-criteria checkbox in
// docs/backlog/0070-fleetctl-export-portfolio-html.md. We exercise:
//   - the pure helper composePortfolioHtml({ profile, lessons,
//     receipts, now, includeLessons, includeReceipts }) directly,
//   - the in-process driver runExportPortfolioCli with the writer
//     seam swapped via _setExportWriterForTests so disk side-effects
//     stay out of every test,
//   - the CLI subcommand wiring via spawnSync against bin/fleetctl.ts
//     with FLEET_DB_PATH pointing at a tmpdir DB + a tmpdir-pinned
//     cwd carrying fleet-control.config.json (per LESSONS 2026-06-19
//     "testing loadConfig() with a non-default config: spawn a
//     subprocess pinned to a tmpdir cwd").
//
// PRODUCER-VS-SPEC per LESSONS 2026-06-05: every column-value literal
// here matches the production ingester / writer:
//   - pr.state = 'MERGED' uppercase per src/ingest/prs.ts:235 +
//     src/views.ts operatorProfilePayload, fleetYearInReview etc.
//   - lesson_credit columns are lowercase per src/db.ts.
//   - receipts_published payload_json is a JSON string of
//     ReceiptsPayload per src/receipts.ts:persistReceipts.
//
// Per LESSONS 2026-05-29 every seed timestamp anchors to the pinned
// NOW constant - never new Date().
// Per LESSONS 2026-06-15 the static-grep no-script + no-stylesheet
// assertions anchor on the EXACT statement shape (the literal
// substrings '<script src=' and '<link rel="stylesheet"') so a prose
// comment mentioning the gate cannot trip the test.
//
// Zero new runtime deps; stdlib + node:test only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../src/db.ts";
import type { FleetConfig } from "../src/config.ts";
import {
  composePortfolioHtml,
  runExportPortfolioCli,
  runExportHelp,
  _setExportWriterForTests,
  _resetExportWriterForTests,
} from "../src/export.ts";
import {
  operatorProfilePayload,
  type OperatorProfilePayload,
  type LessonCreditByLesson,
} from "../src/views.ts";
import type { ReceiptsPayload } from "../src/receipts.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// Pinned anchor: 2026-06-19 (ticket creation date).
const NOW = new Date("2026-06-19T12:00:00.000Z");
const SINCE_DATE = "2025-11-01";
const HANDLE = "mutaaf";

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; dir: string; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-export-portfolio-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return {
    db, dir, path,
    cleanup: () => {
      try { db.close(); } catch { /* may already be closed */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedProject(db: DB, slug: string, name?: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
  ).run(slug, name ?? slug, "test", null);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

function seedMergedPr(db: DB, opts: {
  projectId: number; number: number; title?: string; fetchedAt: string;
}): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,additions,deletions,author,url,fetched_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, opts.title ?? `pr-${opts.number}`,
    `feat/${opts.number}`,
    "MERGED", "green", null, 1, 0, 0, "a",
    `https://example/owner/x/pull/${opts.number}`, opts.fetchedAt,
  );
}

function seedLessonCredit(db: DB, opts: {
  slug: string; date: string; title: string; createdAt: string;
  healAuditId: number; projectSlug: string;
}): void {
  db.prepare(
    "INSERT INTO control_audit(id, ts, actor, action, target, args_json, exit_code, stdout_tail)"
    + " VALUES (?, ?, 'local', 'heal', ?, '{}', 0, '')",
  ).run(opts.healAuditId, opts.createdAt, `${opts.projectSlug}/0`);
  db.prepare(
    "INSERT INTO lesson_credit(lesson_slug, lesson_date, lesson_title, heal_audit_id, project_slug, matched_substring, created_at)"
    + " VALUES (?,?,?,?,?,?,?)",
  ).run(opts.slug, opts.date, opts.title, opts.healAuditId, opts.projectSlug, "needle", opts.createdAt);
}

function seedPublishedReceipt(db: DB, opts: {
  slug: string; month: string; mergedPrs: number; spend: number;
  publishedAt: string;
}): void {
  const payload: ReceiptsPayload = {
    found: true,
    project_slug: opts.slug,
    project_label: opts.slug,
    month_iso: opts.month,
    month_label: opts.month,
    merged_prs: opts.mergedPrs,
    total_spend_usd: opts.spend,
    cost_per_pr_usd: opts.mergedPrs > 0 ? opts.spend / opts.mergedPrs : null,
    red_days: 0,
    top_mover: null,
    generated_at: opts.publishedAt,
  };
  db.prepare(
    "INSERT OR REPLACE INTO receipts_published(project_slug, month_iso, published_at, payload_json)"
    + " VALUES (?,?,?,?)",
  ).run(opts.slug, opts.month, opts.publishedAt, JSON.stringify(payload));
}

function makeOperatorCfg(extra?: Partial<NonNullable<FleetConfig["operator"]>>): FleetConfig {
  return {
    projectRoots: [],
    installedRoot: "/tmp/empty",
    dbPath: "/tmp/empty/fleet.db",
    cacheBase: "/tmp/empty",
    claudeProjects: "/tmp/empty",
    host: "127.0.0.1",
    port: 7070,
    operator: {
      handle: HANDLE,
      displayName: "Mutaaf",
      headline: "running an autonomous agent fleet on personal projects",
      sinceDate: SINCE_DATE,
      ...extra,
    },
  };
}

function emptyCfgNoOperator(): FleetConfig {
  return {
    projectRoots: [],
    installedRoot: "/tmp/empty",
    dbPath: "/tmp/empty/fleet.db",
    cacheBase: "/tmp/empty",
    claudeProjects: "/tmp/empty",
    host: "127.0.0.1",
    port: 7070,
  };
}

/** Seed a fleet with at least one merged PR + a non-empty project so
 *  operatorProfilePayload returns a populated payload (not the
 *  warming-up zero-PR branch). Used by the CLI subprocess tests. */
function seedPopulatedFleet(db: DB): OperatorProfilePayload {
  const p = seedProject(db, "alpha");
  seedMergedPr(db, { projectId: p, number: 1, title: "first ship", fetchedAt: "2026-06-01T10:00:00.000Z" });
  seedMergedPr(db, { projectId: p, number: 2, title: "second ship", fetchedAt: "2026-06-10T10:00:00.000Z" });
  seedLessonCredit(db, {
    slug: "the-tail-test-lesson", date: "2026-06-01",
    title: "lesson title alpha", createdAt: "2026-06-15T10:00:00.000Z",
    healAuditId: 1, projectSlug: "alpha",
  });
  seedLessonCredit(db, {
    slug: "another-lesson", date: "2026-06-02",
    title: "lesson title beta", createdAt: "2026-06-16T10:00:00.000Z",
    healAuditId: 2, projectSlug: "alpha",
  });
  seedPublishedReceipt(db, {
    slug: "alpha", month: "2026-06", mergedPrs: 2, spend: 8.50,
    publishedAt: "2026-06-18T10:00:00.000Z",
  });
  const cfg = makeOperatorCfg();
  const payload = operatorProfilePayload(db, cfg, NOW);
  if (!payload) throw new Error("seed: operatorProfilePayload returned null");
  return payload;
}

function runCliSubprocess(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    join(REPO_ROOT, "bin", "fleetctl.ts"),
    ...args,
  ], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

// ────────────────────────────────────────────────────────────────────
// AC1 - fleetctl export portfolio writes the --out path; CLI exits 0.
//
// Per LESSONS 2026-06-19 the CLI subprocess test pins cwd to a tmpdir
// + drops fleet-control.config.json there so loadConfig() picks up
// the operator handle / sinceDate WITHOUT contaminating the shared
// test runner cwd.
// ────────────────────────────────────────────────────────────────────

test("AC1: fleetctl export portfolio writes the --out path; CLI exits 0", () => {
  const ctx = tempDb();
  try {
    seedPopulatedFleet(ctx.db);
    ctx.db.close();
    // Write the operator config in the tmpdir-pinned cwd.
    const cfgPath = join(ctx.dir, "fleet-control.config.json");
    writeFileSync(cfgPath, JSON.stringify({
      operator: {
        handle: HANDLE, displayName: "Mutaaf",
        headline: "running an autonomous agent fleet",
        sinceDate: SINCE_DATE,
      },
    }), "utf8");
    const outPath = join(ctx.dir, "portfolio-out.html");
    const r = runCliSubprocess(ctx.dir, ["export", "portfolio", "--out", outPath], {
      FLEET_DB_PATH: ctx.path,
    });
    assert.equal(r.code, 0, `CLI must exit 0; stderr=${r.stderr}; stdout=${r.stdout}`);
    assert.ok(existsSync(outPath), `the --out path must exist after the CLI ran; stderr=${r.stderr}`);
    assert.match(r.stdout, /wrote /, "stdout must include the wrote-line");
    const html = readFileSync(outPath, "utf8");
    assert.match(html, /^<!DOCTYPE html>/, "written file must start with the DOCTYPE");
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 - composePortfolioHtml returns the documented shape.
// ────────────────────────────────────────────────────────────────────

test("AC2: composePortfolioHtml returns DOCTYPE + <style> + OG data: URI + manifest", () => {
  const profile: OperatorProfilePayload = {
    handle: HANDLE, displayName: "Mutaaf",
    headline: "running an autonomous agent fleet",
    sinceDate: SINCE_DATE, publicHost: "",
    totals: { lifetimePrsShipped: 4, lessonsAuthored: 2, projectsActive: 1, monthsRunning: 7 },
    recentShips: [], topLessons: [],
    attribution: "anonymised", quietHoursActive: false,
    referralsIntroduced: 0,
    asOf: NOW.toISOString(), version: 1,
  };
  const html = composePortfolioHtml({
    profile, lessons: [], receipts: [], now: NOW,
    includeLessons: true, includeReceipts: true,
  });
  assert.ok(html.startsWith("<!DOCTYPE html>"), "must start with DOCTYPE");
  assert.match(html, /<style>/, "must inline a <style> block");
  assert.match(html, /<img alt="[^"]*" src="data:image\/svg\+xml;base64,/, "must inline the OG card as a data: URI");
  assert.match(html, /<!-- fleet-control portfolio export, version 1, generated/, "must end with the manifest comment block");
  assert.ok(html.trimEnd().endsWith("-->"), "the manifest comment block must close the document");
});

// ────────────────────────────────────────────────────────────────────
// AC3 - The OG card data: URI base64-decodes back to a string
//       containing <svg.
// ────────────────────────────────────────────────────────────────────

test("AC3: OG card data: URI decodes via Buffer.from(b64, 'base64') to a string containing <svg", () => {
  const profile: OperatorProfilePayload = {
    handle: HANDLE, displayName: "Mutaaf",
    headline: "running an autonomous agent fleet",
    sinceDate: SINCE_DATE, publicHost: "",
    totals: { lifetimePrsShipped: 4, lessonsAuthored: 2, projectsActive: 1, monthsRunning: 7 },
    recentShips: [], topLessons: [],
    attribution: "anonymised", quietHoursActive: false,
    referralsIntroduced: 0,
    asOf: NOW.toISOString(), version: 1,
  };
  const html = composePortfolioHtml({
    profile, lessons: [], receipts: [], now: NOW,
    includeLessons: true, includeReceipts: true,
  });
  const m = html.match(/<img alt="[^"]*" src="data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)"/);
  assert.ok(m, "must find the data: URI base64 capture");
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  assert.match(decoded, /<svg/, "the decoded base64 must contain <svg");
});

// ────────────────────────────────────────────────────────────────────
// AC4 - No external fetches at view time. The rendered HTML contains
//       ZERO `<script src=` AND ZERO `<link rel="stylesheet"` AND
//       ZERO `<img src="http`.
//
// Per LESSONS 2026-06-15 the static-grep anchors on the EXACT
// statement shape (the literal substring with the attribute prefix)
// so a prose comment mentioning the gate cannot trip the assertion.
// ────────────────────────────────────────────────────────────────────

test("AC4: composed HTML contains zero <script src=, zero <link rel=stylesheet, zero <img src=http", () => {
  const profile: OperatorProfilePayload = {
    handle: HANDLE, displayName: "Mutaaf",
    headline: "running an autonomous agent fleet",
    sinceDate: SINCE_DATE, publicHost: "",
    totals: { lifetimePrsShipped: 4, lessonsAuthored: 2, projectsActive: 1, monthsRunning: 7 },
    recentShips: [], topLessons: [],
    attribution: "anonymised", quietHoursActive: false,
    referralsIntroduced: 0,
    asOf: NOW.toISOString(), version: 1,
  };
  const html = composePortfolioHtml({
    profile, lessons: [], receipts: [], now: NOW,
    includeLessons: true, includeReceipts: true,
  });
  assert.equal(html.indexOf("<script src="), -1, "must not embed <script src=");
  assert.equal(html.indexOf("<link rel=\"stylesheet\""), -1, "must not embed <link rel=stylesheet");
  assert.equal(html.indexOf("<img src=\"http"), -1, "must not embed <img src=http");
});

// ────────────────────────────────────────────────────────────────────
// AC5 - Manifest comment block at the END of the document. Values
//       come from the profile payload's totals.
// ────────────────────────────────────────────────────────────────────

test("AC5: manifest line present with version=1 and totals matching the seed", () => {
  const profile: OperatorProfilePayload = {
    handle: HANDLE, displayName: "Mutaaf",
    headline: "running an autonomous agent fleet",
    sinceDate: SINCE_DATE, publicHost: "",
    totals: { lifetimePrsShipped: 17, lessonsAuthored: 5, projectsActive: 3, monthsRunning: 7 },
    recentShips: [], topLessons: [],
    attribution: "anonymised", quietHoursActive: false,
    referralsIntroduced: 0,
    asOf: NOW.toISOString(), version: 1,
  };
  const html = composePortfolioHtml({
    profile, lessons: [], receipts: [], now: NOW,
    includeLessons: true, includeReceipts: true,
  });
  const expectedManifest = `<!-- fleet-control portfolio export, version 1, generated ${NOW.toISOString()}, lifetime_prs 17, lessons 5, months 7 -->`;
  assert.ok(html.includes(expectedManifest), `must include manifest line with totals; got tail:\n${html.slice(-300)}`);
  // The manifest must close the document.
  assert.ok(html.trimEnd().endsWith(expectedManifest), "manifest must be the closing element");
});

// ────────────────────────────────────────────────────────────────────
// AC6 - Empty-state branches:
//        - zero lifetime PRs renders the warming-up testid + honest
//          empty-state lines.
//        - --include-lessons=false omits the lessons section.
//        - --include-receipts=false omits the receipts section.
// ────────────────────────────────────────────────────────────────────

test("AC6: zero lifetime PRs renders warming-up testid alongside empty sections", () => {
  const profile: OperatorProfilePayload = {
    handle: HANDLE, displayName: "Mutaaf",
    headline: "running an autonomous agent fleet",
    sinceDate: SINCE_DATE, publicHost: "",
    totals: { lifetimePrsShipped: 0, lessonsAuthored: 0, projectsActive: 0, monthsRunning: 0 },
    recentShips: [], topLessons: [],
    attribution: "anonymised", quietHoursActive: false,
    referralsIntroduced: 0,
    asOf: NOW.toISOString(), version: 1,
  };
  const html = composePortfolioHtml({
    profile, lessons: [], receipts: [], now: NOW,
    includeLessons: true, includeReceipts: true,
  });
  assert.match(html, /data-testid="operator-profile-warming-up"/, "warming-up testid must appear when lifetimePrsShipped=0");
  assert.match(html, /no receipts published yet/, "receipts empty-state line must appear");
  assert.match(html, /no lessons credited yet/, "lessons empty-state line must appear");
});

test("AC6: --include-lessons=false omits the lessons section entirely", () => {
  const ctx = tempDb();
  try {
    seedPopulatedFleet(ctx.db);
    let captured = "";
    _setExportWriterForTests((_p, html) => { captured = html; });
    try {
      const cfg = makeOperatorCfg();
      const r = runExportPortfolioCli({
        db: ctx.db, cfg,
        argv: ["--include-lessons=false"],
        now: NOW,
      });
      assert.equal(r.exitCode, 0, `CLI must exit 0; stderr=${r.stderr}`);
      assert.ok(captured.length > 0, "writer seam must be invoked");
      assert.equal(captured.indexOf("data-testid=\"portfolio-lessons-section\""), -1, "lessons section testid must be ABSENT");
      // The receipts section is still present (default true).
      assert.notEqual(captured.indexOf("data-testid=\"portfolio-receipts-section\""), -1, "receipts section testid must still be present");
    } finally { _resetExportWriterForTests(); }
  } finally { ctx.cleanup(); }
});

test("AC6: --include-receipts=false omits the receipts section entirely", () => {
  const ctx = tempDb();
  try {
    seedPopulatedFleet(ctx.db);
    let captured = "";
    _setExportWriterForTests((_p, html) => { captured = html; });
    try {
      const cfg = makeOperatorCfg();
      const r = runExportPortfolioCli({
        db: ctx.db, cfg,
        argv: ["--include-receipts=false"],
        now: NOW,
      });
      assert.equal(r.exitCode, 0, `CLI must exit 0; stderr=${r.stderr}`);
      assert.equal(captured.indexOf("data-testid=\"portfolio-receipts-section\""), -1, "receipts section testid must be ABSENT");
      assert.notEqual(captured.indexOf("data-testid=\"portfolio-lessons-section\""), -1, "lessons section testid must still be present");
    } finally { _resetExportWriterForTests(); }
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 - Missing-handle gate: exits 1 + writes the exact stderr line +
//       writes no file.
// ────────────────────────────────────────────────────────────────────

test("AC7: missing operator.handle exits 1, writes the stderr line, writes no file", () => {
  const ctx = tempDb();
  try {
    let invoked = false;
    _setExportWriterForTests(() => { invoked = true; });
    try {
      const cfg = emptyCfgNoOperator();
      const r = runExportPortfolioCli({
        db: ctx.db, cfg,
        argv: [],
        now: NOW,
      });
      assert.equal(r.exitCode, 1, "exit code must be 1");
      assert.match(r.stderr, /set operator\.handle in fleet-control\.config\.json to enable the portfolio export/);
      assert.equal(invoked, false, "writer seam must not be invoked");
      assert.equal(r.writtenPath, "", "writtenPath must be empty");
    } finally { _resetExportWriterForTests(); }
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC8 - Path safety: --out=../etc/passwd exits 1 + stderr line.
// ────────────────────────────────────────────────────────────────────

test("AC8: --out path with .. traversal segment is rejected with exit 1 + the stderr line", () => {
  const ctx = tempDb();
  try {
    seedPopulatedFleet(ctx.db);
    let invoked = false;
    _setExportWriterForTests(() => { invoked = true; });
    try {
      const cfg = makeOperatorCfg();
      const r = runExportPortfolioCli({
        db: ctx.db, cfg,
        argv: ["--out=../etc/passwd"],
        now: NOW,
      });
      assert.equal(r.exitCode, 1, "exit code must be 1 on traversal reject");
      assert.match(r.stderr, /invalid --out path: traversal segments not allowed/);
      assert.equal(invoked, false, "writer must not be invoked on a rejected path");
    } finally { _resetExportWriterForTests(); }
  } finally { ctx.cleanup(); }
});

test("AC8: --out path with \\0 NUL byte is rejected with exit 1 + the stderr line", () => {
  const ctx = tempDb();
  try {
    seedPopulatedFleet(ctx.db);
    let invoked = false;
    _setExportWriterForTests(() => { invoked = true; });
    try {
      const cfg = makeOperatorCfg();
      const r = runExportPortfolioCli({
        db: ctx.db, cfg,
        argv: ["--out=portfolio\0.html"],
        now: NOW,
      });
      assert.equal(r.exitCode, 1, "exit code must be 1 on NUL byte reject");
      assert.match(r.stderr, /invalid --out path: traversal segments not allowed/);
      assert.equal(invoked, false, "writer must not be invoked on a rejected path");
    } finally { _resetExportWriterForTests(); }
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC9 - Existing-file overwrite is intentional: print stderr line,
//       write the new content, exit 0.
// ────────────────────────────────────────────────────────────────────

test("AC9: existing-file overwrite prints stderr line + writes the fresh content + exit 0", () => {
  const ctx = tempDb();
  try {
    seedPopulatedFleet(ctx.db);
    const targetPath = join(ctx.dir, "existing.html");
    writeFileSync(targetPath, "<!-- stale content -->", "utf8");

    let writtenPath = "";
    let writtenHtml = "";
    _setExportWriterForTests((p, html) => {
      writtenPath = p; writtenHtml = html;
      // Also actually write so the existsSync check in production
      // semantics is exercised (the seam only redirects the I/O
      // chokepoint - it does not skip the write).
      writeFileSync(p, html, "utf8");
    });
    try {
      const cfg = makeOperatorCfg();
      const r = runExportPortfolioCli({
        db: ctx.db, cfg,
        argv: ["--out", targetPath],
        now: NOW,
      });
      assert.equal(r.exitCode, 0, `CLI must exit 0; stderr=${r.stderr}`);
      assert.match(r.stderr, new RegExp(`overwrote existing file at ${targetPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.equal(writtenPath, targetPath);
      // Confirm the fresh manifest is in place + its generated_at is NOW.
      const onDisk = readFileSync(targetPath, "utf8");
      assert.ok(onDisk.includes(`generated ${NOW.toISOString()}`), "new file's manifest must carry the fresh generated_at");
      assert.equal(onDisk, writtenHtml, "on-disk file must match the captured HTML");
    } finally { _resetExportWriterForTests(); }
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 - fleetctl export (no args) prints help naming `portfolio`,
//        exits 0 (NOT a usage error).
// ────────────────────────────────────────────────────────────────────

test("AC10: fleetctl export (no sub-surface) prints help naming portfolio + exits 0", () => {
  const h = runExportHelp();
  assert.equal(h.exitCode, 0, "help must exit 0 (not a usage error)");
  assert.match(h.stdout, /portfolio/, "help must name 'portfolio' as a sub-surface");
  assert.match(h.stdout, /--out/, "help must list the --out flag");
});

test("AC10: fleetctl export subprocess (no sub-surface) exits 0 + names portfolio on stdout", () => {
  const ctx = tempDb();
  try {
    ctx.db.close();
    const r = runCliSubprocess(ctx.dir, ["export"], { FLEET_DB_PATH: ctx.path });
    assert.equal(r.code, 0, `CLI must exit 0 with no args; stderr=${r.stderr}`);
    assert.match(r.stdout, /portfolio/, "help block must name portfolio");
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC11 - tsc-clean + no new runtime deps + one-way imports +
//        static-grep guards anchored on statement shapes.
//
// We assert structural properties of src/export.ts here so a future
// edit that crosses a guarded boundary trips a test, not a review
// surprise:
//   - no `dependencies` entries added (read package.json).
//   - src/views.ts and src/receipts.ts do NOT import src/export.ts.
//   - src/export.ts does NOT shell out (no `node:child_process`
//     import).
// ────────────────────────────────────────────────────────────────────

test("AC11: zero new runtime deps - package.json dependencies stays empty", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  assert.deepEqual(deps, {}, "no runtime dependencies are permitted");
});

test("AC11: src/views.ts does not import src/export.ts (no function-import cycle)", () => {
  const viewsTs = readFileSync(join(REPO_ROOT, "src", "views.ts"), "utf8");
  assert.equal(viewsTs.indexOf("from \"./export.ts\""), -1, "views.ts must not import export.ts");
  assert.equal(viewsTs.indexOf("from './export.ts'"), -1, "views.ts must not import export.ts");
});

test("AC11: src/receipts.ts does not import src/export.ts (no function-import cycle)", () => {
  const receiptsTs = readFileSync(join(REPO_ROOT, "src", "receipts.ts"), "utf8");
  assert.equal(receiptsTs.indexOf("from \"./export.ts\""), -1, "receipts.ts must not import export.ts");
  assert.equal(receiptsTs.indexOf("from './export.ts'"), -1, "receipts.ts must not import export.ts");
});

test("AC11: src/export.ts does not shell out (no node:child_process import)", () => {
  const exportTs = readFileSync(join(REPO_ROOT, "src", "export.ts"), "utf8");
  assert.equal(exportTs.indexOf("from \"node:child_process\""), -1, "export.ts must not import node:child_process");
  assert.equal(exportTs.indexOf("from 'node:child_process'"), -1, "export.ts must not import node:child_process");
});

// ────────────────────────────────────────────────────────────────────
// Integration sanity - composer with real lessons + receipts produces
// the right testids without crashing. Helps prove the composer's
// downstream consumers see a well-shaped result for the populated
// fleet case (the AC1 subprocess test asserts only existence).
// ────────────────────────────────────────────────────────────────────

test("integration: composer renders portfolio-receipt-* + portfolio-lesson-* testids on a populated fleet", () => {
  const ctx = tempDb();
  try {
    const profile = seedPopulatedFleet(ctx.db);
    const lessons: LessonCreditByLesson[] = [
      { lesson_slug: "lesson-a", lesson_date: "2026-06-01", lesson_title: "title-a", saves: 5, projects: 2, last_seen: "2026-06-15T10:00:00Z" },
      { lesson_slug: "lesson-b", lesson_date: "2026-06-02", lesson_title: "title-b", saves: 3, projects: 1, last_seen: "2026-06-14T10:00:00Z" },
    ];
    const receipts: ReceiptsPayload[] = [
      {
        found: true, project_slug: "alpha", project_label: "alpha",
        month_iso: "2026-06", month_label: "June 2026",
        merged_prs: 2, total_spend_usd: 8.5, cost_per_pr_usd: 4.25,
        red_days: 0, top_mover: null, generated_at: NOW.toISOString(),
      },
    ];
    const html = composePortfolioHtml({
      profile, lessons, receipts, now: NOW,
      includeLessons: true, includeReceipts: true,
    });
    assert.match(html, /data-testid="portfolio-receipt-0"/, "receipts row testid must appear");
    assert.match(html, /data-testid="portfolio-lesson-0"/, "lessons row testid must appear");
    assert.match(html, /title-a/, "lesson title must render");
    assert.match(html, /June 2026/, "receipt month label must render");
    assert.match(html, /data-testid="portfolio-totals"/, "totals block must render on populated fleet");
  } finally { ctx.cleanup(); }
});
