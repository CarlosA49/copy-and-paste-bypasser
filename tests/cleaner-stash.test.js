// tests/cleaner-stash.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const cleaner = require('../lib/cleaner.js');

test('cleanCopiedText stashes result on the module export as lastCleanedCopy', () => {
  const input = 'Some sample text to clean.';
  const out = cleaner.cleanCopiedText(input);
  assert.equal(typeof out, 'string');
  assert.equal(cleaner.lastCleanedCopy, out,
    'cleaner.lastCleanedCopy must mirror the most recent cleanCopiedText return value');
});

test('lastCleanedCopy updates on each call', () => {
  const a = cleaner.cleanCopiedText('first input');
  assert.equal(cleaner.lastCleanedCopy, a);
  const b = cleaner.cleanCopiedText('second different input');
  assert.equal(cleaner.lastCleanedCopy, b);
  assert.notEqual(a, b, 'sanity check: outputs differ for differing inputs');
});

test('lastCleanedCopy reflects empty string when nothing came through cleanly', () => {
  // Pure junk that gets fully filtered.
  const out = cleaner.cleanCopiedText('Coursera AI assistants — academic integrity');
  assert.equal(out, '');
  assert.equal(cleaner.lastCleanedCopy, '');
});
