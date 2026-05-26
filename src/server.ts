// Zero-dependency local server (node:http): JSON read API + static portal.
// Binds 127.0.0.1 by default; set host 0.0.0.0 in fleet-control.config.json for
// LAN access (phone/tablet) — Phase 4 adds the admin token before control routes.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type FleetConfig } from "./config.ts";
import { openDb, type DB } from "./db.ts";
import { runIngestPass } from "./ingest/index.ts";
import { recentEvents } from "./ingest/events.ts";
import { fleetView, projectView, runView, forecastFor } from "./views.ts";
import { doAction } from "./control.ts";
import { evalAlerts } from "./alerts.ts";
import { installDaemon, uninstallDaemon, daemonStatus } from "./daemon.ts";
import { tailTranscript, type TailEvent } from "./live.ts";
import { pricingRows, lastSyncedAt, syncPricing } from "./pricing.ts";
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
const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

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

export function startServer(host = "127.0.0.1", port = 7070) {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  // One-shot: if the legacy adminToken still lives in the config and we have
  // no auth_token rows, promote it to a real admin-scoped token so existing
  // paired devices keep working through the upgrade. After this returns the
  // adminToken field is gone from disk (see src/auth.ts).
  migrateLegacyAdminTokenIfPresent(db, CONFIG_FILE);
  // Ticket 0004: refresh the pricing table from data/anthropic-pricing.json
  // on every boot. A missing file is a no-op (DEFAULT_PRICING is already
  // seeded elsewhere), so this never crashes the server.
  try { syncPricing(db); } catch { /* keep serving */ }
  runIngestPass(db, cfg); lastIngest = Date.now();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;
    try {
      // control actions (management) — POST, auth-gated for non-loopback
      const cm = path.match(/^\/api\/control\/([\w-]+)$/);
      if (cm && req.method === "POST") {
        // Token management lives inside doAction("tokens-*") and requires
        // admin; every other control verb requires control. Daemon toggle
        // is local-only infrastructure → control is sufficient.
        const required: Scope = cm[1].startsWith("tokens-") ? "admin" : "control";
        const auth = requireAuth(db, req, required);
        if (!auth.ok) return json(res, { ok: false, message: auth.message }, auth.status);
        return readBody(req).then((body) => {
          let r;
          try {
            const who = actorOf(req, auth.principal);
            if (cm[1] === "daemon") { // always-on toggle (off by default)
              const on = body.enabled ?? body.on;
              if (on) installDaemon(Number(body.interval) || 60); else uninstallDaemon();
              r = { ok: true, message: on ? "Always-on monitoring enabled." : "Always-on monitoring disabled." };
            } else {
              r = doAction(db, who.actor, cm[1], body, who.actor_name);
            }
          } catch (e: any) { r = { ok: false, message: String(e?.message ?? e) }; }
          lastIngest = 0; // force fresh state next read
          json(res, r, r.ok ? 200 : 400);
        });
      }
      if (path === "/api/whoami") return json(res, { loopback: isLoopback(req), needsToken: !isLoopback(req) });
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
      if (path.startsWith("/api/")) {
        // All read endpoints require the `read` scope (loopback bypasses).
        const rauth = requireAuth(db, req, "read", url);
        if (!rauth.ok) return json(res, { error: rauth.message }, rauth.status);
        maybeIngest(db, cfg);
        if (path === "/api/fleet") return json(res, fleetView(db, cfg));
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
      // static portal
      let file = path === "/" ? "index.html" : path.replace(/^\//, "");
      const full = join(WEB, file);
      if (!full.startsWith(WEB) || !existsSync(full)) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream" });
      res.end(readFileSync(full));
    } catch (e: any) {
      json(res, { error: String(e?.message ?? e) }, 500);
    }
  });

  server.listen(port, host, () => {
    console.log(`fleet-control portal → http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
    if (host === "0.0.0.0") {
      // We deliberately never log a token here — mint one with
      //   `fleetctl tokens add <device-name> --scope <read|control|admin>`
      // which prints it ONCE so it's only on the operator's screen.
      console.log(`  LAN access enabled. Mint a token with: fleetctl tokens add <device-name> --scope read`);
    }
  });
  return server;
}
