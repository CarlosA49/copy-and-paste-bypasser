'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createAiController } = require('../lib/ai-answer-controller.js');
const { createOpenOptionsCallback } = require('../lib/ai-open-options-content.js');

function fakeSidebar() {
  const state = {
    keyStatus: null,
    eligibility: null,
    scanResult: null,
    suggestions: null,
    applyResult: null,
    inFlight: null,
    handlers: null,
  };
  return {
    state: state,
    setAiKeyStatus: function (b) { state.keyStatus = b; },
    setAiPageEligibility: function (e) { state.eligibility = e; },
    setAiScanResult: function (s) { state.scanResult = s; },
    setAiSuggestions: function (l) { state.suggestions = l; },
    setAiApplyResult: function (r) { state.applyResult = r; },
    setAiInFlight: function (f) { state.inFlight = f; },
    setAiAnswerHandlers: function (h) { state.handlers = h; },
  };
}

function fakeMessenger(impl) {
  const calls = [];
  const send = function (cmd, params, cb) {
    calls.push({ cmd: cmd, params: params });
    Promise.resolve(impl(cmd, params)).then(function (res) { cb(res); });
  };
  return { send: send, calls: calls };
}

function radioPage(label) {
  return '<section><h3>Question 1</h3><p>' + (label || 'Pick') + '</p>'
    + '<label><input type="radio" name="r1">Alpha</label>'
    + '<label><input type="radio" name="r1">Beta</label>'
    + '</section>';
}

function setup(html, url) {
  const dom = new JSDOM('<!doctype html><html><body>' + (html || radioPage()) + '</body></html>', { url: url || 'https://www.coursera.org/learn/x/lecture/v1/intro' });
  const questionContext = require('../lib/ai-question-context.js');
  const validator = require('../lib/ai-answer-validator.js');
  const answerApplier = require('../lib/answer-applier.js');
  const sidebar = fakeSidebar();
  const controller = createAiController({
    sidebar: sidebar, questionContext: questionContext, validator: validator, answerApplier: answerApplier,
    messenger: null, // set per test
    document: dom.window.document, location: dom.window.location,
  });
  return { dom, sidebar, controller, questionContext, validator };
}

test('wire() installs handlers and runs initial key refresh', () => {
  const { dom, sidebar, controller } = setup();
  controller.messenger = fakeMessenger(function (cmd) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    return { ok: true };
  });
  controller.wire();
  assert.ok(sidebar.state.handlers, 'sidebar received handlers');
  assert.equal(typeof sidebar.state.handlers.onScan, 'function');
  assert.equal(typeof sidebar.state.handlers.onOpenOptions, 'function', 'onOpenOptions handler must be wired');
  assert.equal(sidebar.state.handlers.onSaveKey, undefined, 'onSaveKey must not be present');
});

test('Scan -> Generate -> Apply: end-to-end via production controller', async () => {
  const { dom, sidebar, controller } = setup();
  controller.messenger = fakeMessenger(function (cmd, params) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') {
      const snap = params.snapshot;
      const q = snap.questions[0];
      return { ok: true, raw: { answers: [{ question_id: q.id, answer: { type: 'single_choice', option_ids: [q.options[1].id] }, explanation: '', confidence: 'high' }] } };
    }
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.ok(sidebar.state.scanResult);
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.ok(sidebar.state.suggestions && sidebar.state.suggestions.length === 1);
  controller.performApply();
  const radios = dom.window.document.querySelectorAll('input[type="radio"]');
  assert.equal(radios[1].checked, true, 'Beta radio selected by Apply');
});

test('Apply refuses when page changed (stale structural token)', async () => {
  const { dom, sidebar, controller } = setup();
  controller.messenger = fakeMessenger(function (cmd, params) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') {
      const q = params.snapshot.questions[0];
      return { ok: true, raw: { answers: [{ question_id: q.id, answer: { type: 'single_choice', option_ids: [q.options[0].id] }, explanation: '' }] } };
    }
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  // Mutate the DOM after Generate
  const lbl = dom.window.document.createElement('label');
  lbl.innerHTML = '<input type="radio" name="r1">Gamma';
  dom.window.document.querySelector('section').appendChild(lbl);
  controller.performApply();
  assert.ok(sidebar.state.applyResult.message && /page changed/i.test(sidebar.state.applyResult.message));
});

test('Generate error maps to a user-facing message via setAiApplyResult.message', async () => {
  const { dom, sidebar, controller } = setup();
  controller.messenger = fakeMessenger(function (cmd) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: false };
    if (cmd === 'generateAnswers') return { ok: false, reason: 'missing-key' };
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.ok(sidebar.state.applyResult);
  assert.ok(sidebar.state.applyResult.message && /API key/i.test(sidebar.state.applyResult.message));
});

test('E4: performGenerate refuses when sanitized payload is empty — no messenger call', async () => {
  // page has only an already-filled text input
  const html = '<section><h3>Question 1</h3><p>filled</p><input type="text" value="x"></section>';
  const { dom, sidebar, controller } = setup(html);
  controller.messenger = fakeMessenger(function (cmd) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') return { ok: true, raw: { answers: [] } };
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  const callsBefore = controller.messenger.calls.filter(function (c) { return c.cmd === 'generateAnswers'; }).length;
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  const callsAfter = controller.messenger.calls.filter(function (c) { return c.cmd === 'generateAnswers'; }).length;
  assert.equal(callsAfter, callsBefore, 'no generateAnswers message sent');
  // Sidebar should have a message indicating no actionable
  assert.ok(sidebar.state.applyResult && /No unanswered supported questions/i.test(sidebar.state.applyResult.message));
});

test('messenger send body is sanitized — no raw DOM / no internal fields beyond sanitizeForRequest output', async () => {
  const { dom, sidebar, controller, questionContext } = setup();
  let captured = null;
  controller.messenger = fakeMessenger(function (cmd, params) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') { captured = params.snapshot; return { ok: true, raw: { answers: [] } }; }
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.ok(captured);
  // sanitizeForRequest output has token/page/questions — no DOM, no internal supported/alreadyAnswered flags
  captured.questions.forEach(function (q) {
    assert.equal('alreadyAnswered' in q, false, 'sanitized question must not include alreadyAnswered');
    assert.equal('supported' in q, false, 'sanitized question must not include supported flag');
    assert.equal('el' in q, false);
    assert.equal('container' in q, false);
    assert.equal('targets' in q, false);
  });
});

test('B1: Apply refuses after user types into a text input post-Generate; user value preserved', async () => {
  const html = '<section><h3>Question 1</h3><p>Enter x</p><input type="text" id="t1"></section>';
  const { dom, sidebar, controller } = setup(html);
  controller.messenger = fakeMessenger(function (cmd, params) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') {
      const q = params.snapshot.questions[0];
      return { ok: true, raw: { answers: [{ question_id: q.id, answer: { type: 'text', value: 'ai-value' }, explanation: '' }] } };
    }
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  // User types after Generate
  dom.window.document.getElementById('t1').value = 'user-typed-this';
  controller.performApply();
  // Refusal message and user value preserved
  assert.ok(sidebar.state.applyResult.message && /Answers were changed/i.test(sidebar.state.applyResult.message));
  assert.equal(dom.window.document.getElementById('t1').value, 'user-typed-this');
});

test('B2: Apply refuses after user selects a radio post-Generate; user selection preserved', async () => {
  const html = '<section><h3>Question 1</h3><p>Pick</p>'
    + '<label><input type="radio" name="r1">Alpha</label>'
    + '<label><input type="radio" name="r1">Beta</label>'
    + '<label><input type="radio" name="r1">Gamma</label></section>';
  const { dom, sidebar, controller } = setup(html);
  controller.messenger = fakeMessenger(function (cmd, params) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') {
      const q = params.snapshot.questions[0];
      return { ok: true, raw: { answers: [{ question_id: q.id, answer: { type: 'single_choice', option_ids: [q.options[0].id] } }] } };
    }
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  // User selects Gamma (index 2)
  const radios = dom.window.document.querySelectorAll('input[type="radio"]');
  radios[2].checked = true;
  controller.performApply();
  assert.ok(sidebar.state.applyResult.message && /Answers were changed/i.test(sidebar.state.applyResult.message));
  assert.equal(radios[2].checked, true);
  assert.equal(radios[0].checked, false);
});

test('B3: Apply refuses after user ticks a checkbox post-Generate; user choices preserved', async () => {
  const html = '<section><h3>Question 1</h3><p>Pick</p>'
    + '<label><input type="checkbox" name="c1">A</label>'
    + '<label><input type="checkbox" name="c1">B</label>'
    + '<label><input type="checkbox" name="c1">C</label></section>';
  const { dom, sidebar, controller } = setup(html);
  controller.messenger = fakeMessenger(function (cmd, params) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') {
      const q = params.snapshot.questions[0];
      return { ok: true, raw: { answers: [{ question_id: q.id, answer: { type: 'multiple_choice', option_ids: [q.options[0].id, q.options[2].id] } }] } };
    }
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  // User ticks B (index 1)
  const cbs = dom.window.document.querySelectorAll('input[type="checkbox"]');
  cbs[1].checked = true;
  controller.performApply();
  assert.ok(sidebar.state.applyResult.message && /Answers were changed/i.test(sidebar.state.applyResult.message));
  // User's choice preserved, AI's suggested A+C not applied
  assert.equal(cbs[0].checked, false);
  assert.equal(cbs[1].checked, true);
  assert.equal(cbs[2].checked, false);
});

test('B4: structural changes still trigger the existing token mismatch refusal', async () => {
  const html = '<section><h3>Question 1</h3><p>P</p>'
    + '<label><input type="radio" name="r1">A</label>'
    + '<label><input type="radio" name="r1">B</label></section>';
  const { dom, sidebar, controller } = setup(html);
  controller.messenger = fakeMessenger(function (cmd, params) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') {
      const q = params.snapshot.questions[0];
      return { ok: true, raw: { answers: [{ question_id: q.id, answer: { type: 'single_choice', option_ids: [q.options[0].id] } }] } };
    }
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  // ADD an option — structural change
  const lbl = dom.window.document.createElement('label');
  lbl.innerHTML = '<input type="radio" name="r1">Gamma';
  dom.window.document.querySelector('section').appendChild(lbl);
  controller.performApply();
  assert.ok(sidebar.state.applyResult.message && /page changed/i.test(sidebar.state.applyResult.message));
});

test('B5: messenger send body never contains the localGuard', async () => {
  const html = '<section><h3>Question 1</h3><p>P</p><input type="text"></section>';
  const { dom, sidebar, controller } = setup(html);
  let capturedBody = null;
  controller.messenger = fakeMessenger(function (cmd, params) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') { capturedBody = params.snapshot; return { ok: true, raw: { answers: [] } }; }
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.ok(capturedBody);
  assert.equal(JSON.stringify(capturedBody).indexOf('localGuard'), -1);
  assert.equal(JSON.stringify(capturedBody).indexOf('selectedOptionIds'), -1);
  assert.equal(JSON.stringify(capturedBody).indexOf('answerFingerprint'), -1);
});

// ---------------------------------------------------------------------------
// H7 — Honest error message rendering (C1-C6)
// ---------------------------------------------------------------------------

test('C1: missing-key from background renders the missing-key message', async () => {
  const { dom, sidebar, controller } = setup();
  controller.messenger = fakeMessenger(function (cmd) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: false };
    if (cmd === 'generateAnswers') return { ok: false, reason: 'missing-key' };
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(sidebar.state.applyResult.message, 'Enter an AI API Key before generating suggestions.');
});

test('C2: unauthorized renders the unauthorized message', async () => {
  const { dom, sidebar, controller } = setup();
  controller.messenger = fakeMessenger(function (cmd) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') return { ok: false, reason: 'unauthorized' };
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(sidebar.state.applyResult.message, 'The AI service rejected the API key. Check the key and try again.');
});

test('C3: network/timeout/aborted each render their intended message', async () => {
  const cases = [
    ['network', 'AI request failed: network.'],
    ['timeout', 'AI request failed: timed out.'],
    ['aborted', 'AI request was cancelled.'],
    ['rate-limit', 'AI request failed: rate limit.'],
    ['server-error', 'AI request failed: server error.'],
  ];
  for (const [reason, expected] of cases) {
    const { dom, sidebar, controller } = setup();
    controller.messenger = fakeMessenger(function (cmd) {
      if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
      if (cmd === 'generateAnswers') return { ok: false, reason };
      return { ok: true };
    });
    controller.wire();
    controller.performScan();
    await new Promise(function (r) { setTimeout(r, 0); });
    controller.performGenerate();
    await new Promise(function (r) { setTimeout(r, 0); });
    assert.equal(sidebar.state.applyResult.message, expected, 'reason=' + reason);
  }
});

test('C4: validator-invalid (ok:false from validator) renders the invalid-format message', async () => {
  const { dom, sidebar, controller } = setup();
  controller.messenger = fakeMessenger(function (cmd) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') return { ok: true, raw: 'this is not parseable as the validator expects' };
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  const origWarn = console.warn;
  console.warn = function () {};
  try {
    controller.performGenerate();
    await new Promise(function (r) { setTimeout(r, 0); });
  } finally { console.warn = origWarn; }
  assert.ok(sidebar.state.applyResult && sidebar.state.applyResult.message);
  assert.ok(/unrecognized format/i.test(sidebar.state.applyResult.message),
    'expected diagnostic message; got: ' + JSON.stringify(sidebar.state.applyResult.message));
});

test('C5: stale-structure refusal sets message, not bare counts', async () => {
  const html = '<section><h3>Question 1</h3><p>P</p><label><input type="radio" name="r1">A</label><label><input type="radio" name="r1">B</label></section>';
  const { dom, sidebar, controller } = setup(html);
  controller.messenger = fakeMessenger(function (cmd, params) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') {
      const q = params.snapshot.questions[0];
      return { ok: true, raw: { answers: [{ question_id: q.id, answer: { type: 'single_choice', option_ids: [q.options[0].id] } }] } };
    }
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  // Add a new option (structural change)
  const lbl = dom.window.document.createElement('label');
  lbl.innerHTML = '<input type="radio" name="r1">Gamma';
  dom.window.document.querySelector('section').appendChild(lbl);
  controller.performApply();
  assert.ok(sidebar.state.applyResult.message, 'message must be set');
  assert.ok(/page changed/i.test(sidebar.state.applyResult.message));
});

test('C6: successful Apply still renders filled/skipped counts (no message)', async () => {
  const html = '<section><h3>Question 1</h3><p>P</p><input type="text" id="t1"></section>';
  const { dom, sidebar, controller } = setup(html);
  controller.messenger = fakeMessenger(function (cmd, params) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') {
      const q = params.snapshot.questions[0];
      return { ok: true, raw: { answers: [{ question_id: q.id, answer: { type: 'text', value: '42' } }] } };
    }
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performApply();
  // Successful — message absent, counts present
  assert.equal(sidebar.state.applyResult.message, undefined);
  assert.equal(sidebar.state.applyResult.filled, 1);
});

test('Apply still succeeds when nothing changed since Generate', async () => {
  const html = '<section><h3>Question 1</h3><p>P</p><input type="text" id="t1"></section>';
  const { dom, sidebar, controller } = setup(html);
  controller.messenger = fakeMessenger(function (cmd, params) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') {
      const q = params.snapshot.questions[0];
      return { ok: true, raw: { answers: [{ question_id: q.id, answer: { type: 'text', value: '0.0352' } }] } };
    }
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  // No user edits
  controller.performApply();
  // Either applyResult message is absent OR no "changed" refusal
  assert.equal(dom.window.document.getElementById('t1').value, '0.0352');
});

// ---------------------------------------------------------------------------
// S4 — controller forwards openOptionsFn + passes rich keyStatus
// ---------------------------------------------------------------------------

test('S4: controller forwards onOpenOptions to the injected openOptionsFn', () => {
  const dom = new JSDOM('<!doctype html><html><body><section><h3>Q1</h3><p>P</p><label><input type="radio" name="r1">A</label></section></body></html>', { url: 'https://www.coursera.org/learn/x/lecture/v1/intro' });
  const questionContext = require('../lib/ai-question-context.js');
  const validator = require('../lib/ai-answer-validator.js');
  const answerApplier = require('../lib/answer-applier.js');
  const sidebar2 = fakeSidebar();
  let opened = 0;
  const ctrl2 = createAiController({
    sidebar: sidebar2, questionContext: questionContext, validator: validator, answerApplier: answerApplier,
    messenger: { send: function (c, p, cb) { cb({ ok: true, keyPresent: false, remembered: false }); } },
    document: dom.window.document, location: dom.window.location,
    openOptionsFn: function () { opened++; },
  });
  ctrl2.wire();
  // Invoke the handler
  sidebar2.state.handlers.onOpenOptions();
  assert.equal(opened, 1);
});

test('S4: refreshKeyStatus passes both keyPresent and remembered to sidebar', async () => {
  const { dom, sidebar, controller } = setup();
  controller.messenger = fakeMessenger(function (cmd) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true, remembered: true };
    return { ok: true };
  });
  controller.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  // keyStatus should be an object with both fields
  assert.equal(typeof sidebar.state.keyStatus, 'object');
  assert.equal(sidebar.state.keyStatus.keyPresent, true);
  assert.equal(sidebar.state.keyStatus.remembered, true);
});

// ---------------------------------------------------------------------------
// T1 — Remove sidebar Clear button: controller must not register onClearKey
// ---------------------------------------------------------------------------

test('T1/A2: controller wire() does NOT register onClearKey in the sidebar handler set', () => {
  const { dom, sidebar, controller } = setup();
  controller.messenger = fakeMessenger(function (cmd) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: false, remembered: false };
    return { ok: true };
  });
  controller.wire();
  // The handler bag the sidebar receives should not include an onClearKey function.
  // Either the property is absent or its value is undefined/null.
  const handlers = sidebar.state.handlers;
  assert.ok(handlers, 'sidebar received handlers');
  assert.equal(typeof handlers.onClearKey === 'function', false,
    'onClearKey must not be registered — Clear lives only at the options page');
});

// ---------------------------------------------------------------------------
// S7 — performGenerate re-checks the current live page
// ---------------------------------------------------------------------------

test('S7: performGenerate refuses with "Scan again" when structural token changed', async () => {
  const html = '<section><h3>Question 1</h3><p>Pick</p>'
    + '<label><input type="radio" name="r1">A</label><label><input type="radio" name="r1">B</label></section>';
  const { dom, sidebar, controller } = setup(html);
  let genCalls = 0;
  controller.messenger = fakeMessenger(function (cmd) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') { genCalls++; return { ok: true, raw: { answers: [] } }; }
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  // Add an option — structural change
  const lbl = dom.window.document.createElement('label');
  lbl.innerHTML = '<input type="radio" name="r1">C';
  dom.window.document.querySelector('section').appendChild(lbl);
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(genCalls, 0, 'must not call background when structure changed');
  assert.ok(sidebar.state.applyResult && /Scan again/i.test(sidebar.state.applyResult.message));
});

test('S7: performGenerate refuses when fresh page has no actionable questions', async () => {
  // Scan with one actionable question, then mark it answered, then Generate
  const html = '<section><h3>Question 1</h3><p>Pick</p>'
    + '<label><input type="radio" name="r1">A</label><label><input type="radio" name="r1">B</label></section>';
  const { dom, sidebar, controller } = setup(html);
  let genCalls = 0;
  controller.messenger = fakeMessenger(function (cmd) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') { genCalls++; return { ok: true, raw: { answers: [] } }; }
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  // User selects an option — Q1 becomes alreadyAnswered (actionable=0)
  // Note: this also changes localGuard but NOT structural token (same options, same prompt).
  dom.window.document.querySelectorAll('input[type="radio"]')[0].checked = true;
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(genCalls, 0, 'no actionable questions — must not call background');
  // Message could be the existing "No unanswered supported questions to send." OR the "Scan again" message
  // (because user changed local answer state). Either is acceptable.
  assert.ok(sidebar.state.applyResult && sidebar.state.applyResult.message);
});

test('S7: normal unchanged eligible Scan -> Generate still calls messenger once', async () => {
  const html = '<section><h3>Question 1</h3><p>Pick</p>'
    + '<label><input type="radio" name="r1">A</label><label><input type="radio" name="r1">B</label></section>';
  const { dom, sidebar, controller } = setup(html);
  let genCalls = 0;
  controller.messenger = fakeMessenger(function (cmd, params) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') { genCalls++; return { ok: true, raw: { answers: [] } }; }
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(genCalls, 1, 'unchanged page must still send exactly one generate request');
});

test('S7: SPA navigation to a different URL between Scan and Generate refuses', async () => {
  // Use jsdom URL replacement: scan at lecture URL, then mutate to gradedLti URL via history.replaceState
  const html = '<section><h3>Question 1</h3><p>Pick</p>'
    + '<label><input type="radio" name="r1">A</label><label><input type="radio" name="r1">B</label></section>';
  const { dom, sidebar, controller } = setup(html, 'https://www.coursera.org/learn/x/lecture/v1/intro');
  let genCalls = 0;
  controller.messenger = fakeMessenger(function (cmd) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') { genCalls++; return { ok: true, raw: { answers: [] } }; }
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  // Simulate SPA navigation: update location.href via history.replaceState
  try {
    dom.window.history.replaceState({}, '', 'https://www.coursera.org/learn/x/gradedLti/abc/xyz');
  } catch (e) {
    // jsdom may not allow cross-origin navigation; in that case skip the URL-based test
    return;
  }
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(genCalls, 0, 'must not call background after SPA navigation to a blocked URL');
});

test('S7: token check uses the fresh snapshot, and Apply afterward references the same fresh snapshot', async () => {
  const html = '<section><h3>Question 1</h3><p>Pick</p>'
    + '<label><input type="radio" name="r1">Alpha</label><label><input type="radio" name="r1">Beta</label></section>';
  const { dom, sidebar, controller } = setup(html);
  controller.messenger = fakeMessenger(function (cmd, params) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
    if (cmd === 'generateAnswers') {
      const q = params.snapshot.questions[0];
      return { ok: true, raw: { answers: [{ question_id: q.id, answer: { type: 'single_choice', option_ids: [q.options[1].id] } }] } };
    }
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  // Apply on the same page (no further changes) should succeed
  controller.performApply();
  const radios = dom.window.document.querySelectorAll('input[type="radio"]');
  assert.equal(radios[1].checked, true, 'Apply uses the fresh snapshot consistently — Beta selected');
});

// ---------------------------------------------------------------------------
// U9 — provider-neutral error messages
// ---------------------------------------------------------------------------

test('U9: aiServiceErrorMessage / sidebar.setAiApplyResult never emits "DeepSeek" in user-facing text', async () => {
  const reasons = ['missing-key', 'unauthorized', 'rate-limit', 'server-error', 'network', 'timeout', 'aborted', 'invalid-response', 'unknown-reason-x'];
  for (var i = 0; i < reasons.length; i++) {
    const reason = reasons[i];
    const { dom, sidebar, controller } = setup();
    controller.messenger = fakeMessenger(function (cmd) {
      if (cmd === 'keyStatus') return { ok: true, keyPresent: true };
      if (cmd === 'generateAnswers') return { ok: false, reason: reason };
      return { ok: true };
    });
    controller.wire();
    controller.performScan();
    await new Promise(function (r) { setTimeout(r, 0); });
    controller.performGenerate();
    await new Promise(function (r) { setTimeout(r, 0); });
    const msg = (sidebar.state.applyResult && sidebar.state.applyResult.message) || '';
    assert.equal(msg.indexOf('DeepSeek'), -1, 'reason "' + reason + '" leaked provider name: ' + msg);
  }
});

// === S2-5: controller mode awareness + onOpenPortal ===

test('S2-5: refreshKeyStatus forwards accessMode to sidebar.setAiAccessMode', async () => {
  const { dom, sidebar, controller } = setup();
  let lastMode = null;
  sidebar.setAiAccessMode = function (m) { lastMode = m; };
  controller.messenger = fakeMessenger(function (cmd) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true, remembered: false, accessMode: 'managed-credits' };
    return { ok: true };
  });
  controller.refreshKeyStatus();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(lastMode, 'managed-credits');
});

test('S2-5: refreshKeyStatus defaults accessMode to personal-key when response omits it', async () => {
  const { dom, sidebar, controller } = setup();
  let lastMode = null;
  sidebar.setAiAccessMode = function (m) { lastMode = m; };
  controller.messenger = fakeMessenger(function (cmd) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: false, remembered: false };
    return { ok: true };
  });
  controller.refreshKeyStatus();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(lastMode, 'personal-key');
});

test('S2-5: performGenerate in managed mode receives managed-not-implemented and shows honest message', async () => {
  const html = '<section><h3>Question 1</h3><p>Pick</p>'
    + '<label><input type="radio" name="r1">A</label><label><input type="radio" name="r1">B</label></section>';
  const { dom, sidebar, controller } = setup(html);
  controller.messenger = fakeMessenger(function (cmd) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: false, accessMode: 'managed-credits' };
    if (cmd === 'generateAnswers') return { ok: false, reason: 'managed-not-implemented' };
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.ok(sidebar.state.applyResult && sidebar.state.applyResult.message);
  assert.ok(/not yet available|not.*implemented/i.test(sidebar.state.applyResult.message),
    'message should explain managed mode is not yet available');
});

test('S2-5: openPortalFn dep is invoked when the sidebar fires onOpenPortal', () => {
  const { dom, sidebar, controller: _existing } = setup();
  let portals = 0;
  const ctx = require('../lib/ai-question-context.js');
  const validator = require('../lib/ai-answer-validator.js');
  const applier = require('../lib/answer-applier.js');
  const ctrl2 = require('../lib/ai-answer-controller.js').createAiController({
    sidebar: sidebar, questionContext: ctx, validator: validator, answerApplier: applier,
    messenger: { send: function (c, p, cb) { cb({ ok: true, keyPresent: false, accessMode: 'managed-credits' }); } },
    document: dom.window.document, location: dom.window.location,
    openOptionsFn: function () {},
    openPortalFn: function () { portals++; },
  });
  ctrl2.wire();
  // The fake sidebar in tests captures handlers via setAiAnswerHandlers. Invoke onOpenPortal directly.
  if (sidebar.state.handlers && typeof sidebar.state.handlers.onOpenPortal === 'function') {
    sidebar.state.handlers.onOpenPortal();
  } else {
    assert.fail('controller must register onOpenPortal in the sidebar handler bag');
  }
  assert.equal(portals, 1);
});

// ---------------------------------------------------------------------------
// U11-1 — controller surfaces open-options failure via sidebar
// ---------------------------------------------------------------------------

// Local helper: wraps the existing fakeSidebar() and exposes _getHandlers()
// which returns the handler bag captured by setAiAnswerHandlers().
function makeFakeSidebar() {
  const sb = fakeSidebar();
  sb._getHandlers = function () { return sb.state.handlers; };
  return sb;
}

// === U11 Issue 1 — controller surfaces open-options failure via sidebar ===

test('U11-1: controller calls openOptionsFn with a callback function (not bare)', () => {
  let received = null;
  const fakeSidebar = makeFakeSidebar();
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
    validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
    answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
    messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
    document: { body: {}, querySelector: () => null },
    location: { href: '', pathname: '' },
    openOptionsFn: function (onResult) { received = { argType: typeof onResult }; if (typeof onResult === 'function') onResult({ ok: true }); },
  });
  ctrl.wire();
  const handlers = fakeSidebar._getHandlers();
  handlers.onOpenOptions();
  assert.ok(received, 'openOptionsFn must have been invoked');
  assert.equal(received.argType, 'function', 'openOptionsFn must be invoked WITH a result callback');
});

test('U11-1: on {ok:false} from openOptionsFn, controller calls sidebar.setAiOpenOptionsFailure with the honest message', () => {
  const fakeSidebar = makeFakeSidebar();
  let failureMsg = null;
  fakeSidebar.setAiOpenOptionsFailure = function (text) { failureMsg = text; };
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
    validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
    answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
    messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
    document: { body: {}, querySelector: () => null },
    location: { href: '', pathname: '' },
    openOptionsFn: function (cb) { cb({ ok: false, reason: 'open-options-failed' }); },
  });
  ctrl.wire();
  fakeSidebar._getHandlers().onOpenOptions();
  assert.equal(failureMsg, 'Unable to open AI API Key settings. Open the extension options page from chrome://extensions.');
});

test('U11-1: on {ok:true}, controller calls sidebar.setAiOpenOptionsFailure with empty string (clear prior failure)', () => {
  const fakeSidebar = makeFakeSidebar();
  let lastFailureMsg = null;
  fakeSidebar.setAiOpenOptionsFailure = function (text) { lastFailureMsg = text; };
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
    validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
    answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
    messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
    document: { body: {}, querySelector: () => null },
    location: { href: '', pathname: '' },
    openOptionsFn: function (cb) { cb({ ok: true }); },
  });
  ctrl.wire();
  fakeSidebar._getHandlers().onOpenOptions();
  assert.equal(lastFailureMsg, '');
});

test('U11-1: missing sidebar.setAiOpenOptionsFailure is a safe no-op (no throw)', () => {
  const fakeSidebar = makeFakeSidebar();
  // intentionally omit setAiOpenOptionsFailure
  delete fakeSidebar.setAiOpenOptionsFailure;
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
    validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
    answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
    messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
    document: { body: {}, querySelector: () => null },
    location: { href: '', pathname: '' },
    openOptionsFn: function (cb) { cb({ ok: false, reason: 'open-options-failed' }); },
  });
  ctrl.wire();
  assert.doesNotThrow(function () { fakeSidebar._getHandlers().onOpenOptions(); });
});

// === U11 — failure-state reset behaviour ===

test('U11-1: repeated failures do NOT append duplicate markup (idempotent write)', () => {
  const fakeSidebar = makeFakeSidebar();
  const calls = [];
  fakeSidebar.setAiOpenOptionsFailure = function (text) { calls.push(text); };
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
    validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
    answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
    messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
    document: { body: {}, querySelector: () => null },
    location: { href: '', pathname: '' },
    openOptionsFn: function (cb) { cb({ ok: false, reason: 'open-options-failed' }); },
  });
  ctrl.wire();
  fakeSidebar._getHandlers().onOpenOptions();
  fakeSidebar._getHandlers().onOpenOptions();
  assert.equal(calls.length, 2);
  const approved = 'Unable to open AI API Key settings. Open the extension options page from chrome://extensions.';
  assert.equal(calls[0], approved);
  assert.equal(calls[1], approved);
});

test('U11-1: failure -> success sequence — second click clears prior failure (single sweep)', () => {
  const fakeSidebar = makeFakeSidebar();
  const calls = [];
  fakeSidebar.setAiOpenOptionsFailure = function (text) { calls.push(text); };
  let nextResponse = { ok: false, reason: 'open-options-failed' };
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
    validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
    answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
    messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
    document: { body: {}, querySelector: () => null },
    location: { href: '', pathname: '' },
    openOptionsFn: function (cb) { cb(nextResponse); },
  });
  ctrl.wire();
  fakeSidebar._getHandlers().onOpenOptions();
  nextResponse = { ok: true };
  fakeSidebar._getHandlers().onOpenOptions();
  assert.equal(calls.length, 2);
  assert.equal(calls[0], 'Unable to open AI API Key settings. Open the extension options page from chrome://extensions.');
  assert.equal(calls[1], '', 'success after failure must clear the prior failure feedback');
});

test('U11-1: failure -> success -> failure preserves correct sweep order', () => {
  const fakeSidebar = makeFakeSidebar();
  const calls = [];
  fakeSidebar.setAiOpenOptionsFailure = function (text) { calls.push(text); };
  const responses = [
    { ok: false, reason: 'open-options-failed' },
    { ok: true },
    { ok: false, reason: 'open-options-failed' },
  ];
  let idx = 0;
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
    validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
    answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
    messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
    document: { body: {}, querySelector: () => null },
    location: { href: '', pathname: '' },
    openOptionsFn: function (cb) { cb(responses[idx++]); },
  });
  ctrl.wire();
  fakeSidebar._getHandlers().onOpenOptions();
  fakeSidebar._getHandlers().onOpenOptions();
  fakeSidebar._getHandlers().onOpenOptions();
  const approved = 'Unable to open AI API Key settings. Open the extension options page from chrome://extensions.';
  assert.deepEqual(calls, [approved, '', approved]);
});

test('U11-1: raw runtime exception content is NEVER displayed to the user (only the approved message)', () => {
  const fakeSidebar = makeFakeSidebar();
  let lastMsg = null;
  fakeSidebar.setAiOpenOptionsFailure = function (text) { lastMsg = text; };
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
    validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
    answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
    messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
    document: { body: {}, querySelector: () => null },
    location: { href: '', pathname: '' },
    openOptionsFn: function () { throw new Error('SECRET-CONTEXT-LEAK-token=sk-pretend-keymaterial'); },
  });
  ctrl.wire();
  assert.doesNotThrow(function () { fakeSidebar._getHandlers().onOpenOptions(); });
  const approved = 'Unable to open AI API Key settings. Open the extension options page from chrome://extensions.';
  assert.equal(lastMsg, approved, 'must surface only the approved generic message');
  assert.equal((lastMsg || '').indexOf('SECRET-CONTEXT-LEAK'), -1, 'raw exception content must never leak');
  assert.equal((lastMsg || '').indexOf('sk-pretend'), -1, 'no key-like substring must leak');
});

test('U11-1: unusual response shapes (null, undefined, missing ok) all surface the approved generic message — no raw content', () => {
  const variants = [null, undefined, {}, { ok: 'truthy-string-not-true' }, { error: 'leaky-internal-detail' }];
  for (const variant of variants) {
    const fakeSidebar = makeFakeSidebar();
    let lastMsg = null;
    fakeSidebar.setAiOpenOptionsFailure = function (text) { lastMsg = text; };
    const ctrl = createAiController({
      sidebar: fakeSidebar,
      questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
      validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
      answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
      messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
      document: { body: {}, querySelector: () => null },
      location: { href: '', pathname: '' },
      openOptionsFn: function (cb) { cb(variant); },
    });
    ctrl.wire();
    fakeSidebar._getHandlers().onOpenOptions();
    assert.equal(lastMsg, 'Unable to open AI API Key settings. Open the extension options page from chrome://extensions.',
      'variant must surface the approved message: ' + JSON.stringify(variant));
    if (variant && variant.error) {
      assert.equal(lastMsg.indexOf('leaky-internal-detail'), -1, 'must not surface variant.error content');
    }
  }
});

// === U11 — blocked-page integration: settings open works; Generate/Apply stay refused ===

function makeBlockedPageFakeSidebar() {
  let handlers = {};
  let lastEligibility = null;
  let lastApplyResult = null;
  let lastInFlight = null;
  let lastSuggestions = undefined;
  let lastOpenOptionsFailure = undefined;
  let lastKeyStatus = null;
  let lastAccessMode = null;
  return {
    setAiAnswerHandlers: function (h) { handlers = h || {}; },
    setAiPageEligibility:  function (e) { lastEligibility = e; },
    setAiApplyResult:       function (r) { lastApplyResult = r; },
    setAiInFlight:          function (v) { lastInFlight = v; },
    setAiSuggestions:       function (s) { lastSuggestions = s; },
    setAiScanResult:        function (_s) { /* not asserted here */ },
    setAiOpenOptionsFailure: function (t) { lastOpenOptionsFailure = t; },
    setAiKeyStatus:         function (k) { lastKeyStatus = k; },
    setAiAccessMode:        function (m) { lastAccessMode = m; },
    _getHandlers:           function () { return handlers; },
    _getLastEligibility:    function () { return lastEligibility; },
    _getLastApplyResult:    function () { return lastApplyResult; },
    _getLastSuggestions:    function () { return lastSuggestions; },
    _getLastOpenOptionsFailure: function () { return lastOpenOptionsFailure; },
  };
}

test('U11-1 INTEGRATION: blocked page — clicking Manage AI API Key TWICE produces TWO sanitized openOptions requests with no other side effects', () => {
  const blockedLoc = {
    href: 'https://www.coursera.org/learn/x/assignment-submission/abc/quiz',
    pathname: '/learn/x/assignment-submission/abc/quiz',
  };
  const qc = {
    buildQuestionSnapshot: function () { return { page: { eligible: false, blockedReason: 'assignment-submission' }, questions: [], supportedCount: 0, actionableCount: 0, token: 't' }; },
    sanitizeForRequest: function (s) { return s; },
    isCurrentPageBlocked: function () { return { blocked: true, reason: 'assignment-submission' }; },
    compareLocalGuards: function () { return { changed: false }; },
  };
  const sentCommands = [];
  const messenger = { send: function (cmd, p, cb) { sentCommands.push({ cmd: cmd, params: p }); if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: false, accessMode: 'personal-key' }); cb({ ok: true }); } };
  let openCount = 0;
  const fakeSidebar = makeBlockedPageFakeSidebar();
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: qc,
    validator: { validateAndMap: function () { return { ok: true, suggestions: [] }; } },
    answerApplier: { applyStructuredAnswers: function () { throw new Error('must not apply'); } },
    messenger: messenger,
    document: { body: {}, querySelector: function () { return null; } },
    location: blockedLoc,
    openOptionsFn: function (cb) { openCount++; if (cb) cb({ ok: true }); },
  });
  ctrl.wire();
  fakeSidebar._getHandlers().onOpenOptions();
  fakeSidebar._getHandlers().onOpenOptions();
  assert.equal(openCount, 2, 'two clicks → two openOptions invocations');
  const generateCalls = sentCommands.filter(function (c) { return c.cmd === 'generateAnswers'; });
  assert.equal(generateCalls.length, 0, 'no generateAnswers from settings-only clicks');
});

// === U11 — pure-helper sanity (kept for fast-path regression) ===

test('U11-1: open-options message helper sends EXACTLY {type:"ccp.ai.openOptions"} with no extra fields', async () => {
  const rt = (function () {
    const sent = [];
    return {
      sent: sent,
      sendMessage: function (msg, cb) { sent.push(msg); if (cb) cb({ ok: true }); },
    };
  })();
  const fn = createOpenOptionsCallback({ runtime: rt });
  const got = await new Promise(function (r) { fn(r); });
  assert.deepEqual(got, { ok: true });
  assert.equal(rt.sent.length, 1);
  assert.deepEqual(rt.sent[0], { type: 'ccp.ai.openOptions' });
  assert.deepEqual(Object.keys(rt.sent[0]), ['type'], 'message must have exactly one field: "type"');
});

test('U11-1: open-options request payload contains no generation/application/submission intent', () => {
  const rt = (function () {
    const sent = [];
    return { sent: sent, sendMessage: function (msg, cb) { sent.push(msg); if (cb) cb({ ok: true }); } };
  })();
  const fn = createOpenOptionsCallback({ runtime: rt });
  fn(function () {});
  const payload = JSON.stringify(rt.sent[0]).toLowerCase();
  ['generate', 'apply', 'submit', 'snapshot', 'continue', 'check', 'autoadvance'].forEach(function (f) {
    assert.equal(payload.indexOf(f), -1, 'open-options must not carry: ' + f);
  });
});

// === U14 — performScan is independent of Manage AI API Key ===

test('U14-B6: performScan does not affect Manage AI API Key click counting (independent of page eligibility)', () => {
  const loc = {
    href: 'https://www.coursera.org/learn/course/lecture/v1/intro',
    pathname: '/learn/course/lecture/v1/intro',
    origin: 'https://www.coursera.org',
  };
  const doc = { body: {}, querySelector: function () { return null; } };
  let openOptionsCalls = 0;
  const benignSnap = {
    token: 'snap_benign', page: { eligible: true, blockedReason: null },
    questions: [], supportedCount: 0, unsupportedCount: 0, actionableCount: 0, localGuard: [],
  };
  const qc = {
    buildQuestionSnapshot: function () { return benignSnap; },
    sanitizeForRequest: function (s) { return s; },
    isCurrentPageBlocked: function () { return { blocked: false, reason: null }; },
    compareLocalGuards: function () { return { changed: false }; },
  };
  const fakeSidebar = makeBlockedPageFakeSidebar();
  const ctrl = createAiController({
    sidebar: fakeSidebar, questionContext: qc,
    validator: { validateAndMap: function () { return { ok: true, suggestions: [] }; } },
    answerApplier: { applyStructuredAnswers: function () { return { summary: { filled: 0, failed: 0 } }; } },
    messenger: { send: function (cmd, p, cb) { if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: true, accessMode: 'personal-key' }); cb({ ok: true }); } },
    document: doc, location: loc,
    openOptionsFn: function (cb) { openOptionsCalls++; if (cb) cb({ ok: true }); },
  });
  ctrl.wire();
  ctrl.performScan();
  fakeSidebar._getHandlers().onOpenOptions();
  assert.equal(openOptionsCalls, 1, 'Manage AI API Key must issue exactly one sanitized open-options invocation per click');
  assert.equal(fakeSidebar._getLastOpenOptionsFailure(), '', 'success path clears prior failure feedback');
});

// === U17: dev-friendly diagnostics in performGenerate ===

test('U17-C1: validator val.ok=false → console.warn with reason + apply-result message includes the reason', async () => {
  const benignLoc = {
    href: 'https://www.coursera.org/learn/x/lecture/v1/intro',
    pathname: '/learn/x/lecture/v1/intro',
    origin: 'https://www.coursera.org',
  };
  const doc = { body: {}, querySelector: function () { return null; } };
  const snap = {
    token: 't1', page: { eligible: true, blockedReason: null },
    questions: [{ id: 'q1', order: 1, questionNumber: 1, type: 'single_choice', supported: true, alreadyAnswered: false, options: [{ id: 'q1o0', label: 'A' }] }],
    supportedCount: 1, unsupportedCount: 0, actionableCount: 1, localGuard: [],
  };
  const qc = {
    buildQuestionSnapshot: function () { return snap; },
    sanitizeForRequest: function (s) { return s; },
    isCurrentPageBlocked: function () { return { blocked: false, reason: null }; },
    compareLocalGuards: function () { return { changed: false }; },
  };
  const validator = {
    validateAndMap: function () { return { ok: false, reason: 'invalid-schema', suggestions: [], rejectedCount: 0 }; },
  };
  const fakeSidebar = makeBlockedPageFakeSidebar();
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: qc,
    validator: validator,
    answerApplier: { applyStructuredAnswers: function () { throw new Error('must not apply'); } },
    messenger: { send: function (cmd, p, cb) { if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: true, accessMode: 'personal-key' }); cb({ ok: true, raw: { not: 'an answers array' } }); } },
    document: doc, location: benignLoc,
    openOptionsFn: function (cb) { if (cb) cb({ ok: true }); },
  });
  ctrl.wire();
  ctrl.performScan();

  const origWarn = console.warn;
  const warns = [];
  console.warn = function () { warns.push(Array.prototype.slice.call(arguments)); };
  try {
    ctrl.performGenerate();
    await new Promise(function (r) { setTimeout(r, 0); });
  } finally { console.warn = origWarn; }

  const applyResult = fakeSidebar._getLastApplyResult();
  assert.ok(applyResult && typeof applyResult.message === 'string', 'apply-result must have a message');
  assert.ok(/invalid-schema/i.test(applyResult.message),
    'apply-result message must include the validator reason; got: ' + JSON.stringify(applyResult.message));

  const warnedReason = warns.some(function (a) { return a.join(' ').indexOf('invalid-schema') !== -1; });
  assert.ok(warnedReason, 'console.warn must mention "invalid-schema"; got: ' + JSON.stringify(warns));
});

test('U17-C2: validator returns suggestions all non-applicable → console.warn + apply-result message says "none applicable"', async () => {
  const benignLoc = {
    href: 'https://www.coursera.org/learn/x/lecture/v1/intro',
    pathname: '/learn/x/lecture/v1/intro',
    origin: 'https://www.coursera.org',
  };
  const doc = { body: {}, querySelector: function () { return null; } };
  const snap = {
    token: 't1', page: { eligible: true, blockedReason: null },
    questions: [{ id: 'q1', order: 1, questionNumber: 1, type: 'single_choice', supported: true, alreadyAnswered: false, options: [{ id: 'q1o0', label: 'A' }] }],
    supportedCount: 1, unsupportedCount: 0, actionableCount: 1, localGuard: [],
  };
  const qc = {
    buildQuestionSnapshot: function () { return snap; },
    sanitizeForRequest: function (s) { return s; },
    isCurrentPageBlocked: function () { return { blocked: false, reason: null }; },
    compareLocalGuards: function () { return { changed: false }; },
  };
  const validator = {
    validateAndMap: function () {
      return { ok: true, suggestions: [
        { questionNumber: 1, type: 'single_choice', mappingStatus: 'wrong-type', applicable: false },
        { questionNumber: 2, type: 'single_choice', mappingStatus: 'unknown-option', applicable: false },
      ], rejectedCount: 2 };
    },
  };
  const fakeSidebar = makeBlockedPageFakeSidebar();
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: qc,
    validator: validator,
    answerApplier: { applyStructuredAnswers: function () { throw new Error('must not apply'); } },
    messenger: { send: function (cmd, p, cb) { if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: true, accessMode: 'personal-key' }); cb({ ok: true, raw: { answers: [] } }); } },
    document: doc, location: benignLoc,
    openOptionsFn: function (cb) { if (cb) cb({ ok: true }); },
  });
  ctrl.wire();
  ctrl.performScan();

  const origWarn = console.warn;
  const warns = [];
  console.warn = function () { warns.push(Array.prototype.slice.call(arguments)); };
  try {
    ctrl.performGenerate();
    await new Promise(function (r) { setTimeout(r, 0); });
  } finally { console.warn = origWarn; }

  const applyResult = fakeSidebar._getLastApplyResult();
  assert.ok(applyResult && typeof applyResult.message === 'string', 'apply-result must have a message');
  assert.ok(/none.*applicable|0.*applicable/i.test(applyResult.message),
    'apply-result message must indicate no applicable suggestions; got: ' + JSON.stringify(applyResult.message));

  const warnedStatuses = warns.some(function (a) {
    var s = JSON.stringify(a);
    return s.indexOf('wrong-type') !== -1 && s.indexOf('unknown-option') !== -1;
  });
  assert.ok(warnedStatuses, 'console.warn must include per-suggestion mappingStatus values; got: ' + JSON.stringify(warns));
});

test('U17-C3: validator returns at least one applicable suggestion → existing happy path, no warning', async () => {
  const benignLoc = {
    href: 'https://www.coursera.org/learn/x/lecture/v1/intro',
    pathname: '/learn/x/lecture/v1/intro',
    origin: 'https://www.coursera.org',
  };
  const doc = { body: {}, querySelector: function () { return null; } };
  const snap = {
    token: 't1', page: { eligible: true, blockedReason: null },
    questions: [{ id: 'q1', order: 1, questionNumber: 1, type: 'single_choice', supported: true, alreadyAnswered: false, options: [{ id: 'q1o0', label: 'A' }] }],
    supportedCount: 1, unsupportedCount: 0, actionableCount: 1, localGuard: [],
  };
  const qc = {
    buildQuestionSnapshot: function () { return snap; },
    sanitizeForRequest: function (s) { return s; },
    isCurrentPageBlocked: function () { return { blocked: false, reason: null }; },
    compareLocalGuards: function () { return { changed: false }; },
  };
  const validator = {
    validateAndMap: function () {
      return { ok: true, suggestions: [
        { questionNumber: 1, type: 'single_choice', mappingStatus: 'matched', applicable: true, choiceText: 'A' },
      ], rejectedCount: 0 };
    },
  };
  const fakeSidebar = makeBlockedPageFakeSidebar();
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: qc,
    validator: validator,
    answerApplier: { applyStructuredAnswers: function () { throw new Error('must not apply'); } },
    messenger: { send: function (cmd, p, cb) { if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: true, accessMode: 'personal-key' }); cb({ ok: true, raw: { answers: [] } }); } },
    document: doc, location: benignLoc,
    openOptionsFn: function (cb) { if (cb) cb({ ok: true }); },
  });
  ctrl.wire();
  ctrl.performScan();

  const origWarn = console.warn;
  const warns = [];
  console.warn = function () { warns.push(Array.prototype.slice.call(arguments)); };
  try {
    ctrl.performGenerate();
    await new Promise(function (r) { setTimeout(r, 0); });
  } finally { console.warn = origWarn; }

  assert.equal(warns.length, 0, 'no console.warn on happy path; got: ' + JSON.stringify(warns));
});
