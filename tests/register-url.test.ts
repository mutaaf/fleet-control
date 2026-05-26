// Unit tests for the `register-url` control action (ticket 0010).
//
// Each test maps to an acceptance-criteria checkbox in
// docs/backlog/0010-github-url-import.md. The runner seam
// `_setRunnerForTests` lets us substitute the execFileSync layer so we
// never spawn a real `gh` or `git clone` — the test asserts the exact
// argv that `register-url` *would* pass, and emulates the filesystem
// effects of `git clone` (a fixture .git dir + remote config + any
// kit-shaped files the action needs to scaffold over).
//
// Hard constraints we're enforcing here:
//   - the regex check on `repo_url` happens BEFORE any child process
//     (so a `;rm -rf /` payload never reaches a shell layer);
//   - slug collisions are rejected after the existing-project lookup;
//   - a partial `<projectRoots[0]>/<slug>` is removed on mid-flow
//     failure via the safe-rm helper landed in 0006;
//   - the control_audit row records `repo_url` + `slug` only.
//
// Zero new deps; stdlib only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db.ts";
import { doAction, _setRunnerForTests, _resetRunnerForTests } from "../src/control.ts";

interface Runner {
  (cmd: string, args: string[]): string;
}
interface Call { cmd: string; args: string[]; }

interface Fixture {
  home: string;
  prevHome: string | undefined;
  cwd: string;
  prevCwd: string;
  projectRoot: string;
  db: DB;
  calls: Call[];
  cleanup: () => void;
}

/** Build an isolated $HOME + cwd + projectRoots config so the action's
 *  filesystem reads happen entirely inside a tmpdir. We write a
 *  fleet-control.config.json next to a fake cwd so loadConfig() picks up
 *  the override; the projectRoots[0] is where the action will clone into. */
function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "fleet-regurl-home-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;

  const cwd = mkdtempSync(join(tmpdir(), "fleet-regurl-cwd-"));
  const prevCwd = process.cwd();
  process.chdir(cwd);

  const projectRoot = join(home, "projects");
  mkdirSync(projectRoot, { recursive: true });

  // Seed the config so projectRoots[0] points at our tmpdir.
  writeFileSync(
    join(cwd, "fleet-control.config.json"),
    JSON.stringify({ projectRoots: [projectRoot], dbPath: join(home, "fleet.db") }),
  );

  const db = openDb(join(home, "fleet.db"));

  return {
    home, prevHome, cwd, prevCwd, projectRoot, db, calls: [],
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

/** Default runner: records every call. For `git clone` it writes a tiny
 *  fake .git dir at the destination so the downstream registerProject()
 *  recognises it as a repo. For `bash install.sh` it no-ops. For `gh
 *  repo view` it returns valid JSON. */
function makeHappyRunner(f: Fixture): Runner {
  return (cmd: string, args: string[]): string => {
    f.calls.push({ cmd, args });
    if (cmd === "git" && args[0] === "clone") {
      const dest = args[args.length - 1];
      mkdirSync(join(dest, ".git"), { recursive: true });
      // Minimal git config so registerProject() can read a remote URL.
      const url = args[args.length - 2];
      writeFileSync(
        join(dest, ".git", "config"),
        `[remote "origin"]\n\turl = ${url}\n`,
      );
      return "";
    }
    if (cmd === "gh" && args[0] === "repo" && args[1] === "view") {
      return JSON.stringify({ name: args[2].split("/")[1] });
    }
    if (cmd === "bash") return ""; // install.sh — no-op in tests
    return "";
  };
}

test("register-url: shell-meta in URL is rejected BEFORE any child process spawns", async () => {
  const f = fixture();
  try {
    let spawned = 0;
    _setRunnerForTests((cmd, args) => { spawned++; return ""; });
    const r = await doAction(f.db, "lan", "register-url", {
      repo_url: "https://github.com/foo;rm -rf /",
    }, "laptop");
    assert.equal(r.ok, false, "shell-meta URL must be rejected");
    assert.match(r.message, /bad[_ ]url/i);
    assert.equal(spawned, 0, "no child process should spawn for a malformed URL");
  } finally { f.cleanup(); }
});

test("register-url: rejects URLs that aren't https://github.com/<owner>/<name>", async () => {
  const f = fixture();
  try {
    let spawned = 0;
    _setRunnerForTests((cmd, args) => { spawned++; return ""; });
    for (const bad of [
      "git@github.com:foo/bar.git",         // SSH out of scope
      "https://gitlab.com/foo/bar",         // wrong host
      "https://github.com/foo",             // missing repo segment
      "http://github.com/foo/bar",          // http not https
      "https://github.com/foo/bar?token=x", // query string smuggled in
      "https://github.com/foo/bar/extra",   // too many segments
      "",                                   // empty
    ]) {
      const r = await doAction(f.db, "lan", "register-url", { repo_url: bad }, "laptop");
      assert.equal(r.ok, false, `should reject ${JSON.stringify(bad)}`);
      assert.match(r.message, /bad[_ ]url/i);
    }
    assert.equal(spawned, 0, "no shell-out for any malformed URL");
  } finally { f.cleanup(); }
});

test("register-url: happy path — runs `gh repo view` then `git clone`, scaffolds files", async () => {
  const f = fixture();
  try {
    _setRunnerForTests(makeHappyRunner(f));
    const r = await doAction(f.db, "lan", "register-url", {
      repo_url: "https://github.com/example/widget",
    }, "laptop");
    assert.equal(r.ok, true, r.message);

    // gh repo view must be called with exactly ["repo","view","example/widget","--json","name"].
    const gh = f.calls.find((c) => c.cmd === "gh");
    assert.ok(gh, "gh repo view must be called");
    assert.deepEqual(gh!.args, ["repo", "view", "example/widget", "--json", "name"]);

    // git clone must be called with --depth=50 and the exact dest path.
    const dest = join(f.projectRoot, "widget");
    const git = f.calls.find((c) => c.cmd === "git" && c.args[0] === "clone");
    assert.ok(git, "git clone must be called");
    assert.deepEqual(git!.args, ["clone", "--depth=50", "https://github.com/example/widget", dest]);

    // Post-clone scaffold (delegated to registerProject) leaves these files.
    assert.equal(existsSync(join(dest, "agents.config.sh")), true, "manifest must be scaffolded");
    assert.equal(existsSync(join(dest, "AGENTS.md")), true, "AGENTS.md must exist");
    const agentsTxt = readFileSync(join(dest, "AGENTS.md"), "utf8");
    assert.match(agentsTxt, /Agent parameters/, "AGENTS.md must carry the Agent parameters section");
    assert.equal(existsSync(join(dest, "docs", "backlog", "README.md")), true, "backlog README must exist");
    assert.equal(existsSync(join(dest, "docs", "backlog", "_template.md")), true, "backlog template must exist");
  } finally { f.cleanup(); }
});

test("register-url: default slug = URL repo name lowercased; collision rejected on second call", async () => {
  const f = fixture();
  try {
    _setRunnerForTests(makeHappyRunner(f));
    const first = await doAction(f.db, "lan", "register-url", {
      repo_url: "https://github.com/example/Widget",
    }, "laptop");
    assert.equal(first.ok, true, first.message);
    // Lowercased default slug landed on disk as projectRoots[0]/<slug>.
    assert.equal(existsSync(join(f.projectRoot, "widget")), true, "default slug should be 'widget'");

    // Second call to the same URL must collide.
    const second = await doAction(f.db, "lan", "register-url", {
      repo_url: "https://github.com/example/Widget",
    }, "laptop");
    assert.equal(second.ok, false, "duplicate slug must be rejected");
    assert.match(second.message, /slug[_ ]exists/i);
  } finally { f.cleanup(); }
});

test("register-url: gh repo view non-zero exit → error: repo_unreachable", async () => {
  const f = fixture();
  try {
    let gitClone = 0;
    _setRunnerForTests((cmd, args) => {
      f.calls.push({ cmd, args });
      if (cmd === "gh") {
        const e: any = new Error("gh: HTTP 404: Not Found");
        e.status = 1;
        e.stderr = "gh: HTTP 404: Not Found";
        throw e;
      }
      if (cmd === "git" && args[0] === "clone") { gitClone++; }
      return "";
    });
    const r = await doAction(f.db, "lan", "register-url", {
      repo_url: "https://github.com/example/nonexistent",
    }, "laptop");
    assert.equal(r.ok, false);
    assert.match(r.message, /repo[_ ]unreachable/i);
    assert.equal(gitClone, 0, "git clone must not run when gh check fails");
  } finally { f.cleanup(); }
});

test("register-url: partial <projectRoots[0]>/<slug> is removed on mid-flow failure", async () => {
  const f = fixture();
  try {
    // Stub: gh succeeds, git clone succeeds (creates dest dir), but bash
    // install.sh throws → simulates a register-time failure after the dest
    // dir already exists. The action must clean up the dest before returning.
    _setRunnerForTests((cmd, args) => {
      if (cmd === "gh") return JSON.stringify({ name: args[2].split("/")[1] });
      if (cmd === "git" && args[0] === "clone") {
        const dest = args[args.length - 1];
        mkdirSync(join(dest, ".git"), { recursive: true });
        writeFileSync(join(dest, ".git", "config"),
          `[remote "origin"]\n\turl = ${args[args.length - 2]}\n`);
        return "";
      }
      if (cmd === "bash") {
        const e: any = new Error("install.sh failed");
        e.status = 1;
        throw e;
      }
      return "";
    });
    const dest = join(f.projectRoot, "boom");
    const r = await doAction(f.db, "lan", "register-url", {
      repo_url: "https://github.com/example/boom",
    }, "laptop");
    assert.equal(r.ok, false, "register failure should bubble up");
    assert.equal(existsSync(dest), false, "partial dest directory must be removed");
  } finally { f.cleanup(); }
});

test("register-url: control_audit row records action=register-url + repo_url+slug only (no token)", async () => {
  const f = fixture();
  try {
    _setRunnerForTests(makeHappyRunner(f));
    const r = await doAction(f.db, "lan", "register-url", {
      repo_url: "https://github.com/example/widget",
      // Smuggle a token-shaped field in the body to prove it gets stripped
      // before being written into args_json.
      gh_token: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }, "laptop");
    assert.equal(r.ok, true, r.message);
    const audit = f.db.prepare(
      "SELECT action, target, args_json, actor, actor_name, exit_code FROM control_audit ORDER BY id DESC LIMIT 1",
    ).get() as any;
    assert.equal(audit.action, "register-url");
    assert.equal(audit.target, "widget");
    assert.equal(audit.actor, "lan");
    assert.equal(audit.actor_name, "laptop");
    assert.equal(audit.exit_code, 0);
    const args = JSON.parse(audit.args_json);
    assert.equal(args.repo_url, "https://github.com/example/widget");
    assert.equal(args.slug, "widget");
    assert.ok(!("gh_token" in args), "audit args_json must not carry token-shaped fields");
    assert.ok(!audit.args_json.includes("ghp_"), "no token-looking string in args_json");
  } finally { f.cleanup(); }
});

test("register-url: accepts an explicit slug override and uses it everywhere", async () => {
  const f = fixture();
  try {
    _setRunnerForTests(makeHappyRunner(f));
    const r = await doAction(f.db, "lan", "register-url", {
      repo_url: "https://github.com/example/widget",
      slug: "my-thing",
    }, "laptop");
    assert.equal(r.ok, true, r.message);
    const dest = join(f.projectRoot, "my-thing");
    assert.equal(existsSync(dest), true, "cloned into projectRoots[0]/<override-slug>");
    // The manifest at the override slug's path carries the slug too.
    const manifest = readFileSync(join(dest, "agents.config.sh"), "utf8");
    assert.match(manifest, /SLUG="my-thing"/);
  } finally { f.cleanup(); }
});

test("register-url: trailing .git in the URL is allowed and stripped from the default slug", async () => {
  const f = fixture();
  try {
    _setRunnerForTests(makeHappyRunner(f));
    const r = await doAction(f.db, "lan", "register-url", {
      repo_url: "https://github.com/example/widget.git",
    }, "laptop");
    assert.equal(r.ok, true, r.message);
    const dest = join(f.projectRoot, "widget");
    assert.equal(existsSync(dest), true, "default slug strips the trailing .git");
  } finally { f.cleanup(); }
});

// Silence unused homedir import — this is a fixture-only file.
void homedir;
