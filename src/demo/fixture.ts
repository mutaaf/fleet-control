// Demo fixture loader (ticket 0025). Hand-authored TypeScript constants
// describing a three-project sandbox fleet — projects, runs, PRs,
// anomalies, cost rollups — that boots into a populated portal in
// under 30 seconds. The data is deterministic across loads and
// timestamps are computed relative to "now" at load-time so the
// seeded fleet always looks "recent".
//
// Why pure-SQL inserts rather than a JSON file + loader:
//   - No file I/O at fixture-load time keeps the fixture self-
//     contained and survives `npm pack` / a future zero-clone path
//     without an extra runtime asset.
//   - Hand-authored TS literals get type-stripping syntax checks at
//     boot, so a typo in a slug or phase fails fast.
//
// Why `INSERT OR IGNORE` keyed on the natural keys:
//   - The fixture is idempotent. Re-running it against an existing
//     demo DB is a silent no-op (no duplicate projects, runs, PRs,
//     anomalies). Per AC2 of the ticket.
//
// Why no shell-out / no fetch / no child_process import:
//   - This module is pure SQL. The runtime contract (AGENTS.md) bans
//     composing shell strings; the fixture has no need to spawn
//     anything in the first place. See the AC10 test in
//     tests/demo.test.ts which greps the source to enforce.
//
// Per docs/LESSONS.md:
//   - typed `.get()` / `.all()` callers in tests use `as unknown as T`
//     (cited from the snapshot/inbox modules);
//   - no backticks inside SQL string literals — every identifier is
//     a plain word.

import type { DB } from "../db.ts";

// ────────────────────────────────────────────────────────────────────
// Public constants (consumed by the CLI handler + tests)
// ────────────────────────────────────────────────────────────────────

/** Port the demo binds to by default. Deliberately NOT 7070 so a real
 *  `fleetctl serve` running on the same machine isn't shadowed. */
export const DEMO_DEFAULT_PORT = 7071;

/** Two-line console banner printed on listen. Single source of truth
 *  so the CLI handler and the AC7 test agree byte-for-byte. */
export const DEMO_BANNER =
  "fleet-control demo - sandbox fleet at http://127.0.0.1:7071\n"
  + "Three seeded projects, ephemeral DB. Press Ctrl-C to tear down.\n";

/** The three project slugs the fixture seeds, in display order. */
export const DEMO_PROJECT_SLUGS = ["fleet-demo-api", "fleet-demo-web", "fleet-demo-cli"] as const;

// ────────────────────────────────────────────────────────────────────
// Fixture data — hand-authored constants
// ────────────────────────────────────────────────────────────────────

interface DemoProject {
  slug: string;
  name: string;
  namespace: string;
  /** Phases the project runs. ship is always present; eng appears only
   *  for projects whose backlog leans on engineering work. */
  phases: ReadonlyArray<"ship" | "groom" | "review" | "eng">;
  /** Plausible per-day cost so the rollup heatmap has visible
   *  intensity differences across the three projects. */
  daily_cost_usd: number;
  eng_enabled: boolean;
}

const DEMO_PROJECTS: ReadonlyArray<DemoProject> = [
  {
    slug: "fleet-demo-api",
    name: "Fleet Demo API",
    namespace: "com.fleet.demo.api",
    phases: ["ship", "groom", "review"],
    daily_cost_usd: 0.42,
    eng_enabled: false,
  },
  {
    slug: "fleet-demo-web",
    name: "Fleet Demo Web",
    namespace: "com.fleet.demo.web",
    phases: ["ship", "groom", "review", "eng"],
    daily_cost_usd: 0.71,
    eng_enabled: true,
  },
  {
    slug: "fleet-demo-cli",
    name: "Fleet Demo CLI",
    namespace: "com.fleet.demo.cli",
    phases: ["ship", "groom", "review"],
    daily_cost_usd: 0.18,
    eng_enabled: false,
  },
];

/** Plausible outcomes per phase. ship overwhelmingly succeeds (with a
 *  smattering of no-ops and one failure) so the SPA's success banner
 *  looks healthy; groom mostly succeeds; review is no-op-heavy. */
const SHIP_OUTCOMES = ["shipped", "shipped", "shipped", "no-op", "shipped", "failure"] as const;
const GROOM_OUTCOMES = ["no-op", "shipped", "no-op", "no-op"] as const;
const REVIEW_OUTCOMES = ["no-op", "no-op", "approved", "no-op"] as const;
const ENG_OUTCOMES = ["shipped", "no-op", "shipped"] as const;

const PHASE_OUTCOMES: Record<"ship" | "groom" | "review" | "eng", ReadonlyArray<string>> = {
  ship: SHIP_OUTCOMES,
  groom: GROOM_OUTCOMES,
  review: REVIEW_OUTCOMES,
  eng: ENG_OUTCOMES,
};

interface DemoPr {
  /** Project slug — joined to project.id at load-time. */
  project_slug: string;
  number: number;
  title: string;
  state: "merged" | "open";
  ci_state: "success" | "pending" | "failure";
  merge_state: "clean" | "behind" | "blocked";
  branch: string;
  is_agent: boolean;
  additions: number;
  deletions: number;
  /** Hours-ago for the synthetic `fetched_at` field. The fixture
   *  applies "now - hours_ago" at load-time so the data always reads
   *  as recent. */
  hours_ago: number;
  /** For one open PR: include a heal-attempt marker in the title so
   *  the SPA's PR card surfaces the heal-1/2 chip. */
  heal_attempt?: number;
}

const DEMO_PRS: ReadonlyArray<DemoPr> = [
  // 4 merged across the three projects
  { project_slug: "fleet-demo-api", number: 101, title: "feat/0042 paginate /v1/items", state: "merged", ci_state: "success", merge_state: "clean", branch: "feat/0042-paginate", is_agent: true, additions: 84, deletions: 12, hours_ago: 7 * 24 },
  { project_slug: "fleet-demo-api", number: 104, title: "feat/0044 rate-limit token bucket", state: "merged", ci_state: "success", merge_state: "clean", branch: "feat/0044-rate-limit", is_agent: true, additions: 162, deletions: 21, hours_ago: 3 * 24 },
  { project_slug: "fleet-demo-web", number: 87, title: "feat/0033 dark-mode toggle", state: "merged", ci_state: "success", merge_state: "clean", branch: "feat/0033-dark-mode", is_agent: true, additions: 56, deletions: 8, hours_ago: 30 },
  { project_slug: "fleet-demo-cli", number: 22, title: "feat/0019 --json output for status", state: "merged", ci_state: "success", merge_state: "clean", branch: "feat/0019-json-status", is_agent: true, additions: 38, deletions: 5, hours_ago: 18 },
  // 2 open; one has heal-attempt=1
  { project_slug: "fleet-demo-web", number: 91, title: "feat/0035 chart legend overlap", state: "open", ci_state: "failure", merge_state: "blocked", branch: "feat/0035-chart-legend", is_agent: true, additions: 24, deletions: 6, hours_ago: 4, heal_attempt: 1 },
  { project_slug: "fleet-demo-api", number: 108, title: "feat/0048 deflake snapshot test", state: "open", ci_state: "pending", merge_state: "clean", branch: "feat/0048-deflake", is_agent: true, additions: 14, deletions: 3, hours_ago: 1 },
];

interface DemoAnomaly {
  project_slug: string;
  phase: "ship" | "groom" | "review" | "eng";
  kind: "duration" | "cost";
  value: number;
  baseline_mean: number;
  baseline_stddev: number;
  sample_count: number;
  candidate_reason: string;
  /** Hours-ago for created_at. */
  hours_ago: number;
}

const DEMO_ANOMALIES: ReadonlyArray<DemoAnomaly> = [
  {
    project_slug: "fleet-demo-web",
    phase: "ship",
    kind: "duration",
    value: 124_000,
    baseline_mean: 42_000,
    baseline_stddev: 9_000,
    sample_count: 14,
    candidate_reason: "ship run took 124s — ~9σ above the 14d baseline of 42s",
    hours_ago: 2,
  },
];

// ────────────────────────────────────────────────────────────────────
// Time helpers
// ────────────────────────────────────────────────────────────────────

/** ISO string for "now - N hours". */
function hoursAgo(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 3600_000).toISOString();
}

/** ISO string for "now - N seconds". */
function secondsAgo(now: Date, seconds: number): string {
  return new Date(now.getTime() - seconds * 1000).toISOString();
}

// ────────────────────────────────────────────────────────────────────
// Per-project run synthesis
// ────────────────────────────────────────────────────────────────────

interface SynthesizedRun {
  phase: "ship" | "groom" | "review" | "eng";
  session_id: string;
  started_at: string;
  duration_ms: number;
  num_turns: number;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  outcome: string;
  pr_number: number | null;
}

/** Deterministic pseudo-random in [0, 1) seeded by the slug+phase+index
 *  triple. Plain LCG — no node:crypto, no Math.random (which would
 *  break AC9 determinism). */
function seededRand(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return ((h >>> 0) % 100000) / 100000;
  };
}

/** Synthesize ~12 runs per project per phase, spread across the
 *  trailing 30 days. The most recent run lands within the last hour
 *  so AC3's "MAX(run.ts) within 1h" assertion holds. */
function synthesizeRuns(now: Date, project: DemoProject): SynthesizedRun[] {
  const out: SynthesizedRun[] = [];
  // Anchor: the most-recent run sits 25 minutes before "now" so it's
  // comfortably inside the AC3 1-hour band but still in the past.
  const LATEST_MINUTES_AGO = 25;
  for (const phase of project.phases) {
    const outcomes = PHASE_OUTCOMES[phase];
    // 12 runs per phase across 30 days = roughly one every 2.5 days.
    const COUNT = 12;
    const rand = seededRand(project.slug + "/" + phase);
    for (let i = 0; i < COUNT; i++) {
      // Latest run (i=0) for the project's first phase becomes the
      // global anchor; subsequent runs space backwards.
      const minutesAgo = LATEST_MINUTES_AGO + i * (30 * 24 * 60 / COUNT) + Math.floor(rand() * 30);
      const startedAt = new Date(now.getTime() - minutesAgo * 60_000).toISOString();
      const durationMs = 25_000 + Math.floor(rand() * 60_000);
      const turns = 6 + Math.floor(rand() * 20);
      const input = 1500 + Math.floor(rand() * 4500);
      const output = 800 + Math.floor(rand() * 2500);
      const cacheRead = 12_000 + Math.floor(rand() * 8_000);
      const cacheCreation = 300 + Math.floor(rand() * 600);
      // Phase-correlated cost: ship ~ avg, groom < avg, review << avg.
      const phaseMult = phase === "ship" ? 1.0 : phase === "groom" ? 0.4 : phase === "review" ? 0.15 : 0.6;
      const cost = +(project.daily_cost_usd * phaseMult * (0.5 + rand())).toFixed(4);
      const outcome = outcomes[i % outcomes.length];
      const sessionId = `demo-${project.slug}-${phase}-${i.toString().padStart(2, "0")}`;
      // Roughly 1-in-3 ship runs carry a PR number. The values don't
      // collide with the DEMO_PRS table (we use 200+ here) so the run
      // table looks lively without conflicting with the PR-list view.
      const prNumber = phase === "ship" && outcome === "shipped" && i % 3 === 0 ? 200 + i : null;
      out.push({
        phase,
        session_id: sessionId,
        started_at: startedAt,
        duration_ms: durationMs,
        num_turns: turns,
        input_tokens: input,
        output_tokens: output,
        cache_creation_tokens: cacheCreation,
        cache_read_tokens: cacheRead,
        cost_usd: cost,
        outcome,
        pr_number: prNumber,
      });
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Cost-rollup recompute (mirrors src/ingest/index.ts but scoped to
// the demo's project ids so a future call from the daemon-bypassed
// startServer doesn't wipe rows for projects outside the demo).
// ────────────────────────────────────────────────────────────────────

function recomputeDemoRollups(db: DB, projectIds: ReadonlyArray<number>): void {
  if (projectIds.length === 0) return;
  const placeholders = projectIds.map(() => "?").join(",");
  // Idempotent: delete then re-insert for these project ids only.
  db.prepare("DELETE FROM cost_rollup_day WHERE project_id IN (" + placeholders + ")")
    .run(...projectIds);
  db.prepare(
    "INSERT INTO cost_rollup_day(project_id,phase,day,runs,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd) "
    + "SELECT project_id, phase, date(started_at) AS day, COUNT(*), "
    + "  SUM(input_tokens), SUM(output_tokens), SUM(cache_creation_tokens), SUM(cache_read_tokens), "
    + "  SUM(COALESCE(cost_usd, cost_usd_computed, 0)) "
    + "FROM run WHERE started_at IS NOT NULL AND project_id IN (" + placeholders + ") "
    + "GROUP BY project_id, phase, date(started_at)",
  ).run(...projectIds);
}

// ────────────────────────────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────────────────────────────

interface ProjectIdRow { id: number; }

/** Seed the three-project sandbox fleet into `db`. Idempotent: re-
 *  running on the same DB produces no duplicate rows.
 *
 *  Returns the array of project ids that were touched so the caller
 *  (typically the demo CLI handler) can drive any follow-up reads
 *  scoped to the fixture without scanning the full project table. */
export function loadDemoFixture(db: DB): number[] {
  const now = new Date();
  const nowIso = now.toISOString();

  db.exec("BEGIN");
  try {
    // Projects — INSERT OR IGNORE keyed on slug (UNIQUE). cadence_json
    // mirrors the "steady" preset so the SPA labels the pace cleanly.
    const upProject = db.prepare(
      "INSERT OR IGNORE INTO project(slug,name,namespace,repo_url,repo_owner,repo_name,model,self_cancel,eng_enabled,manifest_path,cadence_json,first_seen_at,last_seen_at) "
      + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const updateSeen = db.prepare(
      "UPDATE project SET last_seen_at=? WHERE slug=?",
    );
    const cadenceJson = JSON.stringify({
      ship_hours: "0 2 4 6 8 10 12 14 16 18 20 22",
      ship_minute: "41",
      groom_hours: "0 12",
      groom_minute: "17",
      review_interval: "900",
      eng_hours: "0 12",
      eng_minute: "23",
    });
    const projectIds: number[] = [];
    for (const p of DEMO_PROJECTS) {
      upProject.run(
        p.slug,
        p.name,
        p.namespace,
        // repo_url + repo_owner + repo_name are intentionally null-ish
        // so the rendered payload carries no real GitHub URLs. The SPA
        // tolerates null repo fields (existing project rows that
        // haven't been discovered yet hit the same path).
        null,
        null,
        null,
        "claude-opus-4-7",
        "", // self_cancel
        p.eng_enabled ? 1 : 0,
        // manifest_path is the kind of field the snapshot anonymizer
        // strips; we set it to a non-disk-leaking placeholder so a
        // grep for the operator's HOME comes back empty (AC8).
        "(demo)",
        cadenceJson,
        nowIso,
        nowIso,
      );
      updateSeen.run(nowIso, p.slug);
      // Per docs/LESSONS.md § "node:sqlite's .all() needs as unknown as
      // T[]" — the same applies to .get() for narrowing the index-signature
      // SQLOutputValue type to a closed interface.
      const idRow = db.prepare("SELECT id FROM project WHERE slug=?").get(p.slug) as unknown as ProjectIdRow | undefined;
      if (idRow) projectIds.push(idRow.id);
    }

    // Agent rows — one per (project, phase). UNIQUE(project_id, phase)
    // makes this idempotent.
    const upAgent = db.prepare(
      "INSERT INTO agent(project_id,phase,launchd_label) VALUES(?,?,?) "
      + "ON CONFLICT(project_id,phase) DO UPDATE SET launchd_label=excluded.launchd_label",
    );
    for (let i = 0; i < DEMO_PROJECTS.length; i++) {
      const p = DEMO_PROJECTS[i];
      const id = projectIds[i];
      for (const phase of p.phases) {
        upAgent.run(id, phase, p.namespace + ".agent-" + phase);
      }
    }

    // Runs — synthesized 30d backfill per (project, phase). The
    // UNIQUE(project_id, phase, session_id) constraint is the
    // idempotency guard.
    const upRun = db.prepare(
      "INSERT OR IGNORE INTO run(project_id,phase,session_id,started_at,ended_at,duration_ms,num_turns,"
      + "input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd,cost_source,"
      + "model,outcome,pr_number,source) "
      + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (let i = 0; i < DEMO_PROJECTS.length; i++) {
      const p = DEMO_PROJECTS[i];
      const id = projectIds[i];
      for (const r of synthesizeRuns(now, p)) {
        const endedAt = new Date(new Date(r.started_at).getTime() + r.duration_ms).toISOString();
        upRun.run(
          id,
          r.phase,
          r.session_id,
          r.started_at,
          endedAt,
          r.duration_ms,
          r.num_turns,
          r.input_tokens,
          r.output_tokens,
          r.cache_creation_tokens,
          r.cache_read_tokens,
          r.cost_usd,
          "live",
          "claude-opus-4-7",
          r.outcome,
          r.pr_number,
          "demo-fixture",
        );
      }
    }

    // PRs — INSERT OR IGNORE keyed on (project_id, number) (the table's
    // composite PK). `fetched_at` is recomputed per load so the PRs
    // always read as recent (AC3).
    const upPr = db.prepare(
      "INSERT OR IGNORE INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
      + "additions,deletions,author,url,fetched_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const updatePrFetched = db.prepare(
      "UPDATE pr SET fetched_at=? WHERE project_id=? AND number=?",
    );
    const idBySlug = new Map<string, number>();
    for (let i = 0; i < DEMO_PROJECTS.length; i++) {
      idBySlug.set(DEMO_PROJECTS[i].slug, projectIds[i]);
    }
    for (const pr of DEMO_PRS) {
      const pid = idBySlug.get(pr.project_slug);
      if (pid == null) continue;
      const fetched = hoursAgo(now, pr.hours_ago);
      // Title carries an optional "heal N/2" marker that the SPA's PR
      // card surfaces inline (the rendering is done by ticket 0023's
      // SPA work; we just produce the data shape here).
      const title = pr.heal_attempt
        ? `${pr.title} (heal ${pr.heal_attempt}/2)`
        : pr.title;
      upPr.run(
        pid,
        pr.number,
        title,
        pr.branch,
        pr.state,
        pr.ci_state,
        pr.merge_state,
        pr.is_agent ? 1 : 0,
        pr.additions,
        pr.deletions,
        "fleet-agent[bot]",
        // URL is a placeholder rather than a real github.com link so
        // the fixture render survives the AC8 grep for github.com URLs.
        "(demo)",
        fetched,
      );
      // Always refresh fetched_at on re-load so the timestamps stay
      // anchored to "now" (the upsert above is a no-op on PK conflict).
      updatePrFetched.run(fetched, pid, pr.number);
    }

    // Anomalies — one row per (run_id, kind). We need a real run to
    // attach the anomaly to; pick the most recent ship run for the
    // anomaly's project. UNIQUE(run_id, kind) makes the insert
    // idempotent.
    const upAnomaly = db.prepare(
      "INSERT OR IGNORE INTO anomaly(run_id,kind,value,baseline_mean,baseline_stddev,sample_count,"
      + "candidate_reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
    );
    for (const a of DEMO_ANOMALIES) {
      const pid = idBySlug.get(a.project_slug);
      if (pid == null) continue;
      const run = db.prepare(
        "SELECT id FROM run WHERE project_id=? AND phase=? ORDER BY started_at DESC LIMIT 1",
      ).get(pid, a.phase) as { id: number } | undefined;
      if (!run) continue;
      upAnomaly.run(
        run.id,
        a.kind,
        a.value,
        a.baseline_mean,
        a.baseline_stddev,
        a.sample_count,
        a.candidate_reason,
        hoursAgo(now, a.hours_ago),
      );
    }

    // Cost rollups — derived from the run rows we just inserted.
    // Scoped to the demo's project ids so we don't wipe rows that
    // belong to a different project on a shared DB.
    recomputeDemoRollups(db, projectIds);

    db.exec("COMMIT");
    // Suppress unused-import-style lint for the seconds helper — it's
    // useful for any caller that wants sub-minute precision.
    void secondsAgo;
    return projectIds;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
