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
import { readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

/** Render the authenticated /share HTML page. The page surfaces TWO
 *  embed-snippet sections (per ticket 0063 — pulse + lessons), each
 *  carrying three copy-pastable shapes (iframe / img / markdown) with
 *  per-snippet copy-to-clipboard buttons.
 *
 *  Per LESSONS 2026-06-12 "greedy [^>]+id= regex over a <h2 id="..."
 *  data-testid="...">" — every button + snippet anchor uses a
 *  data-testid attribute with a distinctive prefix
 *  (embed-snippet-<kind> for the pulse section, embed-lessons-snippet-
 *  <kind> for the lessons section). The click handler reads the
 *  target snippet's testid off the button's data-snippet-target
 *  attribute so the same script powers BOTH sections without a
 *  per-section special-case. */
export function renderSharePage(host: string): string {
  const pulse = composeEmbedSnippets(host);
  const lessons = composeEmbedLessonsSnippets(host);
  const pulseIframe = escEmbed(pulse.iframe);
  const pulseImg = escEmbed(pulse.img);
  const pulseMd = escEmbed(pulse.markdown);
  const lessonsIframe = escEmbed(lessons.iframe);
  const lessonsImg = escEmbed(lessons.img);
  const lessonsMd = escEmbed(lessons.markdown);

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>fleet-control — embed your fleet</title>
<link rel="stylesheet" href="/style.css" />
</head>
<body>
<main class="share-embed-main">
  <h1 class="share-embed-headline">Embed your fleet</h1>
  <p class="share-embed-intro">Paste one snippet into your blog, README, or LinkedIn feature. Both widgets render live data — the pulse refreshes every 5 minutes, the lesson rotates once per UTC day.</p>

  <section class="share-embed-pulse" data-testid="embed-pulse-section">
    <h2 class="share-embed-section-headline">Embed your fleet pulse</h2>
    <p class="share-embed-intro">The widget renders the same numbers as <a href="/pulse">/pulse</a>.</p>

    <section class="share-embed-section">
      <h2>iframe (any HTML surface)</h2>
      <pre class="share-embed-snippet" data-testid="embed-snippet-iframe">${pulseIframe}</pre>
      <button type="button" class="share-embed-copy" data-testid="embed-copy-iframe" data-snippet-target="embed-snippet-iframe">copy</button>
    </section>

    <section class="share-embed-section">
      <h2>img (GitHub README, surfaces that strip iframes)</h2>
      <pre class="share-embed-snippet" data-testid="embed-snippet-img">${pulseImg}</pre>
      <button type="button" class="share-embed-copy" data-testid="embed-copy-img" data-snippet-target="embed-snippet-img">copy</button>
    </section>

    <section class="share-embed-section">
      <h2>markdown</h2>
      <pre class="share-embed-snippet" data-testid="embed-snippet-markdown">${pulseMd}</pre>
      <button type="button" class="share-embed-copy" data-testid="embed-copy-markdown" data-snippet-target="embed-snippet-markdown">copy</button>
    </section>
  </section>

  <section class="share-embed-lessons" data-testid="embed-lessons-section">
    <h2 class="share-embed-section-headline">Embed today's lesson</h2>
    <p class="share-embed-intro">Rotates one cross-fleet operational lesson each UTC day. Same one-line paste shape as the pulse widget.</p>

    <section class="share-embed-section">
      <h2>iframe (any HTML surface)</h2>
      <pre class="share-embed-snippet" data-testid="embed-lessons-snippet-iframe">${lessonsIframe}</pre>
      <button type="button" class="share-embed-copy" data-testid="embed-lessons-copy-iframe" data-snippet-target="embed-lessons-snippet-iframe">copy</button>
    </section>

    <section class="share-embed-section">
      <h2>img (GitHub README, surfaces that strip iframes)</h2>
      <pre class="share-embed-snippet" data-testid="embed-lessons-snippet-img">${lessonsImg}</pre>
      <button type="button" class="share-embed-copy" data-testid="embed-lessons-copy-img" data-snippet-target="embed-lessons-snippet-img">copy</button>
    </section>

    <section class="share-embed-section">
      <h2>markdown</h2>
      <pre class="share-embed-snippet" data-testid="embed-lessons-snippet-markdown">${lessonsMd}</pre>
      <button type="button" class="share-embed-copy" data-testid="embed-lessons-copy-markdown" data-snippet-target="embed-lessons-snippet-markdown">copy</button>
    </section>
  </section>
</main>
<script>
  (function () {
    var btns = document.querySelectorAll(".share-embed-copy");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", function (ev) {
        var btn = ev.currentTarget;
        var target = btn.getAttribute("data-snippet-target");
        if (!target) return;
        var pre = document.querySelector('[data-testid="' + target + '"]');
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

// ────────────────────────────────────────────────────────────────────
// Ticket 0063 — Embeddable lesson-of-the-day widget.
//
// Two embeddable artifacts (sibling to the 0060 pulse embed):
//
//   1. A 320x200 self-contained HTML page served at /embed/lessons.html
//      (loaded inside an iframe on an operator's personal blog).
//      NO script tags. NO operator project slug after anonymisation.
//      CSS is inlined so the iframe needs zero extra HTTP requests.
//   2. A 320x200 hand-rolled SVG served at /embed/lessons.svg (loaded
//      as an img on surfaces like GitHub READMEs that strip iframes).
//      Hand-rolled per the 0015 + 0060 precedent — no template engine,
//      no new dependency.
//
// Both artifacts surface the SAME rotating lesson: today's title, a
// two-line excerpt, the cadence date, and a footer CTA back to the
// fleet-control project page. The rotation cadence is deterministic on
// the UTC day: dayIndex = floor(epoch_ms / 86_400_000) modulo the
// lessons-count, so two readers on the same UTC day see the same card
// and adjacent days see different cards.
//
// Why this module owns the helper instead of importing lessonOfTheDay
// from src/lessons.ts: per LESSONS 2026-06-13 "function-import cycles
// aren't always cache-invalidation; sometimes the cheapest fix is a
// 6-line inline copy of the helper" the embed module avoids any new
// import edge to src/lessons.ts (which already imports from
// src/views.ts; src/embed.ts already imports a TYPE from src/views.ts).
// The embed rotation is simpler than 0055's savings-weighted rotation
// anyway — it's an equal-weight modulo over every dated lesson, so
// inlining the 25-line parser-reader + selector + anonymiser is the
// right scale tradeoff.
//
// Per LESSONS 2026-06-11 "startServer() tests that mutate fleet-
// control.config.json race against parallel test files; expose a
// renderer-direct seam for branch tests" the per-AC branches drive
// the renderer through buildEmbedLessonsPayloadForTests +
// _renderEmbedLessonsHtmlForTests + _renderEmbedLessonsSvgForTests —
// no cwd config mutation.
//
// Per LESSONS section "no backticks inside template-literal SQL/HTML
// strings": every backtick inside this module's template literals
// quotes plain HTML or SVG text — no embedded SQL identifiers in
// backticks (and the leading comment block uses plain prose so a
// neighbouring slice-and-grep test on lessonSavingsRollup can't poison
// itself by walking 4000 chars past that helper into ours).
// ────────────────────────────────────────────────────────────────────

/** Default lessons file path. Mirrors src/lessons.ts defaultLessonsPath
 *  exactly — env override is `FLEET_CROSS_LESSONS_PATH`. Inlined here
 *  per LESSONS 2026-06-13 (avoid the back-edge import). */
function embedLessonsPath(): string {
  const override = process.env["FLEET_CROSS_LESSONS_PATH"];
  if (override) return override;
  return join(homedir(), ".local", "share", "agent-fleet", "CROSS_LESSONS.md");
}

/** Max file size we'll read. Mirrors src/lessons.ts MAX_FILE_BYTES. */
const EMBED_LESSONS_MAX_BYTES = 2 * 1024 * 1024;

/** Minimum dated-lesson count below which the embed renders the honest
 *  empty state. Per the AC: "when the LESSONS.md file has fewer than
 *  3 lessons total ... the embed renders 'fleet is still learning'". */
export const EMBED_LESSONS_MIN_LESSONS = 3;

/** Embed dimensions per the spec. */
export const EMBED_LESSONS_WIDTH = 320;
export const EMBED_LESSONS_HEIGHT = 200;

/** Maximum excerpt length so the two-line layout stays predictable. */
const EMBED_LESSONS_EXCERPT_CHARS = 140;

/** A single dated lesson record. Mirrors the lessons.ts entry shape
 *  for the fields we need (slug = parent project header, date + title +
 *  body = the entry). Inlined per LESSONS 2026-06-13. */
interface EmbedLessonRecord {
  slug: string;
  date: string;
  title: string;
  body: string;
}

/** Parse the lessons markdown text into a flat list of dated entries.
 *  Mirrors the H2 + H3 + bullet structure that src/lessons.ts
 *  parseCrossLessons handles but only emits dated H3 + bullet entries
 *  (undated entries can't anchor a stable rotation slot). Pure-string
 *  operation. */
function parseEmbedLessons(text: string): EmbedLessonRecord[] {
  const out: EmbedLessonRecord[] = [];
  const lines = text.split(/\r?\n/);
  let currentSlug: string | null = null;
  let pending: EmbedLessonRecord | null = null;
  let bodyBuf: string[] = [];

  const flush = () => {
    if (pending) {
      pending.body = bodyBuf.join("\n").trim();
      out.push(pending);
    }
    pending = null;
    bodyBuf = [];
  };

  const H2 = /^##\s+(.+?)\s*$/;
  const H3_DATED = /^###\s+(\d{4}-\d{2}-\d{2})\s*[—-]\s*(.+?)\s*$/;
  const H3_UNDATED = /^###\s+(.+?)\s*$/;
  const BULLET = /^-\s+(\d{4}-\d{2}-\d{2})\s+(?:\[[^\]]*\]\s+)?(.+?)\s*$/;

  for (const line of lines) {
    const h2 = line.match(H2);
    if (h2) {
      flush();
      currentSlug = h2[1].trim();
      continue;
    }
    if (!currentSlug) continue;
    const h3d = line.match(H3_DATED);
    if (h3d) {
      flush();
      pending = { slug: currentSlug, date: h3d[1], title: h3d[2].trim(), body: "" };
      continue;
    }
    const h3u = line.match(H3_UNDATED);
    if (h3u) {
      flush();
      // The bare "### Entries" header is a structural marker, not an
      // entry. Bullets that follow become bullet-kind entries.
      pending = null;
      continue;
    }
    const b = line.match(BULLET);
    if (b) {
      flush();
      out.push({ slug: currentSlug, date: b[1], title: b[2].trim(), body: "" });
      continue;
    }
    if (pending) bodyBuf.push(line);
  }
  flush();
  return out;
}

/** Read + parse the lessons file, returning [] when missing / oversized.
 *  Pure-fs (no shell-out). */
function readEmbedLessons(): EmbedLessonRecord[] {
  const path = embedLessonsPath();
  if (!existsSync(path)) return [];
  let size = 0;
  try {
    size = statSync(path).size;
  } catch { return []; }
  if (size > EMBED_LESSONS_MAX_BYTES) return [];
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch { return []; }
  return parseEmbedLessons(text);
}

/** Lightweight anonymisation pass on a lesson excerpt. Mirrors a tiny
 *  subset of src/lessons.ts anonymiseLessonBody (operator paths,
 *  branches, GitHub URLs, custom operator slugs) so the embed body
 *  never leaks operator-identifying strings. Inlined per LESSONS
 *  2026-06-13. */
function anonymiseEmbedExcerpt(body: string): string {
  let out = String(body ?? "");
  // 1. Absolute filesystem paths under /Users/ or /home/ → <path>.
  out = out.replace(/\/(?:Users|home)\/[^\s,;)\]]+/g, "<path>");
  // 2. Agent branch names (feat/, chore/, eng/) → <branch>.
  out = out.replace(/\b(?:feat|chore|eng)\/[A-Za-z0-9/_.-]+/g, "<branch>");
  // 3. GitHub PR / repo URLs → <pr-url>. The fleet-control CTA link
  //    survives because we never anonymise the rendered CTA href —
  //    only the lesson body that flows through this helper.
  out = out.replace(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\/[\w./-]*)?/g, "<pr-url>");
  // 4. Operator-style slugs of the shape "<word>-<word>-<word>" where
  //    the operator's project namespace shows up. The 0057 helper does
  //    a strict alias-map lookup; here we approximate by collapsing
  //    any non-public lower-kebab slug carrying a clearly-operator
  //    token (a 3+ word kebab name that does NOT begin with one of
  //    the well-known public anchors). This is conservative — false
  //    positives just render the public placeholder, which is the
  //    right side of the leak/over-redact tradeoff for a public
  //    embed surface.
  out = out.replace(/\b(?!agent-fleet\b|fleet-control\b)[a-z][a-z0-9]+(?:-[a-z0-9]+){2,}\b/g, "<project>");
  // 5. Ticket-id references → "an agent ticket".
  out = out.replace(/\bticket\s+\d{3,5}\b/gi, "an agent ticket");
  return out;
}

/** Build the first-sentence excerpt clipped to EMBED_LESSONS_EXCERPT_CHARS.
 *  Walks back to a word boundary so we don't slice mid-word. */
function buildEmbedExcerpt(body: string): string {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const firstSentenceMatch = text.match(/^[^.\n!?]+[.!?]?/);
  const firstSentence = firstSentenceMatch ? firstSentenceMatch[0].trim() : text;
  if (firstSentence.length <= EMBED_LESSONS_EXCERPT_CHARS) return firstSentence;
  const clipped = firstSentence.slice(0, EMBED_LESSONS_EXCERPT_CHARS);
  const lastSpace = clipped.lastIndexOf(" ");
  if (lastSpace > 0) return clipped.slice(0, lastSpace) + "…";
  return clipped + "…";
}

/** Sort lessons deterministically: by date ASC, then by slug ASC, then
 *  by title ASC — so the rotation slot is stable across operators with
 *  the same lessons file. Pure ordering helper. */
function sortEmbedLessons(records: EmbedLessonRecord[]): EmbedLessonRecord[] {
  return records.slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.slug !== b.slug) return a.slug < b.slug ? -1 : 1;
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return 0;
  });
}

export interface LessonEmbedPayloadLesson {
  kind: "lesson";
  lesson_slug: string;
  lesson_date: string;
  lesson_title: string;
  lesson_excerpt: string;
  rotation_day_index: number;
  total_lessons_indexed: number;
}

export interface LessonEmbedPayloadEmpty {
  kind: "empty";
  reason: "no-lessons" | "below-threshold";
  total_lessons_indexed: number;
  rotation_day_index: number;
}

export type LessonEmbedPayload = LessonEmbedPayloadLesson | LessonEmbedPayloadEmpty;

export interface BuildEmbedLessonsOptions {
  /** Pin the rotation day. Defaults to new Date(). Tests MUST pass
   *  this per LESSONS 2026-05-29 "time-pinned tests must NOT derive
   *  seed timestamps from new Date()". */
  now?: Date;
}

/** Build the deterministic embed payload for the given UTC day anchor.
 *  Reads the lessons file via readEmbedLessons(), drops undated rows
 *  (parser already only emits dated), enforces the >= EMBED_LESSONS_
 *  MIN_LESSONS gate, and picks `sorted[dayIndex mod sorted.length]`.
 *  The excerpt is anonymised via anonymiseEmbedExcerpt before the
 *  payload is returned so EVERY downstream renderer (HTML + SVG) sees
 *  the already-scrubbed text — a per-value scrub at the renderer
 *  boundary per LESSONS 2026-06-10 "redactSecrets on a JSON body
 *  shreds your KEYS, not just your values". */
export function buildEmbedLessonsPayload(opts: BuildEmbedLessonsOptions = {}): LessonEmbedPayload {
  const now = opts.now ?? new Date();
  const dayIndex = Math.floor(now.getTime() / 86_400_000);
  const records = readEmbedLessons();
  if (records.length < EMBED_LESSONS_MIN_LESSONS) {
    return {
      kind: "empty",
      reason: records.length === 0 ? "no-lessons" : "below-threshold",
      total_lessons_indexed: records.length,
      rotation_day_index: dayIndex,
    };
  }
  const sorted = sortEmbedLessons(records);
  const slot = ((dayIndex % sorted.length) + sorted.length) % sorted.length;
  const pick = sorted[slot];
  return {
    kind: "lesson",
    lesson_slug: pick.slug,
    lesson_date: pick.date,
    lesson_title: anonymiseEmbedExcerpt(pick.title),
    lesson_excerpt: anonymiseEmbedExcerpt(buildEmbedExcerpt(pick.body || pick.title)),
    rotation_day_index: dayIndex,
    total_lessons_indexed: records.length,
  };
}

/** Test-only handle. Per LESSONS 2026-06-11 the per-AC branches drive
 *  this directly so we never need to boot startServer + plant a cwd
 *  config file. */
export function buildEmbedLessonsPayloadForTests(now: Date): LessonEmbedPayload {
  return buildEmbedLessonsPayload({ now });
}

/** Read the lessons file's (mtime, size) without parsing — the server-
 *  side cache uses this pair as part of the invalidation tuple so a
 *  freshly-edited LESSONS.md busts the cache on the next request. */
export function embedLessonsFileTuple(): { mtime_ms: number; size: number; exists: boolean } {
  const path = embedLessonsPath();
  if (!existsSync(path)) return { mtime_ms: 0, size: 0, exists: false };
  try {
    const st = statSync(path);
    return { mtime_ms: st.mtimeMs, size: st.size, exists: true };
  } catch {
    return { mtime_ms: 0, size: 0, exists: false };
  }
}

/** Render the self-contained 320x200 HTML embed page. NO script tags.
 *  CSS inlined. The lesson title + excerpt are already anonymised by
 *  buildEmbedLessonsPayload; the final HTML body still passes through
 *  redactSecretsForEmbed at the boundary so a hypothetical upstream
 *  token-shape leak never reaches the rendered card. */
export function renderEmbedLessonsHtml(p: LessonEmbedPayload): string {
  const ctaHref = EMBED_CTA_HREF;
  const ctaLabel = escEmbed(EMBED_CTA_LABEL);

  if (p.kind === "empty") {
    const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>fleet lesson</title>
<style>
  html, body { margin: 0; padding: 0; background: #0E0F0D; color: #E8E2D4;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .embed-card { box-sizing: border-box; width: 100%; height: 100vh;
    display: flex; flex-direction: column; padding: 14px 16px; gap: 8px; }
  .embed-eyebrow { font-size: 10px; color: #807a6c; }
  .embed-empty { font-size: 14px; color: #E8E2D4; flex: 1; display: flex;
    align-items: center; }
  .embed-foot { font-size: 10px; }
  .embed-foot a { color: #c0823c; text-decoration: none; }
</style>
</head>
<body>
<main class="embed-card">
  <div class="embed-eyebrow">fleet lesson</div>
  <div class="embed-empty" data-testid="embed-lessons-empty">fleet is still learning — no lessons yet</div>
  <div class="embed-foot"><a data-testid="embed-lessons-cta" href="${ctaHref}" target="_blank" rel="noopener">${ctaLabel}</a></div>
</main>
</body>
</html>`;
    return redactSecretsForEmbed(body);
  }

  const title = escEmbed(p.lesson_title);
  const excerpt = escEmbed(p.lesson_excerpt);
  const date = escEmbed(p.lesson_date);

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>fleet lesson</title>
<style>
  html, body { margin: 0; padding: 0; background: #0E0F0D; color: #E8E2D4;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; }
  .embed-card { box-sizing: border-box; width: 100%; height: 100vh;
    display: flex; flex-direction: column; padding: 14px 16px; gap: 6px;
    overflow: hidden; }
  .embed-eyebrow { font-size: 10px; color: #807a6c; text-transform: lowercase; }
  .embed-title { font-size: 14px; font-weight: 700; line-height: 1.25;
    color: #E8E2D4; margin: 0; max-height: 2.5em; overflow: hidden;
    text-overflow: ellipsis; display: -webkit-box;
    -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .embed-excerpt { font-size: 11px; line-height: 1.35; color: #c8c2b4;
    flex: 1; overflow: hidden; max-height: 4em;
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    text-overflow: ellipsis; }
  .embed-foot { font-size: 10px; display: flex; justify-content: space-between;
    align-items: center; color: #807a6c; }
  .embed-foot a { color: #c0823c; text-decoration: none; }
</style>
</head>
<body>
<main class="embed-card">
  <div class="embed-eyebrow">fleet lesson · <span data-testid="embed-lessons-date">${date}</span></div>
  <h1 class="embed-title" data-testid="embed-lessons-title">${title}</h1>
  <p class="embed-excerpt" data-testid="embed-lessons-excerpt">${excerpt}</p>
  <div class="embed-foot"><a data-testid="embed-lessons-cta" href="${ctaHref}" target="_blank" rel="noopener">${ctaLabel}</a></div>
</main>
</body>
</html>`;
  return redactSecretsForEmbed(body);
}

export function _renderEmbedLessonsHtmlForTests(p: LessonEmbedPayload): string {
  return renderEmbedLessonsHtml(p);
}

/** Render the self-contained 320x200 SVG embed. Hand-rolled per the
 *  0015 + 0060 precedent — string concatenation, no template engine. */
export function renderEmbedLessonsSvg(p: LessonEmbedPayload): string {
  const w = EMBED_LESSONS_WIDTH;
  const h = EMBED_LESSONS_HEIGHT;

  if (p.kind === "empty") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="fleet lesson — still learning">`
      + `<rect width="100%" height="100%" fill="#0E0F0D"/>`
      + `<text x="16" y="24" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="10">fleet lesson</text>`
      + `<text x="16" y="${Math.floor(h / 2) + 4}" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="13" data-testid="embed-lessons-empty">fleet is still learning — no lessons yet</text>`
      + `<a href="${EMBED_CTA_HREF}" target="_blank">`
      + `<text x="16" y="${h - 14}" fill="#c0823c" font-family="ui-monospace,Menlo,monospace" font-size="10" data-testid="embed-lessons-cta">${escEmbed(EMBED_CTA_LABEL)}</text>`
      + `</a>`
      + `</svg>`;
  }

  const title = escEmbed(p.lesson_title);
  const excerpt = escEmbed(p.lesson_excerpt);
  const date = escEmbed(p.lesson_date);

  // Wrap the title across up to two lines and the excerpt across up to
  // two lines so the 320x200 frame stays readable. We do this with a
  // tiny word-wrap helper rather than relying on browser text-anchor
  // behaviour (SVG has none).
  const titleLines = wrapForSvg(title, 38, 2);
  const excerptLines = wrapForSvg(excerpt, 50, 2);

  const titleY0 = 56;
  const titleLineH = 18;
  const excerptY0 = titleY0 + titleLines.length * titleLineH + 12;
  const excerptLineH = 14;

  const titleTexts = titleLines.map((line, i) =>
    `<text x="16" y="${titleY0 + i * titleLineH}" fill="#E8E2D4" font-family="ui-monospace,Menlo,monospace" font-size="14" font-weight="700"${i === 0 ? ` data-testid="embed-lessons-title"` : ""}>${line}</text>`
  ).join("");
  const excerptTexts = excerptLines.map((line, i) =>
    `<text x="16" y="${excerptY0 + i * excerptLineH}" fill="#c8c2b4" font-family="ui-monospace,Menlo,monospace" font-size="11"${i === 0 ? ` data-testid="embed-lessons-excerpt"` : ""}>${line}</text>`
  ).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="fleet lesson">`
    + `<rect width="100%" height="100%" fill="#0E0F0D"/>`
    + `<text x="16" y="24" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="10">fleet lesson</text>`
    + `<text x="16" y="38" fill="#807a6c" font-family="ui-monospace,Menlo,monospace" font-size="10" data-testid="embed-lessons-date">${date}</text>`
    + titleTexts
    + excerptTexts
    + `<a href="${EMBED_CTA_HREF}" target="_blank">`
    + `<text x="16" y="${h - 14}" fill="#c0823c" font-family="ui-monospace,Menlo,monospace" font-size="10" data-testid="embed-lessons-cta">${escEmbed(EMBED_CTA_LABEL)}</text>`
    + `</a>`
    + `</svg>`;
}

export function _renderEmbedLessonsSvgForTests(p: LessonEmbedPayload): string {
  return renderEmbedLessonsSvg(p);
}

/** Word-wrap a single line into at most `maxLines` lines, each at most
 *  `maxChars` chars. Trailing tokens that overflow get an ellipsis. */
function wrapForSvg(text: string, maxChars: number, maxLines: number): string[] {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    if (lines.length === maxLines - 1) {
      // Last line — accumulate until adding the next word would overflow.
      const candidate = current ? current + " " + w : w;
      if (candidate.length <= maxChars) {
        current = candidate;
      } else {
        // Truncate with ellipsis.
        const room = maxChars - current.length - 1;
        if (room > 1) current = current + " " + w.slice(0, room - 1) + "…";
        else current = current + "…";
        lines.push(current);
        return lines;
      }
      continue;
    }
    const candidate = current ? current + " " + w : w;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Compose the three copy-pastable lesson-embed snippets for the
 *  /share page. Same shape as composeEmbedSnippets but pointing at
 *  /embed/lessons.* instead of /embed/pulse.*. */
export function composeEmbedLessonsSnippets(host: string): EmbedSnippetTriple {
  const safeHost = String(host ?? "").replace(/["'<>]/g, "");
  return {
    iframe: `<iframe src="${safeHost}/embed/lessons.html" width="${EMBED_LESSONS_WIDTH}" height="${EMBED_LESSONS_HEIGHT}" frameborder="0" title="fleet-control lesson of the day"></iframe>`,
    img: `<a href="${safeHost}/lessons-public"><img src="${safeHost}/embed/lessons.svg" alt="fleet lesson" width="${EMBED_LESSONS_WIDTH}" height="${EMBED_LESSONS_HEIGHT}"/></a>`,
    markdown: `[![fleet lesson](${safeHost}/embed/lessons.svg)](${safeHost}/lessons-public)`,
  };
}
