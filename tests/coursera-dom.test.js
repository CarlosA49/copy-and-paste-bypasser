// tests/coursera-dom.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
  parseLearnUrl,
  classifyKind,
  parseItemAccessibleName,
  itemStatus,
  isExcludedNode,
  assessmentRoot,
  withinAssessment,
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

test('parseItemAccessibleName parses the four-token grammar (no lock reason)', () => {
  assert.deepEqual(
    parseItemAccessibleName('Reading, Recommended Textbook, Completed, 10 min'),
    { kindToken: 'Reading', title: 'Recommended Textbook', status: 'completed', lockReason: null, durationText: '10 min' }
  );
  assert.deepEqual(
    parseItemAccessibleName('Video, Scripts, Not submitted, 4 min'),
    { kindToken: 'Video', title: 'Scripts', status: 'not-submitted', lockReason: null, durationText: '4 min' }
  );
  assert.deepEqual(
    parseItemAccessibleName('Ungraded Plugin, Completing MATLAB Programming Assignments, Not submitted, 15 min'),
    { kindToken: 'Ungraded Plugin', title: 'Completing MATLAB Programming Assignments', status: 'not-submitted', lockReason: null, durationText: '15 min' }
  );
});

test('parseItemAccessibleName parses the five-token grammar with an optional lock reason', () => {
  assert.deepEqual(
    parseItemAccessibleName('Reading, Solution to valid_date, Locked, Complete previous item to unlock, 10 min'),
    { kindToken: 'Reading', title: 'Solution to valid_date', status: 'locked', lockReason: 'Complete previous item to unlock', durationText: '10 min' }
  );
});

test('parseItemAccessibleName keeps a title that itself contains a colon', () => {
  assert.deepEqual(
    parseItemAccessibleName('Graded App Item, Assignment: MATLAB Calculation, Not submitted, 15 min'),
    { kindToken: 'Graded App Item', title: 'Assignment: MATLAB Calculation', status: 'not-submitted', lockReason: null, durationText: '15 min' }
  );
});

test('parseItemAccessibleName returns null for empty/garbage input', () => {
  assert.equal(parseItemAccessibleName(''), null);
  assert.equal(parseItemAccessibleName(null), null);
  assert.equal(parseItemAccessibleName('JustOneToken'), null);
});

test('itemStatus maps a status string to the canonical vocabulary', () => {
  assert.equal(itemStatus('Reading, Syllabus, Completed, 10 min'), 'completed');
  assert.equal(itemStatus('Video, Scripts, Not submitted, 4 min'), 'not-submitted');
  assert.equal(itemStatus('Reading, X, Locked, Complete previous item to unlock, 10 min'), 'locked');
  assert.equal(itemStatus('Something with no recognizable status'), 'unknown');
});

test('itemStatus reads an element accessible-name (aria-label) when given a node', () => {
  const d = dom('<a aria-label="Video, Introduction, Completed, 12 min" href="/learn/matlab/lecture/v1/intro">Intro</a>');
  const a = d.querySelector('a');
  assert.equal(itemStatus(a), 'completed');
});

test('isExcludedNode excludes the extension sidebar host (#ccp-host-root) and its subtree', () => {
  const d = dom(
    '<div id="ccp-host-root"><div class="ccp-host">' +
      '<input name="ccp-behavior" type="radio">' +
      '<textarea placeholder="Paste or type text...">x</textarea>' +
    '</div></div>' +
    '<main><input type="radio" name="q1"></main>'
  );
  assert.equal(isExcludedNode(d.getElementById('ccp-host-root')), true);
  assert.equal(isExcludedNode(d.querySelector('input[name="ccp-behavior"]')), true);
  assert.equal(isExcludedNode(d.querySelector('textarea')), true);
  assert.equal(isExcludedNode(d.querySelector('main input[name="q1"]')), false);
});

test('isExcludedNode excludes a .ccp-host subtree even without the #ccp-host-root id (inlined shadow content)', () => {
  const d = dom('<div class="ccp-host"><button>Autopilot</button></div><main><button>Submit</button></main>');
  assert.equal(isExcludedNode(d.querySelector('.ccp-host button')), true);
  assert.equal(isExcludedNode(d.querySelector('main button')), false);
});

test('isExcludedNode excludes the Boost support chat composer and panel', () => {
  const d = dom(
    '<div id="boostai-chat-panel-composer">' +
      '<textarea placeholder="Ask your question here"></textarea>' +
      '<button>Send</button>' +
    '</div>' +
    '<div class="Boost-ChatPanel-foo"><button>X</button></div>' +
    '<button data-testid="coach-chat-launcher-button">Chat</button>' +
    '<main><button>Submit</button></main>'
  );
  assert.equal(isExcludedNode(d.querySelector('#boostai-chat-panel-composer textarea')), true);
  assert.equal(isExcludedNode(d.querySelector('#boostai-chat-panel-composer button')), true);
  assert.equal(isExcludedNode(d.querySelector('.Boost-ChatPanel-foo button')), true);
  assert.equal(isExcludedNode(d.querySelector('[data-testid="coach-chat-launcher-button"]')), true);
  assert.equal(isExcludedNode(d.querySelector('main button')), false);
});

test('isExcludedNode is safe on null and non-element input', () => {
  assert.equal(isExcludedNode(null), false);
  assert.equal(isExcludedNode(undefined), false);
});

test('assessmentRoot returns main when present and excludes nav/aside/extension/chat', () => {
  const d = dom(
    '<nav><a href="/learn/x/quiz/q1">Quiz</a></nav>' +
    '<div id="ccp-host-root"><input name="ccp-behavior" type="radio"></div>' +
    '<main id="real"><fieldset><input type="radio" name="q1"></fieldset></main>'
  );
  const r = assessmentRoot(d);
  assert.ok(r);
  assert.equal(r.id, 'real');
});

test('withinAssessment is true for a node inside the assessment root and false for excluded/nav nodes', () => {
  const d = dom(
    '<nav><button id="nav-btn">Nav</button></nav>' +
    '<div class="ccp-host"><button id="ext-btn">Ext</button></div>' +
    '<main><button id="ok-btn">Submit</button></main>'
  );
  assert.equal(withinAssessment(d.getElementById('ok-btn')), true);
  assert.equal(withinAssessment(d.getElementById('ext-btn')), false);
  assert.equal(withinAssessment(d.getElementById('nav-btn')), false);
});
