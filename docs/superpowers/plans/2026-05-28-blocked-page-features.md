# Re-enable Scan / Generate / Apply on Graded or Blocked Assessment Pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reverse the U12/U13 blocked-page lockdown so the Scan Questions, Generate Suggestions, and Apply Answers buttons function on graded/blocked assessment URLs the same as on any other page, while preserving U11 (Manage AI API Key wiring) and U13 (UI Revision label).

**Architecture:** Strip the eligibility-based disabling from three layers — sidebar `_renderAiButtonStates` + click guard + status text, controller `performScan/Generate/Apply` early-returns + initial-eligibility call, and the `buildQuestionSnapshot` short-circuit. Keep `isCurrentPageBlocked` and `blockReasonFor` exported but unused. Delete the 22 U12/U13 tests that pinned the lockdown; replace with one positive-case live test.

**Tech Stack:** Vanilla JS (MV3 content script), `node:test`, `jsdom`, no build step.

**Spec:** `docs/superpowers/specs/2026-05-28-blocked-page-features-design.md`

---

## Scope Guard

- **Production files allowed:** `lib/sidebar.js`, `lib/ai-answer-controller.js`, `lib/ai-question-context.js`. No other production file may be modified.
- **Test files allowed:** `tests/sidebar.test.js`, `tests/ai-answer-controller.test.js`, `tests/ai-question-context.test.js`, `tests/ai-answer-tab.test.js`. No other test file may be modified.
- **Frozen:** `manifest.json`, `background.js`, `content.js`, `lib/sidebar.css`, `lib/ui-revision.js`, `options.html`, `options.js`, all `lib/autopilot-*.js`, all `lib/module-*.js`, `lib/item-handlers.js`, `lib/completion-confirmer.js`, `lib/ai-options-controller.js`, `lib/ai-background-service.js`, `lib/ai-content-listeners.js`, `lib/ai-open-options-content.js`, `lib/ai-open-options-background.js`, `lib/answer-applier.js`, `lib/question-detector.js`, `lib/deepseek-client.js`, `lib/managed-client.js`, and all their tests.
- No manifest permissions / host_permissions / CSP / web_accessible_resources changes.
- No real API key entered.
- No commercial backend / managed credits / portal / ledger / pricing / payment / provider-route work.

---

## Task 1: Delete U12-A sidebar tests

**Files:**
- Modify: `tests/sidebar.test.js` (delete lines ~1085–1133, the `// === U12 Safety — Scan disabled` block through end of U12-A4. U13-S1 at line 1135 stays.)

The U12-A tests assert disablement on blocked eligibility — the invariant we're removing.

- [ ] **Step 1: Locate the U12-A block**

Run: `grep -n "U12-A\|U13-S1" tests/sidebar.test.js`
Expected output includes:
- `// === U12 Safety — Scan disabled on blocked pages (defense in depth, layer 1) ===` (header)
- `U12-A1` ~line 1087
- `U12-A2` ~line 1096
- `U12-A3` ~line 1109
- `U12-A4` ~line 1121
- `U13-S1` ~line 1135 (this stays)

- [ ] **Step 2: Delete the U12-A block**

Open `tests/sidebar.test.js`. Delete the comment header `// === U12 Safety — Scan disabled on blocked pages (defense in depth, layer 1) ===` and the four tests `U12-A1`, `U12-A2`, `U12-A3`, `U12-A4` (all four `test('...')` blocks). Stop at — and do NOT touch — the `// === U13 — UI Revision label rendered in Diagnostics tab ===` comment immediately preceding `U13-S1`.

The exact deletion boundary is `// === U12 Safety` through (and including) the `});` that closes the U12-A4 test, plus the single blank line that follows it.

- [ ] **Step 3: Verify the file still parses and U13 tests still run**

Run: `node --test tests/sidebar.test.js`
Expected: every remaining test PASSES. `U13-S1` and `U13-S2` still appear in the output.

- [ ] **Step 4: Commit**

```
git add tests/sidebar.test.js
git commit -m "test(sidebar): drop U12-A blocked-eligibility disablement tests"
```

---

## Task 2: Delete U12-B controller tests (B1..B5), repurpose B6 as U14-B6

**Files:**
- Modify: `tests/ai-answer-controller.test.js` (delete lines ~1188 through B5; rewrite B6 in place)

- [ ] **Step 1: Locate the U12-B block**

Run: `grep -n "U12-B\|makeU12LocAndDoc" tests/ai-answer-controller.test.js`
Expected: comment header `// === U12 Safety — controller refuses scan on blocked page (defense in depth, layer 2) ===`, helper `function makeU12LocAndDoc`, then `U12-B1..B6`. File ends at the close of B6 (line ~1372).

- [ ] **Step 2: Delete U12-B1, B2, B3, B4, B5 and the `makeU12LocAndDoc` helper**

In `tests/ai-answer-controller.test.js`, delete the comment header `// === U12 Safety — controller refuses scan on blocked page ...`, the `function makeU12LocAndDoc(blockedPath) { ... }` helper, and the five tests `U12-B1`, `U12-B2`, `U12-B3`, `U12-B4`, `U12-B5`.

Stop at the test `U12-B6`. Do NOT delete `U12-B6` in this step.

- [ ] **Step 3: Replace U12-B6 with U14-B6**

Replace the entire `U12-B6` test (the only remaining U12 test in the file) with the following. This drops the blocked-page precondition and asserts only that `performScan` on a benign page does not affect Manage AI API Key click counting.

```js
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
```

Note: this test uses `makeBlockedPageFakeSidebar` which is defined elsewhere in the same file (a U11 helper). The name is a historical artifact — it produces a fake sidebar that exposes `_getHandlers()` and `_getLastOpenOptionsFailure()`. Do not rename the helper.

- [ ] **Step 4: Run the controller test file**

Run: `node --test tests/ai-answer-controller.test.js`

Expected: U14-B6 PASSES. Every other pre-existing test still PASSES. No U12-B test names appear in the output.

- [ ] **Step 5: Commit**

```
git add tests/ai-answer-controller.test.js
git commit -m "test(controller): drop U12-B blocked-scan tests, repurpose B6 as U14-B6"
```

---

## Task 3: Delete U12-C question-context tests (C1..C4, C6..C11), keep C5

**Files:**
- Modify: `tests/ai-question-context.test.js` (delete lines ~456–504 and ~525–618; keep C5 at line 505 unchanged)

- [ ] **Step 1: Locate the U12-C block**

Run: `grep -n "U12-C\|visibleBlockedDoc" tests/ai-question-context.test.js`
Expected output includes the header comment `// === U12 Safety — buildQuestionSnapshot fail-closed on blocked pages (layer 3) ===`, eleven test names `U12-C1..U12-C11`, and the helper `function visibleBlockedDoc`.

- [ ] **Step 2: Delete U12-C1, C2, C3, C4 (lines preceding C5)**

In `tests/ai-question-context.test.js`, delete the comment header `// === U12 Safety — buildQuestionSnapshot fail-closed on blocked pages (layer 3) ===` and the four tests `U12-C1`, `U12-C2`, `U12-C3`, `U12-C4`. Stop immediately before the comment `// REGRESSION` (which is part of C5's docstring) or before the `test('U12-C5: REGRESSION` line — whichever is first.

- [ ] **Step 3: Keep U12-C5 unchanged**

`U12-C5` asserts an eligible lecture URL still detects questions. This test remains valid and must not be modified. After this plan, this test continues to assert the same behavior with the same setup.

- [ ] **Step 4: Delete U12-C6 through U12-C11 and the `visibleBlockedDoc` helper**

After C5's closing `});`, delete:
- the comment block beginning `// --- VISIBLY-BLOCKED PAGES: ...`
- the `function visibleBlockedDoc(markerText, lectureUrl) { ... }` helper
- the six tests `U12-C6`, `U12-C7`, `U12-C8`, `U12-C9`, `U12-C10`, `U12-C11`

These extend to end-of-file (line ~618).

- [ ] **Step 5: Verify the file still parses and C5 still runs**

Run: `node --test tests/ai-question-context.test.js`

Expected: every remaining test PASSES, including `U12-C5`. No U12-C1..C4 or U12-C6..C11 names appear in the output.

- [ ] **Step 6: Commit**

```
git add tests/ai-question-context.test.js
git commit -m "test(question-context): drop U12-C blocked-snapshot tests, keep C5 regression"
```

---

## Task 4: Delete U12-LIVE, U13-D1, U13-D2 from `tests/ai-answer-tab.test.js`

**Files:**
- Modify: `tests/ai-answer-tab.test.js` (delete lines ~403–809, end of file)

- [ ] **Step 1: Locate the U12-LIVE / U13-D block**

Run: `grep -n "U12 LIVE\|U12-LIVE\|U13 DIAGNOSIS\|U13-D1\|U13-D2" tests/ai-answer-tab.test.js`

Expected output includes:
- `// === U12 LIVE — full-stack regression ...` ~line 403
- `test('U12-LIVE: ...` ~line 408
- `// === U13 DIAGNOSIS — production startup order ...` ~line 619
- `test('U13-D1: ...` ~line 624
- `// === U13 DIAGNOSIS — async ...` ~line 716
- `test('U13-D2: ...` ~line 718

- [ ] **Step 2: Delete from U12-LIVE through end of file**

In `tests/ai-answer-tab.test.js`, delete every line from the `// === U12 LIVE — full-stack regression against the actual screenshot URL ===` comment block (around line 403) through the final `});` of `U13-D2` at the end of the file (~line 809).

The test immediately before the deletion ends at line ~401 with:
```js
  assert.equal(panel.textContent.indexOf('DeepSeek'), -1, 'integration: no DeepSeek visible in sidebar');
});
```
Leave that test intact. After deletion, the file ends right after that `});`.

- [ ] **Step 3: Verify the file still parses and pre-U12 tests still run**

Run: `node --test tests/ai-answer-tab.test.js`

Expected: every remaining test PASSES. No `U12-LIVE`, `U13-D1`, `U13-D2` names appear in the output.

- [ ] **Step 4: Commit**

```
git add tests/ai-answer-tab.test.js
git commit -m "test(answer-tab): drop U12-LIVE and U13 diagnostic tests"
```

---

## Task 5: Remove blocked-page short-circuit from `lib/ai-question-context.js`

**Files:**
- Modify: `lib/ai-question-context.js` (lines ~219–245)

- [ ] **Step 1: Confirm the short-circuit location**

Run: `grep -n "U12 Layer 3\|blockState = isCurrentPageBlocked\|snap_blocked_" lib/ai-question-context.js`
Expected: three matches inside `buildQuestionSnapshot`.

- [ ] **Step 2: Remove the short-circuit and hard-set `eligible: true`**

Open `lib/ai-question-context.js`. Find the start of `buildQuestionSnapshot`:

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
```

Delete the entire comment block plus the `var blockState = ...; if (blockState && blockState.blocked) { ... }` early-return so the function starts:

```js
function buildQuestionSnapshot(rootEl, location, doc) {
  var origin = (location && location.origin) || '';
  var detected = (questionDetector && questionDetector.detectQuestions)
```

- [ ] **Step 3: Find and update the returned `page` block to hard-set `eligible: true` / `blockedReason: null`**

Further down in the same function, locate the existing returned `page` object inside the final `return { ... }`. The current code derives `eligible` from `_visibleBlockedReason` or similar; replace it so the returned snapshot always carries:

```js
page: {
  urlOrigin: origin,
  eligible: true,
  blockedReason: null,
},
```

If the existing `return` references additional `page` fields (e.g., `urlOrigin`), keep them in the same shape — only `eligible` and `blockedReason` are forced. If the existing code computes `eligible` via a local variable that is no longer used after this change, delete that local-variable computation too.

Run: `grep -n "page:" lib/ai-question-context.js` to confirm only one returned `page:` block remains.

- [ ] **Step 4: Run the question-context test suite**

Run: `node --test tests/ai-question-context.test.js`

Expected: every test PASSES, including `U12-C5` (eligible lecture URL still detects one question).

- [ ] **Step 5: Commit**

```
git add lib/ai-question-context.js
git commit -m "feat(ai-question-context): remove blocked-page snapshot short-circuit"
```

---

## Task 6: Remove blocked-page guards from `lib/ai-answer-controller.js`

**Files:**
- Modify: `lib/ai-answer-controller.js`:
  - `performScan` — lines ~37–56 (delete U12 guard block)
  - `performGenerate` — lines ~74–84 (delete `fresh.page.eligible === false` branch)
  - `performApply` — lines ~127–130 (delete `if (!fresh.page.eligible)` branch)
  - `wire()` — lines ~207–209 (delete initial-eligibility `isCurrentPageBlocked` call)

- [ ] **Step 1: Replace `performScan` body**

Open `lib/ai-answer-controller.js`. Find `function performScan()` (~line 37). Replace its entire body with the pre-U12 form:

```js
function performScan() {
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

The deleted block is the entire `var block = qc.isCurrentPageBlocked(loc, doc); if (block && block.blocked) { ... return; }` section.

- [ ] **Step 2: Remove the dead `fresh.page.eligible === false` branch from `performGenerate`**

Find `function performGenerate()` (~line 71). Inside, delete the block:

```js
// DELETE this block:
if (fresh.page.eligible === false) {
  sidebar.setAiPageEligibility({
    eligible: false,
    blockedReason: fresh.page.blockedReason,
    supportedCount: fresh.supportedCount,
    actionableCount: fresh.actionableCount,
  });
  sidebar.setAiApplyResult({ filled: 0, failed: 0, message: 'AI answer filling is disabled on graded or blocked assessment pages.' });
  return;
}
```

The next check (`if (fresh.token !== _activeSnapshot.token) { ... }`) stays.

- [ ] **Step 3: Remove the dead `fresh.page.eligible` branch from `performApply`**

Find `function performApply()` (~line 120). Delete the block:

```js
// DELETE this block:
if (!fresh.page.eligible) {
  sidebar.setAiApplyResult({ filled: 0, failed: 0, message: 'AI answer filling is disabled on graded or blocked assessment pages.' });
  return;
}
```

The token-equality check before it and the `compareLocalGuards` check after it both stay.

- [ ] **Step 4: Remove the initial-eligibility call from `wire()`**

Find `function wire()` (~line 176). Near the end, locate:

```js
refreshKeyStatus();
// Best-effort initial eligibility check (no scan):
var initBlock = qc.isCurrentPageBlocked(loc, doc);
sidebar.setAiPageEligibility({ eligible: !initBlock.blocked, blockedReason: initBlock.reason, supportedCount: 0 });
```

Delete the comment line and the two `initBlock` lines. The `refreshKeyStatus();` call stays. After deletion, `wire()` ends with `refreshKeyStatus();` plus the function's closing `}`.

Rationale: `_aiState.eligible` stays `null` until the first scan, which is fine — `_renderAiButtonStates` (after Task 7) no longer checks `eligible === false`, so a `null` eligibility does not disable any button.

- [ ] **Step 5: Run the controller test file**

Run: `node --test tests/ai-answer-controller.test.js`

Expected: every test PASSES, including `U14-B6`.

- [ ] **Step 6: Commit**

```
git add lib/ai-answer-controller.js
git commit -m "feat(ai-answer-controller): remove blocked-page guards from scan/generate/apply"
```

---

## Task 7: Remove eligibility-based disabling from `lib/sidebar.js`

**Files:**
- Modify: `lib/sidebar.js`:
  - `_renderAiButtonStates` (~lines 1065–1091)
  - `wireAiAnswer` (~line 1109, click-handler guard)
  - `setAiPageEligibility` (~lines 978–994, status-text branch)

- [ ] **Step 1: Replace `_renderAiButtonStates`**

Open `lib/sidebar.js`. Find `function _renderAiButtonStates()` (~line 1065). Replace it with:

```js
function _renderAiButtonStates() {
  if (!shadow) return;
  const scan = shadow.querySelector('[data-action="ai-scan"]');
  const gen = shadow.querySelector('[data-action="ai-generate"]');
  const cancel = shadow.querySelector('[data-action="ai-cancel"]');
  const apply = shadow.querySelector('[data-action="ai-apply"]');
  if (scan) {
    scan.disabled = !!_aiState.inFlight;
  }
  if (gen) {
    var actionable = _aiState.snapshot ? (_aiState.snapshot.actionableCount || 0) : 0;
    gen.disabled = !!(
      !_aiState.keyPresent ||
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
    _aiState.suggestions && _aiState.suggestions.length > 0
  );
}
```

Changes from current:
- `scan.disabled` no longer references `_aiState.eligible === false`.
- `gen.disabled` no longer references `_aiState.eligible === false`.
- `apply.disabled` no longer references `_aiState.eligible !== false`.

- [ ] **Step 2: Remove the click-handler guard inside `wireAiAnswer`**

Find the line inside `wireAiAnswer` (~line 1109):

```js
scan.addEventListener('click', function () { if (scan.disabled) return; if (_aiAnswerHandlers.onScan) _aiAnswerHandlers.onScan(); });
```

Replace with the pre-U12 form (drops the `if (scan.disabled) return;` guard, mirrors the other action handlers in the file):

```js
scan.addEventListener('click', function () { if (_aiAnswerHandlers.onScan) _aiAnswerHandlers.onScan(); });
```

Rationale: the disabled-button DOM behavior already suppresses native clicks; the explicit guard was added for U12's belt-and-suspenders blocked-page lockdown and is no longer needed.

- [ ] **Step 3: Remove the blocked-page status-text branch from `setAiPageEligibility`**

Find `function setAiPageEligibility(state)` (~line 978). Replace the status-text logic with the non-blocked branches only:

```js
function setAiPageEligibility(state) {
  _aiState.eligible = !!(state && state.eligible);
  _aiState.blockedReason = state && state.blockedReason || null;
  _aiState.supportedCount = (state && state.supportedCount) || 0;
  _aiState.actionableCount = (state && state.actionableCount) || 0;
  const status = shadow.querySelector('[data-role="ai-status"]');
  if (status) {
    if (_aiState.actionableCount === 0) {
      status.textContent = 'No unanswered supported questions found on this page.';
    } else {
      status.textContent = 'Ready: supported question page detected.';
    }
  }
  _renderAiButtonStates();
}
```

Changes from current:
- Deleted the `if (!_aiState.eligible) { status.textContent = 'AI answer filling is disabled on graded or blocked assessment pages.'; }` branch.
- Updated the success-case text from `Ready: supported ungraded question page detected.` to `Ready: supported question page detected.` (the "ungraded" qualifier no longer reflects behavior).
- All four `_aiState.*` writes preserved (function still updates state from incoming callers).

- [ ] **Step 4: Run the sidebar test file**

Run: `node --test tests/sidebar.test.js`

Expected: every test PASSES, including `U13-S1` and `U13-S2` (UI Revision label tests).

- [ ] **Step 5: Commit**

```
git add lib/sidebar.js
git commit -m "feat(sidebar): remove blocked-page disabling from Scan/Generate/Apply"
```

---

## Task 8: Add U14-LIVE positive-case test

**Files:**
- Modify: `tests/ai-answer-tab.test.js` (append at end of file)

- [ ] **Step 1: Append the U14-LIVE test**

Open `tests/ai-answer-tab.test.js` and append at end of file:

```js
// === U14 LIVE — Scan/Generate/Apply are enabled on what U12 considered a "blocked" URL ===

test('U14-LIVE: rendered sidebar on /assignment-submission/.../attempt detects questions and Scan/Generate/Apply work', async () => {
  const SIDEBAR_PATH_LOCAL = require.resolve('../lib/sidebar.js');
  const CONTROLLER_PATH_LOCAL = require.resolve('../lib/ai-answer-controller.js');
  delete require.cache[SIDEBAR_PATH_LOCAL];
  delete require.cache[CONTROLLER_PATH_LOCAL];

  const MARKER_Q1 = 'What does BW stand for in communication field?';
  const html = '<section><h3>Question 1</h3><p>' + MARKER_Q1 + '</p>'
    + '<label><input type="radio" name="r1">Bandwidth</label>'
    + '<label><input type="radio" name="r1">Beamwidth</label>'
    + '</section>';

  const { JSDOM } = require('jsdom');
  const url = 'https://www.coursera.org/learn/wireless-communications/assignment-submission/fryRH/practice-quiz-for-introduction-and-history-of-cellular-communication-systems/attempt';
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
  const a = dom.window.ClipboardCleaner;

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

  const openOptionsFn = (function () {
    const helper = require('../lib/ai-open-options-content.js');
    return helper.createOpenOptionsCallback({ runtime: dom.window.chrome.runtime });
  })();
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
    openOptionsFn: openOptionsFn,
  });
  controller.wire();
  await new Promise(function (r) { setTimeout(r, 0); });

  const host = dom.window.document.getElementById('ccp-host-root');
  const shadow = host.shadowRoot || host;
  const scan      = shadow.querySelector('[data-action="ai-scan"]');
  const gen       = shadow.querySelector('[data-action="ai-generate"]');
  const apply     = shadow.querySelector('[data-action="ai-apply"]');
  const configure = shadow.querySelector('[data-action="ai-key-configure"]');
  const statusEl  = shadow.querySelector('[data-role="ai-status"]');
  const scanPrev  = shadow.querySelector('[data-role="ai-scan-preview"]');

  // ASSERTION 1: Scan is enabled on the formerly-blocked URL.
  assert.equal(scan.disabled, false, 'Scan questions must be enabled');

  // ASSERTION 2: status text does NOT contain the old blocked-page message.
  assert.equal((statusEl.textContent || '').indexOf('disabled on graded or blocked'), -1,
    'status text must NOT contain the old blocked-page message');

  // ASSERTION 3: native Scan click populates the preview with the question prompt.
  scan.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.ok((scanPrev.textContent || '').indexOf(MARKER_Q1) !== -1,
    'native Scan click must render the question prompt into the preview (got: ' + JSON.stringify(scanPrev.textContent) + ')');
  assert.ok(scanPrev.querySelectorAll('li').length >= 1,
    'native Scan click must render at least one preview list item');

  // ASSERTION 4: after scan, Generate is enabled (key configured + actionable question).
  assert.equal(gen.disabled, false, 'Generate must be enabled after scan with key configured');

  // ASSERTION 5: U11 invariant preserved — Manage AI API Key still issues exactly one sanitized open-options message.
  configure.click();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(openOptionsCount, 1, 'Manage AI API Key click must issue exactly one ccp.ai.openOptions message');
  const openMsgs = sentMessages.filter(function (m) { return m && m.type === 'ccp.ai.openOptions'; });
  assert.deepEqual(openMsgs[0], { type: 'ccp.ai.openOptions' }, 'open-options message must be exactly {type:"ccp.ai.openOptions"} with no extra fields');

  // ASSERTION 6: Apply stays disabled (no suggestions yet — orthogonal invariant, not related to blocking).
  assert.equal(apply.disabled, true, 'Apply must remain disabled until suggestions exist');
});
```

- [ ] **Step 2: Run the test and verify PASS**

Run: `node --test --test-name-pattern="U14-LIVE" tests/ai-answer-tab.test.js`

Expected: 1 PASS.

If ASSERTION 4 fails because `keyStatus` settles after the test reads `gen.disabled`, add another `await new Promise(r => setTimeout(r, 0))` before the assertion. Verify before committing.

- [ ] **Step 3: Run the full file (regression)**

Run: `node --test tests/ai-answer-tab.test.js`

Expected: every test PASSES.

- [ ] **Step 4: Commit**

```
git add tests/ai-answer-tab.test.js
git commit -m "test(answer-tab): add U14-LIVE positive-case test for re-enabled blocked URLs"
```

---

## Task 9: Full repo regression + verification

**Files:** none modified.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: every test PASSES across every file. Count check: total tests should be down by ~22 from the pre-plan baseline (the deleted U12/U13 tests) and up by 1 (`U14-LIVE`). The `U14-B6` rename is a net zero. Final count varies by what counts as "pre-plan baseline" but the suite must be green.

- [ ] **Step 2: Autopilot regression**

Run: `node --test tests/autopilot-state.test.js tests/autopilot-timing.test.js tests/completion-confirmer.test.js tests/item-handlers.test.js tests/module-autopilot.test.js tests/module-scraper.test.js`

Expected: every test PASSES. Autopilot files were not touched — this is a sanity check that the AI-side changes didn't accidentally regress anything via shared globals.

- [ ] **Step 3: Provider-neutrality grep on public UI files**

Run: `grep -nE "DeepSeek|OpenAI|Anthropic|Claude|GPT-" lib/sidebar.js lib/ai-options-controller.js lib/ai-answer-controller.js lib/ai-content-listeners.js lib/ai-open-options-content.js lib/ai-open-options-background.js lib/ai-question-context.js lib/ui-revision.js options.html`

Expected: zero matches.

- [ ] **Step 4: Real-key leak scan**

Run: `grep -rE "sk-[A-Za-z0-9_]{16,}" --include="*.js" --include="*.json" --include="*.html" --include="*.md" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=Reference .`

Expected: zero matches.

- [ ] **Step 5: Dead-code grep to confirm `isCurrentPageBlocked` callers are gone**

Run: `grep -n "isCurrentPageBlocked" lib/`

Expected matches: only the definition + export inside `lib/ai-question-context.js`. No calls from `lib/sidebar.js`, `lib/ai-answer-controller.js`, or any other production file. (The function stays exported per the spec's "keep dormant" design choice.)

- [ ] **Step 6: Final commit summary (no new commit; just status check)**

Run: `git log --oneline -10`

Expected: the last 7 commits (Tasks 1–8) are visible in order, each with a focused message:
1. `test(sidebar): drop U12-A blocked-eligibility disablement tests`
2. `test(controller): drop U12-B blocked-scan tests, repurpose B6 as U14-B6`
3. `test(question-context): drop U12-C blocked-snapshot tests, keep C5 regression`
4. `test(answer-tab): drop U12-LIVE and U13 diagnostic tests`
5. `feat(ai-question-context): remove blocked-page snapshot short-circuit`
6. `feat(ai-answer-controller): remove blocked-page guards from scan/generate/apply`
7. `feat(sidebar): remove blocked-page disabling from Scan/Generate/Apply`
8. `test(answer-tab): add U14-LIVE positive-case test for re-enabled blocked URLs`

Plus the design-spec commit from before this plan started.

---

## Task 10: Live verification in Chrome (user-driven)

**Files:** none modified.

This task cannot be automated. Implementer reports it back to the user for execution.

- [ ] **Step 1: Reload the extension**

Open `chrome://extensions`, click Reload on Clipboard Cleaner.

- [ ] **Step 2: Verify the UI Revision label still appears**

Open the sidebar, switch to Diagnostics tab. Confirm `UI Revision: U13` is visible. (Not bumped by this plan — U13 stays current.)

- [ ] **Step 3: Navigate to the formerly-blocked URL**

URL: `https://www.coursera.org/learn/wireless-communications/assignment-submission/fryRH/practice-quiz-for-introduction-and-history-of-cellular-communication-systems/attempt`

- [ ] **Step 4: Confirm visible behavior**

- Status pill text is the normal `Click Scan questions...` / `Ready: supported question page detected.` text — NOT `AI answer filling is disabled on graded or blocked assessment pages.`.
- `Scan questions` button is enabled.
- Click Scan — the preview populates with detected questions and prompt text.
- `Generate suggestions` button becomes enabled (assuming an AI API Key is configured).
- `Manage AI API Key` button still opens the options page on click.

If any of these fail, the implementer reports back; do not retry on your own.

---

## Self-Review Notes

- **Spec coverage:**
  - §3.1 `_renderAiButtonStates` change → Task 7 Step 1.
  - §3.1 click-handler guard removal → Task 7 Step 2.
  - §3.1 `setAiPageEligibility` status-text branch removal → Task 7 Step 3.
  - §3.2 controller `performScan` guard → Task 6 Step 1.
  - §3.2 controller `performGenerate` dead branch → Task 6 Step 2.
  - §3.2 controller `performApply` dead branch → Task 6 Step 3.
  - §3.2 `wire()` initial `isCurrentPageBlocked` call → Task 6 Step 4.
  - §3.3 `buildQuestionSnapshot` short-circuit + hard-set → Task 5 Steps 2–3.
  - §4.1 Sidebar deletions → Task 1.
  - §4.1 Controller B1..B5 deletions + §4.2 B6 repurpose → Task 2.
  - §4.1 Question-context C1..C4 + C6..C11 deletions → Task 3.
  - §4.1 Answer-tab U12-LIVE + U13-D deletions → Task 4.
  - §4.3 U14-LIVE positive test → Task 8.
  - §5 order of operations: Tasks 1–8 follow §5's ordering (delete tests first so suite doesn't break, then question-context, then controller, then sidebar, then add positive test).
  - §5 live verification → Task 10.
  - §6 risks: documented in spec; not actioned in plan (correct — they are accepted risks).

- **Placeholder scan:** every step contains either a full code block or a precise `grep`/`node --test` command with expected output. No `TODO`, `TBD`, "add appropriate", or "similar to Task N".

- **Type / symbol consistency:**
  - `setAiPageEligibility` keeps the same call shape (`{ eligible, blockedReason, supportedCount, actionableCount }`) everywhere it's called from in Task 6 and read by in Task 7.
  - `_aiState.eligible` is written as a boolean in `setAiPageEligibility` (Task 7 Step 3) and never read as `=== false` anywhere after Task 7.
  - `makeBlockedPageFakeSidebar` helper name is preserved in Task 2 Step 3 (kept as historical artifact name — exposes `_getHandlers()` and `_getLastOpenOptionsFailure()` regardless of the "blocked-page" naming).
  - The U14-LIVE test in Task 8 references `lib/ai-open-options-content.js` `createOpenOptionsCallback`, which is the same U11 helper used by `content.js` — confirmed unchanged.

- **Scope guard reaffirmed:** the plan touches only the 3 production files and 4 test files listed in Section 0. No `manifest.json`, no Autopilot file, no `content.js`, no background service worker, no options page.
