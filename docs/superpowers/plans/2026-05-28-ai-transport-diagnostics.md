# AI Transport Diagnostics + Default Model Fallback — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the actual DeepSeek API failure so we can see WHY Generate is returning `invalid-response`, and change the default model to a known-working name (`deepseek-chat`) since the current default `deepseek-v4-flash` is likely the cause of the failure.

**Architecture:** Three production changes. (1) `lib/deepseek-client.js` captures up to 240 chars of the response body when an HTTP status is non-OK and includes that in `res.detail`, plus captures the first 240 chars of the raw text on `JSON.parse` failure (still classified as `invalid-response` but with a body excerpt). (2) `lib/deepseek-client.js` defaults to `deepseek-chat` (DeepSeek's canonical non-deprecated chat model name) instead of `deepseek-v4-flash` (which is almost certainly the source of the live failure — DeepSeek's public API does not currently accept that name). (3) `lib/ai-answer-controller.js` adds `console.warn` for transport-level `!res.ok` and embeds `res.detail` in the user-visible apply-result message so the sidebar actually shows what went wrong.

**Tech Stack:** Vanilla JS (MV3 content script + service worker), `node:test`, `jsdom`. No build step.

---

## Scope Guard

- **Production files allowed:** `lib/deepseek-client.js`, `lib/ai-answer-controller.js`.
- **Test files allowed:** `tests/deepseek-client.test.js`, `tests/ai-answer-controller.test.js`.
- **Frozen:** everything else — validator, sidebar, question-context, ai-background-service, manifest, options page, all autopilot files.
- No new manifest permissions / host_permissions changes.
- No real API key entered.

---

## Task 1: Capture failing response body in `lib/deepseek-client.js`

**Files:**
- Test (append): `tests/deepseek-client.test.js`
- Modify: `lib/deepseek-client.js` (the `if (!resp.ok)` branch around line 111 and the `JSON.parse(txt)` catch around line 116)

- [ ] **Step 1: Append U18-D tests to `tests/deepseek-client.test.js`**

The file already has helpers `makeFetch`, `makeResponse`, and a `SNAP` fixture at top. Append at end of file. Note: `makeResponse` currently only returns a JSON-body response; we need a variant that returns a non-OK status with a raw text body. Define `makeResponseText(status, rawBody)` inline in each test rather than refactoring the global helper.

```js
// === U18: deepseek-client transport diagnostics ===

test('U18-D1: HTTP non-OK includes response body excerpt in res.detail', async () => {
  const f = makeFetch(function () {
    return Promise.resolve({
      ok: false,
      status: 400,
      text: function () { return Promise.resolve('{"error":{"message":"Model not found: deepseek-v4-flash","type":"invalid_request_error"}}'); },
    });
  });
  const c = createClient({ fetchFn: f });
  const r = await c.generateAnswers(SNAP, 'sk-fake');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-response');
  assert.ok(typeof r.detail === 'string', 'detail must be a string; got: ' + JSON.stringify(r));
  assert.ok(r.detail.indexOf('http 400') !== -1, 'detail must include HTTP status; got: ' + JSON.stringify(r.detail));
  assert.ok(r.detail.indexOf('Model not found') !== -1,
    'detail must include the response body excerpt so the UI can surface the real reason; got: ' + JSON.stringify(r.detail));
});

test('U18-D2: HTTP 200 with non-JSON body sets reason invalid-response with body excerpt in detail', async () => {
  const f = makeFetch(function () {
    return Promise.resolve({
      ok: true,
      status: 200,
      text: function () { return Promise.resolve('<html>Service Unavailable</html>'); },
    });
  });
  const c = createClient({ fetchFn: f });
  const r = await c.generateAnswers(SNAP, 'sk-fake');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid-response');
  assert.ok(typeof r.detail === 'string', 'detail must be set when JSON.parse fails');
  assert.ok(/Service Unavailable|<html>/i.test(r.detail),
    'detail must include a body excerpt; got: ' + JSON.stringify(r.detail));
});

test('U18-D3: HTTP non-OK body excerpt is truncated to <=240 chars', async () => {
  var huge = '{"error":{"message":"' + 'X'.repeat(5000) + '"}}';
  const f = makeFetch(function () {
    return Promise.resolve({
      ok: false,
      status: 400,
      text: function () { return Promise.resolve(huge); },
    });
  });
  const c = createClient({ fetchFn: f });
  const r = await c.generateAnswers(SNAP, 'sk-fake');
  assert.equal(r.ok, false);
  assert.ok(typeof r.detail === 'string');
  assert.ok(r.detail.length <= 280, 'detail must be reasonably short (<=280 chars total); got length ' + r.detail.length);
});

test('U18-D4: HTTP 401 still classifies as unauthorized AND now includes body excerpt', async () => {
  const f = makeFetch(function () {
    return Promise.resolve({
      ok: false,
      status: 401,
      text: function () { return Promise.resolve('{"error":{"message":"Invalid Authentication"}}'); },
    });
  });
  const c = createClient({ fetchFn: f });
  const r = await c.generateAnswers(SNAP, 'sk-fake');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unauthorized');
  assert.ok(r.detail.indexOf('Invalid Authentication') !== -1,
    'unauthorized errors should also include the body excerpt so the user can see WHY the key was rejected');
});

test('U18-D5: default model is "deepseek-chat" (known-working canonical name)', async () => {
  let captured = null;
  const f = makeFetch(function (url, init) {
    try { captured = JSON.parse(init.body); } catch (_) {}
    return makeResponse(200, { choices: [{ message: { content: JSON.stringify({ answers: [] }) } }] });
  });
  const c = createClient({ fetchFn: f });
  await c.generateAnswers(SNAP, 'sk-fake');
  assert.equal(captured && captured.model, 'deepseek-chat',
    'default model must be "deepseek-chat"; got: ' + JSON.stringify(captured && captured.model));
});

test('U18-D6: explicit model override via createClient still works', async () => {
  let captured = null;
  const f = makeFetch(function (url, init) {
    try { captured = JSON.parse(init.body); } catch (_) {}
    return makeResponse(200, { choices: [{ message: { content: JSON.stringify({ answers: [] }) } }] });
  });
  const c = createClient({ fetchFn: f, model: 'deepseek-reasoner' });
  await c.generateAnswers(SNAP, 'sk-fake');
  assert.equal(captured && captured.model, 'deepseek-reasoner');
});
```

- [ ] **Step 2: Run U18-D tests and confirm failures**

Run: `node --test --test-name-pattern="U18-D" tests/deepseek-client.test.js`

Expected: U18-D1 FAILS (`r.detail` currently is `'http 400'` only, no body excerpt). U18-D2 FAILS (`r.detail` is undefined when JSON.parse fails). U18-D3 FAILS (no truncation logic yet). U18-D4 FAILS (`detail` is `'http 401'` only). U18-D5 FAILS (current default is `'deepseek-v4-flash'`). U18-D6 PASSES (explicit model override already works).

- [ ] **Step 3: Update `DEFAULT_MODEL` and the `!resp.ok` / JSON-parse branches in `lib/deepseek-client.js`**

Open `lib/deepseek-client.js`. Find the constant:

```js
var DEFAULT_MODEL      = 'deepseek-v4-flash';
```

Replace with:

```js
// deepseek-chat is the canonical chat completion model (DeepSeek-V3 series) and is
// the most-stable default. deepseek-reasoner (R1 series) is also available via the
// `model` override option. Earlier defaults (e.g., `deepseek-v4-flash`) returned
// HTTP 400 "Model not found" from the live API.
var DEFAULT_MODEL      = 'deepseek-chat';
```

Also remove the now-misleading "deepseek-v4-flash is the current recommended model" comment block (the 3 lines starting `// deepseek-v4-flash is the current recommended model (2026-05-26).` and `// deepseek-chat was its legacy alias and is deprecated 2026/07/24 per api-docs.deepseek.com.`).

Find the `if (!resp.ok)` branch (around line 111):

```js
if (!resp.ok) {
  return { ok: false, reason: classifyHttp(resp.status), detail: 'http ' + resp.status, elapsedMs: Date.now() - startedAt };
}
```

Replace with:

```js
if (!resp.ok) {
  // Read the response body so we can surface the real cause (e.g., "Model not found")
  // in the controller's console.warn and the sidebar's apply-result message.
  return resp.text().then(function (errBody) {
    var bodyExcerpt = (errBody == null ? '' : String(errBody)).slice(0, 240);
    return { ok: false, reason: classifyHttp(resp.status), detail: 'http ' + resp.status + ' ' + bodyExcerpt, elapsedMs: Date.now() - startedAt };
  }).catch(function () {
    return { ok: false, reason: classifyHttp(resp.status), detail: 'http ' + resp.status, elapsedMs: Date.now() - startedAt };
  });
}
```

Find the `JSON.parse(txt)` catch (around line 116):

```js
return resp.text().then(function (txt) {
  var outer;
  try { outer = JSON.parse(txt); } catch (_) {
    return { ok: false, reason: 'invalid-response', elapsedMs: Date.now() - startedAt };
  }
  var content = outer && outer.choices && outer.choices[0] &&
                outer.choices[0].message && outer.choices[0].message.content;
  if (typeof content !== 'string') {
    return { ok: false, reason: 'invalid-response', elapsedMs: Date.now() - startedAt };
  }
```

Replace with:

```js
return resp.text().then(function (txt) {
  var outer;
  try { outer = JSON.parse(txt); } catch (_) {
    var rawExcerpt = (txt == null ? '' : String(txt)).slice(0, 240);
    return { ok: false, reason: 'invalid-response', detail: 'non-json body: ' + rawExcerpt, elapsedMs: Date.now() - startedAt };
  }
  var content = outer && outer.choices && outer.choices[0] &&
                outer.choices[0].message && outer.choices[0].message.content;
  if (typeof content !== 'string') {
    var outerExcerpt = JSON.stringify(outer).slice(0, 240);
    return { ok: false, reason: 'invalid-response', detail: 'missing choices[0].message.content: ' + outerExcerpt, elapsedMs: Date.now() - startedAt };
  }
```

- [ ] **Step 4: Re-run U18-D tests — confirm 6/6 PASS**

Run: `node --test --test-name-pattern="U18-D" tests/deepseek-client.test.js`

Expected: 6 pass.

- [ ] **Step 5: Run the full deepseek-client test file (regression)**

Run: `node --test tests/deepseek-client.test.js`

Expected: every test PASSES. Pre-existing tests that don't override the model name might assert `model: 'deepseek-v4-flash'`. If any test does that, update the assertion to `'deepseek-chat'` — see Step 5a.

- [ ] **Step 5a: Spot-update any pre-existing test asserting the old model name**

Run: `grep -n "deepseek-v4-flash\|deepseek-chat" tests/deepseek-client.test.js`

If any pre-existing test asserts `'deepseek-v4-flash'` as the model, update to `'deepseek-chat'`. Do NOT add new tests in this step; only update assertions that would otherwise fail because the default changed.

- [ ] **Step 6: Commit**

```
git add lib/deepseek-client.js tests/deepseek-client.test.js
git commit -m "fix(deepseek-client): default to deepseek-chat + capture response body excerpt on HTTP/parse failure"
```

---

## Task 2: Surface `res.detail` in controller console.warn + UI

**Files:**
- Test (append): `tests/ai-answer-controller.test.js`
- Modify: `lib/ai-answer-controller.js` (`performGenerate` response callback `!res.ok` branch around line 70; `aiServiceErrorMessage` around line 143)

- [ ] **Step 1: Append U18-C tests to `tests/ai-answer-controller.test.js`**

```js
// === U18: transport-error diagnostics in performGenerate ===

test('U18-C1: transport !res.ok → console.warn with reason + detail; apply-result message includes detail excerpt', async () => {
  const benignLoc = {
    href: 'https://www.coursera.org/learn/x/lecture/v1/intro',
    pathname: '/learn/x/lecture/v1/intro',
    origin: 'https://www.coursera.org',
  };
  const doc = { body: {}, querySelector: function () { return null; } };
  const snap = {
    token: 't1', page: { eligible: true, blockedReason: null },
    questions: [{ id: 'q1', order: 1, questionNumber: 1, type: 'single_choice', supported: true, alreadyAnswered: false, options: [{ id: 'q1o0', label: 'A' }] }],
    supportedCount: 1, unsupportedCount: 0, actionableCount: 1, localGuard: [],
  };
  const qc = {
    buildQuestionSnapshot: function () { return snap; },
    sanitizeForRequest: function (s) { return s; },
    isCurrentPageBlocked: function () { return { blocked: false, reason: null }; },
    compareLocalGuards: function () { return { changed: false }; },
  };
  const fakeSidebar = makeBlockedPageFakeSidebar();
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: qc,
    validator: { validateAndMap: function () { throw new Error('validator must not run on transport failure'); } },
    answerApplier: { applyStructuredAnswers: function () { throw new Error('must not apply'); } },
    messenger: { send: function (cmd, p, cb) {
      if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: true, accessMode: 'personal-key' });
      cb({ ok: false, reason: 'invalid-response', detail: 'http 400 {"error":{"message":"Model not found: deepseek-v4-flash"}}' });
    } },
    document: doc, location: benignLoc,
    openOptionsFn: function (cb) { if (cb) cb({ ok: true }); },
  });
  ctrl.wire();
  ctrl.performScan();

  const origWarn = console.warn;
  const warns = [];
  console.warn = function () { warns.push(Array.prototype.slice.call(arguments)); };
  try {
    ctrl.performGenerate();
    await new Promise(function (r) { setTimeout(r, 0); });
  } finally { console.warn = origWarn; }

  const applyResult = fakeSidebar._getLastApplyResult();
  assert.ok(applyResult && typeof applyResult.message === 'string', 'apply-result must have a message');
  assert.ok(/Model not found|deepseek-v4-flash/i.test(applyResult.message),
    'apply-result message must include the detail excerpt; got: ' + JSON.stringify(applyResult.message));

  const warned = warns.some(function (a) {
    var s = JSON.stringify(a);
    return s.indexOf('invalid-response') !== -1 && s.indexOf('Model not found') !== -1;
  });
  assert.ok(warned, 'console.warn must include reason + detail; got: ' + JSON.stringify(warns));
});

test('U18-C2: transport failure without detail still surfaces a useful message (no crash)', async () => {
  const benignLoc = {
    href: 'https://www.coursera.org/learn/x/lecture/v1/intro',
    pathname: '/learn/x/lecture/v1/intro',
    origin: 'https://www.coursera.org',
  };
  const doc = { body: {}, querySelector: function () { return null; } };
  const snap = {
    token: 't1', page: { eligible: true, blockedReason: null },
    questions: [{ id: 'q1', order: 1, questionNumber: 1, type: 'single_choice', supported: true, alreadyAnswered: false, options: [{ id: 'q1o0', label: 'A' }] }],
    supportedCount: 1, unsupportedCount: 0, actionableCount: 1, localGuard: [],
  };
  const qc = {
    buildQuestionSnapshot: function () { return snap; },
    sanitizeForRequest: function (s) { return s; },
    isCurrentPageBlocked: function () { return { blocked: false, reason: null }; },
    compareLocalGuards: function () { return { changed: false }; },
  };
  const fakeSidebar = makeBlockedPageFakeSidebar();
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: qc,
    validator: { validateAndMap: function () { throw new Error('must not run'); } },
    answerApplier: { applyStructuredAnswers: function () { throw new Error('must not apply'); } },
    messenger: { send: function (cmd, p, cb) {
      if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: true, accessMode: 'personal-key' });
      cb({ ok: false, reason: 'network' });
    } },
    document: doc, location: benignLoc,
    openOptionsFn: function (cb) { if (cb) cb({ ok: true }); },
  });
  ctrl.wire();
  ctrl.performScan();

  const origWarn = console.warn;
  console.warn = function () {};
  try {
    ctrl.performGenerate();
    await new Promise(function (r) { setTimeout(r, 0); });
  } finally { console.warn = origWarn; }

  const applyResult = fakeSidebar._getLastApplyResult();
  assert.ok(applyResult && typeof applyResult.message === 'string');
  assert.ok(/network/i.test(applyResult.message),
    'no-detail failure should still surface the reason; got: ' + JSON.stringify(applyResult.message));
});

test('U18-C3: happy path (res.ok === true) is unchanged — no console.warn', async () => {
  const benignLoc = {
    href: 'https://www.coursera.org/learn/x/lecture/v1/intro',
    pathname: '/learn/x/lecture/v1/intro',
    origin: 'https://www.coursera.org',
  };
  const doc = { body: {}, querySelector: function () { return null; } };
  const snap = {
    token: 't1', page: { eligible: true, blockedReason: null },
    questions: [{ id: 'q1', order: 1, questionNumber: 1, type: 'single_choice', supported: true, alreadyAnswered: false, options: [{ id: 'q1o0', label: 'A' }] }],
    supportedCount: 1, unsupportedCount: 0, actionableCount: 1, localGuard: [],
  };
  const qc = {
    buildQuestionSnapshot: function () { return snap; },
    sanitizeForRequest: function (s) { return s; },
    isCurrentPageBlocked: function () { return { blocked: false, reason: null }; },
    compareLocalGuards: function () { return { changed: false }; },
  };
  const validator = {
    validateAndMap: function () { return { ok: true, suggestions: [{ questionNumber: 1, type: 'single_choice', mappingStatus: 'matched', applicable: true, choiceText: 'A' }], rejectedCount: 0 }; },
  };
  const fakeSidebar = makeBlockedPageFakeSidebar();
  const ctrl = createAiController({
    sidebar: fakeSidebar,
    questionContext: qc,
    validator: validator,
    answerApplier: { applyStructuredAnswers: function () { throw new Error('must not apply'); } },
    messenger: { send: function (cmd, p, cb) { if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: true, accessMode: 'personal-key' }); cb({ ok: true, raw: { answers: [] } }); } },
    document: doc, location: benignLoc,
    openOptionsFn: function (cb) { if (cb) cb({ ok: true }); },
  });
  ctrl.wire();
  ctrl.performScan();

  const origWarn = console.warn;
  const warns = [];
  console.warn = function () { warns.push(arguments); };
  try {
    ctrl.performGenerate();
    await new Promise(function (r) { setTimeout(r, 0); });
  } finally { console.warn = origWarn; }

  assert.equal(warns.length, 0, 'happy path must not emit console.warn');
});
```

- [ ] **Step 2: Run U18-C tests — confirm failures**

Run: `node --test --test-name-pattern="U18-C" tests/ai-answer-controller.test.js`

Expected: U18-C1 FAILS (current message is generic "could not be safely applied"; no console.warn on transport errors). U18-C2 FAILS or PASSES depending on whether `aiServiceErrorMessage('network')` returns a 'network'-containing string (it does — `'AI request failed: network.'`). U18-C3 PASSES already (no warn on happy path).

- [ ] **Step 3: Update `performGenerate`'s `!res.ok` branch + `aiServiceErrorMessage`**

Find the `!res.ok` branch in `performGenerate`'s callback (around lines 71-75):

```js
if (!res || !res.ok) {
  var msg = (res && res.reason) ? aiServiceErrorMessage(res.reason) : 'AI request failed.';
  sidebar.setAiSuggestions([]);
  if (sidebar.setAiApplyResult) sidebar.setAiApplyResult({ filled: 0, failed: 0, message: msg });
  return;
}
```

Replace with:

```js
if (!res || !res.ok) {
  try { console.warn('[ai-answer-controller] transport error:', res && res.reason, 'detail:', res && res.detail); } catch (_) {}
  var msg = (res && res.reason) ? aiServiceErrorMessage(res.reason, res.detail) : 'AI request failed.';
  sidebar.setAiSuggestions([]);
  if (sidebar.setAiApplyResult) sidebar.setAiApplyResult({ filled: 0, failed: 0, message: msg });
  return;
}
```

Find `aiServiceErrorMessage` (around line 143):

```js
function aiServiceErrorMessage(reason) {
  switch (reason) {
    case 'missing-key': return 'Enter an AI API Key before generating suggestions.';
    case 'unauthorized': return 'The AI service rejected the API key. Check the key and try again.';
    case 'rate-limit': return 'AI request failed: rate limit.';
    case 'server-error': return 'AI request failed: server error.';
    case 'network': return 'AI request failed: network.';
    case 'timeout': return 'AI request failed: timed out.';
    case 'aborted': return 'AI request was cancelled.';
    case 'invalid-response': return 'The AI service returned an answer format that could not be safely applied.';
    case 'managed-not-implemented': return 'Managed AI Credits are not yet available in this build.';
    default: return 'AI request failed: ' + reason + '.';
  }
}
```

Replace with:

```js
function aiServiceErrorMessage(reason, detail) {
  // Append a short, sanitized detail excerpt (when present) so the user can see
  // the real cause (e.g., "Model not found", "Invalid Authentication") in the sidebar
  // instead of just the abstract reason.
  function withDetail(base) {
    if (typeof detail !== 'string' || detail.length === 0) return base;
    return base + ' (' + detail.slice(0, 200) + ')';
  }
  switch (reason) {
    case 'missing-key': return 'Enter an AI API Key before generating suggestions.';
    case 'unauthorized': return withDetail('The AI service rejected the API key. Check the key and try again.');
    case 'rate-limit': return withDetail('AI request failed: rate limit.');
    case 'server-error': return withDetail('AI request failed: server error.');
    case 'network': return withDetail('AI request failed: network.');
    case 'timeout': return 'AI request failed: timed out.';
    case 'aborted': return 'AI request was cancelled.';
    case 'invalid-response': return withDetail('The AI service returned an unexpected response.');
    case 'managed-not-implemented': return 'Managed AI Credits are not yet available in this build.';
    default: return withDetail('AI request failed: ' + reason + '.');
  }
}
```

Changes:
- New second parameter `detail`.
- New inner helper `withDetail(base)` that appends ` (detail)` when detail is a non-empty string.
- Most reasons that benefit from detail get the wrap (unauthorized, rate-limit, server-error, network, invalid-response, default).
- `'invalid-response'` is rephrased from "could not be safely applied" (which conflicts with the validator-side message) to "returned an unexpected response" — clearer semantically.
- `missing-key`, `timeout`, `aborted`, `managed-not-implemented` don't carry detail (no useful body to include).

- [ ] **Step 4: Re-run U18-C tests — confirm 3/3 PASS**

Run: `node --test --test-name-pattern="U18-C" tests/ai-answer-controller.test.js`

Expected: 3 pass.

- [ ] **Step 5: Run the full controller test file (regression)**

Run: `node --test tests/ai-answer-controller.test.js`

Expected: every test PASSES. The previously-existing `C4: validator-invalid` test does NOT go through this path (it's the validator-level branch, not transport), so it stays green. The U17-C and U14-B6 tests are unaffected.

If any pre-existing test asserts the exact old message text `'The AI service returned an answer format that could not be safely applied.'` against the `invalid-response` path, update its assertion to match the new text `/returned an unexpected response/i`.

- [ ] **Step 6: Commit**

```
git add lib/ai-answer-controller.js tests/ai-answer-controller.test.js
git commit -m "feat(ai-answer-controller): surface transport-error detail in console + apply-result message"
```

---

## Task 3: Full repo regression + verification

**Files:** none modified.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: every test PASSES. Net count change: +9 (6 U18-D + 3 U18-C). Any pre-existing tests that asserted `'deepseek-v4-flash'` or the exact `'could not be safely applied'` text under the `invalid-response` path were updated in Tasks 1 and 2.

- [ ] **Step 2: Autopilot regression**

Run: `node --test tests/autopilot-state.test.js tests/autopilot-timing.test.js tests/completion-confirmer.test.js tests/item-handlers.test.js tests/module-autopilot.test.js tests/module-scraper.test.js`

Expected: every test PASSES (autopilot files untouched).

- [ ] **Step 3: Provider-neutrality grep**

Run: `grep -nE "DeepSeek|OpenAI|Anthropic|Claude|GPT-" lib/sidebar.js lib/ai-options-controller.js lib/ai-answer-controller.js lib/ai-content-listeners.js lib/ai-open-options-content.js lib/ai-open-options-background.js lib/ai-question-context.js lib/ai-answer-validator.js lib/ui-revision.js options.html`

Expected: zero matches.

- [ ] **Step 4: Real-key leak scan**

Run: `grep -rE "sk-[A-Za-z0-9_]{16,}" --include="*.js" --include="*.json" --include="*.html" --include="*.md" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=Reference .`

Expected: zero matches.

- [ ] **Step 5: Final commit summary**

Run: `git log --oneline -3`

Expected:
1. `feat(ai-answer-controller): surface transport-error detail in console + apply-result message`
2. `fix(deepseek-client): default to deepseek-chat + capture response body excerpt on HTTP/parse failure`

---

## Task 4: Live Chrome verification (user-driven)

**Files:** none modified.

- [ ] **Step 1: Reload the extension at `chrome://extensions`**

- [ ] **Step 2: Open the AI Answers tab → ensure the API key is configured (the "Remember on this browser" checkbox now defaults checked from the prior fix)**

- [ ] **Step 3: Navigate to a Coursera quiz, Scan → Generate suggestions**

Expected:
- If the model name was the original problem, Generate now succeeds and suggestions appear.
- If something else is wrong, the sidebar apply-result message now contains a detail excerpt — e.g., `'AI request failed: ... (http 401 {"error":...})'`, and DevTools Console shows `[ai-answer-controller] transport error: <reason> detail: <detail>`. Report the detail string back and a follow-up plan can target the next gap.

---

## Self-Review Notes

- **Spec coverage:**
  - User pain: still seeing "could not be safely applied" message → diagnosed as transport-level `'invalid-response'`. Task 1 captures the actual response body; Task 2 surfaces it in console + UI.
  - User requirement: fix the underlying failure. Task 1 Step 3 changes default model from likely-broken `deepseek-v4-flash` to known-working `deepseek-chat`.
  - User requirement: tests. Tasks 1, 2 add 9 tests covering the diagnostics + model default + a backward-compat override case.
  - User requirement: `npm test`. Task 3 Step 1.

- **Placeholder scan:** every step has full code or exact commands with expected output. No "TODO", "TBD", or "similar to Task N".

- **Type / symbol consistency:**
  - `aiServiceErrorMessage(reason, detail)` — defined Task 2 Step 3, callsite updated to pass `res.detail` in same step.
  - `withDetail(base)` — file-local inner helper.
  - `DEFAULT_MODEL` literal `'deepseek-chat'` — used in Task 1 Step 3 production + Task 1 Step 1 test U18-D5.
  - `res.detail` — produced by Task 1's HTTP/parse-failure branches, consumed by Task 2's `aiServiceErrorMessage`.
  - U18-D (deepseek-client) and U18-C (controller) prefixes — grep-able and distinct.

- **Scope:** two production files, two test files. Validator, sidebar, question-context, options page, manifest, autopilot — all untouched.
