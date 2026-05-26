// Inline PR diff renderer (ticket 0007). Pure string → HTML transform — no
// DOM dependency, so it's importable from web/app.js (browser) AND from
// tests/pr-diff.test.ts (node). Vanilla ES module.
//
// Output rules:
//   • one <div class="diff-{kind}"> per non-empty input line
//   • kinds: diff-add (`+...`), diff-del (`-...`), diff-hunk (`@@`),
//     diff-meta (`diff --git`, `index `, `--- `, `+++ `), diff-ctx (else)
//   • `&`, `<`, `>` escaped BEFORE any other processing (HTML safety —
//     diffs frequently contain code with `<script>` etc.)

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ESC[c]);
}

function classify(line) {
  // The order matters: `---`/`+++` are file headers and must be matched
  // BEFORE the bare `+`/`-` body-line check (which would otherwise win).
  if (line.startsWith("@@")) return "diff-hunk";
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "diff-meta";
  if (line.startsWith("--- ") || line.startsWith("+++ ")) return "diff-meta";
  if (line.startsWith("+")) return "diff-add";
  if (line.startsWith("-")) return "diff-del";
  return "diff-ctx";
}

/** Render a unified-diff string as HTML. Returns a string of <div>s the
 *  caller drops into an innerHTML (the input is HTML-escaped here so the
 *  caller doesn't need to). Empty input returns a soft notice line. */
export function renderDiffHtml(text) {
  if (!text || !String(text).trim()) {
    return '<div class="diff-empty">no changes in this diff</div>';
  }
  // Strip a single trailing newline so split() doesn't add a blank row.
  const body = String(text).replace(/\n$/, "");
  const lines = body.split("\n");
  const out = [];
  for (const line of lines) {
    const klass = classify(line);
    out.push('<div class="' + klass + '">' + esc(line) + "</div>");
  }
  return out.join("");
}

/** Server marker for "diff truncated, open in GitHub". The SPA checks for
 *  this substring in the raw body to decide whether to surface the link. */
export const TRUNCATION_MARKER_SNIPPET = "[truncated — open in GitHub]";
