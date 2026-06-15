// Tests for ticket 0032 AC1 — the hand-rolled QR encoder.
//
// Strategy: a single canonical fixture (HELLO WORLD, V1-L alphanumeric)
// committed at tests/fixtures/qr-vector.txt locks the encoder bit-for-
// bit. Any future tweak to mask scoring, codeword layout, or format-info
// placement is gated on regenerating that fixture deliberately. The
// HELLO WORLD vector is the classic QR-tutorial example so the fixture
// is grep-able against any external reference. Additional tests cover
// structural invariants (finder corners, timing column, dark module at
// (13,8) for V1), capacity throws (>25 chars at EC-L alphanumeric), and
// the alphanumeric character-set throw on '?' or '=' (the realistic
// constraint that drove the path-style URL design in src/pair.ts).
//
// Zero new runtime deps; stdlib + node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildQrMatrix, matrixToPlainString, renderQrAscii,
} from "../src/qr.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "fixtures", "qr-vector.txt");

// ────────────────────────────────────────────────────────────────────
// AC1 — encoder produces a 21x21 matrix that matches the committed
// canonical fixture bit-for-bit. A diff here means either the encoder
// regressed or the fixture was intentionally regenerated.
// ────────────────────────────────────────────────────────────────────

test("AC1: HELLO WORLD V1-L matches the canonical fixture bit-for-bit", () => {
  const m = buildQrMatrix("HELLO WORLD");
  const got = matrixToPlainString(m);
  const want = readFileSync(FIXTURE, "utf8").trimEnd();
  assert.equal(got, want,
    "qr-vector.txt drifted from the encoder; regenerate ONLY if the change is intentional");
});

test("AC1: matrix is exactly 21x21", () => {
  const m = buildQrMatrix("HELLO WORLD");
  assert.equal(m.length, 21, "V1 QR must have 21 rows");
  for (const row of m) assert.equal(row.length, 21, "V1 QR rows must each be 21 wide");
});

test("AC1: finder patterns are present at the three corners", () => {
  const m = buildQrMatrix("HELLO WORLD");
  // Top-left finder: 7x7 with outer ring dark + inner 3x3 dark.
  // Check the four outer corners + the centre-of-centre.
  assert.equal(m[0][0], 1, "top-left finder NW corner");
  assert.equal(m[0][6], 1, "top-left finder NE corner");
  assert.equal(m[6][0], 1, "top-left finder SW corner");
  assert.equal(m[6][6], 1, "top-left finder SE corner");
  assert.equal(m[3][3], 1, "top-left finder centre");
  // Top-right finder (rows 0-6, cols 14-20).
  assert.equal(m[0][14], 1);
  assert.equal(m[0][20], 1);
  assert.equal(m[6][14], 1);
  assert.equal(m[6][20], 1);
  assert.equal(m[3][17], 1, "top-right finder centre");
  // Bottom-left finder (rows 14-20, cols 0-6).
  assert.equal(m[14][0], 1);
  assert.equal(m[14][6], 1);
  assert.equal(m[20][0], 1);
  assert.equal(m[20][6], 1);
  assert.equal(m[17][3], 1, "bottom-left finder centre");
});

test("AC1: timing patterns alternate along row 6 / col 6 between finders", () => {
  const m = buildQrMatrix("HELLO WORLD");
  // Per ISO/IEC 18004 §6.3.4, the timing pattern at cols 8..12 of row 6
  // (and rows 8..12 of col 6) alternates dark/light starting with dark.
  for (let i = 8; i <= 12; i++) {
    const expected = (i % 2 === 0) ? 1 : 0;
    assert.equal(m[6][i], expected, `row 6 timing at col ${i}`);
    assert.equal(m[i][6], expected, `col 6 timing at row ${i}`);
  }
});

test("AC1: the V1 dark module sits at (13, 8)", () => {
  const m = buildQrMatrix("HELLO WORLD");
  // Per ISO/IEC 18004 §6.4.7, the "always dark" module for version v
  // sits at (4v + 9, 8); for v=1 that's (13, 8).
  assert.equal(m[13][8], 1, "dark module must be ON at (13, 8)");
});

// ────────────────────────────────────────────────────────────────────
// AC1 — capacity & alphabet throws
// ────────────────────────────────────────────────────────────────────

test("AC1: throws when text exceeds V1-L alphanumeric capacity (>25 chars)", () => {
  const twentySix = "A".repeat(26);
  assert.throws(() => buildQrMatrix(twentySix), /exceeds V1-L alphanumeric capacity/);
});

test("AC1: 25 chars is the boundary — encodes without throwing", () => {
  // 25 'A's is on the limit; should round-trip through the encoder.
  const at25 = "A".repeat(25);
  const m = buildQrMatrix(at25);
  assert.equal(m.length, 21);
});

test("AC1: rejects characters outside the alphanumeric set (no '?' or '=')", () => {
  // Realistic pair-URL shape with query params would fail here — the
  // engineering note in src/pair.ts is that production URLs MUST use
  // path-style routing (`/pair/<token>`) to stay inside this set.
  assert.throws(() => buildQrMatrix("HTTP://X.IO/?T=K7Z2"), /not in the alphanumeric set/);
  assert.throws(() => buildQrMatrix("HTTP://X.IO/=AB"), /not in the alphanumeric set/);
});

test("AC1: lowercase letters are rejected (alphanumeric mode is upper-only)", () => {
  assert.throws(() => buildQrMatrix("hello"), /not in the alphanumeric set/);
});

// ────────────────────────────────────────────────────────────────────
// AC1 — renderQrAscii public API: cell width + visible shape
// ────────────────────────────────────────────────────────────────────

test("AC1: renderQrAscii with cellWidth=2 returns a multi-line block scaled to two-char cells", () => {
  const out = renderQrAscii("HELLO WORLD", { cellWidth: 2 });
  const lines = out.split("\n");
  // SIZE 21 + 2 quiet-zone modules = 23 rows; each character cell is 2
  // wide so each visible row is 46 chars.
  assert.equal(lines.length, 23, "expected 21 + 2 quiet rows");
  for (const line of lines) {
    assert.equal(line.length, 46, `each row must be 46 visible cells (got ${line.length}): ${JSON.stringify(line)}`);
  }
});

test("AC1: renderQrAscii with cellWidth=1 returns a single-char-per-cell block", () => {
  const out = renderQrAscii("HELLO WORLD", { cellWidth: 1 });
  const lines = out.split("\n");
  assert.equal(lines.length, 23);
  for (const line of lines) assert.equal(line.length, 23);
});

test("AC1: renderQrAscii defaults cellWidth to 2 when omitted", () => {
  const explicit = renderQrAscii("HELLO WORLD", { cellWidth: 2 });
  const implicit = renderQrAscii("HELLO WORLD");
  assert.equal(implicit, explicit, "default cellWidth must be 2");
});

test("AC1: renderQrAscii rejects unsupported cell widths", () => {
  assert.throws(() => renderQrAscii("HELLO WORLD", { cellWidth: 3 as 1 | 2 }), /cellWidth must be 1 or 2/);
});

// ────────────────────────────────────────────────────────────────────
// AC1 — pure function: no I/O, no shared state
// ────────────────────────────────────────────────────────────────────

test("AC1: encoder is deterministic — identical input yields identical matrix", () => {
  const a = matrixToPlainString(buildQrMatrix("HELLO WORLD"));
  const b = matrixToPlainString(buildQrMatrix("HELLO WORLD"));
  assert.equal(a, b);
});

test("AC1: encoder produces DIFFERENT matrices for different inputs", () => {
  const a = matrixToPlainString(buildQrMatrix("HELLO WORLD"));
  const b = matrixToPlainString(buildQrMatrix("PAIR ME"));
  assert.notEqual(a, b);
});
