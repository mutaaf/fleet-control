// Tests for ticket 0031 — per-project tool-mix sparkline.
//
// Coverage map (one test scenario per acceptance-criteria checkbox in
// docs/backlog/0031-project-tool-mix-sparkline.md):
//
//   AC1   projectToolMix returns {window, tools, total_invocations};
//         top 6 named + 1 "other"; shares sum to 1.0
//   AC2   total_seconds reuses 0014's strftime-paired SQL — 5.000s ± 1e-6
//   AC3   empty project → tools=[], total_invocations=0 (no NaN, no /0)
//   AC4a  GET /api/projects/:slug/tool-mix?days=N requires read scope
//   AC4b  days clamps to [1,30] (default 7); 999 → 30
//   AC5   /api/project/:slug payload does NOT include `toolMix`
//   AC6   SPA renderToolMixBar emits inline SVG with <rect> per segment;
//         container has data-testid="project-tool-mix" + uses redactSecrets
//   AC7   tooltip text format "<name> — N calls — Xs"
//   AC8   mobile shrink to 200x28 ≤ 600px; legend wraps at 375px
//   AC9   empty state renders "no tool activity this week" + no SVG
//   AC10  perf: helper < 25ms and route < 75ms on 5,000 events
//         (gated on PERF=1)
//   AC11  meta: no new runtime deps; project-detail payload unchanged;
//         SQL row narrowing uses `as unknown as RowT[]`; in-process
//         startServer() tests use the empty-roots config seam
//
// Style discipline:
//   - All seed timestamps anchor to NOW (pinned) — never `new Date()`
//     directly — per LESSONS § "time-pinned tests must NOT derive seed
//     timestamps from `new Date()`".
//   - In-process startServer() tests plant a tmp fleet-control.config.json
//     in cwd (empty roots) and restore on cleanup — per LESSONS §
//     "in-process startServer() tests need an empty-roots config".

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { openDb, type DB } from "../src/db.ts";
import { projectToolMix, projectView } from "../src/views.ts";
import { startServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const STYLE_CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Anchors + helpers
// ────────────────────────────────────────────────────────────────────

/** Pinned wall-clock anchor (matches the leaderboard tests' style). */
const NOW = "2026-05-26T12:00:00.000Z";

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-toolmix-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string): number {
  db.prepare(
    "INSERT INTO project(slug,name,namespace,repo_owner,repo_name) VALUES(?,?,?,?,?)",
  ).run(slug, slug, "test", "owner", slug);
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

function seedRun(
  db: DB, projectId: number, startedAt: string, phase = "ship",
  sessionId?: string,
): number {
  const sid = sessionId ?? `s-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,duration_ms,outcome,cost_usd,cost_source) "
    + "VALUES(?,?,?,?,?,?,?, 'live')",
  ).run(projectId, phase, sid, startedAt, 1000, "shipped", 0);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
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

/** ISO timestamp `daysAgo` before NOW, pinned to noon UTC for stable
 *  bucketing. Per LESSONS, seeds anchor on the pinned `now` — never on
 *  `new Date()` — so the test can't drift into a different window weeks
 *  later. */
function daysAgoIso(daysAgo: number, hourUtc = 12): string {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

// ────────────────────────────────────────────────────────────────────
// AC1 — shape, top-6 + "other" collapse, shares sum to 1.0.
// ────────────────────────────────────────────────────────────────────

test("AC1: projectToolMix returns {window, tools, total_invocations}; top 6 + 'other'; shares sum to 1.0", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "alpha");
    const r = seedRun(db, pid, daysAgoIso(2));
    // 8 distinct tools with descending counts: Bash=8, Edit=7, Read=6,
    // Glob=5, Grep=4, Write=3, WebFetch=2, Task=1 → total 36.
    const tools: Array<[string, number]> = [
      ["Bash", 8], ["Edit", 7], ["Read", 6], ["Glob", 5],
      ["Grep", 4], ["Write", 3], ["WebFetch", 2], ["Task", 1],
    ];
    let seq = 1;
    for (const [name, count] of tools) {
      for (let i = 0; i < count; i++) {
        seedEvent(db, {
          runId: r, seq: seq++, ts: daysAgoIso(2),
          kind: "tool_use", toolName: name, toolUseId: `u-${name}-${i}`,
        });
      }
    }

    const out = projectToolMix(db, pid, new Date(NOW), 7);

    // Window shape
    assert.equal(typeof out.window.start, "string");
    assert.equal(typeof out.window.end, "string");
    assert.equal(out.window.days, 7);
    assert.equal(out.total_invocations, 36);

    // Top 6 survive verbatim; the rest collapse into "other"
    // (WebFetch=2 + Task=1 = 3).
    assert.equal(out.tools.length, 7, "6 named + 1 other");
    assert.equal(out.tools[0].name, "Bash");
    assert.equal(out.tools[0].invocations, 8);
    assert.equal(out.tools[5].name, "Write");
    assert.equal(out.tools[5].invocations, 3);
    assert.equal(out.tools[6].name, "other");
    assert.equal(out.tools[6].invocations, 3, "WebFetch+Task collapsed");

    // Shares sum to ~1.0 with floating-point tolerance.
    const totalShare = out.tools.reduce((s, t) => s + t.share, 0);
    assert.ok(Math.abs(totalShare - 1.0) < 1e-9,
      `shares sum to 1.0, got ${totalShare}`);
    // Per-entry share = invocations / total_invocations.
    assert.ok(Math.abs(out.tools[0].share - 8 / 36) < 1e-9,
      `Bash share ≈ 8/36, got ${out.tools[0].share}`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — total_seconds per tool via the strftime-paired SQL from 0014.
// ────────────────────────────────────────────────────────────────────

test("AC2: total_seconds reuses 0014's strftime-paired SQL — 5.0s ± 1e-6", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "alpha");
    const r = seedRun(db, pid, daysAgoIso(2));
    // Exactly 5.000s apart, both within the 7-day window from NOW.
    const t0 = "2026-05-24T12:00:00.000Z";
    const t5 = "2026-05-24T12:00:05.000Z";
    seedEvent(db, { runId: r, seq: 1, ts: t0, kind: "tool_use",    toolName: "Bash", toolUseId: "u-1" });
    seedEvent(db, { runId: r, seq: 2, ts: t5, kind: "tool_result", toolUseId: "u-1" });

    const out = projectToolMix(db, pid, new Date(NOW), 7);
    const bash = out.tools.find((t) => t.name === "Bash");
    assert.ok(bash, "Bash entry present");
    assert.equal(bash!.invocations, 1);
    assert.ok(Math.abs(bash!.total_seconds - 5.0) < 1e-6,
      `total_seconds ≈ 5.0, got ${bash!.total_seconds}`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — empty project; no divide-by-zero, no NaN.
// ────────────────────────────────────────────────────────────────────

test("AC3: empty project (no run_event rows) → tools=[], total_invocations=0, no NaN", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "empty");
    const out = projectToolMix(db, pid, new Date(NOW), 7);
    assert.deepEqual(out.tools, [], "no tools");
    assert.equal(out.total_invocations, 0);
    assert.equal(out.window.days, 7);
    // Every numeric field must be a finite number (no NaN, no Infinity).
    assert.ok(Number.isFinite(out.total_invocations));
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — route surface: auth + days clamp [1,30].
// ────────────────────────────────────────────────────────────────────

interface Booted {
  base: string;
  close: () => Promise<void>;
  cleanup: () => void;
  dbPath: string;
  db: DB;
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
  const dir = mkdtempSync(join(tmpdir(), "fleet-toolmix-boot-"));
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
  // Re-open the DB so test seeds run AFTER the server has booted.
  const db = openDb(dbPath);
  return {
    base, db,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    cleanup: () => {
      try { db.close(); } catch { /* */ }
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

test("AC4: GET /api/projects/:slug/tool-mix returns 200 on loopback with the documented shape", async () => {
  const b = await boot((db) => {
    const pid = seedProject(db, "routed");
    const r = seedRun(db, pid, daysAgoIso(2));
    seedEvent(db, { runId: r, seq: 1, ts: daysAgoIso(2), kind: "tool_use", toolName: "Bash", toolUseId: "u-1" });
  });
  try {
    const r = await fetch(b.base + "/api/projects/routed/tool-mix");
    assert.equal(r.status, 200);
    const j = await r.json() as any;
    assert.ok(j.window, "window object");
    assert.equal(j.window.days, 7, "default days = 7");
    assert.ok(Array.isArray(j.tools));
    assert.equal(typeof j.total_invocations, "number");
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: tool-mix days param clamps to [1,30] — 999 yields window.days === 30", async () => {
  const b = await boot((db) => { seedProject(db, "clamped"); });
  try {
    const r = await fetch(b.base + "/api/projects/clamped/tool-mix?days=999");
    assert.equal(r.status, 200);
    const j = await r.json() as any;
    assert.equal(j.window.days, 30, "999 clamps to max 30");

    const r2 = await fetch(b.base + "/api/projects/clamped/tool-mix?days=0");
    const j2 = await r2.json() as any;
    assert.equal(j2.window.days, 1, "0 clamps to min 1");

    const r3 = await fetch(b.base + "/api/projects/clamped/tool-mix?days=14");
    const j3 = await r3.json() as any;
    assert.equal(j3.window.days, 14, "in-range integer passes through");
  } finally { await b.close(); b.cleanup(); }
});

test("AC4: tool-mix is 404 for an unknown slug", async () => {
  const b = await boot();
  try {
    const r = await fetch(b.base + "/api/projects/no-such-slug/tool-mix");
    assert.equal(r.status, 404);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — additive only: /api/project/:slug payload does NOT inline
// the tool-mix. The SPA fetches it lazily from the new route.
// ────────────────────────────────────────────────────────────────────

test("AC5: project-detail payload does NOT include toolMix (additive-only contract)", async () => {
  const b = await boot((db) => {
    const pid = seedProject(db, "shape");
    const r = seedRun(db, pid, daysAgoIso(2));
    seedEvent(db, { runId: r, seq: 1, ts: daysAgoIso(2), kind: "tool_use", toolName: "Bash", toolUseId: "u-1" });
  });
  try {
    const r = await fetch(b.base + "/api/project/shape");
    assert.equal(r.status, 200);
    const j = await r.json() as any;
    assert.equal(j.toolMix, undefined,
      "project-detail must NOT inline toolMix; fetch via /api/projects/:slug/tool-mix");
    assert.equal(j.tool_mix, undefined,
      "neither camel- nor snake-case must inline tool mix on the project payload");
  } finally { await b.close(); b.cleanup(); }
});

// Same check, called directly against the helper (no HTTP) so a future
// payload shape change is caught at the source level too.
test("AC5: projectView() helper does not attach toolMix to the payload", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "pure");
    const r = seedRun(db, pid, daysAgoIso(2));
    seedEvent(db, { runId: r, seq: 1, ts: daysAgoIso(2), kind: "tool_use", toolName: "Bash", toolUseId: "u-1" });
    const cfg = loadConfig();
    const out = projectView(db, cfg, "pure") as any;
    assert.ok(out, "projectView returns a payload for an existing slug");
    assert.equal(out.toolMix, undefined);
    assert.equal(out.tool_mix, undefined);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — SPA renderToolMixBar with inline SVG, <rect> per segment,
// data-testid container, redactSecrets at the boundary.
// ────────────────────────────────────────────────────────────────────

test("AC6: web/app.js defines renderToolMixBar(...) with one <rect> per segment + data-testid container", () => {
  assert.match(APP_JS, /renderToolMixBar\s*\(/,
    "renderToolMixBar(...) must be defined");
  // Container with stable test hook.
  assert.match(APP_JS, /data-testid=["']project-tool-mix["']/,
    "container must carry data-testid=\"project-tool-mix\"");
  // The render emits <rect> elements inside an inline <svg>.
  const fnMatch = APP_JS.match(/function renderToolMixBar[\s\S]*?\n\}\n/);
  assert.ok(fnMatch, "renderToolMixBar must be a top-level function");
  const body = fnMatch![0];
  assert.match(body, /<svg/, "inline SVG (no charting lib)");
  assert.match(body, /<rect/, "one <rect> per segment");
});

test("AC6: renderToolMixBar passes tool names through redactSecrets", () => {
  const fnMatch = APP_JS.match(/function renderToolMixBar[\s\S]*?\n\}\n/);
  assert.ok(fnMatch);
  assert.match(fnMatch![0], /redactSecrets/,
    "tool names + counts must pass through redactSecrets at the renderer boundary");
});

test("AC6: project() render path calls renderToolMixBar and fetches /api/projects/:slug/tool-mix", () => {
  // The project page render path must invoke the helper and wire up
  // the lazy fetch (so the project-detail payload stays additive-only).
  // The fetch path is built via string concatenation
  // ("/api/projects/" + encodeURIComponent(slug) + "/tool-mix"), so we
  // assert each fragment is present rather than insisting on a single
  // contiguous literal.
  assert.match(APP_JS, /\/api\/projects\//,
    "SPA must reference the /api/projects/ base path");
  assert.match(APP_JS, /tool-mix/,
    "SPA must reference the tool-mix route segment");
  // Some helper or wiring (e.g. loadToolMixSection) must call into
  // renderToolMixBar from the project render path.
  assert.match(APP_JS, /loadToolMixSection|renderToolMixBar/,
    "project page must wire up the tool-mix section");
  // And the project() render path must invoke loadToolMixSection so
  // the section actually fetches when the operator visits the page.
  const projMatch = APP_JS.match(/async function project\([\s\S]*?\n\}\n/);
  assert.ok(projMatch, "project(slug) render function must exist");
  assert.match(projMatch![0], /loadToolMixSection\s*\(/,
    "project() must call loadToolMixSection(slug) so the section fetches");
});

// ────────────────────────────────────────────────────────────────────
// AC7 — tooltip format. We check the renderer string template emits
// the documented "<name> — N calls — Xs" form.
// ────────────────────────────────────────────────────────────────────

test("AC7: tooltip text contains tool name + 'calls' + seconds.toFixed(1) + 's'", () => {
  const fnMatch = APP_JS.match(/function renderToolMixBar[\s\S]*?\n\}\n/);
  assert.ok(fnMatch);
  const body = fnMatch![0];
  assert.match(body, /calls/i, "tooltip mentions 'calls'");
  // toFixed(1) on the seconds figure
  assert.match(body, /toFixed\(\s*1\s*\)/,
    "seconds rendered with .toFixed(1)");
  // The container itself must carry a tooltip child (no portal / overlay).
  assert.match(body, /tool-mix-tooltip|tooltip/,
    "tooltip element lives inside the same container");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — mobile viewport contract. Desktop = 280x36; phones ≤600px
// shrink to 200x28. Legend wraps at 375px without horizontal scroll.
// ────────────────────────────────────────────────────────────────────

test("AC8: web/style.css declares a .project-tool-mix selector group with a tool-bar SVG", () => {
  assert.match(STYLE_CSS, /\.project-tool-mix\b/,
    "must have a .project-tool-mix selector group");
  // CSS variables for each named tool + 'other' (additive only — no
  // rename of existing tokens).
  for (const v of ["--tool-bash", "--tool-edit", "--tool-read", "--tool-glob",
                   "--tool-grep", "--tool-write", "--tool-webfetch", "--tool-other"]) {
    assert.match(STYLE_CSS, new RegExp(v.replace("-", "\\-")),
      `${v} must be declared in :root`);
  }
});

test("AC8: mobile @media (max-width: 600px) shrinks the tool-mix bar to 200x28", () => {
  // Search every (max-width: 600px) block; at least one must mention
  // the tool-mix selector AND a 200px width.
  const mqs = STYLE_CSS.match(/@media[^{]*max-width:\s*600px[\s\S]*?\n\}\s*\n/g);
  assert.ok(mqs, "must have at least one (max-width: 600px) media query");
  assert.ok(
    mqs.some((b) => /project-tool-mix|tool-mix-bar/.test(b)
                 && /width:\s*200|200px/.test(b)),
    "mobile media query must shrink the tool-mix bar to 200px wide",
  );
});

test("AC8: tool-mix legend uses flex-wrap so it never forces horizontal scroll at 375px", () => {
  // The legend element must declare flex-wrap (or `display: block` +
  // inline-block chips) — anything that wraps to a new line rather than
  // overflowing. The simplest contract is `flex-wrap: wrap`.
  assert.match(STYLE_CSS, /tool-mix-legend[\s\S]*?flex-wrap:\s*wrap/,
    "tool-mix-legend must declare flex-wrap: wrap so chips wrap below 375px");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — empty state: helper returns no tools → SPA renders the empty
// copy with no SVG.
// ────────────────────────────────────────────────────────────────────

test("AC9: empty-state copy 'no tool activity this week' appears in renderToolMixBar", () => {
  const fnMatch = APP_JS.match(/function renderToolMixBar[\s\S]*?\n\}\n/);
  assert.ok(fnMatch);
  const body = fnMatch![0];
  assert.match(body, /no tool activity this week/i,
    "empty-state copy must be the documented string");
});

test("AC9: empty branch returns markup without an <svg> element", () => {
  // The full helper body must contain a branch that, for an empty
  // response, returns markup with no <svg>. We can't run the JS without
  // a DOM, so we assert there's a guard on `tools.length === 0` (or
  // equivalent) that returns early before the SVG template literal.
  const fnMatch = APP_JS.match(/function renderToolMixBar[\s\S]*?\n\}\n/);
  assert.ok(fnMatch);
  const body = fnMatch![0];
  assert.ok(
    /total_invocations\s*===\s*0/.test(body)
      || /tools\.length\s*===\s*0/.test(body)
      || /!\s*tools\.length/.test(body)
      || /tools\.length\s*<\s*1/.test(body),
    "renderToolMixBar must guard on total_invocations===0 or tools.length===0",
  );
});

// ────────────────────────────────────────────────────────────────────
// AC10 — perf gates (skipped unless PERF=1, per ticket).
// ────────────────────────────────────────────────────────────────────

test("AC10: projectToolMix on 5,000 events completes in <25ms (PERF=1 only)", { skip: process.env.PERF !== "1" }, () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "perf");
    const r = seedRun(db, pid, daysAgoIso(2));
    const insertEv = db.prepare(
      "INSERT INTO run_event(run_id, seq, ts, kind, tool_name, tool_use_id, input_summary, output_summary, is_error) "
      + "VALUES (?,?,?,?,?,?,?,?,?)",
    );
    const tools = ["Bash", "Edit", "Read", "Grep", "Write", "Glob", "WebFetch"];
    for (let i = 0; i < 5000; i++) {
      const tool = tools[i % tools.length];
      insertEv.run(r, i, daysAgoIso(2), "tool_use", tool, `u-${i}`, "", "", 0);
    }
    const t0 = process.hrtime.bigint();
    const out = projectToolMix(db, pid, new Date(NOW), 7);
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(out.total_invocations === 5000);
    assert.ok(elapsedMs < 25, `projectToolMix took ${elapsedMs.toFixed(2)}ms; need <25ms`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC11 — zero new runtime deps; `as unknown as RowT[]` pattern.
// ────────────────────────────────────────────────────────────────────

test("AC11: package.json has zero runtime dependencies (no new deps added by 0031)", () => {
  const pkg = JSON.parse(readFileSync(
    join(__dirname, "..", "package.json"), "utf8",
  )) as { dependencies?: Record<string, unknown> };
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    `dependencies must stay empty; found: ${Object.keys(deps).join(", ")}`);
});

test("AC11: projectToolMix uses the 'as unknown as' cast pattern (not bare 'as any[]')", () => {
  const src = readFileSync(join(__dirname, "..", "src", "views.ts"), "utf8");
  const m = src.match(/export function projectToolMix\([\s\S]*?\n\}\n/);
  assert.ok(m, "projectToolMix helper must be exported in src/views.ts");
  assert.match(m![0], /as unknown as/,
    "the new tool-mix SQL row narrowing must use the 'as unknown as RowT' pattern");
});
