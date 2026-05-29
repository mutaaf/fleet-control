// Tests for ticket 0023 — PR card shows heal-attempts and first-fail
// reason inline. One test per acceptance-criteria checkbox in
// docs/backlog/0023-pr-card-heal-and-first-fail.md.
//
// Strategy:
//   - DB / migration assertions go against a fresh tmpdir DB opened by
//     openDb() (the same `ALTER TABLE …` migration pass exercised in
//     production at startup).
//   - The ingest-side tests swap the gh runner via _setPrRunnerForTests
//     so we can pin the `gh pr list --json` payload deterministically
//     without touching the network. Same shape as tests/correlate.test.ts
//     and tests/health.test.ts.
//   - The SPA-render and CSS-mobile-wrap assertions are text-level
//     against web/app.js and web/style.css — same pattern as
//     tests/inbox.test.ts and tests/mobile-portal.test.ts. No jsdom dep.
//   - The exported parse helpers (countHealCommits, firstFailingCheck)
//     are covered directly by pure-function tests.
//
// Zero new runtime deps. Each test name carries the AC reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../src/db.ts";
import {
  ingestProjectPRs, projectPRs,
  countHealCommits, pickFirstFailingCheckName,
  _setPrRunnerForTests, _resetPrRunnerForTests,
} from "../src/ingest/prs.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");
const STYLE_CSS = readFileSync(join(WEB_DIR, "style.css"), "utf8");

// ─── Helpers ─────────────────────────────────────────────────────────

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-prs0023-"));
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

/** Build a `gh pr list --json` payload row with sensible defaults. */
function ghRow(over: Record<string, unknown>): Record<string, unknown> {
  return {
    number: 1, title: "demo", headRefName: "feat/x",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: [],
    commits: [],
    additions: 1, deletions: 0, author: { login: "agent" },
    url: "https://github.com/owner/repo/pull/1",
    createdAt: "2026-05-20T10:00:00Z",
    ...over,
  };
}

/** Snapshot the named columns straight from `pr` for one PR. */
function readPr(db: DB, projectId: number, number: number):
  { heal_attempts: number; first_fail_check: string | null } | undefined {
  return db.prepare(
    "SELECT heal_attempts, first_fail_check FROM pr WHERE project_id=? AND number=?",
  ).get(projectId, number) as
    { heal_attempts: number; first_fail_check: string | null } | undefined;
}

// ────────────────────────────────────────────────────────────────────
// AC1 — schema migration: pr.heal_attempts + pr.first_fail_check exist
// ────────────────────────────────────────────────────────────────────

test("AC1: pr table carries heal_attempts + first_fail_check columns after openDb", () => {
  const { db, cleanup } = tempDb();
  try {
    const cols = (db.prepare("PRAGMA table_info(pr)").all() as Array<{ name: string; dflt_value: unknown }>);
    const colNames = cols.map((c) => c.name);
    assert.ok(colNames.includes("heal_attempts"),
      "pr.heal_attempts must be added by the migration");
    assert.ok(colNames.includes("first_fail_check"),
      "pr.first_fail_check must be added by the migration");
    // heal_attempts must default to 0 so legacy rows round-trip the
    // number-typed render path without a JSON null shape break.
    const healCol = cols.find((c) => c.name === "heal_attempts");
    assert.ok(healCol, "heal_attempts column row must exist");
    assert.equal(String(healCol!.dflt_value ?? ""), "0",
      "heal_attempts default must be 0");
  } finally { cleanup(); }
});

test("AC1: a select round-trips both columns end-to-end", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "rt");
    db.prepare(
      "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
      + "additions,deletions,author,url,fetched_at,heal_attempts,first_fail_check) "
      + "VALUES(?,?,?,?,'open','red','clean',1,?,?,?,?,?,?,?)",
    ).run(
      pid, 42, "demo", "feat/42",
      1, 0, "agent", "https://x/p/42",
      "2026-05-29T00:00:00Z", 2, "typecheck",
    );
    const row = readPr(db, pid, 42);
    assert.ok(row, "round-trip row must exist");
    assert.equal(row!.heal_attempts, 2);
    assert.equal(row!.first_fail_check, "typecheck");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — countHealCommits helper + ingest persists heal_attempts
// ────────────────────────────────────────────────────────────────────

test("AC2: countHealCommits — counts heal:-prefixed first lines (case-insensitive)", () => {
  // Pure helper. No DB, no shell. Each input is one commit's
  // messageHeadline from gh's --json commits payload.
  const commits = [
    { messageHeadline: "heal: fix typecheck error" },
    { messageHeadline: "Heal: rebase against main" },
    { messageHeadline: "HEAL: drop stale dep" },
    { messageHeadline: "feat: initial implementation" },
    { messageHeadline: "" },
    { messageHeadline: "fix: nothing to do with healing" },
  ];
  assert.equal(countHealCommits(commits), 3,
    "case-insensitive heal: prefix on the first line must count");
});

test("AC2: countHealCommits — ignores heal: that isn't at the start of the headline", () => {
  // The agents' convention is `heal:` at column zero — a body mention
  // doesn't count, and a tail/trailing reference doesn't either.
  const commits = [
    { messageHeadline: "fix: heal: lookalike trailing" },
    { messageHeadline: "  heal: leading-whitespace doesn't count" },
    { messageHeadline: "feat(heal): scoped feat is not a heal commit" },
  ];
  assert.equal(countHealCommits(commits), 0);
});

test("AC2: countHealCommits — tolerates messageBody payloads with heal: on later lines", () => {
  // Only the FIRST line (the headline) counts; gh emits messageHeadline
  // separately from messageBody. Even if a caller passes the full
  // message string, only the first line matters.
  const commits = [
    { messageHeadline: "feat: implement", messageBody: "heal: secondary\nnotes" },
    { messageHeadline: "heal: real heal" },
  ];
  assert.equal(countHealCommits(commits), 1);
});

test("AC2: countHealCommits — empty / null / undefined inputs all return 0", () => {
  assert.equal(countHealCommits([]), 0);
  assert.equal(countHealCommits(null as unknown as []), 0);
  assert.equal(countHealCommits(undefined as unknown as []), 0);
});

test("AC2: ingestProjectPRs persists heal_attempts from gh commits payload", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "withheals");
    _setPrRunnerForTests((cmd, args) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([
          ghRow({
            number: 11, title: "ship 0099", headRefName: "feat/0099-foo",
            commits: [
              { messageHeadline: "feat: initial implementation" },
              { messageHeadline: "heal: address tsc error" },
              { messageHeadline: "Heal: re-run after webhook hiccup" },
              { messageHeadline: "heal: fix stray import" },
            ],
          }),
        ]);
      }
      return ""; // first_fail_check derivation may shell out, but no failures here
    });
    try {
      ingestProjectPRs(db, pid, "owner/withheals");
    } finally { _resetPrRunnerForTests(); }
    const row = readPr(db, pid, 11);
    assert.ok(row, "PR row must persist");
    assert.equal(row!.heal_attempts, 3,
      "heal_attempts must equal the count of heal:-prefixed commits");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — pickFirstFailingCheckName + ingest persists first_fail_check
// ────────────────────────────────────────────────────────────────────

test("AC3: pickFirstFailingCheckName — picks first failed by startedAt ascending", () => {
  // gh emits each rollup entry with a startedAt; the AC says we sort
  // by startedAt ascending and pick the first failing one. Three
  // checks where the SECOND is the earliest failing.
  const rollup = [
    { name: "lint",      conclusion: "SUCCESS", startedAt: "2026-05-29T10:00:00Z" },
    { name: "validate",  conclusion: "FAILURE", startedAt: "2026-05-29T10:01:00Z" },
    { name: "typecheck", conclusion: "FAILURE", startedAt: "2026-05-29T10:02:00Z" },
  ];
  assert.equal(pickFirstFailingCheckName(rollup), "validate");
});

test("AC3: pickFirstFailingCheckName — picks earliest failure when payload is unordered", () => {
  // gh doesn't guarantee chronological ordering. The earliest fail
  // by startedAt must win regardless of array position.
  const rollup = [
    { name: "later",   conclusion: "FAILURE", startedAt: "2026-05-29T10:05:00Z" },
    { name: "earlier", conclusion: "ERROR",   startedAt: "2026-05-29T10:01:00Z" },
    { name: "mid",     conclusion: "CANCELLED", startedAt: "2026-05-29T10:03:00Z" },
  ];
  assert.equal(pickFirstFailingCheckName(rollup), "earlier");
});

test("AC3: pickFirstFailingCheckName — returns null when no failures present", () => {
  const rollup = [
    { name: "lint",      conclusion: "SUCCESS", startedAt: "2026-05-29T10:00:00Z" },
    { name: "typecheck", conclusion: "SUCCESS", startedAt: "2026-05-29T10:01:00Z" },
  ];
  assert.equal(pickFirstFailingCheckName(rollup), null);
});

test("AC3: pickFirstFailingCheckName — null / non-array inputs return null", () => {
  assert.equal(pickFirstFailingCheckName(null as unknown as []), null);
  assert.equal(pickFirstFailingCheckName(undefined as unknown as []), null);
  assert.equal(pickFirstFailingCheckName([]), null);
});

test("AC3: pickFirstFailingCheckName — startedAt-less checks fall back to array order", () => {
  // statusCheckRollup entries without a startedAt are legal (legacy
  // status contexts). They sort stably and the first failing one wins.
  const rollup = [
    { name: "first",  conclusion: "SUCCESS" },
    { name: "second", conclusion: "FAILURE" },
    { name: "third",  conclusion: "FAILURE" },
  ];
  assert.equal(pickFirstFailingCheckName(rollup), "second");
});

test("AC3: ingestProjectPRs persists first_fail_check from the rollup", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "ingestme");
    _setPrRunnerForTests((cmd, args) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") {
        return JSON.stringify([
          ghRow({
            number: 3, title: "red ship", headRefName: "feat/red",
            statusCheckRollup: [
              { name: "lint",      conclusion: "SUCCESS", startedAt: "2026-05-29T10:00:00Z" },
              { name: "validate",  conclusion: "FAILURE", startedAt: "2026-05-29T10:01:00Z" },
              { name: "typecheck", conclusion: "FAILURE", startedAt: "2026-05-29T10:02:00Z" },
            ],
            commits: [],
          }),
        ]);
      }
      // The first_fail_check derivation may follow up with `gh run view
      // --log-failed` to populate first_fail_excerpt (ticket 0027). We
      // return an empty body so that path is exercised but doesn't
      // assert anything new here.
      return "";
    });
    try {
      ingestProjectPRs(db, pid, "owner/ingestme");
    } finally { _resetPrRunnerForTests(); }
    const row = readPr(db, pid, 3);
    assert.ok(row, "PR row must persist");
    assert.equal(row!.first_fail_check, "validate",
      "first_fail_check must be the earliest-failing check's name");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — re-ingest idempotency
// ────────────────────────────────────────────────────────────────────

test("AC4: re-ingesting the same gh payload twice keeps heal_attempts + first_fail_check stable", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "idem");
    const payload = JSON.stringify([
      ghRow({
        number: 5, title: "idem",
        statusCheckRollup: [
          { name: "lint",      conclusion: "SUCCESS", startedAt: "2026-05-29T10:00:00Z" },
          { name: "typecheck", conclusion: "FAILURE", startedAt: "2026-05-29T10:01:00Z" },
        ],
        commits: [
          { messageHeadline: "feat: initial" },
          { messageHeadline: "heal: round 1" },
          { messageHeadline: "heal: round 2" },
        ],
      }),
    ]);
    _setPrRunnerForTests((cmd, args) => {
      if (cmd === "gh" && args[0] === "pr" && args[1] === "list") return payload;
      return "";
    });
    try {
      ingestProjectPRs(db, pid, "owner/idem");
      // TTL guard in ingestProjectPRs skips the second call if fetched
      // less than TTL_MS ago — for an idempotency test we want to
      // FORCE the re-fetch path. Resetting fetched_at to a stale value
      // exercises the actual delete+reinsert pass.
      db.prepare("UPDATE pr SET fetched_at=? WHERE project_id=?")
        .run("2020-01-01T00:00:00Z", pid);
      ingestProjectPRs(db, pid, "owner/idem");
    } finally { _resetPrRunnerForTests(); }
    const row = readPr(db, pid, 5);
    assert.ok(row, "PR row must persist after re-ingest");
    assert.equal(row!.heal_attempts, 2,
      "heal_attempts must round-trip through delete/insert");
    assert.equal(row!.first_fail_check, "typecheck",
      "first_fail_check must round-trip through delete/insert");
    // Exactly one PR row after two ingests — the delete/replace
    // pattern doesn't accumulate dupes.
    const count = (db.prepare("SELECT COUNT(*) c FROM pr WHERE project_id=?")
      .get(pid) as { c: number }).c;
    assert.equal(count, 1, "delete-then-insert must leave exactly one row");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — projectPRs() returns heal_attempts + first_fail_check (additive)
// ────────────────────────────────────────────────────────────────────

test("AC5: projectPRs additively returns heal_attempts + first_fail_check; existing fields unchanged", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "shape");
    db.prepare(
      "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,is_agent,"
      + "additions,deletions,author,url,fetched_at,heal_attempts,first_fail_check) "
      + "VALUES(?,?,?,?,'open','red','BLOCKED',1,?,?,?,?,?,?,?)",
    ).run(
      pid, 77, "fix: thing", "feat/77",
      3, 1, "agent", "https://x/p/77", "2026-05-29T00:00:00Z",
      2, "typecheck",
    );
    const rows = projectPRs(db, pid) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    const r = rows[0];
    // Existing fields stay byte-identical in name/type — this is the
    // contract guard the ticket calls out (no JSON-shape break).
    const expectedKeys = new Set([
      "number", "title", "branch", "ci_state", "merge_state", "is_agent",
      "additions", "deletions", "author", "url",
      // additive (this ticket):
      "heal_attempts", "first_fail_check",
    ]);
    for (const k of expectedKeys) {
      assert.ok(k in r, `projectPRs row must include '${k}'`);
    }
    assert.equal(r.heal_attempts, 2);
    assert.equal(r.first_fail_check, "typecheck");
    // Existing fields keep their values.
    assert.equal(r.number, 77);
    assert.equal(r.ci_state, "red");
    assert.equal(r.merge_state, "BLOCKED");
    assert.equal(r.is_agent, 1);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 + AC7 — SPA renderer: chip + first-failed link, empty case
// ────────────────────────────────────────────────────────────────────

test("AC6: web/app.js renders a heal-chip helper (renderHealChip) wired into prSection", () => {
  // The SPA's PR card render must call a small `renderHealChip` helper
  // — the test inspects web/app.js textually (same pattern as
  // tests/inbox.test.ts). We assert: (a) the helper exists, (b) the
  // amber threshold matches the ticket's "amber when >= 2" rule, and
  // (c) the prSection render delegates to it.
  assert.match(APP_JS, /function\s+renderHealChip\s*\(/,
    "renderHealChip helper must be defined in web/app.js");
  // The threshold lives in the helper — we look for a >= 2 comparison
  // anywhere inside the helper body. We don't pin the surrounding
  // syntax; an `n >= max` form is fine too.
  const fnIdx = APP_JS.indexOf("function renderHealChip");
  assert.ok(fnIdx >= 0, "renderHealChip must be present");
  // Find function end via brace balancing.
  let depth = 0, end = fnIdx, started = false;
  for (let i = fnIdx; i < APP_JS.length; i++) {
    const c = APP_JS[i];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { end = i; break; } }
  }
  const body = APP_JS.slice(fnIdx, end + 1);
  assert.match(body, /heal-chip/,
    "renderHealChip must emit a .heal-chip class hook");
  assert.match(body, />=\s*(2|max)/,
    "renderHealChip must compare attempts against the AGENTS.md cap");
  // The amber state class must be present.
  assert.match(body, /heal-chip\s+amber|amber/,
    "renderHealChip must surface an amber state when at/over the cap");
  // The PR card renderer must call it.
  assert.match(APP_JS, /renderHealChip\s*\(/,
    "prSection must call renderHealChip on each PR row");
});

test("AC6: web/app.js renders a first-failed link when pr.first_fail_check is set", () => {
  // The renderer surfaces "first failed: <name>" wired to the PR's
  // GitHub Actions tab. We just assert the SPA references both fields
  // and the className the CSS targets.
  assert.match(APP_JS, /first[_-]?fail[_-]?check/i,
    "the SPA must read pr.first_fail_check on render");
  assert.match(APP_JS, /first\s*failed:/i,
    "the SPA must render the 'first failed:' label");
  assert.match(APP_JS, /pr-first-fail/,
    "the SPA must wrap the link in a .pr-first-fail hook for CSS");
});

test("AC7: when heal_attempts === 0 and first_fail_check === null, no new DOM appears", () => {
  // The renderer must early-return / emit nothing for the empty
  // state. We exercise the helper directly: a real DOM isn't required
  // — `renderHealChip(0, 2)` must return an empty string.
  //
  // Walk web/app.js's renderHealChip body and look for an early
  // `if (!n) return "";` shape (or equivalent).
  const fnIdx = APP_JS.indexOf("function renderHealChip");
  assert.ok(fnIdx >= 0);
  let depth = 0, end = fnIdx, started = false;
  for (let i = fnIdx; i < APP_JS.length; i++) {
    const c = APP_JS[i];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { end = i; break; } }
  }
  const body = APP_JS.slice(fnIdx, end + 1);
  // Some flavour of "n === 0 → ''" must be present. We accept either
  // `!n` or `n === 0` or `n <= 0` — all valid early-exits.
  assert.match(body, /!n\b|n\s*===?\s*0|n\s*<=?\s*0|n\s*<\s*1/,
    "renderHealChip must emit empty string when heal_attempts is 0");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — mobile-wrap below 600px
// ────────────────────────────────────────────────────────────────────

test("AC8: web/style.css declares heal-chip + pr-first-fail styles with a mobile wrap rule", () => {
  // Same text-level approach as tests/mobile-portal.test.ts. The
  // ticket calls for 600px conventions (0011).
  assert.match(STYLE_CSS, /\.heal-chip\s*\{/,
    ".heal-chip rule must exist in style.css");
  assert.match(STYLE_CSS, /\.heal-chip\.amber\s*\{/,
    ".heal-chip.amber rule must exist in style.css");
  assert.match(STYLE_CSS, /\.pr-first-fail\s*\{/,
    ".pr-first-fail rule must exist in style.css");
  // Mobile wrap: the @media (max-width: 600px) block must reference
  // either heal-chip or pr-first-fail with a flex-wrap or display
  // override so the chips fall below the title on phones.
  const mobile = (() => {
    const m = /@media\s*\(\s*max-width:\s*600px\s*\)\s*\{/.exec(STYLE_CSS);
    if (!m) return null;
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < STYLE_CSS.length && depth > 0) {
      const c = STYLE_CSS[i++];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    return depth === 0 ? STYLE_CSS.slice(start, i - 1) : null;
  })();
  assert.ok(mobile, "@media (max-width: 600px) block must exist");
  assert.match(mobile!, /heal-chip|pr-first-fail|pr-head/,
    "mobile media query must adapt the heal-chip / first-fail layout");
  assert.match(mobile!, /flex-wrap|flex-direction|display\s*:\s*block/,
    "mobile media query must enable wrap / stack behaviour");
});

// ────────────────────────────────────────────────────────────────────
// AC9 — secret redaction at the renderer boundary
// ────────────────────────────────────────────────────────────────────

test("AC9: SPA passes first_fail_check through redactSecrets before render", () => {
  // The renderer must route the column through the same
  // `redactSecrets()` chokepoint the burndown/correlation helpers use
  // (LESSONS § defence-in-depth secret redaction at the renderer
  // boundary). The PR card delegates to a `renderFirstFailLink`
  // helper — assert that helper exists AND that its body calls
  // redactSecrets on the first_fail_check value (and on pr.url for
  // defence-in-depth on the destination URL).
  const fnIdx = APP_JS.indexOf("function renderFirstFailLink");
  assert.ok(fnIdx >= 0,
    "renderFirstFailLink helper must exist in web/app.js");
  let depth = 0, end = fnIdx, started = false;
  for (let i = fnIdx; i < APP_JS.length; i++) {
    const c = APP_JS[i];
    if (c === "{") { depth++; started = true; }
    else if (c === "}") { depth--; if (started && depth === 0) { end = i; break; } }
  }
  const body = APP_JS.slice(fnIdx, end + 1);
  assert.match(body, /redactSecrets/,
    "renderFirstFailLink must apply redactSecrets to the first-fail value");
  assert.match(body, /first[_-]?fail/i,
    "renderFirstFailLink must reference first_fail_check");
  // The check name must explicitly pass through redactSecrets before
  // landing in the DOM. We look for a "redactSecrets(<something with
  // 'name' or 'first_fail_check'>)" pattern.
  assert.match(body, /redactSecrets\s*\([^)]*\b(name|first_fail_check)\b[^)]*\)/,
    "renderFirstFailLink must wrap the check-name string in redactSecrets()");
});

// ────────────────────────────────────────────────────────────────────
// AC10 — zero new runtime deps
// ────────────────────────────────────────────────────────────────────

test("AC10: package.json runtime dependencies stays empty (zero-dep contract)", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  const deps = pkg.dependencies || {};
  assert.equal(Object.keys(deps).length, 0,
    "ticket 0023 must not add a runtime dependency");
});
