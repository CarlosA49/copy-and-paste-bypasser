const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNumberedAnswers } = require('../lib/numbered-parser.js');

test('parses simple numbered list', () => {
  const r = parseNumberedAnswers('1. 0.0539\n2. 2*epsilon_o*E_o/r\n3. 0');
  assert.deepEqual(r, [
    { questionNumber: 1, rawAnswer: '0.0539' },
    { questionNumber: 2, rawAnswer: '2*epsilon_o*E_o/r' },
    { questionNumber: 3, rawAnswer: '0' },
  ]);
});

test('parses bold markdown numbered list', () => {
  const r = parseNumberedAnswers('**1.** 0.0539\n**2.** 2*epsilon_o*E_o/r');
  assert.equal(r.length, 2);
  assert.equal(r[0].questionNumber, 1);
  assert.equal(r[0].rawAnswer, '0.0539');
  assert.equal(r[1].questionNumber, 2);
  assert.equal(r[1].rawAnswer, '2*epsilon_o*E_o/r');
});

test('parses JSON answers shape', () => {
  const r = parseNumberedAnswers(JSON.stringify({
    answers: [
      { question_id: '1', answer: '0.0539' },
      { question_id: '2', answer: '2*epsilon_o*E_o/r' },
    ]
  }));
  assert.equal(r.length, 2);
  assert.equal(r[1].rawAnswer, '2*epsilon_o*E_o/r');
});

test('parses JSON inside markdown fence', () => {
  const raw = 'Here you go:\n```json\n{"answers":[{"question_id":"1","answer":"0.0539"},{"question_id":"2","answer":"x"}]}\n```\nDone.';
  const r = parseNumberedAnswers(raw);
  assert.equal(r.length, 2);
  assert.equal(r[0].rawAnswer, '0.0539');
});

test('parses "Question N:" form', () => {
  const r = parseNumberedAnswers('Question 1: 0.0539\nQuestion 2: 2*epsilon_o*E_o/r');
  assert.equal(r.length, 2);
  assert.equal(r[1].questionNumber, 2);
});

test('handles Windows line endings and blank lines', () => {
  const r = parseNumberedAnswers('1. A\r\n\r\n2. B\r\n');
  assert.deepEqual(r, [
    { questionNumber: 1, rawAnswer: 'A' },
    { questionNumber: 2, rawAnswer: 'B' },
  ]);
});

test('the exact 11-answer real-world failure case', () => {
  const raw =
    '1. 0.0539 \n' +
    '2. (2epsilon_oE_o/r)\n' +
    '3. 0\n' +
    '4. (-2k)\n' +
    '5. 0\n' +
    '6. 15058.7876 V\n' +
    '7. (3.7647\\times10^5) N/C\n' +
    '8. 8.0000 μC/m²\n' +
    '9. (3.9789\\times10^{-5}) C/m²\n' +
    '10. Diamagnetism\n' +
    '11. 300 m';
  const r = parseNumberedAnswers(raw);
  assert.equal(r.length, 11);
  // Raw verbatim — normalisation belongs to the applier.
  assert.equal(r[0].rawAnswer, '0.0539');
  assert.equal(r[1].rawAnswer, '(2epsilon_oE_o/r)');
  assert.equal(r[3].rawAnswer, '(-2k)');
  assert.equal(r[6].rawAnswer, '(3.7647\\times10^5) N/C');
  assert.equal(r[8].rawAnswer, '(3.9789\\times10^{-5}) C/m²');
  assert.equal(r[9].rawAnswer, 'Diamagnetism');
  assert.equal(r[10].rawAnswer, '300 m');
});

test('dedupes by questionNumber, first occurrence wins', () => {
  const r = parseNumberedAnswers('1. A\n1. B\n2. C');
  assert.equal(r.length, 2);
  assert.equal(r[0].rawAnswer, 'A');
  assert.equal(r[1].rawAnswer, 'C');
});

test('returns [] for empty / non-string', () => {
  assert.deepEqual(parseNumberedAnswers(''), []);
  assert.deepEqual(parseNumberedAnswers(null), []);
});

test('answers containing commas, parens, and operators are preserved', () => {
  const r = parseNumberedAnswers('1. (a+b)/c\n2. 1, 2, 3');
  assert.equal(r[0].rawAnswer, '(a+b)/c');
  assert.equal(r[1].rawAnswer, '1, 2, 3');
});

test('skips prose lines around list', () => {
  const r = parseNumberedAnswers(
    'Here are the answers:\n1. 0.0539\n2. 0\nLet me know if you need clarification.'
  );
  assert.equal(r.length, 2);
});
