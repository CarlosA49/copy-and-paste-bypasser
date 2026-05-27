# Diagnostics Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Diagnostics` sidebar tab backed by a single in-memory event recorder injected into the autopilot controller, item handlers, completion confirmer, and page-fallback callers, so a real Coursera stall (e.g. `Accessing Parts of a Matrix → skip Assignment: Matrix Indexing → Combining and Transforming Matrices`) produces a chronological, copyable trace covering queue advancement, lazy blocked-skip logging, navigation, SPA re-entry, handler startup, video duration/seek, and completion confirmation.

**Architecture:** Single `lib/autopilot-debug.js` module exposing `createDebugRecorder()` (bounded ring buffer, subscriber list, snapshot helper) and `formatDebugReport(snapshot, extraContext)` (pure plain-text formatter). One recorder is created in `content.js` and dependency-injected into `module-autopilot`, `item-handlers`, `completion-confirmer`, and registered into `sidebar` via `setDebugRecorder()`. The sidebar gets a 5th tab (`Diagnostics`) that subscribes to the recorder and renders rows as events arrive; two buttons (`Copy debug report`, `Clear`). All `record()` callsites are wrapped so any recorder error is swallowed — the autopilot must keep running.

**Tech Stack:** Vanilla JS / Chrome MV3 / dual-export IIFE (`module.exports` + `root.ClipboardCleaner.X`); Node 20 `node --test` + JSDOM; existing sidebar shadow-DOM tab pattern.

**Baseline before starting:** `npm test` → 601 pass, 0 fail. The `runCurrentItem` queuedRun fix and the `ROW_KIND_RE` "Graded App Item" cleanup are already in place — do not redo or revert.

---

## File Structure

- **Create** `lib/autopilot-debug.js` — `createDebugRecorder()` + `formatDebugReport()`. Pure, no DOM dependencies.
- **Create** `tests/autopilot-debug.test.js` — recorder + formatter behavior.
- **Modify** `manifest.json` — load `lib/autopilot-debug.js` BEFORE `lib/completion-confirmer.js`, `lib/item-handlers.js`, `lib/module-autopilot.js`, `lib/sidebar.js`.
- **Modify** `lib/module-autopilot.js` — accept `opts.debugRecorder`; helper `rec(type, details)` that swallows recorder errors; instrument controller/queue/navigation/boot/run-state events.
- **Modify** `lib/item-handlers.js` — accept `deps.debugRecorder`; instrument `video()` (both Fast and Human paths), `waitForVideoDuration`, `seekVideoWithFallback`, `reading()` mark-complete, and final handler outcome.
- **Modify** `lib/completion-confirmer.js` — accept `deps.debugRecorder`; instrument `waitForCompletion()` start/detected/timeout/aborted with evidence kind.
- **Modify** `lib/sidebar.js` — add a 5th tab `Diagnostics` with status block, event list, `Copy debug report` and `Clear` buttons; expose `setDebugRecorder()`, `setAutopilotRunContext()`.
- **Modify** `content.js` — construct a single `debugRecorder` and inject it into handlers, confirmer, autopilot, and `sidebar.setDebugRecorder()`.
- **Modify** `tests/module-autopilot.test.js` — add Course-mode trace test that asserts the recorder captured the A→blocked→C event sequence in order, including `item.run.deferred`/`item.run.rerun.scheduled`/`item.run.rerun.executed`.
- **Modify** `tests/item-handlers.test.js` — add Fast and Human video instrumentation assertions.
- **Modify** `tests/completion-confirmer.test.js` — add evidence-kind and timeout assertions.
- **Modify** `tests/sidebar.test.js` (or create if absent) — Diagnostics-tab UI tests.

---

### Task 1: Diagnostics recorder — `record()`, `getEvents()`, `clear()`

**Files:**
- Create: `lib/autopilot-debug.js`
- Test:  `tests/autopilot-debug.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/autopilot-debug.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDebugRecorder } = require('../lib/autopilot-debug.js');

test('record stores events chronologically with type + details + at', () => {
  let t = 1000;
  const r = createDebugRecorder({ nowFn: function () { return new Date(t).toISOString(); } });
  r.record('a', { x: 1 });
  t = 2000;
  r.record('b', { y: 2 });
  const ev = r.getEvents();
  assert.equal(ev.length, 2);
  assert.equal(ev[0].type, 'a');
  assert.deepEqual(ev[0].details, { x: 1 });
  assert.equal(ev[0].at, new Date(1000).toISOString());
  assert.equal(ev[1].type, 'b');
});

test('record drops events past maxEvents, keeping most recent', () => {
  const r = createDebugRecorder({ maxEvents: 3 });
  r.record('a', {}); r.record('b', {}); r.record('c', {}); r.record('d', {});
  const types = r.getEvents().map(function (e) { return e.type; });
  assert.deepEqual(types, ['b', 'c', 'd']);
});

test('clear empties stored events', () => {
  const r = createDebugRecorder();
  r.record('a', {});
  r.clear();
  assert.deepEqual(r.getEvents(), []);
});

test('record never throws even when details is unserializable (cycles)', () => {
  const r = createDebugRecorder();
  const bad = {}; bad.self = bad;
  assert.doesNotThrow(function () { r.record('x', bad); });
  // The event is still stored; details may be a placeholder.
  const ev = r.getEvents();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'x');
});

test('record swallows internal errors and never throws into caller', () => {
  // Pass a nowFn that throws — record() must still not bubble.
  const r = createDebugRecorder({ nowFn: function () { throw new Error('boom'); } });
  assert.doesNotThrow(function () { r.record('a', { x: 1 }); });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx node --test tests/autopilot-debug.test.js`
Expected: FAIL — `Cannot find module '../lib/autopilot-debug.js'`.

- [ ] **Step 3: Write minimal implementation**

```js
// lib/autopilot-debug.js
(function (root) {
  'use strict';

  const DEFAULT_MAX_EVENTS = 500;

  function safeNow(nowFn) {
    try {
      const n = nowFn();
      if (n instanceof Date) return n.toISOString();
      if (typeof n === 'number') return new Date(n).toISOString();
      if (typeof n === 'string') return n;
      return new Date().toISOString();
    } catch (_) {
      return new Date(0).toISOString();
    }
  }

  function safeDetails(details) {
    if (details == null) return {};
    try {
      // Round-trip through JSON to drop cycles and non-serializable values.
      return JSON.parse(JSON.stringify(details));
    } catch (_) {
      try { return { _unserializable: String(details) }; } catch (__) { return {}; }
    }
  }

  function createDebugRecorder(options) {
    options = options || {};
    const maxEvents = (typeof options.maxEvents === 'number' && options.maxEvents > 0)
      ? options.maxEvents : DEFAULT_MAX_EVENTS;
    const nowFn = (typeof options.nowFn === 'function') ? options.nowFn : function () { return new Date(); };
    const getContext = (typeof options.getContext === 'function') ? options.getContext : null;
    const events = [];
    const listeners = [];

    function record(type, details) {
      try {
        const ev = { at: safeNow(nowFn), type: String(type || ''), details: safeDetails(details) };
        events.push(ev);
        while (events.length > maxEvents) events.shift();
        for (let i = 0; i < listeners.length; i++) {
          try { listeners[i](ev); } catch (_) { /* listener errors must not bubble */ }
        }
      } catch (_) { /* recorder must never throw into caller */ }
    }

    function getEvents() { return events.slice(); }
    function clear() {
      events.length = 0;
      for (let i = 0; i < listeners.length; i++) {
        try { listeners[i](null); } catch (_) {}
      }
    }
    function subscribe(fn) { if (typeof fn === 'function') listeners.push(fn); return function () { unsubscribe(fn); }; }
    function unsubscribe(fn) {
      for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i] === fn) listeners.splice(i, 1);
    }
    function snapshot(extra) {
      let ctx = null;
      try { ctx = getContext ? getContext() : null; } catch (_) { ctx = null; }
      return {
        capturedAt: safeNow(nowFn),
        context: Object.assign({}, ctx || {}, extra || {}),
        events: events.slice(),
      };
    }

    return { record, getEvents, clear, subscribe, unsubscribe, snapshot };
  }

  const api = { createDebugRecorder: createDebugRecorder };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.autopilotDebug = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx node --test tests/autopilot-debug.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: No commit yet** (collecting changes for one cohesive commit at the end of the feature if the user later requests one).

---

### Task 2: Diagnostics recorder — `subscribe()` and `snapshot()`

**Files:**
- Modify: `lib/autopilot-debug.js` (already includes both; tests here lock the contract)
- Test:  `tests/autopilot-debug.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/autopilot-debug.test.js`:

```js
test('subscribe is called when events are recorded, returns unsubscribe', () => {
  const r = createDebugRecorder();
  const seen = [];
  const off = r.subscribe(function (ev) { seen.push(ev && ev.type); });
  r.record('one', {});
  r.record('two', {});
  off();
  r.record('three', {});
  assert.deepEqual(seen, ['one', 'two']);
});

test('clear() notifies subscribers with null', () => {
  const r = createDebugRecorder();
  const seen = [];
  r.subscribe(function (ev) { seen.push(ev); });
  r.record('a', {});
  r.clear();
  assert.equal(seen.length, 2);
  assert.equal(seen[1], null);
});

test('snapshot returns ordered events plus merged context', () => {
  const r = createDebugRecorder({ getContext: function () { return { status: 'running', cursor: 4 }; } });
  r.record('first', { k: 1 });
  const snap = r.snapshot({ runScope: 'course' });
  assert.equal(snap.events.length, 1);
  assert.equal(snap.events[0].type, 'first');
  assert.equal(snap.context.status, 'running');
  assert.equal(snap.context.cursor, 4);
  assert.equal(snap.context.runScope, 'course');
  assert.ok(typeof snap.capturedAt === 'string');
});

test('snapshot ignores getContext errors', () => {
  const r = createDebugRecorder({ getContext: function () { throw new Error('bad'); } });
  const snap = r.snapshot({ x: 1 });
  assert.deepEqual(snap.context, { x: 1 });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx node --test tests/autopilot-debug.test.js`
Expected: PASS, 9 tests total (subscribe/snapshot already implemented in Task 1's module).

If any test fails, fix `lib/autopilot-debug.js` to match the contract above (the Task 1 sketch already satisfies these — this task is the contract lock).

---

### Task 3: Report formatter — `formatDebugReport(snapshot)`

**Files:**
- Modify: `lib/autopilot-debug.js`
- Test:  `tests/autopilot-debug.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/autopilot-debug.test.js`:

```js
const { formatDebugReport } = require('../lib/autopilot-debug.js');

function fakeSnapshot() {
  return {
    capturedAt: '2026-05-25T12:00:00.000Z',
    context: {
      url: 'https://www.coursera.org/learn/x/lecture/v4/access',
      status: 'running',
      behaviorMode: 'fast',
      runScope: 'course',
      courseId: 'x',
      moduleId: 'week-3',
      cursor: 0,
      queueLength: 3,
      ownerTabKey: 'tab-abc',
      lastPauseReason: null,
      queue: [
        { id: 'v4', title: 'Accessing Parts of a Matrix', kind: 'video', blocked: false, completed: false, url: '/learn/x/lecture/v4/access', skippedLogged: false },
        { id: 'a5', title: 'Assignment: Matrix Indexing', kind: 'assignment', blocked: true, blockReason: 'graded item', completed: false, url: '/learn/x/gradedLti/a5/x', skippedLogged: true },
        { id: 'v6', title: 'Combining and Transforming Matrices', kind: 'video', blocked: false, completed: false, url: '/learn/x/lecture/v6/x', skippedLogged: false },
      ],
    },
    events: [
      { at: '2026-05-25T12:00:01.000Z', type: 'run.start.requested', details: { scope: 'course', behaviorMode: 'fast' } },
      { at: '2026-05-25T12:00:02.000Z', type: 'video.seek.direct.result', details: { itemId: 'v4', accepted: true, currentTime: 1200 } },
    ],
  };
}

test('formatDebugReport includes header, queue, events sections', () => {
  const out = formatDebugReport(fakeSnapshot());
  assert.ok(/REPORT TIMESTAMP\s+2026-05-25T12:00:00\.000Z/.test(out));
  assert.ok(/URL\s+https:\/\/www\.coursera\.org\/learn\/x\/lecture\/v4\/access/.test(out));
  assert.ok(/STATUS\s+running/.test(out));
  assert.ok(/BEHAVIOR MODE\s+fast/.test(out));
  assert.ok(/RUN SCOPE\s+course/.test(out));
  assert.ok(/COURSE\s+x/.test(out));
  assert.ok(/MODULE\s+week-3/.test(out));
  assert.ok(/CURSOR\s+0\b/.test(out));
  assert.ok(/QUEUE LENGTH\s+3/.test(out));
  assert.ok(/OWNER TAB\s+tab-abc/.test(out));

  assert.ok(/QUEUE\b/.test(out));
  assert.ok(/\[00\] <- safe\s+video\s+"Accessing Parts of a Matrix"\s+id=v4/.test(out));
  assert.ok(/\[01\] blocked graded item\s+"Assignment: Matrix Indexing"\s+id=a5/.test(out) ||
            /\[01\] blocked\s+assignment\s+"Assignment: Matrix Indexing"\s+id=a5/.test(out));
  assert.ok(/skippedLogged=true/.test(out));
  assert.ok(/\[02\] safe\s+video\s+"Combining and Transforming Matrices"\s+id=v6/.test(out));

  assert.ok(/EVENTS\b/.test(out));
  assert.ok(/run\.start\.requested/.test(out));
  assert.ok(/video\.seek\.direct\.result/.test(out));
  assert.ok(/accepted=true/.test(out));
  assert.ok(/currentTime=1200/.test(out));
});

test('formatDebugReport surfaces pause/stuck reason when present', () => {
  const snap = fakeSnapshot();
  snap.context.lastPauseReason = 'No completion indicator after video';
  const out = formatDebugReport(snap);
  assert.ok(/LAST PAUSE\s+No completion indicator after video/.test(out));
});

test('formatDebugReport never emits answer-text or page-body fields, even if accidentally provided', () => {
  const snap = fakeSnapshot();
  snap.context.answerText = 'SECRET-DO-NOT-PRINT';
  snap.context.pageBody = 'SECRET-PAGE-BODY';
  snap.events.push({ at: '2026-05-25T12:00:03.000Z', type: 'sketchy', details: { answerText: 'NO', pageBody: 'NOPE', value: 42 } });
  const out = formatDebugReport(snap);
  assert.ok(!/SECRET-DO-NOT-PRINT/.test(out));
  assert.ok(!/SECRET-PAGE-BODY/.test(out));
  assert.ok(!/answerText/.test(out));
  assert.ok(!/pageBody/.test(out));
  assert.ok(/value=42/.test(out));
});

test('formatDebugReport handles missing/empty queue and events gracefully', () => {
  const snap = { capturedAt: '2026-05-25T00:00:00.000Z', context: { status: 'idle' }, events: [] };
  const out = formatDebugReport(snap);
  assert.ok(/STATUS\s+idle/.test(out));
  assert.ok(/QUEUE\s+\(empty\)/.test(out));
  assert.ok(/EVENTS\s+\(none\)/.test(out));
});

test('formatDebugReport surfaces a VIDEO STATE block derived from the most recent video-related events', () => {
  const snap = {
    capturedAt: '2026-05-25T00:00:00.000Z',
    context: { status: 'running' },
    events: [
      { at: 't1', type: 'handler.start', details: { itemId: 'v6', title: 'Combining and Transforming Matrices', kind: 'video', behaviorMode: 'fast' } },
      { at: 't2', type: 'video.element', details: { itemId: 'v6', found: true } },
      { at: 't3', type: 'video.duration.initial', details: { itemId: 'v6', value: NaN } },
      { at: 't4', type: 'video.duration.wait.completed', details: { itemId: 'v6', duration: 600, polls: 3 } },
      { at: 't5', type: 'video.seek.requested', details: { itemId: 'v6', directTarget: 555, fallbackTarget: 555 } },
      { at: 't6', type: 'video.seek.direct.result', details: { itemId: 'v6', attempted: true, accepted: true, currentTime: 555 } },
      { at: 't7', type: 'handler.outcome', details: { itemId: 'v6', outcome: 'video-done-fast', mode: 'fast' } },
    ],
  };
  const out = formatDebugReport(snap);
  assert.ok(/VIDEO STATE\b/.test(out));
  assert.ok(/itemId=v6/.test(out));
  assert.ok(/title="Combining and Transforming Matrices"/.test(out));
  assert.ok(/duration=600/.test(out));
  assert.ok(/target=555/.test(out));
  assert.ok(/direct\.accepted=true/.test(out));
  assert.ok(/outcome=video-done-fast/.test(out));
});

test('formatDebugReport surfaces a NAVIGATION block summarizing the latest cursor advance + nav', () => {
  const snap = {
    capturedAt: '2026-05-25T00:00:00.000Z',
    context: { status: 'running' },
    events: [
      { at: 't1', type: 'queue.cursor.changed', details: { before: 0, after: 1, reason: 'success' } },
      { at: 't2', type: 'queue.blocked.skipped', details: { cursor: 1, title: 'Assignment: Matrix Indexing', blockReason: 'graded item', logged: true } },
      { at: 't3', type: 'queue.next.safe', details: { cursor: 2, itemId: 'v6', title: 'Combining and Transforming Matrices', kind: 'video' } },
      { at: 't4', type: 'navigation.requested', details: { from: '/learn/.../v4', target: '/learn/.../v6', itemId: 'v6' } },
      { at: 't5', type: 'navigation.result', details: { target: '/learn/.../v6', urlChanged: true, rowAnchorFallbackClicked: false } },
      { at: 't6', type: 'route.changed', details: { from: '/learn/.../v4', to: '/learn/.../v6', source: 'unknown' } },
      { at: 't7', type: 'item.run.deferred', details: { reason: 'inFlight', queuedRun: true } },
      { at: 't8', type: 'item.run.rerun.scheduled', details: {} },
      { at: 't9', type: 'item.run.rerun.executed', details: {} },
    ],
  };
  const out = formatDebugReport(snap);
  assert.ok(/NAVIGATION\b/.test(out));
  assert.ok(/cursor\s*0\s*->\s*1/.test(out));
  assert.ok(/blocked\s+skipped/.test(out) || /skipped:\s*"Assignment: Matrix Indexing"/.test(out));
  assert.ok(/target=\/learn\/\.\.\.\/v6/.test(out));
  assert.ok(/urlChanged=true/.test(out));
  assert.ok(/queuedRun=true/.test(out));
  assert.ok(/rerun\.scheduled/.test(out));
  assert.ok(/rerun\.executed/.test(out));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test tests/autopilot-debug.test.js`
Expected: FAIL — `formatDebugReport` not exported.

- [ ] **Step 3: Implement `formatDebugReport` and export it**

Add inside the IIFE in `lib/autopilot-debug.js`, before `const api = ...`:

```js
  // Field allow-list applied both to context and per-event details so an
  // accidental sensitive field never lands in the copyable report.
  const FORBIDDEN_KEYS = ['answerText', 'pageBody', 'bodyText', 'pastedAnswer', 'quizOptions'];

  function sanitize(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    Object.keys(obj).forEach(function (k) {
      if (FORBIDDEN_KEYS.indexOf(k) !== -1) return;
      const v = obj[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = sanitize(v);
      } else {
        out[k] = v;
      }
    });
    return out;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function headerLine(label, val) {
    return label.padEnd(16, ' ') + (val == null ? '' : String(val));
  }

  function formatQueueLine(i, cursor, item) {
    const marker = (i === cursor) ? '<- ' : '   ';
    const status = item.blocked ? ('blocked ' + (item.blockReason || item.kind || 'blocked')) : ('safe   ');
    return '[' + pad2(i) + '] ' + marker + status.padEnd(20, ' ') +
      ' "' + (item.title || item.id || '') + '"' +
      ' id=' + (item.id || '') +
      ' completed=' + !!item.completed +
      (item.blocked ? ' skippedLogged=' + !!item.skippedLogged : '') +
      ' url=' + (item.url || '');
  }

  function formatDetails(d) {
    if (!d || typeof d !== 'object') return '';
    const safe = sanitize(d);
    return Object.keys(safe).map(function (k) {
      const v = safe[k];
      if (v && typeof v === 'object') return k + '=' + JSON.stringify(v);
      if (typeof v === 'string') return k + '=' + JSON.stringify(v);
      return k + '=' + String(v);
    }).join(' ');
  }

  function formatDebugReport(snap, extraContext) {
    snap = snap || {};
    const ctx = sanitize(Object.assign({}, snap.context || {}, extraContext || {}));
    const out = [];
    out.push(headerLine('REPORT TIMESTAMP', snap.capturedAt || ''));
    out.push(headerLine('URL', ctx.url));
    out.push(headerLine('STATUS', ctx.status));
    out.push(headerLine('BEHAVIOR MODE', ctx.behaviorMode));
    out.push(headerLine('RUN SCOPE', ctx.runScope));
    out.push(headerLine('COURSE', ctx.courseId));
    out.push(headerLine('MODULE', ctx.moduleId));
    out.push(headerLine('CURSOR', ctx.cursor));
    out.push(headerLine('QUEUE LENGTH', ctx.queueLength));
    if (ctx.ownerTabKey) out.push(headerLine('OWNER TAB', ctx.ownerTabKey));
    if (ctx.lastPauseReason) out.push(headerLine('LAST PAUSE', ctx.lastPauseReason));
    out.push('');
    out.push('QUEUE');
    const queue = Array.isArray(ctx.queue) ? ctx.queue : [];
    if (queue.length === 0) out.push('(empty)');
    else for (let i = 0; i < queue.length; i++) out.push(formatQueueLine(i, ctx.cursor, queue[i]));
    out.push('');
    // VIDEO STATE — pulled from the latest sequence of video.* / handler.* events
    // for the most-recent video itemId. Pure projection over snap.events.
    out.push('VIDEO STATE');
    const vEvents = (snap.events || []).filter(function (e) {
      return e && e.type && (/^video\./.test(e.type) || e.type === 'handler.start' || e.type === 'handler.outcome');
    });
    if (vEvents.length === 0) {
      out.push('(no video activity)');
    } else {
      // Find the latest video itemId by walking backwards.
      let latestItemId = null;
      for (let i = vEvents.length - 1; i >= 0 && !latestItemId; i--) {
        const d = vEvents[i].details || {};
        if (d.itemId) latestItemId = d.itemId;
      }
      const recent = vEvents.filter(function (e) { return (e.details || {}).itemId === latestItemId; });
      const flat = {};
      recent.forEach(function (e) {
        const d = sanitize(e.details || {});
        if (e.type === 'handler.start')              { flat.itemId = d.itemId; flat.title = d.title; flat.behaviorMode = d.behaviorMode; }
        if (e.type === 'video.element')              { flat['video.found'] = d.found; }
        if (e.type === 'video.duration.initial')     { flat['duration.initial'] = d.value; }
        if (e.type === 'video.duration.wait.completed') { flat.duration = d.duration; flat.polls = d.polls; }
        if (e.type === 'video.seek.requested')       { flat.target = d.directTarget; flat.fallbackTarget = d.fallbackTarget; }
        if (e.type === 'video.seek.direct.result')   { flat['direct.attempted'] = d.attempted; flat['direct.accepted'] = d.accepted; flat['direct.currentTime'] = d.currentTime; }
        if (e.type === 'video.seek.forward.result')  { flat['forward.found'] = d.forwardFound; flat['forward.clicks'] = d.forwardClicks; flat['forward.currentTime'] = d.currentTime; flat['forward.reached'] = d.targetReached; }
        if (e.type === 'handler.outcome')            { flat.outcome = d.outcome; flat.mode = d.mode; }
      });
      out.push(formatDetails(flat));
    }
    out.push('');
    // NAVIGATION — condense the latest cursor advance + nav + reentry sequence.
    out.push('NAVIGATION');
    const navEvents = (snap.events || []).filter(function (e) {
      return e && e.type && (
        e.type === 'queue.cursor.changed' || e.type === 'queue.blocked.skipped' ||
        e.type === 'queue.next.safe' || /^navigation\./.test(e.type) ||
        e.type === 'route.changed' || /^item\.run\.(deferred|rerun)/.test(e.type)
      );
    });
    if (navEvents.length === 0) {
      out.push('(no navigation activity)');
    } else {
      navEvents.forEach(function (e) {
        const d = sanitize(e.details || {});
        if (e.type === 'queue.cursor.changed') {
          out.push('  cursor ' + d.before + ' -> ' + d.after + (d.reason ? ' (' + d.reason + ')' : ''));
        } else if (e.type === 'queue.blocked.skipped') {
          out.push('  blocked skipped: "' + (d.title || '') + '" reason=' + (d.blockReason || '') + ' logged=' + !!d.logged);
        } else if (e.type === 'queue.next.safe') {
          out.push('  next safe: cursor=' + d.cursor + ' "' + (d.title || '') + '" kind=' + (d.kind || ''));
        } else if (e.type === 'navigation.requested') {
          out.push('  nav.requested target=' + (d.target || '') + ' itemId=' + (d.itemId || ''));
        } else if (e.type === 'navigation.result') {
          out.push('  nav.result target=' + (d.target || '') + ' urlChanged=' + !!d.urlChanged + ' rowAnchorFallbackClicked=' + !!d.rowAnchorFallbackClicked);
        } else if (e.type === 'route.changed') {
          out.push('  route.changed ' + (d.from || '') + ' -> ' + (d.to || '') + ' (source=' + (d.source || 'unknown') + ')');
        } else if (e.type === 'item.run.deferred') {
          out.push('  item.run.deferred reason=' + (d.reason || '') + ' queuedRun=' + !!d.queuedRun);
        } else if (e.type === 'item.run.rerun.scheduled') {
          out.push('  rerun.scheduled');
        } else if (e.type === 'item.run.rerun.executed') {
          out.push('  rerun.executed');
        }
      });
    }
    out.push('');
    out.push('EVENTS');
    const events = Array.isArray(snap.events) ? snap.events : [];
    if (events.length === 0) out.push('(none)');
    else for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      out.push((ev.at || '') + ' ' + (ev.type || '') + ' ' + formatDetails(ev.details));
    }
    return out.join('\n');
  }
```

Then update the export block:

```js
  const api = {
    createDebugRecorder: createDebugRecorder,
    formatDebugReport: formatDebugReport,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test tests/autopilot-debug.test.js`
Expected: PASS, 13 tests total.

---

### Task 4: Add `lib/autopilot-debug.js` to manifest

**Files:**
- Modify: `manifest.json`

- [ ] **Step 1: Edit `manifest.json` `content_scripts[0].js`**

Insert `"lib/autopilot-debug.js"` immediately after `"lib/autopilot-timing.js"` (before `lib/autopilot-state.js`, `lib/module-scraper.js`, `lib/page-fallback.js`, `lib/item-handlers.js`, `lib/completion-confirmer.js`, `lib/module-autopilot.js`, `lib/sidebar.js`, `content.js`).

Resulting `js` array:

```json
"js": [
  "lib/cleaner.js",
  "lib/math-flatten.js",
  "lib/html-cleaner.js",
  "lib/typing-engine.js",
  "lib/typing-injector.js",
  "lib/value-normalize.js",
  "lib/answer-parser.js",
  "lib/answer-matcher.js",
  "lib/autopilot-timing.js",
  "lib/autopilot-debug.js",
  "lib/discussion-replies.js",
  "lib/autopilot-state.js",
  "lib/module-scraper.js",
  "lib/page-fallback.js",
  "lib/item-handlers.js",
  "lib/completion-confirmer.js",
  "lib/module-autopilot.js",
  "lib/sidebar.js",
  "lib/autopilot-input-guard.js",
  "content.js"
]
```

- [ ] **Step 2: No test runs needed here — manifest changes are pure config.** (Smoke-test in browser comes at end of plan.)

---

### Task 5: Wire `debugRecorder` injection into `completion-confirmer`

**Files:**
- Modify: `lib/completion-confirmer.js`
- Test: `tests/completion-confirmer.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/completion-confirmer.test.js`:

```js
test('confirmer records completion.wait.started and completion.detected with evidence kind', async () => {
  const events = [];
  const debugRecorder = { record: function (t, d) { events.push({ t: t, d: d }); } };
  const dom = new JSDOM('<!doctype html><div data-testid="completed-v1"></div>').window.document;
  const scraper = {
    findItemCompletionIndicator: function (doc, id) {
      return id === 'v1' ? doc.querySelector('[data-testid="completed-v1"]') : null;
    },
  };
  const conf = createConfirmer({ debugRecorder: debugRecorder });
  const ok = await conf.waitForCompletion({ doc: dom, itemId: 'v1', itemKind: 'video', scraper: scraper, timeoutMs: 500, pollIntervalMs: 10 });
  assert.equal(ok, true);
  const types = events.map(function (e) { return e.t; });
  assert.ok(types.indexOf('completion.wait.started') !== -1, 'wait.started recorded');
  const detected = events.find(function (e) { return e.t === 'completion.detected'; });
  assert.ok(detected, 'detected recorded');
  assert.equal(detected.d.itemId, 'v1');
  assert.equal(detected.d.evidence, 'item-indicator');
});

test('confirmer records completion.timeout when nothing matches', async () => {
  const events = [];
  const debugRecorder = { record: function (t, d) { events.push({ t: t, d: d }); } };
  const dom = new JSDOM('<!doctype html><div/>').window.document;
  const scraper = { findItemCompletionIndicator: function () { return null; } };
  const conf = createConfirmer({ debugRecorder: debugRecorder });
  const ok = await conf.waitForCompletion({ doc: dom, itemId: 'v1', itemKind: 'video', scraper: scraper, timeoutMs: 30, pollIntervalMs: 5 });
  assert.equal(ok, false);
  assert.ok(events.some(function (e) { return e.t === 'completion.timeout'; }), 'timeout recorded');
});

test('confirmer never throws even when debugRecorder is undefined (no regression)', async () => {
  const dom = new JSDOM('<!doctype html><div/>').window.document;
  const conf = createConfirmer({});
  const ok = await conf.waitForCompletion({ doc: dom, itemId: 'v1', itemKind: 'video', scraper: { findItemCompletionIndicator: function () { return null; } }, timeoutMs: 30, pollIntervalMs: 5 });
  assert.equal(ok, false);
});
```

(Assumes the existing top-of-file includes `const { JSDOM } = require('jsdom'); const { createConfirmer } = require('../lib/completion-confirmer.js');`. Add them if missing.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test tests/completion-confirmer.test.js`
Expected: FAIL on the detection / timeout assertions because nothing is recorded yet.

- [ ] **Step 3: Modify `lib/completion-confirmer.js`**

In `createConfirmer(deps)`, capture `const debugRecorder = (deps && deps.debugRecorder) || null;`. Add a guarded helper:

```js
function rec(type, details) {
  if (!debugRecorder || typeof debugRecorder.record !== 'function') return;
  try { debugRecorder.record(type, details); } catch (_) {}
}
```

Inside `waitForCompletion(opts)`, immediately after the `pollIntervalMs` line and before the `if (!scraper ...)` guard:

```js
rec('completion.wait.started', { itemId: itemId, itemKind: itemKind, timeoutMs: timeoutMs });
```

Wrap each of the four return-true paths so they record the evidence kind:

```js
if (scraper.findItemCompletionIndicator(doc, itemId)) {
  rec('completion.detected', { itemId: itemId, evidence: 'item-indicator' });
  return true;
}
if (typeof scraper.findGreenCompletionIconInRow === 'function' && scraper.findGreenCompletionIconInRow(doc, itemId)) {
  rec('completion.detected', { itemId: itemId, evidence: 'green-row-icon' });
  return true;
}
if (itemKind === 'reading' && pageFallback
    && typeof pageFallback.findCompletedReadingIndicator === 'function'
    && pageFallback.findCompletedReadingIndicator(doc)) {
  rec('completion.detected', { itemId: itemId, evidence: 'reading-completed' });
  return true;
}
if (baselineProgress && pageFallback) {
  const el = pageFallback.findTopProgressText(doc);
  if (el) {
    const cur = pageFallback.parseProgress(el.textContent);
    if (cur && cur.total === baselineProgress.total && cur.completed > baselineProgress.completed) {
      rec('completion.detected', { itemId: itemId, evidence: 'top-progress' });
      return true;
    }
  }
}
```

At the timeout return: `if (elapsed >= timeoutMs) { rec('completion.timeout', { itemId: itemId, itemKind: itemKind }); return false; }`.

And at the `if (signal && signal.aborted) throw new Error('aborted');` line, record before throwing:

```js
if (signal && signal.aborted) { rec('completion.aborted', { itemId: itemId }); throw new Error('aborted'); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test tests/completion-confirmer.test.js`
Expected: PASS (all previous + 3 new).

---

### Task 6: Wire `debugRecorder` injection into `item-handlers` — video instrumentation

**Files:**
- Modify: `lib/item-handlers.js`
- Test:  `tests/item-handlers.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/item-handlers.test.js`:

```js
test('video fast mode records element/play/duration/seek/outcome events with correct details', async () => {
  const events = [];
  const debugRecorder = { record: function (t, d) { events.push({ t: t, d: d }); } };
  const dom = new JSDOM('<!doctype html><body><video id="v"></video></body>').window.document;
  const v = dom.getElementById('v');
  Object.defineProperty(v, 'duration', { value: 600, configurable: true });
  Object.defineProperty(v, 'currentTime', { value: 0, writable: true, configurable: true });
  v.play = function () { return Promise.resolve(); };
  const h = createHandlers({
    timing: {
      fastVideoTiming: function () { return { mode: 'fast-seek', targetTimeSec: 555, postSeekWaitMs: 1 }; },
      readingDwellMs: function () { return 1; },
      discussionDwellMs: function () { return 1; },
      videoTiming: function () { return { mode: 'play-through', preSkipMs: 0, targetTimeSec: 0, postEndMs: 0 }; },
    },
    sleep: function () { return Promise.resolve(); },
    debugRecorder: debugRecorder,
  });
  const outcome = await h.video({ doc: dom, item: { id: 'vX', title: 'X', kind: 'video' }, rng: function () { return 0.5; }, behaviorMode: 'fast', signal: null });
  assert.equal(outcome.outcome, 'video-done-fast');
  const types = events.map(function (e) { return e.t; });
  assert.ok(types.indexOf('handler.start') !== -1);
  assert.ok(types.indexOf('video.element') !== -1);
  assert.ok(types.indexOf('video.duration.wait.completed') !== -1);
  assert.ok(types.indexOf('video.mode.selected') !== -1);
  assert.ok(types.indexOf('video.seek.requested') !== -1);
  assert.ok(types.indexOf('video.seek.direct.result') !== -1);
  assert.ok(types.indexOf('handler.outcome') !== -1);
  const seekResult = events.find(function (e) { return e.t === 'video.seek.direct.result'; });
  assert.equal(seekResult.d.accepted, true);
  assert.equal(seekResult.d.targetTime, 555);
});

test('video records video.element found=false when no <video> on page', async () => {
  const events = [];
  const debugRecorder = { record: function (t, d) { events.push({ t: t, d: d }); } };
  const dom = new JSDOM('<!doctype html><body></body>').window.document;
  const h = createHandlers({ timing: {}, sleep: function () { return Promise.resolve(); }, debugRecorder: debugRecorder });
  const outcome = await h.video({ doc: dom, item: { id: 'x', kind: 'video' }, rng: function () { return 0; }, behaviorMode: 'fast', signal: null });
  assert.equal(outcome.outcome, 'video-no-element');
  const ve = events.find(function (e) { return e.t === 'video.element'; });
  assert.equal(ve.d.found, false);
});

test('reading records handler.start and handler.outcome', async () => {
  const events = [];
  const debugRecorder = { record: function (t, d) { events.push({ t: t, d: d }); } };
  const dom = new JSDOM('<!doctype html><body><button aria-label="Mark as completed">Mark as completed</button></body>').window.document;
  const h = createHandlers({
    timing: { readingDwellMs: function () { return 1; } },
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
    debugRecorder: debugRecorder,
  });
  const outcome = await h.reading({ doc: dom, item: { id: 'r1', kind: 'reading', title: 'R' }, rng: function () { return 0; }, behaviorMode: 'fast', signal: null });
  assert.ok(/reading/.test(outcome.outcome));
  assert.ok(events.some(function (e) { return e.t === 'handler.start'; }));
  assert.ok(events.some(function (e) { return e.t === 'handler.outcome'; }));
});

test('video handler still works when debugRecorder is omitted (no regression)', async () => {
  const dom = new JSDOM('<!doctype html><body><video id="v"></video></body>').window.document;
  const v = dom.getElementById('v');
  Object.defineProperty(v, 'duration', { value: 600, configurable: true });
  v.play = function () { return Promise.resolve(); };
  const h = createHandlers({
    timing: { fastVideoTiming: function () { return { mode: 'play-through', targetTimeSec: 0, postSeekWaitMs: 1 }; } },
    sleep: function () { return Promise.resolve(); },
  });
  const outcome = await h.video({ doc: dom, item: { id: 'x', kind: 'video' }, rng: function () { return 0; }, behaviorMode: 'fast', signal: null });
  assert.equal(outcome.outcome, 'video-done-fast');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test tests/item-handlers.test.js`
Expected: FAIL — `handler.start` etc. not recorded.

- [ ] **Step 3: Modify `lib/item-handlers.js`**

In `createHandlers(deps)` capture once:

```js
const debugRecorder = (deps && deps.debugRecorder) || null;
function rec(type, details) {
  if (!debugRecorder || typeof debugRecorder.record !== 'function') return;
  try { debugRecorder.record(type, details); } catch (_) {}
}
```

At the top of `async function reading(ctx)`:

```js
rec('handler.start', { itemId: ctx.item && ctx.item.id, title: ctx.item && ctx.item.title, kind: 'reading', behaviorMode: behaviorMode });
```

Replace each `return { outcome: 'reading-...' }` with:

```js
const result = { outcome: 'reading-done-fast' };
rec('handler.outcome', { itemId: ctx.item && ctx.item.id, outcome: result.outcome, mode: behaviorMode });
return result;
```

(Repeat for each return — keep returned outcome strings identical.)

In `async function video(ctx)`:
- Right after `const v = doc.querySelector('video');`:
  ```js
  rec('handler.start', { itemId: ctx.item && ctx.item.id, title: ctx.item && ctx.item.title, kind: 'video', behaviorMode: behaviorMode });
  rec('video.element', { itemId: ctx.item && ctx.item.id, found: !!v });
  if (!v) { rec('handler.outcome', { itemId: ctx.item && ctx.item.id, outcome: 'video-no-element', mode: behaviorMode }); return { outcome: 'video-no-element' }; }
  ```
- Wrap `v.play()` so it records `video.play.requested` before and `video.play.result` in then/catch.
- Modify `waitForVideoDuration` to take a `recItem` argument (or close over `rec`) and record `video.duration.initial` (initial reading), `video.duration.wait.started` if initial wasn't valid, `video.duration.wait.completed` with the final duration + polls count.
- After `timing.fastVideoTiming(duration, rng)`: `rec('video.mode.selected', { itemId, mode: 'fast', timing: t.mode });`
- If `t.mode === 'fast-seek'`, before calling `seekVideoWithFallback`: `rec('video.seek.requested', { itemId, directTarget: t.targetTimeSec, fallbackTarget: t.targetTimeSec, mode: 'fast' });`
- Modify `seekVideoWithFallback` to return a richer object `{ direct, accepted, currentTime, forwardClicks, forwardFound }` so the caller can `rec('video.seek.direct.result', ...)` and `rec('video.seek.forward.result', ...)`. Keep the original `boolean` return signature internally by changing the function's return shape and updating both call sites; do not change handler outcomes.
- Before the final `return { outcome: 'video-done-fast', mode: t.mode };` add `rec('handler.outcome', { itemId, outcome: 'video-done-fast', mode: behaviorMode });`.
- Apply the same `handler.start`/`video.element`/`video.duration.*`/`video.mode.selected`/`video.seek.*`/`handler.outcome` events to the Human path. Keep outcomes (`video-done`, `video-autoplay-blocked`) unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test tests/item-handlers.test.js`
Expected: PASS (existing + 4 new).

---

### Task 7: Wire `debugRecorder` injection into `module-autopilot` — controller events

**Files:**
- Modify: `lib/module-autopilot.js`
- Test:  `tests/module-autopilot.test.js`

- [ ] **Step 1: Write the failing test (A → blocked → C trace)**

Append to `tests/module-autopilot.test.js`:

```js
test('debug recorder captures full A -> blocked B -> safe C trace in chronological order', async () => {
  const { createDebugRecorder } = require('../lib/autopilot-debug.js');
  const debugRecorder = createDebugRecorder({ maxEvents: 500 });

  const html =
    '<div>' +
      '<button class="cds-AccordionHeader-button" aria-controls="m1p"><div>Module 1</div></button>' +
      '<div id="m1p"><ul>' +
        '<li><a href="/learn/x/lecture/vA/access"><div class="outline-single-item-content-wrapper"><div><div>Accessing Parts of a Matrix</div><div>Video. 21 min</div></div></div></a></li>' +
        '<li><a href="/learn/x/gradedLti/aB/matrix-indexing"><div class="outline-single-item-content-wrapper"><div><div>Assignment: Matrix Indexing</div><div>Graded App Item. 15 min</div></div></div></a></li>' +
        '<li><a href="/learn/x/lecture/vC/combining"><div class="outline-single-item-content-wrapper"><div><div>Combining and Transforming Matrices</div><div>Video. 10 min</div></div></div></a></li>' +
      '</ul></div>' +
    '</div>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/vA/access');
  const storage = fakeStorage();
  const handlers = mkFakeHandlers();
  const confirmer = { waitForCompletion: function () { return Promise.resolve(true); } };
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    confirmer: confirmer, debugRecorder: debugRecorder,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function (url) { try { j.window.history.pushState({}, '', url); } catch (_) {} return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
    navigateUrlChangeTimeoutMs: 50,
  });
  await ap.startAllModules();
  await new Promise(function (r) { setTimeout(r, 100); });

  const events = debugRecorder.getEvents();
  const types = events.map(function (e) { return e.type; });

  // Each of these must appear at least once, in this relative order.
  const expected = [
    'run.start.requested',
    'scrape.completed',
    'queue.built',
    'queue.resume.selected',
    'item.run.entered',                       // for vA
    'queue.blocked.skipped',                  // for aB
    'queue.next.safe',                        // points at vC
    'navigation.requested',
    'route.changed',
    'item.run.rerun.scheduled',
    'item.run.rerun.executed',
    'item.run.entered',                       // for vC
  ];
  let cursor = 0;
  expected.forEach(function (name) {
    const i = types.indexOf(name, cursor);
    assert.ok(i !== -1, 'missing event ' + name + ' in: ' + types.join(','));
    cursor = i + 1;
  });

  const aBSkip = events.find(function (e) { return e.type === 'queue.blocked.skipped' && /Matrix Indexing/.test(e.details.title || ''); });
  assert.ok(aBSkip, 'skip event must carry clean title');
  assert.equal(aBSkip.details.blockReason, 'graded item');
});

test('debug recorder records run.paused when handler returns a pause-needed outcome', async () => {
  const { createDebugRecorder } = require('../lib/autopilot-debug.js');
  const debugRecorder = createDebugRecorder();
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/quiz/q1/x');
  const storage = fakeStorage();
  const d = stateMod.defaults(); d.status = 'running'; d.courseId = 'x';
  d.queue = [{ id: 'q1', kind: 'quiz', url: '/learn/x/quiz/q1/x', title: 'Q' }]; d.cursor = 0;
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkFakeHandlers();
  handlers.fallback = function () { return Promise.resolve({ outcome: 'pause-needed-no-answer' }); };
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    debugRecorder: debugRecorder,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.bootIfRunning();
  const types = debugRecorder.getEvents().map(function (e) { return e.type; });
  assert.ok(types.indexOf('run.paused') !== -1, 'run.paused must be recorded');
});

test('autopilot still functions when debugRecorder is omitted (no regression)', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const handlers = mkFakeHandlers();
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.start();
  assert.equal(handlers.calls.length, 1, 'handler still runs without debugRecorder');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test tests/module-autopilot.test.js`
Expected: FAIL — recorder receives no events.

- [ ] **Step 3: Instrument `lib/module-autopilot.js`**

In `createAutopilot(opts)` capture:

```js
const debugRecorder = (opts && opts.debugRecorder) || null;
function rec(type, details) {
  if (!debugRecorder || typeof debugRecorder.record !== 'function') return;
  try { debugRecorder.record(type, details); } catch (_) {}
}
```

Instrument at these exact sites (all are `rec(type, details)` only — never change existing behavior):

| Where | Event |
|-------|-------|
| Top of `start(opts)` | `rec('run.start.requested', { scope: scopeChoice, behaviorMode: undefined, currentUrl: currentUrl() })` (read mode from persisted settings if convenient) |
| Top of `startAllModules()` | `rec('run.start.requested', { scope: 'course', currentUrl: currentUrl() })` |
| Just before each `scraperMod.scrapeModule(doc)` / `scrapeAllModulesWithExpansion()` | `rec('scrape.start', { scope: scopeChoice or 'course', url: currentUrl() })` |
| Just after `scraped` is computed | `rec('scrape.completed', { itemCount: (scraped.items || []).length })` (and `moduleCount` for course) |
| Inside `scrapeAllModulesWithExpansion` for each `header.click()` of a collapsed module | `rec('module.expand.requested', { headerText: textOf(header).slice(0, 80) })` then after re-scrape `rec('module.expand.completed', { itemCount: byId[key].items.length })` |
| After `buildOrderedQueue(...)` returns | `rec('queue.built', { orderedCount: built.queue.length, safeCount: <calc>, blockedCount: <calc>, trimmedResumeCount: <calc> })` |
| After `startCursor` is determined (still in `start()` / `startAllModules()`) | `rec('queue.resume.selected', { cursor: startCursor, itemId, title, kind, reason: 'current-url-match' or 'first-safe' })` |
| In `emitSkipsAndAdvance` — first time we encounter a blocked entry | `rec('queue.blocked.encountered', { cursor, itemId, title, blockReason })` |
| In `emitSkipsAndAdvance` — when we emit the sidebar log line | `rec('queue.blocked.skipped', { cursor, itemId, title, blockReason, logged: !alreadyLogged })` |
| Whenever `cursor` advances (state.update with new cursor) | `rec('queue.cursor.changed', { before: stateNow.cursor, after: newCursor, reason: 'success' or 'blocked-skip' or 'boot-align' })` |
| In success path before `navigateAndConfirm(stateNow.queue[nextCursor].url)` | `rec('queue.next.safe', { cursor: nextCursor, itemId, title, kind })` then `rec('navigation.requested', { from: currentUrl(), target: ..., itemId, title })` |
| Inside `navigateAndConfirm` after returning | `rec('navigation.result', { target, urlChanged: <bool>, rowAnchorFallbackClicked: <bool> })` (Refactor `navigateAndConfirm` to track these flags locally.) |
| In `installRouteWatcher`'s `onMaybeChange` | `rec('route.changed', { from: lastHrefBefore, to: now, source: 'push-or-pop' })` (best-effort — we don't always know source; set `'unknown'`) |
| Top of `bootIfRunning` | `rec('boot.entered', { status: cur.status, cursor: cur.cursor, url: currentUrl() })` |
| Each early-return inside `bootIfRunning` | `rec('boot.exited', { reason: 'idle' or 'foreign-course' or 'foreign-active' or 'off-queue' })` |
| Top of `runCurrentItem`'s async body | `rec('item.run.entered', { cursor: stateNow.cursor, itemId, title, kind, behaviorMode })` |
| In `runCurrentItem` when `if (inFlight)` is hit | `rec('item.run.deferred', { reason: 'inFlight', queuedRun: true })` |
| In the `.finally` when `queuedRun` triggers the `setTimeout` | `rec('item.run.rerun.scheduled', {})` and inside the timeout body, before calling `bootIfRunning()` | `rec('item.run.rerun.executed', {})` |
| Each pause path | `rec('run.paused', { reason: ... })` |
| Module-complete branch | `rec('run.completed', {})` |
| Top of `stop()` | `rec('run.stopped', {})` |
| Each `catch` that pauses for handler error | `rec('run.error', { operation: 'handler', message: e && e.message })` |
| In success path: page-fallback clicks | `rec('pageFallback.markComplete.clicked', { itemId })` / `rec('pageFallback.nextItem.clicked', {})` / `rec('pageFallback.notFound', { itemId })` |

Use `behaviorMode` value from `(stateNow && stateNow.settings && stateNow.settings.behaviorMode) || 'fast'` where available. Never pass page body or answer text into details.

Also expose a context provider so the sidebar's snapshot can include live queue/cursor/status. Add inside `createAutopilot`:

```js
if (debugRecorder && typeof debugRecorder.subscribe === 'function') {
  // nothing — sidebar drives subscription
}
```

Add a tiny public helper on the returned object:

```js
async function getRunSnapshotContext() {
  const cur = await new Promise(function (resolve) { state.load(resolve); });
  return {
    url: currentUrl(),
    status: cur.status,
    behaviorMode: (cur.settings && cur.settings.behaviorMode) || 'fast',
    runScope: cur.runScope || (cur.settings && cur.settings.runScope) || 'module',
    courseId: cur.courseId, moduleId: cur.moduleId,
    cursor: cur.cursor, queueLength: (cur.queue || []).length,
    ownerTabKey: cur.ownerTabKey,
    queue: (cur.queue || []).map(function (it) {
      return {
        id: it.id, title: it.title, kind: it.kind, url: it.url,
        blocked: !!it.blocked, blockReason: it.blockReason || null,
        completed: !!it.completed, skippedLogged: !!(cur.skippedLogged && cur.skippedLogged[it.id]),
      };
    }),
    lastPauseReason: cur.lastPauseReason || null,
  };
}
return {
  // ... existing methods
  getRunSnapshotContext: getRunSnapshotContext,
};
```

When pausing, persist a `lastPauseReason` in `state.update({...})` so the snapshot can surface it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test tests/module-autopilot.test.js`
Expected: PASS (existing + 3 new).

---

### Task 8: Add Diagnostics tab markup + tab activation to sidebar

**Files:**
- Modify: `lib/sidebar.js`
- Test:  `tests/sidebar.test.js` (create if missing)

- [ ] **Step 1: Write the failing tests**

Create `tests/sidebar.test.js` (or append if it already exists):

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

function freshSidebar(htmlUrl) {
  // node --test caches modules between tests; reset by clearing require cache.
  delete require.cache[require.resolve('../lib/sidebar.js')];
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: htmlUrl || 'https://www.coursera.org/learn/x/lecture/v1/intro' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  const sidebar = require('../lib/sidebar.js');
  sidebar.mount();
  const shadow = dom.window.document.getElementById('ccp-host-root').shadowRoot;
  return { sidebar: sidebar, shadow: shadow, dom: dom };
}

test('sidebar exposes a Diagnostics tab that can be activated', () => {
  const { sidebar, shadow } = freshSidebar();
  const tab = shadow.querySelector('[data-tab="diagnostics"]');
  assert.ok(tab, 'Diagnostics tab button must exist');
  sidebar.setActiveTab('diagnostics');
  assert.equal(tab.getAttribute('aria-selected'), 'true');
  const panel = shadow.querySelector('[data-panel="diagnostics"]');
  assert.equal(panel.getAttribute('data-active'), 'true');
});

test('existing tabs and autopilot Run button still exist after Diagnostics is added', () => {
  const { shadow } = freshSidebar();
  assert.ok(shadow.querySelector('[data-tab="copied"]'));
  assert.ok(shadow.querySelector('[data-tab="typer"]'));
  assert.ok(shadow.querySelector('[data-tab="answer"]'));
  assert.ok(shadow.querySelector('[data-tab="autopilot"]'));
  assert.ok(shadow.querySelector('[data-action="autopilot-run"]'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test tests/sidebar.test.js`
Expected: FAIL — `[data-tab="diagnostics"]` is null.

- [ ] **Step 3: Add markup to `lib/sidebar.js`**

In the `HTML` template, in the `<div class="ccp-tabs">` block, after the autopilot tab, add:

```html
<button class="ccp-tab" role="tab" aria-selected="false" data-tab="diagnostics">Diagnostics</button>
```

After the autopilot `<section>` (before `<div class="ccp-modal-backdrop">`), add:

```html
<section class="ccp-panel" data-panel="diagnostics" data-active="false">
  <div class="ccp-diag-header">
    <div><strong>Status:</strong> <span data-role="diag-status">idle</span></div>
    <div><strong>Mode:</strong> <span data-role="diag-mode">fast</span> &nbsp; <strong>Scope:</strong> <span data-role="diag-scope">module</span></div>
    <div><strong>Cursor:</strong> <span data-role="diag-cursor">0</span> / <span data-role="diag-queue-size">0</span></div>
    <div><strong>Current:</strong> <span data-role="diag-current"></span></div>
  </div>
  <div class="ccp-actions">
    <button class="ccp-btn" data-action="diag-copy">Copy debug report</button>
    <button class="ccp-btn" data-variant="ghost" data-action="diag-clear">Clear</button>
  </div>
  <div class="ccp-status" data-role="diag-status-line"></div>
  <div class="ccp-diag-events" data-role="diag-events" style="overflow:auto; max-height:380px; font-family:monospace; font-size:11px;"></div>
</section>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test tests/sidebar.test.js`
Expected: PASS.

---

### Task 9: Sidebar `setDebugRecorder` + live event rendering + status block

**Files:**
- Modify: `lib/sidebar.js`
- Test: `tests/sidebar.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/sidebar.test.js`:

```js
const { createDebugRecorder } = require('../lib/autopilot-debug.js');

test('Diagnostics tab renders events from the injected recorder', () => {
  const { sidebar, shadow } = freshSidebar();
  const rec = createDebugRecorder();
  sidebar.setDebugRecorder(rec);
  rec.record('run.start.requested', { scope: 'course', behaviorMode: 'fast' });
  rec.record('queue.blocked.skipped', { title: 'Assignment: Matrix Indexing', blockReason: 'graded item' });
  const rows = shadow.querySelectorAll('[data-role="diag-events"] .ccp-diag-event');
  assert.equal(rows.length, 2);
  assert.ok(/run\.start\.requested/.test(rows[0].textContent));
  assert.ok(/scope=.?course/.test(rows[0].textContent));
  assert.ok(/queue\.blocked\.skipped/.test(rows[1].textContent));
  assert.ok(/Matrix Indexing/.test(rows[1].textContent));
});

test('setAutopilotRunContext updates the Diagnostics status block', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAutopilotRunContext({ status: 'running', behaviorMode: 'fast', runScope: 'course', cursor: 3, queueLength: 9, currentTitle: 'A', currentKind: 'video' });
  assert.equal(shadow.querySelector('[data-role="diag-status"]').textContent, 'running');
  assert.equal(shadow.querySelector('[data-role="diag-mode"]').textContent, 'fast');
  assert.equal(shadow.querySelector('[data-role="diag-scope"]').textContent, 'course');
  assert.equal(shadow.querySelector('[data-role="diag-cursor"]').textContent, '3');
  assert.equal(shadow.querySelector('[data-role="diag-queue-size"]').textContent, '9');
  assert.equal(shadow.querySelector('[data-role="diag-current"]').textContent, 'A (video)');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test tests/sidebar.test.js`
Expected: FAIL — `setDebugRecorder is not a function`.

- [ ] **Step 3: Implement in `lib/sidebar.js`**

Add module-scoped state near other `let _x` declarations:

```js
let _debugRecorder = null;
let _debugUnsubscribe = null;
```

Add inside or near `wireAutopilot()` (or new `wireDiagnostics()` called from `mount`):

```js
function renderDiagEvent(ev) {
  if (!shadow || !ev) return;
  const box = shadow.querySelector('[data-role="diag-events"]');
  if (!box) return;
  const doc = shadow.ownerDocument || document;
  const line = doc.createElement('div');
  line.className = 'ccp-diag-event';
  line.textContent = (ev.at || '') + ' ' + (ev.type || '') + ' ' + formatDiagDetails(ev.details);
  box.appendChild(line);
  while (box.children.length > 200) box.removeChild(box.firstChild);
  box.scrollTop = box.scrollHeight;
}

function formatDiagDetails(d) {
  if (!d || typeof d !== 'object') return '';
  return Object.keys(d).map(function (k) {
    const v = d[k];
    if (v && typeof v === 'object') return k + '=' + JSON.stringify(v);
    if (typeof v === 'string') return k + '=' + JSON.stringify(v);
    return k + '=' + String(v);
  }).join(' ');
}

function clearDiagEvents() {
  if (!shadow) return;
  const box = shadow.querySelector('[data-role="diag-events"]');
  if (box) while (box.firstChild) box.removeChild(box.firstChild);
}

function setDebugRecorder(rec) {
  if (_debugUnsubscribe) { try { _debugUnsubscribe(); } catch (_) {} _debugUnsubscribe = null; }
  _debugRecorder = rec || null;
  if (!_debugRecorder || typeof _debugRecorder.subscribe !== 'function') return;
  if (!mounted) mount();
  // Render all retained events on attach.
  clearDiagEvents();
  const initial = (typeof _debugRecorder.getEvents === 'function') ? _debugRecorder.getEvents() : [];
  initial.forEach(renderDiagEvent);
  _debugUnsubscribe = _debugRecorder.subscribe(function (ev) {
    if (ev === null) clearDiagEvents();
    else renderDiagEvent(ev);
  });
}

function setAutopilotRunContext(ctx) {
  if (!shadow) return;
  ctx = ctx || {};
  const map = {
    'diag-status': ctx.status || 'idle',
    'diag-mode':   ctx.behaviorMode || 'fast',
    'diag-scope':  ctx.runScope || 'module',
    'diag-cursor': String(ctx.cursor == null ? 0 : ctx.cursor),
    'diag-queue-size': String(ctx.queueLength == null ? 0 : ctx.queueLength),
    'diag-current': ctx.currentTitle ? (ctx.currentTitle + (ctx.currentKind ? ' (' + ctx.currentKind + ')' : '')) : '',
  };
  Object.keys(map).forEach(function (role) {
    const el = shadow.querySelector('[data-role="' + role + '"]');
    if (el) el.textContent = map[role];
  });
}
```

Export them by adding to the `api` object:

```js
const api = {
  // ... existing keys
  setDebugRecorder: setDebugRecorder,
  setAutopilotRunContext: setAutopilotRunContext,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test tests/sidebar.test.js`
Expected: PASS.

---

### Task 10: Sidebar `Copy debug report` + `Clear` buttons

**Files:**
- Modify: `lib/sidebar.js`
- Test: `tests/sidebar.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/sidebar.test.js`:

```js
test('Copy debug report writes formatted text via navigator.clipboard.writeText', async () => {
  const { sidebar, shadow, dom } = freshSidebar();
  const rec = createDebugRecorder();
  sidebar.setDebugRecorder(rec);
  sidebar.setAutopilotRunContext({ status: 'running', behaviorMode: 'fast', runScope: 'course', cursor: 0, queueLength: 1, currentTitle: 'X', currentKind: 'video' });
  rec.record('run.start.requested', { scope: 'course' });

  let copied = null;
  dom.window.navigator.clipboard = { writeText: function (s) { copied = s; return Promise.resolve(); } };

  shadow.querySelector('[data-action="diag-copy"]').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.ok(copied, 'clipboard.writeText must be called');
  assert.ok(/REPORT TIMESTAMP/.test(copied));
  assert.ok(/STATUS\s+running/.test(copied));
  assert.ok(/run\.start\.requested/.test(copied));
  const status = shadow.querySelector('[data-role="diag-status-line"]').textContent;
  assert.ok(/copied|success/i.test(status));
});

test('Copy debug report shows error feedback when clipboard rejects', async () => {
  const { sidebar, shadow, dom } = freshSidebar();
  sidebar.setDebugRecorder(createDebugRecorder());
  dom.window.navigator.clipboard = { writeText: function () { return Promise.reject(new Error('blocked')); } };
  shadow.querySelector('[data-action="diag-copy"]').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  const status = shadow.querySelector('[data-role="diag-status-line"]').textContent;
  assert.ok(/copy failed/i.test(status), 'should show copy failed: ' + status);
});

test('Clear button empties the on-screen events and underlying recorder', () => {
  const { sidebar, shadow } = freshSidebar();
  const rec = createDebugRecorder();
  sidebar.setDebugRecorder(rec);
  rec.record('a', {}); rec.record('b', {});
  shadow.querySelector('[data-action="diag-clear"]').click();
  const rows = shadow.querySelectorAll('[data-role="diag-events"] .ccp-diag-event');
  assert.equal(rows.length, 0);
  assert.deepEqual(rec.getEvents(), []);
});

test('Clear must not affect autopilot Run/Stop buttons or call any autopilot handler', () => {
  const { sidebar, shadow } = freshSidebar();
  let calledStop = false;
  sidebar.setAutopilotHandlers({ onStop: function () { calledStop = true; } });
  sidebar.setDebugRecorder(createDebugRecorder());
  shadow.querySelector('[data-action="diag-clear"]').click();
  assert.equal(calledStop, false, 'Clear must NOT call onStop');
  // Run button still enabled.
  assert.equal(shadow.querySelector('[data-action="autopilot-run"]').disabled, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test tests/sidebar.test.js`
Expected: FAIL — buttons not wired.

- [ ] **Step 3: Wire the buttons in `lib/sidebar.js`**

Inside the existing `wireAutopilot()` (or a new `wireDiagnostics()` called from `mount`), add:

```js
function setDiagStatus(text, tone) {
  const s = shadow.querySelector('[data-role="diag-status-line"]');
  if (!s) return;
  s.textContent = text || '';
  if (tone) s.setAttribute('data-tone', tone); else s.removeAttribute('data-tone');
}

const copyBtn = shadow.querySelector('[data-action="diag-copy"]');
if (copyBtn) {
  copyBtn.addEventListener('click', function () {
    const rec = _debugRecorder;
    const dbg = (typeof window !== 'undefined' && window.ClipboardCleaner && window.ClipboardCleaner.autopilotDebug)
      || (typeof require === 'function' ? require('../lib/autopilot-debug.js') : null);
    if (!rec || !dbg) { setDiagStatus('Diagnostics recorder not attached.', 'error'); return; }
    const snap = rec.snapshot ? rec.snapshot(_lastRunContext || {}) : { capturedAt: new Date().toISOString(), context: _lastRunContext || {}, events: rec.getEvents() };
    const text = dbg.formatDebugReport(snap);
    (navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text)
      : Promise.reject(new Error('clipboard unavailable'))
    ).then(function () {
      setDiagStatus('Debug report copied to clipboard.', 'success');
    }).catch(function (err) {
      setDiagStatus('Copy failed: ' + (err && err.message ? err.message : 'unknown'), 'error');
    });
  });
}
const clearBtn = shadow.querySelector('[data-action="diag-clear"]');
if (clearBtn) {
  clearBtn.addEventListener('click', function () {
    if (_debugRecorder && typeof _debugRecorder.clear === 'function') {
      try { _debugRecorder.clear(); } catch (_) {}
    }
    clearDiagEvents();
    setDiagStatus('Cleared.', 'success');
  });
}
```

Track the last run context for the snapshot:

```js
let _lastRunContext = null;
```

And modify `setAutopilotRunContext` to remember it:

```js
function setAutopilotRunContext(ctx) {
  _lastRunContext = ctx || null;
  // ... existing rendering code
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test tests/sidebar.test.js`
Expected: PASS.

---

### Task 11: Wire one recorder through `content.js`

**Files:**
- Modify: `content.js`

- [ ] **Step 1: Edit `content.js`**

Inside `startAutopilot()`, immediately after the `const storage = ...` line, add:

```js
let debugRecorder = null;
if (a.autopilotDebug && typeof a.autopilotDebug.createDebugRecorder === 'function') {
  try { debugRecorder = a.autopilotDebug.createDebugRecorder({ maxEvents: 500 }); } catch (_) { debugRecorder = null; }
}
```

Pass it into `createConfirmer({})`, `createHandlers({ ..., debugRecorder: debugRecorder })`, and `createAutopilot({ ..., debugRecorder: debugRecorder })`.

Register with the sidebar:

```js
if (debugRecorder && typeof a.sidebar.setDebugRecorder === 'function') {
  try { a.sidebar.setDebugRecorder(debugRecorder); } catch (_) {}
}
```

After `_autopilotInstance.bootIfRunning();`, hook up a periodic refresh of the sidebar status block from the autopilot snapshot:

```js
if (debugRecorder && a.sidebar.setAutopilotRunContext && _autopilotInstance.getRunSnapshotContext) {
  setInterval(function () {
    _autopilotInstance.getRunSnapshotContext().then(function (ctx) {
      try { a.sidebar.setAutopilotRunContext(Object.assign({}, ctx, { currentTitle: ctx.queue && ctx.queue[ctx.cursor] && ctx.queue[ctx.cursor].title, currentKind: ctx.queue && ctx.queue[ctx.cursor] && ctx.queue[ctx.cursor].kind })); } catch (_) {}
    }).catch(function () { /* swallow */ });
  }, 2000);
}
```

- [ ] **Step 2: No new tests — covered indirectly by sidebar + autopilot integration tests.**

---

### Task 12: Persist last pause/stuck reason in state

**Files:**
- Modify: `lib/autopilot-state.js`
- Modify: `lib/module-autopilot.js`

- [ ] **Step 1: Update defaults**

In `lib/autopilot-state.js` `defaults()`, add `lastPauseReason: null,` so older state shapes survive the shallow merge.

- [ ] **Step 2: Plumb in autopilot**

In `lib/module-autopilot.js`, wherever the code pauses (`state.update({ status: 'paused', ownerTabKey: null }, ...)`), include `lastPauseReason: <message>`. For success completion, set `lastPauseReason: null`.

- [ ] **Step 3: No tests directly here**

(Snapshot test in `tests/module-autopilot.test.js` Task 7 indirectly exercises this via `run.paused` event payload; the field surfaces in the formatter via `LAST PAUSE`.)

---

### Task 13: Consecutive-blocked and trailing-blocked instrumentation tests

**Files:**
- Modify: `tests/module-autopilot.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/module-autopilot.test.js`:

```js
test('debug recorder emits one queue.blocked.skipped event per blocked row, in order', async () => {
  const { createDebugRecorder } = require('../lib/autopilot-debug.js');
  const debugRecorder = createDebugRecorder();
  // A -> B1 (blocked) -> B2 (blocked) -> C.
  const html =
    '<div>' +
      '<button class="cds-AccordionHeader-button" aria-controls="m1p"><div>Module 1</div></button>' +
      '<div id="m1p"><ul>' +
        '<li><a href="/learn/x/lecture/vA/x"><div class="outline-single-item-content-wrapper"><div><div>A</div><div>Video. 5 min</div></div></div></a></li>' +
        '<li><a href="/learn/x/gradedLti/b1/x"><div class="outline-single-item-content-wrapper"><div><div>Assignment B1</div><div>Graded App Item. 15 min</div></div></div></a></li>' +
        '<li><a href="/learn/x/quiz/b2/x"><div class="outline-single-item-content-wrapper"><div><div>Quiz B2</div><div>Quiz. 10 min</div></div></div></a></li>' +
        '<li><a href="/learn/x/lecture/vC/x"><div class="outline-single-item-content-wrapper"><div><div>C</div><div>Video. 5 min</div></div></div></a></li>' +
      '</ul></div>' +
    '</div>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/vA/x');
  const storage = fakeStorage();
  const handlers = mkFakeHandlers();
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    confirmer: { waitForCompletion: function () { return Promise.resolve(true); } },
    debugRecorder: debugRecorder,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function (url) { try { j.window.history.pushState({}, '', url); } catch (_) {} return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
    navigateUrlChangeTimeoutMs: 50,
  });
  await ap.startAllModules();
  await new Promise(function (r) { setTimeout(r, 100); });
  const skipped = debugRecorder.getEvents().filter(function (e) { return e.type === 'queue.blocked.skipped'; });
  assert.equal(skipped.length, 2);
  assert.equal(skipped[0].details.title, 'Assignment B1');
  assert.equal(skipped[1].details.title, 'Quiz B2');
});

test('debug recorder emits run.completed when trailing blocked rows finish the run', async () => {
  const { createDebugRecorder } = require('../lib/autopilot-debug.js');
  const debugRecorder = createDebugRecorder();
  const html =
    '<div>' +
      '<button class="cds-AccordionHeader-button" aria-controls="m1p"><div>Module 1</div></button>' +
      '<div id="m1p"><ul>' +
        '<li><a href="/learn/x/lecture/vA/x"><div class="outline-single-item-content-wrapper"><div><div>A</div><div>Video. 5 min</div></div></div></a></li>' +
        '<li><a href="/learn/x/gradedLti/b1/x"><div class="outline-single-item-content-wrapper"><div><div>Final B</div><div>Graded App Item. 15 min</div></div></div></a></li>' +
      '</ul></div>' +
    '</div>';
  const j = makePage(html, 'https://www.coursera.org/learn/x/lecture/vA/x');
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: fakeStorage(), handlers: mkFakeHandlers(),
    confirmer: { waitForCompletion: function () { return Promise.resolve(true); } },
    debugRecorder: debugRecorder,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    sessionStorage: fakeSessionStorage(),
    navigate: function (url) { try { j.window.history.pushState({}, '', url); } catch (_) {} return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
    navigateUrlChangeTimeoutMs: 50,
  });
  await ap.startAllModules();
  await new Promise(function (r) { setTimeout(r, 100); });
  assert.ok(debugRecorder.getEvents().some(function (e) { return e.type === 'run.completed'; }));
});
```

- [ ] **Step 2: Run + verify pass.**

Run: `npx node --test tests/module-autopilot.test.js`
Expected: PASS.

---

### Task 14: Final full-suite verification

**Files:** none

- [ ] **Step 1: Run the focused suites**

```bash
npx node --test tests/autopilot-debug.test.js tests/sidebar.test.js tests/completion-confirmer.test.js tests/item-handlers.test.js tests/module-autopilot.test.js tests/module-scraper.test.js tests/autopilot-state.test.js
```

Expected: 0 failures across all of the above.

- [ ] **Step 2: Run the full suite**

```bash
npm test
```

Expected: total previous + all newly added tests passing, 0 failures. Baseline was 601; after this plan it should land roughly at **~635–650 passing** depending on exact test count (13 recorder/formatter tests + 3 autopilot trace tests + 4 handler tests + 3 confirmer tests + ~7 sidebar tests + 2 consecutive/trailing tests = ~32 new tests).

- [ ] **Step 3: Smoke test (manual, optional but recommended)**

Load the unpacked extension in Chrome, open a Coursera course, click `Finish all modules` from `Accessing Parts of a Matrix`, switch to the new `Diagnostics` tab while it runs, watch events stream in, then click `Copy debug report` and confirm a structured plain-text report lands on the clipboard.

- [ ] **Step 4: Do NOT commit or push unless the user explicitly asks.**

---

## Final Report Template (use after implementation)

When implementation is finished, summarize for the user:

- **Architecture chosen:** single in-memory `createDebugRecorder()` in `lib/autopilot-debug.js`, dependency-injected from `content.js` into module-autopilot, item-handlers, completion-confirmer, and sidebar; pure `formatDebugReport(snapshot)` formatter.
- **Files created:** `lib/autopilot-debug.js`, `tests/autopilot-debug.test.js`, `tests/sidebar.test.js`.
- **Files modified:** `manifest.json`, `content.js`, `lib/sidebar.js`, `lib/module-autopilot.js`, `lib/item-handlers.js`, `lib/completion-confirmer.js`, `lib/autopilot-state.js`, `tests/module-autopilot.test.js`, `tests/item-handlers.test.js`, `tests/completion-confirmer.test.js`.
- **Events instrumented:** all controller/queue/navigation/boot/run-state types from §5 of the spec; video element/play/duration/seek/mode/outcome on both Fast and Human paths; reading start/outcome; completion wait.started/detected/timeout/aborted with evidence kinds; page-fallback markComplete/nextItem/notFound.
- **Tests added:** count from Task 14.
- **Final passing count:** report the actual `npm test` count.
- **How to use during real smoke test:** open Coursera, click `Finish all modules` near `Accessing Parts of a Matrix`, open the `Diagnostics` tab, observe the live timeline, click `Copy debug report` if the run stalls, and paste the report into the bug context for the next iteration.
- **Confirm:** no commit, no push.
