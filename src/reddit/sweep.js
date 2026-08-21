/**
 * Discovery sweep — "find me threads" instead of "here's a link".
 *
 * WHY IT'S SPLIT THE WAY IT IS:
 * The MCP server has no browser. Browsing lives in the calling agent's session
 * (Playwright). So the sweep can't fetch on its own; it works in two halves:
 *
 *   1. plan()          → server says which URLs to load and how to extract each page
 *   2. ingest()        → agent hands back the raw rows, server dedupes + scores + ranks
 *
 * That keeps the deterministic parts (planning, dedupe, scoring, ranking) server-side and
 * testable, while the agent does the only thing it uniquely can: drive a browser.
 *
 * CORRECTION TO AN EARLIER FINDING (verified live 2026-08-20): search result pages DO
 * carry age, votes, and comment counts — an earlier extractor was reading the wrong DOM
 * container and concluded they were absent. That matters a lot: the relevance gate can
 * score from search rows alone, so a sweep costs ~21 page loads instead of opening every
 * candidate thread. See docs/NO-API-TRADEOFFS.md.
 */

import { readFile } from 'node:fs/promises';
import { scoreRelevance } from '../scoring/relevance.js';

const BASE = 'https://www.reddit.com';

/**
 * Resolve which tier a subreddit belongs to, and therefore how we may engage there.
 *
 * This is the important part of tiering: it is NOT just a ranking boost. A thread in
 * r/PostgreSQL and a thread in r/FreightBrokers can score similarly on topic keywords
 * while warranting completely different comments. Without a mode attached, the sweep
 * would hand back "opportunities" in engineering subs that it would be a mistake to
 * pitch in — off-topic promo gets removed and damages the account.
 */
export function resolveTier(subreddit, config) {
  const name = String(subreddit ?? '').toLowerCase();
  for (const [tier, def] of Object.entries(config?.tiers ?? {})) {
    if ((def.subreddits ?? []).some((s) => s.toLowerCase() === name)) {
      return { tier, mode: def.mode, weight: def.weight ?? 0 };
    }
  }
  return { tier: 'untiered', mode: 'UNKNOWN', weight: 0 };
}

/**
 * One-line guidance shown next to each opportunity so the mode can't be missed.
 *
 * `{product}` is substituted from config.product.name. Override any entry via
 * `config.modeGuidance` when your niche needs different wording.
 */
export const DEFAULT_MODE_GUIDANCE = {
  PROMOTE: 'Name {product} and describe the capability that fits their problem. Disclose affiliation.',
  PROMOTE_SOFT: 'Answer the question first. Mention {product} only if they are asking for tooling.',
  CONTRIBUTE: 'Share operator insight. {product} only as context for who you are, not a recommendation.',
  TECHNICAL_ONLY: 'DO NOT PITCH. Technical discussion only — nobody here is shopping for this product.',
  UNKNOWN: 'Subreddit not tiered. Read its rules before engaging.',
};

/** Resolve mode guidance for a config, substituting the product name. */
export function modeGuidance(config = {}) {
  const name = config?.product?.name ?? 'your product';
  const merged = { ...DEFAULT_MODE_GUIDANCE, ...(config.modeGuidance ?? {}) };
  return Object.fromEntries(
    Object.entries(merged).map(([k, v]) => [k, String(v).replaceAll('{product}', name)]),
  );
}

/**
 * The page-side extraction function, as a string for the agent to run verbatim.
 *
 * Two subtleties worth preserving if you edit this:
 *  - <search-telemetry-tracker> elements NEST, so the same post appears several times.
 *    We keep the SMALLEST container that still carries metadata: the big outer one is the
 *    whole feed, the tiny inner one is just the title link.
 *  - A row without age or votes is a nav/tab element, not a result. Skip it.
 */
export const SEARCH_EXTRACTOR = `() => {
  const best = new Map();
  for (const tr of document.querySelectorAll('search-telemetry-tracker')) {
    const a = tr.querySelector('a[href*="/comments/"]');
    if (!a) continue;
    const href = a.getAttribute('href') || '';
    const m = href.match(/\\/r\\/([^/]+)\\/comments\\/([a-z0-9]+)/i);
    if (!m) continue;
    const t = (tr.innerText || '').replace(/\\s+/g, ' ').trim();
    const age = t.match(/·\\s*(\\d+)\\s*(mo|[hdmy])\\s+ago/i);
    const votes = t.match(/(\\d[\\d.,]*[kK]?)\\s*votes?/i);
    const comments = t.match(/(\\d[\\d.,]*[kK]?)\\s*comments?/i);
    if (!age && !votes) continue;
    const prev = best.get(m[2]);
    if (prev && prev._len <= t.length) continue;
    best.set(m[2], {
      id: m[2],
      subreddit: m[1],
      title: (a.innerText || '').trim(),
      age: age ? age[1] + age[2] : null,
      votes: votes ? votes[1] : null,
      comments: comments ? comments[1] : null,
      permalink: 'https://www.reddit.com' + href.split('?')[0],
      _len: t.length
    });
  }
  return JSON.stringify({
    results: [...best.values()].map(({ _len, ...r }) => r),
    loginWalled: /log in to continue|sign up to continue/i.test(document.body.innerText.slice(0, 600))
  });
}`;

/** "6h" / "3d" / "2mo" -> epoch seconds. */
export function ageToEpoch(age, now = Math.floor(Date.now() / 1000)) {
  if (!age) return null;
  const m = String(age).match(/^(\d+)\s*(mo|[hdmy])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const secs = { h: 3600, d: 86400, m: 60, mo: 2592000, y: 31536000 }[unit];
  return secs ? now - n * secs : null;
}

/** "1.2k" -> 1200 */
export function parseCount(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '');
  const m = s.match(/^([\d.]+)([kK])?$/);
  if (!m) return null;
  return Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
}

/**
 * Load a radar config from disk. There is no default path: a library should not guess
 * where your config lives. Pass an absolute path, or set RADAR_CONFIG in the environment.
 */
export async function loadSearchConfig(path = process.env.RADAR_CONFIG) {
  if (!path) {
    throw new Error(
      'No config path given. Pass one explicitly or set RADAR_CONFIG=/path/to/radar.config.json',
    );
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * Build the sweep plan: which URLs to load, in order.
 *
 * @param {object} config the radar config
 * @param {object} opts
 * @param {'global'|'per-subreddit'} [opts.strategy] global = 1 load per query (cheap,
 *   noisier, still finds threads in subs you didn't list); per-subreddit = queries ×
 *   subreddits (thorough, expensive).
 * @param {number} [opts.maxQueries] cap for a quick sweep
 * @param {'new'|'relevance'|'top'|'comments'} [opts.sort]
 * @param {'day'|'week'|'month'|'year'|'all'} [opts.time]
 */
export function planSweep(config, opts = {}) {
  const {
    strategy = 'global',
    maxQueries,
    sort = config?.defaults?.sort ?? 'relevance',
    time = config?.defaults?.time ?? 'month',
    delayMs = 4000,
  } = opts;

  const queries = (config?.queries ?? []).slice(0, maxQueries ?? undefined);

  // Which subreddits a per-subreddit sweep covers. Default to tier1+tier2 only:
  // tier3/tier4 are not places to go looking for buyers, so sweeping them by keyword
  // mostly generates noise you should not act on.
  const tierList = opts.tiers ?? ['tier1', 'tier2'];
  const subs = opts.subreddits
    ?? tierList.flatMap((t) => config?.tiers?.[t]?.subreddits ?? []);
  const steps = [];

  if (strategy === 'per-subreddit') {
    for (const q of queries) {
      for (const s of subs) {
        steps.push({
          query: q,
          subreddit: s,
          url:
            `${BASE}/r/${encodeURIComponent(s)}/search/?q=${encodeURIComponent(q)}` +
            `&restrict_sr=1&type=link&sort=${sort}&t=${time}`,
        });
      }
    }
  } else {
    for (const q of queries) {
      steps.push({
        query: q,
        subreddit: null,
        url: `${BASE}/search/?q=${encodeURIComponent(q)}&type=link&sort=${sort}&t=${time}`,
      });
    }
  }

  return {
    strategy,
    sort,
    time,
    tiers: tierList,
    subreddits: subs,
    steps,
    pageLoads: steps.length,
    estimatedMinutes: Number(((steps.length * delayMs) / 60000).toFixed(1)),
    delayMs,
    extractor: SEARCH_EXTRACTOR,
  };
}

/**
 * Human-readable sweep plan: the URLs to load and the extractor to run on each.
 *
 * planSweep() returns structured data; this renders it for an agent to act on. Keep them
 * separate so programmatic callers are not forced to parse prose.
 */
export function renderPlan(plan) {
  return [
    `SWEEP PLAN — ${plan.pageLoads} page load(s), roughly ${plan.estimatedMinutes} min at a polite pace`,
    `strategy: ${plan.strategy} | sort: ${plan.sort} | window: ${plan.time}` +
      (plan.strategy === 'per-subreddit' ? ` | tiers: ${plan.tiers.join(', ')}` : ''),
    '',
    'Load each URL in order. Pause a few seconds between them: this reads public pages',
    'at human pace on purpose, so do not parallelize it.',
    '',
    'URLS:',
    ...plan.steps.map((s, i) => `${String(i + 1).padStart(3)}. [${s.query}] ${s.url}`),
    '',
    'EXTRACTOR — run this verbatim on each loaded page:',
    '',
    plan.extractor,
    '',
    "Then call ingest_sweep with batches: [{ query, results }, ...] using each page's",
    'returned results array. ingest_sweep dedupes, scores, and ranks them.',
  ].join('\n');
}

/**
 * Dedupe, score, and rank raw search rows.
 *
 * @param {Array<{query?:string, results:Array}>} batches one entry per page loaded
 * @param {object} config
 * @param {object} [opts]
 * @param {number} [opts.threshold] minimum relevance score to keep (default 40)
 * @param {Set<string>|string[]} [opts.seenIds] already-processed IDs to skip
 */
export function ingestSweep(batches, config, opts = {}) {
  const { threshold = 40, seenIds = [], now = Math.floor(Date.now() / 1000) } = opts;
  const seen = new Set(seenIds instanceof Set ? [...seenIds] : seenIds);

  const byId = new Map();
  let rawRows = 0;

  for (const batch of batches ?? []) {
    for (const r of batch?.results ?? []) {
      rawRows++;
      if (!r?.id) continue;
      if (seen.has(r.id)) continue;

      const existing = byId.get(r.id);
      if (existing) {
        // Same post surfaced by another query: that's a relevance signal.
        if (batch.query && !existing.matchedQueries.includes(batch.query)) {
          existing.matchedQueries.push(batch.query);
        }
        continue;
      }

      byId.set(r.id, {
        id: r.id,
        subreddit: r.subreddit,
        ...resolveTier(r.subreddit, config),
        title: r.title ?? '',
        permalink: r.permalink ?? `${BASE}/r/${r.subreddit}/comments/${r.id}/`,
        createdUtc: ageToEpoch(r.age, now),
        ageLabel: r.age ?? null,
        score: parseCount(r.votes),
        numComments: parseCount(r.comments),
        matchedQueries: batch.query ? [batch.query] : [],
      });
    }
  }

  const scored = [...byId.values()].map((post) => {
    const base = scoreRelevance(
      {
        ...post,
        selftext: '', // not on results pages; full body comes at analyze time
        score: post.score ?? 0,
        numComments: post.numComments ?? 0,
        locked: false,
        archived: false,
        over18: false,
        removedByCategory: null,
      },
      config,
      {
        matchedQueries: post.matchedQueries,
        now,
        threshold,
      },
    );

    /**
     * Tier weight nudges ranking so a buyer sub outranks a technical sub on an
     * otherwise similar post. It deliberately cannot rescue a post the relevance gate
     * rejected — `passed` still comes from the topical score.
     */
    const relevance = {
      ...base,
      score: Math.min(100, base.score + post.weight),
      reasons: [...base.reasons, `${post.tier} subreddit (${post.mode}) +${post.weight}`],
    };
    return { ...post, relevance };
  });

  const kept = scored
    .filter((s) => s.relevance.passed)
    .sort((a, b) => b.relevance.score - a.relevance.score);
  const filtered = scored.filter((s) => !s.relevance.passed);

  return {
    stats: {
      rawRows,
      uniquePosts: byId.size,
      duplicatesCollapsed: rawRows - byId.size,
      alreadySeenSkipped: seen.size ? rawRows - byId.size : 0,
      kept: kept.length,
      filteredOut: filtered.length,
    },
    opportunities: kept,
    filtered,
  };
}

/** Human-readable sweep report — the "here are your links" output. */
export function renderSweep(result, { limit = 15, config = {} } = {}) {
  const { stats, opportunities, filtered } = result;
  const GUIDANCE = modeGuidance(config);
  const title = (config?.product?.name ? config.product.name.toUpperCase() + ' ' : '') + 'REDDIT RADAR — DISCOVERY SWEEP';
  const lines = [
    title,
    '',
    `Scanned ${stats.rawRows} result rows -> ${stats.uniquePosts} unique posts ` +
      `(${stats.duplicatesCollapsed} duplicates collapsed)`,
    `${stats.kept} opportunities, ${stats.filteredOut} filtered out as irrelevant`,
    '',
  ];

  if (!opportunities.length) {
    lines.push('No opportunities cleared the relevance threshold.');
    if (filtered.length) {
      lines.push('', 'Closest misses:');
      for (const f of filtered.slice(0, 5)) {
        lines.push(`  [${f.relevance.score}] r/${f.subreddit} — ${f.title.slice(0, 60)}`);
      }
    }
    return lines.join('\n');
  }

  lines.push('='.repeat(70), 'OPPORTUNITIES (highest score first)', '='.repeat(70), '');

  for (const o of opportunities.slice(0, limit)) {
    const meta = [
      o.ageLabel ? `${o.ageLabel} old` : null,
      o.score != null ? `${o.score} pts` : null,
      o.numComments != null ? `${o.numComments} comments` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    const modeTag = o.mode === 'TECHNICAL_ONLY' ? `⚠️ ${o.mode}` : o.mode;
    lines.push(`[${String(o.relevance.score).padStart(3)}] r/${o.subreddit} [${modeTag}] — ${o.title}`);
    if (meta) lines.push(`      ${meta}`);
    lines.push(`      ${o.permalink}`);
    if (o.matchedQueries.length) lines.push(`      found by: ${o.matchedQueries.join(', ')}`);
    lines.push(`      → ${GUIDANCE[o.mode] ?? GUIDANCE.UNKNOWN}`);
    for (const r of o.relevance.reasons.slice(0, 3)) lines.push(`      · ${r}`);
    lines.push('');
  }

  if (opportunities.length > limit) {
    lines.push(`(${opportunities.length - limit} more below the top ${limit})`, '');
  }

  lines.push(
    'Next: pick one and call analyze_thread with its URL to reconstruct the conversation',
    'and load the claim constraints, then write a draft and call check_draft.',
  );
  return lines.join('\n');
}
