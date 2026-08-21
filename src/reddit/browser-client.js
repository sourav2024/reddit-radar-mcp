/**
 * Browser-backed Reddit reader.
 *
 * Third implementation of the same adapter interface as RedditApiClient and
 * FixtureRedditClient, so nothing downstream knows or cares which one is in use.
 *
 * WHY THIS EXISTS: Reddit Data API access is approval-gated and queued (see
 * docs/REDDIT-API-FINDINGS.md). This reads the same public pages a person reads, from a
 * real browser, so the drafting half of the product is usable now.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - No posting, commenting, voting, or messaging. Read-only navigation + DOM reads.
 *   - No login automation or credential handling.
 *   - No concurrency. One page at a time, with human-scale pauses between navigations.
 *
 * TRADEOFF, STATED PLAINLY: this depends on Reddit's DOM. Reddit ships redesigns, and
 * when it does, the extractors below break. They're written to fail loudly (returning
 * nothing and logging which selector missed) rather than silently returning empty
 * threads that would look like "no discussion found". See docs/NO-API-TRADEOFFS.md.
 *
 * Reddit's current web UI renders posts and comments as custom elements whose
 * attributes carry the structured fields we need — verified live 2026-08-20:
 *   <shreddit-post    id score upvote-ratio comment-count created-timestamp author
 *                     post-title subreddit-name permalink post-type>
 *   <shreddit-comment thingid parentid depth score created author is-op permalink>
 * `is-op` is the DOM equivalent of the API's `is_submitter`, which is what makes OP-reply
 * prioritization work here at all.
 */

const BASE = 'https://www.reddit.com';

/** Politeness delay between navigations. Not a rate-limit workaround — a slowdown. */
const DEFAULT_DELAY_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RedditDomError extends Error {
  constructor(message, { selector, url } = {}) {
    super(message);
    this.selector = selector;
    this.url = url;
  }
}

/**
 * @param {object} driver Must provide:
 *   navigate(url): Promise<void>
 *   evaluate(fnString): Promise<string>  // returns JSON string from the page
 * This keeps the client independent of any particular Playwright binding.
 */
export class BrowserRedditClient {
  constructor({ driver, delayMs = DEFAULT_DELAY_MS, logger = console } = {}) {
    if (!driver?.navigate || !driver?.evaluate) {
      throw new TypeError('BrowserRedditClient requires a driver with navigate() and evaluate()');
    }
    this.driver = driver;
    this.delayMs = delayMs;
    this.logger = logger;
    this.mode = 'browser';
    this._lastNav = 0;
  }

  async #go(url) {
    const since = Date.now() - this._lastNav;
    if (since < this.delayMs) await sleep(this.delayMs - since);
    await this.driver.navigate(url);
    this._lastNav = Date.now();
  }

  async #read(fn) {
    const raw = await this.driver.evaluate(fn);
    if (raw == null) return null;
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      // Playwright bindings sometimes wrap the result in quotes.
      try {
        return JSON.parse(JSON.parse(raw));
      } catch {
        throw new RedditDomError('Page returned a non-JSON payload');
      }
    }
  }

  /**
   * Search. Only IDs, titles, and subreddits are reliably present on the results page —
   * score/comments/timestamp are NOT rendered there, so they come back null and are
   * filled in by getThread(). Callers must not assume they exist (see §Limitations).
   */
  async searchPosts({ query, subreddit, sort = 'relevance', time = 'month', limit = 25 } = {}) {
    if (!query) throw new TypeError('searchPosts requires a query');

    const url = subreddit
      ? `${BASE}/r/${encodeURIComponent(subreddit)}/search/?q=${encodeURIComponent(query)}&restrict_sr=1&type=link&sort=${sort}&t=${time}`
      : `${BASE}/search/?q=${encodeURIComponent(query)}&type=link&sort=${sort}&t=${time}`;

    await this.#go(url);

    const data = await this.#read(`() => {
      const seen = new Map();
      for (const a of document.querySelectorAll('a[href*="/comments/"]')) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\\/r\\/([^/]+)\\/comments\\/([a-z0-9]+)/i);
        if (!m) continue;
        const id = m[2];
        if (seen.has(id)) continue;
        const title = (a.innerText || '').trim();
        if (!title) continue;
        seen.set(id, { id, subreddit: m[1], title, permalink: href.split('?')[0] });
      }
      return JSON.stringify({
        posts: [...seen.values()],
        loginWalled: /log in to continue|sign up to continue/i.test(document.body.innerText.slice(0, 600)),
        resultCount: document.querySelectorAll('a[href*="/comments/"]').length
      });
    }`);

    if (data?.loginWalled) {
      throw new RedditDomError('Reddit served a login wall for this search', { url });
    }
    if (!data || data.posts.length === 0) {
      this.logger.warn?.(
        `[browser] No results parsed for "${query}"${subreddit ? ` in r/${subreddit}` : ''}. ` +
          `Either genuinely empty, or Reddit changed its markup (saw ${data?.resultCount ?? 0} comment links).`,
      );
      return { posts: [], after: null };
    }

    return {
      posts: data.posts.slice(0, limit).map((p) => ({
        id: p.id,
        fullname: `t3_${p.id}`,
        subreddit: p.subreddit,
        title: p.title,
        selftext: '', // not rendered on search results; getThread() fills this
        author: null,
        createdUtc: null,
        score: null,
        upvoteRatio: null,
        numComments: null,
        permalink: `${BASE}${p.permalink}`,
        url: `${BASE}${p.permalink}`,
        isSelf: true,
        linkFlair: null,
        over18: false,
        locked: false,
        archived: false,
        stickied: false,
        removedByCategory: null,
        _partial: true, // flag: metadata absent until the thread is fetched
      })),
      after: null,
    };
  }

  /**
   * Full thread. This is where the real fields live — the shreddit custom elements carry
   * score, depth, parentid, created, and is-op as attributes.
   */
  async getThread({ postId, subreddit } = {}) {
    if (!postId) throw new TypeError('getThread requires a postId');
    const id = String(postId).replace(/^t3_/, '');
    const url = subreddit
      ? `${BASE}/r/${encodeURIComponent(subreddit)}/comments/${id}/`
      : `${BASE}/comments/${id}/`;

    await this.#go(url);

    const data = await this.#read(`() => {
      const post = document.querySelector('shreddit-post');
      if (!post) return JSON.stringify({ error: 'no shreddit-post element' });
      const A = (el, n) => el.getAttribute(n);
      const num = (v) => (v === null || v === '' ? null : Number(v));
      const toEpoch = (s) => (s ? Math.floor(new Date(s).getTime() / 1000) : null);

      const bodyEl = post.querySelector('[slot="text-body"]');

      const comments = [...document.querySelectorAll('shreddit-comment')].map((c) => {
        const bodyNode = c.querySelector('[slot="comment"]');
        return {
          id: (A(c, 'thingid') || '').replace(/^t1_/, ''),
          fullname: A(c, 'thingid'),
          parentId: A(c, 'parentid') || A(c, 'postid'),
          depth: num(A(c, 'depth')) ?? 0,
          author: A(c, 'author') || '[deleted]',
          score: num(A(c, 'score')),
          created: A(c, 'created'),
          isOp: c.hasAttribute('is-op'),
          permalink: A(c, 'permalink'),
          body: bodyNode ? bodyNode.innerText.trim() : '',
          distinguished: /moderator/i.test(A(c, 'arialabel') || '') ? 'moderator' : null
        };
      });

      // "N more replies" / collapsed-branch affordances = branches not in the DOM.
      const moreCount = [...document.querySelectorAll('faceplate-partial, button, a')]
        .map((e) => (e.innerText || '').match(/(\\d+)\\s+more\\s+repl/i))
        .filter(Boolean)
        .reduce((sum, m) => sum + Number(m[1]), 0);

      return JSON.stringify({
        post: {
          id: (A(post, 'id') || '').replace(/^t3_/, ''),
          fullname: A(post, 'id'),
          subreddit: A(post, 'subreddit-name'),
          title: A(post, 'post-title') || '',
          selftext: bodyEl ? bodyEl.innerText.trim() : '',
          author: A(post, 'author') || '[deleted]',
          created: A(post, 'created-timestamp'),
          score: num(A(post, 'score')),
          upvoteRatio: num(A(post, 'upvote-ratio')),
          numComments: num(A(post, 'comment-count')),
          permalink: A(post, 'permalink'),
          postType: A(post, 'post-type'),
          locked: post.hasAttribute('locked'),
          moderationVerdict: A(post, 'moderation-verdict') || null
        },
        comments,
        moreCount,
        domCommentCount: comments.length
      });
    }`);

    if (!data || data.error) {
      throw new RedditDomError(
        `Could not parse thread ${id}: ${data?.error ?? 'no data'}. Reddit's markup may have changed.`,
        { selector: 'shreddit-post', url },
      );
    }

    const toEpoch = (s) => (s ? Math.floor(new Date(s).getTime() / 1000) : null);
    const p = data.post;

    const post = {
      id: p.id || id,
      fullname: p.fullname ?? `t3_${id}`,
      subreddit: p.subreddit,
      title: p.title,
      selftext: p.selftext,
      author: p.author,
      createdUtc: toEpoch(p.created),
      score: p.score,
      upvoteRatio: p.upvoteRatio,
      numComments: p.numComments,
      permalink: p.permalink ? `${BASE}${p.permalink}` : url,
      url: p.permalink ? `${BASE}${p.permalink}` : url,
      isSelf: p.postType === 'text',
      linkFlair: null,
      over18: false,
      locked: Boolean(p.locked),
      archived: false,
      stickied: false,
      removedByCategory: p.moderationVerdict || null,
      _source: 'browser',
    };

    return { post, comments: rebuildTree(data.comments, post.fullname, data.moreCount) };
  }

  /**
   * Subreddit rules. The web UI renders these in the sidebar; structure is less stable
   * than the API's /about/rules, so an empty result here means "could not read them",
   * NOT "this subreddit has no rules" — callers must treat it as unknown and flag for
   * manual review.
   */
  async getSubredditRules(subreddit) {
    const url = `${BASE}/r/${encodeURIComponent(subreddit)}/about/rules/`;
    await this.#go(url);

    const data = await this.#read(`() => {
      const out = [];
      for (const d of document.querySelectorAll('details')) {
        const sum = d.querySelector('summary');
        if (!sum) continue;
        const name = sum.innerText.replace(/^\\s*\\d+[.)]?\\s*/, '').trim();
        const rest = d.innerText.slice(sum.innerText.length).trim();
        if (name) out.push({ shortName: name, description: rest });
      }
      return JSON.stringify({ rules: out, found: out.length });
    }`);

    const rules = (data?.rules ?? []).map((r, i) => ({
      index: i + 1,
      shortName: r.shortName,
      description: r.description,
      kind: null, // the web UI does not expose rule scope (all/link/comment)
      violationReason: null,
    }));

    if (rules.length === 0) {
      this.logger.warn?.(
        `[browser] Could not read rules for r/${subreddit}. Treat rules as UNKNOWN and ` +
          'flag the thread for manual review rather than assuming none exist.',
      );
    }
    return { rules, siteRulesFlow: null, _incomplete: rules.length === 0 };
  }

  async getSubredditAbout(subreddit) {
    const url = `${BASE}/r/${encodeURIComponent(subreddit)}/`;
    await this.#go(url);
    const data = await this.#read(`() => {
      const sub = document.querySelector('shreddit-subreddit-header');
      const A = (n) => sub && sub.getAttribute(n);
      return JSON.stringify({
        name: A('display-name'),
        subscribers: A('subscribers') ? Number(A('subscribers')) : null,
        description: (document.querySelector('[data-testid="no-edit-description-block"]')?.innerText || '').trim()
      });
    }`);
    return {
      name: data?.name ?? subreddit,
      title: null,
      publicDescription: data?.description ?? '',
      description: data?.description ?? '',
      subscribers: data?.subscribers ?? null,
      over18: false,
      subredditType: null,
      submissionType: null,
      quarantine: false,
      _source: 'browser',
    };
  }

  /** Not supported without the API. Style import accepts a pasted export instead. */
  async getUserComments() {
    this.logger.warn?.(
      '[browser] getUserComments is not implemented in browser mode. Paste an export for section 8 style analysis.',
    );
    return { comments: [], after: null, _unsupported: true };
  }
}

/**
 * Rebuild the nested tree from the flat DOM list using parentid.
 * The DOM gives us a flat sequence plus depth/parentid, whereas the API gives nesting —
 * so we reconstruct it here to keep the adapter's output shape identical.
 */
export function rebuildTree(flat, postFullname, moreCount = 0) {
  const byId = new Map();
  const nodes = flat
    .filter((c) => c.id)
    .map((c) => ({
      id: c.id,
      fullname: c.fullname,
      parentId: c.parentId,
      linkId: postFullname,
      subreddit: null,
      author: c.author,
      body: c.body,
      createdUtc: c.created ? Math.floor(new Date(c.created).getTime() / 1000) : null,
      score: c.score ?? 0,
      isSubmitter: Boolean(c.isOp),
      stickied: false,
      distinguished: c.distinguished,
      depth: c.depth ?? 0,
      permalink: c.permalink ? `${BASE}${c.permalink}` : null,
      replies: [],
    }));

  for (const n of nodes) byId.set(n.fullname, n);

  const roots = [];
  for (const n of nodes) {
    const parent = n.parentId && byId.get(n.parentId);
    if (parent && parent !== n) parent.replies.push(n);
    else roots.push(n);
  }

  if (moreCount > 0) roots.push({ kind: 'more', count: moreCount, childIds: [] });
  return roots;
}
