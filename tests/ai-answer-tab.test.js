'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const SIDEBAR_PATH = require.resolve('../lib/sidebar.js');

function freshDom(urlOverride) {
  delete require.cache[SIDEBAR_PATH];
  // Mount with one radio question and one text question for end-to-end check
  const html = '<section><h3>Question 1</h3><p>Pick</p>'
    + '<label><input type="radio" name="r1">Alpha</label>'
    + '<label><input type="radio" name="r1">Beta</label>'
    + '</section>'
    + '<section><h3>Question 2</h3><p>Enter value</p><input type="text" id="t2"></section>';
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', {
    url: urlOverride || 'https://www.coursera.org/learn/course/lecture/v1/intro',
  });
  global.window = dom.window;
  global.document = dom.window.document;
  // Node v24 makes global.navigator a getter-only property in strict mode;
  // use Object.defineProperty to override it.
  try {
    Object.defineProperty(global, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
  } catch (_) {
    // If already writable, plain assignment works
    global.navigator = dom.window.navigator; // eslint-disable-line no-global-assign
  }
  // load modules in browser-global pattern
  require('../lib/question-detector.js');
  require('../lib/numbered-parser.js');
  require('../lib/math-normalize.js');
  require('../lib/module-scraper.js');
  require('../lib/answer-applier.js');
  require('../lib/ai-question-context.js');
  require('../lib/ai-answer-validator.js');
  require('../lib/sidebar.js');
  dom.window.ClipboardCleaner = dom.window.ClipboardCleaner || {};
  // attach CJS exports to window namespace mirror
  dom.window.ClipboardCleaner.questionDetector = require('../lib/question-detector.js');
  dom.window.ClipboardCleaner.moduleScraper = require('../lib/module-scraper.js');
  dom.window.ClipboardCleaner.answerApplier = require('../lib/answer-applier.js');
  dom.window.ClipboardCleaner.aiQuestionContext = require('../lib/ai-question-context.js');
  dom.window.ClipboardCleaner.aiAnswerValidator = require('../lib/ai-answer-validator.js');
  dom.window.ClipboardCleaner.sidebar = require('../lib/sidebar.js');
  dom.window.ClipboardCleaner.sidebar.mount();
  return dom;
}

test('end-to-end: scan, generate (stubbed background), apply -> fills radio and text', async () => {
  const dom = freshDom();
  const a = dom.window.ClipboardCleaner;

  // Stub chrome.runtime.sendMessage to simulate background AI handler
  const sentCommands = [];
  const fakeKeyStore = { key: null };
  dom.window.chrome = {
    runtime: {
      sendMessage: function (msg, cb) {
        sentCommands.push({ command: msg.command, params: msg.params });
        if (msg.command === 'keyStatus') return cb({ ok: true, keyPresent: !!fakeKeyStore.key });
        if (msg.command === 'setSessionKey') { fakeKeyStore.key = msg.params.key; return cb({ ok: true, keyPresent: true }); }
        if (msg.command === 'clearKey') { fakeKeyStore.key = null; return cb({ ok: true, keyPresent: false }); }
        if (msg.command === 'cancelRequest') return cb({ ok: true });
        if (msg.command === 'generateAnswers') {
          // Simulate model returning valid answers keyed to the snapshot
          const snap = msg.params.snapshot;
          const answers = [];
          for (let i = 0; i < snap.questions.length; i++) {
            const q = snap.questions[i];
            if (q.type === 'single_choice' && q.options && q.options.length > 0) {
              answers.push({ question_id: q.id, answer: { type: 'single_choice', option_ids: [q.options[1].id] }, explanation: 'pick second', confidence: 'high' });
            } else if (q.type === 'math_input') {
              answers.push({ question_id: q.id, answer: { type: 'text', value: '0.0352' }, explanation: 'compute', confidence: 'high' });
            }
          }
          return cb({ ok: true, raw: { answers: answers }, elapsedMs: 1 });
        }
        return cb({ ok: false, reason: 'unknown-command' });
      }
    }
  };
  global.chrome = dom.window.chrome;

  // Load content controller. We inline its logic here (mirrors content.js Task 8 block).
  // For test purposes, install the handlers directly with the same logic.
  const aiCtx = a.aiQuestionContext;
  const validator = a.aiAnswerValidator;
  const applier = a.answerApplier;
  let activeSnapshot = null;
  let activeSuggestions = null;
  a.sidebar.setAiAnswerHandlers({
    onOpenOptions: function () { /* no-op for test — key entry happens in options page */ },
    onScan: function () {
      activeSnapshot = aiCtx.buildQuestionSnapshot(dom.window.document.body, dom.window.location, dom.window.document);
      a.sidebar.setAiPageEligibility({ eligible: activeSnapshot.page.eligible, blockedReason: activeSnapshot.page.blockedReason, supportedCount: activeSnapshot.supportedCount, actionableCount: activeSnapshot.actionableCount });
      a.sidebar.setAiScanResult(activeSnapshot);
    },
    onGenerate: function () {
      a.sidebar.setAiInFlight(true);
      const sanitized = aiCtx.sanitizeForRequest(activeSnapshot);
      dom.window.chrome.runtime.sendMessage({ type: 'ccp.ai.request', command: 'generateAnswers', params: { snapshot: sanitized } }, function (res) {
        a.sidebar.setAiInFlight(false);
        const val = validator.validateAndMap(res.raw, activeSnapshot, { expectedToken: activeSnapshot.token });
        activeSuggestions = val.suggestions;
        a.sidebar.setAiSuggestions(val.suggestions);
      });
    },
    onCancel: function () { /* no-op for test */ },
    onApply: function () {
      const fresh = aiCtx.buildQuestionSnapshot(dom.window.document.body, dom.window.location, dom.window.document);
      if (fresh.token !== activeSnapshot.token) return;
      const structured = activeSuggestions.filter(function (s) { return s.applicable; }).map(function (s) {
        const item = { questionNumber: s.questionNumber, type: s.type };
        if (s.choiceText) item.choiceText = s.choiceText;
        if (s.choiceTexts) item.choiceTexts = s.choiceTexts;
        if (s.value) item.value = s.value;
        return item;
      });
      const r = applier.applyStructuredAnswers(structured, dom.window.document.body, { verbose: false });
      a.sidebar.setAiApplyResult({ filled: r.summary.filled, failed: r.summary.failed });
    },
    onClearSuggestions: function () { activeSuggestions = null; a.sidebar.setAiSuggestions(null); a.sidebar.setAiApplyResult(null); },
  });

  // Drive the UI like a user. Key entry now happens in the options page;
  // simulate the key being present (as if the background returned keyPresent:true on init).
  a.sidebar.setAiKeyStatus({ keyPresent: true, remembered: false });
  const host = dom.window.document.getElementById('ccp-host-root');
  const shadow = host.shadowRoot || host;
  shadow.querySelector('[data-action="ai-scan"]').click();
  shadow.querySelector('[data-action="ai-generate"]').click();
  // wait one microtask for setMessage callbacks
  await new Promise(function (r) { setTimeout(r, 0); });
  shadow.querySelector('[data-action="ai-apply"]').click();

  // Verify DOM was filled by reusing the existing answer-applier pipeline
  const radios = dom.window.document.querySelectorAll('input[type="radio"]');
  assert.equal(radios[1].checked, true, 'second radio selected by AI flow');
  assert.equal(dom.window.document.getElementById('t2').value, '0.0352');

  // Verify NO submit/check/continue action was attempted
  const submitted = sentCommands.some(function (c) { return /submit|continue|mark/i.test(c.command); });
  assert.equal(submitted, false);

  // Verify no password input is present in the AI panel (key entry moved to options page).
  const panel = shadow.querySelector('[data-panel="ai-answer"]');
  assert.equal(panel.querySelector('input[type="password"]'), null, 'no password input in AI panel');
});

test('end-to-end: blocked page refuses scan/generate/apply', () => {
  // Use a fresh JSDOM with the gradedLti URL passed directly to avoid
  // JSDOM's read-only location.href descriptor issues.
  const dom = freshDom('https://www.coursera.org/learn/course/gradedLti/abc/xyz');
  const a = dom.window.ClipboardCleaner;
  const initBlock = a.aiQuestionContext.isCurrentPageBlocked(dom.window.location, dom.window.document);
  assert.equal(initBlock.blocked, true);
  a.sidebar.setAiKeyStatus(true);
  a.sidebar.setAiPageEligibility({ eligible: false, blockedReason: initBlock.reason, supportedCount: 0 });
  const host = dom.window.document.getElementById('ccp-host-root');
  const shadow = host.shadowRoot || host;
  assert.equal(shadow.querySelector('[data-action="ai-generate"]').disabled, true);
  assert.equal(shadow.querySelector('[data-action="ai-apply"]').disabled, true);
  assert.ok(/disabled on graded or blocked/i.test(shadow.querySelector('[data-role="ai-status"]').textContent));
});

test('end-to-end: stale snapshot blocks apply', () => {
  const dom = freshDom();
  const a = dom.window.ClipboardCleaner;
  // Take a snapshot, then mutate DOM, then ensure token changes
  const snap1 = a.aiQuestionContext.buildQuestionSnapshot(dom.window.document.body, dom.window.location, dom.window.document);
  const newOption = dom.window.document.createElement('label');
  newOption.innerHTML = '<input type="radio" name="r1">NEW';
  dom.window.document.querySelector('section').appendChild(newOption);
  const snap2 = a.aiQuestionContext.buildQuestionSnapshot(dom.window.document.body, dom.window.location, dom.window.document);
  assert.notEqual(snap1.token, snap2.token);
});

// === U8: refreshKeyStatus updates sidebar after key-status-changed broadcast ===

const AI_ANSWER_CONTROLLER_PATH = require.resolve('../lib/ai-answer-controller.js');

function freshDomWithController(urlOverride) {
  delete require.cache[SIDEBAR_PATH];
  delete require.cache[AI_ANSWER_CONTROLLER_PATH];
  const html = '<section><h3>Question 1</h3><p>Pick</p>'
    + '<label><input type="radio" name="r1">Alpha</label>'
    + '<label><input type="radio" name="r1">Beta</label>'
    + '</section>'
    + '<section><h3>Question 2</h3><p>Enter value</p><input type="text" id="t2"></section>';
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', {
    url: urlOverride || 'https://www.coursera.org/learn/course/lecture/v1/intro',
  });
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    Object.defineProperty(global, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
  } catch (_) {
    global.navigator = dom.window.navigator; // eslint-disable-line no-global-assign
  }
  require('../lib/question-detector.js');
  require('../lib/numbered-parser.js');
  require('../lib/math-normalize.js');
  require('../lib/module-scraper.js');
  require('../lib/answer-applier.js');
  require('../lib/ai-question-context.js');
  require('../lib/ai-answer-validator.js');
  require('../lib/sidebar.js');
  require('../lib/ai-answer-controller.js');
  dom.window.ClipboardCleaner = dom.window.ClipboardCleaner || {};
  dom.window.ClipboardCleaner.questionDetector = require('../lib/question-detector.js');
  dom.window.ClipboardCleaner.moduleScraper = require('../lib/module-scraper.js');
  dom.window.ClipboardCleaner.answerApplier = require('../lib/answer-applier.js');
  dom.window.ClipboardCleaner.aiQuestionContext = require('../lib/ai-question-context.js');
  dom.window.ClipboardCleaner.aiAnswerValidator = require('../lib/ai-answer-validator.js');
  dom.window.ClipboardCleaner.sidebar = require('../lib/sidebar.js');
  dom.window.ClipboardCleaner.aiAnswerController = require('../lib/ai-answer-controller.js');
  dom.window.ClipboardCleaner.sidebar.mount();
  return dom;
}

test('U8: refreshKeyStatus updates sidebar from keyPresent:false to keyPresent:true', async () => {
  // Build a minimal end-to-end fixture using the production controller.
  const dom = freshDomWithController();
  const a = dom.window.ClipboardCleaner;

  // State variable so the fake background can change its keyStatus response over time
  let keyState = { keyPresent: false, remembered: false };

  // Stub sendMessage to route AI commands
  dom.window.chrome = dom.window.chrome || {};
  dom.window.chrome.runtime = dom.window.chrome.runtime || {};
  dom.window.chrome.runtime.sendMessage = function (msg, cb) {
    if (msg.command === 'keyStatus') return cb({ ok: true, keyPresent: keyState.keyPresent, remembered: keyState.remembered });
    return cb({ ok: true });
  };
  global.chrome = dom.window.chrome;

  // Construct the production controller (mirrors content.js shim)
  const messenger = {
    send: function (command, params, cb) {
      try { dom.window.chrome.runtime.sendMessage({ type: 'ccp.ai.request', command: command, params: params || {} }, function (res) { cb(res || { ok: false, reason: 'no-response' }); }); }
      catch (e) { cb({ ok: false, reason: 'send-failed' }); }
    },
  };
  const controller = a.aiAnswerController.createAiController({
    sidebar: a.sidebar,
    questionContext: a.aiQuestionContext,
    validator: a.aiAnswerValidator,
    answerApplier: a.answerApplier,
    messenger: messenger,
    document: dom.window.document,
    location: dom.window.location,
    openOptionsFn: function () {},
  });
  controller.wire();
  await new Promise(function (r) { setTimeout(r, 0); });

  // Initial state: not configured
  const host = dom.window.document.getElementById('ccp-host-root');
  const shadow = host.shadowRoot || host;
  const keyState_el = shadow.querySelector('[data-role="ai-key-state"]');
  assert.equal(keyState_el.textContent, 'No AI API Key configured.');

  // Simulate options-page Save → background broadcast → content listener → refresh
  keyState = { keyPresent: true, remembered: false };
  controller.refreshKeyStatus();
  await new Promise(function (r) { setTimeout(r, 0); });

  // Sidebar pill must now reflect configured-this-session
  assert.equal(keyState_el.textContent, 'AI API Key configured for this session.');
});

test('U8: after refreshKeyStatus to present, Generate enables given an eligible actionable scan', async () => {
  const dom = freshDomWithController();
  const a = dom.window.ClipboardCleaner;
  let keyState = { keyPresent: false, remembered: false };
  dom.window.chrome = dom.window.chrome || {};
  dom.window.chrome.runtime = dom.window.chrome.runtime || {};
  dom.window.chrome.runtime.sendMessage = function (msg, cb) {
    if (msg.command === 'keyStatus') return cb({ ok: true, keyPresent: keyState.keyPresent, remembered: keyState.remembered });
    return cb({ ok: true });
  };
  global.chrome = dom.window.chrome;

  const messenger = {
    send: function (command, params, cb) {
      dom.window.chrome.runtime.sendMessage({ type: 'ccp.ai.request', command: command, params: params || {} }, function (res) { cb(res || {}); });
    },
  };
  const controller = a.aiAnswerController.createAiController({
    sidebar: a.sidebar,
    questionContext: a.aiQuestionContext,
    validator: a.aiAnswerValidator,
    answerApplier: a.answerApplier,
    messenger: messenger,
    document: dom.window.document,
    location: dom.window.location,
    openOptionsFn: function () {},
  });
  controller.wire();
  await new Promise(function (r) { setTimeout(r, 0); });

  // Scan an eligible page first — the fixture's freshDomWithController() already includes a
  // <section> with a radio question, which the question detector should pick up
  // (so actionableCount > 0).
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });

  const host = dom.window.document.getElementById('ccp-host-root');
  const shadow = host.shadowRoot || host;
  const gen = shadow.querySelector('[data-action="ai-generate"]');

  // Before key configured: Generate is disabled (no key yet)
  assert.equal(gen.disabled, true);

  // Simulate Save in options → broadcast → refresh
  keyState = { keyPresent: true, remembered: false };
  controller.refreshKeyStatus();
  await new Promise(function (r) { setTimeout(r, 0); });

  // Now key is present + actionable scan exists → Generate enabled
  assert.equal(gen.disabled, false, 'Generate must enable after key refresh given an eligible actionable scan');
});

test('U8: refreshKeyStatus from present back to absent disables Generate', async () => {
  const dom = freshDomWithController();
  const a = dom.window.ClipboardCleaner;
  let keyState = { keyPresent: true, remembered: false };
  dom.window.chrome = dom.window.chrome || {};
  dom.window.chrome.runtime = dom.window.chrome.runtime || {};
  dom.window.chrome.runtime.sendMessage = function (msg, cb) {
    if (msg.command === 'keyStatus') return cb({ ok: true, keyPresent: keyState.keyPresent, remembered: keyState.remembered });
    return cb({ ok: true });
  };
  global.chrome = dom.window.chrome;

  const messenger = {
    send: function (command, params, cb) {
      dom.window.chrome.runtime.sendMessage({ type: 'ccp.ai.request', command: command, params: params || {} }, function (res) { cb(res || {}); });
    },
  };
  const controller = a.aiAnswerController.createAiController({
    sidebar: a.sidebar,
    questionContext: a.aiQuestionContext,
    validator: a.aiAnswerValidator,
    answerApplier: a.answerApplier,
    messenger: messenger,
    document: dom.window.document,
    location: dom.window.location,
    openOptionsFn: function () {},
  });
  controller.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });

  const host = dom.window.document.getElementById('ccp-host-root');
  const shadow = host.shadowRoot || host;
  const gen = shadow.querySelector('[data-action="ai-generate"]');

  // Starts enabled (key present + actionable)
  assert.equal(gen.disabled, false);

  // Simulate Clear in options
  keyState = { keyPresent: false, remembered: false };
  controller.refreshKeyStatus();
  await new Promise(function (r) { setTimeout(r, 0); });

  // Generate must now be disabled
  assert.equal(gen.disabled, true, 'Generate must disable after key cleared');
});

// === U9: provider-neutral text in integration fixture ===

test('U9: end-to-end sidebar text contains no "DeepSeek" after wire+refresh in the integration fixture', async () => {
  const dom = freshDomWithController();
  const a = dom.window.ClipboardCleaner;
  let keyState = { keyPresent: true, remembered: true };
  dom.window.chrome = dom.window.chrome || {};
  dom.window.chrome.runtime = dom.window.chrome.runtime || {};
  dom.window.chrome.runtime.sendMessage = function (msg, cb) {
    if (msg.command === 'keyStatus') return cb({ ok: true, keyPresent: keyState.keyPresent, remembered: keyState.remembered });
    return cb({ ok: true });
  };
  global.chrome = dom.window.chrome;
  const messenger = {
    send: function (command, params, cb) { dom.window.chrome.runtime.sendMessage({ type: 'ccp.ai.request', command: command, params: params || {} }, function (res) { cb(res || {}); }); }
  };
  const controller = a.aiAnswerController.createAiController({
    sidebar: a.sidebar, questionContext: a.aiQuestionContext, validator: a.aiAnswerValidator, answerApplier: a.answerApplier,
    messenger: messenger, document: dom.window.document, location: dom.window.location, openOptionsFn: function () {},
  });
  controller.wire();
  await new Promise(function (r) { setTimeout(r, 0); });

  const host = dom.window.document.getElementById('ccp-host-root');
  const shadow = host.shadowRoot || host;
  const panel = shadow.querySelector('[data-panel="ai-answer"]');
  assert.equal(panel.textContent.indexOf('DeepSeek'), -1, 'integration: no DeepSeek visible in sidebar');
});

// === U12 LIVE — full-stack regression against the actual screenshot URL ===
// Reproduces the live defect: on /assignment-submission/.../attempt the sidebar
// allowed Scan to click and rendered five assessment prompts into the local
// preview. After U12 this must no longer reproduce, via any code path.

test('U12-LIVE: rendered sidebar on /assignment-submission/.../attempt with five detectable questions refuses scan and preserves U11 behaviors', async () => {
  // 1) Build a fresh DOM that matches the live URL + five detectable supported
  //    questions including the recognizable marker prompt from the screenshot.
  const SIDEBAR_PATH_LOCAL = require.resolve('../lib/sidebar.js');
  const CONTROLLER_PATH_LOCAL = require.resolve('../lib/ai-answer-controller.js');
  delete require.cache[SIDEBAR_PATH_LOCAL];
  delete require.cache[CONTROLLER_PATH_LOCAL];

  const MARKER_Q1 = 'What does BW stand for in communication field?';
  const MARKER_Q2 = 'Which is the wrong one about cellular communication?';
  const MARKER_Q3 = 'Which are the keywords for 1G generation?';
  const MARKER_Q4 = 'Spectrum efficiency means what exactly?';
  const MARKER_Q5 = 'How many channels are typically reused per cluster?';

  function radioBlock(qNum, prompt, choices) {
    var s = '<h3>Question ' + qNum + '</h3><p>' + prompt + '</p>';
    for (var i = 0; i < choices.length; i++) {
      s += '<label><input type="radio" name="r' + qNum + '">' + choices[i] + '</label>';
    }
    return '<section>' + s + '</section>';
  }

  const html = ''
    + radioBlock(1, MARKER_Q1,                       ['Bandwidth', 'Beamwidth', 'Bitwidth'])
    + radioBlock(2, MARKER_Q2,                       ['Uses cells', 'Reuses frequency', 'Requires copper wires'])
    + '<section><h3>Question 3</h3><p>' + MARKER_Q3 + '</p>'
        + '<label><input type="checkbox" name="m3">Analog</label>'
        + '<label><input type="checkbox" name="m3">Voice-only</label>'
        + '<label><input type="checkbox" name="m3">AMPS</label>'
    + '</section>'
    + radioBlock(4, MARKER_Q4,                       ['Bits per Hz', 'Bytes per second', 'Tokens per minute'])
    + radioBlock(5, MARKER_Q5,                       ['1', '3', '7']);

  const { JSDOM } = require('jsdom');
  const url = 'https://www.coursera.org/learn/wireless-communications/assignment-submission/fryRH/practice-quiz-for-introduction-and-history-of-cellular-communication-systems/attempt';
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', { url: url });
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    Object.defineProperty(global, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
  } catch (_) { global.navigator = dom.window.navigator; }

  // Load production modules (mirror the freshDomWithController loader).
  require('../lib/question-detector.js');
  require('../lib/numbered-parser.js');
  require('../lib/math-normalize.js');
  require('../lib/module-scraper.js');
  require('../lib/answer-applier.js');
  require('../lib/ai-question-context.js');
  require('../lib/ai-answer-validator.js');
  require('../lib/sidebar.js');
  require('../lib/ai-answer-controller.js');
  dom.window.ClipboardCleaner = dom.window.ClipboardCleaner || {};
  dom.window.ClipboardCleaner.questionDetector = require('../lib/question-detector.js');
  dom.window.ClipboardCleaner.moduleScraper    = require('../lib/module-scraper.js');
  dom.window.ClipboardCleaner.answerApplier    = require('../lib/answer-applier.js');
  dom.window.ClipboardCleaner.aiQuestionContext = require('../lib/ai-question-context.js');
  dom.window.ClipboardCleaner.aiAnswerValidator = require('../lib/ai-answer-validator.js');
  dom.window.ClipboardCleaner.sidebar           = require('../lib/sidebar.js');
  dom.window.ClipboardCleaner.aiAnswerController = require('../lib/ai-answer-controller.js');
  dom.window.ClipboardCleaner.sidebar.mount();

  const a = dom.window.ClipboardCleaner;

  // 2) Wire chrome runtime to capture every message and route an open-options
  //    sanitized request, so we can assert (a) NO generateAnswers/apply/submit
  //    occurs, and (b) Manage AI API Key continues to emit exactly the U11
  //    {type:'ccp.ai.openOptions'} sanitized message.
  const sentMessages = [];
  let openOptionsCount = 0;
  dom.window.chrome = {
    runtime: {
      sendMessage: function (msg, cb) {
        sentMessages.push(msg);
        if (msg && msg.type === 'ccp.ai.openOptions') {
          openOptionsCount++;
          if (cb) cb({ ok: true });
          return;
        }
        if (msg && msg.command === 'keyStatus') {
          if (cb) cb({ ok: true, keyPresent: true, remembered: true, accessMode: 'personal-key' });
          return;
        }
        if (cb) cb({ ok: true });
      }
    }
  };
  global.chrome = dom.window.chrome;

  // 3) Construct the production controller via createAiController, wiring the
  //    U11 createOpenOptionsCallback for Manage AI API Key so its full
  //    sanitized navigation contract is exercised end-to-end.
  const openOptionsFn = (function () {
    const helper = require('../lib/ai-open-options-content.js');
    return helper.createOpenOptionsCallback({ runtime: dom.window.chrome.runtime });
  })();
  const messenger = {
    send: function (command, params, cb) {
      try {
        dom.window.chrome.runtime.sendMessage({ type: 'ccp.ai.request', command: command, params: params || {} }, function (res) { cb(res || { ok: false, reason: 'no-response' }); });
      } catch (_) { cb({ ok: false, reason: 'send-failed' }); }
    },
  };
  const controller = a.aiAnswerController.createAiController({
    sidebar: a.sidebar,
    questionContext: a.aiQuestionContext,
    validator: a.aiAnswerValidator,
    answerApplier: a.answerApplier,
    messenger: messenger,
    document: dom.window.document,
    location: dom.window.location,
    openOptionsFn: openOptionsFn,
  });
  controller.wire();
  await new Promise(function (r) { setTimeout(r, 0); });

  // 4) Acquire sidebar DOM.
  const host = dom.window.document.getElementById('ccp-host-root');
  const shadow = host.shadowRoot || host;
  const scan       = shadow.querySelector('[data-action="ai-scan"]');
  const gen        = shadow.querySelector('[data-action="ai-generate"]');
  const apply      = shadow.querySelector('[data-action="ai-apply"]');
  const configure  = shadow.querySelector('[data-action="ai-key-configure"]');
  const statusEl   = shadow.querySelector('[data-role="ai-status"]');
  const scanPrev   = shadow.querySelector('[data-role="ai-scan-preview"]');

  // ASSERTION 1: page-status text reports the blocked-page message.
  assert.ok(/disabled on graded or blocked assessment pages/i.test(statusEl.textContent),
    'page-status text must declare AI is disabled on graded/blocked pages (got: ' + JSON.stringify(statusEl.textContent) + ')');

  // ASSERTION 2: Scan questions is disabled.
  assert.equal(scan.disabled, true, 'Scan questions button must be disabled');

  // ASSERTION 3: Generate suggestions is disabled.
  assert.equal(gen.disabled, true, 'Generate suggestions button must be disabled');

  // ASSERTION 4: Apply answers is disabled.
  assert.equal(apply.disabled, true, 'Apply answers button must be disabled');

  // ASSERTION 5: Manage AI API Key remains enabled AND clicking it issues
  // EXACTLY {type:'ccp.ai.openOptions'} (the U11 sanitized navigation message).
  assert.ok(configure, 'Manage AI API Key button must exist');
  assert.notEqual(configure.disabled, true, 'Manage AI API Key must remain enabled on blocked page');
  configure.click();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(openOptionsCount, 1, 'Manage AI API Key click must issue exactly one ccp.ai.openOptions message');
  const openMsgs = sentMessages.filter(function (m) { return m && m.type === 'ccp.ai.openOptions'; });
  assert.equal(openMsgs.length, 1);
  assert.deepEqual(openMsgs[0], { type: 'ccp.ai.openOptions' }, 'open-options message must be exactly {type:"ccp.ai.openOptions"} with no extra fields');

  // ASSERTION 6: native click on Scan does NOT render a scan preview.
  scan.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal((scanPrev.textContent || '').indexOf(MARKER_Q1), -1,
    'native Scan click must NOT render Q1 prompt text into the preview (got: ' + JSON.stringify(scanPrev.textContent) + ')');
  assert.equal(scanPrev.querySelectorAll('li').length, 0,
    'native Scan click must NOT render any preview list items');

  // ASSERTION 7: programmatic controller.performScan() also does NOT render a preview.
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal((scanPrev.textContent || '').indexOf(MARKER_Q1), -1,
    'programmatic performScan must NOT render Q1 prompt text');
  assert.equal((scanPrev.textContent || '').indexOf(MARKER_Q2), -1, 'no Q2 prompt');
  assert.equal((scanPrev.textContent || '').indexOf(MARKER_Q3), -1, 'no Q3 prompt');
  assert.equal((scanPrev.textContent || '').indexOf(MARKER_Q4), -1, 'no Q4 prompt');
  assert.equal((scanPrev.textContent || '').indexOf(MARKER_Q5), -1, 'no Q5 prompt');

  // ASSERTION 8: sidebar DOM as a whole does NOT contain the recognizable prompt
  // text after either attempted scan.
  const sidebarText = (function () {
    var s = '';
    var walker = dom.window.document.createTreeWalker(shadow, dom.window.NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) s += (n.nodeValue || '') + ' ';
    return s;
  })();
  [MARKER_Q1, MARKER_Q2, MARKER_Q3, MARKER_Q4, MARKER_Q5].forEach(function (m) {
    assert.equal(sidebarText.indexOf(m), -1, 'sidebar DOM must not contain prompt: ' + m);
  });

  // ASSERTION 9: NO generateAnswers / apply / submit / continue / check /
  // autoAdvance command was ever issued via the messenger.
  const forbiddenCommands = ['generateAnswers', 'apply', 'submit', 'submitAnswer', 'continue', 'check', 'autoAdvance'];
  const cmdNames = sentMessages.map(function (m) { return m && (m.command || ''); });
  forbiddenCommands.forEach(function (cmd) {
    assert.equal(cmdNames.indexOf(cmd), -1, 'forbidden command observed on blocked page: ' + cmd);
  });

  // ASSERTION 10: U11 one-visible-card behavior must not regress — only the
  // active AI access card (personal-key) is computed-style visible. The other
  // (managed-credits) must be display:none via the .ccp-ai-card[hidden] rule.
  const keyCard = shadow.querySelector('[data-card="ai-card-key"]');
  const managedCard = shadow.querySelector('[data-card="ai-card-managed"]');
  if (managedCard) {
    const fs = require('fs'); const path = require('path');
    const css = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sidebar.css'), 'utf8');
    let style = shadow.querySelector('style[data-test="ccp-u12-live"]');
    if (!style) {
      style = dom.window.document.createElement('style');
      style.setAttribute('data-test', 'ccp-u12-live');
      shadow.appendChild(style);
    }
    style.textContent = css;
    const keyDisp = dom.window.getComputedStyle(keyCard).display;
    const managedDisp = dom.window.getComputedStyle(managedCard).display;
    assert.notEqual(keyDisp, 'none', 'personal-key card must remain visible (U11 regression)');
    assert.equal(managedDisp, 'none', 'managed-credits card must remain display:none (U11 regression)');
  }
});

// === U13 DIAGNOSIS — production startup order on a blocked URL ===
// Reproduces the live initialization sequence end-to-end and asserts the Scan
// button stays disabled through every documented init callback (mount, wire,
// refreshKeyStatus settling, setAiPageEligibility, content-listener refresh).

test('U13-D1: production startup order on /assignment-submission/.../attempt keeps Scan disabled after every init callback settles', async () => {
  const SIDEBAR_PATH_LOCAL = require.resolve('../lib/sidebar.js');
  const CONTROLLER_PATH_LOCAL = require.resolve('../lib/ai-answer-controller.js');
  delete require.cache[SIDEBAR_PATH_LOCAL];
  delete require.cache[CONTROLLER_PATH_LOCAL];

  const { JSDOM } = require('jsdom');
  const url = 'https://www.coursera.org/learn/wireless-communications/assignment-submission/fryRH/practice-quiz-for-introduction-and-history-of-cellular-communication-systems/attempt';
  const html = '<section><h3>Question 1</h3><p>Pick</p>'
    + '<label><input type="radio" name="r1">Alpha</label>'
    + '<label><input type="radio" name="r1">Beta</label>'
    + '</section>';
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', { url: url });
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    Object.defineProperty(global, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
  } catch (_) { global.navigator = dom.window.navigator; }

  require('../lib/question-detector.js');
  require('../lib/numbered-parser.js');
  require('../lib/math-normalize.js');
  require('../lib/module-scraper.js');
  require('../lib/answer-applier.js');
  require('../lib/ai-question-context.js');
  require('../lib/ai-answer-validator.js');
  require('../lib/ai-answer-controller.js');
  require('../lib/ai-content-listeners.js');
  require('../lib/ai-open-options-content.js');
  require('../lib/sidebar.js');
  dom.window.ClipboardCleaner = dom.window.ClipboardCleaner || {};
  dom.window.ClipboardCleaner.questionDetector = require('../lib/question-detector.js');
  dom.window.ClipboardCleaner.moduleScraper    = require('../lib/module-scraper.js');
  dom.window.ClipboardCleaner.answerApplier    = require('../lib/answer-applier.js');
  dom.window.ClipboardCleaner.aiQuestionContext = require('../lib/ai-question-context.js');
  dom.window.ClipboardCleaner.aiAnswerValidator = require('../lib/ai-answer-validator.js');
  dom.window.ClipboardCleaner.aiAnswerController = require('../lib/ai-answer-controller.js');
  dom.window.ClipboardCleaner.aiContentListeners = require('../lib/ai-content-listeners.js');
  dom.window.ClipboardCleaner.aiOpenOptionsContent = require('../lib/ai-open-options-content.js');
  dom.window.ClipboardCleaner.sidebar            = require('../lib/sidebar.js');

  const a = dom.window.ClipboardCleaner;

  let keyResponded = false;
  dom.window.chrome = {
    runtime: {
      sendMessage: function (msg, cb) {
        if (msg && msg.command === 'keyStatus') {
          setTimeout(function () { keyResponded = true; cb({ ok: true, keyPresent: true, remembered: true, accessMode: 'personal-key' }); }, 0);
          return;
        }
        if (cb) cb({ ok: true });
      },
      onMessage: { addListener: function () {} },
      getManifest: function () { return { version: '1.0.0' }; },
    },
  };
  global.chrome = dom.window.chrome;

  a.sidebar.mount();
  const messenger = {
    send: function (command, params, cb) {
      try { dom.window.chrome.runtime.sendMessage({ type: 'ccp.ai.request', command: command, params: params || {} }, function (res) { cb(res || { ok: false, reason: 'no-response' }); }); }
      catch (_) { cb({ ok: false, reason: 'send-failed' }); }
    },
  };
  const controller = a.aiAnswerController.createAiController({
    sidebar: a.sidebar,
    questionContext: a.aiQuestionContext,
    validator: a.aiAnswerValidator,
    answerApplier: a.answerApplier,
    messenger: messenger,
    document: dom.window.document,
    location: dom.window.location,
    openOptionsFn: a.aiOpenOptionsContent.createOpenOptionsCallback({ runtime: dom.window.chrome.runtime }),
  });
  controller.wire();
  a.aiContentListeners.attachAiContentListeners({ runtime: dom.window.chrome.runtime, controller: controller });

  await new Promise(function (r) { setTimeout(r, 0); });
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(keyResponded, true, 'keyStatus async callback must have settled');

  const host = dom.window.document.getElementById('ccp-host-root');
  const shadow = host.shadowRoot || host;
  const scan = shadow.querySelector('[data-action="ai-scan"]');
  assert.ok(scan, 'Scan button must exist');
  assert.equal(scan.disabled, true,
    'After full production startup sequence on /assignment-submission/.../attempt, Scan MUST be disabled. ' +
    'Observed scan.disabled=' + scan.disabled + '. Page-status text: ' + JSON.stringify((shadow.querySelector('[data-role="ai-status"]') || {}).textContent));
});

// === U13 DIAGNOSIS — async keyStatus/accessMode broadcast cannot re-enable Scan ===

test('U13-D2: async ccp.ai.keyStatusChanged after blocked eligibility does NOT re-enable Scan', async () => {
  const SIDEBAR_PATH_LOCAL = require.resolve('../lib/sidebar.js');
  const CONTROLLER_PATH_LOCAL = require.resolve('../lib/ai-answer-controller.js');
  delete require.cache[SIDEBAR_PATH_LOCAL];
  delete require.cache[CONTROLLER_PATH_LOCAL];

  const { JSDOM } = require('jsdom');
  const url = 'https://www.coursera.org/learn/wireless-communications/assignment-submission/fryRH/practice-quiz-for-introduction-and-history-of-cellular-communication-systems/attempt';
  const dom = new JSDOM('<!doctype html><html><body><section><h3>Q1</h3><p>P</p><label><input type="radio" name="r1">A</label></section></body></html>', { url: url });
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    Object.defineProperty(global, 'navigator', { value: dom.window.navigator, writable: true, configurable: true });
  } catch (_) { global.navigator = dom.window.navigator; }

  require('../lib/question-detector.js');
  require('../lib/numbered-parser.js');
  require('../lib/math-normalize.js');
  require('../lib/module-scraper.js');
  require('../lib/answer-applier.js');
  require('../lib/ai-question-context.js');
  require('../lib/ai-answer-validator.js');
  require('../lib/ai-answer-controller.js');
  require('../lib/ai-content-listeners.js');
  require('../lib/ai-open-options-content.js');
  require('../lib/sidebar.js');
  dom.window.ClipboardCleaner = dom.window.ClipboardCleaner || {};
  dom.window.ClipboardCleaner.questionDetector = require('../lib/question-detector.js');
  dom.window.ClipboardCleaner.moduleScraper    = require('../lib/module-scraper.js');
  dom.window.ClipboardCleaner.answerApplier    = require('../lib/answer-applier.js');
  dom.window.ClipboardCleaner.aiQuestionContext = require('../lib/ai-question-context.js');
  dom.window.ClipboardCleaner.aiAnswerValidator = require('../lib/ai-answer-validator.js');
  dom.window.ClipboardCleaner.aiAnswerController = require('../lib/ai-answer-controller.js');
  dom.window.ClipboardCleaner.aiContentListeners = require('../lib/ai-content-listeners.js');
  dom.window.ClipboardCleaner.aiOpenOptionsContent = require('../lib/ai-open-options-content.js');
  dom.window.ClipboardCleaner.sidebar            = require('../lib/sidebar.js');

  const a = dom.window.ClipboardCleaner;

  const onMessageListeners = [];
  dom.window.chrome = {
    runtime: {
      sendMessage: function (msg, cb) {
        if (msg && msg.command === 'keyStatus') {
          setTimeout(function () { cb({ ok: true, keyPresent: true, remembered: true, accessMode: 'personal-key' }); }, 0);
          return;
        }
        if (cb) cb({ ok: true });
      },
      onMessage: { addListener: function (fn) { onMessageListeners.push(fn); } },
      getManifest: function () { return { version: '1.0.0' }; },
    },
  };
  global.chrome = dom.window.chrome;

  a.sidebar.mount();
  const messenger = {
    send: function (command, params, cb) {
      dom.window.chrome.runtime.sendMessage({ type: 'ccp.ai.request', command: command, params: params || {} }, function (res) { cb(res || { ok: false, reason: 'no-response' }); });
    },
  };
  const controller = a.aiAnswerController.createAiController({
    sidebar: a.sidebar,
    questionContext: a.aiQuestionContext,
    validator: a.aiAnswerValidator,
    answerApplier: a.answerApplier,
    messenger: messenger,
    document: dom.window.document,
    location: dom.window.location,
    openOptionsFn: a.aiOpenOptionsContent.createOpenOptionsCallback({ runtime: dom.window.chrome.runtime }),
  });
  controller.wire();
  a.aiContentListeners.attachAiContentListeners({ runtime: dom.window.chrome.runtime, controller: controller });

  await new Promise(function (r) { setTimeout(r, 0); });
  await new Promise(function (r) { setTimeout(r, 0); });

  const host = dom.window.document.getElementById('ccp-host-root');
  const shadow = host.shadowRoot || host;
  const scan = shadow.querySelector('[data-action="ai-scan"]');
  assert.equal(scan.disabled, true, 'precondition: Scan must be disabled after initial startup');

  onMessageListeners.forEach(function (fn) { try { fn({ type: 'ccp.ai.keyStatusChanged' }); } catch (_) {} });
  await new Promise(function (r) { setTimeout(r, 0); });
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(scan.disabled, true, 'Scan must REMAIN disabled after ccp.ai.keyStatusChanged broadcast');

  onMessageListeners.forEach(function (fn) { try { fn({ type: 'ccp.ai.accessModeChanged' }); } catch (_) {} });
  await new Promise(function (r) { setTimeout(r, 0); });
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(scan.disabled, true, 'Scan must REMAIN disabled after ccp.ai.accessModeChanged broadcast');
});
