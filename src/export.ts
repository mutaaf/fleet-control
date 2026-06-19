// fleetctl export portfolio CLI subcommand (ticket 0070).
//
// One command snapshots the operator's accumulated fleet history into
// a SINGLE self-contained portfolio.html file - inlined CSS, OG card
// as a data: URI, no external fetches at view time - so the operator
// can email it to a recruiter, attach it to a CV, git-commit it to a
// personal-website repo, or archive it on a USB stick. The file the
// operator owns survives any future uninstall of fleet-control: the
// accumulated-history moat becomes a portable artifact.
//
// This module is the pure-logic side. The CLI shim in bin/fleetctl.ts
// imports runExportPortfolioCli and pipes argv + the live cfg in.
// Every side-effecting boundary (the file-write itself) is gated
// through a writer seam so the tests never touch disk when they only
// want to inspect the composed HTML.
//
// Per LESSONS 2026-06-13 this is a NEW module rather than a sibling
// helper in src/views.ts. The export module imports views.ts one-way
// for the payload helpers (operatorProfilePayload, lessonCreditRollup,
// renderOperatorOgSvg) and receipts.ts for the receipts shape;
// neither of those imports src/export.ts back, so no function-import
// cycle. The globalThis-slot pattern is the wrong shape here - no
// caches, no ingest-vs-server asymmetry.
//
// Per LESSONS 2026-05-26 the file-write boundary is gated through a
// module-level mutable activeWriter plus exported
// _setExportWriterForTests / _resetExportWriterForTests helpers so
// the tests can assert the path + payload without touching disk. Per
// AGENTS.md Hard NOs there is NO shell-out from this module - the
// writer is plain node:fs writeFileSync. Per LESSONS 2026-06-11 the
// leading comment block above uses plain prose for sibling-helper-
// grep-vulnerable identifiers; no backticks around helper names that
// also appear in adjacent view-renderer source.
//
// Per LESSONS 2026-06-15 any static-grep test that pins the no-script
// or no-stylesheet property MUST anchor on the exact statement shape
// (the if-prefix pattern is reused here for the no-fetch composer
// guard so a prose mention of the gate does not trip the assertion).
//
// Zero new runtime deps.
import { writeFileSync, existsSync } from "node:fs";
import type { DB } from "./db.ts";
import type { FleetConfig } from "./config.ts";
import {
  operatorProfilePayload,
  lessonCreditRollup,
  renderOperatorOgSvg,
  type OperatorProfilePayload,
  type LessonCreditByLesson,
} from "./views.ts";
import { receiptsFor, type ReceiptsPayload } from "./receipts.ts";

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

/** Args accepted by composePortfolioHtml. Pure on its inputs - the
 *  composer reads only the fields it documents and returns the full
 *  HTML string. Tests drive this composer with a hand-rolled payload
 *  so the file-write boundary stays out of scope of the AC2 / AC3 /
 *  AC4 / AC5 / AC6 cases. */
export interface ComposePortfolioHtmlArgs {
  profile: OperatorProfilePayload;
  lessons: LessonCreditByLesson[];
  receipts: ReceiptsPayload[];
  now: Date;
  includeLessons: boolean;
  includeReceipts: boolean;
}

/** Result of runExportPortfolioCli - the in-process driver the
 *  bin/fleetctl.ts shim wraps. Everything is captured (stdout, stderr,
 *  exitCode, writtenPath) so tests assert without spawning a
 *  subprocess for the writer-seam cases. */
export interface ExportPortfolioCliResult {
  exitCode: 0 | 1;
  /** Buffered stdout. The CLI shim writes this to process.stdout. */
  stdout: string;
  /** Buffered stderr. The CLI shim writes this to process.stderr. */
  stderr: string;
  /** Path the file was written to. Empty string when the CLI did not
   *  get far enough to write a file (e.g. missing operator.handle,
   *  path-safety reject). */
  writtenPath: string;
}

/** The writer-seam contract. Production wires writeFileSync via the
 *  defaultExportWriter below; tests swap a stub that records the path
 *  + payload without touching disk. */
export type ExportWriter = (path: string, html: string) => void;

// ────────────────────────────────────────────────────────────────────
// Writer seam.
//
// Per LESSONS 2026-05-26 "shell-out modules need an injectable runner
// for tests" - even though this boundary is a file write, not a shell-
// out, the principle is the same: a single chokepoint that tests can
// swap. The leading underscore signals "do not call in production".
// ────────────────────────────────────────────────────────────────────

function defaultExportWriter(path: string, html: string): void {
  writeFileSync(path, html, { encoding: "utf8" });
}

let activeWriter: ExportWriter = defaultExportWriter;

/** Swap the file-write boundary. Tests call this in a try / finally
 *  so the seam is restored after each assertion. The leading
 *  underscore signals "do not call in production". */
export function _setExportWriterForTests(fn: ExportWriter): void {
  activeWriter = fn;
}

/** Restore the production writer. Tests call this in their finally
 *  block to keep cross-test state clean. */
export function _resetExportWriterForTests(): void {
  activeWriter = defaultExportWriter;
}

/** Pure-function wrapper around the writer seam. Production callers
 *  go through this so the seam stays a single chokepoint. */
export function writePortfolioFile(path: string, html: string): void {
  activeWriter(path, html);
}

// ────────────────────────────────────────────────────────────────────
// HTML escape + helpers
// ────────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

/** Inlined stylesheet - kept compact + deliberately self-contained.
 *  The portfolio is read offline; no external fonts, no JS, no CSS
 *  variables that depend on other rules from style.css. The shape
 *  mirrors the 0065 operator profile + the 0041 receipts page but in
 *  a single rule-set tuned for print and email rendering. */
const PORTFOLIO_CSS = [
  "*{box-sizing:border-box}",
  "body{margin:0;padding:32px 24px;font-family:ui-monospace,Menlo,Consolas,monospace;background:#0E0F0D;color:#E8E2D4;line-height:1.5}",
  ".portfolio{max-width:880px;margin:0 auto}",
  ".portfolio-header{margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid #2a2722}",
  ".portfolio-handle{font-size:36px;font-weight:700;margin:0 0 8px 0;color:#E8E2D4}",
  ".portfolio-display-name{font-size:18px;color:#9c9587;margin-bottom:4px}",
  ".portfolio-headline{font-size:14px;color:#807a6c}",
  ".portfolio-since{font-size:13px;color:#807a6c;margin-top:8px}",
  ".portfolio-og{margin:16px 0 24px 0;text-align:center}",
  ".portfolio-og img{max-width:100%;height:auto;border:1px solid #2a2722;border-radius:6px}",
  ".portfolio-totals{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}",
  ".portfolio-stat{padding:12px;background:#171612;border:1px solid #2a2722;border-radius:6px;text-align:center}",
  ".portfolio-stat-value{display:block;font-size:28px;font-weight:700;color:#E8E2D4}",
  ".portfolio-stat-label{display:block;font-size:11px;color:#807a6c;margin-top:4px}",
  ".portfolio-section{margin-bottom:24px}",
  ".portfolio-section h2{font-size:15px;font-weight:700;color:#9c9587;margin:0 0 12px 0;text-transform:uppercase;letter-spacing:0.05em}",
  ".portfolio-section ol{margin:0;padding-left:20px}",
  ".portfolio-section li{margin-bottom:8px;font-size:13px;color:#E8E2D4}",
  ".portfolio-section li .meta{color:#807a6c;font-size:12px}",
  ".portfolio-empty{font-size:13px;color:#807a6c;font-style:italic}",
  ".portfolio-warming{padding:16px;background:#171612;border:1px solid #2a2722;border-radius:6px;font-size:14px;color:#9c9587;text-align:center}",
  ".portfolio-footer{margin-top:32px;padding-top:16px;border-top:1px solid #2a2722;font-size:12px;color:#807a6c;text-align:center}",
  ".portfolio-footer a{color:#9c9587;text-decoration:underline}",
  "@media print{body{background:#fff;color:#000}.portfolio-stat{background:#f5f3ed;border-color:#d8d2c4}.portfolio-stat-value,.portfolio-handle,.portfolio-section li{color:#000}.portfolio-display-name,.portfolio-headline,.portfolio-since,.portfolio-section h2,.portfolio-section li .meta,.portfolio-empty,.portfolio-footer{color:#555}}",
].join("");

const INSTALL_URL = "https://github.com/" + "mutaaf/fleet-control";

/** Format a receipt's month_iso as "May 2026" without depending on
 *  toLocaleString (which is locale-sensitive). Mirrors the helper
 *  in src/receipts.ts so the portfolio's month labels read the same
 *  whether the receipt was published with or without a fresh
 *  computeReceipts pass. */
function fmtReceiptDate(monthIso: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(monthIso);
  if (!m) return monthIso;
  const names = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const y = Number(m[1]);
  const monthIdx = Number(m[2]) - 1;
  return `${names[monthIdx] ?? monthIso} ${y}`;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v < 100) return "$" + v.toFixed(2);
  return "$" + Math.round(v).toString();
}

// ────────────────────────────────────────────────────────────────────
// composePortfolioHtml - the pure HTML composer.
//
// Returns the full HTML string starting with <!DOCTYPE html> and
// ending with the manifest comment block. Pure on its inputs - same
// inputs always produce the same output (modulo the now-stamped
// asOf line in the manifest, which the AC1 test provides via the
// `now` arg).
// ────────────────────────────────────────────────────────────────────

export function composePortfolioHtml(args: ComposePortfolioHtmlArgs): string {
  const { profile, lessons, receipts, now, includeLessons, includeReceipts } = args;
  const handle = esc(profile.handle);
  const displayName = esc(profile.displayName);
  const headline = esc(profile.headline);
  const sinceDate = esc(profile.sinceDate);

  // Inline the OG card as a data: URI so the file has zero external
  // image fetches. The base64 encoding is the standard portable form
  // browsers accept in data: URIs - the SVG decodes cleanly back to
  // the same bytes renderOperatorOgSvg produced.
  const svg = renderOperatorOgSvg(profile);
  const svgB64 = Buffer.from(svg, "utf8").toString("base64");
  const ogAlt = esc(`${profile.displayName}'s fleet portfolio card`);
  const ogTag = `<img alt="${ogAlt}" src="data:image/svg+xml;base64,${svgB64}">`;

  const totals = profile.totals;
  const isWarming = totals.lifetimePrsShipped === 0;

  // Receipts section: 12 most-recent published receipts. Section is
  // OMITTED entirely when includeReceipts=false. When included on a
  // zero-receipt fleet, render an honest empty-state line.
  const receiptsHtml = includeReceipts ? (() => {
    if (receipts.length === 0) {
      return `<section class="portfolio-section" data-testid="portfolio-receipts-section">`
        + `<h2>Monthly receipts</h2>`
        + `<p class="portfolio-empty">no receipts published yet</p>`
        + `</section>`;
    }
    const items = receipts.slice(0, 12).map((r, i) => {
      const month = esc(fmtReceiptDate(r.month_iso));
      const slug = esc(r.project_slug);
      const prs = r.merged_prs;
      const spend = fmtUsd(r.total_spend_usd);
      return `<li data-testid="portfolio-receipt-${i}">`
        + `<span class="meta">${month} · ${slug}</span> — `
        + `${prs} PR${prs === 1 ? "" : "s"} merged for ${esc(spend)}`
        + `</li>`;
    }).join("");
    return `<section class="portfolio-section" data-testid="portfolio-receipts-section">`
      + `<h2>Monthly receipts (last 12)</h2>`
      + `<ol>${items}</ol>`
      + `</section>`;
  })() : "";

  // Lessons section: top 10 by saves. Section is OMITTED entirely
  // when includeLessons=false. When included on a zero-lesson fleet,
  // render an honest empty-state line.
  const lessonsHtml = includeLessons ? (() => {
    if (lessons.length === 0) {
      return `<section class="portfolio-section" data-testid="portfolio-lessons-section">`
        + `<h2>Top cross-fleet lessons</h2>`
        + `<p class="portfolio-empty">no lessons credited yet</p>`
        + `</section>`;
    }
    const items = lessons.slice(0, 10).map((L, i) => {
      const title = esc(L.lesson_title);
      const date = esc(L.lesson_date);
      const saves = L.saves;
      return `<li data-testid="portfolio-lesson-${i}">`
        + `${title} `
        + `<span class="meta">(${date} · ${saves} save${saves === 1 ? "" : "s"})</span>`
        + `</li>`;
    }).join("");
    return `<section class="portfolio-section" data-testid="portfolio-lessons-section">`
      + `<h2>Top cross-fleet lessons</h2>`
      + `<ol>${items}</ol>`
      + `</section>`;
  })() : "";

  // Warming-up body branch - operator with zero lifetime PRs sees
  // the same copy the 0065 operator-profile page uses, alongside
  // each section's honest empty-state line.
  const bodyHero = isWarming
    ? `<section class="portfolio-warming" data-testid="operator-profile-warming-up">`
      + `your fleet is still warming up - check back after your first 3 ships.`
      + `</section>`
    : `<section class="portfolio-totals" data-testid="portfolio-totals">`
      + `<div class="portfolio-stat"><span class="portfolio-stat-value">${totals.lifetimePrsShipped}</span><span class="portfolio-stat-label">PRs shipped</span></div>`
      + `<div class="portfolio-stat"><span class="portfolio-stat-value">${totals.lessonsAuthored}</span><span class="portfolio-stat-label">lessons authored</span></div>`
      + `<div class="portfolio-stat"><span class="portfolio-stat-value">${totals.projectsActive}</span><span class="portfolio-stat-label">projects active</span></div>`
      + `<div class="portfolio-stat"><span class="portfolio-stat-value">${totals.monthsRunning}</span><span class="portfolio-stat-label">months running</span></div>`
      + `</section>`;

  // Manifest values for the AC5 grep. lifetime_prs / lessons / months
  // come from the profile totals - the same numbers the hero
  // renders. monthsRunning is the same as the hero stat block.
  const lifetimePrs = totals.lifetimePrsShipped;
  const lessonsCount = totals.lessonsAuthored;
  const monthsCount = totals.monthsRunning;
  const generatedAt = now.toISOString();
  const manifest = `<!-- fleet-control portfolio export, version 1, generated ${generatedAt}, lifetime_prs ${lifetimePrs}, lessons ${lessonsCount}, months ${monthsCount} -->`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${displayName} - fleet operator portfolio</title>
<style>${PORTFOLIO_CSS}</style>
</head>
<body>
<main class="portfolio">
  <header class="portfolio-header">
    <h1 class="portfolio-handle" data-testid="operator-profile-handle">${handle}</h1>
    <div class="portfolio-display-name">${displayName}</div>
    <div class="portfolio-headline">${headline}</div>
    <div class="portfolio-since">fleet operator since ${sinceDate}</div>
  </header>
  <div class="portfolio-og" data-testid="portfolio-og-card">${ogTag}</div>
  ${bodyHero}
  ${receiptsHtml}
  ${lessonsHtml}
  <footer class="portfolio-footer">
    ${displayName} - powered by <a href="${INSTALL_URL}">fleet-control</a>
  </footer>
</main>
</body>
</html>
${manifest}`;
}

// ────────────────────────────────────────────────────────────────────
// Per-section payload helpers.
//
// Each one composes the data the composer needs from the existing
// payload helpers in views.ts / receipts.ts. Pure functions of
// (db, cfg, now) - the export module is the only caller, so we keep
// them file-scoped.
// ────────────────────────────────────────────────────────────────────

/** Compose the lessons section payload: top 10 by saves over the
 *  trailing 365 days, per the ticket spec. Wraps lessonCreditRollup
 *  with a windowDays=365 option. */
function buildLessonsSection(db: DB, now: Date): LessonCreditByLesson[] {
  const rollup = lessonCreditRollup(db, now, { windowDays: 365 });
  return rollup.by_lesson.slice(0, 10);
}

/** Compose the receipts section payload: the 12 most-recent
 *  published receipts. Reads receipts_published directly so the
 *  shape matches receiptsFor() output - we only need the four
 *  numbers per row + the month label for the portfolio render. */
function buildReceiptsSection(db: DB, now: Date): ReceiptsPayload[] {
  // We pull the (project_slug, month_iso) pairs ordered by
  // published_at DESC, then load each via receiptsFor for the typed
  // payload. The composite key on receipts_published guarantees the
  // pairs are unique, so the result is at most one row per (slug,
  // month).
  const rows = db.prepare(
    "SELECT project_slug, month_iso FROM receipts_published "
    + "ORDER BY published_at DESC LIMIT 12",
  ).all() as unknown as Array<{ project_slug: string; month_iso: string }>;
  const out: ReceiptsPayload[] = [];
  for (const r of rows) {
    const p = receiptsFor(db, r.project_slug, r.month_iso, now);
    if (p) out.push(p);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Argv parser
//
// Supports --out <path>, --out=<path>, --include-lessons[=false],
// --include-receipts[=false]. Defaults: out = derived from handle +
// date, both --include-* flags = true. The =false form is the only
// way to opt out (mirrors LESSONS 2026-05-26 § "the existing CLI
// arg-parser convention").
// ────────────────────────────────────────────────────────────────────

interface ParsedArgs {
  out?: string;
  includeLessons: boolean;
  includeReceipts: boolean;
  help: boolean;
}

function parseExportArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    includeLessons: true,
    includeReceipts: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--help" || tok === "-h") {
      parsed.help = true;
      continue;
    }
    if (tok === "--out") {
      parsed.out = argv[i + 1];
      i += 1;
      continue;
    }
    if (tok.startsWith("--out=")) {
      parsed.out = tok.slice("--out=".length);
      continue;
    }
    if (tok === "--include-lessons=false" || tok === "--no-include-lessons") {
      parsed.includeLessons = false;
      continue;
    }
    if (tok === "--include-lessons=true" || tok === "--include-lessons") {
      parsed.includeLessons = true;
      continue;
    }
    if (tok === "--include-receipts=false" || tok === "--no-include-receipts") {
      parsed.includeReceipts = false;
      continue;
    }
    if (tok === "--include-receipts=true" || tok === "--include-receipts") {
      parsed.includeReceipts = true;
      continue;
    }
  }
  return parsed;
}

// ────────────────────────────────────────────────────────────────────
// Path-safety: reject any --out path containing `..` segments or NUL
// bytes. Per AC8 + the cross-fleet path-validation lesson. We reject
// on the raw string BEFORE resolving / normalising so a path like
// `../etc/passwd` cannot slip through a join() collapse.
// ────────────────────────────────────────────────────────────────────

/** Returns null when the path is safe; returns a stderr line otherwise.
 *  The caller writes the stderr line and exits 1. */
function pathSafetyReject(p: string): string | null {
  if (typeof p !== "string" || p.length === 0) {
    return "invalid --out path: traversal segments not allowed";
  }
  if (p.includes("\0")) {
    return "invalid --out path: traversal segments not allowed";
  }
  // Split on / and \ so the rule catches Windows-style traversal too,
  // even though the production binary is macOS / Linux only.
  const segments = p.split(/[/\\]/);
  for (const seg of segments) {
    if (seg === "..") {
      return "invalid --out path: traversal segments not allowed";
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────
// Help block. Mirrors the share help shape so the operator sees the
// same usage syntax across sibling subcommands.
// ────────────────────────────────────────────────────────────────────

const HELP = [
  "usage: fleetctl export portfolio [--out <path>] [--include-lessons=false] [--include-receipts=false]",
  "",
  "Write a single self-contained portfolio.html bundle. Inlined CSS, OG card",
  "as a data: URI, no external fetches at view time - the operator owns the",
  "file forever even if fleet-control is uninstalled tomorrow.",
  "",
  "Sub-surfaces:",
  "  portfolio   single-file HTML carrying profile + last 12 receipts + top 10 lessons",
  "",
  "Flags:",
  "  --out <path>            override default ./fleet-portfolio-<handle>-<YYYY-MM-DD>.html",
  "  --include-lessons=false omit the lessons section",
  "  --include-receipts=false omit the receipts section",
  "",
  "Example: fleetctl export portfolio --out ~/Documents/fleet-2026-q2.html",
  "",
].join("\n");

// ────────────────────────────────────────────────────────────────────
// runExportPortfolioCli - the testable in-process driver.
//
// The bin/fleetctl.ts shim hands in (db, cfg, argv, now) and writes
// the returned stdout / stderr to the real process streams. Tests
// drive the same function directly so the writer seam is exercised
// without spawning a subprocess on every assertion.
// ────────────────────────────────────────────────────────────────────

export interface RunExportPortfolioCliArgs {
  db: DB;
  /** Subset of FleetConfig the CLI reads. Tests hand in a literal so
   *  they never write fleet-control.config.json. */
  cfg: Partial<FleetConfig>;
  /** The argv tail AFTER the literal `export portfolio` tokens. So a
   *  call to `fleetctl export portfolio --out foo.html` becomes
   *  argv=['--out', 'foo.html']. */
  argv: string[];
  /** Wall-clock anchor. Tests pin it; the bin shim passes new Date(). */
  now: Date;
}

/** Default output path derived from cfg.operator.handle + the YYYY-MM-DD
 *  of `now` (UTC). Same shape as the ticket's default example. */
function defaultOutPath(handle: string, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `./fleet-portfolio-${handle}-${y}-${m}-${d}.html`;
}

/** Sub-command dispatcher for `fleetctl export <subcommand>`. The
 *  v1 release ships only `portfolio`; the help block names it. Other
 *  subcommands fall through to the help block + exit 0 per AC9. */
export function runExportHelp(): { stdout: string; exitCode: 0 } {
  return { stdout: HELP, exitCode: 0 };
}

export function runExportPortfolioCli(
  args: RunExportPortfolioCliArgs,
): ExportPortfolioCliResult {
  const { db, cfg, argv, now } = args;
  let stdout = "";
  let stderr = "";
  const out = (s: string): void => { stdout += s; };
  const err = (s: string): void => { stderr += s; };

  const parsed = parseExportArgs(argv);

  if (parsed.help) {
    out(HELP);
    return { exitCode: 0, stdout, stderr, writtenPath: "" };
  }

  // Missing-handle gate per AC7. Mirrors the 0067 fleetctl share
  // profile precedent exactly so the operator sees the same line
  // across sibling subcommands.
  const handle = (cfg.operator?.handle ?? "").trim();
  if (!handle) {
    err("set operator.handle in fleet-control.config.json to enable the portfolio export\n");
    return { exitCode: 1, stdout, stderr, writtenPath: "" };
  }

  // --out path-safety reject per AC8. Applied to the raw operator-
  // supplied value BEFORE any normalisation so traversal cannot slip
  // through a join() collapse. The default path skips this check
  // because it is constructed from a sanitised handle.
  if (parsed.out !== undefined) {
    const reject = pathSafetyReject(parsed.out);
    if (reject) {
      err(reject + "\n");
      return { exitCode: 1, stdout, stderr, writtenPath: "" };
    }
  }

  const outPath = parsed.out ?? defaultOutPath(handle, now);

  // Compose the payload. The profile helper returns null when
  // cfg.operator lacks handle / sinceDate; we already guarded handle
  // above, so a null here means sinceDate is missing - surface a
  // pointed error rather than crash on the deref.
  const profile = operatorProfilePayload(db, cfg as FleetConfig, now);
  if (!profile) {
    err("set operator.sinceDate in fleet-control.config.json to enable the portfolio export\n");
    return { exitCode: 1, stdout, stderr, writtenPath: "" };
  }

  const lessons = parsed.includeLessons ? buildLessonsSection(db, now) : [];
  const receipts = parsed.includeReceipts ? buildReceiptsSection(db, now) : [];

  const html = composePortfolioHtml({
    profile,
    lessons,
    receipts,
    now,
    includeLessons: parsed.includeLessons,
    includeReceipts: parsed.includeReceipts,
  });

  // Overwrite-existing branch per AC9. We check existence before the
  // write so the stderr line lands before any disk side-effect, then
  // the writer seam runs unconditionally.
  const alreadyExisted = existsSync(outPath);

  try {
    writePortfolioFile(outPath, html);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    err(`failed to write ${outPath}: ${msg}\n`);
    return { exitCode: 1, stdout, stderr, writtenPath: "" };
  }

  if (alreadyExisted) {
    err(`overwrote existing file at ${outPath}\n`);
  }

  // Friendly stdout line so the operator sees the artifact path. Size
  // is computed from the composed string's byte length - we already
  // have it in memory.
  const sizeKb = Math.max(1, Math.round(Buffer.byteLength(html, "utf8") / 1024));
  out(`wrote ${outPath} (${sizeKb} KB)\n`);

  return { exitCode: 0, stdout, stderr, writtenPath: outPath };
}
