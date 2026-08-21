/**
 * Starter rule packs.
 *
 * These cover the four ways a promotional draft most often goes wrong, and they hold for
 * essentially any B2B product. Compose them, then add rules specific to your claim
 * boundary:
 *
 *   import { packs, composePacks } from 'reddit-radar-mcp';
 *
 *   gate: {
 *     ...composePacks(packs.noPricing, packs.noFabricatedMetrics, packs.noCustomerNames),
 *     productPattern: /\bAcme\b/i,
 *     rules: [ ...your own... ],
 *   }
 *
 * Every pack is a plain object you can inspect, edit, or partially discard. Nothing here
 * is magic — if a rule does not fit your situation, drop it.
 */

import { SEVERITY } from './fact-check.js';

/**
 * Never state a price.
 *
 * Most B2B products quote per deal. A number invented in a public comment is a fabricated
 * product claim, and being publicly wrong about your own pricing is worse than silence.
 * Placing yourself in someone else's cost tier is the same mistake wearing a disguise.
 */
export const noPricing = {
  rules: [
    {
      id: 'price-figure',
      severity: SEVERITY.BLOCK,
      pattern: /\$\s?\d[\d,.]*|\b\d[\d,.]*\s*(?:\/|per\s+)(?:seat|user|month|mo\b|unit|license)/i,
      message: 'States a price or per-unit cost.',
      source: 'pack:noPricing',
    },
    {
      id: 'price-ballpark',
      severity: SEVERITY.BLOCK,
      pattern: /\b(?:four|five|three)[- ]figure|\bmid[- ]four\b|\bcheaper than\b|\bless expensive than\b|\bmore affordable than\b|\bundercut/i,
      message: 'Implies a price point or price comparison. Never place your product in a cost tier.',
      source: 'pack:noPricing',
    },
  ],
};

/**
 * Never invent numbers.
 *
 * Quantified outcomes are the most-challenged form of comment in practitioner subreddits
 * ("whose team? what volume?"). Unless you have a public, measured figure, a percentage
 * is a guess wearing a lab coat.
 */
export const noFabricatedMetrics = {
  rules: [
    {
      id: 'invented-metric',
      severity: SEVERITY.BLOCK,
      pattern: /\b\d{1,3}\s?%\s*(?:faster|cheaper|fewer|less|more|reduction|improvement|increase|savings?)\b|\b(?:saves?|cuts?|reduces?)\s+\d{1,3}\s?%/i,
      message: 'States a percentage improvement. Unless this is a published, measured figure, it is fabricated.',
      source: 'pack:noFabricatedMetrics',
    },
    {
      id: 'uptime-sla',
      severity: SEVERITY.BLOCK,
      pattern: /\b99\.\d+\s?%|\bfive nines\b|\b(?:guaranteed|SLA of)\s+\d/i,
      message: 'States an uptime or SLA figure. Only claim this if it is contractually published.',
      source: 'pack:noFabricatedMetrics',
    },
    {
      id: 'vague-scale-claim',
      severity: SEVERITY.WARN,
      pattern: /\b(?:thousands|hundreds|millions) of (?:customers|users|companies|teams|loads|orders)\b|\b(?:industry[- ]leading|market[- ]leading|the best|#1|number one)\b/i,
      message: 'Unverifiable scale or superlative claim. Practitioners downvote these on sight.',
      source: 'pack:noFabricatedMetrics',
    },
  ],
};

/**
 * Never reference a customer, named or anonymous.
 *
 * A named-entity list only catches customers you remember to add, so this blocks the
 * SHAPE of a customer-reference sentence instead.
 *
 * The distinction that matters is attribution, not the before/after structure. Describing
 * how your software changes a workflow is good promotional material. Attributing a
 * measured result to a real operation is an anonymous case study, and it is both
 * unverifiable and a confidentiality risk.
 *
 *   ALLOWED: "Settlement runs that meant CSV exports happen in-system."   (capability)
 *   BLOCKED: "A brokerage went from 3 days to 2 hours after switching."   (attributed)
 */
export const noCustomerNames = {
  rules: [
    {
      id: 'client-reference',
      severity: SEVERITY.BLOCK,
      pattern: /\b(?:one|some|a few|several|many)\s+of\s+(?:our|my)\s+(?:customers|clients|users|accounts|teams)\b|\b(?:our|my)\s+(?:customers?|clients?)\s+(?:who|that|saw|told|reported|said|switched|moved|uses?|use|run|running|reduced|cut|saved)\b|\bwe onboarded\b|\bone of our (?:accounts|tenants)\b/i,
      message: 'References a specific client, even anonymously. Describe the workflow change as a capability instead.',
      source: 'pack:noCustomerNames',
    },
    {
      id: 'anonymous-case-study',
      severity: SEVERITY.BLOCK,
      pattern: /\b(?:went|dropped|fell|cut|reduced|shrank|down)\s+from\s+[^.]{0,30}?\bto\b[^.]{0,30}?\b(?:hours?|days?|minutes?|weeks?|%|percent)\b|\bfrom\s+\d+\s*(?:hours?|days?|weeks?|minutes?)\s+(?:down\s+)?to\s+\d*\s*(?:hours?|days?|weeks?|minutes?)\b/i,
      message: 'Reads as an anonymous case study with a measured outcome. Describe the mechanism, not a result someone achieved.',
      source: 'pack:noCustomerNames',
    },
    {
      id: 'testimonial-claim',
      severity: SEVERITY.WARN,
      pattern: /\b(?:customers|clients|users) (?:love|rave|tell us|say)\b|\btestimonial|\bcase study\b/i,
      message: 'Implies social proof. Only claim this if the material is public.',
      source: 'pack:noCustomerNames',
    },
  ],
};

/**
 * Require affiliation disclosure whenever the product is named.
 *
 * This is not just etiquette. Many vendor-tolerant subreddits remove undisclosed vendor
 * comments and may permanently ban, and Reddit's own Responsible Builder Policy prohibits
 * misrepresenting who you are. A ban ends the channel entirely, so disclosure protects
 * the goal rather than working against it.
 */
export const requireDisclosure = {
  requireDisclosure: true,
};

/**
 * Marketing-register vocabulary that reads as copy rather than as a person.
 * WARN rather than BLOCK — occasionally one of these is the right word.
 */
export const noMarketingSpeak = {
  rules: [
    {
      id: 'marketing-vocabulary',
      severity: SEVERITY.WARN,
      pattern: /\b(?:leverage|seamless(?:ly)?|robust|cutting[- ]edge|game[- ]chang(?:er|ing)|revolutionary|best[- ]in[- ]class|turnkey|synerg|holistic|frictionless|supercharge)\b/i,
      message: 'Marketing register. Practitioner subreddits downvote corporate copy on sight.',
      source: 'pack:noMarketingSpeak',
    },
  ],
};

export const packs = {
  noPricing,
  noFabricatedMetrics,
  noCustomerNames,
  requireDisclosure,
  noMarketingSpeak,
};

/**
 * Merge packs into one gate config fragment. Later packs win on scalar keys; `rules` and
 * `unsupported` concatenate.
 */
export function composePacks(...selected) {
  const out = { rules: [], unsupported: [] };
  for (const p of selected) {
    if (!p) continue;
    const { rules = [], unsupported = [], ...rest } = p;
    out.rules.push(...rules);
    out.unsupported.push(...unsupported);
    Object.assign(out, rest);
  }
  return out;
}
