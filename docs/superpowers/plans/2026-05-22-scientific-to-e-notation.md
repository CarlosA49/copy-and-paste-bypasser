# Scientific-to-E Notation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert scientific notation `<numeric mantissa>{×|x|*}10^<exp>` into Coursera-friendly E notation (`<mantissa>E<exp>`) so numeric fields don't drop the exponent. Preserve symbolic answers (`2*epsilon_o*E_o/r`, `-2*k`, `k*10^2`) untouched.

**Architecture:** Add one new function `scientificToE` to `lib/math-normalize.js`, plugged into the pipeline right after `replaceLatexTimes` (so `×` is already converted to `*`). Extend `insertImplicitMultiplication`'s number tokenizer to recognize `<digits>[.<digits>]E[+-]?<digits>` as a single number token — otherwise the existing "E is a known math identifier" logic would insert a stray `*` between the mantissa and `E`. Update existing tests that asserted the old `*10^N` output to expect the new `EN` form. No DOM changes, no applier changes, no sidebar changes.

**Tech Stack:** Vanilla JS (Chrome MV3 content script), Node 20+ `node --test`, JSDOM. Same IIFE dual-export pattern as the rest of the project.

**Root cause:** Coursera math fields sometimes silently drop the `×10^N`/`*10^N` portion of an answer, keeping only the mantissa. E notation (`3.7699E-8`) is parsed reliably by the same fields. This is a normalization-side fix only.

**Why the tokenizer extension:** `E` and `E_o` are in `MATH_IDENTS` (used to keep `2*epsilon_o*E_o/r` symbolic). Without an extension, tokenizing `3.7699E-8` produces `[num "3.7699", id "E", op "-", num "8"]` and the implicit-`*` pass inserts a star between the num and the id, yielding `3.7699*E-8`. We need the tokenizer to treat `<digits>[.<digits>]E[+-]?<digits>` as a single number token so the E-notation form survives the pass.

---

## File Structure

**Modify:**
- `lib/math-normalize.js` — add `scientificToE`, call it in `normalizeMathAnswer`, extend `insertImplicitMultiplication`'s number-token scan.
- `tests/math-normalize.test.js` — update three existing assertions (the `\times`/`×` cases that previously expected `*10^N`); add six new tests for the spec cases.
- `tests/answer-applier.test.js` — update two existing assertions (Q7/Q9 from the 11-question failure cases) and one assertion in the ordered-lines test; add one new 7-question integration test covering the user's example block.

**Do not touch:** `lib/answer-applier.js`, `lib/sidebar.js`, `lib/numbered-parser.js`, `lib/answer-matcher.js`, `lib/answer-parser.js`, `lib/question-detector.js`, `lib/value-normalize.js`, `manifest.json`. The applier already routes math/numerical answers through `normalizeMathAnswer` — the change is fully encapsulated.

---

## Task 1: Add `scientificToE` and extend number-token tokenizer in `lib/math-normalize.js`

**Files:**
- Modify: `lib/math-normalize.js`
- Modify: `tests/math-normalize.test.js`
- Modify: `tests/answer-applier.test.js` (only the existing Q7/Q9 assertions — the new integration test is Task 2)

### Step 1: Update existing math-normalize tests to expect E-form output

The three currently-passing tests that exercise `\times`/`×` will produce E-form after the change. Edit `tests/math-normalize.test.js`:

Find:
```js
test('normalizeMathAnswer: converts LaTeX \\times and strips units', () => {
  assert.equal(normalizeMathAnswer('(3.7647\\times10^5) N/C'), '3.7647*10^5');
});
```
Change the expected value:
```js
test('normalizeMathAnswer: converts LaTeX \\times and strips units', () => {
  assert.equal(normalizeMathAnswer('(3.7647\\times10^5) N/C'), '3.7647E5');
});
```

Find:
```js
test('normalizeMathAnswer: handles LaTeX brace exponent', () => {
  assert.equal(normalizeMathAnswer('(3.9789\\times10^{-5}) C/m²'), '3.9789*10^-5');
});
```
Change to:
```js
test('normalizeMathAnswer: handles LaTeX brace exponent', () => {
  assert.equal(normalizeMathAnswer('(3.9789\\times10^{-5}) C/m²'), '3.9789E-5');
});
```

Find:
```js
test('normalizeMathAnswer: handles Unicode × too', () => {
  assert.equal(normalizeMathAnswer('3.7647×10^5'), '3.7647*10^5');
});
```
Change to:
```js
test('normalizeMathAnswer: handles Unicode × too', () => {
  assert.equal(normalizeMathAnswer('3.7647×10^5'), '3.7647E5');
});
```

### Step 2: Update existing answer-applier integration assertions

These existing tests passed because `normalizeMathAnswer` produced the `*10^N` form; the new behaviour produces E form. Edit `tests/answer-applier.test.js`:

Find (inside the original 11-question test):
```js
  assert.equal(d.getElementById('q7').value, '3.7647*10^5');
  assert.equal(d.getElementById('q8').value, '8.0000');
  assert.equal(d.getElementById('q9').value, '3.9789*10^-5');
```
Change to:
```js
  assert.equal(d.getElementById('q7').value, '3.7647E5');
  assert.equal(d.getElementById('q8').value, '8.0000');
  assert.equal(d.getElementById('q9').value, '3.9789E-5');
```

Find (inside `'11-question bare un-numbered format is fully filled'`):
```js
  assert.equal(d.getElementById('q7').value, '3.7647*10^5', 'Q7 decimal must not be mis-parsed as numbered list item');
  assert.equal(d.getElementById('q8').value, '8.0000', 'Q8 must not be corrupted to 00000');
  assert.equal(d.getElementById('q9').value, '3.9789*10^-5');
```
Change to:
```js
  assert.equal(d.getElementById('q7').value, '3.7647E5', 'Q7 decimal must not be mis-parsed as numbered list item');
  assert.equal(d.getElementById('q8').value, '8.0000', 'Q8 must not be corrupted to 00000');
  assert.equal(d.getElementById('q9').value, '3.9789E-5');
```

Find (inside `'11-question "Final answers:" header + "Based on..." trailer is fully filled'`):
```js
  assert.equal(d.getElementById('q8').value, '8.0000');
  assert.equal(d.getElementById('q9').value, '3.9789*10^-5');
```
Change to:
```js
  assert.equal(d.getElementById('q8').value, '8.0000');
  assert.equal(d.getElementById('q9').value, '3.9789E-5');
```

(There's no explicit Q7 assertion in the bare-format test besides the one above; if any other test asserts a specific `*10^N` value, update it too. Grep for `*10^` in `tests/answer-applier.test.js` to confirm.)

### Step 3: Append 6 new tests to `tests/math-normalize.test.js`

```js
test('normalizeMathAnswer: ×10^-N with unit becomes E-N', () => {
  assert.equal(normalizeMathAnswer('3.7699×10^-8 C'), '3.7699E-8');
});

test('normalizeMathAnswer: ×10^-N with compound unit C/m² becomes E-N', () => {
  assert.equal(normalizeMathAnswer('5.6250×10^-6 C/m²'), '5.6250E-6');
});

test('normalizeMathAnswer: ASCII x operator with spaces becomes EN', () => {
  assert.equal(normalizeMathAnswer('1.23 x 10^8'), '1.23E8');
});

test('normalizeMathAnswer: ASCII * with spaces and negative exponent', () => {
  assert.equal(normalizeMathAnswer('1.23 * 10^-4'), '1.23E-4');
});

test('normalizeMathAnswer: preserves mantissa trailing zeros', () => {
  assert.equal(normalizeMathAnswer('8.0000×10^3'), '8.0000E3');
});

test('normalizeMathAnswer: symbolic expression with star stays symbolic (no E conversion)', () => {
  assert.equal(normalizeMathAnswer('2*epsilon_o*E_o/r'), '2*epsilon_o*E_o/r');
});

test('normalizeMathAnswer: symbolic k*10^2 is NOT converted (mantissa not numeric)', () => {
  // Mantissa before *10^ must be purely numeric; "k" is symbolic.
  // The k literal is preserved; only the trailing 10^2 should be at most preserved.
  // Expected: implicit-star pass yields "k*10^2" — no E conversion.
  assert.equal(normalizeMathAnswer('k*10^2'), 'k*10^2');
});
```

### Step 4: Run tests to confirm they FAIL

Run: `npm test -- --test-reporter=spec tests/math-normalize.test.js`
Expected: the 3 updated existing tests fail (they now expect E form, but implementation still produces `*10^N`), and the 7 new tests fail (same reason).

Run: `npm test -- --test-reporter=spec tests/answer-applier.test.js`
Expected: the 11-question test, the bare 11-question test, and the "Final answers:" test all fail on the Q7/Q9 assertions.

### Step 5: Implement `scientificToE` in `lib/math-normalize.js`

Open `lib/math-normalize.js`. Add the new function right after `stripLatexBackslashes` (so it lives next to the other LaTeX/syntax cleanup helpers, around line 30):

```js
  // Rule 3b: Convert numeric scientific notation to E form.
  //   3.7699×10^-8 → 3.7699E-8       (after replaceLatexTimes, × is already *)
  //   1.23 x 10^8 → 1.23E8
  //   8.0000*10^3 → 8.0000E3
  //
  // Only fires when the mantissa is purely numeric (digits + optional decimal)
  // AND not preceded by an identifier character. So k*10^2 stays as "k*10^2"
  // and 2*epsilon_o stays symbolic. The prefix capture group ensures the
  // mantissa is a standalone number, not the tail of a longer identifier.
  function scientificToE(s) {
    return s.replace(
      /(^|[^A-Za-z0-9_.])(\d+(?:\.\d+)?)\s*[*x]\s*10\s*\^\s*([+-]?\d+)/g,
      function (_m, prefix, mantissa, exp) {
        return prefix + mantissa + 'E' + exp;
      }
    );
  }
```

### Step 6: Plug `scientificToE` into the pipeline

In the `normalizeMathAnswer` function, find:

```js
    s = replaceLatexTimes(s);
    s = replaceLatexBraces(s);
    s = stripLatexBackslashes(s);

    // Rule 5 (first pass): strip outer parens before unit check so that
```

Insert `scientificToE` between `stripLatexBackslashes` and the comment / first paren strip:

```js
    s = replaceLatexTimes(s);
    s = replaceLatexBraces(s);
    s = stripLatexBackslashes(s);

    // Rule 3b: numeric N*10^M → NEM (Coursera prefers E notation in numeric fields).
    s = scientificToE(s);

    // Rule 5 (first pass): strip outer parens before unit check so that
```

### Step 7: Extend `insertImplicitMultiplication`'s number-token scan

The existing tokenizer (in `insertImplicitMultiplication`) consumes `[0-9.]+` as a number, then exits the number loop. After `scientificToE` runs, the string may contain tokens like `3.7699E-8`. Today the tokenizer would split that into `[num "3.7699", id "E", op "-", num "8"]` and the implicit-`*` pass would yield `3.7699*E-8`. Extend the number scan to consume an optional E-suffix.

Find this block in `insertImplicitMultiplication`:
```js
      // Number literal (including decimals).
      if (/[0-9.]/.test(c)) {
        let j = i;
        while (j < s.length && /[0-9.]/.test(s.charAt(j))) j++;
        tokens.push({ kind: 'num', text: s.slice(i, j) });
        i = j;
        continue;
      }
```

Replace it with:
```js
      // Number literal (including decimals and trailing E-notation).
      // After scientificToE, mantissas like "3.7699E-8" must be ONE token,
      // not [num "3.7699", id "E", op "-", num "8"]. Otherwise the implicit-*
      // pass would insert a spurious star between mantissa and "E".
      if (/[0-9.]/.test(c)) {
        let j = i;
        while (j < s.length && /[0-9.]/.test(s.charAt(j))) j++;
        // Extend through E[+-]?digits if present.
        if (j < s.length && (s.charAt(j) === 'E' || s.charAt(j) === 'e')) {
          let k = j + 1;
          if (k < s.length && (s.charAt(k) === '+' || s.charAt(k) === '-')) k++;
          let m = k;
          while (m < s.length && /[0-9]/.test(s.charAt(m))) m++;
          // Only extend if at least one digit followed the optional sign.
          if (m > k) j = m;
        }
        tokens.push({ kind: 'num', text: s.slice(i, j) });
        i = j;
        continue;
      }
```

### Step 8: Run tests, confirm all pass

Run: `npm test`
Expected: 367/367 pass (360 original + 6 new math-normalize tests + 1 new answer-applier test from Task 2 has NOT been added yet, so actually 366 at the end of this task).

Actually count check:
- Existing: 360.
- New math-normalize tests added in Step 3: 7 (the user spec listed 6, plus one for `k*10^2` symbolic preservation = 7).
- No new answer-applier tests in this task (that's Task 2).
- Three existing math-normalize tests had their expectations updated (no count change).
- Several answer-applier tests had assertions updated (no count change).
- Final: 360 + 7 = **367 tests**, all passing after Task 1.

### Step 9: Commit

```bash
git add lib/math-normalize.js tests/math-normalize.test.js tests/answer-applier.test.js
git commit -m "feat(math-normalize): emit E notation for numeric N*10^M scientific form"
```

---

## Task 2: Add the 7-question integration test

**Files:**
- Modify: `tests/answer-applier.test.js`

### Step 1: Append the new integration test

Append this test to `tests/answer-applier.test.js`:

```js
test('7-question "Final answers:" block with mixed text/radio/scientific is fully filled', () => {
  // Q3 ("the capacitor") and Q5 ("increase the frequency") are single-choice
  // radio groups in this mock — the spec says these should select their
  // matching option, not become a text fill.
  const html =
    makeQuestion(1, '<input type="text" id="q1">') +
    makeQuestion(2, '<input type="text" id="q2">') +
    makeQuestion(3,
      '<fieldset>' +
        '<label><input type="radio" name="q3"> the inductor</label>' +
        '<label><input type="radio" name="q3"> the capacitor</label>' +
        '<label><input type="radio" name="q3"> the resistor</label>' +
      '</fieldset>') +
    makeQuestion(4, '<input type="text" id="q4">') +
    makeQuestion(5,
      '<fieldset>' +
        '<label><input type="radio" name="q5"> decrease the frequency</label>' +
        '<label><input type="radio" name="q5"> keep the frequency</label>' +
        '<label><input type="radio" name="q5"> increase the frequency</label>' +
      '</fieldset>') +
    makeQuestion(6, '<input type="text" id="q6">') +
    makeQuestion(7, '<input type="text" id="q7">');
  const d = dom(html);
  const raw =
    'Final answers:\n\n' +
    '1. 9795.3096 Hz\n' +
    '2. 0 A\n' +
    '3. the capacitor\n' +
    '4. 0.0006665 A\n' +
    '5. increase the frequency\n' +
    '6. 3.7699×10^-8 C\n' +
    '7. 5.6250×10^-6 C/m²';

  const out = applyAnswers(raw, d.body, { verbose: false });

  assert.equal(out.detectedQuestions, 7);
  assert.equal(out.parsedAnswers, 7);
  assert.equal(out.summary.filled, 7);
  assert.equal(out.summary.failed, 0);

  // Numeric / math_input fields:
  assert.equal(d.getElementById('q1').value, '9795.3096');
  assert.equal(d.getElementById('q2').value, '0');
  assert.equal(d.getElementById('q4').value, '0.0006665');
  assert.equal(d.getElementById('q6').value, '3.7699E-8', 'Q6 must be E notation');
  assert.equal(d.getElementById('q7').value, '5.6250E-6', 'Q7 must be E notation');

  // Radio selections:
  const q3 = d.querySelectorAll('input[name="q3"]');
  assert.equal(q3[0].checked, false);
  assert.equal(q3[1].checked, true, 'Q3 "the capacitor" must be selected');
  assert.equal(q3[2].checked, false);

  const q5 = d.querySelectorAll('input[name="q5"]');
  assert.equal(q5[0].checked, false);
  assert.equal(q5[1].checked, false);
  assert.equal(q5[2].checked, true, 'Q5 "increase the frequency" must be selected');
});
```

### Step 2: Run tests, confirm PASS

Run: `npm test -- --test-reporter=spec tests/answer-applier.test.js`
Expected: all answer-applier tests pass including the new one.

Run: `npm test`
Expected: 368/368 pass (367 from Task 1 + 1 new in Task 2).

### Step 3: Commit

```bash
git add tests/answer-applier.test.js
git commit -m "test(answer-applier): 7-question mixed text/radio/scientific block"
```

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Covered by |
|---|---|
| Preserve all current behaviour (360 tests still pass after assertion updates) | Task 1 Steps 1-2 update test expectations to the new E-form output that the change produces; the underlying behavioural contract (math_input fields receive a Coursera-acceptable value) is unchanged. |
| Implement in `lib/math-normalize.js` | Task 1 Steps 5-7 — single file modification. |
| Accept `×`, `x`, `*` with optional spaces around operator and `^` | Regex `[*x]` (after `replaceLatexTimes` already converts `×` to `*`) plus `\s*` around operator, `10`, and `^` — Task 1 Step 5. |
| Positive and negative exponents | Regex `[+-]?\d+` — Task 1 Step 5. |
| Preserve mantissa trailing zeros (e.g. `5.6250` stays `5.6250`) | Regex captures mantissa verbatim via `(\d+(?:\.\d+)?)` — never normalises it. Test in Task 1 Step 3 (`'8.0000×10^3' → '8.0000E3'`). |
| Strip trailing units (`3.7699×10^-8 C` → `3.7699E-8`) | `scientificToE` runs BEFORE `stripTrailingUnit`, so the unit is stripped from the already-converted string. Tests in Task 1 Step 3. |
| Do not convert symbolic `2*epsilon_o*E_o/r`, `-2*k`, `k*10^2` | Regex prefix capture requires non-identifier char before mantissa, AND mantissa must be `\d+(?:\.\d+)?`. `k*10^2` fails because `k` is identifier and the only digit run is `10` — but `(\d+)\s*[*x]\s*10` needs a preceding mantissa with an operator before "10". Tests in Task 1 Step 3 (incl. `k*10^2`). |
| Use E notation for numeric input fields | `normalizeMathAnswer` is only called for `math_input`/`numerical`/`input` types in `lib/answer-applier.js` (existing behaviour). Radio/text choice matching via `pickChoice` is untouched. |
| Do not break radio matching for "the capacitor" / "increase the frequency" | Task 2 integration test asserts both radios are selected via the existing single-choice path. |
| Tests: all 6 unit tests + 1 integration test from spec | Task 1 Step 3 has all 6 spec cases (+ 1 extra for `k*10^2` symbolic safety); Task 2 has the integration test. |
| Q6 → `3.7699E-8`, Q7 → `5.6250E-6` | Task 2 integration test asserts these exact strings. |
| Logging: keep minimal, no new normalization logs | No log changes in this plan. Existing `[answer-applier] mode=...` lines still apply. |

All requirements covered.

**2. Placeholder scan**

No "TBD", "implement later", "add appropriate handling", or "similar to Task N". Every step has either real code or an exact command.

**3. Type consistency**

- `scientificToE(s: string) → string` — same signature shape as `replaceLatexTimes`, `replaceLatexBraces`, etc. No public API change.
- The tokenizer extension is local to `insertImplicitMultiplication`; no exported types or method signatures shift.
- Test expectation changes are mechanical string-for-string updates; no shape changes (still `assert.equal(input.value, 'string')`).

Consistent.

---

## How to run / test

```bash
# Full test suite (Node 20+):
npm test

# Just the modules changed:
npm test -- --test-reporter=spec tests/math-normalize.test.js
npm test -- --test-reporter=spec tests/answer-applier.test.js
```

**Manual extension verification:**

1. Open `chrome://extensions` (or `edge://extensions`).
2. Click **Reload** on Clipboard Cleaner. (No manifest change in this plan, so just hot-reload is enough.)
3. Open a Coursera quiz with a numeric field that expects scientific notation.
4. Paste an answer block containing a `×10^N` value (e.g. `1. 3.7699×10^-8 C`).
5. Click **Apply to page**.
6. Open DevTools → Console. Expect `[answer-applier] mode=numbered` and per-question fill log lines. The math input should contain `3.7699E-8`, not `3.7699×10^-8` or `3.7699*10^-8`.
7. On a quiz where a text answer is `"the capacitor"`, confirm the radio group still selects the right option (no regression in radio matching).
