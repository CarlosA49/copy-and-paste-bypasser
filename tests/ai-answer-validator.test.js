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

test('U15-V1: math_input with ans.type="math_input" is accepted (alias)', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { type: 'math_input', value: '0.5' }, explanation: '', confidence: 'high' }],
  }, SNAP);
  assert.equal(out.ok, true);
  const s = out.suggestions[0];
  assert.equal(s.applicable, true, 'must be applicable');
  assert.equal(s.value, '0.5');
  assert.equal(s.mappingStatus, 'matched');
});

test('U15-V2: math_input with ans.type="numerical" is accepted (alias)', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { type: 'numerical', value: '42' } }],
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].value, '42');
});

test('U15-V3: math_input with ans.type="input" is accepted (alias)', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { type: 'input', value: 'hello world' } }],
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].value, 'hello world');
});

test('U15-V4: math_input with numeric ans.value is coerced to string', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { type: 'text', value: 3.14 } }],
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].value, '3.14');
});

test('U15-V5: math_input with ans.text alias (instead of ans.value) is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { type: 'text', text: 'alpha' } }],
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].value, 'alpha');
});

test('U15-V6: math_input with bare value and no ans.type is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { value: 'bare' } }],
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].value, 'bare');
});

test('U15-V7: math_input with empty / whitespace-only value is still rejected', () => {
  const out1 = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { type: 'text', value: '' } }],
  }, SNAP);
  assert.equal(out1.suggestions[0].applicable, false);
  assert.equal(out1.suggestions[0].mappingStatus, 'wrong-type');
  const out2 = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { type: 'text', value: '   ' } }],
  }, SNAP);
  assert.equal(out2.suggestions[0].applicable, false);
});

test('U15-V8: math_input with ans.type="string" is accepted (some models use this label)', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { type: 'string', value: 'hello' } }],
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].value, 'hello');
});

test('U15-V9: math_input with a bare-string a.answer (no object wrapper) is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: '0.42', explanation: 'forty-two percent', confidence: 'medium' }],
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].value, '0.42');
  assert.equal(out.suggestions[0].explanation, 'forty-two percent');
});

test('U15-V10: math_input with a bare-number a.answer (numeric, no wrapper) is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: 7 }],
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].value, '7');
});

// === U17: tolerant single_choice resolution paths ===

test('U17-V1: single_choice with option_ids array (canonical) still works', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: { type: 'single_choice', option_ids: ['q1o0'] } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].mappingStatus, 'matched');
  assert.equal(out.suggestions[0].choiceText, 'Alpha');
});

test('U17-V2: single_choice with option_id singular string is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: { type: 'single_choice', option_id: 'q1o1' } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].choiceText, 'Beta');
});

test('U17-V3: single_choice with letter "A" is accepted (case-insensitive)', () => {
  const out = v.validateAndMap({
    answers: [
      { question_id: 'q1', answer: { type: 'single_choice', letter: 'A' } },
      { question_id: 'q1', answer: { type: 'single_choice', letter: 'b' } },
    ]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].choiceText, 'Alpha');
  assert.equal(out.suggestions[1].applicable, true);
  assert.equal(out.suggestions[1].choiceText, 'Beta');
});

test('U17-V4: single_choice with value as a single letter is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: { type: 'single_choice', value: 'B' } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].choiceText, 'Beta');
});

test('U17-V5: single_choice with value as the exact option label is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: { type: 'single_choice', value: 'Alpha' } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].choiceText, 'Alpha');
});

test('U17-V6: single_choice with value matching label case-insensitively is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: { type: 'single_choice', value: 'BETA' } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].choiceText, 'Beta');
});

test('U17-V7: single_choice with bare-string a.answer "A" is accepted as letter', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: 'A' }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].choiceText, 'Alpha');
});

test('U17-V8: single_choice with bare-string a.answer matching label is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: 'Beta' }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].choiceText, 'Beta');
});

test('U17-V9: single_choice with value as the option_id is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: { type: 'single_choice', value: 'q1o0' } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].choiceText, 'Alpha');
});

test('U17-V10: single_choice with unresolvable value is rejected as wrong-type', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: { type: 'single_choice', value: 'totally unrelated' } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, false);
  assert.equal(out.suggestions[0].mappingStatus, 'wrong-type');
});

test('U17-V11: single_choice with option_ids referring to an unknown id is rejected as unknown-option', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: { type: 'single_choice', option_ids: ['q1o999'] } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, false);
  assert.equal(out.suggestions[0].mappingStatus, 'unknown-option');
});
