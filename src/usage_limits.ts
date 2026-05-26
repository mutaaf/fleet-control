// Detect "Claude usage limit" / rate-limit signatures in agent output, and pull
// out a reset timestamp when one is present. Used by both transcript ingest and
// runs.jsonl ingest so the same patterns are applied everywhere.
//
// Why this matters: when the Max-plan 5-hour window is exhausted, every ship/
// groom/review run fails with a usage-limit error. The launchd schedule keeps
// firing but every attempt fails until the window resets. fleet-control surfaces
// this as a fleet-level "halted" state with the reset ETA so it's obvious why
// nothing is shipping (vs. silent failure).

/** Matches the typical Claude Code / Anthropic API error messages. */
const PATTERNS: RegExp[] = [
  /Claude (?:AI )?usage limit reached/i,
  /usage[\s_-]limit[\s_-]?(?:reached|exceeded|error)/i,
  /rate[\s_-]limit[\s_-]?error/i,
  /\b429\b.*(?:too many requests|rate limit)/i,
  /you (?:have )?reached your (?:usage|message|rate) limit/i,
];

/** Extract a reset time from the same blob. Patterns observed:
 *   "Resets at 9:00 PM PT"   → today (or tomorrow) 21:00 in -07:00
 *   "Try again at 2026-05-26T14:00:00Z"   → ISO
 *   "Available again at 14:00 UTC"
 *   "in 2h 17m"
 * Returns an ISO string or null. Best-effort only — UI shows the raw text too. */
export function extractResetTime(text: string, now: Date = new Date()): string | null {
  // ISO (preferred — unambiguous)
  const iso = text.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (iso) { const d = new Date(iso[1]); if (!isNaN(d.getTime())) return d.toISOString(); }
  // "in 2h 17m" / "in 45m" / "in 3 hours"
  const rel = text.match(/in\s+(?:(\d+)\s*h(?:ours?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
  if (rel && (rel[1] || rel[2])) {
    const ms = (Number(rel[1] || 0) * 3600 + Number(rel[2] || 0) * 60) * 1000;
    if (ms > 0) return new Date(now.getTime() + ms).toISOString();
  }
  // "Resets at 9:00 PM PT" / "available again at 14:00 UTC"
  const clock = text.match(/(?:reset(?:s)?|available again|try again)\s+(?:at\s+)?(\d{1,2}):?(\d{2})?\s*(am|pm)?\s*(pt|pst|pdt|et|est|edt|utc|gmt)?/i);
  if (clock) {
    let h = Number(clock[1]); const m = Number(clock[2] || 0);
    const mer = (clock[3] || "").toLowerCase(); const tz = (clock[4] || "").toLowerCase();
    if (mer === "pm" && h < 12) h += 12; if (mer === "am" && h === 12) h = 0;
    const offsetMin = tz === "utc" || tz === "gmt" ? 0
      : tz === "pst" ? 8 * 60 : tz === "pdt" || tz === "pt" ? 7 * 60
      : tz === "est" ? 5 * 60 : tz === "edt" || tz === "et" ? 4 * 60
      : -now.getTimezoneOffset();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, 0));
    const utc = today.getTime() + offsetMin * 60_000;
    return new Date(utc <= now.getTime() ? utc + 86_400_000 : utc).toISOString();
  }
  return null;
}

export interface UsageLimitHit {
  hit: true;
  until: string | null;   // ISO reset time if extractable
  snippet: string;        // raw text snippet for the UI
}
export interface UsageLimitMiss { hit: false; }

export function detectUsageLimit(text: string | null | undefined, now: Date = new Date()): UsageLimitHit | UsageLimitMiss {
  if (!text) return { hit: false };
  for (const re of PATTERNS) {
    const m = re.exec(text);
    if (m) {
      // Pick a slice around the match for the snippet — handy in the UI.
      const start = Math.max(0, m.index - 80);
      const end = Math.min(text.length, m.index + 240);
      return { hit: true, until: extractResetTime(text, now), snippet: text.slice(start, end).replace(/\s+/g, " ").trim() };
    }
  }
  return { hit: false };
}
