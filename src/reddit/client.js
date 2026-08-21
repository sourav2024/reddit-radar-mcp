/**
 * Reddit Data API client — app-only OAuth (client_credentials).
 *
 * Every detail here was verified live on 2026-08-20; see docs/REDDIT-API-FINDINGS.md.
 * Nothing in this file is guessed. If an endpoint or parameter isn't documented by
 * Reddit, it isn't here.
 *
 * Read-only by construction. There is no post/vote/reply method and there must never
 * be one (spec section 17, section 21).
 */

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';

/**
 * Reddit requires <platform>:<appid>:<version> (by /u/<username>).
 * Usernames may contain dots and underscores (e.g. production.notes404), so the
 * character class has to be wider than [\w-].
 */
const UA_PATTERN = /^[^:\s]+:[^:\s]+:\S+\s+\(by\s+\/u\/[\w.\-]+\)$/;

export class RedditAuthError extends Error {}
export class RedditRateLimitError extends Error {}
export class RedditApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * Token-bucket limiter. Reddit's documented ceiling is 100 QPM per client averaged over
 * a rolling 10 min window, but sustained-rate reports cluster nearer 60, so we default
 * to the conservative number rather than the advertised one.
 */
class RateLimiter {
  #timestamps = [];

  constructor({ perMinute = 60 } = {}) {
    this.perMinute = perMinute;
  }

  /** Server-reported headers win over our local guess when present. */
  observeHeaders(headers) {
    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (Number.isFinite(remaining) && Number.isFinite(reset)) {
      this.lastRemaining = remaining;
      this.lastReset = reset;
    }
  }

  async acquire(now = Date.now()) {
    const windowStart = now - 60_000;
    this.#timestamps = this.#timestamps.filter((t) => t > windowStart);

    if (this.#timestamps.length >= this.perMinute) {
      const waitMs = this.#timestamps[0] + 60_000 - now;
      if (waitMs > 0) await sleep(waitMs);
      return this.acquire(Date.now());
    }

    // Near-exhaustion per the server's own counter: wait out the window.
    if (this.lastRemaining !== undefined && this.lastRemaining <= 1 && this.lastReset > 0) {
      await sleep(this.lastReset * 1000);
      this.lastRemaining = undefined;
    }

    this.#timestamps.push(now);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RedditApiClient {
  #token = null;
  #tokenExpiresAt = 0;
  #inflightToken = null;

  constructor({ clientId, clientSecret, userAgent, perMinute = 60, fetchImpl = fetch } = {}) {
    if (!clientId || !clientSecret) {
      throw new RedditAuthError(
        'Missing REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET. Reddit API access requires ' +
          'approval under the Responsible Builder Policy — see docs/REDDIT-ACCESS.md. ' +
          'To work without credentials, set REDDIT_MODE=fixture.',
      );
    }
    if (!userAgent || !UA_PATTERN.test(userAgent)) {
      throw new RedditAuthError(
        `Invalid REDDIT_USER_AGENT: ${JSON.stringify(userAgent)}\n` +
          'Reddit requires: <platform>:<appid>:<version> (by /u/<username>)\n' +
          'e.g. macos:my-radar:v1.0.0 (by /u/your-reddit-username)',
      );
    }

    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.userAgent = userAgent;
    this.limiter = new RateLimiter({ perMinute });
    this.fetchImpl = fetchImpl;
  }

  /**
   * App-only tokens last ~1h and carry no refresh token, so we just re-request.
   * Concurrent callers share one in-flight request.
   */
  async #getToken() {
    if (this.#token && Date.now() < this.#tokenExpiresAt - 60_000) return this.#token;
    if (this.#inflightToken) return this.#inflightToken;

    this.#inflightToken = (async () => {
      const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      const res = await this.fetchImpl(TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': this.userAgent,
        },
        body: new URLSearchParams({ grant_type: 'client_credentials' }),
      });

      const text = await res.text();
      if (res.status === 401) {
        throw new RedditAuthError(
          'Reddit rejected the credentials (401). Confirm the client ID/secret and that ' +
            'the app has approved Data API access.',
        );
      }
      if (!res.ok) throw new RedditApiError(`Token request failed (${res.status})`, res.status, text);

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new RedditApiError('Token response was not JSON', res.status, text.slice(0, 200));
      }
      if (!json.access_token) {
        throw new RedditApiError('Token response had no access_token', res.status, json);
      }

      this.#token = json.access_token;
      this.#tokenExpiresAt = Date.now() + Number(json.expires_in ?? 3600) * 1000;
      return this.#token;
    })().finally(() => {
      this.#inflightToken = null;
    });

    return this.#inflightToken;
  }

  async #request(path, params = {}, { attempt = 0 } = {}) {
    await this.limiter.acquire();
    const token = await this.#getToken();

    const url = new URL(path, API_BASE);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    // raw_json=1 stops Reddit HTML-escaping &, <, > in text fields.
    url.searchParams.set('raw_json', '1');

    const res = await this.fetchImpl(url, {
      headers: { Authorization: `bearer ${token}`, 'User-Agent': this.userAgent },
    });
    this.limiter.observeHeaders(res.headers);

    if (res.status === 401 && attempt === 0) {
      this.#token = null; // token may have expired early; retry once
      return this.#request(path, params, { attempt: 1 });
    }
    if (res.status === 429) {
      if (attempt >= 3) throw new RedditRateLimitError('Rate limited by Reddit after 3 retries');
      const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt * 5;
      await sleep(retryAfter * 1000);
      return this.#request(path, params, { attempt: attempt + 1 });
    }
    if (res.status === 403) {
      throw new RedditApiError(
        `403 Forbidden for ${url.pathname}. Either the app lacks approved access, or the ` +
          'subreddit is private/quarantined. Unauthenticated Reddit endpoints all return ' +
          '403 as of 2026-08-20 — see docs/REDDIT-API-FINDINGS.md.',
        403,
        null,
      );
    }
    if (res.status === 404) throw new RedditApiError(`Not found: ${url.pathname}`, 404, null);
    if (!res.ok) {
      throw new RedditApiError(`Reddit API ${res.status} for ${url.pathname}`, res.status, await res.text().catch(() => null));
    }

    // Guard the failure mode from our probes: a 190KB HTML interstitial where JSON
    // was expected. Without this check it parses as garbage far downstream.
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('json')) {
      throw new RedditApiError(
        `Expected JSON from ${url.pathname} but got "${contentType}". This usually means ` +
          'the request was not authenticated.',
        res.status,
        (await res.text().catch(() => '')).slice(0, 200),
      );
    }
    return res.json();
  }

  /**
   * Search posts. Verified params: q, sort, t, limit, after, restrict_sr, type,
   * include_over_18. `limit` is capped at 100 by Reddit.
   *
   * @param {object} opts
   * @param {string} opts.query
   * @param {string} [opts.subreddit] scopes to /r/{sub}/search with restrict_sr=1
   * @param {'relevance'|'hot'|'top'|'new'|'comments'} [opts.sort]
   * @param {'hour'|'day'|'week'|'month'|'year'|'all'} [opts.time]
   */
  async searchPosts({ query, subreddit, sort = 'relevance', time = 'month', limit = 25, after } = {}) {
    if (!query) throw new TypeError('searchPosts requires a query');
    const path = subreddit ? `/r/${encodeURIComponent(subreddit)}/search` : '/search';
    const json = await this.#request(path, {
      q: query,
      sort,
      t: time,
      limit: Math.min(limit, 100),
      after,
      type: 'link',
      restrict_sr: subreddit ? 1 : undefined,
      include_over_18: 'off',
    });
    return {
      posts: (json?.data?.children ?? []).filter((c) => c?.kind === 't3').map((c) => normalizePost(c.data)),
      after: json?.data?.after ?? null,
    };
  }

  /**
   * Full comment tree for a post. Reddit returns [postListing, commentListing].
   * `depth`/`limit` bound the tree; `sort=top` surfaces the substantive branches first,
   * which matters for section 4 (prioritize relevant comments over dumping the whole thread).
   */
  async getThread({ postId, subreddit, sort = 'top', depth = 6, limit = 200 } = {}) {
    if (!postId) throw new TypeError('getThread requires a postId');
    const id = String(postId).replace(/^t3_/, '');
    const path = subreddit ? `/r/${encodeURIComponent(subreddit)}/comments/${id}` : `/comments/${id}`;
    const json = await this.#request(path, { sort, depth, limit, threaded: true });

    if (!Array.isArray(json) || json.length < 2) {
      throw new RedditApiError('Unexpected comment-tree shape from Reddit', 200, json);
    }
    const postData = json[0]?.data?.children?.[0]?.data;
    if (!postData) throw new RedditApiError('Comment tree contained no post', 200, null);

    return {
      post: normalizePost(postData),
      comments: parseCommentForest(json[1]?.data?.children ?? []),
    };
  }

  /** Subreddit metadata (/r/{sub}/about) — description, subscriber count, type. */
  async getSubredditAbout(subreddit) {
    const json = await this.#request(`/r/${encodeURIComponent(subreddit)}/about`);
    const d = json?.data ?? {};
    return {
      name: d.display_name ?? subreddit,
      title: d.title ?? null,
      publicDescription: d.public_description ?? '',
      description: d.description ?? '', // sidebar markdown; often holds the real rules
      subscribers: d.subscribers ?? null,
      over18: Boolean(d.over18),
      subredditType: d.subreddit_type ?? null,
      submissionType: d.submission_type ?? null,
      quarantine: Boolean(d.quarantine),
    };
  }

  /** Structured rules (/r/{sub}/about/rules) — the basis for section 5 rule analysis. */
  async getSubredditRules(subreddit) {
    const json = await this.#request(`/r/${encodeURIComponent(subreddit)}/about/rules`);
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

  /**
   * A user's recent comments, for section 8 writing-style analysis.
   * Public listing, so app-only auth should suffice — unverified without credentials,
   * hence the explicit note. The style importer also accepts a local export.
   */
  async getUserComments({ username, limit = 100, after, sort = 'new' } = {}) {
    if (!username) throw new TypeError('getUserComments requires a username');
    const json = await this.#request(`/user/${encodeURIComponent(username)}/comments`, {
      limit: Math.min(limit, 100),
      after,
      sort,
    });
    return {
      comments: (json?.data?.children ?? [])
        .filter((c) => c?.kind === 't1')
        .map((c) => normalizeComment(c.data)),
      after: json?.data?.after ?? null,
    };
  }
}

// ---------------------------------------------------------------------------
// Normalizers — keep Reddit's wire shape from leaking past the adapter.
// ---------------------------------------------------------------------------

export function normalizePost(d = {}) {
  return {
    id: d.id,
    fullname: d.name ?? (d.id ? `t3_${d.id}` : null),
    subreddit: d.subreddit,
    title: d.title ?? '',
    selftext: d.selftext ?? '',
    author: d.author ?? '[deleted]',
    createdUtc: d.created_utc ?? null,
    score: d.score ?? 0,
    upvoteRatio: d.upvote_ratio ?? null,
    numComments: d.num_comments ?? 0,
    permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : null,
    url: d.url ?? null,
    isSelf: Boolean(d.is_self),
    linkFlair: d.link_flair_text ?? null,
    over18: Boolean(d.over_18),
    locked: Boolean(d.locked),
    archived: Boolean(d.archived),
    stickied: Boolean(d.stickied),
    removedByCategory: d.removed_by_category ?? null,
  };
}

export function normalizeComment(d = {}) {
  return {
    id: d.id,
    fullname: d.name ?? (d.id ? `t1_${d.id}` : null),
    parentId: d.parent_id ?? null,
    linkId: d.link_id ?? null,
    subreddit: d.subreddit,
    author: d.author ?? '[deleted]',
    body: d.body ?? '',
    createdUtc: d.created_utc ?? null,
    score: d.score ?? 0,
    isSubmitter: Boolean(d.is_submitter), // marks OP replies
    stickied: Boolean(d.stickied),
    distinguished: d.distinguished ?? null, // 'moderator' => often the rules comment
    depth: d.depth ?? 0,
    permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : null,
    replies: [],
  };
}

/**
 * Walks Reddit's nested comment listing into a clean tree.
 * `more` stubs are recorded rather than silently dropped, so callers can tell the
 * difference between "no replies" and "replies not fetched".
 */
export function parseCommentForest(children = []) {
  const out = [];
  for (const child of children) {
    if (child?.kind === 'more') {
      out.push({
        kind: 'more',
        count: child.data?.count ?? 0,
        childIds: child.data?.children ?? [],
      });
      continue;
    }
    if (child?.kind !== 't1' || !child.data) continue;
    const comment = normalizeComment(child.data);
    const replies = child.data.replies;
    if (replies && typeof replies === 'object' && replies.data?.children) {
      comment.replies = parseCommentForest(replies.data.children);
    }
    out.push(comment);
  }
  return out;
}
