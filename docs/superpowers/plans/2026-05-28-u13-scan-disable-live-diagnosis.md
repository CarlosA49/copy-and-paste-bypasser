# U13 — Live Scan-Disable Diagnosis + UI Revision Label

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **No-git-mutation constraint (mirrors U11/U12):** NO `git add`, `git commit`, `git push`, `git reset`, `git checkout`, `git clean`, `git revert`, `git amend`, `git branch`, or worktree cleanup. The plan contains no commit steps. Verification uses only read-only git (`git rev-parse`, `git status`, `git diff`) and Node tests. HEAD must remain `d1b0d90b2987b2f2bccde5dbc190787acdada155` (the U11 post-execution SHA) at the end of U13.

**Goal:** Diagnose why production Chrome is not reflecting U12's Scan-disabled state on the blocked `/assignment-submission/.../attempt` URL despite tests reporting the fix is in `lib/sidebar.js`, then either (a) prove via diagnostic RED tests that there is an additional code defect and fix it, or (b) prove that the code is correct and the live failure is a build-load mismatch — and add a source-controlled UI Revision label so the user can distinguish loaded-U13 from stale-loaded-pre-U12 on reload.

**Architecture:**
- **Phase 1 — static source diagnosis (read-only):** confirm the U12 disabling rule is present at the exact line; confirm `manifest.json` content_scripts loads that file; confirm no second sidebar file or generated/dist copy exists; confirm no later-running function re-enables Scan after blocked eligibility.
- **Phase 2 — diagnostic RED tests:** add two integration tests that mirror production startup order (1: mount → wire → keyStatus refresh → eligibility check; 2: async keyStatus/accessMode broadcast AFTER blocked eligibility). Run them. If they fail, the code has a defect uncovered by U12's tests; if they pass, the code paths are correct and the live failure is environmental (build-load).
- **Phase 3 — UI Revision label (always shipped):** add a source-controlled constant `CCP_UI_REVISION = 'U13'` and render it in the Diagnostics tab and the options-page footer alongside the existing `Build: 1.0.0`. Source-controlled means future revisions bump the constant in code, so a reload that still shows `U12` or absent label proves Chrome did not pick up the latest source.
- **Phase 4 — conditional code fix:** ONLY if Phase 2 surfaced an actual RED, implement the minimal fix and re-verify.
- **Phase 5 — verification + live re-test guidance** for the user.

**Tech Stack:** Vanilla JS (MV3 content script + service worker + options page), `node:test`, `jsdom`, no build step.

---

## Scope Guard

- **Approved production files for U13:** `lib/sidebar.js` (UI Revision label rendering, potential fix surfaced by RED), `options.html` (UI Revision label render), `options.js` (UI Revision label population), and one new tiny module `lib/ui-revision.js` (source-of-truth constant).
- **Approved test files for U13:** `tests/sidebar.test.js`, `tests/ai-answer-tab.test.js`, and one new file `tests/ui-revision.test.js`.
- **Frozen unless a failing U13 regression strictly requires it:** `content.js`, `background.js`, `manifest.json`, `lib/sidebar.css`, `lib/ai-answer-controller.js`, `lib/ai-question-context.js`, `lib/ai-open-options-content.js`, `lib/ai-open-options-background.js`, `lib/ai-background-service.js`, `lib/ai-content-listeners.js`, `lib/ai-options-controller.js`, `lib/deepseek-client.js`, `lib/managed-client.js`, all Autopilot files (`lib/autopilot-*.js`, `lib/module-*.js`, `lib/item-handlers.js`, `lib/completion-confirmer.js`) and their tests.
- No new manifest permissions / host_permissions / CSP / web_accessible_resources.
- No real API key entered or embedded.
- No live Scan/Generate/Apply test on assessment content.
- No commercial backend / portal / balance / ledger / pricing / payment / provider-route work.
- No provider API/model behavior changes.

---

## File Structure

- `lib/ui-revision.js` — NEW — tiny module exporting `CCP_UI_REVISION = 'U13'` and the helper `populateUiRevisionTag(rootEl)` that fills any element with `[data-role="ccp-ui-revision"]` with the text `UI Revision: U13`. UMD-style to match existing `lib/ai-*` files.
- `lib/sidebar.js` — add a `<div class="ccp-diag-revision" data-role="ccp-ui-revision">UI Revision: —</div>` element inside the Diagnostics tab template immediately after the existing `<div class="ccp-diag-build" data-role="ccp-build">Build: —</div>`. Modify `mount()` (or wherever `populateBuildTag()` is invoked) to also call `populateUiRevisionTag(shadow)` when the helper is loaded.
- `options.html` — add a `<div class="ccp-options-revision" data-role="ccp-ui-revision">UI Revision: —</div>` element in the existing footer near the existing build display (if any). If options.html does not yet have a footer revision display, add one.
- `options.js` — call the helper to populate `[data-role="ccp-ui-revision"]` on DOMContentLoaded.
- `tests/ui-revision.test.js` — NEW — asserts the helper produces text `UI Revision: U13` against a fixture DOM with `<div data-role="ccp-ui-revision">UI Revision: —</div>`.
- `tests/sidebar.test.js` — append: assert the Diagnostics tab template contains `[data-role="ccp-ui-revision"]`, and after `mount()` plus helper invocation the element text is `UI Revision: U13`.
- `tests/ai-answer-tab.test.js` — append two diagnostic integration tests (production-startup-order + async-broadcast).
- Conditional only if RED surfaces a defect: a focused production fix inside `lib/sidebar.js` (the only file U12 already touched on the Scan path).

No other file may be modified.

---

## Task 1: Static source diagnosis (read-only)

This is the first half of the user-specified diagnosis (items 1–5 of the user's required diagnosis). It produces written evidence; it does not change any file.

**Files:** none modified.

- [ ] **Step 1: Confirm `lib/sidebar.js` contains the U12 Scan disabling rule and identify its exact line number**

Run: `grep -n "scan.disabled = " lib/sidebar.js` (or PowerShell equivalent `Select-String -Path lib/sidebar.js -Pattern 'scan.disabled = '`)
Expected: one or more lines including `scan.disabled = !!(_aiState.eligible === false || _aiState.inFlight);`. Report the exact line number. (At time of plan writing this is `lib/sidebar.js:1066` inside `_renderAiButtonStates()`.)

Also grep for the click-handler guard added in U12: `grep -n "if (scan.disabled)" lib/sidebar.js` — expected: one line inside `wireAiAnswer()` (at time of plan writing, `lib/sidebar.js:1103`).

Report both line numbers.

- [ ] **Step 2: Confirm `manifest.json` content_scripts entry references `lib/sidebar.js`**

Read `manifest.json` and find the `content_scripts[0].js` array. Confirm `"lib/sidebar.js"` is present. At time of plan writing it is at line 55 of `manifest.json`. No other sidebar module path is present.

Report the position of `lib/sidebar.js` within the `js` array and whether any other `*sidebar*` file is registered.

- [ ] **Step 3: Confirm `content.js` loads sidebar via the standard global path and not via any second loader**

Run: `grep -n "sidebar" content.js | head -20`
Expected: references via `a.sidebar` (where `a = window.ClipboardCleaner`) only. No direct `require('./sidebar')`, no `chrome.runtime.getURL('lib/sidebar.js')`, no dynamic `<script>` injection.

Confirm that `mountSidebarWhenReady()` calls `a.sidebar.mount()` and that `setupAiAnswerController()` constructs the controller with `sidebar: a.sidebar`. (Currently `content.js:54-58` and `content.js:249-258`.)

Report: any unexpected sidebar reference is a finding.

- [ ] **Step 4: Confirm no duplicate sidebar source or generated/dist copy exists**

Run:
- `git ls-files | findstr sidebar` (Bash: `git ls-files | grep -i sidebar`) — expected: `lib/sidebar.css`, `lib/sidebar.js`, `tests/sidebar.test.js`. No `dist/`, `build/`, `out/`, or duplicate copy.
- `Get-ChildItem -Recurse -File -Filter "*sidebar*" | Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\\.git\\' -and $_.FullName -notmatch '\\Reference\\' }` (Bash: `find . -name '*sidebar*' -not -path './node_modules/*' -not -path './.git/*' -not -path './Reference/*'`) — confirm only the three expected files plus the plan docs.

Report any unexpected matches.

- [ ] **Step 5: Inspect for a function that re-enables Scan after `setAiPageEligibility({eligible:false})`**

Run: `grep -n "scan" lib/sidebar.js | head -40`
Expected: the only writes to a variable named `scan` are inside `_renderAiButtonStates()` (the U12 disabling rule) and inside `wireAiAnswer()` (the click handler). There must be NO line that does `scan.disabled = false` or `scan.removeAttribute('disabled')` or similar.

Also grep `lib/ai-answer-controller.js`, `lib/ai-content-listeners.js`, `content.js` for any direct DOM manipulation of `[data-action="ai-scan"]`. Expected: zero matches.

Report any finding.

- [ ] **Step 6: Inspect the production startup ordering**

Read `content.js:267-278`. Confirm `startup()` calls `mountSidebarWhenReady()` then `startAutopilot()` then `setupAiAnswerController()` in that order, and is triggered either synchronously after `document.readyState` is non-`loading` or by `DOMContentLoaded`.

Read `lib/ai-answer-controller.js:176-210` (the `wire()` function). Confirm it calls `sidebar.setAiAnswerHandlers({...})` then `refreshKeyStatus()` then computes `initBlock = qc.isCurrentPageBlocked(loc, doc)` and calls `sidebar.setAiPageEligibility({eligible: !initBlock.blocked, blockedReason: initBlock.reason, supportedCount: 0})`.

Note: `refreshKeyStatus()` is async (it goes through `messenger.send(...)`). When its callback returns, `sidebar.setAiKeyStatus(...)` and `sidebar.setAiAccessMode(...)` are called — both of which trigger `_renderAiButtonStates()`. Confirm neither writes to `_aiState.eligible` (read `setAiKeyStatus` at `lib/sidebar.js:953-970` and `setAiAccessMode` at `lib/sidebar.js:920-929`). They write `_aiState.keyPresent` and `_aiState.accessMode` only.

Read `lib/ai-content-listeners.js:11-23`. Confirm it triggers `controller.refreshKeyStatus()` on `ccp.ai.keyStatusChanged` and `ccp.ai.accessModeChanged` broadcasts — and ONLY refreshKeyStatus (which does not touch `_aiState.eligible`).

Report: any path that could overwrite `_aiState.eligible` after the controller's initial `setAiPageEligibility({eligible:false})` is a finding.

- [ ] **Step 7: Compose the static diagnosis report**

Write a short report (markdown, not committed; included in the implementer's final return message). It must contain:
1. Exact line number of the U12 Scan disabling rule.
2. Exact line number of the U12 click-handler guard.
3. Manifest content_scripts confirmation.
4. Absence of duplicate/dist sidebar copies.
5. Absence of any code that re-enables Scan after blocked.
6. Production startup ordering trace (mount → wire → refreshKeyStatus async → setAiPageEligibility sync).
7. Whether `refreshKeyStatus`'s async callback can race against `setAiPageEligibility`.

Based on what I expect to find from this plan's own author's pre-analysis: all the static checks should pass; no defect should be visible at static level. Document that explicitly so the next phase's RED tests have a baseline.

---

## Task 2: DIAGNOSTIC BASELINE — production-startup-order integration test

**Framing (per user clarification):** This is a diagnostic baseline test, not a required RED. Since the current source already contains U12, this test is EXPECTED to PASS if the workspace behavior is correct. Interpret results as follows:
- If it **fails**, a real production initialization/state defect exists. Identify it, show the failure, and implement only the smallest fix in Task 7.
- If it **passes**, do not edit Scan/blocked-page logic speculatively. Record that the checked-in source passes the production-order check, indicating a live load/version mismatch is the likely live failure cause.

**Files:**
- Test: `tests/ai-answer-tab.test.js` (append)

This is the user's required diagnosis item 6.

- [ ] **Step 1: Append the production-startup-order integration test**

Append to `tests/ai-answer-tab.test.js`:

```js
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

  // Load modules in the same order content.js does.
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

  // Stub chrome runtime — keyStatus returns asynchronously via setTimeout(0)
  // to mimic real Chrome's microtask boundary.
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

  // Mirror content.js startup() order exactly.
  // 1. Mount sidebar.
  a.sidebar.mount();

  // 2. setupAiAnswerController (controller.wire()).
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

  // 3. Attach content listeners (refreshKeyStatus-on-broadcast path).
  a.aiContentListeners.attachAiContentListeners({ runtime: dom.window.chrome.runtime, controller: controller });

  // 4. Wait for the keyStatus async callback to settle.
  await new Promise(function (r) { setTimeout(r, 0); });
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(keyResponded, true, 'keyStatus async callback must have settled');

  // 5. Acquire the Scan button from the rendered shadow DOM and assert disabled.
  const host = dom.window.document.getElementById('ccp-host-root');
  const shadow = host.shadowRoot || host;
  const scan = shadow.querySelector('[data-action="ai-scan"]');
  assert.ok(scan, 'Scan button must exist');
  assert.equal(scan.disabled, true,
    'After full production startup sequence on /assignment-submission/.../attempt, Scan MUST be disabled. ' +
    'Observed scan.disabled=' + scan.disabled + '. _aiState diagnostics not directly inspectable, but ' +
    'the page-status text says: ' + JSON.stringify((shadow.querySelector('[data-role="ai-status"]') || {}).textContent));
});
```

- [ ] **Step 2: Run the U13-D1 test**

Run: `node --test --test-name-pattern="U13-D1" tests/ai-answer-tab.test.js`

Two possible outcomes:
- **(A) PASS** — production code paths are correct; the live failure is NOT a code defect surfaced by jsdom. This points to a **build-load mismatch** in real Chrome (stale unpacked extension). Phase 3's UI Revision label is the proper response.
- **(B) FAIL** — a real code defect exists that U12's unit tests missed. Capture verbatim failure; Task 5 will implement the fix.

Either outcome is informative. Report which occurred and capture verbatim output.

---

## Task 3: DIAGNOSTIC BASELINE — async broadcast cannot re-enable Scan

**Framing (per user clarification):** This is a diagnostic baseline test, not a required RED. Same interpretation rules as Task 2.

**Files:**
- Test: `tests/ai-answer-tab.test.js` (append)

This is the user's required diagnosis item 7.

- [ ] **Step 1: Append the async-broadcast test**

Append to `tests/ai-answer-tab.test.js`:

```js
// === U13 DIAGNOSIS — async keyStatus/accessMode broadcast cannot re-enable Scan ===
// Proves: after the controller has set eligible:false for a blocked page, an
// asynchronously delivered ccp.ai.keyStatusChanged or ccp.ai.accessModeChanged
// broadcast that triggers refreshKeyStatus -> setAiKeyStatus + setAiAccessMode
// MUST NOT re-enable the Scan button.

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

  // Build a chrome.runtime that captures onMessage listeners so we can
  // synthesize broadcasts after init.
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

  // Wait for initial keyStatus settle.
  await new Promise(function (r) { setTimeout(r, 0); });
  await new Promise(function (r) { setTimeout(r, 0); });

  const host = dom.window.document.getElementById('ccp-host-root');
  const shadow = host.shadowRoot || host;
  const scan = shadow.querySelector('[data-action="ai-scan"]');
  assert.equal(scan.disabled, true, 'precondition: Scan must be disabled after initial startup');

  // Synthesize ccp.ai.keyStatusChanged → fires refreshKeyStatus → setAiKeyStatus + setAiAccessMode.
  onMessageListeners.forEach(function (fn) { try { fn({ type: 'ccp.ai.keyStatusChanged' }); } catch (_) {} });
  await new Promise(function (r) { setTimeout(r, 0); });
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(scan.disabled, true, 'Scan must REMAIN disabled after ccp.ai.keyStatusChanged broadcast');

  // Synthesize ccp.ai.accessModeChanged → same path.
  onMessageListeners.forEach(function (fn) { try { fn({ type: 'ccp.ai.accessModeChanged' }); } catch (_) {} });
  await new Promise(function (r) { setTimeout(r, 0); });
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(scan.disabled, true, 'Scan must REMAIN disabled after ccp.ai.accessModeChanged broadcast');
});
```

- [ ] **Step 2: Run the U13-D2 test**

Run: `node --test --test-name-pattern="U13-D2" tests/ai-answer-tab.test.js`

Same two outcomes apply:
- **(A) PASS** — async broadcast does NOT regress eligibility. Confirms code is correct.
- **(B) FAIL** — broadcast handlers regress eligibility. Capture and feed into Task 5.

Capture verbatim. Report which outcome occurred.

---

## Task 4: GREEN — Add `lib/ui-revision.js` source-of-truth constant

**Files:**
- Create: `lib/ui-revision.js`
- Create: `tests/ui-revision.test.js`

This is the user's required diagnosis item 8. It ships regardless of whether Tasks 2/3 surface a defect, because the user needs a load-distinguisher to verify which build of the unpacked extension Chrome actually loaded.

- [ ] **Step 1: Create `tests/ui-revision.test.js` (RED)**

Create the test file:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { CCP_UI_REVISION, populateUiRevisionTag } = require('../lib/ui-revision.js');

test('U13-R1: CCP_UI_REVISION equals "U13" (source-controlled constant)', () => {
  assert.equal(CCP_UI_REVISION, 'U13');
});

test('U13-R2: populateUiRevisionTag writes "UI Revision: U13" into any [data-role="ccp-ui-revision"] element under the given root', () => {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<div data-role="ccp-ui-revision">placeholder</div>'
    + '<section><div data-role="ccp-ui-revision">UI Revision: —</div></section>'
    + '</body></html>');
  populateUiRevisionTag(dom.window.document);
  const elements = dom.window.document.querySelectorAll('[data-role="ccp-ui-revision"]');
  assert.equal(elements.length, 2);
  for (var i = 0; i < elements.length; i++) {
    assert.equal(elements[i].textContent, 'UI Revision: U13');
  }
});

test('U13-R3: populateUiRevisionTag is a safe no-op when root is null/undefined or has no matching elements', () => {
  assert.doesNotThrow(function () { populateUiRevisionTag(null); });
  assert.doesNotThrow(function () { populateUiRevisionTag(undefined); });
  const dom = new JSDOM('<!doctype html><html><body><div>no marker</div></body></html>');
  assert.doesNotThrow(function () { populateUiRevisionTag(dom.window.document); });
});
```

Run: `node --test tests/ui-revision.test.js`
Expected: ALL FAIL with `Cannot find module '../lib/ui-revision.js'`. Capture verbatim.

- [ ] **Step 2: Create `lib/ui-revision.js` (GREEN)**

Create the module:

```js
'use strict';
// lib/ui-revision.js
// U13 — source-controlled UI revision label. The manifest version (1.0.0) is
// unchanged across multiple code revisions, so it cannot distinguish loaded
// builds in the unpacked extension. This module exports a single string that
// every plan iteration bumps (U13, U14, ...) so a user reloading the unpacked
// extension can visually confirm which revision Chrome actually picked up.
//
// Display surfaces: Diagnostics tab footer (sidebar) and options-page footer.

(function (root) {
  'use strict';

  var CCP_UI_REVISION = 'U13';

  function populateUiRevisionTag(rootEl) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return;
    var nodes = rootEl.querySelectorAll('[data-role="ccp-ui-revision"]');
    var text = 'UI Revision: ' + CCP_UI_REVISION;
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = text;
  }

  var api = { CCP_UI_REVISION: CCP_UI_REVISION, populateUiRevisionTag: populateUiRevisionTag };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.ClipboardCleaner = root.ClipboardCleaner || {}; root.ClipboardCleaner.uiRevision = api; }
})(typeof self !== 'undefined' ? self : this);
```

Run: `node --test tests/ui-revision.test.js`
Expected: 3/3 PASS.

- [ ] **Step 3: Register the new module in `manifest.json` content_scripts (ONE LINE ADDED)**

Open `manifest.json`. In `content_scripts[0].js`, insert `"lib/ui-revision.js"` immediately AFTER `"lib/ai-open-options-content.js"` and BEFORE `"lib/sidebar.js"`. The relevant block becomes:

```
        "lib/ai-open-options-content.js",
        "lib/ui-revision.js",
        "lib/sidebar.js",
```

This is the ONLY manifest change. No new permissions / host_permissions / CSP / web_accessible_resources.

**Note:** modifying `manifest.json` requires a controlled exception to the "U11 surfaces frozen" rule. This exception is justified because shipping the UI Revision label requires loading the new module, and the manifest is the only way to load a content script. The exception is one inserted line; no other manifest field changes. Report this exception in the final report.

---

## Task 5: GREEN — Render UI Revision label in sidebar Diagnostics tab

**Files:**
- Modify: `lib/sidebar.js`
- Test: `tests/sidebar.test.js` (append)

- [ ] **Step 1: Add the rendering test (RED) to `tests/sidebar.test.js`**

Append:

```js
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
```

Run: `node --test --test-name-pattern="U13-S" tests/sidebar.test.js`
Expected: both FAIL — the placeholder element does not yet exist in the sidebar template.

- [ ] **Step 2: Add the placeholder element to the Diagnostics tab template in `lib/sidebar.js`**

Open `lib/sidebar.js`. Find the Diagnostics tab template line (currently `lib/sidebar.js:107`):

```js
          '<div class="ccp-diag-build" data-role="ccp-build">Build: —</div>' +
```

Insert immediately AFTER that line and BEFORE the existing `<div class="ccp-diag-header">`:

```js
          '<div class="ccp-diag-revision" data-role="ccp-ui-revision">UI Revision: —</div>' +
```

- [ ] **Step 3: Wire `populateUiRevisionTag` into `mount()` alongside `populateBuildTag()`**

Find where `populateBuildTag()` is invoked (search `populateBuildTag()` — it is called inside `mount()`; depending on file structure, look near where the rest of the mount-time DOM population happens). Immediately after that call, add a defensive helper-presence guard:

```js
    try {
      var helper = (typeof self !== 'undefined' && self.ClipboardCleaner && self.ClipboardCleaner.uiRevision) ? self.ClipboardCleaner.uiRevision : null;
      if (!helper && typeof require === 'function') { try { helper = require('../lib/ui-revision.js'); } catch (_) {} }
      if (helper && typeof helper.populateUiRevisionTag === 'function') helper.populateUiRevisionTag(shadow);
    } catch (_) { /* never let revision label rendering crash mount() */ }
```

Notes:
- The defensive `try/catch` matches the file's existing style around `populateBuildTag()`.
- The `self.ClipboardCleaner.uiRevision` lookup mirrors how `sidebar.js` resolves other extracted UMD modules.
- The `require('../lib/ui-revision.js')` fallback covers the node:test path.

- [ ] **Step 4: Run U13-S tests and verify PASS**

Run: `node --test --test-name-pattern="U13-S" tests/sidebar.test.js`
Expected: 2/2 PASS.

- [ ] **Step 5: Run the full sidebar test file**

Run: `node --test tests/sidebar.test.js`
Expected: every test PASSES (no regressions to existing U11/U12 sidebar tests).

---

## Task 6: GREEN — Render UI Revision label in `options.html` footer

**Files:**
- Modify: `options.html`
- Modify: `options.js`

The user requested the label appear on the options-page footer too, so that opening the options page is a second avenue to verify the loaded revision.

- [ ] **Step 1: Inspect `options.html` for the current footer / build display**

Read `options.html` and locate the footer area (likely near `</body>` or in a `<footer>` element). Identify whether there is an existing `[data-role="ccp-build"]` element. Report the line number.

- [ ] **Step 2: Add the UI Revision placeholder element to `options.html`**

Insert a new `<div>` element near the existing footer/build display:

```html
<div class="ccp-options-revision" data-role="ccp-ui-revision">UI Revision: —</div>
```

If the file has no footer at all, add a minimal one near the bottom of `<body>`:

```html
<footer class="ccp-options-footer">
  <div class="ccp-options-revision" data-role="ccp-ui-revision">UI Revision: —</div>
</footer>
```

The exact placement is flexible. The element must be present somewhere visible in the rendered options page.

- [ ] **Step 3: Wire `populateUiRevisionTag(document)` in `options.js`**

Open `options.js`. Find the file's existing `DOMContentLoaded` handler or its top-level init. Add a one-time call to `populateUiRevisionTag(document)` after DOM is ready:

```js
// U13 — populate UI Revision label from the source-controlled constant.
try {
  var uiRev = (typeof window !== 'undefined' && window.ClipboardCleaner && window.ClipboardCleaner.uiRevision) ? window.ClipboardCleaner.uiRevision : null;
  if (!uiRev) {
    // options.html does not load lib/ui-revision.js via manifest content_scripts
    // (it's not a content script). Add an explicit <script src="lib/ui-revision.js"></script>
    // in options.html OR a manual fetch+eval. The simplest path is a <script> tag.
  }
  if (uiRev && typeof uiRev.populateUiRevisionTag === 'function') uiRev.populateUiRevisionTag(document);
} catch (_) { /* never break options page on label render */ }
```

Implementation note: the cleanest way for `options.html` to access `lib/ui-revision.js` is to add a `<script src="lib/ui-revision.js"></script>` tag in `options.html` BEFORE `<script src="options.js"></script>`. The new module's UMD wrapper handles browser globals correctly. **External script src only — NO inline `<script>` blocks in `options.html`.**

- [ ] **Step 4: Add `<script src="lib/ui-revision.js"></script>` to `options.html`**

In `options.html`, immediately before the existing `<script src="options.js"></script>` (or equivalent), add:

```html
<script src="lib/ui-revision.js"></script>
```

This loads the module into the options page's window. The UMD wrapper attaches it to `window.ClipboardCleaner.uiRevision`.

- [ ] **Step 5: Manual verification of options.html (no automated test required for the static HTML markup)**

Run: `grep -n "ccp-ui-revision" options.html` — expected: at least one match.
Run: `grep -n "populateUiRevisionTag" options.js` — expected: at least one match.

If the user wants automated coverage, add a test in `tests/options.test.js` (or wherever options DOM tests live) that loads `options.html` in JSDOM and asserts the element exists. This is optional and out of scope unless an existing test pattern already covers options.html.

---

## Task 7: Conditional GREEN — fix any defect surfaced by Task 2 or Task 3

**Files:** depends on which test failed; expected scope `lib/sidebar.js` only.

**ONLY execute this task IF either U13-D1 or U13-D2 (from Tasks 2 / 3) actually FAILED.** If both tests passed, mark this task as SKIPPED in the implementer's report and proceed directly to Task 8. Do NOT invent a speculative fix.

- [ ] **Step 1: Identify the specific failure mode**

Re-read the verbatim failure output from Task 2 or Task 3. Common possibilities:
- **Failure A:** `scan.disabled === false` after initial `controller.wire()` settles. This would indicate `setAiPageEligibility` is not setting `_aiState.eligible = false`, OR `_renderAiButtonStates()` is not being called, OR the `scan` selector query returns null at the moment of `_renderAiButtonStates`. Inspect each in turn.
- **Failure B:** `scan.disabled` flips from `true` to `false` after a `ccp.ai.keyStatusChanged` broadcast. This would indicate `refreshKeyStatus`'s callback path mutates `_aiState.eligible` somewhere (which would be a regression). Trace `setAiKeyStatus` and `setAiAccessMode` for any assignment to `_aiState.eligible`.

- [ ] **Step 2: Implement the minimal targeted fix**

Apply the smallest possible fix. Examples:
- If `_renderAiButtonStates` is not called from `setAiKeyStatus` or `setAiAccessMode` (it currently is — but verify), add the call.
- If a function accidentally writes `_aiState.eligible = true` or `_aiState.eligible = !!something`, remove that write.
- If the `scan` selector is queried at the wrong time, ensure `_renderAiButtonStates` is called AFTER the sidebar template is mounted (it is — but verify).

Whatever the fix, it must satisfy: `scan.disabled === true` at every observable moment AFTER `setAiPageEligibility({eligible:false})` until a `setAiPageEligibility({eligible:true})` call happens.

- [ ] **Step 3: Re-run U13-D1 and U13-D2 and verify they PASS**

Run: `node --test --test-name-pattern="U13-D" tests/ai-answer-tab.test.js`
Expected: 2/2 PASS.

- [ ] **Step 4: Run the full controller + sidebar + answer-tab suite (regression)**

Run: `node --test tests/sidebar.test.js tests/ai-answer-controller.test.js tests/ai-answer-tab.test.js tests/ai-question-context.test.js`
Expected: all PASS, including the U12-A/B/C and U12-LIVE tests.

---

## Task 8: Final verification + live re-test guidance

**Files:** none modified.

- [ ] **Step 1: Re-run U13-LIVE-equivalent tests (U13-D1 + U13-D2 + U12-LIVE)**

Run: `node --test --test-name-pattern="U13-D|U12-LIVE" tests/ai-answer-tab.test.js`
Expected: all PASS.

- [ ] **Step 2: Focused U13 + related test suite**

Run:

```
node --test tests/sidebar.test.js tests/ai-answer-controller.test.js tests/ai-question-context.test.js tests/ai-answer-tab.test.js tests/ai-options-controller.test.js tests/ai-background-service.test.js tests/ai-content-listeners.test.js tests/ai-open-options-content.test.js tests/ai-open-options-background.test.js tests/ui-revision.test.js
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

Expected: every test PASSES (Autopilot files untouched).

- [ ] **Step 5: Real-key leak scan (PowerShell)**

```powershell
Get-ChildItem -Recurse -File -Exclude *.log,package-lock.json |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\\.git\\' -and $_.FullName -notmatch '\\Reference\\' } |
  Select-String -Pattern 'sk-[A-Za-z0-9_]{16,}' -SimpleMatch:$false
```

Expected: zero matches.

- [ ] **Step 6: Provider-neutrality grep on public UI files**

```powershell
Select-String -Path 'options.html','lib\sidebar.js','lib\ai-options-controller.js','lib\ai-answer-controller.js','lib\ai-content-listeners.js','lib\ai-open-options-content.js','lib\ai-open-options-background.js','lib\ai-question-context.js','lib\ui-revision.js' -Pattern 'DeepSeek','OpenAI','Anthropic','Claude','GPT-' -SimpleMatch
```

Expected: zero matches.

- [ ] **Step 7: U13 file-attribution check**

Confirm the file list attributable to U13 is EXACTLY:
- Created production (1): `lib/ui-revision.js`.
- Modified production (3 or 4):
  - `lib/sidebar.js` (UI Revision element + helper invocation).
  - `manifest.json` (one inserted line registering the new content script).
  - `options.html` (UI Revision element + script tag).
  - `options.js` (helper invocation on DOMContentLoaded).
  - Conditionally + only if Task 7 ran: one additional targeted fix in `lib/sidebar.js` (already counted above).
- Created tests (1): `tests/ui-revision.test.js`.
- Modified tests (2): `tests/sidebar.test.js`, `tests/ai-answer-tab.test.js`.
- Created (docs): `docs/superpowers/plans/2026-05-28-u13-scan-disable-live-diagnosis.md`.

The `manifest.json` and `options.html`/`options.js` edits are controlled exceptions to the "U11 surfaces frozen" rule, justified by the need to ship the UI Revision label. Document this in the final report.

- [ ] **Step 8: HEAD unchanged**

Run: `git rev-parse HEAD`
Expected: `d1b0d90b2987b2f2bccde5dbc190787acdada155`.

- [ ] **Step 9: Compose the final U13 report**

Compose a final report explicitly answering all of the following:

1. Static diagnosis summary (Task 1 evidence).
2. U13-D1 production-startup-order test result (PASS or FAIL, with verbatim if FAIL).
3. U13-D2 async-broadcast test result (PASS or FAIL, with verbatim if FAIL).
4. Was an actual code defect found? If yes, what was the minimal fix in Task 7?
5. What is the UI Revision constant value, and which surfaces display it?
6. What exception(s) to the frozen-surface rule were taken (e.g., `manifest.json` for new script registration)?
7. Live re-test instructions for the user (see Step 10).
8. Test totals (focused / full / autopilot).
9. Real-key leak scan result.
10. Provider-neutrality grep result.
11. Exact files changed.
12. HEAD unchanged confirmation.

- [ ] **Step 10: Live re-test instructions for the user**

The plan must produce concrete user-facing instructions. Include this text in the final report verbatim:

> **Live re-test instructions:**
>
> 1. Open `chrome://extensions` and click the Reload button on the Clipboard Cleaner extension.
> 2. Open a Coursera page in a new tab (NOT the blocked assessment URL — start with any non-blocked URL like a lecture page).
> 3. Open the sidebar, switch to the **Diagnostics** tab. Confirm you see `UI Revision: U13` immediately below `Build: 1.0.0`.
>    - If you see `UI Revision: U13`: the new code is loaded.
>    - If you see `UI Revision: —` (or no UI Revision line at all): Chrome did not pick up the latest unpacked extension source. Verify the unpacked extension path in `chrome://extensions` matches `C:\Users\carlo\Desktop\Claude Code\Coursera\Copy and Paste Bypasser`, then reload again.
> 4. Open the extension options page (right-click extension icon → Options). Confirm the footer shows `UI Revision: U13`. Same diagnostic: if it shows `—`, the load is stale.
> 5. Once `UI Revision: U13` is confirmed visible, navigate to the blocked URL:
>    `https://www.coursera.org/learn/wireless-communications/assignment-submission/fryRH/practice-quiz-for-introduction-and-history-of-cellular-communication-systems/attempt`
> 6. Confirm:
>    - Status text: `AI answer filling is disabled on graded or blocked assessment pages.` ✓
>    - `Scan questions` button is **disabled** (greyed out at 45% opacity). ✓
>    - `Generate suggestions` button is **disabled**. ✓
>    - `Apply answers` button is **disabled**. ✓
>    - `Manage AI API Key` button is **enabled** and opens the options page on click. ✓
> 7. Do NOT click Scan. Do NOT enter any API key. Do NOT perform any live Generate or Apply.
> 8. If the Diagnostics tab shows `UI Revision: U13` AND the Scan button is STILL enabled on the blocked URL: there is a real production defect that the U13 diagnostic tests did not surface. Report this back; do not retry on your own. The next iteration (U14) will be required.

Do NOT enter any real API key during this verification step.

---

## Self-Review Notes

- **Spec coverage (against user's 9 required diagnosis items):**
  1. Confirm `lib/sidebar.js` contains the U12 line + line number → Task 1 Step 1.
  2. Confirm `content.js` loads the same sidebar with no duplicates → Task 1 Steps 3 + 4.
  3. Confirm `manifest.json` content_scripts entry → Task 1 Step 2.
  4. Inspect for re-enabling code → Task 1 Step 5.
  5. Inspect startup ordering → Task 1 Step 6.
  6. Production-startup-order test → Task 2 (U13-D1).
  7. Async-broadcast test → Task 3 (U13-D2).
  8. Visible diagnostic/build revision (`UI Revision: U13`) → Tasks 4 (module), 5 (sidebar render), 6 (options page render).
  9. Do not weaken blocked-page policy → asserted by U12-LIVE re-run in Task 8 Step 1, and by the U13-D1/D2 tests themselves.
- **Placeholder scan:** No `TBD`/`implement later`/`similar to Task N`. Every test has full code; every implementation has full code. Task 7 is explicitly conditional (skip if Tasks 2/3 passed) with clear "do not invent a speculative fix" guidance.
- **Type/symbol consistency:**
  - Constant name `CCP_UI_REVISION` used identically in `lib/ui-revision.js`, `tests/ui-revision.test.js`, and Task 8 report.
  - Selector `[data-role="ccp-ui-revision"]` used identically in `lib/ui-revision.js`, `lib/sidebar.js` template, `options.html` template, and tests.
  - Helper function name `populateUiRevisionTag` used identically across all four production files and the test file.
  - Label text exactly `'UI Revision: U13'` everywhere; the literal `'UI Revision: —'` is the placeholder shown before `populateUiRevisionTag` runs.
- **Scope guard:** No Autopilot file, no `lib/deepseek-client.js`, no `lib/managed-client.js`, no `lib/ai-background-service.js`. Controlled exceptions for `manifest.json` (one inserted line for content-script registration) and `options.html` / `options.js` (UI Revision label rendering on the options page footer) are explicitly documented and justified by the need to ship the load-distinguisher to the user-facing options surface.
- **Safety constraints enforced:**
  - No real API key.
  - No commit/push/reset/clean/revert/checkout/amend/branch steps.
  - No new manifest permissions / host_permissions / CSP changes (only one `js` array entry added).
  - No commercial backend / portal / balance / ledger / pricing / payment / provider-route work.
  - No provider API/model behavior changes.
  - No live Scan/Generate/Apply test on assessment content.
  - Strict authorization for `setSessionKey` / `clearKey` / `setAccessMode` remains untouched.
  - `ccp.ai.openOptions` U11 Coursera-only sender authorization remains untouched.
  - U12 three-layer blocked-page policy remains untouched (the U13-D1/D2 tests assert it).
