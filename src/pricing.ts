// Token -> dollar estimates. Agents run on the Max plan (no per-call bill), so
// these are ESTIMATED effort, not an invoice. Values are $ per 1M tokens and are
// loaded from data/anthropic-pricing.json via syncPricing() (ticket 0004);
// DEFAULT_PRICING below is the seed used the very first time the DB opens,
// before any sync has happened.
import { readFileSync, existsSync } from "node:fs";
import type { DB } from "./db.ts";

export interface Price {
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_write_per_mtok: number;
  cache_read_per_mtok: number;
  note: string;
}

/** A pricing row as exposed by /api/pricing — adds the sync timestamp the
 *  portal footer needs to render "synced Xh ago" + the stale-warning flag. */
export interface PriceRow extends Price {
  fetched_at: string | null;
}

// Defaults (estimates). Matched by longest model-prefix.
export const DEFAULT_PRICING: Price[] = [
  { model: "claude-opus-4",   input_per_mtok: 15, output_per_mtok: 75, cache_write_per_mtok: 18.75, cache_read_per_mtok: 1.5,  note: "estimate" },
  { model: "claude-sonnet-4", input_per_mtok: 3,  output_per_mtok: 15, cache_write_per_mtok: 3.75,  cache_read_per_mtok: 0.3,  note: "estimate" },
  { model: "claude-haiku-4",  input_per_mtok: 0.8,output_per_mtok: 4,  cache_write_per_mtok: 1.0,   cache_read_per_mtok: 0.08, note: "estimate" },
];

export function seedPricing(db: DB): void {
  const up = db.prepare(
    "INSERT INTO pricing(model,input_per_mtok,output_per_mtok,cache_write_per_mtok,cache_read_per_mtok,note) "
    + "VALUES(?,?,?,?,?,?) ON CONFLICT(model) DO NOTHING",
  );
  for (const p of DEFAULT_PRICING)
    up.run(p.model, p.input_per_mtok, p.output_per_mtok, p.cache_write_per_mtok, p.cache_read_per_mtok, p.note);
}

/** Default path of the in-repo bootstrap pricing file (ticket 0004). */
export const DEFAULT_PRICING_FILE = "data/anthropic-pricing.json";

/** Shape of one entry in data/anthropic-pricing.json. */
interface PricingFileEntry {
  id: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_read_per_mtok: number;
  cache_write_per_mtok: number;
  note?: string;
}

/** Load Anthropic pricing from a JSON file and upsert every model into the
 *  `pricing` table. Stamps `fetched_at` with the current wall-clock so the
 *  portal footer can show "Pricing synced Xh ago" and badge stale costs.
 *
 *  Returns the number of model rows that were upserted. A missing file or
 *  malformed JSON is a no-op (returns 0) — we never want a bad fixture to
 *  empty the table mid-run.
 *
 *  Defaults to `data/anthropic-pricing.json` relative to CWD when no path
 *  is given. A follow-up ticket can swap this for a live HTTP fetch. */
export function syncPricing(db: DB, file?: string): number {
  const path = file ?? DEFAULT_PRICING_FILE;
  if (!existsSync(path)) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return 0;
  }
  const models = extractModels(parsed);
  if (!models.length) return 0;

  const now = new Date().toISOString();
  // Upsert every model; on conflict, refresh every numeric field AND
  // fetched_at so re-runs surface drift to the portal.
  const up = db.prepare(
    "INSERT INTO pricing(model,input_per_mtok,output_per_mtok,cache_write_per_mtok,cache_read_per_mtok,note,fetched_at) "
    + "VALUES(?,?,?,?,?,?,?) "
    + "ON CONFLICT(model) DO UPDATE SET "
    + "input_per_mtok=excluded.input_per_mtok, "
    + "output_per_mtok=excluded.output_per_mtok, "
    + "cache_write_per_mtok=excluded.cache_write_per_mtok, "
    + "cache_read_per_mtok=excluded.cache_read_per_mtok, "
    + "note=excluded.note, "
    + "fetched_at=excluded.fetched_at",
  );
  let n = 0;
  for (const m of models) {
    up.run(
      m.id,
      m.input_per_mtok,
      m.output_per_mtok,
      m.cache_write_per_mtok,
      m.cache_read_per_mtok,
      m.note ?? "synced",
      now,
    );
    n += 1;
  }
  // Bust the rate-cache so the next computeCost() sees the new numbers.
  cache = null;
  return n;
}

/** Pull the well-formed model entries out of a parsed JSON blob. Tolerant of
 *  partial rows — silently drops any entry missing a required numeric field
 *  so one typo in the pricing file can't poison the rest of the table. */
function extractModels(parsed: unknown): PricingFileEntry[] {
  if (!parsed || typeof parsed !== "object") return [];
  const obj = parsed as { models?: unknown };
  if (!Array.isArray(obj.models)) return [];
  const out: PricingFileEntry[] = [];
  for (const raw of obj.models) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id) continue;
    const nums = ["input_per_mtok", "output_per_mtok", "cache_read_per_mtok", "cache_write_per_mtok"] as const;
    if (!nums.every((k) => typeof r[k] === "number" && Number.isFinite(r[k] as number))) continue;
    out.push({
      id: r.id,
      input_per_mtok: r.input_per_mtok as number,
      output_per_mtok: r.output_per_mtok as number,
      cache_read_per_mtok: r.cache_read_per_mtok as number,
      cache_write_per_mtok: r.cache_write_per_mtok as number,
      note: typeof r.note === "string" ? r.note : undefined,
    });
  }
  return out;
}

/** Return every pricing row, suitable for /api/pricing JSON serialization. */
export function pricingRows(db: DB): PriceRow[] {
  return db.prepare(
    "SELECT model, input_per_mtok, output_per_mtok, cache_write_per_mtok, cache_read_per_mtok, note, fetched_at "
    + "FROM pricing ORDER BY model",
  ).all() as unknown as PriceRow[];
}

/** Most recent fetched_at across all rows, or null if the table is unsynced.
 *  The /api/pricing route exposes this so the SPA footer can render "synced
 *  Xh ago" without a second query. */
export function lastSyncedAt(db: DB): string | null {
  const row = db.prepare("SELECT MAX(fetched_at) AS ts FROM pricing").get() as { ts: string | null };
  return row?.ts ?? null;
}

let cache: Price[] | null = null;
function priced(db: DB): Price[] {
  if (!cache) cache = db.prepare("SELECT * FROM pricing").all() as unknown as Price[];
  return cache;
}

function rateFor(db: DB, model: string | null): Price {
  const rows = priced(db);
  const m = model ?? "claude-opus-4-7";
  // longest matching prefix wins; fall back to opus
  let best: Price | undefined;
  for (const r of rows) if (m.startsWith(r.model) && (!best || r.model.length > best.model.length)) best = r;
  return best ?? rows.find((r) => r.model.startsWith("claude-opus")) ?? rows[0];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}

export function computeCost(db: DB, model: string | null, u: Usage): number {
  const r = rateFor(db, model);
  return (
    (u.input_tokens / 1e6) * r.input_per_mtok +
    (u.output_tokens / 1e6) * r.output_per_mtok +
    (u.cache_creation_tokens / 1e6) * r.cache_write_per_mtok +
    (u.cache_read_tokens / 1e6) * r.cache_read_per_mtok
  );
}
