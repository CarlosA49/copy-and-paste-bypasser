# Number-Input Fill Throw Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop "Apply to page" from crashing the page when a Coursera answer field is `<input type="number">`. Setting `el.value = "6.0781e-10 F"` on a number input throws `DOMException: The specified value … cannot be parsed`. The current variant-chain code in `applyTextMatches` doesn't catch the throw, so the exception escapes and the rest of the fill loop never runs.

**Architecture:** Two complementary changes — defensive and proactive.
- **Defensive:** wrap the actual value-setter call in `trySetAndVerify` with try/catch, emit a new `'rejected-throw'` skip-reason on throw, and continue to the next variant.
- **Proactive:** `buildVariants` peeks at the target element. When it's `<input type="number">`, variants that aren't pure-numeric-shaped (i.e. anything still containing a unit like `H` or `F`) are filtered out *before* they hit the setter, so the chain starts with the numeric-only form on the first try.

**Tech Stack:** Vanilla JS (Chrome MV3 content script), Node 20+ built-in `node --test`, JSDOM. Existing IIFE + dual-mode pattern preserved.

---

## File Structure

- **Modify** `lib/answer-matcher.js`:
  - `trySetAndVerify`: wrap the native-value setter and the contenteditable `textContent` assignment in `try/catch`; on throw, return `{ ok: false, reason: 'rejected-throw' }`.
  - `buildVariants`: accept an optional `targetEl` argument; when the target is `<input type="number">`, post-filter the variant list to keep only number-shaped strings.
  - `applyTextMatches`: pass `el` to `buildVariants(m, el)`.
- **Modify** `lib/sidebar.js`:
  - Extend the `HUMAN_REASONS` map with `'rejected-throw': 'value rejected by field'`.
- **Modify** `tests/answer-matcher.test.js`:
  - Three new regression tests pinning the bug-fix contract: number-input filtering, setter-throws fallback, no-exception-escape.

Each file change is small and surgical.

---

## Task 1: `trySetAndVerify` wraps the setter in try/catch

**Files:**
- Modify: `lib/answer-matcher.js`
- Modify: `tests/answer-matcher.test.js`

- [ ] **Step 1: Append failing test** to `tests/answer-matcher.test.js`:

```js
test('applyTextMatches: setter that throws is treated as a rejected variant; pipeline continues', () => {
  // First variant set throws (simulates the type="number" DOMException). The
  // pipeline must NOT propagate the throw — it must record a reason and try
  // the next variant.
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  let attempts = 0;
  let stored = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return stored; },
    set: function (v) {
      attempts += 1;
      // First set attempt throws; subsequent attempts succeed.
      if (attempts === 1) throw new Error('value rejected by field');
      stored = String(v);
    },
  });
  let threw = false;
  let summary;
  try {
    summary = applyTextMatches([{ el: el, value: '6.0781e-10 H', reason: 'computedValue' }]);
  } catch (_) {
    threw = true;
  }
  assert.equal(threw, false, 'applyTextMatches must not let setter throws escape');
  assert.equal(summary.filled, 1, 'fallback variant should succeed');
  // Variant 0 (the full string) threw; variant 1 ("6.0781e-10") was accepted.
  assert.equal(el.value, '6.0781e-10');
});

test('applyTextMatches: setter that ALWAYS throws — field is skipped with reason "rejected-throw"', () => {
  const d = dom('<input type="text" id="t">');
  const el = d.getElementById('t');
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return ''; },
    set: function () { throw new Error('always throws'); },
  });
  const summary = applyTextMatches([{ el: el, value: '1 H', reason: 'computedValue' }]);
  assert.equal(summary.filled, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.reasons[0], 'rejected-throw');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern "setter that throws|setter that ALWAYS throws"`
Expected: both fail — the first by an uncaught exception, the second by either the same exception or wrong reason.

- [ ] **Step 3: Wrap setter calls in try/catch** in `lib/answer-matcher.js`.

Find `trySetAndVerify` and replace its body with:

```js
  // Set a value, dispatch events, and read it back. Returns {ok, reason}.
  // The value-setter call is wrapped in try/catch because some inputs
  // (notably <input type="number">) throw a DOMException when the assigned
  // string cannot be parsed as a number. We treat that as a rejected variant
  // and let the caller try the next one.
  function trySetAndVerify(el, value) {
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      try {
        setNativeValue(el, value);
      } catch (_) {
        return { ok: false, reason: 'rejected-throw' };
      }
      dispatch(el, 'input');
      dispatch(el, 'change');
      const actual = (el.value == null) ? '' : String(el.value);
      if (actual === value) return { ok: true };
      if (actual && actual.trim() === value.trim()) return { ok: true };
      if (!actual) return { ok: false, reason: 'rejected-empty' };
      return { ok: false, reason: 'value-did-not-stick' };
    }
    // contenteditable
    try {
      el.textContent = value;
    } catch (_) {
      return { ok: false, reason: 'rejected-throw' };
    }
    dispatch(el, 'input');
    const actualCE = (el.textContent == null) ? '' : String(el.textContent);
    if (actualCE === value) return { ok: true };
    if (!actualCE) return { ok: false, reason: 'rejected-empty' };
    return { ok: false, reason: 'value-did-not-stick' };
  }
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test`
Expected: 0 failures.

- [ ] **Step 5: Commit**

```bash
git add lib/answer-matcher.js tests/answer-matcher.test.js
git commit -m "fix(answer-matcher): wrap native value setter in try/catch (rejected-throw reason)"
```

---

## Task 2: `buildVariants` filters non-numeric variants for `type="number"` inputs

**Files:**
- Modify: `lib/answer-matcher.js`
- Modify: `tests/answer-matcher.test.js`

With Task 1's try/catch in place, the bug no longer crashes — but the pipeline still wastes a variant attempt on the unit-containing string for every number input. We pre-filter the variant list so number inputs start with the numeric form on the first try.

- [ ] **Step 1: Append failing test** to `tests/answer-matcher.test.js`:

```js
test('applyTextMatches: <input type="number"> with value "6.0781e-10 F" fills as "6.0781e-10"', () => {
  // The live-Coursera bug: number inputs reject the unit-containing variant.
  // buildVariants should drop "6.0781e-10 F" (it has letter 'F') before any
  // setter is touched, so the first attempted variant is "6.0781e-10".
  const d = dom('<input type="number" id="t">');
  const el = d.getElementById('t');
  // JSDOM's number input implements the same value-parsing as the browser:
  // assigning a non-numeric string silently empties the field (not throws).
  // Either way the variant filter should mean we never attempt the unit form.
  const summary = applyTextMatches([{ el: el, value: '6.0781e-10 F', reason: 'computedValue' }]);
  assert.equal(summary.filled, 1);
  assert.equal(el.value, '6.0781e-10');
  // Pin the variantIndex: the numeric-only form is index 0 of the FILTERED
  // variant list (the unit-containing form was dropped before the loop ran).
  assert.equal(summary.results[0].variantIndex, 0);
  assert.equal(summary.results[0].valueUsed, '6.0781e-10');
});

test('applyTextMatches: <input type="number"> still tries plain-decimal expansion if numeric-only is rejected', () => {
  // Some number widgets reject scientific notation but accept decimal expansion.
  // Construct one that rejects strings containing 'e' but accepts pure digits/dot.
  const d = dom('<input type="number" id="t">');
  const el = d.getElementById('t');
  let stored = '';
  Object.defineProperty(el, 'value', {
    configurable: true,
    get: function () { return stored; },
    set: function (v) { stored = /[eE]/.test(v) ? '' : String(v); },
  });
  const summary = applyTextMatches([{ el: el, value: '0.0352 F', reason: 'computedValue' }]);
  // Filtered variants for a number input: ["0.0352", "0.0352"] — second deduped.
  // 0.0352 has no 'e', so it's accepted on the first try. Pin success.
  assert.equal(summary.filled, 1);
  assert.equal(stored, '0.0352');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern "input type=\"number\""`
Expected: at least the first new test fails. (The second may pass coincidentally depending on JSDOM number-input behaviour — that's fine; what matters is the first.)

- [ ] **Step 3: Update `buildVariants` to accept a target element and filter for number inputs.**

In `lib/answer-matcher.js`, just above `buildVariants`, add this helper:

```js
  // True when the element is <input type="number">. Number inputs cannot
  // accept unit suffixes (e.g. "1.0e-6 H") — the variant chain skips those
  // forms preemptively so the first attempted setter call is parseable.
  function isNumberInput(el) {
    if (!el || (el.tagName || '').toUpperCase() !== 'INPUT') return false;
    return (el.getAttribute('type') || '').toLowerCase() === 'number';
  }

  // True when a string is shaped like a number that <input type="number">
  // would accept: optional sign, digits, optional fractional part, optional
  // exponent. Decimal point at start ".5" is also accepted (HTML spec).
  function isNumberShaped(s) {
    return /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s);
  }
```

Then modify `buildVariants` to take a second argument `targetEl` and filter at the end. Find:

```js
  function buildVariants(match) {
    const variants = [];
    const seen = new Set();
    ...
    return variants;
  }
```

Change the signature and append a filter:

```js
  function buildVariants(match, targetEl) {
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
          // toFixed(10) keeps numbers like 0.0352 representable without
          // float-imprecision artefacts (toFixed(20) would emit a trailing "212").
          const dec = num.toFixed(10).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
          push(dec);
        }
      } else if (num === 0) {
        push('0');
      }
    }

    // For <input type="number">, drop variants that aren't number-shaped.
    // This prevents wasted setter attempts (and DOMException throws) on the
    // unit-containing form.
    if (isNumberInput(targetEl)) {
      return variants.filter(isNumberShaped);
    }
    return variants;
  }
```

- [ ] **Step 4: Update the `applyTextMatches` call site** to pass the target element.

Find:

```js
      const variants = buildVariants(m);
```

Replace with:

```js
      const variants = buildVariants(m, el);
```

- [ ] **Step 5: Run tests and verify they pass**

Run: `npm test`
Expected: 0 failures. The new number-input test produces the asserted output (`6.0781e-10`).

- [ ] **Step 6: Commit**

```bash
git add lib/answer-matcher.js tests/answer-matcher.test.js
git commit -m "fix(answer-matcher): filter non-numeric variants for <input type=number>"
```

---

## Task 3: Sidebar surfaces the new `rejected-throw` reason

**Files:**
- Modify: `lib/sidebar.js`

- [ ] **Step 1: Extend `HUMAN_REASONS`** in `lib/sidebar.js`. Find the module-scope `HUMAN_REASONS` constant (added in the previous polish round, near the top of the IIFE):

```js
  const HUMAN_REASONS = {
    'detached': 'field not editable',
    'no-variants': 'no matching value',
    'rejected-empty': 'rejected characters',
    'value-did-not-stick': 'value did not stick',
  };
```

Replace with:

```js
  const HUMAN_REASONS = {
    'detached': 'field not editable',
    'no-variants': 'no matching value',
    'rejected-empty': 'rejected characters',
    'rejected-throw': 'value rejected by field',
    'value-did-not-stick': 'value did not stick',
  };
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
git commit -m "feat(sidebar): translate 'rejected-throw' reason in Apply status"
```

---

## Self-Review Checklist (already performed)

**Spec coverage:**
- "Wrap native value setting in try/catch" → Task 1 (around `setNativeValue` call in `trySetAndVerify`, and around `textContent` assignment for contenteditable).
- "If setting a variant throws, record that variant as rejected and immediately try the next variant" → Task 1 (returns `{ok:false, reason:'rejected-throw'}`, which is one of `lastReason`'s possible values; the for-loop in `applyTextMatches` keeps iterating).
- "For input[type="number"], skip unit-containing variants entirely and try numeric-only / plain-decimal first" → Task 2 (`isNumberInput` + `isNumberShaped` filter at the end of `buildVariants`).
- "Never surface browser exceptions to the page. Return skipped/rejected status in the sidebar instead" → Task 1 (try/catch) + Task 3 (status string).
- "Add regression tests" → all three listed scenarios pinned: number-input with unit fills the numeric form (Task 2), setter-throws falls back (Task 1), no exception escape (Task 1's "must not let setter throws escape" assertion).
- "Run the full test suite" → each task ends with `npm test`.

**Placeholder scan:** None. Every code block is complete; every command has an expected output.

**Type consistency:**
- `trySetAndVerify` still returns `{ok, reason}`. New reason code `'rejected-throw'` joins the existing four; `HUMAN_REASONS` covers it.
- `buildVariants` signature changes from `(match)` to `(match, targetEl)`. The only caller (`applyTextMatches`) is updated.
- `isNumberInput(el)` and `isNumberShaped(s)` are private helpers; not exported.
- `results[i].variantIndex` and `results[i].valueUsed` continue to index into the (possibly-filtered) variant list — the pinned-variantIndex test in Task 2 reflects that.
