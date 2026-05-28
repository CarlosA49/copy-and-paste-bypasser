# AI Apply — Text/Math Input Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AI Apply fill `math_input` (text + math) answers on graded/blocked assessment pages by (a) extending the DeepSeek system prompt with an explicit text-answer shape example and (b) making the validator tolerant of the four type-token variants the AI tends to emit.

**Architecture:** Two production files. No new files. The applier (`applyStructuredAnswers`) already handles `math_input` correctly via the same `mathNormalize` + `answerMatcher.applyTextMatches` code path the autopilot "answer for you" system uses — we just need the AI's responses to reach it as `{ applicable: true, value: '<string>' }`.

**Tech Stack:** Vanilla JS (MV3 content + background), `node:test`, `jsdom`. No build step.

**Spec:** `docs/superpowers/specs/2026-05-28-ai-text-math-apply-fix-design.md`

---

## Scope Guard

- **Production files allowed:** `lib/deepseek-client.js`, `lib/ai-answer-validator.js`. No other production file.
- **Test files allowed:** `tests/deepseek-client.test.js`, `tests/ai-answer-validator.test.js`. No other test file.
- **Frozen:** everything else, including all autopilot files, `lib/answer-applier.js`, `lib/ai-answer-controller.js`, `lib/ai-question-context.js`, `lib/question-detector.js`, `lib/math-normalize.js`, `lib/answer-matcher.js`, `lib/sidebar.js`, `lib/managed-client.js`, `content.js`, `background.js`, `manifest.json`, options page.
- No manifest permission changes.
- No real API key.

---

## Task 1: Tolerant validator for `math_input` typed answers

**Files:**
- Test: `tests/ai-answer-validator.test.js` (append)
- Modify: `lib/ai-answer-validator.js:94-98` (replace the `math_input` branch)

- [ ] **Step 1: Append seven RED tests to `tests/ai-answer-validator.test.js`**

Open `tests/ai-answer-validator.test.js`. Append at end of file:

```js
test('U15-V1: math_input with ans.type="math_input" is accepted (alias)', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { type: 'math_input', value: '0.5' }, explanation: '', confidence: 'high' }],
  }, SNAP);
  assert.equal(out.ok, true);
  const s = out.suggestions[0];
  assert.equal(s.applicable, true, 'must be applicable');
  assert.equal(s.value, '0.5');
  assert.equal(s.mappingStatus, 'matched');
});

test('U15-V2: math_input with ans.type="numerical" is accepted (alias)', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { type: 'numerical', value: '42' } }],
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].value, '42');
});

test('U15-V3: math_input with ans.type="input" is accepted (alias)', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { type: 'input', value: 'hello world' } }],
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].value, 'hello world');
});

test('U15-V4: math_input with numeric ans.value is coerced to string', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { type: 'text', value: 3.14 } }],
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].value, '3.14');
});

test('U15-V5: math_input with ans.text alias (instead of ans.value) is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { type: 'text', text: 'alpha' } }],
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].value, 'alpha');
});

test('U15-V6: math_input with bare value and no ans.type is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { value: 'bare' } }],
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].value, 'bare');
});

test('U15-V7: math_input with empty / whitespace-only value is still rejected', () => {
  const out1 = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { type: 'text', value: '' } }],
  }, SNAP);
  assert.equal(out1.suggestions[0].applicable, false);
  assert.equal(out1.suggestions[0].mappingStatus, 'wrong-type');
  const out2 = v.validateAndMap({
    answers: [{ question_id: 'q3', answer: { type: 'text', value: '   ' } }],
  }, SNAP);
  assert.equal(out2.suggestions[0].applicable, false);
});
```

- [ ] **Step 2: Run the tests and confirm all 7 FAIL**

Run: `node --test --test-name-pattern="U15-V" tests/ai-answer-validator.test.js`

Expected: 7 fail. Capture the verbatim failure messages — most should report `applicable: false` and `mappingStatus: 'wrong-type'`.

- [ ] **Step 3: Replace the `math_input` branch in `lib/ai-answer-validator.js`**

Open `lib/ai-answer-validator.js`. Find the existing branch at lines 94-98:

```js
} else if (q.type === 'math_input') {
  if (ans.type !== 'text' || typeof ans.value !== 'string' || ans.value.trim() === '') {
    suggestions.push(Object.assign(base, { mappingStatus: 'wrong-type', applicable: false })); rejected++; continue;
  }
  suggestions.push(Object.assign(base, { value: ans.value.trim(), mappingStatus: 'matched', applicable: true }));
```

Replace with:

```js
} else if (q.type === 'math_input') {
  var TEXT_LIKE_TYPES = { 'text': 1, 'math_input': 1, 'numerical': 1, 'input': 1 };
  // Tolerate four shape variants the AI tends to emit, including bare strings and numbers
  // and the 'text' alias for the value field. The applier downstream is robust to any of them.
  var rawVal = (ans && typeof ans === 'object')
    ? (ans.value !== undefined ? ans.value : ans.text)
    : undefined;
  var typeOk = !ans || !ans.type || (typeof ans.type === 'string' && TEXT_LIKE_TYPES[ans.type] === 1);
  var stringVal = (typeof rawVal === 'string') ? rawVal
                : (typeof rawVal === 'number' && isFinite(rawVal)) ? String(rawVal)
                : null;
  if (!typeOk || stringVal === null || stringVal.trim() === '') {
    suggestions.push(Object.assign(base, { mappingStatus: 'wrong-type', applicable: false })); rejected++; continue;
  }
  suggestions.push(Object.assign(base, { value: stringVal.trim(), mappingStatus: 'matched', applicable: true }));
```

The branches before and after are unchanged. Specifically:
- `single_choice` branch above stays.
- `multiple_choice` branch above stays.
- The final `else` branch below (for genuinely unsupported question types) stays.

- [ ] **Step 4: Re-run the U15-V tests and confirm 7/7 PASS**

Run: `node --test --test-name-pattern="U15-V" tests/ai-answer-validator.test.js`

Expected: 7 pass.

- [ ] **Step 5: Run the full validator test file**

Run: `node --test tests/ai-answer-validator.test.js`

Expected: every test PASSES, including the pre-existing positive test that uses `ans.type === 'text'`.

- [ ] **Step 6: Commit**

```
git add lib/ai-answer-validator.js tests/ai-answer-validator.test.js
git commit -m "feat(ai-answer-validator): accept text/math_input/numerical/input + numeric value + ans.text alias"
```

---

## Task 2: Extend DeepSeek SYSTEM_PROMPT with text-answer shape example

**Files:**
- Test: `tests/deepseek-client.test.js` (append)
- Modify: `lib/deepseek-client.js:14-20` (replace `SYSTEM_PROMPT`)

- [ ] **Step 1: Append two RED tests to `tests/deepseek-client.test.js`**

Open `tests/deepseek-client.test.js`. Append at end of file:

```js
test('U15-P1: SYSTEM_PROMPT contains explicit math_input answer shape example', async () => {
  let captured = null;
  const f = makeFetch(function (url, init) {
    try { captured = JSON.parse(init.body); } catch (_) {}
    return makeResponse(200, { choices: [{ message: { content: JSON.stringify({ answers: [] }) } }] });
  });
  const c = createClient({ fetchFn: f });
  await c.generateAnswers(SNAP, 'sk-fake');
  assert.ok(captured, 'fetch must have been called with a body');
  const systemMsg = captured.messages[0];
  assert.equal(systemMsg.role, 'system');
  const content = systemMsg.content;
  assert.ok(content.indexOf('"type": "text"') !== -1 || content.indexOf('"type":"text"') !== -1,
    'system prompt must contain the {"type":"text",...} answer shape');
  assert.ok(content.indexOf('math_input') !== -1,
    'system prompt must mention math_input by name so the model maps the page type to the shape');
});

test('U15-P2: SYSTEM_PROMPT still contains "json" (DeepSeek JSON-mode requirement)', async () => {
  let captured = null;
  const f = makeFetch(function (url, init) {
    try { captured = JSON.parse(init.body); } catch (_) {}
    return makeResponse(200, { choices: [{ message: { content: JSON.stringify({ answers: [] }) } }] });
  });
  const c = createClient({ fetchFn: f });
  await c.generateAnswers(SNAP, 'sk-fake');
  const systemMsg = captured.messages[0];
  assert.ok(/\bjson\b/i.test(systemMsg.content),
    'system prompt MUST contain the word "json" for DeepSeek JSON mode');
});
```

- [ ] **Step 2: Run the tests and confirm U15-P1 FAILS, U15-P2 PASSES**

Run: `node --test --test-name-pattern="U15-P" tests/deepseek-client.test.js`

Expected:
- `U15-P1` FAILS — current prompt only shows the single_choice schema example; neither `"type":"text"` nor `math_input` appears verbatim in the prompt.
- `U15-P2` PASSES — current prompt already contains `Reply with strict json` and `json_object`.

- [ ] **Step 3: Replace `SYSTEM_PROMPT` in `lib/deepseek-client.js`**

Open `lib/deepseek-client.js`. Find `SYSTEM_PROMPT` at lines 14-20:

```js
var SYSTEM_PROMPT = [
  'You are generating answer suggestions for an ungraded practice form. Reply with strict json only matching the supplied schema. Use only the question_id and option_id values supplied. Do not output HTML, selectors, JavaScript, navigation actions, submit instructions, or markdown.',
  '',
  'For single_choice questions, return exactly one supplied option_id. For multiple_choice questions, return zero or more supplied option_ids only when justified. For text questions, return a concise fill value. If a question cannot be answered confidently from the supplied context, omit it or mark confidence="low".',
  '',
  'Schema example: { "answers": [ { "question_id": "q1", "answer": { "type": "single_choice", "option_ids": ["q1o0"] }, "explanation": "short", "confidence": "high" } ] }'
].join('\n');
```

Replace with:

```js
var SYSTEM_PROMPT = [
  'You are generating answer suggestions for an ungraded practice form. Reply with strict json only matching the supplied schema. Use only the question_id and option_id values supplied. Do not output HTML, selectors, JavaScript, navigation actions, submit instructions, or markdown.',
  '',
  'For single_choice questions, return exactly one supplied option_id. For multiple_choice questions, return zero or more supplied option_ids only when justified. For math_input questions (text or numeric typed answers), return an answer object of shape {"type":"text","value":"<string>"}. Numeric answers MUST be returned as strings (e.g., "0.5", not 0.5). If a question cannot be answered confidently from the supplied context, omit it or mark confidence="low".',
  '',
  'Schema example: { "answers": [ { "question_id": "q1", "answer": { "type": "single_choice", "option_ids": ["q1o0"] }, "explanation": "short", "confidence": "high" }, { "question_id": "q2", "answer": { "type": "text", "value": "the typed or numeric answer as a string" }, "explanation": "short", "confidence": "high" } ] }'
].join('\n');
```

Notes:
- The `"json"` requirement is still satisfied (`Reply with strict json only`).
- The example now demonstrates BOTH shapes the AI will encounter, with the math_input → text mapping spelled out explicitly so the model doesn't drift to `{type:"math_input",value:...}` or `{type:"numerical",value:...}`.
- The validator (Task 1) is tolerant anyway — but a clearer prompt reduces the rate of wrong-type drift.

- [ ] **Step 4: Re-run U15-P tests and confirm 2/2 PASS**

Run: `node --test --test-name-pattern="U15-P" tests/deepseek-client.test.js`

Expected: 2 pass.

- [ ] **Step 5: Run the full deepseek-client test file**

Run: `node --test tests/deepseek-client.test.js`

Expected: every test PASSES.

- [ ] **Step 6: Commit**

```
git add lib/deepseek-client.js tests/deepseek-client.test.js
git commit -m "feat(deepseek-client): add math_input text-answer shape to SYSTEM_PROMPT schema example"
```

---

## Task 3: Full repo regression + verification

**Files:** none modified.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: every test PASSES across every file. Net count change: +9 (7 U15-V + 2 U15-P).

- [ ] **Step 2: Autopilot regression**

Run: `node --test tests/autopilot-state.test.js tests/autopilot-timing.test.js tests/completion-confirmer.test.js tests/item-handlers.test.js tests/module-autopilot.test.js tests/module-scraper.test.js`

Expected: every test PASSES. Autopilot was untouched.

- [ ] **Step 3: Provider-neutrality grep on public UI files**

Run: `grep -nE "DeepSeek|OpenAI|Anthropic|Claude|GPT-" lib/sidebar.js lib/ai-options-controller.js lib/ai-answer-controller.js lib/ai-content-listeners.js lib/ai-open-options-content.js lib/ai-open-options-background.js lib/ai-question-context.js lib/ui-revision.js options.html`

Expected: zero matches. (The DeepSeek system prompt edit lives in `lib/deepseek-client.js`, not a UI file.)

- [ ] **Step 4: Real-key leak scan**

Run: `grep -rE "sk-[A-Za-z0-9_]{16,}" --include="*.js" --include="*.json" --include="*.html" --include="*.md" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=Reference .`

Expected: zero matches.

- [ ] **Step 5: Final commit summary**

Run: `git log --oneline -3`

Expected: the latest two commits are:
1. `feat(deepseek-client): add math_input text-answer shape to SYSTEM_PROMPT schema example`
2. `feat(ai-answer-validator): accept text/math_input/numerical/input + numeric value + ans.text alias`

---

## Task 4: Live Chrome verification (user-driven)

**Files:** none modified.

This task cannot be automated.

- [ ] **Step 1: Reload the extension**

Open `chrome://extensions`, click Reload on Clipboard Cleaner.

- [ ] **Step 2: Navigate to a page with at least one math_input question**

Any practice quiz or assignment-submission URL with a numeric/text input field works.

- [ ] **Step 3: Click Scan questions, then Generate suggestions, then Apply answers**

Expected:
- Scan preview lists the math_input question(s) with `q.type === 'math_input'`.
- Generate suggestions returns at least one suggestion with `mappingStatus === 'matched'` and a `value` field visible in the suggestion preview.
- Apply answers fills the text/number input with the AI's value. The status text reports `Applied N answers; skipped 0.` (or similar).

If Apply still skips a math_input question after the AI returned a value:
- Open DevTools console; look for `[answer-applier] structured-apply filled=X failed=Y` and any per-question failure lines.
- The failure reason is now downstream of this plan (likely a MathQuill / Coursera widget interaction the answer-matcher chain doesn't handle yet). Report the reason back; a follow-up plan can extend the answer-matcher variant chain.

---

## Self-Review Notes

- **Spec coverage:**
  - §2.1 prompt extension → Task 2 Steps 3.
  - §2.2 validator tolerance → Task 1 Step 3.
  - §3.1 deepseek-client test → Task 2 Steps 1-2 (U15-P1, U15-P2).
  - §3.2 validator tests (7 cases) → Task 1 Steps 1-2 (U15-V1 through U15-V7).

- **Placeholder scan:** every step has full code or exact commands with expected output. No `TODO`, `TBD`, or "similar to Task N".

- **Type / symbol consistency:**
  - `TEXT_LIKE_TYPES` defined and used in one place (Task 1 Step 3).
  - `SYSTEM_PROMPT` joined the same way (5-element array → `.join('\n')`); the structural shape matches the existing code.
  - `U15-V` and `U15-P` test name prefixes are distinct and grep-able.

- **Risk surface unchanged from spec:** no applier touch, no question-context touch, no manifest changes, DeepSeek-only (managed-client unaffected since it doesn't exist as a real prompt yet).
