/**
 * reddit-radar-mcp — public API.
 *
 * Find Reddit conversations where your product genuinely fits, reconstruct the thread,
 * and gate any draft reply against a claim boundary you define.
 *
 * There is no posting, voting, or account automation in this package, and a test asserts
 * there never will be. Drafts are for a human to review, edit, and post.
 */

// --- Discovery ---------------------------------------------------------------
export {
  planSweep,
  renderPlan,
  ingestSweep,
  renderSweep,
  resolveTier,
  modeGuidance,
  loadSearchConfig,
  SEARCH_EXTRACTOR,
  DEFAULT_MODE_GUIDANCE,
} from './reddit/sweep.js';

// --- Scoring -----------------------------------------------------------------
export {
  scoreRelevance,
  countMatches,
  DEFAULT_INTENT_PATTERNS,
  DEFAULT_PAIN_PATTERNS,
  DEFAULT_COMMERCIAL_PATTERNS,
  DEFAULT_QUESTION_PATTERNS,
  DEFAULT_VENTING_PATTERNS,
  DEFAULT_SOFTWARE_TERMS,
} from './scoring/relevance.js';
export { DEFAULT_WEIGHTS } from './scoring/weights.js';

// --- Thread reconstruction ---------------------------------------------------
export {
  buildThreadContext,
  renderContextForPrompt,
  flattenComments,
  scoreComment,
  detectProducts,
  loadCompetitorConfig,
} from './reddit/thread-context.js';

// --- Reddit adapters ---------------------------------------------------------
export { RedditApiClient, RedditAuthError } from './reddit/client.js';
export { BrowserRedditClient, RedditDomError } from './reddit/browser-client.js';
export { FixtureRedditClient, createRedditClient } from './reddit/fixture-client.js';

// --- Draft gate --------------------------------------------------------------
export {
  factCheck,
  renderFindings,
  SEVERITY,
  DEFAULT_DISCLOSURE_PATTERNS,
} from './gate/fact-check.js';
export { styleCheck, autoFix, renderStyle, STYLE } from './gate/style-check.js';
export { packs, composePacks } from './gate/packs.js';

// --- Config ------------------------------------------------------------------
export { defineConfig, validateConfig } from './config.js';
