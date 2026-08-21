import test from 'node:test';
import assert from 'node:assert/strict';
import { factCheck } from '../src/gate/fact-check.js';
import { packs, composePacks } from '../src/gate/packs.js';

const GATE = {
  ...composePacks(
    packs.noPricing,
    packs.noFabricatedMetrics,
    packs.noCustomerNames,
    packs.requireDisclosure,
  ),
  productPattern: /\bAcme\b/i,
  unsupported: [
    { term: /\bJenkins\b/i, why: 'No Jenkins integration exists.' },
    { term: /\bself[- ]host(?:ed|ing)?\b/i, why: 'Cloud only.' },
  ],
};

test('clean disclosed draft is allowed', () => {
  const r = factCheck(
    'Full disclosure: I work at Acme. We detect flaky tests by re-running on isolated runners.',
    GATE,
  );
  assert.equal(r.allowed, true, JSON.stringify(r.findings));
});

test('blocks a stated price', () => {
  const r = factCheck('Full disclosure: I work at Acme. It runs $49 per user per month.', GATE);
  assert.equal(r.allowed, false);
  assert.ok(r.findings.some((f) => f.id === 'price-figure'));
});

test('blocks an invented percentage metric', () => {
  const r = factCheck(
    'Full disclosure: I work at Acme. Teams see 40% faster builds after switching.',
    GATE,
  );
  assert.equal(r.allowed, false);
  assert.ok(r.findings.some((f) => f.id === 'invented-metric'));
});

test('blocks an anonymous case study', () => {
  const r = factCheck(
    'Full disclosure: I work at Acme. One team went from 3 hours to 20 minutes on CI.',
    GATE,
  );
  assert.equal(r.allowed, false);
  assert.ok(r.findings.some((f) => ['anonymous-case-study', 'client-reference'].includes(f.id)));
});

test('blocks naming a product without disclosure', () => {
  const r = factCheck('Acme handles flaky test detection well.', GATE);
  assert.equal(r.allowed, false);
  assert.ok(r.findings.some((f) => f.id === 'missing-disclosure'));
});

test('blocks claiming an unsupported capability', () => {
  const r = factCheck(
    'Full disclosure: I work at Acme. It integrates with Jenkins out of the box.',
    GATE,
  );
  assert.equal(r.allowed, false);
  assert.ok(r.findings.some((f) => f.id === 'unsupported-capability'));
});

test('DENIAL IS ALLOWED — honest gap disclosure must never be blocked', () => {
  // This is the behaviour that makes the gate safe to trust. Conceding a limitation is
  // the cheapest credibility available, and an early version of this check blocked it.
  const r = factCheck(
    "Full disclosure: I work at Acme. We do not support Jenkins, only GitHub Actions.",
    GATE,
  );
  assert.equal(r.allowed, true, JSON.stringify(r.findings));
});

test('discussing someone else\'s product does not trip the capability scan', () => {
  const r = factCheck(
    'Full disclosure: I work at Acme. Jenkins is a solid choice if you need self-hosting.',
    GATE,
  );
  assert.equal(r.allowed, true, JSON.stringify(r.findings));
});

test('disclosure can be switched off for non-promotional use', () => {
  const r = factCheck('Acme does flaky detection.', { ...GATE, requireDisclosure: false });
  assert.ok(!r.findings.some((f) => f.id === 'missing-disclosure'));
});

test('a gate with no rules allows anything (and validateConfig warns about it)', () => {
  const r = factCheck('literally anything', {});
  assert.equal(r.allowed, true);
});

test('packs compose without losing rules', () => {
  const composed = composePacks(packs.noPricing, packs.noCustomerNames);
  const ids = composed.rules.map((r) => r.id);
  assert.ok(ids.includes('price-figure'));
  assert.ok(ids.includes('client-reference'));
});
