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
  ]) { try { db.exec(ddl); } catch { /* already there */ } }
  return db;
}
