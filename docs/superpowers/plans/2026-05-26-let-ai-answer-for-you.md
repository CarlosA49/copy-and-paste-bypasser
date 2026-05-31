# "Let AI answer for you" Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a sixth sidebar tab named exactly "Let AI answer for you" that lets the user enter a DeepSeek API key, scan ungraded supported question pages for unanswered questions, send a sanitized snapshot to DeepSeek via the background service worker, preview the returned answers, and apply them through the existing answer-applier pipeline. Never auto-submits; refuses graded/blocked pages.

**Architecture:**
- New modules: `lib/ai-question-context.js` (eligibility + sanitized snapshot + snapshot token), `lib/ai-answer-validator.js` (validate model JSON against snapshot), `lib/deepseek-client.js` (background-safe HTTPS client).
- New background namespace `ccp.ai.*` runs in a **separate** `chrome.runtime.onMessage` listener — never touches `autopilot.state`, the Autopilot authority, `RUN_KEY`/`SETTINGS_KEY`, or `publicSurface` fencing.
- API key stored in `chrome.storage.session` (transient by default). Optional `chrome.storage.local` "remember on device" only via explicit checkbox.
- Sanitized snapshot is built from `questionDetector.detectQuestions()` output stripped of DOM nodes. DeepSeek receives only locally-generated IDs, prompts, and option labels — never selectors.
- Returned JSON is validated against the snapshot (question IDs, option IDs, type consistency), then converted into a new additive entry point on `lib/answer-applier.js` called `applyStructuredAnswers()` that reuses every existing matcher/filter/event-dispatch path.
- Eligibility uses existing `moduleScraper.isBlockedAssessmentItem()` plus a thin wrapper `isCurrentPageBlocked()` that builds an item from `location.href` + the page title.

**Tech Stack:** Plain ES5-ish JS (matches repo style), Node `node:test` + `jsdom` for tests, `chrome.runtime.sendMessage` + `chrome.storage.session` + `fetch()` in the MV3 service worker. No new build tooling.

**Reused modules/functions:**
- `lib/sidebar.js` — `mount()`, `wireTabs()` (auto-picks new `[data-tab]`), `setActiveTab()`, the `setAutopilotHandlers()` registry pattern (we mirror it as `setAiAnswerHandlers()`).
- `lib/question-detector.js` — `detectQuestions(root)` returns `{questionNumber, type, titleText, fullText, choices:[{el,text,index}], targets:[HTMLElement], container}`. We consume read-only.
- `lib/answer-applier.js` — existing `applyAnswers(rawText, root, opts)` stays untouched; we add `applyStructuredAnswers(structured, root, opts)` that takes pre-matched values keyed by `questionNumber` and runs the same per-type apply loops.
- `lib/module-scraper.js` — `isBlockedAssessmentItem({kind,url,title})` plus its `BLOCKED_URL_PATTERNS` / `BLOCKED_TITLE_PATTERNS` / `BLOCKED_KINDS` constants.
- `background.js` — existing `autopilot.state` listener stays. A second `addListener` block dispatches `ccp.ai.*`.

**Files to be created:**
- `lib/ai-question-context.js`
- `lib/ai-answer-validator.js`
- `lib/deepseek-client.js`
- `tests/ai-question-context.test.js`
- `tests/ai-answer-validator.test.js`
- `tests/deepseek-client.test.js`
- `tests/ai-answer-tab.test.js` (sidebar UI + content wiring)

**Files to be modified (minimal):**
- `manifest.json` — add `host_permissions: ["https://api.deepseek.com/*"]`.
- `lib/sidebar.js` — add tab button + panel HTML + `wireAiAnswer()` + `setAiAnswerHandlers()` + a few state setters; **no** existing tab changed.
- `lib/answer-applier.js` — add `applyStructuredAnswers()` next to `applyAnswers()` and export it. Existing function untouched.
- `tests/answer-applier.test.js` — extend with structured-input cases.
- `tests/sidebar.test.js` — extend with new-tab cases (existing tabs assertions remain).
- `background.js` — add a second message listener block for `ccp.ai.*`.
- `content.js` — wire AI scan/generate/apply controller (uses `chrome.runtime.sendMessage`).

**Out of scope / forbidden touches:**
- `lib/autopilot-*.js`, `lib/module-autopilot.js`, `lib/completion-confirmer.js`, `lib/item-handlers.js`, `lib/module-scraper.js` (read-only consumption only — no edits unless a step explicitly says so).
- The dirty Autopilot worktree state. Do not run `git reset`, `git clean`, `git revert`, `git commit`, `git push`, or `git checkout`. Do not pause/reorder/recreate Autopilot PHASE 19 work.
- No live Coursera test against a graded assessment. No live Autopilot smoke test.

**DeepSeek API constants used (must verify before merge):**
- Base URL: `https://api.deepseek.com`
- Endpoint: `POST /chat/completions`
- Auth header: `Authorization: Bearer <key>`
- Model: default constant `DEEPSEEK_MODEL_ID = 'deepseek-chat'` — **the implementer must open https://api-docs.deepseek.com/ and confirm the currently recommended model ID for JSON output before the final commit, and update the constant if needed**. Do not hard-code without confirming.
- Response format: `response_format: { type: 'json_object' }`. The system prompt MUST include the word "json" and an example schema per DeepSeek's JSON-mode requirement.

---

## Task 1 — Add manifest host permission for DeepSeek

**Files:**
- Modify: `manifest.json`

- [ ] **Step 1: Read current manifest**

Run: open `manifest.json` and locate the `"permissions": ["storage"]` line. There is currently no `host_permissions` field.

- [ ] **Step 2: Add host_permissions**

Edit `manifest.json` to add a `host_permissions` array immediately after the `permissions` array. Final shape of those two fields:

```json
"permissions": ["storage"],
"host_permissions": ["https://api.deepseek.com/*"],
```

Do not broaden the existing `content_scripts.matches` or other permission fields.

- [ ] **Step 3: Verify the file still parses as JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'));console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 4: Do NOT commit yet**

The user has explicitly forbidden commits during this feature work. Continue without committing.

---

## Task 2 — `lib/ai-question-context.js`: snapshot + eligibility (RED tests first)

**Files:**
- Create: `lib/ai-question-context.js`
- Create: `tests/ai-question-context.test.js`

This module wraps existing detectors and exposes:

```
{
  isCurrentPageBlocked(location, document) -> { blocked: boolean, reason: string|null }
  buildQuestionSnapshot(root, location, document) -> { token, page, questions, supportedCount, unsupportedCount }
  // questions[*]: { id: 'q<N>', order, questionNumber, type, prompt, options?: [{id:'q<N>o<M>', label}], answerFormatHint?, supported, alreadyAnswered }
  // token: deterministic hash of {url, [questionNumber+type+prompt+optionLabels...]} so Apply can detect stale snapshots
  sanitizeForRequest(snapshot) -> { page, questions } // strips per-question internal flags not needed by the model
}
```

`isCurrentPageBlocked` builds a synthetic item `{ url: location.href, title: (document.title||''), kind: undefined }` and runs it through `moduleScraper.isBlockedAssessmentItem()`. If blocked, it reports `reason` from a small label table mirroring `module-autopilot.blockReasonLabel()` but defined locally (we do NOT depend on autopilot internals).

`buildQuestionSnapshot` calls `questionDetector.detectQuestions(root)` and maps each entry to a sanitized record. It strips `el`, `targets`, `container`. `id` is `'q' + questionNumber`. For choices, each option `id` is `'q' + questionNumber + 'o' + index`. `alreadyAnswered` is computed by inspecting the actual DOM elements (radio `.checked`, text-input `.value.trim() !== ''`) **inside this module only** and recorded as a boolean — the value itself is never put in the sanitized output.

`supported` is true for `single_choice`, `multiple_choice`, and `math_input` (the three the answer-applier handles). Other types are marked `supported:false` and excluded from the model request by `sanitizeForRequest`.

Token: `'snap_' + djb2Hash(JSON.stringify(...))` over `[url, [{questionNumber,type,prompt,optionLabels}...]]` — deterministic; recomputed on rescan; compared against the snapshot used for Apply.

- [ ] **Step 1: Write the failing tests**

Create `tests/ai-question-context.test.js` with the following content:

```javascript
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ctx = require('../lib/ai-question-context.js');

function doc(html, url) {
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', { url: url || 'https://www.coursera.org/learn/x/lecture/v1/intro' });
  return { document: dom.window.document, location: dom.window.location, window: dom.window };
}

function radio(qNum, choices) {
  let s = '<h3>Question ' + qNum + '</h3><p>Pick one ' + qNum + '</p>';
  for (let i = 0; i < choices.length; i++) {
    s += '<label><input type="radio" name="q' + qNum + '">' + choices[i] + '</label>';
  }
  return '<section>' + s + '</section>';
}

test('isCurrentPageBlocked: gradedLti URL is blocked', () => {
  const d = doc('<h1>Anything</h1>', 'https://www.coursera.org/learn/course/gradedLti/abc/xyz');
  const r = ctx.isCurrentPageBlocked(d.location, d.document);
  assert.equal(r.blocked, true);
  assert.ok(r.reason && r.reason.length > 0);
});

test('isCurrentPageBlocked: page titled "Graded Assignment" is blocked even on lecture URL', () => {
  const d = doc('<h1>Graded Assignment</h1>', 'https://www.coursera.org/learn/course/lecture/v1/intro');
  d.document.title = 'Graded Assignment';
  const r = ctx.isCurrentPageBlocked(d.location, d.document);
  assert.equal(r.blocked, true);
});

test('isCurrentPageBlocked: page titled "Peer Review" is blocked', () => {
  const d = doc('<h1>Peer Review your work</h1>', 'https://www.coursera.org/learn/course/lecture/v1/intro');
  d.document.title = 'Peer Review';
  const r = ctx.isCurrentPageBlocked(d.location, d.document);
  assert.equal(r.blocked, true);
});

test('isCurrentPageBlocked: ordinary lecture page is NOT blocked', () => {
  const d = doc('<h1>Welcome to the lesson</h1>', 'https://www.coursera.org/learn/course/lecture/v1/intro');
  d.document.title = 'Lecture 1';
  const r = ctx.isCurrentPageBlocked(d.location, d.document);
  assert.equal(r.blocked, false);
  assert.equal(r.reason, null);
});

test('buildQuestionSnapshot: produces stable IDs and option labels for radio questions', () => {
  const d = doc(radio(1, ['Alpha', 'Beta', 'Gamma']));
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.questions.length, 1);
  assert.equal(snap.questions[0].id, 'q1');
  assert.equal(snap.questions[0].type, 'single_choice');
  assert.equal(snap.questions[0].options.length, 3);
  assert.equal(snap.questions[0].options[0].id, 'q1o0');
  assert.equal(snap.questions[0].options[0].label, 'Alpha');
  assert.equal(snap.questions[0].supported, true);
});

test('buildQuestionSnapshot: checkbox question is multiple_choice', () => {
  const html = '<section><h3>Question 2</h3><p>Pick many</p>'
    + '<label><input type="checkbox" name="q2">A</label>'
    + '<label><input type="checkbox" name="q2">B</label>'
    + '<label><input type="checkbox" name="q2">C</label>'
    + '</section>';
  const d = doc(html);
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.questions[0].type, 'multiple_choice');
  assert.equal(snap.questions[0].options.length, 3);
});

test('buildQuestionSnapshot: text question prompt but no current value', () => {
  const html = '<section><h3>Question 3</h3><p>Enter the value of x</p>'
    + '<input type="text" value="user-typed-secret">'
    + '</section>';
  const d = doc(html);
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.questions[0].type, 'math_input');
  assert.equal(typeof snap.questions[0].prompt, 'string');
  const serialized = JSON.stringify(snap.questions[0]);
  assert.equal(serialized.indexOf('user-typed-secret'), -1, 'snapshot must not leak field value');
});

test('buildQuestionSnapshot: alreadyAnswered=true is set for pre-filled inputs', () => {
  const html = '<section><h3>Question 4</h3><p>Done question</p>'
    + '<input type="text" value="42">'
    + '</section>';
  const d = doc(html);
  const snap = ctx.buildQuestionSnapshot(d.document.body, d.location, d.document);
  assert.equal(snap.questions[0].alreadyAnswered, true);
});

test('sanitizeForRequest: strips unsupported questions and internal flags', () => {
  const snap = {
    token: 'snap_abc',
    page: { urlOrigin: 'https://www.coursera.org', eligible: true, blockedReason: null },
    questions: [
      { id: 'q1', order: 1, questionNumber: 1, type: 'single_choice', prompt: 'p', options: [{ id: 'q1o0', label: 'a' }], supported: true, alreadyAnswered: false },
      { id: 'q2', order: 2, questionNumber: 2, type: 'unknown', prompt: 'p', supported: false, alreadyAnswered: false },
    ],
    supportedCount: 1,
    unsupportedCount: 1,
  };
  const out = ctx.sanitizeForRequest(snap);
  assert.equal(out.questions.length, 1);
  assert.equal(out.questions[0].id, 'q1');
  assert.equal('alreadyAnswered' in out.questions[0], false);
  assert.equal('supported' in out.questions[0], false);
});

test('token: identical snapshot inputs produce identical tokens', () => {
  const d1 = doc(radio(1, ['A', 'B']));
  const d2 = doc(radio(1, ['A', 'B']));
  const s1 = ctx.buildQuestionSnapshot(d1.document.body, d1.location, d1.document);
  const s2 = ctx.buildQuestionSnapshot(d2.document.body, d2.location, d2.document);
  assert.equal(s1.token, s2.token);
});

test('token: changing an option label changes the token', () => {
  const d1 = doc(radio(1, ['A', 'B']));
  const d2 = doc(radio(1, ['A', 'CHANGED']));
  const s1 = ctx.buildQuestionSnapshot(d1.document.body, d1.location, d1.document);
  const s2 = ctx.buildQuestionSnapshot(d2.document.body, d2.location, d2.document);
  assert.notEqual(s1.token, s2.token);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test tests/ai-question-context.test.js`
Expected: FAIL with "Cannot find module '../lib/ai-question-context.js'".

- [ ] **Step 3: Implement `lib/ai-question-context.js`**

Create the file with this content:

```javascript
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./module-scraper.js'),
      require('./question-detector.js')
    );
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.aiQuestionContext = factory(
      root.ClipboardCleaner.moduleScraper,
      root.ClipboardCleaner.questionDetector
    );
  }
}(typeof self !== 'undefined' ? self : this, function (moduleScraper, questionDetector) {

  var SUPPORTED_TYPES = { single_choice: true, multiple_choice: true, math_input: true };

  function djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = (((h << 5) + h) + str.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }

  function blockReasonFor(url, title) {
    var u = url || '';
    var t = title || '';
    if (/\/gradedLti\//i.test(u)) return 'graded item';
    if (/\/peer\//i.test(u) || /\bpeer\b/i.test(t) || /\breview your peers\b/i.test(t)) return 'peer review';
    if (/\/programming\//i.test(u)) return 'programming assignment';
    if (/\/exam\//i.test(u) || /\bexam\b/i.test(t)) return 'exam';
    if (/\/quiz\//i.test(u) || /\bquiz\b/i.test(t)) return 'quiz';
    if (/\/discussion(Prompt)?\//i.test(u) || /\bdiscussion prompt\b/i.test(t)) return 'discussion prompt';
    if (/\/assignment-submission\//i.test(u) || /\bassignment\b/i.test(t) || /\bgraded\b/i.test(t)) return 'graded assignment';
    return 'blocked';
  }

  function isCurrentPageBlocked(location, doc) {
    var url = (location && location.href) || '';
    var title = (doc && doc.title) || '';
    var item = { url: url, title: title };
    var blocked = !!(moduleScraper && moduleScraper.isBlockedAssessmentItem && moduleScraper.isBlockedAssessmentItem(item));
    return { blocked: blocked, reason: blocked ? blockReasonFor(url, title) : null };
  }

  function isAlreadyAnswered(q) {
    if (!q) return false;
    if (q.type === 'single_choice' || q.type === 'multiple_choice') {
      for (var i = 0; i < (q.choices || []).length; i++) {
        var inp = q.choices[i].el;
        if (inp && (inp.checked === true)) return true;
      }
      return false;
    }
    if (q.type === 'math_input') {
      for (var j = 0; j < (q.targets || []).length; j++) {
        var t = q.targets[j];
        if (!t) continue;
        if (typeof t.value === 'string' && t.value.trim() !== '') return true;
        var ce = t.getAttribute && t.getAttribute('contenteditable');
        if (ce && t.textContent && t.textContent.trim() !== '') return true;
      }
      return false;
    }
    return false;
  }

  function buildQuestionSnapshot(rootEl, location, doc) {
    var detected = (questionDetector && questionDetector.detectQuestions)
      ? questionDetector.detectQuestions(rootEl) : [];
    var origin = '';
    try { origin = (location && location.origin) || ''; } catch (_) {}
    var blockState = isCurrentPageBlocked(location, doc);

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

    var supportedCount = 0, unsupportedCount = 0;
    for (var k = 0; k < questions.length; k++) {
      if (questions[k].supported) supportedCount++; else unsupportedCount++;
    }

    var tokenSeed = JSON.stringify([
      (location && location.href) || '',
      questions.map(function (e) {
        return [e.questionNumber, e.type, e.prompt, (e.options || []).map(function (o) { return o.label; })];
      })
    ]);

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
    };
  }

  function sanitizeForRequest(snapshot) {
    var clean = [];
    for (var i = 0; i < snapshot.questions.length; i++) {
      var q = snapshot.questions[i];
      if (!q.supported) continue;
      if (q.alreadyAnswered) continue;
      var out = {
        id: q.id,
        order: q.order,
        type: q.type,
        prompt: q.prompt,
      };
      if (q.options) out.options = q.options.map(function (o) { return { id: o.id, label: o.label }; });
      if (q.answerFormatHint) out.answerFormatHint = q.answerFormatHint;
      clean.push(out);
    }
    return {
      page: { urlOrigin: snapshot.page.urlOrigin, eligible: snapshot.page.eligible },
      questions: clean,
      token: snapshot.token,
    };
  }

  return {
    isCurrentPageBlocked: isCurrentPageBlocked,
    buildQuestionSnapshot: buildQuestionSnapshot,
    sanitizeForRequest: sanitizeForRequest,
  };
}));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test tests/ai-question-context.test.js`
Expected: All 11 tests PASS.

- [ ] **Step 5: Do NOT commit**

Continue to next task without any git operation.

---

## Task 3 — `lib/answer-applier.js`: additive `applyStructuredAnswers()` (RED tests first)

**Files:**
- Modify: `lib/answer-applier.js` (append a second exported function; do NOT alter existing exports or `applyAnswers`)
- Modify: `tests/answer-applier.test.js` (append new tests; existing tests must remain green)

Goal: accept a structured per-question answer map keyed by `questionNumber`, then drive the same matchers/event-dispatchers used by `applyAnswers`. The structured input shape:

```
applyStructuredAnswers([
  { questionNumber: 1, type: 'single_choice', choiceText: 'Beta' },
  { questionNumber: 2, type: 'multiple_choice', choiceTexts: ['A', 'C'] },
  { questionNumber: 3, type: 'math_input', value: '0.0352' },
], rootEl, { verbose: false }) -> { detectedQuestions, results, summary }
```

Implementation MUST call `questionDetector.detectQuestions(rootEl)` and then dispatch each structured entry to the same per-type code paths the existing `applyAnswers` uses. Do not duplicate visibility filtering, click logic, or event dispatch — call the same helpers.

- [ ] **Step 1: Read `lib/answer-applier.js` to identify the per-type helper functions**

Open `lib/answer-applier.js` and locate:
- The single-choice apply branch (around line 147) — note the helper that performs the radio click + change-event dispatch.
- The multiple-choice apply branch — note the checkbox-tick helper.
- The text/math input branch (around lines 170–210) — note the fill + retry + computed-value-normalization helper.

If those branches are inlined inside `applyAnswers`, extract them into private named functions (`_applySingleChoice(q, choiceText, opts)`, `_applyMultipleChoice(q, choiceTexts, opts)`, `_applyMathInput(q, value, opts)`) **without changing behavior** so both `applyAnswers` and `applyStructuredAnswers` can call them. This is the only refactor of the existing function — it must be behavior-preserving.

- [ ] **Step 2: Write the failing tests**

Append to `tests/answer-applier.test.js`:

```javascript
// === structured-input entry tests (Let AI answer for you feature) ===

const { applyStructuredAnswers } = require('../lib/answer-applier.js');

function makeRadio(qNum, choices) {
  let s = '<section><h3>Question ' + qNum + '</h3><p>Pick</p>';
  for (let i = 0; i < choices.length; i++) {
    s += '<label><input type="radio" name="r' + qNum + '">' + choices[i] + '</label>';
  }
  return s + '</section>';
}

function makeCheckbox(qNum, choices) {
  let s = '<section><h3>Question ' + qNum + '</h3><p>Pick many</p>';
  for (let i = 0; i < choices.length; i++) {
    s += '<label><input type="checkbox" name="c' + qNum + '">' + choices[i] + '</label>';
  }
  return s + '</section>';
}

function makeText(qNum) {
  return '<section><h3>Question ' + qNum + '</h3><p>Enter value</p><input type="text" id="t' + qNum + '"></section>';
}

test('applyStructuredAnswers: single-choice selects radio by choice text', () => {
  const d = dom(makeRadio(1, ['Alpha', 'Beta', 'Gamma']));
  const out = applyStructuredAnswers(
    [{ questionNumber: 1, type: 'single_choice', choiceText: 'Beta' }],
    d.body, { verbose: false }
  );
  assert.equal(out.summary.filled, 1);
  const inputs = d.querySelectorAll('input[type="radio"]');
  assert.equal(inputs[1].checked, true);
});

test('applyStructuredAnswers: multiple-choice ticks the named checkboxes', () => {
  const d = dom(makeCheckbox(1, ['A', 'B', 'C', 'D']));
  const out = applyStructuredAnswers(
    [{ questionNumber: 1, type: 'multiple_choice', choiceTexts: ['A', 'C'] }],
    d.body, { verbose: false }
  );
  assert.equal(out.summary.filled, 1);
  const cb = d.querySelectorAll('input[type="checkbox"]');
  assert.equal(cb[0].checked, true);
  assert.equal(cb[1].checked, false);
  assert.equal(cb[2].checked, true);
  assert.equal(cb[3].checked, false);
});

test('applyStructuredAnswers: text/math input fills value', () => {
  const d = dom(makeText(1));
  const out = applyStructuredAnswers(
    [{ questionNumber: 1, type: 'math_input', value: '0.0352' }],
    d.body, { verbose: false }
  );
  assert.equal(out.summary.filled, 1);
  assert.equal(d.getElementById('t1').value, '0.0352');
});

test('applyStructuredAnswers: maps by questionNumber even when input order differs from DOM order', () => {
  const d = dom(makeText(1) + makeText(2));
  const out = applyStructuredAnswers([
    { questionNumber: 2, type: 'math_input', value: 'two' },
    { questionNumber: 1, type: 'math_input', value: 'one' },
  ], d.body, { verbose: false });
  assert.equal(out.summary.filled, 2);
  assert.equal(d.getElementById('t1').value, 'one');
  assert.equal(d.getElementById('t2').value, 'two');
});

test('applyStructuredAnswers: unknown questionNumber is skipped; other answers still applied', () => {
  const d = dom(makeText(1));
  const out = applyStructuredAnswers([
    { questionNumber: 99, type: 'math_input', value: 'ghost' },
    { questionNumber: 1, type: 'math_input', value: 'real' },
  ], d.body, { verbose: false });
  assert.equal(d.getElementById('t1').value, 'real');
  // 99 has no matching question — skipped in summary, not a thrown error.
  assert.ok(out.summary.filled >= 1);
});

test('applyStructuredAnswers: never clicks submit/continue/check buttons', () => {
  const d = dom(makeText(1)
    + '<button id="submit">Submit</button>'
    + '<button id="continue">Continue</button>'
    + '<button id="check">Check</button>'
  );
  let clicked = false;
  ['submit','continue','check'].forEach(function (id) {
    d.getElementById(id).addEventListener('click', function () { clicked = true; });
  });
  applyStructuredAnswers([{ questionNumber: 1, type: 'math_input', value: 'x' }], d.body, { verbose: false });
  assert.equal(clicked, false);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx node --test tests/answer-applier.test.js`
Expected: New tests FAIL with `applyStructuredAnswers is not a function` or destructure error. Existing tests in this file must still PASS.

- [ ] **Step 4: Implement `applyStructuredAnswers` in `lib/answer-applier.js`**

After the existing `applyAnswers` function and before the `const api = { applyAnswers: applyAnswers };` line, add:

```javascript
function _findQuestionByNumber(questions, n) {
  for (var i = 0; i < questions.length; i++) {
    if (questions[i].questionNumber === n) return questions[i];
  }
  return null;
}

function applyStructuredAnswers(structuredList, rootEl, options) {
  options = options || {};
  var verbose = options.verbose !== false;
  var questions = questionDetector.detectQuestions(rootEl);
  var results = [];
  var filled = 0, failed = 0;

  for (var i = 0; i < (structuredList || []).length; i++) {
    var item = structuredList[i];
    var q = _findQuestionByNumber(questions, item.questionNumber);
    if (!q) {
      results.push({ questionNumber: item.questionNumber, status: 'no-question' });
      continue;
    }
    if (q.type !== item.type) {
      results.push({ questionNumber: q.questionNumber, type: q.type, status: 'type-mismatch', requested: item.type });
      failed++;
      continue;
    }
    var r;
    if (item.type === 'single_choice') {
      r = _applySingleChoice(q, item.choiceText, { verbose: verbose });
    } else if (item.type === 'multiple_choice') {
      r = _applyMultipleChoice(q, item.choiceTexts || [], { verbose: verbose });
    } else if (item.type === 'math_input') {
      r = _applyMathInput(q, item.value, { verbose: verbose, maxRetries: options.maxRetries || 3 });
    } else {
      results.push({ questionNumber: q.questionNumber, type: q.type, status: 'unsupported-type' });
      continue;
    }
    results.push(r);
    if (r.status === 'selected' || r.status === 'filled') filled++;
    else failed++;
  }

  return {
    detectedQuestions: questions.length,
    parsedAnswers: (structuredList || []).length,
    mode: 'structured',
    results: results,
    summary: { total: questions.length, filled: filled, failed: failed, missingAnswers: 0, missingQuestions: 0 },
  };
}
```

Update the export object:

```javascript
const api = { applyAnswers: applyAnswers, applyStructuredAnswers: applyStructuredAnswers };
```

If the original `applyAnswers` body inlined the per-type branches, extract `_applySingleChoice`, `_applyMultipleChoice`, `_applyMathInput` as private helpers that BOTH `applyAnswers` and `applyStructuredAnswers` call. Verify the original tests still pass — that proves the refactor is behavior-preserving.

- [ ] **Step 5: Run all answer-applier tests**

Run: `npx node --test tests/answer-applier.test.js`
Expected: ALL tests (old + new) PASS.

- [ ] **Step 6: Do NOT commit**

---

## Task 4 — `lib/ai-answer-validator.js`: validate model JSON (RED tests first)

**Files:**
- Create: `lib/ai-answer-validator.js`
- Create: `tests/ai-answer-validator.test.js`

Module surface:

```
validateAndMap(rawResponseTextOrObject, snapshot) -> {
  ok: boolean,
  reason?: 'invalid-json' | 'invalid-schema' | 'stale-snapshot',
  suggestions: [
    {
      questionNumber: number,
      type: 'single_choice'|'multiple_choice'|'math_input',
      explanation: string,
      confidence: 'low'|'medium'|'high'|null,
      // exactly one of:
      choiceText?: string,
      choiceTexts?: string[],
      value?: string,
      mappingStatus: 'matched' | 'unsupported' | 'missing-answer' | 'ambiguous' | 'unknown-question' | 'unknown-option' | 'wrong-type',
      applicable: boolean,
    }
  ],
  rejectedCount: number,
}

extractStrictJson(text) -> object | null
  // accepts plain JSON; tolerates one outer ```json ... ``` fence as a deliberate fallback
```

Hard rules enforced:
- Only `single_choice`, `multiple_choice`, `math_input` types accepted.
- For `single_choice`: exactly one `option_ids[0]` must exist in the snapshot's options for that question; resolves to `choiceText = options.find(...).label`.
- For `multiple_choice`: every `option_ids[i]` must exist in the snapshot's options for that question; resolves to `choiceTexts`.
- For `math_input`: `value` must be a string (trimmed, non-empty); resolves to `value`.
- Any deviation → `applicable: false` with a `mappingStatus` explaining why. **Never throw**.
- The model may NOT supply `selector`, `xpath`, `action`, `url`, `submit`, `script`, `html` — if any present, set `applicable: false`, mappingStatus `'unsupported'`.
- If `snapshot.token` does not equal a token argument passed at apply-time, validateAndMap returns `{ ok:false, reason:'stale-snapshot' }`. (We compare in this module; the consumer passes the active snapshot.)

- [ ] **Step 1: Write failing tests**

Create `tests/ai-answer-validator.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../lib/ai-answer-validator.js');

const SNAP = {
  token: 'snap_abc',
  page: { urlOrigin: 'https://www.coursera.org', eligible: true },
  questions: [
    { id: 'q1', order: 1, questionNumber: 1, type: 'single_choice', prompt: 'p1',
      options: [
        { id: 'q1o0', label: 'Alpha' },
        { id: 'q1o1', label: 'Beta' },
      ], supported: true },
    { id: 'q2', order: 2, questionNumber: 2, type: 'multiple_choice', prompt: 'p2',
      options: [
        { id: 'q2o0', label: 'A' },
        { id: 'q2o1', label: 'B' },
        { id: 'q2o2', label: 'C' },
      ], supported: true },
    { id: 'q3', order: 3, questionNumber: 3, type: 'math_input', prompt: 'p3', supported: true },
  ],
};

test('valid response maps cleanly', () => {
  const resp = {
    answers: [
      { question_id: 'q1', answer: { type: 'single_choice', option_ids: ['q1o1'] }, explanation: 'because', confidence: 'high' },
      { question_id: 'q2', answer: { type: 'multiple_choice', option_ids: ['q2o0', 'q2o2'] }, explanation: 'two', confidence: 'medium' },
      { question_id: 'q3', answer: { type: 'text', value: '0.5' }, explanation: 'half', confidence: 'low' },
    ]
  };
  const out = v.validateAndMap(resp, SNAP);
  assert.equal(out.ok, true);
  assert.equal(out.suggestions.length, 3);
  assert.equal(out.suggestions[0].choiceText, 'Beta');
  assert.deepEqual(out.suggestions[1].choiceTexts, ['A', 'C']);
  assert.equal(out.suggestions[2].value, '0.5');
  out.suggestions.forEach(s => assert.equal(s.applicable, true));
});

test('unknown question id is rejected as not applicable', () => {
  const out = v.validateAndMap({ answers: [
    { question_id: 'q999', answer: { type: 'single_choice', option_ids: ['q999o0'] } }
  ]}, SNAP);
  assert.equal(out.ok, true);
  assert.equal(out.suggestions[0].applicable, false);
  assert.equal(out.suggestions[0].mappingStatus, 'unknown-question');
});

test('unknown option id is rejected', () => {
  const out = v.validateAndMap({ answers: [
    { question_id: 'q1', answer: { type: 'single_choice', option_ids: ['q1o999'] } }
  ]}, SNAP);
  assert.equal(out.suggestions[0].applicable, false);
  assert.equal(out.suggestions[0].mappingStatus, 'unknown-option');
});

test('wrong-type (text answer for radio question) is rejected', () => {
  const out = v.validateAndMap({ answers: [
    { question_id: 'q1', answer: { type: 'text', value: 'hello' } }
  ]}, SNAP);
  assert.equal(out.suggestions[0].applicable, false);
  assert.equal(out.suggestions[0].mappingStatus, 'wrong-type');
});

test('malformed JSON string returns invalid-json', () => {
  const out = v.validateAndMap('not json at all', SNAP);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'invalid-json');
});

test('markdown-fenced JSON is accepted via extractStrictJson', () => {
  const text = '```json\n{ "answers": [ { "question_id": "q3", "answer": { "type": "text", "value": "9" } } ] }\n```';
  const parsed = v.extractStrictJson(text);
  assert.ok(parsed);
  const out = v.validateAndMap(parsed, SNAP);
  assert.equal(out.suggestions[0].value, '9');
});

test('explanation is preserved for display', () => {
  const out = v.validateAndMap({ answers: [
    { question_id: 'q1', answer: { type: 'single_choice', option_ids: ['q1o0'] }, explanation: 'short reason' }
  ]}, SNAP);
  assert.equal(out.suggestions[0].explanation, 'short reason');
});

test('model cannot smuggle a DOM selector or submit action', () => {
  const out = v.validateAndMap({ answers: [
    { question_id: 'q1', answer: { type: 'single_choice', option_ids: ['q1o0'], selector: '#x', script: 'alert(1)', submit: true, url: 'https://evil/' } }
  ]}, SNAP);
  // Selector/script/url/submit fields are dropped, suggestion still maps cleanly but exposes no selector
  assert.equal('selector' in out.suggestions[0], false);
  assert.equal('script' in out.suggestions[0], false);
  assert.equal('url' in out.suggestions[0], false);
  assert.equal('submit' in out.suggestions[0], false);
});

test('stale snapshot token mismatch blocks apply', () => {
  const out = v.validateAndMap({ answers: [] }, SNAP, { expectedToken: 'snap_DIFFERENT' });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'stale-snapshot');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test tests/ai-answer-validator.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `lib/ai-answer-validator.js`**

```javascript
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.ClipboardCleaner = root.ClipboardCleaner || {}).aiAnswerValidator = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  function extractStrictJson(text) {
    if (text == null) return null;
    if (typeof text === 'object') return text;
    var s = String(text).trim();
    try { return JSON.parse(s); } catch (_) {}
    // Tolerate exactly one ```json ... ``` fence.
    var m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (m) {
      try { return JSON.parse(m[1]); } catch (_) {}
    }
    return null;
  }

  function findQuestion(snap, qid) {
    for (var i = 0; i < snap.questions.length; i++) {
      if (snap.questions[i].id === qid) return snap.questions[i];
    }
    return null;
  }

  function findOptionLabel(question, oid) {
    var opts = question.options || [];
    for (var i = 0; i < opts.length; i++) if (opts[i].id === oid) return opts[i].label;
    return null;
  }

  function validateAndMap(rawResponse, snapshot, opts) {
    opts = opts || {};
    if (opts.expectedToken && snapshot && snapshot.token !== opts.expectedToken) {
      return { ok: false, reason: 'stale-snapshot', suggestions: [], rejectedCount: 0 };
    }
    var parsed = typeof rawResponse === 'string' ? extractStrictJson(rawResponse) : rawResponse;
    if (!parsed) return { ok: false, reason: 'invalid-json', suggestions: [], rejectedCount: 0 };
    if (!parsed.answers || !Array.isArray(parsed.answers)) {
      return { ok: false, reason: 'invalid-schema', suggestions: [], rejectedCount: 0 };
    }

    var suggestions = [];
    var rejected = 0;
    for (var i = 0; i < parsed.answers.length; i++) {
      var a = parsed.answers[i] || {};
      var qid = a.question_id;
      var q = qid ? findQuestion(snapshot, qid) : null;
      var explanation = typeof a.explanation === 'string' ? a.explanation.slice(0, 600) : '';
      var confidence = (a.confidence === 'low' || a.confidence === 'medium' || a.confidence === 'high') ? a.confidence : null;
      var ans = a.answer || {};

      if (!q) {
        suggestions.push({
          questionNumber: null, type: null, explanation: explanation, confidence: confidence,
          mappingStatus: 'unknown-question', applicable: false
        });
        rejected++;
        continue;
      }

      var base = {
        questionNumber: q.questionNumber,
        type: q.type,
        explanation: explanation,
        confidence: confidence,
      };

      if (q.type === 'single_choice') {
        if (ans.type !== 'single_choice' || !Array.isArray(ans.option_ids) || ans.option_ids.length !== 1) {
          suggestions.push(Object.assign(base, { mappingStatus: 'wrong-type', applicable: false })); rejected++; continue;
        }
        var lbl = findOptionLabel(q, ans.option_ids[0]);
        if (lbl == null) {
          suggestions.push(Object.assign(base, { mappingStatus: 'unknown-option', applicable: false })); rejected++; continue;
        }
        suggestions.push(Object.assign(base, { choiceText: lbl, mappingStatus: 'matched', applicable: true }));
      } else if (q.type === 'multiple_choice') {
        if (ans.type !== 'multiple_choice' || !Array.isArray(ans.option_ids)) {
          suggestions.push(Object.assign(base, { mappingStatus: 'wrong-type', applicable: false })); rejected++; continue;
        }
        var labels = [];
        var bad = false;
        for (var k = 0; k < ans.option_ids.length; k++) {
          var L = findOptionLabel(q, ans.option_ids[k]);
          if (L == null) { bad = true; break; }
          labels.push(L);
        }
        if (bad) {
          suggestions.push(Object.assign(base, { mappingStatus: 'unknown-option', applicable: false })); rejected++; continue;
        }
        if (labels.length === 0) {
          suggestions.push(Object.assign(base, { mappingStatus: 'missing-answer', applicable: false })); rejected++; continue;
        }
        suggestions.push(Object.assign(base, { choiceTexts: labels, mappingStatus: 'matched', applicable: true }));
      } else if (q.type === 'math_input') {
        if (ans.type !== 'text' || typeof ans.value !== 'string' || ans.value.trim() === '') {
          suggestions.push(Object.assign(base, { mappingStatus: 'wrong-type', applicable: false })); rejected++; continue;
        }
        suggestions.push(Object.assign(base, { value: ans.value.trim(), mappingStatus: 'matched', applicable: true }));
      } else {
        suggestions.push(Object.assign(base, { mappingStatus: 'unsupported', applicable: false })); rejected++;
      }
    }

    return { ok: true, suggestions: suggestions, rejectedCount: rejected };
  }

  return { validateAndMap: validateAndMap, extractStrictJson: extractStrictJson };
}));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test tests/ai-answer-validator.test.js`
Expected: All 9 tests PASS.

- [ ] **Step 5: Do NOT commit**

---

## Task 5 — `lib/deepseek-client.js`: background-safe HTTPS client (RED tests first)

**Files:**
- Create: `lib/deepseek-client.js`
- Create: `tests/deepseek-client.test.js`

Module surface:

```
createClient({ fetchFn, model, endpoint, timeoutMs }) -> {
  generateAnswers(sanitizedSnapshot, apiKey, { signal }) -> Promise<{ ok: true, raw: object, elapsedMs: number } | { ok: false, reason: 'missing-key'|'unauthorized'|'rate-limit'|'server-error'|'network'|'timeout'|'aborted'|'invalid-response', detail?: string, elapsedMs?: number }>
}
```

Hard rules:
- If `apiKey` is missing/empty → return `{ ok:false, reason:'missing-key' }` **before** calling `fetchFn`.
- Authorization header is the ONLY place the key appears. Never reflect the key in the returned object, never log it.
- Body uses `response_format: { type: 'json_object' }`. System prompt MUST include the word `json` and an example schema (per DeepSeek JSON-mode requirement).
- Map 401 → `unauthorized`, 429 → `rate-limit`, 5xx → `server-error`, network error → `network`, AbortController-fired abort → `aborted`, internal timeout → `timeout`.
- `detail` is a short non-secret string (e.g., `'http 401'`); never contains the key, headers, or full body.

System prompt content (use literally):

```
You are generating answer suggestions for an ungraded practice form. Reply with strict json only matching the supplied schema. Use only the question_id and option_id values supplied. Do not output HTML, selectors, JavaScript, navigation actions, submit instructions, or markdown.

For single_choice questions, return exactly one supplied option_id. For multiple_choice questions, return zero or more supplied option_ids only when justified. For text questions, return a concise fill value. If a question cannot be answered confidently from the supplied context, omit it or mark confidence="low".

Schema example: { "answers": [ { "question_id": "q1", "answer": { "type": "single_choice", "option_ids": ["q1o0"] }, "explanation": "short", "confidence": "high" } ] }
```

- [ ] **Step 1: Write failing tests**

Create `tests/deepseek-client.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../lib/deepseek-client.js');

function makeFetch(impl) {
  const calls = [];
  const fn = function (url, init) { calls.push({ url: url, init: init }); return impl(url, init); };
  fn.calls = calls;
  return fn;
}

function makeResponse(status, jsonBody) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status: status,
    text: function () { return Promise.resolve(JSON.stringify(jsonBody)); },
  });
}

const SNAP = { page: { urlOrigin: 'https://www.coursera.org', eligible: true }, questions: [{ id: 'q1', type: 'math_input', prompt: 'p', order: 1 }], token: 'snap_x' };

test('missing key short-circuits before fetch', async () => {
  const f = makeFetch(function () { throw new Error('should not be called'); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const r = await c.generateAnswers(SNAP, '');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'missing-key');
  assert.equal(f.calls.length, 0);
});

test('valid 200 response is normalized', async () => {
  const f = makeFetch(function () { return makeResponse(200, {
    choices: [{ message: { content: JSON.stringify({ answers: [
      { question_id: 'q1', answer: { type: 'text', value: '42' }, explanation: '', confidence: 'high' }
    ] }) } }]
  }); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const r = await c.generateAnswers(SNAP, 'sk-test');
  assert.equal(r.ok, true);
  assert.ok(r.raw && Array.isArray(r.raw.answers));
  assert.equal(r.raw.answers[0].question_id, 'q1');
});

test('API key appears only in Authorization header and not in returned value', async () => {
  const f = makeFetch(function () { return makeResponse(200, { choices: [{ message: { content: '{"answers":[]}' }}]}); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const r = await c.generateAnswers(SNAP, 'sk-SUPER-SECRET');
  const sent = f.calls[0];
  assert.ok(sent.init.headers && sent.init.headers.Authorization === 'Bearer sk-SUPER-SECRET');
  // body must NOT contain the key
  assert.equal(String(sent.init.body || '').indexOf('sk-SUPER-SECRET'), -1);
  // result must NOT contain the key
  assert.equal(JSON.stringify(r).indexOf('sk-SUPER-SECRET'), -1);
});

test('401 maps to unauthorized', async () => {
  const f = makeFetch(function () { return makeResponse(401, { error: { message: 'bad key' } }); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const r = await c.generateAnswers(SNAP, 'sk-x');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unauthorized');
});

test('429 maps to rate-limit', async () => {
  const f = makeFetch(function () { return makeResponse(429, {}); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const r = await c.generateAnswers(SNAP, 'sk-x');
  assert.equal(r.reason, 'rate-limit');
});

test('500 maps to server-error', async () => {
  const f = makeFetch(function () { return makeResponse(500, {}); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const r = await c.generateAnswers(SNAP, 'sk-x');
  assert.equal(r.reason, 'server-error');
});

test('network error maps to network', async () => {
  const f = makeFetch(function () { return Promise.reject(new Error('socket reset')); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const r = await c.generateAnswers(SNAP, 'sk-x');
  assert.equal(r.reason, 'network');
});

test('abort signal yields reason=aborted', async () => {
  const f = makeFetch(function (url, init) {
    return new Promise(function (resolve, reject) {
      init.signal.addEventListener('abort', function () {
        var err = new Error('aborted'); err.name = 'AbortError'; reject(err);
      });
    });
  });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const ctrl = new AbortController();
  setTimeout(function () { ctrl.abort(); }, 10);
  const r = await c.generateAnswers(SNAP, 'sk-x', { signal: ctrl.signal });
  assert.equal(r.reason, 'aborted');
});

test('timeout fires when slow', async () => {
  const f = makeFetch(function () { return new Promise(function () {}); }); // never resolves
  const c = createClient({ fetchFn: f, model: 'deepseek-chat', timeoutMs: 30 });
  const r = await c.generateAnswers(SNAP, 'sk-x');
  assert.equal(r.reason, 'timeout');
});

test('content that is not parseable JSON is returned with reason=invalid-response', async () => {
  const f = makeFetch(function () { return makeResponse(200, { choices: [{ message: { content: 'not json at all' } }] }); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  const r = await c.generateAnswers(SNAP, 'sk-x');
  // Client returns raw content; validator's job is to decide invalid-json,
  // but client must surface a non-throwing result either way.
  // Accept either: ok:true with raw containing 'not json...' OR ok:false reason:'invalid-response'.
  if (r.ok) {
    assert.equal(typeof r.raw, 'object');
  } else {
    assert.equal(r.reason, 'invalid-response');
  }
});

test('user prompt contains snapshot but never an API key', async () => {
  const f = makeFetch(function (url, init) { return makeResponse(200, { choices: [{ message: { content: '{"answers":[]}' } }] }); });
  const c = createClient({ fetchFn: f, model: 'deepseek-chat' });
  await c.generateAnswers(SNAP, 'sk-XYZ');
  const body = JSON.parse(f.calls[0].init.body);
  const userMsg = body.messages.find(function (m) { return m.role === 'user'; });
  assert.ok(userMsg);
  assert.ok(userMsg.content.indexOf('"q1"') !== -1, 'snapshot must be in user prompt');
  assert.equal(userMsg.content.indexOf('sk-XYZ'), -1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test tests/deepseek-client.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/deepseek-client.js`**

```javascript
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.ClipboardCleaner = root.ClipboardCleaner || {}).deepseekClient = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  var DEFAULT_ENDPOINT = 'https://api.deepseek.com/chat/completions';
  var DEFAULT_MODEL = 'deepseek-chat';
  var DEFAULT_TIMEOUT_MS = 30000;

  var SYSTEM_PROMPT = [
    'You are generating answer suggestions for an ungraded practice form. Reply with strict json only matching the supplied schema. Use only the question_id and option_id values supplied. Do not output HTML, selectors, JavaScript, navigation actions, submit instructions, or markdown.',
    '',
    'For single_choice questions, return exactly one supplied option_id. For multiple_choice questions, return zero or more supplied option_ids only when justified. For text questions, return a concise fill value. If a question cannot be answered confidently from the supplied context, omit it or mark confidence="low".',
    '',
    'Schema example: { "answers": [ { "question_id": "q1", "answer": { "type": "single_choice", "option_ids": ["q1o0"] }, "explanation": "short", "confidence": "high" } ] }'
  ].join('\n');

  function classifyHttp(status) {
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 429) return 'rate-limit';
    if (status >= 500) return 'server-error';
    return 'invalid-response';
  }

  function createClient(opts) {
    opts = opts || {};
    var fetchFn = opts.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    var model = opts.model || DEFAULT_MODEL;
    var endpoint = opts.endpoint || DEFAULT_ENDPOINT;
    var timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

    function generateAnswers(sanitizedSnapshot, apiKey, callOpts) {
      callOpts = callOpts || {};
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
        return Promise.resolve({ ok: false, reason: 'missing-key' });
      }
      if (!fetchFn) {
        return Promise.resolve({ ok: false, reason: 'network', detail: 'no-fetch' });
      }

      var userPrompt = 'Answer this json snapshot of an ungraded practice form. Reply with strict json only matching the schema in the system instruction.\n\n'
        + JSON.stringify({ page: sanitizedSnapshot.page, questions: sanitizedSnapshot.questions });

      var body = JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 2048,
      });

      var ctrl = new AbortController();
      var externalSignal = callOpts.signal;
      if (externalSignal) {
        if (externalSignal.aborted) ctrl.abort();
        else externalSignal.addEventListener('abort', function () { ctrl.abort(); }, { once: true });
      }

      var timer = setTimeout(function () { ctrl.abort('timeout'); }, timeoutMs);
      var timedOut = false;
      var startedAt = Date.now();
      // Mark timed out distinctly
      ctrl.signal.addEventListener('abort', function () {
        if (ctrl.signal.reason === 'timeout') timedOut = true;
      });

      var init = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
          'Accept': 'application/json',
        },
        body: body,
        signal: ctrl.signal,
      };

      return Promise.resolve(fetchFn(endpoint, init)).then(function (resp) {
        clearTimeout(timer);
        if (!resp.ok) {
          return { ok: false, reason: classifyHttp(resp.status), detail: 'http ' + resp.status, elapsedMs: Date.now() - startedAt };
        }
        return resp.text().then(function (txt) {
          var outer;
          try { outer = JSON.parse(txt); } catch (e) { return { ok: false, reason: 'invalid-response', elapsedMs: Date.now() - startedAt }; }
          var content = outer && outer.choices && outer.choices[0] && outer.choices[0].message && outer.choices[0].message.content;
          if (typeof content !== 'string') {
            return { ok: false, reason: 'invalid-response', elapsedMs: Date.now() - startedAt };
          }
          var inner;
          try { inner = JSON.parse(content); } catch (e) { return { ok: true, raw: content, elapsedMs: Date.now() - startedAt }; }
          return { ok: true, raw: inner, elapsedMs: Date.now() - startedAt };
        });
      }).catch(function (err) {
        clearTimeout(timer);
        if (timedOut) return { ok: false, reason: 'timeout', elapsedMs: Date.now() - startedAt };
        if (err && err.name === 'AbortError') return { ok: false, reason: 'aborted', elapsedMs: Date.now() - startedAt };
        return { ok: false, reason: 'network', detail: (err && err.message) ? String(err.message).slice(0, 80) : '', elapsedMs: Date.now() - startedAt };
      });
    }

    return { generateAnswers: generateAnswers };
  }

  return { createClient: createClient };
}));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx node --test tests/deepseek-client.test.js`
Expected: All tests PASS.

- [ ] **Step 5: Verify the constant `DEFAULT_MODEL` against live docs**

Open https://api-docs.deepseek.com/ in a browser (the user opens it; we cannot from here). Confirm the current recommended chat-completions model identifier for `response_format: { type: 'json_object' }`. If the published name differs from `'deepseek-chat'`, update the `DEFAULT_MODEL` constant in `lib/deepseek-client.js` and add a passing test that asserts the new value. Do not invent a name from memory.

- [ ] **Step 6: Do NOT commit**

---

## Task 6 — Background service worker: `ccp.ai.*` namespace

**Files:**
- Modify: `background.js`

Add a **second** `chrome.runtime.onMessage.addListener` block that filters on `msg.type === 'ccp.ai.request'`. Do NOT touch the existing `autopilot.state` listener. Do NOT add commands to `autopilotAuthority`. Do NOT change `publicSurface: true`.

The AI handler:
- Owns its own in-memory `_aiState = { sessionKey: null, currentAbort: null }`.
- Reads `chrome.storage.session` on demand to retrieve a key the user saved this session.
- For `setSessionKey { key }`: store in session storage and `_aiState.sessionKey`.
- For `clearKey`: clear both session and local AI key entries; null `_aiState.sessionKey`.
- For `keyStatus`: respond `{ ok: true, keyPresent: !!key }`. Never include any character of the key.
- For `generateAnswers { snapshot }`: read key (session first, then local if explicitly enabled), call `deepseekClient.generateAnswers(snapshot, key, { signal })`, return `{ ok, raw, reason, elapsedMs }`.
- For `cancelRequest`: call `_aiState.currentAbort && _aiState.currentAbort.abort()`.

- [ ] **Step 1: Read current `background.js` to confirm structure**

Open `background.js`. Confirm:
- There is one `chrome.runtime.onMessage.addListener` for `'autopilot.state'`.
- There is an `api.autopilotAuthority.createAuthority(storage, { publicSurface: true })` call.
- Do not edit any of that.

- [ ] **Step 2: Append the AI handler to `background.js`**

At the end of `background.js` (after the existing listener block), append:

```javascript
// === Let AI answer for you — isolated namespace ===
// Runs in a SECOND onMessage listener with its own state. Never touches
// autopilot authority, RUN_KEY, SETTINGS_KEY, or publicSurface fencing.
try {
  importScripts('./lib/deepseek-client.js');
} catch (e) { /* MV3 SW global scope: this file is loaded as a classic worker; importScripts is available */ }

(function setupAiNamespace(){
  var deepseekMod = (self.ClipboardCleaner && self.ClipboardCleaner.deepseekClient) || null;
  if (!deepseekMod) return; // safe-fail: extension still works without the AI feature

  var SESSION_KEY_NAME = 'ccp.ai.sessionKey';
  var LOCAL_KEY_NAME   = 'ccp.ai.localKey';
  var _state = { currentAbort: null };

  var client = deepseekMod.createClient({ /* model uses default; see DEFAULT_MODEL constant */ });

  function readKey(cb) {
    chrome.storage.session.get([SESSION_KEY_NAME], function (got) {
      var k = got && got[SESSION_KEY_NAME];
      if (k) return cb(k);
      chrome.storage.local.get([LOCAL_KEY_NAME], function (got2) { cb((got2 && got2[LOCAL_KEY_NAME]) || null); });
    });
  }

  function handle(msg, sendResponse) {
    var cmd = msg.command;
    var params = msg.params || {};

    if (cmd === 'setSessionKey') {
      var k = (params.key || '').toString();
      if (!k) { sendResponse({ ok: false, reason: 'empty-key' }); return; }
      var write = {}; write[SESSION_KEY_NAME] = k;
      chrome.storage.session.set(write, function () {
        if (params.remember) {
          var w2 = {}; w2[LOCAL_KEY_NAME] = k;
          chrome.storage.local.set(w2, function () { sendResponse({ ok: true, keyPresent: true, remember: true }); });
        } else {
          sendResponse({ ok: true, keyPresent: true, remember: false });
        }
      });
      return true;
    }

    if (cmd === 'clearKey') {
      chrome.storage.session.remove([SESSION_KEY_NAME], function () {
        chrome.storage.local.remove([LOCAL_KEY_NAME], function () { sendResponse({ ok: true, keyPresent: false }); });
      });
      return true;
    }

    if (cmd === 'keyStatus') {
      readKey(function (k) { sendResponse({ ok: true, keyPresent: !!k }); });
      return true;
    }

    if (cmd === 'generateAnswers') {
      readKey(function (key) {
        if (!key) { sendResponse({ ok: false, reason: 'missing-key' }); return; }
        if (_state.currentAbort) { try { _state.currentAbort.abort(); } catch (_) {} }
        var ctrl = new AbortController();
        _state.currentAbort = ctrl;
        client.generateAnswers(params.snapshot, key, { signal: ctrl.signal }).then(function (res) {
          _state.currentAbort = null;
          sendResponse(res);
        }, function (err) {
          _state.currentAbort = null;
          sendResponse({ ok: false, reason: 'network', detail: (err && err.message) ? String(err.message).slice(0, 80) : '' });
        });
      });
      return true;
    }

    if (cmd === 'cancelRequest') {
      if (_state.currentAbort) { try { _state.currentAbort.abort(); } catch (_) {} }
      _state.currentAbort = null;
      sendResponse({ ok: true });
      return false;
    }

    sendResponse({ ok: false, reason: 'unknown-command', command: cmd });
    return false;
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'ccp.ai.request') return false;
    try { return handle(msg, sendResponse); } catch (e) {
      sendResponse({ ok: false, reason: 'handler-error', detail: String((e && e.message) || '').slice(0, 80) });
      return false;
    }
  });
})();
```

- [ ] **Step 3: Manual sanity check — load extension in Chrome**

Tell the user: load the unpacked extension in `chrome://extensions/` (Developer mode → Reload) and verify the service worker has no parse errors in the SW console. Do NOT visit a live Coursera page yet. We are only confirming the new listener registers cleanly.

If the user reports an SW load error, fix it before continuing. Most likely causes: `importScripts` not available because of `manifest.json` `background.type: "module"` (we use classic SW), or a path typo.

- [ ] **Step 4: Do NOT commit**

---

## Task 7 — Sidebar UI: 6th tab + panel + handler registry (RED tests first)

**Files:**
- Modify: `lib/sidebar.js`
- Modify: `tests/sidebar.test.js`

Add the 6th tab and its panel. Add a `setAiAnswerHandlers({...})` registry mirroring `setAutopilotHandlers`. State setters: `setAiKeyStatus(boolean)`, `setAiPageEligibility({eligible, blockedReason, supportedCount})`, `setAiScanResult(snapshot)`, `setAiSuggestions(suggestions)`, `setAiInFlight(boolean)`, `setAiApplyResult(applyResult)`.

- [ ] **Step 1: Add sidebar tests (RED)**

Append to `tests/sidebar.test.js`:

```javascript
test('sidebar exposes "Let AI answer for you" tab without removing existing tabs', () => {
  const { sidebar, shadow } = freshSidebar();
  // existing tabs unchanged
  ['copied', 'typer', 'answer', 'autopilot', 'diagnostics'].forEach(function (t) {
    assert.ok(shadow.querySelector('[data-tab="' + t + '"]'), 'existing tab ' + t);
  });
  // new tab
  const tab = shadow.querySelector('[data-tab="ai-answer"]');
  assert.ok(tab, 'AI answer tab button must exist');
  assert.equal(tab.textContent.trim(), 'Let AI answer for you');
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

test('API key input is password-masked by default', () => {
  const { sidebar, shadow } = freshSidebar();
  const input = shadow.querySelector('[data-role="ai-key-input"]');
  assert.ok(input);
  assert.equal(input.getAttribute('type'), 'password');
});

test('show/hide toggle changes only field visibility, not stored value', () => {
  const { sidebar, shadow } = freshSidebar();
  const input = shadow.querySelector('[data-role="ai-key-input"]');
  input.value = 'sk-typed';
  const toggle = shadow.querySelector('[data-action="ai-key-toggle"]');
  toggle.click();
  assert.equal(input.getAttribute('type'), 'text');
  assert.equal(input.value, 'sk-typed');
  toggle.click();
  assert.equal(input.getAttribute('type'), 'password');
  assert.equal(input.value, 'sk-typed');
});

test('handler registry fires correct callbacks exactly once', () => {
  const { sidebar, shadow } = freshSidebar();
  const calls = { saveKey: 0, clearKey: 0, scan: 0, generate: 0, cancel: 0, apply: 0, clearSuggestions: 0 };
  sidebar.setAiAnswerHandlers({
    onSaveKey: function (key, remember) { calls.saveKey++; },
    onClearKey: function () { calls.clearKey++; },
    onScan: function () { calls.scan++; },
    onGenerate: function () { calls.generate++; },
    onCancel: function () { calls.cancel++; },
    onApply: function () { calls.apply++; },
    onClearSuggestions: function () { calls.clearSuggestions++; },
  });
  shadow.querySelector('[data-role="ai-key-input"]').value = 'sk-x';
  shadow.querySelector('[data-action="ai-key-save"]').click();
  shadow.querySelector('[data-action="ai-key-clear"]').click();
  shadow.querySelector('[data-action="ai-scan"]').click();
  shadow.querySelector('[data-action="ai-generate"]').click();
  shadow.querySelector('[data-action="ai-cancel"]').click();
  shadow.querySelector('[data-action="ai-apply"]').click();
  shadow.querySelector('[data-action="ai-clear-suggestions"]').click();
  assert.equal(calls.saveKey, 1);
  assert.equal(calls.clearKey, 1);
  assert.equal(calls.scan, 1);
  assert.equal(calls.generate, 1);
  assert.equal(calls.cancel, 1);
  assert.equal(calls.apply, 1);
  assert.equal(calls.clearSuggestions, 1);
});

test('Generate is disabled until eligible scan AND key present', () => {
  const { sidebar, shadow } = freshSidebar();
  const gen = shadow.querySelector('[data-action="ai-generate"]');
  assert.equal(gen.disabled, true);
  sidebar.setAiKeyStatus(true);
  assert.equal(gen.disabled, true, 'still disabled without scan');
  sidebar.setAiPageEligibility({ eligible: true, blockedReason: null, supportedCount: 2 });
  sidebar.setAiScanResult({ token: 't', questions: [{}, {}], supportedCount: 2 });
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
  const input = shadow.querySelector('[data-role="ai-key-input"]');
  input.value = 'sk-LEAK-CHECK-9999';
  sidebar.setAiKeyStatus(true);
  sidebar.setAiPageEligibility({ eligible: true, blockedReason: null, supportedCount: 1 });
  sidebar.setAiScanResult({ token: 't', questions: [{}], supportedCount: 1 });
  sidebar.setAiSuggestions([{ applicable: true, questionNumber: 1, explanation: 'why' }]);
  // The .value of an input is NOT in textContent, so this checks rendered text only.
  const aiPanel = shadow.querySelector('[data-panel="ai-answer"]');
  assert.equal(aiPanel.textContent.indexOf('sk-LEAK-CHECK-9999'), -1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx node --test tests/sidebar.test.js`
Expected: New tests FAIL. Existing tests must still PASS.

- [ ] **Step 3: Implement sidebar changes**

In `lib/sidebar.js`, find the tab list block (around lines 22-28). Append the 6th tab button INSIDE the same `<div class="ccp-tabs">`:

```javascript
'<button class="ccp-tab" role="tab" aria-selected="false" data-tab="ai-answer">Let AI answer for you</button>' +
```

Find the panel definitions block (around lines 29-118). After the diagnostics panel `</section>` and before the closing of `ccp-body`, append:

```javascript
'<section class="ccp-panel" data-panel="ai-answer" data-active="false">' +
  '<div class="ccp-ai-section">' +
    '<label class="ccp-ai-label">DeepSeek API key</label>' +
    '<div class="ccp-ai-row">' +
      '<input class="ccp-ai-input" type="password" data-role="ai-key-input" autocomplete="off" spellcheck="false" />' +
      '<button class="ccp-btn" data-action="ai-key-toggle">Show</button>' +
    '</div>' +
    '<div class="ccp-ai-row">' +
      '<label><input type="checkbox" data-role="ai-key-remember" /> Remember on this device</label>' +
    '</div>' +
    '<div class="ccp-ai-row">' +
      '<button class="ccp-btn" data-action="ai-key-save">Save for this session</button>' +
      '<button class="ccp-btn" data-action="ai-key-clear">Clear key</button>' +
    '</div>' +
    '<div data-role="ai-key-state">No DeepSeek API key configured.</div>' +
  '</div>' +
  '<div class="ccp-ai-section">' +
    '<div data-role="ai-status">Click Scan questions to detect supported unanswered questions on this page.</div>' +
  '</div>' +
  '<div class="ccp-ai-section">' +
    '<button class="ccp-btn" data-action="ai-scan">Scan questions</button>' +
    '<button class="ccp-btn" data-action="ai-generate" disabled>Generate answer suggestions</button>' +
    '<button class="ccp-btn" data-action="ai-cancel" disabled>Cancel request</button>' +
    '<button class="ccp-btn" data-action="ai-apply" disabled>Apply answers</button>' +
    '<button class="ccp-btn" data-action="ai-clear-suggestions">Clear suggestions</button>' +
  '</div>' +
  '<div class="ccp-ai-section">' +
    '<div data-role="ai-scan-preview"></div>' +
  '</div>' +
  '<div class="ccp-ai-section">' +
    '<div data-role="ai-suggestion-preview"></div>' +
  '</div>' +
  '<div class="ccp-ai-section">' +
    '<div data-role="ai-apply-result"></div>' +
  '</div>' +
'</section>' +
```

After the existing handler-registry pattern (around lines 533-560 where `_autopilotHandlers` lives), add a parallel registry:

```javascript
let _aiAnswerHandlers = {
  onSaveKey: null, onClearKey: null, onScan: null, onGenerate: null,
  onCancel: null, onApply: null, onClearSuggestions: null,
};
let _aiState = {
  keyPresent: false,
  eligible: null, blockedReason: null, supportedCount: 0,
  snapshot: null, suggestions: null, inFlight: false,
};

function setAiAnswerHandlers(h) { _aiAnswerHandlers = Object.assign({}, _aiAnswerHandlers, h || {}); }
function setAiKeyStatus(present) {
  _aiState.keyPresent = !!present;
  const el = shadow.querySelector('[data-role="ai-key-state"]');
  if (el) el.textContent = present ? 'API key configured for this session.' : 'No DeepSeek API key configured.';
  _renderAiButtonStates();
}
function setAiPageEligibility(state) {
  _aiState.eligible = !!(state && state.eligible);
  _aiState.blockedReason = state && state.blockedReason || null;
  _aiState.supportedCount = (state && state.supportedCount) || 0;
  const status = shadow.querySelector('[data-role="ai-status"]');
  if (status) {
    if (!_aiState.eligible) {
      status.textContent = 'AI answer filling is disabled on graded or blocked assessment pages.';
    } else if (_aiState.supportedCount === 0) {
      status.textContent = 'No unanswered supported questions found on this page.';
    } else {
      status.textContent = 'Ready: supported ungraded question page detected.';
    }
  }
  _renderAiButtonStates();
}
function setAiScanResult(snapshot) {
  _aiState.snapshot = snapshot || null;
  const el = shadow.querySelector('[data-role="ai-scan-preview"]');
  if (el && snapshot) {
    let html = '<div>Detected ' + snapshot.questions.length + ' questions (' + (snapshot.supportedCount || 0) + ' supported).</div><ul>';
    for (let i = 0; i < snapshot.questions.length; i++) {
      const q = snapshot.questions[i];
      html += '<li>Q' + (q.questionNumber || (i+1)) + ' — ' + (q.type || '?') + ' — ' + ((q.prompt || '').slice(0, 80))
        + (q.supported ? '' : ' (unsupported)') + '</li>';
    }
    html += '</ul>';
    el.innerHTML = html;
  } else if (el) {
    el.innerHTML = '';
  }
  _renderAiButtonStates();
}
function setAiSuggestions(list) {
  _aiState.suggestions = list || null;
  const el = shadow.querySelector('[data-role="ai-suggestion-preview"]');
  if (el && list) {
    let html = '<div>Got ' + list.length + ' suggestions.</div><ul>';
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      let ansText = '';
      if (s.choiceText) ansText = s.choiceText;
      else if (s.choiceTexts) ansText = s.choiceTexts.join(', ');
      else if (s.value) ansText = s.value;
      html += '<li>Q' + (s.questionNumber == null ? '?' : s.questionNumber) + ' — '
        + (s.mappingStatus || '?') + ' — ' + ansText
        + (s.explanation ? ' — ' + s.explanation.slice(0, 120) : '')
        + '</li>';
    }
    html += '</ul>';
    el.innerHTML = html;
  } else if (el) {
    el.innerHTML = '';
  }
  _renderAiButtonStates();
}
function setAiInFlight(flag) {
  _aiState.inFlight = !!flag;
  _renderAiButtonStates();
}
function setAiApplyResult(res) {
  const el = shadow.querySelector('[data-role="ai-apply-result"]');
  if (!el) return;
  if (!res) { el.textContent = ''; return; }
  el.textContent = 'Applied ' + (res.filled || 0) + ' answers; skipped ' + (res.failed || 0) + '.';
}
function _renderAiButtonStates() {
  const gen = shadow.querySelector('[data-action="ai-generate"]');
  const cancel = shadow.querySelector('[data-action="ai-cancel"]');
  const apply = shadow.querySelector('[data-action="ai-apply"]');
  if (gen) gen.disabled = !!(
    !_aiState.keyPresent ||
    _aiState.eligible === false ||
    !_aiState.snapshot ||
    (_aiState.snapshot && _aiState.snapshot.questions && _aiState.snapshot.questions.length === 0) ||
    _aiState.inFlight
  );
  if (cancel) cancel.disabled = !_aiState.inFlight;
  if (apply) apply.disabled = !(
    _aiState.suggestions && _aiState.suggestions.length > 0 && _aiState.eligible !== false
  );
}

function wireAiAnswer() {
  const keyInput = shadow.querySelector('[data-role="ai-key-input"]');
  const toggle   = shadow.querySelector('[data-action="ai-key-toggle"]');
  const save     = shadow.querySelector('[data-action="ai-key-save"]');
  const clearK   = shadow.querySelector('[data-action="ai-key-clear"]');
  const scan     = shadow.querySelector('[data-action="ai-scan"]');
  const gen      = shadow.querySelector('[data-action="ai-generate"]');
  const cancel   = shadow.querySelector('[data-action="ai-cancel"]');
  const apply    = shadow.querySelector('[data-action="ai-apply"]');
  const clearS   = shadow.querySelector('[data-action="ai-clear-suggestions"]');
  const remember = shadow.querySelector('[data-role="ai-key-remember"]');
  if (!keyInput || !toggle || !save || !clearK || !scan || !gen || !cancel || !apply || !clearS) return;

  toggle.addEventListener('click', function () {
    if (keyInput.getAttribute('type') === 'password') { keyInput.setAttribute('type', 'text'); toggle.textContent = 'Hide'; }
    else { keyInput.setAttribute('type', 'password'); toggle.textContent = 'Show'; }
  });
  save.addEventListener('click', function () { if (_aiAnswerHandlers.onSaveKey) _aiAnswerHandlers.onSaveKey(keyInput.value, !!(remember && remember.checked)); keyInput.value = ''; });
  clearK.addEventListener('click', function () { if (_aiAnswerHandlers.onClearKey) _aiAnswerHandlers.onClearKey(); });
  scan.addEventListener('click', function () { if (_aiAnswerHandlers.onScan) _aiAnswerHandlers.onScan(); });
  gen.addEventListener('click', function () { if (_aiAnswerHandlers.onGenerate) _aiAnswerHandlers.onGenerate(); });
  cancel.addEventListener('click', function () { if (_aiAnswerHandlers.onCancel) _aiAnswerHandlers.onCancel(); });
  apply.addEventListener('click', function () { if (_aiAnswerHandlers.onApply) _aiAnswerHandlers.onApply(); });
  clearS.addEventListener('click', function () { if (_aiAnswerHandlers.onClearSuggestions) _aiAnswerHandlers.onClearSuggestions(); setAiSuggestions(null); setAiApplyResult(null); });
}
```

Call `wireAiAnswer();` inside `mount()` immediately after the existing wire calls (around line 202 where `wireTabs()` and `wireAnswer()` and `wireAutopilot()` etc. are called).

Add the new functions to the exported `api` object near line 846:

```javascript
const api = {
  mount: mount, open: open, close: close, toggle: toggle,
  setActiveTab: setActiveTab, showCopied: showCopied,
  setAutopilotStatus: setAutopilotStatus,
  appendAutopilotLog: appendAutopilotLog,
  setAutopilotPaused: setAutopilotPaused,
  setAutopilotButtonsRunning: setAutopilotButtonsRunning,
  setAutopilotButtonsStarting: setAutopilotButtonsStarting,
  setAutopilotHandlers: setAutopilotHandlers,
  setAutopilotSettings: setAutopilotSettings,
  getAnswerText: getAnswerText,
  setDebugRecorder: setDebugRecorder,
  setAutopilotRunContext: setAutopilotRunContext,
  setAiAnswerHandlers: setAiAnswerHandlers,
  setAiKeyStatus: setAiKeyStatus,
  setAiPageEligibility: setAiPageEligibility,
  setAiScanResult: setAiScanResult,
  setAiSuggestions: setAiSuggestions,
  setAiInFlight: setAiInFlight,
  setAiApplyResult: setAiApplyResult,
};
```

- [ ] **Step 4: Run sidebar tests**

Run: `npx node --test tests/sidebar.test.js`
Expected: All tests PASS (old + new).

- [ ] **Step 5: Confirm diagnostics export does NOT include the key**

Search `lib/sidebar.js` for `wireDiagnostics` and the `formatDebugReport` call (around lines 718-793). Confirm there is no path that reads the AI key input value or the AI key state into the debug report. The key input's `.value` is a DOM input; it is not stored on `_aiState` after the user clicks Save (Step 3 clears `keyInput.value = ''` after dispatch). Add a one-line assertion test if not already covered:

```javascript
test('debug export does not include AI key state', () => {
  const { sidebar, shadow } = freshSidebar();
  const input = shadow.querySelector('[data-role="ai-key-input"]');
  input.value = 'sk-DIAG-LEAK-CHECK';
  sidebar.setAiKeyStatus(true);
  const exportBtn = shadow.querySelector('[data-action="diag-copy"]');
  // Spy on clipboard write
  let captured = '';
  shadow.ownerDocument.defaultView.navigator.clipboard = { writeText: function (t) { captured = t; return Promise.resolve(); } };
  if (exportBtn) exportBtn.click();
  // captured may be empty if no debugRecorder; this test passes as long as it does not contain the key
  assert.equal(captured.indexOf('sk-DIAG-LEAK-CHECK'), -1);
});
```

Run: `npx node --test tests/sidebar.test.js`
Expected: All tests PASS.

- [ ] **Step 6: Do NOT commit**

---

## Task 8 — Content script wiring (`content.js`)

**Files:**
- Modify: `content.js`

Add an AI controller that:
1. On page mount, queries the background for `keyStatus` and calls `sidebar.setAiKeyStatus`.
2. On Save Key: sends `setSessionKey` to background.
3. On Clear Key: sends `clearKey`.
4. On Scan: calls `aiQuestionContext.buildQuestionSnapshot(document.body, location, document)`, stores it locally, calls `sidebar.setAiPageEligibility(...)` and `sidebar.setAiScanResult(snapshot)`. Refuses if blocked.
5. On Generate: sends `generateAnswers { snapshot: aiQuestionContext.sanitizeForRequest(snapshot) }` to background, sets `inFlight=true`. On response, validates with `aiAnswerValidator.validateAndMap(res.raw, snapshot, { expectedToken: snapshot.token })`, calls `sidebar.setAiSuggestions(validated.suggestions)`. Records sanitized diagnostics events (no question text, no key).
6. On Cancel: sends `cancelRequest`.
7. On Apply: re-scans (rebuilds snapshot). If new token differs from the stored token → refuse with status message "The page changed after suggestions were generated. Scan again before applying." If token matches, convert applicable suggestions to structured-input list and call `answerApplier.applyStructuredAnswers(list, document.body, { verbose: false })`. Show `setAiApplyResult({filled, failed})`.
8. On Clear Suggestions: drops the in-memory suggestions.

- [ ] **Step 1: Read the existing content.js answer wiring (around lines 186-198) and the require/loader pattern**

Open `content.js`. Note how `ClipboardCleaner` modules are imported (browser-global pattern via `window.ClipboardCleaner.xxx`). Mirror that pattern for `aiQuestionContext`, `aiAnswerValidator`, `answerApplier.applyStructuredAnswers`.

- [ ] **Step 2: Add the AI controller to `content.js`**

After the existing `setAutopilotHandlers({...})` block in `content.js`, add:

```javascript
// === Let AI answer for you — content controller ===
(function setupAiAnswerController() {
  var a = window.ClipboardCleaner || {};
  if (!a.sidebar || !a.aiQuestionContext || !a.aiAnswerValidator || !a.answerApplier) return;

  var _activeSnapshot = null;
  var _activeSuggestions = null;

  function send(command, params, cb) {
    try {
      chrome.runtime.sendMessage({ type: 'ccp.ai.request', command: command, params: params || {} }, function (res) { cb && cb(res || { ok: false, reason: 'no-response' }); });
    } catch (e) { cb && cb({ ok: false, reason: 'send-failed', detail: String(e && e.message || '').slice(0, 80) }); }
  }

  function refreshKeyStatus() {
    send('keyStatus', {}, function (res) {
      a.sidebar.setAiKeyStatus(!!(res && res.keyPresent));
    });
  }

  function performScan() {
    var snap = a.aiQuestionContext.buildQuestionSnapshot(document.body, window.location, document);
    _activeSnapshot = snap;
    _activeSuggestions = null;
    a.sidebar.setAiPageEligibility({
      eligible: snap.page.eligible,
      blockedReason: snap.page.blockedReason,
      supportedCount: snap.supportedCount,
    });
    a.sidebar.setAiScanResult(snap);
    a.sidebar.setAiSuggestions(null);
    a.sidebar.setAiApplyResult(null);
  }

  function performGenerate() {
    if (!_activeSnapshot || !_activeSnapshot.page.eligible) return;
    var sanitized = a.aiQuestionContext.sanitizeForRequest(_activeSnapshot);
    a.sidebar.setAiInFlight(true);
    send('generateAnswers', { snapshot: sanitized }, function (res) {
      a.sidebar.setAiInFlight(false);
      if (!res || !res.ok) {
        var msg = (res && res.reason) ? deepseekErrorMessage(res.reason) : 'DeepSeek request failed.';
        a.sidebar.setAiApplyResult({ filled: 0, failed: 0 });
        a.sidebar.setAiSuggestions([]);
        var status = document.querySelector('#ccp-host-root'); // status text update via setAiPageEligibility shape
        // Best-effort: surface message via a dedicated status setter or reuse setAiApplyResult.
        if (a.sidebar.setAiApplyResult) a.sidebar.setAiApplyResult({ filled: 0, failed: 0, message: msg });
        return;
      }
      var val = a.aiAnswerValidator.validateAndMap(res.raw, _activeSnapshot, { expectedToken: _activeSnapshot.token });
      if (!val.ok) {
        a.sidebar.setAiSuggestions([]);
        return;
      }
      _activeSuggestions = val.suggestions;
      a.sidebar.setAiSuggestions(val.suggestions);
    });
  }

  function performCancel() { send('cancelRequest', {}, function () { a.sidebar.setAiInFlight(false); }); }

  function performApply() {
    if (!_activeSnapshot || !_activeSuggestions) return;
    var fresh = a.aiQuestionContext.buildQuestionSnapshot(document.body, window.location, document);
    if (fresh.token !== _activeSnapshot.token) {
      a.sidebar.setAiApplyResult({ filled: 0, failed: 0, message: 'The page changed after suggestions were generated. Scan again before applying.' });
      return;
    }
    if (!fresh.page.eligible) {
      a.sidebar.setAiApplyResult({ filled: 0, failed: 0, message: 'AI answer filling is disabled on graded or blocked assessment pages.' });
      return;
    }
    var structured = [];
    for (var i = 0; i < _activeSuggestions.length; i++) {
      var s = _activeSuggestions[i];
      if (!s.applicable) continue;
      var item = { questionNumber: s.questionNumber, type: s.type };
      if (s.choiceText) item.choiceText = s.choiceText;
      if (s.choiceTexts) item.choiceTexts = s.choiceTexts;
      if (s.value) item.value = s.value;
      structured.push(item);
    }
    var result = a.answerApplier.applyStructuredAnswers(structured, document.body, { verbose: false });
    a.sidebar.setAiApplyResult({ filled: result.summary.filled, failed: result.summary.failed });
  }

  function performClearSuggestions() { _activeSuggestions = null; a.sidebar.setAiSuggestions(null); a.sidebar.setAiApplyResult(null); }

  function deepseekErrorMessage(reason) {
    switch (reason) {
      case 'missing-key': return 'Enter a DeepSeek API key before generating suggestions.';
      case 'unauthorized': return 'DeepSeek rejected the API key. Check the key and try again.';
      case 'rate-limit': return 'DeepSeek request failed: rate limit.';
      case 'server-error': return 'DeepSeek request failed: server error.';
      case 'network': return 'DeepSeek request failed: network.';
      case 'timeout': return 'DeepSeek request failed: timed out.';
      case 'aborted': return 'DeepSeek request was cancelled.';
      case 'invalid-response': return 'DeepSeek returned an answer format that could not be safely applied.';
      default: return 'DeepSeek request failed: ' + reason + '.';
    }
  }

  a.sidebar.setAiAnswerHandlers({
    onSaveKey: function (key, remember) {
      send('setSessionKey', { key: key, remember: !!remember }, function (res) {
        a.sidebar.setAiKeyStatus(!!(res && res.keyPresent));
      });
    },
    onClearKey: function () { send('clearKey', {}, function () { a.sidebar.setAiKeyStatus(false); }); },
    onScan: performScan,
    onGenerate: performGenerate,
    onCancel: performCancel,
    onApply: performApply,
    onClearSuggestions: performClearSuggestions,
  });

  refreshKeyStatus();
  // Best-effort initial eligibility check (no scan):
  var initBlock = a.aiQuestionContext.isCurrentPageBlocked(window.location, document);
  a.sidebar.setAiPageEligibility({ eligible: !initBlock.blocked, blockedReason: initBlock.reason, supportedCount: 0 });
})();
```

- [ ] **Step 3: Ensure new modules are loaded in `manifest.json` content_scripts**

Open `manifest.json` and locate the `content_scripts.js` array. Add the new modules (and confirm `answer-applier.js` is already present):

```json
"js": [
  "lib/module-scraper.js",
  "lib/question-detector.js",
  "lib/numbered-parser.js",
  "lib/math-normalize.js",
  "lib/answer-parser.js",
  "lib/answer-applier.js",
  "lib/ai-question-context.js",
  "lib/ai-answer-validator.js",
  "lib/sidebar.js",
  "content.js"
],
```

(The exact existing list will differ — keep existing entries in their existing order, only INSERT the two new files in a sensible spot. Do not reorder unrelated entries.)

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: All tests PASS — including pre-existing tests for autopilot/authority/state/module-autopilot. If any pre-existing test fails, do not commit; investigate whether the change accidentally touched that path.

- [ ] **Step 5: Do NOT commit**

---

## Task 9 — End-to-end UI-level test for the AI tab (RED first)

**Files:**
- Create: `tests/ai-answer-tab.test.js`

This is a single integration test that drives the sidebar handlers like content.js would, with a stub for `chrome.runtime.sendMessage` (so the background handler can be simulated) and a stub for `fetch`.

- [ ] **Step 1: Write the failing test**

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const SIDEBAR_PATH = require.resolve('../lib/sidebar.js');

function freshDom() {
  delete require.cache[SIDEBAR_PATH];
  // Mount with one radio question and one text question for end-to-end check
  const html = '<section><h3>Question 1</h3><p>Pick</p>'
    + '<label><input type="radio" name="r1">Alpha</label>'
    + '<label><input type="radio" name="r1">Beta</label>'
    + '</section>'
    + '<section><h3>Question 2</h3><p>Enter value</p><input type="text" id="t2"></section>';
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', { url: 'https://www.coursera.org/learn/course/lecture/v1/intro' });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
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
    onSaveKey: function (key) {
      dom.window.chrome.runtime.sendMessage({ type: 'ccp.ai.request', command: 'setSessionKey', params: { key: key } }, function (res) {
        a.sidebar.setAiKeyStatus(!!(res && res.keyPresent));
      });
    },
    onClearKey: function () { dom.window.chrome.runtime.sendMessage({ type: 'ccp.ai.request', command: 'clearKey', params: {} }, function () { a.sidebar.setAiKeyStatus(false); }); },
    onScan: function () {
      activeSnapshot = aiCtx.buildQuestionSnapshot(dom.window.document.body, dom.window.location, dom.window.document);
      a.sidebar.setAiPageEligibility({ eligible: activeSnapshot.page.eligible, blockedReason: activeSnapshot.page.blockedReason, supportedCount: activeSnapshot.supportedCount });
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

  // Drive the UI like a user
  const host = dom.window.document.getElementById('ccp-host-root');
  const shadow = host.shadowRoot || host;
  shadow.querySelector('[data-role="ai-key-input"]').value = 'sk-pretend';
  shadow.querySelector('[data-action="ai-key-save"]').click();
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

  // Verify the key was sent ONLY in setSessionKey command params, never reflected back into any UI text
  const panelText = shadow.querySelector('[data-panel="ai-answer"]').textContent;
  assert.equal(panelText.indexOf('sk-pretend'), -1);
});

test('end-to-end: blocked page refuses scan/generate/apply', () => {
  const dom = freshDom();
  // Override URL to a gradedLti URL
  Object.defineProperty(dom.window.location, 'href', { value: 'https://www.coursera.org/learn/course/gradedLti/abc/xyz', configurable: true });
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
```

- [ ] **Step 2: Run the integration test**

Run: `npx node --test tests/ai-answer-tab.test.js`
Expected: First it fails (modules not loaded / handlers missing). After Tasks 2–7 complete, it PASSES.

- [ ] **Step 3: Do NOT commit**

---

## Task 10 — Full-suite regression

**Files:** (no edits)

- [ ] **Step 1: Run the entire test suite**

Run: `npm test`
Expected: ALL tests pass. Specifically verify:
- `tests/autopilot-authority.test.js` — every PHASE 15 publicSurface test still green.
- `tests/autopilot-state.test.js` — green.
- `tests/module-autopilot.test.js` — green.
- `tests/autopilot-timing.test.js`, `tests/autopilot-debug.test.js`, `tests/completion-confirmer.test.js`, `tests/item-handlers.test.js`, `tests/module-scraper.test.js`, `tests/question-detector.test.js`, `tests/numbered-parser.test.js`, `tests/math-normalize.test.js`, `tests/answer-applier.test.js`, `tests/sidebar.test.js` — all green.
- New: `tests/ai-question-context.test.js`, `tests/ai-answer-validator.test.js`, `tests/deepseek-client.test.js`, `tests/ai-answer-tab.test.js` — all green.

If any pre-existing test breaks, the change is too invasive. Stop and report. Do NOT push a fix that papers over a real regression.

- [ ] **Step 2: Grep the entire repo for accidental key leakage in tests or fixtures**

Run: `npx node -e "const fs=require('fs');const p=require('path');function w(d){fs.readdirSync(d).forEach(function(f){var fp=p.join(d,f);var s=fs.statSync(fp);if(s.isDirectory()){if(/node_modules|\\.git/.test(fp))return;w(fp);}else if(/\\.(js|json|md|test\\.js)$/.test(f)){var t=fs.readFileSync(fp,'utf8');if(/sk-[A-Za-z0-9_]{16,}/.test(t)){console.log('LEAK?',fp);}}});}w('.');"`
Expected: No `LEAK?` lines printed. The only `sk-` strings should be `sk-pretend`, `sk-typed`, `sk-test`, `sk-x`, `sk-XYZ`, `sk-SUPER-SECRET`, `sk-LEAK-CHECK`, `sk-DIAG-LEAK-CHECK`, `sk-pretend`, etc. — all obvious dummies under 16 chars or clearly labelled test values. The regex above only flags long realistic keys.

- [ ] **Step 3: Confirm operational guarantees**

Manually verify by reading the diff:
- No API key string in source/test/log output (other than the dummy values in tests).
- No `git commit`, `git push`, `git reset`, `git clean`, `git revert`, `git checkout`, or branch switch was performed during this work.
- No live Coursera graded-assessment page was visited or tested.
- No live Autopilot smoke test was performed.
- `lib/autopilot-*.js`, `lib/module-autopilot.js`, `lib/completion-confirmer.js`, `lib/item-handlers.js`, `lib/module-scraper.js` are untouched. (Use `git status` to confirm — should show only the files this plan lists as modified, plus the existing pre-existing dirty Autopilot files which we did not touch.)

- [ ] **Step 4: Hand off, do NOT commit**

Tell the user: implementation complete. They will decide when to commit. Do not invoke any git operation beyond `git status` / `git diff` for inspection.

---

## Task 11 — Deliverables report

**Files:** (no edits — produce a summary in chat)

- [ ] **Step 1: Produce architecture summary**

Write a short message to the user covering:
1. How the new tab works (UI states + handler registry + content controller).
2. Which existing question detector and answer applier functions were reused: `questionDetector.detectQuestions()`, `moduleScraper.isBlockedAssessmentItem()`, and the new additive `answerApplier.applyStructuredAnswers()` which shares per-type helpers with the existing `applyAnswers()`.
3. How API keys are kept out of source/logs: stored only in `chrome.storage.session` (+ optional `chrome.storage.local` only when user opts in), attached only to the outbound `Authorization` header by the background SW, never in returned values, never in diagnostics, never in DOM text. The sidebar clears its input.value after Save.
4. How model answers are validated before field input: `aiAnswerValidator.validateAndMap()` rejects unknown question IDs, unknown option IDs, type mismatches, and any selector/script/url/submit smuggled fields; the snapshot token is recompared at Apply time to refuse on stale state.
5. How graded/blocked pages are prevented: `aiQuestionContext.isCurrentPageBlocked()` wraps `moduleScraper.isBlockedAssessmentItem()` over `{url, title}`, and the sidebar disables Generate/Apply when the page is ineligible.

- [ ] **Step 2: Produce RED-test report**

List the new tests created in Tasks 2, 3, 4, 5, 7, 9. State explicitly that each failed before its implementation step (because the module/function did not exist) and passed after implementation.

- [ ] **Step 3: Produce implementation report**

List exactly:
- Files created: `lib/ai-question-context.js`, `lib/ai-answer-validator.js`, `lib/deepseek-client.js`, `tests/ai-question-context.test.js`, `tests/ai-answer-validator.test.js`, `tests/deepseek-client.test.js`, `tests/ai-answer-tab.test.js`.
- Files modified: `manifest.json` (add `host_permissions` + new content_scripts entries), `lib/sidebar.js` (new tab/panel/handlers, no existing tab touched), `lib/answer-applier.js` (additive `applyStructuredAnswers` + private per-type helpers; existing `applyAnswers` behavior unchanged), `tests/answer-applier.test.js` (new structured-input tests), `tests/sidebar.test.js` (new tab tests), `background.js` (new isolated `ccp.ai.*` listener), `content.js` (new AI controller block).
- Explain: background SW route receives sanitized snapshot + reads key from session storage + calls DeepSeek + returns normalized result; content/sidebar workflow scans → previews → optionally generates → previews suggestions → optionally applies via existing answer-applier helpers.

- [ ] **Step 4: Produce verification report**

Quote the `npm test` summary line: number of tests passed/failed. Cite specific filenames whose tests confirm the most safety-critical guarantees:
- `tests/autopilot-authority.test.js` (PHASE 15 surface still locked).
- `tests/ai-answer-validator.test.js` (model cannot smuggle DOM action, unknown IDs rejected).
- `tests/deepseek-client.test.js` (key only in Authorization header, never in returned object or body).
- `tests/ai-answer-tab.test.js` (end-to-end including blocked-page refusal and stale-snapshot refusal).

- [ ] **Step 5: Produce operational confirmation**

State explicitly that:
- No API key appears in source, tests, or logs (only obvious dummy strings in tests).
- No commit, push, reset, clean, revert, or branch operation was performed.
- No live Coursera graded-assessment testing was performed.
- No Autopilot live smoke test was performed.
- Autopilot files were not touched (verify via `git status` — any modifications to `lib/autopilot-*.js` / `lib/module-autopilot.js` / etc. in the dirty worktree pre-date this work and were left as-is).

---

## Notes & Risks

- **DeepSeek model identifier (Task 5 Step 5)** — the implementer MUST confirm the current recommended model name from the live docs before merge. Do not invent.
- **MV3 service worker `importScripts`** — if `manifest.json` declares `background.type: "module"`, `importScripts` will not work. The current manifest does not declare `type`, which means it's a classic worker; verify and adjust the import strategy in `background.js` if needed.
- **`chrome.storage.session` availability** — requires Chrome 102+. If the test environment lacks it, the AI feature degrades to no-key gracefully because `readKey` falls back to `chrome.storage.local`.
- **JSDOM contenteditable + computed style edge cases** — already handled by `question-detector.js`. The AI feature inherits that behavior by calling `detectQuestions()` directly.
- **Pre-existing dirty Autopilot worktree** — do not touch unless a step explicitly says to. The `git status` baseline at start of this plan included many `M` autopilot files; leave them. The end-of-plan `git status` should add ONLY the files listed in the Implementation report.
