/**
 * Fixture-backed Reddit client.
 *
 * Implements the same interface as RedditApiClient so the whole pipeline downstream of
 * the adapter can be built and tested while Reddit API approval is pending
 * (docs/REDDIT-API-FINDINGS.md).
 *
 * Fixtures are stored in Reddit's raw wire format and run through the *same*
 * normalizers as live responses. That's deliberate: if the fixtures were pre-normalized
 * they'd validate nothing, and parser bugs would only appear once credentials arrived.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { normalizePost, parseCommentForest, normalizeComment } from './client.js';

const DEFAULT_DIR = new URL('../../fixtures/', import.meta.url).pathname;

export class FixtureRedditClient {
  constructor({ dir = DEFAULT_DIR } = {}) {
    this.dir = dir;
    this.mode = 'fixture';
  }

  async #load(name) {
    const raw = await readFile(path.join(this.dir, name), 'utf8');
    return JSON.parse(raw);
  }

  async #allThreadFixtures() {
    const files = (await readdir(this.dir)).filter((f) => f.startsWith('thread-') && f.endsWith('.json'));
    return Promise.all(files.map((f) => this.#load(f)));
  }

  /**
   * Naive substring match over title + body. Good enough to exercise the pipeline;
   * it is explicitly NOT a model of Reddit's relevance ranking.
   */
  async searchPosts({ query, subreddit, limit = 25 } = {}) {
    if (!query) throw new TypeError('searchPosts requires a query');
    const threads = await this.#allThreadFixtures();
    const needle = query.toLowerCase();

    const posts = threads
      .map((t) => t[0]?.data?.children?.[0]?.data)
      .filter(Boolean)
      .filter((d) => !subreddit || d.subreddit?.toLowerCase() === subreddit.toLowerCase())
      .filter((d) => `${d.title ?? ''} ${d.selftext ?? ''}`.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(normalizePost);

    return { posts, after: null };
  }

  async getThread({ postId } = {}) {
    if (!postId) throw new TypeError('getThread requires a postId');
    const id = String(postId).replace(/^t3_/, '');
    const json = await this.#load(`thread-${id}.json`);
    const postData = json[0]?.data?.children?.[0]?.data;
    if (!postData) throw new Error(`Fixture thread-${id}.json contained no post`);
    return {
      post: normalizePost(postData),
      comments: parseCommentForest(json[1]?.data?.children ?? []),
    };
  }

  async getSubredditAbout(subreddit) {
    const json = await this.#load(`subreddit-${subreddit.toLowerCase()}-about.json`);
    const d = json?.data ?? {};
    return {
      name: d.display_name ?? subreddit,
      title: d.title ?? null,
      publicDescription: d.public_description ?? '',
      description: d.description ?? '',
      subscribers: d.subscribers ?? null,
      over18: Boolean(d.over18),
      subredditType: d.subreddit_type ?? null,
      submissionType: d.submission_type ?? null,
      quarantine: Boolean(d.quarantine),
    };
  }

  async getSubredditRules(subreddit) {
    const json = await this.#load(`subreddit-${subreddit.toLowerCase()}-rules.json`);
    return {
      rules: (json?.rules ?? []).map((r, i) => ({
        index: i + 1,
        shortName: r.short_name ?? '',
        description: r.description ?? '',
        kind: r.kind ?? null,
        violationReason: r.violation_reason ?? null,
      })),
      siteRulesFlow: json?.site_rules_flow ?? null,
    };
  }

  async getUserComments({ username, limit = 100 } = {}) {
    const json = await this.#load(`user-${username.toLowerCase()}-comments.json`).catch(() => null);
    if (!json) return { comments: [], after: null };
    return {
      comments: (json?.data?.children ?? [])
        .filter((c) => c?.kind === 't1')
        .map((c) => normalizeComment(c.data))
        .slice(0, limit),
      after: null,
    };
  }
}

/**
 * Chooses the client from env. Keeping this the single construction point means no
 * downstream module ever needs to know which mode it's running in.
 */
export async function createRedditClient(env = process.env, { driver } = {}) {
  const mode = (env.REDDIT_MODE ?? 'fixture').toLowerCase();
  if (mode === 'fixture') return new FixtureRedditClient();

  if (mode === 'browser') {
    if (!driver) {
      throw new Error(
        'REDDIT_MODE=browser needs a Playwright driver passed in as { driver }. ' +
          'See src/reddit/browser-client.js and docs/NO-API-TRADEOFFS.md.',
      );
    }
    const { BrowserRedditClient } = await import('./browser-client.js');
    return new BrowserRedditClient({
      driver,
      delayMs: Number(env.REDDIT_BROWSER_DELAY_MS ?? 4000),
    });
  }

  const { RedditApiClient } = await import('./client.js');
  return new RedditApiClient({
    clientId: env.REDDIT_CLIENT_ID,
    clientSecret: env.REDDIT_CLIENT_SECRET,
    userAgent: env.REDDIT_USER_AGENT,
  });
}
