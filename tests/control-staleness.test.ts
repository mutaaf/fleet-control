// Ticket 0020 — keep-running + eng-toggle must NOT clobber the installed
// manifest when the working tree is stale.
//
// Same root cause that hit set-budget (fixed in PR #42): the action edits
// the working-tree manifest, then `install.sh` cp's it over the installed
// copy. When local main is behind origin/main — which happens easily when
// autonomous agents merge PRs faster than the operator pulls — install.sh
// faithfully copies a stale manifest over a current one, silently
// reverting whatever the operator changed since the local checkout last
// pulled.
//
// The fix routes both actions through the INSTALLED manifest (the one
// launchd actually reads) and mirrors into the working tree best-effort.
// keep-running skips install.sh entirely (SELF_CANCEL is a plain env var
// read by `fleet_self_cancel`). eng-toggle still runs install.sh (the
// eng plist appears/disappears) but passes the installed manifest dir,
// so the cp inside install.sh is a no-op via the `-ef` guard.
//
// Each test maps to one acceptance-criteria checkbox on
// docs/backlog/0020-...md. We use the `_setRunnerForTests` seam to stub
// `bash install.sh` and `launchctl print` — production code paths still
// shell out via execFile + argv array.
//
// Zero new deps; stdlib only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db.ts";
import { doAction, _setRunnerForTests, _resetRunnerForTests } from "../src/control.ts";

interface Call { cmd: string; args: string[]; }

interface Fixture {
  home: string;
  prevHome: string | undefined;
  cwd: string;
  prevCwd: string;
  projectRoot: string;
  installedDir: string;
  workingTreeManifest: string;
  installedManifest: string;
  db: DB;
  calls: Call[];
  cleanup: () => void;
}

const SLUG = "demo";

/** Stale working tree, fresh installed manifest. The working tree's
 *  SHIP_HOURS is the OLD value (the operator hasn't pulled main since
 *  cadence was tightened); the installed copy has the CURRENT value
 *  that launchd actually fires against. Both files carry SELF_CANCEL
 *  and ENG_ENABLED so the regex-targeted edits have something to
 *  rewrite (editManifest errors on a missing key). */
const STALE_WORKING_TREE_MANIFEST = `PROJECT_NAME="Demo"
SLUG="${SLUG}"
NAMESPACE="com.${SLUG}"
SHIP_HOURS="0 12"
SHIP_MINUTE=41
GROOM_HOURS="0 12"
GROOM_MINUTE=17
REVIEW_INTERVAL=300
SELF_CANCEL="20260101"
ENG_ENABLED=0
`;

const CURRENT_INSTALLED_MANIFEST = `PROJECT_NAME="Demo"
SLUG="${SLUG}"
NAMESPACE="com.${SLUG}"
SHIP_HOURS="0 6 12 18"
SHIP_MINUTE=41
GROOM_HOURS="0 12"
GROOM_MINUTE=17
REVIEW_INTERVAL=300
SELF_CANCEL="20260101"
ENG_ENABLED=0
`;

function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "fleet-staleness-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;

  const cwd = mkdtempSync(join(tmpdir(), "fleet-staleness-cwd-"));
  const prevCwd = process.cwd();
  process.chdir(cwd);

  // Working-tree project dir.
  const projectRoot = join(home, "projects");
  const wtDir = join(projectRoot, SLUG);
  mkdirSync(wtDir, { recursive: true });
  const workingTreeManifest = join(wtDir, "agents.config.sh");
  writeFileSync(workingTreeManifest, STALE_WORKING_TREE_MANIFEST);

  // Installed (launchd-readable) project dir.
  const installedDir = join(home, ".local", "share", "agent-fleet", "projects", SLUG);
  mkdirSync(installedDir, { recursive: true });
  const installedManifest = join(installedDir, "agents.config.sh");
  writeFileSync(installedManifest, CURRENT_INSTALLED_MANIFEST);

  // Seed config so loadConfig() picks up the tmpdir as projectRoots[0].
  // FLEET_DB_PATH alone would leak the real fleet via discovery (see
  // LESSONS.md 2026-05-26 "in-process startServer() tests need an
  // empty-roots config"); we use a project-local
  // fleet-control.config.json so manifestDirFor() lands inside the tmpdir.
  writeFileSync(
    join(cwd, "fleet-control.config.json"),
    JSON.stringify({
      projectRoots: [projectRoot],
      installedRoot: join(home, ".local", "share", "agent-fleet", "projects"),
      dbPath: join(home, "fleet.db"),
      cacheBase: join(home, ".cache"),
      claudeProjects: join(home, ".claude", "projects"),
    }),
  );

  const db = openDb(join(home, "fleet.db"));

  // Seed a project row. manifest_path points at the installed file
  // (that's what discovery.ts stores in production after install.sh
  // copies the manifest); the working-tree fallback in
  // manifestDirFor() comes from cfg.projectRoots.
  db.prepare(
    `INSERT INTO project(slug,name,namespace,repo_url,repo_owner,repo_name,manifest_path,first_seen_at,last_seen_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
  ).run(
    SLUG, "Demo", `com.${SLUG}`,
    "https://github.com/example/demo", "example", "demo",
    installedManifest,
    new Date().toISOString(), new Date().toISOString(),
  );

  return {
    home, prevHome, cwd, prevCwd, projectRoot, installedDir,
    workingTreeManifest, installedManifest, db, calls: [],
    cleanup: () => {
      _resetRunnerForTests();
      db.close();
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      process.chdir(prevCwd);
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    },
  };
}

/** Default runner: records every call. `launchctl print` returns an
 *  empty string (no phase is "running") so the running-phases guard
 *  never trips. `bash install.sh` no-ops — we assert via the recorded
 *  argv that we DIDN'T call it (keep-running) or that we DID call it
 *  with the installed dir (eng-toggle). */
function makeRunner(f: Fixture) {
  return (cmd: string, args: string[]): string => {
    f.calls.push({ cmd, args });
    if (cmd === "launchctl") return ""; // no phase is "running"
    if (cmd === "bash") return "";
    return "";
  };
}

test("keep-running: edits the INSTALLED manifest and leaves stale working-tree fields alone", async () => {
  const f = fixture();
  try {
    _setRunnerForTests(makeRunner(f));
    const r = await doAction(f.db, "lan", "keep-running", { slug: SLUG, days: 30 }, "laptop");
    assert.equal(r.ok, true, r.message);

    // Installed manifest: SHIP_HOURS must be UNCHANGED from the current
    // value (NOT reverted to the stale working-tree's "0 12"), and
    // SELF_CANCEL must have been bumped.
    const installedTxt = readFileSync(f.installedManifest, "utf8");
    assert.match(installedTxt, /SHIP_HOURS="0 6 12 18"/,
      "installed SHIP_HOURS must NOT revert to the stale working-tree value");
    assert.doesNotMatch(installedTxt, /SHIP_HOURS="0 12"/,
      "installed SHIP_HOURS must NOT match the stale working-tree value");
    assert.doesNotMatch(installedTxt, /SELF_CANCEL="20260101"/,
      "installed SELF_CANCEL must have been bumped past the seeded value");
    const m = installedTxt.match(/SELF_CANCEL="(\d{8})"/);
    assert.ok(m, "installed SELF_CANCEL must be a YYYYMMDD string");
    assert.ok(Number(m![1]) > 20260101, "installed SELF_CANCEL must be in the future");
  } finally { f.cleanup(); }
});

test("keep-running: skips install.sh entirely (SELF_CANCEL is a plain env var, no plist regen needed)", async () => {
  const f = fixture();
  try {
    _setRunnerForTests(makeRunner(f));
    const r = await doAction(f.db, "lan", "keep-running", { slug: SLUG, days: 30 }, "laptop");
    assert.equal(r.ok, true, r.message);

    const bashCalls = f.calls.filter((c) => c.cmd === "bash");
    assert.equal(bashCalls.length, 0,
      "keep-running must NOT shell out to bash install.sh — that's how staleness clobbered the installed copy");
  } finally { f.cleanup(); }
});

test("keep-running: mirrors SELF_CANCEL into the working tree best-effort so the operator can git-commit it", async () => {
  const f = fixture();
  try {
    _setRunnerForTests(makeRunner(f));
    const r = await doAction(f.db, "lan", "keep-running", { slug: SLUG, days: 30 }, "laptop");
    assert.equal(r.ok, true, r.message);

    // Working-tree manifest's SELF_CANCEL also moves forward — but
    // crucially this is a MIRROR of the installed write, not the source.
    // The stale SHIP_HOURS in the working tree is left untouched (it'll
    // get healed when the operator pulls main).
    const wtTxt = readFileSync(f.workingTreeManifest, "utf8");
    assert.doesNotMatch(wtTxt, /SELF_CANCEL="20260101"/,
      "working-tree SELF_CANCEL should also be bumped (best-effort mirror)");
    assert.match(wtTxt, /SHIP_HOURS="0 12"/,
      "working-tree SHIP_HOURS stays untouched — only main-pull can heal it");
  } finally { f.cleanup(); }
});

test("eng-toggle: edits the INSTALLED manifest and leaves stale working-tree fields alone", async () => {
  const f = fixture();
  try {
    _setRunnerForTests(makeRunner(f));
    const r = await doAction(f.db, "lan", "eng-toggle", { slug: SLUG, enabled: 1 }, "laptop");
    assert.equal(r.ok, true, r.message);

    const installedTxt = readFileSync(f.installedManifest, "utf8");
    assert.match(installedTxt, /SHIP_HOURS="0 6 12 18"/,
      "installed SHIP_HOURS must NOT revert to the stale working-tree value");
    assert.match(installedTxt, /ENG_ENABLED="1"/,
      "installed ENG_ENABLED must have flipped to 1");
  } finally { f.cleanup(); }
});

test("eng-toggle: still calls bash install.sh, but with the INSTALLED manifest dir (cp inside is a no-op via `-ef`)", async () => {
  const f = fixture();
  try {
    _setRunnerForTests(makeRunner(f));
    const r = await doAction(f.db, "lan", "eng-toggle", { slug: SLUG, enabled: 1 }, "laptop");
    assert.equal(r.ok, true, r.message);

    const bashCalls = f.calls.filter((c) => c.cmd === "bash");
    assert.equal(bashCalls.length, 1, "eng-toggle still needs install.sh (eng plist appears/disappears)");
    // The argument passed to install.sh must be the INSTALLED dir, not
    // the working-tree one. That's what makes the cp inside install.sh
    // a no-op (src and dst are the same file → `-ef` short-circuits).
    const installDirArg = bashCalls[0].args[bashCalls[0].args.length - 1];
    assert.equal(installDirArg, f.installedDir,
      "install.sh must be pointed at the installed manifest dir so the cp inside is a no-op");
  } finally { f.cleanup(); }
});

test("eng-toggle: mirrors ENG_ENABLED into the working tree best-effort", async () => {
  const f = fixture();
  try {
    _setRunnerForTests(makeRunner(f));
    const r = await doAction(f.db, "lan", "eng-toggle", { slug: SLUG, enabled: 1 }, "laptop");
    assert.equal(r.ok, true, r.message);

    const wtTxt = readFileSync(f.workingTreeManifest, "utf8");
    assert.match(wtTxt, /ENG_ENABLED="1"/,
      "working-tree ENG_ENABLED should also be flipped (best-effort mirror)");
    assert.match(wtTxt, /SHIP_HOURS="0 12"/,
      "working-tree SHIP_HOURS stays untouched — only main-pull can heal it");
  } finally { f.cleanup(); }
});

test("keep-running: errors loudly when the installed manifest is missing (operator must run install.sh first)", async () => {
  const f = fixture();
  try {
    // Remove the installed manifest to simulate a first-run state.
    rmSync(f.installedManifest);
    assert.equal(existsSync(f.installedManifest), false);

    _setRunnerForTests(makeRunner(f));
    const r = await doAction(f.db, "lan", "keep-running", { slug: SLUG, days: 30 }, "laptop");
    assert.equal(r.ok, false, "must refuse rather than silently fall back to the working tree");
    assert.match(r.message, /installed manifest/i,
      "error message should name the missing installed manifest");
  } finally { f.cleanup(); }
});
