/**
 * Thread context reconstruction.
 *
 * The critical rule from the spec: never generate a contribution from the original post
 * alone. This module flattens a comment tree, ranks branches by how much they actually
 * inform a reply, and renders a compact context block for Claude.
 *
 * "Compact" matters — large threads must be prioritized, not dumped, or we pay for
 * tokens on noise and bury the signal.
 */

import { readFile } from 'node:fs/promises';

/** Flatten the tree, preserving depth, ancestry, and unfetched-branch stubs. */
export function flattenComments(forest, parentPath = []) {
  const out = [];
  let unfetched = 0;

  for (const node of forest) {
    if (node.kind === 'more') {
      unfetched += node.count ?? 0;
      continue;
    }
    const path = [...parentPath, node.id];
    out.push({ ...node, path, replies: undefined, replyCount: node.replies?.length ?? 0 });
    if (node.replies?.length) {
      const child = flattenComments(node.replies, path);
      out.push(...child.comments);
      unfetched += child.unfetched;
    }
  }
  return { comments: out, unfetched };
}

/**
 * Rank a comment by how much it would inform a useful reply.
 * Deliberately favours OP clarifications and substantive experience over jokes and
 * one-liners, regardless of upvotes.
 */
export function scoreComment(comment, { competitorNames = [], featureTerms = [] } = {}) {
  const body = comment.body ?? '';
  const lower = body.toLowerCase();
  let score = 0;
  const tags = [];

  if (comment.isSubmitter) {
    score += 40; // OP replies carry the real requirements
    tags.push('op-reply');
  }
  if (comment.distinguished === 'moderator') {
    score += 25;
    tags.push('moderator'); // often states the rules we must respect
  }

  const mentioned = competitorNames.filter((n) => lower.includes(n.toLowerCase()));
  if (mentioned.length) {
    score += 20;
    tags.push('product-mention');
  }

  const features = featureTerms.filter((t) => lower.includes(t.toLowerCase()));
  if (features.length) {
    score += 12;
    tags.push('feature-discussion');
  }

  // Length as a proxy for substance, with diminishing returns and a floor penalty.
  const words = body.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 40) score += 15;
  else if (words >= 15) score += 8;
  else score -= 10; // "this" / "+1" / "lol"
  tags.push(`${words}w`);

  // Upvotes matter but must not dominate — a +200 joke is still a joke.
  score += Math.min(Math.max(comment.score ?? 0, 0) / 4, 15);

  if (/\?/.test(body)) {
    score += 6;
    tags.push('asks-question');
  }
  if (comment.author === '[deleted]' || body === '[removed]' || body === '[deleted]') {
    score -= 50;
    tags.push('deleted');
  }
  if (comment.stickied && comment.distinguished !== 'moderator') score -= 5;

  return { score: Math.round(score), tags, mentioned, features };
}

/** Detect products from config/competitors.json, with the category that matched. */
export function detectProducts(text, competitorConfig) {
  const lower = (text ?? '').toLowerCase();
  const found = [];
  for (const [category, names] of Object.entries(competitorConfig?.categories ?? {})) {
    for (const name of names) {
      const re = new RegExp(`(?:^|[^a-z0-9])${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^a-z0-9]|$)`, 'i');
      if (re.test(lower)) found.push({ name, category });
    }
  }
  // De-dupe, preferring the longest match ("TriumphPay" over "Triumph").
  const byLower = new Map();
  for (const f of found.sort((a, b) => b.name.length - a.name.length)) {
    const collides = [...byLower.keys()].some((k) => k.includes(f.name.toLowerCase()));
    if (!collides) byLower.set(f.name.toLowerCase(), f);
  }
  return [...byLower.values()];
}

export async function loadCompetitorConfig(path = process.env.RADAR_COMPETITORS) {
  if (!path) {
    throw new Error(
      'No competitor config path given. Pass one explicitly or set RADAR_COMPETITORS. ' +
        'Competitor detection is optional — buildThreadContext works without it.',
    );
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * Build the prioritized context object for a thread.
 *
 * @param {{post:object, comments:object[]}} thread from the Reddit adapter
 * @param {object} opts
 * @param {object} [opts.competitorConfig]
 * @param {object} [opts.subredditRules] from getSubredditRules()
 * @param {object} [opts.subredditAbout] from getSubredditAbout()
 * @param {number} [opts.maxComments] how many ranked comments to keep
 */
export function buildThreadContext(thread, opts = {}) {
  const { competitorConfig = { categories: {} }, subredditRules, subredditAbout, maxComments = 12 } = opts;
  const { post, comments: forest } = thread;

  const competitorNames = Object.values(competitorConfig.categories ?? {}).flat();
  const featureTerms = ['settlement', 'settlements', 'invoice', 'detention', 'accessorial', 'carrier onboarding', 'pod', 'proof of delivery', 'tracking', 'pricing', 'dispatch', 'factoring'];

  const { comments: flat, unfetched } = flattenComments(forest);

  const ranked = flat
    .map((c) => ({ comment: c, ...scoreComment(c, { competitorNames, featureTerms }) }))
    .sort((a, b) => b.score - a.score);

  const selected = ranked.slice(0, maxComments);

  // Always keep OP replies and moderator notes, even if they ranked below the cut —
  // they define the requirements and the rules.
  const mustKeep = ranked.filter(
    (r) => (r.comment.isSubmitter || r.comment.distinguished === 'moderator') && !selected.includes(r),
  );
  const chosen = [...selected, ...mustKeep];

  const allText = [post.title, post.selftext, ...flat.map((c) => c.body)].join('\n');
  const products = detectProducts(allText, competitorConfig);

  return {
    subreddit: post.subreddit,
    post,
    stats: {
      totalCommentsFetched: flat.length,
      commentsNotFetched: unfetched,
      commentsIncluded: chosen.length,
      reportedCommentCount: post.numComments,
    },
    opReplies: flat.filter((c) => c.isSubmitter && c.id !== post.id),
    moderatorComments: flat.filter((c) => c.distinguished === 'moderator'),
    importantComments: chosen.map((r) => ({ ...r.comment, _rank: r.score, _tags: r.tags })),
    productsMentioned: products,
    subredditRules: subredditRules?.rules ?? [],
    subredditAbout: subredditAbout ?? null,
  };
}

/** Render the compact text block described in section 4, for the Claude prompt. */
export function renderContextForPrompt(ctx) {
  const lines = [];
  const age = ctx.post.createdUtc
    ? `${((Date.now() / 1000 - ctx.post.createdUtc) / 86_400).toFixed(1)} days old`
    : 'unknown age';

  lines.push('SUBREDDIT', `r/${ctx.subreddit}`);
  if (ctx.subredditAbout?.subscribers) lines.push(`${ctx.subredditAbout.subscribers.toLocaleString()} subscribers`);
  lines.push('');

  lines.push('POST', `Title: ${ctx.post.title}`, `Author: u/${ctx.post.author}`);
  lines.push(`Score: ${ctx.post.score} | Comments: ${ctx.post.numComments} | ${age}`);
  if (ctx.post.linkFlair) lines.push(`Flair: ${ctx.post.linkFlair}`);
  lines.push('', ctx.post.selftext || '(no body text)', '');

  if (ctx.importantComments.length) {
    lines.push('IMPORTANT COMMENTS');
    for (const c of ctx.importantComments) {
      if (c.isSubmitter) continue; // rendered under OP REPLIES
      lines.push(
        `- u/${c.author} (${c.score} pts, depth ${c.depth}${c.distinguished ? `, ${c.distinguished}` : ''}):`,
      );
      lines.push(`  ${c.body.replace(/\n+/g, '\n  ')}`);
    }
    lines.push('');
  }

  if (ctx.opReplies.length) {
    lines.push('OP REPLIES (these define what OP actually needs)');
    for (const c of ctx.opReplies) lines.push(`- ${c.body.replace(/\n+/g, '\n  ')}`);
    lines.push('');
  }

  if (ctx.productsMentioned.length) {
    lines.push('PRODUCTS MENTIONED');
    for (const p of ctx.productsMentioned) lines.push(`- ${p.name} (${p.category})`);
    lines.push('');
  }

  if (ctx.subredditRules.length) {
    lines.push('SUBREDDIT RULES');
    for (const r of ctx.subredditRules) {
      lines.push(`${r.index}. ${r.shortName}${r.kind ? ` [applies to: ${r.kind}]` : ''}`);
      if (r.description) lines.push(`   ${r.description}`);
    }
    lines.push('');
  }

  lines.push('CONTEXT COMPLETENESS');
  lines.push(
    `Fetched ${ctx.stats.totalCommentsFetched} of ${ctx.stats.reportedCommentCount} reported comments; ` +
      `${ctx.stats.commentsNotFetched} not retrieved; ${ctx.stats.commentsIncluded} included above.`,
  );
  if (ctx.stats.commentsNotFetched > 0) {
    lines.push('Some branches were not retrieved — do not assume the thread has been fully read.');
  }

  return lines.join('\n');
}
