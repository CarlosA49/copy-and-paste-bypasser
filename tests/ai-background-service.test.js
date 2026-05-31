'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiBackgroundService } = require('../lib/ai-background-service.js');

function fakeStorage() {
  const store = {};
  return {
    _store: store,
    get: function (keys, cb) {
      const out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { out[k] = store[k]; });
      cb(out);
    },
    set: function (items, cb) {
      Object.keys(items).forEach(function (k) { store[k] = items[k]; });
      if (cb) cb();
    },
    remove: function (keys, cb) {
      (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete store[k]; });
      if (cb) cb();
    },
  };
}

function fakeClient(behavior) {
  return { generateAnswers: behavior };
}

function call(svc, cmd, params) {
  return new Promise(function (resolve) {
    svc.handleMessage({ type: 'ccp.ai.request', command: cmd, params: params || {} }, {}, resolve);
  });
}

test('non-AI message returns false and does not respond', () => {
  const svc = createAiBackgroundService({ storageSession: fakeStorage(), storageLocal: fakeStorage(), clientFactory: function () { return fakeClient(function () {}); } });
  let called = false;
  const ret = svc.handleMessage({ type: 'autopilot.state', command: 'foo', params: {} }, {}, function () { called = true; });
  assert.equal(ret, false);
  assert.equal(called, false);
});

test('setSessionKey without remember writes session-key entry', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  const svc = createAiBackgroundService({ storageSession: session, storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await call(svc, 'setSessionKey', { key: 'sk-stub', remember: false });
  assert.equal(res.ok, true);
  assert.equal(res.keyPresent, true);
  assert.equal(session._store['ccp.ai.sessionKey'], 'sk-stub');
});

test('setSessionKey with remember=true ALSO writes local copy', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  const svc = createAiBackgroundService({ storageSession: session, storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await call(svc, 'setSessionKey', { key: 'sk-stub', remember: true });
  assert.equal(res.ok, true);
  assert.equal(local._store['ccp.ai.localKey'], 'sk-stub');
});

test('clearKey removes both session and local entries', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'a';
  local._store['ccp.ai.localKey'] = 'b';
  const svc = createAiBackgroundService({ storageSession: session, storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await call(svc, 'clearKey', {});
  assert.equal(res.ok, true);
  assert.equal(res.keyPresent, false);
  assert.equal(session._store['ccp.ai.sessionKey'], undefined);
  assert.equal(local._store['ccp.ai.localKey'], undefined);
});

test('keyStatus returns keyPresent boolean, never the key contents', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-DO-NOT-LEAK-12345';
  const svc = createAiBackgroundService({ storageSession: session, storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await call(svc, 'keyStatus', {});
  assert.equal(res.ok, true);
  assert.equal(res.keyPresent, true);
  assert.equal(JSON.stringify(res).indexOf('sk-DO-NOT-LEAK-12345'), -1);
});

test('generateAnswers without a key returns missing-key without calling client', async () => {
  let clientCalled = false;
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () { clientCalled = true; return Promise.resolve({}); }); }
  });
  const res = await call(svc, 'generateAnswers', { snapshot: { questions: [] } });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'missing-key');
  assert.equal(clientCalled, false);
});

test('generateAnswers calls injected client with the sanitized snapshot and stored key, returns its result', async () => {
  const session = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-x';
  let capturedSnap = null; let capturedKey = null;
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function (snap, key) { capturedSnap = snap; capturedKey = key; return Promise.resolve({ ok: true, raw: { answers: [] } }); }); }
  });
  const snap = { page: { eligible: true }, questions: [{ id: 'q1', type: 'math_input', prompt: 'p' }], token: 't' };
  const res = await call(svc, 'generateAnswers', { snapshot: snap });
  assert.equal(res.ok, true);
  assert.equal(capturedKey, 'sk-x');
  assert.deepEqual(capturedSnap, snap);
});

test('cancelRequest aborts the current in-flight controller', async () => {
  const session = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-x';
  let aborted = false;
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () {
      return fakeClient(function (snap, key, opts) {
        return new Promise(function (resolve) {
          opts.signal.addEventListener('abort', function () { aborted = true; resolve({ ok: false, reason: 'aborted' }); });
        });
      });
    }
  });
  // start a generate but don't await yet
  let resolved = false;
  const p = call(svc, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  p.then(function () { resolved = true; });
  // cancel
  const cancelRes = await call(svc, 'cancelRequest', {});
  assert.equal(cancelRes.ok, true);
  await p;
  assert.equal(aborted, true);
});

test('unknown command returns ok:false reason:unknown-command', async () => {
  const svc = createAiBackgroundService({ storageSession: fakeStorage(), storageLocal: fakeStorage(), clientFactory: function () { return fakeClient(function () {}); } });
  const res = await call(svc, 'whatever', {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unknown-command');
});

test('keyStatus when only local key set still returns keyPresent:true', async () => {
  const local = fakeStorage();
  local._store['ccp.ai.localKey'] = 'sk-local';
  const svc = createAiBackgroundService({ storageSession: fakeStorage(), storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await call(svc, 'keyStatus', {});
  assert.equal(res.keyPresent, true);
});

test('keyStatus when no key set returns keyPresent:false', async () => {
  const svc = createAiBackgroundService({ storageSession: fakeStorage(), storageLocal: fakeStorage(), clientFactory: function () { return fakeClient(function () {}); } });
  const res = await call(svc, 'keyStatus', {});
  assert.equal(res.keyPresent, false);
});

// H3 — Session-key semantics hardening (D1-D6)

test('D1: remember=false with session support writes session AND removes prior local key', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  local._store['ccp.ai.localKey'] = 'sk-old-local';
  const svc = createAiBackgroundService({ storageSession: session, storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await call(svc, 'setSessionKey', { key: 'sk-new', remember: false });
  assert.equal(res.ok, true);
  assert.equal(res.keyPresent, true);
  assert.equal(res.remember, false);
  assert.equal(session._store['ccp.ai.sessionKey'], 'sk-new');
  assert.equal(local._store['ccp.ai.localKey'], undefined, 'old local key must be purged');
});

test('D2: remember=false without session support FAILS CLOSED and leaves local untouched', async () => {
  const local = fakeStorage();
  local._store['ccp.ai.localKey'] = 'sk-old-local';
  const svc = createAiBackgroundService({ storageSession: null, storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await call(svc, 'setSessionKey', { key: 'sk-attempt', remember: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'session-storage-unavailable');
  // Existing local key must be untouched
  assert.equal(local._store['ccp.ai.localKey'], 'sk-old-local');
});

test('D3: remember=true writes the local remembered key (may also mirror to session)', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  const svc = createAiBackgroundService({ storageSession: session, storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await call(svc, 'setSessionKey', { key: 'sk-remember', remember: true });
  assert.equal(res.ok, true);
  assert.equal(res.remember, true);
  assert.equal(local._store['ccp.ai.localKey'], 'sk-remember');
});

test('D3-alt: remember=true without session support still writes local', async () => {
  const local = fakeStorage();
  const svc = createAiBackgroundService({ storageSession: null, storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await call(svc, 'setSessionKey', { key: 'sk-remember', remember: true });
  assert.equal(res.ok, true);
  assert.equal(local._store['ccp.ai.localKey'], 'sk-remember');
});

test('D4: clearKey removes both session and local copies', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-s';
  local._store['ccp.ai.localKey'] = 'sk-l';
  const svc = createAiBackgroundService({ storageSession: session, storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await call(svc, 'clearKey', {});
  assert.equal(res.ok, true);
  assert.equal(session._store['ccp.ai.sessionKey'], undefined);
  assert.equal(local._store['ccp.ai.localKey'], undefined);
});

test('D5: keyStatus returns remembered:false when only a session key exists', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-LEAK-SHOULD-NOT-APPEAR-IN-RESPONSE-9999';
  const svc = createAiBackgroundService({ storageSession: session, storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await call(svc, 'keyStatus', {});
  assert.equal(res.ok, true);
  assert.equal(res.keyPresent, true);
  assert.equal(res.remembered, false);
  assert.equal(JSON.stringify(res).indexOf('sk-LEAK-SHOULD-NOT-APPEAR'), -1, 'key must never appear in response');
});

test('D5: keyStatus returns remembered:true when a local key exists', async () => {
  const local = fakeStorage();
  local._store['ccp.ai.localKey'] = 'sk-l';
  const svc = createAiBackgroundService({ storageSession: fakeStorage(), storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await call(svc, 'keyStatus', {});
  assert.equal(res.keyPresent, true);
  assert.equal(res.remembered, true);
});

test('D5: keyStatus with no keys returns keyPresent:false, remembered:false', async () => {
  const svc = createAiBackgroundService({ storageSession: fakeStorage(), storageLocal: fakeStorage(), clientFactory: function () { return fakeClient(function () {}); } });
  const res = await call(svc, 'keyStatus', {});
  assert.equal(res.keyPresent, false);
  assert.equal(res.remembered, false);
});

test('D5: keyStatus when session is unavailable but local key exists works correctly', async () => {
  const local = fakeStorage();
  local._store['ccp.ai.localKey'] = 'sk-l';
  const svc = createAiBackgroundService({ storageSession: null, storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await call(svc, 'keyStatus', {});
  assert.equal(res.keyPresent, true);
  assert.equal(res.remembered, true);
});

// === S1: per-tab cancellation isolation ===

function callAs(svc, sender, cmd, params) {
  return new Promise(function (resolve) {
    svc.handleMessage({ type: 'ccp.ai.request', command: cmd, params: params || {} }, sender || {}, resolve);
  });
}

test('S1: generate in tab 2 does NOT abort an in-flight generate in tab 1', async () => {
  const session = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-x';
  let tab1Aborted = false;
  // Use a per-call resolver array so each tab's resolve is captured independently.
  let callIndex = 0;
  const resolvers = [];
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () {
      return fakeClient(function (snap, key, opts) {
        var myIndex = callIndex++;
        return new Promise(function (resolve) {
          opts.signal.addEventListener('abort', function () {
            if (myIndex === 0) tab1Aborted = true; // only tab1's first call
            resolve({ ok: false, reason: 'aborted' });
          });
          resolvers[myIndex] = resolve;
        });
      });
    }
  });
  // Start tab 1's generate (do not await)
  const p1 = callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  await new Promise(function (r) { setTimeout(r, 0); });
  // Now start tab 2's generate. The pending tab 1 promise must NOT abort.
  const p2 = callAs(svc, { tab: { id: 2 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  // Give the event loop a chance
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(tab1Aborted, false, 'tab 1 must not be aborted by tab 2');
  // Cleanup: resolve all pending promises so the test can settle
  resolvers.forEach(function (r) { if (r) r({ ok: true, raw: { answers: [] } }); });
  await p1;
  await p2;
});

test('S1: cancel in tab 2 does NOT abort tab 1\'s in-flight request', async () => {
  const session = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-x';
  let tab1Aborted = false;
  let tab1Resolve = null;
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () {
      return fakeClient(function (snap, key, opts) {
        return new Promise(function (resolve) {
          opts.signal.addEventListener('abort', function () { tab1Aborted = true; resolve({ ok: false, reason: 'aborted' }); });
          tab1Resolve = function () { resolve({ ok: true, raw: { answers: [] } }); };
        });
      });
    }
  });
  const p1 = callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  await new Promise(function (r) { setTimeout(r, 0); });
  // Cancel from tab 2 — no in-flight request for tab 2.
  const c2 = await callAs(svc, { tab: { id: 2 } }, 'cancelRequest', {});
  assert.equal(c2.ok, true);
  assert.equal(tab1Aborted, false, 'tab 1 must not be aborted by tab 2 cancel');
  tab1Resolve && tab1Resolve();
  await p1;
});

test('S1: starting a second generate in tab 1 aborts only tab 1\'s prior request', async () => {
  const session = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-x';
  let firstAborted = false;
  let firstResolve = null;
  let callCount = 0;
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () {
      return fakeClient(function (snap, key, opts) {
        callCount++;
        if (callCount === 1) {
          return new Promise(function (resolve) {
            opts.signal.addEventListener('abort', function () { firstAborted = true; resolve({ ok: false, reason: 'aborted' }); });
            firstResolve = function () { resolve({ ok: true }); };
          });
        }
        return Promise.resolve({ ok: true, raw: { answers: [] } });
      });
    }
  });
  const p1 = callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  await new Promise(function (r) { setTimeout(r, 0); });
  const p2 = callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(firstAborted, true, 'first tab-1 request must be aborted by second tab-1 request');
  await p1;
  await p2;
});

test('S1: completed controller is removed from the byTab map', async () => {
  const session = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-x';
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () { return Promise.resolve({ ok: true, raw: { answers: [] } }); }); }
  });
  await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  // After completion, byTab must not retain this tab's controller
  assert.equal(svc._state.byTab.has('tab:1'), false, 'completed controller must be removed from map');
});

// === S2: sender-trust check on secret commands ===

test('S2: setSessionKey from a content-script sender (has sender.tab) is REJECTED', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  const svc = createAiBackgroundService({ storageSession: session, storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await callAs(svc, { tab: { id: 42 } }, 'setSessionKey', { key: 'sk-attacker', remember: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
  // Storage must be untouched
  assert.equal(session._store['ccp.ai.sessionKey'], undefined);
  assert.equal(local._store['ccp.ai.localKey'], undefined);
});

test('S2: setSessionKey from an extension-origin sender (no sender.tab) is ACCEPTED', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  const svc = createAiBackgroundService({ storageSession: session, storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await callAs(svc, { id: 'extension-id' }, 'setSessionKey', { key: 'sk-trusted', remember: false });
  assert.equal(res.ok, true);
  assert.equal(session._store['ccp.ai.sessionKey'], 'sk-trusted');
});

test('S2: clearKey from a content-script sender is REJECTED', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-keep';
  const svc = createAiBackgroundService({ storageSession: session, storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await callAs(svc, { tab: { id: 42 } }, 'clearKey', {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
  assert.equal(session._store['ccp.ai.sessionKey'], 'sk-keep', 'key must not have been cleared');
});

test('S2: clearKey from an extension-origin sender is ACCEPTED', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-to-clear';
  const svc = createAiBackgroundService({ storageSession: session, storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await callAs(svc, {}, 'clearKey', {});
  assert.equal(res.ok, true);
  assert.equal(session._store['ccp.ai.sessionKey'], undefined);
});

test('S2: keyStatus remains reachable from content-script senders (booleans only)', async () => {
  const local = fakeStorage();
  local._store['ccp.ai.localKey'] = 'sk-LEAK-DO-NOT-EXPOSE';
  const svc = createAiBackgroundService({ storageSession: fakeStorage(), storageLocal: local, clientFactory: function () { return fakeClient(function () {}); } });
  const res = await callAs(svc, { tab: { id: 1 } }, 'keyStatus', {});
  assert.equal(res.ok, true);
  assert.equal(res.keyPresent, true);
  assert.equal(JSON.stringify(res).indexOf('sk-LEAK-DO-NOT-EXPOSE'), -1, 'no key contents may leak');
});

test('S2: generateAnswers remains reachable from content-script senders', async () => {
  const session = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-x';
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () { return Promise.resolve({ ok: true, raw: { answers: [] } }); }); }
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(res.ok, true);
});

// === T3: strict canManageSecrets predicate ===

function strictCanManageSecrets(approvedUrl) {
  return function (sender) {
    if (!sender) return false;
    var u = sender.url || '';
    if (!u) return false;
    var base = u.split('#')[0].split('?')[0];
    return base === approvedUrl;
  };
}

test('T3/B1: with strict predicate, sender having tab.id cannot call setSessionKey', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: strictCanManageSecrets('chrome-extension://EXT/options.html'),
  });
  const res = await callAs(svc, { tab: { id: 1 }, url: 'https://www.coursera.org/learn/x' }, 'setSessionKey', { key: 'sk-attacker', remember: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
  assert.equal(session._store['ccp.ai.sessionKey'], undefined);
});

test('T3/B2: with strict predicate, sender having tab.id cannot call clearKey', async () => {
  const session = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-keep';
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: strictCanManageSecrets('chrome-extension://EXT/options.html'),
  });
  const res = await callAs(svc, { tab: { id: 1 }, url: 'https://www.coursera.org/' }, 'clearKey', {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
  assert.equal(session._store['ccp.ai.sessionKey'], 'sk-keep');
});

test('T3/B3: sender with no tab but unrelated extension URL cannot setSessionKey', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: strictCanManageSecrets('chrome-extension://EXT/options.html'),
  });
  const res = await callAs(svc, { id: 'EXT', url: 'chrome-extension://EXT/popup.html' }, 'setSessionKey', { key: 'sk-x', remember: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
  assert.equal(session._store['ccp.ai.sessionKey'], undefined);
});

test('T3/B4: sender with no tab but unrelated extension URL cannot clearKey', async () => {
  const session = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-keep';
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: strictCanManageSecrets('chrome-extension://EXT/options.html'),
  });
  const res = await callAs(svc, { id: 'EXT', url: 'chrome-extension://EXT/devtools.html' }, 'clearKey', {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
  assert.equal(session._store['ccp.ai.sessionKey'], 'sk-keep');
});

test('T3/B5: sender URL matching approved options.html may set the key', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  const approved = 'chrome-extension://EXT/options.html';
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: strictCanManageSecrets(approved),
  });
  const res = await callAs(svc, { id: 'EXT', url: approved }, 'setSessionKey', { key: 'sk-trusted', remember: false });
  assert.equal(res.ok, true);
  assert.equal(session._store['ccp.ai.sessionKey'], 'sk-trusted');
});

test('T3/B5-tab: sender URL matching approved options.html with tab.id (open_in_tab mode) may set the key', async () => {
  // When options.html is opened in a tab, sender.tab IS set. The strict predicate must accept based on URL match.
  const session = fakeStorage(); const local = fakeStorage();
  const approved = 'chrome-extension://EXT/options.html';
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: strictCanManageSecrets(approved),
  });
  const res = await callAs(svc, { id: 'EXT', tab: { id: 42 }, url: approved }, 'setSessionKey', { key: 'sk-trusted', remember: false });
  assert.equal(res.ok, true, 'options.html opened in tab must still be permitted to set keys');
  assert.equal(session._store['ccp.ai.sessionKey'], 'sk-trusted');
});

test('T3/B6: sender URL matching approved options.html may clear the key', async () => {
  const session = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-to-clear';
  const approved = 'chrome-extension://EXT/options.html';
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: strictCanManageSecrets(approved),
  });
  const res = await callAs(svc, { id: 'EXT', url: approved }, 'clearKey', {});
  assert.equal(res.ok, true);
  assert.equal(session._store['ccp.ai.sessionKey'], undefined);
});

test('T3/B5-hash: approved options URL with hash fragment still permitted', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  const approved = 'chrome-extension://EXT/options.html';
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: strictCanManageSecrets(approved),
  });
  const res = await callAs(svc, { id: 'EXT', url: approved + '#section1' }, 'setSessionKey', { key: 'sk-x', remember: false });
  assert.equal(res.ok, true);
});

test('T3/B7: keyStatus and generateAnswers remain reachable from content-script senders', async () => {
  const session = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-LEAK-DO-NOT-EXPOSE-1234567';
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () { return Promise.resolve({ ok: true, raw: { answers: [] } }); }); },
    canManageSecrets: strictCanManageSecrets('chrome-extension://EXT/options.html'),
  });
  const statusRes = await callAs(svc, { tab: { id: 1 }, url: 'https://www.coursera.org/learn/x' }, 'keyStatus', {});
  assert.equal(statusRes.ok, true);
  assert.equal(statusRes.keyPresent, true);
  assert.equal(JSON.stringify(statusRes).indexOf('sk-LEAK-DO-NOT-EXPOSE'), -1);

  const genRes = await callAs(svc, { tab: { id: 1 }, url: 'https://www.coursera.org/learn/x' }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(genRes.ok, true);
});

test('T3: default predicate (no canManageSecrets injected) preserves prior behavior — content-script rejected', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    clientFactory: function () { return fakeClient(function () {}); },
    // no canManageSecrets
  });
  const res = await callAs(svc, { tab: { id: 1 }, url: 'https://www.coursera.org/' }, 'setSessionKey', { key: 'sk-x', remember: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
});

// === U8: sanitized key-status-changed broadcast ===

test('U8: successful setSessionKey (session-only) emits a sanitized broadcast', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
    broadcast: function (msg) { broadcasts.push(msg); },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' }, 'setSessionKey', { key: 'sk-LEAK-DO-NOT-EXPOSE-12345', remember: false });
  assert.equal(res.ok, true);
  assert.equal(broadcasts.length, 1, 'exactly one broadcast on success');
  assert.deepEqual(broadcasts[0], { type: 'ccp.ai.keyStatusChanged' });
  // The broadcast payload must not contain the key
  assert.equal(JSON.stringify(broadcasts[0]).indexOf('sk-LEAK'), -1);
});

test('U8: successful setSessionKey (remember=true) emits a sanitized broadcast', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
    broadcast: function (msg) { broadcasts.push(msg); },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' }, 'setSessionKey', { key: 'sk-x', remember: true });
  assert.equal(res.ok, true);
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0], { type: 'ccp.ai.keyStatusChanged' });
});

test('U8: successful clearKey emits a sanitized broadcast', async () => {
  const session = fakeStorage(); session._store['ccp.ai.sessionKey'] = 'sk-x';
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
    broadcast: function (msg) { broadcasts.push(msg); },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' }, 'clearKey', {});
  assert.equal(res.ok, true);
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0], { type: 'ccp.ai.keyStatusChanged' });
});

test('U8: failed setSessionKey (forbidden-sender) does NOT emit a broadcast', async () => {
  const session = fakeStorage(); const local = fakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return false; },  // reject everyone
    broadcast: function (msg) { broadcasts.push(msg); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'setSessionKey', { key: 'sk-x', remember: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
  assert.equal(broadcasts.length, 0, 'no broadcast on auth failure');
});

test('U8: failed setSessionKey (empty-key) does NOT emit a broadcast', async () => {
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
    broadcast: function (msg) { broadcasts.push(msg); },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' }, 'setSessionKey', { key: '', remember: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'empty-key');
  assert.equal(broadcasts.length, 0);
});

test('U8: failed setSessionKey (session-storage-unavailable) does NOT emit a broadcast', async () => {
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: null, storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
    broadcast: function (msg) { broadcasts.push(msg); },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' }, 'setSessionKey', { key: 'sk-x', remember: false });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'session-storage-unavailable');
  assert.equal(broadcasts.length, 0);
});

test('U8: no broadcast dep injected → service still works, no throw', async () => {
  const session = fakeStorage();
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
    // no broadcast dep — default must be a safe no-op
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' }, 'setSessionKey', { key: 'sk-x', remember: false });
  assert.equal(res.ok, true, 'service works without broadcast dep');
});

// === S2-2: mode-aware routing ===

test('S2: keyStatus includes accessMode (default personal-key)', async () => {
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    managedClient: { generateAnswers: function () { return Promise.resolve({ ok: false, reason: 'should-not-call' }); } },
    accessModeProvider: function (cb) { cb('personal-key'); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'keyStatus', {});
  assert.equal(res.ok, true);
  assert.equal(res.accessMode, 'personal-key');
});

test('S2: keyStatus reports accessMode=managed-credits when set', async () => {
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    managedClient: { generateAnswers: function () { return Promise.resolve({ ok: false, reason: 'should-not-call' }); } },
    accessModeProvider: function (cb) { cb('managed-credits'); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'keyStatus', {});
  assert.equal(res.accessMode, 'managed-credits');
});

test('S2: generateAnswers in personal-key mode calls deepseek client, NOT managed', async () => {
  let deepseekCalled = false;
  let managedCalled = false;
  const session = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-byok';
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () {
      return fakeClient(function () { deepseekCalled = true; return Promise.resolve({ ok: true, raw: { answers: [] } }); });
    },
    managedClient: { generateAnswers: function () { managedCalled = true; return Promise.resolve({ ok: false }); } },
    accessModeProvider: function (cb) { cb('personal-key'); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page:{}, questions: [], token:'t' } });
  assert.equal(res.ok, true);
  assert.equal(deepseekCalled, true);
  assert.equal(managedCalled, false);
});

test('S2: generateAnswers in managed-credits mode calls managed client, NOT deepseek', async () => {
  let deepseekCalled = false;
  let managedCalled = false;
  const session = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-byok-must-be-ignored';
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () {
      return fakeClient(function () { deepseekCalled = true; return Promise.resolve({ ok: true, raw: { answers: [] } }); });
    },
    managedClient: { generateAnswers: function () { managedCalled = true; return Promise.resolve({ ok: false, reason: 'managed-not-implemented' }); } },
    accessModeProvider: function (cb) { cb('managed-credits'); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page:{}, questions: [], token:'t' } });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'managed-not-implemented');
  assert.equal(deepseekCalled, false);
  assert.equal(managedCalled, true);
});

test('S2: managed mode never reads BYOK session-key storage', async () => {
  const session = fakeStorage();
  let sessionGetCount = 0;
  const originalGet = session.get;
  session.get = function (keys, cb) {
    if ((Array.isArray(keys) ? keys : [keys]).indexOf('ccp.ai.sessionKey') !== -1) sessionGetCount++;
    originalGet.call(session, keys, cb);
  };
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    managedClient: { generateAnswers: function () { return Promise.resolve({ ok: false, reason: 'managed-not-implemented' }); } },
    accessModeProvider: function (cb) { cb('managed-credits'); },
  });
  await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: {} });
  assert.equal(sessionGetCount, 0, 'managed mode must not read BYOK key storage');
});

test('S2: invalid accessMode value falls back to personal-key', async () => {
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    managedClient: { generateAnswers: function () { return Promise.resolve({ ok: false }); } },
    accessModeProvider: function (cb) { cb('garbage-value'); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'keyStatus', {});
  assert.equal(res.accessMode, 'personal-key');
});

// === U10 Issue 2 — setAccessMode command + accessModeChanged broadcast ===

function makeModeFakeStorage(initial) {
  const session = fakeStorage();
  const local = fakeStorage();
  if (initial) Object.keys(initial).forEach(function (k) { local._store[k] = initial[k]; });
  return { session: session, local: local };
}

test('U10-2: setAccessMode("managed-credits") from authorized options sender persists to storageLocal', async () => {
  const fs2 = makeModeFakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fs2.session, storageLocal: fs2.local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
    broadcast: function (m) { broadcasts.push(m); },
    accessModeProvider: function (cb) { cb(fs2.local._store['ccp.ai.accessMode'] || 'personal-key'); },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' },
    'setAccessMode', { mode: 'managed-credits' });
  assert.equal(res.ok, true);
  assert.equal(fs2.local._store['ccp.ai.accessMode'], 'managed-credits');
});

test('U10-2: setAccessMode("personal-key") from authorized options sender persists to storageLocal', async () => {
  const fs2 = makeModeFakeStorage({ 'ccp.ai.accessMode': 'managed-credits' });
  const svc = createAiBackgroundService({
    storageSession: fs2.session, storageLocal: fs2.local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' },
    'setAccessMode', { mode: 'personal-key' });
  assert.equal(res.ok, true);
  assert.equal(fs2.local._store['ccp.ai.accessMode'], 'personal-key');
});

test('U10-2: setAccessMode emits exactly {type:"ccp.ai.accessModeChanged"} on success — no key, balance, account', async () => {
  const fs2 = makeModeFakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fs2.session, storageLocal: fs2.local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
    broadcast: function (m) { broadcasts.push(m); },
  });
  await callAs(svc, { url: 'chrome-extension://EXT/options.html' },
    'setAccessMode', { mode: 'managed-credits' });
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0], { type: 'ccp.ai.accessModeChanged' });
  const payloadStr = JSON.stringify(broadcasts[0]);
  ['sk-', 'balance', 'account', 'token', 'credit'].forEach(function (forbidden) {
    assert.equal(payloadStr.toLowerCase().indexOf(forbidden), -1,
      'forbidden substring in broadcast: ' + forbidden);
  });
});

test('U10-2: setAccessMode from content-script sender (tab.id present, non-options URL) is REJECTED — no write, no broadcast', async () => {
  const fs2 = makeModeFakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fs2.session, storageLocal: fs2.local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: strictCanManageSecrets('chrome-extension://EXT/options.html'),
    broadcast: function (m) { broadcasts.push(m); },
  });
  const res = await callAs(svc, { tab: { id: 1 }, url: 'https://www.coursera.org/learn/x' },
    'setAccessMode', { mode: 'managed-credits' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
  assert.equal(fs2.local._store['ccp.ai.accessMode'], undefined);
  assert.equal(broadcasts.length, 0);
});

test('U10-2: setAccessMode from unrelated extension page (e.g. popup.html) is REJECTED', async () => {
  const fs2 = makeModeFakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fs2.session, storageLocal: fs2.local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: strictCanManageSecrets('chrome-extension://EXT/options.html'),
    broadcast: function (m) { broadcasts.push(m); },
  });
  const res = await callAs(svc, { id: 'EXT', url: 'chrome-extension://EXT/popup.html' },
    'setAccessMode', { mode: 'managed-credits' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
  assert.equal(fs2.local._store['ccp.ai.accessMode'], undefined);
  assert.equal(broadcasts.length, 0);
});

test('U10-2: setAccessMode with invalid mode value is REFUSED — no storage write, no broadcast', async () => {
  const fs2 = makeModeFakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fs2.session, storageLocal: fs2.local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
    broadcast: function (m) { broadcasts.push(m); },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' },
    'setAccessMode', { mode: 'garbage-value' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid-mode');
  assert.equal(fs2.local._store['ccp.ai.accessMode'], undefined);
  assert.equal(broadcasts.length, 0);
});

test('U10-2: setAccessMode with missing mode field is REFUSED', async () => {
  const fs2 = makeModeFakeStorage();
  const svc = createAiBackgroundService({
    storageSession: fs2.session, storageLocal: fs2.local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' }, 'setAccessMode', {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid-mode');
});

test('U10-2: failed setAccessMode (forbidden) does not call broadcast', async () => {
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return false; },
    broadcast: function (m) { broadcasts.push(m); },
  });
  await callAs(svc, { url: 'chrome-extension://EXT/options.html' },
    'setAccessMode', { mode: 'managed-credits' });
  assert.equal(broadcasts.length, 0);
});

test('U10-2: managed-credits mode Generate still fails closed with managed-not-implemented (no network call)', async () => {
  let deepseekCalled = false;
  let managedCalled = false;
  const fs2 = makeModeFakeStorage();
  const svc = createAiBackgroundService({
    storageSession: fs2.session, storageLocal: fs2.local,
    clientFactory: function () {
      return fakeClient(function () { deepseekCalled = true; return Promise.resolve({ ok: true }); });
    },
    managedClient: { generateAnswers: function () { managedCalled = true; return Promise.resolve({ ok: false, reason: 'managed-not-implemented' }); } },
    canManageSecrets: function () { return true; },
    accessModeProvider: function (cb) { cb(fs2.local._store['ccp.ai.accessMode'] || 'personal-key'); },
  });
  await callAs(svc, { url: 'chrome-extension://EXT/options.html' },
    'setAccessMode', { mode: 'managed-credits' });
  const gen = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers',
    { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(gen.ok, false);
  assert.equal(gen.reason, 'managed-not-implemented');
  assert.equal(deepseekCalled, false, 'managed mode must not fall through to deepseek');
  assert.equal(managedCalled, true);
});

// === Phase B: provider-agnostic generation ===

function fakeProviders(map) {
  return {
    get: function (id) {
      if (!map[id]) return null;
      return { createClient: function () { return { generateAnswers: map[id] }; } };
    },
    list: function () { return Object.keys(map).map(function (id) { return { id: id, label: id, models: [], defaultModel: 'm' }; }); },
  };
}

test('PB1: generateAnswers resolves the adapter from ccp.ai.provider and calls THAT provider', async () => {
  const session = fakeStorage(); session._store['ccp.ai.sessionKey'] = 'sk-x';
  const local = fakeStorage(); local._store['ccp.ai.provider'] = 'openai';
  let calledProvider = null;
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    aiProviders: fakeProviders({
      deepseek: function () { calledProvider = 'deepseek'; return Promise.resolve({ ok: true, raw: { answers: [] } }); },
      openai: function () { calledProvider = 'openai'; return Promise.resolve({ ok: true, raw: { answers: [{ question_id: 'q1' }] } }); },
    }),
    clientFactory: function () { return fakeClient(function () { calledProvider = 'factory'; return Promise.resolve({ ok: true, raw: {} }); }); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(res.ok, true);
  assert.equal(calledProvider, 'openai');
  assert.equal(res.raw.answers[0].question_id, 'q1');
});

test('PB2: generateAnswers defaults to deepseek when ccp.ai.provider is unset', async () => {
  const session = fakeStorage(); session._store['ccp.ai.sessionKey'] = 'sk-x';
  const local = fakeStorage();
  let calledProvider = null;
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    aiProviders: fakeProviders({
      deepseek: function () { calledProvider = 'deepseek'; return Promise.resolve({ ok: true, raw: { answers: [] } }); },
      openai: function () { calledProvider = 'openai'; return Promise.resolve({ ok: true, raw: { answers: [] } }); },
    }),
    clientFactory: function () { return fakeClient(function () { return Promise.resolve({ ok: true, raw: {} }); }); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(res.ok, true);
  assert.equal(calledProvider, 'deepseek');
});

test('PB3: generateAnswers passes the per-provider model from ccp.ai.model.{provider} to createClient', async () => {
  const session = fakeStorage(); session._store['ccp.ai.sessionKey'] = 'sk-x';
  const local = fakeStorage();
  local._store['ccp.ai.provider'] = 'openai';
  local._store['ccp.ai.model.openai'] = 'gpt-4o';
  let seenModel = null;
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    aiProviders: {
      get: function (id) {
        if (id !== 'openai') return null;
        return { createClient: function (opts) { seenModel = opts.model; return { generateAnswers: function () { return Promise.resolve({ ok: true, raw: { answers: [] } }); } }; } };
      },
      list: function () { return []; },
    },
    clientFactory: function () { return fakeClient(function () { return Promise.resolve({ ok: true }); }); },
  });
  await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(seenModel, 'gpt-4o');
});

test('PB4: generateAnswers passes ccp.ai.baseUrl to createClient for the custom provider', async () => {
  const session = fakeStorage(); session._store['ccp.ai.sessionKey'] = 'sk-x';
  const local = fakeStorage();
  local._store['ccp.ai.provider'] = 'custom';
  local._store['ccp.ai.baseUrl'] = 'https://llm.example.com/v1';
  let seenBase = null;
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    aiProviders: {
      get: function (id) {
        if (id !== 'custom') return null;
        return { createClient: function (opts) { seenBase = opts.baseUrl; return { generateAnswers: function () { return Promise.resolve({ ok: true, raw: { answers: [] } }); } }; } };
      },
      list: function () { return []; },
    },
    clientFactory: function () { return fakeClient(function () { return Promise.resolve({ ok: true }); }); },
  });
  await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(seenBase, 'https://llm.example.com/v1');
});

test('PB5: when no aiProviders dep is injected, generateAnswers falls back to clientFactory (back-compat)', async () => {
  const session = fakeStorage(); session._store['ccp.ai.sessionKey'] = 'sk-x';
  let factoryCalled = false;
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () { factoryCalled = true; return Promise.resolve({ ok: true, raw: { answers: [] } }); }); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(res.ok, true);
  assert.equal(factoryCalled, true);
});

test('PB6: setProvider from authorized options sender persists ccp.ai.provider and broadcasts providerChanged', async () => {
  const local = fakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: local,
    aiProviders: fakeProviders({ openai: function () {}, deepseek: function () {} }),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
    broadcast: function (m) { broadcasts.push(m); },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' }, 'setProvider', { provider: 'openai' });
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'openai');
  assert.equal(local._store['ccp.ai.provider'], 'openai');
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0], { type: 'ccp.ai.providerChanged' });
});

test('PB7: setProvider persists model and baseUrl when supplied', async () => {
  const local = fakeStorage();
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: local,
    aiProviders: fakeProviders({ custom: function () {} }),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' }, 'setProvider', { provider: 'custom', model: 'my-model', baseUrl: 'https://llm.example.com/v1' });
  assert.equal(res.ok, true);
  assert.equal(local._store['ccp.ai.provider'], 'custom');
  assert.equal(local._store['ccp.ai.model.custom'], 'my-model');
  assert.equal(local._store['ccp.ai.baseUrl'], 'https://llm.example.com/v1');
});

test('PB8: setProvider from a content-script sender is REJECTED — no write, no broadcast', async () => {
  const local = fakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: local,
    aiProviders: fakeProviders({ openai: function () {} }),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: strictCanManageSecrets('chrome-extension://EXT/options.html'),
    broadcast: function (m) { broadcasts.push(m); },
  });
  const res = await callAs(svc, { tab: { id: 1 }, url: 'https://www.coursera.org/learn/x' }, 'setProvider', { provider: 'openai' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
  assert.equal(local._store['ccp.ai.provider'], undefined);
  assert.equal(broadcasts.length, 0);
});

test('PB9: setProvider with an unknown provider id is REFUSED — no write, no broadcast', async () => {
  const local = fakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: local,
    aiProviders: fakeProviders({ openai: function () {}, deepseek: function () {} }),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
    broadcast: function (m) { broadcasts.push(m); },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' }, 'setProvider', { provider: 'nonexistent' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid-provider');
  assert.equal(local._store['ccp.ai.provider'], undefined);
  assert.equal(broadcasts.length, 0);
});

test('PB10: managed-credits mode still bypasses providers and calls managedClient', async () => {
  const local = fakeStorage(); local._store['ccp.ai.provider'] = 'openai';
  let openaiCalled = false; let managedCalled = false;
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: local,
    aiProviders: fakeProviders({ openai: function () { openaiCalled = true; return Promise.resolve({ ok: true }); } }),
    clientFactory: function () { return fakeClient(function () {}); },
    managedClient: { generateAnswers: function () { managedCalled = true; return Promise.resolve({ ok: false, reason: 'managed-not-implemented' }); } },
    accessModeProvider: function (cb) { cb('managed-credits'); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(res.reason, 'managed-not-implemented');
  assert.equal(openaiCalled, false);
  assert.equal(managedCalled, true);
});

test('PB11: generated result never contains the stored key', async () => {
  const session = fakeStorage(); session._store['ccp.ai.sessionKey'] = 'sk-LEAK-PB11';
  const local = fakeStorage(); local._store['ccp.ai.provider'] = 'openai';
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    aiProviders: fakeProviders({ openai: function (snap, key) { return Promise.resolve({ ok: true, raw: { answers: [] } }); } }),
    clientFactory: function () { return fakeClient(function () {}); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(JSON.stringify(res).indexOf('sk-LEAK-PB11'), -1);
});
