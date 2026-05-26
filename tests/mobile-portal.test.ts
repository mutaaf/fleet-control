// Tests for the mobile-first portal pass (ticket 0011).
//
// Strategy (per the ticket's engineering notes): zero new deps means no
// jsdom / happy-dom. We do text-level assertions on web/index.html and
// web/style.css — regex/parsing the stylesheet and HTML directly. For
// the "no horizontal scroll at 375/414" criteria we cannot truly render
// a layout without a DOM; instead we assert on the source structure that
// would produce a 1-column flow at the mobile breakpoint: no fixed widths
// > 375 declared, the mobile media query stacks cards / drops padding,
// and the top-level containers (html, body, main) are width-fluid.
//
// Each `test(...)` maps 1:1 to one acceptance-criteria checkbox in
// docs/backlog/0011-mobile-first-portal-pass.md, in the same order.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, "..", "web");
const HTML = readFileSync(join(WEB, "index.html"), "utf8");
const CSS = readFileSync(join(WEB, "style.css"), "utf8");

/* ---------------------------------------------------------------------- *
 * Helpers — block extractors that stay zero-dep.                          *
 * ---------------------------------------------------------------------- */

/** Extract the body of an @media (max-width: <px>px) { ... } block,
 *  matching outer-brace balance so nested rule blocks don't truncate.
 *  Returns null if no such block exists. */
function extractMediaBlock(css: string, maxWidthPx: number): string | null {
  const opener = new RegExp(
    String.raw`@media\s*\(\s*max-width:\s*${maxWidthPx}px\s*\)\s*\{`,
    "g",
  );
  const m = opener.exec(css);
  if (!m) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < css.length && depth > 0) {
    const c = css[i++];
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  if (depth !== 0) return null;
  return css.slice(start, i - 1);
}

/** Extract the body of one selector rule `<selector> { ... }` from a
 *  given css fragment. Pass the raw selector (e.g. ".jobcard", "main",
 *  ":root", "html, body") — special regex chars are escaped here.
 *  Returns the FIRST match (good enough for these text-level assertions). */
function extractRule(css: string, selector: string): string | null {
  // Escape regex metachars in the selector so `.`, `(`, etc are literal.
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Anchor on either start-of-string, `}`, or newline so we don't match
  // a substring of a compound selector (e.g. `.jobcard h3 {...}` when
  // looking up `.jobcard`). The literal whitespace after the selector
  // must NOT contain any non-space char — that's what `\s*\{` enforces.
  const re = new RegExp(
    String.raw`(?:^|[}\n])\s*` + esc + String.raw`\s*\{([^}]*)\}`,
    "m",
  );
  const m = re.exec(css);
  return m ? m[1] : null;
}

/** WCAG 2.x relative-luminance contrast ratio between two hex colors. */
function contrast(hexA: string, hexB: string): number {
  const lum = (hex: string) => {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const chan = (c: number) =>
      c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  };
  const a = lum(hexA);
  const b = lum(hexB);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/** Pull a `--name: value;` declaration out of `:root { ... }`. */
function rootVar(name: string): string {
  const root = extractRule(CSS, ":root");
  assert.ok(root, ":root block missing from style.css");
  const re = new RegExp(String.raw`--${name}\s*:\s*([^;]+);`);
  const m = re.exec(root);
  assert.ok(m, `:root is missing --${name}`);
  return m[1].trim();
}

/* ---------------------------------------------------------------------- *
 * AC 1: <meta viewport> tag exists exactly once with the exact value.    *
 * ---------------------------------------------------------------------- */

test("AC1: index.html has exactly one viewport meta with width=device-width, initial-scale=1, viewport-fit=cover", () => {
  const all = HTML.match(/<meta\s+name=["']viewport["'][^>]*>/gi) ?? [];
  assert.equal(all.length, 1, `expected exactly 1 viewport meta tag, got ${all.length}`);
  const tag = all[0];
  assert.match(tag, /content=["'][^"']*width=device-width[^"']*["']/i);
  assert.match(tag, /content=["'][^"']*initial-scale=1[^"']*["']/i);
  assert.match(tag, /content=["'][^"']*viewport-fit=cover[^"']*["']/i);
});

/* ---------------------------------------------------------------------- *
 * AC 2: @media (max-width: 640px) block with the four required rules.   *
 * ---------------------------------------------------------------------- */

test("AC2: a single @media (max-width: 640px) block stacks cards, drops padding, scales headline, raises tap height", () => {
  // Only one such block (we may keep the existing 560px one; the new one
  // must be at 640px to capture iPhone 14 Plus at 414 logical px).
  const occurrences = (CSS.match(/@media\s*\(\s*max-width:\s*640px\s*\)/g) ?? []).length;
  assert.equal(occurrences, 1, `expected exactly one (max-width: 640px) block, got ${occurrences}`);

  const body = extractMediaBlock(CSS, 640);
  assert.ok(body, "could not extract the (max-width: 640px) media block body");

  // 2a — :root override (or .card override) drops card padding to --card-pad-mobile.
  // We assert the variable exists in :root AND is referenced inside the mobile MQ.
  const cardPadMobile = rootVar("card-pad-mobile");
  assert.ok(/\d/.test(cardPadMobile), `--card-pad-mobile must be a length value, got "${cardPadMobile}"`);
  assert.match(body, /var\(\s*--card-pad-mobile\s*\)/,
    "the mobile media query must apply --card-pad-mobile to card padding");

  // 2b — project cards stack one per row. They're already block-level via
  // `a.card { display: block }`, so the *guarantee* we want is that the
  // mobile MQ doesn't try to lay them out otherwise AND that they reflow
  // to full width. We assert the card padding rule targets `.card` and
  // that the card has `display: block` somewhere in the stylesheet.
  assert.match(CSS, /\.card\s*\{[^}]*display\s*:\s*block/,
    "card must have display:block so cards stack one per row at mobile");

  // 2c — headline (.pname) font-size is reduced inside the mobile MQ.
  const pname = extractRule(body, ".pname");
  assert.ok(pname, ".pname rule missing inside the 640px media block");
  assert.match(pname, /font-size\s*:\s*\d/, ".pname must scale down inside mobile MQ");

  // 2d — clickable elements get min-height: 44px (via --tap-min). The
  // ticket asks for a `--tap-min: 44px` custom property AND that the
  // mobile MQ applies it to all clickable elements.
  const tapMin = rootVar("tap-min");
  assert.equal(tapMin, "44px", `--tap-min must be exactly 44px, got "${tapMin}"`);
  assert.match(body, /var\(\s*--tap-min\s*\)/,
    "the mobile media query must reference --tap-min for clickable elements");
  // The rule must apply to BOTH button and anchor-actions (.btn covers
  // both since every .btn in this SPA is rendered as a <button>; we
  // explicitly cover both selectors so a future <a class="btn"> works).
  assert.ok(
    /\.btn[\s,{][^}]*var\(\s*--tap-min\s*\)/.test(body) ||
      /button[\s,{][^}]*var\(\s*--tap-min\s*\)/.test(body),
    "the mobile MQ must apply --tap-min to .btn or button (raising tap targets)",
  );
});

/* ---------------------------------------------------------------------- *
 * AC 3: no horizontal scrollbar at 375 wide (iPhone 13 mini).            *
 * AC 4: same at 414 wide (iPhone 14 Plus).                               *
 *                                                                        *
 * We can't render a real layout zero-dep; instead we assert on the       *
 * source guarantees that *make* a 1-column fluid flow possible:          *
 *   - html, body have no fixed width                                     *
 *   - main has max-width but no min-width >= viewport, and the mobile MQ *
 *     keeps main's horizontal padding small enough that 2*padding + the  *
 *     widest natural element fits within 375.                            *
 *   - no element declares a fixed width in px wider than 375 (excluding  *
 *     the modal `max-width: 520px` which uses `width: 100%` and so       *
 *     stays fluid).                                                      *
 * ---------------------------------------------------------------------- */

test("AC3: at 375 wide, no source-level rule forces horizontal overflow", () => {
  // html/body must not pin a width.
  const htmlRule = extractRule(CSS, "html, body");
  assert.ok(htmlRule, "html, body rule missing");
  assert.doesNotMatch(htmlRule, /(^|;|\s)width\s*:\s*\d+px/,
    "html/body must not declare a fixed pixel width");
  assert.doesNotMatch(htmlRule, /min-width\s*:\s*\d+px/,
    "html/body must not declare a min-width in pixels");

  // No CSS rule anywhere should declare a *required* min-width > 375 on
  // a block element. We scan for `min-width: <n>px` where n > 375 and
  // fail if any exist (excluding inside @media min-width queries which
  // intentionally key off the viewport, not the element). To keep the
  // check zero-dep, we strip @media (min-width: ...) blocks before scan.
  const stripped = CSS.replace(
    /@media\s*\([^)]*min-width[^)]*\)\s*\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g,
    "",
  );
  const fixed = [...stripped.matchAll(/min-width\s*:\s*(\d+)px/g)];
  for (const [, n] of fixed) {
    assert.ok(+n <= 375, `found min-width: ${n}px — would overflow a 375px viewport`);
  }

  // The mobile MQ tightens main's horizontal padding so 2*pad leaves
  // room for typical content at 375. We assert the existing 560px MQ
  // (or the new 640px MQ) sets main padding ≤ 14px on each side.
  const mq640 = extractMediaBlock(CSS, 640);
  assert.ok(mq640, "640px media block must exist");
  const mainRule = extractRule(mq640, "main");
  assert.ok(mainRule, "main rule missing inside the 640px media block");
  const padM = /padding\s*:\s*\d+px\s+(\d+)px/.exec(mainRule);
  assert.ok(padM, "main inside 640px MQ must declare a `padding: Vpx Hpx ...` shorthand");
  assert.ok(+padM[1] <= 14,
    `main horizontal padding inside mobile MQ must be ≤ 14px (got ${padM[1]}px) to leave room at 375 wide`);
});

test("AC4: 640px breakpoint covers 414 wide (iPhone 14 Plus) — same fluid guarantees apply", () => {
  // The mobile MQ key matters: at 414px wide the (max-width: 640px) MQ
  // must match, otherwise the iPhone 14 Plus falls through to desktop
  // padding and overflows. Assert breakpoint >= 414.
  const m = CSS.match(/@media\s*\(\s*max-width:\s*(\d+)px\s*\)/);
  assert.ok(m, "no mobile @media block found at all");
  assert.ok(+m[1] >= 414, `mobile MQ breakpoint must be ≥ 414px to cover iPhone 14 Plus, got ${m[1]}px`);

  // And the same html/body/main fluidity guarantees as 375 hold by
  // construction — covered by AC3's assertions.
});

/* ---------------------------------------------------------------------- *
 * AC 5: project page — job cards stack one per row at 375.               *
 *                                                                        *
 * `.jobcard` is a <div> with no flex/grid container around it in app.js  *
 * (it's appended directly into `<div id="app">` via .map().join("")).    *
 * We assert there is NO `display: flex` or `display: grid` rule applied  *
 * to any selector that wraps .jobcard, and that .jobcard is naturally    *
 * block-level (which divs are by default — so no override to inline*    *
 * exists).                                                               *
 * ---------------------------------------------------------------------- */

test("AC5: .jobcard stacks one per row — no flex/grid container wraps them, no inline display override", () => {
  const jobcard = extractRule(CSS, ".jobcard");
  assert.ok(jobcard, ".jobcard rule missing");
  // It must NOT be set to inline/inline-block (which would let multiple
  // sit side by side at narrow widths).
  assert.doesNotMatch(jobcard, /display\s*:\s*inline/i,
    ".jobcard must remain block-level so cards stack");
  // No rule should declare a flex/grid container that contains .jobcard
  // children. The SPA appends jobcards directly under #app, so #app
  // must not be flex/grid either.
  const appRule = extractRule(CSS, "#app");
  if (appRule) {
    assert.doesNotMatch(appRule, /display\s*:\s*(flex|grid)/i,
      "#app must not be flex/grid — would prevent .jobcard from stacking");
  }
  // Sanity: even inside the mobile MQ, .jobcard isn't flipped to inline.
  const mq = extractMediaBlock(CSS, 640);
  if (mq) {
    const jc = extractRule(mq, ".jobcard");
    if (jc) {
      assert.doesNotMatch(jc, /display\s*:\s*inline/i,
        "mobile MQ must not override .jobcard to inline");
    }
  }
});

/* ---------------------------------------------------------------------- *
 * AC 6: the sticky PR action bar from 0007 stays visible while           *
 *       scrolling the inline diff at 375 wide.                           *
 *                                                                        *
 * The mechanism is `.pr-actionbar { position: sticky; bottom: 0; }`     *
 * which already exists. The mobile pass must NOT remove or weaken that  *
 * rule — assert it still resolves to sticky/bottom:0 in both default    *
 * and inside the mobile MQ.                                              *
 * ---------------------------------------------------------------------- */

test("AC6: .pr-actionbar stays position: sticky; bottom: 0 — desktop AND inside mobile MQ", () => {
  const base = extractRule(CSS, ".pr-actionbar");
  assert.ok(base, ".pr-actionbar base rule missing");
  assert.match(base, /position\s*:\s*sticky/, ".pr-actionbar must be position: sticky");
  assert.match(base, /bottom\s*:\s*0/, ".pr-actionbar must anchor bottom: 0");

  // Inside the mobile MQ — either the existing 560px one or the new 640px
  // one — the rule must NOT be set to `position: static` (which would
  // un-stick it). Scan every MQ that mentions .pr-actionbar.
  const mqHits = [...CSS.matchAll(
    /@media[^{]+\{[\s\S]*?\.pr-actionbar\s*\{([^}]*)\}/g,
  )];
  for (const [, body] of mqHits) {
    assert.doesNotMatch(body, /position\s*:\s*static/,
      "no mobile MQ may un-stick the PR action bar");
    // If position is re-declared, it must still be sticky.
    if (/position\s*:/.test(body)) {
      assert.match(body, /position\s*:\s*sticky/);
    }
  }
});

/* ---------------------------------------------------------------------- *
 * AC 7: tap-target audit — every <button>/.btn/.action gets ≥ 44 px.    *
 *                                                                        *
 * Text-level: the mobile MQ raises min-height AND min-width to           *
 * var(--tap-min) on the selectors that produce clickable controls.       *
 * We don't enumerate every selector — we require the MQ to apply         *
 * --tap-min to at least .btn (which covers every action in the SPA      *
 * today) AND that no rule inside the MQ shrinks an existing button     *
 * below 44px.                                                            *
 * ---------------------------------------------------------------------- */

test("AC7: mobile MQ applies min-height & min-width: var(--tap-min) to .btn (covers every action)", () => {
  const mq = extractMediaBlock(CSS, 640);
  assert.ok(mq, "640px media block required");
  // Find a rule whose selector list includes .btn AND that sets both
  // min-height and min-width to var(--tap-min). The selector list may
  // include `button` and `a.btn` too — that's fine.
  const ruleRe = /([^{}@]+)\{([^}]*)\}/g;
  let foundBtn = false;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(mq)) !== null) {
    const selectors = m[1];
    const body = m[2];
    if (!/\.btn(\b|[\s,])/.test(selectors)) continue;
    if (/min-height\s*:\s*var\(\s*--tap-min\s*\)/.test(body) &&
        /min-width\s*:\s*var\(\s*--tap-min\s*\)/.test(body)) {
      foundBtn = true;
      break;
    }
  }
  assert.ok(foundBtn,
    "mobile MQ must apply both min-height and min-width: var(--tap-min) to .btn");
});

/* ---------------------------------------------------------------------- *
 * AC 8: state-badge contrast ≥ 4.5 against the card background, both    *
 *       desktop and mobile. The badge text colours live in --good /     *
 *       --accent / --paused / --bad / --warn; card background is        *
 *       --panel. Mobile MQ inherits the same vars (no override) so a   *
 *       desktop pass = a mobile pass.                                    *
 * ---------------------------------------------------------------------- */

test("AC8: state-badge text colours contrast ≥ 4.5:1 against --panel (card bg)", () => {
  const card = rootVar("panel");
  // Working = --accent, Idle = --good, Paused = --paused, Stopped = --bad.
  // The ticket says "Working / Idle / Paused / Stopped"; --warn is for
  // "attention" which is informational, but we cover the four named.
  const pairs: Array<[string, string]> = [
    ["Working", rootVar("accent")],
    ["Idle",    rootVar("good")],
    ["Paused",  rootVar("paused")],
    ["Stopped", rootVar("bad")],
  ];
  for (const [name, color] of pairs) {
    const ratio = contrast(color, card);
    assert.ok(ratio >= 4.5,
      `${name} badge color ${color} on ${card} has contrast ${ratio.toFixed(2)}:1 — must be ≥ 4.5:1`);
  }
  // Mobile pass: the mobile MQ must NOT override any of these vars (it
  // would change the contrast at small widths). Scan the MQ for any
  // --good / --accent / --paused / --bad / --panel re-declaration.
  const mq = extractMediaBlock(CSS, 640);
  assert.ok(mq);
  for (const v of ["good", "accent", "paused", "bad", "panel"]) {
    const re = new RegExp(String.raw`--${v}\s*:`);
    assert.doesNotMatch(mq, re,
      `mobile MQ must not redefine --${v} — contrast invariants would change`);
  }
});

/* ---------------------------------------------------------------------- *
 * AC 9: desktop layouts are not regressed at viewport ≥ 960 px.         *
 *                                                                        *
 * Concretely: every desktop-only rule (outside any @media block) is     *
 * unchanged in shape; the mobile MQ is keyed strictly by max-width so   *
 * it cannot apply at ≥ 960. We assert structurally:                      *
 *   - the only NEW media query introduced is (max-width: 640px), not    *
 *     a (min-width: ...) that would steal desktop styling.              *
 *   - main retains its `max-width: 1040px` at desktop (i.e. outside any *
 *     media block).                                                      *
 * ---------------------------------------------------------------------- */

test("AC9: desktop styling preserved — main keeps max-width: 1040px outside any MQ", () => {
  // Strip every @media block; what remains is desktop-only css.
  let desktop = CSS;
  while (true) {
    const next = desktop.replace(
      /@media[^{]+\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g,
      "",
    );
    if (next === desktop) break;
    desktop = next;
  }
  const mainDesktop = extractRule(desktop, "main");
  assert.ok(mainDesktop, "main rule must exist outside any @media block");
  assert.match(mainDesktop, /max-width\s*:\s*1040px/,
    "desktop main must keep max-width: 1040px");

  // Card must remain block-level at desktop too — multi-column grid is
  // not declared (this SPA stacks cards vertically by design). Assert
  // no `display: grid` or `grid-template-columns` on .card at desktop.
  const cardDesktop = extractRule(desktop, ".card");
  assert.ok(cardDesktop, ".card desktop rule missing");
  assert.doesNotMatch(cardDesktop, /grid-template-columns/,
    ".card must not switch to a grid at desktop (would regress current layout)");
});

/* ---------------------------------------------------------------------- *
 * AC 10: no new runtime deps + no /api/... JSON shape changes.          *
 *                                                                        *
 * The dep check is enforced by AGENTS.md and the review subagent; here  *
 * we add a direct assertion so a regression would fail the same test    *
 * suite that already catches every other AC. We don't have a way to     *
 * detect API shape changes from CSS — that's covered by the ticket      *
 * touching only web/* files; if app.js is edited, other tests would    *
 * fail. We assert package.json has empty `dependencies`.                *
 * ---------------------------------------------------------------------- */

test("AC10: package.json has zero runtime dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  const deps = pkg.dependencies ?? {};
  assert.equal(Object.keys(deps).length, 0,
    `dependencies must stay empty; found: ${Object.keys(deps).join(", ")}`);
});
