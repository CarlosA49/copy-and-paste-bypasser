const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAnswerText } = require('../lib/answer-parser.js');

test('parseAnswerText: returns empty result for empty/whitespace input', () => {
  assert.deepEqual(parseAnswerText(''), { letters: [], numbers: [], quotedSnippets: [], computedValues: [], rawText: '' });
  assert.deepEqual(parseAnswerText('   \n\t '), { letters: [], numbers: [], quotedSnippets: [], computedValues: [], rawText: '   \n\t ' });
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

test('parseAnswerText: extracts plain "answer is X" computed value', () => {
  const out = parseAnswerText('The answer is 500 turns.');
  assert.deepEqual(out.computedValues, [{ value: '500', unit: 'turns', raw: '500 turns' }]);
});

test('parseAnswerText: extracts numeric-only "answer is X" (no unit)', () => {
  const out = parseAnswerText('Therefore the answer is 42.');
  assert.deepEqual(out.computedValues, [{ value: '42', unit: '', raw: '42' }]);
});

test('parseAnswerText: extracts "L = 200 mH" via the equals-with-unit pattern', () => {
  const out = parseAnswerText('After integrating, L = 200 mH.');
  assert.deepEqual(out.computedValues, [{ value: '200', unit: 'mH', raw: '200 mH' }]);
});

test('parseAnswerText: extracts decimal value (6.3 MHz)', () => {
  const out = parseAnswerText('Solving, f = 6.3 MHz.');
  assert.deepEqual(out.computedValues, [{ value: '6.3', unit: 'MHz', raw: '6.3 MHz' }]);
});

test('parseAnswerText: deduplicates identical computed values', () => {
  const out = parseAnswerText('Step 1: f = 6.3 MHz. Step 2: confirm f = 6.3 MHz.');
  assert.equal(out.computedValues.length, 1);
  assert.equal(out.computedValues[0].raw, '6.3 MHz');
});

test('parseAnswerText: returns empty computedValues for non-numeric prose', () => {
  const out = parseAnswerText('Pick option A then explain why.');
  assert.deepEqual(out.computedValues, []);
});

test('parseAnswerText: computedValues coexists with letters/numbers/snippets', () => {
  const out = parseAnswerText('Pick A then compute: L = 200 mH.');
  assert.deepEqual(out.letters, ['A']);
  assert.equal(out.computedValues.length, 1);
  assert.equal(out.computedValues[0].raw, '200 mH');
});

test('parseAnswerText: returns empty computedValues array for empty input', () => {
  assert.deepEqual(parseAnswerText('').computedValues, []);
});

test('parseAnswerText: chained equality (T = 1/f = 0.0167 s) picks the LAST equals', () => {
  const out = parseAnswerText('T = 1/f = 0.0167 s');
  // Only one computed value emitted via the equals branch, and it's the final value.
  assert.equal(out.computedValues.length, 1);
  assert.equal(out.computedValues[0].value, '0.0167');
  assert.equal(out.computedValues[0].unit, 's');
  assert.equal(out.computedValues[0].raw, '0.0167 s');
});

test('parseAnswerText: longer chain (I = V/R = 5/10 = 0.5 A) picks 0.5 A only', () => {
  const out = parseAnswerText('I = V/R = 5/10 = 0.5 A');
  assert.equal(out.computedValues.length, 1);
  assert.equal(out.computedValues[0].raw, '0.5 A');
});

test('parseAnswerText: explicit "answer is X" still wins, even with chained equals after it', () => {
  const out = parseAnswerText('The answer is 42 kg. Sanity: 42 kg = 42 kg.');
  // Answer-pattern produces 42 kg; equals-pattern would also match "= 42 kg"
  // (the last one); the dedup on value+unit key collapses them to one.
  assert.equal(out.computedValues.length, 1);
  assert.equal(out.computedValues[0].raw, '42 kg');
});

test('parseAnswerText: stop-word "and" is NOT captured as a unit', () => {
  const out = parseAnswerText('x = 5 and y = 3');
  // EQUALS_PATTERN now keeps only the LAST match, so this becomes value=3 with no unit.
  assert.equal(out.computedValues.length, 1);
  assert.equal(out.computedValues[0].value, '3');
  assert.equal(out.computedValues[0].unit, '');
  assert.equal(out.computedValues[0].raw, '3');
});

test('parseAnswerText: stop-word "then" is NOT captured as a unit (single equation)', () => {
  // ANSWER_PATTERN matches "answer is 7 then" — "then" must be rejected as a unit.
  const out = parseAnswerText('The answer is 7 then move on.');
  assert.equal(out.computedValues.length, 1);
  assert.equal(out.computedValues[0].value, '7');
  assert.equal(out.computedValues[0].unit, '');
});
