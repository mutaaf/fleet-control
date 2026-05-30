// Zero-dependency local server (node:http): JSON read API + static portal.
// Binds 127.0.0.1 by default; set host 0.0.0.0 in fleet-control.config.json for
// LAN access (phone/tablet) — Phase 4 adds the admin token before control routes.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type FleetConfig } from "./config.ts";
import { openDb, type DB } from "./db.ts";
import { runIngestPass } from "./ingest/index.ts";
import { recentEvents } from "./ingest/events.ts";
import { fleetView, projectView, runView, forecastFor, fleetLeaderboard, clampDays, fleetStreak, projectHealth, projectIdBySlug, projectBurndown, ticketShipReport, projectToolMix, clampToolMixDays } from "./views.ts";
import { recentAnomalies } from "./anomaly.ts";
import { fleetInbox, dismissInboxItem, type DismissRequest } from "./inbox.ts";
import { activeCorrelations } from "./correlate.ts";
import { doAction } from "./control.ts";
import { diskUsage } from "./infra.ts";
import { evalAlerts } from "./alerts.ts";
import { installDaemon, uninstallDaemon, daemonStatus } from "./daemon.ts";
import { tailTranscript, type TailEvent } from "./live.ts";
import { pricingRows, lastSyncedAt, syncPricing } from "./pricing.ts";
import { fetchPrDiff } from "./diff.ts";
import { weeklyDigest } from "./digest.ts";
import { serveShare } from "./snapshot.ts";
import { renderBadge, projectBadge, parseMetric } from "./badge.ts";
import {
  authenticate, scopeAllows, migrateLegacyAdminTokenIfPresent,
  type Scope, type TokenRecord,
} from "./auth.ts";

const CONFIG_FILE = join(process.cwd(), "fleet-control.config.json");

function isLoopback(req: any): boolean {
  const ip = req.socket?.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/** Result of a scoped-auth check. `principal` is null for loopback (the local
 *  CLI / portal — trusted, no token). For remote callers it's the matched
 *  auth_token row, whose `name` we record on every control_audit row. */
export interface AuthOutcome {
  ok: boolean;
  status: number; // HTTP status on failure
  message: string; // human-friendly message on failure
  principal: TokenRecord | null;
}

/** Single auth chokepoint for the JSON API + SSE. Loopback bypasses tokens
 *  entirely (the local CLI/portal is trusted). Remote callers must send the
 *  `x-fleet-token` header (or `?token=` for SSE since browser EventSource
 *  can't set custom headers) AND that token's scope must dominate `required`.
 *  Updates last_used_at on success as a side effect of authenticate(). */
export function requireAuth(db: DB, req: any, required: Scope, url?: URL): AuthOutcome {
  if (isLoopback(req)) return { ok: true, status: 200, message: "", principal: null };
  const raw = String(req.headers["x-fleet-token"] ?? (url ? url.searchParams.get("token") ?? "" : ""));
  if (!raw) return { ok: false, status: 401, message: "not authorized — pair this device first", principal: null };
  const p = authenticate(db, raw);
  if (!p) return { ok: false, status: 401, message: "unknown or revoked token", principal: null };
  if (!scopeAllows(p.scope, required)) {
    return { ok: false, status: 403, message: `this token has scope '${p.scope}', need '${required}'`, principal: p };
  }
  return { ok: true, status: 200, message: "", principal: p };
}

function actorOf(req: any, principal: TokenRecord | null): { actor: string; actor_name: string } {
  if (principal) return { actor: "lan", actor_name: principal.name };
  return { actor: isLoopback(req) ? "local" : "lan", actor_name: isLoopback(req) ? "local" : "anonymous" };
}
function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let s = ""; req.on("data", (c: any) => (s += c)); req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
  });
}

const WEB = join(fileURLToPath(import.meta.url), "..", "..", "web");
// Ticket 0029: PWA shell — add MIME types for the manifest (a JSON variant
// that browsers recognise via `application/manifest+json`) and PNG icons.
// The `application/javascript` mapping covers the service worker — Chrome
// accepts `text/javascript` too, but Safari's stricter SW loader prefers
// `application/javascript`, so we use the explicit form.
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
};

// Refresh history at most every 10s on read (cheap; live state is always fresh).
let lastIngest = 0;
function maybeIngest(db: DB, cfg: FleetConfig) {
  // Skip if the daemon owns ingest (single writer); just serve the cache.
  if (daemonStatus()) return;
  if (Date.now() - lastIngest > 10_000) {
    try { runIngestPass(db, cfg); evalAlerts(db, cfg, false); } catch { /* keep serving */ }
    lastIngest = Date.now();
  }
}

const json = (res: any, body: unknown, code = 200) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(s);
};

/** Optional knobs the demo subcommand (ticket 0025) passes through to
 *  short-circuit every side-effecting boot step. When `demoMode` is
 *  true the server: (a) skips the legacy admin-token migration (the
 *  demo never reads the real fleet-control.config.json), (b) skips
 *  pricing sync, (c) skips the inline runIngestPass() — leaving the
 *  hand-authored fixture in the DB intact, and (d) flags maybeIngest()
 *  so the periodic read-time ingest also stays a no-op. */
export interface StartServerOpts {
  demoMode?: boolean;
  /** When set, suppress the default "fleet-control portal → ..." log
   *  line printed inside the listen callback. The demo CLI (ticket
   *  0025) sets this so it can emit its own banner exactly once,
   *  after the socket is actually accepting connections. */
  quietBanner?: boolean;
  /** Fires inside the server.listen callback — i.e. after the kernel
   *  has bound the port and accept() is live. Demo mode uses this to
   *  print its two-line banner only when fetch() will actually
   *  succeed. */
  onListening?: () => void;
}

export function startServer(host = "127.0.0.1", port = 7070, opts: StartServerOpts = {}) {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const demoMode = opts.demoMode === true;
  if (!demoMode) {
    // One-shot: if the legacy adminToken still lives in the config and we have
    // no auth_token rows, promote it to a real admin-scoped token so existing
    // paired devices keep working through the upgrade. After this returns the
    // adminToken field is gone from disk (see src/auth.ts).
    migrateLegacyAdminTokenIfPresent(db, CONFIG_FILE);
    // Ticket 0004: refresh the pricing table from data/anthropic-pricing.json
    // on every boot. A missing file is a no-op (DEFAULT_PRICING is already
    // seeded elsewhere), so this never crashes the server.
    try { syncPricing(db); } catch { /* keep serving */ }
    runIngestPass(db, cfg);
    lastIngest = Date.now();
  } else {
    // Demo mode: the fixture is the source of truth. Forbid the periodic
    // read-time ingest from firing by pinning lastIngest into the future
    // (maybeIngest() only fires when Date.now() - lastIngest > 10s).
    lastIngest = Number.MAX_SAFE_INTEGER;
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;
    try {
      // control actions (management) — POST, auth-gated for non-loopback
      const cm = path.match(/^\/api\/control\/([\w-]+)$/);
      if (cm && req.method === "POST") {
        // Token management lives inside doAction("tokens-*") and requires
        // admin; one-click GitHub-URL import (ticket 0010) also requires
        // admin — it spawns a clone + install on disk on the operator's
        // behalf. Snapshot-create / snapshot-revoke (ticket 0013) mint a
        // long-lived share URL whose surface is read-only but whose
        // existence is itself a privacy decision — only admin can take
        // it. Every other control verb requires control. Daemon toggle
        // is local-only infrastructure → control is sufficient.
        const required: Scope = (cm[1].startsWith("tokens-") || cm[1] === "register-url" || cm[1].startsWith("snapshot-")) ? "admin" : "control";
        const auth = requireAuth(db, req, required);
        if (!auth.ok) return json(res, { ok: false, message: auth.message }, auth.status);
        return readBody(req).then(async (body) => {
          let r;
          try {
            const who = actorOf(req, auth.principal);
            if (cm[1] === "daemon") { // always-on toggle (off by default)
              const on = body.enabled ?? body.on;
              if (on) installDaemon(Number(body.interval) || 60); else uninstallDaemon();
              r = { ok: true, message: on ? "Always-on monitoring enabled." : "Always-on monitoring disabled." };
            } else {
              // Ticket 0013: for snapshot-create the server freezes a
              // fresh fleet view server-side so the snapshot reflects
              // the same numbers the operator just saw on the home page
              // — and so a malicious caller can't smuggle a hand-rolled
              // payload through the API. base_url is derived from the
              // incoming Host header so the returned share_url is one
              // the recipient's network can actually resolve.
              if (cm[1] === "snapshot-create") {
                body.fleet_view = fleetView(db, cfg);
                const host = String(req.headers["host"] ?? "127.0.0.1:7070");
                body.base_url = `http://${host}`;
              }
              // doAction is now async (ticket 0006 introduced an action that
              // does node:fs/promises rm() — every action funnels through the
              // same await so the call site stays one path).
              r = await doAction(db, who.actor, cm[1], body, who.actor_name);
            }
          } catch (e: any) { r = { ok: false, message: String(e?.message ?? e) }; }
          lastIngest = 0; // force fresh state next read
          json(res, r, r.ok ? 200 : 400);
        });
      }
      if (path === "/api/whoami") return json(res, { loopback: isLoopback(req), needsToken: !isLoopback(req) });
      // Ticket 0017: today's inbox dismiss endpoint. POST a JSON body
      // {kind, project_slug, payload_id} to mark one item handled.
      // Requires `read` scope (loopback bypasses) — same posture as
      // every other read-API; the dismissal write is additive (a row
      // in inbox_dismissal + an UPDATE on anomaly.dismissed_at for
      // anomaly_open), so it's safe under the read scope. The path
      // ends in /inbox/dismiss (NOT /api/control/...) so it doesn't
      // require admin and doesn't collide with the control verb
      // surface.
      if (path === "/api/fleet/inbox/dismiss" && req.method === "POST") {
        const iauth = requireAuth(db, req, "read", url);
        if (!iauth.ok) return json(res, { ok: false, message: iauth.message }, iauth.status);
        return readBody(req).then((body) => {
          const r = dismissInboxItem(db, body as DismissRequest);
          return json(res, r, r.ok ? 200 : 400);
        });
      }
      // Live SSE tool-call stream (ticket 0002). Plain text/event-stream; tails
      // the active jsonl transcript and re-opens on rotation. Closes itself
      // after 5 min of idle or on client disconnect. Loopback bypasses auth;
      // remote requires x-fleet-token (header or ?token=, since browser
      // EventSource can't set custom headers).
      const sm = path.match(/^\/api\/projects\/([\w-]+)\/stream$/);
      if (sm) {
        const sauth = requireAuth(db, req, "read", url);
        if (!sauth.ok) {
          res.writeHead(sauth.status, { "content-type": "text/plain" });
          return res.end(sauth.message);
        }
        const slug = sm[1];
        const optPhase = url.searchParams.get("phase") ?? undefined;
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          "connection": "keep-alive",
          "x-accel-buffering": "no",
          "access-control-allow-origin": "*",
        });
        // SSE retry hint + an immediate "hello" comment so the client knows
        // the channel is alive even before any transcript bytes arrive.
        res.write("retry: 5000\n");
        res.write(": connected\n\n");
        const send = (e: TailEvent) => {
          try {
            const payload = e.path ? { path: e.path, ...(e.data ?? {}) } : (e.data ?? {});
            res.write(`event: ${e.type}\ndata: ${JSON.stringify(payload)}\n\n`);
          } catch { /* peer gone; close handler will tidy up */ }
        };
        const ctrl = tailTranscript(cfg, slug, (e) => {
          send(e);
          if (e.type === "idle-close") { try { res.end(); } catch { /* */ } }
        }, { phase: optPhase });
        // Heartbeat comment every 25s — keeps proxies/load balancers from
        // killing the idle TCP connection without sending a parseable event.
        const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* */ } }, 25_000);
        const teardown = () => { clearInterval(hb); ctrl.close(); };
        req.on("close", teardown);
        res.on("close", teardown);
        return;
      }
      // Inline PR diff (ticket 0007). text/plain body — NOT JSON — so the
      // SPA can stream it directly into a <div> after escaping. Cached
      // server-side for 30s per (repo,number). Read scope (loopback
      // bypasses); malformed slugs / numbers are 400 before any shell-out.
      // Path shape: /api/prs/<owner>/<name>/<number>/diff — the ":repo"
      // segment intentionally contains a "/" because it's owner/name.
      const dfm = path.match(/^\/api\/prs\/([^/]+\/[^/]+)\/(\d+)\/diff$/);
      if (dfm && req.method === "GET") {
        const dauth = requireAuth(db, req, "read", url);
        if (!dauth.ok) {
          res.writeHead(dauth.status, { "content-type": "text/plain" });
          return res.end(dauth.message);
        }
        return fetchPrDiff(dfm[1], dfm[2]).then((r) => {
          res.writeHead(r.status, {
            "content-type": "text/plain; charset=utf-8",
            "x-diff-truncated": r.truncated ? "1" : "0",
            "cache-control": "no-store",
          });
          res.end(r.body);
        }).catch((e: any) => {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(String(e?.message ?? e));
        });
      }
      if (path.startsWith("/api/")) {
        // All read endpoints require the `read` scope (loopback bypasses).
        const rauth = requireAuth(db, req, "read", url);
        if (!rauth.ok) return json(res, { error: rauth.message }, rauth.status);
        maybeIngest(db, cfg);
        if (path === "/api/fleet") {
          const v = fleetView(db, cfg);
          // Ticket 0022: ?sort=health re-orders the project grid
          // ascending by health.score (worst first) so the operator's
          // eye lands on the project that needs them. The default
          // ordering (slug ASC, set by fleetView) is unchanged when
          // the query param is absent.
          if (url.searchParams.get("sort") === "health") {
            v.projects = [...v.projects].sort((a: any, b: any) =>
              (a.health?.score ?? 0) - (b.health?.score ?? 0));
          }
          return json(res, v);
        }
        // Ticket 0022: per-project health detail. Reads `read` scope
        // (loopback bypasses), same posture as every other GET
        // /api/projects/:slug/* route. Returns the full
        // {score, band, subs, generated_at, formula} payload — the
        // SPA tooltip renders the formula text from this response so
        // the docs stay live.
        const hm = path.match(/^\/api\/projects\/([\w-]+)\/health$/);
        if (hm) {
          const pid = projectIdBySlug(db, hm[1]);
          if (pid == null) return json(res, { error: "not found" }, 404);
          return json(res, projectHealth(db, pid));
        }
        // Ticket 0017: today's inbox. Cross-project "what needs me"
        // aggregation over PRs / anomalies / snapshots / failed runs.
        // Read-scope (loopback bypasses); same shape as every other
        // GET /api/fleet/* route — net-new, no existing JSON shape to
        // preserve.
        if (path === "/api/fleet/inbox") return json(res, fleetInbox(db, { cfg }));
        // Ticket 0027: active cross-project failure correlations.
        // Read-scope (loopback bypasses); same posture as every other
        // GET /api/fleet/* route. Net-new — no existing JSON shape to
        // preserve. Returns the array of active (non-dismissed)
        // correlation rows the inbox + detail view both render.
        if (path === "/api/fleet/correlations") {
          return json(res, { correlations: activeCorrelations(db, new Date()) });
        }
        // Merge streak counter + 90-day calendar heatmap (ticket 0026).
        // Read-scope (loopback bypasses); same posture as every other
        // GET /api/fleet/* route. Net-new — no existing JSON shape
        // to preserve. The helper does two SQL GROUP BYs + one JS
        // walk; well under 50ms even at 10 projects × 90 days.
        if (path === "/api/fleet/streak") return json(res, fleetStreak(db));
        // Cross-project tool-call leaderboard (ticket 0014). One JSON
        // payload composed of three SQL aggregations (tools across the
        // fleet, projects, cost-by-phase heatmap). `days` query param
        // defaults to 14, clamped to [1, 90] — clampDays() lives in
        // views.ts so the tests share the same source of truth.
        if (path === "/api/fleet/leaderboard") {
          const days = clampDays(url.searchParams.get("days"));
          return json(res, fleetLeaderboard(db, { days }));
        }
        // Weekly digest (ticket 0012). Cached for 5 min inside the helper
        // keyed by the period — cheap to recompute, but a polled SPA could
        // hit this every 5s on the home view. Same shape as the Digest
        // type in src/digest.ts; the SPA's home banner consumes it.
        if (path === "/api/digest/week") return json(res, weeklyDigest(db));
        // Pricing table (ticket 0004). `synced_at` is the most-recent
        // fetched_at across all rows; `stale` flips true when that's older
        // than 24h so the SPA footer can render a warn badge.
        if (path === "/api/pricing") {
          const rows = pricingRows(db);
          const synced = lastSyncedAt(db);
          const stale = synced ? (Date.now() - new Date(synced).getTime()) > 24 * 60 * 60_000 : true;
          return json(res, { models: rows, synced_at: synced, stale });
        }
        const pm = path.match(/^\/api\/project\/([\w-]+)$/);
        if (pm) { const v = projectView(db, cfg, pm[1]); return v ? json(res, v) : json(res, { error: "not found" }, 404); }
        // 30-day cost forecast (ticket 0005). New route; no existing JSON
        // shape to preserve. Returns null when fewer than 3 days of data
        // exist (the view surfaces "not enough yet" instead of a number).
        const fm = path.match(/^\/api\/projects\/([\w-]+)\/forecast$/);
        if (fm) { const v = forecastFor(db, fm[1]); return v ? json(res, v) : json(res, { error: "not found" }, 404); }
        // Ticket 0028: month-to-date budget burndown for the project
        // card's inline sparkline. Reads `read` scope (loopback
        // bypasses); same posture as every other GET
        // /api/projects/:slug/* route. Net-new — no existing JSON
        // shape to preserve. Returns the full {days, cap_per_day_usd,
        // cap_eom_usd, projected_eom_usd, band} payload; the SPA
        // fetches it lazily on card tap.
        const bdm = path.match(/^\/api\/projects\/([\w-]+)\/burndown$/);
        if (bdm) {
          const pid = projectIdBySlug(db, bdm[1]);
          if (pid == null) return json(res, { error: "not found" }, 404);
          return json(res, projectBurndown(db, pid));
        }
        // Ticket 0031: per-project tool-mix sparkline. Returns
        // {window, tools, total_invocations} — the stacked-bar
        // ingredients the SPA's project page renders above the job
        // cards. `days` clamps to [1,30] (default 7) — the tool-mix
        // is a recent-window question; longer windows don't help the
        // operator drilling into "where did this week's budget go?".
        // Net-new route — no existing JSON shape to preserve; the
        // /api/project/:slug detail payload stays additive-only and
        // does NOT inline this aggregate (the SPA fetches lazily on
        // render).
        const tmm = path.match(/^\/api\/projects\/([\w-]+)\/tool-mix$/);
        if (tmm) {
          const pid = projectIdBySlug(db, tmm[1]);
          if (pid == null) return json(res, { error: "not found" }, 404);
          const days = clampToolMixDays(url.searchParams.get("days"));
          return json(res, projectToolMix(db, pid, new Date(), days));
        }
        // Disk usage + stale-checkout candidates (ticket 0006). 200 with an
        // all-zeros payload for an unknown slug — the SPA's expandable
        // section just shows "0 GB · no candidates" rather than a 404.
        const dm = path.match(/^\/api\/projects\/([\w-]+)\/disk$/);
        if (dm) {
          return diskUsage(dm[1])
            .then((r) => json(res, r))
            .catch((e: any) => json(res, { error: String(e?.message ?? e) }, 500));
        }
        // Ticket 0018: backlog-ticket ship report. Aggregates the
        // ticket_commit_link rows for one 4-digit ticket id; the SPA
        // renders a "Shipped as PR #N · K commits · +X / -Y across Z
        // files" panel beneath the acceptance criteria. Net-new — no
        // existing JSON shape to preserve. Returns 404 when no
        // commits link to the ticket so the SPA can render nothing
        // for proposed / groomed / in-progress tickets.
        const shipm = path.match(/^\/api\/backlog\/(\d{4})\/ship-report$/);
        if (shipm) {
          const rep = ticketShipReport(db, shipm[1]);
          return rep ? json(res, rep) : json(res, { error: "not found" }, 404);
        }
        // Anomalies for a project (ticket 0008). Default N=10, hard cap 50.
        // 200 with `{anomalies: []}` for an unknown slug — same shape as
        // /events, so the SPA can render "no anomalies" without a 404 path.
        const am = path.match(/^\/api\/projects\/([\w-]+)\/anomalies$/);
        if (am) {
          const proj = db.prepare("SELECT id FROM project WHERE slug=?").get(am[1]) as { id: number } | undefined;
          if (!proj) return json(res, { anomalies: [] });
          const raw = Number(url.searchParams.get("limit") ?? "10");
          const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 50) : 10;
          return json(res, { anomalies: recentAnomalies(db, proj.id, limit) });
        }
        // Typed event stream (ticket 0001). Read-only, slug-scoped, capped.
        const em = path.match(/^\/api\/projects\/([\w-]+)\/events$/);
        if (em) {
          const limit = Number(url.searchParams.get("limit") ?? "50");
          const safe = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50;
          return json(res, { slug: em[1], events: recentEvents(db, em[1], safe) });
        }
        const rm = path.match(/^\/api\/run\/(\d+)$/);
        if (rm) { const v = runView(db, Number(rm[1])); return v ? json(res, v) : json(res, { error: "not found" }, 404); }
        return json(res, { error: "unknown endpoint" }, 404);
      }
      // Ticket 0015: embeddable status badge SVG per project. Public
      // by design — same posture as /share/<token>; the slug is not a
      // secret on a LAN and a public deployment is the operator's
      // choice. An unknown slug is a 200 grey "unknown" badge (NOT a
      // 404 — a 404 inside an <img> is uglier than a placeholder).
      // An invalid metric is a 400 with a plain-text body. Cached for
      // 60 seconds with an ETag derived from sha256(body) so README
      // renderers can revalidate cheaply.
      const bm = path.match(/^\/badge\/([\w-]+)\.svg$/);
      if (bm && req.method === "GET") {
        const slug = bm[1];
        const metric = parseMetric(url.searchParams.get("metric"));
        if (metric === null) {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          return res.end("unknown metric — try one of: status, cost, ship");
        }
        const data = projectBadge(db, slug, metric);
        const body = renderBadge(data);
        const etag = '"' + createHash("sha256").update(body).digest("hex") + '"';
        // If-None-Match short-circuit so README renderers re-validate
        // cheaply. We compare on the strong-quoted ETag so a future
        // weak-validator change here doesn't silently start matching.
        const inm = req.headers["if-none-match"];
        if (typeof inm === "string" && inm === etag) {
          res.writeHead(304, {
            "etag": etag,
            "cache-control": "public, max-age=60",
          });
          return res.end();
        }
        res.writeHead(200, {
          "content-type": "image/svg+xml; charset=utf-8",
          "cache-control": "public, max-age=60",
          "etag": etag,
          // Badges are intended for embedding; expose the route to
          // any origin (the bytes are public by design).
          "access-control-allow-origin": "*",
        });
        return res.end(body);
      }
      // Ticket 0013: read-only shareable fleet snapshot.
      // GET /share/<token> renders an HTML page directly from the
      // snapshot row keyed by SHA-256(token). NO auth middleware —
      // the token IS the auth; presenting an unknown one yields 404,
      // a revoked or expired one yields 410. The page carries no
      // <button>, no /api/control/ string, no github.com anchor;
      // see serveShare() in src/snapshot.ts.
      const shm = path.match(/^\/share\/([0-9a-fA-F]+)$/);
      if (shm && req.method === "GET") {
        const result = serveShare(db, shm[1]);
        res.writeHead(result.status, result.headers);
        return res.end(result.body);
      }
      // static portal
      let file = path === "/" ? "index.html" : path.replace(/^\//, "");
      const full = join(WEB, file);
      if (!full.startsWith(WEB) || !existsSync(full)) { res.writeHead(404); return res.end("not found"); }
      // Ticket 0029: the service worker MUST be served with
      // `Service-Worker-Allowed: /` so its scope can extend to the site
      // root from /sw.js. Browsers reject a wider scope without this
      // header (defence against a SW registered from a subdir
      // intercepting the parent). The other static assets keep the
      // existing minimal header set.
      const headers: Record<string, string> = {
        "content-type": MIME[extname(full)] ?? "application/octet-stream",
      };
      if (path === "/sw.js") headers["service-worker-allowed"] = "/";
      res.writeHead(200, headers);
      res.end(readFileSync(full));
    } catch (e: any) {
      json(res, { error: String(e?.message ?? e) }, 500);
    }
  });

  server.listen(port, host, () => {
    if (!opts.quietBanner) {
      console.log(`fleet-control portal → http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
      if (host === "0.0.0.0") {
        // We deliberately never log a token here — mint one with
        //   `fleetctl tokens add <device-name> --scope <read|control|admin>`
        // which prints it ONCE so it's only on the operator's screen.
        console.log(`  LAN access enabled. Mint a token with: fleetctl tokens add <device-name> --scope read`);
      }
    }
    try { opts.onListening?.(); } catch { /* never let a banner crash the server */ }
  });
  return server;
}
