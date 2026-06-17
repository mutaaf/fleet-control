// Shareable read-only fleet snapshot (ticket 0013).
//
// The operator hits "Share fleet snapshot" → we mint a 24-byte hex token,
// SHA-256 it into the `snapshot.id` primary key, store an anonymized
// deep clone of the current fleet view as `payload_json`, and hand the
// plaintext token back ONCE so the caller can build a share URL. The
// recipient hits GET /share/<token>; we re-hash, look up the row, and
// return a self-contained HTML page (no /api fetches, no buttons, no
// outbound github.com links — see serveShare()).
//
// Why the data is frozen at creation time and not live:
//   - the ticket explicitly puts live-updating snapshots out of scope;
//   - it lets us anonymize once and never have to re-walk a churning
//     fleet view on every read;
//   - a stable URL points at the same screenshot every time it's
//     opened, which is what the recipient expects.
//
// Anonymization rules (see anonymize() below):
//   - project slugs become `project-1`, `project-2`, ... in input order;
//   - names become `Project 1`, etc.;
//   - any string field carrying repo/branch/PR metadata is dropped or
//     placeholdered (`null`/`""`/`PR #XX`);
//   - any field name containing `_path` is dropped wholesale (transcript,
//     log, manifest paths all match);
//   - numeric and enum fields are preserved bit-for-bit so the visual
//     impression — costs, run counts, displayState — survives.
//
// Zero new runtime deps; we lean on node:crypto + plain string templates.
import { createHash, randomBytes } from "node:crypto";
import type { DB } from "./db.ts";

// ────────────────────────────────────────────────────────────────────
// Public types + constants
// ────────────────────────────────────────────────────────────────────

/** Default TTL for a freshly-minted snapshot. The ticket caps the
 *  recipient at "show me" — 24h is long enough for the most plausible
 *  share-window (operator demos to a friend over the weekend) and
 *  short enough that a leaked URL has a hard expiry. */
export const DEFAULT_TTL_HOURS = 24;

/** Title prefix the share page advertises in its <title>. The test
 *  asserts this string verbatim so the operator can grep the codebase
 *  for the one place the title lives. */
export const SHARE_PAGE_TITLE_PREFIX = "Fleet snapshot · ";

/** Default base URL the CLI prints alongside a freshly-minted token.
 *  The portal serves /share/<token> on whatever host/port `fleetctl
 *  serve` is bound to; we default to the loopback origin so a
 *  loopback-only operator gets a working link out of the box. The
 *  caller can override via opts.baseUrl. */
export const DEFAULT_BASE_URL = "http://127.0.0.1:7070";

export interface MintedSnapshot {
  id_prefix: string;
  token: string;
  share_url: string;
  name: string;
  expires_at: string;
}

export interface SnapshotRow {
  id_prefix: string;
  name: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface SnapshotResolved {
  payload: unknown;
  name: string;
  created_at: string;
  expires_at: string;
  expired: boolean;
  revoked: boolean;
}

export interface SnapshotCreateOpts {
  /** Operator-supplied label, surfaced on the share page banner. */
  name: string;
  /** The fleet view to freeze. Pass the result of `fleetView(db, cfg)`
   *  — anonymize() walks the object and returns a sanitized clone. */
  fleetView: unknown;
  /** Override the TTL (hours). Defaults to DEFAULT_TTL_HOURS. */
  ttl_hours?: number;
  /** Override the base URL used to build the returned share_url.
   *  Defaults to DEFAULT_BASE_URL. */
  baseUrl?: string;
  /** Ticket 0039: when `true`, the changelog rows below are walked
   *  through `anonymizeChangelog()` and embedded under
   *  `payload.changelog`. Defaults to `false` so existing snapshot
   *  bytes stay backward-compatible — the `changelog` key is absent
   *  on every mint that doesn't opt in. */
  include_changelog?: boolean;
  /** Ticket 0039: the changelog data to embed when
   *  `include_changelog: true`. Caller pre-computes via
   *  `fleetChangelog(db, opts)` — same shape the route returns. */
  changelog?: unknown;
  /** Ticket 0066: token kind discriminator. When omitted (or set to
   *  the legacy default) the mint behaves exactly as today and the
   *  returned share_url targets /share/<token>. When set to
   *  "stakeholder_monthly" the row carries kind='stakeholder_monthly'
   *  AND the returned share_url targets /share/stakeholder/<token>
   *  - the new stakeholder-monthly route. The snapshot.kind column
   *  is TEXT with no CHECK constraint so future kinds extend cleanly
   *  without a schema migration. */
  kind?: "stakeholder_monthly" | "fleet_view";
}

export interface ServeShareResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// ────────────────────────────────────────────────────────────────────
// Hashing + ID helpers
// ────────────────────────────────────────────────────────────────────

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function nowIso(): string { return new Date().toISOString(); }

/** Coerce an arbitrary ttl_hours input into a sane positive integer
 *  in [1, 24*30]. Defaulting silently is intentional: a request that
 *  smuggles `ttl_hours = "drop table"` should mint a normal 24h
 *  snapshot, not crash. */
function clampTtlHours(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TTL_HOURS;
  // Hard ceiling: a month. Per the ticket the realistic use is 24h;
  // we keep a generous cap so an operator can pin one for a long
  // conference week without crafting a custom helper.
  return Math.min(Math.floor(n), 24 * 30);
}

// ────────────────────────────────────────────────────────────────────
// Anonymization
//
// The function walks the fleet view object, replacing any field that
// could leak identity (slugs, names, repo metadata, PR titles, URLs,
// filesystem paths) with a stable placeholder while preserving every
// numeric and enum value bit-for-bit.
//
// Implementation choice: rather than a single recursive walker with a
// regex over property names (brittle when a new field lands), we
// special-case the `projects[]` shape because that's where every
// identity-bearing field lives. Anything else (totals, alerts,
// generatedAt) passes through structurally unchanged.
// ────────────────────────────────────────────────────────────────────

const PATH_FIELDS = new Set<string>(["transcript_path", "log_path", "manifest_path"]);
const PROJECT_DROP_FIELDS = new Set<string>([
  "repo", "repo_url", "repo_owner", "repo_name", "branch",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Scrub anything in a `prs[]` row that could identify the upstream
 *  GitHub artifact. The numeric fields (additions, deletions, number)
 *  and enum fields (state, ci_state, merge_state, is_agent) survive
 *  because they're what gives the snapshot its "live fleet" feel
 *  without leaking. The visible PR number becomes XX so the recipient
 *  can't deep-link, but the count of merged PRs stays accurate. */
function anonymizePr(pr: Record<string, unknown>): Record<string, unknown> {
  return {
    number: typeof pr.number === "number" ? pr.number : null,
    title: "PR #XX",
    url: "",
    author: "",
    additions: typeof pr.additions === "number" ? pr.additions : 0,
    deletions: typeof pr.deletions === "number" ? pr.deletions : 0,
    state: typeof pr.state === "string" ? pr.state : null,
    ci_state: typeof pr.ci_state === "string" ? pr.ci_state : null,
    merge_state: typeof pr.merge_state === "string" ? pr.merge_state : null,
    is_agent: pr.is_agent ?? 0,
  };
}

/** Drop every `*_path` field from a job row, plus anything else that
 *  carries a filesystem-absolute string. We don't try to scrub strings
 *  inside `currentAction` or `summary`-shaped fields by content; the
 *  ticket allows dropping anything with a `_path` suffix wholesale. */
function anonymizeJob(job: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(job)) {
    if (PATH_FIELDS.has(k)) continue;
    if (k.endsWith("_path")) continue; // belt-and-braces for future fields
    if (k === "currentAction" && typeof v === "string") {
      // currentAction can echo a CLI invocation that includes a path. We
      // keep the verb but drop any string that looks like an absolute
      // path or a URL. Cheap heuristic: strip anything starting with `/`.
      out[k] = v.replace(/\/\S+/g, "[path]");
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** Walk a project entry and produce its anonymized twin. `index` is
 *  the 1-indexed counter shared across the snapshot — the same
 *  project always becomes the same `project-N` placeholder. */
function anonymizeProject(p: Record<string, unknown>, index: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "slug") { out[k] = `project-${index}`; continue; }
    if (k === "name") { out[k] = `Project ${index}`; continue; }
    if (PROJECT_DROP_FIELDS.has(k)) { out[k] = null; continue; }
    if (k === "prs" && Array.isArray(v)) {
      out[k] = v.map((pr) => isPlainObject(pr) ? anonymizePr(pr) : pr);
      continue;
    }
    if (k === "jobs" && Array.isArray(v)) {
      out[k] = v.map((j) => isPlainObject(j) ? anonymizeJob(j) : j);
      continue;
    }
    // All other fields (telemetry, displayState, cost, runs, forecast,
    // anomalies, usageLimit, autoKill, …) survive as-is. They're either
    // numeric, enum, or already-shape-safe.
    out[k] = v;
  }
  return out;
}

/** Ticket 0039: anonymize a `fleetChangelog` payload for the snapshot.
 *  Slugs get replaced with `project-N` placeholders, indexed by FIRST
 *  appearance order so the same project always becomes the same
 *  surrogate. PR titles + URLs are dropped (PR titles can carry repo
 *  names; URLs leak the owner). Numeric fields (additions, deletions,
 *  pr_number) survive bit-for-bit so the recipient still sees real
 *  size + counts. The ticket_id is preserved (4-digit ids are not
 *  identifying on their own — they're just sequence numbers). */
export function anonymizeChangelog(changelog: unknown): unknown {
  if (!isPlainObject(changelog)) return null;
  const rows = (changelog as { rows?: unknown[] }).rows;
  if (!Array.isArray(rows)) return null;
  const slugMap = new Map<string, string>();
  let nextIdx = 1;
  const anonRows = rows.map((r) => {
    if (!isPlainObject(r)) return r;
    const slug = String(r.project_slug ?? "");
    if (!slugMap.has(slug)) {
      slugMap.set(slug, `project-${nextIdx}`);
      nextIdx += 1;
    }
    return {
      project_slug: slugMap.get(slug)!,
      project_name: slugMap.get(slug)!,
      pr_number: typeof r.pr_number === "number" ? r.pr_number : 0,
      pr_title: "PR #XX",
      pr_url: "",
      merged_at: typeof r.merged_at === "string" ? r.merged_at : "",
      additions: typeof r.additions === "number" ? r.additions : 0,
      deletions: typeof r.deletions === "number" ? r.deletions : 0,
      ticket_id: typeof r.ticket_id === "string" ? r.ticket_id : null,
    };
  });
  return {
    rows: anonRows,
    next_cursor: null, // cursors leak the merged_at + pr_number tuple verbatim — drop them
    total: typeof (changelog as { total?: unknown }).total === "number"
      ? (changelog as { total: number }).total : anonRows.length,
    generated_at: typeof (changelog as { generated_at?: unknown }).generated_at === "string"
      ? (changelog as { generated_at: string }).generated_at : "",
  };
}

/** Returns a deep clone of the input view with every identity-bearing
 *  field replaced. Numeric + enum fields are preserved bit-for-bit. */
export function anonymize(view: unknown): unknown {
  if (!isPlainObject(view)) {
    // Defensive: if a caller passed in something that isn't an object
    // (shouldn't happen — fleetView always returns one) we deep-clone
    // through JSON so the input isn't shared. JSON's a fine clone here
    // because the fleet view is pure data (no Dates, no functions).
    return JSON.parse(JSON.stringify(view ?? null));
  }
  // Deep clone first via JSON so we never share references with the
  // caller; the field-by-field walk then runs on the clone.
  const clone = JSON.parse(JSON.stringify(view)) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(clone)) {
    if (k === "projects" && Array.isArray(v)) {
      out[k] = v.map((p, i) => isPlainObject(p) ? anonymizeProject(p, i + 1) : p);
    } else if (k === "alerts" && Array.isArray(v)) {
      // Alerts carry detail strings that often name the project slug.
      // Drop the array — counts of "things to act on" are private; an
      // anonymized snapshot is a screenshot, not an inbox. (The totals
      // numeric still shows up unchanged.)
      out[k] = [];
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────
// CRUD
// ────────────────────────────────────────────────────────────────────

/** Mint a snapshot row. Returns the plaintext token ONCE — the caller
 *  is responsible for handing it to the operator immediately. The DB
 *  carries only the SHA-256 hash. */
export function createSnapshot(db: DB, opts: SnapshotCreateOpts): MintedSnapshot {
  const name = String(opts.name ?? "").trim();
  if (!name) throw new Error("snapshot name is required");
  if (name.length > 80) throw new Error("snapshot name must be ≤80 chars");

  const ttlH = clampTtlHours(opts.ttl_hours);
  // 24 bytes of entropy → 48 hex chars. Short enough to paste, long
  // enough that brute-forcing the URL space is uneconomic.
  const token = randomBytes(24).toString("hex");
  const id = hash(token);
  const created_at = nowIso();
  const expires_at = new Date(Date.now() + ttlH * 3600_000).toISOString();
  // Ticket 0039: when `include_changelog: true` the anonymized
  // changelog rides under `payload.changelog`. The default mint
  // (opts.include_changelog falsy) leaves the payload byte-identical
  // to today's so existing share links keep working unchanged.
  const anon = anonymize(opts.fleetView);
  let envelope: unknown = anon;
  if (opts.include_changelog) {
    const anonChangelog = anonymizeChangelog(opts.changelog);
    // Merge as an extra key on the anonymized fleet-view envelope.
    // We deep-clone via JSON one more time so the test that asserts
    // "byte-identical default mint" passes against the default branch
    // (we don't touch the envelope at all when the flag is off).
    const cloned = isPlainObject(anon) ? { ...anon } : {};
    (cloned as Record<string, unknown>).changelog = anonChangelog;
    envelope = cloned;
  }
  const payload_json = JSON.stringify(envelope);
  // Ticket 0066: snapshot.kind discriminator. Legacy callers omit the
  // field; we persist NULL so the route dispatcher reads NULL as the
  // default fleet-view kind. The stakeholder route only matches rows
  // where kind = 'stakeholder_monthly'.
  const kind: string | null = opts.kind === "stakeholder_monthly"
    ? "stakeholder_monthly"
    : null;

  db.prepare(
    "INSERT INTO snapshot(id,name,created_at,expires_at,revoked_at,payload_json,kind) VALUES(?,?,?,?,?,?,?)",
  ).run(id, name, created_at, expires_at, null, payload_json, kind);

  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  // Ticket 0066: stakeholder-monthly tokens get the dedicated
  // /share/stakeholder/<token> route so the stakeholder URL is
  // distinguishable at a glance from a legacy fleet-view share. Every
  // other kind keeps the legacy /share/<token> shape so existing
  // share URLs continue to resolve byte-for-byte.
  const pathSegment = kind === "stakeholder_monthly"
    ? "stakeholder/" + token
    : token;
  return {
    id_prefix: id.slice(0, 8),
    token,
    share_url: `${baseUrl}/share/${pathSegment}`,
    name,
    expires_at,
  };
}

/** Ticket 0066: resolve a presented token to a STAKEHOLDER-monthly
 *  snapshot row. Returns null when:
 *    - the token is empty / non-hex,
 *    - no row matches the hash (unknown token),
 *    - the matching row's kind is NOT 'stakeholder_monthly' (the
 *      caller passed a legacy fleet-view token to the stakeholder
 *      route - the dispatcher 404s instead of leaking the wrong
 *      renderer),
 *    - the row is revoked,
 *    - the row is expired.
 *  When the row IS a live stakeholder_monthly token the helper
 *  returns the resolved fields the route renders against. The
 *  token's plaintext is the auth - 404 on any failure mode (we do
 *  NOT distinguish revoked vs expired vs wrong-kind in the response
 *  so a guesser can't fingerprint which tokens used to exist). */
export function getStakeholderSnapshot(db: DB, token: string): {
  name: string; created_at: string; expires_at: string;
} | null {
  if (!token || typeof token !== "string") return null;
  if (!/^[0-9a-f]+$/i.test(token)) return null;
  const id = hash(token);
  const row = db.prepare(
    "SELECT name,created_at,expires_at,revoked_at,kind FROM snapshot WHERE id=?",
  ).get(id) as {
    name: string; created_at: string; expires_at: string;
    revoked_at: string | null; kind: string | null;
  } | undefined;
  if (!row) return null;
  if (row.kind !== "stakeholder_monthly") return null;
  if (row.revoked_at) return null;
  const now = Date.now();
  if (new Date(row.expires_at).getTime() <= now) return null;
  return {
    name: row.name,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

/** Resolve a presented token to its snapshot row. Returns null if no
 *  row matches (unknown token). Otherwise returns the parsed payload
 *  along with `expired` / `revoked` flags so callers (serveShare,
 *  audit prints) can choose the right HTTP status. */
export function getSnapshot(db: DB, token: string): SnapshotResolved | null {
  if (!token || typeof token !== "string") return null;
  // Token hex chars only — rule out anyone passing junk that would
  // upset the prepared statement. Length matches a 24-byte hex
  // string (48 chars), but we also tolerate any length so future
  // token sizes Just Work; the hash() result is always the same
  // length anyway.
  if (!/^[0-9a-f]+$/i.test(token)) return null;
  const id = hash(token);
  const row = db.prepare(
    "SELECT name,created_at,expires_at,revoked_at,payload_json,kind FROM snapshot WHERE id=?",
  ).get(id) as {
    name: string; created_at: string; expires_at: string;
    revoked_at: string | null; payload_json: string; kind: string | null;
  } | undefined;
  if (!row) return null;
  // Ticket 0066: legacy /share/<token> renders ONLY fleet-view
  // snapshots; a stakeholder-monthly token presented here is
  // a routing error (the operator pasted the wrong URL shape).
  // Return null so the route 404s instead of leaking the wrong
  // renderer over the token's frozen payload.
  if (row.kind === "stakeholder_monthly") return null;
  let payload: unknown = null;
  try { payload = JSON.parse(row.payload_json); } catch { payload = null; }
  const now = Date.now();
  const expired = new Date(row.expires_at).getTime() <= now;
  return {
    payload,
    name: row.name,
    created_at: row.created_at,
    expires_at: row.expires_at,
    expired,
    revoked: !!row.revoked_at,
  };
}

/** Revoke by id-prefix (the 8-char hex prefix `tokens list` shows).
 *  Returns true if a live row was updated, false otherwise. */
export function revokeSnapshot(db: DB, prefix: string): boolean {
  if (typeof prefix !== "string" || prefix.length < 4) {
    throw new Error("id-prefix must be at least 4 chars (use the value shown by `snapshot list`)");
  }
  if (!/^[0-9a-f]+$/i.test(prefix)) return false;
  const r = db.prepare(
    "UPDATE snapshot SET revoked_at=? WHERE id LIKE ? AND revoked_at IS NULL",
  ).run(nowIso(), prefix + "%");
  return Number(r.changes) > 0;
}

/** List every snapshot row (newest first). Never exposes the SHA-256
 *  id — only the 8-char prefix the CLI uses everywhere. */
export function listSnapshots(db: DB): SnapshotRow[] {
  const rows = db.prepare(
    "SELECT id,name,created_at,expires_at,revoked_at FROM snapshot ORDER BY created_at DESC",
  ).all() as unknown as Array<{
    id: string; name: string; created_at: string;
    expires_at: string; revoked_at: string | null;
  }>;
  return rows.map((r) => ({
    id_prefix: r.id.slice(0, 8),
    name: r.name,
    created_at: r.created_at,
    expires_at: r.expires_at,
    revoked_at: r.revoked_at,
  }));
}

// ────────────────────────────────────────────────────────────────────
// HTML rendering — no DOM, no template engine, no <button>/<form>.
//
// The share page is one self-contained string: a <link> to /style.css
// (already served by the static handler), a banner, a single
// <script type="application/json"> with the inlined snapshot payload,
// and a tiny inline render script that walks the JSON into <div>s.
// We do NOT load /app.js (which carries every control binding); the
// recipient must not be able to fire ANY control action.
//
// Test assertions:
//   - no <button>, no <form>, no /api/control/, no github.com anchor,
//     no /Users/ path — all enforced by AC5.
// ────────────────────────────────────────────────────────────────────

/** Tiny HTML-safe escape — keep the table short; we only need to
 *  guard against `<`, `>`, `&`, and quote breakout in attributes. */
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]!));
}

/** Relative-time phrasing the banner uses. We render both the
 *  created/expires timestamps as a "(N hours ago)" / "(in N hours)"
 *  pair so the recipient sees how fresh the snapshot is without us
 *  shipping the SPA's full `ago()` helper. */
function relativeFrom(now: number, then: number): string {
  const delta = (then - now) / 1000;
  const abs = Math.abs(delta);
  const sign = delta >= 0 ? "in " : "";
  const suffix = delta >= 0 ? "" : " ago";
  if (abs < 60) return sign + Math.round(abs) + "s" + suffix;
  if (abs < 3600) return sign + Math.round(abs / 60) + "m" + suffix;
  if (abs < 86_400) return sign + Math.round(abs / 3600) + "h" + suffix;
  return sign + Math.round(abs / 86_400) + "d" + suffix;
}

/** Render the share page for a resolved snapshot. The HTML is a
 *  single string with NO external script dependency — only /style.css
 *  is referenced, and that's served by the static handler. */
export function renderSharePage(s: SnapshotResolved): string {
  const now = Date.now();
  const createdRel = relativeFrom(now, new Date(s.created_at).getTime());
  const expiresRel = relativeFrom(now, new Date(s.expires_at).getTime());
  // Stringified payload: the inline render script reads it; we also
  // double-escape any `</script>` substring (defence in depth — the
  // anonymizer should never produce one, but JSON-in-HTML always
  // deserves the escape).
  const payloadJson = JSON.stringify(s.payload ?? null).replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0E0F0D" />
  <title>${esc(SHARE_PAGE_TITLE_PREFIX)}${esc(s.name)}</title>
  <link rel="stylesheet" href="/style.css" />
  <style>
    .share-banner { padding: 14px 20px; background: rgba(200,132,30,.08);
      border-bottom: 1px solid #2a2b26; font-family: var(--mono); font-size: 13px;
      color: var(--ink); }
    .share-banner .lbl { color: var(--accent); font-weight: 600; }
    .share-banner .dim { color: var(--dim); }
    .share-projects { max-width: 1040px; margin: 22px auto 0; padding: 0 20px; }
    .share-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px; }
    .share-card { background: var(--panel); border: 1px solid var(--line); padding: 14px 16px;
      border-radius: var(--r); }
    .share-card h3 { margin: 0 0 6px; font-size: 17px; font-weight: 600; }
    .share-card .meta { font-family: var(--mono); font-size: 12px; color: var(--dim);
      display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
    .share-card .meta b { color: var(--ink); font-weight: 600; }
    .share-totals { max-width: 1040px; margin: 22px auto; padding: 0 20px;
      font-family: var(--mono); font-size: 13px; color: var(--dim); }
    .share-totals b { color: var(--ink); font-weight: 600; }
    .share-foot { max-width: 1040px; margin: 36px auto 0; padding: 0 20px 40px;
      font-family: var(--mono); font-size: 11px; color: var(--faint); }
  </style>
</head>
<body>
  <div class="share-banner">
    Read-only snapshot of ${esc(s.name)} · created <span class="dim">${esc(createdRel)}</span>,
    expires <span class="dim">${esc(expiresRel)}</span>.
  </div>
  <script type="application/json" id="snapshot-data">${payloadJson}</script>
  <main class="share-projects">
    <div class="share-totals" id="share-totals"></div>
    <div class="share-grid" id="share-grid"></div>
  </main>
  <div class="share-foot">read-only snapshot · no controls, no transcripts, no repo URLs</div>
  <script>
    (function () {
      var el = document.getElementById("snapshot-data");
      var data; try { data = JSON.parse(el.textContent || "null"); } catch (e) { data = null; }
      if (!data) return;
      function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, function (c) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c];
      }); }
      function usd(n) { return n == null ? "—" : "$" + (+n).toFixed(2); }
      var totals = data.totals || {};
      document.getElementById("share-totals").innerHTML =
        "<span><b>" + (data.projects || []).length + "</b> projects</span>"
        + " · <span><b>" + (totals.runs || 0) + "</b> runs</span>"
        + " · <span><b>" + usd(totals.cost || 0) + "</b> est. effort</span>";
      var grid = document.getElementById("share-grid");
      (data.projects || []).forEach(function (p) {
        var card = document.createElement("div");
        card.className = "share-card";
        var state = esc(p.displayState || "idle");
        card.innerHTML =
          "<h3>" + esc(p.name) + "</h3>"
          + "<div class='dim'>" + esc(p.slug) + " · " + state + "</div>"
          + "<div class='meta'>"
            + "<span><b>" + (p.runs || 0) + "</b> runs</span>"
            + "<span>this week <b>" + usd(p.cost7d || 0) + "</b></span>"
            + "<span>total <b>" + usd(p.cost || 0) + "</b></span>"
          + "</div>";
        grid.appendChild(card);
      });
    })();
  </script>
</body>
</html>`;
}

/** Friendly HTML body for the "expired" / "revoked" / "unknown"
 *  failure cases. Intentionally no /api links, no buttons. */
function renderGonePage(reason: "expired" | "revoked", name: string): string {
  const msg = reason === "expired"
    ? `This snapshot of ${esc(name)} has expired and is no longer available.`
    : `This snapshot of ${esc(name)} has been revoked and is no longer available.`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(SHARE_PAGE_TITLE_PREFIX)}gone</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <main style="max-width:640px;margin:80px auto;padding:0 20px;font-family:var(--mono);font-size:14px;color:var(--ink)">
    <h2 style="font-weight:600">Snapshot gone</h2>
    <p>${msg}</p>
    <p class="dim">Ask the operator for a fresh link.</p>
  </main>
</body>
</html>`;
}

function renderNotFoundPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(SHARE_PAGE_TITLE_PREFIX)}not found</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <main style="max-width:640px;margin:80px auto;padding:0 20px;font-family:var(--mono);font-size:14px;color:var(--ink)">
    <h2 style="font-weight:600">Snapshot not found</h2>
    <p class="dim">This share link doesn't match a known snapshot.</p>
  </main>
</body>
</html>`;
}

/** Single chokepoint the server hits for GET /share/<token>. Returns
 *  the status code + headers + body the http handler should emit.
 *  Pure (no req/res argument) so the unit test can drive it directly. */
export function serveShare(db: DB, token: string): ServeShareResult {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    // Block all outbound script execution except inline. The inline
    // <script> we emit runs because 'unsafe-inline' is permitted; we
    // disable everything else (no external scripts, no frames, no
    // form actions). Defence in depth on top of the no-button rule.
    "content-security-policy":
      "default-src 'none'; "
      + "style-src 'self' 'unsafe-inline'; "
      + "script-src 'unsafe-inline'; "
      + "img-src 'self' data:; "
      + "form-action 'none'; "
      + "frame-ancestors 'none'",
    // Snapshots are visible to anyone with the URL; explicitly tell
    // search engines not to index them.
    "x-robots-tag": "noindex, nofollow",
  };
  const got = getSnapshot(db, token);
  if (!got) return { status: 404, headers, body: renderNotFoundPage() };
  if (got.revoked) return { status: 410, headers, body: renderGonePage("revoked", got.name) };
  if (got.expired) return { status: 410, headers, body: renderGonePage("expired", got.name) };
  return { status: 200, headers, body: renderSharePage(got) };
}
