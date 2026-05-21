const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAnswerText } = require('../lib/value-normalize.js');

test('normalizeAnswerText: returns "" for non-string and empty inputs', () => {
  assert.equal(normalizeAnswerText(null), '');
  assert.equal(normalizeAnswerText(undefined), '');
  assert.equal(normalizeAnswerText(123), '');
  assert.equal(normalizeAnswerText(''), '');
});

test('normalizeAnswerText: passes plain prose through unchanged', () => {
  assert.equal(normalizeAnswerText('Hello world.'), 'Hello world.');
});

test('normalizeAnswerText: Unicode minus U+2212 → ASCII "-"', () => {
  // The −6 here uses U+2212, the canonical "minus sign" Coursera uses.
  assert.equal(normalizeAnswerText('value −6'), 'value -6');
});

test('normalizeAnswerText: Unicode superscript digits attached to 10 → 10^N form', () => {
  assert.equal(normalizeAnswerText('10⁻⁶'), '10^-6');
  assert.equal(normalizeAnswerText('10⁶'), '10^6');
  assert.equal(normalizeAnswerText('10¹²'), '10^12');
});

test('normalizeAnswerText: superscript on a letter is left as-is (not part of sci notation)', () => {
  // We only normalize the 10^N case; superscript on a unit symbol stays for downstream use.
  // (m² should stay as m² so the user still sees a sensible unit; the value extractor
  // doesn't need it to be ^2.)
  assert.equal(normalizeAnswerText('area m²'), 'area m²');
});
