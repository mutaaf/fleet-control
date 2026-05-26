// PR diff fetcher (ticket 0007): shells out to `gh pr diff` and caches the
// raw text per (repo, number) for 30 seconds. The fetcher is dependency-
// injected so tests can stub gh entirely — the default uses execFile with an
// argv array (never a shell string → no injection surface).
//
// The 200 KB cap exists so the portal can render the diff inline on a phone
// without OOMing the browser; truncated bodies tail off with a marker line
// that the SPA renders as a link to GitHub.
import { execFile } from "node:child_process";

/** 30-second TTL per (repo,number) — long enough to coalesce a few rapid
 *  re-renders, short enough that pushing a fixup + re-opening the row shows
 *  the new diff almost immediately. */
export const DIFF_CACHE_TTL_MS = 30_000;

/** 200 KB cap on the body returned to the client. Anything past this is
 *  dropped and the truncation marker is appended. The cap is in BYTES of the
 *  output string (UTF-8 char count is a close-enough proxy for the diffs we
 *  see — single-byte ASCII dominates). */
export const MAX_DIFF_BYTES = 200 * 1024;

/** Sentinel appended to a truncated body. The SPA detects it and shows the
 *  "open in GitHub" link instead of trying to render more. */
export const TRUNCATION_MARKER = "\n… [truncated — open in GitHub] …\n";

/** owner/name — GitHub repo slugs allow alphanumerics, dash, underscore, dot
 *  in BOTH segments. Exactly one slash, no `..`, no shell metas. */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** PR number is all digits, length-bounded so a 100KB string of 9s can't DoS. */
const NUM_RE = /^[0-9]{1,9}$/;

export interface DiffResult {
  ok: boolean;
  status: number; // HTTP status the route should write
  body: string; // diff text on success, error message on failure (still text/plain)
  truncated: boolean;
  message?: string; // present when ok=false; human-readable
}

export interface ValidateResult {
  ok: boolean;
  message: string;
}

export function validatePrParams(repo: string, number: string): ValidateResult {
  if (!REPO_RE.test(repo) || repo.includes("..")) {
    return { ok: false, message: "bad repo (owner/name expected)" };
  }
  if (!NUM_RE.test(number)) {
    return { ok: false, message: "bad pr number" };
  }
  return { ok: true, message: "" };
}

/** Default fetcher: shells out to `gh pr diff <number> --repo <owner/name>`.
 *  Uses execFile + an argv array — NEVER a shell string composed from input.
 *  Inputs reach this function only after validatePrParams() — but the argv
 *  shape means even hostile values stay as a single arg to gh, never the
 *  shell. 15s timeout; long diffs that take longer than that are surfaced as
 *  errors (the cap is on body size, not time). */
export function defaultGhFetcher(repo: string, number: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh", ["pr", "diff", number, "--repo", repo],
      { encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr && String(stderr).trim()) || (err.message || "gh failed");
          reject(new Error(msg));
          return;
        }
        resolve(String(stdout ?? ""));
      },
    );
  });
}

interface CacheEntry { body: string; truncated: boolean; expiresAt: number; }
const cache = new Map<string, CacheEntry>();

/** Test-only: wipe the in-memory cache so each test starts clean. */
export function _resetDiffCache(): void {
  cache.clear();
}

function truncate(body: string): { body: string; truncated: boolean } {
  if (body.length <= MAX_DIFF_BYTES) return { body, truncated: false };
  // Cut to MAX_DIFF_BYTES, then back up to the previous newline so the
  // marker lands on its own line (the SPA renders one <div> per line).
  let cut = body.slice(0, MAX_DIFF_BYTES);
  const nl = cut.lastIndexOf("\n");
  if (nl > MAX_DIFF_BYTES - 4096 && nl > 0) cut = cut.slice(0, nl);
  return { body: cut + TRUNCATION_MARKER, truncated: true };
}

/** Fetch a PR diff with caching + size capping. The fetcher is injected so
 *  tests can supply a deterministic stub; production callers omit it and get
 *  the default `gh pr diff` shell-out. Failures are surfaced as ok:false
 *  with a 502-style status; they are NEVER cached so a transient network
 *  blip doesn't pin a bad result for 30 seconds. */
export async function fetchPrDiff(
  repo: string,
  number: string,
  fetcher: (repo: string, number: string) => Promise<string> = defaultGhFetcher,
): Promise<DiffResult> {
  const v = validatePrParams(repo, number);
  if (!v.ok) return { ok: false, status: 400, body: v.message, truncated: false, message: v.message };

  const key = `${repo}#${number}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) {
    return { ok: true, status: 200, body: hit.body, truncated: hit.truncated };
  }

  let raw: string;
  try {
    raw = await fetcher(repo, number);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    return { ok: false, status: 502, body: msg, truncated: false, message: msg };
  }

  const { body, truncated } = truncate(raw);
  cache.set(key, { body, truncated, expiresAt: now + DIFF_CACHE_TTL_MS });
  return { ok: true, status: 200, body, truncated };
}
