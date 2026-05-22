// Central configuration + well-known paths. Everything is local; no cloud.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";

const HOME = homedir();

export interface FleetConfig {
  /** Folders scanned for `<project>/agents.config.sh`. */
  projectRoots: string[];
  /** TCC-safe install location where install.sh copies each manifest. */
  installedRoot: string;
  /** Our own state DB (outside ~/.cache so a cache wipe keeps history). */
  dbPath: string;
  /** Base of per-agent caches: ~/.cache/<slug>-agent/... */
  cacheBase: string;
  /** Base of Claude Code session transcripts. */
  claudeProjects: string;
  /** Server bind host. 127.0.0.1 (default) = local only; 0.0.0.0 = LAN. */
  host?: string;
  /** Server port. */
  port?: number;
}

const DEFAULTS: FleetConfig = {
  projectRoots: [join(HOME, "Desktop", "projects")],
  installedRoot: join(HOME, ".local", "share", "agent-fleet", "projects"),
  dbPath: join(HOME, ".local", "state", "fleet-control", "fleet.db"),
  cacheBase: join(HOME, ".cache"),
  claudeProjects: join(HOME, ".claude", "projects"),
  host: "127.0.0.1",
  port: 7070,
};

/** Load config, merging an optional fleet-control.config.json next to the repo. */
export function loadConfig(): FleetConfig {
  const cfg = { ...DEFAULTS };
  const local = join(process.cwd(), "fleet-control.config.json");
  if (existsSync(local)) {
    try {
      Object.assign(cfg, JSON.parse(readFileSync(local, "utf8")));
    } catch { /* ignore malformed local config */ }
  }
  // Ensure the state dir exists.
  mkdirSync(join(cfg.dbPath, ".."), { recursive: true });
  return cfg;
}

/**
 * Map an absolute agent checkout path to its Claude Code transcript dir name.
 * e.g. /Users/x/.cache/courtiq-agent/review-checkout
 *   -> -Users-x--cache-courtiq-agent-review-checkout
 * (slashes -> '-', and the '.' in .cache becomes the double-dash).
 */
export function transcriptDirFor(checkoutAbsPath: string): string {
  return checkoutAbsPath.replace(/\//g, "-").replace(/\./g, "-");
}
