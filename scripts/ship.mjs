#!/usr/bin/env node
/**
 * Commit and push every change.
 *
 * Usage:
 *   node scripts/ship.mjs "type: summary" "body line" "body line"
 *
 * The first argument is the subject, the rest are body lines. Running the tests
 * first is deliberate: a commit that fails them is not a version worth keeping.
 * Set SKIP_TESTS=1 to commit anyway (for a docs-only change).
 *
 * This exists because the same three steps — test, commit by file, push over
 * SSH — were being retyped for every change, and a mistyped step pushed a
 * broken tree. `git commit -F` is used rather than `-m` because a PowerShell
 * heredoc mangles CJK text.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [subject, ...bodyLines] = process.argv.slice(2);
if (!subject) {
  console.error('usage: node scripts/ship.mjs "subject" ["body line"...]');
  process.exit(2);
}

const run = (args, options = {}) => execFileSync('git', args, {
  encoding: 'utf8',
  stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
});

// Refuse to commit a tree with nothing to say.
const dirty = run(['status', '--porcelain'], { capture: true }).trim();
if (!dirty) {
  console.log('nothing to commit; the tree is already clean');
  process.exit(0);
}
console.log(dirty);

if (process.env.SKIP_TESTS !== '1') {
  console.log('\n--- tests ---');
  const node = process.execPath;
  const tests = spawnSync(node, ['--test', '--test-timeout=40000', ...testFiles()], {
    stdio: 'inherit',
  });
  if (tests.status !== 0) {
    console.error('\ntests failed; nothing was committed');
    process.exit(1);
  }
  const check = spawnSync(node, ['scripts/check-syntax.mjs'], { stdio: 'inherit' });
  if (check.status !== 0) {
    console.error('\nsyntax check failed; nothing was committed');
    process.exit(1);
  }
}

const message = [subject, '', ...(bodyLines.length > 0 ? bodyLines : [''])]
  .join('\n')
  .replace(/\n{3,}/gu, '\n\n')
  .trimEnd();
const messageFile = join(tmpdir(), `dsh-feishu-only-commit-${Date.now()}.txt`);
writeFileSync(messageFile, `${message}\n`, 'utf8');

try {
  run(['add', '-A']);
  run([
    '-c', 'user.name=qdog2012',
    '-c', 'user.email=qdog2012@users.noreply.github.com',
    'commit', '-q', '-F', messageFile,
  ]);
} finally {
  try {
    unlinkSync(messageFile);
  } catch {
    // A temp file that is already gone needs no cleanup.
  }
}

process.env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
run(['push', 'origin', 'main']);

const head = run(['rev-parse', '--short', 'HEAD'], { capture: true }).trim();
const remote = run(['ls-remote', 'origin', 'HEAD'], { capture: true }).trim().split(/\s+/u)[0] ?? '';
const synced = remote.startsWith(head) || run(['rev-parse', 'HEAD'], { capture: true }).trim() === remote;
console.log(`\ncommitted ${head} ${synced ? '(pushed, in sync)' : '(WARNING: remote differs)'}`);

/** The test files, resolved here so the test glob is not re-derived in a shell. */
function testFiles() {
  return readdirSync('test')
    .filter((name) => name.endsWith('.test.js'))
    .map((name) => join('test', name));
}