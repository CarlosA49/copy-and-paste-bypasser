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
    '<a href="/learn/x/lecture/v2/two">Lecture Two</a>' +
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
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [{ id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' }];
  d.cursor = 0;
  d.ownerTabKey = 'tab-A';
  d.heartbeatAt = 1_000_000 - 1000;
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
  assert.ok(bannerText.length > 0, 'should show some banner about another tab');
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
  d.courseId = 'x';
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

test('pause during handler: cursor not advanced after handler completes', async () => {
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

  let apRef = null;
  const handlers = {
    video: async function (ctx) {
      // Simulate: pause() fires mid-handler. We call it via the controller reference.
      await apRef.pause('test pause during handler');
      // Handler still completes — this is the race the fix guards against.
      return { outcome: 'video-done', mode: 'play-through' };
    },
    reading: function () { throw new Error('reading should not run'); },
    discussion: function () { throw new Error('discussion should not run'); },
    fallback: function () { throw new Error('fallback should not run'); },
  };

  const navTargets = [];
  apRef = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function (url) { navTargets.push(url); return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await apRef.bootIfRunning();
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.cursor, 0, 'cursor should NOT advance when paused mid-handler');
  assert.equal(after.status, 'paused', 'status should be paused');
  assert.equal(navTargets.length, 0, 'navigate should NOT be called');
});

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

function mkConfirmer(behavior) {
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
  handlers.tryMarkCompleteFallback = function () { return false; };
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
  assert.equal(after.status, 'paused');
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
  const confirmer = mkConfirmer(function () { return true; });
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
  assert.ok(summary.indexOf('No items found') !== -1 && summary.indexOf('candidate') !== -1,
    'diagnostic should include "No items found" and "candidate" in the log message');
});

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

test('bootIfRunning: stale-heartbeat foreign owner is auto-taken-over', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' },
    { id: 'v2', kind: 'video', url: '/learn/x/lecture/v2/outro', title: 'Outro' },
  ];
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
  assert.equal(after.ownerTabKey, 'tab-fresh', 'ownership should be with tab-fresh after takeover');
});

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

test('takeOver(): force-claims ownership from a foreign-fresh tab and runs', async () => {
  const j = makePage(MODULE_HTML, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Intro' },
    { id: 'v2', kind: 'video', url: '/learn/x/lecture/v2/outro', title: 'Outro' },
  ];
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
    confirmer: { waitForCompletion: function () { return Promise.resolve(false); } },
  });
  await ap.start();
  const got = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  // queue is [r1, v2], current URL is v2 → cursor should be 1.
  // confirmer returns false so runCurrentItem enters the pause-needed path and
  // does NOT advance the cursor — the assertion holds at 1.
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

test('Fast mode video: primary confirmer timeout is 5s, advances quickly when green icon present', async () => {
  const html =
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/x/lecture/v1/intro">Intro</a>' +
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
    navigateUrlChangeTimeoutMs: 50,
  });
  await ap.bootIfRunning();
  await new Promise(function (r) { setTimeout(r, 100); });
  assert.equal(anchorClicked, true, 'should click the row anchor pointing to the queued URL');
});

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
  j.window.history.pushState({}, '', '/learn/x/supplement/r1/reading');
  await Promise.resolve();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(handlers.calls.find(function (c) { return c.kind === 'reading'; }) ? true : false, true);
});

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
