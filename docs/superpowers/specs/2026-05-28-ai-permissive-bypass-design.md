# AI Apply — Permissive bypass for strict-validator failures — Design

**Status:** approved (per user confirmation 2026-05-28)
**Date:** 2026-05-28
**Scope:** `lib/ai-answer-controller.js` + one new `lib/ai-answer-permissive.js` module. Tests for both.
**Out of scope:** strict validator, applier, sidebar UI surface (no new buttons/toggles), options page, background service worker, transport layer, manifest.

---

## 1. Problem

After Scan → Generate, Apply Answers stays greyed out and the user sees `'AI returned an unrecognized format (reason: <X>). See console for details.'` (controller line 82). Root cause is that the strict validator returns `!val.ok` (`invalid-json`, `invalid-schema`, or `stale-snapshot`) OR returns `ok: true` with every item flagged `applicable: false`. The controller sets `_activeSuggestions = []` in the `!ok` branch, so the sidebar's `_renderAiButtonStates` disables Apply (`suggestions.length === 0`).

User wants a hard bypass: apply whatever the AI returned, accepting reduced safety, rather than nothing.

## 2. Behavior

Two new fallback layers, run in order, only when the strict path can't proceed:

1. **Permissive extractor.** Triggered when `!val.ok` OR `applicableCount === 0`. Tries to recover structured suggestions from the raw AI response.
2. **Numbered-parser last resort.** Triggered when the permissive extractor also yields zero applicable items. Routes the raw response text through `answerApplier.applyAnswers`, which understands the autopilot's numbered-list format and does ordered-line fallback for ≥2 questions.

If both fall through, restore today's behavior: strict-rejection message, Apply stays greyed.

## 3. `lib/ai-answer-permissive.js` (new)

Exports `extract(rawResponse, snapshot)` returning `{ suggestions, sourceShape, rawTextUsedAsFallback }`.

Pipeline:

1. **Lenient parse.** Call `validator.extractStrictJson(rawResponse)`. If `null`, scan the string for the first balanced `{...}` or `[...]` block via a single regex `/[\{\[][\s\S]*[\}\]]/`; `JSON.parse` it. If still `null`, return `{ suggestions: [], sourceShape: 'unparseable' }`.
2. **Find answers array.** Order: `parsed.answers` (array), `parsed` itself (array), or the first value in `parsed` that is an array of objects. Empty → return `{ suggestions: [], sourceShape: 'no-array' }`.
3. **Per item:**
    a. **Identify question.** Look at `item.question_id`, `item.questionId`, `item.qid`, `item.id` (string match against `snapshot.questions[i].id`); then `item.question_number`, `item.questionNumber`, `item.q`, `item.number` (numeric match against `snapshot.questions[i].questionNumber`); finally fall back to positional index against `snapshot.questions`. First match wins.
    b. **Extract answer string.** Walk these keys on `item` and on `item.answer` (if object): `value`, `text`, `option_id`, `letter`, `answer` (if primitive). For array-valued `option_ids` / `letters` / `values` → join with `, `. If `item.answer` is itself a string or number → use that. Coerce numbers to strings. First non-empty wins.
    c. **Coerce by question type** (from snapshot, not from the AI's claimed type):
        - `single_choice` → `{ choiceText: str }`
        - `multiple_choice` → `{ choiceTexts: splitCommasAndAnd(str) }`
        - `math_input` and any other type → `{ value: str }`
    d. Mark `applicable: true`, `mappingStatus: 'bypassed'`, `bypassed: true`. Set `questionNumber`, `type` from snapshot. Carry `explanation` if present.
    e. If no question matched OR no string extracted, push `{ applicable: false, mappingStatus: 'bypass-failed' }` (still surfaced for diagnostics).

`splitCommasAndAnd` mirrors the validator's `splitMultipleAnswerString` (strip `[]`, replace ` and ` → `,`, split on `,`, trim, filter empty).

## 4. `lib/ai-answer-controller.js` changes

Add dep injection: `permissive = deps.permissive` (mirrors `validator`). Constructor: pull from `ClipboardCleaner.aiAnswerPermissive` in the browser path; `require('./ai-answer-permissive.js')` in the node path. Same shape as existing validator wiring.

`performGenerate` after `validateAndMap`:

```
if (!val.ok || applicableCount === 0) {
  var perm = permissive.extract(res.raw, _activeSnapshot);
  var permApplicable = perm.suggestions.filter(s => s.applicable);
  if (permApplicable.length > 0) {
    _activeSuggestions = perm.suggestions;
    sidebar.setAiSuggestions(perm.suggestions);
    sidebar.setAiApplyResult({ filled: 0, failed: 0,
      message: 'Bypassed validator — ' + permApplicable.length + ' forced suggestion(s). Review before applying.' });
    return;
  }
  // Last resort: try raw text through the numbered-parser pipeline.
  _activeSuggestions = { __rawTextFallback: true, rawText: typeof res.raw === 'string' ? res.raw : JSON.stringify(res.raw) };
  sidebar.setAiSuggestions([{ questionNumber: null, type: null, mappingStatus: 'raw-text-fallback', applicable: true, explanation: 'Will apply raw response via numbered-parser when you press Apply.' }]);
  sidebar.setAiApplyResult({ filled: 0, failed: 0,
    message: 'Bypassed validator — will apply raw AI response as text. Press Apply to attempt.' });
  return;
}
```

`performApply`:

- Detect raw-text fallback: if `_activeSuggestions && _activeSuggestions.__rawTextFallback`, call `answerApplier.applyAnswers(_activeSuggestions.rawText, doc.body, { verbose: false })`, surface its summary, and return.
- Otherwise current structured path runs unchanged.

The `_activeSuggestions` slot stays "any truthy" for the existing snapshot-staleness/local-guard checks. Refactor those guards to early-return cleanly for the raw-text-fallback case (skip the local apply-guard; the fallback doesn't have per-question structure to diff).

The sidebar's Apply enable check (`suggestions.length > 0`) keeps working because the controller passes a one-item array `[{ ...raw-text-fallback marker }]` to `setAiSuggestions`.

## 5. Tests

**`tests/ai-answer-permissive.test.js` (new):**
- Parses `{ answers: [...] }` plus letter-style `single_choice`.
- Parses top-level array of items (no `answers` wrapper).
- Parses fenced JSON.
- Parses `{ result: { responses: [...] } }` (deep first array fallback).
- Recovers from truncated/leading-prose response by extracting first balanced `{...}` block.
- Single_choice → choiceText from `value` / `letter` / `option_id`.
- Multiple_choice → choiceTexts from `option_ids` / `letters` / comma string / ` and ` string.
- Math_input → value from string, number, or wrapped object.
- Falls back to positional index when no `question_id` present.
- Returns empty suggestions for truly unparseable garbage.

**`tests/ai-answer-controller.test.js` additions:**
- When validator returns `{ ok: false, reason: 'invalid-schema' }` and permissive yields ≥1 applicable, `_activeSuggestions` is set, sidebar's apply-result shows `'Bypassed validator — N forced suggestion(s)...'`.
- When validator returns `ok` with 0 applicable, permissive runs and replaces suggestions.
- When permissive yields 0 applicable, controller flips to raw-text-fallback marker and apply-result mentions "raw AI response".
- `performApply` in raw-text-fallback mode calls `answerApplier.applyAnswers` with the raw text and surfaces its summary.
- Existing strict-success path unchanged (regression guard).

## 6. Trade-offs accepted

- Permissive extraction can mis-match when the AI's `question_id` is wrong AND positional index also doesn't align. The applier's per-question type check (`q.type !== item.type`) catches the worst cases, but multi-choice answers fed to single-choice questions still get attempted as text-matching.
- Numbered-parser last resort can surprise-fill if the AI returned prose containing accidental numbered lines (e.g., `1. First, ...`). The user accepted this risk explicitly.
- Always-on, no toggle. The bypass message in the result area is the only signal that suggestions are low-confidence.

## 7. Non-changes

- No edits to `lib/ai-answer-validator.js` (its strict semantics remain the gold path).
- No edits to `lib/answer-applier.js` (reuses existing `applyStructuredAnswers` + `applyAnswers`).
- No edits to `lib/deepseek-client.js`, sidebar UI, options page, manifest.
- No new permissions, no new storage keys.
