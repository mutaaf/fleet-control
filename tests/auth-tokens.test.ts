// Unit tests for src/auth.ts — per-user scoped tokens with audit log.
// Acceptance criteria from docs/backlog/0003-scoped-tokens-audit.md:
//   - auth_token(id, name, scope, created_at, last_used_at, revoked_at)
//   - mintToken(db, name, scope) returns plaintext once; only SHA256 is stored
//   - listTokens(db) shows id-prefix (first 8 chars), name, scope, etc.
//   - revokeToken(db, id-prefix) sets revoked_at
//   - authenticate(db, token) hashes & looks up, updates last_used_at, rejects
//     revoked tokens, returns scope; null on miss.
//   - scope enforcement: admin > control > read (hierarchical).
//   - control_audit grows an `actor_name` column; existing rows back-fill as
//     "admin (legacy)".
//   - legacy adminToken auto-migration: if fleet-control.config.json has an
//     adminToken and auth_token is empty, accept it once + migrate it in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openDb } from "../src/db.ts";
import {
  mintToken,
  listTokens,
  revokeToken,
  authenticate,
  scopeAllows,
  migrateLegacyAdminTokenIfPresent,
} from "../src/auth.ts";

function tempDb(): { db: ReturnType<typeof openDb>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-auth-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("auth_token table exists with the required columns", () => {
  const { db, cleanup } = tempDb();
  try {
    const cols = db.prepare("PRAGMA table_info(auth_token)").all() as any[];
    const names = cols.map((c) => c.name).sort();
    for (const want of ["id", "name", "scope", "created_at", "last_used_at", "revoked_at"]) {
      assert.ok(names.includes(want), `auth_token missing column ${want}; have: ${names.join(",")}`);
    }
  } finally { cleanup(); }
});

test("control_audit gained the actor_name column (additive ALTER)", () => {
  const { db, cleanup } = tempDb();
  try {
    const cols = db.prepare("PRAGMA table_info(control_audit)").all() as any[];
    const names = cols.map((c) => c.name);
    assert.ok(names.includes("actor_name"), `control_audit missing actor_name; have: ${names.join(",")}`);
  } finally { cleanup(); }
});

test("mintToken returns plaintext once; DB only stores the SHA256 of it", () => {
  const { db, cleanup } = tempDb();
  try {
    const minted = mintToken(db, "phone", "read");
    assert.ok(minted.token && typeof minted.token === "string", "token must be returned in plaintext");
    assert.ok(minted.token.length >= 24, "token should be reasonably long");
    assert.equal(minted.name, "phone");
    assert.equal(minted.scope, "read");
    assert.equal(minted.id_prefix.length, 8);

    // The DB row must store the SHA256 hash as id, NOT the plaintext.
    const expectedHash = createHash("sha256").update(minted.token).digest("hex");
    const row = db.prepare("SELECT id, name, scope FROM auth_token WHERE name=?").get("phone") as any;
    assert.equal(row.id, expectedHash, "stored id must be SHA256(token)");
    assert.equal(row.scope, "read");
    // The plaintext token must not appear anywhere in the row
    assert.ok(!JSON.stringify(row).includes(minted.token), "plaintext token leaked into DB row");
    // id_prefix is the first 8 chars of the stored hash
    assert.equal(minted.id_prefix, expectedHash.slice(0, 8));
  } finally { cleanup(); }
});

test("mintToken rejects invalid scopes", () => {
  const { db, cleanup } = tempDb();
  try {
    assert.throws(() => mintToken(db, "bad", "root" as any), /scope/i);
    assert.throws(() => mintToken(db, "bad", "" as any), /scope/i);
  } finally { cleanup(); }
});

test("mintToken rejects empty / overlong names", () => {
  const { db, cleanup } = tempDb();
  try {
    assert.throws(() => mintToken(db, "", "read"), /name/i);
    assert.throws(() => mintToken(db, "x".repeat(200), "read"), /name/i);
  } finally { cleanup(); }
});

test("listTokens returns id-prefix, name, scope, last_used, revoked — never the full hash", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = mintToken(db, "laptop", "admin");
    const b = mintToken(db, "phone", "read");
    const rows = listTokens(db);
    assert.equal(rows.length, 2);
    const phone = rows.find((r) => r.name === "phone");
    const laptop = rows.find((r) => r.name === "laptop");
    assert.ok(phone && laptop);
    assert.equal(phone!.id_prefix, b.id_prefix);
    assert.equal(phone!.scope, "read");
    assert.equal(phone!.revoked_at, null);
    assert.equal(laptop!.scope, "admin");
    // The full SHA256 must not leak in the listing — only the 8-char prefix.
    for (const r of rows) {
      assert.equal(r.id_prefix.length, 8);
      assert.ok(!("id" in r) || (r as any).id === undefined,
        "listTokens row must not expose the full hash as id");
    }
  } finally { cleanup(); }
});

test("revokeToken by id-prefix sets revoked_at; subsequent authenticate returns null", () => {
  const { db, cleanup } = tempDb();
  try {
    const m = mintToken(db, "tablet", "control");
    assert.equal(authenticate(db, m.token)?.scope, "control");

    const ok = revokeToken(db, m.id_prefix);
    assert.equal(ok, true);
    const row = db.prepare("SELECT revoked_at FROM auth_token WHERE name=?").get("tablet") as any;
    assert.ok(row.revoked_at, "revoked_at must be set");

    assert.equal(authenticate(db, m.token), null, "revoked tokens must not authenticate");
  } finally { cleanup(); }
});

test("revokeToken: unknown prefix returns false (no crash)", () => {
  const { db, cleanup } = tempDb();
  try {
    assert.equal(revokeToken(db, "deadbeef"), false);
  } finally { cleanup(); }
});

test("revokeToken: ambiguous prefix (impossibly short) is rejected", () => {
  const { db, cleanup } = tempDb();
  try {
    // Guardrail — prefixes shorter than 4 chars are refused outright.
    assert.throws(() => revokeToken(db, "ab"), /prefix/i);
  } finally { cleanup(); }
});

test("authenticate updates last_used_at on success", () => {
  const { db, cleanup } = tempDb();
  try {
    const m = mintToken(db, "phone", "read");
    const before = db.prepare("SELECT last_used_at FROM auth_token WHERE name=?").get("phone") as any;
    assert.equal(before.last_used_at, null);
    const r = authenticate(db, m.token);
    assert.ok(r, "valid token should authenticate");
    const after = db.prepare("SELECT last_used_at FROM auth_token WHERE name=?").get("phone") as any;
    assert.ok(after.last_used_at, "last_used_at must update on a successful auth");
  } finally { cleanup(); }
});

test("authenticate returns null for an unknown token", () => {
  const { db, cleanup } = tempDb();
  try {
    assert.equal(authenticate(db, "nope-never-minted-this-one"), null);
  } finally { cleanup(); }
});

test("scopeAllows: admin > control > read (strict hierarchy)", () => {
  // read scope can only call read routes
  assert.equal(scopeAllows("read", "read"), true);
  assert.equal(scopeAllows("read", "control"), false);
  assert.equal(scopeAllows("read", "admin"), false);
  // control covers read + control
  assert.equal(scopeAllows("control", "read"), true);
  assert.equal(scopeAllows("control", "control"), true);
  assert.equal(scopeAllows("control", "admin"), false);
  // admin covers everything
  assert.equal(scopeAllows("admin", "read"), true);
  assert.equal(scopeAllows("admin", "control"), true);
  assert.equal(scopeAllows("admin", "admin"), true);
});

test("legacy adminToken in config: auto-migrates into auth_token on first authenticate", () => {
  const { db, cleanup } = tempDb();
  const dir = mkdtempSync(join(tmpdir(), "fleet-auth-cfg-"));
  const cfgPath = join(dir, "fleet-control.config.json");
  const legacy = "legacy-admin-token-abcdef1234567890";
  writeFileSync(cfgPath, JSON.stringify({ adminToken: legacy }, null, 2));
  try {
    // Before migration: auth_token table is empty
    const before = db.prepare("SELECT COUNT(*) AS n FROM auth_token").get() as any;
    assert.equal(before.n, 0);

    // Migrate (called once at server boot)
    migrateLegacyAdminTokenIfPresent(db, cfgPath);

    // After migration: the legacy token now lives as a named admin token,
    // AND the config field is cleared from disk.
    const after = db.prepare("SELECT name, scope FROM auth_token").all() as any[];
    assert.equal(after.length, 1);
    assert.equal(after[0].scope, "admin");
    assert.match(after[0].name, /legacy/i);

    const newCfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.ok(!newCfg.adminToken, `expected adminToken cleared from config; got: ${JSON.stringify(newCfg)}`);

    // The legacy plaintext token still authenticates (its SHA256 was stored).
    const r = authenticate(db, legacy);
    assert.ok(r, "migrated legacy token must still authenticate");
    assert.equal(r!.scope, "admin");
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrateLegacyAdminTokenIfPresent: idempotent when no adminToken in config", () => {
  const { db, cleanup } = tempDb();
  const dir = mkdtempSync(join(tmpdir(), "fleet-auth-cfg-"));
  const cfgPath = join(dir, "fleet-control.config.json");
  writeFileSync(cfgPath, JSON.stringify({}, null, 2));
  try {
    migrateLegacyAdminTokenIfPresent(db, cfgPath);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM auth_token").get() as any;
    assert.equal(rows.n, 0);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrateLegacyAdminTokenIfPresent: no-op when auth_token already has rows", () => {
  const { db, cleanup } = tempDb();
  const dir = mkdtempSync(join(tmpdir(), "fleet-auth-cfg-"));
  const cfgPath = join(dir, "fleet-control.config.json");
  writeFileSync(cfgPath, JSON.stringify({ adminToken: "should-not-migrate-because-tokens-exist" }, null, 2));
  try {
    mintToken(db, "existing", "admin");
    migrateLegacyAdminTokenIfPresent(db, cfgPath);
    const rows = db.prepare("SELECT name FROM auth_token").all() as any[];
    assert.equal(rows.length, 1, "must not have inserted the legacy token when other tokens exist");
    assert.equal(rows[0].name, "existing");

    // The adminToken stays in config in this case (user might re-empty the
    // table). We don't touch it.
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    assert.equal(cfg.adminToken, "should-not-migrate-because-tokens-exist");
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
