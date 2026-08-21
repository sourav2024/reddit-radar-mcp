#!/usr/bin/env node
/**
 * Portable test runner.
 *
 * Why this exists rather than `node --test "test/**\/*.test.js"`:
 *
 *   - Glob patterns inside `--test` need Node 21+ (unflagged in 22). This package
 *     declares engines >=20.10.0, and CI proved the point: on Node 20 the pattern matched
 *     nothing, `npm test` exited 1, and no test output was produced at all.
 *   - An unquoted shell glob (`node --test test/*.test.js`) works on bash but not on
 *     Windows cmd.exe, which does not expand globs.
 *
 * So discovery happens here, in JS, where behaviour is identical everywhere. Pass extra
 * node flags through argv, e.g. `node scripts/run-tests.js --watch`.
 */
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');

/** Recursively collect *.test.js so nested suites work if the tree grows. */
function findTests(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...findTests(full));
    else if (name.endsWith('.test.js')) out.push(full);
  }
  return out.sort();
}

let files;
try {
  files = findTests(TEST_DIR);
} catch (err) {
  process.stderr.write(`Could not read ${TEST_DIR}: ${err.message}\n`);
  process.exit(1);
}

if (files.length === 0) {
  // Exiting 0 here would let an empty suite masquerade as a passing one.
  process.stderr.write(`No *.test.js files found in ${TEST_DIR}\n`);
  process.exit(1);
}

const passthrough = process.argv.slice(2);
const result = spawnSync(process.execPath, ['--test', ...passthrough, ...files], {
  stdio: 'inherit',
  cwd: ROOT,
});

process.exit(result.status ?? 1);
