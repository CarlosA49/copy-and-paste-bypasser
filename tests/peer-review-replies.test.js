// tests/peer-review-replies.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { COMMENTS, pickComment } = require('../lib/peer-review-replies.js');

function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('COMMENTS has at least 20 entries', () => {
  assert.ok(COMMENTS.length >= 20, 'expected >= 20 comments, got ' + COMMENTS.length);
});

test('every comment is a non-empty string within a sane length bound', () => {
  for (let i = 0; i < COMMENTS.length; i++) {
    const c = COMMENTS[i];
    assert.equal(typeof c, 'string');
    assert.ok(c.trim().length > 0, 'comment ' + i + ' is empty');
    assert.ok(c.length <= 400, 'comment ' + i + ' is too long (' + c.length + ' chars)');
  }
});

test('every comment is unique', () => {
  const set = new Set(COMMENTS);
  assert.equal(set.size, COMMENTS.length);
});

test('no comment mentions a specific topic, AI, or Coursera', () => {
  const banned = /\b(coursera|chatgpt|gpt|openai|deepseek|anthropic|claude|gemini|\bAI\b|artificial intelligence)\b/i;
  for (let i = 0; i < COMMENTS.length; i++) {
    assert.ok(!banned.test(COMMENTS[i]), 'comment ' + i + ' mentions a banned word: ' + COMMENTS[i]);
  }
});

test('pickComment returns a string built from the pool', () => {
  const c = pickComment([], 0, seededRng(1));
  assert.equal(typeof c, 'string');
  assert.ok(c.length > 0);
});

test('pickComment with minLength 0 returns a single pool entry verbatim', () => {
  const c = pickComment([], 0, seededRng(1));
  assert.ok(COMMENTS.indexOf(c) !== -1, 'with no padding the result should be a verbatim pool entry');
});

test('pickComment excludes the most recent entry in history', () => {
  // History holds the single comment we just used; the picker must avoid it.
  const recent = COMMENTS[0];
  for (let seed = 1; seed <= 30; seed++) {
    const c = pickComment([recent], 0, seededRng(seed));
    assert.notEqual(c, recent, 'picked comment must not equal the recent history entry (seed ' + seed + ')');
  }
});

test('pickComment still returns something when history contains every comment', () => {
  const c = pickComment(COMMENTS.slice(), 0, seededRng(1));
  assert.equal(typeof c, 'string');
  assert.ok(c.length > 0);
});

test('pickComment pads to at least minLength by appending further pool sentences', () => {
  const minLength = 600; // longer than any single pool entry
  const c = pickComment([], minLength, seededRng(7));
  assert.ok(c.length >= minLength, 'padded result length ' + c.length + ' should be >= ' + minLength);
});

test('pickComment padding does not infinite-loop and stays bounded', () => {
  // Even an absurd minimum must terminate and produce a finite, capped string.
  const c = pickComment([], 100000, seededRng(3));
  assert.ok(typeof c === 'string' && c.length >= 100000);
  assert.ok(c.length <= 200000, 'padding should be bounded, got ' + c.length);
});

test('pickComment is deterministic given the same seed, history, and minLength', () => {
  const a = pickComment(['x'], 500, seededRng(42));
  const b = pickComment(['x'], 500, seededRng(42));
  assert.equal(a, b);
});
