const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNumberedAnswers, parseOrderedLines } = require('../lib/numbered-parser.js');

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

test('strips bold emphasis wrapping an answer value', () => {
  // "1. **bold answer**" — the closing ** must not leak into rawAnswer
  const r = parseNumberedAnswers('1. **bold answer**\n2. plain');
  assert.equal(r[0].rawAnswer, 'bold answer');
  assert.equal(r[1].rawAnswer, 'plain');
});

test('strips bold emphasis when answer contains an internal asterisk', () => {
  // "1. **2*epsilon_o**" — internal * is math, outer ** is emphasis
  const r = parseNumberedAnswers('1. **2*epsilon_o**\n2. B');
  assert.equal(r[0].rawAnswer, '2*epsilon_o');
  assert.equal(r[1].rawAnswer, 'B');
});

test('single-answer JSON array returns [] (too few answers to trust)', () => {
  const r = parseNumberedAnswers(JSON.stringify([{ question_id: '1', answer: 'A' }]));
  assert.deepEqual(r, []);
});

test('JSON with numeric (non-string) question_id', () => {
  const r = parseNumberedAnswers(JSON.stringify([
    { question_id: 1, answer: 'A' },
    { question_id: 2, answer: 'B' },
  ]));
  assert.equal(r.length, 2);
  assert.equal(r[0].questionNumber, 1);
});

test('parseOrderedLines: bare 11-line format', () => {
  const raw =
    '0.0539\n' +
    '2*epsilon_o*E_o/r\n' +
    '0\n' +
    '-2k\n' +
    '0\n' +
    '15058.7876 V\n' +
    '3.7647×10^5 N/C\n' +
    '8.0000 μC/m²\n' +
    '3.9789×10^-5 C/m²\n' +
    'Diamagnetism\n' +
    '300 m';
  const r = parseOrderedLines(raw, 11);
  assert.equal(r.length, 11);
  assert.equal(r[0].rawAnswer, '0.0539');
  assert.equal(r[1].rawAnswer, '2*epsilon_o*E_o/r');
  assert.equal(r[7].rawAnswer, '8.0000 μC/m²');
  assert.equal(r[8].rawAnswer, '3.9789×10^-5 C/m²');
  assert.equal(r[9].rawAnswer, 'Diamagnetism');
  assert.equal(r[10].rawAnswer, '300 m');
});

test('parseOrderedLines: strips "Final answers:" header and "Based on..." trailer', () => {
  const raw =
    'Final answers:\n\n' +
    '0.0539\n' +
    '2*epsilon_o*E_o/r\n' +
    '0\n' +
    '-2k\n' +
    '0\n' +
    '15058.7876 V\n' +
    '3.7647×10^5 N/C\n' +
    '8.0000 μC/m²\n' +
    '3.9789×10^-5 C/m²\n' +
    'Diamagnetism\n' +
    '300 m\n\n' +
    'Based on the uploaded question set.';
  const r = parseOrderedLines(raw, 11);
  assert.equal(r.length, 11);
  assert.equal(r[0].rawAnswer, '0.0539');
  assert.equal(r[10].rawAnswer, '300 m');
});

test('parseOrderedLines: count mismatch returns []', () => {
  const r = parseOrderedLines('a\nb\nc', 11);
  assert.deepEqual(r, []);
});

test('parseOrderedLines: missing expectedCount returns [] (no permissive mode)', () => {
  assert.deepEqual(parseOrderedLines('a\nb', undefined), []);
  assert.deepEqual(parseOrderedLines('a\nb', null), []);
});

test('parseOrderedLines: Windows line endings normalised', () => {
  const r = parseOrderedLines('a\r\nb\r\nc', 3);
  assert.equal(r.length, 3);
  assert.equal(r[1].rawAnswer, 'b');
});

test('parseOrderedLines: empty / non-string returns []', () => {
  assert.deepEqual(parseOrderedLines('', 5), []);
  assert.deepEqual(parseOrderedLines(null, 5), []);
});

test('parseOrderedLines: blank lines between answers are skipped', () => {
  const r = parseOrderedLines('a\n\nb\n\n\nc', 3);
  assert.equal(r.length, 3);
  assert.equal(r[2].rawAnswer, 'c');
});

test('parseOrderedLines: "Here are the answers:" header is stripped', () => {
  const r = parseOrderedLines('Here are the answers:\nx\ny', 2);
  assert.equal(r.length, 2);
  assert.equal(r[0].rawAnswer, 'x');
});
