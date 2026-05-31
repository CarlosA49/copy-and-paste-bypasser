# Autopilot Auto-Submit AI-Answered Assessments — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Auto-submit quizzes after autofill" actually open, AI-answer, type free-text, submit, and continue through graded/ungraded assessments and peer reviews — with a green-check auto-resume for manual-answer pauses, plus targeted accuracy/stuck-pause fixes.

**Architecture:** The AI handler (`assessmentAi`) gains a submit branch gated on `autoSubmitQuizzes`, types `free_text` via the auto-typer (Fast speed in fast mode), and emits a dedicated `missing-key` outcome. The applier gains a `deferText` mode that hands free-text targets back to the handler instead of setting them. Peer-review un-blocks in the live queue (either-toggle) and honors `autoSubmitQuizzes`. A controller-level watcher auto-resumes manual-answer pauses on green-check. Completion detection is hardened by passing `courseraDom` into the confirmer and adding a conservative graded-results signal.

**Tech Stack:** Vanilla JS (IIFE modules, `module.exports` + `window.ClipboardCleaner` dual export), Node built-in test runner (`node --test`), jsdom. No build step.

**Spec:** `docs/superpowers/specs/2026-05-30-autopilot-auto-submit-assessments-design.md`

**VERIFICATION DISCIPLINE (project memory):** the harness can black out or fabricate tool output. For every test run, redirect to a file and Read it back; confirm each commit landed via `git log --oneline -1`. On Windows PowerShell: `node --test tests/<file>.test.js 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`. (Bash: `node --test tests/<file>.test.js > t.log 2>&1`.)

---

### Task 0: Baseline

**Files:** none (read-only).

- [ ] **Step 1: Record the green baseline**

Run: `node --test 2>&1 | Out-File -Encoding utf8 baseline.log` then Read `baseline.log`.
Expected: all tests pass (project memory baseline: 1440 tests, 0 fail). Note the exact `# pass` / `# fail` counts. Every later task must keep `# fail` at 0 and not reduce `# pass` except where a test is intentionally rewritten.

- [ ] **Step 2: Confirm branch**

Run: `git status -sb`
Expected: on `feat/module-autopilot`. Do all work on this branch.

---

### Task 1: Applier `deferText` mode (free_text only)

**Files:**
- Modify: `lib/answer-applier.js:416-431` (the `free_text`/`code` branch) and `:327-334`, `:445-451` (signature/return)
- Test: `tests/answer-applier.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/answer-applier.test.js`:

```js
test('deferText: free_text is deferred to pendingText, not filled; choices still applied', () => {
  const { applyStructuredAnswers } = require('../lib/answer-applier.js');
  const doc = dom(
    makeQuestion(1,
      '<fieldset>' +
        '<label><input type="radio" name="q1"> Alpha</label>' +
        '<label><input type="radio" name="q1"> Beta</label>' +
      '</fieldset>') +
    makeQuestion(2, '<textarea id="q2"></textarea>')
  );
  const list = [
    { questionNumber: 1, type: 'single_choice', choiceText: 'Beta' },
    { questionNumber: 2, type: 'free_text', value: 'My essay answer.' },
  ];
  const out = applyStructuredAnswers(list, doc.body, { verbose: false, deferText: true });
  // Choice applied immediately.
  const checked = doc.querySelectorAll('input[name="q1"]:checked');
  assert.equal(checked.length, 1);
  // free_text NOT written; handed back instead.
  assert.equal(doc.querySelector('#q2').value, '');
  assert.ok(Array.isArray(out.pendingText));
  assert.equal(out.pendingText.length, 1);
  assert.equal(out.pendingText[0].type, 'free_text');
  assert.equal(out.pendingText[0].value, 'My essay answer.');
  assert.equal(out.pendingText[0].el, doc.querySelector('#q2'));
  assert.equal(out.pendingText[0].questionNumber, 2);
});

test('deferText off (default): free_text is filled directly (back-compat)', () => {
  const { applyStructuredAnswers } = require('../lib/answer-applier.js');
  const doc = dom(makeQuestion(1, '<textarea id="q1"></textarea>'));
  const out = applyStructuredAnswers(
    [{ questionNumber: 1, type: 'free_text', value: 'hello' }], doc.body, { verbose: false });
  assert.equal(doc.querySelector('#q1').value, 'hello');
  assert.ok(!out.pendingText || out.pendingText.length === 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/answer-applier.test.js 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: FAIL — `out.pendingText` is undefined.

- [ ] **Step 3: Implement `deferText`**

In `lib/answer-applier.js`, in `applyStructuredAnswers`, add the flag + collector. Change the head (`:328-334`) from:

```js
    const opts = options || {};
    const verbose = opts.verbose !== false;
    const maxRetries = opts.maxRetries || 3;
    const questions = questionDetector.detectQuestions(rootEl);
    const list = Array.isArray(structuredList) ? structuredList : [];
    const results = [];
    let filled = 0, failed = 0;
```

to:

```js
    const opts = options || {};
    const verbose = opts.verbose !== false;
    const maxRetries = opts.maxRetries || 3;
    const deferText = !!opts.deferText;
    const questions = questionDetector.detectQuestions(rootEl);
    const list = Array.isArray(structuredList) ? structuredList : [];
    const results = [];
    const pendingText = [];
    let filled = 0, failed = 0;
```

Then replace the `free_text`/`code` branch (`:416-431`) — insert the defer check at the top of that branch:

```js
      if (item.type === 'free_text' || item.type === 'code') {
        const target = q.targets && q.targets[0];
        if (!target) { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'field not found' }); failed++; continue; }
        const val = String(item.value == null ? '' : item.value);
        if (deferText && item.type === 'free_text') {
          pendingText.push({ el: target, value: val, type: 'free_text', questionNumber: q.questionNumber });
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'deferred-text' });
          continue;
        }
        if (target.scrollIntoView) { try { target.scrollIntoView({ block: 'center' }); } catch (_) {} }
        const rr = fillTextOnce(target, val);
        if (rr.ok) {
          // code is best-effort; the HANDLER decides to pause. Applier just fills + flags.
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'filled', valueUsed: rr.valueUsed, bestEffort: item.type === 'code' });
          filled++;
        } else {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: rr.reason || 'value-did-not-stick' });
          failed++;
        }
        continue;
      }
```

Then add `pendingText` to the return (`:445-451`):

```js
    return {
      detectedQuestions: questions.length,
      parsedAnswers: list.length,
      mode: 'structured',
      results: results,
      pendingText: pendingText,
      summary: { total: questions.length, filled: filled, failed: failed, missingAnswers: 0, missingQuestions: 0 },
    };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/answer-applier.test.js 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: PASS (all answer-applier tests).

- [ ] **Step 5: Commit**

```bash
git add lib/answer-applier.js tests/answer-applier.test.js
git commit -m "feat(answer-applier): deferText mode hands free_text targets back instead of filling

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Un-block peer-review in the live queue (either-toggle)

**Files:**
- Modify: `lib/module-autopilot.js:110-130` (`buildOrderedQueue`)
- Test: `tests/module-autopilot.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/module-autopilot.test.js`:

```js
test('buildOrderedQueue: peer-review un-blocks when EITHER aiAnswerAssessments or autoSubmitQuizzes is on', () => {
  const { buildOrderedQueue } = require('../lib/module-autopilot.js');
  const scraperMod = require('../lib/module-scraper.js');
  const rawItems = [
    { id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Lecture', completed: false },
    { id: 'pr1', kind: 'peer-review', url: '/learn/x/peer/pr1/review', title: 'Peer Review', completed: false },
  ];
  // Neither toggle: peer-review stays blocked.
  const none = buildOrderedQueue(scraperMod, rawItems, null, {});
  const n = none.queue.find(function (it) { return it.id === 'pr1'; });
  assert.ok(n && n.blocked === true, 'peer-review blocked when no toggle');
  // Only autoSubmitQuizzes (no key): peer-review un-blocked.
  const auto = buildOrderedQueue(scraperMod, rawItems, null, { autoSubmitQuizzes: true });
  const a = auto.queue.find(function (it) { return it.id === 'pr1'; });
  assert.ok(a && !a.blocked, 'peer-review un-blocked when autoSubmitQuizzes on');
  // Only aiAnswerAssessments: peer-review un-blocked.
  const ai = buildOrderedQueue(scraperMod, rawItems, null, { aiAnswerAssessments: true });
  const b = ai.queue.find(function (it) { return it.id === 'pr1'; });
  assert.ok(b && !b.blocked, 'peer-review un-blocked when aiAnswerAssessments on');
});

test('buildOrderedQueue: quiz still requires the AI toggle (autoSubmit alone does NOT un-block a quiz)', () => {
  const { buildOrderedQueue } = require('../lib/module-autopilot.js');
  const scraperMod = require('../lib/module-scraper.js');
  const rawItems = [
    { id: 'v1', kind: 'video', url: '/learn/x/lecture/v1/intro', title: 'Lecture', completed: false },
    { id: 'q1', kind: 'quiz', url: '/learn/x/quiz/q1/intro-quiz', title: 'Quiz', completed: false },
  ];
  const auto = buildOrderedQueue(scraperMod, rawItems, null, { autoSubmitQuizzes: true });
  const q = auto.queue.find(function (it) { return it.id === 'q1'; });
  assert.ok(q && q.blocked === true, 'quiz stays blocked without the AI toggle');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/module-autopilot.test.js 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: FAIL — the first new test fails (`pr1` is blocked even with `autoSubmitQuizzes`).

- [ ] **Step 3: Implement either-toggle un-block**

In `lib/module-autopilot.js`, in `buildOrderedQueue`, change the head (`:111`) and the blocked branch (`:117-126`).

Change `:111` from:
```js
    const aiOn = !!(settings && settings.aiAnswerAssessments);
```
to:
```js
    const aiOn = !!(settings && settings.aiAnswerAssessments);
    const autoSubmitOn = !!(settings && settings.autoSubmitQuizzes);
```

Replace the `if (isBlocked) { ... }` body (`:117-126`) with:
```js
      if (isBlocked) {
        // Quiz/exam un-block requires the AI toggle (needs the key to answer).
        // Peer-review un-blocks on EITHER toggle (canned comments need no key).
        // Hard-skip kinds (programming, external launch, assignment) stay blocked.
        const peerReview = (it.kind === 'peer-review') || /\/peer\//i.test(it.url || '');
        const isQuizExam = (it.kind === 'quiz' || /\/quiz\//i.test(it.url || '') || /\/exam\//i.test(it.url || ''));
        if (aiOn && !_isHardSkipBlock(it) && !peerReview && isQuizExam) {
          ordered.push(Object.assign({}, it, { aiAnswerable: true }));
        } else if (peerReview && (aiOn || autoSubmitOn)) {
          ordered.push(Object.assign({}, it, { peerReviewable: true }));
        } else {
          ordered.push(Object.assign({}, it, { blocked: true, blockReason: blockReasonLabel(it) }));
        }
      } else {
```

> The `peerReviewable:true` tag is informational; routing still goes through `handlerForKind('peer-review')` → `handlers.peerReview` (`:1026`), which already exists.

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/module-autopilot.test.js 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: PASS (new tests pass; existing queue tests still green — the existing `!peerReview` quiz/programming test at the original `:6759` still passes because quiz/programming behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(module-autopilot): un-block peer-review in the live queue on either toggle

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Outcome taxonomy (classification + reason text)

**Files:**
- Modify: `lib/module-autopilot.js:71-85` (`isFailureOutcome`), `:169-183` (`FAILURE_REASON_TEXT`), and add `WATCHER_ARMED_OUTCOMES` near the top.
- Test: `tests/module-autopilot.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/module-autopilot.test.js`:

```js
test('new assessment outcomes are classified correctly', () => {
  const mod = require('../lib/module-autopilot.js');
  // Submitted advances (NOT a failure).
  assert.equal(mod._isFailureOutcome({ outcome: 'assessment-ai-submitted' }), false);
  // These pause.
  assert.equal(mod._isFailureOutcome({ outcome: 'assessment-ai-needs-key' }), true);
  assert.equal(mod._isFailureOutcome({ outcome: 'assessment-ai-no-submit-button' }), true);
  assert.equal(mod._isFailureOutcome({ outcome: 'peer-review-filled-paused' }), true);
});

test('reason text for the new pause outcomes is actionable + mentions auto-resume where applicable', () => {
  const mod = require('../lib/module-autopilot.js');
  assert.ok(/api key/i.test(mod._reasonText({ outcome: 'assessment-ai-needs-key' })));
  assert.ok(/submit/i.test(mod._reasonText({ outcome: 'assessment-ai-no-submit-button' })));
  assert.ok(/review/i.test(mod._reasonText({ outcome: 'peer-review-filled-paused' })));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/module-autopilot.test.js --test-name-pattern "new assessment outcomes" 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: FAIL — `assessment-ai-submitted` is not yet recognized (defaults to failure via the `!o.outcome` guard? No — unknown outcome returns false, so `assessment-ai-submitted` already returns false; but `assessment-ai-needs-key` returns false too, which the test wants true). At least the `needs-key`/`no-submit-button`/`peer-review-filled-paused` asserts FAIL.

- [ ] **Step 3: Implement taxonomy**

In `lib/module-autopilot.js`, add to `isFailureOutcome` (after `:81`):
```js
    if (o.outcome === 'assessment-ai-no-answer') return true;
    if (o.outcome === 'assessment-ai-needs-key') return true;
    if (o.outcome === 'assessment-ai-no-submit-button') return true;
    if (o.outcome === 'peer-review-filled-paused') return true;
```
(`assessment-ai-submitted` is intentionally absent → falls through to `return false`, so it advances.)

Add to `FAILURE_REASON_TEXT` (inside the object, after the `assessment-ai-no-answer` line `:182`):
```js
    'assessment-ai-needs-key': "No AI API Key — answer it manually or via the Answering for you tab. I'll resume automatically once it's marked complete.",
    'assessment-ai-no-submit-button': "Answers filled — I couldn't find the Submit button. Click Submit and I'll continue once it's marked complete.",
    'peer-review-filled-paused': 'Peer review filled — review and submit, then Resume.',
```
Also update the existing `assessment-ai-no-answer` message (`:182`) to:
```js
    'assessment-ai-no-answer': "No AI answer produced — answer manually or via the Answering for you tab. I'll resume once it's marked complete.",
```

Add near the other top-level consts (right after the `FAILURE_REASON_TEXT` object closes, ~`:184`):
```js
  // Pauses where the user must act and the autopilot should auto-resume on
  // green-check (NOT review pauses like assessment-ai-answered-paused).
  const WATCHER_ARMED_OUTCOMES = {
    'assessment-ai-needs-key': true,
    'assessment-ai-no-answer': true,
    'assessment-ai-no-submit-button': true,
    'peer-review-needs-user': true,
  };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test tests/module-autopilot.test.js 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(module-autopilot): classify assessment-ai submit/needs-key/no-submit + peer-filled outcomes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `typeIntoElement` helper + `assessmentAi` rewrite (type / submit / needs-key / retry)

**Files:**
- Modify: `lib/item-handlers.js` — add `typeIntoElement` inside `createHandlers` (after the `rec` helper, ~`:107`); rewrite `assessmentAi` (`:579-640`).
- Test: `tests/item-handlers.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/item-handlers.test.js`. This fake typing engine records the `speed` option and types instantly:

```js
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
    '<button type="submit">Submit</button>',
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
```

> The existing test "assessmentAi handler: builds snapshot, applies AI answers, pauses (no submit)" (`:1068`) passes `behaviorMode:'fast'` with **no** `autoSubmitQuizzes` → still expects `assessment-ai-answered-paused`. The rewrite preserves that (autoSubmit defaults false), so it keeps passing.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/item-handlers.test.js --test-name-pattern "assessmentAi:" 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: FAIL — current handler always returns `assessment-ai-answered-paused`; new outcomes/typing not present.

- [ ] **Step 3: Add `typeIntoElement` helper**

In `lib/item-handlers.js`, inside `createHandlers`, after the `rec` function (`:107`), add:

```js
    // Type a value into an editable element via the auto-typer when available
    // (Fast speed in fast mode, Normal otherwise); direct-set fallback if the
    // engine is unavailable. Resolves when typing completes; rejects on abort.
    function typeIntoElement(el, text, mode, signal) {
      const value = String(text == null ? '' : text);
      return new Promise(function (resolve, reject) {
        if (typingEngine && typingEngine.TypingEngine && typingInjector) {
          let settled = false;
          let onAbort = null;
          const engine = new typingEngine.TypingEngine();
          function detach() {
            if (onAbort && signal && signal.removeEventListener) {
              try { signal.removeEventListener('abort', onAbort); } catch (_) {}
            }
          }
          if (signal && signal.addEventListener) {
            onAbort = function () {
              if (settled) return; settled = true;
              try { engine.stop(); } catch (_) {}
              detach(); reject(new Error('aborted'));
            };
            if (signal.aborted) { onAbort(); return; }
            signal.addEventListener('abort', onAbort, { once: true });
          }
          engine.start({
            text: value,
            target: el,
            profile: 'Balanced Natural',
            speed: mode === 'fast' ? 'Fast' : 'Normal',
            simulateTypos: false,
            onTick: function (ev) { typingInjector.insertOrBackspace(el, ev); },
            onDone: function () { if (settled) return; settled = true; detach(); resolve(); },
          });
        } else {
          try {
            if ('value' in el) el.value = value; else el.textContent = value;
            const win = (el.ownerDocument && el.ownerDocument.defaultView) || null;
            if (win) {
              el.dispatchEvent(new win.Event('input', { bubbles: true }));
              el.dispatchEvent(new win.Event('change', { bubbles: true }));
            }
          } catch (_) {}
          resolve();
        }
      });
    }
```

- [ ] **Step 4: Rewrite `assessmentAi`**

Replace the whole `assessmentAi` function (`:579-640`) with:

```js
    function _mapStructured(raw, snapshot) {
      let structured = [];
      if (aiValidator && typeof aiValidator.validateAndMap === 'function') {
        const v = aiValidator.validateAndMap(raw, snapshot, { expectedToken: snapshot.token });
        if (v && v.ok) structured = _suggestionsToStructured(v.suggestions);
      }
      if (structured.length === 0 && aiPermissive && typeof aiPermissive.extract === 'function') {
        const p = aiPermissive.extract(raw, snapshot);
        if (p && p.suggestions) structured = _suggestionsToStructured(p.suggestions);
      }
      return structured;
    }

    // Build a reduced request payload for the questions still unmapped after the
    // first pass. Returns null when nothing-mapped (identical re-ask is useless)
    // or all-mapped (nothing to retry). Sanitized question .id is 'q'+number.
    function _unmappedPayload(sanitized, structured) {
      const mappedIds = {};
      for (let i = 0; i < structured.length; i++) mappedIds['q' + structured[i].questionNumber] = true;
      const all = sanitized.questions || [];
      const rest = all.filter(function (q) { return !mappedIds[q.id]; });
      if (rest.length === 0 || rest.length === all.length) return null;
      return Object.assign({}, sanitized, { questions: rest });
    }

    async function assessmentAi(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const mode = ctx.behaviorMode === 'human' ? 'human' : 'fast';
      const autoSubmit = !!ctx.autoSubmitQuizzes;
      const location = ctx.location || (doc && doc.defaultView && doc.defaultView.location) || { origin: '', href: '' };
      const aiGenerate = ctx.aiGenerate;
      rec('handler.start', { handler: 'assessment-ai', itemId: ctx.item && ctx.item.id });
      if (typeof aiGenerate !== 'function' || !questionContext || !answerApplier) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-answer', reason: 'no-ai-bridge' });
        return { outcome: 'assessment-ai-no-answer' };
      }
      if (courseraDom && typeof courseraDom.isExternalLaunchPage === 'function' && courseraDom.isExternalLaunchPage(doc, location.href)) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-skipped-lti' });
        return { outcome: 'assessment-skipped-lti' };
      }
      const region = (courseraDom && typeof courseraDom.assessmentRoot === 'function' && courseraDom.assessmentRoot(doc)) || doc.body;
      const snapshot = questionContext.buildQuestionSnapshot(region, location, doc);
      if (!snapshot || (snapshot.actionableCount || 0) === 0) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-answer', reason: 'no-actionable-questions' });
        return { outcome: 'assessment-ai-no-answer' };
      }
      const sanitized = questionContext.sanitizeForRequest(snapshot);
      let res;
      try {
        res = await aiGenerate(sanitized);
      } catch (e) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-answer', reason: 'generate-error' });
        return { outcome: 'assessment-ai-no-answer' };
      }
      // Distinguish the missing-key failure for a tailored pause + watcher.
      if (res && res.ok !== true && res.reason === 'missing-key') {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-needs-key' });
        return { outcome: 'assessment-ai-needs-key' };
      }
      if (!res || res.ok !== true || !res.raw) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-answer', reason: 'no-raw' });
        return { outcome: 'assessment-ai-no-answer' };
      }
      let structured = _mapStructured(res.raw, snapshot);
      // Accuracy: one retry pass for unmapped questions (partial mappings only).
      if (structured.length > 0 && structured.length < (snapshot.actionableCount || 0)) {
        const retryPayload = _unmappedPayload(sanitized, structured);
        if (retryPayload) {
          try {
            const res2 = await aiGenerate(retryPayload);
            if (res2 && res2.ok === true && res2.raw) {
              const more = _mapStructured(res2.raw, snapshot);
              const have = {};
              for (let i = 0; i < structured.length; i++) have[structured[i].questionNumber] = true;
              for (let j = 0; j < more.length; j++) if (!have[more[j].questionNumber]) structured.push(more[j]);
              rec('handler.retry', { handler: 'assessment-ai', added: more.length });
            }
          } catch (_) { /* retry is best-effort */ }
        }
      }
      if (structured.length === 0) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-answer', reason: 'no-mappable-answers' });
        return { outcome: 'assessment-ai-no-answer' };
      }
      // Human-mode pre-fill dwell (unchanged from Phase C).
      if (mode === 'human' && timing && typeof timing.quizDwellMs === 'function') {
        await sleep(timing.quizDwellMs(rng), signal);
      }
      // Apply choices/dropdowns/math directly; defer free_text to the typer.
      const summary = answerApplier.applyStructuredAnswers(structured, region, { verbose: false, deferText: true }) || { summary: { filled: 0 }, pendingText: [] };
      let filled = (summary.summary && summary.summary.filled) || 0;
      const pending = Array.isArray(summary.pendingText) ? summary.pendingText : [];
      for (let i = 0; i < pending.length; i++) {
        if (signal && signal.aborted) throw new Error('aborted');
        try {
          await typeIntoElement(pending[i].el, pending[i].value, mode, signal);
          filled += 1;
        } catch (e) {
          if (e && e.message === 'aborted') throw e;
        }
      }
      if (autoSubmit && filled > 0) {
        const submitBtn = firstMatching(doc, SUBMIT_SELECTORS);
        if (!submitBtn) {
          rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-submit-button', filled: filled });
          return { outcome: 'assessment-ai-no-submit-button', filled: filled };
        }
        try { submitBtn.click(); } catch (_) {}
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-submitted', filled: filled });
        return { outcome: 'assessment-ai-submitted', filled: filled };
      }
      rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-answered-paused', filled: filled });
      return { outcome: 'assessment-ai-answered-paused', filled: filled };
    }
```

> `SUBMIT_SELECTORS` (`:510`) and `firstMatching` (`:56`) already exist above this function. `_suggestionsToStructured` (`:564`) is unchanged.

- [ ] **Step 5: Run to verify pass**

Run: `node --test tests/item-handlers.test.js 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: PASS — all new assessmentAi tests pass; the existing `:1068` "pauses (no submit)" and `:1115`/`:1129` tests still pass.

- [ ] **Step 6: Commit**

```bash
git add lib/item-handlers.js tests/item-handlers.test.js
git commit -m "feat(item-handlers): assessmentAi submits on autoSubmit, types free_text, emits needs-key + retry pass

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Peer-review — type comments in fast mode + honor autoSubmitQuizzes

**Files:**
- Modify: `lib/peer-review.js:162-211` (`fillComment`), `:219-310` (handler submit branch)
- Test: `tests/peer-review.test.js` (add new; update fast-mode assertions)

- [ ] **Step 1: Inspect existing fast-mode peer-review tests**

Run: `node --test tests/peer-review.test.js --test-name-pattern "fast" 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`, and Grep `tests/peer-review.test.js` for `fast` and `peer-review-submitted` to find assertions that (a) expect direct-assign in fast mode, or (b) expect unconditional submit. These will be updated in Step 4.

- [ ] **Step 2: Write the failing tests**

Append to `tests/peer-review.test.js` (reuse the file's existing JSDOM/seededRng/signal helpers; if it lacks a fake typing engine, add the same `fakeTypingEngineModule` factory used in `tests/item-handlers.test.js`):

```js
test('peer-review: fast mode types comments via the engine at Fast speed', async () => {
  const pr = require('../lib/peer-review.js');
  const captured = [];
  function FakeEngine() {}
  FakeEngine.prototype.start = function (opts) {
    captured.push({ speed: opts.speed });
    const s = String(opts.text || '');
    const inj = require('../lib/typing-injector.js');
    for (let i = 0; i < s.length; i++) inj.insertOrBackspace(opts.target, { kind: 'char', char: s[i] });
    opts.onDone();
  };
  FakeEngine.prototype.stop = function () {};
  const handler = pr.createPeerReviewHandler({
    sleep: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: { pickComment: function () { return 'great work overall'; } },
    typingEngine: { TypingEngine: FakeEngine },
    typingInjector: require('../lib/typing-injector.js'),
    courseraDom: { assessmentRoot: function (d) { return d.body; }, isExcludedNode: function () { return false; } },
  });
  const { JSDOM } = require('jsdom');
  const doc = new JSDOM('<!doctype html><body>' +
    '<fieldset role="radiogroup"><label><input type="radio" name="c1"> 1 point</label><label><input type="radio" name="c1"> 2 points</label></fieldset>' +
    '<textarea required></textarea>' +
    '<button>Submit Review</button>' +
    '</body>').window.document;
  doc.querySelector('button').click = function () {};
  const out = await handler({ doc: doc, rng: (function(){let s=1;return function(){s=(s*1664525+1013904223)>>>0;return s/0x100000000;};})(), signal: { aborted: false, addEventListener: function(){}, removeEventListener: function(){} }, behaviorMode: 'fast', autoSubmitQuizzes: true });
  assert.equal(out.outcome, 'peer-review-submitted');
  assert.ok(captured.length >= 1 && captured[0].speed === 'Fast', 'fast peer-review types at Fast speed');
  assert.equal(doc.querySelector('textarea').value, 'great work overall');
});

test('peer-review: autoSubmit off → fills but pauses (peer-review-filled-paused, no submit)', async () => {
  const pr = require('../lib/peer-review.js');
  const handler = pr.createPeerReviewHandler({
    sleep: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: { pickComment: function () { return 'nice'; } },
    typingEngine: null, typingInjector: null,
    courseraDom: { assessmentRoot: function (d) { return d.body; }, isExcludedNode: function () { return false; } },
  });
  const { JSDOM } = require('jsdom');
  const doc = new JSDOM('<!doctype html><body>' +
    '<fieldset role="radiogroup"><label><input type="radio" name="c1"> 1 point</label><label><input type="radio" name="c1"> 2 points</label></fieldset>' +
    '<textarea required></textarea>' +
    '<button>Submit Review</button>' +
    '</body>').window.document;
  let submitted = false;
  doc.querySelector('button').click = function () { submitted = true; };
  const out = await handler({ doc: doc, rng: (function(){let s=2;return function(){s=(s*1664525+1013904223)>>>0;return s/0x100000000;};})(), signal: { aborted: false, addEventListener: function(){}, removeEventListener: function(){} }, behaviorMode: 'fast', autoSubmitQuizzes: false });
  assert.equal(out.outcome, 'peer-review-filled-paused');
  assert.equal(submitted, false);
  assert.equal(doc.querySelector('textarea').value, 'nice', 'comment still filled');
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test tests/peer-review.test.js --test-name-pattern "peer-review:" 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: FAIL — fast mode currently direct-assigns (no engine call captured) and always submits (`peer-review-submitted`, never `peer-review-filled-paused`).

- [ ] **Step 4: Implement fast-typing + autoSubmit gating**

In `lib/peer-review.js`, change `fillComment` (`:162-211`). Replace the condition + engine `speed` so the engine is used whenever available (both modes), at mode-derived speed:

Change `:164`:
```js
        if (mode === 'human' && typingEngine && typingEngine.TypingEngine && typingInjector) {
```
to:
```js
        if (typingEngine && typingEngine.TypingEngine && typingInjector) {
```
and change the `start({...})` `speed` field (`:188`):
```js
            speed: 'Normal',
```
to:
```js
            speed: mode === 'fast' ? 'Fast' : 'Normal',
```

In the handler (`:219`), read the flag near the top (after `const mode = ...`, `:223`):
```js
      const autoSubmit = !!ctx.autoSubmitQuizzes;
```

Replace the auto-submit block (`:297-309`) with:
```js
      // 3) Pre-submit pause (human only). Submit only when autoSubmit is on;
      //    otherwise fill-and-pause for the user to review + submit.
      if (mode === 'human' && timing && autoSubmit) {
        await sleep(timing.peerPreSubmitMs(rng), signal);
      }
      if (signal && signal.aborted) throw new Error('aborted');
      if (!autoSubmit) {
        rec('peerReview.filledPaused', { criteria: selections.length, comments: usedComments.length });
        return { outcome: 'peer-review-filled-paused', selections: selections, usedComments: usedComments };
      }
      try { submitBtn.click(); } catch (_) { /* ignore */ }
      rec('peerReview.submitted', { criteria: selections.length, comments: usedComments.length });
      return {
        outcome: 'peer-review-submitted',
        selections: selections,
        usedComments: usedComments,
      };
```

- [ ] **Step 5: Update existing fast-mode peer-review tests**

In `tests/peer-review.test.js`, update any existing test that (per Step 1) asserted fast-mode **direct assignment** (no engine) or **unconditional submit**:
- Tests that drive the handler in fast mode without passing `autoSubmitQuizzes` now get `peer-review-filled-paused`. Add `autoSubmitQuizzes: true` to those ctx objects to keep asserting `peer-review-submitted`, OR update the expected outcome to `peer-review-filled-paused` where the test's intent is "no submit."
- Tests asserting fast mode sets `.value` directly without a typing engine: if they pass no `typingEngine`, behavior is unchanged (direct-set fallback) — leave them. If they pass a real/fake engine and asserted direct-set, update to expect typed output.
Make the minimal edits so each test's *intent* is preserved.

- [ ] **Step 6: Run to verify pass**

Run: `node --test tests/peer-review.test.js 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: PASS (new + updated existing).

- [ ] **Step 7: Update peer-review log formatter for the new pause (if needed)**

`formatPeerReviewLogLines` (`lib/module-autopilot.js:190`) handles `peer-review-needs-user` and `peer-review-submitted`. `peer-review-filled-paused` is a generic pause — the banner comes from `FAILURE_REASON_TEXT` (Task 3). No formatter change required. Confirm by Reading `:190-211`.

- [ ] **Step 8: Commit**

```bash
git add lib/peer-review.js tests/peer-review.test.js
git commit -m "feat(peer-review): type comments in fast mode (Fast speed) + honor autoSubmitQuizzes

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Auto-resume watcher

**Files:**
- Modify: `lib/module-autopilot.js` — add watcher state + `_armResumeWatcher`/`_disarmResumeWatcher`/`_itemLooksComplete` (after `queuedRun` decl, ~`:443`); arm in the failure-outcome pause path (`:1276-1285`); disarm in `resume`/`pause`/`stop`/`destroy`.
- Test: `tests/module-autopilot.test.js`

- [ ] **Step 1: Write the failing test**

Append to `tests/module-autopilot.test.js` (uses the file's existing `makePage`/`fakeStorage`/`seededRng`/`stateMod`/`mkFakeHandlers` helpers — mirror the Phase D peer test at `:7063`):

```js
test('auto-resume watcher: arms on needs-key pause, resumes when the row shows complete', async () => {
  const QUIZ_HTML =
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/x/quiz/q1/a">Quiz</a>' +
      '<a href="/learn/x/supplement/r1/reading">Reading</a>' +
    '</div>';
  const j = makePage(QUIZ_HTML, 'https://www.coursera.org/learn/x/quiz/q1/a');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running'; d.courseId = 'x'; d.runId = 'r1'; d.ownerTabKey = 'tab-1';
  d.settings.aiAnswerAssessments = true;
  d.queue = [
    { id: 'q1', kind: 'quiz', url: '/learn/x/quiz/q1/a', title: 'Quiz', aiAnswerable: true },
    { id: 'r1', kind: 'reading', url: '/learn/x/supplement/r1/reading', title: 'Reading' },
  ];
  d.cursor = 0;
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  // Handlers: assessmentAi returns needs-key.
  const handlers = mkFakeHandlers();
  handlers.assessmentAi = function () { return Promise.resolve({ outcome: 'assessment-ai-needs-key' }); };
  // Scraper green-icon flips to complete on demand.
  let q1Complete = false;
  const scraperMod = Object.assign({}, require('../lib/module-scraper.js'));
  const baseGreen = scraperMod.findGreenCompletionIconInRow;
  scraperMod.findGreenCompletionIconInRow = function (doc, id) {
    if (id === 'q1') return q1Complete ? {} : null;
    return baseGreen ? baseGreen(doc, id) : null;
  };
  const navTargets = [];
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    scraperMod: scraperMod,
    confirmer: { waitForCompletion: function () { return Promise.resolve(true); } },
    nowFn: function () { return 1000000; }, tabKey: 'tab-1', rng: seededRng(1),
    resumeWatcherPollMs: 10,
    navigate: function (url) { navTargets.push(url); return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.bootIfRunning();
  // Paused on needs-key, watcher armed.
  let after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.status, 'paused', 'paused on needs-key');
  // User completes the quiz: row goes green.
  q1Complete = true;
  // Wait for the watcher to detect + auto-resume + advance.
  await new Promise(function (r) { setTimeout(r, 80); });
  after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.ok(after.cursor >= 1 || after.status === 'idle', 'auto-resumed and advanced past the quiz; cursor=' + after.cursor + ' status=' + after.status);
  ap.destroy();
});
```

> If `mkFakeHandlers` / `makePage` / `fakeStorage` are not in scope at the append point, copy their definitions from earlier in the same test file (they are top-level helpers). Confirm by Grepping the file for `function mkFakeHandlers` / `function makePage`.

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/module-autopilot.test.js --test-name-pattern "auto-resume watcher" 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: FAIL — run stays `paused`; cursor never advances (no watcher yet).

- [ ] **Step 3: Add the watcher plumbing**

In `lib/module-autopilot.js`, after `let queuedRun = false;` (`:443`), add:

```js
    // ---- Auto-resume watcher (manual-answer pauses only) ----
    // Polls the outline-row completion signal for the paused item and auto-
    // resumes when it goes complete. Armed only for WATCHER_ARMED_OUTCOMES.
    let _resumeWatcherTimer = null;
    let _resumeWatcherItemId = null;
    const RESUME_WATCHER_POLL_MS = (typeof opts.resumeWatcherPollMs === 'number' && opts.resumeWatcherPollMs > 0) ? opts.resumeWatcherPollMs : 1500;
    function _itemLooksComplete(itemId) {
      try {
        if (scraperMod.findGreenCompletionIconInRow && scraperMod.findGreenCompletionIconInRow(doc, itemId)) return true;
      } catch (_) {}
      try {
        if (courseraDom && doc && typeof doc.querySelectorAll === 'function'
            && typeof courseraDom.parseLearnUrl === 'function' && typeof courseraDom.itemStatus === 'function') {
          const anchors = doc.querySelectorAll('a[href*="/learn/"]');
          for (let i = 0; i < anchors.length; i++) {
            const parsed = courseraDom.parseLearnUrl(anchors[i].getAttribute('href') || '');
            if (parsed && parsed.id === itemId && courseraDom.itemStatus(anchors[i]) === 'completed') return true;
          }
        }
      } catch (_) {}
      return false;
    }
    function _disarmResumeWatcher() {
      if (_resumeWatcherTimer) { clearInterval(_resumeWatcherTimer); _resumeWatcherTimer = null; }
      _resumeWatcherItemId = null;
    }
    function _armResumeWatcher(itemId) {
      _disarmResumeWatcher();
      if (!itemId) return;
      _resumeWatcherItemId = itemId;
      const _armGen = _runGeneration;
      rec('resumeWatcher.armed', { itemId: itemId });
      _resumeWatcherTimer = setInterval(function () {
        if (destroyed || _runGeneration !== _armGen) { _disarmResumeWatcher(); return; }
        if (!_itemLooksComplete(itemId)) return;
        rec('resumeWatcher.completionDetected', { itemId: itemId });
        _disarmResumeWatcher();
        if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('▶ Detected completion — resuming autopilot');
        state.load(function (cur) {
          if (destroyed || _runGeneration !== _armGen) return;
          if (!cur || cur.status !== 'paused') return;
          resume();
        });
      }, RESUME_WATCHER_POLL_MS);
      if (_resumeWatcherTimer && typeof _resumeWatcherTimer.unref === 'function') _resumeWatcherTimer.unref();
    }
```

- [ ] **Step 4: Arm in the failure-outcome pause path**

In `runCurrentItem`, the failure-outcome block sets the banner at `:1283` (`if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, _outcomeReason);`). Immediately after that line, add:

```js
            if (WATCHER_ARMED_OUTCOMES[outcome.outcome]) {
              if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog("⏳ Waiting for you to complete this — I'll resume automatically when it's marked done");
              _armResumeWatcher(item.id);
            }
```

- [ ] **Step 5: Disarm on transitions**

- In `resume()` (`:1970`), add `_disarmResumeWatcher();` as the first statement.
- In `pause()` (`:1917`), add `_disarmResumeWatcher();` as the first statement (manual pause must not auto-resume).
- In `stop()` (`:2108`), add `_disarmResumeWatcher();` near the top (after `rec('run.stopped', {});`).
- In `destroy()` (`:2215`), add `_disarmResumeWatcher();` after `destroyed = true;`.

- [ ] **Step 6: Run to verify pass**

Run: `node --test tests/module-autopilot.test.js --test-name-pattern "auto-resume watcher" 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: PASS — run advances/idles after `q1Complete = true`.

- [ ] **Step 7: Run the full module-autopilot suite**

Run: `node --test tests/module-autopilot.test.js 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: PASS (watcher does not disturb existing flows — it only arms on the four manual-answer outcomes).

- [ ] **Step 8: Commit**

```bash
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(module-autopilot): auto-resume watcher for manual-answer pauses (green-check → resume)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Completion robustness (courseraDom into confirmer + graded-results signal)

**Files:**
- Modify: `lib/page-fallback.js` — add `findGradedResultsIndicator` + export.
- Modify: `lib/completion-confirmer.js:89-94` region — add graded-results evidence (quiz/exam only).
- Modify: `lib/module-autopilot.js:1313` and `:1405` — pass `courseraDom: courseraDom` into both `confirmer.waitForCompletion({...})` calls.
- Test: `tests/page-fallback.test.js`, `tests/completion-confirmer.test.js`

- [ ] **Step 1: Write the failing page-fallback test**

Append to `tests/page-fallback.test.js` (match its existing JSDOM helper):

```js
test('findGradedResultsIndicator: matches a graded/submitted banner, ignores plain text', () => {
  const pf = require('../lib/page-fallback.js');
  const { JSDOM } = require('jsdom');
  const yes = new JSDOM('<!doctype html><body><h2>Grade received</h2></body>').window.document;
  assert.ok(pf.findGradedResultsIndicator(yes));
  const no = new JSDOM('<!doctype html><body><p>Please grade your work carefully.</p></body>').window.document;
  assert.equal(pf.findGradedResultsIndicator(no), null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test tests/page-fallback.test.js --test-name-pattern "findGradedResultsIndicator" 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: FAIL — `pf.findGradedResultsIndicator is not a function`.

- [ ] **Step 3: Implement `findGradedResultsIndicator`**

In `lib/page-fallback.js`, before the `const api = {` block (`:112`), add:

```js
  function findGradedResultsIndicator(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    const RE = /\b(grade received|your (?:latest )?grade|submission received)\b/i;
    const nodes = doc.querySelectorAll('h1, h2, h3, [role="heading"], [role="status"], [data-testid*="grade" i], [data-testid*="submission" i]');
    for (let i = 0; i < nodes.length; i++) {
      const aria = nodes[i].getAttribute && nodes[i].getAttribute('aria-label');
      const txt = (aria || nodes[i].textContent || '').replace(/\s+/g, ' ').trim();
      if (RE.test(txt)) return nodes[i];
    }
    return null;
  }
```

Add to the `api` object (after `findCompletedReadingIndicator: findCompletedReadingIndicator,` `:118`):
```js
    findGradedResultsIndicator: findGradedResultsIndicator,
```

- [ ] **Step 4: Run to verify page-fallback passes**

Run: `node --test tests/page-fallback.test.js 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: PASS.

- [ ] **Step 5: Write the failing confirmer test**

Append to `tests/completion-confirmer.test.js` (match its existing setup; provide a scraper stub whose `findItemCompletionIndicator`/`findGreenCompletionIconInRow` return false, and a pageFallback with `findGradedResultsIndicator`):

```js
test('confirmer: graded-results banner confirms a quiz (quiz/exam only)', async () => {
  const { createConfirmer } = require('../lib/completion-confirmer.js');
  const { JSDOM } = require('jsdom');
  const doc = new JSDOM('<!doctype html><body><h2>Grade received</h2></body>').window.document;
  const scraper = { findItemCompletionIndicator: function () { return false; }, findGreenCompletionIconInRow: function () { return null; } };
  const pageFallback = require('../lib/page-fallback.js');
  const c = createConfirmer({ sleep: function () { return Promise.resolve(); }, nowFn: (function () { let t = 0; return function () { return (t += 1000); }; })() });
  const ok = await c.waitForCompletion({ doc: doc, itemId: 'q1', itemKind: 'quiz', scraper: scraper, pageFallback: pageFallback, timeoutMs: 5000 });
  assert.equal(ok, true);
});

test('confirmer: graded-results banner does NOT confirm a non-assessment kind', async () => {
  const { createConfirmer } = require('../lib/completion-confirmer.js');
  const { JSDOM } = require('jsdom');
  const doc = new JSDOM('<!doctype html><body><h2>Grade received</h2></body>').window.document;
  const scraper = { findItemCompletionIndicator: function () { return false; }, findGreenCompletionIconInRow: function () { return null; } };
  const pageFallback = require('../lib/page-fallback.js');
  const c = createConfirmer({ sleep: function () { return Promise.resolve(); }, nowFn: (function () { let t = 0; return function () { return (t += 2500); }; })() });
  const ok = await c.waitForCompletion({ doc: doc, itemId: 'r1', itemKind: 'reading', scraper: scraper, pageFallback: pageFallback, timeoutMs: 5000 });
  assert.equal(ok, false);
});
```

- [ ] **Step 6: Run to verify confirmer test fails**

Run: `node --test tests/completion-confirmer.test.js --test-name-pattern "graded-results" 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: FAIL — quiz case returns false (evidence not implemented).

- [ ] **Step 7: Add graded-results evidence to the confirmer**

In `lib/completion-confirmer.js`, inside the poll loop, after the reading-completed block (`:89-94`) and before the top-progress block (`:95`), add:

```js
        if ((itemKind === 'quiz' || itemKind === 'exam') && pageFallback
            && typeof pageFallback.findGradedResultsIndicator === 'function'
            && pageFallback.findGradedResultsIndicator(doc)) {
          rec('completion.detected', { itemId: itemId, evidence: 'graded-results' });
          return true;
        }
```

- [ ] **Step 8: Pass courseraDom into the controller's confirmer calls**

In `lib/module-autopilot.js`, both `confirmer.waitForCompletion({...})` call sites:
- `:1313-1320` (primary): add `courseraDom: courseraDom,` to the options object.
- `:1405-1409` (race): add `courseraDom: courseraDom,` to the options object.

Example (primary), change:
```js
              confirmed = await confirmer.waitForCompletion({
                doc: doc, itemId: item.id, itemKind: item.kind, scraper: scraperMod,
                pageFallback: pageFallback,
                signal: signal, timeoutMs: ...
              });
```
to add `courseraDom: courseraDom,` after `pageFallback: pageFallback,` in both places.

- [ ] **Step 9: Run to verify all pass**

Run: `node --test tests/completion-confirmer.test.js 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`, then `node --test tests/module-autopilot.test.js 2>&1 | Out-File -Encoding utf8 t2.log` then Read `t2.log`.
Expected: PASS for both (existing confirmer tests that don't pass `courseraDom` are unaffected; controller tests still green).

- [ ] **Step 10: Commit**

```bash
git add lib/page-fallback.js lib/completion-confirmer.js lib/module-autopilot.js tests/page-fallback.test.js tests/completion-confirmer.test.js
git commit -m "feat(completion): graded-results evidence + pass courseraDom into confirmer to reduce stalls

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Sidebar warning copy

**Files:**
- Modify: `lib/sidebar.js:101` (warning note text)
- Test: `tests/sidebar.test.js` (update any assertion on the old copy)

- [ ] **Step 1: Find assertions on the old copy**

Grep `tests/sidebar.test.js` for `never submitted automatically` and `autopilot-ai-answer-warning`. Note matches to update in Step 4.

- [ ] **Step 2: Write/adjust the test**

If a test asserts the old phrase, update it to assert the new intent. Add (or modify) in `tests/sidebar.test.js`:

```js
test('AI-answer warning copy explains auto-submit + auto-resume behavior', () => {
  const html = buildSidebarHtmlForTest(); // however the file obtains the rendered sidebar markup
  const note = html.match(/data-role="autopilot-ai-answer-warning"[^>]*>([^<]*)</);
  assert.ok(note, 'warning note present');
  assert.ok(/auto-submit/i.test(note[1]) && /resume/i.test(note[1]), 'mentions auto-submit + resume');
});
```
> Use the same rendering helper the file already uses (e.g. `createSidebar`/`render` into a JSDOM document). If the existing test inspects a live DOM node, query `[data-role="autopilot-ai-answer-warning"]` and assert its `textContent` matches `/auto-submit/i` and `/resume/i`.

- [ ] **Step 3: Run to verify it fails**

Run: `node --test tests/sidebar.test.js --test-name-pattern "warning copy" 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: FAIL — old copy lacks "auto-submit"/"resume".

- [ ] **Step 4: Update the copy**

In `lib/sidebar.js:101`, replace the note text. Change:
```js
'<div class="ccp-row ccp-ai-answer-warning" data-role="autopilot-ai-answer-warning" style="font-size:11px;opacity:.8;">AI answers can be wrong; graded answers are filled for your review, never submitted automatically.</div>' +
```
to:
```js
'<div class="ccp-row ccp-ai-answer-warning" data-role="autopilot-ai-answer-warning" style="font-size:11px;opacity:.8;">AI answers can be wrong. With Auto-submit off, answers are filled for your review. With Auto-submit on, the autopilot submits and continues. Without an API key it pauses and resumes automatically once you complete the item.</div>' +
```

Then update any other test (from Step 1) that asserted the old phrase.

- [ ] **Step 5: Run to verify pass**

Run: `node --test tests/sidebar.test.js 2>&1 | Out-File -Encoding utf8 t.log` then Read `t.log`.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/sidebar.js tests/sidebar.test.js
git commit -m "feat(sidebar): clarify AI-answer warning for auto-submit + auto-resume behavior

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Full-suite verification + integration sanity

**Files:** none (verification).

- [ ] **Step 1: Run the entire suite**

Run: `node --test 2>&1 | Out-File -Encoding utf8 final.log` then Read `final.log`.
Expected: `# fail 0`, and `# pass` ≥ the Task 0 baseline plus the new tests (net new tests added: ~16). If any pre-existing test regressed, investigate before proceeding — do NOT delete a failing test to make it green; fix the root cause or the test's intent per Task 5 Step 5 guidance.

- [ ] **Step 2: Confirm all commits landed**

Run: `git log --oneline -9`
Expected: the 8 feature commits (Tasks 1-8) plus the two earlier spec commits are present, newest first.

- [ ] **Step 3: Manual integration checklist (record in the PR/notes — do NOT automate)**

These require a real Coursera session and an API key; verify by hand:
1. AI toggle on + Auto-submit **on**, key present: a quiz opens, answers fill, free-text is typed (visible char-by-char, faster in Fast mode), Submit is clicked, run continues.
2. AI toggle on + Auto-submit **off**: quiz fills then pauses with "review and submit" banner; manual Resume continues.
3. AI toggle on + **no key**: quiz pauses with the needs-key banner; after you answer + submit and the row shows the green check, the autopilot **auto-resumes** and continues.
4. Auto-submit on + AI toggle off: a **peer review** opens, options selected, comments typed, submitted, continues — **and a quiz stays skipped**.
5. Fast vs Human: typing is visibly faster in Fast mode but still character-by-character; Human mode unchanged.

- [ ] **Step 4: Update project memory**

Update `memory/MEMORY.md` + the Phase D status memory to correct the record: the Phase D peer-review handler was complete but **not wired into the live queue**; this work un-blocked it (either-toggle) and added auto-submit/typed-text/auto-resume. (Use the Write tool on the memory files per the memory protocol.)

---

## Self-Review (completed by plan author)

**1. Spec coverage:**
- §3 behavior model (either-toggle un-block) → Task 2. ✓
- §4 outcome taxonomy (4 new outcomes, classification, reason text, watcher set) → Task 3. ✓
- §5.1 queue un-block → Task 2. ✓
- §5.2 applier deferText (free_text only) → Task 1. ✓
- §5.3 typeIntoElement → Task 4 Step 3. ✓
- §5.4 assessmentAi (needs-key, type, submit branch, retry) → Task 4 Steps 4. ✓
- §5.5 peer-review fast-typing + autoSubmit gating + peer-review-filled-paused → Task 5. ✓
- §5.6 auto-resume watcher (arm set incl. no-submit-button per D2; messaging) → Task 6 + Task 3 messages. ✓
- §5.7 courseraDom into confirmer + graded-results evidence → Task 7. ✓
- §5.8 sidebar copy → Task 8. ✓
- §8 testing → tests in every task + Task 9 full suite. ✓

**2. Placeholder scan:** No "TBD/TODO/handle edge cases" — every code step shows complete code. The only deliberately descriptive steps are Task 5 Step 5 and Task 8 (existing-test updates) where the exact existing assertions must be read first; both name the precise file, grep target, and required edit.

**3. Type/name consistency:** `deferText` (Task 1) ↔ consumed in Task 4. `pendingText` shape `{el,value,type,questionNumber}` (Task 1) ↔ read in Task 4 (`pending[i].el`/`.value`). New outcomes spelled identically across Tasks 3/4/5/6: `assessment-ai-submitted`, `assessment-ai-needs-key`, `assessment-ai-no-submit-button`, `peer-review-filled-paused`. `WATCHER_ARMED_OUTCOMES` defined Task 3, used Task 6. `typeIntoElement(el,text,mode,signal)` signature consistent. `findGradedResultsIndicator` defined Task 7 Step 3, used Task 7 Step 7. `resumeWatcherPollMs` opt consistent between Task 6 test and impl.
