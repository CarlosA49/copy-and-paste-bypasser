# Discussion Blocking + Already-Completed Shortcut Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the autopilot skip Discussion Prompt items as safely as it skips graded/quiz/peer items, and short-circuit any item that already shows a completion indicator — outline green check (any kind) or "Reading completed" h3 (reading pages) — so the autopilot moves to the next safe item immediately instead of dwelling and waiting for the confirmer to time out.

**Architecture:** Three small, layered additions. (1) **Classifier**: extend `isBlockedAssessmentItem` with `/discussionPrompt/` and `/discussion/` URL patterns + `Discussion Prompt` text + `discussion` kind. (2) **Page-level detector**: new `pageFallback.findCompletedReadingIndicator(root)` that matches `aria-label="Reading completed"` or `<hN aria-label="Completed">` headings. (3) **Pre-handler shortcut**: at the top of `runCurrentItem`, check `scraperMod.findGreenCompletionIconInRow(doc, item.id)` and (for reading items) `pageFallback.findCompletedReadingIndicator(doc)`; if either is true, log `✓ Already completed: "{title}"`, click `findGoToNextItemButton(doc)` if present, and route through the existing success path (which records the course log, advances the cursor, and navigates) — skipping the handler + confirmer entirely.

**Tech Stack:** Vanilla JS, IIFE dual-export modules, Node `node:test` + jsdom, Chrome MV3. No new dependencies.

---

## File Structure

**Modify:**
- `lib/module-scraper.js` — extend `BLOCKED_URL_PATTERNS`, `BLOCKED_TITLE_PATTERNS`, `BLOCKED_KINDS`.
- `lib/page-fallback.js` — add `findCompletedReadingIndicator(root)`.
- `lib/module-autopilot.js` — (a) replace the two existing `⏭ Skipped graded/blocked` log lines with a kind-aware `blockReasonLabel(item)` so discussion items log `⏭ Skipped discussion prompt: "..."`; (b) insert a pre-handler already-complete shortcut at the top of `runCurrentItem`.
- `tests/module-scraper.test.js` — discussion-prompt blocking tests.
- `tests/page-fallback.test.js` — `findCompletedReadingIndicator` tests + a `findGoToNextItemButton` regression test for `span.cds-button-label`.
- `tests/module-autopilot.test.js` — pre-handler shortcut tests + multi-scope tests (module boundary stop + course-scope cross-module continuation) + discussion-skipped log test.

**Create:** none.

**Sizing note:** All additions are small. `lib/module-autopilot.js` gains ~50 lines for the shortcut. `lib/module-scraper.js` adds 3 entries to existing constants. `lib/page-fallback.js` adds ~30 lines. Tests grow by ~250 lines.

---

## Helper Naming & Return Shapes (Lock In)

- `pageFallback.findCompletedReadingIndicator(root) → Element | true | null`
- Item outcomes (new): `'already-completed'` (treated as a SUCCESS outcome — `isFailureOutcome` returns false for unknown outcomes by default)
- Log markers (sidebar appendAutopilotLog):
  - `⏭ Skipped graded item: "{title}"` — quiz/exam/assignment/programming/peer-review/generic graded
  - `⏭ Skipped discussion prompt: "{title}"` — discussion-kind items
  - `✓ Already completed: "{title}"` — pre-handler shortcut
- Controller helper: `blockReasonLabel(item) → string` (e.g., `'graded item'`, `'discussion prompt'`, `'peer review'`)

---

## Task 1: Block Discussion Prompts in `isBlockedAssessmentItem`

**Files:**
- Modify: `lib/module-scraper.js`
- Modify: `tests/module-scraper.test.js`

### Why

Discussion Prompt pages have a text input that the existing discussion handler may interact with — but the user does not want autopilot to type into or submit discussion prompts on real Coursera courses. Treat them as the same family as graded/quiz/peer items: classify, skip, log.

### Step 1: Write failing tests

Append to `tests/module-scraper.test.js`:

```js
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
```

### Step 2: Run

Run: `npm test`
Expected: 4 new failures (the two regression tests already pass).

### Step 3: Extend the constants

In `lib/module-scraper.js`, find `BLOCKED_URL_PATTERNS` (around line 102) and add the discussion patterns:

```js
const BLOCKED_URL_PATTERNS = [
  /\/gradedLti\//i,
  /\/assignment-submission\//i,
  /\/quiz\//i,
  /\/exam\//i,
  /\/peer\//i,
  /\/programming\//i,
  /\/review\//i,
  /\/discussionPrompt\//i,
  /\/discussion\//i,
];
```

Then in `BLOCKED_TITLE_PATTERNS`:

```js
const BLOCKED_TITLE_PATTERNS = [
  /\bgraded\b/i,
  /\bassignment\b/i,
  /\bexam\b/i,
  /\bquiz\b/i,
  /\bpeer\b/i,
  /\bassessment\b/i,
  /\breview your peers\b/i,
  /\bapp item\b/i,
  /\bdiscussion prompt\b/i,
];
```

And `BLOCKED_KINDS`:

```js
const BLOCKED_KINDS = ['quiz', 'peer-review', 'programming', 'assignment', 'discussion'];
```

### Step 4: Run

Run: `npm test`
Expected: all 6 new tests pass. CHECK FOR REGRESSIONS — existing tests that exercise `discussion` kind as a safe item will now fail. Specifically, look at `tests/module-scraper.test.js` for:
- `isBlockedAssessmentItem: plain readings/videos are NOT blocked` — this test asserts that a discussion item is NOT blocked. It will FAIL after this change. Update that test: remove the `discussionPrompt` line from the non-blocked group (or change the discussion assertion to expect `true`).
- `isBlockedAssessmentItem: discussion is NOT blocked (safe content)` — this entire test will fail. Update its assertion to `assert.equal(..., true)` and rename the test to `isBlockedAssessmentItem: discussion IS now blocked`.

Apply those test updates. Run again — all should pass.

### Step 5: Commit

```bash
git add lib/module-scraper.js tests/module-scraper.test.js
git commit -m "feat(scraper): block discussion prompts as graded-family"
```

---

## Task 2: Kind-aware skip log labels

**Files:**
- Modify: `lib/module-autopilot.js`
- Modify: `tests/module-autopilot.test.js`

### Why

The current generic log line `⏭ Skipped graded/blocked: "{title}"` is fine for graded items but reads oddly for discussion prompts. Replace with a small `blockReasonLabel(item)` helper that returns a friendly category — "graded item", "quiz", "exam", "peer review", "discussion prompt", "programming assignment", or just "blocked".

### Step 1: Write the failing test

Append to `tests/module-autopilot.test.js`:

```js
test('start: discussion items log "⏭ Skipped discussion prompt:" with the item title', async () => {
  const html =
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/x/lecture/v1/intro">Intro</a>' +
      '<a href="/learn/x/discussionPrompt/d1/services">Services Discussion</a>' +
    '</div>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const handlers = mkFakeHandlers();
  const logs = [];
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function () { return Promise.resolve(); },
    sidebar: {
      setAutopilotStatus: function () {}, appendAutopilotLog: function (l) { logs.push(l); },
      setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; },
    },
    navigateUrlChangeTimeoutMs: 10,
  });
  await ap.start();
  const skipLog = logs.find(function (l) { return /Skipped discussion prompt/.test(l); });
  assert.ok(skipLog, 'should log "Skipped discussion prompt"');
  assert.ok(/Services Discussion/.test(skipLog), 'should include the item title');
});
```

### Step 2: Run

Run: `npm test`
Expected: 1 new failure (current code logs "graded/blocked" not "discussion prompt").

### Step 3: Implement `blockReasonLabel` and update log sites

In `lib/module-autopilot.js`, near the top of the IIFE (after `isFailureOutcome` definition), add:

```js
function blockReasonLabel(item) {
  if (!item) return 'blocked';
  const kind = (item.kind || '').toLowerCase();
  const url = (item.url || '');
  const title = (item.title || '');
  if (kind === 'discussion' || /\/discussion(Prompt)?\//i.test(url) || /\bdiscussion prompt\b/i.test(title)) return 'discussion prompt';
  if (kind === 'peer-review' || /\/peer\//i.test(url) || /\breview your peers\b/i.test(title)) return 'peer review';
  if (/\/exam\//i.test(url) || /\bexam\b/i.test(title)) return 'exam';
  if (kind === 'quiz' || /\/quiz\//i.test(url) || /\bquiz\b/i.test(title)) return 'quiz';
  if (kind === 'programming' || /\/programming\//i.test(url)) return 'programming assignment';
  if (/\/gradedLti\//i.test(url) || /\/assignment-submission\//i.test(url) || /\bgraded\b/i.test(title) || /\bapp item\b/i.test(title) || /\bassignment\b/i.test(title)) return 'graded item';
  return 'blocked';
}
```

Then find BOTH existing skip-log sites in `lib/module-autopilot.js` (one in `start()` around line 305 and one in `startAllModules()` around line 379) and replace each:

OLD (both sites):
```js
sidebar.appendAutopilotLog('⏭ Skipped graded/blocked: "' + (skipped[i].item.title || skipped[i].item.id) + '"');
```

NEW (both sites):
```js
const _label = blockReasonLabel(skipped[i].item);
sidebar.appendAutopilotLog('⏭ Skipped ' + _label + ': "' + (skipped[i].item.title || skipped[i].item.id) + '"');
```

### Step 4: Run

Run: `npm test`
Expected: new test passes. CHECK FOR REGRESSIONS — the existing test `start: filters out blocked items (gradedLti, quiz, peer) from the queue` asserts `logs.some(function (l) { return /Skipped/.test(l); })` — that still matches because all the new lines contain "Skipped". Pass.

### Step 5: Commit

```bash
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(autopilot): kind-aware skip log labels (discussion prompt, quiz, peer, ...)"
```

---

## Task 3: `findCompletedReadingIndicator` page-fallback helper

**Files:**
- Modify: `lib/page-fallback.js`
- Modify: `tests/page-fallback.test.js`

### Why

Coursera's completed reading page renders `<h3 aria-label="Reading completed">Completed</h3>` in the main content area. The autopilot needs a row-independent signal to know "we landed on a page that's already done" so it can short-circuit.

### Step 1: Write failing tests

Append to `tests/page-fallback.test.js`:

```js
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
```

### Step 2: Run

Run: `npm test`
Expected: all 6 new tests fail.

### Step 3: Implement `findCompletedReadingIndicator`

In `lib/page-fallback.js`, just below the existing `findAgreementCheckbox`, add:

```js
const READING_COMPLETED_ARIA_RE = /reading\s+completed/i;
const PURE_COMPLETED_ARIA_RE = /^\s*completed\s*$/i;
const HEADING_TAGS = { H1: true, H2: true, H3: true, H4: true, H5: true, H6: true };

function findCompletedReadingIndicator(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return null;
  const els = root.querySelectorAll('[aria-label]');
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const aria = el.getAttribute('aria-label') || '';
    if (READING_COMPLETED_ARIA_RE.test(aria)) return el;
    if (PURE_COMPLETED_ARIA_RE.test(aria) && el.tagName && HEADING_TAGS[el.tagName.toUpperCase()]) return el;
  }
  return null;
}
```

Add to the `api` object:

```js
const api = {
  findMarkCompleteButton: findMarkCompleteButton,
  findGoToNextItemButton: findGoToNextItemButton,
  findTopProgressText: findTopProgressText,
  parseProgress: parseProgress,
  findAgreementCheckbox: findAgreementCheckbox,
  findCompletedReadingIndicator: findCompletedReadingIndicator,
};
```

### Step 4: Run

Run: `npm test`
Expected: all 6 new tests pass.

NOTE: the `findGoToNextItemButton` span.cds-button-label regression test already passes against the existing implementation (button `.textContent` includes the child span's text). Confirm it passes; no implementation change needed for that helper.

### Step 5: Commit

```bash
git add lib/page-fallback.js tests/page-fallback.test.js
git commit -m "feat(page-fallback): findCompletedReadingIndicator + Go-to-next regression test"
```

---

## Task 4: Pre-handler already-complete shortcut in `runCurrentItem`

**Files:**
- Modify: `lib/module-autopilot.js`
- Modify: `tests/module-autopilot.test.js`

### Why

When `runCurrentItem` is invoked on an item whose outline row already has a green check (or whose reading page already shows "Reading completed"), the existing flow runs the handler + waits for the confirmer + may also click Mark-complete — a slow path that can take 5-45 seconds. Short-circuit: log `✓ Already completed`, click `Go to next item` if visible, and fall straight through to the existing success path (recordCourseItem + cursor advance + navigate).

### Step 1: Write failing tests

Append to `tests/module-autopilot.test.js`:

```js
test('already-complete shortcut: video item with green check in outline row skips handler and advances cursor', async () => {
  const html =
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/x/lecture/v1/intro"><svg style="color: rgb(39, 106, 26);"><rect/></svg>Intro</a>' +
      '<a href="/learn/x/supplement/r1/r">R</a>' +
    '</div>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' },
    { id: 'r1', kind: 'reading', url: '/learn/x/supplement/r1/r', title: 'R' },
  ];
  d.cursor = 0;
  d.ownerTabKey = 'tab-1';
  d.heartbeatAt = 1_000_000;
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkFakeHandlers();
  const navTargets = [];
  const logs = [];
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function (url) { navTargets.push(url); return Promise.resolve(); },
    sidebar: {
      setAutopilotStatus: function () {}, appendAutopilotLog: function (l) { logs.push(l); },
      setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; },
    },
    navigateUrlChangeTimeoutMs: 10,
  });
  await ap.bootIfRunning();
  // The video handler must NOT have been called.
  assert.equal(handlers.calls.length, 0, 'handler should be skipped for already-completed item');
  // Should have logged the already-completed line.
  assert.ok(logs.some(function (l) { return /Already completed/.test(l); }));
  // Should have advanced to the next item (r1).
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.cursor, 1);
  assert.ok(navTargets.some(function (u) { return u.indexOf('/supplement/r1/') !== -1; }));
});

test('already-complete shortcut: reading page with "Reading completed" h3 skips handler and clicks Go to next item', async () => {
  const html =
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/x/supplement/r1/sy">Syllabus</a>' +
      '<a href="/learn/x/lecture/v1/intro">V</a>' +
    '</div>' +
    '<main><h3 aria-label="Reading completed">Completed</h3></main>' +
    '<button id="next">Go to next item</button>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/supplement/r1/sy');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'r1', kind: 'reading', url: '/learn/x/supplement/r1/sy', title: 'Syllabus' },
    { id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'V' },
  ];
  d.cursor = 0;
  d.ownerTabKey = 'tab-1';
  d.heartbeatAt = 1_000_000;
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  let nextClicked = false;
  j.window.document.getElementById('next').addEventListener('click', function () { nextClicked = true; });
  const handlers = mkFakeHandlers();
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
    pageFallback: require('../lib/page-fallback.js'),
    navigateUrlChangeTimeoutMs: 10,
  });
  await ap.bootIfRunning();
  assert.equal(handlers.calls.find(function (c) { return c.kind === 'reading'; }), undefined, 'reading handler should be skipped');
  assert.equal(nextClicked, true, 'should have clicked Go to next item');
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.cursor, 1);
});

test('already-complete shortcut: when no Go-to-next button exists, still advances via queue navigation', async () => {
  const html =
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/x/lecture/v1/intro"><svg style="color: rgb(39, 106, 26);"><rect/></svg>Intro</a>' +
      '<a href="/learn/x/supplement/r1/r">R</a>' +
    '</div>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' },
    { id: 'r1', kind: 'reading', url: '/learn/x/supplement/r1/r', title: 'R' },
  ];
  d.cursor = 0;
  d.ownerTabKey = 'tab-1';
  d.heartbeatAt = 1_000_000;
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkFakeHandlers();
  const navTargets = [];
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function (url) { navTargets.push(url); return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
    navigateUrlChangeTimeoutMs: 10,
  });
  await ap.bootIfRunning();
  // No button → navigate fallback. Should hit navigate() for r1.
  assert.ok(navTargets.some(function (u) { return u.indexOf('/supplement/r1/') !== -1; }), 'navigate should be called for next item');
});

test('already-complete shortcut: when ALL items are already complete, module finishes cleanly', async () => {
  const html =
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/x/lecture/v1/intro"><svg style="color: rgb(39, 106, 26);"><rect/></svg>Intro</a>' +
      '<a href="/learn/x/lecture/v2/two"><svg style="color: rgb(39, 106, 26);"><rect/></svg>Two</a>' +
    '</div>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' },
    { id: 'v2', kind: 'video', url: '/learn/x/lecture/v2/two', title: 'Two' },
  ];
  d.cursor = 0;
  d.ownerTabKey = 'tab-1';
  d.heartbeatAt = 1_000_000;
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  let lastStatus = '';
  const handlers = mkFakeHandlers();
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function () { return Promise.resolve(); },
    sidebar: {
      setAutopilotStatus: function (s) { lastStatus = s; },
      appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; },
    },
    navigateUrlChangeTimeoutMs: 10,
  });
  await ap.bootIfRunning();
  assert.equal(handlers.calls.length, 0, 'no handler should run');
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.status, 'idle');
  assert.ok(/Module complete/i.test(lastStatus));
});
```

### Step 2: Run

Run: `npm test`
Expected: 4 new failures.

### Step 3: Wrap handler+confirmer in `if (!alreadyComplete)`

In `lib/module-autopilot.js`, locate `runCurrentItem`. Find the block (around lines 432-455):

```js
function runCurrentItem(stateNow) {
  if (inFlight) return inFlight;
  inFlight = (async function () {
    const item = stateNow.queue[stateNow.cursor];
    if (!item) return false;
    const handler = handlerForKind(item.kind);
  if (!handler) {
    await new Promise(function (resolve) { state.update({ status: 'paused', ownerTabKey: null }, resolve); });
    if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'No handler for kind: ' + item.kind);
    return false;
  }
  const signal = makeSignal();
  let outcome = null;
  try {
    const ctx = { ...
```

Restructure as follows. Replace the section from `const handler = handlerForKind(item.kind);` through the END of the confirmer block (the `if (!confirmed) { ... }` that pauses) — but BEFORE the success-path code (the log, recordCourseItem, cursor advance, navigateAndConfirm). Wrap that entire chunk in:

```js
// Pre-handler shortcut: if the item is already complete, skip handler + confirmer.
const alreadyCompleteIndicator =
  (scraperMod.findGreenCompletionIconInRow && scraperMod.findGreenCompletionIconInRow(doc, item.id)) ||
  (item.kind === 'reading' && pageFallback && pageFallback.findCompletedReadingIndicator && pageFallback.findCompletedReadingIndicator(doc));

const signal = makeSignal();
let outcome = null;

if (alreadyCompleteIndicator) {
  if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('✓ Already completed: "' + (item.title || item.id) + '"');
  if (pageFallback && pageFallback.findGoToNextItemButton) {
    const nextBtn = pageFallback.findGoToNextItemButton(doc);
    if (nextBtn) { try { nextBtn.click(); } catch (_) {} }
  }
  outcome = { outcome: 'already-completed' };
} else {
  const handler = handlerForKind(item.kind);
  if (!handler) {
    await new Promise(function (resolve) { state.update({ status: 'paused', ownerTabKey: null }, resolve); });
    if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'No handler for kind: ' + item.kind);
    return false;
  }
  try {
    const ctx = {
      // ... existing ctx fields (doc, item, rng, signal, replyHistory, autoSubmitQuizzes, behaviorMode, getAnswerText, getLastCleanedCopy) ...
    };
    outcome = await handler(ctx);
  } catch (e) {
    // ... existing catch block (log handler error + pause) ...
    return false;
  }
  if (isFailureOutcome(outcome)) {
    // ... existing failure-outcome block (pause + stopHeartbeat) ...
    return false;
  }
  if (signal && signal.aborted) {
    // ... existing aborted block (log + return) ...
    return false;
  }
  // ... existing confirmer block, including mark-complete fallback chain and pause-on-stuck path ...
  // (this block lives entirely inside the else)
}

// Success path (unchanged from here): record, advance cursor, navigate.
// Replace the existing success-log line so the message matches the path:
if (alreadyCompleteIndicator) {
  // we already logged ✓ Already completed above — no duplicate log
} else if (sidebar.appendAutopilotLog) {
  sidebar.appendAutopilotLog('✓ ' + item.kind + ' "' + (item.title || item.id) + '"');
}
// ... existing recordCourseItem, cursor advance, navigateAndConfirm ...
```

**Concrete edit sequence:**
1. Right after `if (!item) return false;`, insert the `alreadyCompleteIndicator` computation, the `const signal = makeSignal();` (moved here from later in the function), the `let outcome = null;` (moved here), and the `if (alreadyCompleteIndicator) { ... } else { ... }` wrapper around the existing handler-and-confirmer code.
2. Remove the original `const signal = makeSignal();` and `let outcome = null;` lines from inside the existing flow (they're now at the top).
3. Wrap the body of the existing flow (`const handler = ...` through the end of the confirmer block, but stopping BEFORE `if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('✓ ' + item.kind ...)`) in the `else` branch.
4. Update the success-log line to skip duplication when `alreadyCompleteIndicator` is truthy.

Be careful: the existing flow has multiple early `return false;` statements (handler error, failure outcome, signal aborted, confirmer-not-confirmed). All of those should stay inside the `else` branch.

### Step 4: Run

Run: `npm test`
Expected: all 4 new tests pass. CHECK FOR REGRESSIONS thoroughly:
- `bootIfRunning: runs current item handler then advances cursor and navigates` — no green icon in the test DOM → `alreadyCompleteIndicator` is null/false → existing flow runs. Should pass.
- `bootIfRunning: clears state when cursor reaches end after handler completes` — same, no green icon. Should pass.
- `Fast mode video: primary confirmer timeout is 5s, advances quickly when green icon present` — this test DOES have a green icon in the outline row! After this change, the handler would be SKIPPED entirely. The test asserts `primaryTimeoutMs === 5000` — but the confirmer is no longer called. This test WILL FAIL.

For that test, update its assertion: either (a) remove the green icon from the test fixture so the existing flow + 5s confirmer path is exercised, or (b) reframe the test to verify "already-complete shortcut advances quickly when green icon present" instead. Option (a) is the minimum change. Pick (a) — remove the green-svg span from the fixture, keep the 5s timeout assertion meaningful.

Similarly check `mark-complete fallback uses pageFallback.findMarkCompleteButton for span.cds-button-label buttons` — its fixture has no green icon for v1's row, so the shortcut should not trigger. Should pass.

If any other existing test has an in-row green svg AND expects the handler to run, fix it the same way.

### Step 5: Commit

```bash
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(autopilot): pre-handler shortcut skips already-completed items"
```

---

## Task 5: Multi-scope tests (module boundary + course continuation)

**Files:**
- Modify: `tests/module-autopilot.test.js`

### Why

The user explicitly wants tests proving:
- "Finish current module" stops at the module boundary.
- "Finish all modules" continues into the next module's first safe unfinished item.

Both behaviors are implicit in existing code (`start` uses single-module scrape; `startAllModules` flattens all modules into one queue). Add explicit regression tests so future refactors can't silently break them.

### Step 1: Write the tests

Append to `tests/module-autopilot.test.js`:

```js
test('module scope: stops cleanly when the current module is complete (no cross-module bleed)', async () => {
  // Two modules; current page is in M1. start() builds queue from M1 only.
  // M1 has 1 safe item; queue length must be 1.
  const html =
    '<div>' +
      '<button class="cds-AccordionHeader-button" aria-controls="m1p"><div>Module 1</div></button>' +
      '<div id="m1p"><ul>' +
        '<li><a href="/learn/x/lecture/v1/intro"><div class="outline-single-item-content-wrapper"><div><div>Intro</div><div>Video. 2 min</div></div></div></a></li>' +
      '</ul></div>' +
      '<button class="cds-AccordionHeader-button" aria-controls="m2p"><div>Module 2</div></button>' +
      '<div id="m2p"><ul>' +
        '<li><a href="/learn/x/lecture/v2/two"><div class="outline-single-item-content-wrapper"><div><div>Two</div><div>Video. 5 min</div></div></div></a></li>' +
      '</ul></div>' +
    '</div>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const handlers = mkFakeHandlers();
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
    navigateUrlChangeTimeoutMs: 10,
  });
  await ap.start({ scope: 'module' });
  const got = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(got.queue.length, 1, 'module scope must NOT include items from Module 2');
  assert.equal(got.queue[0].id, 'v1');
  assert.equal(got.runScope, 'module');
});

test('course scope: queues safe items across multiple modules in DOM order', async () => {
  const html =
    '<div>' +
      '<button class="cds-AccordionHeader-button" aria-controls="m1p"><div>Module 1</div></button>' +
      '<div id="m1p"><ul>' +
        '<li><a href="/learn/x/lecture/v1/intro"><div class="outline-single-item-content-wrapper"><div><div>Intro</div><div>Video. 2 min</div></div></div></a></li>' +
        '<li><a href="/learn/x/supplement/r1/sy"><div class="outline-single-item-content-wrapper"><div><div>Syllabus</div><div>Reading. 10 min</div></div></div></a></li>' +
      '</ul></div>' +
      '<button class="cds-AccordionHeader-button" aria-controls="m2p"><div>Module 2</div></button>' +
      '<div id="m2p"><ul>' +
        '<li><a href="/learn/x/lecture/v2/m2"><div class="outline-single-item-content-wrapper"><div><div>M2</div><div>Video. 5 min</div></div></div></a></li>' +
        '<li><a href="/learn/x/supplement/r2/r2"><div class="outline-single-item-content-wrapper"><div><div>R2</div><div>Reading. 8 min</div></div></div></a></li>' +
      '</ul></div>' +
    '</div>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const handlers = mkFakeHandlers();
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
    navigateUrlChangeTimeoutMs: 10,
  });
  await ap.startAllModules();
  const got = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(got.queue.length, 4, 'should include all 4 safe items across both modules');
  assert.deepEqual(got.queue.map(function (it) { return it.id; }), ['v1', 'r1', 'v2', 'r2']);
  assert.equal(got.runScope, 'course');
});

test('course scope: skips blocked items in subsequent modules too', async () => {
  const html =
    '<div>' +
      '<button class="cds-AccordionHeader-button" aria-controls="m1p"><div>Module 1</div></button>' +
      '<div id="m1p"><ul>' +
        '<li><a href="/learn/x/lecture/v1/intro"><div class="outline-single-item-content-wrapper"><div><div>Intro</div><div>Video</div></div></div></a></li>' +
      '</ul></div>' +
      '<button class="cds-AccordionHeader-button" aria-controls="m2p"><div>Module 2</div></button>' +
      '<div id="m2p"><ul>' +
        '<li><a href="/learn/x/discussionPrompt/d1/services"><div class="outline-single-item-content-wrapper"><div><div>Discuss</div><div>Discussion Prompt</div></div></div></a></li>' +
        '<li><a href="/learn/x/quiz/q1/wk2"><div class="outline-single-item-content-wrapper"><div><div>Q2</div><div>Quiz</div></div></div></a></li>' +
        '<li><a href="/learn/x/lecture/v2/two"><div class="outline-single-item-content-wrapper"><div><div>Two</div><div>Video</div></div></div></a></li>' +
      '</ul></div>' +
    '</div>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const handlers = mkFakeHandlers();
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
    navigateUrlChangeTimeoutMs: 10,
  });
  await ap.startAllModules();
  const got = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.deepEqual(got.queue.map(function (it) { return it.id; }), ['v1', 'v2'], 'discussion + quiz should be filtered out');
});
```

### Step 2: Run

Run: `npm test`
Expected: all 3 new tests pass (existing behavior already supports this; tests just lock it in).

### Step 3: Commit

```bash
git add tests/module-autopilot.test.js
git commit -m "test(autopilot): lock module boundary + course-scope continuation"
```

---

## Task 6: Run full suite + push + change summary

**Files:**
- Modify: `docs/superpowers/plans/2026-05-24-discussion-block-and-completed-skip.md`

### Step 1: Run

Run: `npm test`
Expected: all tests pass. Record final pass count (target: 563 prior + 17 new + ~test adjustments = ~580).

### Step 2: Push

Run: `git push origin feat/module-autopilot`

### Step 3: Append a `## Change Summary` to this plan

Append a section listing, with one bullet each:
- Discussion prompt URL/text/kind added to `isBlockedAssessmentItem` (Task 1).
- Kind-aware `blockReasonLabel(item)` → friendlier `⏭ Skipped {label}: ...` log lines in both `start()` and `startAllModules()` (Task 2).
- New `pageFallback.findCompletedReadingIndicator(root)` matching `aria-label="Reading completed"` and `<hN aria-label="Completed">` (Task 3).
- Pre-handler shortcut in `runCurrentItem` — when `findGreenCompletionIconInRow` OR (for readings) `findCompletedReadingIndicator` returns true, the handler + confirmer are skipped: logs `✓ Already completed: "..."`, clicks `Go to next item` if visible, falls through to the existing success-path advance (Task 4).
- Multi-scope regression tests for module boundary stop and course-scope cross-module continuation (Task 5).

Also include the final test count and the list of commits.

### Step 4: Commit and push

```bash
git add docs/superpowers/plans/2026-05-24-discussion-block-and-completed-skip.md
git commit -m "docs(plan): record change summary for discussion-block + already-complete shortcut"
git push origin feat/module-autopilot
```

---

## Self-Review

**Spec coverage (against the user's bullet list):**
- Skip Discussion Prompt items automatically — Task 1 (URL + text + kind) + Task 2 (specific log label) + Task 5 (course-scope test verifies cross-module skipping). ✓
- Completed reading page shortcut — Task 3 (`findCompletedReadingIndicator`) + Task 4 (controller wires it in for reading items). ✓
- Completed video/lesson shortcut from outline green check — Task 4 (uses existing `findGreenCompletionIconInRow` for ALL kinds, not just video). ✓
- Prefer "Go to next item" when already-completed page detected — Task 4 (clicks the button before the success-path advance) + Task 3 (regression test for `findGoToNextItemButton` with `span.cds-button-label`). ✓
- Continue into next module (course scope) / stop at boundary (module scope) — Task 5 (explicit tests for both behaviors). ✓
- Tests for: discussion prompt blocking, completed reading detection, Go-to-next click, outline green skip, consecutive completed items, next-module continuation, module boundary stop — covered across Tasks 1, 3, 4, 5. ✓

**Placeholder scan:** No "TBD" / "add appropriate" / "similar to" — every step has actual code. The pre-handler shortcut (Task 4 Step 3) is described as a restructure with concrete edit sequence; the implementer should produce the exact code from those edits.

**Type / name consistency:**
- `pageFallback.findCompletedReadingIndicator` — Tasks 3 (impl) + 4 (controller call). Same signature. ✓
- `pageFallback.findGoToNextItemButton` — Task 3 (regression test) + Task 4 (controller call). Existing helper. ✓
- `scraperMod.findGreenCompletionIconInRow` — Task 4 (controller call). Existing helper from prior plan. ✓
- `blockReasonLabel(item)` — Task 2 (impl) + Task 1 logs already pass through `start()`/`startAllModules()` skip-loops. ✓
- Outcome string `'already-completed'` — Task 4. `isFailureOutcome` returns false for unknown outcomes by default — verify this in the existing implementation before relying on it. (Falls through the various `if (o.outcome === ...)` checks and returns `false`.) ✓
- Settings: no new settings introduced. ✓
- Sidebar handler keys: no new handlers. ✓
