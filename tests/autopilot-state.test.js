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
