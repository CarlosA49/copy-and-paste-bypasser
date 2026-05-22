const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMathAnswer } = require('../lib/math-normalize.js');

test('normalizeMathAnswer: passes plain decimal through', () => {
  assert.equal(normalizeMathAnswer('0.0539'), '0.0539');
});

test('normalizeMathAnswer: inserts implicit * and strips outer parens', () => {
  assert.equal(normalizeMathAnswer('(2epsilon_oE_o/r)'), '2*epsilon_o*E_o/r');
});

test('normalizeMathAnswer: handles (-2k)', () => {
  assert.equal(normalizeMathAnswer('(-2k)'), '-2*k');
});

test('normalizeMathAnswer: converts LaTeX \\times and strips units', () => {
  assert.equal(normalizeMathAnswer('(3.7647\\times10^5) N/C'), '3.7647*10^5');
});

test('normalizeMathAnswer: handles LaTeX brace exponent', () => {
  assert.equal(normalizeMathAnswer('(3.9789\\times10^{-5}) C/m²'), '3.9789*10^-5');
});

test('normalizeMathAnswer: strips voltage unit', () => {
  assert.equal(normalizeMathAnswer('15058.7876 V'), '15058.7876');
});

test('normalizeMathAnswer: strips μC/m² unit', () => {
  assert.equal(normalizeMathAnswer('8.0000 μC/m²'), '8.0000');
});

test('normalizeMathAnswer: strips bare unit suffix m', () => {
  assert.equal(normalizeMathAnswer('300 m'), '300');
});

test('normalizeMathAnswer: zero passes through', () => {
  assert.equal(normalizeMathAnswer('0'), '0');
});

test('normalizeMathAnswer: preserves necessary parens (a+b)/c', () => {
  assert.equal(normalizeMathAnswer('(a+b)/c'), '(a+b)/c');
});

test('normalizeMathAnswer: does not insert * before known identifier-like math tokens', () => {
  assert.equal(normalizeMathAnswer('2pi'), '2*pi');
  assert.equal(normalizeMathAnswer('pi'), 'pi');
});

test('normalizeMathAnswer: handles Unicode × too', () => {
  assert.equal(normalizeMathAnswer('3.7647×10^5'), '3.7647*10^5');
});

test('normalizeMathAnswer: empty / non-string returns empty', () => {
  assert.equal(normalizeMathAnswer(''), '');
  assert.equal(normalizeMathAnswer(null), '');
});
