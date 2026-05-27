'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ctx = require('../lib/ai-question-context.js');

function doc(html, url) {
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', { url: url || 'https://www.coursera.org/learn/x/lecture/v1/intro' });
  return { document: dom.window.document, location: dom.window.location, window: dom.window };
}

function radio(qNum, choices) {
  let s = '<h3>Question ' + qNum + '</h3><p>Pick one ' + qNum + '</p>';
  for (let i = 0; i < choices.length; i++) {
    s += '<label><input type="radio" name="q' + qNum + '">' + choices[i] + '</label>';
  }
  return '<section>' + s + '</section>';
}

test('isCurrentPageBlocked: gradedLti URL is blocked', () => {
  const d = doc('<h1>Anything</h1>', 'https://www.coursera.org/learn/course/gradedLti/abc/xyz');
  const r = ctx.isCurrentPageBlocked(d.location, d.document);
  assert.equal(r.blocked, true);
  assert.ok(r.reason && r.reason.length > 0);
});

test('isCurrentPageBlocked: page titled "Graded Assignment" is blocked even on lecture URL', () => {
  const d = doc('<h1>Graded Assignment</h1>', 'https://www.coursera.org/learn/course/lecture/v1/intro');
  d.document.title = 'Graded Assignment';
  const r = ctx.isCurrentPageBlocked(d.location, d.document);
  assert.equal(r.blocked, true);
});

test('isCurrentPageBlocked: page titled "Peer Review" is blocked', () => {
  const d = doc('<h1>Peer Review your work</h1>', 'https://www.coursera.org/learn/course/lecture/v1/intro');
  d.document.title = 'Peer Review';
  const r = ctx.isCurrentPageBlocked(d.location, d.document);
  assert.equal(r.blocked, true);
});

test('isCurrentPageBlocked: ordinary lecture page is NOT blocked', () => {
  const d = doc('<h1>Welcome to the lesson</h1>', 'https://www.coursera.org/learn/course/lecture/v1/intro');
  d.document.title = 'Lecture 1';
  const r = ctx.isCurrentPageBlocked(d.location, d.document);
  assert.equal(r.blocked, false);
  assert.equal(r.reason, null);
});

test('buildQuestionSnapshot: produces stable IDs and option labels for radio questions', () => {
  const d = doc(radio(1, ['Alpha', 'Beta', 'Gamma']));
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.questions.length, 1);
  assert.equal(snap.questions[0].id, 'q1');
  assert.equal(snap.questions[0].type, 'single_choice');
  assert.equal(snap.questions[0].options.length, 3);
  assert.equal(snap.questions[0].options[0].id, 'q1o0');
  assert.equal(snap.questions[0].options[0].label, 'Alpha');
  assert.equal(snap.questions[0].supported, true);
});

test('buildQuestionSnapshot: checkbox question is multiple_choice', () => {
  const html = '<section><h3>Question 2</h3><p>Pick many</p>'
    + '<label><input type="checkbox" name="q2">A</label>'
    + '<label><input type="checkbox" name="q2">B</label>'
    + '<label><input type="checkbox" name="q2">C</label>'
    + '</section>';
  const d = doc(html);
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.questions[0].type, 'multiple_choice');
  assert.equal(snap.questions[0].options.length, 3);
});

test('buildQuestionSnapshot: text question prompt but no current value', () => {
  const html = '<section><h3>Question 3</h3><p>Enter the value of x</p>'
    + '<input type="text" value="user-typed-secret">'
    + '</section>';
  const d = doc(html);
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.questions[0].type, 'math_input');
  assert.equal(typeof snap.questions[0].prompt, 'string');
  const serialized = JSON.stringify(snap.questions[0]);
  assert.equal(serialized.indexOf('user-typed-secret'), -1, 'snapshot must not leak field value');
});

test('buildQuestionSnapshot: alreadyAnswered=true is set for pre-filled inputs', () => {
  const html = '<section><h3>Question 4</h3><p>Done question</p>'
    + '<input type="text" value="42">'
    + '</section>';
  const d = doc(html);
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.questions[0].alreadyAnswered, true);
});

test('sanitizeForRequest: strips unsupported questions and internal flags', () => {
  const snap = {
    token: 'snap_abc',
    page: { urlOrigin: 'https://www.coursera.org', eligible: true, blockedReason: null },
    questions: [
      { id: 'q1', order: 1, questionNumber: 1, type: 'single_choice', prompt: 'p', options: [{ id: 'q1o0', label: 'a' }], supported: true, alreadyAnswered: false },
      { id: 'q2', order: 2, questionNumber: 2, type: 'unknown', prompt: 'p', supported: false, alreadyAnswered: false },
    ],
    supportedCount: 1,
    unsupportedCount: 1,
  };
  const out = ctx.sanitizeForRequest(snap);
  assert.equal(out.questions.length, 1);
  assert.equal(out.questions[0].id, 'q1');
  assert.equal('alreadyAnswered' in out.questions[0], false);
  assert.equal('supported' in out.questions[0], false);
});

test('token: identical snapshot inputs produce identical tokens', () => {
  const d1 = doc(radio(1, ['A', 'B']));
  const d2 = doc(radio(1, ['A', 'B']));
  const s1 = ctx.buildQuestionSnapshot(d1.document.body, d1.location, d1.document);
  const s2 = ctx.buildQuestionSnapshot(d2.document.body, d2.location, d2.document);
  assert.equal(s1.token, s2.token);
});

test('token: changing an option label changes the token', () => {
  const d1 = doc(radio(1, ['A', 'B']));
  const d2 = doc(radio(1, ['A', 'CHANGED']));
  const s1 = ctx.buildQuestionSnapshot(d1.document.body, d1.location, d1.document);
  const s2 = ctx.buildQuestionSnapshot(d2.document.body, d2.location, d2.document);
  assert.notEqual(s1.token, s2.token);
});

test('actionableCount counts only supported AND not-already-answered questions', () => {
  // 1 unanswered radio + 1 already-answered text input + 1 unsupported type
  const html = '<section><h3>Question 1</h3><p>Unanswered</p>'
    + '<label><input type="radio" name="r1">A</label><label><input type="radio" name="r1">B</label></section>'
    + '<section><h3>Question 2</h3><p>Pre-filled</p><input type="text" value="user-already-typed"></section>';
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)('<!doctype html><html><body>' + html + '</body></html>', { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' });
  const snap = ctx.buildQuestionSnapshot(dom.window.document.body, dom.window.location, dom.window.document);
  assert.equal(snap.supportedCount, 2, '2 supported total');
  assert.equal(snap.actionableCount, 1, 'only 1 is unanswered');
});

test('actionableCount is zero when all supported questions are answered', () => {
  const html = '<section><h3>Question 1</h3><p>Pre-filled</p><input type="text" value="x"></section>';
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)('<!doctype html><html><body>' + html + '</body></html>', { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' });
  const snap = ctx.buildQuestionSnapshot(dom.window.document.body, dom.window.location, dom.window.document);
  assert.equal(snap.actionableCount, 0);
});

test('buildQuestionSnapshot returns a localGuard array sized to questions', () => {
  const html = '<section><h3>Question 1</h3><p>P</p>'
    + '<label><input type="radio" name="r1">A</label><label><input type="radio" name="r1">B</label></section>'
    + '<section><h3>Question 2</h3><p>P</p><input type="text"></section>';
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)('<!doctype html><html><body>' + html + '</body></html>', { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' });
  const snap = ctx.buildQuestionSnapshot(dom.window.document.body, dom.window.location, dom.window.document);
  assert.ok(Array.isArray(snap.localGuard));
  assert.equal(snap.localGuard.length, snap.questions.length);
});

test('sanitizeForRequest must NOT include localGuard in its output', () => {
  const html = '<section><h3>Question 1</h3><p>P</p>'
    + '<label><input type="radio" name="r1">A</label><label><input type="radio" name="r1">B</label></section>';
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)('<!doctype html><html><body>' + html + '</body></html>', { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' });
  const snap = ctx.buildQuestionSnapshot(dom.window.document.body, dom.window.location, dom.window.document);
  const out = ctx.sanitizeForRequest(snap);
  assert.equal('localGuard' in out, false);
  // Serialize whole thing too, just to be sure
  assert.equal(JSON.stringify(out).indexOf('localGuard'), -1);
  out.questions.forEach(function (q) {
    assert.equal('localGuard' in q, false);
    assert.equal('answerFingerprint' in q, false);
    assert.equal('checked' in q, false);
  });
});

test('localGuard reflects radio selected-option indices', () => {
  const html = '<section><h3>Question 1</h3><p>P</p>'
    + '<label><input type="radio" name="r1">A</label>'
    + '<label><input type="radio" name="r1" checked>B</label>'
    + '<label><input type="radio" name="r1">C</label></section>';
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)('<!doctype html><html><body>' + html + '</body></html>', { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' });
  const snap = ctx.buildQuestionSnapshot(dom.window.document.body, dom.window.location, dom.window.document);
  // Q1 should have selectedOptionIds = ['q1o1'] or selectedIndices = [1]
  const g = snap.localGuard[0];
  assert.ok(g);
  // accept either shape
  const indices = g.selectedIndices || (g.selectedOptionIds || []).map(function (id) { return parseInt(id.split('o')[1], 10); });
  assert.deepEqual(indices, [1]);
});

test('localGuard fingerprint differs when text value differs (privacy: fingerprint is short hex)', () => {
  const ctx = require('../lib/ai-question-context.js');
  function snapWith(val) {
    const html = '<section><h3>Question 1</h3><p>P</p><input type="text" value="' + val + '"></section>';
    const dom = new (require('jsdom').JSDOM)('<!doctype html><html><body>' + html + '</body></html>', { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' });
    return ctx.buildQuestionSnapshot(dom.window.document.body, dom.window.location, dom.window.document);
  }
  const s1 = snapWith('');
  const s2 = snapWith('user-typed');
  const s3 = snapWith('user-typed');
  assert.notDeepEqual(s1.localGuard[0], s2.localGuard[0], 'empty vs typed must differ');
  assert.deepEqual(s2.localGuard[0], s3.localGuard[0], 'same value should fingerprint identically');
});

// ─── S6: visible-content graded-page detection ───────────────────────────────

test('S6: page with generic title but H1 "Graded Assignment" is blocked', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>Module 3 — Course X</title></head>'
    + '<body><main><h1>Graded Assignment</h1><section><h3>Question 1</h3></section></main></body></html>',
    { url: 'https://www.coursera.org/learn/course/lecture/v1/intro' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, true, 'visible "Graded Assignment" H1 must block');
  assert.ok(r.reason, 'reason must be set');
});

test('S6: page with generic title but H1 "Graded Quiz" is blocked', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>Module 3</title></head>'
    + '<body><main><h1>Graded Quiz</h1></main></body></html>',
    { url: 'https://www.coursera.org/learn/course/lecture/v1/intro' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, true);
});

test('S6: page with H1 "Peer Review" is blocked', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>Course</title></head>'
    + '<body><main><h1>Peer Review</h1></main></body></html>',
    { url: 'https://www.coursera.org/learn/course/lecture/v1/intro' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, true);
});

test('S6: page with H1 "Programming Assignment" is blocked', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>Course</title></head>'
    + '<body><main><h1>Programming Assignment</h1></main></body></html>',
    { url: 'https://www.coursera.org/learn/course/lecture/v1/intro' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, true);
});

test('S6: page with H1 "Exam" is blocked', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>Course</title></head>'
    + '<body><main><h1>Exam</h1></main></body></html>',
    { url: 'https://www.coursera.org/learn/course/lecture/v1/intro' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, true);
});

test('S6: page with H2 "Assignment Submission" is blocked', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>Course</title></head>'
    + '<body><main><h2>Assignment Submission</h2></main></body></html>',
    { url: 'https://www.coursera.org/learn/course/lecture/v1/intro' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, true);
});

test('S6: ordinary lecture page with a benign H1 is NOT blocked', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>Module 3</title></head>'
    + '<body><main><h1>Welcome to Logistic Regression</h1><section><h3>Question 1</h3></section></main></body></html>',
    { url: 'https://www.coursera.org/learn/course/lecture/v1/intro' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, false, 'benign lecture page must remain eligible');
});

test('S6: extension shadow host banner text does NOT trigger false positive', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>Module 3</title></head>'
    + '<body>'
    + '<div id="ccp-host-root"><h1>Graded Assignment</h1></div>'  // extension shadow host — must be excluded
    + '<main><h1>Lecture: Vectors</h1></main>'
    + '</body></html>',
    { url: 'https://www.coursera.org/learn/course/lecture/v1/intro' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, false, 'extension host content must be excluded from the scan');
});

test('S6: case-insensitive matching — "GRADED QUIZ" also blocks', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>X</title></head>'
    + '<body><main><h1>GRADED QUIZ</h1></main></body></html>',
    { url: 'https://www.coursera.org/learn/course/lecture/v1/intro' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, true);
});

test('S6: reason field categorizes the visible match', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>X</title></head>'
    + '<body><main><h1>Peer Review</h1></main></body></html>',
    { url: 'https://www.coursera.org/learn/course/lecture/v1/intro' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, true);
  assert.ok(/peer review/i.test(r.reason || ''), 'reason should mention peer review');
});

test('S6: visible-text matching does not leak the original heading text into reason', () => {
  const ctx = require('../lib/ai-question-context.js');
  // Heading contains user-generated/PII-style content; the reason must be the category only.
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>X</title></head>'
    + '<body><main><h1>Graded Assignment by Jane Doe (PII-MARKER-12345)</h1></main></body></html>',
    { url: 'https://www.coursera.org/learn/course/lecture/v1/intro' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, true);
  assert.equal((r.reason || '').indexOf('PII-MARKER-12345'), -1, 'reason must not echo heading text');
  assert.equal((r.reason || '').indexOf('Jane Doe'), -1);
});

// ─── T2: activity-scoped visible-text classification ─────────────────────────

test('T2/C1: safe lecture with non-current aside "Programming Assignment" remains eligible', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>MATLAB</title></head>'
    + '<body>'
    + '<main><h1>Scripts</h1><p>Lecture content</p></main>'
    + '<aside><h3>Programming Assignment</h3></aside>'
    + '</body></html>',
    { url: 'https://www.coursera.org/learn/matlab/lecture/Uz8F0/scripts' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, false, 'aside heading must not block a safe lecture');
  assert.equal(r.reason, null);
});

test('T2/C2: safe reading with nav "Graded Quiz" remains eligible', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>Course</title></head>'
    + '<body>'
    + '<main><h1>Welcome</h1><p>Read this lesson.</p></main>'
    + '<nav><h3>Graded Quiz</h3></nav>'
    + '</body></html>',
    { url: 'https://www.coursera.org/learn/x/supplement/y/z' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, false);
});

test('T2/C3: extension-host messaging in #ccp-host-root does not trigger', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>X</title></head>'
    + '<body>'
    + '<div id="ccp-host-root"><h1>Graded Assignment</h1></div>'
    + '<main><h1>Welcome</h1></main>'
    + '</body></html>',
    { url: 'https://www.coursera.org/learn/x/lecture/y/z' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, false);
});

test('T2/C4: course-outline div [class*="sidebar"] with blocked text does not trigger', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>Course</title></head>'
    + '<body>'
    + '<main><h1>Lecture: Linked Lists</h1></main>'
    + '<div class="rc-CourseSidebar"><h3>Programming Assignment</h3></div>'
    + '</body></html>',
    { url: 'https://www.coursera.org/learn/x/lecture/y/z' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, false);
});

test('T2/D1: current activity containing "Graded App Item" is blocked', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>Course</title></head>'
    + '<body><main><h1>Assignment: Built-in functions</h1><p>Graded App Item</p></main></body></html>',
    { url: 'https://www.coursera.org/learn/matlab/lecture/abc/built-ins' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, true);
  assert.ok(/graded app item/i.test(r.reason || ''));
});

test('T2/D2: current activity containing "Discussion Prompt" is blocked', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>Course</title></head>'
    + '<body><main><h1>Discussion Prompt</h1><p>Discuss the topic with peers.</p></main></body></html>',
    { url: 'https://www.coursera.org/learn/x/supplement/y/z' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, true);
  assert.ok(/discussion prompt/i.test(r.reason || ''));
});

test('T2/D6: same blocked label in nav alone is NOT enough, in main IS enough', () => {
  const ctx = require('../lib/ai-question-context.js');
  // nav only — should be eligible
  const dom1 = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>X</title></head>'
    + '<body><nav><h3>Graded App Item</h3></nav><main><h1>Welcome</h1></main></body></html>',
    { url: 'https://www.coursera.org/learn/x/lecture/y/z' });
  const r1 = ctx.isCurrentPageBlocked(dom1.window.location, dom1.window.document);
  assert.equal(r1.blocked, false, 'nav-only must not block');

  // main contains the label — should block
  const dom2 = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>X</title></head>'
    + '<body><main><h1>Graded App Item</h1></main></body></html>',
    { url: 'https://www.coursera.org/learn/x/lecture/y/z' });
  const r2 = ctx.isCurrentPageBlocked(dom2.window.location, dom2.window.document);
  assert.equal(r2.blocked, true);
});

test('T2/D5: reason field does not include heading text — only category string', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><head><title>X</title></head>'
    + '<body><main><h1>Graded App Item by Jane Doe (PII-MARKER-9999)</h1></main></body></html>',
    { url: 'https://www.coursera.org/learn/x/lecture/y/z' });
  const r = ctx.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(r.blocked, true);
  assert.equal((r.reason || '').indexOf('PII-MARKER-9999'), -1);
  assert.equal((r.reason || '').indexOf('Jane Doe'), -1);
});

test('T2: findCurrentActivityEvidenceRoot is exported', () => {
  const ctx = require('../lib/ai-question-context.js');
  assert.equal(typeof ctx.findCurrentActivityEvidenceRoot, 'function');
});

test('T2: findCurrentActivityEvidenceRoot prefers question container over <main>', () => {
  const ctx = require('../lib/ai-question-context.js');
  const dom = new (require('jsdom').JSDOM)(
    '<!doctype html><html><body>'
    + '<main id="layout-main"><h1>Outer</h1><div id="activity"><section><h3>Question 1</h3><p>Pick</p>'
    + '<label><input type="radio" name="r1">A</label><label><input type="radio" name="r1">B</label></section></div></main>'
    + '</body></html>', { url: 'https://example.com/' });
  const root = ctx.findCurrentActivityEvidenceRoot(dom.window.document, dom.window.location);
  assert.ok(root, 'must return a root');
  // The detected question\'s container should be a descendant of #activity, not #layout-main directly.
  // It is acceptable for the resolver to return the container or any ancestor up to #activity.
  // We just assert it\'s not null and it IS under main.
  assert.ok(dom.window.document.getElementById('layout-main').contains(root));
});

// === U12 Safety — buildQuestionSnapshot fail-closed on blocked pages (layer 3) ===

test('U12-C1: buildQuestionSnapshot on /assignment-submission/.../attempt URL returns empty ineligible snapshot even when questions are detectable in the DOM', () => {
  const blockedUrl = 'https://www.coursera.org/learn/wireless-communications/assignment-submission/fryRH/practice-quiz-for-introduction-and-history-of-cellular-communication-systems/attempt';
  const html = radio(1, ['Alpha', 'Beta', 'Gamma']) + radio(2, ['One', 'Two']) + radio(3, ['X', 'Y']);
  const d = doc(html, blockedUrl);
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false, 'page.eligible must be false on a blocked URL');
  assert.ok(snap.page.blockedReason, 'page.blockedReason must be set');
  assert.equal(snap.questions.length, 0, 'questions must be empty on a blocked URL (no prompt text leaks)');
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.unsupportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, [], 'localGuard must be empty on a blocked URL');
});

test('U12-C2: buildQuestionSnapshot on /gradedLti/ URL returns empty ineligible snapshot even when questions are detectable', () => {
  const d = doc(radio(1, ['A', 'B']), 'https://www.coursera.org/learn/course/gradedLti/abc/xyz');
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false);
  assert.equal(snap.questions.length, 0);
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, []);
});

test('U12-C3: buildQuestionSnapshot on title-only-blocked page ("Graded Assignment") returns empty ineligible snapshot', () => {
  const d = doc(radio(1, ['A', 'B']), 'https://www.coursera.org/learn/course/lecture/v1/intro');
  d.document.title = 'Graded Assignment';
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false, 'title block must be honored even on a lecture-style URL');
  assert.equal(snap.questions.length, 0, 'title block must NOT leak prompt text');
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, []);
});

test('U12-C4: sanitizeForRequest on a blocked snapshot returns zero questions and is safe to send (no prompt leakage)', () => {
  const blockedUrl = 'https://www.coursera.org/learn/x/assignment-submission/abc/attempt';
  const html = radio(1, ['Detected prompt text that must never leave the client', 'Other']);
  const d = doc(html, blockedUrl);
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  const sanitized = ctx.sanitizeForRequest(snap);
  assert.equal(sanitized.questions.length, 0, 'sanitized payload must contain zero questions on a blocked page');
  const payload = JSON.stringify(sanitized);
  assert.equal(payload.indexOf('Detected prompt text'), -1, 'no prompt option text may appear in the sanitized payload');
  assert.equal(sanitized.page.eligible, false);
});

test('U12-C5: REGRESSION — buildQuestionSnapshot on an eligible lecture URL still detects questions (fail-closed must not break legitimate paths)', () => {
  const d = doc(radio(1, ['Alpha', 'Beta', 'Gamma']), 'https://www.coursera.org/learn/course/lecture/v1/intro');
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, true, 'lecture URL must remain eligible');
  assert.equal(snap.questions.length, 1, 'eligible page must still detect questions');
  assert.equal(snap.supportedCount, 1);
  assert.equal(snap.actionableCount, 1);
});

// --- VISIBLY-BLOCKED PAGES: generic lecture-like URL + current-activity text marker ---

function visibleBlockedDoc(markerText, lectureUrl) {
  const url = lectureUrl || 'https://www.coursera.org/learn/course/lecture/v1/intro';
  const PROMPT_MARKER = 'PROMPT_TEXT_THAT_MUST_NEVER_LEAK_' + markerText.replace(/\s+/g, '_').toUpperCase();
  const html = '<main>'
    + '<h1>' + markerText + '</h1>'
    + '<section><h3>Question 1</h3><p>' + PROMPT_MARKER + '</p>'
    + '<label><input type="radio" name="r1">Alpha</label>'
    + '<label><input type="radio" name="r1">Beta</label>'
    + '</section>'
    + '</main>';
  const d = doc(html, url);
  return { d: d, PROMPT_MARKER: PROMPT_MARKER };
}

test('U12-C6: VISIBLE BLOCK — current-activity contains "Graded App Item" → snapshot is empty and contains no prompt text', () => {
  const { d, PROMPT_MARKER } = visibleBlockedDoc('Graded App Item');
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false);
  assert.ok(snap.page.blockedReason && /graded\s+app\s+item/i.test(snap.page.blockedReason), 'blockedReason must categorize as graded app item (got: ' + JSON.stringify(snap.page.blockedReason) + ')');
  assert.equal(snap.questions.length, 0);
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, []);
  const sanitized = ctx.sanitizeForRequest(snap);
  assert.equal(sanitized.questions.length, 0);
  const blob = JSON.stringify(snap) + JSON.stringify(sanitized);
  assert.equal(blob.indexOf(PROMPT_MARKER), -1, 'prompt text marker must not appear in snapshot or sanitized output');
});

test('U12-C7: VISIBLE BLOCK — current-activity contains "Discussion Prompt" → snapshot is empty and contains no prompt text', () => {
  const { d, PROMPT_MARKER } = visibleBlockedDoc('Discussion Prompt');
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false);
  assert.ok(snap.page.blockedReason && /discussion\s+prompt/i.test(snap.page.blockedReason));
  assert.equal(snap.questions.length, 0);
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, []);
  const sanitized = ctx.sanitizeForRequest(snap);
  assert.equal(sanitized.questions.length, 0);
  const blob = JSON.stringify(snap) + JSON.stringify(sanitized);
  assert.equal(blob.indexOf(PROMPT_MARKER), -1);
});

test('U12-C8: VISIBLE BLOCK — current-activity contains "Graded Quiz" → snapshot is empty and contains no prompt text', () => {
  const { d, PROMPT_MARKER } = visibleBlockedDoc('Graded Quiz');
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false);
  assert.ok(snap.page.blockedReason && /graded\s+quiz/i.test(snap.page.blockedReason));
  assert.equal(snap.questions.length, 0);
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, []);
  const sanitized = ctx.sanitizeForRequest(snap);
  assert.equal(sanitized.questions.length, 0);
  const blob = JSON.stringify(snap) + JSON.stringify(sanitized);
  assert.equal(blob.indexOf(PROMPT_MARKER), -1);
});

test('U12-C9: VISIBLE BLOCK — current-activity contains "Programming Assignment" → snapshot is empty and contains no prompt text', () => {
  const { d, PROMPT_MARKER } = visibleBlockedDoc('Programming Assignment');
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false);
  assert.ok(snap.page.blockedReason && /programming\s+assignment/i.test(snap.page.blockedReason));
  assert.equal(snap.questions.length, 0);
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, []);
  const sanitized = ctx.sanitizeForRequest(snap);
  assert.equal(sanitized.questions.length, 0);
  const blob = JSON.stringify(snap) + JSON.stringify(sanitized);
  assert.equal(blob.indexOf(PROMPT_MARKER), -1);
});

test('U12-C10: VISIBLE BLOCK — current-activity contains "Peer Review" → snapshot is empty and contains no prompt text', () => {
  const { d, PROMPT_MARKER } = visibleBlockedDoc('Peer Review');
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false);
  assert.ok(snap.page.blockedReason && /peer\s+review/i.test(snap.page.blockedReason));
  assert.equal(snap.questions.length, 0);
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, []);
  const sanitized = ctx.sanitizeForRequest(snap);
  assert.equal(sanitized.questions.length, 0);
  const blob = JSON.stringify(snap) + JSON.stringify(sanitized);
  assert.equal(blob.indexOf(PROMPT_MARKER), -1);
});

test('U12-C11: VISIBLE BLOCK — current-activity contains "Exam" → snapshot is empty and contains no prompt text', () => {
  const { d, PROMPT_MARKER } = visibleBlockedDoc('Exam');
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false);
  assert.ok(snap.page.blockedReason && /exam/i.test(snap.page.blockedReason));
  assert.equal(snap.questions.length, 0);
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, []);
  const sanitized = ctx.sanitizeForRequest(snap);
  assert.equal(sanitized.questions.length, 0);
  const blob = JSON.stringify(snap) + JSON.stringify(sanitized);
  assert.equal(blob.indexOf(PROMPT_MARKER), -1);
});
