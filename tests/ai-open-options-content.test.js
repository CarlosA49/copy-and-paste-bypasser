'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenOptionsCallback } = require('../lib/ai-open-options-content.js');

function fakeRuntime(behavior) {
  const sent = [];
  return {
    sent: sent,
    sendMessage: function (msg, cb) {
      sent.push(msg);
      Promise.resolve(behavior(msg)).then(function (res) { if (cb) cb(res); });
    },
  };
}

test('U11-1: createOpenOptionsCallback returns a function', () => {
  const fn = createOpenOptionsCallback({ runtime: fakeRuntime(function () { return { ok: true }; }) });
  assert.equal(typeof fn, 'function');
});

test('U11-1: invoking the callback sends EXACTLY {type:"ccp.ai.openOptions"}', () => {
  const rt = fakeRuntime(function () { return { ok: true }; });
  const fn = createOpenOptionsCallback({ runtime: rt });
  fn(function () {});
  assert.equal(rt.sent.length, 1);
  assert.deepEqual(rt.sent[0], { type: 'ccp.ai.openOptions' });
});

test('U11-1: callback NEVER calls chrome.runtime.openOptionsPage()', () => {
  const rt = fakeRuntime(function () { return { ok: true }; });
  assert.equal(typeof rt.openOptionsPage, 'undefined');
  const fn = createOpenOptionsCallback({ runtime: rt });
  fn(function () {});
  assert.equal(rt.sent.length, 1);
});

test('U11-1: callback forwards the response to onResult', async () => {
  const rt = fakeRuntime(function () { return { ok: true }; });
  const fn = createOpenOptionsCallback({ runtime: rt });
  const got = await new Promise(function (r) { fn(r); });
  assert.deepEqual(got, { ok: true });
});

test('U11-1: callback forwards a failure response to onResult', async () => {
  const rt = fakeRuntime(function () { return { ok: false, reason: 'open-options-failed' }; });
  const fn = createOpenOptionsCallback({ runtime: rt });
  const got = await new Promise(function (r) { fn(r); });
  assert.deepEqual(got, { ok: false, reason: 'open-options-failed' });
});

test('U11-1: missing/undefined response is normalized to {ok:false, reason:"no-response"}', async () => {
  const rt = fakeRuntime(function () { return undefined; });
  const fn = createOpenOptionsCallback({ runtime: rt });
  const got = await new Promise(function (r) { fn(r); });
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'no-response');
});

test('U11-1: thrown send error normalizes to {ok:false, reason:"send-failed"}', async () => {
  const throwingRuntime = {
    sendMessage: function () { throw new Error('boom'); },
  };
  const fn = createOpenOptionsCallback({ runtime: throwingRuntime });
  const got = await new Promise(function (r) { fn(r); });
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'send-failed');
});

test('U11-1: no onResult callback is a safe no-op (no throw)', () => {
  const rt = fakeRuntime(function () { return { ok: true }; });
  const fn = createOpenOptionsCallback({ runtime: rt });
  assert.doesNotThrow(function () { fn(); });
});

test('U11-1: missing runtime dependency is a safe no-op invocation', () => {
  const fn = createOpenOptionsCallback({});
  let got = null;
  assert.doesNotThrow(function () { fn(function (r) { got = r; }); });
  assert.equal(got && got.ok, false);
});

test('U11-1: request payload contains no key, balance, account, token, or credit', () => {
  const rt = fakeRuntime(function () { return { ok: true }; });
  const fn = createOpenOptionsCallback({ runtime: rt });
  fn(function () {});
  const payload = JSON.stringify(rt.sent[0]);
  ['sk-', 'balance', 'account', 'token', 'credit', 'key'].forEach(function (forbidden) {
    assert.equal(payload.toLowerCase().indexOf(forbidden), -1,
      'forbidden substring in open-options request: ' + forbidden);
  });
});

// === U11 production-source regression — content.js must NOT call openOptionsPage directly ===

function stripJsComments(src) {
  // Remove /* ... */ block comments first, then // line comments.
  // This is intentionally simple — it does not handle comment-like substrings
  // inside string literals, but production source under test never contains
  // a string literal of the form "chrome.runtime.openOptionsPage(".
  var noBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlock.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

test('U11-1: content.js contains NO direct chrome.runtime.openOptionsPage() call after the fix', () => {
  const fs = require('fs'); const path = require('path');
  const src = stripJsComments(fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8'));
  const callPattern = /chrome\.runtime\.openOptionsPage\s*\(/;
  assert.equal(callPattern.test(src), false,
    'content.js must not call chrome.runtime.openOptionsPage() directly — that API is not callable from a content script in MV3. The settings path must delegate through createOpenOptionsCallback.');
});

test('U11-1: content.js wires openOptionsFn through the sanitized helper (createOpenOptionsCallback)', () => {
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  assert.ok(/createOpenOptionsCallback/.test(src),
    'content.js must reference createOpenOptionsCallback so the settings path delegates through the helper');
  assert.ok(/aiOpenOptionsContent/.test(src),
    'content.js must reference window.ClipboardCleaner.aiOpenOptionsContent via the local `a` alias');
});

test('U11-1: only background.js performs chrome.runtime.openOptionsPage() in production source', () => {
  const fs = require('fs'); const path = require('path');
  const root = path.join(__dirname, '..');
  const callPattern = /chrome\.runtime\.openOptionsPage\s*\(/;
  const forbidden = [
    'content.js',
    'options.js',
    'lib/ai-answer-controller.js',
    'lib/ai-options-controller.js',
    'lib/ai-content-listeners.js',
    'lib/ai-open-options-content.js',
    'lib/sidebar.js',
    'lib/ai-background-service.js',
  ];
  for (const rel of forbidden) {
    const src = stripJsComments(fs.readFileSync(path.join(root, rel), 'utf8'));
    assert.equal(callPattern.test(src), false,
      rel + ' must not call chrome.runtime.openOptionsPage() — only background.js may');
  }
  const bg = stripJsComments(fs.readFileSync(path.join(root, 'background.js'), 'utf8'));
  const matches = bg.match(/chrome\.runtime\.openOptionsPage\s*\(/g) || [];
  assert.ok(matches.length >= 1,
    'background.js must invoke chrome.runtime.openOptionsPage() at least once (the only authorized production path)');
});
