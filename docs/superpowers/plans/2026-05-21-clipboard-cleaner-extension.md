# Clipboard Cleaner Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Manifest V3 browser extension for Chrome/Edge that intercepts the `copy` event on Coursera (and similar educational sites) and strips injected copyright/warning lines before the text reaches the user's clipboard.

**Architecture:** A content script registers a `copy` listener in the capture phase on `document`. The listener reads the current selection, passes the text through a pure `cleanCopiedText()` function that drops lines matching a configurable set of regex patterns (Coursera notices, copyright lines, "do not share" warnings, `(c) YEAR` markers), writes the cleaned result back via `event.clipboardData.setData('text/plain', ...)`, and calls `preventDefault()` so the page's own copy handler cannot reappend its boilerplate. The selection is left untouched so the user still sees what they copied. The cleaning function is factored into its own module so it can be unit-tested in Node without a browser.

**Tech Stack:** Manifest V3, vanilla JavaScript (no build step), Node.js built-in `node:test` runner for unit tests.

---

## File Structure

```
Copy and Paste Bypasser/
├── manifest.json              # MV3 manifest, registers content script on coursera.org
├── content.js                 # Copy event listener; wires DOM to cleaner
├── lib/
│   └── cleaner.js             # Pure cleanCopiedText() — dual-mode (browser + Node)
├── tests/
│   └── cleaner.test.js        # node:test unit tests for cleaner.js
├── package.json               # Test script; no runtime deps
├── icons/
│   ├── icon16.png             # Toolbar icon (16x16)
│   ├── icon48.png             # Extensions page icon (48x48)
│   └── icon128.png            # Store/install icon (128x128)
└── README.md                  # Loading instructions for Chrome/Edge dev mode
```

**Responsibility split:**
- `lib/cleaner.js` is pure string-in/string-out. No DOM, no globals. Easy to test.
- `content.js` is the thin DOM adapter: read selection, call cleaner, write back, preventDefault.
- `manifest.json` lists both files as content scripts so the cleaner is available in the page world.

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `lib/cleaner.js` (empty placeholder so directory exists)
- Create: `tests/cleaner.test.js` (empty placeholder)
- Create: `icons/.gitkeep`

- [ ] **Step 1: Create `package.json`**

Write the file with the exact content below. No dependencies — we use Node's built-in test runner.

```json
{
  "name": "clipboard-cleaner",
  "version": "1.0.0",
  "description": "Browser extension that strips injected copyright/warning text from clipboard on copy.",
  "private": true,
  "scripts": {
    "test": "node --test tests/"
  }
}
```

- [ ] **Step 2: Create empty placeholder files so the directory structure exists**

Create `lib/cleaner.js` containing only:

```js
// Implemented in Task 2.
```

Create `tests/cleaner.test.js` containing only:

```js
// Implemented in Task 2.
```

Create `icons/.gitkeep` as an empty file. Real icons will be added in Task 5.

- [ ] **Step 3: Verify the test runner starts (and finds no tests yet)**

Run: `npm test`
Expected: Exits 0 with output like `# tests 0` / `# pass 0`. If Node is older than 20, the user must upgrade — `node --test` is required.

- [ ] **Step 4: Commit**

```bash
git init
git add package.json lib/cleaner.js tests/cleaner.test.js icons/.gitkeep
git commit -m "chore: scaffold clipboard-cleaner extension project"
```

---

## Task 2: Cleaner Module — Failing Tests First

**Files:**
- Modify: `tests/cleaner.test.js`

We will write a comprehensive test suite for `cleanCopiedText()` before any implementation. Each test documents one behavior the cleaner must have.

- [ ] **Step 1: Write the full failing test suite**

Replace the contents of `tests/cleaner.test.js` with:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanCopiedText } = require('../lib/cleaner.js');

test('returns empty string when input is null', () => {
  assert.equal(cleanCopiedText(null), '');
});

test('returns empty string when input is undefined', () => {
  assert.equal(cleanCopiedText(undefined), '');
});

test('returns empty string when input is empty', () => {
  assert.equal(cleanCopiedText(''), '');
});

test('passes through clean text unchanged (aside from trim)', () => {
  const input = 'The quick brown fox jumps over the lazy dog.';
  assert.equal(cleanCopiedText(input), input);
});

test('removes a line containing the word "coursera" (case-insensitive)', () => {
  const input = [
    'A vector is an ordered list of numbers.',
    'This content is from Coursera and is for personal study only.',
    'Vectors can be added componentwise.',
  ].join('\n');
  const expected = [
    'A vector is an ordered list of numbers.',
    'Vectors can be added componentwise.',
  ].join('\n');
  assert.equal(cleanCopiedText(input), expected);
});

test('removes a line containing "copyright"', () => {
  const input = 'Useful sentence.\nCopyright 2025 Some University. All rights reserved.';
  assert.equal(cleanCopiedText(input), 'Useful sentence.');
});

test('removes a line containing "assessment"', () => {
  const input = 'Real content.\nThis assessment is for your personal use only.';
  assert.equal(cleanCopiedText(input), 'Real content.');
});

test('removes a line containing the phrase "don\'t share" with curly or straight apostrophe', () => {
  const straight = 'Keep this.\nPlease don\'t share this content with others.';
  const curly = 'Keep this.\nPlease don’t share this content with others.';
  assert.equal(cleanCopiedText(straight), 'Keep this.');
  assert.equal(cleanCopiedText(curly), 'Keep this.');
});

test('removes a line containing the pattern "(c) 2025"', () => {
  const input = 'Body text.\n(c) 2025 Example Org';
  assert.equal(cleanCopiedText(input), 'Body text.');
});

test('removes a line containing the symbol "© 2024"', () => {
  const input = 'Body text.\n© 2024 Example Org';
  assert.equal(cleanCopiedText(input), 'Body text.');
});

test('removes multiple injected lines in a single copy', () => {
  const input = [
    'Keep me one.',
    'This material is from Coursera.',
    'Keep me two.',
    'Copyright 2025 Some Org.',
    '(c) 2025 Another Org',
    'Keep me three.',
  ].join('\n');
  const expected = [
    'Keep me one.',
    'Keep me two.',
    'Keep me three.',
  ].join('\n');
  assert.equal(cleanCopiedText(input), expected);
});

test('trims trailing whitespace and newlines from the final result', () => {
  const input = 'Some content.\n\n   \nCopyright 2025 Foo\n   \n';
  assert.equal(cleanCopiedText(input), 'Some content.');
});

test('preserves blank lines that are between kept content (does not collapse paragraphs)', () => {
  const input = [
    'Paragraph one.',
    '',
    'Paragraph two.',
  ].join('\n');
  assert.equal(cleanCopiedText(input), input);
});

test('does not remove a line just because a keyword appears inside an unrelated word', () => {
  // "right" should not trigger the "copyright" rule.
  const input = 'You have the right to remain silent.';
  assert.equal(cleanCopiedText(input), input);
});

test('handles Windows-style CRLF line endings', () => {
  const input = 'Keep this.\r\nCopyright 2025 Org\r\nKeep this too.';
  assert.equal(cleanCopiedText(input), 'Keep this.\nKeep this too.');
});

test('returns empty string when every line is junk', () => {
  const input = 'Copyright 2025 Org\n(c) 2025 Org\nThis material is from Coursera.';
  assert.equal(cleanCopiedText(input), '');
});
```

- [ ] **Step 2: Run the tests to confirm they all fail**

Run: `npm test`
Expected: All tests fail (cleaner.js does not export `cleanCopiedText` yet). Output ends with a non-zero exit code and `# fail` > 0.

- [ ] **Step 3: Commit the failing tests**

```bash
git add tests/cleaner.test.js
git commit -m "test: add failing spec for cleanCopiedText"
```

---

## Task 3: Cleaner Module — Implementation

**Files:**
- Modify: `lib/cleaner.js`

- [ ] **Step 1: Implement `cleanCopiedText` to make the tests pass**

Replace the contents of `lib/cleaner.js` with:

```js
// Dual-mode module: usable from a browser content script (attaches to window)
// and from Node tests (exports via module.exports).

(function (root) {
  // Patterns that mark a line as injected boilerplate. Each is tested against
  // a single line. If any matches, the whole line is dropped.
  //
  // Word boundaries (\b) are used so "right" does not trigger the
  // "copyright" rule and "passessment" (hypothetical) does not trigger
  // "assessment".
  const JUNK_LINE_PATTERNS = [
    /\bcoursera\b/i,
    /\bcopyright\b/i,
    /\bassessment\b/i,
    /\bdon[’']t\s+share\b/i,
    /\(c\)\s*\d{4}/i,   // "(c) 2025"
    /©\s*\d{4}/,    // "© 2025"
  ];

  function isJunkLine(line) {
    return JUNK_LINE_PATTERNS.some(function (re) { return re.test(line); });
  }

  function cleanCopiedText(input) {
    if (input == null) return '';
    if (typeof input !== 'string') return '';

    // Normalize CRLF to LF so line splitting is uniform.
    const normalized = input.replace(/\r\n?/g, '\n');

    const kept = normalized
      .split('\n')
      .filter(function (line) { return !isJunkLine(line); });

    // Trim trailing blank lines and trailing whitespace on the final string,
    // but keep interior blank lines that separate paragraphs.
    return kept.join('\n').replace(/\s+$/, '');
  }

  const api = { cleanCopiedText: cleanCopiedText };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 2: Run the tests to confirm they all pass**

Run: `npm test`
Expected: All tests pass. Output ends with `# pass <N>` and exit code 0. If any test fails, fix the implementation — do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add lib/cleaner.js
git commit -m "feat: implement cleanCopiedText line filter"
```

---

## Task 4: Content Script — Wire Cleaner to the Copy Event

**Files:**
- Create: `content.js`

The content script runs in the page's isolated world. It registers a `copy` listener that runs in the capture phase (so it sees the event before any page-installed bubble-phase handler), reads the current selection, runs it through `ClipboardCleaner.cleanCopiedText`, writes the cleaned text back, and calls `preventDefault()` so the browser does not overwrite our `setData` with the original selection (and so any page handler that listens later cannot re-append boilerplate).

- [ ] **Step 1: Write `content.js`**

Create `content.js` with this content:

```js
// Runs after lib/cleaner.js, which exposes window.ClipboardCleaner.
(function () {
  'use strict';

  function getSelectedText() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return '';
    const text = sel.toString();
    return typeof text === 'string' ? text : '';
  }

  function onCopy(event) {
    const cleaner = window.ClipboardCleaner;
    if (!cleaner || typeof cleaner.cleanCopiedText !== 'function') {
      // Cleaner module did not load — fall back to default browser behavior.
      return;
    }

    const selected = getSelectedText();
    if (!selected) {
      // Nothing selected (e.g. programmatic copy by the page). Don't interfere.
      return;
    }

    const cleaned = cleaner.cleanCopiedText(selected);

    if (!event.clipboardData) {
      // Very old browser, or copy was synthesized without clipboardData.
      return;
    }

    // Replace the clipboard payload with our cleaned text and stop the
    // browser (and any later page handler) from overwriting it.
    event.clipboardData.setData('text/plain', cleaned);
    event.preventDefault();
    // Note: we deliberately do NOT touch window.getSelection(), so the
    // highlighted range stays visible — the user still sees what they copied.
  }

  // Capture phase = true: we run before page-registered bubble handlers,
  // and our preventDefault() blocks the default action they rely on.
  document.addEventListener('copy', onCopy, true);
})();
```

- [ ] **Step 2: Commit**

```bash
git add content.js
git commit -m "feat: add content script that cleans clipboard on copy"
```

---

## Task 5: Manifest and Icons

**Files:**
- Create: `manifest.json`
- Create: `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`

- [ ] **Step 1: Create `manifest.json`**

The manifest registers `lib/cleaner.js` before `content.js` (load order matters — content.js relies on `window.ClipboardCleaner`). It targets Coursera by default; the README explains how to widen the match list.

Write `manifest.json` with this exact content:

```json
{
  "manifest_version": 3,
  "name": "Clipboard Cleaner",
  "version": "1.0.0",
  "description": "Strips injected copyright/warning lines from copied text on Coursera and similar sites.",
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  "content_scripts": [
    {
      "matches": [
        "https://*.coursera.org/*",
        "https://coursera.org/*"
      ],
      "js": ["lib/cleaner.js", "content.js"],
      "run_at": "document_start",
      "all_frames": true
    }
  ]
}
```

Notes baked into this file:
- `run_at: "document_start"` registers our listener before the page's own scripts can install theirs.
- `all_frames: true` covers iframed lesson content.
- No `permissions` entry is needed — content scripts that only read the selection and call `event.clipboardData.setData` inside a user-triggered `copy` handler do **not** require the `clipboardWrite` permission. Adding it would trigger an extra install warning for no benefit.

- [ ] **Step 2: Add icon files**

The extension will load without icons (Chrome substitutes a default), but the manifest references them. Provide any three PNGs at 16x16, 48x48, and 128x128. A quick option is to generate solid-color placeholders:

```powershell
# Option A: copy any existing 16/48/128 PNG into icons/ with the right names.
# Option B: if you have ImageMagick, generate placeholders:
magick -size 16x16   xc:"#2D7DD2" icons/icon16.png
magick -size 48x48   xc:"#2D7DD2" icons/icon48.png
magick -size 128x128 xc:"#2D7DD2" icons/icon128.png
```

If you skip this step, also delete the `"icons"` block from `manifest.json` so Chrome does not warn about missing files.

- [ ] **Step 3: Commit**

```bash
git add manifest.json icons/
git commit -m "feat: add MV3 manifest and placeholder icons"
```

---

## Task 6: README with Loading Instructions

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

Create `README.md` with this exact content:

````markdown
# Clipboard Cleaner

A Manifest V3 browser extension for Chrome and Edge that intercepts the `copy` event on educational sites (Coursera by default) and removes injected copyright / "do not share" boilerplate before the text reaches your clipboard.

## What it does

When you copy text, the extension:
1. Reads your current selection.
2. Drops any line containing `coursera`, `copyright`, `assessment`, `don't share`, `(c) YEAR`, or `© YEAR`.
3. Trims trailing whitespace.
4. Writes the cleaned text to the clipboard.

Your selection stays visually highlighted so you can still see what you copied.

## Load in Chrome

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select the folder that contains `manifest.json` (the project root).
5. Visit a Coursera reading or assessment, select text, and copy. Paste into a plain text editor to verify the boilerplate is gone.

## Load in Edge

1. Open `edge://extensions`.
2. Toggle **Developer mode** on (bottom-left).
3. Click **Load unpacked**.
4. Select the folder that contains `manifest.json`.
5. Test as above.

## Targeting other sites

By default the extension only runs on `*.coursera.org`. To widen it, edit the `matches` array in `manifest.json`. To run on every site, replace the array with:

```json
"matches": ["<all_urls>"]
```

Reload the extension from the extensions page after any manifest change.

## Tuning the filter

The list of patterns that mark a line as junk lives in `lib/cleaner.js` as `JUNK_LINE_PATTERNS`. Add or remove regexes there. Each pattern is tested against a single line; if any matches, the whole line is dropped.

## Running the tests

Requires Node.js 20 or newer (for the built-in test runner).

```bash
npm test
```
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add load and configuration instructions"
```

---

## Task 7: Manual Verification

This task has no code — it's the end-to-end smoke test that proves the extension actually does what it claims in a real browser.

- [ ] **Step 1: Load the unpacked extension in Chrome**

Follow the steps in `README.md`. Confirm the extension appears in `chrome://extensions` with no errors. If Chrome reports a manifest error, fix it and reload.

- [ ] **Step 2: Verify on a clean test page**

Open `data:text/html,<p>Hello world.</p><p>Copyright 2025 Example.</p>` in a new tab. Select both paragraphs, copy, and paste into Notepad.
Expected: Only `Hello world.` is pasted.

- [ ] **Step 3: Verify on Coursera**

Open a Coursera reading or quiz, select a paragraph (including any visible boilerplate), copy, and paste into Notepad.
Expected: The boilerplate lines (Coursera notice, copyright, "do not share") are absent. The actual content is preserved.

- [ ] **Step 4: Verify the selection is still visible after copying**

Repeat step 3 but don't click anywhere after pressing Ctrl+C. The selection highlight on the page should still be present.

- [ ] **Step 5: Verify graceful behavior when nothing is selected**

With no selection, press Ctrl+C on a Coursera page. The browser should not error and other extensions/handlers should behave normally. (Our handler short-circuits when the selection is empty.)

- [ ] **Step 6: Repeat steps 1-4 in Microsoft Edge** to confirm cross-browser parity.

- [ ] **Step 7: Commit a note recording the verification (optional)**

```bash
git commit --allow-empty -m "chore: manual verification passed on Chrome and Edge"
```

---

## Self-Review Notes

- **Spec coverage:** manifest.json (Task 5), content.js copy listener with `preventDefault` + `setData('text/plain', ...)` (Task 4), regex-based line stripping for coursera/copyright/assessment/don't share/`(c) YEAR` (Task 3), null-selection handling (Task 4 `getSelectedText` + Task 2 null tests), trailing-whitespace trim (Task 3 + tests), selection preserved visually (Task 4 — we never mutate the selection), load instructions for Chrome and Edge (Task 6). All covered.
- **Placeholder scan:** Every code step contains the actual code to write. No TBDs.
- **Type/name consistency:** The module exposes `cleanCopiedText` (Task 3) and is consumed as `window.ClipboardCleaner.cleanCopiedText` (Task 4) and `require('../lib/cleaner.js').cleanCopiedText` (Task 2). Filenames `lib/cleaner.js` and `content.js` match across manifest, tests, and content script.
