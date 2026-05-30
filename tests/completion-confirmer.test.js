// tests/completion-confirmer.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
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
  let now = 0;
  const sleep = function (ms) { now += ms; return Promise.resolve(); };
  const confirmer = createConfirmer({ sleep: sleep, nowFn: function () { return now; } });
  const ok = await confirmer.waitForCompletion({
    doc: {}, itemId: 'v1', scraper: scraper,
    signal: mkSignal(), timeoutMs: 100, pollIntervalMs: 20,
  });
  assert.equal(ok, false);
  assert.ok(calls >= 5 && calls <= 6, 'expected ~5-6 polls, got ' + calls);
});

test('waitForCompletion rejects when the abort signal fires mid-poll', async () => {
  const scraper = { findItemCompletionIndicator: function () { return null; } };
  const sig = mkSignal();
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

test('waitForCompletion: top-progress count increase counts as confirmation', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM('<!doctype html><html><body><div data-prog>0/3 learning items</div></body></html>');
  const doc = j.window.document;
  const scraper = {
    findItemCompletionIndicator: function () { return null; },
  };
  const pageFallback = require('../lib/page-fallback.js');
  let polls = 0;
  const sleep = function () {
    polls += 1;
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

test('waitForCompletion: reading page Completed indicator confirms a reading after Mark as completed', async () => {
  const j = new JSDOM('<!doctype html><html><body><h3 aria-label="Reading completed">Completed</h3></body></html>');
  const pageFallback = require('../lib/page-fallback.js');
  const scraper = { findItemCompletionIndicator: function () { return null; } };
  const confirmer = createConfirmer({ sleep: function () { return Promise.resolve(); } });
  const ok = await confirmer.waitForCompletion({
    doc: j.window.document,
    itemId: 'r1',
    itemKind: 'reading',
    scraper: scraper,
    pageFallback: pageFallback,
    signal: mkSignal(),
    timeoutMs: 100,
    pollIntervalMs: 1,
  });
  assert.equal(ok, true);
});

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

test('waitForCompletion detects completion via the accessibleName status token (courseraDom)', async () => {
  const { createConfirmer } = require('../lib/completion-confirmer.js');
  const courseraDom = require('../lib/coursera-dom.js');
  const { JSDOM } = require('jsdom');
  const doc = new JSDOM(
    '<!doctype html><html><body>' +
      '<a href="/learn/x/lecture/v1/intro" aria-label="Video, Intro, Completed, 2 min">Intro</a>' +
    '</body></html>',
    { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' }
  ).window.document;
  // No legacy indicator: the green-icon and item-indicator paths return null.
  const scraper = {
    findItemCompletionIndicator: function () { return null; },
    findGreenCompletionIconInRow: function () { return null; },
  };
  let t = 0;
  const confirmer = createConfirmer({
    sleep: function () { t += 1000; return Promise.resolve(); },
    nowFn: function () { return t; },
  });
  const done = await confirmer.waitForCompletion({
    doc: doc,
    itemId: 'v1',
    itemKind: 'video',
    scraper: scraper,
    courseraDom: courseraDom,
    timeoutMs: 5000,
    pollIntervalMs: 1000,
  });
  assert.equal(done, true);
});

test('waitForCompletion detects completion via a nav progressbar reaching 100% (courseraDom)', async () => {
  const { createConfirmer } = require('../lib/completion-confirmer.js');
  const courseraDom = require('../lib/coursera-dom.js');
  const { JSDOM } = require('jsdom');
  const doc = new JSDOM(
    '<!doctype html><html><body>' +
      '<a href="/learn/x/lecture/v1/intro" aria-label="Video, Intro, Not submitted, 2 min">Intro</a>' +
      '<div role="navigation"><div role="progressbar" aria-valuenow="100" aria-valuemax="100"></div></div>' +
    '</body></html>',
    { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' }
  ).window.document;
  const scraper = {
    findItemCompletionIndicator: function () { return null; },
    findGreenCompletionIconInRow: function () { return null; },
  };
  let t = 0;
  const confirmer = createConfirmer({
    sleep: function () { t += 1000; return Promise.resolve(); },
    nowFn: function () { return t; },
  });
  const done = await confirmer.waitForCompletion({
    doc: doc,
    itemId: 'v1',
    itemKind: 'video',
    scraper: scraper,
    courseraDom: courseraDom,
    timeoutMs: 5000,
    pollIntervalMs: 1000,
  });
  assert.equal(done, true);
});

test('waitForCompletion still times out when no evidence at all is present', async () => {
  const { createConfirmer } = require('../lib/completion-confirmer.js');
  const courseraDom = require('../lib/coursera-dom.js');
  const { JSDOM } = require('jsdom');
  const doc = new JSDOM(
    '<!doctype html><html><body>' +
      '<a href="/learn/x/lecture/v1/intro" aria-label="Video, Intro, Not submitted, 2 min">Intro</a>' +
    '</body></html>',
    { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' }
  ).window.document;
  const scraper = {
    findItemCompletionIndicator: function () { return null; },
    findGreenCompletionIconInRow: function () { return null; },
  };
  let t = 0;
  const confirmer = createConfirmer({
    sleep: function () { t += 1000; return Promise.resolve(); },
    nowFn: function () { return t; },
  });
  const done = await confirmer.waitForCompletion({
    doc: doc,
    itemId: 'v1',
    itemKind: 'video',
    scraper: scraper,
    courseraDom: courseraDom,
    timeoutMs: 3000,
    pollIntervalMs: 1000,
  });
  assert.equal(done, false);
});
