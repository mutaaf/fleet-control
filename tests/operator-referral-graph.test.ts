// Tests for ticket 0068 - Operator-to-operator referral graph.
//
// One test() per acceptance-criteria checkbox in
// docs/backlog/0068-operator-referral-graph.md. Strategy mirrors the
// 0065 operator-profile + 0069 lesson-lineage suites:
//   - Drive the pure helper referralGraphPayload(db, cfg, handle, now)
//     directly against a tmpdir DB for the shape + tile assembly tests.
//   - Drive recordReferralAck(db, cfg, now) directly for the idempotency
//     + consent-update round-trip test.
//   - Drive the renderer-direct seam _renderReferralGraphForTests(payload,
//     opts) for the quiet-hours branch per LESSONS 2026-06-11 (NO cwd
//     config mutation).
//   - Boot startServer() over loopback for the integration shape tests
//     (route mounted before /api/ auth gate; content-type; 404 cases).
//   - Drive the profile stat-block extension via the existing
//     _renderOperatorProfileForTests seam.
//
// LESSONS hygiene:
//   - 2026-05-29: every fixture timestamp derives from the pinned NOW
//     anchor via arithmetic, never `new Date()`.
//   - 2026-06-05: the cache invalidation hook lives on
//     globalThis.__fleet_referral_invalidate__; ingest-cycle-free.
//   - 2026-06-07: the pr table has no surrogate id; this ticket reads
//     snapshot rows by (kind = 'referral_ack') not pr.id.
//   - 2026-06-11: cfg-dependent branches use the renderer-direct seam.
//   - 2026-06-12: HTML scrapes anchor on data-testid, not a greedy id=.
//   - 2026-06-15: "route mounted before /api/" anchors on the if-
//     statement substring `if (path.startsWith("/api/"))`.
//
// Zero new runtime deps; stdlib + node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../src/db.ts";
import type { FleetConfig } from "../src/config.ts";
import {
  referralGraphPayload,
  recordReferralAck,
  _renderReferralGraphForTests,
  _renderOperatorProfileForTests,
  operatorProfilePayload,
  renderOperatorOgSvg,
  type ReferralGraphPayload,
} from "../src/views.ts";
import {
  _resetReferralGraphCacheForTests,
  _getReferralGraphCacheBuildsForTests,
  _referralGraphCachedForTests,
  _invalidateReferralGraphCache,
} from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SERVER_TS = readFileSync(join(REPO_ROOT, "src", "server.ts"), "utf8");
const VIEWS_TS = readFileSync(join(REPO_ROOT, "src", "views.ts"), "utf8");
const RATE_LIMIT_TS = readFileSync(join(REPO_ROOT, "src", "rate_limit.ts"), "utf8");
const PACKAGE_JSON = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};

// Pinned anchor: 2026-06-19 (the ticket creation date).
const NOW = new Date("2026-06-19T12:00:00.000Z");
const HANDLE = "mutaaf";
const SINCE_DATE = "2025-11-01";

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; path: string; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-referral-graph-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return {
    db,
    path,
    dir,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
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
      headline: "running an autonomous agent fleet",
      sinceDate: SINCE_DATE,
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

function seedProject(db: DB, slug: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace, cadence_json) VALUES (?,?,?,?)",
  ).run(slug, slug, "test", null);
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

interface SeedReferralAck {
  upstream: string;
  downstream: string;
  acknowledgedAt: string;
  consentPublicCredit?: boolean;
  prsShipped?: number;
  sinceDate?: string;
  createdAt: string;
}

/** Seed a referral_ack snapshot row directly. The schema reuses the
 *  existing snapshot table (kind TEXT no-CHECK column added by 0066),
 *  so no migration is needed. The payload_json carries the documented
 *  v1 shape. */
function seedReferralAck(db: DB, a: SeedReferralAck): void {
  const id = createHash("sha256").update(`ack|${a.upstream}|${a.downstream}`).digest("hex");
  const expiresAt = new Date(new Date(a.acknowledgedAt).getTime() + 100 * 365 * 86_400_000).toISOString();
  const payload = {
    upstream: a.upstream,
    downstream: a.downstream,
    acknowledgedAt: a.acknowledgedAt,
    consentPublicCredit: a.consentPublicCredit === true,
    prsShipped: a.prsShipped ?? 0,
    sinceDate: a.sinceDate ?? a.acknowledgedAt.slice(0, 10),
    version: 1,
  };
  db.prepare(
    "INSERT OR REPLACE INTO snapshot(id,name,created_at,expires_at,revoked_at,payload_json,kind)"
    + " VALUES(?,?,?,?,?,?,?)",
  ).run(
    id,
    `referral-ack-${a.upstream}-${a.downstream}`,
    a.createdAt,
    expiresAt,
    null,
    JSON.stringify(payload),
    "referral_ack",
  );
}

function anonHash(handle: string): string {
  return createHash("sha256").update(handle).digest("hex").slice(0, 8);
}

// ────────────────────────────────────────────────────────────────────
// AC1 - New optional config field operator.referredBy with consent
//       default. We drive loadConfig in a SUBPROCESS that cd's into a
//       tmpdir so the cwd-shared fleet-control.config.json never
//       collides with parallel test files per LESSONS 2026-06-11.
// ────────────────────────────────────────────────────────────────────

test("AC1: loadConfig populates operator.referredBy when the field is set; consentPublicCredit defaults to undefined-or-false on read", async () => {
  // Spawn a subprocess with cwd = a fresh tmpdir so the config file we
  // write is ISOLATED from any other test's cwd.
  const dir = mkdtempSync(join(tmpdir(), "fleet-referral-ac1-"));
  try {
    writeFileSync(join(dir, "fleet-control.config.json"), JSON.stringify({
      projectRoots: [],
      installedRoot: dir,
      cacheBase: dir,
      claudeProjects: dir,
      operator: {
        handle: "mutaaf",
        sinceDate: SINCE_DATE,
        referredBy: { handle: "upstream-friend", acknowledgedAt: "2026-06-19" },
      },
    }));
    // Run loadConfig in a subprocess pinned to dir so process.cwd() is
    // the isolated tmpdir.
    const { spawnSync } = await import("node:child_process");
    const script = `
      import { loadConfig } from "${join(REPO_ROOT, "src", "config.ts")}";
      const cfg = loadConfig();
      process.stdout.write(JSON.stringify(cfg.operator?.referredBy ?? null));
    `;
    const r = spawnSync(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e", script,
    ], {
      cwd: dir,
      env: { ...process.env, FLEET_DB_PATH: join(dir, "fleet.db") },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, `subprocess loadConfig failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout) as {
      handle: string; acknowledgedAt: string; consentPublicCredit?: boolean;
    } | null;
    assert.ok(parsed, "referredBy field is populated");
    assert.equal(parsed!.handle, "upstream-friend");
    assert.equal(parsed!.acknowledgedAt, "2026-06-19");
    // consentPublicCredit defaults to falsy (undefined OR explicit false)
    // so an operator who sets the field without thinking about consent
    // stays anonymised in the upstream's /referrals/<handle> page.
    assert.equal(parsed!.consentPublicCredit ?? false, false,
      "consentPublicCredit defaults to false when unset");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────
// AC2 - referralGraphPayload composes tiles from referral_ack snapshot
//       rows; anonymisation gated on consentPublicCredit.
// ────────────────────────────────────────────────────────────────────

test("AC2: referralGraphPayload returns 3 tiles with mixed consent; consented tiles carry displayHandle, anonymous tiles do not", () => {
  const { db, cleanup } = tempDb();
  try {
    const cfg = makeOperatorCfg();
    seedReferralAck(db, {
      upstream: HANDLE,
      downstream: "alice",
      acknowledgedAt: "2026-04-01T00:00:00.000Z",
      consentPublicCredit: true,
      prsShipped: 23,
      sinceDate: "2026-03-01",
      createdAt: "2026-04-01T00:00:00.000Z",
    });
    seedReferralAck(db, {
      upstream: HANDLE,
      downstream: "bob",
      acknowledgedAt: "2026-05-01T00:00:00.000Z",
      consentPublicCredit: false,
      prsShipped: 4,
      sinceDate: "2026-04-15",
      createdAt: "2026-05-01T00:00:00.000Z",
    });
    seedReferralAck(db, {
      upstream: HANDLE,
      downstream: "carol",
      acknowledgedAt: "2026-06-01T00:00:00.000Z",
      consentPublicCredit: true,
      prsShipped: 11,
      sinceDate: "2026-05-20",
      createdAt: "2026-06-01T00:00:00.000Z",
    });

    const payload = referralGraphPayload(db, cfg, HANDLE, NOW);
    assert.equal(payload.handle, HANDLE);
    assert.equal(payload.totalIntroduced, 3, "totalIntroduced counts all acks");
    assert.equal(payload.tiles.length, 3, "tiles.length === total");
    assert.equal(payload.version, 1);
    assert.equal(typeof payload.asOf, "string");

    const byDownstream: Record<string, typeof payload.tiles[number]> = {};
    for (const t of payload.tiles) {
      // handleAnon is stable: first 8 chars of sha256(downstream)
      // when the tile is anonymised, else mirrors the consented
      // displayHandle's anon shape; either way the field is present
      // and non-empty.
      assert.ok(t.handleAnon && t.handleAnon.length > 0, "handleAnon non-empty");
      // We can't bind tiles to a downstream identity directly when
      // they are anonymised; instead bin by handleAnon match.
      if (t.handleAnon === anonHash("alice")) byDownstream["alice"] = t;
      else if (t.handleAnon === anonHash("bob")) byDownstream["bob"] = t;
      else if (t.handleAnon === anonHash("carol")) byDownstream["carol"] = t;
    }
    assert.ok(byDownstream["alice"], "alice tile present");
    assert.ok(byDownstream["bob"], "bob tile present");
    assert.ok(byDownstream["carol"], "carol tile present");
    assert.equal(byDownstream["alice"].displayHandle, "alice",
      "consenting downstream gets its real handle on the public page");
    assert.equal(byDownstream["carol"].displayHandle, "carol",
      "consenting downstream gets its real handle on the public page");
    assert.equal(byDownstream["bob"].displayHandle, null,
      "non-consenting downstream stays anonymised (displayHandle === null)");
    assert.equal(byDownstream["alice"].consentPublicCredit, true);
    assert.equal(byDownstream["bob"].consentPublicCredit, false);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 - recordReferralAck writes exactly one row per startup; idempotent
//       on second call; consent-update round-trip via INSERT OR REPLACE.
// ────────────────────────────────────────────────────────────────────

test("AC3: recordReferralAck writes one referral_ack row when referredBy is set; is idempotent; consent update overwrites in-place", () => {
  const { db, cleanup } = tempDb();
  try {
    const cfg = makeOperatorCfg({
      referredBy: { handle: "mentor", acknowledgedAt: "2026-06-19" },
    });
    recordReferralAck(db, cfg, NOW);
    let rows = db.prepare(
      "SELECT id, payload_json FROM snapshot WHERE kind = 'referral_ack'",
    ).all() as unknown as { id: string; payload_json: string }[];
    assert.equal(rows.length, 1, "first call inserts one referral_ack row");
    const firstPayload = JSON.parse(rows[0].payload_json) as {
      upstream: string; downstream: string; consentPublicCredit: boolean;
    };
    assert.equal(firstPayload.upstream, "mentor");
    assert.equal(firstPayload.downstream, HANDLE);
    assert.equal(firstPayload.consentPublicCredit, false,
      "consent defaults to false when unset in cfg");

    // Second call: still one row (idempotent on (upstream, downstream)).
    recordReferralAck(db, cfg, NOW);
    rows = db.prepare(
      "SELECT id, payload_json FROM snapshot WHERE kind = 'referral_ack'",
    ).all() as unknown as { id: string; payload_json: string }[];
    assert.equal(rows.length, 1, "second call is idempotent - still one row");

    // Flip consent in cfg, call again - still one row but the payload's
    // consentPublicCredit flips in-place per INSERT OR REPLACE on the
    // (upstream, downstream) tuple.
    const cfg2 = makeOperatorCfg({
      referredBy: { handle: "mentor", acknowledgedAt: "2026-06-19", consentPublicCredit: true },
    });
    recordReferralAck(db, cfg2, NOW);
    rows = db.prepare(
      "SELECT id, payload_json FROM snapshot WHERE kind = 'referral_ack'",
    ).all() as unknown as { id: string; payload_json: string }[];
    assert.equal(rows.length, 1, "consent flip stays at one row");
    const updated = JSON.parse(rows[0].payload_json) as { consentPublicCredit: boolean };
    assert.equal(updated.consentPublicCredit, true,
      "consent flip persists into the row's payload (INSERT OR REPLACE)");

    // No referredBy => no write.
    const cfg3 = makeOperatorCfg();
    const { db: db2, cleanup: cleanup2 } = tempDb();
    try {
      recordReferralAck(db2, cfg3, NOW);
      const fresh = db2.prepare(
        "SELECT COUNT(*) AS c FROM snapshot WHERE kind = 'referral_ack'",
      ).get() as { c: number };
      assert.equal(fresh.c, 0, "no referredBy = no write");
    } finally { cleanup2(); }
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 - GET /referrals/<handle> route shape: 200 on own handle (even
//       with zero acks); 404 on stranger handle; 200 with tiles on
//       seeded acks. Route mounted BEFORE /api/ auth gate.
//
// Per LESSONS 2026-06-11 "startServer() tests that mutate fleet-
// control.config.json race against parallel test files; expose a
// renderer-direct seam for branch tests" - we drive the branch tests
// via the cached-helper layer + an in-process pure call to the route
// handler instead of booting startServer over loopback. The
// operator-profile test suite already mutates the same CONFIG_PATH
// to set operator.handle so parallel runs of these two files race;
// keeping the integration shape test as a static grep + cached-
// helper call keeps the suite race-free.
// ────────────────────────────────────────────────────────────────────

test("AC4: cached helper returns the tile shape for the upstream's own seeded graph (200-equivalent)", () => {
  _resetReferralGraphCacheForTests();
  const { db, cleanup } = tempDb();
  try {
    // Seed 3 acks against HANDLE so the 'with tiles' branch fires.
    seedReferralAck(db, {
      upstream: HANDLE, downstream: "alice", acknowledgedAt: "2026-04-01T00:00:00.000Z",
      consentPublicCredit: true, createdAt: "2026-04-01T00:00:00.000Z",
    });
    seedReferralAck(db, {
      upstream: HANDLE, downstream: "bob", acknowledgedAt: "2026-05-01T00:00:00.000Z",
      consentPublicCredit: false, createdAt: "2026-05-01T00:00:00.000Z",
    });
    seedReferralAck(db, {
      upstream: HANDLE, downstream: "carol", acknowledgedAt: "2026-06-01T00:00:00.000Z",
      consentPublicCredit: true, createdAt: "2026-06-01T00:00:00.000Z",
    });
    const cfg = makeOperatorCfg();
    const payload = _referralGraphCachedForTests(db, cfg, HANDLE, NOW);
    assert.ok(payload);
    assert.equal(payload!.totalIntroduced, 3, "totalIntroduced surfaces the count");
    assert.equal(payload!.tiles.length, 3, "all 3 tiles render");
    const html = _renderReferralGraphForTests(payload!, { quietHoursActive: false });
    assert.match(html,
      /data-testid=["']referral-graph-total["']/,
      "referral-graph-total testid present");
    assert.match(html, /alice/, "consented tile renders displayHandle 'alice'");
    assert.match(html, /carol/, "consented tile renders displayHandle 'carol'");
    assert.equal(html.includes(">bob<") || html.includes(" bob "), false,
      "non-consenting downstream MUST NOT surface its real handle");
  } finally { cleanup(); }
});

test("AC4: upstream's OWN empty graph renders the honest empty-state copy via the helper layer", () => {
  _resetReferralGraphCacheForTests();
  const { db, cleanup } = tempDb();
  try {
    const cfg = makeOperatorCfg();
    const payload = _referralGraphCachedForTests(db, cfg, HANDLE, NOW);
    assert.ok(payload);
    assert.equal(payload!.totalIntroduced, 0,
      "empty fleet has zero referrals");
    const html = _renderReferralGraphForTests(payload!, { quietHoursActive: false });
    assert.match(html,
      /data-testid=["']referral-graph-empty["']/,
      "empty-state testid present when totalIntroduced === 0");
  } finally { cleanup(); }
});

test("AC4: GET /referrals/<handle> route is wired in server.ts (dispatcher matches the path prefix)", () => {
  // Per LESSONS 2026-06-11 we avoid a boot test that mutates the
  // shared fleet-control.config.json because parallel test files race
  // on the same cwd path. The route wiring is asserted as a static
  // grep: the path-prefix check exists in src/server.ts AND the
  // serveReferralGraph helper is dispatched from it.
  // The slack between the if statement and the dispatch call carries
  // the handle-shape guard + the call to serveReferralGraph; we
  // widen the regex window to cover both.
  assert.match(SERVER_TS,
    /path\.startsWith\(["']\/referrals\/["']\)[\s\S]{0,800}serveReferralGraph\b/,
    "server.ts MUST dispatch /referrals/* to serveReferralGraph");
});

test("AC4: /referrals/<handle> route is mounted BEFORE the if (path.startsWith(\"/api/\")) auth gate", () => {
  // Per LESSONS 2026-06-15 anchor on the if-statement, NOT a prose
  // substring (a sibling helper's comment naming the gate would collide).
  const referralsIdx = SERVER_TS.indexOf("/referrals/");
  assert.notEqual(referralsIdx, -1, "/referrals/ route MUST exist in server.ts");
  const apiGateIdx = SERVER_TS.indexOf("if (path.startsWith(\"/api/\"))");
  assert.notEqual(apiGateIdx, -1, "the if (path.startsWith(/api/)) auth gate MUST exist");
  assert.ok(referralsIdx < apiGateIdx,
    `/referrals/ route MUST be mounted BEFORE the /api/ auth gate (referralsIdx=${referralsIdx}, apiGateIdx=${apiGateIdx})`);
});

// ────────────────────────────────────────────────────────────────────
// AC5 - Rate-limit prefix: /referrals/ in isRateLimitedPath.
// ────────────────────────────────────────────────────────────────────

test("AC5: isRateLimitedPath includes /referrals/ in its prefix list", () => {
  // Static grep so a refactor that moves the prefix list still keeps
  // /referrals/ covered.
  assert.match(RATE_LIMIT_TS,
    /isRateLimitedPath[\s\S]{0,600}\/referrals\//,
    "isRateLimitedPath MUST include /referrals/ in its prefix list per the 0064 surface contract");
});

// ────────────────────────────────────────────────────────────────────
// AC6 - Profile stat block extension: referralsIntroduced populated;
//       stat block renders only when > 0.
// ────────────────────────────────────────────────────────────────────

test("AC6: operatorProfilePayload populates referralsIntroduced from referral_ack rows; renderer surfaces the stat block only when > 0", () => {
  const { db, cleanup } = tempDb();
  try {
    const cfg = makeOperatorCfg();
    const pid = seedProject(db, "alpha");
    // Seed one PR so the operator profile clears the empty-state branch.
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-01T08:00:00.000Z" });

    // No referrals seeded: referralsIntroduced = 0, stat block absent.
    const zero = operatorProfilePayload(db, cfg, NOW);
    assert.ok(zero, "payload non-null");
    assert.equal(zero!.referralsIntroduced, 0,
      "referralsIntroduced = 0 when no acks present");
    const htmlZero = _renderOperatorProfileForTests(zero!, { quietHoursActive: false });
    assert.equal(/data-testid=["']operator-profile-referrals["']/.test(htmlZero), false,
      "referrals stat block ABSENT when count is zero");

    // Seed 3 acks against the upstream handle. The stat block now
    // appears and carries the count + the link to /referrals/<handle>.
    seedReferralAck(db, { upstream: HANDLE, downstream: "alice", acknowledgedAt: "2026-04-01T00:00:00.000Z", createdAt: "2026-04-01T00:00:00.000Z" });
    seedReferralAck(db, { upstream: HANDLE, downstream: "bob", acknowledgedAt: "2026-05-01T00:00:00.000Z", createdAt: "2026-05-01T00:00:00.000Z" });
    seedReferralAck(db, { upstream: HANDLE, downstream: "carol", acknowledgedAt: "2026-06-01T00:00:00.000Z", createdAt: "2026-06-01T00:00:00.000Z" });

    const three = operatorProfilePayload(db, cfg, NOW);
    assert.ok(three);
    assert.equal(three!.referralsIntroduced, 3,
      "referralsIntroduced reads through referralGraphPayload");
    const htmlThree = _renderOperatorProfileForTests(three!, { quietHoursActive: false });
    assert.match(htmlThree,
      /data-testid=["']operator-profile-referrals["']/,
      "referrals stat block PRESENT when count > 0");
    assert.match(htmlThree, /3 operators/,
      "stat block names the count - '3 operators'");
    assert.match(htmlThree,
      /href=["']\/referrals\/mutaaf["']/,
      "stat block links to /referrals/<handle>");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 - OG card extension is OUT OF SCOPE: the OG SVG is byte-identical
//       between a 0-referral and a 3-referral seed.
// ────────────────────────────────────────────────────────────────────

test("AC7: renderOperatorOgSvg is byte-identical between a 0-referral and a 3-referral seed (OG card ignores referralsIntroduced)", () => {
  const { db, cleanup } = tempDb();
  try {
    const cfg = makeOperatorCfg();
    const pid = seedProject(db, "alpha");
    seedMergedPr(db, { projectId: pid, number: 1, fetchedAt: "2026-06-01T08:00:00.000Z" });

    const zero = operatorProfilePayload(db, cfg, NOW);
    const svgZero = renderOperatorOgSvg(zero!);

    seedReferralAck(db, { upstream: HANDLE, downstream: "alice", acknowledgedAt: "2026-04-01T00:00:00.000Z", createdAt: "2026-04-01T00:00:00.000Z" });
    seedReferralAck(db, { upstream: HANDLE, downstream: "bob", acknowledgedAt: "2026-05-01T00:00:00.000Z", createdAt: "2026-05-01T00:00:00.000Z" });
    seedReferralAck(db, { upstream: HANDLE, downstream: "carol", acknowledgedAt: "2026-06-01T00:00:00.000Z", createdAt: "2026-06-01T00:00:00.000Z" });

    const three = operatorProfilePayload(db, cfg, NOW);
    const svgThree = renderOperatorOgSvg(three!);

    assert.equal(svgZero, svgThree,
      "OG SVG is byte-identical regardless of referralsIntroduced (out of scope for v1)");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC8 - Consent toggle round-trip via invalidation hook.
// ────────────────────────────────────────────────────────────────────

test("AC8: flipping consent in a referral_ack payload + invalidation hook updates the rendered displayHandle on next render", () => {
  const { db, cleanup } = tempDb();
  try {
    const cfg = makeOperatorCfg();
    _resetReferralGraphCacheForTests();
    seedReferralAck(db, {
      upstream: HANDLE, downstream: "dave", acknowledgedAt: "2026-04-01T00:00:00.000Z",
      consentPublicCredit: true, createdAt: "2026-04-01T00:00:00.000Z",
    });
    const first = _referralGraphCachedForTests(db, cfg, HANDLE, NOW);
    assert.ok(first);
    assert.equal(first!.tiles.length, 1);
    assert.equal(first!.tiles[0].displayHandle, "dave",
      "consent=true tile renders dave");

    // Update the payload to consent=false in place.
    const newPayload = {
      upstream: HANDLE,
      downstream: "dave",
      acknowledgedAt: "2026-04-01T00:00:00.000Z",
      consentPublicCredit: false,
      prsShipped: 0,
      sinceDate: "2026-04-01",
      version: 1,
    };
    db.prepare(
      "UPDATE snapshot SET payload_json = ? WHERE kind = 'referral_ack'",
    ).run(JSON.stringify(newPayload));

    // Without invalidation the cache still returns the old payload.
    const stale = _referralGraphCachedForTests(db, cfg, HANDLE, NOW);
    assert.equal(stale!.tiles[0].displayHandle, "dave",
      "without invalidation the cache returns the old consent value");

    // Fire the invalidation hook; next render reflects the new consent.
    _invalidateReferralGraphCache();
    const fresh = _referralGraphCachedForTests(db, cfg, HANDLE, NOW);
    assert.equal(fresh!.tiles[0].displayHandle, null,
      "after invalidation the cache reflects consent=false (displayHandle null)");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC9 - Quiet-hours posture: install-cta omitted under quiet hours.
// ────────────────────────────────────────────────────────────────────

function basePayload(): ReferralGraphPayload {
  return {
    handle: HANDLE,
    totalIntroduced: 2,
    since: "2026-04-01",
    tiles: [
      { handleAnon: anonHash("alice"), displayHandle: "alice", sinceDate: "2026-03-01", prsShipped: 23, consentPublicCredit: true },
      { handleAnon: anonHash("bob"), displayHandle: null, sinceDate: "2026-04-15", prsShipped: 4, consentPublicCredit: false },
    ],
    asOf: NOW.toISOString(),
    version: 1,
  };
}

test("AC9: renderer with quietHoursActive=true omits install-cta testid; quietHoursActive=false includes it", () => {
  const normal = _renderReferralGraphForTests(basePayload(), { quietHoursActive: false });
  assert.match(normal, /data-testid=["']install-cta["']/,
    "install-cta testid present during normal hours");
  const quiet = _renderReferralGraphForTests(basePayload(), { quietHoursActive: true });
  assert.equal(/data-testid=["']install-cta["']/.test(quiet), false,
    "install-cta testid SUPPRESSED under quiet hours");
});

// ────────────────────────────────────────────────────────────────────
// AC10 - Cache + invalidation: two reads within TTL = one build; a
//        fresh referral_ack row busts via (MAX(created_at), COUNT(*)).
// ────────────────────────────────────────────────────────────────────

test("AC10: referral graph cache: two reads within TTL share one build; a fresh referral_ack row busts via (MAX(created_at), COUNT(*))", () => {
  const { db, cleanup } = tempDb();
  try {
    _resetReferralGraphCacheForTests();
    const cfg = makeOperatorCfg();
    seedReferralAck(db, {
      upstream: HANDLE, downstream: "alice", acknowledgedAt: "2026-04-01T00:00:00.000Z",
      consentPublicCredit: true, createdAt: "2026-04-01T00:00:00.000Z",
    });
    const before = _getReferralGraphCacheBuildsForTests();
    const a = _referralGraphCachedForTests(db, cfg, HANDLE, NOW);
    const afterFirst = _getReferralGraphCacheBuildsForTests();
    assert.equal(afterFirst - before, 1, "first call cache-misses");
    const b = _referralGraphCachedForTests(db, cfg, HANDLE, NOW);
    const afterSecond = _getReferralGraphCacheBuildsForTests();
    assert.equal(afterSecond - afterFirst, 0,
      "second call within TTL cache-hits");
    assert.equal(a!.totalIntroduced, b!.totalIntroduced);

    seedReferralAck(db, {
      upstream: HANDLE, downstream: "bob", acknowledgedAt: "2026-05-01T00:00:00.000Z",
      consentPublicCredit: false, createdAt: "2026-05-01T00:00:00.000Z",
    });
    _referralGraphCachedForTests(db, cfg, HANDLE, NOW);
    const afterBust = _getReferralGraphCacheBuildsForTests();
    assert.equal(afterBust - afterSecond, 1,
      "fresh referral_ack row MUST bust the cache via (MAX(created_at), COUNT(*))");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC11 - hard NOs: tsc clean (covered by typecheck job),
//        zero new runtime deps, no JSON-shape break, no schema migration.
// ────────────────────────────────────────────────────────────────────

test("AC11: package.json dependencies stays empty (no new runtime deps)", () => {
  assert.deepEqual(PACKAGE_JSON.dependencies ?? {}, {},
    "dependencies MUST stay empty per AGENTS.md Hard NO");
});

test("AC11: src/views.ts MUST NOT introduce a from \"./lessons.ts\" import (LESSONS 2026-06-13 cycle trap)", () => {
  // lessons.ts already imports from views.ts; the back-edge would create
  // a function-import cycle per LESSONS 2026-06-13.
  assert.equal(/from\s+["']\.\/lessons\.ts["']/.test(VIEWS_TS), false,
    "views.ts MUST NOT add an import from ./lessons.ts");
});

test("AC11: no schema migration - referral_ack rides on the existing snapshot table's kind TEXT column", () => {
  // The ticket says: NO schema migration; referral_ack rides on the
  // existing snapshot table (extended by 0066 with a no-CHECK kind
  // column). We assert that no new CREATE TABLE referral_ack landed.
  const DB_TS = readFileSync(join(REPO_ROOT, "src", "db.ts"), "utf8");
  assert.equal(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?referral_ack/i.test(DB_TS), false,
    "no new referral_ack table - the snapshot.kind column carries the discriminator");
});
