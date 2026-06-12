// Boot helper for tests/graveyard.test.ts.
//
// Plants an empty-roots fleet-control.config.json in cwd (snapshots +
// restores prior contents on cleanup) and boots startServer() against
// a tmpdir DB path the caller already seeded. Per LESSONS 2026-05-26
// "in-process startServer() tests need an empty-roots config + run-row
// seeds" — the empty roots stop runIngestPass from walking the
// operator's real filesystem.
//
// IMPORTANT: this helper writes the SAME shape every call (an empty-
// roots config) so concurrent test files don't see a quietHours/
// per-project-override race (per LESSONS 2026-06-11 "startServer()
// tests that mutate fleet-control.config.json race against parallel
// test files"). Branch tests that need a non-default config field
// MUST use the renderer-direct seam exported from src/server.ts.

import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync,
  unlinkSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.ts";

export interface Booted {
  base: string;
  close: () => Promise<void>;
  cleanup: () => void;
}

let activeBoots = 0;
let savedConfigText: string | null = null;
const CONFIG_PATH = join(process.cwd(), "fleet-control.config.json");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    import("node:net").then((net) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const a = srv.address();
        if (a && typeof a === "object") {
          const p = a.port;
          srv.close(() => resolve(p));
        } else { srv.close(); reject(new Error("no port")); }
      });
      srv.on("error", reject);
    }).catch(reject);
  });
}

export async function boot(dbPath: string): Promise<Booted> {
  const emptyRootsDir = mkdtempSync(join(tmpdir(), "fleet-graveyard-roots-"));
  mkdirSync(emptyRootsDir, { recursive: true });
  if (activeBoots === 0) {
    savedConfigText = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null;
  }
  activeBoots += 1;
  writeFileSync(CONFIG_PATH, JSON.stringify({
    projectRoots: [emptyRootsDir],
    installedRoot: emptyRootsDir,
    cacheBase: emptyRootsDir,
    claudeProjects: emptyRootsDir,
  }));
  process.env.FLEET_DB_PATH = dbPath;
  const port = await freePort();
  const server = startServer("127.0.0.1", port);
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(base + "/api/whoami"); if (r.ok) break; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  return {
    base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    cleanup: () => {
      delete process.env.FLEET_DB_PATH;
      activeBoots -= 1;
      if (activeBoots === 0) {
        if (savedConfigText === null) {
          try { unlinkSync(CONFIG_PATH); } catch { /* */ }
        } else {
          writeFileSync(CONFIG_PATH, savedConfigText);
        }
        savedConfigText = null;
      }
      rmSync(emptyRootsDir, { recursive: true, force: true });
    },
  };
}
