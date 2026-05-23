# Autopilot Completion Confirmer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make autopilot advancement driven by Coursera's per-item green-check completion indicator instead of the handler's return value. After every item-action, poll the module sidebar for the green check; if it doesn't appear within a timeout, try a generic "Mark as complete" button fallback; if still nothing, pause with a clear diagnostic.

**Architecture:** One new pure-logic module (`lib/completion-confirmer.js`) + two helpers on existing modules (`findItemCompletionIndicator` on the scraper, `tryMarkCompleteFallback` on item-handlers) + a controller refactor that interposes a confirmer wait between every successful handler action and the cursor advance. Multi-module scraper support added so courses with multiple expanded modules don't pick the wrong items. Six tasks, all TDD, all on branch `feat/module-autopilot` to land alongside the existing PR #3.

**Tech Stack:** Vanilla JS (IIFE + dual export, matching the existing codebase), `node:test` + `node:assert/strict` + jsdom. No new runtime dependencies.

**Smoke-test context:** PR #3 shipped autopilot v1. First-video smoke test showed the autopilot played the video but did not reliably wait for Coursera's sidebar green-check before advancing. The "done" signal is currently the handler's `'video-done'` outcome (which fires on the `ended` event); but Coursera's own completion indicator updates asynchronously after `ended`, so the autopilot can advance prematurely. This plan inverts the source of truth: handlers perform actions, the confirmer decides "done."

---

## File Structure

**Create:**
- `lib/completion-confirmer.js` — pure async helper. Exports `createConfirmer(deps)` returning `{ waitForCompletion({ doc, itemId, signal, timeoutMs, pollIntervalMs }) → Promise<boolean> }`. Polls `scraper.findItemCompletionIndicator(doc, itemId)` until present or timeout. `sleep` is injected so tests don't actually wait. ~80 lines.
- `tests/completion-confirmer.test.js` — covers immediate-pass, appears-after-N-polls, timeout, abort-via-signal.

**Modify:**
- `lib/module-scraper.js` — add exported `findItemCompletionIndicator(doc, itemId) → Element|null`. Also: rework `scrapeModule(doc)` to handle Coursera pages with multiple module containers (pick the one containing the current URL's item; fall back to the first non-empty). Existing per-anchor `completed` detection stays.
- `tests/module-scraper.test.js` — add tests for indicator lookup + multi-module pick.
- `lib/item-handlers.js` — add module-level export `tryMarkCompleteFallback(doc) → boolean` (clicks the first visible Mark-complete button and returns true, else false). Reuse existing `MARK_COMPLETE_SELECTORS`. Reading handler still does its own click; the fallback is for items whose kind-handler doesn't trigger Coursera's completion.
- `tests/item-handlers.test.js` — add test for the fallback (present + absent cases).
- `lib/module-autopilot.js` — controller refactor in `runCurrentItem`:
  1. Define `isFailureOutcome(outcome)` helper that recognizes the existing pause-needed/skipped/blocked outcomes.
  2. On handler success (non-failure outcome): call `confirmer.waitForCompletion(...)` with the controller's primary timeout.
  3. On no green check after the primary timeout: call `handlers.tryMarkCompleteFallback(doc)`; if it clicked something, re-call `waitForCompletion` with a shorter secondary timeout.
  4. On still no green check: pause with a clear diagnostic banner.
  5. On confirmed: record per-course log entry, advance cursor, navigate. (Same as today after the wait.)
- `tests/module-autopilot.test.js` — add 4 new tests matching the spec's scenarios.
- `manifest.json` — append `lib/completion-confirmer.js` to `content_scripts[0].js` (before `lib/sidebar.js`).
- `content.js` — instantiate the confirmer and pass it to `createAutopilot({ confirmer, ... })`.

**No file removed.** The existing handler outcomes (`'video-done'`, `'reading-done'`, `'reading-auto'`, `'discussion-posted'`, `'quiz-submitted'`, etc.) stay as informational return values — the controller just stops trusting them as the sole "advance" signal.

---

## Task 1: Scraper exports `findItemCompletionIndicator(doc, itemId)`

**Files:**
- Modify: `lib/module-scraper.js`
- Modify: `tests/module-scraper.test.js`

The confirmer (Task 2) needs to look up "is this specific item marked complete in the sidebar right now?" without re-scraping the whole queue every poll. Add a focused query.

### Step 1: Append the failing tests

Append to `tests/module-scraper.test.js` (before the file's closing — after the existing `scrapeModule moduleId reflects ...` test):

```js
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
```

### Step 2: Run tests to verify failure

Run: `npm test` (PowerShell: `npm test 2>&1 | Select-Object -Last 12`)
Expected: 4 new failures complaining `findItemCompletionIndicator is not a function`. All other tests pass.

### Step 3: Implement the helper

In `lib/module-scraper.js`, find this existing block:

```js
  function isCompleted(anchor) {
    for (let i = 0; i < COMPLETED_SELECTORS.length; i++) {
      if (anchor.querySelector(COMPLETED_SELECTORS[i])) return true;
    }
    return false;
  }
```

Add a new helper immediately below it (still inside the IIFE):

```js
  function findItemCompletionIndicator(doc, itemId) {
    if (!doc || !itemId) return null;
    const anchors = doc.querySelectorAll('a[href*="/learn/"]');
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const href = a.getAttribute('href');
      if (extractItemId(href) !== itemId) continue;
      for (let j = 0; j < COMPLETED_SELECTORS.length; j++) {
        const el = a.querySelector(COMPLETED_SELECTORS[j]);
        if (el) return el;
      }
    }
    return null;
  }
```

Then find the `api` export block:

```js
  const api = {
    scrapeModule: scrapeModule,
    extractCourseId: extractCourseId,
    extractItemId: extractItemId,
    classifyKind: classifyKind,
  };
```

Replace with (add `findItemCompletionIndicator`):

```js
  const api = {
    scrapeModule: scrapeModule,
    extractCourseId: extractCourseId,
    extractItemId: extractItemId,
    classifyKind: classifyKind,
    findItemCompletionIndicator: findItemCompletionIndicator,
  };
```

### Step 4: Run tests to verify pass

Run: `npm test`
Expected: all tests pass (~446 total: 442 prior + 4 new).

### Step 5: Commit

```
git add lib/module-scraper.js tests/module-scraper.test.js
git commit -m "feat(scraper): add findItemCompletionIndicator for confirmer polling"
```

---

## Task 2: New `lib/completion-confirmer.js` module

**Files:**
- Create: `lib/completion-confirmer.js`
- Create: `tests/completion-confirmer.test.js`

A polling wait-loop with dependency-injected `sleep` so tests are deterministic and fast.

### Step 1: Write the failing tests

Create `tests/completion-confirmer.test.js`:

```js
// tests/completion-confirmer.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createConfirmer } = require('../lib/completion-confirmer.js');

function mkSignal() {
  const listeners = [];
  return {
    aborted: false,
    addEventListener: function (k, fn) { if (k === 'abort') listeners.push(fn); },
    removeEventListener: function () {},
    _abort: function () { this.aborted = true; listeners.forEach(function (fn) { fn(); }); },
  };
}

// Tests use an injected sleep that resolves immediately so polls happen fast.
function immediateSleep(ms, signal) {
  return new Promise(function (resolve, reject) {
    if (signal && signal.aborted) { reject(new Error('aborted')); return; }
    if (signal && signal.addEventListener) {
      signal.addEventListener('abort', function () { reject(new Error('aborted')); }, { once: true });
    }
    setImmediate(resolve);
  });
}

test('waitForCompletion resolves true immediately when indicator already present', async () => {
  const scraper = { findItemCompletionIndicator: function () { return {}; } };
  const confirmer = createConfirmer({ sleep: immediateSleep });
  const ok = await confirmer.waitForCompletion({
    doc: {}, itemId: 'v1', scraper: scraper,
    signal: mkSignal(), timeoutMs: 1000, pollIntervalMs: 10,
  });
  assert.equal(ok, true);
});

test('waitForCompletion resolves true after indicator appears on the 3rd poll', async () => {
  let calls = 0;
  const scraper = {
    findItemCompletionIndicator: function () {
      calls += 1;
      return calls >= 3 ? {} : null;
    },
  };
  const confirmer = createConfirmer({ sleep: immediateSleep });
  const ok = await confirmer.waitForCompletion({
    doc: {}, itemId: 'v1', scraper: scraper,
    signal: mkSignal(), timeoutMs: 1000, pollIntervalMs: 1,
  });
  assert.equal(ok, true);
  assert.equal(calls, 3, 'should have polled 3 times');
});

test('waitForCompletion resolves false when indicator never appears within timeout', async () => {
  let calls = 0;
  const scraper = {
    findItemCompletionIndicator: function () { calls += 1; return null; },
  };
  // Use a fake clock so the loop terminates by virtual elapsed time, not real time.
  let now = 0;
  const sleep = function (ms) { now += ms; return Promise.resolve(); };
  const confirmer = createConfirmer({ sleep: sleep, nowFn: function () { return now; } });
  const ok = await confirmer.waitForCompletion({
    doc: {}, itemId: 'v1', scraper: scraper,
    signal: mkSignal(), timeoutMs: 100, pollIntervalMs: 20,
  });
  assert.equal(ok, false);
  // The first check happens at t=0; subsequent checks at t=20, 40, 60, 80, 100.
  // The loop should not poll past timeoutMs, so calls should be between 5 and 6.
  assert.ok(calls >= 5 && calls <= 6, 'expected ~5-6 polls, got ' + calls);
});

test('waitForCompletion rejects when the abort signal fires mid-poll', async () => {
  const scraper = { findItemCompletionIndicator: function () { return null; } };
  const sig = mkSignal();
  // Sleep that never resolves on its own, only rejects on abort.
  const sleep = function (ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.addEventListener) {
        signal.addEventListener('abort', function () { reject(new Error('aborted')); });
      }
    });
  };
  const confirmer = createConfirmer({ sleep: sleep });
  const p = confirmer.waitForCompletion({
    doc: {}, itemId: 'v1', scraper: scraper,
    signal: sig, timeoutMs: 10000, pollIntervalMs: 100,
  }).then(function (v) { return 'resolved:' + v; }, function (e) { return 'rejected:' + (e && e.message); });
  // Let the first poll + first sleep schedule.
  await new Promise(function (r) { setTimeout(r, 0); });
  sig._abort();
  const result = await p;
  assert.equal(result, 'rejected:aborted');
});

test('waitForCompletion uses defaults when timeoutMs/pollIntervalMs are absent', async () => {
  const scraper = { findItemCompletionIndicator: function () { return {}; } };
  const confirmer = createConfirmer({ sleep: immediateSleep });
  const ok = await confirmer.waitForCompletion({
    doc: {}, itemId: 'v1', scraper: scraper, signal: mkSignal(),
  });
  assert.equal(ok, true);
});

test('createConfirmer exports the defaults', () => {
  const { DEFAULT_TIMEOUT_MS, DEFAULT_POLL_INTERVAL_MS } = require('../lib/completion-confirmer.js');
  assert.equal(typeof DEFAULT_TIMEOUT_MS, 'number');
  assert.equal(typeof DEFAULT_POLL_INTERVAL_MS, 'number');
  assert.ok(DEFAULT_TIMEOUT_MS >= 30000 && DEFAULT_TIMEOUT_MS <= 60000);
});
```

### Step 2: Run tests to verify failure

Run: `npm test`
Expected: failures from `Cannot find module '../lib/completion-confirmer.js'`.

### Step 3: Implement the confirmer

Create `lib/completion-confirmer.js`:

```js
// lib/completion-confirmer.js
// Polls a scraper's findItemCompletionIndicator(doc, itemId) until the
// indicator appears or a timeout elapses. The "done" signal of record for
// the autopilot — handlers no longer self-report completion.
(function (root) {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 45 * 1000;
  const DEFAULT_POLL_INTERVAL_MS = 1000;

  function createConfirmer(deps) {
    const sleep = (deps && deps.sleep) || function (ms, signal) {
      return new Promise(function (resolve, reject) {
        const t = setTimeout(resolve, ms);
        if (signal && signal.addEventListener) {
          signal.addEventListener('abort', function () { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
        }
      });
    };
    const nowFn = (deps && deps.nowFn) || function () { return Date.now(); };

    async function waitForCompletion(opts) {
      opts = opts || {};
      const doc = opts.doc;
      const itemId = opts.itemId;
      const scraper = opts.scraper;
      const signal = opts.signal;
      const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
      const pollIntervalMs = (typeof opts.pollIntervalMs === 'number' && opts.pollIntervalMs > 0) ? opts.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
      if (!scraper || typeof scraper.findItemCompletionIndicator !== 'function') return false;
      const start = nowFn();
      // Loop: check, then sleep, then check again, bounded by timeoutMs.
      while (true) {
        if (signal && signal.aborted) throw new Error('aborted');
        const found = scraper.findItemCompletionIndicator(doc, itemId);
        if (found) return true;
        const elapsed = nowFn() - start;
        if (elapsed >= timeoutMs) return false;
        await sleep(pollIntervalMs, signal);
      }
    }

    return { waitForCompletion: waitForCompletion };
  }

  const api = {
    createConfirmer: createConfirmer,
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    DEFAULT_POLL_INTERVAL_MS: DEFAULT_POLL_INTERVAL_MS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.completionConfirmer = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

### Step 4: Run tests

Run: `npm test`
Expected: all tests pass (~452 total: 446 prior + 6 new).

### Step 5: Commit

```
git add lib/completion-confirmer.js tests/completion-confirmer.test.js
git commit -m "feat(autopilot): add completion confirmer with poll-until-indicator-or-timeout"
```

---

## Task 3: Multi-module scraper support

**Files:**
- Modify: `lib/module-scraper.js`
- Modify: `tests/module-scraper.test.js`

Coursera course pages can render multiple module containers in the sidebar at once (e.g., Module 1 expanded with its items, Module 2 collapsed but visible). Current `scrapeModule(doc)` matches the FIRST container — wrong when the user is on an item from Module 2.

New behavior: find all containers; for each, build its items; pick the container whose items include the current URL's `itemId`; fall back to the first non-empty container if no match.

### Step 1: Write the failing tests

Append to `tests/module-scraper.test.js`:

```js
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
```

### Step 2: Run tests to verify the first new test fails

Run: `npm test`
Expected: `scrapeModule picks the container...` fails because current code returns M1's 2 items (it matched the first container only). Other new test (`falls back...`) probably passes because the first container is the first non-empty anyway. Back-compat test still passes.

### Step 3: Modify the scraper

In `lib/module-scraper.js`, find the existing `firstMatching` helper and ADD this helper next to it:

```js
  function allMatching(root, selectors) {
    const seen = new Set();
    const out = [];
    for (let i = 0; i < selectors.length; i++) {
      const list = root.querySelectorAll(selectors[i]);
      for (let j = 0; j < list.length; j++) {
        const el = list[j];
        if (!seen.has(el)) { seen.add(el); out.push(el); }
      }
    }
    // Filter out containers nested inside another already in the list.
    return out.filter(function (el) {
      return !out.some(function (other) { return other !== el && other.contains(el); });
    });
  }
```

Find this existing function:

```js
  function scrapeModule(doc) {
    const url = (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || '';
    const courseId = extractCourseId(url);
    const moduleId = extractModuleId(url);
    const container = firstMatching(doc, CONTAINER_SELECTORS);
    if (!container) {
      return { courseId: courseId, moduleId: moduleId, items: [] };
    }
    const anchors = container.querySelectorAll('a[href*="/learn/"]');
    const items = [];
    const seen = new Set();
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const href = a.getAttribute('href');
      const id = extractItemId(href);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push({
        id: id,
        title: textOf(a),
        kind: classifyKind(href),
        url: href,
        completed: isCompleted(a),
      });
    }
    return { courseId: courseId, moduleId: moduleId, items: items };
  }
```

Replace with (multi-container aware, picks the container that includes the current URL item):

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
      items.push({
        id: id,
        title: textOf(a),
        kind: classifyKind(href),
        url: href,
        completed: isCompleted(a),
      });
    }
    return items;
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
    // Build per-container item lists, then pick the one containing the current item.
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

### Step 4: Run tests

Run: `npm test`
Expected: all tests pass (~455 total: 452 prior + 3 new).

### Step 5: Commit

```
git add lib/module-scraper.js tests/module-scraper.test.js
git commit -m "feat(scraper): pick the module container that holds the current URL item"
```

---

## Task 4: `tryMarkCompleteFallback(doc)` on item-handlers

**Files:**
- Modify: `lib/item-handlers.js`
- Modify: `tests/item-handlers.test.js`

A generic "find a visible Mark-complete button and click it" function that the controller invokes when a handler succeeded but Coursera's green check didn't appear. Reuses the existing `MARK_COMPLETE_SELECTORS` so we don't drift.

### Step 1: Append the failing tests

Append to `tests/item-handlers.test.js`:

```js
test('tryMarkCompleteFallback: clicks visible Mark-complete button and returns true', () => {
  const { tryMarkCompleteFallback } = require('../lib/item-handlers.js');
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><button aria-label="Mark as completed">Done</button></body>'
  ).window.document;
  const btn = doc.querySelector('button');
  let clicked = false;
  btn.click = function () { clicked = true; };
  const result = tryMarkCompleteFallback(doc);
  assert.equal(result, true);
  assert.equal(clicked, true);
});

test('tryMarkCompleteFallback: returns false when no button is present', () => {
  const { tryMarkCompleteFallback } = require('../lib/item-handlers.js');
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><div>no buttons here</div></body>'
  ).window.document;
  const result = tryMarkCompleteFallback(doc);
  assert.equal(result, false);
});

test('tryMarkCompleteFallback: matches button with data-testid mark-complete pattern', () => {
  const { tryMarkCompleteFallback } = require('../lib/item-handlers.js');
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><button data-testid="mark-as-complete-button">x</button></body>'
  ).window.document;
  const btn = doc.querySelector('button');
  let clicked = false;
  btn.click = function () { clicked = true; };
  const result = tryMarkCompleteFallback(doc);
  assert.equal(result, true);
  assert.equal(clicked, true);
});
```

### Step 2: Run tests to verify failure

Run: `npm test`
Expected: 3 failures (`tryMarkCompleteFallback is not a function`).

### Step 3: Implement the fallback

In `lib/item-handlers.js`, find the existing `MARK_COMPLETE_SELECTORS` constant (it's near the top of the IIFE). Below the constants, add:

```js
  function tryMarkCompleteFallback(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return false;
    for (let i = 0; i < MARK_COMPLETE_SELECTORS.length; i++) {
      const btn = doc.querySelector(MARK_COMPLETE_SELECTORS[i]);
      if (btn) {
        try { btn.click(); } catch (_) { return false; }
        return true;
      }
    }
    return false;
  }
```

Then find the `api` export block at the bottom:

```js
  const api = {
    createHandlers: createHandlers,
    cancellableSleep: cancellableSleep,
    _selectors: {
      reading: READING_SELECTORS,
      markComplete: MARK_COMPLETE_SELECTORS,
      replyInput: REPLY_INPUT_SELECTORS,
      replySubmit: REPLY_SUBMIT_SELECTORS,
    },
  };
```

Replace with:

```js
  const api = {
    createHandlers: createHandlers,
    cancellableSleep: cancellableSleep,
    tryMarkCompleteFallback: tryMarkCompleteFallback,
    _selectors: {
      reading: READING_SELECTORS,
      markComplete: MARK_COMPLETE_SELECTORS,
      replyInput: REPLY_INPUT_SELECTORS,
      replySubmit: REPLY_SUBMIT_SELECTORS,
    },
  };
```

### Step 4: Run tests

Run: `npm test`
Expected: all pass (~458 total: 455 prior + 3 new).

### Step 5: Commit

```
git add lib/item-handlers.js tests/item-handlers.test.js
git commit -m "feat(autopilot): add tryMarkCompleteFallback for generic completion fallback"
```

---

## Task 5: Controller integrates confirmer + fallback

**Files:**
- Modify: `lib/module-autopilot.js`
- Modify: `tests/module-autopilot.test.js`

After a handler returns a non-failure outcome, `runCurrentItem`:
1. Polls `confirmer.waitForCompletion(...)` with the primary timeout.
2. If no green check: calls `handlers.tryMarkCompleteFallback(doc)`; if it clicked something, polls again with a shorter secondary timeout.
3. If still no green check: pause with a clear diagnostic and stop heartbeat.
4. If confirmed: record per-course log, advance cursor, navigate.

We also introduce `isFailureOutcome` so the controller has a single place to classify what counts as "handler did not actually do its thing."

### Step 1: Append the failing tests

Append to `tests/module-autopilot.test.js`. These cover all four spec scenarios:

```js
function mkConfirmer(behavior) {
  // behavior(itemId) returns true|false|'throw' for each call.
  let n = 0;
  return {
    waitForCompletion: function (opts) {
      n += 1;
      const r = behavior(opts.itemId, n);
      if (r === 'throw') return Promise.reject(new Error('aborted'));
      return Promise.resolve(!!r);
    },
    _callCount: function () { return n; },
  };
}

test('handler success but no green check => does not advance cursor', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' },
    { id: 'r1', kind: 'reading', url: '/learn/x/supplement/r1/reading', title: 'Reading' },
  ];
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkFakeHandlers();
  handlers.tryMarkCompleteFallback = function () { return false; }; // no button to click
  const confirmer = mkConfirmer(function () { return false; });
  const navTargets = [];
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    confirmer: confirmer,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function (url) { navTargets.push(url); return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.bootIfRunning();
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.cursor, 0, 'cursor must NOT advance without green check');
  assert.equal(after.status, 'paused', 'should pause with diagnostic');
  assert.equal(navTargets.length, 0);
});

test('green check appears after polling => advances cursor', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' },
    { id: 'r1', kind: 'reading', url: '/learn/x/supplement/r1/reading', title: 'Reading' },
  ];
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkFakeHandlers();
  const confirmer = mkConfirmer(function () { return true; }); // green check appears
  const navTargets = [];
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    confirmer: confirmer,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function (url) { navTargets.push(url); return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.bootIfRunning();
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.cursor, 1);
  assert.equal(navTargets.length, 1);
  assert.ok(navTargets[0].indexOf('/supplement/r1') !== -1);
});

test('handler success + first confirmer timeout => mark-complete fallback => second confirmer pass => advance', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' },
    { id: 'r1', kind: 'reading', url: '/learn/x/supplement/r1/reading', title: 'Reading' },
  ];
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkFakeHandlers();
  let fallbackCalls = 0;
  handlers.tryMarkCompleteFallback = function () { fallbackCalls += 1; return true; };
  // First call returns false (no check), second returns true (check appears after fallback click).
  let callIdx = 0;
  const confirmer = {
    waitForCompletion: function () {
      callIdx += 1;
      return Promise.resolve(callIdx >= 2);
    },
  };
  const navTargets = [];
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    confirmer: confirmer,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function (url) { navTargets.push(url); return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.bootIfRunning();
  assert.equal(fallbackCalls, 1, 'fallback should have been invoked once');
  assert.equal(callIdx, 2, 'confirmer should have been polled twice (primary + post-fallback)');
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.cursor, 1, 'cursor advanced after fallback resolved the wait');
});

test('handler failure outcome (pause-needed-*) skips confirmer entirely and pauses', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/quiz/q1/x');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'q1', kind: 'quiz', url: '/learn/x/quiz/q1/x', title: 'Quiz' },
  ];
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkFakeHandlers();
  handlers.fallback = function () { return Promise.resolve({ outcome: 'pause-needed-no-answer' }); };
  let confirmerCalls = 0;
  const confirmer = { waitForCompletion: function () { confirmerCalls += 1; return Promise.resolve(true); } };
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    confirmer: confirmer,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.bootIfRunning();
  assert.equal(confirmerCalls, 0, 'confirmer must NOT be polled on a failure outcome');
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.status, 'paused');
  assert.equal(after.cursor, 0);
});
```

### Step 2: Run tests, verify failures

Run: `npm test`
Expected: 4 failures (the test using `confirmer` will hit early because the controller doesn't yet wire one in; the others will fail because cursor advancement still happens immediately on handler success).

### Step 3: Modify `lib/module-autopilot.js`

In `lib/module-autopilot.js`, add this helper at the top of the IIFE (before `function getStateMod() { ... }`):

```js
  function isFailureOutcome(o) {
    if (!o || !o.outcome) return true;
    if (/^pause-needed/.test(o.outcome)) return true;
    if (o.outcome === 'video-autoplay-blocked') return true;
    if (o.outcome === 'video-no-element') return true;
    if (o.outcome === 'discussion-skipped-no-input') return true;
    if (o.outcome === 'quiz-filled-paused-for-review') return true;
    if (o.outcome === 'quiz-filled-no-submit-button') return true;
    return false;
  }

  const PRIMARY_CONFIRMER_TIMEOUT_MS = 45 * 1000;
  const FALLBACK_CONFIRMER_TIMEOUT_MS = 15 * 1000;
```

Find this line near the top of `createAutopilot`:

```js
    const sidebar = opts.sidebar || {};
```

Insert after it:

```js
    const confirmer = opts.confirmer || null;
```

Now find this block inside `runCurrentItem`:

```js
        if (outcome && /^pause-needed/.test(outcome.outcome)) {
          await new Promise(function (resolve) { state.update({ status: 'paused', ownerTabKey: null }, resolve); });
          if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Paused — needs your action.');
          stopHeartbeat();
          return false;
        }
        // If pause/stop fired during the handler and the signal was honored
        // after the handler had already resolved, bail before recording or
        // advancing the cursor. The pause() call already wrote status='paused'
        // and ownerTabKey=null; we just need to not navigate/skip.
        if (signal && signal.aborted) {
          if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('⏸ Paused before commit — cursor not advanced');
          return false;
        }
        if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('✓ ' + item.kind + ' "' + (item.title || item.id) + '"');
```

Replace with:

```js
        if (isFailureOutcome(outcome)) {
          await new Promise(function (resolve) { state.update({ status: 'paused', ownerTabKey: null }, resolve); });
          const reason = (outcome && outcome.outcome) || 'no-outcome';
          if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Paused — ' + reason);
          stopHeartbeat();
          return false;
        }
        // If pause/stop fired during the handler and the signal was honored
        // after the handler had already resolved, bail before recording or
        // advancing the cursor.
        if (signal && signal.aborted) {
          if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('⏸ Paused before commit — cursor not advanced');
          return false;
        }
        // Wait for Coursera's sidebar to mark this item complete. The handler
        // took an action; the confirmer decides whether it actually worked.
        if (confirmer && typeof confirmer.waitForCompletion === 'function') {
          if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Waiting for completion mark — ' + item.kind + ' "' + (item.title || item.id) + '"');
          let confirmed = false;
          try {
            confirmed = await confirmer.waitForCompletion({
              doc: doc, itemId: item.id, scraper: scraperMod,
              signal: signal, timeoutMs: PRIMARY_CONFIRMER_TIMEOUT_MS,
            });
          } catch (_) { /* abort surfaces as not-confirmed */ }
          if (!confirmed) {
            // Try the generic Mark-as-complete fallback.
            const handlersApi = (typeof require !== 'undefined') ? require('./item-handlers.js')
              : (root.ClipboardCleaner && root.ClipboardCleaner.itemHandlers);
            const fallback = (handlersApi && handlersApi.tryMarkCompleteFallback)
              || (handlers && handlers.tryMarkCompleteFallback);
            if (fallback && fallback(doc)) {
              if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('↻ Clicked Mark-as-complete fallback for "' + (item.title || item.id) + '"');
              try {
                confirmed = await confirmer.waitForCompletion({
                  doc: doc, itemId: item.id, scraper: scraperMod,
                  signal: signal, timeoutMs: FALLBACK_CONFIRMER_TIMEOUT_MS,
                });
              } catch (_) { /* abort */ }
            }
          }
          if (!confirmed) {
            await new Promise(function (resolve) { state.update({ status: 'paused', ownerTabKey: null }, resolve); });
            if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'No completion indicator after ' + item.kind + ' — Resume to retry or stop.');
            stopHeartbeat();
            return false;
          }
        }
        if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('✓ ' + item.kind + ' "' + (item.title || item.id) + '"');
```

### Step 4: Run tests

Run: `npm test`
Expected: all pass (~462 total: 458 prior + 4 new). Suite exits cleanly.

If a test fails because the `handlers.tryMarkCompleteFallback` lookup didn't resolve — confirm that the test's `mkFakeHandlers()` returned object has the fallback assigned in the failing test (or via the require-fallback path).

### Step 5: Commit

```
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(autopilot): confirmer-driven advancement with mark-complete fallback"
```

---

## Task 6: Wire confirmer into manifest + content.js

**Files:**
- Modify: `manifest.json`
- Modify: `content.js`

### Step 1: Update manifest

In `manifest.json`, find the existing `js` array in `content_scripts[0]`. Insert `lib/completion-confirmer.js` immediately BEFORE `lib/module-autopilot.js` (the controller depends on it):

Find:

```
        "lib/autopilot-state.js",
        "lib/module-scraper.js",
        "lib/item-handlers.js",
        "lib/module-autopilot.js",
        "lib/sidebar.js",
```

Replace with:

```
        "lib/autopilot-state.js",
        "lib/module-scraper.js",
        "lib/item-handlers.js",
        "lib/completion-confirmer.js",
        "lib/module-autopilot.js",
        "lib/sidebar.js",
```

### Step 2: Wire the confirmer in content.js

In `content.js`, find the `startAutopilot()` function. After the `if (!a.itemHandlers || ...) return;` guard, before `const handlers = a.itemHandlers.createHandlers({...})`, add:

```js
    if (!a.completionConfirmer || typeof a.completionConfirmer.createConfirmer !== 'function') {
      console.warn('[autopilot] disabled: completionConfirmer not loaded');
      return;
    }
    const confirmer = a.completionConfirmer.createConfirmer({});
```

Then find this block:

```js
    _autopilotInstance = a.moduleAutopilot.createAutopilot({
      document: document,
      window: window,
      storage: storage,
      handlers: handlers,
      sidebar: a.sidebar,
    });
```

Replace with:

```js
    // Expose the generic Mark-complete fallback on handlers so the controller
    // can invoke it without re-resolving the module.
    handlers.tryMarkCompleteFallback = a.itemHandlers.tryMarkCompleteFallback;
    _autopilotInstance = a.moduleAutopilot.createAutopilot({
      document: document,
      window: window,
      storage: storage,
      handlers: handlers,
      sidebar: a.sidebar,
      confirmer: confirmer,
    });
```

### Step 3: Run tests

Run: `npm test`
Expected: 462/0 (no test changes).

### Step 4: Manifest sanity check

Run:

```
node -e "const m=JSON.parse(require('fs').readFileSync('manifest.json','utf8'));const js=m.content_scripts[0].js;console.log('len',js.length,'has confirmer',js.indexOf('lib/completion-confirmer.js'));"
```

Expected: `len 17 has confirmer 14` (index may differ; just confirm `> -1` and that the new total is 17).

### Step 5: Commit

```
git add manifest.json content.js
git commit -m "chore(autopilot): wire completion-confirmer into manifest + content.js"
```

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
|---|---|
| Add a completion confirmer (poll sidebar, configurable timeout, advance only on green check) | Task 2 (`createConfirmer`), Task 5 (controller integration) |
| Video behavior — wait for green check after `ended` | Task 5 (every successful handler triggers the confirmer) |
| Mark-as-complete behavior — generic fallback for any item with a visible button | Task 4 (`tryMarkCompleteFallback`), Task 5 (controller invokes it on first-poll timeout) |
| Adaptability — action-based handlers, confirmer decides if it worked | Task 5 reshapes `runCurrentItem` so all non-failure outcomes go through the confirmer |
| Multiple modules — scraper doesn't hard-code first module | Task 3 (multi-container support with current-item match) |
| Test: handler success but no green check => no advance | Task 5 test 1 |
| Test: green check appears after polling => advances | Task 5 test 2 |
| Test: visible Mark-as-complete clicked => waits for green check | Task 5 test 3 (fallback path) |
| Test: video ended but green check delayed => waits before advancing | Covered by Task 2's "appears-after-N-polls" test + Task 5 test 2 (any successful handler waits via the confirmer; video uses the same path) |

**2. Placeholder scan:** No "TBD", "TODO", "implement later", or "similar to Task N". Every step has runnable code or a single command.

**3. Type consistency:**
- `findItemCompletionIndicator(doc, itemId) → Element|null` — defined in Task 1, consumed by Task 2's `createConfirmer` and Task 5's controller via `scraperMod`.
- `createConfirmer({ sleep, nowFn }) → { waitForCompletion(opts) → Promise<bool> }` — defined Task 2, consumed Task 5/6.
- `tryMarkCompleteFallback(doc) → boolean` — defined Task 4, consumed Task 5's controller (with both `require` and `handlers` lookup paths for browser + Node test parity).
- `isFailureOutcome(outcome) → boolean` — defined Task 5, used Task 5.
- `createAutopilot(opts)` gains a new optional `opts.confirmer`. All existing tests that don't pass a confirmer still work — when `confirmer` is null, the controller skips the wait and advances immediately (back-compat with the original behavior). Task 5's new tests pass a confirmer.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-23-autopilot-completion-confirmer.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review.
2. **Inline Execution** — execute in this session via `superpowers:executing-plans`.

Which approach?
