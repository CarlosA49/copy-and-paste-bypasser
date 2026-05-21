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

test('normalizeAnswerText: Unicode superscript digits attached to 10 → canonical e-form', () => {
  // normalizeSuperscripts expands 10⁻⁶ → 10^-6, then normalizeSciNotation
  // converts bare 10^N → 1eN, so the full pipeline produces e-form.
  assert.equal(normalizeAnswerText('10⁻⁶'), '1e-6');
  assert.equal(normalizeAnswerText('10⁶'), '1e6');
  assert.equal(normalizeAnswerText('10¹²'), '1e12');
});

test('normalizeAnswerText: superscript on a letter is left as-is (not part of sci notation)', () => {
  // We only normalize the 10^N case; superscript on a unit symbol stays for downstream use.
  // (m² should stay as m² so the user still sees a sensible unit; the value extractor
  // doesn't need it to be ^2.)
  assert.equal(normalizeAnswerText('area m²'), 'area m²');
});

test('normalizeAnswerText: "1.0000×10^-6" → "1.0000e-6"', () => {
  assert.equal(normalizeAnswerText('1.0000×10^-6'), '1.0000e-6');
});

test('normalizeAnswerText: "1.0000 × 10^-6" → "1.0000e-6" (spaces around ×)', () => {
  assert.equal(normalizeAnswerText('1.0000 × 10^-6'), '1.0000e-6');
});

test('normalizeAnswerText: "1.0000x10^-6" → "1.0000e-6" (lowercase x)', () => {
  assert.equal(normalizeAnswerText('1.0000x10^-6'), '1.0000e-6');
});

test('normalizeAnswerText: "1.0000*10^-6" → "1.0000e-6" (asterisk)', () => {
  assert.equal(normalizeAnswerText('1.0000*10^-6'), '1.0000e-6');
});

test('normalizeAnswerText: "1.0000×10⁻⁶" → "1.0000e-6" (Unicode superscript)', () => {
  assert.equal(normalizeAnswerText('1.0000×10⁻⁶'), '1.0000e-6');
});

test('normalizeAnswerText: "1.0E-6" → "1.0e-6" (capital E lowercased)', () => {
  assert.equal(normalizeAnswerText('1.0E-6'), '1.0e-6');
});

test('normalizeAnswerText: "1.0e-6" → "1.0e-6" (already canonical)', () => {
  assert.equal(normalizeAnswerText('1.0e-6'), '1.0e-6');
});

test('normalizeAnswerText: bare "10^-6" (no coefficient) → "1e-6"', () => {
  assert.equal(normalizeAnswerText('value 10^-6 here'), 'value 1e-6 here');
});

test('normalizeAnswerText: bare "10⁻⁶" → "1e-6"', () => {
  assert.equal(normalizeAnswerText('value 10⁻⁶ here'), 'value 1e-6 here');
});

test('normalizeAnswerText: positive exponent "1.5×10^3" → "1.5e3"', () => {
  assert.equal(normalizeAnswerText('1.5×10^3'), '1.5e3');
});

test('normalizeAnswerText: explicit "+" sign "1.5×10^+3" → "1.5e+3"', () => {
  assert.equal(normalizeAnswerText('1.5×10^+3'), '1.5e+3');
});

test('normalizeAnswerText: multiple sci-notation expressions in one string', () => {
  assert.equal(
    normalizeAnswerText('1.0000×10^-6 H, then 2.5×10^-9 F'),
    '1.0000e-6 H, then 2.5e-9 F'
  );
});

test('normalizeAnswerText: does NOT touch a plain decimal like "0.0352"', () => {
  assert.equal(normalizeAnswerText('value 0.0352 H'), 'value 0.0352 H');
});

test('normalizeAnswerText: does NOT touch year-like numbers ("2024 was a leap year")', () => {
  // 2024 is preceded by a digit boundary, not part of sci notation.
  assert.equal(normalizeAnswerText('2024 was a leap year'), '2024 was a leap year');
});

test('normalizeAnswerText: split sci notation across 2 lines is joined', () => {
  // Coefficient on one line, exponent on the next.
  const input = '1.0000×10\n-6';
  const out = normalizeAnswerText(input);
  // After the line-join + canonicalisation: "1.0000e-6"
  assert.equal(out, '1.0000e-6');
});

test('normalizeAnswerText: split sci notation across 3 lines (coefficient / exponent / unit)', () => {
  const input = '1.0000×10\n−6\nH';
  const out = normalizeAnswerText(input);
  // Coefficient + exponent collapse onto one line; the unit stays separated
  // by a space (we don't fold arbitrary line content into the value, just the exponent).
  assert.equal(out, '1.0000e-6 H');
});

test('normalizeAnswerText: split sci notation does NOT join unrelated next line', () => {
  // "2024 was..." after "value 10^N" should not be absorbed as an exponent.
  // (Our join rule requires the next line to be a signed integer only.)
  const input = '1.0000×10\nNot an exponent here';
  const out = normalizeAnswerText(input);
  // No join — the next line isn't just a signed number.
  assert.equal(out.indexOf('Not an exponent here'), out.length - 'Not an exponent here'.length);
});
