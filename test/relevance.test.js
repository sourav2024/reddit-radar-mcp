import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreRelevance } from '../src/scoring/relevance.js';

const NOW = 1_760_000_000;

/** A devtools-flavoured config, so tests don't depend on any one vertical. */
const CONFIG = {
  product: { name: 'Acme' },
  domainTerms: ['ci', 'pipeline', 'flaky', 'github actions', 'test suite', 'jenkins'],
  ambiguousTerms: ['build', 'runner'],
  featureTerms: ['flaky test', 'build time', 'test analytics'],
  subreddits: ['devops', 'sre'],
};

const post = (o = {}) => ({
  title: '', selftext: '', subreddit: 'devops', createdUtc: NOW - 86_400,
  score: 5, numComments: 10, locked: false, archived: false, over18: false,
  removedByCategory: null, ...o,
});

test('a real tooling question in a configured sub passes', () => {
  const r = scoreRelevance(
    post({ title: 'What CI tool do you use for flaky test detection?' }),
    CONFIG, { now: NOW },
  );
  assert.equal(r.passed, true, `scored ${r.score}: ${JSON.stringify(r.reasons)}`);
});

test('THE ANCHOR RULE: shape-only signals cannot carry an off-topic post', () => {
  // Recent + question + intent + software word, but nothing tying it to the domain.
  const r = scoreRelevance(
    post({
      subreddit: 'cooking',
      title: 'Any recommendations for a good app?',
      selftext: 'Looking for suggestions, my current tool is a nightmare.',
      createdUtc: NOW - 3600,
    }),
    CONFIG, { now: NOW },
  );
  assert.equal(r.signals.anchored, false);
  assert.equal(r.passed, false, `off-topic post scored ${r.score}`);
});

test('ambiguous term alone is a false positive outside the domain', () => {
  const r = scoreRelevance(
    post({ subreddit: 'homelab', title: 'Finished my new build!', createdUtc: NOW - 3600 }),
    CONFIG, { matchedQueries: ['build'], now: NOW },
  );
  assert.equal(r.passed, false, `scored ${r.score}`);
});

test('ambiguous term is redeemed by a configured subreddit', () => {
  const r = scoreRelevance(
    post({ subreddit: 'devops', title: 'Build keeps failing intermittently', createdUtc: NOW - 3600 }),
    CONFIG, { matchedQueries: ['build'], now: NOW },
  );
  assert.ok(
    r.reasons.some((x) => /treated as on-topic/.test(x)),
    JSON.stringify(r.reasons),
  );
});

test('venting is penalized below threshold', () => {
  const r = scoreRelevance(
    post({
      subreddit: 'devops',
      title: 'Am I wrong for wanting to quit over this CI pipeline?',
      selftext: 'Total rant. My manager fired the only person who understood it.',
    }),
    CONFIG, { now: NOW },
  );
  assert.equal(r.passed, false, `venting scored ${r.score}`);
});

test('no software signal penalizes a domain post about the job', () => {
  const r = scoreRelevance(
    post({ subreddit: 'devops', title: 'How much do CI engineers make in Berlin?' }),
    CONFIG, { now: NOW },
  );
  assert.ok(
    r.reasons.some((x) => /no software\/tooling signal/.test(x)),
    JSON.stringify(r.reasons),
  );
});

test('inflected forms match — real titles are not lemmatized', () => {
  // Regression from production: "Tracking softwares" scored 15/100 and was filtered
  // purely because "softwares" did not match "software".
  const r = scoreRelevance(
    post({ subreddit: 'devops', title: 'CI pipelines and test suites: monitoring tools?' }),
    CONFIG, { now: NOW },
  );
  assert.ok(r.signals.domainHits.length > 0, JSON.stringify(r.signals.domainHits));
});

test('locked / archived / removed threads are hard-blocked regardless of score', () => {
  for (const flag of [{ locked: true }, { archived: true }, { removedByCategory: 'moderator' }]) {
    const r = scoreRelevance(
      post({ title: 'What CI tool do you use for flaky test detection?', ...flag }),
      CONFIG, { now: NOW },
    );
    assert.equal(r.passed, false, `${JSON.stringify(flag)} scored ${r.score}`);
    assert.ok(r.blockers.length > 0);
  }
});

test('score never goes negative', () => {
  const r = scoreRelevance(
    post({ subreddit: 'random', title: 'I quit, what a rant, fired', createdUtc: NOW - 400 * 86_400 }),
    CONFIG, { now: NOW },
  );
  assert.ok(r.score >= 0, `got ${r.score}`);
});

test('weights are overridable', () => {
  const base = scoreRelevance(
    post({ title: 'What CI tool for flaky tests?' }), CONFIG, { now: NOW },
  );
  const boosted = scoreRelevance(
    post({ title: 'What CI tool for flaky tests?' }),
    { ...CONFIG, weights: { domainVocabulary: 5 } },
    { now: NOW },
  );
  assert.ok(boosted.score < base.score, `${boosted.score} should be < ${base.score}`);
});

test('empty config does not crash and refuses to anchor', () => {
  const r = scoreRelevance(post({ title: 'anything at all' }), {}, { now: NOW });
  assert.equal(r.signals.anchored, false);
  assert.equal(r.passed, false);
});
