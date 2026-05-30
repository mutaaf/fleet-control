// Tests for ticket 0029 — installable PWA portal with offline shell + stale
// banner. One `test(...)` per acceptance-criteria checkbox in
// docs/backlog/0029-pwa-installable-portal.md.
//
// Strategy:
//   • The static assets (manifest, icons, index.html, sw.js, app.js) are
//     asserted at the file-bytes level — JSON shape, PNG magic bytes, tag
//     counts, sw.js text shape. We do NOT boot a real service-worker
//     runtime; instead we eval() sw.js inside a hand-rolled `self` scaffold
//     that captures the install/activate/fetch listeners, then drive each
//     one with a stub fetch + a stub Cache Storage.
//   • The server-route tests (manifest / sw.js / icon-192.png /
//     icon-512.png) drive an in-process `startServer()` per LESSONS §
//     "in-process startServer() tests need an empty-roots config + run-row
//     seeds" — we plant a temporary fleet-control.config.json in cwd
//     pointing every root at an empty tmpdir, snapshot/restore on cleanup.
//   • The app.js client-side helpers (registerServiceWorker /
//     renderStaleBanner / clearStaleBanner) are exercised by parsing the
//     relevant function text out of app.js, wrapping it in a JSDOM-ish
//     scaffold, and asserting DOM state — no JSDOM dep, just a minimal
//     hand-rolled document / element shim.
//
// Zero new runtime deps; stdlib + node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.ts";
import { startServer } from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const WEB = join(REPO_ROOT, "web");

// ────────────────────────────────────────────────────────────────────
// Server-route boot helper (mirrors tests/badge-route.test.ts —
// LESSONS § "in-process startServer() tests need an empty-roots config").
// ────────────────────────────────────────────────────────────────────

let activeBoots = 0;
let savedConfigText: string | null = null;
const CONFIG_PATH = join(process.cwd(), "fleet-control.config.json");

interface Booted {
  base: string;
  close: () => Promise<void>;
  cleanup: () => void;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    import("node:net").then((net) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const a = srv.address();
        if (a && typeof a === "object") {
          const p = a.port; srv.close(() => resolve(p));
        } else { srv.close(); reject(new Error("no port")); }
      });
      srv.on("error", reject);
    }).catch(reject);
  });
}

async function boot(): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), "fleet-pwa-"));
  const dbPath = join(dir, "fleet.db");
  const emptyRoots = join(dir, "empty");
  mkdirSync(emptyRoots, { recursive: true });
  if (activeBoots === 0) {
    savedConfigText = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null;
  }
  activeBoots += 1;
  writeFileSync(CONFIG_PATH, JSON.stringify({
    projectRoots: [emptyRoots],
    installedRoot: emptyRoots,
    cacheBase: emptyRoots,
    claudeProjects: emptyRoots,
  }));
  process.env.FLEET_DB_PATH = dbPath;
  // Touch the DB so the inline migration step doesn't race the test.
  const seedDb = openDb(dbPath); seedDb.close();
  const port = await freePort();
  const server = startServer("127.0.0.1", port);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + "/api/whoami"); if (r.ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  return {
    base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    cleanup: () => {
      delete process.env.FLEET_DB_PATH;
      activeBoots -= 1;
      if (activeBoots === 0) {
        if (savedConfigText === null) { try { unlinkSync(CONFIG_PATH); } catch { /* gone */ } }
        else writeFileSync(CONFIG_PATH, savedConfigText);
        savedConfigText = null;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// AC1 — manifest.webmanifest is valid JSON with the required fields,
// colours pinned to literals matching --bg in web/style.css.
// ────────────────────────────────────────────────────────────────────

test("AC1: manifest.webmanifest parses and carries the required fields", () => {
  const raw = readFileSync(join(WEB, "manifest.webmanifest"), "utf8");
  const m = JSON.parse(raw);
  assert.equal(m.name, "fleet-control");
  assert.equal(m.short_name, "fleet");
  assert.equal(m.start_url, "/");
  assert.equal(m.display, "standalone");
  assert.equal(m.scope, "/");
  assert.ok(typeof m.background_color === "string" && /^#[0-9A-Fa-f]{6}$/.test(m.background_color));
  assert.ok(typeof m.theme_color === "string" && /^#[0-9A-Fa-f]{6}$/.test(m.theme_color));
  assert.ok(Array.isArray(m.icons) && m.icons.length >= 2);
  const sizes = new Set(m.icons.map((i: any) => i.sizes));
  assert.ok(sizes.has("192x192"), "manifest must declare a 192x192 icon");
  assert.ok(sizes.has("512x512"), "manifest must declare a 512x512 icon");
  for (const ico of m.icons) {
    assert.equal(ico.type, "image/png");
    assert.ok(typeof ico.src === "string" && ico.src.startsWith("/"));
  }
});

test("AC1: manifest colours match the literals in web/style.css (--bg)", () => {
  const css = readFileSync(join(WEB, "style.css"), "utf8");
  const bgMatch = css.match(/--bg:\s*(#[0-9A-Fa-f]{6})/);
  assert.ok(bgMatch, "expected --bg literal in style.css");
  const bg = bgMatch![1].toUpperCase();
  const m = JSON.parse(readFileSync(join(WEB, "manifest.webmanifest"), "utf8"));
  assert.equal(String(m.background_color).toUpperCase(), bg,
    "manifest.background_color must match --bg literal in style.css");
  assert.equal(String(m.theme_color).toUpperCase(), bg,
    "manifest.theme_color must match --bg literal in style.css");
});

// ────────────────────────────────────────────────────────────────────
// AC2 — icon-192.png and icon-512.png are real PNGs (magic-byte check).
// ────────────────────────────────────────────────────────────────────

test("AC2: icon-192.png and icon-512.png exist and start with PNG magic bytes", () => {
  for (const name of ["icon-192.png", "icon-512.png"]) {
    const p = join(WEB, name);
    assert.ok(existsSync(p), `${name} must exist`);
    const bytes = readFileSync(p);
    assert.ok(bytes.length > 0, `${name} must be non-empty`);
    // PNG magic: 89 50 4E 47 0D 0A 1A 0A
    assert.equal(bytes[0], 0x89, `${name}[0]`);
    assert.equal(bytes[1], 0x50, `${name}[1]`);
    assert.equal(bytes[2], 0x4e, `${name}[2]`);
    assert.equal(bytes[3], 0x47, `${name}[3]`);
  }
});

// ────────────────────────────────────────────────────────────────────
// AC3 — index.html has exactly one <link rel="manifest"> and one
// <meta name="theme-color">; the 0011 viewport stays unchanged.
// ────────────────────────────────────────────────────────────────────

test("AC3: index.html has exactly one manifest link + one theme-color meta + viewport preserved", () => {
  const html = readFileSync(join(WEB, "index.html"), "utf8");
  const manifestLinks = html.match(/<link[^>]+rel=["']manifest["'][^>]*>/gi) || [];
  assert.equal(manifestLinks.length, 1, "expected exactly one <link rel=\"manifest\">");
  assert.match(manifestLinks[0], /href=["']\/manifest\.webmanifest["']/i);
  const themeMetas = html.match(/<meta[^>]+name=["']theme-color["'][^>]*>/gi) || [];
  assert.equal(themeMetas.length, 1, "expected exactly one <meta name=\"theme-color\">");
  // The viewport meta from ticket 0011 must remain present and unchanged.
  assert.match(html, /<meta\s+name="viewport"\s+content="width=device-width,\s*initial-scale=1,\s*viewport-fit=cover"\s*\/>/);
});

// ────────────────────────────────────────────────────────────────────
// AC4 — sw.js install/activate handlers + cache-name + shell asset list.
// We assert by text shape — the canonical SW runtime is the browser,
// not node, so we parse the file and check structural invariants.
// ────────────────────────────────────────────────────────────────────

test("AC4: sw.js declares versioned cache + install pre-caches the shell + activate purges old", () => {
  const src = readFileSync(join(WEB, "sw.js"), "utf8");
  // No imports at all — vanilla SW.
  assert.equal(/^\s*import\b/m.test(src), false,
    "sw.js must have no imports (vanilla service worker)");
  // Versioned cache name with a fleet-shell- prefix.
  assert.match(src, /CACHE_NAME\s*=\s*["']fleet-shell-/);
  // install handler registered.
  assert.match(src, /addEventListener\(\s*["']install["']/);
  // activate handler registered.
  assert.match(src, /addEventListener\(\s*["']activate["']/);
  // Shell asset list contains every required entry.
  for (const asset of [
    "/", "/app.js", "/style.css", "/index.html",
    "/manifest.webmanifest", "/icon-192.png", "/icon-512.png",
  ]) {
    assert.ok(src.includes(`"${asset}"`),
      `sw.js shell list must include "${asset}"`);
  }
  // Activate purges only old fleet-shell-* caches (not foreign caches).
  assert.match(src, /startsWith\(\s*["']fleet-shell-["']/);
  assert.match(src, /caches\.delete/);
});

// ────────────────────────────────────────────────────────────────────
// AC5 — sw.js fetch handler: network-first for /api/*, cache-first for
// everything else, synthetic 503 {stale,reason:"offline"} on /api/* fail.
// We eval the SW in a hand-rolled scaffold and drive each handler.
// ────────────────────────────────────────────────────────────────────

interface SwHarness {
  install: (event: any) => void;
  activate: (event: any) => void;
  fetch: (event: any) => void;
  caches: any;
}

function loadSwHarness(opts: { fetchImpl: any }): SwHarness {
  const src = readFileSync(join(WEB, "sw.js"), "utf8");
  const listeners: Record<string, (event: any) => void> = {};
  // Stub Cache Storage: a single Map per cache name, keyed by request URL.
  const store = new Map<string, Map<string, any>>();
  const cachesShim = {
    open(name: string) {
      if (!store.has(name)) store.set(name, new Map());
      const m = store.get(name)!;
      return Promise.resolve({
        addAll(list: string[]) {
          // Pretend each shell URL fetches OK; tuck the URL into the cache.
          for (const u of list) m.set(u, new Response("shell:" + u, { status: 200 }));
          return Promise.resolve();
        },
        put(req: any, res: any) {
          const url = typeof req === "string" ? req : req.url;
          m.set(url, res);
          return Promise.resolve();
        },
      });
    },
    keys() { return Promise.resolve(Array.from(store.keys())); },
    delete(name: string) { return Promise.resolve(store.delete(name)); },
    match(req: any) {
      const url = typeof req === "string" ? req : req.url;
      for (const m of store.values()) {
        const hit = m.get(url);
        if (hit) return Promise.resolve(hit);
      }
      return Promise.resolve(undefined);
    },
    _store: store,
  };
  const self = {
    addEventListener(name: string, fn: (e: any) => void) { listeners[name] = fn; },
  };
  // Evaluate the SW source against our scaffold. We expose `self`,
  // `caches`, `fetch`, `URL`, and `Response` as locals.
  const factory = new Function("self", "caches", "fetch", "URL", "Response",
    src + "\n; return null;");
  factory(self, cachesShim, opts.fetchImpl, URL, Response);
  return {
    install: listeners["install"],
    activate: listeners["activate"],
    fetch: listeners["fetch"],
    caches: cachesShim,
  };
}

function makeFetchEvent(url: string, method = "GET") {
  let handled: any = null;
  const event = {
    request: { url, method },
    respondWith(p: Promise<Response> | Response) { handled = p; },
    waitUntil(p: Promise<any>) { return p; },
    get _handled() { return handled; },
  };
  return event;
}

test("AC5: sw.js fetch handler network-first for /api/* and synthesises 503 on failure", async () => {
  const harness = loadSwHarness({ fetchImpl: () => Promise.reject(new Error("offline")) });
  const ev = makeFetchEvent("http://127.0.0.1:7070/api/fleet");
  harness.fetch(ev);
  assert.ok(ev._handled, "fetch handler must call respondWith for /api/* GETs");
  const res = await ev._handled;
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.stale, true);
  assert.equal(body.reason, "offline");
});

test("AC5: sw.js fetch handler is cache-first for shell assets — second call wins from cache", async () => {
  // Network returns "fresh"; we expect the first call to populate the
  // cache and the second to win from cache even if network errors.
  let networkCalls = 0;
  const harness = loadSwHarness({
    fetchImpl: (req: any) => {
      networkCalls += 1;
      const url = typeof req === "string" ? req : req.url;
      return Promise.resolve(new Response("fresh:" + url, {
        status: 200, headers: { "content-type": "text/css" },
      }));
    },
  });
  // Prime the cache with the shell asset (the install handler does this
  // for the real shell list; we add /style.css explicitly so the second
  // call has something to hit even if the impl prefers cache from
  // install-time).
  await harness.caches.open("fleet-shell-v1").then((c: any) =>
    c.put("http://127.0.0.1:7070/style.css", new Response("cached-body", {
      status: 200, headers: { "content-type": "text/css" },
    })));
  const ev = makeFetchEvent("http://127.0.0.1:7070/style.css");
  harness.fetch(ev);
  const res = await ev._handled;
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(body, "cached-body",
    "cache-first must serve the cached body when present");
  assert.equal(networkCalls, 0, "cache-first must not hit network when cache has the entry");
});

// ────────────────────────────────────────────────────────────────────
// AC6 — app.js registers the SW only when navigator.serviceWorker is
// present; registration failure (Safari private) is swallowed silently.
// ────────────────────────────────────────────────────────────────────

function extractFunction(src: string, name: string): string {
  // Extract a top-level `function NAME(...) { ... }` block from the file,
  // matching balanced braces. Throws if not found.
  const re = new RegExp("function\\s+" + name + "\\s*\\([^)]*\\)\\s*\\{");
  const m = src.match(re);
  if (!m) throw new Error("function " + name + " not found");
  const start = m.index!;
  let depth = 0; let i = start + m[0].length - 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") { depth -= 1; if (depth === 0) return src.slice(start, i + 1); }
    i += 1;
  }
  throw new Error("function " + name + " unterminated");
}

test("AC6: app.js registerServiceWorker swallows registration failure", () => {
  const src = readFileSync(join(WEB, "app.js"), "utf8");
  const body = extractFunction(src, "registerServiceWorker");
  // The helper must (a) guard on "serviceWorker" in navigator, (b) call
  // .register with /sw.js, (c) attach a .catch on the returned promise OR
  // wrap in try/catch — Safari throws synchronously in private mode.
  assert.match(body, /"serviceWorker"\s+in\s+navigator/);
  assert.match(body, /\.register\(/);
  assert.match(body, /\.catch\(/);
  assert.match(body, /try\s*\{/);
  // Drive the helper against a stub navigator that throws on register.
  const navStub = { serviceWorker: { register: () => { throw new Error("private"); } } };
  const factory = new Function("navigator", "document", "window", body + "\nreturn registerServiceWorker;");
  const fn = factory(navStub, { readyState: "complete" }, {});
  // Must NOT throw.
  let threw = false;
  try { fn(); } catch { threw = true; }
  assert.equal(threw, false, "registerServiceWorker must swallow sync throws");

  // Async failure (promise rejection) must also be swallowed — exercise
  // the rejected-promise path by letting the harness see it.
  const navAsyncReject = {
    serviceWorker: { register: () => Promise.reject(new Error("async-private")) },
  };
  const fn2 = new Function("navigator", "document", "window", body + "\nreturn registerServiceWorker;")
    (navAsyncReject, { readyState: "complete" }, {});
  fn2();
  // Give microtasks a beat to settle without throwing.
  return new Promise<void>((resolve) => setImmediate(() => resolve()));
});

// ────────────────────────────────────────────────────────────────────
// AC7 — app.js renders one amber stale banner with data-testid; tap
// retries; clear on success.
// ────────────────────────────────────────────────────────────────────

interface FakeEl {
  tagName: string;
  className: string;
  innerHTML: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  parentNode: FakeEl | null;
  childNodes: FakeEl[];
  tabIndex?: number;
  listeners: Record<string, ((ev: any) => void)[]>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  hasAttribute(k: string): boolean;
  removeAttribute(k: string): void;
  appendChild(c: FakeEl): FakeEl;
  insertBefore(n: FakeEl, ref: FakeEl): FakeEl;
  remove(): void;
  addEventListener(name: string, fn: (ev: any) => void): void;
  matches(sel: string): boolean;
  querySelector(sel: string): FakeEl | null;
  click(): void;
  contains(c: FakeEl): boolean;
}

function makeFakeDom() {
  function el(tag: string): FakeEl {
    const e: FakeEl = {
      tagName: tag.toUpperCase(),
      className: "",
      innerHTML: "",
      attrs: {},
      style: {},
      parentNode: null,
      childNodes: [],
      listeners: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k] ?? null; },
      hasAttribute(k) { return k in this.attrs; },
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) {
        c.parentNode = this; this.childNodes.push(c); return c;
      },
      insertBefore(n, ref) {
        n.parentNode = this;
        const idx = this.childNodes.indexOf(ref);
        if (idx >= 0) this.childNodes.splice(idx, 0, n);
        else this.childNodes.unshift(n);
        return n;
      },
      remove() {
        if (!this.parentNode) return;
        const i = this.parentNode.childNodes.indexOf(this);
        if (i >= 0) this.parentNode.childNodes.splice(i, 1);
        this.parentNode = null;
      },
      addEventListener(name, fn) {
        (this.listeners[name] ||= []).push(fn);
      },
      matches(sel: string) {
        if (sel.startsWith("[data-testid=")) {
          const want = sel.slice('[data-testid="'.length, -2);
          return this.attrs["data-testid"] === want;
        }
        return false;
      },
      querySelector(sel: string) {
        for (const c of this.childNodes) {
          if (c.matches(sel)) return c;
          const inner = c.querySelector(sel);
          if (inner) return inner;
        }
        return null;
      },
      click() {
        for (const fn of this.listeners["click"] || []) fn({ target: this });
      },
      contains(c: FakeEl): boolean {
        if (c === this) return true;
        for (const child of this.childNodes) if (child.contains(c)) return true;
        return false;
      },
    };
    return e;
  }
  const body = el("body");
  const app = el("div"); app.attrs.id = "app"; body.appendChild(app);
  const doc = {
    body,
    readyState: "complete",
    createElement: (tag: string) => el(tag),
    querySelector(sel: string) {
      if (body.matches(sel)) return body;
      return body.querySelector(sel);
    },
    getElementById(id: string) {
      if (app.attrs.id === id) return app;
      return null;
    },
  };
  return { doc, body, app, el };
}

test("AC7: app.js renderStaleBanner shows one banner with data-testid; clearStaleBanner removes it", () => {
  const src = readFileSync(join(WEB, "app.js"), "utf8");
  const renderSrc = extractFunction(src, "renderStaleBanner");
  const clearSrc = extractFunction(src, "clearStaleBanner");
  const redactSrc = extractFunction(src, "redactSecrets");
  // Build a fake DOM + a fake `app` + a fake `esc`/`redactSecrets`/`route`.
  const { doc, app, el } = makeFakeDom();
  let routeCalls = 0;
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "document", "app", "esc", "redactSecrets", "route",
    renderSrc + "\n" + clearSrc + "\n" +
    "return { renderStaleBanner, clearStaleBanner };",
  );
  const escFn = (s: string) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as any)[c]);
  const redactFn = new Function("s", redactSrc + "\nreturn redactSecrets(s);");
  const route = () => { routeCalls += 1; return Promise.resolve(); };
  const api = factory(doc, app, escFn, redactFn, route);
  // First call: no banner yet → create one with data-testid="stale-banner".
  api.renderStaleBanner({ reason: "offline", lastUrl: "/api/fleet" });
  let banner = doc.querySelector('[data-testid="stale-banner"]') as FakeEl | null;
  assert.ok(banner, "renderStaleBanner must create a banner");
  assert.equal(banner!.attrs["data-testid"], "stale-banner");
  assert.match(banner!.innerHTML, /stale/i);
  // Second call: must NOT duplicate the banner.
  api.renderStaleBanner({ reason: "offline", lastUrl: "/api/fleet" });
  const all = doc.body.childNodes.filter((n: FakeEl) => n.attrs["data-testid"] === "stale-banner");
  assert.equal(all.length, 1, "renderStaleBanner must be idempotent");
  // Tap → invokes route() exactly once.
  banner!.click();
  assert.equal(routeCalls, 1, "tapping the banner must call route()");
  // clearStaleBanner removes it.
  api.clearStaleBanner();
  banner = doc.querySelector('[data-testid="stale-banner"]') as FakeEl | null;
  assert.equal(banner, null, "clearStaleBanner must remove the banner");
});

// ────────────────────────────────────────────────────────────────────
// AC8 — strings flowing into the stale-banner path pass through
// redactSecrets (LESSONS § renderer-boundary redaction).
// ────────────────────────────────────────────────────────────────────

test("AC8: stale-banner reason text passes through redactSecrets — no ghp_… leaks to DOM", () => {
  const src = readFileSync(join(WEB, "app.js"), "utf8");
  const renderSrc = extractFunction(src, "renderStaleBanner");
  const clearSrc = extractFunction(src, "clearStaleBanner");
  const redactSrc = extractFunction(src, "redactSecrets");
  const { doc, app } = makeFakeDom();
  const escFn = (s: string) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as any)[c]);
  const redactFn = new Function("s", redactSrc + "\nreturn redactSecrets(s);");
  const factory = new Function(
    "document", "app", "esc", "redactSecrets", "route",
    renderSrc + "\n" + clearSrc + "\n" +
    "return { renderStaleBanner };",
  );
  const api = factory(doc, app, escFn, redactFn, () => Promise.resolve());
  // Plant a token-shaped string inside the reason field.
  const leaked = "ghp_" + "A".repeat(36) + "Z9";
  api.renderStaleBanner({ reason: leaked, lastUrl: "/api/fleet" });
  const banner = doc.querySelector('[data-testid="stale-banner"]') as FakeEl;
  assert.ok(banner);
  assert.equal(banner.innerHTML.includes(leaked), false,
    "the raw PAT must never reach the DOM (redactSecrets backstop)");
  assert.match(banner.innerHTML, /redacted/);
});

// ────────────────────────────────────────────────────────────────────
// AC9 — src/server.ts serves the new static paths with the right MIME
// types and the Service-Worker-Allowed header on /sw.js.
// ────────────────────────────────────────────────────────────────────

test("AC9: GET /manifest.webmanifest returns application/manifest+json", async () => {
  const b = await boot();
  try {
    const r = await fetch(b.base + "/manifest.webmanifest");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") || "", /application\/manifest\+json/);
    const body = await r.json();
    assert.equal(body.name, "fleet-control");
  } finally { await b.close(); b.cleanup(); }
});

test("AC9: GET /sw.js returns application/javascript + Service-Worker-Allowed: /", async () => {
  const b = await boot();
  try {
    const r = await fetch(b.base + "/sw.js");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") || "", /application\/javascript/);
    assert.equal(r.headers.get("service-worker-allowed"), "/");
    const body = await r.text();
    assert.match(body, /addEventListener\(\s*["']install["']/);
  } finally { await b.close(); b.cleanup(); }
});

test("AC9: GET /icon-192.png and /icon-512.png return image/png", async () => {
  const b = await boot();
  try {
    for (const path of ["/icon-192.png", "/icon-512.png"]) {
      const r = await fetch(b.base + path);
      assert.equal(r.status, 200, path);
      assert.match(r.headers.get("content-type") || "", /image\/png/, path);
      const buf = Buffer.from(await r.arrayBuffer());
      assert.equal(buf[0], 0x89, `${path}[0]`);
      assert.equal(buf[1], 0x50, `${path}[1]`);
    }
  } finally { await b.close(); b.cleanup(); }
});

// ────────────────────────────────────────────────────────────────────
// AC10 — no new runtime deps; tsc clean (covered by the typecheck gate);
// no /api/* JSON-shape break (the synthetic 503 lives in the SW layer);
// mobile viewport contract from 0011 holds (the new banner CSS class is
// margin/colour only — no fixed widths that could induce horizontal
// scroll at 375px).
// ────────────────────────────────────────────────────────────────────

test("AC10: package.json dependencies stays empty (no new runtime deps)", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  assert.deepEqual(pkg.dependencies ?? {}, {},
    "dependencies must stay empty per AGENTS.md Hard NO");
});

test("AC10: existing /api/fleet route still returns its documented JSON shape (no break)", async () => {
  const b = await boot();
  try {
    const r = await fetch(b.base + "/api/fleet");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") || "", /application\/json/);
    const body = await r.json();
    // Required keys per the existing SPA fetcher. The SW's synthetic 503
    // lives entirely in the client layer — the wire shape MUST be
    // unchanged.
    assert.ok(Array.isArray(body.projects), "fleet.projects must be an array");
    assert.ok(body.totals && typeof body.totals === "object", "fleet.totals must be present");
    // The 503 envelope shape MUST NOT appear on the wire from /api/fleet.
    assert.equal(body.stale, undefined,
      "the SW's synthetic stale envelope must never appear on /api/fleet — that's a SW-layer concern");
  } finally { await b.close(); b.cleanup(); }
});

test("AC10: stale-banner CSS is margin/colour only — no fixed width that could overflow 375px", () => {
  const css = readFileSync(join(WEB, "app.js"), "utf8");
  const renderSrc = extractFunction(css, "renderStaleBanner");
  // The banner uses the existing .banner class + an inline `margin` only.
  // No literal `width:` declarations and no min-width >375px slipped in.
  assert.equal(/width\s*:\s*\d+px/i.test(renderSrc), false,
    "stale banner must not pin a fixed pixel width (would overflow 375x812)");
});
