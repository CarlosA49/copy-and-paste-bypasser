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

test('video handler (long video): seeks immediately to ~1 min before end, no pre-skip dwell', async () => {
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
  const p = handlers.video({ doc: doc, item: { id: 'v2', kind: 'video' }, rng: seededRng(2), signal: sig });
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
  assert.equal(sleeps.length, 1, 'only post-end sleep, no pre-skip');
  assert.ok(sleeps[0] >= 5000 && sleeps[0] <= 10000, 'post-end dwell in [5000, 10000] ms');
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
  const ctx = { doc: doc, item: { id: 'x', kind: 'video' }, rng: function () { return 0.5; }, signal: { aborted: false, addEventListener: function () {} } };
  const r = await handlers.video(ctx);
  assert.equal(r.outcome, 'video-done');
  assert.ok(fwdClicks > 0, 'forward seek button should have been clicked');
});
