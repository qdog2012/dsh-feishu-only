/**
 * Syntax-check every shipped JavaScript file.
 *
 * The plugin has no build step, so this is the equivalent of a compile gate:
 * anything that fails here would fail to load in the Host.
 *
 * Usage: node scripts/check-syntax.mjs
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) yield path;
  }
}

const files = [];
for await (const file of walk(root)) files.push(file);
files.push(join(root, 'index.js'));

let failed = 0;
for (const file of new Set(files)) {
  try {
    await run(process.execPath, ['--check', file]);
  } catch (error) {
    failed += 1;
    console.error(`✖ ${relative(root, file)}\n${error.stderr ?? error.message}`);
  }
}

// A manifest that cannot be parsed is as fatal as a syntax error.
try {
  JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
} catch (error) {
  failed += 1;
  console.error(`✖ package.json\n${error.message}`);
}
for (const locale of ['en', 'zh']) {
  try {
    JSON.parse(await readFile(join(root, 'locale', `${locale}.json`), 'utf8'));
  } catch (error) {
    failed += 1;
    console.error(`✖ locale/${locale}.json\n${error.message}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} file(s) failed`);
  process.exit(1);
}
console.log(`✓ ${new Set(files).size} source files and every JSON resource parse cleanly`);