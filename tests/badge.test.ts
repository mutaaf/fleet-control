// Tests for the embeddable status badge (ticket 0015).
//
// Each `test(...)` maps 1:1 to one acceptance-criteria checkbox in
// docs/backlog/0015-embeddable-status-badge-svg.md. We exercise both
// the pure helpers in `src/badge.ts` (renderBadge / projectBadge) and
// the web/app.js embed-panel renderer. The HTTP route is covered in
// tests/badge-route.test.ts.
//
// Zero new runtime deps; stdlib + node:test only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../src/db.ts";
import {
  renderBadge, projectBadge, BADGE_COLORS, type BadgeMetric,
} from "../src/badge.ts";

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-badge-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string): number {
  db.prepare(
    "INSERT INTO project(slug,name,namespace) VALUES(?,?,?)",
  ).run(slug, slug, "test");
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as any).id;
}

function seedRun(db: DB, opts: {
  projectId: number; phase?: string; startedAt?: string;
  outcome?: string | null; costUsd?: number | null; sessionId?: string;
}): number {
  const sid = opts.sessionId ?? `sess-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO run(project_id,phase,session_id,started_at,outcome,cost_usd,cost_source) "
    + "VALUES(?,?,?,?,?,?, 'live')",
  ).run(
    opts.projectId, opts.phase ?? "ship", sid,
    opts.startedAt ?? new Date().toISOString(),
    opts.outcome ?? null,
    opts.costUsd ?? null,
  );
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as any).id;
}

function seedCostRollup(db: DB, opts: {
  projectId: number; phase?: string; day: string; costUsd: number;
}) {
  db.prepare(
    "INSERT OR REPLACE INTO cost_rollup_day(project_id,phase,day,runs,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd) "
    + "VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(opts.projectId, opts.phase ?? "ship", opts.day, 1, 0, 0, 0, 0, opts.costUsd);
}

function daysAgoIso(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
}

/** YYYY-MM-DD UTC bucket key compatible with cost_rollup_day rows. */
function dayBucket(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

// ────────────────────────────────────────────────────────────────────
// AC1 — renderBadge returns a complete, well-formed SVG
// ────────────────────────────────────────────────────────────────────

test("AC1: renderBadge returns a complete SVG with both label and value", () => {
  const svg = renderBadge({ label: "fleet", value: "ok", color: BADGE_COLORS.green });
  assert.ok(svg.startsWith("<svg"), "must start with <svg root");
  assert.ok(svg.includes(">fleet<") || svg.includes("'>fleet<") || svg.includes(">fleet</"),
    "label text 'fleet' must appear inside a tag");
  assert.ok(svg.includes(">ok<") || svg.includes(">ok</"),
    "value text 'ok' must appear inside a tag");
  // The green hex color from BADGE_COLORS appears.
  assert.ok(svg.toLowerCase().includes(BADGE_COLORS.green.toLowerCase()),
    "rendered SVG must carry the chosen color hex");
});

test("AC1: renderBadge produces balanced tags with a single <svg> root", () => {
  const svg = renderBadge({ label: "fleet", value: "ok", color: BADGE_COLORS.green });
  // Exactly one opening <svg and one closing </svg>.
  const opens = (svg.match(/<svg\b/g) || []).length;
  const closes = (svg.match(/<\/svg>/g) || []).length;
  assert.equal(opens, 1, "exactly one <svg root");
  assert.equal(closes, 1, "exactly one </svg> close");
  // No stray < that isn't an opening of a tag or </ end.
  // Quick well-formedness sanity: every "<" has a matching ">" before the next "<".
  for (let i = 0; i < svg.length; i++) {
    if (svg[i] === "<") {
      const gt = svg.indexOf(">", i);
      const nextLt = svg.indexOf("<", i + 1);
      assert.ok(gt !== -1 && (nextLt === -1 || gt < nextLt), `unbalanced angle bracket near offset ${i}`);
      i = gt;
    }
  }
});

test("AC1: renderBadge embeds explicit width on <svg> (stable layout, no external font metrics)", () => {
  const svg = renderBadge({ label: "fleet", value: "ok", color: BADGE_COLORS.green });
  // The width attribute MUST be present on the root <svg> so consumers
  // (GitHub, README renderers) lay it out without measuring text.
  assert.match(svg, /<svg\b[^>]*\bwidth=["']\d+["']/, "<svg> must declare a width");
  assert.match(svg, /<svg\b[^>]*\bheight=["']\d+["']/, "<svg> must declare a height");
});

// ────────────────────────────────────────────────────────────────────
// AC2 — projectBadge(db, slug, metric) returns {label,value,color} per
// metric. status / cost / ship branches.
// ────────────────────────────────────────────────────────────────────

test("AC2 status: latest run outcome=success → green ok", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "demo");
    seedRun(db, { projectId: pid, outcome: "failure", startedAt: daysAgoIso(2) });
    seedRun(db, { projectId: pid, outcome: "success", startedAt: daysAgoIso(0) });
    const b = projectBadge(db, "demo", "status");
    assert.equal(b.label, "fleet");
    assert.equal(b.value, "ok");
    assert.equal(b.color, BADGE_COLORS.green);
  } finally { cleanup(); }
});

test("AC2 status: outcome=failure → red fail", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "demo");
    seedRun(db, { projectId: pid, outcome: "failure", startedAt: daysAgoIso(0) });
    const b = projectBadge(db, "demo", "status");
    assert.equal(b.value, "fail");
    assert.equal(b.color, BADGE_COLORS.red);
  } finally { cleanup(); }
});

test("AC2 status: outcome=in-progress → yellow running", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "demo");
    seedRun(db, { projectId: pid, outcome: "in-progress", startedAt: daysAgoIso(0) });
    const b = projectBadge(db, "demo", "status");
    assert.equal(b.value, "running");
    assert.equal(b.color, BADGE_COLORS.yellow);
  } finally { cleanup(); }
});

test("AC2 status: no rows for slug → grey unknown", () => {
  const { db, cleanup } = tempDb();
  try {
    const b = projectBadge(db, "no-such", "status");
    assert.equal(b.value, "unknown");
    assert.equal(b.color, BADGE_COLORS.grey);
  } finally { cleanup(); }
});

test("AC2 cost: sums cost_rollup_day.cost_usd over last 7d; <$5 → green", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "demo");
    // $3.50 within window, $20 outside (8 days ago, should not count).
    seedCostRollup(db, { projectId: pid, day: dayBucket(0), costUsd: 1.25 });
    seedCostRollup(db, { projectId: pid, day: dayBucket(3), costUsd: 2.25 });
    seedCostRollup(db, { projectId: pid, day: dayBucket(20), costUsd: 20.00 });
    const b = projectBadge(db, "demo", "cost");
    assert.equal(b.label, "cost 7d");
    assert.match(b.value, /^\$\d+\.\d{2}$/, "cost value formatted as $NN.NN");
    assert.equal(b.value, "$3.50");
    assert.equal(b.color, BADGE_COLORS.green);
  } finally { cleanup(); }
});

test("AC2 cost: $5-$25 → yellow", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "demo");
    seedCostRollup(db, { projectId: pid, day: dayBucket(0), costUsd: 12.34 });
    const b = projectBadge(db, "demo", "cost");
    assert.equal(b.value, "$12.34");
    assert.equal(b.color, BADGE_COLORS.yellow);
  } finally { cleanup(); }
});

test("AC2 cost: >$25 → red", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "demo");
    seedCostRollup(db, { projectId: pid, day: dayBucket(0), costUsd: 30 });
    const b = projectBadge(db, "demo", "cost");
    assert.equal(b.value, "$30.00");
    assert.equal(b.color, BADGE_COLORS.red);
  } finally { cleanup(); }
});

test("AC2 ship: shipped run <24h ago → green relative-age", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "demo");
    // 3 hours ago.
    const ts = new Date(Date.now() - 3 * 3600_000).toISOString();
    seedRun(db, { projectId: pid, outcome: "shipped", startedAt: ts });
    const b = projectBadge(db, "demo", "ship");
    assert.equal(b.label, "shipped");
    assert.match(b.value, /^[0-9]+[mhd]$/, "ship value formatted as Nm/Nh/Nd");
    assert.equal(b.color, BADGE_COLORS.green);
    assert.ok(b.value.endsWith("h"), "3h ago should be in hours");
  } finally { cleanup(); }
});

test("AC2 ship: shipped run <7d but >24h → yellow", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "demo");
    const ts = new Date(Date.now() - 3 * 86_400_000).toISOString();
    seedRun(db, { projectId: pid, outcome: "shipped", startedAt: ts });
    const b = projectBadge(db, "demo", "ship");
    assert.equal(b.color, BADGE_COLORS.yellow);
    assert.ok(b.value.endsWith("d"));
  } finally { cleanup(); }
});

test("AC2 ship: shipped run >7d → red", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "demo");
    const ts = new Date(Date.now() - 10 * 86_400_000).toISOString();
    seedRun(db, { projectId: pid, outcome: "shipped", startedAt: ts });
    const b = projectBadge(db, "demo", "ship");
    assert.equal(b.color, BADGE_COLORS.red);
  } finally { cleanup(); }
});

test("AC2 ship: no shipped runs → 'never' / grey", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "demo");
    // A failure-only run still leaves ship value "never".
    seedRun(db, { projectId: pid, outcome: "failure", startedAt: daysAgoIso(0) });
    const b = projectBadge(db, "demo", "ship");
    assert.equal(b.value, "never");
    assert.equal(b.color, BADGE_COLORS.grey);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — SVG body never carries host/IP info (host-neutral payload).
// ────────────────────────────────────────────────────────────────────

test("AC7: renderBadge body contains no operator hostname, IP, or origin URL", () => {
  const svg = renderBadge({ label: "fleet", value: "ok", color: BADGE_COLORS.green });
  // Strip the SVG's required namespace declaration before checking — the
  // W3C URI is a globally-fixed identifier baked into the SVG spec, not an
  // operator-controlled origin. Removing it lets us assert the stronger
  // "no http(s)://anything" rule on the actual badge bytes.
  const checkable = svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "");
  const lower = checkable.toLowerCase();
  assert.equal(lower.includes("localhost"), false, "no localhost literal");
  assert.equal(lower.includes("127.0.0.1"), false, "no IPv4 loopback literal");
  assert.equal(lower.includes("http://"), false, "no http:// scheme outside the SVG namespace");
  assert.equal(lower.includes("https://"), false, "no https:// scheme");
  // Also no obvious IP literal pattern.
  assert.equal(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(checkable), false, "no IPv4 literal");
});

// ────────────────────────────────────────────────────────────────────
// AC5 — web/app.js embed panel: a button per metric + textarea content
// that matches the expected /badge/<slug>.svg URL pattern.
// ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_JS = readFileSync(join(__dirname, "..", "web", "app.js"), "utf8");

test("AC5: web/app.js carries a renderEmbedPanel(slug) helper", () => {
  // The helper must exist by name so the project view can call it. We
  // grep on the function declaration, not just the call site.
  assert.match(APP_JS, /function\s+renderEmbedPanel\s*\(/,
    "web/app.js must declare function renderEmbedPanel(...)");
});

test("AC5: embed panel emits one [data-metric] button per metric", () => {
  // The helper interpolates the slug and reads `location.origin` to
  // build the README URL. We run its source through a tiny harness:
  // extract the function body via regex, eval inside Function() with
  // a stub `esc` shim AND a `location` shim. Cheaper than JSDOM.
  const m = APP_JS.match(/function\s+renderEmbedPanel\s*\(\s*slug\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, "must find renderEmbedPanel body");
  const body = m![1];
  const fn = new Function(
    "slug", "location",
    "const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));"
    + body,
  );
  const html = String(fn("demo", { origin: "http://example.test:7070" }));
  for (const metric of ["status", "cost", "ship"]) {
    const re = new RegExp(`<button[^>]*\\bdata-metric=["']${metric}["']`);
    assert.match(html, re, `must include a [data-metric="${metric}"] button`);
  }
  // Each metric's markdown snippet matches /badge/<slug>.svg?metric=<X>
  assert.ok(html.includes("/badge/demo.svg"), "embed panel must reference /badge/<slug>.svg");
  for (const metric of ["status", "cost", "ship"]) {
    assert.ok(html.includes(`metric=${metric}`), `embed panel must include ?metric=${metric}`);
  }
  // The clipboard fallback uses a real text snippet — assert the
  // textarea content carries the markdown shape verbatim.
  assert.ok(html.includes("![fleet-control]("), "must use markdown image syntax");
});

// ────────────────────────────────────────────────────────────────────
// AC6 (engineering hygiene): no /api JSON-shape change.
// We pin the shape by reading the SPA's known fetcher calls; if a future
// PR breaks one of these, this assertion catches it.
// ────────────────────────────────────────────────────────────────────

test("AC6: no new /api/... fetch call lands in app.js for the badge work", () => {
  // The badge route lives at /badge/<slug>.svg — NOT under /api. The
  // embed panel never fetches it from the SPA; the operator pastes
  // the URL into a README. So app.js MUST NOT introduce a fetch to
  // /api/badge or /api/embed.
  assert.equal(APP_JS.includes("/api/badge"), false, "no /api/badge fetch should be introduced");
  assert.equal(APP_JS.includes("/api/embed"), false, "no /api/embed fetch should be introduced");
});

// ────────────────────────────────────────────────────────────────────
// Defence: metric enum coverage. A future contributor renaming a
// metric without updating both ends should land loudly here.
// ────────────────────────────────────────────────────────────────────

test("metric enum coverage: all three metrics resolve cleanly on an empty DB", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "demo");
    for (const metric of ["status", "cost", "ship"] as BadgeMetric[]) {
      const b = projectBadge(db, "demo", metric);
      assert.ok(typeof b.label === "string" && b.label.length > 0, `label for ${metric}`);
      assert.ok(typeof b.value === "string" && b.value.length > 0, `value for ${metric}`);
      assert.ok(typeof b.color === "string" && /^#[0-9a-f]{6}$/i.test(b.color), `hex color for ${metric}`);
    }
  } finally { cleanup(); }
});
