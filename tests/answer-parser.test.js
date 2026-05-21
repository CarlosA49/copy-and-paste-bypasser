const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAnswerText } = require('../lib/answer-parser.js');

test('parseAnswerText: returns empty result for empty/whitespace input', () => {
  assert.deepEqual(parseAnswerText(''), { letters: [], numbers: [], quotedSnippets: [], rawText: '' });
  assert.deepEqual(parseAnswerText('   \n\t '), { letters: [], numbers: [], quotedSnippets: [], rawText: '   \n\t ' });
});

test('parseAnswerText: extracts single capital-letter answer from "The answer is A."', () => {
  const out = parseAnswerText('The answer is A.');
  assert.deepEqual(out.letters, ['A']);
});

test('parseAnswerText: extracts multiple letters from "The correct answers are A and C"', () => {
  const out = parseAnswerText('The correct answers are A and C');
  assert.deepEqual(out.letters, ['A', 'C']);
});

test('parseAnswerText: deduplicates and preserves first-seen order', () => {
  const out = parseAnswerText('A, then C, then A again');
  assert.deepEqual(out.letters, ['A', 'C']);
});

test('parseAnswerText: accepts "(a)" and "a)" forms and normalizes to uppercase', () => {
  assert.deepEqual(parseAnswerText('Pick (a) and b).').letters, ['A', 'B']);
});

test('parseAnswerText: does NOT pick stray letters inside ordinary words', () => {
  // "a" inside "answer" must not count.
  const out = parseAnswerText('The answer involves choosing carefully.');
  assert.deepEqual(out.letters, []);
});

test('parseAnswerText: extracts numeric option references like "Option 2" and "#3"', () => {
  const out = parseAnswerText('Pick option 2 and choice #3');
  assert.deepEqual(out.numbers, [2, 3]);
});

test('parseAnswerText: extracts numbers in "1)" / "1." enumerated forms', () => {
  const out = parseAnswerText('Correct: 1) and 4.');
  assert.deepEqual(out.numbers, [1, 4]);
});

test('parseAnswerText: ignores standalone numbers without an option marker', () => {
  // "I have 5 apples" should not pretend 5 is an option index.
  const out = parseAnswerText('I have 5 apples and 12 oranges.');
  assert.deepEqual(out.numbers, []);
});

test('parseAnswerText: extracts double-quoted snippets verbatim', () => {
  const out = parseAnswerText('Pick "Gradient descent" and "Backpropagation"');
  assert.deepEqual(out.quotedSnippets, ['Gradient descent', 'Backpropagation']);
});

test('parseAnswerText: extracts single-quoted snippets and trims whitespace', () => {
  const out = parseAnswerText("Choose '  cross entropy  '");
  assert.deepEqual(out.quotedSnippets, ['cross entropy']);
});

test('parseAnswerText: ignores empty quoted snippets', () => {
  const out = parseAnswerText('Pick "" and "real"');
  assert.deepEqual(out.quotedSnippets, ['real']);
});

test('parseAnswerText: combined extraction does not drop earlier categories', () => {
  const out = parseAnswerText('A. "Gradient descent". Also pick option 3.');
  assert.deepEqual(out.letters, ['A']);
  assert.deepEqual(out.numbers, [3]);
  assert.deepEqual(out.quotedSnippets, ['Gradient descent']);
});

test('parseAnswerText: ignores decimal numbers like 3.14 and 1.5', () => {
  const out = parseAnswerText('The value is 3.14 not 2.71 — score 1.5 out of 2.0.');
  assert.deepEqual(out.numbers, []);
});

test('parseAnswerText: still extracts "N." when followed by a non-digit (enumerated form)', () => {
  const out = parseAnswerText('Correct: 1. and 4. are right');
  assert.deepEqual(out.numbers, [1, 4]);
});

test('parseAnswerText: extracts "answer N" branch', () => {
  const out = parseAnswerText('Pick answer 5 then answer 7');
  assert.deepEqual(out.numbers, [5, 7]);
});

test('parseAnswerText: deduplicates quoted snippets case-insensitively', () => {
  const out = parseAnswerText('Pick "alpha" and "alpha" then "ALPHA" then "beta"');
  assert.deepEqual(out.quotedSnippets, ['alpha', 'beta']);
});
