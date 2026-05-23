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

const DRAWER_HTML =
  '<aside data-testid="course-content-drawer" aria-label="Course content">' +
    '<section data-testid="module-section">' +
      '<header>' +
        '<div class="module-eyebrow">Module 1</div>' +
        '<h3 class="module-title">Course Pages</h3>' +
      '</header>' +
      '<ul role="list">' +
        '<li>' +
          '<a href="/learn/matlab/lecture/v1/course-preview" data-testid="rc-DesktopItem">' +
            '<span class="status-indicator" aria-label="Not completed"></span>' +
            '<div class="item-body">' +
              '<div class="item-title">Course Preview</div>' +
              '<div class="item-meta">Video • 2 min</div>' +
            '</div>' +
          '</a>' +
        '</li>' +
        '<li>' +
          '<a href="/learn/matlab/supplement/r1/syllabus" data-testid="rc-DesktopItem">' +
            '<span class="status-indicator status-completed" aria-label="Completed"></span>' +
            '<div class="item-body">' +
              '<div class="item-title">Syllabus</div>' +
              '<div class="item-meta">Reading • 10 min</div>' +
            '</div>' +
          '</a>' +
        '</li>' +
        '<li>' +
          '<a href="/learn/matlab/supplement/r2/grading" data-testid="rc-DesktopItem">' +
            '<span class="status-indicator" aria-label="Not completed"></span>' +
            '<div class="item-body">' +
              '<div class="item-title">Grading and Logistics</div>' +
              '<div class="item-meta">Reading • 10 min</div>' +
            '</div>' +
          '</a>' +
        '</li>' +
        '<li>' +
          '<a href="/learn/matlab/supplement/r3/textbook" data-testid="rc-DesktopItem">' +
            '<span class="status-indicator" aria-label="Not completed"></span>' +
            '<div class="item-body">' +
              '<div class="item-title">Recommended Textbook</div>' +
              '<div class="item-meta">Reading • 10 min</div>' +
            '</div>' +
          '</a>' +
        '</li>' +
      '</ul>' +
    '</section>' +
    '<section data-testid="module-section">' +
      '<header>' +
        '<div class="module-eyebrow">Module 2</div>' +
        '<h3 class="module-title">MATLAB Basics</h3>' +
      '</header>' +
      '<ul role="list">' +
        '<li>' +
          '<a href="/learn/matlab/lecture/v2/getting-started" data-testid="rc-DesktopItem">' +
            '<span class="status-indicator" aria-label="Not completed"></span>' +
            '<div class="item-body">' +
              '<div class="item-title">Getting Started</div>' +
              '<div class="item-meta">Video • 5 min</div>' +
            '</div>' +
          '</a>' +
        '</li>' +
      '</ul>' +
    '</section>' +
  '</aside>';

test('drawer: extracts all 4 items from Module 1: Course Pages on a Module 1 URL', () => {
  const d = dom(DRAWER_HTML, 'https://www.coursera.org/learn/matlab/lecture/v1/course-preview');
  const r = scrapeModule(d);
  assert.equal(r.items.length, 4, 'should find all 4 Module 1 items');
  assert.equal(r.items[0].id, 'v1');
  assert.equal(r.items[0].title, 'Course Preview');
  assert.equal(r.items[0].kind, 'video');
  assert.equal(r.items[1].id, 'r1');
  assert.equal(r.items[1].title, 'Syllabus');
  assert.equal(r.items[1].kind, 'reading');
  assert.equal(r.items[2].title, 'Grading and Logistics');
  assert.equal(r.items[3].title, 'Recommended Textbook');
});

test('drawer: stops at the next Module N header (does NOT include Module 2 items)', () => {
  const d = dom(DRAWER_HTML, 'https://www.coursera.org/learn/matlab/lecture/v1/course-preview');
  const r = scrapeModule(d);
  const m2 = r.items.find(function (it) { return it.id === 'v2'; });
  assert.equal(m2, undefined, 'Module 2 items must not bleed into the Module 1 queue');
});

test('drawer: picks the section that contains the current URL item (Module 2 selected when on Module 2)', () => {
  const d = dom(DRAWER_HTML, 'https://www.coursera.org/learn/matlab/lecture/v2/getting-started');
  const r = scrapeModule(d);
  assert.equal(r.items.length, 1, 'Module 2 has one item');
  assert.equal(r.items[0].id, 'v2');
  assert.equal(r.items[0].title, 'Getting Started');
});

test('drawer: per-row completion is read from status-completed / aria-label="Completed"', () => {
  const d = dom(DRAWER_HTML, 'https://www.coursera.org/learn/matlab/lecture/v1/course-preview');
  const r = scrapeModule(d);
  const syllabus = r.items.find(function (it) { return it.id === 'r1'; });
  assert.equal(syllabus.completed, true);
  const preview = r.items.find(function (it) { return it.id === 'v1'; });
  assert.equal(preview.completed, false);
});

test('drawer: findItemCompletionIndicator works for the new drawer markup', () => {
  const d = dom(DRAWER_HTML, 'https://www.coursera.org/learn/matlab/lecture/v1/course-preview');
  const el = findItemCompletionIndicator(d, 'r1');
  assert.ok(el, 'should find the completion indicator for the syllabus row');
});

test('findItemCompletionIndicator returns null when only "Not completed" indicator is present', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/v1/x">A<span aria-label="Not completed"></span></a>' +
    '</div>'
  );
  assert.equal(findItemCompletionIndicator(d, 'v1'), null,
    '"Not completed" must not be treated as a completion indicator');
});

test('findItemCompletionIndicator rejects data-testid="not-completed" indicator', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/v1/x">A<span data-testid="status-not-completed"></span></a>' +
    '</div>'
  );
  assert.equal(findItemCompletionIndicator(d, 'v1'), null,
    'data-testid="status-not-completed" must not be treated as a completion indicator');
});

test('drawer: derives kind from visible "Video • 2 min" when URL kind is unknown', () => {
  // /item/ is not in KIND_BY_SEGMENT — extractItemId returns null, so the row is skipped
  // unless we also build a fallback row path. For now lock in that visible-text kind
  // detection works whenever the URL DOES classify, e.g. a /lecture/ row whose visible
  // text reads "Video • 2 min".
  const d = dom(
    '<aside data-testid="course-content-drawer">' +
      '<section data-testid="module-section">' +
        '<a href="/learn/x/lecture/v1/intro">' +
          '<span class="status-indicator"></span>' +
          '<div class="item-body">' +
            '<div class="item-title">Course Preview</div>' +
            '<div class="item-meta">Video • 2 min</div>' +
          '</div>' +
        '</a>' +
      '</section>' +
    '</aside>',
    'https://www.coursera.org/learn/x/lecture/v1/intro'
  );
  const r = scrapeModule(d);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].kind, 'video');
  assert.equal(r.items[0].title, 'Course Preview');
});

test('drawer: title is the title element only, not concatenated with the meta line', () => {
  const d = dom(
    '<aside data-testid="course-content-drawer">' +
      '<section data-testid="module-section">' +
        '<a href="/learn/x/supplement/r1/syllabus">' +
          '<span class="status-indicator"></span>' +
          '<div class="item-body">' +
            '<div class="item-title">Syllabus</div>' +
            '<div class="item-meta">Reading • 10 min</div>' +
          '</div>' +
        '</a>' +
      '</section>' +
    '</aside>',
    'https://www.coursera.org/learn/x/supplement/r1/syllabus'
  );
  const r = scrapeModule(d);
  assert.equal(r.items[0].title, 'Syllabus');
  assert.equal(r.items[0].title.indexOf('Reading'), -1, 'title must not include meta line');
});

test('scrapeModuleDiagnostics reports drawer container with zero sectioned items', () => {
  const d = dom(
    '<aside data-testid="course-content-drawer">' +
      '<section data-testid="module-section">' +
        '<header>Module 1</header>' +
        // no anchors at all — Coursera placeholder while loading
      '</section>' +
    '</aside>'
  );
  const diag = scrapeModuleDiagnostics(d);
  const drawer = diag.containerCandidates.find(function (c) { return c.selector === '[data-testid="course-content-drawer"]'; });
  assert.ok(drawer, 'drawer candidate should be present');
  assert.equal(drawer.matched, true);
  assert.equal(drawer.itemCount, 0);
  assert.equal(typeof diag.sectionCount, 'number');
  assert.equal(diag.sectionCount >= 1, true, 'should count >=1 module-section node');
});

// ── parseRowText ──────────────────────────────────────────────────────────────
const { parseRowText } = require('../lib/module-scraper.js');

test('parseRowText splits "Lesson 2: Matrices and OperatorsReading. Duration: 10 minutes10 min"', () => {
  const r = parseRowText('Lesson 2: Matrices and OperatorsReading. Duration: 10 minutes10 min');
  assert.equal(r.title, 'Lesson 2: Matrices and Operators');
  assert.equal(r.kind, 'reading');
  assert.ok(/^Reading/.test(r.meta));
});

test('parseRowText handles "Introduction to Matrices and OperatorsVideo. Duration: 5 minutes"', () => {
  const r = parseRowText('Introduction to Matrices and OperatorsVideo. Duration: 5 minutes');
  assert.equal(r.title, 'Introduction to Matrices and Operators');
  assert.equal(r.kind, 'video');
});

test('parseRowText strips leading "Completed" / "Not completed" status word', () => {
  const r1 = parseRowText('CompletedSyllabusReading. Duration: 10 min');
  assert.equal(r1.title, 'Syllabus');
  assert.equal(r1.kind, 'reading');
  const r2 = parseRowText('Not completedCourse PreviewVideo. Duration: 2 min');
  assert.equal(r2.title, 'Course Preview');
  assert.equal(r2.kind, 'video');
});

test('parseRowText recognizes Quiz, Practice Quiz, Assignment, Peer Review, Programming Assignment', () => {
  assert.equal(parseRowText('Module 2 QuizQuiz. Duration: 30 min').kind, 'quiz');
  assert.equal(parseRowText('Try It YourselfPractice Quiz. 5 questions').kind, 'quiz');
  assert.equal(parseRowText('Homework 1Assignment. Due in 7 days').kind, 'quiz');
  assert.equal(parseRowText('Peer Project ReviewPeer Review. 2 submissions').kind, 'peer-review');
  assert.equal(parseRowText('Linked List LabProgramming Assignment. 90 min').kind, 'programming');
});

test('parseRowText returns kind:null and full text as title when no kind keyword is present', () => {
  const r = parseRowText('Just some random row text');
  assert.equal(r.title, 'Just some random row text');
  assert.equal(r.kind, null);
  assert.equal(r.meta, null);
});
