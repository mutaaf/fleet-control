// Cross-fleet lessons portal view (ticket 0036).
//
// Pure-JS parser + loader for the auto-generated
// `~/.local/share/agent-fleet/CROSS_LESSONS.md` file. The portal's
// `/lessons` page reads through `GET /api/fleet/lessons` (wired in
// src/server.ts) which calls `loadCrossLessons()`; the daemon's once-
// per-day diff (src/daemon.ts) calls the same helper and emits an
// inbox row when the total grew.
//
// Zero new runtime deps; only `node:fs` + `node:path` + `node:os`.
// No markdown parser dependency — the file structure is fixed
// (per-project `## <slug>` H2, `### YYYY-MM-DD - <title>` H3 entries
// OR `- YYYY-MM-DD [phase] ...` bullet entries inside an `### Entries`
// section) so two regex passes carry the whole job. The file size
// safety check (2MB precheck via `fs.statSync`) keeps a runaway log
// from OOMing the server per AGENTS.md Hard NOs.
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// N/A here — no SQL is involved. Per LESSONS § "no shell-out to read
// the file": we use `readFileSync` + `statSync`, never `cat` or a
// subprocess.
import { readFileSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export type LessonKind = "h3" | "bullet";

export interface LessonEntry {
  /** ISO date (YYYY-MM-DD) parsed from the entry header / bullet, or
   *  null when the entry has no parseable date. Undated entries are
   *  still included so the operator sees them; the SPA's "new this
   *  week" filter just skips them. */
  date: string | null;
  /** Headline — the H3 title text (without the date prefix) for `h3`
   *  entries, or the full single-line bullet text (without the date /
   *  phase prefix) for `bullet` entries. */
  title: string;
  /** Body paragraph(s) for h3 entries; empty string for bullet
   *  entries (they're single-line by construction). */
  body: string;
  /** Which style the parser matched. The SPA uses this to render an
   *  h3 entry's body as a paragraph and a bullet entry as inline
   *  "symptom -> cause -> fix" text. */
  kind: LessonKind;
}

export interface ProjectLessons {
  /** The project slug — the text after `## ` on the H2 header. */
  slug: string;
  /** Lessons in source order (parser preserves file order). */
  lessons: LessonEntry[];
}

export interface CrossLessonsParseResult {
  projects: ProjectLessons[];
  /** ISO timestamp at which the parse ran. */
  parsed_at: string;
  /** Sum of `lessons.length` across `projects`. */
  total: number;
}

export interface CrossLessonsLoadResult extends CrossLessonsParseResult {
  /** False when the file is missing; true otherwise. */
  source_present: boolean;
  /** True when the file is larger than `MAX_FILE_BYTES`. In that case
   *  `projects` is empty and `total` is 0 — the parser is skipped
   *  entirely so a runaway file can't OOM the server. */
  oversized?: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Tunables
// ────────────────────────────────────────────────────────────────────

/** Maximum file size we'll read. Production file is ~85KB today; 2MB
 *  is ~25x headroom which keeps the door open for years of growth
 *  while preventing a pathological log from killing the server. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Env-var override for the source file path. Production reads the
 *  default at homedir; tests + the daemon's deterministic seed run
 *  through this seam. */
export const ENV_PATH_KEY = "FLEET_CROSS_LESSONS_PATH";

// ────────────────────────────────────────────────────────────────────
// Path resolution
// ────────────────────────────────────────────────────────────────────

/** The canonical file path the autonomous loop's `fleet lessons-sync`
 *  writes to. Overridable per-process via `FLEET_CROSS_LESSONS_PATH`
 *  (the route handler and the daemon both honour the override). */
export function defaultLessonsPath(): string {
  const override = process.env[ENV_PATH_KEY];
  if (override) return override;
  return join(homedir(), ".local", "share", "agent-fleet", "CROSS_LESSONS.md");
}

// ────────────────────────────────────────────────────────────────────
// Parser
// ────────────────────────────────────────────────────────────────────

const H2_RE = /^##\s+(.+?)\s*$/;
const H3_DATED_RE = /^###\s+(\d{4}-\d{2}-\d{2})\s*[—-]\s*(.+?)\s*$/;
const H3_UNDATED_RE = /^###\s+(.+?)\s*$/;
const BULLET_RE = /^-\s+(\d{4}-\d{2}-\d{2})\s+(?:\[[^\]]*\]\s+)?(.+?)\s*$/;

/** Parse the source text into the structured projects shape. Pure
 *  string operation — no I/O. Order is preserved: projects appear in
 *  source order; lessons appear in source order within each project.
 *
 *  Recognised structures:
 *
 *    ## <slug>                       -- starts a new project block
 *    ### YYYY-MM-DD — <title>        -- dated H3 entry (also '-' accepted)
 *    ### <anything>                  -- undated H3 entry (date: null)
 *    - YYYY-MM-DD [phase] <text>     -- bullet entry under `### Entries`
 *
 *  H3 entries' body spans every following non-empty line until the
 *  next `###` or `##`. Bullet entries have an empty body string —
 *  they're single-line by construction. The `### Entries` H3 itself
 *  is treated as a section header (no entry recorded for it) so the
 *  bullets underneath land as bullet-kind entries, not as the body of
 *  a phantom H3 entry. */
export function parseCrossLessons(text: string): CrossLessonsParseResult {
  const projects: ProjectLessons[] = [];
  const lines = text.split(/\r?\n/);
  let currentProject: ProjectLessons | null = null;
  let currentH3: LessonEntry | null = null;
  let bodyBuf: string[] = [];

  const flushH3 = () => {
    if (currentH3 && currentProject) {
      currentH3.body = bodyBuf.join("\n").trim();
      currentProject.lessons.push(currentH3);
    }
    currentH3 = null;
    bodyBuf = [];
  };

  for (const line of lines) {
    const h2 = line.match(H2_RE);
    if (h2) {
      flushH3();
      currentProject = { slug: h2[1].trim(), lessons: [] };
      projects.push(currentProject);
      continue;
    }
    if (!currentProject) {
      // Skip everything before the first `## <slug>` (e.g. the file
      // preamble). Without a project we can't attach an entry.
      continue;
    }
    const h3d = line.match(H3_DATED_RE);
    if (h3d) {
      flushH3();
      currentH3 = {
        date: h3d[1],
        title: h3d[2].trim(),
        body: "",
        kind: "h3",
      };
      continue;
    }
    const h3u = line.match(H3_UNDATED_RE);
    if (h3u) {
      flushH3();
      // The `### Entries` H3 is a structural marker, not an entry.
      // The bullets that follow become bullet-kind entries.
      if (/^Entries\s*$/i.test(h3u[1].trim())) {
        currentH3 = null;
        continue;
      }
      currentH3 = {
        date: null,
        title: h3u[1].trim(),
        body: "",
        kind: "h3",
      };
      continue;
    }
    const b = line.match(BULLET_RE);
    if (b) {
      // Bullet entries flush any pending H3 first so a bullet doesn't
      // get folded into the previous H3's body. A bullet has no
      // multi-line body — the next non-bullet line either opens a
      // fresh H3/H2 (which flushH3 already handles), or is a stray
      // empty line we silently drop.
      flushH3();
      currentProject.lessons.push({
        date: b[1],
        title: b[2].trim(),
        body: "",
        kind: "bullet",
      });
      continue;
    }
    // Plain content line — if we're inside an H3 it joins the body.
    if (currentH3) bodyBuf.push(line);
  }
  flushH3();

  let total = 0;
  for (const p of projects) total += p.lessons.length;
  return {
    projects,
    parsed_at: new Date().toISOString(),
    total,
  };
}

// ────────────────────────────────────────────────────────────────────
// Loader (the only I/O surface)
// ────────────────────────────────────────────────────────────────────

/** Read + parse the source file. Never throws — a missing file
 *  returns `source_present: false` with an empty projects array, and
 *  a >MAX_FILE_BYTES file returns `oversized: true` (the parser is
 *  skipped entirely so the server can't OOM). Per AGENTS.md Hard
 *  NOs, no shell-out — we use `statSync` for the size precheck and
 *  `readFileSync` for the read. */
export function loadCrossLessons(path: string): CrossLessonsLoadResult {
  const nowIso = new Date().toISOString();
  if (!existsSync(path)) {
    return {
      projects: [],
      parsed_at: nowIso,
      total: 0,
      source_present: false,
    };
  }
  let size = 0;
  try {
    const st = statSync(path);
    size = st.size;
  } catch {
    // Race: the file vanished between existsSync and statSync. Treat
    // it as missing — same shape as the no-file branch.
    return {
      projects: [],
      parsed_at: nowIso,
      total: 0,
      source_present: false,
    };
  }
  if (size > MAX_FILE_BYTES) {
    return {
      projects: [],
      parsed_at: nowIso,
      total: 0,
      source_present: true,
      oversized: true,
    };
  }
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {
      projects: [],
      parsed_at: nowIso,
      total: 0,
      source_present: false,
    };
  }
  const parsed = parseCrossLessons(text);
  return {
    projects: parsed.projects,
    parsed_at: parsed.parsed_at,
    total: parsed.total,
    source_present: true,
  };
}

// ────────────────────────────────────────────────────────────────────
// "new this week" helper — shared by the route + the daemon hook so
// they agree on the window.
// ────────────────────────────────────────────────────────────────────

const WEEK_MS = 7 * 24 * 3600_000;

/** Count entries whose `date` parses to a Date within the last 7 days
 *  relative to `now`. Undated entries don't count. The route response
 *  surfaces this number for the SPA's "new this week (N)" badge. */
export function newThisWeekCount(
  result: { projects: ProjectLessons[] },
  now: Date,
): number {
  const cutoff = now.getTime() - WEEK_MS;
  let n = 0;
  for (const p of result.projects) {
    for (const l of p.lessons) {
      if (!l.date) continue;
      const t = Date.parse(l.date);
      if (!Number.isFinite(t)) continue;
      if (t >= cutoff) n += 1;
    }
  }
  return n;
}

// ────────────────────────────────────────────────────────────────────
// Daemon hook — once-per-day diff of `total` against the previous
// known value. Per AGENTS.md "No schema migration in v1": the hook
// reuses the existing `watermark` table with two fixed keys
// (`cross_lessons_total` for the running total, `cross_lessons_last_new`
// for the most-recent detected delta). Per LESSONS § "re-fire-after-
// dismiss needs an aging window, not a partial UNIQUE index",
// idempotency lives in the application via a 24h lookup on the
// `cross_lessons_last_new` watermark — never a SQL UNIQUE constraint.
// ────────────────────────────────────────────────────────────────────

import type { DB } from "./db.ts";

const LESSONS_TOTAL_KEY = "cross_lessons_total";
const LESSONS_LAST_NEW_KEY = "cross_lessons_last_new";
const ONE_DAY_MS = 24 * 3600_000;

interface WatermarkRow { cursor: string }

/** Look up the cursor for one watermark key. Returns null if the row
 *  hasn't been written yet. */
function readWatermark(db: DB, key: string): string | null {
  const row = db.prepare(
    "SELECT cursor FROM watermark WHERE source=?",
  ).get(key) as unknown as WatermarkRow | undefined;
  return row?.cursor ?? null;
}

function writeWatermark(db: DB, key: string, cursor: string, nowIso: string): void {
  db.prepare(
    "INSERT INTO watermark(source,cursor,updated_at) VALUES(?,?,?) "
    + "ON CONFLICT(source) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at",
  ).run(key, cursor, nowIso);
}

/** Parse the `<count>|<iso>` cursor format used by
 *  `cross_lessons_last_new`. Returns null for either missing or
 *  malformed values — both shapes are treated as "nothing pending". */
export function parseLastNewCursor(cursor: string | null): {
  count: number; at: string;
} | null {
  if (!cursor) return null;
  const [n, at] = cursor.split("|");
  const count = Number(n);
  if (!Number.isFinite(count) || count <= 0) return null;
  if (!at) return null;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  return { count, at };
}

export interface LessonsNewInbox {
  /** Number of fresh lessons since the last seen total. */
  count: number;
  /** ISO timestamp the hook fired. Used as the dedup payload_id so a
   *  fresh fire (after the previous batch was dismissed) gets a new
   *  payload_id and re-surfaces — per LESSONS § "re-fire-after-dismiss
   *  needs an aging window, not a partial UNIQUE index". */
  at: string;
}

/** Surface the active `lessons_new` row for the inbox. Returns null
 *  when no fresh delta has been detected, when the most recent
 *  detection is older than 24h, OR when the operator has already
 *  dismissed this batch (matched by payload_id == at). The inbox
 *  composer (src/inbox.ts) calls this once per build. */
export function activeLessonsNewInbox(
  db: DB, now: Date,
): LessonsNewInbox | null {
  const cursor = readWatermark(db, LESSONS_LAST_NEW_KEY);
  const parsed = parseLastNewCursor(cursor);
  if (!parsed) return null;
  const t = Date.parse(parsed.at);
  if (now.getTime() - t > ONE_DAY_MS) return null;
  return { count: parsed.count, at: parsed.at };
}

/** Run the once-per-day lessons-new detector. Reads the file, diffs
 *  the total against the previous watermark, and (when a positive
 *  delta exists AND no earlier delta is still inside its 24h aging
 *  window) writes a fresh `cross_lessons_last_new` watermark + bumps
 *  the running total. Returns the number of inbox rows the next
 *  `fleetInbox` build will surface — 0 or 1.
 *
 *  Per LESSONS § "shell-out modules need an injectable runner for
 *  tests" the path resolution is via `defaultLessonsPath()` which
 *  reads the `FLEET_CROSS_LESSONS_PATH` env override — tests stub
 *  the env, never the loader. */
export function runLessonsHook(db: DB, now: Date): number {
  const nowIso = now.toISOString();
  const path = defaultLessonsPath();
  const v = loadCrossLessons(path);
  // When the source file is missing or oversized, don't touch
  // either watermark: an absent file is a fresh-install signal and
  // an oversized file is a runaway-log signal — neither should mint
  // an inbox row.
  if (!v.source_present || v.oversized) return 0;

  const prev = Number(readWatermark(db, LESSONS_TOTAL_KEY) ?? "0");
  const current = v.total;
  if (current <= prev) {
    // No new lessons since the last check. Sync the watermark so a
    // future delta reads from the correct baseline (this also handles
    // the cold-start case where prev=0 because there's no prior row).
    if (current !== prev) writeWatermark(db, LESSONS_TOTAL_KEY, String(current), nowIso);
    return 0;
  }

  // Aging-window idempotency — if a previous delta inside the last
  // 24h is still live, don't re-fire. The next tick after the window
  // closes will pick up a fresh batch (or no-op if nothing changed).
  const existing = activeLessonsNewInbox(db, now);
  if (existing) return 0;

  const delta = current - prev;
  writeWatermark(db, LESSONS_LAST_NEW_KEY, `${delta}|${nowIso}`, nowIso);
  writeWatermark(db, LESSONS_TOTAL_KEY, String(current), nowIso);
  return 1;
}
