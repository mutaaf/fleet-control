// Disk usage + stale-checkout janitor (ticket 0006).
//
// Per AGENTS.md § Hard NOs: zero new runtime deps; never `rm -rf` outside
// `~/.cache/<slug>-agent*`. We use only `node:fs/promises` here (recursive
// stat for sizing, `rm({recursive:true, force:true})` for deletion) — no
// shell-out, so there's no argv injection surface at all.
//
// Layout assumptions (mirrors how the agent kit lays down caches):
//   ~/.cache/<slug>-agent/                 -- protected: runs.jsonl,
//                                             events.jsonl, logs/...
//   ~/.cache/<slug>-agent-<phase>-checkout -- ephemeral working trees that
//                                             agents clone into per run; these
//                                             are what we may delete.
//
// `diskUsage(slug)` reports the totals across everything matching
//   ~/.cache/<slug>-agent*
// but the `candidates` list only contains the *-checkout dirs (i.e. things
// that look like agent working trees we are allowed to delete). The protected
// `<slug>-agent/` directory itself is INCLUDED in `bytes` (so the operator
// sees the real number) but never appears as a candidate.
import { readdir, stat, rm } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Per-candidate row in the disk-view payload. */
export interface DiskCandidate {
  path: string;
  age_days: number;
  bytes: number;
}

/** Shape returned by `/api/projects/:slug/disk`. */
export interface DiskUsageReport {
  bytes: number;
  checkout_count: number;
  oldest_age_days: number;
  candidates: DiskCandidate[];
}

/** Result of a janitor pass — list of paths that were `rm -rf`'d. */
export interface CleanReport {
  removed: string[];
}

/** Strict slug regex shared with src/control.ts. Anything that doesn't match
 *  must never reach the filesystem layer. */
const SLUG_RE = /^[\w-]{1,40}$/;

/** Day in ms — used everywhere age_days is computed. */
const DAY_MS = 86_400_000;

/** Build the strict path prefix the cleaner refuses to step outside of.
 *  Reads $HOME dynamically (not at module load) so tests can override it. */
function safePrefix(slug: string): string {
  return join(homedir(), ".cache", `${slug}-agent`);
}

/** Build the path regex that gates `rm()` — a candidate must:
 *   - sit directly under $HOME/.cache/
 *   - have a name that starts with `<slug>-agent` (with optional suffix)
 *  This is the final safety check inside cleanCheckouts(); diskUsage()'s
 *  enumeration also goes through it so a malformed name never even reads. */
function safePathCheck(slug: string, path: string): boolean {
  if (!SLUG_RE.test(slug)) return false;
  const prefix = safePrefix(slug);
  // Match either the protected dir itself (`<prefix>`) or any sibling that
  // starts with `<prefix>-...` (the checkout dirs). Forbid `..` etc.
  if (path !== prefix && !path.startsWith(`${prefix}-`)) return false;
  if (path.includes("..")) return false;
  return true;
}

/** True when a directory's basename looks like an ephemeral agent checkout
 *  (i.e. ends with `-checkout`). We only delete these; never the protected
 *  `<slug>-agent/` tree. */
function isCheckoutDir(name: string): boolean {
  return name.endsWith("-checkout");
}

/** Sum every regular-file size under `dir`. Pure node:fs/promises (no du
 *  shell-out → no argv concern). Symlinks are not followed; broken entries
 *  are silently skipped so a torn-down checkout in mid-delete can't crash
 *  the disk view. */
async function dirSize(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch { return 0; }
  for (const e of entries) {
    const full = join(dir, e.name);
    try {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { total += await dirSize(full); continue; }
      if (e.isFile()) {
        const s = await stat(full);
        total += s.size;
      }
    } catch { /* entry vanished mid-walk; ignore */ }
  }
  return total;
}

/** Find every direct child of ~/.cache whose name starts with `<slug>-agent`.
 *  Returns absolute paths. Empty array if the cache dir doesn't exist or the
 *  slug is malformed. */
async function findSlugDirs(slug: string): Promise<string[]> {
  if (!SLUG_RE.test(slug)) return [];
  const cache = join(homedir(), ".cache");
  let entries: Dirent[];
  try {
    entries = (await readdir(cache, { withFileTypes: true })) as Dirent[];
  } catch { return []; }
  const want = `${slug}-agent`;
  const out: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name !== want && !e.name.startsWith(`${want}-`)) continue;
    const full = join(cache, e.name);
    if (!safePathCheck(slug, full)) continue;
    out.push(full);
  }
  return out;
}

/** diskUsage(slug) — public API for `/api/projects/:slug/disk`.
 *
 *  Walks every directory under ~/.cache that matches `<slug>-agent*` and
 *  returns the byte total plus a `candidates` list of the *-checkout dirs
 *  (i.e. the things `cleanCheckouts` would consider deleting). The
 *  protected `<slug>-agent/` dir's bytes are counted in `bytes` so the
 *  operator sees an accurate "this project's disk footprint" number, but it
 *  is NEVER listed as a candidate (cleanCheckouts refuses to touch it). */
export async function diskUsage(slug: string): Promise<DiskUsageReport> {
  const dirs = await findSlugDirs(slug);
  const now = Date.now();
  let bytes = 0;
  let oldestAgeDays = 0;
  let checkouts = 0;
  const candidates: DiskCandidate[] = [];
  for (const dir of dirs) {
    const size = await dirSize(dir);
    bytes += size;
    let mtimeMs = now;
    try { mtimeMs = (await stat(dir)).mtimeMs; } catch { /* gone */ }
    const ageDays = Math.max(0, (now - mtimeMs) / DAY_MS);
    if (ageDays > oldestAgeDays) oldestAgeDays = ageDays;
    const name = dir.split("/").pop() ?? "";
    if (isCheckoutDir(name)) {
      checkouts += 1;
      candidates.push({ path: dir, age_days: round1(ageDays), bytes: size });
    }
  }
  // Sort oldest-first so the SPA can render the most-cleanable items at top.
  candidates.sort((a, b) => b.age_days - a.age_days);
  return {
    bytes,
    checkout_count: checkouts,
    oldest_age_days: round1(oldestAgeDays),
    candidates,
  };
}

/** Round to 1 decimal place — keeps the JSON payload tidy and the SPA's
 *  "X.Y days" string from showing 17-significant-digit noise. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** safeRmUnder(prefix, target) — generic path-prefix-guarded `rm -rf`.
 *
 *  Used by the `register-url` action (ticket 0010) to clean up a partial
 *  `<projectRoots[0]>/<slug>` directory when the clone-then-register flow
 *  trips mid-way. Same defensive shape as the per-slug cleaner above:
 *   - both paths must be absolute;
 *   - `target` must sit strictly *under* `prefix` (i.e. `target.startsWith(
 *     prefix + path.sep)`); identical paths are refused so a typo'd
 *     `prefix === target` can't wipe the whole projects root;
 *   - neither path may contain `..` (defence-in-depth against a body that
 *     somehow smuggled a traversal segment through earlier validation);
 *   - uses `node:fs/promises rm({recursive,force})` — no shell-out.
 *
 *  Returns true when an `rm` was attempted (whether or not it found
 *  anything to remove), false when the safety check refused the path. */
export async function safeRmUnder(prefix: string, target: string): Promise<boolean> {
  if (typeof prefix !== "string" || typeof target !== "string") return false;
  if (!prefix.startsWith("/") || !target.startsWith("/")) return false;
  if (prefix.includes("..") || target.includes("..")) return false;
  // The trailing separator is load-bearing: it stops `/a/projects` from
  // matching `/a/projects-evil` as a prefix.
  const sep = prefix.endsWith("/") ? "" : "/";
  if (!target.startsWith(prefix + sep)) return false;
  if (target === prefix) return false; // never wipe the root itself
  await rm(target, { recursive: true, force: true });
  return true;
}

/** cleanCheckouts(slug, olderThanDays) — janitor pass.
 *
 *  Removes every `*-checkout` directory under ~/.cache/<slug>-agent* whose
 *  mtime is at least `olderThanDays` old. Never touches the protected
 *  `<slug>-agent/` directory (runs.jsonl, events.jsonl, logs/), never
 *  touches non-checkout siblings, and refuses any path that doesn't pass
 *  `safePathCheck()`. Uses `node:fs/promises rm({recursive,force})` — no
 *  shell-out, no argv injection surface.
 *
 *  Returns the list of paths actually removed. Bad slug → empty result. */
export async function cleanCheckouts(slug: string, olderThanDays: number): Promise<CleanReport> {
  if (!SLUG_RE.test(slug)) return { removed: [] };
  const threshold = Math.max(0, Number.isFinite(olderThanDays) ? olderThanDays : 14);
  const dirs = await findSlugDirs(slug);
  const now = Date.now();
  const removed: string[] = [];
  for (const dir of dirs) {
    const name = dir.split("/").pop() ?? "";
    if (!isCheckoutDir(name)) continue; // never touch <slug>-agent/ itself
    if (!safePathCheck(slug, dir)) continue; // double-belt safety
    let mtimeMs = now;
    try { mtimeMs = (await stat(dir)).mtimeMs; } catch { continue; }
    const ageDays = (now - mtimeMs) / DAY_MS;
    if (ageDays < threshold) continue;
    // Final guard: refuse to operate on a path outside $HOME/.cache/<slug>-agent.
    const prefix = safePrefix(slug);
    if (!dir.startsWith(`${prefix}-`)) continue;
    try {
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch { /* best-effort; another agent might have it open */ }
  }
  return { removed };
}
