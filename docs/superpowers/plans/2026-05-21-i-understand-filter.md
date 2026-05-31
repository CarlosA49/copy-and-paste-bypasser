# "I understand" Standalone-Line Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip Coursera's repeated standalone "I understand" boilerplate line from copied output, without removing legitimate sentences that merely contain the phrase.

**Architecture:** Add one anchored regex pattern (`/^\s*i\s+understand\s*[.!?]*\s*$/i`) to `JUNK_LINE_PATTERNS` in `lib/cleaner.js`. The pattern is anchored to start (`^`) and end (`$`) of the line — it matches only when the whole line is "I understand" plus optional trailing punctuation. Because both the plain-text cleaner (`cleanCopiedText`) and the HTML cleaner (`cleanSelectionHtml`) read from this same `JUNK_LINE_PATTERNS` array, a single addition propagates to both paths.

**Tech Stack:** Unchanged — vanilla JS, `node:test`, no new dependencies.

---

## Why this works without touching html-cleaner.js

`lib/html-cleaner.js` imports `JUNK_LINE_PATTERNS` from `lib/cleaner.js` and applies the patterns line-by-line inside its Pass 2 `dropJunkBlocks` walker. Same patterns drive both filters. Adding one entry to the source array updates both.

The plain-text cleaner is paragraph-based: it drops the whole paragraph if any line matches a junk pattern. The HTML cleaner is block-element-based: it drops a block element if its `textContent` matches. In both cases a standalone "I understand" — appearing on its own line / inside its own `<p>` / `<div>` — is dropped. A sentence like "I understand how capacitors work." doesn't match the anchored regex, so its paragraph is preserved.

---

## Task 1: Add the pattern + tests

**Files:**
- Modify: `lib/cleaner.js`
- Modify: `tests/cleaner.test.js`
- Modify: `tests/html-cleaner.test.js`

- [ ] **Step 1: Add failing tests in `tests/cleaner.test.js`**

Append at the end of the file:

```js
// --- Standalone "I understand" filter (Coursera boilerplate) ---------------

test('drops a paragraph that is exactly "I understand"', () => {
  const input = 'Real content.\n\nI understand';
  assert.equal(cleanCopiedText(input), 'Real content.');
});

test('drops "I understand." with trailing period', () => {
  const input = 'Real content.\n\nI understand.';
  assert.equal(cleanCopiedText(input), 'Real content.');
});

test('drops "I understand!" with trailing exclamation', () => {
  const input = 'Real content.\n\nI understand!';
  assert.equal(cleanCopiedText(input), 'Real content.');
});

test('drops "i understand" lowercase', () => {
  const input = 'Real content.\n\ni understand';
  assert.equal(cleanCopiedText(input), 'Real content.');
});

test('drops multiple repeated "I understand" lines across a multi-question copy', () => {
  const input = [
    'Question 1',
    'What is the capacitance?',
    '',
    'I understand',
    '',
    '(a) 5 µF',
    '(b) 10 µF',
    '',
    '1 point',
    '',
    'Question 2',
    'Define inductance.',
    '',
    'I understand.',
    '',
    '(a) Property of a coil',
    '(b) Property of a battery',
    '',
    '1 point',
  ].join('\n');
  const result = cleanCopiedText(input);
  assert.doesNotMatch(result, /^\s*I understand\s*$/im);
  assert.match(result, /Question 1/);
  assert.match(result, /What is the capacitance\?/);
  assert.match(result, /\(a\) 5 µF/);
  assert.match(result, /Question 2/);
  assert.match(result, /Define inductance\./);
  assert.match(result, /\(a\) Property of a coil/);
});

test('preserves a sentence that merely contains "I understand"', () => {
  const input = 'I understand how capacitors work.';
  assert.equal(cleanCopiedText(input), 'I understand how capacitors work.');
});

test('preserves "I understand" mid-paragraph alongside other content', () => {
  // A paragraph where one of the lines is the boilerplate but the paragraph
  // ALSO contains a sentence. Paragraph-level filter drops the whole paragraph
  // because one of its lines matches — this is the same trade-off documented
  // for every other JUNK_LINE_PATTERNS entry. If the user wants to keep the
  // mixed paragraph, they need a blank line between the boilerplate and the
  // content. The test asserts the existing trade-off, not a new behaviour.
  const input = 'I understand how capacitors work.\nMore content here.';
  assert.equal(cleanCopiedText(input), 'I understand how capacitors work.\nMore content here.');
});
```

- [ ] **Step 2: Run tests, confirm new ones fail**

Run: `npm test`
Expected: at least 6 failures in the new "I understand" block (current cleaner does not strip standalone "I understand"). The 7th test (preserves the sentence) already passes against the current code, but include it as a regression guard.

- [ ] **Step 3: Add the pattern to `lib/cleaner.js`**

Open `lib/cleaner.js` and find the `JUNK_LINE_PATTERNS` array. After the `/\bdo\s+you\s+understand\b\s*[?.!]*/i` entry (the last existing pattern), add:

```js
    /^\s*i\s+understand\s*[.!?]*\s*$/i,
```

So the tail of the array reads:

```js
    /\bdata-action\b/i,
    /\bcompliance\s+verification\b/i,
    /\bdo\s+you\s+understand\b\s*[?.!]*/i,
    /^\s*i\s+understand\s*[.!?]*\s*$/i,
  ];
```

Anchors `^` and `$` plus the line-by-line check inside `isJunkLine` mean this pattern matches ONLY when the entire line is "I understand" (case-insensitive, optional surrounding whitespace, optional trailing `.`/`!`/`?`).

- [ ] **Step 4: Add a parallel HTML test in `tests/html-cleaner.test.js`**

Append at the end of the file:

```js
// --- Standalone "I understand" filter ---------------------------------------

test('drops a <p>I understand</p> block but keeps question text and answers', () => {
  const input =
    '<h3>Question 1</h3>' +
    '<p>What is the capacitance?</p>' +
    '<p>I understand</p>' +
    '<ol><li>5 µF</li><li>10 µF</li></ol>' +
    '<p>1 point</p>';
  const { cleanHtml, cleanText } = cleanSelectionHtml(input);
  assert.doesNotMatch(cleanHtml, /<p>I understand<\/p>/);
  assert.match(cleanHtml, /<h3>Question 1<\/h3>/);
  assert.match(cleanHtml, /<p>What is the capacitance\?<\/p>/);
  assert.match(cleanHtml, /<ol>/);
  assert.match(cleanHtml, /<p>1 point<\/p>/);
  assert.doesNotMatch(cleanText, /^\s*I understand\s*$/im);
});

test('preserves <p>I understand how capacitors work.</p>', () => {
  const input = '<p>I understand how capacitors work.</p>';
  const { cleanHtml, cleanText } = cleanSelectionHtml(input);
  assert.match(cleanHtml, /<p>I understand how capacitors work\.<\/p>/);
  assert.equal(cleanText, 'I understand how capacitors work.');
});
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 73 + 7 (cleaner.js tests) + 2 (html-cleaner tests) = 82 tests pass. Exit 0.

If any test fails, read the actual vs expected. The most likely cause is a misaligned regex anchor (`^`/`$` semantics within the cleaner's per-line check should already work).

- [ ] **Step 6: Commit**

```bash
git add lib/cleaner.js tests/cleaner.test.js tests/html-cleaner.test.js
git commit -m "feat: drop standalone 'I understand' boilerplate line"
```

---

## Self-Review

**Spec coverage:**
- Removes standalone `I understand`, `I understand.`, `I understand!` → covered by tests 1, 2, 3 of the new cleaner block.
- Does not remove a legitimate sentence containing "I understand" → covered by test 6.
- Removed from multiple copied questions in the same selection → covered by test 5 (multi-question fixture).
- Normal question text and answer choices remain → asserted in test 5 and the HTML test.
- Plain-text cleaner updated → adding to `JUNK_LINE_PATTERNS` updates `cleanCopiedText`.
- HTML cleaner updated → same `JUNK_LINE_PATTERNS` is imported by `lib/html-cleaner.js`, so the new pattern propagates automatically. HTML test guards this.

**Placeholder scan:** No TBDs. Every step contains the code or command needed.

**Type consistency:** `JUNK_LINE_PATTERNS` is the existing exported array; `cleanCopiedText` and `cleanSelectionHtml` are existing functions; no new names introduced.

**Risk:** The pattern uses the same anchored line shape as the rest of `JUNK_LINE_PATTERNS`. The trade-off documented in test 7 (paragraph-level filter drops the whole paragraph if any internal line matches) is preserved — same behaviour as every other pattern. Acceptable.
