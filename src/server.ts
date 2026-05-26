// Zero-dependency local server (node:http): JSON read API + static portal.
// Binds 127.0.0.1 by default; set host 0.0.0.0 in fleet-control.config.json for
// LAN access (phone/tablet) — Phase 4 adds the admin token before control routes.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { loadConfig, type FleetConfig } from "./config.ts";
import { openDb, type DB } from "./db.ts";
import { runIngestPass } from "./ingest/index.ts";
import { recentEvents } from "./ingest/events.ts";
import { fleetView, projectView, runView } from "./views.ts";
import { doAction } from "./control.ts";
import { evalAlerts } from "./alerts.ts";
import { installDaemon, uninstallDaemon, daemonStatus } from "./daemon.ts";
import { tailTranscript, type TailEvent } from "./live.ts";

const CONFIG_FILE = join(process.cwd(), "fleet-control.config.json");

/** Read or generate the admin token (required for control actions over the LAN). */
function adminToken(): string {
  let cfg: any = {};
  if (existsSync(CONFIG_FILE)) { try { cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8")); } catch { /* */ } }
  if (!cfg.adminToken) {
    cfg.adminToken = randomBytes(24).toString("hex");
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  }
  return cfg.adminToken;
}
const TOKEN = adminToken();

function isLoopback(req: any): boolean {
  const ip = req.socket?.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}
function controlAuthed(req: any): boolean {
  if (isLoopback(req)) return true; // local portal/CLI is trusted
  const t = String(req.headers["x-fleet-token"] ?? "");
  if (t.length !== TOKEN.length) return false;
  try { return timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN)); } catch { return false; }
}
/** Auth for the SSE stream: loopback bypasses; remote needs x-fleet-token,
 *  passed via header OR ?token= query (browser EventSource can't set headers). */
function streamAuthed(req: any, url: URL): boolean {
  if (isLoopback(req)) return true;
  const t = String(req.headers["x-fleet-token"] ?? url.searchParams.get("token") ?? "");
  if (t.length !== TOKEN.length) return false;
  try { return timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN)); } catch { return false; }
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
  runIngestPass(db, cfg); lastIngest = Date.now();

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname;
    try {
      // control actions (management) — POST, auth-gated for non-loopback
      const cm = path.match(/^\/api\/control\/([\w-]+)$/);
      if (cm && req.method === "POST") {
        if (!controlAuthed(req)) return json(res, { ok: false, message: "not authorized — pair this device first" }, 401);
        return readBody(req).then((body) => {
          let r;
          try {
            if (cm[1] === "daemon") { // always-on toggle (off by default)
              const on = body.enabled ?? body.on;
              if (on) installDaemon(Number(body.interval) || 60); else uninstallDaemon();
              r = { ok: true, message: on ? "Always-on monitoring enabled." : "Always-on monitoring disabled." };
            } else {
              r = doAction(db, isLoopback(req) ? "local" : "lan", cm[1], body);
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
        if (!streamAuthed(req, url)) {
          res.writeHead(401, { "content-type": "text/plain" });
          return res.end("unauthorized");
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
        maybeIngest(db, cfg);
        if (path === "/api/fleet") return json(res, fleetView(db, cfg));
        const pm = path.match(/^\/api\/project\/([\w-]+)$/);
        if (pm) { const v = projectView(db, cfg, pm[1]); return v ? json(res, v) : json(res, { error: "not found" }, 404); }
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
      console.log(`  LAN access enabled. Pair a device with this admin token:`);
      console.log(`  ${TOKEN}`);
    }
  });
  return server;
}
