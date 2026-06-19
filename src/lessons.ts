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

// ────────────────────────────────────────────────────────────────────
// Ticket 0042 — Lesson credit ledger.
//
// Two pure helpers turn the parsed CROSS_LESSONS.md file into an
// attribution ledger over control_audit's heal rows:
//
//   extractSymptomPatterns(parsed)   → per-lesson distinctive substrings
//   attributeHealsToLessons(db, ...) → walks heal-audit rows, runs
//                                      each lesson's patterns through
//                                      String.prototype.includes() on
//                                      the stdout_tail, writes one
//                                      lesson_credit row per first
//                                      matching (lesson, heal) pair.
//
// PRODUCER-VS-SPEC reconciliation (per LESSONS 2026-06-05 "groomer
// prose can disagree with the schema; the schema wins"): the
// production heal row is INSERTed with action='heal' (lowercase) and
// target='pr-<number>' — confirmed against src/control.ts:230 (the
// audit() helper that every doAction("heal", …) hits) and the
// riskiest-pr classifier in src/views.ts:3128. We SELECT against the
// same casing here.
//
// Per AGENTS.md Hard NO "never compose a shell string from input"
// (and its SQL analogue): every pattern lives in JS as a literal
// string; we never push it into a SQL LIKE / GLOB. The SQL surface
// is a single parameterised prepared statement bound to the
// (lesson_slug, lesson_date, heal_audit_id, …) tuple.
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// every typed-row narrowing here uses the double-cast pattern.
// ────────────────────────────────────────────────────────────────────

/** Minimum length for a candidate substring to be considered
 *  "distinctive enough" to act as a match key. 12 chars filters
 *  out common English words and short tool names so a pattern like
 *  "the run" doesn't credit half the heals in the fleet. */
const MIN_PATTERN_LEN = 12;

/** Per-lesson cap. The attributor iterates patterns in order and
 *  stops on the first match per heal — three is plenty of coverage
 *  for the body+title variants of a single lesson without inflating
 *  the inner loop. */
const MAX_PATTERNS_PER_LESSON = 3;

/** Default attribution window in days. The route + the daemon hook
 *  both accept an opts override; the constant lives here so test
 *  fixtures can import it later if needed. */
export const LESSON_CREDIT_DEFAULT_WINDOW_DAYS = 30;

/** Hard-coded module-level stoplist of common English words and short
 *  generic terms. Kept tight — anything we miss is filtered out by
 *  the >= 12 char length check anyway, so this list focuses on the
 *  multi-word junk fragments that would otherwise sneak through
 *  (e.g. "the GitHub Actions sometimes" → if a stoplist token sits
 *  at the start, we recompose from the next word). The list is a
 *  Set for O(1) lookup. */
const STOPLIST = new Set<string>([
  "the", "and", "with", "from", "into", "your", "this", "that",
  "have", "been", "when", "what", "while", "where", "which",
  "these", "those", "their", "there", "would", "could", "should",
  "about", "after", "before", "above", "below", "again", "still",
  "some", "such", "than", "then", "them", "they", "were", "will",
  "just", "only", "very", "also", "even", "more", "most", "much",
  "other", "over", "same", "into", "onto", "upon", "each", "every",
  "any", "all", "for", "but", "not", "now", "out", "via", "per",
  "lesson", "lessons", "symptom", "cause", "fix", "trace", "log",
]);

export interface LessonSymptomPatterns {
  slug: string;
  date: string;
  title: string;
  patterns: string[];
}

/** Tokenise + filter a single lesson title/body pair into 1-3
 *  distinctive substrings. The first candidate is always the lesson
 *  title (most distinctive by construction — the operator authored
 *  it as a one-line "here's the symptom" headline). Subsequent
 *  candidates are the first sentence of the body and the first
 *  sentence after the body's "Cause:" / "Fix:" tokens when present.
 *
 *  Each candidate is trimmed to a single line and clipped to <= 200
 *  chars so the SQL row stays small. Candidates whose every word is
 *  in the STOPLIST OR whose length is below MIN_PATTERN_LEN are
 *  dropped. */
function patternsForLesson(title: string, body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const cleaned = raw.replace(/\s+/g, " ").trim();
    if (cleaned.length < MIN_PATTERN_LEN) return;
    if (cleaned.length > 200) return;
    // All-stoplist test: every space-split token is in the stoplist.
    const tokens = cleaned.toLowerCase().split(/[\s\W]+/).filter(Boolean);
    const informative = tokens.some((t) => !STOPLIST.has(t) && t.length >= 4);
    if (!informative) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(cleaned);
  };
  // 1. The title (most distinctive — operator-authored headline).
  push(title);
  // 2. First sentence of the body. We split on `.\s` or newline so a
  //    multi-paragraph body still yields a tight first candidate.
  const firstLine = body.split(/[.\n]/).find((s) => s.trim().length >= MIN_PATTERN_LEN);
  if (firstLine) push(firstLine);
  // 3. The text immediately following the body's `Cause:` token —
  //    this is the lesson's "what went wrong" summary, the part
  //    most likely to mirror an upstream heal's stdout tail.
  const causeMatch = body.match(/Cause:\s*([^.\n]+)/i);
  if (causeMatch) push(causeMatch[1]);
  return out.slice(0, MAX_PATTERNS_PER_LESSON);
}

/** Derive per-lesson match keys from a parsed CROSS_LESSONS.md.
 *  Dated-less entries are skipped (the lesson_credit PK requires
 *  lesson_date). Returns lessons whose patterns array is non-empty —
 *  a lesson with no usable substrings can't match anything anyway,
 *  so dropping it from the output keeps the attributor's inner loop
 *  short. */
export function extractSymptomPatterns(
  parsed: CrossLessonsLoadResult,
): LessonSymptomPatterns[] {
  const out: LessonSymptomPatterns[] = [];
  for (const p of parsed.projects) {
    for (const l of p.lessons) {
      if (!l.date) continue;
      const patterns = patternsForLesson(l.title ?? "", l.body ?? "");
      if (patterns.length === 0) continue;
      out.push({
        slug: p.slug,
        date: l.date,
        title: l.title,
        patterns,
      });
    }
  }
  return out;
}

interface HealAuditRowForAttribution {
  id: number;
  ts: string;
  target: string | null;
  stdout_tail: string | null;
}

interface ProjectByPrRow {
  number: number;
  project_slug: string;
}

export interface AttributeHealsResult {
  credits_inserted: number;
  heals_examined: number;
}

export interface AttributeHealsOptions {
  /** Window in days for the heal lookback. Defaults to
   *  LESSON_CREDIT_DEFAULT_WINDOW_DAYS (30). */
  windowDays?: number;
}

/** Walk every heal-audit row in the window, match its stdout_tail
 *  against every lesson's patterns (first-match-wins per heal), and
 *  INSERT OR IGNORE one lesson_credit row per (lesson, heal) pair.
 *
 *  Idempotent on re-run: the composite PK on lesson_credit
 *  (lesson_slug, lesson_date, heal_audit_id) blocks duplicates so a
 *  second invocation in the same daemon loop is a silent no-op.
 *
 *  Pure-SQL + JS substring helper — no shell-out, no network, no
 *  LLM. Per AGENTS.md Hard NOs the stdout_tail match runs in JS via
 *  String.prototype.includes(); the only SQL the helper issues is
 *  parameterised reads and writes against lesson_credit / pr /
 *  control_audit. */
export function attributeHealsToLessons(
  db: DB,
  parsed: CrossLessonsLoadResult,
  now: Date,
  opts: AttributeHealsOptions = {},
): AttributeHealsResult {
  const windowDays = Math.max(
    1, Math.floor(opts.windowDays ?? LESSON_CREDIT_DEFAULT_WINDOW_DAYS));
  // When the parsed file is empty / oversized / missing there's
  // nothing to attribute against; the daemon hook also short-circuits
  // before calling us, but this guard keeps the helper safe for
  // direct callers (tests etc.).
  if (!parsed.source_present || parsed.oversized) {
    return { credits_inserted: 0, heals_examined: 0 };
  }
  const patternsByLesson = extractSymptomPatterns(parsed);
  if (patternsByLesson.length === 0) {
    return { credits_inserted: 0, heals_examined: 0 };
  }

  const cutoffIso = new Date(now.getTime() - windowDays * 24 * 3600_000).toISOString();
  // PRODUCER-VS-SPEC: action='heal' (lowercase) per src/control.ts.
  const healRows = db.prepare(
    "SELECT id, ts, target, stdout_tail FROM control_audit "
    + " WHERE action = 'heal' AND ts >= ? "
    + " ORDER BY id ASC",
  ).all(cutoffIso) as unknown as HealAuditRowForAttribution[];

  if (healRows.length === 0) {
    return { credits_inserted: 0, heals_examined: 0 };
  }

  // Pre-load the PR → project_slug map so we attribute the credit to
  // the right project without an N+1 join. target follows the
  // 'pr-<number>' convention (per src/views.ts:3128); rows whose
  // target doesn't match that shape simply attribute to project_slug
  // = '' (still a valid credit; the rollup just counts it under the
  // empty slug, which is the right thing for non-PR-scoped heals).
  const prMapRows = db.prepare(
    "SELECT pr.number AS number, project.slug AS project_slug "
    + " FROM pr JOIN project ON project.id = pr.project_id",
  ).all() as unknown as ProjectByPrRow[];
  const slugByPrNumber = new Map<number, string>();
  for (const r of prMapRows) slugByPrNumber.set(Number(r.number), String(r.project_slug));

  const insert = db.prepare(
    "INSERT OR IGNORE INTO lesson_credit("
    + "lesson_slug, lesson_date, lesson_title, heal_audit_id, "
    + "project_slug, matched_substring, created_at"
    + ") VALUES (?,?,?,?,?,?,?)",
  );

  let inserted = 0;
  const nowIso = now.toISOString();
  for (const heal of healRows) {
    const tail = String(heal.stdout_tail ?? "");
    if (!tail) continue;
    // Resolve project_slug from the target shape. We accept
    // 'pr-<N>' explicitly; anything else (e.g. '<slug>/<phase>'
    // from auto-kill rows) falls back to the slug component when
    // present, otherwise the empty string.
    let projectSlug = "";
    const target = String(heal.target ?? "");
    const prMatch = target.match(/^pr-(\d+)$/);
    if (prMatch) {
      projectSlug = slugByPrNumber.get(Number(prMatch[1])) ?? "";
    } else if (target.includes("/")) {
      projectSlug = target.split("/")[0] ?? "";
    }
    // First-match-wins per heal. We iterate lessons in source order
    // (extractSymptomPatterns preserves it); within a lesson the
    // patterns are also iterated in order (title first, then body
    // sentences). The credit attributes to the FIRST lesson whose
    // any pattern is a substring of the tail.
    let matchedLesson: LessonSymptomPatterns | null = null;
    let matchedSubstring = "";
    outer: for (const lesson of patternsByLesson) {
      for (const p of lesson.patterns) {
        if (tail.includes(p)) {
          matchedLesson = lesson;
          matchedSubstring = p;
          break outer;
        }
      }
    }
    if (!matchedLesson) continue;
    const r = insert.run(
      matchedLesson.slug, matchedLesson.date, matchedLesson.title,
      heal.id, projectSlug, matchedSubstring, nowIso,
    );
    if (r.changes > 0) inserted += 1;
  }
  // Ticket 0052: invalidate the lesson-savings memo cache the moment
  // a fresh lesson_credit row lands so the next /api/fleet/lessons/
  // savings or /api/fleet/lessons request sees the new ledger entry
  // without waiting out the 15-min TTL. Per LESSONS 2026-06-05
  // "break ingest↔server cache-invalidation cycles via a globalThis
  // slot, not a circular import": the slot
  // `__fleet_lesson_savings_invalidate__` is registered from
  // src/server.ts on module load; we read it lazily here so this
  // module never has to import server.ts. The hook is a no-op when
  // the server module hasn't loaded (the launchd daemon imports
  // this module but not the server).
  if (inserted > 0) {
    try {
      const savingsHook = (globalThis as { __fleet_lesson_savings_invalidate__?: () => void })
        .__fleet_lesson_savings_invalidate__;
      if (typeof savingsHook === "function") savingsHook();
    } catch { /* never let an in-process cache fail an attribution */ }
    // Ticket 0055: the lesson-of-the-day rotation list is keyed off
    // savings ranking, so a fresh lesson_credit row may re-order the
    // rotation. Wake the lesson-of-the-day memo via the same
    // globalThis-slot pattern (registered by src/server.ts on module
    // load) — never an import cycle.
    try {
      const lotdHook = (globalThis as { __fleet_lesson_of_the_day_invalidate__?: () => void })
        .__fleet_lesson_of_the_day_invalidate__;
      if (typeof lotdHook === "function") lotdHook();
    } catch { /* never let an in-process cache fail an attribution */ }
    // Ticket 0056: the per-project savings rollup composes the SAME
    // lesson_credit + run signals as the parent 0052 savings rollup,
    // so a fresh credit row must bust the per-project cache too. Same
    // globalThis-slot pattern; registered by src/server.ts on module
    // load (never an import cycle).
    try {
      const byProjectHook = (globalThis as { __fleet_lesson_savings_by_project_invalidate__?: () => void })
        .__fleet_lesson_savings_by_project_invalidate__;
      if (typeof byProjectHook === "function") byProjectHook();
    } catch { /* never let an in-process cache fail an attribution */ }
    // Ticket 0069: the per-slug lineage memo cache derives directly
    // from lesson_credit rows; a fresh credit row may grow the
    // timeline or flip a singleton-shape lesson into a multi-catch
    // one. Wake the lineage memo via the same globalThis-slot pattern
    // (registered by src/server.ts on module load) - never an import
    // cycle (LESSONS 2026-06-05).
    try {
      const lineageHook = (globalThis as { __fleet_lesson_lineage_invalidate__?: () => void })
        .__fleet_lesson_lineage_invalidate__;
      if (typeof lineageHook === "function") lineageHook();
    } catch { /* never let an in-process cache fail an attribution */ }
  }
  return { credits_inserted: inserted, heals_examined: healRows.length };
}

// ────────────────────────────────────────────────────────────────────
// Ticket 0055 — Lesson of the day.
//
// Pure helper that selects ONE cross-fleet lesson per UTC day, weighted
// by the lesson_credit-based savings ledger (0052). Composes the
// existing cross-fleet lessons file (0036) with the existing
// `lessonSavingsRollup()` helper (0052) — no new schema, no new
// ingest, no new control surface.
//
// Selection algorithm:
//   1. Load the parsed cross-fleet lessons via `loadCrossLessons()`.
//   2. If fewer than 5 dated lessons exist → return null (the SPA
//      renders the "still learning" empty state).
//   3. Build `ranked_lessons` = lessons sorted by `saved_usd` DESC
//      (stable secondary sort by `lesson_slug` ASC then `lesson_date`
//      ASC). Lessons with zero credits get `saved_usd = 0` and sort
//      to the tail.
//   4. Apply a savings-decile bias: every lesson whose `saved_usd`
//      is in the top decile (>= the 90th-percentile threshold of the
//      non-zero values) appears TWICE in the rotation list. This
//      gives the highest-value lessons ~2x the surface frequency
//      without changing the deterministic shape of the rotation.
//   5. Compute `day_index = floor(epoch_ms / 86_400_000)` (UTC days
//      since the unix epoch).
//   6. Pick `ranked_lessons[day_index mod ranked_lessons.length]`.
//
// PRODUCER-VS-SPEC: the spec prose names a `lesson_slug` field on the
// parsed entry, but `parseCrossLessons()` exposes the slug on the
// PARENT `ProjectLessons.slug` (not on each `LessonEntry`). We join
// `lesson_slug = project.slug` and `lesson_date = entry.date` so the
// rotation key matches `lessonSavingsRollup`'s (lesson_slug,
// lesson_date) row identity.
//
// Per LESSONS § "node:sqlite's .all() needs `as unknown as T[]`":
// every row narrowing in lessonSavingsRollup already uses the double
// cast — we just consume the typed result here.
// Per LESSONS § "no backticks inside template-literal SQL strings":
// this helper issues no raw SQL; it composes pure-JS rollups.
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps
// from `new Date()`": the helper accepts `opts.now` so tests pin the
// rotation day deterministically.
// Per LESSONS § "in-process dedup sets need an explicit reset hook
// for tests" AND § "expose a build counter for cache-hit tests, not
// a fetcher swap": the caching + reset + counter seam live in
// src/server.ts where the route handler reads the cache; the helper
// itself is pure.
// ────────────────────────────────────────────────────────────────────

import { lessonSavingsRollup, type LessonSavingsRow } from "./views.ts";

/** Minimum number of dated lessons before the rotation surfaces a
 *  card. Below this the SPA shows an honest "still learning" empty
 *  state per the user story. */
export const LESSON_OF_THE_DAY_MIN_LESSONS = 5;

/** Window in days for the savings rollup we join against. Wide
 *  enough to cover the lifetime of the lesson_credit ledger — the
 *  rotation is a "wisdom-accounting" surface, not a recency surface,
 *  so a credit landed N years ago still ranks the lesson it
 *  attributed to. The 0052 savings route still defaults to 90; this
 *  is a deliberate per-feature widening so the daily rotation's slot
 *  doesn't shift mid-month as a 91-day-old credit ages out of the
 *  shorter window. */
export const LESSON_OF_THE_DAY_SAVINGS_WINDOW_DAYS = 3650;

/** Hard cap on the excerpt length so the SPA's mobile card layout
 *  stays predictable. Per the user story: "~120 chars, first sentence
 *  of the symptom-cause-fix paragraph". */
export const LESSON_OF_THE_DAY_EXCERPT_CHARS = 120;

export interface LessonOfTheDay {
  lesson_slug: string;
  lesson_date: string;
  lesson_title: string;
  lesson_excerpt: string;
  saved_usd: number;
  total_lessons_indexed: number;
  rotation_day_index: number;
}

export interface LessonOfTheDayOptions {
  /** Pin the rotation day. Defaults to `new Date()`. Tests MUST set
   *  this per LESSONS § "time-pinned tests must NOT derive seed
   *  timestamps from `new Date()`". */
  now?: Date;
}

interface RankedLesson {
  lesson_slug: string;
  lesson_date: string;
  lesson_title: string;
  lesson_body: string;
  saved_usd: number;
}

/** First-sentence excerpt up to `LESSON_OF_THE_DAY_EXCERPT_CHARS`
 *  chars, ending on a word boundary. Returns "" when the body is
 *  empty so the SPA can render an em-dash placeholder. */
function buildExcerpt(body: string): string {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  // Prefer the first sentence — split on '.', '\n', '!', '?' .
  const firstSentenceMatch = text.match(/^[^.\n!?]+[.!?]?/);
  const firstSentence = firstSentenceMatch ? firstSentenceMatch[0].trim() : text;
  if (firstSentence.length <= LESSON_OF_THE_DAY_EXCERPT_CHARS) return firstSentence;
  // Clip on a word boundary. Walk back from the cap to the previous
  // space so we don't slice mid-word.
  const clipped = firstSentence.slice(0, LESSON_OF_THE_DAY_EXCERPT_CHARS);
  const lastSpace = clipped.lastIndexOf(" ");
  if (lastSpace > 0) return clipped.slice(0, lastSpace) + "…";
  return clipped + "…";
}

/** Compute the 90th-percentile threshold over the strictly positive
 *  `saved_usd` values. Returns `Infinity` when no values are positive
 *  (no top-decile bias when the fleet has no savings). */
function topDecileThreshold(savedUsds: number[]): number {
  const positives = savedUsds.filter((v) => v > 0);
  if (positives.length === 0) return Infinity;
  // Sort ascending and pick the value at the 90th percentile index.
  // We use the nearest-rank method which is fine for our purposes
  // (it's just a frequency bias, not a statistical threshold).
  const sorted = positives.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1);
  return sorted[idx];
}

/** Pick the deterministic lesson-of-the-day. Returns `null` when the
 *  cross-fleet lessons file carries fewer than
 *  `LESSON_OF_THE_DAY_MIN_LESSONS` dated lessons. */
export function lessonOfTheDay(
  db: DB,
  opts: LessonOfTheDayOptions = {},
): LessonOfTheDay | null {
  const now = opts.now ?? new Date();
  const lessonsPath = defaultLessonsPath();
  const parsed = loadCrossLessons(lessonsPath);
  // Empty / oversized / missing → no rotation. The route translates
  // this into a `{ lesson: null }` 200 so the SPA renders the honest
  // empty state.
  if (!parsed.source_present || parsed.oversized) return null;

  // Collect every dated lesson; the rotation joins on (slug, date) so
  // undated entries (legacy headers, free-form sections) are dropped.
  const flat: Array<{ slug: string; date: string; title: string; body: string }> = [];
  for (const p of parsed.projects) {
    for (const l of p.lessons) {
      if (!l.date) continue;
      flat.push({
        slug: p.slug,
        date: l.date,
        title: String(l.title ?? ""),
        body: String(l.body ?? ""),
      });
    }
  }
  if (flat.length < LESSON_OF_THE_DAY_MIN_LESSONS) return null;

  // Join with the savings rollup (0052) so each lesson carries a
  // saved_usd value. Lessons with no credits get $0.
  const savings = lessonSavingsRollup(db, {
    now,
    windowDays: LESSON_OF_THE_DAY_SAVINGS_WINDOW_DAYS,
  });
  const savingsByKey = new Map<string, LessonSavingsRow>();
  for (const row of savings.lesson_savings) {
    savingsByKey.set(row.lesson_slug + "|" + row.lesson_date, row);
  }

  const ranked: RankedLesson[] = flat.map((f) => {
    const row = savingsByKey.get(f.slug + "|" + f.date);
    return {
      lesson_slug: f.slug,
      lesson_date: f.date,
      lesson_title: f.title,
      lesson_body: f.body,
      saved_usd: row ? Number(row.saved_usd) || 0 : 0,
    };
  });

  // Primary sort: saved_usd DESC. Secondary stable sort: lesson_slug
  // ASC, then lesson_date ASC. This makes the rotation deterministic
  // regardless of file order — operators get the same slot for the
  // same day.
  ranked.sort((a, b) => {
    if (b.saved_usd !== a.saved_usd) return b.saved_usd - a.saved_usd;
    if (a.lesson_slug !== b.lesson_slug) return a.lesson_slug < b.lesson_slug ? -1 : 1;
    return a.lesson_date < b.lesson_date ? -1 : (a.lesson_date > b.lesson_date ? 1 : 0);
  });

  // Savings-decile bias: top-decile lessons appear TWICE in the
  // rotation list so the modular indexing surfaces them ~2x as often.
  const threshold = topDecileThreshold(ranked.map((r) => r.saved_usd));
  const rotationList: RankedLesson[] = [];
  for (const r of ranked) {
    rotationList.push(r);
    if (Number.isFinite(threshold) && r.saved_usd >= threshold && r.saved_usd > 0) {
      rotationList.push(r);
    }
  }

  // Day index — UTC days since unix epoch. Stable per calendar day
  // regardless of local tz; rolls over at midnight UTC, which is the
  // cache boundary the route honours via Cache-Control: max-age=3600.
  const dayIndex = Math.floor(now.getTime() / 86_400_000);
  const slot = ((dayIndex % rotationList.length) + rotationList.length) % rotationList.length;
  const pick = rotationList[slot];

  return {
    lesson_slug: pick.lesson_slug,
    lesson_date: pick.lesson_date,
    lesson_title: pick.lesson_title,
    lesson_excerpt: buildExcerpt(pick.lesson_body),
    saved_usd: pick.saved_usd,
    total_lessons_indexed: flat.length,
    rotation_day_index: dayIndex,
  };
}

// Ticket 0057: public lesson archive.
//
// Pure helper that turns the parsed cross-fleet lessons file into the
// anonymised public-archive payload. The companion routes
// /lessons-public + /lessons-public/<slug> + /api/lessons-public live
// in src/server.ts; this helper is purely a data shape. Composes the
// existing parser via loadCrossLessons() — no new schema, no new
// ingest, no new shell-out.
//
// Per LESSONS § "in-process dedup sets need an explicit reset hook for
// tests" AND "expose a build counter for cache-hit tests, not a fetcher
// swap": the route-side memo cache plus its reset and build-counter
// seams live in src/server.ts where the route handler reads them. The
// helper itself is pure — every call re-derives the payload from
// loadCrossLessons() (which carries its own mtime memo inside the
// server module).
//
// Per LESSONS § "time-pinned tests must NOT derive seed timestamps
// from new Date()": the helper accepts opts.now so tests pin the
// generated_at deterministically.
//
// Per LESSONS § "no backticks inside template-literal SQL strings":
// this helper composes string substitutions, never SQL. The leading
// comment intentionally avoids any backticked identifiers so a sibling
// helper's character-window source-grep test (the lessonOfTheDay
// AC10 backtick guard slices 4000 chars from that helper's start)
// cannot pull SQL keywords out of this block by accident — per
// LESSONS 2026-06-11 "character-window source greps leak into sibling
// helpers".
//
// Anonymisation rules (one per AC1 bullet):
//   - replace any known operator project slug (from the operator's
//     actual project list) with a stable project-N alias, building
//     the alias map deterministically from the slugs that appear in
//     the lessons file in source order (this is the same shape as
//     src/snapshot.ts anonymize() per ticket 0013).
//   - replace any branch name matching (feat|chore|eng)/<rest> with
//     the literal placeholder <branch>.
//   - replace any absolute filesystem path under /Users/ or /home/
//     with <path>.
//   - replace any ticket-id reference ticket NNNN with the prose
//     phrase "an agent ticket".
//   - preserve every technical token: function names, error codes,
//     SQL snippets, type expressions, code idioms.

export interface LessonsPublicArchiveRow {
  /** URL-safe kebab-case slug derived from (lesson_date + lesson_title);
   *  guaranteed globally unique within one archive build (collisions
   *  get a "-2", "-3" suffix). */
  lesson_slug: string;
  lesson_date: string;
  lesson_title: string;
  lesson_body_anonymised: string;
  /** Per-lesson primary attribution alias. The literal "agent-fleet"
   *  for the bootstrap project (its slug is already the public name
   *  of the open-source kit); otherwise project-N where N is the
   *  deterministic 1-indexed position the slug first appears in the
   *  file. */
  project_alias: string;
}

export interface LessonsPublicArchive {
  generated_at: string;
  total_lessons: number;
  earliest_lesson_date: string;
  latest_lesson_date: string;
  lessons: LessonsPublicArchiveRow[];
}

export interface LessonsPublicArchiveOptions {
  /** Pin the generated_at. Defaults to new Date(). */
  now?: Date;
  /** Optional pre-built slug→alias map. The route hands this in from a
   *  project SELECT so operator-actual slugs (that may NOT appear in
   *  the lessons file body but DO appear in the file's H2 headers via
   *  a different casing) all collapse to the same alias. When omitted
   *  the helper builds the map from the file's H2 slugs in source
   *  order. */
  projectAliasMap?: Record<string, string>;
}

/** The bootstrap project slug — kept un-aliased on purpose: it IS the
 *  public name of the open-source kit (agent-fleet) so its lessons can
 *  be attributed without anonymisation. Every OTHER operator slug
 *  collapses to a project-N alias. */
const PUBLIC_BOOTSTRAP_SLUG = "agent-fleet";

/** Build a stable slug→alias map from the parsed lessons file. The
 *  bootstrap slug keeps its real name; every other slug becomes
 *  project-N where N is its 1-indexed appearance order. Callers can
 *  override individual entries (e.g. the route handler may pass a
 *  fuller alias map sourced from the operator's `project` table). */
function buildAliasMap(parsed: CrossLessonsLoadResult): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 1;
  for (const p of parsed.projects) {
    const slug = String(p.slug ?? "").trim();
    if (!slug) continue;
    if (slug === PUBLIC_BOOTSTRAP_SLUG) {
      out[slug] = PUBLIC_BOOTSTRAP_SLUG;
    } else {
      if (!(slug in out)) {
        out[slug] = "project-" + String(n);
        n += 1;
      }
    }
  }
  return out;
}

/** Escape regex special characters in a literal substring so we can
 *  build a global regex that strips it from a body. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Anonymise one lesson body string per the AC1 rules. The technical
 *  tokens (function names, type expressions, error codes) are NOT
 *  enumerated explicitly — they survive by NOT matching any of the
 *  anonymisation patterns. Operator-supplied identifiers are matched
 *  by structural shape (slug appears in alias map, branch matches the
 *  agent prefix, path starts with /Users/ or /home/, ticket follows
 *  the literal word "ticket"). */
function anonymiseLessonBody(body: string, aliasMap: Record<string, string>): string {
  let out = String(body ?? "");
  // 1. Operator slugs → alias. Order LONGEST-FIRST so a slug that's a
  //    prefix of another (e.g. "courtiq" vs "courtiq-prod") doesn't
  //    pre-empt the longer match.
  const slugs = Object.keys(aliasMap).slice().sort((a, b) => b.length - a.length);
  for (const slug of slugs) {
    if (!slug) continue;
    if (slug === PUBLIC_BOOTSTRAP_SLUG) continue; // keep the public name verbatim
    const alias = aliasMap[slug] ?? "project-?";
    // Use a bounded character class around the slug to avoid eating
    // adjacent identifier characters. Word-boundary alone is too
    // forgiving for slugs that carry hyphens.
    const re = new RegExp("(^|[^A-Za-z0-9_-])" + reEscape(slug) + "(?![A-Za-z0-9_-])", "g");
    out = out.replace(re, (_m, pre) => String(pre) + alias);
  }
  // 2. Branch names matching the agent prefixes → <branch>. Capture
  //    the leading prefix + a permissive identifier tail.
  out = out.replace(/\b(feat|chore|eng)\/[A-Za-z0-9/_.-]+/g, "<branch>");
  // 3. Absolute filesystem paths under /Users/ or /home/ → <path>.
  //    The path tail is permissive: anything up to whitespace or a
  //    sentence-terminating punctuation.
  out = out.replace(/\/(?:Users|home)\/[^\s,;)]+/g, "<path>");
  // 4. Ticket-id references "ticket NNNN" → "an agent ticket".
  out = out.replace(/\bticket\s+\d{3,5}\b/gi, "an agent ticket");
  return out;
}

/** Derive a URL-safe kebab-case slug from (lesson_date + lesson_title).
 *  Lowercase, ASCII-only, strips every character outside [a-z0-9-],
 *  collapses runs of "-" to a single hyphen, and trims leading/trailing
 *  hyphens. The caller is responsible for disambiguation via a seen-set. */
function slugifyLesson(date: string, title: string): string {
  const raw = String(date ?? "") + " " + String(title ?? "");
  let s = raw.toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, "-");
  s = s.replace(/-+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  if (!s) s = "lesson";
  return s;
}

/** Disambiguate a slug against a seen-set: if the candidate already
 *  exists, append "-2", "-3", … until we find a free slot. */
function uniqueSlug(seen: Set<string>, candidate: string): string {
  if (!seen.has(candidate)) return candidate;
  let n = 2;
  for (;;) {
    const cand = candidate + "-" + String(n);
    if (!seen.has(cand)) return cand;
    n += 1;
  }
}

/** Build the public-archive payload. Reads the lessons file via
 *  loadCrossLessons (which carries its own mtime guard internally), runs
 *  the anonymisation pass per row, derives a unique slug per row, and
 *  returns the documented shape. Undated lessons are dropped — the
 *  public archive is keyed off (date + title) and a missing date breaks
 *  both the URL slug AND the chronological sort. */
export function lessonsPublicArchive(
  opts: LessonsPublicArchiveOptions = {},
): LessonsPublicArchive {
  const now = opts.now ?? new Date();
  const lessonsPath = defaultLessonsPath();
  const parsed = loadCrossLessons(lessonsPath);
  const aliasMap = opts.projectAliasMap ?? buildAliasMap(parsed);

  const rows: LessonsPublicArchiveRow[] = [];
  const seenSlugs = new Set<string>();

  // Walk projects in source order so the alias map's 1-indexed
  // appearance assignment matches the bodies' anonymisation order.
  for (const p of parsed.projects) {
    const projectSlug = String(p.slug ?? "").trim();
    const alias = aliasMap[projectSlug] ?? (
      projectSlug === PUBLIC_BOOTSTRAP_SLUG
        ? PUBLIC_BOOTSTRAP_SLUG
        : ("project-" + String(Object.keys(aliasMap).length + 1))
    );
    for (const l of p.lessons) {
      if (!l.date) continue;
      const title = String(l.title ?? "").trim();
      const body = String(l.body ?? "");
      const cand = slugifyLesson(l.date, title);
      const slug = uniqueSlug(seenSlugs, cand);
      seenSlugs.add(slug);
      rows.push({
        lesson_slug: slug,
        lesson_date: l.date,
        lesson_title: title,
        lesson_body_anonymised: anonymiseLessonBody(body, aliasMap),
        project_alias: alias,
      });
    }
  }

  let earliest = "";
  let latest = "";
  for (const r of rows) {
    if (!earliest || r.lesson_date < earliest) earliest = r.lesson_date;
    if (!latest || r.lesson_date > latest) latest = r.lesson_date;
  }
  return {
    generated_at: now.toISOString(),
    total_lessons: rows.length,
    earliest_lesson_date: earliest,
    latest_lesson_date: latest,
    lessons: rows,
  };
}
