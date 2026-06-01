// Hand-rolled QR encoder — version 1 (21x21), error correction level L,
// alphanumeric mode. Per ticket 0032 § engineering notes, this is the
// explicit test of the "zero runtime dependency" discipline: pulling in
// `qrcode` from npm would be the obvious shortcut, so we write the ~120
// lines instead.
//
// Scope: a single mode + version + EC level is all this ticket needs (the
// welcome banner's pair URL is short and known to fit). Anything beyond
// that — version >1, byte mode, kanji, etc — is intentionally out of
// scope; a future ticket can grow the encoder if a new caller needs it.
//
// References:
//   * ISO/IEC 18004:2024 § 8 (data encoding), § 7.5 (Reed-Solomon error
//     correction), § 8.7 (mask patterns and penalty score), § 8.9
//     (format information BCH encoding).
//   * Thonky tutorial worked examples for the alphanumeric mode bit
//     sequencing and the 32 pre-computed format-info bit strings.
//
// All inputs upstream of this module are operator-controlled (the pair
// URL the welcome banner shows), so there's no need for constant-time
// comparisons or input sanitisation beyond the upper-case alphanumeric
// alphabet check.

// ────────────────────────────────────────────────────────────────────
// Alphanumeric alphabet (ISO/IEC 18004 § 8.4.3)
// ────────────────────────────────────────────────────────────────────

const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

function alphaValue(ch: string): number {
  const v = ALPHANUMERIC.indexOf(ch);
  if (v < 0) {
    throw new Error(
      `qr: char '${ch}' (U+${ch.charCodeAt(0).toString(16).padStart(4, "0")}) is not in the alphanumeric set; allowed: ${JSON.stringify(ALPHANUMERIC)}`,
    );
  }
  return v;
}

// ────────────────────────────────────────────────────────────────────
// GF(256) arithmetic (QR primitive polynomial 0x11d)
// ────────────────────────────────────────────────────────────────────

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Reed-Solomon generator polynomial of degree `nsym`. Coefficients are
 *  highest-degree first, length nsym+1. */
function rsGenerator(nsym: number): Uint8Array {
  let g = new Uint8Array([1]);
  for (let i = 0; i < nsym; i++) {
    const next = new Uint8Array(g.length + 1);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], GF_EXP[i]);
    }
    g = next;
  }
  return g;
}

/** Compute `nsym` Reed-Solomon error correction bytes for `data`. */
function rsEncode(data: Uint8Array, nsym: number): Uint8Array {
  const gen = rsGenerator(nsym);
  const out = new Uint8Array(data.length + nsym);
  out.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef !== 0) {
      for (let j = 0; j < gen.length; j++) {
        out[i + j] ^= gfMul(gen[j], coef);
      }
    }
  }
  return out.slice(data.length);
}

// ────────────────────────────────────────────────────────────────────
// Bit stream helpers (variable-length push, byte-pack)
// ────────────────────────────────────────────────────────────────────

class BitStream {
  bits: number[] = [];
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
  length(): number { return this.bits.length; }
  toBytes(): Uint8Array {
    const len = Math.ceil(this.bits.length / 8);
    const out = new Uint8Array(len);
    for (let i = 0; i < this.bits.length; i++) {
      out[i >> 3] |= this.bits[i] << (7 - (i & 7));
    }
    return out;
  }
}

// ────────────────────────────────────────────────────────────────────
// Encode the alphanumeric payload to the 19 data codewords of V1-L.
// ────────────────────────────────────────────────────────────────────

const V1_L_DATA_CODEWORDS = 19;
const V1_L_EC_CODEWORDS = 7;
const V1_L_TOTAL_BITS = V1_L_DATA_CODEWORDS * 8; // 152
const V1_ALPHA_COUNT_BITS = 9; // V1-9: 9 bits for alphanumeric char-count

function encodeDataCodewords(text: string): Uint8Array {
  const bs = new BitStream();
  // Mode indicator: alphanumeric = 0010 (4 bits).
  bs.push(0b0010, 4);
  // Character count indicator.
  bs.push(text.length, V1_ALPHA_COUNT_BITS);
  // Encode pairs of alphanumeric chars as 11-bit groups (45*a + b),
  // trailing single char as 6-bit value.
  for (let i = 0; i < text.length; i += 2) {
    if (i + 1 < text.length) {
      const a = alphaValue(text[i]);
      const b = alphaValue(text[i + 1]);
      bs.push(45 * a + b, 11);
    } else {
      bs.push(alphaValue(text[i]), 6);
    }
  }
  // Terminator: up to 4 zero bits (truncated if past capacity).
  const remaining = V1_L_TOTAL_BITS - bs.length();
  bs.push(0, Math.max(0, Math.min(4, remaining)));
  // Pad with zero bits to the next byte boundary.
  while (bs.length() % 8 !== 0) bs.push(0, 1);
  // Pad bytes alternating 0xec, 0x11 until we hit 19 codewords.
  const pad = [0xec, 0x11];
  let p = 0;
  while (bs.length() < V1_L_TOTAL_BITS) {
    bs.push(pad[p], 8);
    p = 1 - p;
  }
  const bytes = bs.toBytes();
  if (bytes.length !== V1_L_DATA_CODEWORDS) {
    throw new Error(`qr: internal — expected ${V1_L_DATA_CODEWORDS} data codewords, got ${bytes.length}`);
  }
  return bytes;
}

// ────────────────────────────────────────────────────────────────────
// Module placement (21x21 matrix)
//
// We carry two parallel matrices:
//   * modules[r][c]  — 0 / 1, the dark module bit
//   * reserved[r][c] — 0 / 1, whether this module is reserved (finder,
//                       timing, format-info, dark module) and therefore
//                       NOT eligible for data placement or masking
// ────────────────────────────────────────────────────────────────────

const SIZE = 21; // V1

function makeGrid(): { modules: Uint8Array[]; reserved: Uint8Array[] } {
  const modules: Uint8Array[] = [];
  const reserved: Uint8Array[] = [];
  for (let r = 0; r < SIZE; r++) {
    modules.push(new Uint8Array(SIZE));
    reserved.push(new Uint8Array(SIZE));
  }
  return { modules, reserved };
}

function placeFinder(g: { modules: Uint8Array[]; reserved: Uint8Array[] }, r0: number, c0: number): void {
  // 7x7 finder + 1-module quiet-zone separator inside the symbol.
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const r = r0 + dr;
      const c = c0 + dc;
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) continue;
      let dark = 0;
      if (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) {
        // Finder pattern body.
        const onEdge = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inner3 = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        dark = (onEdge || inner3) ? 1 : 0;
      }
      g.modules[r][c] = dark;
      g.reserved[r][c] = 1;
    }
  }
}

function placeTiming(g: { modules: Uint8Array[]; reserved: Uint8Array[] }): void {
  for (let i = 8; i < SIZE - 8; i++) {
    const bit = (i % 2 === 0) ? 1 : 0;
    g.modules[6][i] = bit; g.reserved[6][i] = 1;
    g.modules[i][6] = bit; g.reserved[i][6] = 1;
  }
}

function reserveFormatAreas(g: { modules: Uint8Array[]; reserved: Uint8Array[] }): void {
  // Around top-left finder: row 8 cols 0-8 (skip col 6), col 8 rows 0-8 (skip row 6).
  for (let c = 0; c <= 8; c++) if (c !== 6) g.reserved[8][c] = 1;
  for (let r = 0; r <= 8; r++) if (r !== 6) g.reserved[r][8] = 1;
  // Top-right finder strip: row 8 cols size-8..size-1.
  for (let c = SIZE - 8; c < SIZE; c++) g.reserved[8][c] = 1;
  // Bottom-left finder strip: col 8 rows size-7..size-1.
  for (let r = SIZE - 7; r < SIZE; r++) g.reserved[r][8] = 1;
  // The "dark module" at (4 * version + 9, 8) = (13, 8) for V1.
  g.modules[SIZE - 8][8] = 1;
  g.reserved[SIZE - 8][8] = 1;
}

/** Walk module positions in QR's snake/zigzag order, skipping reserved
 *  modules and the vertical timing column (col 6). Yields rows of
 *  (row, col) pairs as a flat sequence. */
function dataModulePositions(reserved: Uint8Array[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let up = true;
  for (let right = SIZE - 1; right > 0; right -= 2) {
    if (right === 6) right -= 1; // skip vertical timing column
    for (let v = 0; v < SIZE; v++) {
      const row = up ? SIZE - 1 - v : v;
      for (let k = 0; k < 2; k++) {
        const col = right - k;
        if (!reserved[row][col]) out.push([row, col]);
      }
    }
    up = !up;
  }
  return out;
}

function placeDataBits(
  g: { modules: Uint8Array[]; reserved: Uint8Array[] },
  fullCodewords: Uint8Array,
): void {
  const positions = dataModulePositions(g.reserved);
  for (let i = 0; i < positions.length; i++) {
    const byteIdx = i >> 3;
    const bitIdx = 7 - (i & 7);
    const bit = byteIdx < fullCodewords.length
      ? (fullCodewords[byteIdx] >> bitIdx) & 1
      : 0;
    const [r, c] = positions[i];
    g.modules[r][c] = bit;
  }
}

// ────────────────────────────────────────────────────────────────────
// Mask patterns (ISO/IEC 18004 § 8.8.1)
// ────────────────────────────────────────────────────────────────────

type MaskFn = (r: number, c: number) => boolean;
const MASKS: MaskFn[] = [
  (r, c) => (r + c) % 2 === 0,
  (r, _c) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(modules: Uint8Array[], reserved: Uint8Array[], mask: MaskFn): void {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!reserved[r][c] && mask(r, c)) modules[r][c] ^= 1;
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// Format info — pre-computed BCH(15,5) strings for ECC level L, masks 0..7
// (ISO/IEC 18004 § 8.9, table reproduced from Thonky tutorial reference).
// ────────────────────────────────────────────────────────────────────

const FORMAT_INFO_L: string[] = [
  "111011111000100",
  "111001011110011",
  "111110110101010",
  "111100010011101",
  "110011000101111",
  "110001100011000",
  "110110001000001",
  "110100101110110",
];

function placeFormatInfo(g: { modules: Uint8Array[]; reserved: Uint8Array[] }, mask: number): void {
  const bits = FORMAT_INFO_L[mask].split("").map((b) => Number(b));
  // Around top-left finder: bits[0..6] go down col 8 (rows 0..5, then 7),
  // bits[7..14] go right along row 8 (col 8 down to col 0, skipping col 6).
  // Position list per the standard's figure 19.
  const around: Array<[number, number]> = [
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
    [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  ];
  for (let i = 0; i < 15; i++) {
    const [r, c] = around[i];
    g.modules[r][c] = bits[i];
  }
  // Mirror copy: bits[0..7] go right along row 8 cols size-1..size-8;
  // bits[8..14] go up col 8 rows size-7..size-1.
  const mirror: Array<[number, number]> = [
    [8, SIZE - 1], [8, SIZE - 2], [8, SIZE - 3], [8, SIZE - 4],
    [8, SIZE - 5], [8, SIZE - 6], [8, SIZE - 7],
    [SIZE - 7, 8], [SIZE - 6, 8], [SIZE - 5, 8], [SIZE - 4, 8],
    [SIZE - 3, 8], [SIZE - 2, 8], [SIZE - 1, 8],
  ];
  for (let i = 0; i < 14; i++) {
    const [r, c] = mirror[i];
    g.modules[r][c] = bits[i];
  }
}

// ────────────────────────────────────────────────────────────────────
// Mask-penalty scoring (ISO/IEC 18004 § 8.8.2)
// ────────────────────────────────────────────────────────────────────

function maskPenalty(m: Uint8Array[]): number {
  let p = 0;
  // Rule 1: runs of 5+ same-coloured modules in rows/cols.
  for (let r = 0; r < SIZE; r++) {
    let runColor = -1; let runLen = 0;
    for (let c = 0; c < SIZE; c++) {
      if (m[r][c] === runColor) { runLen++; }
      else { if (runLen >= 5) p += 3 + (runLen - 5); runColor = m[r][c]; runLen = 1; }
    }
    if (runLen >= 5) p += 3 + (runLen - 5);
  }
  for (let c = 0; c < SIZE; c++) {
    let runColor = -1; let runLen = 0;
    for (let r = 0; r < SIZE; r++) {
      if (m[r][c] === runColor) { runLen++; }
      else { if (runLen >= 5) p += 3 + (runLen - 5); runColor = m[r][c]; runLen = 1; }
    }
    if (runLen >= 5) p += 3 + (runLen - 5);
  }
  // Rule 2: 2x2 blocks of same colour.
  for (let r = 0; r < SIZE - 1; r++) {
    for (let c = 0; c < SIZE - 1; c++) {
      const v = m[r][c];
      if (m[r][c + 1] === v && m[r + 1][c] === v && m[r + 1][c + 1] === v) p += 3;
    }
  }
  // Rule 3: 1:1:3:1:1 finder-like patterns (1011101 with 4-module
  // light region either side). Look horizontally and vertically.
  const finderRow = [1, 0, 1, 1, 1, 0, 1];
  const matchAt = (vals: number[]): boolean => {
    if (vals.length !== 11) return false;
    // Either 4-light prefix or 4-light suffix around the 7-module finder.
    const prefixLight = vals.slice(0, 4).every((v) => v === 0)
      && vals.slice(4, 11).every((v, i) => v === finderRow[i]);
    const suffixLight = vals.slice(7, 11).every((v) => v === 0)
      && vals.slice(0, 7).every((v, i) => v === finderRow[i]);
    return prefixLight || suffixLight;
  };
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c <= SIZE - 11; c++) {
      const row: number[] = [];
      for (let k = 0; k < 11; k++) row.push(m[r][c + k]);
      if (matchAt(row)) p += 40;
    }
  }
  for (let c = 0; c < SIZE; c++) {
    for (let r = 0; r <= SIZE - 11; r++) {
      const col: number[] = [];
      for (let k = 0; k < 11; k++) col.push(m[r + k][c]);
      if (matchAt(col)) p += 40;
    }
  }
  // Rule 4: dark-module ratio penalty.
  let dark = 0;
  for (let r = 0; r < SIZE; r++) for (let c = 0; c < SIZE; c++) if (m[r][c]) dark++;
  const total = SIZE * SIZE;
  const pct = (dark * 100) / total;
  const steps = Math.floor(Math.abs(pct - 50) / 5);
  p += steps * 10;
  return p;
}

// ────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────

export interface QrRenderOpts {
  /** Width of each cell in characters. Default 2 — the welcome banner
   *  uses two-character cells so the QR scans cleanly under typical
   *  phone glare at kitchen-table distance. */
  cellWidth?: 1 | 2;
}

const V1_ALPHA_MAX = 25; // V1-L alphanumeric capacity (ISO/IEC 18004 table 2)

/** Build the 21x21 QR matrix for `text` in V1-L alphanumeric mode.
 *  Throws on invalid characters or text longer than 25 chars. Exported
 *  mainly for tests; the production caller uses `renderQrAscii`. */
export function buildQrMatrix(text: string): Uint8Array[] {
  if (typeof text !== "string") throw new Error("qr: text must be a string");
  if (text.length > V1_ALPHA_MAX) {
    throw new Error(`qr: text length ${text.length} exceeds V1-L alphanumeric capacity ${V1_ALPHA_MAX}`);
  }
  // Validate every char up-front so we throw deterministically before
  // any matrix work.
  for (const ch of text) alphaValue(ch);

  const dataCodewords = encodeDataCodewords(text);
  const ecCodewords = rsEncode(dataCodewords, V1_L_EC_CODEWORDS);
  const full = new Uint8Array(dataCodewords.length + ecCodewords.length);
  full.set(dataCodewords, 0);
  full.set(ecCodewords, dataCodewords.length);

  // Try every mask, pick the lowest-penalty result. This is the standard
  // V1 selection procedure; with only 8 masks it's cheap (sub-ms on a
  // laptop) and gives a deterministic output for a given input.
  let bestModules: Uint8Array[] | null = null;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = makeGrid();
    placeFinder(g, 0, 0);
    placeFinder(g, 0, SIZE - 7);
    placeFinder(g, SIZE - 7, 0);
    placeTiming(g);
    reserveFormatAreas(g);
    placeDataBits(g, full);
    applyMask(g.modules, g.reserved, MASKS[mask]);
    placeFormatInfo(g, mask);
    const pen = maskPenalty(g.modules);
    if (pen < bestPenalty) {
      bestPenalty = pen;
      bestModules = g.modules.map((row) => new Uint8Array(row));
    }
  }
  if (!bestModules) throw new Error("qr: internal — no mask selected");
  return bestModules;
}

/** Render the matrix as a multi-line ASCII string. Dark modules use the
 *  full block U+2588; light modules use spaces. A 1-module-wide quiet
 *  zone (4 cells is the QR spec, but indoor phone cameras lock on with
 *  just 1 and we want to keep the welcome compact) is added on every
 *  side. */
export function renderQrAscii(text: string, opts: QrRenderOpts = {}): string {
  const cellWidth = opts.cellWidth ?? 2;
  if (cellWidth !== 1 && cellWidth !== 2) {
    throw new Error(`qr: cellWidth must be 1 or 2, got ${cellWidth}`);
  }
  const m = buildQrMatrix(text);
  const dark = "█".repeat(cellWidth);
  const light = " ".repeat(cellWidth);
  const QUIET = 1;
  const lines: string[] = [];
  const emptyLine = light.repeat(SIZE + 2 * QUIET);
  for (let q = 0; q < QUIET; q++) lines.push(emptyLine);
  for (let r = 0; r < SIZE; r++) {
    let row = light.repeat(QUIET);
    for (let c = 0; c < SIZE; c++) row += m[r][c] ? dark : light;
    row += light.repeat(QUIET);
    lines.push(row);
  }
  for (let q = 0; q < QUIET; q++) lines.push(emptyLine);
  return lines.join("\n");
}

/** Convenience: render the matrix as a plain 21x21 string of '#'/'.'
 *  characters with no quiet zone. Used by the test fixture so the
 *  on-disk reference is human-readable diff-friendly. */
export function matrixToPlainString(m: Uint8Array[]): string {
  return m.map((row) => Array.from(row).map((b) => (b ? "#" : ".")).join("")).join("\n");
}
