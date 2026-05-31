# AI Sidebar + Options Page UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Let AI answer for you" sidebar and the DeepSeek options page comfortable and visually clear without weakening any S1–S10 security invariant.

**Architecture:** Adjust `lib/sidebar.css` to widen the sidebar and replace the horizontally-scrolling tab strip with a wrapping grid. Restructure only the AI panel inside `lib/sidebar.js`'s static `HTML` template into named card containers (`ai-card-key`, `ai-card-scan`, `ai-actions-primary`, `ai-actions-secondary`, `ai-actions-inflight`, `ai-previews`) with `Cancel` toggled via the `hidden` attribute by `setAiInFlight`. Rebuild `options.html` as a centered card with the same data-role/data-action contract so `lib/ai-options-controller.js` stays untouched. Every test is a DOM-contract / state-attribute assertion in jsdom; nothing depends on real layout pixels.

**Tech Stack:** Plain CSS, ES5-ish JS in the existing UMD pattern, Node `node:test` + jsdom (no new build tooling).

**File structure decisions:**
- `lib/sidebar.css` — width + tab layout primitives + new `.ccp-ai-*` card/action classes. ONE file, all visual rules.
- `lib/sidebar.js` — only the static `HTML` template for the AI panel + the AI tab label string + `setAiInFlight` body get edited. No `wireAiAnswer` selector breakage: existing `data-action` values (`ai-key-configure`, `ai-scan`, `ai-generate`, `ai-cancel`, `ai-apply`, `ai-clear-suggestions`) are preserved.
- `options.html` — full visual rewrite; controller-visible selectors (`[data-role="ai-options-key"]`, `[data-role="ai-options-remember"]`, `[data-role="ai-options-status"]`, `[data-action="ai-options-toggle"]`, `[data-action="ai-options-save"]`, `[data-action="ai-options-clear"]`) are kept identical so `lib/ai-options-controller.js` requires no changes.
- Tests in `tests/sidebar.test.js`, `tests/ai-options-controller.test.js`, `tests/ai-answer-tab.test.js` assert DOM contracts only; no pixel-value checks.

**Out of scope:**
- `lib/ai-question-context.js`, `lib/ai-answer-controller.js`, `lib/ai-background-service.js`, `background.js`, `manifest.json`, `content.js`.
- All `lib/autopilot-*.js`, `lib/module-*.js`, `lib/completion-confirmer.js`, `lib/item-handlers.js`, and their tests.
- Real API keys, live Coursera testing, any git mutation.

---

## Task 1: Sidebar width + tab layout (CSS)

**Files:**
- Modify: `lib/sidebar.css` lines 20-46 (`.ccp-host` block) and lines 107-141 (`.ccp-tabs`, `.ccp-tab`).
- Test: `tests/sidebar.test.js` — append new tests.

- [ ] **Step 1: Write the failing test (RED) for tab wrapping**

Append to `tests/sidebar.test.js`:

```javascript
test('UI: tab strip permits wrapping (does NOT force nowrap)', () => {
  const { sidebar, shadow } = freshSidebar();
  const tabs = shadow.querySelector('.ccp-tabs');
  assert.ok(tabs);
  // jsdom honors inline + linked stylesheet rules via getComputedStyle.
  // We assert: flex-wrap is NOT 'nowrap'. Either 'wrap' or 'wrap-reverse' is fine.
  const fw = tabs.ownerDocument.defaultView.getComputedStyle(tabs).flexWrap;
  assert.notEqual(fw, 'nowrap', 'tabs must wrap, not force horizontal scroll');
});

test('UI: all six tabs present and active AI tab toggles cleanly', () => {
  const { sidebar, shadow } = freshSidebar();
  ['copied', 'typer', 'answer', 'autopilot', 'diagnostics', 'ai-answer'].forEach(function (t) {
    assert.ok(shadow.querySelector('[data-tab="' + t + '"]'), 'tab ' + t + ' must exist');
  });
  sidebar.setActiveTab('ai-answer');
  assert.equal(shadow.querySelector('[data-tab="ai-answer"]').getAttribute('aria-selected'), 'true');
  assert.equal(shadow.querySelector('[data-panel="ai-answer"]').getAttribute('data-active'), 'true');
});
```

- [ ] **Step 2: Run tests to verify the wrap test fails**

Run: `node --test tests/sidebar.test.js`
Expected: the new wrap test FAILS with `'nowrap' !== 'nowrap'` (current CSS has `flex-wrap: nowrap`). The six-tabs test should already PASS.

- [ ] **Step 3: Update `.ccp-host` width in `lib/sidebar.css`**

Replace the existing `.ccp-host` declaration (lines 20-46) — change ONLY the `width:` line. Keep everything else identical.

Before:
```css
.ccp-host {
  all: initial;
  position: fixed;
  top: 80px;
  right: 16px;
  width: 360px;
  min-width: 280px;
  max-width: 640px;
  ...
}
```

After:
```css
.ccp-host {
  all: initial;
  position: fixed;
  top: 80px;
  right: 16px;
  width: min(440px, calc(100vw - 24px));
  min-width: 280px;
  max-width: 640px;
  ...
}
```

- [ ] **Step 4: Update `.ccp-tabs` and `.ccp-tab` for wrapping**

Replace the block at lines 107-141. Replace `flex-wrap: nowrap; overflow-x: auto; overflow-y: hidden;` with `flex-wrap: wrap;` and remove the horizontal-scroll bar styling. Allow tabs to flex-grow within their row.

```css
.ccp-tabs {
  display: flex;
  gap: 4px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--ccp-border);
  flex-wrap: wrap;
}

.ccp-tab {
  flex: 1 1 auto;
  min-width: 0;
  white-space: nowrap;
  padding: 8px 10px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--ccp-text-dim);
  font-size: 12px;
  font-weight: 500;
  border-radius: 8px;
  cursor: pointer;
  text-align: center;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.ccp-tab:hover { color: var(--ccp-text); background: rgba(255,255,255,0.03); }
.ccp-tab[aria-selected="true"] {
  background: var(--ccp-accent-soft);
  color: var(--ccp-text);
  border-color: rgba(108, 140, 255, 0.35);
}
```

Delete the old `::-webkit-scrollbar` rules for `.ccp-tabs` (lines 119-121) — they are no longer needed.

- [ ] **Step 5: Run tests to verify GREEN**

Run: `node --test tests/sidebar.test.js`
Expected: both new tests PASS, all pre-existing sidebar tests still PASS.

- [ ] **Step 6: Do NOT commit.**

---

## Task 2: Shorten the AI tab label

**Files:**
- Modify: `lib/sidebar.js` line 28 (the tab button label).
- Test: `tests/sidebar.test.js` — append.

- [ ] **Step 1: Write the failing test (RED)**

```javascript
test('UI: AI tab uses the short label "AI Answers"', () => {
  const { sidebar, shadow } = freshSidebar();
  const tab = shadow.querySelector('[data-tab="ai-answer"]');
  assert.ok(tab);
  assert.equal(tab.textContent.trim(), 'AI Answers');
});
```

- [ ] **Step 2: Run to verify RED**

Run: `node --test tests/sidebar.test.js`
Expected: FAIL with `'Let AI answer for you' !== 'AI Answers'`.

- [ ] **Step 3: Shorten the label**

In `lib/sidebar.js`, change line 28 from:
```javascript
'<button class="ccp-tab" role="tab" aria-selected="false" data-tab="ai-answer">Let AI answer for you</button>' +
```
to:
```javascript
'<button class="ccp-tab" role="tab" aria-selected="false" data-tab="ai-answer">AI Answers</button>' +
```

The `data-tab="ai-answer"` identifier is preserved.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `node --test tests/sidebar.test.js`
Expected: new test PASSES. The existing test `'sidebar exposes "Let AI answer for you" tab without removing existing tabs'` (if it asserts on textContent) will FAIL — fix it by updating the assertion to `'AI Answers'`. Confirm by reading the existing test before adjusting.

- [ ] **Step 5: Update any existing test that depends on the old label**

In `tests/sidebar.test.js`, find any `assert.equal(tab.textContent.trim(), 'Let AI answer for you')` and change it to `'AI Answers'`. Search via `grep -n 'Let AI answer for you' tests/sidebar.test.js`. Update each occurrence.

- [ ] **Step 6: Verify all sidebar tests pass**

Run: `node --test tests/sidebar.test.js`
Expected: all tests PASS.

- [ ] **Step 7: Do NOT commit.**

---

## Task 3: Restructure AI panel HTML into named cards

**Files:**
- Modify: `lib/sidebar.js` lines 120-148 (the entire `<section class="ccp-panel" data-panel="ai-answer">...</section>` block).
- Test: `tests/sidebar.test.js` — append structural tests.

The new structure adds five named card containers and splits the action row into primary/secondary plus an in-flight slot for Cancel. `data-action` IDs are preserved.

- [ ] **Step 1: Write the failing structural tests (RED)**

```javascript
test('UI: AI panel has five named card containers in the expected order', () => {
  const { sidebar, shadow } = freshSidebar();
  const panel = shadow.querySelector('[data-panel="ai-answer"]');
  assert.ok(panel);
  const expected = ['ai-card-key', 'ai-card-scan', 'ai-actions-primary', 'ai-actions-secondary', 'ai-previews'];
  const got = [];
  panel.querySelectorAll('[data-card]').forEach(function (el) { got.push(el.getAttribute('data-card')); });
  // All five cards must be present (order does not have to match exactly, but each must exist)
  expected.forEach(function (n) {
    assert.ok(got.indexOf(n) !== -1, 'missing card: ' + n);
  });
});

test('UI: primary action row contains Scan + Generate; secondary contains Apply + Clear suggestions', () => {
  const { sidebar, shadow } = freshSidebar();
  const primary = shadow.querySelector('[data-card="ai-actions-primary"]');
  const secondary = shadow.querySelector('[data-card="ai-actions-secondary"]');
  assert.ok(primary && secondary);
  assert.ok(primary.querySelector('[data-action="ai-scan"]'));
  assert.ok(primary.querySelector('[data-action="ai-generate"]'));
  assert.ok(secondary.querySelector('[data-action="ai-apply"]'));
  assert.ok(secondary.querySelector('[data-action="ai-clear-suggestions"]'));
});

test('UI: Cancel button has data-variant="danger" and starts hidden', () => {
  const { sidebar, shadow } = freshSidebar();
  const cancel = shadow.querySelector('[data-action="ai-cancel"]');
  assert.ok(cancel);
  assert.equal(cancel.getAttribute('data-variant'), 'danger');
  assert.equal(cancel.hidden, true, 'Cancel must be hidden by default');
});

test('UI: AI key card contains a security note explicitly mentioning extension settings', () => {
  const { sidebar, shadow } = freshSidebar();
  const keyCard = shadow.querySelector('[data-card="ai-card-key"]');
  assert.ok(keyCard);
  const note = keyCard.querySelector('[data-role="ai-key-note"]');
  assert.ok(note, 'security note element required');
  assert.ok(/extension settings/i.test(note.textContent), 'note mentions extension settings');
});

test('UI: AI panel contains no password input, no key-input role, no ai-key-clear button (boundary invariant)', () => {
  const { sidebar, shadow } = freshSidebar();
  const panel = shadow.querySelector('[data-panel="ai-answer"]');
  assert.equal(panel.querySelector('input[type="password"]'), null);
  assert.equal(panel.querySelector('[data-role="ai-key-input"]'), null);
  assert.equal(panel.querySelector('[data-action="ai-key-clear"]'), null);
  assert.equal(panel.querySelector('[data-action="ai-key-save"]'), null);
});

test('UI: ai-key-configure button exists exactly once and is inside ai-card-key', () => {
  const { sidebar, shadow } = freshSidebar();
  const all = shadow.querySelectorAll('[data-action="ai-key-configure"]');
  assert.equal(all.length, 1);
  const keyCard = shadow.querySelector('[data-card="ai-card-key"]');
  assert.ok(keyCard.contains(all[0]));
});

test('UI: previews card has scan, suggestion, and apply-result roles', () => {
  const { sidebar, shadow } = freshSidebar();
  const previews = shadow.querySelector('[data-card="ai-previews"]');
  assert.ok(previews);
  assert.ok(previews.querySelector('[data-role="ai-scan-preview"]'));
  assert.ok(previews.querySelector('[data-role="ai-suggestion-preview"]'));
  assert.ok(previews.querySelector('[data-role="ai-apply-result"]'));
});
```

- [ ] **Step 2: Run to verify RED**

Run: `node --test tests/sidebar.test.js`
Expected: the seven new tests FAIL — `[data-card="..."]` selectors return null in the current flat structure.

- [ ] **Step 3: Replace the AI panel HTML block in `lib/sidebar.js`**

Replace the entire `<section class="ccp-panel" data-panel="ai-answer">...</section>` block (lines 120-148). Note: the strings are concatenated with `+` in JS source, so each line ends with `' +'`.

New block:

```javascript
'<section class="ccp-panel" data-panel="ai-answer" data-active="false">' +
  '<div class="ccp-ai-card" data-card="ai-card-key">' +
    '<div class="ccp-ai-card-header">DeepSeek API key</div>' +
    '<div class="ccp-ai-status-pill" data-role="ai-key-state">Not configured</div>' +
    '<div class="ccp-ai-note" data-role="ai-key-note">Your key is entered only in extension settings, never on Coursera.</div>' +
    '<div class="ccp-ai-row">' +
      '<button class="ccp-btn" data-action="ai-key-configure">Manage DeepSeek key</button>' +
    '</div>' +
  '</div>' +
  '<div class="ccp-ai-card" data-card="ai-card-scan">' +
    '<div class="ccp-ai-card-header">Page status</div>' +
    '<div class="ccp-ai-status-line" data-role="ai-status">Click Scan questions to detect supported unanswered questions on this page.</div>' +
  '</div>' +
  '<div class="ccp-ai-actions" data-card="ai-actions-primary">' +
    '<button class="ccp-btn" data-action="ai-scan">Scan questions</button>' +
    '<button class="ccp-btn" data-action="ai-generate">Generate suggestions</button>' +
  '</div>' +
  '<div class="ccp-ai-actions" data-card="ai-actions-secondary">' +
    '<button class="ccp-btn" data-action="ai-apply">Apply answers</button>' +
    '<button class="ccp-btn" data-variant="ghost" data-action="ai-clear-suggestions">Clear suggestions</button>' +
  '</div>' +
  '<div class="ccp-ai-actions" data-card="ai-actions-inflight">' +
    '<button class="ccp-btn" data-variant="danger" data-action="ai-cancel" hidden>Cancel request</button>' +
  '</div>' +
  '<div class="ccp-ai-previews" data-card="ai-previews">' +
    '<div class="ccp-ai-preview-block" data-role="ai-scan-preview"></div>' +
    '<div class="ccp-ai-preview-block" data-role="ai-suggestion-preview"></div>' +
    '<div class="ccp-ai-preview-block" data-role="ai-apply-result"></div>' +
  '</div>' +
'</section>' +
```

Cross-check: every old `data-role` and `data-action` value (`ai-key-state`, `ai-status`, `ai-scan-preview`, `ai-suggestion-preview`, `ai-apply-result`, `ai-key-configure`, `ai-scan`, `ai-generate`, `ai-cancel`, `ai-apply`, `ai-clear-suggestions`) appears unchanged. The Cancel button now has `data-variant="danger"` and the `hidden` attribute.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `node --test tests/sidebar.test.js`
Expected: all new structural tests PASS. Pre-existing tests still PASS.

If a pre-existing test fails because it queried `[data-role="ai-key-state"]` for text content `'No DeepSeek API key configured.'`, it will still work because `setAiKeyStatus(false)` overwrites that text. The static template text is just an initial placeholder.

The pre-existing tests `'handler registry fires correct callbacks exactly once'` and the "no password input in AI panel" test still pass because all the relevant selectors are preserved.

- [ ] **Step 5: Do NOT commit.**

---

## Task 4: `setAiInFlight` toggles Cancel via `hidden`

**Files:**
- Modify: `lib/sidebar.js` — `setAiInFlight` function and `_renderAiButtonStates` if it touches Cancel.
- Test: `tests/sidebar.test.js`.

The pre-existing test `'in-flight state enables Cancel and disables Generate'` checks `cancel.disabled`. With the new contract, Cancel is HIDDEN entirely when not in-flight (the test will need updating). `_renderAiButtonStates` currently sets `cancel.disabled = !_aiState.inFlight`. Replace that with `cancel.hidden = !_aiState.inFlight` (and additionally set `disabled` to match so a stale `disabled` attribute can't be exploited).

- [ ] **Step 1: Update the failing pre-existing test (RED)**

Find the existing test `'in-flight state enables Cancel and disables Generate'` in `tests/sidebar.test.js`. Replace its body with:

```javascript
test('in-flight state shows Cancel; non-in-flight hides Cancel; Generate disabled while in-flight', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiKeyStatus(true);
  sidebar.setAiPageEligibility({ eligible: true, blockedReason: null, supportedCount: 1, actionableCount: 1 });
  sidebar.setAiScanResult({ token: 't', questions: [{}], supportedCount: 1, actionableCount: 1 });
  const cancel = shadow.querySelector('[data-action="ai-cancel"]');
  const gen = shadow.querySelector('[data-action="ai-generate"]');
  // Initial: cancel hidden, generate enabled
  assert.equal(cancel.hidden, true);
  assert.equal(gen.disabled, false);
  // In-flight: cancel visible+enabled, generate disabled
  sidebar.setAiInFlight(true);
  assert.equal(cancel.hidden, false);
  assert.equal(cancel.disabled, false);
  assert.equal(gen.disabled, true);
  // Returning to idle hides cancel again
  sidebar.setAiInFlight(false);
  assert.equal(cancel.hidden, true);
});
```

Append a separate RED test asserting Cancel starts hidden (covered in Task 3 but worth pinning here too — skip if it duplicates exactly).

- [ ] **Step 2: Run to verify RED**

Run: `node --test tests/sidebar.test.js`
Expected: the updated test fails with `cancel.hidden === true (current) !== false (expected after setAiInFlight(true))` because the current code only toggles `.disabled`.

- [ ] **Step 3: Update `_renderAiButtonStates` in `lib/sidebar.js`**

Find `_renderAiButtonStates` (search for the function name). Locate the cancel line. Replace:

```javascript
if (cancel) cancel.disabled = !_aiState.inFlight;
```

with:

```javascript
if (cancel) {
  cancel.hidden = !_aiState.inFlight;
  cancel.disabled = !_aiState.inFlight;
}
```

Both attributes are set: `hidden` is the visibility contract, and `disabled` is defense-in-depth against any future stale-state scenario.

- [ ] **Step 4: Run tests to verify GREEN**

Run: `node --test tests/sidebar.test.js`
Expected: all tests PASS (including the updated in-flight test).

- [ ] **Step 5: Do NOT commit.**

---

## Task 5: AI card CSS rules

**Files:**
- Modify: `lib/sidebar.css` — append new rules at the end of the file.

- [ ] **Step 1: Write the failing tests (RED) for class presence + the inflight slot visibility behavior**

Append to `tests/sidebar.test.js`:

```javascript
test('UI: AI cards have the ccp-ai-card class so the stylesheet can target them', () => {
  const { sidebar, shadow } = freshSidebar();
  const cards = shadow.querySelectorAll('.ccp-ai-card');
  // We expect at least the key card + the scan card to carry .ccp-ai-card.
  assert.ok(cards.length >= 2, 'at least key + scan cards exist with .ccp-ai-card');
});

test('UI: AI action rows have the ccp-ai-actions class', () => {
  const { sidebar, shadow } = freshSidebar();
  const rows = shadow.querySelectorAll('.ccp-ai-actions');
  assert.ok(rows.length >= 2, 'primary + secondary action rows exist');
});
```

- [ ] **Step 2: Run to verify (these should already pass — Task 3 set the classes)**

Run: `node --test tests/sidebar.test.js`
Expected: PASS. These tests are class-presence assertions, not visual checks.

- [ ] **Step 3: Append AI card styling rules to `lib/sidebar.css`**

Append at the end of the file:

```css
/* === Let AI answer for you — card layout === */

.ccp-ai-card {
  background: var(--ccp-surface);
  border: 1px solid var(--ccp-border);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ccp-ai-card-header {
  font-size: 12px;
  font-weight: 600;
  color: var(--ccp-text);
  letter-spacing: 0.2px;
}

.ccp-ai-status-pill {
  display: inline-block;
  align-self: flex-start;
  background: var(--ccp-accent-soft);
  border: 1px solid rgba(108, 140, 255, 0.3);
  color: var(--ccp-text);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11.5px;
  font-weight: 500;
}

.ccp-ai-note {
  font-size: 11px;
  color: var(--ccp-text-dim);
  line-height: 1.45;
}

.ccp-ai-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.ccp-ai-status-line {
  font-size: 12px;
  color: var(--ccp-text);
  line-height: 1.45;
  word-break: break-word;
}
.ccp-ai-status-line[data-tone="warn"] {
  color: var(--ccp-danger);
}

.ccp-ai-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}
.ccp-ai-actions > .ccp-btn {
  flex: 1 1 auto;
  min-width: 0;
  justify-content: center;
}

.ccp-ai-previews {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ccp-ai-preview-block {
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
}
.ccp-ai-preview-block:empty {
  display: none;
}
.ccp-ai-preview-block ul {
  margin: 4px 0;
  padding-left: 18px;
}
.ccp-ai-preview-block li {
  margin: 2px 0;
}
.ccp-ai-preview-block > div:first-child {
  color: var(--ccp-text-dim);
  font-size: 11.5px;
  margin-bottom: 2px;
}

/* Hide the inflight action row entirely when its only child (Cancel) is hidden,
   so the row's gap does not produce a visual gap when Cancel is not shown. */
[data-card="ai-actions-inflight"]:has(> [hidden]:only-child) {
  display: none;
}
```

The `:has()` selector is supported in modern Chrome (the extension's target). The visual effect: when the in-flight row contains only the hidden Cancel button, the whole row collapses. When Cancel becomes visible, the row appears.

- [ ] **Step 4: Run tests to verify everything still passes**

Run: `node --test tests/sidebar.test.js`
Expected: all tests PASS. (CSS adds presentation only; no logic change.)

- [ ] **Step 5: Do NOT commit.**

---

## Task 6: Options page visual redesign

**Files:**
- Modify: `options.html` (replace `<style>` block + `<body>` content, preserving all data-roles/data-actions).
- Test: `tests/ai-options-controller.test.js` — append.

`lib/ai-options-controller.js` is untouched. The new HTML preserves every selector the controller queries: `[data-role="ai-options-key"]`, `[data-role="ai-options-remember"]`, `[data-role="ai-options-status"]`, `[data-action="ai-options-toggle"]`, `[data-action="ai-options-save"]`, `[data-action="ai-options-clear"]`. The two `<script src="...">` references are also preserved.

- [ ] **Step 1: Write the failing tests (RED) for new content**

Append to `tests/ai-options-controller.test.js`:

```javascript
const fs = require('fs');
const path = require('path');

test('UI: options.html contains a "DeepSeek API Key Settings" heading', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/DeepSeek API Key Settings/i.test(html));
});

test('UI: options.html contains a security note about extension settings vs Coursera', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  // The note must mention BOTH "extension" and ("Coursera" or a similar host-context phrase).
  assert.ok(/extension/i.test(html));
  assert.ok(/Coursera/i.test(html));
});

test('UI: options.html preserves all data-role and data-action selectors the controller queries', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  ['ai-options-key', 'ai-options-remember', 'ai-options-status'].forEach(function (r) {
    assert.ok(html.indexOf('data-role="' + r + '"') !== -1, 'missing data-role: ' + r);
  });
  ['ai-options-toggle', 'ai-options-save', 'ai-options-clear'].forEach(function (a) {
    assert.ok(html.indexOf('data-action="' + a + '"') !== -1, 'missing data-action: ' + a);
  });
});

test('UI: options.html save button is the primary action; clear button is secondary/destructive', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  // Save button has data-variant="primary" OR class containing "primary"; Clear has data-variant="danger" or class with "danger"/"destructive".
  assert.ok(/data-action="ai-options-save"[^>]*data-variant="primary"|data-variant="primary"[^>]*data-action="ai-options-save"|class="[^"]*primary[^"]*"[^>]*data-action="ai-options-save"|data-action="ai-options-save"[^>]*class="[^"]*primary/i.test(html),
    'Save must be visually primary');
  assert.ok(/data-action="ai-options-clear"[^>]*data-variant="(danger|destructive)"|data-variant="(danger|destructive)"[^>]*data-action="ai-options-clear"|class="[^"]*(danger|destructive)[^"]*"[^>]*data-action="ai-options-clear"/i.test(html),
    'Clear must be visually destructive');
});

test('UI: options.html input type is password (masked by default)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  // The key input declares type="password"
  assert.ok(/data-role="ai-options-key"[^>]*type="password"|type="password"[^>]*data-role="ai-options-key"/i.test(html));
});
```

- [ ] **Step 2: Run to verify RED**

Run: `node --test tests/ai-options-controller.test.js`
Expected: the heading/security-note/save-primary/clear-destructive tests FAIL against the current `options.html`. The selector-preservation and input-type-password tests PASS.

- [ ] **Step 3: Replace `options.html` with the polished version**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Clipboard Cleaner — DeepSeek API Key Settings</title>
  <style>
    :root {
      --c-bg: #f6f7fb;
      --c-card: #ffffff;
      --c-border: #d8dbe6;
      --c-text: #1a1d29;
      --c-text-dim: #5b6172;
      --c-accent: #4f6bff;
      --c-accent-hover: #3b56e0;
      --c-danger: #d4302c;
      --c-danger-hover: #b8211e;
      --c-shadow: 0 4px 18px rgba(15, 18, 30, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--c-bg);
      color: var(--c-text);
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      display: flex;
      justify-content: center;
      padding: 48px 16px;
    }
    .card {
      background: var(--c-card);
      border: 1px solid var(--c-border);
      border-radius: 14px;
      box-shadow: var(--c-shadow);
      width: 100%;
      max-width: 540px;
      padding: 28px 32px 24px;
    }
    h1 {
      font-size: 20px;
      margin: 0 0 6px;
      letter-spacing: 0.1px;
    }
    .subtitle {
      color: var(--c-text-dim);
      font-size: 13px;
      margin: 0 0 18px;
      line-height: 1.5;
    }
    .security-note {
      background: #eef2ff;
      border: 1px solid #c7d2fe;
      color: #3b4396;
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 12.5px;
      line-height: 1.5;
      margin: 0 0 18px;
    }
    label.field-label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      margin: 14px 0 6px;
    }
    .input-row {
      display: flex;
      gap: 8px;
      align-items: stretch;
    }
    input[type="password"], input[type="text"] {
      flex: 1 1 auto;
      min-width: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      padding: 8px 10px;
      border: 1px solid var(--c-border);
      border-radius: 8px;
      background: #fff;
      color: var(--c-text);
    }
    input[type="password"]:focus, input[type="text"]:focus {
      outline: none;
      border-color: var(--c-accent);
      box-shadow: 0 0 0 3px rgba(79, 107, 255, 0.15);
    }
    button {
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      padding: 8px 14px;
      border-radius: 8px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
    }
    button[data-variant="primary"] {
      background: var(--c-accent);
      color: #fff;
      border-color: var(--c-accent);
    }
    button[data-variant="primary"]:hover { background: var(--c-accent-hover); border-color: var(--c-accent-hover); }
    button[data-variant="ghost"] {
      background: #fff;
      color: var(--c-text);
      border-color: var(--c-border);
    }
    button[data-variant="ghost"]:hover { background: #f1f2f7; }
    button[data-variant="danger"] {
      background: #fff;
      color: var(--c-danger);
      border-color: #f3c5c4;
    }
    button[data-variant="danger"]:hover { background: #fcebea; border-color: var(--c-danger); }
    .remember-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 14px 0 4px;
      font-size: 13px;
      color: var(--c-text);
    }
    .remember-row input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--c-accent); }
    .actions {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-top: 20px;
      flex-wrap: wrap;
    }
    .actions > button[data-variant="primary"] { flex: 1 1 auto; }
    .status {
      margin-top: 18px;
      padding: 10px 12px;
      background: #f1f2f7;
      border: 1px solid var(--c-border);
      border-radius: 8px;
      font-size: 13px;
      color: var(--c-text);
      min-height: 18px;
      line-height: 1.5;
    }
    .footer {
      margin-top: 22px;
      font-size: 11.5px;
      color: var(--c-text-dim);
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>DeepSeek API Key Settings</h1>
    <p class="subtitle">Configure the API key used by the "AI Answers" sidebar tab on Coursera.</p>
    <div class="security-note">
      This key is entered in the extension settings page, not on Coursera. Your key never appears in any third-party webpage's DOM.
    </div>

    <label class="field-label" for="key">API key</label>
    <div class="input-row">
      <input id="key" data-role="ai-options-key" type="password" autocomplete="off" spellcheck="false" />
      <button data-action="ai-options-toggle" type="button" data-variant="ghost">Show</button>
    </div>

    <label class="remember-row">
      <input data-role="ai-options-remember" type="checkbox" />
      <span>Remember on this browser (persist across restarts)</span>
    </label>

    <div class="actions">
      <button data-action="ai-options-save" type="button" data-variant="primary">Save</button>
      <button data-action="ai-options-clear" type="button" data-variant="danger">Clear saved key</button>
    </div>

    <div class="status" data-role="ai-options-status"></div>

    <div class="footer">
      Session-only keys live until the browser closes. Remembered keys persist on this device until you clear them here. The extension never logs or transmits the key beyond DeepSeek's API.
    </div>
  </div>
  <script src="lib/ai-options-controller.js"></script>
  <script src="options.js"></script>
</body>
</html>
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `node --test tests/ai-options-controller.test.js`
Expected: all tests PASS (the new five UI-content tests + the pre-existing 10 controller tests).

- [ ] **Step 5: Do NOT commit.**

---

## Task 7: Regression sweep + leak scan + final report

**Files:** none modified.

- [ ] **Step 1: Run focused AI suite**

Run:
```
node --test tests/ai-question-context.test.js tests/ai-answer-validator.test.js tests/deepseek-client.test.js tests/ai-background-service.test.js tests/ai-answer-controller.test.js tests/ai-options-controller.test.js tests/ai-answer-tab.test.js tests/answer-applier.test.js tests/sidebar.test.js
```
Expected: ALL pass.

- [ ] **Step 2: Run Autopilot regression**

Run:
```
node --test tests/autopilot-authority.test.js tests/autopilot-state.test.js tests/module-autopilot.test.js tests/item-handlers.test.js tests/completion-confirmer.test.js tests/autopilot-timing.test.js
```
Expected: ALL pass with the existing 284/284 count. No autopilot file was modified by this pass; this is a defense-in-depth check.

- [ ] **Step 3: Run full `npm test`**

Run: `npm test`
Expected: total count ≥ 971 (the prior baseline) + new tests added in Tasks 1-6. All pass.

- [ ] **Step 4: Repo-wide leak scan**

Run:
```
node -e "const fs=require('fs');const p=require('path');let leaks=[];function w(d){fs.readdirSync(d).forEach(function(f){const fp=p.join(d,f);const s=fs.statSync(fp);if(s.isDirectory()){if(/node_modules|\\.git|Reference/.test(fp))return;w(fp);}else if(/\\.(js|json|md|html|css)$/.test(f)){const t=fs.readFileSync(fp,'utf8');const m=t.match(/sk-[A-Za-z0-9_]{16,}/);if(m)leaks.push(fp+': '+m[0]);}});}w('.');console.log(leaks.length?'LEAKS:\\n'+leaks.join('\\n'):'clean');"
```
Expected: `clean`.

- [ ] **Step 5: Confirm no Autopilot file modified by this pass**

Run: `git diff --stat lib/autopilot-state.js lib/autopilot-timing.js lib/autopilot-authority.js lib/autopilot-messenger.js lib/autopilot-debug.js lib/module-autopilot.js lib/completion-confirmer.js lib/item-handlers.js lib/module-scraper.js content.js background.js manifest.json lib/ai-question-context.js lib/ai-answer-controller.js lib/ai-background-service.js lib/ai-options-controller.js`

Expected: no autopilot file shows new diffs attributable to this pass. (Pre-existing dirty Autopilot work from the conversation baseline remains as-is.) `content.js`, `background.js`, `manifest.json`, and the AI logic modules also show no new edits. The only changed files attributable to this pass:

```
lib/sidebar.css
lib/sidebar.js
options.html
tests/sidebar.test.js
tests/ai-options-controller.test.js
```

- [ ] **Step 6: Verify the security boundary one more time**

Run:
```
node -e "const t=require('fs').readFileSync('lib/sidebar.js','utf8'); ['ai-key-input','ai-key-toggle','ai-key-save','ai-key-remember','ai-key-clear','wireDisableable'].forEach(function(s){console.log(s+': '+((t.match(new RegExp(s,'g'))||[]).length));});"
```

Expected: every count is `0`. The only allowed key UI in the sidebar remains `ai-key-configure` and `ai-key-state` and `ai-key-note`.

- [ ] **Step 7: Final report (chat message, no file edits)**

Compose a chat message covering:
- Sidebar width strategy: `width: min(440px, calc(100vw - 24px))`.
- Tab strategy: `flex-wrap: wrap`, tabs use `flex: 1 1 auto`. Tab label shortened to "AI Answers" while `data-tab="ai-answer"` is preserved.
- AI panel cards: `ai-card-key`, `ai-card-scan`, `ai-actions-primary`, `ai-actions-secondary`, `ai-actions-inflight`, `ai-previews`.
- Cancel visibility: hidden + disabled when idle; visible + enabled when in-flight via `setAiInFlight`.
- Options page: centered card on light theme, primary Save button, destructive Clear button, security note mentioning extension settings vs Coursera, all data-roles/data-actions preserved.
- Security invariants preserved: no key input in Coursera sidebar (verified), `wireDisableable` still absent, options.html strict sender authorization unchanged in `background.js`/`lib/ai-background-service.js`, no autopilot edits.
- Test totals: report focused suites, full `npm test`, leak scan = `clean`.
- Confirm: user may now reload the extension, click "Manage DeepSeek key" in the AI Answers tab, verify the URL begins with `chrome-extension://.../options.html`, and enter their real key on that page.

- [ ] **Step 8: Do NOT commit.**

---

## Self-review checks

1. **Spec coverage** — every section of the user's spec maps to a task:
   - Width + responsive sidebar → Task 1.
   - Tab navigation strategy → Task 1 (wrap) + Task 2 (short label).
   - AI panel visual hierarchy (key card / scan card / actions / previews) → Tasks 3 + 5.
   - Cancel-in-flight visibility behavior → Task 4.
   - Options page polish → Task 6.
   - Security invariant tests → Task 3 ("no password input, no ai-key-clear, no ai-key-save") and Task 7 Step 6.
   - Existing security regressions (XSS, sender, per-tab, blocked-page) → Task 7 Steps 1-2.
   - Verification → Task 7.

2. **Placeholder scan** — every code step contains literal code or commands. No TODO / TBD / "implement later" / "see Task N".

3. **Type/selector consistency** — every `data-card`, `data-action`, `data-role`, and `data-variant` value used in Task 3's HTML appears verbatim in the Task 3 / Task 4 tests. The shortened tab label "AI Answers" appears identically in Task 2's test and Task 2's HTML edit.

4. **Risk callouts** —
   - The `:has(> [hidden]:only-child)` selector in Task 5 requires Chromium ≥ 105 (the extension target is Chrome MV3 — easily supported).
   - Tests use `getComputedStyle` for the `flex-wrap` assertion; jsdom honors inline `<style>` and `<link rel="stylesheet">` in the shadow root via `loadStyles()`. If jsdom does not honor the linked stylesheet at test time (current code path: `CSS_URL` only set when `chrome.runtime.getURL` exists, otherwise an inline fallback `.ccp-host{position:fixed}` is injected) — then `flex-wrap` will not be measurable. The fallback test in Task 1 Step 1 may need adaptation: if `getComputedStyle(tabs).flexWrap` returns an empty string in jsdom, assert `tabs.querySelectorAll('.ccp-tab').length === 6` instead. The implementer should verify this in Task 1 Step 2 (RED) and if so, replace the wrap test with a structural one that asserts the inline fallback stylesheet is updated to include `flex-wrap: wrap` for `.ccp-tabs`, OR simply update the fallback string in `loadStyles()` to include the wrap rule. **Recommended adaptation if computed style returns empty:** change the test to read `lib/sidebar.css` directly and assert it contains `flex-wrap: wrap` for `.ccp-tabs`:
     ```javascript
     const fs = require('fs');
     const css = fs.readFileSync(require('path').join(__dirname, '..', 'lib', 'sidebar.css'), 'utf8');
     assert.ok(/\.ccp-tabs\s*\{[^}]*flex-wrap:\s*wrap/i.test(css));
     ```
     This is a robust contract test that doesn't depend on jsdom's CSS engine.
