// Discover fleet projects (mirrors agent-fleet/bin/fleet) and resolve the
// legacy-slug aliases (dca->digitalcraft, sportsiq->courtiq) by git remote.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { FleetConfig } from "./config.ts";
import type { DB } from "./db.ts";

export interface Manifest {
  slug: string;
  name: string;
  namespace: string;
  repoUrl: string;
  model: string;
  selfCancel: string;
  engEnabled: boolean;
  cadence: Record<string, string>;
  manifestPath: string;
}

/** Parse the simple KEY=value shell manifest (read-only, no sourcing).
 *
 *  Match bash's value semantics for the patterns we actually see in the
 *  fleet's manifests:
 *
 *    KEY=value                → value
 *    KEY=value  # comment     → value
 *    KEY="value"              → value
 *    KEY="value"  # comment   → value
 *    KEY="value"# comment     → value   (no space before `#` after a closed
 *                                        quote — what bash accepts and what
 *                                        broke discovery once, see #43 era)
 *    KEY='value w/ spaces'    → value w/ spaces
 *
 *  A previous version did `.replace(/\s+#.*$/, "")` which required whitespace
 *  before the `#`, so `KEY="3600"# comment` parsed as `3600"# comment` and
 *  every downstream Number() coercion produced NaN, which crashed fleetView
 *  via `new Date(NaN).toISOString()`.
 */
function _parseManifestValue(raw: string): string {
  const s = raw.trim();
  if (s[0] === '"' || s[0] === "'") {
    const q = s[0];
    let end = 1;
    while (end < s.length && s[end] !== q) end++;
    // After the closing quote, anything (including a leading `#` with no
    // space) is comment. We don't need to read past it.
    return s.slice(1, end);
  }
  // Unquoted: stop at first whitespace or `#`.
  return s.replace(/[\s#].*$/, "");
}

function parseManifest(path: string): Manifest | null {
  const text = readFileSync(path, "utf8");
  const v: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    v[m[1]] = _parseManifestValue(m[2]);
  }
  if (!v.SLUG || !v.REPO_URL) return null;
  return {
    slug: v.SLUG,
    name: v.PROJECT_NAME ?? v.SLUG,
    namespace: v.NAMESPACE ?? `com.fleet.${v.SLUG}`,
    repoUrl: v.REPO_URL,
    model: v.MODEL ?? "claude-opus-4-7",
    selfCancel: v.SELF_CANCEL ?? "",
    engEnabled: v.ENG_ENABLED === "1",
    cadence: {
      ship_hours: v.SHIP_HOURS ?? "",                // optional; empty = every hour
      ship_minute: v.SHIP_MINUTE ?? "41",
      groom_hours: v.GROOM_HOURS ?? "0 6 12 18",
      groom_minute: v.GROOM_MINUTE ?? "17",
      review_interval: v.REVIEW_INTERVAL ?? "300",
      eng_hours: v.ENG_HOURS ?? "",
      eng_minute: v.ENG_MINUTE ?? "",
      max_daily_usd: v.MAX_DAILY_USD ?? "",          // optional daily $ cap (ticket 0004)
    },
    manifestPath: path,
  };
}

function repoSlug(url: string): string {
  return url.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
}

/** Read a git checkout's origin url from .git/config (no spawn). */
function gitRemote(checkoutDir: string): string | null {
  const cfg = join(checkoutDir, ".git", "config");
  if (!existsSync(cfg)) return null;
  const m = readFileSync(cfg, "utf8").match(/^\s*url\s*=\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

/** Union working-tree + installed manifests, de-dup by SLUG (working wins). */
export function discoverManifests(cfg: FleetConfig): Manifest[] {
  const found: string[] = [];
  for (const root of cfg.projectRoots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const p = join(root, entry.name, "agents.config.sh");
      if (existsSync(p)) found.push(p);
    }
  }
  if (existsSync(cfg.installedRoot))
    for (const entry of readdirSync(cfg.installedRoot, { withFileTypes: true })) {
      const p = join(cfg.installedRoot, entry.name, "agents.config.sh");
      if (existsSync(p)) found.push(p);
    }
  const bySlug = new Map<string, Manifest>();
  for (const path of found) {
    const m = parseManifest(path);
    if (m && !bySlug.has(m.slug)) bySlug.set(m.slug, m);
  }
  return [...bySlug.values()];
}

/** Upsert projects + agents and resolve legacy-slug aliases. */
export function syncProjects(db: DB, cfg: FleetConfig): Manifest[] {
  const manifests = discoverManifests(cfg);
  const now = new Date().toISOString();
  const byRepo = new Map<string, number>(); // repoSlug -> project_id

  const up = db.prepare(`
    INSERT INTO project(slug,name,namespace,repo_url,repo_owner,repo_name,model,self_cancel,eng_enabled,manifest_path,cadence_json,first_seen_at,last_seen_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(slug) DO UPDATE SET
      name=excluded.name, namespace=excluded.namespace, repo_url=excluded.repo_url,
      model=excluded.model, self_cancel=excluded.self_cancel, eng_enabled=excluded.eng_enabled,
      manifest_path=excluded.manifest_path, cadence_json=excluded.cadence_json, last_seen_at=excluded.last_seen_at`);
  const getId = db.prepare("SELECT id FROM project WHERE slug=?");
  const agentUp = db.prepare(
    "INSERT INTO agent(project_id,phase,launchd_label) VALUES(?,?,?) ON CONFLICT(project_id,phase) DO UPDATE SET launchd_label=excluded.launchd_label",
  );

  for (const m of manifests) {
    const [owner, name] = repoSlug(m.repoUrl).split("/");
    up.run(m.slug, m.name, m.namespace, m.repoUrl, owner ?? null, name ?? null, m.model,
      m.selfCancel, m.engEnabled ? 1 : 0, m.manifestPath, JSON.stringify(m.cadence), now, now);
    const id = (getId.get(m.slug) as { id: number }).id;
    byRepo.set(repoSlug(m.repoUrl), id);
    const phases = ["ship", "groom", "review", ...(m.engEnabled ? ["eng"] : [])];
    for (const ph of phases) agentUp.run(id, ph, `${m.namespace}.agent-${ph}`);
  }

  // Aliases: cache dirs whose slug isn't a current project, mapped by git remote.
  const aliasUp = db.prepare(
    "INSERT INTO project_alias(project_id,alias_slug,kind) VALUES(?,?,?) ON CONFLICT(alias_slug) DO NOTHING",
  );
  const currentSlugs = new Set(manifests.map((m) => m.slug));
  // every current slug is its own alias (so ingest can treat all uniformly)
  for (const m of manifests) {
    const id = (getId.get(m.slug) as { id: number }).id;
    aliasUp.run(id, m.slug, "current");
  }
  if (existsSync(cfg.cacheBase))
    for (const entry of readdirSync(cfg.cacheBase, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith("-agent")) continue;
      const slug = entry.name.replace(/-agent$/, "");
      if (currentSlugs.has(slug)) continue;
      // resolve by the checkout's git remote
      for (const sub of ["checkout", "review-checkout", "eng-checkout", "groom-checkout"]) {
        const url = gitRemote(join(cfg.cacheBase, entry.name, sub));
        if (url) {
          const pid = byRepo.get(repoSlug(url));
          if (pid) aliasUp.run(pid, slug, "legacy-cache");
          break;
        }
      }
    }
  return manifests;
}
