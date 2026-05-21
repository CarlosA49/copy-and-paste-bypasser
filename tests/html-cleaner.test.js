const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanSelectionHtml } = require('../lib/html-cleaner.js');

// Each test calls cleanSelectionHtml(htmlString) and asserts on both
// cleanHtml and cleanText. Subsequent tasks append more tests.

test('no-op: clean input with no junk and no math passes through structurally intact', () => {
  const input = '<p>Hello world.</p>';
  const { cleanHtml, cleanText } = cleanSelectionHtml(input);
  assert.match(cleanHtml, /^<p>Hello world\.<\/p>$/);
  assert.equal(cleanText, 'Hello world.');
});
