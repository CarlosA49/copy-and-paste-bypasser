// tests/module-scraper.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
  scrapeModule,
  extractCourseId,
  extractItemId,
  classifyKind,
} = require('../lib/module-scraper.js');

function dom(html, url) {
  return new JSDOM(
    '<!doctype html><html><body>' + html + '</body></html>',
    { url: url || 'https://www.coursera.org/learn/test-course/home/week/3' }
  ).window.document;
}

test('extractCourseId pulls slug from /learn/<slug>/...', () => {
  assert.equal(extractCourseId('https://www.coursera.org/learn/ml-intro/home/week/1'), 'ml-intro');
  assert.equal(extractCourseId('https://www.coursera.org/learn/deep-nets/lecture/abc123/title'), 'deep-nets');
  assert.equal(extractCourseId('https://www.coursera.org/about'), null);
});

test('extractItemId pulls itemId from /<kind>/<itemId>', () => {
  assert.equal(extractItemId('https://www.coursera.org/learn/x/lecture/abc123/intro'), 'abc123');
  assert.equal(extractItemId('https://www.coursera.org/learn/x/supplement/r9X/reading'), 'r9X');
  assert.equal(extractItemId('https://www.coursera.org/learn/x/discussionPrompt/d22/prompt'), 'd22');
  assert.equal(extractItemId('https://www.coursera.org/learn/x/home/week/2'), null);
});

test('classifyKind maps URL segments', () => {
  assert.equal(classifyKind('/learn/x/lecture/abc/x'), 'video');
  assert.equal(classifyKind('/learn/x/supplement/abc/x'), 'reading');
  assert.equal(classifyKind('/learn/x/discussionPrompt/abc/x'), 'discussion');
  assert.equal(classifyKind('/learn/x/quiz/abc'), 'quiz');
  assert.equal(classifyKind('/learn/x/exam/abc'), 'quiz');
  assert.equal(classifyKind('/learn/x/assignment/abc'), 'quiz');
  assert.equal(classifyKind('/learn/x/peer/abc'), 'peer-review');
  assert.equal(classifyKind('/learn/x/programming/abc'), 'programming');
  assert.equal(classifyKind('/learn/x/whatever/abc'), 'other');
});

test('scrapeModule returns empty list when container missing', () => {
  const d = dom('<div>no module sidebar</div>');
  const r = scrapeModule(d);
  assert.deepEqual(r.items, []);
  assert.equal(r.courseId, 'test-course');
});

test('scrapeModule extracts item rows via data-testid container', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/v1/intro">Intro Video</a>' +
      '<a href="/learn/test-course/supplement/r1/reading-a">Reading A</a>' +
      '<a href="/learn/test-course/discussionPrompt/d1/prompt">Discuss</a>' +
      '<a href="/learn/test-course/quiz/q1">Quiz</a>' +
    '</div>',
    'https://www.coursera.org/learn/test-course/lecture/v1/intro'
  );
  const r = scrapeModule(d);
  assert.equal(r.items.length, 4);
  assert.equal(r.items[0].id, 'v1');
  assert.equal(r.items[0].kind, 'video');
  assert.equal(r.items[0].title, 'Intro Video');
  assert.equal(r.items[1].kind, 'reading');
  assert.equal(r.items[2].kind, 'discussion');
  assert.equal(r.items[3].kind, 'quiz');
  // URLs preserved verbatim.
  assert.ok(r.items[0].url.indexOf('/learn/test-course/lecture/v1') !== -1);
});

test('scrapeModule falls back to rc-LessonCollection class', () => {
  const d = dom(
    '<div class="rc-LessonCollection">' +
      '<a href="/learn/test-course/lecture/v1/intro">Intro</a>' +
    '</div>'
  );
  assert.equal(scrapeModule(d).items.length, 1);
});

test('scrapeModule detects per-item completed flag', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/v1/x">A<span aria-label="Completed"></span></a>' +
      '<a href="/learn/test-course/lecture/v2/y">B</a>' +
    '</div>'
  );
  const r = scrapeModule(d);
  assert.equal(r.items[0].completed, true);
  assert.equal(r.items[1].completed, false);
});

test('scrapeModule deduplicates items by id (sidebar can render the same id twice)', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/v1/x">A</a>' +
      '<a href="/learn/test-course/lecture/v1/x">A again</a>' +
    '</div>'
  );
  const r = scrapeModule(d);
  assert.equal(r.items.length, 1);
});

test('scrapeModule moduleId reflects /home/week/<n> when present', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/v1/x">A</a>' +
    '</div>',
    'https://www.coursera.org/learn/test-course/home/week/4'
  );
  const r = scrapeModule(d);
  assert.equal(r.moduleId, 'week-4');
});

const { findItemCompletionIndicator } = require('../lib/module-scraper.js');

test('findItemCompletionIndicator returns the indicator element when the item is completed', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/v1/x">A<span aria-label="Completed"></span></a>' +
      '<a href="/learn/test-course/lecture/v2/y">B</a>' +
    '</div>'
  );
  const el = findItemCompletionIndicator(d, 'v1');
  assert.ok(el, 'should return the completion indicator element for v1');
  assert.equal(el.getAttribute('aria-label'), 'Completed');
});

test('findItemCompletionIndicator returns null when the item is not completed', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/v1/x">A</a>' +
    '</div>'
  );
  assert.equal(findItemCompletionIndicator(d, 'v1'), null);
});

test('findItemCompletionIndicator returns null when the item is not in the sidebar at all', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/v1/x">A<span aria-label="Completed"></span></a>' +
    '</div>'
  );
  assert.equal(findItemCompletionIndicator(d, 'v999'), null);
});

test('findItemCompletionIndicator works with the rc-Completed class fallback selector', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/v1/x">A<span class="rc-Completed"></span></a>' +
    '</div>'
  );
  const el = findItemCompletionIndicator(d, 'v1');
  assert.ok(el);
});

test('scrapeModule picks the container that holds the current URL item', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/m1v1/intro">M1V1</a>' +
      '<a href="/learn/test-course/lecture/m1v2/two">M1V2</a>' +
    '</div>' +
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/m2v1/three">M2V1</a>' +
      '<a href="/learn/test-course/lecture/m2v2/four">M2V2</a>' +
    '</div>',
    'https://www.coursera.org/learn/test-course/lecture/m2v1/three'
  );
  const r = scrapeModule(d);
  assert.equal(r.items.length, 2, 'should pick the module containing the current item');
  assert.equal(r.items[0].id, 'm2v1');
  assert.equal(r.items[1].id, 'm2v2');
});

test('scrapeModule falls back to the first non-empty container when current item is in none', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/m1v1/intro">M1V1</a>' +
    '</div>' +
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/m2v1/three">M2V1</a>' +
    '</div>',
    'https://www.coursera.org/learn/test-course/home/week/1'
  );
  const r = scrapeModule(d);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, 'm1v1');
});

test('scrapeModule still works when only one container is present (back-compat)', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/v1/intro">V1</a>' +
      '<a href="/learn/test-course/lecture/v2/two">V2</a>' +
    '</div>',
    'https://www.coursera.org/learn/test-course/lecture/v1/intro'
  );
  const r = scrapeModule(d);
  assert.equal(r.items.length, 2);
});

const { scrapeModuleDiagnostics } = require('../lib/module-scraper.js');

test('scrapeModuleDiagnostics lists candidate containers and whether each matched', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/v1/intro">Intro</a>' +
    '</div>'
  );
  const diag = scrapeModuleDiagnostics(d);
  assert.ok(Array.isArray(diag.containerCandidates));
  const hit = diag.containerCandidates.find(function (c) { return c.selector === '[data-testid="lesson-collection"]'; });
  assert.ok(hit, 'legacy selector should be listed');
  assert.equal(hit.matched, true);
  assert.equal(hit.itemCount, 1);
});

test('scrapeModuleDiagnostics reports zero matches when no containers are present', () => {
  const d = dom('<div>nothing useful here</div>');
  const diag = scrapeModuleDiagnostics(d);
  assert.equal(diag.containerCandidates.every(function (c) { return c.matched === false; }), true);
  assert.equal(diag.totalItemsFound, 0);
});
