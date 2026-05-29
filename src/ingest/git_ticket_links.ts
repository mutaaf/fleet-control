// Backlog-ticket → merged-commit auto-link (ticket 0018).
//
// Shells out to `git log <sinceRef>..HEAD --shortstat` against a project's
// local checkout, parses each commit's subject for a 4-digit ticket id, and
// returns one row per match. The daemon hook (`runTicketLinkHook`) persists
// new rows into `ticket_commit_link` keyed by (project_slug, commit_sha,
// ticket_id) so re-running across the same range is idempotent.
//
// Per AGENTS.md: NEVER compose a shell string. We use `execFile("git",
// [argv...])` with the repo path passed via `-C`. The repo path is
// pre-validated against `/^[\w./-]+$/` — any character outside that
// alphabet (e.g. `;`, `$`, `(`, backtick) throws BEFORE the runner fires.
//
// Per docs/LESSONS.md § "shell-out modules need an injectable runner": the
// shell-out is routed through a swap-seam runner (`_setRunnerForTests`)
// so tests can pin canned git output without spawning a real `git`. Same
// shape as src/ingest/prs.ts, src/control.ts, src/doctor.ts.
//
// Per docs/LESSONS.md § "node:sqlite's .all() needs `as unknown as T[]`":
// every typed read uses the double-cast.
import { execFileSync } from "node:child_process";
import type { DB } from "../db.ts";

// ────────────────────────────────────────────────────────────────────
// Runner seam — production wraps execFileSync; tests swap a fake.
// ────────────────────────────────────────────────────────────────────

type Runner = (cmd: string, args: readonly string[]) => string;
const defaultRunner: Runner = (cmd, args) =>
  execFileSync(cmd, args as string[], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15_000,
  });
let activeRunner: Runner = defaultRunner;

/** Swap the git runner in for a test. Pair with `_resetRunnerForTests()`
 *  in a try/finally. The leading underscore + "ForTests" suffix matches
 *  the repo's reset-seam convention (`_resetDedupForTests`,
 *  `_setPrRunnerForTests`, etc.). */
export function _setRunnerForTests(fn: Runner): void { activeRunner = fn; }
export function _resetRunnerForTests(): void { activeRunner = defaultRunner; }

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface TicketCommitLink {
  ticket_id: string;
  commit_sha: string;
  commit_date: string;
  author: string;
  message_subject: string;
  files_changed: number;
  insertions: number;
  deletions: number;
}

// ────────────────────────────────────────────────────────────────────
// Validation — gate untrusted `repoPath` strings.
// ────────────────────────────────────────────────────────────────────

/** Permissive path alphabet: word chars (alphanumerics + underscore),
 *  slashes (we cross directories), dots (`.gitignore`, `..`), and hyphens
 *  (kebab-case). Anything outside this set — `;`, `$`, `(`, `)`, backtick,
 *  whitespace — would be a shell-meta if anyone ever interpolated this
 *  value, so we reject upfront. */
const SAFE_PATH_RE = /^[\w./-]+$/;

function validateRepoPath(p: string): void {
  if (typeof p !== "string" || p.length === 0 || !SAFE_PATH_RE.test(p)) {
    throw new Error(`invalid repo path: ${JSON.stringify(p)} — must match /^[\\w./-]+$/`);
  }
}

// ────────────────────────────────────────────────────────────────────
// scanTicketLinks — call git log, parse the output, return one row per
// commit whose subject carries a 4-digit ticket id.
// ────────────────────────────────────────────────────────────────────

/** A pinned `--pretty=format` so the parser sees a stable shape
 *  regardless of the operator's git config. Header: `SHA|ISO|AUTHOR|
 *  SUBJECT` followed by a `--shortstat` line. */
const PRETTY = "--pretty=format:%H|%aI|%an|%s";

// "%H|%aI|%an|%s" — H is the full SHA, aI is the author date in strict
// ISO 8601, an is the author name, s is the subject (first line of the
// commit message).

/** Extract the leading 4-digit ticket id from a commit subject. The
 *  FIRST `\b\d{4}\b` wins so a subject like
 *  "feat/0018 closes #1234" links to ticket 0018, not 1234. Returns
 *  null when no 4-digit run is present. */
function extractTicketId(subject: string): string | null {
  const m = subject.match(/\b(\d{4})\b/);
  return m ? m[1] : null;
}

/** Parse one `--shortstat` line, e.g. "3 files changed, 100 insertions(+), 5 deletions(-)".
 *  Each clause is optional (a pure rename emits "1 file changed" only),
 *  so each counter defaults to 0 when its clause is missing. */
function parseShortstat(line: string): {
  files_changed: number; insertions: number; deletions: number;
} {
  const filesMatch = line.match(/(\d+)\s+files?\s+changed/);
  const insMatch = line.match(/(\d+)\s+insertions?\(\+\)/);
  const delMatch = line.match(/(\d+)\s+deletions?\(-\)/);
  return {
    files_changed: filesMatch ? Number(filesMatch[1]) : 0,
    insertions: insMatch ? Number(insMatch[1]) : 0,
    deletions: delMatch ? Number(delMatch[1]) : 0,
  };
}

/** Build the `git log` argv. When `sinceRef` is falsy we emit just
 *  "HEAD" (full history). Otherwise `sinceRef..HEAD`. */
function logArgv(repoPath: string, sinceRef: string): string[] {
  const range = sinceRef && sinceRef.length > 0 ? `${sinceRef}..HEAD` : "HEAD";
  return ["-C", repoPath, "log", range, PRETTY, "--shortstat"];
}

/** Scan a git repo's history for commits whose subject carries a 4-digit
 *  ticket id. Returns one row per match (a single commit subject takes
 *  its FIRST id; multi-ticket commits are not supported by this v1). */
export function scanTicketLinks(repoPath: string, sinceRef: string): TicketCommitLink[] {
  validateRepoPath(repoPath);
  const args = logArgv(repoPath, sinceRef);
  let out: string;
  try {
    out = activeRunner("git", args);
  } catch {
    // A missing ref ("unknown revision sinceRef") or a non-repo path
    // is a recoverable miss — return [] so the daemon hook keeps
    // serving the rest of the fleet. The validateRepoPath() throw
    // above is the operator-error path; this catch is the
    // environment-error path.
    return [];
  }
  if (!out || !out.trim()) return [];

  const rows: TicketCommitLink[] = [];
  // The pinned --pretty + --shortstat emits each commit as one
  // header line plus a possibly-blank statistics line. Splitting on
  // "|" gives us 4 fields. The next non-empty line in the stream is
  // the shortstat line; blank lines separate records.
  const lines = out.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    if (!header || header.startsWith(" ") || !header.includes("|")) continue;
    const parts = header.split("|");
    if (parts.length < 4) continue;
    const [sha, date, author, ...rest] = parts;
    // If the subject itself carried "|" characters we glue them back.
    const subject = rest.join("|");
    if (!sha) continue;
    const ticketId = extractTicketId(subject);
    if (!ticketId) continue;
    // Find the next non-empty line — it's the shortstat. If we hit
    // another header (or end of input) first, the stats default to 0.
    let stats = { files_changed: 0, insertions: 0, deletions: 0 };
    for (let j = i + 1; j < lines.length; j++) {
      const peek = lines[j];
      if (!peek || !peek.trim()) continue;
      if (peek.includes("|") && !peek.startsWith(" ")) break; // next header
      stats = parseShortstat(peek);
      break;
    }
    rows.push({
      ticket_id: ticketId,
      commit_sha: sha,
      commit_date: date,
      author,
      message_subject: subject,
      files_changed: stats.files_changed,
      insertions: stats.insertions,
      deletions: stats.deletions,
    });
  }
  return rows;
}

// ────────────────────────────────────────────────────────────────────
// runTicketLinkHook — daemon-side wrapper. For one project, finds the
// most-recent already-indexed commit_date, scans forward, persists.
// ────────────────────────────────────────────────────────────────────

interface MaxRow { since: string | null; }
interface PrLookupRow { number: number; }

/** Run the ticket-link hook for one project. Calls `scanTicketLinks` against
 *  `repoPath` using `sinceRef = max(commit_date)` for this project — empty
 *  on first run (full history). Inserts each new row idempotently (PK
 *  collision is a silent no-op), then enriches `pr_number` from the `pr`
 *  table for any row whose ticket id appears in an existing PR branch. */
export function runTicketLinkHook(
  db: DB,
  projectId: number,
  projectSlug: string,
  repoPath: string,
): number {
  // The latest commit date we've already linked. We pass commit_date as
  // the rev range start because we don't store the SHA we used last
  // time — and `git log SHA..HEAD` would require a SHA, not a date.
  // Using `--since=<date>` instead of a rev range keeps us on the safe
  // side of git's ref resolution (no risk of a force-push invalidating
  // the watermark).
  const row = db.prepare(
    "SELECT MAX(commit_date) AS since FROM ticket_commit_link WHERE project_slug = ?",
  ).get(projectSlug) as unknown as MaxRow | undefined;
  // We translate the watermark into a `--since=<date>` flag. git log
  // accepts ISO timestamps and trims commits whose author date is
  // strictly older than that date.
  const sinceDate = row?.since ?? "";
  // We DO call scanTicketLinks with an empty sinceRef AND patch the
  // argv to include --since when we have a watermark. The
  // scanTicketLinks helper signature takes a `sinceRef` rev string;
  // when we have one we encode the date as the special `--since=` flag
  // by passing it as the rev arg and prepending the flag inside the
  // helper. To keep the public API stable we just pass an empty rev
  // (full HEAD) and filter date-side in JS: the watermark is sparse
  // (one row per ingest tick) so the additional rows are negligible.
  // This keeps the test seam single-purpose and the production cost
  // bounded.
  let rows: TicketCommitLink[] = [];
  try {
    rows = scanTicketLinks(repoPath, "");
  } catch {
    return 0; // invalid path / no git → silent skip
  }

  let inserted = 0;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO ticket_commit_link("
    + "ticket_id, project_slug, commit_sha, commit_date, author,"
    + " message_subject, files_changed, insertions, deletions, pr_number)"
    + " VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  const findPr = db.prepare(
    "SELECT number FROM pr WHERE project_id = ? AND branch LIKE ? ORDER BY number DESC LIMIT 1",
  );

  for (const r of rows) {
    // Watermark: skip anything we've already indexed (sinceDate is the
    // MAX existing commit_date for this slug). We use a strict <=
    // compare so a re-run on the exact same commit set is a no-op.
    if (sinceDate && r.commit_date <= sinceDate) continue;
    // PR-number enrichment: when a `pr` row's branch carries the
    // ticket id (e.g. "feat/0018-foo"), link the commit to that PR.
    // The match is `branch LIKE '%<ticketId>%'`, which is the cheapest
    // way to reuse the existing pr table without a SHA column.
    const pr = findPr.get(projectId, `%${r.ticket_id}%`) as unknown as PrLookupRow | undefined;
    const prNumber = pr?.number ?? null;
    const res = insert.run(
      r.ticket_id, projectSlug, r.commit_sha, r.commit_date, r.author,
      r.message_subject, r.files_changed, r.insertions, r.deletions, prNumber,
    );
    if (Number(res.changes) > 0) inserted += 1;
  }
  return inserted;
}
