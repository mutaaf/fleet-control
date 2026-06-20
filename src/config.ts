// Central configuration + well-known paths. Everything is local; no cloud.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

const HOME = homedir();

export interface FleetConfig {
  /** Folders scanned for `<project>/agents.config.sh`. */
  projectRoots: string[];
  /** TCC-safe install location where install.sh copies each manifest. */
  installedRoot: string;
  /** Our own state DB (outside ~/.cache so a cache wipe keeps history). */
  dbPath: string;
  /** Base of per-agent caches: ~/.cache/<slug>-agent/... */
  cacheBase: string;
  /** Base of Claude Code session transcripts. */
  claudeProjects: string;
  /** Server bind host. 127.0.0.1 (default) = local only; 0.0.0.0 = LAN. */
  host?: string;
  /** Server port. */
  port?: number;
  /** ntfy.sh topic for push notifications (ticket 0009). Empty/unset →
   *  ntfy disabled; osascript stays the only channel. */
  ntfyTopic?: string;
  /** Base portal URL for ntfy click-through. Defaults to the loopback SPA
   *  hash route `http://127.0.0.1:7070/#/p/`. The project slug is
   *  appended per notification. */
  portalUrl?: string;
  /** Quiet hours — sleep-window suppress non-critical pushes (ticket 0030).
   *  Operator-wide default. `tz` is an IANA zone name like
   *  "America/Los_Angeles"; `start` and `end` are HH:MM strings interpreted
   *  in `tz`. When `start > end` the window wraps midnight. Undefined =
   *  no quiet hours. Invalid HH:MM / unknown tz falls back to undefined
   *  via the parser in `src/quiet_hours.ts`. */
  quietHours?: { start: string; end: string; tz: string };
  /** Per-project quiet-hours override (ticket 0030). The literal `false`
   *  means "always page for this project, never quiet" — useful for the
   *  rare project that warrants 24/7 paging. An object overrides the
   *  fleet default's window/tz for that slug. */
  quietHoursOverride?: Record<string, false | { start: string; end: string; tz: string }>;
  /** Worth-it verdict knobs (ticket 0048). A nested object — same
   *  shape the in-process reader expects. The two keys (hourly rate
   *  in USD + hours per merged PR) drive the per-project
   *  worth-it-verdict's "human equivalent cost" calculation. Both are
   *  optional with documented defaults (`75` and `1`) baked into the
   *  helper; the operator overrides via `fleet-control.config.json`.
   *  Per LESSONS 2026-05-25 "store cascading config values shaped to
   *  the reader" - any future portal-side setter MUST write in this
   *  same nested-object shape. */
  worth_it?: {
    hourly_rate_usd?: number;
    hours_per_pr?: number;
  };
  /** Embed-origin allowlist for the /embed/pulse.html iframe widget
   *  (ticket 0060). When omitted (or empty) the embed page's
   *  X-Frame-Options + Content-Security-Policy frame-ancestors are
   *  SAMEORIGIN / 'self' — the widget renders ONLY on the operator's
   *  own host. When the operator lists explicit origins (e.g.
   *  ["https://operator.dev", "https://github.com"]) both headers
   *  widen to include them so the embed can render on those surfaces.
   *  The list is value-filtered downstream; passing junk leaves the
   *  default-safe headers in place. */
  embedOrigins?: string[];
  /** Per-IP token-bucket rate-limit for the public /embed/*, /og/*,
   *  /share/* routes (ticket 0064). When omitted both sub-fields fall
   *  back to documented defaults (60 tokens per minute, burst of 60)
   *  via resolveRateLimitOpts() in src/rate_limit.ts. Loopback callers
   *  are exempt unconditionally - the operator's own portal never
   *  throttles regardless of these values. Defaulting pattern matches
   *  the embedOrigins field above: passing junk leaves the
   *  default-safe values in place. */
  embedRateLimit?: {
    tokensPerMinute?: number;
    burst?: number;
  };
  /** Operator-attributed profile page (ticket 0065). Opt-in: when the
   *  operator field is OMITTED the /operator/<handle> and
   *  /og/operator/<handle>.svg routes both 404 (and the home page is
   *  unchanged). When present the routes render a tasteful one-page
   *  portfolio at /operator/<handle> for the operator to paste into
   *  a LinkedIn / CV / portfolio. handle and sinceDate are the only
   *  required fields; displayName / headline default to documented
   *  fallbacks inside the renderer. attribution defaults to
   *  "anonymised" - the operator OPTS IN to attribution by name. */
  operator?: {
    /** The URL-safe handle the route slug matches against. */
    handle: string;
    /** Human-readable display name (defaults to handle). */
    displayName?: string;
    /** One-line headline rendered under the handle. */
    headline?: string;
    /** ISO date string the operator started running the fleet
     *  (used to compute monthsRunning). */
    sinceDate: string;
    /** Whether recent ships render the real project slug
     *  ("attributed") or the anonymised "project-N" alias
     *  ("anonymised", default). */
    attribution?: "anonymised" | "attributed";
    /** Absolute host URL (e.g. https://fleet.example.com) used to
     *  compose the absolute og:image URL on the rendered profile
     *  page. When omitted the og:image falls back to the request
     *  Host header (per the 0061 composeOgMetaTags pattern). */
    publicHost?: string;
    /** Ticket 0068: operator-to-operator referral. OPERATOR-AUTHORED:
     *  the new operator credits the upstream operator who introduced
     *  them to fleet-control by writing this field locally. The
     *  consentPublicCredit toggle gates whether the upstream's
     *  /referrals/<upstream> page surfaces this downstream's REAL
     *  handle (true) or the anonymised 8-char hash placeholder
     *  (false, the documented default). Omitting the field entirely
     *  signals "I installed without a referral" - the daemon writes
     *  no referral_ack row. The new operator's local instance writes
     *  a referral_ack snapshot row on startup; there is NO network
     *  call to the upstream operator's instance. */
    referredBy?: {
      handle: string;
      acknowledgedAt: string;
      consentPublicCredit?: boolean;
    };
  };
  /** Reactivation push opt-out (ticket 0071). When omitted (the default)
   *  the daemon helper evaluateReactivationPush treats the operator as
   *  enabled - the Sunday 18:00 nudge fires when the operator has been
   *  absent for 5+ days. When set to true the helper short-circuits with
   *  reason "opt_out" and never fires the push. The defaulting pattern
   *  matches the existing embedRateLimit / worth_it nested fields. */
  reactivationPush?: {
    disabled?: boolean;
  };
}

const DEFAULTS: FleetConfig = {
  projectRoots: [join(HOME, "Desktop", "projects")],
  installedRoot: join(HOME, ".local", "share", "agent-fleet", "projects"),
  dbPath: join(HOME, ".local", "state", "fleet-control", "fleet.db"),
  cacheBase: join(HOME, ".cache"),
  claudeProjects: join(HOME, ".claude", "projects"),
  host: "127.0.0.1",
  port: 7070,
};

/** Load config, merging an optional fleet-control.config.json next to the repo. */
export function loadConfig(): FleetConfig {
  const cfg = { ...DEFAULTS };
  const local = join(process.cwd(), "fleet-control.config.json");
  if (existsSync(local)) {
    try {
      Object.assign(cfg, JSON.parse(readFileSync(local, "utf8")));
    } catch { /* ignore malformed local config */ }
  }
  // Env override for the DB path. Useful for the test suite (so a
  // subprocess CLI invocation can point at a tmpdir DB without
  // touching the operator's real `~/.local/state` tree) and for
  // anyone wanting to keep their fleet history on an external disk.
  if (process.env.FLEET_DB_PATH) cfg.dbPath = process.env.FLEET_DB_PATH;
  // Ensure the state dir exists.
  mkdirSync(join(cfg.dbPath, ".."), { recursive: true });
  return cfg;
}

/**
 * Map an absolute agent checkout path to its Claude Code transcript dir name.
 * e.g. /Users/x/.cache/courtiq-agent/review-checkout
 *   -> -Users-x--cache-courtiq-agent-review-checkout
 * (slashes -> '-', and the '.' in .cache becomes the double-dash).
 */
export function transcriptDirFor(checkoutAbsPath: string): string {
  return checkoutAbsPath.replace(/\//g, "-").replace(/\./g, "-");
}
