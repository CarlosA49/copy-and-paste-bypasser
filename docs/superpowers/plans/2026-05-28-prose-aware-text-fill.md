# Prose-Aware Text Fill (math_input prose answers no longer mangled) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `lib/answer-applier.js` from running prose typed answers through `mathNormalize.normalizeMathAnswer`, which currently turns `"Long Term Evolution"` into `"Long*Term*Evolution"` because Rule 6 inserts implicit `*` between adjacent identifier tokens and Rule 7 strips whitespace.

**Architecture:** Add one tiny helper `looksMathematical(s)` to `lib/math-normalize.js` (exported alongside the existing `normalizeMathAnswer`). In `lib/answer-applier.js` `applyStructuredAnswers` (only — not `applyAnswers`, which has its own ordered-line pipeline), branch on `looksMathematical(item.value)`: if true, keep existing behavior (`normalizeMathAnswer`); if false, use `value.trim()` directly. No changes to `normalizeMathAnswer` itself, so the existing math-normalize test suite stays untouched.

**Tech Stack:** Vanilla JS (MV3 content script), `node:test`, `jsdom`. No build step.

---

## Scope Guard

- **Production files allowed:** `lib/math-normalize.js`, `lib/answer-applier.js`.
- **Test files allowed:** `tests/math-normalize.test.js`, `tests/answer-applier.test.js`.
- **Frozen:** everything else, including the AI validator (already trims and passes the value through unchanged), the AI controller, the sidebar, the question-detector, every autopilot file, and `lib/answer-matcher.js`.
- The existing `normalizeMathAnswer` function MUST NOT be modified (so its dedicated test suite — ~50+ cases — stays green automatically). Only the math-normalize module's *exports* are extended.

---

## File Structure

| File | Change |
|---|---|
| `lib/math-normalize.js` | Add new function `looksMathematical(s)`. Export it alongside `normalizeMathAnswer`. |
| `lib/answer-applier.js` | In `applyStructuredAnswers` (lines ~292-309 — the `math_input`/`numerical`/`input` branch), branch on `mathNormalize.looksMathematical(item.value)`. If false, use `String(item.value).trim()` as the value to fill; if true, keep existing `mathNormalize.normalizeMathAnswer(item.value)`. The downstream `answerMatcher.applyTextMatches` call is unchanged. |
| `tests/math-normalize.test.js` | Append unit tests for `looksMathematical`. |
| `tests/answer-applier.test.js` | Append integration tests on `applyStructuredAnswers`: prose fills as-is; math/numeric continues to normalize. |

---

## Task 1: Add `looksMathematical` helper to `lib/math-normalize.js`

**Files:**
- Test (append): `tests/math-normalize.test.js`
- Modify: `lib/math-normalize.js` (add helper + extend exports)

### Heuristic

`looksMathematical(s)` returns `true` iff the trimmed string contains ANY of:

1. A digit `[0-9]` — covers all numeric answers, units like `"15058.7876 V"`, scientific notation `"3.7699×10^-8"`.
2. A math operator or LaTeX/Unicode math glyph: any of `+ - * / ^ = ( ) \ × ·`.
3. A standalone known math identifier from `MATH_IDENTS` (`pi`, `e`, `E`, `epsilon_o`, `E_o`, `sqrt`, `sin`, `cos`, `tan`, `ln`, `log`, `exp`, `abs`). "Standalone" means the identifier is bounded by non-identifier characters on both sides (or string start/end).

Otherwise returns `false` — the string is prose and must be passed through unchanged.

Known edge cases (accepted):
- Single-letter prose answers like `"E"` or `"e"` classify as math (would round-trip through `normalizeMathAnswer` as `"E"` or `"e"` — harmless).
- A prose answer like `"5G"` (mentioning "5G networks") would classify as math because of the digit, and `normalizeMathAnswer("5G")` produces `"5*G"`. Users who hit this edge can tweak their typed answer.
- `"and/or"` classifies as math because of `/`, but tokenizing as `and` (id) + `/` (op) + `or` (id) does NOT trigger implicit `*` (only `id→id`, not `id→op→id`), so the result is `and/or` with spaces stripped — acceptable.

- [ ] **Step 1: Append RED tests to `tests/math-normalize.test.js`**

Open `tests/math-normalize.test.js`. The file currently only imports `normalizeMathAnswer`. Update the import at line 3 to also pull in `looksMathematical`:

```js
const { normalizeMathAnswer, looksMathematical } = require('../lib/math-normalize.js');
```

Then append at end of file:

```js
// === U16: looksMathematical — prose vs math/numeric classifier ===

test('U16-L1: pure prose with spaces returns false', () => {
  assert.equal(looksMathematical('Long Term Evolution'), false);
  assert.equal(looksMathematical('Hello world'), false);
  assert.equal(looksMathematical('Yes'), false);
});

test('U16-L2: empty / whitespace / non-string returns false', () => {
  assert.equal(looksMathematical(''), false);
  assert.equal(looksMathematical('   '), false);
  assert.equal(looksMathematical(null), false);
  assert.equal(looksMathematical(undefined), false);
  assert.equal(looksMathematical(5), false); // non-string
});

test('U16-L3: any digit triggers math', () => {
  assert.equal(looksMathematical('5'), true);
  assert.equal(looksMathematical('15058.7876 V'), true);
  assert.equal(looksMathematical('3.7699×10^-8 C'), true);
  assert.equal(looksMathematical('answer is 42'), true);
});

test('U16-L4: math operators trigger math', () => {
  assert.equal(looksMathematical('a + b'), true);
  assert.equal(looksMathematical('x/y'), true);
  assert.equal(looksMathematical('(2epsilon_oE_o/r)'), true);
  assert.equal(looksMathematical('\\sqrt{2}'), true);
  assert.equal(looksMathematical('a × b'), true);
});

test('U16-L5: standalone math identifiers trigger math (full-token match)', () => {
  assert.equal(looksMathematical('pi'), true);
  assert.equal(looksMathematical('sqrt'), true);
  assert.equal(looksMathematical('sin x'), true);
  assert.equal(looksMathematical('E_o'), true);
  assert.equal(looksMathematical('epsilon_o'), true);
});

test('U16-L6: words that CONTAIN math identifiers as substrings DO NOT trigger', () => {
  // "Evolution" contains "e" as a substring but not as a standalone token
  assert.equal(looksMathematical('Evolution'), false);
  // "absurd" contains "abs" as a prefix but not as a standalone token
  assert.equal(looksMathematical('absurd theory'), false);
  // "principal" contains "pi" as a prefix but not as a standalone token
  assert.equal(looksMathematical('principal component'), false);
  // "exponent" contains "exp" as a prefix
  assert.equal(looksMathematical('exponent rules apply'), false);
});

test('U16-L7: real-world math examples from existing math-normalize test suite all classify as math', () => {
  assert.equal(looksMathematical('0.0539'), true);
  assert.equal(looksMathematical('(2epsilon_oE_o/r)'), true);
  assert.equal(looksMathematical('(-2k)'), true);
  assert.equal(looksMathematical('(3.7647\\times10^5) N/C'), true);
  assert.equal(looksMathematical('(3.9789\\times10^{-5}) C/m²'), true);
});
```

- [ ] **Step 2: Run U16-L tests and confirm all FAIL with "looksMathematical is not a function"**

Run: `node --test --test-name-pattern="U16-L" tests/math-normalize.test.js`

Expected: 7 fails. Each reports `looksMathematical is not a function` (or `undefined is not a function`).

- [ ] **Step 3: Implement `looksMathematical` and extend exports in `lib/math-normalize.js`**

Open `lib/math-normalize.js`. Find the `const api = { normalizeMathAnswer: normalizeMathAnswer };` line near the bottom (around line 256).

Immediately BEFORE that line, add the helper:

```js
  // ---------------------------------------------------------------------------
  // Classifier: does this string look like a math/numeric expression?
  // Used by callers (lib/answer-applier.js applyStructuredAnswers) to decide
  // whether to run normalizeMathAnswer (math) or pass the value through (prose).
  //
  // Returns true if the trimmed input contains ANY of:
  //   - a digit
  //   - a math operator or LaTeX/Unicode math glyph
  //   - a standalone known math identifier (bounded by non-identifier chars)
  // ---------------------------------------------------------------------------
  function looksMathematical(raw) {
    if (typeof raw !== 'string') return false;
    var s = raw.trim();
    if (!s) return false;
    // Any digit → math.
    if (/[0-9]/.test(s)) return true;
    // Math operators / LaTeX / Unicode math glyphs → math.
    if (/[+\-*/^=()\\×·]/.test(s)) return true;
    // Standalone known math identifier → math.
    for (var ki = 0; ki < KNOWN_IDENTS_SORTED.length; ki++) {
      var ident = KNOWN_IDENTS_SORTED[ki];
      // Escape underscores in the identifier for use inside a character-class-free regex.
      // The identifiers in MATH_IDENTS are all ASCII letters + underscore; no regex
      // metacharacters need escaping beyond a defensive identity replace.
      var pattern = '(^|[^A-Za-z0-9_])' + ident.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&') + '($|[^A-Za-z0-9_])';
      var re = new RegExp(pattern);
      if (re.test(s)) return true;
    }
    return false;
  }
```

Then extend the API export. Replace the existing `const api = ...` line:

```js
const api = { normalizeMathAnswer: normalizeMathAnswer };
```

with:

```js
const api = { normalizeMathAnswer: normalizeMathAnswer, looksMathematical: looksMathematical };
```

`KNOWN_IDENTS_SORTED` is already defined earlier in the file (line ~100) as the longest-first sort of `MATH_IDENTS`. Reuse it directly.

- [ ] **Step 4: Re-run U16-L tests — confirm 7/7 PASS**

Run: `node --test --test-name-pattern="U16-L" tests/math-normalize.test.js`

Expected: 7 pass.

- [ ] **Step 5: Run the full math-normalize test file (regression — must stay green)**

Run: `node --test tests/math-normalize.test.js`

Expected: every test PASSES — both the existing ~50+ `normalizeMathAnswer` tests AND the new 7 `looksMathematical` tests. Do NOT modify any pre-existing test.

- [ ] **Step 6: Commit**

```
git add lib/math-normalize.js tests/math-normalize.test.js
git commit -m "feat(math-normalize): add looksMathematical(s) prose-vs-math classifier"
```

---

## Task 2: Use `looksMathematical` in `applyStructuredAnswers`

**Files:**
- Test (append): `tests/answer-applier.test.js`
- Modify: `lib/answer-applier.js` (`applyStructuredAnswers`, lines ~292-309)

- [ ] **Step 1: Append RED integration tests to `tests/answer-applier.test.js`**

The file already imports `applyAnswers` from `../lib/answer-applier.js`. Add `applyStructuredAnswers` to the import at line 4:

```js
const { applyAnswers, applyStructuredAnswers } = require('../lib/answer-applier.js');
```

Then append at end of file:

```js
// === U16: applyStructuredAnswers preserves prose for math_input typed fields ===

test('U16-A1: prose value "Long Term Evolution" fills the text input verbatim (no implicit * insertion)', () => {
  const doc = dom(
    makeQuestion(1, '<input type="text" id="q1">')
  );
  const result = applyStructuredAnswers(
    [{ questionNumber: 1, type: 'math_input', value: 'Long Term Evolution' }],
    doc.body,
    { verbose: false }
  );
  assert.equal(result.summary.filled, 1);
  assert.equal(result.summary.failed, 0);
  const input = doc.getElementById('q1');
  assert.equal(input.value, 'Long Term Evolution',
    'prose answer must fill exactly — no Long*Term*Evolution corruption');
});

test('U16-A2: multi-word prose with punctuation fills verbatim', () => {
  const doc = dom(makeQuestion(1, '<input type="text" id="q1">'));
  const result = applyStructuredAnswers(
    [{ questionNumber: 1, type: 'math_input', value: 'Hello, world!' }],
    doc.body,
    { verbose: false }
  );
  assert.equal(result.summary.filled, 1);
  assert.equal(doc.getElementById('q1').value, 'Hello, world!');
});

test('U16-A3: single-word prose answer fills verbatim', () => {
  const doc = dom(makeQuestion(1, '<input type="text" id="q1">'));
  const result = applyStructuredAnswers(
    [{ questionNumber: 1, type: 'math_input', value: 'Bandwidth' }],
    doc.body,
    { verbose: false }
  );
  assert.equal(result.summary.filled, 1);
  assert.equal(doc.getElementById('q1').value, 'Bandwidth');
});

test('U16-A4: real numeric answer still normalises (unit stripped, no regression)', () => {
  const doc = dom(makeQuestion(1, '<input type="text" id="q1">'));
  const result = applyStructuredAnswers(
    [{ questionNumber: 1, type: 'math_input', value: '15058.7876 V' }],
    doc.body,
    { verbose: false }
  );
  assert.equal(result.summary.filled, 1);
  assert.equal(doc.getElementById('q1').value, '15058.7876',
    'numeric answer must still strip trailing unit');
});

test('U16-A5: real scientific-notation answer still normalises to E form', () => {
  const doc = dom(makeQuestion(1, '<input type="text" id="q1">'));
  const result = applyStructuredAnswers(
    [{ questionNumber: 1, type: 'math_input', value: '3.7699×10^-8 C' }],
    doc.body,
    { verbose: false }
  );
  assert.equal(result.summary.filled, 1);
  assert.equal(doc.getElementById('q1').value, '3.7699E-8',
    'scientific-notation answer must still convert to E form and strip the unit');
});

test('U16-A6: symbolic-math answer still gets implicit * insertion and outer parens stripped', () => {
  const doc = dom(makeQuestion(1, '<input type="text" id="q1">'));
  const result = applyStructuredAnswers(
    [{ questionNumber: 1, type: 'math_input', value: '(2epsilon_oE_o/r)' }],
    doc.body,
    { verbose: false }
  );
  assert.equal(result.summary.filled, 1);
  assert.equal(doc.getElementById('q1').value, '2*epsilon_o*E_o/r',
    'symbolic-math answer must still insert implicit * and strip outer parens');
});
```

- [ ] **Step 2: Run U16-A tests and confirm U16-A1, A2, A3 FAIL; U16-A4, A5, A6 PASS**

Run: `node --test --test-name-pattern="U16-A" tests/answer-applier.test.js`

Expected:
- `U16-A1` FAILS: actual value is `"Long*Term*Evolution"`.
- `U16-A2` FAILS or possibly PASSES depending on punctuation handling (current `normalizeMathAnswer` may leave `"Hello,world!"` after stripping spaces; assertion expects `"Hello, world!"`). Either way the post-fix behavior is the same.
- `U16-A3` PASSES: `"Bandwidth"` is a single token; `normalizeMathAnswer` returns `"Bandwidth"` unchanged.
- `U16-A4` PASSES: existing behavior already strips the `V` unit.
- `U16-A5` PASSES: existing behavior already converts to E form and strips the `C` unit.
- `U16-A6` PASSES: existing behavior already inserts implicit `*`.

Capture verbatim — at minimum `U16-A1` must fail.

- [ ] **Step 3: Modify `applyStructuredAnswers` in `lib/answer-applier.js`**

Open `lib/answer-applier.js`. Find the `math_input`/`numerical`/`input` branch inside `applyStructuredAnswers` (around line 292):

```js
if (item.type === 'math_input' || item.type === 'numerical' || item.type === 'input') {
  const normalized = mathNormalize.normalizeMathAnswer(item.value);
  if (!normalized) { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'empty-after-normalize' }); failed++; continue; }
  let ok = false, valueUsed = null, lastReason = 'unknown';
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const target = (attempt === 0)
      ? q.targets[0]
      : (questionDetector.detectQuestions(rootEl).find(function (qq) { return qq.questionNumber === q.questionNumber; }) || q).targets[0];
    if (!target) { lastReason = 'field not found'; continue; }
    if (target.scrollIntoView) { try { target.scrollIntoView({ block: 'center' }); } catch (_) {} }
    const r = fillTextOnce(target, normalized);
    if (r.ok) { ok = true; valueUsed = r.valueUsed; break; }
    lastReason = r.reason || 'value-did-not-stick';
  }
  if (ok) { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'filled', normalizedAnswer: normalized, valueUsed: valueUsed }); filled++; }
  else { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: lastReason, normalizedAnswer: normalized }); failed++; }
  continue;
}
```

Replace the FIRST line of the block (`const normalized = mathNormalize.normalizeMathAnswer(item.value);`) with a branched form:

```js
if (item.type === 'math_input' || item.type === 'numerical' || item.type === 'input') {
  const rawValue = (item.value == null) ? '' : String(item.value);
  const normalized = mathNormalize.looksMathematical(rawValue)
    ? mathNormalize.normalizeMathAnswer(rawValue)
    : rawValue.trim();
  if (!normalized) { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'empty-after-normalize' }); failed++; continue; }
  let ok = false, valueUsed = null, lastReason = 'unknown';
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const target = (attempt === 0)
      ? q.targets[0]
      : (questionDetector.detectQuestions(rootEl).find(function (qq) { return qq.questionNumber === q.questionNumber; }) || q).targets[0];
    if (!target) { lastReason = 'field not found'; continue; }
    if (target.scrollIntoView) { try { target.scrollIntoView({ block: 'center' }); } catch (_) {} }
    const r = fillTextOnce(target, normalized);
    if (r.ok) { ok = true; valueUsed = r.valueUsed; break; }
    lastReason = r.reason || 'value-did-not-stick';
  }
  if (ok) { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'filled', normalizedAnswer: normalized, valueUsed: valueUsed }); filled++; }
  else { results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: lastReason, normalizedAnswer: normalized }); failed++; }
  continue;
}
```

Changes:
- `rawValue` coerces `item.value` to a string defensively (already a string when coming from the AI validator, but the autopilot/numbered path may pass non-strings).
- The math/prose branch is selected by `mathNormalize.looksMathematical(rawValue)`.
- For prose, `normalized = rawValue.trim()` — no implicit-`*`, no space-strip.
- For math, behavior is identical to before (`normalizeMathAnswer(rawValue)`).
- The `normalizedAnswer` field in the result is the value actually used (either trimmed prose or normalized math). This preserves existing observable behavior for callers reading that field.

**Do NOT touch `applyAnswers`** (the autopilot/numbered path) — that function operates on raw answer text from the clipboard, not on AI-structured answers, and its existing call to `mathNormalize.normalizeMathAnswer` works fine for the answer formats the autopilot receives.

- [ ] **Step 4: Re-run U16-A tests — confirm 6/6 PASS**

Run: `node --test --test-name-pattern="U16-A" tests/answer-applier.test.js`

Expected: 6 pass. Specifically:
- `U16-A1`: `doc.getElementById('q1').value === 'Long Term Evolution'`.
- `U16-A2`: `doc.getElementById('q1').value === 'Hello, world!'`.
- `U16-A3`: `doc.getElementById('q1').value === 'Bandwidth'`.
- `U16-A4`: `doc.getElementById('q1').value === '15058.7876'`.
- `U16-A5`: `doc.getElementById('q1').value === '3.7699E-8'`.
- `U16-A6`: `doc.getElementById('q1').value === '2*epsilon_o*E_o/r'`.

- [ ] **Step 5: Run the full answer-applier test file (regression — must stay green)**

Run: `node --test tests/answer-applier.test.js`

Expected: every test PASSES, including the pre-existing `applyAnswers` tests (which are untouched by this change) and any pre-existing `applyStructuredAnswers` tests.

- [ ] **Step 6: Commit**

```
git add lib/answer-applier.js tests/answer-applier.test.js
git commit -m "fix(answer-applier): preserve prose for math_input typed answers (no implicit *)"
```

---

## Task 3: Full repo regression + verification

**Files:** none modified.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: every test PASSES. Net count change: +13 (7 U16-L in math-normalize + 6 U16-A in answer-applier).

- [ ] **Step 2: Autopilot regression**

Run: `node --test tests/autopilot-state.test.js tests/autopilot-timing.test.js tests/completion-confirmer.test.js tests/item-handlers.test.js tests/module-autopilot.test.js tests/module-scraper.test.js`

Expected: every test PASSES. Autopilot uses `applyAnswers` (numbered path), not `applyStructuredAnswers` — untouched.

- [ ] **Step 3: Specifically confirm the existing math-normalize suite is intact**

Run: `node --test tests/math-normalize.test.js`

Expected: every pre-existing `normalizeMathAnswer` test PASSES (the function is unchanged) plus the 7 new `U16-L` tests.

- [ ] **Step 4: Provider-neutrality grep (sanity)**

Run: `grep -nE "DeepSeek|OpenAI|Anthropic|Claude|GPT-" lib/sidebar.js lib/ai-options-controller.js lib/ai-answer-controller.js lib/ai-content-listeners.js lib/ai-open-options-content.js lib/ai-open-options-background.js lib/ai-question-context.js lib/ui-revision.js options.html`

Expected: zero matches.

- [ ] **Step 5: Real-key leak scan**

Run: `grep -rE "sk-[A-Za-z0-9_]{16,}" --include="*.js" --include="*.json" --include="*.html" --include="*.md" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=Reference .`

Expected: zero matches.

- [ ] **Step 6: Final commit summary**

Run: `git log --oneline -3`

Expected: the two new commits are visible:
1. `fix(answer-applier): preserve prose for math_input typed answers (no implicit *)`
2. `feat(math-normalize): add looksMathematical(s) prose-vs-math classifier`

---

## Task 4: Live Chrome verification (user-driven)

**Files:** none modified.

- [ ] **Step 1: Reload the extension**

Open `chrome://extensions`, click Reload on Clipboard Cleaner.

- [ ] **Step 2: Navigate to a page with a typed-text question whose answer is prose (e.g., "Long Term Evolution")**

Practice quiz or assignment-submission URL with at least one fill-in-the-blank that expects a text/acronym answer.

- [ ] **Step 3: Click Scan questions, Generate suggestions, Apply answers**

Expected:
- Sidebar preview shows the AI's suggestion with the prose value verbatim (e.g., `Long Term Evolution`).
- Clicking Apply fills the input field with `Long Term Evolution` exactly — no `*` inserted, spaces preserved.

- [ ] **Step 4: Sanity-check a math/numeric question**

Navigate to a question whose answer is `15058.7876 V` or similar.

Expected: the input gets `15058.7876` (unit stripped). Math normalization still works.

---

## Self-Review Notes

- **Spec coverage:**
  - User requirement: prose preserved → Task 2 Step 3 (the `looksMathematical` branch returns `rawValue.trim()` for prose), Tests U16-A1, A2, A3.
  - User requirement: math/numeric still normalised → Task 2 Step 3 (the math branch calls `normalizeMathAnswer`), Tests U16-A4, A5, A6.
  - User requirement: regression tests in `tests/answer-applier.test.js` → Task 2 Step 1 (6 U16-A tests).
  - User requirement: AI Answers / controller / sidebar regression → addressed in Task 2's U16-A1 which exercises the end-to-end shape that the AI controller forwards (`{ questionNumber, type:'math_input', value:'<prose>' }`). The sidebar's suggestion preview already displays `s.value` verbatim and was never the source of corruption — no sidebar change needed.
  - User requirement: don't weaken existing math-normalize tests → Task 1 Step 4 doesn't modify `normalizeMathAnswer`; Task 3 Step 3 re-asserts the full suite stays green.
  - User requirement: small helper, only call `normalizeMathAnswer` when value looks math/numeric → Task 1 (helper); Task 2 (branched call site).
  - User requirement: run `npm test` → Task 3 Step 1.

- **Placeholder scan:** every step has full code or exact commands with expected output. Notes in Task 1 Steps 1-2 about the two-step authoring artifact are explicit; the engineer produces the final test shape directly.

- **Type / symbol consistency:**
  - `looksMathematical` defined and used by name in: `tests/math-normalize.test.js`, `lib/math-normalize.js`, `lib/answer-applier.js`.
  - `normalizeMathAnswer` referenced consistently as `mathNormalize.normalizeMathAnswer` in `answer-applier.js`.
  - `MATH_IDENTS` / `KNOWN_IDENTS_SORTED` referenced from inside `lib/math-normalize.js`; both are defined earlier in the same file.
  - The `U16-L` (looksMathematical) and `U16-A` (applyStructuredAnswers) test-name prefixes are distinct and grep-able.

- **Scope:** two production files, two test files. No autopilot file, no AI controller, no sidebar, no manifest, no options page.
