// Open PRs per project from gh, cached in the `pr` table with a short TTL so the
// portal never blocks on the network and gh isn't hammered.
import { execFileSync } from "node:child_process";
import type { DB } from "../db.ts";

const TTL_MS = 60_000;
const AGENT_RE = /^(feat\/|chore\/gtm-|eng\/)/;

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
    const out = execFileSync("gh", ["pr", "list", "--repo", repo, "--state", "open", "--limit", "40",
      "--json", "number,title,headRefName,mergeStateStatus,statusCheckRollup,additions,deletions,author,url"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 });
    rows = JSON.parse(out);
  } catch { return; } // no gh/auth/network → keep last cache

  const now = new Date().toISOString();
  db.prepare("DELETE FROM pr WHERE project_id=?").run(projectId);
  const up = db.prepare(`INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,additions,deletions,author,url,fetched_at)
    VALUES(?,?,?,?, 'open', ?,?,?,?,?,?,?,?)`);
  for (const p of rows)
    up.run(projectId, p.number, p.title, p.headRefName, ciState(p.statusCheckRollup),
      p.mergeStateStatus ?? null, AGENT_RE.test(p.headRefName) ? 1 : 0,
      p.additions ?? 0, p.deletions ?? 0, p.author?.login ?? null, p.url ?? null, now);
}

export function projectPRs(db: DB, projectId: number) {
  return db.prepare("SELECT number,title,branch,ci_state,merge_state,is_agent,additions,deletions,author,url FROM pr WHERE project_id=? ORDER BY is_agent DESC, number DESC").all(projectId);
}
