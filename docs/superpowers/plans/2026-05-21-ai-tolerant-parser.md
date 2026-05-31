# AI-Tolerant Answer Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Answering for you" computed-value extractor with a robust two-stage parser: a pure preprocessor that normalizes messy AI-output formatting (Unicode minus / superscripts / split scientific notation / `×10^N` variants) into a canonical `1.0e-6` form, and a confidence-scored extractor that recognises labeled answers (`Q1:`, `Answer 2 =`, `#3`), list answers (numbered / bulleted), and inline paragraph answers.

**Architecture:** New pure module `lib/value-normalize.js` runs first, producing a canonicalized copy of the pasted text. `lib/answer-parser.js`'s computed-value extractor is rewritten to scan that text with three confidence-scored passes (high = labeled, medium = list, low = inline), deduplicating across passes and keeping the highest-confidence reason. A new `confidence` field on each computed value flows through to the sidebar, which warns the user in the status line when confidence is low or the number of extracted values does not match the number of text inputs on the page. Multiple-choice letter extraction is suppressed when the only single-letter candidates are physics units (H, F, C, A, V, W, N, J, T) and a high-confidence numeric answer was found.

**Tech Stack:** Vanilla JS (Chrome MV3 content script), Node 20+ built-in `node --test`, JSDOM for DOM-touching tests. Existing IIFE + dual-mode pattern preserved.

---

## File Structure

- **Create** `lib/value-normalize.js` — pure DOM-free preprocessor. Exports `normalizeAnswerText(text) → string`. Handles Unicode minus, Unicode superscript digits, `×10^N` / `x10^N` / `*10^N` / bare `10^N` → `e±N`, joins split scientific notation across lines, leaves untouched anything that isn't math.
- **Create** `tests/value-normalize.test.js` — unit tests covering every input format the user listed.
- **Modify** `lib/answer-parser.js`:
  - Lazy-load `valueNormalize` (same pattern as `mathFlatten` is loaded by `html-cleaner.js`).
  - Replace `extractComputedValues` with a 3-pass `extractAnswers` that returns `[{value, unit, raw, confidence, label}]`.
  - Add `KNOWN_UNITS` whitelist (broader than current `STOP_UNITS` rejection).
  - Add a `suppressUnitLetters(letters, computedValues)` pass that drops single-letter candidates which are physics-unit codes when a high-confidence numeric answer exists.
  - `computedValues` shape gains a `confidence` field (`'high' | 'medium' | 'low'`). The existing five tests asserting on the full object are updated to include this field.
- **Modify** `tests/answer-parser.test.js` — add ~20 new tests for the AI-tolerant cases (clean lists, bullets, inline prose, split sci notation, Q1:/Answer N=/#N labels, unit-letter suppression). Update five existing tests to include `confidence`.
- **Modify** `manifest.json` — register `lib/value-normalize.js` so the browser content-script bundle can read `window.ClipboardCleaner.valueNormalize`.
- **Modify** `lib/sidebar.js` — when the user clicks Apply, surface a warning in the status line when (a) the text-input pipeline has any `confidence === 'low'` match, or (b) `parsed.computedValues.length !== textInputs.length` and at least one fill happened. Existing chip rendering continues to show one chip per `computedValues` entry.

Each file has a single clear responsibility: `value-normalize.js` is pure text-shape; `answer-parser.js` is pure semantic extraction; `sidebar.js` is the user-facing surface.

---

## Epic A — Value normalization (preprocessor)

### Task A1: Char-level normalization (Unicode minus + Unicode superscript digits)

**Files:**
- Create: `lib/value-normalize.js`
- Test: `tests/value-normalize.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/value-normalize.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAnswerText } = require('../lib/value-normalize.js');

test('normalizeAnswerText: returns "" for non-string and empty inputs', () => {
  assert.equal(normalizeAnswerText(null), '');
  assert.equal(normalizeAnswerText(undefined), '');
  assert.equal(normalizeAnswerText(123), '');
  assert.equal(normalizeAnswerText(''), '');
});

test('normalizeAnswerText: passes plain prose through unchanged', () => {
  assert.equal(normalizeAnswerText('Hello world.'), 'Hello world.');
});

test('normalizeAnswerText: Unicode minus U+2212 → ASCII "-"', () => {
  // The −6 here uses U+2212, the canonical "minus sign" Coursera uses.
  assert.equal(normalizeAnswerText('value −6'), 'value -6');
});

test('normalizeAnswerText: Unicode superscript digits attached to 10 → 10^N form', () => {
  assert.equal(normalizeAnswerText('10⁻⁶'), '10^-6');
  assert.equal(normalizeAnswerText('10⁶'), '10^6');
  assert.equal(normalizeAnswerText('10¹²'), '10^12');
});

test('normalizeAnswerText: superscript on a letter is left as-is (not part of sci notation)', () => {
  // We only normalize the 10^N case; superscript on a unit symbol stays for downstream use.
  // (m² should stay as m² so the user still sees a sensible unit; the value extractor
  // doesn't need it to be ^2.)
  assert.equal(normalizeAnswerText('area m²'), 'area m²');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern normalizeAnswerText`
Expected: all 5 FAIL (module missing).

- [ ] **Step 3: Implement** `lib/value-normalize.js`:

```js
// lib/value-normalize.js
// Pure text preprocessor for AI-output normalisation. Turns the many
// flavours of scientific notation (×10^N, x10^N, 10⁻⁶, 1.0E-6, split across
// lines, Unicode minus) into a canonical "1.0e-6" form so downstream extractors
// can use a single simple regex. No DOM. Dual-export (browser + CJS).
(function (root) {
  'use strict';

  // Map Unicode superscript characters to their ASCII equivalents.
  const SUPER_MAP = {
    '⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9',
    '⁻':'-','⁺':'+',
  };

  // Normalise Unicode minus (U+2212) to ASCII hyphen-minus.
  function normalizeMinus(s) {
    return s.replace(/−/g, '-');
  }

  // When Unicode superscript digits/sign appear immediately after the digits "10",
  // unpack them as "^N" so later passes can canonicalise to "e" form. Other
  // superscript clusters (like m²) are left alone — they're units, not exponents.
  function normalizeSuperscripts(s) {
    return s.replace(/10([⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+)/g, function (_m, sup) {
      let ascii = '';
      for (let i = 0; i < sup.length; i++) {
        ascii += SUPER_MAP[sup[i]] || sup[i];
      }
      return '10^' + ascii;
    });
  }

  function normalizeAnswerText(text) {
    if (typeof text !== 'string') return '';
    if (!text) return '';
    let s = text;
    s = normalizeMinus(s);
    s = normalizeSuperscripts(s);
    return s;
  }

  const api = { normalizeAnswerText: normalizeAnswerText };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.valueNormalize = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern normalizeAnswerText`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/value-normalize.js tests/value-normalize.test.js
git commit -m "feat(value-normalize): Unicode minus + superscript normalisation"
```

---

### Task A2: Sci-notation canonicalization (`×10^N`, `x10^N`, `*10^N`, `10^N` → `e±N`)

**Files:**
- Modify: `lib/value-normalize.js`
- Modify: `tests/value-normalize.test.js`

- [ ] **Step 1: Append failing tests**

```js
test('normalizeAnswerText: "1.0000×10^-6" → "1.0000e-6"', () => {
  assert.equal(normalizeAnswerText('1.0000×10^-6'), '1.0000e-6');
});

test('normalizeAnswerText: "1.0000 × 10^-6" → "1.0000e-6" (spaces around ×)', () => {
  assert.equal(normalizeAnswerText('1.0000 × 10^-6'), '1.0000e-6');
});

test('normalizeAnswerText: "1.0000x10^-6" → "1.0000e-6" (lowercase x)', () => {
  assert.equal(normalizeAnswerText('1.0000x10^-6'), '1.0000e-6');
});

test('normalizeAnswerText: "1.0000*10^-6" → "1.0000e-6" (asterisk)', () => {
  assert.equal(normalizeAnswerText('1.0000*10^-6'), '1.0000e-6');
});

test('normalizeAnswerText: "1.0000×10⁻⁶" → "1.0000e-6" (Unicode superscript)', () => {
  assert.equal(normalizeAnswerText('1.0000×10⁻⁶'), '1.0000e-6');
});

test('normalizeAnswerText: "1.0E-6" → "1.0e-6" (capital E lowercased)', () => {
  assert.equal(normalizeAnswerText('1.0E-6'), '1.0e-6');
});

test('normalizeAnswerText: "1.0e-6" → "1.0e-6" (already canonical)', () => {
  assert.equal(normalizeAnswerText('1.0e-6'), '1.0e-6');
});

test('normalizeAnswerText: bare "10^-6" (no coefficient) → "1e-6"', () => {
  assert.equal(normalizeAnswerText('value 10^-6 here'), 'value 1e-6 here');
});

test('normalizeAnswerText: bare "10⁻⁶" → "1e-6"', () => {
  assert.equal(normalizeAnswerText('value 10⁻⁶ here'), 'value 1e-6 here');
});

test('normalizeAnswerText: positive exponent "1.5×10^3" → "1.5e3"', () => {
  assert.equal(normalizeAnswerText('1.5×10^3'), '1.5e3');
});

test('normalizeAnswerText: explicit "+" sign "1.5×10^+3" → "1.5e+3"', () => {
  assert.equal(normalizeAnswerText('1.5×10^+3'), '1.5e+3');
});

test('normalizeAnswerText: multiple sci-notation expressions in one string', () => {
  assert.equal(
    normalizeAnswerText('1.0000×10^-6 H, then 2.5×10^-9 F'),
    '1.0000e-6 H, then 2.5e-9 F'
  );
});

test('normalizeAnswerText: does NOT touch a plain decimal like "0.0352"', () => {
  assert.equal(normalizeAnswerText('value 0.0352 H'), 'value 0.0352 H');
});

test('normalizeAnswerText: does NOT touch year-like numbers ("2024 was a leap year")', () => {
  // 2024 is preceded by a digit boundary, not part of sci notation.
  assert.equal(normalizeAnswerText('2024 was a leap year'), '2024 was a leap year');
});
```

- [ ] **Step 2: Run tests and verify failures**

Run: `npm test -- --test-name-pattern normalizeAnswerText`
Expected: the 14 new tests fail (sci notation isn't canonicalised yet).

- [ ] **Step 3: Add sci-notation canonicalisation** to `lib/value-normalize.js`.

Add this function below `normalizeSuperscripts`:

```js
  // Canonicalise scientific notation to "e" form.
  //   "N × 10^M" / "N x 10^M" / "N * 10^M"  →  "NeM"
  //   bare "10^M" (preceded by non-alphanumeric) →  "1eM"
  //   "NE-M" / "Ne-M" → "Ne-M" (lowercase the E, no semantic change)
  function normalizeSciNotation(s) {
    // First: coefficient × 10^exponent form. Whitespace around × is allowed.
    // Coefficient must include at least one digit; exponent is signed.
    s = s.replace(
      /(-?\d+(?:\.\d+)?)\s*[×x*]\s*10\s*\^?\s*([+-]?\d+)/g,
      '$1e$2'
    );
    // Second: bare "10^M" where the leading 10 is not part of a larger number.
    // The boundary check (?:^|[^A-Za-z0-9.]) ensures we don't catch "2110^6".
    s = s.replace(
      /(^|[^A-Za-z0-9.])10\s*\^\s*([+-]?\d+)/g,
      function (_m, prefix, exp) { return prefix + '1e' + exp; }
    );
    // Third: lowercase E in canonical "Ne-M" form.
    s = s.replace(/(\d)E([+-]?\d)/g, '$1e$2');
    return s;
  }
```

Then call it from `normalizeAnswerText`. Find this body:

```js
  function normalizeAnswerText(text) {
    if (typeof text !== 'string') return '';
    if (!text) return '';
    let s = text;
    s = normalizeMinus(s);
    s = normalizeSuperscripts(s);
    return s;
  }
```

Replace with:

```js
  function normalizeAnswerText(text) {
    if (typeof text !== 'string') return '';
    if (!text) return '';
    let s = text;
    s = normalizeMinus(s);
    s = normalizeSuperscripts(s);
    s = normalizeSciNotation(s);
    return s;
  }
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern normalizeAnswerText`
Expected: 19 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/value-normalize.js tests/value-normalize.test.js
git commit -m "feat(value-normalize): canonicalise scientific notation to e-form"
```

---

### Task A3: Join split scientific notation across lines

**Files:**
- Modify: `lib/value-normalize.js`
- Modify: `tests/value-normalize.test.js`

When a user copies content from a rendered Coursera or KaTeX-style block, the exponent and unit often land on separate lines. We pre-collapse these so the canonicalisation pass in Task A2 can match them as a single token.

- [ ] **Step 1: Append failing tests**

```js
test('normalizeAnswerText: split sci notation across 2 lines is joined', () => {
  // Coefficient on one line, exponent on the next.
  const input = '1.0000×10\n-6';
  const out = normalizeAnswerText(input);
  // After the line-join + canonicalisation: "1.0000e-6"
  assert.equal(out, '1.0000e-6');
});

test('normalizeAnswerText: split sci notation across 3 lines (coefficient / exponent / unit)', () => {
  const input = '1.0000×10\n−6\nH';
  const out = normalizeAnswerText(input);
  // Coefficient + exponent collapse onto one line; the unit stays separated
  // by a space (we don't fold arbitrary line content into the value, just the exponent).
  assert.equal(out, '1.0000e-6 H');
});

test('normalizeAnswerText: split sci notation does NOT join unrelated next line', () => {
  // "2024 was..." after "value 10^N" should not be absorbed as an exponent.
  // (Our join rule requires the next line to be a signed integer only.)
  const input = '1.0000×10\nNot an exponent here';
  const out = normalizeAnswerText(input);
  // No join — the next line isn't just a signed number.
  assert.equal(out.indexOf('Not an exponent here'), out.length - 'Not an exponent here'.length);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test -- --test-name-pattern split`
Expected: 2-3 failing (line joining not implemented).

- [ ] **Step 3: Add line-join pre-pass** to `lib/value-normalize.js`.

Add this function near `normalizeMinus`:

```js
  // Join split scientific notation across lines. Coursera/KaTeX content often
  // copies as:
  //     1.0000×10
  //     −6
  //     H
  // The exponent line is just a signed integer. Optionally followed by a unit
  // line that's a short alphabetic token.
  function joinSplitSciNotation(s) {
    // Step A: coefficient ends with "×10" / "x10" / "*10", next non-empty line is signed integer.
    s = s.replace(
      /(-?\d+(?:\.\d+)?\s*[×x*]\s*10)\s*\n\s*([+-]?\d+)\b/g,
      '$1^$2'
    );
    // Step B: bare "10" at end of line followed by signed integer line.
    s = s.replace(
      /(^|[^A-Za-z0-9.])(10)\s*\n\s*([+-]?\d+)\b/g,
      '$1$2^$3'
    );
    // Step C: a unit on the next line directly after a numeric line ending in
    // a digit (or canonicalised "e±N") — collapse with a single space. Only
    // collapse short alphabetic tokens (1–4 chars + optional ²/³ etc.) so we
    // don't absorb whole paragraphs.
    s = s.replace(
      /(\d)\s*\n\s*([A-Za-zμΩ°]{1,4}[²³]?)\s*$/gm,
      '$1 $2'
    );
    return s;
  }
```

Then call it from `normalizeAnswerText` BEFORE the other passes. Find:

```js
    let s = text;
    s = normalizeMinus(s);
    s = normalizeSuperscripts(s);
    s = normalizeSciNotation(s);
    return s;
```

Replace with:

```js
    let s = text;
    s = normalizeMinus(s);
    s = joinSplitSciNotation(s);
    s = normalizeSuperscripts(s);
    s = normalizeSciNotation(s);
    return s;
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern split`
Expected: the 3 split tests pass; full suite still green.

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 5: Commit**

```bash
git add lib/value-normalize.js tests/value-normalize.test.js
git commit -m "feat(value-normalize): join split scientific notation across lines"
```

---

### Task A4: Manifest registration

**Files:**
- Modify: `manifest.json`

- [ ] **Step 1: Update `content_scripts[0].js`** to load `lib/value-normalize.js` before `lib/answer-parser.js` (which reads `window.ClipboardCleaner.valueNormalize` lazily).

After the change, the `js` array should look like:

```json
"js": [
  "lib/cleaner.js",
  "lib/math-flatten.js",
  "lib/html-cleaner.js",
  "lib/typing-engine.js",
  "lib/typing-injector.js",
  "lib/value-normalize.js",
  "lib/answer-parser.js",
  "lib/answer-matcher.js",
  "lib/sidebar.js",
  "content.js"
]
```

(`lib/value-normalize.js` is the only new line, inserted between `typing-injector.js` and `answer-parser.js`.)

- [ ] **Step 2: Validate the JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add manifest.json
git commit -m "build: load value-normalize before answer-parser in content script"
```

---

## Epic B — Confidence-scored answer extraction

### Task B1: extractAnswers — labeled answers (high confidence)

**Files:**
- Modify: `lib/answer-parser.js`
- Modify: `tests/answer-parser.test.js`

This task replaces the old `extractComputedValues` with a new `extractAnswers` function. We start with the labeled-answer pass only; medium and low passes come in B2/B3. The intermediate state still produces a working extractor for labeled cases.

- [ ] **Step 1: Append failing tests** to `tests/answer-parser.test.js`

```js
test('parseAnswerText: extracts "Q1: VALUE UNIT" with confidence high and label 1', () => {
  const out = parseAnswerText('Q1: 1.0000×10^-6 H');
  assert.equal(out.computedValues.length, 1);
  assert.equal(out.computedValues[0].value, '1.0000e-6');
  assert.equal(out.computedValues[0].unit, 'H');
  assert.equal(out.computedValues[0].raw, '1.0000e-6 H');
  assert.equal(out.computedValues[0].confidence, 'high');
  assert.equal(out.computedValues[0].label, '1');
});

test('parseAnswerText: extracts "Question 1: VALUE UNIT" with confidence high', () => {
  const out = parseAnswerText('Question 1: 500 turns');
  assert.equal(out.computedValues[0].value, '500');
  assert.equal(out.computedValues[0].confidence, 'high');
  assert.equal(out.computedValues[0].label, '1');
});

test('parseAnswerText: extracts "Answer 2 = VALUE UNIT" with confidence high and label 2', () => {
  const out = parseAnswerText('Answer 2 = 0.0352 H');
  assert.equal(out.computedValues[0].value, '0.0352');
  assert.equal(out.computedValues[0].unit, 'H');
  assert.equal(out.computedValues[0].confidence, 'high');
  assert.equal(out.computedValues[0].label, '2');
});

test('parseAnswerText: extracts "For #3, the result is VALUE UNIT" with label 3', () => {
  const out = parseAnswerText('For #3, the result is 6.0781×10^-10 F.');
  assert.equal(out.computedValues[0].value, '6.0781e-10');
  assert.equal(out.computedValues[0].unit, 'F');
  assert.equal(out.computedValues[0].confidence, 'high');
  assert.equal(out.computedValues[0].label, '3');
});

test('parseAnswerText: extracts "The answer to question 1 is VALUE UNIT"', () => {
  const out = parseAnswerText('The answer to question 1 is 1.0000×10^-6 H.');
  assert.equal(out.computedValues[0].value, '1.0000e-6');
  assert.equal(out.computedValues[0].confidence, 'high');
  assert.equal(out.computedValues[0].label, '1');
});

test('parseAnswerText: multiple labeled answers preserve order by document position', () => {
  const out = parseAnswerText(
    'Q1: 1.0000×10^-6 H\n' +
    'Answer 2 = 0.0352 H\n' +
    'For #3, the result is 6.0781×10^-10 F.'
  );
  assert.equal(out.computedValues.length, 3);
  assert.equal(out.computedValues[0].label, '1');
  assert.equal(out.computedValues[1].label, '2');
  assert.equal(out.computedValues[2].label, '3');
  assert.ok(out.computedValues.every(function (cv) { return cv.confidence === 'high'; }));
});
```

- [ ] **Step 2: Update existing computedValues tests** to include the new `confidence` field. Find each of these tests and update the `assert.deepEqual` to include `confidence` (and `label` where appropriate):

Test "extracts plain 'answer is X' computed value" — replace:
```js
  assert.deepEqual(out.computedValues, [{ value: '500', unit: 'turns', raw: '500 turns' }]);
```
with:
```js
  assert.deepEqual(out.computedValues, [{ value: '500', unit: 'turns', raw: '500 turns', confidence: 'high', label: null }]);
```

Test "extracts numeric-only 'answer is X' (no unit)" — replace:
```js
  assert.deepEqual(out.computedValues, [{ value: '42', unit: '', raw: '42' }]);
```
with:
```js
  assert.deepEqual(out.computedValues, [{ value: '42', unit: '', raw: '42', confidence: 'high', label: null }]);
```

Test "extracts 'L = 200 mH' via the equals-with-unit pattern" — replace:
```js
  assert.deepEqual(out.computedValues, [{ value: '200', unit: 'mH', raw: '200 mH' }]);
```
with:
```js
  assert.deepEqual(out.computedValues, [{ value: '200', unit: 'mH', raw: '200 mH', confidence: 'low', label: null }]);
```

Test "extracts decimal value (6.3 MHz)" — replace:
```js
  assert.deepEqual(out.computedValues, [{ value: '6.3', unit: 'MHz', raw: '6.3 MHz' }]);
```
with:
```js
  assert.deepEqual(out.computedValues, [{ value: '6.3', unit: 'MHz', raw: '6.3 MHz', confidence: 'low', label: null }]);
```

(The other computedValues tests assert via `.equal` on individual fields rather than full-shape `deepEqual`, so they don't need shape updates.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern computedValues`
Expected: the 4 updated tests + 6 new labeled tests fail (the new extractor doesn't exist yet).

- [ ] **Step 4: Implement `extractAnswers` (high-confidence pass)**

In `lib/answer-parser.js`, at the top of the IIFE just below `'use strict';`, lazy-load the normaliser the same way `html-cleaner.js` loads `mathFlatten`:

```js
  const valueNormalize = (function () {
    if (typeof module !== 'undefined' && module.exports) {
      return require('./value-normalize.js');
    }
    return (root.ClipboardCleaner && root.ClipboardCleaner.valueNormalize) || null;
  })();
```

Delete the `ANSWER_PATTERN`, `EQUALS_PATTERN`, and `STOP_UNITS` constants. Delete the `extractComputedValues` function. Replace all three with this new block (placed where the old extractor lived, just above `parseAnswerText`):

```js
  // Numeric value regex, post-normalisation. Matches "500", "0.0352", "1.0e-6",
  // "1.0e+3", "-3.14". Does NOT match bare "10^N" — the normaliser converts
  // those to "1eN" first.
  const VALUE_RE = '(-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)';

  // Unit regex: short letter run with optional Unicode μ/Ω/° and optional /denominator,
  // and an optional ²/³ etc. attached. Keeps "Vs/A", "cm²", "kΩ". Bounded length to
  // avoid swallowing whole sentences.
  const UNIT_RE = '([A-Za-zμΩ°][A-Za-zμΩ°/]{0,6}[²³]?)';

  // Physics units that are ALSO valid multiple-choice letters (A, B, C, ...).
  // Used by suppressUnitLetters in Task B5.
  const UNIT_LETTERS = new Set(['H','F','C','A','V','W','N','J','T','K']);

  // Words that look like a unit to the regex but are actually prose connectors.
  const STOP_UNITS = new Set([
    'and','or','but','so','is','to','for','of','the','an','a',
    'then','thus','therefore','hence','where','when','if','as','by','in','on','with',
    'plus','minus','times','divided','over','from','at','that','this','these','those',
  ]);

  // Patterns that signal a "labeled answer" (high confidence). Each pattern
  // emits {label, value, unit}. Patterns are scanned globally in document order.
  const LABEL_PATTERNS = [
    // "Q1: ...", "Q 1: ...", "Q1 ..."
    new RegExp('\\bQ\\s*(\\d{1,2})\\s*[:.=]?\\s*' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?', 'gi'),
    // "Question 1: ...", "Question 1 ..."
    new RegExp('\\bquestion\\s+(\\d{1,2})\\s*[:.=]?\\s*(?:is\\s+)?' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?', 'gi'),
    // "Answer 2 = ...", "Answer 2: ..."
    new RegExp('\\banswer\\s+(\\d{1,2})\\s*[:=]\\s*' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?', 'gi'),
    // "For #3, ... result is X" / "#3 ... = X" — capture the # number.
    new RegExp('#(\\d{1,2})\\b[^.]*?(?:result\\s+is|=)\\s*' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?', 'gi'),
    // "the answer (is|:|=) X" — no question label, but the label group is null.
    // Place last so labelled forms above win when both could match.
    new RegExp('(?:final\\s+answer|\\banswer)\\s*[:=]?\\s*(?:is\\s+)?' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?', 'gi'),
  ];

  function cleanUnit(u) {
    const t = (u || '').trim();
    if (!t) return '';
    if (STOP_UNITS.has(t.toLowerCase())) return '';
    return t;
  }

  function makeAnswer(value, unit, confidence, label) {
    const u = cleanUnit(unit);
    const raw = u ? (value + ' ' + u) : value;
    return { value: value, unit: u, raw: raw, confidence: confidence, label: label || null };
  }

  function extractLabeledAnswers(normalisedText) {
    const out = [];
    LABEL_PATTERNS.forEach(function (re) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(normalisedText)) !== null) {
        // For the question-labeled patterns, m[1] is the question number, m[2] is value, m[3] is unit.
        // For the "answer is X" pattern (no label), m[1] is value, m[2] is unit.
        let label = null, value, unit;
        if (m.length === 4) {
          label = m[1];
          value = m[2];
          unit = m[3] || '';
        } else {
          value = m[1];
          unit = m[2] || '';
        }
        if (!value) continue;
        out.push(makeAnswer(value, unit, 'high', label));
      }
    });
    return out;
  }

  // Top-level extractor used by parseAnswerText. Tasks B2/B3 will add medium-
  // and low-confidence passes; for now we only have high.
  function extractAnswers(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) return [];
    const normalised = valueNormalize ? valueNormalize.normalizeAnswerText(rawText) : rawText;
    const labeled = extractLabeledAnswers(normalised);
    // Dedup by value|unit, keeping the highest-confidence entry.
    return dedupAnswers(labeled);
  }

  function dedupAnswers(list) {
    const byKey = new Map();
    const order = ['high', 'medium', 'low'];
    list.forEach(function (a) {
      const key = a.value + '|' + (a.unit || '').toLowerCase();
      const prev = byKey.get(key);
      if (!prev || order.indexOf(a.confidence) < order.indexOf(prev.confidence)) {
        byKey.set(key, a);
      }
    });
    return Array.from(byKey.values());
  }
```

Finally update `parseAnswerText` to populate `computedValues` via the new function. Find the two existing places where `computedValues` is set:

```js
      return { letters: letters, numbers: numbers, quotedSnippets: quotedSnippets, computedValues: [], rawText: rawText };
```
and:
```js
    const computedValues = extractComputedValues(rawText);
    return { letters: letters, numbers: numbers, quotedSnippets: quotedSnippets, computedValues: computedValues, rawText: rawText };
```

The empty-input early return stays as-is. Change the second to:

```js
    const computedValues = extractAnswers(rawText);
    return { letters: letters, numbers: numbers, quotedSnippets: quotedSnippets, computedValues: computedValues, rawText: rawText };
```

- [ ] **Step 5: Run tests and verify they pass**

Run: `npm test`
Expected: the labeled-answer tests pass; the 4 existing tests with `'low'` confidence still **fail** (we haven't implemented the inline/low pass yet — they'll pass after Task B3). All other tests pass.

Note this is the only task that intentionally leaves tests red. The next two tasks complete the picture.

- [ ] **Step 6: Commit**

```bash
git add lib/answer-parser.js tests/answer-parser.test.js
git commit -m "feat(answer-parser): extractAnswers — labeled answers (high confidence)"
```

---

### Task B2: extractAnswers — list format (medium confidence)

**Files:**
- Modify: `lib/answer-parser.js`
- Modify: `tests/answer-parser.test.js`

- [ ] **Step 1: Append failing tests**

```js
test('parseAnswerText: numbered-list answers get confidence medium and the line number as label', () => {
  const out = parseAnswerText('1. 1.0000e-6 H\n2. 0.0352 H');
  assert.equal(out.computedValues.length, 2);
  assert.equal(out.computedValues[0].value, '1.0000e-6');
  assert.equal(out.computedValues[0].unit, 'H');
  assert.equal(out.computedValues[0].confidence, 'medium');
  assert.equal(out.computedValues[0].label, '1');
  assert.equal(out.computedValues[1].value, '0.0352');
  assert.equal(out.computedValues[1].label, '2');
});

test('parseAnswerText: bullet-list answers (- /•/*) get confidence medium and null label', () => {
  const out = parseAnswerText('- 1.0000×10^-6 H\n- 0.0352 H');
  assert.equal(out.computedValues.length, 2);
  assert.equal(out.computedValues[0].value, '1.0000e-6');
  assert.equal(out.computedValues[0].confidence, 'medium');
  assert.equal(out.computedValues[0].label, null);
});

test('parseAnswerText: mixed bullet styles "* X" and "• X" both match', () => {
  const out = parseAnswerText('* 1.5e-3 V\n• 2.5 A');
  assert.equal(out.computedValues.length, 2);
  assert.equal(out.computedValues[0].confidence, 'medium');
  assert.equal(out.computedValues[1].confidence, 'medium');
});

test('parseAnswerText: numbered list with Unicode superscript exponent in value', () => {
  const out = parseAnswerText('1. 1.0000×10⁻⁶ H\n2. 0.0352 H');
  assert.equal(out.computedValues[0].value, '1.0000e-6');
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test -- --test-name-pattern list`
Expected: 4 failing (medium pass not implemented).

- [ ] **Step 3: Add `extractListAnswers` and wire it into `extractAnswers`** in `lib/answer-parser.js`.

Add this function below `extractLabeledAnswers`:

```js
  // Numbered or bulleted list lines. "1. VALUE UNIT" gets label = "1";
  // "- VALUE UNIT" gets label = null. Confidence: medium.
  // Anchored at line start (post-normalisation, ^ in multiline mode).
  const NUMBERED_LINE_RE = new RegExp(
    '^\\s*(\\d{1,2})[.)\\s]\\s*' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?',
    'gm'
  );
  const BULLET_LINE_RE = new RegExp(
    '^\\s*[-•*]\\s+' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?',
    'gm'
  );

  function extractListAnswers(normalisedText) {
    const out = [];
    NUMBERED_LINE_RE.lastIndex = 0;
    let m;
    while ((m = NUMBERED_LINE_RE.exec(normalisedText)) !== null) {
      const label = m[1];
      const value = m[2];
      const unit = m[3] || '';
      if (!value) continue;
      out.push(makeAnswer(value, unit, 'medium', label));
    }
    BULLET_LINE_RE.lastIndex = 0;
    while ((m = BULLET_LINE_RE.exec(normalisedText)) !== null) {
      const value = m[1];
      const unit = m[2] || '';
      if (!value) continue;
      out.push(makeAnswer(value, unit, 'medium', null));
    }
    return out;
  }
```

Modify `extractAnswers` — find:

```js
  function extractAnswers(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) return [];
    const normalised = valueNormalize ? valueNormalize.normalizeAnswerText(rawText) : rawText;
    const labeled = extractLabeledAnswers(normalised);
    return dedupAnswers(labeled);
  }
```

Replace with:

```js
  function extractAnswers(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) return [];
    const normalised = valueNormalize ? valueNormalize.normalizeAnswerText(rawText) : rawText;
    const labeled = extractLabeledAnswers(normalised);
    const listed = extractListAnswers(normalised);
    return dedupAnswers(labeled.concat(listed));
  }
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern list`
Expected: 4 passing.

Full suite — `npm test` — should show the same 4 'low'-expecting tests from Task B1 still failing (we still haven't done the inline pass). That's expected; Task B3 fixes them.

- [ ] **Step 5: Commit**

```bash
git add lib/answer-parser.js tests/answer-parser.test.js
git commit -m "feat(answer-parser): extractAnswers — list format (medium confidence)"
```

---

### Task B3: extractAnswers — inline last-value (low confidence)

**Files:**
- Modify: `lib/answer-parser.js`
- Modify: `tests/answer-parser.test.js`

The inline pass catches `= X UNIT` style assignments. In a worked-solution paragraph with multiple `=` signs, we keep only the LAST match per paragraph (matching the existing `EQUALS_PATTERN`'s last-match behaviour).

- [ ] **Step 1: Append failing tests**

```js
test('parseAnswerText: inline last-value picks final "= X UNIT" in a paragraph', () => {
  const out = parseAnswerText('T = 1/f = 0.0167 s');
  assert.equal(out.computedValues.length, 1);
  assert.equal(out.computedValues[0].value, '0.0167');
  assert.equal(out.computedValues[0].unit, 's');
  assert.equal(out.computedValues[0].confidence, 'low');
});

test('parseAnswerText: each paragraph contributes one inline last-value', () => {
  const out = parseAnswerText('Para A: T = 1/f = 0.0167 s.\n\nPara B: V = IR = 5 V.');
  assert.equal(out.computedValues.length, 2);
  // Order is document position; both are low confidence.
  assert.ok(out.computedValues.some(function (cv) { return cv.value === '0.0167' && cv.unit === 's'; }));
  assert.ok(out.computedValues.some(function (cv) { return cv.value === '5' && cv.unit === 'V'; }));
  assert.ok(out.computedValues.every(function (cv) { return cv.confidence === 'low'; }));
});

test('parseAnswerText: labeled and inline coexist (labeled wins for same value)', () => {
  // "The answer is 42 kg" matches labeled (high). "42 kg = 42 kg." matches inline (low).
  // After dedup by value|unit, only the high-confidence entry survives.
  const out = parseAnswerText('The answer is 42 kg. Sanity: 42 kg = 42 kg.');
  assert.equal(out.computedValues.length, 1);
  assert.equal(out.computedValues[0].confidence, 'high');
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test -- --test-name-pattern inline`
Expected: failing.

Also the four 'low'-confidence test updates from Task B1 should still be failing — those become green here.

- [ ] **Step 3: Add `extractInlineAnswers`** in `lib/answer-parser.js`.

Add this function below `extractListAnswers`:

```js
  // Inline "= X UNIT" assignments, last match per paragraph. Confidence: low.
  // A paragraph is separated by a blank line.
  const INLINE_EQUALS_RE = new RegExp('=\\s*' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?', 'g');

  function extractInlineAnswers(normalisedText) {
    const out = [];
    const paragraphs = normalisedText.split(/\n[ \t]*\n+/);
    paragraphs.forEach(function (para) {
      INLINE_EQUALS_RE.lastIndex = 0;
      let last = null;
      let m;
      while ((m = INLINE_EQUALS_RE.exec(para)) !== null) {
        if (m[1]) last = m;
      }
      if (last) {
        out.push(makeAnswer(last[1], last[2] || '', 'low', null));
      }
    });
    return out;
  }
```

Modify `extractAnswers` — replace its current body with:

```js
  function extractAnswers(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) return [];
    const normalised = valueNormalize ? valueNormalize.normalizeAnswerText(rawText) : rawText;
    const labeled = extractLabeledAnswers(normalised);
    const listed = extractListAnswers(normalised);
    const inline = extractInlineAnswers(normalised);
    return dedupAnswers(labeled.concat(listed).concat(inline));
  }
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test`
Expected: 0 failures. All four 'low'-confidence tests from Task B1, the three new inline tests, and everything else, pass.

- [ ] **Step 5: Commit**

```bash
git add lib/answer-parser.js tests/answer-parser.test.js
git commit -m "feat(answer-parser): extractAnswers — inline last-value (low confidence)"
```

---

### Task B4: Suppress unit-letter MC candidates when high-confidence numeric answer exists

**Files:**
- Modify: `lib/answer-parser.js`
- Modify: `tests/answer-parser.test.js`

When the pasted text says `"The answer to question 1 is 1.0000e-6 H."`, the current letter scanner picks up `H` as a multiple-choice letter candidate. We suppress single-letter MC candidates that are ALSO physics-unit codes (`H`, `F`, `C`, `A`, `V`, `W`, `N`, `J`, `T`, `K`) IF and ONLY IF the extractor found a high-confidence numeric answer.

- [ ] **Step 1: Append failing tests**

```js
test('parseAnswerText: H is NOT a letter candidate when a high-confidence numeric answer with unit H is present', () => {
  const out = parseAnswerText('The answer to question 1 is 1.0000×10^-6 H.');
  assert.deepEqual(out.letters, []);
  assert.equal(out.computedValues.length, 1);
});

test('parseAnswerText: H IS still a letter candidate when no high-confidence numeric answer present', () => {
  // No labeled/list/inline numeric answer — just a letter mention.
  const out = parseAnswerText('Pick H, please.');
  assert.deepEqual(out.letters, ['H']);
});

test('parseAnswerText: non-unit letter (B) is preserved even when numeric answer present', () => {
  const out = parseAnswerText('The answer is 1.0e-6 H. Also pick B.');
  // Single-letter physics units suppressed (H), but B is unaffected.
  assert.ok(out.letters.indexOf('H') === -1);
  assert.ok(out.letters.indexOf('B') !== -1);
});

test('parseAnswerText: medium-confidence numeric answer (list) ALSO suppresses unit letters', () => {
  // Suppression triggers on high OR medium confidence — list-format answers
  // are explicit enough to override letter false positives.
  const out = parseAnswerText('1. 1.0e-6 H\n2. 0.0352 H');
  assert.deepEqual(out.letters, []);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test -- --test-name-pattern "unit-letter"`
Expected: failing.

- [ ] **Step 3: Add `suppressUnitLetters`** in `lib/answer-parser.js`.

Add this function near `extractAnswers`:

```js
  // When a confident numeric answer with units is present, drop any single-letter
  // MC candidates that are actually physics-unit codes (H, F, C, A, V, W, N, J, T, K).
  function suppressUnitLetters(letters, computedValues) {
    const hasConfidentNumeric = computedValues.some(function (cv) {
      return cv.confidence === 'high' || cv.confidence === 'medium';
    });
    if (!hasConfidentNumeric) return letters;
    return letters.filter(function (l) { return !UNIT_LETTERS.has(l); });
  }
```

In `parseAnswerText`, the final non-empty return currently looks like:

```js
    const computedValues = extractAnswers(rawText);
    return { letters: letters, numbers: numbers, quotedSnippets: quotedSnippets, computedValues: computedValues, rawText: rawText };
```

Replace with:

```js
    const computedValues = extractAnswers(rawText);
    const filteredLetters = suppressUnitLetters(letters, computedValues);
    return { letters: filteredLetters, numbers: numbers, quotedSnippets: quotedSnippets, computedValues: computedValues, rawText: rawText };
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test`
Expected: 0 failures. The 4 new suppression tests pass, and all prior tests still green.

- [ ] **Step 5: Commit**

```bash
git add lib/answer-parser.js tests/answer-parser.test.js
git commit -m "feat(answer-parser): suppress unit-letter MC candidates with confident numeric answer"
```

---

## Epic C — Sidebar UX

### Task C1: Confidence + count-mismatch warning in status

**Files:**
- Modify: `lib/sidebar.js`

The Apply handler currently reports `"Selected N, Filled M"`. We extend it to surface a warning tone and explanatory text when:

1. `parsed.computedValues` has any entry with `confidence === 'low'`, OR
2. `parsed.computedValues.length !== textInputs.length` and at least one of them is non-zero (i.e. a real mismatch the user should notice).

The fill still happens — we just add an inline warning string and downgrade the tone from `'success'` to `'warn'` (a new tone we'll style with the existing CSS hooks).

- [ ] **Step 1: Locate and update the Apply handler.** In `lib/sidebar.js`, find the final status-string assembly block in the `apply.addEventListener('click', ...)` body. It currently looks like:

```js
      const did = optionSummary.selected + textSummary.filled;
      if (did === 0) {
        setAnswerStatus('No options matched the parsed answer, and no text fields could be filled.', 'error');
        return;
      }
      const parts = [];
      if (optionSummary.selected > 0) parts.push('Selected ' + optionSummary.selected);
      if (textSummary.filled > 0)     parts.push('Filled ' + textSummary.filled);
      const skipped = (optionSummary.skipped || 0) + (textSummary.skipped || 0);
      if (skipped) parts.push('(' + skipped + ' skipped)');
      setAnswerStatus(parts.join(', '), 'success');
```

Replace with:

```js
      const did = optionSummary.selected + textSummary.filled;
      if (did === 0) {
        setAnswerStatus('No options matched the parsed answer, and no text fields could be filled.', 'error');
        return;
      }
      const parts = [];
      if (optionSummary.selected > 0) parts.push('Selected ' + optionSummary.selected);
      if (textSummary.filled > 0)     parts.push('Filled ' + textSummary.filled);
      const skipped = (optionSummary.skipped || 0) + (textSummary.skipped || 0);
      if (skipped) parts.push('(' + skipped + ' skipped)');

      // Confidence + count-mismatch warning. Filled values stay filled; we just
      // warn the user to double-check.
      const warnings = [];
      const cvs = (parsed.computedValues || []);
      const hasLow = cvs.some(function (cv) { return cv.confidence === 'low'; });
      if (hasLow) warnings.push('low confidence — verify values');
      if (textInputs.length > 0 && cvs.length !== textInputs.length && cvs.length > 0) {
        warnings.push(cvs.length + ' value(s) vs ' + textInputs.length + ' input(s)');
      }

      const tone = warnings.length > 0 ? 'warn' : 'success';
      const msg = parts.join(', ') + (warnings.length ? ' — ' + warnings.join('; ') : '');
      setAnswerStatus(msg, tone);
```

- [ ] **Step 2: Run the full test suite** to confirm nothing else broke.

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 3: Sanity-load the sidebar module**

Run: `node -e "const s=require('./lib/sidebar.js'); console.log(typeof s.mount)"`
Expected: `function`.

- [ ] **Step 4: Commit**

```bash
git add lib/sidebar.js
git commit -m "feat(sidebar): warn on low confidence or count mismatch in Apply status"
```

---

## Epic D — End-to-end regression

### Task D1: Regression tests for the messy AI examples

**Files:**
- Modify: `tests/answer-parser.test.js`

These tests pin the end-to-end behaviour against the exact noisy formats the user described. They exercise the full pipeline (normalize → labeled/list/inline extract → dedup → suppress).

- [ ] **Step 1: Append the regression tests**

```js
test('regression: clean numbered list from AI', () => {
  const out = parseAnswerText('1. 1.0000e-6 H\n2. 0.0352 H');
  assert.equal(out.computedValues.length, 2);
  assert.equal(out.computedValues[0].raw, '1.0000e-6 H');
  assert.equal(out.computedValues[1].raw, '0.0352 H');
});

test('regression: bullets with × notation get normalised', () => {
  const out = parseAnswerText('- 1.0000×10^-6 H\n- 0.0352 H');
  assert.equal(out.computedValues.length, 2);
  assert.equal(out.computedValues[0].raw, '1.0000e-6 H');
  assert.equal(out.computedValues[1].raw, '0.0352 H');
});

test('regression: inline prose with two answers', () => {
  const out = parseAnswerText(
    'The answer to question 1 is 1.0000×10^-6 H. For question 2, use 0.0352 H.'
  );
  assert.equal(out.computedValues.length, 2);
  // Both labeled, high confidence.
  assert.equal(out.computedValues[0].label, '1');
  assert.equal(out.computedValues[0].raw, '1.0000e-6 H');
  assert.equal(out.computedValues[1].label, '2');
  assert.equal(out.computedValues[1].raw, '0.0352 H');
  assert.ok(out.computedValues.every(function (cv) { return cv.confidence === 'high'; }));
});

test('regression: split scientific notation across three lines', () => {
  // Exactly the user's reported shape.
  const out = parseAnswerText('1.0000×10\n−6\nH');
  assert.equal(out.computedValues.length, 1);
  assert.equal(out.computedValues[0].raw, '1.0000e-6 H');
});

test('regression: Q1/Answer N/#N labels in one paste', () => {
  const out = parseAnswerText(
    'Q1: 1.0000×10^-6 H\n' +
    'Answer 2 = 0.0352 H\n' +
    'For #3, the result is 6.0781×10^-10 F.'
  );
  assert.equal(out.computedValues.length, 3);
  assert.equal(out.computedValues[0].label, '1');
  assert.equal(out.computedValues[0].raw, '1.0000e-6 H');
  assert.equal(out.computedValues[1].label, '2');
  assert.equal(out.computedValues[1].raw, '0.0352 H');
  assert.equal(out.computedValues[2].label, '3');
  assert.equal(out.computedValues[2].raw, '6.0781e-10 F');
});

test('regression: Unicode-superscript-only form (10⁻⁶ with no ×)', () => {
  const out = parseAnswerText('The result is 10⁻⁶ F.');
  // Single value extracted: "1e-6 F" via the labeled-answer "result is" path,
  // OR via the inline path if labeled didn't catch — either way confidence is reasonable.
  assert.equal(out.computedValues.length, 1);
  assert.equal(out.computedValues[0].raw, '1e-6 F');
});

test('regression: text contains both letter A and computed value with unit A — unit-letter suppressed', () => {
  // "A" should not be treated as MC candidate when there's a confident numeric
  // answer that ends in unit A.
  const out = parseAnswerText('Q1: 0.5 A');
  assert.deepEqual(out.letters, []);
  assert.equal(out.computedValues[0].unit, 'A');
});

test('regression: derivation paragraph keeps only the final value (inline last-equals)', () => {
  const out = parseAnswerText('Solve: I = V/R = 5/10 = 0.5 A. Done.');
  assert.equal(out.computedValues.length, 1);
  assert.equal(out.computedValues[0].raw, '0.5 A');
  assert.equal(out.computedValues[0].confidence, 'low');
});

test('regression: mixed forms in one paste (×, *, e-notation, capital E)', () => {
  const out = parseAnswerText('Q1: 1.0×10^-6 H\nQ2: 2.0*10^-3 V\nQ3: 3.0E-9 F');
  assert.equal(out.computedValues.length, 3);
  assert.equal(out.computedValues[0].raw, '1.0e-6 H');
  assert.equal(out.computedValues[1].raw, '2.0e-3 V');
  assert.equal(out.computedValues[2].raw, '3.0e-9 F');
});

test('regression: complex unit μH preserved through pipeline', () => {
  const out = parseAnswerText('Final answer: 57 μH');
  assert.equal(out.computedValues.length, 1);
  assert.equal(out.computedValues[0].unit, 'μH');
  assert.equal(out.computedValues[0].raw, '57 μH');
});

test('regression: MC letter answer alone still works (no numeric answer)', () => {
  const out = parseAnswerText('The correct answer is C.');
  // C is a unit code, but there's no confident numeric answer → not suppressed.
  assert.deepEqual(out.letters, ['C']);
  assert.equal(out.computedValues.length, 0);
});
```

- [ ] **Step 2: Run tests and verify they pass**

Run: `npm test`
Expected: 0 failures. Total should be roughly: previous 204 + 24 normalize + 24 parser-extension + 11 regression ≈ 263 tests.

If any test fails, investigate carefully. The most likely failure modes:

- **`'regression: Unicode-superscript-only form'`** — if the normaliser turns `10⁻⁶` into `1e-6` but no labeled-answer pattern catches `"is 1e-6 F"`. The 5th `LABEL_PATTERNS` entry `(?:final\s+answer|\banswer)\s*...` does not match `"result is"`. Add another labeled pattern:
  ```js
  new RegExp('\\b(?:result|outcome|value)\\s+is\\s+' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?', 'gi'),
  ```
  If this is needed, add it to `LABEL_PATTERNS` in Task B1 (mark as a Task B1 follow-up).

- **`'regression: derivation paragraph'`** — verify that "Solve: I = V/R = 5/10 = 0.5 A" only emits one entry. The inline pass takes the LAST `=` match per paragraph; intermediate matches like `5/10` should not produce extra entries.

- [ ] **Step 3: Commit**

```bash
git add tests/answer-parser.test.js
git commit -m "test(answer-parser): regression for messy AI-output formats"
```

---

## Self-Review Checklist (already performed)

**Spec coverage:**
- Clean numbered lists (`1. 1.0000e-6 H`) → Task B2 (medium confidence pass), regression test in D1.
- Bullets (`- ...`) → Task B2.
- Inline prose ("The answer to question 1 is X") → Task B1.
- Split scientific notation (coefficient/exponent/unit on separate lines) → Task A3.
- Unicode and formatting variants (`×10^-6`, `x10^-6`, `× 10 −6`, `10⁻⁶`, `1.0E-6`, `1.0e-6`, `1.0 * 10^-6`) → Tasks A1, A2.
- Units (H, F, μH, mA, Ω, etc.) → UNIT_RE in B1 handles letter runs with Unicode μ/Ω/°.
- Messy AI labels (`Q1:`, `Answer 2 =`, `For #3, result is`) → LABEL_PATTERNS in B1.
- False-positive avoidance: unit letters as MC → Task B4 (suppressUnitLetters).
- False-positive avoidance: derivation `=` chains → inline pass uses LAST per paragraph (Task B3).
- Prefer labeled / final → confidence ordering in `dedupAnswers` (B1).
- MC letters preserved when no numeric answer → Task B4 only suppresses when high/medium-confidence numeric present.
- Fill behaviour and warning on mismatch → Task C1.
- Chips already render (existing polish from prior plan).

**Placeholder scan:** No TBD/TODO. Every code block is complete; every command has an expected output line.

**Type consistency:**
- All answer objects across passes use the shape `{value, unit, raw, confidence, label}`. Confidence values are exactly `'high' | 'medium' | 'low'`. Label is the question-number string or `null`.
- `makeAnswer(value, unit, confidence, label)` is the single constructor used by all three passes (B1/B2/B3).
- `dedupAnswers(list)` keys by `value + '|' + unit` (lowercased), preferring higher confidence (`order.indexOf` ordering).
- `extractAnswers(rawText)` always returns an array; consumed by `parseAnswerText`'s `computedValues` field.
- `suppressUnitLetters(letters, computedValues)` only modifies the letters array — never touches numbers/quotedSnippets/computedValues.
- Sidebar warnings (C1) read `cv.confidence` and `parsed.computedValues.length` — both pinned in earlier tasks.
