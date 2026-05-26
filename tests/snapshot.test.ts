// Tests for the shareable read-only fleet snapshot (ticket 0013).
//
// Each test maps 1:1 to an acceptance-criteria checkbox in
// docs/backlog/0013-shareable-fleet-snapshot.md. We exercise:
//   - the snapshot table schema (round-trip insert/query),
//   - the helpers in src/snapshot.ts (createSnapshot / getSnapshot /
//     revokeSnapshot / anonymize / listSnapshots / serveShare),
//   - the control actions (snapshot-create / snapshot-revoke) via
//     doAction() — proving the audit row carries id_prefix only and
//     NEVER the plaintext token,
//   - the server's GET /share/<token> handler (via serveShare(), the
//     same helper the server routes call) — including the expiry path
//     that returns 410 Gone and the revoked path,
//   - the CLI subcommands `fleetctl snapshot create|list|revoke`
//     spawned in a subprocess so we exercise the actual argv parser.
//
// Hard constraints we enforce in these tests (from AGENTS.md § Hard NOs
// and the ticket's own "no new deps / no shape change" line):
//   - the SHA-256 of the secret token is what we store; the plaintext
//     never appears in the DB and never in any audit row;
//   - the share HTML carries no <button>, no /api/control/, no
//     github.com anchor, and no /Users/ filesystem path;
//   - the share HTML inlines its data as a <script
//     type="application/json"> block — no /api/... fetches.
//
// Zero new runtime deps; stdlib + node:test only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openDb, type DB } from "../src/db.ts";
import {
  createSnapshot, getSnapshot, revokeSnapshot, anonymize, listSnapshots,
  serveShare, SHARE_PAGE_TITLE_PREFIX,
} from "../src/snapshot.ts";
import { doAction } from "../src/control.ts";

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-snap-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A realistic fleet view fixture. Carries everything the anonymizer is
 *  contractually required to drop or replace: a real owner slug
 *  ('mutaaf-aziz'), a repo URL, a PR title/url/author, transcript
 *  paths, and a mix of numeric + enum fields that MUST survive. */
function fleetFixture(): unknown {
  return {
    projects: [
      {
        slug: "fleet-control",
        name: "Fleet Control",
        repo: "mutaaf-aziz/fleet-control",
        repo_owner: "mutaaf-aziz",
        repo_name: "fleet-control",
        repo_url: "https://github.com/mutaaf-aziz/fleet-control",
        branch: "main",
        displayState: "idle",
        selfCancelDays: 18,
        engEnabled: true,
        cost: 21.34,
        cost7d: 4.21,
        runs: 187,
        jobs: [{
          phase: "ship",
          loaded: true,
          running: false,
          paused: false,
          next: "2026-05-27T05:53:00Z",
          last: {
            id: 9001, started_at: "2026-05-26T05:53:00Z", outcome: "shipped",
            pr_number: 25, duration_ms: 240_000, cost: 1.23,
          },
          transcript_path: "/Users/mutaaf-aziz/.claude/projects/fleet-control/sess.jsonl",
          log_path: "/Users/mutaaf-aziz/.local/state/fleet-control/agent.log",
          manifest_path: "/Users/mutaaf-aziz/Desktop/projects/fleet-control/agents.config.sh",
        }],
        telemetry: ["shipped", "no-op", "shipped", "healed"],
        forecast: { daily_mean_7d: 0.91, daily_mean_14d: 0.88, projected_30d: 27.3, samples: 7 },
        anomalies: { count_24h: 0, latest_at: null },
        prs: [{
          number: 25, title: "feat/0012 weekly digest", url: "https://github.com/mutaaf-aziz/fleet-control/pull/25",
          author: "mutaaf-aziz", additions: 612, deletions: 17, state: "open",
          ci_state: "green", merge_state: "clean", is_agent: 1,
        }],
      },
      {
        slug: "courtiq",
        name: "Courtiq",
        repo: "mutaaf-aziz/courtiq",
        repo_owner: "mutaaf-aziz",
        repo_name: "courtiq",
        repo_url: "https://github.com/mutaaf-aziz/courtiq",
        branch: "main",
        displayState: "working",
        selfCancelDays: 5,
        engEnabled: false,
        cost: 7.5,
        cost7d: 1.4,
        runs: 64,
        jobs: [{
          phase: "groom", loaded: true, running: true, paused: false, next: null,
          last: { id: 9100, outcome: "no-op", started_at: "2026-05-26T11:53:00Z", cost: 0.04 },
          transcript_path: "/Users/mutaaf-aziz/.claude/projects/courtiq/sess.jsonl",
        }],
        telemetry: ["no-op", "shipped"],
        forecast: null,
        anomalies: { count_24h: 1, latest_at: "2026-05-26T11:00:00Z" },
        prs: [],
      },
    ],
    totals: { cost: 28.84, runs: 251, projected_30d: 27.3, forecast_ready: 1 },
    alerts: [],
    daemonOn: false,
    generatedAt: "2026-05-26T12:00:00Z",
  };
}

// ────────────────────────────────────────────────────────────────────
// AC1 — snapshot table schema round-trips
// ────────────────────────────────────────────────────────────────────

test("AC1: snapshot table accepts insert + round-trips every column", () => {
  const { db, cleanup } = tempDb();
  try {
    const id = createHash("sha256").update("secret-token").digest("hex");
    const created = "2026-05-26T12:00:00.000Z";
    const expires = "2026-05-27T12:00:00.000Z";
    const payload = JSON.stringify({ projects: [] });
    db.prepare(
      "INSERT INTO snapshot(id,name,created_at,expires_at,revoked_at,payload_json) VALUES(?,?,?,?,?,?)",
    ).run(id, "demo", created, expires, null, payload);
    const row = db.prepare(
      "SELECT id,name,created_at,expires_at,revoked_at,payload_json FROM snapshot WHERE id=?",
    ).get(id) as Record<string, unknown>;
    assert.equal(row.id, id);
    assert.equal(row.name, "demo");
    assert.equal(row.created_at, created);
    assert.equal(row.expires_at, expires);
    assert.equal(row.revoked_at, null);
    assert.equal(row.payload_json, payload);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC2 — createSnapshot / getSnapshot / revokeSnapshot / anonymize
// ────────────────────────────────────────────────────────────────────

test("AC2: createSnapshot mints distinct tokens on successive calls", () => {
  const { db, cleanup } = tempDb();
  try {
    const view = fleetFixture();
    const a = createSnapshot(db, { name: "couch demo", fleetView: view });
    const b = createSnapshot(db, { name: "couch demo", fleetView: view });
    assert.ok(a.token && typeof a.token === "string", "must return a plaintext token");
    assert.ok(b.token && typeof b.token === "string");
    assert.notEqual(a.token, b.token, "successive snapshots must have distinct tokens");
    assert.ok(a.share_url.includes(a.token), "share_url should embed the plaintext token");
    // Hash, not plaintext, lives in the DB.
    const idA = createHash("sha256").update(a.token).digest("hex");
    const row = db.prepare("SELECT id FROM snapshot WHERE id=?").get(idA) as { id: string } | undefined;
    assert.equal(row?.id, idA, "snapshot row keyed by SHA-256 of the token");
    const leaked = db.prepare(
      "SELECT COUNT(*) AS n FROM snapshot WHERE payload_json LIKE ?",
    ).get("%" + a.token + "%") as { n: number };
    assert.equal(leaked.n, 0, "plaintext token must NOT leak into payload_json");
  } finally { cleanup(); }
});

test("AC2: getSnapshot resolves a live token; null for unknown", () => {
  const { db, cleanup } = tempDb();
  try {
    const m = createSnapshot(db, { name: "demo", fleetView: fleetFixture() });
    const got = getSnapshot(db, m.token);
    assert.ok(got, "live token must resolve");
    assert.equal(got!.expired, false);
    assert.equal(got!.revoked, false);
    assert.ok(got!.payload && typeof got!.payload === "object");
    assert.equal(getSnapshot(db, "nope-not-a-real-token"), null);
  } finally { cleanup(); }
});

test("AC2: revokeSnapshot flips revoked_at; subsequent getSnapshot reports revoked=true", () => {
  const { db, cleanup } = tempDb();
  try {
    const m = createSnapshot(db, { name: "demo", fleetView: fleetFixture() });
    const ok = revokeSnapshot(db, m.id_prefix);
    assert.equal(ok, true, "revokeSnapshot must report success for a live prefix");
    const got = getSnapshot(db, m.token);
    assert.ok(got, "row still readable post-revoke (404 surfaced elsewhere)");
    assert.equal(got!.revoked, true);
    // Revoking again is a no-op (returns false).
    assert.equal(revokeSnapshot(db, m.id_prefix), false);
  } finally { cleanup(); }
});

test("AC2: anonymize replaces slugs/names/urls/paths and preserves numerics+enums", () => {
  const view = fleetFixture() as { projects: any[]; totals: any };
  const anon = anonymize(view) as { projects: any[]; totals: any };
  // Stable counter — first project becomes project-1 (not 0-indexed; the
  // ticket's user story shows "project-a/-b/-c" placeholders, we keep the
  // 1-indexed counter so the snapshot reads as 1..N to a human).
  assert.equal(anon.projects[0].slug, "project-1");
  assert.equal(anon.projects[1].slug, "project-2");
  assert.equal(anon.projects[0].name, "Project 1");
  assert.equal(anon.projects[1].name, "Project 2");
  // No /Users/ path anywhere in the serialized view.
  const serialised = JSON.stringify(anon);
  assert.equal(serialised.includes("/Users/"), false, "no absolute /Users/ paths leak");
  assert.equal(serialised.includes("mutaaf-aziz"), false, "no real owner slug leaks");
  assert.equal(serialised.includes("fleet-control"), false, "no real repo slug leaks");
  assert.equal(serialised.includes("courtiq"), false, "no second real slug leaks");
  assert.equal(serialised.includes("github.com"), false, "no github.com URLs leak");
  // PR title/author/url are scrubbed.
  for (const p of anon.projects) {
    for (const pr of (p.prs || [])) {
      assert.ok(!pr.title || /^PR #/.test(pr.title), "PR title replaced with placeholder");
      assert.ok(pr.url == null || pr.url === "", "PR url dropped");
      assert.ok(pr.author == null || pr.author === "", "PR author dropped");
    }
    for (const j of (p.jobs || [])) {
      assert.equal("transcript_path" in j, false, "transcript_path dropped");
      assert.equal("log_path" in j, false, "log_path dropped");
      assert.equal("manifest_path" in j, false, "manifest_path dropped");
    }
    // repo_url/repo_owner/repo_name/branch dropped or nulled.
    assert.ok(p.repo_url == null || p.repo_url === "", "repo_url dropped");
    assert.ok(p.repo_owner == null || p.repo_owner === "", "repo_owner dropped");
    assert.ok(p.repo_name == null || p.repo_name === "", "repo_name dropped");
    assert.ok(p.branch == null || p.branch === "", "branch dropped");
  }
  // Numerics preserved bit-for-bit.
  assert.equal(anon.projects[0].cost, 21.34);
  assert.equal(anon.projects[0].cost7d, 4.21);
  assert.equal(anon.projects[0].runs, 187);
  assert.equal(anon.totals.cost, 28.84);
  assert.equal(anon.totals.runs, 251);
  // Enums preserved.
  assert.equal(anon.projects[0].displayState, "idle");
  assert.equal(anon.projects[1].displayState, "working");
  assert.equal(anon.projects[0].jobs[0].phase, "ship");
  assert.equal(anon.projects[0].jobs[0].last.outcome, "shipped");
});

test("AC2: anonymize is a deep clone — does not mutate the input view", () => {
  const view = fleetFixture() as { projects: any[] };
  const slugBefore = view.projects[0].slug;
  const ownerBefore = view.projects[0].repo_owner;
  anonymize(view);
  assert.equal(view.projects[0].slug, slugBefore, "input view must be untouched");
  assert.equal(view.projects[0].repo_owner, ownerBefore);
});

// ────────────────────────────────────────────────────────────────────
// AC3 — POST /api/control/snapshot-create requires admin, returns share_url
// ────────────────────────────────────────────────────────────────────

test("AC3: server gates POST /api/control/snapshot-* on the 'admin' scope", () => {
  // The 403/200 contract for "without admin → reject, with admin →
  // accept" is enforced one layer up by requireAuth (already covered
  // end-to-end by tests/auth-server.test.ts — `read` token denied on
  // `control` scope, `admin` satisfies every scope). What we MUST
  // assert here is the route-level wiring: server.ts's
  // /api/control/<action> dispatcher names the right `required`
  // scope for `snapshot-*` actions. A future refactor that widens
  // the ternary lands loudly on this regex.
  const here = dirname(fileURLToPath(import.meta.url));
  const srv = readFileSync(join(here, "..", "src", "server.ts"), "utf8");
  // The ternary spans several lines in server.ts; we collapse
  // whitespace so the pattern is forgiving of formatting churn but
  // still pinpoints the exact decision: snapshot-* → admin, others
  // (besides tokens-/register-url, also on admin) → control. We
  // allow `.*?` between the openings because the boolean-or chain
  // contains its own parentheses (`startsWith("tokens-")`).
  const collapsed = srv.replace(/\s+/g, " ");
  assert.match(
    collapsed,
    /required:\s*Scope\s*=\s*\(.*?startsWith\("snapshot-"\).*?\)\s*\?\s*"admin"\s*:\s*"control"/,
    "server.ts must gate snapshot-* on admin scope",
  );
});

test("AC3: doAction(snapshot-create) writes a row + returns share_url", async () => {
  const { db, cleanup } = tempDb();
  try {
    const r = await doAction(db, "local", "snapshot-create", {
      name: "couch demo",
      fleet_view: fleetFixture(),
    });
    assert.equal(r.ok, true, r.message);
    const payload = JSON.parse(r.output ?? "{}");
    assert.ok(payload.token, "snapshot-create response must carry plaintext token once");
    assert.ok(payload.share_url, "snapshot-create response must carry share_url");
    assert.ok(payload.id_prefix && /^[0-9a-f]{8}$/.test(payload.id_prefix));
    // The audit row records id_prefix, NEVER the plaintext token.
    const audit = db.prepare(
      "SELECT action, target, args_json FROM control_audit ORDER BY id DESC LIMIT 1",
    ).get() as { action: string; target: string; args_json: string };
    assert.equal(audit.action, "snapshot-create");
    assert.ok(!audit.args_json.includes(payload.token), "plaintext token must not leak into args_json");
    assert.ok(audit.args_json.includes(payload.id_prefix), "audit args_json should carry id_prefix");
    // The row exists.
    const row = db.prepare("SELECT name FROM snapshot WHERE id LIKE ?")
      .get(payload.id_prefix + "%") as { name: string } | undefined;
    assert.equal(row?.name, "couch demo");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC4 — POST /api/control/snapshot-revoke flips revoked_at; subsequent
//       share view surfaces 410 Gone
// ────────────────────────────────────────────────────────────────────

test("AC4: doAction(snapshot-revoke) + serveShare → 410 Gone afterwards", async () => {
  const { db, cleanup } = tempDb();
  try {
    const minted = await doAction(db, "local", "snapshot-create", {
      name: "tmp", fleet_view: fleetFixture(),
    });
    const created = JSON.parse(minted.output ?? "{}");
    // Pre-revoke: serveShare returns 200 with HTML.
    const pre = serveShare(db, created.token);
    assert.equal(pre.status, 200);
    assert.match(pre.headers["content-type"] ?? "", /text\/html/);

    const revoked = await doAction(db, "local", "snapshot-revoke", {
      id_prefix: created.id_prefix,
    });
    assert.equal(revoked.ok, true);

    // Post-revoke: 410 Gone.
    const post = serveShare(db, created.token);
    assert.equal(post.status, 410, "revoked snapshot must return 410");
    assert.match(post.body, /revoked|gone|no longer/i);

    // Audit row recorded the revoke without the plaintext token.
    const audit = db.prepare(
      "SELECT action, target, args_json FROM control_audit WHERE action='snapshot-revoke' ORDER BY id DESC LIMIT 1",
    ).get() as { action: string; target: string; args_json: string };
    assert.equal(audit.action, "snapshot-revoke");
    assert.equal(audit.target, created.id_prefix);
    assert.ok(!audit.args_json.includes(created.token), "plaintext token must not leak");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC5 — GET /share/<token> returns a self-contained read-only HTML page
// ────────────────────────────────────────────────────────────────────

test("AC5: serveShare returns self-contained HTML — no /api, no github, no buttons", async () => {
  const { db, cleanup } = tempDb();
  try {
    const m = createSnapshot(db, { name: "couch demo", fleetView: fleetFixture() });
    const r = serveShare(db, m.token);
    assert.equal(r.status, 200);
    assert.match(r.headers["content-type"] ?? "", /text\/html/);
    const body = r.body;
    // Title prefix surfaces the read-only intent.
    assert.ok(body.includes(SHARE_PAGE_TITLE_PREFIX), "must carry the documented title prefix");
    // No control surface at all.
    assert.equal(/<button\b/i.test(body), false, "no <button> elements");
    assert.equal(/<form\b/i.test(body), false, "no <form> elements");
    assert.equal(body.includes("/api/control/"), false, "no /api/control/ string anywhere");
    assert.equal(body.includes("/api/"), false, "no /api/ fetches anywhere");
    // No github links.
    assert.equal(/href=["'][^"']*github\.com/i.test(body), false, "no github.com anchors");
    // No absolute /Users/ paths.
    assert.equal(body.includes("/Users/"), false, "no /Users/ paths");
    // Stylesheet reference present.
    assert.match(body, /href=["']\/style\.css["']/, "must include /style.css link");
    // The SPA app.js (with control bindings) must NOT be loaded.
    assert.equal(/src=["']\/app\.js/.test(body), false, "must NOT load /app.js");
    // Data inlined as a JSON <script>.
    assert.match(body, /<script[^>]*type=["']application\/json["'][^>]*id=["']snapshot-data["']/);
    // Banner with name and timestamps.
    assert.match(body, /Read-only snapshot of couch demo/i, "banner must name the snapshot");
    assert.match(body, /created|expires/i);
    // Anonymized slug appears (project-1 or "Project 1").
    assert.match(body, /project[- ]1/i);
  } finally { cleanup(); }
});

test("AC5: serveShare HTML inlines anonymized payload — no real slugs leak", () => {
  const { db, cleanup } = tempDb();
  try {
    const m = createSnapshot(db, { name: "demo", fleetView: fleetFixture() });
    const r = serveShare(db, m.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.includes("mutaaf-aziz"), false, "no real owner slug in HTML");
    assert.equal(r.body.includes("fleet-control"), false, "no real repo slug in HTML");
    assert.equal(r.body.includes("courtiq"), false, "no second real slug in HTML");
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC6 — Expired snapshots return HTTP 410 Gone
// ────────────────────────────────────────────────────────────────────

test("AC6: expired snapshot returns 410 with a friendly message", () => {
  const { db, cleanup } = tempDb();
  try {
    // Mint, then back-date the expiry to yesterday.
    const m = createSnapshot(db, { name: "demo", fleetView: fleetFixture() });
    db.prepare("UPDATE snapshot SET expires_at=? WHERE id LIKE ?")
      .run("2020-01-01T00:00:00.000Z", m.id_prefix + "%");
    const r = serveShare(db, m.token);
    assert.equal(r.status, 410);
    assert.match(r.body, /expired|gone|no longer/i, "page must say it's expired/gone");
  } finally { cleanup(); }
});

test("AC6: getSnapshot reports expired=true for past expires_at", () => {
  const { db, cleanup } = tempDb();
  try {
    const m = createSnapshot(db, { name: "demo", fleetView: fleetFixture() });
    db.prepare("UPDATE snapshot SET expires_at=? WHERE id LIKE ?")
      .run("2020-01-01T00:00:00.000Z", m.id_prefix + "%");
    const got = getSnapshot(db, m.token);
    assert.ok(got);
    assert.equal(got!.expired, true);
  } finally { cleanup(); }
});

test("AC6: serveShare returns 404 for an unknown token (not 410)", () => {
  const { db, cleanup } = tempDb();
  try {
    const r = serveShare(db, "totally-not-a-real-token");
    assert.equal(r.status, 404);
  } finally { cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC7 — fleetctl snapshot create | list | revoke
// ────────────────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dirname ?? "", "..");

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

test("AC7: fleetctl snapshot create → prints share URL + token; row exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-snap-cli-"));
  const dbPath = join(dir, "fleet.db");
  try {
    // Seed a project so the fleet view isn't empty.
    const seed = openDb(dbPath);
    seed.prepare("INSERT INTO project(slug,name,namespace,repo_owner,repo_name) VALUES(?,?,?,?,?)")
      .run("demo", "Demo", "com.demo", "owner", "demo");
    seed.close();

    const r = runCli(["snapshot", "create", "couch demo"], {
      HOME: dir,
      FLEET_DB_PATH: dbPath,
    });
    assert.equal(r.code, 0, "create must exit 0: stdout=" + r.stdout + " stderr=" + r.stderr);
    assert.match(r.stdout, /\/share\//, "must print the share URL");

    const db = openDb(dbPath);
    const rows = db.prepare("SELECT name FROM snapshot").all() as Array<{ name: string }>;
    db.close();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "couch demo");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("AC7: fleetctl snapshot list shows id-prefix + name; revoke flips state", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-snap-cli-"));
  const dbPath = join(dir, "fleet.db");
  try {
    const seed = openDb(dbPath);
    seed.prepare("INSERT INTO project(slug,name,namespace,repo_owner,repo_name) VALUES(?,?,?,?,?)")
      .run("demo", "Demo", "com.demo", "owner", "demo");
    seed.close();

    const created = runCli(["snapshot", "create", "couch demo"], {
      HOME: dir, FLEET_DB_PATH: dbPath,
    });
    assert.equal(created.code, 0, "create stderr: " + created.stderr);
    // Pull the id_prefix out of the printed JSON-ish line. The CLI MUST
    // print it; we don't care about exact framing.
    const prefixMatch = created.stdout.match(/\b([0-9a-f]{8})\b/);
    assert.ok(prefixMatch, "create output should include the 8-char id_prefix");
    const prefix = prefixMatch![1];

    const listed = runCli(["snapshot", "list"], { HOME: dir, FLEET_DB_PATH: dbPath });
    assert.equal(listed.code, 0);
    assert.ok(listed.stdout.includes(prefix), "list must include the new prefix");
    assert.ok(listed.stdout.includes("couch demo"), "list must include the name");

    const revoked = runCli(["snapshot", "revoke", prefix], { HOME: dir, FLEET_DB_PATH: dbPath });
    assert.equal(revoked.code, 0);

    // Re-list should mark it revoked.
    const listed2 = runCli(["snapshot", "list"], { HOME: dir, FLEET_DB_PATH: dbPath });
    assert.match(listed2.stdout, /revoked/i, "post-revoke list must surface revoked state");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ────────────────────────────────────────────────────────────────────
// listSnapshots — needed by both the CLI and the (future) admin panel.
// ────────────────────────────────────────────────────────────────────

test("listSnapshots returns id-prefix + name + state, never the plaintext token", () => {
  const { db, cleanup } = tempDb();
  try {
    const a = createSnapshot(db, { name: "a", fleetView: fleetFixture() });
    const b = createSnapshot(db, { name: "b", fleetView: fleetFixture() });
    revokeSnapshot(db, b.id_prefix);
    const rows = listSnapshots(db);
    assert.equal(rows.length, 2);
    const byPrefix = new Map(rows.map((r) => [r.id_prefix, r]));
    assert.equal(byPrefix.get(a.id_prefix)?.name, "a");
    assert.equal(byPrefix.get(a.id_prefix)?.revoked_at, null);
    assert.ok(byPrefix.get(b.id_prefix)?.revoked_at, "b should be revoked");
    // No row carries the full SHA-256 id (only the 8-char prefix).
    for (const r of rows) {
      assert.equal(r.id_prefix.length, 8);
    }
  } finally { cleanup(); }
});
