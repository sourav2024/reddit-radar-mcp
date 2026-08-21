#!/usr/bin/env node
/**
 * reddit-radar-mcp — MCP server.
 *
 * Exposes Reddit discovery, thread reconstruction, and a draft gate as MCP tools, so the
 * whole workflow runs inside an agent session instead of a separate CLI.
 *
 * DESIGN DECISION worth understanding before changing anything here:
 *
 * The claim gate and quality gate run INSIDE this server, not as advice to the calling
 * model. If the model generated a draft and then chose whether to validate it, the gates
 * would be optional — and they exist precisely because a model writing promotional copy
 * is the least reliable judge of whether it overclaimed.
 *
 * So `check_draft` is the enforcement point and refuses to return a blocked draft, while
 * `analyze_thread` hands back context plus constraints rather than finished prose. The
 * model writes; the server decides whether that writing is allowed out.
 *
 * There is no posting tool. There will never be a posting tool, and test/safety.test.js
 * asserts it.
 *
 * Usage:
 *   RADAR_CONFIG=/path/to/radar.config.js npx reddit-radar-mcp
 *
 * Environment:
 *   RADAR_CONFIG       (required) path to your radar config, .js or .json
 *   RADAR_LOG_LEVEL    silent | error | warn | info (default) | debug
 *   RADAR_LOG_FORMAT   json (default) | text
 *   REDDIT_MODE        browser (default) | live | fixture
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildThreadContext, renderContextForPrompt } from './src/reddit/thread-context.js';
import { scoreRelevance } from './src/scoring/relevance.js';
import { factCheck, renderFindings } from './src/gate/fact-check.js';
import { styleCheck, renderStyle, autoFix } from './src/gate/style-check.js';
import { createRedditClient } from './src/reddit/fixture-client.js';
import { planSweep, renderPlan, ingestSweep, renderSweep, modeGuidance } from './src/reddit/sweep.js';
import { validateConfig } from './src/config.js';
import { log } from './src/logger.js';
import { version, SERVER_NAME } from './src/version.js';

const VERSION = version();

const ok = (text) => ({ content: [{ type: 'text', text }] });
const toolError = (message) => ({ content: [{ type: 'text', text: `❌ ${message}` }], isError: true });

const guard = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    return toolError(err?.message ?? String(err));
  }
};

// --- Config ------------------------------------------------------------------

/**
 * Load the user's config. Supports .js (ESM, default export) and .json.
 * Fails loudly at startup rather than serving a radar that silently matches nothing.
 */
async function loadConfig() {
  const p = process.env.RADAR_CONFIG;
  if (!p) {
    throw new Error(
      'RADAR_CONFIG is not set. Point it at your radar config:\n' +
        '  RADAR_CONFIG=/abs/path/radar.config.js npx reddit-radar-mcp\n' +
        'See examples/devtools.config.js for the shape.',
    );
  }
  const abs = path.resolve(p);
  let mod;
  try {
    mod = await import(
      pathToFileURL(abs).href,
      abs.endsWith('.json') ? { with: { type: 'json' } } : undefined
    );
  } catch (err) {
    const msg = String(err?.message ?? err);
    // The commonest real-world failure: a .js config in a project without
    // "type": "module", where Node parses it as CommonJS and the import throws.
    const hint = /outside a module|Unexpected token 'export'|Cannot use import statement/i.test(msg)
      ? '\nThis is an ESM/CommonJS mismatch. Either rename the file to ' +
        `${path.basename(abs, path.extname(abs))}.mjs, or add "type": "module" ` +
        'to the nearest package.json.'
      : '\nA .js config must be ESM with a default export; a .json config must be valid JSON.';
    throw new Error(`Could not load config from ${abs}: ${msg}${hint}`);
  }
  const config = mod.default ?? mod;

  const { valid, errors, warnings } = validateConfig(config);
  for (const w of warnings) log.warn('config warning', { detail: w });
  if (!valid) {
    throw new Error(`Invalid config at ${abs}:\n  - ${errors.join('\n  - ')}`);
  }
  log.debug('config loaded', {
    path: abs,
    product: config.product?.name,
    queries: config.queries?.length ?? 0,
    tiers: Object.keys(config.tiers ?? {}).length,
  });
  return config;
}

let config;
try {
  config = await loadConfig();
} catch (err) {
  // A config problem is the single most likely startup failure, and a raw stack trace
  // inside an MCP client's log is nearly unreadable. Fail with the fix, not the trace.
  process.stderr.write(`\n[radar] startup failed\n\n${err?.message ?? err}\n\n`);
  process.exit(1);
}
const PRODUCT = config.product?.name ?? 'the product';

const server = new McpServer({ name: SERVER_NAME, version: VERSION });

// --- Discovery ---------------------------------------------------------------

server.registerTool(
  'plan_sweep',
  {
    title: 'Plan a discovery sweep',
    description:
      'Returns the list of Reddit search URLs to load and the exact page-extraction ' +
      'function to run on each. Workflow: call this, navigate to each URL with your ' +
      'browser tool, run the returned extractor, then pass all results to ingest_sweep. ' +
      'Strategy "global" is one load per query (cheap, also finds threads in subreddits ' +
      'not on your list); "per-subreddit" is thorough but many times the loads.',
    inputSchema: {
      strategy: z.enum(['global', 'per-subreddit']).optional(),
      sort: z.enum(['relevance', 'new', 'top', 'comments']).optional(),
      time: z.enum(['day', 'week', 'month', 'year', 'all']).optional(),
      maxQueries: z.number().optional().describe('Cap the number of queries for a quick sweep'),
      tiers: z.array(z.string()).optional().describe('Which subreddit tiers a per-subreddit sweep covers'),
    },
  },
  guard(async (args) => ok(renderPlan(planSweep(config, args ?? {})))),
);

server.registerTool(
  'ingest_sweep',
  {
    title: 'Score and rank swept results',
    description:
      'Takes raw search rows collected during a sweep, deduplicates across queries, ' +
      'scores each post for relevance, and returns a ranked opportunity list with URLs. ' +
      'Posts surfaced by multiple queries score higher. Each result carries an ' +
      'engagement MODE from its subreddit tier and you must respect it: PROMOTE, ' +
      'PROMOTE_SOFT, CONTRIBUTE, or TECHNICAL_ONLY (do not pitch).',
    inputSchema: {
      batches: z.array(
        z.object({
          query: z.string().optional(),
          results: z.array(
            z.object({
              id: z.string(),
              subreddit: z.string(),
              title: z.string(),
              age: z.string().nullable().optional(),
              votes: z.string().nullable().optional(),
              comments: z.string().nullable().optional(),
              permalink: z.string().optional(),
            }),
          ),
        }),
      ),
      limit: z.number().optional(),
      threshold: z.number().optional(),
      seenIds: z.array(z.string()).optional(),
    },
  },
  guard(async ({ batches, limit = 15, threshold, seenIds = [] }) => {
    const result = ingestSweep(batches, config, { threshold, seenIds });
    return ok(renderSweep(result, { limit, config }));
  }),
);

server.registerTool(
  'score_thread',
  {
    title: 'Score one post',
    description:
      'Deterministic relevance score (0-100) for a single Reddit post, with the reasoning ' +
      'for every point awarded. Runs locally with no LLM call. Use to triage before ' +
      'spending effort on full analysis.',
    inputSchema: {
      title: z.string(),
      subreddit: z.string(),
      body: z.string().optional(),
      score: z.number().optional(),
      numComments: z.number().optional(),
      createdUtc: z.number().optional(),
      matchedQueries: z.array(z.string()).optional(),
    },
  },
  guard(async ({ title, subreddit, body = '', score, numComments, createdUtc, matchedQueries = [] }) => {
    const r = scoreRelevance(
      { title, subreddit, selftext: body, score, numComments, createdUtc },
      config,
      { matchedQueries },
    );
    const guidance = modeGuidance(config);
    const lines = [
      `SCORE: ${r.score}/100 — ${r.passed ? 'worth pursuing' : 'below threshold'}`,
      '',
      'Reasoning:',
      ...r.reasons.map((x) => `  · ${x}`),
    ];
    if (r.blockers.length) lines.push('', 'Blockers:', ...r.blockers.map((b) => `  ✖ ${b}`));
    if (!r.signals.anchored) {
      lines.push('', 'NOT ANCHORED: nothing ties this post to your domain. Likely a false positive.');
    }
    lines.push('', `Guidance if you engage: ${guidance.UNKNOWN}`);
    return ok(lines.join('\n'));
  }),
);

// --- Thread reconstruction ---------------------------------------------------

server.registerTool(
  'analyze_thread',
  {
    title: 'Reconstruct a thread',
    description:
      'Fetches a thread, reconstructs the conversation (prioritizing OP replies and ' +
      'moderator notes over upvote count), detects competing products, and returns the ' +
      'claim constraints needed to draft a reply. Call this BEFORE writing any draft. ' +
      'Returns context and rules, deliberately not a draft.',
    inputSchema: {
      url: z.string().describe('Reddit thread URL, or a bare post id'),
      maxComments: z.number().optional(),
    },
  },
  guard(async ({ url, maxComments = 12 }) => {
    const client = await createRedditClient(process.env);
    const id = String(url).match(/comments\/([a-z0-9]+)/i)?.[1] ?? String(url).replace(/^t3_/, '');
    const thread = await client.getThread({ postId: id });
    const ctx = buildThreadContext(thread, {
      maxComments,
      featureTerms: config.featureTerms ?? [],
      competitorNames: config.competitors ?? [],
    });
    return ok(
      renderContextForPrompt(ctx) +
        '\n\n' + '='.repeat(70) +
        `\nCLAIM CONSTRAINTS — binding on any draft about ${PRODUCT}\n` +
        '='.repeat(70) + '\n' +
        renderConstraints() +
        '\n\nNow write a draft, then call check_draft. Blocked drafts must not be shown.',
    );
  }),
);

server.registerTool(
  'parse_thread_html',
  {
    title: 'Reconstruct a thread from browser extraction',
    description:
      'For browser mode: navigate to a Reddit thread with your own browser tool, extract ' +
      'shreddit-post / shreddit-comment attributes, and pass them here to be reconstructed ' +
      'and analyzed. Use when the Reddit API is unavailable.',
    inputSchema: {
      post: z.object({
        id: z.string(),
        subreddit: z.string(),
        title: z.string(),
        author: z.string().optional(),
        selftext: z.string().optional(),
        score: z.number().nullable().optional(),
        numComments: z.number().nullable().optional(),
        createdTimestamp: z.string().optional(),
      }),
      comments: z.array(
        z.object({
          id: z.string(),
          body: z.string(),
          author: z.string().optional(),
          parentId: z.string().optional(),
          depth: z.number().optional(),
          score: z.number().nullable().optional(),
          created: z.string().optional(),
          isOp: z.boolean().optional(),
          distinguished: z.string().nullable().optional(),
        }),
      ),
      rules: z.array(z.object({ shortName: z.string(), description: z.string().optional() })).optional(),
      unfetchedCount: z.number().optional(),
    },
  },
  guard(async ({ post, comments, rules = [], unfetchedCount = 0 }) => {
    const thread = {
      post: {
        ...post,
        selftext: post.selftext ?? '',
        createdUtc: post.createdTimestamp ? Math.floor(Date.parse(post.createdTimestamp) / 1000) : null,
      },
      comments: comments.map((c) => ({
        ...c,
        createdUtc: c.created ? Math.floor(Date.parse(c.created) / 1000) : null,
      })),
      rules,
      unfetchedCount,
    };
    const ctx = buildThreadContext(thread, {
      featureTerms: config.featureTerms ?? [],
      competitorNames: config.competitors ?? [],
    });
    return ok(
      renderContextForPrompt(ctx) +
        '\n\n' + '='.repeat(70) +
        `\nCLAIM CONSTRAINTS — binding on any draft about ${PRODUCT}\n` +
        '='.repeat(70) + '\n' +
        renderConstraints() +
        '\n\nNow write a draft, then call check_draft. Blocked drafts must not be shown.',
    );
  }),
);

// --- The gate ----------------------------------------------------------------

server.registerTool(
  'check_draft',
  {
    title: 'Fact-check and quality gate',
    description:
      'Validates a draft against your claim boundary and the subreddit quality bar. ' +
      'Blocks fabricated claims and flags text that reads as low-effort filler. ' +
      'MANDATORY before showing any draft to the user. If it returns BLOCKED, revise and ' +
      'call again — do not present the draft.',
    inputSchema: {
      draft: z.string().describe('The full draft comment text'),
      applyAutoFix: z.boolean().optional().describe('Apply mechanical fixes and re-check. Default true.'),
    },
  },
  guard(async ({ draft, applyAutoFix = true }) => {
    const text = applyAutoFix ? autoFix(draft) : draft;
    const facts = factCheck(text, config.gate ?? {});
    const style = styleCheck(text, {
      anchorTerms: [...(config.domainTerms ?? []), ...(config.featureTerms ?? [])],
    });

    const blocked = !facts.allowed || style.fails > 0;
    const head = blocked
      ? '🛑 BLOCKED — revise before showing anyone'
      : '✅ APPROVED — safe to show the user';

    const body = [head, '', renderFindings(facts), '', renderStyle(style)];
    if (!blocked) body.push('', '--- APPROVED DRAFT ---', text);
    else body.push('', 'Revise and call check_draft again. Do NOT present this draft to the user.');

    return ok(body.join('\n'));
  }),
);

server.registerTool(
  'get_claim_boundary',
  {
    title: 'What may be claimed',
    description:
      'Returns the configured claim boundary: the product description, what must never ' +
      'be claimed, and the rules the gate enforces. The authoritative source for any ' +
      'statement about the product.',
    inputSchema: {},
  },
  guard(async () => ok(renderConstraints())),
);

function renderConstraints() {
  const gate = config.gate ?? {};
  const lines = [];

  if (config.product?.what) lines.push(`PRODUCT: ${PRODUCT} — ${config.product.what}`, '');
  if (config.product?.claims?.length) {
    lines.push('SAFE TO CLAIM:', ...config.product.claims.map((c) => `  ✓ ${c}`), '');
  }

  if (gate.unsupported?.length) {
    lines.push('NEVER CLAIM (absent from the knowledge base):');
    for (const u of gate.unsupported) lines.push(`  ✖ ${u.why}`);
    lines.push('');
  }

  if (gate.rules?.length) {
    lines.push('ENFORCED RULES:');
    for (const r of gate.rules) {
      lines.push(`  [${r.severity ?? 'BLOCK'}] ${r.id}: ${r.message}`);
    }
    lines.push('');
  }

  if (gate.requireDisclosure !== false && gate.productPattern) {
    lines.push(
      'DISCLOSURE REQUIRED: naming the product without disclosing affiliation is blocked.',
      '',
    );
  }

  lines.push(
    'Denials are always allowed. Saying "we do not support X" is honest and encouraged —',
    'conceding a real gap buys more credibility than any feature claim.',
  );

  return lines.join('\n');
}

// --- Start -------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
log.info('server ready', { name: SERVER_NAME, version: VERSION, product: PRODUCT });

/** Exit cleanly so an MCP client sees a closed stream rather than a hang. */
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log.info('shutting down', { signal: sig });
    process.exit(0);
  });
}

process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { reason: String(reason) });
});
