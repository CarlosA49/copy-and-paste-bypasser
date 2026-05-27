'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../lib/ai-answer-validator.js');

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

test('valid response maps cleanly', () => {
  const resp = {
    answers: [
      { question_id: 'q1', answer: { type: 'single_choice', option_ids: ['q1o1'] }, explanation: 'because', confidence: 'high' },
      { question_id: 'q2', answer: { type: 'multiple_choice', option_ids: ['q2o0', 'q2o2'] }, explanation: 'two', confidence: 'medium' },
      { question_id: 'q3', answer: { type: 'text', value: '0.5' }, explanation: 'half', confidence: 'low' },
    ]
  };
  const out = v.validateAndMap(resp, SNAP);
  assert.equal(out.ok, true);
  assert.equal(out.suggestions.length, 3);
  assert.equal(out.suggestions[0].choiceText, 'Beta');
  assert.deepEqual(out.suggestions[1].choiceTexts, ['A', 'C']);
  assert.equal(out.suggestions[2].value, '0.5');
  out.suggestions.forEach(s => assert.equal(s.applicable, true));
});

test('unknown question id is rejected as not applicable', () => {
  const out = v.validateAndMap({ answers: [
    { question_id: 'q999', answer: { type: 'single_choice', option_ids: ['q999o0'] } }
  ]}, SNAP);
  assert.equal(out.ok, true);
  assert.equal(out.suggestions[0].applicable, false);
  assert.equal(out.suggestions[0].mappingStatus, 'unknown-question');
});

test('unknown option id is rejected', () => {
  const out = v.validateAndMap({ answers: [
    { question_id: 'q1', answer: { type: 'single_choice', option_ids: ['q1o999'] } }
  ]}, SNAP);
  assert.equal(out.suggestions[0].applicable, false);
  assert.equal(out.suggestions[0].mappingStatus, 'unknown-option');
});

test('wrong-type (text answer for radio question) is rejected', () => {
  const out = v.validateAndMap({ answers: [
    { question_id: 'q1', answer: { type: 'text', value: 'hello' } }
  ]}, SNAP);
  assert.equal(out.suggestions[0].applicable, false);
  assert.equal(out.suggestions[0].mappingStatus, 'wrong-type');
});

test('malformed JSON string returns invalid-json', () => {
  const out = v.validateAndMap('not json at all', SNAP);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'invalid-json');
});

test('markdown-fenced JSON is accepted via extractStrictJson', () => {
  const text = '```json\n{ "answers": [ { "question_id": "q3", "answer": { "type": "text", "value": "9" } } ] }\n```';
  const parsed = v.extractStrictJson(text);
  assert.ok(parsed);
  const out = v.validateAndMap(parsed, SNAP);
  assert.equal(out.suggestions[0].value, '9');
});

test('explanation is preserved for display', () => {
  const out = v.validateAndMap({ answers: [
    { question_id: 'q1', answer: { type: 'single_choice', option_ids: ['q1o0'] }, explanation: 'short reason' }
  ]}, SNAP);
  assert.equal(out.suggestions[0].explanation, 'short reason');
});

test('model cannot smuggle a DOM selector or submit action', () => {
  const out = v.validateAndMap({ answers: [
    { question_id: 'q1', answer: { type: 'single_choice', option_ids: ['q1o0'], selector: '#x', script: 'alert(1)', submit: true, url: 'https://evil/' } }
  ]}, SNAP);
  // Selector/script/url/submit fields are dropped, suggestion still maps cleanly but exposes no selector
  assert.equal('selector' in out.suggestions[0], false);
  assert.equal('script' in out.suggestions[0], false);
  assert.equal('url' in out.suggestions[0], false);
  assert.equal('submit' in out.suggestions[0], false);
});

test('stale snapshot token mismatch blocks apply', () => {
  const out = v.validateAndMap({ answers: [] }, SNAP, { expectedToken: 'snap_DIFFERENT' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'stale-snapshot');
});
