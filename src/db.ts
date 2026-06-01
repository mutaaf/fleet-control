// SQLite store (node:sqlite, WAL). Single-writer; readers never block.
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS project (
  id            INTEGER PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT,
  namespace     TEXT NOT NULL,
  repo_url      TEXT, repo_owner TEXT, repo_name TEXT,
  model         TEXT DEFAULT 'claude-opus-4-7',
  self_cancel   TEXT,
  eng_enabled   INTEGER DEFAULT 0,
  manifest_path TEXT,
  cadence_json  TEXT,
  first_seen_at TEXT, last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS project_alias (
  project_id INTEGER REFERENCES project(id),
  alias_slug TEXT PRIMARY KEY,
  kind       TEXT
);

CREATE TABLE IF NOT EXISTS agent (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES project(id),
  phase TEXT NOT NULL,
  launchd_label TEXT NOT NULL,
  UNIQUE(project_id, phase)
);

CREATE TABLE IF NOT EXISTS run (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES project(id),
  phase TEXT NOT NULL,
  session_id TEXT,
  started_at TEXT, ended_at TEXT,
  duration_ms INTEGER,
  exit_code INTEGER,
  num_turns INTEGER,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_creation_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cost_usd REAL,
  cost_usd_computed REAL,
  cost_source TEXT,
  model TEXT,
  summary TEXT,
  outcome TEXT,
  pr_number INTEGER,
  transcript_path TEXT, log_path TEXT,
  source TEXT,
  UNIQUE(project_id, phase, session_id)
);
CREATE INDEX IF NOT EXISTS run_proj_started ON run(project_id, started_at);

CREATE TABLE IF NOT EXISTS run_event (
  id INTEGER PRIMARY KEY,
  run_id INTEGER REFERENCES run(id) ON DELETE CASCADE,
  seq INTEGER, ts TEXT,
  kind TEXT, tool_name TEXT, tool_use_id TEXT,
  input_summary TEXT, output_summary TEXT, is_error INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS run_event_run ON run_event(run_id, seq);

CREATE TABLE IF NOT EXISTS cost_rollup_day (
  project_id INTEGER, phase TEXT, day TEXT,
  runs INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  cache_creation_tokens INTEGER, cache_read_tokens INTEGER, cost_usd REAL,
  PRIMARY KEY(project_id, phase, day)
);

CREATE TABLE IF NOT EXISTS pricing (
  model TEXT PRIMARY KEY,
  input_per_mtok REAL, output_per_mtok REAL,
  cache_write_per_mtok REAL, cache_read_per_mtok REAL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS ingested_file (
  path TEXT PRIMARY KEY,
  size INTEGER, mtime TEXT, complete INTEGER,
  run_id INTEGER, ingested_at TEXT
);

CREATE TABLE IF NOT EXISTS watermark (
  source TEXT PRIMARY KEY, cursor TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS pr (
  project_id INTEGER, number INTEGER, title TEXT, branch TEXT,
  state TEXT, ci_state TEXT, merge_state TEXT, is_agent INTEGER,
  additions INTEGER, deletions INTEGER, author TEXT, url TEXT, fetched_at TEXT,
  PRIMARY KEY(project_id, number)
);

CREATE TABLE IF NOT EXISTS control_audit (
  id INTEGER PRIMARY KEY, ts TEXT,
  actor TEXT, action TEXT, target TEXT, args_json TEXT,
  exit_code INTEGER, stdout_tail TEXT
);

CREATE TABLE IF NOT EXISTS alert (
  id INTEGER PRIMARY KEY, project_id INTEGER, phase TEXT,
  type TEXT, severity TEXT, title TEXT, detail TEXT,
  dedup_key TEXT UNIQUE, created_at TEXT, notified_at TEXT, resolved_at TEXT
);

-- Typed event stream ingested from ~/.cache/<slug>-agent/events.jsonl.
-- One row per JSONL line, deduped by a watermark byte-offset (see
-- src/ingest/events.ts). Named agent_event (not event) to avoid clashing
-- with the existing run_event table and to keep grep cleanly disambiguated.
CREATE TABLE IF NOT EXISTS agent_event (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL,
  ts           TEXT,
  phase        TEXT,
  type         TEXT,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS agent_event_slug_ts ON agent_event(slug, ts DESC);

-- Per-user scoped tokens (ticket 0003). Replaces the single shared admin
-- token. id is the SHA256 hex digest of the plaintext token — we never
-- store the plaintext itself. scope is one of read | control | admin with
-- a strict hierarchy (admin covers control covers read). Revocation is a
-- timestamp, not a row delete, so audit-log foreign keys stay live.
CREATE TABLE IF NOT EXISTS auth_token (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  scope         TEXT NOT NULL,
  created_at    TEXT,
  last_used_at  TEXT,
  revoked_at    TEXT
);

-- Anomaly flags (ticket 0008). One row per (run_id, kind) — the UNIQUE
-- constraint is also the idempotency guard: re-running flagRun() on a
-- run that already has a flag for that metric is a silent no-op. kind is
-- one of 'duration' or 'cost'. value is the candidate run's measured
-- figure (ms or USD); baseline_mean / baseline_stddev describe the
-- prior-14-day window the threshold was computed from; sample_count is
-- how many runs went into that window (must be >= 5 to fire).
-- candidate_reason is a deterministic heuristic string (no transcript
-- I/O) — see src/anomaly.ts for the rules.
CREATE TABLE IF NOT EXISTS anomaly (
  id               INTEGER PRIMARY KEY,
  run_id           INTEGER REFERENCES run(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  value            REAL,
  baseline_mean    REAL,
  baseline_stddev  REAL,
  sample_count     INTEGER,
  candidate_reason TEXT,
  created_at       TEXT,
  UNIQUE(run_id, kind)
);
CREATE INDEX IF NOT EXISTS anomaly_created_at ON anomaly(created_at DESC);

-- Shareable read-only snapshots (ticket 0013). id is the SHA-256 hex
-- digest of the secret share token — the plaintext token is never
-- stored, same pattern as auth_token. payload_json carries the
-- frozen anonymized fleet view. Revocation is a timestamp, not a row
-- delete, so an audit-trail of "this URL was killed at T" stays
-- queryable. Expiry is a separate timestamp the GET handler compares
-- against now() to choose 200 vs 410.
CREATE TABLE IF NOT EXISTS snapshot (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshot_created_at ON snapshot(created_at DESC);

-- Soft daily-budget autopause state (ticket 0021). One row per paused
-- project (PRIMARY KEY on project_id), so re-firing the guard the same
-- day is idempotent via INSERT OR REPLACE. reason is one of 'cost_cap'
-- (v1 — set by the autopause guard) or 'manual' (reserved for a future
-- ticket; v1 never writes this value). detail_json carries the figures
-- the operator wants to see: {spent_usd, cap_usd, day}.
CREATE TABLE IF NOT EXISTS project_pause (
  project_id    INTEGER PRIMARY KEY REFERENCES project(id),
  reason        TEXT NOT NULL,
  triggered_at  TEXT NOT NULL,
  triggered_by  TEXT NOT NULL,
  detail_json   TEXT
);

-- Today's inbox dismissals (ticket 0017). Purely additive: the inbox
-- helper unions four reads against existing tables (pr / anomaly /
-- snapshot / run) and then LEFT-JOINs this table to filter out items
-- the operator already dismissed. For pr_review and run_failed the
-- dismissal lives ONLY here — no UPDATE on the source row, so the
-- existing PR / run views stay byte-identical. For anomaly_open the
-- inbox prefers anomaly.dismissed_at on the source row (a future
-- column added by the ALTER below in openDb); the table still records
-- the dismissal for the audit-trail. PK is (kind, project_slug,
-- payload_id) so re-dismissing is a silent no-op.
CREATE TABLE IF NOT EXISTS inbox_dismissal (
  kind          TEXT NOT NULL,
  project_slug  TEXT NOT NULL,
  payload_id    TEXT NOT NULL,
  dismissed_at  TEXT NOT NULL,
  PRIMARY KEY (kind, project_slug, payload_id)
);

-- Backlog-ticket to merged-commit auto-link (ticket 0018). One row per
-- (project_slug, commit_sha, ticket_id) tuple. Populated by the daemon
-- hook in src/ingest/git_ticket_links.ts which shells out to git log
-- with a sinceRef..HEAD range plus --shortstat and parses each commit
-- subject for a 4-digit ticket id. Idempotent on re-insert (PK
-- collision = no duplicate row); pr_number is enriched at insert time
-- when the ticket id appears inside a known pr.branch. ALL identifiers
-- are quoted as plain words inside this SCHEMA template — per
-- LESSONS § no backticks inside template-literal SQL strings, a stray
-- backtick here would break node v25 type-stripping and the whole
-- module would fail to load.
CREATE TABLE IF NOT EXISTS ticket_commit_link (
  ticket_id       TEXT NOT NULL,
  project_slug    TEXT NOT NULL,
  commit_sha      TEXT NOT NULL,
  commit_date     TEXT NOT NULL,
  author          TEXT NOT NULL,
  message_subject TEXT NOT NULL,
  files_changed   INTEGER NOT NULL,
  insertions      INTEGER NOT NULL,
  deletions       INTEGER NOT NULL,
  pr_number       INTEGER,
  PRIMARY KEY (project_slug, commit_sha, ticket_id)
);
CREATE INDEX IF NOT EXISTS ticket_commit_link_ticket ON ticket_commit_link(ticket_id);

-- Phone-pairing one-shot tokens (ticket 0032). One row per minted pair
-- token; the QR-scan flow consumes the row, sets an x-fleet-token
-- cookie carrying the admin_token plaintext, and 302s to /. Single-
-- use enforced at the application layer (mint INSERTs, consume DELETEs);
-- 90-second TTL enforced via expires_at + a sweep on consume. Per
-- LESSONS § no backticks inside template-literal SQL strings, all
-- identifiers stay plain words inside this SCHEMA template.
CREATE TABLE IF NOT EXISTS pair_token (
  token        TEXT PRIMARY KEY,
  admin_token  TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pair_token_expires ON pair_token(expires_at);
`;

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  // ALTERs for older DBs (CREATE TABLE IF NOT EXISTS won't add columns to an
  // already-existing table). Each ALTER is wrapped — duplicate column is fine.
  for (const ddl of [
    "ALTER TABLE run ADD COLUMN usage_limit_at TEXT",
    "ALTER TABLE run ADD COLUMN usage_limit_until TEXT",
    "ALTER TABLE alert ADD COLUMN auto_resolve INTEGER DEFAULT 1",
    // ticket 0003: control_audit now records WHO (by token name), not just
    // an opaque "local"/"lan" actor. Back-fill is implicit — pre-existing
    // rows show actor_name=NULL which the views surface as "admin (legacy)".
    "ALTER TABLE control_audit ADD COLUMN actor_name TEXT",
    // ticket 0004: pricing rows now carry the wall-clock of the last
    // successful sync. Older DBs that lived through the hardcoded-pricing
    // era pick up the column on next open; the value stays NULL until
    // the first syncPricing() call stamps it.
    "ALTER TABLE pricing ADD COLUMN fetched_at TEXT",
    // ticket 0017: today's inbox marks anomalies dismissed in-place
    // (the spec says "for anomaly_open this sets dismissed_at on the
    // anomaly row"). Older DBs predate this column; the inbox helper
    // tolerates a NULL value the same way it tolerates a missing
    // inbox_dismissal row.
    "ALTER TABLE anomaly ADD COLUMN dismissed_at TEXT",
    // ticket 0022: PR rows snapshot GitHub's `createdAt` field on each
    // ingest pass so the `pr_age` health sub-score can derive a real
    // age (hours since open) without re-querying gh per render. The
    // value is NULL for rows ingested before this column existed; the
    // health helper treats NULL the same as "no open agent PR" (sub
    // score = 100) so older DBs render healthy until the next ingest
    // tick repopulates the column.
    "ALTER TABLE pr ADD COLUMN gh_created_at TEXT",
    // ticket 0027: cross-project failure correlation. The first
    // failing check name (e.g. "typecheck") is the lookup key the
    // ingest pass uses to call `gh run view --log-failed`; the
    // resulting first 200 chars of the log become first_fail_excerpt.
    // Both default NULL on legacy rows so the correlation detector
    // simply skips them (signature derivation requires an excerpt).
    // Why the column lives on `pr` and not a side table: every
    // existing PR-card render path already SELECTs from pr; carrying
    // these two columns inline keeps the cross-join overhead the
    // detector pays at one table.
    "ALTER TABLE pr ADD COLUMN first_fail_check TEXT",
    "ALTER TABLE pr ADD COLUMN first_fail_excerpt TEXT",
    // ticket 0023: heal-attempts count surfaced inline on each PR
    // card so the operator can see "heal 2/2" without remembering to
    // grep the commit log. Populated by ingestProjectPRs from gh's
    // `commits` payload (counted via countHealCommits — only the
    // first line of each commit's messageHeadline is inspected, and
    // only a case-insensitive `heal:` prefix at column zero counts).
    // Default 0 keeps legacy rows (and any PR with zero heal commits)
    // safely numeric for the SPA's `pr.heal_attempts > 0` chip-render
    // guard — a NULL would render the chip on every legacy row. Per
    // LESSONS § no backticks inside template-literal SQL strings, the
    // identifier stays plain (no quoting needed for a single word).
    "ALTER TABLE pr ADD COLUMN heal_attempts INTEGER DEFAULT 0",
    // ticket 0027: the anomaly table grows one new column for
    // correlation tagging. The existing `kind` column (NOT NULL since
    // 0008) is reused for the new 'fleet_correlated' value — adding
    // a parallel default-bearing column would split the kind-space
    // across two fields and complicate every existing
    // SELECT a.kind read in src/inbox.ts and src/anomaly.ts. Legacy
    // rows keep their original kind ('duration' / 'cost'); new
    // correlation rows carry kind='fleet_correlated' AND
    // correlation_signature='TS2304' (or similar). The detector's
    // dedup key is correlation_signature alone, so the union with
    // the legacy kind-space is harmless.
    "ALTER TABLE anomaly ADD COLUMN correlation_signature TEXT",
  ]) { try { db.exec(ddl); } catch { /* already there */ } }
  // Ticket 0027: a regular (non-unique) index on
  // (correlation_signature, created_at) makes the daemon hook's
  // "is there already a live row for this signature?" lookup O(log
  // n) without locking out the legitimate re-fire path. We DON'T add
  // a hard UNIQUE constraint because correlations re-fire after a
  // dismissal once a NEW occurrence is detected outside the
  // dismissed window — the application-level guard in
  // runCorrelationHook() owns idempotency within the 24h window.
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS anomaly_correlation_sig_ts "
      + "ON anomaly(correlation_signature, created_at DESC) "
      + "WHERE kind = 'fleet_correlated'",
    );
  } catch { /* index exists or older sqlite */ }
  return db;
}
