// Fleet control plane SPA (zero-dep). Plain language by default; hash routing.
const app = document.getElementById("app");
const summary = document.getElementById("fleet-summary");
const foot = document.getElementById("foot");

const PHASE = { ship: "Builds features", groom: "Comes up with ideas", review: "Checks the work", eng: "Tidies the code" };
const STATE = {
  working: ["working", "Working"], idle: ["idle", "Idle · on"], attention: ["attention", "Needs you"],
  expired: ["expired", "Stopped"], off: ["off", "Paused"],
};
const OUTCOME = {
  shipped: "shipped a feature", healed: "fixed the last work", "no-op": "nothing to do",
  "reviewed-ok": "checked — looks good", "reviewed-changes": "sent work back", "self-cancel": "stopped (limit)",
};

const usd = (n) => (n == null ? "—" : "$" + (+n).toFixed(2));
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
  const b = e.target.closest("[data-act]");
  if (!b) return;
  e.preventDefault();
  if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
  act(b.dataset.act, { slug: b.dataset.slug, phase: b.dataset.phase || undefined, days: b.dataset.days ? +b.dataset.days : undefined, enabled: b.dataset.enabled === "1" });
});

let timer = null;
const stop = () => { if (timer) { clearInterval(timer); timer = null; } };

function telemetry(arr) {
  if (!arr || !arr.length) return "";
  return `<div class="telemetry">${arr.map((o) => `<span class="tick ${esc(o ?? "no-op")}"></span>`).join("")}</div>`;
}

// ---- Home -----------------------------------------------------------------
async function home() {
  const data = await get("/api/fleet");
  summary.innerHTML = `<b>${data.projects.length}</b> projects · <b>${usd(data.totals.cost)}</b> est. effort`;
  app.innerHTML = `<div class="eyebrow">Your projects</div>` + data.projects.map(card).join("") +
    `<div class="eyebrow" style="margin-top:28px">Across the fleet</div>
     <div class="card"><div class="metarow">
       <span>total runs <b class="cost">${data.totals.runs}</b></span>
       <span>this week <b class="cost">${usd(data.projects.reduce((s, p) => s + (p.cost7d || 0), 0))}</b></span>
       <span class="dim">estimated effort · agents run on your Max plan (no real bill)</span>
     </div></div>`;
  foot.textContent = "updated " + new Date(data.generatedAt).toLocaleTimeString();
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
  const banner = sc != null && sc < 0
    ? `<div class="banner bad">Stopped working — its safety limit passed. Open it to restart.</div>`
    : sc != null && sc <= 3
      ? `<div class="banner">Stops working in ${sc} day${sc === 1 ? "" : "s"} unless you keep it running.</div>` : "";
  return `<a class="card" href="#/p/${p.slug}">
    <div class="card-head"><span class="pname">${esc(p.name)}</span>
      <span class="state"><span class="dot ${cls}"></span>${label}</span></div>
    ${telemetry(p.telemetry)}
    ${nowLine || (lastAny ? `<div class="job">Last: ${OUTCOME[lastAny.outcome] || lastAny.outcome || "ran"} · ${ago(lastAny.started_at)}</div>` : "")}
    <div class="metarow">
      ${nextJob ? `<span>next: ${PHASE[nextJob.phase].toLowerCase()} <b>${until(nextJob.next)}</b></span>` : `<span class="dim">paused</span>`}
      <span>this week <b class="cost">${usd(p.cost7d)}</b></span>
      <span class="dim">${p.runs} runs</span>
    </div>${banner}</a>`;
}

// ---- Project --------------------------------------------------------------
async function project(slug) {
  const p = await get("/api/project/" + slug);
  summary.innerHTML = `<a href="#/" class="dim">‹ all projects</a>`;
  const [cls, label] = STATE[p.displayState] || STATE.off;
  app.innerHTML = `<a class="back" href="#/">‹ all projects</a>
    <div class="card-head" style="margin-bottom:6px"><span class="pname">${esc(p.name)}</span>
      <span class="state"><span class="dot ${cls}"></span>${label}</span></div>
    <div class="metarow"><span class="dim mono">${esc(p.repo)}</span>
      ${p.selfCancelDays != null ? `<span>${p.selfCancelDays < 0 ? "stopped" : "keeps running " + p.selfCancelDays + "d"}</span>` : ""}</div>
    <div class="actions">
      ${p.selfCancelDays != null && p.selfCancelDays <= 7 ? `<button class="btn primary" data-act="keep-running" data-slug="${p.slug}" data-days="30">Keep it running (+30 days)</button>` : `<button class="btn" data-act="keep-running" data-slug="${p.slug}" data-days="30">Keep it running (+30 days)</button>`}
      <button class="btn" data-act="resume" data-slug="${p.slug}">Resume all jobs</button>
      <button class="btn" data-act="pause" data-slug="${p.slug}" data-confirm="Pause all of ${esc(p.name)}’s jobs? It will stop working autonomously until resumed.">Pause project</button>
      <button class="btn" data-act="eng-toggle" data-slug="${p.slug}" data-enabled="${p.engEnabled ? "0" : "1"}">${p.engEnabled ? "Turn off code-tidying" : "Also tidy the code"}</button>
    </div>
    <div class="eyebrow">The jobs</div>
    ${p.jobs.map((j) => jobCard(j, p.slug)).join("")}
    <div class="eyebrow">Recent activity</div>
    <table><thead><tr><th>when</th><th>job</th><th>did</th><th>PR</th><th>tokens</th><th>cost</th></tr></thead>
    <tbody>${p.recent.map(runRow).join("")}</tbody></table>`;
  foot.textContent = "live · " + new Date().toLocaleTimeString();
}
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
async function run(id) {
  const d = await get("/api/run/" + id);
  summary.innerHTML = `<a href="#/p/${d.project.slug}" class="dim">‹ ${esc(d.project.name)}</a>`;
  const r = d.run;
  app.innerHTML = `<a class="back" href="#/p/${d.project.slug}">‹ ${esc(d.project.name)}</a>
    <div class="card-head"><span class="pname">${PHASE[r.phase] || r.phase} · ${OUTCOME[r.outcome] || r.outcome || "run"}</span></div>
    <div class="metarow">
      <span>${ago(r.started_at)}</span><span>${r.num_turns} turns</span>
      <span class="cost">${usd(r.cost_usd ?? r.cost_usd_computed)} <span class="faint">(${r.cost_source})</span></span>
      ${r.pr_number ? `<span>PR #${r.pr_number}</span>` : ""}
      <span class="faint">in ${toks(r.input_tokens)} · out ${toks(r.output_tokens)} · cache-rd ${toks(r.cache_read_tokens)}</span>
    </div>
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
async function route() {
  stop();
  const h = location.hash || "#/";
  try {
    if (h.startsWith("#/p/")) { const s = h.slice(4); await project(s); timer = setInterval(() => project(s).catch(() => {}), 5000); }
    else if (h.startsWith("#/r/")) { await run(h.slice(4)); }
    else { await home(); timer = setInterval(() => home().catch(() => {}), 5000); }
  } catch (e) {
    app.innerHTML = `<div class="loading">couldn’t reach the fleet server.<br><span class="dim">${esc(e.message)}</span></div>`;
  }
}
window.addEventListener("hashchange", route);
route();
