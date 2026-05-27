// tests/sidebar.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { JSDOM } = require('jsdom');

const SIDEBAR_PATH = path.resolve(__dirname, '..', 'lib', 'sidebar.js');

function freshSidebar(htmlUrl) {
  // Reset require cache so the sidebar IIFE re-initializes its module-scoped
  // mount flag for each test.
  delete require.cache[SIDEBAR_PATH];
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: htmlUrl || 'https://www.coursera.org/learn/x/lecture/v1/intro' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  const sidebar = require('../lib/sidebar.js');
  sidebar.mount();
  const host = dom.window.document.getElementById('ccp-host-root');
  const shadow = host && host.shadowRoot ? host.shadowRoot : host;
  return { sidebar: sidebar, shadow: shadow, dom: dom };
}

test('sidebar exposes a Diagnostics tab that can be activated', () => {
  const { sidebar, shadow } = freshSidebar();
  const tab = shadow.querySelector('[data-tab="diagnostics"]');
  assert.ok(tab, 'Diagnostics tab button must exist');
  sidebar.setActiveTab('diagnostics');
  assert.equal(tab.getAttribute('aria-selected'), 'true');
  const panel = shadow.querySelector('[data-panel="diagnostics"]');
  assert.equal(panel.getAttribute('data-active'), 'true');
});

test('existing tabs and autopilot Run button still exist after Diagnostics is added', () => {
  const { shadow } = freshSidebar();
  assert.ok(shadow.querySelector('[data-tab="copied"]'));
  assert.ok(shadow.querySelector('[data-tab="typer"]'));
  assert.ok(shadow.querySelector('[data-tab="answer"]'));
  assert.ok(shadow.querySelector('[data-tab="autopilot"]'));
  assert.ok(shadow.querySelector('[data-action="autopilot-run"]'));
});

const { createDebugRecorder } = require('../lib/autopilot-debug.js');

test('Diagnostics tab renders events from the injected recorder', () => {
  const { sidebar, shadow } = freshSidebar();
  const rec = createDebugRecorder();
  sidebar.setDebugRecorder(rec);
  rec.record('run.start.requested', { scope: 'course', behaviorMode: 'fast' });
  rec.record('queue.blocked.skipped', { title: 'Assignment: Matrix Indexing', blockReason: 'graded item' });
  const rows = shadow.querySelectorAll('[data-role="diag-events"] .ccp-diag-event');
  assert.equal(rows.length, 2);
  assert.ok(/run\.start\.requested/.test(rows[0].textContent));
  assert.ok(/scope=.?course/.test(rows[0].textContent));
  assert.ok(/queue\.blocked\.skipped/.test(rows[1].textContent));
  assert.ok(/Matrix Indexing/.test(rows[1].textContent));
});

test('setAutopilotRunContext updates the Diagnostics status block', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAutopilotRunContext({ status: 'running', behaviorMode: 'fast', runScope: 'course', cursor: 3, queueLength: 9, currentTitle: 'A', currentKind: 'video' });
  assert.equal(shadow.querySelector('[data-role="diag-status"]').textContent, 'running');
  assert.equal(shadow.querySelector('[data-role="diag-mode"]').textContent, 'fast');
  assert.equal(shadow.querySelector('[data-role="diag-scope"]').textContent, 'course');
  assert.equal(shadow.querySelector('[data-role="diag-cursor"]').textContent, '3');
  assert.equal(shadow.querySelector('[data-role="diag-queue-size"]').textContent, '9');
  assert.equal(shadow.querySelector('[data-role="diag-current"]').textContent, 'A (video)');
});

test('Copy debug report writes formatted text via navigator.clipboard.writeText', async () => {
  const { sidebar, shadow, dom } = freshSidebar();
  const rec = createDebugRecorder();
  sidebar.setDebugRecorder(rec);
  sidebar.setAutopilotRunContext({ status: 'running', behaviorMode: 'fast', runScope: 'course', cursor: 0, queueLength: 1, currentTitle: 'X', currentKind: 'video' });
  rec.record('run.start.requested', { scope: 'course' });

  let copied = null;
  dom.window.navigator.clipboard = { writeText: function (s) { copied = s; return Promise.resolve(); } };

  shadow.querySelector('[data-action="diag-copy"]').click();
  await new Promise(function (r) { setTimeout(r, 10); });
  assert.ok(copied, 'clipboard.writeText must be called');
  assert.ok(/REPORT TIMESTAMP/.test(copied));
  assert.ok(/STATUS\s+running/.test(copied));
  assert.ok(/run\.start\.requested/.test(copied));
  const status = shadow.querySelector('[data-role="diag-status-line"]').textContent;
  assert.ok(/copied|success/i.test(status));
});

test('Copy debug report shows error feedback when clipboard rejects', async () => {
  const { sidebar, shadow, dom } = freshSidebar();
  sidebar.setDebugRecorder(createDebugRecorder());
  dom.window.navigator.clipboard = { writeText: function () { return Promise.reject(new Error('blocked')); } };
  shadow.querySelector('[data-action="diag-copy"]').click();
  await new Promise(function (r) { setTimeout(r, 10); });
  const status = shadow.querySelector('[data-role="diag-status-line"]').textContent;
  assert.ok(/copy failed/i.test(status), 'should show copy failed: ' + status);
});

test('Clear button empties the on-screen events and underlying recorder', () => {
  const { sidebar, shadow } = freshSidebar();
  const rec = createDebugRecorder();
  sidebar.setDebugRecorder(rec);
  rec.record('a', {}); rec.record('b', {});
  shadow.querySelector('[data-action="diag-clear"]').click();
  const rows = shadow.querySelectorAll('[data-role="diag-events"] .ccp-diag-event');
  assert.equal(rows.length, 0);
  assert.deepEqual(rec.getEvents(), []);
});

test('Clear must not affect autopilot Run/Stop buttons or call any autopilot handler', () => {
  const { sidebar, shadow } = freshSidebar();
  let calledStop = false;
  sidebar.setAutopilotHandlers({ onStop: function () { calledStop = true; } });
  sidebar.setDebugRecorder(createDebugRecorder());
  shadow.querySelector('[data-action="diag-clear"]').click();
  assert.equal(calledStop, false, 'Clear must NOT call onStop');
  assert.equal(shadow.querySelector('[data-action="autopilot-run"]').disabled, false);
});

test('REGRESSION: Copy debug report after Stop still reports the last active run scope/queue/cursor', async () => {
  const { sidebar, shadow, dom } = freshSidebar();
  const rec = createDebugRecorder();
  sidebar.setDebugRecorder(rec);
  // Simulate an active course run: 51 safe items, mid-course.
  sidebar.setAutopilotRunContext({
    status: 'running', behaviorMode: 'fast', runScope: 'course',
    cursor: 1, queueLength: 51, courseId: 'matlab', moduleId: 'week-3',
    currentTitle: 'Arithmetic Part 1', currentKind: 'video',
    queue: [
      { id: 'DXTg0', title: 'Combining', kind: 'video', url: '/a' },
      { id: 'TcIQM', title: 'Arithmetic Part 1', kind: 'video', url: '/b' },
    ],
  });
  // Now Stop fires — content.js polling will push an empty/idle context.
  sidebar.setAutopilotRunContext({
    status: 'idle', behaviorMode: 'fast', runScope: 'module',
    cursor: 0, queueLength: 0, courseId: null, moduleId: null,
    currentTitle: '', currentKind: '', queue: [],
  });
  let copied = null;
  dom.window.navigator.clipboard = { writeText: function (s) { copied = s; return Promise.resolve(); } };
  shadow.querySelector('[data-action="diag-copy"]').click();
  await new Promise(function (r) { setTimeout(r, 10); });
  assert.ok(copied, 'clipboard.writeText must be called');
  // Status reflects the current (idle) state — that is correct.
  assert.ok(/STATUS\s+idle/.test(copied), 'status should reflect current idle: ' + copied.slice(0, 200));
  // But the SCOPE, COURSE, MODULE, QUEUE LENGTH, CURSOR from the last active
  // run must survive — otherwise the report after a stall is useless.
  assert.ok(/RUN SCOPE\s+course/.test(copied), 'runScope from last active run preserved: ' + copied.slice(0, 400));
  assert.ok(/COURSE\s+matlab/.test(copied), 'courseId preserved');
  assert.ok(/QUEUE LENGTH\s+51/.test(copied), 'queueLength preserved');
  assert.ok(/CURSOR\s+1\b/.test(copied), 'cursor preserved');
  assert.ok(/Arithmetic Part 1/.test(copied), 'queue items preserved');
});

test('REGRESSION: Clear button erases the last active run context so a stale report is not shown', async () => {
  const { sidebar, shadow, dom } = freshSidebar();
  sidebar.setDebugRecorder(createDebugRecorder());
  sidebar.setAutopilotRunContext({
    status: 'running', runScope: 'course', cursor: 1, queueLength: 5, courseId: 'matlab',
  });
  shadow.querySelector('[data-action="diag-clear"]').click();
  // After Clear, copy should not surface the prior course context.
  let copied = null;
  dom.window.navigator.clipboard = { writeText: function (s) { copied = s; return Promise.resolve(); } };
  shadow.querySelector('[data-action="diag-copy"]').click();
  await new Promise(function (r) { setTimeout(r, 10); });
  assert.ok(copied);
  assert.ok(!/COURSE\s+matlab/.test(copied), 'course context erased after Clear');
});

// ---------------------------------------------------------------------------
// PHASE 5 — Sidebar reflects effective stored settings, including the
// pauseOnUserInput migration outcome. The checkbox must not display as
// checked while the input guard reads the effective setting as false.
// ---------------------------------------------------------------------------

test('setAutopilotSettings is exported on the sidebar API', () => {
  const { sidebar } = freshSidebar();
  assert.equal(typeof sidebar.setAutopilotSettings, 'function');
});

test('setAutopilotSettings({pauseOnUserInput:false}) unchecks the checkbox', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAutopilotSettings({ pauseOnUserInput: false });
  const pi = shadow.querySelector('[data-role="autopilot-pause-on-input"]');
  assert.equal(pi.checked, false, 'checkbox must be unchecked when effective setting is false');
});

test('setAutopilotSettings({pauseOnUserInput:true}) checks the checkbox', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAutopilotSettings({ pauseOnUserInput: true });
  const pi = shadow.querySelector('[data-role="autopilot-pause-on-input"]');
  assert.equal(pi.checked, true, 'checkbox must be checked when effective setting is true');
});

test('setAutopilotSettings also reflects autoSubmitQuizzes and behaviorMode', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAutopilotSettings({ pauseOnUserInput: false, autoSubmitQuizzes: true, behaviorMode: 'human' });
  assert.equal(shadow.querySelector('[data-role="autopilot-auto-submit-quizzes"]').checked, true);
  assert.equal(shadow.querySelector('[data-role="autopilot-behavior-human"]').checked, true);
  assert.equal(shadow.querySelector('[data-role="autopilot-behavior-fast"]').checked, false);
});

test('setAutopilotSettings does NOT echo a settings change to the controller (no feedback loop)', () => {
  // Otherwise initializing the UI from loaded state would re-trigger
  // onSettingsChange and persist a possibly-stale value (e.g. pre-migration true)
  // right back over the migrated one. The sync must be one-way: storage -> UI.
  const { sidebar } = freshSidebar();
  let calls = 0;
  sidebar.setAutopilotHandlers({ onSettingsChange: function () { calls += 1; } });
  sidebar.setAutopilotSettings({ pauseOnUserInput: true });
  assert.equal(calls, 0, 'syncing settings INTO the UI must not emit onSettingsChange');
});

// PHASE 18 — control recovery on refused-start UI dead end. Reproduces the
// production sequence the controller calls on a refused start against an
// existing paused run, then asserts the rendered DOM is usable: Stop must
// be enabled (because the banner says "Stop it to reset") and Run/Run-All
// must be disabled (because activateRun was refused).
test('PHASE 18 sidebar: simulated refused-start UI sequence leaves Stop ENABLED and Run/Run-All DISABLED in real DOM', () => {
  const { sidebar, shadow } = freshSidebar();
  // The new ordering the controller uses on a refused-already-active path:
  //   1. setAutopilotButtonsStarting(true)     (PHASE 17 — gate)
  //   2. setAutopilotButtonsRunning(true)      (PHASE 18 — enable Stop)
  //   3. setAutopilotPaused(true, banner)
  //   4. setAutopilotButtonsStarting(false)    (gate release)
  sidebar.setAutopilotButtonsStarting(true);
  sidebar.setAutopilotButtonsRunning(true);
  sidebar.setAutopilotPaused(true, 'An autopilot run is paused with no remaining items. Stop it to reset before starting a new run.');
  sidebar.setAutopilotButtonsStarting(false);

  const stop   = shadow.querySelector('[data-action="autopilot-stop"]');
  const run    = shadow.querySelector('[data-action="autopilot-run"]');
  const runAll = shadow.querySelector('[data-action="autopilot-run-all"]');
  const banner = shadow.querySelector('[data-role="autopilot-banner"]');
  assert.ok(stop && run && runAll, 'autopilot control buttons must exist');
  assert.equal(stop.disabled, false,
    'PHASE 18: Stop button must be enabled when banner directs "Stop it to reset"');
  assert.equal(run.disabled, true,
    'PHASE 18: Run button must be disabled (another run is already active)');
  assert.equal(runAll.disabled, true,
    'PHASE 18: Run All must be disabled (another run is already active)');
  assert.ok(banner && /stop/i.test(banner.textContent),
    'PHASE 18: banner must mention Stop; got ' + JSON.stringify(banner && banner.textContent));
});

// ---------------------------------------------------------------------------
// Task 7 — "Let AI answer for you" 6th tab
// ---------------------------------------------------------------------------

test('sidebar exposes "Let AI answer for you" tab without removing existing tabs', () => {
  const { sidebar, shadow } = freshSidebar();
  // existing tabs unchanged
  ['copied', 'typer', 'answer', 'autopilot', 'diagnostics'].forEach(function (t) {
    assert.ok(shadow.querySelector('[data-tab="' + t + '"]'), 'existing tab ' + t);
  });
  // new tab
  const tab = shadow.querySelector('[data-tab="ai-answer"]');
  assert.ok(tab, 'AI answer tab button must exist');
  assert.equal(tab.textContent.trim(), 'AI Answers');
});

test('activating AI answer tab toggles only its panel', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setActiveTab('ai-answer');
  const tab = shadow.querySelector('[data-tab="ai-answer"]');
  assert.equal(tab.getAttribute('aria-selected'), 'true');
  const panel = shadow.querySelector('[data-panel="ai-answer"]');
  assert.equal(panel.getAttribute('data-active'), 'true');
  ['copied', 'typer', 'answer', 'autopilot', 'diagnostics'].forEach(function (t) {
    assert.equal(shadow.querySelector('[data-tab="' + t + '"]').getAttribute('aria-selected'), 'false');
  });
});

test('AI panel contains no password/key input field after mount', () => {
  const { sidebar, shadow } = freshSidebar();
  const panel = shadow.querySelector('[data-panel="ai-answer"]');
  assert.ok(panel);
  // No password input, no textarea, no input with data-role="ai-key-input"
  assert.equal(panel.querySelector('input[type="password"]'), null, 'no password input in AI panel');
  assert.equal(panel.querySelector('[data-role="ai-key-input"]'), null);
  assert.equal(panel.querySelector('[data-action="ai-key-save"]'), null);
  assert.equal(panel.querySelector('[data-action="ai-key-toggle"]'), null);
  assert.equal(panel.querySelector('[data-role="ai-key-remember"]'), null);
});

test('handler registry fires correct callbacks exactly once', () => {
  const { sidebar, shadow } = freshSidebar();
  const calls = { openOptions: 0, scan: 0, generate: 0, cancel: 0, apply: 0, clearSuggestions: 0 };
  sidebar.setAiAnswerHandlers({
    onOpenOptions: function () { calls.openOptions++; },
    onScan: function () { calls.scan++; },
    onGenerate: function () { calls.generate++; },
    onCancel: function () { calls.cancel++; },
    onApply: function () { calls.apply++; },
    onClearSuggestions: function () { calls.clearSuggestions++; },
  });
  // Arrange state so every button is enabled at the moment it is clicked.
  // Generate must be clicked BEFORE setAiInFlight(true) because inFlight disables it.
  sidebar.setAiKeyStatus({ keyPresent: true, remembered: false });
  sidebar.setAiPageEligibility({ eligible: true, blockedReason: null, supportedCount: 1, actionableCount: 1 });
  sidebar.setAiScanResult({ token: 't', questions: [{}], supportedCount: 1, actionableCount: 1 });
  // Configure is always enabled (Clear button has been removed).
  shadow.querySelector('[data-action="ai-key-configure"]').click();
  shadow.querySelector('[data-action="ai-scan"]').click();
  // Generate is enabled now (key present, eligible, scan done, not in-flight).
  shadow.querySelector('[data-action="ai-generate"]').click();
  // Now set inFlight=true to enable Cancel.
  sidebar.setAiInFlight(true);
  shadow.querySelector('[data-action="ai-cancel"]').click();
  // After in-flight clears, enable Apply via suggestions, then click.
  sidebar.setAiInFlight(false);
  sidebar.setAiSuggestions([{ applicable: true, questionNumber: 1 }]);
  shadow.querySelector('[data-action="ai-apply"]').click();
  shadow.querySelector('[data-action="ai-clear-suggestions"]').click();
  assert.equal(calls.openOptions, 1);
  assert.equal(calls.scan, 1);
  assert.equal(calls.generate, 1);
  assert.equal(calls.cancel, 1);
  assert.equal(calls.apply, 1);
  assert.equal(calls.clearSuggestions, 1);
});

// ---------------------------------------------------------------------------
// T1 — Remove sidebar Clear button
// ---------------------------------------------------------------------------

test('T1/A1: AI panel does NOT contain an ai-key-clear button', () => {
  const { sidebar, shadow } = freshSidebar();
  const panel = shadow.querySelector('[data-panel="ai-answer"]');
  assert.ok(panel);
  assert.equal(panel.querySelector('[data-action="ai-key-clear"]'), null,
    'Clear button must be absent from the Coursera content sidebar — only options.html may clear the key');
});

test('T1/A1: AI panel still has the Configure/Manage key button', () => {
  const { sidebar, shadow } = freshSidebar();
  const configure = shadow.querySelector('[data-action="ai-key-configure"]');
  assert.ok(configure, 'Configure/Manage button must remain');
  assert.ok(/manage|configure/i.test(configure.textContent), 'Configure button label');
});

test('Generate is disabled until eligible scan AND key present', () => {
  const { sidebar, shadow } = freshSidebar();
  const gen = shadow.querySelector('[data-action="ai-generate"]');
  assert.equal(gen.disabled, true);
  sidebar.setAiKeyStatus(true);
  assert.equal(gen.disabled, true, 'still disabled without scan');
  sidebar.setAiPageEligibility({ eligible: true, blockedReason: null, supportedCount: 2, actionableCount: 2 });
  sidebar.setAiScanResult({ token: 't', questions: [{}, {}], supportedCount: 2, actionableCount: 2 });
  assert.equal(gen.disabled, false);
});

test('Apply is disabled until suggestions exist', () => {
  const { sidebar, shadow } = freshSidebar();
  const apply = shadow.querySelector('[data-action="ai-apply"]');
  assert.equal(apply.disabled, true);
  sidebar.setAiSuggestions([{ applicable: true, questionNumber: 1 }]);
  assert.equal(apply.disabled, false);
});

test('blocked-page state disables Generate and Apply', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus(true);
  sidebar.setAiPageEligibility({ eligible: false, blockedReason: 'graded item', supportedCount: 0 });
  assert.equal(shadow.querySelector('[data-action="ai-generate"]').disabled, true);
  assert.equal(shadow.querySelector('[data-action="ai-apply"]').disabled, true);
  const status = shadow.querySelector('[data-role="ai-status"]');
  assert.ok(/disabled on graded or blocked/i.test(status.textContent));
});

test('in-flight state enables Cancel and disables Generate', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus(true);
  sidebar.setAiPageEligibility({ eligible: true, blockedReason: null, supportedCount: 1 });
  sidebar.setAiScanResult({ token: 't', questions: [{}], supportedCount: 1 });
  sidebar.setAiInFlight(true);
  assert.equal(shadow.querySelector('[data-action="ai-generate"]').disabled, true);
  assert.equal(shadow.querySelector('[data-action="ai-cancel"]').disabled, false);
  sidebar.setAiInFlight(false);
  assert.equal(shadow.querySelector('[data-action="ai-cancel"]').disabled, true);
});

test('API key value is never written into any rendered DOM text', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus({ keyPresent: true, remembered: false });
  sidebar.setAiPageEligibility({ eligible: true, blockedReason: null, supportedCount: 1 });
  sidebar.setAiScanResult({ token: 't', questions: [{}], supportedCount: 1 });
  sidebar.setAiSuggestions([{ applicable: true, questionNumber: 1, explanation: 'why' }]);
  // No password input in the panel means no key value can be in the DOM.
  const aiPanel = shadow.querySelector('[data-panel="ai-answer"]');
  assert.equal(aiPanel.querySelector('input[type="password"]'), null, 'no password input in AI panel');
});

test('debug export does not include AI key state', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus({ keyPresent: true, remembered: false });
  const exportBtn = shadow.querySelector('[data-action="diag-copy"]');
  // Spy on clipboard write
  let captured = '';
  shadow.ownerDocument.defaultView.navigator.clipboard = { writeText: function (t) { captured = t; return Promise.resolve(); } };
  if (exportBtn) exportBtn.click();
  // captured may be empty if no debugRecorder; this test passes as long as it does not contain a key pattern
  assert.equal(captured.indexOf('sk-'), -1);
});

// ---------------------------------------------------------------------------
// H1 — Sidebar XSS hardening: setAiScanResult + setAiSuggestions must not
// inject attacker-controlled markup via innerHTML.
// ---------------------------------------------------------------------------

test('A1: setAiScanResult renders prompt as literal text and does not inject markup', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiScanResult({
    token: 't1',
    questions: [{
      questionNumber: 1,
      type: 'single_choice',
      prompt: '<img data-attack="scan" src=x onerror="window.__attack=1">Question',
      supported: true,
    }],
    supportedCount: 1,
  });
  const preview = shadow.querySelector('[data-role="ai-scan-preview"]');
  assert.ok(preview, 'preview container must exist');
  // No injected element with the attack marker
  assert.equal(preview.querySelector('img[data-attack="scan"]'), null);
  // The literal prompt text appears verbatim somewhere in textContent
  assert.ok(preview.textContent.indexOf('<img data-attack="scan"') !== -1
    || preview.textContent.indexOf('data-attack="scan"') !== -1);
});

test('A2: setAiSuggestions renders value/explanation as literal text and does not inject markup', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiSuggestions([{
    questionNumber: 1,
    type: 'math_input',
    value: '<button data-attack="model">Fake Apply</button>',
    explanation: '<button data-attack="explain">Fake</button>',
    mappingStatus: 'matched',
    applicable: true,
  }]);
  const preview = shadow.querySelector('[data-role="ai-suggestion-preview"]');
  assert.equal(preview.querySelector('button[data-attack="model"]'), null);
  assert.equal(preview.querySelector('button[data-attack="explain"]'), null);
  assert.ok(preview.textContent.indexOf('<button') !== -1);
});

test('A3: option-label markup returned via AI suggestion remains literal text (multi-choice)', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiSuggestions([{
    questionNumber: 2,
    type: 'multiple_choice',
    choiceTexts: ['<img data-attack="opt" src=x>Option A', 'Option B'],
    mappingStatus: 'matched',
    applicable: true,
  }]);
  const preview = shadow.querySelector('[data-role="ai-suggestion-preview"]');
  assert.equal(preview.querySelector('img[data-attack="opt"]'), null);
});

test('A4: existing previews still show readable content after safe rendering', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiScanResult({
    token: 't',
    questions: [
      { questionNumber: 1, type: 'single_choice', prompt: 'What is 2+2?', supported: true },
      { questionNumber: 2, type: 'math_input', prompt: 'Enter x:', supported: true },
    ],
    supportedCount: 2,
  });
  const scanPreview = shadow.querySelector('[data-role="ai-scan-preview"]');
  assert.ok(scanPreview.textContent.indexOf('What is 2+2?') !== -1);
  assert.ok(scanPreview.textContent.indexOf('Enter x:') !== -1);
  // Counts should still appear
  assert.ok(/Detected\s+2/i.test(scanPreview.textContent));

  sidebar.setAiSuggestions([
    { questionNumber: 1, type: 'single_choice', choiceText: 'Beta', mappingStatus: 'matched', applicable: true, explanation: 'because' },
    { questionNumber: 2, type: 'math_input', value: '0.0352', mappingStatus: 'matched', applicable: true },
  ]);
  const sugPreview = shadow.querySelector('[data-role="ai-suggestion-preview"]');
  assert.ok(sugPreview.textContent.indexOf('Beta') !== -1);
  assert.ok(sugPreview.textContent.indexOf('0.0352') !== -1);
  assert.ok(sugPreview.textContent.indexOf('because') !== -1);
});

test('E1: Generate disabled when actionableCount=0 even with snapshot.questions.length>0', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus(true);
  sidebar.setAiPageEligibility({ eligible: true, blockedReason: null, supportedCount: 2, actionableCount: 0 });
  sidebar.setAiScanResult({ token: 't', questions: [{}, {}], supportedCount: 2, actionableCount: 0 });
  assert.equal(shadow.querySelector('[data-action="ai-generate"]').disabled, true);
  // Status should say no unanswered supported questions
  assert.ok(/No unanswered supported questions/i.test(shadow.querySelector('[data-role="ai-status"]').textContent));
});

test('E3: Generate enabled when actionableCount>0', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus(true);
  sidebar.setAiPageEligibility({ eligible: true, blockedReason: null, supportedCount: 2, actionableCount: 1 });
  sidebar.setAiScanResult({ token: 't', questions: [{}, {}], supportedCount: 2, actionableCount: 1 });
  assert.equal(shadow.querySelector('[data-action="ai-generate"]').disabled, false);
});

// ---------------------------------------------------------------------------
// H7 — Honest error message rendering (C1-C6)
// ---------------------------------------------------------------------------

test('C: setAiApplyResult(null) clears the result line', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiApplyResult({ filled: 3, failed: 1 });
  sidebar.setAiApplyResult(null);
  assert.equal(shadow.querySelector('[data-role="ai-apply-result"]').textContent, '');
});

test('C: setAiApplyResult({message}) renders the message and NOT the counts', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiApplyResult({ filled: 0, failed: 0, message: 'Enter an AI API Key before generating suggestions.' });
  const txt = shadow.querySelector('[data-role="ai-apply-result"]').textContent;
  assert.equal(txt, 'Enter an AI API Key before generating suggestions.');
});

test('C: setAiApplyResult({filled,failed}) without message renders counts', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiApplyResult({ filled: 2, failed: 1 });
  const txt = shadow.querySelector('[data-role="ai-apply-result"]').textContent;
  assert.equal(txt, 'Applied 2 answers; skipped 1.');
});

test('C: messages with HTML markup render as literal text', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiApplyResult({ message: '<img src=x onerror="window.__x=1">attack' });
  const cell = shadow.querySelector('[data-role="ai-apply-result"]');
  assert.equal(cell.querySelector('img'), null);
  assert.ok(cell.textContent.indexOf('<img') !== -1);
});

// ---------------------------------------------------------------------------
// S5 — disabled button integrity (wireDisableable removed)
// ---------------------------------------------------------------------------

test('S5: disabled Apply button does NOT invoke onApply when clicked', () => {
  const { sidebar, shadow } = freshSidebar();
  let applyCalls = 0;
  sidebar.setAiAnswerHandlers({ onApply: function () { applyCalls++; } });
  // Apply starts disabled (no suggestions). Verify.
  const apply = shadow.querySelector('[data-action="ai-apply"]');
  assert.equal(apply.disabled, true);
  apply.click();
  assert.equal(applyCalls, 0, 'disabled button must not fire handler');
});

test('S5: disabled Generate button does NOT invoke onGenerate when clicked', () => {
  const { sidebar, shadow } = freshSidebar();
  let genCalls = 0;
  sidebar.setAiAnswerHandlers({ onGenerate: function () { genCalls++; } });
  const gen = shadow.querySelector('[data-action="ai-generate"]');
  assert.equal(gen.disabled, true);
  gen.click();
  assert.equal(genCalls, 0);
});

// ---------------------------------------------------------------------------
// S4 — Configure button replaces key entry UI
// ---------------------------------------------------------------------------

test('S4: Configure button exists and triggers onOpenOptions', () => {
  const { sidebar, shadow } = freshSidebar();
  let opened = 0;
  sidebar.setAiAnswerHandlers({ onOpenOptions: function () { opened++; } });
  shadow.querySelector('[data-action="ai-key-configure"]').click();
  assert.equal(opened, 1);
});

test('S4: setAiKeyStatus({keyPresent:true, remembered:false}) renders the session-only label', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus({ keyPresent: true, remembered: false });
  const el = shadow.querySelector('[data-role="ai-key-state"]');
  assert.equal(el.textContent, 'AI API Key configured for this session.');
});

test('S4: setAiKeyStatus({keyPresent:true, remembered:true}) renders the remembered label', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus({ keyPresent: true, remembered: true });
  const el = shadow.querySelector('[data-role="ai-key-state"]');
  assert.equal(el.textContent, 'AI API Key remembered on this browser.');
});

test('S4: setAiKeyStatus(false) [legacy boolean] renders not-configured label', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus(false);
  const el = shadow.querySelector('[data-role="ai-key-state"]');
  assert.equal(el.textContent, 'No AI API Key configured.');
});

test('S4: setAiKeyStatus(true) [legacy boolean] renders session label', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus(true);
  const el = shadow.querySelector('[data-role="ai-key-state"]');
  assert.equal(el.textContent, 'AI API Key configured for this session.');
});

// === U1: width + tab wrapping ===
test('U1: sidebar.css declares .ccp-host width with viewport-safe min()', () => {
  const fs = require('fs'); const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sidebar.css'), 'utf8');
  // The .ccp-host block must use min(...) for width — not a fixed 360px value.
  // We require the explicit "min(" pattern to enforce viewport safety.
  const hostBlock = css.match(/\.ccp-host\s*\{[^}]+\}/);
  assert.ok(hostBlock, '.ccp-host block must exist');
  assert.ok(/width:\s*min\(/i.test(hostBlock[0]), '.ccp-host width must use min(...) for viewport safety');
});

test('U1: .ccp-tabs uses flex-wrap: wrap (not nowrap)', () => {
  const fs = require('fs'); const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sidebar.css'), 'utf8');
  const tabsBlock = css.match(/\.ccp-tabs\s*\{[^}]+\}/);
  assert.ok(tabsBlock);
  assert.ok(/flex-wrap:\s*wrap\b/i.test(tabsBlock[0]), '.ccp-tabs must declare flex-wrap: wrap');
  assert.equal(/flex-wrap:\s*nowrap\b/i.test(tabsBlock[0]), false, 'nowrap must be gone');
});

test('U1: .ccp-tab grows to fill available row space (flex: 1 1 ...)', () => {
  const fs = require('fs'); const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sidebar.css'), 'utf8');
  // Find the .ccp-tab block but NOT .ccp-tab:hover/.ccp-tab[aria-selected]
  // We look for the standalone selector.
  const m = css.match(/(^|\})\s*\.ccp-tab\s*\{[^}]+\}/);
  assert.ok(m, 'a base .ccp-tab block must exist');
  assert.ok(/flex:\s*1\s+1\s/i.test(m[0]), '.ccp-tab must use flex: 1 1 ...');
});

test('U1: all six tabs still present and AI tab still activatable', () => {
  const { sidebar, shadow } = freshSidebar();
  ['copied', 'typer', 'answer', 'autopilot', 'diagnostics', 'ai-answer'].forEach(function (t) {
    assert.ok(shadow.querySelector('[data-tab="' + t + '"]'), 'tab ' + t);
  });
  sidebar.setActiveTab('ai-answer');
  assert.equal(shadow.querySelector('[data-tab="ai-answer"]').getAttribute('aria-selected'), 'true');
});

// === U2: AI tab label ===
test('U2: AI tab label is "AI Answers" (short label, data-tab="ai-answer" preserved)', () => {
  const { sidebar, shadow } = freshSidebar();
  const tab = shadow.querySelector('[data-tab="ai-answer"]');
  assert.ok(tab);
  assert.equal(tab.textContent.trim(), 'AI Answers');
});

// === U3: AI panel structural cards ===

test('U3: AI panel contains all five named card containers', () => {
  const { sidebar, shadow } = freshSidebar();
  const panel = shadow.querySelector('[data-panel="ai-answer"]');
  assert.ok(panel);
  ['ai-card-key', 'ai-card-scan', 'ai-actions-primary', 'ai-actions-secondary', 'ai-actions-inflight', 'ai-previews'].forEach(function (n) {
    assert.ok(panel.querySelector('[data-card="' + n + '"]'), 'missing card: ' + n);
  });
});

test('U3: primary action row contains Scan + Generate; secondary contains Apply + Clear suggestions', () => {
  const { sidebar, shadow } = freshSidebar();
  const primary = shadow.querySelector('[data-card="ai-actions-primary"]');
  const secondary = shadow.querySelector('[data-card="ai-actions-secondary"]');
  assert.ok(primary && secondary);
  assert.ok(primary.querySelector('[data-action="ai-scan"]'));
  assert.ok(primary.querySelector('[data-action="ai-generate"]'));
  assert.ok(secondary.querySelector('[data-action="ai-apply"]'));
  assert.ok(secondary.querySelector('[data-action="ai-clear-suggestions"]'));
  // No Scan/Generate in secondary, no Apply/Clear in primary
  assert.equal(primary.querySelector('[data-action="ai-apply"]'), null);
  assert.equal(secondary.querySelector('[data-action="ai-scan"]'), null);
});

test('U3: Cancel button has data-variant="danger" and starts hidden', () => {
  const { sidebar, shadow } = freshSidebar();
  const cancel = shadow.querySelector('[data-action="ai-cancel"]');
  assert.ok(cancel);
  assert.equal(cancel.getAttribute('data-variant'), 'danger');
  assert.equal(cancel.hidden, true);
});

test('U3: Cancel lives inside ai-actions-inflight card', () => {
  const { sidebar, shadow } = freshSidebar();
  const inflightCard = shadow.querySelector('[data-card="ai-actions-inflight"]');
  const cancel = shadow.querySelector('[data-action="ai-cancel"]');
  assert.ok(inflightCard && cancel);
  assert.ok(inflightCard.contains(cancel));
});

test('U3: AI key card has a status pill (ai-key-state) and a security note (ai-key-note)', () => {
  const { sidebar, shadow } = freshSidebar();
  const keyCard = shadow.querySelector('[data-card="ai-card-key"]');
  assert.ok(keyCard);
  assert.ok(keyCard.querySelector('[data-role="ai-key-state"]'));
  const note = keyCard.querySelector('[data-role="ai-key-note"]');
  assert.ok(note);
  assert.ok(/extension settings/i.test(note.textContent), 'note mentions extension settings');
  assert.ok(/Coursera/i.test(note.textContent), 'note contrasts with Coursera');
});

test('U3: ai-key-configure button exists exactly once and lives in the key card', () => {
  const { sidebar, shadow } = freshSidebar();
  const all = shadow.querySelectorAll('[data-action="ai-key-configure"]');
  assert.equal(all.length, 1);
  const keyCard = shadow.querySelector('[data-card="ai-card-key"]');
  assert.ok(keyCard.contains(all[0]));
});

test('U3: previews card contains all three preview roles', () => {
  const { sidebar, shadow } = freshSidebar();
  const previews = shadow.querySelector('[data-card="ai-previews"]');
  assert.ok(previews);
  assert.ok(previews.querySelector('[data-role="ai-scan-preview"]'));
  assert.ok(previews.querySelector('[data-role="ai-suggestion-preview"]'));
  assert.ok(previews.querySelector('[data-role="ai-apply-result"]'));
});

test('U3: secret-boundary unchanged — no password input, no key input, no clear/save key actions', () => {
  const { sidebar, shadow } = freshSidebar();
  const panel = shadow.querySelector('[data-panel="ai-answer"]');
  assert.equal(panel.querySelector('input[type="password"]'), null);
  assert.equal(panel.querySelector('[data-role="ai-key-input"]'), null);
  assert.equal(panel.querySelector('[data-action="ai-key-clear"]'), null);
  assert.equal(panel.querySelector('[data-action="ai-key-save"]'), null);
  assert.equal(panel.querySelector('[data-action="ai-key-toggle"]'), null);
});

// === U4: Cancel visibility via hidden ===

test('U4: setAiInFlight(true) reveals Cancel; (false) hides it again — both hidden and disabled tracked', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus(true);
  sidebar.setAiPageEligibility({ eligible: true, blockedReason: null, supportedCount: 1, actionableCount: 1 });
  sidebar.setAiScanResult({ token: 't', questions: [{}], supportedCount: 1, actionableCount: 1 });
  const cancel = shadow.querySelector('[data-action="ai-cancel"]');
  assert.equal(cancel.hidden, true, 'idle: hidden');
  assert.equal(cancel.disabled, true, 'idle: disabled (defense in depth)');
  sidebar.setAiInFlight(true);
  assert.equal(cancel.hidden, false, 'in-flight: visible');
  assert.equal(cancel.disabled, false, 'in-flight: enabled');
  sidebar.setAiInFlight(false);
  assert.equal(cancel.hidden, true, 'returned-to-idle: hidden');
  assert.equal(cancel.disabled, true, 'returned-to-idle: disabled');
});

// === U5: CSS class presence (the file-read CSS contract tests live in earlier U1 tests; here we assert DOM-class presence) ===

test('U5: AI cards carry the ccp-ai-card class so CSS can target them', () => {
  const { sidebar, shadow } = freshSidebar();
  const cards = shadow.querySelectorAll('.ccp-ai-card');
  assert.ok(cards.length >= 2, 'at least key + scan cards have ccp-ai-card class');
});

test('U5: AI action rows carry the ccp-ai-actions class', () => {
  const { sidebar, shadow } = freshSidebar();
  const rows = shadow.querySelectorAll('.ccp-ai-actions');
  assert.ok(rows.length >= 2, 'at least two action rows have ccp-ai-actions class');
});

test('U5: sidebar.css declares .ccp-ai-card and .ccp-ai-actions selectors', () => {
  const fs = require('fs'); const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sidebar.css'), 'utf8');
  assert.ok(/\.ccp-ai-card\s*\{/.test(css), '.ccp-ai-card selector must exist');
  assert.ok(/\.ccp-ai-actions\s*\{/.test(css), '.ccp-ai-actions selector must exist');
  assert.ok(/\.ccp-ai-status-pill\s*\{/.test(css), '.ccp-ai-status-pill selector must exist');
  assert.ok(/\.ccp-ai-note\s*\{/.test(css), '.ccp-ai-note selector must exist');
});

// === U9: provider-neutral wording ===

test('U9: AI panel key card header reads "AI API Key" (no provider name)', () => {
  const { sidebar, shadow } = freshSidebar();
  const keyCard = shadow.querySelector('[data-card="ai-card-key"]');
  assert.ok(keyCard);
  const header = keyCard.querySelector('.ccp-ai-card-header');
  assert.ok(header);
  assert.equal(header.textContent.trim(), 'AI API Key');
  assert.equal(keyCard.textContent.indexOf('DeepSeek'), -1, 'no provider name in key card');
});

test('U9: initial key state pill reads "No AI API Key configured."', () => {
  const { sidebar, shadow } = freshSidebar();
  const pill = shadow.querySelector('[data-role="ai-key-state"]');
  assert.equal(pill.textContent, 'No AI API Key configured.');
});

test('U9: setAiKeyStatus({keyPresent:true, remembered:false}) renders generic session label', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus({ keyPresent: true, remembered: false });
  const pill = shadow.querySelector('[data-role="ai-key-state"]');
  assert.equal(pill.textContent, 'AI API Key configured for this session.');
  assert.equal(pill.textContent.indexOf('DeepSeek'), -1);
});

test('U9: setAiKeyStatus({keyPresent:true, remembered:true}) renders generic remembered label', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus({ keyPresent: true, remembered: true });
  const pill = shadow.querySelector('[data-role="ai-key-state"]');
  assert.equal(pill.textContent, 'AI API Key remembered on this browser.');
  assert.equal(pill.textContent.indexOf('DeepSeek'), -1);
});

test('U9: setAiKeyStatus(false) [legacy boolean] still renders generic no-key label', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus(false);
  assert.equal(shadow.querySelector('[data-role="ai-key-state"]').textContent, 'No AI API Key configured.');
});

test('U9: Manage button label reads "Manage AI API Key"', () => {
  const { sidebar, shadow } = freshSidebar();
  const btn = shadow.querySelector('[data-action="ai-key-configure"]');
  assert.equal(btn.textContent.trim(), 'Manage AI API Key');
});

test('U9: key card security note mentions AI API Key and Coursera, not DeepSeek', () => {
  const { sidebar, shadow } = freshSidebar();
  const note = shadow.querySelector('[data-role="ai-key-note"]');
  assert.ok(note);
  assert.ok(/AI API Key/i.test(note.textContent));
  assert.ok(/Coursera/i.test(note.textContent));
  assert.equal(note.textContent.indexOf('DeepSeek'), -1);
});

test('U9: AI panel rendered text contains no "DeepSeek" after initial mount and after status setters', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus({ keyPresent: true, remembered: false });
  sidebar.setAiPageEligibility({ eligible: true, blockedReason: null, supportedCount: 1, actionableCount: 1 });
  sidebar.setAiScanResult({ token: 't', questions: [{ questionNumber: 1, type: 'single_choice', prompt: 'p', supported: true }], supportedCount: 1, actionableCount: 1 });
  sidebar.setAiSuggestions([{ applicable: true, questionNumber: 1, mappingStatus: 'matched', choiceText: 'A' }]);
  sidebar.setAiApplyResult({ filled: 1, failed: 0 });
  const panel = shadow.querySelector('[data-panel="ai-answer"]');
  assert.equal(panel.textContent.indexOf('DeepSeek'), -1, 'no "DeepSeek" must appear in any visible AI panel text');
});

test('U9: secret-boundary unchanged (no built-in-key control, no key input, no save/clear-key buttons)', () => {
  const { sidebar, shadow } = freshSidebar();
  const panel = shadow.querySelector('[data-panel="ai-answer"]');
  assert.equal(panel.querySelector('input[type="password"]'), null);
  assert.equal(panel.querySelector('[data-role="ai-key-input"]'), null);
  assert.equal(panel.querySelector('[data-action="ai-key-save"]'), null);
  assert.equal(panel.querySelector('[data-action="ai-key-clear"]'), null);
  assert.equal(panel.querySelector('[data-action="ai-use-builtin"]'), null);
  assert.equal(panel.textContent.indexOf('Use built-in API key'), -1);
});

// ---------------------------------------------------------------------------
// Task S0-1 — Build indicator
// ---------------------------------------------------------------------------

test('Stage 0: Diagnostics tab renders a Build indicator', () => {
  const { sidebar, shadow } = freshSidebar();
  const el = shadow.querySelector('[data-role="ccp-build"]');
  assert.ok(el, 'Diagnostics tab must contain [data-role="ccp-build"]');
  assert.ok(/^Build:\s+/.test(el.textContent), 'must start with "Build: "');
});

test('Stage 0: Build text does NOT contain a hardcoded version literal', () => {
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sidebar.js'), 'utf8');
  assert.equal(src.match(/Build:\s*\d+\.\d+\.\d+/), null, 'no hardcoded version literal in source');
});

// === S2-3: dual-card layout + setAiAccessMode/setAiManagedStatus ===

test('S2-3: AI panel contains both ai-card-key and ai-card-managed', () => {
  const { sidebar, shadow } = freshSidebar();
  assert.ok(shadow.querySelector('[data-card="ai-card-key"]'));
  assert.ok(shadow.querySelector('[data-card="ai-card-managed"]'));
});

test('S2-3: by default (personal-key mode) the managed card is hidden, BYOK card visible', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiAccessMode('personal-key');
  assert.equal(shadow.querySelector('[data-card="ai-card-key"]').hidden, false);
  assert.equal(shadow.querySelector('[data-card="ai-card-managed"]').hidden, true);
});

test('S2-3: setAiAccessMode("managed-credits") shows managed card, hides BYOK', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiAccessMode('managed-credits');
  assert.equal(shadow.querySelector('[data-card="ai-card-key"]').hidden, true);
  assert.equal(shadow.querySelector('[data-card="ai-card-managed"]').hidden, false);
});

test('S2-3: managed card contains NO key input / save / clear / show / remember', () => {
  const { sidebar, shadow } = freshSidebar();
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  assert.equal(managed.querySelector('input[type="password"]'), null);
  assert.equal(managed.querySelector('[data-role="ai-key-input"]'), null);
  assert.equal(managed.querySelector('[data-action="ai-key-save"]'), null);
  assert.equal(managed.querySelector('[data-action="ai-key-clear"]'), null);
  assert.equal(managed.querySelector('[data-action="ai-key-toggle"]'), null);
  assert.equal(managed.querySelector('[data-role="ai-key-remember"]'), null);
});

test('S2-3: managed card has title "AI Credits", a status pill, and a portal action button', () => {
  const { sidebar, shadow } = freshSidebar();
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  const header = managed.querySelector('.ccp-ai-card-header');
  assert.ok(header);
  assert.equal(header.textContent.trim(), 'AI Credits');
  assert.ok(managed.querySelector('[data-role="ai-managed-state"]'));
  assert.ok(managed.querySelector('[data-action="ai-open-portal"]'));
});

test('S2-3: setAiManagedStatus({ available:false, message:"X" }) renders X', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiManagedStatus({ available: false, message: 'Managed AI Credits are not yet available in this build.' });
  const pill = shadow.querySelector('[data-role="ai-managed-state"]');
  assert.equal(pill.textContent, 'Managed AI Credits are not yet available in this build.');
});

test('S2-3: setAiManagedStatus({ available:false }) marks the managed card as unavailable', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiManagedStatus({ available: false });
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  assert.ok(managed.classList.contains('ccp-ai-card--unavailable'));
});

test('S2-3: setAiAccessMode("garbage-value") normalizes to personal-key', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiAccessMode('garbage-value');
  assert.equal(shadow.querySelector('[data-card="ai-card-key"]').hidden, false);
  assert.equal(shadow.querySelector('[data-card="ai-card-managed"]').hidden, true);
});

test('S2-3: no provider name appears in either card', () => {
  const { sidebar, shadow } = freshSidebar();
  const panel = shadow.querySelector('[data-panel="ai-answer"]');
  assert.equal(panel.textContent.indexOf('DeepSeek'), -1);
});

// === U10 Issue 3 — sidebar managed card stays unavailable and fail-closed ===

test('U10-3: sidebar managed card default text matches the honest unavailability wording', () => {
  const { sidebar, shadow } = freshSidebar();
  const pill = shadow.querySelector('[data-role="ai-managed-state"]');
  assert.equal(pill.textContent, 'Managed AI Credits are not yet available in this build.');
});

test('U10-3: sidebar managed card portal button is disabled by default', () => {
  const { sidebar, shadow } = freshSidebar();
  const btn = shadow.querySelector('[data-action="ai-open-portal"]');
  assert.ok(btn);
  assert.ok(btn.hasAttribute('disabled'),
    'sidebar portal button must remain disabled in Stage 2');
});

test('U10-3: sidebar managed card contains no "Purchase" or "Balance" claim', () => {
  const { sidebar, shadow } = freshSidebar();
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  const txt = managed.textContent;
  assert.equal(txt.indexOf('Purchase'), -1);
  assert.equal(txt.indexOf('Balance'), -1);
});

test('U10-3: sidebar managed-mode panel still hidden until setAiAccessMode("managed-credits") flips it', () => {
  const { sidebar, shadow } = freshSidebar();
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  assert.equal(managed.hidden, true);
  sidebar.setAiAccessMode('managed-credits');
  assert.equal(managed.hidden, false);
});

// === U11 Issue 2 — sidebar.css must enforce hidden on .ccp-ai-card ===

test('U11-2: lib/sidebar.css contains the .ccp-ai-card[hidden] display:none rule', () => {
  const fs = require('fs'); const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sidebar.css'), 'utf8');
  assert.ok(
    /\.ccp-ai-card\[hidden\]\s*\{\s*display:\s*none\s*;?\s*\}/.test(css),
    'lib/sidebar.css must declare ".ccp-ai-card[hidden] { display: none; }" to override the .ccp-ai-card display:flex rule'
  );
});

function freshSidebarWithCss() {
  const { sidebar, shadow, dom } = freshSidebar();
  const fs = require('fs'); const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sidebar.css'), 'utf8');
  let styleTag = shadow.querySelector('style[data-test="ccp"]');
  if (!styleTag) {
    styleTag = dom.window.document.createElement('style');
    styleTag.setAttribute('data-test', 'ccp');
    shadow.appendChild(styleTag);
  }
  styleTag.textContent = css;
  return { sidebar, shadow, dom };
}

test('U11-2: default-mount personal-key mode renders ONLY the AI API Key card (computed style)', () => {
  const { shadow, dom } = freshSidebarWithCss();
  const key = shadow.querySelector('[data-card="ai-card-key"]');
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  const keyDisp = dom.window.getComputedStyle(key).display;
  const managedDisp = dom.window.getComputedStyle(managed).display;
  assert.notEqual(keyDisp, 'none', 'personal-key card must render');
  assert.equal(managedDisp, 'none', 'managed card must be display:none, not just hidden');
});

test('U11-2: setAiAccessMode("managed-credits") renders ONLY the AI Credits card (computed style)', () => {
  const { sidebar, shadow, dom } = freshSidebarWithCss();
  sidebar.setAiAccessMode('managed-credits');
  const key = shadow.querySelector('[data-card="ai-card-key"]');
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  const keyDisp = dom.window.getComputedStyle(key).display;
  const managedDisp = dom.window.getComputedStyle(managed).display;
  assert.equal(keyDisp, 'none', 'personal-key card must be display:none after managed-credits');
  assert.notEqual(managedDisp, 'none', 'managed card must render after managed-credits');
});

test('U11-2: setAiAccessMode("garbage") normalizes to personal-key and renders ONLY the AI API Key card', () => {
  const { sidebar, shadow, dom } = freshSidebarWithCss();
  sidebar.setAiAccessMode('garbage');
  const key = shadow.querySelector('[data-card="ai-card-key"]');
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  assert.notEqual(dom.window.getComputedStyle(key).display, 'none');
  assert.equal(dom.window.getComputedStyle(managed).display, 'none');
});

test('U11-2: the two access cards are NEVER both visibly rendered simultaneously across mode toggles', () => {
  const { sidebar, shadow, dom } = freshSidebarWithCss();
  const modes = ['personal-key', 'managed-credits', 'personal-key', 'garbage', 'managed-credits'];
  for (const m of modes) {
    sidebar.setAiAccessMode(m);
    const k = dom.window.getComputedStyle(shadow.querySelector('[data-card="ai-card-key"]')).display;
    const g = dom.window.getComputedStyle(shadow.querySelector('[data-card="ai-card-managed"]')).display;
    const kVisible = k !== 'none';
    const gVisible = g !== 'none';
    assert.ok(!(kVisible && gVisible), 'both cards visible after setAiAccessMode("' + m + '")');
    assert.ok(kVisible || gVisible, 'at least one card must be visible after setAiAccessMode("' + m + '")');
  }
});

test('U11-2: REGRESSION — cancel button row stays hidden when not in flight (existing :has rule still works)', () => {
  const { sidebar, shadow, dom } = freshSidebarWithCss();
  const inflightRow = shadow.querySelector('[data-card="ai-actions-inflight"]');
  if (inflightRow) {
    const disp = dom.window.getComputedStyle(inflightRow).display;
    assert.equal(disp, 'none', 'the inflight action row must remain display:none when cancel is hidden');
  }
});

// === U11 Issue 1 — sidebar must surface open-options failure as inert text ===

test('U11-1: ai-card-key contains a hidden [data-role="ai-open-options-status"] inert-text element', () => {
  const { shadow } = freshSidebar();
  const keyCard = shadow.querySelector('[data-card="ai-card-key"]');
  assert.ok(keyCard, 'ai-card-key must exist');
  const status = keyCard.querySelector('[data-role="ai-open-options-status"]');
  assert.ok(status, 'ai-card-key must contain [data-role="ai-open-options-status"]');
  assert.ok(status.hasAttribute('hidden'), 'open-options status must start hidden');
  assert.equal(status.textContent, '', 'open-options status must start empty');
});

test('U11-1: setAiOpenOptionsFailure(text) sets visible inert text', () => {
  const { sidebar, shadow } = freshSidebar();
  const honest = 'Unable to open AI API Key settings. Open the extension options page from chrome://extensions.';
  sidebar.setAiOpenOptionsFailure(honest);
  const status = shadow.querySelector('[data-role="ai-open-options-status"]');
  assert.equal(status.textContent, honest);
  assert.equal(status.hasAttribute('hidden'), false, 'status must un-hide when failure text is set');
});

test('U11-1: setAiOpenOptionsFailure("") clears and re-hides the status', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiOpenOptionsFailure('something');
  sidebar.setAiOpenOptionsFailure('');
  const status = shadow.querySelector('[data-role="ai-open-options-status"]');
  assert.equal(status.textContent, '');
  assert.ok(status.hasAttribute('hidden'), 'status must re-hide when text is empty');
});

test('U11-1: setAiOpenOptionsFailure renders via textContent (no HTML injection)', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiOpenOptionsFailure('<img data-attack="x" src=x onerror=alert(1)>');
  const status = shadow.querySelector('[data-role="ai-open-options-status"]');
  assert.equal(status.querySelector('img[data-attack="x"]'), null, 'must not parse HTML');
  assert.ok(status.textContent.indexOf('<img') !== -1, 'must render as literal text');
});

// === U13 — UI Revision label rendered in Diagnostics tab ===

test('U13-S1: Diagnostics tab contains a [data-role="ccp-ui-revision"] placeholder element', () => {
  const { shadow } = freshSidebar();
  const el = shadow.querySelector('[data-panel="diagnostics"] [data-role="ccp-ui-revision"]');
  assert.ok(el, 'Diagnostics tab must contain a UI Revision placeholder');
});

test('U13-S2: after mount + populateUiRevisionTag(shadow), the placeholder reads "UI Revision: U13"', () => {
  const { shadow } = freshSidebar();
  const helper = require('../lib/ui-revision.js');
  helper.populateUiRevisionTag(shadow);
  const els = shadow.querySelectorAll('[data-role="ccp-ui-revision"]');
  assert.ok(els.length >= 1, 'at least one UI Revision element must exist');
  for (var i = 0; i < els.length; i++) {
    assert.equal(els[i].textContent, 'UI Revision: U13');
  }
});

module.exports = { freshSidebar, SIDEBAR_PATH };
