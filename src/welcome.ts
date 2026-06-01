// `fleetctl serve` first-run welcome — ticket 0024.
//
// Goal: close the cold-start gap between "the server is up" and "I see
// something useful in the portal" with a single printed checklist. Pure
// rendering plus an injectable filesystem surface so every check is
// unit-testable without touching the operator's real $HOME.
//
// Discipline:
//   - zero new runtime deps (stdlib only);
//   - the admin token literal is NEVER embedded; the welcome carries a
//     PATH to the file that owns it, not the value. As a defence-in-
//     depth layer (per docs/LESSONS.md § defence-in-depth secret
//     redaction at the renderer boundary) the rendered string is run
//     through `redactSecrets()` before return so a future regression
//     where a check author accidentally interpolates a token-shaped
//     value is caught at the renderer boundary.
//   - the sentinel write failure path is non-fatal: a single warn line
//     and serve continues — never crash the server because a config dir
//     is read-only.
//   - sentinel path resolution honours FLEET_HOME first (test seam),
//     then XDG_CONFIG_HOME, then $HOME/.config. This matches the
//     existing FLEET_DB_PATH env-seam pattern (LESSONS.md § CLI
//     subprocess tests need a FLEET_DB_PATH env seam).
import { join } from "node:path";
import { renderQrAscii } from "./qr.ts";

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

/** Options for renderWelcome — pure render input. */
export interface WelcomeOpts {
  /** The admin token VALUE. Kept opaque: never embedded in the rendered
   *  string. Present here so a future check can warn if it's missing,
   *  not so we can print it. */
  token: string;
  /** Bind host as configured (`127.0.0.1`, `0.0.0.0`, etc). 0.0.0.0 is
   *  rendered as `localhost` in the portal URL so the operator can
   *  click it. */
  host: string;
  /** Bind port (default 7070). */
  port: number;
  /** Absolute path to the operator's `fleet-control.config.json`. */
  configPath: string;
  /** Where the admin token came from — surfaces in the LAN tip line so
   *  the operator knows what file to look at. */
  tokenSource: "config" | "env" | "new";
  /** Print ANSI escape codes? Caller decides based on
   *  `process.stdout.isTTY`. */
  color: boolean;
  /** Existing project slugs (cap 3 shown; trailing `…` if more).
   *  Empty array → renders the `fleetctl register <github-url>` hint. */
  projects: string[];
  /** Absolute path of the `.welcome-seen` sentinel file — surfaced in
   *  the footer so the operator can `touch` it themselves. */
  sentinelPath: string;
  /** Optional phone-pairing section (ticket 0032). When present, the
   *  rendered welcome appends a "Scan from your phone to pair (90s):"
   *  block between the existing line 5 and the "Hide this with:"
   *  footer. When absent the welcome output is byte-identical to
   *  pre-0032 — every existing test that doesn't pass this opt
   *  continues to see the same string. `qrText` is the upper-case
   *  alphanumeric form the QR encoder will accept (typically a path-
   *  style URL); `url` is the human-readable form the operator can
   *  type if scanning fails. The renderer trusts both values to be
   *  safe to print (no admin-token interpolation) but passes the
   *  final string through redactSecrets as a defence-in-depth
   *  backstop per LESSONS § "defence-in-depth secret redaction at
   *  the renderer boundary". */
  pairSection?: {
    url: string;
    qrText: string;
  };
}

/** Injected filesystem surface. Production wires this to `node:fs`
 *  sync calls; tests stub it. */
export interface WelcomeDeps {
  fileExists: (path: string) => boolean;
  writeFile: (path: string, body: string) => void;
  mkdir: (path: string) => void;
  log: (line: string) => void;
  warn: (line: string) => void;
}

/** Behavioural overrides on `firstRun`. */
export interface FirstRunOpts {
  /** Print the welcome regardless of the sentinel (the `--welcome` flag). */
  force?: boolean;
  /** Suppress the welcome regardless of the sentinel; do NOT write the
   *  sentinel (the `--no-welcome` flag). */
  suppress?: boolean;
}

// ────────────────────────────────────────────────────────────────────
// Sentinel-path resolution (env-seam friendly)
// ────────────────────────────────────────────────────────────────────

/** Resolve the absolute sentinel path. FLEET_HOME wins (test seam), then
 *  XDG_CONFIG_HOME, then `$HOME/.config`. The leaf is always
 *  `fleet-control/.welcome-seen`. */
export function sentinelPathFor(env: Record<string, string | undefined>): string {
  const root = env.FLEET_HOME
    ?? env.XDG_CONFIG_HOME
    ?? (env.HOME ? join(env.HOME, ".config") : ".");
  // FLEET_HOME is treated as a config-home equivalent — the leaf path
  // is the same regardless of which knob the operator (or test) set.
  return join(root, "fleet-control", ".welcome-seen");
}

// ────────────────────────────────────────────────────────────────────
// Secret redaction (defence-in-depth backstop)
// ────────────────────────────────────────────────────────────────────

/** Same shape as src/doctor.ts § redactSecrets: strip token-shaped runs
 *  and GitHub repo URLs. We DO NOT call into doctor.ts here because the
 *  welcome should remain a leaf module — but we keep the regex set in
 *  sync. */
function redactSecrets(s: string): string {
  let out = s.replace(/\bgh[opusr]_[A-Za-z0-9_]{20,}\b/g, "<redacted-pat>");
  out = out.replace(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?/g, "<redacted-repo-url>");
  out = out.replace(/\b[A-Za-z0-9_]{24,}\b/g, (match) => {
    const hasLetter = /[A-Za-z]/.test(match);
    const hasDigit = /\d/.test(match) || /_/.test(match);
    return hasLetter && hasDigit ? "<redacted>" : match;
  });
  return out;
}

// ────────────────────────────────────────────────────────────────────
// Pure renderer
// ────────────────────────────────────────────────────────────────────

const C = {
  dim: "\x1b[2m", bold: "\x1b[1m", grn: "\x1b[32m", cyan: "\x1b[36m", rst: "\x1b[0m",
};

function paint(color: boolean, code: string, s: string): string {
  return color ? `${code}${s}${C.rst}` : s;
}

/** Map a bind-host to the URL operators can click. `0.0.0.0` → localhost
 *  so the browser actually resolves it. */
function displayHost(host: string): string {
  return host === "0.0.0.0" ? "localhost" : host;
}

function projectsLine(projects: string[]): string {
  if (projects.length === 0) {
    return "Add your first project:  fleetctl register <github-url>";
  }
  const shown = projects.slice(0, 3).join(", ");
  const suffix = projects.length > 3 ? " …" : "";
  return `Your projects:           ${shown}${suffix}`;
}

/** Render the multi-line welcome string. Pure: same input always
 *  yields the same output. ANSI escapes are emitted only when
 *  `opts.color === true`. The final string passes through
 *  `redactSecrets` so any future regression that embeds a token-shaped
 *  value is caught at the boundary. */
export function renderWelcome(opts: WelcomeOpts): string {
  const url = `http://${displayHost(opts.host)}:${opts.port}`;
  const lines: string[] = [];
  lines.push(paint(opts.color, C.bold, "fleet-control — first run detected."));
  lines.push("");
  lines.push(paint(opts.color, C.dim, "Next 5 minutes:"));
  lines.push(`  1. Open the portal:      ${paint(opts.color, C.cyan, url)}`);
  lines.push(`  2. Loopback bypasses auth — no token needed locally.`);
  lines.push(`     For LAN: x-fleet-token: <token-from-fleet-control.config.json>`);
  lines.push(`  3. ${projectsLine(opts.projects)}`);
  lines.push(`  4. Verify with:          ${paint(opts.color, C.cyan, "fleetctl doctor")}`);
  lines.push(`  5. Watch the live tail:  ${paint(opts.color, C.cyan, "fleetctl tail --follow")}`);
  // Ticket 0032 — phone-pairing section. Inserted BETWEEN step 5 and the
  // hide-hint footer so the operator's eye lands on the scan target
  // immediately after the "Open the portal" instruction. When the opt
  // is absent (loopback bind, `--no-pair`, LAN unreachable) we emit
  // nothing here — the welcome is byte-identical to the pre-0032
  // output (the welcome AC-suite in tests/welcome.test.ts continues to
  // pass without modification).
  if (opts.pairSection) {
    lines.push("");
    lines.push(paint(opts.color, C.dim, "Scan from your phone to pair (90s):"));
    lines.push(`  ${paint(opts.color, C.cyan, opts.pairSection.url)}`);
    // The QR encoder may throw if the qrText is too long or contains
    // characters outside the alphanumeric alphabet; the welcome MUST
    // NOT crash in that case (it's a banner, not a control path), so
    // we swallow the error and fall back to "QR unavailable" on the
    // next line. The CLI is expected to pre-validate qrText with the
    // same encoder before passing it through; this is belt-and-braces.
    let qrBlock = "";
    try {
      qrBlock = renderQrAscii(opts.pairSection.qrText, { cellWidth: 2 });
    } catch (e) {
      const msg = e && typeof e === "object" && "message" in e
        ? String((e as { message: unknown }).message) : String(e);
      qrBlock = `  (QR unavailable: ${msg})`;
    }
    for (const qrLine of qrBlock.split("\n")) lines.push(qrLine);
  }
  lines.push("");
  lines.push(paint(opts.color, C.dim, `Hide this with: touch ${opts.sentinelPath}`));
  lines.push("");
  return redactSecrets(lines.join("\n"));
}

/** One-line "subsequent run" banner. Subsequent serves print this and
 *  nothing else — matches the existing `fleet-control portal → ...`
 *  shape so the cold-start welcome is the only behavioural change. */
function renderQuietBanner(opts: WelcomeOpts): string {
  return `fleet-control serving on ${displayHost(opts.host)}:${opts.port}`;
}

// ────────────────────────────────────────────────────────────────────
// firstRun — orchestrate sentinel detect → render → optional write
// ────────────────────────────────────────────────────────────────────

/** Decide whether to print, print, and (on a real first run) write the
 *  sentinel. Never throws on a sentinel-write failure — emits one warn
 *  line so the operator can see what happened, then continues. */
export function firstRun(opts: WelcomeOpts, deps: WelcomeDeps, run: FirstRunOpts = {}): void {
  // `--no-welcome` short-circuits everything (including the one-line
  // message) — the operator asked for quiet, deliver quiet. We also do
  // NOT write the sentinel: the operator may want the welcome on a
  // later run, and the suppress flag is read-only by contract.
  if (run.suppress) return;

  const alreadySeen = deps.fileExists(opts.sentinelPath);
  if (alreadySeen && !run.force) {
    deps.log(renderQuietBanner(opts));
    return;
  }

  // Print the full welcome. Use one log() call per line so a future
  // log routing layer (e.g. ndjson) sees each line cleanly.
  const body = renderWelcome(opts);
  for (const line of body.split("\n")) deps.log(line);

  // Write the sentinel (best-effort). Only on a real first run —
  // forcing the welcome via --welcome does NOT clobber the sentinel
  // because it might already be there for a reason, and we don't want
  // a second --welcome to re-print on subsequent serves.
  if (!alreadySeen) {
    try {
      // Ensure the parent dir exists. mkdir is recursive in the wrapper.
      const parent = opts.sentinelPath.slice(0, opts.sentinelPath.lastIndexOf("/"));
      if (parent) deps.mkdir(parent);
      deps.writeFile(opts.sentinelPath, `${new Date().toISOString()}\n`);
    } catch (e: unknown) {
      const msg = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
      deps.warn(`warn: could not write welcome sentinel at ${opts.sentinelPath}: ${msg}`);
    }
  }
}
