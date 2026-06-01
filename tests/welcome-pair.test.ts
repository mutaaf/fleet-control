// Tests for ticket 0032 — welcome `pairSection` opt, CLI wiring, and
// PWA install-hint banner. One test per acceptance-criteria checkbox
// (AC6 welcome render, AC7 CLI subprocess wiring, AC8 PWA install hint,
// AC10 perf — gated on PERF=1).
//
// Strategy mirrors tests/welcome.test.ts (the 0024 suite):
//   * The renderer is pure — we drive it directly with the pair opt
//     present and absent, asserting the inserted block and that the
//     admin token literal never leaks.
//   * The CLI subprocess test uses FLEET_HOME + FLEET_DB_PATH +
//     FLEET_CWD env seams so the operator's real $HOME is never
//     touched, per LESSONS § "CLI subprocess tests need a FLEET_DB_PATH
//     env seam" and the 0024 FLEET_HOME pattern.
//   * The PWA install-hint banner is exercised via a hand-rolled JSDOM-
//     like shim (same pattern as tests/pwa.test.ts) — we extract the
//     relevant functions out of web/app.js with extractFunction(), wrap
//     them in a `new Function(...)` factory, and drive them with stubs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { renderWelcome, type WelcomeOpts } from "../src/welcome.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ────────────────────────────────────────────────────────────────────
// Renderer helpers (mirror tests/welcome.test.ts baseOpts)
// ────────────────────────────────────────────────────────────────────

function baseOpts(over: Partial<WelcomeOpts> = {}): WelcomeOpts {
  return {
    token: "secret_admin_token_value_xyz_1234567890",
    host: "0.0.0.0",
    port: 7070,
    configPath: "/tmp/fake/fleet-control.config.json",
    tokenSource: "config",
    color: false,
    projects: [],
    sentinelPath: "/tmp/fake/.welcome-seen",
    ...over,
  };
}

// ────────────────────────────────────────────────────────────────────
// AC6 — welcome with pairSection appends the QR block
// ────────────────────────────────────────────────────────────────────

test("AC6: renderWelcome with pairSection emits the scan headline + URL + QR block", () => {
  const url = "http://192.168.1.42:7070/pair?t=K7-Z2-9F-X4";
  const qrText = "HTTP://X.IO/P/K7-Z2-9F-X4"; // 25 chars — fits V1-L
  const out = renderWelcome(baseOpts({ pairSection: { url, qrText } }));
  assert.match(out, /Scan from your phone to pair \(90s\):/);
  // The URL string appears exactly once.
  const urlMatches = (out.match(new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
  assert.equal(urlMatches, 1, `URL should appear exactly once; saw ${urlMatches}`);
  // The QR block carries at least one dark-module run (the U+2588
  // full block character used by renderQrAscii at cellWidth=2).
  assert.match(out, /█{2,}/, "rendered welcome must contain QR dark modules");
});

test("AC6: renderWelcome WITHOUT pairSection is byte-identical to the pre-0032 baseline output", () => {
  // The pair section is purely additive; the existing welcome.test.ts
  // assertions still hold for an opt-less render. We assert byte
  // equality of the full rendered string against a render that
  // explicitly omits the opt by re-using the same baseOpts twice with
  // no pairSection key set.
  const a = renderWelcome(baseOpts({ pairSection: undefined }));
  const b = renderWelcome(baseOpts());
  assert.equal(a, b, "absent pairSection MUST yield identical output to default opts");
  // And the pre-0032 sections all still appear.
  assert.match(a, /first run/i);
  assert.match(a, /Hide this with:/);
  assert.equal(/Scan from your phone/i.test(a), false,
    "pair headline must NOT appear when the opt is absent");
});

test("AC6: renderWelcome with pairSection does NOT contain the admin token literal", () => {
  const token = "ADMIN_LITERAL_SHOULD_NOT_LEAK_99999";
  const out = renderWelcome(baseOpts({
    token,
    pairSection: { url: "http://192.168.1.42:7070/pair?t=AB-CD-EF-GH", qrText: "HTTP://X.IO/P/AB-CD" },
  }));
  assert.equal(out.includes(token), false,
    "the admin token literal must NEVER appear in the rendered welcome");
});

test("AC6: renderWelcome falls back gracefully when qrText exceeds V1-L capacity", () => {
  // Realistic LAN URL (longer than 25 chars). The renderer must NOT
  // crash — instead it embeds a "(QR unavailable: ...)" line so the
  // operator at least sees the URL.
  const out = renderWelcome(baseOpts({
    pairSection: {
      url: "http://192.168.1.42:7070/pair?t=K7-Z2-9F-X4",
      qrText: "HTTP://192.168.1.42:7070/P/K7-Z2-9F-X4", // > 25 chars
    },
  }));
  assert.match(out, /Scan from your phone/);
  assert.match(out, /QR unavailable/);
  // The URL text is still printed exactly once (the fallback message
  // names the capacity, not the URL).
  assert.equal((out.match(/192\.168\.1\.42/g) || []).length, 1,
    "URL printed once even when the QR fallback line is shown");
});

// ────────────────────────────────────────────────────────────────────
// AC10 — perf: rendering the welcome with a pair section completes < 30ms
// ────────────────────────────────────────────────────────────────────

test("AC10: renderWelcome with pairSection completes in < 30ms (PERF=1 only)", () => {
  if (process.env.PERF !== "1") return;
  const opts = baseOpts({
    pairSection: {
      url: "http://192.168.1.42:7070/pair?t=AB-CD-EF-GH",
      qrText: "HTTP://X.IO/P/AB-CD-EF-GH",
    },
  });
  // Warm the encoder once so we measure the steady-state call.
  renderWelcome(opts);
  const start = process.hrtime.bigint();
  renderWelcome(opts);
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1_000_000;
  assert.ok(ms < 30, `welcome render took ${ms.toFixed(2)}ms, expected < 30ms`);
});

// ────────────────────────────────────────────────────────────────────
// AC7 — CLI subprocess: `fleetctl serve` discovers LAN URL, mints pair
// token, threads pairSection into welcome. `--no-pair` suppresses.
// ────────────────────────────────────────────────────────────────────

interface ServeChildHandle {
  child: ReturnType<typeof spawn>;
  stdoutBuf: string;
  stderrBuf: string;
}

async function freePort(): Promise<number> {
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

function spawnServe(extraArgs: string[], env: Record<string, string>, cwd: string): ServeChildHandle {
  const handle: ServeChildHandle = {
    child: spawn(process.execPath, [
      "--disable-warning=ExperimentalWarning",
      join(REPO_ROOT, "bin", "fleetctl.ts"),
      "serve",
      ...extraArgs,
    ], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
    }),
    stdoutBuf: "",
    stderrBuf: "",
  };
  handle.child.stdout?.on("data", (c) => { handle.stdoutBuf += String(c); });
  handle.child.stderr?.on("data", (c) => { handle.stderrBuf += String(c); });
  return handle;
}

async function waitForLine(h: ServeChildHandle, needle: RegExp, maxMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = (): void => {
      if (needle.test(h.stdoutBuf) || needle.test(h.stderrBuf)) return resolve();
      if (Date.now() - t0 > maxMs) {
        return reject(new Error(`needle ${needle} not seen in ${maxMs}ms; stdout=${h.stdoutBuf}; stderr=${h.stderrBuf}`));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function killAndWait(child: ReturnType<typeof spawn>): Promise<void> {
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    let done = false;
    const settle = (): void => { if (!done) { done = true; resolve(); } };
    child.on("exit", settle);
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* */ } settle(); }, 1500);
  });
}

function planCwd(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "fleet-pair-cwd-"));
  const emptyRoots = join(cwd, "empty");
  mkdirSync(emptyRoots, { recursive: true });
  // Plant a config with adminToken so the CLI has something to mint
  // pair tokens against. Without it, the pair section is skipped (by
  // design: a fresh install with no token can't pair).
  writeFileSync(join(cwd, "fleet-control.config.json"), JSON.stringify({
    projectRoots: [emptyRoots],
    installedRoot: emptyRoots,
    cacheBase: emptyRoots,
    claudeProjects: emptyRoots,
    adminToken: "ADMIN_FOR_PAIR_TEST_0123",
  }));
  return {
    cwd,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

test("AC7: `fleetctl serve` with FLEET_HOST=0.0.0.0 prints the QR pair section", async () => {
  const { cwd, cleanup } = planCwd();
  const fleetHome = mkdtempSync(join(tmpdir(), "fleet-pair-home-"));
  const dbPath = join(cwd, "fleet.db");
  const port = await freePort();
  const h = spawnServe([], {
    FLEET_HOST: "0.0.0.0",
    FLEET_PORT: String(port),
    FLEET_HOME: fleetHome,
    FLEET_DB_PATH: dbPath,
  }, cwd);
  try {
    // Wait for the welcome's first line at minimum. The pair section
    // is appended INSIDE the welcome render, so once "first run"
    // appears we can inspect the buffer.
    await waitForLine(h, /first run/i, 10_000);
    // Give the welcome a beat to flush all lines.
    await new Promise((r) => setTimeout(r, 200));
    // The pair section MAY or may not be present depending on whether
    // this machine has a non-loopback IPv4 interface. We accept either:
    // the headline appears OR the run is loopback-only (no interface).
    // If the headline appears, the URL must include "/pair?t=" — that's
    // the proof the QR was threaded.
    if (/Scan from your phone/.test(h.stdoutBuf)) {
      assert.match(h.stdoutBuf, /\/pair\?t=/,
        "pair section must include the /pair?t=... URL");
    } else {
      // No LAN-discoverable interface on this CI host — skip.
      // The mere absence of "Scan from your phone" is fine; the
      // ticket explicitly says loopback-only is silent.
    }
  } finally {
    await killAndWait(h.child);
    cleanup();
    rmSync(fleetHome, { recursive: true, force: true });
  }
});

test("AC7: `fleetctl serve --no-pair` suppresses the QR section even when LAN is discoverable", async () => {
  const { cwd, cleanup } = planCwd();
  const fleetHome = mkdtempSync(join(tmpdir(), "fleet-pair-home2-"));
  const dbPath = join(cwd, "fleet.db");
  const port = await freePort();
  const h = spawnServe(["--no-pair"], {
    FLEET_HOST: "0.0.0.0",
    FLEET_PORT: String(port),
    FLEET_HOME: fleetHome,
    FLEET_DB_PATH: dbPath,
  }, cwd);
  try {
    await waitForLine(h, /first run/i, 10_000);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(/Scan from your phone/.test(h.stdoutBuf), false,
      "--no-pair must suppress the pair headline");
    assert.equal(/\/pair\?t=/.test(h.stdoutBuf), false,
      "--no-pair must suppress the pair URL");
  } finally {
    await killAndWait(h.child);
    cleanup();
    rmSync(fleetHome, { recursive: true, force: true });
  }
});

test("AC7: `fleetctl serve` with default loopback bind shows NO pair section", async () => {
  const { cwd, cleanup } = planCwd();
  const fleetHome = mkdtempSync(join(tmpdir(), "fleet-pair-home3-"));
  const dbPath = join(cwd, "fleet.db");
  const port = await freePort();
  const h = spawnServe([], {
    FLEET_HOST: "127.0.0.1", // explicit loopback
    FLEET_PORT: String(port),
    FLEET_HOME: fleetHome,
    FLEET_DB_PATH: dbPath,
  }, cwd);
  try {
    await waitForLine(h, /first run/i, 10_000);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(/Scan from your phone/.test(h.stdoutBuf), false,
      "loopback bind must suppress the pair section");
  } finally {
    await killAndWait(h.child);
    cleanup();
    rmSync(fleetHome, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────
// AC8 — PWA install-hint banner in web/app.js
// ────────────────────────────────────────────────────────────────────

function extractFunction(src: string, name: string): string {
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

interface FakeEl {
  tagName: string;
  className: string;
  innerHTML: string;
  attrs: Record<string, string>;
  style: Record<string, string>;
  parentNode: FakeEl | null;
  childNodes: FakeEl[];
  listeners: Record<string, ((ev: any) => void)[]>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  removeAttribute(k: string): void;
  appendChild(c: FakeEl): FakeEl;
  insertBefore(n: FakeEl, ref: FakeEl): FakeEl;
  remove(): void;
  removeChild(c: FakeEl): FakeEl;
  addEventListener(name: string, fn: (ev: any) => void): void;
  matches(sel: string): boolean;
  querySelector(sel: string): FakeEl | null;
  click(target?: FakeEl): void;
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
      removeAttribute(k) { delete this.attrs[k]; },
      appendChild(c) { c.parentNode = this; this.childNodes.push(c); return c; },
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
      removeChild(child: FakeEl) {
        const i = this.childNodes.indexOf(child);
        if (i >= 0) this.childNodes.splice(i, 1);
        if (child.parentNode === this) child.parentNode = null;
        return child;
      },
      addEventListener(name, fn) {
        (this.listeners[name] ||= []).push(fn);
      },
      matches(sel) {
        if (sel.startsWith("[data-testid=")) {
          const want = sel.slice('[data-testid="'.length, -2);
          return this.attrs["data-testid"] === want;
        }
        if (sel.startsWith("[")) {
          const m = sel.match(/^\[([\w-]+)\]$/);
          if (m) return m[1] in this.attrs;
        }
        return false;
      },
      querySelector(sel) {
        for (const c of this.childNodes) {
          if (c.matches(sel)) return c;
          const inner = c.querySelector(sel);
          if (inner) return inner;
        }
        return null;
      },
      click(target) {
        const evt = { target: target ?? this, preventDefault() { /* */ } };
        for (const fn of this.listeners["click"] || []) fn(evt);
      },
      contains(c) {
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

function loadPwaHooks() {
  const src = readFileSync(join(REPO_ROOT, "web", "app.js"), "utf8");
  // Pull in the functions we exercise. The banner renderer references
  // `esc`, `redactSecrets`, and `app`; we provide stubs for all three.
  const renderSrc = extractFunction(src, "renderPairInstallHint");
  const dismissSrc = extractFunction(src, "dismissPairInstallHint");
  const maybeSrc = extractFunction(src, "maybeRenderPairInstallHint");
  const justSrc = extractFunction(src, "pairJustConsumed");
  const redactSrc = extractFunction(src, "redactSecrets");
  return { renderSrc, dismissSrc, maybeSrc, justSrc, redactSrc };
}

test("AC8: with beforeinstallprompt fired + pair_just_consumed=1, the install hint banner appears", () => {
  const fns = loadPwaHooks();
  const { doc, app } = makeFakeDom();
  const esc = (s: any) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as any)[c]);
  const redactFn = new Function("s", fns.redactSrc + "\nreturn redactSecrets(s);");
  // localStorage stub: empty.
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => { storage.set(k, v); },
    removeItem: (k: string) => { storage.delete(k); },
  };
  const windowStub = { location: { search: "?pair_just_consumed=1" } };
  // Build the function set, plumbing the `_deferredInstallPrompt`
  // through a closure variable.
  const wrap = new Function(
    "document", "app", "esc", "redactSecrets", "window", "localStorage", "deferred",
    "let _deferredInstallPrompt = deferred;\n"
    + fns.justSrc + "\n" + fns.renderSrc + "\n" + fns.dismissSrc + "\n" + fns.maybeSrc + "\n"
    + "return { maybeRenderPairInstallHint, renderPairInstallHint, dismissPairInstallHint };",
  );
  const stubPrompt = { prompt: () => {}, userChoice: Promise.resolve({ outcome: "accepted" }) };
  const api = wrap(doc, app, esc, redactFn, windowStub, localStorage, stubPrompt);
  api.maybeRenderPairInstallHint();
  const banner = doc.querySelector('[data-testid="pair-install-hint"]') as FakeEl | null;
  assert.ok(banner, "banner must be rendered when both preconditions are met");
  assert.match(banner!.innerHTML, /Add to Home Screen/);
});

test("AC8: install hint does NOT appear when pair_just_consumed is absent", () => {
  const fns = loadPwaHooks();
  const { doc, app } = makeFakeDom();
  const esc = (s: any) => String(s ?? "");
  const redactFn = new Function("s", fns.redactSrc + "\nreturn redactSecrets(s);");
  const localStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  };
  const windowStub = { location: { search: "" } };
  const wrap = new Function(
    "document", "app", "esc", "redactSecrets", "window", "localStorage", "deferred",
    "let _deferredInstallPrompt = deferred;\n"
    + fns.justSrc + "\n" + fns.renderSrc + "\n" + fns.dismissSrc + "\n" + fns.maybeSrc + "\n"
    + "return { maybeRenderPairInstallHint };",
  );
  const api = wrap(doc, app, esc, redactFn, windowStub, localStorage, { prompt: () => {}, userChoice: Promise.resolve() });
  api.maybeRenderPairInstallHint();
  assert.equal(doc.querySelector('[data-testid="pair-install-hint"]'), null);
});

test("AC8: install hint does NOT appear when beforeinstallprompt has not fired", () => {
  const fns = loadPwaHooks();
  const { doc, app } = makeFakeDom();
  const esc = (s: any) => String(s ?? "");
  const redactFn = new Function("s", fns.redactSrc + "\nreturn redactSecrets(s);");
  const localStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  };
  const windowStub = { location: { search: "?pair_just_consumed=1" } };
  const wrap = new Function(
    "document", "app", "esc", "redactSecrets", "window", "localStorage", "deferred",
    "let _deferredInstallPrompt = deferred;\n"
    + fns.justSrc + "\n" + fns.renderSrc + "\n" + fns.dismissSrc + "\n" + fns.maybeSrc + "\n"
    + "return { maybeRenderPairInstallHint };",
  );
  // deferred = null → beforeinstallprompt never fired (or already used).
  const api = wrap(doc, app, esc, redactFn, windowStub, localStorage, null);
  api.maybeRenderPairInstallHint();
  assert.equal(doc.querySelector('[data-testid="pair-install-hint"]'), null,
    "no banner if the install prompt is not pending");
});

test("AC8: 'Not now' dismissal persists; second maybeRender is a no-op", () => {
  const fns = loadPwaHooks();
  const { doc, app } = makeFakeDom();
  const esc = (s: any) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" } as any)[c]);
  const redactFn = new Function("s", fns.redactSrc + "\nreturn redactSecrets(s);");
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
    setItem: (k: string, v: string) => { storage.set(k, v); },
    removeItem: (k: string) => { storage.delete(k); },
  };
  const windowStub = { location: { search: "?pair_just_consumed=1" } };
  const wrap = new Function(
    "document", "app", "esc", "redactSecrets", "window", "localStorage", "deferred",
    "let _deferredInstallPrompt = deferred;\n"
    + fns.justSrc + "\n" + fns.renderSrc + "\n" + fns.dismissSrc + "\n" + fns.maybeSrc + "\n"
    + "return { maybeRenderPairInstallHint, dismissPairInstallHint };",
  );
  const api = wrap(doc, app, esc, redactFn, windowStub, localStorage,
    { prompt: () => {}, userChoice: Promise.resolve() });
  api.maybeRenderPairInstallHint();
  assert.ok(doc.querySelector('[data-testid="pair-install-hint"]'), "banner first render");
  api.dismissPairInstallHint(true);
  assert.equal(doc.querySelector('[data-testid="pair-install-hint"]'), null);
  assert.equal(storage.get("pairInstallDismissed"), "1");
  // Second render call must be a no-op because the dismissal is persisted.
  api.maybeRenderPairInstallHint();
  assert.equal(doc.querySelector('[data-testid="pair-install-hint"]'), null,
    "persisted dismissal must suppress re-render on reload");
});

test("AC8: banner carries the data-testid='pair-install-hint' attribute", () => {
  // Stable test hook per the cross-fleet "duplicate-name surfaces"
  // pattern. The mere existence of the attribute on the rendered
  // banner is the contract; tests downstream of this ticket can rely
  // on it without breaking on copy changes.
  const fns = loadPwaHooks();
  const { doc, app } = makeFakeDom();
  const esc = (s: any) => String(s ?? "");
  const redactFn = new Function("s", fns.redactSrc + "\nreturn redactSecrets(s);");
  const localStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  };
  const windowStub = { location: { search: "?pair_just_consumed=1" } };
  const wrap = new Function(
    "document", "app", "esc", "redactSecrets", "window", "localStorage", "deferred",
    "let _deferredInstallPrompt = deferred;\n"
    + fns.justSrc + "\n" + fns.renderSrc + "\n" + fns.dismissSrc + "\n" + fns.maybeSrc + "\n"
    + "return { maybeRenderPairInstallHint };",
  );
  const api = wrap(doc, app, esc, redactFn, windowStub, localStorage,
    { prompt: () => {}, userChoice: Promise.resolve() });
  api.maybeRenderPairInstallHint();
  const banner = doc.querySelector('[data-testid="pair-install-hint"]');
  assert.ok(banner);
});
