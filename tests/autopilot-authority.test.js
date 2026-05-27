// tests/autopilot-authority.test.js
// PHASE 11 — focused tests for the cross-realm state authority and the
// in-process messenger. These exercise the single-writer queue, change-
// event broadcast, and conditional-write semantics directly, without going
// through the higher-level state client. The same authority+messenger
// scaffold is then reused by tests in autopilot-state.test.js and
// module-autopilot.test.js to simulate distinct content-script realms
// sharing one service-worker authority.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuthority } = require('../lib/autopilot-authority.js');
const { createInProcessMessenger } = require('../lib/autopilot-messenger.js');
const stateModule = require('../lib/autopilot-state.js');
const { RUN_KEY, SETTINGS_KEY, COURSE_LOG_KEY, SETTINGS_VERSION, defaults } = stateModule;

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
      cb && cb();
    },
  };
}

function makeDeferredStorage(predicate) {
  const _store = {};
  const deferred = [];
  return {
    _store: _store,
    get: function (keys, cb) {
      const out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { out[k] = _store[k]; });
      cb(out);
    },
    set: function (items, cb) {
      if (predicate(items)) {
        deferred.push(function () {
          Object.keys(items).forEach(function (k) { _store[k] = items[k]; });
          cb && cb();
        });
      } else {
        Object.keys(items).forEach(function (k) { _store[k] = items[k]; });
        cb && cb();
      }
    },
    release: function () { const list = deferred.splice(0); list.forEach(function (fn) { fn(); }); },
    heldCount: function () { return deferred.length; },
  };
}

function dispatch(messenger, cmd, params) {
  return new Promise(function (resolve) { messenger.send(cmd, params, function (res) { resolve(res); }); });
}

test('createAuthority + InProcessMessenger: a load command returns merged state', async () => {
  const auth = createAuthority(fakeStorage());
  const m = createInProcessMessenger(auth);
  const res = await dispatch(m, 'load', {});
  assert.equal(res.ok, true);
  assert.equal(res.state.status, 'idle');
  assert.equal(res.state.runId, null);
});

test('createAuthority serializes mutations: two messengers issuing updateIfCurrentRun and clear race-free', async () => {
  // Two clients (representing two realms) talk to ONE authority. The
  // authority owns the serialization queue. Even when client A's mutation
  // is delayed at storage level, client B's clear is sequenced behind it
  // — the final state is the last writer's intent (B's clear).
  function _isCursorAdvancePatch(items) {
    const v = items && items[RUN_KEY];
    return !!(v && v.status === 'running' && v.cursor === 1);
  }
  const deferred = makeDeferredStorage(_isCursorAdvancePatch);
  // Seed an active run.
  deferred._store[RUN_KEY] = Object.assign({}, defaults(), {
    status: 'running', runId: 'run-1', cursor: 0, queue: [{ id: 'a' }, { id: 'b' }],
    ownerTabKey: 'tab-1', heartbeatAt: 1_000_000,
  });
  delete deferred._store[RUN_KEY].settings;

  const auth = createAuthority(deferred);
  const A = createInProcessMessenger(auth);
  const B = createInProcessMessenger(auth);

  // A fires cursor-advance — its underlying storage.set is held.
  const aPromise = dispatch(A, 'updateIfCurrentRun', { expectedRunId: 'run-1', patch: { cursor: 1 } });
  // Poll until deferred captures A's write.
  const _t0 = Date.now();
  while (deferred.heldCount() === 0 && (Date.now() - _t0) < 500) {
    await new Promise(function (r) { setTimeout(r, 10); });
  }
  assert.ok(deferred.heldCount() > 0, 'A\'s cursor-advance must be deferred');
  // B clears the run. It must SEQUENCE behind A through the shared queue.
  const bPromise = dispatch(B, 'clear', {});
  // Release A's write.
  deferred.release();
  await aPromise; await bPromise;
  await new Promise(function (r) { setTimeout(r, 30); });

  const after = deferred._store[RUN_KEY];
  assert.equal(after && after.status, 'idle');
  assert.equal(after && after.runId, null);
  assert.equal(after && after.cursor, 0);
});

test('createAuthority: updateIfCurrentRun(null) is refused (null is the absence of identity)', async () => {
  const auth = createAuthority(fakeStorage());
  const m = createInProcessMessenger(auth);
  const res = await dispatch(m, 'updateIfCurrentRun', { expectedRunId: null, patch: { status: 'running', cursor: 9 } });
  assert.equal(res.ok, true);
  assert.equal(res.written, false);
  assert.equal(res.reason, 'null-run-id');
});

test('createAuthority: updateIfCurrentRun refuses when stored runId no longer matches', async () => {
  const fake = fakeStorage();
  fake._store[RUN_KEY] = Object.assign({}, defaults(), { status: 'running', runId: 'run-new', cursor: 0 });
  delete fake._store[RUN_KEY].settings;
  const auth = createAuthority(fake);
  const m = createInProcessMessenger(auth);
  const res = await dispatch(m, 'updateIfCurrentRun', { expectedRunId: 'run-old', patch: { cursor: 5 } });
  assert.equal(res.written, false);
  assert.equal(res.reason, 'stale-run');
  assert.equal(res.currentRunId, 'run-new');
  assert.equal(fake._store[RUN_KEY].cursor, 0, 'stale write must be refused');
});

test('createAuthority change-event broadcast: subscribers on ALL messengers see RUN_KEY mutations', async () => {
  const auth = createAuthority(fakeStorage());
  const A = createInProcessMessenger(auth);
  const B = createInProcessMessenger(auth);
  const eventsA = []; const eventsB = [];
  A.onChange(function (e) { eventsA.push(e); });
  B.onChange(function (e) { eventsB.push(e); });
  await dispatch(A, 'update', { patch: { status: 'paused', lastPauseReason: 'test' } });
  // Both messengers should receive the change.
  const aRun = eventsA.find(function (e) { return e.key === RUN_KEY; });
  const bRun = eventsB.find(function (e) { return e.key === RUN_KEY; });
  assert.ok(aRun, 'messenger A must receive the RUN_KEY change');
  assert.ok(bRun, 'messenger B must receive the RUN_KEY change');
});

test('createAuthority settings updates target SETTINGS_KEY only, never RUN_KEY active fields', async () => {
  const fake = fakeStorage();
  fake._store[RUN_KEY] = Object.assign({}, defaults(), { status: 'running', runId: 'run-1', cursor: 4, queue: [{ id: 'a' }], ownerTabKey: 'tab-1' });
  delete fake._store[RUN_KEY].settings;
  const auth = createAuthority(fake);
  const m = createInProcessMessenger(auth);
  await dispatch(m, 'update', { patch: { settings: { behaviorMode: 'human' } } });
  // RUN_KEY active fields unchanged.
  assert.equal(fake._store[RUN_KEY].status, 'running');
  assert.equal(fake._store[RUN_KEY].cursor, 4);
  assert.equal(fake._store[RUN_KEY].runId, 'run-1');
  // SETTINGS_KEY has the new value.
  assert.ok(fake._store[SETTINGS_KEY]);
  assert.equal(fake._store[SETTINGS_KEY].behaviorMode, 'human');
});

test('createAuthority recordCourseItem (Policy A) writes COURSE_LOG_KEY independent of the run-state queue', async () => {
  const fake = fakeStorage();
  const auth = createAuthority(fake);
  const m = createInProcessMessenger(auth);
  await dispatch(m, 'recordCourseItem', { courseId: 'x', itemId: 'v1', kind: 'video', outcome: 'video-done' });
  assert.ok(fake._store[COURSE_LOG_KEY] && fake._store[COURSE_LOG_KEY].x && fake._store[COURSE_LOG_KEY].x.v1);
  assert.equal(fake._store[COURSE_LOG_KEY].x.v1.kind, 'video');
});

// ===========================================================================
// PHASE 12 — authority fence for stale lifecycle commands.
//
// PHASE 11's queue serializes commands in arrival order but does not refuse
// a late old-realm command that arrives AFTER Stop/replacement. The fence
// validates every active-run mutation against expected identity (runId,
// status, or "no active run" depending on the operation). A stale command
// from a previous lifecycle is rejected at the authority.
// ===========================================================================

function holdableMessenger(authority, commandsToHold) {
  const inner = createInProcessMessenger(authority);
  const held = [];
  return {
    send: function (cmd, params, cb) {
      if (commandsToHold && commandsToHold.indexOf(cmd) !== -1) {
        held.push(function () { inner.send(cmd, params, cb); });
      } else {
        inner.send(cmd, params, cb);
      }
    },
    onChange: inner.onChange,
    release: function () { const list = held.splice(0); list.forEach(function (fn) { fn(); }); },
    heldCount: function () { return held.length; },
  };
}

test('PHASE 12 A1: activateRun fence — late old activateRun arriving AFTER new Stop+Start is rejected, not silently overwritten', async () => {
  const fake = fakeStorage();
  const auth = createAuthority(fake);
  const msgOld = holdableMessenger(auth, ['activateRun']);
  const msgNew = createInProcessMessenger(auth);
  // Old realm prepares an activateRun for run-old; it's held at the messenger.
  let oldResult = null;
  msgOld.send('activateRun', {
    state: Object.assign(defaults(), { status: 'running', runId: 'run-old', cursor: 0, queue: [{ id: 'a' }], ownerTabKey: 'tab-old', heartbeatAt: 1_000_000 }),
  }, function (res) { oldResult = res; });
  assert.equal(msgOld.heldCount(), 1, 'old activate must be held at the messenger');
  // New realm Stop + Start with run-new.
  await dispatch(msgNew, 'clear', {});
  const newStartRes = await dispatch(msgNew, 'activateRun', {
    state: Object.assign(defaults(), { status: 'running', runId: 'run-new', cursor: 0, queue: [{ id: 'NEW' }], ownerTabKey: 'tab-new', heartbeatAt: 1_000_001 }),
  });
  assert.equal(newStartRes.ok, true);
  assert.equal(newStartRes.written, true, 'new activateRun must succeed');
  // Release old's late activateRun.
  msgOld.release();
  // Drain.
  await new Promise(function (r) { setTimeout(r, 20); });

  assert.ok(oldResult, 'old activateRun must have responded');
  assert.equal(oldResult.ok, true, 'response envelope is ok=true');
  assert.equal(oldResult.written, false, 'late old activateRun must be REJECTED');
  assert.equal(oldResult.reason, 'already-active', 'reason must indicate a run is already active');
  // Storage authoritatively reflects run-new.
  const after = fake._store[RUN_KEY];
  assert.equal(after.runId, 'run-new', 'authoritative runId must remain run-new');
  assert.equal(after.cursor, 0);
  assert.deepEqual(after.queue, [{ id: 'NEW' }]);
});

test('PHASE 12 A2: pauseRun fence — late old pause carrying expectedRunId=run-old is rejected when storage shows run-new', async () => {
  const fake = fakeStorage();
  const auth = createAuthority(fake);
  const msgOld = holdableMessenger(auth, ['pauseRun']);
  const msgNew = createInProcessMessenger(auth);
  // Seed run-old then transition to run-new via clear + activateRun.
  await dispatch(msgNew, 'activateRun', { state: Object.assign(defaults(), { status: 'running', runId: 'run-old', cursor: 0, queue: [{ id: 'a' }] }) });
  // Old realm queues a pause for run-old (held).
  let oldRes = null;
  msgOld.send('pauseRun', { expectedRunId: 'run-old', lastPauseReason: 'late' }, function (res) { oldRes = res; });
  // New realm Stop + Start run-new.
  await dispatch(msgNew, 'clear', {});
  await dispatch(msgNew, 'activateRun', { state: Object.assign(defaults(), { status: 'running', runId: 'run-new', cursor: 0, queue: [{ id: 'NEW' }] }) });
  msgOld.release();
  await new Promise(function (r) { setTimeout(r, 20); });

  assert.equal(oldRes && oldRes.written, false, 'old pause must be rejected');
  assert.equal(oldRes && oldRes.reason, 'stale-run');
  const after = fake._store[RUN_KEY];
  assert.equal(after.status, 'running');
  assert.equal(after.runId, 'run-new');
  assert.equal(after.lastPauseReason, null);
});

test('PHASE 12 A3: takeOverRun fence — late old takeover with expectedRunId=run-old is rejected when storage holds run-new', async () => {
  const fake = fakeStorage();
  const auth = createAuthority(fake);
  const msgOld = holdableMessenger(auth, ['takeOverRun']);
  const msgNew = createInProcessMessenger(auth);
  await dispatch(msgNew, 'activateRun', { state: Object.assign(defaults(), { status: 'running', runId: 'run-old', cursor: 0, queue: [{ id: 'a' }], ownerTabKey: 'tab-x', heartbeatAt: 1_000_000 }) });
  let oldRes = null;
  msgOld.send('takeOverRun', { expectedRunId: 'run-old', tabKey: 'tab-old', now: 1_000_500 }, function (res) { oldRes = res; });
  await dispatch(msgNew, 'clear', {});
  await dispatch(msgNew, 'activateRun', { state: Object.assign(defaults(), { status: 'running', runId: 'run-new', cursor: 0, queue: [{ id: 'NEW' }], ownerTabKey: 'tab-new', heartbeatAt: 1_000_600 }) });
  msgOld.release();
  await new Promise(function (r) { setTimeout(r, 20); });

  assert.equal(oldRes && oldRes.written, false);
  assert.equal(oldRes && oldRes.reason, 'stale-run');
  const after = fake._store[RUN_KEY];
  assert.equal(after.runId, 'run-new');
  assert.equal(after.ownerTabKey, 'tab-new');
  assert.equal(after.heartbeatAt, 1_000_600);
});

test('PHASE 12 A4: upgradeLegacyRunId fence — late legacy upgrade is rejected when current status is no longer running/paused or runId is no longer null', async () => {
  const fake = fakeStorage();
  // Seed legacy state (status=running, runId=null).
  const legacy = Object.assign(defaults(), { status: 'running', runId: null, cursor: 0, queue: [{ id: 'v1' }] });
  delete legacy.settings;
  fake._store[RUN_KEY] = legacy;
  const auth = createAuthority(fake);
  const msgOld = holdableMessenger(auth, ['upgradeLegacyRunId']);
  const msgNew = createInProcessMessenger(auth);
  // Old realm prepares the upgrade write (held).
  let oldRes = null;
  msgOld.send('upgradeLegacyRunId', { expectedStatus: 'running', newRunId: 'run-old' }, function (res) { oldRes = res; });
  // New realm clears (Stop) — cur becomes idle, runId stays null.
  await dispatch(msgNew, 'clear', {});
  msgOld.release();
  await new Promise(function (r) { setTimeout(r, 20); });

  assert.equal(oldRes && oldRes.written, false, 'legacy upgrade must be refused when current status is idle');
  assert.equal(oldRes && oldRes.reason, 'stale-status');
  const after = fake._store[RUN_KEY];
  assert.equal(after.status, 'idle');
  assert.equal(after.runId, null, 'no stale old runId may be installed');
});

test('PHASE 12 A5: refreshHeartbeat fence — late refresh from former owner with expectedRunId=run-old is rejected when storage holds run-new', async () => {
  const fake = fakeStorage();
  const auth = createAuthority(fake);
  const msgOld = holdableMessenger(auth, ['refreshHeartbeat']);
  const msgNew = createInProcessMessenger(auth);
  await dispatch(msgNew, 'activateRun', { state: Object.assign(defaults(), { status: 'running', runId: 'run-old', cursor: 0, queue: [{ id: 'a' }], ownerTabKey: 'tab-old', heartbeatAt: 1_000_000 }) });
  let oldRes = null;
  msgOld.send('refreshHeartbeat', { expectedRunId: 'run-old', tabKey: 'tab-old', now: 1_000_500 }, function (res) { oldRes = res; });
  // New realm Stop + Start run-new with different owner and heartbeat.
  await dispatch(msgNew, 'clear', {});
  await dispatch(msgNew, 'activateRun', { state: Object.assign(defaults(), { status: 'running', runId: 'run-new', cursor: 0, queue: [{ id: 'NEW' }], ownerTabKey: 'tab-new', heartbeatAt: 1_000_600 }) });
  msgOld.release();
  await new Promise(function (r) { setTimeout(r, 20); });

  assert.equal(oldRes && oldRes.refreshed, false, 'old heartbeat must NOT refresh new run');
  const after = fake._store[RUN_KEY];
  assert.equal(after.runId, 'run-new');
  assert.equal(after.ownerTabKey, 'tab-new');
  assert.equal(after.heartbeatAt, 1_000_600);
});

test('PHASE 12 C1a: state client must propagate structured authority responses so callers can detect authority-unavailable', async () => {
  // Build a fake messenger that ALWAYS returns authority-unavailable.
  const stateMod2 = require('../lib/autopilot-state.js');
  const failingMessenger = {
    send: function (cmd, params, cb) { cb({ ok: false, reason: 'authority-unavailable' }); },
    onChange: function () { return function () {}; },
  };
  const s = stateMod2.createState(failingMessenger);
  // load: cb must NOT receive an inferred-idle state on failure.
  const loadCb = await new Promise(function (r) { s.load(function (cur) { r(cur); }); });
  assert.equal(loadCb, null, 'state.load must return null when authority is unavailable (not a fake idle state)');
  // update / save / clear / recordCourseItem / acquireOwnership / refreshHeartbeat must propagate ok=false.
  const updateRes = await new Promise(function (r) { s.update({ status: 'paused' }, function (res) { r(res); }); });
  assert.equal(updateRes && updateRes.ok, false, 'update cb must receive ok=false on authority-unavailable');
  const saveRes = await new Promise(function (r) { s.save(defaults(), function (res) { r(res); }); });
  assert.equal(saveRes && saveRes.ok, false);
  const clearRes = await new Promise(function (r) { s.clear(function (res) { r(res); }); });
  assert.equal(clearRes && clearRes.ok, false);
  const acqRes = await new Promise(function (r) { s.acquireOwnership('tab-1', 1, function (result) { r(result); }); });
  assert.equal(acqRes, 'authority-unavailable', 'acquireOwnership cb must surface authority-unavailable distinctly from foreign-active');
  const hbRes = await new Promise(function (r) { s.refreshHeartbeat('tab-1', 1, function (res) { r(res); }); });
  assert.equal(hbRes, false, 'refreshHeartbeat cb must report false when authority unavailable');
});

// ===========================================================================
// PHASE 13 — completing the authority fence. Stop is now fenced; heartbeat
// must carry an expected runId; activation does not corrupt an existing
// run; UI truthfulness is enforced at the controller level (see
// module-autopilot tests).
// ===========================================================================

test('PHASE 13 A1: late old stopRun arriving AFTER new Stop+Start is REFUSED — RUN_KEY remains run-new', async () => {
  const fake = fakeStorage();
  const auth = createAuthority(fake);
  const msgOld = holdableMessenger(auth, ['stopRun']);
  const msgNew = createInProcessMessenger(auth);
  // Activate run-old, then later transition.
  await dispatch(msgNew, 'activateRun', { state: Object.assign(defaults(), { status: 'running', runId: 'run-old', cursor: 0, queue: [{ id: 'a' }], ownerTabKey: 'tab-old', heartbeatAt: 1_000_000 }) });
  // Old realm prepares a stop for run-old; held.
  let oldStopRes = null;
  msgOld.send('stopRun', { expectedRunId: 'run-old' }, function (res) { oldStopRes = res; });
  // New realm: valid stop + activate run-new.
  const validStop = await dispatch(msgNew, 'stopRun', { expectedRunId: 'run-old' });
  assert.equal(validStop.written, true, 'in-time stop of run-old must succeed');
  await dispatch(msgNew, 'activateRun', { state: Object.assign(defaults(), { status: 'running', runId: 'run-new', cursor: 0, queue: [{ id: 'NEW' }], ownerTabKey: 'tab-new', heartbeatAt: 1_000_002 }) });
  // Release old stopRun (late).
  msgOld.release();
  await new Promise(function (r) { setTimeout(r, 20); });

  assert.equal(oldStopRes && oldStopRes.written, false, 'late old stopRun must be REFUSED');
  assert.equal(oldStopRes && oldStopRes.reason, 'stale-run');
  const after = fake._store[RUN_KEY];
  assert.equal(after.status, 'running');
  assert.equal(after.runId, 'run-new');
  assert.deepEqual(after.queue, [{ id: 'NEW' }]);
});

test('PHASE 13 A1b: stopRun with matching expectedRunId clears state (preserve intentional user Stop)', async () => {
  const fake = fakeStorage();
  const auth = createAuthority(fake);
  const m = createInProcessMessenger(auth);
  await dispatch(m, 'activateRun', { state: Object.assign(defaults(), { status: 'running', runId: 'run-1', cursor: 0, queue: [{ id: 'a' }] }) });
  const res = await dispatch(m, 'stopRun', { expectedRunId: 'run-1' });
  assert.equal(res.written, true);
  assert.equal(fake._store[RUN_KEY].status, 'idle');
  assert.equal(fake._store[RUN_KEY].runId, null);
});

test('PHASE 13 A1c: stopRun with expectedRunId=null is refused — null is not an authority', async () => {
  const fake = fakeStorage();
  const auth = createAuthority(fake);
  const m = createInProcessMessenger(auth);
  await dispatch(m, 'activateRun', { state: Object.assign(defaults(), { status: 'running', runId: 'run-1', cursor: 0, queue: [{ id: 'a' }] }) });
  const res = await dispatch(m, 'stopRun', { expectedRunId: null });
  assert.equal(res.written, false);
  assert.equal(res.reason, 'null-run-id');
  assert.equal(fake._store[RUN_KEY].status, 'running');
});

test('PHASE 13 C1: same-tab old heartbeat tick (captured expectedRunId=run-old) is REFUSED after replacement to run-new in the same tab', async () => {
  const fake = fakeStorage();
  const auth = createAuthority(fake);
  const msgOld = holdableMessenger(auth, ['refreshHeartbeat']);
  const msgNew = createInProcessMessenger(auth);
  // Activate run-old with ownerTabKey='same-tab'.
  await dispatch(msgNew, 'activateRun', { state: Object.assign(defaults(), { status: 'running', runId: 'run-old', cursor: 0, queue: [{ id: 'a' }], ownerTabKey: 'same-tab', heartbeatAt: 1_000_000 }) });
  // Capture an old heartbeat tick (carries expectedRunId='run-old').
  let oldHbRes = null;
  msgOld.send('refreshHeartbeat', { expectedRunId: 'run-old', tabKey: 'same-tab', now: 1_000_500 }, function (res) { oldHbRes = res; });
  // Valid Stop of run-old + activate run-new with the SAME tabKey.
  await dispatch(msgNew, 'stopRun', { expectedRunId: 'run-old' });
  await dispatch(msgNew, 'activateRun', { state: Object.assign(defaults(), { status: 'running', runId: 'run-new', cursor: 0, queue: [{ id: 'NEW' }], ownerTabKey: 'same-tab', heartbeatAt: 1_000_600 }) });
  // Release old heartbeat tick.
  msgOld.release();
  await new Promise(function (r) { setTimeout(r, 20); });

  assert.equal(oldHbRes && oldHbRes.refreshed, false, 'old same-tab heartbeat must be REFUSED on stale runId');
  assert.equal(oldHbRes && oldHbRes.reason, 'stale-run');
  const after = fake._store[RUN_KEY];
  assert.equal(after.runId, 'run-new');
  assert.equal(after.heartbeatAt, 1_000_600, 'run-new heartbeat must be unchanged');
});

test('PHASE 13 C1b: refreshHeartbeat WITHOUT expectedRunId is refused for active-run state (must carry runId)', async () => {
  const fake = fakeStorage();
  const auth = createAuthority(fake);
  const m = createInProcessMessenger(auth);
  await dispatch(m, 'activateRun', { state: Object.assign(defaults(), { status: 'running', runId: 'run-1', cursor: 0, queue: [{ id: 'a' }], ownerTabKey: 'tab-1', heartbeatAt: 1_000_000 }) });
  const res = await dispatch(m, 'refreshHeartbeat', { tabKey: 'tab-1', now: 1_000_500 });
  assert.equal(res.refreshed, false, 'heartbeat without expectedRunId must be refused for active runs');
  assert.equal(res.reason, 'missing-run-id');
  const after = fake._store[RUN_KEY];
  assert.equal(after.heartbeatAt, 1_000_000, 'heartbeat unchanged');
});

test('PHASE 13 D1: activateRun against an already-active (non-idle) run does NOT corrupt that run\'s owner/runId/heartbeat — fence rejects atomically', async () => {
  const fake = fakeStorage();
  const auth = createAuthority(fake);
  const m = createInProcessMessenger(auth);
  await dispatch(m, 'activateRun', { state: Object.assign(defaults(), { status: 'running', runId: 'run-existing', cursor: 5, queue: [{ id: 'EXIST' }], ownerTabKey: 'tab-existing', heartbeatAt: 1_000_000 }) });
  // Simulate a NEW start arriving while run-existing is still active (e.g.,
  // its heartbeat looks stale to the new controller). The authority must
  // refuse and NOT alter any field of run-existing.
  const res = await dispatch(m, 'activateRun', { state: Object.assign(defaults(), { status: 'running', runId: 'run-new', cursor: 0, queue: [{ id: 'NEW' }], ownerTabKey: 'tab-new', heartbeatAt: 1_000_900 }) });
  assert.equal(res.written, false, 'activateRun must refuse when there is already an active run');
  assert.equal(res.reason, 'already-active');
  const after = fake._store[RUN_KEY];
  assert.equal(after.runId, 'run-existing', 'runId must remain run-existing');
  assert.equal(after.ownerTabKey, 'tab-existing', 'ownerTabKey must remain unchanged');
  assert.equal(after.heartbeatAt, 1_000_000, 'heartbeat must remain unchanged');
  assert.equal(after.cursor, 5, 'cursor must remain unchanged');
});

test('PHASE 13 B3 authority: takeOverLegacyRun is fenced on cur.runId==null AND cur.status===expectedStatus AND cur.ownerTabKey===expectedOwnerTabKey', async () => {
  const fake = fakeStorage();
  // Seed legacy state (no runId).
  fake._store[RUN_KEY] = Object.assign(defaults(), { status: 'running', runId: null, queue: [{ id: 'a' }], cursor: 0, ownerTabKey: 'tab-foreign', heartbeatAt: 1_000_000 });
  delete fake._store[RUN_KEY].settings;
  const auth = createAuthority(fake);
  const m = createInProcessMessenger(auth);
  // Valid legacy takeover: cur.runId==null && cur.status==='running' && cur.ownerTabKey==='tab-foreign'.
  const valid = await dispatch(m, 'takeOverLegacyRun', { expectedStatus: 'running', expectedOwnerTabKey: 'tab-foreign', tabKey: 'tab-new', now: 1_000_500 });
  assert.equal(valid.written, true);
  assert.equal(fake._store[RUN_KEY].ownerTabKey, 'tab-new');
  // Stale legacy takeover after a modern activation: expectedStatus mismatch (status is now 'idle' or different runId).
  await dispatch(m, 'stopRun', { expectedRunId: null }).catch(function () {}); // stopRun(null) refused — use clear instead via fake direct write
  // Actually, simulate "current state has been replaced with a modern run".
  fake._store[RUN_KEY] = Object.assign(defaults(), { status: 'running', runId: 'run-new', queue: [{ id: 'NEW' }], cursor: 0, ownerTabKey: 'tab-modern', heartbeatAt: 1_000_900 });
  delete fake._store[RUN_KEY].settings;
  const stale = await dispatch(m, 'takeOverLegacyRun', { expectedStatus: 'running', expectedOwnerTabKey: 'tab-foreign', tabKey: 'tab-other', now: 1_001_000 });
  assert.equal(stale.written, false, 'legacy takeover must refuse when modern runId has been installed');
  const after = fake._store[RUN_KEY];
  assert.equal(after.runId, 'run-new');
  assert.equal(after.ownerTabKey, 'tab-modern');
});

// ===========================================================================
// PHASE 14 — close the remaining unfenced ownership acquisition race.
//
// Generic acquireOwnership has no expectedRunId; a late ownership claim from
// an older controller boot/resume that arrives AFTER a newer run has been
// installed would overwrite ownerTabKey/heartbeatAt without identity checks.
// The fenced replacement is claimRunOwnership(expectedRunId, tabKey, now).
// Contract:
//   * expectedRunId == null            → refuse (reason: null-run-id),
//                                        no mutation, result: 'foreign-active'
//   * cur.runId !== expectedRunId      → refuse (reason: stale-run),
//                                        no mutation, result: 'foreign-active'
//   * same expectedRunId, same tab     → return owner (no write needed if
//                                        already fresh)
//   * same expectedRunId, foreign      → if foreign owner fresh → foreign-active;
//                                        if foreign owner stale → transfer
//                                        and return owner
//
// The existing generic acquireOwnership remains for legacy paths (cur.runId
// == null) and tests, but it must REFUSE to mutate modern active state
// (cur.runId != null) because it lacks identity.
// ===========================================================================

test('PHASE 14 A1: claimRunOwnership — late claim for run-old after replacement to run-new is REFUSED (stale-run); run-new ownership untouched', async () => {
  const fake = fakeStorage();
  const auth = createAuthority(fake);
  const msgOld = holdableMessenger(auth, ['claimRunOwnership']);
  const msgNew = createInProcessMessenger(auth);
  // Activate run-old with an owner.
  await dispatch(msgNew, 'activateRun', { state: Object.assign(defaults(), {
    status: 'running', runId: 'run-old', cursor: 0, queue: [{ id: 'a' }],
    ownerTabKey: 'tab-old', heartbeatAt: 1_000_000,
  }) });
  // Old controller prepares a claimRunOwnership(expectedRunId='run-old',...);
  // held BEFORE it reaches the authority queue (delayed message arrival).
  let oldClaimRes = null;
  msgOld.send('claimRunOwnership', { expectedRunId: 'run-old', tabKey: 'tab-old', now: 1_000_100 }, function (res) { oldClaimRes = res; });
  assert.equal(msgOld.heldCount(), 1, 'old claim must be held at the messenger');
  // New realm performs a valid Stop + new activation while old claim sits held.
  const validStop = await dispatch(msgNew, 'stopRun', { expectedRunId: 'run-old' });
  assert.equal(validStop.written, true);
  const newAct = await dispatch(msgNew, 'activateRun', { state: Object.assign(defaults(), {
    status: 'running', runId: 'run-new', cursor: 2, queue: [{ id: 'NEW' }],
    ownerTabKey: 'tab-new', heartbeatAt: 1_000_500,
  }) });
  assert.equal(newAct.written, true);
  // Release the late old claim.
  msgOld.release();
  await new Promise(function (r) { setTimeout(r, 20); });

  assert.ok(oldClaimRes, 'old claim must respond');
  assert.equal(oldClaimRes.written, false, 'late old claim must be REFUSED');
  assert.equal(oldClaimRes.reason, 'stale-run');
  assert.equal(oldClaimRes.result, 'foreign-active');
  const after = fake._store[RUN_KEY];
  assert.equal(after.runId, 'run-new', 'RUN_KEY must remain run-new');
  assert.equal(after.ownerTabKey, 'tab-new', 'ownerTabKey must remain run-new\'s');
  assert.equal(after.heartbeatAt, 1_000_500, 'heartbeatAt must remain run-new\'s');
});

test('PHASE 14 A2: claimRunOwnership — same expected runId, foreign owner with STALE heartbeat → transfers ownership and returns owner', async () => {
  const fake = fakeStorage();
  fake._store[RUN_KEY] = Object.assign(defaults(), {
    status: 'running', runId: 'run-1', cursor: 0, queue: [{ id: 'a' }],
    ownerTabKey: 'tab-foreign', heartbeatAt: 0,
  });
  delete fake._store[RUN_KEY].settings;
  const auth = createAuthority(fake);
  const m = createInProcessMessenger(auth);
  const res = await dispatch(m, 'claimRunOwnership', { expectedRunId: 'run-1', tabKey: 'tab-mine', now: 1_000_000 });
  assert.equal(res.ok, true);
  assert.equal(res.result, 'owner', 'stale foreign owner should be taken over');
  const after = fake._store[RUN_KEY];
  assert.equal(after.ownerTabKey, 'tab-mine');
  assert.equal(after.heartbeatAt, 1_000_000);
  assert.equal(after.runId, 'run-1', 'runId unchanged');
});

test('PHASE 14 A3: claimRunOwnership — same expected runId, foreign owner with FRESH heartbeat → foreign-active, no mutation', async () => {
  const fake = fakeStorage();
  fake._store[RUN_KEY] = Object.assign(defaults(), {
    status: 'running', runId: 'run-1', cursor: 0, queue: [{ id: 'a' }],
    ownerTabKey: 'tab-foreign', heartbeatAt: 999_500,
  });
  delete fake._store[RUN_KEY].settings;
  const auth = createAuthority(fake);
  const m = createInProcessMessenger(auth);
  const res = await dispatch(m, 'claimRunOwnership', { expectedRunId: 'run-1', tabKey: 'tab-mine', now: 1_000_000 });
  assert.equal(res.ok, true);
  assert.equal(res.result, 'foreign-active');
  const after = fake._store[RUN_KEY];
  assert.equal(after.ownerTabKey, 'tab-foreign', 'must not transfer ownership');
  assert.equal(after.heartbeatAt, 999_500, 'must not mutate heartbeat');
});

test('PHASE 14 A3b: claimRunOwnership — same expected runId, already this tab + fresh → owner, no-op', async () => {
  const fake = fakeStorage();
  fake._store[RUN_KEY] = Object.assign(defaults(), {
    status: 'running', runId: 'run-1', cursor: 3, queue: [{ id: 'a' }],
    ownerTabKey: 'tab-mine', heartbeatAt: 999_900,
  });
  delete fake._store[RUN_KEY].settings;
  const auth = createAuthority(fake);
  const m = createInProcessMessenger(auth);
  const res = await dispatch(m, 'claimRunOwnership', { expectedRunId: 'run-1', tabKey: 'tab-mine', now: 1_000_000 });
  assert.equal(res.result, 'owner');
  assert.equal(fake._store[RUN_KEY].ownerTabKey, 'tab-mine');
});

test('PHASE 14 A4: claimRunOwnership — expectedRunId=null is refused (null is not authority); no mutation', async () => {
  const fake = fakeStorage();
  fake._store[RUN_KEY] = Object.assign(defaults(), {
    status: 'running', runId: 'run-1', cursor: 0, queue: [{ id: 'a' }],
    ownerTabKey: 'tab-existing', heartbeatAt: 1_000_000,
  });
  delete fake._store[RUN_KEY].settings;
  const auth = createAuthority(fake);
  const m = createInProcessMessenger(auth);
  const res = await dispatch(m, 'claimRunOwnership', { expectedRunId: null, tabKey: 'tab-other', now: 2_000_000 });
  assert.equal(res.written, false);
  assert.equal(res.reason, 'null-run-id');
  const after = fake._store[RUN_KEY];
  assert.equal(after.ownerTabKey, 'tab-existing');
  assert.equal(after.heartbeatAt, 1_000_000);
});

// ===========================================================================
// PHASE 15 — public-authority command-surface lockdown.
//
// PHASE 14 closed the unfenced ownership-acquisition race for every CURRENT
// controller path, but the authority itself still registers the legacy
// generic commands (save, update, clear, acquireOwnership) and the
// background service worker forwards every {type:'autopilot.state'} message
// it receives to authority.dispatch(...) without filtering. A late stale
// message that reaches the background through chrome.runtime can therefore
// still mutate RUN_KEY. PHASE 15 restricts the PRODUCTION runtime authority
// surface to fenced commands only. Local/test (publicSurface=false default)
// authorities retain the legacy surface so older PHASE 11/12 tests that use
// raw `clear`/`save`/`update`/`acquireOwnership` as setup still work.
// ===========================================================================

test('PHASE 15 A1: public-surface acquireOwnership against modern active run is REFUSED; ownerTabKey/heartbeatAt unchanged', async () => {
  const fake = fakeStorage();
  fake._store[RUN_KEY] = Object.assign(defaults(), {
    status: 'running', runId: 'run-new', cursor: 0, queue: [{ id: 'a' }],
    ownerTabKey: 'tab-new', heartbeatAt: 1_000_000,
  });
  delete fake._store[RUN_KEY].settings;
  const auth = createAuthority(fake, { publicSurface: true });
  const m = createInProcessMessenger(auth);
  const res = await dispatch(m, 'acquireOwnership', { tabKey: 'tab-stale', now: 1_000_000 + 60_000 });
  assert.equal(res.ok, false, 'must be refused at the public-authority boundary');
  assert.equal(res.reason, 'fenced-command-required');
  const after = fake._store[RUN_KEY];
  assert.equal(after.runId, 'run-new');
  assert.equal(after.ownerTabKey, 'tab-new', 'ownerTabKey must remain run-new\'s');
  assert.equal(after.heartbeatAt, 1_000_000, 'heartbeatAt must remain run-new\'s');
});

test('PHASE 15 A2: public-surface takeOverLegacyRun still works for legacy (runId==null) state', async () => {
  const fake = fakeStorage();
  fake._store[RUN_KEY] = Object.assign(defaults(), {
    status: 'running', runId: null, cursor: 0, queue: [{ id: 'a' }],
    ownerTabKey: 'tab-legacy', heartbeatAt: 0,
  });
  delete fake._store[RUN_KEY].settings;
  const auth = createAuthority(fake, { publicSurface: true });
  const m = createInProcessMessenger(auth);
  const res = await dispatch(m, 'takeOverLegacyRun', {
    expectedStatus: 'running', expectedOwnerTabKey: 'tab-legacy',
    tabKey: 'tab-new', now: 1_000_000,
  });
  assert.equal(res.ok, true);
  assert.equal(res.written, true, 'legacy takeover must succeed on public surface');
  const after = fake._store[RUN_KEY];
  assert.equal(after.ownerTabKey, 'tab-new');
  assert.equal(after.heartbeatAt, 1_000_000);
  assert.equal(after.runId, null, 'legacy runId stays null');
});

test('PHASE 15 B1: public-surface clear cannot erase a modern active run', async () => {
  const fake = fakeStorage();
  fake._store[RUN_KEY] = Object.assign(defaults(), {
    status: 'running', runId: 'run-new', cursor: 2, queue: [{ id: 'NEW' }],
    ownerTabKey: 'tab-new', heartbeatAt: 1_000_000,
  });
  delete fake._store[RUN_KEY].settings;
  const auth = createAuthority(fake, { publicSurface: true });
  const m = createInProcessMessenger(auth);
  const res = await dispatch(m, 'clear', {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'fenced-command-required');
  const after = fake._store[RUN_KEY];
  assert.equal(after.runId, 'run-new', 'modern active run must remain intact');
  assert.equal(after.status, 'running');
  assert.equal(after.cursor, 2);
  assert.equal(after.ownerTabKey, 'tab-new');
  assert.deepEqual(after.queue, [{ id: 'NEW' }]);
});

test('PHASE 15 B2: public-surface update with run fields is REFUSED; cannot pause, replace ownership, change cursor, or install a different runId', async () => {
  const fake = fakeStorage();
  fake._store[RUN_KEY] = Object.assign(defaults(), {
    status: 'running', runId: 'run-new', cursor: 2, queue: [{ id: 'NEW' }],
    ownerTabKey: 'tab-new', heartbeatAt: 1_000_000,
  });
  delete fake._store[RUN_KEY].settings;
  const auth = createAuthority(fake, { publicSurface: true });
  const m = createInProcessMessenger(auth);
  const pauseRes = await dispatch(m, 'update', { patch: { status: 'paused' } });
  assert.equal(pauseRes.ok, false);
  assert.equal(pauseRes.reason, 'fenced-command-required');
  const ownerRes = await dispatch(m, 'update', { patch: { ownerTabKey: 'tab-attacker' } });
  assert.equal(ownerRes.ok, false);
  assert.equal(ownerRes.reason, 'fenced-command-required');
  const cursorRes = await dispatch(m, 'update', { patch: { cursor: 99 } });
  assert.equal(cursorRes.ok, false);
  assert.equal(cursorRes.reason, 'fenced-command-required');
  const runIdRes = await dispatch(m, 'update', { patch: { runId: 'run-attacker' } });
  assert.equal(runIdRes.ok, false);
  assert.equal(runIdRes.reason, 'fenced-command-required');
  const after = fake._store[RUN_KEY];
  assert.equal(after.status, 'running', 'status must be unchanged');
  assert.equal(after.ownerTabKey, 'tab-new');
  assert.equal(after.cursor, 2);
  assert.equal(after.runId, 'run-new');
});

test('PHASE 15 B3: public-surface save cannot overwrite modern active RUN_KEY', async () => {
  const fake = fakeStorage();
  fake._store[RUN_KEY] = Object.assign(defaults(), {
    status: 'running', runId: 'run-new', cursor: 2, queue: [{ id: 'NEW' }],
    ownerTabKey: 'tab-new', heartbeatAt: 1_000_000,
  });
  delete fake._store[RUN_KEY].settings;
  const auth = createAuthority(fake, { publicSurface: true });
  const m = createInProcessMessenger(auth);
  const res = await dispatch(m, 'save', { state: Object.assign(defaults(), {
    status: 'running', runId: 'run-attacker', cursor: 99, queue: [],
    ownerTabKey: 'tab-attacker', heartbeatAt: 9_999_999,
  }) });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'fenced-command-required');
  const after = fake._store[RUN_KEY];
  assert.equal(after.runId, 'run-new');
  assert.equal(after.ownerTabKey, 'tab-new');
  assert.equal(after.cursor, 2);
  assert.equal(after.heartbeatAt, 1_000_000);
});

test('PHASE 15 C1: every fenced production-lifecycle command succeeds on the public-authority surface (positive control)', async () => {
  // Drives the full active-run lifecycle that module-autopilot relies on
  // through the publicSurface authority. If any production path were
  // routed through a generic/deprecated command, that command would now be
  // refused — proving by construction that the public surface is
  // sufficient for production use.
  const fake = fakeStorage();
  const auth = createAuthority(fake, { publicSurface: true });
  const m = createInProcessMessenger(auth);
  const { createState } = require('../lib/autopilot-state.js');
  const s = createState(m);

  const act = await new Promise(function (r) {
    s.activateRun(Object.assign(defaults(), {
      status: 'running', runId: 'r1', cursor: 0, queue: [{ id: 'a' }, { id: 'b' }],
      ownerTabKey: 'tab-1', heartbeatAt: 1_000_000,
    }), r);
  });
  assert.equal(act.ok, true);
  assert.equal(act.written, true, 'activateRun must succeed');

  const hb = await new Promise(function (r) { s.refreshHeartbeat('tab-1', 1_000_100, r, 'r1'); });
  assert.equal(hb, true, 'refreshHeartbeat must succeed');

  const claim = await new Promise(function (r) { s.claimRunOwnership('r1', 'tab-1', 1_000_200, r); });
  assert.equal(claim, 'owner', 'claimRunOwnership must succeed');

  const upd = await new Promise(function (r) { s.updateIfCurrentRun('r1', { cursor: 1 }, r); });
  assert.equal(upd.written, true, 'updateIfCurrentRun must succeed');

  const pause = await new Promise(function (r) { s.pauseRun('r1', 'user', r); });
  assert.equal(pause.written, true, 'pauseRun must succeed');

  const resume = await new Promise(function (r) { s.resumeRun('r1', 'tab-1', 1_000_300, r); });
  assert.equal(resume.written, true, 'resumeRun must succeed');

  const stop = await new Promise(function (r) { s.stopRun('r1', r); });
  assert.equal(stop.written, true, 'stopRun must succeed');

  assert.equal(fake._store[RUN_KEY].status, 'idle');
  assert.equal(fake._store[RUN_KEY].runId, null);
});

test('PHASE 15 D1: public-surface settings-only update writes SETTINGS_KEY (settings storage preserved)', async () => {
  const fake = fakeStorage();
  // Active-run state present; settings-only update must not touch RUN_KEY.
  fake._store[RUN_KEY] = Object.assign(defaults(), {
    status: 'running', runId: 'run-1', cursor: 4, queue: [{ id: 'a' }],
    ownerTabKey: 'tab-1', heartbeatAt: 1_000_000,
  });
  delete fake._store[RUN_KEY].settings;
  const auth = createAuthority(fake, { publicSurface: true });
  const m = createInProcessMessenger(auth);
  const res = await dispatch(m, 'update', { patch: { settings: { behaviorMode: 'human' } } });
  assert.equal(res.ok, true, 'settings-only update must succeed on public surface');
  assert.ok(fake._store[SETTINGS_KEY], 'SETTINGS_KEY must be written');
  assert.equal(fake._store[SETTINGS_KEY].behaviorMode, 'human');
  // RUN_KEY active-run fields untouched.
  assert.equal(fake._store[RUN_KEY].status, 'running');
  assert.equal(fake._store[RUN_KEY].runId, 'run-1');
  assert.equal(fake._store[RUN_KEY].cursor, 4);
});

test('PHASE 15 D2: public-surface recordCourseItem (Policy A) writes COURSE_LOG_KEY (course-log preserved)', async () => {
  const fake = fakeStorage();
  // Modern active state present — historical completion writes must remain
  // independent of active-run fencing.
  fake._store[RUN_KEY] = Object.assign(defaults(), {
    status: 'running', runId: 'run-1', cursor: 0, queue: [{ id: 'v1' }],
    ownerTabKey: 'tab-1', heartbeatAt: 1_000_000,
  });
  delete fake._store[RUN_KEY].settings;
  const auth = createAuthority(fake, { publicSurface: true });
  const m = createInProcessMessenger(auth);
  const res = await dispatch(m, 'recordCourseItem', {
    courseId: 'c1', itemId: 'v1', kind: 'video', outcome: 'video-done',
  });
  assert.equal(res.ok, true, 'recordCourseItem must succeed on public surface');
  assert.ok(fake._store[COURSE_LOG_KEY] && fake._store[COURSE_LOG_KEY].c1 && fake._store[COURSE_LOG_KEY].c1.v1);
  assert.equal(fake._store[COURSE_LOG_KEY].c1.v1.kind, 'video');
  assert.equal(fake._store[COURSE_LOG_KEY].c1.v1.outcome, 'video-done');
  // Active RUN_KEY unaffected.
  assert.equal(fake._store[RUN_KEY].runId, 'run-1');
});

test('PHASE 15 E1: internal/test surface (default) still accepts raw clear/save/update/acquireOwnership — older tests unaffected', async () => {
  // Documents the explicit distinction: tests/internal callers without
  // publicSurface:true retain the legacy command set.
  const fake = fakeStorage();
  fake._store[RUN_KEY] = Object.assign(defaults(), {
    status: 'running', runId: 'run-1', cursor: 1, queue: [{ id: 'a' }],
    ownerTabKey: 'tab-1', heartbeatAt: 1_000_000,
  });
  delete fake._store[RUN_KEY].settings;
  const auth = createAuthority(fake); // no publicSurface flag
  const m = createInProcessMessenger(auth);
  const clearRes = await dispatch(m, 'clear', {});
  assert.equal(clearRes.ok, true, 'internal clear must still work');
  assert.equal(fake._store[RUN_KEY].status, 'idle');
});

