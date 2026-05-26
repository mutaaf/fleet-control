// Unit tests for src/pricing.ts:syncPricing — the bootstrap-source-of-truth
// loader for Anthropic model pricing (ticket 0004). Each test maps to one
// acceptance-criteria checkbox in docs/backlog/0004-live-pricing-sync.md.
//
// Notes:
//   - Zero new deps. Stdlib only.
//   - No sleep-guess timing; if a test needs to observe a `fetched_at`
//     advance we poll with waitFor(predicate, maxMs) (lesson: 2026-05-26
//     "node test-runner timing is jittery; poll, don't sleep").
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { syncPricing, pricingRows } from "../src/pricing.ts";

function tempDb(): { db: ReturnType<typeof openDb>; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-pricedb-"));
  const path = join(dir, "fleet.db");
  const db = openDb(path);
  return { db, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

function tempPricingFile(payload: unknown): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-priceJson-"));
  const path = join(dir, "anthropic-pricing.json");
  writeFileSync(path, JSON.stringify(payload));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Poll a predicate until true or timeout; returns true if it ever held. */
async function waitFor(predicate: () => boolean, maxMs = 1000, stepMs = 20): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
}

test("pricing table: fetched_at column exists after openDb (AC: ALTER TABLE added the column)", () => {
  const { db, cleanup } = tempDb();
  try {
    const cols = db.prepare("PRAGMA table_info(pricing)").all() as any[];
    const names = cols.map((c) => c.name);
    assert.ok(names.includes("fetched_at"), `expected 'fetched_at' on pricing, got: ${names.join(", ")}`);
  } finally { cleanup(); }
});

test("syncPricing: inserts a row per model and stamps fetched_at", () => {
  const { db, cleanup } = tempDb();
  const { path, cleanup: rmJson } = tempPricingFile({
    models: [
      { id: "claude-opus-4-7", input_per_mtok: 15.00, output_per_mtok: 75.00, cache_read_per_mtok: 1.50, cache_write_per_mtok: 18.75 },
      { id: "claude-sonnet-4", input_per_mtok:  3.00, output_per_mtok: 15.00, cache_read_per_mtok: 0.30, cache_write_per_mtok:  3.75 },
    ],
  });
  try {
    const n = syncPricing(db, path);
    assert.equal(n, 2, "two fixture rows should be upserted");

    const rows = db.prepare("SELECT model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, fetched_at FROM pricing ORDER BY model").all() as any[];
    assert.equal(rows.length, 2);
    assert.equal(rows[0].model, "claude-opus-4-7");
    assert.equal(rows[0].input_per_mtok, 15);
    assert.equal(rows[0].output_per_mtok, 75);
    assert.equal(rows[0].cache_read_per_mtok, 1.5);
    assert.equal(rows[0].cache_write_per_mtok, 18.75);
    assert.ok(rows[0].fetched_at, "fetched_at should be populated on insert");
    // The stamp is an ISO string.
    assert.ok(!Number.isNaN(Date.parse(rows[0].fetched_at)), "fetched_at must parse as a date");
  } finally { rmJson(); cleanup(); }
});

test("syncPricing: changed value on re-run updates the row and advances fetched_at", async () => {
  const { db, cleanup } = tempDb();
  const { path, cleanup: rmJson } = tempPricingFile({
    models: [{ id: "claude-opus-4-7", input_per_mtok: 15, output_per_mtok: 75, cache_read_per_mtok: 1.5, cache_write_per_mtok: 18.75 }],
  });
  try {
    syncPricing(db, path);
    const first = db.prepare("SELECT input_per_mtok, fetched_at FROM pricing WHERE model=?").get("claude-opus-4-7") as any;
    assert.equal(first.input_per_mtok, 15);
    const firstStamp = first.fetched_at as string;
    assert.ok(firstStamp);

    // Rewrite the fixture with a changed price.
    writeFileSync(path, JSON.stringify({
      models: [{ id: "claude-opus-4-7", input_per_mtok: 17.5, output_per_mtok: 80, cache_read_per_mtok: 1.75, cache_write_per_mtok: 20.0 }],
    }));

    // Poll until the wall clock has moved past the first stamp's second, so a
    // re-run produces a strictly newer ISO string (the implementation uses
    // new Date().toISOString() so ms granularity is enough but a jittery
    // runner can still tie — wait the predicate out, not a fixed sleep).
    await waitFor(() => new Date().toISOString() > firstStamp, 1500, 10);

    syncPricing(db, path);
    const second = db.prepare("SELECT input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok, fetched_at FROM pricing WHERE model=?").get("claude-opus-4-7") as any;
    assert.equal(second.input_per_mtok, 17.5, "input rate must update on re-sync");
    assert.equal(second.output_per_mtok, 80);
    assert.equal(second.cache_read_per_mtok, 1.75);
    assert.equal(second.cache_write_per_mtok, 20.0);
    assert.ok(second.fetched_at > firstStamp, `fetched_at should advance: ${second.fetched_at} > ${firstStamp}`);

    // And still exactly one row for that model — upsert, not insert.
    const count = db.prepare("SELECT COUNT(*) AS n FROM pricing WHERE model=?").get("claude-opus-4-7") as any;
    assert.equal(count.n, 1, "must upsert, not duplicate");
  } finally { rmJson(); cleanup(); }
});

test("pricingRows: returns the upserted table as JSON-ready objects", () => {
  const { db, cleanup } = tempDb();
  const { path, cleanup: rmJson } = tempPricingFile({
    models: [
      { id: "claude-haiku-4", input_per_mtok: 0.8, output_per_mtok: 4, cache_read_per_mtok: 0.08, cache_write_per_mtok: 1.0 },
    ],
  });
  try {
    syncPricing(db, path);
    const rows = pricingRows(db);
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.model, "claude-haiku-4");
    assert.equal(r.input_per_mtok, 0.8);
    assert.equal(r.cache_read_per_mtok, 0.08);
    assert.ok(typeof r.fetched_at === "string" && r.fetched_at.length > 0);
  } finally { rmJson(); cleanup(); }
});

test("syncPricing: tolerates a missing pricing JSON (returns 0; no throw)", () => {
  const { db, cleanup } = tempDb();
  try {
    const n = syncPricing(db, join(tmpdir(), "definitely-not-here-" + Date.now() + ".json"));
    assert.equal(n, 0, "missing file should be a no-op, not a throw");
    const count = db.prepare("SELECT COUNT(*) AS n FROM pricing").get() as any;
    assert.equal(count.n, 0);
  } finally { cleanup(); }
});

test("syncPricing: malformed JSON does not corrupt the table", () => {
  const dir = mkdtempSync(join(tmpdir(), "fleet-priceBad-"));
  const path = join(dir, "anthropic-pricing.json");
  writeFileSync(path, "{ not valid json at all");
  const { db, cleanup } = tempDb();
  try {
    const n = syncPricing(db, path);
    assert.equal(n, 0, "malformed JSON must be a no-op");
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("data/anthropic-pricing.json: ships in-repo with the documented shape", () => {
  // The ticket pins this file as the bootstrap source of truth, so a regression
  // here (missing file, wrong shape) should break CI rather than silently
  // empty the pricing table on every fresh deploy.
  const { db, cleanup } = tempDb();
  const repoFile = join(process.cwd(), "data", "anthropic-pricing.json");
  try {
    const n = syncPricing(db, repoFile);
    assert.ok(n >= 1, `expected at least one model in data/anthropic-pricing.json, got ${n}`);
    const opus = db.prepare("SELECT * FROM pricing WHERE model=?").get("claude-opus-4-7") as any;
    assert.ok(opus, "the repo fixture must include claude-opus-4-7 (the default model)");
    assert.ok(opus.input_per_mtok > 0);
    assert.ok(opus.output_per_mtok > 0);
    assert.ok(opus.fetched_at);
  } finally { cleanup(); }
});
