/**
 * Safety invariants.
 *
 * This package reads Reddit and drafts text for a human. It must never post, vote, or
 * act as an account. These tests exist so that stops being a promise and starts being
 * enforced — if someone adds a write path, CI fails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { RedditApiClient } from '../src/reddit/client.js';
import { BrowserRedditClient } from '../src/reddit/browser-client.js';
import { FixtureRedditClient } from '../src/reddit/fixture-client.js';

const WRITE_METHODS = [
  'post', 'submit', 'comment', 'reply', 'vote', 'upvote', 'downvote',
  'sendMessage', 'follow', 'subscribe', 'delete', 'edit', 'report', 'award',
];

const clients = [
  ['RedditApiClient', RedditApiClient.prototype],
  ['BrowserRedditClient', BrowserRedditClient.prototype],
  ['FixtureRedditClient', FixtureRedditClient.prototype],
];

for (const [name, proto] of clients) {
  test(`${name} exposes no write/post/vote methods`, () => {
    const names = Object.getOwnPropertyNames(proto);
    for (const m of WRITE_METHODS) {
      assert.ok(
        !names.some((n) => n.toLowerCase() === m.toLowerCase()),
        `${name} must not expose ${m}()`,
      );
    }
  });
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test('no source file issues a Reddit write request', async () => {
  const root = new URL('../src/', import.meta.url).pathname;
  const offenders = [];

  for (const file of await walk(root)) {
    const src = await readFile(file, 'utf8');
    // A POST/PUT/DELETE aimed at reddit's API surface.
    const writeVerb = /method:\s*['"](POST|PUT|DELETE|PATCH)['"]/i.test(src);
    const apiEndpoint = /\/api\/(?:submit|comment|vote|compose|save|del|editusertext|friend|subscribe)/i.test(src);
    if (apiEndpoint) offenders.push(`${path.basename(file)}: references a write endpoint`);
    // The OAuth token call is the one legitimate POST.
    if (writeVerb && !/access_token/.test(src)) {
      offenders.push(`${path.basename(file)}: has a non-auth write verb`);
    }
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('package exports no posting function', async () => {
  const mod = await import('../src/index.js');
  for (const key of Object.keys(mod)) {
    assert.ok(
      !/^(post|submit|comment|reply|vote|upvote)/i.test(key),
      `index.js must not export ${key}`,
    );
  }
});
