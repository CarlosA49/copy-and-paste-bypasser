# AI Apply — Fix text/math input not being filled — Design

**Status:** approved (per user confirmation 2026-05-28)
**Date:** 2026-05-28
**Scope:** AI answer pipeline only — schema instruction to the AI + validator robustness for text/math answers.
**Out of scope:** Autopilot, answer-applier internals, question-detector, sidebar UI, controller, options page, background service worker, manifest permissions, commercial backend, provider routing.

---

## 1. Background

On a graded/blocked assessment page (post the 2026-05-28 re-enable plan), AI Scan/Generate/Apply now work for `single_choice` and `multiple_choice` questions but Apply does NOT fill `math_input` questions (typed text or math). Investigation shows every infrastructure layer already supports `math_input`:

| Layer | math_input handling | Status |
|---|---|---|
| `lib/question-detector.js:143` | emits `type: 'math_input'` for any visible editable input/textarea/contenteditable | ✓ |
| `lib/ai-question-context.js:11,168` | `SUPPORTED_TYPES` includes `math_input`; snapshot exposes `answerFormatHint: 'number-or-text'` | ✓ |
| `lib/answer-applier.js:292-309` | `applyStructuredAnswers` handles `math_input`/`numerical`/`input` via `mathNormalize.normalizeMathAnswer` + `answerMatcher.applyTextMatches` (the same code path the autopilot "answer for you" system uses) | ✓ |
| `lib/ai-answer-controller.js` `performApply` | forwards `{ questionNumber, type, value }` to `applyStructuredAnswers` | ✓ |
| `lib/ai-answer-validator.js:94-98` | **REQUIRES `ans.type === 'text'` AND `typeof ans.value === 'string'` AND `ans.value.trim() !== ''`** — anything else → `mappingStatus: 'wrong-type'`, `applicable: false` | **strict** |
| `lib/deepseek-client.js:14-20` `SYSTEM_PROMPT` | only shows a `single_choice` schema example; for text questions says vaguely "return a concise fill value" with NO shape example | **vague** |

The two strict/vague layers compound: the AI is left to guess the answer shape (`{type:'math_input',value:...}`, `{type:'numerical',value:...}`, `{type:'input',text:...}`, bare string, number type for numeric answers, etc.); the validator then accepts only one of those guesses (`{type:'text',value:'<string>'}`). Mis-shaped answers are silently dropped via `applicable: false` and the Apply button skips them.

---

## 2. Fix

Two production files change. No new files. No changes to the applier or any other layer.

### 2.1 `lib/deepseek-client.js` — extend `SYSTEM_PROMPT` schema example

Add a second example showing the text/math answer shape so the AI consistently produces it. The current `SYSTEM_PROMPT` joins 5 lines via `\n`. Replace the final "Schema example" line so it presents **two** examples (single_choice + math_input). Final form:

```js
'Schema example: { "answers": [ { "question_id": "q1", "answer": { "type": "single_choice", "option_ids": ["q1o0"] }, "explanation": "short", "confidence": "high" }, { "question_id": "q2", "answer": { "type": "text", "value": "the typed or numeric answer as a string" }, "explanation": "short", "confidence": "high" } ] }'
```

Also tighten the existing "For text questions" sentence to spell out the shape:

```
For math_input questions (text or numeric typed answers), return an answer object of shape {"type":"text","value":"<string>"}. Numeric answers MUST be returned as strings (e.g., "0.5", not 0.5).
```

That line replaces the existing `For single_choice questions, ... For text questions, return a concise fill value. If a question cannot be answered confidently...` paragraph — but only the "For text questions" half. Keep the single_choice and multiple_choice halves verbatim.

The string `"json"` MUST remain somewhere in the system prompt (DeepSeek JSON-mode requirement) — it already appears in `Reply with strict json only` and the schema example.

### 2.2 `lib/ai-answer-validator.js` — accept tolerant type tokens + numeric value coercion

Replace the `q.type === 'math_input'` branch (currently `lib/ai-answer-validator.js:94-98`) with a permissive validator:

- Accept `ans.type ∈ {'text', 'math_input', 'numerical', 'input'}` — synonyms for "typed answer".
- Accept `ans.value` as either a string or a finite number (coerce numbers to string via `String(ans.value)`).
- Also accept `ans.value` from the alternate field name `ans.text` (some models emit `text` instead of `value` despite the example).
- Trim the resulting string. Reject only if the trimmed string is empty.

Updated branch:

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
}
```

The trimmed string is then forwarded by the controller as `item.value` to `applyStructuredAnswers`, where `mathNormalize.normalizeMathAnswer` and `answerMatcher.applyTextMatches` handle the actual DOM fill — the same code path the autopilot's "answer for you" system uses.

The existing `single_choice` and `multiple_choice` branches are unchanged. The existing `else` branch (unsupported types) is unchanged.

---

## 3. Test changes

### 3.1 `tests/deepseek-client.test.js`

Add one test asserting `SYSTEM_PROMPT` contains the new math_input shape example. Easiest implementation: a stub fetch captures the request body and the test asserts `body.messages[0].content` contains `'"type": "text"'` and the string `math_input`.

### 3.2 `tests/ai-answer-validator.test.js`

Add four tests asserting tolerant typed-answer mapping for a `math_input` question:
1. `ans.type === 'math_input'` accepted.
2. `ans.type === 'numerical'` accepted.
3. `ans.type === 'input'` accepted.
4. `ans.value` as a number accepted (coerced to string).
5. `ans.text` (alternate field) accepted.
6. Bare string in `ans.value` with no `ans.type` accepted.
7. Empty/whitespace `value` still rejected (`wrong-type`).

The existing positive test (`ans.type === 'text'`) stays unchanged.

---

## 4. Risks & non-goals

- **No applier changes.** If a specific MathQuill widget or Coursera contenteditable is the actual fill failure, this plan won't fix it. The user explicitly said "get most of the system from the answer-for-you system" — that system is `applyStructuredAnswers`, which we're already calling. If a fill still fails after this change, that's a separate investigation into the applier/widget interaction.
- **No prompt-engineering for accuracy.** This plan only fixes the answer *shape*, not the answer *correctness*. If the AI's typed answer is wrong, that's a model-quality concern outside this plan.
- **DeepSeek-specific.** The system prompt edit lives in the DeepSeek client; if `managed-client.js` ever ships with its own prompt, that plan will need to mirror this change.
- **Backwards compatibility.** The validator becomes more permissive, never stricter — every previously-accepted shape (`{type:'text',value:'<string>'}`) still works.
