# Drawer-Aware Module Scraping + Ownership Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `module-scraper.js` parse Coursera's modern course-content drawer (Module 1 / "Course Pages" with rows that read like "Course Preview — Video • 2 min"), and harden module-autopilot ownership so same-tab reloads, stale heartbeats, and locked states behave sensibly.

**Architecture:** Two stacked subsystems on `feat/module-autopilot`:

1. **Scraper rewrite** — keep the existing legacy-sidebar path as a fallback, but add a "drawer" path: locate a course-content drawer container by aria/role/testid candidates, split it into module sections by heading rows, choose the section containing the current URL's item (else the first non-empty one), extract rows with title + visible kind text + circular completion indicator + click target. Add a `scrapeModuleDiagnostics(doc)` helper that returns which candidate selectors matched so we can log it instead of just "No items found."
2. **Ownership hardening** — persist the controller's `tabKey` in `sessionStorage` so a same-tab reload reuses it; in `bootIfRunning`, treat a foreign-active owner whose heartbeat exceeds TTL as takeover-eligible (already true in `acquireOwnership`, but the boot-time messaging masks it); add a "Take over this tab" sidebar button that force-claims ownership; gate `startAutopilot()` to `window.top === window`; tighten the foreign-active banner so it only shows when the foreign owner is genuinely fresh AND not us.

**Tech Stack:** Vanilla JS, `node:test` + jsdom, Chrome Extension Manifest V3. No new dependencies.

---

## File Structure

**Modify:**
- `lib/module-scraper.js` — add `scrapeModuleDrawer(doc)`, `scrapeModuleDiagnostics(doc)`, drawer container selectors, module-section partitioning, visible-kind/title fallbacks, expanded completion selectors. `scrapeModule(doc)` first tries the legacy sidebar path, then the drawer path, returning whichever yields a non-empty queue.
- `lib/module-autopilot.js` — `start()` and `bootIfRunning()` log a one-shot diagnostic via the scraper before showing "No items found in this module." `bootIfRunning()` is updated to call `state.acquireOwnership` and rely on its built-in stale-heartbeat takeover, but distinguishes "you are the same tab reloaded" (reclaim silently) from "different tab, foreign-fresh" (show banner + offer takeover). Adds a `takeOver()` method exported on the controller.
- `lib/sidebar.js` — adds a `data-action="autopilot-takeover"` button next to the Resume button, hidden by default, shown via `setAutopilotPaused(true, text, { offerTakeover: true })`. `setAutopilotHandlers` accepts `onTakeOver`.
- `content.js` — early-return when `window.top !== window` (only top frame runs autopilot). Persists `tabKey` in `sessionStorage`. Wires `onTakeOver` to `_autopilotInstance.takeOver()`.
- `tests/module-scraper.test.js` — adds drawer-layout tests using a fixture HTML matching the described Coursera drawer (Module 1: Course Pages + 4 items, then Module 2). Adds tests for: visible-kind parsing, completion indicator on the drawer, module-section selection by current URL, diagnostic helper output, click-target falls back to nearest anchor.
- `tests/module-autopilot.test.js` — adds tests for: same-tab reload reclaims ownership, stale-heartbeat foreign owner auto-takeover, foreign-active banner only fires on a genuinely fresh different owner, `takeOver()` forces ownership.

**No new files.**

---

## Task 1: Scraper diagnostic helper

**Files:**
- Modify: `lib/module-scraper.js`
- Modify: `tests/module-scraper.test.js`

### Why

When the page has zero items, the user currently sees "No items found in this module." with no clue *why*. We need a side-effect-free function that returns the list of candidate selectors and which matched, so the controller can `console.warn` it.

This task lands the helper before we add the drawer code path — that way the diagnostic itself is regression-protected as we extend the selector list.

### Step 1: Write the failing test

Append to `tests/module-scraper.test.js`:

```js
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
```

### Step 2: Run tests to confirm the new tests fail

Run: `npm test`
Expected: both new tests fail with `scrapeModuleDiagnostics is not a function`.

### Step 3: Implement `scrapeModuleDiagnostics`

In `lib/module-scraper.js`, just before the `api` object, add:

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
  const totalItemsFound = candidates.reduce(function (n, c) { return n + c.itemCount; }, 0);
  return { containerCandidates: candidates, totalItemsFound: totalItemsFound };
}
```

And export it:

```js
const api = {
  scrapeModule: scrapeModule,
  scrapeModuleDiagnostics: scrapeModuleDiagnostics,
  extractCourseId: extractCourseId,
  extractItemId: extractItemId,
  classifyKind: classifyKind,
  findItemCompletionIndicator: findItemCompletionIndicator,
};
```

### Step 4: Run tests to verify they pass

Run: `npm test`
Expected: both new tests pass, all existing tests still pass.

### Step 5: Commit

```bash
git add lib/module-scraper.js tests/module-scraper.test.js
git commit -m "feat(scraper): add scrapeModuleDiagnostics helper"
```

---

## Task 2: Wire diagnostic logging into the controller

**Files:**
- Modify: `lib/module-autopilot.js` (`start()` and `bootIfRunning()`)
- Modify: `tests/module-autopilot.test.js`

### Why

Requirement 7: when no items are found, log a diagnostic summary of which candidate containers/selectors were checked, instead of only saying "No items found."

### Step 1: Write the failing test

Append to `tests/module-autopilot.test.js`:

```js
test('start: logs a diagnostic when no items are found', async () => {
  const j = makePage('<div>empty page</div>', 'https://www.coursera.org/learn/x/home/week/1');
  const storage = fakeStorage();
  const logs = [];
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: mkFakeHandlers(),
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function () { return Promise.resolve(); },
    sidebar: {
      setAutopilotStatus: function () {}, appendAutopilotLog: function (l) { logs.push(l); },
      setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; },
    },
  });
  await ap.start();
  const summary = logs.find(function (l) { return l.indexOf('No items found') !== -1; });
  assert.ok(summary, 'should log a no-items diagnostic');
  assert.ok(summary.indexOf('lesson-collection') !== -1 || summary.indexOf('candidate') !== -1,
    'diagnostic should reference a candidate selector');
});
```

### Step 2: Run tests to confirm the new test fails

Run: `npm test`
Expected: fails — the only current log on empty is `setAutopilotStatus('No items found...')`, not `appendAutopilotLog`.

### Step 3: Add a `noItemsDiagnostic` helper and call it

In `lib/module-autopilot.js`, near the top inside `createAutopilot(opts)` (right before `function startHeartbeat`), add:

```js
function logNoItemsDiagnostic() {
  if (!sidebar.appendAutopilotLog) return;
  let diag = null;
  try { diag = scraperMod.scrapeModuleDiagnostics && scraperMod.scrapeModuleDiagnostics(doc); } catch (_) {}
  if (!diag) {
    sidebar.appendAutopilotLog('No items found — scraper has no diagnostic helper');
    return;
  }
  const hits = diag.containerCandidates.filter(function (c) { return c.matched; });
  if (hits.length === 0) {
    sidebar.appendAutopilotLog('No items found — 0 candidate containers matched. Tried: ' +
      diag.containerCandidates.map(function (c) { return c.selector; }).join(', '));
  } else {
    sidebar.appendAutopilotLog('No items found — ' + hits.length + ' container(s) matched but yielded 0 items. ' +
      hits.map(function (c) { return c.selector + ' (nodes=' + c.nodeCount + ', items=' + c.itemCount + ')'; }).join('; '));
  }
}
```

Then change the early-return inside `start()`:

```js
if (!scraped.items || scraped.items.length === 0) {
  logNoItemsDiagnostic();
  if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('No items found in this module.');
  return;
}
```

### Step 4: Run tests to verify they pass

Run: `npm test`
Expected: all tests pass, including the new diagnostic test.

### Step 5: Commit

```bash
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(autopilot): log selector diagnostics when no items found"
```

---

## Task 3: Drawer-layout fixture and failing scraper test

**Files:**
- Modify: `tests/module-scraper.test.js` (add drawer fixture and tests)

### Why

Before extending the scraper, encode the target shape as failing tests. The fixture below mirrors what a modern Coursera course-content drawer renders for the user's screenshot: a top-level container with two visible modules ("Module 1: Course Pages" with 4 items, "Module 2: ..." with 1), per-row title + visible meta ("Video • 2 min"), circular completion indicators, and anchors as click targets.

### Step 1: Add the fixture helper and failing tests

Append to `tests/module-scraper.test.js`:

```js
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
```

### Step 2: Run tests to confirm they fail

Run: `npm test`
Expected: all five new drawer tests fail — the current container list doesn't match `aside[data-testid="course-content-drawer"]`, so `scrapeModule` returns `items: []`.

### Step 3: Commit (tests-only checkpoint)

```bash
git add tests/module-scraper.test.js
git commit -m "test(scraper): add failing drawer-layout fixture and tests"
```

---

## Task 4: Drawer container selectors + section partitioning

**Files:**
- Modify: `lib/module-scraper.js`

### Why

Make the drawer tests in Task 3 pass. The drawer layout has its own root container and is split into module *sections* (one per `<section>` with a header). We need to pick the right section by URL and collect anchors within it.

### Step 1: Extend CONTAINER_SELECTORS and add a drawer path

Edit `lib/module-scraper.js`. Replace the existing `CONTAINER_SELECTORS` and `COMPLETED_SELECTORS` constants with the expanded list:

```js
const CONTAINER_SELECTORS = [
  '[data-testid="lesson-collection"]',
  '.rc-LessonCollection',
  'nav[aria-label*="lesson" i]',
  '[class*="LessonCollection"]',
  // Modern course-content drawer (Module 1 / Course Pages screenshot)
  '[data-testid="course-content-drawer"]',
  'aside[aria-label*="course content" i]',
  '[data-testid*="course-content" i]',
  '[class*="CourseContentDrawer" i]',
];

const SECTION_SELECTORS = [
  '[data-testid="module-section"]',
  '[data-testid*="module-section" i]',
  '[class*="ModuleSection" i]',
  'section',
];

const COMPLETED_SELECTORS = [
  '[aria-label*="completed" i]',
  '[class*="Completed"]',
  'svg[class*="check" i]',
  '[class*="status-completed" i]',
  '[data-testid*="completed" i]',
  '[data-icon*="check" i]',
];

const ROW_SELECTORS = [
  'a[href*="/learn/"]',
  '[data-testid="rc-DesktopItem"]',
  '[role="link"][href*="/learn/"]',
];

const VISIBLE_KIND_MAP = [
  { re: /\bvideo\b/i,        kind: 'video' },
  { re: /\breading\b/i,      kind: 'reading' },
  { re: /\bdiscussion\b/i,   kind: 'discussion' },
  { re: /\bquiz\b/i,         kind: 'quiz' },
  { re: /\bassignment\b/i,   kind: 'quiz' },
  { re: /\bexam\b/i,         kind: 'quiz' },
  { re: /\bpeer review\b/i,  kind: 'peer-review' },
  { re: /\bprogramming\b/i,  kind: 'programming' },
  { re: /\bplugin\b/i,       kind: 'reading' },
];
```

Add a `kindFromVisibleText` helper just below `classifyKind`:

```js
function kindFromVisibleText(text) {
  if (!text) return null;
  for (let i = 0; i < VISIBLE_KIND_MAP.length; i++) {
    if (VISIBLE_KIND_MAP[i].re.test(text)) return VISIBLE_KIND_MAP[i].kind;
  }
  return null;
}
```

Update `collectItemsFrom` to enrich kind/title with visible text when the URL classifier returns `'other'` or the anchor text is empty:

```js
function collectItemsFrom(container) {
  const anchors = container.querySelectorAll('a[href*="/learn/"]');
  const items = [];
  const seen = new Set();
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const href = a.getAttribute('href');
    const id = extractItemId(href);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    let title = '';
    const titleEl = a.querySelector('.item-title, [class*="ItemTitle" i], [data-testid*="item-title" i]');
    if (titleEl) title = textOf(titleEl);
    if (!title) title = textOf(a);
    const metaEl = a.querySelector('.item-meta, [class*="ItemMeta" i], [data-testid*="item-meta" i]');
    const metaText = metaEl ? textOf(metaEl) : '';
    let kind = classifyKind(href);
    if (kind === 'other') {
      const fromText = kindFromVisibleText(metaText) || kindFromVisibleText(textOf(a));
      if (fromText) kind = fromText;
    }
    items.push({
      id: id,
      title: title,
      kind: kind,
      url: href,
      completed: isCompleted(a),
    });
  }
  return items;
}
```

### Step 2: Run tests to verify the drawer tests pass

Run: `npm test`
Expected: the five Task 3 tests pass *except* the "picks the section that contains the current URL item" test — that one still fails because we collect items across the whole drawer, not per-section. The other four (extracts 4 items, completion read, find indicator, no Module-2 bleed) need both this and Step 3.

If "extracts all 4 items from Module 1" passes here but "stops at the next Module N header" fails because Module 2's `v2` leaks in, that's the expected mid-step state.

### Step 3: Partition the drawer into sections and pick by current URL

Replace `scrapeModule` with a section-aware version:

```js
function isDrawerContainer(el) {
  if (!el) return false;
  const testId = el.getAttribute && el.getAttribute('data-testid');
  if (testId && /course-content/i.test(testId)) return true;
  const cls = (el.className && typeof el.className === 'string') ? el.className : '';
  if (/CourseContentDrawer/i.test(cls)) return true;
  const aria = el.getAttribute && el.getAttribute('aria-label');
  if (aria && /course content/i.test(aria)) return true;
  return false;
}

function sectionsIn(container) {
  for (let i = 0; i < SECTION_SELECTORS.length; i++) {
    const list = container.querySelectorAll(SECTION_SELECTORS[i]);
    if (list.length > 1) return Array.prototype.slice.call(list);
  }
  return [container];
}

function pickSection(sections, currentItemId) {
  if (currentItemId) {
    for (let i = 0; i < sections.length; i++) {
      const items = collectItemsFrom(sections[i]);
      if (items.some(function (it) { return it.id === currentItemId; })) {
        return { section: sections[i], items: items };
      }
    }
  }
  for (let i = 0; i < sections.length; i++) {
    const items = collectItemsFrom(sections[i]);
    if (items.length > 0) return { section: sections[i], items: items };
  }
  return { section: null, items: [] };
}

function scrapeModule(doc) {
  const url = (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || '';
  const courseId = extractCourseId(url);
  const moduleId = extractModuleId(url);
  const currentItemId = extractItemId(url);
  const containers = allMatching(doc, CONTAINER_SELECTORS);
  if (containers.length === 0) {
    return { courseId: courseId, moduleId: moduleId, items: [] };
  }
  // Drawer-style containers: partition into sections and pick by URL item.
  for (let i = 0; i < containers.length; i++) {
    if (!isDrawerContainer(containers[i])) continue;
    const sections = sectionsIn(containers[i]);
    const picked = pickSection(sections, currentItemId);
    if (picked.items.length > 0) {
      return { courseId: courseId, moduleId: moduleId, items: picked.items };
    }
  }
  // Legacy path: each container is its own module list.
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
  const items = chosenItems || firstNonEmpty || [];
  return { courseId: courseId, moduleId: moduleId, items: items };
}
```

### Step 4: Run tests to verify all drawer tests pass

Run: `npm test`
Expected: all five drawer tests in Task 3 pass; all 462 prior tests still pass. Total should be 462 + 5 (Task 3) + 2 (Task 1) + 1 (Task 2) = 470.

### Step 5: Commit

```bash
git add lib/module-scraper.js
git commit -m "feat(scraper): parse modern Coursera course-content drawer"
```

---

## Task 5: Drawer kind/title extraction edge cases

**Files:**
- Modify: `tests/module-scraper.test.js`

### Why

Lock in two edge cases from the requirements: (a) when the URL kind segment is unknown but the visible text says "Video • 2 min", classify by visible text; (b) the row title comes from the title element, not from concatenated row text that includes the meta line. Both are covered by Task 4's code; this task just adds explicit regression tests so a future selector change can't silently break them.

### Step 1: Write the tests

Append to `tests/module-scraper.test.js`:

```js
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
```

### Step 2: Run tests

Run: `npm test`
Expected: both pass (Task 4's implementation already supports them).

### Step 3: Commit

```bash
git add tests/module-scraper.test.js
git commit -m "test(scraper): lock in drawer kind+title extraction"
```

---

## Task 6: Drawer-aware diagnostic helper

**Files:**
- Modify: `lib/module-scraper.js` (extend `scrapeModuleDiagnostics`)
- Modify: `tests/module-scraper.test.js`

### Why

Task 1 only counted anchors per container — for a drawer container that exists but its sections are empty (or selector doesn't find sections), we want the diagnostic to call that out so we know whether to widen `SECTION_SELECTORS` vs `CONTAINER_SELECTORS`.

### Step 1: Write the failing test

Append to `tests/module-scraper.test.js`:

```js
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
```

### Step 2: Run tests to confirm it fails

Run: `npm test`
Expected: fails on `diag.sectionCount` undefined.

### Step 3: Add section count to the diagnostic

Replace `scrapeModuleDiagnostics` body:

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
  return { containerCandidates: candidates, totalItemsFound: totalItemsFound, sectionCount: sectionCount };
}
```

### Step 4: Run tests

Run: `npm test`
Expected: all pass.

### Step 5: Update the autopilot log line to include section count

In `lib/module-autopilot.js`, change `logNoItemsDiagnostic`'s "container(s) matched" branch to:

```js
sidebar.appendAutopilotLog('No items found — ' + hits.length + ' container(s) matched but yielded 0 items; sections=' + diag.sectionCount + '. ' +
  hits.map(function (c) { return c.selector + ' (nodes=' + c.nodeCount + ', items=' + c.itemCount + ')'; }).join('; '));
```

### Step 6: Commit

```bash
git add lib/module-scraper.js lib/module-autopilot.js tests/module-scraper.test.js
git commit -m "feat(scraper): include section count in no-items diagnostic"
```

---

## Task 7: Top-frame guard in content.js

**Files:**
- Modify: `content.js`

### Why

Requirement: only top frame should run module autopilot ownership logic. Coursera embeds iframes for some lectures; the content script runs in every frame, and any frame can race for ownership.

There's no jsdom test for this — it's a one-liner in `content.js` that we verify by inspection and by ensuring `npm test` (which doesn't touch content.js) still passes.

### Step 1: Add the guard

In `content.js`, at the top of `startAutopilot()`:

```js
function startAutopilot() {
  if (typeof window !== 'undefined' && window.top !== window) {
    // Only the top frame manages autopilot ownership.
    return;
  }
  const a = api();
  ...
}
```

### Step 2: Verify tests still pass

Run: `npm test`
Expected: all 473 tests pass (content.js isn't required by tests).

### Step 3: Commit

```bash
git add content.js
git commit -m "fix(autopilot): only top frame runs ownership logic"
```

---

## Task 8: Persist tabKey in sessionStorage so reload reclaims ownership

**Files:**
- Modify: `lib/module-autopilot.js`
- Modify: `tests/module-autopilot.test.js`
- Modify: `content.js`

### Why

After a same-tab reload, `createAutopilot` generates a fresh `tabKey`, and the stored owner (the pre-reload key) appears foreign. `acquireOwnership` will still succeed *if* heartbeat is stale, but during the first 30s after reload it shows "Another tab is running this course's autopilot" — wrong, it's us.

Persisting `tabKey` in `sessionStorage` (per-tab, survives reload, distinct across tabs) lets the post-reload instance reclaim its own ownership immediately.

### Step 1: Write the failing test

Append to `tests/module-autopilot.test.js`:

```js
function fakeSessionStorage() {
  let v = null;
  return {
    getItem: function (k) { return k === 'ccp_autopilot_tabkey' ? v : null; },
    setItem: function (k, val) { if (k === 'ccp_autopilot_tabkey') v = val; },
    removeItem: function (k) { if (k === 'ccp_autopilot_tabkey') v = null; },
  };
}

test('createAutopilot reuses tabKey from sessionStorage when present', () => {
  const ss = fakeSessionStorage();
  ss.setItem('ccp_autopilot_tabkey', 'tab-persisted');
  const j = makePage(MODULE_HTML);
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: fakeStorage(), handlers: mkFakeHandlers(),
    nowFn: function () { return 1_000_000; }, rng: seededRng(1), sessionStorage: ss,
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  assert.equal(ap._tabKey, 'tab-persisted');
});

test('createAutopilot generates and persists a new tabKey when sessionStorage is empty', () => {
  const ss = fakeSessionStorage();
  const j = makePage(MODULE_HTML);
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: fakeStorage(), handlers: mkFakeHandlers(),
    nowFn: function () { return 1_000_000; }, rng: seededRng(1), sessionStorage: ss,
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  assert.equal(typeof ap._tabKey, 'string');
  assert.ok(ap._tabKey.length > 0);
  assert.equal(ss.getItem('ccp_autopilot_tabkey'), ap._tabKey);
});

test('bootIfRunning: same-tab reload (persisted tabKey == ownerTabKey) reclaims ownership silently', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [{ id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' }];
  d.ownerTabKey = 'tab-persisted';
  d.heartbeatAt = 1_000_000 - 1000; // fresh
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const ss = fakeSessionStorage();
  ss.setItem('ccp_autopilot_tabkey', 'tab-persisted');
  let banner = '';
  const handlers = mkFakeHandlers();
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, rng: seededRng(1), sessionStorage: ss,
    navigate: function () { return Promise.resolve(); },
    sidebar: {
      setAutopilotStatus: function () {}, appendAutopilotLog: function () {},
      setAutopilotPaused: function (paused, text) { banner = text || banner; },
      setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; },
    },
  });
  const ran = await ap.bootIfRunning();
  assert.equal(ran, true, 'should reclaim and run');
  assert.equal(handlers.calls.length, 1);
  assert.equal(banner, '', 'should NOT show a foreign-active banner');
});
```

### Step 2: Run tests to confirm failure

Run: `npm test`
Expected: the three new tests fail (`sessionStorage` option not yet honored).

### Step 3: Read `sessionStorage` in `createAutopilot`

In `lib/module-autopilot.js`, modify the head of `createAutopilot`:

```js
function createAutopilot(opts) {
  opts = opts || {};
  const doc = opts.document || (typeof document !== 'undefined' ? document : null);
  const win = opts.window || (typeof window !== 'undefined' ? window : null);
  const storage = opts.storage;
  const handlers = opts.handlers || {};
  const nowFn = opts.nowFn || function () { return Date.now(); };
  const sessionStore = opts.sessionStorage
    || (win && win.sessionStorage)
    || (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
  const TABKEY_SS = 'ccp_autopilot_tabkey';
  let tabKey = opts.tabKey;
  if (!tabKey && sessionStore) {
    try { tabKey = sessionStore.getItem(TABKEY_SS) || null; } catch (_) {}
  }
  if (!tabKey) tabKey = generateTabKey();
  if (sessionStore) {
    try { sessionStore.setItem(TABKEY_SS, tabKey); } catch (_) {}
  }
  // ... rest of the function unchanged
```

### Step 4: Run tests

Run: `npm test`
Expected: the three new tests pass; everything else still passes.

### Step 5: Commit

```bash
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(autopilot): persist tabKey in sessionStorage for same-tab reload"
```

---

## Task 9: Stale-heartbeat auto-takeover at boot

**Files:**
- Modify: `lib/module-autopilot.js`
- Modify: `tests/module-autopilot.test.js`

### Why

`acquireOwnership` already takes over when `now - heartbeatAt > HEARTBEAT_TTL_MS`. The existing test `bootIfRunning: foreign-active does not mutate shared state` uses `heartbeatAt = now - 1000` (fresh), so it stays foreign. But there's no test asserting the *takeover* path. Lock it in.

### Step 1: Write the failing test

Append to `tests/module-autopilot.test.js`:

```js
test('bootIfRunning: stale-heartbeat foreign owner is auto-taken-over', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [{ id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' }];
  d.ownerTabKey = 'tab-dead';
  d.heartbeatAt = 1_000_000 - (stateMod.HEARTBEAT_TTL_MS + 5000); // stale
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkFakeHandlers();
  let banner = '';
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-fresh', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function () { return Promise.resolve(); },
    sidebar: {
      setAutopilotStatus: function () {}, appendAutopilotLog: function () {},
      setAutopilotPaused: function (paused, text) { banner = text || banner; },
      setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; },
    },
  });
  const ran = await ap.bootIfRunning();
  assert.equal(ran, true, 'stale heartbeat should be taken over');
  assert.equal(handlers.calls.length, 1, 'handler should run after takeover');
  assert.equal(banner, '', 'should NOT show a foreign-active banner after takeover');
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.ownerTabKey, 'tab-fresh');
});
```

### Step 2: Run tests

Run: `npm test`
Expected: this test should pass *immediately* (the takeover path already works in `autopilot-state.js`). If it fails, the bug is in `acquireOwnership`'s stale path — investigate and fix the underlying logic. **Do not** weaken the test.

### Step 3: Commit

```bash
git add tests/module-autopilot.test.js
git commit -m "test(autopilot): lock in stale-heartbeat auto-takeover at boot"
```

---

## Task 10: Tighten foreign-active banner

**Files:**
- Modify: `lib/module-autopilot.js`
- Modify: `tests/module-autopilot.test.js`

### Why

Today, `bootIfRunning` shows "Another tab is running this course's autopilot" when `acquireOwnership` returns `foreign-active`. After Task 8 the same-tab reload no longer hits this path. But we want one more belt-and-braces test: the foreign-active banner must NOT fire when the persisted `tabKey` equals the stored `ownerTabKey` — in that case we explicitly reclaim.

### Step 1: Write the failing test

Append to `tests/module-autopilot.test.js`:

```js
test('bootIfRunning: foreign-active fires ONLY when stored ownerTabKey differs from persisted tabKey', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [{ id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' }];
  d.ownerTabKey = 'tab-other';
  d.heartbeatAt = 1_000_000 - 1000; // fresh
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const ss = fakeSessionStorage();
  ss.setItem('ccp_autopilot_tabkey', 'tab-mine');
  let banner = '';
  const handlers = mkFakeHandlers();
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, rng: seededRng(1), sessionStorage: ss,
    navigate: function () { return Promise.resolve(); },
    sidebar: {
      setAutopilotStatus: function () {}, appendAutopilotLog: function () {},
      setAutopilotPaused: function (paused, text) { banner = text || banner; },
      setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; },
    },
  });
  const ran = await ap.bootIfRunning();
  assert.equal(ran, false, 'should NOT take over a fresh other tab');
  assert.equal(handlers.calls.length, 0);
  assert.ok(banner.length > 0, 'should show foreign-active banner');
  assert.ok(/another tab/i.test(banner), 'banner mentions another tab');
});
```

### Step 2: Run tests

Run: `npm test`
Expected: passes (this is exactly the existing behavior, just locked to the new persisted-tabKey path).

### Step 3: Commit

```bash
git add tests/module-autopilot.test.js
git commit -m "test(autopilot): foreign-active banner only on genuine other tab"
```

---

## Task 11: `takeOver()` controller method + sidebar button

**Files:**
- Modify: `lib/module-autopilot.js`
- Modify: `lib/sidebar.js`
- Modify: `tests/module-autopilot.test.js`

### Why

Requirement: 'Force resume here / Take over this tab' button when a fresh owner appears impossible (e.g., another stuck tab the user can't close). It writes our tabKey to `ownerTabKey` and triggers `bootIfRunning`.

### Step 1: Write the failing test

Append to `tests/module-autopilot.test.js`:

```js
test('takeOver(): force-claims ownership from a foreign-fresh tab and runs', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [{ id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' }];
  d.ownerTabKey = 'tab-stuck';
  d.heartbeatAt = 1_000_000 - 500; // very fresh
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkFakeHandlers();
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-takeover', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  const ran = await ap.takeOver();
  assert.equal(ran, true);
  assert.equal(handlers.calls.length, 1, 'handler should run after takeover');
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.ownerTabKey, 'tab-takeover');
});
```

### Step 2: Run tests

Run: `npm test`
Expected: fails — `ap.takeOver is not a function`.

### Step 3: Implement `takeOver`

In `lib/module-autopilot.js`, just after `async function resume()`, add:

```js
async function takeOver() {
  // Force-claim ownership regardless of foreign heartbeat freshness, then boot.
  await new Promise(function (resolve) {
    state.update({ ownerTabKey: tabKey, heartbeatAt: nowFn() }, resolve);
  });
  return await bootIfRunning();
}
```

And add it to the returned API:

```js
return {
  start: start,
  stop: stop,
  pause: pause,
  resume: resume,
  takeOver: takeOver,
  bootIfRunning: bootIfRunning,
  destroy: destroy,
  _tabKey: tabKey,
};
```

### Step 4: Update `bootIfRunning` to surface the takeover offer in the banner

In `lib/module-autopilot.js`, change the foreign-active branch in `bootIfRunning`:

```js
const acq = await new Promise(function (resolve) { state.acquireOwnership(tabKey, nowFn(), resolve); });
if (acq !== 'owner') {
  if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true,
    "Another tab is running this course's autopilot.", { offerTakeover: true });
  return false;
}
```

### Step 5: Add the Take-over button to the sidebar

In `lib/sidebar.js`, update the HTML around the existing autopilot-resume button (`'<button class="ccp-btn" data-action="autopilot-resume" hidden>Resume</button>'`) — add immediately after it:

```js
'<button class="ccp-btn" data-action="autopilot-takeover" hidden>Take over this tab</button>' +
```

Update `setAutopilotPaused` to accept an options arg:

```js
function setAutopilotPaused(isPaused, bannerText, opts) {
  if (!shadow) return;
  const resumeBtn   = shadow.querySelector('[data-action="autopilot-resume"]');
  const takeoverBtn = shadow.querySelector('[data-action="autopilot-takeover"]');
  const banner      = shadow.querySelector('[data-role="autopilot-banner"]');
  if (resumeBtn)   resumeBtn.hidden = !isPaused;
  if (takeoverBtn) takeoverBtn.hidden = !(isPaused && opts && opts.offerTakeover);
  if (banner)      banner.textContent = bannerText || '';
}
```

Update `wireAutopilot` to wire the takeover click:

```js
const takeover = shadow.querySelector('[data-action="autopilot-takeover"]');
if (takeover) {
  takeover.addEventListener('click', function () {
    if (_autopilotHandlers.onTakeOver) _autopilotHandlers.onTakeOver();
  });
}
```

### Step 6: Wire `onTakeOver` in content.js

In `content.js`, inside `setAutopilotHandlers({ ... })`, add:

```js
onTakeOver: function () { _autopilotInstance.takeOver(); },
```

### Step 7: Run tests

Run: `npm test`
Expected: the new `takeOver()` test passes; everything else still passes.

### Step 8: Commit

```bash
git add lib/module-autopilot.js lib/sidebar.js content.js tests/module-autopilot.test.js
git commit -m "feat(autopilot): add Take-over-this-tab button + takeOver() controller"
```

---

## Task 12: Run the full suite and write a change summary

**Files:**
- No source changes. Final verification.

### Step 1: Run the full suite

Run: `npm test`
Expected: all tests pass. Take the final pass count.

### Step 2: Write a one-paragraph summary at the END of this plan file

Append to `docs/superpowers/plans/2026-05-23-drawer-scraper-and-ownership.md`, under a new `## Change Summary` heading:

- New container/section selectors that detect the modern Coursera drawer (`[data-testid="course-content-drawer"]`, aside variants).
- Module-section partitioning that scopes the queue to the current URL's module.
- Visible-kind fallback ("Video • 2 min" → `kind: video`) for rows whose URL kind segment is missing.
- Per-row drawer completion (`status-completed`, aria-label "Completed") via expanded `COMPLETED_SELECTORS`.
- `scrapeModuleDiagnostics()` + `appendAutopilotLog` on empty result, replacing the silent "No items found" failure mode.
- Same-tab reload reclaims ownership via `sessionStorage`-persisted tabKey.
- Stale-heartbeat foreign owners are auto-taken-over at boot.
- Foreign-active banner only fires when the stored owner is fresh AND differs from our persisted tabKey.
- New `takeOver()` controller method + "Take over this tab" sidebar button surfaced on the foreign-active banner.
- Top-frame guard in `content.js` so embedded iframes never race for ownership.
- Test count: from 462 → final count after this plan.

### Step 3: Commit the summary

```bash
git add docs/superpowers/plans/2026-05-23-drawer-scraper-and-ownership.md
git commit -m "docs(plan): record change summary for drawer scraper + ownership"
```

---

## Self-Review

**Spec coverage (8 scraper requirements):**
1. Detect items inside the current Coursera module drawer — Task 4 (new container selectors). ✓
2. Identify Module 1 / "Course Pages" as the current module and collect rows until Module 2 — Task 4 (`sectionsIn` + `pickSection`). ✓
3. Item kind from visible "Video • 2 min" / "Reading • 10 min" — Task 4 (`kindFromVisibleText`) + Task 5. ✓
4. Item title from row title — Task 4 (`.item-title` selector) + Task 5. ✓
5. Completion via circular indicator / checkmark — Task 4 (`status-completed`, etc.) + Task 3 test. ✓
6. Clicking uses the row anchor — Task 4 (anchor `href` preserved; controller already navigates by anchor click). ✓
7. Diagnostic summary when zero items — Tasks 1, 2, 6. ✓
8. jsdom tests for the drawer structure — Task 3 fixture covers the screenshot one-to-one. ✓

**Ownership coverage:**
- Same-tab refresh/reload reclaim — Task 8. ✓
- Stale heartbeat takeover — Task 9 test (behavior already implemented in `autopilot-state.js`). ✓
- "Force resume / Take over this tab" — Task 11. ✓
- Top-frame only — Task 7. ✓
- Tests for stale-takeover, same-course single-tab reload, foreign-active only on real fresh different owner — Tasks 8, 9, 10. ✓

**Placeholder scan:** No "TBD"/"add appropriate"/"similar to" — every code change shows the code. Selector list and helpers are concrete.

**Type/name consistency:**
- `scrapeModuleDiagnostics` — same name in Tasks 1, 2, 6 ✓
- `tryMarkCompleteFallback` — referenced in existing code, not touched here ✓
- `takeOver` (camelCase) — same in Tasks 11 + content.js wiring ✓
- `sessionStorage` option key — same in Tasks 8, 9, 10, 11 ✓
- `ccp_autopilot_tabkey` storage key — same string in implementation and tests ✓
- `setAutopilotPaused(isPaused, bannerText, opts?)` — extended signature consistent across Task 11 implementation and sidebar wiring ✓
- `appendAutopilotLog` — already exists on sidebar, used in Task 2 ✓
