# Adaptive Autopilot — Behavior Modes, Safe Skipping, and Resume-From-Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Coursera autopilot adaptive across any course: respect `pauseOnUserInput`, ship a default Fast mode that seeks videos near the end and waits ≤5s for the green check, resume from the first unfinished safe item (never restart item 1 when it's complete), automatically skip graded/assessment items, support a "Finish all modules" course-wide scope, and survive Coursera's SPA navigation without a full page reload.

**Architecture:** Three layers of change. (1) **Settings + classification** — extend `autopilot-state.defaults().settings` with `behaviorMode: 'fast'` and `runScope: 'module'`; add `isBlockedAssessmentItem(item)` in `lib/module-scraper.js`. (2) **Controller behavior** — `start()` now re-scrapes, filters out completed + blocked items, and picks the cursor from the current URL when possible; "Finish all modules" adds course-wide queue building; a new `lib/autopilot-input-guard.js` makes pause-on-input respect the setting and exposes a pure helper for tests; SPA continuation hooks `popstate` + patched `history.pushState/replaceState` so we re-enter `bootIfRunning()` after Coursera SPA route changes. (3) **Handlers + confirmer** — Fast mode video seeks to `duration - 45s` and uses a 5-second primary confirmer window; the confirmer gains `findGreenCompletionIconInRow(doc, itemId)` (row-scoped green SVG/icon detection); a `diagnosticsSnapshot(...)` helper logs structured state when stuck.

**Tech Stack:** Vanilla JS, IIFE dual-export modules, Node `node:test` + jsdom, Chrome MV3. No new dependencies.

---

## File Structure

**Modify:**
- `lib/module-autopilot.js` — `start()` accepts `{ scope: 'module' | 'course' }`; resume-from-progress logic (filter completed + blocked, pick cursor from current URL); shorter primary confirmer timeout when `behaviorMode === 'fast'` AND `item.kind === 'video'`; SPA route watcher; structured diagnostics on stuck; next-safe-anchor click fallback when `navigate()` doesn't change the URL within a timeout.
- `lib/module-scraper.js` — `isBlockedAssessmentItem(item)` (URL+text classifier); `scrapeAllModules(doc)` (course-wide scrape across all accordion panels); `findGreenCompletionIconInRow(doc, itemId)` (row-scoped green SVG detection); export new helpers.
- `lib/item-handlers.js` — video handler reads `ctx.behaviorMode`; Fast mode seeks to `duration - FAST_VIDEO_SEEK_FROM_END_SEC` (default 45s) and short-waits 5s; uses existing forward-seek-button fallback. Human mode unchanged.
- `lib/autopilot-timing.js` — new `fastVideoTiming(durationSec, rng)` returning `{ mode, targetTimeSec, postEndMs: 5000, fastConfirmTimeoutMs: 5000 }`; existing `videoTiming` stays for human mode. New constant `FAST_VIDEO_SEEK_FROM_END_SEC = 45` and `FAST_POST_SEEK_WAIT_MS = 5000`.
- `lib/autopilot-state.js` — `defaults().settings.behaviorMode = 'fast'`; `defaults().settings.runScope = 'module'`.
- `lib/sidebar.js` — replace "Run autopilot for this module" with two buttons "Finish current module" + "Finish all modules"; add behavior-mode segmented control (Fast / Human); wire both via `setAutopilotHandlers({ onRun, onRunAllModules, ... })`.
- `lib/completion-confirmer.js` — also consults `scraper.findGreenCompletionIconInRow(doc, itemId)` when present.
- `content.js` — pause-on-input listeners use `lib/autopilot-input-guard.js`; add `pointerdown` listener; install `popstate`+`history.pushState/replaceState` patch and call `_autopilotInstance.bootIfRunning()` on route change; pass `pageFallback` (already exposed by Task 11 in prior plan).
- `tests/*.test.js` — extensive new tests per task.

**Create:**
- `lib/autopilot-input-guard.js` — pure helper `shouldPauseFor(event, settings, opts)` plus `attachInputListeners(target, getSettings, isSidebarHost, onPause)`.
- `tests/autopilot-input-guard.test.js` — unit tests for the pure helper and the attach-and-fire integration.

**Sizing note:** `lib/module-autopilot.js` grows from ~513 to ~700 lines; `lib/module-scraper.js` from ~544 to ~660. Both stay manageable. If during Task 8 the controller feels tangled, splitting course-wide queue building into `lib/scraper-course.js` is acceptable.

---

## Helper Naming & Return Shapes (Lock In)

- `autopilotInputGuard.shouldPauseFor(event, settings, opts) → boolean`
- `autopilotInputGuard.attachInputListeners(target, getSettings, isSidebarHost, onPause) → () => void` (returns detach)
- `scraper.isBlockedAssessmentItem(item) → boolean`
- `scraper.scrapeAllModules(doc) → { courseId, modules: [{ moduleId, headerText, items: Item[] }] }`
- `scraper.findGreenCompletionIconInRow(doc, itemId) → Element | null`
- `timing.fastVideoTiming(durationSec, rng) → { mode: 'fast-seek', targetTimeSec, postSeekWaitMs }`
- `timing.FAST_VIDEO_SEEK_FROM_END_SEC = 45`
- `timing.FAST_POST_SEEK_WAIT_MS = 5000`
- Settings: `behaviorMode: 'fast' | 'human'` (default `'fast'`); `runScope: 'module' | 'course'` (default `'module'`)
- Controller: `createAutopilot(opts)` returns added methods `startAllModules()` (in addition to existing `start`/`stop`/`pause`/`resume`/`takeOver`)
- Sidebar handler keys: `onRun`, `onRunAllModules`, `onStop`, `onResume`, `onTakeOver`, `onSettingsChange`
- Item outcomes (new): `video-done-fast`
- Log markers (sidebar appendAutopilotLog): `⏭ Skipped graded:`, `⏭ Skipped quiz:`, `⏭ Skipped peer:`, `↪ Continuing in module`, `▶ Resuming at item N of M`

---

## Task 1: Pause-on-input guard + helper module

**Files:**
- Create: `lib/autopilot-input-guard.js`
- Create: `tests/autopilot-input-guard.test.js`
- Modify: `content.js`
- Modify: `manifest.json`

### Why

Today `content.js` pauses on any trusted keydown outside the sidebar, ignoring `settings.pauseOnUserInput`. Extract the decision into a pure helper, add `pointerdown` and `mousedown`, gate by settings.

### Step 1: Write failing tests

Create `tests/autopilot-input-guard.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const guard = require('../lib/autopilot-input-guard.js');

function dom(html) {
  return new JSDOM('<!doctype html><html><body>' + html + '</body></html>').window;
}

test('shouldPauseFor: returns false when settings.pauseOnUserInput is false', () => {
  const w = dom('<input id="x">');
  const ev = new w.KeyboardEvent('keydown', { bubbles: true });
  Object.defineProperty(ev, 'isTrusted', { value: true });
  Object.defineProperty(ev, 'composedPath', { value: function () { return [w.document.getElementById('x')]; } });
  assert.equal(guard.shouldPauseFor(ev, { pauseOnUserInput: false }), false);
});

test('shouldPauseFor: returns true on trusted keydown when setting is enabled', () => {
  const w = dom('<input id="x">');
  const ev = new w.KeyboardEvent('keydown', { bubbles: true });
  Object.defineProperty(ev, 'isTrusted', { value: true });
  Object.defineProperty(ev, 'composedPath', { value: function () { return [w.document.getElementById('x')]; } });
  assert.equal(guard.shouldPauseFor(ev, { pauseOnUserInput: true }), true);
});

test('shouldPauseFor: ignores untrusted (synthetic) events even when setting enabled', () => {
  const w = dom('<input id="x">');
  const ev = new w.KeyboardEvent('keydown', { bubbles: true });
  // isTrusted defaults to false on jsdom-constructed events; do not override.
  assert.equal(guard.shouldPauseFor(ev, { pauseOnUserInput: true }), false);
});

test('shouldPauseFor: returns false when composed path contains the sidebar host id', () => {
  const w = dom('<div id="ccp-host-root"><input id="x"></div>');
  const ev = new w.KeyboardEvent('keydown', { bubbles: true });
  Object.defineProperty(ev, 'isTrusted', { value: true });
  const host = w.document.getElementById('ccp-host-root');
  const input = w.document.getElementById('x');
  Object.defineProperty(ev, 'composedPath', { value: function () { return [input, host]; } });
  assert.equal(guard.shouldPauseFor(ev, { pauseOnUserInput: true }), false);
});

test('shouldPauseFor: accepts pointerdown and mousedown event types', () => {
  const w = dom('<button id="b">');
  const mk = function (type) {
    const ev = new w.Event(type, { bubbles: true });
    Object.defineProperty(ev, 'isTrusted', { value: true });
    Object.defineProperty(ev, 'composedPath', { value: function () { return [w.document.getElementById('b')]; } });
    return ev;
  };
  assert.equal(guard.shouldPauseFor(mk('pointerdown'), { pauseOnUserInput: true }), true);
  assert.equal(guard.shouldPauseFor(mk('mousedown'), { pauseOnUserInput: true }), true);
});

test('attachInputListeners: invokes onPause once on trusted keydown when enabled', () => {
  const w = dom('<input id="x">');
  let calls = 0;
  const detach = guard.attachInputListeners(
    w.document,
    function () { return { pauseOnUserInput: true }; },
    function (el) { return false; },
    function () { calls += 1; }
  );
  const ev = new w.KeyboardEvent('keydown', { bubbles: true });
  Object.defineProperty(ev, 'isTrusted', { value: true });
  w.document.getElementById('x').dispatchEvent(ev);
  assert.equal(calls, 1);
  detach();
});

test('attachInputListeners: does not invoke onPause when setting disabled', () => {
  const w = dom('<input id="x">');
  let calls = 0;
  const detach = guard.attachInputListeners(
    w.document,
    function () { return { pauseOnUserInput: false }; },
    function () { return false; },
    function () { calls += 1; }
  );
  const ev = new w.KeyboardEvent('keydown', { bubbles: true });
  Object.defineProperty(ev, 'isTrusted', { value: true });
  w.document.getElementById('x').dispatchEvent(ev);
  assert.equal(calls, 0);
  detach();
});
```

### Step 2: Run

Run: `npm test`
Expected: all 7 fail — module doesn't exist.

### Step 3: Create `lib/autopilot-input-guard.js`

```js
// lib/autopilot-input-guard.js
// Decides whether a user-input event should pause the autopilot.
// Pure helper + a tiny attachInputListeners utility for content scripts.
(function (root) {
  'use strict';

  const SIDEBAR_HOST_ID = 'ccp-host-root';
  const INPUT_EVENT_TYPES = ['keydown', 'pointerdown', 'mousedown'];

  function isInSidebar(event) {
    const path = (event && typeof event.composedPath === 'function') ? event.composedPath() : [];
    for (let i = 0; i < path.length; i++) {
      const el = path[i];
      if (el && el.id === SIDEBAR_HOST_ID) return true;
    }
    return false;
  }

  function shouldPauseFor(event, settings, opts) {
    if (!event || !event.isTrusted) return false;
    if (!settings || settings.pauseOnUserInput !== true) return false;
    if (isInSidebar(event)) return false;
    if (opts && typeof opts.isSidebarHost === 'function' && opts.isSidebarHost(event)) return false;
    return true;
  }

  function attachInputListeners(target, getSettings, isSidebarHost, onPause) {
    if (!target || typeof target.addEventListener !== 'function') return function () {};
    function handler(ev) {
      let settings = null;
      try { settings = getSettings && getSettings(); } catch (_) { settings = null; }
      if (shouldPauseFor(ev, settings || {}, { isSidebarHost: isSidebarHost })) {
        try { onPause(ev); } catch (_) { /* never break input handling */ }
      }
    }
    INPUT_EVENT_TYPES.forEach(function (t) { target.addEventListener(t, handler, true); });
    return function detach() {
      INPUT_EVENT_TYPES.forEach(function (t) { target.removeEventListener(t, handler, true); });
    };
  }

  const api = {
    shouldPauseFor: shouldPauseFor,
    attachInputListeners: attachInputListeners,
    SIDEBAR_HOST_ID: SIDEBAR_HOST_ID,
    INPUT_EVENT_TYPES: INPUT_EVENT_TYPES,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.autopilotInputGuard = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

### Step 4: Run tests

Run: `npm test`
Expected: 7 new tests pass.

### Step 5: Wire content.js to use the guard

In `content.js`, replace the existing block at lines 142-150:

```js
// Pause-on-user-input listener (trusted only, ignore sidebar shadow events).
document.addEventListener('keydown', function (ev) {
  if (!ev.isTrusted) return;
  const path = (typeof ev.composedPath === 'function') ? ev.composedPath() : [];
  for (let i = 0; i < path.length; i++) {
    if (path[i] && path[i].id === 'ccp-host-root') return;
  }
  _autopilotInstance && _autopilotInstance.pause('You started interacting.');
}, true);
```

with:

```js
// Pause-on-user-input listeners — gated by settings.pauseOnUserInput.
if (a.autopilotInputGuard && typeof a.autopilotInputGuard.attachInputListeners === 'function') {
  a.autopilotInputGuard.attachInputListeners(
    document,
    function () {
      // Read latest settings on every event so the toggle is live.
      let s = null;
      try {
        a.autopilotState.createState(storage).load(function (cur) { s = cur && cur.settings; });
      } catch (_) {}
      return s || { pauseOnUserInput: false };
    },
    null,
    function () {
      _autopilotInstance && _autopilotInstance.pause('You started interacting.');
    }
  );
}
```

NOTE: `state.load` is async-style (callback) but the listener returns a value synchronously. To work around, cache settings via the existing `onSettingsChange` handler:

```js
let _latestSettings = { pauseOnUserInput: true, autoSubmitQuizzes: false, behaviorMode: 'fast', runScope: 'module' };
// Initialize from storage once.
a.autopilotState.createState(storage).load(function (cur) {
  if (cur && cur.settings) _latestSettings = Object.assign({}, _latestSettings, cur.settings);
});
// Extend setAutopilotHandlers onSettingsChange:
if (typeof a.sidebar.setAutopilotHandlers === 'function') {
  a.sidebar.setAutopilotHandlers({
    onRun:    function () { _autopilotInstance.start({ scope: 'module' }); },
    onRunAllModules: function () { _autopilotInstance.startAllModules(); },
    onStop:   function () { _autopilotInstance.stop(); },
    onResume: function () { _autopilotInstance.resume(); },
    onTakeOver: function () { _autopilotInstance.takeOver(); },
    onSettingsChange: function (settings) {
      _latestSettings = Object.assign({}, _latestSettings, settings || {});
      a.autopilotState && a.autopilotState.createState(storage).update({ settings: settings }, function () {});
    },
  });
}
a.autopilotInputGuard.attachInputListeners(
  document,
  function () { return _latestSettings; },
  null,
  function () { _autopilotInstance && _autopilotInstance.pause('You started interacting.'); }
);
```

(The `_autopilotInstance.startAllModules()` and `setAutopilotHandlers({ onRunAllModules })` are added in Task 8 — this code intentionally references them now so the wiring is in one place. Task 8 supplies the matching implementation.)

### Step 6: Wire into manifest

Modify `manifest.json` — in `"content_scripts"[0].js`, insert `"lib/autopilot-input-guard.js"` BEFORE `content.js`. Use the same insertion point as `lib/page-fallback.js`.

### Step 7: Run tests

Run: `npm test`
Expected: all pass.

### Step 8: Commit

```bash
git add lib/autopilot-input-guard.js tests/autopilot-input-guard.test.js content.js manifest.json
git commit -m "feat(autopilot): respect pauseOnUserInput setting + add input-guard helper"
```

---

## Task 2: Settings — behaviorMode + runScope defaults and sidebar UI

**Files:**
- Modify: `lib/autopilot-state.js`
- Modify: `lib/sidebar.js`
- Modify: `tests/autopilot-state.test.js`

### Why

Add `behaviorMode: 'fast'` (default) and `runScope: 'module'` (default) to the settings shape. Surface a Fast/Human segmented control in the sidebar. Replace the single Run button with two buttons: "Finish current module" + "Finish all modules".

### Step 1: Write failing tests

Append to `tests/autopilot-state.test.js`:

```js
test('defaults().settings includes behaviorMode="fast" and runScope="module"', () => {
  const d = require('../lib/autopilot-state.js').defaults();
  assert.equal(d.settings.behaviorMode, 'fast');
  assert.equal(d.settings.runScope, 'module');
});

test('state.update merges settings.behaviorMode preserving other settings', (t, done) => {
  const stateMod = require('../lib/autopilot-state.js');
  const store = {};
  const storage = {
    get: function (keys, cb) { const out = {}; keys.forEach(function (k) { out[k] = store[k]; }); cb(out); },
    set: function (items, cb) { Object.assign(store, items); cb && cb(); },
  };
  const s = stateMod.createState(storage);
  s.update({ settings: { behaviorMode: 'human' } }, function () {
    s.load(function (cur) {
      assert.equal(cur.settings.behaviorMode, 'human');
      assert.equal(cur.settings.pauseOnUserInput, true); // unchanged default
      assert.equal(cur.settings.runScope, 'module');
      done();
    });
  });
});
```

### Step 2: Run

Run: `npm test`
Expected: 2 new failures.

### Step 3: Extend `defaults()` in `lib/autopilot-state.js`

Replace the `settings:` line:

```js
settings: { pauseOnUserInput: true, autoSubmitQuizzes: false, behaviorMode: 'fast', runScope: 'module' },
```

### Step 4: Run

Run: `npm test`
Expected: 2 new tests pass.

### Step 5: Update sidebar HTML + handlers

In `lib/sidebar.js`, replace the autopilot button row (around lines 84-87) with:

```js
'<button class="ccp-btn" data-action="autopilot-run">Finish current module</button>' +
'<button class="ccp-btn" data-action="autopilot-run-all">Finish all modules</button>' +
'<button class="ccp-btn" data-variant="danger" data-action="autopilot-stop" disabled>Stop</button>' +
'<button class="ccp-btn" data-action="autopilot-resume" hidden>Resume</button>' +
'<button class="ccp-btn" data-action="autopilot-takeover" hidden>Take over this tab</button>' +
```

Below the existing pause-on-input + auto-submit checkboxes, add the behavior-mode control (insert after the auto-submit checkbox line around line 93):

```js
'<div class="ccp-row" style="margin-top:6px;">' +
  '<span class="ccp-label">Behavior:</span>' +
  '<label><input type="radio" name="ccp-behavior" data-role="autopilot-behavior-fast" value="fast" checked> Fast</label>' +
  '<label><input type="radio" name="ccp-behavior" data-role="autopilot-behavior-human" value="human"> Human</label>' +
'</div>' +
```

In `wireAutopilot()` (around line 564), add a `runAll` lookup and a behavior-mode change emitter:

```js
const runAll  = shadow.querySelector('[data-action="autopilot-run-all"]');
const bm_fast  = shadow.querySelector('[data-role="autopilot-behavior-fast"]');
const bm_human = shadow.querySelector('[data-role="autopilot-behavior-human"]');
if (runAll) {
  runAll.addEventListener('click', function () {
    if (_autopilotHandlers.onRunAllModules) _autopilotHandlers.onRunAllModules();
  });
}
function emitSettings() {
  if (_autopilotHandlers.onSettingsChange) {
    const behaviorMode = (bm_human && bm_human.checked) ? 'human' : 'fast';
    _autopilotHandlers.onSettingsChange({
      pauseOnUserInput: !!(pi && pi.checked),
      autoSubmitQuizzes: !!(as && as.checked),
      behaviorMode: behaviorMode,
    });
  }
}
if (pi) pi.addEventListener('change', emitSettings);
if (as) as.addEventListener('change', emitSettings);
if (bm_fast) bm_fast.addEventListener('change', emitSettings);
if (bm_human) bm_human.addEventListener('change', emitSettings);
```

Update `setAutopilotButtonsRunning` to disable BOTH run buttons:

```js
function setAutopilotButtonsRunning(isRunning) {
  if (!shadow) return;
  const run    = shadow.querySelector('[data-action="autopilot-run"]');
  const runAll = shadow.querySelector('[data-action="autopilot-run-all"]');
  const stop   = shadow.querySelector('[data-action="autopilot-stop"]');
  if (run)    run.disabled    = isRunning;
  if (runAll) runAll.disabled = isRunning;
  if (stop)   stop.disabled   = !isRunning;
}
```

### Step 6: Run

Run: `npm test`
Expected: all pass.

### Step 7: Commit

```bash
git add lib/autopilot-state.js lib/sidebar.js tests/autopilot-state.test.js
git commit -m "feat(autopilot): add behaviorMode setting + Finish-all-modules button"
```

---

## Task 3: Fast video mode timing + handler

**Files:**
- Modify: `lib/autopilot-timing.js`
- Modify: `lib/item-handlers.js`
- Modify: `tests/autopilot-timing.test.js`
- Modify: `tests/item-handlers.test.js`

### Why

In Fast mode, seek to `duration - 45s` (or as close as `currentTime` allows), then wait at most 5 seconds for the green check before moving on. Human mode keeps the existing flow.

### Step 1: Write failing tests — timing

Append to `tests/autopilot-timing.test.js`:

```js
const timing = require('../lib/autopilot-timing.js');

test('fastVideoTiming: returns mode "fast-seek" and targetTimeSec = max(0, duration - 45)', () => {
  const t = timing.fastVideoTiming(180, function () { return 0.5; });
  assert.equal(t.mode, 'fast-seek');
  assert.equal(t.targetTimeSec, 135);
  assert.equal(t.postSeekWaitMs, 5000);
});

test('fastVideoTiming: very short video (< 45s) clamps targetTimeSec to 0', () => {
  const t = timing.fastVideoTiming(20, function () { return 0.5; });
  assert.equal(t.mode, 'fast-seek');
  assert.equal(t.targetTimeSec, 0);
});

test('fastVideoTiming: unknown duration (NaN) returns targetTimeSec = null and play-through mode', () => {
  const t = timing.fastVideoTiming(NaN, function () { return 0.5; });
  assert.equal(t.mode, 'fast-play-through');
  assert.equal(t.targetTimeSec, null);
});

test('FAST_VIDEO_SEEK_FROM_END_SEC = 45, FAST_POST_SEEK_WAIT_MS = 5000', () => {
  assert.equal(timing.FAST_VIDEO_SEEK_FROM_END_SEC, 45);
  assert.equal(timing.FAST_POST_SEEK_WAIT_MS, 5000);
});
```

### Step 2: Run

Run: `npm test`
Expected: 4 new failures.

### Step 3: Add to `lib/autopilot-timing.js`

Before the `api` declaration, add:

```js
const FAST_VIDEO_SEEK_FROM_END_SEC = 45;
const FAST_POST_SEEK_WAIT_MS = 5000;

function fastVideoTiming(durationSec, rng) {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { mode: 'fast-play-through', targetTimeSec: null, postSeekWaitMs: FAST_POST_SEEK_WAIT_MS };
  }
  const targetTimeSec = Math.max(0, durationSec - FAST_VIDEO_SEEK_FROM_END_SEC);
  return { mode: 'fast-seek', targetTimeSec: targetTimeSec, postSeekWaitMs: FAST_POST_SEEK_WAIT_MS };
}
```

Add to `api`:

```js
const api = {
  RANGES: RANGES,
  MIN_VIDEO_DURATION_FOR_SKIP_SEC: MIN_VIDEO_DURATION_FOR_SKIP_SEC,
  FAST_VIDEO_SEEK_FROM_END_SEC: FAST_VIDEO_SEEK_FROM_END_SEC,
  FAST_POST_SEEK_WAIT_MS: FAST_POST_SEEK_WAIT_MS,
  randInt: randInt,
  videoTiming: videoTiming,
  fastVideoTiming: fastVideoTiming,
  readingDwellMs: readingDwellMs,
  discussionDwellMs: discussionDwellMs,
  quizDwellMs: quizDwellMs,
  interItemGapMs: interItemGapMs,
  scrollStep: scrollStep,
};
```

### Step 4: Write failing tests — handler

Append to `tests/item-handlers.test.js`:

```js
test('video handler (Fast mode): seeks to ~duration-45s and returns video-done-fast', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM('<!doctype html><html><body><video></video></body></html>');
  const doc = j.window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { value: 180, configurable: true });
  let ct = 0;
  Object.defineProperty(v, 'currentTime', {
    get: function () { return ct; },
    set: function (x) { ct = x; },
    configurable: true,
  });
  v.play = function () { return Promise.resolve(); };
  const handlers = require('../lib/item-handlers.js').createHandlers({
    timing: require('../lib/autopilot-timing.js'),
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
  });
  const ctx = {
    doc: doc, item: { id: 'x', kind: 'video' },
    rng: function () { return 0.5; },
    signal: { aborted: false, addEventListener: function () {} },
    behaviorMode: 'fast',
  };
  const r = await handlers.video(ctx);
  assert.equal(r.outcome, 'video-done-fast');
  assert.equal(Math.abs(ct - 135) < 2, true, 'currentTime should land near duration - 45');
});

test('video handler (Fast mode): when currentTime ignored, clicks forward seek button enough times', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM(
    '<!doctype html><html><body>' +
      '<video></video>' +
      '<button aria-label="Seek Video Forward 10 seconds" data-fwd></button>' +
    '</body></html>'
  );
  const doc = j.window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { value: 180, configurable: true });
  let ct = 0;
  Object.defineProperty(v, 'currentTime', {
    get: function () { return ct; },
    set: function (_) { /* DRM, ignored */ },
    configurable: true,
  });
  v.play = function () { return Promise.resolve(); };
  let clicks = 0;
  doc.querySelector('[data-fwd]').addEventListener('click', function () { clicks += 1; ct += 10; });
  const handlers = require('../lib/item-handlers.js').createHandlers({
    timing: require('../lib/autopilot-timing.js'),
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
  });
  const ctx = {
    doc: doc, item: { id: 'x', kind: 'video' },
    rng: function () { return 0.5; },
    signal: { aborted: false, addEventListener: function () {} },
    behaviorMode: 'fast',
  };
  const r = await handlers.video(ctx);
  assert.equal(r.outcome, 'video-done-fast');
  assert.ok(clicks > 0, 'forward seek button should have been clicked');
});

test('video handler (Human mode): falls through to existing video-done outcome (regression check)', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM('<!doctype html><html><body><video></video></body></html>');
  const doc = j.window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { value: 600, configurable: true });
  let ct = 0;
  Object.defineProperty(v, 'currentTime', { get: function () { return ct; }, set: function (x) { ct = x; }, configurable: true });
  v.play = function () { return Promise.resolve(); };
  setTimeout(function () { v.dispatchEvent(new j.window.Event('ended')); }, 0);
  const handlers = require('../lib/item-handlers.js').createHandlers({
    timing: require('../lib/autopilot-timing.js'),
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
  });
  const ctx = {
    doc: doc, item: { id: 'x', kind: 'video' },
    rng: function () { return 0.5; },
    signal: { aborted: false, addEventListener: function () {} },
    behaviorMode: 'human',
  };
  const r = await handlers.video(ctx);
  assert.equal(r.outcome, 'video-done');
});
```

### Step 5: Run

Run: `npm test`
Expected: 3 new failures.

### Step 6: Implement Fast-mode branch in the video handler

In `lib/item-handlers.js`, replace the entire `async function video(ctx)` body with:

```js
async function video(ctx) {
  const doc = ctx.doc;
  const rng = ctx.rng;
  const signal = ctx.signal;
  const behaviorMode = (ctx && ctx.behaviorMode) || 'fast';
  const v = doc.querySelector('video');
  if (!v) { return { outcome: 'video-no-element' }; }

  // -------- Fast mode --------
  if (behaviorMode === 'fast') {
    const t = timing.fastVideoTiming(v.duration, rng);
    // Best-effort play; ignore rejection (DRM/autoplay-block — handled by completion confirmer).
    try { const p = v.play(); if (p && typeof p.then === 'function') p.then(function () {}, function () {}); } catch (_) {}
    if (t.mode === 'fast-seek') {
      let seeked = false;
      try {
        v.currentTime = t.targetTimeSec;
        seeked = !isNaN(v.currentTime) && Math.abs((v.currentTime || 0) - t.targetTimeSec) < 5;
      } catch (_) { /* read-only */ }
      if (!seeked) {
        const fwd = doc.querySelector('button[aria-label*="Seek Video Forward" i], button[aria-label*="seek forward" i]');
        if (fwd) {
          let need = Math.max(0, Math.ceil((t.targetTimeSec - (v.currentTime || 0)) / 10));
          need = Math.min(need, 200);
          for (let i = 0; i < need; i++) {
            try { fwd.click(); } catch (_) {}
          }
        }
      }
    }
    // In Fast mode the controller will run the confirmer with a 5s primary timeout.
    // Wait the short post-seek window here so handlers don't return before the player flushes the 'completed' state.
    await sleep(t.postSeekWaitMs, signal);
    return { outcome: 'video-done-fast', mode: t.mode };
  }

  // -------- Human mode (existing behavior, unchanged) --------
  const t = timing.videoTiming(v.duration, rng);
  let playError = null;
  let playSettled = false;
  const playPromise = (function () {
    try {
      const p = v.play();
      if (p && typeof p.then === 'function') {
        return p.then(
          function () { playSettled = true; },
          function (e) { playSettled = true; playError = e; }
        );
      }
    } catch (e) { playSettled = true; playError = e; }
    playSettled = true;
    return Promise.resolve();
  })();
  if (t.mode === 'seek') {
    let seeked = false;
    try {
      v.currentTime = t.targetTimeSec;
      seeked = !isNaN(v.currentTime) && Math.abs((v.currentTime || 0) - t.targetTimeSec) < 5;
    } catch (_) { /* read-only in some envs */ }
    if (!seeked) {
      const fwd = doc.querySelector('button[aria-label*="Seek Video Forward" i], button[aria-label*="seek forward" i]');
      if (fwd) {
        // In fallback mode we drive close to the natural end (duration - 10s) rather than the
        // primary 50-70s-before-end seek target, so the video reaches `ended` quickly without
        // requiring a full ~minute of real playback after clicking the forward-seek button.
        const endTarget = Math.max(t.targetTimeSec, v.duration - 10);
        let need = Math.max(0, Math.ceil((endTarget - (v.currentTime || 0)) / 10));
        need = Math.min(need, 200);
        for (let i = 0; i < need; i++) {
          try { fwd.click(); } catch (_) {}
        }
      }
    }
  }
  const ended = waitForEvent(v, 'ended', signal);
  const playFailed = playPromise.then(function () {
    return playError ? Promise.reject(new Error('autoplay-blocked')) : new Promise(function () { /* never resolves */ });
  });
  try {
    await Promise.race([ended, playFailed]);
  } catch (e) {
    if (e && e.message === 'autoplay-blocked') {
      return { outcome: 'video-autoplay-blocked', mode: t.mode };
    }
    throw e;
  }
  await sleep(t.postEndMs, signal);
  return { outcome: 'video-done', mode: t.mode };
}
```

### Step 7: Run

Run: `npm test`
Expected: all pass.

### Step 8: Commit

```bash
git add lib/autopilot-timing.js lib/item-handlers.js tests/autopilot-timing.test.js tests/item-handlers.test.js
git commit -m "feat(video): Fast mode seeks to duration-45s and returns video-done-fast"
```

---

## Task 4: Row-scoped green completion icon detector

**Files:**
- Modify: `lib/module-scraper.js`
- Modify: `lib/completion-confirmer.js`
- Modify: `tests/module-scraper.test.js`
- Modify: `tests/completion-confirmer.test.js`

### Why

Coursera marks complete with a green SVG icon (`rgb(39, 106, 26)`) inside the item's outline row. Need a row-scoped detector that ignores green icons elsewhere on the page (e.g., a banner).

### Step 1: Write failing tests

Append to `tests/module-scraper.test.js`:

```js
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
```

### Step 2: Run

Run: `npm test`
Expected: 5 new failures.

### Step 3: Implement `findGreenCompletionIconInRow`

In `lib/module-scraper.js`, add below `findItemCompletionIndicator`:

```js
function parseColorToRgb(c) {
  if (!c) return null;
  const s = String(c).trim();
  let m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/i);
  if (m) return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
  m = s.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    return { r: parseInt(m[1].slice(0,2), 16), g: parseInt(m[1].slice(2,4), 16), b: parseInt(m[1].slice(4,6), 16) };
  }
  m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) {
    const x = m[1];
    return { r: parseInt(x[0] + x[0], 16), g: parseInt(x[1] + x[1], 16), b: parseInt(x[2] + x[2], 16) };
  }
  return null;
}

function isGreenColor(rgb) {
  if (!rgb) return false;
  return rgb.g >= 80 && rgb.r < 120 && rgb.b < 120 && rgb.g > rgb.r && rgb.g > rgb.b;
}

function elementHasGreenColor(el) {
  if (!el || !el.getAttribute) return false;
  // 1. Inline style (jsdom-safe).
  const style = el.getAttribute('style') || '';
  const styleColor = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
  if (styleColor && isGreenColor(parseColorToRgb(styleColor[1]))) return true;
  const styleFill = style.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i);
  if (styleFill && isGreenColor(parseColorToRgb(styleFill[1]))) return true;
  const styleStroke = style.match(/(?:^|;)\s*stroke\s*:\s*([^;]+)/i);
  if (styleStroke && isGreenColor(parseColorToRgb(styleStroke[1]))) return true;
  // 2. SVG-style attributes.
  const fillAttr = el.getAttribute('fill');
  if (fillAttr && isGreenColor(parseColorToRgb(fillAttr))) return true;
  const strokeAttr = el.getAttribute('stroke');
  if (strokeAttr && isGreenColor(parseColorToRgb(strokeAttr))) return true;
  // 3. getComputedStyle in browsers.
  if (typeof el.ownerDocument !== 'undefined' && el.ownerDocument && el.ownerDocument.defaultView
      && typeof el.ownerDocument.defaultView.getComputedStyle === 'function') {
    try {
      const cs = el.ownerDocument.defaultView.getComputedStyle(el);
      if (cs) {
        if (isGreenColor(parseColorToRgb(cs.color))) return true;
        if (isGreenColor(parseColorToRgb(cs.fill))) return true;
        if (isGreenColor(parseColorToRgb(cs.stroke))) return true;
      }
    } catch (_) {}
  }
  return false;
}

function findGreenCompletionIconInRow(doc, itemId) {
  if (!doc || !itemId) return null;
  const anchors = doc.querySelectorAll('a[href*="/learn/"]');
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    if (extractItemId(a.getAttribute('href')) !== itemId) continue;
    // 1. Existing aria-label / class-based positive completion markers — re-use isCompleted's logic.
    if (isCompleted(a)) return a; // any positive marker in the row counts
    // 2. Row-scoped green icon search.
    const candidates = a.querySelectorAll('svg, span, i, div');
    for (let j = 0; j < candidates.length; j++) {
      if (elementHasGreenColor(candidates[j])) return candidates[j];
    }
  }
  return null;
}
```

Export it on `api`:

```js
findItemCompletionIndicator: findItemCompletionIndicator,
findGreenCompletionIconInRow: findGreenCompletionIconInRow,
```

### Step 4: Wire confirmer to also consult the green-icon detector

In `lib/completion-confirmer.js`, inside the polling loop, after the existing `if (scraper.findItemCompletionIndicator(...))` check, add:

```js
if (typeof scraper.findGreenCompletionIconInRow === 'function' && scraper.findGreenCompletionIconInRow(doc, itemId)) return true;
```

### Step 5: Confirmer test

Append to `tests/completion-confirmer.test.js`:

```js
test('waitForCompletion: returns true when scraper.findGreenCompletionIconInRow finds a green icon', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM(
    '<!doctype html><html><body>' +
      '<a href="/learn/x/lecture/v1/intro"><svg style="color: rgb(39, 106, 26);"><rect/></svg></a>' +
    '</body></html>'
  );
  const doc = j.window.document;
  const scraperReal = require('../lib/module-scraper.js');
  const scraper = {
    findItemCompletionIndicator: function () { return null; },
    findGreenCompletionIconInRow: function (d, id) { return scraperReal.findGreenCompletionIconInRow(d, id); },
  };
  const confirmer = require('../lib/completion-confirmer.js').createConfirmer({ sleep: function () { return Promise.resolve(); } });
  const r = await confirmer.waitForCompletion({
    doc: doc, itemId: 'v1', scraper: scraper, timeoutMs: 1000, pollIntervalMs: 1,
  });
  assert.equal(r, true);
});
```

### Step 6: Run

Run: `npm test`
Expected: all 6 new tests pass.

### Step 7: Commit

```bash
git add lib/module-scraper.js lib/completion-confirmer.js tests/module-scraper.test.js tests/completion-confirmer.test.js
git commit -m "feat(scraper): row-scoped green completion icon detection"
```

---

## Task 5: Blocked-item classifier

**Files:**
- Modify: `lib/module-scraper.js`
- Modify: `tests/module-scraper.test.js`

### Why

The autopilot must never auto-submit graded items. Centralize "is this an assessment we should skip?" into one function.

### Step 1: Write failing tests

Append to `tests/module-scraper.test.js`:

```js
const { isBlockedAssessmentItem } = require('../lib/module-scraper.js');

test('isBlockedAssessmentItem: gradedLti URLs are blocked', () => {
  assert.equal(isBlockedAssessmentItem({ url: '/learn/matlab/gradedLti/V2JqF/assignment-lesson-1-wrap-up', title: 'Wrap-up', kind: 'assignment' }), true);
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
  assert.equal(isBlockedAssessmentItem({ url: '/learn/x/discussionPrompt/d1/x', title: 'Discussion', kind: 'discussion' }), false);
});

test('isBlockedAssessmentItem: discussion is NOT blocked (safe content)', () => {
  assert.equal(isBlockedAssessmentItem({ url: '/learn/x/discussionPrompt/d1/x', title: 'Week 1 Discussion', kind: 'discussion' }), false);
});
```

### Step 2: Run

Run: `npm test`
Expected: 11 new failures.

### Step 3: Implement `isBlockedAssessmentItem`

In `lib/module-scraper.js`, just below `classifyKind`, add:

```js
const BLOCKED_URL_PATTERNS = [
  /\/gradedLti\//i,
  /\/assignment-submission\//i,
  /\/quiz\//i,
  /\/exam\//i,
  /\/peer\//i,
  /\/programming\//i,
  /\/review\//i,
];

const BLOCKED_TITLE_PATTERNS = [
  /\bgraded\b/i,
  /\bassignment\b/i,
  /\bexam\b/i,
  /\bquiz\b/i,
  /\bpeer\b/i,
  /\bassessment\b/i,
  /\breview your peers\b/i,
  /\bapp item\b/i,
];

const BLOCKED_KINDS = ['quiz', 'peer-review', 'programming', 'assignment'];

function isBlockedAssessmentItem(item) {
  if (!item) return false;
  if (item.kind && BLOCKED_KINDS.indexOf(item.kind) !== -1) return true;
  const url = item.url || '';
  for (let i = 0; i < BLOCKED_URL_PATTERNS.length; i++) {
    if (BLOCKED_URL_PATTERNS[i].test(url)) return true;
  }
  const title = item.title || '';
  for (let i = 0; i < BLOCKED_TITLE_PATTERNS.length; i++) {
    if (BLOCKED_TITLE_PATTERNS[i].test(title)) return true;
  }
  return false;
}
```

Export it on `api`:

```js
isBlockedAssessmentItem: isBlockedAssessmentItem,
```

### Step 4: Run

Run: `npm test`
Expected: 11 new tests pass.

### Step 5: Commit

```bash
git add lib/module-scraper.js tests/module-scraper.test.js
git commit -m "feat(scraper): isBlockedAssessmentItem classifier for safe skipping"
```

---

## Task 6: Resume-from-progress in `start()`

**Files:**
- Modify: `lib/module-autopilot.js`
- Modify: `tests/module-autopilot.test.js`

### Why

When the user presses Stop then Run, the autopilot must NOT restart at item 1 if item 1 has a green check. Filter the queue to incomplete + non-blocked items, and pick the cursor from `currentUrl()` when possible.

### Step 1: Write the failing tests

Append to `tests/module-autopilot.test.js`:

```js
test('start: skips already-completed items and starts at first unfinished safe item', async () => {
  const html =
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/x/lecture/v1/intro"><span aria-label="Completed"></span>Intro</a>' +
      '<a href="/learn/x/supplement/r1/syllabus">Syllabus</a>' +
      '<a href="/learn/x/lecture/v2/two">Two</a>' +
    '</div>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const navTargets = [];
  const handlers = mkFakeHandlers();
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function (url) { navTargets.push(url); return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.start();
  const got = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  // v1 is completed → queue starts with r1 then v2.
  assert.equal(got.queue.length, 2, 'completed item v1 should be filtered out');
  assert.equal(got.queue[0].id, 'r1');
  assert.equal(got.queue[1].id, 'v2');
  assert.ok(navTargets[0].indexOf('/supplement/r1/') !== -1, 'should navigate to r1, not v1');
});

test('start: when current URL matches an unfinished safe item, starts cursor there', async () => {
  const html =
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/x/lecture/v1/intro"><span aria-label="Completed"></span>Intro</a>' +
      '<a href="/learn/x/supplement/r1/syllabus">Syllabus</a>' +
      '<a href="/learn/x/lecture/v2/two">Two</a>' +
    '</div>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/v2/two');
  const storage = fakeStorage();
  const handlers = mkFakeHandlers();
  const navTargets = [];
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function (url) { navTargets.push(url); return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.start();
  const got = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  // queue is [r1, v2], current URL is v2 → cursor should be 1.
  assert.equal(got.queue.length, 2);
  assert.equal(got.cursor, 1);
});

test('start: filters out blocked items (gradedLti, quiz, peer) from the queue', async () => {
  const html =
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/x/lecture/v1/intro">Intro</a>' +
      '<a href="/learn/x/quiz/q1/wk1">Week 1 Quiz</a>' +
      '<a href="/learn/x/supplement/r1/sy">Syllabus</a>' +
      '<a href="/learn/x/peer/p1/peer">Review Your Peers</a>' +
      '<a href="/learn/x/lecture/v2/two">Two</a>' +
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
  });
  await ap.start();
  const got = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(got.queue.length, 3, 'quiz and peer items filtered out');
  assert.deepEqual(got.queue.map(function (it) { return it.id; }), ['v1', 'r1', 'v2']);
  // Skip log lines should appear.
  assert.ok(logs.some(function (l) { return /Skipped/.test(l); }));
});

test('start: when all items are complete or blocked, shows "Module already complete." and does not navigate', async () => {
  const html =
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/x/lecture/v1/intro"><span aria-label="Completed"></span>Intro</a>' +
      '<a href="/learn/x/quiz/q1/wk1">Week 1 Quiz</a>' +
    '</div>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const handlers = mkFakeHandlers();
  let status = '';
  const navTargets = [];
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function (url) { navTargets.push(url); return Promise.resolve(); },
    sidebar: {
      setAutopilotStatus: function (s) { status = s; },
      appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; },
    },
  });
  await ap.start();
  assert.ok(/already complete|no remaining safe/i.test(status));
  assert.equal(navTargets.length, 0);
});
```

### Step 2: Run

Run: `npm test`
Expected: 4 new failures.

### Step 3: Update `start()` in `lib/module-autopilot.js`

Find the existing `async function start()` (around line 138 in the post-Task-9 file). Replace the body up through and including the `state.update({...})` call (where status becomes 'running') with:

```js
async function start(opts) {
  if (destroyed) return;
  const scopeChoice = (opts && opts.scope) || 'module';
  let scraped = scraperMod.scrapeModule(doc);
  if (!scraped.items || scraped.items.length === 0) {
    logNoItemsDiagnostic();
    const syntheticItem = buildSyntheticPageItem(scraperMod, currentUrl(), doc);
    if (!syntheticItem) {
      if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('No items found in this module.');
      return;
    }
    scraped = { courseId: scraped.courseId, moduleId: scraped.moduleId, items: [syntheticItem], singlePage: true };
    if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('▶ Single-page mode for ' + syntheticItem.kind + ' "' + syntheticItem.title + '"');
  }

  // ---- Resume-from-progress queue building ----
  const raw = scraped.items;
  const safeQueue = [];
  const skipped = [];
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i];
    if (it.completed) { skipped.push({ item: it, reason: 'already-complete' }); continue; }
    if (scraperMod.isBlockedAssessmentItem && scraperMod.isBlockedAssessmentItem(it)) {
      skipped.push({ item: it, reason: 'blocked-assessment' });
      continue;
    }
    safeQueue.push(it);
  }
  // Log skips.
  for (let i = 0; i < skipped.length; i++) {
    if (sidebar.appendAutopilotLog && skipped[i].reason === 'blocked-assessment') {
      sidebar.appendAutopilotLog('⏭ Skipped graded/blocked: "' + (skipped[i].item.title || skipped[i].item.id) + '"');
    }
  }
  if (safeQueue.length === 0) {
    if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Module already complete — no remaining safe items.');
    return;
  }
  // Cursor: start at current URL's item if present in the safe queue, else 0.
  const currentItemId = scraperMod.extractItemId(currentUrl());
  let startCursor = 0;
  if (currentItemId) {
    const idx = safeQueue.findIndex(function (it) { return it.id === currentItemId; });
    if (idx >= 0) startCursor = idx;
  }
  const acq = await new Promise(function (resolve) { state.acquireOwnership(tabKey, nowFn(), resolve); });
  if (acq !== 'owner') {
    if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Another tab is running an autopilot.');
    return;
  }
  await new Promise(function (resolve) {
    state.update({
      status: 'running',
      courseId: scraped.courseId,
      moduleId: scraped.moduleId,
      queue: safeQueue,
      cursor: startCursor,
      startedAt: nowFn(),
      itemStartedAt: nowFn(),
      ownerTabKey: tabKey,
      heartbeatAt: nowFn(),
      runScope: scopeChoice,
    }, resolve);
  });
  startHeartbeat();
  if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(true);
  if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Running — item ' + (startCursor + 1) + ' of ' + safeQueue.length);
  if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('▶ Resuming at item ' + (startCursor + 1) + ' of ' + safeQueue.length + ' — ' + safeQueue.length + ' safe items');
  await navigate(safeQueue[startCursor].url);
  const curItemId = scraperMod.extractItemId(currentUrl());
  if (curItemId && curItemId === safeQueue[startCursor].id) {
    const fresh = await new Promise(function (resolve) { state.load(resolve); });
    await runCurrentItem(fresh);
  }
}
```

### Step 4: Run

Run: `npm test`
Expected: 4 new tests pass; existing tests pass.

CHECK FOR REGRESSIONS — specifically:
- `start: scrapes the module, saves running state, navigates to first item` — uses 3-item MODULE_HTML with no completed flags; should still pass (cursor=0, queue.length=3 since no blocked items).
- `start: kicks off handler when current URL already matches queue[0]` — same as above, should pass.

If any regression test fails, investigate before committing.

### Step 5: Commit

```bash
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(autopilot): start() resumes from first unfinished safe item"
```

---

## Task 7: Fast confirmer timeout for video items

**Files:**
- Modify: `lib/module-autopilot.js`
- Modify: `tests/module-autopilot.test.js`

### Why

In Fast mode the video handler returns `video-done-fast` after ~5s of post-seek wait. The controller's primary confirmer timeout (45s) makes the run feel slow when the green check has already appeared. Use a short 5s primary window for Fast-mode video items, falling through to Mark-complete and the existing 15s fallback window only when the green check truly hasn't appeared.

### Step 1: Write the failing test

Append to `tests/module-autopilot.test.js`:

```js
test('Fast mode video: primary confirmer timeout is 5s, advances quickly when green icon present', async () => {
  const html =
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/x/lecture/v1/intro"><svg style="color: rgb(39, 106, 26);"><rect/></svg>Intro</a>' +
      '<a href="/learn/x/supplement/r1/x">R</a>' +
    '</div>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' },
    { id: 'r1', kind: 'reading', url: '/learn/x/supplement/r1/x', title: 'R' },
  ];
  d.cursor = 0;
  d.settings = { behaviorMode: 'fast', pauseOnUserInput: false, autoSubmitQuizzes: false, runScope: 'module' };
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  let primaryTimeoutMs = null;
  const confirmer = {
    waitForCompletion: function (opts) {
      if (primaryTimeoutMs === null) primaryTimeoutMs = opts.timeoutMs;
      // First call uses fast timeout, returns true (green icon is present).
      return Promise.resolve(true);
    },
  };
  const handlers = mkFakeHandlers();
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    confirmer: confirmer,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.bootIfRunning();
  assert.equal(primaryTimeoutMs, 5000, 'Fast-mode video should use 5s primary confirmer timeout');
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.cursor, 1);
});
```

### Step 2: Run

Run: `npm test`
Expected: 1 failure.

### Step 3: Implement variable timeout in `runCurrentItem`

In `lib/module-autopilot.js`, just below the `PRIMARY_CONFIRMER_TIMEOUT_MS` constant declaration, add:

```js
const FAST_PRIMARY_CONFIRMER_TIMEOUT_MS = 5 * 1000;
```

In `runCurrentItem`, where `confirmer.waitForCompletion({...})` is called the first time, replace `timeoutMs: PRIMARY_CONFIRMER_TIMEOUT_MS,` with:

```js
timeoutMs: (stateNow && stateNow.settings && stateNow.settings.behaviorMode === 'fast' && item.kind === 'video')
  ? FAST_PRIMARY_CONFIRMER_TIMEOUT_MS
  : PRIMARY_CONFIRMER_TIMEOUT_MS,
```

Also pass `behaviorMode` through to handlers — find the `const ctx = { ... }` literal inside `runCurrentItem` and add:

```js
behaviorMode: (stateNow && stateNow.settings && stateNow.settings.behaviorMode) || 'fast',
```

### Step 4: Run

Run: `npm test`
Expected: all pass.

### Step 5: Commit

```bash
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(autopilot): 5s primary confirmer timeout for Fast-mode video items"
```

---

## Task 8: Course-wide scrape + `startAllModules()`

**Files:**
- Modify: `lib/module-scraper.js`
- Modify: `lib/module-autopilot.js`
- Modify: `tests/module-scraper.test.js`
- Modify: `tests/module-autopilot.test.js`

### Why

"Finish all modules" needs a queue built from ALL accordion sections, not only the section containing the current item. Skip blocked items; remember module boundaries for status display.

### Step 1: Write failing scraper test

Append to `tests/module-scraper.test.js`:

```js
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
```

### Step 2: Run

Run: `npm test`
Expected: 2 new failures.

### Step 3: Implement `scrapeAllModules`

In `lib/module-scraper.js`, add just below `scrapeModuleByAccordion`:

```js
function scrapeAllModules(doc) {
  if (!doc) return { courseId: null, modules: [] };
  const url = (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || '';
  const courseId = extractCourseId(url);
  const headers = findAccordionHeaders(doc);
  const modules = [];
  for (let i = 0; i < headers.length; i++) {
    const headerText = textOf(headers[i]).slice(0, 200);
    const panel = pairHeaderWithPanel(headers[i], doc);
    const items = panel ? extractItemsFromPanel(panel) : [];
    const idMatch = headerText.match(MODULE_HEADER_RE);
    const moduleId = idMatch ? (idMatch[1] + '-' + headerText.match(/\d+/)[0]).toLowerCase() : ('module-' + (i + 1));
    modules.push({ moduleId: moduleId, headerText: headerText, items: items });
  }
  return { courseId: courseId, modules: modules };
}
```

Export it on `api`:

```js
scrapeAllModules: scrapeAllModules,
```

### Step 4: Run

Run: `npm test`
Expected: 2 new tests pass.

### Step 5: Write failing controller test

Append to `tests/module-autopilot.test.js`:

```js
test('startAllModules: builds course-wide queue across modules, skipping blocked items', async () => {
  const html =
    '<div>' +
      '<button class="cds-AccordionHeader-button" aria-controls="m1p"><div>Module 1</div></button>' +
      '<div id="m1p"><ul>' +
        '<li><a href="/learn/x/lecture/v1/intro"><div class="outline-single-item-content-wrapper"><div><div>Intro</div><div>Video. 2 min</div></div></div></a></li>' +
        '<li><a href="/learn/x/quiz/q1/wk1"><div class="outline-single-item-content-wrapper"><div><div>Q1</div><div>Quiz. 30 min</div></div></div></a></li>' +
      '</ul></div>' +
      '<button class="cds-AccordionHeader-button" aria-controls="m2p"><div>Module 2</div></button>' +
      '<div id="m2p"><ul>' +
        '<li><a href="/learn/x/lecture/v2/m2"><div class="outline-single-item-content-wrapper"><div><div>M2</div><div>Video. 5 min</div></div></div></a></li>' +
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
  });
  await ap.startAllModules();
  const got = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(got.queue.length, 2, 'q1 is blocked; only v1 + v2 remain');
  assert.equal(got.queue[0].id, 'v1');
  assert.equal(got.queue[1].id, 'v2');
  assert.equal(got.runScope, 'course');
});
```

### Step 6: Run

Run: `npm test`
Expected: 1 new failure (`startAllModules is not a function`).

### Step 7: Implement `startAllModules`

In `lib/module-autopilot.js`, add this function just after the existing `start` definition:

```js
async function startAllModules() {
  if (destroyed) return;
  const all = scraperMod.scrapeAllModules(doc);
  // Flatten all modules' items in DOM order.
  const flat = [];
  for (let m = 0; m < all.modules.length; m++) {
    const mod = all.modules[m];
    for (let i = 0; i < mod.items.length; i++) {
      flat.push(Object.assign({}, mod.items[i], { _moduleId: mod.moduleId, _moduleHeader: mod.headerText }));
    }
  }
  if (flat.length === 0) {
    // Fall through to module-scope start which handles the synthetic fallback.
    return await start({ scope: 'course' });
  }
  // Filter completed + blocked.
  const safeQueue = [];
  const skipped = [];
  for (let i = 0; i < flat.length; i++) {
    const it = flat[i];
    if (it.completed) { skipped.push({ item: it, reason: 'already-complete' }); continue; }
    if (scraperMod.isBlockedAssessmentItem && scraperMod.isBlockedAssessmentItem(it)) {
      skipped.push({ item: it, reason: 'blocked-assessment' });
      continue;
    }
    safeQueue.push(it);
  }
  for (let i = 0; i < skipped.length; i++) {
    if (sidebar.appendAutopilotLog && skipped[i].reason === 'blocked-assessment') {
      sidebar.appendAutopilotLog('⏭ Skipped graded/blocked: "' + (skipped[i].item.title || skipped[i].item.id) + '"');
    }
  }
  if (safeQueue.length === 0) {
    if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Course already complete — no remaining safe items.');
    return;
  }
  const currentItemId = scraperMod.extractItemId(currentUrl());
  let startCursor = 0;
  if (currentItemId) {
    const idx = safeQueue.findIndex(function (it) { return it.id === currentItemId; });
    if (idx >= 0) startCursor = idx;
  }
  const acq = await new Promise(function (resolve) { state.acquireOwnership(tabKey, nowFn(), resolve); });
  if (acq !== 'owner') {
    if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Another tab is running an autopilot.');
    return;
  }
  await new Promise(function (resolve) {
    state.update({
      status: 'running',
      courseId: all.courseId,
      moduleId: safeQueue[startCursor]._moduleId,
      queue: safeQueue,
      cursor: startCursor,
      startedAt: nowFn(),
      itemStartedAt: nowFn(),
      ownerTabKey: tabKey,
      heartbeatAt: nowFn(),
      runScope: 'course',
    }, resolve);
  });
  startHeartbeat();
  if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(true);
  if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Running (course) — item ' + (startCursor + 1) + ' of ' + safeQueue.length);
  if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('▶ Course mode — ' + safeQueue.length + ' safe items across ' + all.modules.length + ' modules');
  await navigate(safeQueue[startCursor].url);
  const curItemId = scraperMod.extractItemId(currentUrl());
  if (curItemId && curItemId === safeQueue[startCursor].id) {
    const fresh = await new Promise(function (resolve) { state.load(resolve); });
    await runCurrentItem(fresh);
  }
}
```

Add `startAllModules: startAllModules` to the returned controller object.

### Step 8: Run

Run: `npm test`
Expected: all pass.

### Step 9: Commit

```bash
git add lib/module-scraper.js lib/module-autopilot.js tests/module-scraper.test.js tests/module-autopilot.test.js
git commit -m "feat(autopilot): Finish-all-modules course-wide queue across accordion sections"
```

---

## Task 9: SPA navigation continuation

**Files:**
- Modify: `lib/module-autopilot.js`
- Modify: `tests/module-autopilot.test.js`

### Why

Coursera's SPA route changes don't trigger `DOMContentLoaded`. The controller needs to re-enter `bootIfRunning()` after URL changes so the next queued item runs.

### Step 1: Write the failing test

Append to `tests/module-autopilot.test.js`:

```js
test('SPA: after pushState changes URL, autopilot re-enters bootIfRunning and runs the next item', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' },
    { id: 'r1', kind: 'reading', url: '/learn/x/supplement/r1/reading', title: 'R' },
  ];
  d.cursor = 0;
  d.ownerTabKey = 'tab-1';
  d.heartbeatAt = 1_000_000;
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkFakeHandlers();
  let runs = 0;
  // Patch handlers.video to count invocations.
  const baseVideo = handlers.video;
  handlers.video = function (ctx) { runs += 1; return baseVideo(ctx); };
  const confirmer = { waitForCompletion: function () { return Promise.resolve(true); } };
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    confirmer: confirmer,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.bootIfRunning();
  assert.equal(runs, 1, 'video handler ran once');
  // Simulate Coursera SPA route change to the next item URL.
  j.window.history.pushState({}, '', '/learn/x/supplement/r1/reading');
  // Allow the route-watcher to fire its callback (synchronous in this implementation).
  await Promise.resolve();
  await new Promise(function (r) { setTimeout(r, 0); });
  // Should advance — reading handler invoked once.
  assert.equal(handlers.calls.find(function (c) { return c.kind === 'reading'; }) ? true : false, true);
});
```

### Step 2: Run

Run: `npm test`
Expected: 1 new failure (no SPA hook).

### Step 3: Implement the SPA watcher

In `lib/module-autopilot.js`, inside `createAutopilot(opts)`, add a route-watcher installer near the end (just before `return { ... };`):

```js
function installRouteWatcher() {
  if (!win || typeof win.addEventListener !== 'function' || typeof win.history === 'undefined') return function () {};
  let lastHref = currentUrl();
  function onMaybeChange() {
    const now = currentUrl();
    if (now === lastHref) return;
    lastHref = now;
    // Don't run if no longer running or destroyed.
    if (destroyed) return;
    bootIfRunning();
  }
  win.addEventListener('popstate', onMaybeChange);
  const origPush = win.history.pushState;
  const origReplace = win.history.replaceState;
  function patched(fn) {
    return function () {
      const r = fn.apply(this, arguments);
      try { onMaybeChange(); } catch (_) {}
      return r;
    };
  }
  try { win.history.pushState = patched(origPush); } catch (_) {}
  try { win.history.replaceState = patched(origReplace); } catch (_) {}
  return function detach() {
    try { win.history.pushState = origPush; } catch (_) {}
    try { win.history.replaceState = origReplace; } catch (_) {}
    try { win.removeEventListener('popstate', onMaybeChange); } catch (_) {}
  };
}

const _detachRouteWatcher = installRouteWatcher();
```

Update `destroy()` to also detach:

```js
function destroy() {
  destroyed = true;
  if (abortController && abortController.abort) abortController.abort();
  stopHeartbeat();
  try { _detachRouteWatcher && _detachRouteWatcher(); } catch (_) {}
}
```

### Step 4: Run

Run: `npm test`
Expected: all pass.

### Step 5: Commit

```bash
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(autopilot): SPA route-watcher re-enters bootIfRunning on URL change"
```

---

## Task 10: Next-safe-anchor fallback when navigate doesn't change URL

**Files:**
- Modify: `lib/module-autopilot.js`
- Modify: `tests/module-autopilot.test.js`

### Why

Coursera sometimes refuses SPA navigation to a URL that should already be active. Provide a DOM-level fallback: after `navigate(url)`, if the URL hasn't actually changed after a short wait AND the current page isn't the target item, click the row anchor that points to the target URL.

### Step 1: Write the failing test

Append to `tests/module-autopilot.test.js`:

```js
test('navigate fallback: clicks the target row anchor in the outline when URL did not change', async () => {
  const html =
    '<a id="target-anchor" href="/learn/x/supplement/r1/reading">Syllabus</a>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' },
    { id: 'r1', kind: 'reading', url: '/learn/x/supplement/r1/reading', title: 'R' },
  ];
  d.cursor = 0;
  d.ownerTabKey = 'tab-1';
  d.heartbeatAt = 1_000_000;
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  let anchorClicked = false;
  j.window.document.getElementById('target-anchor').addEventListener('click', function () { anchorClicked = true; });
  // navigate() resolves but does NOT change window.location.href.
  const navTargets = [];
  const handlers = mkFakeHandlers();
  const confirmer = { waitForCompletion: function () { return Promise.resolve(true); } };
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    confirmer: confirmer,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function (url) { navTargets.push(url); return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
    navigateUrlChangeTimeoutMs: 50, // injectable for tests
  });
  await ap.bootIfRunning();
  // After advancing past v1, controller tries navigate(r1.url); URL doesn't change → it should click the target anchor.
  await new Promise(function (r) { setTimeout(r, 100); });
  assert.equal(anchorClicked, true, 'should click the row anchor pointing to the queued URL');
});
```

### Step 2: Run

Run: `npm test`
Expected: 1 new failure.

### Step 3: Add fallback in `runCurrentItem`'s advance step

In `lib/module-autopilot.js`, near the top of `createAutopilot`:

```js
const navigateUrlChangeTimeoutMs = (opts.navigateUrlChangeTimeoutMs && opts.navigateUrlChangeTimeoutMs > 0) ? opts.navigateUrlChangeTimeoutMs : 3000;
```

Find the existing line `await navigate(stateNow.queue[nextCursor].url);` (the intermediate-cursor branch in `runCurrentItem`) and REPLACE that line with a helper:

```js
await navigateAndConfirm(stateNow.queue[nextCursor].url);
```

Add the helper near the top of `createAutopilot`:

```js
async function navigateAndConfirm(targetUrl) {
  const before = currentUrl();
  await navigate(targetUrl);
  const deadline = nowFn() + navigateUrlChangeTimeoutMs;
  while (nowFn() < deadline) {
    if (currentUrl() !== before) return true;
    await new Promise(function (r) { setTimeout(r, 50); });
  }
  // URL did not change — try clicking a row anchor whose href matches the target path.
  if (doc && typeof doc.querySelectorAll === 'function') {
    let targetPath = targetUrl;
    try {
      const origin = (win && win.location && win.location.origin) || 'https://www.coursera.org';
      targetPath = new URL(targetUrl, origin).pathname;
    } catch (_) {}
    const anchors = doc.querySelectorAll('a[href*="/learn/"]');
    for (let i = 0; i < anchors.length; i++) {
      const href = anchors[i].getAttribute('href') || '';
      try {
        const aPath = new URL(href, 'https://www.coursera.org').pathname;
        if (aPath === targetPath) {
          try { anchors[i].click(); return true; } catch (_) {}
        }
      } catch (_) {}
    }
  }
  return false;
}
```

ALSO replace the `await navigate(queue[0].url);` line in `start()` and the equivalent in `startAllModules()` with `await navigateAndConfirm(safeQueue[startCursor].url);`.

### Step 4: Run

Run: `npm test`
Expected: all pass.

### Step 5: Commit

```bash
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(autopilot): row-anchor fallback when SPA navigate does not change URL"
```

---

## Task 11: Structured diagnostics snapshot

**Files:**
- Modify: `lib/module-autopilot.js`
- Modify: `tests/module-autopilot.test.js`

### Why

When a confirmer times out twice, log a structured one-line diagnostic so we can debug real Coursera variability without guessing.

### Step 1: Write the failing test

Append to `tests/module-autopilot.test.js`:

```js
test('confirmer timeout: logs a diagnostics snapshot with item id, kind, currentTime, queue length', async () => {
  const html =
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/x/lecture/v1/intro">Intro</a>' +
      '<a href="/learn/x/supplement/r1/r">R</a>' +
    '</div>' +
    '<video id="vid"></video>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  Object.defineProperty(j.window.document.getElementById('vid'), 'duration', { value: 60, configurable: true });
  Object.defineProperty(j.window.document.getElementById('vid'), 'currentTime', { value: 55, configurable: true });
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
  d.settings = { behaviorMode: 'fast', pauseOnUserInput: false };
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkFakeHandlers();
  handlers.tryMarkCompleteFallback = function () { return false; };
  const confirmer = { waitForCompletion: function () { return Promise.resolve(false); } };
  const logs = [];
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    confirmer: confirmer,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function () { return Promise.resolve(); },
    sidebar: {
      setAutopilotStatus: function () {}, appendAutopilotLog: function (l) { logs.push(l); },
      setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; },
    },
  });
  await ap.bootIfRunning();
  const diag = logs.find(function (l) { return /diag/i.test(l); });
  assert.ok(diag, 'should log a diagnostic line containing the word "diag"');
  assert.ok(/v1/.test(diag), 'should mention item id');
  assert.ok(/video/.test(diag), 'should mention kind');
  assert.ok(/curT=55/.test(diag), 'should include current video time');
  assert.ok(/queue=2/.test(diag), 'should include queue length');
});
```

### Step 2: Run

Run: `npm test`
Expected: 1 new failure.

### Step 3: Add `buildDiagnosticsSnapshot` and call it on stuck

In `lib/module-autopilot.js`, near `buildSyntheticPageItem`, add:

```js
function buildDiagnosticsSnapshot(stateNow, item, doc, pageFallback, scraperMod) {
  const url = (doc && doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || '';
  const v = doc && doc.querySelector ? doc.querySelector('video') : null;
  const curT = v && Number.isFinite(v.currentTime) ? v.currentTime : null;
  const dur = v && Number.isFinite(v.duration) ? v.duration : null;
  const slider = doc && doc.querySelector ? doc.querySelector('[role="slider"][aria-label*="Video Progress" i]') : null;
  const sliderVal = slider ? (slider.getAttribute('aria-valuenow') || null) : null;
  const sliderMax = slider ? (slider.getAttribute('aria-valuemax') || null) : null;
  const markBtn = pageFallback && pageFallback.findMarkCompleteButton ? !!pageFallback.findMarkCompleteButton(doc) : false;
  const nextBtn = pageFallback && pageFallback.findGoToNextItemButton ? !!pageFallback.findGoToNextItemButton(doc) : false;
  const greenIn = scraperMod && scraperMod.findGreenCompletionIconInRow && item ? !!scraperMod.findGreenCompletionIconInRow(doc, item.id) : false;
  return {
    itemId: item ? item.id : null,
    kind: item ? item.kind : null,
    title: item ? item.title : null,
    url: url,
    queue: stateNow && stateNow.queue ? stateNow.queue.length : 0,
    cursor: stateNow ? stateNow.cursor : null,
    curT: curT,
    dur: dur,
    sliderVal: sliderVal,
    sliderMax: sliderMax,
    markBtn: markBtn,
    nextBtn: nextBtn,
    greenInRow: greenIn,
  };
}

function formatDiagnosticsSnapshot(snap) {
  if (!snap) return 'diag=null';
  const parts = [
    'diag id=' + snap.itemId,
    'kind=' + snap.kind,
    'title=' + JSON.stringify(snap.title || ''),
    'url=' + snap.url,
    'queue=' + snap.queue,
    'cursor=' + snap.cursor,
    'curT=' + (snap.curT === null ? 'n/a' : Math.round(snap.curT)),
    'dur=' + (snap.dur === null ? 'n/a' : Math.round(snap.dur)),
    'sliderVal=' + (snap.sliderVal === null ? 'n/a' : snap.sliderVal),
    'sliderMax=' + (snap.sliderMax === null ? 'n/a' : snap.sliderMax),
    'markBtn=' + snap.markBtn,
    'nextBtn=' + snap.nextBtn,
    'greenInRow=' + snap.greenInRow,
  ];
  return parts.join(' ');
}
```

In `runCurrentItem`, just before the existing `state.update({ status: 'paused', ownerTabKey: null }, resolve);` call inside the `if (!confirmed) { ... }` block (after the mark-complete fallback retry has also failed), add:

```js
const snap = buildDiagnosticsSnapshot(stateNow, item, doc, pageFallback, scraperMod);
if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog(formatDiagnosticsSnapshot(snap));
try { console.warn('[autopilot stuck]', snap); } catch (_) {}
```

### Step 4: Run

Run: `npm test`
Expected: all pass.

### Step 5: Commit

```bash
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(autopilot): structured diagnostics snapshot on stuck/paused"
```

---

## Task 12: Run full suite, push, and write change summary

**Files:**
- Modify: `docs/superpowers/plans/2026-05-23-autopilot-adaptive-modes-and-safety.md`

### Step 1: Run the full suite

Run: `npm test`
Expected: all tests pass. Record the final pass count.

### Step 2: Push to PR #3

Run: `git push origin feat/module-autopilot`

### Step 3: Append a `## Change Summary` section to this plan file

Append a section that lists, with one bullet each:
- the input-guard helper and the `pauseOnUserInput` fix
- the new `behaviorMode` setting (default `fast`) and the Fast/Human sidebar control
- the new "Finish all modules" button + `startAllModules()` controller method
- the new Fast-mode video flow (seek to `duration - 45s`, 5s post-seek wait, fall back to forward-seek button)
- the row-scoped green icon detector (`findGreenCompletionIconInRow`) and its confirmer wiring
- the `isBlockedAssessmentItem` classifier and the URL/text patterns it covers
- `start()` filtering completed + blocked items and resuming from `currentUrl` cursor
- `scrapeAllModules` for course-wide queue building
- SPA `popstate` + `history.pushState/replaceState` watcher
- The row-anchor click fallback when `navigate()` doesn't change the URL within `navigateUrlChangeTimeoutMs`
- The structured `diagnosticsSnapshot` log line

Also include the final test count and the list of commits.

### Step 4: Commit and push

```bash
git add docs/superpowers/plans/2026-05-23-autopilot-adaptive-modes-and-safety.md
git commit -m "docs(plan): record change summary for adaptive autopilot modes"
git push origin feat/module-autopilot
```

---

## Self-Review

**Spec coverage (against the user's bullet list):**
- Task 1 — pause-on-input setting respected; helper module `autopilot-input-guard.js` is testable in isolation. ✓
- Task 2 — `behaviorMode` setting (default `fast`), `runScope` setting (default `module`), sidebar Fast/Human radio + Finish-current/Finish-all buttons. ✓
- Task 3 — Fast video timing (`duration - 45s` seek, 5s wait, forward-button fallback, short-video graceful fallback). ✓
- Task 4 — Row-scoped `findGreenCompletionIconInRow` (color + fill + stroke + aria-label) wired into confirmer. ✓
- Task 5 — `isBlockedAssessmentItem` URL + text classifier. ✓
- Task 6 — `start()` re-scrapes, filters completed + blocked, picks cursor from `currentUrl`, logs skips, status when nothing left. ✓
- Task 7 — Fast-mode 5s primary confirmer timeout for video items (driven by settings.behaviorMode). ✓
- Task 8 — `scrapeAllModules` + `startAllModules()` (course-wide queue, skipping blocked items, runScope='course'). ✓
- Task 9 — SPA `popstate` + `pushState`/`replaceState` watcher → `bootIfRunning()`. ✓
- Task 10 — Row-anchor click fallback when `navigate()` doesn't change URL. ✓
- Task 11 — Structured diagnostics snapshot on stuck. ✓
- Task 12 — Full suite, push, change summary. ✓

**Acceptance-criteria coverage:**
- npm test passes — Task 12 verifies. ✓
- Existing tests remain green — each task explicitly checks for regressions before commit. ✓
- pause-on-input setting — Tasks 1 + tests. ✓
- behavior mode defaults — Task 2 + tests. ✓
- fast video seek and 5-second wait — Task 3 + Task 7. ✓
- forward-seek fallback — Task 3. ✓
- green SVG completion detection — Task 4. ✓
- Stop → Run starts first unfinished safe item — Task 6. ✓
- blocked assessment skipping — Tasks 5 + 6 + 8. ✓
- Finish current module queue — Task 6 (default scope). ✓
- Finish all modules queue — Task 8. ✓
- SPA route continuation — Task 9. ✓

**Placeholder scan:** No "TBD" / "add appropriate" / "similar to" — every code change shows the actual code. The locked-in helper signatures table at the top resolves any naming ambiguity.

**Type / name consistency:**
- `behaviorMode: 'fast' | 'human'` — Tasks 2, 3, 7. Default `'fast'` in all referenced places. ✓
- `runScope: 'module' | 'course'` — Tasks 2, 6, 8. Default `'module'`. ✓
- `isBlockedAssessmentItem(item)` — Tasks 5, 6, 8. Same signature. ✓
- `findGreenCompletionIconInRow(doc, itemId)` — Tasks 4, 11. Same signature. ✓
- `scrapeAllModules(doc)` returning `{ courseId, modules: [{ moduleId, headerText, items }] }` — Task 8. ✓
- `startAllModules()` controller method — Tasks 1 (wiring), 8 (implementation). ✓
- `video-done-fast` outcome — Task 3 + Task 7 (controller uses it). ✓
- `navigateAndConfirm(url)` — Task 10. Used in both `start()` and `startAllModules()`. ✓
- Sidebar handler keys `onRun` / `onRunAllModules` — Tasks 1 (wiring) / 2 (UI). ✓

---

## Change Summary

**Pause-on-input fix (Task 1):**
- New `lib/autopilot-input-guard.js` exposes a pure `shouldPauseFor(event, settings, opts)` and `attachInputListeners(...)`. `content.js` now caches the latest settings via `onSettingsChange` and calls `attachInputListeners`, so the "Pause on keyboard/mouse input" checkbox actually controls behavior. Added `pointerdown` + `mousedown` alongside `keydown`. Sidebar shadow events are ignored.

**Settings + UI (Task 2):**
- `defaults().settings` gains `behaviorMode: 'fast'` and `runScope: 'module'`. Sidebar renames the single Run button to two: **Finish current module** + **Finish all modules**, and adds a Fast/Human radio. `setAutopilotHandlers` accepts `onRunAllModules`. Both Run buttons are disabled while running.

**Fast video mode (Task 3):**
- `lib/autopilot-timing.js` adds `fastVideoTiming(duration, rng)` + constants `FAST_VIDEO_SEEK_FROM_END_SEC=45`, `FAST_POST_SEEK_WAIT_MS=5000`. Video handler dispatches on `ctx.behaviorMode`: Fast attempts `currentTime = duration - 45`, falls back to repeated forward-seek-button clicks if the write doesn't stick, waits 5s, and returns `video-done-fast`. Human mode preserved byte-identically.

**Row-scoped green completion detector (Task 4):**
- `findGreenCompletionIconInRow(doc, itemId)` scopes the search to the matching `/learn/` anchor row. Parses inline style `color`/`fill`/`stroke`, SVG `fill`/`stroke` attributes, and `getComputedStyle` color/fill/stroke. Accepts a loose green range plus the exact Coursera `rgb(39, 106, 26)`. Confirmer consults it after `findItemCompletionIndicator` on every poll.

**Blocked-item classifier (Task 5):**
- `isBlockedAssessmentItem(item)` returns true for URL patterns `/gradedLti/`, `/assignment-submission/`, `/quiz/`, `/exam/`, `/peer/`, `/programming/`, `/review/`; for title patterns `graded`, `assignment`, `exam`, `quiz`, `peer`, `assessment`, `review your peers`, `app item`; and for kinds `quiz`, `peer-review`, `programming`, `assignment`. Discussion remains safe.

**Resume-from-progress in `start()` (Task 6):**
- `start(opts)` accepts `{ scope: 'module' | 'course' }`. Re-scrapes, filters out completed and blocked items, picks `startCursor` from `currentUrl()` when the URL maps to a safe item, logs `⏭ Skipped graded/blocked` per skip, and shows "Module already complete — no remaining safe items." if the safe queue is empty. The cursor kickoff condition kicks `runCurrentItem` whenever current URL matches `safeQueue[startCursor].id`, regardless of cursor position.

**Fast confirmer window (Task 7):**
- New `FAST_PRIMARY_CONFIRMER_TIMEOUT_MS = 5000`. The primary `confirmer.waitForCompletion` uses 5s when `settings.behaviorMode === 'fast'` AND `item.kind === 'video'`; otherwise the existing 45s. `behaviorMode` is now passed into handler `ctx`.

**Course-wide scrape + `startAllModules()` (Task 8):**
- `scrapeAllModules(doc)` returns `{ courseId, modules: [{ moduleId, headerText, items }] }` using `findAccordionHeaders` + `pairHeaderWithPanel` + `extractItemsFromPanel`. `startAllModules()` flattens all module items, filters by `isBlockedAssessmentItem` + `completed`, sets `runScope: 'course'`, and runs the same kickoff path as `start()`.

**SPA route watcher (Task 9):**
- `installRouteWatcher()` patches `history.pushState`/`replaceState` and listens to `popstate`. On URL change, calls `bootIfRunning()` (fire-and-forget; `inFlight` guards re-entrancy). `destroy()` detaches.

**`navigateAndConfirm` row-anchor fallback (Task 10):**
- All three `navigate()` call sites in the controller (`start`, `startAllModules`, `runCurrentItem`'s advance step) go through `navigateAndConfirm(url)`. It calls the injected `navigate(url)`, then polls `currentUrl()` for change up to `navigateUrlChangeTimeoutMs` (default 100ms). If the URL hasn't changed, it scans `a[href*="/learn/"]` anchors for a matching pathname and clicks it — surviving SPA-route no-ops.

**Structured diagnostics snapshot (Task 11):**
- `buildDiagnosticsSnapshot(stateNow, item, doc, pageFallback, scraperMod)` returns a flat object with `itemId`, `kind`, `title`, `url`, `queue` length, `cursor`, video `curT`/`dur`, slider `aria-valuenow`/`aria-valuemax`, mark/next button presence, and green-icon-in-row. `formatDiagnosticsSnapshot` flattens it to a `diag id=... kind=... ...` log line. Logged via `sidebar.appendAutopilotLog` + `console.warn('[autopilot stuck]', snap)` just before the pause-update inside `runCurrentItem`'s confirmer-timeout branch.

**Tests:** 519 → **563 (+44, all pass).**

**Commits on `feat/module-autopilot` for this plan (13 commits):**
- `29efeff` feat(autopilot): respect pauseOnUserInput setting + add input-guard helper
- `60c75f1` feat(autopilot): add behaviorMode setting + Finish-all-modules button
- `a3f6309` fix(sidebar): rename onRunAll handler to onRunAllModules to match content.js
- `09731e6` feat(video): Fast mode seeks to duration-45s and returns video-done-fast
- `2b2e81b` feat(scraper): row-scoped green completion icon detection
- `ccdaed1` feat(scraper): isBlockedAssessmentItem classifier for safe skipping
- `48a9d55` feat(autopilot): start() resumes from first unfinished safe item
- `16cea69` fix(autopilot): kick runCurrentItem when current URL matches startCursor>0
- `f1cd289` feat(autopilot): 5s primary confirmer timeout for Fast-mode video items
- `71f73ca` feat(autopilot): Finish-all-modules course-wide queue across accordion sections
- `1d5b9f3` feat(autopilot): SPA route-watcher re-enters bootIfRunning on URL change
- `97f856e` feat(autopilot): row-anchor fallback when SPA navigate does not change URL
- `62777ba` feat(autopilot): structured diagnostics snapshot on stuck/paused
