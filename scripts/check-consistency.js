#!/usr/bin/env node
/**
 * Fail the build if metadata is inconsistent or a placeholder would ship.
 *
 * Two failure modes this catches, both of which are hard to un-publish:
 *
 *   1. Version drift. package.json, server.json (twice), and CHANGELOG.md all carry the
 *      version. A release that bumps one and forgets another publishes a package whose
 *      MCP registry entry points at a version that does not exist.
 *   2. Unfilled placeholders. A repository URL or funding link pointing at something
 *      nobody owns is worse than no link at all.
 *
 * Runs in `npm run verify` and via prepublishOnly, so neither can reach npm unnoticed.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const readJson = (f) => JSON.parse(read(f));

const problems = [];
const fail = (msg) => problems.push(msg);

// --- 1. Version consistency -------------------------------------------------
const pkg = readJson('package.json');
const server = readJson('server.json');

if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(pkg.version)) {
  fail(`package.json version "${pkg.version}" is not valid semver.`);
}
if (server.version !== pkg.version) {
  fail(`server.json version "${server.version}" != package.json "${pkg.version}".`);
}
const npmPkg = server.packages?.find((p) => p.registryType === 'npm');
if (!npmPkg) {
  fail('server.json has no npm package entry.');
} else {
  if (npmPkg.version !== pkg.version) {
    fail(`server.json packages[npm].version "${npmPkg.version}" != package.json "${pkg.version}".`);
  }
  if (npmPkg.identifier !== pkg.name) {
    fail(`server.json packages[npm].identifier "${npmPkg.identifier}" != package.json name "${pkg.name}".`);
  }
}

// CHANGELOG must document the version being published.
try {
  const changelog = read('CHANGELOG.md');
  if (!changelog.includes(`[${pkg.version}]`)) {
    fail(`CHANGELOG.md has no "[${pkg.version}]" section. Document the release before publishing.`);
  }
} catch {
  fail('CHANGELOG.md is missing.');
}

// --- 2. Placeholders --------------------------------------------------------
const PLACEHOLDERS = [
  { token: '<OWNER>', files: ['package.json', 'server.json', 'README.md'],
    fix: 'Replace with the GitHub owner/organization name.' },
  { token: 'YOUR-USERNAME', files: ['package.json', 'server.json', 'README.md', '.github/FUNDING.yml'],
    fix: 'Replace with your GitHub username, or remove the link entirely.' },
  { token: 'TODO:', files: ['README.md', 'server.json'],
    fix: 'Resolve the TODO or remove it before publishing.' },
];

for (const { token, files, fix } of PLACEHOLDERS) {
  for (const file of files) {
    let content;
    try {
      content = read(file);
    } catch {
      continue; // optional file
    }
    content.split('\n').forEach((line, i) => {
      if (line.includes(token)) {
        fail(`${file}:${i + 1} unfilled placeholder "${token}"\n      → ${fix}`);
      }
    });
  }
}

// --- 3. Files that must exist in the tarball --------------------------------
for (const required of ['README.md', 'LICENSE', 'CHANGELOG.md', 'server.js', 'src/index.js']) {
  try {
    read(required);
  } catch {
    fail(`Required file missing: ${required}`);
  }
}

// --- 4. The safety invariant, restated as metadata --------------------------
// A posting tool would need a write scope somewhere in the manifest. If one ever appears,
// that is a deliberate change to the project's core promise and should fail loudly here.
if (/\b(submit|post|vote|comment)\b/i.test(JSON.stringify(server.packages ?? []))) {
  fail('server.json mentions a write capability. This package is read-only by design.');
}

// --- Report -----------------------------------------------------------------
if (problems.length > 0) {
  process.stderr.write('\nconsistency check failed:\n\n');
  for (const p of problems) process.stderr.write(`  ✖ ${p}\n`);
  process.stderr.write(`\n${problems.length} problem(s) found.\n`);
  process.exit(1);
}

process.stdout.write(`consistency OK — v${pkg.version} aligned across package.json, server.json, CHANGELOG.md\n`);
