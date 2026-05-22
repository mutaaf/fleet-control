// Token -> dollar estimates. Agents run on the Max plan (no per-call bill), so
// these are ESTIMATED effort, not an invoice. Values are $ per 1M tokens and are
// configurable; seed with current public Claude rates. Cache-read dominates
// these runs, so its rate matters most. (Open item: confirm exact Opus 4.7 rates.)
import type { DB } from "./db.ts";

export interface Price {
  model: string;
  input_per_mtok: number;
  output_per_mtok: number;
  cache_write_per_mtok: number;
  cache_read_per_mtok: number;
  note: string;
}

// Defaults (estimates). Matched by longest model-prefix.
export const DEFAULT_PRICING: Price[] = [
  { model: "claude-opus-4",   input_per_mtok: 15, output_per_mtok: 75, cache_write_per_mtok: 18.75, cache_read_per_mtok: 1.5,  note: "estimate" },
  { model: "claude-sonnet-4", input_per_mtok: 3,  output_per_mtok: 15, cache_write_per_mtok: 3.75,  cache_read_per_mtok: 0.3,  note: "estimate" },
  { model: "claude-haiku-4",  input_per_mtok: 0.8,output_per_mtok: 4,  cache_write_per_mtok: 1.0,   cache_read_per_mtok: 0.08, note: "estimate" },
];

export function seedPricing(db: DB): void {
  const up = db.prepare(
    `INSERT INTO pricing(model,input_per_mtok,output_per_mtok,cache_write_per_mtok,cache_read_per_mtok,note)
     VALUES(?,?,?,?,?,?) ON CONFLICT(model) DO NOTHING`,
  );
  for (const p of DEFAULT_PRICING)
    up.run(p.model, p.input_per_mtok, p.output_per_mtok, p.cache_write_per_mtok, p.cache_read_per_mtok, p.note);
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
