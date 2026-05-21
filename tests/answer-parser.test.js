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
