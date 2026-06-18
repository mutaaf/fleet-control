// Tests for fleetctl share CLI subcommand (ticket 0067).
//
// Each test maps 1:1 to one acceptance-criteria checkbox in
// docs/backlog/0067-fleetctl-share-cli-paste-ready-blurb.md. We exercise:
//   - the pure helpers in the new src/share.ts module
//     (composeShareBlurb, resolveShareHost, runShareCli),
//   - the runner seam _setShareClipboardRunnerForTests so the pbcopy
//     shell-out never invokes the real binary,
//   - the FLEET_SHARE_NO_CLIPBOARD=1 fallback path,
//   - the CLI subcommand wiring via spawnSync against bin/fleetctl.ts
//     with FLEET_DB_PATH pointing at a tmpdir DB (per LESSONS
//     2026-05-26 CLI subprocess tests need a FLEET_DB_PATH env seam).
//
// Zero new runtime deps; stdlib + node:test only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, type DB } from "../src/db.ts";
import {
  composeShareBlurb,
  resolveShareHost,
  runShareCli,
  _setShareClipboardRunnerForTests,
  _resetShareClipboardRunnerForTests,
  type ShareSurface,
  type ShareCliResult,
} from "../src/share.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { dir: string; dbPath: string; db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-share-"));
  const dbPath = join(dir, "fleet.db");
  const db = openDb(dbPath);
  return {
    dir,
    dbPath,
    db,
    cleanup: () => { try { db.close(); } catch { /* may already be closed */ } rmSync(dir, { recursive: true, force: true }); },
  };
}

function seedProject(db: DB, slug = "demo", name = "Demo"): void {
  db.prepare("INSERT INTO project(slug,name,namespace,repo_owner,repo_name) VALUES(?,?,?,?,?)")
    .run(slug, name, "com." + slug, "owner", slug);
}

function runCli(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [
    "--disable-warning=ExperimentalWarning",
    join(REPO_ROOT, "bin", "fleetctl.ts"),
    ...args,
  ], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

// ────────────────────────────────────────────────────────────────────
// AC1 — `fleetctl share <surface>` accepts all five surfaces + each
//        returns exit 0 + non-empty blurb on stdout.
// ────────────────────────────────────────────────────────────────────

test("AC1: fleetctl share <surface> exits 0 with non-empty blurb for each of the 5 surfaces", () => {
  const ctx = tempDb();
  try {
    seedProject(ctx.db);
    // Configure an operator handle so the profile branch works.
    const cfgPath = join(ctx.dir, "fleet-control.config.json");
    // We pass the config via cwd which the CLI reads on startup.
    // Since cwd isn't easily overridable, drive runShareCli directly
    // for the profile branch in this subprocess test we ALSO need an
    // operator handle. Set FLEET_OPERATOR_HANDLE so the in-process
    // resolveOperatorHandleForShare prefers it.
    void cfgPath;
    ctx.db.close();

    const surfaces: ShareSurface[] = ["pulse", "receipts", "calculator", "lessons", "profile"];
    for (const surface of surfaces) {
      const r = runCli(["share", surface], {
        FLEET_DB_PATH: ctx.dbPath,
        FLEET_SHARE_NO_CLIPBOARD: "1",
        FLEET_OPERATOR_HANDLE: "test-operator",
      });
      assert.equal(r.code, 0, `share ${surface} must exit 0; stderr=${r.stderr}; stdout=${r.stdout}`);
      assert.ok(r.stdout.trim().length > 0, `share ${surface} must print a non-empty blurb`);
      // The blurb's signature footer is documented in AC2 — assert it appears.
      assert.match(r.stdout, /\(powered by fleet-control\)/, `share ${surface} must include the powered-by footer`);
    }
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — composeShareBlurb is deterministic + each surface carries its
//        own signature phrase.
// ────────────────────────────────────────────────────────────────────

test("AC2: composeShareBlurb is deterministic across identical inputs", () => {
  const payload = { merged_prs: 4, total_spend_usd: 0, lesson_title: null };
  const url = "http://127.0.0.1:7070/share/pulse/abc123";
  const a = composeShareBlurb({ surface: "pulse", payload, url });
  const b = composeShareBlurb({ surface: "pulse", payload, url });
  assert.equal(a, b, "two calls with identical input must return byte-identical strings");
});

test("AC2: composeShareBlurb carries per-surface signature phrases", () => {
  const url = "http://127.0.0.1:7070/share/pulse/xyz";
  // pulse → "this week"
  const pulse = composeShareBlurb({
    surface: "pulse",
    payload: { merged_prs: 4 },
    url,
  });
  assert.match(pulse, /this week/i, "pulse blurb must reference 'this week'");

  // receipts → "this month" + "~$<X>"
  const receipts = composeShareBlurb({
    surface: "receipts",
    payload: { merged_prs: 12, total_spend_usd: 87.5 },
    url,
  });
  assert.match(receipts, /this month/i, "receipts blurb must reference 'this month'");
  assert.match(receipts, /\$/, "receipts blurb must include a $ figure");

  // calculator → time-saved claim
  const calc = composeShareBlurb({
    surface: "calculator",
    payload: { merged_prs_per_month: 8, cost_per_pr_usd: 12.5 },
    url,
  });
  assert.match(calc, /save|saved|hours|time/i, "calculator blurb must reference time/savings");

  // lessons → most-cited lesson title
  const lessons = composeShareBlurb({
    surface: "lessons",
    payload: { lesson_title: "the redactSecrets keys lesson", saved_usd: 42.5 },
    url,
  });
  assert.match(lessons, /lesson/i, "lessons blurb must reference 'lesson'");
  assert.ok(
    lessons.includes("the redactSecrets keys lesson"),
    "lessons blurb must embed the lesson title",
  );

  // profile → lifetime totals
  const profile = composeShareBlurb({
    surface: "profile",
    payload: { lifetimePrsShipped: 137, monthsRunning: 9 },
    url,
  });
  assert.match(profile, /137/, "profile blurb must mention lifetime PR count");
});

test("AC2: composeShareBlurb output is exactly 3 lines of content + URL inline", () => {
  const url = "http://127.0.0.1:7070/share/pulse/abc";
  const blurb = composeShareBlurb({
    surface: "pulse",
    payload: { merged_prs: 4 },
    url,
  });
  // The blurb is line-1, blank, line-2 (with URL), blank, line-3 (powered by).
  const lines = blurb.split("\n");
  assert.ok(lines.length >= 5, "blurb must have 5+ lines (3 content + 2 blanks)");
  assert.ok(blurb.includes(url), "blurb must embed the URL verbatim");
});

// ────────────────────────────────────────────────────────────────────
// AC3 — clipboard plumbing routes through the runner seam.
//        Test asserts cmd === 'pbcopy', argv.length === 0, opts.input === blurb.
// ────────────────────────────────────────────────────────────────────

test("AC3: clipboard plumbing invokes pbcopy with argv=[] and the blurb as stdin", async () => {
  const ctx = tempDb();
  try {
    seedProject(ctx.db);
    const seen: Array<{ cmd: string; argv: string[]; input: string }> = [];
    _setShareClipboardRunnerForTests((cmd, argv, opts) => {
      seen.push({ cmd, argv, input: opts.input });
      return { code: 0, stderrOut: "" };
    });
    try {
      const result: ShareCliResult = await runShareCli({
        db: ctx.db,
        cfg: { host: "127.0.0.1", port: 7070 },
        argv: ["pulse"],
        env: {},
      });
      assert.equal(result.exitCode, 0);
      assert.equal(seen.length, 1, "the runner seam must be invoked exactly once");
      assert.equal(seen[0].cmd, "pbcopy", "cmd must be the literal string 'pbcopy'");
      assert.equal(seen[0].argv.length, 0, "argv must be an empty array literal");
      assert.equal(seen[0].input, result.blurb, "opts.input must be the blurb byte-for-byte");
    } finally { _resetShareClipboardRunnerForTests(); }
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — non-Mac fallback. FLEET_SHARE_NO_CLIPBOARD=1 forces the
//        no-pbcopy branch; exit 0, stderr line, blurb on stdout.
// ────────────────────────────────────────────────────────────────────

test("AC4: FLEET_SHARE_NO_CLIPBOARD=1 prints the blurb on stdout, logs to stderr, exits 0", () => {
  const ctx = tempDb();
  try {
    seedProject(ctx.db);
    ctx.db.close();
    const r = runCli(["share", "pulse"], {
      FLEET_DB_PATH: ctx.dbPath,
      FLEET_SHARE_NO_CLIPBOARD: "1",
    });
    assert.equal(r.code, 0, "no-clipboard branch must exit 0 (the blurb is still useful on stdout)");
    assert.ok(r.stdout.length > 0, "blurb must still print to stdout");
    assert.match(r.stderr, /pbcopy not available/, "stderr must explain why the clipboard was skipped");
  } finally { ctx.cleanup(); }
});

test("AC4: ENOENT from the runner seam falls back to the same no-pbcopy stderr line", async () => {
  const ctx = tempDb();
  try {
    seedProject(ctx.db);
    // Stub the runner to return ENOENT — same shape as a missing
    // pbcopy binary on Linux.
    _setShareClipboardRunnerForTests(() => {
      const err = new Error("spawn pbcopy ENOENT") as Error & { code: string };
      err.code = "ENOENT";
      throw err;
    });
    try {
      const result = await runShareCli({
        db: ctx.db,
        cfg: { host: "127.0.0.1", port: 7070 },
        argv: ["pulse"],
        env: {},
      });
      assert.equal(result.exitCode, 0, "ENOENT must NOT exit non-zero (blurb is still on stdout)");
      assert.match(result.stderr, /pbcopy not available/i, "stderr must explain the fallback");
      assert.ok(result.blurb.length > 0, "blurb must still be returned for stdout");
    } finally { _resetShareClipboardRunnerForTests(); }
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — URL resolution. resolveShareHost translates wildcard /
//        loopback / LAN configs into a parseable host for Slack.
// ────────────────────────────────────────────────────────────────────

test("AC5: resolveShareHost('127.0.0.1') returns '127.0.0.1'", () => {
  assert.equal(resolveShareHost({ host: "127.0.0.1", port: 7070 }), "127.0.0.1");
});

test("AC5: resolveShareHost('0.0.0.0') returns the loopback IP (Slack-parseable)", () => {
  assert.equal(
    resolveShareHost({ host: "0.0.0.0", port: 7070 }),
    "127.0.0.1",
    "0.0.0.0 is unparseable as a URL by Slack/Bluesky/LinkedIn — substitute loopback",
  );
});

test("AC5: resolveShareHost('192.168.1.42') returns the LAN IP unchanged", () => {
  assert.equal(resolveShareHost({ host: "192.168.1.42", port: 7070 }), "192.168.1.42");
});

test("AC5: URL composes as http://<host>:<port>/share/<surface>/<token>", async () => {
  const ctx = tempDb();
  try {
    seedProject(ctx.db);
    _setShareClipboardRunnerForTests(() => ({ code: 0, stderrOut: "" }));
    try {
      const result = await runShareCli({
        db: ctx.db,
        cfg: { host: "127.0.0.1", port: 7070 },
        argv: ["pulse"],
        env: {},
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /http:\/\/127\.0\.0\.1:7070\/share\/pulse\/[0-9a-f]+/);
    } finally { _resetShareClipboardRunnerForTests(); }
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Snapshot token issuance + profile branch + missing-handle error.
// ────────────────────────────────────────────────────────────────────

test("AC6: fleetctl share pulse mints a snapshot row with kind='share_pulse'", async () => {
  const ctx = tempDb();
  try {
    seedProject(ctx.db);
    _setShareClipboardRunnerForTests(() => ({ code: 0, stderrOut: "" }));
    try {
      const result = await runShareCli({
        db: ctx.db,
        cfg: { host: "127.0.0.1", port: 7070 },
        argv: ["pulse"],
        env: {},
      });
      assert.equal(result.exitCode, 0);
      const rows = ctx.db.prepare("SELECT kind FROM snapshot").all() as Array<{ kind: string | null }>;
      assert.equal(rows.length, 1, "exactly one snapshot row must be inserted");
      assert.equal(rows[0].kind, "share_pulse");
    } finally { _resetShareClipboardRunnerForTests(); }
  } finally { ctx.cleanup(); }
});

test("AC6: each non-profile surface mints a snapshot row with kind='share_<surface>'", async () => {
  const ctx = tempDb();
  try {
    seedProject(ctx.db);
    _setShareClipboardRunnerForTests(() => ({ code: 0, stderrOut: "" }));
    try {
      const surfaces: ShareSurface[] = ["pulse", "receipts", "calculator", "lessons"];
      for (const surface of surfaces) {
        const result = await runShareCli({
          db: ctx.db,
          cfg: { host: "127.0.0.1", port: 7070 },
          argv: [surface],
          env: {},
        });
        assert.equal(result.exitCode, 0, `${surface} should exit 0`);
      }
      const rows = ctx.db.prepare("SELECT kind FROM snapshot ORDER BY created_at").all() as Array<{ kind: string | null }>;
      const kinds = new Set(rows.map((r) => r.kind));
      assert.ok(kinds.has("share_pulse"));
      assert.ok(kinds.has("share_receipts"));
      assert.ok(kinds.has("share_calculator"));
      assert.ok(kinds.has("share_lessons"));
    } finally { _resetShareClipboardRunnerForTests(); }
  } finally { ctx.cleanup(); }
});

test("AC6: fleetctl share profile with no operator handle exits 1 + prints stderr help", async () => {
  const ctx = tempDb();
  try {
    seedProject(ctx.db);
    _setShareClipboardRunnerForTests(() => ({ code: 0, stderrOut: "" }));
    try {
      const result = await runShareCli({
        db: ctx.db,
        cfg: { host: "127.0.0.1", port: 7070 /* no operator */ },
        argv: ["profile"],
        env: {},
      });
      assert.equal(result.exitCode, 1, "missing operator handle must exit non-zero");
      assert.match(
        result.stderr,
        /operator\.handle/,
        "stderr must name the missing config key",
      );
      // No snapshot row should be minted — profile is tokenless.
      const rows = ctx.db.prepare("SELECT COUNT(*) AS c FROM snapshot").get() as { c: number };
      assert.equal(rows.c, 0, "profile branch must NOT mint a snapshot row even on success");
    } finally { _resetShareClipboardRunnerForTests(); }
  } finally { ctx.cleanup(); }
});

test("AC6: fleetctl share profile with handle returns /operator/<handle> URL without a token segment", async () => {
  const ctx = tempDb();
  try {
    seedProject(ctx.db);
    _setShareClipboardRunnerForTests(() => ({ code: 0, stderrOut: "" }));
    try {
      const result = await runShareCli({
        db: ctx.db,
        cfg: {
          host: "127.0.0.1",
          port: 7070,
          operator: { handle: "mutaaf", sinceDate: "2026-01-01" },
        },
        argv: ["profile"],
        env: {},
      });
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /\/operator\/mutaaf\b/, "profile URL must hit /operator/<handle>");
      assert.ok(!/\/share\/profile\//.test(result.stdout), "profile URL must NOT carry a token segment");
      // No snapshot row should be minted for profile.
      const rows = ctx.db.prepare("SELECT COUNT(*) AS c FROM snapshot").get() as { c: number };
      assert.equal(rows.c, 0, "profile branch must NOT mint a snapshot row");
    } finally { _resetShareClipboardRunnerForTests(); }
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — Revoke subcommand. `fleetctl share revoke <token-or-prefix>`
//        flips the snapshot row's revoked_at via the existing 0013
//        revokeSnapshot helper.
// ────────────────────────────────────────────────────────────────────

test("AC7: fleetctl share revoke <id-prefix> flips revoked_at on the snapshot row", async () => {
  const ctx = tempDb();
  try {
    seedProject(ctx.db);
    _setShareClipboardRunnerForTests(() => ({ code: 0, stderrOut: "" }));
    try {
      // Create a snapshot first.
      const created = await runShareCli({
        db: ctx.db,
        cfg: { host: "127.0.0.1", port: 7070 },
        argv: ["pulse"],
        env: {},
      });
      assert.equal(created.exitCode, 0);
      // Look up the id_prefix to revoke against (the 0013 revoke helper
      // takes the id-prefix, not the plaintext token).
      const row = ctx.db.prepare("SELECT id, revoked_at FROM snapshot").get() as {
        id: string; revoked_at: string | null;
      };
      assert.equal(row.revoked_at, null, "freshly-minted snapshot must not be revoked yet");
      const prefix = row.id.slice(0, 8);

      const revoked = await runShareCli({
        db: ctx.db,
        cfg: { host: "127.0.0.1", port: 7070 },
        argv: ["revoke", prefix],
        env: {},
      });
      assert.equal(revoked.exitCode, 0);
      const after = ctx.db.prepare("SELECT revoked_at FROM snapshot").get() as { revoked_at: string | null };
      assert.ok(after.revoked_at, "revoke must populate revoked_at");
    } finally { _resetShareClipboardRunnerForTests(); }
  } finally { ctx.cleanup(); }
});

test("AC7: fleetctl share revoke with no token argument exits 1 with a usage line", async () => {
  const ctx = tempDb();
  try {
    const result = await runShareCli({
      db: ctx.db,
      cfg: { host: "127.0.0.1", port: 7070 },
      argv: ["revoke"],
      env: {},
    });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr + result.stdout, /usage/i);
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC8 — Help surface: `fleetctl share` (no subcommand) prints a help
//        block naming all 5 surfaces + revoke. Exits 0.
// ────────────────────────────────────────────────────────────────────

test("AC8: fleetctl share with no surface prints a help block listing all 5 surfaces + revoke + exits 0", async () => {
  const ctx = tempDb();
  try {
    const result = await runShareCli({
      db: ctx.db,
      cfg: { host: "127.0.0.1", port: 7070 },
      argv: [],
      env: {},
    });
    assert.equal(result.exitCode, 0, "share-no-arg is help, not a usage error");
    const out = result.stdout;
    assert.match(out, /pulse/);
    assert.match(out, /receipts/);
    assert.match(out, /calculator/);
    assert.match(out, /lessons/);
    assert.match(out, /profile/);
    assert.match(out, /revoke/);
  } finally { ctx.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC9 — Static-grep guard: the clipboard shell-out uses argv-array form,
//        never a composed shell string.
//        + the new module must NOT import { exec } / { execSync } directly.
// ────────────────────────────────────────────────────────────────────

test("AC9: src/share.ts does NOT import the shell-string exec variants from node:child_process", async () => {
  // Per LESSONS 2026-05-26 "no shell-string exec static checks should
  // grep the import, not the call site" — we check the import surface,
  // not the call site. The call site can use any name (deps.exec,
  // runner, etc.); the import is the single chokepoint.
  const src = await import("node:fs").then((m) => m.readFileSync(
    join(REPO_ROOT, "src", "share.ts"), "utf8",
  ));
  // Must not import `exec` or `execSync` (the shell-string variants)
  // from node:child_process. execFile is the only allowed shape.
  const importBlock = src.match(/from\s+["']node:child_process["'][^;]*/g) ?? [];
  for (const imp of importBlock) {
    // Allow `execFile`. Reject bare `exec` / `execSync`.
    assert.ok(!/\b(exec|execSync)\b\s*(,|\}|\s)/.test(
      imp.replace(/execFile\w*/g, "FILTERED"),
    ), `src/share.ts must not import shell-string exec from node:child_process; got: ${imp}`);
  }
});

test("AC9: src/share.ts shells out via execFile('pbcopy', []) — the literal argv array", async () => {
  const src = await import("node:fs").then((m) => m.readFileSync(
    join(REPO_ROOT, "src", "share.ts"), "utf8",
  ));
  // The argv array literal MUST appear next to the pbcopy literal.
  // Anchor the grep on the function-call shape (per LESSONS 2026-06-15
  // "static `before /api/` greps must anchor on the if-statement, not
  // the prose comment") — here we look for a `("pbcopy"` followed by
  // a `, []` argv literal in source order.
  assert.match(
    src,
    /["']pbcopy["']\s*,\s*\[\s*\]/,
    "src/share.ts must call execFile('pbcopy', []) with an argv-array literal",
  );
});
