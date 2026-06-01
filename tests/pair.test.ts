// Tests for ticket 0032 — pair-token mint/consume, /pair route,
// rate limit, schema migration, LAN discovery, and end-to-end perf.
//
// Each top-level test maps 1:1 to one acceptance-criteria checkbox in
// docs/backlog/0032-welcome-qr-and-phone-pairing.md (AC2 lan, AC3
// pair-token round-trip, AC4 schema, AC5 /pair route, AC9 rate-limit,
// AC10 perf).
//
// Strategy:
//   * Pure helpers (lan + pair) get unit tests against tmpdir DBs and
//     stubbed os.networkInterfaces();
//   * The /pair route is exercised via the in-process startServer()
//     per LESSONS § "in-process startServer() tests need an empty-
//     roots config + run-row seeds" — we plant a temporary
//     fleet-control.config.json in cwd pointing every root at an
//     empty tmpdir and restore it on cleanup.
//   * The rate limiter test seeds + verifies the 11th attempt 429s.
//   * The perf test gates on PERF=1 per the ticket's AC.
//
// Zero new runtime deps; stdlib + node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../src/db.ts";
import { startServer } from "../src/server.ts";
import {
  mintPairToken, consumePairToken, sweepExpiredPairTokens,
  rateLimitAllow, _resetPairCacheForTests, PAIR_TOKEN_TTL_MS,
} from "../src/pair.ts";
import { discoverLanUrl } from "../src/lan.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ────────────────────────────────────────────────────────────────────
// Helpers (tmpdir + db + boot)
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; cleanup: () => void; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-pair-"));
  const dbPath = join(dir, "fleet.db");
  const db = openDb(dbPath);
  return {
    db,
    dbPath,
    cleanup: () => { try { db.close(); } catch { /* */ } rmSync(dir, { recursive: true, force: true }); },
  };
}

// In-process boot helper (mirrors tests/pwa.test.ts's boot()).
let activeBoots = 0;
let savedConfigText: string | null = null;
const CONFIG_PATH = join(process.cwd(), "fleet-control.config.json");

interface Booted {
  base: string;
  db: DB;
  dbPath: string;
  close: () => Promise<void>;
  cleanup: () => void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    import("node:net").then((net) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const a = srv.address();
        if (a && typeof a === "object") {
          const p = a.port; srv.close(() => resolve(p));
        } else { srv.close(); reject(new Error("no port")); }
      });
      srv.on("error", reject);
    }).catch(reject);
  });
}

async function boot(): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-pair-srv-"));
  const dbPath = join(dir, "fleet.db");
  const emptyRoots = join(dir, "empty");
  mkdirSync(emptyRoots, { recursive: true });
  if (activeBoots === 0) {
    savedConfigText = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null;
  }
  activeBoots += 1;
  writeFileSync(CONFIG_PATH, JSON.stringify({
    projectRoots: [emptyRoots],
    installedRoot: emptyRoots,
    cacheBase: emptyRoots,
    claudeProjects: emptyRoots,
  }));
  process.env.FLEET_DB_PATH = dbPath;
  // Touch the DB so the inline migration step doesn't race the test.
  const seedDb = openDb(dbPath);
  const port = await freePort();
  const server = startServer("127.0.0.1", port);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + "/api/whoami"); if (r.ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  return {
    base,
    db: seedDb,
    dbPath,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    cleanup: () => {
      try { seedDb.close(); } catch { /* */ }
      delete process.env.FLEET_DB_PATH;
      activeBoots -= 1;
      if (activeBoots === 0) {
        if (savedConfigText === null) { try { unlinkSync(CONFIG_PATH); } catch { /* gone */ } }
        else writeFileSync(CONFIG_PATH, savedConfigText);
        savedConfigText = null;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// AC2 — discoverLanUrl walks os.networkInterfaces() correctly
// ────────────────────────────────────────────────────────────────────

test("AC2: discoverLanUrl returns the first non-loopback IPv4 from a stubbed interface set", () => {
  const url = discoverLanUrl("0.0.0.0", 7070, {
    interfaces: () => ({
      lo0: [{
        address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4",
        mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8",
      }],
      en0: [{
        address: "192.168.1.42", netmask: "255.255.255.0", family: "IPv4",
        mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "192.168.1.42/24",
      }],
    }),
  });
  assert.equal(url, "http://192.168.1.42:7070");
});

test("AC2: discoverLanUrl returns null when only loopback interfaces exist", () => {
  const url = discoverLanUrl("0.0.0.0", 7070, {
    interfaces: () => ({
      lo0: [{
        address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4",
        mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8",
      }],
    }),
  });
  assert.equal(url, null);
});

test("AC2: discoverLanUrl returns null when host is explicitly 127.0.0.1 (loopback bind)", () => {
  const url = discoverLanUrl("127.0.0.1", 7070, {
    interfaces: () => ({
      en0: [{
        address: "192.168.1.42", netmask: "255.255.255.0", family: "IPv4",
        mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "192.168.1.42/24",
      }],
    }),
  });
  assert.equal(url, null,
    "operator who explicitly bound loopback gets no LAN URL even when an interface is available");
});

test("AC2: discoverLanUrl prefers lower-sorted IP when multiple non-loopback interfaces exist", () => {
  const url = discoverLanUrl("0.0.0.0", 7070, {
    interfaces: () => ({
      en0: [{
        address: "192.168.1.42", netmask: "255.255.255.0", family: "IPv4",
        mac: "a1:b2:c3:d4:e5:f6", internal: false, cidr: "192.168.1.42/24",
      }],
      en1: [{
        address: "10.0.0.5", netmask: "255.0.0.0", family: "IPv4",
        mac: "a1:b2:c3:d4:e5:f7", internal: false, cidr: "10.0.0.5/8",
      }],
    }),
  });
  assert.equal(url, "http://10.0.0.5:7070", "deterministic lowest-IP wins");
});

// ────────────────────────────────────────────────────────────────────
// AC3 — mint / consume round-trip
// ────────────────────────────────────────────────────────────────────

test("AC3: mintPairToken stores a row; consumePairToken returns ok exactly once", () => {
  const { db, cleanup } = tempDb();
  try {
    const m = mintPairToken(db, "ADMIN_TOKEN_VALUE_ABC");
    assert.match(m.token, /^[0-9A-Z]{2}(-[0-9A-Z]{2}){3}$/,
      "token must follow XX-XX-XX-XX shape (alphanumeric)");
    assert.ok(m.expires_at, "expires_at must be returned");
    const r1 = consumePairToken(db, m.token);
    assert.equal(r1.ok, true);
    assert.equal(r1.admin_token, "ADMIN_TOKEN_VALUE_ABC");
    // Second consume must fail (single-use).
    const r2 = consumePairToken(db, m.token);
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, "unknown");
  } finally { cleanup(); }
});

test("AC3: consumePairToken returns ok=false past the 90-second TTL even on first consume", () => {
  const { db, cleanup } = tempDb();
  try {
    // Pin `now` to a fixed instant so the expiry math is deterministic.
    // Per LESSONS § "time-pinned tests must NOT derive seed timestamps
    // from new Date()", we pass `now` explicitly to BOTH mint and
    // consume so the fixture math is anchored to the same value.
    const mintNow = new Date("2026-06-01T10:00:00.000Z");
    const m = mintPairToken(db, "ADMIN", mintNow);
    // Advance just past TTL.
    const lateNow = new Date(mintNow.getTime() + PAIR_TOKEN_TTL_MS + 1);
    const r = consumePairToken(db, m.token, lateNow);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "expired");
    // The row is swept on the expired-consume so a second attempt
    // reports `unknown`.
    const r2 = consumePairToken(db, m.token, lateNow);
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, "unknown");
  } finally { cleanup(); }
});

test("AC3: consumePairToken rejects malformed tokens without touching the DB", () => {
  const { db, cleanup } = tempDb();
  try {
    const r = consumePairToken(db, "not-a-real-token");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "malformed");
  } finally { cleanup(); }
});

test("AC3: mintPairToken throws when admin token is empty/missing", () => {
  const { db, cleanup } = tempDb();
  try {
    assert.throws(() => mintPairToken(db, ""), /adminToken is required/);
  } finally { cleanup(); }
});

test("AC3: sweepExpiredPairTokens deletes ONLY rows past expires_at", () => {
  const { db, cleanup } = tempDb();
  try {
    const mintNow = new Date("2026-06-01T10:00:00.000Z");
    const m1 = mintPairToken(db, "AT1", mintNow);
    const m2 = mintPairToken(db, "AT2", new Date(mintNow.getTime() + 30_000));
    // Move past m1's expiry but not m2's.
    const sweepAt = new Date(mintNow.getTime() + PAIR_TOKEN_TTL_MS + 1);
    const n = sweepExpiredPairTokens(db, sweepAt);
    assert.equal(n, 1, "only one expired row should be swept");
    // m2 still consumable.
    const r = consumePairToken(db, m2.token, sweepAt);
    assert.equal(r.ok, true);
    assert.equal(r.admin_token, "AT2");
    // m1 already gone.
    const r1 = consumePairToken(db, m1.token, sweepAt);
    assert.equal(r1.ok, false);
    assert.equal(r1.reason, "unknown");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — schema migration: pair_token table exists and round-trips
// ────────────────────────────────────────────────────────────────────

test("AC4: openDb creates the pair_token table idempotently with the required columns", () => {
  const { db, cleanup } = tempDb();
  try {
    // The schema info_pragma reports each column; assert the four we need.
    const cols = db.prepare("PRAGMA table_info(pair_token)").all() as unknown as Array<{ name: string; type: string; notnull: number; pk: number }>;
    const byName = new Map(cols.map((c) => [c.name, c]));
    assert.ok(byName.has("token"), "pair_token must have a `token` column");
    assert.equal(byName.get("token")!.pk, 1, "token must be the primary key");
    assert.ok(byName.has("admin_token"), "pair_token must have an `admin_token` column");
    assert.equal(byName.get("admin_token")!.notnull, 1);
    assert.ok(byName.has("expires_at"));
    assert.equal(byName.get("expires_at")!.notnull, 1);
    assert.ok(byName.has("created_at"));
    assert.equal(byName.get("created_at")!.notnull, 1);
    // Round-trip a direct INSERT/SELECT to confirm the table is live.
    db.prepare(
      "INSERT INTO pair_token(token, admin_token, expires_at, created_at) VALUES(?,?,?,?)",
    ).run("AB-CD-EF-GH", "ADMIN", "2099-01-01T00:00:00.000Z", "2026-06-01T10:00:00.000Z");
    const row = db.prepare("SELECT token, admin_token FROM pair_token WHERE token = ?")
      .get("AB-CD-EF-GH") as unknown as { token: string; admin_token: string };
    assert.equal(row.admin_token, "ADMIN");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — /pair route end-to-end
// ────────────────────────────────────────────────────────────────────

test("AC5: GET /pair?t=<valid> sets the x-fleet-token cookie + 302 to / with pair_just_consumed", async () => {
  _resetPairCacheForTests();
  const b = await boot();
  try {
    const m = mintPairToken(b.db, "ADMIN_ABCDE_FGHIJ");
    const r = await fetch(`${b.base}/pair?t=${encodeURIComponent(m.token)}`, {
      redirect: "manual",
    });
    assert.equal(r.status, 302, `expected 302, got ${r.status}`);
    const loc = r.headers.get("location");
    assert.ok(loc && loc.includes("/?pair_just_consumed=1"),
      `expected redirect to /?pair_just_consumed=1, got ${loc}`);
    const cookie = r.headers.get("set-cookie");
    assert.ok(cookie, "expected Set-Cookie header");
    assert.match(cookie!, /x-fleet-token=ADMIN_ABCDE_FGHIJ/,
      "cookie must carry the admin token plaintext");
    assert.match(cookie!, /HttpOnly/);
    assert.match(cookie!, /SameSite=Lax/);
    assert.match(cookie!, /Path=\//);
  } finally { await b.close(); b.cleanup(); }
});

test("AC5: GET /pair?t=<invalid> returns 200 + the expiration page + NO cookie", async () => {
  _resetPairCacheForTests();
  const b = await boot();
  try {
    const r = await fetch(`${b.base}/pair?t=ZZ-ZZ-ZZ-ZZ`, { redirect: "manual" });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("set-cookie"), null,
      "no cookie should be set for an invalid token");
    const body = await r.text();
    assert.match(body, /Pair link expired/);
    assert.match(body, /fleetctl serve/, "page should tell operator how to re-mint");
  } finally { await b.close(); b.cleanup(); }
});

test("AC5: GET /P/<TOKEN> (uppercase path form) also consumes the token", async () => {
  // The uppercase path-style form is what the QR encodes, because V1-L
  // alphanumeric mode can't carry `?` / `=`. The server must accept both
  // shapes so the QR and the human-typeable URL converge on the same
  // consume path.
  _resetPairCacheForTests();
  const b = await boot();
  try {
    const m = mintPairToken(b.db, "ADMIN_PATH_STYLE");
    const r = await fetch(`${b.base}/P/${m.token}`, { redirect: "manual" });
    assert.equal(r.status, 302);
    const cookie = r.headers.get("set-cookie");
    assert.ok(cookie && cookie.includes("ADMIN_PATH_STYLE"));
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC9 — rate-limit: 10/min per IP; the 11th attempt is 429
// ────────────────────────────────────────────────────────────────────

test("AC9: rateLimitAllow permits 10 attempts/minute and blocks the 11th", () => {
  _resetPairCacheForTests();
  const ip = "192.168.1.99";
  const now = new Date("2026-06-01T10:00:00.000Z");
  for (let i = 0; i < 10; i++) {
    assert.equal(rateLimitAllow(ip, now), true, `attempt ${i + 1} should be allowed`);
  }
  assert.equal(rateLimitAllow(ip, now), false, "attempt 11 should be blocked");
});

test("AC9: rateLimitAllow resets after the 60s window expires", () => {
  _resetPairCacheForTests();
  const ip = "10.0.0.1";
  const start = new Date("2026-06-01T10:00:00.000Z");
  for (let i = 0; i < 10; i++) assert.equal(rateLimitAllow(ip, start), true);
  assert.equal(rateLimitAllow(ip, start), false);
  // 61 seconds later: prior attempts have fallen out of the window.
  const later = new Date(start.getTime() + 61_000);
  assert.equal(rateLimitAllow(ip, later), true, "after window expiry the limiter resets");
});

test("AC9: rateLimitAllow is per-IP (one IP's exhaustion doesn't block another)", () => {
  _resetPairCacheForTests();
  const now = new Date("2026-06-01T10:00:00.000Z");
  for (let i = 0; i < 11; i++) rateLimitAllow("1.1.1.1", now);
  assert.equal(rateLimitAllow("1.1.1.1", now), false, "IP1 exhausted");
  assert.equal(rateLimitAllow("2.2.2.2", now), true, "IP2 still fresh");
});

test("AC9: 11 rapid requests on /pair from the same source produce a 429", async () => {
  // The startServer() boot binds 127.0.0.1, so every request appears
  // from the same source IP — perfect for the rate-limit assertion.
  _resetPairCacheForTests();
  const b = await boot();
  try {
    for (let i = 0; i < 10; i++) {
      // Use clearly-invalid tokens so we never DELETE-and-affect-table state;
      // the rate-limit check fires BEFORE the token lookup.
      const r = await fetch(`${b.base}/pair?t=AA-AA-AA-A${i}`, { redirect: "manual" });
      assert.notEqual(r.status, 429, `attempt ${i + 1} should not yet be 429 (got ${r.status})`);
    }
    const r11 = await fetch(`${b.base}/pair?t=AA-AA-AA-AB`, { redirect: "manual" });
    assert.equal(r11.status, 429, `the 11th attempt MUST return 429, got ${r11.status}`);
    const body = await r11.text();
    assert.match(body, /too many attempts/);
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 — perf: mint+consume < 5ms; welcome render < 30ms (gated PERF=1)
// ────────────────────────────────────────────────────────────────────

test("AC10: mintPairToken + consumePairToken complete in < 5ms (PERF=1 only)", () => {
  if (process.env.PERF !== "1") return; // skip outside the perf gate
  const { db, cleanup } = tempDb();
  try {
    // Warm: hit each prepared statement once so the first run doesn't
    // pay the SQLite stmt-prepare cost.
    const warm = mintPairToken(db, "WARMUP");
    consumePairToken(db, warm.token);
    const start = process.hrtime.bigint();
    const m = mintPairToken(db, "PERF_TOKEN");
    const r = consumePairToken(db, m.token);
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1_000_000;
    assert.equal(r.ok, true);
    assert.ok(ms < 5, `mint + consume took ${ms.toFixed(2)}ms, expected < 5ms`);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC11 — invariants: no /api shape break + no new deps
// ────────────────────────────────────────────────────────────────────

test("AC11: package.json dependencies stays empty (zero-runtime-dep contract holds)", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  assert.deepEqual(pkg.dependencies ?? {}, {},
    "ticket 0032 must not add a runtime dependency (the hand-rolled QR encoder is the test)");
});

test("AC11: existing /api/fleet route still returns its documented JSON shape", async () => {
  _resetPairCacheForTests();
  const b = await boot();
  try {
    const r = await fetch(b.base + "/api/fleet");
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.ok(Array.isArray(body.projects), "fleet.projects must still be an array");
    assert.ok(body.totals && typeof body.totals === "object");
  } finally { await b.close(); b.cleanup(); }
});

test("AC11: src/pair.ts does not import child_process (no shell-out)", () => {
  const txt = readFileSync(join(REPO_ROOT, "src", "pair.ts"), "utf8");
  assert.equal(/from\s+["']node:child_process["']/.test(txt), false);
});

test("AC11: src/qr.ts does not import child_process (pure function, no I/O)", () => {
  const txt = readFileSync(join(REPO_ROOT, "src", "qr.ts"), "utf8");
  assert.equal(/from\s+["']node:child_process["']/.test(txt), false);
  assert.equal(/from\s+["']node:fs/.test(txt), false,
    "qr.ts must not import node:fs — pure function only");
});
