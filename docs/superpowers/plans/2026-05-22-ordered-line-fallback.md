# Ordered-Line Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the question-numbered pipeline accept ordered un-numbered answer lists ("Final answers:" headers / bare line-per-answer) so they route through the new math-aware applier instead of falling back to the legacy positional matcher, which currently mis-fills Q8 as `"00000"`.

**Architecture:** Add a new `parseOrderedLines(raw, expectedCount)` to `lib/numbered-parser.js` that filters wrapper lines ("Final answers:", "Based on the uploaded question set.") and returns one answer per remaining line, but ONLY when the count matches the detected Coursera question count. The applier (`lib/answer-applier.js`) calls it as a second-chance after `parseNumberedAnswers` returns `[]`. No legacy code is touched. Math normalisation, choice matching, retry/verify, and logging all already exist — they just need to receive answers through this new entry point.

**Tech Stack:** Vanilla JS (Chrome MV3 content script), Node 20+ `node --test`, JSDOM. Existing IIFE dual-export pattern preserved. No new files — three modifications only.

**Root cause of the existing bug:**

1. `lib/numbered-parser.js:125` (`layerLineFallback`): suppresses fallback when *any* line matches `^\d{1,2}[.):]`. For the bare format, `"0.0539"` matches that (digit `0` + literal `.`), so even the bare format never enters fallback. `parseNumberedAnswers` returns `[]`.
2. `lib/sidebar.js` Apply handler then falls back to the legacy parser/matcher (today's behaviour). The legacy positional `matchTextInputs` drops symbolic answers (`2*epsilon_o*E_o/r`, `-2k`, `Diamagnetism`), the value list shrinks, and the surviving values get misaligned onto inputs — producing the `"00000"` corruption for Q8.

The fix routes the un-numbered formats through the new pipeline where `lib/math-normalize.js` already correctly produces `"8.0000"` for `"8.0000 μC/m²"`, `"3.7647*10^5"` for `"3.7647×10^5 N/C"`, etc. (verified in existing Task 1 tests).

---

## File Structure

**Modify:**
- `lib/numbered-parser.js` — add `parseOrderedLines(raw, expectedCount)`, export it. Keep `parseNumberedAnswers` byte-identical.
- `lib/answer-applier.js` — in `applyAnswers`, when `parseNumberedAnswers` returns `[]`, try `parseOrderedLines(raw, questions.length)`. Track `mode` ('numbered' | 'ordered-lines') and log it.
- `lib/sidebar.js` — when the new pipeline returns `parsedAnswers === 0`, log `[answer-applier] fallback=legacy` before invoking the legacy path.

**Modify (tests):**
- `tests/numbered-parser.test.js` — unit tests for `parseOrderedLines`.
- `tests/answer-applier.test.js` — end-to-end tests for both un-numbered formats against the 11-question DOM.

**Do not touch:** `lib/answer-parser.js`, `lib/answer-matcher.js`, `lib/math-normalize.js`, `lib/question-detector.js`, `manifest.json`. The new logic plugs into existing seams.

---

## Task 1: `parseOrderedLines(raw, expectedCount)` in `lib/numbered-parser.js`

**Files:**
- Modify: `lib/numbered-parser.js`
- Modify: `tests/numbered-parser.test.js`

### Behaviour

- Input: `raw: string`, `expectedCount: number | undefined`.
- Pre-pass: BOM strip, `\r\n`/`\r` → `\n`, trim. (Same as `parseNumberedAnswers`.)
- Split on `\n`, trim each line, drop blanks.
- Drop "wrapper" lines that match any of these (case-insensitive):
  - `/^\s*final\s+answers?\s*[:.]?\s*$/i` — `"Final answers:"`, `"Final answer."`
  - `/^\s*answers?\s*[:.]?\s*$/i` — `"Answers:"`, `"Answer"`
  - `/^\s*based\s+on\s+(?:the\s+)?(?:uploaded\s+)?question(?:\s+set)?\.?\s*$/i` — `"Based on the uploaded question set."`, `"Based on question set"`
  - `/^\s*here\s+(?:are|is)\s+(?:the\s+)?answers?\s*[:.]?\s*$/i` — `"Here are the answers:"`
- If `expectedCount` is a finite number ≥ 1 and the remaining line count is **not** equal to `expectedCount`, return `[]`.
- If `expectedCount` is `undefined`/`null`, return `[]` (call site must supply it — no permissive mode).
- Otherwise return `lines.map((l, i) => ({questionNumber: i + 1, rawAnswer: stripWholeEmphasis(l)}))`.

Public API additions:
```js
module.exports = { parseNumberedAnswers, parseOrderedLines };
// browser:
root.ClipboardCleaner.numberedParser = { parseNumberedAnswers, parseOrderedLines };
```

### Step 1: Append failing tests to `tests/numbered-parser.test.js`

```js
const { parseOrderedLines } = require('../lib/numbered-parser.js');

test('parseOrderedLines: bare 11-line format', () => {
  const raw =
    '0.0539\n' +
    '2*epsilon_o*E_o/r\n' +
    '0\n' +
    '-2k\n' +
    '0\n' +
    '15058.7876 V\n' +
    '3.7647×10^5 N/C\n' +
    '8.0000 μC/m²\n' +
    '3.9789×10^-5 C/m²\n' +
    'Diamagnetism\n' +
    '300 m';
  const r = parseOrderedLines(raw, 11);
  assert.equal(r.length, 11);
  assert.equal(r[0].rawAnswer, '0.0539');
  assert.equal(r[1].rawAnswer, '2*epsilon_o*E_o/r');
  assert.equal(r[7].rawAnswer, '8.0000 μC/m²');
  assert.equal(r[8].rawAnswer, '3.9789×10^-5 C/m²');
  assert.equal(r[9].rawAnswer, 'Diamagnetism');
  assert.equal(r[10].rawAnswer, '300 m');
});

test('parseOrderedLines: strips "Final answers:" header and "Based on..." trailer', () => {
  const raw =
    'Final answers:\n\n' +
    '0.0539\n' +
    '2*epsilon_o*E_o/r\n' +
    '0\n' +
    '-2k\n' +
    '0\n' +
    '15058.7876 V\n' +
    '3.7647×10^5 N/C\n' +
    '8.0000 μC/m²\n' +
    '3.9789×10^-5 C/m²\n' +
    'Diamagnetism\n' +
    '300 m\n\n' +
    'Based on the uploaded question set.';
  const r = parseOrderedLines(raw, 11);
  assert.equal(r.length, 11);
  assert.equal(r[0].rawAnswer, '0.0539');
  assert.equal(r[10].rawAnswer, '300 m');
});

test('parseOrderedLines: count mismatch returns []', () => {
  const r = parseOrderedLines('a\nb\nc', 11);
  assert.deepEqual(r, []);
});

test('parseOrderedLines: missing expectedCount returns [] (no permissive mode)', () => {
  assert.deepEqual(parseOrderedLines('a\nb', undefined), []);
  assert.deepEqual(parseOrderedLines('a\nb', null), []);
});

test('parseOrderedLines: Windows line endings normalised', () => {
  const r = parseOrderedLines('a\r\nb\r\nc', 3);
  assert.equal(r.length, 3);
  assert.equal(r[1].rawAnswer, 'b');
});

test('parseOrderedLines: empty / non-string returns []', () => {
  assert.deepEqual(parseOrderedLines('', 5), []);
  assert.deepEqual(parseOrderedLines(null, 5), []);
});

test('parseOrderedLines: blank lines between answers are skipped', () => {
  const r = parseOrderedLines('a\n\nb\n\n\nc', 3);
  assert.equal(r.length, 3);
  assert.equal(r[2].rawAnswer, 'c');
});

test('parseOrderedLines: "Here are the answers:" header is stripped', () => {
  const r = parseOrderedLines('Here are the answers:\nx\ny', 2);
  assert.equal(r.length, 2);
  assert.equal(r[0].rawAnswer, 'x');
});
```

### Step 2: Run tests — confirm they fail

Run: `npm test -- --test-reporter=spec tests/numbered-parser.test.js`
Expected: 8 new test cases FAIL with `parseOrderedLines is not a function`.

### Step 3: Implement `parseOrderedLines`

Open `lib/numbered-parser.js`. Add the function right above the `parseNumberedAnswers` definition:

```js
const WRAPPER_PATTERNS = [
  /^\s*final\s+answers?\s*[:.]?\s*$/i,
  /^\s*answers?\s*[:.]?\s*$/i,
  /^\s*based\s+on\s+(?:the\s+)?(?:uploaded\s+)?question(?:\s+set)?\.?\s*$/i,
  /^\s*here\s+(?:are|is)\s+(?:the\s+)?answers?\s*[:.]?\s*$/i,
];

function isWrapperLine(line) {
  for (let i = 0; i < WRAPPER_PATTERNS.length; i++) {
    if (WRAPPER_PATTERNS[i].test(line)) return true;
  }
  return false;
}

function parseOrderedLines(raw, expectedCount) {
  if (typeof raw !== 'string') return [];
  if (typeof expectedCount !== 'number' || !Number.isFinite(expectedCount) || expectedCount < 1) {
    return [];
  }
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = text.split('\n')
    .map(function (l) { return l.trim(); })
    .filter(function (l) { return l.length > 0 && !isWrapperLine(l); });
  if (lines.length !== expectedCount) return [];
  return lines.map(function (l, i) {
    return { questionNumber: i + 1, rawAnswer: stripWholeEmphasis(l) };
  });
}
```

Update the exports at the bottom of the file. Change:

```js
const api = { parseNumberedAnswers: parseNumberedAnswers };
```

to:

```js
const api = {
  parseNumberedAnswers: parseNumberedAnswers,
  parseOrderedLines: parseOrderedLines,
};
```

### Step 4: Run tests — confirm all pass

Run: `npm test -- --test-reporter=spec tests/numbered-parser.test.js`
Expected: all existing parser tests + 8 new cases PASS.

Then full suite: `npm test`. Expected: 356/356 pass (348 prior + 8 new).

### Step 5: Commit

```bash
git add lib/numbered-parser.js tests/numbered-parser.test.js
git commit -m "feat(numbered-parser): add parseOrderedLines for un-numbered formats"
```

---

## Task 2: Wire ordered-lines mode into `lib/answer-applier.js`

**Files:**
- Modify: `lib/answer-applier.js`
- Modify: `tests/answer-applier.test.js`

### Behaviour

In `applyAnswers`:
1. Call `parseNumberedAnswers(rawAnswerText)` → `parsed`.
2. Track `mode = 'numbered'`.
3. If `parsed.length === 0` AND `questions.length > 0`, call `parseOrderedLines(rawAnswerText, questions.length)`. If it returns ≥ 1 item, set `parsed` to that result and `mode = 'ordered-lines'`.
4. Log `[answer-applier] mode=<mode>` immediately after the detection phase (so the user can see which path ran). Gate on `verbose !== false`.
5. The rest of the algorithm (mapping by questionNumber, normalising, filling/clicking, retry/verify, summary) is unchanged.

### Step 1: Append failing tests to `tests/answer-applier.test.js`

```js
test('11-question bare un-numbered format is fully filled', () => {
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
    '0.0539\n' +
    '2*epsilon_o*E_o/r\n' +
    '0\n' +
    '-2k\n' +
    '0\n' +
    '15058.7876 V\n' +
    '3.7647×10^5 N/C\n' +
    '8.0000 μC/m²\n' +
    '3.9789×10^-5 C/m²\n' +
    'Diamagnetism\n' +
    '300 m';

  const out = applyAnswers(raw, d.body, { verbose: false });

  assert.equal(out.detectedQuestions, 11);
  assert.equal(out.parsedAnswers, 11);
  assert.equal(out.summary.filled, 11);
  assert.equal(out.summary.failed, 0);
  assert.equal(out.mode, 'ordered-lines');

  assert.equal(d.getElementById('q8').value, '8.0000', 'Q8 must not be corrupted to 00000');
  assert.equal(d.getElementById('q9').value, '3.9789*10^-5');
  assert.equal(d.getElementById('q11').value, '300');

  const radios = d.querySelectorAll('input[name="q10"]');
  assert.equal(radios[1].checked, true, 'Q10 Diamagnetism must be selected');
});

test('11-question "Final answers:" header + "Based on..." trailer is fully filled', () => {
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
    'Final answers:\n\n' +
    '0.0539\n' +
    '2*epsilon_o*E_o/r\n' +
    '0\n' +
    '-2k\n' +
    '0\n' +
    '15058.7876 V\n' +
    '3.7647×10^5 N/C\n' +
    '8.0000 μC/m²\n' +
    '3.9789×10^-5 C/m²\n' +
    'Diamagnetism\n' +
    '300 m\n\n' +
    'Based on the uploaded question set.';

  const out = applyAnswers(raw, d.body, { verbose: false });

  assert.equal(out.detectedQuestions, 11);
  assert.equal(out.parsedAnswers, 11);
  assert.equal(out.summary.filled, 11);
  assert.equal(out.summary.failed, 0);
  assert.equal(out.mode, 'ordered-lines');

  // The specific four spec assertions:
  assert.equal(d.getElementById('q8').value, '8.0000');
  assert.equal(d.getElementById('q9').value, '3.9789*10^-5');
  assert.equal(d.querySelectorAll('input[name="q10"]')[1].checked, true);
  assert.equal(d.getElementById('q11').value, '300');
});

test('numbered format still reports mode=numbered (regression guard)', () => {
  const html =
    makeQuestion(1, '<input type="text" id="q1">') +
    makeQuestion(2, '<input type="text" id="q2">');
  const d = dom(html);
  const out = applyAnswers('1. a\n2. b', d.body, { verbose: false });
  assert.equal(out.mode, 'numbered');
});

test('count mismatch falls through to legacy (parsedAnswers stays 0)', () => {
  const html =
    makeQuestion(1, '<input type="text">') +
    makeQuestion(2, '<input type="text">');
  const d = dom(html);
  // 3 lines vs 2 questions — should NOT be picked up as ordered-lines.
  const out = applyAnswers('a\nb\nc', d.body, { verbose: false });
  assert.equal(out.parsedAnswers, 0);
});
```

### Step 2: Run tests — confirm the 4 new ones fail

Run: `npm test -- --test-reporter=spec tests/answer-applier.test.js`
Expected: existing 6 pass; the 4 new tests fail (no `mode` field, parsedAnswers stays 0 for un-numbered input).

### Step 3: Modify `lib/answer-applier.js`

In `lib/answer-applier.js`, find the start of `applyAnswers` and the line:

```js
    const parsed = numberedParser.parseNumberedAnswers(rawAnswerText);
```

Replace it with:

```js
    let parsed = numberedParser.parseNumberedAnswers(rawAnswerText);
    let mode = 'numbered';
    if (parsed.length === 0 && questions.length > 0 && typeof numberedParser.parseOrderedLines === 'function') {
      const ordered = numberedParser.parseOrderedLines(rawAnswerText, questions.length);
      if (ordered.length > 0) {
        parsed = ordered;
        mode = 'ordered-lines';
      }
    }
```

(`questions` is defined two lines above in the existing code — `const questions = questionDetector.detectQuestions(rootEl);` — confirm the order in the file. The new block uses `questions.length`, so it MUST come after `questions` is set. Move the lines if necessary.)

Add a log line right after the new block:

```js
    if (verbose) console.log('[answer-applier] mode=' + mode);
```

Then in the early-return branch (when `parsed.length === 0` after both attempts), include `mode` in the return:

Find:
```js
    if (parsed.length === 0) {
      return {
        detectedQuestions: questions.length,
        parsedAnswers: 0,
        results: [],
        summary: { total: questions.length, filled: 0, failed: 0, missingAnswers: questions.length, missingQuestions: 0 }
      };
    }
```

Change to:
```js
    if (parsed.length === 0) {
      return {
        detectedQuestions: questions.length,
        parsedAnswers: 0,
        mode: mode,
        results: [],
        summary: { total: questions.length, filled: 0, failed: 0, missingAnswers: questions.length, missingQuestions: 0 }
      };
    }
```

Find the final return statement at the end of `applyAnswers` (the one with `detectedQuestions`, `parsedAnswers`, `results`, `summary`) and add `mode` there too:

```js
    return {
      detectedQuestions: questions.length,
      parsedAnswers: parsed.length,
      mode: mode,
      results: results,
      summary: { ... }
    };
```

### Step 4: Run tests — confirm all pass

Run: `npm test -- --test-reporter=spec tests/answer-applier.test.js`
Expected: all 10 cases (6 existing + 4 new) pass.

Then full suite: `npm test`. Expected: 360/360 pass (356 from Task 1 + 4 new here).

### Step 5: Commit

```bash
git add lib/answer-applier.js tests/answer-applier.test.js
git commit -m "feat(answer-applier): ordered-lines fallback mode"
```

---

## Task 3: Add `fallback=legacy` log in `lib/sidebar.js`

**Files:**
- Modify: `lib/sidebar.js`

### Behaviour

When the new applier returns `parsedAnswers === 0`, the sidebar already falls through to the legacy code path. Add one `console.log` line *before* it does, so the DevTools console clearly records which path ran.

### Step 1: Read the current Apply handler in `lib/sidebar.js`

Locate the block:

```js
    if (out && out.parsedAnswers > 0) {
      // ...numbered/ordered-lines result handling...
      return;
    }
    // parsedAnswers === 0 — fall through to legacy path.
  }
```

(The exact structure is the one introduced by commit `a8cc9cc`.)

### Step 2: Add the fallback log

Immediately *before* the line `// Legacy fallback: letters / quoted snippets / positional text values.` (the comment is currently in the file), insert:

```js
  if (applier && typeof applier.applyAnswers === 'function') {
    try { console.log('[answer-applier] fallback=legacy'); } catch (_) { /* ignore */ }
  }
```

The `try/catch` guards against environments where `console` is not defined. The `applier` guard avoids logging "fallback=legacy" when the applier was never available in the first place (then there's no fallback — legacy is the only path).

### Step 3: Run tests — confirm no regressions

Run: `npm test`
Expected: still 360/360 pass (no tests target the sidebar log, but nothing should break).

### Step 4: Commit

```bash
git add lib/sidebar.js
git commit -m "feat(sidebar): log fallback=legacy when new pipeline declines input"
```

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Covered by |
|---|---|
| Keep existing numbered pipeline working | Task 2 explicitly preserves `parsedAnswers` path; Task 1 adds a sibling function, doesn't touch `parseNumberedAnswers`. Regression test in Task 2 Step 1 (`mode=numbered`). |
| Ordered line parser, ignore empty lines, ignore "Final answers:" / "Answers:" / "Based on..." | Task 1 (`parseOrderedLines` + `WRAPPER_PATTERNS`). |
| Only activate when line count matches question count, else fall back to legacy | Task 1 (`expectedCount` strict-equality gate); Task 2 (no-match → keep `parsed = []` → existing early-return path). Task 2 Step 1 has a "count mismatch falls through to legacy" test. |
| Fix bad numeric stripping: Q8 → `"8.0000"` not `"00000"` | Routing through the new pipeline runs `mathNormalize.normalizeMathAnswer("8.0000 μC/m²")` which already correctly strips the unit and preserves `"8.0000"` (verified by existing `tests/math-normalize.test.js:strips μC/m² unit`). Task 2 test explicitly asserts `q8.value === '8.0000'`. |
| Preserve scientific notation, `3.7647×10^5` → `3.7647*10^5`, `3.9789×10^-5` → `3.9789*10^-5` | Existing math-normalize Task 1 tests + new Task 2 test asserts `q9.value === '3.9789*10^-5'`. Q7's expected value `3.7647*10^5` is implicit in `summary.filled === 11`. |
| Preserve symbolic answers (`2*epsilon_o*E_o/r`, `-2k` → `-2*k`) | Existing math-normalize tests confirm; new Task 2 test exercises both via the bare format reaching `summary.filled === 11`. |
| Radio still works (`Diamagnetism`) | Task 2 test asserts `radios[1].checked === true`. |
| Add tests for both un-numbered formats; specific Q8/Q9/Q10/Q11 assertions | Task 2 Step 1, both tests explicitly assert each of those. |
| Keep all existing tests passing | Tasks 1 and 2 finish with full-suite `npm test` runs; numbered regression test in Task 2. |
| Implementation scoped to new pipeline files only | Tasks 1, 2, 3 modify only `numbered-parser.js`, `answer-applier.js`, `sidebar.js`. No touch to `answer-parser.js`, `answer-matcher.js`, `math-normalize.js`, `question-detector.js`, `manifest.json`. |
| Logs `mode=numbered`, `mode=ordered-lines`, `fallback=legacy` | Task 2 (`[answer-applier] mode=...`); Task 3 (`[answer-applier] fallback=legacy`). |

All requirements covered.

**2. Placeholder scan**

No "TBD", no "similar to Task N", no "add appropriate handling". Every step contains a concrete code block or exact command.

**3. Type consistency**

- `parseOrderedLines(raw, expectedCount) → Array<{questionNumber, rawAnswer}>` — same shape as `parseNumberedAnswers`. Task 1 defines it, Task 2 consumes it via `numberedParser.parseOrderedLines(...)` — names match.
- `applyAnswers` return now includes `mode: 'numbered' | 'ordered-lines'`. Task 2 Step 3 adds it to BOTH the early-return shape and the normal-return shape. Tests in Task 2 Step 1 check `out.mode` only on the new tests; existing 6 tests don't check `mode`, so they keep passing.
- `WRAPPER_PATTERNS` and `isWrapperLine` are local to `lib/numbered-parser.js` (not exported). No external dependency.

Consistent.

---

## How to run / test

```bash
# Full test suite (Node 20+):
npm test

# Just the modules changed in this plan:
npm test -- --test-reporter=spec tests/numbered-parser.test.js
npm test -- --test-reporter=spec tests/answer-applier.test.js
```

**Manual extension verification:**

1. Open `chrome://extensions` (or `edge://extensions`).
2. Click **Reload** on Clipboard Cleaner. (No manifest change in this plan, so just hot-reload is enough.)
3. Open a Coursera quiz with 11 questions matching the failure shape.
4. Paste either un-numbered format into the **Answering for you** tab.
5. Click **Apply to page**.
6. Open DevTools → Console. Expect `[answer-applier] mode=ordered-lines` log line and per-question fill log lines.
7. Confirm Q8 shows `8.0000` (NOT `00000`), Q9 shows `3.9789*10^-5`, Q10 has Diamagnetism radio selected, Q11 shows `300`.
8. Paste the numbered format on the same page; expect `[answer-applier] mode=numbered` instead and same result.
9. Paste `The answer is A and C` on a quiz with letter options to confirm legacy fallback still works; expect `[answer-applier] fallback=legacy` in console.
