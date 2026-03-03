/**
 * Minimal QR code generator for terminal output.
 * Zero dependencies — pure JS implementation of QR Code Model 2.
 * Supports up to ~200 chars (sufficient for URLs).
 */

// ── GF(256) arithmetic for Reed-Solomon ──
const EXP = new Uint8Array(256);
const LOG = new Uint8Array(256);
let x = 1;
for (let i = 0; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x = (x << 1) ^ (x & 128 ? 0x11d : 0);
}
EXP[255] = EXP[0];

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[(LOG[a] + LOG[b]) % 255];
}

function rsGenPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsGenPoly(ecLen);
  const msg = new Uint8Array(data.length + ecLen);
  msg.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = msg[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      msg[i + j] ^= gfMul(gen[j], coef);
    }
  }
  return msg.slice(data.length);
}

// ── QR Code constants ──
// Version info: [version, totalCodewords, dataCodewords, ecCodewordsPerBlock, numBlocks]
// Error Correction Level L
const VERSION_TABLE = [
  null,
  [1, 26, 19, 7, 1],
  [2, 44, 34, 10, 1],
  [3, 70, 55, 15, 1],
  [4, 100, 80, 20, 1],
  [5, 134, 108, 26, 1],
  [6, 172, 136, 18, 2],
  [7, 196, 156, 20, 2],
  [8, 242, 192, 24, 2],
  [9, 292, 232, 30, 2],
  [10, 346, 274, 18, 4],
];

function getVersion(dataLen) {
  // Byte mode: 4 bits mode + 8/16 bits count + data*8 bits
  for (let v = 1; v <= 10; v++) {
    const info = VERSION_TABLE[v];
    const dataCap = info[2]; // dataCodewords
    const countBits = v <= 9 ? 8 : 16;
    const availBits = dataCap * 8;
    const needed = 4 + countBits + dataLen * 8;
    if (needed <= availBits) return v;
  }
  throw new Error('Data too long for QR (max ~200 chars)');
}

function encodeData(text, version) {
  const info = VERSION_TABLE[version];
  const ecPerBlock = info[3];
  const numBlocks = info[4];
  const totalCodewords = info[1];
  const dataCodewords = info[2];

  // Encode to byte mode
  const countBits = version <= 9 ? 8 : 16;
  const bits = [];
  function push(val, len) { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); }

  push(0b0100, 4); // Byte mode
  push(text.length, countBits);
  for (let i = 0; i < text.length; i++) push(text.charCodeAt(i), 8);

  // Terminator
  const maxBits = dataCodewords * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  push(0, termLen);

  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  // Pad bytes
  const padBytes = [0xEC, 0x11];
  let padIdx = 0;
  while (bits.length < maxBits) {
    push(padBytes[padIdx % 2], 8);
    padIdx++;
  }

  // Convert to bytes
  const dataBytes = new Uint8Array(dataCodewords);
  for (let i = 0; i < dataCodewords; i++) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | (bits[i * 8 + b] || 0);
    dataBytes[i] = byte;
  }

  // Split into blocks and generate EC
  const blockSize = Math.floor(dataCodewords / numBlocks);
  const longBlocks = dataCodewords % numBlocks;
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i++) {
    const size = blockSize + (i >= numBlocks - longBlocks ? 1 : 0);
    const block = dataBytes.slice(offset, offset + size);
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
    offset += size;
  }

  // Interleave
  const result = [];
  const maxDataBlock = blockSize + (longBlocks > 0 ? 1 : 0);
  for (let i = 0; i < maxDataBlock; i++) {
    for (let j = 0; j < numBlocks; j++) {
      if (i < dataBlocks[j].length) result.push(dataBlocks[j][i]);
    }
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (let j = 0; j < numBlocks; j++) {
      result.push(ecBlocks[j][i]);
    }
  }
  return result;
}

// ── Matrix operations ──
function createMatrix(version) {
  const size = version * 4 + 17;
  const matrix = Array.from({ length: size }, () => new Int8Array(size)); // 0=unset, 1=black, -1=white
  const reserved = Array.from({ length: size }, () => new Uint8Array(size));

  function setModule(r, c, val) {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      matrix[r][c] = val ? 1 : -1;
      reserved[r][c] = 1;
    }
  }

  // Finder patterns
  function finderPattern(row, col) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const isBlack = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                        (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                        (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        setModule(row + r, col + c, isBlack && r >= 0 && r <= 6 && c >= 0 && c <= 6);
      }
    }
  }

  finderPattern(0, 0);
  finderPattern(0, size - 7);
  finderPattern(size - 7, 0);

  // Alignment patterns (version >= 2)
  if (version >= 2) {
    const positions = getAlignmentPositions(version);
    for (const r of positions) {
      for (const c of positions) {
        if (reserved[r][c]) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const isBlack = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
            setModule(r + dr, c + dc, isBlack);
          }
        }
      }
    }
  }

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) setModule(6, i, i % 2 === 0);
    if (!reserved[i][6]) setModule(i, 6, i % 2 === 0);
  }

  // Dark module
  setModule(size - 8, 8, true);

  // Reserve format info areas
  for (let i = 0; i < 8; i++) {
    if (!reserved[8][i]) { reserved[8][i] = 1; }
    if (!reserved[8][size - 1 - i]) { reserved[8][size - 1 - i] = 1; }
    if (!reserved[i][8]) { reserved[i][8] = 1; }
    if (!reserved[size - 1 - i][8]) { reserved[size - 1 - i][8] = 1; }
  }
  reserved[8][8] = 1;

  return { matrix, reserved, size };
}

function getAlignmentPositions(version) {
  if (version === 1) return [];
  const intervals = [0, 0, 18, 22, 26, 30, 34, 22, 24, 26, 28][version];
  const size = version * 4 + 17;
  const last = size - 7;
  const positions = [6];
  let pos = last;
  while (pos > 6) {
    positions.unshift(pos);
    pos -= intervals;
  }
  return positions;
}

function placeData(matrix, reserved, size, data) {
  let bitIdx = 0;
  const totalBits = data.length * 8;
  let col = size - 1;
  let goingUp = true;

  while (col >= 0) {
    if (col === 6) col--; // Skip timing column

    for (let row = 0; row < size; row++) {
      const r = goingUp ? size - 1 - row : row;
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (cc < 0 || reserved[r][cc]) continue;
        if (bitIdx < totalBits) {
          const byteIdx = Math.floor(bitIdx / 8);
          const bitPos = 7 - (bitIdx % 8);
          matrix[r][cc] = ((data[byteIdx] >> bitPos) & 1) ? 1 : -1;
          bitIdx++;
        } else {
          matrix[r][cc] = -1;
        }
      }
    }
    goingUp = !goingUp;
    col -= 2;
  }
}

function applyMask(matrix, reserved, size, maskNum) {
  const maskFns = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ];
  const fn = maskFns[maskNum];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!reserved[r][c] && fn(r, c)) {
        matrix[r][c] = matrix[r][c] === 1 ? -1 : 1;
      }
    }
  }
}

function placeFormatInfo(matrix, size, maskNum) {
  // Error correction level L = 01, mask pattern
  const ecLevel = 0b01;
  let data = (ecLevel << 3) | maskNum;

  // BCH(15,5) encoding
  let bits = data << 10;
  let gen = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if (bits & (1 << i)) bits ^= gen << (i - 10);
  }
  bits = (data << 10) | bits;
  bits ^= 0b101010000010010; // XOR mask

  // Place format bits
  const formatBits = [];
  for (let i = 14; i >= 0; i--) formatBits.push((bits >> i) & 1);

  // Around top-left finder
  const positions1 = [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]];
  for (let i = 0; i < 15; i++) {
    const [r, c] = positions1[i];
    matrix[r][c] = formatBits[i] ? 1 : -1;
  }

  // Around other finders
  const positions2 = [[size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],[8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]];
  for (let i = 0; i < 15; i++) {
    const [r, c] = positions2[i];
    matrix[r][c] = formatBits[i] ? 1 : -1;
  }
}

// ── Main QR generation ──
export function generateQR(text) {
  const version = getVersion(text.length);
  const data = encodeData(text, version);
  const { matrix, reserved, size } = createMatrix(version);
  placeData(matrix, reserved, size, data);

  // Try all 8 masks, pick the one with mask 0 (simple, good enough for URLs)
  const maskNum = 0;
  applyMask(matrix, reserved, size, maskNum);
  placeFormatInfo(matrix, size, maskNum);

  // Convert to boolean grid (true = black)
  const grid = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) {
      row.push(matrix[r][c] === 1);
    }
    grid.push(row);
  }
  return { grid, size };
}

/**
 * Render QR code to terminal using Unicode block characters.
 * Each character represents 2 vertical modules.
 */
export function qrToTerminal(text, { invert = false } = {}) {
  const { grid, size } = generateQR(text);
  const quiet = 2; // quiet zone modules

  const lines = [];
  const total = size + quiet * 2;

  // Use upper-half block (U+2580) / lower-half block (U+2584) / full block (U+2588) / space
  for (let r = 0; r < total; r += 2) {
    let line = '';
    for (let c = 0; c < total; c++) {
      const r1 = r - quiet;
      const r2 = r + 1 - quiet;
      const cc = c - quiet;

      const top = (r1 >= 0 && r1 < size && cc >= 0 && cc < size) ? grid[r1][cc] : false;
      const bot = (r2 >= 0 && r2 < size && cc >= 0 && cc < size) ? grid[r2][cc] : false;

      const t = invert ? !top : top;
      const b = invert ? !bot : bot;

      if (t && b) line += '\u2588';       // Full block
      else if (t && !b) line += '\u2580'; // Upper half
      else if (!t && b) line += '\u2584'; // Lower half
      else line += ' ';                    // Empty
    }
    lines.push(line);
  }
  return lines.join('\n');
}
