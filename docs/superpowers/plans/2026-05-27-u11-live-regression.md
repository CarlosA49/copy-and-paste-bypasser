# U11 Live Regression Correction Pass — Options Navigation and Mode Card Visibility

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **No-git-mutation constraint:** Per the U11 scope/safety constraints, NO `git add`, `git commit`, `git push`, `git reset`, `git checkout`, `git clean`, `git revert`, `git amend`, `git branch`, or worktree cleanup may occur during this pass. The plan therefore contains no commit steps. Verification runs only read-only git (`git rev-parse`, `git status`, `git diff`) and Node tests.

**Goal:** Fix the two live-browser regressions: (1) the sidebar's `Manage AI API Key` button does nothing because the MV3 content script cannot directly call `chrome.runtime.openOptionsPage()` and no background handler exists for the fallback `ccp.ai.openOptions` message; (2) both AI access cards render simultaneously because `.ccp-ai-card { display: flex; }` overrides the `hidden` attribute's default `display: none`.

**Architecture:**
- The sidebar's `onOpenOptions` callback (in `content.js`) is rewritten to send exactly one sanitized runtime message `{ type: 'ccp.ai.openOptions' }` and accept a `{ ok }` response. A new tiny tested module `lib/ai-open-options-background.js` exposes a handler that wraps `chrome.runtime.openOptionsPage` and responds `{ ok: true }` on success or `{ ok: false, reason: 'open-options-failed' }` on failure. `background.js` instantiates the handler and registers it as a runtime message listener. The controller surfaces failure via a new minimal sidebar method `setAiOpenOptionsFailure(text)` that writes to an inert-text status element placed inside the AI API Key card.
- `lib/sidebar.css` gains one narrowly scoped rule — `.ccp-ai-card[hidden] { display: none; }` — placed immediately after the `.ccp-ai-card` rule. The cancel button's hidden behavior is already preserved by the existing `[data-card="ai-actions-inflight"]:has(> [hidden]:only-child) { display: none; }` rule and is verified by a regression test.

**Tech Stack:** Vanilla JS (MV3 service worker + content script + options page), `node:test`, `jsdom`, no build step.

---

## File Structure

- `lib/sidebar.css` — add one CSS rule (`.ccp-ai-card[hidden] { display: none; }`) immediately after the `.ccp-ai-card { … }` block.
- `lib/sidebar.js` — add inert-text status element inside `ai-card-key`; expose `setAiOpenOptionsFailure(text)` (writes textContent, toggles hidden, never injects HTML).
- `content.js` — rewrite `openOptionsFn` to send the single sanitized runtime message and invoke a result callback. Drop the direct `chrome.runtime.openOptionsPage()` call.
- `lib/ai-answer-controller.js` — change the `onOpenOptions` handler so it passes a result callback to `openOptionsFn` and on `{ ok: false }` calls `sidebar.setAiOpenOptionsFailure(...)` with the approved honest message; on success, clears the failure text.
- `lib/ai-open-options-background.js` — NEW tiny tested module that returns a `chrome.runtime.onMessage`-shaped handler. Only handles `{ type: 'ccp.ai.openOptions' }`. Wraps an injected `openOptionsPage(cb)` adapter. No storage access, no key access, no broadcast, no navigation beyond `openOptionsPage`.
- `background.js` — add one short IIFE that imports the new module via `importScripts('lib/ai-open-options-background.js')`, builds an `openOptionsPage(cb)` adapter around `chrome.runtime.openOptionsPage`, and registers the handler.
- `tests/sidebar.test.js` — append CSS-rule string-content tests; computed-style tests for card visibility; cancel-row regression test; tests for `setAiOpenOptionsFailure`.
- `tests/ai-answer-controller.test.js` — append tests asserting `openOptionsFn` is invoked with a callback, that the controller surfaces failure to `sidebar.setAiOpenOptionsFailure`, and that on success the failure text is cleared.
- `tests/content-open-options-callback.test.js` — NEW — a tiny extracted helper test for the message shape of the content-side `openOptionsFn`. (Implementation note: we extract a pure function `buildOpenOptionsCallback({ runtime })` into `lib/ai-open-options-content.js` so it can be tested without jsdom mounting all of `content.js`. See Task 6.)
- `lib/ai-open-options-content.js` — NEW — tiny pure factory that returns the `openOptionsFn` to be passed into the controller. Receives the runtime as a dep.
- `tests/ai-open-options-background.test.js` — NEW — tests for the background handler.
- `manifest.json` — register `lib/ai-open-options-content.js` as a content script (before `content.js`). No new permissions, no CSP changes, no host_permissions changes.

No other file may be modified.

---

## Task 1: RED — sidebar.css must hide AI cards carrying `hidden` attribute

**Files:**
- Test: `tests/sidebar.test.js` (append)

- [ ] **Step 1: Add a CSS file-content RED test**

Append to `tests/sidebar.test.js`:

```js
// === U11 Issue 2 — sidebar.css must enforce hidden on .ccp-ai-card ===

test('U11-2: lib/sidebar.css contains the .ccp-ai-card[hidden] display:none rule', () => {
  const fs = require('fs'); const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sidebar.css'), 'utf8');
  assert.ok(
    /\.ccp-ai-card\[hidden\]\s*\{\s*display:\s*none\s*;?\s*\}/.test(css),
    'lib/sidebar.css must declare ".ccp-ai-card[hidden] { display: none; }" to override the .ccp-ai-card display:flex rule'
  );
});
```

- [ ] **Step 2: Run the test and verify it FAILS**

Run: `node --test --test-name-pattern="U11-2: lib/sidebar.css contains" tests/sidebar.test.js`
Expected: FAIL with `lib/sidebar.css must declare ".ccp-ai-card[hidden] { display: none; }"`.

---

## Task 2: RED — computed-style integration tests for card visibility

**Files:**
- Test: `tests/sidebar.test.js` (append)

- [ ] **Step 1: Read the existing `freshSidebar()` helper to learn the mount pattern**

Open `tests/sidebar.test.js` and locate `freshSidebar()`. Note whether it injects `lib/sidebar.css` into the JSDOM. If it does, the tests below can use `getComputedStyle`. If it does not (it likely loads the stylesheet via shadow DOM with a `<link>` whose URL fails to resolve in JSDOM), the implementer should manually inject the stylesheet content via a `<style>` element inside the shadow root for these tests only.

- [ ] **Step 2: Add a small helper that mounts the sidebar AND inlines the stylesheet for computed-style tests**

Append to `tests/sidebar.test.js`, near `freshSidebar()`:

```js
function freshSidebarWithCss() {
  const { sidebar, shadow, dom } = freshSidebar();
  // Inline lib/sidebar.css into the shadow root so JSDOM's getComputedStyle
  // can resolve display rules. Idempotent: if a <style data-test="ccp"> tag
  // already exists, reuse it.
  const fs = require('fs'); const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sidebar.css'), 'utf8');
  let styleTag = shadow.querySelector('style[data-test="ccp"]');
  if (!styleTag) {
    styleTag = dom.window.document.createElement('style');
    styleTag.setAttribute('data-test', 'ccp');
    shadow.appendChild(styleTag);
  }
  styleTag.textContent = css;
  return { sidebar, shadow, dom };
}
```

Note: if `freshSidebar()` does not currently return `dom`, modify your local copy of the helper invocation to obtain `dom` from where `freshSidebar` constructs it (or change `freshSidebar` to also return `dom`). The implementer subagent should report back if this requires touching `freshSidebar()`'s signature — that change is allowed because it's test-only.

- [ ] **Step 3: Add the three computed-style RED tests**

Append:

```js
test('U11-2: default-mount personal-key mode renders ONLY the AI API Key card (computed style)', () => {
  const { shadow, dom } = freshSidebarWithCss();
  const key = shadow.querySelector('[data-card="ai-card-key"]');
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  const keyDisp = dom.window.getComputedStyle(key).display;
  const managedDisp = dom.window.getComputedStyle(managed).display;
  assert.notEqual(keyDisp, 'none', 'personal-key card must render');
  assert.equal(managedDisp, 'none', 'managed card must be display:none, not just hidden');
});

test('U11-2: setAiAccessMode("managed-credits") renders ONLY the AI Credits card (computed style)', () => {
  const { sidebar, shadow, dom } = freshSidebarWithCss();
  sidebar.setAiAccessMode('managed-credits');
  const key = shadow.querySelector('[data-card="ai-card-key"]');
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  const keyDisp = dom.window.getComputedStyle(key).display;
  const managedDisp = dom.window.getComputedStyle(managed).display;
  assert.equal(keyDisp, 'none', 'personal-key card must be display:none after managed-credits');
  assert.notEqual(managedDisp, 'none', 'managed card must render after managed-credits');
});

test('U11-2: setAiAccessMode("garbage") normalizes to personal-key and renders ONLY the AI API Key card', () => {
  const { sidebar, shadow, dom } = freshSidebarWithCss();
  sidebar.setAiAccessMode('garbage');
  const key = shadow.querySelector('[data-card="ai-card-key"]');
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  assert.notEqual(dom.window.getComputedStyle(key).display, 'none');
  assert.equal(dom.window.getComputedStyle(managed).display, 'none');
});

test('U11-2: the two access cards are NEVER both visibly rendered simultaneously across mode toggles', () => {
  const { sidebar, shadow, dom } = freshSidebarWithCss();
  const modes = ['personal-key', 'managed-credits', 'personal-key', 'garbage', 'managed-credits'];
  for (const m of modes) {
    sidebar.setAiAccessMode(m);
    const k = dom.window.getComputedStyle(shadow.querySelector('[data-card="ai-card-key"]')).display;
    const g = dom.window.getComputedStyle(shadow.querySelector('[data-card="ai-card-managed"]')).display;
    const kVisible = k !== 'none';
    const gVisible = g !== 'none';
    assert.ok(!(kVisible && gVisible), 'both cards visible after setAiAccessMode("' + m + '")');
    assert.ok(kVisible || gVisible, 'at least one card must be visible after setAiAccessMode("' + m + '")');
  }
});

test('U11-2: REGRESSION — cancel button row stays hidden when not in flight (existing :has rule still works)', () => {
  const { sidebar, shadow, dom } = freshSidebarWithCss();
  // Default state: not in flight, cancel button is hidden
  const inflightRow = shadow.querySelector('[data-card="ai-actions-inflight"]');
  if (inflightRow) {
    const disp = dom.window.getComputedStyle(inflightRow).display;
    assert.equal(disp, 'none', 'the inflight action row must remain display:none when cancel is hidden');
  }
});
```

- [ ] **Step 4: Run and verify they FAIL (or partially fail)**

Run: `node --test --test-name-pattern="U11-2" tests/sidebar.test.js`
Expected: the four computed-style tests for cards should FAIL because the current CSS has `.ccp-ai-card { display: flex; }` overriding `hidden`. The cancel regression test should already PASS (the existing rule covers it). If JSDOM's computed-style returns `''` or `'flex'` instead of `'none'`, that confirms the regression.

If the computed-style tests are inconclusive in JSDOM (e.g. all return empty strings), note this in the implementer report and rely on Task 1's file-content rule as the primary regression guard. The implementer MUST run an explicit visual check via `node --eval` with JSDOM to see actual computed display before declaring inconclusive.

---

## Task 3: GREEN — add the CSS rule in `lib/sidebar.css`

**Files:**
- Modify: `lib/sidebar.css` (insert after the existing `.ccp-ai-card { … }` block, currently at lines ~300–308)

- [ ] **Step 1: Insert the CSS rule**

Open `lib/sidebar.css`. Find the `.ccp-ai-card` rule:

```css
.ccp-ai-card {
  background: var(--ccp-surface);
  border: 1px solid var(--ccp-border);
  border-radius: 10px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
```

Insert immediately after the closing `}` of that rule:

```css
.ccp-ai-card[hidden] { display: none; }
```

This narrow rule wins over `display: flex` because it has equal specificity (both `.ccp-ai-card` selectors) AND uses an attribute selector that increases specificity from (0,1,0) to (0,2,0).

- [ ] **Step 2: Run U11-2 tests**

Run: `node --test --test-name-pattern="U11-2" tests/sidebar.test.js`
Expected: all U11-2 tests PASS.

- [ ] **Step 3: Run the full sidebar test file**

Run: `node --test tests/sidebar.test.js`
Expected: every test PASSES, including the S2-3 mutual-exclusion tests, the existing managed/personal hidden tests, and the new U11-2 computed-style tests.

---

## Task 4: RED — sidebar `setAiOpenOptionsFailure` method + DOM element

**Files:**
- Test: `tests/sidebar.test.js` (append)

- [ ] **Step 1: Add RED tests for the new sidebar method**

Append to `tests/sidebar.test.js`:

```js
// === U11 Issue 1 — sidebar must surface open-options failure as inert text ===

test('U11-1: ai-card-key contains a hidden [data-role="ai-open-options-status"] inert-text element', () => {
  const { shadow } = freshSidebar();
  const keyCard = shadow.querySelector('[data-card="ai-card-key"]');
  assert.ok(keyCard, 'ai-card-key must exist');
  const status = keyCard.querySelector('[data-role="ai-open-options-status"]');
  assert.ok(status, 'ai-card-key must contain [data-role="ai-open-options-status"]');
  assert.ok(status.hasAttribute('hidden'), 'open-options status must start hidden');
  assert.equal(status.textContent, '', 'open-options status must start empty');
});

test('U11-1: setAiOpenOptionsFailure(text) sets visible inert text', () => {
  const { sidebar, shadow } = freshSidebar();
  const honest = 'Unable to open AI API Key settings. Open the extension options page from chrome://extensions.';
  sidebar.setAiOpenOptionsFailure(honest);
  const status = shadow.querySelector('[data-role="ai-open-options-status"]');
  assert.equal(status.textContent, honest);
  assert.equal(status.hasAttribute('hidden'), false, 'status must un-hide when failure text is set');
});

test('U11-1: setAiOpenOptionsFailure("") clears and re-hides the status', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiOpenOptionsFailure('something');
  sidebar.setAiOpenOptionsFailure('');
  const status = shadow.querySelector('[data-role="ai-open-options-status"]');
  assert.equal(status.textContent, '');
  assert.ok(status.hasAttribute('hidden'), 'status must re-hide when text is empty');
});

test('U11-1: setAiOpenOptionsFailure renders via textContent (no HTML injection)', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiOpenOptionsFailure('<img data-attack="x" src=x onerror=alert(1)>');
  const status = shadow.querySelector('[data-role="ai-open-options-status"]');
  assert.equal(status.querySelector('img[data-attack="x"]'), null, 'must not parse HTML');
  assert.ok(status.textContent.indexOf('<img') !== -1, 'must render as literal text');
});
```

- [ ] **Step 2: Run and verify FAIL**

Run: `node --test --test-name-pattern="U11-1: ai-card-key contains|U11-1: setAiOpenOptionsFailure" tests/sidebar.test.js`
Expected: all four tests FAIL — the element does not exist and the method is not exposed.

---

## Task 5: GREEN — add the DOM element and the `setAiOpenOptionsFailure` method

**Files:**
- Modify: `lib/sidebar.js`

- [ ] **Step 1: Add the inert-text element inside the AI API Key card template**

Open `lib/sidebar.js`. Find the AI API Key card template block (currently around lines 122–129) which includes:

```js
            '<div class="ccp-ai-note" data-role="ai-key-note">Your AI API Key is entered only in extension settings, never on Coursera.</div>' +
            '<div class="ccp-ai-row">' +
              '<button class="ccp-btn" data-action="ai-key-configure">Manage AI API Key</button>' +
            '</div>' +
          '</div>' +
```

Insert a new line immediately AFTER the `Manage AI API Key` button row's closing `</div>` and BEFORE the card's closing `</div>`:

```js
            '<div class="ccp-ai-status-line" data-role="ai-open-options-status" data-tone="warn" hidden></div>' +
```

The full replacement block looks like:

```js
            '<div class="ccp-ai-note" data-role="ai-key-note">Your AI API Key is entered only in extension settings, never on Coursera.</div>' +
            '<div class="ccp-ai-row">' +
              '<button class="ccp-btn" data-action="ai-key-configure">Manage AI API Key</button>' +
            '</div>' +
            '<div class="ccp-ai-status-line" data-role="ai-open-options-status" data-tone="warn" hidden></div>' +
          '</div>' +
```

- [ ] **Step 2: Add the `setAiOpenOptionsFailure` function**

Find where the existing AI sidebar helpers are exported (search for `setAiAccessMode` or `setAiKeyStatus`). Add this function near them:

```js
  function setAiOpenOptionsFailure(text) {
    if (!shadow) return;
    var el = shadow.querySelector('[data-role="ai-open-options-status"]');
    if (!el) return;
    var s = (typeof text === 'string') ? text : '';
    el.textContent = s;
    if (s.length === 0) el.setAttribute('hidden', '');
    else el.removeAttribute('hidden');
  }
```

Then add it to the public sidebar API export — find the `return` or `Object.assign` that exposes the sidebar functions (the file likely returns an object literal). Add `setAiOpenOptionsFailure: setAiOpenOptionsFailure,` to that exported object.

If you cannot locate the export pattern, search for `setAiAccessMode:` and add the new entry next to it in the same export object.

- [ ] **Step 3: Run the U11-1 sidebar tests**

Run: `node --test --test-name-pattern="U11-1" tests/sidebar.test.js`
Expected: all four U11-1 tests PASS.

- [ ] **Step 4: Run the full sidebar test file**

Run: `node --test tests/sidebar.test.js`
Expected: every test PASSES. Note that the cancel-row, S2-3 mutual-exclusion, and U10-3 honest-copy tests must all remain green.

---

## Task 6: RED — content-side openOptionsFn message shape (extracted helper)

**Files:**
- Create: `lib/ai-open-options-content.js`
- Test: `tests/ai-open-options-content.test.js`

Rationale for extraction: testing the message shape sent from `content.js` is awkward because `content.js` is a top-level IIFE. We extract a pure factory `createOpenOptionsCallback({ runtime })` so it can be unit-tested without mounting all of `content.js`. The factory returns the same `openOptionsFn(onResult)` callable that `content.js` will pass into the controller.

- [ ] **Step 1: Create the test file**

Create `tests/ai-open-options-content.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenOptionsCallback } = require('../lib/ai-open-options-content.js');

function fakeRuntime(behavior) {
  const sent = [];
  return {
    sent: sent,
    sendMessage: function (msg, cb) {
      sent.push(msg);
      Promise.resolve(behavior(msg)).then(function (res) { if (cb) cb(res); });
    },
  };
}

test('U11-1: createOpenOptionsCallback returns a function', () => {
  const fn = createOpenOptionsCallback({ runtime: fakeRuntime(function () { return { ok: true }; }) });
  assert.equal(typeof fn, 'function');
});

test('U11-1: invoking the callback sends EXACTLY {type:"ccp.ai.openOptions"}', () => {
  const rt = fakeRuntime(function () { return { ok: true }; });
  const fn = createOpenOptionsCallback({ runtime: rt });
  fn(function () {});
  assert.equal(rt.sent.length, 1);
  assert.deepEqual(rt.sent[0], { type: 'ccp.ai.openOptions' });
});

test('U11-1: callback NEVER calls chrome.runtime.openOptionsPage()', () => {
  // The runtime stub we pass intentionally has no openOptionsPage method.
  // If the production code tried to call it, the next assertion would not
  // execute because of a TypeError. We assert by absence: sent[0] is just the
  // navigation message; the runtime stub never observed an openOptionsPage call.
  const rt = fakeRuntime(function () { return { ok: true }; });
  assert.equal(typeof rt.openOptionsPage, 'undefined');
  const fn = createOpenOptionsCallback({ runtime: rt });
  fn(function () {});
  assert.equal(rt.sent.length, 1);
});

test('U11-1: callback forwards the response to onResult', async () => {
  const rt = fakeRuntime(function () { return { ok: true }; });
  const fn = createOpenOptionsCallback({ runtime: rt });
  const got = await new Promise(function (r) { fn(r); });
  assert.deepEqual(got, { ok: true });
});

test('U11-1: callback forwards a failure response to onResult', async () => {
  const rt = fakeRuntime(function () { return { ok: false, reason: 'open-options-failed' }; });
  const fn = createOpenOptionsCallback({ runtime: rt });
  const got = await new Promise(function (r) { fn(r); });
  assert.deepEqual(got, { ok: false, reason: 'open-options-failed' });
});

test('U11-1: missing/undefined response is normalized to {ok:false, reason:"no-response"}', async () => {
  const rt = fakeRuntime(function () { return undefined; });
  const fn = createOpenOptionsCallback({ runtime: rt });
  const got = await new Promise(function (r) { fn(r); });
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'no-response');
});

test('U11-1: thrown send error normalizes to {ok:false, reason:"send-failed"}', async () => {
  const throwingRuntime = {
    sendMessage: function () { throw new Error('boom'); },
  };
  const fn = createOpenOptionsCallback({ runtime: throwingRuntime });
  const got = await new Promise(function (r) { fn(r); });
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'send-failed');
});

test('U11-1: no onResult callback is a safe no-op (no throw)', () => {
  const rt = fakeRuntime(function () { return { ok: true }; });
  const fn = createOpenOptionsCallback({ runtime: rt });
  assert.doesNotThrow(function () { fn(); });
});

test('U11-1: missing runtime dependency is a safe no-op invocation', () => {
  const fn = createOpenOptionsCallback({});
  // The factory itself should not throw at construction.
  // Invoking the callback with no runtime should not throw and should return a failure to onResult.
  let got = null;
  assert.doesNotThrow(function () { fn(function (r) { got = r; }); });
  assert.equal(got && got.ok, false);
});

test('U11-1: request payload contains no key, balance, account, token, or credit', () => {
  const rt = fakeRuntime(function () { return { ok: true }; });
  const fn = createOpenOptionsCallback({ runtime: rt });
  fn(function () {});
  const payload = JSON.stringify(rt.sent[0]);
  ['sk-', 'balance', 'account', 'token', 'credit', 'key'].forEach(function (forbidden) {
    assert.equal(payload.toLowerCase().indexOf(forbidden), -1,
      'forbidden substring in open-options request: ' + forbidden);
  });
});
```

- [ ] **Step 2: Run the test and verify it FAILS**

Run: `node --test tests/ai-open-options-content.test.js`
Expected: all tests FAIL — the module does not exist yet (`Cannot find module '../lib/ai-open-options-content.js'`).

---

## Task 7: GREEN — implement `lib/ai-open-options-content.js`

**Files:**
- Create: `lib/ai-open-options-content.js`

- [ ] **Step 1: Create the module**

Create `lib/ai-open-options-content.js`:

```js
'use strict';
// lib/ai-open-options-content.js
// U11 Issue 1 — tiny content-side factory that builds the `openOptionsFn`
// callback passed into the AI answer controller. The callback sends exactly
// one sanitized runtime message ({type:'ccp.ai.openOptions'}) to the service
// worker and forwards the response to an optional onResult callback.
// No direct chrome.runtime.openOptionsPage() call — that API is not callable
// from a content script in MV3.

(function (root) {
  'use strict';

  function createOpenOptionsCallback(deps) {
    var runtime = (deps && deps.runtime) ? deps.runtime : null;
    return function openOptionsFn(onResult) {
      function deliver(res) {
        if (typeof onResult === 'function') {
          try { onResult(res); } catch (_) { /* never let UI errors poison content-script flow */ }
        }
      }
      if (!runtime || typeof runtime.sendMessage !== 'function') {
        deliver({ ok: false, reason: 'send-failed' });
        return;
      }
      try {
        runtime.sendMessage({ type: 'ccp.ai.openOptions' }, function (res) {
          deliver(res || { ok: false, reason: 'no-response' });
        });
      } catch (_) {
        deliver({ ok: false, reason: 'send-failed' });
      }
    };
  }

  var api = { createOpenOptionsCallback: createOpenOptionsCallback };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.ClipboardCleaner = root.ClipboardCleaner || {}; root.ClipboardCleaner.aiOpenOptionsContent = api; }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 2: Run the test file and verify PASS**

Run: `node --test tests/ai-open-options-content.test.js`
Expected: all 10 tests PASS.

---

## Task 8: GREEN — wire `content.js` to use the new factory; remove direct `chrome.runtime.openOptionsPage()`

**Files:**
- Modify: `content.js`
- Modify: `manifest.json` (register the new module in content_scripts BEFORE `content.js`)

- [ ] **Step 1: Replace the inline `openOptionsFn` in `content.js`**

Open `content.js`. Locate the `setupAiAnswerController()` function and the `openOptionsFn` it currently passes (looks like):

```js
      openOptionsFn: function () {
        try { chrome.runtime.openOptionsPage(); }
        catch (e) {
          // Fallback if openOptionsPage is unavailable in this context: send a message to background to open it.
          try { chrome.runtime.sendMessage({ type: 'ccp.ai.openOptions' }); } catch (_) {}
        }
      },
```

Replace it with:

```js
      openOptionsFn: (a.aiOpenOptionsContent && typeof a.aiOpenOptionsContent.createOpenOptionsCallback === 'function')
        ? a.aiOpenOptionsContent.createOpenOptionsCallback({ runtime: chrome.runtime })
        : function (cb) { if (typeof cb === 'function') cb({ ok: false, reason: 'module-not-loaded' }); },
```

Note: the inline `chrome.runtime.openOptionsPage()` call must be GONE. The fallback `function (cb) { ... }` exists only for graceful degradation if the helper module fails to load — it does not call openOptionsPage either.

- [ ] **Step 2: Register `lib/ai-open-options-content.js` in `manifest.json`**

Open `manifest.json`. In `content_scripts[0].js`, insert `"lib/ai-open-options-content.js"` immediately AFTER `"lib/ai-content-listeners.js"` and BEFORE `"lib/sidebar.js"` and BEFORE `"content.js"`. The relevant snippet becomes:

```
        "lib/ai-answer-controller.js",
        "lib/ai-content-listeners.js",
        "lib/ai-open-options-content.js",
        "lib/sidebar.js",
        ...
        "content.js"
```

No other manifest edits: no new permissions, no host_permissions, no CSP, no web_accessible_resources.

- [ ] **Step 3: Verify the diff is exactly two lines (content.js edit + manifest.json line insertion)**

Grep `content.js` for `chrome.runtime.openOptionsPage`. Expected: ZERO matches. If a match remains, the inline call was not fully removed.

Grep `manifest.json` for `lib/ai-open-options-content.js`. Expected: ONE match.

- [ ] **Step 4: Add a production-source regression test (`tests/ai-open-options-content.test.js`)**

Append to `tests/ai-open-options-content.test.js`:

```js
// === U11 production-source regression — content.js must NOT call openOptionsPage directly ===

test('U11-1: content.js contains NO direct chrome.runtime.openOptionsPage() call after the fix', () => {
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  assert.equal(src.indexOf('chrome.runtime.openOptionsPage'), -1,
    'content.js must not call chrome.runtime.openOptionsPage() directly — that API is not callable from a content script in MV3. The settings path must delegate through createOpenOptionsCallback.');
});

test('U11-1: content.js wires openOptionsFn through the sanitized helper (createOpenOptionsCallback)', () => {
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  assert.ok(/createOpenOptionsCallback/.test(src),
    'content.js must reference createOpenOptionsCallback so the settings path delegates through the helper');
  assert.ok(/aiOpenOptionsContent/.test(src),
    'content.js must reference window.ClipboardCleaner.aiOpenOptionsContent via the local `a` alias');
});

test('U11-1: only background.js performs chrome.runtime.openOptionsPage() in production source', () => {
  const fs = require('fs'); const path = require('path');
  const root = path.join(__dirname, '..');
  // Public-surface production files that must NOT call openOptionsPage directly.
  // (Test files, baseline snapshots, and node_modules are excluded by listing
  // only the production files in the load order.)
  const forbidden = [
    'content.js',
    'options.js',
    'lib/ai-answer-controller.js',
    'lib/ai-options-controller.js',
    'lib/ai-content-listeners.js',
    'lib/ai-open-options-content.js',
    'lib/sidebar.js',
    'lib/ai-background-service.js',
  ];
  for (const rel of forbidden) {
    const src = fs.readFileSync(path.join(root, rel), 'utf8');
    assert.equal(src.indexOf('chrome.runtime.openOptionsPage'), -1,
      rel + ' must not call chrome.runtime.openOptionsPage() — only background.js may');
  }
  // background.js MUST contain at least one call (production wiring).
  const bg = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  const matches = bg.match(/chrome\.runtime\.openOptionsPage/g) || [];
  assert.ok(matches.length >= 1,
    'background.js must invoke chrome.runtime.openOptionsPage() at least once (the only authorized production path)');
});
```

Run: `node --test --test-name-pattern="U11-1: content.js contains NO|U11-1: content.js wires|U11-1: only background.js" tests/ai-open-options-content.test.js`
Expected: all three PASS after Step 1's content.js edit and after Task 13's background.js edit. (If background.js wiring is not yet applied, the third test will fail; rerun after Task 13. It is acceptable to run this regression as part of Step 2 of Task 13.)

---

## Task 9: RED — controller must invoke `sidebar.setAiOpenOptionsFailure` on failure

**Files:**
- Test: `tests/ai-answer-controller.test.js` (append)

- [ ] **Step 1: Add RED tests**

Append to `tests/ai-answer-controller.test.js`:

```js
// === U11 Issue 1 — controller surfaces open-options failure via sidebar ===

test('U11-1: controller calls openOptionsFn with a callback function (not bare)', () => {
  // We capture the openOptionsFn call signature.
  let received = null;
  const fakeSidebar = makeFakeSidebar();
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
    validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
    answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
    messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
    document: { body: {}, querySelector: () => null },
    location: { href: '', pathname: '' },
    openOptionsFn: function (onResult) { received = { argType: typeof onResult }; if (typeof onResult === 'function') onResult({ ok: true }); },
  });
  ctrl.wire();
  // Trigger the open-options handler that the sidebar received.
  const handlers = fakeSidebar._getHandlers();
  handlers.onOpenOptions();
  assert.ok(received, 'openOptionsFn must have been invoked');
  assert.equal(received.argType, 'function', 'openOptionsFn must be invoked WITH a result callback');
});

test('U11-1: on {ok:false} from openOptionsFn, controller calls sidebar.setAiOpenOptionsFailure with the honest message', () => {
  const fakeSidebar = makeFakeSidebar();
  let failureMsg = null;
  fakeSidebar.setAiOpenOptionsFailure = function (text) { failureMsg = text; };
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
    validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
    answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
    messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
    document: { body: {}, querySelector: () => null },
    location: { href: '', pathname: '' },
    openOptionsFn: function (cb) { cb({ ok: false, reason: 'open-options-failed' }); },
  });
  ctrl.wire();
  fakeSidebar._getHandlers().onOpenOptions();
  assert.equal(failureMsg, 'Unable to open AI API Key settings. Open the extension options page from chrome://extensions.');
});

test('U11-1: on {ok:true}, controller calls sidebar.setAiOpenOptionsFailure with empty string (clear prior failure)', () => {
  const fakeSidebar = makeFakeSidebar();
  let lastFailureMsg = null;
  fakeSidebar.setAiOpenOptionsFailure = function (text) { lastFailureMsg = text; };
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
    validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
    answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
    messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
    document: { body: {}, querySelector: () => null },
    location: { href: '', pathname: '' },
    openOptionsFn: function (cb) { cb({ ok: true }); },
  });
  ctrl.wire();
  fakeSidebar._getHandlers().onOpenOptions();
  assert.equal(lastFailureMsg, '');
});

test('U11-1: missing sidebar.setAiOpenOptionsFailure is a safe no-op (no throw)', () => {
  const fakeSidebar = makeFakeSidebar();
  // intentionally omit setAiOpenOptionsFailure
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
    validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
    answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
    messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
    document: { body: {}, querySelector: () => null },
    location: { href: '', pathname: '' },
    openOptionsFn: function (cb) { cb({ ok: false, reason: 'open-options-failed' }); },
  });
  ctrl.wire();
  assert.doesNotThrow(function () { fakeSidebar._getHandlers().onOpenOptions(); });
});

// === U11 — failure-state reset behaviour ===

test('U11-1: repeated failures do NOT append duplicate markup (idempotent write)', () => {
  // After two failure click cycles, the sidebar's setAiOpenOptionsFailure must
  // have been called exactly twice with the SAME approved message, and the call
  // history must contain only that approved message — no concatenation, no
  // accumulated text, and no raw exception detail.
  const fakeSidebar = makeFakeSidebar();
  const calls = [];
  fakeSidebar.setAiOpenOptionsFailure = function (text) { calls.push(text); };
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
    validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
    answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
    messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
    document: { body: {}, querySelector: () => null },
    location: { href: '', pathname: '' },
    openOptionsFn: function (cb) { cb({ ok: false, reason: 'open-options-failed' }); },
  });
  ctrl.wire();
  fakeSidebar._getHandlers().onOpenOptions();
  fakeSidebar._getHandlers().onOpenOptions();
  assert.equal(calls.length, 2);
  // Each call must be the SAME approved message (no concatenation, no growth)
  const approved = 'Unable to open AI API Key settings. Open the extension options page from chrome://extensions.';
  assert.equal(calls[0], approved);
  assert.equal(calls[1], approved);
});

test('U11-1: failure → success sequence — second click clears prior failure (single sweep)', () => {
  // First click fails; second click succeeds. The sidebar receives:
  //   [approved-failure-msg, '']
  // in that order. The success call clears the prior failure feedback.
  const fakeSidebar = makeFakeSidebar();
  const calls = [];
  fakeSidebar.setAiOpenOptionsFailure = function (text) { calls.push(text); };
  let nextResponse = { ok: false, reason: 'open-options-failed' };
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
    validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
    answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
    messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
    document: { body: {}, querySelector: () => null },
    location: { href: '', pathname: '' },
    openOptionsFn: function (cb) { cb(nextResponse); },
  });
  ctrl.wire();
  fakeSidebar._getHandlers().onOpenOptions();
  nextResponse = { ok: true };
  fakeSidebar._getHandlers().onOpenOptions();
  assert.equal(calls.length, 2);
  assert.equal(calls[0], 'Unable to open AI API Key settings. Open the extension options page from chrome://extensions.');
  assert.equal(calls[1], '', 'success after failure must clear the prior failure feedback');
});

test('U11-1: failure → success → failure preserves correct sweep order', () => {
  const fakeSidebar = makeFakeSidebar();
  const calls = [];
  fakeSidebar.setAiOpenOptionsFailure = function (text) { calls.push(text); };
  const responses = [
    { ok: false, reason: 'open-options-failed' },
    { ok: true },
    { ok: false, reason: 'open-options-failed' },
  ];
  let idx = 0;
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
    validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
    answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
    messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
    document: { body: {}, querySelector: () => null },
    location: { href: '', pathname: '' },
    openOptionsFn: function (cb) { cb(responses[idx++]); },
  });
  ctrl.wire();
  fakeSidebar._getHandlers().onOpenOptions();
  fakeSidebar._getHandlers().onOpenOptions();
  fakeSidebar._getHandlers().onOpenOptions();
  const approved = 'Unable to open AI API Key settings. Open the extension options page from chrome://extensions.';
  assert.deepEqual(calls, [approved, '', approved]);
});

test('U11-1: raw runtime exception content is NEVER displayed to the user (only the approved message)', () => {
  // The controller must NOT surface the raw exception message — only the
  // approved generic message.
  const fakeSidebar = makeFakeSidebar();
  let lastMsg = null;
  fakeSidebar.setAiOpenOptionsFailure = function (text) { lastMsg = text; };
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
    validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
    answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
    messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
    document: { body: {}, querySelector: () => null },
    location: { href: '', pathname: '' },
    openOptionsFn: function () { throw new Error('SECRET-CONTEXT-LEAK-token=sk-pretend-keymaterial'); },
  });
  ctrl.wire();
  assert.doesNotThrow(function () { fakeSidebar._getHandlers().onOpenOptions(); });
  const approved = 'Unable to open AI API Key settings. Open the extension options page from chrome://extensions.';
  assert.equal(lastMsg, approved, 'must surface only the approved generic message');
  // Belt and suspenders: the raw exception substring must NEVER appear.
  assert.equal((lastMsg || '').indexOf('SECRET-CONTEXT-LEAK'), -1, 'raw exception content must never leak');
  assert.equal((lastMsg || '').indexOf('sk-pretend'), -1, 'no key-like substring must leak');
});

test('U11-1: unusual response shapes (null, undefined, missing ok) all surface the approved generic message — no raw content', () => {
  const variants = [null, undefined, {}, { ok: 'truthy-string-not-true' }, { error: 'leaky-internal-detail' }];
  for (const variant of variants) {
    const fakeSidebar = makeFakeSidebar();
    let lastMsg = null;
    fakeSidebar.setAiOpenOptionsFailure = function (text) { lastMsg = text; };
    const ctrl = createAiController({
      sidebar: fakeSidebar,
      questionContext: { buildQuestionSnapshot: () => ({ page: { eligible: true }, questions: [], token: 't' }), sanitizeForRequest: (s) => s, isCurrentPageBlocked: () => ({ blocked: false }), compareLocalGuards: () => ({ changed: false }) },
      validator: { validateAndMap: () => ({ ok: true, suggestions: [] }) },
      answerApplier: { applyStructuredAnswers: () => ({ summary: { filled: 0, failed: 0 } }) },
      messenger: { send: function (cmd, p, cb) { cb({ ok: true, keyPresent: false }); } },
      document: { body: {}, querySelector: () => null },
      location: { href: '', pathname: '' },
      openOptionsFn: function (cb) { cb(variant); },
    });
    ctrl.wire();
    fakeSidebar._getHandlers().onOpenOptions();
    assert.equal(lastMsg, 'Unable to open AI API Key settings. Open the extension options page from chrome://extensions.',
      'variant must surface the approved message: ' + JSON.stringify(variant));
    if (variant && variant.error) {
      assert.equal(lastMsg.indexOf('leaky-internal-detail'), -1, 'must not surface variant.error content');
    }
  }
});
```

**Important:** if `makeFakeSidebar()` does not exist or does not expose `_getHandlers()`, find the existing pattern in `tests/ai-answer-controller.test.js` — it likely uses a similar fixture. Adapt the tests to that fixture's actual surface. The implementer subagent should report if the existing test fixture differs and adjust accordingly without changing the assertion intent. If the fixture cannot capture handler invocations, the implementer should extend it with a minimal accessor (e.g., a `_getHandlers()` or `_capturedHandlers` slot) — that change is allowed because it is test-only and matches the existing pattern from prior tests.

- [ ] **Step 2: Run and verify FAIL**

Run: `node --test --test-name-pattern="U11-1" tests/ai-answer-controller.test.js`
Expected: 8–9 tests FAIL — the controller currently invokes `openOptionsFn()` with no callback and does not invoke `setAiOpenOptionsFailure`. The failure-state reset tests will also fail since the reset/idempotency behavior does not yet exist.

---

## Task 10: GREEN — controller invokes `openOptionsFn` with a callback and surfaces failure

**Files:**
- Modify: `lib/ai-answer-controller.js`

- [ ] **Step 1: Update the `onOpenOptions` wire**

Open `lib/ai-answer-controller.js`. Find in `wire()`:

```js
      sidebar.setAiAnswerHandlers({
        onOpenOptions: function () { openOptionsFn(); },
        onOpenPortal: function () { if (openPortalFn) openPortalFn(); },
        ...
      });
```

Replace the `onOpenOptions` line with:

```js
        onOpenOptions: function () {
          try {
            openOptionsFn(function (res) {
              var ok = !!(res && res.ok);
              if (typeof sidebar.setAiOpenOptionsFailure === 'function') {
                try {
                  sidebar.setAiOpenOptionsFailure(ok
                    ? ''
                    : 'Unable to open AI API Key settings. Open the extension options page from chrome://extensions.');
                } catch (_) { /* never let UI errors block the click */ }
              }
            });
          } catch (_) {
            if (typeof sidebar.setAiOpenOptionsFailure === 'function') {
              try {
                sidebar.setAiOpenOptionsFailure('Unable to open AI API Key settings. Open the extension options page from chrome://extensions.');
              } catch (_) {}
            }
          }
        },
```

- [ ] **Step 2: Run the controller tests**

Run: `node --test tests/ai-answer-controller.test.js`
Expected: all PASS, including the new U11-1 tests.

---

## Task 11: RED — background open-options handler (with sender authorization)

**Files:**
- Create: `tests/ai-open-options-background.test.js`

The background handler is **two-stage**:
1. **`canOpenOptions(sender)`** — injected, testable predicate that decides whether the sender is allowed to ask the service worker to open the extension options page.
2. **`openOptionsPage(cb)`** — injected adapter that wraps `chrome.runtime.openOptionsPage` and reports success/failure via a node-style callback.

The production predicate (`isCourseraSender`) exported from the same module allows ONLY:
- `https://coursera.org/...` (bare apex)
- `https://*.coursera.org/...` (any subdomain — `www.`, `es.`, etc.)

It rejects:
- Non-https schemes (including `http://www.coursera.org/`).
- Lookalike hosts (`evilcoursera.org`, `www.coursera.org.evil.com`).
- Unrelated web origins (`example.com`).
- Missing/empty `sender.url`.
- Malformed `sender.url` (URL parser throws).
- Any extension-page URL (`chrome-extension://…/popup.html`, etc.) — there is no approved extension-page use case for `ccp.ai.openOptions` in U11.

This is a **separate** authorization surface from `canManageSecrets` used by `setSessionKey`/`clearKey`/`setAccessMode`. Those remain strictly `options.html`-only. The Coursera origin allowed here cannot manipulate keys or access mode through this command — it only navigates to the options page.

- [ ] **Step 1: Create the test file**

Create `tests/ai-open-options-background.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenOptionsHandler, isCourseraSender } = require('../lib/ai-open-options-background.js');

// ---------- Non-routing & opener-adapter behavior (with permissive auth) ----------

test('U11-1: non-openOptions messages return false and do not invoke openOptionsPage', () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; if (cb) cb(null); },
    canOpenOptions: function () { return true; },
  });
  let responded = false;
  const ret = handler({ type: 'autopilot.state' }, {}, function () { responded = true; });
  assert.equal(ret, false);
  assert.equal(opened, 0);
  assert.equal(responded, false);
});

test('U11-1: ccp.ai.openOptions invokes openOptionsPage exactly once and responds {ok:true}', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: function () { return true; },
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, {}, resolve);
  });
  assert.equal(opened, 1);
  assert.deepEqual(res, { ok: true });
});

test('U11-1: openOptionsPage error responds {ok:false, reason:"open-options-failed"}', async () => {
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { cb(new Error('cannot open')); },
    canOpenOptions: function () { return true; },
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, {}, resolve);
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'open-options-failed');
});

test('U11-1: thrown error inside openOptionsPage responds {ok:false, reason:"open-options-failed"}', async () => {
  const handler = createOpenOptionsHandler({
    openOptionsPage: function () { throw new Error('boom'); },
    canOpenOptions: function () { return true; },
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, {}, resolve);
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'open-options-failed');
});

test('U11-1: response contains no key, balance, account, token, or credit', async () => {
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { cb(null); },
    canOpenOptions: function () { return true; },
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, {}, resolve);
  });
  const s = JSON.stringify(res).toLowerCase();
  ['sk-', 'balance', 'account', 'token', 'credit', 'key'].forEach(function (forbidden) {
    assert.equal(s.indexOf(forbidden), -1, 'forbidden substring in response: ' + forbidden);
  });
});

test('U11-1: handler returns true on the openOptions branch (keeps async response channel open)', () => {
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { setTimeout(function () { cb(null); }, 0); },
    canOpenOptions: function () { return true; },
  });
  const ret = handler({ type: 'ccp.ai.openOptions' }, {}, function () {});
  assert.equal(ret, true);
});

test('U11-1: missing openOptionsPage dep responds {ok:false, reason:"open-options-failed"} without throwing', async () => {
  const handler = createOpenOptionsHandler({ canOpenOptions: function () { return true; } });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, {}, resolve);
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'open-options-failed');
});

// ---------- Sender authorization (default deny + production Coursera predicate) ----------

test('U11-1: AUTH — default canOpenOptions is deny-all (no dep injected ⇒ forbidden-sender)', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    // canOpenOptions intentionally omitted
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'https://www.coursera.org/learn/x' }, resolve);
  });
  assert.equal(opened, 0, 'opener must NOT be invoked when no predicate is injected');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — approved Coursera sender (https://www.coursera.org/...) invokes opener exactly once', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { tab: { id: 1 }, url: 'https://www.coursera.org/learn/wireless-communications/assignment-submission/fryRH/practice-quiz' }, resolve);
  });
  assert.equal(opened, 1);
  assert.deepEqual(res, { ok: true });
});

test('U11-1: AUTH — bare https://coursera.org/ (no subdomain) is approved', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'https://coursera.org/learn/x' }, resolve);
  });
  assert.equal(opened, 1);
  assert.equal(res.ok, true);
});

test('U11-1: AUTH — Coursera subdomain (https://es.coursera.org/...) is approved', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'https://es.coursera.org/learn/x' }, resolve);
  });
  assert.equal(opened, 1);
  assert.equal(res.ok, true);
});

test('U11-1: AUTH — unrelated web origin (https://evil.example.com) is REFUSED — opener invoked zero times', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'https://evil.example.com/' }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — lookalike host (https://evilcoursera.org) is REFUSED', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'https://evilcoursera.org/' }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — suffix-style lookalike (https://www.coursera.org.evil.com) is REFUSED', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'https://www.coursera.org.evil.com/' }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — http (not https) Coursera URL is REFUSED', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'http://www.coursera.org/' }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — missing sender.url is REFUSED (no error)', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { tab: { id: 1 } }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — empty sender.url is REFUSED', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: '' }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — malformed sender.url is REFUSED without throwing', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'not a url' }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — missing sender object is REFUSED', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, null, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — unrelated extension page (chrome-extension://EXT/popup.html) is REFUSED — no documented use case', async () => {
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'chrome-extension://EXT/popup.html' }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — options.html itself cannot use this navigation command (it is already open if it asks)', async () => {
  // Sanity: an options-page sender ALSO does not get to invoke openOptions.
  // This is desirable: opening options from options.html is meaningless and
  // is not an approved use case.
  let opened = 0;
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { opened++; cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'chrome-extension://EXT/options.html' }, resolve);
  });
  assert.equal(opened, 0);
  assert.equal(res.reason, 'forbidden-sender');
});

test('U11-1: AUTH — rejected response contains NO secret-like data', async () => {
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { cb(null); },
    canOpenOptions: isCourseraSender,
  });
  const res = await new Promise(function (resolve) {
    handler({ type: 'ccp.ai.openOptions' }, { url: 'https://evil.example.com/' }, resolve);
  });
  const s = JSON.stringify(res).toLowerCase();
  ['sk-', 'balance', 'account', 'token', 'credit', 'key', 'session', 'auth', 'password'].forEach(function (forbidden) {
    assert.equal(s.indexOf(forbidden), -1, 'forbidden substring in rejected response: ' + forbidden);
  });
});

test('U11-1: AUTH — handler returns false on the forbidden-sender branch (synchronous response)', () => {
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { cb(null); },
    canOpenOptions: function () { return false; },
  });
  const ret = handler({ type: 'ccp.ai.openOptions' }, { url: 'https://evil.example.com/' }, function () {});
  // The reject path responds synchronously — return false (no async channel needed).
  assert.equal(ret, false);
});

// ---------- isCourseraSender unit tests ----------

test('U11-1: isCourseraSender — accepts https://www.coursera.org/...', () => {
  assert.equal(isCourseraSender({ url: 'https://www.coursera.org/learn/x' }), true);
});

test('U11-1: isCourseraSender — accepts https://coursera.org/...', () => {
  assert.equal(isCourseraSender({ url: 'https://coursera.org/learn/x' }), true);
});

test('U11-1: isCourseraSender — accepts any https subdomain (es., zh., dev.)', () => {
  assert.equal(isCourseraSender({ url: 'https://es.coursera.org/learn/x' }), true);
  assert.equal(isCourseraSender({ url: 'https://zh.coursera.org/' }), true);
});

test('U11-1: isCourseraSender — rejects http scheme', () => {
  assert.equal(isCourseraSender({ url: 'http://www.coursera.org/' }), false);
});

test('U11-1: isCourseraSender — rejects evilcoursera.org', () => {
  assert.equal(isCourseraSender({ url: 'https://evilcoursera.org/' }), false);
});

test('U11-1: isCourseraSender — rejects www.coursera.org.evil.com', () => {
  assert.equal(isCourseraSender({ url: 'https://www.coursera.org.evil.com/' }), false);
});

test('U11-1: isCourseraSender — rejects empty/missing/null/malformed url', () => {
  assert.equal(isCourseraSender({}), false);
  assert.equal(isCourseraSender({ url: '' }), false);
  assert.equal(isCourseraSender({ url: null }), false);
  assert.equal(isCourseraSender({ url: 'not a url' }), false);
  assert.equal(isCourseraSender(null), false);
  assert.equal(isCourseraSender(undefined), false);
});

test('U11-1: isCourseraSender — rejects any chrome-extension:// URL', () => {
  assert.equal(isCourseraSender({ url: 'chrome-extension://EXT/popup.html' }), false);
  assert.equal(isCourseraSender({ url: 'chrome-extension://EXT/options.html' }), false);
  assert.equal(isCourseraSender({ url: 'chrome-extension://EXT/devtools.html' }), false);
});

// ---------- Separation from secret-management authorization ----------

test('U11-1: SEPARATION — the openOptions authorization is independent of canManageSecrets (no cross-contamination)', () => {
  // This is a structural check: the createOpenOptionsHandler factory does NOT
  // accept a canManageSecrets dep, nor should it read or alter secret-management
  // state. Verify by inspecting the factory's accepted shape.
  const handler = createOpenOptionsHandler({
    openOptionsPage: function (cb) { cb(null); },
    canOpenOptions: isCourseraSender,
    canManageSecrets: function () { return true; },  // should be ignored / no effect
  });
  // If the implementation accidentally promoted Coursera senders to secret-management
  // privileges, that would show up elsewhere (in ai-background-service tests). Here we
  // simply confirm the factory still constructs cleanly when given an unknown extra dep.
  assert.equal(typeof handler, 'function');
});
```

- [ ] **Step 2: Run and verify FAIL**

Run: `node --test tests/ai-open-options-background.test.js`
Expected: all tests FAIL — `lib/ai-open-options-background.js` does not exist.

- [ ] **Step 3: Sanity check — existing secret-management auth tests must remain unaffected**

Run: `node --test tests/ai-background-service.test.js`
Expected: every test PASSES — `setSessionKey` / `clearKey` / `setAccessMode` auth tests stay green. (No code change yet — this run is a baseline. After Task 12 + Task 13 land, re-run to confirm still green in Task 15.)

---

## Task 12: GREEN — implement `lib/ai-open-options-background.js` (auth predicate + opener)

**Files:**
- Create: `lib/ai-open-options-background.js`

- [ ] **Step 1: Create the module**

Create `lib/ai-open-options-background.js`:

```js
'use strict';
// lib/ai-open-options-background.js
// U11 Issue 1 — tiny tested handler that opens the extension options page
// from the MV3 service-worker context in response to a sanitized runtime
// message ({type:'ccp.ai.openOptions'}). The handler:
//  - only responds to the openOptions message type
//  - enforces a two-stage gate: (1) canOpenOptions(sender) authorization,
//    (2) injected openOptionsPage(cb) adapter
//  - responds {ok:true} on success, {ok:false, reason:'forbidden-sender'} on
//    auth failure, {ok:false, reason:'open-options-failed'} on adapter failure
//  - never reads or returns any key/balance/account/token/credit
//  - is SEPARATE from secret-management authorization (canManageSecrets used by
//    setSessionKey/clearKey/setAccessMode in ai-background-service.js) — this
//    factory does not accept that dep and cannot grant secret-management
//    privileges to the Coursera origin allowed here
//  - default canOpenOptions is deny-all (fail-closed): callers must inject the
//    appropriate predicate explicitly

(function (root) {
  'use strict';

  // Production predicate exported alongside the factory. Allows ONLY:
  //   - https://coursera.org/...
  //   - https://<any-subdomain>.coursera.org/...
  // Rejects: non-https, lookalike hosts, unrelated origins, extension pages,
  // missing/malformed URLs.
  function isCourseraSender(sender) {
    if (!sender || typeof sender.url !== 'string' || sender.url.length === 0) return false;
    var u;
    try { u = new URL(sender.url); } catch (_) { return false; }
    if (u.protocol !== 'https:') return false;
    var host = u.hostname;
    return host === 'coursera.org' || (host.length > '.coursera.org'.length && host.endsWith('.coursera.org'));
  }

  function defaultDenyAll() { return false; }

  function createOpenOptionsHandler(deps) {
    var openOptionsPage = (deps && typeof deps.openOptionsPage === 'function') ? deps.openOptionsPage : null;
    var canOpenOptions = (deps && typeof deps.canOpenOptions === 'function') ? deps.canOpenOptions : defaultDenyAll;
    return function handleMessage(msg, sender, sendResponse) {
      if (!msg || msg.type !== 'ccp.ai.openOptions') return false;
      // Stage 1: sender authorization. Fail-closed.
      if (!canOpenOptions(sender)) {
        sendResponse({ ok: false, reason: 'forbidden-sender' });
        return false;
      }
      // Stage 2: opener invocation.
      if (!openOptionsPage) {
        sendResponse({ ok: false, reason: 'open-options-failed' });
        return false;
      }
      try {
        openOptionsPage(function (err) {
          if (err) sendResponse({ ok: false, reason: 'open-options-failed' });
          else sendResponse({ ok: true });
        });
        return true;
      } catch (_) {
        sendResponse({ ok: false, reason: 'open-options-failed' });
        return false;
      }
    };
  }

  var api = {
    createOpenOptionsHandler: createOpenOptionsHandler,
    isCourseraSender: isCourseraSender,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.ClipboardCleaner = root.ClipboardCleaner || {}; root.ClipboardCleaner.aiOpenOptionsBackground = api; }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 2: Run the test file**

Run: `node --test tests/ai-open-options-background.test.js`
Expected: all ~30 tests PASS (the routing/opener tests + the authorization tests + the isCourseraSender unit tests + the separation sanity test).

- [ ] **Step 3: Confirm existing secret-management auth tests are unchanged in meaning**

Run: `node --test tests/ai-background-service.test.js`
Expected: all PASS — `setSessionKey` / `clearKey` / `setAccessMode` auth tests stay green; this module did not touch those paths.

---

## Task 13: GREEN — wire the handler into `background.js`

**Files:**
- Modify: `background.js`

- [ ] **Step 1: Add the importScripts and the listener IIFE**

Open `background.js`. At the top, the file already calls `importScripts(...)`. Add `'lib/ai-open-options-background.js'` to that list. The full block becomes:

```js
importScripts(
  'lib/autopilot-state.js',
  'lib/autopilot-authority.js',
  'lib/deepseek-client.js',
  'lib/ai-background-service.js',
  'lib/managed-client.js',
  'lib/ai-open-options-background.js'
);
```

Then, at the bottom of `background.js` (after the existing IIFE that wires the AI service), add a new IIFE that **injects the production `isCourseraSender` predicate** alongside the opener adapter:

```js
// === U11 Issue 1 — open-options navigation listener ===
// Sanitized navigation: handles ONLY {type:'ccp.ai.openOptions'}.
// Authorization is gated by the exported isCourseraSender predicate from
// lib/ai-open-options-background.js, which allows ONLY https://coursera.org/...
// and https://*.coursera.org/...; everything else is rejected with
// {ok:false, reason:'forbidden-sender'} and the opener is NOT invoked.
// This authorization surface is SEPARATE from the canManageSecrets gate that
// protects setSessionKey/clearKey/setAccessMode — granting Coursera origin
// the ability to request settings navigation does NOT grant it any
// secret-management privileges. No keys, no balance, no broadcast.
(function () {
  'use strict';
  if (!chrome || !chrome.runtime || !chrome.runtime.onMessage) return;
  const mod = self.ClipboardCleaner && self.ClipboardCleaner.aiOpenOptionsBackground;
  if (!mod) return;
  function openOptionsPageAdapter(cb) {
    try {
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage(function () {
          var err = chrome.runtime && chrome.runtime.lastError;
          cb(err ? err : null);
        });
      } else {
        cb(new Error('openOptionsPage-unavailable'));
      }
    } catch (e) {
      cb(e);
    }
  }
  const handler = mod.createOpenOptionsHandler({
    openOptionsPage: openOptionsPageAdapter,
    canOpenOptions: mod.isCourseraSender,
  });
  chrome.runtime.onMessage.addListener(handler);
})();
```

- [ ] **Step 2: Verify no other background changes**

Grep `background.js` for `ccp.ai.openOptions`. Expected: at least one match (the comment in the new IIFE). The actual message-type string `'ccp.ai.openOptions'` does NOT appear in production background.js code — that string lives inside the helper module's `handleMessage` early-exit check. The grep result of 0 production matches and 1+ comment matches is correct.

Grep `background.js` for `chrome.runtime.openOptionsPage`. Expected: exactly ONE match — the call inside the `openOptionsPageAdapter`. This is the only authorized production invocation of that API.

Confirm no edits to: existing autopilot listener, existing AI service listener, `lib/ai-background-service.js`'s `canManageSecrets` injection in the AI service IIFE.

- [ ] **Step 3: Run the production-source regression tests added in Task 8 Step 4**

Run: `node --test --test-name-pattern="U11-1: only background.js" tests/ai-open-options-content.test.js`
Expected: PASS — `background.js` contains the one authorized `chrome.runtime.openOptionsPage` invocation and no other production file does.

---

## Task 14: Blocked-page controller/sidebar integration regression (REAL integration, not message-helper)

**Files:**
- Test: `tests/ai-answer-controller.test.js` (append)

Pure message-helper tests cannot prove the actual sidebar/controller eligibility behavior. This task constructs a blocked `/assignment-submission/` location, drives it through the real production controller path with its `questionContext`/`sidebar`/`messenger`/`answerApplier` deps stubbed at the seam, and verifies the full end-to-end contract:
- sidebar reports the blocked state
- `Manage AI API Key` produces exactly one sanitized `ccp.ai.openOptions` request
- `Generate` remains disabled / refuses without sending `generateAnswers`
- `Apply` remains disabled / refuses without calling `answerApplier.applyStructuredAnswers`
- No `submit` / `continue` / `check` action is invoked through the messenger

- [ ] **Step 1: Append the integration test block**

Append to `tests/ai-answer-controller.test.js`:

```js
// === U11 — blocked-page integration: settings open works; Generate/Apply stay refused ===

// Test helper: a fake sidebar that captures handlers, eligibility, suggestions,
// apply-results, and any open-options failure messages. If the existing test
// file already has a `makeFakeSidebar()` with similar shape, reuse it and add
// only the missing slots; do NOT shadow the existing helper.
function makeBlockedPageFakeSidebar() {
  let handlers = {};
  let lastEligibility = null;
  let lastApplyResult = null;
  let lastInFlight = null;
  let lastSuggestions = undefined;
  let lastOpenOptionsFailure = undefined;
  let lastKeyStatus = null;
  let lastAccessMode = null;
  return {
    setAiAnswerHandlers: function (h) { handlers = h || {}; },
    setAiPageEligibility:  function (e) { lastEligibility = e; },
    setAiApplyResult:       function (r) { lastApplyResult = r; },
    setAiInFlight:          function (v) { lastInFlight = v; },
    setAiSuggestions:       function (s) { lastSuggestions = s; },
    setAiScanResult:        function (_s) { /* not asserted here */ },
    setAiOpenOptionsFailure: function (t) { lastOpenOptionsFailure = t; },
    setAiKeyStatus:         function (k) { lastKeyStatus = k; },
    setAiAccessMode:        function (m) { lastAccessMode = m; },
    _getHandlers:           function () { return handlers; },
    _getLastEligibility:    function () { return lastEligibility; },
    _getLastApplyResult:    function () { return lastApplyResult; },
    _getLastSuggestions:    function () { return lastSuggestions; },
    _getLastOpenOptionsFailure: function () { return lastOpenOptionsFailure; },
  };
}

test('U11-1 INTEGRATION: blocked /assignment-submission/ page — Manage AI API Key opens settings; Generate and Apply refuse without sending generateAnswers or applying', () => {
  const blockedLoc = {
    href: 'https://www.coursera.org/learn/wireless-communications/assignment-submission/fryRH/practice-quiz',
    pathname: '/learn/wireless-communications/assignment-submission/fryRH/practice-quiz',
  };

  // Production-shaped question-context stub: reports blocked.
  let buildCalls = 0;
  const qc = {
    buildQuestionSnapshot: function (_body, _loc) {
      buildCalls++;
      return {
        page: { eligible: false, blockedReason: 'assignment-submission' },
        questions: [],
        supportedCount: 0,
        actionableCount: 0,
        token: 't-blocked-' + buildCalls,
      };
    },
    sanitizeForRequest: function (s) { return s; },
    isCurrentPageBlocked: function (_loc, _doc) { return { blocked: true, reason: 'assignment-submission' }; },
    compareLocalGuards: function () { return { changed: false }; },
  };

  // Capture every messenger command so we can verify generateAnswers never goes out.
  const sentCommands = [];
  const messenger = {
    send: function (cmd, params, cb) {
      sentCommands.push({ cmd: cmd, params: params });
      if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: true, remembered: true, accessMode: 'personal-key' });
      cb({ ok: true });
    },
  };

  // answerApplier.applyStructuredAnswers MUST NOT be called on a blocked page.
  let applyCalls = 0;
  const answerApplier = {
    applyStructuredAnswers: function () {
      applyCalls++;
      throw new Error('answerApplier.applyStructuredAnswers MUST NOT be called on a blocked page');
    },
  };

  // Validator: would succeed if reached; we expect it NOT to be reached for generate.
  let validateCalls = 0;
  const validator = {
    validateAndMap: function () { validateCalls++; return { ok: true, suggestions: [] }; },
  };

  // openOptionsFn: capture the sanitized message and the callback contract.
  let openOptionsCalls = 0;
  let openOptionsArgType = null;
  const openOptionsFn = function (cb) {
    openOptionsCalls++;
    openOptionsArgType = typeof cb;
    if (typeof cb === 'function') cb({ ok: true });
  };

  const fakeSidebar = makeBlockedPageFakeSidebar();
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: qc,
    validator: validator,
    answerApplier: answerApplier,
    messenger: messenger,
    document: { body: {}, querySelector: function () { return null; } },
    location: blockedLoc,
    openOptionsFn: openOptionsFn,
  });

  // ----- Wire -----
  ctrl.wire();

  // 1. Sidebar must report the blocked state on initial wire.
  const elig = fakeSidebar._getLastEligibility();
  assert.ok(elig, 'sidebar must have received an eligibility call during wire()');
  assert.equal(elig.eligible, false, 'eligibility.eligible must be false on a blocked page');
  assert.equal(elig.blockedReason, 'assignment-submission');

  // 2. Click "Manage AI API Key" — exactly one sanitized openOptions request.
  fakeSidebar._getHandlers().onOpenOptions();
  assert.equal(openOptionsCalls, 1, 'exactly one open-options invocation');
  assert.equal(openOptionsArgType, 'function', 'controller must pass a result callback to openOptionsFn');
  // Success-path: sidebar receives empty-string failure clear.
  assert.equal(fakeSidebar._getLastOpenOptionsFailure(), '',
    'on {ok:true} the sidebar receives an empty-string failure clear');
  // No secret-related cmd was sent via the messenger as part of opening settings.
  const cmdsAfterOpen = sentCommands.map(function (c) { return c.cmd; });
  assert.equal(cmdsAfterOpen.indexOf('setSessionKey'), -1);
  assert.equal(cmdsAfterOpen.indexOf('clearKey'), -1);
  assert.equal(cmdsAfterOpen.indexOf('setAccessMode'), -1);

  // 3. performScan to populate _activeSnapshot (necessary precondition for performGenerate's
  // own guard to even run the fresh-snapshot check).
  ctrl.performScan();

  // 4. performGenerate must NOT send generateAnswers because page eligibility is false.
  ctrl.performGenerate();
  const generateCalls = sentCommands.filter(function (c) { return c.cmd === 'generateAnswers'; });
  assert.equal(generateCalls.length, 0,
    'generateAnswers MUST NOT be sent on a blocked /assignment-submission/ page');

  // 5. Sidebar should have received a blocked-page apply-result message from performGenerate.
  const ar = fakeSidebar._getLastApplyResult();
  assert.ok(ar && typeof ar === 'object', 'sidebar must receive an apply-result on the blocked Generate');
  assert.equal(ar.filled, 0);
  assert.equal(ar.failed, 0);
  // Message must communicate the blocked state to the user.
  assert.ok(/disabled on graded or blocked assessment pages/i.test(ar.message || ''),
    'apply-result message must reference blocked-page refusal');

  // 6. performApply must refuse — answerApplier.applyStructuredAnswers must NOT be called.
  ctrl.performApply();
  assert.equal(applyCalls, 0,
    'answerApplier.applyStructuredAnswers MUST NOT be called on a blocked page (it would throw)');

  // 7. No submit/continue/check command was ever invoked via the messenger.
  const allCmdNames = sentCommands.map(function (c) { return c.cmd; });
  ['submit', 'submitAnswer', 'continue', 'check', 'apply', 'autoAdvance'].forEach(function (forbidden) {
    assert.equal(allCmdNames.indexOf(forbidden), -1,
      'forbidden messenger command on a blocked page: ' + forbidden);
  });

  // 8. validateAndMap was NOT reached (because generate refused before request).
  assert.equal(validateCalls, 0, 'validator must not run when generate refuses on a blocked page');
});

test('U11-1 INTEGRATION: blocked page — clicking Manage AI API Key TWICE produces TWO sanitized openOptions requests with no other side effects', () => {
  const blockedLoc = {
    href: 'https://www.coursera.org/learn/x/assignment-submission/abc/quiz',
    pathname: '/learn/x/assignment-submission/abc/quiz',
  };
  const qc = {
    buildQuestionSnapshot: function () { return { page: { eligible: false, blockedReason: 'assignment-submission' }, questions: [], supportedCount: 0, actionableCount: 0, token: 't' }; },
    sanitizeForRequest: function (s) { return s; },
    isCurrentPageBlocked: function () { return { blocked: true, reason: 'assignment-submission' }; },
    compareLocalGuards: function () { return { changed: false }; },
  };
  const sentCommands = [];
  const messenger = { send: function (cmd, p, cb) { sentCommands.push({ cmd: cmd, params: p }); if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: false, accessMode: 'personal-key' }); cb({ ok: true }); } };
  let openCount = 0;
  const fakeSidebar = makeBlockedPageFakeSidebar();
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: qc,
    validator: { validateAndMap: function () { return { ok: true, suggestions: [] }; } },
    answerApplier: { applyStructuredAnswers: function () { throw new Error('must not apply'); } },
    messenger: messenger,
    document: { body: {}, querySelector: function () { return null; } },
    location: blockedLoc,
    openOptionsFn: function (cb) { openCount++; if (cb) cb({ ok: true }); },
  });
  ctrl.wire();
  fakeSidebar._getHandlers().onOpenOptions();
  fakeSidebar._getHandlers().onOpenOptions();
  assert.equal(openCount, 2, 'two clicks → two openOptions invocations');
  const generateCalls = sentCommands.filter(function (c) { return c.cmd === 'generateAnswers'; });
  assert.equal(generateCalls.length, 0, 'no generateAnswers from settings-only clicks');
});

// === U11 — pure-helper sanity (kept for fast-path regression) ===

test('U11-1: open-options message helper sends EXACTLY {type:"ccp.ai.openOptions"} with no extra fields', async () => {
  // Pure helper-level sanity: the message shape is fixed regardless of caller.
  const rt = (function () {
    const sent = [];
    return {
      sent: sent,
      sendMessage: function (msg, cb) { sent.push(msg); if (cb) cb({ ok: true }); },
    };
  })();
  const fn = createOpenOptionsCallback({ runtime: rt });
  const got = await new Promise(function (r) { fn(r); });
  assert.deepEqual(got, { ok: true });
  assert.equal(rt.sent.length, 1);
  assert.deepEqual(rt.sent[0], { type: 'ccp.ai.openOptions' });
  assert.deepEqual(Object.keys(rt.sent[0]), ['type'], 'message must have exactly one field: "type"');
});

test('U11-1: open-options request payload contains no generation/application/submission intent', () => {
  const rt = (function () {
    const sent = [];
    return { sent: sent, sendMessage: function (msg, cb) { sent.push(msg); if (cb) cb({ ok: true }); } };
  })();
  const fn = createOpenOptionsCallback({ runtime: rt });
  fn(function () {});
  const payload = JSON.stringify(rt.sent[0]).toLowerCase();
  ['generate', 'apply', 'submit', 'snapshot', 'continue', 'check', 'autoadvance'].forEach(function (f) {
    assert.equal(payload.indexOf(f), -1, 'open-options must not carry: ' + f);
  });
});
```

**Important fixture-extension note:** the integration tests above require `createAiController` to be importable in `tests/ai-answer-controller.test.js`. If the existing test file already imports it, reuse the existing import. If `makeFakeSidebar()` (the existing fixture from Task 9) does not expose the slots needed by these integration tests, the implementer should either (a) extend that helper in-place with backward-compatible getters, or (b) define `makeBlockedPageFakeSidebar()` as shown — do NOT shadow the existing fixture name. The two helpers may coexist.

The pure-helper sanity tests at the bottom (`open-options message helper sends EXACTLY...` and `open-options request payload contains no generation...`) require `createOpenOptionsCallback` from `lib/ai-open-options-content.js`. If `tests/ai-answer-controller.test.js` does not already import it, add at the top of the file:

```js
const { createOpenOptionsCallback } = require('../lib/ai-open-options-content.js');
```

- [ ] **Step 2: Run the integration tests**

Run: `node --test --test-name-pattern="U11-1 INTEGRATION|U11-1: open-options message helper|U11-1: open-options request payload" tests/ai-answer-controller.test.js`
Expected: all PASS after the controller/sidebar GREEN edits from Tasks 5, 7, 10. If they fail with `applyStructuredAnswers MUST NOT be called` it means the blocked-page guard in `performApply` is broken — investigate before proceeding.

- [ ] **Step 3: Confirm existing blocked-page tests in this file remain green**

Run: `node --test tests/ai-answer-controller.test.js`
Expected: every test PASSES (including any pre-existing blocked-page assertions plus the new U11 integration tests).

---

## Task 15: Final verification

**Files:** (verification only — no edits)

- [ ] **Step 1: Record a baseline of files to be touched by U11**

Capture mtimes / snapshots before/after where needed (the same `.u10-baseline-snapshots/` mechanism may be reused for files this pass touches, or a new `.u11-baseline-snapshots/` directory may be created). Required pre-snapshot list:
- `lib/sidebar.js`, `lib/sidebar.css`, `lib/ai-answer-controller.js`, `content.js`, `background.js`, `manifest.json`
- `tests/sidebar.test.js`, `tests/ai-answer-controller.test.js`

The new files (no baseline needed): `lib/ai-open-options-content.js`, `lib/ai-open-options-background.js`, `tests/ai-open-options-content.test.js`, `tests/ai-open-options-background.test.js`.

- [ ] **Step 2: Focused U11 + AI/sidebar/content/background test suite**

Run:

```
node --test tests/sidebar.test.js tests/ai-answer-controller.test.js tests/ai-options-controller.test.js tests/ai-background-service.test.js tests/ai-content-listeners.test.js tests/ai-open-options-content.test.js tests/ai-open-options-background.test.js
```

Expected: every test PASSES.

- [ ] **Step 3: Full repo test suite**

Run: `npm test`
Expected: every test PASSES.

- [ ] **Step 4: Autopilot regression**

Run:

```
node --test tests/autopilot-state.test.js tests/autopilot-timing.test.js tests/autopilot-input-guard.test.js tests/autopilot-authority.test.js tests/autopilot-debug.test.js tests/completion-confirmer.test.js tests/item-handlers.test.js tests/module-autopilot.test.js tests/module-scraper.test.js
```

Expected: every test PASSES.

- [ ] **Step 5: Repo-wide real-key leak scan**

PowerShell:

```powershell
Get-ChildItem -Recurse -File -Exclude *.log,package-lock.json |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\\.git\\' -and $_.FullName -notmatch '\\\.u10-baseline-snapshots\\' -and $_.FullName -notmatch '\\\.u11-baseline-snapshots\\' } |
  Select-String -Pattern 'sk-[A-Za-z0-9_]{16,}' -SimpleMatch:$false
```

Expected: zero matches.

- [ ] **Step 6: Provider-neutrality grep on public UI files**

PowerShell:

```powershell
Select-String -Path 'options.html','lib\sidebar.js','lib\ai-options-controller.js','lib\ai-answer-controller.js','lib\ai-content-listeners.js','lib\ai-open-options-content.js','lib\ai-open-options-background.js' -Pattern 'DeepSeek','OpenAI','Anthropic','Claude','GPT-' -SimpleMatch
```

Expected: zero matches.

- [ ] **Step 7: Sidebar / content secret-control leak grep**

Grep `lib/sidebar.js` and `content.js` for: `ai-options-key`, `ai-options-save`, `ai-options-clear`, `ai-options-toggle`, `ai-options-remember`.
Expected: zero matches.

- [ ] **Step 8: Autopilot-untouched check**

Compare current Autopilot files against baseline mtimes (Autopilot mtimes should be older than the U11 session start). Confirm no edits to:
- `lib/autopilot-*.js`, `lib/module-*.js`, `lib/item-handlers.js`, `lib/completion-confirmer.js`
- corresponding test files

- [ ] **Step 9: U11 file-attribution check**

Confirm the file list attributable to U11 is EXACTLY:
- Modified: `content.js`, `background.js`, `manifest.json`, `lib/sidebar.js`, `lib/sidebar.css`, `lib/ai-answer-controller.js`, `tests/sidebar.test.js`, `tests/ai-answer-controller.test.js`
- Created: `lib/ai-open-options-content.js`, `lib/ai-open-options-background.js`, `tests/ai-open-options-content.test.js`, `tests/ai-open-options-background.test.js`, `docs/superpowers/plans/2026-05-27-u11-live-regression.md`

- [ ] **Step 10: HEAD unchanged**

Run: `git rev-parse HEAD`
Expected: identical to whatever HEAD was when U11 started (no commit made).

- [ ] **Step 11: Produce the final 11-point report**

Compose a final report explicitly answering all eleven of the user's required questions:

1. Why did clicking Manage AI API Key do nothing in the live browser?
2. Does production `content.js` now avoid direct use of `chrome.runtime.openOptionsPage()` for this action?
3. From which extension context is `chrome.runtime.openOptionsPage()` now called?
4. What exact sanitized message does the content script send to open settings?
5. How is options-page opening failure displayed to the user?
6. What tests prove settings can open from a blocked page without enabling Generate or Apply?
7. Why did both AI access cards display simultaneously?
8. What exact CSS rule now guarantees that only the active card is visibly rendered?
9. What tests assert computed or rendered visibility rather than only hidden-property values?
10. Which exact files changed for U11?
11. Did any secret, paid-service implementation, provider behavior change, Autopilot modification, live generation test, or git mutation occur?

Do NOT enter any real API key during this verification step.

---

## Self-Review Notes

- **Spec coverage:** Issue 1 (inert button) → Tasks 6–13 + 14 (blocked-page); Issue 2 (card visibility) → Tasks 1–3; sidebar status surface → Tasks 4–5; controller wiring → Tasks 9–10; verification → Task 15.
- **Placeholder scan:** No `TBD`/`implement later`/`similar to Task N`. Every test has full code; every implementation has full code.
- **Type/symbol consistency:**
  - Message type `'ccp.ai.openOptions'` used identically in `lib/ai-open-options-content.js`, `lib/ai-open-options-background.js`, `content.js`, and `background.js`.
  - Failure response shape `{ ok: false, reason: 'open-options-failed' }` used identically in handler + tests + content-side `no-response`/`send-failed` variants.
  - Sidebar method name `setAiOpenOptionsFailure` used identically in `lib/sidebar.js`, `lib/ai-answer-controller.js`, and all relevant tests.
  - DOM selector `[data-role="ai-open-options-status"]` used identically in sidebar template and sidebar tests.
  - Module names `aiOpenOptionsContent` and `aiOpenOptionsBackground` consistent with the existing `aiContentListeners` naming convention.
- **Scope guard:** No Autopilot file, no `lib/deepseek-client.js`, no `lib/managed-client.js`, no options.html / options.js (the inert-button + card-visibility regressions live entirely in content/background/sidebar surfaces).
- **Safety constraints enforced:**
  - No real API key anywhere.
  - No commit / push / reset / clean / revert / checkout / amend / branch / worktree-cleanup steps in the plan.
  - No new permissions / host_permissions / CSP changes.
  - Strict authorization for `setSessionKey` / `clearKey` / `setAccessMode` remains untouched.
  - `openOptions` is acceptable from the Coursera content script (as the user permitted) and is verified by Task 11's content-script-sender test, but the secret-management commands remain strictly options-page only.
