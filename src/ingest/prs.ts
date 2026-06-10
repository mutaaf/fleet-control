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

// Ticket 0023: surface the FIRST failing check (sorted by startedAt
// ascending) so the operator's PR-card "first failed: <name>" link
// always points at the root-cause check, not whichever entry happened
// to land first in gh's array. Sort is stable: entries without a
// startedAt keep their original array position relative to one
// another, which preserves the legacy-context fallback shape ticket
// 0027 relied on. Exported for direct unit-test coverage per the
// ticket's "small parsing helpers; both should be exported" note.
//
// Returns null when no rollup entry failed.
export function pickFirstFailingCheckName(rollup: unknown): string | null {
  if (!Array.isArray(rollup)) return null;
  if (rollup.length === 0) return null;
  // Decorate-sort-undecorate: capture each entry's original index so
  // entries without a startedAt sort stably by their array position.
  const decorated = rollup.map((c, i) => ({ c, i }));
  decorated.sort((a, b) => {
    const ta = String((a.c as any)?.startedAt ?? "");
    const tb = String((b.c as any)?.startedAt ?? "");
    // When either side is missing a timestamp the comparison falls
    // back to the original index — so a payload with NO startedAt
    // anywhere just yields array order.
    if (!ta && !tb) return a.i - b.i;
    if (!ta) return 1;
    if (!tb) return -1;
    if (ta === tb) return a.i - b.i;
    return ta < tb ? -1 : 1;
  });
  for (const { c } of decorated) {
    const s = String((c as any)?.conclusion ?? (c as any)?.status ?? "");
    if (/FAIL|ERROR|CANCEL/i.test(s)) {
      // gh emits the check name under `name` (check_run) or `context`
      // (legacy status check). databaseId / workflowName are fallbacks.
      return String((c as any)?.name ?? (c as any)?.context
        ?? (c as any)?.workflowName ?? "ci");
    }
  }
  return null;
}

// Ticket 0023: count `heal:`-prefixed commits on the PR. The agent
// loop's AGENTS.md-mandated convention is that every heal commit's
// first-line headline starts with `heal:` at column zero
// (case-insensitive). Anything else — a trailing mention, a scoped
// `feat(heal):`, a leading-whitespace `  heal:` — is NOT a heal
// commit and must not inflate the count. Exported for direct unit
// coverage; the ingest pass calls it once per PR row.
//
// Inputs accept either gh's `messageHeadline` shape OR a plain string
// (we tolerate `{messageHeadline}` objects per the gh `--json commits`
// schema and fall back to a string read for ergonomic test callers).
export function countHealCommits(commits: unknown): number {
  if (!Array.isArray(commits)) return 0;
  let n = 0;
  for (const raw of commits) {
    const headline = typeof raw === "string"
      ? raw
      : String((raw as any)?.messageHeadline ?? "");
    // First line only: gh splits headline from body, but a string
    // caller might pass the joined message — only the first
    // newline-delimited line counts.
    const firstLine = headline.split("\n", 1)[0] ?? "";
    if (/^heal:/i.test(firstLine)) n += 1;
  }
  return n;
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

  // Ticket 0049: fetch BOTH open and closed PRs so the 0047 autopsy
  // card lights up against real fleet data. gh's `--state closed`
  // returns both closed-non-merged AND merged PRs in the same call
  // (the `state` field on each row carries the verbatim 'CLOSED' or
  // 'MERGED' token we want to persist). Producer convention (per
  // LESSONS 2026-06-05 "groomer prose can disagree with the schema;
  // the schema wins"): open rows still write the hardcoded lowercase
  // `'open'` per the 0040 LESSON so every existing
  // `state = 'open'` reader keeps matching; closed/merged rows write
  // the gh state verbatim ('CLOSED' / 'MERGED' uppercase) which
  // matches the established `state = 'MERGED'` reader convention in
  // src/views.ts and the new 0047 `state = 'CLOSED'` autopsy filter.
  // Both fetches use the same `--json` projection plus the `state` +
  // `closedAt` fields (additive on the gh JSON shape — no callers
  // consume the gh stdout directly).
  const JSON_FIELDS = "number,title,headRefName,mergeStateStatus,statusCheckRollup,additions,deletions,author,url,createdAt,closedAt,state,commits";
  let openRows: any[] = [];
  let closedRows: any[] = [];
  try {
    const openOut = activeRunner("gh", ["pr", "list", "--repo", repo, "--state", "open", "--limit", "40",
      "--json", JSON_FIELDS]);
    openRows = JSON.parse(openOut);
  } catch { return; } // no gh/auth/network → keep last cache for the whole project
  try {
    // The closed fetch is best-effort: if it fails (older gh, auth
    // hiccup) we still write the open rows. The existing DELETE-then-
    // INSERT pattern below removes the prior tick's closed rows, so
    // a transient failure means the autopsy goes dark for one tick
    // — not a regression on the existing open-PR surface.
    const closedOut = activeRunner("gh", ["pr", "list", "--repo", repo, "--state", "closed", "--limit", "40",
      "--json", JSON_FIELDS]);
    closedRows = JSON.parse(closedOut);
  } catch { closedRows = []; }

  const now = new Date().toISOString();
  db.prepare("DELETE FROM pr WHERE project_id=?").run(projectId);
  // Two prepared statements: one hardcodes the 'open' lowercase
  // literal (per the 0040 LESSON — open readers expect this exact
  // casing), one accepts the gh state token verbatim ('CLOSED' or
  // 'MERGED' uppercase). The closed-state stmt additionally carries
  // a `closed_at` column write so the 0047 autopsy filter
  // (`state='CLOSED' AND closed_at IS NOT NULL`) lights up.
  const upOpen = db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
    + "additions,deletions,author,url,fetched_at,gh_created_at,"
    + "first_fail_check,first_fail_excerpt,heal_attempts) "
    + "VALUES(?,?,?,?, 'open', ?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  const upClosed = db.prepare(
    "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
    + "additions,deletions,author,url,fetched_at,gh_created_at,closed_at,"
    + "first_fail_check,first_fail_excerpt,heal_attempts) "
    + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );

  // Open rows: hardcoded 'open' lowercase. closed_at stays NULL by
  // schema default — the open INSERT never writes that column.
  for (const p of openRows) {
    // Ticket 0023 + 0027: derive first_fail_check via the
    // startedAt-ascending picker (was: array order), then (when
    // non-null) pull the first 200 chars of the failing log via the
    // runner seam. Both excerpt-side columns stay NULL when the
    // rollup carries no failing check — the correlation pass skips
    // NULL excerpts entirely.
    //
    // heal_attempts is sourced from the commits payload via
    // countHealCommits — `heal:` at column zero, case-insensitive,
    // first-line-only. NULL-safe: defaults to 0 when gh omits the
    // commits field (no caller hits that branch in production but the
    // helper tolerates it).
    const firstFail = pickFirstFailingCheckName(p.statusCheckRollup);
    const excerpt = firstFail ? fetchFirstFailExcerpt(repo, p.number) : null;
    const heals = countHealCommits(p.commits);
    upOpen.run(projectId, p.number, p.title, p.headRefName, ciState(p.statusCheckRollup),
      p.mergeStateStatus ?? null, AGENT_RE.test(p.headRefName) ? 1 : 0,
      p.additions ?? 0, p.deletions ?? 0, p.author?.login ?? null, p.url ?? null, now,
      p.createdAt ?? null, firstFail, excerpt, heals);
  }

  // Closed/merged rows: gh state verbatim + closed_at populated from
  // gh's `closedAt`. We DO NOT call fetchFirstFailExcerpt for closed
  // rows — `gh run view --log-failed --branch pull/<n>/head` cannot
  // resolve a workflow run for a closed PR head (the branch is
  // typically gone), and the autopsy reader already carries the
  // first_fail_check token from when the row was last open. We DO
  // call pickFirstFailingCheckName so a merged-from-red PR
  // (rare but legal) still carries the killing-check name.
  for (const p of closedRows) {
    // gh's state field for `--state closed` is one of 'CLOSED' or
    // 'MERGED' (uppercase). Anything else (an OPEN row that snuck in
    // via a re-open mid-tick — unlikely but possible) defaults to the
    // safe 'CLOSED' token so the autopsy filter still matches.
    const rawState = String(p.state ?? "").toUpperCase();
    const state = rawState === "MERGED" ? "MERGED" : "CLOSED";
    const firstFail = pickFirstFailingCheckName(p.statusCheckRollup);
    const heals = countHealCommits(p.commits);
    upClosed.run(projectId, p.number, p.title, p.headRefName, state,
      ciState(p.statusCheckRollup), p.mergeStateStatus ?? null,
      AGENT_RE.test(p.headRefName) ? 1 : 0,
      p.additions ?? 0, p.deletions ?? 0, p.author?.login ?? null, p.url ?? null, now,
      p.createdAt ?? null, p.closedAt ?? null, firstFail, null, heals);
  }
}

export function projectPRs(db: DB, projectId: number) {
  // Ticket 0023: additively returns heal_attempts + first_fail_check
  // so the PR card renderer can surface "heal X/2" and "first failed:
  // <name>" without a second round-trip. Existing fields keep their
  // names and types — this is purely additive on the JSON shape
  // (the SPA's fetcher tolerates extra keys).
  return db.prepare(
    "SELECT number,title,branch,ci_state,merge_state,is_agent,additions,deletions,"
    + "author,url,heal_attempts,first_fail_check "
    + "FROM pr WHERE project_id=? ORDER BY is_agent DESC, number DESC",
  ).all(projectId);
}
