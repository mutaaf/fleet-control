// Tests for ticket 0049 — ingest CLOSED + MERGED PRs into the `pr` table.
//
// One test() per acceptance-criteria checkbox in
// docs/backlog/0049-ingest-closed-prs.md.
//
// Strategy:
//   - Drive ingestProjectPRs() directly against a tmpdir DB opened by
//     openDb() so the production ALTERs run.
//   - Stub the gh runner via _setPrRunnerForTests so we can pin TWO
//     payloads: one for `gh pr list --state open` and one for
//     `gh pr list --state closed`. The runner branches on
//     argv to return the right payload.
//   - Producer-vs-spec audit (LESSONS 2026-06-05): the production
//     readers in src/views.ts, src/server.ts, src/receipts.ts,
//     src/correlate.ts only ever compare pr.state to one of three
//     literal strings: 'open' (lowercase, the 0040 LESSON), 'MERGED'
//     (uppercase), 'CLOSED' (uppercase). The ingester writes the gh
//     state verbatim for closed/merged rows and the hardcoded
//     lowercase 'open' for open rows — fully compatible.
//
// Zero new runtime deps; stdlib + node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db.ts";
import {
  ingestProjectPRs,
  _setPrRunnerForTests, _resetPrRunnerForTests,
} from "../src/ingest/prs.ts";
// Direct re-runs of the helpers that read pr.state — AC4 regression
// guard. Imported lazily inside their test bodies so a refactor that
// renames one doesn't blow up the whole file.

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-prs0049-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace) VALUES (?,?,?)",
  ).run(slug, slug, "test");
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

/** A minimal `gh pr list --json` row. The closed-state fetch uses the
 *  same JSON shape as the open-state fetch — gh's `--json` projection
 *  is uniform regardless of `--state`. */
function ghRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    number: 1, title: "demo", headRefName: "feat/x",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [],
    commits: [],
    additions: 1, deletions: 0, author: { login: "agent" },
    url: "https://github.com/owner/repo/pull/1",
    createdAt: "2026-05-20T10:00:00Z",
    state: "OPEN", // overridden per row
    closedAt: null,
    ...over,
  };
}

/** Build a runner that returns the right payload based on the
 *  `--state` flag in the argv. Captures invocations for assertions. */
function mkRunner(opts: {
  openRows: unknown[];
  closedRows: unknown[];
}): { runner: (cmd: string, args: readonly string[]) => string; invocations: { state: string; argv: readonly string[] }[] } {
  const invocations: { state: string; argv: readonly string[] }[] = [];
  const runner = (cmd: string, args: readonly string[]): string => {
    if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
      // Find the `--state <value>` flag.
      const i = args.indexOf("--state");
      const state = i >= 0 ? String(args[i + 1] ?? "") : "";
      invocations.push({ state, argv: args });
      if (state === "open") return JSON.stringify(opts.openRows);
      if (state === "closed") return JSON.stringify(opts.closedRows);
      return "[]";
    }
    // `gh run view --log-failed` follow-up shell-out — return empty so
    // the first_fail_excerpt path stays null.
    return "";
  };
  return { runner, invocations };
}

// ────────────────────────────────────────────────────────────────────
// AC1 — ingester fetches `--state closed` AND writes verbatim CLOSED /
//       MERGED state values; open rows still write the hardcoded
//       'open' lowercase.
// ────────────────────────────────────────────────────────────────────

test("AC1: ingester fires a second `gh pr list --state closed` call alongside the open call", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "double-call");
    const { runner, invocations } = mkRunner({
      openRows: [ghRow({ number: 1, headRefName: "feat/1", state: "OPEN" })],
      closedRows: [
        ghRow({ number: 2, headRefName: "feat/2", state: "MERGED",
                closedAt: "2026-06-01T10:00:00Z" }),
        ghRow({ number: 3, headRefName: "feat/3", state: "CLOSED",
                closedAt: "2026-06-02T10:00:00Z" }),
      ],
    });
    _setPrRunnerForTests(runner);
    try {
      ingestProjectPRs(db, pid, "owner/double-call");
    } finally { _resetPrRunnerForTests(); }
    // Exactly two `gh pr list` calls — one per state. The order is
    // implementation-defined but both states MUST be requested.
    const states = invocations.map((i) => i.state).sort();
    assert.deepEqual(states, ["closed", "open"],
      "ingester must call gh pr list once per state (open, closed)");
  } finally { cleanup(); }
});

test("AC1: closed-state rows persist with the gh-verbatim 'CLOSED' / 'MERGED' state values", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "verbatim");
    const { runner } = mkRunner({
      openRows: [ghRow({ number: 10, headRefName: "feat/open", state: "OPEN" })],
      closedRows: [
        ghRow({
          number: 20, title: "merged one", headRefName: "feat/m",
          state: "MERGED", closedAt: "2026-06-01T10:00:00Z",
        }),
        ghRow({
          number: 21, title: "closed one", headRefName: "feat/c",
          state: "CLOSED", closedAt: "2026-06-02T10:00:00Z",
        }),
      ],
    });
    _setPrRunnerForTests(runner);
    try {
      ingestProjectPRs(db, pid, "owner/verbatim");
    } finally { _resetPrRunnerForTests(); }

    const row20 = db.prepare("SELECT state FROM pr WHERE project_id=? AND number=?").get(pid, 20) as { state: string } | undefined;
    const row21 = db.prepare("SELECT state FROM pr WHERE project_id=? AND number=?").get(pid, 21) as { state: string } | undefined;
    assert.ok(row20, "merged row must persist");
    assert.ok(row21, "closed row must persist");
    assert.equal(row20!.state, "MERGED",
      "merged PR row must persist with verbatim 'MERGED' (uppercase) per the existing reader convention");
    assert.equal(row21!.state, "CLOSED",
      "closed PR row must persist with verbatim 'CLOSED' (uppercase) per the autopsy reader convention");
  } finally { cleanup(); }
});

test("AC1: open-state rows continue to persist with the hardcoded 'open' lowercase (0040 LESSON)", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "lower");
    // gh's `--json state` would return 'OPEN' uppercase; the ingester
    // discards that token and writes the hardcoded lowercase so
    // existing `state = 'open'` readers keep matching.
    const { runner } = mkRunner({
      openRows: [
        ghRow({ number: 30, headRefName: "feat/30", state: "OPEN" }),
        ghRow({ number: 31, headRefName: "feat/31", state: "OPEN" }),
      ],
      closedRows: [],
    });
    _setPrRunnerForTests(runner);
    try {
      ingestProjectPRs(db, pid, "owner/lower");
    } finally { _resetPrRunnerForTests(); }
    const rows = db.prepare("SELECT number, state FROM pr WHERE project_id=? ORDER BY number").all(pid) as { number: number; state: string }[];
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(r.state, "open",
        `open PR row #${r.number} must persist with lowercase 'open' per the 0040 LESSON`);
    }
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — closed_at populated from gh's closedAt on closed/merged rows;
//       gh_created_at still populated from createdAt on every row.
// ────────────────────────────────────────────────────────────────────

test("AC2: closed_at is populated from gh's closedAt on every closed + merged row", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "closedat");
    const { runner } = mkRunner({
      openRows: [
        ghRow({ number: 40, headRefName: "feat/40", state: "OPEN",
                createdAt: "2026-05-25T08:00:00Z" }),
      ],
      closedRows: [
        ghRow({
          number: 41, headRefName: "feat/41", state: "MERGED",
          createdAt: "2026-05-20T08:00:00Z",
          closedAt: "2026-05-28T15:30:00Z",
        }),
        ghRow({
          number: 42, headRefName: "feat/42", state: "CLOSED",
          createdAt: "2026-05-21T08:00:00Z",
          closedAt: "2026-05-29T16:00:00Z",
        }),
      ],
    });
    _setPrRunnerForTests(runner);
    try {
      ingestProjectPRs(db, pid, "owner/closedat");
    } finally { _resetPrRunnerForTests(); }

    const merged = db.prepare(
      "SELECT closed_at, gh_created_at, state FROM pr WHERE project_id=? AND number=?",
    ).get(pid, 41) as { closed_at: string | null; gh_created_at: string | null; state: string } | undefined;
    const closed = db.prepare(
      "SELECT closed_at, gh_created_at, state FROM pr WHERE project_id=? AND number=?",
    ).get(pid, 42) as { closed_at: string | null; gh_created_at: string | null; state: string } | undefined;
    const open = db.prepare(
      "SELECT closed_at, gh_created_at, state FROM pr WHERE project_id=? AND number=?",
    ).get(pid, 40) as { closed_at: string | null; gh_created_at: string | null; state: string } | undefined;

    assert.ok(merged && closed && open, "all three rows must persist");
    assert.equal(merged!.closed_at, "2026-05-28T15:30:00Z",
      "merged PR must record gh's closedAt in pr.closed_at");
    assert.equal(closed!.closed_at, "2026-05-29T16:00:00Z",
      "closed PR must record gh's closedAt in pr.closed_at");
    assert.equal(merged!.gh_created_at, "2026-05-20T08:00:00Z",
      "merged PR must record gh's createdAt in pr.gh_created_at");
    assert.equal(closed!.gh_created_at, "2026-05-21T08:00:00Z",
      "closed PR must record gh's createdAt in pr.gh_created_at");
    // Open rows: closed_at MUST stay NULL — the existing autopsy
    // SELECT filters on `closed_at IS NOT NULL` so a stray non-NULL
    // value would surface the open PR as a closed autopsy row.
    assert.equal(open!.closed_at, null,
      "open PR row must keep closed_at = NULL");
    assert.equal(open!.gh_created_at, "2026-05-25T08:00:00Z",
      "open PR must still record gh's createdAt in gh_created_at");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — mixed-state fixture: CLOSED + MERGED + OPEN all land in one
//       ingest pass with correct casing and closed_at.
// ────────────────────────────────────────────────────────────────────

test("AC3: a mixed-state fixture round-trips through ingestProjectPRs into the pr table", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "mixed");
    const { runner } = mkRunner({
      openRows: [
        ghRow({ number: 100, title: "open-A", headRefName: "feat/100",
                state: "OPEN", createdAt: "2026-06-01T09:00:00Z" }),
        ghRow({ number: 101, title: "open-B", headRefName: "feat/101",
                state: "OPEN", createdAt: "2026-06-02T09:00:00Z" }),
      ],
      closedRows: [
        ghRow({ number: 200, title: "merged-A", headRefName: "feat/200",
                state: "MERGED", createdAt: "2026-05-15T09:00:00Z",
                closedAt: "2026-05-20T09:00:00Z" }),
        ghRow({ number: 201, title: "merged-B", headRefName: "feat/201",
                state: "MERGED", createdAt: "2026-05-22T09:00:00Z",
                closedAt: "2026-05-28T09:00:00Z" }),
        ghRow({ number: 300, title: "closed-A", headRefName: "feat/300",
                state: "CLOSED", createdAt: "2026-05-25T09:00:00Z",
                closedAt: "2026-05-30T09:00:00Z" }),
      ],
    });
    _setPrRunnerForTests(runner);
    try {
      ingestProjectPRs(db, pid, "owner/mixed");
    } finally { _resetPrRunnerForTests(); }

    // 2 open + 2 merged + 1 closed = 5 rows in the pr table for this project.
    const all = db.prepare(
      "SELECT number, state, closed_at FROM pr WHERE project_id=? ORDER BY number",
    ).all(pid) as { number: number; state: string; closed_at: string | null }[];
    assert.equal(all.length, 5, "5 PRs should land — 2 open + 2 merged + 1 closed");

    const byNumber = new Map(all.map((r) => [r.number, r]));
    assert.equal(byNumber.get(100)!.state, "open");
    assert.equal(byNumber.get(100)!.closed_at, null);
    assert.equal(byNumber.get(101)!.state, "open");
    assert.equal(byNumber.get(101)!.closed_at, null);
    assert.equal(byNumber.get(200)!.state, "MERGED");
    assert.equal(byNumber.get(200)!.closed_at, "2026-05-20T09:00:00Z");
    assert.equal(byNumber.get(201)!.state, "MERGED");
    assert.equal(byNumber.get(201)!.closed_at, "2026-05-28T09:00:00Z");
    assert.equal(byNumber.get(300)!.state, "CLOSED");
    assert.equal(byNumber.get(300)!.closed_at, "2026-05-30T09:00:00Z");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — regression coverage for the helpers each restricted to a
//       single pr.state value. The mixed fixture above should NOT
//       affect their counts beyond what each filter intends:
//         - riskiest_open_pr (0040): state='open' AND is_agent=1
//         - spendEfficiencyRanking (0044): state='MERGED' AND is_agent=1
//         - stuckPrTaxonomy (0045): state='open' AND is_agent=1
//         - prs_merged_7d (0019): state='MERGED' AND is_agent=1
//       We exercise the new mixed fixture through each helper to
//       confirm a third state value (CLOSED) on the same project
//       does NOT change the count.
// ────────────────────────────────────────────────────────────────────

test("AC4: riskiestOpenPr counts only 'open' rows even when CLOSED + MERGED rows live alongside", async () => {
  const { riskiestOpenPr } = await import("../src/views.ts");
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "risk");
    const { runner } = mkRunner({
      openRows: [
        ghRow({ number: 1, headRefName: "feat/1", state: "OPEN",
                createdAt: "2026-06-01T08:00:00Z" }),
      ],
      closedRows: [
        ghRow({ number: 2, headRefName: "feat/2", state: "MERGED",
                closedAt: "2026-05-20T08:00:00Z" }),
        ghRow({ number: 3, headRefName: "feat/3", state: "CLOSED",
                closedAt: "2026-05-21T08:00:00Z" }),
      ],
    });
    _setPrRunnerForTests(runner);
    try { ingestProjectPRs(db, pid, "owner/risk"); }
    finally { _resetPrRunnerForTests(); }
    const result = riskiestOpenPr(db, new Date("2026-06-10T12:00:00Z"));
    // open_count surfaces the number of OPEN agent PRs across the
    // fleet. We seeded 1 OPEN row with an agent branch; CLOSED +
    // MERGED rows must NOT inflate this count.
    assert.equal(result.open_count, 1,
      "riskiestOpenPr.open_count must count only state='open' AND is_agent=1 rows");
  } finally { cleanup(); }
});

test("AC4: spendEfficiencyRanking.projects[*].merged_prs honours only 'MERGED' rows", async () => {
  const { spendEfficiencyRanking } = await import("../src/views.ts");
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "spend");
    const { runner } = mkRunner({
      openRows: [
        ghRow({ number: 1, headRefName: "feat/1", state: "OPEN" }),
      ],
      closedRows: [
        // Both MERGED rows fall inside the spendEfficiencyRanking
        // window (default 14 days) — fetched_at is stamped to "now"
        // by the ingester so the helper's date(fetched_at) filter
        // matches both rows.
        ghRow({ number: 2, headRefName: "feat/2", state: "MERGED",
                closedAt: "2026-06-05T08:00:00Z" }),
        ghRow({ number: 3, headRefName: "feat/3", state: "MERGED",
                closedAt: "2026-06-06T08:00:00Z" }),
        // CLOSED row in the same window — must NOT be counted as merged.
        ghRow({ number: 4, headRefName: "feat/4", state: "CLOSED",
                closedAt: "2026-06-07T08:00:00Z" }),
      ],
    });
    _setPrRunnerForTests(runner);
    try { ingestProjectPRs(db, pid, "owner/spend"); }
    finally { _resetPrRunnerForTests(); }
    const ranking = spendEfficiencyRanking(db, new Date());
    // spendEfficiencyRanking returns rows under `.projects[]`. The
    // CLOSED row must NOT add to the merged count.
    const row = ranking.projects.find((r: { project_slug: string }) => r.project_slug === "spend");
    assert.ok(row, "spend project row must be present in ranking");
    assert.equal((row as { merged_prs: number }).merged_prs, 2,
      "merged_prs must count only state='MERGED' AND is_agent=1, not CLOSED");
  } finally { cleanup(); }
});

test("AC4: stuckPrTaxonomy counts only 'open' rows even with siblings in CLOSED + MERGED", async () => {
  const { stuckPrTaxonomy } = await import("../src/views.ts");
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "stuck");
    const { runner } = mkRunner({
      openRows: [
        ghRow({ number: 1, headRefName: "feat/1", state: "OPEN",
                createdAt: "2026-06-01T08:00:00Z" }),
        ghRow({ number: 2, headRefName: "feat/2", state: "OPEN",
                createdAt: "2026-06-02T08:00:00Z" }),
      ],
      closedRows: [
        ghRow({ number: 3, headRefName: "feat/3", state: "MERGED",
                closedAt: "2026-06-05T08:00:00Z" }),
        ghRow({ number: 4, headRefName: "feat/4", state: "CLOSED",
                closedAt: "2026-06-06T08:00:00Z" }),
      ],
    });
    _setPrRunnerForTests(runner);
    try { ingestProjectPRs(db, pid, "owner/stuck"); }
    finally { _resetPrRunnerForTests(); }
    const taxonomy = stuckPrTaxonomy(db, new Date("2026-06-10T12:00:00Z"));
    // open_count is the cardinality the taxonomy covers. CLOSED +
    // MERGED must NOT inflate this.
    assert.equal(taxonomy.open_count, 2,
      "stuckPrTaxonomy.open_count must count only state='open' AND is_agent=1");
  } finally { cleanup(); }
});

test("AC4: prAutopsies (0047) lights up against the ingester's CLOSED writer + closed_at column", async () => {
  // The 0019 helper (prs_merged_7d) is inlined inside fleetView()
  // off the `run` table — it never touches pr.state. The relevant
  // 0049 regression coverage for the pr.state→reader chain is the
  // 0047 autopsy reader, which is the ONLY existing helper that
  // SELECTs `state='CLOSED' AND closed_at IS NOT NULL`. Before
  // this ticket the producer never wrote 'CLOSED' so the autopsy
  // returned an empty result against real fleet data. AC4 here:
  // assert the autopsy now lights up with the ingester's writer.
  const { prAutopsies } = await import("../src/views.ts");
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "autopsy");
    const { runner } = mkRunner({
      openRows: [
        ghRow({ number: 1, headRefName: "feat/1", state: "OPEN" }),
      ],
      closedRows: [
        ghRow({ number: 2, headRefName: "feat/2", state: "MERGED",
                createdAt: "2026-06-01T08:00:00Z",
                closedAt: "2026-06-05T08:00:00Z" }),
        ghRow({ number: 3, headRefName: "feat/3", state: "CLOSED",
                createdAt: "2026-06-02T08:00:00Z",
                closedAt: "2026-06-06T08:00:00Z" }),
        ghRow({ number: 4, headRefName: "feat/4", state: "CLOSED",
                createdAt: "2026-06-03T08:00:00Z",
                closedAt: "2026-06-07T08:00:00Z" }),
      ],
    });
    _setPrRunnerForTests(runner);
    try { ingestProjectPRs(db, pid, "owner/autopsy"); }
    finally { _resetPrRunnerForTests(); }
    // The autopsy filters by state='CLOSED' AND closed_at IS NOT
    // NULL. We seeded 2 CLOSED rows (and 1 MERGED + 1 open which
    // the autopsy must NOT include).
    const autopsies = prAutopsies(db, new Date("2026-06-10T12:00:00Z"));
    assert.equal(autopsies.total_closes, 2,
      "prAutopsies.total_closes must count exactly the 2 CLOSED rows the ingester wrote");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 secondary: zero new runtime deps stays true.
// ────────────────────────────────────────────────────────────────────

test("AC4: package.json runtime dependencies stays empty (zero-dep contract)", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  const deps = pkg.dependencies || {};
  assert.equal(Object.keys(deps).length, 0,
    "ticket 0049 must not add a runtime dependency");
});
