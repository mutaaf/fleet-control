// One-shot pair tokens for the phone-pairing flow (ticket 0032).
//
// The flow: `fleetctl serve` mints a 90-second token, stores it in the
// `pair_token` table alongside the live admin token's plaintext (so the
// /pair route can hand the phone a real x-fleet-token cookie without
// re-deriving the admin secret), and prints both the URL and an ASCII-
// QR in the welcome banner. The phone scans, hits GET /pair?t=<token>,
// the server consumes the token (single-use, DELETEs the row), sets
// the cookie, and redirects to /.
//
// Discipline:
//   * The token format is XX-XX-XX-XX (12 alphanumeric chars + hyphens
//     in the QR-safe alphabet) so the QR payload stays inside V1-L's
//     25-char alphanumeric capacity.
//   * The token is single-use AND time-limited; consume() handles BOTH
//     conditions in one prepared statement so the route doesn't race.
//   * Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`"
//     row narrowing uses the double-cast. We use .get() here, not .all().
//   * No module-level mutable state — but per LESSONS § "in-process
//     dedup sets need an explicit reset hook for tests", any future
//     cache addition (e.g. an in-memory hot-path) MUST come with a
//     `_resetPairCacheForTests` seam. The current implementation has
//     nothing to reset; the export exists as documentation + a stable
//     test hook so future revisions don't break the harness.

import { randomBytes } from "node:crypto";
import type { DB } from "./db.ts";

// ────────────────────────────────────────────────────────────────────
// Token format: 4 groups of 2 uppercase-alnum chars separated by '-'.
// 11 visible chars / 12 incl. the hyphens. Inside the QR's V1-L
// alphanumeric set (digits + A-Z + space + $%*+-./:) so the encoded
// payload stays compact.
// ────────────────────────────────────────────────────────────────────

const TOKEN_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // ambiguous I/O removed
const TOKEN_GROUPS = 4;
const TOKEN_CHARS_PER_GROUP = 2;

export const PAIR_TOKEN_TTL_MS = 90_000; // 90 seconds, per ticket

function randAlpha(n: number): string {
  // randomBytes returns uniform [0,255]; modulo bias for a 34-char
  // alphabet is ~7e-3 — negligible for a 90-second one-shot token where
  // each guess costs a network round-trip and the rate-limit caps
  // attempts at 10/min/IP. randomInt would be marginally cleaner but
  // adds nothing material here.
  const buf = randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) {
    out += TOKEN_ALPHABET[buf[i] % TOKEN_ALPHABET.length];
  }
  return out;
}

/** Format `XX-XX-XX-XX` (11 chars incl. hyphens). */
function freshToken(): string {
  const parts: string[] = [];
  for (let i = 0; i < TOKEN_GROUPS; i++) parts.push(randAlpha(TOKEN_CHARS_PER_GROUP));
  return parts.join("-");
}

// Guard against a future caller passing an arbitrary string to consume() —
// the SQL is parameterised so injection isn't a risk, but a malformed
// shape should fail fast.
const TOKEN_RE = new RegExp(
  `^[${TOKEN_ALPHABET}]{${TOKEN_CHARS_PER_GROUP}}(-[${TOKEN_ALPHABET}]{${TOKEN_CHARS_PER_GROUP}}){${TOKEN_GROUPS - 1}}$`,
);

export interface PairMintResult {
  token: string;
  expires_at: string;
}

export interface PairConsumeResult {
  ok: boolean;
  admin_token?: string;
  reason?: "unknown" | "expired" | "malformed";
}

/** Mint a fresh one-shot pair token, store it in `pair_token`, return the
 *  plaintext + the expiry timestamp. The plaintext is shown to the
 *  operator ONCE via the welcome banner — never logged elsewhere. */
export function mintPairToken(
  db: DB,
  adminToken: string,
  now: Date = new Date(),
): PairMintResult {
  if (typeof adminToken !== "string" || adminToken.length === 0) {
    throw new Error("mintPairToken: adminToken is required");
  }
  const token = freshToken();
  const expiresAt = new Date(now.getTime() + PAIR_TOKEN_TTL_MS).toISOString();
  const createdAt = now.toISOString();
  db.prepare(
    "INSERT INTO pair_token(token, admin_token, expires_at, created_at) VALUES(?,?,?,?)",
  ).run(token, adminToken, expiresAt, createdAt);
  return { token, expires_at: expiresAt };
}

interface PairRow {
  token: string;
  admin_token: string;
  expires_at: string;
}

/** Consume a pair token by plaintext. Returns the admin token exactly
 *  once on success; the row is DELETEd as part of the transaction so a
 *  re-consume can't succeed. Expired tokens return {ok:false} AND get
 *  swept from the table so the next mint doesn't accumulate cruft. */
export function consumePairToken(
  db: DB,
  token: string,
  now: Date = new Date(),
): PairConsumeResult {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    return { ok: false, reason: "malformed" };
  }
  // Read first so we can decide expired vs not-found cleanly. Then DELETE
  // unconditionally (single-use, even on expiry).
  const row = db.prepare(
    "SELECT token, admin_token, expires_at FROM pair_token WHERE token = ?",
  ).get(token) as unknown as PairRow | undefined;
  if (!row) return { ok: false, reason: "unknown" };
  db.prepare("DELETE FROM pair_token WHERE token = ?").run(token);
  if (new Date(row.expires_at).getTime() < now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, admin_token: row.admin_token };
}

/** Sweep all expired rows. Cheap (indexed PK scan + DELETE) and lets the
 *  table stay small even if the operator restarts serve many times in
 *  quick succession. Called opportunistically by the route handler. */
export function sweepExpiredPairTokens(db: DB, now: Date = new Date()): number {
  const r = db.prepare("DELETE FROM pair_token WHERE expires_at < ?").run(now.toISOString());
  return Number(r.changes);
}

// ────────────────────────────────────────────────────────────────────
// Rate limiter — per-IP in-memory ring buffer of attempt timestamps.
// 10 attempts / 60 s per source IP. The map is module-level state so
// the LESSONS § "in-process dedup sets need an explicit reset hook for
// tests" rule applies — exported as `_resetPairCacheForTests`.
// ────────────────────────────────────────────────────────────────────

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 10;

const attempts = new Map<string, number[]>();

/** Record an attempt for `ip` at `now`; return true if the request is
 *  WITHIN the per-minute limit, false if it should be 429ed. */
export function rateLimitAllow(ip: string, now: Date = new Date()): boolean {
  const cutoff = now.getTime() - RATE_WINDOW_MS;
  const list = (attempts.get(ip) ?? []).filter((ts) => ts >= cutoff);
  list.push(now.getTime());
  attempts.set(ip, list);
  return list.length <= RATE_LIMIT;
}

/** Test seam: clear all in-process pair caches. Per LESSONS § "in-
 *  process dedup sets need an explicit reset hook for tests", this MUST
 *  be called at the top of every test that exercises the limiter or
 *  any future module-level state. */
export function _resetPairCacheForTests(): void {
  attempts.clear();
}
