/**
 * QR code rendering for the onboarding page.
 *
 * The page shows a QR for the verification URL. Rather than shipping a QR
 * encoder in the browser bundle, the Host renders it once as SVG, so the
 * encoder exists in one place and the page stays a thin view.
 *
 * This is a byte-mode, error-correction-level-M QR encoder: exactly what a URL
 * needs and no more. It is deliberately small and self-contained.
 *
 * @module dsh-feishu-only/lib/qr
 */

/** Error-correction codewords per block for level M, indexed by version. */
const ECC_CODEWORDS_PER_BLOCK_M = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];

/** Number of error-correction blocks for level M, indexed by version. */
const NUM_ERROR_CORRECTION_BLOCKS_M = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

const ECC_LEVEL_M = { formatBits: 0, ecc: ECC_CODEWORDS_PER_BLOCK_M, blocks: NUM_ERROR_CORRECTION_BLOCKS_M };
const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** Total codewords available at one version. */
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version, ecl) {
  return Math.floor(rawDataModules(version) / 8 - ecl.ecc[version] * ecl.blocks[version]);
}

/** Build the per-version alignment pattern centers. */
function alignmentPatternPositions(version) {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32
    ? 26
    : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < numAlign; position -= step) {
    result.splice(1, 0, position);
  }
  return result;
}

// ----------------------------------------------------------------- Reed-Solomon

function reedSolomonDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = multiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = multiply(root, 0x02);
  }
  return result;
}

function multiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function reedSolomonRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < result.length; i += 1) {
      result[i] ^= multiply(divisor[i], factor);
    }
  }
  return result;
}

// ---------------------------------------------------------------- bit buffer

class BitBuffer {
  bits = [];

  append(value, length) {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }

  get length() {
    return this.bits.length;
  }
}

function encodeSegment(text) {
  const bytes = new TextEncoder().encode(text);
  const buffer = new BitBuffer();
  buffer.append(0b0100, 4); // byte mode
  // Character count uses 8 bits for versions 1-9 and 16 bits above.
  const versionGuess = bytes.length <= 17 ? 1 : bytes.length <= 32 ? 2 : 3;
  buffer.append(bytes.length, versionGuess <= 9 ? 8 : 16);
  for (const byte of bytes) buffer.append(byte, 8);
  return { buffer, length: bytes.length };
}

// ------------------------------------------------------------------ encoding

/**
 * Encode one UTF-8 string at error-correction level M.
 *
 * @param {string} text
 * @returns {{ version: number, size: number, modules: boolean[][] }}
 */
export function encodeQr(text) {
  const payload = new TextEncoder().encode(text);
  // Pick the smallest version whose data capacity holds this payload.
  let version = 0;
  for (let candidate = 1; candidate <= 40; candidate += 1) {
    const capacityBits = dataCodewords(candidate, ECC_LEVEL_M) * 8;
    const headerBits = 4 + (candidate <= 9 ? 8 : 16);
    if (headerBits + payload.length * 8 <= capacityBits) {
      version = candidate;
      break;
    }
  }
  if (version === 0) throw new Error('the verification URL is too long to encode');

  const capacityBits = dataCodewords(version, ECC_LEVEL_M) * 8;
  const buffer = new BitBuffer();
  buffer.append(0b0100, 4);
  buffer.append(payload.length, version <= 9 ? 8 : 16);
  for (const byte of payload) buffer.append(byte, 8);

  // Terminator, then pad to a byte boundary.
  const terminator = Math.min(4, capacityBits - buffer.length);
  buffer.append(0, terminator);
  while (buffer.length % 8 !== 0) buffer.bits.push(0);

  // Pad codewords alternate 0xEC / 0x11.
  const padBytes = Math.floor((capacityBits - buffer.length) / 8);
  for (let i = 0; i < padBytes; i += 1) buffer.append(i % 2 === 0 ? 0xec : 0x11, 8);

  const data = new Uint8Array(buffer.length / 8);
  for (let i = 0; i < buffer.bits.length; i += 1) {
    if (buffer.bits[i]) data[i >>> 3] |= 0x80 >>> (i & 7);
  }

  const allCodewords = addEccAndInterleave(data, version, ECC_LEVEL_M);
  return buildMatrix(version, allCodewords, ECC_LEVEL_M);
}

function addEccAndInterleave(data, version, ecl) {
  const numBlocks = ecl.blocks[version];
  const blockEccLen = ecl.ecc[version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  const divisor = reedSolomonDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const dataLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
    const block = data.slice(k, k + dataLen);
    k += dataLen;
    const ecc = reedSolomonRemainder(block, divisor);
    const parts = [block, ecc];
    blocks.push(parts);
  }

  const result = new Uint8Array(rawCodewords);
  let index = 0;
  for (let i = 0; i < shortBlockLen + 1; i += 1) {
    for (let j = 0; j < numBlocks; j += 1) {
      const block = blocks[j][0];
      const ecc = blocks[j][1];
      if (i < block.length) result[index++] = block[i];
      if (i === shortBlockLen - blockEccLen) {
        for (const byte of ecc) result[index++] = byte;
      }
    }
  }
  // The loop above consumed the ECC in block order; rebuild cleanly instead.
  const ordered = [];
  for (let i = 0; i < shortBlockLen + 1; i += 1) {
    for (const [block, ecc] of blocks) {
      if (i < block.length) ordered.push(block[i]);
    }
    if (i === shortBlockLen - blockEccLen) {
      for (let e = 0; e < blockEccLen; e += 1) {
        for (const [, ecc] of blocks) ordered.push(ecc[e]);
      }
    }
  }
  return Uint8Array.from(ordered);
}

function buildMatrix(version, codewords, ecl) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));

  const setFunction = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  // Finder patterns plus separators.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || x >= size || y < 0 || y >= size) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        setFunction(x, y, distance !== 2 && distance !== 4);
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }

  // Alignment patterns.
  const positions = alignmentPatternPositions(version);
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      // Skip the three positions occupied by finder patterns.
      if ((i === 0 && j === 0) || (i === 0 && j === positions.length - 1)
        || (i === positions.length - 1 && j === 0)) continue;
      const cx = positions[i];
      const cy = positions[j];
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // Reserve the format areas before placing data.
  const drawFormatBits = (mask) => {
    const data = (ecl.formatBits << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    for (let i = 0; i <= 5; i += 1) setFunction(8, i, ((bits >>> i) & 1) !== 0);
    setFunction(8, 7, ((bits >>> 6) & 1) !== 0);
    setFunction(8, 8, ((bits >>> 7) & 1) !== 0);
    setFunction(7, 8, ((bits >>> 8) & 1) !== 0);
    for (let i = 9; i < 15; i += 1) setFunction(14 - i, 8, ((bits >>> i) & 1) !== 0);

    for (let i = 0; i < 8; i += 1) setFunction(size - 1 - i, 8, ((bits >>> i) & 1) !== 0);
    for (let i = 8; i < 15; i += 1) setFunction(8, size - 15 + i, ((bits >>> i) & 1) !== 0);
    setFunction(8, size - 8, true);
  };

  // Reserve the version area for version 7 and above.
  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (version << 12) | remainder;
    for (let i = 0; i < 18; i += 1) {
      const bit = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(a, b, bit);
      setFunction(b, a, bit);
    }
  }

  drawFormatBits(0);

  // Place data with a zigzag scan, skipping the vertical timing column.
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunction[y][x]) continue;
        const bit = bitIndex < codewords.length * 8
          ? ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0
          : false;
        modules[y][x] = bit;
        bitIndex += 1;
      }
    }
  }

  applyBestMask(modules, isFunction, size, ecl);
  return { version, size, modules };
}

/** Apply the mask with the lowest penalty, writing its number into the format. */
function applyBestMask(modules, isFunction, size, ecl) {
  let bestMask = 0;
  let bestPenalty = Infinity;
  const apply = (mask) => {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (isFunction[y][x]) continue;
        if (maskBit(mask, x, y)) modules[y][x] = !modules[y][x];
      }
    }
  };
  for (let mask = 0; mask < 8; mask += 1) {
    apply(mask);
    const penalty = penaltyScore(modules, size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    apply(mask); // undo
  }
  apply(bestMask);
  writeFormatBits(modules, size, ecl, bestMask);
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return false;
  }
}

function writeFormatBits(modules, size, ecl, mask) {
  const data = (ecl.formatBits << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const place = (x, y, bit) => {
    modules[y][x] = bit;
  };
  for (let i = 0; i <= 5; i += 1) place(8, i, ((bits >>> i) & 1) !== 0);
  place(8, 7, ((bits >>> 6) & 1) !== 0);
  place(8, 8, ((bits >>> 7) & 1) !== 0);
  place(7, 8, ((bits >>> 8) & 1) !== 0);
  for (let i = 9; i < 15; i += 1) place(14 - i, 8, ((bits >>> i) & 1) !== 0);
  for (let i = 0; i < 8; i += 1) place(size - 1 - i, 8, ((bits >>> i) & 1) !== 0);
  for (let i = 8; i < 15; i += 1) place(8, size - 15 + i, ((bits >>> i) & 1) !== 0);
  place(8, size - 8, true);
}

function penaltyScore(modules, size) {
  let penalty = 0;
  const line = (get) => {
    let runColor = null;
    let runLength = 0;
    let score = 0;
    for (let i = 0; i < size; i += 1) {
      const color = get(i);
      if (color === runColor) {
        runLength += 1;
      } else {
        if (runLength >= 5) score += PENALTY_N1 + (runLength - 5);
        runColor = color;
        runLength = 1;
      }
    }
    if (runLength >= 5) score += PENALTY_N1 + (runLength - 5);
    return score;
  };
  for (let y = 0; y < size; y += 1) penalty += line((x) => modules[y][x]);
  for (let x = 0; x < size; x += 1) penalty += line((y) => modules[y][x]);

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        penalty += PENALTY_N2;
      }
    }
  }
  return penalty + 0 * PENALTY_N3 + 0 * PENALTY_N4;
}

/**
 * Render one string as a standalone SVG QR code.
 *
 * @param {string} text
 * @param {{ scale?: number, border?: number }} [options]
 * @returns {string} an SVG document.
 */
export function qrSvg(text, { scale = 6, border = 4 } = {}) {
  const { size, modules } = encodeQr(text);
  const dimension = (size + border * 2) * scale;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" `
    + `viewBox="0 0 ${size + border * 2} ${size + border * 2}" shape-rendering="crispEdges" `
    + 'role="img" aria-label="QR code">',
    `<rect width="${size + border * 2}" height="${size + border * 2}" fill="#ffffff"/>`,
    '<path fill="#000000" d="',
  ];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!modules[y][x]) continue;
      parts.push(`M${x + border} ${y + border}h1v1h-1z`);
    }
  }
  parts.push('"/></svg>');
  return parts.join('');
}