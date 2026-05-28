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
  const up = db.prepare(`INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,additions,deletions,author,url,fetched_at,gh_created_at)
    VALUES(?,?,?,?, 'open', ?,?,?,?,?,?,?,?,?)`);
  for (const p of rows)
    up.run(projectId, p.number, p.title, p.headRefName, ciState(p.statusCheckRollup),
      p.mergeStateStatus ?? null, AGENT_RE.test(p.headRefName) ? 1 : 0,
      p.additions ?? 0, p.deletions ?? 0, p.author?.login ?? null, p.url ?? null, now,
      p.createdAt ?? null);
}

export function projectPRs(db: DB, projectId: number) {
  return db.prepare("SELECT number,title,branch,ci_state,merge_state,is_agent,additions,deletions,author,url FROM pr WHERE project_id=? ORDER BY is_agent DESC, number DESC").all(projectId);
}
