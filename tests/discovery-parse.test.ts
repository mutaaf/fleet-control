// Unit tests for the shell-manifest parser in src/discovery.ts.
//
// The parser used to crash discovery when a manifest had `KEY="value"#comment`
// with no space before the `#` — the old regex required whitespace, so the
// comment leaked into the value and every downstream `Number()` coercion
// produced NaN, ultimately throwing "Invalid time value" inside fleetView.
//
// These tests pin the bash-compatible behavior so it doesn't regress.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverManifests } from "../src/discovery.ts";

function tmpRoot(manifest: string): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "fleet-parse-"));
  const proj = join(root, "myproject");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "agents.config.sh"), manifest);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const baseCfg = (root: string) => ({
  projectRoots: [root],
  installedRoot: join(root, "_no_installed"),
  cacheBase: join(root, "_no_cache"),
});

test("parser: quoted value with comment but no space before #", () => {
  // The regression case. Bash treats `"3600"# comment` as VALUE=3600. The
  // parser must too — otherwise discovery.ts feeds garbage into cadence_json
  // and fleetView's toISOString call throws.
  const { root, cleanup } = tmpRoot([
    'SLUG=test',
    'REPO_URL=https://github.com/example/repo',
    'REVIEW_INTERVAL="3600"# no space before hash',
  ].join("\n"));
  try {
    const ms = discoverManifests(baseCfg(root));
    assert.equal(ms.length, 1);
    assert.equal(ms[0].cadence.review_interval, "3600");
  } finally { cleanup(); }
});

test("parser: quoted value with whitespace + comment", () => {
  const { root, cleanup } = tmpRoot([
    'SLUG=test',
    'REPO_URL=https://github.com/example/repo',
    'REVIEW_INTERVAL="1800"  # spaces are fine too',
  ].join("\n"));
  try {
    const ms = discoverManifests(baseCfg(root));
    assert.equal(ms[0].cadence.review_interval, "1800");
  } finally { cleanup(); }
});

test("parser: unquoted value with comment", () => {
  const { root, cleanup } = tmpRoot([
    'SLUG=test',
    'REPO_URL=https://github.com/example/repo',
    'SHIP_MINUTE=41 # unquoted with comment',
  ].join("\n"));
  try {
    const ms = discoverManifests(baseCfg(root));
    assert.equal(ms[0].cadence.ship_minute, "41");
  } finally { cleanup(); }
});

test("parser: quoted value with internal spaces survives", () => {
  // SHIP_HOURS="0 6 12 18" — the spaces inside the quotes are part of the
  // value, NOT a separator. Easy to break with a naive .split() approach.
  const { root, cleanup } = tmpRoot([
    'SLUG=test',
    'REPO_URL=https://github.com/example/repo',
    'SHIP_HOURS="0 6 12 18"',
  ].join("\n"));
  try {
    const ms = discoverManifests(baseCfg(root));
    assert.equal(ms[0].cadence.ship_hours, "0 6 12 18");
  } finally { cleanup(); }
});

test("parser: empty value is preserved", () => {
  // Manifests written by fleet-control's set-budget action use MAX_DAILY_USD=""
  // to mean "no cap". The parser must round-trip the empty string, not turn
  // it into the literal `""`.
  const { root, cleanup } = tmpRoot([
    'SLUG=test',
    'REPO_URL=https://github.com/example/repo',
    'MAX_DAILY_USD=""',
  ].join("\n"));
  try {
    const ms = discoverManifests(baseCfg(root));
    assert.equal(ms[0].cadence.max_daily_usd, "");
  } finally { cleanup(); }
});
