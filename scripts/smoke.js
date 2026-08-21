#!/usr/bin/env node
/**
 * Smoke test: drive the real MCP wire protocol over stdio.
 *
 * Unit tests import functions directly, so they never prove the server actually speaks
 * MCP — that it handshakes, advertises its tools, and returns well-formed results. This
 * spawns the server as a client would and asserts on the JSON-RPC traffic.
 *
 * No network access required: every assertion below uses local scoring and gating.
 *
 * Run with: npm run smoke
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 20_000;

// A throwaway config so the smoke test never depends on a user's real one.
const dir = mkdtempSync(path.join(tmpdir(), 'radar-smoke-'));
const configPath = path.join(dir, 'radar.config.js');
writeFileSync(
  configPath,
  `import { packs, composePacks } from ${JSON.stringify(path.join(ROOT, 'src/index.js'))};
export default {
  product: { name: 'Acme', what: 'CI observability', claims: ['flaky test detection'] },
  queries: ['flaky tests', 'CI pipeline slow'],
  domainTerms: ['ci', 'pipeline', 'flaky', 'github actions', 'runner'],
  ambiguousTerms: ['build'],
  featureTerms: ['flaky test', 'build time'],
  tiers: { tier1: { mode: 'PROMOTE', weight: 20, subreddits: ['devops'] } },
  gate: {
    ...composePacks(packs.noPricing, packs.noCustomerNames, packs.requireDisclosure),
    productPattern: /\\bAcme\\b/i,
    unsupported: [{ term: /\\bJenkins\\b/i, why: 'No Jenkins integration.' }],
  },
};
`,
);

const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, RADAR_CONFIG: configPath, RADAR_LOG_LEVEL: 'error' },
});

const pending = new Map();
let buffer = '';
let stderr = '';
let nextId = 1;

child.stderr.on('data', (c) => {
  stderr += c;
});

child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  // JSON-RPC over stdio is newline-delimited.
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`server wrote non-JSON to stdout, which corrupts the protocol stream:\n${line}`);
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

const timer = setTimeout(() => fail(`timed out after ${TIMEOUT_MS}ms`), TIMEOUT_MS);

function fail(message) {
  clearTimeout(timer);
  process.stderr.write(`\n✖ smoke: ${message}\n`);
  if (stderr.trim()) process.stderr.write(`\n--- server stderr ---\n${stderr}\n`);
  child.kill('SIGKILL');
  process.exit(1);
}

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function notify(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
}

const textOf = (res) => {
  assert.ok(res.result, `expected a result, got: ${JSON.stringify(res).slice(0, 300)}`);
  return res.result.content.map((c) => c.text).join('\n');
};

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

// --- 1. Handshake -----------------------------------------------------------
const init = await send('initialize', {
  protocolVersion: PROTOCOL_VERSION,
  capabilities: {},
  clientInfo: { name: 'smoke', version: '1.0.0' },
});
check('handshake returns serverInfo', () => {
  assert.equal(init.result.serverInfo.name, 'reddit-radar-mcp');
  assert.match(init.result.serverInfo.version, /^\d+\.\d+\.\d+/);
});
notify('notifications/initialized');

// --- 2. Tool advertisement --------------------------------------------------
const list = await send('tools/list');
const names = list.result.tools.map((t) => t.name).sort();
check('advertises every expected tool', () => {
  assert.deepEqual(names, [
    'analyze_thread',
    'check_draft',
    'get_claim_boundary',
    'ingest_sweep',
    'parse_thread_html',
    'plan_sweep',
    'score_thread',
  ]);
});
check('no tool can post, vote, or comment', () => {
  for (const n of names) {
    assert.doesNotMatch(n, /post|submit|comment|reply|vote|upvote/i, `tool "${n}" looks like a write`);
  }
});
check('every tool has a description and input schema', () => {
  for (const t of list.result.tools) {
    assert.ok(t.description?.length > 20, `${t.name} needs a real description`);
    assert.ok(t.inputSchema, `${t.name} needs an inputSchema`);
  }
});

// --- 3. plan_sweep ----------------------------------------------------------
const plan = await send('tools/call', {
  name: 'plan_sweep',
  arguments: { strategy: 'global', maxQueries: 2 },
});
check('plan_sweep returns URLs and the extractor', () => {
  const t = textOf(plan);
  assert.match(t, /reddit\.com\/search/);
  assert.match(t, /EXTRACTOR/);
  assert.match(t, /search-telemetry-tracker/);
});

// --- 4. score_thread --------------------------------------------------------
const scoreGood = await send('tools/call', {
  name: 'score_thread',
  arguments: {
    title: 'What CI tool do you use for flaky test detection?',
    subreddit: 'devops',
    createdUtc: Math.floor(Date.now() / 1000) - 86_400,
    matchedQueries: ['flaky tests'],
  },
});
check('score_thread scores a real tooling question highly', () => {
  const t = textOf(scoreGood);
  const score = Number(t.match(/SCORE:\s*(\d+)/)?.[1]);
  assert.ok(score >= 40, `expected >= 40, got ${score}\n${t}`);
});

const scoreBad = await send('tools/call', {
  name: 'score_thread',
  arguments: {
    title: 'Any recommendations for a good app?',
    subreddit: 'cooking',
    createdUtc: Math.floor(Date.now() / 1000) - 3600,
  },
});
check('score_thread rejects an unanchored off-topic post', () => {
  const t = textOf(scoreBad);
  assert.match(t, /NOT ANCHORED/);
});

// --- 5. ingest_sweep --------------------------------------------------------
const ingest = await send('tools/call', {
  name: 'ingest_sweep',
  arguments: {
    batches: [
      {
        query: 'flaky tests',
        results: [
          {
            id: 'abc123',
            subreddit: 'devops',
            title: 'Our CI pipeline is flaky, what tools help?',
            age: '2d',
            votes: '15',
            comments: '9',
            permalink: 'https://www.reddit.com/r/devops/comments/abc123/x/',
          },
          { id: 'zzz999', subreddit: 'cooking', title: 'Best pan?', age: '1d', votes: '3', comments: '1' },
        ],
      },
    ],
  },
});
check('ingest_sweep ranks the relevant post and filters the rest', () => {
  const t = textOf(ingest);
  assert.match(t, /abc123|CI pipeline is flaky/);
  assert.doesNotMatch(t, /Best pan/);
  assert.match(t, /PROMOTE/);
});

// --- 6. check_draft: the gate ----------------------------------------------
const blocked = await send('tools/call', {
  name: 'check_draft',
  arguments: {
    draft: 'Acme integrates with Jenkins and costs $49/month. One of our customers loved it.',
  },
});
check('check_draft BLOCKS a draft that overclaims', () => {
  const t = textOf(blocked);
  assert.match(t, /BLOCKED/);
  assert.match(t, /missing-disclosure/);
  assert.match(t, /unsupported-capability/);
  assert.match(t, /price-figure/);
});
check('a blocked draft is withheld, not returned', () => {
  const t = textOf(blocked);
  assert.doesNotMatch(t, /APPROVED DRAFT/);
});

const approved = await send('tools/call', {
  name: 'check_draft',
  arguments: {
    draft:
      'Full disclosure: I work at Acme. We do not support Jenkins, only GitHub Actions. ' +
      'The way we surface flaky tests is by rerunning a failed job on an isolated runner ' +
      'and comparing the two traces. That catches ordering bugs a plain retry hides. ' +
      'Worth asking any vendor how they tell a flaky test from a real regression, because ' +
      'the answer separates the serious tools from the dashboards. Ask for a live demo.',
  },
});
check('check_draft APPROVES a grounded draft and returns the text', () => {
  const t = textOf(approved);
  assert.match(t, /APPROVED/);
  assert.match(t, /APPROVED DRAFT/);
});
check('a denial of an unsupported capability is not blocked', () => {
  assert.doesNotMatch(textOf(approved), /unsupported-capability/);
});

// --- 7. get_claim_boundary --------------------------------------------------
const boundary = await send('tools/call', { name: 'get_claim_boundary', arguments: {} });
check('get_claim_boundary reports the configured rules', () => {
  const t = textOf(boundary);
  assert.match(t, /Acme/);
  assert.match(t, /NEVER CLAIM/);
  assert.match(t, /Jenkins/);
});

// --- 8. Error handling ------------------------------------------------------
const bad = await send('tools/call', {
  name: 'parse_thread_html',
  arguments: { post: { id: 'x' }, comments: [] },
});
check('an invalid call returns an error result, not a crash', () => {
  assert.ok(bad.result || bad.error, 'expected a response');
  if (bad.result) assert.equal(bad.result.isError, true);
});

// --- Report -----------------------------------------------------------------
clearTimeout(timer);
let failed = 0;
for (const [name, fn] of checks) {
  try {
    fn();
    process.stdout.write(`  ✔ ${name}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`  ✖ ${name}\n      ${err.message.split('\n')[0]}\n`);
  }
}

child.kill('SIGTERM');

if (failed > 0) {
  process.stderr.write(`\n${failed} smoke check${failed > 1 ? 's' : ''} failed.\n`);
  if (stderr.trim()) process.stderr.write(`\n--- server stderr ---\n${stderr}\n`);
  process.exit(1);
}
process.stdout.write(`\n${checks.length} smoke checks passed — server speaks MCP.\n`);
process.exit(0);
