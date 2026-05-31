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
  const ev = r.getEvents();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'x');
});

test('record swallows internal errors and never throws into caller', () => {
  const r = createDebugRecorder({ nowFn: function () { throw new Error('boom'); } });
  assert.doesNotThrow(function () { r.record('a', { x: 1 }); });
});

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
      { at: 't3', type: 'video.duration.initial', details: { itemId: 'v6', value: null } },
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

test('formatDebugReport VIDEO STATE surfaces element-wait fields (waited, found, polls, elapsedMs, timeoutMs)', () => {
  const snap = {
    capturedAt: '2026-05-25T00:00:00.000Z',
    context: { status: 'running' },
    events: [
      { at: 't1', type: 'handler.start', details: { itemId: '7Gsua', title: 'Arithmetic Part 2', kind: 'video', behaviorMode: 'fast' } },
      { at: 't2', type: 'video.element.wait.started', details: { itemId: '7Gsua', timeoutMs: 7000 } },
      { at: 't3', type: 'video.element.wait.completed', details: { itemId: '7Gsua', found: true, polls: 4, elapsedMs: 620, timeoutMs: 7000 } },
      { at: 't4', type: 'video.element', details: { itemId: '7Gsua', found: true } },
      { at: 't5', type: 'handler.outcome', details: { itemId: '7Gsua', outcome: 'video-done-fast', mode: 'fast' } },
    ],
  };
  const out = formatDebugReport(snap);
  assert.ok(/VIDEO STATE\b/.test(out));
  assert.ok(/element\.waited=true/.test(out));
  assert.ok(/element\.found=true/.test(out));
  assert.ok(/element\.polls=4/.test(out));
  assert.ok(/element\.elapsedMs=620/.test(out));
  assert.ok(/element\.timeoutMs=7000/.test(out));
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

test('formatDebugReport: redacts AI prompt/snapshot/choice fields but leaves generic value untouched', () => {
  const snap = { capturedAt: '2026-05-25T00:00:00.000Z', context: { status: 'running' }, events: [] };
  snap.events.push({ at: 't1', type: 'handler.outcome', details: {
    handler: 'assessment-ai',
    prompt: 'SECRET_PROMPT',
    snapshot: { questions: [{ prompt: 'SECRET_Q' }] },
    choiceText: 'SECRET_CHOICE',
    choiceTexts: ['SECRET_A', 'SECRET_B'],
    value: 42,
  } });
  const out = formatDebugReport(snap);
  ['SECRET_PROMPT', 'SECRET_Q', 'SECRET_CHOICE', 'SECRET_A', 'SECRET_B'].forEach(function (s) {
    assert.ok(out.indexOf(s) === -1, 'must redact ' + s);
  });
  // Generic keys that existing events legitimately emit are NOT redacted.
  assert.ok(/value=42/.test(out), 'generic value key must NOT be redacted (existing events rely on it)');
});
