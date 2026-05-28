// Open PRs per project from gh, cached in the `pr` table with a short TTL so the
// portal never blocks on the network and gh isn't hammered.
import { execFileSync } from "node:child_process";
import type { DB } from "../db.ts";

const TTL_MS = 60_000;
const AGENT_RE = /^(feat\/|chore\/gtm-|eng\/)/;

// Module-level shell runner seam (ticket 0022). Tests swap this via
// _setPrRunnerForTests to drive `gh pr list` deterministically without
// touching the network — same pattern as src/control.ts and src/doctor.ts.
// Production keeps a thin wrapper around execFileSync so the existing
// timeout / stdio plumbing stays unchanged.
type PrRunner = (cmd: string, args: readonly string[]) => string;
const defaultRunner: PrRunner = (cmd, args) =>
  execFileSync(cmd, args as string[], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
let activeRunner: PrRunner = defaultRunner;

/** Swap the gh runner in for a test. Pair with `_resetPrRunnerForTests()`
 *  in a try/finally so a thrown assertion can't leak the stub into
 *  sibling tests. The leading underscore + "ForTests" suffix matches the
 *  repo's reset-seam convention. */
export function _setPrRunnerForTests(fn: PrRunner): void { activeRunner = fn; }
export function _resetPrRunnerForTests(): void { activeRunner = defaultRunner; }

function ciState(rollup: any[]): string {
  if (!Array.isArray(rollup) || !rollup.length) return "none";
  const states = rollup.map((c) => c.conclusion || c.status || "");
  if (states.some((s) => /FAIL|ERROR|CANCEL/i.test(s))) return "red";
  if (states.some((s) => /PENDING|QUEUED|IN_PROGRESS/i.test(s))) return "pending";
  return "green";
}

// Ticket 0027: surface the first failing check name (e.g. "typecheck")
// from the rollup so the correlation pass has a stable lookup key for
// `gh run view --log-failed`. We pick the first rollup entry whose
// conclusion matches /FAIL|ERROR|CANCEL/i — same shape as the ciState
// classifier above. Returns null when no rollup entry failed. (When
// ticket 0023 lands its own first_fail_check derivation it will
// replace this helper; for now we own the column.)
function firstFailingCheck(rollup: any[]): string | null {
  if (!Array.isArray(rollup)) return null;
  for (const c of rollup) {
    const s = String(c?.conclusion ?? c?.status ?? "");
    if (/FAIL|ERROR|CANCEL/i.test(s)) {
      // gh emits the check name under `name` (check_run) or `context`
      // (legacy status check). databaseId / workflowName are fallbacks.
      return String(c?.name ?? c?.context ?? c?.workflowName ?? "ci");
    }
  }
  return null;
}

// Ticket 0027: pull the first 200 chars of the failing check's log via
// `gh run view --log-failed`. Routed through the same `activeRunner`
// seam so tests can pin the payload deterministically. Returns null on
// any error / empty output — the column stays NULL and the correlation
// detector simply skips this PR (signature derivation requires an
// excerpt). The argv array form is mandatory per AGENTS.md.
function fetchFirstFailExcerpt(repo: string, prNumber: number): string | null {
  try {
    // `gh pr view <n> --repo <r> --json` doesn't carry log bodies, so
    // we go via `gh run view --log-failed`. We don't know the run id
    // up-front; gh accepts `--branch` to pick the latest run for a
    // specific head, but the simplest cross-version invocation is
    // `gh run list --json databaseId --branch <head>` and then a
    // follow-up `gh run view <id> --log-failed`. To keep the shell-
    // out surface minimal we call `gh pr checks` which prints one
    // line per check including the run URL; the URL's path ends in
    // /runs/<id>. From there one `gh run view <id> --log-failed`
    // returns the failing-step logs.
    //
    // We keep the implementation minimal: a single attempt against
    // `gh run view --log-failed` with the PR number; gh resolves the
    // associated workflow run automatically. The flag is supported
    // by gh >= 2.21 (released 2023-03); doctor (ticket 0016) already
    // requires a comparable gh version so no new requirement here.
    const out = activeRunner("gh", [
      "run", "view", "--log-failed", "--repo", repo,
      "--branch", `pull/${prNumber}/head`,
    ]);
    const trimmed = (out ?? "").toString().trim();
    if (!trimmed) return null;
    return trimmed.slice(0, 200);
  } catch {
    return null;
  }
}

export function ingestProjectPRs(db: DB, projectId: number, repo: string): void {
  if (!repo || repo.includes("null")) return;
  const last = db.prepare("SELECT MAX(fetched_at) f FROM pr WHERE project_id=?").get(projectId) as any;
  if (last?.f && Date.now() - new Date(last.f).getTime() < TTL_MS) return; // fresh enough

  let rows: any[] = [];
  try {
    // Ticket 0022: includes `createdAt` in the field list so the SQL
    // schema's new gh_created_at column (added in src/db.ts) gets
    // populated on every ingest pass. The extra field is additive on
    // the gh JSON shape — no callers consume the gh stdout directly.
    const out = activeRunner("gh", ["pr", "list", "--repo", repo, "--state", "open", "--limit", "40",
      "--json", "number,title,headRefName,mergeStateStatus,statusCheckRollup,additions,deletions,author,url,createdAt"]);
    rows = JSON.parse(out);
  } catch { return; } // no gh/auth/network → keep last cache

  const now = new Date().toISOString();
  db.prepare("DELETE FROM pr WHERE project_id=?").run(projectId);
  const up = db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
    + "additions,deletions,author,url,fetched_at,gh_created_at,"
    + "first_fail_check,first_fail_excerpt) "
    + "VALUES(?,?,?,?, 'open', ?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const p of rows) {
    // Ticket 0027: derive first_fail_check from the rollup we already
    // have, then (when it's non-null) pull the first 200 chars of the
    // failing log via the runner seam. Both columns stay NULL when
    // the rollup carries no failing check — the correlation pass
    // skips NULL excerpts entirely.
    const firstFail = firstFailingCheck(p.statusCheckRollup);
    const excerpt = firstFail ? fetchFirstFailExcerpt(repo, p.number) : null;
    up.run(projectId, p.number, p.title, p.headRefName, ciState(p.statusCheckRollup),
      p.mergeStateStatus ?? null, AGENT_RE.test(p.headRefName) ? 1 : 0,
      p.additions ?? 0, p.deletions ?? 0, p.author?.login ?? null, p.url ?? null, now,
      p.createdAt ?? null, firstFail, excerpt);
  }
}

export function projectPRs(db: DB, projectId: number) {
  return db.prepare("SELECT number,title,branch,ci_state,merge_state,is_agent,additions,deletions,author,url FROM pr WHERE project_id=? ORDER BY is_agent DESC, number DESC").all(projectId);
}
