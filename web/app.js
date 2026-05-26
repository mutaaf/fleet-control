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
async function get(p) { const r = await fetch(p); if (!r.ok) throw new Error(p); return r.json(); }

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
  toast(d.message || (d.ok ? "done" : "failed"), d.ok);
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
  // Fan out /api/fleet + /api/digest/week so the second round-trip doesn't
  // delay the rest of the page. The banner is rendered above the alerts.
  const [data, digestData] = await Promise.all([get("/api/fleet"), fetchDigest()]);
  const alerts = data.alerts || [];
  summary.innerHTML = `${alerts.length ? `<span class="bell">${alerts.length} alert${alerts.length === 1 ? "" : "s"}</span> · ` : ""}<b>${data.projects.length}</b> projects · <b>${usd(data.totals.cost)}</b> est. effort · <a href="#/leaderboard" class="navlink">Compare ›</a>`;
  // Cache pace info so the "Set fleet pace" modal can show the current mix.
  window._allPaces = data.projects.map((p) => ({ slug: p.slug, pace: p.pace || "custom" }));
  app.innerHTML =
    digestBanner(digestData) +
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
    <div class="card-head"><span class="pname">${esc(p.name)}</span>
      <span class="state"><span class="dot ${cls}"></span>${label}${anomalyPill(p)}</span></div>
    ${telemetry(p.telemetry)}
    ${nowLine || (lastAny ? `<div class="job">Last: ${OUTCOME[lastAny.outcome] || lastAny.outcome || "ran"} · ${ago(lastAny.started_at)}</div>` : "")}
    <div class="metarow">
      ${nextJob ? `<span>next: ${PHASE[nextJob.phase].toLowerCase()} <b>${until(nextJob.next)}</b></span>` : `<span class="dim">paused</span>`}
      <span>this week <b class="cost">${usd(p.cost7d)}</b></span>
      <span>${forecastSpan(p.forecast)}</span>
      <span class="dim">${p.runs} runs</span>
    </div>${ulBanner}${akBanner}${banner}</a>`;
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
    <div class="eyebrow">The jobs</div>
    ${p.jobs.map((j) => jobCard(j, p.slug)).join("")}
    <div class="eyebrow">Anomalies</div>
    <div id="anomaly-section" class="jobcard"><div class="kv dim">checking…</div></div>
    <div class="eyebrow">Disk</div>
    <div id="disk-section" class="jobcard"><div class="kv dim">checking…</div></div>
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
}
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
async function loadDiskSection(slug) {
  const el = document.getElementById("disk-section");
  if (!el) return;
  let d;
  try { d = await get("/api/projects/" + encodeURIComponent(slug) + "/disk"); }
  catch { el.innerHTML = `<div class="kv dim">couldn't read disk usage</div>`; return; }
  const candidates = (d.candidates || []);
  const rows = candidates.map((c) =>
    `<div class="kv mono"><span class="lbl">${c.age_days.toFixed(1)}d</span>${esc(c.path)} <span class="faint">· ${fmtBytes(c.bytes)}</span></div>`,
  ).join("");
  const hasStale = candidates.some((c) => c.age_days >= 14);
  el.innerHTML = `
    <h3>Cache footprint <span class="jobactions">
      <button class="btn sm${hasStale ? " primary" : ""}" data-act="clean-checkouts" data-slug="${esc(slug)}"
        data-confirm="Clean checkouts older than 14 days for ${esc(slug)}? This removes only stale agent working trees — runs.jsonl, events.jsonl, and logs/ stay put.">
        Clean checkouts older than 14 days</button>
    </span></h3>
    <div class="metarow">
      <span>${fmtBytes(d.bytes)} on disk</span>
      <span>${d.checkout_count} checkout${d.checkout_count === 1 ? "" : "s"}</span>
      <span>oldest <b>${d.oldest_age_days.toFixed(1)}d</b></span>
    </div>
    ${candidates.length ? `<details style="margin-top:8px"><summary class="dim">show candidates</summary>${rows}</details>`
                        : `<div class="kv dim">no checkout directories</div>`}
  `;
}
function nowBanner(ev) {
  if (!ev) return "";
  const phaseName = PHASE[ev.phase] || ev.phase || "An agent";
  return `<div class="banner">● ${esc(phaseName)} is running now — started ${ago(ev.ts)}.</div>`;
}
function prSection(p) {
  const prs = (p.prs || []).filter((x) => x.is_agent);
  if (!prs.length) return "";
  const ci = { green: "✓ checks pass", red: "✗ checks failing", pending: "checks running…", none: "" };
  return `<div class="eyebrow">Finished work waiting for you</div>` + prs.map((pr) => `
    <div class="card pr-card" data-pr-card data-slug="${esc(p.slug)}" data-repo="${esc(p.repo)}" data-number="${pr.number}" data-url="${esc(pr.url || "")}">
      <div class="card-head pr-head" data-pr-toggle>
        <span class="pname" style="font-size:15px">${esc(pr.title)}</span>
        <span class="state dim mono">#${pr.number} · ${ci[pr.ci_state] || ""} <span class="pr-caret">▸</span></span>
      </div>
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
    </div>`).join("");
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
async function route() {
  stop();
  const h = location.hash || "#/";
  try {
    const { path, params } = parseHash(h);
    if (path.startsWith("p/")) {
      const s = path.slice(2);
      await project(s, params);
      timer = setInterval(() => project(s, params).catch(() => {}), 5000);
    } else if (path.startsWith("r/")) {
      await run(path.slice(2));
    } else if (path === "leaderboard" || path.startsWith("leaderboard")) {
      // Ticket 0014: cross-project tool-call leaderboard. One-shot
      // render — no polling timer because the data window is fixed
      // (last 14 days) and the leaderboard is a "glance" view, not a
      // live monitor.
      await leaderboard();
    } else {
      await home();
      timer = setInterval(() => home().catch(() => {}), 5000);
    }
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
