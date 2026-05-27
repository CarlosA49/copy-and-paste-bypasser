# Adaptive Text-Fill Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Apply to page" actually fill Coursera answer boxes on real pages. Strip leading `=`/`answer is`/`final:` prefixes from values; only target visible enabled fields; for each field, try a chain of value variants (raw → numeric-only → plain-decimal) and verify the field's value actually stuck via read-back; on rejection move on to the next field with a recorded skip reason; surface those reasons in the sidebar status.

**Architecture:** A small pure helper `cleanFillValue` in `lib/answer-parser.js` strips common AI-prose prefixes. `lib/answer-matcher.js` gets a visibility filter on `findTextInputs` so hidden / aria-hidden / collapsed inputs (and the search field `type`) are dropped. `applyTextMatches` is rewritten around `buildVariants` (raw → numeric → plain-decimal) and `trySetAndVerify` (set + dispatch + read-back) and now returns `{filled, skipped, reasons, results}` so the sidebar can surface granular skip reasons. Chip rendering in `lib/sidebar.js` runs through `cleanFillValue` so the `= ` prefix never reaches the user, and the Apply status string aggregates skip reasons into human-readable counts.

**Tech Stack:** Vanilla JS (Chrome MV3 content script), Node 20+ built-in `node --test`, JSDOM for DOM tests. Existing IIFE + dual-mode (browser global + CommonJS) pattern preserved.

---

## File Structure

- **Modify** `lib/answer-parser.js` — Add `cleanFillValue(raw) → string` exported on the public api. No change to the extractor itself.
- **Modify** `tests/answer-parser.test.js` — Tests for `cleanFillValue`.
- **Modify** `lib/answer-matcher.js`:
  - Add `isVisible(el) → boolean` (walks ancestors checking inline + computed display/visibility/aria-hidden).
  - Drop `'search'` from `TEXT_INPUT_TYPES`.
  - Use `isVisible` to filter `findTextInputs`.
  - Add `buildVariants(match) → string[]` and `trySetAndVerify(el, value) → {ok, reason}`.
  - Rewrite `applyTextMatches` to iterate variants per match with read-back, returning `{filled, skipped, reasons, results}`.
  - Lazy-load `answerParser` (CJS in Node, `window.ClipboardCleaner.answerParser` in browser) so the matcher can call `cleanFillValue`.
- **Modify** `tests/answer-matcher.test.js`:
  - New tests for visibility filter, variant chain, read-back rejection, mixed success/failure batching.
  - Update two existing `applyTextMatches` tests that used `assert.deepEqual` on the full summary so they assert only on the `filled`/`skipped` fields (the return shape gains `reasons` and `results`).
- **Modify** `lib/sidebar.js`:
  - Chip rendering: call `cleanFillValue(cv.raw)` instead of prefixing `'= '`.
  - Apply status: aggregate `textSummary.reasons` into human-readable counts ("rejected characters", "value did not stick", etc.) and append to the warning string.

Each file has a single responsibility: parser stays pure; matcher owns DOM read/write; sidebar wires presentation.

---

## Task 1: `cleanFillValue` helper

**Files:**
- Modify: `lib/answer-parser.js`
- Modify: `tests/answer-parser.test.js`

- [ ] **Step 1: Append failing tests** to `tests/answer-parser.test.js`:

```js
const { cleanFillValue } = require('../lib/answer-parser.js');

test('cleanFillValue: strips leading "= "', () => {
  assert.equal(cleanFillValue('= 1.0e-6 H'), '1.0e-6 H');
});

test('cleanFillValue: strips "answer = " / "answer is "', () => {
  assert.equal(cleanFillValue('answer = 1.0e-6 H'), '1.0e-6 H');
  assert.equal(cleanFillValue('Answer is 1.0e-6 H'), '1.0e-6 H');
});

test('cleanFillValue: strips "the answer is " (with article)', () => {
  assert.equal(cleanFillValue('The answer is 1.0e-6 H'), '1.0e-6 H');
});

test('cleanFillValue: strips "value is = "', () => {
  assert.equal(cleanFillValue('value is = 1.0e-6 H'), '1.0e-6 H');
});

test('cleanFillValue: strips "Final: = "', () => {
  assert.equal(cleanFillValue('Final: = 1.0e-6 H'), '1.0e-6 H');
});

test('cleanFillValue: strips "result is " and "outcome is "', () => {
  assert.equal(cleanFillValue('result is 42 J'), '42 J');
  assert.equal(cleanFillValue('outcome is 42 J'), '42 J');
});

test('cleanFillValue: passes already-clean value through unchanged', () => {
  assert.equal(cleanFillValue('1.0e-6 H'), '1.0e-6 H');
  assert.equal(cleanFillValue('500'), '500');
});

test('cleanFillValue: returns "" for non-string and empty inputs', () => {
  assert.equal(cleanFillValue(null), '');
  assert.equal(cleanFillValue(undefined), '');
  assert.equal(cleanFillValue(123), '');
  assert.equal(cleanFillValue(''), '');
  assert.equal(cleanFillValue('   '), '');
});

test('cleanFillValue: trims surrounding whitespace', () => {
  assert.equal(cleanFillValue('   1.0e-6 H   '), '1.0e-6 H');
});

test('cleanFillValue: loops to strip chained prefixes (Final: + answer is + =)', () => {
  assert.equal(cleanFillValue('Final: answer is = 1.0e-6 H'), '1.0e-6 H');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern cleanFillValue`
Expected: 10 failing (function not exported).

- [ ] **Step 3: Implement `cleanFillValue`** in `lib/answer-parser.js`.

Just above the `parseAnswerText` function definition, add:

```js
  // Strip common AI-prose prefixes from a raw answer string so the fill
  // pipeline sees only the value+unit. Examples:
  //   "= 1.0e-6 H"             → "1.0e-6 H"
  //   "answer = 1.0e-6 H"      → "1.0e-6 H"
  //   "value is = 1.0e-6 H"    → "1.0e-6 H"
  //   "Final: answer is X"     → "X"
  // The loop runs each rule repeatedly until no more progress is made, so
  // chained prefixes like "Final: answer is = X" collapse cleanly.
  const FILL_PREFIX_PATTERNS = [
    /^final\s*[:.]?\s*/i,
    /^the\s+answer\s+(?:is\s+)?[:=]?\s*/i,
    /^answer\s+is\s*[:=]?\s*/i,
    /^answer\s*[:=]\s*/i,
    /^value\s+is\s*[:=]?\s*/i,
    /^result\s+is\s*[:=]?\s*/i,
    /^outcome\s+is\s*[:=]?\s*/i,
    /^=\s*/,
  ];

  function cleanFillValue(raw) {
    if (typeof raw !== 'string') return '';
    let s = raw.trim();
    if (!s) return '';
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < FILL_PREFIX_PATTERNS.length; i++) {
        const next = s.replace(FILL_PREFIX_PATTERNS[i], '');
        if (next !== s) { s = next.trim(); changed = true; }
      }
    }
    return s;
  }
```

Then export `cleanFillValue` on the public api. Find:

```js
  const api = { parseAnswerText: parseAnswerText };
```

Replace with:

```js
  const api = { parseAnswerText: parseAnswerText, cleanFillValue: cleanFillValue };
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern cleanFillValue`
Expected: 10 passing.

Run full suite — `npm test` — expect 0 failures.

- [ ] **Step 5: Commit**

```bash
git add lib/answer-parser.js tests/answer-parser.test.js
git commit -m "feat(answer-parser): cleanFillValue strips AI-prose prefixes"
```

---

## Task 2: `findTextInputs` visibility filter

**Files:**
- Modify: `lib/answer-matcher.js`
- Modify: `tests/answer-matcher.test.js`

- [ ] **Step 1: Append failing tests** to `tests/answer-matcher.test.js`:

```js
test('findTextInputs: skips <input type="hidden">', () => {
  const d = dom('<input type="hidden" id="h"><input type="text" id="ok">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: skips <input hidden> (the HTML hidden attribute)', () => {
  const d = dom('<input type="text" hidden id="h"><input type="text" id="ok">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: skips <input style="display:none">', () => {
  const d = dom('<input type="text" id="h" style="display:none"><input type="text" id="ok">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: skips inputs inside a display:none ancestor', () => {
  const d = dom('<div style="display:none"><input type="text" id="h"></div><input type="text" id="ok">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: skips aria-hidden="true" inputs', () => {
  const d = dom('<input type="text" id="h" aria-hidden="true"><input type="text" id="ok">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: skips inputs inside an aria-hidden ancestor', () => {
  const d = dom('<div aria-hidden="true"><input type="text" id="h"></div><input type="text" id="ok">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: skips visibility:hidden', () => {
  const d = dom('<input type="text" id="h" style="visibility:hidden"><input type="text" id="ok">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: type="search" is no longer included (Coursera answer boxes are text/number)', () => {
  const d = dom('<input type="search" id="s"><input type="text" id="ok">');
  const list = findTextInputs(d.body);
  assert.equal(list.length, 1);
  assert.equal(list[0].el.id, 'ok');
});

test('findTextInputs: 12 visible answer boxes among extra hidden inputs counts exactly 12', () => {
  // Real-world scenario: a page has 12 visible answer boxes plus 2 hidden
  // React/framework inputs. findTextInputs returns exactly 12.
  let html = '<input type="hidden" name="csrf">';
  for (let i = 0; i < 12; i++) html += '<input type="text" name="q' + i + '">';
  html += '<div style="display:none"><input type="text" name="internal"></div>';
  const d = dom(html);
  const list = findTextInputs(d.body);
  assert.equal(list.length, 12);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern findTextInputs`
Expected: at least 8 of the 9 new tests fail; the type="search" exclusion test will fail because 'search' is currently in TEXT_INPUT_TYPES.

- [ ] **Step 3: Add `isVisible` and drop `'search'`** in `lib/answer-matcher.js`.

Find the current `findTextInputs` function. Above it, add:

```js
  // Determines whether an element (and all ancestors up to <html>) are visible
  // in the rendered tree. Hidden/aria-hidden/display:none/visibility:hidden at
  // any level filters the element out.
  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden === true) return false;
    if (el.type === 'hidden') return false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      if (cur.style && (cur.style.display === 'none' || cur.style.visibility === 'hidden')) return false;
      // Computed style honours stylesheets too (real browser). In JSDOM this
      // mostly reflects inline styles, so the inline checks above already cover
      // the common test cases.
      const view = cur.ownerDocument && cur.ownerDocument.defaultView;
      if (view && view.getComputedStyle) {
        try {
          const cs = view.getComputedStyle(cur);
          if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
        } catch (_) { /* JSDOM may throw on detached nodes */ }
      }
      cur = cur.parentElement;
    }
    return true;
  }
```

Then update the `findTextInputs` body. Find:

```js
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

Replace the function body so it:
1. Removes `'search'` from `TEXT_INPUT_TYPES`.
2. Adds an `isVisible(el)` gate.

```js
  function findTextInputs(root) {
    if (!root) return [];
    const out = [];
    const TEXT_INPUT_TYPES = ['text', 'number', 'email', 'tel', 'url', 'password'];
    const els = root.querySelectorAll('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]');
    els.forEach(function (el) {
      if (!isUsable(el)) return;
      if (el.readOnly) return;
      if (!isVisible(el)) return;
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

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern findTextInputs`
Expected: every findTextInputs test passes (including all pre-existing ones).

Run full suite — `npm test` — expect 0 failures.

- [ ] **Step 5: Commit**

```bash
git add lib/answer-matcher.js tests/answer-matcher.test.js
git commit -m "feat(answer-matcher): findTextInputs filters hidden/offscreen inputs and excludes type=search"
```

---

## Task 3: `applyTextMatches` variant chain + read-back

**Files:**
- Modify: `lib/answer-matcher.js`
- Modify: `tests/answer-matcher.test.js`

The current `applyTextMatches` just sets the value and assumes success. We replace it with a per-match variant chain (raw → numeric-only → plain-decimal) that verifies after each set whether the field's value actually stuck, and records a skip reason on full failure. The return shape gains `reasons` and `results` fields; consumers reading only `.filled` / `.skipped` still work.

- [ ] **Step 1: Append failing tests** to `tests/answer-matcher.test.js`:

```js
test('applyTextMatches: strips leading "= " from the raw value before filling', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  applyTextMatches([{ el: el, value: '= 1.0e-6 H', reason: 'computedValue' }]);
  // The "= " prefix is stripped before the field is touched.
  assert.equal(el.value, '1.0e-6 H');
});

test('applyTextMatches: strips "answer = " / "Final: " prefixes', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  applyTextMatches([{ el: el, value: 'Final: answer = 42 J', reason: 'computedValue' }]);
  assert.equal(el.value, '42 J');
});

test('applyTextMatches: falls back to numeric-only when full raw is rejected', () => {
  // Mock a field that rejects any letter character: any set attempt that
  // contains [A-Za-z] is silently truncated to empty. The fallback chain should
  // then try the numeric-only variant.
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  // Override the value descriptor to reject letters.
  const proto = Object.getPrototypeOf(el);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  let storedValue = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return storedValue; },
    set: function (v) { storedValue = /[A-Za-z]/.test(v) ? '' : String(v); },
  });
  const summary = applyTextMatches([{ el: el, value: '1.0e-6 H', reason: 'computedValue' }]);
  // Variant 0 "1.0e-6 H" contains letters → rejected. Variant 1 "1.0e-6"
  // contains 'e' which is also a letter → rejected. Variant 2 plain-decimal
  // "0.000001" has no letters → accepted.
  assert.equal(summary.filled, 1);
  assert.equal(el.value, '0.000001');
});

test('applyTextMatches: records a skip reason when every variant is rejected', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  // Reject every set attempt entirely.
  let storedValue = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return storedValue; },
    set: function (_v) { storedValue = ''; },
  });
  const summary = applyTextMatches([{ el: el, value: '1.0e-6 H', reason: 'computedValue' }]);
  assert.equal(summary.filled, 0);
  assert.equal(summary.skipped, 1);
  assert.ok(Array.isArray(summary.reasons));
  assert.equal(summary.reasons.length, 1);
  // Reason is the canonical machine-readable code; sidebar translates to human text.
  assert.ok(summary.reasons[0] === 'rejected-empty' || summary.reasons[0] === 'value-did-not-stick');
});

test('applyTextMatches: one failed field does not stop subsequent fills', () => {
  const d = dom('<input type="text" id="bad"><input type="text" id="ok">');
  const bad = d.getElementById('bad');
  const ok = d.getElementById('ok');
  // bad rejects everything; ok accepts.
  Object.defineProperty(bad, 'value', {
    configurable: true,
    get: function () { return ''; },
    set: function () { /* swallow */ },
  });
  const summary = applyTextMatches([
    { el: bad, value: '1.0e-6 H', reason: 'computedValue' },
    { el: ok,  value: '0.0352 H', reason: 'computedValue' },
  ]);
  assert.equal(summary.filled, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(ok.value, '0.0352 H');
});

test('applyTextMatches: returns reasons:[] when input list is empty', () => {
  const summary = applyTextMatches([]);
  assert.equal(summary.filled, 0);
  assert.equal(summary.skipped, 0);
  assert.deepEqual(summary.reasons, []);
});

test('applyTextMatches: detached element produces skip reason "detached"', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  el.remove();
  const summary = applyTextMatches([{ el: el, value: 'x', reason: 'computedValue' }]);
  assert.equal(summary.filled, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.reasons[0], 'detached');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern applyTextMatches`
Expected: the 7 new tests fail.

- [ ] **Step 3: Lazy-load `answerParser` in `lib/answer-matcher.js`.**

At the top of the IIFE just below `'use strict';`, add (mirroring how `html-cleaner.js` loads `cleaner.js`):

```js
  const answerParser = (function () {
    if (typeof module !== 'undefined' && module.exports) {
      return require('./answer-parser.js');
    }
    return (root.ClipboardCleaner && root.ClipboardCleaner.answerParser) || null;
  })();

  function cleanFillValue(s) {
    if (answerParser && typeof answerParser.cleanFillValue === 'function') {
      return answerParser.cleanFillValue(s);
    }
    return (typeof s === 'string') ? s.trim() : '';
  }
```

(The fallback keeps the matcher functional even if the parser isn't loaded in some odd test setup.)

- [ ] **Step 4: Add `buildVariants` and `trySetAndVerify`.**

Just below `setNativeValue`, add:

```js
  // Build an ordered list of value variants to try for a text-input fill.
  // The first variant is the cleaned raw (e.g. "1.0e-6 H"). Then numeric-only
  // ("1.0e-6"). Then plain decimal expansion ("0.000001") for fields that
  // reject scientific notation. Empty / NaN-derived variants are skipped.
  function buildVariants(match) {
    const variants = [];
    const seen = new Set();
    function push(v) {
      const t = cleanFillValue(v);
      if (t && !seen.has(t)) { seen.add(t); variants.push(t); }
    }
    const cleaned = cleanFillValue(match && match.value);
    push(cleaned);

    // Numeric-only: the first numeric token in the cleaned string.
    const numMatch = cleaned.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/);
    if (numMatch) push(numMatch[0]);

    // Plain-decimal expansion (only useful when the value is in e-notation
    // and the magnitude is in a sensible range).
    if (numMatch) {
      const num = parseFloat(numMatch[0]);
      if (Number.isFinite(num) && num !== 0) {
        const abs = Math.abs(num);
        if (abs >= 1e-9 && abs < 1e15) {
          const dec = num.toFixed(20).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
          push(dec);
        }
      } else if (num === 0) {
        push('0');
      }
    }
    return variants;
  }

  // Set a value, dispatch events, and read it back. Returns {ok, reason}.
  function trySetAndVerify(el, value) {
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      setNativeValue(el, value);
      dispatch(el, 'input');
      dispatch(el, 'change');
      const actual = (el.value == null) ? '' : String(el.value);
      if (actual === value) return { ok: true };
      if (actual && actual.trim() === value.trim()) return { ok: true };
      if (!actual) return { ok: false, reason: 'rejected-empty' };
      return { ok: false, reason: 'value-did-not-stick' };
    }
    // contenteditable
    el.textContent = value;
    dispatch(el, 'input');
    const actualCE = (el.textContent == null) ? '' : String(el.textContent);
    if (actualCE === value) return { ok: true };
    if (!actualCE) return { ok: false, reason: 'rejected-empty' };
    return { ok: false, reason: 'value-did-not-stick' };
  }
```

- [ ] **Step 5: Rewrite `applyTextMatches`.**

Find the current `applyTextMatches` function and REPLACE it with:

```js
  function applyTextMatches(matches) {
    const results = [];
    if (!Array.isArray(matches)) return { filled: 0, skipped: 0, reasons: [], results: [] };

    matches.forEach(function (m) {
      const el = m && m.el;
      if (!el || !el.ownerDocument || !el.ownerDocument.contains(el)) {
        results.push({ el: el, filled: false, reason: 'detached' });
        return;
      }
      const variants = buildVariants(m);
      if (variants.length === 0) {
        results.push({ el: el, filled: false, reason: 'no-variants' });
        return;
      }
      let success = false;
      let lastReason = 'value-did-not-stick';
      for (let i = 0; i < variants.length; i++) {
        const r = trySetAndVerify(el, variants[i]);
        if (r.ok) {
          results.push({ el: el, filled: true, valueUsed: variants[i], variantIndex: i });
          success = true;
          break;
        }
        lastReason = r.reason;
      }
      if (!success) {
        results.push({ el: el, filled: false, reason: lastReason });
      }
    });

    const filled = results.filter(function (r) { return r.filled; }).length;
    const skipped = results.length - filled;
    const reasons = results.filter(function (r) { return !r.filled; }).map(function (r) { return r.reason; });
    return { filled: filled, skipped: skipped, reasons: reasons, results: results };
  }
```

- [ ] **Step 6: Update two existing tests** that asserted on the full summary shape via `deepEqual`.

Find this test in `tests/answer-matcher.test.js`:

```js
test('applyTextMatches: returns { filled: 0, skipped: 0 } for empty list', () => {
  assert.deepEqual(applyTextMatches([]), { filled: 0, skipped: 0 });
});
```

Replace with:

```js
test('applyTextMatches: returns filled:0, skipped:0 for empty list', () => {
  const s = applyTextMatches([]);
  assert.equal(s.filled, 0);
  assert.equal(s.skipped, 0);
});
```

Find this test:

```js
test('applyTextMatches: returns { filled: 0, skipped: 0 } for non-array input', () => {
  assert.deepEqual(applyTextMatches(null), { filled: 0, skipped: 0 });
});
```

Replace with:

```js
test('applyTextMatches: returns filled:0, skipped:0 for non-array input', () => {
  const s = applyTextMatches(null);
  assert.equal(s.filled, 0);
  assert.equal(s.skipped, 0);
});
```

- [ ] **Step 7: Run the full test suite**

Run: `npm test`
Expected: 0 failures. All new applyTextMatches tests pass; existing radio/checkbox/option-match tests untouched.

- [ ] **Step 8: Commit**

```bash
git add lib/answer-matcher.js tests/answer-matcher.test.js
git commit -m "feat(answer-matcher): applyTextMatches uses variant chain with read-back verification"
```

---

## Task 4: Sidebar — strip leading `=` from chips

**File:**
- Modify: `lib/sidebar.js`

The chip rendering currently prefixes every `computedValues` entry with the literal string `'= '`. We change it to render `cleanFillValue(cv.raw)` so the chip shows exactly the cleaned value that will be filled.

- [ ] **Step 1: Locate the chip-rendering block** in `lib/sidebar.js`. Inside `renderAnswerSummary`, find:

```js
    (parsed.computedValues || []).forEach(function (cv) {
      chips.push('= ' + cv.raw);
    });
```

Replace with:

```js
    (parsed.computedValues || []).forEach(function (cv) {
      const cleaner = (window.ClipboardCleaner && window.ClipboardCleaner.answerParser && window.ClipboardCleaner.answerParser.cleanFillValue)
        || function (s) { return (typeof s === 'string' ? s.trim() : ''); };
      const display = cleaner(cv.raw) || cv.raw;
      chips.push(display);
    });
```

- [ ] **Step 2: Run the full test suite** to confirm nothing else broke.

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 3: Sanity-load**

Run: `node -e "const s=require('./lib/sidebar.js'); console.log(typeof s.mount)"`
Expected: `function`.

- [ ] **Step 4: Commit**

```bash
git add lib/sidebar.js
git commit -m "feat(sidebar): chip text shows cleaned value (no leading '=' prefix)"
```

---

## Task 5: Sidebar — surface skip reasons in Apply status

**File:**
- Modify: `lib/sidebar.js`

The current Apply status reports `Selected N, Filled M [— warnings]` but doesn't tell the user WHY fields were skipped. With the new `textSummary.reasons` array, we aggregate counts per reason code and append human-readable phrases.

- [ ] **Step 1: Locate the Apply status assembly block** in `lib/sidebar.js`. Inside the `apply.addEventListener('click', function () { ... })` body, find the final `warnings` block that ends with `setAnswerStatus(msg, tone);`. The current end of the handler looks like:

```js
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

Replace with:

```js
      const warnings = [];
      const cvs = (parsed.computedValues || []);
      const hasLow = cvs.some(function (cv) { return cv.confidence === 'low'; });
      if (hasLow) warnings.push('low confidence — verify values');
      if (textInputs.length > 0 && cvs.length !== textInputs.length && cvs.length > 0) {
        warnings.push(cvs.length + ' value(s) vs ' + textInputs.length + ' input(s)');
      }

      // Aggregate text-input skip reasons into a short phrase like
      // "1 rejected characters, 2 value did not stick".
      const HUMAN_REASONS = {
        'detached': 'field not editable',
        'no-variants': 'no matching value',
        'rejected-empty': 'rejected characters',
        'value-did-not-stick': 'value did not stick',
      };
      const textReasons = (textSummary.reasons || []);
      if (textReasons.length > 0) {
        const counts = {};
        textReasons.forEach(function (r) { counts[r] = (counts[r] || 0) + 1; });
        const parts2 = Object.keys(counts).map(function (r) {
          const human = HUMAN_REASONS[r] || r;
          return counts[r] === 1 ? human : (counts[r] + ' ' + human);
        });
        warnings.push(parts2.join(', '));
      }

      const tone = warnings.length > 0 ? 'warn' : 'success';
      const msg = parts.join(', ') + (warnings.length ? ' — ' + warnings.join('; ') : '');
      setAnswerStatus(msg, tone);
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 3: Sanity-load**

Run: `node -e "const s=require('./lib/sidebar.js'); console.log(typeof s.mount)"`
Expected: `function`.

- [ ] **Step 4: Commit**

```bash
git add lib/sidebar.js
git commit -m "feat(sidebar): surface aggregated skip reasons in Apply status"
```

---

## Task 6: End-to-end regression tests

**File:**
- Modify: `tests/answer-matcher.test.js`

These tests pin every scenario in the user's spec at the level of the matcher's public API. They go beyond the per-task unit tests by exercising real combined cases (e.g., 12 visible inputs + 12 values, with extra hidden controls present).

- [ ] **Step 1: Append regression tests** to `tests/answer-matcher.test.js`:

```js
test('regression: leading "= " removed before fill (chip + actual value)', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  const summary = applyTextMatches([{ el: el, value: '= 1.0e-6 H', reason: 'computedValue' }]);
  assert.equal(summary.filled, 1);
  assert.equal(el.value, '1.0e-6 H'); // no "= " prefix in the field
});

test('regression: value+unit field can fall back to numeric-only', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  // Reject any value containing a letter (units like H/F/etc.).
  let stored = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return stored; },
    set: function (v) { stored = /[A-Za-z]/.test(v) ? '' : String(v); },
  });
  // The value has "e" in "1.0e-6" so that ALSO fails the letter test.
  // The final fallback variant is the plain-decimal expansion "0.000001".
  const summary = applyTextMatches([{ el: el, value: '1.0e-6 H', reason: 'computedValue' }]);
  assert.equal(summary.filled, 1);
  assert.equal(el.value, '0.000001');
});

test('regression: every variant rejected → field is skipped with a reason', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  // Reject every set attempt.
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return ''; },
    set: function () { /* swallow */ },
  });
  const summary = applyTextMatches([{ el: el, value: '1.0e-6 H', reason: 'computedValue' }]);
  assert.equal(summary.filled, 0);
  assert.equal(summary.skipped, 1);
  // Reason is one of the canonical machine-readable codes.
  assert.ok(['rejected-empty', 'value-did-not-stick'].indexOf(summary.reasons[0]) !== -1);
});

test('regression: a failed field does not stop subsequent fields from filling', () => {
  const d = dom(
    '<input type="text" id="bad">' +
    '<input type="text" id="ok">' +
    '<input type="text" id="also-ok">'
  );
  const bad = d.getElementById('bad');
  // bad rejects everything.
  Object.defineProperty(bad, 'value', {
    configurable: true,
    get: function () { return ''; },
    set: function () {},
  });
  const summary = applyTextMatches([
    { el: bad, value: 'a', reason: 'computedValue' },
    { el: d.getElementById('ok'), value: 'b', reason: 'computedValue' },
    { el: d.getElementById('also-ok'), value: 'c', reason: 'computedValue' },
  ]);
  assert.equal(summary.filled, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(d.getElementById('ok').value, 'b');
  assert.equal(d.getElementById('also-ok').value, 'c');
});

test('regression: hidden / aria-hidden / display:none inputs are NOT discovered', () => {
  const d = dom(
    '<input type="hidden" name="csrf">' +
    '<input type="text" id="ok-1">' +
    '<input type="text" id="hidden-1" hidden>' +
    '<div style="display:none"><input type="text" id="hidden-2"></div>' +
    '<div aria-hidden="true"><input type="text" id="hidden-3"></div>' +
    '<input type="text" id="ok-2">'
  );
  const list = findTextInputs(d.body);
  assert.equal(list.length, 2);
  const ids = list.map(function (x) { return x.el.id; });
  assert.deepEqual(ids, ['ok-1', 'ok-2']);
});

test('regression: 12 visible answer boxes + 12 values fills 12/12 (no off-by-N)', () => {
  let html = '<input type="hidden" name="csrf">';
  for (let i = 0; i < 12; i++) html += '<input type="text" name="q' + i + '">';
  html += '<div style="display:none"><input type="text" name="internal-react"></div>';
  const d = dom(html);
  const inputs = findTextInputs(d.body);
  assert.equal(inputs.length, 12);

  const parsed = { computedValues: [] };
  for (let i = 0; i < 12; i++) {
    parsed.computedValues.push({ value: String(i + 1), unit: 'H', raw: (i + 1) + ' H', confidence: 'high', label: String(i + 1) });
  }
  const matches = matchTextInputs(inputs, parsed);
  assert.equal(matches.length, 12);
  const summary = applyTextMatches(matches);
  assert.equal(summary.filled, 12);
  assert.equal(summary.skipped, 0);
});
```

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: 0 failures. Total should land at roughly previous-count + ~32 new tests across Tasks 1–6.

If any test fails unexpectedly, investigate before committing.

- [ ] **Step 3: Commit**

```bash
git add tests/answer-matcher.test.js
git commit -m "test(answer-matcher): regression for variant-chain + visibility filter"
```

---

## Self-Review Checklist (already performed)

**Spec coverage:**
- "Do not include leading equals signs in filled values" → Task 1 (`cleanFillValue`) + Task 3 (variant chain uses it) + Task 4 (chip rendering uses it).
- "Add answer-value variants for constrained fields" → Task 3 (`buildVariants`: raw → numeric → plain decimal).
- "Detect whether typing/filling actually stuck" → Task 3 (`trySetAndVerify` read-back + skip-on-fail).
- "Improve input matching" / "12 values vs 14 inputs" → Task 2 (`isVisible` filter, drop `type=search`) + Task 6 regression test pinning 12-visible scenario.
- "Add smart move-on behavior" → Task 3's `forEach` runs each match independently; one failure does not abort the loop.
- "Sidebar feedback with skip reasons" → Task 5 (`HUMAN_REASONS` map + aggregated counts).
- "Regression tests" — every listed scenario has a regression test in Task 6.

**Placeholder scan:** None. Every code block is complete; every command has an expected output.

**Type consistency:**
- `applyTextMatches` return shape `{filled, skipped, reasons, results}` is used identically in Task 3 tests, Task 5 sidebar consumer, and Task 6 regression tests.
- `results[i]` shape `{el, filled, reason?, valueUsed?, variantIndex?}` is used consistently.
- `reasons` is an array of string codes drawn from a fixed set: `'detached'`, `'no-variants'`, `'rejected-empty'`, `'value-did-not-stick'`. The sidebar's `HUMAN_REASONS` map covers all four.
- `cleanFillValue(s)` returns `string` always (empty for invalid input). Used identically in Task 1 tests, Task 3 helper, and Task 4 sidebar.
- `isVisible(el)` returns `boolean`. Used only in `findTextInputs`.
