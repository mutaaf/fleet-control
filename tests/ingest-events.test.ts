// Unit tests for src/ingest/events.ts — the typed-event ingest pipeline.
// Acceptance criteria from docs/backlog/0001-events-jsonl-ingest.md:
//   - new agent_event table with (slug, ts DESC) index
//   - watermark dedupe keyed per-slug under source='events:<slug>'
//   - malformed lines are tolerated (logged and skipped)
//   - idempotency: a second call inserts zero new rows
//   - the function exposes a count of newly-inserted rows
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { ingestEvents } from "../src/ingest/events.ts";

function fixtureCache(): { cacheBase: string; slug: string; eventsPath: string; cleanup: () => void } {
  const cacheBase = mkdtempSync(join(tmpdir(), "fleet-events-"));
  const slug = "demo";
  const dir = join(cacheBase, `${slug}-agent`);
  mkdirSync(dir, { recursive: true });
  const eventsPath = join(dir, "events.jsonl");
  return {
    cacheBase, slug, eventsPath,
    cleanup: () => rmSync(cacheBase, { recursive: true, force: true }),
  };
}

function tempDb(): { db: ReturnType<typeof openDb>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-evdb-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test("ingestEvents: 3 lines (one malformed) → 2 inserted, second pass → 0", () => {
  const { cacheBase, slug, eventsPath, cleanup } = fixtureCache();
  const { db, cleanup: dbClose } = tempDb();
  try {
    // 3 lines: two valid JSON objects, one malformed (not JSON).
    const lines = [
      JSON.stringify({ ts: "2026-05-26T12:00:00Z", phase: "ship", type: "run_started", pid: 11111 }),
      "{ this is not valid json",
      JSON.stringify({ ts: "2026-05-26T12:01:23Z", phase: "ship", type: "run_finished", exit: 0 }),
    ];
    writeFileSync(eventsPath, lines.join("\n") + "\n");

    const first = ingestEvents(db, slug, cacheBase);
    assert.equal(first, 2, "first pass should insert exactly the 2 well-formed lines");

    const rows = db.prepare("SELECT slug, ts, phase, type, payload_json FROM agent_event WHERE slug=? ORDER BY ts").all(slug) as any[];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].slug, slug);
    assert.equal(rows[0].type, "run_started");
    assert.equal(rows[0].phase, "ship");
    assert.equal(rows[1].type, "run_finished");
    // payload_json round-trips the original event object verbatim
    const p0 = JSON.parse(rows[0].payload_json);
    assert.equal(p0.pid, 11111);

    // second pass with no new bytes → zero new rows (watermark dedupe)
    const second = ingestEvents(db, slug, cacheBase);
    assert.equal(second, 0, "second pass without new bytes must insert nothing");
    const after = db.prepare("SELECT COUNT(*) AS n FROM agent_event WHERE slug=?").get(slug) as any;
    assert.equal(after.n, 2);
  } finally {
    dbClose(); cleanup();
  }
});

test("ingestEvents: appended lines after a pass pick up just the new ones", () => {
  const { cacheBase, slug, eventsPath, cleanup } = fixtureCache();
  const { db, cleanup: dbClose } = tempDb();
  try {
    writeFileSync(eventsPath, JSON.stringify({ ts: "2026-05-26T10:00:00Z", phase: "ship", type: "run_started" }) + "\n");
    assert.equal(ingestEvents(db, slug, cacheBase), 1);

    // Append two more events
    appendFileSync(eventsPath, JSON.stringify({ ts: "2026-05-26T10:00:30Z", phase: "ship", type: "tool_call", tool: "Edit" }) + "\n");
    appendFileSync(eventsPath, JSON.stringify({ ts: "2026-05-26T10:01:00Z", phase: "ship", type: "run_finished" }) + "\n");

    assert.equal(ingestEvents(db, slug, cacheBase), 2, "watermark advances; only new bytes ingested");
    const all = db.prepare("SELECT type FROM agent_event WHERE slug=? ORDER BY ts").all(slug) as any[];
    assert.deepEqual(all.map((r) => r.type), ["run_started", "tool_call", "run_finished"]);
  } finally {
    dbClose(); cleanup();
  }
});

test("ingestEvents: missing events.jsonl is a no-op", () => {
  const cacheBase = mkdtempSync(join(tmpdir(), "fleet-events-noop-"));
  const { db, cleanup: dbClose } = tempDb();
  try {
    // no project dir at all
    assert.equal(ingestEvents(db, "ghost", cacheBase), 0);
  } finally {
    dbClose(); rmSync(cacheBase, { recursive: true, force: true });
  }
});

test("agent_event table: (slug, ts DESC) index is created", () => {
  const { db, cleanup: dbClose } = tempDb();
  try {
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='agent_event'").all() as any[];
    const names = idx.map((r) => r.name);
    assert.ok(names.some((n) => /slug.*ts/i.test(n) || /agent_event_slug_ts/.test(n)),
      `expected an index over (slug, ts) on agent_event, got: ${names.join(", ") || "(none)"}`);
  } finally {
    dbClose();
  }
});
