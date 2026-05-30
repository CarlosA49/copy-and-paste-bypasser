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
  // home/week is not an item link; extractItemId now keeps the id-position token
  // (week) rather than null. Callers gate item links on a[href*="/learn/"] + a
  // real itemSlug, so this does not re-introduce home pages into the queue.
  assert.equal(extractItemId('https://www.coursera.org/learn/x/home/week/2'), 'week');
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

test('parseRowText does not classify the LAB in MATLAB as a programming item', () => {
  const r = parseRowText('Lesson 1: The MATLAB EnvironmentReading. Duration: 10 minutes10 min');
  assert.equal(r.title, 'Lesson 1: The MATLAB Environment');
  assert.equal(r.kind, 'reading');
});

test('parseRowText uses the trailing activity type rather than a type word in the title', () => {
  const r = parseRowText('Introduction to ProgrammingReading. Duration: 10 minutes10 min');
  assert.equal(r.title, 'Introduction to Programming');
  assert.equal(r.kind, 'reading');
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

test('parseRowText splits Graded App Item rows like "Assignment: Matrix IndexingGraded App Item. Duration: 15 minutes15 min"', () => {
  // Real Coursera concatenates the visible title with the "Graded App Item"
  // type label and duration; the blocked-item skip log must show only the
  // clean title.
  const r = parseRowText('Assignment: Matrix IndexingGraded App Item. Duration: 15 minutes15 min');
  assert.equal(r.title, 'Assignment: Matrix Indexing');
  assert.equal(r.kind, 'assignment');
  assert.ok(/Graded App Item/.test(r.meta));
});

test('parseRowText recognizes plain "App Item" as a blocked-style activity label', () => {
  const r = parseRowText('Assignment: WhateverApp Item. Duration: 30 min');
  assert.equal(r.title, 'Assignment: Whatever');
  assert.equal(r.kind, 'assignment');
});

const { findAccordionHeaders } = require('../lib/module-scraper.js');

const CDS_ACCORDION_HTML =
  '<div>' +
    '<button class="cds-AccordionHeader-button" aria-controls="panel-1">' +
      '<div class="cds-AccordionHeader-content">' +
        '<div class="cds-AccordionHeader-labelGroup">' +
          '<div>Module 1</div>' +
        '</div>' +
        '<div>Course Pages</div>' +
      '</div>' +
    '</button>' +
    '<button class="cds-AccordionHeader-button" aria-controls="panel-2">' +
      '<div class="cds-AccordionHeader-content">' +
        '<div class="cds-AccordionHeader-labelGroup">' +
          '<div>Module 2</div>' +
        '</div>' +
        '<div>The MATLAB Environment</div>' +
      '</div>' +
    '</button>' +
  '</div>';

test('findAccordionHeaders locates CDS accordion-header buttons whose text matches Module N', () => {
  const d = dom(CDS_ACCORDION_HTML);
  const headers = findAccordionHeaders(d);
  assert.equal(headers.length, 2);
  assert.ok(/Module 1/.test(headers[0].textContent));
  assert.ok(/Module 2/.test(headers[1].textContent));
});

test('findAccordionHeaders also matches "Week N" and "Lesson N" buttons by visible text', () => {
  const d = dom(
    '<div>' +
      '<button>Week 1Introduction</button>' +
      '<button>Lesson 3Advanced Topics</button>' +
      '<button>Not a module header</button>' +
    '</div>'
  );
  const headers = findAccordionHeaders(d);
  assert.equal(headers.length, 2);
  assert.ok(/Week 1/.test(headers[0].textContent));
  assert.ok(/Lesson 3/.test(headers[1].textContent));
});

test('findAccordionHeaders ignores buttons whose text does not match the module-header pattern', () => {
  const d = dom(
    '<div>' +
      '<button class="cds-AccordionHeader-button">Course Resources</button>' +
      '<button class="cds-AccordionHeader-button">Module 5Final Review</button>' +
    '</div>'
  );
  const headers = findAccordionHeaders(d);
  assert.equal(headers.length, 1);
  assert.ok(/Module 5/.test(headers[0].textContent));
});

const { pairHeaderWithPanel } = require('../lib/module-scraper.js');

test('pairHeaderWithPanel uses aria-controls to find the panel', () => {
  const d = dom(
    '<div>' +
      '<button class="cds-AccordionHeader-button" aria-controls="m1-panel">Module 1Intro</button>' +
      '<div id="m1-panel">' +
        '<ul><li><a href="/learn/x/lecture/v1/intro">Intro</a></li></ul>' +
      '</div>' +
    '</div>'
  );
  const header = d.querySelector('button');
  const panel = pairHeaderWithPanel(header, d);
  assert.ok(panel);
  assert.equal(panel.id, 'm1-panel');
});

test('pairHeaderWithPanel falls back to the next sibling subtree with /learn/ anchors when aria-controls absent', () => {
  const d = dom(
    '<div>' +
      '<button>Module 1Intro</button>' +
      '<div>' +
        '<ul><li><a href="/learn/x/lecture/v1/intro">Intro</a></li></ul>' +
      '</div>' +
    '</div>'
  );
  const header = d.querySelector('button');
  const panel = pairHeaderWithPanel(header, d);
  assert.ok(panel, 'should find a panel');
  assert.ok(panel.querySelector('a[href*="/learn/"]'));
});

test('pairHeaderWithPanel returns null when no following content has learn anchors', () => {
  const d = dom('<div><button>Module 1Intro</button><div>nothing here</div></div>');
  const header = d.querySelector('button');
  assert.equal(pairHeaderWithPanel(header, d), null);
});

const { extractItemsFromPanel } = require('../lib/module-scraper.js');

const CDS_PANEL_HTML =
  '<div id="m2-panel">' +
    '<ul>' +
      '<li>' +
        '<div>' +
          '<a href="/learn/matlab/lecture/AAAA/intro-to-matrices">' +
            '<div class="outline-single-item-content-wrapper">' +
              '<div>' +
                '<div>Introduction to Matrices and Operators</div>' +
                '<div>Video<span>. Duration: 5 minutes5 min</span></div>' +
              '</div>' +
              '<svg><rect /></svg>' +
            '</div>' +
          '</a>' +
        '</div>' +
      '</li>' +
      '<li>' +
        '<div>' +
          '<a href="/learn/matlab/supplement/BBBB/lesson-2-matrices-and-operators">' +
            '<div class="outline-single-item-content-wrapper">' +
              '<div>' +
                '<div>Lesson 2: Matrices and Operators</div>' +
                '<div>Reading<span>. Duration: 10 minutes10 min</span></div>' +
              '</div>' +
              '<svg><rect /></svg>' +
            '</div>' +
          '</a>' +
        '</div>' +
      '</li>' +
    '</ul>' +
  '</div>';

test('extractItemsFromPanel extracts items from real Coursera CDS panel markup', () => {
  const d = dom(CDS_PANEL_HTML);
  const panel = d.getElementById('m2-panel');
  const items = extractItemsFromPanel(panel);
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'AAAA');
  assert.equal(items[0].title, 'Introduction to Matrices and Operators');
  assert.equal(items[0].kind, 'video');
  assert.equal(items[0].url, '/learn/matlab/lecture/AAAA/intro-to-matrices');
  assert.equal(items[1].id, 'BBBB');
  assert.equal(items[1].title, 'Lesson 2: Matrices and Operators');
  assert.equal(items[1].kind, 'reading');
});

test('extractItemsFromPanel marks items completed when aria-label="Completed" indicator is present', () => {
  const d = dom(
    '<div id="p"><ul>' +
      '<li><a href="/learn/x/lecture/v1/x">' +
        '<div class="outline-single-item-content-wrapper">' +
          '<div><div>Title A</div><div>Video. 2 min</div></div>' +
          '<span aria-label="Completed"></span>' +
        '</div>' +
      '</a></li>' +
      '<li><a href="/learn/x/lecture/v2/x">' +
        '<div class="outline-single-item-content-wrapper">' +
          '<div><div>Title B</div><div>Video. 2 min</div></div>' +
          '<span aria-label="Not completed"></span>' +
        '</div>' +
      '</a></li>' +
    '</ul></div>'
  );
  const items = extractItemsFromPanel(d.getElementById('p'));
  assert.equal(items[0].completed, true);
  assert.equal(items[1].completed, false);
});

test('extractItemsFromPanel marks a Coursera row green check svg as completed', () => {
  const d = dom(
    '<div id="p"><ul>' +
      '<li><a href="/learn/matlab/lecture/v1/course-preview">' +
        '<div class="outline-single-item-content-wrapper">' +
          '<div><div>Course Preview</div><div>Video. Duration: 2 min</div></div>' +
          '<svg style="color: rgb(39, 106, 26);"><path></path></svg>' +
        '</div>' +
      '</a></li>' +
      '<li><a href="/learn/matlab/supplement/r1/recommended-textbook">' +
        '<div class="outline-single-item-content-wrapper">' +
          '<div><div>Recommended Textbook</div><div>Reading. Duration: 10 min</div></div>' +
        '</div>' +
      '</a></li>' +
    '</ul></div>'
  );
  const items = extractItemsFromPanel(d.getElementById('p'));
  assert.equal(items[0].completed, true);
  assert.equal(items[1].completed, false);
});

// ── Task 5: scrapeModuleByAccordion ──────────────────────────────────────────
const FULL_ACCORDION_HTML =
  '<div>' +
    '<button class="cds-AccordionHeader-button" aria-controls="m1p" aria-expanded="false">' +
      '<div>Module 1</div><div>Course Pages</div>' +
    '</button>' +
    '<div id="m1p">' +
      '<ul>' +
        '<li><a href="/learn/matlab/lecture/v1/course-preview">' +
          '<div class="outline-single-item-content-wrapper"><div><div>Course Preview</div><div>Video. Duration: 2 min</div></div></div>' +
        '</a></li>' +
        '<li><a href="/learn/matlab/supplement/r1/syllabus">' +
          '<div class="outline-single-item-content-wrapper"><div><div>Syllabus</div><div>Reading. Duration: 10 min</div></div></div>' +
        '</a></li>' +
      '</ul>' +
    '</div>' +
    '<button class="cds-AccordionHeader-button" aria-controls="m2p" aria-expanded="true">' +
      '<div>Module 2</div><div>The MATLAB Environment</div>' +
    '</button>' +
    '<div id="m2p">' +
      '<ul>' +
        '<li><a href="/learn/matlab/lecture/v2/intro">' +
          '<div class="outline-single-item-content-wrapper"><div><div>Intro to MATLAB</div><div>Video. Duration: 5 min</div></div></div>' +
        '</a></li>' +
      '</ul>' +
    '</div>' +
  '</div>';

test('scrapeModule (accordion layer) finds items when no Layer-1 container matches but accordion headers do', () => {
  const d = dom(FULL_ACCORDION_HTML, 'https://www.coursera.org/learn/matlab/supplement/r1/syllabus');
  const r = scrapeModule(d);
  assert.equal(r.items.length, 2, 'Module 1 (where current item Syllabus is) has 2 items');
  assert.equal(r.items[0].id, 'v1');
  assert.equal(r.items[0].title, 'Course Preview');
  assert.equal(r.items[0].kind, 'video');
  assert.equal(r.items[1].id, 'r1');
  assert.equal(r.items[1].kind, 'reading');
});

test('scrapeModule (accordion layer) picks the expanded module when current URL is not in any panel', () => {
  const d = dom(FULL_ACCORDION_HTML, 'https://www.coursera.org/learn/matlab/home/welcome');
  const r = scrapeModule(d);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, 'v2');
  assert.equal(r.items[0].title, 'Intro to MATLAB');
});

test('scrapeModule (accordion layer) coexists with Layer 1: legacy lesson-collection still works', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/test-course/lecture/v1/intro">Intro Video</a>' +
    '</div>',
    'https://www.coursera.org/learn/test-course/lecture/v1/intro'
  );
  const r = scrapeModule(d);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id, 'v1');
});

const SECOND_COURSE_HTML =
  '<div>' +
    '<button class="cds-AccordionHeader-button" aria-controls="w3p" aria-expanded="true">' +
      '<div>Week 3</div><div>Pandas for Data Wrangling</div>' +
    '</button>' +
    '<div id="w3p">' +
      '<ul>' +
        '<li><a href="/learn/python-ds/lecture/abc/dataframes">' +
          '<div class="outline-single-item-content-wrapper"><div><div>DataFrames Deep Dive</div><div>Video. Duration: 12 min</div></div></div>' +
        '</a></li>' +
        '<li><a href="/learn/python-ds/quiz/q3/pandas-quiz">' +
          '<div class="outline-single-item-content-wrapper"><div><div>Week 3 Knowledge Check</div><div>Practice Quiz. 8 questions</div></div></div>' +
        '</a></li>' +
        '<li><a href="/learn/python-ds/peer/p3/group-eda">' +
          '<div class="outline-single-item-content-wrapper"><div><div>Group EDA</div><div>Peer Review. 2 submissions</div></div></div>' +
        '</a></li>' +
        '<li><a href="/learn/python-ds/programming/lab3/groupby-lab">' +
          '<div class="outline-single-item-content-wrapper"><div><div>Groupby Lab</div><div>Programming Assignment. 90 min</div></div></div>' +
        '</a></li>' +
      '</ul>' +
    '</div>' +
  '</div>';

test('scrapeModule: accordion path works on a different course (Python Data Science) with different kinds', () => {
  const d = dom(SECOND_COURSE_HTML, 'https://www.coursera.org/learn/python-ds/quiz/q3/pandas-quiz');
  const r = scrapeModule(d);
  assert.equal(r.items.length, 4);
  assert.equal(r.items[0].kind, 'video');
  assert.equal(r.items[1].kind, 'quiz');
  assert.equal(r.items[2].kind, 'peer-review');
  assert.equal(r.items[3].kind, 'programming');
  assert.equal(r.items[0].title, 'DataFrames Deep Dive');
  assert.equal(r.items[1].title, 'Week 3 Knowledge Check');
  assert.equal(r.items[2].title, 'Group EDA');
  assert.equal(r.items[3].title, 'Groupby Lab');
  assert.equal(r.courseId, 'python-ds');
});

const TEXT_ONLY_HTML =
  '<nav>' +
    '<div>Module 1</div><div>Course Pages</div>' +
    '<a href="/learn/matlab/lecture/v1/x"><div>Course PreviewVideo. 2 min</div></a>' +
    '<a href="/learn/matlab/supplement/r1/y"><div>SyllabusReading. 10 min</div></a>' +
    '<a href="/learn/matlab/supplement/r2/z"><div>Grading and LogisticsReading. 10 min</div></a>' +
    '<div>Module 2</div><div>The MATLAB Environment</div>' +
    '<a href="/learn/matlab/lecture/v2/q"><div>Intro to MATLABVideo. 5 min</div></a>' +
  '</nav>';

test('scrapeModule: text-pattern path finds Module 1 items when accordion headers are missing', () => {
  const d = dom(TEXT_ONLY_HTML, 'https://www.coursera.org/learn/matlab/supplement/r1/y');
  const r = scrapeModule(d);
  assert.equal(r.items.length, 3, 'Module 1 has 3 items');
  assert.equal(r.items[0].id, 'v1');
  assert.equal(r.items[0].kind, 'video');
  assert.equal(r.items[1].title, 'Syllabus');
  assert.equal(r.items[2].title, 'Grading and Logistics');
});

test('scrapeModule: text-pattern path does NOT bleed Module 2 items into Module 1 queue', () => {
  const d = dom(TEXT_ONLY_HTML, 'https://www.coursera.org/learn/matlab/supplement/r1/y');
  const r = scrapeModule(d);
  assert.equal(r.items.find(function (it) { return it.id === 'v2'; }), undefined);
});

test('scrapeModuleDiagnostics includes accordion/page-fallback counts and DOM samples', () => {
  const d = dom(
    '<div>' +
      '<button class="cds-AccordionHeader-button">Module 1Intro</button>' +
      '<div><ul><li>nothing useful</li></ul></div>' +
      '<button>Mark as completed</button>' +
      '<button>Go to next item</button>' +
      '<a href="/learn/x/lecture/v1/intro">Some video link</a>' +
    '</div>'
  );
  const diag = scrapeModuleDiagnostics(d);
  assert.equal(typeof diag.accordionHeaderCount, 'number');
  assert.equal(diag.accordionHeaderCount, 1);
  assert.equal(diag.markCompleteCount, 1);
  assert.equal(diag.goToNextCount, 1);
  assert.equal(diag.learnAnchorCount, 1);
  assert.ok(Array.isArray(diag.headerSamples));
  assert.ok(/Module 1/.test(diag.headerSamples[0]));
});

const { findGreenCompletionIconInRow } = require('../lib/module-scraper.js');

test('findGreenCompletionIconInRow: returns the green svg inside the matching item row', () => {
  const d = dom(
    '<div>' +
      '<a href="/learn/x/lecture/v1/intro">' +
        '<svg style="color: rgb(39, 106, 26);"><rect/></svg>' +
        'Intro' +
      '</a>' +
    '</div>',
    'https://www.coursera.org/learn/x/lecture/v1/intro'
  );
  const el = findGreenCompletionIconInRow(d, 'v1');
  assert.ok(el);
  assert.equal(el.tagName && el.tagName.toLowerCase(), 'svg');
});

test('findGreenCompletionIconInRow: ignores a green svg in an UNRELATED row', () => {
  const d = dom(
    '<div>' +
      '<a href="/learn/x/lecture/v1/intro">No icon</a>' +
      '<a href="/learn/x/lecture/v2/two">' +
        '<svg style="color: rgb(39, 106, 26);"><rect/></svg>' +
      '</a>' +
    '</div>'
  );
  assert.equal(findGreenCompletionIconInRow(d, 'v1'), null);
  assert.ok(findGreenCompletionIconInRow(d, 'v2'));
});

test('findGreenCompletionIconInRow: requires green-ish color (not just any svg in the row)', () => {
  const d = dom(
    '<div>' +
      '<a href="/learn/x/lecture/v1/intro">' +
        '<svg style="color: rgb(128, 128, 128);"><rect/></svg>' +
      '</a>' +
    '</div>'
  );
  assert.equal(findGreenCompletionIconInRow(d, 'v1'), null);
});

test('findGreenCompletionIconInRow: accepts fill attribute as well as style color', () => {
  const d = dom(
    '<div>' +
      '<a href="/learn/x/lecture/v1/intro">' +
        '<svg fill="rgb(39, 106, 26)"><rect/></svg>' +
      '</a>' +
    '</div>'
  );
  assert.ok(findGreenCompletionIconInRow(d, 'v1'));
});

test('findGreenCompletionIconInRow: accepts inline aria-label "Completed" inside the row', () => {
  const d = dom(
    '<div>' +
      '<a href="/learn/x/lecture/v1/intro">' +
        '<span aria-label="Completed"></span>' +
      '</a>' +
    '</div>'
  );
  assert.ok(findGreenCompletionIconInRow(d, 'v1'));
});

// ── Task 5: isBlockedAssessmentItem ──────────────────────────────────────────
const { isBlockedAssessmentItem } = require('../lib/module-scraper.js');

test('isBlockedAssessmentItem: gradedLti URLs are blocked', () => {
  assert.equal(isBlockedAssessmentItem({ url: '/learn/matlab/gradedLti/V2JkF/assignment-lesson-1-wrap-up', title: 'Wrap-up', kind: 'assignment' }), true);
});

test('isBlockedAssessmentItem: peer URLs are blocked', () => {
  assert.equal(isBlockedAssessmentItem({ url: '/learn/ai-ethics/peer/UdoHt/course-reflection', title: 'Review Your Peers', kind: 'peer-review' }), true);
});

test('isBlockedAssessmentItem: assignment-submission URLs are blocked', () => {
  assert.equal(isBlockedAssessmentItem({ url: '/learn/physics/assignment-submission/lMLNW/exam', title: 'Exam', kind: 'quiz' }), true);
});

test('isBlockedAssessmentItem: quiz URLs are blocked', () => {
  assert.equal(isBlockedAssessmentItem({ url: '/learn/x/quiz/q1/week-1', title: 'Week 1 Quiz', kind: 'quiz' }), true);
});

test('isBlockedAssessmentItem: exam URLs are blocked', () => {
  assert.equal(isBlockedAssessmentItem({ url: '/learn/x/exam/e1/final', title: 'Final', kind: 'quiz' }), true);
});

test('isBlockedAssessmentItem: programming URLs are blocked', () => {
  assert.equal(isBlockedAssessmentItem({ url: '/learn/x/programming/p1/lab1', title: 'Lab 1', kind: 'programming' }), true);
});

test('isBlockedAssessmentItem: visible-text "Graded Assignment" blocks even without URL pattern', () => {
  assert.equal(isBlockedAssessmentItem({ url: '/learn/x/lecture/v1/x', title: 'Graded Assignment', kind: 'video' }), true);
});

test('isBlockedAssessmentItem: visible-text "Review Your Peers" blocks', () => {
  assert.equal(isBlockedAssessmentItem({ url: '/learn/x/supplement/s/x', title: 'Review Your Peers', kind: 'reading' }), true);
});

test('isBlockedAssessmentItem: visible-text "App Item" blocks', () => {
  assert.equal(isBlockedAssessmentItem({ url: '/learn/x/lecture/v1/x', title: 'Cool App Item', kind: 'video' }), true);
});

test('isBlockedAssessmentItem: plain readings/videos are NOT blocked', () => {
  assert.equal(isBlockedAssessmentItem({ url: '/learn/x/lecture/v1/x', title: 'Course Preview', kind: 'video' }), false);
  assert.equal(isBlockedAssessmentItem({ url: '/learn/x/supplement/r1/x', title: 'Syllabus', kind: 'reading' }), false);
});

test('isBlockedAssessmentItem: discussion IS now blocked', () => {
  assert.equal(isBlockedAssessmentItem({ url: '/learn/x/discussionPrompt/d1/x', title: 'Week 1 Discussion', kind: 'discussion' }), true);
});

const { scrapeAllModules } = require('../lib/module-scraper.js');

const COURSE_FIXTURE_HTML =
  '<div>' +
    '<button class="cds-AccordionHeader-button" aria-controls="m1p"><div>Module 1</div><div>Course Pages</div></button>' +
    '<div id="m1p">' +
      '<ul>' +
        '<li><a href="/learn/x/lecture/v1/intro"><div class="outline-single-item-content-wrapper"><div><div>Intro</div><div>Video. 2 min</div></div></div></a></li>' +
        '<li><a href="/learn/x/quiz/q1/wk1"><div class="outline-single-item-content-wrapper"><div><div>Week 1 Quiz</div><div>Quiz. 30 min</div></div></div></a></li>' +
        '<li><a href="/learn/x/supplement/r1/sy"><div class="outline-single-item-content-wrapper"><div><div>Syllabus</div><div>Reading. 10 min</div></div></div></a></li>' +
      '</ul>' +
    '</div>' +
    '<button class="cds-AccordionHeader-button" aria-controls="m2p"><div>Module 2</div><div>The MATLAB Environment</div></button>' +
    '<div id="m2p">' +
      '<ul>' +
        '<li><a href="/learn/x/lecture/v2/m2-intro"><div class="outline-single-item-content-wrapper"><div><div>M2 Intro</div><div>Video. 5 min</div></div></div></a></li>' +
        '<li><a href="/learn/x/peer/p1/peer-1"><div class="outline-single-item-content-wrapper"><div><div>Peer Review 1</div><div>Peer Review. 2 submissions</div></div></div></a></li>' +
      '</ul>' +
    '</div>' +
  '</div>';

test('scrapeAllModules: returns one entry per module with module items in DOM order', () => {
  const d = dom(COURSE_FIXTURE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const r = scrapeAllModules(d);
  assert.equal(r.modules.length, 2);
  assert.equal(r.modules[0].items.length, 3);
  assert.equal(r.modules[1].items.length, 2);
  assert.ok(/Module 1/.test(r.modules[0].headerText));
  assert.ok(/Module 2/.test(r.modules[1].headerText));
});

test('scrapeAllModules: each module is paired to its accordion panel via aria-controls', () => {
  const d = dom(COURSE_FIXTURE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const r = scrapeAllModules(d);
  assert.equal(r.modules[0].items[0].id, 'v1');
  assert.equal(r.modules[0].items[1].id, 'q1');
  assert.equal(r.modules[1].items[0].id, 'v2');
});

test('isBlockedAssessmentItem: /discussionPrompt/ URLs are blocked', () => {
  assert.equal(isBlockedAssessmentItem({
    url: '/learn/wireless-communications/discussionPrompt/acEZk/services-in-cellular-system',
    title: 'Services in Cellular System',
    kind: 'discussion',
  }), true);
});

test('isBlockedAssessmentItem: /discussion/ URLs are blocked (older URL shape)', () => {
  assert.equal(isBlockedAssessmentItem({
    url: '/learn/x/discussion/d1/example',
    title: 'Example Discussion',
    kind: 'discussion',
  }), true);
});

test('isBlockedAssessmentItem: visible-text "Discussion Prompt" blocks even when kind is unknown', () => {
  assert.equal(isBlockedAssessmentItem({
    url: '/learn/x/lecture/v1/x',
    title: 'Week 1 Discussion Prompt',
    kind: 'video',
  }), true);
});

test('isBlockedAssessmentItem: kind="discussion" alone is enough to block', () => {
  assert.equal(isBlockedAssessmentItem({
    url: '/learn/x/lecture/v1/x',
    title: 'Some random title',
    kind: 'discussion',
  }), true);
});

test('isBlockedAssessmentItem: previously-blocked items still block (regression)', () => {
  assert.equal(isBlockedAssessmentItem({ url: '/learn/x/gradedLti/g/x', title: 'Graded Wrap-up', kind: 'assignment' }), true);
  assert.equal(isBlockedAssessmentItem({ url: '/learn/x/quiz/q/x', title: 'Q', kind: 'quiz' }), true);
  assert.equal(isBlockedAssessmentItem({ url: '/learn/x/peer/p/x', title: 'P', kind: 'peer-review' }), true);
});

test('isBlockedAssessmentItem: plain video/reading still NOT blocked (regression)', () => {
  assert.equal(isBlockedAssessmentItem({ url: '/learn/x/lecture/v1/x', title: 'Course Preview', kind: 'video' }), false);
  assert.equal(isBlockedAssessmentItem({ url: '/learn/x/supplement/r1/x', title: 'Syllabus', kind: 'reading' }), false);
});

test('extractItemId keeps the id for an ungradedWidget segment (regression: vanished lessons)', () => {
  assert.equal(
    extractItemId('/learn/matlab/ungradedWidget/8h1hv/completing-matlab-programming-assignments'),
    '8h1hv'
  );
});

test('extractItemId keeps the id for an unknown/renamed segment instead of returning null', () => {
  assert.equal(extractItemId('/learn/matlab/brandNewSegment/zz9/foo'), 'zz9');
});

test('extractItemId still returns null when there is no /<kind>/<id> after /learn/<slug>', () => {
  assert.equal(extractItemId('https://www.coursera.org/learn/x/home/week/2'), 'week');
  assert.equal(extractItemId('https://www.coursera.org/about'), null);
});

test('classifyKind maps ungradedWidget through the extended segment map (delegates to reading-style plugin handling)', () => {
  // module-scraper.classifyKind keeps its single-arg contract (the 1253 tests
  // depend on it). It must now map ungradedWidget to a non-'other' kind.
  assert.equal(classifyKind('/learn/x/ungradedWidget/abc/x'), 'reading');
});

test('scrapeModule no longer drops the ungradedWidget row (GROUND TRUTH from extraction)', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/matlab/lecture/v1/intro">Intro Video</a>' +
      '<a href="/learn/matlab/ungradedWidget/8h1hv/completing-matlab-programming-assignments">Completing MATLAB Programming Assignments</a>' +
    '</div>',
    'https://www.coursera.org/learn/matlab/lecture/v1/intro'
  );
  const r = scrapeModule(d);
  const ids = r.items.map(function (it) { return it.id; });
  assert.ok(ids.indexOf('8h1hv') !== -1, 'ungradedWidget item must appear in the queue');
});

// ─── Task 14: completion via courseraDom.itemStatus + findModuleRegions ───

test('scrapeModule keeps a Graded App Item (gradedLti) row in the queue (GROUND TRUTH)', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/matlab/gradedLti/g1/assignment-matlab-calculation" aria-label="Graded App Item, Assignment: MATLAB Calculation, Not submitted, 15 min">Assignment: MATLAB Calculation</a>' +
    '</div>',
    'https://www.coursera.org/learn/matlab/lecture/v1/intro'
  );
  const r = scrapeModule(d);
  const ids = r.items.map(function (it) { return it.id; });
  assert.ok(ids.indexOf('g1') !== -1, 'gradedLti row must stay in the queue');
});

test('scrapeModule reads completion from the accessibleName status token (preferred over green-RGB)', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/matlab/lecture/v1/intro" aria-label="Video, Intro, Completed, 2 min">Intro</a>' +
    '</div>',
    'https://www.coursera.org/learn/matlab/lecture/v1/intro'
  );
  const r = scrapeModule(d);
  const it = r.items.filter(function (x) { return x.id === 'v1'; })[0];
  assert.ok(it, 'row must be in the queue');
  assert.equal(it.completed, true);
});

test('scrapeModule reads not-completion from the accessibleName status token even with green-ish styling (status wins)', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/matlab/lecture/v2/scripts" aria-label="Video, Scripts, Not submitted, 4 min">' +
        '<span style="color: rgb(0, 160, 0)">point</span>Scripts' +
      '</a>' +
    '</div>',
    'https://www.coursera.org/learn/matlab/lecture/v1/intro'
  );
  const r = scrapeModule(d);
  const it = r.items.filter(function (x) { return x.id === 'v2'; })[0];
  assert.ok(it, 'row must be in the queue');
  assert.equal(it.completed, false);
});

test('scrapeModule still falls back to the green-RGB icon when the accessibleName has no status token (last resort)', () => {
  const d = dom(
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/matlab/lecture/v3/recap" aria-label="Course Preview">' +
        '<svg style="color: rgb(0, 150, 0)"><path></path></svg>Recap' +
      '</a>' +
    '</div>',
    'https://www.coursera.org/learn/matlab/lecture/v1/intro'
  );
  const r = scrapeModule(d);
  const it = r.items.filter(function (x) { return x.id === 'v3'; })[0];
  assert.ok(it, 'row must be in the queue');
  assert.equal(it.completed, true);
});

test('module-scraper exposes findModuleRegions delegating to courseraDom (role=region module discovery)', () => {
  const scraper = require('../lib/module-scraper.js');
  assert.equal(typeof scraper.findModuleRegions, 'function');
  const d = dom(
    '<nav role="navigation">' +
      '<div role="region" aria-label="Module 1 Course Pages">' +
        '<div role="heading" aria-level="3"><button aria-expanded="true">Module 1 Course Pages</button></div>' +
        '<ul><li><div><a href="/learn/matlab/lecture/cp1/course-preview">Course Preview</a></div></li></ul>' +
      '</div>' +
      '<div role="region" aria-label="Module 2 The MATLAB Environment">' +
        '<div role="heading" aria-level="3"><button aria-expanded="false">Module 2 The MATLAB Environment</button></div>' +
      '</div>' +
    '</nav>'
  );
  const regions = scraper.findModuleRegions(d);
  assert.equal(regions.length, 2);
  assert.equal(regions[0].title, 'Module 1 Course Pages');
  assert.equal(regions[0].expanded, true);
  assert.equal(regions[1].expanded, false);
});
