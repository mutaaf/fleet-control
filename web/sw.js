// fleet-control service worker (ticket 0029).
//
// Vanilla — no imports, no build step. The cache name carries a version
// suffix so the `activate` handler can purge any prior shell that doesn't
// match. Bump CACHE_VERSION when any entry of SHELL_ASSETS changes.
//
// Strategy:
//   • install  → openCache(fleet-shell-vN) + addAll(SHELL_ASSETS).
//   • activate → list caches, delete every "fleet-shell-*" whose name
//                doesn't equal CACHE_NAME.
//   • fetch    → network-first for /api/* (live data wins when the laptop
//                is awake; failed fetches synthesise a 503 with body
//                {"stale":true,"reason":"offline"} so the SPA can render a
//                cached snapshot under the amber stale banner).
//                cache-first for everything else (shell loads instantly).
//
// State lives entirely inside the Cache Storage API — no module-level
// Set/Map. Per LESSONS § "in-process dedup sets need an explicit reset
// hook for tests", if we grow process-lifetime state in a future revision
// we MUST expose a `_resetForTests()` seam.

const CACHE_VERSION = "v1";
const CACHE_NAME = "fleet-shell-" + CACHE_VERSION;
const SHELL_ASSETS = [
  "/",
  "/app.js",
  "/style.css",
  "/index.html",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys
        .filter((k) => k.startsWith("fleet-shell-") && k !== CACHE_NAME)
        .map((k) => caches.delete(k)),
    )),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only intercept GETs — POST /api/control/* must always hit the network.
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirstApi(req));
    return;
  }
  event.respondWith(cacheFirstShell(req));
});

function networkFirstApi(req) {
  return fetch(req).catch(() => new Response(
    JSON.stringify({ stale: true, reason: "offline" }),
    { status: 503, headers: { "content-type": "application/json" } },
  ));
}

function cacheFirstShell(req) {
  return caches.match(req).then((hit) => {
    if (hit) return hit;
    return fetch(req).then((res) => {
      // Tuck successful shell fetches into the live cache so the next
      // offline visit serves them without going to the network. Same-origin
      // 200s only — never cache 404s or cross-origin opaque responses.
      if (res && res.status === 200 && res.type === "basic") {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    });
  });
}
