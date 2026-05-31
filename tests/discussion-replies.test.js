// tests/discussion-replies.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { REPLIES, pickReply } = require('../lib/discussion-replies.js');

function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('REPLIES has exactly 20 entries', () => {
  assert.equal(REPLIES.length, 20);
});

test('every reply is non-empty and short (<=300 chars)', () => {
  for (let i = 0; i < REPLIES.length; i++) {
    const r = REPLIES[i];
    assert.equal(typeof r, 'string');
    assert.ok(r.trim().length > 0, 'reply ' + i + ' is empty');
    assert.ok(r.length <= 300, 'reply ' + i + ' is too long (' + r.length + ' chars)');
  }
});

test('every reply is unique', () => {
  const set = new Set(REPLIES);
  assert.equal(set.size, REPLIES.length);
});

test('pickReply returns a string from the pool', () => {
  const r = pickReply([], seededRng(1));
  assert.ok(REPLIES.indexOf(r) !== -1);
});

test('pickReply excludes entries present in history', () => {
  const history = REPLIES.slice(0, 5);
  const r = pickReply(history, seededRng(1));
  assert.ok(history.indexOf(r) === -1, 'picked reply must not be in history');
});

test('pickReply still returns something if history contains all replies (fallback)', () => {
  const r = pickReply(REPLIES.slice(), seededRng(1));
  assert.ok(typeof r === 'string' && r.length > 0);
});

test('pickReply is deterministic given seed and history', () => {
  const a = pickReply([], seededRng(42));
  const b = pickReply([], seededRng(42));
  assert.equal(a, b);
});
