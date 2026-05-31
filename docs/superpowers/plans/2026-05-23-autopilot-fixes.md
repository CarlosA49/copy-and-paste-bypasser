# Module Autopilot Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the "Run autopilot button appears to do nothing" bug and replace the video handler's pre-skip-dwell model with the simpler "start → seek to ~1 min before end → wait 5–10 s" flow the user requested.

**Architecture:** Three small fixes, all on the existing `feat/module-autopilot` branch (or follow-up branch). Task 1 makes `start()` kick off `runCurrentItem` directly when the user is already on the queue's first item (the most likely "nothing happens" case). Task 2 adds visible `console.warn` lines on every silent early-return in `content.js` so future "doesn't work" reports have a diagnostic. Task 3 rewrites the video timings and handler to the simpler flow.

**Tech Stack:** Vanilla JS, `node:test` + jsdom, Chrome Extension Manifest V3. No new dependencies.

---

## File Structure

**Modify:**
- `lib/module-autopilot.js` — at the end of `start()`, kick off `runCurrentItem` directly if the current page URL already matches the queue's first item (no SPA navigation happens, so DOMContentLoaded won't re-fire).
- `content.js` — replace silent `return` early-exits in `startAutopilot()` with `console.warn` lines that name the missing dependency, so DevTools shows what's blocking initialization.
- `lib/autopilot-timing.js` — update `RANGES`, `MIN_VIDEO_DURATION_FOR_SKIP_SEC`, and `videoTiming()` for the simpler model (no pre-skip dwell, seek ≈1 min before end, 5–10 s post-end).
- `lib/item-handlers.js` — simplify the `video` handler now that there's no pre-skip wait.
- `tests/autopilot-timing.test.js` — replace tests that asserted the pre-skip/cap behavior with tests for the new ranges + simpler return shape.
- `tests/item-handlers.test.js` — update video tests to match the simpler handler.
- `tests/module-autopilot.test.js` — add a test asserting `start()` triggers the handler when the page URL already matches the queue's first item.

**No new files.** All three fixes are surgical edits to existing modules + their tests.

---

## Task 1: `start()` kicks off `runCurrentItem` when already on the first item

**Files:**
- Modify: `lib/module-autopilot.js` (`start()` function tail)
- Modify: `tests/module-autopilot.test.js` (one new test)

### Why

`start()` writes state with `cursor: 0`, then calls `navigate(queue[0].url)`. If the user is already on that URL (e.g., they navigated to a Coursera lecture, opened the sidebar, clicked Run), the navigate path either clicks an `<a>` that's already the current page (no SPA route change) OR falls through to `location.href = url` (browser ignores same-URL nav). Either way, no DOMContentLoaded fires, so `bootIfRunning()` doesn't run, so `runCurrentItem` doesn't run, so the handler never executes. Status shows "Running — item 1 of N" forever and the user sees nothing.

Fix: after `navigate(...)`, check if `currentUrl()`'s itemId matches `queue[0].id`. If yes, re-load state and call `runCurrentItem` directly.

### Step 1: Write the failing test

Append this test to `tests/module-autopilot.test.js` (after the existing `runCurrentItem bails on signal abort` test):

```js
test('start: kicks off handler when current URL already matches queue[0]', async () => {
  // User is on /lecture/v1/intro and clicks Run. Without the fix, navigate is a no-op
  // and the handler never runs.
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const handlers = mkFakeHandlers();
  const navTargets = [];
  const ap = createAutopilot({
    document: j.window.document,
    window: j.window,
    storage: storage,
    handlers: handlers,
    nowFn: function () { return 1_000_000; },
    tabKey: 'tab-1',
    rng: seededRng(1),
    navigate: function (url) { navTargets.push(url); return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.start();
  // navigate is still called (best-effort), but the handler must have fired too.
  assert.equal(handlers.calls.length, 1, 'handler should have run for queue[0]');
  assert.equal(handlers.calls[0].kind, 'video');
  assert.equal(handlers.calls[0].id, 'v1');
  // After the handler resolves, cursor should advance to 1.
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.cursor, 1, 'cursor should advance after handler resolves');
});
```

### Step 2: Run tests to confirm the new test fails

Run: `npm test`
Expected: the new test fails because `handlers.calls.length` is `0` (handler never fired). All other tests pass.

### Step 3: Modify `start()` to call `runCurrentItem` when on the queue's first item

In `lib/module-autopilot.js`, find the end of the `start()` function:

```js
      startHeartbeat();
      if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(true);
      if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Running — item 1 of ' + queue.length);
      if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('▶ Started — ' + queue.length + ' items');
      await navigate(queue[0].url);
    }
```

Replace with:

```js
      startHeartbeat();
      if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(true);
      if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Running — item 1 of ' + queue.length);
      if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('▶ Started — ' + queue.length + ' items');
      await navigate(queue[0].url);
      // If the page URL already matches queue[0], no DOMContentLoaded will fire
      // (the SPA-click was a no-op or location.href = same URL is ignored).
      // Kick off the handler directly so the run actually progresses.
      const curItemId = scraperMod.extractItemId(currentUrl());
      if (curItemId && curItemId === queue[0].id) {
        const fresh = await new Promise(function (resolve) { state.load(resolve); });
        await runCurrentItem(fresh);
      }
    }
```

### Step 4: Run tests to verify pass

Run: `npm test`
Expected: 442/0 (441 prior + 1 new). Suite exits cleanly.

### Step 5: Commit

```
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "fix(autopilot): start() kicks off handler when already on queue[0] URL"
```

---

## Task 2: Make `startAutopilot()` failures visible in DevTools

**Files:**
- Modify: `content.js` (replace silent returns with `console.warn`)

### Why

When the user clicks Run and nothing happens, it can mean any of five distinct failures in `content.js`'s `startAutopilot()`:

1. `window.ClipboardCleaner` not populated (no lib loaded).
2. `a.moduleAutopilot.createAutopilot` missing (the controller lib didn't load).
3. `a.sidebar` missing.
4. `a.autopilotState` missing OR `chromeStorageOrNull()` returned null (no `"storage"` permission).
5. `a.itemHandlers.createHandlers` missing.

Right now all five just `return;` silently. Future diagnosis becomes "check the manifest, check the console, hope something's there." Each failure should emit a labeled `console.warn` so the user can paste one line back to us.

### Step 1: Replace the early-return block in `content.js`

Find this block (around lines 60–70):

```js
  let _autopilotInstance = null;

  function startAutopilot() {
    const a = api();
    if (!a || !a.moduleAutopilot || typeof a.moduleAutopilot.createAutopilot !== 'function') return;
    if (!a.sidebar) return;
    if (!a.autopilotState) return;
    const storage = a.autopilotState.chromeStorageOrNull && a.autopilotState.chromeStorageOrNull();
    if (!storage) return;
    if (!a.itemHandlers || typeof a.itemHandlers.createHandlers !== 'function') return;
```

Replace with:

```js
  let _autopilotInstance = null;

  function startAutopilot() {
    const a = api();
    if (!a) { console.warn('[autopilot] disabled: window.ClipboardCleaner is missing'); return; }
    if (!a.moduleAutopilot || typeof a.moduleAutopilot.createAutopilot !== 'function') {
      console.warn('[autopilot] disabled: moduleAutopilot.createAutopilot not loaded');
      return;
    }
    if (!a.sidebar) { console.warn('[autopilot] disabled: sidebar API not loaded'); return; }
    if (!a.autopilotState) { console.warn('[autopilot] disabled: autopilotState not loaded'); return; }
    const storage = a.autopilotState.chromeStorageOrNull && a.autopilotState.chromeStorageOrNull();
    if (!storage) {
      console.warn('[autopilot] disabled: chrome.storage.local unavailable (missing "storage" permission?)');
      return;
    }
    if (!a.itemHandlers || typeof a.itemHandlers.createHandlers !== 'function') {
      console.warn('[autopilot] disabled: itemHandlers.createHandlers not loaded');
      return;
    }
```

The rest of the function stays unchanged.

### Step 2: Run tests

Run: `npm test`
Expected: 442/0 (no test-affecting changes; content.js has no dedicated tests).

### Step 3: Commit

```
git add content.js
git commit -m "fix(autopilot): label every startAutopilot early-return with console.warn"
```

---

## Task 3: Replace video timings with the simpler "start → quick seek → 5–10 s" model

**Files:**
- Modify: `lib/autopilot-timing.js` (RANGES, MIN constant, `videoTiming` body)
- Modify: `lib/item-handlers.js` (video handler — drop pre-skip sleep)
- Modify: `tests/autopilot-timing.test.js` (replace pre-skip + cap tests)
- Modify: `tests/item-handlers.test.js` (update the long-video seek test and the pre-skip abort test)

### Why

The user's new preferred flow is: start the video, immediately seek to ~1 minute before the end, wait 5–10 s for completion. The current model has a 1–5 min pre-skip dwell + a cap that falls back to play-through when the math gets tight. Simpler is better here — drop the dwell entirely.

### New behavior

| Field | Old | New |
|---|---|---|
| Pre-skip dwell | 60–300 s, capped to `min(300, targetTime − 10)` | **0 ms (removed)** |
| Seek-from-end | 60–120 s | **50–70 s** |
| Post-end dwell | 10–20 s | **5–10 s** |
| Min duration for skip | 180 s | **90 s** |

`videoTiming` return shape stays `{ mode, preSkipMs, targetTimeSec, postEndMs }` so the handler doesn't need to change its API — `preSkipMs` is just always `0` in seek mode.

### Step 1: Update `lib/autopilot-timing.js`

Find:

```js
  const RANGES = {
    videoPreSkipSec: [60, 300],
    videoSeekFromEndSec: [60, 120],
    videoPostEndSec: [10, 20],
    readingDwellSec: [120, 180],
    discussionDwellSec: [120, 180],
    quizDwellSec: [120, 180],
    interItemGapSec: [8, 18],
    scrollStepIntervalSec: [3, 8],
    scrollStepPx: [200, 500],
  };

  const MIN_VIDEO_DURATION_FOR_SKIP_SEC = 180;
  const SEEK_BUFFER_SEC = 10;
```

Replace with:

```js
  const RANGES = {
    videoSeekFromEndSec: [50, 70],
    videoPostEndSec: [5, 10],
    readingDwellSec: [120, 180],
    discussionDwellSec: [120, 180],
    quizDwellSec: [120, 180],
    interItemGapSec: [8, 18],
    scrollStepIntervalSec: [3, 8],
    scrollStepPx: [200, 500],
  };

  const MIN_VIDEO_DURATION_FOR_SKIP_SEC = 90;
```

(`videoPreSkipSec` and `SEEK_BUFFER_SEC` constants removed — no longer needed.)

Then find the `videoTiming` function:

```js
  function videoTiming(durationSec, rng) {
    const postEndMs = randInt(rng, RANGES.videoPostEndSec[0], RANGES.videoPostEndSec[1]) * 1000;
    if (!Number.isFinite(durationSec) || durationSec < MIN_VIDEO_DURATION_FOR_SKIP_SEC) {
      return { mode: 'play-through', preSkipMs: 0, targetTimeSec: null, postEndMs: postEndMs };
    }
    const seekFromEnd = randInt(rng, RANGES.videoSeekFromEndSec[0], RANGES.videoSeekFromEndSec[1]);
    const targetTimeSec = durationSec - seekFromEnd;
    const maxPreSkipSec = Math.floor(targetTimeSec - SEEK_BUFFER_SEC);
    if (maxPreSkipSec < RANGES.videoPreSkipSec[0]) {
      return { mode: 'play-through', preSkipMs: 0, targetTimeSec: null, postEndMs: postEndMs };
    }
    const upper = Math.min(RANGES.videoPreSkipSec[1], maxPreSkipSec);
    const preSkipSec = randInt(rng, RANGES.videoPreSkipSec[0], upper);
    return {
      mode: 'seek',
      preSkipMs: preSkipSec * 1000,
      targetTimeSec: targetTimeSec,
      postEndMs: postEndMs,
    };
  }
```

Replace with:

```js
  function videoTiming(durationSec, rng) {
    const postEndMs = randInt(rng, RANGES.videoPostEndSec[0], RANGES.videoPostEndSec[1]) * 1000;
    if (!Number.isFinite(durationSec) || durationSec < MIN_VIDEO_DURATION_FOR_SKIP_SEC) {
      return { mode: 'play-through', preSkipMs: 0, targetTimeSec: null, postEndMs: postEndMs };
    }
    const seekFromEnd = randInt(rng, RANGES.videoSeekFromEndSec[0], RANGES.videoSeekFromEndSec[1]);
    const targetTimeSec = durationSec - seekFromEnd;
    return {
      mode: 'seek',
      preSkipMs: 0,
      targetTimeSec: targetTimeSec,
      postEndMs: postEndMs,
    };
  }
```

Then find the `api` export block:

```js
  const api = {
    RANGES: RANGES,
    MIN_VIDEO_DURATION_FOR_SKIP_SEC: MIN_VIDEO_DURATION_FOR_SKIP_SEC,
    SEEK_BUFFER_SEC: SEEK_BUFFER_SEC,
    randInt: randInt,
    videoTiming: videoTiming,
    readingDwellMs: readingDwellMs,
    discussionDwellMs: discussionDwellMs,
    quizDwellMs: quizDwellMs,
    interItemGapMs: interItemGapMs,
    scrollStep: scrollStep,
  };
```

Replace with:

```js
  const api = {
    RANGES: RANGES,
    MIN_VIDEO_DURATION_FOR_SKIP_SEC: MIN_VIDEO_DURATION_FOR_SKIP_SEC,
    randInt: randInt,
    videoTiming: videoTiming,
    readingDwellMs: readingDwellMs,
    discussionDwellMs: discussionDwellMs,
    quizDwellMs: quizDwellMs,
    interItemGapMs: interItemGapMs,
    scrollStep: scrollStep,
  };
```

(Removed `SEEK_BUFFER_SEC` export.)

### Step 2: Update `lib/item-handlers.js` — drop the pre-skip sleep

Find the `video` handler inside `createHandlers`:

```js
    async function video(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const v = doc.querySelector('video');
      if (!v) { return { outcome: 'video-no-element' }; }
      const t = timing.videoTiming(v.duration, rng);
      // Try to play; swallow sync throws and capture async rejection without
      // blocking the rest of the handler. If play() rejects (autoplay block, DRM,
      // etc.), and `ended` never fires, the outer wait-for-ended would hang forever
      // — so we race waitForEvent against the play rejection.
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
        await sleep(t.preSkipMs, signal);
        try { v.currentTime = t.targetTimeSec; } catch (_) { /* read-only in some envs */ }
      }
      // Race the 'ended' event against a play() rejection so an autoplay-blocked
      // tab surfaces a clean outcome instead of hanging.
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

Replace with (the only change is the `if (t.mode === 'seek')` block — no more `await sleep(t.preSkipMs, signal)`):

```js
    async function video(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const v = doc.querySelector('video');
      if (!v) { return { outcome: 'video-no-element' }; }
      const t = timing.videoTiming(v.duration, rng);
      // Try to play; swallow sync throws and capture async rejection without
      // blocking the rest of the handler. If play() rejects (autoplay block, DRM,
      // etc.), and `ended` never fires, the outer wait-for-ended would hang forever
      // — so we race waitForEvent against the play rejection.
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
      // Simpler flow: in seek mode, jump straight to ~1 min before the end —
      // no pre-skip dwell. Coursera marks complete once `ended` fires.
      if (t.mode === 'seek') {
        try { v.currentTime = t.targetTimeSec; } catch (_) { /* read-only in some envs */ }
      }
      // Race the 'ended' event against a play() rejection so an autoplay-blocked
      // tab surfaces a clean outcome instead of hanging.
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

### Step 3: Update `tests/autopilot-timing.test.js`

Find the existing video-timing tests block. Replace **the entire set of `videoTiming` tests** (the seven tests starting with `'videoTiming: short video -> play-through'` through `'videoTiming: cap-fallback at borderline duration where maxPreSkip < 60'`) with this set:

```js
test('videoTiming: short video (<90 s) -> play-through', () => {
  const r = videoTiming(60, seededRng(1));
  assert.equal(r.mode, 'play-through');
  assert.equal(r.preSkipMs, 0);
  assert.equal(r.targetTimeSec, null);
  assert.ok(r.postEndMs >= 5000 && r.postEndMs <= 10000);
});

test('videoTiming: NaN/missing duration -> play-through', () => {
  const r = videoTiming(NaN, seededRng(1));
  assert.equal(r.mode, 'play-through');
});

test('videoTiming: just-below-threshold duration (89) -> play-through', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = videoTiming(89, seededRng(seed));
    assert.equal(r.mode, 'play-through');
  }
});

test('videoTiming: long video -> seek mode, preSkipMs=0, target in (duration-70, duration-50)', () => {
  const rng = seededRng(1);
  const duration = 600;
  const r = videoTiming(duration, rng);
  assert.equal(r.mode, 'seek');
  assert.equal(r.preSkipMs, 0, 'new simpler model has no pre-skip dwell');
  assert.ok(r.targetTimeSec >= duration - 70 && r.targetTimeSec <= duration - 50,
    'targetTimeSec ' + r.targetTimeSec + ' should be in [duration-70, duration-50]');
  assert.ok(r.postEndMs >= 5000 && r.postEndMs <= 10000);
});

test('videoTiming: boundary duration (90) -> seek mode (threshold is inclusive at 90)', () => {
  // 90 is NOT < 90, so it enters seek mode. targetTime = 90 - seekFromEnd(50..70) = 20..40.
  const r = videoTiming(90, seededRng(1));
  assert.equal(r.mode, 'seek');
  assert.equal(r.preSkipMs, 0);
  assert.ok(r.targetTimeSec >= 20 && r.targetTimeSec <= 40);
});
```

Also find this test:

```js
test('exports RANGES and constants', () => {
  assert.ok(RANGES.videoPreSkipSec);
  assert.equal(MIN_VIDEO_DURATION_FOR_SKIP_SEC, 180);
  assert.equal(SEEK_BUFFER_SEC, 10);
});
```

Replace with:

```js
test('exports RANGES and constants', () => {
  assert.deepEqual(RANGES.videoSeekFromEndSec, [50, 70]);
  assert.deepEqual(RANGES.videoPostEndSec, [5, 10]);
  assert.equal(MIN_VIDEO_DURATION_FOR_SKIP_SEC, 90);
});
```

Also update the imports at the top of the file — find:

```js
const {
  randInt,
  videoTiming,
  readingDwellMs,
  discussionDwellMs,
  quizDwellMs,
  interItemGapMs,
  scrollStep,
  RANGES,
  MIN_VIDEO_DURATION_FOR_SKIP_SEC,
  SEEK_BUFFER_SEC,
} = require('../lib/autopilot-timing.js');
```

Replace with:

```js
const {
  randInt,
  videoTiming,
  readingDwellMs,
  discussionDwellMs,
  quizDwellMs,
  interItemGapMs,
  scrollStep,
  RANGES,
  MIN_VIDEO_DURATION_FOR_SKIP_SEC,
} = require('../lib/autopilot-timing.js');
```

(Drop the `SEEK_BUFFER_SEC` import — no longer exported.)

### Step 4: Update `tests/item-handlers.test.js`

Find this test in the video-handler section:

```js
test('video handler (long video): seeks to targetTime then waits for ended', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><video></video></body>',
    { url: 'https://www.coursera.org/learn/x/lecture/v2/long' }
  ).window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { configurable: true, get: function () { return 600; } });
  let seekedTo = null;
  Object.defineProperty(v, 'currentTime', {
    configurable: true,
    get: function () { return seekedTo || 0; },
    set: function (val) { seekedTo = val; },
  });
  v.play = function () { v.paused = false; };
  v.pause = function () { v.paused = true; };

  const sleep = function () { return Promise.resolve(); };
  const scroll = function () { return Promise.resolve(); };
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: sleep,
    jitteredScroll: scroll,
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
  });
  const sig = { aborted: false, addEventListener: function () {}, removeEventListener: function () {} };
  const p = handlers.video({ doc: doc, item: { id: 'v2', kind: 'video' }, rng: seededRng(2), signal: sig });
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.ok(seekedTo !== null, 'currentTime should have been set');
  v.dispatchEvent(new doc.defaultView.Event('ended'));
  const out = await p;
  assert.equal(out.outcome, 'video-done');
  assert.equal(out.mode, 'seek');
  assert.ok(seekedTo >= 480 && seekedTo <= 540,
    'seekedTo ' + seekedTo + ' should be in [480, 540]');
});
```

Replace with (target range is now duration - 70..50, i.e. 530..550):

```js
test('video handler (long video): seeks immediately to ~1 min before end, no pre-skip dwell', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><video></video></body>',
    { url: 'https://www.coursera.org/learn/x/lecture/v2/long' }
  ).window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { configurable: true, get: function () { return 600; } });
  let seekedTo = null;
  Object.defineProperty(v, 'currentTime', {
    configurable: true,
    get: function () { return seekedTo || 0; },
    set: function (val) { seekedTo = val; },
  });
  v.play = function () { v.paused = false; };
  v.pause = function () { v.paused = true; };

  const sleeps = [];
  const sleep = function (ms) { sleeps.push(ms); return Promise.resolve(); };
  const scroll = function () { return Promise.resolve(); };
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: sleep,
    jitteredScroll: scroll,
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
  });
  const sig = { aborted: false, addEventListener: function () {}, removeEventListener: function () {} };
  const p = handlers.video({ doc: doc, item: { id: 'v2', kind: 'video' }, rng: seededRng(2), signal: sig });
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.ok(seekedTo !== null, 'currentTime should have been set');
  // Seek target is duration(600) - seekFromEnd(50..70) = 530..550.
  assert.ok(seekedTo >= 530 && seekedTo <= 550,
    'seekedTo ' + seekedTo + ' should be in [530, 550]');
  v.dispatchEvent(new doc.defaultView.Event('ended'));
  const out = await p;
  assert.equal(out.outcome, 'video-done');
  assert.equal(out.mode, 'seek');
  // Only the post-end dwell should have been awaited — no pre-skip sleep.
  assert.equal(sleeps.length, 1, 'only post-end sleep, no pre-skip');
  assert.ok(sleeps[0] >= 5000 && sleeps[0] <= 10000, 'post-end dwell in [5000, 10000] ms');
});
```

Find this test (the abort-mid-flight test that relies on the pre-skip `sleep` to be where abort lands):

```js
test('video handler: aborts mid-flight on signal abort', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><video></video></body>'
  ).window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { configurable: true, get: function () { return 600; } });
  Object.defineProperty(v, 'currentTime', { configurable: true, get: function () { return 0; }, set: function () {} });
  v.play = function () {};
  v.pause = function () {};

  const sleep = function (ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.addEventListener) {
        signal.addEventListener('abort', function () { reject(new Error('aborted')); });
      }
    });
  };
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: sleep,
    jitteredScroll: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
  });
  const listeners = [];
  const sig = {
    aborted: false,
    addEventListener: function (k, fn) { if (k === 'abort') listeners.push(fn); },
    removeEventListener: function () {},
  };
  const p = handlers.video({ doc: doc, item: { id: 'v3', kind: 'video' }, rng: seededRng(3), signal: sig })
    .then(function () { return 'resolved'; }, function (e) { return 'rejected:' + (e && e.message || ''); });
  await new Promise(function (r) { setTimeout(r, 0); });
  sig.aborted = true;
  listeners.forEach(function (fn) { fn(); });
  const result = await p;
  assert.equal(result, 'rejected:aborted');
});
```

The new simpler video handler has no pre-skip sleep — abort during `waitForEvent('ended')` is now the relevant path. The test still works because `waitForEvent` listens for abort (we hardened that in a prior commit). No change needed to the test body, but the inline comments may now reference behavior that no longer applies. Replace the test with:

```js
test('video handler: aborts mid-flight on signal abort (during ended wait)', async () => {
  // After the seek, the handler awaits the `ended` event via waitForEvent,
  // which honors abort. Trigger abort during that wait and confirm rejection.
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><video></video></body>'
  ).window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { configurable: true, get: function () { return 600; } });
  Object.defineProperty(v, 'currentTime', { configurable: true, get: function () { return 0; }, set: function () {} });
  v.play = function () { return Promise.resolve(); };
  v.pause = function () {};

  const sleep = function () { return Promise.resolve(); };
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: sleep,
    jitteredScroll: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
  });
  const listeners = [];
  const sig = {
    aborted: false,
    addEventListener: function (k, fn) { if (k === 'abort') listeners.push(fn); },
    removeEventListener: function () {},
  };
  const p = handlers.video({ doc: doc, item: { id: 'v3', kind: 'video' }, rng: seededRng(3), signal: sig })
    .then(function () { return 'resolved'; }, function (e) { return 'rejected:' + (e && e.message || ''); });
  await new Promise(function (r) { setTimeout(r, 0); });
  sig.aborted = true;
  listeners.forEach(function (fn) { fn(); });
  const result = await p;
  assert.equal(result, 'rejected:aborted');
});
```

### Step 5: Run tests

Run: `npm test`
Expected: 442/0 (the count from Task 1, with replaced tests netting to the same total). Suite exits cleanly.

If tests fail, the most likely cause is a stale assertion range from the old timings. Re-read the failure message and confirm the assertion was updated for the new ranges (target window `[530, 550]`, post-end window `[5000, 10000]`).

### Step 6: Commit

```
git add lib/autopilot-timing.js lib/item-handlers.js tests/autopilot-timing.test.js tests/item-handlers.test.js
git commit -m "feat(autopilot): simpler video flow — immediate seek + 5-10s post-end dwell"
```

---

## Self-Review

**1. Spec coverage:**

| Requirement | Task |
|---|---|
| Fix "Run autopilot button does nothing" when on first item | Task 1 |
| Surface initialization failures so future bugs are diagnosable | Task 2 |
| Replace pre-skip dwell with direct play→seek→5-10s flow | Task 3 |
| Tests updated to match the new ranges | Task 3 Steps 3–4 |
| Suite exits cleanly | Verified via Step 5 in each task |

**2. Placeholder scan:** No "TBD", "TODO", "implement later", or "similar to Task N". Every step has runnable code or a single command.

**3. Type consistency:**
- `videoTiming` return shape unchanged: `{ mode, preSkipMs, targetTimeSec, postEndMs }`. `preSkipMs` is always `0` in seek mode under the new flow — consumers don't need to change their unpacking.
- `runCurrentItem` signature unchanged.
- The new Task 1 test imports the same `stateMod`, `createAutopilot`, `seededRng`, `fakeStorage`, `makePage`, `MODULE_HTML`, `mkFakeHandlers` helpers already present at the top of `tests/module-autopilot.test.js`.
- `SEEK_BUFFER_SEC` is dropped from both the lib and the test imports — Task 3 Step 3 updates the destructure list to match.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-23-autopilot-fixes.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review.
2. **Inline Execution** — execute in this session via `superpowers:executing-plans`.

Which approach?
