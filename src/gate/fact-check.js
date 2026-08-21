/**
 * Deterministic claim gate.
 *
 * Rule-based on purpose. The whole point is to catch a model overclaiming about your
 * product, so the check must not be performed by a model with the same incentive. An LLM
 * pass can run in addition, never instead.
 *
 * This module ships the ENGINE. The rules are yours: a claim boundary is specific to your
 * product, and shipping someone else's defaults would be both useless and unsafe. Start
 * from the packs in `./packs.js`, then add your own.
 */

export const SEVERITY = { BLOCK: 'BLOCK', WARN: 'WARN' };

const asRegex = (p) => (p instanceof RegExp ? p : new RegExp(p, 'i'));

/**
 * Sentences that ASSERT a capability of your product. Only these get scanned against the
 * unsupported-capability list, so discussing a competitor's feature ("OTM is built for
 * shippers", "their EDI works well") does not trip the gate.
 *
 * `productPattern` is injected so "Acme does X" works for whatever your product is called.
 */
function buildAssertionPattern(productPattern) {
  const p = productPattern instanceof RegExp ? productPattern.source : productPattern;
  return new RegExp(
    `\\b(?:${p}|it|we|ours?|the (?:platform|system|product|tool))\\b[^.!?]{0,80}?` +
      '\\b(?:does|do|supports?|handles?|includes?|has|have|offers?|provides?|covers?|' +
      'integrates?|runs?|works? with|can|built in|native)\\b' +
      "|\\bthere(?:'s| is| are)\\b[^.!?]{0,40}\\b(?:integration|support|connector)\\b" +
      '|\\b(?:is|are)\\s+(?:fully\\s+)?supported\\b',
    'i',
  );
}

/**
 * A DENIAL is the opposite of a claim and must never be blocked.
 *
 * "It does not do container tracking" is exactly the honest behaviour you want. An early
 * version of this check flagged denials, which pushed drafts toward silence about gaps
 * instead of disclosure — the opposite of the intent. Conceding a limitation is the
 * cheapest credibility you can buy in a skeptical subreddit.
 */
const DENIAL = /\b(?:does ?n[o']t|do ?n[o']t|no|not|cannot|can'?t|lacks?|without|never|skips?)\b/i;

/** Default phrases that count as disclosing an affiliation. */
export const DEFAULT_DISCLOSURE_PATTERNS = [
  /\bI work (?:at|for)\b/i,
  /\bI'?m (?:on the team|with|at)\b/i,
  /\bfull disclosure\b/i,
  /\bdisclosure:/i,
  /\bmy company\b/i,
  /\b(?:I|we) build\b/i,
  /\bI'?m (?:a )?(?:co)?founder\b/i,
  /\bbiased[,:]? I work\b/i,
  /\b(?:disclaimer|for transparency)\b/i,
];

/**
 * Run the claim gate over a draft.
 *
 * @param {string} draft
 * @param {object} config              gate config
 * @param {Array}  [config.rules]      [{id, severity, pattern, message, source}]
 * @param {Array}  [config.unsupported] [{term, why}] capabilities you must not claim
 * @param {RegExp|string} [config.productPattern] how your product is named in text
 * @param {boolean} [config.requireDisclosure=true]
 * @param {Array}  [config.disclosurePatterns]
 * @returns {{allowed:boolean, findings:Array, blocks:number, warns:number}}
 */
export function factCheck(draft, config = {}) {
  const {
    rules = [],
    unsupported = [],
    productPattern,
    requireDisclosure = true,
    disclosurePatterns = DEFAULT_DISCLOSURE_PATTERNS,
  } = config;

  const text = String(draft ?? '');
  const findings = [];

  for (const rule of rules) {
    const m = text.match(asRegex(rule.pattern));
    if (m) {
      findings.push({
        id: rule.id,
        severity: rule.severity ?? SEVERITY.BLOCK,
        message: rule.message,
        source: rule.source ?? null,
        evidence: m[0].trim().slice(0, 80),
      });
    }
  }

  // Assertion-scoped scan for capabilities you don't have.
  if (unsupported.length > 0 && productPattern) {
    const assertion = buildAssertionPattern(productPattern);
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
      if (!assertion.test(sentence)) continue;
      if (DENIAL.test(sentence)) continue; // honest gap disclosure, not a claim
      for (const cap of unsupported) {
        const m = sentence.match(asRegex(cap.term));
        if (m) {
          findings.push({
            id: 'unsupported-capability',
            severity: SEVERITY.BLOCK,
            message: `Claims a capability absent from the knowledge base. ${cap.why}`,
            source: cap.source ?? null,
            evidence: m[0].trim().slice(0, 60),
          });
        }
      }
    }
  }

  if (requireDisclosure && productPattern) {
    const mentioned = asRegex(productPattern).test(text);
    const disclosed = disclosurePatterns.some((p) => asRegex(p).test(text));
    if (mentioned && !disclosed) {
      findings.push({
        id: 'missing-disclosure',
        severity: SEVERITY.BLOCK,
        message:
          'Names your product without disclosing affiliation. Most vendor-tolerant ' +
          'subreddits require this, and undisclosed promotion risks a permanent ban.',
        source: 'disclosure',
        evidence: 'product named, no disclosure phrase found',
      });
    }
  }

  const blocks = findings.filter((f) => f.severity === SEVERITY.BLOCK).length;
  const warns = findings.filter((f) => f.severity === SEVERITY.WARN).length;

  return {
    allowed: blocks === 0,
    blocks,
    warns,
    findings: findings.sort((a) => (a.severity === SEVERITY.BLOCK ? -1 : 1)),
  };
}

/** Human-readable findings block. */
export function renderFindings(result) {
  if (result.findings.length === 0) return 'FACT CHECK: clean — no rule violations detected.';
  const lines = [
    `FACT CHECK: ${result.blocks} blocking, ${result.warns} warning`,
    '',
  ];
  for (const f of result.findings) {
    lines.push(`[${f.severity}] ${f.id}: ${f.message}`);
    if (f.evidence) lines.push(`  found: "${f.evidence}"`);
    if (f.source) lines.push(`  source: ${f.source}`);
  }
  return lines.join('\n');
}
