/**
 * Default scoring weights.
 *
 * These are tuned from real sweeps in a B2B SaaS niche (freight software) and are a
 * reasonable starting point for any "find people evaluating tools" use case. Override
 * any subset via `config.weights`.
 *
 * Two of these are negative on purpose:
 *
 * - `noSoftwareContext` (-20): a post that matches your domain but mentions no tooling
 *   is usually about the JOB, not about software. Removing this penalty was the single
 *   biggest source of false positives in testing.
 *
 * - `venting` (-35): rants outrank buying questions on engagement, so without a heavy
 *   penalty the ranking inverts. A complaint about a coworker is not a lead, and
 *   replying to one with a product mention reads as tone-deaf.
 */
export const DEFAULT_WEIGHTS = {
  /** Unambiguous domain vocabulary appears in the text. */
  domainVocabulary: 30,
  /** A search query matched, and it wasn't an ambiguous one. */
  queryMatch: 20,
  /** Only an ambiguous term matched, but the subreddit supplies the domain context. */
  ambiguousInDomainSub: 25,
  /** Posted in one of the configured subreddits. */
  configuredSubreddit: 20,
  /** Newer than 7 days. */
  recent: 15,
  /** Newer than 30 days. */
  withinMonth: 8,
  /** Title reads as a question. */
  question: 15,
  /** Evaluating/comparing tools, or discussing cost. */
  intent: 10,
  /** Mentions one of your product's capability areas. */
  featureMatch: 10,
  /** Describes an operational pain point. */
  pain: 5,
  /** Mentions software/tooling at all. */
  softwareContext: 10,
  /** PENALTY: no tooling signal — likely about the job, not the tools. */
  noSoftwareContext: -20,
  /** PENALTY: reads as venting/storytelling rather than a question. */
  venting: -35,
};
