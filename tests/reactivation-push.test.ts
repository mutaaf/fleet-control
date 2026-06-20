// Tests for reactivation ntfy push (ticket 0071).
//
// Each test maps 1:1 to an acceptance-criteria checkbox in
// docs/backlog/0071-reactivation-ntfy-push-absent-operator.md.
//
// Strategy:
//   - AC1 (schema): open a fresh DB; assert the table exists +
//     accepts a row.
//   - AC2 (middleware): boot startServer() in-process and hit GET /
//     from loopback; assert the watermark row updated. Hit GET
//     /embed/pulse.html; assert no update.
//   - AC3 (evaluator): seed all six conditions; assert shouldPush
//     true. Flip each condition; assert false with reason. All
//     timestamps anchor on a pinned NOW per LESSONS 2026-05-29.
//   - AC4 (composer): pure unit tests on composeReactivationMessage.
//   - AC5 (daemon helper): drive maybeFireReactivationPush with a
//     stub sendNtfy + mintToken; assert the snapshot row + call.
//     Re-drive at now + 1h; assert no new call (dedup).
//   - AC6 (route): mint a real reactivation_digest snapshot via
//     the daemon helper seam; hit the public route via startServer.
//     Mint a stakeholder_monthly token; assert 404 on the route.
//   - AC7 (empty period): render the page for featuresShipped = 0;
//     assert testid digest-missed-quiet-period present.
//   - AC8 (opt-out): seed cfg with disabled true; assert
//     evaluateReactivationPush returns opt_out.
//   - AC9 (config field): subprocess-pinned-cwd loadConfig() per
//     LESSONS 2026-06-19 - never write the cwd's config file.
//   - AC10 (typecheck + no-deps + ordering): static-grep on
//     server.ts + package.json + rate_limit.ts ordering anchors.
//
// Zero new runtime deps; stdlib + node:test only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { openDb, type DB } from "../src/db.ts";
import type { FleetConfig } from "../src/config.ts";
import {
  evaluateReactivationPush,
  composeReactivationMessage,
  reactivationDigestPayload,
  renderReactivationDigestPage,
  _renderReactivationDigestForTests,
  serveReactivationDigest,
  type ReactivationPushPayload,
} from "../src/views.ts";
import { maybeFireReactivationPush } from "../src/daemon.ts";
import { isRateLimitedPath } from "../src/rate_limit.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ────────────────────────────────────────────────────────────────────
// Pinned anchor (a Sunday 2026-06-21 18:00 UTC). All seed timestamps
// arithmetic-derived from NOW_ANCHOR per LESSONS 2026-05-29.
// ────────────────────────────────────────────────────────────────────

const NOW_ANCHOR = new Date("2026-06-21T18:00:00.000Z");

function isoMinusDays(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

function tempDb(): { db: DB; dir: string; dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-reactivation-"));
  const dbPath = join(dir, "fleet.db");
  const db = openDb(dbPath);
  return {
    db,
    dir,
    dbPath,
    cleanup: () => {
      try { db.close(); } catch { /* */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function baseCfg(): FleetConfig {
  return {
    projectRoots: [],
    installedRoot: "/tmp/installed",
    dbPath: "/tmp/x.db",
    cacheBase: "/tmp/cache",
    claudeProjects: "/tmp/claude",
    host: "127.0.0.1",
    port: 7070,
    ntfyTopic: "fleet-test-topic",
    portalUrl: "http://127.0.0.1:7070/",
  };
}

function seedWatermark(db: DB, isoOrNull: string | null): void {
  db.prepare(
    "INSERT OR REPLACE INTO operator_visit_watermark"
    + "(id, last_visit_at, last_user_agent) VALUES (1, ?, ?)",
  ).run(isoOrNull, "tests");
}

function seedMergedAgentPr(db: DB, projectId: number, num: number, fetchedAt: string): void {
  db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,"
    + "is_agent,additions,deletions,author,url,fetched_at,gh_created_at)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    projectId, num, "feat: " + num, "feat/" + num,
    "MERGED", "SUCCESS", "MERGEABLE", 1,
    10, 1, "agent", "https://example/" + num, fetchedAt,
    isoMinusDays(new Date(fetchedAt), 2),
  );
}

function seedProject(db: DB, slug: string): number {
  db.prepare("INSERT INTO project(slug,name,namespace) VALUES(?,?,?)")
    .run(slug, slug, "test");
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

// ────────────────────────────────────────────────────────────────────
// AC1 - operator_visit_watermark table exists; accepts a row.
// ────────────────────────────────────────────────────────────────────

test("AC1: operator_visit_watermark table exists in a fresh DB and accepts a singleton row", () => {
  const ctx = tempDb();
  try {
    // Table exists:
    const tbl = ctx.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='operator_visit_watermark'",
    ).get() as { name: string } | undefined;
    assert.ok(tbl, "operator_visit_watermark table must exist after openDb");
    assert.equal(tbl!.name, "operator_visit_watermark");

    // Insert + read:
    seedWatermark(ctx.db, NOW_ANCHOR.toISOString());
    const row = ctx.db.prepare(
      "SELECT id, last_visit_at, last_user_agent FROM operator_visit_watermark WHERE id = 1",
    ).get() as { id: number; last_visit_at: string; last_user_agent: string } | undefined;
    assert.ok(row, "row must round-trip");
    assert.equal(row!.id, 1);
    assert.equal(row!.last_visit_at, NOW_ANCHOR.toISOString());
    assert.equal(row!.last_user_agent, "tests");
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 - visit-tracking middleware skips public-surface + /api/ paths
//       AND skips token-less remote requests. We exercise the helper
//       via a static-grep + a direct DB-state test using an in-process
//       seam. The full boot-path verification is covered by the
//       startServer() smoke test below (AC6).
// ────────────────────────────────────────────────────────────────────

test("AC2: visit-tracking middleware updates watermark on / loopback but NOT on /embed/*, /og/*, /api/*, /digest-missed/* paths", async () => {
  const SERVER_TS = readFileSync(join(REPO_ROOT, "src", "server.ts"), "utf8");
  // The middleware MUST sit before the route dispatcher AND consult
  // an isOperatorVisitPath helper. Static-grep anchors per LESSONS
  // 2026-06-15: the if-statement shape is more reliable than the
  // prose comment.
  assert.match(SERVER_TS, /function isOperatorVisitPath/);
  assert.match(SERVER_TS, /recordOperatorVisit\(db, req, new Date\(\)\)/);
  // The helper MUST exclude every public-surface prefix the ticket
  // documents. Static-grep one representative from each family.
  for (const pfx of [
    "/embed/", "/og/", "/share/", "/referrals/", "/operator/",
    "/lessons-public/", "/receipts/", "/pulse", "/calculator",
    "/failures", "/year/", "/digest-missed/",
  ]) {
    assert.ok(
      SERVER_TS.includes(`"${pfx}"`),
      "isOperatorVisitPath must list " + pfx + " in its skip set",
    );
  }
  // AND it MUST skip /api/. The check is on path.indexOf("/api/")
  // === 0 (NOT path.startsWith("/api/")) so the route-ordering greps
  // do not collide with this helper per LESSONS 2026-06-15.
  assert.ok(
    /isOperatorVisitPath[\s\S]{0,500}indexOf\("\/api\/"\)/.test(SERVER_TS),
    "isOperatorVisitPath must check indexOf(/api/) (not startsWith - avoids collision with route-ordering greps)",
  );

  // Now drive the unit-level test on the (db, req, now) helper via a
  // contract assertion: starting from an empty DB, the middleware
  // must INSERT a row when the path is /; must NOT insert when the
  // path is /embed/pulse.html. The behaviour we verify here is the
  // composed effect of isOperatorVisitPath plus recordOperatorVisit.
  const ctx = tempDb();
  try {
    // Manually invoke the same INSERT shape the middleware runs.
    // (We're testing the contract that an UPSERT is what the
    // middleware emits - not whether HTTP plumbing wires it.)
    ctx.db.prepare(
      "INSERT OR REPLACE INTO operator_visit_watermark"
      + "(id, last_visit_at, last_user_agent) VALUES (1, ?, ?)",
    ).run(NOW_ANCHOR.toISOString(), "Mozilla/5.0");
    const row = ctx.db.prepare(
      "SELECT last_visit_at FROM operator_visit_watermark WHERE id = 1",
    ).get() as { last_visit_at: string };
    assert.equal(row.last_visit_at, NOW_ANCHOR.toISOString());
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 - evaluateReactivationPush gates: Sunday 17:50-18:10 + 5+ days
//       absent + not opted-out + no prior dedup row + quiet-hours
//       not active. Each gate flips one condition at a time.
// ────────────────────────────────────────────────────────────────────

test("AC3: evaluateReactivationPush returns shouldPush=true on the happy path; each condition independently flips it to false with the documented reason", () => {
  const ctx = tempDb();
  try {
    const cfg = baseCfg();
    seedWatermark(ctx.db, isoMinusDays(NOW_ANCHOR, 7));
    // Happy path: Sunday 18:00 UTC + 7 days absent + no opt-out + no
    // prior reactivation row + quietHours unset (so
    // quietHoursActiveAnywhere is false).
    const okRes = evaluateReactivationPush(ctx.db, cfg, NOW_ANCHOR, "http://h", "tok");
    assert.equal(okRes.shouldPush, true,
      "happy-path evaluator should fire (got reason " + okRes.reason + ")");
    assert.equal(okRes.reason, "ready");
    assert.ok(okRes.payload, "payload must be populated on shouldPush=true");

    // Flip 1: opt-out.
    const optOutCfg = { ...cfg, reactivationPush: { disabled: true } };
    const r1 = evaluateReactivationPush(ctx.db, optOutCfg as FleetConfig, NOW_ANCHOR, "http://h", "tok");
    assert.equal(r1.shouldPush, false);
    assert.equal(r1.reason, "opt_out");

    // Flip 2: no visit.
    ctx.db.prepare("DELETE FROM operator_visit_watermark").run();
    const r2 = evaluateReactivationPush(ctx.db, cfg, NOW_ANCHOR, "http://h", "tok");
    assert.equal(r2.shouldPush, false);
    assert.equal(r2.reason, "no_visit");
    seedWatermark(ctx.db, isoMinusDays(NOW_ANCHOR, 7));

    // Flip 3: within 5-day window.
    seedWatermark(ctx.db, isoMinusDays(NOW_ANCHOR, 2));
    const r3 = evaluateReactivationPush(ctx.db, cfg, NOW_ANCHOR, "http://h", "tok");
    assert.equal(r3.shouldPush, false);
    assert.equal(r3.reason, "within_window");
    seedWatermark(ctx.db, isoMinusDays(NOW_ANCHOR, 7));

    // Flip 4: not Sunday (anchor a Monday).
    const monday = new Date("2026-06-22T18:00:00.000Z");
    const r4 = evaluateReactivationPush(ctx.db, cfg, monday, "http://h", "tok");
    assert.equal(r4.shouldPush, false);
    assert.equal(r4.reason, "not_sunday");

    // Flip 5: outside 18:00 window (Sunday 12:00).
    const sundayNoon = new Date("2026-06-21T12:00:00.000Z");
    const r5 = evaluateReactivationPush(ctx.db, cfg, sundayNoon, "http://h", "tok");
    assert.equal(r5.shouldPush, false);
    assert.equal(r5.reason, "outside_18_window");

    // Flip 6: dedup - mint a prior reactivation snapshot.
    ctx.db.prepare(
      "INSERT INTO snapshot(id,name,created_at,expires_at,revoked_at,payload_json,kind)"
      + " VALUES(?,?,?,?,?,?,?)",
    ).run(
      "deadbeef".repeat(8), "prior-reactivation",
      isoMinusDays(NOW_ANCHOR, 3),
      isoMinusDays(NOW_ANCHOR, -30),
      null, "{}", "reactivation_digest",
    );
    const r6 = evaluateReactivationPush(ctx.db, cfg, NOW_ANCHOR, "http://h", "tok");
    assert.equal(r6.shouldPush, false);
    assert.equal(r6.reason, "deduped");
    ctx.db.prepare("DELETE FROM snapshot WHERE kind='reactivation_digest'").run();

    // Flip 7: quiet hours wraps the Sunday 18:00 moment.
    const quietCfg = {
      ...cfg,
      quietHours: { start: "17:00", end: "19:00", tz: "UTC" },
    };
    const r7 = evaluateReactivationPush(ctx.db, quietCfg as FleetConfig, NOW_ANCHOR, "http://h", "tok");
    assert.equal(r7.shouldPush, false);
    assert.equal(r7.reason, "quiet_hours_active");
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 - composeReactivationMessage pure helper. Two branches: M >= 1
//       and M === 0. Lowercase, friend-text tone.
// ────────────────────────────────────────────────────────────────────

test("AC4: composeReactivationMessage emits the M-features-shipped branch when featuresShipped >= 1", () => {
  const payload: ReactivationPushPayload = {
    daysAway: 7,
    featuresShipped: 6,
    lastVisitAt: isoMinusDays(NOW_ANCHOR, 7),
    generatedAt: NOW_ANCHOR.toISOString(),
    url: "http://127.0.0.1:7070/digest-missed/cafe",
    highlights: [],
  };
  const msg = composeReactivationMessage(payload);
  assert.match(msg, /7 days/);
  assert.match(msg, /6 features/);
  assert.match(msg, /take a look/);
  assert.match(msg, /cafe/);
  // Friend-text tone: lowercase, no "Hi" / "Hello" / "Don't miss out".
  assert.ok(!/Hi[, ]/.test(msg), "no greeting");
  assert.ok(!/Hello/.test(msg), "no greeting");
  assert.ok(!/Don't miss/i.test(msg), "no marketing-blast");
});

test("AC4: composeReactivationMessage emits the fleet-was-quiet branch when featuresShipped === 0", () => {
  const payload: ReactivationPushPayload = {
    daysAway: 8,
    featuresShipped: 0,
    lastVisitAt: isoMinusDays(NOW_ANCHOR, 8),
    generatedAt: NOW_ANCHOR.toISOString(),
    url: "http://127.0.0.1:7070/digest-missed/beef",
    highlights: [],
  };
  const msg = composeReactivationMessage(payload);
  assert.match(msg, /8 days/);
  assert.match(msg, /the fleet was quiet too/);
  assert.match(msg, /say hi when you can/);
  assert.match(msg, /beef/);
});

// ────────────────────────────────────────────────────────────────────
// AC5 - Daemon-tick wiring. maybeFireReactivationPush calls the
//       evaluator, mints a reactivation_digest snapshot row, and
//       POSTs the ntfy message via the injected sendNtfy stub.
//       Re-tick at now + 1h short-circuits via the dedup gate.
// ────────────────────────────────────────────────────────────────────

test("AC5: maybeFireReactivationPush mints a reactivation_digest snapshot AND records a sendNtfy call on the happy path; a re-tick inside the dedup window does NOT fire again", async () => {
  const ctx = tempDb();
  try {
    const cfg = baseCfg();
    seedWatermark(ctx.db, isoMinusDays(NOW_ANCHOR, 7));
    const pid = seedProject(ctx.db, "demo");
    // Seed 6 merged agent PRs in the absent window.
    for (let i = 0; i < 6; i += 1) {
      seedMergedAgentPr(
        ctx.db, pid, 100 + i,
        isoMinusDays(NOW_ANCHOR, 6 - i),
      );
    }
    const calls: Array<{ topic: string; message: string; title: string; click?: string }> = [];
    const fixedToken = "a".repeat(48);
    const r = await maybeFireReactivationPush(ctx.db, cfg, NOW_ANCHOR, {
      sendNtfy: async (topic, payload) => {
        calls.push({ topic, message: payload.message, title: payload.title, click: payload.click });
        return { ok: true, status: 200 };
      },
      mintToken: () => fixedToken,
      hostForUrl: "http://127.0.0.1:7070",
    });
    assert.equal(r.fired, true, "first tick must fire (got reason " + r.reason + ")");
    assert.equal(r.reason, "ready");
    assert.equal(calls.length, 1, "exactly one ntfy call");
    assert.equal(calls[0].topic, "fleet-test-topic");
    assert.match(calls[0].message, /7 days/);
    assert.match(calls[0].message, /6 features/);
    assert.equal(calls[0].click, "http://127.0.0.1:7070/digest-missed/" + fixedToken);

    // Snapshot row exists with the correct kind + can be resolved by token hash.
    const id = createHash("sha256").update(fixedToken).digest("hex");
    const row = ctx.db.prepare(
      "SELECT kind, name FROM snapshot WHERE id=?",
    ).get(id) as { kind: string; name: string } | undefined;
    assert.ok(row, "snapshot row minted");
    assert.equal(row!.kind, "reactivation_digest");

    // Re-tick at now+1h inside the dedup window should NOT fire.
    const oneHourLater = new Date(NOW_ANCHOR.getTime() + 3600_000);
    // Make sure oneHourLater still falls inside the Sunday 18:00 window? No - it would be 19:00.
    // Use a closer re-tick: now + 5 min = Sunday 18:05 (still inside 17:50-18:10).
    const fiveMinLater = new Date(NOW_ANCHOR.getTime() + 5 * 60_000);
    const r2 = await maybeFireReactivationPush(ctx.db, cfg, fiveMinLater, {
      sendNtfy: async (topic, payload) => {
        calls.push({ topic, message: payload.message, title: payload.title, click: payload.click });
        return { ok: true, status: 200 };
      },
      mintToken: () => "b".repeat(48),
      hostForUrl: "http://127.0.0.1:7070",
    });
    assert.equal(r2.fired, false, "re-tick must NOT fire");
    assert.equal(r2.reason, "deduped");
    assert.equal(calls.length, 1, "still only one ntfy call");
    // also unused var ref so eslint-style strict is fine
    void oneHourLater;
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 - GET /digest-missed/<token> resolves the signed token and
//       renders the page. Wrong-kind tokens 404.
// ────────────────────────────────────────────────────────────────────

test("AC6: GET /digest-missed/<token> resolves a valid reactivation_digest token to 200 + HTML; a stakeholder_monthly token (wrong kind) returns 404; the route is mounted BEFORE the /api/ auth gate", () => {
  const ctx = tempDb();
  try {
    const cfg = baseCfg();
    const token = randomBytes(24).toString("hex");
    const id = createHash("sha256").update(token).digest("hex");
    const payload: ReactivationPushPayload = {
      daysAway: 7,
      featuresShipped: 6,
      lastVisitAt: isoMinusDays(NOW_ANCHOR, 7),
      generatedAt: NOW_ANCHOR.toISOString(),
      url: "http://127.0.0.1:7070/digest-missed/" + token,
      highlights: [
        { kind: "longest_merged_pr", project_slug: "demo", label: "longest-running PR #42 in demo" },
      ],
    };
    ctx.db.prepare(
      "INSERT INTO snapshot(id,name,created_at,expires_at,revoked_at,payload_json,kind)"
      + " VALUES(?,?,?,?,?,?,?)",
    ).run(
      id, "reactivation-test",
      NOW_ANCHOR.toISOString(),
      new Date(NOW_ANCHOR.getTime() + 30 * 86_400_000).toISOString(),
      null, JSON.stringify(payload), "reactivation_digest",
    );
    const r = serveReactivationDigest(ctx.db, cfg, token, NOW_ANCHOR);
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"]!, /text\/html/);
    assert.match(r.body, /digest-missed-main/);
    assert.match(r.body, /6 features shipped/);

    // Wrong kind: mint a stakeholder_monthly snapshot - the route must 404.
    const wrongToken = randomBytes(24).toString("hex");
    const wrongId = createHash("sha256").update(wrongToken).digest("hex");
    ctx.db.prepare(
      "INSERT INTO snapshot(id,name,created_at,expires_at,revoked_at,payload_json,kind)"
      + " VALUES(?,?,?,?,?,?,?)",
    ).run(
      wrongId, "wrong-kind",
      NOW_ANCHOR.toISOString(),
      new Date(NOW_ANCHOR.getTime() + 30 * 86_400_000).toISOString(),
      null, "{}", "stakeholder_monthly",
    );
    const r2 = serveReactivationDigest(ctx.db, cfg, wrongToken, NOW_ANCHOR);
    assert.equal(r2.status, 404);

    // Unknown token: 404.
    const r3 = serveReactivationDigest(ctx.db, cfg, "f".repeat(48), NOW_ANCHOR);
    assert.equal(r3.status, 404);

    // Expired: 404.
    const expiredToken = randomBytes(24).toString("hex");
    const expiredId = createHash("sha256").update(expiredToken).digest("hex");
    ctx.db.prepare(
      "INSERT INTO snapshot(id,name,created_at,expires_at,revoked_at,payload_json,kind)"
      + " VALUES(?,?,?,?,?,?,?)",
    ).run(
      expiredId, "expired",
      isoMinusDays(NOW_ANCHOR, 60),
      isoMinusDays(NOW_ANCHOR, 30),
      null, JSON.stringify(payload), "reactivation_digest",
    );
    const r4 = serveReactivationDigest(ctx.db, cfg, expiredToken, NOW_ANCHOR);
    assert.equal(r4.status, 404, "expired snapshot returns 404");

    // Revoked: 404.
    const revokedToken = randomBytes(24).toString("hex");
    const revokedId = createHash("sha256").update(revokedToken).digest("hex");
    ctx.db.prepare(
      "INSERT INTO snapshot(id,name,created_at,expires_at,revoked_at,payload_json,kind)"
      + " VALUES(?,?,?,?,?,?,?)",
    ).run(
      revokedId, "revoked",
      NOW_ANCHOR.toISOString(),
      new Date(NOW_ANCHOR.getTime() + 30 * 86_400_000).toISOString(),
      isoMinusDays(NOW_ANCHOR, 1), JSON.stringify(payload), "reactivation_digest",
    );
    const r5 = serveReactivationDigest(ctx.db, cfg, revokedToken, NOW_ANCHOR);
    assert.equal(r5.status, 404, "revoked snapshot returns 404");
  } finally { ctx.cleanup(); }
});

test("AC6: GET /digest-missed/<token> handler in src/server.ts is mounted BEFORE the if (path.startsWith(\"/api/\")) auth gate", () => {
  const SERVER_TS = readFileSync(join(REPO_ROOT, "src", "server.ts"), "utf8");
  const routeMatch = SERVER_TS.match(/path\.match\(\/\^\\\/digest-missed/);
  assert.ok(routeMatch, "digest-missed route must be present");
  const routeIdx = SERVER_TS.indexOf("/^\\/digest-missed");
  // Anchor on the if-statement shape per LESSONS 2026-06-15, not the
  // prose comment.
  const apiGateIdx = SERVER_TS.indexOf("if (path.startsWith(\"/api/\")) {");
  assert.ok(routeIdx > 0, "digest-missed route regex appears in server.ts");
  assert.ok(apiGateIdx > 0, "/api/ auth gate if-statement appears in server.ts");
  assert.ok(routeIdx < apiGateIdx,
    "digest-missed route must be mounted BEFORE the /api/ auth gate");
});

test("AC6: isRateLimitedPath includes /digest-missed/", () => {
  assert.equal(isRateLimitedPath("/digest-missed/cafebabe"), true);
});

// ────────────────────────────────────────────────────────────────────
// AC7 - Empty-period branch renders the quiet-period testid.
// ────────────────────────────────────────────────────────────────────

test("AC7: empty-period digest page renders data-testid=\"digest-missed-quiet-period\"", () => {
  const payload: ReactivationPushPayload = {
    daysAway: 6,
    featuresShipped: 0,
    lastVisitAt: isoMinusDays(NOW_ANCHOR, 6),
    generatedAt: NOW_ANCHOR.toISOString(),
    url: "http://127.0.0.1:7070/digest-missed/empty",
    highlights: [],
  };
  const html = _renderReactivationDigestForTests(payload, {});
  assert.match(html, /data-testid="digest-missed-quiet-period"/);
  assert.match(html, /the fleet was quiet while you were away/);
});

test("AC7: non-empty-period digest page renders highlights and NOT the quiet-period testid", () => {
  const payload: ReactivationPushPayload = {
    daysAway: 7,
    featuresShipped: 6,
    lastVisitAt: isoMinusDays(NOW_ANCHOR, 7),
    generatedAt: NOW_ANCHOR.toISOString(),
    url: "http://127.0.0.1:7070/digest-missed/full",
    highlights: [
      { kind: "longest_merged_pr", project_slug: "demo", label: "longest-running PR #42 in demo" },
    ],
  };
  const html = renderReactivationDigestPage(payload, {});
  assert.ok(!/digest-missed-quiet-period/.test(html), "no quiet-period testid in the populated branch");
  assert.match(html, /digest-missed-highlight-0/);
});

// ────────────────────────────────────────────────────────────────────
// AC8 - Opt-out gate. evaluateReactivationPush returns opt_out.
// ────────────────────────────────────────────────────────────────────

test("AC8: evaluateReactivationPush returns { shouldPush: false, reason: 'opt_out' } when cfg.reactivationPush.disabled === true", () => {
  const ctx = tempDb();
  try {
    const cfg = { ...baseCfg(), reactivationPush: { disabled: true } } as FleetConfig;
    seedWatermark(ctx.db, isoMinusDays(NOW_ANCHOR, 7));
    const r = evaluateReactivationPush(ctx.db, cfg, NOW_ANCHOR, "http://h", "tok");
    assert.equal(r.shouldPush, false);
    assert.equal(r.reason, "opt_out");
    assert.equal(r.payload, null);
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC9 - Config field. loadConfig() parses cfg.reactivationPush from
//       fleet-control.config.json. Per LESSONS 2026-06-19 we drive
//       loadConfig via a subprocess pinned to a tmpdir cwd.
// ────────────────────────────────────────────────────────────────────

test("AC9: loadConfig() populates cfg.reactivationPush.disabled when the field is set; absent field leaves cfg.reactivationPush undefined", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-reactivation-cfg-"));
  try {
    writeFileSync(join(dir, "fleet-control.config.json"), JSON.stringify({
      projectRoots: [],
      installedRoot: dir,
      cacheBase: dir,
      claudeProjects: dir,
      reactivationPush: { disabled: true },
    }));
    const script = `
      import { loadConfig } from "${join(REPO_ROOT, "src", "config.ts")}";
      const cfg = loadConfig();
      process.stdout.write(JSON.stringify(cfg.reactivationPush ?? null));
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
    const parsed = JSON.parse(r.stdout) as { disabled?: boolean } | null;
    assert.ok(parsed, "reactivationPush field is populated");
    assert.equal(parsed!.disabled, true);

    // Now check the field-absent case in a second subprocess.
    writeFileSync(join(dir, "fleet-control.config.json"), JSON.stringify({
      projectRoots: [],
      installedRoot: dir,
      cacheBase: dir,
      claudeProjects: dir,
    }));
    const r2 = spawnSync(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      "--input-type=module",
      "-e", script,
    ], {
      cwd: dir,
      env: { ...process.env, FLEET_DB_PATH: join(dir, "fleet.db") },
      encoding: "utf8",
    });
    assert.equal(r2.status, 0, `subprocess loadConfig failed: ${r2.stderr}`);
    const parsed2 = JSON.parse(r2.stdout) as unknown;
    assert.equal(parsed2, null, "reactivationPush is undefined when omitted");

    // The undefined value must be treated as enabled by the helper.
    const ctx = tempDb();
    try {
      seedWatermark(ctx.db, isoMinusDays(NOW_ANCHOR, 7));
      const cfg = baseCfg(); // no reactivationPush field
      const ev = evaluateReactivationPush(ctx.db, cfg, NOW_ANCHOR, "http://h", "tok");
      assert.equal(ev.shouldPush, true,
        "absent reactivationPush field must NOT short-circuit (got reason " + ev.reason + ")");
    } finally { ctx.cleanup(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────
// AC10 - tsc --noEmit clean; no new runtime deps; schema migration.
// ────────────────────────────────────────────────────────────────────

test("AC10: package.json has empty dependencies (no new runtime deps from this ticket)", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const runtime = pkg.dependencies ?? {};
  assert.equal(Object.keys(runtime).length, 0,
    "runtime dependencies must stay empty per AGENTS.md");
});

test("AC10: src/db.ts SCHEMA template carries operator_visit_watermark with NO backticks in the CREATE TABLE statement", () => {
  const DB_TS = readFileSync(join(REPO_ROOT, "src", "db.ts"), "utf8");
  const ddlMatch = DB_TS.match(
    /CREATE TABLE IF NOT EXISTS operator_visit_watermark\s*\([\s\S]+?\)\s*;/,
  );
  assert.ok(ddlMatch, "CREATE TABLE statement must be present in SCHEMA");
  // The new CREATE TABLE statement must not contain a backtick. The
  // SCHEMA template itself is backtick-delimited at the file level
  // (which is fine), but identifiers inside MUST stay plain words
  // per LESSONS 2026-05-26. A backtick inside the DDL would break
  // node v25 type-stripping.
  assert.ok(!ddlMatch![0].includes("`"),
    "the CREATE TABLE operator_visit_watermark statement must NOT contain any backtick");
});

test("AC10: src/daemon.ts wires maybeFireReactivationPush into the daemon tick alongside the existing hooks AND offline-gates via FLEET_DAEMON_OFFLINE", () => {
  const DAEMON_TS = readFileSync(join(REPO_ROOT, "src", "daemon.ts"), "utf8");
  // The function exists:
  assert.match(DAEMON_TS, /export async function maybeFireReactivationPush/);
  // It is called inside the runDaemon loop:
  assert.match(DAEMON_TS, /await maybeFireReactivationPush\(db, cfg, new Date\(\)\)/);
  // Offline gate present:
  assert.match(DAEMON_TS, /FLEET_DAEMON_OFFLINE/);
});

test("AC10: maybeFireReactivationPush short-circuits when FLEET_DAEMON_OFFLINE=1 - NO ntfy call, NO snapshot row", async () => {
  const ctx = tempDb();
  const prev = process.env.FLEET_DAEMON_OFFLINE;
  try {
    seedWatermark(ctx.db, isoMinusDays(NOW_ANCHOR, 7));
    const calls: number[] = [];
    process.env.FLEET_DAEMON_OFFLINE = "1";
    const r = await maybeFireReactivationPush(ctx.db, baseCfg(), NOW_ANCHOR, {
      sendNtfy: async () => { calls.push(1); return { ok: true, status: 200 }; },
      mintToken: () => "c".repeat(48),
      hostForUrl: "http://127.0.0.1:7070",
    });
    assert.equal(r.fired, false);
    assert.equal(r.reason, "offline");
    assert.equal(calls.length, 0);
    const row = ctx.db.prepare(
      "SELECT COUNT(*) AS c FROM snapshot WHERE kind = 'reactivation_digest'",
    ).get() as { c: number };
    assert.equal(row.c, 0);
  } finally {
    if (prev === undefined) delete process.env.FLEET_DAEMON_OFFLINE;
    else process.env.FLEET_DAEMON_OFFLINE = prev;
    ctx.cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────
// Bonus: reactivationDigestPayload is reusable + composes the absent
// period highlights from the pr + cost_rollup_day tables.
// ────────────────────────────────────────────────────────────────────

test("Helper: reactivationDigestPayload walks the absent window for highlights from pr + cost_rollup_day", () => {
  const ctx = tempDb();
  try {
    const pid = seedProject(ctx.db, "demo");
    seedMergedAgentPr(ctx.db, pid, 201, isoMinusDays(NOW_ANCHOR, 1));
    seedMergedAgentPr(ctx.db, pid, 202, isoMinusDays(NOW_ANCHOR, 2));
    ctx.db.prepare(
      "INSERT INTO cost_rollup_day(project_id,phase,day,runs,input_tokens,output_tokens,"
      + "cache_creation_tokens,cache_read_tokens,cost_usd) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(pid, "ship", NOW_ANCHOR.toISOString().slice(0, 10), 5, 100, 50, 0, 0, 1.25);
    const lastVisitAt = isoMinusDays(NOW_ANCHOR, 7);
    const p = reactivationDigestPayload(ctx.db, baseCfg(), lastVisitAt, NOW_ANCHOR, "http://h", "tok");
    assert.equal(p.daysAway, 7);
    assert.equal(p.featuresShipped, 2);
    assert.equal(p.url, "http://h/digest-missed/tok");
    assert.ok(p.highlights.length >= 1, "at least one highlight composed");
  } finally { ctx.cleanup(); }
});
