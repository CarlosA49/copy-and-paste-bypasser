# U12 Safety Correction — Blocked-Page Scan Guard (Three-Layer Fail-Closed + Live-Screenshot Regression)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **No-git-mutation constraint (mirrors U11):** NO `git add`, `git commit`, `git push`, `git reset`, `git checkout`, `git clean`, `git revert`, `git amend`, `git branch`, or worktree cleanup may occur during this pass. The plan therefore contains no commit steps. Verification runs only read-only git (`git rev-parse`, `git status`, `git diff`) and Node tests. HEAD must remain `d1b0d90b2987b2f2bccde5dbc190787acdada155` (the U11 post-execution SHA) at the end of U12.

**Goal:** Close the U11 live-test safety gap where `Scan questions` was clickable on a blocked `/assignment-submission/.../attempt` page and rendered five assessment prompts (`What does BW stand for in communication field?`, etc.) into the local preview. After U12, the rendered sidebar on that URL — and on any other blocked page including visibly-blocked pages where URL/title alone are insufficient — produces ZERO question prompts via native click, programmatic invocation, or any other code path, while preserving U11's Manage AI API Key behavior.

**Architecture:** Defense in depth.
- **Layer 1 — sidebar UI gating:** `lib/sidebar.js` `_renderAiButtonStates()` adds Scan to the eligibility-gated disabled set so the `[data-action="ai-scan"]` button is disabled when `_aiState.eligible === false`.
- **Layer 2 — controller fail-closed:** `lib/ai-answer-controller.js` `performScan()` calls `qc.isCurrentPageBlocked(loc, doc)` BEFORE any `buildQuestionSnapshot` call; on blocked it clears `_activeSnapshot` / `_activeSuggestions` and clears sidebar scan preview / suggestions / surfaces the blocked apply-result message. Disabled UI buttons are presentation; the controller is the actual security boundary against programmatic invocation, stale event handlers, or test code.
- **Layer 3 — question-context defense in depth:** `lib/ai-question-context.js` `buildQuestionSnapshot()` calls `isCurrentPageBlocked()` BEFORE `detectQuestions()` and returns an empty ineligible snapshot. URL/title-detectable pages (e.g. `/assignment-submission/`, `/gradedLti/`, title `"Graded Assignment"`) short-circuit before `detectQuestions` runs at all. Visibly-blocked pages (generic lecture-like URL with current-activity text matching markers like "Graded App Item", "Discussion Prompt", "Graded Quiz", "Programming Assignment", "Peer Review", "Exam") may require `_visibleBlockedReason()` to inspect DOM evidence (which internally walks question containers for evidence-root anchoring) BUT the final returned snapshot still contains zero questions and zero prompt text. Contract: never RETURN, PREVIEW, or TRANSMIT extracted assessment-question content once the page is classified as blocked.
- **Layer 4 — live-screenshot integration regression:** `tests/ai-answer-tab.test.js` exercises the full rendered sidebar + production controller against the live `/assignment-submission/.../attempt` URL with five detectable supported questions in the DOM. Captures the actual screenshot defect as a single end-to-end test and proves it no longer reproduces.

**Tech Stack:** Vanilla JS (MV3 content script + service worker + options page), `node:test`, `jsdom`, no build step.

---

## Scope Guard

- **Production footprint (3 files):** `lib/sidebar.js`, `lib/ai-answer-controller.js`, `lib/ai-question-context.js`.
- **Test footprint (4 files):** `tests/sidebar.test.js`, `tests/ai-answer-controller.test.js`, `tests/ai-question-context.test.js`, `tests/ai-answer-tab.test.js`.
- **No Autopilot file may be touched** (`lib/autopilot-*.js`, `lib/module-*.js`, `lib/item-handlers.js`, `lib/completion-confirmer.js`, and their tests).
- **No U11 surface may be touched unless a failing regression proves otherwise:** `content.js`, `background.js`, `manifest.json`, `lib/sidebar.css`, `lib/ai-open-options-content.js`, `lib/ai-open-options-background.js`.
- **No other AI surface may be touched:** `lib/ai-options-controller.js`, `lib/ai-background-service.js`, `lib/ai-content-listeners.js`, `options.html`, `options.js`.
- No manifest permissions / host_permissions / CSP / web_accessible_resources changes.
- No real API key entered or embedded anywhere.
- No Managed AI Credits backend / portal / balance / purchase / ledger / payment / account / pricing / provider-route work.
- No provider API/model behavior changes.
- No live answer-generation tests.

---

## File Structure

- `lib/sidebar.js` — extend `_renderAiButtonStates()` so that the `[data-action="ai-scan"]` button is disabled when `_aiState.eligible === false` or `_aiState.inFlight` is true. Other buttons untouched. No new exports.
- `lib/ai-answer-controller.js` — modify `performScan()` to invoke `qc.isCurrentPageBlocked(loc, doc)` BEFORE any call to `qc.buildQuestionSnapshot(...)`. On blocked: clear `_activeSnapshot` / `_activeSuggestions` and call `sidebar.setAiPageEligibility(...)`, `sidebar.setAiScanResult(null)`, `sidebar.setAiSuggestions(null)`, `sidebar.setAiApplyResult({ filled: 0, failed: 0, message: 'AI answer filling is disabled on graded or blocked assessment pages.' })`, then return. No new exports.
- `lib/ai-question-context.js` — modify `buildQuestionSnapshot(rootEl, location, doc)` so it computes `blockState = isCurrentPageBlocked(location, doc)` BEFORE doing snapshot construction. On blocked, return an empty ineligible snapshot with `questions: []`, `supportedCount: 0`, `unsupportedCount: 0`, `actionableCount: 0`, `localGuard: []`, the correct `page.eligible: false`, `page.blockedReason: blockState.reason`, and a deterministic blocked-token (`'snap_blocked_' + djb2(<url>)`). `sanitizeForRequest()` is NOT modified — it already returns zero questions when the source snapshot has zero questions. Existing scoped visible-classification behavior (the `findCurrentActivityEvidenceRoot` exclusion logic that avoids false positives from navigation/sidebar labels) is preserved unchanged.
- `tests/sidebar.test.js` — append 4 U12-A tests.
- `tests/ai-answer-controller.test.js` — append 6 U12-B tests.
- `tests/ai-question-context.test.js` — append 11 U12-C tests (5 URL/title-block + 6 visible-marker categories).
- `tests/ai-answer-tab.test.js` — append the live-screenshot integration regression test `U12-LIVE: rendered sidebar on /assignment-submission/.../attempt with five detectable questions refuses scan and preserves U11 behaviors`.

No other file may be modified.

---

## Task 1: RED — Live-screenshot integration regression (`tests/ai-answer-tab.test.js`)

This is the canonical full-stack regression for the live defect. It must be written and run BEFORE any production change so its failure mode mirrors the actual screenshot the user captured.

**Files:**
- Test: `tests/ai-answer-tab.test.js` (append)

- [ ] **Step 1: Inspect the existing fixture**

Open `tests/ai-answer-tab.test.js`. The file already exposes `freshDomWithController(urlOverride)` (around line 183) that mounts production `lib/sidebar.js` + `lib/ai-answer-controller.js` + `lib/ai-question-context.js` + `lib/question-detector.js` + `lib/answer-applier.js` etc., calls `sidebar.mount()`, and returns the JSDOM. Reuse this fixture verbatim — DO NOT shadow it.

- [ ] **Step 2: Append the U12-LIVE integration test**

Append to `tests/ai-answer-tab.test.js`:

```js
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
    // Inject lib/sidebar.css into the shadow root so getComputedStyle resolves
    // the .ccp-ai-card[hidden] { display:none } rule (jsdom does not auto-load
    // the stylesheet referenced by the sidebar mount).
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
```

- [ ] **Step 3: Run the U12-LIVE test and verify it FAILS**

Run: `node --test --test-name-pattern="U12-LIVE" tests/ai-answer-tab.test.js`

Expected on pre-U12 code:
- ASSERTION 1 FAILS — current sidebar status text on initial mount is `Click Scan questions to detect supported unanswered questions on this page.`, not the blocked-page text, because `performScan` had to be called to trigger eligibility flow. (Actually `controller.wire()` does call `isCurrentPageBlocked` once during init and sets eligibility — so this assertion may already pass; verify in the captured RED output. If it passes on pre-U12 code, that's fine — it's a forward-compatible check that becomes load-bearing after Task 5.)
- ASSERTION 2 FAILS — Scan button is currently enabled.
- ASSERTION 6 FAILS — native Scan click currently renders the prompt text `MARKER_Q1` into `[data-role="ai-scan-preview"]` (this is the screenshot defect).
- ASSERTION 7 FAILS — programmatic `controller.performScan()` currently renders the prompt text.
- ASSERTION 8 FAILS — sidebar DOM contains marker prompts after Scan.

ASSERTIONS 3, 4, 5, 9, 10 may already pass (U11 already disables Generate/Apply on blocked, and Manage AI API Key + ccp.ai.openOptions wiring + one-card visibility are U11 fixes). Capture verbatim and confirm at minimum assertions 2, 6, 7, 8 fail before proceeding to Tasks 2–7.

---

## Task 2: RED — Sidebar U12-A tests (Scan disabled on blocked eligibility)

**Files:**
- Test: `tests/sidebar.test.js` (append)

- [ ] **Step 1: Inspect the existing `freshSidebar()` fixture**

Open `tests/sidebar.test.js` and locate `freshSidebar()`. Confirm it returns `{ sidebar, shadow, dom }`. The U11 work already added `freshSidebarWithCss()` which uses the same base. All four U12-A tests use `freshSidebar()`.

- [ ] **Step 2: Append the four U12-A RED tests**

Append to `tests/sidebar.test.js`:

```js
// === U12 Safety — Scan disabled on blocked pages (defense in depth, layer 1) ===

test('U12-A1: setAiPageEligibility({ eligible:false, blockedReason:"graded assignment" }) disables Scan questions', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus({ present: true, remembered: true });
  sidebar.setAiPageEligibility({ eligible: false, blockedReason: 'graded assignment', supportedCount: 0 });
  const scanBtn = shadow.querySelector('[data-action="ai-scan"]');
  assert.ok(scanBtn, 'ai-scan button must exist');
  assert.equal(scanBtn.disabled, true, 'Scan questions must be disabled when eligible === false');
});

test('U12-A2: blocked-eligibility state — Generate and Apply remain disabled while Manage AI API Key remains enabled', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus({ present: true, remembered: true });
  sidebar.setAiPageEligibility({ eligible: false, blockedReason: 'graded assignment', supportedCount: 0 });
  const gen = shadow.querySelector('[data-action="ai-generate"]');
  const apply = shadow.querySelector('[data-action="ai-apply"]');
  const configure = shadow.querySelector('[data-action="ai-key-configure"]');
  assert.equal(gen.disabled, true, 'Generate must remain disabled on blocked page');
  assert.equal(apply.disabled, true, 'Apply must remain disabled on blocked page');
  assert.ok(configure, 'Manage AI API Key button must exist');
  assert.notEqual(configure.disabled, true, 'Manage AI API Key must remain enabled on blocked page');
});

test('U12-A3: native click on disabled Scan does NOT invoke the registered onScan handler', () => {
  const { sidebar, shadow, dom } = freshSidebar();
  sidebar.setAiKeyStatus({ present: true, remembered: true });
  let scanCalls = 0;
  sidebar.setAiAnswerHandlers({ onScan: function () { scanCalls++; } });
  sidebar.setAiPageEligibility({ eligible: false, blockedReason: 'graded assignment', supportedCount: 0 });
  const scanBtn = shadow.querySelector('[data-action="ai-scan"]');
  assert.equal(scanBtn.disabled, true);
  scanBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert.equal(scanCalls, 0, 'onScan must not be invoked when Scan button is disabled');
});

test('U12-A4: restoring eligibility re-enables Scan without altering Manage AI API Key', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus({ present: true, remembered: true });
  sidebar.setAiPageEligibility({ eligible: false, blockedReason: 'graded assignment', supportedCount: 0 });
  const scanBtn = shadow.querySelector('[data-action="ai-scan"]');
  assert.equal(scanBtn.disabled, true, 'precondition: Scan disabled on blocked');
  sidebar.setAiPageEligibility({ eligible: true, blockedReason: null, supportedCount: 1, actionableCount: 1 });
  assert.notEqual(scanBtn.disabled, true, 'Scan must be re-enabled when eligibility is restored');
  const configure = shadow.querySelector('[data-action="ai-key-configure"]');
  assert.notEqual(configure.disabled, true, 'Manage AI API Key must remain enabled throughout');
});
```

- [ ] **Step 3: Run the four U12-A tests and verify they FAIL**

Run: `node --test --test-name-pattern="U12-A" tests/sidebar.test.js`

Expected:
- U12-A1 FAILS: current `_renderAiButtonStates()` does not touch `[data-action="ai-scan"]`.
- U12-A2 should already PASS (Generate/Apply gating exists; Manage button is not disabled by anything in U11).
- U12-A3 FAILS: Scan is enabled so the click fires `onScan` and `scanCalls === 1`.
- U12-A4 FAILS at the precondition (Scan was never disabled).

Capture verbatim.

---

## Task 3: GREEN — Sidebar: disable Scan when eligible === false

**Files:**
- Modify: `lib/sidebar.js` (`_renderAiButtonStates`, currently around lines 1059–1081)

- [ ] **Step 1: Add Scan to the disabled-button set inside `_renderAiButtonStates()`**

Open `lib/sidebar.js`. Find `_renderAiButtonStates()`. Insert a `scan` query and a single disabled-state assignment immediately after the existing `const gen / cancel / apply` queries. The full updated function becomes:

```js
  function _renderAiButtonStates() {
    if (!shadow) return;
    const scan = shadow.querySelector('[data-action="ai-scan"]');
    const gen = shadow.querySelector('[data-action="ai-generate"]');
    const cancel = shadow.querySelector('[data-action="ai-cancel"]');
    const apply = shadow.querySelector('[data-action="ai-apply"]');
    if (scan) {
      scan.disabled = !!(_aiState.eligible === false || _aiState.inFlight);
    }
    if (gen) {
      var actionable = _aiState.snapshot ? (_aiState.snapshot.actionableCount || 0) : 0;
      gen.disabled = !!(
        !_aiState.keyPresent ||
        _aiState.eligible === false ||
        !_aiState.snapshot ||
        actionable === 0 ||
        _aiState.inFlight
      );
    }
    if (cancel) {
      cancel.hidden = !_aiState.inFlight;
      cancel.disabled = !_aiState.inFlight;
    }
    if (apply) apply.disabled = !(
      _aiState.suggestions && _aiState.suggestions.length > 0 && _aiState.eligible !== false
    );
  }
```

Notes:
- `_aiState.eligible === false` is strict — when `eligible` is `null` (initial), Scan stays enabled (matches existing behavior on a freshly mounted page where the controller has not yet checked).
- `_aiState.inFlight` is included so Scan is also disabled during an in-flight Generate; preserves implicit current safety behavior without accidentally re-enabling Scan in any state where it should be disabled.

- [ ] **Step 2: Re-run U12-A tests and verify PASS**

Run: `node --test --test-name-pattern="U12-A" tests/sidebar.test.js`
Expected: all four U12-A tests PASS.

- [ ] **Step 3: Run the full sidebar test file (regression)**

Run: `node --test tests/sidebar.test.js`
Expected: every test PASSES. Pre-existing tests that click Scan after `setAiPageEligibility({ eligible: true, ... })` must continue to work because Scan stays enabled when `eligible !== false`.

---

## Task 4: RED — Controller U12-B tests (`performScan` fail-closed + stale-state clearing + post-blocked-scan refusal)

**Files:**
- Test: `tests/ai-answer-controller.test.js` (append)

This task EXPANDS the controller coverage to six contracts: (1) `isCurrentPageBlocked` called before `buildQuestionSnapshot`, (2) sidebar scan preview cleared via `setAiScanResult(null)` with blocked apply-result, (3) stale safe-page preview cleared on SPA navigation to blocked, (4) prior suggestions cleared on blocked scan, (5) `_activeSnapshot` left null so subsequent Generate and Apply remain refused, (6) Manage AI API Key remains independent and usable.

- [ ] **Step 1: Inspect the existing controller fixture**

Open `tests/ai-answer-controller.test.js`. U11 already provides `makeBlockedPageFakeSidebar()` and the standard `createAiController` import. Reuse them.

- [ ] **Step 2: Append the six U12-B RED tests**

Append to `tests/ai-answer-controller.test.js`:

```js
// === U12 Safety — controller refuses scan on blocked page (defense in depth, layer 2) ===

function makeU12LocAndDoc(blockedPath) {
  return {
    loc: {
      href: 'https://www.coursera.org' + blockedPath,
      pathname: blockedPath,
      origin: 'https://www.coursera.org',
    },
    doc: { body: {}, querySelector: function () { return null; } },
  };
}

test('U12-B1: performScan on /assignment-submission/.../attempt URL calls isCurrentPageBlocked BEFORE buildQuestionSnapshot (snapshot construction never reached)', () => {
  const { loc, doc } = makeU12LocAndDoc('/learn/wireless-communications/assignment-submission/fryRH/practice-quiz-for-introduction-and-history-of-cellular-communication-systems/attempt');
  let isBlockedCalls = 0;
  let buildSnapshotCalls = 0;
  const qc = {
    buildQuestionSnapshot: function () { buildSnapshotCalls++; throw new Error('buildQuestionSnapshot MUST NOT be called on a blocked page'); },
    sanitizeForRequest: function (s) { return s; },
    isCurrentPageBlocked: function () { isBlockedCalls++; return { blocked: true, reason: 'assignment-submission' }; },
    compareLocalGuards: function () { return { changed: false }; },
  };
  const fakeSidebar = makeBlockedPageFakeSidebar();
  const sentCommands = [];
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: qc,
    validator: { validateAndMap: function () { throw new Error('validator must not run on blocked scan'); } },
    answerApplier: { applyStructuredAnswers: function () { throw new Error('answerApplier must not run on blocked scan'); } },
    messenger: { send: function (cmd, p, cb) { sentCommands.push({ cmd: cmd, params: p }); if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: true, accessMode: 'personal-key' }); cb({ ok: true }); } },
    document: doc, location: loc,
    openOptionsFn: function (cb) { if (cb) cb({ ok: true }); },
  });
  ctrl.wire();
  assert.doesNotThrow(function () { ctrl.performScan(); },
    'performScan must NOT throw on a blocked page — it must refuse cleanly');
  assert.ok(isBlockedCalls >= 1, 'isCurrentPageBlocked must be invoked at least once by performScan');
  assert.equal(buildSnapshotCalls, 0, 'buildQuestionSnapshot must NOT be reached on a blocked page');
  const generateCalls = sentCommands.filter(function (c) { return c.cmd === 'generateAnswers'; });
  assert.equal(generateCalls.length, 0, 'generateAnswers must not be sent during a blocked scan');
});

test('U12-B2: blocked performScan calls sidebar.setAiScanResult(null) and surfaces the blocked-page apply-result message', () => {
  const { loc, doc } = makeU12LocAndDoc('/learn/x/assignment-submission/abc/attempt');
  const scanResults = []; const suggestionsCalls = []; const applyResultCalls = []; const eligibilityCalls = [];
  const qc = {
    buildQuestionSnapshot: function () { throw new Error('buildQuestionSnapshot MUST NOT be called on a blocked page'); },
    sanitizeForRequest: function (s) { return s; },
    isCurrentPageBlocked: function () { return { blocked: true, reason: 'assignment-submission' }; },
    compareLocalGuards: function () { return { changed: false }; },
  };
  const fakeSidebar = (function () {
    const base = makeBlockedPageFakeSidebar();
    const o1 = base.setAiScanResult, o2 = base.setAiSuggestions, o3 = base.setAiApplyResult, o4 = base.setAiPageEligibility;
    base.setAiScanResult       = function (v) { scanResults.push(v);     if (o1) o1(v); };
    base.setAiSuggestions      = function (v) { suggestionsCalls.push(v); if (o2) o2(v); };
    base.setAiApplyResult      = function (v) { applyResultCalls.push(v); if (o3) o3(v); };
    base.setAiPageEligibility  = function (v) { eligibilityCalls.push(v); if (o4) o4(v); };
    return base;
  })();
  const ctrl = createAiController({
    sidebar: fakeSidebar, questionContext: qc,
    validator: { validateAndMap: function () { return { ok: true, suggestions: [] }; } },
    answerApplier: { applyStructuredAnswers: function () { throw new Error('answerApplier must not run on blocked scan'); } },
    messenger: { send: function (cmd, p, cb) { if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: true, accessMode: 'personal-key' }); cb({ ok: true }); } },
    document: doc, location: loc,
    openOptionsFn: function (cb) { if (cb) cb({ ok: true }); },
  });
  ctrl.wire();
  ctrl.performScan();
  const lastElig = eligibilityCalls[eligibilityCalls.length - 1];
  assert.ok(lastElig, 'setAiPageEligibility must be called');
  assert.equal(lastElig.eligible, false);
  assert.equal(lastElig.blockedReason, 'assignment-submission');
  assert.ok(scanResults.indexOf(null) !== -1, 'setAiScanResult(null) must be called to clear the scan preview');
  assert.ok(suggestionsCalls.indexOf(null) !== -1, 'setAiSuggestions(null) must be called to clear suggestions');
  const sawBlockedMsg = applyResultCalls.some(function (r) { return r && typeof r === 'object' && /disabled on graded or blocked assessment pages/i.test(r.message || ''); });
  assert.ok(sawBlockedMsg, 'apply result must be set to the blocked-page message');
});

test('U12-B3: stale safe-page preview is cleared when SPA navigates to a blocked page and Scan is invoked again', () => {
  // First scan on an eligible page populates _activeSnapshot + sidebar scan preview.
  let blocked = false;
  const goodSnap = { token: 'snap_good', page: { eligible: true, blockedReason: null }, questions: [{ id: 'q1', order: 1, questionNumber: 1, type: 'single_choice', prompt: 'PROMPT-TEXT-MUST-NOT-LINGER', supported: true, alreadyAnswered: false, options: [] }], supportedCount: 1, unsupportedCount: 0, actionableCount: 1, localGuard: [] };
  const qc = {
    buildQuestionSnapshot: function () { if (blocked) throw new Error('buildQuestionSnapshot MUST NOT be called when blocked'); return goodSnap; },
    sanitizeForRequest: function (s) { return s; },
    isCurrentPageBlocked: function () { return blocked ? { blocked: true, reason: 'assignment-submission' } : { blocked: false, reason: null }; },
    compareLocalGuards: function () { return { changed: false }; },
  };
  const scanResults = [];
  const fakeSidebar = (function () {
    const base = makeBlockedPageFakeSidebar();
    const o = base.setAiScanResult;
    base.setAiScanResult = function (v) { scanResults.push(v); if (o) o(v); };
    return base;
  })();
  const loc = { href: 'https://www.coursera.org/learn/x/lecture/v1/intro', pathname: '/learn/x/lecture/v1/intro', origin: 'https://www.coursera.org' };
  const ctrl = createAiController({
    sidebar: fakeSidebar, questionContext: qc,
    validator: { validateAndMap: function () { return { ok: true, suggestions: [] }; } },
    answerApplier: { applyStructuredAnswers: function () { throw new Error('must not apply on blocked'); } },
    messenger: { send: function (cmd, p, cb) { if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: true, accessMode: 'personal-key' }); cb({ ok: true }); } },
    document: { body: {}, querySelector: function () { return null; } }, location: loc,
    openOptionsFn: function (cb) { if (cb) cb({ ok: true }); },
  });
  ctrl.wire();
  ctrl.performScan();
  // After eligible scan, the latest setAiScanResult call carries the good snapshot.
  assert.equal(scanResults[scanResults.length - 1].token, 'snap_good', 'precondition: eligible scan populated the preview');
  // Now SPA-navigate to a blocked URL (mutate href + pathname; same loc object).
  blocked = true;
  loc.href = 'https://www.coursera.org/learn/x/assignment-submission/abc/attempt';
  loc.pathname = '/learn/x/assignment-submission/abc/attempt';
  ctrl.performScan();
  // The most recent setAiScanResult call after the blocked scan must be null.
  assert.equal(scanResults[scanResults.length - 1], null, 'blocked scan must clear stale safe-page preview via setAiScanResult(null)');
});

test('U12-B4: blocked performScan creates no usable _activeSnapshot — subsequent performGenerate refuses without sending generateAnswers', () => {
  const { loc, doc } = makeU12LocAndDoc('/learn/x/assignment-submission/abc/attempt');
  const sentCommands = [];
  const qc = {
    buildQuestionSnapshot: function () { throw new Error('buildQuestionSnapshot must not be called on a blocked page'); },
    sanitizeForRequest: function (s) { return s; },
    isCurrentPageBlocked: function () { return { blocked: true, reason: 'assignment-submission' }; },
    compareLocalGuards: function () { return { changed: false }; },
  };
  const fakeSidebar = makeBlockedPageFakeSidebar();
  const ctrl = createAiController({
    sidebar: fakeSidebar, questionContext: qc,
    validator: { validateAndMap: function () { return { ok: true, suggestions: [] }; } },
    answerApplier: { applyStructuredAnswers: function () { throw new Error('must not apply'); } },
    messenger: { send: function (cmd, p, cb) { sentCommands.push({ cmd: cmd, params: p }); if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: true, accessMode: 'personal-key' }); cb({ ok: true }); } },
    document: doc, location: loc,
    openOptionsFn: function (cb) { if (cb) cb({ ok: true }); },
  });
  ctrl.wire();
  ctrl.performScan();
  // Even after the blocked scan, attempting Generate must not send generateAnswers.
  ctrl.performGenerate();
  const genCalls = sentCommands.filter(function (c) { return c.cmd === 'generateAnswers'; });
  assert.equal(genCalls.length, 0, 'no generateAnswers must be sent after a blocked scan');
});

test('U12-B5: blocked performScan leaves Apply in a refused state — answerApplier.applyStructuredAnswers is never called', () => {
  const { loc, doc } = makeU12LocAndDoc('/learn/x/assignment-submission/abc/attempt');
  let applyCalls = 0;
  const qc = {
    buildQuestionSnapshot: function () { throw new Error('buildQuestionSnapshot must not be called on a blocked page'); },
    sanitizeForRequest: function (s) { return s; },
    isCurrentPageBlocked: function () { return { blocked: true, reason: 'assignment-submission' }; },
    compareLocalGuards: function () { return { changed: false }; },
  };
  const ctrl = createAiController({
    sidebar: makeBlockedPageFakeSidebar(), questionContext: qc,
    validator: { validateAndMap: function () { return { ok: true, suggestions: [] }; } },
    answerApplier: { applyStructuredAnswers: function () { applyCalls++; throw new Error('answerApplier.applyStructuredAnswers MUST NOT be called on a blocked page'); } },
    messenger: { send: function (cmd, p, cb) { if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: true, accessMode: 'personal-key' }); cb({ ok: true }); } },
    document: doc, location: loc,
    openOptionsFn: function (cb) { if (cb) cb({ ok: true }); },
  });
  ctrl.wire();
  ctrl.performScan();
  ctrl.performApply();
  assert.equal(applyCalls, 0, 'answerApplier.applyStructuredAnswers MUST NOT be called on a blocked page');
});

test('U12-B6: blocked performScan does NOT affect Manage AI API Key — openOptionsFn still produces exactly one sanitized open-options invocation per click', () => {
  const { loc, doc } = makeU12LocAndDoc('/learn/x/assignment-submission/abc/attempt');
  let openOptionsCalls = 0;
  const qc = {
    buildQuestionSnapshot: function () { throw new Error('must not call buildQuestionSnapshot'); },
    sanitizeForRequest: function (s) { return s; },
    isCurrentPageBlocked: function () { return { blocked: true, reason: 'assignment-submission' }; },
    compareLocalGuards: function () { return { changed: false }; },
  };
  const fakeSidebar = makeBlockedPageFakeSidebar();
  const ctrl = createAiController({
    sidebar: fakeSidebar, questionContext: qc,
    validator: { validateAndMap: function () { return { ok: true, suggestions: [] }; } },
    answerApplier: { applyStructuredAnswers: function () { throw new Error('must not apply'); } },
    messenger: { send: function (cmd, p, cb) { if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: true, accessMode: 'personal-key' }); cb({ ok: true }); } },
    document: doc, location: loc,
    openOptionsFn: function (cb) { openOptionsCalls++; if (cb) cb({ ok: true }); },
  });
  ctrl.wire();
  ctrl.performScan(); // blocked
  // Open settings from the blocked-page sidebar (via the handler the controller wired).
  fakeSidebar._getHandlers().onOpenOptions();
  assert.equal(openOptionsCalls, 1, 'Manage AI API Key must still issue exactly one sanitized open-options invocation');
  // Failure/clear sequence: success path clears prior failure feedback.
  assert.equal(fakeSidebar._getLastOpenOptionsFailure(), '', 'success path clears prior failure feedback');
});
```

- [ ] **Step 3: Run U12-B tests and verify FAIL**

Run: `node --test --test-name-pattern="U12-B" tests/ai-answer-controller.test.js`
Expected:
- U12-B1 FAILS: `performScan` currently calls `buildQuestionSnapshot` first; the throwing stub raises, `assert.doesNotThrow` fails, `buildSnapshotCalls === 1` not `0`.
- U12-B2 FAILS for the same reason — the throw escapes before any setAi* clears happen.
- U12-B3 FAILS: the blocked branch is not implemented, so on the second scan `setAiScanResult` either still carries `snap_good` (if the throw is caught upstream) or the test throws.
- U12-B4 FAILS: after the throwing scan, `_activeSnapshot` may end up in an undefined state; verify exact failure mode.
- U12-B5 FAILS similarly.
- U12-B6 may already pass (open-options is independent of scan). Capture exact pre-fix status.

Capture verbatim. At minimum B1–B3 must FAIL before proceeding.

---

## Task 5: GREEN — Controller: `performScan` fail-closed guard + clear sequence

**Files:**
- Modify: `lib/ai-answer-controller.js` (`performScan`, currently lines 37–50)

- [ ] **Step 1: Add the blocked-page guard at the top of `performScan()`**

Open `lib/ai-answer-controller.js`. Replace the current `performScan()` body with:

```js
    function performScan() {
      // U12 Layer 2 — fail-closed guard: refuse blocked pages BEFORE building a snapshot.
      // Disabled UI buttons are not the security boundary; programmatic invocation, stale
      // event handlers, or tests may still call performScan() directly. This must short-
      // circuit before any call to buildQuestionSnapshot/validator/answerApplier/messenger.
      var block = qc.isCurrentPageBlocked(loc, doc);
      if (block && block.blocked) {
        _activeSnapshot = null;
        _activeSuggestions = null;
        sidebar.setAiPageEligibility({
          eligible: false,
          blockedReason: block.reason,
          supportedCount: 0,
          actionableCount: 0,
        });
        sidebar.setAiScanResult(null);
        sidebar.setAiSuggestions(null);
        sidebar.setAiApplyResult({ filled: 0, failed: 0, message: 'AI answer filling is disabled on graded or blocked assessment pages.' });
        return;
      }
      var snap = qc.buildQuestionSnapshot(doc.body, loc, doc);
      _activeSnapshot = snap;
      _activeSuggestions = null;
      sidebar.setAiPageEligibility({
        eligible: snap.page.eligible,
        blockedReason: snap.page.blockedReason,
        supportedCount: snap.supportedCount,
        actionableCount: snap.actionableCount,
      });
      sidebar.setAiScanResult(snap);
      sidebar.setAiSuggestions(null);
      sidebar.setAiApplyResult(null);
    }
```

Notes:
- Uses the existing `qc.isCurrentPageBlocked(loc, doc)` API — no new exports.
- The blocked-page message string is the EXACT literal already present at `lib/ai-answer-controller.js:63` (performGenerate) and `:109` (performApply). Three call sites with the identical literal is acceptable for U12's small surface; the U12-B2 test pins the message via regex `/disabled on graded or blocked assessment pages/i`.
- Eligibility object shape matches what `performGenerate` already produces on the blocked branch.
- `_activeSnapshot = null` and `_activeSuggestions = null` make subsequent `performGenerate`/`performApply` early-return on their existing `if (!_activeSnapshot) return;` and `if (!_activeSnapshot || !_activeSuggestions) return;` guards (lines 53, 102) — those guards remain unchanged.

- [ ] **Step 2: Run U12-B tests and verify PASS**

Run: `node --test --test-name-pattern="U12-B" tests/ai-answer-controller.test.js`
Expected: all six U12-B tests PASS.

- [ ] **Step 3: Run the full controller test file (regression)**

Run: `node --test tests/ai-answer-controller.test.js`
Expected: every test PASSES (including the existing U11 integration tests, S-series tests, and the new U12-B tests).

---

## Task 6: RED — Question-context U12-C tests (fail-closed `buildQuestionSnapshot` for URL/title-blocked AND visibly-blocked pages)

**Files:**
- Test: `tests/ai-question-context.test.js` (append)

This task EXPANDS the question-context coverage to eleven tests: five for URL/title-blocked + sanitize/regression cases (C1–C5), plus six visible-block marker categories (C6–C11) where a generic lecture-like URL has detectable questions PLUS current-activity text containing a blocked marker.

- [ ] **Step 1: Inspect the existing fixture**

Open `tests/ai-question-context.test.js`. The file already has `doc(html, url)` (constructs a JSDOM at the given URL) and `radio(qNum, choices)` (emits a single-choice question section). Reuse them.

- [ ] **Step 2: Append the eleven U12-C RED tests**

Append to `tests/ai-question-context.test.js`:

```js
// === U12 Safety — buildQuestionSnapshot fail-closed on blocked pages (layer 3) ===

test('U12-C1: buildQuestionSnapshot on /assignment-submission/.../attempt URL returns empty ineligible snapshot even when questions are detectable in the DOM', () => {
  const blockedUrl = 'https://www.coursera.org/learn/wireless-communications/assignment-submission/fryRH/practice-quiz-for-introduction-and-history-of-cellular-communication-systems/attempt';
  const html = radio(1, ['Alpha', 'Beta', 'Gamma']) + radio(2, ['One', 'Two']) + radio(3, ['X', 'Y']);
  const d = doc(html, blockedUrl);
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false, 'page.eligible must be false on a blocked URL');
  assert.ok(snap.page.blockedReason, 'page.blockedReason must be set');
  assert.equal(snap.questions.length, 0, 'questions must be empty on a blocked URL (no prompt text leaks)');
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.unsupportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, [], 'localGuard must be empty on a blocked URL');
});

test('U12-C2: buildQuestionSnapshot on /gradedLti/ URL returns empty ineligible snapshot even when questions are detectable', () => {
  const d = doc(radio(1, ['A', 'B']), 'https://www.coursera.org/learn/course/gradedLti/abc/xyz');
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false);
  assert.equal(snap.questions.length, 0);
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, []);
});

test('U12-C3: buildQuestionSnapshot on title-only-blocked page ("Graded Assignment") returns empty ineligible snapshot', () => {
  const d = doc(radio(1, ['A', 'B']), 'https://www.coursera.org/learn/course/lecture/v1/intro');
  d.document.title = 'Graded Assignment';
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false, 'title block must be honored even on a lecture-style URL');
  assert.equal(snap.questions.length, 0, 'title block must NOT leak prompt text');
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, []);
});

test('U12-C4: sanitizeForRequest on a blocked snapshot returns zero questions and is safe to send (no prompt leakage)', () => {
  const blockedUrl = 'https://www.coursera.org/learn/x/assignment-submission/abc/attempt';
  const html = radio(1, ['Detected prompt text that must never leave the client', 'Other']);
  const d = doc(html, blockedUrl);
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  const sanitized = ctx.sanitizeForRequest(snap);
  assert.equal(sanitized.questions.length, 0, 'sanitized payload must contain zero questions on a blocked page');
  const payload = JSON.stringify(sanitized);
  assert.equal(payload.indexOf('Detected prompt text'), -1, 'no prompt option text may appear in the sanitized payload');
  assert.equal(sanitized.page.eligible, false);
});

test('U12-C5: REGRESSION — buildQuestionSnapshot on an eligible lecture URL still detects questions (fail-closed must not break legitimate paths)', () => {
  const d = doc(radio(1, ['Alpha', 'Beta', 'Gamma']), 'https://www.coursera.org/learn/course/lecture/v1/intro');
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, true, 'lecture URL must remain eligible');
  assert.equal(snap.questions.length, 1, 'eligible page must still detect questions');
  assert.equal(snap.supportedCount, 1);
  assert.equal(snap.actionableCount, 1);
});

// --- VISIBLY-BLOCKED PAGES: generic lecture-like URL + current-activity text marker ---
// These tests use a generic lecture URL so URL/title classification does NOT trigger
// the block. The block must be detected via DOM evidence inside the current-activity
// region. The final returned snapshot must still expose zero prompts.

function visibleBlockedDoc(markerText, lectureUrl) {
  // Generic lecture-like URL by default (chosen so blockReasonFor's URL fallback
  // does NOT match 'graded assignment').
  const url = lectureUrl || 'https://www.coursera.org/learn/course/lecture/v1/intro';
  // The marker text MUST be inside <main> (which findCurrentActivityEvidenceRoot
  // returns as the activity root when no detected question container yields one
  // higher than body — Priority 2 in findCurrentActivityEvidenceRoot).
  const PROMPT_MARKER = 'PROMPT_TEXT_THAT_MUST_NEVER_LEAK_' + markerText.replace(/\s+/g, '_').toUpperCase();
  const html = '<main>'
    + '<h1>' + markerText + '</h1>'
    + '<section><h3>Question 1</h3><p>' + PROMPT_MARKER + '</p>'
    + '<label><input type="radio" name="r1">Alpha</label>'
    + '<label><input type="radio" name="r1">Beta</label>'
    + '</section>'
    + '</main>';
  const d = doc(html, url);
  return { d: d, PROMPT_MARKER: PROMPT_MARKER };
}

test('U12-C6: VISIBLE BLOCK — current-activity contains "Graded App Item" → snapshot is empty and contains no prompt text', () => {
  const { d, PROMPT_MARKER } = visibleBlockedDoc('Graded App Item');
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false);
  assert.ok(snap.page.blockedReason && /graded\s+app\s+item/i.test(snap.page.blockedReason), 'blockedReason must categorize as graded app item (got: ' + JSON.stringify(snap.page.blockedReason) + ')');
  assert.equal(snap.questions.length, 0);
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, []);
  const sanitized = ctx.sanitizeForRequest(snap);
  assert.equal(sanitized.questions.length, 0);
  const blob = JSON.stringify(snap) + JSON.stringify(sanitized);
  assert.equal(blob.indexOf(PROMPT_MARKER), -1, 'prompt text marker must not appear in snapshot or sanitized output');
});

test('U12-C7: VISIBLE BLOCK — current-activity contains "Discussion Prompt" → snapshot is empty and contains no prompt text', () => {
  const { d, PROMPT_MARKER } = visibleBlockedDoc('Discussion Prompt');
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false);
  assert.ok(snap.page.blockedReason && /discussion\s+prompt/i.test(snap.page.blockedReason));
  assert.equal(snap.questions.length, 0);
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, []);
  const sanitized = ctx.sanitizeForRequest(snap);
  assert.equal(sanitized.questions.length, 0);
  const blob = JSON.stringify(snap) + JSON.stringify(sanitized);
  assert.equal(blob.indexOf(PROMPT_MARKER), -1);
});

test('U12-C8: VISIBLE BLOCK — current-activity contains "Graded Quiz" → snapshot is empty and contains no prompt text', () => {
  const { d, PROMPT_MARKER } = visibleBlockedDoc('Graded Quiz');
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false);
  assert.ok(snap.page.blockedReason && /graded\s+quiz/i.test(snap.page.blockedReason));
  assert.equal(snap.questions.length, 0);
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, []);
  const sanitized = ctx.sanitizeForRequest(snap);
  assert.equal(sanitized.questions.length, 0);
  const blob = JSON.stringify(snap) + JSON.stringify(sanitized);
  assert.equal(blob.indexOf(PROMPT_MARKER), -1);
});

test('U12-C9: VISIBLE BLOCK — current-activity contains "Programming Assignment" → snapshot is empty and contains no prompt text', () => {
  const { d, PROMPT_MARKER } = visibleBlockedDoc('Programming Assignment');
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false);
  assert.ok(snap.page.blockedReason && /programming\s+assignment/i.test(snap.page.blockedReason));
  assert.equal(snap.questions.length, 0);
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, []);
  const sanitized = ctx.sanitizeForRequest(snap);
  assert.equal(sanitized.questions.length, 0);
  const blob = JSON.stringify(snap) + JSON.stringify(sanitized);
  assert.equal(blob.indexOf(PROMPT_MARKER), -1);
});

test('U12-C10: VISIBLE BLOCK — current-activity contains "Peer Review" → snapshot is empty and contains no prompt text', () => {
  const { d, PROMPT_MARKER } = visibleBlockedDoc('Peer Review');
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false);
  assert.ok(snap.page.blockedReason && /peer\s+review/i.test(snap.page.blockedReason));
  assert.equal(snap.questions.length, 0);
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, []);
  const sanitized = ctx.sanitizeForRequest(snap);
  assert.equal(sanitized.questions.length, 0);
  const blob = JSON.stringify(snap) + JSON.stringify(sanitized);
  assert.equal(blob.indexOf(PROMPT_MARKER), -1);
});

test('U12-C11: VISIBLE BLOCK — current-activity contains "Exam" → snapshot is empty and contains no prompt text', () => {
  const { d, PROMPT_MARKER } = visibleBlockedDoc('Exam');
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.page.eligible, false);
  assert.ok(snap.page.blockedReason && /exam/i.test(snap.page.blockedReason));
  assert.equal(snap.questions.length, 0);
  assert.equal(snap.supportedCount, 0);
  assert.equal(snap.actionableCount, 0);
  assert.deepEqual(snap.localGuard, []);
  const sanitized = ctx.sanitizeForRequest(snap);
  assert.equal(sanitized.questions.length, 0);
  const blob = JSON.stringify(snap) + JSON.stringify(sanitized);
  assert.equal(blob.indexOf(PROMPT_MARKER), -1);
});
```

Notes on the visible-block fixture:
- Each visibly-blocked test uses a generic lecture URL `https://www.coursera.org/learn/course/lecture/v1/intro` so `blockReasonFor(url, title)` returns `'blocked'` ONLY if URL/title patterns match — they do not for this URL. The marker text is the ONLY signal.
- The marker text is placed inside `<main>` so `findCurrentActivityEvidenceRoot` (Priority 2) returns the `<main>` as the evidence root.
- The prompt-text marker (e.g. `PROMPT_TEXT_THAT_MUST_NEVER_LEAK_GRADED_APP_ITEM`) is placed inside a detectable question container. The contract assertion is that this marker does NOT appear anywhere in the snapshot JSON or sanitized JSON.
- The existing `findCurrentActivityEvidenceRoot` exclusion logic (ASIDE, NAV, role=navigation, sidebar/drawer/outline classnames) is preserved by the GREEN step — `buildQuestionSnapshot` calls `isCurrentPageBlocked` which calls `_visibleBlockedReason` which uses the existing evidence-root walk. We do not change that walker; we only add the early-return after the block is classified.

- [ ] **Step 3: Run U12-C tests and verify FAIL**

Run: `node --test --test-name-pattern="U12-C" tests/ai-question-context.test.js`
Expected:
- C1–C4 FAIL: `snap.questions.length > 0` (the URL/title block reason is attached to `page.blockedReason` but questions are still produced by `detectQuestions`).
- C5 PASSES (regression baseline for the GREEN step to defend).
- C6–C11 FAIL: each visible-block fixture produces a non-empty `questions` array containing the prompt marker — the leak the test is designed to catch.

Capture verbatim.

---

## Task 7: GREEN — Question-context: `buildQuestionSnapshot` fail-closed

**Files:**
- Modify: `lib/ai-question-context.js` (`buildQuestionSnapshot`, currently lines 219–282)

- [ ] **Step 1: Move the block check BEFORE snapshot construction and short-circuit for blocked pages**

Open `lib/ai-question-context.js`. Replace the current `buildQuestionSnapshot` with:

```js
  function buildQuestionSnapshot(rootEl, location, doc) {
    var origin = (location && location.origin) || '';
    // U12 Layer 3 — fail-closed: determine blocked state BEFORE constructing the
    // question snapshot. For URL/title-detectable pages this short-circuits
    // before any detectQuestions(rootEl) call. For visibly-blocked pages,
    // _visibleBlockedReason internally walks the current-activity evidence root
    // (which may include question containers) to CLASSIFY the page — but the
    // returned snapshot still exposes zero question prompts. Contract: never
    // RETURN, PREVIEW, or TRANSMIT extracted assessment-question content once
    // the page is classified as blocked.
    var blockState = isCurrentPageBlocked(location, doc);
    if (blockState && blockState.blocked) {
      var blockedTokenSeed = JSON.stringify(['blocked', (location && location.href) || '']);
      return {
        token: 'snap_blocked_' + djb2(blockedTokenSeed),
        page: {
          urlOrigin: origin,
          eligible: false,
          blockedReason: blockState.reason,
        },
        questions: [],
        supportedCount: 0,
        unsupportedCount: 0,
        actionableCount: 0,
        localGuard: [],
      };
    }
    var detected = (questionDetector && questionDetector.detectQuestions)
      ? questionDetector.detectQuestions(rootEl) : [];

    var questions = [];
    for (var i = 0; i < detected.length; i++) {
      var q = detected[i];
      var id = 'q' + q.questionNumber;
      var supported = !!SUPPORTED_TYPES[q.type];
      var prompt = (q.fullText || q.titleText || '').toString().slice(0, 500);
      var entry = {
        id: id,
        order: i + 1,
        questionNumber: q.questionNumber,
        type: q.type,
        prompt: prompt,
        supported: supported,
        alreadyAnswered: isAlreadyAnswered(q),
      };
      if (q.type === 'single_choice' || q.type === 'multiple_choice') {
        entry.options = (q.choices || []).map(function (c, idx) {
          return { id: id + 'o' + idx, label: (c.text || '').toString().slice(0, 200) };
        });
      } else if (q.type === 'math_input') {
        entry.answerFormatHint = 'number-or-text';
      }
      questions.push(entry);
    }

    var supportedCount = 0, unsupportedCount = 0, actionableCount = 0;
    for (var k = 0; k < questions.length; k++) {
      if (questions[k].supported) {
        supportedCount++;
        if (!questions[k].alreadyAnswered) actionableCount++;
      } else {
        unsupportedCount++;
      }
    }

    var tokenSeed = JSON.stringify([
      (location && location.href) || '',
      questions.map(function (e) {
        return [e.questionNumber, e.type, e.prompt, (e.options || []).map(function (o) { return o.label; })];
      })
    ]);

    var localGuard = _buildLocalGuard(detected);

    return {
      token: 'snap_' + djb2(tokenSeed),
      page: {
        urlOrigin: origin,
        eligible: !blockState.blocked,
        blockedReason: blockState.reason,
      },
      questions: questions,
      supportedCount: supportedCount,
      unsupportedCount: unsupportedCount,
      actionableCount: actionableCount,
      localGuard: localGuard,
    };
  }
```

Notes:
- The blocked branch returns BEFORE invoking `detectQuestions(rootEl)` from this function. The `_visibleBlockedReason` path internally walks the activity-root via `findCurrentActivityEvidenceRoot` — which itself calls `detectQuestions(doc.body)` to find a question-container anchor (Priority 1) — but only for classification. The returned snapshot has zero questions and zero prompt text, satisfying the user's contract: "never RETURN, PREVIEW, or TRANSMIT extracted assessment-question content once blocked."
- The token shape `'snap_blocked_' + djb2(...)` is deterministic per URL and distinct from the normal `'snap_' + djb2(...)` so stale-snapshot comparisons in `performGenerate` / `performApply` will correctly detect a blocked→unblocked transition.
- `sanitizeForRequest()` is unchanged; it already iterates `snapshot.questions` and produces an empty `clean` array when the source is empty — Tests C4, C6–C11 leverage this.
- The non-blocked path is unchanged below the early return (preserves lecture/practice behavior — Test C5 defends this).
- `findCurrentActivityEvidenceRoot` and its exclusion logic for ASIDE/NAV/role=navigation/sidebar-classnames is NOT modified — that scoped visible-classification behavior continues to protect against false positives from navigation/sidebar labels.

- [ ] **Step 2: Run U12-C tests and verify PASS**

Run: `node --test --test-name-pattern="U12-C" tests/ai-question-context.test.js`
Expected: all eleven U12-C tests PASS (C1–C5 URL/title + sanitize + lecture regression; C6–C11 visible-marker categories).

- [ ] **Step 3: Run the full question-context test file (regression)**

Run: `node --test tests/ai-question-context.test.js`
Expected: every test PASSES. Pre-existing tests around `isCurrentPageBlocked`, eligible lecture snapshots, sanitize, and `compareLocalGuards` must remain green.

- [ ] **Step 4: Cross-suite regression — re-run sidebar and controller tests**

Run: `node --test tests/sidebar.test.js tests/ai-answer-controller.test.js tests/ai-question-context.test.js`
Expected: all PASS.

---

## Task 8: VERIFY — U12-LIVE integration test now PASSES + Final verification

**Files:** (verification only — no edits)

- [ ] **Step 1: Re-run the U12-LIVE integration regression (added in Task 1)**

Run: `node --test --test-name-pattern="U12-LIVE" tests/ai-answer-tab.test.js`
Expected: ALL 10 assertions PASS. This is the canonical proof that the live-screenshot defect no longer reproduces against the full rendered workflow. If any assertion still fails, do NOT proceed — diagnose which layer (sidebar/controller/question-context) is incomplete and fix.

- [ ] **Step 2: Focused U12 + related test suite**

Run:

```
node --test tests/sidebar.test.js tests/ai-answer-controller.test.js tests/ai-question-context.test.js tests/ai-answer-tab.test.js tests/ai-options-controller.test.js tests/ai-background-service.test.js tests/ai-content-listeners.test.js tests/ai-open-options-content.test.js tests/ai-open-options-background.test.js
```

Expected: every test PASSES.

- [ ] **Step 3: Full repo test suite**

Run: `npm test`
Expected: every test PASSES.

- [ ] **Step 4: Autopilot regression**

Run:

```
node --test tests/autopilot-state.test.js tests/autopilot-timing.test.js tests/autopilot-input-guard.test.js tests/autopilot-authority.test.js tests/autopilot-debug.test.js tests/completion-confirmer.test.js tests/item-handlers.test.js tests/module-autopilot.test.js tests/module-scraper.test.js
```

Expected: every test PASSES (Autopilot files untouched by U12).

- [ ] **Step 5: Repo-wide real-key leak scan**

PowerShell:

```powershell
Get-ChildItem -Recurse -File -Exclude *.log,package-lock.json |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\\.git\\' -and $_.FullName -notmatch '\\Reference\\' } |
  Select-String -Pattern 'sk-[A-Za-z0-9_]{16,}' -SimpleMatch:$false
```

Expected: zero matches in the extension codebase (`Reference\` excluded — its `sk-…` hits are vendored pip RECORD checksums confirmed in U11).

- [ ] **Step 6: Provider-neutrality grep on public UI files**

PowerShell:

```powershell
Select-String -Path 'options.html','lib\sidebar.js','lib\ai-options-controller.js','lib\ai-answer-controller.js','lib\ai-content-listeners.js','lib\ai-open-options-content.js','lib\ai-open-options-background.js','lib\ai-question-context.js' -Pattern 'DeepSeek','OpenAI','Anthropic','Claude','GPT-' -SimpleMatch
```

Expected: zero matches.

- [ ] **Step 7: Sidebar / content secret-control selector grep**

Grep `lib/sidebar.js` and `content.js` for: `ai-options-key`, `ai-options-save`, `ai-options-clear`, `ai-options-toggle`, `ai-options-remember`.
Expected: zero matches.

- [ ] **Step 8: U11 surface-untouched check**

Run `git diff --stat content.js background.js manifest.json lib/sidebar.css lib/ai-open-options-content.js lib/ai-open-options-background.js` and confirm the diff stat for each file is IDENTICAL to what it was at the start of U12 (no U12 edits to any U11 surface). If any of these files shows a new hunk attributable to U12, halt and report.

- [ ] **Step 9: Autopilot-untouched check**

Run `git diff --stat lib/autopilot-state.js lib/autopilot-timing.js lib/module-autopilot.js lib/module-scraper.js lib/item-handlers.js lib/completion-confirmer.js tests/autopilot-state.test.js tests/autopilot-timing.test.js tests/module-autopilot.test.js tests/module-scraper.test.js tests/item-handlers.test.js tests/completion-confirmer.test.js` and confirm the diff stat is IDENTICAL to what it was at U12 start.

- [ ] **Step 10: U12 file-attribution check**

Confirm the file list attributable to U12 is EXACTLY:
- Modified production (3): `lib/sidebar.js`, `lib/ai-answer-controller.js`, `lib/ai-question-context.js`.
- Modified tests (4): `tests/sidebar.test.js`, `tests/ai-answer-controller.test.js`, `tests/ai-question-context.test.js`, `tests/ai-answer-tab.test.js`.
- Created (docs): `docs/superpowers/plans/2026-05-27-u12-blocked-scan-guard.md`.

No new modules created. No new manifest entries. No new permissions.

- [ ] **Step 11: HEAD unchanged**

Run: `git rev-parse HEAD`
Expected: `d1b0d90b2987b2f2bccde5dbc190787acdada155` (the U11 post-execution SHA, unchanged by U12).

- [ ] **Step 12: Produce the final U12 report**

Compose a final report explicitly answering all of the following:

1. What was the U12 root cause at each of the three layers? (Sidebar gating gap, controller eager `buildQuestionSnapshot` call, question-context detection-before-block-check.)
2. What exact change disables Scan in the sidebar on blocked pages?
3. What exact change makes `performScan()` fail-closed in the controller, including the clear-on-blocked sequence (`_activeSnapshot=null`, `_activeSuggestions=null`, `setAiScanResult(null)`, `setAiSuggestions(null)`, blocked apply-result)?
4. What exact change makes `buildQuestionSnapshot()` fail-closed in the question-context module?
5. Live-screenshot integration regression: which test proves the rendered sidebar on `/assignment-submission/.../attempt` with five detectable questions no longer reproduces the screenshot? Quote the assertion list (status text, Scan disabled, Generate disabled, Apply disabled, Manage AI API Key issues exactly `{type:"ccp.ai.openOptions"}`, native click no preview, programmatic scan no preview, sidebar DOM contains no marker prompt, no forbidden commands, U11 one-card visibility preserved).
6. What tests prove sanitizeForRequest on a blocked snapshot produces zero questions and no prompt leakage (C4 + the C6–C11 snapshot/sanitize JSON checks)?
7. What tests prove visibly-blocked current-activity pages (Graded App Item, Discussion Prompt, Graded Quiz, Programming Assignment, Peer Review, Exam) on a generic lecture URL produce empty snapshots with the correct categorized blockedReason?
8. What tests prove a previously scanned safe-page preview is cleared when the SPA navigates to a blocked page and Scan is invoked again (B3)?
9. What tests prove Manage AI API Key remains usable from a blocked page (B6 + U12-LIVE assertion 5)?
10. What tests prove eligible lecture pages still produce questions (regression C5)?
11. Which exact files changed for U12?
12. Did any secret, paid-service implementation, provider behavior change, Autopilot modification, live generation test, or git mutation occur?
13. Was a real API key entered or embedded anywhere?
14. Live re-test instruction for the user: reload the unpacked extension, revisit the blocked `/assignment-submission/.../attempt` URL, click `Scan questions` and confirm the button is disabled and no preview renders. Manage AI API Key still opens settings.

Do NOT enter any real API key during this verification step.

---

## Self-Review Notes

- **Spec coverage:**
  - **Live-screenshot integration regression (Amendment 1):** Task 1 (RED first per "should be RED before the implementation") + Task 8 Step 1 (verify GREEN after all layers). All 10 required assertions enumerated explicitly in the test code:
    1. status text declares disabled
    2. Scan disabled
    3. Generate disabled
    4. Apply disabled
    5. Manage AI API Key enabled + emits exactly `{type:'ccp.ai.openOptions'}`
    6. Native click on Scan renders no preview
    7. Programmatic `controller.performScan()` renders no preview
    8. Sidebar DOM contains no marker prompt text after either attempt
    9. No `generateAnswers`/apply/submit/continue/check/autoAdvance command
    10. U11 one-visible-card behavior preserved (computed-style check)
  - **Visible-block coverage in question-context (Amendment 2):** Task 6 explicitly covers all six required markers — Graded App Item (C6), Discussion Prompt (C7), Graded Quiz (C8), Programming Assignment (C9), Peer Review (C10), Exam (C11). Each asserts the 8 required contracts:
    1. `page.eligible === false`
    2. correct categorized `blockedReason`
    3. `questions.length === 0`
    4. `supportedCount === 0`
    5. `actionableCount === 0`
    6. `localGuard` is `[]`
    7. `sanitizeForRequest(snapshot).questions.length === 0`
    8. snapshot JSON + sanitized JSON do not contain the prompt-text marker
  - **Expanded controller assertions (Amendment 3):** Task 4 covers all five additional required contracts:
    - Stale safe-page preview cleared on SPA navigation to blocked (B3)
    - Prior suggestions cleared on blocked scan refusal (B2 via `setAiSuggestions(null)` assertion)
    - Blocked programmatic scan creates no usable `_activeSnapshot` (B4 — `_activeSnapshot=null` proven by `performGenerate` early-return / no `generateAnswers` send)
    - Subsequent Generate and Apply remain refused with zero transport/application effect (B4 + B5)
    - Manage AI API Key remains independent and usable (B6)
  - Three-layer fix → Tasks 2–7 (sidebar A1–A4, controller B1–B6, question-context C1–C11).
  - Verification gates → Task 8 (U12-LIVE re-run, focused suite, full `npm test`, autopilot regression, leak scan, provider-neutrality, secret-control selectors, U11-untouched, autopilot-untouched, file attribution, HEAD-unchanged, final report).
- **Placeholder scan:** No `TBD`/`implement later`/`similar to Task N`. Every test has full code; every implementation has full code.
- **Type/symbol consistency:**
  - `_aiState.eligible === false` strict comparison used identically in `lib/sidebar.js` Task 3 and in the existing `gen.disabled` / `apply.disabled` checks already in the file.
  - `qc.isCurrentPageBlocked(loc, doc)` API used identically in `lib/ai-answer-controller.js` Task 5 and in `lib/ai-question-context.js` Task 7 (same module, same export).
  - Blocked-page apply-result message string `'AI answer filling is disabled on graded or blocked assessment pages.'` is the EXACT literal already present at `lib/ai-answer-controller.js:63` and `:109`; Task 5 reuses it verbatim. Three call sites with the same literal is acceptable for U12's small scope.
  - Snapshot field shape matches the existing non-blocked return; the `'snap_blocked_' + djb2(...)` token is distinct from the normal `'snap_' + djb2(...)` so token-equality checks in `performGenerate`/`performApply` correctly detect blocked→unblocked transitions.
  - `makeBlockedPageFakeSidebar()` is reused from U11's controller test additions (already exposes `_getHandlers()`, `_getLastOpenOptionsFailure()`). Task 4 does not shadow it.
  - `createOpenOptionsCallback` import in `tests/ai-answer-tab.test.js` Task 1 references the U11 helper at `lib/ai-open-options-content.js` (same export shape verified in U11 Group 3 tests).
- **Scope guard:** No Autopilot file, no `lib/deepseek-client.js`, no `lib/managed-client.js`, no options.html/options.js, no `content.js`, no `background.js`, no `manifest.json` edits. U11 surfaces remain frozen (verified by Task 8 Step 8).
- **Safety constraints enforced:**
  - No real API key anywhere.
  - No commit/push/reset/clean/revert/checkout/amend/branch/worktree-cleanup steps.
  - No new permissions/host_permissions/CSP changes.
  - Strict authorization for `setSessionKey` / `clearKey` / `setAccessMode` remains untouched.
  - `ccp.ai.openOptions` U11 Coursera-only sender authorization remains untouched.
