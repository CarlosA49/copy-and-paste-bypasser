// tests/item-handlers.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createHandlers, cancellableSleep } = require('../lib/item-handlers.js');

function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function mkSignal() {
  const listeners = [];
  return {
    aborted: false,
    addEventListener: function (k, fn) { if (k === 'abort') listeners.push(fn); },
    removeEventListener: function () {},
    _abort: function () { this.aborted = true; listeners.forEach(function (fn) { fn(); }); },
  };
}

function makeFakeDoc(html, url) {
  const j = new JSDOM('<!doctype html><html><body>' + html + '</body></html>',
    { url: url || 'https://www.coursera.org/learn/x/supplement/r1/reading-a' });
  return j.window.document;
}

test('cancellableSleep resolves after ms and is cancellable via signal', async () => {
  const t0 = Date.now();
  await cancellableSleep(20);
  assert.ok(Date.now() - t0 >= 20);

  const sig = mkSignal();
  let rejected = false;
  const p = cancellableSleep(10000, sig).catch(function () { rejected = true; });
  sig._abort();
  await p;
  assert.equal(rejected, true);
});

test('reading handler: dwells, optionally clicks Mark as completed, resolves', async () => {
  const doc = makeFakeDoc(
    '<article data-testid="reading"><p>' + 'word '.repeat(2000) + '</p></article>' +
    '<button aria-label="Mark as completed">Mark complete</button>'
  );
  const sleeps = [];
  const sleep = function (ms) { sleeps.push(ms); return Promise.resolve(); };
  const scrolled = [];
  const scroll = function (container, opts) { scrolled.push({ container: !!container, opts: opts }); return Promise.resolve(); };
  const rng = seededRng(1);
  const handlers = createHandlers({
    sleep: sleep,
    jitteredScroll: scroll,
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
  });
  let markedClicked = false;
  const markBtn = doc.querySelector('button[aria-label="Mark as completed"]');
  const orig = markBtn.click.bind(markBtn);
  markBtn.click = function () { markedClicked = true; orig(); };
  const out = await handlers.reading({ doc: doc, item: { id: 'r1', kind: 'reading' }, rng: rng, signal: mkSignal() });
  assert.ok(scrolled.length > 0, 'should have scrolled');
  assert.equal(markedClicked, true, 'should click Mark as completed when present');
  assert.equal(out.outcome, 'reading-done');
});

test('reading handler: resolves with reading-auto when no Mark-complete button', async () => {
  const doc = makeFakeDoc('<article data-testid="reading"><p>Text.</p></article>');
  const sleep = function () { return Promise.resolve(); };
  const scroll = function () { return Promise.resolve(); };
  const handlers = createHandlers({
    sleep: sleep,
    jitteredScroll: scroll,
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
  });
  const out = await handlers.reading({ doc: doc, item: { id: 'r1', kind: 'reading' }, rng: seededRng(1), signal: mkSignal() });
  assert.equal(out.outcome, 'reading-auto');
});

test('discussion handler: types reply via typingEngine + injector, submits, returns reply text', async () => {
  const doc = makeFakeDoc(
    '<div data-testid="discussion-thread"><div>existing post</div></div>' +
    '<textarea data-role="discussion-reply" data-testid="reply-input"></textarea>' +
    '<button data-testid="submit-reply">Reply</button>',
    'https://www.coursera.org/learn/x/discussionPrompt/d1/prompt'
  );
  const sleep = function () { return Promise.resolve(); };
  const scroll = function () { return Promise.resolve(); };

  let started = false;
  let typedText = null;
  const fakeEngine = {
    TypingEngine: function FakeEngine() {
      this.start = function (opts) {
        started = true;
        typedText = opts.text;
        opts.target.value = opts.text;
        opts.onDone && opts.onDone();
      };
      this.stop = function () {};
    },
  };
  const fakeInjector = {
    insertOrBackspace: function () {},
    isEditable: function () { return true; },
  };
  let submitted = false;
  const submitBtn = doc.querySelector('[data-testid="submit-reply"]');
  submitBtn.click = function () { submitted = true; };

  const handlers = createHandlers({
    sleep: sleep,
    jitteredScroll: scroll,
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
    typingEngine: fakeEngine,
    typingInjector: fakeInjector,
  });
  const out = await handlers.discussion({
    doc: doc,
    item: { id: 'd1', kind: 'discussion' },
    rng: seededRng(1),
    signal: mkSignal(),
    replyHistory: [],
  });
  assert.equal(started, true, 'typing engine should have started');
  assert.ok(typedText && typedText.length > 0, 'should have typed some text');
  assert.equal(submitted, true, 'should have clicked the submit button');
  assert.equal(out.outcome, 'discussion-posted');
  assert.equal(out.usedReply, typedText, 'usedReply should match typed text');
});

test('discussion handler: respects replyHistory cooldown', async () => {
  const doc = makeFakeDoc(
    '<textarea data-testid="reply-input"></textarea>' +
    '<button data-testid="submit-reply">Reply</button>'
  );
  const { REPLIES } = require('../lib/discussion-replies.js');
  const history = REPLIES.slice(0, 5);
  const sleep = function () { return Promise.resolve(); };
  const scroll = function () { return Promise.resolve(); };
  const fakeEngine = {
    TypingEngine: function () {
      this.start = function (opts) { opts.target.value = opts.text; opts.onDone && opts.onDone(); };
      this.stop = function () {};
    },
  };
  const fakeInjector = { insertOrBackspace: function () {}, isEditable: function () { return true; } };
  const submitBtn = doc.querySelector('[data-testid="submit-reply"]');
  submitBtn.click = function () {};
  const handlers = createHandlers({
    sleep: sleep,
    jitteredScroll: scroll,
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
    typingEngine: fakeEngine,
    typingInjector: fakeInjector,
  });
  const out = await handlers.discussion({
    doc: doc, item: { id: 'd1', kind: 'discussion' },
    rng: seededRng(7), signal: mkSignal(), replyHistory: history,
  });
  assert.ok(history.indexOf(out.usedReply) === -1, 'picked reply must not be in cooldown history');
});

test('discussion handler: aborts mid-typing via signal, stops engine, rejects', async () => {
  const doc = makeFakeDoc(
    '<textarea data-testid="reply-input"></textarea>' +
    '<button data-testid="submit-reply">Reply</button>'
  );
  let stopped = false;
  const fakeEngine = {
    TypingEngine: function () {
      this.start = function (opts) {
        // Do NOT call onDone — simulate typing-in-progress.
        // Save opts so we could inspect later if needed.
        this._opts = opts;
      };
      this.stop = function () { stopped = true; };
    },
  };
  const fakeInjector = { insertOrBackspace: function () {}, isEditable: function () { return true; } };
  const submitBtn = doc.querySelector('[data-testid="submit-reply"]');
  submitBtn.click = function () {};

  const handlers = createHandlers({
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
    typingEngine: fakeEngine,
    typingInjector: fakeInjector,
  });
  const sig = mkSignal();
  const p = handlers.discussion({
    doc: doc, item: { id: 'd1', kind: 'discussion' },
    rng: seededRng(1), signal: sig, replyHistory: [],
  }).then(function () { return 'resolved'; }, function (e) { return 'rejected:' + (e && e.message || ''); });

  // Let the handler progress to the typing promise where it attaches the abort listener.
  await new Promise(function (r) { setTimeout(r, 0); });
  sig._abort();
  const result = await p;
  assert.equal(result, 'rejected:aborted');
  assert.equal(stopped, true, 'engine.stop() should have been called on abort');
});

test('video handler (short video): plays through, waits for ended, post-end dwell, resolves', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><video></video></body>',
    { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' }
  ).window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { configurable: true, get: function () { return 60; } });
  v.play = function () { v.paused = false; };
  v.pause = function () { v.paused = true; };

  const sleeps = [];
  const sleep = function (ms) { sleeps.push(ms); return Promise.resolve(); };
  const scroll = function () { return Promise.resolve(); };
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: sleep,
    jitteredScroll: scroll,
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
  });
  const sig = (function () {
    const listeners = [];
    return { aborted: false, addEventListener: function (k, fn) { if (k === 'abort') listeners.push(fn); }, removeEventListener: function () {}, _abort: function () { this.aborted = true; listeners.forEach(function (fn) { fn(); }); } };
  })();
  const p = handlers.video({ doc: doc, item: { id: 'v1', kind: 'video' }, rng: seededRng(1), signal: sig });
  await new Promise(function (r) { setTimeout(r, 0); });
  v.dispatchEvent(new doc.defaultView.Event('ended'));
  const out = await p;
  assert.equal(out.outcome, 'video-done');
  assert.equal(out.mode, 'play-through');
  assert.ok(sleeps.length >= 1, 'should have post-end dwell');
});

test('video handler (long video): seeks to targetTime then waits for ended', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><video></video></body>',
    { url: 'https://www.coursera.org/learn/x/lecture/v2/long' }
  ).window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { configurable: true, get: function () { return 600; } });
  let seekedTo = null;
  Object.defineProperty(v, 'currentTime', {
    configurable: true,
    get: function () { return seekedTo || 0; },
    set: function (val) { seekedTo = val; },
  });
  v.play = function () { v.paused = false; };
  v.pause = function () { v.paused = true; };

  const sleep = function () { return Promise.resolve(); };
  const scroll = function () { return Promise.resolve(); };
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: sleep,
    jitteredScroll: scroll,
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
  });
  const sig = { aborted: false, addEventListener: function () {}, removeEventListener: function () {} };
  const p = handlers.video({ doc: doc, item: { id: 'v2', kind: 'video' }, rng: seededRng(2), signal: sig });
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.ok(seekedTo !== null, 'currentTime should have been set');
  v.dispatchEvent(new doc.defaultView.Event('ended'));
  const out = await p;
  assert.equal(out.outcome, 'video-done');
  assert.equal(out.mode, 'seek');
  assert.ok(seekedTo >= 480 && seekedTo <= 540,
    'seekedTo ' + seekedTo + ' should be in [480, 540]');
});

test('video handler: aborts mid-flight on signal abort', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><video></video></body>'
  ).window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { configurable: true, get: function () { return 600; } });
  Object.defineProperty(v, 'currentTime', { configurable: true, get: function () { return 0; }, set: function () {} });
  v.play = function () {};
  v.pause = function () {};

  const sleep = function (ms, signal) {
    return new Promise(function (resolve, reject) {
      if (signal && signal.addEventListener) {
        signal.addEventListener('abort', function () { reject(new Error('aborted')); });
      }
    });
  };
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: sleep,
    jitteredScroll: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
  });
  const listeners = [];
  const sig = {
    aborted: false,
    addEventListener: function (k, fn) { if (k === 'abort') listeners.push(fn); },
    removeEventListener: function () {},
  };
  const p = handlers.video({ doc: doc, item: { id: 'v3', kind: 'video' }, rng: seededRng(3), signal: sig })
    .then(function () { return 'resolved'; }, function (e) { return 'rejected:' + (e && e.message || ''); });
  await new Promise(function (r) { setTimeout(r, 0); });
  sig.aborted = true;
  listeners.forEach(function (fn) { fn(); });
  const result = await p;
  assert.equal(result, 'rejected:aborted');
});

test('video handler: waitForEvent honors an already-aborted signal', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><video></video></body>'
  ).window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { configurable: true, get: function () { return 60; } });
  v.play = function () { return Promise.resolve(); };

  // Sleep that resolves immediately so the handler reaches waitForEvent quickly.
  const sleep = function () { return Promise.resolve(); };
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: sleep,
    jitteredScroll: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
  });
  const sig = {
    aborted: true, // pre-aborted
    addEventListener: function () {},
    removeEventListener: function () {},
  };
  const result = await handlers.video({ doc: doc, item: { id: 'v', kind: 'video' }, rng: seededRng(1), signal: sig })
    .then(function () { return 'resolved'; }, function (e) { return 'rejected:' + (e && e.message || ''); });
  assert.equal(result, 'rejected:aborted', 'pre-aborted signal should reject waitForEvent immediately');
});

test('video handler: returns video-autoplay-blocked when v.play() rejects and ended never fires', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><video></video></body>'
  ).window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { configurable: true, get: function () { return 60; } });
  v.play = function () { return Promise.reject(new Error('NotAllowedError')); };

  const sleep = function () { return Promise.resolve(); };
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: sleep,
    jitteredScroll: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
  });
  const sig = { aborted: false, addEventListener: function () {}, removeEventListener: function () {} };
  const out = await handlers.video({ doc: doc, item: { id: 'v', kind: 'video' }, rng: seededRng(1), signal: sig });
  assert.equal(out.outcome, 'video-autoplay-blocked');
});
