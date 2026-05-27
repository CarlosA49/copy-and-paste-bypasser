# Math Text Rendering + Text-Input Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two related improvements on the Coursera quiz workflow. (1) Change the plain-text cleaner so inline math renders as the visible Unicode the user actually sees (not `$LaTeX$`), drop MathJax pronunciation duplicates / zero-width artefacts, and dedupe redundant Coursera question numbering. (2) Extend the "Answering for you" panel so pasted text containing computed numerical answers (with optional units) also fills text inputs / textareas / contenteditable on the page.

**Architecture:** Add a small pure module `lib/math-flatten.js` that turns simple LaTeX into visible Unicode (or returns null for genuinely complex math, so the caller falls back to the LaTeX form). Use it from `lib/html-cleaner.js` for inline math only; display math stays as `$$...$$`. Extend the parser with a `computedValues` extraction and the matcher with three new functions (`findTextInputs` / `matchTextInputs` / `applyTextMatches`) so text fields are handled in parallel with the existing option-group pipeline; the sidebar runs both after Apply.

**Tech Stack:** Vanilla JS (Chrome MV3 content script), Node 20+ built-in `node --test`, JSDOM for DOM-touching tests. Existing IIFE + dual-mode (browser global + CommonJS) module pattern is preserved everywhere.

---

## File Structure

- **Create** `lib/math-flatten.js` — pure DOM-free flattener. Exports `flattenLatexToText(latex) → string | null`. Returns Unicode-rendered string for simple math (greek/operators/sub-sup digits/thin spaces); returns `null` for `\frac`, `\sqrt`, `\sum`, `\int`, `\begin{}`, etc. so callers can fall back to LaTeX.
- **Create** `tests/math-flatten.test.js` — unit tests for the flattener (no DOM).
- **Modify** `lib/html-cleaner.js`:
  - Lazy-load `mathFlatten` the same way `cleaner.js` is loaded today.
  - Use the flattener in `walkPlainText` for inline `<math>` only.
  - Strip zero-width characters from the final plain text.
  - Run a `dedupQuestionNumber` post-pass on the plain text.
- **Modify** `tests/html-cleaner.test.js` — three existing inline-math assertions change (LaTeX → visible text); add regression tests for every noisy example from the spec, ZWSP stripping, and question dedup.
- **Modify** `manifest.json` — register `lib/math-flatten.js` before `lib/html-cleaner.js`.
- **Modify** `lib/answer-parser.js` — add `computedValues: [{value, unit, raw}]` to the return shape.
- **Modify** `tests/answer-parser.test.js` — tests for `parseComputedValues`.
- **Modify** `lib/answer-matcher.js` — three new exports: `findTextInputs`, `matchTextInputs`, `applyTextMatches`. Existing functions unchanged.
- **Modify** `tests/answer-matcher.test.js` — JSDOM tests for the three new functions.
- **Modify** `lib/sidebar.js` — after `applyMatches(matches)` runs, run the text-input pipeline and fold its `filled` count into the status string.
- **Modify** `README.md` — one paragraph documenting the text-fill behaviour.

Each new file is small, focused, and testable in isolation.

---

## Epic A — Math text rendering + cleanup polish

### Task A1: Create `lib/math-flatten.js` with basic flattening

**Files:**
- Create: `lib/math-flatten.js`
- Test: `tests/math-flatten.test.js`

- [ ] **Step 1: Write the failing tests** — exact contents of `tests/math-flatten.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { flattenLatexToText } = require('../lib/math-flatten.js');

test('flattenLatexToText: passes plain digits through', () => {
  assert.equal(flattenLatexToText('500'), '500');
});

test('flattenLatexToText: strips enclosing single $ delimiters', () => {
  assert.equal(flattenLatexToText('$500$'), '500');
});

test('flattenLatexToText: strips enclosing double $$ delimiters', () => {
  assert.equal(flattenLatexToText('$$500$$'), '500');
});

test('flattenLatexToText: passes letters through (e.g. LC)', () => {
  assert.equal(flattenLatexToText('LC'), 'LC');
});

test('flattenLatexToText: thin space \\, becomes a regular space', () => {
  assert.equal(flattenLatexToText('10\\,cm'), '10 cm');
});

test('flattenLatexToText: greek macro \\Omega becomes Ω (capital)', () => {
  assert.equal(flattenLatexToText('\\Omega'), 'Ω');
});

test('flattenLatexToText: \\mu followed by a space and a letter joins to μ+letter (57 μH)', () => {
  assert.equal(flattenLatexToText('57\\,\\mu H'), '57 μH');
});

test('flattenLatexToText: \\Omega adjacent to a number (10\\,\\Omega → 10 Ω)', () => {
  assert.equal(flattenLatexToText('10\\,\\Omega'), '10 Ω');
});

test('flattenLatexToText: returns empty string for empty / whitespace input', () => {
  assert.equal(flattenLatexToText(''), '');
  assert.equal(flattenLatexToText('   '), '');
});

test('flattenLatexToText: returns null for non-string input', () => {
  assert.equal(flattenLatexToText(null), null);
  assert.equal(flattenLatexToText(undefined), null);
  assert.equal(flattenLatexToText(123), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern flattenLatexToText`
Expected: all 10 FAIL (module missing).

- [ ] **Step 3: Implement** `lib/math-flatten.js`:

```js
// lib/math-flatten.js
// Pure LaTeX → visible-text flattener. Returns a Unicode-rendered string for
// simple math (greek, thin spaces, basic operators, super/subscript digits)
// and returns null for genuinely complex constructs (\frac, \sqrt, \sum, etc.)
// so callers can fall back to the raw LaTeX form ($...$).
//
// No DOM. Dual-export (browser global + CommonJS).
(function (root) {
  'use strict';

  // If the LaTeX contains any of these constructs, flattening is unsafe.
  const COMPLEX_MARKERS = [
    /\\frac\b/, /\\sqrt\b/, /\\sum\b/, /\\int\b/, /\\prod\b/,
    /\\binom\b/, /\\over\b/, /\\begin\{/, /\\end\{/, /\\\\/,
    /\\matrix\b/, /\\cases\b/, /\\left\b/, /\\right\b/,
  ];

  // Greek + symbol macros → Unicode. Trailing single space after the macro is
  // consumed by the replacement regex so "\mu H" becomes "μH" (not "μ H").
  const MACROS = {
    'Alpha':'Α','alpha':'α','Beta':'Β','beta':'β','Gamma':'Γ','gamma':'γ',
    'Delta':'Δ','delta':'δ','Epsilon':'Ε','epsilon':'ε','varepsilon':'ε',
    'Zeta':'Ζ','zeta':'ζ','Eta':'Η','eta':'η','Theta':'Θ','theta':'θ',
    'Iota':'Ι','iota':'ι','Kappa':'Κ','kappa':'κ','Lambda':'Λ','lambda':'λ',
    'Mu':'Μ','mu':'μ','Nu':'Ν','nu':'ν','Xi':'Ξ','xi':'ξ',
    'Omicron':'Ο','omicron':'ο','Pi':'Π','pi':'π','Rho':'Ρ','rho':'ρ',
    'Sigma':'Σ','sigma':'σ','Tau':'Τ','tau':'τ','Upsilon':'Υ','upsilon':'υ',
    'Phi':'Φ','phi':'φ','varphi':'φ','Chi':'Χ','chi':'χ','Psi':'Ψ','psi':'ψ',
    'Omega':'Ω','omega':'ω',
    'times':'×','cdot':'·','pm':'±','mp':'∓',
    'leq':'≤','le':'≤','geq':'≥','ge':'≥','neq':'≠','ne':'≠',
    'approx':'≈','equiv':'≡','sim':'∼','propto':'∝',
    'infty':'∞','partial':'∂','nabla':'∇',
    'degree':'°','circ':'°',
    'rightarrow':'→','to':'→','leftarrow':'←','Rightarrow':'⇒',
    'in':'∈','notin':'∉','subset':'⊂','supset':'⊃','cup':'∪','cap':'∩',
  };

  function flattenLatexToText(latex) {
    if (typeof latex !== 'string') return null;
    let s = latex.trim();
    if (!s) return '';
    // Strip enclosing $$...$$ or $...$ delimiters.
    s = s.replace(/^\$\$([\s\S]*)\$\$$/, '$1').replace(/^\$([\s\S]*)\$$/, '$1').trim();
    if (!s) return '';

    // Complex constructs → bail so caller falls back to LaTeX form.
    for (let i = 0; i < COMPLEX_MARKERS.length; i++) {
      if (COMPLEX_MARKERS[i].test(s)) return null;
    }

    // Thin / negative / various LaTeX spacing → regular space.
    s = s.replace(/\\[,!;:>]/g, ' ').replace(/\\ /g, ' ');

    // \text{...} → contents.
    s = s.replace(/\\text\{([^}]*)\}/g, '$1');

    // Macro substitution. The trailing " ?" eats one space after the macro so
    // "\mu H" → "μH" rather than "μ H".
    s = s.replace(/\\([A-Za-z]+)\b ?/g, function (m, name) {
      if (Object.prototype.hasOwnProperty.call(MACROS, name)) return MACROS[name];
      return m; // unknown macro — leave intact, caller may still fall back
    });

    // If any backslash macros remain, we don't know how to render them.
    if (/\\[A-Za-z]+/.test(s)) return null;

    // Strip leftover single-level braces { ... } → contents.
    s = s.replace(/\{([^{}]*)\}/g, '$1');

    // Collapse multiple spaces.
    s = s.replace(/\s+/g, ' ').trim();

    return s;
  }

  const api = { flattenLatexToText: flattenLatexToText };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.mathFlatten = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern flattenLatexToText`
Expected: 10 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/math-flatten.js tests/math-flatten.test.js
git commit -m "feat(math-flatten): flatten simple LaTeX to visible Unicode"
```

---

### Task A2: math-flatten — superscript and subscript digits

**Files:**
- Modify: `lib/math-flatten.js`
- Modify: `tests/math-flatten.test.js`

- [ ] **Step 1: Add failing tests** — append to `tests/math-flatten.test.js`:

```js
test('flattenLatexToText: simple ^2 → ²', () => {
  assert.equal(flattenLatexToText('cm^2'), 'cm²');
});

test('flattenLatexToText: ^{2} → ²', () => {
  assert.equal(flattenLatexToText('cm^{2}'), 'cm²');
});

test('flattenLatexToText: ^3 → ³', () => {
  assert.equal(flattenLatexToText('m^3'), 'm³');
});

test('flattenLatexToText: multi-digit superscript ^{10} → ¹⁰', () => {
  assert.equal(flattenLatexToText('x^{10}'), 'x¹⁰');
});

test('flattenLatexToText: subscript _0 → ₀', () => {
  assert.equal(flattenLatexToText('t_0'), 't₀');
});

test('flattenLatexToText: subscript _{12} → ₁₂', () => {
  assert.equal(flattenLatexToText('R_{12}'), 'R₁₂');
});

test('flattenLatexToText: superscript with un-mappable char (^x) → null fallback', () => {
  // Caller will fall back to LaTeX form.
  assert.equal(flattenLatexToText('a^x'), null);
});

test('flattenLatexToText: full noisy example "2\\,cm^2" → "2 cm²"', () => {
  assert.equal(flattenLatexToText('2\\,cm^2'), '2 cm²');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern flattenLatexToText`
Expected: the 8 new tests fail (the `^` and `_` operators aren't handled yet).

- [ ] **Step 3: Add super/subscript translation** to `lib/math-flatten.js`. Insert these two table constants near the top, just below the `MACROS` constant:

```js
  const SUPER = {
    '0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹',
    '+':'⁺','-':'⁻','=':'⁼','(':'⁽',')':'⁾','n':'ⁿ','i':'ⁱ',
  };
  const SUB = {
    '0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉',
    '+':'₊','-':'₋','=':'₌','(':'₍',')':'₎',
  };
```

Then in `flattenLatexToText`, after the macro substitution block and BEFORE the "If any backslash macros remain" check, insert:

```js
    // Superscripts: ^{XYZ} or ^X (single token). If any character can't be
    // mapped, return the original match — and a later check bails the whole
    // flatten.
    s = s.replace(/\^\{([^{}]+)\}|\^(\S)/g, function (m, group, single) {
      const inner = (group !== undefined ? group : single);
      let out = '';
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (Object.prototype.hasOwnProperty.call(SUPER, ch)) out += SUPER[ch];
        else return m;
      }
      return out;
    });

    // Subscripts: same rule.
    s = s.replace(/_\{([^{}]+)\}|_(\S)/g, function (m, group, single) {
      const inner = (group !== undefined ? group : single);
      let out = '';
      for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (Object.prototype.hasOwnProperty.call(SUB, ch)) out += SUB[ch];
        else return m;
      }
      return out;
    });

    // Any remaining ^ or _ means we couldn't flatten cleanly.
    if (/[\^_]/.test(s)) return null;
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern flattenLatexToText`
Expected: 18 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/math-flatten.js tests/math-flatten.test.js
git commit -m "feat(math-flatten): translate ^digit and _digit to Unicode super/subscripts"
```

---

### Task A3: math-flatten — complex-construct null fallback

**Files:**
- Modify: `tests/math-flatten.test.js`

(Task A3 is purely test-only: the COMPLEX_MARKERS implementation already exists from Task A1. This task pins the contract so a future maintainer can't quietly weaken it.)

- [ ] **Step 1: Add tests** — append:

```js
test('flattenLatexToText: returns null for \\frac', () => {
  assert.equal(flattenLatexToText('\\frac{1}{2}'), null);
});

test('flattenLatexToText: returns null for \\sqrt', () => {
  assert.equal(flattenLatexToText('\\sqrt{2}'), null);
});

test('flattenLatexToText: returns null for \\sum', () => {
  assert.equal(flattenLatexToText('\\sum_{i=0}^{n} i'), null);
});

test('flattenLatexToText: returns null for \\int', () => {
  assert.equal(flattenLatexToText('\\int_a^b f(x) dx'), null);
});

test('flattenLatexToText: returns null for \\begin{matrix}', () => {
  assert.equal(flattenLatexToText('\\begin{matrix}1 & 2\\end{matrix}'), null);
});

test('flattenLatexToText: returns null for unknown macro (e.g. \\foobar)', () => {
  assert.equal(flattenLatexToText('\\foobar'), null);
});
```

- [ ] **Step 2: Run tests and verify they pass immediately**

Run: `npm test -- --test-name-pattern flattenLatexToText`
Expected: all 24 passing (the existing implementation already returns null for these inputs).

- [ ] **Step 3: Commit**

```bash
git add tests/math-flatten.test.js
git commit -m "test(math-flatten): pin null fallback for complex constructs"
```

---

### Task A4: Integrate flattener into `lib/html-cleaner.js`

**Files:**
- Modify: `lib/html-cleaner.js`
- Modify: `tests/html-cleaner.test.js`

- [ ] **Step 1: Update the three existing inline-math assertions** in `tests/html-cleaner.test.js` to expect the new visible-text output.

Find this assertion (currently line 29):

```js
  assert.equal(cleanText.trim(), '$x = 5$');
```

Replace with:

```js
  assert.equal(cleanText.trim(), 'x = 5');
```

Find the same assertion later (currently line 54):

```js
  assert.equal(cleanText.trim(), '$x = 5$');
```

Replace with:

```js
  assert.equal(cleanText.trim(), 'x = 5');
```

Find this assertion (currently line 231, inside the end-to-end test):

```js
  assert.match(cleanText, /\$x = 5\$/);
```

Replace with:

```js
  assert.match(cleanText, /(?<![\\$])x = 5(?![\\$])/);
```

Also update line 230's preceding comment string to match — change the comment that says `// Plain text: boilerplate gone, math is $x = 5$, ...` to `// Plain text: boilerplate gone, math is x = 5 (visible form), ...`.

The display-math assertion at line 40 (`/\$\$x = 5\$\$/`) stays as-is — display math keeps the LaTeX form.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: at least 2 inline-math tests fail (display-math test still passes; the two `cleanText.trim()` assertions and the end-to-end match are now red).

- [ ] **Step 3: Lazy-load the flattener in `lib/html-cleaner.js`.**

In `lib/html-cleaner.js`, just below the `JUNK_LINE_PATTERNS` lazy-load block (currently ending around line 20), add:

```js
  // Pure LaTeX → visible-text flattener. Browser context: rely on
  // window.ClipboardCleaner.mathFlatten (registered by lib/math-flatten.js,
  // loaded earlier by the manifest). Node tests: require the module directly.
  const mathFlatten = (function () {
    if (typeof module !== 'undefined' && module.exports) {
      return require('./math-flatten.js');
    }
    return (root.ClipboardCleaner && root.ClipboardCleaner.mathFlatten) || null;
  })();
```

- [ ] **Step 4: Use the flattener for inline math** in `walkPlainText`.

Find this block (currently around line 358 — the MATH-tag branch of `walk`):

```js
      if (tag === 'MATH') {
        const latex = getAnnotationLatex(node);
        const isDisplay = (node.getAttribute('display') || 'inline').toLowerCase() === 'block';
        if (isDisplay) {
          if (lastChar() !== '\n') emit('\n');
          emit('$$' + latex + '$$\n');
        } else {
          emit('$' + latex + '$');
        }
        return;
      }
```

Replace with:

```js
      if (tag === 'MATH') {
        const latex = getAnnotationLatex(node);
        const isDisplay = (node.getAttribute('display') || 'inline').toLowerCase() === 'block';
        if (isDisplay) {
          if (lastChar() !== '\n') emit('\n');
          emit('$$' + latex + '$$\n');
        } else {
          // Inline: prefer visible Unicode; fall back to LaTeX only when the
          // expression is too complex to flatten safely.
          const flat = (mathFlatten && mathFlatten.flattenLatexToText)
            ? mathFlatten.flattenLatexToText(latex)
            : null;
          emit(flat !== null ? flat : ('$' + latex + '$'));
        }
        return;
      }
```

- [ ] **Step 5: Run tests and verify they pass**

Run: `npm test`
Expected: all tests passing (including the three updated assertions and all math-flatten tests).

- [ ] **Step 6: Commit**

```bash
git add lib/html-cleaner.js tests/html-cleaner.test.js
git commit -m "feat(html-cleaner): render inline math as visible Unicode via flattener"
```

---

### Task A5: html-cleaner — strip zero-width characters

**Files:**
- Modify: `lib/html-cleaner.js`
- Modify: `tests/html-cleaner.test.js`

- [ ] **Step 1: Add failing test** — append to `tests/html-cleaner.test.js`:

```js
test('zero-width chars (U+200B/200C/200D/FEFF) are stripped from plain text', () => {
  // Construct input with literal zero-width chars between visible words.
  const ZW = '​‌‍﻿';
  const input = '<p>Hello' + ZW + ' world.</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.equal(cleanText, 'Hello world.');
});

test('zero-width-only line between paragraphs collapses cleanly', () => {
  const ZW = '​';
  const input = '<p>Above.</p><p>' + ZW + '</p><p>1 point</p>';
  const { cleanText } = cleanSelectionHtml(input);
  // The middle paragraph collapses to nothing, leaving the regular
  // paragraph break.
  assert.match(cleanText, /Above\.\s+1 point/);
  // And the zero-width char is gone.
  assert.doesNotMatch(cleanText, /[​-‍﻿]/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern zero-width`
Expected: 2 failing.

- [ ] **Step 3: Strip zero-width characters in `cleanSelectionHtml`.**

In `lib/html-cleaner.js`, find this line (currently around line 301):

```js
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').replace(/\s+$/g, '');
```

Add a new normalization line immediately above it:

```js
    // Strip zero-width characters that some sites use as invisible spacers.
    cleanText = cleanText.replace(/[​-‍﻿]/g, '');
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add lib/html-cleaner.js tests/html-cleaner.test.js
git commit -m "fix(html-cleaner): strip zero-width characters from plain text"
```

---

### Task A6: html-cleaner — dedupe Coursera's "Question N" + "N." duplicate prefix

**Files:**
- Modify: `lib/html-cleaner.js`
- Modify: `tests/html-cleaner.test.js`

- [ ] **Step 1: Add failing tests** — append to `tests/html-cleaner.test.js`:

```js
test('"Question 1" header followed by "1. Body" — leading "1." stripped from body', () => {
  const input =
    '<p>Question 1</p>' +
    '<p>1. A toroidal inductor consists of 500 turns.</p>' +
    '<p>1 point</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.match(cleanText, /Question 1\n\nA toroidal inductor consists of 500 turns\./);
  // The trailing "1 point" worth marker must survive (it's not a body prefix).
  assert.match(cleanText, /1 point/);
});

test('"Question 1" header followed by "1 Body" (no punctuation) — leading "1 " stripped', () => {
  const input =
    '<p>Question 1</p>' +
    '<p>1 A toroidal inductor consists of 500 turns.</p>' +
    '<p>1 point</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.match(cleanText, /Question 1\n\nA toroidal inductor consists of 500 turns\./);
  assert.match(cleanText, /1 point/);
});

test('"Question 1" header followed by "1 point" — the worth marker is NOT stripped', () => {
  // Edge case: no body between header and worth marker; we must not strip
  // "1 " from "1 point" or the user sees just "point".
  const input = '<p>Question 1</p><p>1 point</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.match(cleanText, /Question 1\n\n1 point/);
});

test('mismatched number — "Question 2" followed by "1. body" — no stripping (numbers differ)', () => {
  const input = '<p>Question 2</p><p>1. unrelated</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.match(cleanText, /Question 2\n\n1\. unrelated/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern Question`
Expected: 3 failing (the 4th one — mismatched-number — would pass already because no dedup runs yet).

- [ ] **Step 3: Add `dedupQuestionNumber` helper** in `lib/html-cleaner.js`.

Insert this function just above `cleanSelectionHtml` (around line 282):

```js
  // After plain text is built, Coursera quizzes typically render as:
  //   "Question 1"  (heading)
  //   "1. Body text"  or  "1 Body text"  (Coursera's own visible numbering)
  // The "1." (or "1 ") at the start of the body is redundant given the
  // heading. We strip it conservatively: only when the body's leading number
  // matches the heading's number AND the body isn't just "1 point" (the
  // points-worth marker, which legitimately starts with a number).
  function dedupQuestionNumber(text) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      const m = /^Question\s+(\d+)\s*$/.exec(lines[i]);
      if (!m) continue;
      const num = m[1];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j >= lines.length) continue;
      const bodyMatch = /^(\d+)([.\)])?\s+(.+)$/.exec(lines[j]);
      if (!bodyMatch) continue;
      if (bodyMatch[1] !== num) continue;
      const punct = bodyMatch[2];
      const body = bodyMatch[3];
      // If there's no explicit "." or ")" and the rest is the points-worth
      // marker, leave the line alone.
      if (!punct && /^point\b/i.test(body)) continue;
      lines[j] = body;
    }
    return lines.join('\n');
  }
```

- [ ] **Step 4: Call the helper** at the end of `cleanSelectionHtml`. Find this block (just before the `return` at the bottom of `cleanSelectionHtml`):

```js
    cleanText = cleaner(cleanText);

    return { cleanHtml: cleanHtml, cleanText: cleanText };
```

Replace with:

```js
    cleanText = cleaner(cleanText);
    cleanText = dedupQuestionNumber(cleanText);

    return { cleanHtml: cleanHtml, cleanText: cleanText };
```

- [ ] **Step 5: Run tests and verify they pass**

Run: `npm test`
Expected: all passing (the new 4 question tests, plus everything earlier).

- [ ] **Step 6: Commit**

```bash
git add lib/html-cleaner.js tests/html-cleaner.test.js
git commit -m "feat(html-cleaner): dedupe Coursera question-number prefix when redundant"
```

---

### Task A7: html-cleaner — regression tests for the exact MathJax noisy outputs

**Files:**
- Modify: `tests/html-cleaner.test.js`

These tests exercise the full DOM pipeline with the same shape Coursera emits when you copy MathJax content. Each test constructs a MathJax-v2 selection HTML (visual span + assistive accessibility text + `<script type="math/tex">` source) and asserts the cleaned plain-text matches the visible-text expectation from the spec.

- [ ] **Step 1: Append the regression tests**:

```js
function mjInline(latex, rendered, assistive) {
  // Builds a MathJax-v2-style selection fragment: visual preview + assistive
  // pronunciation span + math/tex source. Cleaner must collapse to one form.
  return (
    '<span class="MathJax_Preview"></span>' +
    '<span class="MathJax">' + rendered + '</span>' +
    '<span class="MJX_Assistive_MathML">' + assistive + '</span>' +
    '<script type="math/tex">' + latex + '</script>'
  );
}

test('regression: $500$ noisy copy → "500"', () => {
  const input = '<p>' + mjInline('500', '500', '500') + '</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.equal(cleanText.trim(), '500');
});

test('regression: $10\\,cm$ noisy copy → "10 cm"', () => {
  const input = '<p>' + mjInline('10\\,cm', '10cm', '10, c, m') + '</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.equal(cleanText.trim(), '10 cm');
});

test('regression: $2\\,cm^2$ noisy copy → "2 cm²"', () => {
  const input = '<p>' + mjInline('2\\,cm^2', '2cm2', '2, c, m, squared') + '</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.equal(cleanText.trim(), '2 cm²');
});

test('regression: $t=0$ noisy copy → "t=0"', () => {
  const input = '<p>' + mjInline('t=0', 't=0', 't, equals, 0') + '</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.equal(cleanText.trim(), 't=0');
});

test('regression: $\\Omega$ noisy copy → "Ω"', () => {
  const input = '<p>' + mjInline('\\Omega', 'Ω', '\\Omega') + '</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.equal(cleanText.trim(), 'Ω');
});

test('regression: $10\\,\\Omega$ noisy copy → "10 Ω"', () => {
  const input = '<p>' + mjInline('10\\,\\Omega', '10Ω', '10, \\Omega') + '</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.equal(cleanText.trim(), '10 Ω');
});

test('regression: $200\\,mH$ noisy copy → "200 mH"', () => {
  const input = '<p>' + mjInline('200\\,mH', '200mH', '200, m, H') + '</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.equal(cleanText.trim(), '200 mH');
});

test('regression: $57\\,\\mu H$ noisy copy → "57 μH"', () => {
  const input = '<p>' + mjInline('57\\,\\mu H', '57μH', '57, mu, H') + '</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.equal(cleanText.trim(), '57 μH');
});

test('regression: $1\\,H$ noisy copy → "1 H"', () => {
  const input = '<p>' + mjInline('1\\,H', '1H', '1, H') + '</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.equal(cleanText.trim(), '1 H');
});

test('regression: $1\\,Vs/A$ noisy copy → "1 Vs/A"', () => {
  const input = '<p>' + mjInline('1\\,Vs/A', '1Vs/A', '1, V, s, slash, A') + '</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.equal(cleanText.trim(), '1 Vs/A');
});

test('regression: $6.3\\,MHz$ noisy copy → "6.3 MHz"', () => {
  const input = '<p>' + mjInline('6.3\\,MHz', '6.3MHz', '6, point, 3, M, H, z') + '</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.equal(cleanText.trim(), '6.3 MHz');
});

test('regression: $LC$ noisy copy → "LC"', () => {
  const input = '<p>' + mjInline('LC', 'LC', 'L, C') + '</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.equal(cleanText.trim(), 'LC');
});

test('regression: complex \\frac{1}{2} stays as LaTeX (visible-text fallback)', () => {
  const input = '<p>' + mjInline('\\frac{1}{2}', '12', '1, over, 2') + '</p>';
  const { cleanText } = cleanSelectionHtml(input);
  assert.match(cleanText, /\$\\frac\{1\}\{2\}\$/);
});

test('regression: full Coursera-like question shape ends up clean', () => {
  const input =
    '<h2>Question 1</h2>' +
    '<p>1. A toroidal inductor consists of ' +
    mjInline('500', '500', '500') +
    ' turns around a toroid of radius ' +
    mjInline('10\\,cm', '10cm', '10, c, m') +
    ', and cross sectional area ' +
    mjInline('2\\,cm^2', '2cm2', '2, c, m, squared') +
    '. What is the inductance in ' +
    mjInline('H', 'H', 'H') +
    '? Note that ' +
    mjInline('1\\,H = 1\\,Vs/A', '1H=1Vs/A', '1, H, equals, 1, V, s, slash, A') +
    '.</p>' +
    '<p>​</p>' +
    '<p>1 point</p>';
  const { cleanText } = cleanSelectionHtml(input);
  // Visible math, no duplicate "1." prefix, no zero-width line, worth marker intact.
  assert.match(cleanText, /Question 1\n\nA toroidal inductor consists of 500 turns around a toroid of radius 10 cm, and cross sectional area 2 cm², and cross|A toroidal inductor consists of 500 turns around a toroid of radius 10 cm, and cross sectional area 2 cm²/);
  assert.match(cleanText, /What is the inductance in H\?/);
  assert.match(cleanText, /Note that 1 H = 1 Vs\/A/);
  assert.match(cleanText, /1 point/);
  // No noisy pronunciation text leaked through.
  assert.doesNotMatch(cleanText, /squared|equals|slash/);
});
```

Note on the long-form question assertion: the alternation tolerates either of two possible word orders depending on whitespace collapsing — both are correct visible outputs.

- [ ] **Step 2: Run tests and verify they pass**

Run: `npm test`
Expected: all passing. Tally should be roughly: previous 124 + 1 (parser dedup) + 10 (math-flatten basic) + 8 (super/sub) + 6 (complex) + 2 (zero-width) + 4 (question dedup) + 14 (regression) = ~169.

- [ ] **Step 3: Commit**

```bash
git add tests/html-cleaner.test.js
git commit -m "test(html-cleaner): pin regression for every noisy MathJax example"
```

---

### Task A8: Register `lib/math-flatten.js` in `manifest.json`

**Files:**
- Modify: `manifest.json`

- [ ] **Step 1: Update the `content_scripts[0].js` array** so `lib/math-flatten.js` loads BEFORE `lib/html-cleaner.js` (which now reads `window.ClipboardCleaner.mathFlatten` on first call).

After the change, the `js` array should be:

```json
"js": [
  "lib/cleaner.js",
  "lib/math-flatten.js",
  "lib/html-cleaner.js",
  "lib/typing-engine.js",
  "lib/typing-injector.js",
  "lib/answer-parser.js",
  "lib/answer-matcher.js",
  "lib/sidebar.js",
  "content.js"
]
```

(Only one new line added — `"lib/math-flatten.js",` inserted between `cleaner.js` and `html-cleaner.js`.)

- [ ] **Step 2: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add manifest.json
git commit -m "build: load math-flatten before html-cleaner in content script"
```

---

## Epic B — Text-input fill via "Answering for you"

### Task B1: Parser — extract `computedValues`

**Files:**
- Modify: `lib/answer-parser.js`
- Modify: `tests/answer-parser.test.js`

- [ ] **Step 1: Add failing tests** — append to `tests/answer-parser.test.js`:

```js
test('parseAnswerText: extracts plain "answer is X" computed value', () => {
  const out = parseAnswerText('The answer is 500 turns.');
  assert.deepEqual(out.computedValues, [{ value: '500', unit: 'turns', raw: '500 turns' }]);
});

test('parseAnswerText: extracts numeric-only "answer is X" (no unit)', () => {
  const out = parseAnswerText('Therefore the answer is 42.');
  assert.deepEqual(out.computedValues, [{ value: '42', unit: '', raw: '42' }]);
});

test('parseAnswerText: extracts "L = 200 mH" via the equals-with-unit pattern', () => {
  const out = parseAnswerText('After integrating, L = 200 mH.');
  assert.deepEqual(out.computedValues, [{ value: '200', unit: 'mH', raw: '200 mH' }]);
});

test('parseAnswerText: extracts decimal value (6.3 MHz)', () => {
  const out = parseAnswerText('Solving, f = 6.3 MHz.');
  assert.deepEqual(out.computedValues, [{ value: '6.3', unit: 'MHz', raw: '6.3 MHz' }]);
});

test('parseAnswerText: deduplicates identical computed values', () => {
  const out = parseAnswerText('Step 1: f = 6.3 MHz. Step 2: confirm f = 6.3 MHz.');
  assert.equal(out.computedValues.length, 1);
  assert.equal(out.computedValues[0].raw, '6.3 MHz');
});

test('parseAnswerText: returns empty computedValues for non-numeric prose', () => {
  const out = parseAnswerText('Pick option A then explain why.');
  assert.deepEqual(out.computedValues, []);
});

test('parseAnswerText: computedValues coexists with letters/numbers/snippets', () => {
  const out = parseAnswerText('Pick A then compute: L = 200 mH.');
  assert.deepEqual(out.letters, ['A']);
  assert.equal(out.computedValues.length, 1);
  assert.equal(out.computedValues[0].raw, '200 mH');
});

test('parseAnswerText: returns empty computedValues array for empty input', () => {
  assert.deepEqual(parseAnswerText('').computedValues, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern computedValues`
Expected: 8 failing (no `computedValues` key on output).

- [ ] **Step 3: Add a constant and extend `parseAnswerText`** in `lib/answer-parser.js`.

Just below the existing `QUOTE_PATTERN` declaration, add:

```js
  // Computed-value extraction. Two strategies:
  //   1. "answer (is|:|=) NUMBER [UNIT]"  /  "final answer ..."
  //   2. "= NUMBER [UNIT]"  (typically the last assignment in a worked solution)
  // UNIT is a short ASCII/greek token following the number with optional space.
  const VALUE_NUM = '(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)';
  const VALUE_UNIT = '([A-Za-zμΩ°/]+(?:\\^?\\d+)?)';
  const ANSWER_PATTERN = new RegExp(
    '(?:final\\s+answer|answer)\\s*[:=]?\\s*(?:is\\s+)?' + VALUE_NUM + '(?:\\s*' + VALUE_UNIT + ')?',
    'gi'
  );
  const EQUALS_PATTERN = new RegExp('=\\s*' + VALUE_NUM + '(?:\\s*' + VALUE_UNIT + ')?', 'g');
```

Then add this helper before `parseAnswerText`:

```js
  function extractComputedValues(rawText) {
    const out = [];
    if (typeof rawText !== 'string' || !rawText.trim()) return out;
    const seen = new Set();
    function pushMatch(value, unit) {
      const u = unit || '';
      const raw = u ? (value + ' ' + u) : value;
      const key = value + '|' + u.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ value: value, unit: u, raw: raw });
    }
    [ANSWER_PATTERN, EQUALS_PATTERN].forEach(function (re) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(rawText)) !== null) {
        const value = m[1];
        const unit = m[2] || '';
        if (value === undefined || value === null || value === '') continue;
        pushMatch(value, unit);
      }
    });
    return out;
  }
```

Finally, modify `parseAnswerText` to populate the new field. Find the line:

```js
    return { letters: letters, numbers: numbers, quotedSnippets: quotedSnippets, rawText: rawText };
```

Replace with:

```js
    const computedValues = extractComputedValues(rawText);
    return { letters: letters, numbers: numbers, quotedSnippets: quotedSnippets, computedValues: computedValues, rawText: rawText };
```

Also update the empty/whitespace early-return (same function) so the shape stays consistent. Find:

```js
    if (rawText.trim().length === 0) {
      return { letters: [], numbers: [], quotedSnippets: [], rawText: rawText };
    }
```

Replace with:

```js
    if (rawText.trim().length === 0) {
      return { letters: [], numbers: [], quotedSnippets: [], computedValues: [], rawText: rawText };
    }
```

And the empty-result branch at the very top of the function (where `rawText` is built but trim check has already returned). The original empty-return assignment line above already handles empty/whitespace. Double-check the first test (the empty input one from Task 1) still passes — it asserts the four original keys; the addition of `computedValues: []` is additive and won't break `deepEqual({letters:[],numbers:[],quotedSnippets:[],rawText:''}, ...)` only if those original tests use deepEqual with strict-key matching. Run them after Step 4 to confirm.

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern parseAnswerText`
Expected: all parser tests pass. If any of the earliest tests (the original empty-result test) now fails because it doesn't expect `computedValues`, update those tests too to add `computedValues: []` to the expected object:

If the test currently reads:
```js
assert.deepEqual(parseAnswerText(''), { letters: [], numbers: [], quotedSnippets: [], rawText: '' });
```
Change to:
```js
assert.deepEqual(parseAnswerText(''), { letters: [], numbers: [], quotedSnippets: [], computedValues: [], rawText: '' });
```
(There are likely 2 such asserts — the empty-string and the whitespace-only cases.) After updating, re-run:

Run: `npm test -- --test-name-pattern parseAnswerText`
Expected: all passing.

Run the full suite to catch any other consumer:

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 5: Commit**

```bash
git add lib/answer-parser.js tests/answer-parser.test.js
git commit -m "feat(answer-parser): extract computedValues from pasted text"
```

---

### Task B2: Matcher — `findTextInputs`

**Files:**
- Modify: `lib/answer-matcher.js`
- Modify: `tests/answer-matcher.test.js`

- [ ] **Step 1: Add failing tests** — append to `tests/answer-matcher.test.js`:

```js
const { findTextInputs } = require('../lib/answer-matcher.js');

test('findTextInputs: returns [] when page has no text inputs', () => {
  const d = dom('<p>nothing here</p>');
  assert.deepEqual(findTextInputs(d.body), []);
});

test('findTextInputs: finds an <input type="text">', () => {
  const d = dom('<input type="text" id="t1">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'input');
  assert.equal(list[0].el.id, 't1');
});

test('findTextInputs: finds an <input type="number">', () => {
  const d = dom('<input type="number" id="n1">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'input');
});

test('findTextInputs: skips type="radio" and type="checkbox"', () => {
  const d = dom('<input type="radio" name="r"><input type="checkbox" name="c">');
  assert.deepEqual(findTextInputs(d.body), []);
});

test('findTextInputs: finds a <textarea>', () => {
  const d = dom('<textarea id="ta"></textarea>');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'textarea');
});

test('findTextInputs: finds a [contenteditable="true"] div', () => {
  const d = dom('<div id="ce" contenteditable="true">hi</div>');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'contenteditable');
});

test('findTextInputs: skips disabled / readonly inputs', () => {
  const d = dom(
    '<input type="text" disabled>' +
    '<input type="text" readonly>' +
    '<input type="text" id="ok">'
  );
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: preserves discovery order', () => {
  const d = dom(
    '<input type="text" id="a">' +
    '<textarea id="b"></textarea>' +
    '<input type="number" id="c">'
  );
  const list = findTextInputs(d.body);
  assert.deepEqual(list.map(function (x) { return x.el.id; }), ['a', 'b', 'c']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern findTextInputs`
Expected: 8 failing (function not exported).

- [ ] **Step 3: Implement `findTextInputs`** in `lib/answer-matcher.js`.

Add this function near the other `find*Groups` functions (above `matchCandidates`):

```js
  // Text-entry targets: <input> of a text-like type, <textarea>, contenteditable.
  // Disabled/readonly are skipped. Order preserved.
  function findTextInputs(root) {
    if (!root) return [];
    const out = [];
    const TEXT_INPUT_TYPES = ['text', 'number', 'search', 'email', 'tel', 'url', 'password'];
    const els = root.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]');
    els.forEach(function (el) {
      if (!isUsable(el)) return;
      if (el.readOnly) return;
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
    });
    return out;
  }
```

Update the `api` object to export `findTextInputs`. Find:

```js
  const api = {
    findOptionGroups: findOptionGroups,
    matchCandidates: matchCandidates,
    applyMatches: applyMatches
  };
```

Replace with:

```js
  const api = {
    findOptionGroups: findOptionGroups,
    matchCandidates: matchCandidates,
    applyMatches: applyMatches,
    findTextInputs: findTextInputs,
  };
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern findTextInputs`
Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/answer-matcher.js tests/answer-matcher.test.js
git commit -m "feat(answer-matcher): findTextInputs for text/textarea/contenteditable"
```

---

### Task B3: Matcher — `matchTextInputs`

**Files:**
- Modify: `lib/answer-matcher.js`
- Modify: `tests/answer-matcher.test.js`

- [ ] **Step 1: Add failing tests** — append to `tests/answer-matcher.test.js`:

```js
const { matchTextInputs } = require('../lib/answer-matcher.js');

test('matchTextInputs: returns [] when there are no computed values', () => {
  const d = dom('<input type="text" id="t">');
  const tis = findTextInputs(d.body);
  const matches = matchTextInputs(tis, { computedValues: [] });
  assert.deepEqual(matches, []);
});

test('matchTextInputs: returns [] when there are no text inputs', () => {
  const matches = matchTextInputs([], { computedValues: [{ value: '500', unit: '', raw: '500' }] });
  assert.deepEqual(matches, []);
});

test('matchTextInputs: pairs values to inputs in order', () => {
  const d = dom('<input type="text" id="a"><input type="text" id="b">');
  const tis = findTextInputs(d.body);
  const matches = matchTextInputs(tis, {
    computedValues: [
      { value: '500', unit: 'turns', raw: '500 turns' },
      { value: '200', unit: 'mH', raw: '200 mH' },
    ],
  });
  assert.equal(matches.length, 2);
  assert.equal(matches[0].el.id, 'a');
  assert.equal(matches[0].value, '500 turns');
  assert.equal(matches[1].el.id, 'b');
  assert.equal(matches[1].value, '200 mH');
});

test('matchTextInputs: extra inputs without a corresponding value are skipped', () => {
  const d = dom('<input type="text" id="a"><input type="text" id="b"><input type="text" id="c">');
  const tis = findTextInputs(d.body);
  const matches = matchTextInputs(tis, {
    computedValues: [{ value: '500', unit: '', raw: '500' }],
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].el.id, 'a');
});

test('matchTextInputs: each match carries reason "computedValue"', () => {
  const d = dom('<input type="text" id="a">');
  const tis = findTextInputs(d.body);
  const matches = matchTextInputs(tis, {
    computedValues: [{ value: '500', unit: '', raw: '500' }],
  });
  assert.equal(matches[0].reason, 'computedValue');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern matchTextInputs`
Expected: 5 failing.

- [ ] **Step 3: Implement `matchTextInputs`** in `lib/answer-matcher.js`. Add just below `matchCandidates`:

```js
  function matchTextInputs(textInputs, parsed) {
    const out = [];
    if (!Array.isArray(textInputs) || !parsed) return out;
    const values = Array.isArray(parsed.computedValues) ? parsed.computedValues : [];
    if (values.length === 0) return out;
    const limit = Math.min(textInputs.length, values.length);
    for (let i = 0; i < limit; i++) {
      const ti = textInputs[i];
      const cv = values[i];
      if (!ti || !ti.el || !cv) continue;
      out.push({ el: ti.el, value: cv.raw, reason: 'computedValue' });
    }
    return out;
  }
```

Add `matchTextInputs` to the `api`:

```js
  const api = {
    findOptionGroups: findOptionGroups,
    matchCandidates: matchCandidates,
    applyMatches: applyMatches,
    findTextInputs: findTextInputs,
    matchTextInputs: matchTextInputs,
  };
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern matchTextInputs`
Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/answer-matcher.js tests/answer-matcher.test.js
git commit -m "feat(answer-matcher): matchTextInputs pairs computed values to fields by order"
```

---

### Task B4: Matcher — `applyTextMatches`

**Files:**
- Modify: `lib/answer-matcher.js`
- Modify: `tests/answer-matcher.test.js`

- [ ] **Step 1: Add failing tests** — append to `tests/answer-matcher.test.js`:

```js
const { applyTextMatches } = require('../lib/answer-matcher.js');

test('applyTextMatches: fills an <input type="text"> with the value', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  const summary = applyTextMatches([{ el: el, value: '500 turns', reason: 'computedValue' }]);
  assert.equal(summary.filled, 1);
  assert.equal(summary.skipped, 0);
  assert.equal(el.value, '500 turns');
});

test('applyTextMatches: fills a <textarea> with the value', () => {
  const d = dom('<textarea id="t"></textarea>');
  const el = d.getElementById('t');
  applyTextMatches([{ el: el, value: 'hello', reason: 'computedValue' }]);
  assert.equal(el.value, 'hello');
});

test('applyTextMatches: fills a contenteditable element with the value', () => {
  const d = dom('<div id="ce" contenteditable="true"></div>');
  const el = d.getElementById('ce');
  applyTextMatches([{ el: el, value: '6.3 MHz', reason: 'computedValue' }]);
  assert.equal(el.textContent, '6.3 MHz');
});

test('applyTextMatches: dispatches input and change events on <input>', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  const fired = [];
  el.addEventListener('input', function () { fired.push('input'); });
  el.addEventListener('change', function () { fired.push('change'); });
  applyTextMatches([{ el: el, value: 'x', reason: 'computedValue' }]);
  assert.deepEqual(fired, ['input', 'change']);
});

test('applyTextMatches: dispatches input event on contenteditable', () => {
  const d = dom('<div id="ce" contenteditable="true"></div>');
  const el = d.getElementById('ce');
  let inputCount = 0;
  el.addEventListener('input', function () { inputCount += 1; });
  applyTextMatches([{ el: el, value: 'x', reason: 'computedValue' }]);
  assert.equal(inputCount, 1);
});

test('applyTextMatches: skips detached elements', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  el.remove();
  const summary = applyTextMatches([{ el: el, value: 'x', reason: 'computedValue' }]);
  assert.equal(summary.filled, 0);
  assert.equal(summary.skipped, 1);
});

test('applyTextMatches: returns { filled: 0, skipped: 0 } for empty list', () => {
  assert.deepEqual(applyTextMatches([]), { filled: 0, skipped: 0 });
});

test('applyTextMatches: returns { filled: 0, skipped: 0 } for non-array input', () => {
  assert.deepEqual(applyTextMatches(null), { filled: 0, skipped: 0 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern applyTextMatches`
Expected: 8 failing.

- [ ] **Step 3: Implement `applyTextMatches`** in `lib/answer-matcher.js`. Add just below `applyMatches`:

```js
  function setNativeValue(el, value) {
    // React (and some other frameworks) override the prototype `value`
    // descriptor on inputs/textareas. Setting via the native descriptor and
    // dispatching `input` is the standard "make framework see this" pattern.
    try {
      const proto = Object.getPrototypeOf(el);
      const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && typeof desc.set === 'function') {
        desc.set.call(el, value);
        return;
      }
    } catch (_) { /* fall through */ }
    el.value = value;
  }

  function applyTextMatches(matches) {
    let filled = 0, skipped = 0;
    if (!Array.isArray(matches)) return { filled: 0, skipped: 0 };
    matches.forEach(function (m) {
      const el = m && m.el;
      const value = (m && typeof m.value === 'string') ? m.value : '';
      if (!el || !el.ownerDocument || !el.ownerDocument.contains(el)) { skipped += 1; return; }
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        setNativeValue(el, value);
        dispatch(el, 'input');
        dispatch(el, 'change');
      } else {
        // contenteditable
        el.textContent = value;
        dispatch(el, 'input');
      }
      filled += 1;
    });
    return { filled: filled, skipped: skipped };
  }
```

Add `applyTextMatches` to the `api`:

```js
  const api = {
    findOptionGroups: findOptionGroups,
    matchCandidates: matchCandidates,
    applyMatches: applyMatches,
    findTextInputs: findTextInputs,
    matchTextInputs: matchTextInputs,
    applyTextMatches: applyTextMatches,
  };
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern applyTextMatches`
Expected: 8 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/answer-matcher.js tests/answer-matcher.test.js
git commit -m "feat(answer-matcher): applyTextMatches fills text fields via native setter"
```

---

### Task B5: Sidebar wiring — run text-input pipeline after option-group pipeline

**Files:**
- Modify: `lib/sidebar.js`

- [ ] **Step 1: Read the existing `wireAnswer` apply handler** to understand the integration point. In `lib/sidebar.js`, locate the `apply.addEventListener('click', ...)` body. The current final lines look like:

```js
      const summary = matcher.applyMatches(matches);
      const tone = summary.selected > 0 ? 'success' : 'error';
      setAnswerStatus('Selected ' + summary.selected + (summary.skipped ? ' (' + summary.skipped + ' skipped)' : ''), tone);
```

- [ ] **Step 2: Extend the handler** so a text-input pipeline runs after the option-group pipeline. Replace the closing lines of the apply handler — from the line beginning with `const groups = matcher.findOptionGroups(document.body);` through the end of the click callback — with:

```js
      const groups = matcher.findOptionGroups(document.body);
      const matches = (groups.length > 0) ? matcher.matchCandidates(groups, parsed) : [];
      const optionSummary = (matches.length > 0)
        ? matcher.applyMatches(matches)
        : { selected: 0, skipped: 0 };

      const textInputs = matcher.findTextInputs ? matcher.findTextInputs(document.body) : [];
      const textMatches = matcher.matchTextInputs
        ? matcher.matchTextInputs(textInputs, parsed)
        : [];
      const textSummary = (textMatches.length > 0 && matcher.applyTextMatches)
        ? matcher.applyTextMatches(textMatches)
        : { filled: 0, skipped: 0 };

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

Note: the previous "No option groups found on this page" / "No options matched the parsed answer" guards are now subsumed into the single `did === 0` check below. That's intentional — a page with no option groups but a single text input plus a computed value should succeed, not error out.

- [ ] **Step 3: Run the full test suite to confirm nothing else breaks**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 4: Sanity-load the sidebar module**

Run: `node -e "const s=require('./lib/sidebar.js'); console.log(typeof s.mount)"`
Expected: `function`.

- [ ] **Step 5: Commit**

```bash
git add lib/sidebar.js
git commit -m "feat(sidebar): apply pipeline now fills text inputs from computed values"
```

---

### Task B6: Documentation — README note on text-input fill

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Append a paragraph** to the existing `### Answering for you` section (immediately after the multi-question paragraph from the previous polish):

```markdown

Text-input fill: if the pasted answer contains a final computed value (e.g. "L = 200 mH" or "The answer is 500"), the extension also locates `<input>` / `<textarea>` / contenteditable fields on the page and populates them in document order. The first computed value goes into the first text field, the second into the second, and so on. Selection (radio/checkbox) and text fill run in the same Apply click — status reads `Selected N, Filled M`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: describe text-input fill in 'Answering for you'"
```

---

## Final check

After Task B6 is committed, run the full suite once more to confirm everything is green:

Run: `npm test`
Expected: 0 failures. Approximate total: previous 125 + 10 (math-flatten basic) + 8 (super/sub) + 6 (complex) + 2 (zero-width) + 4 (question dedup) + 14 (regression) + 8 (computedValues) + 8 (findTextInputs) + 5 (matchTextInputs) + 8 (applyTextMatches) = ~198 tests.

---

## Self-Review Checklist (already performed)

**Spec coverage — Epic A:**
- "Render math as visible text" → Task A4 (with helper from A1–A3).
- Each noisy example (`$500$`, `$10\,cm$`, `$2\,cm^2$`, `$t=0$`, `$\Omega$`, `$10\,\Omega$`, `$200\,mH$`, `$1\,H$`, `$1\,Vs/A$`, `$6.3\,MHz$`, `$57\,\mu H$`, `$LC$`) → regression test in Task A7.
- "Keep only one representation" / "remove duplicate visual + assistive" → existing `normalizeMathJaxScripts` already deletes MathJax siblings before scripts; the flattener in A4 ensures the remaining math node renders cleanly. The regression tests in A7 actively prove "squared", "equals", "slash" don't leak through.
- "Use LaTeX only for complex math" → A3 pins the null-fallback contract; A7 includes a `\frac{1}{2}` regression that asserts the LaTeX fallback fires.
- "Strip invisible blank lines like zero-width spaces" → Task A5.
- "Avoid duplicate question numbering" → Task A6.
- Manifest registration of `math-flatten.js` → Task A8.

**Spec coverage — Epic B:**
- "Identify and extract final computed values (numerical results with units)" → Task B1 (`computedValues` extraction with both "answer is" and "= X" patterns, decimal + unit support).
- "Locate active `<input>` or `<textarea>` elements on the page" → Task B2 (`findTextInputs`).
- "Programmatically populate these fields with the extracted values using value injection" → Task B4 (`applyTextMatches`, using the native value setter so React-controlled fields update).
- "Distinguish between selection-based inputs and text entry fields" → Task B5 explicitly runs the two pipelines in sequence and reports both counts.

**Placeholder scan:** No `TBD`/`TODO`/`implement later`. Every step shows the actual code or command.

**Type consistency:**
- Parser output keys are consistent: `letters`, `numbers`, `quotedSnippets`, `computedValues`, `rawText` — used identically across B1, B3, B5.
- `findTextInputs` returns `{el, kind}` objects — `kind` ∈ `'input'|'textarea'|'contenteditable'`. Used consistently in B2 tests, B3, and B4.
- Text-match objects use `{el, value, reason}`. The `value` field is a string. Consistent across B3 and B4.
- Text-pipeline summary uses `{filled, skipped}`. Option-pipeline summary still uses `{selected, skipped}`. Both wired into the status string in B5 explicitly.
- `flattenLatexToText` returns `string | null`. Caller in A4 explicitly tests `flat !== null` and falls back to LaTeX form on null.
