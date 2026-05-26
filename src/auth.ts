// Per-user scoped tokens (ticket 0003). Replaces the legacy single-shared
// admin token in fleet-control.config.json. Plaintext tokens are never
// stored — we SHA256 them on mint and look up by hash on every request.
// Scopes are hierarchical: admin > control > read.
//
// CLI surface (bin/fleetctl.ts):
//   fleetctl tokens add <name> --scope <read|control|admin>   # prints token ONCE
//   fleetctl tokens list                                      # id-prefix, name, scope, ...
//   fleetctl tokens revoke <id-prefix>                        # by 8-char prefix
//
// Server surface (src/server.ts):
//   requireAuth(req, required) — loopback bypasses; remote must send the
//     x-fleet-token header (or ?token= for SSE). The middleware updates
//     last_used_at and returns the matched record's scope so callers can
//     decide read vs. control vs. admin.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { DB } from "./db.ts";

export type Scope = "read" | "control" | "admin";
const SCOPES: readonly Scope[] = ["read", "control", "admin"];
// Hierarchical: holder of admin can do control & read; holder of control can
// also do read. Strictly numeric so route handlers stay a one-liner.
const RANK: Record<Scope, number> = { read: 1, control: 2, admin: 3 };

export interface TokenRecord {
  id_prefix: string;
  name: string;
  scope: Scope;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface MintedToken {
  id_prefix: string;
  token: string; // shown to the operator exactly once
  name: string;
  scope: Scope;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function validName(name: string): void {
  if (typeof name !== "string" || !name.trim()) throw new Error("token name is required");
  if (name.length > 64) throw new Error("token name must be ≤64 chars");
}
function validScope(scope: string): asserts scope is Scope {
  if (!SCOPES.includes(scope as Scope)) {
    throw new Error(`bad scope '${scope}' — must be one of ${SCOPES.join(", ")}`);
  }
}

/** Generate a fresh token, hash it, persist the hash + metadata. The plaintext
 *  is returned ONCE — the caller is responsible for showing it to the operator
 *  immediately; we never write it to disk and never log it. */
export function mintToken(db: DB, name: string, scope: Scope): MintedToken {
  validName(name);
  validScope(scope);
  // 32 bytes of entropy → 43 base64url chars. Strong enough for an admin
  // token; short enough to paste once into a phone.
  const token = randomBytes(32).toString("base64url");
  const id = hash(token);
  db.prepare(
    "INSERT INTO auth_token(id, name, scope, created_at, last_used_at, revoked_at) VALUES(?,?,?,?,?,?)",
  ).run(id, name, scope, new Date().toISOString(), null, null);
  return { id_prefix: id.slice(0, 8), token, name, scope };
}

/** Listing intentionally omits the full SHA256 — only the first 8 chars are
 *  ever shown, since that's what the operator types into `tokens revoke`. */
export function listTokens(db: DB): TokenRecord[] {
  const rows = db.prepare(
    "SELECT id, name, scope, created_at, last_used_at, revoked_at FROM auth_token ORDER BY revoked_at IS NULL DESC, created_at DESC",
  ).all() as Array<{ id: string; name: string; scope: Scope; created_at: string | null; last_used_at: string | null; revoked_at: string | null }>;
  return rows.map((r) => ({
    id_prefix: r.id.slice(0, 8),
    name: r.name,
    scope: r.scope,
    created_at: r.created_at,
    last_used_at: r.last_used_at,
    revoked_at: r.revoked_at,
  }));
}

/** Mark the token whose id starts with `prefix` as revoked. Returns true if a
 *  row was updated, false if no matching live token exists. */
export function revokeToken(db: DB, prefix: string): boolean {
  if (typeof prefix !== "string" || prefix.length < 4) {
    throw new Error("id-prefix must be at least 4 chars (use the value shown by `tokens list`)");
  }
  // Only revoke live tokens; "revoking" an already-revoked one is a no-op.
  const r = db.prepare(
    "UPDATE auth_token SET revoked_at=? WHERE id LIKE ? AND revoked_at IS NULL",
  ).run(new Date().toISOString(), prefix + "%");
  return Number(r.changes) > 0;
}

/** Look up a presented token; null if unknown OR revoked. Updates
 *  last_used_at on success. The lookup is by SHA256, so a constant-time
 *  comparison isn't required — an attacker only sees a binary yes/no over
 *  the wire and there's no plaintext on disk to brute-force. */
export function authenticate(db: DB, token: string): TokenRecord | null {
  if (!token || typeof token !== "string") return null;
  const id = hash(token);
  const row = db.prepare(
    "SELECT id, name, scope, created_at, last_used_at, revoked_at FROM auth_token WHERE id=?",
  ).get(id) as { id: string; name: string; scope: Scope; created_at: string | null; last_used_at: string | null; revoked_at: string | null } | undefined;
  if (!row) return null;
  if (row.revoked_at) return null;
  const now = new Date().toISOString();
  db.prepare("UPDATE auth_token SET last_used_at=? WHERE id=?").run(now, id);
  return {
    id_prefix: row.id.slice(0, 8),
    name: row.name,
    scope: row.scope,
    created_at: row.created_at,
    last_used_at: now,
    revoked_at: null,
  };
}

/** Does a token with `holder` scope satisfy a route that requires `required`?
 *  Hierarchical: admin satisfies control which satisfies read. */
export function scopeAllows(holder: Scope, required: Scope): boolean {
  return RANK[holder] >= RANK[required];
}

/** One-shot migration: if fleet-control.config.json carries a legacy
 *  `adminToken` AND the auth_token table is empty, install that token as the
 *  initial admin-scoped row and clear the config field. Idempotent: a second
 *  call after migration is a no-op. */
export function migrateLegacyAdminTokenIfPresent(db: DB, configPath: string): void {
  if (!existsSync(configPath)) return;
  let cfg: any;
  try { cfg = JSON.parse(readFileSync(configPath, "utf8")); } catch { return; }
  if (!cfg || typeof cfg.adminToken !== "string" || !cfg.adminToken) return;

  const existing = db.prepare("SELECT COUNT(*) AS n FROM auth_token").get() as { n: number };
  if (Number(existing.n) > 0) return; // someone already minted tokens — leave config alone

  const legacy: string = cfg.adminToken;
  const id = hash(legacy);
  db.prepare(
    "INSERT OR IGNORE INTO auth_token(id, name, scope, created_at, last_used_at, revoked_at) VALUES(?,?,?,?,?,?)",
  ).run(id, "admin (legacy)", "admin", new Date().toISOString(), null, null);
  // Clear the now-migrated field so a second migration pass doesn't re-add
  // the legacy row after a user has revoked it.
  delete cfg.adminToken;
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}
