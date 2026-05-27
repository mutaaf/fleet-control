// Embeddable status badge SVG per project (ticket 0015).
//
// Pure helpers — no DB writes, no shell-out, no network. The HTTP route
// in src/server.ts wraps these for /badge/<slug>.svg. The same helpers
// power the "Embed" panel in the SPA (the panel just stamps the URL;
// it never fetches the SVG from JS).
//
// Design notes (per ticket 0015 + AGENTS.md):
//   - Zero new runtime deps. Hand-rolled SVG string, no template engine.
//   - Stable layout: text widths approximated by char-count × 6.5px so a
//     fresh value never re-wraps in a README's image renderer. There is
//     no font-metrics library and there isn't going to be one.
//   - Colors are Shields-style flat fills, hardcoded as four constants
//     so the metric → color decision lives in one branch per metric.
//   - The SVG body is host-neutral: no URL, no hostname, no IP literal.
//     The operator's pasted markdown carries the host; the bytes don't.
//     A cached badge served from anywhere still tells the truth about
//     the underlying metric.

import type { DB } from "./db.ts";

// ────────────────────────────────────────────────────────────────────
// Public types + constants
// ────────────────────────────────────────────────────────────────────

/** The three metrics the badge route supports in v1. Anything else
 *  is a 400 at the route layer. */
export type BadgeMetric = "status" | "cost" | "ship";

export const BADGE_METRICS: readonly BadgeMetric[] = ["status", "cost", "ship"] as const;

/** Shields-style flat palette. The hex values match the ticket's
 *  engineering note verbatim — these are the only four colors the
 *  badge can render in v1. Per-badge custom colors are explicitly
 *  out of scope. */
export const BADGE_COLORS = {
  green: "#3ba55d",
  yellow: "#dfb317",
  red: "#e05d44",
  grey: "#9f9f9f",
} as const;

export interface BadgeData {
  /** Left-half label, e.g. "fleet" / "cost 7d" / "shipped". */
  label: string;
  /** Right-half value, e.g. "ok" / "$3.50" / "3h". */
  value: string;
  /** Right-half background color (one of BADGE_COLORS). Hex with leading `#`. */
  color: string;
}

// ────────────────────────────────────────────────────────────────────
// SVG rendering — hand-rolled, no template engine
// ────────────────────────────────────────────────────────────────────

/** Approximate width in pixels for a string at the default badge font.
 *  Shields uses Verdana 11px and ships per-character metric tables; we
 *  don't have those, so the ticket's engineering note pins us at a
 *  flat 6.5 px/char approximation. Real renders look identical to
 *  Shields within ~1 char of width which is well inside the
 *  paste-into-README tolerance. */
function measureTextWidth(s: string): number {
  return Math.max(1, s.length * 6.5);
}

/** Escape a string for safe XML text-node insertion. The label/value
 *  come from operator-controlled data (slugs, dollar amounts, "Nh") —
 *  but it costs nothing to escape and protects us from a future
 *  ticket that feeds a `<` through. */
function escXml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;",
  }[c]!));
}

/** Layout constants — kept in one place so a future "denser badge"
 *  ticket can re-tune without spelunking through the SVG string. */
const PAD_X = 6;       // left/right text padding
const HEIGHT = 20;     // total badge height
const TEXT_Y = 14;     // baseline of the visible text
const SHADOW_Y = 15;   // baseline of the drop-shadow text below

/** Build the badge SVG. Both halves are sized to fit their content;
 *  the result is a complete `<svg ... > ... </svg>` document with an
 *  explicit width + height + viewBox so README renderers can lay it
 *  out without ever measuring the text themselves. */
export function renderBadge(data: BadgeData): string {
  const label = String(data.label ?? "");
  const value = String(data.value ?? "");
  const color = String(data.color ?? BADGE_COLORS.grey);
  const lw = Math.round(measureTextWidth(label) + PAD_X * 2);
  const vw = Math.round(measureTextWidth(value) + PAD_X * 2);
  const total = lw + vw;
  // The two halves: left is a dark slate, right is the metric color.
  // The drop-shadow text under each label is a Shields trick — it
  // gives 1-pixel of pseudo-emboss against the flat fill so the text
  // stays readable on every Hex background we hand it.
  const labelMid = lw / 2;
  const valueMid = lw + vw / 2;
  // We intentionally inline `font-family` rather than relying on the
  // README renderer's defaults so a Shields-like look is achievable
  // even when DejaVu Sans isn't installed.
  const font = "DejaVu Sans,Verdana,Geneva,sans-serif";
  return ""
    + `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${HEIGHT}" `
    + `viewBox="0 0 ${total} ${HEIGHT}" role="img" aria-label="${escXml(label)}: ${escXml(value)}">`
    + `<title>${escXml(label)}: ${escXml(value)}</title>`
    + `<linearGradient id="s" x2="0" y2="100%">`
    + `<stop offset="0" stop-color="#bbb" stop-opacity=".1"/>`
    + `<stop offset="1" stop-opacity=".1"/>`
    + `</linearGradient>`
    + `<clipPath id="r"><rect width="${total}" height="${HEIGHT}" rx="3" fill="#fff"/></clipPath>`
    + `<g clip-path="url(#r)">`
    + `<rect width="${lw}" height="${HEIGHT}" fill="#555"/>`
    + `<rect x="${lw}" width="${vw}" height="${HEIGHT}" fill="${escXml(color)}"/>`
    + `<rect width="${total}" height="${HEIGHT}" fill="url(#s)"/>`
    + `</g>`
    + `<g fill="#fff" text-anchor="middle" font-family="${font}" font-size="11">`
    + `<text x="${labelMid}" y="${SHADOW_Y}" fill="#010101" fill-opacity=".3">${escXml(label)}</text>`
    + `<text x="${labelMid}" y="${TEXT_Y}">${escXml(label)}</text>`
    + `<text x="${valueMid}" y="${SHADOW_Y}" fill="#010101" fill-opacity=".3">${escXml(value)}</text>`
    + `<text x="${valueMid}" y="${TEXT_Y}">${escXml(value)}</text>`
    + `</g>`
    + `</svg>`;
}

// ────────────────────────────────────────────────────────────────────
// Metric resolvers — pure SQL against existing tables
// ────────────────────────────────────────────────────────────────────

interface RunRow {
  outcome: string | null;
  started_at: string | null;
}

interface CostRow {
  cost_usd: number | null;
}

/** Resolve the `status` metric: the most-recent run's outcome.
 *  Maps `success/shipped/healed/reviewed-ok/no-op` → green `ok`,
 *  `failure/error/reviewed-changes/self-cancel` → red `fail`,
 *  `in-progress` → yellow `running`, anything else / no row → grey
 *  `unknown`. The mapping is intentionally generous on the "good"
 *  side because the agent fleet labels success runs in several
 *  flavours; the value text stays `ok` for all of them so the
 *  badge reads cleanly.
 *
 *  Ticket 0021: when the project is cost-cap paused (project_pause
 *  row with reason='cost_cap'), the badge shifts to the existing
 *  amber/yellow palette token with value 'paused·cost' — same colour
 *  the SPA pill uses so README readers see the same state. The check
 *  is cheap (one row lookup keyed on project_id) and short-circuits
 *  before the outcome map so a paused project that also failed a
 *  recent run still reads as 'paused·cost'. */
function statusBadge(db: DB, slug: string): BadgeData {
  // Cost-cap pause short-circuit (ticket 0021). The join goes through
  // project so an unknown slug folds into "no pause row" naturally.
  const pause = db.prepare(
    "SELECT pp.reason AS reason FROM project_pause pp "
    + "JOIN project p ON p.id = pp.project_id "
    + "WHERE p.slug=?",
  ).get(slug) as unknown as { reason: string } | undefined;
  if (pause && pause.reason === "cost_cap") {
    return { label: "fleet", value: "paused·cost", color: BADGE_COLORS.yellow };
  }
  const row = db.prepare(
    "SELECT outcome FROM run r "
    + "JOIN project p ON p.id = r.project_id "
    + "WHERE p.slug=? "
    + "ORDER BY r.started_at DESC LIMIT 1",
  ).get(slug) as unknown as RunRow | undefined;
  if (!row) return { label: "fleet", value: "unknown", color: BADGE_COLORS.grey };
  const outcome = (row.outcome ?? "").toLowerCase();
  // The ticket spells out three specific outcomes; we keep the
  // mapping table small and explicit so a future contributor can
  // see at a glance which strings count for which colour.
  const GREEN = new Set([
    "success", "shipped", "healed", "reviewed-ok", "no-op",
  ]);
  const RED = new Set([
    "failure", "error", "reviewed-changes", "self-cancel", "usage-limit",
  ]);
  if (outcome === "in-progress" || outcome === "running") {
    return { label: "fleet", value: "running", color: BADGE_COLORS.yellow };
  }
  if (GREEN.has(outcome)) {
    return { label: "fleet", value: "ok", color: BADGE_COLORS.green };
  }
  if (RED.has(outcome)) {
    return { label: "fleet", value: "fail", color: BADGE_COLORS.red };
  }
  // An unknown / null outcome (a row exists but the agent didn't
  // tag it) is rendered as grey/unknown rather than guessing.
  return { label: "fleet", value: "unknown", color: BADGE_COLORS.grey };
}

/** Resolve the `cost` metric: sum cost_rollup_day.cost_usd for the
 *  slug across the last 7 days (SQLite `date('now','-7 day')`).
 *  Thresholds are static per the ticket: <$5 green, $5-$25 yellow,
 *  >$25 red. */
function costBadge(db: DB, slug: string): BadgeData {
  const row = db.prepare(
    "SELECT COALESCE(SUM(c.cost_usd),0) AS cost_usd "
    + "FROM cost_rollup_day c JOIN project p ON p.id = c.project_id "
    + "WHERE p.slug=? AND c.day >= date('now','-7 day')",
  ).get(slug) as unknown as CostRow | undefined;
  const cost = Number(row?.cost_usd ?? 0);
  const value = "$" + cost.toFixed(2);
  let color: string;
  if (cost < 5) color = BADGE_COLORS.green;
  else if (cost <= 25) color = BADGE_COLORS.yellow;
  else color = BADGE_COLORS.red;
  return { label: "cost 7d", value, color };
}

/** Human-friendly relative-age string for the ship badge. Always one
 *  of `Nm` / `Nh` / `Nd`. Never returns a unit larger than days. */
function relativeAge(ageMs: number): string {
  const sec = Math.max(0, Math.floor(ageMs / 1000));
  if (sec < 3600) return Math.max(1, Math.floor(sec / 60)) + "m";
  if (sec < 86_400) return Math.floor(sec / 3600) + "h";
  return Math.floor(sec / 86_400) + "d";
}

/** Resolve the `ship` metric: relative age of the most recent run
 *  whose outcome marks it as a successful ship (`shipped`, `success`,
 *  `healed`, `reviewed-ok`). Color green <24h, yellow <7d, red older;
 *  grey `never` if no qualifying row exists. */
function shipBadge(db: DB, slug: string, now: number = Date.now()): BadgeData {
  const row = db.prepare(
    "SELECT r.started_at FROM run r "
    + "JOIN project p ON p.id = r.project_id "
    + "WHERE p.slug=? AND r.outcome IN ('shipped','success','healed','reviewed-ok') "
    + "ORDER BY r.started_at DESC LIMIT 1",
  ).get(slug) as unknown as { started_at: string | null } | undefined;
  if (!row || !row.started_at) {
    return { label: "shipped", value: "never", color: BADGE_COLORS.grey };
  }
  const ageMs = now - new Date(row.started_at).getTime();
  const value = relativeAge(ageMs);
  let color: string;
  if (ageMs < 24 * 3600_000) color = BADGE_COLORS.green;
  else if (ageMs < 7 * 86_400_000) color = BADGE_COLORS.yellow;
  else color = BADGE_COLORS.red;
  return { label: "shipped", value, color };
}

/** Single chokepoint the route hits. Validates the metric, dispatches
 *  to the right resolver, and returns the data the renderer wants.
 *  An unknown slug is NOT an error — every metric resolver folds the
 *  "no row" case into a grey/`unknown`/`never` badge so the route can
 *  return a 200 SVG placeholder rather than a 404 inside an `<img>`. */
export function projectBadge(db: DB, slug: string, metric: BadgeMetric): BadgeData {
  switch (metric) {
    case "status": return statusBadge(db, slug);
    case "cost": return costBadge(db, slug);
    case "ship": return shipBadge(db, slug);
    default: {
      // Belt-and-braces: TypeScript narrows BadgeMetric to never here,
      // but a JS caller passing junk should get a defined fallback
      // rather than crashing the request. The route validates first,
      // so production never reaches this branch.
      return { label: "fleet", value: "unknown", color: BADGE_COLORS.grey };
    }
  }
}

/** Type-narrowing helper for the route's query parsing. Returns the
 *  validated metric or null on miss; the route emits a 400 on null. */
export function parseMetric(raw: string | null | undefined): BadgeMetric | null {
  if (!raw) return "status"; // default per AC3
  const s = String(raw).toLowerCase();
  if ((BADGE_METRICS as readonly string[]).includes(s)) return s as BadgeMetric;
  return null;
}
