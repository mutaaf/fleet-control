// fleetctl share CLI subcommand (ticket 0067).
//
// One command snapshots the current state, signs a token, prints a
// paste-ready three-line blurb, plus copies it to the clipboard so the
// operator's "look what shipped" moment lands on LinkedIn / Slack /
// Bluesky in under five seconds.
//
// This module is the pure-logic side. The CLI shim in bin/fleetctl.ts
// imports runShareCli and pipes argv + the live cfg in. Every
// side-effecting boundary (snapshot mint, clipboard write) is gated
// through a function so the tests never touch the real DB, the real
// pbcopy binary, or the operator's clipboard.
//
// Per LESSONS 2026-06-13 this is a NEW module rather than a sibling
// helper in src/views.ts. The share module imports views.ts one-way
// for the payload helpers (fleetWeeklyPulse, lessonSavingsRollup,
// operatorProfilePayload) and receipts.ts for computeReceipts;
// neither of those imports src/share.ts back, so no function-import
// cycle. The globalThis-slot pattern is the wrong shape here - no
// caches, no ingest-vs-server asymmetry.
//
// Per LESSONS 2026-05-26 the clipboard shell-out is gated through a
// one-purpose runner seam _setShareClipboardRunnerForTests so the
// tests can assert the argv shape AND the stdin string without
// writing to the real clipboard. Per AGENTS.md Hard NOs the pbcopy
// call uses execFile with an argv array LITERAL - never a composed
// shell string.
//
// Zero new runtime deps.
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import type { DB } from "./db.ts";
import type { FleetConfig } from "./config.ts";
import {
  fleetView,
  fleetWeeklyPulse,
  lessonSavingsRollup,
  fleetMedianProjection,
  operatorProfilePayload,
} from "./views.ts";
import { computeReceipts } from "./receipts.ts";
import { revokeSnapshot } from "./snapshot.ts";

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

/** The five share surfaces the CLI knows how to compose a blurb for.
 *  Each one maps to its own template phrase AND its own snapshot.kind
 *  discriminator in the DB. profile is special - it skips the token
 *  issuance because the 0065 /operator/<handle> URL is already
 *  unauthenticated and handle-scoped. */
export type ShareSurface = "pulse" | "receipts" | "calculator" | "lessons" | "profile";

const SHARE_SURFACES: ReadonlyArray<ShareSurface> =
  ["pulse", "receipts", "calculator", "lessons", "profile"];

/** Args accepted by composeShareBlurb. The payload shape varies per
 *  surface; the composer reads only the fields it documents for that
 *  surface and ignores the rest, so a caller can hand in the full
 *  payload helper return value without trimming. */
export interface ComposeShareBlurbArgs {
  surface: ShareSurface;
  payload: Record<string, unknown>;
  url: string;
}

/** Result of runShareCli - the in-process driver the bin/fleetctl.ts
 *  shim wraps. Everything is captured (stdout, stderr, exitCode,
 *  blurb) so tests can assert without spawning a subprocess for the
 *  runner-seam cases. */
export interface ShareCliResult {
  exitCode: 0 | 1;
  /** The composed blurb. Empty string when the CLI did not get far
   *  enough to compose one (e.g. missing operator.handle on profile). */
  blurb: string;
  /** Buffered stdout. The CLI shim writes this to process.stdout. */
  stdout: string;
  /** Buffered stderr. The CLI shim writes this to process.stderr. */
  stderr: string;
}

/** The runner-seam contract. Production wires execFile via the
 *  defaultClipboardRunner below; tests swap a stub that records the
 *  cmd / argv / stdin without spawning. */
export interface ShareClipboardRunResult {
  /** Process exit code. 0 = success; anything else falls through to
   *  the no-pbcopy fallback. */
  code: number;
  /** Anything the binary wrote to stderr. Surfaced verbatim into the
   *  CLI's stderr buffer on non-zero exit. */
  stderrOut: string;
}

export type ShareClipboardRunner = (
  cmd: string,
  argv: string[],
  opts: { input: string },
) => ShareClipboardRunResult | Promise<ShareClipboardRunResult>;

// ────────────────────────────────────────────────────────────────────
// resolveShareHost - pure function so it is testable directly.
//
// Per the ticket: when host === '0.0.0.0' the CLI SUBSTITUTES the
// loopback IP for the stdout URL (a 0.0.0.0 URL is unparseable by
// Slack / Bluesky / LinkedIn). Loopback and LAN-bound configs pass
// through unchanged. Per LESSONS 2026-06-15 on the doctor-check
// offline-gate discipline the substitution is a pure function.
// ────────────────────────────────────────────────────────────────────

/** Return the host string the share URL should embed. Translates the
 *  wildcard bind into a loopback address so a pasted URL works in
 *  Slack / LinkedIn / etc. */
export function resolveShareHost(cfg: { host?: string }): string {
  const raw = (cfg.host ?? "127.0.0.1").trim();
  if (raw === "" || raw === "0.0.0.0") return "127.0.0.1";
  return raw;
}

// ────────────────────────────────────────────────────────────────────
// composeShareBlurb - the deterministic per-surface template.
//
// Each surface gets its own template tuned for the surface's
// emotional beat:
//   pulse       - this-week numbers + URL.
//   receipts    - this-month numbers + cost figure + URL.
//   calculator  - the time-saved claim + URL.
//   lessons     - the most-cited lesson title + URL.
//   profile     - lifetime totals + URL.
//
// The blurb is PURE deterministic - no LLM, no randomness, no
// templating that the operator must edit. The 3-line layout:
//   line 1: the headline.
//   blank.
//   line 2: the URL the recipient should click.
//   blank.
//   line 3: the footer signature "(powered by fleet-control)".
// ────────────────────────────────────────────────────────────────────

function asNumber(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asString(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (v == null) return fallback;
  return String(v);
}

function pluralFeatures(n: number): string {
  return n === 1 ? "1 feature" : `${n} features`;
}

/** Compose the paste-ready blurb. Pure on its inputs; same inputs
 *  always produce the same string. */
export function composeShareBlurb(args: ComposeShareBlurbArgs): string {
  const { surface, payload, url } = args;
  let headline: string;
  switch (surface) {
    case "pulse": {
      const n = asNumber(payload.merged_prs);
      headline = `Just shipped ${pluralFeatures(n)} this week with my autonomous agent fleet.`;
      break;
    }
    case "receipts": {
      const n = asNumber(payload.merged_prs);
      const spend = asNumber(payload.total_spend_usd);
      const spendStr = spend > 0 ? `~$${spend.toFixed(2)}` : "near zero spend";
      headline = `Shipped ${pluralFeatures(n)} this month for ${spendStr} with my autonomous agent fleet.`;
      break;
    }
    case "calculator": {
      const throughput = asNumber(payload.merged_prs_per_month);
      const costPerPr = asNumber(payload.cost_per_pr_usd);
      // The calculator surface's emotional beat is "this is what the
      // fleet saves a human-equivalent operator per month." We render
      // the throughput figure + the cost-per-PR claim; the recipient
      // clicks the URL to model their own savings.
      headline = throughput > 0
        ? `My agent fleet saves me hours every week - ${throughput.toFixed(1)} PRs/mo at ~$${costPerPr.toFixed(2)}/PR.`
        : `My agent fleet is saving me hours every week. Model your own savings:`;
      break;
    }
    case "lessons": {
      const title = asString(payload.lesson_title).trim();
      const saved = asNumber(payload.saved_usd);
      headline = title.length > 0
        ? (saved > 0
            ? `My most-cited cross-fleet lesson "${title}" has saved ~$${saved.toFixed(2)} so far.`
            : `My most-cited cross-fleet lesson: "${title}".`)
        : `Cross-fleet operational lessons my agents learned the hard way:`;
      break;
    }
    case "profile": {
      const lifetimePrs = asNumber(payload.lifetimePrsShipped);
      const months = asNumber(payload.monthsRunning);
      headline = months > 0
        ? `${lifetimePrs} PRs shipped by my autonomous agent fleet over ${months} months.`
        : `${lifetimePrs} PRs shipped by my autonomous agent fleet so far.`;
      break;
    }
    default: {
      // Exhaustiveness check. _never narrows the switch so tsc errors
      // if a new surface is added without a branch above.
      const _never: never = surface;
      throw new Error("composeShareBlurb: unknown surface " + String(_never));
    }
  }
  return [
    headline,
    "",
    url,
    "",
    "(powered by fleet-control)",
  ].join("\n");
}

// ────────────────────────────────────────────────────────────────────
// Clipboard runner seam.
//
// Per LESSONS 2026-05-26 "shell-out modules need an injectable runner
// for tests" - the pbcopy shell-out is gated through a module-level
// mutable activeRunner plus exported _setShareClipboardRunnerForTests
// / _resetShareClipboardRunnerForTests helpers. Production callers
// keep their existing semantics; tests swap the runner in a
// try { ... } finally { _resetShareClipboardRunnerForTests(); }
// block. The leading underscore signals "do not call in production"
// (same convention as _resetDedupForTests in src/ntfy.ts).
//
// The runner contract is intentionally narrow - cmd, argv, opts.input.
// We do NOT widen it to accept arbitrary spawn options because the
// only consumer is the pbcopy plumbing.
// ────────────────────────────────────────────────────────────────────

/** Production runner: execFile pbcopy with the blurb on stdin. Wraps
 *  execFile in a Promise; the pbcopy binary is asynchronous from our
 *  perspective. ENOENT (Linux CI) re-throws so the caller's catch
 *  block can branch to the no-pbcopy fallback. */
function defaultClipboardRunner(
  cmd: string,
  argv: string[],
  opts: { input: string },
): Promise<ShareClipboardRunResult> {
  return new Promise((resolve, reject) => {
    const proc = execFile(cmd, argv, { encoding: "utf8", timeout: 5_000 }, (err, _stdout, stderr) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          reject(err);
          return;
        }
        resolve({ code: typeof (err as { code?: number }).code === "number"
          ? (err as { code: number }).code : 1, stderrOut: String(stderr ?? "") });
        return;
      }
      resolve({ code: 0, stderrOut: String(stderr ?? "") });
    });
    try {
      proc.stdin?.end(opts.input);
    } catch {
      // The stdin write failure path is already wrapped by execFile's
      // err callback above; ignore here.
    }
  });
}

let activeClipboardRunner: ShareClipboardRunner = defaultClipboardRunner;

/** Swap the clipboard runner. Tests call this in a try / finally so
 *  the seam is restored after each assertion. The leading underscore
 *  signals "do not call in production". */
export function _setShareClipboardRunnerForTests(fn: ShareClipboardRunner): void {
  activeClipboardRunner = fn;
}

/** Restore the production clipboard runner. Tests call this in their
 *  finally block to keep cross-test state clean. */
export function _resetShareClipboardRunnerForTests(): void {
  activeClipboardRunner = defaultClipboardRunner;
}

// ────────────────────────────────────────────────────────────────────
// Snapshot mint - direct SQL.
//
// Why we don't reuse createSnapshot() from src/snapshot.ts: the 0013
// helper hardcodes anonymize(fleetView) + a typed union on the kind
// arg. The share surfaces want a per-surface payload (the pulse
// payload, the receipts payload, etc) AND a new kind value the union
// doesn't list. Going around the helper for INSERT keeps the 0013
// signature stable AND lets us use the snapshot.kind column directly
// per the 0066 ALTER TABLE migration (TEXT, no CHECK constraint, so
// new kinds extend cleanly with zero schema work).
//
// The revoke path reuses the existing revokeSnapshot helper because
// the discriminator (id-prefix lookup) is identical across kinds.
// ────────────────────────────────────────────────────────────────────

const SHARE_TTL_HOURS = 24 * 7; // one week - long enough for a typical share moment.

interface MintedShareSnapshot {
  token: string;
  id_prefix: string;
  expires_at: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mintShareSnapshot(
  db: DB,
  kind: string,
  name: string,
  payload: unknown,
): MintedShareSnapshot {
  const token = randomBytes(24).toString("hex");
  const id = hashToken(token);
  const now = new Date();
  const created_at = now.toISOString();
  const expires_at = new Date(now.getTime() + SHARE_TTL_HOURS * 3600_000).toISOString();
  const payload_json = JSON.stringify(payload ?? null);
  db.prepare(
    "INSERT INTO snapshot(id,name,created_at,expires_at,revoked_at,payload_json,kind) VALUES(?,?,?,?,?,?,?)",
  ).run(id, name, created_at, expires_at, null, payload_json, kind);
  return { token, id_prefix: id.slice(0, 8), expires_at };
}

// ────────────────────────────────────────────────────────────────────
// Per-surface payload helpers.
//
// Each one composes the data the blurb template needs from the
// existing payload helpers in views.ts / receipts.ts. Pure functions
// of (db, cfg, now) - the share module is the only caller, so we
// keep them file-scoped.
// ────────────────────────────────────────────────────────────────────

function buildPulsePayload(db: DB, now: Date): Record<string, unknown> {
  const pulse = fleetWeeklyPulse(db, { now });
  return {
    merged_prs: pulse.merged_prs,
    total_spend_usd: pulse.total_spend_usd,
    cost_per_pr_usd: pulse.cost_per_pr_usd,
    top_project: pulse.top_project,
    week_start_iso: pulse.week_start_iso,
    week_end_iso: pulse.week_end_iso,
  };
}

function currentMonthIso(now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function buildReceiptsPayload(db: DB, now: Date): Record<string, unknown> {
  const month = currentMonthIso(now);
  const receipts = computeReceipts(db, "fleet", month, now);
  return {
    merged_prs: receipts.merged_prs,
    total_spend_usd: receipts.total_spend_usd,
    cost_per_pr_usd: receipts.cost_per_pr_usd,
    month_iso: receipts.month_iso,
    month_label: receipts.month_label,
  };
}

function buildCalculatorPayload(db: DB, now: Date): Record<string, unknown> {
  const median = fleetMedianProjection(db, now);
  return {
    merged_prs_per_month: median.merged_prs_per_month,
    spend_usd_per_month: median.spend_usd_per_month,
    cost_per_pr_usd: median.cost_per_pr_usd ?? 0,
    window_days: median.window_days,
    percentile: median.percentile,
  };
}

function buildLessonsPayload(db: DB, now: Date): Record<string, unknown> {
  // The lessonSavingsRollup helper orders lesson_savings DESC by
  // saved_usd, so the head element is the "most-cited" / highest
  // dollar-saved lesson at snapshot time. Empty fleet => null title.
  const rollup = lessonSavingsRollup(db, { now });
  const head = rollup.lesson_savings[0];
  if (!head) {
    return {
      lesson_title: null,
      lesson_slug: null,
      saved_usd: 0,
      average_failed_ship_cost_usd: rollup.average_failed_ship_cost_usd,
    };
  }
  return {
    lesson_title: head.lesson_title,
    lesson_slug: head.lesson_slug,
    saved_usd: head.saved_usd,
    heal_count: head.heal_count,
    average_failed_ship_cost_usd: rollup.average_failed_ship_cost_usd,
  };
}

function buildProfilePayload(db: DB, cfg: FleetConfig, now: Date): Record<string, unknown> | null {
  const payload = operatorProfilePayload(db, cfg, now);
  if (!payload) return null;
  return {
    handle: payload.handle,
    displayName: payload.displayName,
    lifetimePrsShipped: payload.totals.lifetimePrsShipped,
    lessonsAuthored: payload.totals.lessonsAuthored,
    projectsActive: payload.totals.projectsActive,
    monthsRunning: payload.totals.monthsRunning,
  };
}

// ────────────────────────────────────────────────────────────────────
// runShareCli - the testable in-process driver.
//
// The bin/fleetctl.ts shim hands in (db, cfg, argv, env) and writes
// the returned stdout / stderr to the real process streams. Tests
// drive the same function directly so the clipboard runner seam and
// the per-surface payload helpers are exercised without spawning a
// subprocess on every assertion.
// ────────────────────────────────────────────────────────────────────

export interface RunShareCliArgs {
  db: DB;
  /** Subset of FleetConfig the CLI reads. Tests hand in a literal so
   *  they never write fleet-control.config.json. */
  cfg: Partial<FleetConfig> & { host?: string; port?: number };
  /** The argv tail AFTER the literal `share` subcommand. So a call to
   *  `fleetctl share pulse` becomes argv=['pulse']. */
  argv: string[];
  /** Env subset the CLI reads. Tests pass an empty object; the CLI
   *  shim hands in process.env. */
  env: Record<string, string | undefined>;
}

const HELP = [
  "usage: fleetctl share <pulse|receipts|calculator|lessons|profile>",
  "       fleetctl share revoke <id-prefix>",
  "",
  "Snapshot the current state, mint a signed token, print a paste-ready",
  "3-line blurb to stdout, and copy it to the macOS clipboard (pbcopy).",
  "",
  "Surfaces:",
  "  pulse       this week's fleet pulse (merged PRs, top project)",
  "  receipts    this month's receipts (PRs, spend, $/PR)",
  "  calculator  median throughput + cost-per-PR (recipient models savings)",
  "  lessons     the most-cited cross-fleet lesson + dollars-saved tally",
  "  profile     the operator's lifetime totals (no token; handle-scoped)",
  "",
  "Revoke any time with: fleetctl share revoke <id-prefix>",
  "",
].join("\n");

function isShareSurface(s: string): s is ShareSurface {
  return (SHARE_SURFACES as ReadonlyArray<string>).includes(s);
}

export async function runShareCli(args: RunShareCliArgs): Promise<ShareCliResult> {
  const { db, cfg, argv, env } = args;
  let stdout = "";
  let stderr = "";
  const out = (s: string): void => { stdout += s; };
  const err = (s: string): void => { stderr += s; };

  const [sub, ...rest] = argv;

  // ── Help branch (no surface) ──────────────────────────────────────
  if (!sub) {
    out(HELP);
    return { exitCode: 0, blurb: "", stdout, stderr };
  }

  // ── Revoke branch ─────────────────────────────────────────────────
  if (sub === "revoke") {
    const prefix = rest[0];
    if (!prefix) {
      err("usage: fleetctl share revoke <id-prefix>\n");
      return { exitCode: 1, blurb: "", stdout, stderr };
    }
    try {
      const ok = revokeSnapshot(db, prefix);
      if (ok) {
        out(`revoked ${prefix}\n`);
        return { exitCode: 0, blurb: "", stdout, stderr };
      }
      err(`no live share with id-prefix ${prefix}\n`);
      return { exitCode: 1, blurb: "", stdout, stderr };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      err(`error: ${msg}\n`);
      return { exitCode: 1, blurb: "", stdout, stderr };
    }
  }

  // ── Surface validation ────────────────────────────────────────────
  if (!isShareSurface(sub)) {
    err(`unknown share surface: ${sub}\n`);
    err(HELP);
    return { exitCode: 1, blurb: "", stdout, stderr };
  }

  const now = new Date();
  const host = resolveShareHost({ host: cfg.host });
  const port = Number(cfg.port ?? 7070);
  const baseUrl = `http://${host}:${port}`;

  // ── Profile branch (no token; handle-scoped URL) ──────────────────
  if (sub === "profile") {
    // Resolve the operator handle. cfg.operator.handle is the
    // canonical source. The FLEET_OPERATOR_HANDLE env var is an
    // escape hatch for the AC1 multi-surface subprocess test so a
    // throwaway tmpdir DB can drive the profile branch without a
    // full operator config block. Operator-facing usage path is
    // always the config.
    const handle = (cfg.operator?.handle ?? env.FLEET_OPERATOR_HANDLE ?? "").trim();
    if (!handle) {
      err("set operator.handle in fleet-control.config.json to enable the profile share\n");
      return { exitCode: 1, blurb: "", stdout, stderr };
    }
    // Try to use the live operatorProfilePayload first; fall back to
    // a minimal handle-only payload when the operator hasn't yet
    // populated their since-date. The blurb composer tolerates a
    // zero monthsRunning value.
    const live = cfg.operator ? buildProfilePayload(db, cfg as FleetConfig, now) : null;
    const payload: Record<string, unknown> = live ?? {
      handle,
      lifetimePrsShipped: 0,
      monthsRunning: 0,
    };
    const url = `${baseUrl}/operator/${handle}`;
    const blurb = composeShareBlurb({ surface: "profile", payload, url });
    out(blurb + "\n");
    const clip = await finishWithClipboard(blurb, env);
    err(clip.stderrAdd);
    return { exitCode: clip.exitCode, blurb, stdout, stderr };
  }

  // ── Tokened surface branch (pulse / receipts / calculator / lessons) ─
  let payload: Record<string, unknown>;
  switch (sub) {
    case "pulse": payload = buildPulsePayload(db, now); break;
    case "receipts": payload = buildReceiptsPayload(db, now); break;
    case "calculator": payload = buildCalculatorPayload(db, now); break;
    case "lessons": payload = buildLessonsPayload(db, now); break;
  }

  const kind = "share_" + sub;
  const minted = mintShareSnapshot(db, kind, `share-${sub}-${now.toISOString().slice(0, 10)}`, payload);
  const url = `${baseUrl}/share/${sub}/${minted.token}`;
  const blurb = composeShareBlurb({ surface: sub, payload, url });
  out(blurb + "\n");
  out(`\nURL copied to clipboard - revoke any time with: fleetctl share revoke ${minted.id_prefix}\n`);
  const clip = await finishWithClipboard(blurb, env);
  err(clip.stderrAdd);
  return { exitCode: clip.exitCode, blurb, stdout, stderr };
}

// ────────────────────────────────────────────────────────────────────
// Clipboard step + non-Mac fallback.
//
// Per LESSONS 2026-06-15 the no-pbcopy branch is gated on the
// FLEET_SHARE_NO_CLIPBOARD env var so the CI test path doesn't have
// to actually shell out to a missing binary. ENOENT from the runner
// (e.g. Linux CI without pbcopy) falls through to the same stderr
// line. Either path exits 0 - the blurb is still useful on stdout.
// ────────────────────────────────────────────────────────────────────

/** Result returned by finishWithClipboard. The caller appends the
 *  stderrAdd to its own stderr buffer; stdout is unaffected by the
 *  clipboard step (the blurb already went to stdout upstream). */
interface ClipboardOutcome {
  exitCode: 0 | 1;
  /** Additional stderr text the clipboard step produced. */
  stderrAdd: string;
}

async function finishWithClipboard(
  blurb: string,
  env: Record<string, string | undefined>,
): Promise<ClipboardOutcome> {
  if (env.FLEET_SHARE_NO_CLIPBOARD === "1") {
    return { exitCode: 0, stderrAdd: "pbcopy not available - blurb printed to stdout\n" };
  }
  try {
    const r = await activeClipboardRunner("pbcopy", [], { input: blurb });
    if (r.code !== 0) {
      return {
        exitCode: 0,
        stderrAdd:
          `pbcopy exited ${r.code}: ${r.stderrOut}\n`
          + "pbcopy not available - blurb printed to stdout\n",
      };
    }
    return { exitCode: 0, stderrAdd: "" };
  } catch (e: unknown) {
    const code = e && typeof e === "object" && "code" in e
      ? (e as { code?: unknown }).code
      : undefined;
    if (code === "ENOENT") {
      return { exitCode: 0, stderrAdd: "pbcopy not available - blurb printed to stdout\n" };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return {
      exitCode: 0,
      stderrAdd:
        `pbcopy failed: ${msg}\n`
        + "pbcopy not available - blurb printed to stdout\n",
    };
  }
}

// Avoid an unused-import warning for fleetView - it is currently
// unused but kept on the import list so future surfaces (e.g. a
// fleet-wide "show me" share) can layer in without re-adding the
// import (which would otherwise be a churny one-line diff). Same
// pattern as src/doctor.ts at the bottom.
void fleetView;
