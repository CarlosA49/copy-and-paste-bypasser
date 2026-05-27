# "Answering for you" Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new sidebar tab "Answering for you" that parses pasted answer text, cross-references it against on-page quiz options, and auto-selects matching radio buttons / checkboxes. Also make the sidebar tab strip horizontally scrollable.

**Architecture:** Two new pure-ish modules — `lib/answer-parser.js` (DOM-free; turns raw text into structured answer candidates) and `lib/answer-matcher.js` (DOM-aware; finds quiz option elements, matches them against parsed candidates, and applies selection). The sidebar gets a new panel that pipes a textarea's value through parser → matcher → click. Tab strip CSS switches from equal-flex tabs to a single-row, horizontally-scrollable strip.

**Tech Stack:** Vanilla JS (no framework), Chrome MV3 content script, `node --test` + JSDOM for unit tests. Matches the existing patterns in `lib/cleaner.js`, `lib/typing-engine.js`, `lib/typing-injector.js`.

---

## File Structure

- **Create** `lib/answer-parser.js` — Pure text→candidates parser. Exports `parseAnswerText(raw) → { letters: string[], numbers: number[], quotedSnippets: string[], rawText: string }`. Exposed on `window.ClipboardCleaner.answerParser` and via CommonJS for tests.
- **Create** `lib/answer-matcher.js` — DOM matcher. Exports `findOptionGroups(root) → Group[]`, `matchCandidates(groups, parsed) → Match[]`, `applyMatches(matches) → AppliedSummary`. Exposed on `window.ClipboardCleaner.answerMatcher`.
- **Create** `tests/answer-parser.test.js` — Unit tests for the parser (no DOM).
- **Create** `tests/answer-matcher.test.js` — JSDOM-driven tests for option discovery, matching, and selection.
- **Modify** `lib/sidebar.js` — Add the new tab/panel HTML, wire the new panel's button to parser+matcher, register the panel in `setActiveTab` / tab wiring (which already iterates all `.ccp-tab`s, so the loop itself needs no change — but a new tab is added).
- **Modify** `lib/sidebar.css` — Make `.ccp-tabs` horizontally scrollable (single row, no shrink); style the new panel's status/preview chips.
- **Modify** `manifest.json` — Register `lib/answer-parser.js` and `lib/answer-matcher.js` in the content script `js` array (before `lib/sidebar.js`, after `lib/cleaner.js`).

Each file has one responsibility: parsing is pure, matching is DOM-only, sidebar wires them together. Tests mirror file structure.

---

## Task 1: Parser — letter answers

**Files:**
- Create: `lib/answer-parser.js`
- Test: `tests/answer-parser.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/answer-parser.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAnswerText } = require('../lib/answer-parser.js');

test('parseAnswerText: returns empty result for empty/whitespace input', () => {
  assert.deepEqual(parseAnswerText(''), { letters: [], numbers: [], quotedSnippets: [], rawText: '' });
  assert.deepEqual(parseAnswerText('   \n\t '), { letters: [], numbers: [], quotedSnippets: [], rawText: '   \n\t ' });
});

test('parseAnswerText: extracts single capital-letter answer from "The answer is A."', () => {
  const out = parseAnswerText('The answer is A.');
  assert.deepEqual(out.letters, ['A']);
});

test('parseAnswerText: extracts multiple letters from "The correct answers are A and C"', () => {
  const out = parseAnswerText('The correct answers are A and C');
  assert.deepEqual(out.letters, ['A', 'C']);
});

test('parseAnswerText: deduplicates and preserves first-seen order', () => {
  const out = parseAnswerText('A, then C, then A again');
  assert.deepEqual(out.letters, ['A', 'C']);
});

test('parseAnswerText: accepts "(a)" and "a)" forms and normalizes to uppercase', () => {
  assert.deepEqual(parseAnswerText('Pick (a) and b).').letters, ['A', 'B']);
});

test('parseAnswerText: does NOT pick stray letters inside ordinary words', () => {
  // "a" inside "answer" must not count.
  const out = parseAnswerText('The answer involves choosing carefully.');
  assert.deepEqual(out.letters, []);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test -- --test-name-pattern parseAnswerText`
Expected: all 6 tests FAIL (module not found / `parseAnswerText` undefined).

- [ ] **Step 3: Implement the parser shell with letter extraction**

```js
// lib/answer-parser.js
// Pure parser. No DOM. Turns raw text into structured answer candidates.
(function (root) {
  'use strict';

  // Match an answer letter when it's standalone — either wrapped in (), followed by a closing
  // marker like ) . : , space EOL, or both. Captures A–H (Coursera questions rarely exceed 8 options).
  // Examples that match: "A.", "(b)", "C)", "answer is D ", "D,"
  // Examples that do NOT match: "a" inside "answer", "act"
  const LETTER_PATTERN = /(?:\(([A-Ha-h])\)|(?:^|[\s,.;:])([A-Ha-h])(?=[\s.,:;)\]]|$))/g;

  function parseAnswerText(raw) {
    const rawText = typeof raw === 'string' ? raw : '';
    const letters = [];
    const seen = new Set();
    if (rawText.trim().length === 0) {
      return { letters: [], numbers: [], quotedSnippets: [], rawText: rawText };
    }
    let m;
    LETTER_PATTERN.lastIndex = 0;
    while ((m = LETTER_PATTERN.exec(rawText)) !== null) {
      const ch = (m[1] || m[2] || '').toUpperCase();
      if (!ch) continue;
      if (!seen.has(ch)) { seen.add(ch); letters.push(ch); }
    }
    return { letters: letters, numbers: [], quotedSnippets: [], rawText: rawText };
  }

  const api = { parseAnswerText: parseAnswerText };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.answerParser = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern parseAnswerText`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/answer-parser.js tests/answer-parser.test.js
git commit -m "feat(answer-parser): extract letter answers from pasted text"
```

---

## Task 2: Parser — numeric and quoted-snippet candidates

**Files:**
- Modify: `lib/answer-parser.js`
- Modify: `tests/answer-parser.test.js`

- [ ] **Step 1: Add failing tests for numbers and quoted snippets**

Append to `tests/answer-parser.test.js`:

```js
test('parseAnswerText: extracts numeric option references like "Option 2" and "#3"', () => {
  const out = parseAnswerText('Pick option 2 and choice #3');
  assert.deepEqual(out.numbers, [2, 3]);
});

test('parseAnswerText: extracts numbers in "1)" / "1." enumerated forms', () => {
  const out = parseAnswerText('Correct: 1) and 4.');
  assert.deepEqual(out.numbers, [1, 4]);
});

test('parseAnswerText: ignores standalone numbers without an option marker', () => {
  // "I have 5 apples" should not pretend 5 is an option index.
  const out = parseAnswerText('I have 5 apples and 12 oranges.');
  assert.deepEqual(out.numbers, []);
});

test('parseAnswerText: extracts double-quoted snippets verbatim', () => {
  const out = parseAnswerText('Pick "Gradient descent" and "Backpropagation"');
  assert.deepEqual(out.quotedSnippets, ['Gradient descent', 'Backpropagation']);
});

test('parseAnswerText: extracts single-quoted snippets and trims whitespace', () => {
  const out = parseAnswerText("Choose '  cross entropy  '");
  assert.deepEqual(out.quotedSnippets, ['cross entropy']);
});

test('parseAnswerText: ignores empty quoted snippets', () => {
  const out = parseAnswerText('Pick "" and "real"');
  assert.deepEqual(out.quotedSnippets, ['real']);
});

test('parseAnswerText: combined extraction does not drop earlier categories', () => {
  const out = parseAnswerText('A. "Gradient descent". Also pick option 3.');
  assert.deepEqual(out.letters, ['A']);
  assert.deepEqual(out.numbers, [3]);
  assert.deepEqual(out.quotedSnippets, ['Gradient descent']);
});
```

- [ ] **Step 2: Run the new tests and verify failure**

Run: `npm test -- --test-name-pattern parseAnswerText`
Expected: the 7 new tests FAIL (numbers/quotedSnippets stay empty).

- [ ] **Step 3: Extend the parser**

Replace the body of `parseAnswerText` in `lib/answer-parser.js` with:

```js
  const LETTER_PATTERN = /(?:\(([A-Ha-h])\)|(?:^|[\s,.;:])([A-Ha-h])(?=[\s.,:;)\]]|$))/g;
  // Matches: "option 2", "choice 3", "answer 4", "#5", "1)", "1."
  const NUMBER_PATTERN = /(?:\b(?:option|choice|answer)\s+(\d{1,2})\b|#(\d{1,2})\b|(?:^|\s)(\d{1,2})(?=[).])/gi;
  // Matches "...", '...', or “...” (curly). Captures inner text.
  const QUOTE_PATTERN = /"([^"]*)"|'([^']*)'|“([^”]*)”/g;

  function parseAnswerText(raw) {
    const rawText = typeof raw === 'string' ? raw : '';
    const letters = [];
    const numbers = [];
    const quotedSnippets = [];
    if (rawText.trim().length === 0) {
      return { letters: letters, numbers: numbers, quotedSnippets: quotedSnippets, rawText: rawText };
    }
    const seenLetters = new Set();
    LETTER_PATTERN.lastIndex = 0;
    let m;
    while ((m = LETTER_PATTERN.exec(rawText)) !== null) {
      const ch = (m[1] || m[2] || '').toUpperCase();
      if (ch && !seenLetters.has(ch)) { seenLetters.add(ch); letters.push(ch); }
    }
    const seenNums = new Set();
    NUMBER_PATTERN.lastIndex = 0;
    while ((m = NUMBER_PATTERN.exec(rawText)) !== null) {
      const nStr = m[1] || m[2] || m[3];
      if (!nStr) continue;
      const n = parseInt(nStr, 10);
      if (!Number.isFinite(n) || n < 1 || n > 20) continue;
      if (!seenNums.has(n)) { seenNums.add(n); numbers.push(n); }
    }
    QUOTE_PATTERN.lastIndex = 0;
    while ((m = QUOTE_PATTERN.exec(rawText)) !== null) {
      const s = (m[1] || m[2] || m[3] || '').trim();
      if (s.length > 0) quotedSnippets.push(s);
    }
    return { letters: letters, numbers: numbers, quotedSnippets: quotedSnippets, rawText: rawText };
  }
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern parseAnswerText`
Expected: all 13 tests passing.

- [ ] **Step 5: Commit**

```bash
git add lib/answer-parser.js tests/answer-parser.test.js
git commit -m "feat(answer-parser): extract numeric and quoted-snippet candidates"
```

---

## Task 3: Matcher — find option groups in the DOM

**Files:**
- Create: `lib/answer-matcher.js`
- Test: `tests/answer-matcher.test.js`

- [ ] **Step 1: Write failing tests for `findOptionGroups`**

```js
// tests/answer-matcher.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { findOptionGroups } = require('../lib/answer-matcher.js');

function dom(html) {
  return new JSDOM('<!doctype html><html><body>' + html + '</body></html>').window.document;
}

test('findOptionGroups: returns [] when document has no inputs', () => {
  const d = dom('<p>nothing here</p>');
  assert.deepEqual(findOptionGroups(d.body), []);
});

test('findOptionGroups: groups radios sharing a name', () => {
  const d = dom(
    '<fieldset>' +
      '<label><input type="radio" name="q1" value="a"> First option</label>' +
      '<label><input type="radio" name="q1" value="b"> Second option</label>' +
      '<label><input type="radio" name="q1" value="c"> Third option</label>' +
    '</fieldset>'
  );
  const groups = findOptionGroups(d.body);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'radio');
  assert.equal(groups[0].options.length, 3);
  assert.equal(groups[0].options[0].text, 'First option');
  assert.equal(groups[0].options[1].text, 'Second option');
});

test('findOptionGroups: groups checkboxes sharing a name', () => {
  const d = dom(
    '<label><input type="checkbox" name="multi" value="x"> Gradient descent</label>' +
    '<label><input type="checkbox" name="multi" value="y"> Backpropagation</label>'
  );
  const groups = findOptionGroups(d.body);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'checkbox');
  assert.equal(groups[0].options.length, 2);
});

test('findOptionGroups: separates groups by name attribute', () => {
  const d = dom(
    '<label><input type="radio" name="q1"> One</label>' +
    '<label><input type="radio" name="q1"> Two</label>' +
    '<label><input type="radio" name="q2"> Alpha</label>' +
    '<label><input type="radio" name="q2"> Beta</label>'
  );
  const groups = findOptionGroups(d.body);
  assert.equal(groups.length, 2);
});

test('findOptionGroups: skips disabled inputs', () => {
  const d = dom(
    '<label><input type="radio" name="q1"> A</label>' +
    '<label><input type="radio" name="q1" disabled> B</label>'
  );
  const groups = findOptionGroups(d.body);
  assert.equal(groups[0].options.length, 1);
});

test('findOptionGroups: derives option text from explicit label[for=id] when label does not wrap input', () => {
  const d = dom(
    '<input type="radio" name="q1" id="opt-a"><label for="opt-a">Choice A</label>' +
    '<input type="radio" name="q1" id="opt-b"><label for="opt-b">Choice B</label>'
  );
  const groups = findOptionGroups(d.body);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].options[0].text, 'Choice A');
  assert.equal(groups[0].options[1].text, 'Choice B');
});

test('findOptionGroups: handles ARIA radio/checkbox roles on non-input elements', () => {
  const d = dom(
    '<div role="radiogroup">' +
      '<div role="radio" aria-checked="false">Option X</div>' +
      '<div role="radio" aria-checked="false">Option Y</div>' +
    '</div>'
  );
  const groups = findOptionGroups(d.body);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'radio');
  assert.equal(groups[0].options[0].text, 'Option X');
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- --test-name-pattern findOptionGroups`
Expected: all 7 fail (module missing).

- [ ] **Step 3: Implement `findOptionGroups` and the module shell**

```js
// lib/answer-matcher.js
// DOM matcher: finds quiz option groups, matches parsed candidates, applies selection.
(function (root) {
  'use strict';

  function textOf(el) {
    if (!el) return '';
    // Prefer associated label content. Fall back to the element's own text.
    const id = el.id;
    let labelText = '';
    if (id) {
      const lbl = el.ownerDocument.querySelector('label[for="' + cssEscape(id) + '"]');
      if (lbl) labelText = lbl.textContent || '';
    }
    if (!labelText) {
      const wrappingLabel = el.closest && el.closest('label');
      if (wrappingLabel) labelText = wrappingLabel.textContent || '';
    }
    if (!labelText) labelText = el.textContent || '';
    return labelText.replace(/\s+/g, ' ').trim();
  }

  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
  }

  function isUsable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled) return false;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  }

  function findNativeGroups(root) {
    const groups = new Map(); // key: kind + '::' + name
    const inputs = root.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    inputs.forEach(function (inp) {
      if (!isUsable(inp)) return;
      const kind = inp.type === 'radio' ? 'radio' : 'checkbox';
      const name = inp.name || '__anon__:' + (inp.form ? inp.form.name || '' : '');
      const key = kind + '::' + name;
      if (!groups.has(key)) groups.set(key, { kind: kind, name: name, options: [] });
      groups.get(key).options.push({ el: inp, text: textOf(inp), index: groups.get(key).options.length });
    });
    return Array.from(groups.values()).filter(function (g) { return g.options.length > 0; });
  }

  function findAriaGroups(root) {
    const out = [];
    const radioGroups = root.querySelectorAll('[role="radiogroup"]');
    radioGroups.forEach(function (rg) {
      const items = rg.querySelectorAll('[role="radio"]');
      if (items.length === 0) return;
      const options = [];
      items.forEach(function (it, i) {
        if (!isUsable(it)) return;
        options.push({ el: it, text: textOf(it), index: i });
      });
      if (options.length > 0) out.push({ kind: 'radio', name: rg.id || '__aria__', options: options });
    });
    // Standalone role="checkbox" elements are treated as one group per common ancestor with role="group"
    // For simplicity, treat all role=checkbox under a common parent (root) as a single group only if
    // no role=group is present. Otherwise group by role=group ancestor id/element identity.
    const groupContainers = root.querySelectorAll('[role="group"]');
    const seenChecks = new Set();
    groupContainers.forEach(function (gc) {
      const items = gc.querySelectorAll('[role="checkbox"]');
      if (items.length === 0) return;
      const options = [];
      items.forEach(function (it, i) {
        if (!isUsable(it)) return;
        seenChecks.add(it);
        options.push({ el: it, text: textOf(it), index: i });
      });
      if (options.length > 0) out.push({ kind: 'checkbox', name: gc.id || '__aria__', options: options });
    });
    const looseChecks = root.querySelectorAll('[role="checkbox"]');
    const orphan = [];
    looseChecks.forEach(function (it, i) {
      if (seenChecks.has(it)) return;
      if (!isUsable(it)) return;
      orphan.push({ el: it, text: textOf(it), index: i });
    });
    if (orphan.length > 0) out.push({ kind: 'checkbox', name: '__aria_loose__', options: orphan });
    return out;
  }

  function findOptionGroups(root) {
    if (!root) return [];
    return findNativeGroups(root).concat(findAriaGroups(root));
  }

  const api = { findOptionGroups: findOptionGroups };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.answerMatcher = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern findOptionGroups`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/answer-matcher.js tests/answer-matcher.test.js
git commit -m "feat(answer-matcher): discover native and ARIA option groups"
```

---

## Task 4: Matcher — match candidates to option indexes

**Files:**
- Modify: `lib/answer-matcher.js`
- Modify: `tests/answer-matcher.test.js`

- [ ] **Step 1: Add failing tests for `matchCandidates`**

Append to `tests/answer-matcher.test.js`:

```js
const { matchCandidates } = require('../lib/answer-matcher.js');

function radioGroup(d, texts) {
  texts.forEach(function (t, i) {
    const label = d.createElement('label');
    const inp = d.createElement('input');
    inp.type = 'radio'; inp.name = 'q1';
    label.appendChild(inp);
    label.appendChild(d.createTextNode(' ' + t));
    d.body.appendChild(label);
  });
  return findOptionGroups(d.body)[0];
}

test('matchCandidates: letter A → first option of the group', () => {
  const d = dom('');
  const g = radioGroup(d, ['Alpha', 'Beta', 'Gamma']);
  const matches = matchCandidates([g], { letters: ['A'], numbers: [], quotedSnippets: [], rawText: '' });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].option.index, 0);
  assert.equal(matches[0].reason, 'letter');
});

test('matchCandidates: letter C → third option', () => {
  const d = dom('');
  const g = radioGroup(d, ['Alpha', 'Beta', 'Gamma']);
  const matches = matchCandidates([g], { letters: ['C'], numbers: [], quotedSnippets: [], rawText: '' });
  assert.equal(matches[0].option.index, 2);
});

test('matchCandidates: number 2 → second option', () => {
  const d = dom('');
  const g = radioGroup(d, ['Alpha', 'Beta', 'Gamma']);
  const matches = matchCandidates([g], { letters: [], numbers: [2], quotedSnippets: [], rawText: '' });
  assert.equal(matches[0].option.index, 1);
  assert.equal(matches[0].reason, 'number');
});

test('matchCandidates: quoted snippet → option whose label contains the snippet (case-insensitive)', () => {
  const d = dom('');
  const g = radioGroup(d, ['Gradient descent', 'Linear regression', 'Backpropagation']);
  const matches = matchCandidates([g], { letters: [], numbers: [], quotedSnippets: ['BACKPROP'], rawText: '' });
  assert.equal(matches[0].option.index, 2);
  assert.equal(matches[0].reason, 'snippet');
});

test('matchCandidates: snippet falls back to token-overlap when no direct substring match', () => {
  const d = dom('');
  const g = radioGroup(d, ['Stochastic gradient descent optimizer', 'Naive Bayes classifier', 'K-means clustering']);
  const matches = matchCandidates([g], { letters: [], numbers: [], quotedSnippets: ['stochastic optimizer'], rawText: '' });
  assert.equal(matches[0].option.index, 0);
  assert.equal(matches[0].reason, 'overlap');
});

test('matchCandidates: out-of-range letter is ignored, not clamped', () => {
  const d = dom('');
  const g = radioGroup(d, ['Alpha', 'Beta']); // only A, B exist
  const matches = matchCandidates([g], { letters: ['D'], numbers: [], quotedSnippets: [], rawText: '' });
  assert.equal(matches.length, 0);
});

test('matchCandidates: out-of-range number is ignored', () => {
  const d = dom('');
  const g = radioGroup(d, ['Alpha', 'Beta']);
  const matches = matchCandidates([g], { letters: [], numbers: [9], quotedSnippets: [], rawText: '' });
  assert.equal(matches.length, 0);
});

test('matchCandidates: radio group caps at one selection even if multiple candidates match', () => {
  const d = dom('');
  const g = radioGroup(d, ['Alpha', 'Beta']);
  const matches = matchCandidates([g], { letters: ['A', 'B'], numbers: [], quotedSnippets: [], rawText: '' });
  // radio is single-select; only first surviving match is kept
  assert.equal(matches.length, 1);
  assert.equal(matches[0].option.index, 0);
});

test('matchCandidates: checkbox group keeps all matched candidates', () => {
  const d = dom(
    '<label><input type="checkbox" name="m"> One</label>' +
    '<label><input type="checkbox" name="m"> Two</label>' +
    '<label><input type="checkbox" name="m"> Three</label>'
  );
  const g = findOptionGroups(d.body)[0];
  const matches = matchCandidates([g], { letters: ['A', 'C'], numbers: [], quotedSnippets: [], rawText: '' });
  assert.equal(matches.length, 2);
  assert.equal(matches[0].option.index, 0);
  assert.equal(matches[1].option.index, 2);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- --test-name-pattern matchCandidates`
Expected: 9 failing (function not exported).

- [ ] **Step 3: Implement `matchCandidates`**

Add to `lib/answer-matcher.js`, just above the `api` declaration:

```js
  function normalize(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function tokenize(s) {
    const STOP = new Set(['the','a','an','of','to','in','and','or','for','is','are','on','with','by']);
    return normalize(s).split(' ').filter(function (t) { return t.length > 1 && !STOP.has(t); });
  }

  function jaccard(aTokens, bTokens) {
    if (aTokens.length === 0 || bTokens.length === 0) return 0;
    const a = new Set(aTokens), b = new Set(bTokens);
    let inter = 0;
    a.forEach(function (t) { if (b.has(t)) inter += 1; });
    const uni = a.size + b.size - inter;
    return uni === 0 ? 0 : inter / uni;
  }

  function matchCandidates(groups, parsed) {
    const out = [];
    if (!Array.isArray(groups) || !parsed) return out;
    groups.forEach(function (g) {
      const groupMatches = [];
      // letters: A=0, B=1, ...
      (parsed.letters || []).forEach(function (ch) {
        const idx = ch.charCodeAt(0) - 65;
        if (idx >= 0 && idx < g.options.length) {
          groupMatches.push({ group: g, option: g.options[idx], reason: 'letter', score: 1.0 });
        }
      });
      // numbers: 1-based
      (parsed.numbers || []).forEach(function (n) {
        const idx = n - 1;
        if (idx >= 0 && idx < g.options.length) {
          groupMatches.push({ group: g, option: g.options[idx], reason: 'number', score: 0.95 });
        }
      });
      // quoted snippets: direct substring, then token overlap
      (parsed.quotedSnippets || []).forEach(function (sn) {
        const snipNorm = normalize(sn);
        if (!snipNorm) return;
        const direct = g.options.find(function (o) { return normalize(o.text).indexOf(snipNorm) !== -1; });
        if (direct) {
          groupMatches.push({ group: g, option: direct, reason: 'snippet', score: 0.9 });
          return;
        }
        const snipTokens = tokenize(sn);
        let best = null; let bestScore = 0;
        g.options.forEach(function (o) {
          const sc = jaccard(snipTokens, tokenize(o.text));
          if (sc > bestScore) { bestScore = sc; best = o; }
        });
        if (best && bestScore >= 0.34) {
          groupMatches.push({ group: g, option: best, reason: 'overlap', score: bestScore });
        }
      });
      // De-dup by option element, keep highest-score reason
      const byEl = new Map();
      groupMatches.forEach(function (m) {
        const prev = byEl.get(m.option.el);
        if (!prev || m.score > prev.score) byEl.set(m.option.el, m);
      });
      let final = Array.from(byEl.values());
      // Radio groups: keep only the single highest-score match
      if (g.kind === 'radio' && final.length > 1) {
        final.sort(function (a, b) { return b.score - a.score; });
        final = [final[0]];
      }
      // Preserve discovery order within the group
      final.sort(function (a, b) { return a.option.index - b.option.index; });
      final.forEach(function (m) { out.push(m); });
    });
    return out;
  }
```

Then update the `api` object to include it:

```js
  const api = { findOptionGroups: findOptionGroups, matchCandidates: matchCandidates };
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern matchCandidates`
Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add lib/answer-matcher.js tests/answer-matcher.test.js
git commit -m "feat(answer-matcher): match parsed candidates against option groups"
```

---

## Task 5: Matcher — apply selection (clicks)

**Files:**
- Modify: `lib/answer-matcher.js`
- Modify: `tests/answer-matcher.test.js`

- [ ] **Step 1: Add failing tests for `applyMatches`**

Append to `tests/answer-matcher.test.js`:

```js
const { applyMatches } = require('../lib/answer-matcher.js');

test('applyMatches: checks the matched native radio input', () => {
  const d = dom(
    '<label><input type="radio" name="q1"> Alpha</label>' +
    '<label><input type="radio" name="q1"> Beta</label>'
  );
  const g = findOptionGroups(d.body)[0];
  const matches = matchCandidates([g], { letters: ['B'], numbers: [], quotedSnippets: [], rawText: '' });
  const summary = applyMatches(matches);
  assert.equal(summary.selected, 1);
  assert.equal(summary.skipped, 0);
  // Find the radio after Beta's label text
  const radios = d.querySelectorAll('input[type="radio"]');
  assert.equal(radios[0].checked, false);
  assert.equal(radios[1].checked, true);
});

test('applyMatches: checks multiple matched checkboxes', () => {
  const d = dom(
    '<label><input type="checkbox" name="m"> One</label>' +
    '<label><input type="checkbox" name="m"> Two</label>' +
    '<label><input type="checkbox" name="m"> Three</label>'
  );
  const g = findOptionGroups(d.body)[0];
  const matches = matchCandidates([g], { letters: ['A', 'C'], numbers: [], quotedSnippets: [], rawText: '' });
  const summary = applyMatches(matches);
  assert.equal(summary.selected, 2);
  const boxes = d.querySelectorAll('input[type="checkbox"]');
  assert.equal(boxes[0].checked, true);
  assert.equal(boxes[1].checked, false);
  assert.equal(boxes[2].checked, true);
});

test('applyMatches: dispatches change and click events on each selected input', () => {
  const d = dom('<label><input type="radio" name="q1"> Alpha</label>');
  const g = findOptionGroups(d.body)[0];
  const inp = d.querySelector('input');
  let changes = 0, clicks = 0;
  inp.addEventListener('change', function () { changes += 1; });
  inp.addEventListener('click', function () { clicks += 1; });
  const matches = matchCandidates([g], { letters: ['A'], numbers: [], quotedSnippets: [], rawText: '' });
  applyMatches(matches);
  assert.equal(changes, 1);
  assert.equal(clicks, 1);
});

test('applyMatches: skips matches whose element is detached', () => {
  const d = dom('<label><input type="radio" name="q1"> Alpha</label>');
  const g = findOptionGroups(d.body)[0];
  const matches = matchCandidates([g], { letters: ['A'], numbers: [], quotedSnippets: [], rawText: '' });
  d.querySelector('input').remove();
  const summary = applyMatches(matches);
  assert.equal(summary.selected, 0);
  assert.equal(summary.skipped, 1);
});

test('applyMatches: clicks ARIA role=radio elements (no native input)', () => {
  const d = dom(
    '<div role="radiogroup">' +
      '<div role="radio" aria-checked="false">X</div>' +
      '<div role="radio" aria-checked="false">Y</div>' +
    '</div>'
  );
  const g = findOptionGroups(d.body)[0];
  let clicks = 0;
  d.querySelectorAll('[role="radio"]').forEach(function (el) { el.addEventListener('click', function () { clicks += 1; }); });
  const matches = matchCandidates([g], { letters: ['B'], numbers: [], quotedSnippets: [], rawText: '' });
  const summary = applyMatches(matches);
  assert.equal(summary.selected, 1);
  assert.equal(clicks, 1);
});

test('applyMatches: returns { selected: 0, skipped: 0 } for empty match list', () => {
  const summary = applyMatches([]);
  assert.deepEqual(summary, { selected: 0, skipped: 0 });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `npm test -- --test-name-pattern applyMatches`
Expected: 6 failing (function not exported).

- [ ] **Step 3: Implement `applyMatches`**

Add to `lib/answer-matcher.js`, just above the `api` declaration:

```js
  function dispatch(el, type) {
    try {
      const ev = new el.ownerDocument.defaultView.Event(type, { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
    } catch (_) { /* ignore */ }
  }

  function applyMatches(matches) {
    let selected = 0, skipped = 0;
    if (!Array.isArray(matches)) return { selected: 0, skipped: 0 };
    matches.forEach(function (m) {
      const el = m && m.option && m.option.el;
      if (!el || !el.ownerDocument || !el.ownerDocument.contains(el)) { skipped += 1; return; }
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'INPUT') {
        const t = (el.getAttribute('type') || '').toLowerCase();
        if (t === 'radio' || t === 'checkbox') {
          if (!el.checked) {
            el.checked = true;
            dispatch(el, 'click');
            dispatch(el, 'change');
            dispatch(el, 'input');
          } else {
            dispatch(el, 'click');
          }
          selected += 1;
          return;
        }
      }
      // ARIA path: just click; the host page's handler updates aria-checked.
      dispatch(el, 'click');
      selected += 1;
    });
    return { selected: selected, skipped: skipped };
  }
```

Update the `api` object:

```js
  const api = {
    findOptionGroups: findOptionGroups,
    matchCandidates: matchCandidates,
    applyMatches: applyMatches
  };
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test -- --test-name-pattern applyMatches`
Expected: 6 passing.

- [ ] **Step 5: Full test sweep**

Run: `npm test`
Expected: all pre-existing tests still pass, plus the 35 new tests across parser/matcher.

- [ ] **Step 6: Commit**

```bash
git add lib/answer-matcher.js tests/answer-matcher.test.js
git commit -m "feat(answer-matcher): apply selection by clicking matched elements"
```

---

## Task 6: Register matcher modules in the manifest

**Files:**
- Modify: `manifest.json`

- [ ] **Step 1: Update `content_scripts[0].js` to load the new modules**

Edit `manifest.json` so the `js` array becomes (note the two new entries, placed before `sidebar.js` so the sidebar can read `window.ClipboardCleaner.answerParser` / `answerMatcher` on its first call):

```json
"js": [
  "lib/cleaner.js",
  "lib/html-cleaner.js",
  "lib/typing-engine.js",
  "lib/typing-injector.js",
  "lib/answer-parser.js",
  "lib/answer-matcher.js",
  "lib/sidebar.js",
  "content.js"
]
```

- [ ] **Step 2: Sanity-check the JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add manifest.json
git commit -m "build: load answer-parser and answer-matcher in content script"
```

---

## Task 7: CSS — horizontally scrollable tab strip

**Files:**
- Modify: `lib/sidebar.css`

- [ ] **Step 1: Replace the `.ccp-tabs` and `.ccp-tab` rules**

Locate the existing `.ccp-tabs { display: flex; ... }` and `.ccp-tab { flex: 1; ... }` block (currently at lines 107–130 of `lib/sidebar.css`) and replace it with:

```css
.ccp-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ccp-border);
  /* Horizontal scroll for an arbitrary number of tabs */
  flex-wrap: nowrap;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--ccp-accent-soft) transparent;
}
.ccp-tabs::-webkit-scrollbar { height: 6px; }
.ccp-tabs::-webkit-scrollbar-track { background: transparent; }
.ccp-tabs::-webkit-scrollbar-thumb { background: var(--ccp-accent-soft); border-radius: 3px; }

.ccp-tab {
  flex: 0 0 auto;
  white-space: nowrap;
  padding: 8px 12px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--ccp-text-dim);
  font-size: 12px;
  font-weight: 500;
  border-radius: 8px;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.ccp-tab:hover { color: var(--ccp-text); background: rgba(255,255,255,0.03); }
.ccp-tab[aria-selected="true"] {
  background: var(--ccp-accent-soft);
  color: var(--ccp-text);
  border-color: rgba(108, 140, 255, 0.35);
}
```

The two material differences from the existing rules: `.ccp-tabs` now scrolls horizontally (`flex-wrap: nowrap; overflow-x: auto`) with a thin styled scrollbar, and `.ccp-tab` is non-shrinking (`flex: 0 0 auto`) with `white-space: nowrap` so labels don't wrap.

- [ ] **Step 2: Append rules for the "Answering for you" panel UI**

Append at end of `lib/sidebar.css`:

```css
.ccp-answer-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 11.5px;
  color: var(--ccp-text-dim);
}
.ccp-chip {
  background: var(--ccp-accent-soft);
  border: 1px solid rgba(108, 140, 255, 0.3);
  color: var(--ccp-text);
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
}
```

- [ ] **Step 3: Commit**

```bash
git add lib/sidebar.css
git commit -m "style(sidebar): horizontally scrollable tabs and answer panel chips"
```

---

## Task 8: Sidebar HTML — add the "Answering for you" tab and panel

**Files:**
- Modify: `lib/sidebar.js`

- [ ] **Step 1: Add the new tab button to the tablist**

In `lib/sidebar.js`, locate the `.ccp-tabs` block in the `HTML` string (currently lines 22–25):

```js
      '<div class="ccp-tabs" role="tablist">' +
        '<button class="ccp-tab" role="tab" aria-selected="true" data-tab="copied">Copied Text</button>' +
        '<button class="ccp-tab" role="tab" aria-selected="false" data-tab="typer">Auto Typer</button>' +
      '</div>' +
```

Replace with:

```js
      '<div class="ccp-tabs" role="tablist">' +
        '<button class="ccp-tab" role="tab" aria-selected="true" data-tab="copied">Copied Text</button>' +
        '<button class="ccp-tab" role="tab" aria-selected="false" data-tab="typer">Auto Typer</button>' +
        '<button class="ccp-tab" role="tab" aria-selected="false" data-tab="answer">Answering for you</button>' +
      '</div>' +
```

- [ ] **Step 2: Add the new panel markup**

In the same `HTML` string, locate the closing of the `typer` panel (the line `'</section>' +` immediately followed by the modal backdrop). Insert a new panel between the typer panel and the modal backdrop:

```js
        '<section class="ccp-panel" data-panel="answer" data-active="false">' +
          '<textarea class="ccp-textarea" data-role="answer-text" placeholder="Paste an answer (e.g. \'The answer is A and C\' or quoted option text) — Apply will tick the matching options on the page."></textarea>' +
          '<div class="ccp-answer-summary" data-role="answer-summary"></div>' +
          '<div class="ccp-actions">' +
            '<button class="ccp-btn" data-action="answer-apply">Apply to page</button>' +
            '<button class="ccp-btn" data-variant="ghost" data-action="answer-clear">Clear</button>' +
          '</div>' +
          '<div class="ccp-status" data-role="answer-status"></div>' +
        '</section>' +
```

- [ ] **Step 3: Manual sanity-check the markup parses**

Run: `node -e "const s=require('./lib/sidebar.js'); console.log(typeof s.mount)"`
Expected: `function` (the module still loads with no syntax error).

- [ ] **Step 4: Commit**

```bash
git add lib/sidebar.js
git commit -m "feat(sidebar): add 'Answering for you' tab and panel markup"
```

---

## Task 9: Sidebar wiring — parse + match + apply on click

**Files:**
- Modify: `lib/sidebar.js`

- [ ] **Step 1: Register a wireAnswer call in `mount()`**

In `lib/sidebar.js`, locate the block inside `mount()` that wires sub-features:

```js
    wireHeader();
    wireTabs();
    wireResize();
    wireTyper();
```

Add a fifth call:

```js
    wireHeader();
    wireTabs();
    wireResize();
    wireTyper();
    wireAnswer();
```

- [ ] **Step 2: Implement `wireAnswer`**

Add the function just below `wireTyper`'s definition (anywhere before the `open`/`close` helpers is fine):

```js
  function getAnswerApi() {
    const r = (typeof window !== 'undefined' && window.ClipboardCleaner) || {};
    return { parser: r.answerParser, matcher: r.answerMatcher };
  }

  function setAnswerStatus(text, tone) {
    const s = shadow.querySelector('[data-role="answer-status"]');
    if (!s) return;
    s.textContent = text || '';
    if (tone) s.setAttribute('data-tone', tone); else s.removeAttribute('data-tone');
  }

  function renderAnswerSummary(parsed) {
    const box = shadow.querySelector('[data-role="answer-summary"]');
    if (!box) return;
    box.textContent = '';
    if (!parsed) return;
    const chips = [];
    (parsed.letters || []).forEach(function (l) { chips.push('Letter ' + l); });
    (parsed.numbers || []).forEach(function (n) { chips.push('#' + n); });
    (parsed.quotedSnippets || []).forEach(function (s) {
      const trimmed = s.length > 30 ? s.slice(0, 27) + '…' : s;
      chips.push('"' + trimmed + '"');
    });
    chips.forEach(function (txt) {
      const span = document.createElement('span');
      span.className = 'ccp-chip';
      span.textContent = txt;
      box.appendChild(span);
    });
  }

  function wireAnswer() {
    const apply = shadow.querySelector('[data-action="answer-apply"]');
    const clear = shadow.querySelector('[data-action="answer-clear"]');
    const ta    = shadow.querySelector('[data-role="answer-text"]');
    if (!apply || !clear || !ta) return;

    // Live preview of parsed candidates as the user pastes/edits.
    ta.addEventListener('input', function () {
      const { parser } = getAnswerApi();
      if (!parser) return;
      try { renderAnswerSummary(parser.parseAnswerText(ta.value || '')); } catch (_) { /* ignore */ }
    });

    apply.addEventListener('click', function () {
      const { parser, matcher } = getAnswerApi();
      if (!parser || !matcher) { setAnswerStatus('Answer engine unavailable.', 'error'); return; }
      const raw = ta.value || '';
      if (!raw.trim()) { setAnswerStatus('Paste an answer first.', 'error'); return; }
      const parsed = parser.parseAnswerText(raw);
      renderAnswerSummary(parsed);
      const hasAnyCandidate = parsed.letters.length + parsed.numbers.length + parsed.quotedSnippets.length;
      if (!hasAnyCandidate) {
        setAnswerStatus('No answer candidates found in the pasted text.', 'error');
        return;
      }
      const groups = matcher.findOptionGroups(document.body);
      if (groups.length === 0) { setAnswerStatus('No option groups found on this page.', 'error'); return; }
      const matches = matcher.matchCandidates(groups, parsed);
      if (matches.length === 0) { setAnswerStatus('No options matched the parsed answer.', 'error'); return; }
      const summary = matcher.applyMatches(matches);
      const tone = summary.selected > 0 ? 'success' : 'error';
      setAnswerStatus('Selected ' + summary.selected + (summary.skipped ? ' (' + summary.skipped + ' skipped)' : ''), tone);
    });

    clear.addEventListener('click', function () {
      ta.value = '';
      renderAnswerSummary(null);
      setAnswerStatus('');
    });
  }
```

- [ ] **Step 3: Run the full test sweep**

Run: `npm test`
Expected: every test (existing + new) passes. Sidebar changes are not unit-tested directly; they're covered by integration in step 4.

- [ ] **Step 4: Manual smoke test in Chrome**

  1. Run `chrome://extensions` → reload the unpacked extension from this directory.
  2. Open any Coursera quiz page or a local HTML file like:
     ```html
     <form>
       <label><input type="radio" name="q1"> Gradient descent</label>
       <label><input type="radio" name="q1"> Linear regression</label>
       <label><input type="radio" name="q1"> Backpropagation</label>
     </form>
     ```
  3. Open the Clipboard Cleaner sidebar. Confirm three tabs are visible. Resize the sidebar narrower until the tab strip overflows — it should scroll horizontally with a thin scrollbar rather than wrapping or clipping.
  4. Click the "Answering for you" tab. Paste `The answer is C`. The summary chip "Letter C" should appear under the textarea.
  5. Click **Apply to page**. The third radio button on the page becomes checked. Status reads "Selected 1".
  6. Paste `"Gradient descent"` instead and Apply — the first radio is now checked instead.
  7. Click **Clear** and confirm the textarea, chips, and status all reset.

- [ ] **Step 5: Commit**

```bash
git add lib/sidebar.js
git commit -m "feat(sidebar): wire 'Answering for you' panel to parser+matcher"
```

---

## Task 10: Documentation refresh

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the current README to find the usage section**

Open `README.md` and locate the section that lists existing sidebar tabs (Copied Text / Auto Typer). If no such section exists, add a new "### Answering for you" subsection near the existing Auto Typer description.

- [ ] **Step 2: Add a short usage entry**

Append (or insert in the appropriate section) the following text — keep wording tight, match the repo's existing tone:

```markdown
### Answering for you

Paste the answer text you want to apply (for example: "The correct answers are A and C" or a quoted option phrase like "Gradient descent"). Click **Apply to page** and the extension will:

1. Parse letter answers (A, B, C…), numeric option references (`option 2`, `#3`), and quoted option text.
2. Scan the current page for radio / checkbox groups (including ARIA `role="radio"` / `role="checkbox"`).
3. Tick the matching option(s). Radio groups receive a single selection; checkbox groups receive all matches.

Nothing is sent off-device — parsing and matching happen entirely in the content script.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe the 'Answering for you' tab"
```

---

## Self-Review Checklist (already performed)

- **Spec coverage:**
  - "New tab labeled 'Answering for you'" → Task 8.
  - "Text input interface" → Task 8 (textarea in panel markup).
  - "Parsing mechanism that analyzes pasted text to identify key data points" → Tasks 1–2 (`answer-parser`).
  - "Programmatically cross-references with existing form options to auto-select matching inputs" → Tasks 3–5 (`answer-matcher`) and Task 9 (sidebar wires apply on click).
  - "Update tab navigation container to support horizontal scrolling" → Task 7 (`.ccp-tabs` overflow-x).
- **Placeholder scan:** No `TBD`/`TODO`/`implement later`; every step shows full code or full commands.
- **Type consistency:** Parser output shape `{ letters, numbers, quotedSnippets, rawText }` is identical between Tasks 1, 2, and the matcher tests in Task 4. Matcher exports `findOptionGroups`, `matchCandidates`, `applyMatches` consistently across Tasks 3, 4, 5 and the sidebar in Task 9. Option object shape `{ el, text, index }` is identical in production and tests.
