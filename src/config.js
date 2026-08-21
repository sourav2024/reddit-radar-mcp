/**
 * Config definition and validation.
 *
 * Validation is deliberately loud about the mistakes that produce a silently useless
 * radar: no domain terms (everything scores as a false positive), no subreddits (nothing
 * to sweep), or a gate that names a product with no rules behind it.
 */

/** Identity helper for editor autocomplete: `export default defineConfig({...})`. */
export const defineConfig = (config) => config;

const VALID_MODES = ['PROMOTE', 'PROMOTE_SOFT', 'CONTRIBUTE', 'TECHNICAL_ONLY'];

/**
 * @param {object} config
 * @returns {{valid:boolean, errors:string[], warnings:string[]}}
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be an object.'], warnings: [] };
  }

  if (!config.product?.name) {
    errors.push('product.name is required — it labels output and drives disclosure checks.');
  }

  if (!Array.isArray(config.queries) || config.queries.length === 0) {
    errors.push('queries must be a non-empty array of search terms.');
  }

  const tierSubs = Object.values(config.tiers ?? {}).flatMap((t) => t.subreddits ?? []);
  const allSubs = [...(config.subreddits ?? []), ...tierSubs];
  if (allSubs.length === 0) {
    errors.push('No subreddits configured. Add config.subreddits or config.tiers[].subreddits.');
  }

  if (!Array.isArray(config.domainTerms) || config.domainTerms.length === 0) {
    errors.push(
      'domainTerms is required and must be non-empty. Without it nothing can anchor to ' +
        'your domain, so every recent question scores as an opportunity.',
    );
  }

  for (const [tier, def] of Object.entries(config.tiers ?? {})) {
    if (def.mode && !VALID_MODES.includes(def.mode)) {
      errors.push(`tiers.${tier}.mode "${def.mode}" is not one of: ${VALID_MODES.join(', ')}`);
    }
    if (!Array.isArray(def.subreddits) || def.subreddits.length === 0) {
      warnings.push(`tiers.${tier} has no subreddits and will never match.`);
    }
  }

  // A gate that knows the product name but has nothing to enforce is a false sense of safety.
  const gate = config.gate ?? {};
  const ruleCount = (gate.rules ?? []).length + (gate.unsupported ?? []).length;
  if (gate.productPattern && ruleCount === 0 && gate.requireDisclosure === false) {
    warnings.push(
      'gate has a productPattern but no rules and disclosure is off — it will approve everything.',
    );
  }
  if (!gate.productPattern && ruleCount > 0) {
    warnings.push(
      'gate.rules are set but gate.productPattern is missing — disclosure and ' +
        'unsupported-capability checks are skipped without it.',
    );
  }

  const dupes = allSubs
    .map((s) => s.toLowerCase())
    .filter((s, i, a) => a.indexOf(s) !== i);
  if (dupes.length) {
    warnings.push(`Subreddit listed more than once: ${[...new Set(dupes)].join(', ')}`);
  }

  const ambiguousNotInDomain = (config.ambiguousTerms ?? []).filter(
    (t) => !(config.queries ?? []).some((q) => q.toLowerCase() === String(t).toLowerCase()),
  );
  if (ambiguousNotInDomain.length) {
    warnings.push(
      `ambiguousTerms not present in queries (they only take effect for matched queries): ${ambiguousNotInDomain.join(', ')}`,
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}
