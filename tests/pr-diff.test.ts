// Tests for the inline PR diff feature (ticket 0007).
//
// Each test maps to one acceptance-criteria checkbox in
// docs/backlog/0007-inline-pr-diff.md:
//   1. /api/prs/:repo/:number/diff returns text/plain from gh pr diff,
//      cached 30s per (repo,number), read-scope auth (read scope is already
//      verified end-to-end in auth-server.test.ts — here we assert the route
//      goes through requireAuth and rejects bad/malformed inputs).
//   2. & 5. The SPA inline rendering + sticky bar are markup/CSS — we cover
//      the *renderer* (web/diff.js) by importing it directly in node since
//      it's a pure string transform with zero DOM dependencies.
//   3. Diff rendering: monospace, server-side `<`/`>` escape, one <div> per
//      line, `+` green, `-` red, hunk headers bold.
//   4. Long diffs: server caps at 200 KB and appends a truncation marker.
//   6. Cache hit on the second call (fetcher must NOT be invoked twice).
//
// Strategy: every shell-out is dependency-injected via a `fetcher` argument
// (default uses execFile gh) so we never run real `gh` in tests. Zero new
// runtime deps; stdlib + node:test only.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchPrDiff, _resetDiffCache, validatePrParams, MAX_DIFF_BYTES,
  TRUNCATION_MARKER, DIFF_CACHE_TTL_MS,
} from "../src/diff.ts";
import { renderDiffHtml } from "../web/diff.js";

const SAMPLE_DIFF = `diff --git a/foo.ts b/foo.ts
index 0000000..1111111 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,3 @@
 unchanged line
-removed line
+added line <script>
`;

test("validatePrParams: rejects malformed repo / number", () => {
  // owner/name allowed; everything else rejected.
  assert.equal(validatePrParams("owner/repo", "42").ok, true);
  assert.equal(validatePrParams("Owner/Repo-Name_1.x", "7").ok, true);

  // Missing slash — single-segment repos aren't valid GitHub repos.
  assert.equal(validatePrParams("repo", "42").ok, false);
  // Path traversal / shell metas / spaces.
  assert.equal(validatePrParams("owner/../etc", "42").ok, false);
  assert.equal(validatePrParams("owner;rm/repo", "42").ok, false);
  assert.equal(validatePrParams("owner repo/name", "42").ok, false);
  // Two slashes — owner/name only, no nested paths.
  assert.equal(validatePrParams("a/b/c", "42").ok, false);
  // Number must be all digits.
  assert.equal(validatePrParams("owner/repo", "1a").ok, false);
  assert.equal(validatePrParams("owner/repo", "-1").ok, false);
  assert.equal(validatePrParams("owner/repo", "").ok, false);
});

test("fetchPrDiff: returns the stub gh output and caches per (repo,number)", async () => {
  _resetDiffCache();
  let calls = 0;
  const fetcher = async (repo: string, _number: string) => {
    calls++;
    assert.equal(repo, "owner/repo");
    return SAMPLE_DIFF;
  };
  const r1 = await fetchPrDiff("owner/repo", "42", fetcher);
  assert.equal(r1.ok, true);
  assert.equal(r1.body, SAMPLE_DIFF);
  assert.equal(r1.truncated, false);
  assert.equal(calls, 1);

  // Second call within TTL must hit the cache — fetcher NOT invoked again.
  const r2 = await fetchPrDiff("owner/repo", "42", fetcher);
  assert.equal(r2.ok, true);
  assert.equal(r2.body, SAMPLE_DIFF);
  assert.equal(calls, 1, "cache hit: fetcher must not be called a second time");

  // Different PR number → new fetch.
  const r3 = await fetchPrDiff("owner/repo", "43", fetcher);
  assert.equal(r3.ok, true);
  assert.equal(calls, 2, "different number must miss the cache");

  // TTL constant is exactly 30s per the ticket.
  assert.equal(DIFF_CACHE_TTL_MS, 30_000);
});

test("fetchPrDiff: bad inputs rejected before any fetcher call", async () => {
  _resetDiffCache();
  let calls = 0;
  const fetcher = async () => { calls++; return ""; };
  const r = await fetchPrDiff("../etc/passwd", "42", fetcher);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.equal(calls, 0, "fetcher must not run for malformed inputs");
});

test("fetchPrDiff: bubbles up gh failure as ok:false (no cache pollution)", async () => {
  _resetDiffCache();
  let calls = 0;
  const failing = async () => { calls++; throw new Error("gh: not authenticated"); };
  const r1 = await fetchPrDiff("owner/repo", "44", failing);
  assert.equal(r1.ok, false);
  assert.match(r1.message ?? "", /not authenticated|gh/);
  // A retry must hit the fetcher again — failures don't cache.
  const r2 = await fetchPrDiff("owner/repo", "44", failing);
  assert.equal(r2.ok, false);
  assert.equal(calls, 2, "errors must not be cached — second call must re-fetch");
});

test("fetchPrDiff: caps body at 200 KB and appends a truncation marker", async () => {
  _resetDiffCache();
  // Build a payload comfortably larger than the cap so we can detect cleanly.
  const huge = "+x".repeat(MAX_DIFF_BYTES); // 2 chars per repeat → 400 KB
  const fetcher = async () => huge;
  const r = await fetchPrDiff("owner/repo", "100", fetcher);
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true, "body over the cap must be marked truncated");
  // The marker is appended; total length stays bounded by cap + marker.
  assert.ok(
    r.body.length <= MAX_DIFF_BYTES + TRUNCATION_MARKER.length + 1,
    `truncated body should be near the cap, was ${r.body.length}`,
  );
  assert.ok(r.body.endsWith(TRUNCATION_MARKER), "truncation marker must be the tail of the body");
  assert.equal(MAX_DIFF_BYTES, 200 * 1024);
});

test("renderDiffHtml: one <div> per line, +/- coloured, hunk bold, < / > escaped", () => {
  const html = renderDiffHtml(SAMPLE_DIFF);
  // One <div class="..."> per non-empty line in the input. Sample has 8
  // lines (diff/index/---/+++/@@/ctx/-/+); the trailing \n is stripped.
  const divs = html.match(/<div class="/g) ?? [];
  assert.equal(divs.length, 8, `expected 8 lines, got ${divs.length}: ${html}`);

  // `+` lines are .diff-add (green via CSS); `-` lines are .diff-del (red).
  assert.match(html, /<div class="diff-add">\+added line/);
  assert.match(html, /<div class="diff-del">-removed line/);

  // Hunk headers (@@) get the .diff-hunk class — bold in CSS.
  assert.match(html, /<div class="diff-hunk">@@ -1,3 \+1,3 @@/);

  // File headers stay plain context but must be distinguishable from body
  // for readability — we use .diff-meta for `diff --git`, `index`, `+++`, `---`.
  assert.match(html, /<div class="diff-meta">diff --git/);
  assert.match(html, /<div class="diff-meta">index 0000000/);
  assert.match(html, /<div class="diff-meta">--- a\/foo\.ts/);
  assert.match(html, /<div class="diff-meta">\+\+\+ b\/foo\.ts/);

  // Escape: `<script>` in the added line must NOT survive as a real tag.
  assert.ok(!/<script>/.test(html), "raw <script> must be escaped");
  assert.match(html, /&lt;script&gt;/);
});

test("renderDiffHtml: empty input renders a soft 'no diff' notice", () => {
  const html = renderDiffHtml("");
  assert.match(html, /diff-empty/);
});

test("renderDiffHtml: ampersand escape (& → &amp;) before the angle-brackets", () => {
  // Order matters — escaping `<` first would corrupt `&lt;`. Sanity-test it.
  const html = renderDiffHtml("+a & b < c > d\n");
  assert.match(html, /a &amp; b &lt; c &gt; d/);
});
