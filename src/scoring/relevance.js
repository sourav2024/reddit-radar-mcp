/**
 * Deterministic relevance pre-filter.
 *
 * Purpose: cheaply discard obviously irrelevant posts so an LLM call is never spent on
 * them. This is a gate, not a judgment — semantic scoring is the model's job downstream.
 *
 * Scores threads, never people. Reddit's Responsible Builder Policy forbids deriving or
 * inferring characteristics about users, so nothing here profiles an author.
 *
 * Everything domain-specific arrives via config. The scoring SHAPE is the reusable part:
 * which signals exist, how they interact, and — most importantly — the anchor rule that
 * stops shape-only signals from carrying an off-topic post.
 */

import { DEFAULT_WEIGHTS } from './weights.js';

const norm = (s) => (s ?? '').toLowerCase();

/**
 * Word-boundary term matching with optional inflection.
 *
 * Terms of `inflectMinLength`+ chars also match a short inflection (s/es/ing), because
 * real Reddit titles are not lemmatized. Observed in production: "Tracking softwares"
 * and "planning multi-stop loads" both scored 15/100 and were filtered purely because
 * "softwares" did not match "software". Short terms are excluded from inflection to
 * avoid new false positives — you do not want "app" matching "apps" if "app" is already
 * a bare acronym in your domain.
 */
export function countMatches(haystack, terms, { inflectMinLength = 5 } = {}) {
  const hits = [];
  for (const term of terms) {
    const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = String(term).length >= inflectMinLength
      ? new RegExp(`(?:^|[^a-z0-9])${escaped}(?:s|es|ing)?(?:[^a-z0-9]|$)`, 'i')
      : new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i');
    if (re.test(haystack)) hits.push(term);
  }
  return hits;
}

const toRegexes = (patterns = []) =>
  patterns.map((p) => (p instanceof RegExp ? p : new RegExp(p, 'i')));

/**
 * Signals that someone is evaluating tooling rather than chatting. These are about the
 * SHAPE of a post and are genuinely domain-independent, so they ship as defaults.
 * Override via `config.intentPatterns` if your niche phrases things differently.
 */
export const DEFAULT_INTENT_PATTERNS = [
  /\b(?:looking for|searching for|need|recommend|recommendations?|suggestions?)\b/i,
  /\b(?:anyone (?:using|tried|know)|has anyone)\b/i,
  /\b(?:alternatives? to|instead of|switching (?:from|to)|migrating (?:from|to))\b/i,
  /\b(?:worth it|any good|thoughts on|experience with|reviews? of)\b/i,
  /\b(?:vs\.?|versus|compared to|comparison)\b/i,
  /\bhow (?:do|does|are) (?:you|other|small|people)\b/i,
];

export const DEFAULT_PAIN_PATTERNS = [
  /\b(?:manual|spreadsheet|excel|by hand|copy.?past)/i,
  /\b(?:falling apart|nightmare|painful|frustrat|struggling|broken|a mess|tedious)/i,
  /\b(?:wasting|takes (?:us )?(?:\d+|three|four|five|all) (?:hours|days)|too (?:long|slow))/i,
  /\b(?:can't|cannot|unable to|no way to)\b/i,
];

export const DEFAULT_COMMERCIAL_PATTERNS = [
  /\b(?:pricing|price|cost|quote|budget|per seat|monthly|expensive|affordable|demo|trial)\b/i,
];

export const DEFAULT_QUESTION_PATTERNS = [
  /\?/,
  /^\s*(?:what|which|how|who|where|when|why|is|are|does|do|can|should|any)\b/i,
];

/**
 * Venting / storytelling, not a buying question.
 *
 * Observed in production: r/Truckers "Don't we just love dispatch?" scored 100/100 — a
 * driver complaining about a *person*, where pitching software would be tone-deaf and
 * downvoted. The real buying question scored lower. The ranking was inverted, so venting
 * is penalized hard. The generic half of those patterns ships here; add domain ones via
 * `config.ventingPatterns`.
 */
export const DEFAULT_VENTING_PATTERNS = [
  /\b(?:am i|was i) (?:the )?(?:wrong|asshole|crazy)\b/i,
  /\bthis sub is full of complaining|have to join in|\brant\b|vent(?:ing)?\b/i,
  /\bfired\b|\bquit\b|\bwalked off\b/i,
  /\b(?:gotta love|don'?t we (?:just )?love)\b/i,
];

/**
 * Generic software-shopping vocabulary. A post mentioning your domain but none of these
 * is usually about the JOB, not about tooling — no opening for a software vendor.
 */
export const DEFAULT_SOFTWARE_TERMS = [
  'software', 'system', 'platform', 'app', 'tool', 'tools', 'saas', 'spreadsheet',
  'excel', 'subscription', 'integration', 'automate', 'automation', 'crm', 'erp',
  'stack', 'vendor', 'demo', 'dashboard', 'tracking', 'portal', 'api', 'plugin', 'sync',
];

/**
 * Score a post for relevance to the configured domain.
 *
 * @param {object} post           normalized post {title, selftext, subreddit, createdUtc, ...}
 * @param {object} config         the radar config (see schema/config.schema.json)
 * @param {object} [opts]
 * @param {string[]} [opts.matchedQueries] queries that surfaced this post
 * @param {number}   [opts.now]            epoch seconds, for deterministic tests
 * @param {number}   [opts.threshold]      overrides config.threshold
 * @returns {{score:number, passed:boolean, blockers:string[], signals:object, reasons:string[]}}
 */
export function scoreRelevance(post, config = {}, opts = {}) {
  const {
    domainTerms = [],
    ambiguousTerms = [],
    featureTerms = [],
    softwareTerms = DEFAULT_SOFTWARE_TERMS,
    subreddits = [],
    weights: weightOverrides = {},
    inflectMinLength = 5,
  } = config;

  const W = { ...DEFAULT_WEIGHTS, ...weightOverrides };

  const intentPatterns = config.intentPatterns
    ? toRegexes(config.intentPatterns) : DEFAULT_INTENT_PATTERNS;
  const painPatterns = config.painPatterns
    ? toRegexes(config.painPatterns) : DEFAULT_PAIN_PATTERNS;
  const commercialPatterns = config.commercialPatterns
    ? toRegexes(config.commercialPatterns) : DEFAULT_COMMERCIAL_PATTERNS;
  const questionPatterns = config.questionPatterns
    ? toRegexes(config.questionPatterns) : DEFAULT_QUESTION_PATTERNS;
  const ventingPatterns = config.ventingPatterns
    ? [...DEFAULT_VENTING_PATTERNS, ...toRegexes(config.ventingPatterns)]
    : DEFAULT_VENTING_PATTERNS;

  const {
    matchedQueries = [],
    now = Math.floor(Date.now() / 1000),
    threshold = config.threshold ?? 40,
  } = opts;

  const ambiguous = new Set(ambiguousTerms.map(norm));
  const text = norm(`${post.title ?? ''} ${post.selftext ?? ''}`);
  const mopts = { inflectMinLength };
  const reasons = [];
  let score = 0;

  // --- Keyword match -------------------------------------------------------
  const domainHits = countMatches(text, domainTerms, mopts);
  const queryHits = matchedQueries.filter((q) => text.includes(norm(q)));
  const ambiguousOnly = queryHits.length > 0 && queryHits.every((q) => ambiguous.has(norm(q)));
  const inConfiguredSub = subreddits.some((s) => norm(s) === norm(post.subreddit));

  if (domainHits.length > 0) {
    score += W.domainVocabulary;
    reasons.push(`domain vocabulary: ${domainHits.slice(0, 4).join(', ')}`);
  } else if (queryHits.length > 0 && !ambiguousOnly) {
    score += W.queryMatch;
    reasons.push(`query terms matched: ${queryHits.join(', ')}`);
  } else if (ambiguousOnly) {
    /**
     * An ambiguous term with no other domain signal is usually a false positive: for a
     * freight tool, "POD" is a podcast episode and "detention" is school. BUT the
     * subreddit itself is domain context — an ambiguous term inside a configured
     * subreddit is on-topic even when a search row carries no body text to scan.
     * Penalizing that filtered out the single best thread found in production.
     */
    if (inConfiguredSub) {
      score += W.ambiguousInDomainSub;
      reasons.push(`ambiguous term "${queryHits.join(', ')}" in a configured subreddit — treated as on-topic`);
    } else {
      reasons.push(`only ambiguous term(s) matched with no domain context: ${queryHits.join(', ')} — likely false positive`);
    }
  }

  /**
   * THE ANCHOR RULE — the most important line in this file.
   *
   * A post is "anchored" only if something ties it to the domain: real domain
   * vocabulary, an unambiguous query term, or a configured subreddit. Without this
   * gate the context-free bonuses below (recency, question form, generic intent) sum
   * to 40+ on their own, which passes ANY recent Reddit question with zero topical
   * relevance. Those signals describe the SHAPE of a post, not its subject, so they
   * must never carry a post alone.
   */
  const anchored = domainHits.length > 0 || (queryHits.length > 0 && !ambiguousOnly) || inConfiguredSub;
  if (!anchored) {
    reasons.push('no domain anchor (no domain vocabulary, unambiguous keyword, or configured subreddit)');
  }

  // --- Configured subreddit ------------------------------------------------
  if (inConfiguredSub) {
    score += W.configuredSubreddit;
    reasons.push(`posted in configured subreddit r/${post.subreddit}`);
  }

  // --- Recency -------------------------------------------------------------
  const ageDays = post.createdUtc ? (now - post.createdUtc) / 86_400 : Infinity;
  if (anchored && ageDays <= 7) {
    score += W.recent;
    reasons.push(`recent (${ageDays.toFixed(1)}d old)`);
  } else if (anchored && ageDays <= 30) {
    score += W.withinMonth;
    reasons.push(`within a month (${ageDays.toFixed(0)}d old)`);
  } else if (Number.isFinite(ageDays) && ageDays > 30) {
    reasons.push(`stale (${ageDays.toFixed(0)}d old)`);
  }

  // --- Question form -------------------------------------------------------
  const isQuestion = questionPatterns.some((re) => re.test(post.title ?? ''));
  if (anchored && isQuestion) {
    score += W.question;
    reasons.push('title reads as a question');
  }

  // --- Intent / commercial -------------------------------------------------
  const intentHit = intentPatterns.some((re) => re.test(text));
  const commercialHit = commercialPatterns.some((re) => re.test(text));
  if (anchored && (intentHit || commercialHit)) {
    score += W.intent;
    reasons.push(intentHit ? 'evaluating/comparing tools' : 'discussing cost or pricing');
  }

  // --- Feature-area match --------------------------------------------------
  // Only count feature terms that aren't themselves the flagged ambiguous match,
  // otherwise an ambiguous false positive earns a second bonus on the same bad signal.
  const featureHits = countMatches(text, featureTerms, mopts)
    .filter((t) => anchored || !ambiguous.has(norm(t)));
  if (anchored && featureHits.length > 0) {
    score += W.featureMatch;
    reasons.push(`touches configured capability areas: ${featureHits.slice(0, 4).join(', ')}`);
  }

  // --- Pain signals --------------------------------------------------------
  const painHits = painPatterns.filter((re) => re.test(text)).length;
  if (anchored && painHits > 0) {
    score += W.pain;
    reasons.push('describes an operational pain point');
  }

  // --- Software/tooling context -------------------------------------------
  const softwareHits = countMatches(text, softwareTerms, mopts);
  if (softwareHits.length > 0) {
    score += W.softwareContext;
    reasons.push(`software/tooling context: ${softwareHits.slice(0, 3).join(', ')}`);
  } else {
    score += W.noSoftwareContext;
    reasons.push('no software/tooling signal — likely about the job, not about tools');
  }

  // --- Venting penalty -----------------------------------------------------
  const ventHits = ventingPatterns.filter((re) => re.test(text)).length;
  if (ventHits > 0) {
    score += W.venting;
    reasons.push(`reads as venting/storytelling (${ventHits} signal${ventHits > 1 ? 's' : ''}) — not a tool question`);
  }

  // --- Hard disqualifiers --------------------------------------------------
  const blockers = [];
  if (post.locked) blockers.push('thread is locked — cannot reply');
  if (post.archived) blockers.push('thread is archived — cannot reply');
  if (post.removedByCategory) blockers.push(`post was removed (${post.removedByCategory})`);
  if (post.over18) blockers.push('NSFW');

  const signals = {
    anchored,
    domainHits,
    queryHits,
    featureHits,
    inConfiguredSubreddit: inConfiguredSub,
    ageDays: Number.isFinite(ageDays) ? Number(ageDays.toFixed(2)) : null,
    isQuestion,
    hasIntent: intentHit,
    hasCommercialIntent: commercialHit,
    painSignals: painHits,
    softwareHits,
    ventingSignals: ventHits,
    engagement: { score: post.score ?? 0, comments: post.numComments ?? 0 },
  };

  return {
    score: Math.max(0, Math.min(score, 100)),
    passed: blockers.length === 0 && score >= threshold,
    blockers,
    signals,
    reasons,
  };
}
