import test from 'node:test';
import assert from 'node:assert/strict';
import { styleCheck, autoFix } from '../src/gate/style-check.js';

const ANCHORS = ['ci', 'pipeline', 'flaky', 'runner', 'github actions', 'regression'];

test('domain anchors are configurable — a dense draft is not flagged as thin', () => {
  // Regression: the anchor list was hardcoded to one vertical's vocabulary, so a
  // technically specific draft from any other domain scored 0 anchors and failed.
  const draft =
    'We surface flaky tests by rerunning a failed job on an isolated runner and ' +
    'comparing traces. That catches ordering bugs a plain retry hides. Ask any vendor ' +
    'how they separate a flaky test from a real regression.';

  const without = styleCheck(draft);
  const with_ = styleCheck(draft, { anchorTerms: ANCHORS });

  assert.equal(without.metrics.anchors, 0, 'no config = no domain anchors');
  assert.ok(with_.metrics.anchors >= 2, `got ${with_.metrics.anchors}`);
  assert.ok(!with_.findings.some((f) => f.id === 'thin-substance'));
});

test('genuinely empty filler still fails on substance', () => {
  const draft =
    'This is a great question and something a lot of teams run into. There are many ' +
    'options out there, and the right one really depends on your specific needs and ' +
    'your workflow. It is worth taking the time to evaluate a few and see what fits.';
  const r = styleCheck(draft, { anchorTerms: ANCHORS });
  assert.ok(r.findings.some((f) => f.id === 'thin-substance'), JSON.stringify(r.findings));
});

test('flags marketing vocabulary', () => {
  const r = styleCheck(
    'Our robust platform lets you leverage seamless CI pipeline observability at scale.',
    { anchorTerms: ANCHORS },
  );
  assert.ok(r.findings.some((f) => /banned|vocab/i.test(f.id)), JSON.stringify(r.findings.map((f) => f.id)));
});

test('flags negation framing', () => {
  const r = styleCheck(
    'It is not just a dashboard, it is a full CI pipeline observability layer for flaky ' +
      'test detection across every runner in your fleet.',
    { anchorTerms: ANCHORS },
  );
  assert.ok(r.findings.some((f) => f.id === 'negation-framing'), JSON.stringify(r.findings.map((f) => f.id)));
});

test('autoFix converts curly quotes and em dashes', () => {
  const fixed = autoFix('The “build” — it’s slow.');
  assert.ok(!/[‘’“”—]/.test(fixed), fixed);
});

test('styleCheck without options does not crash', () => {
  const r = styleCheck('Short draft with 3 numbers 42 and 7.');
  assert.ok(typeof r.metrics.anchors === 'number');
});
