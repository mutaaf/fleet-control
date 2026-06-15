// Embeddable fleet-pulse widget renderers (ticket 0060).
//
// This module composes the existing fleetWeeklyPulse payload (per
// src/views.ts) into TWO embeddable artifacts:
//
//   1. A 300x180 self-contained HTML page served at /embed/pulse.html
//      (loaded inside an iframe on an operator's personal blog).
//      NO script tags. NO operator project slug. CSS is inlined so the
//      iframe needs zero extra HTTP requests.
//   2. A 300x180 hand-rolled SVG served at /embed/pulse.svg (loaded as
//      an img on surfaces like GitHub profile READMEs that strip
//      iframes). Hand-rolled per the 0015 status-badge precedent. NO
//      template engine, NO new dependency.
//
// Both artifacts render the SAME three stats: merged PRs this week, $
// spent, $ per merged PR. Honest empty state: when merged_prs is 0
// the embed renders the same quiet-week sentence as /pulse (per AC3).
// Anonymisation: no operator project slug appears in either body
// (the embed surface is FLEET-level by construction, per AC7).
//
// Why a new module and not src/views.ts: src/views.ts is already
// imported by src/lessons.ts, src/config.ts, src/inbox.ts and many
// others. Per LESSONS 2026-06-13 "function-import cycles aren't
// always cache-invalidation" we keep the new helper out of
// src/views.ts so neither side grows a back-edge import. The embed
// module imports only the FleetWeeklyPulse type plus a tiny escape
// helper local copy. No back-edge from views.ts to embed.ts is
// created.
//
// Renderer-direct seams: per LESSONS 2026-06-11 "startServer() tests
// that mutate fleet-control.config.json race against parallel test
// files; expose a renderer-direct seam for branch tests" the embed-
// origin and viewport-width branches are exercised via the exported
// _renderEmbedPulseHtmlForTests / _renderEmbedPulseSvgForTests seams
// so test files never need to mutate the cwd config.

import type { FleetWeeklyPulse } from "./views.ts";

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

/** Default embed dimensions. The 300x180 box fits a typical blog
 *  sidebar; the 200x100 narrow viewport is used for the gracefully-
 *  degraded two-stat layout (per AC8). */
export const EMBED_WIDTH = 300;
export const EMBED_HEIGHT = 180;
export const NARROW_WIDTH_THRESHOLD = 240;

/** Plain-prose footer link the embed always carries. The link points
 *  at the fleet-control project URL (a hard-coded string, not the
 *  operator's host) so an embedded card always advertises the tool,
 *  never the operator's local network. */
export const EMBED_CTA_HREF = "https://github.com/fleet-control/fleet-control";
export const EMBED_CTA_LABEL = "powered by fleet-control";

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** HTML/SVG attribute and text escaper. Local copy so we never reach
 *  into src/views.ts (avoid the function-import cycle trap per
 *  LESSONS 2026-06-13). */
function escEmbed(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

function fmtEmbedUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  return "$" + v.toFixed(2);
}

/** Strip token-shaped substrings + GitHub URLs from operator-visible
 *  copy. Same shape as src/receipts.ts redactSecrets — defence-in-
 *  depth at the renderer boundary per LESSONS section "defence-in-
 *  depth secret redaction at the renderer boundary".
 *
 *  The embed HTML body is plain HTML (not JSON) so the body-string
 *  redaction is appropriate here per LESSONS 2026-06-10 "redactSecrets
 *  on a JSON body shreds your KEYS, not just your values" — HTML body
 *  redaction is fine; never call this on a JSON body string. */
export function redactSecretsForEmbed(s: string): string {
  let out = String(s ?? "");
  out = out.replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-pat>");
  out = out.replace(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?/g, (match) => {
    // Preserve the fleet-control CTA link verbatim — the redactor must
    // not eat the one allowed github.com anchor on the embed page.
    if (match === EMBED_CTA_HREF) return match;
    return "<redacted-repo-url>";
  });
  out = out.replace(/\b[A-Za-z0-9_]{24,}\b/g, (match) => {
    const hasLetter = /[A-Za-z]/.test(match);
    const hasDigit = /\d/.test(match);
    return hasLetter && hasDigit ? "<redacted>" : match;
  });
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Embed origin headers — used by both routes (HTML + SVG)
// ────────────────────────────────────────────────────────────────────

export interface EmbedHeaderOptions {
  embedOrigins?: string[];
}

/** Compose the frame-ancestors values for X-Frame-Options and CSP.
 *  When embedOrigins is omitted or empty, the embed renders ONLY on
 *  the operator's own host (SAMEORIGIN / 'self'). When the operator
 *  lists explicit origins, both headers widen to include them.
 *
 *  This is the chokepoint the routes call; tests drive it directly
 *  via _renderEmbedHeadersForTests so a per-AC branch never has to
 *  mutate the cwd config. */
export function composeEmbedFrameHeaders(
  opts: EmbedHeaderOptions = {},
): { xFrameOptions: string; contentSecurityPolicy: string } {
  const origins = (opts.embedOrigins ?? []).filter((o) => typeof o === "string" && o.length > 0);
  if (origins.length === 0) {
    return {
      xFrameOptions: "SAMEORIGIN",
      contentSecurityPolicy: "frame-ancestors 'self'",
    };
  }
  // X-Frame-Options only accepts SAMEORIGIN or ALLOW-FROM (deprecated
  // by most browsers) — when widening we drop it to ALLOWALL so the
  // CSP frame-ancestors becomes the source of truth. Per the AC, the
  // widened header surface is the documented mechanism for opting in.
  const escapedOrigins = origins.map((o) => o.replace(/[<>"']/g, ""));
  return {
    xFrameOptions: "ALLOWALL",
    contentSecurityPolicy: `frame-ancestors 'self' ${escapedOrigins.join(" ")}`,
  };
}

/** Test-only handle on the header composer. The boot-path tests stay
 *  the integration surface; this seam lets the per-AC origin test
 *  drive the function directly without booting startServer + the
 *  cwd-config seam that races parallel test files. */
export function _renderEmbedHeadersForTests(
  opts: EmbedHeaderOptions = {},
): { xFrameOptions: string; contentSecurityPolicy: string } {
  return composeEmbedFrameHeaders(opts);
}

// ────────────────────────────────────────────────────────────────────
// HTML renderer
// ────────────────────────────────────────────────────────────────────

export interface EmbedHtmlOptions {
  /** Drives the wide vs narrow layout. Default EMBED_WIDTH (300). */
  viewportWidth?: number;
  /** Forwarded to the header composer when the renderer is invoked
   *  through the test seam. The route handler passes the cfg-derived
   *  origins through; the production header set is composed on the
   *  server side via composeEmbedFrameHeaders. */
  embedOrigins?: string[];
}

/** Render the self-contained 300x180 HTML embed page. NO script tags.
 *  CSS inlined. NO operator project slug. The output passes through
 *  redactSecretsForEmbed at the boundary so a hypothetical upstream
 *  leak of a token shape never reaches the rendered card. */
export function renderEmbedPulseHtml(
  p: FleetWeeklyPulse,
  opts: EmbedHtmlOptions = {},
): string {
  const viewportWidth = opts.viewportWidth ?? EMBED_WIDTH;
  const narrow = viewportWidth < NARROW_WIDTH_THRESHOLD;
  const weekStart = escEmbed(p.week_start_iso);
  const ctaHref = EMBED_CTA_HREF;
  const ctaLabel = escEmbed(EMBED_CTA_LABEL);

  // Honest empty-week branch. Per LESSONS section "honest empty state"
  // the embed never fabricates an upbeat line — the quiet sentence is
  // the same shape as the /pulse empty state.
  if (p.merged_prs === 0) {
    const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>fleet pulse</title>
<style>
  html, body { margin: 0; padding: 0; background: #0E0F0D; color: #E8E2D4;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .embed-card { box-sizing: border-box; width: 100%; height: 100vh;
    display: flex; flex-direction: column; padding: 14px 16px; gap: 8px; }
  .embed-eyebrow { font-size: 11px; color: #807a6c; }
  .embed-empty { font-size: 14px; color: #E8E2D4; flex: 1; display: flex;
    align-items: center; }
  .embed-foot { font-size: 10px; }
  .embed-foot a { color: #c0823c; text-decoration: none; }
</style>
</head>
<body>
<main class="embed-card">
  <div class="embed-eyebrow">week of ${weekStart}</div>
  <div class="embed-empty" data-testid="embed-pulse-empty">fleet is quiet this week — nothing shipped</div>
  <div class="embed-foot"><a data-testid="embed-pulse-cta" href="${ctaHref}" target="_blank" rel="noopener">${ctaLabel}</a></div>
</main>
</body>
</html>`;
    return redactSecretsForEmbed(body);
  }

  const merged = escEmbed(String(p.merged_prs));
  const spend = escEmbed(fmtEmbedUsd(p.total_spend_usd));
  const cpp = escEmbed(p.cost_per_pr_usd == null ? "—" : fmtEmbedUsd(p.cost_per_pr_usd));

  // Narrow layout: two stats only (PRs + $/PR) so the card degrades
  // gracefully on a 200x100 embedder without overflow.
  const statsHtml = narrow
    ? [
        `<div class="embed-stat" data-testid="embed-pulse-prs"><span class="embed-stat-value">${merged}</span><span class="embed-stat-label">PRs merged</span></div>`,
        `<div class="embed-stat" data-testid="embed-pulse-cost-per-pr"><span class="embed-stat-value">${cpp}</span><span class="embed-stat-label">per merged PR</span></div>`,
      ].join("")
    : [
        `<div class="embed-stat" data-testid="embed-pulse-prs"><span class="embed-stat-value">${merged}</span><span class="embed-stat-label">PRs merged</span></div>`,
        `<div class="embed-stat" data-testid="embed-pulse-spend"><span class="embed-stat-value">${spend}</span><span class="embed-stat-label">spent</span></div>`,
        `<div class="embed-stat" data-testid="embed-pulse-cost-per-pr"><span class="embed-stat-value">${cpp}</span><span class="embed-stat-label">per merged PR</span></div>`,
      ].join("");

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>fleet pulse</title>
<style>
  html, body { margin: 0; padding: 0; background: #0E0F0D; color: #E8E2D4;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; }
  .embed-card { box-sizing: border-box; width: 100%; height: 100vh;
    display: flex; flex-direction: column; padding: 12px 14px; gap: 6px;
    overflow: hidden; }
  .embed-eyebrow { font-size: 10px; color: #807a6c; }
  .embed-stats { display: flex; flex-direction: row; gap: 14px; flex: 1;
    align-items: center; }
  .embed-stat { display: flex; flex-direction: column; gap: 1px; }
  .embed-stat-value { font-size: 18px; font-weight: 700; color: #E8E2D4; }
  .embed-stat-label { font-size: 10px; color: #807a6c; text-transform: lowercase; }
  .embed-foot { font-size: 10px; }
  .embed-foot a { color: #c0823c; text-decoration: none; }
</style>
</head>
<body>
<main class="embed-card">
  <div class="embed-eyebrow">week of ${weekStart}</div>
  <div class="embed-stats">${statsHtml}</div>
  <div class="embed-foot"><a data-testid="embed-pulse-cta" href="${ctaHref}" target="_blank" rel="noopener">${ctaLabel}</a></div>
</main>
</body>
</html>`;
  return redactSecretsForEmbed(body);
}

/** Test-only handle on the HTML renderer. Per LESSONS 2026-06-11 the
 *  branch tests drive this directly so they never touch the cwd
 *  config file. */
export function _renderEmbedPulseHtmlForTests(
  p: FleetWeeklyPulse,
  opts: EmbedHtmlOptions = {},
): string {
  return renderEmbedPulseHtml(p, opts);
}

// ────────────────────────────────────────────────────────────────────
// SVG renderer — hand-rolled per the 0015 badge precedent.
// ────────────────────────────────────────────────────────────────────

/** Render the self-contained 300x180 SVG embed. Same three-stat content
 *  as the HTML page. Hand-rolled string — NO template engine, NO new
 *  runtime dependency. */
export function renderEmbedPulseSvg(p: FleetWeeklyPulse): string {
  const w = EMBED_WIDTH;
  const h = EMBED_HEIGHT;
  const weekStart = escEmbed(p.week_start_iso);

  if (p.merged_prs === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="fleet pulse — quiet week">`
      + `<rect width="100%" height="100%" fill="#0E0F0D"/>`
      + `<text x="14" y="22" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="11">week of ${weekStart}</text>`
      + `<text x="14" y="${Math.floor(h / 2) + 4}" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="13" data-testid="embed-pulse-empty">fleet is quiet this week — nothing shipped</text>`
      + `<a href="${EMBED_CTA_HREF}" target="_blank">`
      + `<text x="14" y="${h - 12}" fill="#c0823c" font-family="ui-monospace,Menlo,monospace" font-size="10" data-testid="embed-pulse-cta">${escEmbed(EMBED_CTA_LABEL)}</text>`
      + `</a>`
      + `</svg>`;
  }

  const merged = escEmbed(String(p.merged_prs));
  const spend = escEmbed(fmtEmbedUsd(p.total_spend_usd));
  const cpp = escEmbed(p.cost_per_pr_usd == null ? "—" : fmtEmbedUsd(p.cost_per_pr_usd));

  // Three stat columns, evenly spaced across the 300px width.
  const colX = [22, 120, 218];
  const valueY = 88;
  const labelY = 110;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="fleet pulse">`
    + `<rect width="100%" height="100%" fill="#0E0F0D"/>`
    + `<text x="14" y="22" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="11">week of ${weekStart}</text>`
    + `<text x="${colX[0]}" y="${valueY}" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="20" font-weight="700" data-testid="embed-pulse-prs">${merged}</text>`
    + `<text x="${colX[0]}" y="${labelY}" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="10">PRs merged</text>`
    + `<text x="${colX[1]}" y="${valueY}" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="20" font-weight="700" data-testid="embed-pulse-spend">${spend}</text>`
    + `<text x="${colX[1]}" y="${labelY}" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="10">spent</text>`
    + `<text x="${colX[2]}" y="${valueY}" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="20" font-weight="700" data-testid="embed-pulse-cost-per-pr">${cpp}</text>`
    + `<text x="${colX[2]}" y="${labelY}" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="10">per merged PR</text>`
    + `<a href="${EMBED_CTA_HREF}" target="_blank">`
    + `<text x="14" y="${h - 12}" fill="#c0823c" font-family="ui-monospace,Menlo,monospace" font-size="10" data-testid="embed-pulse-cta">${escEmbed(EMBED_CTA_LABEL)}</text>`
    + `</a>`
    + `</svg>`;
}

export function _renderEmbedPulseSvgForTests(p: FleetWeeklyPulse): string {
  return renderEmbedPulseSvg(p);
}

// ────────────────────────────────────────────────────────────────────
// /share page snippet composition
// ────────────────────────────────────────────────────────────────────

export interface EmbedSnippetTriple {
  iframe: string;
  img: string;
  markdown: string;
}

/** Compose the three copy-pastable snippets the /share page surfaces.
 *  The `host` parameter is the operator's lan/loopback URL (per
 *  src/lan.ts); the caller wires this from discoverLanUrl + the
 *  loopback fallback. */
export function composeEmbedSnippets(host: string): EmbedSnippetTriple {
  // Defence: clamp the host to a printable URL shape; never let a
  // hypothetical upstream return value end up rendered as raw markup.
  const safeHost = String(host ?? "").replace(/["'<>]/g, "");
  return {
    iframe: `<iframe src="${safeHost}/embed/pulse.html" width="${EMBED_WIDTH}" height="${EMBED_HEIGHT}" frameborder="0" title="fleet-control pulse"></iframe>`,
    img: `<a href="${safeHost}/pulse"><img src="${safeHost}/embed/pulse.svg" alt="fleet pulse" width="${EMBED_WIDTH}" height="${EMBED_HEIGHT}"/></a>`,
    markdown: `[![fleet pulse](${safeHost}/embed/pulse.svg)](${safeHost}/pulse)`,
  };
}

/** Render the authenticated /share HTML page. The page surfaces the
 *  three copy-pastable snippets plus a copy-to-clipboard button per
 *  snippet (testids per the AC). */
export function renderSharePage(host: string): string {
  const snippets = composeEmbedSnippets(host);
  const iframeSnippet = escEmbed(snippets.iframe);
  const imgSnippet = escEmbed(snippets.img);
  const mdSnippet = escEmbed(snippets.markdown);

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>fleet-control — embed your pulse</title>
<link rel="stylesheet" href="/style.css" />
</head>
<body>
<main class="share-embed-main">
  <h1 class="share-embed-headline">Embed your fleet pulse</h1>
  <p class="share-embed-intro">Paste one snippet into your blog, README, or LinkedIn feature. The widget renders the same numbers as <a href="/pulse">/pulse</a> and refreshes itself every 5 minutes.</p>

  <section class="share-embed-section">
    <h2>iframe (any HTML surface)</h2>
    <pre class="share-embed-snippet" data-testid="embed-snippet-iframe">${iframeSnippet}</pre>
    <button type="button" class="share-embed-copy" data-testid="embed-copy-iframe" data-snippet-kind="iframe">copy</button>
  </section>

  <section class="share-embed-section">
    <h2>img (GitHub README, surfaces that strip iframes)</h2>
    <pre class="share-embed-snippet" data-testid="embed-snippet-img">${imgSnippet}</pre>
    <button type="button" class="share-embed-copy" data-testid="embed-copy-img" data-snippet-kind="img">copy</button>
  </section>

  <section class="share-embed-section">
    <h2>markdown</h2>
    <pre class="share-embed-snippet" data-testid="embed-snippet-markdown">${mdSnippet}</pre>
    <button type="button" class="share-embed-copy" data-testid="embed-copy-markdown" data-snippet-kind="markdown">copy</button>
  </section>
</main>
<script>
  (function () {
    var btns = document.querySelectorAll(".share-embed-copy");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function (ev) {
        var btn = ev.currentTarget;
        var kind = btn.getAttribute("data-snippet-kind");
        var pre = document.querySelector('[data-testid="embed-snippet-' + kind + '"]');
        if (!pre) return;
        var text = pre.textContent || "";
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            btn.textContent = "copied!";
            setTimeout(function () { btn.textContent = "copy"; }, 1200);
          });
        }
      });
    }
  })();
</script>
</body>
</html>`;
  return redactSecretsForEmbed(body);
}

export function _renderSharePageForTests(host: string): string {
  return renderSharePage(host);
}
