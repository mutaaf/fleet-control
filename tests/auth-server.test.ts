// Integration tests for src/server.ts:requireAuth — the chokepoint that
// gates every JSON/SSE route. We feed it synthetic request objects with the
// shape node:http would hand us, so we don't need to spin up the real
// listener (zero new dependencies, deterministic).
//
// This covers the AC checkbox from docs/backlog/0003-scoped-tokens-audit.md:
//   "mint a token, hit a route with it, assert success; revoke it, assert 401."
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { mintToken, revokeToken } from "../src/auth.ts";
import { requireAuth } from "../src/server.ts";

function tempDb(): { db: ReturnType<typeof openDb>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-auth-srv-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** Build the minimal req object requireAuth touches: { socket, headers }. */
function fakeReq(opts: { ip?: string; token?: string } = {}): any {
  return {
    socket: { remoteAddress: opts.ip ?? "10.0.0.5" },
    headers: opts.token ? { "x-fleet-token": opts.token } : {},
  };
}

test("requireAuth: loopback always passes regardless of scope", () => {
  const { db, cleanup } = tempDb();
  try {
    for (const ip of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const r = requireAuth(db, fakeReq({ ip }), "admin");
      assert.equal(r.ok, true, `loopback ${ip} should pass admin scope`);
      assert.equal(r.principal, null, "loopback principal is null (no token)");
    }
  } finally { cleanup(); }
});

test("requireAuth: remote with no token → 401", () => {
  const { db, cleanup } = tempDb();
  try {
    const r = requireAuth(db, fakeReq(), "read");
    assert.equal(r.ok, false);
    assert.equal(r.status, 401);
    assert.match(r.message, /pair this device|not authorized/i);
  } finally { cleanup(); }
});

test("requireAuth: remote with a minted read token → ok for read, 403 for control", () => {
  const { db, cleanup } = tempDb();
  try {
    const m = mintToken(db, "phone", "read");
    const okRead = requireAuth(db, fakeReq({ token: m.token }), "read");
    assert.equal(okRead.ok, true, "read token should satisfy read route");
    assert.equal(okRead.principal?.name, "phone");

    const denied = requireAuth(db, fakeReq({ token: m.token }), "control");
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 403, "read token must NOT satisfy a control route");
    assert.match(denied.message, /scope/);
  } finally { cleanup(); }
});

test("requireAuth: admin token satisfies every scope", () => {
  const { db, cleanup } = tempDb();
  try {
    const m = mintToken(db, "laptop", "admin");
    for (const scope of ["read", "control", "admin"] as const) {
      const r = requireAuth(db, fakeReq({ token: m.token }), scope);
      assert.equal(r.ok, true, `admin must satisfy scope ${scope}`);
      assert.equal(r.principal?.scope, "admin");
    }
  } finally { cleanup(); }
});

test("requireAuth: mint → hit → revoke → next hit is 401 (AC ticket 0003)", () => {
  const { db, cleanup } = tempDb();
  try {
    const m = mintToken(db, "tablet", "control");

    const first = requireAuth(db, fakeReq({ token: m.token }), "control");
    assert.equal(first.ok, true, "fresh token should authenticate");

    const revoked = revokeToken(db, m.id_prefix);
    assert.equal(revoked, true);

    const after = requireAuth(db, fakeReq({ token: m.token }), "control");
    assert.equal(after.ok, false, "revoked token must NOT authenticate");
    assert.equal(after.status, 401);
    assert.match(after.message, /unknown or revoked/);
  } finally { cleanup(); }
});

test("requireAuth: ?token= query string is accepted (SSE fallback)", () => {
  const { db, cleanup } = tempDb();
  try {
    const m = mintToken(db, "browser", "read");
    const url = new URL(`http://x/api/projects/foo/stream?token=${encodeURIComponent(m.token)}`);
    // No x-fleet-token header — only the query string carries the token.
    const r = requireAuth(db, fakeReq(), "read", url);
    assert.equal(r.ok, true, "query-string token should authenticate SSE callers");
    assert.equal(r.principal?.name, "browser");
  } finally { cleanup(); }
});

test("requireAuth: garbage token → 401, never throws", () => {
  const { db, cleanup } = tempDb();
  try {
    for (const t of ["", "junk", "x".repeat(500)]) {
      const r = requireAuth(db, fakeReq({ token: t }), "read");
      assert.equal(r.ok, false);
      assert.equal(r.status, 401);
    }
  } finally { cleanup(); }
});
