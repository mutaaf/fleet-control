// Open-graph image renderers (ticket 0061).
//
// This module composes three hand-rolled 1200x630 SVGs for the public
// pages /pulse, /receipts, /calculator. Each SVG is the artifact a
// LinkedIn / Twitter / Bluesky crawler fetches when its peer's paste of
// the page URL is rendered as a feed card. The aspect ratio (1.91:1)
// matches every major social crawler's preview frame.
//
// Three pure renderer functions:
//   renderOgPulseSvg(payload)       - the week-of-N pulse card
//   renderOgReceiptsSvg(payload)    - the monthly-receipts card with
//                                     a 12-bar trailing sparkline
//   renderOgCalculatorSvg(payload)  - the median-projection card
//
// Each renderer is INPUT-PURE: no DB call, no globalThis read, no
// Date.now() leak. The route layer (src/server.ts) owns the cache and
// the DB-to-payload composition; this module owns the SVG bytes.
//
// PRODUCER-VS-SPEC reconciliation (per LESSONS 2026-06-05): the
// route-layer composition reads producer-side helpers
// (fleetWeeklyPulse + receipts monthly aggregator + fleetMedianProjection)
// for the actual field names. This module's payload TYPES match those
// producers exactly so a future consumer never has to guess.
//
// Per LESSONS 2026-06-11 "expose a renderer-direct seam for branch
// tests" - the three `_render*ForTests` exports let tests drive the
// SVG branches without booting the server or mutating cwd config.
//
// Per LESSONS 2026-06-13 "function-import cycles aren't always cache-
// invalidation; sometimes the cheapest fix is a 6-line inline copy"
// - this module imports ONLY the FleetWeeklyPulse type from views.ts;
// the escape helper is a private copy here so views.ts never grows a
// back-edge import of og.ts. The cache invalidation hook lives in
// src/server.ts and is registered on `globalThis.__fleet_og_invalidate__`
// (per LESSONS 2026-06-05); this module stays pure.
//
// Per LESSONS section "honest empty state" - each renderer carries a
// single hard-coded sentence for its empty branch ("fleet is quiet
// this week", "no months ingested yet - install fleet-control",
// "calibrating - check back after a week of data"). No fabricated
// upbeat copy.
//
// Zero new runtime deps: hand-rolled SVG string concatenation per the
// 0015 + 0060 precedent. No template engine, no JSX, no <script> tag.

import type { FleetWeeklyPulse } from "./views.ts";

// ------------------------------------------------------------------
// Constants - the LinkedIn/Twitter/OpenGraph 1.91:1 standard frame.
// ------------------------------------------------------------------

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;

/** Fleet-control attribution footer. Static string so the SVG body
 *  never references the operator's own host. */
const OG_FOOTER_LABEL = "powered by fleet-control";

// ------------------------------------------------------------------
// Private helpers - inline copies per LESSONS 2026-06-13 to keep
// views.ts free of a back-edge import.
// ------------------------------------------------------------------

/** HTML/SVG attribute and text escaper. */
function escOg(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

function fmtOgUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (Math.abs(v) >= 100) return "$" + Math.round(v).toString();
  return "$" + v.toFixed(2);
}

function fmtOgInteger(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return String(Math.round(Number(n)));
}

// ------------------------------------------------------------------
// Pulse OG renderer.
// ------------------------------------------------------------------

/** Render the 1200x630 pulse OG card. Three stat blocks (merged PRs,
 *  $ spent, $/PR), header "fleet pulse - week of <ISO>", footer
 *  attribution. Empty branch: "The fleet is quiet this week" - same
 *  honest copy as the /pulse HTML page. */
export function renderOgPulseSvg(p: FleetWeeklyPulse): string {
  const w = OG_WIDTH;
  const h = OG_HEIGHT;
  const weekStart = escOg(p.week_start_iso);
  const weekEnd = escOg(p.week_end_iso);

  if (p.merged_prs === 0) {
    return ogSvgFrame(
      `<text x="60" y="110" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="28">fleet pulse - week of ${weekStart}</text>`
      + `<text x="60" y="${Math.floor(h / 2) + 10}" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="48" data-testid="og-pulse-empty">The fleet is quiet this week.</text>`
      + ogFooter(h),
      "fleet pulse - quiet week",
    );
  }

  const merged = escOg(fmtOgInteger(p.merged_prs));
  const spend = escOg(fmtOgUsd(p.total_spend_usd));
  const cpp = escOg(p.cost_per_pr_usd == null ? "—" : fmtOgUsd(p.cost_per_pr_usd));

  // Three stat columns evenly spaced across the 1200px width.
  // Layout: 60px L margin, 1080px usable, 3 columns @ 360px each.
  const colX = [60, 420, 780];
  const valueY = 360;
  const labelY = 410;
  const headerY = 110;

  return ogSvgFrame(
    `<text x="60" y="${headerY}" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="32">fleet pulse - week of ${weekStart} -&gt; ${weekEnd}</text>`
    + `<text x="${colX[0]}" y="${valueY}" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="120" font-weight="700" data-testid="og-pulse-prs">${merged}</text>`
    + `<text x="${colX[0]}" y="${labelY}" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="28">PRs merged</text>`
    + `<text x="${colX[1]}" y="${valueY}" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="120" font-weight="700" data-testid="og-pulse-spend">${spend}</text>`
    + `<text x="${colX[1]}" y="${labelY}" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="28">spent</text>`
    + `<text x="${colX[2]}" y="${valueY}" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="120" font-weight="700" data-testid="og-pulse-cost-per-pr">${cpp}</text>`
    + `<text x="${colX[2]}" y="${labelY}" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="28">per merged PR</text>`
    + ogFooter(h),
    "fleet pulse",
  );
}

export function _renderOgPulseSvgForTests(p: FleetWeeklyPulse): string {
  return renderOgPulseSvg(p);
}

// ------------------------------------------------------------------
// Receipts OG renderer.
// ------------------------------------------------------------------

/** Payload for the receipts OG renderer. Fleet-wide; the route layer
 *  composes this from the receipts monthly aggregator (this month) and
 *  a trailing 11-month series of per-month merged-PR counts for the
 *  sparkline. NO project slugs - the receipts OG is fleet-level.
 *
 *  Note: `month_label` is REQUIRED on the type for caller ergonomics
 *  but the renderer derives the human-readable month string from
 *  `month_iso` (structurally safe - matches /^\d{4}-\d{2}$/) so a
 *  hypothetical leak via month_label cannot reach the SVG body. */
export interface OgReceiptsPayload {
  generated_at: string;
  month_iso: string;
  month_label: string;
  merged_prs: number;
  total_spend_usd: number;
  /** Trailing 12 months of merged-PR counts, oldest first. The last
   *  value is THIS month's count and matches merged_prs. */
  sparkline: number[];
}

/** Derive a safe human-readable month label from the structurally-safe
 *  month_iso string. Never reads the operator-supplied month_label. */
function safeMonthLabelFromIso(monthIso: string): string {
  const m = String(monthIso ?? "").match(/^(\d{4})-(\d{2})$/);
  if (!m) return "this month";
  const names = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const monthIdx = Number(m[2]) - 1;
  const yr = m[1];
  if (monthIdx < 0 || monthIdx > 11) return "this month";
  return `${names[monthIdx]} ${yr}`;
}

/** Render the 1200x630 receipts OG card. One giant headline ("this
 *  month: <N> PRs at $<X>") plus a 12-bar trailing sparkline rendered
 *  as <rect> elements (hand-rolled like 0031). Empty branch: "no
 *  months ingested yet - install fleet-control" - honest copy. */
export function renderOgReceiptsSvg(p: OgReceiptsPayload): string {
  const w = OG_WIDTH;
  const h = OG_HEIGHT;
  // Derive the month label from the structurally-safe month_iso; never
  // surface the operator-supplied p.month_label so a hypothetical leak
  // via that field cannot reach the SVG body.
  const monthLabel = escOg(safeMonthLabelFromIso(p.month_iso));

  if (p.merged_prs === 0 && (p.sparkline ?? []).every((n) => n === 0)) {
    return ogSvgFrame(
      `<text x="60" y="110" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="28">fleet receipts - ${monthLabel}</text>`
      + `<text x="60" y="${Math.floor(h / 2) + 10}" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="44" data-testid="og-receipts-empty">no months ingested yet - install fleet-control.</text>`
      + ogFooter(h),
      "fleet receipts - empty fleet",
    );
  }

  const merged = escOg(fmtOgInteger(p.merged_prs));
  const spend = escOg(fmtOgUsd(p.total_spend_usd));

  // Sparkline layout: 12 monthly bars across the bottom-middle band.
  // Anchor: x in [60, 1140] (1080 wide), y in [440..560] (120 tall).
  const bars = (p.sparkline ?? []).slice(-12);
  const maxVal = bars.reduce((m, v) => (v > m ? v : m), 0);
  const barAreaX = 60;
  const barAreaY = 440;
  const barAreaW = w - 120;
  const barAreaH = 120;
  const cellW = bars.length > 0 ? barAreaW / bars.length : 0;
  const gap = 6;
  const barW = Math.max(0, cellW - gap);
  let sparkRects = "";
  for (let i = 0; i < bars.length; i++) {
    const v = bars[i] ?? 0;
    const ratio = maxVal > 0 ? v / maxVal : 0;
    const barH = Math.max(2, Math.round(ratio * barAreaH));
    const x = Math.round(barAreaX + i * cellW + gap / 2);
    const y = barAreaY + (barAreaH - barH);
    sparkRects += `<rect x="${x}" y="${y}" width="${Math.round(barW)}" height="${barH}" fill="#c0823c"></rect>`;
  }

  return ogSvgFrame(
    `<text x="60" y="110" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="32">fleet receipts - ${monthLabel}</text>`
    + `<text x="60" y="260" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="72" font-weight="700" data-testid="og-receipts-headline">this month: ${merged} PRs at ${spend}</text>`
    + `<text x="60" y="420" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="24">12-month trailing merged PRs</text>`
    + `<g data-testid="og-receipts-sparkline">${sparkRects}</g>`
    + ogFooter(h),
    "fleet receipts",
  );
}

export function _renderOgReceiptsSvgForTests(p: OgReceiptsPayload): string {
  return renderOgReceiptsSvg(p);
}

// ------------------------------------------------------------------
// Calculator OG renderer.
// ------------------------------------------------------------------

/** Payload for the calculator OG renderer. Fleet-wide; the route layer
 *  composes this from fleetMedianProjection (90d window, p25 percentile
 *  by default). NO project slugs - the calculator OG is fleet-level. */
export interface OgCalculatorPayload {
  generated_at: string;
  /** Median (or p25) hours saved per week per project, computed as
   *  merged_prs_per_month / (30/7). Zero on the insufficient-data
   *  branch. */
  hours_saved_per_week: number;
  merged_prs_per_month: number;
  cost_per_pr_usd: number | null;
  /** Human-readable label for the percentile pick. */
  percentile_label: string;
  /** True when the fleet has fewer than 2 qualifying projects
   *  (matches fleetMedianProjection's insufficient-fleet branch). */
  insufficient_data: boolean;
}

/** Render the 1200x630 calculator OG card. One headline ("operators
 *  like you save ~<H>h/week"), one CTA footer ("install fleet-control"),
 *  and a single stat block. Empty branch: "calibrating - check back
 *  after a week of data". */
export function renderOgCalculatorSvg(p: OgCalculatorPayload): string {
  const w = OG_WIDTH;
  const h = OG_HEIGHT;

  if (p.insufficient_data) {
    return ogSvgFrame(
      `<text x="60" y="110" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="28">fleet-control - pre-install ROI calculator</text>`
      + `<text x="60" y="${Math.floor(h / 2) + 10}" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="44" data-testid="og-calc-empty">calibrating - check back after a week of data.</text>`
      + `<text x="60" y="${h - 90}" fill="#c0823c" font-family="ui-monospace,Menlo,monospace" font-size="32" data-testid="og-calc-cta">install fleet-control</text>`
      + ogFooter(h),
      "fleet-control calculator - calibrating",
    );
  }

  const hours = fmtOgInteger(p.hours_saved_per_week);
  const prsPerMonth = fmtOgInteger(p.merged_prs_per_month);

  return ogSvgFrame(
    `<text x="60" y="110" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="32">fleet-control - pre-install ROI calculator</text>`
    + `<text x="60" y="260" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="64" font-weight="700" data-testid="og-calc-headline">operators like you save ~${escOg(hours)}h/week.</text>`
    + `<text x="60" y="360" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="28">based on a fleet of ${escOg(prsPerMonth)} merged PRs / month per project.</text>`
    + `<text x="60" y="${h - 90}" fill="#c0823c" font-family="ui-monospace,Menlo,monospace" font-size="40" font-weight="600" data-testid="og-calc-cta">install fleet-control</text>`
    + ogFooter(h),
    "fleet-control calculator",
  );
}

export function _renderOgCalculatorSvgForTests(p: OgCalculatorPayload): string {
  return renderOgCalculatorSvg(p);
}

// ------------------------------------------------------------------
// Shared SVG frame + footer helpers.
// ------------------------------------------------------------------

/** Wrap the inner SVG body in the standard 1200x630 frame with the
 *  fleet-control dark background. The aria-label is human copy only -
 *  no project slugs ever flow in. */
function ogSvgFrame(innerBody: string, ariaLabel: string): string {
  const w = OG_WIDTH;
  const h = OG_HEIGHT;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${escOg(ariaLabel)}">`
    + `<rect width="100%" height="100%" fill="#0E0F0D"></rect>`
    + innerBody
    + `</svg>`;
}

/** Static footer attribution. The label is the same hard-coded string
 *  across all three renderers so the OG cards visually rhyme. */
function ogFooter(h: number): string {
  return `<text x="60" y="${h - 40}" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="22" data-testid="og-footer">${escOg(OG_FOOTER_LABEL)}</text>`;
}
