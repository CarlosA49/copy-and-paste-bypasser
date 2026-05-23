# Universal Coursera Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the autopilot work on any Coursera course's live drawer (Coursera Design System accordion + outline rows), without depending on generated CSS class hashes or per-course markers — and keep advancing even when full-queue discovery fails.

**Architecture:** Three-layer scraper. Layer 1 (existing): stable `data-testid` / `aria-label` selectors. Layer 2 (new): Coursera Design System accordion structural detection — find module-header buttons by *role + visible text pattern*, pair to panels via `aria-controls`, extract item rows from the panel. Layer 3 (new): pure text-pattern fallback — walk the DOM for `Module N` / `Week N` / `Lesson N` headers and group sibling anchors by `Video` / `Reading` / `Quiz` / `Assignment` kind markers. Plus: a single-page synthetic-queue runner that keeps moving via the `Go to next item` button when no queue can be built, a video forward-seek fallback when `currentTime` writes are ignored, a universal `Mark as completed` button finder, an assignment-page agreement-checkbox handler (no auto-submit), and a top-progress (`N/M learning items`) watcher as an additional completion signal.

**Tech Stack:** Vanilla JS (Chrome Extension Manifest V3), `node:test` + jsdom. No new dependencies.

---

## File Structure

**Modify:**
- `lib/module-scraper.js` — add `parseRowText`, `findAccordionHeaders`, `pairHeaderWithPanel`, `extractItemsFromPanel`, `scrapeModuleByAccordion`, `scrapeModuleByText`, `findCurrentRow`. Refactor `scrapeModule` to a 3-layer dispatcher: existing selector path → accordion path → text path → empty. Extend `scrapeModuleDiagnostics` with accordion/panel/anchor counts and DOM samples.
- `lib/module-autopilot.js` — when `scrapeModule.items === []`, build a synthetic 1-item queue from the current URL (kind from `/lecture/`/`/supplement/`/`/quiz/`/`/gradedLti/`). After confirmer timeout, call `pageFallback.findMarkCompleteButton(doc)` (in addition to the existing `tryMarkCompleteFallback`). After successful confirmation in single-page mode, click `pageFallback.findGoToNextItemButton(doc)` to advance.
- `lib/item-handlers.js` — extend the `video` handler with a forward-seek fallback (`button[aria-label*="Seek Video Forward" i]`) when direct `currentTime` write doesn't stick. Add an `assignment` handler that checks `#agreement-checkbox-base` (dispatches `input` + `change`), then pauses with a clear reason.
- `lib/completion-confirmer.js` — accept an optional second signal source: read top progress text via `pageFallback.findTopProgressText(doc)`, treat a `completed` count increase as confirmation.
- `tests/module-scraper.test.js` — accordion fixture (Coursera CDS markup) + second-course accordion fixture (different module + item names) + diagnostics fixture.
- `tests/item-handlers.test.js` — video forward-seek fallback test; assignment agreement-checkbox test.
- `tests/module-autopilot.test.js` — synthetic-queue fallback test (no drawer items → handler runs on current URL → `Go to next item` clicked).
- `tests/completion-confirmer.test.js` — top-progress change-as-confirmation test.

**Create:**
- `lib/page-fallback.js` — page-level helpers used by the controller and confirmer: `findMarkCompleteButton`, `findGoToNextItemButton`, `findTopProgressText`, `parseProgress`, `findAgreementCheckbox`. Pure DOM, no side effects.
- `tests/page-fallback.test.js` — fixtures for the five helpers including the `<span class="cds-button-label">Mark as completed</span>` nested case and `<input id="agreement-checkbox-base">`.

**Sizing note:** After this plan, `lib/module-scraper.js` will grow from 286 to ~560 lines. If during Task 5 or 7 the implementer feels the file is too tangled, splitting `scrapeModuleByAccordion` / `scrapeModuleByText` into `lib/scraper-accordion.js` and `lib/scraper-text.js` is a reasonable plan deviation. Default is to keep them in one file matching the existing pattern.

---

## Helper Naming & Return Shapes (Lock In)

Used consistently across tasks. If any later task seems to use a different name, the earlier task definition wins.

- `parseRowText(rawText) → { title: string, kind: string|null, meta: string|null }`
- `findAccordionHeaders(root) → Element[]`
- `pairHeaderWithPanel(headerEl, doc) → Element|null`
- `extractItemsFromPanel(panelEl) → Item[]`
- `scrapeModuleByAccordion(doc) → { items: Item[], section: Element|null }`
- `scrapeModuleByText(doc) → { items: Item[], section: Element|null }`
- `findCurrentRow(rootEl, currentUrl) → Element|null`
- `Item = { id, title, kind, url, completed, selected? }`
- `pageFallback.findMarkCompleteButton(root) → Element|null`
- `pageFallback.findGoToNextItemButton(root) → Element|null`
- `pageFallback.findTopProgressText(root) → Element|null`
- `pageFallback.parseProgress(text) → { completed: number, total: number, raw: string }|null`
- `pageFallback.findAgreementCheckbox(root) → Element|null`

---

## Task 1: `parseRowText` — pure row-text splitter

**Files:**
- Modify: `lib/module-scraper.js`
- Modify: `tests/module-scraper.test.js`

### Why

Coursera Design System rows render as concatenated text like `Lesson 2: Matrices and OperatorsReading. Duration: 10 minutes10 min`. Need a pure function that splits this into `{ title: 'Lesson 2: Matrices and Operators', kind: 'reading', meta: 'Reading. Duration: 10 minutes10 min' }`. Both the accordion path and the text path will use this.

### Step 1: Write the failing tests

Append to `tests/module-scraper.test.js`:

```js
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
```

### Step 2: Run tests to confirm they fail

Run: `npm test`
Expected: 5 new failures — `parseRowText is not a function`.

### Step 3: Implement `parseRowText`

In `lib/module-scraper.js`, just below the existing `kindFromVisibleText` function (around line 107), add:

```js
const ROW_STATUS_PREFIX_RE = /^\s*(Completed|Not completed|In progress)\s*/i;
const ROW_KIND_RE = /\b(Practice Quiz|Programming Assignment|Programming Lab|Peer Review|Discussion Prompt|Video|Reading|Quiz|Assignment|Programming|Lab|Discussion)\b/i;

function classifyVisibleKind(label) {
  const s = String(label || '').toLowerCase();
  if (/programming/.test(s)) return 'programming';
  if (/peer review/.test(s)) return 'peer-review';
  if (/discussion/.test(s)) return 'discussion';
  if (/practice quiz/.test(s)) return 'quiz';
  if (/quiz/.test(s)) return 'quiz';
  if (/assignment/.test(s)) return 'quiz';
  if (/lab\b/.test(s)) return 'programming';
  if (/reading/.test(s)) return 'reading';
  if (/video/.test(s)) return 'video';
  return null;
}

function parseRowText(rawText) {
  let text = String(rawText || '').replace(/\s+/g, ' ').trim();
  text = text.replace(ROW_STATUS_PREFIX_RE, '');
  const m = text.match(ROW_KIND_RE);
  if (!m) return { title: text, kind: null, meta: null };
  const idx = m.index;
  const title = text.slice(0, idx).trim().replace(/[\.•·\-:\s]+$/, '').trim();
  const meta = text.slice(idx).trim();
  return { title: title, kind: classifyVisibleKind(m[1]), meta: meta };
}
```

Export `parseRowText` and `classifyVisibleKind` on the `api` object:

```js
const api = {
  scrapeModule: scrapeModule,
  scrapeModuleDiagnostics: scrapeModuleDiagnostics,
  extractCourseId: extractCourseId,
  extractItemId: extractItemId,
  classifyKind: classifyKind,
  classifyVisibleKind: classifyVisibleKind,
  parseRowText: parseRowText,
  findItemCompletionIndicator: findItemCompletionIndicator,
};
```

### Step 4: Run tests to verify they pass

Run: `npm test`
Expected: all 481 prior tests pass, plus 5 new tests pass.

### Step 5: Commit

```bash
git add lib/module-scraper.js tests/module-scraper.test.js
git commit -m "feat(scraper): add parseRowText universal row-text splitter"
```

---

## Task 2: `findAccordionHeaders` — locate Coursera CDS module headers

**Files:**
- Modify: `lib/module-scraper.js`
- Modify: `tests/module-scraper.test.js`

### Why

Live Coursera renders module headers as `button.cds-AccordionHeader-button` whose visible text starts with `Module N`, `Week N`, or `Lesson N` (sometimes followed by a title with no separator: `Module 2The MATLAB Environment`). Find them via *role+text*, not via a generated class.

### Step 1: Write the failing tests

Append to `tests/module-scraper.test.js`:

```js
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
```

### Step 2: Run tests to confirm they fail

Run: `npm test`
Expected: `findAccordionHeaders is not a function`.

### Step 3: Implement `findAccordionHeaders`

In `lib/module-scraper.js`, add just below `parseRowText`:

```js
const MODULE_HEADER_RE = /\b(Module|Week|Lesson|Unit)\s+\d+\b/i;

function findAccordionHeaders(root) {
  if (!root) return [];
  let candidates = Array.prototype.slice.call(
    root.querySelectorAll('button[class*="AccordionHeader" i], button[class*="accordion-header" i], [role="button"][class*="AccordionHeader" i]')
  );
  if (candidates.length === 0) {
    candidates = Array.prototype.slice.call(root.querySelectorAll('button, [role="button"]'));
  }
  return candidates.filter(function (b) {
    return MODULE_HEADER_RE.test(textOf(b));
  });
}
```

Export it:

```js
const api = {
  scrapeModule: scrapeModule,
  scrapeModuleDiagnostics: scrapeModuleDiagnostics,
  extractCourseId: extractCourseId,
  extractItemId: extractItemId,
  classifyKind: classifyKind,
  classifyVisibleKind: classifyVisibleKind,
  parseRowText: parseRowText,
  findAccordionHeaders: findAccordionHeaders,
  findItemCompletionIndicator: findItemCompletionIndicator,
};
```

### Step 4: Run tests

Run: `npm test`
Expected: 3 new tests pass; total 489.

### Step 5: Commit

```bash
git add lib/module-scraper.js tests/module-scraper.test.js
git commit -m "feat(scraper): find Coursera CDS accordion headers by role+text"
```

---

## Task 3: `pairHeaderWithPanel` — header → accordion panel

**Files:**
- Modify: `lib/module-scraper.js`
- Modify: `tests/module-scraper.test.js`

### Why

Each `cds-AccordionHeader-button` has `aria-controls="<panel-id>"`. When present, the panel is `doc.getElementById(panelId)`. When absent, fall back to the nearest forward sibling/descendant that contains `<ul>` + `/learn/` anchors.

### Step 1: Write the failing tests

Append:

```js
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
```

### Step 2: Run

Run: `npm test`
Expected: 3 new failures.

### Step 3: Implement

In `lib/module-scraper.js`, add below `findAccordionHeaders`:

```js
function pairHeaderWithPanel(headerEl, doc) {
  if (!headerEl) return null;
  const controlsId = headerEl.getAttribute && headerEl.getAttribute('aria-controls');
  if (controlsId && doc && typeof doc.getElementById === 'function') {
    const byId = doc.getElementById(controlsId);
    if (byId) return byId;
  }
  // Walk forward through ancestors looking at following siblings for a panel-like subtree.
  let node = headerEl.parentElement;
  while (node) {
    let sib = node.nextElementSibling;
    while (sib) {
      if (sib.querySelector && sib.querySelector('a[href*="/learn/"]')) return sib;
      sib = sib.nextElementSibling;
    }
    // Also look inside the current ancestor for a panel that comes after the header in document order.
    if (node.querySelector) {
      const panels = node.querySelectorAll('[id*="accordion-panel" i], [role="region"]');
      for (let i = 0; i < panels.length; i++) {
        if (headerEl.compareDocumentPosition && (headerEl.compareDocumentPosition(panels[i]) & 0x04 /* FOLLOWING */)) {
          if (panels[i].querySelector('a[href*="/learn/"]')) return panels[i];
        }
      }
    }
    node = node.parentElement;
  }
  return null;
}
```

Export it:

```js
parseRowText: parseRowText,
findAccordionHeaders: findAccordionHeaders,
pairHeaderWithPanel: pairHeaderWithPanel,
findItemCompletionIndicator: findItemCompletionIndicator,
```

### Step 4: Run

Run: `npm test`
Expected: all pass; total 492.

### Step 5: Commit

```bash
git add lib/module-scraper.js tests/module-scraper.test.js
git commit -m "feat(scraper): pair accordion header to panel via aria-controls"
```

---

## Task 4: `extractItemsFromPanel` — panel → items

**Files:**
- Modify: `lib/module-scraper.js`
- Modify: `tests/module-scraper.test.js`

### Why

Given a panel element, return well-typed `Item[]` with title from row title text, kind from visible meta (via `parseRowText`), url from the row anchor, and completed from `isPositiveCompletionEl` against the existing `COMPLETED_SELECTORS` list.

### Step 1: Write the failing tests

Append:

```js
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
```

### Step 2: Run

Run: `npm test`
Expected: 2 new failures.

### Step 3: Implement

In `lib/module-scraper.js`, add below `pairHeaderWithPanel`:

```js
function extractItemsFromPanel(panelEl) {
  if (!panelEl || typeof panelEl.querySelectorAll !== 'function') return [];
  const anchors = panelEl.querySelectorAll('a[href*="/learn/"]');
  const items = [];
  const seen = new Set();
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const href = a.getAttribute('href');
    const id = extractItemId(href);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // Title + kind from row text via parseRowText
    const rowEl = a.querySelector('.outline-single-item-content-wrapper, [class*="outline-single-item" i]') || a;
    const parsed = parseRowText(textOf(rowEl));
    let title = parsed.title || textOf(a);
    let kind = parsed.kind || classifyKind(href);
    if (!kind || kind === 'other') kind = classifyKind(href);
    items.push({
      id: id,
      title: title,
      kind: kind || 'other',
      url: href,
      completed: isCompleted(a),
    });
  }
  return items;
}
```

Export it:

```js
parseRowText: parseRowText,
findAccordionHeaders: findAccordionHeaders,
pairHeaderWithPanel: pairHeaderWithPanel,
extractItemsFromPanel: extractItemsFromPanel,
findItemCompletionIndicator: findItemCompletionIndicator,
```

### Step 4: Run

Run: `npm test`
Expected: 2 new tests pass; total 494.

### Step 5: Commit

```bash
git add lib/module-scraper.js tests/module-scraper.test.js
git commit -m "feat(scraper): extract items from accordion panel via row-text parsing"
```

---

## Task 5: `scrapeModuleByAccordion` + wire into `scrapeModule`

**Files:**
- Modify: `lib/module-scraper.js`
- Modify: `tests/module-scraper.test.js`

### Why

Compose Tasks 2–4 into a working pipeline: for each module header, get its panel and items; pick the section containing the current URL's item (or whose panel is expanded — `aria-expanded="true"`; else first non-empty). Wire it into `scrapeModule` as Layer 2, after the existing selector path but before returning empty.

### Step 1: Write the failing tests

Append:

```js
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
```

### Step 2: Run

Run: `npm test`
Expected: first two new tests fail (accordion path missing); third passes (legacy still works).

### Step 3: Implement `scrapeModuleByAccordion` and wire it in

In `lib/module-scraper.js`, add below `extractItemsFromPanel`:

```js
function scrapeModuleByAccordion(doc) {
  if (!doc) return { items: [], section: null };
  const url = (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || '';
  const currentItemId = extractItemId(url);
  const headers = findAccordionHeaders(doc);
  if (headers.length === 0) return { items: [], section: null };
  const pairs = [];
  for (let i = 0; i < headers.length; i++) {
    const panel = pairHeaderWithPanel(headers[i], doc);
    if (!panel) continue;
    pairs.push({ header: headers[i], panel: panel, items: extractItemsFromPanel(panel) });
  }
  if (pairs.length === 0) return { items: [], section: null };
  // 1. Section containing the current URL's item
  if (currentItemId) {
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i].items.some(function (it) { return it.id === currentItemId; })) {
        return { items: pairs[i].items, section: pairs[i].panel };
      }
    }
  }
  // 2. Expanded section (aria-expanded="true")
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].header.getAttribute && pairs[i].header.getAttribute('aria-expanded') === 'true') {
      if (pairs[i].items.length > 0) return { items: pairs[i].items, section: pairs[i].panel };
    }
  }
  // 3. First non-empty section
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].items.length > 0) return { items: pairs[i].items, section: pairs[i].panel };
  }
  return { items: [], section: null };
}
```

Then change `scrapeModule` (replace the entire current body starting around line 219) to:

```js
function scrapeModule(doc) {
  const url = (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || '';
  const courseId = extractCourseId(url);
  const moduleId = extractModuleId(url);
  const currentItemId = extractItemId(url);
  // ---- Layer 1: Existing stable selectors ----
  const containers = allMatching(doc, CONTAINER_SELECTORS);
  if (containers.length > 0) {
    for (let i = 0; i < containers.length; i++) {
      if (!isDrawerContainer(containers[i])) continue;
      const sections = sectionsIn(containers[i]);
      const picked = pickSection(sections, currentItemId);
      if (picked.items.length > 0) {
        return { courseId: courseId, moduleId: moduleId, items: picked.items };
      }
    }
    let chosenItems = null;
    let firstNonEmpty = null;
    for (let i = 0; i < containers.length; i++) {
      const items = collectItemsFrom(containers[i]);
      if (items.length === 0) continue;
      if (!firstNonEmpty) firstNonEmpty = items;
      if (currentItemId && items.some(function (it) { return it.id === currentItemId; })) {
        chosenItems = items;
        break;
      }
    }
    if (chosenItems || firstNonEmpty) {
      return { courseId: courseId, moduleId: moduleId, items: chosenItems || firstNonEmpty };
    }
  }
  // ---- Layer 2: Coursera Design System accordion ----
  const acc = scrapeModuleByAccordion(doc);
  if (acc.items.length > 0) {
    return { courseId: courseId, moduleId: moduleId, items: acc.items };
  }
  return { courseId: courseId, moduleId: moduleId, items: [] };
}
```

Add `scrapeModuleByAccordion` to the exported `api` object.

### Step 4: Run

Run: `npm test`
Expected: all pass.

### Step 5: Commit

```bash
git add lib/module-scraper.js tests/module-scraper.test.js
git commit -m "feat(scraper): accordion layer for Coursera Design System drawers"
```

---

## Task 6: Universality test — second-course accordion fixture

**Files:**
- Modify: `tests/module-scraper.test.js`

### Why

Prove the accordion path isn't MATLAB-specific by running it against a different course (different module names, different item titles, different kinds).

### Step 1: Write the test

Append:

```js
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
```

### Step 2: Run

Run: `npm test`
Expected: passes (everything Task 5 provides covers this).

### Step 3: Commit

```bash
git add tests/module-scraper.test.js
git commit -m "test(scraper): universality test — Python DS accordion fixture"
```

---

## Task 7: `scrapeModuleByText` — pure text-pattern fallback

**Files:**
- Modify: `lib/module-scraper.js`
- Modify: `tests/module-scraper.test.js`

### Why

Even when no accordion roles/classes exist, the drawer DOM still contains text like `Module 1` followed by anchor rows. Detect modules by visible text alone — final defense before going empty.

### Step 1: Write the failing test

Append:

```js
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
```

### Step 2: Run

Run: `npm test`
Expected: 2 new failures (only accordion path exists; no text path yet).

### Step 3: Implement `scrapeModuleByText`

In `lib/module-scraper.js`, add below `scrapeModuleByAccordion`:

```js
function moduleHeaderElements(root) {
  // Elements whose own (excluding deep descendants) text matches the module header pattern.
  const out = [];
  if (!root || typeof root.querySelectorAll !== 'function') return out;
  // Walk all leaf-ish elements: any element with no child elements containing module text,
  // OR an element whose first 80 chars of text matches the pattern at the start.
  const all = root.querySelectorAll('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const t = textOf(el);
    if (!t || t.length > 120) continue;
    if (!MODULE_HEADER_RE.test(t)) continue;
    // Prefer the smallest matching ancestor: skip if a child also matches.
    const childMatch = Array.prototype.some.call(el.children || [], function (c) { return MODULE_HEADER_RE.test(textOf(c)); });
    if (childMatch) continue;
    out.push(el);
  }
  return out;
}

function scrapeModuleByText(doc) {
  if (!doc) return { items: [], section: null };
  const url = (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || '';
  const currentItemId = extractItemId(url);
  const headers = moduleHeaderElements(doc);
  if (headers.length === 0) return { items: [], section: null };
  // For each header, the items it owns = /learn/ anchors that come AFTER this header in
  // document order and BEFORE the next header.
  const anchors = Array.prototype.slice.call(doc.querySelectorAll('a[href*="/learn/"]'));
  const headerPositions = headers.map(function (h, i) {
    return { header: h, items: [], idx: i };
  });
  function compareDoc(a, b) {
    if (a === b) return 0;
    const p = a.compareDocumentPosition(b);
    return (p & 0x04) ? -1 : ((p & 0x02) ? 1 : 0);
  }
  for (let j = 0; j < anchors.length; j++) {
    const a = anchors[j];
    let owner = -1;
    for (let i = 0; i < headers.length; i++) {
      if (compareDoc(headers[i], a) < 0) owner = i; else break;
    }
    if (owner < 0) continue;
    headerPositions[owner].items.push(a);
  }
  function buildItems(anchorList) {
    const items = [];
    const seen = new Set();
    for (let i = 0; i < anchorList.length; i++) {
      const a = anchorList[i];
      const href = a.getAttribute('href');
      const id = extractItemId(href);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const parsed = parseRowText(textOf(a));
      const items_kind = parsed.kind || classifyKind(href);
      items.push({
        id: id,
        title: parsed.title || textOf(a),
        kind: items_kind || 'other',
        url: href,
        completed: isCompleted(a),
      });
    }
    return items;
  }
  // 1. Section containing the current URL's item
  if (currentItemId) {
    for (let i = 0; i < headerPositions.length; i++) {
      const items = buildItems(headerPositions[i].items);
      if (items.some(function (it) { return it.id === currentItemId; })) {
        return { items: items, section: headerPositions[i].header };
      }
    }
  }
  // 2. First non-empty section
  for (let i = 0; i < headerPositions.length; i++) {
    const items = buildItems(headerPositions[i].items);
    if (items.length > 0) return { items: items, section: headerPositions[i].header };
  }
  return { items: [], section: null };
}
```

Wire into `scrapeModule` after the accordion layer:

```js
// ---- Layer 2: Coursera Design System accordion ----
const acc = scrapeModuleByAccordion(doc);
if (acc.items.length > 0) {
  return { courseId: courseId, moduleId: moduleId, items: acc.items };
}
// ---- Layer 3: Pure text-pattern ----
const txt = scrapeModuleByText(doc);
if (txt.items.length > 0) {
  return { courseId: courseId, moduleId: moduleId, items: txt.items };
}
return { courseId: courseId, moduleId: moduleId, items: [] };
```

Export `scrapeModuleByText` on `api`.

### Step 4: Run

Run: `npm test`
Expected: all pass; total 499.

### Step 5: Commit

```bash
git add lib/module-scraper.js tests/module-scraper.test.js
git commit -m "feat(scraper): text-pattern fallback for selector-less drawers"
```

---

## Task 8: `lib/page-fallback.js` — universal page-level helpers

**Files:**
- Create: `lib/page-fallback.js`
- Create: `tests/page-fallback.test.js`

### Why

Five small helpers needed by the controller, the confirmer, and the assignment handler. Pure DOM, no side effects. Tested independently so they're reused with confidence.

### Step 1: Write the failing tests

Create `tests/page-fallback.test.js`:

```js
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
```

### Step 2: Run

Run: `npm test`
Expected: all 12 new tests fail (module doesn't exist).

### Step 3: Implement `lib/page-fallback.js`

Create the file:

```js
// lib/page-fallback.js
// Universal page-level helpers — find Mark-complete / Go-to-next-item / top progress /
// agreement checkbox by visible text and stable aria patterns, not by class hashes.
(function (root) {
  'use strict';

  function normText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  const MARK_COMPLETE_RE = /^(mark\s+as\s+completed?|mark\s+complete|complete|completed)$/i;
  const NEXT_ITEM_RE = /^(go\s+to\s+next\s+item|next\s+item|continue)$/i;
  const PROGRESS_RE = /(\d+)\s*\/\s*(\d+)\s+learning\s+items?/i;

  function findMarkCompleteButton(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;
    const candidates = root.querySelectorAll('button, [role="button"]');
    for (let i = 0; i < candidates.length; i++) {
      if (MARK_COMPLETE_RE.test(normText(candidates[i].textContent))) return candidates[i];
    }
    const labels = root.querySelectorAll('.cds-button-label, [class*="button-label" i]');
    for (let i = 0; i < labels.length; i++) {
      if (MARK_COMPLETE_RE.test(normText(labels[i].textContent))) {
        const btn = labels[i].closest && labels[i].closest('button, [role="button"]');
        if (btn) return btn;
      }
    }
    return null;
  }

  function findGoToNextItemButton(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;
    const els = root.querySelectorAll('button, a, [role="button"]');
    for (let i = 0; i < els.length; i++) {
      if (NEXT_ITEM_RE.test(normText(els[i].textContent))) return els[i];
    }
    return null;
  }

  function findTopProgressText(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const own = normText(el.textContent);
      if (own.length === 0 || own.length > 80) continue;
      if (PROGRESS_RE.test(own)) {
        const hasChildMatch = Array.prototype.some.call(el.children || [], function (c) {
          return PROGRESS_RE.test(normText(c.textContent));
        });
        if (!hasChildMatch) return el;
      }
    }
    return null;
  }

  function parseProgress(text) {
    if (!text) return null;
    const m = String(text).match(PROGRESS_RE);
    if (!m) return null;
    return {
      completed: parseInt(m[1], 10),
      total: parseInt(m[2], 10),
      raw: m[0],
    };
  }

  function findAgreementCheckbox(root) {
    if (!root || typeof root.querySelector !== 'function') return null;
    const byId = root.querySelector('#agreement-checkbox-base');
    if (byId) return byId;
    const cbs = root.querySelectorAll('input[type="checkbox"]');
    for (let i = 0; i < cbs.length; i++) {
      const cb = cbs[i];
      let label = cb.closest && cb.closest('label');
      if (!label && cb.id) label = root.querySelector('label[for="' + cb.id + '"]');
      if (label && /\bagree\b/i.test(normText(label.textContent))) return cb;
    }
    return null;
  }

  const api = {
    findMarkCompleteButton: findMarkCompleteButton,
    findGoToNextItemButton: findGoToNextItemButton,
    findTopProgressText: findTopProgressText,
    parseProgress: parseProgress,
    findAgreementCheckbox: findAgreementCheckbox,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.pageFallback = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

### Step 4: Run

Run: `npm test`
Expected: 12 new tests pass.

### Step 5: Wire into manifest

Modify `manifest.json` to load `lib/page-fallback.js` in the content-script declaration before `content.js`. Open the file, find the `"content_scripts"` block's `"js"` array, and insert `"lib/page-fallback.js"` next to the other `lib/` entries (alphabetical placement, between `lib/numbered-parser.js` and `lib/question-detector.js` or wherever the existing order keeps it consistent — match the existing pattern; if the array order is just "as encountered", append before `content.js`).

### Step 6: Commit

```bash
git add lib/page-fallback.js tests/page-fallback.test.js manifest.json
git commit -m "feat: add lib/page-fallback.js universal page-level helpers"
```

---

## Task 9: Single-page synthetic-queue fallback in the autopilot

**Files:**
- Modify: `lib/module-autopilot.js`
- Modify: `tests/module-autopilot.test.js`

### Why

When `scrapeModule.items === []`, instead of stopping with "No items found", build a synthetic 1-item queue for the current page based on the URL kind, run the handler, then either click `Mark as completed` (if visible) or `Go to next item` to advance — without breaking out of `running` state.

### Step 1: Write the failing test

Append to `tests/module-autopilot.test.js`:

```js
const pageFallbackMod = require('../lib/page-fallback.js');

test('single-page fallback: scrape returns empty → synthetic queue runs current-page handler → clicks Go to next item', async () => {
  const html =
    '<div><h1>Syllabus</h1></div>' +
    '<button id="next-btn">Go to next item</button>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/supplement/r1/syllabus');
  const storage = fakeStorage();
  const handlers = mkFakeHandlers();
  let nextClicked = false;
  j.window.document.getElementById('next-btn').addEventListener('click', function () { nextClicked = true; });
  const confirmer = { waitForCompletion: function () { return Promise.resolve(true); } };
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    confirmer: confirmer,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
    pageFallback: pageFallbackMod,
  });
  await ap.start();
  assert.equal(handlers.calls.length, 1, 'reading handler should run on current page');
  assert.equal(handlers.calls[0].kind, 'reading', 'kind should be reading (URL is /supplement/)');
  assert.equal(nextClicked, true, 'Go to next item button should have been clicked');
});
```

### Step 2: Run

Run: `npm test`
Expected: 1 new failure (handlers.calls.length === 0).

### Step 3: Implement single-page fallback in `start()`

In `lib/module-autopilot.js`, near the top of `createAutopilot(opts)`, add:

```js
const pageFallback = opts.pageFallback
  || (typeof require !== 'undefined' ? (function () { try { return require('./page-fallback.js'); } catch (_) { return null; } })() : null)
  || (root.ClipboardCleaner && root.ClipboardCleaner.pageFallback) || null;
```

Then in `start()`, replace the `if (!scraped.items || scraped.items.length === 0)` block with:

```js
if (!scraped.items || scraped.items.length === 0) {
  logNoItemsDiagnostic();
  // Single-page fallback: build a synthetic 1-item queue from the current URL.
  const syntheticItem = buildSyntheticPageItem(scraperMod, currentUrl(), doc);
  if (!syntheticItem) {
    if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('No items found in this module.');
    return;
  }
  scraped = { courseId: scraped.courseId, moduleId: scraped.moduleId, items: [syntheticItem], singlePage: true };
  if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('▶ Single-page mode for ' + syntheticItem.kind + ' "' + syntheticItem.title + '"');
}
```

Add the `buildSyntheticPageItem` helper near the top of the IIFE (above `createAutopilot`):

```js
function buildSyntheticPageItem(scraperMod, url, doc) {
  if (!url) return null;
  const id = scraperMod.extractItemId(url);
  const kind = scraperMod.classifyKind(url);
  if (kind === 'other' && !id) return null;
  const title = (doc && doc.title) || 'Current page';
  return {
    id: id || ('page-' + (kind || 'unknown')),
    title: title.replace(/\s*\|\s*Coursera\s*$/i, ''),
    kind: kind === 'other' ? 'reading' : kind,
    url: url,
    completed: false,
    syntheticSinglePage: true,
  };
}
```

Then in `runCurrentItem`, after the cursor-advance branch (where `nextCursor >= queueLen`), if the completed item has `syntheticSinglePage`, click the next-item button before going idle:

Replace the `if (nextCursor >= queueLen) { ... }` block with:

```js
if (nextCursor >= queueLen) {
  // If this was a synthetic single-page item, try to advance via Go-to-next-item.
  const wasSingle = item && item.syntheticSinglePage;
  await new Promise(function (resolve) {
    state.update({
      status: wasSingle ? 'running' : 'idle',
      cursor: wasSingle ? nextCursor : nextCursor,
      replyHistory: newReplyHistory,
      ownerTabKey: wasSingle ? tabKey : null,
      queue: [],
      dwellEndsAt: null,
    }, resolve);
  });
  if (wasSingle && pageFallback) {
    const nextBtn = pageFallback.findGoToNextItemButton(doc);
    if (nextBtn) {
      if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('↪ Clicking "Go to next item"');
      try { nextBtn.click(); } catch (_) {}
      // The next page load will re-enter bootIfRunning → re-scrape.
      return true;
    }
  }
  stopHeartbeat();
  if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Module complete.');
  if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('🏁 Module complete');
  if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(false);
  return true;
}
```

### Step 4: Run

Run: `npm test`
Expected: all pass.

### Step 5: Commit

```bash
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(autopilot): single-page synthetic-queue fallback with Go-to-next"
```

---

## Task 10: Video forward-seek fallback

**Files:**
- Modify: `lib/item-handlers.js`
- Modify: `tests/item-handlers.test.js`

### Why

Some Coursera players ignore `video.currentTime = N` writes (DRM/encrypted streams, custom players). Fallback: click the `Seek Video Forward 10 seconds` button enough times to advance to the target time, before the existing `ended` wait.

### Step 1: Write the failing test

Append to `tests/item-handlers.test.js`:

```js
test('video handler: when direct currentTime write does not stick, falls back to Seek Video Forward 10s button', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM(
    '<!doctype html><html><body>' +
      '<video></video>' +
      '<button aria-label="Seek Video Forward 10 seconds" data-fwd></button>' +
    '</body></html>'
  );
  const doc = j.window.document;
  // Simulate a read-only currentTime (writes silently ignored).
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { value: 600, configurable: true });
  let currentTime = 0;
  Object.defineProperty(v, 'currentTime', {
    get: function () { return currentTime; },
    set: function (_) { /* ignored — DRM */ },
    configurable: true,
  });
  v.play = function () { return Promise.resolve(); };
  // Forward button clicks advance the time by 10s.
  let fwdClicks = 0;
  doc.querySelector('[data-fwd]').addEventListener('click', function () {
    fwdClicks += 1;
    currentTime += 10;
    if (currentTime >= 590) {
      // Fire 'ended' once we're near the end so the handler resolves.
      setTimeout(function () { v.dispatchEvent(new j.window.Event('ended')); }, 0);
    }
  });
  const timing = require('../lib/autopilot-timing.js');
  const handlers = require('../lib/item-handlers.js').createHandlers({
    timing: timing, sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
  });
  const ctx = { doc: doc, item: { id: 'x', kind: 'video' }, rng: function () { return 0.5; }, signal: { aborted: false, addEventListener: function () {} } };
  const r = await handlers.video(ctx);
  assert.equal(r.outcome, 'video-done');
  assert.ok(fwdClicks > 0, 'forward seek button should have been clicked');
});
```

### Step 2: Run

Run: `npm test`
Expected: 1 new failure — handler hangs or completes without clicking the forward button.

### Step 3: Implement the forward-seek fallback

In `lib/item-handlers.js`, replace the `if (t.mode === 'seek') { ... }` block inside `async function video(ctx)` with:

```js
if (t.mode === 'seek') {
  let seeked = false;
  try {
    v.currentTime = t.targetTimeSec;
    // Verify the write stuck (some players silently ignore writes on encrypted streams).
    seeked = !isNaN(v.currentTime) && Math.abs((v.currentTime || 0) - t.targetTimeSec) < 5;
  } catch (_) { /* read-only in some envs */ }
  if (!seeked) {
    const fwd = doc.querySelector('button[aria-label*="Seek Video Forward" i], button[aria-label*="seek forward" i]');
    if (fwd) {
      let need = Math.max(0, Math.ceil((t.targetTimeSec - (v.currentTime || 0)) / 10));
      // Cap clicks at 200 to avoid runaway loops on very long videos with broken seek.
      need = Math.min(need, 200);
      for (let i = 0; i < need; i++) {
        try { fwd.click(); } catch (_) {}
      }
    }
  }
}
```

### Step 4: Run

Run: `npm test`
Expected: all pass.

### Step 5: Commit

```bash
git add lib/item-handlers.js tests/item-handlers.test.js
git commit -m "feat(video): fall back to Seek-Video-Forward button when currentTime is read-only"
```

---

## Task 11: Assignment / gradedLti handler with agreement-checkbox

**Files:**
- Modify: `lib/item-handlers.js`
- Modify: `tests/item-handlers.test.js`

### Why

`/gradedLti/` pages have an agreement checkbox that often blocks the rest of the UI. Tick it (dispatch `input` + `change` so React sees the update) and pause with a clear reason — DO NOT auto-submit external assignments.

### Step 1: Write the failing test

Append to `tests/item-handlers.test.js`:

```js
test('assignment handler: ticks agreement checkbox and dispatches input+change, then pauses', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM(
    '<!doctype html><html><body>' +
      '<input id="agreement-checkbox-base" type="checkbox">' +
    '</body></html>'
  );
  const doc = j.window.document;
  const cb = doc.querySelector('#agreement-checkbox-base');
  let events = [];
  cb.addEventListener('input', function () { events.push('input'); });
  cb.addEventListener('change', function () { events.push('change'); });
  const handlers = require('../lib/item-handlers.js').createHandlers({
    timing: require('../lib/autopilot-timing.js'),
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
    pageFallback: require('../lib/page-fallback.js'),
  });
  const ctx = { doc: doc, item: { id: 'x', kind: 'quiz', url: '/learn/x/gradedLti/X7rOE/assignment-x' }, rng: function () { return 0.5; }, signal: { aborted: false, addEventListener: function () {} } };
  const r = await handlers.assignment(ctx);
  assert.equal(cb.checked, true);
  assert.deepEqual(events.sort(), ['change', 'input']);
  assert.equal(r.outcome, 'assignment-agreement-accepted-paused');
});

test('assignment handler: when no agreement checkbox is present, pauses with no-action outcome', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM('<!doctype html><html><body><div>no checkbox</div></body></html>');
  const handlers = require('../lib/item-handlers.js').createHandlers({
    timing: require('../lib/autopilot-timing.js'),
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
    pageFallback: require('../lib/page-fallback.js'),
  });
  const ctx = { doc: j.window.document, item: { id: 'x', kind: 'quiz', url: '/learn/x/gradedLti/X7rOE/assignment-x' }, rng: function () { return 0.5; }, signal: { aborted: false, addEventListener: function () {} } };
  const r = await handlers.assignment(ctx);
  assert.equal(r.outcome, 'assignment-no-action');
});
```

### Step 2: Run

Run: `npm test`
Expected: 2 new failures — `handlers.assignment is not a function`.

### Step 3: Implement the assignment handler

In `lib/item-handlers.js`, inside `createHandlers`, accept `pageFallback` from `deps`:

```js
const pageFallback = (deps && deps.pageFallback) || null;
```

Add a new handler just before the returned object:

```js
async function assignment(ctx) {
  const doc = ctx.doc;
  if (!pageFallback) return { outcome: 'assignment-no-action' };
  const cb = pageFallback.findAgreementCheckbox(doc);
  if (!cb) return { outcome: 'assignment-no-action' };
  if (!cb.checked) {
    try { cb.checked = true; } catch (_) {}
    try { cb.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true })); } catch (_) {}
    try { cb.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true })); } catch (_) {}
  }
  return { outcome: 'assignment-agreement-accepted-paused' };
}
```

Add `assignment: assignment` to the returned `createHandlers` object, alongside the existing `video`, `reading`, `discussion`, `fallback` keys.

Update `lib/module-autopilot.js`'s `isFailureOutcome` to NOT treat `assignment-agreement-accepted-paused` as a hard failure but DO treat it as pause-needed:

```js
function isFailureOutcome(o) {
  if (!o || !o.outcome) return true;
  if (/^pause-needed/.test(o.outcome)) return true;
  if (o.outcome === 'video-autoplay-blocked') return true;
  if (o.outcome === 'video-no-element') return true;
  if (o.outcome === 'discussion-skipped-no-input') return true;
  if (o.outcome === 'quiz-filled-paused-for-review') return true;
  if (o.outcome === 'quiz-filled-no-submit-button') return true;
  if (o.outcome === 'assignment-agreement-accepted-paused') return true;
  if (o.outcome === 'assignment-no-action') return true;
  return false;
}
```

And add user-grade reason text:

```js
const FAILURE_REASON_TEXT = {
  'pause-needed-no-answer': 'no answer text to apply',
  // ...existing entries...
  'assignment-agreement-accepted-paused': 'agreement checked — review and submit manually, then Resume',
  'assignment-no-action': 'graded assignment — review and submit manually, then Resume',
};
```

In `content.js` startup wiring inside `startAutopilot`, pass `pageFallback` into `createHandlers`:

```js
const handlers = a.itemHandlers.createHandlers({
  // ...existing entries...
  pageFallback: a.pageFallback || null,
});
```

Also expose `pageFallback` on the namespace in the page-fallback file — already done in Task 8 (`root.ClipboardCleaner.pageFallback = api`).

Finally, route `gradedLti` and `assignment` kinds to the assignment handler in `lib/module-autopilot.js`'s `handlerForKind`:

```js
function handlerForKind(kind) {
  if (kind === 'quiz' && handlers.assignment && /* current item url has gradedLti */ false) {
    // (we route by item.kind, not URL — see below)
  }
  if (handlers[kind]) return handlers[kind];
  return handlers.fallback;
}
```

Actually simpler: extend the scraper's URL classifier so `/gradedLti/` returns `kind: 'assignment'` (a new kind) instead of `'quiz'`. Add to `KIND_BY_SEGMENT` in `lib/module-scraper.js`:

```js
const KIND_BY_SEGMENT = {
  lecture: 'video',
  supplement: 'reading',
  discussionPrompt: 'discussion',
  quiz: 'quiz',
  exam: 'quiz',
  assignment: 'quiz',
  peer: 'peer-review',
  programming: 'programming',
  gradedLti: 'assignment',
};
```

And update `handlerForKind` to route `'assignment'` to `handlers.assignment`:

```js
function handlerForKind(kind) {
  if (kind === 'assignment' && handlers.assignment) return handlers.assignment;
  if (handlers[kind]) return handlers[kind];
  return handlers.fallback;
}
```

### Step 4: Run

Run: `npm test`
Expected: all new + existing tests pass.

### Step 5: Commit

```bash
git add lib/item-handlers.js lib/module-autopilot.js lib/module-scraper.js content.js tests/item-handlers.test.js
git commit -m "feat(autopilot): assignment handler ticks agreement checkbox + pauses"
```

---

## Task 12: Top-progress watcher in `completion-confirmer`

**Files:**
- Modify: `lib/completion-confirmer.js`
- Modify: `tests/completion-confirmer.test.js`

### Why

`findItemCompletionIndicator` requires a per-row indicator. As a secondary signal, also watch the top progress text (`0/3 learning items` → `1/3 learning items`). When `completed` increases between calls, treat as confirmation.

### Step 1: Write the failing test

Append to `tests/completion-confirmer.test.js`:

```js
test('waitForCompletion: top-progress count increase counts as confirmation', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM('<!doctype html><html><body><div data-prog>0/3 learning items</div></body></html>');
  const doc = j.window.document;
  const scraper = {
    findItemCompletionIndicator: function () { return null; }, // never finds row indicator
  };
  const pageFallback = require('../lib/page-fallback.js');
  let polls = 0;
  const sleep = function () {
    polls += 1;
    // After the 2nd poll, bump the progress.
    if (polls === 2) doc.querySelector('[data-prog]').textContent = '1/3 learning items';
    return Promise.resolve();
  };
  const confirmer = require('../lib/completion-confirmer.js').createConfirmer({ sleep: sleep });
  const r = await confirmer.waitForCompletion({
    doc: doc, itemId: 'v1', scraper: scraper,
    pageFallback: pageFallback,
    timeoutMs: 60000, pollIntervalMs: 1,
  });
  assert.equal(r, true);
});
```

### Step 2: Run

Run: `npm test`
Expected: 1 new failure (pageFallback isn't consulted yet).

### Step 3: Update `waitForCompletion`

In `lib/completion-confirmer.js`, modify `waitForCompletion` to also watch top-progress:

```js
async function waitForCompletion(opts) {
  opts = opts || {};
  const doc = opts.doc;
  const itemId = opts.itemId;
  const scraper = opts.scraper;
  const pageFallback = opts.pageFallback;
  const signal = opts.signal;
  const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = (typeof opts.pollIntervalMs === 'number' && opts.pollIntervalMs > 0) ? opts.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
  if (!scraper || typeof scraper.findItemCompletionIndicator !== 'function') return false;
  const start = nowFn();
  let baselineProgress = null;
  if (pageFallback && typeof pageFallback.findTopProgressText === 'function') {
    const el = pageFallback.findTopProgressText(doc);
    if (el) baselineProgress = pageFallback.parseProgress(el.textContent);
  }
  while (true) {
    if (signal && signal.aborted) throw new Error('aborted');
    if (scraper.findItemCompletionIndicator(doc, itemId)) return true;
    if (baselineProgress && pageFallback) {
      const el = pageFallback.findTopProgressText(doc);
      if (el) {
        const cur = pageFallback.parseProgress(el.textContent);
        if (cur && cur.total === baselineProgress.total && cur.completed > baselineProgress.completed) return true;
      }
    }
    const elapsed = nowFn() - start;
    if (elapsed >= timeoutMs) return false;
    await sleep(pollIntervalMs, signal);
  }
}
```

In `lib/module-autopilot.js`'s `runCurrentItem`, pass `pageFallback` into the confirmer call:

```js
confirmed = await confirmer.waitForCompletion({
  doc: doc, itemId: item.id, scraper: scraperMod,
  pageFallback: pageFallback,
  signal: signal, timeoutMs: PRIMARY_CONFIRMER_TIMEOUT_MS,
});
```

And the same for the post-fallback retry call below it.

### Step 4: Run

Run: `npm test`
Expected: all pass.

### Step 5: Commit

```bash
git add lib/completion-confirmer.js lib/module-autopilot.js tests/completion-confirmer.test.js
git commit -m "feat(confirmer): treat top-progress count increase as completion signal"
```

---

## Task 13: Mark-complete fallback uses the page-fallback finder

**Files:**
- Modify: `lib/module-autopilot.js`
- Modify: `tests/module-autopilot.test.js`

### Why

The existing `tryMarkCompleteFallback` in `item-handlers.js` only looks for `button[aria-label*="mark as completed" i]`. Real Coursera renders the button with text inside `span.cds-button-label`, not on an aria-label. Use `pageFallback.findMarkCompleteButton` as an additional fallback finder.

### Step 1: Write the failing test

Append to `tests/module-autopilot.test.js`:

```js
test('mark-complete fallback uses pageFallback.findMarkCompleteButton for span.cds-button-label buttons', async () => {
  const html =
    MODULE_HTML +
    '<button data-real-mark><span class="cds-button-label">Mark as completed</span></button>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' },
    { id: 'r1', kind: 'reading', url: '/learn/x/supplement/r1/reading', title: 'R' },
  ];
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkFakeHandlers();
  // Don't inject tryMarkCompleteFallback — force the controller to use pageFallback.
  let callIdx = 0;
  const confirmer = { waitForCompletion: function () { callIdx += 1; return Promise.resolve(callIdx >= 2); } };
  let markClicked = false;
  j.window.document.querySelector('[data-real-mark]').addEventListener('click', function () { markClicked = true; });
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    confirmer: confirmer,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function () { return Promise.resolve(); },
    pageFallback: require('../lib/page-fallback.js'),
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.bootIfRunning();
  assert.equal(markClicked, true, 'span.cds-button-label Mark-as-completed should be clicked by the fallback');
});
```

### Step 2: Run

Run: `npm test`
Expected: 1 new failure.

### Step 3: Wire `pageFallback.findMarkCompleteButton` into the controller's fallback chain

In `lib/module-autopilot.js`'s `runCurrentItem`, where the existing `fallback = ... tryMarkCompleteFallback` is invoked, insert a `pageFallback`-driven attempt first:

```js
if (!confirmed) {
  let markClicked = false;
  if (pageFallback && typeof pageFallback.findMarkCompleteButton === 'function') {
    const btn = pageFallback.findMarkCompleteButton(doc);
    if (btn) {
      try { btn.click(); markClicked = true; } catch (_) {}
      if (markClicked && sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('↻ Clicked Mark-as-completed (page-fallback) for "' + (item.title || item.id) + '"');
    }
  }
  if (!markClicked) {
    const handlersApi = (typeof require !== 'undefined') ? require('./item-handlers.js')
      : (root.ClipboardCleaner && root.ClipboardCleaner.itemHandlers);
    const fallback = (handlers && handlers.tryMarkCompleteFallback)
      || (handlersApi && handlersApi.tryMarkCompleteFallback);
    if (fallback && fallback(doc)) {
      markClicked = true;
      if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('↻ Clicked Mark-as-complete fallback for "' + (item.title || item.id) + '"');
    }
  }
  if (markClicked) {
    try {
      confirmed = await confirmer.waitForCompletion({
        doc: doc, itemId: item.id, scraper: scraperMod,
        pageFallback: pageFallback,
        signal: signal, timeoutMs: FALLBACK_CONFIRMER_TIMEOUT_MS,
      });
    } catch (_) { /* abort */ }
  }
}
```

### Step 4: Run

Run: `npm test`
Expected: all pass.

### Step 5: Commit

```bash
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(autopilot): use pageFallback.findMarkCompleteButton for cds-button-label"
```

---

## Task 14: Richer no-items diagnostic

**Files:**
- Modify: `lib/module-scraper.js`
- Modify: `lib/module-autopilot.js`
- Modify: `tests/module-scraper.test.js`

### Why

When the 3-layer scraper still finds zero items, the log should reveal accordion/panel/anchor/Mark-complete/Go-next counts and small DOM samples — so we can fix new Coursera layouts without guessing.

### Step 1: Write the failing test

Append to `tests/module-scraper.test.js`:

```js
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
```

### Step 2: Run

Run: `npm test`
Expected: 1 new failure.

### Step 3: Extend `scrapeModuleDiagnostics`

In `lib/module-scraper.js`, replace `scrapeModuleDiagnostics`:

```js
function scrapeModuleDiagnostics(doc) {
  const candidates = CONTAINER_SELECTORS.map(function (sel) {
    const list = doc.querySelectorAll(sel);
    let itemCount = 0;
    for (let i = 0; i < list.length; i++) {
      itemCount += list[i].querySelectorAll('a[href*="/learn/"]').length;
    }
    return { selector: sel, matched: list.length > 0, nodeCount: list.length, itemCount: itemCount };
  });
  let sectionCount = 0;
  for (let i = 0; i < SECTION_SELECTORS.length; i++) {
    const found = doc.querySelectorAll(SECTION_SELECTORS[i]).length;
    if (found > sectionCount) sectionCount = found;
  }
  const totalItemsFound = candidates.reduce(function (n, c) { return n + c.itemCount; }, 0);
  const headers = findAccordionHeaders(doc);
  const accordionPanelCount = doc.querySelectorAll('[id*="accordion-panel" i], [role="region"]').length;
  const learnAnchorCount = doc.querySelectorAll('a[href*="/learn/"]').length;
  const markCompleteCount = Array.prototype.filter.call(
    doc.querySelectorAll('button, [role="button"]'),
    function (b) { return /^(mark\s+as\s+completed?|mark\s+complete|complete|completed)$/i.test(textOf(b)); }
  ).length;
  const goToNextCount = Array.prototype.filter.call(
    doc.querySelectorAll('button, a, [role="button"]'),
    function (b) { return /^(go\s+to\s+next\s+item|next\s+item|continue)$/i.test(textOf(b)); }
  ).length;
  const headerSamples = headers.slice(0, 3).map(function (h) { return textOf(h).slice(0, 80); });
  const anchorSamples = Array.prototype.slice.call(doc.querySelectorAll('a[href*="/learn/"]'), 0, 5).map(function (a) { return textOf(a).slice(0, 80); });
  return {
    containerCandidates: candidates,
    totalItemsFound: totalItemsFound,
    sectionCount: sectionCount,
    accordionHeaderCount: headers.length,
    accordionPanelCount: accordionPanelCount,
    learnAnchorCount: learnAnchorCount,
    markCompleteCount: markCompleteCount,
    goToNextCount: goToNextCount,
    headerSamples: headerSamples,
    anchorSamples: anchorSamples,
  };
}
```

### Step 4: Update `logNoItemsDiagnostic` in `lib/module-autopilot.js`

Replace the matched/no-matched branches to also surface the new counts:

```js
function logNoItemsDiagnostic() {
  if (!sidebar.appendAutopilotLog) return;
  let diag = null;
  try {
    diag = scraperMod.scrapeModuleDiagnostics && scraperMod.scrapeModuleDiagnostics(doc);
  } catch (_) { /* diagnostic is best-effort */ }
  if (!diag || !diag.containerCandidates) {
    sidebar.appendAutopilotLog('No items found — scraper has no diagnostic helper');
    return;
  }
  const hits = diag.containerCandidates.filter(function (c) { return c.matched; });
  const extras = 'accordion=' + diag.accordionHeaderCount + ', panels=' + diag.accordionPanelCount
    + ', learn-anchors=' + diag.learnAnchorCount
    + ', mark-complete-btns=' + diag.markCompleteCount
    + ', go-next-btns=' + diag.goToNextCount;
  const samples = '; headers=[' + (diag.headerSamples || []).map(function (s) { return JSON.stringify(s); }).join(', ') + ']'
    + '; anchor-text=[' + (diag.anchorSamples || []).map(function (s) { return JSON.stringify(s); }).join(', ') + ']';
  if (hits.length === 0) {
    sidebar.appendAutopilotLog('No items found — 0 candidate containers matched. ' + extras + samples);
  } else {
    sidebar.appendAutopilotLog('No items found — ' + hits.length + ' container(s) matched but yielded 0 items; sections=' + diag.sectionCount + '. ' + extras + samples);
  }
}
```

### Step 5: Run

Run: `npm test`
Expected: all pass.

### Step 6: Commit

```bash
git add lib/module-scraper.js lib/module-autopilot.js tests/module-scraper.test.js
git commit -m "feat(diagnostics): richer no-items log with accordion/page-fallback counts"
```

---

## Task 15: Run full suite + push to PR #3 + change summary

**Files:**
- Modify: `docs/superpowers/plans/2026-05-23-coursera-adaptive-scraper-and-controls.md`

### Step 1: Run the full suite

Run: `npm test`
Expected: all tests pass. Record the final pass count.

### Step 2: Push to PR #3

Run: `git push origin feat/module-autopilot`
Verify the push succeeded and PR #3 shows the new commits.

### Step 3: Append a `## Change Summary` section to this plan file

Append:

```markdown
---

## Change Summary

**New scraper fallback strategy (3 layers):**
1. Existing stable selectors (`[data-testid="lesson-collection"]`, `[data-testid="course-content-drawer"]`, etc.) — unchanged.
2. Coursera Design System accordion — find headers via `button[class*="AccordionHeader" i]` or visible-text `/Module|Week|Lesson N/`, pair to panels via `aria-controls` (or following sibling subtree), extract items from `<a href*="/learn/">` anchors using `parseRowText` to split concatenated row text into title + kind.
3. Pure text-pattern fallback — no class/testid required. Walk the DOM for elements whose own text matches the module-header pattern, attribute each `/learn/` anchor to the nearest preceding header, build per-module item lists.

**New video seek strategy:**
- Direct `video.currentTime = N` write attempted first. If the write doesn't stick (encrypted/DRM stream), click `button[aria-label*="Seek Video Forward" i]` `ceil((target - current) / 10)` times (cap 200) to advance.

**Mark as completed detection:**
- New `pageFallback.findMarkCompleteButton(root)` matches button text `Mark as completed` / `Mark complete` / `Complete` / `Completed` on `<button>`, `[role="button"]`, or `span.cds-button-label`'s closest button — universal, no class-hash dependency.
- The autopilot tries this finder BEFORE the existing `tryMarkCompleteFallback`.

**Go to next item fallback:**
- New `pageFallback.findGoToNextItemButton(root)` matches `Go to next item` / `Next item` / `Continue` on buttons and anchors.
- The autopilot clicks this when running in single-page mode and the current item completed — drives forward without a parsed queue.

**Assignment / gradedLti agreement handling:**
- `/gradedLti/` URLs now classify as `kind: 'assignment'` (new entry in `KIND_BY_SEGMENT`).
- New `handlers.assignment(ctx)` ticks `#agreement-checkbox-base` (or any `<input type="checkbox">` inside a label mentioning "agree"), dispatches `input` + `change` events so React state updates, then pauses with reason `agreement checked — review and submit manually, then Resume`. Never auto-submits.

**Completion confirmation strategy:**
- Primary: per-row `findItemCompletionIndicator` against expanded `COMPLETED_SELECTORS` with `isPositiveCompletionEl` rejection of "Not completed" / "not-completed" markers (already in place).
- Secondary (new): top progress text `N/M learning items` — confirmer takes a baseline before waiting, and treats a strictly-increasing `completed` count (with unchanged `total`) as confirmation.
- Fallback chain after primary timeout: `pageFallback.findMarkCompleteButton` → `tryMarkCompleteFallback` → retry confirmer up to `FALLBACK_CONFIRMER_TIMEOUT_MS`.

**Single-page synthetic queue:**
- When `scrapeModule.items === []`, the controller builds a 1-item queue from the current URL's kind (`/lecture/` → video, `/supplement/` → reading, `/quiz/` → quiz, `/gradedLti/` → assignment). On successful handler+confirmer, the controller clicks `Go to next item` to navigate, re-entering `bootIfRunning` on the next page.

**Diagnostics:**
- `scrapeModuleDiagnostics` now returns `accordionHeaderCount`, `accordionPanelCount`, `learnAnchorCount`, `markCompleteCount`, `goToNextCount`, `headerSamples` (first 3 module-header texts), and `anchorSamples` (first 5 `/learn/` anchor texts). The autopilot's "No items found" log surfaces all of them.

**Tests:** 481 → final count after this plan.
```

### Step 4: Commit the summary

```bash
git add docs/superpowers/plans/2026-05-23-coursera-adaptive-scraper-and-controls.md
git commit -m "docs(plan): record change summary for universal Coursera adapter"
```

### Step 5: Push

```bash
git push origin feat/module-autopilot
```

---

## Self-Review

**Spec coverage (against the user's bullet list):**
- Existing known selectors first → Layer 1 in Task 5 (unchanged). ✓
- Accordion structural fallback (`cds-AccordionHeader-button`, panel via `aria-controls`, `ul > li > a`) → Tasks 2, 3, 4, 5. ✓
- Text-structure fallback (Module N text → group anchors by kind metadata) → Task 7. ✓
- Current-page fallback (synthetic 1-item queue + Go to next item) → Task 9. ✓
- Video prefer `<video>`, currentTime → forward-seek button fallback → Task 10. ✓
- After video: wait for confirmation → Mark complete → pause → Task 12 (top-progress watcher) + Task 13 (mark-complete fallback). ✓
- Mark complete finder (text-based, span.cds-button-label support) → Task 8 (`findMarkCompleteButton`). ✓
- Agreement checkbox on assignment/LTI → Task 11. ✓
- Go to next item finder → Task 8 (`findGoToNextItemButton`); used in Task 9. ✓
- Completion confirmation via top progress text → Task 12. ✓
- Improved diagnostics (counts + samples) → Task 14. ✓
- Tests for: accordion fixture (Task 5), second-course fixture (Task 6), video controls (Task 10), Mark complete `span.cds-button-label` (Task 8), Go next (Task 8), assignment agreement (Task 11), diagnostics (Task 14). ✓
- Run full suite + push to PR #3 + summary → Task 15. ✓

**Placeholder scan:** No "TBD" / "add appropriate" / "similar to" — every code change shows the code verbatim. All helper signatures fixed in the lock-in table at the top.

**Type / name consistency:**
- `parseRowText` — Tasks 1, 4, 7. Same return shape. ✓
- `findAccordionHeaders` — Tasks 2, 5, 14. ✓
- `pairHeaderWithPanel` — Tasks 3, 5. ✓
- `extractItemsFromPanel` — Tasks 4, 5. ✓
- `scrapeModuleByAccordion`, `scrapeModuleByText` — Tasks 5, 7. ✓
- `classifyVisibleKind` — Task 1 export; used by `parseRowText`. ✓
- `pageFallback.findMarkCompleteButton` / `findGoToNextItemButton` / `findTopProgressText` / `parseProgress` / `findAgreementCheckbox` — Tasks 8, 9, 11, 12, 13, 14. Same name throughout. ✓
- `Item` shape (`id`, `title`, `kind`, `url`, `completed`, `syntheticSinglePage?`) — Tasks 4, 9. ✓
- `assignment-agreement-accepted-paused` outcome string — Task 11 export + Task 11 isFailureOutcome wiring. ✓
- `KIND_BY_SEGMENT.gradedLti = 'assignment'` — Task 11. Handler routes via `handlerForKind`. ✓
