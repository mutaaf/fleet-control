// Quiet hours — ticket 0030.
//
// Pure functions on top of `Intl.DateTimeFormat` (zero new deps — node's
// ICU covers IANA zones). Resolves a per-operator sleep window (default
// fleet-wide; per-project overrides beat the default; the literal `false`
// override skips quiet hours entirely for that project), then answers
// `isQuietNow(cfg, slug, now): boolean` for the ntfy gate and inbox
// split.
//
// Time arithmetic strategy:
//   - Convert `now` into "minutes since midnight in the resolved zone"
//     via Intl.DateTimeFormat with `hour: "2-digit", minute: "2-digit",
//     hourCycle: "h23"`.
//   - Parse the configured `start`/`end` HH:MM strings into the same
//     unit.
//   - Same-day window: start <= now < end.
//   - Overnight wrap (start > end): now >= start OR now < end.
//
// Why this module exposes a reset hook per LESSONS § "in-process dedup
// sets need an explicit reset hook for tests": the module memoises the
// `Intl.DateTimeFormat` per (tz, …) tuple so we don't pay the formatter-
// construction cost on every dispatch tick. The cache is process-
// lifetime; tests that mutate config across cases need a clean slate.
//
// Validation posture: a bad HH:MM or a bad tz logs once to fleetd.err
// and falls back to "no quiet hours for that scope" — the ntfy gate
// and inbox split treat that as "always page", matching the ticket's
// "default = no quiet hours" contract.
import type { FleetConfig } from "./config.ts";

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

/** One quiet-hours window. `tz` is an IANA zone name. */
export interface QuietWindow {
  start: string; // HH:MM
  end: string;   // HH:MM
  tz: string;    // IANA zone
}

/** Per-project override: `false` means "always page for this project". */
export type QuietOverride = false | QuietWindow;

interface ParsedWindow {
  startMins: number; // minutes-since-midnight
  endMins: number;
  tz: string;
}

// ────────────────────────────────────────────────────────────────────
// Module-level cache (process lifetime; reset via _resetQuietHoursForTests)
// ────────────────────────────────────────────────────────────────────

const fmtCache = new Map<string, Intl.DateTimeFormat>();

/** Reset module-level caches. Tests that mutate config across cases
 *  call this to keep the formatter cache from masquerading a successful
 *  parse of a previously-invalid tz. Production never calls this. */
export function _resetQuietHoursForTests(): void {
  fmtCache.clear();
}

// ────────────────────────────────────────────────────────────────────
// Internals
// ────────────────────────────────────────────────────────────────────

const HHMM_RE = /^([0-9]{2}):([0-9]{2})$/;

function parseHHMM(s: string): number | null {
  const m = HHMM_RE.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mi)) return null;
  if (h < 0 || h > 23) return null;
  if (mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch { return false; }
}

function getFormatter(tz: string): Intl.DateTimeFormat | null {
  const cached = fmtCache.get(tz);
  if (cached) return cached;
  try {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    fmtCache.set(tz, f);
    return f;
  } catch { return null; }
}

/** Convert a Date to "minutes since midnight" in the given IANA zone.
 *  Returns null if the tz is invalid. */
function minutesInZone(now: Date, tz: string): number | null {
  const fmt = getFormatter(tz);
  if (!fmt) return null;
  // Intl.DateTimeFormat's `formatToParts` is the most-robust way to
  // pull integer hours/minutes without parsing the formatter's locale-
  // specific "HH:MM" string.
  const parts = fmt.formatToParts(now);
  let h = NaN, m = NaN;
  for (const p of parts) {
    if (p.type === "hour") h = Number(p.value);
    else if (p.type === "minute") m = Number(p.value);
  }
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  // hourCycle: "h23" guarantees 00-23. Defence-in-depth: clamp.
  if (h === 24) h = 0;
  return h * 60 + m;
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

/** Parse a candidate `QuietWindow` into the internal representation;
 *  returns null on any validation failure (invalid HH:MM, invalid tz,
 *  start === end, missing fields). Exported for testability. */
export function parseWindow(w: QuietWindow | undefined | null): ParsedWindow | null {
  if (!w || typeof w !== "object") return null;
  if (typeof w.start !== "string" || typeof w.end !== "string"
      || typeof w.tz !== "string") return null;
  const startMins = parseHHMM(w.start);
  const endMins = parseHHMM(w.end);
  if (startMins === null || endMins === null) return null;
  if (startMins === endMins) return null; // zero-length window is degenerate
  if (!isValidTz(w.tz)) return null;
  return { startMins, endMins, tz: w.tz };
}

/** Resolve the effective quiet-hours window for a given project slug.
 *  Per-project override beats the fleet default; the literal `false`
 *  override skips quiet hours entirely; absent / invalid configuration
 *  returns null. */
export function resolveWindow(
  cfg: FleetConfig, projectSlug: string,
): QuietWindow | null {
  const anyCfg = cfg as unknown as {
    quietHours?: QuietWindow;
    quietHoursOverride?: Record<string, QuietOverride>;
  };
  const override = anyCfg.quietHoursOverride?.[projectSlug];
  if (override === false) return null; // always page for this project
  if (override && typeof override === "object") {
    const parsed = parseWindow(override);
    if (parsed) return override; // forward the original (start/end/tz strings)
    // override was malformed — fall through to fleet default rather
    // than silently paging through quiet hours.
  }
  const fleet = anyCfg.quietHours;
  if (!fleet) return null;
  if (!parseWindow(fleet)) return null;
  return fleet;
}

/** Is the current moment within the effective quiet-hours window for
 *  this project? Returns false when no quiet hours are configured (or
 *  when configured but `now` falls outside the window). */
export function isQuietNow(
  cfg: FleetConfig, projectSlug: string, now: Date,
): boolean {
  const win = resolveWindow(cfg, projectSlug);
  if (!win) return false;
  const parsed = parseWindow(win);
  if (!parsed) return false;
  const nowMins = minutesInZone(now, parsed.tz);
  if (nowMins === null) return false;
  // Same-day window: start <= now < end.
  if (parsed.startMins < parsed.endMins) {
    return nowMins >= parsed.startMins && nowMins < parsed.endMins;
  }
  // Overnight wrap (start > end): now >= start OR now < end.
  return nowMins >= parsed.startMins || nowMins < parsed.endMins;
}

/** Compute the next moment after `now` at which the quiet-hours window
 *  ENDS for this project — i.e. the wall-clock at which the inbox's
 *  quietedItems will be re-merged back into items. Returns null when
 *  there's no active quiet hours window at `now`. Used for the SPA's
 *  "Queued during quiet hours — resumes at HH:MM" copy. */
export function nextWindowEnd(
  cfg: FleetConfig, projectSlug: string, now: Date,
): Date | null {
  if (!isQuietNow(cfg, projectSlug, now)) return null;
  const win = resolveWindow(cfg, projectSlug);
  if (!win) return null;
  const parsed = parseWindow(win);
  if (!parsed) return null;
  const nowMins = minutesInZone(now, parsed.tz);
  if (nowMins === null) return null;
  // Compute the wall-clock minute-delta to the next `end` boundary in
  // the resolved tz. Two cases:
  //   - same-day window (start < end): end is later today.
  //   - overnight wrap (start > end): if now >= start, end is tomorrow;
  //     if now < end, end is later today.
  let deltaMins: number;
  if (parsed.startMins < parsed.endMins) {
    deltaMins = parsed.endMins - nowMins;
  } else if (nowMins >= parsed.startMins) {
    // tonight → tomorrow morning end
    deltaMins = (24 * 60 - nowMins) + parsed.endMins;
  } else {
    // already in the morning portion of an overnight window
    deltaMins = parsed.endMins - nowMins;
  }
  if (deltaMins <= 0) deltaMins += 24 * 60;
  return new Date(now.getTime() + deltaMins * 60_000);
}

/** Is quiet hours active for ANY project (or for the fleet default)?
 *  Used by the inbox split + the API envelope to surface
 *  `quietHoursActive: true` even when the caller doesn't have a
 *  specific project context. */
export function quietHoursActiveAnywhere(cfg: FleetConfig, now: Date): boolean {
  const anyCfg = cfg as unknown as {
    quietHours?: QuietWindow;
    quietHoursOverride?: Record<string, QuietOverride>;
  };
  // Fleet default first — the cheap path.
  if (anyCfg.quietHours && isQuietNow(cfg, "__fleet__", now)) return true;
  // Per-project overrides next.
  const overrides = anyCfg.quietHoursOverride ?? {};
  for (const slug of Object.keys(overrides)) {
    if (isQuietNow(cfg, slug, now)) return true;
  }
  return false;
}

/** Render `nextWindowEnd` for the FLEET DEFAULT window as an ISO
 *  string suitable for the API envelope `quietHoursUntil` field.
 *  Returns null when no quiet hours are active for the fleet default. */
export function fleetQuietUntilIso(cfg: FleetConfig, now: Date): string | null {
  const end = nextWindowEnd(cfg, "__fleet__", now);
  return end ? end.toISOString() : null;
}
