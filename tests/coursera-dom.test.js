// tests/coursera-dom.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
  parseLearnUrl,
  classifyKind,
} = require('../lib/coursera-dom.js');

function dom(html, url) {
  return new JSDOM(
    '<!doctype html><html><body>' + html + '</body></html>',
    { url: url || 'https://www.coursera.org/learn/matlab/home/week/1' }
  ).window.document;
}

test('parseLearnUrl decomposes the /learn/{slug}/{kind}/{id}/{itemSlug} grammar', () => {
  assert.deepEqual(
    parseLearnUrl('https://www.coursera.org/learn/matlab/lecture/abc123/intro'),
    { courseSlug: 'matlab', kind: 'lecture', id: 'abc123', itemSlug: 'intro' }
  );
  assert.deepEqual(
    parseLearnUrl('https://www.coursera.org/learn/matlab/ungradedWidget/8h1hv/completing-matlab-programming-assignments'),
    { courseSlug: 'matlab', kind: 'ungradedWidget', id: '8h1hv', itemSlug: 'completing-matlab-programming-assignments' }
  );
  assert.deepEqual(
    parseLearnUrl('https://www.coursera.org/learn/matlab/gradedLti/0OaH5/assignment-echo-generator'),
    { courseSlug: 'matlab', kind: 'gradedLti', id: '0OaH5', itemSlug: 'assignment-echo-generator' }
  );
});

test('parseLearnUrl tolerates a missing itemSlug and query/hash', () => {
  assert.deepEqual(
    parseLearnUrl('/learn/x/quiz/q1'),
    { courseSlug: 'x', kind: 'quiz', id: 'q1', itemSlug: null }
  );
  assert.deepEqual(
    parseLearnUrl('/learn/x/exam/e9?foo=1#frag'),
    { courseSlug: 'x', kind: 'exam', id: 'e9', itemSlug: null }
  );
});

test('parseLearnUrl returns null for non-learn URLs', () => {
  assert.equal(parseLearnUrl('https://www.coursera.org/about'), null);
  assert.equal(parseLearnUrl(''), null);
  assert.equal(parseLearnUrl(null), null);
});

test('classifyKind maps known URL segments and keeps unknown as other', () => {
  assert.equal(classifyKind('/learn/x/lecture/abc/x'), 'video');
  assert.equal(classifyKind('/learn/x/supplement/abc/x'), 'reading');
  assert.equal(classifyKind('/learn/x/discussionPrompt/abc/x'), 'discussion');
  assert.equal(classifyKind('/learn/x/ungradedWidget/abc/x'), 'plugin');
  assert.equal(classifyKind('/learn/x/quiz/abc'), 'quiz');
  assert.equal(classifyKind('/learn/x/exam/abc'), 'exam');
  assert.equal(classifyKind('/learn/x/peer/abc'), 'peer');
  assert.equal(classifyKind('/learn/x/assignment/abc'), 'assignment');
  assert.equal(classifyKind('/learn/x/programming/abc'), 'programming');
  assert.equal(classifyKind('/learn/x/gradedLti/abc'), 'gradedLti');
  assert.equal(classifyKind('/learn/x/home/week/1'), 'home');
  assert.equal(classifyKind('/learn/x/brandNewSegment/abc'), 'other');
});

test('classifyKind accepts a bare segment token', () => {
  assert.equal(classifyKind('lecture'), 'video');
  assert.equal(classifyKind('ungradedWidget'), 'plugin');
  assert.equal(classifyKind('mysteryKind'), 'other');
});

test('classifyKind cross-checks accessibleName when the URL is ambiguous', () => {
  // No usable URL segment, but an accessibleName naming an Ungraded Plugin.
  assert.equal(classifyKind('', 'Ungraded Plugin, Completing MATLAB Programming Assignments, Not submitted, 15 min'), 'plugin');
  assert.equal(classifyKind('', 'Graded App Item, Assignment: MATLAB Calculation, Not submitted, 15 min'), 'gradedLti');
  assert.equal(classifyKind('', 'Video, Scripts, Not submitted, 4 min'), 'video');
  assert.equal(classifyKind('', 'Reading, Syllabus, Completed, 10 min'), 'reading');
});
