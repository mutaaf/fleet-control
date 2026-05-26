// Covers two more ACs from docs/backlog/0003-scoped-tokens-audit.md:
//   - control_audit rows record the token's `name` in `actor_name`
//   - tokens-add and tokens-revoke flow through doAction() and write audit
//     rows themselves (so a stolen token's misuse leaves a trail)
//
// We don't actually shell out to launchctl — instead we exercise the
// tokens-* actions which are pure DB writes, and assert the audit columns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { doAction } from "../src/control.ts";

function tempDb(): { db: ReturnType<typeof openDb>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-audit-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("doAction(tokens-add): mints a token, writes a control_audit row with actor_name", async () => {
  const { db, cleanup } = tempDb();
  try {
    const r = await doAction(db, "lan", "tokens-add", { name: "phone", scope: "read" }, "laptop");
    assert.equal(r.ok, true, r.message);
    // The response includes the plaintext token once.
    const payload = JSON.parse(r.output ?? "{}");
    assert.ok(payload.token, "tokens-add must return the plaintext token once");
    assert.equal(payload.name, "phone");
    assert.equal(payload.scope, "read");

    const audit = db.prepare(
      "SELECT actor, actor_name, action, target FROM control_audit ORDER BY id DESC LIMIT 1",
    ).get() as any;
    assert.equal(audit.action, "tokens-add");
    assert.equal(audit.actor, "lan");
    assert.equal(audit.actor_name, "laptop", "actor_name should be the calling token's name");
    assert.match(audit.target, /^phone\/read$/);
    // The audit row's args_json must NOT contain the plaintext token.
    const argRow = db.prepare("SELECT args_json FROM control_audit ORDER BY id DESC LIMIT 1").get() as any;
    assert.ok(!argRow.args_json.includes(payload.token), "plaintext token leaked into audit args_json");
  } finally { cleanup(); }
});

test("doAction(tokens-revoke): records the revocation in control_audit", async () => {
  const { db, cleanup } = tempDb();
  try {
    const minted = await doAction(db, "lan", "tokens-add", { name: "tablet", scope: "control" }, "laptop");
    const payload = JSON.parse(minted.output ?? "{}");
    const prefix = payload.id_prefix;
    assert.ok(prefix);

    const r = await doAction(db, "lan", "tokens-revoke", { id_prefix: prefix }, "laptop");
    assert.equal(r.ok, true);

    const audits = db.prepare(
      "SELECT action, actor_name, target FROM control_audit ORDER BY id",
    ).all() as any[];
    assert.equal(audits.length, 2);
    assert.equal(audits[1].action, "tokens-revoke");
    assert.equal(audits[1].actor_name, "laptop");
    assert.equal(audits[1].target, prefix);
  } finally { cleanup(); }
});

test("doAction: bad scope on tokens-add → ok:false, audit row with exit_code=1", async () => {
  const { db, cleanup } = tempDb();
  try {
    const r = await doAction(db, "lan", "tokens-add", { name: "x", scope: "root" }, "laptop");
    assert.equal(r.ok, false);
    assert.match(r.message, /scope/i);
    const audit = db.prepare("SELECT exit_code, action FROM control_audit ORDER BY id DESC LIMIT 1").get() as any;
    assert.equal(audit.action, "tokens-add");
    assert.equal(audit.exit_code, 1, "failed mint should still record an audit row");
  } finally { cleanup(); }
});

test("doAction: actor_name defaults to 'local' for local actor when no name passed", async () => {
  const { db, cleanup } = tempDb();
  try {
    // Simulate a CLI/loopback call: actor=local, no explicit actorName.
    const r = await doAction(db, "local", "tokens-add", { name: "from-cli", scope: "read" });
    assert.equal(r.ok, true);
    const audit = db.prepare("SELECT actor, actor_name FROM control_audit ORDER BY id DESC LIMIT 1").get() as any;
    assert.equal(audit.actor, "local");
    assert.equal(audit.actor_name, "local", "local actor with no explicit name should fall back to 'local'");
  } finally { cleanup(); }
});

test("doAction: unknown control action rejects (KNOWN_ACTIONS gate still holds)", async () => {
  const { db, cleanup } = tempDb();
  try {
    await assert.rejects(
      () => doAction(db, "lan", "rm-rf-everything", {}, "laptop"),
      /unknown action/,
    );
  } finally { cleanup(); }
});
