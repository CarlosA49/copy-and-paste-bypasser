// tests/autopilot-state.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const stateModule = require('../lib/autopilot-state.js');
const {
  createState,
  defaults,
  migrateSettings,
  HEARTBEAT_TTL_MS,
  RUN_KEY,
  SETTINGS_KEY,
  COURSE_LOG_KEY,
  SETTINGS_VERSION,
} = stateModule;

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
  assert.equal(d.settings.pauseOnUserInput, false);
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

test('defaults().settings includes behaviorMode="fast" and runScope="module"', () => {
  const d = require('../lib/autopilot-state.js').defaults();
  assert.equal(d.settings.behaviorMode, 'fast');
  assert.equal(d.settings.runScope, 'module');
});

test('state.update merges settings.behaviorMode preserving other settings', (t, done) => {
  const stateMod = require('../lib/autopilot-state.js');
  const store = {};
  const storage = {
    get: function (keys, cb) { const out = {}; keys.forEach(function (k) { out[k] = store[k]; }); cb(out); },
    set: function (items, cb) { Object.assign(store, items); cb && cb(); },
  };
  const s = stateMod.createState(storage);
  s.update({ settings: { behaviorMode: 'human' } }, function () {
    s.load(function (cur) {
      assert.equal(cur.settings.behaviorMode, 'human');
      assert.equal(cur.settings.pauseOnUserInput, false); // unchanged default (opt-in)
      assert.equal(cur.settings.runScope, 'module');
      done();
    });
  });
});

// ---------------------------------------------------------------------------
// PHASE 5 — Settings versioning + one-time pauseOnUserInput migration.
//
// The old default was pauseOnUserInput=true. Some users have persisted state
// from that era; loading it now would override the new safer default (false)
// and pause every Fast/Course run on page clicks. We version the settings and
// run a one-shot migration on legacy unversioned saves.
// ---------------------------------------------------------------------------

test('SETTINGS_VERSION is exported and is a positive integer', () => {
  assert.equal(typeof SETTINGS_VERSION, 'number');
  assert.ok(SETTINGS_VERSION >= 1, 'must be at least 1');
  assert.equal(Math.floor(SETTINGS_VERSION), SETTINGS_VERSION, 'must be an integer');
});

test('defaults().settings.settingsVersion equals the current SETTINGS_VERSION', () => {
  assert.equal(defaults().settings.settingsVersion, SETTINGS_VERSION);
});

test('fresh install default: load on empty storage returns pauseOnUserInput=false at current version', async () => {
  const fake = (function () {
    const store = {};
    return {
      _store: store,
      get: function (keys, cb) { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { out[k] = store[k]; }); cb(out); },
      set: function (items, cb) { Object.keys(items).forEach(function (k) { store[k] = items[k]; }); cb && cb(); },
    };
  })();
  const s = createState(fake);
  const got = await new Promise(function (r) { s.load(r); });
  assert.equal(got.settings.pauseOnUserInput, false);
  assert.equal(got.settings.settingsVersion, SETTINGS_VERSION);
});

test('legacy unversioned saved settings with pauseOnUserInput=true migrate once to false', async () => {
  const fake = (function () {
    const store = {};
    return {
      _store: store,
      get: function (keys, cb) { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { out[k] = store[k]; }); cb(out); },
      set: function (items, cb) { Object.keys(items).forEach(function (k) { store[k] = items[k]; }); cb && cb(); },
    };
  })();
  // Legacy blob: pauseOnUserInput inherited from the old true default, no version field.
  fake._store[RUN_KEY] = {
    status: 'idle',
    cursor: 0,
    queue: [],
    settings: { pauseOnUserInput: true, autoSubmitQuizzes: false, behaviorMode: 'fast', runScope: 'module' },
  };
  const s = createState(fake);
  const got = await new Promise(function (r) { s.load(r); });
  assert.equal(got.settings.pauseOnUserInput, false, 'legacy true must migrate to false');
  assert.equal(got.settings.settingsVersion, SETTINGS_VERSION);
  // PHASE 10: migration persists settings to SETTINGS_KEY, NOT back into the
  // active-run blob. The migration write must NOT carry stale active-run
  // fields.
  const persistedSettings = fake._store[SETTINGS_KEY];
  assert.ok(persistedSettings, 'migration must persist settings to SETTINGS_KEY');
  assert.equal(persistedSettings.pauseOnUserInput, false);
  assert.equal(persistedSettings.settingsVersion, SETTINGS_VERSION);
});

test('post-migration explicit opt-in pauseOnUserInput=true survives reload', async () => {
  const fake = (function () {
    const store = {};
    return {
      _store: store,
      get: function (keys, cb) { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { out[k] = store[k]; }); cb(out); },
      set: function (items, cb) { Object.keys(items).forEach(function (k) { store[k] = items[k]; }); cb && cb(); },
    };
  })();
  // First load migrates legacy state to false + version=current.
  fake._store[RUN_KEY] = { settings: { pauseOnUserInput: true } };
  const s = createState(fake);
  await new Promise(function (r) { s.load(r); });
  // User explicitly opts back in.
  await new Promise(function (r) { s.update({ settings: { pauseOnUserInput: true } }, r); });
  // Reload: opt-in must persist (the second migration must NOT undo it).
  const got = await new Promise(function (r) { s.load(r); });
  assert.equal(got.settings.pauseOnUserInput, true, 'explicit opt-in must survive reload');
  assert.equal(got.settings.settingsVersion, SETTINGS_VERSION);
});

test('legacy unversioned saved settings with pauseOnUserInput=false (explicit-off) is preserved across migration', async () => {
  // A user who had explicitly turned the box off in the old version must not
  // see their preference rewritten (false stays false either way, but we must
  // not write back stale settingsVersion fields or other surprises).
  const fake = (function () {
    const store = {};
    return {
      _store: store,
      get: function (keys, cb) { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { out[k] = store[k]; }); cb(out); },
      set: function (items, cb) { Object.keys(items).forEach(function (k) { store[k] = items[k]; }); cb && cb(); },
    };
  })();
  fake._store[RUN_KEY] = { settings: { pauseOnUserInput: false } };
  const s = createState(fake);
  const got = await new Promise(function (r) { s.load(r); });
  assert.equal(got.settings.pauseOnUserInput, false);
  assert.equal(got.settings.settingsVersion, SETTINGS_VERSION);
});

test('load shallow-merges newer default fields into older saved state', async () => {
  const fake = fakeStorage();
  // Simulate an older stored blob that's missing several fields added later
  // (no replyHistory, no ownerTabKey, no heartbeatAt, partial settings).
  fake._store[RUN_KEY] = {
    status: 'running',
    cursor: 4,
    queue: [{ id: 'x' }],
    settings: { pauseOnUserInput: false }, // missing autoSubmitQuizzes
  };
  const s = createState(fake);
  const got = await awaitCb(s.load);
  // Stored values preserved.
  assert.equal(got.status, 'running');
  assert.equal(got.cursor, 4);
  assert.equal(got.queue.length, 1);
  assert.equal(got.settings.pauseOnUserInput, false);
  // Missing fields filled from defaults.
  assert.deepEqual(got.replyHistory, []);
  assert.equal(got.ownerTabKey, null);
  assert.equal(got.heartbeatAt, 0);
  assert.equal(got.settings.autoSubmitQuizzes, false, 'settings deep-merge fills missing leaves');
});

// =========================================================================
// PHASE 10 — Shared-coordinator, migration safety, identity guards.
//
// PHASE 9 placed the write queue inside createState(), which means TWO
// state instances sharing one storage do NOT serialize against each other.
// The real extension creates at least three: the autopilot's internal one,
// and content.js's two one-shot instances for settings (load + every
// onSettingsChange). The PHASE 10 fix promotes the queue to a shared
// coordinator keyed by the storage object itself.
//
// PHASE 10 also addresses two further holes:
//   * load()'s legacy-settings migration writes the WHOLE raw RUN_KEY blob
//     back to storage. A delayed migration write can therefore resurrect
//     status/cursor/queue/ownerTabKey/runId after Stop. The fix splits
//     settings into a separate SETTINGS_KEY so migration writes ONLY
//     settings and can never carry stale active-run fields.
//   * updateIfCurrentRun(null, patch) currently writes when both expected
//     and stored runId are null. After Stop, stored runId IS null, so a
//     stale legacy iteration with expectedRunId=null can still overwrite
//     the cleared state. PHASE 10 treats null as "no active identity"
//     and refuses the write.
// =========================================================================

function makeDeferredStorage(predicate) {
  const _store = {};
  const deferred = [];
  return {
    _store: _store,
    get: function (keys, cb) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      list.forEach(function (k) { out[k] = _store[k]; });
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
    release: function () {
      const list = deferred.splice(0);
      list.forEach(function (fn) { fn(); });
    },
    heldCount: function () { return deferred.length; },
  };
}
function _isRunCursorAdvancePatch(items) {
  const v = items && items[RUN_KEY];
  return !!(v && v.status === 'running' && typeof v.cursor === 'number' && v.cursor >= 1);
}

test('PHASE 10 A1: two createState instances sharing one storage must serialize their RUN_KEY writes — stale write does not survive clear()', async () => {
  // Models content.js's reality: an autopilot-owned state (A) and a
  // settings-owned state (B) both reference chrome.storage.local. A's
  // updateIfCurrentRun is held at the storage layer; B's clear must
  // sequence AFTER it via the SHARED queue. With per-instance queues,
  // they would race and B's clear would land FIRST, then A's release
  // overwrites — final state stale. The PHASE 10 shared coordinator
  // serializes them so the final state is what B (clear) intended.
  const deferred = makeDeferredStorage(_isRunCursorAdvancePatch);
  const A = createState(deferred);
  const B = createState(deferred);
  // Seed an active running run with runId='run-1' and a queue.
  await new Promise(function (r) { A.save(Object.assign(defaults(), {
    status: 'running', runId: 'run-1', queue: [{ id: 'a' }, { id: 'b' }], cursor: 0,
    ownerTabKey: 'tab-1', heartbeatAt: 1_000_000,
  }), r); });
  // A enqueues a cursor-advance updateIfCurrentRun; its storage.set is held.
  let _aResult = null;
  A.updateIfCurrentRun('run-1', { cursor: 1, ownerTabKey: 'tab-1', heartbeatAt: 1_000_000 }, function (res) { _aResult = res; });
  // Wait until the deferred storage.set has been captured.
  const _t0 = Date.now();
  while (deferred.heldCount() === 0 && (Date.now() - _t0) < 500) {
    await new Promise(function (r) { setTimeout(r, 10); });
  }
  assert.ok(deferred.heldCount() > 0, 'A\'s cursor-advance storage.set must be deferred');
  // B clears the run (via the same storage). With per-instance queues, B.clear
  // runs to completion immediately (writing defaults) and A's release then
  // overwrites — the stale write wins. With the PHASE 10 shared coordinator,
  // B.clear is sequenced AFTER A's pending write, so the released A-write
  // lands FIRST, then B.clear's defaults overwrite — final state is idle.
  // Fire-and-release pattern (don't await before release) keeps the test
  // sound whether the implementation serializes through a shared queue or
  // per-instance queues.
  const bClearPromise = new Promise(function (r) { B.clear(r); });
  deferred.release();
  await bClearPromise;
  await new Promise(function (r) { setTimeout(r, 100); });

  const after = deferred._store[RUN_KEY];
  assert.equal(after && after.status, 'idle', 'final state must remain idle; got ' + (after && after.status));
  assert.equal(after && after.runId, null, 'final runId must be null after clear');
  assert.equal(after && after.cursor, 0, 'cursor must NOT be the stale 1 left by A');
});

test('PHASE 10 A2: settings update from a second state instance does not resurrect old run state and does persist settings', async () => {
  // The settings UI in content.js calls createState(storage).update({settings: ...})
  // for every change. Even if a stale settings update settles AFTER Stop or
  // AFTER a fresh start, it must not write old status/cursor/queue/runId.
  // The split-storage approach: settings live in SETTINGS_KEY, not RUN_KEY.
  function _isSettingsKeyWrite(items) {
    return !!(items && Object.prototype.hasOwnProperty.call(items, 'ccp_autopilot_settings'));
  }
  const deferred = makeDeferredStorage(_isSettingsKeyWrite);
  // Seed directly to _store (bypass the queue) — using save() would also
  // write the embedded settings to SETTINGS_KEY, which the deferred predicate
  // would hold and deadlock the seed itself.
  const seedRun = Object.assign(defaults(), {
    status: 'running', runId: 'run-1', queue: [{ id: 'a' }], cursor: 0,
    ownerTabKey: 'tab-1', heartbeatAt: 1_000_000,
  });
  delete seedRun.settings;
  deferred._store[RUN_KEY] = seedRun;
  deferred._store[SETTINGS_KEY] = defaults().settings;
  const autopilotState = createState(deferred);
  const settingsState = createState(deferred);
  // settingsState begins a settings update; its SETTINGS_KEY write is held.
  settingsState.update({ settings: { behaviorMode: 'human' } }, function () {});
  const _t0 = Date.now();
  while (deferred.heldCount() === 0 && (Date.now() - _t0) < 500) {
    await new Promise(function (r) { setTimeout(r, 10); });
  }
  assert.ok(deferred.heldCount() > 0, 'settings update must defer a SETTINGS_KEY storage.set');
  // Fire clear without awaiting — under the PHASE 10 shared coordinator the
  // clear's slot legitimately waits behind the held settings update.
  const apClearPromise = new Promise(function (r) { autopilotState.clear(r); });
  deferred.release();
  await apClearPromise;
  await new Promise(function (r) { setTimeout(r, 100); });

  const afterRun = deferred._store[RUN_KEY];
  assert.equal(afterRun && afterRun.status, 'idle', 'RUN_KEY must remain idle after settings release');
  assert.equal(afterRun && afterRun.runId, null, 'RUN_KEY runId must remain null');
  // The settings update must still have persisted (just in SETTINGS_KEY).
  const merged = await new Promise(function (r) { autopilotState.load(r); });
  assert.equal(merged.settings.behaviorMode, 'human', 'settings update must still persist');
});

test('PHASE 10 B3: held migration write must NOT resurrect stale active-run fields after Stop', async () => {
  // Seed legacy RUN_KEY (settings unversioned + pauseOnUserInput=true)
  // together with active running fields. load() detects migration. The
  // migration persistence write is held by the deferred storage.
  function _migrationWritePredicate(items) {
    // The legacy load-side persist wrote RUN_KEY with stale active fields.
    // The PHASE 10 fix moves migration to SETTINGS_KEY only, so a write
    // to SETTINGS_KEY (or to RUN_KEY where the legacy path used to live)
    // can be the migration write. We hold either.
    if (items && Object.prototype.hasOwnProperty.call(items, 'ccp_autopilot_settings')) return true;
    const v = items && items[RUN_KEY];
    // legacy persist wrote a settings field with the migrated version on it.
    return !!(v && v.settings && v.settings.settingsVersion === SETTINGS_VERSION && v.status === 'running');
  }
  const deferred = makeDeferredStorage(_migrationWritePredicate);
  deferred._store[RUN_KEY] = {
    status: 'running',
    queue: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    cursor: 4,
    runId: 'run-legacy',
    ownerTabKey: 'tab-1',
    heartbeatAt: 1_000_000,
    settings: { pauseOnUserInput: true, autoSubmitQuizzes: false, behaviorMode: 'fast', runScope: 'module' },
  };
  const s = createState(deferred);
  // Trigger migration via load().
  let _loadResult = null;
  s.load(function (cur) { _loadResult = cur; });
  // The migration write must be deferred.
  const _t0 = Date.now();
  while (deferred.heldCount() === 0 && (Date.now() - _t0) < 500) {
    await new Promise(function (r) { setTimeout(r, 10); });
  }
  assert.ok(deferred.heldCount() > 0, 'migration persistence write must be deferred');
  // Stop the run. Fire-and-await pattern — clear's coordinator slot may
  // legitimately wait behind the held migration write, so we issue clear
  // first and then release; the test asserts the final state after both
  // settle in their queue-determined order.
  const clearPromise = new Promise(function (r) { s.clear(r); });
  deferred.release();
  await clearPromise;
  await new Promise(function (r) { setTimeout(r, 100); });

  const after = deferred._store[RUN_KEY];
  assert.equal(after && after.status, 'idle', 'RUN_KEY must remain idle; got ' + (after && after.status));
  assert.equal(after && after.runId, null, 'RUN_KEY runId must remain null');
  assert.deepEqual(after && after.queue, [], 'RUN_KEY queue must remain empty');
});

test('PHASE 10 B4: migration must not write stale status/cursor/queue/ownerTabKey/heartbeatAt/runId at any point', async () => {
  // Stronger variant: record EVERY storage.set call and assert that no set
  // call ever writes a RUN_KEY containing legacy active-run shape together
  // with the migrated settings flag. Migration may only patch settings.
  const seen = [];
  const inner = (function () {
    const store = {
      ccp_autopilot_run: {
        status: 'running',
        queue: [{ id: 'a' }, { id: 'b' }],
        cursor: 1,
        runId: 'run-legacy',
        ownerTabKey: 'tab-1',
        heartbeatAt: 1_000_000,
        settings: { pauseOnUserInput: true, autoSubmitQuizzes: false, behaviorMode: 'fast', runScope: 'module' },
      },
    };
    return {
      _store: store,
      get: function (keys, cb) {
        const list = Array.isArray(keys) ? keys : [keys];
        const out = {}; list.forEach(function (k) { out[k] = store[k]; }); cb(out);
      },
      set: function (items, cb) {
        seen.push(JSON.parse(JSON.stringify(items)));
        Object.keys(items).forEach(function (k) { store[k] = items[k]; });
        cb && cb();
      },
    };
  })();
  const s = createState(inner);
  await new Promise(function (r) { s.load(r); });
  // Now also stop the run and start a fresh one.
  await new Promise(function (r) { s.clear(r); });
  await new Promise(function (r) { s.update({ status: 'running', queue: [{ id: 'NEW' }], cursor: 0, runId: 'run-NEW', ownerTabKey: 'tab-1', heartbeatAt: 1_000_001 }, r); });
  // Look at every set call that wrote settingsVersion === current AND
  // also wrote any of the stale active fields on RUN_KEY.
  const offenders = seen.filter(function (items) {
    const v = items && items[RUN_KEY];
    if (!v) return false;
    if (!(v.settings && v.settings.settingsVersion === SETTINGS_VERSION)) return false;
    // A "migration write" carrying any of these active-run fields with
    // legacy values is the bug.
    const hasStaleRun = (v.status === 'running' && v.runId === 'run-legacy')
      || (v.queue && v.queue.length > 0 && v.queue[0] && v.queue[0].id === 'a')
      || (v.cursor === 1 && v.ownerTabKey === 'tab-1' && v.runId === 'run-legacy');
    return hasStaleRun;
  });
  assert.equal(offenders.length, 0, 'no storage.set may write migrated settings together with stale active-run fields; offenders=' + JSON.stringify(offenders));
});

test('PHASE 10 C7: updateIfCurrentRun(null, ...) must NOT mutate cleared idle state — null is the absence of an active identity, not a valid one', async () => {
  // After Stop, persisted state has runId=null. A stale iteration that
  // captured _expectedRunId=null must NOT be permitted to write — null
  // is an absence of identity, not an active identity. Without this fix
  // updateIfCurrentRun(null, ...) sees cur.runId===null and passes.
  const fake = fakeStorage();
  const s = createState(fake);
  // _store starts empty → load returns defaults (idle, runId=null).
  let _res = null;
  await new Promise(function (resolve) {
    s.updateIfCurrentRun(null, { status: 'running', cursor: 9, queue: [{ id: 'x' }] }, function (r) { _res = r; resolve(); });
  });
  assert.equal(_res && _res.written, false, 'updateIfCurrentRun(null) must refuse to write; got ' + JSON.stringify(_res));
  const after = fake._store[RUN_KEY];
  // Either undefined (no write happened) or still idle.
  if (after) {
    assert.equal(after.status, 'idle', 'cleared idle state must NOT be promoted to running by a null-identity update');
    assert.notEqual(after.cursor, 9, 'cursor must NOT be set by a null-identity update');
  }
});

// =========================================================================
// PHASE 11 — Cross-realm authority. PHASE 10's per-storage-wrapper queue
// (WeakMap keyed by JS object identity) does NOT survive distinct content-
// script realms — a reload, a full-document navigation, or another tab
// each construct a NEW chromeStorageOrNull() wrapper and a NEW WeakMap.
// Stale read-then-write operations from an old realm can land after Stop
// or replacement by a newer realm.
//
// The PHASE 11 fix promotes the writer to an extension-scoped authority
// reachable through a messenger. In production this is the MV3 service
// worker (background.js). In tests we construct one authority backend
// shared by multiple createInProcessMessenger clients — each client
// represents a separate realm but every mutation is serialized through
// the single backend's queue.
// =========================================================================

const { createAuthority: _ca10 } = require('../lib/autopilot-authority.js');
const { createInProcessMessenger: _ipm10 } = require('../lib/autopilot-messenger.js');

function _ph11DeferredStorage(predicate) {
  const _store = {}; const deferred = [];
  return {
    _store: _store,
    get: function (keys, cb) { const out = {}; (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { out[k] = _store[k]; }); cb(out); },
    set: function (items, cb) {
      if (predicate(items)) {
        deferred.push(function () { Object.keys(items).forEach(function (k) { _store[k] = items[k]; }); cb && cb(); });
      } else {
        Object.keys(items).forEach(function (k) { _store[k] = items[k]; });
        cb && cb();
      }
    },
    release: function () { const list = deferred.splice(0); list.forEach(function (fn) { fn(); }); },
    heldCount: function () { return deferred.length; },
  };
}

function _ph11SetupTwoRealms(storage) {
  const auth = _ca10(storage);
  const A = createState(_ipm10(auth));
  const B = createState(_ipm10(auth));
  return { auth: auth, A: A, B: B };
}

test('PHASE 11 A1: distinct realms (separate messenger clients) — old cursor-advance does NOT survive new realm\'s clear', async () => {
  function _isCursorAdvance(items) {
    const v = items && items[RUN_KEY];
    return !!(v && v.status === 'running' && v.cursor === 1);
  }
  const deferred = _ph11DeferredStorage(_isCursorAdvance);
  // Seed an active run in storage.
  const seed = Object.assign(defaults(), {
    status: 'running', runId: 'run-old', cursor: 0,
    queue: [{ id: 'a' }, { id: 'b' }], ownerTabKey: 'tab-1', heartbeatAt: 1_000_000,
  });
  delete seed.settings;
  deferred._store[RUN_KEY] = seed;
  const { A, B } = _ph11SetupTwoRealms(deferred);
  // Old realm (A) begins cursor-advance; its underlying storage.set is held.
  let _aRes = null;
  A.updateIfCurrentRun('run-old', { cursor: 1 }, function (r) { _aRes = r; });
  const _t0 = Date.now();
  while (deferred.heldCount() === 0 && (Date.now() - _t0) < 1000) {
    await new Promise(function (r) { setTimeout(r, 10); });
  }
  assert.ok(deferred.heldCount() > 0, 'old realm\'s cursor-advance must be deferred');
  // New realm (B) stops/clears via a DIFFERENT messenger client. The shared
  // authority must serialize B.clear behind A's pending write.
  const bClearPromise = new Promise(function (r) { B.clear(r); });
  deferred.release();
  await bClearPromise;
  await new Promise(function (r) { setTimeout(r, 30); });

  const after = deferred._store[RUN_KEY];
  assert.equal(after && after.status, 'idle', 'final RUN_KEY must be idle after new-realm clear; got ' + (after && after.status));
  assert.equal(after && after.runId, null, 'final runId must be null');
  assert.equal(after && after.cursor, 0, 'cursor must NOT be the stale 1');
});

test('PHASE 11 A2: old realm holds cursor-advance; new realm Stops then Starts run-new — final state is run-new\'s', async () => {
  function _isCursorAdvance(items) {
    const v = items && items[RUN_KEY];
    return !!(v && v.status === 'running' && v.cursor === 1 && v.runId === 'run-old');
  }
  const deferred = _ph11DeferredStorage(_isCursorAdvance);
  const seedOld = Object.assign(defaults(), {
    status: 'running', runId: 'run-old', cursor: 0,
    queue: [{ id: 'a' }, { id: 'b' }], ownerTabKey: 'tab-1', heartbeatAt: 1_000_000,
  });
  delete seedOld.settings;
  deferred._store[RUN_KEY] = seedOld;
  const { A, B } = _ph11SetupTwoRealms(deferred);
  A.updateIfCurrentRun('run-old', { cursor: 1 }, function () {});
  const _t0 = Date.now();
  while (deferred.heldCount() === 0 && (Date.now() - _t0) < 1000) { await new Promise(function (r) { setTimeout(r, 10); }); }
  // New realm Stops then Starts run-new.
  const bClearP = new Promise(function (r) { B.clear(r); });
  const bStartP = new Promise(function (r) {
    B.update({ status: 'running', runId: 'run-new', cursor: 0, queue: [{ id: 'X' }, { id: 'Y' }, { id: 'Z' }], ownerTabKey: 'tab-1', heartbeatAt: 1_000_001 }, r);
  });
  deferred.release();
  await bClearP; await bStartP;
  await new Promise(function (r) { setTimeout(r, 30); });

  const after = deferred._store[RUN_KEY];
  assert.equal(after && after.runId, 'run-new', 'final runId must be run-new\'s; got ' + (after && after.runId));
  assert.equal(after && after.cursor, 0, 'final cursor must be run-new\'s 0');
  assert.equal(after && Array.isArray(after.queue) && after.queue.length, 3, 'final queue must be run-new\'s 3-item queue');
});

test('PHASE 11 A3: old realm holds no-completion-indicator pause write — new realm\'s Stop wins; final remains idle, not paused', async () => {
  function _isNoCompletionPause(items) {
    const v = items && items[RUN_KEY];
    return !!(v && v.status === 'paused' && typeof v.lastPauseReason === 'string' && v.lastPauseReason.indexOf('No completion indicator') !== -1);
  }
  const deferred = _ph11DeferredStorage(_isNoCompletionPause);
  const seed = Object.assign(defaults(), {
    status: 'running', runId: 'run-old', cursor: 0, queue: [{ id: 'a' }], ownerTabKey: 'tab-1', heartbeatAt: 1_000_000,
  });
  delete seed.settings;
  deferred._store[RUN_KEY] = seed;
  const { A, B } = _ph11SetupTwoRealms(deferred);
  A.updateIfCurrentRun('run-old', { status: 'paused', ownerTabKey: null, lastPauseReason: 'No completion indicator after video — Resume to retry or stop.' }, function () {});
  const _t0 = Date.now();
  while (deferred.heldCount() === 0 && (Date.now() - _t0) < 1000) { await new Promise(function (r) { setTimeout(r, 10); }); }
  const bClearP = new Promise(function (r) { B.clear(r); });
  deferred.release();
  await bClearP;
  await new Promise(function (r) { setTimeout(r, 30); });
  const after = deferred._store[RUN_KEY];
  assert.equal(after && after.status, 'idle', 'final must remain idle; old no-completion pause must not survive new-realm clear');
  assert.equal(after && after.lastPauseReason, null);
});

test('PHASE 11 A4: old realm holds handler-error / handler-outcome pause write — new realm starts replacement; replacement remains authoritative', async () => {
  function _isHandlerErrorPause(items) {
    const v = items && items[RUN_KEY];
    return !!(v && v.status === 'paused' && typeof v.lastPauseReason === 'string' && v.lastPauseReason.indexOf('Handler error:') !== -1);
  }
  const deferred = _ph11DeferredStorage(_isHandlerErrorPause);
  const seed = Object.assign(defaults(), {
    status: 'running', runId: 'run-old', cursor: 0, queue: [{ id: 'a' }], ownerTabKey: 'tab-1', heartbeatAt: 1_000_000,
  });
  delete seed.settings;
  deferred._store[RUN_KEY] = seed;
  const { A, B } = _ph11SetupTwoRealms(deferred);
  A.updateIfCurrentRun('run-old', { status: 'paused', ownerTabKey: null, lastPauseReason: 'Handler error: late failure' }, function () {});
  const _t0 = Date.now();
  while (deferred.heldCount() === 0 && (Date.now() - _t0) < 1000) { await new Promise(function (r) { setTimeout(r, 10); }); }
  const bClearP = new Promise(function (r) { B.clear(r); });
  const bStartP = new Promise(function (r) {
    B.update({ status: 'running', runId: 'run-new', cursor: 0, queue: [{ id: 'NEW' }], ownerTabKey: 'tab-1', heartbeatAt: 1_000_001 }, r);
  });
  deferred.release();
  await bClearP; await bStartP;
  await new Promise(function (r) { setTimeout(r, 30); });
  const after = deferred._store[RUN_KEY];
  assert.equal(after && after.status, 'running', 'replacement run must remain running');
  assert.equal(after && after.runId, 'run-new', 'replacement runId must be authoritative');
});

test('defaults(): includes aiAnswerAssessments false and migration leaves it false', () => {
  const d = defaults();
  assert.equal(d.settings.aiAnswerAssessments, false);
  // Existing stored state without the field migrates to false (not undefined/true).
  const out = migrateSettings({ pauseOnUserInput: false, autoSubmitQuizzes: false, behaviorMode: 'fast', runScope: 'module' });
  const merged = Object.assign({}, defaults().settings, out.settings);
  assert.equal(merged.aiAnswerAssessments, false);
});
