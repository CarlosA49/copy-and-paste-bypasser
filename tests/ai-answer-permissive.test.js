'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../lib/ai-answer-permissive.js');

const SNAP = {
  token: 'snap_abc',
  page: { urlOrigin: 'https://www.coursera.org', eligible: true },
  questions: [
    { id: 'q1', order: 1, questionNumber: 1, type: 'single_choice', prompt: 'p1',
      options: [
        { id: 'q1o0', label: 'Alpha' },
        { id: 'q1o1', label: 'Beta' },
      ], supported: true },
    { id: 'q2', order: 2, questionNumber: 2, type: 'multiple_choice', prompt: 'p2',
      options: [
        { id: 'q2o0', label: 'A' },
        { id: 'q2o1', label: 'B' },
        { id: 'q2o2', label: 'C' },
      ], supported: true },
    { id: 'q3', order: 3, questionNumber: 3, type: 'math_input', prompt: 'p3', supported: true },
  ],
};

test('parses { answers: [...] } shape with assorted answer fields', () => {
  const raw = {
    answers: [
      { question_id: 'q1', answer: { value: 'Beta' } },
      { question_id: 'q2', answer: { option_ids: ['q2o0', 'q2o2'] } },
      { question_id: 'q3', answer: { value: '0.5' } },
    ],
  };
  const out = p.extract(raw, SNAP);
  assert.equal(out.suggestions.length, 3);
  assert.equal(out.suggestions[0].choiceText, 'Beta');
  assert.deepEqual(out.suggestions[1].choiceTexts, ['q2o0', 'q2o2']);
  assert.equal(out.suggestions[2].value, '0.5');
  out.suggestions.forEach((s) => assert.equal(s.applicable, true));
  out.suggestions.forEach((s) => assert.equal(s.bypassed, true));
});

test('parses top-level array (no answers wrapper)', () => {
  const raw = [
    { question_id: 'q1', value: 'Beta' },
    { question_id: 'q3', value: 7 },
  ];
  const out = p.extract(raw, SNAP);
  assert.equal(out.suggestions.length, 2);
  assert.equal(out.suggestions[0].choiceText, 'Beta');
  assert.equal(out.suggestions[1].value, '7');
});

test('parses fenced JSON string', () => {
  const raw = '```json\n{"answers":[{"question_id":"q1","answer":{"letter":"A"}}]}\n```';
  const out = p.extract(raw, SNAP);
  assert.equal(out.suggestions.length, 1);
  // permissive carries the letter through as text; applier resolves it.
  assert.equal(out.suggestions[0].choiceText, 'A');
});

test('recovers JSON embedded in leading prose', () => {
  const raw = 'Here you go: {"answers":[{"question_id":"q1","answer":{"value":"Alpha"}}]} cheers';
  const out = p.extract(raw, SNAP);
  assert.equal(out.suggestions.length, 1);
  assert.equal(out.suggestions[0].choiceText, 'Alpha');
});

test('falls back to nested array deep inside an object', () => {
  const raw = { result: { responses: [{ question_id: 'q1', value: 'Beta' }] } };
  const out = p.extract(raw, SNAP);
  assert.equal(out.suggestions.length, 1);
  assert.equal(out.suggestions[0].choiceText, 'Beta');
});

test('positional fallback when no question_id is present', () => {
  const raw = { answers: [{ value: 'Beta' }, { value: 'A, C' }, { value: 3.14 }] };
  const out = p.extract(raw, SNAP);
  assert.equal(out.suggestions[0].choiceText, 'Beta');
  assert.deepEqual(out.suggestions[1].choiceTexts, ['A', 'C']);
  assert.equal(out.suggestions[2].value, '3.14');
});

test('multiple_choice "and" separator', () => {
  const raw = { answers: [{ question_id: 'q2', value: 'A and C' }] };
  const out = p.extract(raw, SNAP);
  assert.deepEqual(out.suggestions[0].choiceTexts, ['A', 'C']);
});

test('multiple_choice with single value still produces a one-item array', () => {
  const raw = { answers: [{ question_id: 'q2', value: 'B' }] };
  const out = p.extract(raw, SNAP);
  assert.deepEqual(out.suggestions[0].choiceTexts, ['B']);
});

test('numeric question_number matches by snapshot.questionNumber', () => {
  const raw = { answers: [{ question_number: 3, value: 42 }] };
  const out = p.extract(raw, SNAP);
  assert.equal(out.suggestions[0].questionNumber, 3);
  assert.equal(out.suggestions[0].value, '42');
});

test('item with no recoverable answer string is non-applicable', () => {
  const raw = { answers: [{ question_id: 'q1', answer: { metadata: {} } }] };
  const out = p.extract(raw, SNAP);
  assert.equal(out.suggestions.length, 1);
  assert.equal(out.suggestions[0].applicable, false);
  assert.equal(out.suggestions[0].mappingStatus, 'bypass-failed');
});

test('unknown question_id (no positional match either) is non-applicable', () => {
  // Empty snapshot questions → positional fallback can\'t resolve.
  const emptySnap = { token: 't', questions: [] };
  const raw = { answers: [{ question_id: 'zzz', value: 'whatever' }] };
  const out = p.extract(raw, emptySnap);
  assert.equal(out.suggestions.length, 1);
  assert.equal(out.suggestions[0].applicable, false);
});

test('garbage input returns empty suggestions', () => {
  assert.deepEqual(p.extract(null, SNAP), { suggestions: [], sourceShape: 'unparseable' });
  assert.deepEqual(p.extract('absolutely no json here', SNAP), { suggestions: [], sourceShape: 'unparseable' });
  assert.deepEqual(p.extract({}, SNAP).suggestions, []);
});

test('bare-string and bare-number answers extracted', () => {
  const raw = { answers: [{ question_id: 'q1', answer: 'Beta' }, { question_id: 'q3', answer: 9 }] };
  const out = p.extract(raw, SNAP);
  assert.equal(out.suggestions[0].choiceText, 'Beta');
  assert.equal(out.suggestions[1].value, '9');
});
