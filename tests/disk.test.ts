// Unit tests for src/infra.ts (diskUsage) + the clean-checkouts control action
// (ticket 0006). Each test maps to an acceptance-criteria checkbox in
// docs/backlog/0006-stale-checkout-janitor.md.
//
// Strategy: build a tmp "fake $HOME" that mirrors the real layout
//   <home>/.cache/<slug>-agent-ship-checkout         (stale by mtime)
//   <home>/.cache/<slug>-agent-groom-checkout        (fresh)
//   <home>/.cache/<slug>-agent/runs.jsonl            (must never be touched)
//   <home>/.cache/<slug>-agent/events.jsonl          (must never be touched)
//   <home>/.cache/<slug>-agent/logs/ship.log         (must never be touched)
// then point HOME at the tmpdir for the duration of each test. We never run
// any shell-out — diskUsage / cleanCheckouts are pure node:fs/promises +
// node:fs operations against the rewritten $HOME.
//
// Zero new deps; stdlib only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, statSync, utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type DB } from "../src/db.ts";
import { diskUsage, cleanCheckouts } from "../src/infra.ts";
import { doAction } from "../src/control.ts";

interface Fixture {
  home: string;
  prevHome: string | undefined;
  db: DB;
  staleDir: string;
  freshDir: string;
  agentDir: string;
  cleanup: () => void;
}

const SLUG = "demo";

/** Build a tmp $HOME with two checkouts (one stale, one fresh) and the
 *  protected files diskUsage/cleanCheckouts must never touch. */
function fixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), "fleet-disk-"));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  const cache = join(home, ".cache");
  mkdirSync(cache, { recursive: true });

  // Two checkout directories — both match `~/.cache/<slug>-agent*`.
  const staleDir = join(cache, `${SLUG}-agent-ship-checkout`);
  const freshDir = join(cache, `${SLUG}-agent-groom-checkout`);
  mkdirSync(staleDir, { recursive: true });
  mkdirSync(freshDir, { recursive: true });
  // Pad each with a known-size file so byte-count assertions are deterministic.
  writeFileSync(join(staleDir, "f.txt"), "x".repeat(100));
  writeFileSync(join(freshDir, "f.txt"), "y".repeat(50));
  // Stale: mtime 30 days ago. Fresh: now.
  const longAgo = new Date(Date.now() - 30 * 86_400_000);
  utimesSync(staleDir, longAgo, longAgo);
  utimesSync(join(staleDir, "f.txt"), longAgo, longAgo);

  // Protected files under <slug>-agent/ — these must survive cleanCheckouts().
  const agentDir = join(cache, `${SLUG}-agent`);
  mkdirSync(join(agentDir, "logs"), { recursive: true });
  writeFileSync(join(agentDir, "runs.jsonl"), '{"phase":"ship"}\n');
  writeFileSync(join(agentDir, "events.jsonl"), '{"type":"run_started"}\n');
  writeFileSync(join(agentDir, "logs", "ship.log"), "hello\n");

  // DB the cleaner writes a control_audit row to + project row for slug lookup.
  const dbPath = join(home, "fleet.db");
  const db = openDb(dbPath);
  db.prepare(
    "INSERT INTO project(slug, name, namespace, repo_owner, repo_name, manifest_path) VALUES (?,?,?,?,?,?)",
  ).run(SLUG, SLUG, `com.${SLUG}`, "owner", SLUG, join(home, "agents.config.sh"));

  return {
    home, prevHome, db, staleDir, freshDir, agentDir,
    cleanup: () => {
      db.close();
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("diskUsage: counts both checkouts, computes oldest_age_days, lists candidates", async () => {
  const f = fixture();
  try {
    const d = await diskUsage(SLUG);
    assert.equal(d.checkout_count, 2, "two checkouts under ~/.cache/<slug>-agent*");
    // The protected <slug>-agent/ tree carries its own bytes too — diskUsage
    // reports total bytes across everything under the glob, but the
    // `candidates` list is just the *-checkout dirs we may delete.
    assert.ok(d.bytes >= 150, "bytes must include both checkout payloads");
    assert.ok(d.oldest_age_days >= 29, `oldest_age_days should be ~30, got ${d.oldest_age_days}`);
    const paths = d.candidates.map((c) => c.path).sort();
    assert.deepEqual(paths, [f.freshDir, f.staleDir].sort(), "candidates list both checkout dirs");
    const stale = d.candidates.find((c) => c.path === f.staleDir);
    const fresh = d.candidates.find((c) => c.path === f.freshDir);
    assert.ok(stale && fresh);
    assert.ok(stale!.age_days >= 29, "stale candidate should report ~30 days");
    assert.ok(fresh!.age_days < 1, "fresh candidate should report <1 day");
    assert.equal(stale!.bytes, 100, "stale candidate's byte count must match its single file");
    assert.equal(fresh!.bytes, 50, "fresh candidate's byte count must match its single file");
  } finally { f.cleanup(); }
});

test("diskUsage: unknown slug returns zeros (so the route can 200 with an empty shape)", async () => {
  const f = fixture();
  try {
    const d = await diskUsage("ghost");
    assert.equal(d.checkout_count, 0);
    assert.equal(d.bytes, 0);
    assert.equal(d.oldest_age_days, 0);
    assert.deepEqual(d.candidates, []);
  } finally { f.cleanup(); }
});

test("cleanCheckouts: removes only the stale checkout; never touches runs.jsonl/events.jsonl/logs", async () => {
  const f = fixture();
  try {
    const r = await cleanCheckouts(SLUG, 14);
    assert.equal(r.removed.length, 1, "exactly one stale dir should be removed");
    assert.equal(r.removed[0], f.staleDir, "the stale dir is the one removed");
    assert.equal(existsSync(f.staleDir), false, "stale checkout must be gone");
    assert.equal(existsSync(f.freshDir), true, "fresh checkout must survive");
    // Protected paths under <slug>-agent/ must be untouched.
    assert.equal(existsSync(join(f.agentDir, "runs.jsonl")), true, "runs.jsonl must survive");
    assert.equal(existsSync(join(f.agentDir, "events.jsonl")), true, "events.jsonl must survive");
    assert.equal(existsSync(join(f.agentDir, "logs", "ship.log")), true, "logs/ must survive");
  } finally { f.cleanup(); }
});

test("doAction(clean-checkouts): writes a control_audit row and reports removed paths", async () => {
  const f = fixture();
  try {
    const r = await doAction(f.db, "lan", "clean-checkouts", { slug: SLUG, older_than_days: 14 }, "laptop");
    assert.equal(r.ok, true, r.message);
    const audit = f.db.prepare(
      "SELECT actor, actor_name, action, target, exit_code FROM control_audit ORDER BY id DESC LIMIT 1",
    ).get() as any;
    assert.equal(audit.action, "clean-checkouts");
    assert.equal(audit.actor, "lan");
    assert.equal(audit.actor_name, "laptop");
    assert.equal(audit.exit_code, 0);
    assert.match(audit.target, new RegExp(`^${SLUG}/`), "audit target prefixed with slug");
    // The stale dir is gone, the fresh dir remains.
    assert.equal(existsSync(f.staleDir), false);
    assert.equal(existsSync(f.freshDir), true);
  } finally { f.cleanup(); }
});

test("doAction(clean-checkouts): default older_than_days = 14 when omitted", async () => {
  const f = fixture();
  try {
    const r = await doAction(f.db, "local", "clean-checkouts", { slug: SLUG });
    assert.equal(r.ok, true, r.message);
    assert.equal(existsSync(f.staleDir), false, "30-day-old dir is stale at the 14-day default");
    assert.equal(existsSync(f.freshDir), true, "fresh dir must remain");
  } finally { f.cleanup(); }
});

test("cleanCheckouts: refuses paths that don't start with $HOME/.cache/<slug>-agent", async () => {
  const f = fixture();
  try {
    // Plant a directory just outside the prefix — same name shape but in a
    // different cache subtree. Anything OUTSIDE $HOME/.cache/<slug>-agent
    // must be untouched even if its mtime is ancient.
    const evil = join(f.home, ".cache", "other-agent-checkout");
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, "f.txt"), "z");
    const longAgo = new Date(Date.now() - 90 * 86_400_000);
    utimesSync(evil, longAgo, longAgo);
    utimesSync(join(evil, "f.txt"), longAgo, longAgo);

    // diskUsage("demo") must not surface this dir as a candidate.
    const d = await diskUsage(SLUG);
    assert.equal(
      d.candidates.some((c) => c.path === evil), false,
      "diskUsage must only walk ~/.cache/<slug>-agent*",
    );
    // cleanCheckouts must leave it alone.
    const r = await cleanCheckouts(SLUG, 14);
    assert.equal(r.removed.includes(evil), false, "cleaner must never touch foreign paths");
    assert.equal(existsSync(evil), true, "foreign dir survives");
  } finally { f.cleanup(); }
});

test("doAction(clean-checkouts): bad slug rejected before any fs work", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => doAction(f.db, "lan", "clean-checkouts", { slug: "../etc/passwd" }, "laptop"),
      /bad slug/,
    );
    // Stale dir survives because the call never made it past validation.
    assert.equal(existsSync(f.staleDir), true);
  } finally { f.cleanup(); }
});

// Sanity: a fresh-only fixture leaves nothing to remove.
test("cleanCheckouts: no stale dirs → removed is empty, fresh survives", async () => {
  const f = fixture();
  try {
    // Reset the stale dir's mtime so both checkouts now look fresh.
    const now = new Date();
    utimesSync(f.staleDir, now, now);
    utimesSync(join(f.staleDir, "f.txt"), now, now);
    const r = await cleanCheckouts(SLUG, 14);
    assert.deepEqual(r.removed, []);
    assert.equal(existsSync(f.staleDir), true);
    assert.equal(existsSync(f.freshDir), true);
    // Sanity check the mtime really moved.
    assert.ok((Date.now() - statSync(f.staleDir).mtimeMs) < 5_000);
  } finally { f.cleanup(); }
});
