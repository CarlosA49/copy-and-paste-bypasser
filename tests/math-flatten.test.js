const test = require('node:test');
const assert = require('node:assert/strict');
const { flattenLatexToText } = require('../lib/math-flatten.js');

test('flattenLatexToText: passes plain digits through', () => {
  assert.equal(flattenLatexToText('500'), '500');
});

test('flattenLatexToText: strips enclosing single $ delimiters', () => {
  assert.equal(flattenLatexToText('$500$'), '500');
});

test('flattenLatexToText: strips enclosing double $$ delimiters', () => {
  assert.equal(flattenLatexToText('$$500$$'), '500');
});

test('flattenLatexToText: passes letters through (e.g. LC)', () => {
  assert.equal(flattenLatexToText('LC'), 'LC');
});

test('flattenLatexToText: thin space \\, becomes a regular space', () => {
  assert.equal(flattenLatexToText('10\\,cm'), '10 cm');
});

test('flattenLatexToText: greek macro \\Omega becomes Ω (capital)', () => {
  assert.equal(flattenLatexToText('\\Omega'), 'Ω');
});

test('flattenLatexToText: \\mu followed by a space and a letter joins to μ+letter (57 μH)', () => {
  assert.equal(flattenLatexToText('57\\,\\mu H'), '57 μH');
});

test('flattenLatexToText: \\Omega adjacent to a number (10\\,\\Omega → 10 Ω)', () => {
  assert.equal(flattenLatexToText('10\\,\\Omega'), '10 Ω');
});

test('flattenLatexToText: returns empty string for empty / whitespace input', () => {
  assert.equal(flattenLatexToText(''), '');
  assert.equal(flattenLatexToText('   '), '');
});

test('flattenLatexToText: returns null for non-string input', () => {
  assert.equal(flattenLatexToText(null), null);
  assert.equal(flattenLatexToText(undefined), null);
  assert.equal(flattenLatexToText(123), null);
});

test('flattenLatexToText: simple ^2 → ²', () => {
  assert.equal(flattenLatexToText('cm^2'), 'cm²');
});

test('flattenLatexToText: ^{2} → ²', () => {
  assert.equal(flattenLatexToText('cm^{2}'), 'cm²');
});

test('flattenLatexToText: ^3 → ³', () => {
  assert.equal(flattenLatexToText('m^3'), 'm³');
});

test('flattenLatexToText: multi-digit superscript ^{10} → ¹⁰', () => {
  assert.equal(flattenLatexToText('x^{10}'), 'x¹⁰');
});

test('flattenLatexToText: subscript _0 → ₀', () => {
  assert.equal(flattenLatexToText('t_0'), 't₀');
});

test('flattenLatexToText: subscript _{12} → ₁₂', () => {
  assert.equal(flattenLatexToText('R_{12}'), 'R₁₂');
});

test('flattenLatexToText: superscript with un-mappable char (^x) → null fallback', () => {
  // Caller will fall back to LaTeX form.
  assert.equal(flattenLatexToText('a^x'), null);
});

test('flattenLatexToText: full noisy example "2\\,cm^2" → "2 cm²"', () => {
  assert.equal(flattenLatexToText('2\\,cm^2'), '2 cm²');
});

test('flattenLatexToText: returns null for \\frac', () => {
  assert.equal(flattenLatexToText('\\frac{1}{2}'), null);
});

test('flattenLatexToText: returns null for \\sqrt', () => {
  assert.equal(flattenLatexToText('\\sqrt{2}'), null);
});

test('flattenLatexToText: returns null for \\sum', () => {
  assert.equal(flattenLatexToText('\\sum_{i=0}^{n} i'), null);
});

test('flattenLatexToText: returns null for \\int', () => {
  assert.equal(flattenLatexToText('\\int_a^b f(x) dx'), null);
});

test('flattenLatexToText: returns null for \\begin{matrix}', () => {
  assert.equal(flattenLatexToText('\\begin{matrix}1 & 2\\end{matrix}'), null);
});

test('flattenLatexToText: returns null for unknown macro (e.g. \\foobar)', () => {
  assert.equal(flattenLatexToText('\\foobar'), null);
});
