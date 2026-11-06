import test from 'node:test';
import assert from 'node:assert/strict';

import { encodeQr, qrSvg } from '../lib/qr.js';

/**
 * Structural checks only.
 *
 * The encoder is verified against an independent decoder (jsQR) during
 * development; these tests pin the invariants that decoder relies on, so a
 * regression that would make a real phone fail to scan is caught here without
 * shipping a decoder dependency.
 */

test('the simplest payload encodes at version 1', () => {
  const { version, size } = encodeQr('HI');
  assert.equal(version, 1);
  assert.equal(size, 21);
});

test('a longer payload selects a larger version', () => {
  const small = encodeQr('A');
  const large = encodeQr('https://open.feishu.cn/page/launcher?user_code=BUEY-PZCV&from=sdk');
  assert.ok(large.version > small.version);
  assert.equal(large.size, large.version * 4 + 17);
});

test('the matrix is square and matches the version size', () => {
  const { version, size, modules } = encodeQr('https://example.com/x');
  assert.equal(modules.length, size);
  for (const row of modules) assert.equal(row.length, size);
  assert.equal(size, version * 4 + 17);
});

test('the three finder patterns are present and correctly shaped', () => {
  const { size, modules } = encodeQr('https://example.com/finders');

  // A finder is a 7x7 ring: dark border, light ring, 3x3 dark core.
  const checkFinder = (left, top) => {
    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        const onBorder = x === 0 || y === 0 || x === 6 || y === 6;
        const inCore = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        const expected = onBorder || inCore;
        assert.equal(
          modules[top + y][left + x],
          expected,
          `finder at ${left},${top} module ${x},${y}`,
        );
      }
    }
  };
  checkFinder(0, 0);
  checkFinder(size - 7, 0);
  checkFinder(0, size - 7);
});

test('the timing patterns alternate between the finders', () => {
  const { size, modules } = encodeQr('https://example.com/timing');
  for (let i = 8; i < size - 8; i += 1) {
    assert.equal(modules[6][i], i % 2 === 0, `horizontal timing at ${i}`);
    assert.equal(modules[i][6], i % 2 === 0, `vertical timing at ${i}`);
  }
});

test('the dark module next to the bottom-left finder is always set', () => {
  const { size, modules } = encodeQr('https://example.com/dark');
  assert.equal(modules[size - 8][8], true);
});

test('the same input always produces the same matrix', () => {
  const a = encodeQr('https://example.com/stable');
  const b = encodeQr('https://example.com/stable');
  assert.deepEqual(a.modules, b.modules);
});

test('different inputs produce different matrices', () => {
  const a = encodeQr('https://example.com/a');
  const b = encodeQr('https://example.com/b');
  assert.notDeepEqual(a.modules, b.modules);
});

test('UTF-8 payloads encode without throwing', () => {
  const { modules } = encodeQr('飞书机器人任务');
  assert.ok(modules.length > 0);
});

test('an over-long payload is rejected rather than silently truncated', () => {
  assert.throws(() => encodeQr('x'.repeat(4000)), /too long/u);
});

test('the SVG declares its own size and a white background', () => {
  const svg = qrSvg('https://example.com/svg', { scale: 4, border: 2 });
  const { size } = encodeQr('https://example.com/svg');
  const expected = (size + 4) * 4;
  assert.match(svg, /^<svg /u);
  assert.ok(svg.includes(`width="${expected}"`), 'width matches scale and border');
  assert.ok(svg.includes(`height="${expected}"`));
  assert.ok(svg.includes('#ffffff'), 'a quiet-zone background is present');
  assert.ok(svg.endsWith('</svg>'));
  assert.ok(svg.includes('role="img"'), 'the image is labelled for assistive tech');
});

test('the SVG path contains one subpath per dark module', () => {
  const svg = qrSvg('https://example.com/path');
  const { modules } = encodeQr('https://example.com/path');
  const dark = modules.flat().filter(Boolean).length;
  const subpaths = (svg.match(/M\d+ \d+h1v1h-1z/gu) ?? []).length;
  assert.equal(subpaths, dark);
});