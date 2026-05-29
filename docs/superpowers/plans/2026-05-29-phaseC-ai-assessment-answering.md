# AI-Driven Assessment Answering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the autopilot run loop answer in-page Coursera quizzes/exams/graded-assignments with AI behind an explicit, key-gated, OFF-by-default toggle that fills typed answers per question-type and then PAUSES for review (never auto-submits), while skipping external LTI launches and programming labs.

**Architecture:** A new `assessment-ai` handler inside `item-handlers.createHandlers` builds a sanitized question snapshot (scoped to the Coursera assessment region, excluding extension/Boost-chat nodes), routes it through an injected `ctx.aiGenerate(snapshot)` bridge that reuses the existing un-gated background `generateAnswers` command, validates the response (validator → permissive → raw fallback), applies it via `answer-applier.applyStructuredAnswers`, and pauses. `module-autopilot` conditionally un-blocks answerable assessments only when `settings.aiAnswerAssessments` is on, routing answerable items to the AI handler and LTI/programming to skip-with-reason. The answer engine (`answer-applier`/`answer-matcher`/`question-detector`) is extended with new question types and three critical correctness fixes (scoped math-normalization, MathQuill detection, label-wrapped `cds-` option fallback, ordinal question detection, unified parser ceilings).

**Tech Stack:** Chrome MV3 content scripts, IIFE modules on `window.ClipboardCleaner`, `node --test` (node:test + node:assert/strict), jsdom.

**Depends on Phase A + B.** This phase consumes Phase A (`window.ClipboardCleaner.courseraDom = {parseLearnUrl, classifyKind, parseItemAccessibleName, itemStatus, isExcludedNode, assessmentRoot, withinAssessment, findOutlineNav, findModuleRegions, findItemLinks, findNextItemButton, isExternalLaunchPage}`) and Phase B (`window.ClipboardCleaner.aiProviders.get(provider).buildRequest/parseResponse`, surfaced to content via the un-gated background `generateAnswers` command). Treat A and B as already loaded and tested; this plan never redefines them. Each task that calls `coursera-dom.*` does so through a small DI shim (`deps.courseraDom` / `opts.courseraDom`) so the new code remains testable with a fake even before Phase A merges, and falls back to `window.ClipboardCleaner.courseraDom` in production.

### Scope: question types implemented in this plan vs deferred

This plan implements detection + apply + `SUPPORTED_TYPES` for: `single_choice`, `multiple_choice`, `numeric`/`math` (`math_input`), `free_text`/`essay`, `dropdown` (Tasks 3–6), plus `code` (best-effort, then pause) and `file_upload` (pause-only) detection/handling (Tasks 4–5).

**Deferred to a follow-up (NOT implemented here): `matching` and `ordering`.** The spec's question-type table (spec L200–L201) lists these as status "full", but they require materially different DOM interaction models — `matching` needs paired left→right control mapping, and `ordering` needs drag-reorder / rank-input sequencing — neither of which the existing `answer-matcher`/`question-detector`/`answer-applier` primitives (radio/checkbox/text/select) support without new detection and apply strategies. Rather than ship a half-built guess, they are explicitly deferred:
- The detector returns `unknown` for matching/ordering containers (so they are NOT mis-applied), and `ai-question-context.SUPPORTED_TYPES` does NOT mark them supported (so the snapshot drops them as unsupported and the handler pauses for the user rather than guessing — consistent with spec L206 "Any question the system cannot confidently answer … pauses for review").
- A follow-up task (post-Phase C) should add `matching`/`ordering` detection (question-detector), apply strategies (answer-applier), and `SUPPORTED_TYPES` entries with TDD tests; the spec table "Status" for these two rows should then be revised to reflect the staged delivery.

This deferral is intentional and documented so the gap is not a silent omission; the fill-then-pause safety guarantee (never auto-submit, never guess) holds for these types in the interim.

---

## File Structure

| File | Create / Modify | Responsibility (single) |
|---|---|---|
| `lib/autopilot-state.js` | Modify (`defaults()` @ L35) | Add `aiAnswerAssessments: false` to `defaults().settings` so it threads through every settings merge. |
| `lib/autopilot-authority.js` | No code change (regression-tested only) | The activate merge at `_cmd_activateRun` L335 already preserves any settings key via `Object.assign({}, _settingsDefaults(), curSettings, newState.settings)`; `_settingsDefaults()` = `defaults().settings`, which gains the field in Task 7. Task 8 adds a regression test guarding this round-trip. |
| `lib/autopilot-debug.js` | Modify (`FORBIDDEN_KEYS` @ L93) | Add ONLY AI-specific container field names (`prompt`, `snapshot`, `choiceText`, `choiceTexts`) to the redaction list — NOT generic keys (`value`/`options`/`label`) that existing events/tests rely on. |
| `lib/numbered-parser.js` | Modify (ceilings @ L57, L130, L146; regexes @ L125, L141, L160) | Unify the per-question-number ceiling to a single shared constant AND widen the `\d{1,2}` regexes to `\d{1,3}` so the ceiling actually fires (today `\d{1,2}` caps real matches at 99). |
| `lib/answer-parser.js` | Modify (ceiling @ L295; `NUMBER_PATTERN` @ L19) | Unify the per-question-number ceiling to the same shared value as numbered-parser AND widen `NUMBER_PATTERN`'s three `\d{1,2}` groups to `\d{1,3}`. |
| `lib/answer-matcher.js` | Modify (`findTextInputs` @ L182, `findOptionGroups` @ L130) | Add `.mq-editable-field` MathQuill detection + a label-wrapped clickable fallback for `cds-` options without `role=radio`. |
| `lib/question-detector.js` | Modify (`classify` @ L132, `collectContainers` @ L56, `detectQuestions` @ L148) | Add dropdown/free_text/code/file_upload classification + container-ordinal numbering (gated on a non-`unknown` classify) when no literal "Question N". |
| `lib/answer-applier.js` | Modify (`applyAnswers` @ L201, `applyStructuredAnswers` @ L356) | Scope math-normalization to numeric/math only + add apply branches for dropdown/free_text/code/file_upload. |
| `lib/ai-question-context.js` | Modify (`SUPPORTED_TYPES` @ L11) | Expand supported types so the snapshot does not drop the new answerable types. |
| `lib/item-handlers.js` | Modify (inside `createHandlers` @ L83-564, returned map @ L556-563) | Add the `assessmentAi` handler (build snapshot → validate → apply → pause) wired with DI `aiGenerate`/`courseraDom`. |
| `lib/module-scraper.js` | Modify (no predicate change; consumed read-only) | (No code change in this phase; un-block gating lives in the controller. Listed for grounding.) |
| `lib/module-autopilot.js` | Modify (`buildOrderedQueue` @ L97, `handlerForKind` @ L918, run-loop handler call @ L1072, `isFailureOutcome` @ L71, `FAILURE_REASON_TEXT` @ L146, ctx @ L1081, handler-outcome pause branch @ L1133) | Conditional un-block gating, AI/skip routing, `ctx.aiGenerate`, AI fill/no-answer pause tokens (failures), LTI/programming skip-advance branch + run-log lines. |
| `lib/sidebar.js` | Modify (markup @ L92-97, `setAutopilotSettings` @ L771, `emitSettings` @ L920, `setAiKeyStatus` @ L986) | Add the `aiAnswerAssessments` toggle (markup + sync + emit + key-gated disable). |
| `content.js` | Modify (`startAutopilot` @ L96-171, `_latestSettings` @ L175) | Build the `aiGenerate` bridge from the existing `ccp.ai.request`/`generateAnswers` messenger and pass it into `createHandlers` + `createAutopilot`; default `aiAnswerAssessments:false`. |
| `tests/autopilot-state.test.js` | Modify (Test) | Assert the new default + migration leaves it false. |
| `tests/autopilot-authority.test.js` | Modify (Test) | Assert the field survives an activate/load round-trip (pure regression test; no authority code change). |
| `tests/autopilot-debug.test.js` | Modify (Test) | Assert AI-specific keys are redacted while generic `value` is left intact. |
| `tests/numbered-parser.test.js` / `tests/answer-parser.test.js` | Modify (Test) | Assert the unified ceiling accepts the same range in both. |
| `tests/answer-matcher.test.js` | Modify (Test) | MathQuill + label-wrapped `cds-` option detection. |
| `tests/question-detector.test.js` | Modify (Test) | Dropdown/free_text/code/file_upload + ordinal numbering. |
| `tests/answer-applier.test.js` | Modify (Test) | Plain-text math-corruption regression + new-type apply branches. |
| `tests/ai-question-context.test.js` | Modify (Test) | New types marked supported in the snapshot. |
| `tests/item-handlers.test.js` | Modify (Test) | `assessmentAi` handler: apply+pause, no-key, error→pause, exclusion. |
| `tests/module-autopilot.test.js` | Modify (Test, `mkFakeHandlers` @ L37) | Un-block gating on/off, fresh-start gating, AI routing, AI-pause-vs-skip-advance semantics, run-log lines, ctx.aiGenerate wiring, end-to-end fill-then-pause (no submit). |

---

### Task 1: Unify parser question-number ceilings (and widen regexes to 3 digits so the ceiling fires)

**Files:**
- Modify: `lib/numbered-parser.js:57,130,146` (ceiling checks) and `:125,141,160` (the `\d{1,2}` regexes)
- Modify: `lib/answer-parser.js:295` (ceiling check) and `:19` (`NUMBER_PATTERN` `\d{1,2}` groups)
- Test: `tests/numbered-parser.test.js`, `tests/answer-parser.test.js`

> **Why both the constant AND the regexes change:** the underlying regexes match only 1–2 digit numbers (`\d{1,2}`), so a 3-digit number like `101` cannot match at all and the ceiling check never fires — a `MAX_QUESTION_NUMBER=100` constant alone would be a no-op for any value > 99. To make the ceiling genuinely enforce (accept Q100, reject Q150), widen the regexes to `\d{1,3}` so 3-digit numbers reach the `> MAX_QUESTION_NUMBER` guard.

Steps:

- [ ] 1. Write the failing test in `tests/numbered-parser.test.js` (append at end of file, before any trailing comment). It asserts the unified ceiling (100) accepts a genuine 3-digit-vs-ceiling boundary — Q100 accepted, Q150 rejected — proving the rejection fires for the RIGHT reason (the ceiling, not the regex width):
```js
test('numbered-parser: accepts Q100 at the unified ceiling and rejects Q150 above it', () => {
  const { parseNumberedAnswers } = require('../lib/numbered-parser.js');
  const got = parseNumberedAnswers('100. Diamagnetism\n150. nope');
  const nums = got.map(function (p) { return p.questionNumber; });
  assert.ok(nums.indexOf(100) !== -1, 'Q100 must be accepted at the unified ceiling');
  assert.ok(nums.indexOf(150) === -1, 'Q150 must be rejected above the unified ceiling');
});
```
- [ ] 2. Run it and watch it FAIL (current `\d{1,2}` regex cannot match 3-digit `100`, so Q100 is dropped): `node --test "tests/numbered-parser.test.js"` → expect FAIL on the `indexOf(100) !== -1` assertion.
- [ ] 3. Minimal implementation in `lib/numbered-parser.js`. Add a shared constant immediately after `'use strict';` (line 5 area):
```js
  const MAX_QUESTION_NUMBER = 100;
```
Then (a) widen the three `\d{1,2}` question-number regex groups to `\d{1,3}` so 3-digit numbers can match:
  - L125 `layerNumberedList`: change `(\d{1,2})` → `(\d{1,3})` in `const re = /^\s*(?:\*\*)?\s*(\d{1,2})\s*(?:\*\*)?\s*([.):])(\s*)(.+?)\s*$/gm;`
  - L141 `layerQuestionN`: change `(\d{1,2})` → `(\d{1,3})` in `const re = /^\s*Question\s+(\d{1,2})\s*[:.\-]\s*(.+?)\s*$/gim;`
  - L160 `layerLineFallback`: change both `\d{1,2}` → `\d{1,3}` in `if (lines.some(function (l) { return /^\d{1,2}[.):]/.test(l); })) return [];`

(b) Then replace the three ceiling checks. At L57 (`fromJSONShape`) change `if (!Number.isFinite(n) || n < 1 || n > 50) return;` to `if (!Number.isFinite(n) || n < 1 || n > MAX_QUESTION_NUMBER) return;`. At L130 (`layerNumberedList`) change `if (!Number.isFinite(n) || n < 1 || n > 50) continue;` to `if (!Number.isFinite(n) || n < 1 || n > MAX_QUESTION_NUMBER) continue;`. At L146 (`layerQuestionN`) change the `> 50` check to `> MAX_QUESTION_NUMBER`. Export the constant by adding `MAX_QUESTION_NUMBER: MAX_QUESTION_NUMBER,` into the existing `api` object literal.
- [ ] 4. Run it and watch it PASS: `node --test "tests/numbered-parser.test.js"` → expect PASS.
- [ ] 5. Write the failing test in `tests/answer-parser.test.js` (append at end). NOTE: `parseAnswerText` returns `{ letters, numbers, quotedSnippets, computedValues, rawText }` — there is NO `.number` field; assert against the `numbers` array. The input `"100. ..."` reaches the `(\d{1,3})(?=\)|\.(?!\d))` branch (digits followed by `.` not-digit):
```js
test('answer-parser: NUMBER_PATTERN accepts Q100 at the ceiling and rejects Q150 above it', () => {
  const { parseAnswerText } = require('../lib/answer-parser.js');
  const got = parseAnswerText('Per option 100. And option 150.');
  assert.ok(got.numbers.indexOf(100) !== -1, 'Q100 must be parsed at the unified ceiling');
  assert.ok(got.numbers.indexOf(150) === -1, 'Q150 must be rejected above the unified ceiling');
});
```
- [ ] 6. Run it and watch it FAIL (current `\d{1,2}` cannot match 3-digit `100`, so it never reaches the ceiling): `node --test "tests/answer-parser.test.js"` → expect FAIL (`got.numbers` does not contain 100).
- [ ] 7. Minimal implementation in `lib/answer-parser.js`. Add after `'use strict';`:
```js
  const MAX_QUESTION_NUMBER = 100;
```
Then (a) widen all three `\d{1,2}` capture groups in `NUMBER_PATTERN` (L19) to `\d{1,3}`:
```js
  const NUMBER_PATTERN = /(?:\b(?:option|choice|answer)\s+(\d{1,3})\b|#(\d{1,3})\b|(?:^|\s)(\d{1,3})(?=\)|\.(?!\d)))/gi;
```
(b) Replace L295 `if (!Number.isFinite(n) || n < 1 || n > 20) continue;` with `if (!Number.isFinite(n) || n < 1 || n > MAX_QUESTION_NUMBER) continue;`. Add `MAX_QUESTION_NUMBER: MAX_QUESTION_NUMBER,` to the `api` object literal (which currently exports `parseAnswerText` and `cleanFillValue`).
- [ ] 8. Run it and watch it PASS: `node --test "tests/answer-parser.test.js"` → expect PASS. Then run the full suite to confirm no regression: `npm test` → expect all green.
- [ ] 9. Commit: `git add lib/numbered-parser.js lib/answer-parser.js tests/numbered-parser.test.js tests/answer-parser.test.js` then `git commit -m "fix(parsers): unify question-number ceiling to 100 and widen regexes to 3 digits"`

---

### Task 2: Scope math-normalization to numeric/math only (stop corrupting plain text)

**Files:**
- Modify: `lib/answer-applier.js:200-202` (`applyAnswers` single-target branch), `lib/answer-applier.js:356-358` (`applyStructuredAnswers` math branch)
- Test: `tests/answer-applier.test.js`

Steps:

- [ ] 1. Write the failing test in `tests/answer-applier.test.js` (append at end). It builds a single math-typed question whose only target is a `text` input and feeds it a plain-word answer that math-normalize would mangle; it asserts the value lands verbatim. Use the existing `dom(html)` helper convention (a JSDOM whose `.window.document` is returned):
```js
test('applyAnswers: plain-text answer into a non-numeric text input is not math-normalized', () => {
  const j = new JSDOM(
    '<!doctype html><html><body>' +
    '<div data-testid="cml-question-1"><div>Question 1</div>' +
    '<input type="text" name="q1" /></div>' +
    '</body></html>', { url: 'https://www.coursera.org/learn/x/quiz/q1/a' });
  const doc = j.window.document;
  const summary = applyAnswers('1. spectroscopy', doc.body, { verbose: false });
  const input = doc.querySelector('input[name="q1"]');
  assert.equal(input.value, 'spectroscopy', 'plain word must be filled verbatim, not normalized');
});
```
(Ensure the file's top has `const { JSDOM } = require('jsdom');` — it already does for fixture tests; if absent, the test adds it.)
- [ ] 2. Run it and watch it FAIL: `node --test "tests/answer-applier.test.js"` → expect FAIL because `normalizeMathAnswer('spectroscopy')` corrupts the word (inserts operators / collapses), so `input.value !== 'spectroscopy'`.
- [ ] 3. Minimal implementation in `lib/answer-applier.js`. Add a helper near the top (after `req(...)` block, before `applyAnswers`):
```js
  // Math-normalization must ONLY run on genuinely numeric/math answers. Running
  // it on plain words ("one" -> "on*e", "spectroscopy" mangled) corrupts text.
  const NUMERIC_MATH_RE = /[0-9]/;
  function looksNumericMath(s) {
    return NUMERIC_MATH_RE.test(String(s || ''));
  }
```
In `applyAnswers` replace the L200-202 block:
```js
        const target0 = q.targets[0];
        const isTextarea = target0 && (target0.tagName || '').toUpperCase() === 'TEXTAREA';
        const normalized = isTextarea ? p.rawAnswer.trim() : mathNormalize.normalizeMathAnswer(p.rawAnswer);
```
with:
```js
        const target0 = q.targets[0];
        const isTextarea = target0 && (target0.tagName || '').toUpperCase() === 'TEXTAREA';
        // Only numeric/math answers go through math-normalization; plain words/phrases
        // are filled verbatim so they are not corrupted (e.g. "spectroscopy", "one").
        const normalized = (isTextarea || !looksNumericMath(p.rawAnswer))
          ? p.rawAnswer.trim()
          : mathNormalize.normalizeMathAnswer(p.rawAnswer);
```
In `applyStructuredAnswers` replace the L356-358 block:
```js
      if (item.type === 'math_input' || item.type === 'numerical' || item.type === 'input') {
        const normalized = mathNormalize.normalizeMathAnswer(item.value);
```
with:
```js
      if (item.type === 'math_input' || item.type === 'numerical' || item.type === 'input') {
        const normalized = looksNumericMath(item.value)
          ? mathNormalize.normalizeMathAnswer(item.value)
          : String(item.value == null ? '' : item.value).trim();
```
- [ ] 4. Run it and watch it PASS: `node --test "tests/answer-applier.test.js"` → expect PASS. The existing "11-question failure case" still passes because its math fields contain digits (e.g. `3.7647E5`) and so still normalize, and its radio Q10 is unaffected. Confirm: `node --test "tests/answer-applier.test.js"` → all green.
- [ ] 5. Commit: `git add lib/answer-applier.js tests/answer-applier.test.js` then `git commit -m "fix(answer-applier): scope math-normalization to numeric/math answers only"`

---

### Task 3: MathQuill + label-wrapped `cds-` option detection in answer-matcher

**Files:**
- Modify: `lib/answer-matcher.js:182-205` (`findTextInputs`), `lib/answer-matcher.js:130-133` (`findOptionGroups`)
- Test: `tests/answer-matcher.test.js`

Steps:

- [ ] 1. Write the failing test in `tests/answer-matcher.test.js` for MathQuill (append at end). It builds a `.mq-editable-field` contenteditable and asserts `findTextInputs` returns it:
```js
test('findTextInputs: discovers a .mq-editable-field MathQuill target', () => {
  const j = new JSDOM('<!doctype html><html><body>' +
    '<span class="mq-editable-field" contenteditable="true"></span>' +
    '</body></html>', { url: 'https://www.coursera.org/learn/x/quiz/q/a' });
  const doc = j.window.document;
  const found = findTextInputs(doc.body);
  assert.equal(found.length, 1, 'MathQuill field must be discovered');
  assert.equal(found[0].kind, 'mathquill');
});
```
(`const { findTextInputs, findOptionGroups } = require('../lib/answer-matcher.js');` and `const { JSDOM } = require('jsdom');` at top — add if missing.)
- [ ] 2. Run it and watch it FAIL: `node --test "tests/answer-matcher.test.js"` → expect FAIL (`found.length` is 0; the selector lacks `.mq-editable-field`).
- [ ] 3. Minimal implementation in `lib/answer-matcher.js` `findTextInputs`. Change the selector at L186 to include `.mq-editable-field`:
```js
    const els = root.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], .mq-editable-field');
```
Inside the `forEach`, after the existing `else { kind = 'contenteditable'; }` resolution, add MathQuill kind detection. Replace the tag-branch block:
```js
      const tag = (el.tagName || '').toUpperCase();
      let kind;
      if (tag === 'INPUT') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (TEXT_INPUT_TYPES.indexOf(t) === -1) return;
        kind = 'input';
      } else if (tag === 'TEXTAREA') {
        kind = 'textarea';
      } else {
        kind = 'contenteditable';
      }
      out.push({ el: el, kind: kind });
```
with:
```js
      const tag = (el.tagName || '').toUpperCase();
      const cls = (typeof el.className === 'string') ? el.className : '';
      let kind;
      if (/\bmq-editable-field\b/.test(cls)) {
        kind = 'mathquill';
      } else if (tag === 'INPUT') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (TEXT_INPUT_TYPES.indexOf(t) === -1) return;
        kind = 'input';
      } else if (tag === 'TEXTAREA') {
        kind = 'textarea';
      } else {
        kind = 'contenteditable';
      }
      out.push({ el: el, kind: kind });
```
- [ ] 4. Run it and watch it PASS: `node --test "tests/answer-matcher.test.js"` → expect PASS for the MathQuill test.
- [ ] 5. Write the failing test for the label-wrapped `cds-` option fallback (append). It builds three label-wrapped clickable divs with `cds-`-prefixed class and NO `role=radio`/native input, grouped under one container, and asserts `findOptionGroups` returns one group with three options:
```js
test('findOptionGroups: label-wrapped cds- options without role=radio are discovered as a group', () => {
  const j = new JSDOM('<!doctype html><html><body>' +
    '<div data-testid="cml-question-1">' +
      '<label class="cds-checkboxAndRadio-label"><div class="cds-1">Alpha</div></label>' +
      '<label class="cds-checkboxAndRadio-label"><div class="cds-1">Beta</div></label>' +
      '<label class="cds-checkboxAndRadio-label"><div class="cds-1">Gamma</div></label>' +
    '</div>' +
    '</body></html>', { url: 'https://www.coursera.org/learn/x/quiz/q/a' });
  const doc = j.window.document;
  const groups = findOptionGroups(doc.querySelector('[data-testid="cml-question-1"]'));
  assert.equal(groups.length, 1, 'one label-wrapped option group');
  assert.equal(groups[0].options.length, 3);
  assert.deepEqual(groups[0].options.map(function (o) { return o.text; }), ['Alpha', 'Beta', 'Gamma']);
});
```
- [ ] 6. Run it and watch it FAIL: `node --test "tests/answer-matcher.test.js"` → expect FAIL (`findOptionGroups` returns 0 groups; no native inputs and no `role=radio`).
- [ ] 7. Minimal implementation in `lib/answer-matcher.js`. Add a label-wrapped fallback finder, then call it from `findOptionGroups`. Add this function above `findOptionGroups`:
```js
  // Coursera cds- options are often label-wrapped clickable divs/buttons with no
  // native input and no role=radio. Group sibling cds- labels under a single
  // container so the matcher can click them. Only used when no native/aria group
  // was found in the same container, to avoid double-claiming real inputs.
  function findLabelWrappedGroups(root) {
    const labels = root.querySelectorAll('label[class*="cds-"]');
    if (!labels || labels.length < 1) return [];
    const options = [];
    labels.forEach(function (lbl) {
      if (!isUsable(lbl)) return;
      if (!isVisible(lbl)) return;
      // Skip labels that wrap a native input or role=radio/checkbox (handled elsewhere).
      if (lbl.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]')) return;
      options.push({ el: lbl, text: textOf(lbl), index: options.length });
    });
    if (options.length < 2) return [];
    return [{ kind: 'radio', name: '__cdsLabel__:1', options: options }];
  }
```
Then change `findOptionGroups` (L130-133):
```js
  function findOptionGroups(root) {
    if (!root) return [];
    return findNativeGroups(root).concat(findAriaGroups(root));
  }
```
to:
```js
  function findOptionGroups(root) {
    if (!root) return [];
    const primary = findNativeGroups(root).concat(findAriaGroups(root));
    if (primary.length > 0) return primary;
    // Fallback only when no native/aria groups exist: label-wrapped cds- options.
    return findLabelWrappedGroups(root);
  }
```
- [ ] 8. Run it and watch it PASS: `node --test "tests/answer-matcher.test.js"` → expect PASS. Then `npm test` → expect all green (the fallback only fires when no native/aria group is found, so existing tests are unaffected).
- [ ] 9. Commit: `git add lib/answer-matcher.js tests/answer-matcher.test.js` then `git commit -m "feat(answer-matcher): detect MathQuill fields and label-wrapped cds- option groups"`

---

### Task 4: Question detection by container ordinal + dropdown/free_text/code/file_upload types

**Files:**
- Modify: `lib/question-detector.js:56-91` (`collectContainers` Pass A — keep headerless containers), `lib/question-detector.js:148-179` (`detectQuestions` — ordinal numbering + unknown-decoy guard), `lib/question-detector.js:132-146` (`classify` — new types). (`HEAD_RE` @ L16 is unchanged; the ordinal path handles the no-header case.)
- Test: `tests/question-detector.test.js`

Steps:

- [ ] 1. Write the failing test for ordinal detection (append to `tests/question-detector.test.js`). Two `data-testid="cml-question"` containers with NO literal "Question N" text, each with a radio group; assert they get questionNumber 1 and 2 by DOM order:
```js
test('detectQuestions: numbers containers by ordinal when no literal "Question N"', () => {
  const j = new JSDOM('<!doctype html><html><body>' +
    '<div data-testid="cml-question-a"><fieldset>' +
      '<label><input type="radio" name="qa"> Yes</label>' +
      '<label><input type="radio" name="qa"> No</label>' +
    '</fieldset></div>' +
    '<div data-testid="cml-question-b"><fieldset>' +
      '<label><input type="radio" name="qb"> True</label>' +
      '<label><input type="radio" name="qb"> False</label>' +
    '</fieldset></div>' +
    '</body></html>', { url: 'https://www.coursera.org/learn/x/quiz/q/a' });
  const out = detectQuestions(j.window.document.body);
  assert.equal(out.length, 2);
  assert.equal(out[0].questionNumber, 1);
  assert.equal(out[1].questionNumber, 2);
});
```
(`const { detectQuestions } = require('../lib/question-detector.js');` + `const { JSDOM } = require('jsdom');` at top — add if missing.)
- [ ] 2. Run it and watch it FAIL: `node --test "tests/question-detector.test.js"` → expect FAIL (current `collectContainers` requires `findHeaderInside` to match `HEAD_RE`, so containers without "Question N" are dropped → `out.length` is 0).
- [ ] 3. Minimal implementation in `lib/question-detector.js`. In `collectContainers` (L56-91), change Pass A (`explicit.forEach` at L64-71) so a `data-testid` container with NO matched header still becomes a container with a `null` header (numbered later by ordinal). Replace the Pass A `explicit.forEach` body:
```js
    explicit.forEach(function (el) {
      if (seen.has(el)) return;
      const hdr = findHeaderInside(el);
      if (hdr) {
        seen.add(el);
        containers.push({ container: el, header: hdr });
      }
    });
```
with:
```js
    explicit.forEach(function (el) {
      if (seen.has(el)) return;
      const hdr = findHeaderInside(el);
      seen.add(el);
      // Keep the container even without a literal "Question N" header; it will be
      // numbered by ordinal below. This rescues single-question pages, localized
      // labels, and pages that omit the "Question N" prefix entirely. Decoy
      // containers with no answerable surface are dropped in detectQuestions
      // (their classify() yields 'unknown'), so non-question scaffolding whose
      // data-testid merely contains "question" is never emitted as a question.
      containers.push({ container: el, header: hdr || null });
    });
```
Then in `detectQuestions` (L148-179), assign ordinals where `header` is null AND drop ordinal-only containers that have no answerable surface. The real loop builds a `byNumber` Map (L152-174) and dedups by question number; preserve that structure. Replace the `raw.forEach` body (L153-174):
```js
    raw.forEach(function (rc) {
      const cls = classify(rc.container);
      const fullText = (rc.container.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      const entry = {
        questionNumber: rc.header.number,
        titleText: rc.header.titleText,
        fullText: fullText,
        type: cls.type,
        choices: cls.choices,
        targets: cls.targets,
        container: rc.container
      };
      const prev = byNumber.get(entry.questionNumber);
      if (!prev) { byNumber.set(entry.questionNumber, entry); return; }
      // Prefer the entry with a typed answer surface.
      const score = function (e) {
        if (e.type === 'single_choice' || e.type === 'multiple_choice') return 3;
        if (e.type === 'math_input') return 2;
        return 0;
      };
      if (score(entry) > score(prev)) byNumber.set(entry.questionNumber, entry);
    });
```
with:
```js
    let ordinal = 0;
    raw.forEach(function (rc) {
      const cls = classify(rc.container);
      const hasHeader = !!(rc.header && typeof rc.header.number === 'number');
      // GUARD: an ordinal-only container (no literal "Question N" header) is only
      // a real question if it actually classifies to an answerable surface. A
      // decoy like <div data-testid="question-meta"> with no inputs yields
      // 'unknown' and must NOT be counted (it would otherwise inflate the
      // snapshot's actionableCount and surface scaffolding to the AI). Dropped
      // decoys do NOT consume an ordinal slot, so kept questions stay contiguous.
      if (!hasHeader && cls.type === 'unknown') return;
      ordinal += 1;
      const fullText = (rc.container.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      const number = hasHeader ? rc.header.number : ordinal;
      const titleText = (rc.header && rc.header.titleText) ? rc.header.titleText : ('Question ' + ordinal);
      const entry = {
        questionNumber: number,
        titleText: titleText,
        fullText: fullText,
        type: cls.type,
        choices: cls.choices,
        targets: cls.targets,
        container: rc.container
      };
      const prev = byNumber.get(entry.questionNumber);
      if (!prev) { byNumber.set(entry.questionNumber, entry); return; }
      // Prefer the entry with a typed answer surface.
      const score = function (e) {
        if (e.type === 'single_choice' || e.type === 'multiple_choice') return 3;
        if (e.type === 'dropdown' || e.type === 'free_text' || e.type === 'code') return 2.5;
        if (e.type === 'math_input') return 2;
        if (e.type === 'file_upload') return 1;
        return 0;
      };
      if (score(entry) > score(prev)) byNumber.set(entry.questionNumber, entry);
    });
```
(Note: `ordinal` increments only AFTER the unknown-decoy guard, so kept questions are numbered contiguously 1, 2, 3… in DOM order and a dropped decoy never leaves a gap.)
- [ ] 4. Run it and watch it PASS: `node --test "tests/question-detector.test.js"` → expect PASS for ordinal detection. Run `npm test` to confirm "Question N" pages still number correctly → expect all green.
- [ ] 4a. Write the failing decoy-guard test (append). A headerless `data-testid="question-meta"` decoy that contains NO answerable input must NOT be emitted, while an adjacent real radio question IS — proving ordinal-only retention is gated on a non-`unknown` classify:
```js
test('detectQuestions: a headerless data-testid="question-meta" decoy with no inputs is NOT emitted', () => {
  const j = new JSDOM('<!doctype html><html><body>' +
    '<div data-testid="question-meta"><span>Points: 5</span></div>' +
    '<div data-testid="cml-question-a"><fieldset>' +
      '<label><input type="radio" name="qa"> Yes</label>' +
      '<label><input type="radio" name="qa"> No</label>' +
    '</fieldset></div>' +
    '</body></html>', { url: 'https://www.coursera.org/learn/x/quiz/q/a' });
  const out = detectQuestions(j.window.document.body);
  assert.equal(out.length, 1, 'only the real radio question is emitted; the decoy is dropped');
  assert.equal(out[0].type, 'single_choice');
  assert.equal(out[0].questionNumber, 1, 'the kept question numbers as ordinal 1 (no gap from the dropped decoy)');
});
```
- [ ] 4b. Run it and watch it FAIL before the step-3 guard is applied (the decoy would be emitted as an `unknown` ordinal question → `out.length === 2`), and PASS after: `node --test "tests/question-detector.test.js"` → expect PASS once step 3's `if (!hasHeader && cls.type === 'unknown') return;` guard is in place.
- [ ] 5. Write the failing test for the new types (append). A `<select>` dropdown, a bare `<textarea>` free_text, a `data-testid="code-editor"` code block, and an `input[type=file]`:
```js
test('classify: detects dropdown, free_text, code, and file_upload types', () => {
  const j = new JSDOM('<!doctype html><html><body>' +
    '<div data-testid="cml-question-1"><select><option>x</option><option>y</option></select></div>' +
    '<div data-testid="cml-question-2"><textarea></textarea></div>' +
    '<div data-testid="cml-question-3"><div data-testid="code-editor"><textarea></textarea></div></div>' +
    '<div data-testid="cml-question-4"><input type="file"></div>' +
    '</body></html>', { url: 'https://www.coursera.org/learn/x/quiz/q/a' });
  const out = detectQuestions(j.window.document.body);
  const types = out.map(function (q) { return q.type; });
  assert.deepEqual(types, ['dropdown', 'free_text', 'code', 'file_upload']);
});
```
- [ ] 6. Run it and watch it FAIL: `node --test "tests/question-detector.test.js"` → expect FAIL (current `classify` returns `math_input` for the textarea/file cases and `unknown` for `<select>`).
- [ ] 7. Minimal implementation in `lib/question-detector.js` `classify`. Replace the function body. The order matters: file_upload and code are checked before generic editable targets, dropdown before editable, free_text (textarea/contenteditable) after numeric inputs:
```js
  function classify(container) {
    const group = findRadioOrCheckbox(container);
    if (group) {
      return {
        type: group.kind === 'radio' ? 'single_choice' : 'multiple_choice',
        choices: group.options.map(function (o) { return { el: o.el, text: o.text, index: o.index }; }),
        targets: []
      };
    }
    // File upload: cannot fabricate a file — detect so the handler can pause.
    const fileInput = container.querySelector('input[type="file"]');
    if (fileInput && isVisible(fileInput)) {
      return { type: 'file_upload', choices: [], targets: [fileInput] };
    }
    // Code editor: a code surface (data-testid contains "code", or a CodeMirror/Monaco/ace class).
    const codeHost = container.querySelector('[data-testid*="code" i], .CodeMirror, .monaco-editor, .ace_editor');
    if (codeHost) {
      const codeTargets = findEditableTargets(container);
      return { type: 'code', choices: [], targets: codeTargets };
    }
    // Dropdown: native <select> (cds- listbox is handled as a choice group above when present).
    const select = container.querySelector('select');
    if (select && isVisible(select)) {
      const opts = [];
      const optionEls = select.querySelectorAll('option');
      optionEls.forEach(function (o, i) { opts.push({ el: o, text: (o.textContent || '').trim(), index: i }); });
      return { type: 'dropdown', choices: opts, targets: [select] };
    }
    const targets = findEditableTargets(container);
    if (targets.length > 0) {
      // A lone <textarea>/contenteditable with no numeric hint is free text/essay;
      // numeric/MathQuill inputs stay math_input. `onlyTextareas` drives the
      // decision: every target is a TEXTAREA -> free_text; otherwise math_input.
      const onlyTextareas = targets.every(function (t) {
        return (t.tagName || '').toUpperCase() === 'TEXTAREA';
      });
      if (onlyTextareas) {
        return { type: 'free_text', choices: [], targets: targets };
      }
      return { type: 'math_input', choices: [], targets: targets };
    }
    return { type: 'unknown', choices: [], targets: [] };
  }
```
This is the FINAL classify() body — write exactly this. There is no `allTextarea` variable.
- [ ] 8. Run it and watch it PASS: `node --test "tests/question-detector.test.js"` → expect PASS. Run `npm test` → expect all green (math/choice detection unchanged for existing fixtures).
- [ ] 9. Commit: `git add lib/question-detector.js tests/question-detector.test.js` then `git commit -m "feat(question-detector): ordinal numbering + dropdown/free_text/code/file_upload types"`

---

### Task 5: Apply branches for dropdown / free_text / code / file_upload in answer-applier

**Files:**
- Modify: `lib/answer-applier.js` `applyStructuredAnswers` (function starts @ L310; add the new per-type branches just before its `unsupported-type` fallback)
- Test: `tests/answer-applier.test.js`

> The dropdown branch sets `<select>.value` directly and dispatches `input`/`change`; it does NOT reuse `clickChoice` (L80, which is for radio/checkbox option elements). The free_text/code branches reuse the existing `fillTextOnce` helper (L95). No change to `clickChoice` is needed.

Steps:

- [ ] 1. Write the failing test for dropdown apply (append). A `<select>` question; structured item `{questionNumber:1, type:'dropdown', value:'Beta'}`; assert the matching option is selected:
```js
test('applyStructuredAnswers: dropdown selects the option whose text matches value', () => {
  const j = new JSDOM('<!doctype html><html><body>' +
    '<div data-testid="cml-question-1"><div>Question 1</div>' +
    '<select name="q1"><option>Alpha</option><option>Beta</option><option>Gamma</option></select></div>' +
    '</body></html>', { url: 'https://www.coursera.org/learn/x/quiz/q/a' });
  const doc = j.window.document;
  const r = applyStructuredAnswers([{ questionNumber: 1, type: 'dropdown', value: 'Beta' }], doc.body, { verbose: false });
  const sel = doc.querySelector('select[name="q1"]');
  assert.equal(sel.value, 'Beta');
  assert.equal(r.summary.filled, 1);
});
```
(`const { applyAnswers, applyStructuredAnswers } = require('../lib/answer-applier.js');` at top — add `applyStructuredAnswers` to the destructure if absent.)
- [ ] 2. Run it and watch it FAIL: `node --test "tests/answer-applier.test.js"` → expect FAIL (no `dropdown` branch; falls through to `unsupported-type`).
- [ ] 3. Minimal implementation in `lib/answer-applier.js`. Add a dropdown branch in `applyStructuredAnswers` immediately before the final `results.push(... 'unsupported-type' ...)`:
```js
      if (item.type === 'dropdown') {
        const sel = q.targets && q.targets[0];
        if (!sel || (sel.tagName || '').toUpperCase() !== 'SELECT') { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'no-select-target' }); failed++; continue; }
        const want = normalizeChoiceText(item.value);
        let matchedOpt = null;
        const optionEls = sel.querySelectorAll('option');
        for (let oi = 0; oi < optionEls.length; oi++) {
          if (normalizeChoiceText(optionEls[oi].textContent) === want) { matchedOpt = optionEls[oi]; break; }
        }
        if (!matchedOpt) {
          for (let oj = 0; oj < optionEls.length; oj++) {
            const ot = normalizeChoiceText(optionEls[oj].textContent);
            if (ot.length > 2 && (ot.indexOf(want) !== -1 || want.indexOf(ot) !== -1)) { matchedOpt = optionEls[oj]; break; }
          }
        }
        if (!matchedOpt) { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'option not matched' }); failed++; continue; }
        try { sel.value = matchedOpt.value || matchedOpt.textContent; } catch (_) {}
        if (sel.value !== (matchedOpt.value || matchedOpt.textContent)) { try { matchedOpt.selected = true; } catch (_) {} }
        dispatch(sel, 'input'); dispatch(sel, 'change');
        results.push({ questionNumber: q.questionNumber, type: q.type, status: 'filled', valueUsed: matchedOpt.textContent }); filled++; continue;
      }
```
- [ ] 4. Run it and watch it PASS: `node --test "tests/answer-applier.test.js"` → expect PASS for dropdown.
- [ ] 5. Write the failing test for free_text + code + file_upload (append). free_text/code fill a textarea; file_upload returns a `pause-only` status without touching anything:
```js
test('applyStructuredAnswers: free_text and code fill, file_upload is pause-only', () => {
  const j = new JSDOM('<!doctype html><html><body>' +
    '<div data-testid="cml-question-1"><div>Question 1</div><textarea name="ft"></textarea></div>' +
    '<div data-testid="cml-question-2"><div>Question 2</div><div data-testid="code-editor"><textarea name="cd"></textarea></div></div>' +
    '<div data-testid="cml-question-3"><div>Question 3</div><input type="file" name="fu"></div>' +
    '</body></html>', { url: 'https://www.coursera.org/learn/x/quiz/q/a' });
  const doc = j.window.document;
  const r = applyStructuredAnswers([
    { questionNumber: 1, type: 'free_text', value: 'a thoughtful answer' },
    { questionNumber: 2, type: 'code', value: 'print(42)' },
    { questionNumber: 3, type: 'file_upload', value: '' },
  ], doc.body, { verbose: false });
  assert.equal(doc.querySelector('textarea[name="ft"]').value, 'a thoughtful answer');
  assert.equal(doc.querySelector('textarea[name="cd"]').value, 'print(42)');
  const fu = r.results.find(function (x) { return x.questionNumber === 3; });
  assert.equal(fu.status, 'pause-only');
});
```
- [ ] 6. Run it and watch it FAIL: `node --test "tests/answer-applier.test.js"` → expect FAIL (no free_text/code/file_upload branches).
- [ ] 7. Minimal implementation in `lib/answer-applier.js`. Add these branches in `applyStructuredAnswers` before the `unsupported-type` fallback (after the dropdown branch):
```js
      if (item.type === 'free_text' || item.type === 'code') {
        const target = q.targets && q.targets[0];
        if (!target) { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'field not found' }); failed++; continue; }
        const val = String(item.value == null ? '' : item.value);
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

      if (item.type === 'file_upload') {
        // Never fabricate a file; signal the handler to pause for the user.
        results.push({ questionNumber: q.questionNumber, type: q.type, status: 'pause-only', reason: 'file-upload-needs-user' });
        continue;
      }
```
- [ ] 8. Run it and watch it PASS: `node --test "tests/answer-applier.test.js"` → expect PASS. Run `npm test` → expect all green.
- [ ] 9. Commit: `git add lib/answer-applier.js tests/answer-applier.test.js` then `git commit -m "feat(answer-applier): apply branches for dropdown/free_text/code/file_upload"`

---

### Task 6: Expand SUPPORTED_TYPES in ai-question-context so the snapshot keeps new types

**Files:**
- Modify: `lib/ai-question-context.js:11` (`SUPPORTED_TYPES`)
- Test: `tests/ai-question-context.test.js`

Steps:

- [ ] 1. Write the failing test (append to `tests/ai-question-context.test.js`). A dropdown + free_text page; assert `buildQuestionSnapshot` marks both `supported:true` and `sanitizeForRequest` keeps them:
```js
test('buildQuestionSnapshot: dropdown and free_text are supported and survive sanitize', () => {
  const j = new JSDOM('<!doctype html><html><body>' +
    '<div data-testid="cml-question-1"><div>Question 1</div><select><option>x</option><option>y</option></select></div>' +
    '<div data-testid="cml-question-2"><div>Question 2</div><textarea></textarea></div>' +
    '</body></html>', { url: 'https://www.coursera.org/learn/x/quiz/q/a' });
  const doc = j.window.document;
  const snap = buildQuestionSnapshot(doc.body, { origin: 'https://www.coursera.org', href: doc.defaultView.location.href }, doc);
  assert.equal(snap.questions.length, 2);
  assert.ok(snap.questions.every(function (q) { return q.supported === true; }));
  const clean = sanitizeForRequest(snap);
  assert.equal(clean.questions.length, 2);
});
```
(`const { buildQuestionSnapshot, sanitizeForRequest } = require('../lib/ai-question-context.js');` + `const { JSDOM } = require('jsdom');` at top — add if missing.)
- [ ] 2. Run it and watch it FAIL: `node --test "tests/ai-question-context.test.js"` → expect FAIL (`dropdown`/`free_text` are not in `SUPPORTED_TYPES`, so `supported` is false and `sanitizeForRequest` drops them → `clean.questions.length` is 0).
- [ ] 3. Minimal implementation in `lib/ai-question-context.js`. Replace L11:
```js
  var SUPPORTED_TYPES = { single_choice: true, multiple_choice: true, math_input: true };
```
with:
```js
  // Types the AI can answer in-page. code/file_upload are deliberately EXCLUDED:
  // code is best-effort handled in the handler (still pauses), file_upload always
  // pauses, so neither is sent to the model as an actionable answer slot.
  var SUPPORTED_TYPES = {
    single_choice: true, multiple_choice: true, math_input: true,
    numerical: true, input: true, dropdown: true, free_text: true,
  };
```
- [ ] 4. Run it and watch it PASS: `node --test "tests/ai-question-context.test.js"` → expect PASS. Run `npm test` → expect all green.
- [ ] 5. Commit: `git add lib/ai-question-context.js tests/ai-question-context.test.js` then `git commit -m "feat(ai-question-context): mark numeric/dropdown/free_text question types supported"`

---

### Task 7: Add `aiAnswerAssessments` to settings defaults + migration

**Files:**
- Modify: `lib/autopilot-state.js:35` (`defaults().settings`), `lib/autopilot-state.js:44-56` (`migrateSettings`)
- Test: `tests/autopilot-state.test.js`

Steps:

- [ ] 1. Write the failing test (append to `tests/autopilot-state.test.js`):
```js
test('defaults(): includes aiAnswerAssessments false and migration leaves it false', () => {
  const d = defaults();
  assert.equal(d.settings.aiAnswerAssessments, false);
  // Existing stored state without the field migrates to false (not undefined/true).
  const out = migrateSettings({ pauseOnUserInput: false, autoSubmitQuizzes: false, behaviorMode: 'fast', runScope: 'module' });
  const merged = Object.assign({}, defaults().settings, out.settings);
  assert.equal(merged.aiAnswerAssessments, false);
});
```
(`const { defaults, migrateSettings } = require('../lib/autopilot-state.js');` — confirm both are in the file's destructure at the top; add if missing.)
- [ ] 2. Run it and watch it FAIL: `node --test "tests/autopilot-state.test.js"` → expect FAIL (`d.settings.aiAnswerAssessments` is `undefined`, not `false`).
- [ ] 3. Minimal implementation in `lib/autopilot-state.js`. Replace L35:
```js
      settings: { pauseOnUserInput: false, autoSubmitQuizzes: false, behaviorMode: 'fast', runScope: 'module', settingsVersion: SETTINGS_VERSION },
```
with:
```js
      settings: { pauseOnUserInput: false, autoSubmitQuizzes: false, aiAnswerAssessments: false, behaviorMode: 'fast', runScope: 'module', settingsVersion: SETTINGS_VERSION },
```
No change needed in `migrateSettings` because the field defaults via `Object.assign({}, defaults().settings, raw)` in the authority merge; the test asserts the merge result is `false`. (Verify: the authority's `_settingsDefaults()` = `defaults().settings`, so the new field is supplied whenever raw omits it.)
- [ ] 4. Run it and watch it PASS: `node --test "tests/autopilot-state.test.js"` → expect PASS. Run `npm test` → expect all green.
- [ ] 5. Commit: `git add lib/autopilot-state.js tests/autopilot-state.test.js` then `git commit -m "feat(autopilot-state): add aiAnswerAssessments:false to settings defaults"`

---

### Task 8: Regression test — `aiAnswerAssessments` survives the authority activate/load round-trip

**Files:**
- Test only: `tests/autopilot-authority.test.js`

> **This is a pure regression test, not an implementation task.** The authority's activate merge already preserves any settings key: `_cmd_activateRun` at `lib/autopilot-authority.js:335` does `const mergedSettings = Object.assign({}, _settingsDefaults(), curSettings || {}, newState.settings);` (verified), and `_settingsDefaults()` returns `defaults().settings` — which gains `aiAnswerAssessments` in Task 7. So the field round-trips with NO authority code change. This task locks that guarantee with a test so a future settings-whitelist refactor cannot silently drop the field. (Depends on Task 7 being applied first.)

Steps:

- [ ] 1. Read the top of `tests/autopilot-authority.test.js` to mirror its EXACT existing conventions: how it constructs the authority (`createAuthority`/its messenger), its `fakeStorage()` helper, and its `handle`/callback (or messenger `send`) invocation shape. Use those verbatim — do NOT invent a `handle({command,...}, cb)` shape if the file uses a different one.
- [ ] 2. Write the regression test (append). Activate a run carrying `settings.aiAnswerAssessments:true`, load it back, assert it survives:
```js
test('activateRun preserves settings.aiAnswerAssessments through load', async () => {
  const storage = fakeStorage();
  const auth = createAuthority(storage, {});
  // NOTE: match this file's existing authority-invocation convention exactly
  // (handle vs send, response shape) — mirror a nearby activateRun/load test.
  await new Promise(function (resolve) {
    auth.handle({ command: 'activateRun', newState: { courseId: 'x', queue: [{ id: 'q1', kind: 'quiz', url: '/learn/x/quiz/q1/a' }], cursor: 0, ownerTabKey: 't1', runId: 'r1', settings: { pauseOnUserInput: false, autoSubmitQuizzes: false, aiAnswerAssessments: true, behaviorMode: 'fast', runScope: 'module' } } }, function () { resolve(); });
  });
  const loaded = await new Promise(function (resolve) { auth.handle({ command: 'load' }, function (res) { resolve(res); }); });
  const st = loaded && (loaded.state || loaded);
  assert.equal(st.settings.aiAnswerAssessments, true);
});
```
- [ ] 3. Run it: `node --test "tests/autopilot-authority.test.js"` → it should PASS immediately (the merge already preserves the field once Task 7 is in place). This is expected for a regression test guarding existing-correct behavior — no production change is needed or made in this task. If it FAILS, that means the activate path is dropping settings (a real bug to investigate before proceeding); otherwise leave the authority code untouched.
- [ ] 4. Run the full suite: `npm test` → expect all green.
- [ ] 5. Commit: `git add tests/autopilot-authority.test.js` then `git commit -m "test(autopilot-authority): assert aiAnswerAssessments survives activate/load round-trip"`

---

### Task 9: Add new answer/prompt/snapshot field names to autopilot-debug FORBIDDEN_KEYS

**Files:**
- Modify: `lib/autopilot-debug.js:93` (`FORBIDDEN_KEYS`)
- Test: `tests/autopilot-debug.test.js`

> **Redact ONLY AI-specific container keys.** Do NOT add the generic keys `value`, `options`, `label`, or `comment` to `FORBIDDEN_KEYS`: the existing suite legitimately emits and asserts them — `tests/autopilot-debug.test.js:154` records `details: { ..., value: 42 }` and asserts `assert.ok(/value=42/.test(out))` at L160, and `tests/autopilot-debug.test.js:178` records the VIDEO STATE event `video.duration.initial` with `details: { itemId: 'v6', value: null }` (consumed by the VIDEO STATE parser at L160-209). Redacting `value` strips both and turns the 1253-test suite red. The Task 11 handler only records `outcome`/`filled`/`reason`/`handler`/`itemId` via `rec()` — it never records raw `value`/`options`/`label` — so redacting those generic keys is both unnecessary and harmful. Add ONLY the AI-specific container keys: `prompt`, `snapshot`, `choiceText`, `choiceTexts`.

Steps:

- [ ] 1. Write the failing test (append to `tests/autopilot-debug.test.js`). Feed `formatDebugReport` a snapshot whose events carry the AI-specific sensitive fields and assert none of them appear in the output, while a benign `value` key (which existing events legitimately use) is NOT redacted. Mirror the existing redaction-assertion style and `snap` shape (the existing redaction test at L150 pushes an event into `snap.events` with a `details` object):
```js
test('formatDebugReport: redacts AI prompt/snapshot/choice fields but leaves generic value untouched', () => {
  const snap = { capturedAt: '2026-05-25T00:00:00.000Z', context: { status: 'running' }, events: [] };
  snap.events.push({ at: 't1', type: 'handler.outcome', details: {
    handler: 'assessment-ai',
    prompt: 'SECRET_PROMPT',
    snapshot: { questions: [{ prompt: 'SECRET_Q' }] },
    choiceText: 'SECRET_CHOICE',
    choiceTexts: ['SECRET_A', 'SECRET_B'],
    value: 42,
  } });
  const out = formatDebugReport(snap);
  ['SECRET_PROMPT', 'SECRET_Q', 'SECRET_CHOICE', 'SECRET_A', 'SECRET_B'].forEach(function (s) {
    assert.ok(out.indexOf(s) === -1, 'must redact ' + s);
  });
  // Generic keys that existing events legitimately emit are NOT redacted.
  assert.ok(/value=42/.test(out), 'generic value key must NOT be redacted (existing events rely on it)');
});
```
(`const { formatDebugReport } = require('../lib/autopilot-debug.js');` — confirm/add to the destructure at top; the existing redaction test at L150 already uses this shape.)
- [ ] 2. Run it and watch it FAIL: `node --test "tests/autopilot-debug.test.js"` → expect FAIL (`prompt`, `snapshot`, `choiceText`, `choiceTexts` are not in `FORBIDDEN_KEYS`, so they pass through and the SECRET assertions fire).
- [ ] 3. Minimal implementation in `lib/autopilot-debug.js`. Replace L93:
```js
  var FORBIDDEN_KEYS = ['answerText', 'pageBody', 'bodyText', 'pastedAnswer', 'quizOptions'];
```
with:
```js
  var FORBIDDEN_KEYS = [
    'answerText', 'pageBody', 'bodyText', 'pastedAnswer', 'quizOptions',
    // AI-assessment answer/prompt/snapshot payload fields (Phase C). ONLY the
    // AI-specific container keys are added here — NOT generic keys like `value`
    // or `options`, which existing debug events (e.g. video.duration.initial)
    // and their tests legitimately emit and assert.
    'prompt', 'snapshot', 'choiceText', 'choiceTexts',
  ];
```
- [ ] 4. Run it and watch it PASS: `node --test "tests/autopilot-debug.test.js"` → expect PASS, including the existing `value=42` (L160) and VIDEO STATE (L178 `value:null`) tests. Run `npm test` → expect all green.
- [ ] 5. Commit: `git add lib/autopilot-debug.js tests/autopilot-debug.test.js` then `git commit -m "feat(autopilot-debug): redact AI prompt/snapshot/choice fields in diagnostics"`

---

### Task 10: Register AI/skip outcome tokens with the correct pause-vs-advance semantics

**Files:**
- Modify: `lib/module-autopilot.js:71-82` (`isFailureOutcome`), `lib/module-autopilot.js:146-157` (`FAILURE_REASON_TEXT`)
- Test: `tests/module-autopilot.test.js`

> **CRITICAL semantics (do not get this backwards).** The run loop uses `isFailureOutcome(outcome) === true` as its PAUSE trigger at `lib/module-autopilot.js:1133` (verified) — a `true` return pauses the run for review; a `false` return falls through to `confirmer.waitForCompletion` (L1165) which ADVANCES to the next item. The existing fill-then-pause outcomes `quiz-filled-paused-for-review` (L77) and `assignment-agreement-accepted-paused` (L79) are deliberately listed in `isFailureOutcome` precisely SO THAT they pause.
>
> Therefore, to satisfy the spec's core rule "fills answers, then PAUSES for review — never auto-submits" (spec L18/L187), the AI pause outcomes MUST be failures:
> - `assessment-ai-answered-paused` → **failure (pause)**. It is a deliberate pause-for-review, exactly like `quiz-filled-paused-for-review`. If it returned `false`, the loop would advance and effectively auto-proceed past a filled-but-unsubmitted quiz — defeating the entire feature.
> - `assessment-ai-no-answer` → **failure (pause)**. Per the spec error-handling table (L264): toggle-on-but-no-key / no mappable answer → pause for review.
> - `assessment-skipped-lti` / `assessment-skipped-programming` → **non-failure**. These must SKIP-and-CONTINUE per the spec ("Skip + continue; log reason", L266). They are NOT routed through the failure/pause path; Task 12 adds an explicit skip-advance branch in `runCurrentItem` that logs the reason and advances the cursor. Keeping them out of `isFailureOutcome` is what lets that skip-advance branch handle them instead of pausing.

Steps:

- [ ] 1. Write the failing test (append to `tests/module-autopilot.test.js`). Import `isFailureOutcome` — it is not exported today, so this task also exports it. Assert the AI pause tokens ARE failures (so the loop pauses), the skip tokens are NOT (so the loop can advance/skip them), and legacy tokens are unchanged:
```js
test('isFailureOutcome: AI pause tokens pause; skip tokens advance; legacy tokens unchanged', () => {
  const { isFailureOutcome } = require('../lib/module-autopilot.js');
  // AI fill/no-answer outcomes are deliberate pauses-for-review (MUST be failures so the loop pauses):
  assert.equal(isFailureOutcome({ outcome: 'assessment-ai-answered-paused' }), true, 'AI-answered must PAUSE for review');
  assert.equal(isFailureOutcome({ outcome: 'assessment-ai-no-answer' }), true, 'no-AI-answer must PAUSE for review');
  // Skip outcomes are skip-and-continue (NOT failures; the loop advances past them via Task 12's skip branch):
  assert.equal(isFailureOutcome({ outcome: 'assessment-skipped-lti' }), false, 'LTI skip must NOT pause');
  assert.equal(isFailureOutcome({ outcome: 'assessment-skipped-programming' }), false, 'programming skip must NOT pause');
  // Legacy behavior preserved:
  assert.equal(isFailureOutcome({ outcome: 'assignment-agreement-accepted-paused' }), true);
  assert.equal(isFailureOutcome({ outcome: 'quiz-filled-paused-for-review' }), true);
  assert.equal(isFailureOutcome({ outcome: 'pause-needed-no-answer' }), true);
});
```
- [ ] 2. Run it and watch it FAIL: `node --test "tests/module-autopilot.test.js"` → expect FAIL on import first (`isFailureOutcome` is `undefined` — not exported yet); after exporting it (step 3a) but before adding the two `return true` lines (step 3b), the two AI-pause assertions FAIL because the default-`false` return treats them as non-failures.
- [ ] 3. Minimal implementation in `lib/module-autopilot.js`:
  - (a) Export `isFailureOutcome` by adding `isFailureOutcome: isFailureOutcome,` to the `api` object literal (the one near L2115 that already exports `createAutopilot`, `generateTabKey`).
  - (b) Add the two AI-pause tokens to `isFailureOutcome` so they PAUSE. Insert immediately after the existing `if (o.outcome === 'assignment-agreement-accepted-paused') return true;` line (L79), before the `if (o.outcome === 'assignment-no-action') return true;` line:
```js
    if (o.outcome === 'assessment-ai-answered-paused') return true;
    if (o.outcome === 'assessment-ai-no-answer') return true;
```
  (Leave the skip tokens OUT of `isFailureOutcome` — the default-`false` return keeps them non-failures so Task 12's skip-advance branch handles them.)
  - (c) Add user-facing phrases for the AI pause tokens to `FAILURE_REASON_TEXT` (after the `'assignment-no-action': ...` entry at L156, before the closing `}`):
```js
    'assessment-ai-answered-paused': 'AI filled the answers — review and submit, then Resume',
    'assessment-ai-no-answer': 'no AI answer produced — configure an AI API Key (Manage AI API Key) or answer manually',
```
  (The skip tokens are surfaced as run-log lines by Task 12, not via `FAILURE_REASON_TEXT`, because they never reach the pause-reason banner.)
- [ ] 4. Run it and watch it PASS: `node --test "tests/module-autopilot.test.js"` → expect PASS. Run `npm test` → expect all green.
- [ ] 5. Commit: `git add lib/module-autopilot.js tests/module-autopilot.test.js` then `git commit -m "feat(module-autopilot): export isFailureOutcome; AI fill/no-answer pause, skips advance"`

---

### Task 11: assessmentAi handler in item-handlers (build snapshot → validate → apply → pause)

**Files:**
- Modify: `lib/item-handlers.js` — DI dep resolution near the top of `createHandlers` (after the `rec`/`waitForElement` helpers, ~L96), a `_suggestionsToStructured` helper + the `assessmentAi` handler placed before the returned map, the `fallback` applier reference (L516), and the returned handler map (L556-563, after `assignment: assignment,`).
- Test: `tests/item-handlers.test.js`

> **Human-mode timing — documented v1 reduction.** The spec (L188) describes "randomized inter-field and pre-pause dwell" for Human mode. This handler implements a SINGLE randomized pre-fill dwell via the existing `timing.quizDwellMs(rng)` (verified exported in `lib/autopilot-timing.js:74`); it does NOT add per-field jitter between each applied answer (the applier fills fields in a tight loop). This is an intentional v1 reduction — the fill-then-pause guarantee and key-gating are unaffected, and per-field jitter only matters cosmetically since the run pauses before any submission. A follow-up may add inter-field dwell by threading a timing callback into `applyStructuredAnswers`.

Steps:

- [ ] 1. Write the failing test (append to `tests/item-handlers.test.js`). It injects a fake `aiGenerate` returning a typed-answer `raw` and a fake `courseraDom`/`questionContext`/`validator`/`answerApplier` chain; asserts the answer is applied and the outcome is `assessment-ai-answered-paused` (NOT submitted). Use the real modules where convenient but stub `aiGenerate`:
```js
test('assessmentAi handler: builds snapshot, applies AI answers, pauses (no submit)', async () => {
  const doc = makeFakeDoc(
    '<div id="assessment-region">' +
      '<div data-testid="cml-question-1"><div>Question 1</div><fieldset>' +
        '<label><input type="radio" name="q1"> Alpha</label>' +
        '<label><input type="radio" name="q1"> Beta</label>' +
      '</fieldset></div>' +
    '</div>',
    'https://www.coursera.org/learn/x/quiz/q1/a'
  );
  const region = doc.getElementById('assessment-region');
  const courseraDom = {
    isExternalLaunchPage: function () { return false; },
    assessmentRoot: function () { return region; },
    isExcludedNode: function () { return false; },
  };
  const questionContext = require('../lib/ai-question-context.js');
  const validator = require('../lib/ai-answer-validator.js');
  const permissive = require('../lib/ai-answer-permissive.js');
  const answerApplier = require('../lib/answer-applier.js');
  // AI returns a strict-JSON answer selecting "Beta" for q1.
  const aiGenerate = function (snapshot) {
    return Promise.resolve({ ok: true, raw: JSON.stringify({ answers: [{ question_id: 'q1', answer: { value: 'Beta' } }] }) });
  };
  const handlers = createHandlers({
    sleep: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    answerApplier: answerApplier,
    questionContext: questionContext,
    validator: validator,
    permissive: permissive,
    courseraDom: courseraDom,
  });
  let submitted = false;
  doc.querySelectorAll('button[type="submit"]').forEach(function (b) { b.click = function () { submitted = true; }; });
  const out = await handlers.assessmentAi({
    doc: doc, item: { id: 'q1', kind: 'quiz' }, rng: seededRng(1), signal: mkSignal(),
    behaviorMode: 'fast', aiGenerate: aiGenerate,
    location: { origin: 'https://www.coursera.org', href: 'https://www.coursera.org/learn/x/quiz/q1/a' },
  });
  const checked = doc.querySelectorAll('input[name="q1"]:checked');
  assert.equal(checked.length, 1, 'one radio must be checked');
  assert.equal(checked[0].parentElement.textContent.trim(), 'Beta');
  assert.equal(out.outcome, 'assessment-ai-answered-paused');
  assert.equal(submitted, false, 'must NEVER auto-submit');
});
```
- [ ] 2. Run it and watch it FAIL: `node --test "tests/item-handlers.test.js"` → expect FAIL (`handlers.assessmentAi` is `undefined`).
- [ ] 3. Minimal implementation in `lib/item-handlers.js`. Inside `createHandlers`, resolve the new DI deps near the top of the function (after the existing `pageFallback`/`debugRecorder` lines around L90-91):
```js
    const answerApplier = (deps && deps.answerApplier) || null;
    const questionContext = (deps && deps.questionContext) || (root.ClipboardCleaner && root.ClipboardCleaner.aiQuestionContext) || null;
    const aiValidator = (deps && deps.validator) || (root.ClipboardCleaner && root.ClipboardCleaner.aiAnswerValidator) || null;
    const aiPermissive = (deps && deps.permissive) || (root.ClipboardCleaner && root.ClipboardCleaner.aiAnswerPermissive) || null;
    const courseraDom = (deps && deps.courseraDom) || (root.ClipboardCleaner && root.ClipboardCleaner.courseraDom) || null;
```
(Note: `deps.answerApplier` is already read at L516 inside `fallback`; keep that working by referencing the same `answerApplier` const there instead of `deps.answerApplier` — change L516 `const applier = deps && deps.answerApplier;` to `const applier = answerApplier;`.)
Add a helper that maps validator suggestions to the `applyStructuredAnswers` item shape, then the handler. Place both just before the `return { reading: ... }` map (after `assignment`):
```js
    function _suggestionsToStructured(suggestions) {
      const out = [];
      for (let i = 0; i < (suggestions || []).length; i++) {
        const s = suggestions[i];
        if (!s || s.applicable === false) continue;
        if (typeof s.questionNumber !== 'number') continue;
        const itm = { questionNumber: s.questionNumber, type: s.type };
        if (s.type === 'single_choice') itm.choiceText = s.choiceText;
        else if (s.type === 'multiple_choice') itm.choiceTexts = s.choiceTexts || [];
        else itm.value = s.value;
        out.push(itm);
      }
      return out;
    }

    async function assessmentAi(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const location = ctx.location || (doc && doc.defaultView && doc.defaultView.location) || { origin: '', href: '' };
      const aiGenerate = ctx.aiGenerate;
      rec('handler.start', { handler: 'assessment-ai', itemId: ctx.item && ctx.item.id });
      if (typeof aiGenerate !== 'function' || !questionContext || !answerApplier) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-answer', reason: 'no-ai-bridge' });
        return { outcome: 'assessment-ai-no-answer' };
      }
      // 1. Refuse external launches (LTI / Launch App) and route to skip.
      if (courseraDom && typeof courseraDom.isExternalLaunchPage === 'function' && courseraDom.isExternalLaunchPage(doc, location.href)) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-skipped-lti' });
        return { outcome: 'assessment-skipped-lti' };
      }
      // 2. Scope to the assessment region (excludes nav/extension/chat via Phase A).
      const region = (courseraDom && typeof courseraDom.assessmentRoot === 'function' && courseraDom.assessmentRoot(doc)) || doc.body;
      const snapshot = questionContext.buildQuestionSnapshot(region, location, doc);
      if (!snapshot || (snapshot.actionableCount || 0) === 0) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-answer', reason: 'no-actionable-questions' });
        return { outcome: 'assessment-ai-no-answer' };
      }
      const sanitized = questionContext.sanitizeForRequest(snapshot);
      // 3. Ask the background AI (key read server-side). Errors → recoverable pause.
      let res;
      try {
        res = await aiGenerate(sanitized);
      } catch (e) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-answer', reason: 'generate-error' });
        return { outcome: 'assessment-ai-no-answer' };
      }
      if (!res || res.ok !== true || !res.raw) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-answer', reason: 'no-raw' });
        return { outcome: 'assessment-ai-no-answer' };
      }
      // 4. Validate → permissive → raw fallback (same chain as the manual path).
      let structured = [];
      if (aiValidator && typeof aiValidator.validateAndMap === 'function') {
        const v = aiValidator.validateAndMap(res.raw, snapshot, { expectedToken: snapshot.token });
        if (v && v.ok) structured = _suggestionsToStructured(v.suggestions);
      }
      if (structured.length === 0 && aiPermissive && typeof aiPermissive.extract === 'function') {
        const p = aiPermissive.extract(res.raw, snapshot);
        if (p && p.suggestions) structured = _suggestionsToStructured(p.suggestions);
      }
      if (structured.length === 0) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-answer', reason: 'no-mappable-answers' });
        return { outcome: 'assessment-ai-no-answer' };
      }
      // 5. Human-mode pre-fill dwell. v1 reduction (see note below): a single
      // randomized pre-fill dwell via timing.quizDwellMs, NOT per-field jitter.
      if (ctx.behaviorMode === 'human' && timing && typeof timing.quizDwellMs === 'function') {
        await sleep(timing.quizDwellMs(rng), signal);
      }
      // 6. Apply typed answers, scoped to the region.
      const summary = answerApplier.applyStructuredAnswers(structured, region, { verbose: false }) || { summary: { filled: 0 } };
      const filled = (summary.summary && summary.summary.filled) || 0;
      // 7. ALWAYS pause for review — never auto-submit (ignores autoSubmitQuizzes).
      rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-answered-paused', filled: filled });
      return { outcome: 'assessment-ai-answered-paused', filled: filled };
    }
```
Then add `assessmentAi: assessmentAi,` to the returned handler map (after `assignment: assignment,`).
- [ ] 4. Run it and watch it PASS: `node --test "tests/item-handlers.test.js"` → expect PASS. Run `npm test` → expect all green (the `fallback` L516 change is behavior-preserving since `answerApplier === deps.answerApplier`).
- [ ] 5. Write a second failing test for the no-key / error paths (append):
```js
test('assessmentAi handler: missing aiGenerate yields assessment-ai-no-answer; generate error pauses', async () => {
  const doc = makeFakeDoc('<div data-testid="cml-question-1"><div>Question 1</div><fieldset><label><input type="radio" name="q1"> A</label><label><input type="radio" name="q1"> B</label></fieldset></div>', 'https://www.coursera.org/learn/x/quiz/q1/a');
  const handlers = createHandlers({
    sleep: function () { return Promise.resolve(); }, timing: require('../lib/autopilot-timing.js'),
    answerApplier: require('../lib/answer-applier.js'), questionContext: require('../lib/ai-question-context.js'),
    validator: require('../lib/ai-answer-validator.js'), permissive: require('../lib/ai-answer-permissive.js'),
    courseraDom: { isExternalLaunchPage: function () { return false; }, assessmentRoot: function (d) { return d.body; }, isExcludedNode: function () { return false; } },
  });
  const noKey = await handlers.assessmentAi({ doc: doc, item: { id: 'q1', kind: 'quiz' }, rng: seededRng(1), signal: mkSignal(), behaviorMode: 'fast', location: { origin: 'https://www.coursera.org', href: 'https://www.coursera.org/learn/x/quiz/q1/a' } });
  assert.equal(noKey.outcome, 'assessment-ai-no-answer');
  const errd = await handlers.assessmentAi({ doc: doc, item: { id: 'q1', kind: 'quiz' }, rng: seededRng(1), signal: mkSignal(), behaviorMode: 'fast', aiGenerate: function () { return Promise.reject(new Error('worker-evicted')); }, location: { origin: 'https://www.coursera.org', href: 'https://www.coursera.org/learn/x/quiz/q1/a' } });
  assert.equal(errd.outcome, 'assessment-ai-no-answer');
});
```
- [ ] 6. Run it and watch it PASS: `node --test "tests/item-handlers.test.js"` → expect PASS (the handler's `typeof aiGenerate !== 'function'` and try/catch branches already cover these; if it FAILS, the branch ordering must be corrected so the no-bridge guard runs before any aiGenerate call — adjust then re-run).
- [ ] 7. Write a third failing test for the LTI-skip branch (append):
```js
test('assessmentAi handler: external launch page yields assessment-skipped-lti', async () => {
  const doc = makeFakeDoc('<form role="form"><button>Launch App</button></form>', 'https://www.coursera.org/learn/x/gradedLti/g1/a');
  const handlers = createHandlers({
    sleep: function () { return Promise.resolve(); }, timing: require('../lib/autopilot-timing.js'),
    answerApplier: require('../lib/answer-applier.js'), questionContext: require('../lib/ai-question-context.js'),
    courseraDom: { isExternalLaunchPage: function () { return true; }, assessmentRoot: function (d) { return d.body; }, isExcludedNode: function () { return false; } },
  });
  const out = await handlers.assessmentAi({ doc: doc, item: { id: 'g1', kind: 'assignment' }, rng: seededRng(1), signal: mkSignal(), behaviorMode: 'fast', aiGenerate: function () { return Promise.resolve({ ok: true, raw: '{}' }); }, location: { origin: 'https://www.coursera.org', href: 'https://www.coursera.org/learn/x/gradedLti/g1/a' } });
  assert.equal(out.outcome, 'assessment-skipped-lti');
});
```
- [ ] 8. Run it and watch it PASS: `node --test "tests/item-handlers.test.js"` → expect PASS. Run `npm test` → expect all green.
- [ ] 9. Commit: `git add lib/item-handlers.js tests/item-handlers.test.js` then `git commit -m "feat(item-handlers): assessmentAi handler — snapshot, validate, apply, pause (never submit)"`

---

### Task 12: Controller un-block gating + AI/skip routing + ctx.aiGenerate + run-log lines

**Files:**
- Modify: `lib/module-autopilot.js` — `buildOrderedQueue` (signature + blocked branch, L97-125; export in `api`), the two queue-build call sites (`_doStart` L611-612, `_doStartAllModules` L825-826) to load + pass settings, the run-loop handler selection (L1072), the `ctx` object (L1081-1091), a skip-advance branch + AI-answered run-log line around the handler-outcome handling (L1092-1155), the confirmer guard (L1165), and the success-path `✓` log gate (L1469-1471).
- Test: `tests/module-autopilot.test.js`

Steps:

- [ ] 1. Write the failing test for un-block gating (append to `tests/module-autopilot.test.js`). `buildOrderedQueue` must un-block answerable assessments only when the toggle is on. Since `buildOrderedQueue` is not exported, this task exports it. Test:
```js
test('buildOrderedQueue: un-blocks answerable assessments only when aiAnswerAssessments is on', () => {
  const { buildOrderedQueue } = require('../lib/module-autopilot.js');
  const scraperMod = require('../lib/module-scraper.js');
  const rawItems = [
    { id: 'q1', kind: 'quiz', url: '/learn/x/quiz/q1/a', title: 'Quiz One' },
    { id: 'p1', kind: 'programming', url: '/learn/x/programming/p1/a', title: 'Lab One' },
  ];
  // Toggle OFF: both blocked (today's behavior, preserved).
  const off = buildOrderedQueue(scraperMod, rawItems, null, { aiAnswerAssessments: false });
  assert.ok(off.queue[0].blocked === true, 'quiz blocked when toggle off');
  // Toggle ON: quiz un-blocked + tagged for AI; programming stays blocked.
  const on = buildOrderedQueue(scraperMod, rawItems, null, { aiAnswerAssessments: true });
  const q = on.queue.find(function (it) { return it.id === 'q1'; });
  const p = on.queue.find(function (it) { return it.id === 'p1'; });
  assert.ok(q && !q.blocked, 'quiz un-blocked when toggle on');
  assert.equal(q.aiAnswerable, true);
  assert.ok(p && p.blocked, 'programming stays blocked even when toggle on');
});
```
- [ ] 2. Run it and watch it FAIL: `node --test "tests/module-autopilot.test.js"` → expect FAIL (`buildOrderedQueue` is not exported; and it currently ignores a 4th `settings` arg).
- [ ] 3. Minimal implementation in `lib/module-autopilot.js`. Add a small classifier of which blocked kinds are AI-answerable vs hard-skip, then make `buildOrderedQueue` accept a `settings` arg. Add above `buildOrderedQueue`:
```js
  // Hard-skip kinds the AI can never answer in-page (external launch + programming).
  const AI_HARD_SKIP_KINDS = { programming: true, assignment: true };
  function _isHardSkipBlock(item) {
    const kind = (item && item.kind || '').toLowerCase();
    const url = (item && item.url) || '';
    if (AI_HARD_SKIP_KINDS[kind]) return true;
    if (/\/gradedLti\//i.test(url) || /\/programming\//i.test(url) || /\/assignment-submission\//i.test(url)) return true;
    return false;
  }
```
(Note: `assignment` kind here maps to the gradedLti external-launch family per module-scraper `KIND_BY_SEGMENT.gradedLti = 'assignment'`; the in-page graded `quiz`/`exam` items are kind `quiz` and ARE answerable. Body-shape answerability is finalized in the handler via `coursera-dom.isExternalLaunchPage`; the queue only pre-classifies.) Change the `buildOrderedQueue` signature and blocked branch:
```js
  function buildOrderedQueue(scraperMod, rawItems, currentItemId) {
```
to:
```js
  function buildOrderedQueue(scraperMod, rawItems, currentItemId, settings) {
    const aiOn = !!(settings && settings.aiAnswerAssessments);
```
and replace the blocked push:
```js
      if (scraperMod.isBlockedAssessmentItem && scraperMod.isBlockedAssessmentItem(it)) {
        ordered.push(Object.assign({}, it, { blocked: true, blockReason: blockReasonLabel(it) }));
      } else {
        ordered.push(it);
      }
```
with:
```js
      const isBlocked = scraperMod.isBlockedAssessmentItem && scraperMod.isBlockedAssessmentItem(it);
      if (isBlocked) {
        // When the AI toggle is ON, un-block answerable assessments (quiz/exam)
        // and tag them for the AI handler; hard-skip kinds (programming, external
        // launch) stay blocked. Peer-review stays blocked in Phase C (Phase D).
        const peerReview = (it.kind === 'peer-review') || /\/peer\//i.test(it.url || '');
        if (aiOn && !_isHardSkipBlock(it) && !peerReview && (it.kind === 'quiz' || /\/quiz\//i.test(it.url || '') || /\/exam\//i.test(it.url || ''))) {
          ordered.push(Object.assign({}, it, { aiAnswerable: true }));
        } else {
          ordered.push(Object.assign({}, it, { blocked: true, blockReason: blockReasonLabel(it) }));
        }
      } else {
        ordered.push(it);
      }
```
Export `buildOrderedQueue` by adding `buildOrderedQueue: buildOrderedQueue,` to the `api` object literal.
- [ ] 4. Run it and watch it PASS: `node --test "tests/module-autopilot.test.js"` → expect PASS.
- [ ] 5. Update the two `buildOrderedQueue` call sites to pass effective settings.
  > **IMPORTANT — there is NO `stateNow`/`cur` variable in scope at these call sites (verified).** `_doStart` builds the queue at L611-612 BEFORE `activateRun` (L644), and never loads settings on this path; `_doStartAllModules` builds at L825-826 likewise. The settings live only in the authority. So you must explicitly LOAD them via `state.load` (which returns the merged state including `.settings`, with `aiAnswerAssessments` supplied by Task 7's default) immediately before each `buildOrderedQueue` call.

  (a) In `_doStart`, the existing lines (L611-612) are:
```js
      const currentItemId = scraperMod.extractItemId(currentUrl());
      const built = buildOrderedQueue(scraperMod, scraped.items, currentItemId);
```
  Change to:
```js
      const currentItemId = scraperMod.extractItemId(currentUrl());
      // Load effective settings from the authority so the AI un-block gate sees
      // the user's toggle on a fresh start (settings are NOT in scope here; the
      // queue is built before activateRun). state.load returns null on
      // authority-unavailable → fall back to {} (gate off).
      const _settingsForGate = await new Promise(function (resolve) {
        state.load(function (s) { resolve((s && s.settings) || {}); });
      });
      const built = buildOrderedQueue(scraperMod, scraped.items, currentItemId, _settingsForGate);
```
  (b) In `_doStartAllModules`, the existing lines (L825-826) are:
```js
      const currentItemId = scraperMod.extractItemId(currentUrl());
      const built = buildOrderedQueue(scraperMod, flat, currentItemId);
```
  Change to:
```js
      const currentItemId = scraperMod.extractItemId(currentUrl());
      const _settingsForGate = await new Promise(function (resolve) {
        state.load(function (s) { resolve((s && s.settings) || {}); });
      });
      const built = buildOrderedQueue(scraperMod, flat, currentItemId, _settingsForGate);
```
  Run `npm test` → expect all green (default settings have `aiAnswerAssessments:false`, so existing queue tests are unchanged).
- [ ] 5a. Write the failing FRESH-START gating test (append) — this is the test the verification flagged as missing. It drives the `start()`/`_doStart` path (NOT `bootIfRunning`), with the toggle persisted in the authority's settings BEFORE start, and asserts the activated queue un-blocks the quiz as `aiAnswerable`. Because the fake `storage` is what `state.load` reads through the authority/messenger, seed the settings into storage first, then call `start()`:
```js
test('start/_doStart: a freshly started run with the AI toggle ON un-blocks an answerable quiz', async () => {
  const QUIZ_HTML =
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/x/quiz/q1/intro-quiz">Quiz One</a>' +
    '</div>';
  const j = makePage(QUIZ_HTML, 'https://www.coursera.org/learn/x/home/week/1');
  const storage = fakeStorage();
  // Persist the toggle BEFORE start so state.load (read on the _doStart path)
  // sees aiAnswerAssessments:true. The in-process authority's load falls back to
  // runRaw.settings when SETTINGS_KEY is absent (verified: autopilot-authority
  // _cmd_load L139 legacyCandidate), and migrateSettings preserves the field, so
  // seeding RUN_KEY.settings is sufficient. (Status stays 'idle'/runId null so
  // activateRun is allowed to proceed on start.)
  const seed = stateMod.defaults();
  seed.settings.aiAnswerAssessments = true;
  await new Promise(function (r) { storage.set({ [stateMod.RUN_KEY]: seed }, r); });
  const handlers = mkFakeHandlers();
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function () { return Promise.resolve(); },
    aiGenerate: function () { return Promise.resolve({ ok: true, raw: '{"answers":[]}' }); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.start();
  const got = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  const q = (got.queue || []).find(function (it) { return it.id === 'q1'; });
  assert.ok(q, 'quiz must be present in the activated queue');
  assert.ok(!q.blocked, 'quiz must be un-blocked on a fresh start with the toggle on');
  assert.equal(q.aiAnswerable, true, 'quiz must be tagged aiAnswerable on the _doStart path');
});
```
  > **Load-bearing point:** this test drives `start()` → `_doStart` (NOT `bootIfRunning`), exercising the path the verification flagged as untested. If `_doStart` does not load settings before `buildOrderedQueue` (step 5 not yet applied), the gate is off and the quiz stays `blocked` — so this test catches the broken fresh-start flow that the `bootIfRunning`-only tests miss.
- [ ] 5b. Run 5a and watch it FAIL before step 5's `state.load` wiring is added (the queue builds with no settings → `aiAnswerable` is undefined and the quiz stays `blocked`), and PASS after: `node --test "tests/module-autopilot.test.js"` → expect PASS once `_doStart` loads settings.
- [ ] 6. Write the failing routing + ctx test (append). Extend `mkFakeHandlers` to record an `assessmentAi` call, run an answerable quiz with the toggle on, and assert the AI handler ran and `ctx.aiGenerate` was provided. First, augment the local `mkFakeHandlers` (or define an inline handlers object in this test) to include `assessmentAi`:
```js
test('runCurrentItem: routes an aiAnswerable quiz to the assessmentAi handler with ctx.aiGenerate', async () => {
  const QUIZ_HTML =
    '<div data-testid="lesson-collection">' +
      '<a href="/learn/x/quiz/q1/intro-quiz">Quiz One</a>' +
    '</div>';
  const j = makePage(QUIZ_HTML, 'https://www.coursera.org/learn/x/quiz/q1/intro-quiz');
  const storage = fakeStorage();
  const calls = [];
  let sawAiGenerate = false;
  const handlers = {
    video: function () { return Promise.resolve({ outcome: 'video-done' }); },
    reading: function () { return Promise.resolve({ outcome: 'reading-done' }); },
    discussion: function () { return Promise.resolve({ outcome: 'discussion-posted' }); },
    fallback: function (ctx) { calls.push('fallback'); return Promise.resolve({ outcome: 'quiz-filled-paused-for-review' }); },
    assessmentAi: function (ctx) { calls.push('assessmentAi'); sawAiGenerate = (typeof ctx.aiGenerate === 'function'); return Promise.resolve({ outcome: 'assessment-ai-answered-paused' }); },
  };
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function () { return Promise.resolve(); },
    aiGenerate: function () { return Promise.resolve({ ok: true, raw: '{"answers":[]}' }); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  // Seed running state with an aiAnswerable quiz so handlerForKind routes to assessmentAi.
  const d = stateMod.defaults();
  d.status = 'running'; d.courseId = 'x'; d.ownerTabKey = 'tab-1'; d.runId = 'r1';
  d.settings.aiAnswerAssessments = true;
  d.queue = [{ id: 'q1', kind: 'quiz', url: '/learn/x/quiz/q1/intro-quiz', title: 'Quiz One', aiAnswerable: true }];
  d.cursor = 0;
  await new Promise(function (r) { storage.set({ [stateMod.RUN_KEY]: d }, r); });
  await ap.bootIfRunning();
  assert.ok(calls.indexOf('assessmentAi') !== -1, 'assessmentAi handler must run for an aiAnswerable quiz');
  assert.equal(sawAiGenerate, true, 'ctx.aiGenerate must be provided');
});
```
- [ ] 7. Run it and watch it FAIL: `node --test "tests/module-autopilot.test.js"` → expect FAIL (`handlerForKind('quiz')` returns `handlers.fallback`, and `ctx.aiGenerate` is undefined).
- [ ] 8. Minimal implementation in `lib/module-autopilot.js`. (a) Accept and store `aiGenerate` in `createAutopilot`: near the other `opts.*` reads (around L210), add `const aiGenerate = (typeof opts.aiGenerate === 'function') ? opts.aiGenerate : null;`. (b) Route in `handlerForKind` — but routing depends on the ITEM, not just kind, so change the call rather than the function. In `runCurrentItem`, where `const handler = handlerForKind(item.kind);` appears (L1072), replace with:
```js
          const handler = (item.aiAnswerable && handlers.assessmentAi)
            ? handlers.assessmentAi
            : handlerForKind(item.kind);
```
(c) Add `aiGenerate` and `location` to the `ctx` object (L1081-1091), after `getLastCleanedCopy`:
```js
              aiGenerate: aiGenerate || function () { return Promise.resolve({ ok: false, reason: 'no-ai-bridge' }); },
              location: (win && win.location) || { origin: '', href: '' },
              aiAnswerAssessments: !!(stateNow.settings && stateNow.settings.aiAnswerAssessments),
```
- [ ] 9. Run it and watch it PASS: `node --test "tests/module-autopilot.test.js"` → expect PASS. Run `npm test` → expect all green.
- [ ] 9a. Write the failing run-log + skip-advance test (append). This covers two spec-mandated transparency lines (spec L238-239): the AI-answered "paused for review" line (with filled count) when the handler pauses, and the per-skip reason line when the handler skips. Use an inline handlers object whose `assessmentAi` returns a skip outcome for one item and an answered-paused outcome for another; capture the sidebar log:
```js
test('runCurrentItem: AI-answered pause logs filled count + "paused for review"; LTI skip logs reason and advances', async () => {
  // --- Part 1: answered → pause → run-log line with count ---
  const j1 = makePage('<div data-testid="lesson-collection"><a href="/learn/x/quiz/q1/intro-quiz">Quiz One</a></div>', 'https://www.coursera.org/learn/x/quiz/q1/intro-quiz');
  const storage1 = fakeStorage();
  const logs1 = [];
  const handlers1 = {
    video: function () { return Promise.resolve({ outcome: 'video-done' }); },
    reading: function () { return Promise.resolve({ outcome: 'reading-done' }); },
    discussion: function () { return Promise.resolve({ outcome: 'discussion-posted' }); },
    fallback: function () { return Promise.resolve({ outcome: 'quiz-filled-paused-for-review' }); },
    assessmentAi: function () { return Promise.resolve({ outcome: 'assessment-ai-answered-paused', filled: 3 }); },
  };
  let paused1 = false;
  const ap1 = createAutopilot({
    document: j1.window.document, window: j1.window, storage: storage1, handlers: handlers1,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function () { return Promise.resolve(); },
    aiGenerate: function () { return Promise.resolve({ ok: true, raw: '{}' }); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function (s) { logs1.push(s); }, setAutopilotPaused: function () { paused1 = true; }, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  const d1 = stateMod.defaults();
  d1.status = 'running'; d1.courseId = 'x'; d1.ownerTabKey = 'tab-1'; d1.runId = 'r1';
  d1.settings.aiAnswerAssessments = true;
  d1.queue = [{ id: 'q1', kind: 'quiz', url: '/learn/x/quiz/q1/intro-quiz', title: 'Quiz One', aiAnswerable: true }];
  d1.cursor = 0;
  await new Promise(function (r) { storage1.set({ [stateMod.RUN_KEY]: d1 }, r); });
  await ap1.bootIfRunning();
  assert.equal(paused1, true, 'AI-answered outcome must PAUSE the run');
  assert.ok(logs1.some(function (s) { return /AI/i.test(s) && /3/.test(s) && /paused for review/i.test(s); }),
    'must log a run line with the filled count (3) and "paused for review"');

  // --- Part 2: LTI skip → log reason → advance (do not pause) ---
  const j2 = makePage('<div data-testid="lesson-collection"><a href="/learn/x/gradedLti/g1/launch">Graded App</a><a href="/learn/x/lecture/v2/two">Lecture Two</a></div>', 'https://www.coursera.org/learn/x/gradedLti/g1/launch');
  const storage2 = fakeStorage();
  const logs2 = [];
  let paused2 = false;
  const handlers2 = {
    video: function () { return Promise.resolve({ outcome: 'video-done' }); },
    reading: function () { return Promise.resolve({ outcome: 'reading-done' }); },
    discussion: function () { return Promise.resolve({ outcome: 'discussion-posted' }); },
    fallback: function () { return Promise.resolve({ outcome: 'quiz-filled-paused-for-review' }); },
    assessmentAi: function () { return Promise.resolve({ outcome: 'assessment-skipped-lti' }); },
  };
  const ap2 = createAutopilot({
    document: j2.window.document, window: j2.window, storage: storage2, handlers: handlers2,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function () { return Promise.resolve(); },
    aiGenerate: function () { return Promise.resolve({ ok: true, raw: '{}' }); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function (s) { logs2.push(s); }, setAutopilotPaused: function () { paused2 = true; }, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  const d2 = stateMod.defaults();
  d2.status = 'running'; d2.courseId = 'x'; d2.ownerTabKey = 'tab-1'; d2.runId = 'r1';
  d2.settings.aiAnswerAssessments = true;
  d2.queue = [
    { id: 'g1', kind: 'quiz', url: '/learn/x/gradedLti/g1/launch', title: 'Graded App', aiAnswerable: true },
    { id: 'v2', kind: 'video', url: '/learn/x/lecture/v2/two', title: 'Lecture Two' },
  ];
  d2.cursor = 0;
  await new Promise(function (r) { storage2.set({ [stateMod.RUN_KEY]: d2 }, r); });
  await ap2.bootIfRunning();
  assert.equal(paused2, false, 'a skip outcome must NOT pause the run');
  assert.ok(logs2.some(function (s) { return /skip/i.test(s) && /(lti|external|app)/i.test(s); }),
    'must log a skip line with the LTI/external reason');
});
```
- [ ] 9b. Run it and watch it FAIL: `node --test "tests/module-autopilot.test.js"` → expect FAIL (no run-log line for the AI-answered pause; and the skip outcome is currently a non-failure that falls through to the confirmer, neither logging a skip reason nor cleanly advancing).
- [ ] 9c. Minimal implementation in `lib/module-autopilot.js` `runCurrentItem`. Two additions around the handler-outcome handling (the handler returns into `outcome`):
  (i) **Skip-advance branch** — immediately AFTER `outcome = await handler(ctx);` resolves and the abort/error guards (the `catch` block ends ~L1132), and BEFORE the `if (isFailureOutcome(outcome))` check (L1133), insert a skip-token branch that logs the reason and treats the item as advanced (skip-and-continue, NOT pause). Insert:
```js
          // AI skip outcomes (external LTI launch / programming lab) are
          // skip-and-continue per the spec: log the reason and advance the
          // cursor without waiting on the confirmer or pausing.
          const AI_SKIP_REASONS = {
            'assessment-skipped-lti': 'external app/LTI launch (cannot be answered in-page)',
            'assessment-skipped-programming': 'programming lab (cannot be answered in-page)',
          };
          if (outcome && AI_SKIP_REASONS[outcome.outcome]) {
            if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('⏭ Skipped ' + AI_SKIP_REASONS[outcome.outcome] + ': "' + (item.title || item.id) + '"');
            rec('run.ai.skipped', { itemId: item.id, outcome: outcome.outcome });
            // Fall through to the normal success/advance path below by treating
            // the item as a completed no-op: set the outcome to a benign value so
            // isFailureOutcome is false and the cursor advances. (Do NOT submit.)
            outcome = { outcome: outcome.outcome, _aiSkip: true };
          }
```
  (ii) **AI-answered run-log line** — inside the `if (isFailureOutcome(outcome))` pause branch (L1133-1155), after computing `_outcomeReason` and before/after the `state.updateIfCurrentRun(...status:'paused'...)` call, add a count-bearing run-log line specifically for the AI-answered outcome:
```js
            if (outcome.outcome === 'assessment-ai-answered-paused') {
              const _filledN = (typeof outcome.filled === 'number') ? outcome.filled : 0;
              if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('🤖 AI filled ' + _filledN + ' answer(s) — paused for review');
            }
```
  (iii) **Bypass the confirmer for skips.** The confirmer wait at L1165 (`if (confirmer && typeof confirmer.waitForCompletion === 'function')`) would, in production, wait for a completion mark that a skipped LTI/programming item never gets — and time out into a pause. Gate the confirmer block so a skip bypasses it and falls straight through to the success/advance path. Change the L1165 guard from:
```js
          if (confirmer && typeof confirmer.waitForCompletion === 'function') {
```
to:
```js
          if (!(outcome && outcome._aiSkip) && confirmer && typeof confirmer.waitForCompletion === 'function') {
```
  > The skip branch sets `_aiSkip` only as a marker; the existing success/advance path (L1453+) does not auto-submit — it logs `✓`, records the item, and advances the cursor via `emitSkipsAndAdvance` to the next safe item, satisfying "skip + continue". Gate the success-path `✓ <kind> "<title>"` line (L1469-1471) on `!(outcome && outcome._aiSkip)` so the only run-log line for a skip is the `⏭ Skipped …` line emitted in (i). In the unit test, `confirmer` is `null` (not passed to `createAutopilot`), so the confirmer block is already skipped there; this gate is the production-correctness path.
- [ ] 9d. Run it and watch it PASS: `node --test "tests/module-autopilot.test.js"` → expect PASS for both parts. Run `npm test` → expect all green.
- [ ] 10. Commit: `git add lib/module-autopilot.js tests/module-autopilot.test.js` then `git commit -m "feat(module-autopilot): fresh-start gating, AI routing/ctx, run-log lines + LTI/programming skip-advance"`

---

### Task 13: Sidebar aiAnswerAssessments toggle (markup + sync + emit + key-gated disable)

**Files:**
- Modify: `lib/sidebar.js:92-97` (markup), `lib/sidebar.js:771-784` (`setAutopilotSettings`), `lib/sidebar.js:920-933` (`emitSettings`), `lib/sidebar.js:986-1004` (`setAiKeyStatus`)
- Test: `tests/sidebar.test.js`

Steps:

- [ ] 1. Write the failing test (append to `tests/sidebar.test.js`). Mount the sidebar, assert the toggle exists, is disabled until a key is present, syncs from `setAutopilotSettings`, and is included in the `emitSettings` payload. Mirror the file's existing sidebar-mount convention (read the top of `tests/sidebar.test.js` to reuse its DOM setup / `require`):
```js
test('sidebar: aiAnswerAssessments toggle is key-gated, syncs, and emits', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://www.coursera.org/learn/x/quiz/q/a', pretendToBeVisual: true });
  global.window = dom.window; global.document = dom.window.document;
  const sidebar = require('../lib/sidebar.js');
  sidebar.mount ? sidebar.mount() : null;
  let emitted = null;
  sidebar.setAutopilotHandlers({ onSettingsChange: function (s) { emitted = s; } });
  const shadow = document.getElementById('ccp-host-root') ? document.getElementById('ccp-host-root').shadowRoot : (sidebar._shadowForTest && sidebar._shadowForTest());
  const cb = shadow.querySelector('[data-role="autopilot-ai-answer"]');
  assert.ok(cb, 'toggle must exist in markup');
  // Disabled until a key is configured.
  sidebar.setAiKeyStatus({ keyPresent: false });
  assert.equal(cb.disabled, true, 'toggle disabled without a key');
  sidebar.setAiKeyStatus({ keyPresent: true });
  assert.equal(cb.disabled, false, 'toggle enabled with a key');
  // Sync from settings.
  sidebar.setAutopilotSettings({ aiAnswerAssessments: true });
  assert.equal(cb.checked, true);
  // Emit on change.
  cb.checked = false;
  cb.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.ok(emitted && emitted.aiAnswerAssessments === false, 'emitSettings includes aiAnswerAssessments');
});
```
(If `tests/sidebar.test.js` already has a shared mount helper and a way to reach the shadow root, use that instead of the inline globals — match the file's exact existing pattern. The assertions on `data-role="autopilot-ai-answer"`, `.disabled`, `.checked`, and the emit payload are the load-bearing parts.)
- [ ] 2. Run it and watch it FAIL: `node --test "tests/sidebar.test.js"` → expect FAIL (no `autopilot-ai-answer` element).
- [ ] 3. Minimal implementation in `lib/sidebar.js`. (a) Markup — insert a new row after the auto-submit row (after L97's `'</div>' +`), with the toggle and warning line:
```js
          '<div class="ccp-row">' +
            '<label><input type="checkbox" data-role="autopilot-ai-answer" disabled> Answer graded &amp; practical assessments with AI</label>' +
          '</div>' +
          '<div class="ccp-row ccp-ai-answer-warning" data-role="autopilot-ai-answer-warning" style="font-size:11px;opacity:.8;">AI answers can be wrong; graded answers are filled for your review, never submitted automatically.</div>' +
```
(b) `setAutopilotSettings` (L771-784) — add sync. After the `as` lookup, add:
```js
    const aia = shadow.querySelector('[data-role="autopilot-ai-answer"]');
```
and after the `as.checked` assignment add:
```js
    if (aia && typeof settings.aiAnswerAssessments === 'boolean') aia.checked = settings.aiAnswerAssessments;
```
(c) `emitSettings` (L920-933) — read the new checkbox and include it. In the `wire` block where `pi`/`as`/`bFast`/`bHuman` are looked up (L891-894), add `const aia = shadow.querySelector('[data-role="autopilot-ai-answer"]');`. In `emitSettings`, add `aiAnswerAssessments: !!(aia && aia.checked),` to the `onSettingsChange` payload object. Add `if (aia) aia.addEventListener('change', emitSettings);` after the `as` listener.
(d) `setAiKeyStatus` (L986-1004) — gate the toggle's `disabled` on `keyPresent`, mirroring the `gen.disabled` pattern. After `_aiState.keyPresent = keyPresent;` add:
```js
    const aiaToggle = shadow.querySelector('[data-role="autopilot-ai-answer"]');
    if (aiaToggle) {
      aiaToggle.disabled = !keyPresent;
      if (!keyPresent) aiaToggle.checked = false;
    }
```
- [ ] 4. Run it and watch it PASS: `node --test "tests/sidebar.test.js"` → expect PASS. Run `npm test` → expect all green.
- [ ] 5. Commit: `git add lib/sidebar.js tests/sidebar.test.js` then `git commit -m "feat(sidebar): key-gated Answer-assessments-with-AI toggle (sync + emit + disable)"`

---

### Task 14: Wire the aiGenerate bridge in content.js and default the setting

**Files:**
- Modify: `content.js:96-127` (createHandlers deps), `content.js:161-171` (createAutopilot opts), `content.js:175` (`_latestSettings`)
- Test: (manual — `content.js` is the browser orchestrator and is not unit-tested; verified by the controller/handler tests above plus a load smoke check)

Steps:

- [ ] 1. Write the failing smoke test in a new file `tests/content-ai-bridge.test.js` that requires nothing from `content.js` (it is a browser IIFE) but instead asserts the BRIDGE CONTRACT the wiring must satisfy: an `aiGenerate(snapshot)` built from a `messenger.send('generateAnswers', {snapshot}, cb)` resolves to `{ok, raw}`. This locks the exact shape `content.js` must produce so a reviewer can verify the wiring by inspection:
```js
const test = require('node:test');
const assert = require('node:assert/strict');

// Mirrors the bridge content.js builds: wrap the ccp.ai.request 'generateAnswers'
// messenger as aiGenerate(snapshot) -> Promise<{ok, raw}>.
function makeAiGenerate(messenger) {
  return function (snapshot) {
    return new Promise(function (resolve) {
      messenger.send('generateAnswers', { snapshot: snapshot }, function (res) {
        resolve(res && res.ok ? { ok: true, raw: res.raw } : { ok: false, reason: (res && res.reason) || 'no-response' });
      });
    });
  };
}

test('aiGenerate bridge: forwards snapshot via generateAnswers and normalizes to {ok, raw}', async () => {
  const seen = [];
  const messenger = { send: function (command, params, cb) { seen.push({ command: command, params: params }); cb({ ok: true, raw: '{"answers":[]}' }); } };
  const aiGenerate = makeAiGenerate(messenger);
  const out = await aiGenerate({ token: 't', questions: [] });
  assert.equal(seen[0].command, 'generateAnswers');
  assert.deepEqual(seen[0].params.snapshot, { token: 't', questions: [] });
  assert.deepEqual(out, { ok: true, raw: '{"answers":[]}' });
});

test('aiGenerate bridge: a failed response normalizes to ok:false', async () => {
  const messenger = { send: function (command, params, cb) { cb({ ok: false, reason: 'no-key' }); } };
  const out = await makeAiGenerate(messenger)({ token: 't', questions: [] });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no-key');
});
```
- [ ] 2. Run it and watch it FAIL: `node --test "tests/content-ai-bridge.test.js"` → expect FAIL (file does not exist yet / `makeAiGenerate` undefined until written). After writing the test file, the test itself contains `makeAiGenerate`, so it should PASS on first run — to honor strict TDD, FIRST write the test with `const makeAiGenerate = require('./does-not-exist')` to force a real failure, run it (expect FAIL: module not found), THEN replace that require with the inline `makeAiGenerate` definition shown above.
- [ ] 3. Minimal implementation in `content.js`. (a) Build the bridge by sharing the same `ccp.ai.request` messenger pattern used in `setupAiAnswerController`. In `startAutopilot`, before `createHandlers`, add:
```js
    function aiRequestSend(command, params, cb) {
      try {
        chrome.runtime.sendMessage({ type: 'ccp.ai.request', command: command, params: params || {} }, function (res) { cb(res || { ok: false, reason: 'no-response' }); });
      } catch (e) { cb({ ok: false, reason: 'send-failed' }); }
    }
    const aiGenerate = function (snapshot) {
      return new Promise(function (resolve) {
        aiRequestSend('generateAnswers', { snapshot: snapshot }, function (res) {
          resolve(res && res.ok ? { ok: true, raw: res.raw } : { ok: false, reason: (res && res.reason) || 'no-response' });
        });
      });
    };
```
(b) Pass the AI deps into `createHandlers` (the deps object at L96-127): add
```js
      questionContext: a.aiQuestionContext || null,
      validator: a.aiAnswerValidator || null,
      permissive: a.aiAnswerPermissive || null,
      courseraDom: a.courseraDom || null,
```
(c) Pass `aiGenerate` into `createAutopilot` opts (L161-171): add `aiGenerate: aiGenerate,`.
(d) Default the setting in `_latestSettings` (L175): change
```js
    let _latestSettings = { pauseOnUserInput: false, autoSubmitQuizzes: false, behaviorMode: 'fast', runScope: 'module' };
```
to
```js
    let _latestSettings = { pauseOnUserInput: false, autoSubmitQuizzes: false, aiAnswerAssessments: false, behaviorMode: 'fast', runScope: 'module' };
```
- [ ] 4. Run it and watch it PASS: `node --test "tests/content-ai-bridge.test.js"` → expect PASS. Run the FULL suite to confirm nothing else broke: `npm test` → expect all green.
- [ ] 5. Commit: `git add content.js tests/content-ai-bridge.test.js` then `git commit -m "feat(content): wire aiGenerate bridge (reuse ccp.ai.request) into handlers + autopilot"`

---

### Task 15: End-to-end controller test — toggle ON answers a quiz and pauses (no submit)

**Files:**
- Modify: `tests/module-autopilot.test.js` (Test only — integration over Tasks 7-14)
- (No production code change; this task is the cross-cutting regression net the spec's "Autopilot controller" testing row requires.)

Steps:

- [ ] 1. Write the failing integration test (append to `tests/module-autopilot.test.js`). Drive a real `assessmentAi` handler (from `item-handlers.createHandlers`) through `createAutopilot`, with a mocked `aiGenerate` returning a single-choice answer, and assert the FULL pause contract — not just that nothing was submitted. After `bootIfRunning`, load the PERSISTED run state and assert: (a) the radio is selected, (b) `status === 'paused'`, (c) the cursor did NOT advance past the quiz (`cursor === 0` and `queue` not cleared to `[]`), (d) `lastPauseReason` reflects the AI-answered pause, and (e) no submit fired. This makes the test FAIL under the broken Task-10 "advance instead of pause" behavior (where `status` would be `idle`/complete, `queue` cleared, and `lastPauseReason` null) and PASS only when the pause requirement holds:
```js
test('integration: toggle ON drives assessmentAi to FILL + PAUSE a quiz (cursor frozen, no submit)', async () => {
  const QUIZ_HTML =
    '<div data-testid="cml-question-1"><div>Question 1</div><fieldset>' +
      '<label><input type="radio" name="q1"> Alpha</label>' +
      '<label><input type="radio" name="q1"> Beta</label>' +
    '</fieldset></div>' +
    '<button type="submit">Submit</button>';
  const j = makePage(QUIZ_HTML, 'https://www.coursera.org/learn/x/quiz/q1/intro-quiz');
  const doc = j.window.document;
  let submitted = false;
  doc.querySelector('button[type="submit"]').click = function () { submitted = true; };
  const storage = fakeStorage();
  let pausedBanner = null;
  const handlers = require('../lib/item-handlers.js').createHandlers({
    sleep: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    answerApplier: require('../lib/answer-applier.js'),
    questionContext: require('../lib/ai-question-context.js'),
    validator: require('../lib/ai-answer-validator.js'),
    permissive: require('../lib/ai-answer-permissive.js'),
    courseraDom: { isExternalLaunchPage: function () { return false; }, assessmentRoot: function (d) { return d.body; }, isExcludedNode: function () { return false; } },
  });
  handlers.video = function () { return Promise.resolve({ outcome: 'video-done' }); };
  handlers.reading = function () { return Promise.resolve({ outcome: 'reading-done' }); };
  handlers.discussion = function () { return Promise.resolve({ outcome: 'discussion-posted' }); };
  const ap = createAutopilot({
    document: doc, window: j.window, storage: storage, handlers: handlers,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function () { return Promise.resolve(); },
    aiGenerate: function (snapshot) { return Promise.resolve({ ok: true, raw: JSON.stringify({ answers: [{ question_id: 'q1', answer: { value: 'Beta' } }] }) }); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function (on, reason) { if (on) pausedBanner = reason; }, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  const d = stateMod.defaults();
  d.status = 'running'; d.courseId = 'x'; d.ownerTabKey = 'tab-1'; d.runId = 'r1';
  d.settings.aiAnswerAssessments = true;
  d.queue = [{ id: 'q1', kind: 'quiz', url: '/learn/x/quiz/q1/intro-quiz', title: 'Quiz One', aiAnswerable: true }];
  d.cursor = 0;
  await new Promise(function (r) { storage.set({ [stateMod.RUN_KEY]: d }, r); });
  await ap.bootIfRunning();
  // (a) AI selected the radio.
  const checked = doc.querySelectorAll('input[name="q1"]:checked');
  assert.equal(checked.length, 1, 'AI must have selected one radio');
  assert.equal(checked[0].parentElement.textContent.trim(), 'Beta');
  // (e) never auto-submitted.
  assert.equal(submitted, false, 'must NOT auto-submit AI-answered assessments');
  // (b)-(d) the run actually PAUSED — load the persisted state and assert it did
  // not advance. This is the regression net for the Task-10 'advance-instead-of-
  // pause' defect: under the broken behavior status would be 'idle' (run
  // completed) with queue cleared, and these assertions would fail.
  const persisted = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(persisted.status, 'paused', 'run must be PAUSED after AI fills the quiz');
  assert.equal(persisted.cursor, 0, 'cursor must NOT advance past the filled quiz');
  assert.ok(Array.isArray(persisted.queue) && persisted.queue.length === 1, 'queue must be retained (not cleared as if complete)');
  assert.ok(persisted.lastPauseReason && /AI filled the answers|review and submit/i.test(persisted.lastPauseReason), 'lastPauseReason must reflect the AI-answered pause');
  assert.ok(pausedBanner && /AI filled the answers|review and submit/i.test(pausedBanner), 'sidebar pause banner must reflect the AI-answered pause');
});
```
- [ ] 2. Run it and watch it FAIL initially (if any wiring from Tasks 11-12 is incomplete, or if Task 10 was applied incorrectly so the loop advances instead of pausing): `node --test "tests/module-autopilot.test.js"`. If it FAILS, the failure pinpoints the broken seam (routing, ctx.aiGenerate, snapshot scoping, apply, or the pause-vs-advance outcome classification). Fix the smallest thing in the responsible lib file and re-run. If it PASSES, the integration is sound.
- [ ] 3. (Only if step 2 failed) Make the minimal correction in the implicated file (no new behavior — reconcile the seam the test exposes). Re-run `node --test "tests/module-autopilot.test.js"` → expect PASS.
- [ ] 4. Run the full suite to confirm the entire phase is green together: `npm test` → expect all 1253 existing tests PLUS every test added in Tasks 1-15 to pass.
- [ ] 5. Commit: `git add tests/module-autopilot.test.js` then `git commit -m "test(module-autopilot): end-to-end AI-answer-then-pause integration (no auto-submit)"`

---

## Deferred manual smoke test (not automatable here)

After the suite is green, perform the manual real-Coursera smoke test the spec defers: with a key configured and the toggle ON, run the autopilot on a real in-page graded quiz and confirm answers are filled and the run PAUSES (no submission), an external LTI/MATLAB item is skipped with a log line, and the Boost chat / extension sidebar controls are never touched. This is a deferred step, not part of the automated `npm test` gate.
