# Module Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sidebar-triggered autopilot that walks the current Coursera module's remaining items end-to-end — playing videos with a believable pre-skip dwell, dwelling on readings, posting from a curated 20-reply pool on discussions, and falling back to the existing answer engine on quizzes/assignments — checkpointing run state to `chrome.storage.local` so a refresh or SPA navigation resumes cleanly, with multi-tab ownership semantics that prevent two tabs from corrupting shared state.

**Architecture:** Six new pure-logic modules in `lib/` (IIFE + dual `module.exports`/`window.ClipboardCleaner.<name>` pattern matching the rest of the codebase), one modified sidebar tab, a one-line stash in `lib/cleaner.js`, and wiring in `manifest.json` + `content.js`. State persists in `chrome.storage.local`; a `bootIfRunning()` call on every page load reads state and resumes after acquiring tab ownership. No background service worker.

**Tech Stack:** Vanilla JS (matches existing style), `node:test` + `node:assert/strict` + jsdom, Chrome Extension Manifest V3, `chrome.storage.local` (faked in tests). No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-05-23-module-autopilot-design.md` — read it first if anything in this plan is ambiguous.

---

## File Structure

**Create:**
- `lib/autopilot-timing.js` — pure RNG-driven timing helpers. All ranges as named constants. ~80 lines.
- `lib/discussion-replies.js` — the 20-reply pool + `pickReply(history, rng)`. ~80 lines.
- `lib/autopilot-state.js` — `chrome.storage.local` CRUD for the run state + per-course completion log. Async API matching the existing `voice-profile.js` shape. ~120 lines.
- `lib/module-scraper.js` — DOM → `{ courseId, moduleId, items }`, with `extractCourseId(url)` and `extractItemId(url)` helpers. ~130 lines.
- `lib/item-handlers.js` — `handlers = { video, reading, discussion, fallback }`. Each handler signature: `async ({ doc, item, sleep, signal, rng, timing, replies, deps }) → { outcome }`. ~250 lines.
- `lib/module-autopilot.js` — controller. `createAutopilot(opts)` returns `{ start, stop, pause, resume, bootIfRunning, destroy }`. Owns the run loop, navigation, heartbeat, pause/resume triggers, ownership. ~220 lines.

**Tests (one per lib module):**
- `tests/autopilot-timing.test.js`
- `tests/discussion-replies.test.js`
- `tests/autopilot-state.test.js`
- `tests/module-scraper.test.js`
- `tests/item-handlers.test.js`
- `tests/module-autopilot.test.js`

**Modify:**
- `lib/cleaner.js` — one-line stash of `window.ClipboardCleaner.lastCleanedCopy` whenever the cleaner produces a result.
- `lib/sidebar.js` — new `Autopilot` tab (`data-tab="autopilot"`) with status, log, settings checkboxes, Run/Stop/Resume buttons. Expose `setAutopilotStatus`, `appendAutopilotLog`, `setAutopilotPaused`, `getAnswerText`, `setAutopilotSettingsChangeHandler`, and the public start/stop/resume callbacks wired by the controller.
- `manifest.json` — append the six new lib files before `lib/sidebar.js`. Ensure top-level `"permissions": ["storage"]` is present.
- `content.js` — on `DOMContentLoaded` instantiate the autopilot and call `bootIfRunning()`.

---

## Task 1: Timing helpers

**Files:**
- Create: `lib/autopilot-timing.js`
- Create: `tests/autopilot-timing.test.js`

### Step 1: Write the failing test

Create `tests/autopilot-timing.test.js`:

```js
// tests/autopilot-timing.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
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

function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('randInt returns integers in [lo, hi] inclusive', () => {
  const rng = seededRng(1);
  for (let i = 0; i < 200; i++) {
    const n = randInt(rng, 5, 10);
    assert.ok(Number.isInteger(n));
    assert.ok(n >= 5 && n <= 10, 'expected 5..10, got ' + n);
  }
});

test('videoTiming: short video -> play-through', () => {
  const r = videoTiming(120, seededRng(1));
  assert.equal(r.mode, 'play-through');
  assert.equal(r.preSkipMs, 0);
  assert.equal(r.targetTimeSec, null);
  assert.ok(r.postEndMs >= 10000 && r.postEndMs <= 20000);
});

test('videoTiming: NaN/missing duration -> play-through', () => {
  const r = videoTiming(NaN, seededRng(1));
  assert.equal(r.mode, 'play-through');
});

test('videoTiming: long video -> seek mode, preSkip below targetTime - buffer', () => {
  const rng = seededRng(1);
  const duration = 600; // 10 min
  const r = videoTiming(duration, rng);
  assert.equal(r.mode, 'seek');
  // targetTime is duration - 60..120
  assert.ok(r.targetTimeSec >= duration - 120 && r.targetTimeSec <= duration - 60);
  // preSkipMs must be strictly less than (targetTimeSec - SEEK_BUFFER_SEC) * 1000
  const preSkipSec = r.preSkipMs / 1000;
  assert.ok(preSkipSec >= 60, 'preSkip >= 60 s');
  assert.ok(preSkipSec <= 300, 'preSkip <= 300 s');
  assert.ok(preSkipSec <= r.targetTimeSec - SEEK_BUFFER_SEC,
    'preSkip ' + preSkipSec + ' must be <= targetTime - buffer (' + (r.targetTimeSec - SEEK_BUFFER_SEC) + ')');
  assert.ok(r.postEndMs >= 10000 && r.postEndMs <= 20000);
});

test('videoTiming: medium video where cap < 60 -> play-through fallback', () => {
  // duration where targetTimeSec - SEEK_BUFFER_SEC < 60 forces play-through.
  // Pick duration so targetTime ranges 60..120 -> targetTime - 10 ranges 50..110.
  // randInt with seed 1 will produce some preSkip target. If maxPreSkip < 60 -> play-through.
  // duration 130 -> target ranges 10..70, maxPreSkip ranges 0..60.
  for (let seed = 1; seed <= 20; seed++) {
    const r = videoTiming(180, seededRng(seed));
    // duration 180 exactly is borderline (< MIN_VIDEO_DURATION_FOR_SKIP_SEC), should play-through.
    assert.equal(r.mode, 'play-through');
  }
});

test('videoTiming: cap-fallback at borderline duration where maxPreSkip < 60', () => {
  // duration 185: targetTime = 65..125. maxPreSkip = 55..115. Some seeds will be < 60.
  // We just need to confirm that when maxPreSkip < 60 the helper returns play-through.
  // Construct a synthetic case using a deterministic RNG that produces a specific result.
  // Use a fixed-value RNG forced to choose seekFromEnd=120 so targetTime=65, maxPreSkip=55<60.
  const forcedRng = (function () {
    const seq = [
      0.99, // randInt(rng, 60, 120) -> close to 120 -> 120
    ];
    let i = 0;
    return function () { return seq[i++] || 0; };
  })();
  const r = videoTiming(185, forcedRng);
  assert.equal(r.mode, 'play-through', 'tight cap should force play-through');
});

test('readingDwellMs in [120000, 180000]', () => {
  const rng = seededRng(1);
  for (let i = 0; i < 50; i++) {
    const v = readingDwellMs(rng);
    assert.ok(v >= 120000 && v <= 180000);
  }
});

test('discussionDwellMs in [120000, 180000]', () => {
  const rng = seededRng(1);
  for (let i = 0; i < 50; i++) {
    const v = discussionDwellMs(rng);
    assert.ok(v >= 120000 && v <= 180000);
  }
});

test('quizDwellMs in [120000, 180000]', () => {
  const rng = seededRng(1);
  for (let i = 0; i < 50; i++) {
    const v = quizDwellMs(rng);
    assert.ok(v >= 120000 && v <= 180000);
  }
});

test('interItemGapMs in [8000, 18000]', () => {
  const rng = seededRng(1);
  for (let i = 0; i < 50; i++) {
    const v = interItemGapMs(rng);
    assert.ok(v >= 8000 && v <= 18000);
  }
});

test('scrollStep returns intervalMs in [3000, 8000] and pixels in [200, 500]', () => {
  const rng = seededRng(1);
  for (let i = 0; i < 50; i++) {
    const s = scrollStep(rng);
    assert.ok(s.intervalMs >= 3000 && s.intervalMs <= 8000);
    assert.ok(s.pixels >= 200 && s.pixels <= 500);
  }
});

test('exports RANGES and constants', () => {
  assert.ok(RANGES.videoPreSkipSec);
  assert.equal(MIN_VIDEO_DURATION_FOR_SKIP_SEC, 180);
  assert.equal(SEEK_BUFFER_SEC, 10);
});
```

### Step 2: Run test to verify it fails

Run: `npm test`
Expected: failures from `Cannot find module '../lib/autopilot-timing.js'`. Other ~332 tests still pass.

### Step 3: Implement the timing helpers

Create `lib/autopilot-timing.js`:

```js
// lib/autopilot-timing.js
// Pure RNG-driven timing helpers for the module autopilot. All ranges named.
(function (root) {
  'use strict';

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

  function randInt(rng, lo, hi) {
    // [lo, hi] inclusive
    return Math.floor(rng() * (hi - lo + 1)) + lo;
  }

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

  function readingDwellMs(rng)    { return randInt(rng, RANGES.readingDwellSec[0],    RANGES.readingDwellSec[1])    * 1000; }
  function discussionDwellMs(rng) { return randInt(rng, RANGES.discussionDwellSec[0], RANGES.discussionDwellSec[1]) * 1000; }
  function quizDwellMs(rng)       { return randInt(rng, RANGES.quizDwellSec[0],       RANGES.quizDwellSec[1])       * 1000; }
  function interItemGapMs(rng)    { return randInt(rng, RANGES.interItemGapSec[0],    RANGES.interItemGapSec[1])    * 1000; }

  function scrollStep(rng) {
    return {
      intervalMs: randInt(rng, RANGES.scrollStepIntervalSec[0], RANGES.scrollStepIntervalSec[1]) * 1000,
      pixels:     randInt(rng, RANGES.scrollStepPx[0],          RANGES.scrollStepPx[1]),
    };
  }

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

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.autopilotTiming = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

### Step 4: Run tests to verify they pass

Run: `npm test`
Expected: all tests pass (~344 total: prior + ~12 new).

### Step 5: Commit

```bash
git add lib/autopilot-timing.js tests/autopilot-timing.test.js
git commit -m "feat(autopilot): add timing helpers with named ranges and seek-cap logic"
```

---

## Task 2: Discussion reply pool

**Files:**
- Create: `lib/discussion-replies.js`
- Create: `tests/discussion-replies.test.js`

### Step 1: Write the failing test

Create `tests/discussion-replies.test.js`:

```js
// tests/discussion-replies.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { REPLIES, pickReply } = require('../lib/discussion-replies.js');

function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('REPLIES has exactly 20 entries', () => {
  assert.equal(REPLIES.length, 20);
});

test('every reply is non-empty and short (<=300 chars)', () => {
  for (let i = 0; i < REPLIES.length; i++) {
    const r = REPLIES[i];
    assert.equal(typeof r, 'string');
    assert.ok(r.trim().length > 0, 'reply ' + i + ' is empty');
    assert.ok(r.length <= 300, 'reply ' + i + ' is too long (' + r.length + ' chars)');
  }
});

test('every reply is unique', () => {
  const set = new Set(REPLIES);
  assert.equal(set.size, REPLIES.length);
});

test('pickReply returns a string from the pool', () => {
  const r = pickReply([], seededRng(1));
  assert.ok(REPLIES.indexOf(r) !== -1);
});

test('pickReply excludes entries present in history', () => {
  const history = REPLIES.slice(0, 5);
  const r = pickReply(history, seededRng(1));
  assert.ok(history.indexOf(r) === -1, 'picked reply must not be in history');
});

test('pickReply still returns something if history contains all replies (fallback)', () => {
  const r = pickReply(REPLIES.slice(), seededRng(1));
  assert.ok(typeof r === 'string' && r.length > 0);
});

test('pickReply is deterministic given seed and history', () => {
  const a = pickReply([], seededRng(42));
  const b = pickReply([], seededRng(42));
  assert.equal(a, b);
});
```

### Step 2: Run test to verify it fails

Run: `npm test`
Expected: `Cannot find module '../lib/discussion-replies.js'`.

### Step 3: Implement the pool

Create `lib/discussion-replies.js`:

```js
// lib/discussion-replies.js
// 20 short, topic-agnostic discussion replies + a cooldown-aware picker.
(function (root) {
  'use strict';

  const REPLIES = [
    "This actually clicked for me on the second read. The piece about how the framing shifts depending on context is the part I'm still chewing on.",
    "Useful prompt. I'd push back gently on the implied either/or — most of the real cases I've seen sit in the messy middle.",
    "Quick reaction: the bit on tradeoffs felt right. The part about long-term costs is where I want more evidence.",
    "The example is carrying more of the argument than I noticed at first. That was the part that made the main point click for me.",
    "Honestly the angle here surprised me. I went in expecting one conclusion and ended up somewhere else by the end.",
    "Solid. Worth pausing on the assumption baked into step two — that's where I think the disagreements in the class will land.",
    "Two things stuck. First, the definition is sharper than I remembered. Second, the boundary cases matter more than the central ones.",
    "I like this. It takes a clearer position than I expected, and that makes the tradeoffs easier to see.",
    "I'm not fully sold on the example. It feels cleaner than the situation the conclusion is trying to explain.",
    "Reads true. The part I had to slow down on was the move from observation to recommendation — that step is doing a lot of work.",
    "Nice writeup. I keep coming back to the question of who bears the cost when this is applied at scale — feels underexplored.",
    "Half-agree. The descriptive part is sharp; the prescriptive part loses me when it stops engaging with the obvious alternative.",
    "First take: the framework is useful as a sorting tool, less so as a decision tool. Different jobs.",
    "What I'm taking away: the second-order effects are doing more work in the argument than the first-order ones. That's the part to interrogate.",
    "Worth restating in your own words — when I tried, I noticed the steps don't quite connect the way I assumed on first read.",
    "The edge cases are the strongest part for me. Without them, the main point would feel more conventional.",
    "Reasonable. I'd want to see this stress-tested against the case in week two — the one where the usual heuristic breaks.",
    "Tagging this as one to revisit. The argument is tighter than my initial reaction gave it credit for.",
    "Side note: the terminology overlap with the previous module made this harder to read on the first pass than it needed to be.",
    "Pretty much aligns with what I've been mulling over. The one place I'd press is the move from anecdote to general claim — feels quick.",
  ];

  function pickReply(history, rng) {
    const hist = Array.isArray(history) ? history : [];
    const usable = REPLIES.filter(function (r) { return hist.indexOf(r) === -1; });
    const pool = usable.length > 0 ? usable : REPLIES;
    const idx = Math.floor(rng() * pool.length);
    return pool[idx];
  }

  const api = { REPLIES: REPLIES, pickReply: pickReply };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.discussionReplies = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

### Step 4: Run tests to verify they pass

Run: `npm test`
Expected: all tests pass.

### Step 5: Commit

```bash
git add lib/discussion-replies.js tests/discussion-replies.test.js
git commit -m "feat(autopilot): add 20-reply discussion pool with cooldown picker"
```

---

## Task 3: Autopilot state (storage CRUD + ownership procedure)

**Files:**
- Create: `lib/autopilot-state.js`
- Create: `tests/autopilot-state.test.js`

### Step 1: Write the failing test

Create `tests/autopilot-state.test.js`:

```js
// tests/autopilot-state.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createState,
  defaults,
  HEARTBEAT_TTL_MS,
  RUN_KEY,
  COURSE_LOG_KEY,
} = require('../lib/autopilot-state.js');

function fakeStorage() {
  const store = {};
  return {
    _store: store,
    get: function (keys, cb) {
      const out = {};
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach(function (k) { out[k] = store[k]; });
      cb(out);
    },
    set: function (items, cb) {
      Object.keys(items).forEach(function (k) { store[k] = items[k]; });
      cb && cb();
    },
  };
}

function awaitCb(fn) { return new Promise(function (resolve) { fn(resolve); }); }

test('defaults() returns idle state with sensible settings', () => {
  const d = defaults();
  assert.equal(d.status, 'idle');
  assert.equal(d.cursor, 0);
  assert.deepEqual(d.queue, []);
  assert.equal(d.dwellEndsAt, null);
  assert.deepEqual(d.replyHistory, []);
  assert.equal(d.ownerTabKey, null);
  assert.equal(d.heartbeatAt, 0);
  assert.equal(d.settings.pauseOnUserInput, true);
  assert.equal(d.settings.autoSubmitQuizzes, false);
});

test('load returns defaults when storage empty', async () => {
  const s = createState(fakeStorage());
  const got = await awaitCb(s.load);
  assert.equal(got.status, 'idle');
});

test('save persists state under RUN_KEY', async () => {
  const fake = fakeStorage();
  const s = createState(fake);
  const d = defaults();
  d.status = 'running';
  d.cursor = 3;
  await awaitCb(function (done) { s.save(d, done); });
  assert.equal(fake._store[RUN_KEY].status, 'running');
  assert.equal(fake._store[RUN_KEY].cursor, 3);
});

test('update merges a partial patch into the saved state', async () => {
  const fake = fakeStorage();
  const s = createState(fake);
  const d = defaults();
  d.cursor = 2;
  await awaitCb(function (done) { s.save(d, done); });
  await awaitCb(function (done) { s.update({ status: 'paused' }, done); });
  const got = await awaitCb(s.load);
  assert.equal(got.status, 'paused');
  assert.equal(got.cursor, 2, 'unchanged fields preserved');
});

test('clear restores idle state', async () => {
  const fake = fakeStorage();
  const s = createState(fake);
  const d = defaults();
  d.status = 'running';
  d.queue = [{ id: 'a' }];
  await awaitCb(function (done) { s.save(d, done); });
  await awaitCb(s.clear);
  const got = await awaitCb(s.load);
  assert.equal(got.status, 'idle');
  assert.deepEqual(got.queue, []);
});

test('recordCourseItem appends to per-course log', async () => {
  const fake = fakeStorage();
  const s = createState(fake);
  await awaitCb(function (done) { s.recordCourseItem('cId1', 'item-1', 'video', 'video-done', done); });
  await awaitCb(function (done) { s.recordCourseItem('cId1', 'item-2', 'reading', 'reading-done', done); });
  const log = await awaitCb(s.getCourseLog);
  assert.ok(log.cId1, 'course entry present');
  assert.equal(log.cId1['item-1'].kind, 'video');
  assert.equal(log.cId1['item-1'].outcome, 'video-done');
  assert.equal(log.cId1['item-2'].kind, 'reading');
});

test('acquireOwnership: returns owner when state is unowned', async () => {
  const fake = fakeStorage();
  const s = createState(fake);
  const d = defaults();
  d.status = 'running';
  await awaitCb(function (done) { s.save(d, done); });
  const result = await awaitCb(function (done) {
    s.acquireOwnership('tab-A', Date.now(), done);
  });
  assert.equal(result, 'owner');
  const got = await awaitCb(s.load);
  assert.equal(got.ownerTabKey, 'tab-A');
  assert.ok(got.heartbeatAt > 0);
});

test('acquireOwnership: returns owner when state already owned by this key + fresh', async () => {
  const fake = fakeStorage();
  const s = createState(fake);
  const now = 1_000_000;
  const d = defaults();
  d.status = 'running';
  d.ownerTabKey = 'tab-A';
  d.heartbeatAt = now - 1000; // fresh
  await awaitCb(function (done) { s.save(d, done); });
  const result = await awaitCb(function (done) {
    s.acquireOwnership('tab-A', now, done);
  });
  assert.equal(result, 'owner');
});

test('acquireOwnership: returns foreign-active when another tab is fresh', async () => {
  const fake = fakeStorage();
  const s = createState(fake);
  const now = 1_000_000;
  const d = defaults();
  d.status = 'running';
  d.ownerTabKey = 'tab-A';
  d.heartbeatAt = now - 1000; // fresh
  await awaitCb(function (done) { s.save(d, done); });
  const result = await awaitCb(function (done) {
    s.acquireOwnership('tab-B', now, done);
  });
  assert.equal(result, 'foreign-active');
  const got = await awaitCb(s.load);
  assert.equal(got.ownerTabKey, 'tab-A', 'foreign tab must not overwrite');
});

test('acquireOwnership: returns owner when other tab heartbeat is stale (> TTL)', async () => {
  const fake = fakeStorage();
  const s = createState(fake);
  const now = 1_000_000;
  const d = defaults();
  d.status = 'running';
  d.ownerTabKey = 'tab-A';
  d.heartbeatAt = now - (HEARTBEAT_TTL_MS + 1);
  await awaitCb(function (done) { s.save(d, done); });
  const result = await awaitCb(function (done) {
    s.acquireOwnership('tab-B', now, done);
  });
  assert.equal(result, 'owner');
  const got = await awaitCb(s.load);
  assert.equal(got.ownerTabKey, 'tab-B');
});

test('refreshHeartbeat updates heartbeatAt only when this tab owns', async () => {
  const fake = fakeStorage();
  const s = createState(fake);
  const d = defaults();
  d.status = 'running';
  d.ownerTabKey = 'tab-A';
  d.heartbeatAt = 0;
  await awaitCb(function (done) { s.save(d, done); });
  const did = await awaitCb(function (done) { s.refreshHeartbeat('tab-A', 12345, done); });
  assert.equal(did, true);
  const got = await awaitCb(s.load);
  assert.equal(got.heartbeatAt, 12345);
});

test('refreshHeartbeat is a no-op when this tab is not owner', async () => {
  const fake = fakeStorage();
  const s = createState(fake);
  const d = defaults();
  d.status = 'running';
  d.ownerTabKey = 'tab-A';
  d.heartbeatAt = 0;
  await awaitCb(function (done) { s.save(d, done); });
  const did = await awaitCb(function (done) { s.refreshHeartbeat('tab-B', 12345, done); });
  assert.equal(did, false);
  const got = await awaitCb(s.load);
  assert.equal(got.heartbeatAt, 0, 'non-owner cannot bump heartbeat');
});

test('exports RUN_KEY, COURSE_LOG_KEY, HEARTBEAT_TTL_MS', () => {
  assert.equal(typeof RUN_KEY, 'string');
  assert.equal(typeof COURSE_LOG_KEY, 'string');
  assert.equal(typeof HEARTBEAT_TTL_MS, 'number');
});
```

### Step 2: Run test to verify it fails

Run: `npm test`
Expected: `Cannot find module '../lib/autopilot-state.js'`.

### Step 3: Implement the state module

Create `lib/autopilot-state.js`:

```js
// lib/autopilot-state.js
// chrome.storage.local CRUD + acquireOwnership procedure for the module autopilot.
(function (root) {
  'use strict';

  const RUN_KEY = 'ccp_autopilot_run';
  const COURSE_LOG_KEY = 'ccp_autopilot_course_log';
  const HEARTBEAT_TTL_MS = 30 * 1000;

  function defaults() {
    return {
      status: 'idle',
      courseId: null,
      moduleId: null,
      queue: [],
      cursor: 0,
      dwellEndsAt: null,
      startedAt: 0,
      itemStartedAt: 0,
      history: [],
      replyHistory: [],
      settings: { pauseOnUserInput: true, autoSubmitQuizzes: false },
      heartbeatAt: 0,
      ownerTabKey: null,
    };
  }

  function createState(storage) {
    function load(cb) {
      storage.get([RUN_KEY], function (got) {
        const raw = (got && got[RUN_KEY]) || null;
        if (!raw) { cb(defaults()); return; }
        // Shallow-merge into defaults so newly-added fields don't break older state.
        const d = defaults();
        const merged = Object.assign({}, d, raw);
        merged.settings = Object.assign({}, d.settings, raw.settings || {});
        cb(merged);
      });
    }

    function save(state, cb) {
      const items = {};
      items[RUN_KEY] = state;
      storage.set(items, function () { cb && cb(); });
    }

    function update(patch, cb) {
      load(function (cur) {
        const next = Object.assign({}, cur, patch || {});
        if (patch && patch.settings) {
          next.settings = Object.assign({}, cur.settings, patch.settings);
        }
        save(next, cb);
      });
    }

    function clear(cb) {
      save(defaults(), cb);
    }

    function getCourseLog(cb) {
      storage.get([COURSE_LOG_KEY], function (got) {
        cb((got && got[COURSE_LOG_KEY]) || {});
      });
    }

    function recordCourseItem(courseId, itemId, kind, outcome, cb) {
      getCourseLog(function (log) {
        const next = Object.assign({}, log);
        next[courseId] = Object.assign({}, next[courseId] || {});
        next[courseId][itemId] = { kind: kind, outcome: outcome, at: Date.now() };
        const items = {};
        items[COURSE_LOG_KEY] = next;
        storage.set(items, function () { cb && cb(); });
      });
    }

    function acquireOwnership(myTabKey, now, cb) {
      load(function (cur) {
        const isOwnerAlready = cur.ownerTabKey === myTabKey && (now - cur.heartbeatAt) <= HEARTBEAT_TTL_MS;
        if (isOwnerAlready) { cb('owner'); return; }
        const foreignFresh = cur.ownerTabKey && cur.ownerTabKey !== myTabKey
          && (now - cur.heartbeatAt) <= HEARTBEAT_TTL_MS;
        if (foreignFresh) { cb('foreign-active'); return; }
        // Stale or unowned — claim it.
        const next = Object.assign({}, cur, { ownerTabKey: myTabKey, heartbeatAt: now });
        save(next, function () {
          // Re-read in case of races.
          load(function (after) {
            cb(after.ownerTabKey === myTabKey ? 'owner' : 'foreign-active');
          });
        });
      });
    }

    function refreshHeartbeat(myTabKey, now, cb) {
      load(function (cur) {
        if (cur.ownerTabKey !== myTabKey) { cb(false); return; }
        const next = Object.assign({}, cur, { heartbeatAt: now });
        save(next, function () { cb(true); });
      });
    }

    function chromeStorageOrNull() {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        return {
          get: function (keys, cb) { chrome.storage.local.get(keys, cb); },
          set: function (items, cb) { chrome.storage.local.set(items, cb); },
        };
      }
      return null;
    }

    return {
      load: load,
      save: save,
      update: update,
      clear: clear,
      getCourseLog: getCourseLog,
      recordCourseItem: recordCourseItem,
      acquireOwnership: acquireOwnership,
      refreshHeartbeat: refreshHeartbeat,
      _chromeStorageOrNull: chromeStorageOrNull,
    };
  }

  function chromeStorageOrNull() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      return {
        get: function (keys, cb) { chrome.storage.local.get(keys, cb); },
        set: function (items, cb) { chrome.storage.local.set(items, cb); },
      };
    }
    return null;
  }

  const api = {
    createState: createState,
    defaults: defaults,
    chromeStorageOrNull: chromeStorageOrNull,
    HEARTBEAT_TTL_MS: HEARTBEAT_TTL_MS,
    RUN_KEY: RUN_KEY,
    COURSE_LOG_KEY: COURSE_LOG_KEY,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.autopilotState = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

### Step 4: Run tests to verify they pass

Run: `npm test`
Expected: all tests pass.

### Step 5: Commit

```bash
git add lib/autopilot-state.js tests/autopilot-state.test.js
git commit -m "feat(autopilot): add state CRUD with ownership and heartbeat semantics"
```

---

## Task 4: Module scraper

**Files:**
- Create: `lib/module-scraper.js`
- Create: `tests/module-scraper.test.js`

### Selectors (Coursera, tolerant fallbacks)

- Module sidebar container: `[data-testid="lesson-collection"]`, `.rc-LessonCollection`, `nav[aria-label*="lesson" i]`.
- Item anchors: `a[href*="/learn/"]` inside the container.
- Completion indicator on an item: presence of `[aria-label*="completed" i]`, `[class*="Completed"]`, or an SVG with `class*="check"`.

### URL parsing

Coursera item URLs follow `/learn/<courseSlug>/<itemKind>/<itemId>[/...]`. Item kinds we recognize:

| URL segment | kind |
|---|---|
| `lecture` | `video` |
| `supplement` | `reading` |
| `discussionPrompt` | `discussion` |
| `quiz`, `exam`, `assignment` | `quiz` |
| `peer` | `peer-review` |
| `programming` | `programming` |
| anything else | `other` |

The course slug becomes `courseId`. The module ID — Coursera doesn't expose a clean numeric one for free; use the URL fragment after `/home/week/<n>` if present, else first 8 chars of a hash of the queue ids as a stable identifier.

### Step 1: Write the failing test

Create `tests/module-scraper.test.js`:

```js
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
```

### Step 2: Run test to verify it fails

Run: `npm test`
Expected: `Cannot find module '../lib/module-scraper.js'`.

### Step 3: Implement the scraper

Create `lib/module-scraper.js`:

```js
// lib/module-scraper.js
// Parses the Coursera course-module sidebar into a queue.
(function (root) {
  'use strict';

  const CONTAINER_SELECTORS = [
    '[data-testid="lesson-collection"]',
    '.rc-LessonCollection',
    'nav[aria-label*="lesson" i]',
    '[class*="LessonCollection"]',
  ];

  const COMPLETED_SELECTORS = [
    '[aria-label*="completed" i]',
    '[class*="Completed"]',
    'svg[class*="check" i]',
  ];

  const KIND_BY_SEGMENT = {
    lecture: 'video',
    supplement: 'reading',
    discussionPrompt: 'discussion',
    quiz: 'quiz',
    exam: 'quiz',
    assignment: 'quiz',
    peer: 'peer-review',
    programming: 'programming',
  };

  function firstMatching(root, selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const el = root.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function extractCourseId(url) {
    if (!url) return null;
    const m = String(url).match(/\/learn\/([^/]+)/);
    return m ? m[1] : null;
  }

  function extractItemId(url) {
    if (!url) return null;
    const m = String(url).match(/\/learn\/[^/]+\/([a-zA-Z]+)\/([^/?#]+)/);
    if (!m) return null;
    if (!KIND_BY_SEGMENT[m[1]]) return null;
    return m[2];
  }

  function classifyKind(url) {
    if (!url) return 'other';
    const m = String(url).match(/\/learn\/[^/]+\/([a-zA-Z]+)\//);
    if (!m) return 'other';
    return KIND_BY_SEGMENT[m[1]] || 'other';
  }

  function extractModuleId(url) {
    if (!url) return null;
    const m = String(url).match(/\/home\/week\/(\d+)/);
    return m ? ('week-' + m[1]) : null;
  }

  function isCompleted(anchor) {
    for (let i = 0; i < COMPLETED_SELECTORS.length; i++) {
      if (anchor.querySelector(COMPLETED_SELECTORS[i])) return true;
    }
    return false;
  }

  function textOf(el) {
    return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
  }

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

  const api = {
    scrapeModule: scrapeModule,
    extractCourseId: extractCourseId,
    extractItemId: extractItemId,
    classifyKind: classifyKind,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.moduleScraper = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

### Step 4: Run tests to verify they pass

Run: `npm test`
Expected: all tests pass.

### Step 5: Commit

```bash
git add lib/module-scraper.js tests/module-scraper.test.js
git commit -m "feat(autopilot): add tolerant Coursera module sidebar scraper"
```

---

## Task 5: cleaner.js — stash last cleaned copy

**Files:**
- Modify: `lib/cleaner.js`

### Step 1: Read the existing cleaner module

Read `lib/cleaner.js` to find the function that returns the cleaned text (likely named `cleanCopiedText`). We need to stash its result on `window.ClipboardCleaner.lastCleanedCopy` before returning.

Run: `grep -n "function clean\|exports" lib/cleaner.js`

You should see the top-level `cleanCopiedText` function and the dual-export footer.

### Step 2: Add the stash inside `cleanCopiedText`

Edit `lib/cleaner.js`. Find the existing `cleanCopiedText` function and add ONE statement immediately before its `return` statement so the cleaned text becomes available globally:

```js
  if (typeof root !== 'undefined' && root.ClipboardCleaner) {
    root.ClipboardCleaner.lastCleanedCopy = cleaned;
  }
```

Where `root` is the IIFE parameter that already exists at the top of the file. (If the existing variable is named something else like `self`/`globalThis`, use that — the pattern is to set it on the same global the dual-export uses.)

`cleaned` should be the variable holding the final result string. Inspect the function body to confirm the right local name.

### Step 3: Add a smoke test asserting the global gets set

Create `tests/cleaner-stash.test.js`:

```js
// tests/cleaner-stash.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

// In Node we have no `window`. We attach a stand-in to `globalThis` before
// requiring the module, then assert the module wrote to ClipboardCleaner.lastCleanedCopy.
globalThis.ClipboardCleaner = globalThis.ClipboardCleaner || {};
const cleaner = require('../lib/cleaner.js');

test('cleanCopiedText stashes result on ClipboardCleaner.lastCleanedCopy', () => {
  const input = 'Some sample text to clean.';
  const out = cleaner.cleanCopiedText(input);
  assert.equal(typeof out, 'string');
  assert.equal(globalThis.ClipboardCleaner.lastCleanedCopy, out,
    'last cleaned copy must mirror the function return value');
});
```

If the cleaner's exported function has a different name, adjust the test accordingly — read the existing exports first to confirm. The two assertions must hold regardless of which input you pass.

### Step 4: Run tests

Run: `npm test`
Expected: all tests pass including the new smoke test.

### Step 5: Commit

```bash
git add lib/cleaner.js tests/cleaner-stash.test.js
git commit -m "feat(cleaner): stash last cleaned copy on ClipboardCleaner.lastCleanedCopy"
```

---

## Task 6: Sidebar — Autopilot tab + getAnswerText

**Files:**
- Modify: `lib/sidebar.js`

### Step 1: Add the tab button

In the `HTML` constant tabs row in `lib/sidebar.js`, find the last existing tab button (likely the Lecture Notes tab if Task 5 from the lecture-companion plan was applied, otherwise the Answering for you tab). Add after it:

```js
'<button class="ccp-tab" role="tab" aria-selected="false" data-tab="autopilot">Autopilot</button>' +
```

### Step 2: Add the Autopilot panel

In the same `HTML` constant, find the panel section for the LAST existing tab (the one whose button you placed yours after). Insert the autopilot panel immediately AFTER its `</section>`:

```js
'<section class="ccp-panel" data-panel="autopilot" data-active="false">' +
  '<div class="ccp-autopilot-status" data-role="autopilot-status">Idle</div>' +
  '<div class="ccp-autopilot-current" data-role="autopilot-current"></div>' +
  '<div class="ccp-progress"><div class="ccp-progress-bar" data-role="autopilot-bar"></div></div>' +
  '<div class="ccp-actions">' +
    '<button class="ccp-btn" data-action="autopilot-run">Run autopilot for this module</button>' +
    '<button class="ccp-btn" data-variant="danger" data-action="autopilot-stop" disabled>Stop</button>' +
    '<button class="ccp-btn" data-action="autopilot-resume" hidden>Resume</button>' +
  '</div>' +
  '<div class="ccp-row">' +
    '<label><input type="checkbox" data-role="autopilot-pause-on-input" checked> Pause on keyboard/mouse input</label>' +
  '</div>' +
  '<div class="ccp-row">' +
    '<label><input type="checkbox" data-role="autopilot-auto-submit-quizzes"> Auto-submit quizzes after autofill</label>' +
  '</div>' +
  '<div class="ccp-autopilot-log" data-role="autopilot-log"></div>' +
  '<div class="ccp-status" data-role="autopilot-banner"></div>' +
'</section>' +
```

### Step 3: Wire the tab in `mount()`

Find the `mount()` function and the existing list of `wire*();` calls. Add `wireAutopilot();` after the last existing call (e.g. after `wireLecture();` or `wireAnswer();`).

### Step 4: Add the autopilot helpers immediately before the `const api = { ... }` line

```js
  let _autopilotHandlers = {
    onRun: null,
    onStop: null,
    onResume: null,
    onSettingsChange: null,
  };

  function setAutopilotStatus(text, meta) {
    if (!shadow) return;
    const s = shadow.querySelector('[data-role="autopilot-status"]');
    if (s) s.textContent = text || '';
    if (meta && meta.current) {
      const c = shadow.querySelector('[data-role="autopilot-current"]');
      if (c) c.textContent = meta.current;
    }
    if (meta && typeof meta.progressPct === 'number') {
      const bar = shadow.querySelector('[data-role="autopilot-bar"]');
      if (bar) bar.style.width = Math.max(0, Math.min(100, meta.progressPct)) + '%';
    }
  }

  function appendAutopilotLog(entry) {
    if (!shadow) return;
    const box = shadow.querySelector('[data-role="autopilot-log"]');
    if (!box) return;
    const line = (shadow.ownerDocument || document).createElement('div');
    line.className = 'ccp-autopilot-log-line';
    line.textContent = entry || '';
    box.appendChild(line);
    // Cap at 20 entries.
    while (box.children.length > 20) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  function setAutopilotPaused(isPaused, bannerText) {
    if (!shadow) return;
    const resumeBtn = shadow.querySelector('[data-action="autopilot-resume"]');
    const stopBtn   = shadow.querySelector('[data-action="autopilot-stop"]');
    const runBtn    = shadow.querySelector('[data-action="autopilot-run"]');
    const banner    = shadow.querySelector('[data-role="autopilot-banner"]');
    if (resumeBtn) resumeBtn.hidden = !isPaused;
    if (stopBtn)   stopBtn.disabled = !isPaused;
    if (runBtn)    runBtn.disabled = isPaused;
    if (banner)    banner.textContent = bannerText || '';
  }

  function getAnswerText() {
    if (!shadow) return '';
    const ta = shadow.querySelector('[data-role="answer-text"]');
    return ta ? (ta.value || '') : '';
  }

  function setAutopilotHandlers(handlers) {
    _autopilotHandlers = Object.assign({}, _autopilotHandlers, handlers || {});
  }

  function wireAutopilot() {
    const run    = shadow.querySelector('[data-action="autopilot-run"]');
    const stop   = shadow.querySelector('[data-action="autopilot-stop"]');
    const resume = shadow.querySelector('[data-action="autopilot-resume"]');
    const pi     = shadow.querySelector('[data-role="autopilot-pause-on-input"]');
    const as     = shadow.querySelector('[data-role="autopilot-auto-submit-quizzes"]');
    if (run) {
      run.addEventListener('click', function () {
        if (_autopilotHandlers.onRun) _autopilotHandlers.onRun();
      });
    }
    if (stop) {
      stop.addEventListener('click', function () {
        if (_autopilotHandlers.onStop) _autopilotHandlers.onStop();
      });
    }
    if (resume) {
      resume.addEventListener('click', function () {
        if (_autopilotHandlers.onResume) _autopilotHandlers.onResume();
      });
    }
    function emitSettings() {
      if (_autopilotHandlers.onSettingsChange) {
        _autopilotHandlers.onSettingsChange({
          pauseOnUserInput: !!(pi && pi.checked),
          autoSubmitQuizzes: !!(as && as.checked),
        });
      }
    }
    if (pi) pi.addEventListener('change', emitSettings);
    if (as) as.addEventListener('change', emitSettings);
  }

  function setAutopilotButtonsRunning(isRunning) {
    if (!shadow) return;
    const run  = shadow.querySelector('[data-action="autopilot-run"]');
    const stop = shadow.querySelector('[data-action="autopilot-stop"]');
    if (run)  run.disabled  = isRunning;
    if (stop) stop.disabled = !isRunning;
  }
```

### Step 5: Expose the new functions in `api`

Find the existing `const api = { ... };` line and extend it. The exact final shape depends on what's already there from prior plans; add these keys (preserving everything currently present):

```js
    setAutopilotStatus: setAutopilotStatus,
    appendAutopilotLog: appendAutopilotLog,
    setAutopilotPaused: setAutopilotPaused,
    setAutopilotButtonsRunning: setAutopilotButtonsRunning,
    setAutopilotHandlers: setAutopilotHandlers,
    getAnswerText: getAnswerText,
```

### Step 6: Run all tests

Run: `npm test`
Expected: still passing (no new tests; sidebar has no dedicated test file).

### Step 7: Commit

```bash
git add lib/sidebar.js
git commit -m "feat(sidebar): add Autopilot tab and getAnswerText accessor"
```

---

## Task 7: Item handlers — scaffolding + reading + discussion

**Files:**
- Create: `lib/item-handlers.js`
- Create: `tests/item-handlers.test.js`

This task implements the shared structure (`createHandlers`, `cancellableSleep`, `jitteredScroll`, `findFirstButton`) plus the **reading** and **discussion** handlers. The video and quiz/fallback handlers are appended in Tasks 8 and 9.

### Step 1: Write the failing tests

Create `tests/item-handlers.test.js`:

```js
// tests/item-handlers.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createHandlers, cancellableSleep } = require('../lib/item-handlers.js');

function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function mkSignal() {
  const listeners = [];
  return {
    aborted: false,
    addEventListener: function (k, fn) { if (k === 'abort') listeners.push(fn); },
    removeEventListener: function () {},
    _abort: function () { this.aborted = true; listeners.forEach(function (fn) { fn(); }); },
  };
}

function makeFakeDoc(html, url) {
  const j = new JSDOM('<!doctype html><html><body>' + html + '</body></html>',
    { url: url || 'https://www.coursera.org/learn/x/supplement/r1/reading-a' });
  return j.window.document;
}

test('cancellableSleep resolves after ms and is cancellable via signal', async () => {
  const t0 = Date.now();
  await cancellableSleep(20);
  assert.ok(Date.now() - t0 >= 20);

  const sig = mkSignal();
  let rejected = false;
  const p = cancellableSleep(10000, sig).catch(function () { rejected = true; });
  sig._abort();
  await p;
  assert.equal(rejected, true);
});

test('reading handler: dwells, optionally clicks Mark as completed, resolves', async () => {
  const doc = makeFakeDoc(
    '<article data-testid="reading"><p>' + 'word '.repeat(2000) + '</p></article>' +
    '<button aria-label="Mark as completed">Mark complete</button>'
  );
  // Fake sleep that resolves immediately so the test doesn't block 2-3 minutes.
  const sleeps = [];
  const sleep = function (ms) { sleeps.push(ms); return Promise.resolve(); };
  const scrolled = [];
  const scroll = function (container, opts) { scrolled.push({ container: !!container, opts: opts }); return Promise.resolve(); };
  const rng = seededRng(1);
  const handlers = createHandlers({
    sleep: sleep,
    jitteredScroll: scroll,
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
  });
  let markedClicked = false;
  const markBtn = doc.querySelector('button[aria-label="Mark as completed"]');
  const orig = markBtn.click.bind(markBtn);
  markBtn.click = function () { markedClicked = true; orig(); };
  const out = await handlers.reading({ doc: doc, item: { id: 'r1', kind: 'reading' }, rng: rng, signal: mkSignal() });
  assert.ok(scrolled.length > 0, 'should have scrolled');
  assert.equal(markedClicked, true, 'should click Mark as completed when present');
  assert.equal(out.outcome, 'reading-done');
});

test('reading handler: resolves with reading-auto when no Mark-complete button', async () => {
  const doc = makeFakeDoc('<article data-testid="reading"><p>Text.</p></article>');
  const sleep = function () { return Promise.resolve(); };
  const scroll = function () { return Promise.resolve(); };
  const handlers = createHandlers({
    sleep: sleep,
    jitteredScroll: scroll,
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
  });
  const out = await handlers.reading({ doc: doc, item: { id: 'r1', kind: 'reading' }, rng: seededRng(1), signal: mkSignal() });
  assert.equal(out.outcome, 'reading-auto');
});

test('discussion handler: types reply via typingEngine + injector, submits, returns reply text', async () => {
  const doc = makeFakeDoc(
    '<div data-testid="discussion-thread"><div>existing post</div></div>' +
    '<textarea data-role="discussion-reply" data-testid="reply-input"></textarea>' +
    '<button data-testid="submit-reply">Reply</button>',
    'https://www.coursera.org/learn/x/discussionPrompt/d1/prompt'
  );
  const sleep = function () { return Promise.resolve(); };
  const scroll = function () { return Promise.resolve(); };

  // Fake TypingEngine that just writes the text into the target.
  let started = false;
  let typedText = null;
  const fakeEngine = {
    TypingEngine: function FakeEngine() {
      this.start = function (opts) {
        started = true;
        typedText = opts.text;
        opts.target.value = opts.text;
        opts.onDone && opts.onDone();
      };
      this.stop = function () {};
    },
  };
  const fakeInjector = {
    insertOrBackspace: function () {},
    isEditable: function () { return true; },
  };
  let submitted = false;
  const submitBtn = doc.querySelector('[data-testid="submit-reply"]');
  submitBtn.click = function () { submitted = true; };

  const handlers = createHandlers({
    sleep: sleep,
    jitteredScroll: scroll,
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
    typingEngine: fakeEngine,
    typingInjector: fakeInjector,
  });
  const out = await handlers.discussion({
    doc: doc,
    item: { id: 'd1', kind: 'discussion' },
    rng: seededRng(1),
    signal: mkSignal(),
    replyHistory: [],
  });
  assert.equal(started, true, 'typing engine should have started');
  assert.ok(typedText && typedText.length > 0, 'should have typed some text');
  assert.equal(submitted, true, 'should have clicked the submit button');
  assert.equal(out.outcome, 'discussion-posted');
  assert.equal(out.usedReply, typedText, 'usedReply should match typed text');
});

test('discussion handler: respects replyHistory cooldown', async () => {
  const doc = makeFakeDoc(
    '<textarea data-testid="reply-input"></textarea>' +
    '<button data-testid="submit-reply">Reply</button>'
  );
  const { REPLIES } = require('../lib/discussion-replies.js');
  const history = REPLIES.slice(0, 5);
  const sleep = function () { return Promise.resolve(); };
  const scroll = function () { return Promise.resolve(); };
  const fakeEngine = {
    TypingEngine: function () {
      this.start = function (opts) { opts.target.value = opts.text; opts.onDone && opts.onDone(); };
      this.stop = function () {};
    },
  };
  const fakeInjector = { insertOrBackspace: function () {}, isEditable: function () { return true; } };
  const submitBtn = doc.querySelector('[data-testid="submit-reply"]');
  submitBtn.click = function () {};
  const handlers = createHandlers({
    sleep: sleep,
    jitteredScroll: scroll,
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
    typingEngine: fakeEngine,
    typingInjector: fakeInjector,
  });
  const out = await handlers.discussion({
    doc: doc, item: { id: 'd1', kind: 'discussion' },
    rng: seededRng(7), signal: mkSignal(), replyHistory: history,
  });
  assert.ok(history.indexOf(out.usedReply) === -1, 'picked reply must not be in cooldown history');
});
```

### Step 2: Run tests to verify they fail

Run: `npm test`
Expected: `Cannot find module '../lib/item-handlers.js'`.

### Step 3: Write the scaffolding + reading + discussion

Create `lib/item-handlers.js`:

```js
// lib/item-handlers.js
// Per-kind item handlers for the module autopilot.
// Pure logic with dependency-injected sleep/scroll/typing.
(function (root) {
  'use strict';

  function cancellableSleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      const t = setTimeout(function () { resolve(); }, ms);
      if (signal) {
        const onAbort = function () { clearTimeout(t); reject(new Error('aborted')); };
        if (signal.aborted) { clearTimeout(t); reject(new Error('aborted')); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  const READING_SELECTORS = [
    '[data-testid="reading"]',
    '.rc-Reading',
    'article',
    'main',
  ];

  const MARK_COMPLETE_SELECTORS = [
    'button[aria-label*="mark as completed" i]',
    'button[aria-label*="completed" i]',
    'button[data-testid*="mark" i][data-testid*="complete" i]',
  ];

  const REPLY_INPUT_SELECTORS = [
    '[data-testid="reply-input"]',
    '[data-role="discussion-reply"]',
    'textarea[name*="reply" i]',
    'div[contenteditable="true"]',
  ];

  const REPLY_SUBMIT_SELECTORS = [
    '[data-testid="submit-reply"]',
    'button[type="submit"]',
    'button[aria-label*="reply" i]',
  ];

  function firstMatching(doc, selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const el = doc.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function defaultJitteredScroll(container, opts) {
    // No-op scroller used as a fallback. The autopilot controller injects a real one.
    return Promise.resolve();
  }

  function createHandlers(deps) {
    const sleep = (deps && deps.sleep) || cancellableSleep;
    const jitteredScroll = (deps && deps.jitteredScroll) || defaultJitteredScroll;
    const timing = deps && deps.timing;
    const replies = deps && deps.replies;
    const typingEngine = deps && deps.typingEngine;
    const typingInjector = deps && deps.typingInjector;

    async function reading(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const totalMs = timing.readingDwellMs(rng);
      const container = firstMatching(doc, READING_SELECTORS) || doc.body;
      // Use the jittered scroll for the entire dwell budget.
      await jitteredScroll(container, { totalMs: totalMs, rng: rng, signal: signal });
      const btn = firstMatching(doc, MARK_COMPLETE_SELECTORS);
      if (btn) {
        try { btn.click(); } catch (_) { /* ignore */ }
        return { outcome: 'reading-done' };
      }
      return { outcome: 'reading-auto' };
    }

    async function discussion(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const history = Array.isArray(ctx.replyHistory) ? ctx.replyHistory : [];
      const totalMs = timing.discussionDwellMs(rng);
      const threadEl = doc.querySelector('[data-testid="discussion-thread"]') || doc.body;
      await jitteredScroll(threadEl, { totalMs: totalMs, rng: rng, signal: signal });
      const replyEl = firstMatching(doc, REPLY_INPUT_SELECTORS);
      if (!replyEl) {
        return { outcome: 'discussion-skipped-no-input' };
      }
      const text = replies.pickReply(history, rng);
      await new Promise(function (resolve, reject) {
        if (typingEngine && typingEngine.TypingEngine && typingInjector) {
          const engine = new typingEngine.TypingEngine();
          engine.start({
            text: text,
            target: replyEl,
            profile: 'Balanced Natural',
            speed: 'Normal',
            simulateTypos: false,
            onTick: function (ev) { typingInjector.insertOrBackspace(replyEl, ev); },
            onDone: function () { resolve(); },
          });
          if (signal && signal.addEventListener) {
            signal.addEventListener('abort', function () { try { engine.stop(); } catch (_) {} reject(new Error('aborted')); }, { once: true });
          }
        } else {
          // Fallback: direct assignment.
          if ('value' in replyEl) replyEl.value = text;
          else replyEl.textContent = text;
          resolve();
        }
      });
      const submitBtn = firstMatching(doc, REPLY_SUBMIT_SELECTORS);
      if (submitBtn) {
        try { submitBtn.click(); } catch (_) { /* ignore */ }
      }
      return { outcome: 'discussion-posted', usedReply: text };
    }

    return {
      reading: reading,
      discussion: discussion,
      // video and fallback are appended in later tasks.
    };
  }

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

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.itemHandlers = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

### Step 4: Run tests to verify they pass

Run: `npm test`
Expected: all tests pass.

### Step 5: Commit

```bash
git add lib/item-handlers.js tests/item-handlers.test.js
git commit -m "feat(autopilot): add item handlers scaffolding with reading + discussion"
```

---

## Task 8: Item handlers — append video handler

**Files:**
- Modify: `lib/item-handlers.js` (append video handler to the `createHandlers` factory)
- Modify: `tests/item-handlers.test.js` (append video tests)

### Step 1: Append the failing tests

Append to `tests/item-handlers.test.js` (after existing tests, before file end):

```js
test('video handler (short video): plays through, waits for ended, post-end dwell, resolves', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><video></video></body>',
    { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' }
  ).window.document;
  const v = doc.querySelector('video');
  // Stub the duration getter — jsdom returns NaN.
  Object.defineProperty(v, 'duration', { configurable: true, get: function () { return 60; } });
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
  const sig = (function () {
    const listeners = [];
    return { aborted: false, addEventListener: function (k, fn) { if (k === 'abort') listeners.push(fn); }, removeEventListener: function () {}, _abort: function () { this.aborted = true; listeners.forEach(function (fn) { fn(); }); } };
  })();
  const p = handlers.video({ doc: doc, item: { id: 'v1', kind: 'video' }, rng: seededRng(1), signal: sig });
  // Let the handler register its 'ended' listener before we fire it.
  await new Promise(function (r) { setTimeout(r, 0); });
  v.dispatchEvent(new doc.defaultView.Event('ended'));
  const out = await p;
  assert.equal(out.outcome, 'video-done');
  assert.equal(out.mode, 'play-through');
  assert.ok(sleeps.length >= 1, 'should have post-end dwell');
  // No seek for play-through mode.
});

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
  // Sleep was awaited inside the handler; now the seek should already have happened.
  assert.ok(seekedTo !== null, 'currentTime should have been set');
  // Now fire ended.
  v.dispatchEvent(new doc.defaultView.Event('ended'));
  const out = await p;
  assert.equal(out.outcome, 'video-done');
  assert.equal(out.mode, 'seek');
  // Target was in (duration - 120) .. (duration - 60).
  assert.ok(seekedTo >= 480 && seekedTo <= 540,
    'seekedTo ' + seekedTo + ' should be in [480, 540]');
});

test('video handler: aborts mid-flight on signal abort', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><video></video></body>'
  ).window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { configurable: true, get: function () { return 600; } });
  Object.defineProperty(v, 'currentTime', { configurable: true, get: function () { return 0; }, set: function () {} });
  v.play = function () {};
  v.pause = function () {};

  // sleep that returns a never-resolving promise unless aborted.
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

### Step 2: Run tests to verify the video tests fail

Run: `npm test`
Expected: 3 failures (`handlers.video is not a function`).

### Step 3: Append the video handler to `lib/item-handlers.js`

Inside the `createHandlers` factory, append this `async function video(ctx)` BEFORE the `return { reading: reading, discussion: discussion };` line, and update the return:

```js
    function waitForEvent(target, event, signal) {
      return new Promise(function (resolve, reject) {
        const onFire = function () {
          target.removeEventListener(event, onFire);
          resolve();
        };
        target.addEventListener(event, onFire);
        if (signal && signal.addEventListener) {
          signal.addEventListener('abort', function () {
            target.removeEventListener(event, onFire);
            reject(new Error('aborted'));
          }, { once: true });
        }
      });
    }

    async function video(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const v = doc.querySelector('video');
      if (!v) { return { outcome: 'video-no-element' }; }
      const t = timing.videoTiming(v.duration, rng);
      try { v.play(); } catch (_) { /* play() may reject without user gesture */ }
      if (t.mode === 'seek') {
        await sleep(t.preSkipMs, signal);
        try { v.currentTime = t.targetTimeSec; } catch (_) { /* read-only in some envs */ }
      }
      await waitForEvent(v, 'ended', signal);
      await sleep(t.postEndMs, signal);
      return { outcome: 'video-done', mode: t.mode };
    }
```

Then update the return at the bottom of `createHandlers`:

```js
    return {
      reading: reading,
      discussion: discussion,
      video: video,
    };
```

### Step 4: Run tests

Run: `npm test`
Expected: all tests pass.

### Step 5: Commit

```bash
git add lib/item-handlers.js tests/item-handlers.test.js
git commit -m "feat(autopilot): add video handler with pre-skip dwell and seek-cap fallback"
```

---

## Task 9: Item handlers — append quiz/fallback handler

**Files:**
- Modify: `lib/item-handlers.js` (append `fallback` handler)
- Modify: `tests/item-handlers.test.js` (append fallback tests)

The fallback handler is what runs for quizzes / peer-review / programming / other kinds. It pulls an answer text from `getAnswerText()` → `lastCleanedCopy` → pause+prompt.

### Step 1: Append the failing tests

Append to `tests/item-handlers.test.js`:

```js
test('fallback handler: pauses when no answer text available', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><div data-testid="quiz">Quiz body</div></body>',
    { url: 'https://www.coursera.org/learn/x/quiz/q1' }
  ).window.document;
  const sleep = function () { return Promise.resolve(); };
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: sleep,
    jitteredScroll: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
    answerApplier: { applyAnswers: function () { return { selected: 0, filled: 0 }; } },
  });
  const out = await handlers.fallback({
    doc: doc, item: { id: 'q1', kind: 'quiz' },
    rng: seededRng(1), signal: { aborted: false, addEventListener: function () {} },
    getAnswerText: function () { return ''; },
    getLastCleanedCopy: function () { return null; },
    autoSubmitQuizzes: false,
  });
  assert.equal(out.outcome, 'pause-needed-no-answer');
});

test('fallback handler: applies answer and resolves when something fills', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><div data-testid="quiz">Quiz body</div></body>'
  ).window.document;
  const calls = [];
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
    answerApplier: {
      applyAnswers: function (raw, body, opts) {
        calls.push({ raw: raw, hasBody: !!body, opts: opts });
        return { selected: 2, filled: 0 };
      },
    },
  });
  const out = await handlers.fallback({
    doc: doc, item: { id: 'q1', kind: 'quiz' },
    rng: seededRng(1), signal: { aborted: false, addEventListener: function () {} },
    getAnswerText: function () { return 'A and C'; },
    getLastCleanedCopy: function () { return null; },
    autoSubmitQuizzes: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].raw, 'A and C');
  assert.equal(out.outcome, 'quiz-filled-paused-for-review');
});

test('fallback handler: uses lastCleanedCopy when sidebar text is empty', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><div data-testid="quiz">Quiz body</div></body>'
  ).window.document;
  let usedRaw = null;
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
    answerApplier: { applyAnswers: function (raw) { usedRaw = raw; return { selected: 1, filled: 0 }; } },
  });
  const out = await handlers.fallback({
    doc: doc, item: { id: 'q1', kind: 'quiz' },
    rng: seededRng(1), signal: { aborted: false, addEventListener: function () {} },
    getAnswerText: function () { return ''; },
    getLastCleanedCopy: function () { return 'fallback copy text'; },
    autoSubmitQuizzes: false,
  });
  assert.equal(usedRaw, 'fallback copy text');
  assert.equal(out.outcome, 'quiz-filled-paused-for-review');
});

test('fallback handler: clicks submit when autoSubmitQuizzes ON and applier filled something', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><div data-testid="quiz">Quiz</div>' +
    '<button type="submit" data-testid="submit">Submit</button></body>'
  ).window.document;
  const submitBtn = doc.querySelector('[data-testid="submit"]');
  let submitClicked = false;
  submitBtn.click = function () { submitClicked = true; };

  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
    answerApplier: { applyAnswers: function () { return { selected: 1, filled: 0 }; } },
  });
  const out = await handlers.fallback({
    doc: doc, item: { id: 'q1', kind: 'quiz' },
    rng: seededRng(1), signal: { aborted: false, addEventListener: function () {} },
    getAnswerText: function () { return 'A'; },
    getLastCleanedCopy: function () { return null; },
    autoSubmitQuizzes: true,
  });
  assert.equal(submitClicked, true);
  assert.equal(out.outcome, 'quiz-submitted');
});

test('fallback handler: pauses when applier returns selected=0 filled=0', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><div data-testid="quiz">Quiz</div></body>'
  ).window.document;
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
    answerApplier: { applyAnswers: function () { return { selected: 0, filled: 0 }; } },
  });
  const out = await handlers.fallback({
    doc: doc, item: { id: 'q1', kind: 'quiz' },
    rng: seededRng(1), signal: { aborted: false, addEventListener: function () {} },
    getAnswerText: function () { return 'no match'; },
    getLastCleanedCopy: function () { return null; },
    autoSubmitQuizzes: true,
  });
  assert.equal(out.outcome, 'pause-needed-no-match');
});
```

### Step 2: Run tests

Run: `npm test`
Expected: 5 failures (`handlers.fallback is not a function`).

### Step 3: Append the fallback handler to `lib/item-handlers.js`

Inside `createHandlers`, append before the `return { ... }`:

```js
    const SUBMIT_SELECTORS = [
      '[data-testid="submit"]',
      'button[type="submit"]',
    ];

    async function fallback(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const getAnswerText = ctx.getAnswerText || function () { return ''; };
      const getLastCleanedCopy = ctx.getLastCleanedCopy || function () { return null; };
      const autoSubmit = !!ctx.autoSubmitQuizzes;
      const applier = deps && deps.answerApplier;
      if (!applier || typeof applier.applyAnswers !== 'function') {
        return { outcome: 'pause-needed-no-applier' };
      }
      const raw = (getAnswerText() || '').trim()
        || (getLastCleanedCopy && (getLastCleanedCopy() || ''))
        || '';
      if (!raw) {
        return { outcome: 'pause-needed-no-answer' };
      }
      const summary = applier.applyAnswers(raw, doc.body, {}) || { selected: 0, filled: 0 };
      const did = (summary.selected || 0) + (summary.filled || 0);
      if (did === 0) {
        return { outcome: 'pause-needed-no-match' };
      }
      await sleep(timing.quizDwellMs(rng), signal);
      if (!autoSubmit) {
        return { outcome: 'quiz-filled-paused-for-review' };
      }
      const submitBtn = firstMatching(doc, SUBMIT_SELECTORS);
      if (!submitBtn) {
        return { outcome: 'quiz-filled-no-submit-button' };
      }
      try { submitBtn.click(); } catch (_) { /* ignore */ }
      return { outcome: 'quiz-submitted' };
    }
```

Update the return at the end of `createHandlers`:

```js
    return {
      reading: reading,
      discussion: discussion,
      video: video,
      fallback: fallback,
    };
```

### Step 4: Run tests

Run: `npm test`
Expected: all tests pass.

### Step 5: Commit

```bash
git add lib/item-handlers.js tests/item-handlers.test.js
git commit -m "feat(autopilot): add quiz/fallback handler with applyAnswers integration"
```

---

## Task 10: module-autopilot controller

**Files:**
- Create: `lib/module-autopilot.js`
- Create: `tests/module-autopilot.test.js`

The controller is the orchestrator. It exposes `createAutopilot(opts)` returning `{ start, stop, pause, resume, bootIfRunning, destroy }`. Key responsibilities:
- Build the queue via `module-scraper`, save state, navigate to first item.
- On every page load (`bootIfRunning()`), acquire ownership, then dispatch the appropriate handler for the current item.
- Refresh heartbeat every 5 s while running.
- React to pause triggers (user input, visibility, manual stop).
- Advance cursor after each item; navigate via SPA click on the next item's sidebar anchor.

### Step 1: Write the failing tests

Create `tests/module-autopilot.test.js`:

```js
// tests/module-autopilot.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createAutopilot, generateTabKey } = require('../lib/module-autopilot.js');
const stateMod = require('../lib/autopilot-state.js');

function seededRng(seed) {
  let s = seed >>> 0;
  return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

function fakeStorage() {
  const store = {};
  return {
    _store: store,
    get: function (keys, cb) {
      const out = {};
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach(function (k) { out[k] = store[k]; });
      cb(out);
    },
    set: function (items, cb) {
      Object.keys(items).forEach(function (k) { store[k] = items[k]; });
      cb && cb();
    },
  };
}

function makePage(html, url) {
  return new JSDOM(
    '<!doctype html><html><body>' + html + '</body></html>',
    { url: url || 'https://www.coursera.org/learn/x/lecture/v1/intro' }
  );
}

function mkFakeHandlers() {
  const calls = [];
  return {
    calls: calls,
    video:      function (ctx) { calls.push({ kind: 'video', id: ctx.item.id }); return Promise.resolve({ outcome: 'video-done', mode: 'play-through' }); },
    reading:    function (ctx) { calls.push({ kind: 'reading', id: ctx.item.id }); return Promise.resolve({ outcome: 'reading-done' }); },
    discussion: function (ctx) { calls.push({ kind: 'discussion', id: ctx.item.id }); return Promise.resolve({ outcome: 'discussion-posted', usedReply: 'r' }); },
    fallback:   function (ctx) { calls.push({ kind: 'fallback', id: ctx.item.id }); return Promise.resolve({ outcome: 'quiz-filled-paused-for-review' }); },
  };
}

const MODULE_HTML =
  '<div data-testid="lesson-collection">' +
    '<a href="/learn/x/lecture/v1/intro">Intro Video</a>' +
    '<a href="/learn/x/supplement/r1/reading">Reading</a>' +
    '<a href="/learn/x/discussionPrompt/d1/prompt">Discuss</a>' +
  '</div>';

test('generateTabKey produces a non-empty string per call', () => {
  const a = generateTabKey();
  const b = generateTabKey();
  assert.equal(typeof a, 'string');
  assert.ok(a.length > 0);
  assert.notEqual(a, b);
});

test('start: scrapes the module, saves running state, navigates to first item', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/home/week/1');
  const storage = fakeStorage();
  const navTargets = [];
  const handlers = mkFakeHandlers();
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
  const got = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(got.status, 'running');
  assert.equal(got.queue.length, 3);
  assert.equal(got.cursor, 0);
  assert.equal(got.ownerTabKey, 'tab-1');
  assert.equal(navTargets.length, 1);
  assert.ok(navTargets[0].indexOf('/lecture/v1') !== -1);
});

test('bootIfRunning: returns when status is idle', async () => {
  const j = makePage(MODULE_HTML);
  const storage = fakeStorage();
  const handlers = mkFakeHandlers();
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  const ran = await ap.bootIfRunning();
  assert.equal(ran, false);
  assert.equal(handlers.calls.length, 0);
});

test('bootIfRunning: foreign-active does not mutate shared state', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  // Pre-seed state owned by another tab, fresh heartbeat.
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [{ id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' }];
  d.cursor = 0;
  d.ownerTabKey = 'tab-A';
  d.heartbeatAt = 1_000_000 - 1000; // fresh
  await new Promise(function (r) {
    const items = {}; items[stateMod.RUN_KEY] = d; storage.set(items, r);
  });
  const handlers = mkFakeHandlers();
  let bannerText = '';
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-B', rng: seededRng(1),
    navigate: function () { return Promise.resolve(); },
    sidebar: {
      setAutopilotStatus: function () {}, appendAutopilotLog: function () {},
      setAutopilotPaused: function (paused, text) { bannerText = text || bannerText; },
      setAutopilotButtonsRunning: function () {},
      getAnswerText: function () { return ''; },
    },
  });
  const ran = await ap.bootIfRunning();
  assert.equal(ran, false);
  assert.equal(handlers.calls.length, 0);
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.ownerTabKey, 'tab-A', 'foreign tab must not have taken ownership');
  assert.equal(after.status, 'running', 'status untouched');
  assert.ok(bannerText.toLowerCase().indexOf('another tab') !== -1 || bannerText.length > 0,
    'should show some banner about another tab');
});

test('bootIfRunning: runs current item handler then advances cursor and navigates', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' },
    { id: 'r1', kind: 'reading', url: '/learn/x/supplement/r1/reading', title: 'Reading' },
  ];
  d.cursor = 0;
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkFakeHandlers();
  const navTargets = [];
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function (url) { navTargets.push(url); return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  const ran = await ap.bootIfRunning();
  assert.equal(ran, true);
  assert.equal(handlers.calls.length, 1);
  assert.equal(handlers.calls[0].kind, 'video');
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.cursor, 1);
  assert.equal(after.status, 'running');
  assert.ok(navTargets[0].indexOf('/supplement/r1') !== -1, 'should navigate to next queue item');
});

test('bootIfRunning: clears state when cursor reaches end after handler completes', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [{ id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' }];
  d.cursor = 0;
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkFakeHandlers();
  const navTargets = [];
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function (url) { navTargets.push(url); return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.bootIfRunning();
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.status, 'idle');
  assert.equal(navTargets.length, 0, 'no nav when run completes');
});

test('resume: flips paused -> running and re-enters boot flow', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'paused';
  d.courseId = 'x';
  d.queue = [{ id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' }];
  d.cursor = 0;
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkFakeHandlers();
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.resume();
  assert.equal(handlers.calls.length, 1);
});

test('stop: clears state and stops the run', async () => {
  const j = makePage(MODULE_HTML);
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [{ id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' }];
  d.ownerTabKey = 'tab-1';
  d.heartbeatAt = 1_000_000;
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: mkFakeHandlers(),
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.stop();
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.status, 'idle');
});

test('different-course tab: shows passive banner, does not run, does not mutate shared state', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/other-course/lecture/zz/x');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x'; // different from current URL course
  d.queue = [{ id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' }];
  d.ownerTabKey = 'tab-A';
  d.heartbeatAt = 1_000_000 - 1000;
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkFakeHandlers();
  let bannerSeen = '';
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-B', rng: seededRng(1),
    navigate: function () { return Promise.resolve(); },
    sidebar: {
      setAutopilotStatus: function () {}, appendAutopilotLog: function () {},
      setAutopilotPaused: function (paused, text) { bannerSeen = text || bannerSeen; },
      setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; },
    },
  });
  const ran = await ap.bootIfRunning();
  assert.equal(ran, false);
  assert.equal(handlers.calls.length, 0);
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.ownerTabKey, 'tab-A');
  assert.ok(bannerSeen.length > 0);
});

test('bootIfRunning: writes per-course log entry after successful handler', async () => {
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
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.bootIfRunning();
  const log = await new Promise(function (r) { storage.get([stateMod.COURSE_LOG_KEY], function (g) { r(g[stateMod.COURSE_LOG_KEY]); }); });
  assert.ok(log && log.x && log.x.v1, 'course log should have v1 entry');
  assert.equal(log.x.v1.kind, 'video');
  assert.equal(log.x.v1.outcome, 'video-done');
});

test('pause: flips running -> paused and releases ownership', async () => {
  const j = makePage(MODULE_HTML);
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [{ id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' }];
  d.ownerTabKey = 'tab-1';
  d.heartbeatAt = 1_000_000;
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: mkFakeHandlers(),
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.pause('test reason');
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.status, 'paused');
  assert.equal(after.ownerTabKey, null);
});
```

### Step 2: Run tests to verify failure

Run: `npm test`
Expected: `Cannot find module '../lib/module-autopilot.js'`.

### Step 3: Implement the controller

Create `lib/module-autopilot.js`:

```js
// lib/module-autopilot.js
// Controller for the module autopilot. Owns the run loop, navigation,
// heartbeat, and pause/resume triggers.
(function (root) {
  'use strict';

  function getStateMod() {
    if (typeof module !== 'undefined' && module.exports) {
      return require('./autopilot-state.js');
    }
    return (root.ClipboardCleaner && root.ClipboardCleaner.autopilotState) || null;
  }

  function getScraperMod() {
    if (typeof module !== 'undefined' && module.exports) {
      return require('./module-scraper.js');
    }
    return (root.ClipboardCleaner && root.ClipboardCleaner.moduleScraper) || null;
  }

  function generateTabKey() {
    return 'tab-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
  }

  const HEARTBEAT_INTERVAL_MS = 5000;

  function createAutopilot(opts) {
    opts = opts || {};
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    const win = opts.window || (typeof window !== 'undefined' ? window : null);
    const storage = opts.storage;
    const handlers = opts.handlers || {};
    const nowFn = opts.nowFn || function () { return Date.now(); };
    const tabKey = opts.tabKey || generateTabKey();
    const rng = opts.rng || Math.random;
    const navigate = opts.navigate || function (url) {
      // Default: try to SPA-click the matching sidebar anchor.
      const a = doc.querySelector('a[href="' + url + '"]')
        || doc.querySelector('a[href$="' + url.replace(/^https?:\/\/[^/]+/, '') + '"]');
      if (a) { a.click(); return Promise.resolve(); }
      // Last resort: hard navigate.
      if (win && win.location) { win.location.href = url; }
      return Promise.resolve();
    };
    const sidebar = opts.sidebar || {};

    const stateMod = opts.stateMod || getStateMod();
    const scraperMod = opts.scraperMod || getScraperMod();
    const state = stateMod.createState(storage);

    let heartbeatTimer = null;
    let destroyed = false;
    let abortController = null;

    function startHeartbeat() {
      stopHeartbeat();
      heartbeatTimer = setInterval(function () {
        state.refreshHeartbeat(tabKey, nowFn(), function () {});
      }, HEARTBEAT_INTERVAL_MS);
    }

    function stopHeartbeat() {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    }

    function makeSignal() {
      // Best-effort AbortController for handler cancellation. Falls back to a duck.
      if (typeof AbortController === 'function') {
        abortController = new AbortController();
        return abortController.signal;
      }
      const listeners = [];
      abortController = {
        signal: {
          aborted: false,
          addEventListener: function (k, fn) { if (k === 'abort') listeners.push(fn); },
          removeEventListener: function () {},
        },
        abort: function () {
          abortController.signal.aborted = true;
          listeners.forEach(function (fn) { fn(); });
        },
      };
      return abortController.signal;
    }

    function currentUrl() {
      return (win && win.location && win.location.href) || '';
    }

    async function start() {
      if (destroyed) return;
      const scraped = scraperMod.scrapeModule(doc);
      if (!scraped.items || scraped.items.length === 0) {
        if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('No items found in this module.');
        return;
      }
      const queue = scraped.items.filter(function (it) { return !it.completed; });
      if (queue.length === 0) {
        if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Module already complete.');
        return;
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
          queue: queue,
          cursor: 0,
          startedAt: nowFn(),
          itemStartedAt: nowFn(),
          ownerTabKey: tabKey,
          heartbeatAt: nowFn(),
        }, resolve);
      });
      startHeartbeat();
      if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(true);
      if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Running — item 1 of ' + queue.length);
      if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('▶ Started — ' + queue.length + ' items');
      await navigate(queue[0].url);
    }

    function handlerForKind(kind) {
      if (handlers[kind]) return handlers[kind];
      return handlers.fallback;
    }

    async function runCurrentItem(stateNow) {
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
        const ctx = {
          doc: doc,
          item: item,
          rng: rng,
          signal: signal,
          replyHistory: stateNow.replyHistory || [],
          autoSubmitQuizzes: (stateNow.settings && stateNow.settings.autoSubmitQuizzes) || false,
          getAnswerText: function () { return (sidebar.getAnswerText && sidebar.getAnswerText()) || ''; },
          getLastCleanedCopy: function () { return (root.ClipboardCleaner && root.ClipboardCleaner.lastCleanedCopy) || null; },
        };
        outcome = await handler(ctx);
      } catch (e) {
        if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('✖ Handler error: ' + (e && e.message || 'unknown'));
        await new Promise(function (resolve) { state.update({ status: 'paused', ownerTabKey: null }, resolve); });
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Paused: handler error.');
        stopHeartbeat();
        return false;
      }
      if (outcome && /^pause-needed/.test(outcome.outcome)) {
        await new Promise(function (resolve) { state.update({ status: 'paused', ownerTabKey: null }, resolve); });
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Paused — needs your action.');
        stopHeartbeat();
        return false;
      }
      // Success path.
      if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('✓ ' + item.kind + ' "' + (item.title || item.id) + '"');
      // Record per-course completion in the local log (hybrid resume support).
      if (stateNow.courseId) {
        await new Promise(function (resolve) {
          state.recordCourseItem(stateNow.courseId, item.id, item.kind, outcome.outcome, resolve);
        });
      }
      // Advance cursor.
      const nextCursor = stateNow.cursor + 1;
      const newReplyHistory = (outcome && outcome.usedReply)
        ? ((stateNow.replyHistory || []).concat([outcome.usedReply]).slice(-5))
        : (stateNow.replyHistory || []);
      const queueLen = stateNow.queue.length;
      if (nextCursor >= queueLen) {
        await new Promise(function (resolve) {
          state.update({
            status: 'idle',
            cursor: nextCursor,
            replyHistory: newReplyHistory,
            ownerTabKey: null,
            queue: [],
            dwellEndsAt: null,
          }, resolve);
        });
        stopHeartbeat();
        if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Module complete.');
        if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('🏁 Module complete');
        if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(false);
        return true;
      }
      await new Promise(function (resolve) {
        state.update({
          cursor: nextCursor,
          replyHistory: newReplyHistory,
          itemStartedAt: nowFn(),
        }, resolve);
      });
      await navigate(stateNow.queue[nextCursor].url);
      return true;
    }

    async function bootIfRunning() {
      if (destroyed) return false;
      const cur = await new Promise(function (resolve) { state.load(resolve); });
      if (cur.status !== 'running') return false;
      const url = currentUrl();
      const scraperUrlCourseId = scraperMod.extractCourseId(url);
      if (cur.courseId && scraperUrlCourseId && cur.courseId !== scraperUrlCourseId) {
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Autopilot is running on a different course.');
        return false;
      }
      const acq = await new Promise(function (resolve) { state.acquireOwnership(tabKey, nowFn(), resolve); });
      if (acq !== 'owner') {
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Another tab is running this course\'s autopilot.');
        return false;
      }
      startHeartbeat();
      const stateNow = await new Promise(function (resolve) { state.load(resolve); });
      // Find which queue index matches the current URL.
      const currentItemId = scraperMod.extractItemId(url);
      let cursor = stateNow.cursor;
      if (currentItemId) {
        const idx = stateNow.queue.findIndex(function (it) { return it.id === currentItemId; });
        if (idx === -1) {
          // User navigated outside the queue.
          await new Promise(function (resolve) { state.update({ status: 'paused', ownerTabKey: null }, resolve); });
          stopHeartbeat();
          if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Off-queue — Resume to continue.');
          return false;
        }
        if (idx > stateNow.cursor) {
          // Jumped forward; align cursor.
          cursor = idx;
          await new Promise(function (resolve) { state.update({ cursor: cursor }, resolve); });
        }
      }
      const reloaded = await new Promise(function (resolve) { state.load(resolve); });
      if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(true);
      return await runCurrentItem(reloaded);
    }

    async function pause(reason) {
      if (abortController && abortController.abort) abortController.abort();
      await new Promise(function (resolve) { state.update({ status: 'paused', ownerTabKey: null }, resolve); });
      stopHeartbeat();
      if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, reason || 'Paused.');
      if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(false);
    }

    async function resume() {
      const cur = await new Promise(function (resolve) { state.load(resolve); });
      if (cur.status !== 'paused' || !cur.queue || cur.queue.length === 0) return;
      const url = currentUrl();
      const urlCourse = scraperMod.extractCourseId(url);
      if (cur.courseId && urlCourse && cur.courseId !== urlCourse) {
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Navigate back to course ' + cur.courseId + ' to resume.');
        return;
      }
      const acq = await new Promise(function (resolve) { state.acquireOwnership(tabKey, nowFn(), resolve); });
      if (acq !== 'owner') {
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Another tab owns this run.');
        return;
      }
      await new Promise(function (resolve) { state.update({ status: 'running', ownerTabKey: tabKey, heartbeatAt: nowFn() }, resolve); });
      startHeartbeat();
      if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(false, '');
      const stateNow = await new Promise(function (resolve) { state.load(resolve); });
      await runCurrentItem(stateNow);
    }

    async function stop() {
      if (abortController && abortController.abort) abortController.abort();
      stopHeartbeat();
      await new Promise(function (resolve) { state.clear(resolve); });
      if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Idle.');
      if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(false);
      if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(false, '');
    }

    function destroy() {
      destroyed = true;
      if (abortController && abortController.abort) abortController.abort();
      stopHeartbeat();
    }

    return {
      start: start,
      stop: stop,
      pause: pause,
      resume: resume,
      bootIfRunning: bootIfRunning,
      destroy: destroy,
      _tabKey: tabKey,
    };
  }

  const api = {
    createAutopilot: createAutopilot,
    generateTabKey: generateTabKey,
    HEARTBEAT_INTERVAL_MS: HEARTBEAT_INTERVAL_MS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.moduleAutopilot = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

### Step 4: Run tests

Run: `npm test`
Expected: all tests pass.

### Step 5: Commit

```bash
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(autopilot): add controller with ownership-safe boot/resume/stop"
```

---

## Task 11: Manifest + content.js wiring + smoke-test note

**Files:**
- Modify: `manifest.json`
- Modify: `content.js`

### Step 1: Update manifest

Read `manifest.json` first to see its current `content_scripts[0].js` array — it may have grown via the lecture-companion plan. Insert these six files BEFORE `lib/sidebar.js`, preserving every existing entry:

```
lib/autopilot-timing.js
lib/discussion-replies.js
lib/autopilot-state.js
lib/module-scraper.js
lib/item-handlers.js
lib/module-autopilot.js
```

Then ensure the top-level `"permissions"` array contains `"storage"`. If it doesn't exist, add:

```json
  "permissions": ["storage"],
```

Place it between `description` and `icons`.

### Step 2: Wire the autopilot in content.js

Read the current `content.js`. After the existing `mountSidebarWhenReady()` block (and `startLectureCompanion()` from the lecture-companion plan, if present), add:

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
    const handlers = a.itemHandlers.createHandlers({
      sleep: function (ms, signal) {
        return new Promise(function (resolve, reject) {
          const t = setTimeout(resolve, ms);
          if (signal && signal.addEventListener) {
            signal.addEventListener('abort', function () { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
          }
        });
      },
      jitteredScroll: function (container, opts) {
        // Simple jittered scroll using timing helpers.
        return new Promise(function (resolve, reject) {
          if (!container || !container.scrollBy) { resolve(); return; }
          const start = Date.now();
          const timing = a.autopilotTiming;
          function step() {
            if (Date.now() - start >= opts.totalMs) { resolve(); return; }
            if (opts.signal && opts.signal.aborted) { reject(new Error('aborted')); return; }
            const s = timing.scrollStep(opts.rng);
            try { container.scrollBy(0, s.pixels); } catch (_) {}
            setTimeout(step, s.intervalMs);
          }
          step();
        });
      },
      timing: a.autopilotTiming,
      replies: a.discussionReplies,
      typingEngine: a.typingEngine,
      typingInjector: a.typingInjector,
      answerApplier: a.answerApplier || null,
    });
    _autopilotInstance = a.moduleAutopilot.createAutopilot({
      document: document,
      window: window,
      storage: storage,
      handlers: handlers,
      sidebar: a.sidebar,
    });
    // Wire sidebar buttons to controller actions.
    if (typeof a.sidebar.setAutopilotHandlers === 'function') {
      a.sidebar.setAutopilotHandlers({
        onRun:    function () { _autopilotInstance.start(); },
        onStop:   function () { _autopilotInstance.stop(); },
        onResume: function () { _autopilotInstance.resume(); },
        onSettingsChange: function (settings) {
          a.autopilotState && a.autopilotState.createState(storage).update({ settings: settings }, function () {});
        },
      });
    }
    // Pause-on-user-input listener (trusted only, ignore sidebar shadow events).
    document.addEventListener('keydown', function (ev) {
      if (!ev.isTrusted) return;
      // Best-effort sidebar exclusion: ignore if path includes the host element.
      const path = (typeof ev.composedPath === 'function') ? ev.composedPath() : [];
      for (let i = 0; i < path.length; i++) {
        if (path[i] && path[i].id === 'ccp-host-root') return;
      }
      _autopilotInstance && _autopilotInstance.pause('You started interacting.');
    }, true);
    // Visibility pause after 60s hidden.
    let hiddenSince = 0;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { hiddenSince = Date.now(); }
      else if (hiddenSince && Date.now() - hiddenSince > 60000) {
        _autopilotInstance && _autopilotInstance.pause('Tab was hidden — paused.');
        hiddenSince = 0;
      } else { hiddenSince = 0; }
    });
    _autopilotInstance.bootIfRunning();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startAutopilot, { once: true });
  } else {
    startAutopilot();
  }
```

### Step 3: Run all tests

Run: `npm test`
Expected: all tests pass.

### Step 4: Manifest validity check

Run:

```
node -e "const m=JSON.parse(require('fs').readFileSync('manifest.json','utf8'));console.log('scripts:',m.content_scripts[0].js.length,'perm:',m.permissions);"
```

Confirm the new six scripts are listed and `permissions` includes `"storage"`.

### Step 5: SKIP the manual smoke test

The plan explicitly DOES NOT include a manual Chrome smoke test as an automatable step. Document the deferred verification at the end of your task report so the user can do it:

> Manual smoke test (deferred): load unpacked, open a Coursera course module page, click "Run autopilot for this module", confirm the queue scrape, navigation, and per-item handlers behave on real DOM. Selectors are the highest-risk surface — if anything fails, report the selector that needed widening.

### Step 6: Commit

```bash
git add manifest.json content.js
git commit -m "chore(autopilot): wire six new lib files and instantiate controller in content.js"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Implemented in |
|---|---|
| Architecture (content-script + chrome.storage checkpoint, no SW) | Tasks 3, 10, 11. `bootIfRunning()` in content.js. |
| File structure (6 new lib modules) | Tasks 1–4, 7–10. |
| Item-type behaviors — video | Task 8. Pre-skip dwell with cap, post-end dwell, fallback to play-through, abort on signal. |
| Item-type behaviors — reading | Task 7. Jittered scroll over dwell, optional Mark-complete click. |
| Item-type behaviors — discussion | Task 7. Dwell, TypingEngine for reply, click submit, replyHistory cooldown. |
| Item-type behaviors — quiz/fallback | Task 9. Source-order for answer text, `applyAnswers`, autoSubmit gate. |
| Discussion reply pool of 20 with cooldown | Task 2. |
| Timing model (all ranges in named constants) | Task 1. |
| State machine (acquireOwnership, refreshHeartbeat, defaults) | Task 3. |
| Per-course completion log (hybrid resume) | Task 3 (`recordCourseItem`/`getCourseLog`); Task 10 calls `recordCourseItem` in the controller's success path with a dedicated test. |
| Boot behavior (1–11) including cursor-then-completion check | Task 10. |
| `resume()` flips paused→running, acquires ownership | Task 10. |
| Pause triggers — Stop, user input, visibility, handler failure | Task 11 (input + visibility), Task 10 (pause/handler failure). |
| Sidebar UI — Autopilot tab | Task 6. |
| `getAnswerText()` from sidebar | Task 6. |
| `lastCleanedCopy` stash on cleaner | Task 5. |
| Manifest registration + storage permission | Task 11. |
| Testing strategy — fake storage, jsdom, RNG-seed determinism, fake handlers | Throughout. |

**2. Placeholder scan:** No "TBD", "TODO", or "implement later" in any step. Every test file has runnable code. Every implementation step includes the complete code.

**3. Type consistency:**
- `createState(storage)` returns `{ load, save, update, clear, getCourseLog, recordCourseItem, acquireOwnership, refreshHeartbeat }` — used identically in Task 10 and Task 11.
- `createHandlers(deps)` returns `{ reading, discussion, video, fallback }` — wiring in Task 11 reads `a.itemHandlers.createHandlers`, matches Task 7/8/9 export name.
- `createAutopilot(opts)` returns `{ start, stop, pause, resume, bootIfRunning, destroy, _tabKey }` — content.js wires `onRun→start`, `onStop→stop`, `onResume→resume`, and calls `bootIfRunning()`. Consistent.
- Handler context shape (`ctx.doc, item, rng, signal, getAnswerText, getLastCleanedCopy, autoSubmitQuizzes, replyHistory`) — built in Task 10's `runCurrentItem`, consumed in Tasks 7/8/9 tests and implementations.
- Storage key constants `RUN_KEY`, `COURSE_LOG_KEY` exported from autopilot-state, imported in tests and the controller via the module.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-23-module-autopilot.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task with two-stage review (spec + code quality), fast iteration. This is what the lecture-companion plan used.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans` with batched checkpoints.

Which approach?
