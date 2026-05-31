# Multi-segment autopilot paste — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user pastes answers in `(A) X, (B) Y, (C) Z` (multi-sub-blank), `X – Y – Z` (sequence), `X ≥ Y ≥ Z` (ordering), or free prose format into the autopilot "Answer for you" flow, fill the right sub-input or refuse cleanly instead of always selecting the first choice on every question.

**Architecture:** Two pure-logic libraries get extended; no DOM changes, no new modules. (1) `lib/numbered-parser.js` attaches a `segments: [{ kind, label, value }]` field to each parsed `{ questionNumber, rawAnswer }` when it detects sub-blank/sequence patterns. (2) `lib/answer-applier.js` consumes `segments`: routes them positionally to multi-target text questions, refuses single_choice questions that received obviously multi-segment input (instead of guessing with substring-scan and picking option A), and tightens `pickChoice`'s substring fallback so 1–2-char option labels don't false-match against long answer prose.

**Tech Stack:** Node 22+ `node:test` runner, plain ES5/ES2015 JS in `lib/*.js` (no transpilation; browser-extension content script context). JSDOM-backed tests already exist for the applier. No new dependencies.

---

## Background & Root Cause

The user pasted this 10-line block into the "Answer for you" tab and every question got the first option (A) selected:

```
(A) uncertainty, (B) fair, (C) 1
(A) 2W, (B) infinite, (C) decreased, (D) increased
(A) radio wave, (B) frequency, (C) bandwidth, (D) power
(A) N₀/2, (B) N₀W, (C) 2W, (D) W log₂(1 + P/N₀W)
Channel Encoding – Constellation Mapping – Waveform Mapping – Up Converting & Power Amp
(A) boundaries, (B) possible, (C) increases
If users in different cells reuse the same frequency channels, the required bandwidth becomes much reduced.
(A) MCS, (B) CQI, (C) AMC
(A) orthogonal, (B) orthogonal, (C) quasi-orthogonal
TDMA ≥ FDMA ≥ CDMA
```

**Trace:**
1. `numberedParser.parseNumberedAnswers` runs `layerLineFallback` (no line starts with `\d+[.):]`) → returns 10 items, each `{ questionNumber: i+1, rawAnswer: <whole line> }`.
2. `answerApplier.applyAnswers` dispatches per question. For `single_choice` questions with short letter-style option labels (`"A"`, `"B"`, `"C"`, `"D"`), it calls `pickChoice(choices, rawAnswer)`.
3. `pickChoice` in `lib/answer-applier.js:41-59`:
    - Skips the letter shortcut (the raw isn't a bare single letter).
    - Direct-text match fails (no choice text equals the whole line).
    - **Substring fallback** (line 50-52): `choices.find(c => c.text.indexOf(n) !== -1 || n.indexOf(c.text) !== -1)`. With `c.text === "A"` and the answer containing letter `A` anywhere, the second branch matches → returns the first choice every time.

So every line, regardless of format, picks option A.

Even after the substring scan is tightened, the deeper feature gap remains: `(A) X, (B) Y, (C) Z` is meant for multi-blank text-fill questions where one numbered question exposes ≥2 input boxes. `lib/answer-applier.js:152-178` already only ever writes to `q.targets[0]`, so even if the question were correctly typed as `math_input`, only blank A would get a value (the whole comma-joined string at that). We need segment parsing + positional routing across `q.targets[]`.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `lib/numbered-parser.js` | modify | Detect multi-segment patterns inside each `rawAnswer` and attach `segments: [{ kind, label, value }]` on the returned items. No changes to the cascading parser shape — just an additive annotation. |
| `lib/answer-applier.js` | modify | (a) Tighten `pickChoice` substring guard for short option labels. (b) In `applyAnswers`, when a parsed item has `segments` and the question is multi-target text → route segments positionally. (c) When segments exist and the question is `single_choice`/`multiple_choice` with short option texts → refuse (status `failed`, reason `multi-segment-not-single-choice`) instead of guessing. |
| `tests/numbered-parser.test.js` | modify | Add `parseAnswerSegments` unit tests + `parseNumberedAnswers` annotation tests for letter-segment, sequence-separator, and prose-no-segment inputs. |
| `tests/answer-applier.test.js` | modify | Add: (1) multi-target text-fill routing test, (2) short-option-label substring-guard test (regression for "all-A-bug"), (3) multi-segment-on-single-choice refusal test, (4) prose-passthrough-to-text-target test. |

No new files. No changes to question-detector, sidebar, controller, validator, manifest.

---

## Design decisions (locked here so subtasks don't re-litigate)

1. **Segment grammar** — A "letter segment" is one of: `(A) value`, `A. value`, `A) value`, `A: value` where the letter is a single capital A–H, separated from the next segment by `, ` or ` and `. To qualify as a multi-segment rawAnswer, there MUST be ≥2 segments with ≥2 distinct letters. A single `(A) foo` is NOT segments — it's just prose-with-paren.

2. **Sequence separators** — `–` (U+2013 en-dash), `—` (U+2014 em-dash), `≥` (U+2265), `≤` (U+2264), `→` (U+2192), `←` (U+2190), ` -> `, ` => `. Comma is **excluded** (already used by multi-choice answer parsing and would cause false splits in prose). Must produce ≥2 non-empty trimmed parts to qualify.

3. **Output shape on parsed item:**
    ```js
    { questionNumber: 1, rawAnswer: '(A) uncertainty, (B) fair, (C) 1',
      segments: { kind: 'letters', items: [
        { label: 'A', value: 'uncertainty' },
        { label: 'B', value: 'fair' },
        { label: 'C', value: '1' },
      ] } }
    // OR
    { questionNumber: 5, rawAnswer: 'X – Y – Z',
      segments: { kind: 'sequence', items: [
        { label: null, value: 'X' }, { label: null, value: 'Y' }, { label: null, value: 'Z' },
      ] } }
    // OR (no segments)
    { questionNumber: 7, rawAnswer: 'If users in different cells…' }
    ```
    No `segments` key when not multi-segment — applier checks for presence.

4. **Multi-target routing strategy** — Positional only. `segments.items[i].value` → `q.targets[i]`. If `q.targets.length !== segments.items.length`, fall back to filling `min(L, R)` targets and reporting `partial` status for the rest. Trying to match `(A)` labels against per-target sibling text is fragile across Coursera UI variants — skip it. Positional left-to-right matches how the user wrote the answer.

5. **pickChoice short-label guard** — When `normalizeChoiceText(c.text).length <= 2`, skip the substring branch entirely (line 50-52 of current applier). The letter-shortcut branch (line 44-47) and direct-match branch (line 49) still run. Jaccard branch (line 53-58) still runs, but with `tokens(s)` requiring length > 1, a 1-char option produces an empty token set and jaccard returns 0 — so it'll also miss. Net: 1–2-char option labels can only be selected by the explicit letter shortcut.

6. **Refusal for multi-segment-on-single-choice** — When `applyAnswers` sees `p.segments` set AND `q.type === 'single_choice' || q.type === 'multiple_choice'` AND all `q.choices` have `normalizeChoiceText(c.text).length <= 2`: push `{ status: 'failed', reason: 'multi-segment-not-single-choice', rawAnswer: p.rawAnswer }` and return. Don't call pickChoice. This stops the wrong-answer-fill that motivated the report. Long-text choices (≥3 chars) still go through pickChoice — `(A) uncertainty` against a long-text choice "uncertainty" picks correctly.

7. **Prose-passthrough is implicit** — If `p.segments` is absent and `q.type === 'math_input'`, the existing single-target text-fill path runs unchanged. No new code needed.

---

## Tasks

### Task 1: Add `parseAnswerSegments` to numbered-parser

**Files:**
- Modify: `lib/numbered-parser.js` (add new function, no changes to existing exports)
- Test: `tests/numbered-parser.test.js` (new test file already exists; append tests at end)

- [ ] **Step 1: Write the failing tests**

Append to `tests/numbered-parser.test.js`:

```js
test('parseAnswerSegments: letter segments with (A) (B) (C)', () => {
  const r = numberedParser.parseAnswerSegments('(A) uncertainty, (B) fair, (C) 1');
  assert.deepEqual(r, { kind: 'letters', items: [
    { label: 'A', value: 'uncertainty' },
    { label: 'B', value: 'fair' },
    { label: 'C', value: '1' },
  ]});
});

test('parseAnswerSegments: letter segments with A. B. C.', () => {
  const r = numberedParser.parseAnswerSegments('A. apple, B. banana, C. cherry');
  assert.equal(r.kind, 'letters');
  assert.deepEqual(r.items.map(i => i.label), ['A', 'B', 'C']);
  assert.deepEqual(r.items.map(i => i.value), ['apple', 'banana', 'cherry']);
});

test('parseAnswerSegments: letter segments tolerant of inner punctuation in value', () => {
  const r = numberedParser.parseAnswerSegments('(A) N₀/2, (B) N₀W, (C) 2W, (D) W log₂(1 + P/N₀W)');
  assert.equal(r.kind, 'letters');
  assert.equal(r.items.length, 4);
  assert.equal(r.items[3].value, 'W log₂(1 + P/N₀W)');
});

test('parseAnswerSegments: single (A) item is NOT segments (needs ≥2 distinct letters)', () => {
  assert.equal(numberedParser.parseAnswerSegments('(A) only one'), null);
});

test('parseAnswerSegments: repeated letter "(A) x, (A) y" is NOT segments', () => {
  assert.equal(numberedParser.parseAnswerSegments('(A) x, (A) y'), null);
});

test('parseAnswerSegments: sequence with en-dash separator', () => {
  const r = numberedParser.parseAnswerSegments('Channel Encoding – Constellation Mapping – Waveform Mapping');
  assert.deepEqual(r, { kind: 'sequence', items: [
    { label: null, value: 'Channel Encoding' },
    { label: null, value: 'Constellation Mapping' },
    { label: null, value: 'Waveform Mapping' },
  ]});
});

test('parseAnswerSegments: sequence with ≥ separator', () => {
  const r = numberedParser.parseAnswerSegments('TDMA ≥ FDMA ≥ CDMA');
  assert.equal(r.kind, 'sequence');
  assert.deepEqual(r.items.map(i => i.value), ['TDMA', 'FDMA', 'CDMA']);
});

test('parseAnswerSegments: sequence with → separator', () => {
  const r = numberedParser.parseAnswerSegments('first → second → third');
  assert.equal(r.kind, 'sequence');
  assert.equal(r.items.length, 3);
});

test('parseAnswerSegments: prose with single comma is NOT segments', () => {
  // Comma is NOT a sequence separator. Single hyphen is NOT a sequence separator
  // (only en-dash, em-dash, etc.).
  assert.equal(numberedParser.parseAnswerSegments('one comma, two comma'), null);
});

test('parseAnswerSegments: long prose with no separators returns null', () => {
  assert.equal(numberedParser.parseAnswerSegments('If users in different cells reuse the same frequency channels, the required bandwidth becomes much reduced.'), null);
});

test('parseAnswerSegments: returns null for empty / non-string', () => {
  assert.equal(numberedParser.parseAnswerSegments(''), null);
  assert.equal(numberedParser.parseAnswerSegments(null), null);
  assert.equal(numberedParser.parseAnswerSegments(42), null);
});

test('parseAnswerSegments: letters beat sequence when both present', () => {
  // "(A) X – Y, (B) Z – W" → letters wins (segments come first).
  const r = numberedParser.parseAnswerSegments('(A) X – Y, (B) Z – W');
  assert.equal(r.kind, 'letters');
  assert.equal(r.items.length, 2);
});
```

(`numberedParser` is already required at the top of the existing test file. If your file uses a different variable name, adapt the calls but keep the assertions verbatim.)

- [ ] **Step 2: Run the tests, confirm all 12 fail with `TypeError: numberedParser.parseAnswerSegments is not a function`**

Run: `npm test -- --test-name-pattern="parseAnswerSegments"`
Expected: 12 failing tests with `TypeError`.

- [ ] **Step 3: Implement `parseAnswerSegments` in `lib/numbered-parser.js`**

Insert this function above `parseNumberedAnswers`:

```js
function parseAnswerSegments(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  // Letter segments. Matches "(A) value", "A. value", "A) value", "A: value".
  // The next-letter pattern + end-of-string serves as the value terminator so we
  // don't have to track commas/ands.
  const LETTER_RE = /(?:\(([A-H])\)|\b([A-H])[.:)])\s*([\s\S]*?)(?=(?:\s*,\s*|\s+and\s+)(?:\(([A-H])\)|\b([A-H])[.:)])|$)/g;
  const letterItems = [];
  let m;
  while ((m = LETTER_RE.exec(s)) !== null) {
    const label = m[1] || m[2];
    const value = (m[3] || '').trim();
    if (!value) continue;
    letterItems.push({ label: label, value: value });
  }
  if (letterItems.length >= 2) {
    const distinct = new Set(letterItems.map(function (it) { return it.label; }));
    if (distinct.size >= 2) {
      return { kind: 'letters', items: letterItems };
    }
  }

  // Sequence separators (NOT comma — too noisy in prose).
  const SEQ_RE = /\s+(?:–|—|≥|≤|→|←|->|=>)\s+/g;
  if (SEQ_RE.test(s)) {
    const parts = s.split(SEQ_RE).map(function (p) { return p.trim(); }).filter(Boolean);
    if (parts.length >= 2) {
      return { kind: 'sequence', items: parts.map(function (p) { return { label: null, value: p }; }) };
    }
  }

  return null;
}
```

Add `parseAnswerSegments: parseAnswerSegments,` to the `api` object at the bottom of the file:

```js
const api = {
  parseNumberedAnswers: parseNumberedAnswers,
  parseOrderedLines: parseOrderedLines,
  parseAnswerSegments: parseAnswerSegments,
};
```

- [ ] **Step 4: Run the tests, confirm all 12 pass**

Run: `npm test -- --test-name-pattern="parseAnswerSegments"`
Expected: 12 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/numbered-parser.js tests/numbered-parser.test.js
git commit -m "feat(numbered-parser): parseAnswerSegments for (A) (B) (C) and X – Y – Z patterns"
```

---

### Task 2: Annotate `parseNumberedAnswers` output with segments

**Files:**
- Modify: `lib/numbered-parser.js` (annotate in `dedupByQuestion` so all paths get it)
- Test: `tests/numbered-parser.test.js` (append annotation tests)

- [ ] **Step 1: Write the failing tests**

Append to `tests/numbered-parser.test.js`:

```js
test('parseNumberedAnswers: line-fallback annotates segments on each item', () => {
  const raw = '(A) uncertainty, (B) fair, (C) 1\n(A) 2W, (B) infinite, (C) decreased, (D) increased\nprose with no separators here';
  const out = numberedParser.parseNumberedAnswers(raw);
  assert.equal(out.length, 3);
  assert.ok(out[0].segments && out[0].segments.kind === 'letters');
  assert.equal(out[0].segments.items.length, 3);
  assert.ok(out[1].segments && out[1].segments.kind === 'letters');
  assert.equal(out[1].segments.items.length, 4);
  assert.equal(out[2].segments, undefined);
});

test('parseNumberedAnswers: numbered list also gets segment annotation', () => {
  const raw = '1. (A) red, (B) blue\n2. plain answer\n3. X – Y – Z';
  const out = numberedParser.parseNumberedAnswers(raw);
  assert.equal(out.length, 3);
  assert.equal(out[0].segments && out[0].segments.kind, 'letters');
  assert.equal(out[1].segments, undefined);
  assert.equal(out[2].segments && out[2].segments.kind, 'sequence');
});
```

- [ ] **Step 2: Run the tests, confirm both fail because `segments` is undefined on the items**

Run: `npm test -- --test-name-pattern="parseNumberedAnswers:"`
Expected: 2 new failures (plus pre-existing tests still passing).

- [ ] **Step 3: Annotate in `dedupByQuestion`**

In `lib/numbered-parser.js`, replace the `dedupByQuestion` function with:

```js
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
    const entry = { questionNumber: it.questionNumber, rawAnswer: ans };
    const segs = parseAnswerSegments(ans);
    if (segs) entry.segments = segs;
    out.push(entry);
  });
  out.sort(function (a, b) { return a.questionNumber - b.questionNumber; });
  return out;
}
```

(`parseAnswerSegments` is defined above in the same file from Task 1.)

- [ ] **Step 4: Run the tests, confirm passing**

Run: `npm test -- --test-name-pattern="parseNumberedAnswers:"`
Expected: all `parseNumberedAnswers:`-prefixed tests pass.

- [ ] **Step 5: Run full numbered-parser suite to catch regressions**

Run: `npm test -- tests/numbered-parser.test.js`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/numbered-parser.js tests/numbered-parser.test.js
git commit -m "feat(numbered-parser): annotate parsed items with segments when (A)/(B)/sequence detected"
```

---

### Task 3: Tighten `pickChoice` substring guard for short option labels

**Files:**
- Modify: `lib/answer-applier.js:41-59` (function `pickChoice`)
- Test: `tests/answer-applier.test.js` (append regression test)

- [ ] **Step 1: Write the failing test**

Append to `tests/answer-applier.test.js`:

```js
test('regression: short letter-only option labels do NOT substring-match long answer prose (all-A bug)', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html><body>'
    + '<section><h3>Question 1</h3><p>P</p>'
    + '<label><input type="radio" name="r1" value="A">A</label>'
    + '<label><input type="radio" name="r1" value="B">B</label>'
    + '<label><input type="radio" name="r1" value="C">C</label>'
    + '</section>'
    + '</body></html>'
  );
  // Raw answer is a multi-sub-blank paste; no single letter selection intended.
  const raw = '(A) uncertainty, (B) fair, (C) 1';
  const r = answerApplier.applyAnswers(raw, dom.window.document.body, { verbose: false });
  // The short-label guard means pickChoice's substring fallback can't trigger,
  // and the multi-segment-not-single-choice refusal (Task 4) takes over —
  // either way, no radio gets selected.
  const radios = dom.window.document.querySelectorAll('input[type="radio"]');
  assert.equal(radios[0].checked, false, 'option A must NOT be selected');
  assert.equal(radios[1].checked, false);
  assert.equal(radios[2].checked, false);
});
```

(`answerApplier` is already required at the top of the existing test file. If your file uses a different variable name, adapt the import but keep the assertions verbatim.)

- [ ] **Step 2: Run the test, confirm it fails (option A gets selected today)**

Run: `npm test -- --test-name-pattern="all-A bug"`
Expected: `AssertionError: option A must NOT be selected`.

- [ ] **Step 3: Modify `pickChoice` to skip substring matching for short labels**

In `lib/answer-applier.js`, replace the `pickChoice` function (currently lines 41-59) with:

```js
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
  // Substring fallback — only safe when the option label is long enough that an
  // accidental hit in long answer prose is unlikely. Single-letter labels like
  // "A"/"B" otherwise match any answer containing that letter, causing the
  // "always picks first option" bug.
  const sub = choices.find(function (c) {
    const ct = normalizeChoiceText(c.text);
    if (ct.length <= 2) return false;
    return ct.indexOf(n) !== -1 || n.indexOf(ct) !== -1;
  });
  if (sub) return sub;
  let best = null, bestScore = 0;
  choices.forEach(function (c) {
    const sc = jaccard(tokens(r), tokens(c.text));
    if (sc > bestScore) { bestScore = sc; best = c; }
  });
  return (best && bestScore >= 0.34) ? best : null;
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npm test -- --test-name-pattern="all-A bug"`
Expected: PASS.

- [ ] **Step 5: Run full answer-applier suite to catch regressions**

Run: `npm test -- tests/answer-applier.test.js`
Expected: all tests pass. If any pre-existing test relies on a single-letter option matching against a long string via the substring fallback, that test was asserting the bug — update it to expect `null` from `pickChoice` and add a comment explaining the guard.

- [ ] **Step 6: Commit**

```bash
git add lib/answer-applier.js tests/answer-applier.test.js
git commit -m "fix(answer-applier): pickChoice substring fallback ignores ≤2-char option labels"
```

---

### Task 4: Refuse multi-segment answers on single_choice/multiple_choice with short option labels

**Files:**
- Modify: `lib/answer-applier.js` (inside `applyAnswers`, before the single_choice / multiple_choice branches)
- Test: `tests/answer-applier.test.js` (append refusal test)

- [ ] **Step 1: Write the failing test**

Append to `tests/answer-applier.test.js`:

```js
test('multi-segment answer on single_choice with letter-only options → failed with diagnostic reason', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html><body>'
    + '<section><h3>Question 1</h3><p>P</p>'
    + '<label><input type="radio" name="r1" value="A">A</label>'
    + '<label><input type="radio" name="r1" value="B">B</label>'
    + '<label><input type="radio" name="r1" value="C">C</label>'
    + '</section>'
    + '</body></html>'
  );
  const raw = '(A) uncertainty, (B) fair, (C) 1';
  const r = answerApplier.applyAnswers(raw, dom.window.document.body, { verbose: false });
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].status, 'failed');
  assert.equal(r.results[0].reason, 'multi-segment-not-single-choice');
  assert.equal(r.summary.failed, 1);
  assert.equal(r.summary.filled, 0);
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npm test -- --test-name-pattern="multi-segment-not-single-choice"`
Expected: failure (today: `status: 'failed', reason: 'choice not matched'` after Task 3, or `selected` before Task 3).

- [ ] **Step 3: Add the refusal check in `applyAnswers`**

In `lib/answer-applier.js`, in the `applyAnswers` function, find the block starting with `if (q.type === 'single_choice') {` (around line 181). Insert this guard BEFORE that block (i.e., immediately before the `if (q.type === 'single_choice')` line):

```js
// Multi-segment answers (e.g. "(A) X, (B) Y") aimed at letter-labeled
// choice questions cannot be sensibly mapped to a single pick — refuse
// loudly instead of guessing via substring fallback. Long-text choice
// options (≥3 chars) still go through pickChoice unchanged.
if (p.segments && (q.type === 'single_choice' || q.type === 'multiple_choice')) {
  const shortChoiceLabels = (q.choices || []).every(function (c) {
    return normalizeChoiceText(c.text).length <= 2;
  });
  if (shortChoiceLabels) {
    results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'multi-segment-not-single-choice', rawAnswer: p.rawAnswer });
    if (verbose) console.log('  Q' + q.questionNumber + ' ' + q.type + ' FAIL multi-segment-not-single-choice');
    return;
  }
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `npm test -- --test-name-pattern="multi-segment-not-single-choice"`
Expected: PASS.

- [ ] **Step 5: Run full suite to catch regressions**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/answer-applier.js tests/answer-applier.test.js
git commit -m "feat(answer-applier): refuse multi-segment answers on letter-labeled choice questions"
```

---

### Task 5: Route segments to multi-target text questions

**Files:**
- Modify: `lib/answer-applier.js` (math_input branch in `applyAnswers`)
- Test: `tests/answer-applier.test.js` (append multi-target test)

- [ ] **Step 1: Write the failing test**

Append to `tests/answer-applier.test.js`:

```js
test('multi-target text question: letter segments fill each sub-input positionally', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html><body>'
    + '<section><h3>Question 1</h3><p>Multi-blank prompt</p>'
    + '<label>(A) <input type="text" id="ta" /></label>'
    + '<label>(B) <input type="text" id="tb" /></label>'
    + '<label>(C) <input type="text" id="tc" /></label>'
    + '</section>'
    + '</body></html>'
  );
  const raw = '(A) uncertainty, (B) fair, (C) 1';
  const r = answerApplier.applyAnswers(raw, dom.window.document.body, { verbose: false });
  assert.equal(dom.window.document.getElementById('ta').value, 'uncertainty');
  assert.equal(dom.window.document.getElementById('tb').value, 'fair');
  assert.equal(dom.window.document.getElementById('tc').value, '1');
  assert.equal(r.summary.filled, 1, 'one question fully filled');
});

test('multi-target text question: sequence segments fill positionally', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html><body>'
    + '<section><h3>Question 1</h3><p>Order:</p>'
    + '<input type="text" id="t1" /><input type="text" id="t2" /><input type="text" id="t3" />'
    + '</section>'
    + '</body></html>'
  );
  const raw = 'first – second – third';
  answerApplier.applyAnswers(raw, dom.window.document.body, { verbose: false });
  assert.equal(dom.window.document.getElementById('t1').value, 'first');
  assert.equal(dom.window.document.getElementById('t2').value, 'second');
  assert.equal(dom.window.document.getElementById('t3').value, 'third');
});

test('multi-target text question: segment count > target count fills min(L,R) and reports partial', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html><body>'
    + '<section><h3>Question 1</h3><p>P</p>'
    + '<input type="text" id="ta" /><input type="text" id="tb" />'
    + '</section>'
    + '</body></html>'
  );
  const raw = '(A) one, (B) two, (C) three';
  const r = answerApplier.applyAnswers(raw, dom.window.document.body, { verbose: false });
  assert.equal(dom.window.document.getElementById('ta').value, 'one');
  assert.equal(dom.window.document.getElementById('tb').value, 'two');
  assert.equal(r.results[0].status, 'partial');
  assert.equal(r.results[0].reason, 'segment-count-mismatch');
});

test('single-target text question with no segments: prose fills the one input (passthrough)', () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(
    '<!doctype html><html><body>'
    + '<section><h3>Question 1</h3><p>P</p>'
    + '<textarea id="ta"></textarea>'
    + '</section>'
    + '</body></html>'
  );
  const raw = 'If users in different cells reuse the same frequency channels, the required bandwidth becomes much reduced.';
  answerApplier.applyAnswers(raw, dom.window.document.body, { verbose: false });
  assert.equal(
    dom.window.document.getElementById('ta').value,
    'If users in different cells reuse the same frequency channels, the required bandwidth becomes much reduced.'
  );
});
```

- [ ] **Step 2: Run the tests, confirm 4 failures (the multi-target ones write only to the first input today)**

Run: `npm test -- --test-name-pattern="multi-target text question|single-target text question with no segments"`
Expected: 4 failures (first input gets the whole string; later inputs stay empty).

- [ ] **Step 3: Modify the math_input branch in `applyAnswers`**

In `lib/answer-applier.js`, in the `applyAnswers` function, find the math_input branch (currently `if (q.type === 'math_input' || q.type === 'numerical' || q.type === 'input') {` around line 152). Replace the entire branch body up to its closing `return;` with this:

```js
if (q.type === 'math_input' || q.type === 'numerical' || q.type === 'input') {
  // Multi-target + segments → positional sub-fill.
  if (p.segments && q.targets.length > 1) {
    const segs = p.segments.items;
    const n = Math.min(segs.length, q.targets.length);
    let subFilled = 0;
    const subResults = [];
    for (let j = 0; j < n; j++) {
      const tgt = q.targets[j];
      const valNorm = mathNormalize.normalizeMathAnswer(segs[j].value);
      if (!valNorm) { subResults.push({ index: j, ok: false, reason: 'empty-after-normalize' }); continue; }
      if (tgt.scrollIntoView) { try { tgt.scrollIntoView({ block: 'center' }); } catch (_) {} }
      const rr = fillTextOnce(tgt, valNorm);
      if (rr.ok) { subFilled++; subResults.push({ index: j, ok: true, valueUsed: rr.valueUsed }); }
      else { subResults.push({ index: j, ok: false, reason: rr.reason || 'value-did-not-stick' }); }
    }
    const matched = segs.length === q.targets.length;
    if (matched && subFilled === n) {
      results.push({ questionNumber: q.questionNumber, type: q.type, status: 'filled', rawAnswer: p.rawAnswer, subResults: subResults });
    } else {
      results.push({ questionNumber: q.questionNumber, type: q.type, status: matched ? 'failed' : 'partial', reason: matched ? 'some-sub-fills-failed' : 'segment-count-mismatch', rawAnswer: p.rawAnswer, subResults: subResults });
    }
    if (verbose) console.log('  Q' + q.questionNumber + ' ' + q.type + ' multi-target subFilled=' + subFilled + '/' + n);
    return;
  }

  // Single-target (or no segments): existing behavior, fill q.targets[0] with whole string.
  const normalized = mathNormalize.normalizeMathAnswer(p.rawAnswer);
  if (!normalized) {
    results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: 'empty-after-normalize', rawAnswer: p.rawAnswer });
    return;
  }
  let lastReason = 'unknown';
  let ok = false; let valueUsed = null;
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
  if (ok) {
    results.push({ questionNumber: q.questionNumber, type: q.type, status: 'filled', rawAnswer: p.rawAnswer, normalizedAnswer: normalized, valueUsed: valueUsed });
    if (verbose) console.log('  Q' + q.questionNumber + ' ' + q.type + ' success "' + valueUsed + '"');
  } else {
    results.push({ questionNumber: q.questionNumber, type: q.type, status: 'failed', reason: lastReason, rawAnswer: p.rawAnswer, normalizedAnswer: normalized });
    if (verbose) console.log('  Q' + q.questionNumber + ' ' + q.type + ' FAIL ' + lastReason);
  }
  return;
}
```

The single-target block is the existing implementation, repeated verbatim — the only addition is the multi-target sub-fill branch at the top.

- [ ] **Step 4: Run the new tests, confirm passing**

Run: `npm test -- --test-name-pattern="multi-target text question|single-target text question with no segments"`
Expected: 4 passing.

- [ ] **Step 5: Update the summary counter to count partial results correctly**

In `lib/answer-applier.js`, find the summary aggregation block (around line 216-220, just after the per-question loop):

```js
const filled = results.filter(function (r) { return r.status === 'filled' || r.status === 'selected'; }).length;
const failed = results.filter(function (r) { return r.status === 'failed'; }).length;
```

Change to:

```js
const filled = results.filter(function (r) { return r.status === 'filled' || r.status === 'selected'; }).length;
const failed = results.filter(function (r) { return r.status === 'failed' || r.status === 'partial'; }).length;
```

(Partial counts toward failed in the summary so the user sees a non-zero "skipped" count and investigates. The per-result `status: 'partial'` + `reason: 'segment-count-mismatch'` carries the diagnostic detail.)

- [ ] **Step 6: Run full suite, confirm no regressions**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/answer-applier.js tests/answer-applier.test.js
git commit -m "feat(answer-applier): route (A)/(B)/(C) and sequence segments to multi-target text questions positionally"
```

---

### Task 6: End-to-end integration test with the user's actual paste

**Files:**
- Test: `tests/answer-applier.test.js` (append end-to-end test)

- [ ] **Step 1: Write the test**

Append to `tests/answer-applier.test.js`:

```js
test('E2E: user-reported paste fills multi-target questions, refuses single-letter choices, fills prose', () => {
  const { JSDOM } = require('jsdom');
  // Build a page with 3 questions that mirror typical Coursera shapes:
  //   Q1: 3 text sub-inputs (multi-blank)
  //   Q2: single_choice with letter-only labels A/B/C
  //   Q3: single textarea (prose answer)
  const html = ''
    + '<section><h3>Question 1</h3><p>Multi-blank</p>'
    + '<input type="text" id="q1a" /><input type="text" id="q1b" /><input type="text" id="q1c" />'
    + '</section>'
    + '<section><h3>Question 2</h3><p>Pick one</p>'
    + '<label><input type="radio" name="r2" value="A">A</label>'
    + '<label><input type="radio" name="r2" value="B">B</label>'
    + '<label><input type="radio" name="r2" value="C">C</label>'
    + '</section>'
    + '<section><h3>Question 3</h3><p>Explain</p>'
    + '<textarea id="q3"></textarea>'
    + '</section>';
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>');
  const raw =
    '(A) uncertainty, (B) fair, (C) 1\n'
    + '(A) MCS, (B) CQI, (C) AMC\n'
    + 'If users in different cells reuse the same frequency channels, the required bandwidth becomes much reduced.';
  const r = answerApplier.applyAnswers(raw, dom.window.document.body, { verbose: false });

  // Q1: multi-blank fills positionally
  assert.equal(dom.window.document.getElementById('q1a').value, 'uncertainty');
  assert.equal(dom.window.document.getElementById('q1b').value, 'fair');
  assert.equal(dom.window.document.getElementById('q1c').value, '1');

  // Q2: multi-segment-not-single-choice → no radio selected
  const r2 = dom.window.document.querySelectorAll('input[name="r2"]');
  assert.equal(r2[0].checked, false, 'A must not be selected (regression for all-A bug)');
  assert.equal(r2[1].checked, false);
  assert.equal(r2[2].checked, false);

  // Q3: prose fills the textarea
  assert.equal(
    dom.window.document.getElementById('q3').value,
    'If users in different cells reuse the same frequency channels, the required bandwidth becomes much reduced.'
  );

  assert.equal(r.summary.filled, 2, 'Q1 and Q3 filled');
  assert.equal(r.summary.failed, 1, 'Q2 refused');
});
```

- [ ] **Step 2: Run the test, confirm passing**

Run: `npm test -- --test-name-pattern="E2E: user-reported paste"`
Expected: PASS (all previous tasks together deliver this behavior).

- [ ] **Step 3: Run full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/answer-applier.test.js
git commit -m "test(answer-applier): end-to-end paste-and-fill with user-reported answer block"
```

---

## Manual verification (after all tasks)

1. **Reload the extension at `chrome://extensions`** — required because Chrome caches the content script. Without this, you'll still see the OLD behavior.
2. Open a Coursera page with mixed question types.
3. Paste the user's 10-line block into the autopilot "Answer for you" textarea and click Apply.
4. Expected outcomes per question type:
    - Multi-blank text questions: each sub-blank filled with its corresponding letter segment.
    - Sequence questions (em-dash, ≥, →): positional fill across sub-inputs.
    - Long-form prose: filled into the single text/textarea target.
    - Letter-only single_choice questions (A/B/C): NOT auto-picked; result panel shows "failed (multi-segment-not-single-choice)" — user picks manually.
5. Open DevTools console; verify `[answer-applier]` lines describe each question's status truthfully.

## Self-Review

**Spec coverage:**
- `(A) X, (B) Y, (C) Z` → Tasks 1, 2, 4, 5 ✓
- `X – Y – Z` and `X ≥ Y ≥ Z` → Tasks 1, 2, 5 ✓
- Free prose → Task 5 (passthrough preserved) ✓
- "Always picks first option" regression → Tasks 3, 4 ✓
- Multi-target routing → Task 5 ✓
- Diagnostic refusal for impossible mappings → Task 4 ✓
- End-to-end → Task 6 ✓

**Placeholders:** None. Every code step has the complete function body or insertion block. Test bodies are fully written.

**Type consistency:** `segments.kind` is `'letters'` or `'sequence'` everywhere. `segments.items[].label` is uppercase A–H or `null`. `parseAnswerSegments` named consistently in tests and implementation. Result objects use the same `status`/`reason` keys (`'filled'`, `'failed'`, `'partial'`, `'multi-segment-not-single-choice'`, `'segment-count-mismatch'`, `'some-sub-fills-failed'`).

**Scope:** Six tasks, ~150 lines of production change, ~250 lines of test. Single subsystem (the autopilot paste pipeline). No new dependencies, no UI changes, no manifest changes. Ships in one session.
