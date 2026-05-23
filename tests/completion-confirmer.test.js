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
