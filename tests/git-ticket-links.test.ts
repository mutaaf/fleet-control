// Tests for ticket 0018 — Backlog-ticket → merged-commit auto-link via
// git log. One test per acceptance-criteria checkbox in
// docs/backlog/0018-backlog-ticket-commit-autolink.md.
//
// Strategy mirrors tests/correlate.test.ts and tests/inbox.test.ts:
//   - The git shell-out goes through the new runner seam (`_setRunnerForTests`)
//     so we can pin canned `git log` output deterministically and assert the
//     exact argv passed to `git`. Per docs/LESSONS.md § "shell-out modules
//     need an injectable runner".
//   - Schema migration + helper round-trips run against a tmpdir DB.
//   - Route-level AC6 boots `startServer()` in-process with an empty-roots
//     config + `FLEET_DB_PATH` env override per docs/LESSONS.md § "in-process
//     startServer() tests need an empty-roots config + run-row seeds".
//   - SPA assertion (AC7) is text-level against web/app.js — no jsdom.
//
// Zero new runtime deps.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync,
  unlinkSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../src/db.ts";
import {
  scanTicketLinks, _setRunnerForTests, _resetRunnerForTests,
  runTicketLinkHook,
} from "../src/ingest/git_ticket_links.ts";
import { ticketShipReport } from "../src/views.ts";
import { startServer } from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const APP_JS = readFileSync(join(WEB_DIR, "app.js"), "utf8");

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-tickelinks-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function seedProject(db: DB, slug: string, name?: string): number {
  db.prepare(
    "INSERT INTO project(slug, name, namespace) VALUES (?,?,?)",
  ).run(slug, name ?? slug, "test");
  return (db.prepare("SELECT id FROM project WHERE slug=?").get(slug) as { id: number }).id;
}

/** Canonical `git log` payload shape the helper expects. Each commit is
 *  emitted as: a header line "SHA|ISO|AUTHOR|SUBJECT" followed by the
 *  raw --shortstat line. We pin the format here so the parser's regex
 *  has a stable contract to read. */
const RECORD_SEP = "";
function gitOut(records: Array<{
  sha: string; date: string; author: string; subject: string;
  filesChanged?: number; insertions?: number; deletions?: number;
}>): string {
  return records.map((r) => {
    const header = [r.sha, r.date, r.author, r.subject].join("|");
    const stat = [
      r.filesChanged != null ? `${r.filesChanged} file${r.filesChanged === 1 ? "" : "s"} changed` : null,
      r.insertions != null ? `${r.insertions} insertion${r.insertions === 1 ? "" : "s"}(+)` : null,
      r.deletions != null ? `${r.deletions} deletion${r.deletions === 1 ? "" : "s"}(-)` : null,
    ].filter(Boolean).join(", ");
    return `${header}\n ${stat}\n`;
  }).join(RECORD_SEP);
}

// ────────────────────────────────────────────────────────────────────
// AC1 — scanTicketLinks parses git log output via the runner seam.
// ────────────────────────────────────────────────────────────────────

test("AC1: scanTicketLinks parses --shortstat output and extracts the 4-digit ticket id from subjects", () => {
  let capturedCmd: string | null = null;
  let capturedArgs: readonly string[] | null = null;
  _setRunnerForTests((cmd, args) => {
    capturedCmd = cmd;
    capturedArgs = args;
    return gitOut([
      {
        sha: "aaaaaaaaaaaa1111", date: "2026-05-29T10:00:00Z",
        author: "Alice", subject: "feat(0014): cross-project leaderboard (#11)",
        filesChanged: 8, insertions: 312, deletions: 47,
      },
      {
        sha: "bbbbbbbbbbbb2222", date: "2026-05-29T11:00:00Z",
        author: "Bob", subject: "chore/gtm-0014 follow up tweak",
        filesChanged: 1, insertions: 3, deletions: 1,
      },
      {
        sha: "cccccccccccc3333", date: "2026-05-29T12:00:00Z",
        author: "Carol", subject: "fix typo (no ticket)",
        filesChanged: 1, insertions: 1, deletions: 1,
      },
    ]);
  });
  try {
    const rows = scanTicketLinks("/tmp/some/repo", "v0.1.0");
    assert.equal(capturedCmd, "git", "must shell out via git");
    assert.ok(capturedArgs && capturedArgs.includes("-C"),
      "git argv must include -C for cwd-safe execution");
    assert.ok(capturedArgs && capturedArgs.includes("/tmp/some/repo"),
      "repo path must be passed as -C arg, not composed into a shell string");
    assert.ok(capturedArgs && capturedArgs.includes("log"),
      "git argv must include the log subcommand");
    assert.ok(capturedArgs && capturedArgs.some((a) => a === "--shortstat"),
      "git argv must include --shortstat");
    // Three commits in, two carry a ticket id → two rows expected.
    assert.equal(rows.length, 2, "only commits with a 4-digit ticket id produce rows");
    assert.deepEqual(rows.map((r) => r.ticket_id).sort(), ["0014", "0014"]);
    const a = rows.find((r) => r.commit_sha === "aaaaaaaaaaaa1111");
    assert.ok(a, "first matching commit must be returned");
    assert.equal(a!.ticket_id, "0014");
    assert.equal(a!.author, "Alice");
    assert.equal(a!.files_changed, 8);
    assert.equal(a!.insertions, 312);
    assert.equal(a!.deletions, 47);
    assert.equal(a!.message_subject, "feat(0014): cross-project leaderboard (#11)");
  } finally { _resetRunnerForTests(); }
});

test("AC1: scanTicketLinks tolerates malformed shortstat lines (missing insertions/deletions)", () => {
  _setRunnerForTests(() => gitOut([
    // A pure rename/move commit shows only "X files changed" with no
    // insertion or deletion clause — common with git mv. Helper must
    // default the missing counters to 0 rather than throw.
    { sha: "1111111111111111", date: "2026-05-29T13:00:00Z",
      author: "Dave", subject: "chore(0018): rename module",
      filesChanged: 2 },
  ]));
  try {
    const rows = scanTicketLinks("/tmp/r", "HEAD~1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ticket_id, "0018");
    assert.equal(rows[0].files_changed, 2);
    assert.equal(rows[0].insertions, 0,
      "missing insertion clause must default to 0, not throw");
    assert.equal(rows[0].deletions, 0,
      "missing deletion clause must default to 0, not throw");
  } finally { _resetRunnerForTests(); }
});

test("AC1: scanTicketLinks returns [] when git log emits no commits", () => {
  _setRunnerForTests(() => "");
  try {
    const rows = scanTicketLinks("/tmp/r", "v0.0.0");
    assert.deepEqual(rows, []);
  } finally { _resetRunnerForTests(); }
});

test("AC1: a subject body with multiple 4-digit matches takes the FIRST one", () => {
  _setRunnerForTests(() => gitOut([
    // The merge subject mentions ticket 0018 and a PR #1234 — only the
    // first \b\d{4}\b match (0018) becomes the ticket_id. Otherwise a
    // commit closing 0018 that happens to reference PR #1234 would
    // wrongly link to ticket 1234.
    { sha: "deadbeefcafebabe", date: "2026-05-29T14:00:00Z",
      author: "Eve", subject: "feat/0018 implement autolink (closes #1234)",
      filesChanged: 4, insertions: 100, deletions: 5 },
  ]));
  try {
    const rows = scanTicketLinks("/tmp/r", "HEAD~1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ticket_id, "0018",
      "the first 4-digit match wins so PR numbers don't masquerade as ticket ids");
  } finally { _resetRunnerForTests(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — schema migration: ticket_commit_link table is idempotent on
// re-insert (PK collision = no duplicate row).
// ────────────────────────────────────────────────────────────────────

test("AC2: ticket_commit_link table is created by openDb and inserts are idempotent", () => {
  const { db, cleanup } = tempDb();
  try {
    const cols = (db.prepare("PRAGMA table_info(ticket_commit_link)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    for (const expected of [
      "ticket_id", "project_slug", "commit_sha", "commit_date",
      "author", "message_subject", "files_changed", "insertions", "deletions",
      "pr_number",
    ]) {
      assert.ok(cols.includes(expected),
        `ticket_commit_link.${expected} must be present`);
    }
    const ins = db.prepare(
      "INSERT OR IGNORE INTO ticket_commit_link("
      + "ticket_id, project_slug, commit_sha, commit_date, author,"
      + " message_subject, files_changed, insertions, deletions, pr_number)"
      + " VALUES(?,?,?,?,?,?,?,?,?,?)",
    );
    ins.run("0018", "fleet-control", "abc123", "2026-05-29T10:00:00Z",
      "A", "feat(0018): land", 5, 100, 10, 42);
    ins.run("0018", "fleet-control", "abc123", "2026-05-29T10:00:00Z",
      "A", "feat(0018): land", 5, 100, 10, 42);
    const cnt = db.prepare(
      "SELECT COUNT(*) AS n FROM ticket_commit_link WHERE commit_sha='abc123' AND ticket_id='0018'",
    ).get() as { n: number };
    assert.equal(cnt.n, 1,
      "re-insert with the same PK must be a no-op, not produce a duplicate row");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — daemon hook: runTicketLinkHook scans a project's repo from the
// last-known commit_date forward and inserts every new row.
// ────────────────────────────────────────────────────────────────────

test("AC3: runTicketLinkHook inserts one row per new commit and groups by ticket id", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "demo");
    _setRunnerForTests((cmd, args) => {
      assert.equal(cmd, "git");
      // First-ever run: sinceRef is empty → helper still calls git log
      // (HEAD only, no .. range). Either way the runner just returns
      // the canned three-commit fixture.
      return gitOut([
        { sha: "0001aaaa00000001", date: "2026-05-29T10:00:00Z",
          author: "A", subject: "feat(0014): leaderboard",
          filesChanged: 3, insertions: 80, deletions: 5 },
        { sha: "0002bbbb00000002", date: "2026-05-29T11:00:00Z",
          author: "B", subject: "feat(0014): leaderboard polish",
          filesChanged: 1, insertions: 5, deletions: 2 },
        { sha: "0003cccc00000003", date: "2026-05-29T12:00:00Z",
          author: "C", subject: "feat(0015): badge route",
          filesChanged: 4, insertions: 100, deletions: 10 },
      ]);
    });
    try {
      runTicketLinkHook(db, pid, "demo", "/tmp/fake/repo");
    } finally { _resetRunnerForTests(); }
    const rows = db.prepare(
      "SELECT ticket_id, commit_sha FROM ticket_commit_link WHERE project_slug=? ORDER BY commit_date",
    ).all("demo") as Array<{ ticket_id: string; commit_sha: string }>;
    assert.equal(rows.length, 3, "three new commits → three new rows");
    const byTicket = new Map<string, string[]>();
    for (const r of rows) {
      const list = byTicket.get(r.ticket_id) ?? [];
      list.push(r.commit_sha);
      byTicket.set(r.ticket_id, list);
    }
    assert.equal(byTicket.get("0014")?.length, 2,
      "two commits on ticket 0014");
    assert.equal(byTicket.get("0015")?.length, 1,
      "one commit on ticket 0015");
  } finally { cleanup(); }
});

test("AC3: runTicketLinkHook is idempotent across two calls with no new commits", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "demo");
    _setRunnerForTests(() => gitOut([
      { sha: "abcabcabcabcabcabc", date: "2026-05-29T10:00:00Z",
        author: "A", subject: "feat(0018): autolink",
        filesChanged: 5, insertions: 200, deletions: 30 },
    ]));
    try {
      runTicketLinkHook(db, pid, "demo", "/tmp/fake/repo");
      runTicketLinkHook(db, pid, "demo", "/tmp/fake/repo");
    } finally { _resetRunnerForTests(); }
    const cnt = db.prepare(
      "SELECT COUNT(*) AS n FROM ticket_commit_link WHERE commit_sha='abcabcabcabcabcabc'",
    ).get() as { n: number };
    assert.equal(cnt.n, 1,
      "two hook runs against the same commit must not duplicate the row");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — PR-number enrichment: when an inserted commit's SHA matches a
// pr row's branch head, pr_number is populated.
// ────────────────────────────────────────────────────────────────────

test("AC4: runTicketLinkHook populates pr_number from the pr table when branches match", () => {
  const { db, cleanup } = tempDb();
  try {
    const pid = seedProject(db, "demo");
    // Seed a PR row whose branch is "feat/0018-x" — the subject's
    // ticket id matches and we expect the join to pick it up by
    // matching the ticket id INSIDE the branch name (the SHA isn't
    // recorded on the pr row, so we link by ticket id within the
    // pr's branch field).
    db.prepare(
      "INSERT INTO pr(project_id,number,title,branch,state,ci_state,merge_state,"
      + "is_agent,additions,deletions,author,url,fetched_at) "
      + "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(pid, 77, "feat/0018 land it", "feat/0018-autolink",
          "open", "green", "clean", 1, 200, 30, "agent",
          "https://example/p/77", "2026-05-29T09:00:00Z");
    _setRunnerForTests(() => gitOut([
      { sha: "deadbeefcafebabed00d", date: "2026-05-29T10:00:00Z",
        author: "A", subject: "feat(0018): land autolink (#77)",
        filesChanged: 5, insertions: 200, deletions: 30 },
    ]));
    try {
      runTicketLinkHook(db, pid, "demo", "/tmp/fake/repo");
    } finally { _resetRunnerForTests(); }
    const row = db.prepare(
      "SELECT pr_number FROM ticket_commit_link WHERE commit_sha='deadbeefcafebabed00d'",
    ).get() as { pr_number: number | null } | undefined;
    assert.ok(row, "the inserted row must exist");
    assert.equal(row!.pr_number, 77,
      "pr_number must be populated from the matching pr row's number");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — ticketShipReport aggregates commits for a given ticket id.
// ────────────────────────────────────────────────────────────────────

test("AC5: ticketShipReport aggregates per-ticket commits with totals + extreme dates", () => {
  const { db, cleanup } = tempDb();
  try {
    seedProject(db, "demo");
    const ins = db.prepare(
      "INSERT OR IGNORE INTO ticket_commit_link("
      + "ticket_id, project_slug, commit_sha, commit_date, author,"
      + " message_subject, files_changed, insertions, deletions, pr_number)"
      + " VALUES(?,?,?,?,?,?,?,?,?,?)",
    );
    ins.run("0018", "demo", "sha1", "2026-05-29T10:00:00Z", "A",
      "feat(0018): part 1", 3, 100, 10, 99);
    ins.run("0018", "demo", "sha2", "2026-05-29T11:00:00Z", "B",
      "feat(0018): part 2", 2, 80, 5, 99);
    ins.run("0018", "demo", "sha3", "2026-05-29T12:00:00Z", "C",
      "feat(0018): part 3", 4, 132, 32, 99);

    const rep = ticketShipReport(db, "0018");
    assert.ok(rep, "shipped ticket with 3 linked commits → non-null report");
    assert.equal(rep!.commits.length, 3);
    assert.equal(rep!.total_insertions, 312,
      "100 + 80 + 132 = 312");
    assert.equal(rep!.total_deletions, 47,
      "10 + 5 + 32 = 47");
    assert.equal(rep!.total_files_changed, 9,
      "3 + 2 + 4 = 9");
    assert.equal(rep!.pr_number, 99, "shared pr_number bubbles up");
    assert.equal(rep!.first_commit_date, "2026-05-29T10:00:00Z");
    assert.equal(rep!.last_commit_date, "2026-05-29T12:00:00Z");
  } finally { cleanup(); }
});

test("AC5: ticketShipReport returns null when no commits link to the ticket", () => {
  const { db, cleanup } = tempDb();
  try {
    const rep = ticketShipReport(db, "9999");
    assert.equal(rep, null,
      "no linked commits → null so the route can 404 cleanly");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — GET /api/backlog/:id/ship-report — read-scope; 404 on no links.
// ────────────────────────────────────────────────────────────────────

let activeBoots = 0;
let savedConfigText: string | null = null;
const CONFIG_PATH = join(process.cwd(), "fleet-control.config.json");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    import("node:net").then((net) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const a = srv.address();
        if (a && typeof a === "object") {
          const p = a.port;
          srv.close(() => resolve(p));
        } else { srv.close(); reject(new Error("no port")); }
      });
      srv.on("error", reject);
    }).catch(reject);
  });
}

interface Booted {
  base: string;
  close: () => Promise<void>;
  cleanup: () => void;
  dbPath: string;
}

async function boot(seed?: (db: DB) => void): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-ticketlinks-route-"));
  const dbPath = join(dir, "fleet.db");
  if (activeBoots === 0) {
    savedConfigText = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null;
  }
  activeBoots += 1;
  const emptyRoots = join(dir, "empty");
  mkdirSync(emptyRoots, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify({
    projectRoots: [emptyRoots],
    installedRoot: emptyRoots,
    cacheBase: emptyRoots,
    claudeProjects: emptyRoots,
  }));
  process.env.FLEET_DB_PATH = dbPath;
  if (seed) {
    const db = openDb(dbPath);
    try { seed(db); } finally { db.close(); }
  }
  const port = await freePort();
  const server = startServer("127.0.0.1", port);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base + "/api/whoami");
      if (r.ok) break;
    } catch { /* not up yet */ }
    await new Promise((rs) => setTimeout(rs, 20));
  }
  return {
    base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    cleanup: () => {
      delete process.env.FLEET_DB_PATH;
      activeBoots -= 1;
      if (activeBoots === 0) {
        if (savedConfigText === null) {
          try { unlinkSync(CONFIG_PATH); } catch { /* gone already */ }
        } else {
          writeFileSync(CONFIG_PATH, savedConfigText);
        }
        savedConfigText = null;
      }
      rmSync(dir, { recursive: true, force: true });
    },
    dbPath,
  };
}

test("AC6: GET /api/backlog/:id/ship-report returns the shape for shipped tickets and 404s for unshipped", async () => {
  const b = await boot((db) => {
    seedProject(db, "demo");
    const ins = db.prepare(
      "INSERT OR IGNORE INTO ticket_commit_link("
      + "ticket_id, project_slug, commit_sha, commit_date, author,"
      + " message_subject, files_changed, insertions, deletions, pr_number)"
      + " VALUES(?,?,?,?,?,?,?,?,?,?)",
    );
    ins.run("0018", "demo", "sha-route-1", "2026-05-29T10:00:00Z", "A",
      "feat(0018): one", 3, 100, 10, 88);
    ins.run("0018", "demo", "sha-route-2", "2026-05-29T11:00:00Z", "B",
      "feat(0018): two", 5, 200, 40, 88);
  });
  try {
    const rOk = await fetch(b.base + "/api/backlog/0018/ship-report");
    assert.equal(rOk.status, 200, "shipped ticket → 200");
    const body = await rOk.json() as {
      commits: Array<{ commit_sha: string }>;
      pr_number: number | null;
      total_insertions: number;
      total_deletions: number;
    };
    assert.equal(body.commits.length, 2);
    assert.equal(body.pr_number, 88);
    assert.equal(body.total_insertions, 300);
    assert.equal(body.total_deletions, 50);

    const r404 = await fetch(b.base + "/api/backlog/9999/ship-report");
    assert.equal(r404.status, 404,
      "unknown ticket id → 404 (route helper returns null)");
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — SPA: ticket detail page renders "Shipped as" only for shipped
// tickets. We assert at the source level: the renderer is wired and
// fetches the new endpoint.
// ────────────────────────────────────────────────────────────────────

test("AC7: web/app.js wires a Shipped-as renderer fetching /api/backlog/:id/ship-report", () => {
  assert.match(APP_JS, /Shipped as/i,
    "the SPA must carry a 'Shipped as' heading literal");
  assert.ok(APP_JS.includes("/api/backlog/")
    && APP_JS.includes("/ship-report"),
    "the SPA must fetch the new ship-report endpoint");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — `repoPath` is validated against /^[\w./-]+$/ before being
// passed to git. Shell metacharacters cause the helper to throw
// before any exec is attempted.
// ────────────────────────────────────────────────────────────────────

test("AC8: scanTicketLinks throws BEFORE invoking the runner when repoPath carries shell-meta", () => {
  let runnerWasCalled = false;
  _setRunnerForTests(() => { runnerWasCalled = true; return ""; });
  try {
    assert.throws(
      () => scanTicketLinks("/tmp/r;rm -rf /", "HEAD~1"),
      /invalid|repo|path/i,
      "a path with ';' must throw a validation error",
    );
    assert.throws(
      () => scanTicketLinks("/tmp/$(whoami)/x", "HEAD~1"),
      /invalid|repo|path/i,
      "a path with '$(...)' must throw a validation error",
    );
    assert.equal(runnerWasCalled, false,
      "the validator must reject BEFORE the runner ever fires");
  } finally { _resetRunnerForTests(); }
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Hard NOs: no shell-string exec import, zero new runtime deps.
// ────────────────────────────────────────────────────────────────────

test("AC9: src/ingest/git_ticket_links.ts imports execFile only (no exec / execSync shell-string surface)", () => {
  const src = readFileSync(
    join(__dirname, "..", "src", "ingest", "git_ticket_links.ts"),
    "utf8",
  );
  // Per LESSONS § "no shell-string exec static checks should grep the
  // import, not the call site" — the import is the single chokepoint
  // where a shell-string variant could enter.
  const importMatch = src.match(/from\s+["']node:child_process["']/);
  assert.ok(importMatch, "the module must import from node:child_process");
  // Grab the line that does the import + check it only pulls execFile.
  const importLine = src.split("\n").find((l) => l.includes("node:child_process")) ?? "";
  assert.ok(/execFile/.test(importLine),
    "the import must include execFile");
  assert.ok(!/\bexec\b(?!File)/.test(importLine),
    "the import must NOT pull the shell-string exec / execSync surface");
});

test("AC9: package.json keeps dependencies empty (zero runtime deps)", () => {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    "ticket 0018 must not add any runtime dependency");
});
