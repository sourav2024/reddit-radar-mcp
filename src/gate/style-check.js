/**
 * Draft quality gate — catches text that reads as unedited generated filler.
 *
 * PURPOSE, STATED PRECISELY: this is NOT an AI-detection bypass. That is explicitly out
 * of scope, and it would not work anyway. Many subreddits ban *low-effort*
 * content: "Comments that read as unedited generated filler will be removed. If you use
 * an assistant to help draft, make sure the substance is yours and actually answers the
 * question." Moderators there read; they don't run classifiers.
 *
 * So this gate enforces what such a rule actually asks for — that a draft reads like a
 * person who knows the subject wrote it, with real substance and no marketing filler.
 * The human still edits and posts. Authorship is never misrepresented; drafts disclose
 * affiliation (see fact-check.js) and the poster is accountable for what they send.
 *
 * Rules derived from the `humanize` skill's measurable checks. Deliberately mechanical:
 * the model that wrote a draft is the worst judge of its own tells.
 */

export const STYLE = { FAIL: 'FAIL', WARN: 'WARN' };

/** Words that mark corporate filler. Subset of the skill's list, tuned for Reddit. */
const BANNED = [
  'delve', 'leverage', 'utilize', 'robust', 'comprehensive', 'streamline', 'foster',
  'facilitate', 'pivotal', 'nuanced', 'multifaceted', 'seamless', 'seamlessly',
  'landscape', 'showcase', 'tapestry', 'testament', 'furthermore', 'moreover',
  'game-changer', 'game-changing', 'cutting-edge', 'best-in-class', 'industry-leading',
  'unlock', 'supercharge', 'effortless', 'groundbreaking', 'holistic', 'synergy',
  'empower', 'elevate', 'revolutionize', 'revolutionary', 'transformative',
];

const BANNED_PHRASES = [
  'it is important to note', "it's worth noting", 'it is worth mentioning',
  'in conclusion', 'in summary', 'at the end of the day', 'at its core',
  "let's dive in", "let's break this down", "here's what you need to know",
  'in today', 'needless to say', 'it goes without saying',
  'i hope this helps', 'let me know if you have any questions',
  'feel free to reach out', 'happy to jump on a call',
  'great question', "you're absolutely right", 'that said, at the end',
  'a myriad of', 'a plethora of', 'in the realm of', 'the real question is',
];

const splitSentences = (text) =>
  text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;

/**
 * @param {string} draft
 * @returns {{passed:boolean, fails:number, warns:number, findings:Array, metrics:object}}
 */
export function styleCheck(draft, opts = {}) {
  const text = String(draft ?? '');
  /**
   * Domain vocabulary counts as substance. Pass your config's domainTerms +
   * featureTerms so the check knows what a specific noun looks like in YOUR field —
   * otherwise a technically dense draft reads as empty.
   */
  const { anchorTerms = [] } = opts;
  const words = wordCount(text);
  const findings = [];

  const add = (id, severity, message, fix, evidence) =>
    findings.push({ id, severity, message, fix, evidence });

  // --- Em dashes: 1 per 300 words, zero under 300 -------------------------
  const emDashes = (text.match(/—/g) ?? []).length;
  const emBudget = Math.floor(words / 300);
  if (emDashes > emBudget) {
    add(
      'em-dashes',
      STYLE.FAIL,
      `${emDashes} em dash(es); budget is ${emBudget} for ${words} words.`,
      'Replace with a period, a comma, or cut the aside. This is the single most reliable tell.',
      `${emDashes} found`,
    );
  }

  // --- Semicolons ---------------------------------------------------------
  const semis = (text.match(/;/g) ?? []).length;
  if (semis > 0) {
    add('semicolons', STYLE.FAIL, `${semis} semicolon(s).`, 'Use a period, or and/but/so.', `${semis} found`);
  }

  // --- Curly quotes (a near-certain character-level tell) -----------------
  const curly = (text.match(/[‘’“”]/g) ?? []).length;
  if (curly > 0) {
    add(
      'curly-quotes',
      STYLE.FAIL,
      `${curly} curly quote/apostrophe character(s).`,
      "Replace with straight ' and \". Survives rewriting, so it must be fixed mechanically.",
      `${curly} found`,
    );
  }

  // --- Negation / comparative framing ------------------------------------
  const negations = [
    ...(text.match(/\bnot just\b/gi) ?? []),
    ...(text.match(/\bisn't\b[^.!?]{0,45}?\bit's\b/gi) ?? []),
    ...(text.match(/\bit's not\b[^.!?]{0,40}?\bit's\b/gi) ?? []),
    ...(text.match(/\bnot\b[^.!?]{0,15}?,\s*(?:it's|they're|that's)\b/gi) ?? []),
  ];
  if (negations.length) {
    add(
      'negation-framing',
      STYLE.FAIL,
      `${negations.length} negation pivot(s) ("not X, it's Y").`,
      'Say what the thing IS. Drop the setup half.',
      negations.map((n) => n.trim().slice(0, 50)).join(' | '),
    );
  }

  // --- Banned vocabulary --------------------------------------------------
  const lower = text.toLowerCase();
  const bannedHits = BANNED.filter((w) =>
    new RegExp(`(?:^|[^a-z])${w.replace(/[-]/g, '[- ]')}(?:[^a-z]|$)`, 'i').test(lower),
  );
  const phraseHits = BANNED_PHRASES.filter((p) => lower.includes(p));
  if (bannedHits.length || phraseHits.length) {
    add(
      'banned-vocabulary',
      STYLE.FAIL,
      `Filler vocabulary: ${[...bannedHits, ...phraseHits].join(', ')}.`,
      'These read as corporate copy. Practitioners downvote them on sight.',
      [...bannedHits, ...phraseHits].join(', '),
    );
  }

  // --- Sentence rhythm ----------------------------------------------------
  const sentences = splitSentences(text);
  const counts = sentences.map(wordCount);
  const metrics = {
    words,
    sentences: counts.length,
    sentenceCounts: counts,
    emDashes,
    semicolons: semis,
    curlyQuotes: curly,
    range: counts.length ? Math.max(...counts) - Math.min(...counts) : 0,
    midBand: counts.filter((c) => c >= 10 && c <= 20).length,
    shortest: counts.length ? Math.min(...counts) : 0,
    longest: counts.length ? Math.max(...counts) : 0,
  };

  // Rhythm rules only meaningful above ~80 words.
  if (words > 80 && counts.length >= 4) {
    if (metrics.range < 20) {
      add(
        'rhythm-range',
        STYLE.WARN,
        `Sentence length range is ${metrics.range}; want 20+.`,
        'Add a fragment of <=5 words AND one 25+ word sentence that earns its length.',
        `counts: ${counts.join(', ')}`,
      );
    }
    if (metrics.midBand > counts.length / 2) {
      add(
        'rhythm-midband',
        STYLE.WARN,
        `${metrics.midBand}/${counts.length} sentences in the 10-20 word band (want under half).`,
        'Split one mid-length sentence into a fragment plus the rest; merge two others.',
        `counts: ${counts.join(', ')}`,
      );
    }
    const shortNeeded = Math.floor(words / 150);
    const shorts = counts.filter((c) => c <= 6).length;
    if (shorts < Math.max(1, shortNeeded)) {
      add(
        'rhythm-no-short',
        STYLE.WARN,
        `${shorts} sentence(s) of <=6 words; want at least ${Math.max(1, shortNeeded)}.`,
        'Drop in a short one. Like that.',
        `shortest is ${metrics.shortest} words`,
      );
    }
    // Three consecutive counts within 5 words of each other reads uniform.
    for (let i = 0; i + 2 < counts.length; i++) {
      const w = counts.slice(i, i + 3);
      if (Math.max(...w) - Math.min(...w) <= 5) {
        add(
          'rhythm-flat-run',
          STYLE.WARN,
          `Three consecutive sentences of similar length (${w.join(', ')}).`,
          'Break one of them.',
          `positions ${i + 1}-${i + 3}`,
        );
        break;
      }
    }
  }

  // --- Structural markers -------------------------------------------------
  const bullets = (text.match(/^\s*[-*•]\s+/gm) ?? []).length;
  if (bullets >= 3) {
    add(
      'bullet-heavy',
      STYLE.WARN,
      `${bullets} bullet points.`,
      'Reddit comments in these subs are prose. Bullets read as a generated summary.',
      `${bullets} bullets`,
    );
  }

  // --- Substance check: rule 4 is about low effort, so measure substance --
  const anchorPattern = anchorTerms.length
    ? new RegExp(
        '\\b(?:' +
          anchorTerms
            .map((t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .sort((a, b) => b.length - a.length)
            .join('|') +
          ')\\w*',
        'gi',
      )
    : null;
  const anchors = [
    ...(text.match(/\b\d+\b/g) ?? []),
    ...(anchorPattern ? text.match(anchorPattern) ?? [] : []),
  ];
  /**
   * Scale the requirement with length. A 289-word answer should carry several specifics;
   * a deliberately terse 60-word reply carrying two is dense, not thin. A flat threshold
   * of 3 blocked genuinely good short comments (observed 2026-08-20), which would have
   * pushed drafts to pad — the opposite of what rule 4 wants.
   */
  const anchorsNeeded = words < 90 ? 2 : words < 180 ? 3 : 4;
  if (anchors.length < anchorsNeeded) {
    add(
      'thin-substance',
      STYLE.FAIL,
      `Only ${anchors.length} concrete anchor(s) for ${words} words; want ${anchorsNeeded}.`,
      'This is what rule 4 actually removes. Name specifics: the mechanism, the field, the workflow step. Do NOT pad — add substance or cut length.',
      `${anchors.length} anchors`,
    );
  }
  metrics.anchors = anchors.length;

  const fails = findings.filter((f) => f.severity === STYLE.FAIL).length;
  const warns = findings.filter((f) => f.severity === STYLE.WARN).length;

  return {
    passed: fails === 0,
    fails,
    warns,
    findings: findings.sort((a) => (a.severity === STYLE.FAIL ? -1 : 1)),
    metrics,
  };
}

/** Mechanical fixes that never change meaning. Safe to apply automatically. */
export function autoFix(draft) {
  return String(draft ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/—/g, '.') // em dash -> sentence break; review reads oddly sometimes
    .replace(/\.\s*\./g, '.')
    .replace(/\s+\./g, '.');
}

export function renderStyle(result) {
  const m = result.metrics;
  const lines = [
    `DRAFT QUALITY: ${result.fails} fail, ${result.warns} warn` +
      (result.passed ? ' — reads as written by a person' : ' — reads as generated filler'),
    `${m.words} words, ${m.sentences} sentences (${m.sentenceCounts.join(', ')})`,
    `em:${m.emDashes} semi:${m.semicolons} curly:${m.curlyQuotes} anchors:${m.anchors}`,
    '',
  ];
  for (const f of result.findings) {
    lines.push(`[${f.severity}] ${f.id}: ${f.message}`);
    lines.push(`  fix: ${f.fix}`);
    if (f.evidence) lines.push(`  found: ${f.evidence}`);
  }
  return lines.join('\n');
}
