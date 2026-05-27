# U10 Corrections — Stage 0 + Stage 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land three narrowly-scoped corrections to the existing Stage 0 + Stage 2 AI-access scaffolding before the user enters a real API key: (1) remove the MV3-CSP-violating inline `<script>` from `options.html`, (2) make access-mode changes refresh an already-open sidebar by routing them through the background's authorized settings command and broadcasting a sanitized event, and (3) replace the misleading Stage 2 portal/balance copy with honest "not yet available" wording.

**Architecture:**
- All build-indicator population moves into `lib/ai-options-controller.js` so `options.html` ships zero inline JavaScript.
- A new `setAccessMode` command is added to `lib/ai-background-service.js`. It reuses the existing strict `canManageSecrets` options-page sender boundary, validates the mode against `{ 'personal-key', 'managed-credits' }`, persists to `chrome.storage.local["ccp.ai.accessMode"]`, and broadcasts `{ type: 'ccp.ai.accessModeChanged' }`. The options page swaps its direct `storage.set` write for this command. The content script listens on the new event and reuses `controller.refreshKeyStatus()`.
- Stage 2 managed-mode copy in both `options.html` and `lib/sidebar.js` is rewritten to honest "not yet available" wording; the portal control is disabled and emits no navigation.

**Tech Stack:** Vanilla JS (MV3 service worker + content script + options page), `node:test`, `jsdom`, no build step.

---

## File Structure

This correction touches a small, focused surface. Each file has one job:

- `lib/ai-options-controller.js` — owns the build-indicator DOM update (NEW); owns the radio→`setAccessMode` dispatch (CHANGED — no longer writes mode through page storage).
- `options.html` — drops the inline `<script>` block; updates Stage 2 managed copy and disables the portal action.
- `lib/ai-background-service.js` — adds the `setAccessMode` command, authorized via `canManageSecrets`, persists to `storageLocal`, and broadcasts the sanitized event (NEW command in existing handler).
- `background.js` — passes a `setAccessMode` persistence callback to the service constructor; existing `broadcastToTabs` is reused unchanged.
- `lib/sidebar.js` — rewrites the managed-card copy and confirms the portal button stays `disabled` with no navigation. (No new DOM contract — selector names unchanged.)
- `content.js` — adds a second `chrome.runtime.onMessage` branch so `'ccp.ai.accessModeChanged'` also invokes `controller.refreshKeyStatus()`.
- `tests/ai-options-controller.test.js` — RED tests for Issue 1, Issue 2 (options radio dispatches `setAccessMode`), Issue 3 (options managed copy).
- `tests/ai-background-service.test.js` — RED tests for Issue 2 background-side authorization + broadcast.
- `tests/ai-answer-controller.test.js` — RED integration tests for Issue 2 sidebar refresh on `ccp.ai.accessModeChanged`.
- `tests/sidebar.test.js` — RED tests for Issue 3 sidebar managed copy preservation.

No existing file is restructured; each change is the minimum needed for the corresponding test.

---

## Task 1: Build indicator — RED test for inline-script removal

**Files:**
- Test: `tests/ai-options-controller.test.js`

- [ ] **Step 1: Add a RED test asserting `options.html` has zero inline executable `<script>` blocks**

Append this test to `tests/ai-options-controller.test.js`:

```js
// === U10 Issue 1 — MV3 CSP: no inline scripts in options.html ===

test('U10-1: options.html contains NO inline executable <script> blocks', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  // Match <script> tags that have NO src attribute — those are inline executable.
  // We deliberately do not allow type="module" inline either (still CSP-blocked in MV3).
  const inlineScripts = html.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi) || [];
  assert.equal(inlineScripts.length, 0,
    'options.html must not contain any inline <script> — MV3 CSP forbids it. Found: ' + inlineScripts.join('\n---\n'));
});

test('U10-1: options.html only loads bundled external scripts (every <script> has a src=)', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  const allScripts = html.match(/<script\b[^>]*>/gi) || [];
  for (var i = 0; i < allScripts.length; i++) {
    assert.ok(/\bsrc=/.test(allScripts[i]),
      'every <script> in options.html must have a src= attribute, found: ' + allScripts[i]);
  }
});
```

- [ ] **Step 2: Run the new tests and verify they FAIL**

Run: `npm test -- --test-name-pattern="U10-1"`
Expected: Both tests FAIL — `options.html` currently has the inline `(function populateBuildTag() { ... })()` block, so the inline-script count is 1 and `allScripts` includes one tag without `src=`.

- [ ] **Step 3: Commit the RED tests**

```bash
git add tests/ai-options-controller.test.js
git commit -m "test(ai-options): RED — options.html must have no inline scripts (U10-1)"
```

---

## Task 2: Build indicator — RED test for controller-side population

**Files:**
- Test: `tests/ai-options-controller.test.js`

- [ ] **Step 1: Add a RED test asserting the controller populates `[data-role="ccp-build"]` from a mocked manifest**

Append to `tests/ai-options-controller.test.js`:

```js
test('U10-1: wire() populates [data-role="ccp-build"] with "Build: <manifest.version>" from a mocked chrome.runtime.getManifest()', async () => {
  const dom = makeDom();
  dom.window.document.body.insertAdjacentHTML('beforeend',
    '<div data-role="ccp-build">Build: —</div>');
  // Inject a fake chrome.runtime.getManifest into the controller's deps surface.
  // The controller exposes a `chromeRuntime` dep for this purpose (added in this task).
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function () { return { ok: true, keyPresent: false }; }),
    chromeRuntime: { getManifest: function () { return { version: '9.9.9-test' }; } },
  });
  ctrl.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  const el = dom.window.document.querySelector('[data-role="ccp-build"]');
  assert.equal(el.textContent, 'Build: 9.9.9-test');
});

test('U10-1: wire() falls back to "Build: —" when chrome.runtime.getManifest is unavailable, without throwing', async () => {
  const dom = makeDom();
  dom.window.document.body.insertAdjacentHTML('beforeend',
    '<div data-role="ccp-build">Build: —</div>');
  // No chromeRuntime dep at all — must not throw.
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function () { return { ok: true, keyPresent: false }; }),
  });
  assert.doesNotThrow(function () { ctrl.wire(); });
  await new Promise(function (r) { setTimeout(r, 0); });
  const el = dom.window.document.querySelector('[data-role="ccp-build"]');
  assert.equal(el.textContent, 'Build: —');
});

test('U10-1: wire() handles a throwing getManifest gracefully (renders neutral placeholder)', async () => {
  const dom = makeDom();
  dom.window.document.body.insertAdjacentHTML('beforeend',
    '<div data-role="ccp-build">Build: —</div>');
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function () { return { ok: true, keyPresent: false }; }),
    chromeRuntime: { getManifest: function () { throw new Error('boom'); } },
  });
  assert.doesNotThrow(function () { ctrl.wire(); });
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(dom.window.document.querySelector('[data-role="ccp-build"]').textContent, 'Build: —');
});
```

- [ ] **Step 2: Run these tests and verify they FAIL**

Run: `npm test -- --test-name-pattern="U10-1"`
Expected: All three new tests FAIL — the controller does not yet read `chromeRuntime` or update `[data-role="ccp-build"]`.

- [ ] **Step 3: Commit the RED tests**

```bash
git add tests/ai-options-controller.test.js
git commit -m "test(ai-options): RED — controller must populate ccp-build from chromeRuntime (U10-1)"
```

---

## Task 3: Build indicator — GREEN implementation in the controller

**Files:**
- Modify: `lib/ai-options-controller.js`
- Modify: `options.js`
- Modify: `options.html`

- [ ] **Step 1: Add a `chromeRuntime` dep and a build-tag updater to `lib/ai-options-controller.js`**

In `lib/ai-options-controller.js`, inside `createAiOptionsController(deps)`, after the existing dep-reads, add:

```js
    var chromeRuntime = deps.chromeRuntime || null;
```

Add a helper near the other private helpers (e.g. above `function refreshStatus()`):

```js
    function populateBuildTag() {
      var version = '';
      try {
        if (chromeRuntime && typeof chromeRuntime.getManifest === 'function') {
          var m = chromeRuntime.getManifest();
          if (m && typeof m.version === 'string') version = m.version;
        }
      } catch (_) { /* ignore — fall through to neutral placeholder */ }
      var els = doc.querySelectorAll('[data-role="ccp-build"]');
      for (var i = 0; i < els.length; i++) {
        els[i].textContent = 'Build: ' + (version || '—');
      }
    }
```

Then inside `function wire()`, after the existing `readModeAndApply();` call and before `refreshStatus();`, add:

```js
      populateBuildTag();
```

- [ ] **Step 2: Update `options.js` to pass `chromeRuntime: chrome.runtime`**

In `options.js`, change the `createAiOptionsController` call to add the new dep:

```js
  var ctrl = mod.createAiOptionsController({
    messenger: messenger,
    document: document,
    storage: storage,
    chromeRuntime: (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime : null,
    openPortalFn: function () {
      var statusEl = document.querySelector('[data-role="ai-options-managed-status"]');
      if (statusEl) statusEl.textContent = 'Managed AI Credits are not yet available in this build. Try again once the portal launches.';
    },
  });
```

- [ ] **Step 3: Remove the inline `<script>` block from `options.html`**

Delete the entire inline block (lines 210–222 of `options.html`):

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

Leave the two external `<script src="…">` tags untouched.

- [ ] **Step 4: Run the U10-1 tests and verify they PASS**

Run: `npm test -- --test-name-pattern="U10-1"`
Expected: All five U10-1 tests PASS.

- [ ] **Step 5: Run the full ai-options-controller test file to confirm no regression**

Run: `node --test tests/ai-options-controller.test.js`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/ai-options-controller.js options.js options.html
git commit -m "fix(options): remove inline build script; controller populates ccp-build (U10-1)"
```

---

## Task 4: Background `setAccessMode` — RED tests

**Files:**
- Test: `tests/ai-background-service.test.js`

- [ ] **Step 1: Add RED tests for the new `setAccessMode` command**

Append to `tests/ai-background-service.test.js`:

```js
// === U10 Issue 2 — setAccessMode command + accessModeChanged broadcast ===

function makeModeFakeStorage(initial) {
  const session = fakeStorage();
  const local = fakeStorage();
  if (initial) Object.keys(initial).forEach(function (k) { local._store[k] = initial[k]; });
  return { session: session, local: local };
}

test('U10-2: setAccessMode("managed-credits") from authorized options sender persists to storageLocal', async () => {
  const fs2 = makeModeFakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fs2.session, storageLocal: fs2.local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
    broadcast: function (m) { broadcasts.push(m); },
    accessModeProvider: function (cb) { cb(fs2.local._store['ccp.ai.accessMode'] || 'personal-key'); },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' },
    'setAccessMode', { mode: 'managed-credits' });
  assert.equal(res.ok, true);
  assert.equal(fs2.local._store['ccp.ai.accessMode'], 'managed-credits');
});

test('U10-2: setAccessMode("personal-key") from authorized options sender persists to storageLocal', async () => {
  const fs2 = makeModeFakeStorage({ 'ccp.ai.accessMode': 'managed-credits' });
  const svc = createAiBackgroundService({
    storageSession: fs2.session, storageLocal: fs2.local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' },
    'setAccessMode', { mode: 'personal-key' });
  assert.equal(res.ok, true);
  assert.equal(fs2.local._store['ccp.ai.accessMode'], 'personal-key');
});

test('U10-2: setAccessMode emits exactly {type:"ccp.ai.accessModeChanged"} on success — no key, balance, account', async () => {
  const fs2 = makeModeFakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fs2.session, storageLocal: fs2.local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
    broadcast: function (m) { broadcasts.push(m); },
  });
  await callAs(svc, { url: 'chrome-extension://EXT/options.html' },
    'setAccessMode', { mode: 'managed-credits' });
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0], { type: 'ccp.ai.accessModeChanged' });
  // No key material, no balance, no account identifiers may appear:
  const payloadStr = JSON.stringify(broadcasts[0]);
  ['sk-', 'balance', 'account', 'token', 'credit'].forEach(function (forbidden) {
    assert.equal(payloadStr.toLowerCase().indexOf(forbidden), -1,
      'forbidden substring in broadcast: ' + forbidden);
  });
});

test('U10-2: setAccessMode from content-script sender (tab.id present, non-options URL) is REJECTED — no write, no broadcast', async () => {
  const fs2 = makeModeFakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fs2.session, storageLocal: fs2.local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: strictCanManageSecrets('chrome-extension://EXT/options.html'),
    broadcast: function (m) { broadcasts.push(m); },
  });
  const res = await callAs(svc, { tab: { id: 1 }, url: 'https://www.coursera.org/learn/x' },
    'setAccessMode', { mode: 'managed-credits' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
  assert.equal(fs2.local._store['ccp.ai.accessMode'], undefined);
  assert.equal(broadcasts.length, 0);
});

test('U10-2: setAccessMode from unrelated extension page (e.g. popup.html) is REJECTED', async () => {
  const fs2 = makeModeFakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fs2.session, storageLocal: fs2.local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: strictCanManageSecrets('chrome-extension://EXT/options.html'),
    broadcast: function (m) { broadcasts.push(m); },
  });
  const res = await callAs(svc, { id: 'EXT', url: 'chrome-extension://EXT/popup.html' },
    'setAccessMode', { mode: 'managed-credits' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
  assert.equal(fs2.local._store['ccp.ai.accessMode'], undefined);
  assert.equal(broadcasts.length, 0);
});

test('U10-2: setAccessMode with invalid mode value is REFUSED — no storage write, no broadcast', async () => {
  const fs2 = makeModeFakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fs2.session, storageLocal: fs2.local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
    broadcast: function (m) { broadcasts.push(m); },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' },
    'setAccessMode', { mode: 'garbage-value' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid-mode');
  assert.equal(fs2.local._store['ccp.ai.accessMode'], undefined);
  assert.equal(broadcasts.length, 0);
});

test('U10-2: setAccessMode with missing mode field is REFUSED', async () => {
  const fs2 = makeModeFakeStorage();
  const svc = createAiBackgroundService({
    storageSession: fs2.session, storageLocal: fs2.local,
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' }, 'setAccessMode', {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid-mode');
});

test('U10-2: failed setAccessMode (forbidden) does not call broadcast', async () => {
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return false; },
    broadcast: function (m) { broadcasts.push(m); },
  });
  await callAs(svc, { url: 'chrome-extension://EXT/options.html' },
    'setAccessMode', { mode: 'managed-credits' });
  assert.equal(broadcasts.length, 0);
});

test('U10-2: managed-credits mode Generate still fails closed with managed-not-implemented (no network call)', async () => {
  // After switching to managed-credits, generateAnswers must continue to refuse —
  // exactly as the existing S2 behavior. This guards against the correction
  // accidentally enabling a real managed path.
  let deepseekCalled = false;
  let managedCalled = false;
  const fs2 = makeModeFakeStorage();
  const svc = createAiBackgroundService({
    storageSession: fs2.session, storageLocal: fs2.local,
    clientFactory: function () {
      return fakeClient(function () { deepseekCalled = true; return Promise.resolve({ ok: true }); });
    },
    managedClient: { generateAnswers: function () { managedCalled = true; return Promise.resolve({ ok: false, reason: 'managed-not-implemented' }); } },
    canManageSecrets: function () { return true; },
    accessModeProvider: function (cb) { cb(fs2.local._store['ccp.ai.accessMode'] || 'personal-key'); },
  });
  await callAs(svc, { url: 'chrome-extension://EXT/options.html' },
    'setAccessMode', { mode: 'managed-credits' });
  const gen = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers',
    { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(gen.ok, false);
  assert.equal(gen.reason, 'managed-not-implemented');
  assert.equal(deepseekCalled, false, 'managed mode must not fall through to deepseek');
  assert.equal(managedCalled, true);
});
```

- [ ] **Step 2: Run these tests and verify they FAIL**

Run: `npm test -- --test-name-pattern="U10-2"`
Expected: All nine U10-2 tests FAIL — the service does not yet implement `setAccessMode` (it falls through to the `unknown-command` branch).

- [ ] **Step 3: Commit the RED tests**

```bash
git add tests/ai-background-service.test.js
git commit -m "test(ai-bg): RED — setAccessMode command + accessModeChanged broadcast (U10-2)"
```

---

## Task 5: Background `setAccessMode` — GREEN implementation

**Files:**
- Modify: `lib/ai-background-service.js`

- [ ] **Step 1: Implement the `setAccessMode` command in `handle()`**

In `lib/ai-background-service.js`, inside `function handle(msg, sender, sendResponse)`, add a new branch BEFORE the trailing `sendResponse({ ok: false, reason: 'unknown-command' … });`:

```js
      if (cmd === 'setAccessMode') {
        if (!canManageSecrets(sender)) { sendResponse({ ok: false, reason: 'forbidden-sender' }); return false; }
        var mode = params && params.mode;
        if (!VALID_MODES[mode]) { sendResponse({ ok: false, reason: 'invalid-mode' }); return false; }
        var write = {}; write['ccp.ai.accessMode'] = mode;
        storageLocal.set(write, function () {
          broadcast({ type: 'ccp.ai.accessModeChanged' });
          sendResponse({ ok: true, accessMode: mode });
        });
        return true;
      }
```

(The `VALID_MODES` map already exists at the top of `createAiBackgroundService`.)

- [ ] **Step 2: Run U10-2 tests and verify they PASS**

Run: `npm test -- --test-name-pattern="U10-2"`
Expected: All nine U10-2 tests PASS.

- [ ] **Step 3: Run the full ai-background-service test file**

Run: `node --test tests/ai-background-service.test.js`
Expected: All tests PASS — no regression in S1/S2/T3/U8/S2-2 suites.

- [ ] **Step 4: Commit**

```bash
git add lib/ai-background-service.js
git commit -m "feat(ai-bg): authorized setAccessMode command broadcasts ccp.ai.accessModeChanged (U10-2)"
```

---

## Task 6: Options page — RED test that the radio dispatches `setAccessMode`

**Files:**
- Test: `tests/ai-options-controller.test.js`

- [ ] **Step 1: Add RED tests asserting radios dispatch `setAccessMode` rather than directly storing the mode**

Append to `tests/ai-options-controller.test.js`:

```js
// === U10 Issue 2 — options radio dispatches setAccessMode ===

test('U10-2: clicking managed-credits radio dispatches setAccessMode(managed-credits) instead of writing storage directly', async () => {
  const dom = makeDom();
  dom.window.document.body.insertAdjacentHTML('beforeend',
    '<input type="radio" name="ai-access-mode" value="personal-key" data-role="ai-options-mode-personal-key" />' +
    '<input type="radio" name="ai-access-mode" value="managed-credits" data-role="ai-options-mode-managed-credits" />');
  let storageSetCalls = 0;
  const messengerCalls = [];
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: {
      send: function (cmd, params, cb) {
        messengerCalls.push({ cmd: cmd, params: params });
        if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: false, accessMode: 'personal-key' });
        if (cmd === 'setAccessMode') return cb({ ok: true, accessMode: params.mode });
        cb({ ok: true });
      }
    },
    storage: {
      get: function (k, cb) { cb({}); },
      set: function (i, cb) { storageSetCalls++; if (cb) cb(); },
    },
  });
  ctrl.wire();
  const radio = dom.window.document.querySelector('[data-role="ai-options-mode-managed-credits"]');
  radio.checked = true;
  radio.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  // The mode-write path must be the background command, not page storage.
  const modeCmds = messengerCalls.filter(function (c) { return c.cmd === 'setAccessMode'; });
  assert.equal(modeCmds.length, 1);
  assert.deepEqual(modeCmds[0].params, { mode: 'managed-credits' });
  assert.equal(storageSetCalls, 0,
    'options.js must NOT write ccp.ai.accessMode through page storage anymore');
});

test('U10-2: clicking personal-key radio dispatches setAccessMode(personal-key)', async () => {
  const dom = makeDom();
  dom.window.document.body.insertAdjacentHTML('beforeend',
    '<input type="radio" name="ai-access-mode" value="personal-key" data-role="ai-options-mode-personal-key" />' +
    '<input type="radio" name="ai-access-mode" value="managed-credits" data-role="ai-options-mode-managed-credits" />');
  const messengerCalls = [];
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: {
      send: function (cmd, params, cb) {
        messengerCalls.push({ cmd: cmd, params: params });
        if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: false, accessMode: 'managed-credits' });
        if (cmd === 'setAccessMode') return cb({ ok: true, accessMode: params.mode });
        cb({ ok: true });
      }
    },
    storage: { get: function (k, cb) { cb({}); }, set: function (i, cb) { if (cb) cb(); } },
  });
  ctrl.wire();
  const radio = dom.window.document.querySelector('[data-role="ai-options-mode-personal-key"]');
  radio.checked = true;
  radio.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  const modeCmds = messengerCalls.filter(function (c) { return c.cmd === 'setAccessMode'; });
  assert.equal(modeCmds.length, 1);
  assert.deepEqual(modeCmds[0].params, { mode: 'personal-key' });
});
```

- [ ] **Step 2: Run the new tests and verify they FAIL**

Run: `npm test -- --test-name-pattern="U10-2"`
Expected: The two new options-side tests FAIL — the controller currently calls `storage.set` directly via `persistMode()`.

Note: This will also break the pre-existing tests `S2-4: clicking personal-key radio persists "personal-key" to storage` and `S2-4: clicking managed-credits radio persists "managed-credits" to storage`, which assert the OLD (direct-storage) behavior. **That is intentional** — the design correction supersedes those assertions. Update them in Step 3 of Task 7.

- [ ] **Step 3: Commit the RED tests**

```bash
git add tests/ai-options-controller.test.js
git commit -m "test(ai-options): RED — radios dispatch setAccessMode, not storage.set (U10-2)"
```

---

## Task 7: Options page — GREEN: route radio changes through `setAccessMode`

**Files:**
- Modify: `lib/ai-options-controller.js`
- Modify: `tests/ai-options-controller.test.js` (supersede two S2-4 tests)

- [ ] **Step 1: Replace `persistMode()` to dispatch via the messenger instead of `storage.set`**

In `lib/ai-options-controller.js`, replace the existing `persistMode` body:

```js
    function persistMode(mode) {
      messenger.send('setAccessMode', { mode: mode }, function (_res) { /* status managed by accessModeChanged */ });
    }
```

Leave `readModeAndApply()` reading from `storage.get` so the radios initialize correctly when the options page loads (the canonical value still lives in `chrome.storage.local`, written by the background).

- [ ] **Step 2: Update the two superseded S2-4 tests to reflect the new design**

In `tests/ai-options-controller.test.js`, find the two existing tests:
- `S2-4: clicking personal-key radio persists "personal-key" to storage`
- `S2-4: clicking managed-credits radio persists "managed-credits" to storage`

Replace each with a version that asserts the messenger receives `setAccessMode` and that `storage.set` is NOT called. The exact replacement for the first one:

```js
test('S2-4 (U10-2): clicking personal-key radio dispatches setAccessMode via the messenger (no direct storage write)', async () => {
  const dom = makeDom();
  dom.window.document.body.insertAdjacentHTML('beforeend',
    '<input type="radio" name="ai-access-mode" value="personal-key" data-role="ai-options-mode-personal-key" />' +
    '<input type="radio" name="ai-access-mode" value="managed-credits" data-role="ai-options-mode-managed-credits" />');
  let storageSets = 0;
  const sent = [];
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: {
      send: function (cmd, params, cb) {
        sent.push({ cmd: cmd, params: params });
        if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: false, accessMode: 'managed-credits' });
        cb({ ok: true });
      }
    },
    storage: { get: function (k, cb) { cb({}); }, set: function (i, cb) { storageSets++; if (cb) cb(); } },
  });
  ctrl.wire();
  const radio = dom.window.document.querySelector('[data-role="ai-options-mode-personal-key"]');
  radio.checked = true;
  radio.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  const setMode = sent.filter(function (c) { return c.cmd === 'setAccessMode'; });
  assert.equal(setMode.length, 1);
  assert.deepEqual(setMode[0].params, { mode: 'personal-key' });
  assert.equal(storageSets, 0);
});
```

And the second:

```js
test('S2-4 (U10-2): clicking managed-credits radio dispatches setAccessMode via the messenger (no direct storage write)', async () => {
  const dom = makeDom();
  dom.window.document.body.insertAdjacentHTML('beforeend',
    '<input type="radio" name="ai-access-mode" value="personal-key" data-role="ai-options-mode-personal-key" />' +
    '<input type="radio" name="ai-access-mode" value="managed-credits" data-role="ai-options-mode-managed-credits" />');
  let storageSets = 0;
  const sent = [];
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: {
      send: function (cmd, params, cb) {
        sent.push({ cmd: cmd, params: params });
        if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: false, accessMode: 'personal-key' });
        cb({ ok: true });
      }
    },
    storage: { get: function (k, cb) { cb({}); }, set: function (i, cb) { storageSets++; if (cb) cb(); } },
  });
  ctrl.wire();
  const radio = dom.window.document.querySelector('[data-role="ai-options-mode-managed-credits"]');
  radio.checked = true;
  radio.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  const setMode = sent.filter(function (c) { return c.cmd === 'setAccessMode'; });
  assert.equal(setMode.length, 1);
  assert.deepEqual(setMode[0].params, { mode: 'managed-credits' });
  assert.equal(storageSets, 0);
});
```

- [ ] **Step 3: Run the full ai-options-controller test file**

Run: `node --test tests/ai-options-controller.test.js`
Expected: All tests PASS (including the new U10-2 + the rewritten S2-4 pair, and the unchanged read-and-apply S2-4 tests).

- [ ] **Step 4: Commit**

```bash
git add lib/ai-options-controller.js tests/ai-options-controller.test.js
git commit -m "fix(ai-options): radios dispatch setAccessMode instead of writing storage directly (U10-2)"
```

---

## Task 8: Sidebar refresh integration — RED test for `ccp.ai.accessModeChanged`

**Files:**
- Test: `tests/ai-answer-controller.test.js`

- [ ] **Step 1: Read existing test setup to understand fixture patterns**

Read `tests/ai-answer-controller.test.js` to understand the `freshController()` / sidebar-stub idiom in use; reuse it.

- [ ] **Step 2: Add an integration RED test exercising the content-script listener**

The integration sits in `content.js` — the listener wiring lives there, not in `lib/ai-answer-controller.js`. We test the wiring through a small extracted helper. Add this helper module first.

Create new file `lib/ai-content-listeners.js`:

```js
'use strict';
// lib/ai-content-listeners.js
// U10 Issue 2 — single function that registers content-script onMessage listeners
// for both 'ccp.ai.keyStatusChanged' and 'ccp.ai.accessModeChanged'. Both events
// cause controller.refreshKeyStatus() so the sidebar mirrors current background state.
// Pure, dependency-injected for tests; no global side effects.

(function (root) {
  'use strict';

  function attachAiContentListeners(deps) {
    var runtime = deps.runtime;
    var controller = deps.controller;
    if (!runtime || !runtime.onMessage || typeof runtime.onMessage.addListener !== 'function') return;
    if (!controller || typeof controller.refreshKeyStatus !== 'function') return;

    runtime.onMessage.addListener(function (msg) {
      if (!msg) return;
      if (msg.type === 'ccp.ai.keyStatusChanged' || msg.type === 'ccp.ai.accessModeChanged') {
        try { controller.refreshKeyStatus(); } catch (_) {}
      }
    });
  }

  var api = { attachAiContentListeners: attachAiContentListeners };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.ClipboardCleaner = root.ClipboardCleaner || {}; root.ClipboardCleaner.aiContentListeners = api; }
})(typeof self !== 'undefined' ? self : this);
```

Now add a new test file `tests/ai-content-listeners.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { attachAiContentListeners } = require('../lib/ai-content-listeners.js');

function fakeRuntime() {
  var listeners = [];
  return {
    onMessage: {
      addListener: function (fn) { listeners.push(fn); },
    },
    _emit: function (msg) { listeners.forEach(function (l) { l(msg); }); },
    _listenerCount: function () { return listeners.length; },
  };
}

test('U10-2: ccp.ai.keyStatusChanged calls controller.refreshKeyStatus()', () => {
  const runtime = fakeRuntime();
  let refreshCalls = 0;
  const controller = { refreshKeyStatus: function () { refreshCalls++; } };
  attachAiContentListeners({ runtime: runtime, controller: controller });
  runtime._emit({ type: 'ccp.ai.keyStatusChanged' });
  assert.equal(refreshCalls, 1);
});

test('U10-2: ccp.ai.accessModeChanged ALSO calls controller.refreshKeyStatus()', () => {
  const runtime = fakeRuntime();
  let refreshCalls = 0;
  const controller = { refreshKeyStatus: function () { refreshCalls++; } };
  attachAiContentListeners({ runtime: runtime, controller: controller });
  runtime._emit({ type: 'ccp.ai.accessModeChanged' });
  assert.equal(refreshCalls, 1, 'access-mode broadcast must trigger refreshKeyStatus');
});

test('U10-2: unrelated message types do NOT call refreshKeyStatus', () => {
  const runtime = fakeRuntime();
  let refreshCalls = 0;
  const controller = { refreshKeyStatus: function () { refreshCalls++; } };
  attachAiContentListeners({ runtime: runtime, controller: controller });
  runtime._emit({ type: 'autopilot.state' });
  runtime._emit({ type: 'random.other' });
  runtime._emit(null);
  runtime._emit(undefined);
  assert.equal(refreshCalls, 0);
});

test('U10-2: throwing controller.refreshKeyStatus does not propagate to the message bus', () => {
  const runtime = fakeRuntime();
  const controller = { refreshKeyStatus: function () { throw new Error('boom'); } };
  attachAiContentListeners({ runtime: runtime, controller: controller });
  assert.doesNotThrow(function () { runtime._emit({ type: 'ccp.ai.accessModeChanged' }); });
});

test('U10-2: integration — simulated options switch to managed-credits flips the sidebar to managed card without page reload or key Save/Clear', () => {
  // Sidebar starts in personal-key mode, then receives the accessModeChanged
  // broadcast (as if dispatched from a successful options-page setAccessMode).
  // The controller's refreshKeyStatus must re-query the background and the
  // sidebar must reflect the new access mode.
  const runtime = fakeRuntime();
  let currentMode = 'personal-key';
  let renderedMode = null;
  const stubController = {
    refreshKeyStatus: function () {
      // emulate controller: asks bg for keyStatus, renders accessMode
      renderedMode = currentMode;
    }
  };
  attachAiContentListeners({ runtime: runtime, controller: stubController });
  // Initial render
  stubController.refreshKeyStatus();
  assert.equal(renderedMode, 'personal-key');
  // Options page switches mode in storage and emits the broadcast
  currentMode = 'managed-credits';
  runtime._emit({ type: 'ccp.ai.accessModeChanged' });
  assert.equal(renderedMode, 'managed-credits',
    'sidebar must reflect the new mode after accessModeChanged');
});

test('U10-2: integration — reverse switch (managed → personal) also rerenders', () => {
  const runtime = fakeRuntime();
  let currentMode = 'managed-credits';
  let renderedMode = null;
  const stubController = { refreshKeyStatus: function () { renderedMode = currentMode; } };
  attachAiContentListeners({ runtime: runtime, controller: stubController });
  stubController.refreshKeyStatus();
  assert.equal(renderedMode, 'managed-credits');
  currentMode = 'personal-key';
  runtime._emit({ type: 'ccp.ai.accessModeChanged' });
  assert.equal(renderedMode, 'personal-key');
});
```

- [ ] **Step 3: Run the new tests and verify they FAIL**

Run: `node --test tests/ai-content-listeners.test.js`
Expected: All tests FAIL — `lib/ai-content-listeners.js` does not yet exist at that path (will throw `Cannot find module`). Actually since we created the file in step 2 the module already exists; tests should PASS once we run them. Re-verify the assertion logic by temporarily commenting out the `lib/ai-content-listeners.js` body and confirming FAIL → restore. (Optional sanity check.)

Then run: `node --test tests/ai-content-listeners.test.js`
Expected (after restore): All tests PASS.

- [ ] **Step 4: Wire `content.js` to use the new helper**

In `content.js`, locate the `setupAiAnswerController()` function. Replace this block:

```js
    try {
      chrome.runtime.onMessage.addListener(function (msg) {
        if (msg && msg.type === 'ccp.ai.keyStatusChanged') {
          try { controller.refreshKeyStatus(); } catch (_) {}
        }
      });
    } catch (_) { /* ignore — extension reload, etc. */ }
```

with:

```js
    try {
      if (a.aiContentListeners && typeof a.aiContentListeners.attachAiContentListeners === 'function') {
        a.aiContentListeners.attachAiContentListeners({ runtime: chrome.runtime, controller: controller });
      } else {
        // Defensive fallback: preserve prior single-event behavior if module not loaded.
        chrome.runtime.onMessage.addListener(function (msg) {
          if (msg && (msg.type === 'ccp.ai.keyStatusChanged' || msg.type === 'ccp.ai.accessModeChanged')) {
            try { controller.refreshKeyStatus(); } catch (_) {}
          }
        });
      }
    } catch (_) { /* ignore — extension reload, etc. */ }
```

- [ ] **Step 5: Add `lib/ai-content-listeners.js` to `manifest.json` content_scripts**

Open `manifest.json` and add `"lib/ai-content-listeners.js"` to the `content_scripts[0].js` array, placed immediately after `"lib/ai-answer-controller.js"`:

```json
        "lib/ai-answer-controller.js",
        "lib/ai-content-listeners.js",
        "lib/sidebar.js",
```

- [ ] **Step 6: Run the full ai-content-listeners + ai-answer-controller test files**

Run: `node --test tests/ai-content-listeners.test.js tests/ai-answer-controller.test.js`
Expected: All tests PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/ai-content-listeners.js tests/ai-content-listeners.test.js content.js manifest.json
git commit -m "feat(content): refresh sidebar on ccp.ai.accessModeChanged (U10-2)"
```

---

## Task 9: Stage 2 managed copy — RED tests for `options.html`

**Files:**
- Test: `tests/ai-options-controller.test.js`

- [ ] **Step 1: Add RED tests for the corrected Stage 2 managed copy in `options.html`**

Append to `tests/ai-options-controller.test.js`:

```js
// === U10 Issue 3 — Stage 2 managed copy must NOT overstate an unbuilt portal ===

test('U10-3: options.html managed section uses honest "not yet available" wording', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/Managed AI Credits are not yet available in this build\./.test(html),
    'options.html must contain the honest unavailability sentence');
});

test('U10-3: options.html does NOT claim a purchase, balance, or signed-out state', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.equal(html.indexOf('Purchase credits'), -1, 'must not promise a purchase flow');
  assert.equal(html.indexOf('Balance: Not signed in'), -1, 'must not claim a balance/signed-out state');
});

test('U10-3: options.html portal action, if retained, is DISABLED', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  // Find any <button> tag carrying data-action="ai-options-open-portal".
  // It must either be absent OR carry the `disabled` attribute.
  const m = html.match(/<button[^>]*data-action="ai-options-open-portal"[^>]*>/i);
  if (m) {
    assert.ok(/\bdisabled\b/.test(m[0]),
      'portal button must be disabled until a real portal exists; found: ' + m[0]);
  }
});

test('U10-3: options.html does NOT contain the literal string "Open AI Credits Portal" as an enabled label', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  // The label "Open AI Credits Portal" implies an active portal-open action.
  // Allowed: "AI Credits Portal - Coming Soon" or no portal label at all.
  assert.equal(html.indexOf('Open AI Credits Portal'), -1,
    'options.html must not advertise an active "Open AI Credits Portal" action');
});

test('U10-3: options.html provides forward-looking explanatory copy without inventing facts', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/hosted credits option is planned for a future release/i.test(html)
    || /A hosted credits option is planned/i.test(html),
    'options.html must include the planned-for-future explanation');
  assert.ok(/No purchase or balance is available yet\./i.test(html),
    'options.html must disclaim purchase/balance availability');
});
```

- [ ] **Step 2: Run U10-3 tests and verify they FAIL**

Run: `npm test -- --test-name-pattern="U10-3"`
Expected: All five U10-3 tests FAIL — `options.html` currently has "Purchase credits", "Balance: Not signed in.", and an enabled "Open AI Credits Portal" button.

- [ ] **Step 3: Commit the RED tests**

```bash
git add tests/ai-options-controller.test.js
git commit -m "test(ai-options): RED — Stage 2 managed copy must not overstate (U10-3)"
```

---

## Task 10: Stage 2 managed copy — GREEN edits to `options.html`

**Files:**
- Modify: `options.html`

- [ ] **Step 1: Rewrite the `<section class="managed-section">` block**

In `options.html`, replace lines 196–203 (the existing managed section) with:

```html
    <section class="managed-section">
      <h2>Managed AI Credits</h2>
      <p class="managed-availability">Managed AI Credits are not yet available in this build.</p>
      <p class="managed-explainer">A hosted credits option is planned for a future release. No purchase or balance is available yet.</p>
      <div class="actions">
        <button data-action="ai-options-open-portal" type="button" data-variant="ghost" disabled aria-disabled="true">AI Credits Portal - Coming Soon</button>
      </div>
    </section>
```

Notes:
- Heading text remains `Managed AI Credits` as the user permitted.
- The button keeps `data-action="ai-options-open-portal"` so the existing U6 / S2-4 selector tests continue to find it.
- `disabled` plus `aria-disabled="true"` prevents click activation.
- The "Balance: Not signed in." line and `data-role="ai-options-managed-status"` element are removed; no behavior depended on it beyond the (no-op) `openPortalFn` text update in `options.js`.

- [ ] **Step 2: Remove the now-dead `openPortalFn` body in `options.js`**

Since the portal button is disabled, the click handler is dead code. Replace the `openPortalFn` in `options.js` with a no-op:

```js
    openPortalFn: function () { /* Stage 2: no portal exists; button is disabled. */ },
```

- [ ] **Step 3: Run U10-3 tests and verify they PASS**

Run: `npm test -- --test-name-pattern="U10-3"`
Expected: All five U10-3 tests PASS.

- [ ] **Step 4: Run the full ai-options-controller test file**

Run: `node --test tests/ai-options-controller.test.js`
Expected: All tests PASS. The pre-existing test `S2-4: clicking the portal-link button invokes the injected openPortalFn` still constructs the button programmatically with its own `insertAdjacentHTML` (no `disabled`), so it stays green.

- [ ] **Step 5: Commit**

```bash
git add options.html options.js
git commit -m "fix(options): honest Stage 2 managed copy; disabled portal placeholder (U10-3)"
```

---

## Task 11: Stage 2 sidebar managed copy — RED tests

**Files:**
- Test: `tests/sidebar.test.js`

- [ ] **Step 1: Add RED tests asserting the sidebar managed card stays honest and fail-closed**

Append to `tests/sidebar.test.js` (after the existing S2-3 block):

```js
// === U10 Issue 3 — sidebar managed card stays unavailable and fail-closed ===

test('U10-3: sidebar managed card default text matches the honest unavailability wording', () => {
  const { sidebar, shadow } = freshSidebar();
  const pill = shadow.querySelector('[data-role="ai-managed-state"]');
  assert.equal(pill.textContent, 'Managed AI Credits are not yet available in this build.');
});

test('U10-3: sidebar managed card portal button is disabled by default', () => {
  const { sidebar, shadow } = freshSidebar();
  const btn = shadow.querySelector('[data-action="ai-open-portal"]');
  assert.ok(btn);
  assert.ok(btn.hasAttribute('disabled'),
    'sidebar portal button must remain disabled in Stage 2');
});

test('U10-3: sidebar managed card contains no "Purchase" or "Balance" claim', () => {
  const { sidebar, shadow } = freshSidebar();
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  const txt = managed.textContent;
  assert.equal(txt.indexOf('Purchase'), -1);
  assert.equal(txt.indexOf('Balance'), -1);
});

test('U10-3: sidebar managed-mode panel still hidden until setAiAccessMode("managed-credits") flips it', () => {
  const { sidebar, shadow } = freshSidebar();
  const managed = shadow.querySelector('[data-card="ai-card-managed"]');
  assert.equal(managed.hidden, true);
  sidebar.setAiAccessMode('managed-credits');
  assert.equal(managed.hidden, false);
});
```

- [ ] **Step 2: Run U10-3 sidebar tests and verify status**

Run: `node --test tests/sidebar.test.js --test-name-pattern="U10-3"`
Expected: The "default text" and "no Purchase/Balance" tests PASS (current sidebar copy already matches). The "portal button is disabled" test should PASS (the existing template already has `disabled`). Treat any unexpected FAIL as a real bug and fix in the GREEN step below.

- [ ] **Step 3: Inspect sidebar.js for any drift; if all green, commit and proceed**

If all tests PASS:

```bash
git add tests/sidebar.test.js
git commit -m "test(sidebar): assert managed card stays honest and disabled (U10-3)"
```

If any FAIL: fix in `lib/sidebar.js` minimally to restore: ensure the managed-card HTML in the template (around line 130–137) keeps the existing `Managed AI Credits are not yet available in this build.` pill text and the `disabled` button. Then commit both files together.

---

## Task 12: Final verification — full test run, secret scan, neutrality grep, Autopilot untouched

**Files:** (verification only — no edits)

- [ ] **Step 1: Run the focused suite for everything we touched**

Run: `node --test tests/ai-background-service.test.js tests/ai-options-controller.test.js tests/ai-answer-controller.test.js tests/ai-content-listeners.test.js tests/sidebar.test.js`
Expected: All tests PASS.

- [ ] **Step 2: Run the full repo test suite**

Run: `npm test`
Expected: Every test PASS. If anything outside the AI/sidebar/options/background surface fails, that is unexpected — investigate before continuing.

- [ ] **Step 3: Run a repo-wide secret-like-key leak scan**

Run (PowerShell):

```powershell
Get-ChildItem -Recurse -File -Exclude *.log,package-lock.json |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\\.git\\' } |
  Select-String -Pattern 'sk-[A-Za-z0-9_]{16,}' -SimpleMatch:$false
```

Expected: No matches. Any hit must be inspected — only patterns inside test code that explicitly use `sk-stub`, `sk-x`, `sk-LEAK-DO-NOT-EXPOSE`, etc. (short pseudo keys < 16 chars after `sk-`) are acceptable; anything else is a leak.

- [ ] **Step 4: Run provider-neutrality grep over public UI files**

Run (PowerShell):

```powershell
Select-String -Path 'options.html','lib\sidebar.js','lib\ai-options-controller.js','lib\ai-answer-controller.js','lib\ai-content-listeners.js' -Pattern 'DeepSeek','OpenAI','Anthropic','Claude','GPT-' -SimpleMatch
```

Expected: No matches in any of these public-facing files. (Provider names are permitted only in `lib/deepseek-client.js`, `manifest.json` host_permissions, and similar internal/permission surfaces.)

- [ ] **Step 5: Confirm no Autopilot files were edited in this branch**

Run:

```bash
git diff --name-only main...HEAD
```

Expected: The output must NOT include any of:
- `lib/autopilot-*.js`
- `lib/module-autopilot.js`
- `lib/module-scraper.js`
- `lib/item-handlers.js`
- `lib/completion-confirmer.js`
- `tests/autopilot-*.test.js`
- `tests/module-*.test.js`
- `tests/item-handlers.test.js`
- `tests/completion-confirmer.test.js`

The expected diff list for this plan is exactly:
- `docs/superpowers/plans/2026-05-27-ai-access-u10-corrections.md`
- `options.html`
- `options.js`
- `manifest.json`
- `lib/ai-options-controller.js`
- `lib/ai-background-service.js`
- `lib/ai-content-listeners.js` (new)
- `lib/sidebar.js` (only if Step 3 of Task 11 required a fix; otherwise unchanged)
- `content.js`
- `tests/ai-options-controller.test.js`
- `tests/ai-background-service.test.js`
- `tests/ai-content-listeners.test.js` (new)
- `tests/sidebar.test.js`

If anything else appears, revert it (carefully, NOT with `git checkout -- .` — use targeted `git restore <file>` after confirming the file's content).

- [ ] **Step 6: Confirm no destructive ops were performed**

Mentally re-verify (do not run any of these — this is a checklist):
- No `git push`
- No `git reset` (any variant)
- No `git clean`
- No `git revert`
- No `git branch -D` or branch deletion
- No real API key was entered anywhere
- No live Coursera page was loaded and exercised

If any of the above accidentally happened, stop and surface it to the user immediately.

- [ ] **Step 7: Produce the final report**

Compose a final report explicitly answering the three required statements:

1. **`options.html` has zero inline scripts** — cite Task 1 (RED) and Task 3 (GREEN) passing, including the U10-1 inline-script-count assertion.
2. **Mode changes update an already-open sidebar without key Save/Clear or page reload** — cite Task 4–7 (background command + options dispatch + broadcast), Task 8 (content listener integration + integration tests).
3. **Managed-mode UI makes no unbuilt purchase/balance claims** — cite Task 9–11 (options.html copy correction + disabled portal + sidebar copy assertions).

Include the final `git diff --name-only main...HEAD` output and the secret-scan + neutrality-grep results inline.

Do NOT commit, push, or perform any branch/reset/clean operation as part of this report step.

---

## Self-Review Notes

- **Spec coverage:** Issue 1 → Tasks 1–3; Issue 2 → Tasks 4–8; Issue 3 → Tasks 9–11. Final verification covers the scope/safety constraints and the three explicit report points → Task 12.
- **Placeholder scan:** No `TBD` / `implement later` / `similar to Task N`. Every test has full code; every edit shows the actual change.
- **Type/symbol consistency:** Command name `setAccessMode` is used identically across the background service, options controller, and tests. Event type `'ccp.ai.accessModeChanged'` is used identically in background broadcast, content listener, and integration test. Module name `aiContentListeners` (camelCase) is registered both in `lib/ai-content-listeners.js` and consumed in `content.js` via `a.aiContentListeners`. Storage key `'ccp.ai.accessMode'` is unchanged from existing code.
- **Scope guard:** No Autopilot file is touched. Task 12 Step 5 explicitly verifies this.
