// Fleet control plane SPA (zero-dep). Plain language by default; hash routing.
import { renderDiffHtml, TRUNCATION_MARKER_SNIPPET } from "/diff.js";

const app = document.getElementById("app");
const summary = document.getElementById("fleet-summary");
const foot = document.getElementById("foot");

const PHASE = { ship: "Builds features", groom: "Comes up with ideas", review: "Checks the work", eng: "Tidies the code" };
const STATE = {
  working: ["working", "Working"], idle: ["idle", "Idle · on"], attention: ["attention", "Needs you"],
  expired: ["expired", "Stopped"], off: ["off", "Paused"], halted: ["expired", "Halted · Claude limit"],
};
const OUTCOME = {
  shipped: "shipped a feature", healed: "fixed the last work", "no-op": "nothing to do",
  "reviewed-ok": "checked — looks good", "reviewed-changes": "sent work back", "self-cancel": "stopped (limit)",
  "usage-limit": "blocked — Claude limit",
};

// Ticket 0004: pricing-sync metadata, refreshed once per page load. We store
// just the timestamp + stale flag here; the SPA re-renders the footer string
// on every route change so the relative time stays current as the page
// lingers. `stale=true` → cost figures everywhere get a ⚠ warn marker.
let pricingMeta = { synced_at: null, stale: false, fetched: false };
async function refreshPricingMeta() {
  try {
    const d = await get("/api/pricing");
    pricingMeta = { synced_at: d.synced_at, stale: !!d.stale, fetched: true };
  } catch { /* leave defaults — footer just won't show the line */ }
}
function pricingFooter() {
  if (!pricingMeta.fetched) return "";
  if (!pricingMeta.synced_at) return "pricing not synced yet — run: fleetctl pricing sync";
  const warn = pricingMeta.stale ? " ⚠ pricing may be stale" : "";
  return "pricing synced " + ago(pricingMeta.synced_at) + warn;
}
const usd = (n) => {
  if (n == null) return "—";
  const s = "$" + (+n).toFixed(2);
  // The ⚠ glyph is inline (text, no extra DOM) so existing table layouts
  // don't shift. The title attr surfaces the explanation on hover/long-press;
  // we lean on the surrounding span's title where present rather than wrapping
  // every usd() call in markup. The icon is appended only when stale.
  return pricingMeta.stale ? s + " ⚠" : s;
};
const toks = (n) => (!n ? "0" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : "" + n);
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
function ago(iso) {
  if (!iso) return "—";
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 90) return "just now";
  if (d < 3600) return Math.round(d / 60) + "m ago";
  if (d < 86400) return Math.round(d / 3600) + "h ago";
  return Math.round(d / 86400) + "d ago";
}
function until(iso) {
  if (!iso) return "won’t run";
  const d = (new Date(iso).getTime() - Date.now()) / 1000;
  if (d < 60) return "any moment";
  if (d < 3600) return "in " + Math.round(d / 60) + " min";
  if (d < 86400) return "in " + Math.round(d / 3600) + "h";
  return "in " + Math.round(d / 86400) + "d";
}
// Ticket 0029: any /api/* fetch that the service worker can't reach is
// answered by a synthetic 503 with body `{stale:true, reason:"offline"}`.
// We intercept that here so EVERY caller of get() either receives JSON or
// throws — and the throw triggers the amber stale banner via the catch
// path on the home route. The detection is body-shape based, not status-
// code based: if a server change ever returns 503 for a different reason
// the banner will only fire if `stale === true` in the body.
async function get(p) {
  const r = await fetch(p);
  if (!r.ok) {
    let stale = false; let reason = "";
    if (r.status === 503) {
      try {
        const body = await r.clone().json();
        if (body && body.stale === true) { stale = true; reason = String(body.reason || "offline"); }
      } catch { /* not a stale envelope; fall through */ }
    }
    if (stale) { renderStaleBanner({ reason, lastUrl: p }); throw new Error("stale:" + reason); }
    throw new Error(p);
  }
  clearStaleBanner();
  return r.json();
}

// Ticket 0029: amber stale banner above the inbox/home view. Rendered on
// the home view whenever an /api/* fetch is intercepted by the SW with the
// synthetic 503 envelope (laptop asleep / wifi flap). Tapping the banner
// re-runs the home route — a successful refetch clears it via the get()
// success path; another failure re-renders the banner with whatever reason
// the SW returned. `data-testid="stale-banner"` is the stable test hook
// per the cross-fleet "duplicate-name surfaces" pattern.
function renderStaleBanner({ reason, lastUrl } = {}) {
  // Defence-in-depth per LESSONS § "secret redaction at the renderer
  // boundary": every operator-visible string passes through redactSecrets
  // before it reaches the DOM. A cached payload could contain a leaked
  // ghp_… in a project name or repo URL; the banner is a renderer surface
  // so we strip token-shaped substrings here as a backstop even though
  // the reason text we emit is normally a fixed string.
  const safeReason = esc(redactSecrets(String(reason || "offline")));
  let banner = document.querySelector('[data-testid="stale-banner"]');
  const inner = "Fleet snapshot may be stale — laptop unreachable (" + safeReason + "). Tap to retry.";
  if (banner) { banner.innerHTML = inner; return; }
  banner = document.createElement("div");
  banner.className = "banner stale-banner";
  banner.setAttribute("data-testid", "stale-banner");
  banner.setAttribute("role", "button");
  banner.tabIndex = 0;
  banner.style.cursor = "pointer";
  banner.style.margin = "0 0 12px";
  banner.innerHTML = inner;
  banner.addEventListener("click", () => { route().catch(() => {}); });
  if (app && app.parentNode) app.parentNode.insertBefore(banner, app);
}
function clearStaleBanner() {
  const banner = document.querySelector('[data-testid="stale-banner"]');
  if (banner) banner.remove();
}

// Ticket 0029: register the service worker on load. Failure is swallowed
// silently — Safari private mode disables the SW API, an http:// loopback
// hit a future iOS version doesn't whitelist, etc. The portal MUST keep
// working without the SW; registration is a progressive enhancement.
function registerServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const p = navigator.serviceWorker.register("/sw.js", { scope: "/" });
    if (p && typeof p.catch === "function") p.catch(() => { /* swallow */ });
  } catch { /* swallow — Safari private, file://, etc. */ }
}
if (typeof window !== "undefined") {
  if (document.readyState === "complete") registerServiceWorker();
  else window.addEventListener("load", registerServiceWorker);
}

// Ticket 0032: PWA install hint after a successful phone-pair. The
// /pair route redirects to /?pair_just_consumed=1 on success; if the
// browser has fired `beforeinstallprompt` (per ticket 0029) AND the
// operator hasn't already dismissed the hint, we show a small inline
// banner with the install CTA. Dismissal is persisted in localStorage
// so the banner doesn't re-appear on reload.
let _deferredInstallPrompt = null;
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Stash the event so we can surface it on demand. Per the spec,
    // calling prompt() must happen synchronously from a user gesture.
    if (e && typeof e.preventDefault === "function") e.preventDefault();
    _deferredInstallPrompt = e;
    // Best-effort: if we already landed here via a successful pair
    // consume, fire the banner immediately.
    try { maybeRenderPairInstallHint(); } catch { /* swallow */ }
  });
  window.addEventListener("appinstalled", () => {
    _deferredInstallPrompt = null;
    const b = document.querySelector('[data-testid="pair-install-hint"]');
    if (b && b.parentNode) b.parentNode.removeChild(b);
  });
}

/** Detect a `pair_just_consumed=1` query param. We read from window.location
 *  rather than threading a router because the SPA is hash-routed — the query
 *  param sits on the document URL alongside the hash and persists across
 *  hash navigations until the operator explicitly drops it. */
function pairJustConsumed() {
  if (typeof window === "undefined" || !window.location) return false;
  const search = window.location.search || "";
  return /(?:^|[?&])pair_just_consumed=1(?:&|$)/.test(search);
}

/** Render the PWA install hint banner if all preconditions are met. The
 *  banner carries `data-testid="pair-install-hint"` per the cross-fleet
 *  pattern for stable test hooks. Idempotent: a second call while the
 *  banner is up is a no-op. */
function renderPairInstallHint() {
  if (typeof document === "undefined") return;
  const existing = document.querySelector('[data-testid="pair-install-hint"]');
  if (existing) return;
  // Defence-in-depth per LESSONS § "secret redaction at the renderer
  // boundary": the banner body is a fixed string, but we route it
  // through redactSecrets anyway so a future copy-tweak that splices
  // in a server value (e.g. a project slug) can't leak a token.
  const text = redactSecrets("Add to Home Screen to keep this one tap away");
  const banner = document.createElement("div");
  banner.className = "banner pair-install-hint";
  banner.setAttribute("data-testid", "pair-install-hint");
  banner.style.margin = "0 0 12px";
  banner.innerHTML =
    "<span>" + esc(text) + "</span>"
    + " <button class=\"btn sm primary\" data-pair-install-accept>Install</button>"
    + " <button class=\"btn sm\" data-pair-install-dismiss>Not now</button>";
  banner.addEventListener("click", async (e) => {
    const t = e.target;
    if (!t) return;
    if (t.matches && t.matches("[data-pair-install-accept]")) {
      e.preventDefault();
      try {
        if (_deferredInstallPrompt && typeof _deferredInstallPrompt.prompt === "function") {
          _deferredInstallPrompt.prompt();
          // The result either way dismisses the hint — we don't re-show
          // a banner on "dismissed" because the operator already saw it.
          try { await _deferredInstallPrompt.userChoice; } catch { /* ignore */ }
          _deferredInstallPrompt = null;
        }
      } catch { /* swallow */ }
      dismissPairInstallHint(false);
    } else if (t.matches && t.matches("[data-pair-install-dismiss]")) {
      e.preventDefault();
      dismissPairInstallHint(true);
    }
  });
  if (app && app.parentNode) app.parentNode.insertBefore(banner, app);
}

/** Tear down the banner and (optionally) persist a dismissal so it
 *  doesn't re-appear on reload. */
function dismissPairInstallHint(persist) {
  const b = document.querySelector('[data-testid="pair-install-hint"]');
  if (b && b.parentNode) b.parentNode.removeChild(b);
  if (persist) {
    try { localStorage.setItem("pairInstallDismissed", "1"); } catch { /* private mode */ }
  }
}

/** Guarded entry point: render IFF the operator just paired AND a
 *  beforeinstallprompt is pending AND the operator hasn't permanently
 *  dismissed the hint. Called both from beforeinstallprompt (in case
 *  the SPA already loaded with the pair query) and from the SPA's
 *  initial route() so a late-firing event still surfaces the banner. */
function maybeRenderPairInstallHint() {
  if (!pairJustConsumed()) return;
  if (!_deferredInstallPrompt) return;
  try {
    if (localStorage.getItem("pairInstallDismissed") === "1") return;
  } catch { /* private mode — proceed without persistence */ }
  renderPairInstallHint();
}

// ---- control actions ------------------------------------------------------
function toast(msg, ok = true) {
  let t = document.getElementById("toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.className = ok ? "ok" : "bad"; t.style.opacity = "1";
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.style.opacity = "0"), 3200);
}
async function act(action, body) {
  const tok = localStorage.getItem("fleetToken") || "";
  let r, d;
  try {
    r = await fetch("/api/control/" + action, {
      method: "POST", headers: { "content-type": "application/json", ...(tok ? { "x-fleet-token": tok } : {}) },
      body: JSON.stringify(body),
    });
    d = await r.json();
  } catch { return toast("couldn’t reach the server", false); }
  if (r.status === 401) {
    const t = prompt("This device isn’t paired. Paste the admin token from the server’s terminal:");
    if (t) { localStorage.setItem("fleetToken", t.trim()); return act(action, body); }
    return;
  }
  // "Running" guard — the server says a job is mid-run. Offer a confirm to
  // retry with force=true, which terminates the in-flight launchd label.
  // The operator opted in by clicking the button; we just surface the cost.
  if (!d.ok && d.code === "running" && !body?.force) {
    const phs = Array.isArray(d.running) ? d.running.join(" + ") : "a job";
    const proceed = confirm(`${phs} ${Array.isArray(d.running) && d.running.length === 1 ? "is" : "are"} mid-run.\n\nApplying now will cut the current run short — any in-flight PR will be left for the next cycle to heal.\n\nApply anyway?`);
    if (proceed) return act(action, { ...body, force: true });
    toast("cancelled — try again once the run finishes", false);
    return;
  }
  toast(d.message || (d.ok ? "done" : "failed"), d.ok);
  // Bust local caches on actions that change the data they cache. Otherwise
  // the operator clicks "Clean checkouts" and the panel still shows the old
  // disk usage for up to 60s.
  if (d.ok && action === "clean-checkouts" && body?.slug) _diskCache.delete(body.slug);
  if (d.ok) setTimeout(route, 700);
}
document.addEventListener("click", (e) => {
  const m = e.target.closest("[data-modal]");
  if (m) { e.preventDefault(); openModal(m.dataset.modal, m.dataset.slug); return; }
  const b = e.target.closest("[data-act]");
  if (!b) return;
  e.preventDefault();
  if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
  const body = { slug: b.dataset.slug, phase: b.dataset.phase || undefined, days: b.dataset.days ? +b.dataset.days : undefined, enabled: b.dataset.enabled === "1", number: b.dataset.number ? +b.dataset.number : undefined };
  if (b.dataset.act === "pr-changes") { const note = prompt("What should it change? (sent back to the agent)"); if (note == null) return; body.note = note; }
  act(b.dataset.act, body);
});

// ---- modal forms ("tell it what to build", "add a project") ---------------
function openModal(kind, slug) {
  const wrap = document.createElement("div"); wrap.className = "modal-bg"; wrap.id = "modal";
  let html = "";
  if (kind === "ticket") html = ticketForm(slug);
  else if (kind === "add") html = addForm();
  else if (kind === "cadence") html = cadenceForm(slug);
  else if (kind === "fleet-pace") html = fleetPaceForm();
  else if (kind === "budget") html = budgetForm(slug);
  wrap.innerHTML = `<div class="modal">${html}</div>`;
  wrap.addEventListener("click", (e) => { if (e.target === wrap) wrap.remove(); });
  document.body.appendChild(wrap);
}
const closeModal = () => document.getElementById("modal")?.remove();
function field(id, label, ph, tag = "input") {
  return `<label class="fld"><span>${label}</span>${tag === "textarea" ? `<textarea id="${id}" rows="3" placeholder="${ph}"></textarea>` : `<input id="${id}" placeholder="${ph}">`}</label>`;
}
function ticketForm(slug) {
  return `<h2>Tell ${esc(slug)} what to build</h2>
    <p class="dim">Describe it like you'd tell a teammate. The agent turns each "done when" line into a test.</p>
    ${field("t-title", "What should it build?", "Share weekly recap as an image")}
    ${field("t-story", "Who is it for / why? (optional)", "someone tracking a streak, so they can post it", "textarea")}
    ${field("t-crit", "Done when… (one per line)", "A Share button appears\nTapping it makes a story-sized image", "textarea")}
    <div class="frow">
      <label class="fld"><span>How important</span><select id="t-pri"><option value="P1">Should do</option><option value="P0">Must do soon</option><option value="P2" selected>Maybe someday</option></select></label>
      <label class="fld"><span>Area</span><input id="t-area" placeholder="growth" value="growth"></label>
    </div>
    <label class="chk"><input type="checkbox" id="t-idea"> Save as an idea (review later) instead of adding to the build list</label>
    <div class="frow end"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" data-submit="ticket" data-slug="${esc(slug)}">Add to build list</button></div>`;
}
function addForm() {
  return `<h2>Add a project</h2>
    <p class="dim">Two ways: connect a folder you already have, or paste a GitHub URL and we'll clone it for you.</p>
    ${field("a-path", "Folder path", "/Users/you/Desktop/projects/myapp")}
    ${field("a-name", "Name (optional)", "My App")}
    <div class="frow">
      <label class="fld"><span>Keep running for</span><select id="a-days"><option value="30">30 days</option><option value="90">90 days</option><option value="14">14 days</option></select></label>
      <label class="chk"><input type="checkbox" id="a-eng"> Also let it tidy the code</label>
    </div>
    <div class="frow end"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" data-submit="add">Connect & start</button></div>
    <div class="addurl">
      <div class="dim" style="margin:14px 0 6px">— or —</div>
      ${field("a-url", "Or paste a GitHub URL", "https://github.com/you/myapp")}
      ${field("a-url-slug", "Slug (optional, defaults to repo name)", "myapp")}
      <div class="frow end"><button class="btn primary" data-submit="add-url">Clone &amp; connect</button></div>
    </div>`;
}

// ---- cadence / pace -------------------------------------------------------
//
// Two forms: a per-project "Change schedule" modal (per-phase dropdowns) and a
// fleet-wide "Set pace" modal (named preset → applies to every project).
// Both POST to set-cadence / set-pace-fleet — the underlying engine writes
// SHIP_HOURS et al. to each project's agents.config.sh and reinstalls launchd.

// Preset name → human label so the modal can show "Currently: Conservative".
const PACE_LABEL = {
  aggressive: "Aggressive — fastest (current default)",
  steady: "Steady — every 2 hours",
  conservative: "Conservative — every 6 hours",
  trickle: "Trickle — twice a day",
  custom: "Custom — fine-tuned per phase",
};
function paceOptions(selected) {
  return Object.entries(PACE_LABEL).filter(([k]) => k !== "custom")
    .map(([k, lbl]) => `<option value="${k}"${selected === k ? " selected" : ""}>${lbl}</option>`).join("");
}

// Per-phase dropdown values that map to the manifest variables.
const SHIP_OPTIONS = [
  { label: "Every hour (default)", ship_hours: "" },
  { label: "Every 2 hours", ship_hours: "0 2 4 6 8 10 12 14 16 18 20 22" },
  { label: "Every 4 hours", ship_hours: "0 4 8 12 16 20" },
  { label: "Every 6 hours", ship_hours: "0 6 12 18" },
  { label: "Every 12 hours", ship_hours: "0 12" },
  { label: "Once a day", ship_hours: "0" },
];
const GROOM_OPTIONS = [
  { label: "4× a day (default)", groom_hours: "0 6 12 18" },
  { label: "Twice a day", groom_hours: "0 12" },
  { label: "Once a day", groom_hours: "0" },
];
const REVIEW_OPTIONS = [
  { label: "Every 5 min (default)", review_interval: "300" },
  { label: "Every 15 min", review_interval: "900" },
  { label: "Every 30 min", review_interval: "1800" },
  { label: "Every hour", review_interval: "3600" },
];

function cadenceForm(slug) {
  // The current cadence values for this project arrive via window._cadenceFor
  // — the project page sets that just before opening the modal so the dropdowns
  // start on whatever the current schedule is.
  const cad = (window._cadenceFor && window._cadenceFor[slug]) || {};
  const pace = (window._paceFor && window._paceFor[slug]) || "custom";
  const sel = (opts, key) => opts.map((o) =>
    `<option value="${o[key] ?? ""}"${(cad[key] ?? "") === (o[key] ?? "") ? " selected" : ""}>${o.label}</option>`).join("");
  return `<h2>How often should ${esc(slug)} run?</h2>
    <p class="dim">Currently: <b>${PACE_LABEL[pace] || pace}</b>. Pick a different schedule per phase below.</p>
    <label class="fld"><span>Builds features (ship)</span>
      <select id="c-ship">${sel(SHIP_OPTIONS, "ship_hours")}</select></label>
    <label class="fld"><span>Comes up with ideas (groom)</span>
      <select id="c-groom">${sel(GROOM_OPTIONS, "groom_hours")}</select></label>
    <label class="fld"><span>Checks the work (review)</span>
      <select id="c-review">${sel(REVIEW_OPTIONS, "review_interval")}</select></label>
    <p class="dim" style="font-size:12px">Slower schedules help when GitHub/CI is rate-limiting you or you're managing a usage limit.</p>
    <div class="frow end">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" data-submit="cadence" data-slug="${esc(slug)}">Apply</button>
    </div>`;
}

// ---- budget cap -----------------------------------------------------------
//
// Per-project daily $ cap (MAX_DAILY_USD in agents.config.sh). The engine
// soft-aborts the next run when today's UTC spend reaches the cap, emitting
// a `budget_block` event. Empty / 0 = no cap (current default).
function budgetForm(slug) {
  const cad = (window._cadenceFor && window._cadenceFor[slug]) || {};
  const current = cad.max_daily_usd || "";
  const placeholder = current ? "" : "e.g. 20";
  return `<h2>Daily $ cap for ${esc(slug)}</h2>
    <p class="dim">When today's UTC spend reaches this, the next run soft-aborts and writes a <code>budget_block</code> event. Leave empty to remove the cap.</p>
    <label class="fld"><span>Cap ($ per day)</span>
      <input id="b-cap" type="number" min="0" step="0.01" value="${esc(current)}" placeholder="${placeholder}"></label>
    <p class="dim" style="font-size:12px">Currently: ${current ? `<b>$${esc(current)}</b> per day` : "<b>no cap</b>"}. The cap kicks in on the next scheduled run, not the one in flight.</p>
    <div class="frow end">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" data-submit="budget" data-slug="${esc(slug)}">Apply</button>
    </div>`;
}

function fleetPaceForm() {
  // Show the current pace of each project so the operator can see whether
  // the fleet is already mixed (e.g. one project on trickle, others on default).
  const rows = (window._allPaces || []).map(({ slug, pace }) =>
    `<div class="kv"><span class="lbl">${esc(slug)}</span>${esc(PACE_LABEL[pace] || pace)}</div>`).join("");
  return `<h2>Set the fleet pace</h2>
    <p class="dim">Slow every project down at once. Useful when one repo's CI is rate-limiting you or your Anthropic usage is tight. Per-project tuning is still available on each project's page.</p>
    ${rows ? `<div class="kvbox" style="margin:8px 0 12px">${rows}</div>` : ""}
    <label class="fld"><span>New pace for everyone</span>
      <select id="fp-preset">${paceOptions("conservative")}</select></label>
    <p class="dim" style="font-size:12px">Projects with a currently-running job are skipped — the modal will tell you which ones you need to retry.</p>
    <div class="frow end">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn primary" data-submit="fleet-pace">Apply to all projects</button>
    </div>`;
}
document.addEventListener("click", (e) => {
  const s = e.target.closest("[data-submit]");
  if (!s) return;
  e.preventDefault();
  if (s.dataset.submit === "ticket") {
    const v = (id) => document.getElementById(id).value.trim();
    if (!v("t-title")) return toast("a title is required", false);
    act("create-ticket", { slug: s.dataset.slug, title: v("t-title"), story: v("t-story"),
      criteria: v("t-crit").split("\n").map((x) => x.trim()).filter(Boolean),
      priority: document.getElementById("t-pri").value, area: v("t-area") || "growth",
      idea: document.getElementById("t-idea").checked });
  } else if (s.dataset.submit === "add-url") {
    // Ticket 0010: one-click GitHub-URL import. Client-side regex matches
    // the server's GH_URL_RE so the toast lands before the round-trip.
    const v = (id) => document.getElementById(id).value.trim();
    const url = v("a-url");
    if (!url) return toast("a GitHub URL is required", false);
    if (!/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(\.git)?$/.test(url)) {
      return toast("URL must look like https://github.com/<owner>/<name>", false);
    }
    act("register-url", {
      repo_url: url,
      slug: v("a-url-slug") || undefined,
      days: +document.getElementById("a-days").value,
      eng: document.getElementById("a-eng").checked,
    });
  } else if (s.dataset.submit === "cadence") {
    // Per-phase form. We send the manifest keys directly so the server can
    // apply any subset (omitted dropdowns stay at their current values).
    const ship = document.getElementById("c-ship").value;
    const groom = document.getElementById("c-groom").value;
    const review = document.getElementById("c-review").value;
    act("set-cadence", { slug: s.dataset.slug, SHIP_HOURS: ship, GROOM_HOURS: groom, REVIEW_INTERVAL: review });
  } else if (s.dataset.submit === "fleet-pace") {
    const preset = document.getElementById("fp-preset").value;
    if (!confirm(`Apply "${preset}" pace to every project? Currently-running jobs will be skipped.`)) return;
    act("set-pace-fleet", { preset });
  } else if (s.dataset.submit === "budget") {
    const raw = document.getElementById("b-cap").value.trim();
    if (raw && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) {
      return toast("cap must be a non-negative number", false);
    }
    act("set-budget", { slug: s.dataset.slug, max_daily_usd: raw });
  } else if (s.dataset.submit === "add") {
    const v = (id) => document.getElementById(id).value.trim();
    if (!v("a-path")) return toast("a folder path is required", false);
    act("register", { path: v("a-path"), name: v("a-name"), days: +document.getElementById("a-days").value, eng: document.getElementById("a-eng").checked });
  }
  closeModal();
});

let timer = null;
let liveES = null; // live tool-call EventSource (ticket 0002)
const stop = () => {
  if (timer) { clearInterval(timer); timer = null; }
  if (liveES) { try { liveES.close(); } catch (_) { /* */ } liveES = null; }
};

/** Open an EventSource against /api/projects/:slug/stream and pipe each
 *  parsed event into a single "Live now" line in the project view. The
 *  server tail closes after 5 min idle or on transcript rotation; the
 *  rotate handler re-renders the panel by triggering a route refresh. */
function attachLiveStream(slug) {
  if (liveES) { try { liveES.close(); } catch (_) { /* */ } liveES = null; }
  const tok = localStorage.getItem("fleetToken") || "";
  const qs = tok ? "?token=" + encodeURIComponent(tok) : "";
  let es;
  try { es = new EventSource("/api/projects/" + encodeURIComponent(slug) + "/stream" + qs); }
  catch (_) { return; }
  liveES = es;
  const render = (kind, label) => {
    const el = document.getElementById("live-now");
    if (!el) return;
    el.classList.remove("hidden");
    el.innerHTML = `<span class="dot working"></span><span class="lbl">live</span> ${esc(kind)} <span class="faint">· ${esc(label)}</span>`;
  };
  es.addEventListener("tool-call", (ev) => {
    try { const d = JSON.parse(ev.data); render(d.name || "tool", d.input_head || ""); } catch (_) { /* */ }
  });
  es.addEventListener("text", (ev) => {
    try { const d = JSON.parse(ev.data); render("thinking", (d.text || "").slice(0, 120)); } catch (_) { /* */ }
  });
  es.addEventListener("idle-close", () => { try { es.close(); } catch (_) { /* */ } if (liveES === es) liveES = null; });
  es.addEventListener("rotate", () => {
    // A new run started — re-fetch the project view so the "running" badge
    // and last-run summary flip over without waiting for the 5s poll.
    setTimeout(() => { if (location.hash === "#/p/" + slug) project(slug).catch(() => {}); }, 50);
  });
  es.onerror = () => { /* network blip — EventSource auto-reconnects via retry: 5000 */ };
}

function telemetry(arr) {
  if (!arr || !arr.length) return "";
  return `<div class="telemetry">${arr.map((o) => `<span class="tick ${esc(o ?? "no-op")}"></span>`).join("")}</div>`;
}

// ---- Home -----------------------------------------------------------------
// Ticket 0012: weekly digest banner. We fetch the digest in parallel with
// /api/fleet so the home render isn't slowed by a second round-trip; the
// banner is rendered above the alerts and "Your projects" list. Tapping it
// expands the per-project rows inline. Errors fall through silently — the
// home page must still render if the digest endpoint is unavailable.
async function fetchDigest() {
  try { return await get("/api/digest/week"); } catch { return null; }
}

// Ticket 0017: today's inbox. One cross-fleet pull above the project
// grid that answers "anything I need to do?" Errors fall through
// silently — the home page still renders if the inbox endpoint is
// unavailable. `renderInbox` returns "" for null/empty so we can use
// the same string concat as `digestBanner` does.
async function fetchInbox() {
  try { return await get("/api/fleet/inbox"); } catch { return null; }
}

// Ticket 0026: merge streak counter + 90-day calendar heatmap. Sits
// ABOVE the inbox on home — the morning portal-open hook ("the
// streak is alive") before "what needs me". Errors fall through
// silently: the home page still renders if the streak endpoint is
// unavailable. `renderStreak` returns "" on null so we can use the
// same string concat as `renderInbox` / `digestBanner`.
async function fetchStreak() {
  try { return await get("/api/fleet/streak"); } catch { return null; }
}

// Ticket 0033: "Yesterday at a glance" morning card. One trailing-24h
// summary above the inbox: shipped count, dollars spent today, open
// anomalies, fleet streak, plus a single verdict line. Lazy-fetched
// from /api/fleet/glance so the home payload stays small and the SW
// cache (0029) can satisfy a phone refresh inside the 60s window.
// Errors fall through silently — the card just disappears for that
// render cycle and the rest of the home page still loads.
async function fetchGlance() {
  try { return await get("/api/fleet/glance"); } catch { return null; }
}

// Ticket 0035: "Cost per merged PR" headline summary. One trailing-14d
// summary above the 0033 glance card: dollars per merged PR, count of
// PRs shipped, total spend, window length. Lazy-fetched from
// /api/fleet/cost-per-pr so the home payload stays small and the
// existing SW cache (0029) survives a phone refresh inside the 5-min
// window. Errors fall through silently — the summary line just
// disappears for that render cycle and the rest of the home page still
// loads.
async function fetchCostPerPr() {
  try { return await get("/api/fleet/cost-per-pr"); } catch { return null; }
}

/** Skeleton block shown while /api/fleet/glance is in flight. Carries
 *  `aria-busy="true"` so screen readers announce the loading state;
 *  the pulsing animation flattens under
 *  `prefers-reduced-motion: reduce` via the matching CSS rule. The
 *  container has the same `data-testid` as the resolved card so the
 *  phone tests' selector is stable across loading vs loaded. */
function renderGlanceSkeleton() {
  return `<div class="yesterday-glance yesterday-glance-skeleton" data-testid="yesterday-glance" aria-busy="true">
    <div class="glance-title">Last 24 hours</div>
    <div class="glance-stats">
      <span class="glance-stat skeleton-bar" aria-hidden="true"></span>
      <span class="glance-stat skeleton-bar" aria-hidden="true"></span>
      <span class="glance-stat skeleton-bar" aria-hidden="true"></span>
      <span class="glance-stat skeleton-bar" aria-hidden="true"></span>
    </div>
    <div class="glance-verdict skeleton-bar" aria-hidden="true"></div>
  </div>`;
}

/** Render the loaded "Yesterday at a glance" card. Tapping anywhere
 *  navigates to the weekly digest route (#/digest, per ticket 0012).
 *  Per LESSONS § "defence-in-depth secret redaction at the renderer
 *  boundary": verdict.project_slug + verdict.message pass through
 *  redactSecrets before insertion so any future ingest regression
 *  that smuggles a token-shaped substring into a project slug is
 *  defanged at the render boundary. */
function renderYesterdayGlance(data) {
  if (!data) return "";
  const shipped = Number(data.shipped_count || 0);
  const spent = Number(data.spent_usd || 0);
  const anomalies = Number(data.anomalies_open || 0);
  const streak = Number(data.streak_days || 0);
  const v = data.verdict || { kind: "all_quiet", message: "" };
  // Defence-in-depth: redact tokens before any HTML interpolation.
  const safeMessage = esc(redactSecrets(String(v.message || "")));
  const safeKind = esc(String(v.kind || ""));
  // Tap-anywhere navigates to the digest (the user story's
  // "[tap for digest]" affordance). Internal hash route — the
  // existing routing already handles it.
  return `<a class="yesterday-glance" data-testid="yesterday-glance" href="#/digest" aria-label="Last 24 hours — tap for digest">
    <div class="glance-title">Last 24 hours <span class="glance-tap-hint dim">tap for digest</span></div>
    <div class="glance-stats">
      <span class="glance-stat"><b>${shipped}</b> PR${shipped === 1 ? "" : "s"} shipped</span>
      <span class="glance-stat"><b>${usd(spent)}</b> spent</span>
      <span class="glance-stat"><b>${anomalies}</b> anomal${anomalies === 1 ? "y" : "ies"}</span>
      <span class="glance-stat"><b>${streak}</b> day${streak === 1 ? "" : "s"} streak</span>
    </div>
    <div class="glance-verdict glance-verdict-${safeKind}">${safeMessage}</div>
  </a>`;
}

// ────────────────────────────────────────────────────────────────────
// Ticket 0035: cost per merged PR.
//
// One-line summary at the very top of the home page (above the 0033
// glance card): "$2.37 per merged PR · 28 PRs · $66.36 spent · last
// 14d". When there are zero merged PRs in window, the line collapses
// to "No merged PRs yet · $X spent · last <days>d" (no division).
// Tap-anywhere navigates to #/cost-per-pr where the detail table
// renders sortable rows + a fleet-rollup row.
//
// Per LESSONS § "defence-in-depth secret redaction at the renderer
// boundary": every interpolated string passes through redactSecrets
// before HTML insertion. This surface has no operator-supplied text
// today (only numbers + slug-shape strings), but the pattern stays
// consistent with the rest of the renderer layer so a future field
// addition can't smuggle a token-shape string into the DOM.
// ────────────────────────────────────────────────────────────────────

/** Render the one-line "$ per merged PR" summary. Quiet hours do NOT
 *  alter this surface — it's a pull view, not a push notification
 *  (ticket 0030 gates pushes only). */
function renderCostPerPrSummary(data) {
  if (!data) return "";
  const fleet = data.fleet || {};
  const days = Number(data.window && data.window.days) || 14;
  const spent = Number(fleet.spent_usd || 0);
  const prs = Number(fleet.prs_merged || 0);
  // Defence-in-depth: route the (small) interpolated strings through
  // redactSecrets even though they are numbers/integers today.
  const daysLabel = esc(redactSecrets(`last ${days}d`));
  let body;
  if (fleet.dollars_per_pr == null) {
    // Empty / no-merges branch: no division, just the spend + window.
    body = `<span class="cost-per-pr-empty">No merged PRs yet</span>`
      + ` <span class="cost-per-pr-sep">·</span>`
      + ` <span class="cost-per-pr-stat"><b>${usd(spent)}</b> spent</span>`
      + ` <span class="cost-per-pr-sep">·</span>`
      + ` <span class="cost-per-pr-stat dim">${daysLabel}</span>`;
  } else {
    const dpp = Number(fleet.dollars_per_pr);
    body = `<span class="cost-per-pr-headline"><b>${usd(dpp)}</b> per merged PR</span>`
      + ` <span class="cost-per-pr-sep">·</span>`
      + ` <span class="cost-per-pr-stat"><b>${prs}</b> PR${prs === 1 ? "" : "s"} shipped</span>`
      + ` <span class="cost-per-pr-sep">·</span>`
      + ` <span class="cost-per-pr-stat"><b>${usd(spent)}</b> spent</span>`
      + ` <span class="cost-per-pr-sep">·</span>`
      + ` <span class="cost-per-pr-stat dim">${daysLabel}</span>`;
  }
  return `<a class="cost-per-pr-summary" data-testid="cost-per-pr-summary"`
    + ` href="#/cost-per-pr" aria-label="Cost per merged PR — tap for breakdown">${body}</a>`;
}

/** Format a trend percentage cell. Null prior baseline → em-dash. The
 *  arrow glyph is text-only so existing table layouts don't shift. */
function formatTrendCell(trendPct) {
  if (trendPct == null) return `<span class="cost-per-pr-trend cost-per-pr-trend-none">—</span>`;
  const v = Number(trendPct);
  const sign = v > 0 ? "up" : (v < 0 ? "down" : "flat");
  const arrow = sign === "up" ? "▲" : sign === "down" ? "▼" : "·";
  const cls = `cost-per-pr-trend cost-per-pr-trend-${sign}`;
  const pct = Math.abs(v).toFixed(0) + "%";
  return `<span class="${cls}">${arrow} ${pct}</span>`;
}

const COST_PER_PR_SORT_DIR = { asc: 1, desc: -1 };
let _costPerPrSortState = { col: "dollars_per_pr", dir: "desc" };

/** Sort project rows by the configured column + direction. Rows with
 *  `dollars_per_pr === null` ALWAYS sort to the bottom regardless of
 *  direction (per AC7). */
function sortCostPerPrRows(rows, col, dir) {
  const sign = COST_PER_PR_SORT_DIR[dir] || -1;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    // Null-$/PR rows always sink to the bottom.
    const aNull = a.dollars_per_pr == null;
    const bNull = b.dollars_per_pr == null;
    if (aNull && bNull) return String(a.slug).localeCompare(String(b.slug));
    if (aNull) return 1;
    if (bNull) return -1;
    const av = a[col];
    const bv = b[col];
    // Strings (slug) sort lexicographically; numbers do numeric.
    if (typeof av === "string" && typeof bv === "string") {
      return sign * av.localeCompare(bv);
    }
    const an = Number(av);
    const bn = Number(bv);
    if (Number.isFinite(an) && Number.isFinite(bn)) {
      return sign * (an - bn);
    }
    return 0;
  });
  return sorted;
}

/** Detail page for /cost-per-pr. Sortable table; fleet-rollup row is
 *  appended as the last visual row with a CSS border-top separator
 *  (per AC7). */
function renderCostPerPrDetail(data) {
  if (!data) {
    return `<a class="back" href="#/">‹ all projects</a>
      <div class="loading">no data yet for the cost-per-PR breakdown.</div>`;
  }
  const days = Number(data.window && data.window.days) || 14;
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const fleet = data.fleet || {};
  const sortCol = _costPerPrSortState.col;
  const sortDir = _costPerPrSortState.dir;
  const sorted = sortCostPerPrRows(projects, sortCol, sortDir);
  const headers = [
    { key: "slug", label: "project" },
    { key: "spent_usd", label: `${days}d $` },
    { key: "prs_merged", label: "PRs" },
    { key: "dollars_per_pr", label: "$/PR" },
    { key: "trend_pct", label: "trend" },
  ];
  const thRow = headers.map((h) => {
    const active = h.key === sortCol;
    const ind = active ? (sortDir === "asc" ? " ▲" : " ▼") : "";
    return `<th data-sort-key="${esc(h.key)}" class="${active ? "active" : ""}">`
      + `${esc(h.label)}${ind}</th>`;
  }).join("");
  const projRow = (p) => {
    const slug = esc(redactSecrets(String(p.slug || "")));
    const dpp = p.dollars_per_pr == null
      ? `<span class="cost-per-pr-na">—</span>`
      : `${esc(usd(p.dollars_per_pr))}`;
    return `<tr class="cost-per-pr-row" data-slug="${slug}">`
      + `<td class="cost-per-pr-slug"><a href="#/p/${slug}"><b>${slug}</b></a></td>`
      + `<td class="cost-per-pr-spent mono">${esc(usd(p.spent_usd))}</td>`
      + `<td class="cost-per-pr-prs mono">${Number(p.prs_merged) || 0}</td>`
      + `<td class="cost-per-pr-dpp mono">${dpp}</td>`
      + `<td class="cost-per-pr-trendcell mono">${formatTrendCell(p.trend_pct)}</td>`
      + `</tr>`;
  };
  const fleetDpp = fleet.dollars_per_pr == null
    ? `<span class="cost-per-pr-na">—</span>`
    : `${esc(usd(fleet.dollars_per_pr))}`;
  const fleetRow = `<tr class="cost-per-pr-row cost-per-pr-fleet-row" data-testid="cost-per-pr-fleet-row">`
    + `<td class="cost-per-pr-slug"><b>fleet</b></td>`
    + `<td class="cost-per-pr-spent mono">${esc(usd(fleet.spent_usd || 0))}</td>`
    + `<td class="cost-per-pr-prs mono">${Number(fleet.prs_merged) || 0}</td>`
    + `<td class="cost-per-pr-dpp mono">${fleetDpp}</td>`
    + `<td class="cost-per-pr-trendcell mono">${formatTrendCell(fleet.trend_pct)}</td>`
    + `</tr>`;
  return `<a class="back" href="#/">‹ all projects</a>
    <div class="card-head"><span class="pname">Fleet · Cost per merged PR</span>
      <span class="state dim mono">last ${days} days</span></div>
    <div class="cost-per-pr-detail">
      <table class="cost-per-pr-table" data-testid="cost-per-pr-table">
        <thead><tr>${thRow}</tr></thead>
        <tbody>${sorted.map(projRow).join("") || `<tr><td colspan="5" class="dim">no projects with PR data in the window</td></tr>`}${fleetRow}</tbody>
      </table>
    </div>`;
}

/** Hash-route handler: render the cost-per-PR detail page. Pulls the
 *  API once, stores the data in a module-level cache so click handlers
 *  on the header cells can re-sort without re-fetching. */
let _costPerPrLastData = null;
async function costPerPr() {
  let d;
  try { d = await get("/api/fleet/cost-per-pr"); }
  catch (e) {
    app.innerHTML = `<div class="loading">couldn't load cost-per-PR.<br><span class="dim">${esc(e.message)}</span></div>`;
    return;
  }
  _costPerPrLastData = d;
  summary.innerHTML = `<a href="#/" class="dim">‹ all projects</a>`;
  app.innerHTML = renderCostPerPrDetail(d);
  foot.textContent = "window: " + d.window.start + " → " + d.window.end + " (" + d.window.days + " days)";
}

// Click delegate for the sortable header cells. Reads data-sort-key
// from the <th> and re-renders against the cached payload.
document.addEventListener("click", (e) => {
  const th = e.target && e.target.closest && e.target.closest(".cost-per-pr-table th[data-sort-key]");
  if (!th) return;
  const col = th.getAttribute("data-sort-key");
  if (!col) return;
  if (_costPerPrSortState.col === col) {
    _costPerPrSortState.dir = _costPerPrSortState.dir === "asc" ? "desc" : "asc";
  } else {
    _costPerPrSortState.col = col;
    _costPerPrSortState.dir = "desc";
  }
  if (_costPerPrLastData) {
    app.innerHTML = renderCostPerPrDetail(_costPerPrLastData);
  }
});

// Mobile collapse expand toggle: tapping a row on phones expands the
// hidden columns inline. The fleet-rollup row is always expanded.
document.addEventListener("click", (e) => {
  const row = e.target && e.target.closest && e.target.closest(".cost-per-pr-row");
  if (!row) return;
  if (row.classList.contains("cost-per-pr-fleet-row")) return;
  // Don't intercept clicks on the embedded project link.
  if (e.target.tagName === "A") return;
  row.classList.toggle("expanded");
});

const STREAK_BAND_TITLE = {
  empty: "no activity",
  low: "1 merged",
  med: "merged",
  high: "merged",
  red: "broke the streak",
};

function renderHeatmap(cells) {
  // Cells arrive chronologically (oldest → today). The GitHub-shape
  // grid is 13 columns × 7 rows; column-major fill so each column
  // is one week. CSS grid handles the visual layout — we just emit
  // 91 buttons in chronological order with `grid-column` / `grid-row`
  // hints so the browser places them in the right cells.
  //
  // Why 91 visual cells but 90 data cells: 13 × 7 = 91. The extra
  // cell is reserved for "today's column starts mid-week" alignment
  // — we render an empty placeholder for the first cell only when
  // today's weekday demands it. For simplicity (and to keep the AC
  // wording "91 cells" honest) we render 91 cells: 90 data cells
  // followed by a single trailing empty placeholder. The visual
  // effect is a clean 13×7 grid.
  if (!cells || cells.length === 0) return "";
  const today = new Date();
  const todayWeekday = today.getUTCDay(); // 0 = Sun, 6 = Sat
  const buttons = cells.map((c, idx) => {
    // Column-major: cells are emitted in chronological order; the
    // CSS grid auto-flow column places them left-to-right, top-to-
    // bottom inside each column.
    const title = c.band === "empty"
      ? `${c.date}: no activity`
      : c.band === "red"
        ? `${c.date}: ${c.failed} unrecovered failure${c.failed === 1 ? "" : "s"}, ${c.merged} merged`
        : `${c.date}: ${c.merged} PR${c.merged === 1 ? "" : "s"} merged`;
    return `<button type="button" class="heatmap-cell band-${esc(c.band)}"`
      + ` aria-label="${esc(title)}" title="${esc(title)}"`
      + ` data-streak-cell="${esc(c.date)}"`
      + ` data-merged="${c.merged}" data-failed="${c.failed}"></button>`;
  }).join("");
  // The placeholder fills 91 - 90 = 1 cell so the grid is square.
  // It carries aria-hidden so screen-readers skip it.
  const placeholder = `<span class="heatmap-cell band-placeholder" aria-hidden="true"></span>`;
  return `<div class="heatmap" role="grid" aria-label="Fleet merge heatmap, last 90 days">${buttons}${placeholder}</div>`;
}

function renderStreak(data) {
  if (!data) return "";
  const streak = data.streak_days || 0;
  const lastRed = data.last_red_day;
  // Empty-state copy is verbatim per the ticket — same shape as the
  // inbox-zero line. Reads "starting today" when streak === 0.
  const line = streak === 0
    ? `<span class="streak-line">Fleet streak: starting today</span>`
    : `<span class="streak-line"><b class="streak-days">${streak}</b> day${streak === 1 ? "" : "s"} of green ships`
      + (lastRed ? ` <span class="dim">· last red day ${esc(lastRed)}</span>` : "")
      + `</span>`;
  return `<div class="streak-banner" data-streak-banner>
    <div class="eyebrow">Fleet streak</div>
    <div class="streak-row">${line}</div>
    ${renderHeatmap(data.heatmap || [])}
  </div>`;
}

// Tap/click toggle for heatmap cells — mobile-friendly (no
// hover-only path per 0011). Click toggles a tooltip on the cell;
// clicking outside closes it. We piggyback on the cell's `title`
// attribute (the browser's native tooltip) for hover-capable
// devices, and surface the same text via a click-bound tooltip
// node for touch. The tooltip is recreated each click so it
// always reflects the live cell payload.
document.addEventListener("click", (e) => {
  const cell = e.target.closest("[data-streak-cell]");
  if (!cell) {
    // Outside the heatmap: tear down any open tooltip.
    const open = document.querySelector(".heatmap-tooltip");
    if (open && open.parentNode) open.parentNode.removeChild(open);
    return;
  }
  e.preventDefault();
  // Remove any existing tooltip first.
  const open = document.querySelector(".heatmap-tooltip");
  if (open && open.parentNode) open.parentNode.removeChild(open);
  const date = cell.dataset.streakCell;
  const merged = +cell.dataset.merged || 0;
  const failed = +cell.dataset.failed || 0;
  const label = failed > 0
    ? `${date}: ${failed} unrecovered, ${merged} merged`
    : merged > 0
      ? `${date}: ${merged} PR${merged === 1 ? "" : "s"} merged`
      : `${date}: no activity`;
  const tip = document.createElement("div");
  tip.className = "heatmap-tooltip";
  tip.textContent = label;
  cell.parentNode.appendChild(tip);
  // Auto-close after 3.5 seconds.
  setTimeout(() => {
    if (tip.parentNode) tip.parentNode.removeChild(tip);
  }, 3500);
});

const INBOX_KIND_LABEL = {
  pr_review: "PR awaits review",
  anomaly_open: "Anomaly fired",
  snapshot_expiring: "Snapshot expires soon",
  run_failed: "Last run failed",
  // Ticket 0027: a fleet-wide pattern — the same failure signature
  // hitting N projects within 24h.
  fleet_correlation: "Fleet pattern",
  // Ticket 0034: per-project shape drift — the project's last 24h
  // diverges from its OWN 14-day baseline on one of three metrics
  // (Bash share / Edit-Read ratio / median run cost).
  self_drift: "Shape drift",
};

// Ticket 0034: human-readable copy for each drift metric. Used by the
// inbox row + the detail view so the operator sees "Bash share 3.2x
// normal" rather than the raw machine name.
const DRIFT_METRIC_LABEL = {
  bash_share: "Bash share",
  edit_read_ratio: "Edit/Read ratio",
  median_run_cost_usd: "Median run cost",
};

// Ticket 0027: defence-in-depth secret redaction at the renderer
// boundary (mirrors src/doctor.ts's redactSecrets — same regexes).
// Correlation excerpts pull live `gh run view --log-failed` output,
// which in pathological cases can include a leaked PAT in a curl
// invocation. We strip token-shaped substrings before they land in
// the DOM. (Per LESSONS § "defence-in-depth secret redaction at the
// renderer boundary".)
function redactSecrets(s) {
  let out = String(s ?? "");
  // GitHub PATs (ghp_, gho_, ghu_, ghs_, ghr_) followed by >=20 chars.
  out = out.replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-pat>");
  // GitHub repo URLs — same heuristic as doctor.
  out = out.replace(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?/g, "<redacted-repo-url>");
  // Long base64-ish tokens (>=24 chars of [A-Za-z0-9_]).
  out = out.replace(/\b[A-Za-z0-9_]{24,}\b/g, (m) => {
    const hasLetter = /[A-Za-z]/.test(m);
    const hasDigit = /\d/.test(m) || /_/.test(m);
    return hasLetter && hasDigit ? "<redacted>" : m;
  });
  return out;
}

// Ticket 0027: a fleet_correlation item renders the affected project
// slugs as inline chips and the "investigate" CTA navigates to the
// detail view at #/correlation/<signature>. Excerpts pass through
// redactSecrets before any HTML interpolation.
function renderCorrelationItem(item) {
  const payload = item.payload || {};
  const sig = esc(payload.signature || item.payload.id);
  const slugs = Array.isArray(payload.affected_slugs) ? payload.affected_slugs : [];
  const chips = slugs.map((s) => `<a class="chip" href="#/p/${esc(s)}" data-stop="1">${esc(s)}</a>`).join("");
  const title = esc(item.title);
  const route = "#/correlation/" + encodeURIComponent(payload.signature || item.payload.id);
  return `<div class="inbox-row" data-inbox-row data-kind="fleet_correlation" data-slug="fleet" data-payload-id="${sig}">
    <div class="inbox-meta">
      <span class="inbox-kind">${esc(INBOX_KIND_LABEL.fleet_correlation)}</span>
      <span class="dim">· signature ${sig} · ${esc(ago(new Date(Date.now() - (item.age_seconds || 0) * 1000).toISOString()))}</span>
    </div>
    <div class="inbox-title">${title}</div>
    <div class="inbox-chips">${chips}</div>
    <div class="inbox-actions">
      <a class="btn sm" href="${esc(route)}" data-stop="1">Investigate</a>
      <button class="btn sm" data-act="inbox-dismiss" data-kind="fleet_correlation" data-slug="fleet" data-payload-id="${sig}">Dismiss</button>
    </div>
  </div>`;
}

// Ticket 0034: self_drift inbox row. Renders the headline copy
// "<slug>: <metric> Nx normal since HH:MM" where N is current /
// baseline_mean rounded to one decimal and HH:MM is derived from
// `first_seen_at` in the operator's local timezone. The "investigate"
// action navigates to #/project/<slug>/drift (the detail view). Per
// LESSONS § "defence-in-depth secret redaction at the renderer
// boundary", every operator-visible string passes through redactSecrets
// before any HTML interpolation.
function renderDriftInboxRow(item) {
  const payload = item.payload || {};
  const metric = String(payload.metric || item.payload.id || "");
  const slug = String(item.project_slug || "");
  const safeSlug = esc(redactSecrets(slug));
  const safeMetric = esc(redactSecrets(metric));
  const metricLabel = esc(redactSecrets(DRIFT_METRIC_LABEL[metric] || metric));
  const baselineMean = Number(payload.baseline_mean) || 0;
  const current = Number(payload.current) || 0;
  const ratio = baselineMean > 0 ? current / baselineMean : 0;
  const nx = ratio > 0 ? ratio.toFixed(1) + "x" : "—";
  let sinceText = "";
  if (payload.first_seen_at) {
    try {
      const d = new Date(payload.first_seen_at);
      if (!isNaN(d.getTime())) {
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        sinceText = ` since ${hh}:${mm}`;
      }
    } catch { /* leave sinceText empty */ }
  }
  const headline = `${safeSlug}: ${metricLabel} ${esc(nx)} normal${esc(sinceText)}`;
  const route = "#/project/" + encodeURIComponent(slug) + "/drift";
  return `<div class="inbox-row" data-inbox-row data-kind="self_drift" data-slug="${safeSlug}" data-payload-id="${safeMetric}">
    <div class="inbox-meta">
      <span class="inbox-kind">${esc(INBOX_KIND_LABEL.self_drift)}</span>
      <span class="dim">· ${safeSlug} · ${safeMetric} · ${esc(ago(payload.first_seen_at || new Date(Date.now() - (item.age_seconds || 0) * 1000).toISOString()))}</span>
    </div>
    <div class="inbox-title">${headline}</div>
    <div class="inbox-actions">
      <a class="btn sm" href="${esc(route)}" data-stop="1">Investigate</a>
      <button class="btn sm" data-act="inbox-dismiss" data-kind="self_drift" data-slug="${safeSlug}" data-payload-id="${safeMetric}">Dismiss</button>
    </div>
  </div>`;
}

function inboxRow(item, opts) {
  if (item.kind === "fleet_correlation") return renderCorrelationItem(item);
  if (item.kind === "self_drift") return renderDriftInboxRow(item);
  const quieted = !!(opts && opts.quieted);
  const lbl = INBOX_KIND_LABEL[item.kind] || item.kind;
  const slug = esc(item.project_slug);
  const title = esc(item.title);
  const actionLabel = esc((item.action && item.action.label) || "Open");
  const route = (item.action && item.action.route) || "#/";
  const isExternal = /^https?:\/\//.test(route);
  // The "open" link uses the existing styling — external (PR URL) gets
  // target=_blank, internal hash routes navigate in-place. The
  // "dismiss" button posts to /api/fleet/inbox/dismiss via the global
  // data-act delegate (added below) and the row disappears on the
  // next 5s home() poll.
  const openLink = isExternal
    ? `<a class="btn sm" href="${esc(route)}" target="_blank" rel="noopener" data-stop="1">${actionLabel}</a>`
    : `<a class="btn sm" href="${esc(route)}" data-stop="1">${actionLabel}</a>`;
  // Ticket 0030: quieted rows carry a small moon glyph (U+1F319) so
  // the operator can scan the inbox at 9am and see immediately which
  // rows arrived during the night. The glyph is text-only (no DOM
  // shift) and carries an aria-label="quiet" for screen readers.
  const moon = quieted
    ? `<span class="moon" aria-label="quiet">🌙</span> `
    : "";
  const rowClass = quieted ? "inbox-row inbox-row-quieted" : "inbox-row";
  return `<div class="${rowClass}" data-inbox-row data-kind="${esc(item.kind)}" data-slug="${slug}" data-payload-id="${esc(item.payload.id)}">
    <div class="inbox-meta">
      ${moon}<span class="inbox-kind">${esc(lbl)}</span>
      <span class="dim">· ${slug} · ${esc(ago(new Date(Date.now() - (item.age_seconds || 0) * 1000).toISOString()))}</span>
    </div>
    <div class="inbox-title">${title}</div>
    <div class="inbox-actions">
      ${openLink}
      <button class="btn sm" data-act="inbox-dismiss" data-kind="${esc(item.kind)}" data-slug="${slug}" data-payload-id="${esc(item.payload.id)}">Dismiss</button>
    </div>
  </div>`;
}

// Ticket 0030: render the "Queued during quiet hours — resumes at HH:MM"
// divider above the quietedItems section. The `until` ISO string passes
// through redactSecrets per LESSONS § "defence-in-depth secret redaction
// at the renderer boundary" — even though the string is normally a fixed
// ISO timestamp, the renderer surface stays disciplined.
function renderQuietDivider(quietHoursUntil, count) {
  const safeUntil = redactSecrets(String(quietHoursUntil || ""));
  let resumesText = "";
  if (safeUntil) {
    try {
      const d = new Date(safeUntil);
      if (!isNaN(d.getTime())) {
        // Render HH:MM in the operator's local zone (the browser's
        // default — same convention as ago() and until() elsewhere).
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        resumesText = ` — resumes at ${hh}:${mm}`;
      }
    } catch { /* fall through, render the divider without time */ }
  }
  const countText = count === 1 ? "1 item arrived overnight"
    : `${count} items arrived overnight`;
  return `<div class="inbox-quiet-divider" data-testid="inbox-quiet-divider">
    <span class="moon" aria-label="quiet">🌙</span>
    <span class="dim">Queued during quiet hours${esc(resumesText)} · ${esc(countText)}</span>
  </div>`;
}

function renderInbox(data) {
  if (!data) return "";
  const items = data.items || [];
  const quietedItems = data.quietedItems || [];
  if (items.length === 0 && quietedItems.length === 0) {
    return `<div class="eyebrow">Inbox</div>
      <div class="inbox-empty">Inbox zero — fleet's healthy.</div>`;
  }
  const totalCount = items.length + quietedItems.length;
  const head = `<div class="eyebrow">Inbox · ${totalCount} thing${totalCount === 1 ? "" : "s"} need${totalCount === 1 ? "s" : ""} you</div>`;
  const itemsHtml = items.map((it) => inboxRow(it)).join("");
  // The divider is absent when quietedItems is empty — per the AC,
  // "When data.quietedItems.length === 0 the divider is absent."
  let quietedHtml = "";
  if (quietedItems.length > 0) {
    quietedHtml = renderQuietDivider(data.quietHoursUntil, quietedItems.length)
      + quietedItems.map((it) => inboxRow(it, { quieted: true })).join("");
  }
  return `${head}
    <div class="inbox-list">${itemsHtml}${quietedHtml}</div>`;
}

// Dismiss handler — POST to /api/fleet/inbox/dismiss, then trigger a
// home() refresh so the row disappears immediately. Uses the same
// fleet-token plumbing as act() but a different path so it isn't a
// /api/control/ verb.
async function dismissInbox(kind, slug, payloadId) {
  const tok = localStorage.getItem("fleetToken") || "";
  try {
    const r = await fetch("/api/fleet/inbox/dismiss", {
      method: "POST",
      headers: { "content-type": "application/json", ...(tok ? { "x-fleet-token": tok } : {}) },
      body: JSON.stringify({ kind, project_slug: slug, payload_id: payloadId }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) {
      toast("dismissed", true);
      // Optimistically remove the row so the operator sees an
      // immediate effect; the next home() poll re-renders from the
      // server response anyway.
      const row = document.querySelector(`[data-inbox-row][data-kind="${CSS.escape(kind)}"][data-slug="${CSS.escape(slug)}"][data-payload-id="${CSS.escape(payloadId)}"]`);
      if (row && row.parentNode) row.parentNode.removeChild(row);
      setTimeout(route, 400);
    } else {
      toast(d.message || "couldn't dismiss", false);
    }
  } catch {
    toast("couldn't reach the server", false);
  }
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act='inbox-dismiss']");
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  dismissInbox(b.dataset.kind, b.dataset.slug, b.dataset.payloadId);
});

/** Render the "Last week" banner at the top of the home view from a
 *  /api/digest/week payload. Returns an HTML string. Tap-to-expand is
 *  handled by a document-level listener registered once at bottom of file. */
function digestBanner(d) {
  if (!d || !d.totals) return "";
  const t = d.totals;
  // Headline strip — five compact stats. The merged-PR count is the
  // headline (operator's favourite number) so it leads.
  const headline = ""
    + `<b>${t.prs_merged}</b> PR${t.prs_merged === 1 ? "" : "s"} merged`
    + ` · <b>${t.prs_sent_back}</b> sent back`
    + ` · <b>${usd(t.cost_usd)}</b> spent`
    + ` · <b>${t.self_cancels}</b> self-cancel${t.self_cancels === 1 ? "" : "s"}`
    + ` · <b>${t.anomalies}</b> anomal${t.anomalies === 1 ? "y" : "ies"}`;
  // Per-project rows (hidden by default; expand on tap). One <li> per
  // project, ordered as the digest sorted them (cost desc).
  const rows = (d.projects || []).map((p) => {
    const delta = p.delta_cost_vs_prior_week_pct;
    const deltaStr = delta == null ? "new this week"
      : (delta >= 0 ? "+" : "") + delta.toFixed(1) + "% vs last week";
    return `<li class="digest-row">`
      + `<a href="#/p/${esc(p.slug)}"><b>${esc(p.name || p.slug)}</b></a>`
      + ` <span class="faint">· ${p.runs} runs · ${p.prs_merged} PR${p.prs_merged === 1 ? "" : "s"}`
      + ` · ${usd(p.cost_usd)} · ${esc(deltaStr)}</span>`
      + `</li>`;
  }).join("");
  const narrative = (d.narrative || []).map((b) => `<li>${esc(b)}</li>`).join("");
  return `<div class="digest-banner" data-digest-banner>
    <div class="digest-head" data-digest-toggle>
      <span class="digest-eyebrow">Last week</span>
      <span class="digest-stats">${headline}</span>
      <span class="digest-caret">▸</span>
    </div>
    <div class="digest-body hidden">
      ${rows ? `<ul class="digest-list">${rows}</ul>` : `<div class="faint">no projects ran last week</div>`}
      ${narrative ? `<div class="digest-eyebrow">Narrative</div><ul class="digest-narrative">${narrative}</ul>` : ""}
    </div>
  </div>`;
}

async function home() {
  // Fan out /api/fleet + /api/digest/week + /api/fleet/inbox +
  // /api/fleet/streak + /api/fleet/glance + /api/fleet/cost-per-pr so
  // the round-trips don't serialize. Streak banner renders above the
  // inbox (ticket 0026); the "Yesterday at a glance" card (ticket
  // 0033) renders ABOVE the inbox AND the streak; the "Cost per
  // merged PR" summary (ticket 0035) renders at the very top so it's
  // the first thing the operator sees on a morning open. Errors fall
  // through silently per the helper.
  const [data, digestData, inboxData, streakData, glanceData, costPerPrData] = await Promise.all([
    get("/api/fleet"), fetchDigest(), fetchInbox(), fetchStreak(), fetchGlance(), fetchCostPerPr(),
  ]);
  const alerts = data.alerts || [];
  const inboxCount = (inboxData && inboxData.items && inboxData.items.length) || 0;
  summary.innerHTML = `${inboxCount ? `<a href="#inbox" class="inbox-badge" data-inbox-badge>Inbox ${inboxCount}</a> · ` : ""}${alerts.length ? `<span class="bell">${alerts.length} alert${alerts.length === 1 ? "" : "s"}</span> · ` : ""}<b>${data.projects.length}</b> projects · <b>${usd(data.totals.cost)}</b> est. effort · <a href="#/leaderboard" class="navlink">Compare ›</a>`;
  // Cache pace info so the "Set fleet pace" modal can show the current mix.
  window._allPaces = data.projects.map((p) => ({ slug: p.slug, pace: p.pace || "custom" }));
  app.innerHTML =
    digestBanner(digestData) +
    renderCostPerPrSummary(costPerPrData) +
    renderYesterdayGlance(glanceData) +
    renderStreak(streakData) +
    renderInbox(inboxData) +
    (alerts.length ? `<div class="eyebrow">Needs attention</div>` + alerts.map(alertRow).join("") : "") +
    `<div class="eyebrow rowflex">Your projects <button class="btn sm" data-modal="add">+ Add a project</button></div>` + data.projects.map(card).join("") +
    `<div class="eyebrow" style="margin-top:28px">Across the fleet</div>
     <div class="card"><div class="metarow">
       <span>total runs <b class="cost">${data.totals.runs}</b></span>
       <span>this week <b class="cost">${usd(data.projects.reduce((s, p) => s + (p.cost7d || 0), 0))}</b></span>
       <span class="dim">estimated effort · agents run on your Max plan (no real bill)</span>
     </div></div>
     <div class="eyebrow" style="margin-top:28px">Pace</div>
     <div class="card"><div class="metarow" style="align-items:center">
       <span>Slow the whole fleet down (one click) if GitHub/CI is rate-limiting you or your Anthropic usage is tight.</span>
       <button class="btn primary" data-modal="fleet-pace">Set fleet pace…</button>
     </div></div>
     <div class="eyebrow" style="margin-top:28px">Monitoring</div>
     <div class="card"><div class="metarow" style="align-items:center">
       <span>Always-on background monitoring is <b class="${data.daemonOn ? "now" : "dim"}">${data.daemonOn ? "ON" : "OFF"}</b></span>
       <button class="btn" data-act="daemon" data-enabled="${data.daemonOn ? "0" : "1"}">${data.daemonOn ? "Turn off" : "Turn on"}</button>
       <span class="dim">When on, the fleet is watched and you get alerts even with this closed (a little background CPU). Off: updates only while open.</span>
     </div></div>`;
  const pf = pricingFooter();
  // Ticket 0005: total-fleet forecast — sum of per-project projected_30d.
  // Projects without enough data contribute zero; surface that count so a
  // small headline number doesn't read as "we're cheap" when really it's
  // "we don't know yet". Hidden entirely until at least one project has a
  // projection, so brand-new installs don't show "$0/mo (forecast)".
  const ft = data.totals || {};
  const fcLine = ft.forecast_ready
    ? "forecast " + usd(ft.projected_30d) + "/mo across the fleet"
      + (ft.forecast_ready < data.projects.length ? " (" + ft.forecast_ready + "/" + data.projects.length + " projects)" : "")
    : "";
  foot.textContent = "updated " + new Date(data.generatedAt).toLocaleTimeString() + (data.daemonOn ? " · always-on" : "") + (fcLine ? " · " + fcLine : "") + (pf ? " · " + pf : "");
  if (pricingMeta.stale) foot.title = "Pricing may be stale (synced >24h ago). Run: fleetctl pricing sync";
  else foot.removeAttribute("title");
}
function alertRow(a) {
  return `<div class="banner ${a.severity === "critical" ? "bad" : ""}" style="margin:0 0 8px">
    <b>${esc(a.title)}</b> — ${esc(a.detail)}</div>`;
}
function forecastSpan(f) {
  // Ticket 0005: per-project "$X/mo (forecast)" derived from daily_mean_7d × 30.
  // The 14d mean is exposed in a tooltip so a single hot day's spike on the
  // 7d figure is easy to sanity-check. Until 3 days of data exist we render
  // a soft "not enough yet" string instead of a number.
  if (!f) return `<span class="dim">forecast: —</span>`;
  if (f.projected_30d == null) return `<span class="dim" title="${esc(f.reason || "not enough data")}">forecast: not enough yet</span>`;
  const tip = "14d mean: " + usd(f.daily_mean_14d) + "/day · 7d mean: " + usd(f.daily_mean_7d) + "/day";
  return `<span title="${esc(tip)}"><b class="cost">${usd(f.projected_30d)}</b>/mo <span class="dim">(forecast)</span></span>`;
}
// Ticket 0008: anomaly pill for the home grid card. Hidden entirely when the
// trailing-24h count is zero (most projects, most of the time). Red when
// the latest flag is <1h old (someone should look now), amber otherwise
// (within 24h but cooled off). Clicking the pill deep-links into the
// project page's anomalies view.
function anomalyPill(p) {
  const a = p.anomalies;
  if (!a || !a.count_24h) return "";
  const fresh = a.latest_at && (Date.now() - new Date(a.latest_at).getTime() < 60 * 60_000);
  const cls = fresh ? "anomaly-pill fresh" : "anomaly-pill stale";
  const label = "Anomal" + (a.count_24h === 1 ? "y" : "ies") + " (" + a.count_24h + ")";
  // The pill is rendered inside an <a class="card">; nested <a> isn't valid
  // HTML, so we use a span with a click handler that bubbles to the card's
  // href. The deep link `?view=anomalies` is preserved by route().
  return `<span class="${cls}" data-anom-link="${esc(p.slug)}" title="${esc(a.latest_at ? "latest " + ago(a.latest_at) : "anomalies in last 24h")}">${label}</span>`;
}
// Ticket 0021: amber "paused·cost" pill + inline Resume button on the
// project card. Empty when paused is null/undefined — render nothing
// new so unchanged projects stay byte-identical. The button has a
// data-act="resume-paused" attribute so the global delegate (the same
// pattern eng-toggle uses) catches the click without nesting a button
// inside the card's <a>. data-stop is read by the click delegate to
// suppress the parent <a class="card"> navigation.
function pausedCostPill(p) {
  if (!p || p.paused !== "cost_cap") return "";
  return `<span class="paused-pill cost" title="Paused because today's spend hit the daily $ cap. Tap Resume to restart.">paused·cost
    <button class="btn xs resume-paused" data-act="resume-paused" data-slug="${esc(p.slug)}" data-stop="1">Resume</button></span>`;
}

// Ticket 0022: per-project "fleet temperature" — one coloured dot
// prefix on the card head + a tap-toggle tooltip that fetches
// /api/projects/:slug/health on open. The formula text is rendered
// from the API response (not hardcoded) so the docs stay live with
// any future change to the helper. The tooltip is keyboard-friendly
// (<button aria-expanded>) and tap-toggle on mobile per the 0011
// mobile-first guideline.
function renderHealthDot(health, slug) {
  const band = (health && health.band) || "grey";
  const score = health && typeof health.score === "number" ? health.score : "—";
  const title = band === "grey"
    ? `Health: ${score} — not enough data`
    : `Health: ${score} (${band})`;
  return `<button type="button" class="health-dot band-${esc(band)}"`
    + ` aria-label="${esc(title)}" title="${esc(title)}"`
    + ` aria-expanded="false"`
    + ` data-health-dot="${esc(slug || "")}"`
    + ` data-stop="1"></button>`;
}

// Click delegate for the health dot — toggles a tooltip beside the
// dot. The tooltip body is rendered from the API response so the
// formula stays in lockstep with src/views.ts. We tear down any
// open tooltip on outside-click so a phone tap doesn't leave stale
// chrome behind.
document.addEventListener("click", async (e) => {
  const dot = e.target.closest("[data-health-dot]");
  if (!dot) {
    const open = document.querySelector(".health-tooltip");
    if (open && open.parentNode) open.parentNode.removeChild(open);
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const open = document.querySelector(".health-tooltip");
  if (open && open.parentNode) open.parentNode.removeChild(open);
  const slug = dot.dataset.healthDot;
  if (!slug) return;
  dot.setAttribute("aria-expanded", "true");
  const tip = document.createElement("div");
  tip.className = "health-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.textContent = "loading…";
  dot.parentNode.appendChild(tip);
  let d;
  try { d = await get("/api/projects/" + encodeURIComponent(slug) + "/health"); }
  catch {
    tip.textContent = "couldn't load health";
    setTimeout(() => { if (tip.parentNode) tip.parentNode.removeChild(tip); }, 2500);
    return;
  }
  const subs = d.subs || {};
  const fm = d.formula || {};
  const subVal = (v) => (v == null ? "—" : String(v));
  // Each row carries the score, a label, and the formula text from the
  // API response — that's the engineering-note contract. Equal weights
  // (25 each) are documented in the composite line.
  const rows = [
    ["ship_success", "Ship success"],
    ["anomaly", "Anomalies"],
    ["pr_age", "PR age"],
    ["cost_trajectory", "Cost trend"],
  ].map(([k, label]) => `<div class="health-row">
      <span class="health-row-score">${esc(subVal(subs[k]))}</span>
      <span class="health-row-label"><b>${esc(label)}</b> <span class="dim">${esc(fm[k] || "")}</span></span>
    </div>`).join("");
  tip.innerHTML = `<div class="health-head"><b>Health ${esc(String(d.score ?? "—"))}</b> · ${esc(d.band || "")} <span class="dim">· 25% each</span></div>
    ${rows}
    <div class="health-foot dim">${esc(fm.composite || "")}</div>`;
  setTimeout(() => {
    if (tip.parentNode) tip.parentNode.removeChild(tip);
    dot.setAttribute("aria-expanded", "false");
  }, 8000);
});

// Ticket 0028: month-to-date budget burndown sparkline. Hand-rolled
// inline SVG (no charting lib). Two polylines (cumulative, projected)
// plus a dashed cap reference; one today-dot coloured by band. The
// inline summary on the home payload carries only
// {projected_eom_usd, cap_eom_usd, band}; the full days[] series is
// fetched lazily on card tap from /api/projects/:slug/burndown so
// the home payload stays small. We always render a band-coloured
// today-dot from the summary so the operator's eye lands on the
// at-risk project before any network round-trip.
//
// Per LESSONS § "defence-in-depth secret redaction at the renderer
// boundary": any project-name string passes through redactSecrets
// before it lands in the DOM. The label string itself never carries
// a name today, but the helper is the chokepoint.
//
// Empty state (AC10): when projected_eom_usd is 0 AND cap is unset
// (or when the lazy /burndown fetch returns days: []), the SPA
// renders "no spend this month" instead of the chart.
function renderBurndownSparkline(p, opts) {
  const summary = p && p.burndown;
  if (!summary) return "";
  const band = summary.band || "green";
  const cap = summary.cap_eom_usd;
  const proj = summary.projected_eom_usd;
  const noSpend = (!proj || proj === 0) && (cap == null);
  // Defence-in-depth: route the project name string through the
  // redactor before it enters the title/label DOM. The label text
  // itself doesn't carry a name today, but the title attr does, and
  // a future label format that interpolates the name stays safe.
  const name = redactSecrets(String(p.name || p.slug || ""));
  if (noSpend) {
    return `<div class="burndown-empty dim" title="${esc(name)}: no spend this month">no spend this month</div>`;
  }
  // 60x32 px viewport on desktop; CSS shrinks to 40x24 on mobile via
  // the @media (max-width: 600px) block in web/style.css.
  // X axis: day-of-month 1..30 (we don't know `days.length` yet — the
  // summary view draws a single projection line + cap reference);
  // Y axis: 0..max(projected, cap). Coordinates are hand-rolled
  // strings so no external SVG lib enters the bundle.
  const yMax = Math.max(Number(proj) || 0, Number(cap) || 0, 1);
  const w = 60, h = 32;
  // Cap reference: a flat dashed line at y=cap.
  let capLine = "";
  if (cap != null && cap > 0) {
    const capY = h - (Number(cap) / yMax) * (h - 2) - 1;
    capLine = `<line class="burndown-cap" x1="0" y1="${capY.toFixed(1)}" x2="${w}" y2="${capY.toFixed(1)}" stroke-dasharray="2,2"></line>`;
  }
  // Projected segment: a dashed line sloping up to today's projected
  // eom. We anchor at (0, h) (origin) and slope to (w, projectedY).
  let projLine = "";
  if (proj != null) {
    const projY = h - (Number(proj) / yMax) * (h - 2) - 1;
    projLine = `<line class="burndown-projected" x1="0" y1="${h}" x2="${w}" y2="${projY.toFixed(1)}" stroke-dasharray="4,2"></line>`;
  }
  // Today-dot, coloured by band — operator's eye-magnet.
  const dotY = proj != null ? h - (Number(proj) / yMax) * (h - 2) - 1 : h - 2;
  const dot = `<circle class="burndown-dot band-${esc(band)}" cx="${w}" cy="${dotY.toFixed(1)}" r="3"></circle>`;
  const usdProj = "$" + (Number(proj) || 0).toFixed(2);
  const usdCap = cap != null ? "$" + Number(cap).toFixed(2) : "—";
  const title = `${name}: ${usdProj} forecast vs ${usdCap} cap`;
  return `<span class="burndown band-${esc(band)}" title="${esc(title)}">
    <svg class="burndown" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
      ${capLine}${projLine}${dot}
    </svg>
    <span class="burndown-label dim">${esc(usdProj)} of ${esc(usdCap)} cap MTD</span>
  </span>`;
}

function card(p) {
  const [cls, label] = STATE[p.displayState] || STATE.off;
  const running = p.jobs.find((j) => j.running);
  const nowLine = running
    ? `<div class="job now">● ${PHASE[running.phase]} now${running.currentAction ? ` <span class="faint">· ${esc(running.currentAction)}</span>` : ""}</div>`
    : "";
  const nextJob = p.jobs.filter((j) => j.next).sort((a, b) => new Date(a.next) - new Date(b.next))[0];
  const lastAny = p.jobs.map((j) => j.last).filter(Boolean).sort((a, b) => new Date(b.started_at) - new Date(a.started_at))[0];
  const sc = p.selfCancelDays;
  const ulBanner = p.usageLimit?.blocked
    ? `<div class="banner bad">Hit Claude usage limit · ${p.usageLimit.until ? "back in service " + until(p.usageLimit.until) : "until the next reset"}.</div>` : "";
  const akBanner = p.autoKill && (Date.now() - new Date(p.autoKill.ts).getTime() < 15 * 60_000)
    ? `<div class="banner">Auto-healed ${PHASE[p.autoKill.phase] || p.autoKill.phase} (was hung ${p.autoKill.mins}m) · next run will retry.</div>` : "";
  const banner = sc != null && sc < 0
    ? `<div class="banner bad">Stopped working — its safety limit passed. Open it to restart.</div>`
    : sc != null && sc <= 3
      ? `<div class="banner">Stops working in ${sc} day${sc === 1 ? "" : "s"} unless you keep it running.</div>` : "";
  return `<a class="card" href="#/p/${p.slug}">
    <div class="card-head">${renderHealthDot(p.health, p.slug)}<span class="pname">${esc(p.name)}</span>
      <span class="state"><span class="dot ${cls}"></span>${label}${pausedCostPill(p)}${anomalyPill(p)}</span></div>
    ${telemetry(p.telemetry)}
    ${nowLine || (lastAny ? `<div class="job">Last: ${OUTCOME[lastAny.outcome] || lastAny.outcome || "ran"} · ${ago(lastAny.started_at)}</div>` : "")}
    <div class="metarow">
      ${nextJob ? `<span>next: ${PHASE[nextJob.phase].toLowerCase()} <b>${until(nextJob.next)}</b></span>` : `<span class="dim">paused</span>`}
      <span>this week <b class="cost">${usd(p.cost7d)}</b></span>
      <span>${forecastSpan(p.forecast)}</span>
      <span class="dim">${p.runs} runs</span>
    </div>
    ${renderBurndownSparkline(p)}
    ${ulBanner}${akBanner}${banner}</a>`;
}
// Ticket 0012: "Last week" digest banner — tap the head to expand
// the per-project rows. Same toggle pattern as the PR card head.
document.addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-digest-toggle]");
  if (!toggle) return;
  // Don't hijack clicks that originated on a real link inside the head
  // (e.g. a project name): let the navigation through.
  if (e.target.closest("a")) return;
  const banner = toggle.closest("[data-digest-banner]");
  if (!banner) return;
  const body = banner.querySelector(".digest-body");
  const caret = banner.querySelector(".digest-caret");
  if (!body) return;
  const opening = body.classList.contains("hidden");
  body.classList.toggle("hidden");
  if (caret) caret.textContent = opening ? "▾" : "▸";
});

// Pill clicks: stop the parent <a class="card"> navigation and route to
// the anomalies view explicitly. data-anom-link carries the slug.
document.addEventListener("click", (e) => {
  const pill = e.target.closest("[data-anom-link]");
  if (!pill) return;
  e.preventDefault();
  e.stopPropagation();
  location.hash = "#/p/" + pill.dataset.anomLink + "?view=anomalies";
});

// ---- Project --------------------------------------------------------------
// Typed-event probe (ticket 0001): if the very latest event is a run_started
// in the last 30 minutes, surface its phase + age above the transcript-tail
// fallback. Failures are silent — the rest of the panel renders regardless.
async function latestRunStarted(slug) {
  try {
    const d = await get("/api/projects/" + slug + "/events?limit=1");
    const e = d?.events?.[0];
    if (!e || e.type !== "run_started" || !e.ts) return null;
    const ageMs = Date.now() - new Date(e.ts).getTime();
    if (!(ageMs >= 0) || ageMs > 30 * 60_000) return null;
    return { phase: e.phase, ts: e.ts, ageMs, payload: e.payload };
  } catch { return null; }
}
async function project(slug, params) {
  const [p, nowEv] = await Promise.all([get("/api/project/" + slug), latestRunStarted(slug)]);
  // Ticket 0008: optional "Anomalies" panel rendered when the deep link
  // `?view=anomalies` was used (or any time there's at least one row in
  // the trailing 50). The list is fetched lazily so a clean project pays
  // no cost for the extra round-trip.
  const wantAnomalies = params && params.get("view") === "anomalies";
  summary.innerHTML = `<a href="#/" class="dim">‹ all projects</a>`;
  // Stash this project's cadence / pace so cadenceForm() (modal) can pre-fill
  // its dropdowns with the current values. Lives on window because the modal
  // template is built from a string and can't capture closures.
  window._cadenceFor = window._cadenceFor || {};
  window._cadenceFor[slug] = p.cadence || {};
  window._paceFor = window._paceFor || {};
  window._paceFor[slug] = p.pace || "custom";
  const [cls, label] = STATE[p.displayState] || STATE.off;
  const ulBanner = p.usageLimit?.blocked
    ? `<div class="banner bad">Hit Claude usage limit on ${PHASE[p.usageLimit.phase] || p.usageLimit.phase} · ${p.usageLimit.until ? "back in service " + until(p.usageLimit.until) : "until the next reset"}. Subsequent runs will keep failing until then — no need to act.</div>` : "";
  const akBanner = p.autoKill && (Date.now() - new Date(p.autoKill.ts).getTime() < 60 * 60_000)
    ? `<div class="banner">Auto-healed ${PHASE[p.autoKill.phase] || p.autoKill.phase} ${ago(p.autoKill.ts)} (was hung ${p.autoKill.mins}m) so the next scheduled run could fire.</div>` : "";
  app.innerHTML = `<a class="back" href="#/">‹ all projects</a>
    <div class="card-head" style="margin-bottom:6px"><span class="pname">${esc(p.name)}</span>
      <span class="state"><span class="dot ${cls}"></span>${label}</span></div>
    <div class="metarow"><span class="dim mono">${esc(p.repo)}</span>
      ${p.selfCancelDays != null ? `<span>${p.selfCancelDays < 0 ? "stopped" : "keeps running " + p.selfCancelDays + "d"}</span>` : ""}</div>
    ${ulBanner}${akBanner}${nowBanner(nowEv)}
    <div id="live-now" class="live-now hidden"></div>
    <div class="actions">
      ${p.selfCancelDays != null && p.selfCancelDays <= 7 ? `<button class="btn primary" data-act="keep-running" data-slug="${p.slug}" data-days="30">Keep it running (+30 days)</button>` : `<button class="btn" data-act="keep-running" data-slug="${p.slug}" data-days="30">Keep it running (+30 days)</button>`}
      <button class="btn" data-act="resume" data-slug="${p.slug}">Resume all jobs</button>
      <button class="btn" data-act="pause" data-slug="${p.slug}" data-confirm="Pause all of ${esc(p.name)}’s jobs? It will stop working autonomously until resumed.">Pause project</button>
      <button class="btn" data-act="eng-toggle" data-slug="${p.slug}" data-enabled="${p.engEnabled ? "0" : "1"}">${p.engEnabled ? "Turn off code-tidying" : "Also tidy the code"}</button>
      <button class="btn" data-modal="cadence" data-slug="${p.slug}" title="Pace: ${esc(p.pace || "custom")}">Change schedule…</button>
      <button class="btn" data-modal="budget" data-slug="${p.slug}" title="${p.cadence?.max_daily_usd ? "Cap: $" + p.cadence.max_daily_usd + "/day" : "No daily cap"}">Daily cap…</button>
      <button class="btn primary" data-modal="ticket" data-slug="${p.slug}">Tell it what to build</button>
      <button class="btn" data-embed-toggle data-slug="${p.slug}">Embed badge</button>
    </div>
    ${renderEmbedPanel(p.slug)}
    ${prSection(p)}
    <div class="eyebrow">Where the tokens went (last 7d)</div>
    <div id="tool-mix-section" class="jobcard"><div class="kv dim">checking…</div></div>
    <div class="eyebrow">The jobs</div>
    ${p.jobs.map((j) => jobCard(j, p.slug)).join("")}
    <div class="eyebrow">Anomalies</div>
    <div id="anomaly-section" class="jobcard"><div class="kv dim">checking…</div></div>
    <div class="eyebrow">Disk</div>
    <div id="disk-section" class="jobcard">${(_diskCache.get(slug) && (Date.now() - _diskCache.get(slug).ts < _DISK_TTL_MS)) ? _diskCache.get(slug).html : '<div class="kv dim">checking…</div>'}</div>
    <div class="eyebrow">Recent activity</div>
    <table><thead><tr><th>when</th><th>job</th><th>did</th><th>PR</th><th>tokens</th><th>cost</th></tr></thead>
    <tbody>${p.recent.map(runRow).join("")}</tbody></table>`;
  const pf = pricingFooter();
  foot.textContent = "live · " + new Date().toLocaleTimeString() + (pf ? " · " + pf : "");
  if (pricingMeta.stale) foot.title = "Pricing may be stale (synced >24h ago). Run: fleetctl pricing sync";
  else foot.removeAttribute("title");
  // Attach the SSE tool-call tail only once per project visit; the poll
  // refreshes the markup around it, but tearing down the EventSource on
  // every tick would defeat the point.
  if (!liveES) attachLiveStream(slug);
  // Ticket 0006: per-project disk view. Fired in parallel with the rest of
  // the project render so a slow filesystem walk never blocks the page.
  loadDiskSection(slug);
  // Ticket 0008: per-project anomalies. Same lazy pattern as disk.
  loadAnomaliesSection(slug, wantAnomalies);
  // Ticket 0031: per-project tool-mix sparkline (where this project's
  // tokens actually went). Lazy fetch — keeps /api/project/:slug
  // additive-only and the home payload small.
  loadToolMixSection(slug);
}

// ---- Tool-mix sparkline (ticket 0031) ------------------------------------
// Renders a 280x36 stacked horizontal bar (200x28 on phones via CSS)
// showing which tools consumed THIS project's tokens over the trailing
// 7 days, plus a wrapping legend underneath. Hover (desktop) / tap
// (mobile) on a segment surfaces "<name> — N calls — Xs" in an inline
// tooltip inside the container.
//
// Empty state (no tool_use events in window): renders "no tool activity
// this week" with no SVG, no broken layout.
//
// Per LESSONS § "defence-in-depth secret redaction at the renderer
// boundary": every operator-visible label (tool name, count, seconds)
// passes through redactSecrets before insertion. Tool names are bounded
// by the Claude SDK but the defensive pass is the silent backstop.
function renderToolMixBar(data) {
  const tools = (data && data.tools) || [];
  const total = (data && data.total_invocations) || 0;
  // Empty branch FIRST — no SVG, no NaN, no broken layout.
  if (total === 0 || tools.length === 0) {
    return `<div class="project-tool-mix" data-testid="project-tool-mix">
      <div class="tool-mix-empty dim">no tool activity this week</div>
    </div>`;
  }
  // Desktop: 280x36 px (CSS shrinks to 200x28 below 600px). Width is
  // share-proportional; no minimum-width fudge — a 1%-share tool gets
  // a sliver, which is the honest reading.
  const W = 280, H = 36;
  // Build segments. CSS variables `--tool-bash`, `--tool-edit`, etc.
  // pick the colour per named tool; unknown tools fall back to
  // `--tool-other` (neutral grey).
  const NAMED = new Set(["Bash", "Edit", "Read", "Glob", "Grep", "Write", "WebFetch"]);
  let x = 0;
  const rects = tools.map((t, i) => {
    const w = t.share * W;
    const tk = NAMED.has(t.name) ? t.name.toLowerCase() : "other";
    const safe = redactSecrets(String(t.name || ""));
    const rect = `<rect class="tool-mix-segment seg-${esc(tk)}" data-tool="${esc(safe)}" data-idx="${i}" x="${x.toFixed(2)}" y="0" width="${w.toFixed(2)}" height="${H}"></rect>`;
    x += w;
    return rect;
  }).join("");
  // Legend chips wrap below the bar; share is whole-percent rounded.
  const chips = tools.map((t) => {
    const tk = NAMED.has(t.name) ? t.name.toLowerCase() : "other";
    const safe = esc(redactSecrets(String(t.name || "")));
    const pct = Math.round(t.share * 100);
    return `<span class="tool-mix-chip"><span class="tool-mix-swatch swatch-${esc(tk)}"></span>${safe} ${pct}%</span>`;
  }).join("");
  // Tooltip is a sibling <div> positioned absolutely INSIDE the
  // container so it never escapes the card (no portal/overlay).
  // Default tooltip text: the head tool.
  const head = tools[0];
  const headName = esc(redactSecrets(String(head.name || "")));
  const headTip = `${headName} — ${head.invocations} calls — ${(Number(head.total_seconds) || 0).toFixed(1)}s`;
  return `<div class="project-tool-mix" data-testid="project-tool-mix">
    <svg class="tool-mix-bar" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none" role="img" aria-label="tool mix">
      ${rects}
    </svg>
    <div class="tool-mix-legend">${chips}</div>
    <div class="tool-mix-tooltip" data-default="${esc(headTip)}">${esc(headTip)}</div>
  </div>`;
}

async function loadToolMixSection(slug) {
  const el = document.getElementById("tool-mix-section");
  if (!el) return;
  let d;
  try { d = await get("/api/projects/" + encodeURIComponent(slug) + "/tool-mix"); }
  catch { el.innerHTML = `<div class="kv dim">couldn't read tool mix</div>`; return; }
  el.innerHTML = renderToolMixBar(d);
  // Stash the response on the container so the hover/tap delegate can
  // surface per-segment invocations + seconds without re-parsing the
  // chip text. Lives on the DOM node so it follows the markup's
  // lifecycle — gone when the next project route discards the section.
  const container = el.querySelector(".project-tool-mix");
  if (container) container._toolMixData = d;
}

// Hover/tap delegate for the tool-mix sparkline (ticket 0031). One
// listener at the document root finds the segment, updates the
// sibling tooltip's textContent to "<name> — N calls — Xs", and
// restores the head tool on mouseleave. Tap-to-show on mobile uses
// the same path — `touchstart` synthesizes a `mouseenter`-equivalent
// click on iOS Safari, so the delegate fires on tap too.
document.addEventListener("mouseover", (e) => {
  const seg = e.target.closest && e.target.closest(".tool-mix-segment");
  if (!seg) return;
  const container = seg.closest(".project-tool-mix");
  if (!container) return;
  const tip = container.querySelector(".tool-mix-tooltip");
  if (!tip) return;
  const name = seg.getAttribute("data-tool") || "";
  // Read the live data off the legend chip in the same DOM position.
  const idx = Number(seg.getAttribute("data-idx") || 0);
  const chip = container.querySelectorAll(".tool-mix-chip")[idx];
  // Pull invocations + seconds from the segment's geometry-independent
  // data attrs (we re-render the section on every project poll so the
  // text content matches the current fetch).
  // The chip carries the rounded percent only; for the calls/seconds
  // figures we look them up from a stashed data blob.
  const blob = container._toolMixData;
  let calls = 0, secs = 0;
  if (blob && Array.isArray(blob.tools) && blob.tools[idx]) {
    calls = blob.tools[idx].invocations;
    secs = Number(blob.tools[idx].total_seconds) || 0;
  } else if (chip) {
    // Fallback — chip carries the visible "<name> X%" string; we can't
    // recover N calls / seconds from it. Show the head-tool default.
    tip.textContent = tip.getAttribute("data-default") || "";
    return;
  }
  tip.textContent = `${name} — ${calls} calls — ${secs.toFixed(1)}s`;
});
document.addEventListener("mouseout", (e) => {
  const seg = e.target.closest && e.target.closest(".tool-mix-segment");
  if (!seg) return;
  const container = seg.closest(".project-tool-mix");
  if (!container) return;
  const tip = container.querySelector(".tool-mix-tooltip");
  if (!tip) return;
  tip.textContent = tip.getAttribute("data-default") || "";
});
// Mobile tap: same handler shape, but stash the data blob first so the
// delegate above can read it. We patch loadToolMixSection to stash on
// the container after render.

// Ticket 0008: anomaly list for the project page. Renders the trailing-50
// rows newest-first; each row links into the run detail page where the
// badge gives the full context. When `scrollIntoView` is true (deep-link
// from the home pill), we scroll the section into view after render.
async function loadAnomaliesSection(slug, scrollIntoView) {
  const el = document.getElementById("anomaly-section");
  if (!el) return;
  let d;
  try { d = await get("/api/projects/" + encodeURIComponent(slug) + "/anomalies?limit=50"); }
  catch { el.innerHTML = `<div class="kv dim">couldn't read anomalies</div>`; return; }
  const rows = d.anomalies || [];
  if (!rows.length) {
    el.innerHTML = `<div class="kv dim">no anomalies in the trailing window — runs are sitting within 3σ of baseline.</div>`;
    return;
  }
  const renderRow = (a) => {
    const mult = (a.stddev_multiplier || 0).toFixed(1);
    const reason = a.candidate_reason ? ` <span class="faint">· ${esc(a.candidate_reason)}</span>` : "";
    return `<div class="kv mono"><a href="#/r/${a.run_id}"><span class="lbl">${ago(a.created_at)}</span>${esc(a.phase)} · ${esc(a.kind)} ${mult}σ${reason}</a></div>`;
  };
  el.innerHTML = `<h3>Recent flags <span class="faint mono">${rows.length} in last 50</span></h3>${rows.map(renderRow).join("")}`;
  if (scrollIntoView) {
    try { el.scrollIntoView({ behavior: "smooth", block: "start" }); } catch { /* */ }
  }
}
// ---- Disk view (ticket 0006) ---------------------------------------------
// Renders bytes/checkout_count/oldest_age_days plus an expandable list of
// candidate checkout dirs and a "Clean checkouts older than 14 days" button
// that wraps the clean-checkouts control action.
function fmtBytes(n) {
  if (!n || n < 1024) return (n || 0) + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}
// Cache disk and anomaly data per slug so the 5-second poll doesn't replace
// the section with "checking…" every tick (the flash the operator sees). We
// re-fetch when older than 60s, OR after a control action that changes disk
// state (clean-checkouts) — handled by clearing the cache below.
const _diskCache = new Map(); // slug -> { ts, html }
const _DISK_TTL_MS = 60_000;

function _renderDiskHtml(slug, d) {
  const candidates = (d.candidates || []);
  const rows = candidates.map((c) =>
    `<div class="kv mono"><span class="lbl">${c.age_days.toFixed(1)}d</span>${esc(c.path)} <span class="faint">· ${fmtBytes(c.bytes)}</span></div>`,
  ).join("");
  const hasStale = candidates.some((c) => c.age_days >= 14);
  return `
    <h3>Cache footprint <span class="jobactions">
      <button class="btn sm${hasStale ? " primary" : ""}" data-act="clean-checkouts" data-slug="${esc(slug)}"
        data-confirm="Clean checkouts older than 14 days for ${esc(slug)}? This removes only stale agent working trees — runs.jsonl, events.jsonl, and logs/ stay put.">
        Clean checkouts older than 14 days</button>
    </span></h3>
    <div class="metarow">
      <span>${fmtBytes(d.bytes)} on disk</span>
      <span>${d.checkout_count} checkout${d.checkout_count === 1 ? "" : "s"}</span>
      ${d.oldest_age_days != null ? `<span>oldest <b>${d.oldest_age_days.toFixed(1)}d</b></span>` : ""}
    </div>
    ${candidates.length ? `<details style="margin-top:8px"><summary class="dim">show candidates</summary>${rows}</details>` : `<div class="kv dim">no checkout directories</div>`}`;
}

async function loadDiskSection(slug) {
  const el = document.getElementById("disk-section");
  if (!el) return;
  const cached = _diskCache.get(slug);
  if (cached && Date.now() - cached.ts < _DISK_TTL_MS) {
    if (el.innerHTML !== cached.html) el.innerHTML = cached.html;
    return;
  }
  let d;
  try { d = await get("/api/projects/" + encodeURIComponent(slug) + "/disk"); }
  catch {
    // On error, keep showing whatever we already rendered. Only paint the
    // fallback if we have nothing at all — otherwise the flash returns.
    if (!cached) el.innerHTML = `<div class="kv dim">couldn't read disk usage</div>`;
    return;
  }
  const html = _renderDiskHtml(slug, d);
  _diskCache.set(slug, { ts: Date.now(), html });
  if (el.innerHTML !== html) el.innerHTML = html;
  return; // skip the old in-function render below — it's now in _renderDiskHtml
}
function nowBanner(ev) {
  if (!ev) return "";
  const phaseName = PHASE[ev.phase] || ev.phase || "An agent";
  return `<div class="banner">● ${esc(phaseName)} is running now — started ${ago(ev.ts)}.</div>`;
}
// Ticket 0023: inline heal-attempts chip. Renders nothing when
// heal_attempts is 0 so healthy PRs stay byte-identical with prior
// versions. Amber when n >= max (the AGENTS.md-mandated heal cap is
// 2, surfaced via the second arg so a future per-project cap could
// pass a different value). The chip is a span (no nested <a>, since
// the parent .pr-card already wraps the head in a clickable region).
function renderHealChip(n, max) {
  if (!n || n <= 0) return "";
  const cls = n >= max ? "heal-chip amber" : "heal-chip";
  const title = n >= max
    ? `Heal attempts: ${n} of ${max} (cap reached — next failure escalates)`
    : `Heal attempts: ${n} of ${max}`;
  return `<span class="${cls}" title="${esc(title)}">heal ${n}/${max}</span>`;
}

// Ticket 0023: "first failed: <name>" link → the PR's GitHub Actions
// tab. The link target is derived from pr.url (the PR's HTML URL)
// by suffixing `/checks` — gh's standard Checks tab on a pull
// request. Empty when first_fail_check is nullish. The check name
// passes through redactSecrets per LESSONS § secret redaction at the
// renderer boundary; the URL itself is also redacted defensively
// (a future leaked PAT in a webhook URL would otherwise survive).
function renderFirstFailLink(pr) {
  const name = pr && pr.first_fail_check;
  if (!name) return "";
  const safeName = esc(redactSecrets(String(name)));
  // pr.url is the canonical PR HTML URL (https://github.com/o/r/pull/N).
  // The Checks tab lives at <url>/checks. When pr.url is missing we
  // fall back to an inert span so the operator still sees the label.
  const url = pr.url ? redactSecrets(String(pr.url)) + "/checks" : "";
  if (!url) {
    return `<span class="pr-first-fail dim">first failed: ${safeName}</span>`;
  }
  return `<a class="pr-first-fail" href="${esc(url)}" target="_blank"`
    + ` rel="noopener" onclick="event.stopPropagation()">first failed: ${safeName}</a>`;
}

function prSection(p) {
  const prs = (p.prs || []).filter((x) => x.is_agent);
  if (!prs.length) return "";
  const ci = { green: "✓ checks pass", red: "✗ checks failing", pending: "checks running…", none: "" };
  // Heal cap from AGENTS.md (Hard NOs §3 — "Never exceed 2 heal
  // attempts on one PR"). The chip surfaces this implicitly via
  // "heal X/2" so the operator sees the budget without having to
  // remember the number.
  const HEAL_MAX = 2;
  return `<div class="eyebrow">Finished work waiting for you</div>` + prs.map((pr) => {
    const healChip = renderHealChip(pr.heal_attempts || 0, HEAL_MAX);
    const firstFailLink = renderFirstFailLink(pr);
    return `
    <div class="card pr-card" data-pr-card data-slug="${esc(p.slug)}" data-repo="${esc(p.repo)}" data-number="${pr.number}" data-url="${esc(pr.url || "")}">
      <div class="card-head pr-head" data-pr-toggle>
        <span class="pname" style="font-size:15px">${esc(pr.title)}</span>
        <span class="state dim mono">#${pr.number} · ${ci[pr.ci_state] || ""}${healChip ? " " + healChip : ""} <span class="pr-caret">▸</span></span>
      </div>
      ${firstFailLink ? `<div class="pr-firstfail-row">${firstFailLink}</div>` : ""}
      <div class="metarow" style="margin-top:8px">
        <span class="faint mono">+${pr.additions} −${pr.deletions}</span>
        ${pr.url ? `<a class="btn sm" href="${esc(pr.url)}" target="_blank" onclick="event.stopPropagation()">View on GitHub</a>` : ""}
      </div>
      <div class="pr-expand hidden">
        <div class="pr-diff" data-pr-diff><div class="dim mono">loading diff…</div></div>
        <div class="pr-actionbar">
          <button class="btn sm primary" data-act="pr-merge" data-slug="${p.slug}" data-number="${pr.number}" data-confirm="Approve and publish #${pr.number}? It merges to main when checks pass.">Approve &amp; publish</button>
          <button class="btn sm" data-act="pr-changes" data-slug="${p.slug}" data-number="${pr.number}">Send back…</button>
          <button class="btn sm" data-act="pr-close" data-slug="${p.slug}" data-number="${pr.number}" data-confirm="Discard #${pr.number}? This closes the work.">Discard</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

// ---- Embed badge panel (ticket 0015) -------------------------------------
// Three copy-buttons (one per metric) — each stamps a markdown snippet the
// operator can paste into a project's README. We never fetch the SVG from
// JS; the panel is purely a clipboard-helper for the /badge/<slug>.svg
// URL the server already serves. Using location.origin keeps the URL
// correct regardless of host/port (loopback vs LAN at 0.0.0.0:7070).
function renderEmbedPanel(slug) {
  // Each metric becomes a row: label, copy-button, read-only textarea
  // pre-populated with the markdown. The textarea is selectable so a
  // device without clipboard-API support can still copy by hand.
  const metrics = [
    { id: "status", label: "Status", desc: "last run outcome" },
    { id: "cost", label: "Cost (7d)", desc: "trailing-week spend" },
    { id: "ship", label: "Last shipped", desc: "relative age" },
  ];
  const row = (m) => {
    const md = "![fleet-control](" + location.origin + "/badge/" + slug + ".svg?metric=" + m.id + ")";
    return `<div class="embed-row">
      <div class="embed-label"><b>${esc(m.label)}</b> <span class="dim">${esc(m.desc)}</span></div>
      <textarea class="embed-snippet mono" readonly data-snippet>${esc(md)}</textarea>
      <button class="btn sm" data-metric="${esc(m.id)}" data-embed-copy>Copy</button>
    </div>`;
  };
  return `<div class="embed-panel hidden" data-embed-panel data-slug="${esc(slug)}">
    <div class="embed-head dim">Paste one of these into the project's README. The badge updates from this fleet's data; it's host-neutral so the SVG bytes won't leak your laptop's IP.</div>
    ${metrics.map(row).join("")}
  </div>`;
}
// Click handlers — toggle the panel + handle the per-row copy buttons.
// We bind document-level so the polled re-renders of the project view
// don't lose state. The copy uses navigator.clipboard.writeText when
// available; a prompt() fallback lets the operator copy by hand on
// browsers without the clipboard API (older Safari, niche setups).
document.addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-embed-toggle]");
  if (toggle) {
    e.preventDefault();
    const panel = document.querySelector("[data-embed-panel]");
    if (panel) panel.classList.toggle("hidden");
    return;
  }
  const copy = e.target.closest("[data-embed-copy]");
  if (!copy) return;
  e.preventDefault();
  const row = copy.closest(".embed-row");
  const ta = row && row.querySelector("[data-snippet]");
  if (!ta) return;
  const text = ta.value;
  const onOk = () => { copy.textContent = "Copied"; setTimeout(() => (copy.textContent = "Copy"), 1200); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(onOk).catch(() => {
      // Permission denied / non-secure context — fall through to prompt.
      window.prompt("Copy this markdown snippet:", text);
    });
  } else {
    window.prompt("Copy this markdown snippet:", text);
  }
});

// ---- Inline PR diff (ticket 0007) ----------------------------------------
// Click the PR card head → toggle .pr-expand and lazy-load the diff once.
// The diff <div> is sticky-bar's scroll container; the action bar is
// position:sticky inside .pr-expand so it stays visible on mobile while
// the operator scrolls a long diff.
async function loadPrDiff(card) {
  const diffEl = card.querySelector("[data-pr-diff]");
  if (!diffEl || diffEl.dataset.loaded === "1") return;
  const repo = card.dataset.repo;
  const number = card.dataset.number;
  const ghUrl = card.dataset.url || "";
  const tok = localStorage.getItem("fleetToken") || "";
  const u = "/api/prs/" + repo + "/" + number + "/diff";
  let r, text;
  try {
    r = await fetch(u, { headers: tok ? { "x-fleet-token": tok } : {} });
    text = await r.text();
  } catch {
    diffEl.innerHTML = `<div class="dim mono">couldn't reach the server</div>`;
    return;
  }
  if (!r.ok) {
    diffEl.innerHTML = `<div class="dim mono">${esc(text || "diff unavailable")}</div>`;
    return;
  }
  const truncated = r.headers.get("x-diff-truncated") === "1" || text.includes(TRUNCATION_MARKER_SNIPPET);
  let html = renderDiffHtml(text);
  if (truncated && ghUrl) {
    html += `<div class="diff-truncated"><a href="${esc(ghUrl)}" target="_blank">open full diff in GitHub →</a></div>`;
  }
  diffEl.innerHTML = html;
  diffEl.dataset.loaded = "1";
}
document.addEventListener("click", (e) => {
  // Ignore clicks on links, buttons, or anything with [data-act]/[data-modal]
  // inside the head — those should fire their own handlers, not toggle.
  if (e.target.closest("a, button, [data-act], [data-modal]")) return;
  const toggle = e.target.closest("[data-pr-toggle]");
  if (!toggle) return;
  const card = toggle.closest("[data-pr-card]");
  if (!card) return;
  const expand = card.querySelector(".pr-expand");
  const caret = card.querySelector(".pr-caret");
  if (!expand) return;
  const opening = expand.classList.contains("hidden");
  expand.classList.toggle("hidden");
  if (caret) caret.textContent = opening ? "▾" : "▸";
  if (opening) loadPrDiff(card);
});
function jobCard(j, slug) {
  const next = j.paused ? "paused" : j.loaded ? until(j.next) : "not set up";
  const toggle = j.paused
    ? `<button class="btn sm" data-act="resume" data-slug="${slug}" data-phase="${j.phase}">Resume</button>`
    : `<button class="btn sm" data-act="pause" data-slug="${slug}" data-phase="${j.phase}">Pause</button>`;
  return `<div class="jobcard">
    <h3>${j.running ? `<span class="dot working"></span>` : ""}${PHASE[j.phase]}
      <span class="jobactions"><button class="btn sm" data-act="kickstart" data-slug="${slug}" data-phase="${j.phase}">Run now</button>${toggle}</span></h3>
    ${j.running
      ? `<div class="kv now">● working now${j.currentAction ? ` — <span class="faint">${esc(j.currentAction)}</span>` : ""}</div>`
      : `<div class="kv"><span class="lbl">next</span>${esc(next)}</div>`}
    ${j.last ? `<div class="kv"><span class="lbl">last</span>${OUTCOME[j.last.outcome] || j.last.outcome || "ran"} · ${ago(j.last.started_at)} · ${usd(j.last.cost)}${j.last.pr_number ? ` · PR #${j.last.pr_number}` : ""}</div>` : ""}
  </div>`;
}
function runRow(r) {
  return `<tr class="run" onclick="location.hash='#/r/${r.id}'">
    <td>${ago(r.started_at)}</td><td class="dim">${PHASE[r.phase] || r.phase}</td>
    <td><span class="tag ${esc(r.outcome || "")}">${OUTCOME[r.outcome] || r.outcome || "—"}</span></td>
    <td>${r.pr_number ? "#" + r.pr_number : "—"}</td><td>${toks(r.toks)}</td><td class="cost">${usd(r.cost)}</td></tr>`;
}

// ---- Run trace ------------------------------------------------------------
// Ticket 0008: badge rendered above the run trace when one or more anomaly
// rows are attached to this run. Each badge reads
// "Anomaly: <kind> Nσ above baseline — <candidate_reason>" per the spec.
// We render one block per anomaly row so a run flagged for both metrics
// gets both rows surfaced.
function anomalyBadge(a) {
  const mult = (a.stddev_multiplier || 0).toFixed(1);
  const reason = a.candidate_reason ? " — " + esc(a.candidate_reason) : "";
  return `<div class="banner bad anomaly-badge"><b>Anomaly:</b> ${esc(a.kind)} ${mult}σ above baseline${reason}</div>`;
}
async function run(id) {
  const d = await get("/api/run/" + id);
  summary.innerHTML = `<a href="#/p/${d.project.slug}" class="dim">‹ ${esc(d.project.name)}</a>`;
  const r = d.run;
  const anomalies = d.anomalies || [];
  app.innerHTML = `<a class="back" href="#/p/${d.project.slug}">‹ ${esc(d.project.name)}</a>
    <div class="card-head"><span class="pname">${PHASE[r.phase] || r.phase} · ${OUTCOME[r.outcome] || r.outcome || "run"}</span></div>
    <div class="metarow">
      <span>${ago(r.started_at)}</span><span>${r.num_turns} turns</span>
      <span class="cost">${usd(r.cost_usd ?? r.cost_usd_computed)} <span class="faint">(${r.cost_source})</span></span>
      ${r.pr_number ? `<span>PR #${r.pr_number}</span>` : ""}
      <span class="faint">in ${toks(r.input_tokens)} · out ${toks(r.output_tokens)} · cache-rd ${toks(r.cache_read_tokens)}</span>
    </div>
    ${anomalies.map(anomalyBadge).join("")}
    ${r.summary ? `<div class="summary-box">${esc(r.summary)}</div>` : ""}
    <div class="eyebrow">What it did, step by step</div>
    <div class="trace">${d.events.length ? d.events.map(traceLine).join("") : '<span class="dim">no detailed trace for this run</span>'}</div>`;
  foot.textContent = "";
}
function traceLine(e) {
  if (e.kind === "tool_use") return `<div class="ev"><span class="tool">${esc(e.tool_name || "")}</span> ${esc(e.input_summary || "")}</div>`;
  if (e.kind === "tool_result" && e.is_error) return `<div class="ev err">  ↳ error: ${esc((e.output_summary || "").slice(0, 120))}</div>`;
  return "";
}

// ---- Leaderboard (ticket 0014) -------------------------------------------
// Cross-project tool-call leaderboard. Renders three sections:
//   1. Tools — name, invocations, total seconds, error rate, top projects.
//   2. Projects — slug, top tool, tool diversity, avg tools per run.
//   3. Heatmap — cost by phase per project (ship/groom/review/eng).
// Single fetch against /api/fleet/leaderboard; the window defaults to the
// last 14 days. Empty-state copy points operators at `fleetctl backfill`
// when no tool events have been ingested yet (fresh installs).
async function leaderboard() {
  let d;
  try { d = await get("/api/fleet/leaderboard"); }
  catch (e) {
    app.innerHTML = `<div class="loading">couldn't load leaderboard.<br><span class="dim">${esc(e.message)}</span></div>`;
    return;
  }
  summary.innerHTML = `<a href="#/" class="dim">‹ all projects</a>`;
  app.innerHTML = renderLeaderboard(d);
  foot.textContent = "window: " + d.window.start + " → " + d.window.end + " (" + d.window.days + " days)";
}

function renderLeaderboard(d) {
  const tools = d.tools || [];
  const projects = d.projects || [];
  const heatmap = d.heatmap || [];
  // Empty-state: a freshly-installed fleet has no events yet. Point the
  // operator at `fleetctl backfill` so the leaderboard fills out.
  if (tools.length === 0) {
    return `<a class="back" href="#/">‹ all projects</a>
      <div class="card-head"><span class="pname">Fleet · Compare</span></div>
      <div class="card" style="margin-top:14px">
        <div class="kv dim">No tool events ingested yet.</div>
        <div class="kv">Run <code class="mono">fleetctl backfill</code> to populate the leaderboard, then refresh this page.</div>
      </div>`;
  }
  const fmtSec = (s) => {
    if (!s || s < 1) return (s || 0).toFixed(2) + "s";
    if (s < 60) return s.toFixed(1) + "s";
    if (s < 3600) return (s / 60).toFixed(1) + "m";
    return (s / 3600).toFixed(1) + "h";
  };
  const pctErr = (r) => (r > 0 ? (r * 100).toFixed(1) + "%" : "0%");
  const toolRow = (t) => {
    const tops = (t.top_projects || []).map((p) => esc(p.slug) + " (" + p.invocations + ")").join(", ");
    return `<tr>
      <td><b>${esc(t.name)}</b></td>
      <td class="mono">${t.invocations}</td>
      <td class="mono">${esc(fmtSec(t.total_seconds))}</td>
      <td class="mono">${esc(pctErr(t.error_rate))}</td>
      <td class="dim">${tops}</td>
    </tr>`;
  };
  const projRow = (p) => `<tr>
    <td><a href="#/p/${esc(p.slug)}"><b>${esc(p.name || p.slug)}</b></a></td>
    <td class="mono">${esc(p.top_tool || "—")}</td>
    <td class="mono">${p.tool_diversity}</td>
    <td class="mono">${(p.avg_tools_per_run || 0).toFixed(1)}</td>
    <td class="mono">${p.runs_in_window}</td>
  </tr>`;
  // Heatmap: relative intensity per cell, computed against the row max
  // (so each project's stripe reads independently). We render USD inside
  // each cell and tint the background; zero cells stay neutral.
  const maxCellCost = Math.max(
    1e-9,
    ...heatmap.flatMap((h) => Object.values(h.by_phase || {}).map((v) => +v || 0)),
  );
  const heatRow = (h) => {
    const phases = ["ship", "groom", "review", "eng"];
    const cells = phases.map((ph) => {
      const v = (h.by_phase && +h.by_phase[ph]) || 0;
      const intensity = v / maxCellCost;
      const alpha = Math.min(0.6, intensity * 0.6).toFixed(3);
      return `<td class="heat-cell mono" style="background: rgba(200,132,30,${alpha})">${esc(usd(v))}</td>`;
    });
    return `<tr><td><b>${esc(h.slug)}</b></td>${cells.join("")}</tr>`;
  };
  return `<a class="back" href="#/">‹ all projects</a>
    <div class="card-head"><span class="pname">Fleet · Compare</span>
      <span class="state dim mono">last ${d.window.days} days</span></div>

    <div class="eyebrow">Tools</div>
    <table class="leaderboard">
      <thead><tr><th>tool</th><th>invocations</th><th>total time</th><th>error rate</th><th>top projects</th></tr></thead>
      <tbody>${tools.map(toolRow).join("")}</tbody>
    </table>

    <div class="eyebrow">Projects</div>
    <table class="leaderboard">
      <thead><tr><th>project</th><th>top tool</th><th>diversity</th><th>avg tools / run</th><th>runs</th></tr></thead>
      <tbody>${projects.map(projRow).join("") || `<tr><td colspan="5" class="dim">no projects with runs in the window</td></tr>`}</tbody>
    </table>

    <div class="eyebrow">Cost by phase (heatmap)</div>
    <table class="leaderboard heatmap">
      <thead><tr><th>project</th><th>ship</th><th>groom</th><th>review</th><th>eng</th></tr></thead>
      <tbody>${heatmap.map(heatRow).join("") || `<tr><td colspan="5" class="dim">no cost rollups in the window</td></tr>`}</tbody>
    </table>`;
}

// ---- Router ---------------------------------------------------------------
// Hash strings carry an optional `?view=anomalies` (or any future view) —
// strip the query off the slug before fetching the project view, and pass
// the parsed search params into project() so it can scroll the right
// section into view.
function parseHash(h) {
  const body = (h || "").replace(/^#\/?/, "");
  const qIdx = body.indexOf("?");
  const path = qIdx < 0 ? body : body.slice(0, qIdx);
  const query = qIdx < 0 ? "" : body.slice(qIdx + 1);
  const params = new URLSearchParams(query);
  return { path, params };
}
// Ticket 0027: fleet-correlation detail view. Pulls /api/fleet/
// correlations, finds the matching signature, and renders the
// affected projects + each project's first 200-char failure excerpt
// side-by-side. Every excerpt passes through redactSecrets before
// HTML interpolation (LESSONS § "defence-in-depth secret redaction
// at the renderer boundary").
async function correlation(signature) {
  const sig = decodeURIComponent(signature || "");
  let data;
  try { data = await get("/api/fleet/correlations"); }
  catch (e) {
    app.innerHTML = `<div class="loading">couldn’t load correlations.<br><span class="dim">${esc(e.message)}</span></div>`;
    return;
  }
  const list = (data && data.correlations) || [];
  const cor = list.find((c) => c.signature === sig);
  if (!cor) {
    app.innerHTML = `<div class="eyebrow"><a href="#/" class="navlink">‹ Back</a></div>
      <div class="card"><b>No active correlation</b> for signature <code>${esc(sig)}</code>.
      <div class="dim">It may have been dismissed or aged out of the 24-hour window.</div></div>`;
    return;
  }
  const slugs = Array.isArray(cor.project_slugs) ? cor.project_slugs : [];
  const excerpt = redactSecrets(cor.sample_excerpt || "");
  // Each affected project gets one column with its slug + the shared
  // excerpt (the detector stores one sample per signature, not per
  // project; this is the side-by-side surface the operator asked
  // for). When a future ticket pulls per-project excerpts, the
  // payload already has a place to land.
  const cols = slugs.map((s) => `<div class="correlation-col">
    <div class="correlation-slug"><a href="#/p/${esc(s)}">${esc(s)}</a></div>
    <pre class="correlation-excerpt">${esc(excerpt)}</pre>
  </div>`).join("");
  app.innerHTML = `<div class="eyebrow"><a href="#/" class="navlink">‹ Back</a> · Fleet correlation</div>
    <div class="card">
      <div class="correlation-head">
        <div class="correlation-sig">${esc(cor.signature)}</div>
        <div class="dim">${slugs.length} projects affected · first seen ${esc(ago(cor.first_seen_at))} · last seen ${esc(ago(cor.last_seen_at))}</div>
      </div>
      <div class="correlation-grid">${cols}</div>
    </div>`;
}

// ---- Self-baseline drift detail view (ticket 0034) -----------------------
// /project/<slug>/drift renders three inline-SVG rows — one per metric —
// each showing the trailing-14d baseline mean ± 1-sigma band as a grey
// <rect> with the current value as an orange <circle> marker overlaid.
// When the current marker sits OUTSIDE the band the metric is drifted;
// when it sits inside the band the metric is healthy. Per LESSONS §
// "defence-in-depth secret redaction at the renderer boundary", every
// operator-visible string passes through redactSecrets before
// interpolation. The detail container carries data-testid="project-
// drift" per the cross-fleet stable-hook pattern.

const DRIFT_METRIC_FORMATTERS = {
  bash_share: (v) => (v == null ? "—" : (v * 100).toFixed(1) + "%"),
  edit_read_ratio: (v) => (v == null ? "—" : v.toFixed(2)),
  median_run_cost_usd: (v) => (v == null ? "—" : "$" + v.toFixed(2)),
};

const DRIFT_METRICS_ORDER = [
  "bash_share", "edit_read_ratio", "median_run_cost_usd",
];

/** Render one inline SVG band+marker for a single metric. The band
 *  spans [mean - sigma, mean + sigma] of an axis that runs from 0 to
 *  `domainMax` (chosen so the current value + 1 sigma always sit
 *  inside the viewBox). The current value renders as an orange
 *  <circle>. The desktop dims are 400x40; CSS scales them down to
 *  280x32 on phones (handled in style.css). */
function renderDriftSvg(entry, opts) {
  const desktopWidth = 400, desktopHeight = 40;
  const padX = 8;
  const mean = Number(entry.baseline_mean) || 0;
  const sigma = Number(entry.baseline_sigma) || 0;
  const current = Number(entry.current) || 0;
  // Domain: widen so the current marker is always inside the viewBox.
  const upperHint = Math.max(mean + 3 * sigma, current * 1.15, mean * 1.5, 0.01);
  const domainMax = upperHint;
  const scale = (v) => padX + (Math.max(0, Math.min(v, domainMax)) / domainMax) * (desktopWidth - 2 * padX);
  const bandLeft = scale(Math.max(0, mean - sigma));
  const bandRight = scale(mean + sigma);
  const meanX = scale(mean);
  const currentX = scale(current);
  const drifted = !!(opts && opts.drifted);
  const markerColor = drifted ? "var(--drift-marker, var(--warn))" : "var(--drift-marker-ok, var(--good))";
  return `<svg class="drift-svg" viewBox="0 0 ${desktopWidth} ${desktopHeight}" preserveAspectRatio="none" aria-hidden="true">
    <rect class="drift-band" x="${bandLeft.toFixed(1)}" y="14" width="${(bandRight - bandLeft).toFixed(1)}" height="12" rx="2"></rect>
    <rect class="drift-mean" x="${(meanX - 0.5).toFixed(1)}" y="12" width="1.5" height="16"></rect>
    <circle class="drift-current" cx="${currentX.toFixed(1)}" cy="20" r="5" fill="${markerColor}"></circle>
  </svg>`;
}

/** Render one row for a metric — label + numeric summary + inline SVG.
 *  `entry` is either an active DriftEntry (when the metric is drifted)
 *  OR a synthesised "not drifted" row (when the metric is healthy).
 *  The "drifted" CSS class flips the marker colour from green to amber.
 */
function renderDriftRow(metric, entry, drifted) {
  const label = esc(redactSecrets(DRIFT_METRIC_LABEL[metric] || metric));
  const fmt = DRIFT_METRIC_FORMATTERS[metric] || ((v) => String(v));
  const meanStr = esc(fmt(entry.baseline_mean));
  const sigmaStr = esc(fmt(entry.baseline_sigma));
  const currentStr = esc(fmt(entry.current));
  const sigmasText = entry.sigmas != null
    ? (entry.sigmas >= 0 ? "+" : "") + Number(entry.sigmas).toFixed(2) + "σ"
    : "—";
  const verdict = drifted ? "DRIFTED" : "within band";
  return `<div class="drift-row ${drifted ? "drifted" : ""}" data-metric="${esc(metric)}">
    <div class="drift-row-head">
      <span class="drift-label">${label}</span>
      <span class="drift-verdict dim">${esc(verdict)} · ${esc(sigmasText)}</span>
    </div>
    <div class="drift-row-stats dim">baseline ${meanStr} ± ${sigmaStr} · current ${currentStr}</div>
    ${renderDriftSvg(entry, { drifted })}
  </div>`;
}

async function projectDrift(slug) {
  summary.innerHTML = `<a href="#/" class="dim">‹ all projects</a>`;
  const safeSlug = esc(redactSecrets(String(slug || "")));
  let data;
  try {
    data = await get("/api/projects/" + encodeURIComponent(slug) + "/drift");
  } catch (e) {
    app.innerHTML = `<div class="loading">couldn't load drift detail.<br><span class="dim">${esc(e.message)}</span></div>`;
    return;
  }
  const detected = (data && data.detected) || [];
  const driftedByMetric = new Map();
  for (const d of detected) driftedByMetric.set(d.metric, d);
  // Empty state: the operator clicked through but the project has no
  // active drift. Render a small "no drift detected" card.
  if (detected.length === 0) {
    app.innerHTML = `<a class="back" href="#/">‹ all projects</a>
      <div class="card-head"><span class="pname">${safeSlug}</span></div>
      <div class="project-drift" data-testid="project-drift">
        <div class="eyebrow">Shape drift</div>
        <div class="drift-empty dim">No drift detected — this project's last 24h shape sits inside its 14-day baseline on all three metrics.</div>
      </div>`;
    return;
  }
  const rowsHtml = DRIFT_METRICS_ORDER.map((m) => {
    const drifted = driftedByMetric.get(m);
    if (drifted) return renderDriftRow(m, drifted, true);
    // Healthy metric: synthesise a row from "no detection" by emitting
    // a zero-sigma entry so the SVG still renders for visual scan.
    return renderDriftRow(m, {
      metric: m, baseline_mean: 0, baseline_sigma: 0, current: 0, sigmas: 0,
    }, false);
  }).join("");
  // Contributing runs for any drifted metric, shown as compact chips
  // below the rows. The route navigates into the existing run-detail
  // page so the operator can read the transcript.
  const contribChips = detected.flatMap((d) => {
    return (d.contributing_runs || []).map((rid) =>
      `<a class="chip" href="#/r/${encodeURIComponent(String(rid))}" data-stop="1">run ${esc(String(rid))}</a>`,
    );
  }).join("");
  app.innerHTML = `<a class="back" href="#/">‹ all projects</a>
    <div class="card-head"><span class="pname">${safeSlug}</span></div>
    <div class="project-drift" data-testid="project-drift">
      <div class="eyebrow">Shape drift</div>
      <div class="drift-rows">${rowsHtml}</div>
      ${contribChips ? `<div class="eyebrow">Top contributors</div><div class="drift-contributors">${contribChips}</div>` : ""}
    </div>`;
  foot.textContent = "";
}

// ---- Backlog ticket detail view (ticket 0018) ----------------------------
// One-shot view that renders the "Shipped as PR #N · K commits · +X / -Y
// across Z files" panel from the new /api/backlog/:id/ship-report
// endpoint. For shipped tickets only — the endpoint 404s on tickets with
// no linked commits, in which case we render nothing under the heading
// (operator clicked through from a proposed/groomed ticket). Each commit
// hash links to the GitHub commit page when a repo_url is known on the
// ticket payload, otherwise the SHA renders inline.
function renderShipReport(rep) {
  if (!rep) return "";
  const commits = (rep.commits || []).map((c) => {
    const shaShort = String(c.commit_sha || "").slice(0, 12);
    const subject = esc(c.message_subject || "");
    return `<li class="ship-commit"><code class="mono">${esc(shaShort)}</code> `
      + `<span class="dim">· ${esc(c.author || "")} · ${esc(ago(c.commit_date))}</span> `
      + `· ${subject}</li>`;
  }).join("");
  const pr = rep.pr_number != null
    ? `PR #${esc(String(rep.pr_number))} `
    : "";
  const headline = `${pr}· <b>${rep.commits.length}</b> commit${rep.commits.length === 1 ? "" : "s"}`
    + ` · <b>+${esc(String(rep.total_insertions))}</b> / <b>−${esc(String(rep.total_deletions))}</b>`
    + ` across <b>${esc(String(rep.total_files_changed))}</b> file${rep.total_files_changed === 1 ? "" : "s"}`;
  return `<div class="ship-report">
    <div class="eyebrow">Shipped as</div>
    <div class="ship-headline">${headline}</div>
    <ul class="ship-commits">${commits}</ul>
  </div>`;
}

async function backlog(id) {
  summary.innerHTML = `<a href="#/" class="dim">‹ all projects</a>`;
  const tid = String(id || "").match(/^\d{4}$/) ? id : "";
  if (!tid) {
    app.innerHTML = `<div class="loading">unknown ticket id: <code class="mono">${esc(String(id))}</code></div>`;
    return;
  }
  let rep = null;
  try {
    const r = await fetch("/api/backlog/" + encodeURIComponent(tid) + "/ship-report");
    if (r.ok) rep = await r.json();
    // 404 leaves rep=null so the "Shipped as" section renders nothing
    // (proposed / groomed / in-progress tickets fall here).
  } catch { /* network blip — render the empty page */ }
  app.innerHTML = `<a class="back" href="#/">‹ all projects</a>
    <div class="card-head"><span class="pname">Ticket ${esc(tid)}</span></div>
    ${renderShipReport(rep)}`;
  foot.textContent = "";
}

async function route() {
  stop();
  const h = location.hash || "#/";
  try {
    const { path, params } = parseHash(h);
    if (path.startsWith("p/")) {
      const s = path.slice(2);
      await project(s, params);
      timer = setInterval(() => project(s, params).catch(() => {}), 5000);
    } else if (path.startsWith("project/") && path.endsWith("/drift")) {
      // Ticket 0034: self-baseline drift detail view. One-shot render
      // — the operator is reading static contributors, not monitoring
      // a live process; the inbox refresh on home is the live surface.
      const s = path.slice("project/".length, path.length - "/drift".length);
      await projectDrift(decodeURIComponent(s));
    } else if (path.startsWith("r/")) {
      await run(path.slice(2));
    } else if (path.startsWith("t/")) {
      // Ticket 0018: backlog ticket detail page with the "Shipped as"
      // auto-link panel. One-shot render — no polling timer because
      // the data is the merged-commit history, which only changes
      // when a new PR lands (the next home() tick will pick it up).
      await backlog(path.slice(2));
    } else if (path.startsWith("correlation/")) {
      // Ticket 0027: fleet-correlation detail view. One-shot render
      // — no polling timer because the operator is reading, not
      // monitoring; the inbox refresh on the home view is the live
      // surface.
      await correlation(path.slice("correlation/".length));
    } else if (path === "leaderboard" || path.startsWith("leaderboard")) {
      // Ticket 0014: cross-project tool-call leaderboard. One-shot
      // render — no polling timer because the data window is fixed
      // (last 14 days) and the leaderboard is a "glance" view, not a
      // live monitor.
      await leaderboard();
    } else if (path === "cost-per-pr" || path.startsWith("cost-per-pr")) {
      // Ticket 0035: cost per merged PR detail. One-shot render — the
      // data is a 5-min cached aggregate, not a live monitor; the
      // home view's 5s refresh picks up new numbers via the summary
      // line.
      await costPerPr();
    } else {
      await home();
      timer = setInterval(() => home().catch(() => {}), 5000);
    }
    // Ticket 0032: after rendering, check whether the operator just
    // arrived via /pair?... and (if so + a beforeinstallprompt is
    // pending) surface the install hint. The function is a no-op when
    // any precondition fails.
    try { maybeRenderPairInstallHint(); } catch { /* swallow */ }
  } catch (e) {
    app.innerHTML = `<div class="loading">couldn’t reach the fleet server.<br><span class="dim">${esc(e.message)}</span></div>`;
  }
}
window.addEventListener("hashchange", route);
// Kick off the pricing-meta fetch in parallel with the first route — the
// home view's first paint may land before pricingFooter() has data, which
// is fine (no line); the 5s refresh interval will pick it up on the next
// tick. We also re-poll every 5min so a long-lived tab eventually flips
// the stale warning when fetched_at crosses the 24h mark.
refreshPricingMeta();
setInterval(refreshPricingMeta, 5 * 60_000);
route();
