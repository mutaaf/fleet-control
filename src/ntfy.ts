// ntfy.sh push-notification dispatch (ticket 0009). Zero runtime deps —
// uses `node:https` directly. Two ways to call:
//   1. sendNtfy(topic, payload) — low-level POST helper; returns
//      {ok, status, error?} and NEVER throws (transport failure is a
//      best-effort log, not a daemon crash).
//   2. ntfyForAlert / ntfyForAnomaly — higher-level dispatchers that map
//      severity → priority, build the click URL from portalUrl + slug, and
//      dedup per (dedup_key) for alerts / (run_id, kind) for anomalies so
//      a repeated insert at the rule-engine layer doesn't re-buzz the
//      operator's phone.
//
// Testability: rather than monkey-patch the global `node:https` module
// (lesson 2026-05-26 "don't fake a lazy require" — and globals are
// shared state across tests), we expose `setHttpsRequest(factory)` to
// inject the request constructor. Tests call setHttpsRequest with a fake
// that records calls; production callers don't touch this and the
// default factory wraps `https.request`.
import { request as httpsRequest } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { DB } from "./db.ts";
import type { FleetConfig } from "./config.ts";
import { isQuietNow } from "./quiet_hours.ts";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ────────────────────────────────────────────────────────────────────────
// Injectable transport — tests stub this; production wraps node:https.
// ────────────────────────────────────────────────────────────────────────

export interface HttpsLikeInit {
  method?: string;
  headers?: Record<string, string>;
}

/** Signature compatible with `https.request(url, options, callback)` — the
 *  three pieces sendNtfy actually consumes. We accept a URL string (not a
 *  URL object) to keep the test surface tiny. */
export type HttpsLikeRequest = (
  url: string,
  init: HttpsLikeInit,
  callback: (res: IncomingMessage) => void,
) => ClientRequest;

const defaultHttpsRequest: HttpsLikeRequest = (url, init, cb) => {
  // The real node:https surface accepts (url, options, cb). Options'
  // shape on the Node side aligns with HttpsLikeInit (method + headers).
  return httpsRequest(url, init as any, cb);
};

let httpsFactory: HttpsLikeRequest = defaultHttpsRequest;

/** Test seam: replace the https.request factory. Reset with
 *  resetHttpsRequest(). */
export function setHttpsRequest(factory: HttpsLikeRequest): void {
  httpsFactory = factory;
}

export function resetHttpsRequest(): void {
  httpsFactory = defaultHttpsRequest;
}

// ────────────────────────────────────────────────────────────────────────
// sendNtfy — low-level POST to https://ntfy.sh/<topic>
// ────────────────────────────────────────────────────────────────────────

export interface NtfyPayload {
  title: string;
  message: string;
  /** ntfy priority 1 (lowest) → 5 (max). Critical = 5; warn = 3. */
  priority: number;
  tags?: string[];
  click?: string;
  /** Optional ntfy "actions" array — pass-through (out of scope to type
   *  the full action schema; v1 dispatchers don't set this). */
  actions?: unknown[];
}

export interface NtfyResult {
  ok: boolean;
  status: number;
  error?: string;
}

/** POST a notification to ntfy.sh. Returns {ok,status,error?} — never
 *  throws. Times out after 5s. An empty/unset topic is a no-op that
 *  reports {ok:true,status:0,error:"disabled"} so callers can treat
 *  "ntfy off" the same as "ntfy succeeded but silently". */
export async function sendNtfy(topic: string, payload: NtfyPayload): Promise<NtfyResult> {
  if (!topic || typeof topic !== "string" || topic.trim() === "") {
    return { ok: true, status: 0, error: "disabled" };
  }
  // Build the JSON body. ntfy accepts the topic in either the URL path or
  // the body; we set both so a typo in either doesn't drop the message.
  const body = JSON.stringify({
    topic,
    title: payload.title,
    message: payload.message,
    priority: payload.priority,
    ...(payload.tags ? { tags: payload.tags } : {}),
    ...(payload.click ? { click: payload.click } : {}),
    ...(payload.actions ? { actions: payload.actions } : {}),
  });
  const url = `https://ntfy.sh/${encodeURIComponent(topic)}`;

  return new Promise<NtfyResult>((resolve) => {
    let settled = false;
    const settle = (r: NtfyResult) => { if (!settled) { settled = true; resolve(r); } };
    let req: ClientRequest;
    try {
      req = httpsFactory(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
        },
      }, (res) => {
        const status = res.statusCode ?? 0;
        // Drain the response so the socket can be reused (no-op for the
        // fake in tests; matters for real keep-alive in production).
        res.on("data", () => {});
        res.on("end", () => {
          if (status >= 200 && status < 300) settle({ ok: true, status });
          else settle({ ok: false, status, error: `http ${status}` });
        });
        res.on("error", (e: Error) => settle({ ok: false, status, error: e.message }));
      });
    } catch (e: any) {
      settle({ ok: false, status: 0, error: String(e?.message ?? e) });
      return;
    }

    req.on("error", (e: Error) => settle({ ok: false, status: 0, error: e.message }));
    req.on("timeout", () => {
      try { req.destroy(); } catch { /* */ }
      settle({ ok: false, status: 0, error: "timeout" });
    });
    // 5s overall budget per spec.
    try { req.setTimeout(5000); } catch { /* test fakes may not implement */ }

    try { req.write(body); req.end(); }
    catch (e: any) { settle({ ok: false, status: 0, error: String(e?.message ?? e) }); }
  });
}

// ────────────────────────────────────────────────────────────────────────
// Higher-level dispatchers — alerts + anomalies
// ────────────────────────────────────────────────────────────────────────

export interface NtfyConfig {
  /** ntfy.sh topic name. Empty/unset → ntfy disabled. */
  topic: string;
  /** SPA portal base; sendNtfy appends the project slug for `click`.
   *  Default is the local loopback hash route. Trailing "/" optional. */
  portalUrl: string;
}

const DEFAULT_PORTAL_URL = "http://127.0.0.1:7070/#/p/";

/** Load ntfy config from a FleetConfig. The two fields are added to the
 *  on-disk `fleet-control.config.json` — both optional. */
export function ntfyConfigFrom(cfg: FleetConfig): NtfyConfig {
  const anyCfg = cfg as unknown as Record<string, unknown>;
  const topic = typeof anyCfg.ntfyTopic === "string" ? anyCfg.ntfyTopic.trim() : "";
  let portalUrl = typeof anyCfg.portalUrl === "string" ? anyCfg.portalUrl : DEFAULT_PORTAL_URL;
  if (!portalUrl.endsWith("/")) portalUrl += "/";
  return { topic, portalUrl };
}

export interface AlertLike {
  project_id: number;
  phase: string | null;
  type: string;
  severity: string;
  title: string;
  detail: string;
  dedup_key: string;
}

/** severity → ntfy priority. Critical pages hard; warn buzzes; anything
 *  else stays at the ntfy default (3) so we don't bias future severities. */
function severityToPriority(sev: string): number {
  if (sev === "critical") return 5;
  if (sev === "warn") return 3;
  return 3;
}

/** Look up a project slug from its id (for click-URL construction).
 *  Returns null if the project was deleted between insert and dispatch. */
function slugFor(db: DB, projectId: number): string | null {
  const row = db.prepare("SELECT slug FROM project WHERE id=?").get(projectId) as
    { slug: string } | undefined;
  return row?.slug ?? null;
}

/** In-memory dedup table — one POST per dedup_key per process lifetime.
 *  This mirrors the SQL UNIQUE constraint on `alert.dedup_key`: the rule
 *  engine already calls evalAlerts every tick and re-inserts the SAME
 *  dedup_key are silent no-ops at the DB layer. We want the same shape
 *  for ntfy so a multi-minute outage doesn't buzz the phone every minute.
 *
 *  Restart resets the set, which is fine: if the daemon restarts, the
 *  underlying alert is still open in `alert` and the operator will see
 *  it on their next portal load. The point of ntfy is "tell me NOW" — a
 *  re-buzz on restart is a one-off, not a flood. */
const seenAlertKeys = new Set<string>();
const seenAnomalyKeys = new Set<string>();

/** Reset both dedup tables — used by tests to keep cases isolated.
 *  Production callers should never need this. */
export function _resetDedupForTests(): void {
  seenAlertKeys.clear();
  seenAnomalyKeys.clear();
}

/** Optional dispatcher overrides. `now` is the wall-clock used for the
 *  quiet-hours gate (ticket 0030); defaults to `new Date()`. Tests
 *  pin this so the gate is deterministic. */
export interface NtfyDispatchOpts {
  now?: Date;
}

/** Dispatch an alert to ntfy. Deduped per dedup_key. The dispatcher
 *  silently returns {ok:true,error:"disabled"} when ntfyTopic is unset OR
 *  the key has already been seen this process lifetime. Best-effort: a
 *  transport failure is logged to fleetd.err and the caller proceeds.
 *
 *  Ticket 0030: when the resolved quiet-hours window catches `now` AND
 *  the payload priority is < 5, the dispatcher returns
 *  `{ok:true,status:0,error:"quiet_hours"}` and does NOT POST. Per AC4,
 *  the dedup key is NOT consumed on the quiet-hours path so the alert
 *  re-fires at window close if still open. */
export async function ntfyForAlert(
  db: DB, cfg: FleetConfig, ncfg: NtfyConfig, alert: AlertLike,
  opts: NtfyDispatchOpts = {},
): Promise<NtfyResult> {
  if (!ncfg.topic) return { ok: true, status: 0, error: "disabled" };
  if (seenAlertKeys.has(alert.dedup_key)) {
    return { ok: true, status: 0, error: "deduped" };
  }
  const slug = slugFor(db, alert.project_id) ?? "";
  const priority = severityToPriority(alert.severity);
  // Quiet-hours gate: priority < 5 (anything below critical) is
  // suppressed when the project's effective window catches `now`.
  // Critical (priority 5) and fleet-wide correlations always page.
  if (priority < 5) {
    const now = opts.now ?? new Date();
    if (isQuietNow(cfg, slug, now)) {
      // DO NOT seenAlertKeys.add(alert.dedup_key) here — the alert
      // must re-fire at window close if still open.
      return { ok: true, status: 0, error: "quiet_hours" };
    }
  }
  seenAlertKeys.add(alert.dedup_key);
  const click = ncfg.portalUrl + slug;
  const tags = [alert.severity === "critical" ? "rotating_light" : "warning", alert.type];
  const r = await sendNtfy(ncfg.topic, {
    title: alert.title,
    message: alert.detail,
    priority,
    tags,
    click,
  });
  if (!r.ok) logNtfyError(`alert ${alert.dedup_key}`, r);
  return r;
}

export interface AnomalyDispatch {
  project_id: number;
  run_id: number;
  kind: string;
  value: number;
  baseline_mean: number;
  stddev_multiplier: number;
  candidate_reason: string | null;
}

/** Dispatch an anomaly to ntfy. Deduped per (run_id, kind). Message
 *  surfaces the σ-multiplier so the operator gets immediate context
 *  ("ship #482 ran 5.2σ above baseline — repeated tool errors").
 *
 *  Ticket 0030: anomalies dispatch at priority 4 (between warn and
 *  critical) — strictly less than the priority-5 gate, so they
 *  participate in the quiet-hours suppression. Same re-fire-at-close
 *  semantics as ntfyForAlert: the dedup key is NOT consumed on the
 *  quiet-hours path. */
export async function ntfyForAnomaly(
  db: DB, cfg: FleetConfig, ncfg: NtfyConfig, a: AnomalyDispatch,
  opts: NtfyDispatchOpts = {},
): Promise<NtfyResult> {
  if (!ncfg.topic) return { ok: true, status: 0, error: "disabled" };
  const key = `anomaly:${a.run_id}:${a.kind}`;
  if (seenAnomalyKeys.has(key)) {
    return { ok: true, status: 0, error: "deduped" };
  }
  const slug = slugFor(db, a.project_id) ?? "";
  // Quiet-hours gate (priority 4 < 5). Don't consume the dedup key on
  // suppression so a still-open anomaly re-fires at window close.
  {
    const now = opts.now ?? new Date();
    if (isQuietNow(cfg, slug, now)) {
      return { ok: true, status: 0, error: "quiet_hours" };
    }
  }
  seenAnomalyKeys.add(key);
  const click = ncfg.portalUrl + slug;
  const sigma = a.stddev_multiplier.toFixed(1);
  const unit = a.kind === "duration" ? "ms" : "$";
  const title = `${slug || "fleet"}: anomaly on ${a.kind}`;
  const reason = a.candidate_reason ? ` — ${a.candidate_reason}` : "";
  const message = `run #${a.run_id} hit ${unit}${a.value} (${sigma}σ above ${unit}${a.baseline_mean.toFixed(0)})${reason}`;
  const r = await sendNtfy(ncfg.topic, {
    title,
    message,
    priority: 4, // anomalies sit between warn and critical
    tags: ["chart_with_upwards_trend", "anomaly", a.kind],
    click,
  });
  if (!r.ok) logNtfyError(`anomaly run=${a.run_id} kind=${a.kind}`, r);
  return r;
}

/** Append a one-line ntfy failure to fleetd.err. Best-effort; if the log
 *  dir doesn't exist we silently swallow — the alternative is crashing
 *  the daemon for a logging failure, which defeats the point. */
function logNtfyError(context: string, r: NtfyResult): void {
  try {
    const line = `${new Date().toISOString()} ntfy error: ${r.status || "0"} ${r.error ?? ""} (${context})\n`;
    const path = join(homedir(), ".local", "state", "fleet-control", "logs", "fleetd.err");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line);
  } catch { /* never let a logger crash the daemon */ }
}

// ────────────────────────────────────────────────────────────────────────
// `fleetctl ntfy test` — operator setup verifier
// ────────────────────────────────────────────────────────────────────────

/** Run a test POST against the operator's configured topic. Returns an
 *  exit code (0=ok, 1=fail). Prints a single line to stdout (success) or
 *  stderr (failure) — no third-party logger. */
export async function ntfyTestCommand(ncfg: NtfyConfig): Promise<number> {
  if (!ncfg.topic) {
    process.stderr.write("ntfy test: no ntfyTopic configured in fleet-control.config.json\n");
    return 1;
  }
  const r = await sendNtfy(ncfg.topic, {
    title: "fleet-control: ntfy test",
    message: "If you see this on your phone, your ntfy setup is working.",
    priority: 3,
    tags: ["white_check_mark", "test"],
    click: ncfg.portalUrl,
  });
  if (r.ok) {
    process.stdout.write(`ntfy test: ok (status ${r.status})\n`);
    return 0;
  }
  process.stderr.write(`ntfy test: failed — ${r.error ?? "unknown"} (status ${r.status})\n`);
  return 1;
}

