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
  wrap.innerHTML = `<div class="modal">${kind === "ticket" ? ticketForm(slug) : addForm()}</div>`;
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
    <p class="dim">Connect a folder you already have. It must be a git repo pushed to GitHub.</p>
    ${field("a-path", "Folder path", "/Users/you/Desktop/projects/myapp")}
    ${field("a-name", "Name (optional)", "My App")}
    <div class="frow">
      <label class="fld"><span>Keep running for</span><select id="a-days"><option value="30">30 days</option><option value="90">90 days</option><option value="14">14 days</option></select></label>
      <label class="chk"><input type="checkbox" id="a-eng"> Also let it tidy the code</label>
    </div>
    <div class="frow end"><button class="btn" onclick="closeModal()">Cancel</button><button class="btn primary" data-submit="add">Connect & start</button></div>`;
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
  } else {
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
async function home() {
  const data = await get("/api/fleet");
  const alerts = data.alerts || [];
  summary.innerHTML = `${alerts.length ? `<span class="bell">${alerts.length} alert${alerts.length === 1 ? "" : "s"}</span> · ` : ""}<b>${data.projects.length}</b> projects · <b>${usd(data.totals.cost)}</b> est. effort`;
  app.innerHTML =
    (alerts.length ? `<div class="eyebrow">Needs attention</div>` + alerts.map(alertRow).join("") : "") +
    `<div class="eyebrow rowflex">Your projects <button class="btn sm" data-modal="add">+ Add a project</button></div>` + data.projects.map(card).join("") +
    `<div class="eyebrow" style="margin-top:28px">Across the fleet</div>
     <div class="card"><div class="metarow">
       <span>total runs <b class="cost">${data.totals.runs}</b></span>
       <span>this week <b class="cost">${usd(data.projects.reduce((s, p) => s + (p.cost7d || 0), 0))}</b></span>
       <span class="dim">estimated effort · agents run on your Max plan (no real bill)</span>
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
      <button class="btn primary" data-modal="ticket" data-slug="${p.slug}">Tell it what to build</button>
    </div>
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
