# AI Access Stage 0 + Stage 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the build/version indicator (Stage 0) and the two-mode AI access scaffolding (Stage 2) per `docs/superpowers/specs/2026-05-27-ai-access-design.md`. Stage 2 adds an `aiAccessMode` setting, a mocked `managed-client.js` that returns `managed-not-implemented` without any network call, mode-aware routing in the background service, mode-aware sidebar rendering, and a two-section options page with a mode radio toggle.

**Architecture:** `chrome.storage.local["ccp.ai.accessMode"]` is the single source of truth for the access mode (defaults to `"personal-key"`). The background service reads it on every generate call and dispatches to either the existing `deepseekClient` (BYOK) or the new `managedClient` (mocked). The sidebar's AI Answers panel contains two sibling cards (`ai-card-key`, `ai-card-managed`); a new `setAiAccessMode(mode)` setter toggles which card is visible via the `hidden` attribute. The options page gets a radio toggle that persists the mode and renders both sections side-by-side.

**Tech Stack:** Plain ES5-ish JS in the existing UMD pattern, `chrome.storage.local` for mode persistence, Node `node:test` + jsdom (no new build tooling).

**Hard non-negotiables (from spec §8):**
- **NO real backend, NO payment processor, NO real managed-mode network request.** The Stage 2 managed-client is a mock that returns `{ ok:false, reason:'managed-not-implemented' }` without calling `fetch`.
- **NO bundled or built-in API key** anywhere in this extension package.
- **NO API-key input, Save, Clear, Show/hide, or Remember control** added to the Coursera-injected sidebar.
- **NO silent fallback** between modes. Managed mode never reads BYOK storage; BYOK mode never reads managed state.
- **NO auto-submit, NO weakening of blocked-page detection, NO change to Generate revalidation, local apply guard, per-tab cancellation, sender authorization, or sanitized payload boundary.**
- **NO real key, NO live Coursera testing, NO git mutation (no commit, push, reset, clean, revert, checkout, amend).**

---

## File footprint (this plan only)

### Files modified

| File | Stage | Why |
|---|---|---|
| `lib/sidebar.js` | 0 + 2 | Stage 0: build tag in Diagnostics header. Stage 2: add `ai-card-managed` card; export `setAiAccessMode`, `setAiManagedStatus`. |
| `lib/sidebar.css` | 2 | One additional rule for the `.ccp-ai-card--unavailable` style (subdued state for the Stage-2 unavailable managed card). |
| `lib/ai-options-controller.js` | 2 | Add mode radio + portal-link wiring. Persist `aiAccessMode` via injected storage. |
| `lib/ai-answer-controller.js` | 2 | Read `aiAccessMode` on wire; call `sidebar.setAiAccessMode`; refuse Generate honestly in managed mode (no messenger call). Accept new `openPortalFn` dep. |
| `lib/ai-background-service.js` | 2 | Accept new `accessModeProvider(cb)` dep. Route `generateAnswers` to `deepseekClient` or `managedClient` based on mode. Extend `keyStatus` to return `accessMode`. |
| `background.js` | 2 | Construct `managedClient` mock. Pass it + an `accessModeProvider` to the service. |
| `options.html` | 0 + 2 | Stage 0: build footer. Stage 2: radio toggle + Managed AI Credits section. |
| `content.js` | 2 | Pass `openPortalFn` to controller (Stage-2 mock: opens a placeholder `about:blank#ai-credits-portal-placeholder` and shows a console hint that the portal is unavailable). |
| `tests/sidebar.test.js` | 0 + 2 | Build-tag tests + mode-aware rendering tests. |
| `tests/ai-options-controller.test.js` | 0 + 2 | Build-footer tests + mode-radio persistence tests. |
| `tests/ai-answer-controller.test.js` | 2 | Mode-aware Generate refusal tests. |
| `tests/ai-background-service.test.js` | 2 | Mode-aware dispatch tests + `keyStatus.accessMode` tests. |

### Files created

| File | Purpose |
|---|---|
| `lib/managed-client.js` | Stage-2 mock. `createManagedClient({ fetchFn, backendBaseUrl, sessionTokenProvider, timeoutMs })` returns `{ generateAnswers(snapshot, sessionToken, opts) → Promise<{ok, raw, reason?}> }` that returns `{ ok:false, reason:'managed-not-implemented' }` synchronously without any fetch call. |
| `tests/managed-client.test.js` | RED tests for the mock contract. |

### Files explicitly forbidden in this plan

The following files must NOT be modified by this plan (anything else needs a separate plan/spec change):

- `lib/autopilot-state.js`
- `lib/autopilot-timing.js`
- `lib/autopilot-authority.js`
- `lib/autopilot-messenger.js`
- `lib/autopilot-debug.js`
- `lib/module-autopilot.js`
- `lib/completion-confirmer.js`
- `lib/item-handlers.js`
- `lib/module-scraper.js`
- `lib/ai-question-context.js`
- `lib/ai-answer-validator.js`
- `lib/deepseek-client.js`
- `manifest.json` (no new host_permissions in Stage 2 — backend URL is added in Stage 4)
- All `tests/autopilot-*.test.js`
- All `tests/module-*.test.js`
- `tests/completion-confirmer.test.js`
- `tests/item-handlers.test.js`
- `tests/deepseek-client.test.js`
- `tests/ai-question-context.test.js`
- `tests/ai-answer-validator.test.js`
- `tests/answer-applier.test.js`

### Test matrix (Stage 0 + Stage 2 only)

| Concern | Test file | New tests |
|---|---|---|
| Build tag in Diagnostics | `tests/sidebar.test.js` | 2 |
| Build footer in options page | `tests/ai-options-controller.test.js` | 1 |
| Manifest-version source (no hardcoded constant) | `tests/sidebar.test.js` | 1 |
| `setAiAccessMode("personal-key")` shows BYOK card, hides managed | `tests/sidebar.test.js` | 2 |
| `setAiAccessMode("managed-credits")` shows managed card, hides BYOK | `tests/sidebar.test.js` | 2 |
| `setAiManagedStatus(...)` renders the placeholder unavailable text | `tests/sidebar.test.js` | 2 |
| Managed card has no key input / save / clear / show / remember | `tests/sidebar.test.js` | 1 |
| Managed-client mock returns `managed-not-implemented` and does not call fetch | `tests/managed-client.test.js` | 3 |
| Background routes BYOK → deepseekClient, Managed → managedClient | `tests/ai-background-service.test.js` | 4 |
| Background `keyStatus` returns the access mode | `tests/ai-background-service.test.js` | 2 |
| Mode change persists across service reconstruction (storage-backed) | `tests/ai-background-service.test.js` | 1 |
| Managed mode `generateAnswers` never reads BYOK key storage | `tests/ai-background-service.test.js` | 1 |
| Options-page radio persists `aiAccessMode` | `tests/ai-options-controller.test.js` | 3 |
| Invalid/missing stored value normalizes to `personal-key` | `tests/ai-options-controller.test.js` | 1 |
| Options page Managed section shows portal link button | `tests/ai-options-controller.test.js` | 1 |
| Controller refuses Generate in managed mode without messenger call | `tests/ai-answer-controller.test.js` | 1 |
| Controller forwards mode to `setAiAccessMode` on wire | `tests/ai-answer-controller.test.js` | 1 |
| Controller `openPortalFn` invoked from sidebar handler | `tests/ai-answer-controller.test.js` | 1 |
| **Total new tests** | | **~27** |

---

## Stage 0 — Build/version indicator

### Task S0-1: Add `Build:` indicator to Diagnostics tab + options footer

**Files:**
- Modify: `lib/sidebar.js` lines 106-119 (Diagnostics panel) and the manifest-version read.
- Modify: `options.html` footer area.
- Test: `tests/sidebar.test.js`, `tests/ai-options-controller.test.js`.

The build text is derived at render time from `chrome.runtime.getManifest().version`. In jsdom tests where `chrome.runtime` is absent, we fall back to reading `manifest.json` from disk in the test setup, or the production code falls back to the empty string and renders just `Build: —` (a literal em-dash) so the element always exists. Tests assert the element exists and contains either the manifest version or the em-dash fallback — never a hardcoded version string.

- [ ] **Step 1: Write the failing tests in `tests/sidebar.test.js`**

```javascript
test('Stage 0: Diagnostics tab renders a Build indicator', () => {
  const { sidebar, shadow } = freshSidebar();
  const el = shadow.querySelector('[data-role="ccp-build"]');
  assert.ok(el, 'Diagnostics tab must contain [data-role="ccp-build"]');
  assert.ok(/^Build:\s+/.test(el.textContent), 'must start with "Build: "');
});

test('Stage 0: Build text does NOT contain a hardcoded version literal', () => {
  // Read sidebar.js source and assert it does not include a literal "Build: 1.0.0".
  // The version must come from chrome.runtime.getManifest() at render time, not from source.
  const fs = require('fs'); const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sidebar.js'), 'utf8');
  assert.equal(src.match(/Build:\s*\d+\.\d+\.\d+/), null, 'no hardcoded version literal in source');
});
```

- [ ] **Step 2: Write the failing test in `tests/ai-options-controller.test.js`**

```javascript
test('Stage 0: options.html contains a [data-role="ccp-build"] element in the footer', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/data-role="ccp-build"/.test(html), 'options.html must contain [data-role="ccp-build"]');
});
```

- [ ] **Step 3: Run tests to verify RED**

Run: `node --test tests/sidebar.test.js tests/ai-options-controller.test.js 2>&1 | grep -E "(fail|✖)"`
Expected: 3 failing tests (no `[data-role="ccp-build"]`, no `Build:` text, options.html has no marker).

- [ ] **Step 4: Implement Diagnostics build tag in `lib/sidebar.js`**

Find the Diagnostics panel block (lines 106-119). Add a build line at the top of the panel, right after the opening `<section>`:

```javascript
'<section class="ccp-panel" data-panel="diagnostics" data-active="false">' +
  '<div class="ccp-diag-build" data-role="ccp-build">Build: —</div>' +
  '<div class="ccp-diag-header">' +
```

Then find the `mount()` function. After `wireDiagnostics();`, add a call to a new `populateBuildTag()` function defined elsewhere in the file:

```javascript
function populateBuildTag() {
  if (!shadow) return;
  let version = '';
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
      const m = chrome.runtime.getManifest();
      if (m && typeof m.version === 'string') version = m.version;
    }
  } catch (_) { /* ignore — jsdom or restricted context */ }
  const text = 'Build: ' + (version || '—');
  shadow.querySelectorAll('[data-role="ccp-build"]').forEach(function (el) { el.textContent = text; });
}
```

Call `populateBuildTag();` at the end of `mount()`, after `wireDiagnostics();`. (Actually, append the call after the existing wire calls — order doesn't matter as long as `shadow` is set.)

Also append a CSS rule to `lib/sidebar.css`:

```css
.ccp-diag-build {
  font-size: 11px;
  color: var(--ccp-text-dim);
  margin-bottom: 6px;
  letter-spacing: 0.3px;
}
```

- [ ] **Step 5: Implement options-page footer build tag**

In `options.html`, find the `.footer` div near the bottom of the body. Replace its content:

```html
<div class="footer">
  Session-only keys live until the browser closes. Remembered keys persist on this device until you clear them here. The extension never logs or transmits the key beyond the AI service's API.
  <div data-role="ccp-build" style="margin-top:8px; font-size:11px; color:#888;">Build: —</div>
</div>
```

Then add a small inline `<script>` BEFORE the existing `<script src="lib/ai-options-controller.js">` line that populates the build text:

```html
<script>
  (function populateBuildTag() {
    var version = '';
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
        var m = chrome.runtime.getManifest();
        if (m && typeof m.version === 'string') version = m.version;
      }
    } catch (e) { /* ignore */ }
    var els = document.querySelectorAll('[data-role="ccp-build"]');
    for (var i = 0; i < els.length; i++) els[i].textContent = 'Build: ' + (version || '—');
  })();
</script>
```

(The options-page tests only check that the `[data-role="ccp-build"]` element exists in the HTML — they do not need to execute the script.)

- [ ] **Step 6: Run tests to verify GREEN**

Run: `node --test tests/sidebar.test.js tests/ai-options-controller.test.js`
Expected: all build-tag tests pass; existing tests still pass.

- [ ] **Step 7: Do NOT commit.**

### Task S0-2: Document manual reload verification

**Files:**
- No code changes. This is documentation only.

The reload procedure is documented in `docs/superpowers/specs/2026-05-27-ai-access-design.md` §1.2. No action needed here other than confirming the doc is current. Mark this task complete after Task S0-1.

---

## Stage 2 — Two-mode access scaffolding

### Task S2-1: `lib/managed-client.js` mock + tests (RED first)

**Files:**
- Create: `lib/managed-client.js`
- Create: `tests/managed-client.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/managed-client.test.js`:

```javascript
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createManagedClient } = require('../lib/managed-client.js');

test('Stage 2: createManagedClient returns an object with generateAnswers', () => {
  const c = createManagedClient({});
  assert.equal(typeof c.generateAnswers, 'function');
});

test('Stage 2: generateAnswers returns managed-not-implemented WITHOUT calling fetchFn', async () => {
  let called = false;
  const fetchFn = function () { called = true; throw new Error('must not be called'); };
  const c = createManagedClient({ fetchFn: fetchFn, backendBaseUrl: 'https://placeholder.invalid' });
  const r = await c.generateAnswers({ page: {}, questions: [], token: 't' }, 'session-token-stub', { signal: undefined });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'managed-not-implemented');
  assert.equal(called, false, 'fetchFn must NOT be invoked in Stage 2 mock');
});

test('Stage 2: returned response carries no key/credential/session-token fields', async () => {
  const c = createManagedClient({ backendBaseUrl: 'https://placeholder.invalid' });
  const r = await c.generateAnswers({}, 'sk-LEAK-DO-NOT-EXPOSE-1234567', {});
  assert.equal(JSON.stringify(r).indexOf('sk-LEAK-DO-NOT-EXPOSE'), -1);
  assert.equal(JSON.stringify(r).indexOf('session-token-stub'), -1);
});
```

- [ ] **Step 2: Run to verify RED**

Run: `node --test tests/managed-client.test.js`
Expected: 3 tests FAIL with `Cannot find module '../lib/managed-client.js'`.

- [ ] **Step 3: Implement `lib/managed-client.js`**

```javascript
'use strict';
// lib/managed-client.js
// Stage 2 mock: returns {ok:false, reason:'managed-not-implemented'} without
// performing any network request. Stage 3 will replace this body with real
// HTTPS calls to the managed backend; the same factory signature stays.
//
// Hard rule: this file must NEVER:
//   - read or store an upstream provider key
//   - send a real request anywhere in Stage 2
//   - return any session-token or credential material in its response

(function (root) {
  'use strict';

  function createManagedClient(opts) {
    opts = opts || {};
    // Accepted (but unused in the Stage 2 mock) so the Stage 3 swap-in keeps the same factory signature.
    // Reading them once defensively avoids "unused parameter" linter noise without affecting behavior.
    var _backendBaseUrl = opts.backendBaseUrl || null;
    var _timeoutMs = opts.timeoutMs || 30000;
    var _fetchFn = opts.fetchFn || null;
    var _sessionTokenProvider = opts.sessionTokenProvider || null;
    void _backendBaseUrl; void _timeoutMs; void _fetchFn; void _sessionTokenProvider;

    function generateAnswers(_snapshot, _sessionToken, _callOpts) {
      // Stage 2 mock: NO network call, NO snapshot inspection, NO credential echo.
      return Promise.resolve({ ok: false, reason: 'managed-not-implemented' });
    }

    return { generateAnswers: generateAnswers };
  }

  var api = { createManagedClient: createManagedClient };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.ClipboardCleaner = root.ClipboardCleaner || {}; root.ClipboardCleaner.managedClient = api; }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 4: Run tests to verify GREEN**

Run: `node --test tests/managed-client.test.js`
Expected: 3/3 pass.

- [ ] **Step 5: Do NOT commit.**

### Task S2-2: Background service mode-aware routing (RED first)

**Files:**
- Modify: `lib/ai-background-service.js`
- Modify: `background.js`
- Modify: `tests/ai-background-service.test.js`

`createAiBackgroundService` gains a new dep `managedClient` and a new dep `accessModeProvider(cb)` that asynchronously reports the current mode (default: read `chrome.storage.local["ccp.ai.accessMode"]`, fall back to `"personal-key"` if absent or invalid). The `generateAnswers` handler dispatches to either client based on mode. The `keyStatus` handler returns `accessMode` alongside existing fields.

- [ ] **Step 1: Write the failing tests in `tests/ai-background-service.test.js`**

```javascript
test('Stage 2: keyStatus includes accessMode (default personal-key)', async () => {
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    managedClient: { generateAnswers: function () { return Promise.resolve({ ok: false, reason: 'should-not-call' }); } },
    accessModeProvider: function (cb) { cb('personal-key'); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'keyStatus', {});
  assert.equal(res.ok, true);
  assert.equal(res.accessMode, 'personal-key');
});

test('Stage 2: keyStatus reports accessMode=managed-credits when set', async () => {
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    managedClient: { generateAnswers: function () { return Promise.resolve({ ok: false, reason: 'should-not-call' }); } },
    accessModeProvider: function (cb) { cb('managed-credits'); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'keyStatus', {});
  assert.equal(res.accessMode, 'managed-credits');
});

test('Stage 2: generateAnswers in personal-key mode calls deepseek client, NOT managed', async () => {
  let deepseekCalled = false;
  let managedCalled = false;
  const session = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-byok';
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () {
      return fakeClient(function () { deepseekCalled = true; return Promise.resolve({ ok: true, raw: { answers: [] } }); });
    },
    managedClient: { generateAnswers: function () { managedCalled = true; return Promise.resolve({ ok: false }); } },
    accessModeProvider: function (cb) { cb('personal-key'); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page:{}, questions: [], token:'t' } });
  assert.equal(res.ok, true);
  assert.equal(deepseekCalled, true);
  assert.equal(managedCalled, false);
});

test('Stage 2: generateAnswers in managed-credits mode calls managed client, NOT deepseek', async () => {
  let deepseekCalled = false;
  let managedCalled = false;
  const session = fakeStorage();
  session._store['ccp.ai.sessionKey'] = 'sk-byok-must-be-ignored';
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () {
      return fakeClient(function () { deepseekCalled = true; return Promise.resolve({ ok: true, raw: { answers: [] } }); });
    },
    managedClient: { generateAnswers: function () { managedCalled = true; return Promise.resolve({ ok: false, reason: 'managed-not-implemented' }); } },
    accessModeProvider: function (cb) { cb('managed-credits'); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page:{}, questions: [], token:'t' } });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'managed-not-implemented');
  assert.equal(deepseekCalled, false);
  assert.equal(managedCalled, true);
});

test('Stage 2: managed mode never reads BYOK session-key storage', async () => {
  const session = fakeStorage();
  let sessionGetCount = 0;
  const originalGet = session.get;
  session.get = function (keys, cb) {
    if ((Array.isArray(keys) ? keys : [keys]).indexOf('ccp.ai.sessionKey') !== -1) sessionGetCount++;
    originalGet.call(session, keys, cb);
  };
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    managedClient: { generateAnswers: function () { return Promise.resolve({ ok: false, reason: 'managed-not-implemented' }); } },
    accessModeProvider: function (cb) { cb('managed-credits'); },
  });
  await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: {} });
  assert.equal(sessionGetCount, 0, 'managed mode must not read BYOK key storage');
});

test('Stage 2: invalid accessMode value falls back to personal-key', async () => {
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    managedClient: { generateAnswers: function () { return Promise.resolve({ ok: false }); } },
    accessModeProvider: function (cb) { cb('garbage-value'); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'keyStatus', {});
  assert.equal(res.accessMode, 'personal-key');
});
```

- [ ] **Step 2: Run to verify RED**

Run: `node --test tests/ai-background-service.test.js`
Expected: 6 new tests FAIL (the service doesn't yet accept `managedClient` / `accessModeProvider` deps and does not return `accessMode`).

- [ ] **Step 3: Implement service changes in `lib/ai-background-service.js`**

Add at the top of `createAiBackgroundService`:

```javascript
var managedClient = deps.managedClient || null;
var accessModeProvider = (typeof deps.accessModeProvider === 'function')
  ? deps.accessModeProvider
  : function (cb) { cb('personal-key'); };

var VALID_MODES = { 'personal-key': true, 'managed-credits': true };
function readAccessMode(cb) {
  accessModeProvider(function (m) { cb(VALID_MODES[m] ? m : 'personal-key'); });
}
```

In the `keyStatus` handler, extend the `done()` function to also call `readAccessMode`:

```javascript
if (cmd === 'keyStatus') {
  var hasSession = false, hasLocal = false, mode = 'personal-key';
  function done() { sendResponse({ ok: true, keyPresent: !!(hasSession || hasLocal), remembered: !!hasLocal, accessMode: mode }); }
  function checkMode() { readAccessMode(function (m) { mode = m; done(); }); }
  function checkLocal() { storageLocal.get([LOCAL_KEY], function (g) { hasLocal = !!(g && g[LOCAL_KEY]); checkMode(); }); }
  if (storageSession) {
    storageSession.get([SESSION_KEY], function (g) { hasSession = !!(g && g[SESSION_KEY]); checkLocal(); });
  } else {
    checkLocal();
  }
  return true;
}
```

In the `generateAnswers` handler, branch by mode BEFORE any storage read:

```javascript
if (cmd === 'generateAnswers') {
  var k = tabKey(sender);
  readAccessMode(function (mode) {
    if (mode === 'managed-credits') {
      if (!managedClient || typeof managedClient.generateAnswers !== 'function') {
        sendResponse({ ok: false, reason: 'managed-not-implemented' });
        return;
      }
      var prior = state.byTab.get(k);
      if (prior) { try { prior.abort(); } catch (_) {} state.byTab.delete(k); }
      var mctrl = abortControllerFactory();
      state.byTab.set(k, mctrl);
      managedClient.generateAnswers(params.snapshot, null, { signal: mctrl.signal }).then(function (res) {
        if (state.byTab.get(k) === mctrl) state.byTab.delete(k);
        sendResponse(res);
      }, function (err) {
        if (state.byTab.get(k) === mctrl) state.byTab.delete(k);
        sendResponse({ ok: false, reason: 'network', detail: (err && err.message) ? String(err.message).slice(0, 80) : '' });
      });
      return;
    }
    // personal-key path: existing behavior unchanged.
    readKey(function (key) {
      if (!key) { sendResponse({ ok: false, reason: 'missing-key' }); return; }
      var prior2 = state.byTab.get(k);
      if (prior2) { try { prior2.abort(); } catch (_) {} state.byTab.delete(k); }
      var ctrl = abortControllerFactory();
      state.byTab.set(k, ctrl);
      client.generateAnswers(params.snapshot, key, { signal: ctrl.signal }).then(function (res) {
        if (state.byTab.get(k) === ctrl) state.byTab.delete(k);
        sendResponse(res);
      }, function (err) {
        if (state.byTab.get(k) === ctrl) state.byTab.delete(k);
        sendResponse({ ok: false, reason: 'network', detail: (err && err.message) ? String(err.message).slice(0, 80) : '' });
      });
    });
  });
  return true;
}
```

(The existing personal-key request flow is preserved exactly; the managed branch is parallel and never reads BYOK storage.)

- [ ] **Step 4: Wire production deps in `background.js`**

After the existing `importScripts(...)` call, append `'lib/managed-client.js'` to the list. After constructing `svc`, change the construction to pass the new deps:

```javascript
const managedMod = self.ClipboardCleaner && self.ClipboardCleaner.managedClient;

function readAccessModeFromStorage(cb) {
  try {
    chrome.storage.local.get(['ccp.ai.accessMode'], function (got) {
      cb((got && got['ccp.ai.accessMode']) || 'personal-key');
    });
  } catch (_) { cb('personal-key'); }
}

const svc = aiMod.createAiBackgroundService({
  storageSession: storageSession,
  storageLocal: storageLocal,
  clientFactory: function () { return deepseekMod.createClient({}); },
  managedClient: managedMod ? managedMod.createManagedClient({ backendBaseUrl: null }) : null,
  accessModeProvider: readAccessModeFromStorage,
  canManageSecrets: canManageSecretsStrict,
  broadcast: broadcastToTabs,
});
```

- [ ] **Step 5: Run tests to verify GREEN**

Run: `node --test tests/ai-background-service.test.js`
Expected: all (existing 53 + 6 new) tests pass.

- [ ] **Step 6: Do NOT commit.**

### Task S2-3: Sidebar dual-card layout + `setAiAccessMode` (RED first)

**Files:**
- Modify: `lib/sidebar.js`
- Modify: `lib/sidebar.css`
- Modify: `tests/sidebar.test.js`

The AI Answers panel gains a sibling card `ai-card-managed` placed immediately after `ai-card-key`. A new `setAiAccessMode(mode)` toggles which card is visible via the `hidden` attribute. The managed card carries no key UI and renders an honest "not yet available" placeholder until Stage 3.

- [ ] **Step 1: Write the failing tests in `tests/sidebar.test.js`**

```javascript
test('Stage 2: AI panel contains both ai-card-key and ai-card-managed', () => {
  const { sidebar, shadow } = freshSidebar();
  assert.ok(shadow.querySelector('[data-card="ai-card-key"]'));
  assert.ok(shadow.querySelector('[data-card="ai-card-managed"]'));
});

test('Stage 2: by default (personal-key mode) the managed card is hidden, BYOK card visible', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiAccessMode('personal-key');
  assert.equal(shadow.querySelector('[data-card="ai-card-key"]').hidden, false);
  assert.equal(shadow.querySelector('[data-card="ai-card-managed"]').hidden, true);
});

test('Stage 2: setAiAccessMode("managed-credits") shows managed card, hides BYOK', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiAccessMode('managed-credits');
  assert.equal(shadow.querySelector('[data-card="ai-card-key"]').hidden, true);
  assert.equal(shadow.querySelector('[data-card="ai-card-managed"]').hidden, false);
});

test('Stage 2: managed card contains NO key input / save / clear / show / remember', () => {
  const { sidebar, shadow } = freshSidebar();
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  assert.equal(managed.querySelector('input[type="password"]'), null);
  assert.equal(managed.querySelector('[data-role="ai-key-input"]'), null);
  assert.equal(managed.querySelector('[data-action="ai-key-save"]'), null);
  assert.equal(managed.querySelector('[data-action="ai-key-clear"]'), null);
  assert.equal(managed.querySelector('[data-action="ai-key-toggle"]'), null);
  assert.equal(managed.querySelector('[data-role="ai-key-remember"]'), null);
});

test('Stage 2: managed card has title "AI Credits", a status pill, and a portal action button', () => {
  const { sidebar, shadow } = freshSidebar();
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  const header = managed.querySelector('.ccp-ai-card-header');
  assert.ok(header);
  assert.equal(header.textContent.trim(), 'AI Credits');
  assert.ok(managed.querySelector('[data-role="ai-managed-state"]'));
  assert.ok(managed.querySelector('[data-action="ai-open-portal"]'));
});

test('Stage 2: setAiManagedStatus({ available:false, message:"Managed AI Credits are not yet available in this build." }) renders that text', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiManagedStatus({ available: false, message: 'Managed AI Credits are not yet available in this build.' });
  const pill = shadow.querySelector('[data-role="ai-managed-state"]');
  assert.equal(pill.textContent, 'Managed AI Credits are not yet available in this build.');
});

test('Stage 2: setAiManagedStatus({ available:false }) marks the managed card as unavailable', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiManagedStatus({ available: false });
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  assert.ok(managed.classList.contains('ccp-ai-card--unavailable'));
});

test('Stage 2: invalid mode value normalizes to personal-key', () => {
  const { sidebar, shadow } = freshSidebar();
  sidebar.setAiAccessMode('garbage-value');
  assert.equal(shadow.querySelector('[data-card="ai-card-key"]').hidden, false);
  assert.equal(shadow.querySelector('[data-card="ai-card-managed"]').hidden, true);
});

test('Stage 2: no provider name appears in either card', () => {
  const { sidebar, shadow } = freshSidebar();
  const panel = shadow.querySelector('[data-panel="ai-answer"]');
  assert.equal(panel.textContent.indexOf('DeepSeek'), -1);
});
```

- [ ] **Step 2: Run to verify RED**

Run: `node --test tests/sidebar.test.js`
Expected: ~9 new tests FAIL (managed card doesn't exist, `setAiAccessMode` doesn't exist).

- [ ] **Step 3: Update HTML template in `lib/sidebar.js`**

Find the existing `data-card="ai-card-key"` block. After its closing `</div>` (and before `data-card="ai-card-scan"`), insert the new managed card:

```javascript
'<div class="ccp-ai-card" data-card="ai-card-managed" hidden>' +
  '<div class="ccp-ai-card-header">AI Credits</div>' +
  '<div class="ccp-ai-status-pill" data-role="ai-managed-state">Managed AI Credits are not yet available in this build.</div>' +
  '<div class="ccp-ai-note">No API key required. Credits will power generation through a hosted service once available.</div>' +
  '<div class="ccp-ai-row">' +
    '<button class="ccp-btn" data-action="ai-open-portal" disabled>Get AI Credits</button>' +
  '</div>' +
'</div>' +
```

- [ ] **Step 4: Add `setAiAccessMode` and `setAiManagedStatus` functions**

Add the functions inside the sidebar IIFE (near the other `setAi*` functions):

```javascript
const VALID_AI_ACCESS_MODES = { 'personal-key': true, 'managed-credits': true };

function setAiAccessMode(mode) {
  if (!shadow) return;
  const normalized = VALID_AI_ACCESS_MODES[mode] ? mode : 'personal-key';
  _aiState.accessMode = normalized;
  const byok = shadow.querySelector('[data-card="ai-card-key"]');
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  if (byok) byok.hidden = (normalized !== 'personal-key');
  if (managed) managed.hidden = (normalized !== 'managed-credits');
  _renderAiButtonStates();
}

function setAiManagedStatus(state) {
  if (!shadow) return;
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  const pill = shadow.querySelector('[data-role="ai-managed-state"]');
  if (state && state.message && pill) pill.textContent = String(state.message);
  if (managed) {
    if (state && state.available === false) managed.classList.add('ccp-ai-card--unavailable');
    else managed.classList.remove('ccp-ai-card--unavailable');
  }
  _renderAiButtonStates();
}
```

Update the exported `api` object to include both new functions.

Update `_aiState` initialization to include `accessMode: 'personal-key'`.

- [ ] **Step 5: Add CSS rule for unavailable state**

Append to `lib/sidebar.css`:

```css
.ccp-ai-card--unavailable {
  opacity: 0.7;
}
.ccp-ai-card--unavailable .ccp-ai-status-pill {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.08);
  color: var(--ccp-text-dim);
}
```

- [ ] **Step 6: Run tests to verify GREEN**

Run: `node --test tests/sidebar.test.js`
Expected: all sidebar tests pass.

- [ ] **Step 7: Do NOT commit.**

### Task S2-4: Options-page mode radio + Managed AI Credits section (RED first)

**Files:**
- Modify: `options.html`
- Modify: `lib/ai-options-controller.js`
- Modify: `tests/ai-options-controller.test.js`

The radio toggle has two values (`personal-key`, `managed-credits`). The controller persists the selection via an injected storage dep so jsdom tests can drive it. The managed section contains a portal-link button (in Stage 2 it opens a placeholder URL via the injected `openPortalFn` dep).

- [ ] **Step 1: Write the failing tests in `tests/ai-options-controller.test.js`**

```javascript
test('Stage 2: options.html contains the radio mode toggle and managed section', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/name="ai-access-mode"/.test(html));
  assert.ok(/value="personal-key"/.test(html));
  assert.ok(/value="managed-credits"/.test(html));
  assert.ok(/data-action="ai-options-open-portal"/.test(html));
});

test('Stage 2: controller reads stored aiAccessMode and checks the matching radio', async () => {
  const dom = makeDom();  // helper already exists in this file; add radios via per-test markup
  // Inject the radio HTML for this test:
  dom.window.document.body.insertAdjacentHTML('beforeend',
    '<input type="radio" name="ai-access-mode" value="personal-key" data-role="ai-options-mode-personal-key" />' +
    '<input type="radio" name="ai-access-mode" value="managed-credits" data-role="ai-options-mode-managed-credits" />');
  let stored = null;
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function (cmd) {
      if (cmd === 'keyStatus') return { ok: true, keyPresent: false, accessMode: 'managed-credits' };
      return { ok: true };
    }),
    storage: { get: function (k, cb) { cb({ 'ccp.ai.accessMode': 'managed-credits' }); }, set: function (i, cb) { stored = i; if (cb) cb(); } },
  });
  ctrl.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(dom.window.document.querySelector('[data-role="ai-options-mode-managed-credits"]').checked, true);
});

test('Stage 2: clicking personal-key radio persists "personal-key" to storage', async () => {
  const dom = makeDom();
  dom.window.document.body.insertAdjacentHTML('beforeend',
    '<input type="radio" name="ai-access-mode" value="personal-key" data-role="ai-options-mode-personal-key" />' +
    '<input type="radio" name="ai-access-mode" value="managed-credits" data-role="ai-options-mode-managed-credits" />');
  let stored = null;
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function (cmd) {
      if (cmd === 'keyStatus') return { ok: true, keyPresent: false, accessMode: 'managed-credits' };
      return { ok: true };
    }),
    storage: { get: function (k, cb) { cb({}); }, set: function (i, cb) { stored = i; if (cb) cb(); } },
  });
  ctrl.wire();
  const radio = dom.window.document.querySelector('[data-role="ai-options-mode-personal-key"]');
  radio.checked = true;
  radio.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.deepEqual(stored, { 'ccp.ai.accessMode': 'personal-key' });
});

test('Stage 2: invalid stored mode value defaults to personal-key radio checked', async () => {
  const dom = makeDom();
  dom.window.document.body.insertAdjacentHTML('beforeend',
    '<input type="radio" name="ai-access-mode" value="personal-key" data-role="ai-options-mode-personal-key" />' +
    '<input type="radio" name="ai-access-mode" value="managed-credits" data-role="ai-options-mode-managed-credits" />');
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function () { return { ok: true, keyPresent: false }; }),
    storage: { get: function (k, cb) { cb({ 'ccp.ai.accessMode': 'garbage' }); }, set: function (i, cb) { if (cb) cb(); } },
  });
  ctrl.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(dom.window.document.querySelector('[data-role="ai-options-mode-personal-key"]').checked, true);
});

test('Stage 2: clicking the portal-link button invokes the injected openPortalFn', async () => {
  const dom = makeDom();
  dom.window.document.body.insertAdjacentHTML('beforeend',
    '<button data-action="ai-options-open-portal">Open AI Credits Portal</button>' +
    '<input type="radio" name="ai-access-mode" value="personal-key" data-role="ai-options-mode-personal-key" />' +
    '<input type="radio" name="ai-access-mode" value="managed-credits" data-role="ai-options-mode-managed-credits" />');
  let opens = 0;
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function () { return { ok: true, keyPresent: false }; }),
    storage: { get: function (k, cb) { cb({}); }, set: function (i, cb) { if (cb) cb(); } },
    openPortalFn: function () { opens++; },
  });
  ctrl.wire();
  dom.window.document.querySelector('[data-action="ai-options-open-portal"]').click();
  assert.equal(opens, 1);
});
```

- [ ] **Step 2: Run to verify RED**

Run: `node --test tests/ai-options-controller.test.js`
Expected: 5 new tests FAIL.

- [ ] **Step 3: Update `options.html` body**

In the body, before the existing BYOK section, add a mode-selector and wrap both sections appropriately. New body content:

```html
<body>
  <div class="card">
    <h1>AI API Key Settings</h1>
    <p class="subtitle">Configure the API key used by the "AI Answers" feature.</p>
    <div class="security-note">
      This key is entered in the extension settings page, not on Coursera. Your key never appears in any third-party webpage's DOM.
    </div>

    <fieldset class="mode-selector">
      <legend>Choose how this extension calls the AI service.</legend>
      <label class="mode-row">
        <input type="radio" name="ai-access-mode" value="personal-key" data-role="ai-options-mode-personal-key" />
        Use my own AI API Key
      </label>
      <label class="mode-row">
        <input type="radio" name="ai-access-mode" value="managed-credits" data-role="ai-options-mode-managed-credits" />
        Use Managed AI Credits
      </label>
    </fieldset>

    <section class="byok-section">
      <h2>Use Your Own AI API Key</h2>
      <label class="field-label" for="key">AI API Key</label>
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
    </section>

    <section class="managed-section">
      <h2>Managed AI Credits</h2>
      <p>No API key required. Purchase credits in our hosted portal to start generating suggestions.</p>
      <div class="managed-status" data-role="ai-options-managed-status">Balance: Not signed in.</div>
      <div class="actions">
        <button data-action="ai-options-open-portal" type="button" data-variant="ghost">Open AI Credits Portal</button>
      </div>
    </section>

    <div class="footer">
      Session-only keys live until the browser closes. Remembered keys persist on this device until you clear them here. The extension never logs or transmits the key beyond the AI service's API.
      <div data-role="ccp-build" style="margin-top:8px; font-size:11px; color:#888;">Build: —</div>
    </div>
  </div>
  <script>
    (function populateBuildTag() {
      var version = '';
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) {
          var m = chrome.runtime.getManifest();
          if (m && typeof m.version === 'string') version = m.version;
        }
      } catch (e) { /* ignore */ }
      var els = document.querySelectorAll('[data-role="ccp-build"]');
      for (var i = 0; i < els.length; i++) els[i].textContent = 'Build: ' + (version || '—');
    })();
  </script>
  <script src="lib/ai-options-controller.js"></script>
  <script src="options.js"></script>
</body>
```

Add CSS in the same `<style>` block:

```css
.mode-selector { border: 1px solid var(--c-border); border-radius: 8px; padding: 8px 12px; margin: 10px 0 18px; }
.mode-selector legend { font-size: 12px; color: var(--c-text-dim); padding: 0 4px; }
.mode-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: 13px; cursor: pointer; }
.mode-row input[type="radio"] { width: 16px; height: 16px; accent-color: var(--c-accent); }
.byok-section, .managed-section { margin: 18px 0; padding-top: 18px; border-top: 1px solid var(--c-border); }
.byok-section h2, .managed-section h2 { font-size: 15px; margin: 0 0 8px; }
.managed-status { background: #f1f2f7; border: 1px solid var(--c-border); border-radius: 8px; padding: 10px 12px; font-size: 13px; color: var(--c-text); margin-bottom: 10px; }
```

- [ ] **Step 4: Update `lib/ai-options-controller.js`**

Add `storage` and `openPortalFn` to the dep list at the top of `createAiOptionsController`:

```javascript
var messenger = deps.messenger;
var doc       = deps.document;
var storage   = deps.storage || null;
var openPortalFn = (typeof deps.openPortalFn === 'function') ? deps.openPortalFn : null;
```

Add helper:

```javascript
var VALID_MODES_OPT = { 'personal-key': true, 'managed-credits': true };

function setRadioMode(mode) {
  var normalized = VALID_MODES_OPT[mode] ? mode : 'personal-key';
  var personalRadio = doc.querySelector('[data-role="ai-options-mode-personal-key"]');
  var managedRadio = doc.querySelector('[data-role="ai-options-mode-managed-credits"]');
  if (personalRadio) personalRadio.checked = (normalized === 'personal-key');
  if (managedRadio) managedRadio.checked = (normalized === 'managed-credits');
}

function persistMode(mode) {
  if (!storage || typeof storage.set !== 'function') return;
  var write = {}; write['ccp.ai.accessMode'] = mode;
  storage.set(write, function () { /* noop */ });
}

function readModeAndApply() {
  if (!storage || typeof storage.get !== 'function') { setRadioMode('personal-key'); return; }
  storage.get(['ccp.ai.accessMode'], function (got) {
    var mode = (got && got['ccp.ai.accessMode']) || 'personal-key';
    setRadioMode(mode);
  });
}
```

In `wire()`, add radio listeners and portal-button listener AFTER the existing toggle/save/clear wiring:

```javascript
var personalRadio = doc.querySelector('[data-role="ai-options-mode-personal-key"]');
var managedRadio = doc.querySelector('[data-role="ai-options-mode-managed-credits"]');
if (personalRadio) personalRadio.addEventListener('change', function () { if (personalRadio.checked) persistMode('personal-key'); });
if (managedRadio) managedRadio.addEventListener('change', function () { if (managedRadio.checked) persistMode('managed-credits'); });

var portalBtn = doc.querySelector('[data-action="ai-options-open-portal"]');
if (portalBtn) portalBtn.addEventListener('click', function () { if (openPortalFn) openPortalFn(); });

readModeAndApply();
```

- [ ] **Step 5: Update `options.js` to inject storage + openPortalFn**

In `options.js`, replace the controller construction with:

```javascript
var messenger = {
  send: function (command, params, cb) {
    try {
      chrome.runtime.sendMessage({ type: 'ccp.ai.request', command: command, params: params || {} }, function (res) {
        cb(res || { ok: false, reason: 'no-response' });
      });
    } catch (e) {
      cb({ ok: false, reason: 'send-failed', detail: String(e && e.message || '').slice(0, 80) });
    }
  }
};
var storage = {
  get: function (keys, cb) { chrome.storage.local.get(keys, cb); },
  set: function (items, cb) { chrome.storage.local.set(items, cb); },
};
var ctrl = mod.createAiOptionsController({
  messenger: messenger,
  document: document,
  storage: storage,
  openPortalFn: function () {
    // Stage 2 placeholder: there is no real portal yet.
    // Show an honest, sanitized message rather than navigating to a fake URL.
    var statusEl = document.querySelector('[data-role="ai-options-managed-status"]');
    if (statusEl) statusEl.textContent = 'Managed AI Credits are not yet available in this build. Try again once the portal launches.';
  },
});
ctrl.wire();
```

- [ ] **Step 6: Run tests to verify GREEN**

Run: `node --test tests/ai-options-controller.test.js`
Expected: all tests pass.

- [ ] **Step 7: Do NOT commit.**

### Task S2-5: Content controller mode awareness + Generate refusal in managed mode (RED first)

**Files:**
- Modify: `lib/ai-answer-controller.js`
- Modify: `content.js`
- Modify: `tests/ai-answer-controller.test.js`

The controller's `refreshKeyStatus` already calls `setAiKeyStatus({keyPresent, remembered})`. Extend it to also call `setAiAccessMode(res.accessMode)`. The `performGenerate` function inspects the access mode and refuses with an honest message if it's `managed-credits` (since Stage 2 has no real managed route yet).

- [ ] **Step 1: Write the failing tests in `tests/ai-answer-controller.test.js`**

```javascript
test('Stage 2: refreshKeyStatus forwards accessMode to sidebar.setAiAccessMode', async () => {
  const { dom, sidebar, controller } = setup();
  let lastMode = null;
  sidebar.setAiAccessMode = function (m) { lastMode = m; };  // augment fake
  controller.messenger = fakeMessenger(function (cmd) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: true, remembered: false, accessMode: 'managed-credits' };
    return { ok: true };
  });
  controller.refreshKeyStatus();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(lastMode, 'managed-credits');
});

test('Stage 2: performGenerate in managed-credits mode receives managed-not-implemented honestly', async () => {
  const html = '<section><h3>Question 1</h3><p>Pick</p>'
    + '<label><input type="radio" name="r1">A</label><label><input type="radio" name="r1">B</label></section>';
  const { dom, sidebar, controller } = setup(html);
  controller.messenger = fakeMessenger(function (cmd) {
    if (cmd === 'keyStatus') return { ok: true, keyPresent: false, accessMode: 'managed-credits' };
    if (cmd === 'generateAnswers') return { ok: false, reason: 'managed-not-implemented' };
    return { ok: true };
  });
  controller.wire();
  controller.performScan();
  await new Promise(function (r) { setTimeout(r, 0); });
  controller.performGenerate();
  await new Promise(function (r) { setTimeout(r, 0); });
  // Sidebar message should be honest about the managed mode not being available
  assert.ok(sidebar.state.applyResult && sidebar.state.applyResult.message);
  assert.ok(/not yet available|not.*implemented/i.test(sidebar.state.applyResult.message));
});

test('Stage 2: openPortalFn dep is invoked by onOpenPortal handler', () => {
  const { dom, sidebar, controller } = setup();
  let portals = 0;
  const ctx = require('../lib/ai-question-context.js');
  const validator = require('../lib/ai-answer-validator.js');
  const applier = require('../lib/answer-applier.js');
  const ctrl2 = require('../lib/ai-answer-controller.js').createAiController({
    sidebar: sidebar, questionContext: ctx, validator: validator, answerApplier: applier,
    messenger: { send: function (c, p, cb) { cb({ ok: true, keyPresent: false, accessMode: 'managed-credits' }); } },
    document: dom.window.document, location: dom.window.location,
    openOptionsFn: function () {},
    openPortalFn: function () { portals++; },
  });
  ctrl2.wire();
  // Simulate the sidebar's onOpenPortal callback firing
  if (sidebar.state.handlers && typeof sidebar.state.handlers.onOpenPortal === 'function') {
    sidebar.state.handlers.onOpenPortal();
  }
  assert.equal(portals, 1);
});
```

- [ ] **Step 2: Run to verify RED**

Run: `node --test tests/ai-answer-controller.test.js`
Expected: 3 new tests FAIL.

- [ ] **Step 3: Update `refreshKeyStatus` in `lib/ai-answer-controller.js`**

```javascript
function refreshKeyStatus() {
  send('keyStatus', {}, function (res) {
    sidebar.setAiKeyStatus({ keyPresent: !!(res && res.keyPresent), remembered: !!(res && res.remembered) });
    if (typeof sidebar.setAiAccessMode === 'function') {
      sidebar.setAiAccessMode((res && res.accessMode) || 'personal-key');
    }
  });
}
```

- [ ] **Step 4: Add `openPortalFn` dep + onOpenPortal handler in `wire()`**

In `createAiController(deps)`:

```javascript
var openPortalFn = (typeof deps.openPortalFn === 'function') ? deps.openPortalFn : null;
```

In `wire()`'s `setAiAnswerHandlers` call, add:

```javascript
onOpenPortal: function () { if (openPortalFn) openPortalFn(); },
```

- [ ] **Step 5: Update `performGenerate` to handle managed-not-implemented**

The existing `aiServiceErrorMessage` already covers most reasons. Add `managed-not-implemented` to the switch:

```javascript
case 'managed-not-implemented': return 'Managed AI Credits are not yet available in this build.';
```

The existing `performGenerate` already calls `aiServiceErrorMessage(res.reason)` and shows the message via `setAiApplyResult({ filled:0, failed:0, message: msg })`. So the new reason flows through naturally.

- [ ] **Step 6: Wire `openPortalFn` in `content.js`**

In `setupAiAnswerController()`, after constructing the messenger, add:

```javascript
var controller = a.aiAnswerController.createAiController({
  sidebar: a.sidebar,
  questionContext: a.aiQuestionContext,
  validator: a.aiAnswerValidator,
  answerApplier: a.answerApplier,
  messenger: messenger,
  document: document,
  location: window.location,
  openOptionsFn: function () { try { chrome.runtime.openOptionsPage(); } catch (e) { try { chrome.runtime.sendMessage({ type: 'ccp.ai.openOptions' }); } catch (_) {} } },
  openPortalFn: function () {
    // Stage 2: there is no real portal URL yet. Open the options page where the
    // managed-credits section explains the unavailable state honestly.
    try { chrome.runtime.openOptionsPage(); } catch (_) {}
  },
});
```

- [ ] **Step 7: Wire `onOpenPortal` in sidebar's handler registry + bind to the managed card's button**

In `lib/sidebar.js`, find the `_aiAnswerHandlers` object and add `onOpenPortal: null` to its initial shape. In `wireAiAnswer()`, locate the existing button-handler bindings and add a binding for the managed card's portal button:

```javascript
const portalBtn = shadow.querySelector('[data-action="ai-open-portal"]');
if (portalBtn) {
  portalBtn.addEventListener('click', function () {
    if (_aiAnswerHandlers.onOpenPortal) _aiAnswerHandlers.onOpenPortal();
  });
}
```

- [ ] **Step 8: Run tests to verify GREEN**

Run: `node --test tests/ai-answer-controller.test.js tests/sidebar.test.js`
Expected: all tests pass.

- [ ] **Step 9: Do NOT commit.**

### Task S2-6: Full regression + leak scan + final report

**Files:** none modified.

- [ ] **Step 1: Run full focused AI suite**

Run:
```
node --test tests/ai-question-context.test.js tests/ai-answer-validator.test.js tests/deepseek-client.test.js tests/ai-background-service.test.js tests/ai-answer-controller.test.js tests/ai-options-controller.test.js tests/ai-answer-tab.test.js tests/answer-applier.test.js tests/sidebar.test.js tests/managed-client.test.js
```
Expected: all pass.

- [ ] **Step 2: Run Autopilot regression**

Run:
```
node --test tests/autopilot-authority.test.js tests/autopilot-state.test.js tests/module-autopilot.test.js tests/item-handlers.test.js tests/completion-confirmer.test.js tests/autopilot-timing.test.js
```
Expected: all pass with current counts (284/284 baseline).

- [ ] **Step 3: Full `npm test`**

Run: `npm test`
Expected: total ≥ prior baseline (1023) + ~27 new tests from this plan. All pass.

- [ ] **Step 4: Repo-wide secret leak scan**

Run:
```
node -e "const fs=require('fs');const p=require('path');let leaks=[];function w(d){fs.readdirSync(d).forEach(function(f){const fp=p.join(d,f);const s=fs.statSync(fp);if(s.isDirectory()){if(/node_modules|\\.git|Reference/.test(fp))return;w(fp);}else if(/\\.(js|json|md|html|css)$/.test(f)){const t=fs.readFileSync(fp,'utf8');const m=t.match(/sk-[A-Za-z0-9_]{16,}/);if(m)leaks.push(fp+': '+m[0]);}});}w('.');console.log(leaks.length?'LEAKS:\\n'+leaks.join('\\n'):'clean');"
```
Expected: `clean`.

- [ ] **Step 5: Provider-neutrality grep**

Run:
```
node -e "['lib/sidebar.js','lib/ai-options-controller.js','lib/ai-answer-controller.js','options.html','lib/managed-client.js'].forEach(function(p){var t=require('fs').readFileSync(p,'utf8');var n=(t.match(/DeepSeek/g)||[]).length;console.log(p+': DeepSeek='+n);});"
```
Expected: each line reports `DeepSeek=0`.

- [ ] **Step 6: Sidebar secret-boundary grep**

Run:
```
node -e "const t=require('fs').readFileSync('lib/sidebar.js','utf8'); ['ai-key-input','ai-key-toggle','ai-key-save','ai-key-remember','ai-key-clear','wireDisableable','Use built-in API key','ai-use-builtin'].forEach(function(s){console.log(s+': '+((t.match(new RegExp(s,'g'))||[]).length));});"
```
Expected: each count = `0`.

- [ ] **Step 7: Confirm no autopilot file modified**

Run: `git diff --name-only HEAD | grep -E "(autopilot|module-|completion-confirmer|item-handlers)"`
Expected: no output. (Pre-existing dirty markers from the conversation baseline remain — `git status` shows them but no new diffs were added.)

- [ ] **Step 8: Confirm no real key, no live test, no git mutation**

Verify by inspection:
- Repo leak scan reports `clean`.
- No `chrome.tabs.create` / `chrome.tabs.update` call points at any real third-party URL added in this plan (only `chrome.runtime.openOptionsPage()` for portal placeholder).
- `manifest.json` is unchanged in this plan (no new `host_permissions`).
- No `git commit`, `git push`, `git reset`, `git clean`, `git revert`, `git checkout`, branch creation, or `git amend` was run.

- [ ] **Step 9: Final report**

Compose a chat message covering:
- Stage 0: build indicator wired in Diagnostics + options footer; reads `chrome.runtime.getManifest().version` at render time with `—` fallback.
- Stage 2: `aiAccessMode` storage with two valid values; invalid normalizes to `personal-key`; default for new installs is `personal-key`.
- Sidebar has both cards in the static template; `setAiAccessMode` toggles via `hidden`; managed card carries NO key UI.
- Background service routes by mode; managed branch never reads BYOK storage; `keyStatus` returns `accessMode`.
- `lib/managed-client.js` is a Stage 2 mock returning `managed-not-implemented` with NO network call.
- Options page has radio toggle + Managed AI Credits section with portal-link button; selection persists to `chrome.storage.local`.
- Content controller wires `openPortalFn` (Stage 2: opens options page, since no real portal exists yet).
- Final test totals, leak scan = `clean`, provider-neutrality grep all 0, sidebar secret-boundary grep all 0.
- Operational confirmations: no real key, no live test, no autopilot edits, no git mutation.
- Deferred decisions remain UNDECIDED; Stage 3 + Stage 4 implementation is NOT undertaken in this plan.

---

## Self-review

**Spec coverage** — every Stage 0/2 requirement in `docs/superpowers/specs/2026-05-27-ai-access-design.md` maps to a task here:
- Spec §1.3 build indicator → Task S0-1.
- Spec §1.2 manual reload steps → Task S0-2 (documentation only, lives in the spec doc).
- Spec §2 dual-route architecture → Task S2-2.
- Spec §3 file footprint (extension portion) → the file-footprint table above; all files match.
- Spec §5.1 sidebar dual-card → Task S2-3.
- Spec §5.2 options two-section layout → Task S2-4.
- Spec §6.1 + §6.2 RED tests → embedded in each task.
- Spec §8 hard non-negotiables → enforced by the forbidden-file list + leak scans + secret-boundary greps + the explicit "do not commit / no real key" steps.

Stage 3 + Stage 4 (real backend, payment, ledger, plans) are explicitly NOT in this plan and remain blocked behind the eight UNDECIDED decisions in spec §7.

**Placeholder scan** — no `TBD` / `TODO` / `implement later` in this plan. Every code step shows complete code blocks.

**Type/selector consistency** —
- Storage key: `ccp.ai.accessMode` consistent in service, controller, and tests.
- Mode values: `'personal-key'` and `'managed-credits'` consistent everywhere.
- Card data-attributes: `data-card="ai-card-key"`, `data-card="ai-card-managed"` consistent in sidebar template + tests.
- New `data-role` / `data-action` values: `ai-managed-state`, `ai-open-portal`, `ai-options-mode-personal-key`, `ai-options-mode-managed-credits`, `ai-options-open-portal`, `ai-options-managed-status`, `ccp-build` — each defined once and queried by tests with the same string.
- New sidebar functions: `setAiAccessMode`, `setAiManagedStatus` — defined in Task S2-3, exported in same task, consumed by tests in same task and by controller in Task S2-5.
- New controller dep: `openPortalFn` — declared in Task S2-5, injected by content.js in same task, asserted by tests in same task.
- New service deps: `managedClient`, `accessModeProvider` — declared in Task S2-2, injected by background.js in same task, asserted by tests in same task.
- New options-controller dep: `storage`, `openPortalFn` — declared in Task S2-4.

**Risk callouts**:
- The radio in options.html submits a `change` event from JS in tests via `radio.dispatchEvent(new Event('change'))`. JSDOM supports this; the bubbling event reaches the controller's `addEventListener`. If a future test runs in a stricter environment, the controller's bare `addEventListener('change', ...)` still works.
- The Stage 2 `openPortalFn` in production opens the options page rather than a real portal URL. This is intentional: it lands the user on the page that explains "Managed AI Credits are not yet available" honestly. Stage 4 swaps this for the real portal URL.
- The managed-card-only `setAiManagedStatus` mutates a CSS class on the card. The `.ccp-ai-card--unavailable` rule is added in Task S2-3 step 5. If a future visual designer wants to change the unavailable-state appearance, the test does not lock in pixel values — only the class name.
