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
  const out = await handlers.reading({ doc: doc, item: { id: 'r1', kind: 'reading' }, rng: rng, signal: mkSignal(), behaviorMode: 'human' });
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
  const out = await handlers.reading({ doc: doc, item: { id: 'r1', kind: 'reading' }, rng: seededRng(1), signal: mkSignal(), behaviorMode: 'human' });
  assert.equal(out.outcome, 'reading-auto');
});

test('reading handler (Fast mode): clicks visible-text Mark as completed immediately without scrolling', async () => {
  const doc = makeFakeDoc(
    '<article data-testid="reading"><p>Recommended textbook</p></article>' +
    '<button class="cds-button-primary"><span class="cds-button-label">Mark as completed</span></button>'
  );
  let clicked = false;
  let scrolled = false;
  doc.querySelector('button').addEventListener('click', function () { clicked = true; });
  const handlers = createHandlers({
    timing: require('../lib/autopilot-timing.js'),
    pageFallback: require('../lib/page-fallback.js'),
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { scrolled = true; return Promise.resolve(); },
  });
  const out = await handlers.reading({
    doc: doc,
    item: { id: 'r1', kind: 'reading' },
    rng: seededRng(1),
    signal: mkSignal(),
    behaviorMode: 'fast',
  });
  assert.equal(clicked, true);
  assert.equal(scrolled, false);
  assert.equal(out.outcome, 'reading-done-fast');
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
  const p = handlers.video({ doc: doc, item: { id: 'v1', kind: 'video' }, rng: seededRng(1), signal: sig, behaviorMode: 'human' });
  await new Promise(function (r) { setTimeout(r, 0); });
  v.dispatchEvent(new doc.defaultView.Event('ended'));
  const out = await p;
  assert.equal(out.outcome, 'video-done');
  assert.equal(out.mode, 'play-through');
  assert.ok(sleeps.length >= 1, 'should have post-end dwell');
});

test('video handler (long Human-mode video): watches the opening briefly, then seeks to ~1 min before end', async () => {
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

  const sleeps = [];
  const sleep = function (ms) { sleeps.push(ms); return Promise.resolve(); };
  const scroll = function () { return Promise.resolve(); };
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: sleep,
    jitteredScroll: scroll,
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
  });
  const sig = { aborted: false, addEventListener: function () {}, removeEventListener: function () {} };
  const p = handlers.video({ doc: doc, item: { id: 'v2', kind: 'video' }, rng: seededRng(2), signal: sig, behaviorMode: 'human' });
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.ok(seekedTo !== null, 'currentTime should have been set');
  // Seek target is duration(600) - seekFromEnd(50..70) = 530..550.
  assert.ok(seekedTo >= 530 && seekedTo <= 550,
    'seekedTo ' + seekedTo + ' should be in [530, 550]');
  v.dispatchEvent(new doc.defaultView.Event('ended'));
  const out = await p;
  assert.equal(out.outcome, 'video-done');
  assert.equal(out.mode, 'seek');
  // Only the post-end dwell should have been awaited — no pre-skip sleep.
  assert.equal(sleeps.length, 2, 'Human mode uses an opening-watch pause and a post-end pause');
  assert.ok(sleeps[0] >= 5000 && sleeps[0] <= 12000, 'opening-watch pause in [5000, 12000] ms');
  assert.ok(sleeps[1] >= 5000 && sleeps[1] <= 10000, 'post-end dwell in [5000, 10000] ms');
});

test('video handler: aborts mid-flight on signal abort (during ended wait)', async () => {
  // After the seek, the handler awaits the `ended` event via waitForEvent,
  // which honors abort. Trigger abort during that wait and confirm rejection.
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><video></video></body>'
  ).window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { configurable: true, get: function () { return 600; } });
  Object.defineProperty(v, 'currentTime', { configurable: true, get: function () { return 0; }, set: function () {} });
  v.play = function () { return Promise.resolve(); };
  v.pause = function () {};

  const sleep = function () { return Promise.resolve(); };
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
  const p = handlers.video({ doc: doc, item: { id: 'v3', kind: 'video' }, rng: seededRng(3), signal: sig, behaviorMode: 'human' })
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
  const result = await handlers.video({ doc: doc, item: { id: 'v', kind: 'video' }, rng: seededRng(1), signal: sig, behaviorMode: 'human' })
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
  const out = await handlers.video({ doc: doc, item: { id: 'v', kind: 'video' }, rng: seededRng(1), signal: sig, behaviorMode: 'human' });
  assert.equal(out.outcome, 'video-autoplay-blocked');
});

test('fallback handler: pauses when no answer text available', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><div data-testid="quiz">Quiz body</div></body>',
    { url: 'https://www.coursera.org/learn/x/quiz/q1' }
  ).window.document;
  const sleep = function () { return Promise.resolve(); };
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: sleep,
    jitteredScroll: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
    answerApplier: { applyAnswers: function () { return { selected: 0, filled: 0 }; } },
  });
  const out = await handlers.fallback({
    doc: doc, item: { id: 'q1', kind: 'quiz' },
    rng: seededRng(1), signal: { aborted: false, addEventListener: function () {} },
    getAnswerText: function () { return ''; },
    getLastCleanedCopy: function () { return null; },
    autoSubmitQuizzes: false,
  });
  assert.equal(out.outcome, 'pause-needed-no-answer');
});

test('fallback handler: applies answer and resolves when something fills', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><div data-testid="quiz">Quiz body</div></body>'
  ).window.document;
  const calls = [];
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
    answerApplier: {
      applyAnswers: function (raw, body, opts) {
        calls.push({ raw: raw, hasBody: !!body, opts: opts });
        return { selected: 2, filled: 0 };
      },
    },
  });
  const out = await handlers.fallback({
    doc: doc, item: { id: 'q1', kind: 'quiz' },
    rng: seededRng(1), signal: { aborted: false, addEventListener: function () {} },
    getAnswerText: function () { return 'A and C'; },
    getLastCleanedCopy: function () { return null; },
    autoSubmitQuizzes: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].raw, 'A and C');
  assert.equal(out.outcome, 'quiz-filled-paused-for-review');
});

test('fallback handler: uses lastCleanedCopy when sidebar text is empty', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><div data-testid="quiz">Quiz body</div></body>'
  ).window.document;
  let usedRaw = null;
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
    answerApplier: { applyAnswers: function (raw) { usedRaw = raw; return { selected: 1, filled: 0 }; } },
  });
  const out = await handlers.fallback({
    doc: doc, item: { id: 'q1', kind: 'quiz' },
    rng: seededRng(1), signal: { aborted: false, addEventListener: function () {} },
    getAnswerText: function () { return ''; },
    getLastCleanedCopy: function () { return 'fallback copy text'; },
    autoSubmitQuizzes: false,
  });
  assert.equal(usedRaw, 'fallback copy text');
  assert.equal(out.outcome, 'quiz-filled-paused-for-review');
});

test('fallback handler: clicks submit when autoSubmitQuizzes ON and applier filled something', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><div data-testid="quiz">Quiz</div>' +
    '<button type="submit" data-testid="submit">Submit</button></body>'
  ).window.document;
  const submitBtn = doc.querySelector('[data-testid="submit"]');
  let submitClicked = false;
  submitBtn.click = function () { submitClicked = true; };

  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
    answerApplier: { applyAnswers: function () { return { selected: 1, filled: 0 }; } },
  });
  const out = await handlers.fallback({
    doc: doc, item: { id: 'q1', kind: 'quiz' },
    rng: seededRng(1), signal: { aborted: false, addEventListener: function () {} },
    getAnswerText: function () { return 'A'; },
    getLastCleanedCopy: function () { return null; },
    autoSubmitQuizzes: true,
  });
  assert.equal(submitClicked, true);
  assert.equal(out.outcome, 'quiz-submitted');
});

test('fallback handler: pauses when applier returns selected=0 filled=0', async () => {
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><div data-testid="quiz">Quiz</div></body>'
  ).window.document;
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/discussion-replies.js'),
    answerApplier: { applyAnswers: function () { return { selected: 0, filled: 0 }; } },
  });
  const out = await handlers.fallback({
    doc: doc, item: { id: 'q1', kind: 'quiz' },
    rng: seededRng(1), signal: { aborted: false, addEventListener: function () {} },
    getAnswerText: function () { return 'no match'; },
    getLastCleanedCopy: function () { return null; },
    autoSubmitQuizzes: true,
  });
  assert.equal(out.outcome, 'pause-needed-no-match');
});


test('tryMarkCompleteFallback: clicks visible Mark-complete button and returns true', () => {
  const { tryMarkCompleteFallback } = require('../lib/item-handlers.js');
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><button aria-label="Mark as completed">Done</button></body>'
  ).window.document;
  const btn = doc.querySelector('button');
  let clicked = false;
  btn.click = function () { clicked = true; };
  const result = tryMarkCompleteFallback(doc);
  assert.equal(result, true);
  assert.equal(clicked, true);
});

test('tryMarkCompleteFallback: returns false when no button is present', () => {
  const { tryMarkCompleteFallback } = require('../lib/item-handlers.js');
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><div>no buttons here</div></body>'
  ).window.document;
  const result = tryMarkCompleteFallback(doc);
  assert.equal(result, false);
});

test('tryMarkCompleteFallback: matches button with data-testid mark-complete pattern', () => {
  const { tryMarkCompleteFallback } = require('../lib/item-handlers.js');
  const doc = new (require('jsdom').JSDOM)(
    '<!doctype html><body><button data-testid="mark-as-complete-button">x</button></body>'
  ).window.document;
  const btn = doc.querySelector('button');
  let clicked = false;
  btn.click = function () { clicked = true; };
  const result = tryMarkCompleteFallback(doc);
  assert.equal(result, true);
  assert.equal(clicked, true);
});

test('video handler: when direct currentTime write does not stick, falls back to Seek Video Forward 10s button', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM(
    '<!doctype html><html><body>' +
      '<video></video>' +
      '<button aria-label="Seek Video Forward 10 seconds" data-fwd></button>' +
    '</body></html>'
  );
  const doc = j.window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { value: 600, configurable: true });
  let currentTime = 0;
  Object.defineProperty(v, 'currentTime', {
    get: function () { return currentTime; },
    set: function (_) { /* ignored — DRM */ },
    configurable: true,
  });
  v.play = function () { return Promise.resolve(); };
  let fwdClicks = 0;
  doc.querySelector('[data-fwd]').addEventListener('click', function () {
    fwdClicks += 1;
    currentTime += 10;
    if (currentTime >= 590) {
      setTimeout(function () { v.dispatchEvent(new j.window.Event('ended')); }, 0);
    }
  });
  const timing = require('../lib/autopilot-timing.js');
  const handlers = require('../lib/item-handlers.js').createHandlers({
    timing: timing, sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
  });
  const ctx = { doc: doc, item: { id: 'x', kind: 'video' }, rng: function () { return 0.5; }, signal: { aborted: false, addEventListener: function () {} }, behaviorMode: 'human' };
  const r = await handlers.video(ctx);
  assert.equal(r.outcome, 'video-done');
  assert.ok(fwdClicks > 0, 'forward seek button should have been clicked');
});

test('assignment handler: ticks agreement checkbox and dispatches input+change, then pauses', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM(
    '<!doctype html><html><body>' +
      '<input id="agreement-checkbox-base" type="checkbox">' +
    '</body></html>'
  );
  const doc = j.window.document;
  const cb = doc.querySelector('#agreement-checkbox-base');
  let events = [];
  cb.addEventListener('input', function () { events.push('input'); });
  cb.addEventListener('change', function () { events.push('change'); });
  const handlers = require('../lib/item-handlers.js').createHandlers({
    timing: require('../lib/autopilot-timing.js'),
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
    pageFallback: require('../lib/page-fallback.js'),
  });
  const ctx = { doc: doc, item: { id: 'x', kind: 'quiz', url: '/learn/x/gradedLti/X7rOE/assignment-x' }, rng: function () { return 0.5; }, signal: { aborted: false, addEventListener: function () {} } };
  const r = await handlers.assignment(ctx);
  assert.equal(cb.checked, true);
  assert.deepEqual(events.sort(), ['change', 'input']);
  assert.equal(r.outcome, 'assignment-agreement-accepted-paused');
});

test('assignment handler: when no agreement checkbox is present, pauses with no-action outcome', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM('<!doctype html><html><body><div>no checkbox</div></body></html>');
  const handlers = require('../lib/item-handlers.js').createHandlers({
    timing: require('../lib/autopilot-timing.js'),
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
    pageFallback: require('../lib/page-fallback.js'),
  });
  const ctx = { doc: j.window.document, item: { id: 'x', kind: 'quiz', url: '/learn/x/gradedLti/X7rOE/assignment-x' }, rng: function () { return 0.5; }, signal: { aborted: false, addEventListener: function () {} } };
  const r = await handlers.assignment(ctx);
  assert.equal(r.outcome, 'assignment-no-action');
});

test('video handler (Fast mode): seeks to ~duration-45s and returns video-done-fast', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM('<!doctype html><html><body><video></video></body></html>');
  const doc = j.window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { value: 180, configurable: true });
  let ct = 0;
  Object.defineProperty(v, 'currentTime', {
    get: function () { return ct; },
    set: function (x) { ct = x; },
    configurable: true,
  });
  v.play = function () { return Promise.resolve(); };
  const handlers = require('../lib/item-handlers.js').createHandlers({
    timing: require('../lib/autopilot-timing.js'),
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
  });
  const ctx = {
    doc: doc, item: { id: 'x', kind: 'video' },
    rng: function () { return 0.5; },
    signal: { aborted: false, addEventListener: function () {} },
    behaviorMode: 'fast',
  };
  const r = await handlers.video(ctx);
  assert.equal(r.outcome, 'video-done-fast');
  assert.equal(Math.abs(ct - 135) < 2, true, 'currentTime should land near duration - 45');
});

test('video handler (Fast mode): seeks after duration becomes available once playback starts', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM('<!doctype html><html><body><video></video></body></html>');
  const doc = j.window.document;
  const v = doc.querySelector('video');
  let duration = NaN;
  let ct = 0;
  Object.defineProperty(v, 'duration', { get: function () { return duration; }, configurable: true });
  Object.defineProperty(v, 'currentTime', { get: function () { return ct; }, set: function (x) { ct = x; }, configurable: true });
  v.play = function () {
    Promise.resolve().then(function () { duration = 180; });
    return Promise.resolve();
  };
  const handlers = require('../lib/item-handlers.js').createHandlers({
    timing: require('../lib/autopilot-timing.js'),
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
  });
  const r = await handlers.video({
    doc: doc, item: { id: 'late-fast', kind: 'video' },
    rng: function () { return 0.5; },
    signal: { aborted: false, addEventListener: function () {}, removeEventListener: function () {} },
    behaviorMode: 'fast',
  });
  assert.equal(r.mode, 'fast-seek');
  assert.equal(ct, 135);
});

test('video handler (Fast mode): when currentTime ignored, clicks forward seek button enough times', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM(
    '<!doctype html><html><body>' +
      '<video></video>' +
      '<button aria-label="Seek Video Forward 10 seconds" data-fwd></button>' +
    '</body></html>'
  );
  const doc = j.window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { value: 180, configurable: true });
  let ct = 0;
  Object.defineProperty(v, 'currentTime', {
    get: function () { return ct; },
    set: function (_) { /* DRM, ignored */ },
    configurable: true,
  });
  v.play = function () { return Promise.resolve(); };
  let clicks = 0;
  doc.querySelector('[data-fwd]').addEventListener('click', function () { clicks += 1; ct += 10; });
  const handlers = require('../lib/item-handlers.js').createHandlers({
    timing: require('../lib/autopilot-timing.js'),
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
  });
  const ctx = {
    doc: doc, item: { id: 'x', kind: 'video' },
    rng: function () { return 0.5; },
    signal: { aborted: false, addEventListener: function () {} },
    behaviorMode: 'fast',
  };
  const r = await handlers.video(ctx);
  assert.equal(r.outcome, 'video-done-fast');
  assert.ok(clicks > 0, 'forward seek button should have been clicked');
});

test('video handler (Fast mode): paces forward-button clicks when the player updates asynchronously', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM(
    '<!doctype html><html><body>' +
      '<video></video>' +
      '<button aria-label="Seek Video Forward 10 seconds" data-fwd></button>' +
    '</body></html>'
  );
  const doc = j.window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { value: 180, configurable: true });
  let ct = 0;
  let acceptingClick = true;
  Object.defineProperty(v, 'currentTime', {
    get: function () { return ct; },
    set: function (_) { /* direct seek ignored */ },
    configurable: true,
  });
  v.play = function () { return Promise.resolve(); };
  doc.querySelector('[data-fwd]').addEventListener('click', function () {
    if (!acceptingClick) return;
    acceptingClick = false;
    Promise.resolve().then(function () {
      ct += 10;
      acceptingClick = true;
    });
  });
  const handlers = require('../lib/item-handlers.js').createHandlers({
    timing: require('../lib/autopilot-timing.js'),
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
  });
  const r = await handlers.video({
    doc: doc, item: { id: 'async-forward', kind: 'video' },
    rng: function () { return 0.5; },
    signal: { aborted: false, addEventListener: function () {}, removeEventListener: function () {} },
    behaviorMode: 'fast',
  });
  assert.equal(r.outcome, 'video-done-fast');
  assert.ok(ct >= 130, 'paced fallback should advance close to the near-end target');
});

test('video handler (Human mode): falls through to existing video-done outcome (regression check)', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM('<!doctype html><html><body><video></video></body></html>');
  const doc = j.window.document;
  const v = doc.querySelector('video');
  Object.defineProperty(v, 'duration', { value: 600, configurable: true });
  let ct = 0;
  Object.defineProperty(v, 'currentTime', { get: function () { return ct; }, set: function (x) { ct = x; }, configurable: true });
  v.play = function () { return Promise.resolve(); };
  setTimeout(function () { v.dispatchEvent(new j.window.Event('ended')); }, 0);
  const handlers = require('../lib/item-handlers.js').createHandlers({
    timing: require('../lib/autopilot-timing.js'),
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
  });
  const ctx = {
    doc: doc, item: { id: 'x', kind: 'video' },
    rng: function () { return 0.5; },
    signal: { aborted: false, addEventListener: function () {} },
    behaviorMode: 'human',
  };
  const r = await handlers.video(ctx);
  assert.equal(r.outcome, 'video-done');
});

test('video handler (Human mode): waits for a newly loaded duration, then uses its opening-watch seek path', async () => {
  const { JSDOM } = require('jsdom');
  const j = new JSDOM('<!doctype html><html><body><video></video></body></html>');
  const doc = j.window.document;
  const v = doc.querySelector('video');
  let duration = NaN;
  let ct = 0;
  Object.defineProperty(v, 'duration', { get: function () { return duration; }, configurable: true });
  Object.defineProperty(v, 'currentTime', { get: function () { return ct; }, set: function (x) { ct = x; }, configurable: true });
  v.play = function () {
    Promise.resolve().then(function () { duration = 600; });
    return Promise.resolve();
  };
  const sleeps = [];
  const handlers = require('../lib/item-handlers.js').createHandlers({
    timing: require('../lib/autopilot-timing.js'),
    sleep: function (ms) { sleeps.push(ms); return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
  });
  const p = handlers.video({
    doc: doc, item: { id: 'late-human', kind: 'video' },
    rng: function () { return 0.5; },
    signal: { aborted: false, addEventListener: function () {}, removeEventListener: function () {} },
    behaviorMode: 'human',
  });
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
  assert.ok(ct >= 530 && ct <= 550, 'Human mode should seek after duration loads');
  assert.ok(sleeps.some(function (ms) { return ms >= 5000 && ms <= 12000; }), 'Human mode should briefly watch before seeking');
  v.dispatchEvent(new j.window.Event('ended'));
  const r = await p;
  assert.equal(r.outcome, 'video-done');
  assert.equal(r.mode, 'seek');
});

test('video fast mode records element/play/duration/seek/outcome events with correct details', async () => {
  const events = [];
  const debugRecorder = { record: function (t, d) { events.push({ t: t, d: d }); } };
  const dom = new JSDOM('<!doctype html><body><video id="v"></video></body>').window.document;
  const v = dom.getElementById('v');
  Object.defineProperty(v, 'duration', { value: 600, configurable: true });
  Object.defineProperty(v, 'currentTime', { value: 0, writable: true, configurable: true });
  v.play = function () { return Promise.resolve(); };
  const h = createHandlers({
    timing: {
      fastVideoTiming: function () { return { mode: 'fast-seek', targetTimeSec: 555, postSeekWaitMs: 1 }; },
      readingDwellMs: function () { return 1; },
      discussionDwellMs: function () { return 1; },
      videoTiming: function () { return { mode: 'play-through', preSkipMs: 0, targetTimeSec: 0, postEndMs: 0 }; },
    },
    sleep: function () { return Promise.resolve(); },
    debugRecorder: debugRecorder,
  });
  const outcome = await h.video({ doc: dom, item: { id: 'vX', title: 'X', kind: 'video' }, rng: function () { return 0.5; }, behaviorMode: 'fast', signal: null });
  assert.equal(outcome.outcome, 'video-done-fast');
  const types = events.map(function (e) { return e.t; });
  assert.ok(types.indexOf('handler.start') !== -1);
  assert.ok(types.indexOf('video.element') !== -1);
  assert.ok(types.indexOf('video.duration.wait.completed') !== -1);
  assert.ok(types.indexOf('video.mode.selected') !== -1);
  assert.ok(types.indexOf('video.seek.requested') !== -1);
  assert.ok(types.indexOf('video.seek.direct.result') !== -1);
  assert.ok(types.indexOf('handler.outcome') !== -1);
  const seekResult = events.find(function (e) { return e.t === 'video.seek.direct.result'; });
  assert.equal(seekResult.d.accepted, true);
  assert.equal(seekResult.d.targetTime, 555);
});

test('video records video.element found=false when no <video> on page', async () => {
  const events = [];
  const debugRecorder = { record: function (t, d) { events.push({ t: t, d: d }); } };
  const dom = new JSDOM('<!doctype html><body></body>').window.document;
  const h = createHandlers({ timing: {}, sleep: function () { return Promise.resolve(); }, debugRecorder: debugRecorder });
  const outcome = await h.video({ doc: dom, item: { id: 'x', kind: 'video' }, rng: function () { return 0; }, behaviorMode: 'fast', signal: null });
  assert.equal(outcome.outcome, 'video-no-element');
  const ve = events.find(function (e) { return e.t === 'video.element'; });
  assert.equal(ve.d.found, false);
});

test('reading records handler.start and handler.outcome', async () => {
  const events = [];
  const debugRecorder = { record: function (t, d) { events.push({ t: t, d: d }); } };
  const dom = new JSDOM('<!doctype html><body><button aria-label="Mark as completed">Mark as completed</button></body>').window.document;
  const h = createHandlers({
    timing: { readingDwellMs: function () { return 1; } },
    sleep: function () { return Promise.resolve(); },
    jitteredScroll: function () { return Promise.resolve(); },
    debugRecorder: debugRecorder,
  });
  const outcome = await h.reading({ doc: dom, item: { id: 'r1', kind: 'reading', title: 'R' }, rng: function () { return 0; }, behaviorMode: 'fast', signal: null });
  assert.ok(/reading/.test(outcome.outcome));
  assert.ok(events.some(function (e) { return e.t === 'handler.start'; }));
  assert.ok(events.some(function (e) { return e.t === 'handler.outcome'; }));
});

test('video handler still works when debugRecorder is omitted (no regression)', async () => {
  const dom = new JSDOM('<!doctype html><body><video id="v"></video></body>').window.document;
  const v = dom.getElementById('v');
  Object.defineProperty(v, 'duration', { value: 600, configurable: true });
  v.play = function () { return Promise.resolve(); };
  const h = createHandlers({
    timing: { fastVideoTiming: function () { return { mode: 'play-through', targetTimeSec: 0, postSeekWaitMs: 1 }; } },
    sleep: function () { return Promise.resolve(); },
  });
  const outcome = await h.video({ doc: dom, item: { id: 'x', kind: 'video' }, rng: function () { return 0; }, behaviorMode: 'fast', signal: null });
  assert.equal(outcome.outcome, 'video-done-fast');
});

// ===========================================================================
// PHASE 4 — Video element readiness wait.
// In real Coursera the destination <video> element is mounted by React a few
// hundred milliseconds AFTER SPA navigation completes. The handler used to
// query once and return video-no-element on a miss. The wait makes the
// handler poll for a bounded window, abort-aware via the signal.
// ===========================================================================

function _attachVideo(dom) {
  const v = dom.createElement('video');
  dom.body.appendChild(v);
  Object.defineProperty(v, 'duration', { value: 600, configurable: true });
  Object.defineProperty(v, 'currentTime', { value: 0, writable: true, configurable: true });
  v.play = function () { return Promise.resolve(); };
  return v;
}

test('REGRESSION: Fast video tolerates a delayed <video> mount via bounded readiness poll', async () => {
  const events = [];
  const debugRecorder = { record: function (t, d) { events.push({ t: t, d: d }); } };
  const dom = new JSDOM('<!doctype html><body></body>').window.document;
  let sleepCount = 0;
  const sleep = function () {
    sleepCount += 1;
    // Mount the destination <video> after a few polls.
    if (sleepCount === 3) { _attachVideo(dom); }
    return Promise.resolve();
  };
  const h = createHandlers({
    timing: { fastVideoTiming: function () { return { mode: 'fast-seek', targetTimeSec: 555, postSeekWaitMs: 1 }; } },
    sleep: sleep,
    debugRecorder: debugRecorder,
    videoElementTimeoutMs: 2000,
    videoElementPollMs: 5,
  });
  const outcome = await h.video({ doc: dom, item: { id: '7Gsua', title: 'Arithmetic Part 2', kind: 'video' }, rng: function () { return 0.5; }, behaviorMode: 'fast', signal: null });
  assert.equal(outcome.outcome, 'video-done-fast', 'handler must succeed after the delayed mount');
  const types = events.map(function (e) { return e.t; });
  assert.ok(types.indexOf('video.element.wait.started') !== -1, 'wait.started must be recorded');
  const completed = events.find(function (e) { return e.t === 'video.element.wait.completed'; });
  assert.ok(completed, 'wait.completed must be recorded');
  assert.equal(completed.d.found, true);
  assert.ok(completed.d.polls >= 1, 'polls must be > 0 for a delayed mount');
  // video.element backward-compat: still emitted after the wait, with found=true.
  const elEvt = events.find(function (e) { return e.t === 'video.element'; });
  assert.equal(elEvt && elEvt.d.found, true);
});

test('REGRESSION: Fast video with an immediately present <video> does not waste polls', async () => {
  const events = [];
  const debugRecorder = { record: function (t, d) { events.push({ t: t, d: d }); } };
  const dom = new JSDOM('<!doctype html><body></body>').window.document;
  _attachVideo(dom);
  let sleepCount = 0;
  const h = createHandlers({
    timing: { fastVideoTiming: function () { return { mode: 'fast-seek', targetTimeSec: 555, postSeekWaitMs: 1 }; } },
    sleep: function () { sleepCount += 1; return Promise.resolve(); },
    debugRecorder: debugRecorder,
    videoElementTimeoutMs: 2000,
    videoElementPollMs: 5,
  });
  const outcome = await h.video({ doc: dom, item: { id: 'x', kind: 'video' }, rng: function () { return 0.5; }, behaviorMode: 'fast', signal: null });
  assert.equal(outcome.outcome, 'video-done-fast');
  const completed = events.find(function (e) { return e.t === 'video.element.wait.completed'; });
  assert.ok(completed, 'wait.completed must still be recorded for backward-compat snapshot');
  assert.equal(completed.d.polls, 0, 'no polls should run when the element is already present');
});

test('REGRESSION: Fast video pauses cleanly when <video> never mounts within the readiness timeout', async () => {
  const events = [];
  const debugRecorder = { record: function (t, d) { events.push({ t: t, d: d }); } };
  const dom = new JSDOM('<!doctype html><body></body>').window.document;
  let sleepCount = 0;
  // Track wall-clock so the wait can time out without real delay.
  let nowVal = 0;
  const sleep = function () { sleepCount += 1; nowVal += 50; return Promise.resolve(); };
  const h = createHandlers({
    timing: { fastVideoTiming: function () { return { mode: 'play-through', targetTimeSec: 0, postSeekWaitMs: 1 }; } },
    sleep: sleep,
    debugRecorder: debugRecorder,
    videoElementTimeoutMs: 100,
    videoElementPollMs: 5,
    nowFn: function () { return nowVal; },
  });
  const outcome = await h.video({ doc: dom, item: { id: 'x', kind: 'video' }, rng: function () { return 0.5; }, behaviorMode: 'fast', signal: null });
  assert.equal(outcome.outcome, 'video-no-element', 'must end with the no-element outcome');
  const timeout = events.find(function (e) { return e.t === 'video.element.wait.timeout'; });
  assert.ok(timeout, 'wait.timeout must be recorded');
  assert.equal(timeout.d.found, false);
  assert.ok(typeof timeout.d.elapsedMs === 'number');
  assert.ok(sleepCount > 0 && sleepCount < 100, 'must NOT loop forever');
});

test('REGRESSION: Fast video readiness wait aborts promptly when signal fires', async () => {
  const events = [];
  const debugRecorder = { record: function (t, d) { events.push({ t: t, d: d }); } };
  const dom = new JSDOM('<!doctype html><body></body>').window.document;
  const controller = (typeof AbortController === 'function') ? new AbortController() : { signal: { aborted: false, addEventListener: function () {} }, abort: function () { this.signal.aborted = true; } };
  let sleepCount = 0;
  const sleep = function (_ms, signal) {
    sleepCount += 1;
    if (sleepCount === 2 && controller && controller.abort) controller.abort();
    if (signal && signal.aborted) return Promise.reject(new Error('aborted'));
    return Promise.resolve();
  };
  const h = createHandlers({
    timing: { fastVideoTiming: function () { return { mode: 'play-through', targetTimeSec: 0, postSeekWaitMs: 1 }; } },
    sleep: sleep,
    debugRecorder: debugRecorder,
    videoElementTimeoutMs: 5000,
    videoElementPollMs: 5,
  });
  const outcome = await h.video({ doc: dom, item: { id: 'x', kind: 'video' }, rng: function () { return 0.5; }, behaviorMode: 'fast', signal: controller.signal });
  assert.equal(outcome.outcome, 'video-no-element');
  const aborted = events.find(function (e) { return e.t === 'video.element.wait.aborted'; });
  assert.ok(aborted, 'wait.aborted must be recorded');
  // Once aborted, no further play/seek/duration events should appear.
  const types = events.map(function (e) { return e.t; });
  assert.equal(types.indexOf('video.play.requested'), -1, 'must NOT request play after abort');
  assert.equal(types.indexOf('video.seek.requested'), -1, 'must NOT request seek after abort');
});

test('REGRESSION: Human video also tolerates delayed <video> mount without changing its timing semantics', async () => {
  const events = [];
  const debugRecorder = { record: function (t, d) { events.push({ t: t, d: d }); } };
  const dom = new JSDOM('<!doctype html><body></body>').window.document;
  let sleepCount = 0;
  const sleep = function () {
    sleepCount += 1;
    if (sleepCount === 2) { _attachVideo(dom); }
    return Promise.resolve();
  };
  const h = createHandlers({
    timing: {
      videoTiming: function () { return { mode: 'play-through', preSkipMs: 0, targetTimeSec: 0, postEndMs: 0 }; },
      fastVideoTiming: function () { return { mode: 'play-through', targetTimeSec: 0, postSeekWaitMs: 0 }; },
    },
    sleep: sleep,
    debugRecorder: debugRecorder,
    videoElementTimeoutMs: 2000,
    videoElementPollMs: 5,
  });
  // Human mode currently waits for 'ended'. To keep this test deterministic,
  // dispatch the ended event right after the wait succeeds.
  const origAttach = _attachVideo;
  // Monkey-patch sleep to fire 'ended' once the video is mounted.
  let endedFired = false;
  const sleep2 = function () {
    sleepCount += 1;
    if (sleepCount === 2 && !dom.querySelector('video')) {
      const v = _attachVideo(dom);
      // Fire 'ended' on next tick so the human path's Promise.race resolves.
      setTimeout(function () { if (!endedFired) { endedFired = true; v.dispatchEvent(new dom.defaultView.Event('ended')); } }, 0);
    }
    return Promise.resolve();
  };
  const h2 = createHandlers({
    timing: {
      videoTiming: function () { return { mode: 'play-through', preSkipMs: 0, targetTimeSec: 0, postEndMs: 0 }; },
      fastVideoTiming: function () { return { mode: 'play-through', targetTimeSec: 0, postSeekWaitMs: 0 }; },
    },
    sleep: sleep2,
    debugRecorder: debugRecorder,
    videoElementTimeoutMs: 2000,
    videoElementPollMs: 5,
  });
  sleepCount = 0;
  const outcome = await h2.video({ doc: dom, item: { id: 'x', kind: 'video' }, rng: function () { return 0.5; }, behaviorMode: 'human', signal: null });
  assert.equal(outcome.outcome, 'video-done', 'human path must complete after delayed mount');
  const completed = events.find(function (e) { return e.t === 'video.element.wait.completed'; });
  assert.ok(completed, 'human path also records the readiness wait');
  assert.equal(completed.d.found, true);
});

test('assessmentAi handler: builds snapshot, applies AI answers, pauses (no submit)', async () => {
  const doc = makeFakeDoc(
    '<div id="assessment-region">' +
      '<div data-testid="cml-question-1"><div>Question 1</div><fieldset>' +
        '<label><input type="radio" name="q1"> Alpha</label>' +
        '<label><input type="radio" name="q1"> Beta</label>' +
      '</fieldset></div>' +
    '</div>',
    'https://www.coursera.org/learn/x/quiz/q1/a'
  );
  const region = doc.getElementById('assessment-region');
  const courseraDom = {
    isExternalLaunchPage: function () { return false; },
    assessmentRoot: function () { return region; },
    isExcludedNode: function () { return false; },
  };
  const questionContext = require('../lib/ai-question-context.js');
  const validator = require('../lib/ai-answer-validator.js');
  const permissive = require('../lib/ai-answer-permissive.js');
  const answerApplier = require('../lib/answer-applier.js');
  // AI returns a strict-JSON answer selecting "Beta" for q1.
  const aiGenerate = function (snapshot) {
    return Promise.resolve({ ok: true, raw: JSON.stringify({ answers: [{ question_id: 'q1', answer: { value: 'Beta' } }] }) });
  };
  const handlers = createHandlers({
    sleep: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    answerApplier: answerApplier,
    questionContext: questionContext,
    validator: validator,
    permissive: permissive,
    courseraDom: courseraDom,
  });
  let submitted = false;
  doc.querySelectorAll('button[type="submit"]').forEach(function (b) { b.click = function () { submitted = true; }; });
  const out = await handlers.assessmentAi({
    doc: doc, item: { id: 'q1', kind: 'quiz' }, rng: seededRng(1), signal: mkSignal(),
    behaviorMode: 'fast', aiGenerate: aiGenerate,
    location: { origin: 'https://www.coursera.org', href: 'https://www.coursera.org/learn/x/quiz/q1/a' },
  });
  const checked = doc.querySelectorAll('input[name="q1"]:checked');
  assert.equal(checked.length, 1, 'one radio must be checked');
  assert.equal(checked[0].parentElement.textContent.trim(), 'Beta');
  assert.equal(out.outcome, 'assessment-ai-answered-paused');
  assert.equal(submitted, false, 'must NEVER auto-submit');
});

test('assessmentAi handler: missing aiGenerate yields assessment-ai-no-answer; generate error pauses', async () => {
  const doc = makeFakeDoc('<div data-testid="cml-question-1"><div>Question 1</div><fieldset><label><input type="radio" name="q1"> A</label><label><input type="radio" name="q1"> B</label></fieldset></div>', 'https://www.coursera.org/learn/x/quiz/q1/a');
  const handlers = createHandlers({
    sleep: function () { return Promise.resolve(); }, timing: require('../lib/autopilot-timing.js'),
    answerApplier: require('../lib/answer-applier.js'), questionContext: require('../lib/ai-question-context.js'),
    validator: require('../lib/ai-answer-validator.js'), permissive: require('../lib/ai-answer-permissive.js'),
    courseraDom: { isExternalLaunchPage: function () { return false; }, assessmentRoot: function (d) { return d.body; }, isExcludedNode: function () { return false; } },
  });
  const noKey = await handlers.assessmentAi({ doc: doc, item: { id: 'q1', kind: 'quiz' }, rng: seededRng(1), signal: mkSignal(), behaviorMode: 'fast', location: { origin: 'https://www.coursera.org', href: 'https://www.coursera.org/learn/x/quiz/q1/a' } });
  assert.equal(noKey.outcome, 'assessment-ai-no-answer');
  const errd = await handlers.assessmentAi({ doc: doc, item: { id: 'q1', kind: 'quiz' }, rng: seededRng(1), signal: mkSignal(), behaviorMode: 'fast', aiGenerate: function () { return Promise.reject(new Error('worker-evicted')); }, location: { origin: 'https://www.coursera.org', href: 'https://www.coursera.org/learn/x/quiz/q1/a' } });
  assert.equal(errd.outcome, 'assessment-ai-no-answer');
});

test('assessmentAi handler: external launch page yields assessment-skipped-lti', async () => {
  const doc = makeFakeDoc('<form role="form"><button>Launch App</button></form>', 'https://www.coursera.org/learn/x/gradedLti/g1/a');
  const handlers = createHandlers({
    sleep: function () { return Promise.resolve(); }, timing: require('../lib/autopilot-timing.js'),
    answerApplier: require('../lib/answer-applier.js'), questionContext: require('../lib/ai-question-context.js'),
    courseraDom: { isExternalLaunchPage: function () { return true; }, assessmentRoot: function (d) { return d.body; }, isExcludedNode: function () { return false; } },
  });
  const out = await handlers.assessmentAi({ doc: doc, item: { id: 'g1', kind: 'assignment' }, rng: seededRng(1), signal: mkSignal(), behaviorMode: 'fast', aiGenerate: function () { return Promise.resolve({ ok: true, raw: '{}' }); }, location: { origin: 'https://www.coursera.org', href: 'https://www.coursera.org/learn/x/gradedLti/g1/a' } });
  assert.equal(out.outcome, 'assessment-skipped-lti');
});

// ---- Phase D: peer-review routing ----
// NOTE: mkSignal() is defined once near the top of this file (with _abort()).
// A second, abort-less definition used to live here and — because function
// declarations hoist last-wins — it silently shadowed the real one across the
// whole file, breaking the cancellableSleep + discussion-abort tests. Removed.

test('createHandlers exposes a peerReview handler that fills a rubric and submits', async () => {
  const doc = makeFakeDoc(
    '<div data-testid="peer-review-content">' +
      '<fieldset role="radiogroup" aria-label="Clarity">' +
        '<label class="cds-checkboxAndRadio-input"><input type="radio" name="c1"><span>0 points</span></label>' +
        '<label class="cds-checkboxAndRadio-input"><input type="radio" name="c1"><span>2 points</span></label>' +
      '</fieldset>' +
      '<textarea data-required="true" aria-label="Feedback"></textarea>' +
      '<button class="cds-button-primary"><span class="cds-button-label">Submit</span></button>' +
    '</div>',
    'https://www.coursera.org/learn/x/peer/p1/review'
  );
  let submitted = false;
  doc.querySelector('.cds-button-primary').click = function () { submitted = true; };

  const fakeEngine2 = {
    TypingEngine: function FakeEngine() {
      this.start = function (opts) { opts.target.value = opts.text; opts.onDone && opts.onDone(); };
      this.stop = function () {};
    },
  };
  const fakeInjector2 = { insertOrBackspace: function () {}, isEditable: function () { return true; } };

  const handlers = createHandlers({
    sleep: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    peerReview: require('../lib/peer-review.js'),
    peerReviewReplies: require('../lib/peer-review-replies.js'),
    typingEngine: fakeEngine2,
    typingInjector: fakeInjector2,
  });

  assert.equal(typeof handlers.peerReview, 'function', 'should expose a peerReview handler');
  const out = await handlers.peerReview({
    doc: doc,
    item: { id: 'p1', kind: 'peer' },
    rng: seededRng(1),
    signal: mkSignal(),
    behaviorMode: 'fast',
    replyHistory: [],
  });
  assert.equal(doc.querySelectorAll('input[name="c1"]')[1].checked, true, 'highest option checked');
  assert.ok(doc.querySelector('textarea').value.length > 0, 'comment filled');
  assert.equal(submitted, true, 'auto-submitted');
  assert.equal(out.outcome, 'peer-review-submitted');
});

// ---- Task 4: assessmentAi auto-submit + free_text typing + needs-key + retry ----

function fakeTypingEngineModule(captured) {
  function FakeEngine() {}
  FakeEngine.prototype.start = function (opts) {
    captured.push({ text: opts.text, speed: opts.speed, profile: opts.profile });
    const s = String(opts.text || '');
    for (let i = 0; i < s.length; i++) opts.onTick({ kind: 'char', char: s[i] });
    opts.onDone();
  };
  FakeEngine.prototype.stop = function () {};
  return { TypingEngine: FakeEngine };
}

function aiAssessmentDeps(captured) {
  return {
    sleep: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    answerApplier: require('../lib/answer-applier.js'),
    questionContext: require('../lib/ai-question-context.js'),
    validator: require('../lib/ai-answer-validator.js'),
    permissive: require('../lib/ai-answer-permissive.js'),
    courseraDom: { isExternalLaunchPage: function () { return false; }, assessmentRoot: function (d) { return d.body; }, isExcludedNode: function () { return false; } },
    typingEngine: fakeTypingEngineModule(captured),
    typingInjector: require('../lib/typing-injector.js'),
  };
}

test('assessmentAi: autoSubmit on + free_text typed via engine (Fast in fast mode) + submit clicked', async () => {
  const doc = makeFakeDoc(
    '<div data-testid="cml-question-1"><div>Question 1</div><textarea id="a1"></textarea></div>' +
    '<div data-testid="quiz"><button type="submit">Submit</button></div>',
    'https://www.coursera.org/learn/x/quiz/q1/a');
  const captured = [];
  const handlers = createHandlers(aiAssessmentDeps(captured));
  let submitted = false;
  doc.querySelector('button[type="submit"]').click = function () { submitted = true; };
  const aiGenerate = function () {
    return Promise.resolve({ ok: true, raw: JSON.stringify({ token: 'ignored', answers: [{ id: 'q1', type: 'free_text', value: 'typed essay' }] }) });
  };
  const out = await handlers.assessmentAi({
    doc: doc, item: { id: 'q1', kind: 'quiz' }, rng: seededRng(1), signal: mkSignal(),
    behaviorMode: 'fast', autoSubmitQuizzes: true, aiGenerate: aiGenerate,
    location: { origin: 'https://www.coursera.org', href: 'https://www.coursera.org/learn/x/quiz/q1/a' },
  });
  assert.equal(doc.querySelector('#a1').value, 'typed essay', 'free_text typed into the box');
  assert.ok(captured.length >= 1 && captured[0].speed === 'Fast', 'fast mode uses Fast speed');
  assert.equal(out.outcome, 'assessment-ai-submitted');
  assert.equal(submitted, true);
});

test('assessmentAi: human mode types free_text at Normal speed', async () => {
  const doc = makeFakeDoc(
    '<div data-testid="cml-question-1"><div>Question 1</div><textarea id="a1"></textarea></div>' +
    '<button type="submit">Submit</button>',
    'https://www.coursera.org/learn/x/quiz/q1/a');
  const captured = [];
  const handlers = createHandlers(aiAssessmentDeps(captured));
  doc.querySelector('button[type="submit"]').click = function () {};
  const aiGenerate = function () { return Promise.resolve({ ok: true, raw: JSON.stringify({ answers: [{ id: 'q1', type: 'free_text', value: 'hi' }] }) }); };
  await handlers.assessmentAi({
    doc: doc, item: { id: 'q1', kind: 'quiz' }, rng: seededRng(1), signal: mkSignal(),
    behaviorMode: 'human', autoSubmitQuizzes: false, aiGenerate: aiGenerate,
    location: { origin: 'https://www.coursera.org', href: 'https://www.coursera.org/learn/x/quiz/q1/a' },
  });
  assert.ok(captured.length >= 1 && captured[0].speed === 'Normal', 'human mode uses Normal speed');
});

test('assessmentAi: autoSubmit off pauses for review (no submit)', async () => {
  const doc = makeFakeDoc(
    '<div data-testid="cml-question-1"><div>Question 1</div><fieldset>' +
      '<label><input type="radio" name="q1"> Alpha</label>' +
      '<label><input type="radio" name="q1"> Beta</label></fieldset></div>' +
    '<button type="submit">Submit</button>',
    'https://www.coursera.org/learn/x/quiz/q1/a');
  const handlers = createHandlers(aiAssessmentDeps([]));
  let submitted = false;
  doc.querySelector('button[type="submit"]').click = function () { submitted = true; };
  const aiGenerate = function () { return Promise.resolve({ ok: true, raw: JSON.stringify({ answers: [{ id: 'q1', type: 'single_choice', option_id: 'q1o1' }] }) }); };
  const out = await handlers.assessmentAi({
    doc: doc, item: { id: 'q1', kind: 'quiz' }, rng: seededRng(1), signal: mkSignal(),
    behaviorMode: 'fast', autoSubmitQuizzes: false, aiGenerate: aiGenerate,
    location: { origin: 'https://www.coursera.org', href: 'https://www.coursera.org/learn/x/quiz/q1/a' },
  });
  assert.equal(out.outcome, 'assessment-ai-answered-paused');
  assert.equal(submitted, false);
});

test('assessmentAi: missing-key yields assessment-ai-needs-key', async () => {
  const doc = makeFakeDoc('<div data-testid="cml-question-1"><div>Question 1</div><fieldset><label><input type="radio" name="q1"> A</label><label><input type="radio" name="q1"> B</label></fieldset></div>', 'https://www.coursera.org/learn/x/quiz/q1/a');
  const handlers = createHandlers(aiAssessmentDeps([]));
  const out = await handlers.assessmentAi({
    doc: doc, item: { id: 'q1', kind: 'quiz' }, rng: seededRng(1), signal: mkSignal(),
    behaviorMode: 'fast', autoSubmitQuizzes: true,
    aiGenerate: function () { return Promise.resolve({ ok: false, reason: 'missing-key' }); },
    location: { origin: 'https://www.coursera.org', href: 'https://www.coursera.org/learn/x/quiz/q1/a' },
  });
  assert.equal(out.outcome, 'assessment-ai-needs-key');
});

test('assessmentAi: autoSubmit on but no submit button → assessment-ai-no-submit-button', async () => {
  const doc = makeFakeDoc('<div data-testid="cml-question-1"><div>Question 1</div><textarea id="a1"></textarea></div>', 'https://www.coursera.org/learn/x/quiz/q1/a');
  const handlers = createHandlers(aiAssessmentDeps([]));
  const aiGenerate = function () { return Promise.resolve({ ok: true, raw: JSON.stringify({ answers: [{ id: 'q1', type: 'free_text', value: 'x' }] }) }); };
  const out = await handlers.assessmentAi({
    doc: doc, item: { id: 'q1', kind: 'quiz' }, rng: seededRng(1), signal: mkSignal(),
    behaviorMode: 'fast', autoSubmitQuizzes: true, aiGenerate: aiGenerate,
    location: { origin: 'https://www.coursera.org', href: 'https://www.coursera.org/learn/x/quiz/q1/a' },
  });
  assert.equal(out.outcome, 'assessment-ai-no-submit-button');
});
