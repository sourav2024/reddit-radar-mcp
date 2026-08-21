/**
 * Example config: a hypothetical CI/CD observability product.
 *
 * Shows the shape end to end. The parts that matter most are `domainTerms` (what anchors
 * a post to your world), `ambiguousTerms` (words that mean something else outside it),
 * and the tier modes (which decide HOW to engage, not just ranking).
 */

import { defineConfig, packs, composePacks } from 'reddit-radar-mcp';

export default defineConfig({
  product: {
    name: 'Acme',
    what: 'CI/CD pipeline observability — flaky test detection, build timing, failure triage.',
  },

  // Search terms. Keep them close to how people actually phrase problems.
  queries: [
    'flaky tests',
    'CI pipeline slow',
    'build times',
    'test flakiness',
    'CI observability',
    'pipeline monitoring',
    'GitHub Actions slow',
    'test suite slow',
  ],

  /**
   * Unambiguous vocabulary from your domain. One hit is a real signal.
   * REQUIRED — without this, every recent question on Reddit looks like an opportunity.
   */
  domainTerms: [
    'ci', 'cd', 'pipeline', 'build', 'test suite', 'flaky', 'github actions',
    'gitlab ci', 'jenkins', 'circleci', 'buildkite', 'runner', 'artifact',
    'deploy', 'regression', 'monorepo', 'test runner',
  ],

  /**
   * Terms that mean something else outside your niche. These only count when a second
   * domain signal is present, or when the post is in one of your configured subreddits.
   * "build" in r/homelab is a PC build; in r/devops it is a CI build.
   */
  ambiguousTerms: ['build', 'pipeline', 'runner', 'artifact'],

  /** Capability areas your product actually covers. Small bonus when they appear. */
  featureTerms: [
    'flaky test', 'test retry', 'build time', 'pipeline duration',
    'failure triage', 'test analytics', 'ci metrics',
  ],

  /**
   * Tiers set BEHAVIOUR, not just ranking. The same question warrants a different
   * comment depending on where it was asked.
   *
   *   PROMOTE        name the product, describe the fitting capability, disclose
   *   PROMOTE_SOFT   answer first; mention only if they are asking for tooling
   *   CONTRIBUTE     share insight; product only as context for who you are
   *   TECHNICAL_ONLY do NOT pitch; discussion only
   */
  tiers: {
    tier1: {
      mode: 'PROMOTE',
      weight: 20,
      subreddits: ['devops', 'continuousintegration', 'platform_engineering'],
    },
    tier2: {
      mode: 'PROMOTE_SOFT',
      weight: 15,
      subreddits: ['sre', 'kubernetes', 'docker'],
    },
    tier3: {
      mode: 'CONTRIBUTE',
      weight: 8,
      subreddits: ['ExperiencedDevs', 'softwarearchitecture'],
    },
    tier4: {
      mode: 'TECHNICAL_ONLY',
      weight: 3,
      subreddits: ['programming', 'javascript', 'golang', 'rust'],
    },
  },

  defaults: { sort: 'relevance', time: 'month', limit: 25 },
  threshold: 40,

  /**
   * The claim gate. Start from the packs, then add rules for your own boundary.
   * These run BEFORE any draft is shown, and a BLOCK withholds the draft entirely.
   */
  gate: {
    ...composePacks(
      packs.noPricing,
      packs.noFabricatedMetrics,
      packs.noCustomerNames,
      packs.noMarketingSpeak,
      packs.requireDisclosure,
    ),

    /** How your product appears in text. Drives disclosure + capability scoping. */
    productPattern: /\bAcme\b/i,

    /** Things you must never claim. Denials ("we don't do X") are always allowed. */
    unsupported: [
      { term: /\bon[- ]prem(?:ise|ises)?\b|\bself[- ]host(?:ed|ing)?\b/i,
        why: 'Cloud only. No self-hosted deployment exists.' },
      { term: /\bJenkins\b/i,
        why: 'No Jenkins integration. GitHub Actions and GitLab CI only.' },
      { term: /\bSOC ?2\b|\bHIPAA\b|\bFedRAMP\b/i,
        why: 'No compliance certification has been completed.' },
    ],

    /** Product-specific rules on top of the packs. */
    rules: [
      {
        id: 'auto-fix-claim',
        severity: 'BLOCK',
        pattern: /\b(?:automatically )?fixes? (?:your )?(?:flaky )?tests?\b/i,
        message: 'We detect and quarantine flaky tests. We do not fix them.',
        source: 'features.md',
      },
    ],
  },
});
