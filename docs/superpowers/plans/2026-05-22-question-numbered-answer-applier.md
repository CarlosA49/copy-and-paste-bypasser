# Question-Numbered Answer Applier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the "Apply to page" flow from skipping later Coursera questions when the answer list contains symbolic math, units, LaTeX `\times`, wrapped parentheses, or a non-numeric (radio) option. Move the matcher off positional zipping (`textInputs[i] ↔ computedValues[i]`) and onto an explicit question-number map, so 11 answers reliably fill 11 questions even when Q10 is a radio.

**Architecture:** Introduce a question-numbered pipeline that parallels the existing letter/number/quote/computedValue path. Three new pure-logic modules + one DOM orchestrator, all dual-export IIFEs matching the project style:

- `lib/math-normalize.js` — Coursera math syntax normaliser (`\times`→`*`, implicit-`*`, strip outer parens, strip units, LaTeX brace cleanup).
- `lib/numbered-parser.js` — cascading parser pipeline (JSON → fenced JSON → numbered list → `Question N:` → line fallback) returning `[{questionNumber, rawAnswer}]` with mapping preserved.
- `lib/question-detector.js` — finds Coursera question containers with type detection (`math_input` / `single_choice` / `multiple_choice`) and ordered question numbers.
- `lib/answer-applier.js` — orchestrator. Iterates *over detected questions*, looks up the answer by question number, normalises per type, fills/clicks with retry+verify, returns a structured log/summary.

Existing `lib/answer-parser.js` and `lib/answer-matcher.js` stay untouched as the legacy fallback path: when `numbered-parser` extracts ≥ 1 numbered answer, the new applier runs; otherwise the sidebar falls back to today's behaviour (so "the answer is A and C" still works).

**Tech Stack:** Vanilla JS (Chrome MV3 content script). Node 20+ `node --test`. JSDOM for DOM tests. IIFE + dual-mode (`module.exports` / `window.ClipboardCleaner.<name>`) pattern preserved.

**Root cause (for plan readers):** `lib/answer-matcher.js:267` (`matchTextInputs`) zips `textInputs[i]` with `parsed.computedValues[i]`. `lib/answer-parser.js`'s `NUMBERED_LINE_RE` requires a *numeric* value, so symbolic answers (Q2 `2*epsilon_o*E_o/r`, Q4 `-2*k`) and the radio text Q10 `Diamagnetism` never enter `computedValues`. After dedup, the list runs out before the 11 inputs do — the loop silently exits at `Math.min(textInputs.length, values.length)`. Q10 never reaches the option-matcher either, because "Diamagnetism" is unquoted prose, not a letter / number / quoted snippet.

---

## File Structure

**Create:**
- `lib/math-normalize.js` — pure text in, Coursera-syntax text out.
- `lib/numbered-parser.js` — pure parser. Returns `[{questionNumber, rawAnswer}]`.
- `lib/question-detector.js` — pure DOM read. Returns `[{questionNumber, titleText, fullText, type, choices, targets}]`.
- `lib/answer-applier.js` — DOM orchestrator. Returns `{detectedQuestions, parsedAnswers, results: [{questionNumber, type, status, reason, valueUsed}], summary: {total, filled, failed}}`.
- `tests/math-normalize.test.js`
- `tests/numbered-parser.test.js`
- `tests/question-detector.test.js`
- `tests/answer-applier.test.js`

**Modify:**
- `lib/sidebar.js` — `wireAnswer` Apply handler dispatches to `answerApplier.apply()` when numbered answers exist; otherwise keeps today's flow. Render the per-question result list in status / summary. Add new skip-reason strings to `HUMAN_REASONS`.
- `manifest.json` — add the four new script paths to `content_scripts[0].js` in the order `math-normalize.js → numbered-parser.js → question-detector.js → answer-applier.js` (before `sidebar.js`).

**Self-contained boundaries:** each new file has a single responsibility and a stable public API. They depend downward only: `answer-applier` → (`question-detector`, `numbered-parser`, `math-normalize`, existing `answer-matcher` for the click/setNativeValue helpers via direct require). No circular deps. `numbered-parser` and `math-normalize` are pure (no DOM).

---

## Task 1: `math-normalize.js` — Coursera math syntax normaliser

**Files:**
- Create: `lib/math-normalize.js`
- Test: `tests/math-normalize.test.js`

Normalises a single answer string to Coursera-acceptable syntax. Only used for `math_input`/`numerical` question types — radio/checkbox choice text is passed through untouched.

Rules (in order, applied repeatedly until stable):
1. Replace LaTeX `\times` → `*`. Replace Unicode `×` → `*`.
2. Replace LaTeX `^{N}` braces → `^N` (e.g. `10^{-5}` → `10^-5`).
3. Remove LaTeX `\` prefixes from words (`\sqrt` → `sqrt`, `\sin` → `sin`, `\cos` → `cos`, `\ln` → `ln`, `\log` → `log`, `\pi` → `pi`).
4. Strip trailing unit suffix: a single space then a short unit token (≤ 8 chars of `[A-Za-zμΩ°/]` plus optional `²³`) at end of string is dropped. Examples kept by allow-list: do not strip a token that is `pi`, `E`, `epsilon_o`, `E_o`, `e` (Euler), `sqrt`, `sin`, `cos`, `tan`, `ln`, `log`. (These are math identifiers, not units.)
5. Strip outer wrapping parentheses iff they are balanced and not mathematically necessary — i.e. the parens enclose the entire trimmed string AND removing them keeps the expression balanced. `(2*x)` → `2*x`; `(a+b)/c` is kept because the outer `(` isn't paired with the final char.
6. Insert implicit `*` between adjacent identifiers / numbers: `2epsilon_o` → `2*epsilon_o`, `epsilon_oE_o` → `epsilon_o*E_o`. Implementation: tokenise into runs of `[0-9.]` / `[A-Za-z][A-Za-z0-9_]*` / single operators / parens; join adjacent number↔identifier or identifier↔identifier with `*`. Never insert across operators.
7. Collapse runs of whitespace; trim.

Public API:
```js
function normalizeMathAnswer(raw) { /* returns string */ }
module.exports = { normalizeMathAnswer };
```

- [ ] **Step 1: Write the failing test** — create `tests/math-normalize.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMathAnswer } = require('../lib/math-normalize.js');

test('normalizeMathAnswer: passes plain decimal through', () => {
  assert.equal(normalizeMathAnswer('0.0539'), '0.0539');
});

test('normalizeMathAnswer: inserts implicit * and strips outer parens', () => {
  assert.equal(normalizeMathAnswer('(2epsilon_oE_o/r)'), '2*epsilon_o*E_o/r');
});

test('normalizeMathAnswer: handles (-2k)', () => {
  assert.equal(normalizeMathAnswer('(-2k)'), '-2*k');
});

test('normalizeMathAnswer: converts LaTeX \\times and strips units', () => {
  assert.equal(normalizeMathAnswer('(3.7647\\times10^5) N/C'), '3.7647*10^5');
});

test('normalizeMathAnswer: handles LaTeX brace exponent', () => {
  assert.equal(normalizeMathAnswer('(3.9789\\times10^{-5}) C/m²'), '3.9789*10^-5');
});

test('normalizeMathAnswer: strips voltage unit', () => {
  assert.equal(normalizeMathAnswer('15058.7876 V'), '15058.7876');
});

test('normalizeMathAnswer: strips μC/m² unit', () => {
  assert.equal(normalizeMathAnswer('8.0000 μC/m²'), '8.0000');
});

test('normalizeMathAnswer: strips bare unit suffix m', () => {
  assert.equal(normalizeMathAnswer('300 m'), '300');
});

test('normalizeMathAnswer: zero passes through', () => {
  assert.equal(normalizeMathAnswer('0'), '0');
});

test('normalizeMathAnswer: preserves necessary parens (a+b)/c', () => {
  assert.equal(normalizeMathAnswer('(a+b)/c'), '(a+b)/c');
});

test('normalizeMathAnswer: does not insert * before known identifier-like math tokens', () => {
  // "2pi" should become "2*pi", but "pi" alone stays "pi"
  assert.equal(normalizeMathAnswer('2pi'), '2*pi');
  assert.equal(normalizeMathAnswer('pi'), 'pi');
});

test('normalizeMathAnswer: handles Unicode × too', () => {
  assert.equal(normalizeMathAnswer('3.7647×10^5'), '3.7647*10^5');
});

test('normalizeMathAnswer: empty / non-string returns empty', () => {
  assert.equal(normalizeMathAnswer(''), '');
  assert.equal(normalizeMathAnswer(null), '');
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npm test -- --test-name-pattern="normalizeMathAnswer"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/math-normalize.js`**

```js
// lib/math-normalize.js
// Pure text normaliser. Turns AI math-answer strings into Coursera-acceptable
// syntax: `\times` → `*`, implicit `*`, strip outer parens, strip trailing
// units, LaTeX brace cleanup. No DOM. Dual-export.
(function (root) {
  'use strict';

  // Identifiers Coursera recognises as math, not units. They must NOT be stripped
  // when they appear as a trailing token, and they must NOT trigger implicit-*
  // insertion when they are the whole answer.
  const MATH_IDENTS = new Set([
    'pi', 'e', 'E', 'epsilon_o', 'E_o', 'sqrt', 'sin', 'cos', 'tan',
    'ln', 'log', 'exp', 'abs'
  ]);

  function replaceLatexTimes(s) {
    return s.replace(/\\times/g, '*').replace(/×/g, '*');
  }

  function replaceLatexBraces(s) {
    // 10^{-5}  ->  10^-5
    return s.replace(/\^\{([^}]+)\}/g, '^$1');
  }

  function stripLatexBackslashes(s) {
    // \sqrt -> sqrt, \pi -> pi, \cdot -> *
    s = s.replace(/\\cdot\b/g, '*');
    s = s.replace(/\\([A-Za-z]+)/g, '$1');
    return s;
  }

  // Remove a single pair of outer parens iff they enclose the whole string AND
  // the opening `(` matches the closing `)` (i.e. nothing breaks balance).
  function stripOuterParens(s) {
    let t = s.trim();
    while (t.length >= 2 && t.charAt(0) === '(' && t.charAt(t.length - 1) === ')') {
      let depth = 0;
      let matched = true;
      for (let i = 0; i < t.length; i++) {
        const c = t.charAt(i);
        if (c === '(') depth++;
        else if (c === ')') {
          depth--;
          if (depth === 0 && i < t.length - 1) { matched = false; break; }
        }
      }
      if (!matched || depth !== 0) break;
      t = t.slice(1, -1).trim();
    }
    return t;
  }

  // Tokenise into number / identifier / single-char operator / paren tokens.
  // Then walk and insert "*" between adjacent value-bearing tokens
  // (number-then-identifier, identifier-then-identifier, identifier-then-number,
  // number-then-paren-open, identifier-then-paren-open, paren-close-then-...).
  function insertImplicitMultiplication(s) {
    const tokens = [];
    let i = 0;
    while (i < s.length) {
      const c = s.charAt(i);
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) {
        let j = i;
        while (j < s.length && /[0-9.]/.test(s.charAt(j))) j++;
        tokens.push({ kind: 'num', text: s.slice(i, j) });
        i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        let j = i;
        while (j < s.length && /[A-Za-z0-9_]/.test(s.charAt(j))) j++;
        tokens.push({ kind: 'id', text: s.slice(i, j) });
        i = j;
        continue;
      }
      tokens.push({ kind: 'op', text: c });
      i++;
    }
    const out = [];
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      const prev = out[out.length - 1];
      if (prev) {
        const needsStar =
          (prev.kind === 'num' && t.kind === 'id') ||
          (prev.kind === 'id'  && t.kind === 'id') ||
          (prev.kind === 'id'  && t.kind === 'num') ||
          (prev.kind === 'num' && t.text === '(') ||
          (prev.kind === 'id'  && t.text === '(') ||
          (prev.text === ')'   && (t.kind === 'num' || t.kind === 'id' || t.text === '('));
        if (needsStar) out.push({ kind: 'op', text: '*' });
      }
      out.push(t);
    }
    return out.map(function (t) { return t.text; }).join('');
  }

  // Strip a trailing unit token. The token must be 1–8 chars of letters/μΩ°/
  // optionally followed by ² or ³, and NOT be in MATH_IDENTS.
  // Only strips if a single whitespace precedes the token.
  function stripTrailingUnit(s) {
    const m = s.match(/^(.*\S)\s+([A-Za-zμΩ°][A-Za-zμΩ°/]{0,6}[²³]?)\s*$/);
    if (!m) return s;
    const lhs = m[1];
    const unit = m[2];
    if (MATH_IDENTS.has(unit)) return s;
    // Don't strip if lhs ends with an operator — that would leave dangling syntax.
    if (/[+\-*/^=(]\s*$/.test(lhs)) return s;
    return lhs;
  }

  function normalizeMathAnswer(raw) {
    if (typeof raw !== 'string') return '';
    let s = raw.trim();
    if (!s) return '';
    s = replaceLatexTimes(s);
    s = replaceLatexBraces(s);
    s = stripLatexBackslashes(s);
    s = stripOuterParens(s);
    s = stripTrailingUnit(s);
    // Loop strip+parens once more in case unit-strip exposes outer parens.
    s = stripOuterParens(s);
    s = insertImplicitMultiplication(s);
    s = s.replace(/\s+/g, '');
    return s;
  }

  const api = { normalizeMathAnswer: normalizeMathAnswer };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.mathNormalize = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npm test -- --test-name-pattern="normalizeMathAnswer"`
Expected: PASS — all 13 cases.

- [ ] **Step 5: Commit**

```bash
git add lib/math-normalize.js tests/math-normalize.test.js
git commit -m "feat(math-normalize): add Coursera math syntax normaliser"
```

---

## Task 2: `numbered-parser.js` — cascading parser pipeline

**Files:**
- Create: `lib/numbered-parser.js`
- Test: `tests/numbered-parser.test.js`

Public API:
```js
function parseNumberedAnswers(raw) {
  // returns Array<{questionNumber: number, rawAnswer: string}>
  // ordered by questionNumber ascending. De-duplicated by questionNumber
  // (first occurrence wins).
}
module.exports = { parseNumberedAnswers };
```

Layers, tried in order. The first layer that returns ≥ 2 distinct questionNumbers wins. (A single match alone is too weak — fall through.) Each layer returns `[]` on no match.

1. **Direct JSON parse:** if `JSON.parse(raw)` succeeds and the result is an object with `answers: [{question_id, answer}, …]` *or* an array of `{question_id, answer}`, extract directly.
2. **Fenced JSON:** find ```` ```json … ``` ```` or ```` ``` … ``` ```` blocks; try parse the content of each as JSON; treat as Layer 1.
3. **Brace-bounded JSON:** slice from first `{` to last `}`, try JSON parse; treat as Layer 1.
4. **Bracket-bounded JSON array:** slice from first `[` to last `]`, try JSON parse; treat as Layer 1.
5. **Numbered list regex:** match `^\s*(?:\*\*)?\s*(\d{1,2})\.?\s*(?:\*\*)?\s*[).:]?\s*(.+?)\s*$` per line (multiline, gm). Group 1 → questionNumber, group 2 → rawAnswer. Skip lines where the answer is empty or where `questionNumber > 50`.
6. **`Question N:` regex:** match `^\s*Question\s+(\d{1,2})\s*[:.\-]\s*(.+?)\s*$` per line (multiline, gm, case-insensitive).
7. **Fallback line-by-line:** strip blank lines; if every remaining line either matches `^\d{1,2}[.):]?\s+\S` *or* matches a known answer shape, treat each line as the next questionNumber starting at 1.

Pre-pass on `raw`:
- Normalise line endings: `\r\n` → `\n`, `\r` → `\n`.
- Strip BOM.
- Strip leading/trailing whitespace.

Per-answer post-processing inside the parser:
- Trim.
- Strip Markdown emphasis on the *answer text* (`**X**` → `X`, `*X*` → `X`) but only when the whole token is wrapped — never internally.
- Do **not** apply math normalisation here. The answer is returned verbatim. Math/radio decision is made by the applier based on detected question type.

- [ ] **Step 1: Write the failing tests** — create `tests/numbered-parser.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNumberedAnswers } = require('../lib/numbered-parser.js');

test('parses simple numbered list', () => {
  const r = parseNumberedAnswers('1. 0.0539\n2. 2*epsilon_o*E_o/r\n3. 0');
  assert.deepEqual(r, [
    { questionNumber: 1, rawAnswer: '0.0539' },
    { questionNumber: 2, rawAnswer: '2*epsilon_o*E_o/r' },
    { questionNumber: 3, rawAnswer: '0' },
  ]);
});

test('parses bold markdown numbered list', () => {
  const r = parseNumberedAnswers('**1.** 0.0539\n**2.** 2*epsilon_o*E_o/r');
  assert.equal(r.length, 2);
  assert.equal(r[0].questionNumber, 1);
  assert.equal(r[0].rawAnswer, '0.0539');
  assert.equal(r[1].questionNumber, 2);
  assert.equal(r[1].rawAnswer, '2*epsilon_o*E_o/r');
});

test('parses JSON answers shape', () => {
  const r = parseNumberedAnswers(JSON.stringify({
    answers: [
      { question_id: '1', answer: '0.0539' },
      { question_id: '2', answer: '2*epsilon_o*E_o/r' },
    ]
  }));
  assert.equal(r.length, 2);
  assert.equal(r[1].rawAnswer, '2*epsilon_o*E_o/r');
});

test('parses JSON inside markdown fence', () => {
  const raw = 'Here you go:\n```json\n{"answers":[{"question_id":"1","answer":"0.0539"},{"question_id":"2","answer":"x"}]}\n```\nDone.';
  const r = parseNumberedAnswers(raw);
  assert.equal(r.length, 2);
  assert.equal(r[0].rawAnswer, '0.0539');
});

test('parses "Question N:" form', () => {
  const r = parseNumberedAnswers('Question 1: 0.0539\nQuestion 2: 2*epsilon_o*E_o/r');
  assert.equal(r.length, 2);
  assert.equal(r[1].questionNumber, 2);
});

test('handles Windows line endings and blank lines', () => {
  const r = parseNumberedAnswers('1. A\r\n\r\n2. B\r\n');
  assert.deepEqual(r, [
    { questionNumber: 1, rawAnswer: 'A' },
    { questionNumber: 2, rawAnswer: 'B' },
  ]);
});

test('the exact 11-answer real-world failure case', () => {
  const raw =
    '1. 0.0539 \n' +
    '2. (2epsilon_oE_o/r)\n' +
    '3. 0\n' +
    '4. (-2k)\n' +
    '5. 0\n' +
    '6. 15058.7876 V\n' +
    '7. (3.7647\\times10^5) N/C\n' +
    '8. 8.0000 μC/m²\n' +
    '9. (3.9789\\times10^{-5}) C/m²\n' +
    '10. Diamagnetism\n' +
    '11. 300 m';
  const r = parseNumberedAnswers(raw);
  assert.equal(r.length, 11);
  // The parser must preserve raw answers verbatim — normalisation belongs to the applier.
  assert.equal(r[0].rawAnswer, '0.0539');
  assert.equal(r[1].rawAnswer, '(2epsilon_oE_o/r)');
  assert.equal(r[3].rawAnswer, '(-2k)');
  assert.equal(r[6].rawAnswer, '(3.7647\\times10^5) N/C');
  assert.equal(r[8].rawAnswer, '(3.9789\\times10^{-5}) C/m²');
  assert.equal(r[9].rawAnswer, 'Diamagnetism');
  assert.equal(r[10].rawAnswer, '300 m');
});

test('dedupes by questionNumber, first occurrence wins', () => {
  const r = parseNumberedAnswers('1. A\n1. B\n2. C');
  assert.equal(r.length, 2);
  assert.equal(r[0].rawAnswer, 'A');
  assert.equal(r[1].rawAnswer, 'C');
});

test('returns [] for empty / non-string', () => {
  assert.deepEqual(parseNumberedAnswers(''), []);
  assert.deepEqual(parseNumberedAnswers(null), []);
});

test('answers containing commas, parens, and operators are preserved', () => {
  const r = parseNumberedAnswers('1. (a+b)/c\n2. 1, 2, 3');
  assert.equal(r[0].rawAnswer, '(a+b)/c');
  assert.equal(r[1].rawAnswer, '1, 2, 3');
});

test('skips prose lines around list (line fallback ignores non-numbered prose)', () => {
  const r = parseNumberedAnswers(
    'Here are the answers:\n1. 0.0539\n2. 0\nLet me know if you need clarification.'
  );
  assert.equal(r.length, 2);
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `npm test -- --test-reporter=spec tests/numbered-parser.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/numbered-parser.js`**

```js
// lib/numbered-parser.js
// Cascading parser: turns messy AI output into an ordered list of
// {questionNumber, rawAnswer}. No DOM. No math-normalisation. Dual-export.
(function (root) {
  'use strict';

  function dedupByQuestion(items) {
    const seen = new Set();
    const out = [];
    items.forEach(function (it) {
      if (!it || typeof it.questionNumber !== 'number') return;
      if (typeof it.rawAnswer !== 'string') return;
      const ans = it.rawAnswer.trim();
      if (!ans) return;
      if (seen.has(it.questionNumber)) return;
      seen.add(it.questionNumber);
      out.push({ questionNumber: it.questionNumber, rawAnswer: ans });
    });
    out.sort(function (a, b) { return a.questionNumber - b.questionNumber; });
    return out;
  }

  function fromJSONShape(parsed) {
    const out = [];
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.answers) ? parsed.answers : null);
    if (!list) return [];
    list.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      const qid = item.question_id != null ? item.question_id : item.questionNumber;
      const ans = item.answer != null ? item.answer : item.value;
      const n = parseInt(qid, 10);
      if (!Number.isFinite(n) || n < 1 || n > 50) return;
      const s = (typeof ans === 'string') ? ans : (ans == null ? '' : String(ans));
      out.push({ questionNumber: n, rawAnswer: s });
    });
    return out;
  }

  function tryJSON(text) {
    try { return JSON.parse(text); } catch (_) { return undefined; }
  }

  // Layer 1: direct JSON.
  function layerDirect(text) {
    const p = tryJSON(text);
    if (p === undefined) return [];
    return fromJSONShape(p);
  }

  // Layer 2: fenced JSON blocks.
  function layerFenced(text) {
    const re = /```(?:json)?\s*([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const p = tryJSON(m[1].trim());
      if (p !== undefined) {
        const out = fromJSONShape(p);
        if (out.length) return out;
      }
    }
    return [];
  }

  // Layer 3: first { ... last }
  function layerBraced(text) {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a === -1 || b <= a) return [];
    const p = tryJSON(text.slice(a, b + 1));
    return p === undefined ? [] : fromJSONShape(p);
  }

  // Layer 4: first [ ... last ]
  function layerBracketed(text) {
    const a = text.indexOf('[');
    const b = text.lastIndexOf(']');
    if (a === -1 || b <= a) return [];
    const p = tryJSON(text.slice(a, b + 1));
    return p === undefined ? [] : fromJSONShape(p);
  }

  function stripWholeEmphasis(s) {
    let t = s.trim();
    while (true) {
      const m = t.match(/^\*\*(.+)\*\*$/) || t.match(/^\*(.+)\*$/);
      if (!m) break;
      t = m[1].trim();
    }
    return t;
  }

  // Layer 5: numbered list. "1. X", "1) X", "**1.** X", "**1)** X".
  function layerNumberedList(text) {
    const re = /^\s*(?:\*\*)?\s*(\d{1,2})\s*(?:\*\*)?\s*[.):]\s*(?:\*\*)?\s*(.+?)\s*$/gm;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = parseInt(m[1], 10);
      if (!Number.isFinite(n) || n < 1 || n > 50) continue;
      const ans = stripWholeEmphasis(m[2]);
      out.push({ questionNumber: n, rawAnswer: ans });
    }
    return out;
  }

  // Layer 6: "Question N:" form.
  function layerQuestionN(text) {
    const re = /^\s*Question\s+(\d{1,2})\s*[:.\-]\s*(.+?)\s*$/gim;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = parseInt(m[1], 10);
      if (!Number.isFinite(n) || n < 1 || n > 50) continue;
      out.push({ questionNumber: n, rawAnswer: stripWholeEmphasis(m[2]) });
    }
    return out;
  }

  // Layer 7: line fallback — if every non-blank line lacks a digit prefix but
  // contains a single answer, assign sequential question numbers.
  function layerLineFallback(text) {
    const lines = text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    if (lines.length === 0) return [];
    // If ANY line looks numbered, skip — Layer 5/6 should have caught it.
    if (lines.some(function (l) { return /^\d{1,2}[.):]/.test(l); })) return [];
    if (lines.length < 2) return [];
    return lines.map(function (l, i) { return { questionNumber: i + 1, rawAnswer: stripWholeEmphasis(l) }; });
  }

  function parseNumberedAnswers(raw) {
    if (typeof raw !== 'string') return [];
    let text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!text) return [];
    const layers = [layerDirect, layerFenced, layerBraced, layerBracketed,
                    layerNumberedList, layerQuestionN, layerLineFallback];
    for (let i = 0; i < layers.length; i++) {
      const out = dedupByQuestion(layers[i](text));
      if (out.length >= 2) return out;
      if (out.length === 1 && i >= 4) {
        // For text-line layers (5/6/7), a single match can be legit.
        return out;
      }
    }
    return [];
  }

  const api = { parseNumberedAnswers: parseNumberedAnswers };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.numberedParser = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm test -- --test-reporter=spec tests/numbered-parser.test.js`
Expected: PASS — all 11 cases.

- [ ] **Step 5: Commit**

```bash
git add lib/numbered-parser.js tests/numbered-parser.test.js
git commit -m "feat(numbered-parser): cascading parser preserving question numbers"
```

---

## Task 3: `question-detector.js` — find Coursera question containers

**Files:**
- Create: `lib/question-detector.js`
- Test: `tests/question-detector.test.js`

Public API:
```js
function detectQuestions(root) {
  // root: DOM Element (e.g. document.body). Returns:
  //   Array<{
  //     questionNumber: number,     // parsed from "Question N" heading
  //     titleText: string,          // e.g. "Question 9"
  //     fullText: string,           // up to 400 chars of the container text
  //     type: 'math_input' | 'input' | 'numerical' | 'single_choice' | 'multiple_choice' | 'unknown',
  //     choices: Array<{ el: Element, text: string, index: number }>,  // for radio/checkbox
  //     targets: Array<Element>,    // for input types — the editable field(s)
  //     container: Element          // the question container
  //   }>
}
module.exports = { detectQuestions };
```

Detection strategy:
1. Find every element whose visible text begins with a "Question N" header. Selectors tried in order:
   - `[data-testid^="cml-question"]`, `[data-testid*="question"]`, `[role="group"]`, `fieldset`, `div[class*="question"]`, `div[class*="Question"]`.
   - For each candidate, examine its first ~200 chars of visible text via a heading walk: look for a child or descendant whose text matches `/^Question\s+(\d{1,2})\b/i`. If found, treat that ancestor (the candidate) as the container.
2. As a fallback, walk all elements matching `*` and find every element whose direct text content matches `/^Question\s+(\d{1,2})\b/i`. Use its nearest `fieldset`/`[role="group"]`/`[class*="question" i]` ancestor as the container; if no such ancestor exists, use the heading element's parent.
3. De-dup by `questionNumber`. If two candidates have the same questionNumber, prefer the one that contains an editable field or radio/checkbox group.
4. For each container, classify the type:
   - If it contains a usable radio input (`input[type=radio]` or `[role=radio]`) — `single_choice`. Build `choices` via the existing `answer-matcher.findOptionGroups(container)` (re-use that logic).
   - Else if it contains a usable checkbox — `multiple_choice`.
   - Else if it contains an editable text-like field (`<input>` of text/number/etc, `<textarea>`, `[contenteditable=true]`, `[contenteditable=plaintext-only]`, MathQuill `.mq-editable-field`, `.MathJax` containers with editable subtree, or `[data-testid*="math"]`) — `math_input`. Set `targets` to the *visible* editable element(s); if the container has both hidden mirror inputs and visible contenteditable, take the visible one only.
   - Else — `unknown`.
5. Sort the returned array by `questionNumber` ascending. Log via `console.log` only when `options.verbose === true`.

- [ ] **Step 1: Write the failing tests** — create `tests/question-detector.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { detectQuestions } = require('../lib/question-detector.js');

function dom(html) {
  return new JSDOM('<!doctype html><html><body>' + html + '</body></html>').window.document;
}

test('detects a single text-input question with question number', () => {
  const d = dom(
    '<div data-testid="cml-question-1">' +
      '<h2>Question 1</h2>' +
      '<p>Compute X</p>' +
      '<input type="text" />' +
    '</div>'
  );
  const qs = detectQuestions(d.body);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].questionNumber, 1);
  assert.equal(qs[0].type, 'math_input');
  assert.equal(qs[0].targets.length, 1);
  assert.equal(qs[0].targets[0].tagName.toLowerCase(), 'input');
});

test('detects a single_choice radio question and lists choices', () => {
  const d = dom(
    '<div data-testid="cml-question-10">' +
      '<h2>Question 10</h2>' +
      '<fieldset>' +
        '<label><input type="radio" name="q10"> Paramagnetism</label>' +
        '<label><input type="radio" name="q10"> Diamagnetism</label>' +
        '<label><input type="radio" name="q10"> Ferromagnetism</label>' +
      '</fieldset>' +
    '</div>'
  );
  const qs = detectQuestions(d.body);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].questionNumber, 10);
  assert.equal(qs[0].type, 'single_choice');
  assert.equal(qs[0].choices.length, 3);
  assert.equal(qs[0].choices[1].text, 'Diamagnetism');
});

test('detects multiple questions in order', () => {
  const d = dom(
    '<div><h2>Question 1</h2><input type="text"></div>' +
    '<div><h2>Question 2</h2><input type="text"></div>' +
    '<div><h2>Question 3</h2><textarea></textarea></div>'
  );
  const qs = detectQuestions(d.body);
  assert.equal(qs.length, 3);
  assert.deepEqual(qs.map(function(q){return q.questionNumber;}), [1,2,3]);
});

test('detects mixed text + radio + text page (the 11-question failure shape)', () => {
  const make = function (n, inner) {
    return '<div><h2>Question ' + n + '</h2>' + inner + '</div>';
  };
  const html =
    make(1, '<input type="text">') +
    make(2, '<input type="text">') +
    make(3, '<input type="text">') +
    make(4, '<input type="text">') +
    make(5, '<input type="text">') +
    make(6, '<input type="text">') +
    make(7, '<input type="text">') +
    make(8, '<input type="text">') +
    make(9, '<input type="text">') +
    make(10,
      '<fieldset>' +
        '<label><input type="radio" name="q10"> Paramagnetism</label>' +
        '<label><input type="radio" name="q10"> Diamagnetism</label>' +
        '<label><input type="radio" name="q10"> Ferromagnetism</label>' +
      '</fieldset>') +
    make(11, '<input type="text">');
  const d = dom(html);
  const qs = detectQuestions(d.body);
  assert.equal(qs.length, 11);
  assert.equal(qs[9].type, 'single_choice');
  assert.equal(qs[9].questionNumber, 10);
  assert.equal(qs[10].type, 'math_input');
  assert.equal(qs[10].questionNumber, 11);
});

test('prefers visible contenteditable over hidden mirror input', () => {
  const d = dom(
    '<div><h2>Question 1</h2>' +
      '<input type="hidden" value="">' +
      '<div contenteditable="true">type here</div>' +
    '</div>'
  );
  const qs = detectQuestions(d.body);
  assert.equal(qs.length, 1);
  assert.equal(qs[0].type, 'math_input');
  assert.equal(qs[0].targets[0].getAttribute('contenteditable'), 'true');
});

test('returns [] when no question headers present', () => {
  const d = dom('<p>nothing here</p>');
  assert.deepEqual(detectQuestions(d.body), []);
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `npm test -- --test-reporter=spec tests/question-detector.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/question-detector.js`**

```js
// lib/question-detector.js
// DOM read: finds Coursera question containers, identifies type
// (math_input / single_choice / multiple_choice), exposes targets/choices.
// Depends on lib/answer-matcher.js for findOptionGroups (re-uses radio/checkbox
// discovery). Dual-export.
(function (root) {
  'use strict';

  const answerMatcher = (function () {
    if (typeof module !== 'undefined' && module.exports) {
      return require('./answer-matcher.js');
    }
    return (root.ClipboardCleaner && root.ClipboardCleaner.answerMatcher) || null;
  })();

  const HEAD_RE = /^\s*Question\s+(\d{1,2})\b/i;

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden === true) return false;
    if (el.type === 'hidden') return false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      if (cur.style && (cur.style.display === 'none' || cur.style.visibility === 'hidden')) return false;
      cur = cur.parentElement;
    }
    return true;
  }

  function findHeaderInside(container) {
    // Find first descendant whose direct visible text matches HEAD_RE.
    // Cheap walk: querySelectorAll('h1,h2,h3,h4,h5,h6,div,span,p,legend').
    const candidates = container.querySelectorAll('h1,h2,h3,h4,h5,h6,div,span,p,legend');
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const m = txt.match(HEAD_RE);
      if (m) return { number: parseInt(m[1], 10), titleText: m[0].trim() };
    }
    return null;
  }

  function nearestContainer(el) {
    return el.closest('fieldset, [role="radiogroup"], [role="group"], [data-testid^="cml-question"], [data-testid*="question"], div[class*="question" i]') || el.parentElement;
  }

  function collectContainers(root) {
    const seen = new Set();
    const containers = [];

    // Pass A: explicit selectors.
    const explicit = root.querySelectorAll(
      '[data-testid^="cml-question"], [data-testid*="question"], fieldset[data-testid*="question"]'
    );
    explicit.forEach(function (el) {
      if (seen.has(el)) return;
      const hdr = findHeaderInside(el);
      if (hdr) {
        seen.add(el);
        containers.push({ container: el, header: hdr });
      }
    });

    // Pass B: walk headings ourselves.
    const heads = root.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,div,span,p');
    heads.forEach(function (el) {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const m = txt.match(HEAD_RE);
      if (!m) return;
      // Skip if this heading is nested inside an already-collected container.
      const anc = el.closest('fieldset, [role="radiogroup"], [role="group"], [data-testid^="cml-question"], [data-testid*="question"], div[class*="question" i]');
      const c = anc || el.parentElement;
      if (!c || seen.has(c)) return;
      // Require the matched element to be the leftmost text of its block
      // (e.g. a heading, not buried prose). Heuristic: txt starts with "Question N".
      if (!/^Question\s+\d{1,2}\b/i.test(txt)) return;
      seen.add(c);
      containers.push({ container: c, header: { number: parseInt(m[1], 10), titleText: 'Question ' + m[1] } });
    });

    return containers;
  }

  function findRadioOrCheckbox(container) {
    if (!answerMatcher || typeof answerMatcher.findOptionGroups !== 'function') return null;
    const groups = answerMatcher.findOptionGroups(container);
    if (!groups || groups.length === 0) return null;
    // Prefer the first group; Coursera questions are 1 group per question.
    return groups[0];
  }

  // Detect editable input targets, preferring visible / non-hidden / non-mirror.
  function findEditableTargets(container) {
    const out = [];
    const TEXT_TYPES = ['text','number','email','tel','url','password','search'];
    const candidates = container.querySelectorAll(
      'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], .mq-editable-field, [data-testid*="math" i]'
    );
    candidates.forEach(function (el) {
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'INPUT') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'hidden') return;
        if (TEXT_TYPES.indexOf(t) === -1) return;
      }
      if (el.disabled) return;
      if (el.readOnly) return;
      if (!isVisible(el)) return;
      out.push(el);
    });
    // If we have both a visible contenteditable and a sibling hidden mirror,
    // prefer the contenteditable. (Already excluded type=hidden above.)
    // De-dup by element.
    const seen = new Set();
    const dedup = [];
    out.forEach(function (el) {
      if (seen.has(el)) return;
      seen.add(el); dedup.push(el);
    });
    return dedup;
  }

  function classify(container) {
    const group = findRadioOrCheckbox(container);
    if (group) {
      return {
        type: group.kind === 'radio' ? 'single_choice' : 'multiple_choice',
        choices: group.options.map(function (o) { return { el: o.el, text: o.text, index: o.index }; }),
        targets: []
      };
    }
    const targets = findEditableTargets(container);
    if (targets.length > 0) {
      return { type: 'math_input', choices: [], targets: targets };
    }
    return { type: 'unknown', choices: [], targets: [] };
  }

  function detectQuestions(root) {
    if (!root) return [];
    const raw = collectContainers(root);

    const byNumber = new Map();
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

    const list = Array.from(byNumber.values());
    list.sort(function (a, b) { return a.questionNumber - b.questionNumber; });
    return list;
  }

  const api = { detectQuestions: detectQuestions };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.questionDetector = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm test -- --test-reporter=spec tests/question-detector.test.js`
Expected: PASS — all 6 cases.

- [ ] **Step 5: Commit**

```bash
git add lib/question-detector.js tests/question-detector.test.js
git commit -m "feat(question-detector): find Coursera question containers with type"
```

---

## Task 4: `answer-applier.js` — orchestrator with retry, verify, logging

**Files:**
- Create: `lib/answer-applier.js`
- Test: `tests/answer-applier.test.js`

Public API:
```js
function applyAnswers(rawAnswerText, root, options) {
  // root: DOM Element. options: { verbose?: boolean, maxRetries?: number }
  // Returns:
  //   {
  //     detectedQuestions: number,
  //     parsedAnswers: number,
  //     results: Array<{
  //       questionNumber, type, status: 'filled' | 'selected' | 'failed' | 'no-answer' | 'no-question',
  //       rawAnswer?, normalizedAnswer?, reason?, valueUsed?
  //     }>,
  //     summary: { total, filled, failed, missingAnswers, missingQuestions }
  //   }
}
module.exports = { applyAnswers };
```

Algorithm:
1. `numberedParser.parseNumberedAnswers(rawAnswerText)` → `parsed[]` (length 0 ⇒ caller must fall back to legacy path; applier returns `{detectedQuestions: 0, parsedAnswers: 0, results: [], summary: {...}}` and the sidebar treats it as "no numbered answers, use the legacy matcher").
2. `questionDetector.detectQuestions(root)` → `questions[]`.
3. Build a `Map<number, parsedItem>` keyed by `questionNumber`.
4. For each detected question in order:
   - If no answer is mapped → push `{status: 'no-answer'}`. Log warning.
   - For `math_input`: `normalized = mathNormalize.normalizeMathAnswer(parsed.rawAnswer)`. If empty, status `failed reason='empty-after-normalize'`. Else call `fillTextField(target, normalized)`. Retry up to 3 times; between retries, `target.scrollIntoView()` and re-query the editable element inside the container (use the freshest from `questionDetector.detectQuestions(root)` filtered to this questionNumber). Verify by reading `el.value` (or `textContent` for contenteditable). On success → `{status: 'filled', valueUsed, normalizedAnswer}`. On exhaust → `{status: 'failed', reason}`.
   - For `single_choice`: `target = pickRadioChoice(question.choices, parsed.rawAnswer)`. Click it. Verify selection (`el.checked` or `aria-checked` true). On success → `{status: 'selected'}`. On fail → `{status: 'failed', reason: 'choice not matched'}`.
   - For `multiple_choice`: parse `parsed.rawAnswer` into a list (split on `,`/`and`/`[`/`]`), match each against `question.choices` (letter index or text). Click each.
   - For `unknown`: `{status: 'failed', reason: 'unknown question type'}`.
5. After the loop, count `parsed` entries not consumed → log `missingQuestions` (answers with no matching question). Build summary.

Choice-matching helper (single_choice):
1. If `raw` is a single letter A–H, map to index (`A=0`).
2. Else lowercase + collapse whitespace; if any choice text matches exactly → select.
3. Else compute jaccard over tokens; pick highest score above 0.34.

Filling helper:
- Use `answer-matcher.applyTextMatches([{el, value: normalized, reason: 'numbered'}])` so the existing variant-chain + setNativeValue logic is reused. Read back `result.results[0].filled`.
- For contenteditable, set `textContent` and dispatch `input`. The applyTextMatches helper already covers this path.

Logging (only when `options.verbose === true` OR module-level constant `LOG = true` for now; default to `true` during development):
- "Detected N questions:" + per-question line.
- "Parsed answers:" + per-answer line with raw and normalized.
- "Filling:" + per-question status line.
- "Final: Success K/N filled."
- If any failed → "Failed:" + per-question reason line.

- [ ] **Step 1: Write the failing tests** — create `tests/answer-applier.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { applyAnswers } = require('../lib/answer-applier.js');

function dom(html) {
  return new JSDOM('<!doctype html><html><body>' + html + '</body></html>').window.document;
}

function makeQuestion(n, inner) {
  return '<div data-testid="cml-question-' + n + '">' +
    '<h2>Question ' + n + '</h2>' + inner + '</div>';
}

test('11-question failure case is fully filled', () => {
  const html =
    makeQuestion(1, '<input type="text" id="q1">') +
    makeQuestion(2, '<input type="text" id="q2">') +
    makeQuestion(3, '<input type="text" id="q3">') +
    makeQuestion(4, '<input type="text" id="q4">') +
    makeQuestion(5, '<input type="text" id="q5">') +
    makeQuestion(6, '<input type="text" id="q6">') +
    makeQuestion(7, '<input type="text" id="q7">') +
    makeQuestion(8, '<input type="text" id="q8">') +
    makeQuestion(9, '<input type="text" id="q9">') +
    makeQuestion(10,
      '<fieldset>' +
        '<label><input type="radio" name="q10"> Paramagnetism</label>' +
        '<label><input type="radio" name="q10"> Diamagnetism</label>' +
        '<label><input type="radio" name="q10"> Ferromagnetism</label>' +
      '</fieldset>') +
    makeQuestion(11, '<input type="text" id="q11">');
  const d = dom(html);
  const raw =
    '1. 0.0539 \n' +
    '2. (2epsilon_oE_o/r)\n' +
    '3. 0\n' +
    '4. (-2k)\n' +
    '5. 0\n' +
    '6. 15058.7876 V\n' +
    '7. (3.7647\\times10^5) N/C\n' +
    '8. 8.0000 μC/m²\n' +
    '9. (3.9789\\times10^{-5}) C/m²\n' +
    '10. Diamagnetism\n' +
    '11. 300 m';

  const out = applyAnswers(raw, d.body, { verbose: false });

  assert.equal(out.detectedQuestions, 11);
  assert.equal(out.parsedAnswers, 11);
  assert.equal(out.summary.filled, 11);
  assert.equal(out.summary.failed, 0);

  assert.equal(d.getElementById('q1').value, '0.0539');
  assert.equal(d.getElementById('q2').value, '2*epsilon_o*E_o/r');
  assert.equal(d.getElementById('q3').value, '0');
  assert.equal(d.getElementById('q4').value, '-2*k');
  assert.equal(d.getElementById('q5').value, '0');
  assert.equal(d.getElementById('q6').value, '15058.7876');
  assert.equal(d.getElementById('q7').value, '3.7647*10^5');
  assert.equal(d.getElementById('q8').value, '8.0000');
  assert.equal(d.getElementById('q9').value, '3.9789*10^-5');
  assert.equal(d.getElementById('q11').value, '300');

  // Q10: Diamagnetism radio is checked
  const radios = d.querySelectorAll('input[name="q10"]');
  assert.equal(radios[0].checked, false);
  assert.equal(radios[1].checked, true);
  assert.equal(radios[2].checked, false);
});

test('returns no-answer entry when a question has no matching answer', () => {
  const html = makeQuestion(1, '<input type="text">') + makeQuestion(2, '<input type="text">');
  const d = dom(html);
  const out = applyAnswers('1. only-one', d.body, { verbose: false });
  assert.equal(out.summary.filled, 1);
  const q2 = out.results.find(function (r) { return r.questionNumber === 2; });
  assert.equal(q2.status, 'no-answer');
});

test('returns nothing-to-do when no numbered answers parsed', () => {
  const html = makeQuestion(1, '<input type="text">');
  const d = dom(html);
  const out = applyAnswers('The answer is A', d.body, { verbose: false });
  assert.equal(out.parsedAnswers, 0);
});

test('matches radio answer case-insensitively', () => {
  const html = makeQuestion(1,
    '<fieldset>' +
      '<label><input type="radio" name="x"> Alpha</label>' +
      '<label><input type="radio" name="x"> Beta</label>' +
    '</fieldset>');
  const d = dom(html);
  const out = applyAnswers('1. beta', d.body, { verbose: false });
  assert.equal(out.summary.filled, 1);
  const radios = d.querySelectorAll('input[name="x"]');
  assert.equal(radios[0].checked, false);
  assert.equal(radios[1].checked, true);
});

test('letter answer A maps to first radio choice', () => {
  const html = makeQuestion(1,
    '<fieldset>' +
      '<label><input type="radio" name="x"> Alpha</label>' +
      '<label><input type="radio" name="x"> Beta</label>' +
    '</fieldset>');
  const d = dom(html);
  const out = applyAnswers('1. A', d.body, { verbose: false });
  assert.equal(out.summary.filled, 1);
  const radios = d.querySelectorAll('input[name="x"]');
  assert.equal(radios[0].checked, true);
});

test('multiple_choice "A, C" ticks the right boxes', () => {
  const html = makeQuestion(1,
    '<label><input type="checkbox" name="m"> Apples</label>' +
    '<label><input type="checkbox" name="m"> Bananas</label>' +
    '<label><input type="checkbox" name="m"> Cherries</label>');
  const d = dom(html);
  const out = applyAnswers('1. A, C', d.body, { verbose: false });
  assert.equal(out.summary.filled, 1);
  const boxes = d.querySelectorAll('input[name="m"]');
  assert.equal(boxes[0].checked, true);
  assert.equal(boxes[1].checked, false);
  assert.equal(boxes[2].checked, true);
});
```

- [ ] **Step 2: Run tests, confirm they fail**

Run: `npm test -- --test-reporter=spec tests/answer-applier.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/answer-applier.js`**

```js
// lib/answer-applier.js
// Top-level orchestrator. Maps parsed numbered answers onto detected question
// containers and fills/clicks them. Uses answer-matcher's applyTextMatches for
// the variant-chain text-fill, but iterates over QUESTIONS (not inputs).
(function (root) {
  'use strict';

  function req(name, browserName) {
    if (typeof module !== 'undefined' && module.exports) return require(name);
    return root.ClipboardCleaner && root.ClipboardCleaner[browserName];
  }
  const numberedParser   = req('./numbered-parser.js',   'numberedParser');
  const questionDetector = req('./question-detector.js', 'questionDetector');
  const mathNormalize    = req('./math-normalize.js',    'mathNormalize');
  const answerMatcher    = req('./answer-matcher.js',    'answerMatcher');

  function dispatch(el, type) {
    try {
      const ev = new el.ownerDocument.defaultView.Event(type, { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
    } catch (_) { /* ignore */ }
  }

  function normalizeChoiceText(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function jaccard(a, b) {
    if (!a.length || !b.length) return 0;
    const A = new Set(a), B = new Set(b);
    let inter = 0;
    A.forEach(function (t) { if (B.has(t)) inter++; });
    const uni = A.size + B.size - inter;
    return uni === 0 ? 0 : inter / uni;
  }

  function tokens(s) {
    return normalizeChoiceText(s).split(' ').filter(function (t) { return t.length > 1; });
  }

  function pickChoice(choices, raw) {
    const r = String(raw || '').trim();
    if (!r) return null;
    if (/^[A-Ha-h]$/.test(r)) {
      const idx = r.toUpperCase().charCodeAt(0) - 65;
      if (idx >= 0 && idx < choices.length) return choices[idx];
    }
    const n = normalizeChoiceText(r);
    const direct = choices.find(function (c) { return normalizeChoiceText(c.text) === n; });
    if (direct) return direct;
    const sub = choices.find(function (c) { return normalizeChoiceText(c.text).indexOf(n) !== -1 || n.indexOf(normalizeChoiceText(c.text)) !== -1; });
    if (sub) return sub;
    let best = null, bestScore = 0;
    choices.forEach(function (c) {
      const sc = jaccard(tokens(r), tokens(c.text));
      if (sc > bestScore) { bestScore = sc; best = c; }
    });
    return (best && bestScore >= 0.34) ? best : null;
  }

  function pickMultipleChoices(choices, raw) {
    const r = String(raw || '').replace(/[\[\]]/g, '').replace(/\band\b/gi, ',');
    const parts = r.split(',').map(function (p) { return p.trim(); }).filter(Boolean);
    const out = [];
    parts.forEach(function (p) {
      const m = pickChoice(choices, p);
      if (m && out.indexOf(m) === -1) out.push(m);
    });
    return out;
  }

  function clickChoice(opt) {
    const el = opt && opt.el;
    if (!el) return false;
    if ((el.tagName || '').toUpperCase() === 'INPUT' && (el.type === 'radio' || el.type === 'checkbox')) {
      el.checked = true;
      dispatch(el, 'click');
      dispatch(el, 'input');
      dispatch(el, 'change');
      return el.checked === true;
    }
    dispatch(el, 'click');
    const aria = el.getAttribute && el.getAttribute('aria-checked');
    return aria === 'true' || aria === null;
  }

  function fillTextOnce(target, value) {
    const r = answerMatcher.applyTextMatches([{ el: target, value: value, reason: 'numbered' }]);
    const first = r && r.results && r.results[0];
    return first && first.filled
      ? { ok: true, valueUsed: first.valueUsed }
      : { ok: false, reason: first ? first.reason : 'unknown' };
  }

  function logHeader(label) { console.log('[answer-applier] ' + label); }

  function applyAnswers(rawAnswerText, rootEl, options) {
    const opts = options || {};
    const verbose = opts.verbose !== false; // default true
    const maxRetries = opts.maxRetries || 3;
    const parsed = numberedParser.parseNumberedAnswers(rawAnswerText);
    const questions = questionDetector.detectQuestions(rootEl);

    if (verbose) {
      logHeader('Detected ' + questions.length + ' questions:');
      questions.forEach(function (q) {
        const t = q.type === 'single_choice' || q.type === 'multiple_choice'
          ? q.type + ' choices=[' + q.choices.map(function (c) { return c.text; }).join(', ') + ']'
          : q.type + ' target=' + (q.targets[0] ? q.targets[0].tagName.toLowerCase() : 'none');
        console.log('  Q' + q.questionNumber + ' type=' + t);
      });
    }

    if (parsed.length === 0) {
      return {
        detectedQuestions: questions.length,
        parsedAnswers: 0,
        results: [],
        summary: { total: questions.length, filled: 0, failed: 0, missingAnswers: questions.length, missingQuestions: 0 }
      };
    }

    const ansByNum = new Map();
    parsed.forEach(function (p) { ansByNum.set(p.questionNumber, p); });

    if (verbose) {
      logHeader('Parsed answers:');
      parsed.forEach(function (p) { console.log('  Q' + p.questionNumber + ' raw="' + p.rawAnswer + '"'); });
    }

    const results = [];
    questions.forEach(function (q) {
      const p = ansByNum.get(q.questionNumber);
      if (!p) {
        results.push({ questionNumber: q.questionNumber, type: q.type, status: 'no-answer' });
        if (verbose) console.log('  Q' + q.questionNumber + ' NO ANSWER');
        return;
      }

      if (q.type === 'math_input' || q.type === 'numerical' || q.type === 'input') {
        const normalized = mathNormalize.normalizeMathAnswer(p.rawAnswer);
        if (!normalized) {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'empty-after-normalize', rawAnswer: p.rawAnswer });
          return;
        }
        let lastReason = 'unknown';
        let ok = false; let valueUsed = null;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
          // Re-query targets if attempt > 0 (Coursera may re-render).
          const target = (attempt === 0)
            ? q.targets[0]
            : (questionDetector.detectQuestions(rootEl).find(function (qq) { return qq.questionNumber === q.questionNumber; }) || q).targets[0];
          if (!target) { lastReason = 'field not found'; continue; }
          if (target.scrollIntoView) { try { target.scrollIntoView({ block: 'center' }); } catch (_) {} }
          const r = fillTextOnce(target, normalized);
          if (r.ok) { ok = true; valueUsed = r.valueUsed; break; }
          lastReason = r.reason || 'value-did-not-stick';
        }
        if (ok) {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'filled', rawAnswer: p.rawAnswer, normalizedAnswer: normalized, valueUsed: valueUsed });
          if (verbose) console.log('  Q' + q.questionNumber + ' ' + q.type + ' success "' + valueUsed + '"');
        } else {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: lastReason, rawAnswer: p.rawAnswer, normalizedAnswer: normalized });
          if (verbose) console.log('  Q' + q.questionNumber + ' ' + q.type + ' FAIL ' + lastReason);
        }
        return;
      }

      if (q.type === 'single_choice') {
        const choice = pickChoice(q.choices, p.rawAnswer);
        if (!choice) {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'choice not matched', rawAnswer: p.rawAnswer });
          return;
        }
        const ok = clickChoice(choice);
        if (ok) {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'selected', rawAnswer: p.rawAnswer, valueUsed: choice.text });
          if (verbose) console.log('  Q' + q.questionNumber + ' single_choice selected "' + choice.text + '"');
        } else {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'click did not select', rawAnswer: p.rawAnswer });
        }
        return;
      }

      if (q.type === 'multiple_choice') {
        const picks = pickMultipleChoices(q.choices, p.rawAnswer);
        if (picks.length === 0) {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'no choices matched', rawAnswer: p.rawAnswer });
          return;
        }
        let allOk = true;
        picks.forEach(function (c) { if (!clickChoice(c)) allOk = false; });
        if (allOk) {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'filled', rawAnswer: p.rawAnswer, valueUsed: picks.map(function (c) { return c.text; }).join(', ') });
        } else {
          results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'some clicks failed', rawAnswer: p.rawAnswer });
        }
        return;
      }

      results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'unknown question type', rawAnswer: p.rawAnswer });
    });

    const filled = results.filter(function (r) { return r.status === 'filled' || r.status === 'selected'; }).length;
    const failed = results.filter(function (r) { return r.status === 'failed'; }).length;
    const missingAnswers = results.filter(function (r) { return r.status === 'no-answer'; }).length;
    const detectedNums = new Set(questions.map(function (q) { return q.questionNumber; }));
    const missingQuestions = parsed.filter(function (p) { return !detectedNums.has(p.questionNumber); }).length;

    if (verbose) {
      console.log('[answer-applier] Final: Success ' + filled + '/' + questions.length + ' filled.');
      if (failed > 0) {
        console.log('[answer-applier] Failed:');
        results.filter(function (r) { return r.status === 'failed'; }).forEach(function (r) {
          console.log('  Q' + r.questionNumber + ' reason="' + r.reason + '"');
        });
      }
    }

    return {
      detectedQuestions: questions.length,
      parsedAnswers: parsed.length,
      results: results,
      summary: { total: questions.length, filled: filled, failed: failed, missingAnswers: missingAnswers, missingQuestions: missingQuestions }
    };
  }

  const api = { applyAnswers: applyAnswers };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.answerApplier = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npm test -- --test-reporter=spec tests/answer-applier.test.js`
Expected: PASS — all 6 cases including the 11-question end-to-end.

- [ ] **Step 5: Commit**

```bash
git add lib/answer-applier.js tests/answer-applier.test.js
git commit -m "feat(answer-applier): question-numbered fill+select orchestrator"
```

---

## Task 5: Wire the new pipeline into the sidebar

**Files:**
- Modify: `lib/sidebar.js`
- Modify: `manifest.json`

The sidebar Apply handler tries the numbered path first. If `applyAnswers` returns `parsedAnswers === 0`, fall back to the existing legacy matcher (so "the answer is A and C" still works). Status string mirrors the new summary.

- [ ] **Step 1: Update `manifest.json`**

Add the four new script paths in load order **before** `sidebar.js`. The full `js` array becomes:

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
  "lib/math-normalize.js",
  "lib/numbered-parser.js",
  "lib/question-detector.js",
  "lib/answer-applier.js",
  "lib/sidebar.js",
  "content.js"
]
```

- [ ] **Step 2: Modify `lib/sidebar.js` Apply handler**

Inside `wireAnswer`, replace the body of the `apply.addEventListener('click', ...)` handler with this dispatch logic. The legacy parser is still rendered into the summary chips for visibility.

Old code path (the `apply` click handler body) is replaced with:

```js
apply.addEventListener('click', function () {
  const { parser, matcher } = getAnswerApi();
  const root = (typeof window !== 'undefined') ? window.ClipboardCleaner : null;
  const applier = root && root.answerApplier;
  if (!parser || !matcher) { setAnswerStatus('Answer engine unavailable.', 'error'); return; }
  const raw = ta.value || '';
  if (!raw.trim()) { setAnswerStatus('Paste an answer first.', 'error'); return; }

  // Render the legacy parsed summary chips for visibility.
  let parsed;
  try { parsed = parser.parseAnswerText(raw); } catch (_) { parsed = null; }
  if (parsed) renderAnswerSummary(parsed);

  // Try the numbered pipeline FIRST.
  if (applier && typeof applier.applyAnswers === 'function') {
    let out;
    try {
      out = applier.applyAnswers(raw, document.body, { verbose: true });
    } catch (e) {
      out = null;
    }
    if (out && out.parsedAnswers > 0) {
      const s = out.summary;
      const parts = ['Filled ' + s.filled + '/' + s.total];
      if (s.failed) parts.push(s.failed + ' failed');
      if (s.missingAnswers) parts.push(s.missingAnswers + ' missing answer');
      if (s.missingQuestions) parts.push(s.missingQuestions + ' extra answer');
      const tone = (s.failed === 0 && s.missingAnswers === 0) ? 'success' : 'warn';
      setAnswerStatus(parts.join(', '), tone);
      return;
    }
    // parsedAnswers === 0 — fall through to legacy path.
  }

  // Legacy fallback: letters / quoted snippets / positional text values.
  if (!parsed) { setAnswerStatus('Could not parse the pasted text.', 'error'); return; }
  const hasAnyCandidate = parsed.letters.length + parsed.numbers.length + parsed.quotedSnippets.length + (parsed.computedValues ? parsed.computedValues.length : 0);
  if (!hasAnyCandidate) { setAnswerStatus('No answer candidates found in the pasted text.', 'error'); return; }
  const groups = matcher.findOptionGroups(document.body);
  const matches = (groups.length > 0) ? matcher.matchCandidates(groups, parsed) : [];
  const optionSummary = (matches.length > 0) ? matcher.applyMatches(matches) : { selected: 0, skipped: 0 };
  const textInputs = matcher.findTextInputs ? matcher.findTextInputs(document.body) : [];
  const textMatches = matcher.matchTextInputs ? matcher.matchTextInputs(textInputs, parsed) : [];
  const textSummary = (textMatches.length > 0 && matcher.applyTextMatches) ? matcher.applyTextMatches(textMatches) : { filled: 0, skipped: 0 };
  const did = optionSummary.selected + textSummary.filled;
  if (did === 0) { setAnswerStatus('No options matched the parsed answer, and no text fields could be filled.', 'error'); return; }
  const parts = [];
  if (optionSummary.selected > 0) parts.push('Selected ' + optionSummary.selected);
  if (textSummary.filled > 0)     parts.push('Filled ' + textSummary.filled);
  const skipped = (optionSummary.skipped || 0) + (textSummary.skipped || 0);
  if (skipped) parts.push('(' + skipped + ' skipped)');
  setAnswerStatus(parts.join(', '), skipped ? 'warn' : 'success');
});
```

- [ ] **Step 3: Run all tests, confirm green**

Run: `npm test`
Expected: PASS — every existing test plus the new ones.

- [ ] **Step 4: Manual smoke check (extension reload)**

Open `chrome://extensions`, hit "Reload" on Clipboard Cleaner. Visit a Coursera quiz page with mixed question types. Paste the 11-line answer block into the Answering tab and click **Apply to page**. Inspect the page: every field including Q9, Q10, Q11 should be filled/selected. Open DevTools console to read the `[answer-applier]` log lines.

- [ ] **Step 5: Commit**

```bash
git add lib/sidebar.js manifest.json
git commit -m "feat(sidebar): wire question-numbered applier into Apply flow"
```

---

## Self-Review

Run after Task 5. Confirms the plan as a whole addresses every spec requirement.

**Spec coverage:**
- (1) Robust question detection — Task 3 (`question-detector.js`) + tests.
- (2) Answer parsing preserves question mapping — Task 2 (`numbered-parser.js`) + 11-answer test.
- (3) Cascading parser pipeline (7 layers) — Task 2 implements all 7.
- (4) Coursera math answer formatting — Task 1 (`math-normalize.js`).
- (5) Exact normalised answers for this quiz — covered by both Task 1 unit tests and the Task 4 11-question integration test (asserts `el.value === '2*epsilon_o*E_o/r'` etc.).
- (6) Radio and checkbox handling — Task 4 `pickChoice` / `pickMultipleChoices`.
- (7) Input filling reliability — Task 4 uses existing `applyTextMatches` (variant chain), adds retry + scrollIntoView + re-query.
- (8) Prevent skipping final questions — Task 4 iterates over **detected questions**, not inputs; no bound on `textInputs.length`.
- (9) Logging — Task 4 logs Detected / Parsed / Filling / Final / Failed lines.
- (10) Testing — every new module has unit tests; the 11-answer end-to-end test pins the failure case.
- (11) Smallest reliable changes — legacy code paths in `answer-parser.js` and `answer-matcher.js` are untouched; the new pipeline is additive and only activates when numbered answers are detected.

**Placeholder scan:** No "TBD" / "implement later" / "similar to" — every step shows real code or real commands.

**Type consistency:** Public APIs are stable across tasks. `parseNumberedAnswers` → `[{questionNumber, rawAnswer}]`. `detectQuestions` → `[{questionNumber, titleText, fullText, type, choices, targets, container}]`. `applyAnswers` → `{detectedQuestions, parsedAnswers, results[], summary}`. Result `status` enum: `'filled' | 'selected' | 'failed' | 'no-answer'`. These match between definition and consumer code.

---

## How to run / test

```bash
# All tests (Node 20+):
npm test

# Just the new modules:
npm test -- --test-reporter=spec tests/math-normalize.test.js
npm test -- --test-reporter=spec tests/numbered-parser.test.js
npm test -- --test-reporter=spec tests/question-detector.test.js
npm test -- --test-reporter=spec tests/answer-applier.test.js
```

Manual: load the unpacked extension in Chrome, open a Coursera quiz, paste the 11-line answer block into the Answering tab, click **Apply to page**. Read `[answer-applier]` lines in DevTools console.

---

## Expected normalised output for the 11-answer example (verified by Task 4 test)

```
{
  1:  "0.0539",
  2:  "2*epsilon_o*E_o/r",
  3:  "0",
  4:  "-2*k",
  5:  "0",
  6:  "15058.7876",
  7:  "3.7647*10^5",
  8:  "8.0000",
  9:  "3.9789*10^-5",
  10: "Diamagnetism",   // not normalised — selected as radio choice
  11: "300"
}
```

---

## Root cause summary (for the PR description)

The legacy `matchTextInputs` in `lib/answer-matcher.js:267` zipped `textInputs[i]` against `parsed.computedValues[i]` positionally, bounded by `Math.min(textInputs.length, values.length)`. Two things conspired:

1. `lib/answer-parser.js`'s `NUMBERED_LINE_RE` only captures numeric values, so symbolic answers ("2*epsilon_o*E_o/r", "-2*k") and the radio text "Diamagnetism" never entered `computedValues`. The list shrank from 11 → ~6.
2. Even if the parser had emitted 11 values, `textInputs` would still have been ~10 (radio question Q10 has no text input), so positional zipping would still drift after position 9.

The fix is structural: **iterate over detected questions, not detected inputs, and look up the answer by question number.** New pipeline activates only when numbered answers are present, so existing "the answer is A and C" flows are untouched.

