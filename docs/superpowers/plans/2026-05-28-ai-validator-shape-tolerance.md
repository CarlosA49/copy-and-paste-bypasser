# AI Validator Shape Tolerance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the live "Got 0 suggestions" + "The AI service returned an answer format that could not be safely applied" failure by widening `lib/ai-answer-validator.js` to accept the shape variants real models actually emit for `single_choice` and `multiple_choice` (option_id singular, letter, label text, bare string, value-as-letter, comma-separated lists). Preserve the safest path (`option_ids` array) untouched. Add developer-friendly diagnostics in the controller so future failures expose the validator's actual reason in the console + a more specific UI message.

**Architecture:** Two internal helpers added to `lib/ai-answer-validator.js`: `letterToOption(question, letter)` (`"A"` → first option) and `findOptionByText(question, raw)` (letter → option_id → exact label → substring → jaccard, mirroring `lib/answer-applier.js` `pickChoice` minimally without DOM coupling). Single-choice and multiple-choice branches are restructured to try resolution paths in order of safety: `option_ids` (canonical) → `option_id` (singular) → `letter`/`letters` → `value`/`values` (treated as letter/id/label, with `pickChoice`-style fuzzy match). Bare-string `a.answer` is wrapped as `{ value: a.answer }` before resolution. `math_input` is untouched (already tolerant from commit `e3f501c`). The controller emits `console.warn` with the raw response + per-suggestion mapping status whenever validation fails or produces zero applicable suggestions; the UI message includes the validator reason when `ok: false`.

**Tech Stack:** Vanilla JS (MV3 content script), `node:test`, `jsdom`. No build step.

---

## Scope Guard

- **Production files allowed:** `lib/ai-answer-validator.js`, `lib/ai-answer-controller.js`.
- **Test files allowed:** `tests/ai-answer-validator.test.js`, `tests/ai-answer-controller.test.js`.
- **Frozen:** everything else — `lib/deepseek-client.js`, `lib/ai-question-context.js`, `lib/sidebar.js`, `lib/answer-applier.js`, all autopilot files, `manifest.json`, options page.
- The existing `extractStrictJson` and the math_input branch (from commit `e3f501c`) MUST NOT be changed.
- The existing "wrong-type / unknown-question / unknown-option / stale-snapshot / invalid-json / invalid-schema" reason strings remain valid — new resolution paths feed into the existing failure reasons; no new reason strings are introduced (this keeps callers and existing tests stable).

---

## File Structure

| File | Change |
|---|---|
| `lib/ai-answer-validator.js` | Add `letterToOption` + `findOptionByText` helpers (file-local). Restructure `single_choice` and `multiple_choice` branches to try multiple resolution paths. Wrap bare-string `a.answer` as `{ value: ... }` for choice types. Math_input branch untouched. Public API unchanged (`validateAndMap` + `extractStrictJson`). |
| `lib/ai-answer-controller.js` | In `performGenerate`'s response callback, add `console.warn` diagnostics for `val.ok === false` (including `val.reason` + `res.raw`) and for `val.ok === true` with zero applicable suggestions (per-question `mappingStatus`). Include `val.reason` in the apply-result UI message instead of the generic string. |
| `tests/ai-answer-validator.test.js` | Append U17-V tests for each new single_choice and multiple_choice shape variant. |
| `tests/ai-answer-controller.test.js` | Append U17-C tests for the dev-friendly logging + reason-bearing apply-result message. |

---

## Task 1: Tolerant single_choice resolution

**Files:**
- Test (append): `tests/ai-answer-validator.test.js`
- Modify: `lib/ai-answer-validator.js` (single_choice branch + introduce `letterToOption` + `findOptionByText` helpers)

### Resolution order (single_choice)

For each AI answer mapped to a `single_choice` question:

1. If `a.answer` is a bare string, treat it as `{ value: a.answer }`.
2. Try in this order; first success wins:
   - `ans.option_ids` (array, length 1) → use `ans.option_ids[0]` as option_id.
   - `ans.option_id` (string) → use directly.
   - `ans.letter` (string `"A"`..`"Z"`, case-insensitive) → `letterToOption(q, letter)` → option_id.
   - `ans.value` (string) → `findOptionByText(q, value)` → option_id.
3. If no resolution path produced an option_id, push `wrong-type` and reject.
4. If the resolved option_id doesn't exist in `q.options`, push `unknown-option` and reject.
5. Otherwise push `matched` with `choiceText: <label>`.

### Helpers

```js
function letterToOption(q, raw) {
  if (!q || !Array.isArray(q.options) || q.options.length === 0) return null;
  if (typeof raw !== 'string') return null;
  var s = raw.trim();
  if (!/^[A-Za-z]$/.test(s)) return null;
  var idx = s.toUpperCase().charCodeAt(0) - 65;
  if (idx < 0 || idx >= q.options.length) return null;
  return q.options[idx];
}

function findOptionByText(q, raw) {
  if (!q || !Array.isArray(q.options) || q.options.length === 0) return null;
  if (typeof raw !== 'string') return null;
  var s = raw.trim();
  if (!s) return null;
  // Letter shortcut.
  if (/^[A-Za-z]$/.test(s)) {
    var byLetter = letterToOption(q, s);
    if (byLetter) return byLetter;
  }
  // Direct option_id match.
  for (var i = 0; i < q.options.length; i++) {
    if (q.options[i].id === s) return q.options[i];
  }
  // Normalized label match (exact, then substring, then jaccard threshold 0.34).
  function norm(t) { return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  var n = norm(s);
  for (var j = 0; j < q.options.length; j++) {
    if (norm(q.options[j].label) === n) return q.options[j];
  }
  for (var k = 0; k < q.options.length; k++) {
    var L = norm(q.options[k].label);
    if (L && (L.indexOf(n) !== -1 || n.indexOf(L) !== -1)) return q.options[k];
  }
  function tokens(t) { return norm(t).split(' ').filter(function (x) { return x.length > 1; }); }
  function jaccard(a, b) {
    if (!a.length || !b.length) return 0;
    var A = {}, B = {}, inter = 0, uA = 0, uB = 0;
    a.forEach(function (t) { if (!A[t]) { A[t] = 1; uA++; } });
    b.forEach(function (t) { if (!B[t]) { B[t] = 1; uB++; if (A[t]) inter++; } });
    return inter / (uA + uB - inter);
  }
  var best = null, bestScore = 0;
  for (var m = 0; m < q.options.length; m++) {
    var sc = jaccard(tokens(s), tokens(q.options[m].label));
    if (sc > bestScore) { bestScore = sc; best = q.options[m]; }
  }
  return (best && bestScore >= 0.34) ? best : null;
}
```

These helpers go above `validateAndMap` inside the IIFE (alongside the existing `findQuestion` / `findOptionLabel`).

- [ ] **Step 1: Append U17-V single_choice tests to `tests/ai-answer-validator.test.js`**

The file's `SNAP` fixture has `q1` of type `single_choice` with options `q1o0`→Alpha and `q1o1`→Beta. Append at end of file:

```js
// === U17: tolerant single_choice resolution paths ===

test('U17-V1: single_choice with option_ids array (canonical) still works', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: { type: 'single_choice', option_ids: ['q1o0'] } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].mappingStatus, 'matched');
  assert.equal(out.suggestions[0].choiceText, 'Alpha');
});

test('U17-V2: single_choice with option_id singular string is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: { type: 'single_choice', option_id: 'q1o1' } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].choiceText, 'Beta');
});

test('U17-V3: single_choice with letter "A" is accepted (case-insensitive)', () => {
  const out = v.validateAndMap({
    answers: [
      { question_id: 'q1', answer: { type: 'single_choice', letter: 'A' } },
      { question_id: 'q1', answer: { type: 'single_choice', letter: 'b' } },
    ]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].choiceText, 'Alpha');
  assert.equal(out.suggestions[1].applicable, true);
  assert.equal(out.suggestions[1].choiceText, 'Beta');
});

test('U17-V4: single_choice with value as a single letter is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: { type: 'single_choice', value: 'B' } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].choiceText, 'Beta');
});

test('U17-V5: single_choice with value as the exact option label is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: { type: 'single_choice', value: 'Alpha' } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].choiceText, 'Alpha');
});

test('U17-V6: single_choice with value matching label case-insensitively is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: { type: 'single_choice', value: 'BETA' } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].choiceText, 'Beta');
});

test('U17-V7: single_choice with bare-string a.answer "A" is accepted as letter', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: 'A' }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].choiceText, 'Alpha');
});

test('U17-V8: single_choice with bare-string a.answer matching label is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: 'Beta' }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].choiceText, 'Beta');
});

test('U17-V9: single_choice with value as the option_id is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: { type: 'single_choice', value: 'q1o0' } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].choiceText, 'Alpha');
});

test('U17-V10: single_choice with unresolvable value is rejected as wrong-type', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: { type: 'single_choice', value: 'totally unrelated' } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, false);
  assert.equal(out.suggestions[0].mappingStatus, 'wrong-type');
});

test('U17-V11: single_choice with option_ids referring to an unknown id is rejected as unknown-option', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q1', answer: { type: 'single_choice', option_ids: ['q1o999'] } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, false);
  assert.equal(out.suggestions[0].mappingStatus, 'unknown-option');
});
```

- [ ] **Step 2: Run U17-V single_choice tests and confirm fails**

Run: `node --test --test-name-pattern="U17-V[0-9]+: single_choice" tests/ai-answer-validator.test.js`

Expected: U17-V1 PASSES (canonical), U17-V11 PASSES (unknown-option still works), the rest FAIL. Capture verbatim.

- [ ] **Step 3: Add helpers + restructure single_choice branch in `lib/ai-answer-validator.js`**

Open `lib/ai-answer-validator.js`. Above the existing `function findQuestion(snap, qid)` (around line 17), insert:

```js
  function letterToOption(q, raw) {
    if (!q || !Array.isArray(q.options) || q.options.length === 0) return null;
    if (typeof raw !== 'string') return null;
    var s = raw.trim();
    if (!/^[A-Za-z]$/.test(s)) return null;
    var idx = s.toUpperCase().charCodeAt(0) - 65;
    if (idx < 0 || idx >= q.options.length) return null;
    return q.options[idx];
  }

  function findOptionByText(q, raw) {
    if (!q || !Array.isArray(q.options) || q.options.length === 0) return null;
    if (typeof raw !== 'string') return null;
    var s = raw.trim();
    if (!s) return null;
    if (/^[A-Za-z]$/.test(s)) {
      var byLetter = letterToOption(q, s);
      if (byLetter) return byLetter;
    }
    for (var i = 0; i < q.options.length; i++) {
      if (q.options[i].id === s) return q.options[i];
    }
    function norm(t) { return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
    var n = norm(s);
    for (var j = 0; j < q.options.length; j++) {
      if (norm(q.options[j].label) === n) return q.options[j];
    }
    for (var k = 0; k < q.options.length; k++) {
      var L = norm(q.options[k].label);
      if (L && (L.indexOf(n) !== -1 || n.indexOf(L) !== -1)) return q.options[k];
    }
    function tokens(t) { return norm(t).split(' ').filter(function (x) { return x.length > 1; }); }
    function jaccard(a, b) {
      if (!a.length || !b.length) return 0;
      var A = {}, B = {}, inter = 0, uA = 0, uB = 0;
      a.forEach(function (t) { if (!A[t]) { A[t] = 1; uA++; } });
      b.forEach(function (t) { if (!B[t]) { B[t] = 1; uB++; if (A[t]) inter++; } });
      return inter / (uA + uB - inter);
    }
    var best = null, bestScore = 0;
    for (var m = 0; m < q.options.length; m++) {
      var sc = jaccard(tokens(s), tokens(q.options[m].label));
      if (sc > bestScore) { bestScore = sc; best = q.options[m]; }
    }
    return (best && bestScore >= 0.34) ? best : null;
  }
```

Then find the single_choice branch (around lines 67-75) and replace:

```js
if (q.type === 'single_choice') {
  if (ans.type !== 'single_choice' || !Array.isArray(ans.option_ids) || ans.option_ids.length !== 1) {
    suggestions.push(Object.assign(base, { mappingStatus: 'wrong-type', applicable: false })); rejected++; continue;
  }
  var lbl = findOptionLabel(q, ans.option_ids[0]);
  if (lbl == null) {
    suggestions.push(Object.assign(base, { mappingStatus: 'unknown-option', applicable: false })); rejected++; continue;
  }
  suggestions.push(Object.assign(base, { choiceText: lbl, mappingStatus: 'matched', applicable: true }));
}
```

with:

```js
if (q.type === 'single_choice') {
  // Wrap bare-string a.answer as { value: <string> } for uniform handling.
  var rawAns = (typeof a.answer === 'string') ? { value: a.answer } : (a.answer || {});
  // Resolution paths, safest first. First success wins.
  var resolvedId = null;
  var resolutionExhausted = false;
  if (Array.isArray(rawAns.option_ids) && rawAns.option_ids.length === 1 && typeof rawAns.option_ids[0] === 'string') {
    resolvedId = rawAns.option_ids[0];
  } else if (typeof rawAns.option_id === 'string') {
    resolvedId = rawAns.option_id;
  } else if (typeof rawAns.letter === 'string') {
    var letterOpt = letterToOption(q, rawAns.letter);
    if (letterOpt) resolvedId = letterOpt.id; else resolutionExhausted = true;
  } else if (typeof rawAns.value === 'string') {
    var textOpt = findOptionByText(q, rawAns.value);
    if (textOpt) resolvedId = textOpt.id; else resolutionExhausted = true;
  }
  if (!resolvedId) {
    // wrong-type covers: no recognizable field, or letter/value couldn't resolve to an option.
    suggestions.push(Object.assign(base, { mappingStatus: 'wrong-type', applicable: false })); rejected++; continue;
  }
  var lbl = findOptionLabel(q, resolvedId);
  if (lbl == null) {
    suggestions.push(Object.assign(base, { mappingStatus: 'unknown-option', applicable: false })); rejected++; continue;
  }
  suggestions.push(Object.assign(base, { choiceText: lbl, mappingStatus: 'matched', applicable: true }));
}
```

Note: `resolutionExhausted` is currently a dead-write placeholder for future granularity (e.g., distinguishing "letter not in range" vs "letter not provided"). It's local-only and doesn't change the return — keep it commented as a marker but inert. If the reviewer prefers, remove the variable entirely; either is fine.

Actually — remove the dead variable. Final replacement:

```js
if (q.type === 'single_choice') {
  // Wrap bare-string a.answer as { value: <string> } for uniform handling.
  var rawAns = (typeof a.answer === 'string') ? { value: a.answer } : (a.answer || {});
  // Resolution paths, safest first. First success wins.
  var resolvedId = null;
  if (Array.isArray(rawAns.option_ids) && rawAns.option_ids.length === 1 && typeof rawAns.option_ids[0] === 'string') {
    resolvedId = rawAns.option_ids[0];
  } else if (typeof rawAns.option_id === 'string') {
    resolvedId = rawAns.option_id;
  } else if (typeof rawAns.letter === 'string') {
    var letterOpt = letterToOption(q, rawAns.letter);
    if (letterOpt) resolvedId = letterOpt.id;
  } else if (typeof rawAns.value === 'string') {
    var textOpt = findOptionByText(q, rawAns.value);
    if (textOpt) resolvedId = textOpt.id;
  }
  if (!resolvedId) {
    suggestions.push(Object.assign(base, { mappingStatus: 'wrong-type', applicable: false })); rejected++; continue;
  }
  var lbl = findOptionLabel(q, resolvedId);
  if (lbl == null) {
    suggestions.push(Object.assign(base, { mappingStatus: 'unknown-option', applicable: false })); rejected++; continue;
  }
  suggestions.push(Object.assign(base, { choiceText: lbl, mappingStatus: 'matched', applicable: true }));
}
```

The outer `var ans = a.answer || {};` at line ~49 stays — multiple_choice (still untouched in this task) reads it. The new code uses `rawAns` locally.

- [ ] **Step 4: Run all single_choice U17-V tests — confirm 11/11 PASS**

Run: `node --test --test-name-pattern="U17-V[0-9]+: single_choice" tests/ai-answer-validator.test.js`

Expected: 11 pass.

- [ ] **Step 5: Run the full validator test file — confirm pre-existing tests stay green**

Run: `node --test tests/ai-answer-validator.test.js`

Expected: every test PASSES, including the pre-existing `'valid response maps cleanly'`, `'wrong-type (text answer for radio question) is rejected'`, `'model cannot smuggle a DOM selector or submit action'`, and the U15-V math_input tests.

Note: the pre-existing `'wrong-type (text answer for radio question) is rejected'` test sends `{type: 'text', value: 'hello'}` against `q1` (single_choice). After this change, the new code reaches the `value` branch, calls `findOptionByText(q1, 'hello')` which returns null (no letter, no id match, no label match for q1's options Alpha/Beta), so `resolvedId` stays null and the suggestion becomes `wrong-type`. The existing assertion still holds.

- [ ] **Step 6: Commit**

```
git add lib/ai-answer-validator.js tests/ai-answer-validator.test.js
git commit -m "feat(ai-answer-validator): tolerant single_choice resolution (option_id/letter/value/bare string)"
```

---

## Task 2: Tolerant multiple_choice resolution

**Files:**
- Test (append): `tests/ai-answer-validator.test.js`
- Modify: `lib/ai-answer-validator.js` (multiple_choice branch)

### Resolution order (multiple_choice)

For each AI answer mapped to a `multiple_choice` question:

1. If `a.answer` is a bare string, treat it as `{ value: a.answer }`.
2. Collect resolved option_ids from the FIRST present source:
   - `ans.option_ids` (array of strings) — use directly.
   - `ans.letters` (array of letter strings) — map each via `letterToOption`.
   - `ans.values` (array of strings) — map each via `findOptionByText`.
   - `ans.value` (string with `,` / `and` / brackets) — split, then map each via `findOptionByText`.
3. De-duplicate. Look up each label via `findOptionLabel`.
4. If zero labels resolved, push `wrong-type` (or `unknown-option` if at least one id was attempted but missing).
5. If at least one label resolved, push `matched` with `choiceTexts: <labels[]>`.

### Helper (file-local)

```js
function splitMultipleAnswerString(s) {
  if (typeof s !== 'string') return [];
  return s.replace(/[\[\]]/g, '').replace(/\band\b/gi, ',').split(',')
    .map(function (p) { return p.trim(); })
    .filter(Boolean);
}
```

Place this immediately after `findOptionByText` (Task 1).

- [ ] **Step 1: Append U17-V multiple_choice tests**

`SNAP.q2` is multiple_choice with options `q2o0`→A, `q2o1`→B, `q2o2`→C. Append:

```js
// === U17: tolerant multiple_choice resolution paths ===

test('U17-V12: multiple_choice with option_ids array (canonical) still works', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q2', answer: { type: 'multiple_choice', option_ids: ['q2o0', 'q2o2'] } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.equal(out.suggestions[0].mappingStatus, 'matched');
  assert.deepEqual(out.suggestions[0].choiceTexts, ['A', 'C']);
});

test('U17-V13: multiple_choice with letters array is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q2', answer: { type: 'multiple_choice', letters: ['A', 'C'] } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.deepEqual(out.suggestions[0].choiceTexts, ['A', 'C']);
});

test('U17-V14: multiple_choice with values array of labels is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q2', answer: { type: 'multiple_choice', values: ['A', 'B'] } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.deepEqual(out.suggestions[0].choiceTexts, ['A', 'B']);
});

test('U17-V15: multiple_choice with comma-separated value string is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q2', answer: { type: 'multiple_choice', value: 'A, C' } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.deepEqual(out.suggestions[0].choiceTexts, ['A', 'C']);
});

test('U17-V16: multiple_choice with "A and B" connector value is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q2', answer: { type: 'multiple_choice', value: 'A and B' } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.deepEqual(out.suggestions[0].choiceTexts, ['A', 'B']);
});

test('U17-V17: multiple_choice with bracketed value "[A, C]" is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q2', answer: { type: 'multiple_choice', value: '[A, C]' } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.deepEqual(out.suggestions[0].choiceTexts, ['A', 'C']);
});

test('U17-V18: multiple_choice with bare-string a.answer "A, C" is accepted', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q2', answer: 'A, C' }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.deepEqual(out.suggestions[0].choiceTexts, ['A', 'C']);
});

test('U17-V19: multiple_choice with one resolvable and one unresolvable letter keeps the resolvable one', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q2', answer: { type: 'multiple_choice', letters: ['A', 'Z'] } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.deepEqual(out.suggestions[0].choiceTexts, ['A']);
});

test('U17-V20: multiple_choice with zero resolvable letters is rejected as wrong-type', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q2', answer: { type: 'multiple_choice', letters: ['Z', 'Y'] } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, false);
  assert.equal(out.suggestions[0].mappingStatus, 'wrong-type');
});

test('U17-V21: multiple_choice with option_ids array referring only to unknown ids is rejected as unknown-option', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q2', answer: { type: 'multiple_choice', option_ids: ['q2o999'] } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, false);
  assert.equal(out.suggestions[0].mappingStatus, 'unknown-option');
});

test('U17-V22: multiple_choice with duplicate letters de-duplicates in the output', () => {
  const out = v.validateAndMap({
    answers: [{ question_id: 'q2', answer: { type: 'multiple_choice', letters: ['A', 'A', 'C'] } }]
  }, SNAP);
  assert.equal(out.suggestions[0].applicable, true);
  assert.deepEqual(out.suggestions[0].choiceTexts, ['A', 'C']);
});
```

- [ ] **Step 2: Run U17-V multiple_choice tests — confirm most FAIL**

Run: `node --test --test-name-pattern="U17-V[12][0-9]+: multiple_choice" tests/ai-answer-validator.test.js`

Expected: U17-V12 PASSES (canonical), U17-V21 may pass (existing unknown-option path), the rest FAIL.

- [ ] **Step 3: Add `splitMultipleAnswerString` helper and restructure multiple_choice branch**

In `lib/ai-answer-validator.js`, immediately after `findOptionByText` (added in Task 1), insert:

```js
  function splitMultipleAnswerString(s) {
    if (typeof s !== 'string') return [];
    return s.replace(/[\[\]]/g, '').replace(/\band\b/gi, ',').split(',')
      .map(function (p) { return p.trim(); })
      .filter(Boolean);
  }
```

Then find the multiple_choice branch (around lines 76-93) and replace:

```js
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
}
```

with:

```js
} else if (q.type === 'multiple_choice') {
  // Wrap bare-string a.answer as { value: <string> } for uniform handling.
  var rawAnsM = (typeof a.answer === 'string') ? { value: a.answer } : (a.answer || {});
  // Collect candidate ids from the first present source.
  var idCandidates = [];
  var sawIdArray = false;
  if (Array.isArray(rawAnsM.option_ids)) {
    sawIdArray = true;
    for (var ai = 0; ai < rawAnsM.option_ids.length; ai++) {
      if (typeof rawAnsM.option_ids[ai] === 'string') idCandidates.push(rawAnsM.option_ids[ai]);
    }
  } else if (Array.isArray(rawAnsM.letters)) {
    for (var bi = 0; bi < rawAnsM.letters.length; bi++) {
      var lOpt = letterToOption(q, rawAnsM.letters[bi]);
      if (lOpt) idCandidates.push(lOpt.id);
    }
  } else if (Array.isArray(rawAnsM.values)) {
    for (var ci = 0; ci < rawAnsM.values.length; ci++) {
      var vOpt = findOptionByText(q, rawAnsM.values[ci]);
      if (vOpt) idCandidates.push(vOpt.id);
    }
  } else if (typeof rawAnsM.value === 'string') {
    var parts = splitMultipleAnswerString(rawAnsM.value);
    for (var di = 0; di < parts.length; di++) {
      var pOpt = findOptionByText(q, parts[di]);
      if (pOpt) idCandidates.push(pOpt.id);
    }
  }
  // De-duplicate idCandidates while preserving order.
  var seenIds = {};
  var uniqueIds = [];
  for (var ei = 0; ei < idCandidates.length; ei++) {
    if (!seenIds[idCandidates[ei]]) {
      seenIds[idCandidates[ei]] = 1;
      uniqueIds.push(idCandidates[ei]);
    }
  }
  // Resolve labels.
  var mcLabels = [];
  var sawUnknown = false;
  for (var fi = 0; fi < uniqueIds.length; fi++) {
    var mcLabel = findOptionLabel(q, uniqueIds[fi]);
    if (mcLabel == null) { sawUnknown = true; continue; }
    mcLabels.push(mcLabel);
  }
  if (mcLabels.length === 0) {
    // If we tried option_ids and ALL were unknown, surface unknown-option (preserves existing semantic).
    // Otherwise (no source matched or letters/values produced 0), it's wrong-type.
    if (sawIdArray && sawUnknown && uniqueIds.length > 0) {
      suggestions.push(Object.assign(base, { mappingStatus: 'unknown-option', applicable: false })); rejected++; continue;
    }
    suggestions.push(Object.assign(base, { mappingStatus: 'wrong-type', applicable: false })); rejected++; continue;
  }
  suggestions.push(Object.assign(base, { choiceTexts: mcLabels, mappingStatus: 'matched', applicable: true }));
}
```

The outer `var ans = a.answer || {}` (line ~49) remains. The branch uses local `rawAnsM`.

- [ ] **Step 4: Re-run U17-V multiple_choice tests — confirm 11/11 PASS**

Run: `node --test --test-name-pattern="U17-V[12][0-9]+: multiple_choice" tests/ai-answer-validator.test.js`

Expected: 11 pass (V12..V22).

- [ ] **Step 5: Run the full validator test file — confirm pre-existing tests stay green**

Run: `node --test tests/ai-answer-validator.test.js`

Expected: every test PASSES, including the pre-existing `'valid response maps cleanly'` (which sends `option_ids: ['q2o0', 'q2o2']` for q2 → still matched as before) and all Task 1 single_choice tests.

- [ ] **Step 6: Commit**

```
git add lib/ai-answer-validator.js tests/ai-answer-validator.test.js
git commit -m "feat(ai-answer-validator): tolerant multiple_choice resolution (option_ids/letters/values/comma string)"
```

---

## Task 3: Developer-friendly diagnostics in the controller

**Files:**
- Test (append): `tests/ai-answer-controller.test.js`
- Modify: `lib/ai-answer-controller.js` (`performGenerate`'s response callback)

### Behavior

After `validator.validateAndMap(...)`:

1. **If `val.ok === false`:** `console.warn` with the validator reason + the raw response. Set the apply-result message to include the reason (e.g., `'AI returned an unrecognized format (reason: invalid-schema). See console for details.'`) instead of the generic string.

2. **If `val.ok === true` but ALL suggestions have `applicable: false`:** `console.warn` with the per-suggestion `{questionNumber, mappingStatus}` array. Set the apply-result message to: `'AI returned N suggestion(s) but none were applicable (see console for details).'`

3. **If at least one suggestion is applicable:** keep existing behavior. Optionally also log non-applicable ones at `console.info` level, but this is not required for the tests.

- [ ] **Step 1: Append U17-C controller tests**

Open `tests/ai-answer-controller.test.js`. The file already has `createAiController`, `makeBlockedPageFakeSidebar` (a misleading name — it's just a fake sidebar), and stub patterns. Append at end of file:

```js
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
```

- [ ] **Step 2: Run U17-C tests — confirm fails**

Run: `node --test --test-name-pattern="U17-C" tests/ai-answer-controller.test.js`

Expected: U17-C1 FAILS (current message doesn't include "invalid-schema"). U17-C2 FAILS (current code goes into the happy `_activeSuggestions = val.suggestions; setAiSuggestions` path with no console.warn and no special apply-result message when suggestions are non-applicable). U17-C3 should already pass (no warning on happy path is already the case).

- [ ] **Step 3: Update `performGenerate`'s response callback in `lib/ai-answer-controller.js`**

Find the `send('generateAnswers', ...)` callback (around lines 68-84):

```js
send('generateAnswers', { snapshot: sanitized }, function (res) {
  sidebar.setAiInFlight(false);
  if (!res || !res.ok) {
    var msg = (res && res.reason) ? aiServiceErrorMessage(res.reason) : 'AI request failed.';
    sidebar.setAiSuggestions([]);
    if (sidebar.setAiApplyResult) sidebar.setAiApplyResult({ filled: 0, failed: 0, message: msg });
    return;
  }
  var val = validator.validateAndMap(res.raw, _activeSnapshot, { expectedToken: _activeSnapshot.token });
  if (!val.ok) {
    sidebar.setAiSuggestions([]);
    sidebar.setAiApplyResult({ filled: 0, failed: 0, message: 'The AI service returned an answer format that could not be safely applied.' });
    return;
  }
  _activeSuggestions = val.suggestions;
  sidebar.setAiSuggestions(val.suggestions);
});
```

Replace with:

```js
send('generateAnswers', { snapshot: sanitized }, function (res) {
  sidebar.setAiInFlight(false);
  if (!res || !res.ok) {
    var msg = (res && res.reason) ? aiServiceErrorMessage(res.reason) : 'AI request failed.';
    sidebar.setAiSuggestions([]);
    if (sidebar.setAiApplyResult) sidebar.setAiApplyResult({ filled: 0, failed: 0, message: msg });
    return;
  }
  var val = validator.validateAndMap(res.raw, _activeSnapshot, { expectedToken: _activeSnapshot.token });
  if (!val.ok) {
    try { console.warn('[ai-answer-controller] validator rejected:', val.reason, 'raw:', res && res.raw); } catch (_) {}
    sidebar.setAiSuggestions([]);
    sidebar.setAiApplyResult({ filled: 0, failed: 0,
      message: 'AI returned an unrecognized format (reason: ' + val.reason + '). See console for details.' });
    return;
  }
  // Diagnostics: surface per-suggestion mapping status when none are applicable.
  var applicableCount = 0;
  var statuses = [];
  for (var si = 0; si < val.suggestions.length; si++) {
    var s = val.suggestions[si];
    if (s.applicable) applicableCount++;
    statuses.push({ question: s.questionNumber, status: s.mappingStatus });
  }
  if (applicableCount === 0 && val.suggestions.length > 0) {
    try { console.warn('[ai-answer-controller] 0 applicable suggestions; per-question statuses:', statuses); } catch (_) {}
    sidebar.setAiApplyResult({ filled: 0, failed: 0,
      message: 'AI returned ' + val.suggestions.length + ' suggestion(s) but none were applicable (see console for details).' });
  }
  _activeSuggestions = val.suggestions;
  sidebar.setAiSuggestions(val.suggestions);
});
```

Notes:
- `try/catch` around `console.warn` keeps the controller safe if a future test stubs console.
- The "no applicable" branch sets `applyResult` BEFORE `setAiSuggestions` so the suggestion list (still empty of applicables) renders alongside the explanatory message.
- The happy path is unchanged: when at least one suggestion is applicable, no message is set and `setAiSuggestions(val.suggestions)` runs as before.

- [ ] **Step 4: Re-run U17-C tests — confirm 3/3 PASS**

Run: `node --test --test-name-pattern="U17-C" tests/ai-answer-controller.test.js`

Expected: 3 pass.

- [ ] **Step 5: Run the full controller test file — confirm no regression**

Run: `node --test tests/ai-answer-controller.test.js`

Expected: every test PASSES, including the U11-1 integration tests, S7 variants, and U14-B6.

- [ ] **Step 6: Commit**

```
git add lib/ai-answer-controller.js tests/ai-answer-controller.test.js
git commit -m "feat(ai-answer-controller): surface validator reason + per-suggestion mapping status in console + apply-result"
```

---

## Task 4: Full repo regression + verification

**Files:** none modified.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: every test PASSES. Net count change: +25 (11 single_choice + 11 multiple_choice + 3 controller diagnostics).

- [ ] **Step 2: Autopilot regression**

Run: `node --test tests/autopilot-state.test.js tests/autopilot-timing.test.js tests/completion-confirmer.test.js tests/item-handlers.test.js tests/module-autopilot.test.js tests/module-scraper.test.js`

Expected: every test PASSES.

- [ ] **Step 3: Provider-neutrality grep on public UI files**

Run: `grep -nE "DeepSeek|OpenAI|Anthropic|Claude|GPT-" lib/sidebar.js lib/ai-options-controller.js lib/ai-answer-controller.js lib/ai-content-listeners.js lib/ai-open-options-content.js lib/ai-open-options-background.js lib/ai-question-context.js lib/ai-answer-validator.js lib/ui-revision.js options.html`

Expected: zero matches.

- [ ] **Step 4: Real-key leak scan**

Run: `grep -rE "sk-[A-Za-z0-9_]{16,}" --include="*.js" --include="*.json" --include="*.html" --include="*.md" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=Reference .`

Expected: zero matches.

- [ ] **Step 5: Final commit summary**

Run: `git log --oneline -5`

Expected the three new commits are visible:
1. `feat(ai-answer-controller): surface validator reason + per-suggestion mapping status in console + apply-result`
2. `feat(ai-answer-validator): tolerant multiple_choice resolution (option_ids/letters/values/comma string)`
3. `feat(ai-answer-validator): tolerant single_choice resolution (option_id/letter/value/bare string)`

---

## Task 5: Live Chrome verification (user-driven)

**Files:** none modified.

- [ ] **Step 1: Reload the extension at `chrome://extensions`**

- [ ] **Step 2: Navigate to a Coursera quiz with single_choice and/or multiple_choice questions**

- [ ] **Step 3: Click Scan → Generate suggestions → Apply**

Expected:
- Suggestion preview shows "Got N suggestions." with N ≥ 1.
- Each suggestion shows `mappingStatus === 'matched'` and a `choiceText` (for single) or `choiceTexts` (for multiple).
- Apply fills the radio/checkbox(es) for matched suggestions.

If Generate still fails:
- Open DevTools Console. Look for `[ai-answer-controller] validator rejected: <reason> raw: <response>` or `[ai-answer-controller] 0 applicable suggestions; per-question statuses: [...]`.
- The reason / per-question statuses tell you exactly which shape the model used and which validator path failed. Report the console output back; a follow-up plan can extend the validator's accepted shapes.

---

## Self-Review Notes

- **Spec coverage:**
  - User req 1 ("Preserve the safest path"): Task 1 Step 3 — `option_ids` (array, length 1) is the first resolution branch, unchanged from current behavior. U17-V1 / U17-V12 verify.
  - User req 2 (single_choice variants): Task 1 — U17-V2..U17-V9 cover `option_id`, `letter`, `value` as letter/label/id, and bare-string `a.answer`.
  - User req 3 (multiple_choice variants): Task 2 — U17-V13..U17-V18 cover letters/values/comma string/bracketed string/bare string. U17-V19/V22 cover edge cases (partial-resolve + de-dup).
  - User req 4 (math_input still works): math_input branch untouched; existing U15-V tests assert it.
  - User req 5 (surface validator reason): Task 3 — apply-result message embeds `val.reason`; console.warn includes raw response. U17-C1/C2 verify.
  - User req 6 (regression tests): Tasks 1, 2, 3 add 25 regression tests, including the exact failure modes the user reported.
  - User req 7 (run npm test): Task 4 Step 1.

- **Placeholder scan:** every step has full code or exact commands with expected output. The Task 1 Step 3 dead-variable mention is followed by the corrected final replacement code that drops the variable; the engineer uses the final form.

- **Type / symbol consistency:**
  - `letterToOption(q, letter)` — defined Task 1 Step 3, used in Task 1 single_choice + Task 2 multiple_choice.
  - `findOptionByText(q, raw)` — defined Task 1 Step 3, used in Task 1 + Task 2.
  - `splitMultipleAnswerString(s)` — defined Task 2 Step 3, used only in Task 2 multiple_choice.
  - `mappingStatus` values: `'matched'`, `'wrong-type'`, `'unknown-option'`, `'unknown-question'`, `'unsupported'`, `'missing-answer'` — all pre-existing; no new values introduced.
  - U17-V (validator), U17-C (controller) — distinct grep-able prefixes.

- **Scope guard:** two production files, two test files. Math_input untouched. No changes to sidebar, controller wiring, manifest, deepseek-client, question-context.
