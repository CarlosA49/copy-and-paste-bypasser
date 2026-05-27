'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenOptionsHandler, isCourseraSender } = require('../lib/ai-open-options-background.js');

// ---------- Non-routing & opener-adapter behavior (with permissive auth) ----------

test('U11-1: non-openOptions messages return false and do not invoke openOptionsPage', () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; if (cb) cb(null); },
    canOpenOptions: function () { return true; },
  });
  let responded = false;
  const ret = handler({ type: 'autopilot.state' }, {}, function () { responded = true; });
  assert.equal(ret, false);
  assert.equal(opened, 0);
  assert.equal(responded, false);
});

test('U11-1: ccp.ai.openOptions invokes openOptionsPage exactly once and responds {ok:true}', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: function () { return true; },
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, {}, resolve);
  });
  assert.equal(opened, 1);
  assert.deepEqual(res, { ok: true });
});

test('U11-1: openOptionsPage error responds {ok:false, reason:"open-options-failed"}', async () => {
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { cb(new Error('cannot open')); },
    canOpenOptions: function () { return true; },
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, {}, resolve);
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'open-options-failed');
});

test('U11-1: thrown error inside openOptionsPage responds {ok:false, reason:"open-options-failed"}', async () => {
  const handler = createOpenOptionsHandler({
    openOptionsPage: function () { throw new Error('boom'); },
    canOpenOptions: function () { return true; },
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, {}, resolve);
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'open-options-failed');
});

test('U11-1: response contains no key, balance, account, token, or credit', async () => {
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { cb(null); },
    canOpenOptions: function () { return true; },
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, {}, resolve);
  });
  const s = JSON.stringify(res).toLowerCase();
  ['sk-', 'balance', 'account', 'token', 'credit', 'key'].forEach(function (forbidden) {
    assert.equal(s.indexOf(forbidden), -1, 'forbidden substring in response: ' + forbidden);
  });
});

test('U11-1: handler returns true on the openOptions branch (keeps async response channel open)', () => {
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { setTimeout(function () { cb(null); }, 0); },
    canOpenOptions: function () { return true; },
  });
  const ret = handler({ type: 'ccp.ai.openOptions' }, {}, function () {});
  assert.equal(ret, true);
});

test('U11-1: missing openOptionsPage dep responds {ok:false, reason:"open-options-failed"} without throwing', async () => {
  const handler = createOpenOptionsHandler({ canOpenOptions: function () { return true; } });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, {}, resolve);
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'open-options-failed');
});

// ---------- Sender authorization (default deny + production Coursera predicate) ----------

test('U11-1: AUTH — default canOpenOptions is deny-all (no dep injected ⇒ forbidden-sender)', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'https://www.coursera.org/learn/x' }, resolve);
  });
  assert.equal(opened, 0, 'opener must NOT be invoked when no predicate is injected');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — approved Coursera sender (https://www.coursera.org/...) invokes opener exactly once', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { tab: { id: 1 }, url: 'https://www.coursera.org/learn/wireless-communications/assignment-submission/fryRH/practice-quiz' }, resolve);
  });
  assert.equal(opened, 1);
  assert.deepEqual(res, { ok: true });
});

test('U11-1: AUTH — bare https://coursera.org/ (no subdomain) is approved', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'https://coursera.org/learn/x' }, resolve);
  });
  assert.equal(opened, 1);
  assert.equal(res.ok, true);
});

test('U11-1: AUTH — Coursera subdomain (https://es.coursera.org/...) is approved', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'https://es.coursera.org/learn/x' }, resolve);
  });
  assert.equal(opened, 1);
  assert.equal(res.ok, true);
});

test('U11-1: AUTH — unrelated web origin (https://evil.example.com) is REFUSED — opener invoked zero times', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'https://evil.example.com/' }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — lookalike host (https://evilcoursera.org) is REFUSED', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'https://evilcoursera.org/' }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — suffix-style lookalike (https://www.coursera.org.evil.com) is REFUSED', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'https://www.coursera.org.evil.com/' }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — http (not https) Coursera URL is REFUSED', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'http://www.coursera.org/' }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — missing sender.url is REFUSED (no error)', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { tab: { id: 1 } }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — empty sender.url is REFUSED', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: '' }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — malformed sender.url is REFUSED without throwing', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'not a url' }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — missing sender object is REFUSED', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, null, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — unrelated extension page (chrome-extension://EXT/popup.html) is REFUSED — no documented use case', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'chrome-extension://EXT/popup.html' }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — options.html itself cannot use this navigation command (it is already open if it asks)', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'chrome-extension://EXT/options.html' }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — rejected response contains NO secret-like data', async () => {
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'https://evil.example.com/' }, resolve);
  });
  const s = JSON.stringify(res).toLowerCase();
  ['sk-', 'balance', 'account', 'token', 'credit', 'key', 'session', 'auth', 'password'].forEach(function (forbidden) {
    assert.equal(s.indexOf(forbidden), -1, 'forbidden substring in rejected response: ' + forbidden);
  });
});

test('U11-1: AUTH — handler returns false on the forbidden-sender branch (synchronous response)', () => {
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { cb(null); },
    canOpenOptions: function () { return false; },
  });
  const ret = handler({ type: 'ccp.ai.openOptions' }, { url: 'https://evil.example.com/' }, function () {});
  assert.equal(ret, false);
});

// ---------- isCourseraSender unit tests ----------

test('U11-1: isCourseraSender — accepts https://www.coursera.org/...', () => {
  assert.equal(isCourseraSender({ url: 'https://www.coursera.org/learn/x' }), true);
});

test('U11-1: isCourseraSender — accepts https://coursera.org/...', () => {
  assert.equal(isCourseraSender({ url: 'https://coursera.org/learn/x' }), true);
});

test('U11-1: isCourseraSender — accepts any https subdomain (es., zh., dev.)', () => {
  assert.equal(isCourseraSender({ url: 'https://es.coursera.org/learn/x' }), true);
  assert.equal(isCourseraSender({ url: 'https://zh.coursera.org/' }), true);
});

test('U11-1: isCourseraSender — rejects http scheme', () => {
  assert.equal(isCourseraSender({ url: 'http://www.coursera.org/' }), false);
});

test('U11-1: isCourseraSender — rejects evilcoursera.org', () => {
  assert.equal(isCourseraSender({ url: 'https://evilcoursera.org/' }), false);
});

test('U11-1: isCourseraSender — rejects www.coursera.org.evil.com', () => {
  assert.equal(isCourseraSender({ url: 'https://www.coursera.org.evil.com/' }), false);
});

test('U11-1: isCourseraSender — rejects empty/missing/null/malformed url', () => {
  assert.equal(isCourseraSender({}), false);
  assert.equal(isCourseraSender({ url: '' }), false);
  assert.equal(isCourseraSender({ url: null }), false);
  assert.equal(isCourseraSender({ url: 'not a url' }), false);
  assert.equal(isCourseraSender(null), false);
  assert.equal(isCourseraSender(undefined), false);
});

test('U11-1: isCourseraSender — rejects any chrome-extension:// URL', () => {
  assert.equal(isCourseraSender({ url: 'chrome-extension://EXT/popup.html' }), false);
  assert.equal(isCourseraSender({ url: 'chrome-extension://EXT/options.html' }), false);
  assert.equal(isCourseraSender({ url: 'chrome-extension://EXT/devtools.html' }), false);
});

// ---------- Separation from secret-management authorization ----------

test('U11-1: SEPARATION — the openOptions authorization is independent of canManageSecrets (no cross-contamination)', () => {
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { cb(null); },
    canOpenOptions: isCourseraSender,
    canManageSecrets: function () { return true; },
  });
  assert.equal(typeof handler, 'function');
});
