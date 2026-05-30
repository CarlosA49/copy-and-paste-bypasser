const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const pageFallback = require('../lib/page-fallback.js');

function dom(html, url) {
  return new JSDOM(
    '<!doctype html><html><body>' + html + '</body></html>',
    { url: url || 'https://www.coursera.org/learn/test/lecture/v1/x' }
  ).window.document;
}

test('findMarkCompleteButton: button with plain text "Mark as completed"', () => {
  const d = dom('<button>Mark as completed</button>');
  const btn = pageFallback.findMarkCompleteButton(d);
  assert.ok(btn);
  assert.equal(btn.tagName, 'BUTTON');
});

test('findMarkCompleteButton: span.cds-button-label inside a button → returns the closest button', () => {
  const d = dom('<button class="cds-button-primary"><span class="cds-button-label">Mark as completed</span></button>');
  const btn = pageFallback.findMarkCompleteButton(d);
  assert.ok(btn);
  assert.equal(btn.tagName, 'BUTTON');
});

test('findMarkCompleteButton: accepts variants "Mark complete", "Complete", "Completed"', () => {
  assert.ok(pageFallback.findMarkCompleteButton(dom('<button>Mark complete</button>')));
  assert.ok(pageFallback.findMarkCompleteButton(dom('<button>Complete</button>')));
  assert.ok(pageFallback.findMarkCompleteButton(dom('<button>Completed</button>')));
});

test('findMarkCompleteButton: returns null when no matching button exists', () => {
  assert.equal(pageFallback.findMarkCompleteButton(dom('<button>Save</button>')), null);
});

test('findGoToNextItemButton: matches "Go to next item" exactly', () => {
  const d = dom('<button>Go to next item</button>');
  const btn = pageFallback.findGoToNextItemButton(d);
  assert.ok(btn);
});

test('findGoToNextItemButton: matches "Next item" and "Continue"', () => {
  assert.ok(pageFallback.findGoToNextItemButton(dom('<a href="#">Next item</a>')));
  assert.ok(pageFallback.findGoToNextItemButton(dom('<button>Continue</button>')));
});

test('findGoToNextItemButton: returns null when none present', () => {
  assert.equal(pageFallback.findGoToNextItemButton(dom('<button>Save</button>')), null);
});

test('findTopProgressText: matches "0/3 learning items" anywhere visible', () => {
  const d = dom('<div><span>Hello</span><span>0/3 learning items</span></div>');
  const el = pageFallback.findTopProgressText(d);
  assert.ok(el);
  assert.equal(el.textContent.trim(), '0/3 learning items');
});

test('parseProgress: splits "0/3 learning items" into {completed:0, total:3}', () => {
  assert.deepEqual(pageFallback.parseProgress('0/3 learning items'), { completed: 0, total: 3, raw: '0/3 learning items' });
  assert.deepEqual(pageFallback.parseProgress('5/12 learning items'), { completed: 5, total: 12, raw: '5/12 learning items' });
  assert.equal(pageFallback.parseProgress('not a progress string'), null);
  assert.equal(pageFallback.parseProgress(''), null);
});

test('findAgreementCheckbox: returns input#agreement-checkbox-base when present', () => {
  const d = dom('<form><input id="agreement-checkbox-base" type="checkbox"></form>');
  const cb = pageFallback.findAgreementCheckbox(d);
  assert.ok(cb);
  assert.equal(cb.id, 'agreement-checkbox-base');
});

test('findAgreementCheckbox: falls back to checkbox whose label mentions "agree"', () => {
  const d = dom('<label for="cb1">I agree to the terms</label><input id="cb1" type="checkbox">');
  const cb = pageFallback.findAgreementCheckbox(d);
  assert.ok(cb);
  assert.equal(cb.id, 'cb1');
});

test('findAgreementCheckbox: returns null when no agreement-style checkbox exists', () => {
  assert.equal(pageFallback.findAgreementCheckbox(dom('<input type="text">')), null);
});

test('findCompletedReadingIndicator: matches h3 with aria-label "Reading completed"', () => {
  const d = dom('<main><h3 aria-label="Reading completed">Completed</h3></main>');
  const el = pageFallback.findCompletedReadingIndicator(d);
  assert.ok(el, 'should find the indicator');
});

test('findCompletedReadingIndicator: matches any element with aria-label /reading completed/i', () => {
  const d = dom('<main><div aria-label="reading COMPLETED"></div></main>');
  assert.ok(pageFallback.findCompletedReadingIndicator(d));
});

test('findCompletedReadingIndicator: matches an h2 with aria-label="Completed"', () => {
  const d = dom('<main><h2 aria-label="Completed">Completed</h2></main>');
  assert.ok(pageFallback.findCompletedReadingIndicator(d));
});

test('findCompletedReadingIndicator: returns null when only an unrelated "Completed" text node exists', () => {
  const d = dom('<main><p>You have not yet Completed this section.</p></main>');
  assert.equal(pageFallback.findCompletedReadingIndicator(d), null);
});

test('findCompletedReadingIndicator: returns null when no completion indicators are present', () => {
  const d = dom('<main><h1>Syllabus</h1></main>');
  assert.equal(pageFallback.findCompletedReadingIndicator(d), null);
});

test('findGoToNextItemButton: matches when text is inside span.cds-button-label', () => {
  // Regression test — confirms the Coursera reading page Go-to-next button works.
  const d = dom('<button class="cds-button-primary"><span class="cds-button-label">Go to next item</span></button>');
  const btn = pageFallback.findGoToNextItemButton(d);
  assert.ok(btn);
  assert.equal(btn.tagName, 'BUTTON');
});

test('findGoToNextItemButton matches a non-whole-string label like "Go to next item (Lesson 2)"', () => {
  const { findGoToNextItemButton } = require('../lib/page-fallback.js');
  const d = dom('<main><div role="button">Go to next item (Lesson 2)</div></main>');
  const btn = findGoToNextItemButton(d.body);
  assert.ok(btn);
  assert.equal(btn.getAttribute('role'), 'button');
});

test('findGoToNextItemButton matches via aria-label and ignores the Boost chat composer', () => {
  const { findGoToNextItemButton } = require('../lib/page-fallback.js');
  const d = dom(
    '<div id="boostai-chat-panel-composer"><button aria-label="next item">Send</button></div>' +
    '<main><button aria-label="Go to next item">→</button></main>'
  );
  const btn = findGoToNextItemButton(d.body);
  assert.ok(btn);
  assert.equal(btn.getAttribute('aria-label'), 'Go to next item');
});

test('findGoToNextItemButton still matches the legacy whole-string "Continue" when courseraDom finds nothing', () => {
  const { findGoToNextItemButton } = require('../lib/page-fallback.js');
  const d = dom('<main><button>Continue</button></main>');
  const btn = findGoToNextItemButton(d.body);
  assert.ok(btn);
  assert.equal(btn.textContent, 'Continue');
});

test('findGradedResultsIndicator: matches a graded/submitted banner, ignores plain text', () => {
  const pf = require('../lib/page-fallback.js');
  const { JSDOM } = require('jsdom');
  const yes = new JSDOM('<!doctype html><body><h2>Grade received</h2></body>').window.document;
  assert.ok(pf.findGradedResultsIndicator(yes));
  const no = new JSDOM('<!doctype html><body><p>Please grade your work carefully.</p></body>').window.document;
  assert.equal(pf.findGradedResultsIndicator(no), null);
});
