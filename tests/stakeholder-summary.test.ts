// Tests for ticket 0066 - Monthly stakeholder summary at a signed
// share URL.
//
// One test() per acceptance-criteria checkbox in
// docs/backlog/0066-stakeholder-monthly-summary-signed-url.md.
// Strategy mirrors the 0065 operator-profile suite:
//   - Drive the pure helper stakeholderMonthlySummary(db, cfg, now)
//     directly against a tmpdir DB for shape, branch and fallback tests.
//   - Drive composeStakeholderProse(retroPayload, operatorName)
//     directly so determinism + vocabulary scrubs are testable
//     without booting startServer().
//   - Drive renderStakeholderSummaryPage via the
//     _renderStakeholderSummaryForTests seam per LESSONS 2026-06-11
//     so the first-full-month / warming-up / empty-cta branches do
//     NOT race fleet-control.config.json in parallel test files.
//   - Boot startServer() over loopback for the integration route
//     (token lookup, 404 on unknown / revoked, content-type, testids).
//
// PRODUCER-VS-SPEC per LESSONS 2026-06-05: the 0062 helper exports as
// monthlyRetroCard(db, now) in src/retro.ts (NOT fleetMonthlyRetro as
// the ticket prose claims). The stakeholder helper is a PURE
// re-renderer over the monthlyRetroCard payload + the operator config,
// not a parallel SQL surface.
//
// Per LESSONS 2026-05-29 time-pinned tests must NOT derive seed
// timestamps from new Date(); every fixture timestamp anchors on the
// pinned NOW constant.
// Per LESSONS 2026-06-12 the rendered HTML scrape anchors on a unique
// data-testid attribute, never a greedy id= regex.
// Per LESSONS 2026-06-13 the helper lives INSIDE src/views.ts; the
// route layer in src/server.ts is the only consumer. retro.ts does
// not import from views.ts so the new views.ts -> retro.ts edge is
// cycle-safe.
// Per LESSONS 2026-06-15 the static-grep ordering assertion anchors
// on the if (path.startsWith("/api/")) statement shape, never a
// loose prose substring that a sibling comment could carry.
// Per LESSONS 2026-06-11 the cache reset + builds-counter seam is
// exported so tests can assert hit / miss semantics without stubbing
// SQL.

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
import type { FleetConfig } from "../src/config.ts";
import {
  stakeholderMonthlySummary,
  composeStakeholderProse,
  stakeholderInviteCard,
  _renderStakeholderSummaryForTests,
  type StakeholderSummary,
} from "../src/views.ts";
import { createSnapshot } from "../src/snapshot.ts";
import {
  startServer,
  _resetStakeholderSummaryCacheForTests,
  _getStakeholderSummaryCacheBuildsForTests,
} from "../src/server.ts";
import { _resetRateLimitBucketsForTests } from "../src/rate_limit.ts";
import type { MonthlyRetroPayload } from "../src/retro.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SERVER_TS = readFileSync(join(REPO_ROOT, "src", "server.ts"), "utf8");
const VIEWS_TS = readFileSync(join(REPO_ROOT, "src", "views.ts"), "utf8");
const SNAPSHOT_TS = readFileSync(join(REPO_ROOT, "src", "snapshot.ts"), "utf8");
const FLEETCTL_TS = readFileSync(join(REPO_ROOT, "bin", "fleetctl.ts"), "utf8");
const DB_TS = readFileSync(join(REPO_ROOT, "src", "db.ts"), "utf8");

// Pinned anchor: Wednesday 2026-07-01 12:00 UTC. Matches the retro
// test anchor so the "completed prior month" is June 2026 (thisMonth)
// vs May 2026 (lastMonth) - same shape as monthlyRetroCard(db, NOW)
// asserts elsewhere.
const NOW = new Date("2026-07-01T12:00:00.000Z");

function tempDb(): { db: DB; path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-stakeholder-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, path, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
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
  healAttempts?: number;
}

function seedPr(db: DB, opts: SeedPrOpts): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,"
    + "is_agent,additions,deletions,author,url,fetched_at,heal_attempts)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    opts.projectId, opts.number, `pr-${opts.number}`, `feat/${opts.number}`,
    opts.state ?? "MERGED", "green", null, 1, 0, 0, "alice",
    `https://github.com/owner/x/pull/${opts.number}`,
    opts.fetchedAt,
    opts.healAttempts ?? 0,
  );
}

/** Seed 14 merged PRs spread across 3 projects in JUNE 2026, plus
 *  4 extra trailing weeks of fringe baseline rows to clear the
 *  monthly-retro 8-distinct-weeks global gate AND the
 *  MIN_FULL_MONTH_PRS first-full-month gate (so we land on
 *  kind:'card', NOT kind:'first-full-month' or 'warming-up').
 *  Per LESSONS 2026-06-13 per-candidate fixtures must also clear
 *  the global empty-fleet gate. */
function seedFullMonthFleet(db: DB): {
  alpha: number; beta: number; gamma: number;
} {
  const alpha = seedProject(db, "alpha", "Alpha");
  const beta = seedProject(db, "beta", "Beta");
  const gamma = seedProject(db, "gamma", "Gamma");

  // June 2026: 14 merges across 3 projects, spread over 4 ISO weeks.
  // alpha: 6, beta: 5, gamma: 3 = 14 total. Same calendar month as
  // NOW (2026-07-01) - 1 = June.
  const juneDays = [
    "2026-06-02", "2026-06-04", "2026-06-08", "2026-06-10", "2026-06-12",
    "2026-06-15", "2026-06-16", "2026-06-18", "2026-06-22", "2026-06-23",
    "2026-06-25", "2026-06-27", "2026-06-28", "2026-06-29",
  ];
  const owners = [alpha, alpha, alpha, alpha, alpha, alpha, beta, beta, beta, beta, beta, gamma, gamma, gamma];
  for (let i = 0; i < juneDays.length; i++) {
    seedPr(db, {
      projectId: owners[i],
      number: 600 + i,
      fetchedAt: juneDays[i] + "T08:00:00.000Z",
    });
  }

  // May 2026: 8 merges across the 3 projects to provide a comparison
  // anchor (kind:'card' branch). lastMonth = May here.
  const mayDays = [
    "2026-05-04", "2026-05-06", "2026-05-09", "2026-05-13",
    "2026-05-18", "2026-05-22", "2026-05-26", "2026-05-29",
  ];
  for (let i = 0; i < mayDays.length; i++) {
    seedPr(db, {
      projectId: i % 3 === 0 ? alpha : (i % 3 === 1 ? beta : gamma),
      number: 500 + i,
      fetchedAt: mayDays[i] + "T08:00:00.000Z",
    });
  }

  // April / March / February / January 2026: fringe rows to clear the
  // 8-distinct-trailing-weeks gate AND to ensure that April (the
  // chronological first month >= MIN_FULL_MONTH_PRS=3) is an EARLIER
  // full month than thisMonth (June) - so the helper takes the
  // 'card' branch and not 'first-full-month'.
  const aprilDays = ["2026-04-06", "2026-04-13", "2026-04-20", "2026-04-27"]; // 4 PRs in April >= 3
  for (let i = 0; i < aprilDays.length; i++) {
    seedPr(db, {
      projectId: alpha,
      number: 400 + i,
      fetchedAt: aprilDays[i] + "T08:00:00.000Z",
    });
  }
  const fringeDays = ["2026-03-09", "2026-03-23", "2026-02-09", "2026-02-16"];
  for (let i = 0; i < fringeDays.length; i++) {
    seedPr(db, {
      projectId: alpha,
      number: 300 + i,
      fetchedAt: fringeDays[i] + "T08:00:00.000Z",
    });
  }
  return { alpha, beta, gamma };
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
      handle: "mutaaf",
      displayName: "Mutaaf",
      sinceDate: "2025-11-01",
      ...extra,
    },
  };
}

function emptyCfg(): FleetConfig {
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

// ────────────────────────────────────────────────────────────────────
// AC1 - stakeholderMonthlySummary returns the documented shape with
//       "14 features" + "3 projects" prose and NO engineer-only
//       vocabulary.
// ────────────────────────────────────────────────────────────────────

test("AC1: stakeholderMonthlySummary returns kind='card' with 14 features / 3 projects prose and no engineer-only vocabulary", () => {
  const { db, cleanup } = tempDb();
  try {
    seedFullMonthFleet(db);
    const cfg = makeOperatorCfg();

    const s = stakeholderMonthlySummary(db, cfg, NOW);

    assert.equal(s.kind, "card", `expected kind='card'; got ${s.kind}`);
    assert.equal(typeof s.prose, "string");
    assert.ok(s.prose.includes("14 features"),
      `prose MUST contain the literal "14 features"; got: ${s.prose}`);
    assert.ok(s.prose.includes("3 projects"),
      `prose MUST contain the literal "3 projects"; got: ${s.prose}`);

    // Engineer-only vocabulary scrub: the stakeholder is non-technical;
    // every banned vocabulary term in the entire payload string is a
    // bug. We check the whole serialised payload because the stake-
    // holder eyeballs every field.
    const fullText = JSON.stringify(s).toLowerCase();
    const banned = ["ship phase", "groom phase", "review phase",
      "$/pr", "sigma", "drift", "anomaly", "heal-attempt", "heal_attempt"];
    for (const b of banned) {
      assert.equal(fullText.includes(b), false,
        `payload MUST NOT contain engineer-only term "${b}"; got: ${fullText}`);
    }
    // The dollar sign by itself is also banned per the spec ("agents
    // run on a Max subscription, $ is relative not invoiced").
    assert.equal(fullText.includes("$"), false,
      `payload MUST NOT contain literal "$" - cost framing is hours saved, not dollars`);

    // Shape assertions on the documented fields.
    assert.equal(s.operatorName, "Mutaaf");
    assert.equal(s.monthIso, "2026-06");
    assert.equal(s.version, 1);
    assert.ok(s.headline.startsWith("Mutaaf"));
    assert.equal(Array.isArray(s.highlights), true);
    assert.equal(s.highlights.length, 3, "exactly three highlights per spec");
    for (const h of s.highlights) {
      assert.equal(typeof h.kind, "string");
      assert.equal(typeof h.text, "string");
    }
    assert.equal(typeof s.footer, "string");
    assert.equal(typeof s.asOf, "string");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 - composeStakeholderProse is deterministic.
// ────────────────────────────────────────────────────────────────────

test("AC2: composeStakeholderProse is deterministic over identical input", () => {
  const payload: MonthlyRetroPayload = {
    month_iso: "2026-06",
    prs_this_month: 14,
    prs_last_month: 8,
    prs_delta_pct: 75,
    spend_this_month: 12.5,
    spend_last_month: 8.0,
    spend_delta_pct: 56,
    cost_per_pr_this: 0.9,
    cost_per_pr_last: 1.0,
    cost_per_pr_delta_pct: -10,
    heal_avg_this: 0.5,
    heal_avg_last: 0.7,
    best_project_sentence: "alpha shipped 2.0x its trailing baseline this month",
    laggard_project_sentence: "gamma shipped 3 this month after averaging 5",
  };
  const a = composeStakeholderProse(payload, "Mutaaf", { projectsActive: 3 });
  const b = composeStakeholderProse(payload, "Mutaaf", { projectsActive: 3 });
  assert.equal(a, b, "composer MUST return strict-equal string on identical input");
  // Also: no engineer vocabulary in the composed prose.
  const lower = a.toLowerCase();
  for (const banned of ["ship phase", "groom", "review phase", "$/pr", "sigma", "drift", "anomaly", "heal"]) {
    assert.equal(lower.includes(banned), false,
      `composer prose MUST NOT contain "${banned}"; got: ${a}`);
  }
});

// ────────────────────────────────────────────────────────────────────
// AC3 - Route GET /share/stakeholder/<token> 200 on valid; 404 on
//       unknown / revoked.
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
  const dir = mkdtempSync(join(tmpdir(), "fleet-stakeholder-boot-"));
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

test("AC3: GET /share/stakeholder/<token> returns 200 + HTML with stakeholder-headline-prose testid; 404 on unknown / revoked", async () => {
  _resetStakeholderSummaryCacheForTests();
  _resetRateLimitBucketsForTests();

  // Seed fleet, mint a stakeholder snapshot token. We do this OUTSIDE
  // the booted server's HTTP layer (createSnapshot is exported from
  // src/snapshot.ts) so the test owns the token plaintext directly.
  const b = await boot((db) => {
    seedFullMonthFleet(db);
  }, {
    operator: { handle: "mutaaf", displayName: "Mutaaf", sinceDate: "2025-11-01" },
  });
  try {
    // Mint the stakeholder token directly against the same DB the
    // booted server uses. We open a fresh handle because the server
    // owns its own.
    const tokenDb = openDb(b.dbPath);
    let token: string;
    let prefix: string;
    try {
      const m = createSnapshot(tokenDb, {
        name: "co-founder summary",
        fleetView: null, // not used by stakeholder route - re-derived live
        kind: "stakeholder_monthly",
      });
      token = m.token;
      prefix = m.id_prefix;
    } finally { tokenDb.close(); }

    // 1. Valid token → 200 + HTML + testid.
    const ok = await fetch(b.base + "/share/stakeholder/" + token);
    assert.equal(ok.status, 200, `valid token MUST 200; got ${ok.status}`);
    assert.match(ok.headers.get("content-type") ?? "", /text\/html/,
      "content-type MUST be text/html");
    const body = await ok.text();
    assert.match(body,
      /data-testid=["']stakeholder-headline-prose["']/,
      "rendered HTML MUST carry data-testid=stakeholder-headline-prose");

    // 2. Unknown token → 404.
    const unknown = await fetch(b.base + "/share/stakeholder/" + "f".repeat(48));
    assert.equal(unknown.status, 404,
      `unknown token MUST 404; got ${unknown.status}`);

    // 3. Revoke + re-fetch → 404 (or 410-like; spec says 404 on
    //    revoked OR unknown).
    const revokeDb = openDb(b.dbPath);
    try {
      revokeDb.prepare(
        "UPDATE snapshot SET revoked_at = ? WHERE id LIKE ?",
      ).run(NOW.toISOString(), prefix + "%");
    } finally { revokeDb.close(); }

    _resetStakeholderSummaryCacheForTests();
    const revoked = await fetch(b.base + "/share/stakeholder/" + token);
    assert.equal(revoked.status, 404,
      `revoked token MUST 404; got ${revoked.status}`);
  } finally { await b.close(); b.cleanup(); }
});

// AC3 sub-assertion: the new route is mounted BEFORE the
// path.startsWith("/api/") auth gate so a remote viewer without a
// token reaches the public stakeholder page. Per LESSONS 2026-06-15
// the static-grep ordering assertion anchors on the if-statement
// shape, not the prose comment.
test("AC3: /share/stakeholder/ route is mounted BEFORE the path.startsWith(\"/api/\") auth gate", () => {
  const routeIdx = SERVER_TS.indexOf("/share/stakeholder/");
  const apiGateIdx = SERVER_TS.indexOf("if (path.startsWith(\"/api/\"))");
  assert.ok(routeIdx > 0, "stakeholder route MUST be referenced in src/server.ts");
  assert.ok(apiGateIdx > 0, "the /api/ auth gate if-statement MUST be present");
  assert.ok(routeIdx < apiGateIdx,
    `the stakeholder route (idx ${routeIdx}) MUST be mounted BEFORE the /api/ auth gate (idx ${apiGateIdx})`);
});

// ────────────────────────────────────────────────────────────────────
// AC4 - First-full-month branch via the renderer-direct seam.
// ────────────────────────────────────────────────────────────────────

test("AC4: first-full-month branch renders a soft warming-up framing and NO '<N> features shipped' number", () => {
  // Drive the renderer-direct seam per LESSONS 2026-06-11 - no
  // startServer boot, no cwd config race.
  const html = _renderStakeholderSummaryForTests(
    { kind: "first-full-month" },
    { operatorName: "Mutaaf", monthIso: "2026-06", sinceDate: "2025-11-01", asOf: NOW.toISOString() },
  );
  assert.match(html,
    /data-testid=["']stakeholder-first-full-month["']/,
    "first-full-month branch MUST carry the stakeholder-first-full-month testid");
  // No "<N> features shipped" pattern in the warming-up framing.
  assert.equal(/\d+\s+features\s+shipped/.test(html), false,
    "first-full-month framing MUST NOT contain '<N> features shipped' numeric prose");
});

// ────────────────────────────────────────────────────────────────────
// AC5 - Warming-up branch (< 8 distinct trailing weeks).
// ────────────────────────────────────────────────────────────────────

test("AC5: warming-up branch renders the stakeholder-warming-up testid and NO '<N> features shipped' number", () => {
  const html = _renderStakeholderSummaryForTests(
    { kind: "warming-up" },
    { operatorName: "Mutaaf", monthIso: "2026-06", sinceDate: "2025-11-01", asOf: NOW.toISOString() },
  );
  assert.match(html,
    /data-testid=["']stakeholder-warming-up["']/,
    "warming-up branch MUST carry the stakeholder-warming-up testid");
  assert.equal(/\d+\s+features\s+shipped/.test(html), false,
    "warming-up framing MUST NOT contain '<N> features shipped' numeric prose");
});

// Also a helper-level assertion: the helper passes through the
// retro card's kind:'warming-up' from a freshly-seeded fleet with
// only 3 weeks of data.
test("AC5: stakeholderMonthlySummary helper returns kind='warming-up' when fewer than 8 trailing weeks of PR data exist", () => {
  const { db, cleanup } = tempDb();
  try {
    const cfg = makeOperatorCfg();
    const pid = seedProject(db, "fresh", "Fresh");
    // Three weeks of PR data only.
    for (let w = 1; w <= 3; w++) {
      const d = new Date(NOW.getTime() - w * 7 * 24 * 3600_000);
      seedPr(db, {
        projectId: pid, number: w,
        fetchedAt: d.toISOString().slice(0, 10) + "T08:00:00.000Z",
      });
    }
    const s = stakeholderMonthlySummary(db, cfg, NOW);
    assert.equal(s.kind, "warming-up",
      `expected warming-up branch; got ${s.kind}`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 - Operator name fallback when displayName is undefined.
// ────────────────────────────────────────────────────────────────────

test("AC6: undefined operatorName renders 'your autonomous agent fleet' headline; named operator renders '<name>'s autonomous agent fleet'", () => {
  // Two renderer-direct calls per LESSONS 2026-06-11. The renderer
  // is pure on (result, opts) so we drive each branch directly.
  const undef = _renderStakeholderSummaryForTests(
    { kind: "warming-up" },
    { operatorName: undefined, monthIso: "2026-06", sinceDate: "2025-11-01", asOf: NOW.toISOString() },
  );
  assert.ok(undef.includes("your autonomous agent fleet"),
    "undefined operator name MUST render the 'your autonomous agent fleet' headline");
  assert.equal(undef.includes("undefined"), false,
    "the literal 'undefined' MUST NOT appear in the rendered HTML");
  assert.equal(undef.includes("anonymous"), false,
    "the placeholder 'anonymous' MUST NOT appear (per spec)");

  const named = _renderStakeholderSummaryForTests(
    { kind: "warming-up" },
    { operatorName: "Mutaaf", monthIso: "2026-06", sinceDate: "2025-11-01", asOf: NOW.toISOString() },
  );
  assert.ok(named.includes("Mutaaf"),
    "named operator MUST render their display name in the headline");
  // The renderer HTML-escapes the apostrophe to &#39; so the assertion
  // tolerates either the literal apostrophe OR the escaped form
  // (single straight quote OR &#39; OR a curly apostrophe).
  assert.ok(/Mutaaf(?:'|&#39;|’)s\s+autonomous\s+agent\s+fleet/.test(named),
    `named operator MUST render "<name>'s autonomous agent fleet"; got: ${named.slice(0, 600)}`);
});

// ────────────────────────────────────────────────────────────────────
// AC7 - CTA: informational only (no <a href>), omitted when N=0.
// ────────────────────────────────────────────────────────────────────

test("AC7: CTA renders as plain text when N>=1 (no <a href>) and is OMITTED entirely when N=0", () => {
  // Drive renderer-direct so we own the cta count. We feed a synthetic
  // 'card' payload via the test seam.
  const payloadCard: MonthlyRetroPayload = {
    month_iso: "2026-06",
    prs_this_month: 14,
    prs_last_month: 8,
    prs_delta_pct: 75,
    spend_this_month: 12.0,
    spend_last_month: 8.0,
    spend_delta_pct: 50,
    cost_per_pr_this: 0.85,
    cost_per_pr_last: 1.0,
    cost_per_pr_delta_pct: -15,
    heal_avg_this: 0.5,
    heal_avg_last: 0.7,
    best_project_sentence: "alpha shipped 2.0x its trailing baseline this month",
    laggard_project_sentence: "gamma shipped 3 this month after averaging 5",
  };
  const withTwo = _renderStakeholderSummaryForTests(
    { kind: "card", payload: payloadCard },
    {
      operatorName: "Mutaaf", monthIso: "2026-06",
      sinceDate: "2025-11-01", asOf: NOW.toISOString(),
      prsWaiting: 2, projectsActive: 3,
    },
  );
  assert.match(withTwo,
    /data-testid=["']stakeholder-cta["']/,
    "with N>=1 the CTA section MUST render");
  // The CTA line includes "2 features ready" (or similar) but NEVER a
  // hyperlink (this is a stakeholder surface; no internal links).
  // We slice out the CTA section and assert no <a href= inside it.
  const ctaSliceStart = withTwo.indexOf("data-testid=\"stakeholder-cta\"");
  const ctaSliceEnd = withTwo.indexOf("</section>", ctaSliceStart);
  assert.ok(ctaSliceStart > 0 && ctaSliceEnd > ctaSliceStart,
    "the CTA section MUST be a <section> with a closing tag");
  const ctaInner = withTwo.slice(ctaSliceStart, ctaSliceEnd);
  assert.equal(/<a\s+[^>]*href=/i.test(ctaInner), false,
    `CTA MUST NOT contain a hyperlink; got: ${ctaInner}`);
  assert.ok(/\b2\b/.test(ctaInner),
    "CTA MUST mention the 2-waiting count");

  // N=0 → the CTA section is omitted entirely.
  const withZero = _renderStakeholderSummaryForTests(
    { kind: "card", payload: payloadCard },
    {
      operatorName: "Mutaaf", monthIso: "2026-06",
      sinceDate: "2025-11-01", asOf: NOW.toISOString(),
      prsWaiting: 0, projectsActive: 3,
    },
  );
  assert.equal(/data-testid=["']stakeholder-cta["']/.test(withZero), false,
    "N=0 MUST omit the CTA section entirely");
});

// ────────────────────────────────────────────────────────────────────
// AC8 - Token issuance via the existing CLI / snapshot writer with
//       the new --kind=stakeholder-monthly flag.
// ────────────────────────────────────────────────────────────────────

test("AC8: createSnapshot({ kind: 'stakeholder_monthly' }) writes a snapshot row with kind='stakeholder_monthly' and the returned URL hits the new /share/stakeholder/ route shape", () => {
  const { db, cleanup } = tempDb();
  try {
    const m = createSnapshot(db, {
      name: "co-founder summary",
      fleetView: { projects: [] },
      kind: "stakeholder_monthly",
    });
    // The row carries kind='stakeholder_monthly'.
    const row = db.prepare(
      "SELECT kind FROM snapshot WHERE id LIKE ?",
    ).get(m.id_prefix + "%") as { kind: string } | undefined;
    assert.ok(row, "snapshot row MUST be present");
    assert.equal(row!.kind, "stakeholder_monthly",
      `snapshot.kind MUST be 'stakeholder_monthly'; got ${row!.kind}`);

    // The returned share_url hits the new route shape.
    assert.match(m.share_url, /\/share\/stakeholder\/[0-9a-f]+$/,
      `share_url MUST be /share/stakeholder/<token>; got ${m.share_url}`);
  } finally { cleanup(); }
});

// AC8 also asserts the CLI argv extension - we grep the source for
// the documented flag, NOT a parallel subcommand.
test("AC8: bin/fleetctl.ts grows a --kind=stakeholder-monthly arg on the EXISTING `snapshot create` subcommand (no parallel subcommand)", () => {
  // Grep the argv parser for the new flag. The flag MUST be wired on
  // the existing snapshot create branch, not a sibling.
  assert.match(FLEETCTL_TS, /stakeholder-monthly/,
    "bin/fleetctl.ts MUST reference the --kind=stakeholder-monthly flag");
  // The new flag MUST appear inside the existing snapshot create
  // function body, not via a parallel subcommand. We anchor on the
  // unique `snapshot()` function declaration.
  const fnStart = FLEETCTL_TS.indexOf("async function snapshot()");
  // Find the end of the function (the next top-level async function).
  const fnEnd = FLEETCTL_TS.indexOf("\n}\n", fnStart);
  assert.ok(fnStart > 0, "the snapshot() function MUST exist");
  assert.ok(fnEnd > fnStart, "the snapshot() function MUST have a closing brace");
  const fnBody = FLEETCTL_TS.slice(fnStart, fnEnd);
  assert.match(fnBody, /stakeholder-monthly/,
    "the --kind=stakeholder-monthly flag MUST live INSIDE the existing snapshot() subcommand");
});

// ────────────────────────────────────────────────────────────────────
// AC9 - Home-page one-time CTA card. The composer adds an inbox-
//       shaped row only when (a) lifetime PR count >= 3 AND (b) no
//       stakeholder_monthly snapshot exists AND (c) the operator has
//       not dismissed it.
// ────────────────────────────────────────────────────────────────────

test("AC9: home invite card fires when >=3 PRs shipped + no stakeholder_monthly snapshot + not dismissed; dismissing it via inbox_dismissal suppresses it on re-render", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "alpha", "Alpha");
    // Seed 5 merged agent PRs (>= 3 lifetime threshold).
    for (let i = 0; i < 5; i++) {
      seedPr(db, {
        projectId: pid, number: 100 + i,
        fetchedAt: `2026-06-${String(i + 1).padStart(2, "0")}T08:00:00.000Z`,
      });
    }
    // No snapshot row + no dismissal row.
    const cfg = makeOperatorCfg();
    const card = require_stakeholder_invite_or_null(db, cfg, NOW);
    assert.ok(card, "invite card MUST fire when >=3 PRs + no snapshot + not dismissed");
    assert.equal(card!.kind, "stakeholder_url_invite");
    assert.equal(card!.payload_id, "static-v1");
    assert.ok(typeof card!.title === "string" && card!.title.length > 0);

    // Dismiss it.
    db.prepare(
      "INSERT INTO inbox_dismissal(kind, project_slug, payload_id, dismissed_at) VALUES(?, ?, ?, ?)",
    ).run("stakeholder_url_invite", "fleet", "static-v1", NOW.toISOString());

    const after = require_stakeholder_invite_or_null(db, cfg, NOW);
    assert.equal(after, null,
      "after dismissal the invite card MUST NOT re-appear");
  } finally { cleanup(); }
});

// AC9 sub-assertion: when a stakeholder_monthly snapshot already
// exists, the invite is suppressed (the operator already set it up).
test("AC9: when a stakeholder_monthly snapshot row already exists, the invite card is SUPPRESSED", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "alpha", "Alpha");
    for (let i = 0; i < 5; i++) {
      seedPr(db, {
        projectId: pid, number: 100 + i,
        fetchedAt: `2026-06-${String(i + 1).padStart(2, "0")}T08:00:00.000Z`,
      });
    }
    // Mint a stakeholder_monthly snapshot.
    createSnapshot(db, {
      name: "co-founder summary",
      fleetView: { projects: [] },
      kind: "stakeholder_monthly",
    });
    const cfg = makeOperatorCfg();
    const card = require_stakeholder_invite_or_null(db, cfg, NOW);
    assert.equal(card, null,
      "snapshot already exists → invite is suppressed");
  } finally { cleanup(); }
});

// AC9 sub-assertion: when lifetime PRs < 3, the invite is suppressed.
test("AC9: when lifetime PR count < 3, the invite card is SUPPRESSED", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "alpha", "Alpha");
    // Only 2 merged PRs.
    seedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-01T08:00:00.000Z" });
    seedPr(db, { projectId: pid, number: 2, fetchedAt: "2026-06-02T08:00:00.000Z" });
    const cfg = makeOperatorCfg();
    const card = require_stakeholder_invite_or_null(db, cfg, NOW);
    assert.equal(card, null,
      "fewer than 3 lifetime PRs → invite is suppressed");
  } finally { cleanup(); }
});

// Helper that wraps the export we add in src/views.ts.
function require_stakeholder_invite_or_null(db: DB, cfg: FleetConfig, now: Date) {
  return stakeholderInviteCard(db, cfg, now);
}

// ────────────────────────────────────────────────────────────────────
// AC10 - Cache + invalidation (5-minute memo, keyed by token).
// ────────────────────────────────────────────────────────────────────

test("AC10: stakeholder summary cache - second render within TTL is a HIT (build counter does NOT tick); seeding a new merged PR busts the (MAX(fetched_at), COUNT(*)) tuple and the next render is a MISS", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetStakeholderSummaryCacheForTests();
    seedFullMonthFleet(db);
    const cfg = makeOperatorCfg();
    const mint = createSnapshot(db, {
      name: "co-founder summary",
      fleetView: { projects: [] },
      kind: "stakeholder_monthly",
    });

    const before = _getStakeholderSummaryCacheBuildsForTests();
    // First call - MISS, counter ticks.
    const a = stakeholderMonthlySummaryCachedForTests(db, cfg, NOW, mint.token);
    const afterFirst = _getStakeholderSummaryCacheBuildsForTests();
    assert.equal(afterFirst, before + 1,
      `first call MUST be a MISS (counter +1); before=${before} after=${afterFirst}`);

    // Second call - HIT, counter does NOT tick.
    const b = stakeholderMonthlySummaryCachedForTests(db, cfg, NOW, mint.token);
    const afterHit = _getStakeholderSummaryCacheBuildsForTests();
    assert.equal(afterHit, afterFirst,
      `second call MUST be a HIT (counter unchanged); after=${afterFirst} afterHit=${afterHit}`);
    assert.equal(b.monthIso, a.monthIso, "same payload on the hit");

    // Bust: insert a fresh merged PR for the alpha project (later
    // fetched_at than any seed). Per LESSONS 2026-06-07 the tuple is
    // (MAX(pr.fetched_at), COUNT(*) FROM pr) - we touch BOTH by
    // inserting a new row at a later timestamp.
    const alphaPid = (db.prepare("SELECT id FROM project WHERE slug=?").get("alpha") as { id: number }).id;
    seedPr(db, { projectId: alphaPid, number: 999, fetchedAt: "2026-06-30T23:00:00.000Z" });

    const c = stakeholderMonthlySummaryCachedForTests(db, cfg, NOW, mint.token);
    const afterMiss = _getStakeholderSummaryCacheBuildsForTests();
    assert.equal(afterMiss, afterFirst + 1,
      `MAX(fetched_at)+COUNT(*) bust MUST cause a MISS (counter +1); after=${afterFirst} afterMiss=${afterMiss}`);
  } finally { cleanup(); }
});

// We expose the cached path through a tiny test helper that we import
// from src/server.ts. The helper is a thin wrapper around the same
// memo getStakeholderSummaryCached we use in the route layer.
import { _stakeholderSummaryCachedForTests as stakeholderMonthlySummaryCachedForTests } from "../src/server.ts";

// ────────────────────────────────────────────────────────────────────
// AC11 - tsc --noEmit clean (handled by the CI typecheck gate), no
//        new runtime deps, no shell-string composition, no schema
//        migration that adds a CHECK constraint to snapshot.kind.
// ────────────────────────────────────────────────────────────────────

test("AC11: package.json `dependencies` stays empty - no new runtime deps", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    `dependencies MUST stay empty; got: ${JSON.stringify(deps)}`);
});

test("AC11: snapshot table grows a kind TEXT column via ALTER TABLE migration; no CHECK constraint that would block 'stakeholder_monthly'", () => {
  // Grep db.ts for the ALTER. The migration block tolerates
  // legacy DBs that predate the column.
  assert.match(DB_TS,
    /ALTER\s+TABLE\s+snapshot\s+ADD\s+COLUMN\s+kind\s+TEXT/i,
    "src/db.ts MUST carry an ALTER TABLE snapshot ADD COLUMN kind TEXT migration");
  // No CHECK constraint on the snapshot table that mentions kind.
  // We anchor on "CREATE TABLE IF NOT EXISTS snapshot" and walk to
  // the next ");" - inside that window, no CHECK( kind ) clause.
  const createIdx = DB_TS.indexOf("CREATE TABLE IF NOT EXISTS snapshot");
  assert.ok(createIdx > 0, "snapshot CREATE TABLE MUST be present in src/db.ts");
  const closeIdx = DB_TS.indexOf(");", createIdx);
  const tableDef = DB_TS.slice(createIdx, closeIdx);
  assert.equal(/CHECK\s*\([^)]*kind/i.test(tableDef), false,
    "snapshot table MUST NOT carry a CHECK constraint on kind that would block stakeholder_monthly");
});
