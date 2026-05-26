// Unit tests for the ntfy push-notification dispatch (ticket 0009). Each
// test maps to one acceptance-criteria checkbox in
// docs/backlog/0009-ntfy-push.md.
//
// Strategy: stub `node:https` via an injected request factory
// (`setHttpsRequest`) — no monkey-patching of the global module, no real
// network. The fake captures the URL + headers + body each call so we can
// assert exactly one POST per dedup-key, exactly the JSON shape ntfy.sh
// expects, and that the function never throws on transport failures.
//
// Zero new deps; stdlib + node:test only. Lesson respected: each test
// resets the injection after the call so the next test sees a clean slate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { openDb, type DB } from "../src/db.ts";
import type { FleetConfig } from "../src/config.ts";
import {
  sendNtfy,
  setHttpsRequest,
  resetHttpsRequest,
  ntfyForAlert,
  ntfyForAnomaly,
  _resetDedupForTests,
  type NtfyConfig,
  type HttpsLikeRequest,
} from "../src/ntfy.ts";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Fake the request factory: every call resolves with `respond({status})`
 *  unless the test overrides `responder`. The captured-calls array lets
 *  tests assert N posts AND inspect the exact body sent. */
function fakeHttps(opts?: {
  status?: number;
  fail?: "error" | "timeout";
}): { calls: CapturedCall[]; factory: HttpsLikeRequest } {
  const calls: CapturedCall[] = [];
  const factory: HttpsLikeRequest = (urlStr, init, cb) => {
    // Build a writable-like that captures the body. We don't extend
    // node:http internals — just satisfy the small surface sendNtfy uses.
    let body = "";
    const req: any = new EventEmitter();
    req.write = (chunk: any) => { body += chunk?.toString() ?? ""; };
    req.end = () => {
      calls.push({
        url: urlStr,
        method: init.method ?? "GET",
        headers: (init.headers ?? {}) as Record<string, string>,
        body,
      });
      if (opts?.fail === "error") {
        // Schedule the error on next tick — matches real socket behavior.
        setImmediate(() => req.emit("error", new Error("ECONNREFUSED")));
        return;
      }
      if (opts?.fail === "timeout") {
        setImmediate(() => req.emit("timeout"));
        return;
      }
      // Success path: synthesize an IncomingMessage-like object.
      const res: any = new EventEmitter();
      res.statusCode = opts?.status ?? 200;
      setImmediate(() => { cb(res); res.emit("end"); });
    };
    req.setTimeout = (_ms: number, _onTimeout?: () => void) => { /* no-op */ };
    req.destroy = () => { /* no-op */ };
    return req;
  };
  return { calls, factory };
}

function tempDb(): { db: DB; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-ntfydb-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function baseCfg(): FleetConfig {
  return {
    projectRoots: [],
    installedRoot: "/tmp/installed",
    dbPath: "/tmp/x.db",
    cacheBase: "/tmp/cache",
    claudeProjects: "/tmp/claude",
    host: "127.0.0.1",
    port: 7070,
  };
}

// ────────────────────────────────────────────────────────────────────────
// AC #1: sendNtfy POSTs JSON to https://ntfy.sh/<topic>, returns {ok,status}
// ────────────────────────────────────────────────────────────────────────
test("sendNtfy: POSTs JSON body to ntfy.sh/<topic> and returns {ok:true,status:200}", async () => {
  const { calls, factory } = fakeHttps({ status: 200 });
  setHttpsRequest(factory);
  try {
    const r = await sendNtfy("fleet-test-topic", {
      title: "hello",
      message: "world",
      priority: 5,
      tags: ["fire"],
      click: "http://127.0.0.1:7070/#/p/almanac",
    });
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(calls.length, 1, "exactly one POST");
    assert.equal(calls[0].url, "https://ntfy.sh/fleet-test-topic");
    assert.equal(calls[0].method, "POST");
    // Body is JSON the ntfy server accepts (POST to /<topic> with JSON body).
    const sent = JSON.parse(calls[0].body);
    assert.equal(sent.title, "hello");
    assert.equal(sent.message, "world");
    assert.equal(sent.priority, 5);
    assert.deepEqual(sent.tags, ["fire"]);
    assert.equal(sent.click, "http://127.0.0.1:7070/#/p/almanac");
    // Topic ends up either in body.topic OR encoded in the URL — ntfy accepts both.
    if (sent.topic !== undefined) assert.equal(sent.topic, "fleet-test-topic");
  } finally { resetHttpsRequest(); }
});

// ────────────────────────────────────────────────────────────────────────
// AC #2: empty/missing ntfyTopic → no-op, never opens a socket
// ────────────────────────────────────────────────────────────────────────
test("sendNtfy: empty topic returns {ok:true,error:'disabled'} and makes ZERO requests", async () => {
  const { calls, factory } = fakeHttps({ status: 200 });
  setHttpsRequest(factory);
  try {
    const r1 = await sendNtfy("", { title: "x", message: "y", priority: 3 });
    assert.equal(r1.ok, true, "disabled is still ok:true (no caller-side failure)");
    assert.equal(r1.status, 0);
    assert.equal(r1.error, "disabled");
    // undefined-as-string would be a config-loader bug; sendNtfy must defend.
    const r2 = await sendNtfy(undefined as unknown as string, { title: "x", message: "y", priority: 3 });
    assert.equal(r2.ok, true);
    assert.equal(r2.error, "disabled");
    assert.equal(calls.length, 0, "no socket attempts when topic is unset");
  } finally { resetHttpsRequest(); }
});

// ────────────────────────────────────────────────────────────────────────
// AC #3: alert dispatch dedups per (dedup_key); 2 inserts → 1 POST
// AC #3b: severity → priority mapping (critical=5, warn=3)
// ────────────────────────────────────────────────────────────────────────
test("ntfyForAlert: critical → priority 5; warn → priority 3", async () => {
  _resetDedupForTests();
  const { calls, factory } = fakeHttps({ status: 200 });
  setHttpsRequest(factory);
  const { db, cleanup } = tempDb();
  try {
    db.prepare("INSERT INTO project(slug,name,namespace) VALUES (?,?,?)").run("almanac", "almanac", "ns");
    const pid = (db.prepare("SELECT id FROM project WHERE slug=?").get("almanac") as any).id;
    const ncfg: NtfyConfig = { topic: "tfleet", portalUrl: "http://127.0.0.1:7070/#/p/" };
    const cfg = baseCfg();

    await ntfyForAlert(db, cfg, ncfg, {
      project_id: pid, phase: null, type: "self_cancel",
      severity: "critical", title: "almanac stopped", detail: "extend it",
      dedup_key: "self_cancel:almanac:passed",
    });
    await ntfyForAlert(db, cfg, ncfg, {
      project_id: pid, phase: "ship", type: "hung_run",
      severity: "warn", title: "almanac: ship running 30m", detail: "auto-killed",
      dedup_key: "hung:almanac:ship:2026-05-26T10",
    });

    assert.equal(calls.length, 2, "two distinct dedup keys → two POSTs");
    const a = JSON.parse(calls[0].body);
    const b = JSON.parse(calls[1].body);
    assert.equal(a.priority, 5, "critical maps to ntfy priority 5");
    assert.equal(b.priority, 3, "warn maps to ntfy priority 3");
    // Both must use the configured topic.
    assert.ok(calls[0].url.endsWith("/tfleet"));
    assert.ok(calls[1].url.endsWith("/tfleet"));
  } finally { resetHttpsRequest(); cleanup(); }
});

test("ntfyForAlert: same dedup_key fired twice → only ONE POST (lifetime dedup)", async () => {
  _resetDedupForTests();
  const { calls, factory } = fakeHttps({ status: 200 });
  setHttpsRequest(factory);
  const { db, cleanup } = tempDb();
  try {
    db.prepare("INSERT INTO project(slug,name,namespace) VALUES (?,?,?)").run("almanac", "almanac", "ns");
    const pid = (db.prepare("SELECT id FROM project WHERE slug=?").get("almanac") as any).id;
    const ncfg: NtfyConfig = { topic: "tfleet", portalUrl: "http://127.0.0.1:7070/#/p/" };
    const cfg = baseCfg();
    const a = {
      project_id: pid, phase: null, type: "self_cancel",
      severity: "critical", title: "almanac stopped", detail: "extend it",
      dedup_key: "self_cancel:almanac:passed",
    };
    await ntfyForAlert(db, cfg, ncfg, a);
    await ntfyForAlert(db, cfg, ncfg, a);
    assert.equal(calls.length, 1, "second insert of the same dedup_key must NOT POST again");
  } finally { resetHttpsRequest(); cleanup(); }
});

// ────────────────────────────────────────────────────────────────────────
// AC #4: anomaly insert → ntfy POST (separate dedup namespace from alerts)
// ────────────────────────────────────────────────────────────────────────
test("ntfyForAnomaly: fires a POST per new anomaly row, deduped by run_id+kind", async () => {
  _resetDedupForTests();
  const { calls, factory } = fakeHttps({ status: 200 });
  setHttpsRequest(factory);
  const { db, cleanup } = tempDb();
  try {
    db.prepare("INSERT INTO project(slug,name,namespace) VALUES (?,?,?)").run("almanac", "almanac", "ns");
    const pid = (db.prepare("SELECT id FROM project WHERE slug=?").get("almanac") as any).id;
    const ncfg: NtfyConfig = { topic: "tfleet", portalUrl: "http://127.0.0.1:7070/#/p/" };
    const cfg = baseCfg();

    await ntfyForAnomaly(db, cfg, ncfg, {
      project_id: pid,
      run_id: 42, kind: "duration",
      value: 60_000, baseline_mean: 10_000, stddev_multiplier: 5.2,
      candidate_reason: "repeated tool errors",
    });
    // Re-fire on the same (run_id, kind) is a dedup hit.
    await ntfyForAnomaly(db, cfg, ncfg, {
      project_id: pid,
      run_id: 42, kind: "duration",
      value: 60_000, baseline_mean: 10_000, stddev_multiplier: 5.2,
      candidate_reason: "repeated tool errors",
    });
    assert.equal(calls.length, 1, "anomaly dedup is per (run_id, kind)");
    const body = JSON.parse(calls[0].body);
    assert.ok(/anomaly|σ|sigma/i.test(body.message + " " + body.title), "message names the anomaly");
  } finally { resetHttpsRequest(); cleanup(); }
});

test("ntfyForAnomaly: with no ntfyTopic configured → no POST (does not break)", async () => {
  _resetDedupForTests();
  const { calls, factory } = fakeHttps({ status: 200 });
  setHttpsRequest(factory);
  const { db, cleanup } = tempDb();
  try {
    db.prepare("INSERT INTO project(slug,name,namespace) VALUES (?,?,?)").run("almanac", "almanac", "ns");
    const pid = (db.prepare("SELECT id FROM project WHERE slug=?").get("almanac") as any).id;
    const cfg = baseCfg();
    const ncfg: NtfyConfig = { topic: "", portalUrl: "http://127.0.0.1:7070/#/p/" };
    await ntfyForAnomaly(db, cfg, ncfg, {
      project_id: pid, run_id: 1, kind: "duration",
      value: 60_000, baseline_mean: 10_000, stddev_multiplier: 5.2,
      candidate_reason: null,
    });
    assert.equal(calls.length, 0, "ntfy disabled → silent no-op even when anomalies fire");
  } finally { resetHttpsRequest(); cleanup(); }
});

// ────────────────────────────────────────────────────────────────────────
// AC #5: click URL points at portalUrl + slug; default 127.0.0.1
// ────────────────────────────────────────────────────────────────────────
test("ntfyForAlert: click URL is portalUrl + project slug", async () => {
  _resetDedupForTests();
  const { calls, factory } = fakeHttps({ status: 200 });
  setHttpsRequest(factory);
  const { db, cleanup } = tempDb();
  try {
    db.prepare("INSERT INTO project(slug,name,namespace) VALUES (?,?,?)").run("almanac", "almanac", "ns");
    const pid = (db.prepare("SELECT id FROM project WHERE slug=?").get("almanac") as any).id;
    const ncfg: NtfyConfig = { topic: "tfleet", portalUrl: "https://portal.example.com/#/p/" };
    const cfg = baseCfg();
    await ntfyForAlert(db, cfg, ncfg, {
      project_id: pid, phase: null, type: "self_cancel",
      severity: "critical", title: "almanac stopped", detail: "extend it",
      dedup_key: "self_cancel:almanac:passed",
    });
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0].body);
    assert.equal(body.click, "https://portal.example.com/#/p/almanac",
      "click must use the configured portalUrl with the project slug appended");
  } finally { resetHttpsRequest(); cleanup(); }
});

// ────────────────────────────────────────────────────────────────────────
// AC #6: transport failure → {ok:false}, caller proceeds (never throws)
// ────────────────────────────────────────────────────────────────────────
test("sendNtfy: socket error returns {ok:false,error:...} and does not throw", async () => {
  const { factory } = fakeHttps({ fail: "error" });
  setHttpsRequest(factory);
  try {
    let threw = false;
    let result;
    try {
      result = await sendNtfy("fleet-t", { title: "x", message: "y", priority: 3 });
    } catch { threw = true; }
    assert.equal(threw, false, "sendNtfy MUST NOT throw on transport failure");
    assert.equal(result?.ok, false);
    assert.ok(result?.error, "error message must be populated");
  } finally { resetHttpsRequest(); }
});

test("sendNtfy: non-2xx response returns {ok:false,status:N}", async () => {
  const { factory } = fakeHttps({ status: 503 });
  setHttpsRequest(factory);
  try {
    const r = await sendNtfy("fleet-t", { title: "x", message: "y", priority: 3 });
    assert.equal(r.ok, false, "5xx is a transport-level failure for the caller");
    assert.equal(r.status, 503);
  } finally { resetHttpsRequest(); }
});

// ────────────────────────────────────────────────────────────────────────
// AC #7: `fleetctl ntfy test` exits 0 on success, 1 on failure
// (We unit-test the underlying helper that the CLI subcommand calls.
// The CLI dispatch itself is just `switch (cmd)`; the helper IS the test.)
// ────────────────────────────────────────────────────────────────────────
test("ntfyTestCommand: success → exit 0", async () => {
  const { factory } = fakeHttps({ status: 200 });
  setHttpsRequest(factory);
  try {
    const { ntfyTestCommand } = await import("../src/ntfy.ts");
    const code = await ntfyTestCommand({ topic: "fleet-t", portalUrl: "http://127.0.0.1:7070/#/p/" });
    assert.equal(code, 0);
  } finally { resetHttpsRequest(); }
});

test("ntfyTestCommand: disabled (no topic) → exit 1 with a printed reason", async () => {
  const { factory } = fakeHttps({ status: 200 });
  setHttpsRequest(factory);
  try {
    const { ntfyTestCommand } = await import("../src/ntfy.ts");
    const code = await ntfyTestCommand({ topic: "", portalUrl: "http://127.0.0.1:7070/#/p/" });
    assert.equal(code, 1, "no topic configured is a setup failure for `ntfy test`");
  } finally { resetHttpsRequest(); }
});

test("ntfyTestCommand: transport failure → exit 1", async () => {
  const { factory } = fakeHttps({ fail: "error" });
  setHttpsRequest(factory);
  try {
    const { ntfyTestCommand } = await import("../src/ntfy.ts");
    const code = await ntfyTestCommand({ topic: "fleet-t", portalUrl: "http://127.0.0.1:7070/#/p/" });
    assert.equal(code, 1);
  } finally { resetHttpsRequest(); }
});
