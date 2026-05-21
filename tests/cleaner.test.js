const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanCopiedText } = require('../lib/cleaner.js');

test('returns empty string when input is null', () => {
  assert.equal(cleanCopiedText(null), '');
});

test('returns empty string when input is undefined', () => {
  assert.equal(cleanCopiedText(undefined), '');
});

test('returns empty string when input is empty', () => {
  assert.equal(cleanCopiedText(''), '');
});

test('passes through clean text unchanged (aside from trim)', () => {
  const input = 'The quick brown fox jumps over the lazy dog.';
  assert.equal(cleanCopiedText(input), input);
});

test('removes a line containing the word "coursera" (case-insensitive)', () => {
  const input = [
    'A vector is an ordered list of numbers.',
    'This content is from Coursera and is for personal study only.',
    'Vectors can be added componentwise.',
  ].join('\n');
  const expected = [
    'A vector is an ordered list of numbers.',
    'Vectors can be added componentwise.',
  ].join('\n');
  assert.equal(cleanCopiedText(input), expected);
});

test('removes a line containing "copyright"', () => {
  const input = 'Useful sentence.\nCopyright 2025 Some University. All rights reserved.';
  assert.equal(cleanCopiedText(input), 'Useful sentence.');
});

test('removes a line containing "assessment"', () => {
  const input = 'Real content.\nThis assessment is for your personal use only.';
  assert.equal(cleanCopiedText(input), 'Real content.');
});

test('removes a line containing the phrase "don\'t share" with curly or straight apostrophe', () => {
  const straight = 'Keep this.\nPlease don\'t share this content with others.';
  const curly = 'Keep this.\nPlease don’t share this content with others.';
  assert.equal(cleanCopiedText(straight), 'Keep this.');
  assert.equal(cleanCopiedText(curly), 'Keep this.');
});

test('removes a line containing the pattern "(c) 2025"', () => {
  const input = 'Body text.\n(c) 2025 Example Org';
  assert.equal(cleanCopiedText(input), 'Body text.');
});

test('removes a line containing the symbol "© 2024"', () => {
  const input = 'Body text.\n© 2024 Example Org';
  assert.equal(cleanCopiedText(input), 'Body text.');
});

test('removes multiple injected lines in a single copy', () => {
  const input = [
    'Keep me one.',
    'This material is from Coursera.',
    'Keep me two.',
    'Copyright 2025 Some Org.',
    '(c) 2025 Another Org',
    'Keep me three.',
  ].join('\n');
  const expected = [
    'Keep me one.',
    'Keep me two.',
    'Keep me three.',
  ].join('\n');
  assert.equal(cleanCopiedText(input), expected);
});

test('trims trailing whitespace and newlines from the final result', () => {
  const input = 'Some content.\n\n   \nCopyright 2025 Foo\n   \n';
  assert.equal(cleanCopiedText(input), 'Some content.');
});

test('preserves blank lines that are between kept content (does not collapse paragraphs)', () => {
  const input = [
    'Paragraph one.',
    '',
    'Paragraph two.',
  ].join('\n');
  assert.equal(cleanCopiedText(input), input);
});

test('does not remove a line just because a keyword appears inside an unrelated word', () => {
  // "right" should not trigger the "copyright" rule.
  const input = 'You have the right to remain silent.';
  assert.equal(cleanCopiedText(input), input);
});

test('handles Windows-style CRLF line endings', () => {
  const input = 'Keep this.\r\nCopyright 2025 Org\r\nKeep this too.';
  assert.equal(cleanCopiedText(input), 'Keep this.\nKeep this too.');
});

test('returns empty string when every line is junk', () => {
  const input = 'Copyright 2025 Org\n(c) 2025 Org\nThis material is from Coursera.';
  assert.equal(cleanCopiedText(input), '');
});
