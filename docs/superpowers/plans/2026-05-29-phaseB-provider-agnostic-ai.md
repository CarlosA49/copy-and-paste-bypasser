# Provider-Agnostic AI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded DeepSeek background AI client with a pluggable, background-safe provider adapter registry (`window.ClipboardCleaner.aiProviders`) supporting OpenAI, Anthropic, Gemini, DeepSeek, and a custom OpenAI-compatible endpoint, while keeping the API key server-side, preserving the `{ok, raw}` contract, and surfacing provider/model selection in the options UI.

**Architecture:** A new no-DOM `lib/ai-providers.js` module exposes `aiProviders.get(id)` / `aiProviders.list()`, each adapter implementing `buildRequest(snapshot, key, opts) -> {url, method, headers, body}` and `parseResponse(jsonOrText) -> {ok, raw}` reusing the DeepSeek transport scaffolding (timeout, AbortController, `classifyHttp`, reasons). `ai-background-service.js` re-resolves the adapter per `generateAnswers` call from the injected `storageLocal` key `ccp.ai.provider` (with per-provider model `ccp.ai.model.{provider}`) and gains a `setProvider` command gated exactly like `setAccessMode`. The options page and `ai-options-controller.js` gain a provider `<select>`, a model field with datalist, and a custom base-URL field; the manifest gains per-provider `host_permissions` plus `optional_host_permissions` for the custom endpoint. The API key only ever appears in request headers and is never returned to any content script.

**Tech Stack:** Chrome MV3 content scripts + service worker, IIFE modules registered on `window.ClipboardCleaner.*` (with a `module.exports` tail for CommonJS), `node --test` with `node:assert/strict`, jsdom for DOM-touching tests (this phase's new pure tests need no jsdom).

**Scope boundary (deferred to Phase C):** Per WS-B spec line 148 ("System prompt is generalized … it requests a typed answer schema"), the generalized `SYSTEM_PROMPT` in this phase covers exactly four answer kinds — `single_choice`, `multiple_choice`, `math_input`, and `free_text`. Expanding the typed schema to the remaining question kinds (`dropdown`, `matching`, `ordering`, `code`, `file_upload`) is intentionally OUT OF SCOPE here and is deferred to Phase C (WS-C question-type system). A reviewer should NOT expect those types in this plan's prompt or tests.

---

## File Structure

| File | Create/Modify | Single responsibility |
|---|---|---|
| `lib/ai-providers.js` | **Create** | No-DOM adapter registry. `aiProviders.get(id)` / `aiProviders.list()`; each adapter exposes `id/label/defaultModel/models/endpoint(opts)/buildRequest(snapshot, key, opts)/parseResponse(jsonOrText)` and a `transport`-based `createClient(opts)` wrapper that fetches + normalizes to `{ok, raw}`. Houses the shared transport (timeout, AbortController, `classifyHttp`, reason mapping) refactored from `deepseek-client.js`. |
| `tests/ai-providers.test.js` | **Create** | Pure `node:test` + mocked fetch. Per-adapter `buildRequest` shape (URL/method/headers/body), `parseResponse` `{ok, raw}` normalization, custom base-URL handling, key-never-leaks assertions, registry `get`/`list`, and full transport `createClient(...).generateAnswers(...)` per provider. |
| `lib/deepseek-client.js` | **Modify** (`L4-160`) | Keep exporting `createClient` (back-compat for `tests/deepseek-client.test.js`) by delegating to the `deepseek` adapter inside `ai-providers.js` when available, with a self-contained fallback so the file still works if loaded alone. Preserves `SYSTEM_PROMPT`, body shape, `{ok, raw}`, `classifyHttp`. |
| `lib/ai-background-service.js` | **Modify** (`L11-216`) | Add the `aiProviders` dep; re-resolve the adapter-backed client per `generateAnswers` call by reading `ccp.ai.provider`/`ccp.ai.model.{provider}`/`ccp.ai.baseUrl` from the injected `storageLocal`; add a `setProvider` command (gated by `canManageSecrets`, broadcasts `ccp.ai.providerChanged`). `clientFactory` remains supported as the fallback so existing tests stay green. |
| `lib/ai-options-controller.js` | **Modify** (`L21-165`) | Wire a provider `<select>`, model `<input>`+datalist, and custom base-URL field; read `ccp.ai.provider`/`ccp.ai.model.{provider}` from storage and apply; persist provider via `messenger.send('setProvider', …)` (never direct page storage write); show/hide base-URL field for custom. Status wording stays provider-neutral. |
| `options.html` | **Modify** (`L166-203`, `L213-215`) | Add provider `<select>` (`data-role="ai-options-provider"`), model `<input>` + `<datalist>` (`data-role="ai-options-model"`), and a custom base-URL field (`data-role="ai-options-base-url"`, in a container `data-role="ai-options-base-url-row"`). Add `<script src="lib/ai-providers.js">` as the first script (before `ai-options-controller.js` and `options.js`) so the page exposes the canonical provider registry. No inline scripts; no `DeepSeek` in static markup; no real `sk-` key. Existing selectors/heading preserved. |
| `background.js` | **Modify** (`L8-15`, `L65-137`) | Add `lib/ai-providers.js` to `importScripts` (before `deepseek-client.js`); wire the `aiProviders` registry and the strict `canManageSecrets` gate into `createAiBackgroundService` (the provider id is read from `storageLocal['ccp.ai.provider']` inside the service's `resolveClient`, so no separate provider-reader dep is passed). Not unit-tested; logic lives in the tested modules. |
| `options.js` | **Modify** (`L34`) | Pass `providerList` (from `window.ClipboardCleaner.aiProviders.list()`, the canonical registry loaded by options.html; an inline array is a defensive backstop only) and a `permissions` wrapper around `chrome.permissions.request` into `createAiOptionsController`. Not unit-tested; a source-text drift-guard test (D-DRIFT) pins the backstop ids to the registry. |
| `manifest.json` | **Modify** (`L11`) | Add `host_permissions` for OpenAI/Anthropic/Gemini; add top-level `optional_host_permissions: ["https://*/*"]`. Do not broaden `content_scripts.matches`. |

---

### Task 1: Provider registry skeleton + shared transport

**Files:**
- Create: `lib/ai-providers.js`
- Test: `tests/ai-providers.test.js`

Steps:

- [ ] **Step 1 — Failing test: module loads, exports registry with get/list.** Create `tests/ai-providers.test.js` with the verbatim deepseek-client helpers and an initial registry assertion:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { aiProviders } = require('../lib/ai-providers.js');

function makeFetch(impl) {
  const calls = [];
  const fn = function (url, init) { calls.push({ url: url, init: init }); return impl(url, init); };
  fn.calls = calls;
  return fn;
}

function makeResponse(status, jsonBody) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status: status,
    text: function () { return Promise.resolve(JSON.stringify(jsonBody)); },
  });
}

const SNAP = { page: { urlOrigin: 'https://www.coursera.org', eligible: true }, questions: [{ id: 'q1', type: 'math_input', prompt: 'p', order: 1 }], token: 'snap_x' };

test('registry exposes get and list functions', () => {
  assert.equal(typeof aiProviders.get, 'function');
  assert.equal(typeof aiProviders.list, 'function');
});

test('list returns the five known providers with id/label/models/defaultModel', () => {
  const ids = aiProviders.list().map(function (p) { return p.id; }).sort();
  assert.deepEqual(ids, ['anthropic', 'custom', 'deepseek', 'gemini', 'openai']);
  aiProviders.list().forEach(function (p) {
    assert.equal(typeof p.label, 'string');
    assert.ok(p.label.length > 0);
    assert.ok(Array.isArray(p.models));
    assert.equal(typeof p.defaultModel, 'string');
  });
});

test('get returns null for an unknown provider id', () => {
  assert.equal(aiProviders.get('nope'), null);
});
```
- [ ] **Step 2 — Run it, expect FAIL.** `node --test "tests/ai-providers.test.js"` — expected FAIL: `Cannot find module '../lib/ai-providers.js'`.
- [ ] **Step 3 — Minimal implementation: registry + shared transport + the five adapter shells.** Create `lib/ai-providers.js`. This step writes the full module skeleton (transport reused from deepseek-client) plus a placeholder for the per-adapter `buildRequest`/`parseResponse` filled in by later tasks. Full file:
```js
// lib/ai-providers.js
// Background-safe provider adapter registry. Zero deps; NO DOM (loads in the MV3
// service worker, so it references `self`, never `window`/`document`).
// Each adapter: { id, label, defaultModel, models, endpoint(opts),
//   buildRequest(sanitizedSnapshot, apiKey, opts) -> { url, method, headers, body },
//   parseResponse(jsonOrText) -> { ok, raw }, createClient(opts) -> { generateAnswers } }
(function (root) {
  'use strict';

  var DEFAULT_TIMEOUT_MS = 30000;

  // Generalized system prompt — the SINGLE SOURCE OF TRUTH for the assessment
  // contract. MUST contain the literal word "json", the {"type":"text",...}
  // answer-shape example, and the token "math_input" so the deepseek adapter still
  // satisfies deepseek-client.test U15-P1/U15-P2. NOTE: lib/deepseek-client.js keeps a
  // VERBATIM copy of this string in its standalone fallback (used only when this
  // module cannot be loaded). The two must stay byte-identical; Task 7 Step 4 adds a
  // test (D-PROMPT) asserting equality. If you edit this prompt, edit the fallback too.
  // Type coverage here is intentionally scoped to single_choice / multiple_choice /
  // math_input / free_text; the remaining typed-schema kinds (dropdown, matching,
  // ordering, code, file_upload) are deferred to Phase C (WS-C question-type system).
  var SYSTEM_PROMPT = [
    'You are generating answer suggestions for an online assessment. Reply with strict json only matching the supplied schema. Use only the question_id and option_id values supplied. Do not output HTML, selectors, JavaScript, navigation actions, submit instructions, or markdown.',
    '',
    'For single_choice questions, return exactly one supplied option_id. For multiple_choice questions, return zero or more supplied option_ids only when justified. For math_input questions (text or numeric typed answers), return an answer object of shape {"type":"text","value":"<string>"}. Numeric answers MUST be returned as strings (e.g., "0.5", not 0.5). For free_text questions, return {"type":"text","value":"<string>"}. If a question cannot be answered confidently from the supplied context, omit it or mark confidence="low".',
    '',
    'Schema example: { "answers": [ { "question_id": "q1", "answer": { "type": "single_choice", "option_ids": ["q1o0"] }, "explanation": "short", "confidence": "high" }, { "question_id": "q2", "answer": { "type": "text", "value": "the typed or numeric answer as a string" }, "explanation": "short", "confidence": "high" } ] }'
  ].join('\n');

  function classifyHttp(status) {
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 429) return 'rate-limit';
    if (status >= 500) return 'server-error';
    return 'invalid-response';
  }

  function userPromptFor(sanitizedSnapshot) {
    return 'Answer this json snapshot of an online assessment. Reply with strict json only matching the schema in the system instruction.\n\n'
      + JSON.stringify({ page: sanitizedSnapshot.page, questions: sanitizedSnapshot.questions });
  }

  // Shared transport: drives any adapter's buildRequest/parseResponse through
  // fetch with timeout + AbortController, normalizing to {ok, raw} / {ok:false, reason, detail, elapsedMs}.
  function makeClient(adapter, opts) {
    opts = opts || {};
    var fetchFn   = opts.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    var timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    var callModel = opts.model || adapter.defaultModel;
    var baseUrl   = opts.baseUrl || null;

    function generateAnswers(sanitizedSnapshot, apiKey, callOpts) {
      callOpts = callOpts || {};
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
        return Promise.resolve({ ok: false, reason: 'missing-key' });
      }
      if (!fetchFn) {
        return Promise.resolve({ ok: false, reason: 'network', detail: 'no-fetch' });
      }

      var req;
      try {
        req = adapter.buildRequest(sanitizedSnapshot, apiKey, { model: callModel, baseUrl: baseUrl });
      } catch (e) {
        return Promise.resolve({ ok: false, reason: 'invalid-response', detail: 'build-request: ' + String((e && e.message) || '').slice(0, 120) });
      }

      var ctrl = new AbortController();
      var externalSignal = callOpts.signal;
      if (externalSignal) {
        if (externalSignal.aborted) ctrl.abort();
        else externalSignal.addEventListener('abort', function () { ctrl.abort(); }, { once: true });
      }

      var timedOut = false;
      var startedAt = Date.now();
      var timer = setTimeout(function () {
        timedOut = true;
        try { ctrl.abort('timeout'); } catch (_) { ctrl.abort(); }
      }, timeoutMs);

      var init = {
        method: req.method || 'POST',
        headers: req.headers,
        body: req.body,
        signal: ctrl.signal,
      };

      var abortRace = new Promise(function (_, reject) {
        if (ctrl.signal.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        } else {
          ctrl.signal.addEventListener('abort', function () {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }, { once: true });
        }
      });

      return Promise.race([
        Promise.resolve(fetchFn(req.url, init)),
        abortRace,
      ]).then(function (resp) {
        clearTimeout(timer);
        if (!resp.ok) {
          return resp.text().then(function (errBody) {
            var bodyExcerpt = (errBody == null ? '' : String(errBody)).slice(0, 240);
            return { ok: false, reason: classifyHttp(resp.status), detail: 'http ' + resp.status + ' ' + bodyExcerpt, elapsedMs: Date.now() - startedAt };
          }).catch(function () {
            return { ok: false, reason: classifyHttp(resp.status), detail: 'http ' + resp.status, elapsedMs: Date.now() - startedAt };
          });
        }
        return resp.text().then(function (txt) {
          var outer;
          try { outer = JSON.parse(txt); } catch (_) {
            var rawExcerpt = (txt == null ? '' : String(txt)).slice(0, 240);
            return { ok: false, reason: 'invalid-response', detail: 'non-json body: ' + rawExcerpt, elapsedMs: Date.now() - startedAt };
          }
          var parsed = adapter.parseResponse(outer);
          if (!parsed || parsed.ok !== true) {
            var outerExcerpt = JSON.stringify(outer).slice(0, 240);
            return { ok: false, reason: (parsed && parsed.reason) || 'invalid-response', detail: 'unparseable provider payload: ' + outerExcerpt, elapsedMs: Date.now() - startedAt };
          }
          return { ok: true, raw: parsed.raw, elapsedMs: Date.now() - startedAt };
        });
      }).catch(function (err) {
        clearTimeout(timer);
        if (timedOut) return { ok: false, reason: 'timeout', elapsedMs: Date.now() - startedAt };
        if (err && err.name === 'AbortError') return { ok: false, reason: 'aborted', elapsedMs: Date.now() - startedAt };
        return { ok: false, reason: 'network', detail: (err && err.message) ? String(err.message).slice(0, 80) : '', elapsedMs: Date.now() - startedAt };
      });
    }

    return { generateAnswers: generateAnswers };
  }

  // Normalize raw model content into {ok:true, raw}. content is the provider's
  // text payload; JSON.parse it into raw.answers, else {ok:true, raw:{_raw:content}}.
  function normalizeContent(content) {
    if (typeof content !== 'string') return { ok: false, reason: 'invalid-response' };
    var inner;
    try { inner = JSON.parse(content); } catch (_) {
      return { ok: true, raw: { _raw: content } };
    }
    return { ok: true, raw: inner };
  }

  // ---- Adapter definitions (buildRequest/parseResponse filled in by later tasks) ----

  var openai = {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    endpoint: function () { return 'https://api.openai.com/v1/chat/completions'; },
    buildRequest: function () { throw new Error('not-implemented'); },
    parseResponse: function () { return { ok: false, reason: 'invalid-response' }; },
  };

  var anthropic = {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-3-5-haiku-latest',
    models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest'],
    endpoint: function () { return 'https://api.anthropic.com/v1/messages'; },
    buildRequest: function () { throw new Error('not-implemented'); },
    parseResponse: function () { return { ok: false, reason: 'invalid-response' }; },
  };

  var gemini = {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini-1.5-flash',
    models: ['gemini-1.5-flash', 'gemini-1.5-pro'],
    endpoint: function (opts) {
      var model = (opts && opts.model) || gemini.defaultModel;
      return 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
    },
    buildRequest: function () { throw new Error('not-implemented'); },
    parseResponse: function () { return { ok: false, reason: 'invalid-response' }; },
  };

  var deepseek = {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    endpoint: function () { return 'https://api.deepseek.com/chat/completions'; },
    buildRequest: function () { throw new Error('not-implemented'); },
    parseResponse: function () { return { ok: false, reason: 'invalid-response' }; },
  };

  var custom = {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    defaultModel: 'gpt-4o-mini',
    models: [],
    endpoint: function (opts) {
      var base = (opts && opts.baseUrl) || '';
      return joinUrl(base, '/chat/completions');
    },
    buildRequest: function () { throw new Error('not-implemented'); },
    parseResponse: function () { return { ok: false, reason: 'invalid-response' }; },
  };

  function joinUrl(base, path) {
    if (!base || typeof base !== 'string') return path;
    var b = base.replace(/\/+$/, '');
    if (b.indexOf('/chat/completions') !== -1 || b.indexOf('/completions') !== -1) return b;
    return b + path;
  }

  var REGISTRY = {
    openai: openai,
    anthropic: anthropic,
    gemini: gemini,
    deepseek: deepseek,
    custom: custom,
  };

  // Attach createClient to each adapter so callers can do get(id).createClient(opts).
  Object.keys(REGISTRY).forEach(function (id) {
    var a = REGISTRY[id];
    a.createClient = function (opts) { return makeClient(a, opts); };
  });

  var aiProviders = {
    get: function (id) { return REGISTRY[id] || null; },
    list: function () {
      return Object.keys(REGISTRY).map(function (id) {
        var a = REGISTRY[id];
        return { id: a.id, label: a.label, models: a.models.slice(), defaultModel: a.defaultModel };
      });
    },
  };

  var api = {
    aiProviders: aiProviders,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    classifyHttp: classifyHttp,
    userPromptFor: userPromptFor,
    normalizeContent: normalizeContent,
    joinUrl: joinUrl,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.aiProviders = aiProviders;
  }
})(typeof self !== 'undefined' ? self : this);
```
- [ ] **Step 4 — Run it, expect PASS.** `node --test "tests/ai-providers.test.js"` — expected PASS (3 tests). Then run the full suite: `npm test` — expected PASS (existing 1253 + 3 new).
- [ ] **Step 5 — Commit.** `git add lib/ai-providers.js tests/ai-providers.test.js` then `git commit -m "feat(ai-providers): registry skeleton + shared fetch transport (no adapters yet)"`.

---

### Task 2: OpenAI adapter (buildRequest + parseResponse)

**Files:**
- Modify: `lib/ai-providers.js` (`openai.buildRequest`, `openai.parseResponse`)
- Test: `tests/ai-providers.test.js`

Steps:

- [ ] **Step 1 — Failing test: openai buildRequest shape + key only in Authorization.** Append to `tests/ai-providers.test.js`:
```js
test('openai buildRequest posts JSON to the chat completions URL with the key only in the Authorization header', () => {
  const a = aiProviders.get('openai');
  const req = a.buildRequest(SNAP, 'sk-SUPER-SECRET', { model: 'gpt-4o-mini' });
  assert.equal(req.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.Authorization, 'Bearer sk-SUPER-SECRET');
  assert.equal(req.headers['Content-Type'], 'application/json');
  const body = JSON.parse(req.body);
  assert.equal(body.model, 'gpt-4o-mini');
  assert.equal(body.response_format.type, 'json_object');
  const userMsg = body.messages.find(function (m) { return m.role === 'user'; });
  assert.ok(userMsg.content.indexOf('"q1"') !== -1, 'snapshot must be in the user prompt');
  // key must NOT appear in the serialized body
  assert.equal(req.body.indexOf('sk-SUPER-SECRET'), -1);
});

test('openai parseResponse reads choices[0].message.content and JSON.parses it into raw.answers', () => {
  const a = aiProviders.get('openai');
  const r = a.parseResponse({ choices: [{ message: { content: JSON.stringify({ answers: [{ question_id: 'q1' }] }) } }] });
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.raw.answers));
  assert.equal(r.raw.answers[0].question_id, 'q1');
});

test('openai parseResponse returns {ok:true, raw:{_raw}} for non-JSON content', () => {
  const a = aiProviders.get('openai');
  const r = a.parseResponse({ choices: [{ message: { content: 'not json at all' } }] });
  assert.equal(r.ok, true);
  assert.equal(r.raw._raw, 'not json at all');
});

test('openai createClient end-to-end 200 normalizes and never leaks the key', async () => {
  const f = makeFetch(function () { return makeResponse(200, { choices: [{ message: { content: '{"answers":[{"question_id":"q1"}]}' } }] }); });
  const c = aiProviders.get('openai').createClient({ fetchFn: f });
  const r = await c.generateAnswers(SNAP, 'sk-SUPER-SECRET');
  assert.equal(r.ok, true);
  assert.equal(r.raw.answers[0].question_id, 'q1');
  assert.equal(JSON.stringify(r).indexOf('sk-SUPER-SECRET'), -1);
  assert.equal(String(f.calls[0].init.body || '').indexOf('sk-SUPER-SECRET'), -1);
  assert.equal(f.calls[0].init.headers.Authorization, 'Bearer sk-SUPER-SECRET');
});
```
- [ ] **Step 2 — Run it, expect FAIL.** `node --test "tests/ai-providers.test.js"` — expected FAIL: `openai.buildRequest` throws `not-implemented`.
- [ ] **Step 3 — Minimal implementation.** In `lib/ai-providers.js` replace the `openai.buildRequest`/`openai.parseResponse` placeholder lines with:
```js
    buildRequest: function (sanitizedSnapshot, apiKey, opts) {
      opts = opts || {};
      var model = opts.model || openai.defaultModel;
      var body = JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPromptFor(sanitizedSnapshot) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 2048,
      });
      return {
        url: openai.endpoint(opts),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
          'Accept': 'application/json',
        },
        body: body,
      };
    },
    parseResponse: function (outer) {
      var content = outer && outer.choices && outer.choices[0] && outer.choices[0].message && outer.choices[0].message.content;
      return normalizeContent(content);
    },
```
- [ ] **Step 4 — Run it, expect PASS.** `node --test "tests/ai-providers.test.js"` — expected PASS (7 tests). Then `npm test` — expected PASS.
- [ ] **Step 5 — Commit.** `git add lib/ai-providers.js tests/ai-providers.test.js` then `git commit -m "feat(ai-providers): openai adapter buildRequest + parseResponse"`.

---

### Task 3: DeepSeek adapter (buildRequest + parseResponse)

**Files:**
- Modify: `lib/ai-providers.js` (`deepseek.buildRequest`, `deepseek.parseResponse`)
- Test: `tests/ai-providers.test.js`

Steps:

- [ ] **Step 1 — Failing test: deepseek buildRequest shape + system prompt literals.** Append to `tests/ai-providers.test.js`:
```js
test('deepseek buildRequest targets api.deepseek.com with json_object response_format and the key only in Authorization', () => {
  const a = aiProviders.get('deepseek');
  const req = a.buildRequest(SNAP, 'sk-DS-SECRET', { model: 'deepseek-chat' });
  assert.equal(req.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.Authorization, 'Bearer sk-DS-SECRET');
  const body = JSON.parse(req.body);
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(req.body.indexOf('sk-DS-SECRET'), -1);
});

test('deepseek default model is deepseek-chat when no model option supplied', () => {
  const a = aiProviders.get('deepseek');
  const req = a.buildRequest(SNAP, 'sk-x', {});
  assert.equal(JSON.parse(req.body).model, 'deepseek-chat');
});

test('deepseek system prompt contains json, math_input, and the {"type":"text"} shape', () => {
  const a = aiProviders.get('deepseek');
  const body = JSON.parse(a.buildRequest(SNAP, 'sk-x', {}).body);
  const system = body.messages[0].content;
  assert.ok(/\bjson\b/i.test(system));
  assert.ok(system.indexOf('math_input') !== -1);
  assert.ok(system.indexOf('"type":"text"') !== -1 || system.indexOf('"type": "text"') !== -1);
});

test('deepseek parseResponse normalizes choices[0].message.content to raw.answers', () => {
  const a = aiProviders.get('deepseek');
  const r = a.parseResponse({ choices: [{ message: { content: JSON.stringify({ answers: [{ question_id: 'q1' }] }) } }] });
  assert.equal(r.ok, true);
  assert.equal(r.raw.answers[0].question_id, 'q1');
});
```
- [ ] **Step 2 — Run it, expect FAIL.** `node --test "tests/ai-providers.test.js"` — expected FAIL: `deepseek.buildRequest` throws `not-implemented`.
- [ ] **Step 3 — Minimal implementation.** In `lib/ai-providers.js` replace the `deepseek.buildRequest`/`deepseek.parseResponse` placeholders with (DeepSeek is OpenAI-shaped):
```js
    buildRequest: function (sanitizedSnapshot, apiKey, opts) {
      opts = opts || {};
      var model = opts.model || deepseek.defaultModel;
      var body = JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPromptFor(sanitizedSnapshot) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 2048,
      });
      return {
        url: deepseek.endpoint(opts),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
          'Accept': 'application/json',
        },
        body: body,
      };
    },
    parseResponse: function (outer) {
      var content = outer && outer.choices && outer.choices[0] && outer.choices[0].message && outer.choices[0].message.content;
      return normalizeContent(content);
    },
```
- [ ] **Step 4 — Run it, expect PASS.** `node --test "tests/ai-providers.test.js"` — expected PASS (11 tests). Then `npm test` — expected PASS.
- [ ] **Step 5 — Commit.** `git add lib/ai-providers.js tests/ai-providers.test.js` then `git commit -m "feat(ai-providers): deepseek adapter buildRequest + parseResponse"`.

---

### Task 4: Anthropic adapter (x-api-key header, content[0].text)

**Files:**
- Modify: `lib/ai-providers.js` (`anthropic.buildRequest`, `anthropic.parseResponse`)
- Test: `tests/ai-providers.test.js`

Steps:

- [ ] **Step 1 — Failing test: anthropic uses x-api-key + anthropic-version, reads content[0].text.** Append to `tests/ai-providers.test.js`:
```js
test('anthropic buildRequest sends the key in x-api-key (not Authorization) with anthropic-version header', () => {
  const a = aiProviders.get('anthropic');
  const req = a.buildRequest(SNAP, 'sk-ANT-SECRET', { model: 'claude-3-5-haiku-latest' });
  assert.equal(req.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers['x-api-key'], 'sk-ANT-SECRET');
  assert.ok(typeof req.headers['anthropic-version'] === 'string' && req.headers['anthropic-version'].length > 0);
  assert.equal(req.headers.Authorization, undefined, 'anthropic must NOT use a Bearer Authorization header');
  const body = JSON.parse(req.body);
  assert.equal(body.model, 'claude-3-5-haiku-latest');
  // anthropic has no response_format; system prompt + JSON instruction carry the contract
  assert.ok(typeof body.system === 'string' && /\bjson\b/i.test(body.system));
  assert.ok(typeof body.max_tokens === 'number');
  const userMsg = body.messages.find(function (m) { return m.role === 'user'; });
  assert.ok(userMsg.content.indexOf('"q1"') !== -1);
  assert.equal(req.body.indexOf('sk-ANT-SECRET'), -1);
});

test('anthropic parseResponse reads content[0].text and JSON.parses into raw.answers', () => {
  const a = aiProviders.get('anthropic');
  const r = a.parseResponse({ content: [{ type: 'text', text: JSON.stringify({ answers: [{ question_id: 'q1' }] }) }] });
  assert.equal(r.ok, true);
  assert.equal(r.raw.answers[0].question_id, 'q1');
});

test('anthropic parseResponse returns {ok:true, raw:{_raw}} for non-JSON text', () => {
  const a = aiProviders.get('anthropic');
  const r = a.parseResponse({ content: [{ type: 'text', text: 'plain words' }] });
  assert.equal(r.ok, true);
  assert.equal(r.raw._raw, 'plain words');
});

test('anthropic createClient end-to-end never leaks the key into body or return', async () => {
  const f = makeFetch(function () { return makeResponse(200, { content: [{ type: 'text', text: '{"answers":[]}' }] }); });
  const c = aiProviders.get('anthropic').createClient({ fetchFn: f });
  const r = await c.generateAnswers(SNAP, 'sk-ANT-SECRET');
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(r).indexOf('sk-ANT-SECRET'), -1);
  assert.equal(String(f.calls[0].init.body || '').indexOf('sk-ANT-SECRET'), -1);
  assert.equal(f.calls[0].init.headers['x-api-key'], 'sk-ANT-SECRET');
});
```
- [ ] **Step 2 — Run it, expect FAIL.** `node --test "tests/ai-providers.test.js"` — expected FAIL: `anthropic.buildRequest` throws `not-implemented`.
- [ ] **Step 3 — Minimal implementation.** In `lib/ai-providers.js` replace the `anthropic.buildRequest`/`anthropic.parseResponse` placeholders with:
```js
    buildRequest: function (sanitizedSnapshot, apiKey, opts) {
      opts = opts || {};
      var model = opts.model || anthropic.defaultModel;
      var body = JSON.stringify({
        model: model,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: userPromptFor(sanitizedSnapshot) },
        ],
        max_tokens: 2048,
        temperature: 0.2,
      });
      return {
        url: anthropic.endpoint(opts),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Accept': 'application/json',
        },
        body: body,
      };
    },
    parseResponse: function (outer) {
      var content = outer && outer.content && outer.content[0] && outer.content[0].text;
      return normalizeContent(content);
    },
```
- [ ] **Step 4 — Run it, expect PASS.** `node --test "tests/ai-providers.test.js"` — expected PASS (15 tests). Then `npm test` — expected PASS.
- [ ] **Step 5 — Commit.** `git add lib/ai-providers.js tests/ai-providers.test.js` then `git commit -m "feat(ai-providers): anthropic adapter (x-api-key, content[0].text)"`.

---

### Task 5: Gemini adapter (x-goog-api-key header, candidates parsing)

**Files:**
- Modify: `lib/ai-providers.js` (`gemini.buildRequest`, `gemini.parseResponse`)
- Test: `tests/ai-providers.test.js`

Steps:

- [ ] **Step 1 — Failing test: gemini sends key in x-goog-api-key header, NOT a query param.** Append to `tests/ai-providers.test.js`:
```js
test('gemini buildRequest puts the key in the x-goog-api-key header and NOT in the URL query', () => {
  const a = aiProviders.get('gemini');
  const req = a.buildRequest(SNAP, 'gem-SECRET-KEY', { model: 'gemini-1.5-flash' });
  assert.ok(req.url.indexOf('generativelanguage.googleapis.com') !== -1);
  assert.ok(req.url.indexOf('gemini-1.5-flash') !== -1);
  assert.equal(req.url.indexOf('gem-SECRET-KEY'), -1, 'key must NOT appear in the URL (no ?key=)');
  assert.equal(req.url.indexOf('key='), -1, 'no key= query param allowed');
  assert.equal(req.headers['x-goog-api-key'], 'gem-SECRET-KEY');
  const body = JSON.parse(req.body);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.ok(JSON.stringify(body).indexOf('"q1"') !== -1, 'snapshot must be embedded');
  assert.equal(req.body.indexOf('gem-SECRET-KEY'), -1);
});

test('gemini parseResponse reads candidates[0].content.parts[0].text into raw.answers', () => {
  const a = aiProviders.get('gemini');
  const r = a.parseResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify({ answers: [{ question_id: 'q1' }] }) }] } }] });
  assert.equal(r.ok, true);
  assert.equal(r.raw.answers[0].question_id, 'q1');
});

test('gemini parseResponse returns {ok:true, raw:{_raw}} for non-JSON parts text', () => {
  const a = aiProviders.get('gemini');
  const r = a.parseResponse({ candidates: [{ content: { parts: [{ text: 'free text' }] } }] });
  assert.equal(r.ok, true);
  assert.equal(r.raw._raw, 'free text');
});

test('gemini createClient end-to-end never leaks the key into URL, body, or return', async () => {
  const f = makeFetch(function () { return makeResponse(200, { candidates: [{ content: { parts: [{ text: '{"answers":[]}' }] } }] }); });
  const c = aiProviders.get('gemini').createClient({ fetchFn: f });
  const r = await c.generateAnswers(SNAP, 'gem-SECRET-KEY');
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(r).indexOf('gem-SECRET-KEY'), -1);
  assert.equal(String(f.calls[0].url || '').indexOf('gem-SECRET-KEY'), -1);
  assert.equal(String(f.calls[0].init.body || '').indexOf('gem-SECRET-KEY'), -1);
  assert.equal(f.calls[0].init.headers['x-goog-api-key'], 'gem-SECRET-KEY');
});
```
- [ ] **Step 2 — Run it, expect FAIL.** `node --test "tests/ai-providers.test.js"` — expected FAIL: `gemini.buildRequest` throws `not-implemented`.
- [ ] **Step 3 — Minimal implementation.** In `lib/ai-providers.js` replace the `gemini.buildRequest`/`gemini.parseResponse` placeholders with:
```js
    buildRequest: function (sanitizedSnapshot, apiKey, opts) {
      opts = opts || {};
      var combined = SYSTEM_PROMPT + '\n\n' + userPromptFor(sanitizedSnapshot);
      var body = JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: combined }] },
        ],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.2,
          maxOutputTokens: 2048,
        },
      });
      return {
        url: gemini.endpoint(opts),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
          'Accept': 'application/json',
        },
        body: body,
      };
    },
    parseResponse: function (outer) {
      var content = outer && outer.candidates && outer.candidates[0] &&
        outer.candidates[0].content && outer.candidates[0].content.parts &&
        outer.candidates[0].content.parts[0] && outer.candidates[0].content.parts[0].text;
      return normalizeContent(content);
    },
```
- [ ] **Step 4 — Run it, expect PASS.** `node --test "tests/ai-providers.test.js"` — expected PASS (19 tests). Then `npm test` — expected PASS.
- [ ] **Step 5 — Commit.** `git add lib/ai-providers.js tests/ai-providers.test.js` then `git commit -m "feat(ai-providers): gemini adapter (x-goog-api-key header, candidates parsing)"`.

---

### Task 6: Custom OpenAI-compatible adapter (base-URL handling)

**Files:**
- Modify: `lib/ai-providers.js` (`custom.buildRequest`, `custom.parseResponse`)
- Test: `tests/ai-providers.test.js`

Steps:

- [ ] **Step 1 — Failing test: custom adapter builds from a base URL and is OpenAI-shaped.** Append to `tests/ai-providers.test.js`:
```js
test('custom buildRequest appends /chat/completions to a bare base URL', () => {
  const a = aiProviders.get('custom');
  const req = a.buildRequest(SNAP, 'sk-CUSTOM', { model: 'my-model', baseUrl: 'https://llm.example.com/v1' });
  assert.equal(req.url, 'https://llm.example.com/v1/chat/completions');
  assert.equal(req.method, 'POST');
  assert.equal(req.headers.Authorization, 'Bearer sk-CUSTOM');
  const body = JSON.parse(req.body);
  assert.equal(body.model, 'my-model');
  assert.equal(req.body.indexOf('sk-CUSTOM'), -1);
});

test('custom buildRequest tolerates a trailing slash and an already-complete completions path', () => {
  const a = aiProviders.get('custom');
  const trailing = a.buildRequest(SNAP, 'sk-x', { model: 'm', baseUrl: 'https://llm.example.com/v1/' });
  assert.equal(trailing.url, 'https://llm.example.com/v1/chat/completions');
  const complete = a.buildRequest(SNAP, 'sk-x', { model: 'm', baseUrl: 'https://llm.example.com/v1/chat/completions' });
  assert.equal(complete.url, 'https://llm.example.com/v1/chat/completions');
});

test('custom parseResponse normalizes OpenAI-shaped choices[0].message.content', () => {
  const a = aiProviders.get('custom');
  const r = a.parseResponse({ choices: [{ message: { content: JSON.stringify({ answers: [{ question_id: 'q1' }] }) } }] });
  assert.equal(r.ok, true);
  assert.equal(r.raw.answers[0].question_id, 'q1');
});

test('custom createClient end-to-end uses the supplied baseUrl and never leaks the key', async () => {
  const f = makeFetch(function () { return makeResponse(200, { choices: [{ message: { content: '{"answers":[]}' } }] }); });
  const c = aiProviders.get('custom').createClient({ fetchFn: f, model: 'm', baseUrl: 'https://llm.example.com/v1' });
  const r = await c.generateAnswers(SNAP, 'sk-CUSTOM');
  assert.equal(r.ok, true);
  assert.equal(f.calls[0].url, 'https://llm.example.com/v1/chat/completions');
  assert.equal(JSON.stringify(r).indexOf('sk-CUSTOM'), -1);
  assert.equal(String(f.calls[0].init.body || '').indexOf('sk-CUSTOM'), -1);
});
```
- [ ] **Step 2 — Run it, expect FAIL.** `node --test "tests/ai-providers.test.js"` — expected FAIL: `custom.buildRequest` throws `not-implemented`.
- [ ] **Step 3 — Minimal implementation.** In `lib/ai-providers.js` replace the `custom.buildRequest`/`custom.parseResponse` placeholders with:
```js
    buildRequest: function (sanitizedSnapshot, apiKey, opts) {
      opts = opts || {};
      var model = opts.model || custom.defaultModel;
      var body = JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPromptFor(sanitizedSnapshot) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 2048,
      });
      return {
        url: custom.endpoint(opts),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
          'Accept': 'application/json',
        },
        body: body,
      };
    },
    parseResponse: function (outer) {
      var content = outer && outer.choices && outer.choices[0] && outer.choices[0].message && outer.choices[0].message.content;
      return normalizeContent(content);
    },
```
- [ ] **Step 4 — Run it, expect PASS.** `node --test "tests/ai-providers.test.js"` — expected PASS (23 tests). Then `npm test` — expected PASS.
- [ ] **Step 5 — Commit.** `git add lib/ai-providers.js tests/ai-providers.test.js` then `git commit -m "feat(ai-providers): custom OpenAI-compatible adapter with base-URL handling"`.

---

### Task 7: Refactor deepseek-client.js to delegate to the deepseek adapter (preserve export surface)

**Files:**
- Modify: `lib/deepseek-client.js` (`L4-160`)
- Test: `tests/deepseek-client.test.js` (unchanged — must stay green), `tests/ai-providers.test.js`

Steps:

- [ ] **Step 1 — Failing test: deepseek-client actually delegates to the ai-providers deepseek adapter (require-graph + shared-transport proof).** Append to `tests/ai-providers.test.js` a cross-module assertion. The behavior checks (identical URL/headers/body) would pass against the pre-refactor standalone client, so the GUARANTEED-RED signal is the delegation-proof assertion: after requiring `lib/deepseek-client.js` in isolation, `lib/ai-providers.js` MUST appear in `require.cache` (the pre-refactor standalone client never requires it, so this fails before Step 3 and passes after):
```js
test('deepseek-client delegates to ai-providers: ai-providers is pulled into deepseek-client require graph', () => {
  const path = require('path');
  const providersPath = path.resolve(__dirname, '..', 'lib', 'ai-providers.js');
  const clientPath = path.resolve(__dirname, '..', 'lib', 'deepseek-client.js');
  // Force a clean require so the cache reflects ONLY what deepseek-client pulls in.
  delete require.cache[clientPath];
  delete require.cache[providersPath];
  require(clientPath);
  assert.ok(
    Object.prototype.hasOwnProperty.call(require.cache, providersPath),
    'deepseek-client.js must require ai-providers.js (delegation), not duplicate the transport'
  );
});

test('deepseek-client createClient produces a request identical in shape to the deepseek adapter', async () => {
  const { createClient } = require('../lib/deepseek-client.js');
  const f = makeFetch(function () { return makeResponse(200, { choices: [{ message: { content: '{"answers":[]}' } }] }); });
  const c = createClient({ fetchFn: f });
  const r = await c.generateAnswers(SNAP, 'sk-DELEGATE');
  assert.equal(r.ok, true);
  const sent = f.calls[0];
  assert.equal(sent.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(sent.init.headers.Authorization, 'Bearer sk-DELEGATE');
  const body = JSON.parse(sent.init.body);
  assert.equal(body.model, 'deepseek-chat');
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(String(sent.init.body || '').indexOf('sk-DELEGATE'), -1);
  assert.equal(JSON.stringify(r).indexOf('sk-DELEGATE'), -1);
});
```
- [ ] **Step 2 — Run it, expect FAIL (true RED before the refactor).** `node --test "tests/ai-providers.test.js"` — expected FAIL on the new `deepseek-client delegates …` test: the pre-refactor `lib/deepseek-client.js` is fully self-contained and never `require`s `ai-providers.js`, so `ai-providers.js` is absent from `require.cache` and the assertion fails. (The second, behavior-shape test may already pass against the standalone client — that is fine; the require-graph test is the enforced RED gate.) Also confirm the baseline before touching the file: `node --test "tests/deepseek-client.test.js"` prints `ℹ tests 20` / `ℹ pass 20` / `ℹ fail 0`. After Step 3, both the new delegation test AND all 20 deepseek-client tests must be GREEN; treat any regression in `tests/deepseek-client.test.js` as a contract break to fix before committing.
- [ ] **Step 3 — Minimal implementation: rewrite `lib/deepseek-client.js` to delegate.** Replace the entire file body so `createClient` is backed by the `deepseek` adapter from `ai-providers.js` when that module is available (CommonJS require in tests, `self.ClipboardCleaner.aiProviders` in the worker), with a self-contained fallback identical to today's behavior so the file still works if loaded alone. Full file:
```js
// lib/deepseek-client.js
// Background-safe DeepSeek HTTPS client. Now a thin delegator to the `deepseek`
// adapter in lib/ai-providers.js (request/response shape + {ok, raw} preserved).
// Exports createClient(opts) -> { generateAnswers(snapshot, apiKey, opts) } unchanged.
(function (root) {
  'use strict';

  var DEFAULT_ENDPOINT   = 'https://api.deepseek.com/chat/completions';
  var DEFAULT_MODEL      = 'deepseek-chat';
  var DEFAULT_TIMEOUT_MS = 30000;

  // Resolve the ai-providers module across realms: CommonJS (tests) and the
  // service-worker global (importScripts puts it on self.ClipboardCleaner).
  function resolveProviders() {
    if (typeof module !== 'undefined' && module.exports) {
      try { return require('./ai-providers.js'); } catch (_) { return null; }
    }
    if (root && root.ClipboardCleaner && root.ClipboardCleaner.aiProviders) {
      // Worker realm exposes only the registry object, not the helper export.
      return { aiProviders: root.ClipboardCleaner.aiProviders };
    }
    return null;
  }

  function createClient(opts) {
    opts = opts || {};
    var providers = resolveProviders();
    var adapter = providers && providers.aiProviders && providers.aiProviders.get
      ? providers.aiProviders.get('deepseek')
      : null;
    if (adapter && typeof adapter.createClient === 'function') {
      return adapter.createClient({
        fetchFn: opts.fetchFn,
        model: opts.model || DEFAULT_MODEL,
        timeoutMs: opts.timeoutMs,
      });
    }
    // Fallback: self-contained client (kept so the file works if loaded alone).
    return fallbackClient(opts);
  }

  // --- Self-contained fallback (only used when ai-providers.js is NOT loadable) ---
  // This SYSTEM_PROMPT is a deliberate VERBATIM copy of the SYSTEM_PROMPT in
  // lib/ai-providers.js (Task 1). It must stay character-for-character identical so
  // there is no behavioral drift between the adapter path (production) and this
  // standalone fallback. If you change one, change both. Task 7 Step 4 adds a test
  // (D-PROMPT) asserting the two strings are byte-identical to enforce this.
  var SYSTEM_PROMPT = [
    'You are generating answer suggestions for an online assessment. Reply with strict json only matching the supplied schema. Use only the question_id and option_id values supplied. Do not output HTML, selectors, JavaScript, navigation actions, submit instructions, or markdown.',
    '',
    'For single_choice questions, return exactly one supplied option_id. For multiple_choice questions, return zero or more supplied option_ids only when justified. For math_input questions (text or numeric typed answers), return an answer object of shape {"type":"text","value":"<string>"}. Numeric answers MUST be returned as strings (e.g., "0.5", not 0.5). For free_text questions, return {"type":"text","value":"<string>"}. If a question cannot be answered confidently from the supplied context, omit it or mark confidence="low".',
    '',
    'Schema example: { "answers": [ { "question_id": "q1", "answer": { "type": "single_choice", "option_ids": ["q1o0"] }, "explanation": "short", "confidence": "high" }, { "question_id": "q2", "answer": { "type": "text", "value": "the typed or numeric answer as a string" }, "explanation": "short", "confidence": "high" } ] }'
  ].join('\n');

  function classifyHttp(status) {
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 429) return 'rate-limit';
    if (status >= 500) return 'server-error';
    return 'invalid-response';
  }

  function fallbackClient(opts) {
    var fetchFn   = opts.fetchFn || (typeof fetch !== 'undefined' ? fetch : null);
    var model     = opts.model || DEFAULT_MODEL;
    var endpoint  = opts.endpoint || DEFAULT_ENDPOINT;
    var timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;

    function generateAnswers(sanitizedSnapshot, apiKey, callOpts) {
      callOpts = callOpts || {};
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
        return Promise.resolve({ ok: false, reason: 'missing-key' });
      }
      if (!fetchFn) return Promise.resolve({ ok: false, reason: 'network', detail: 'no-fetch' });

      var userPrompt = 'Answer this json snapshot of an online assessment. Reply with strict json only matching the schema in the system instruction.\n\n'
        + JSON.stringify({ page: sanitizedSnapshot.page, questions: sanitizedSnapshot.questions });
      var body = JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
        max_tokens: 2048,
      });

      var ctrl = new AbortController();
      var externalSignal = callOpts.signal;
      if (externalSignal) {
        if (externalSignal.aborted) ctrl.abort();
        else externalSignal.addEventListener('abort', function () { ctrl.abort(); }, { once: true });
      }
      var timedOut = false;
      var startedAt = Date.now();
      var timer = setTimeout(function () { timedOut = true; try { ctrl.abort('timeout'); } catch (_) { ctrl.abort(); } }, timeoutMs);

      var init = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' },
        body: body,
        signal: ctrl.signal,
      };
      var abortRace = new Promise(function (_, reject) {
        if (ctrl.signal.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        else ctrl.signal.addEventListener('abort', function () { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
      });

      return Promise.race([Promise.resolve(fetchFn(endpoint, init)), abortRace]).then(function (resp) {
        clearTimeout(timer);
        if (!resp.ok) {
          return resp.text().then(function (errBody) {
            var bodyExcerpt = (errBody == null ? '' : String(errBody)).slice(0, 240);
            return { ok: false, reason: classifyHttp(resp.status), detail: 'http ' + resp.status + ' ' + bodyExcerpt, elapsedMs: Date.now() - startedAt };
          }).catch(function () {
            return { ok: false, reason: classifyHttp(resp.status), detail: 'http ' + resp.status, elapsedMs: Date.now() - startedAt };
          });
        }
        return resp.text().then(function (txt) {
          var outer;
          try { outer = JSON.parse(txt); } catch (_) {
            var rawExcerpt = (txt == null ? '' : String(txt)).slice(0, 240);
            return { ok: false, reason: 'invalid-response', detail: 'non-json body: ' + rawExcerpt, elapsedMs: Date.now() - startedAt };
          }
          var content = outer && outer.choices && outer.choices[0] && outer.choices[0].message && outer.choices[0].message.content;
          if (typeof content !== 'string') {
            var outerExcerpt = JSON.stringify(outer).slice(0, 240);
            return { ok: false, reason: 'invalid-response', detail: 'missing choices[0].message.content: ' + outerExcerpt, elapsedMs: Date.now() - startedAt };
          }
          var inner;
          try { inner = JSON.parse(content); } catch (_) {
            return { ok: true, raw: { _raw: content }, elapsedMs: Date.now() - startedAt };
          }
          return { ok: true, raw: inner, elapsedMs: Date.now() - startedAt };
        });
      }).catch(function (err) {
        clearTimeout(timer);
        if (timedOut) return { ok: false, reason: 'timeout', elapsedMs: Date.now() - startedAt };
        if (err && err.name === 'AbortError') return { ok: false, reason: 'aborted', elapsedMs: Date.now() - startedAt };
        return { ok: false, reason: 'network', detail: (err && err.message) ? String(err.message).slice(0, 80) : '', elapsedMs: Date.now() - startedAt };
      });
    }
    return { generateAnswers: generateAnswers };
  }

  var api = { createClient: createClient };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.deepseekClient = api;
  }
})(typeof self !== 'undefined' ? self : this);
```
- [ ] **Step 3b — Add the single-source-of-truth prompt test (D-PROMPT).** The fallback `SYSTEM_PROMPT` in `lib/deepseek-client.js` is a verbatim copy of the one in `lib/ai-providers.js`. To prevent silent drift, append a source-text equality test to `tests/ai-providers.test.js`. It extracts the `SYSTEM_PROMPT = [ ... ].join('\n')` array literal from both source files and asserts the array bodies are byte-identical:
```js
test('D-PROMPT: deepseek-client fallback SYSTEM_PROMPT is byte-identical to the ai-providers SYSTEM_PROMPT', () => {
  const fs = require('fs');
  const path = require('path');
  function extractPromptArray(file) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', file), 'utf8');
    // Match: var SYSTEM_PROMPT = [ ... ].join('\n');  (non-greedy up to the first ].join)
    const m = src.match(/var SYSTEM_PROMPT = \[([\s\S]*?)\]\.join\('\\n'\);/);
    assert.ok(m, 'SYSTEM_PROMPT array literal must be present in lib/' + file);
    // Normalize incidental indentation/whitespace between the two source files.
    return m[1].replace(/\s+/g, ' ').trim();
  }
  const providersPrompt = extractPromptArray('ai-providers.js');
  const clientPrompt = extractPromptArray('deepseek-client.js');
  assert.equal(clientPrompt, providersPrompt,
    'deepseek-client fallback SYSTEM_PROMPT has drifted from ai-providers SYSTEM_PROMPT — keep them byte-identical');
});
```
- [ ] **Step 4 — Run both suites, expect PASS.** `node --test "tests/deepseek-client.test.js"` — expected PASS; the runner must print `ℹ tests 20` / `ℹ pass 20` / `ℹ fail 0` (all 20 existing tests still green: default model `deepseek-chat`, SYSTEM_PROMPT literals, json_object body, key-only-in-header, classifyHttp, timeout/abort/network, 240-char excerpt). Then `node --test "tests/ai-providers.test.js"` — expected PASS (26 tests: 23 from Tasks 1-6 plus the 3 added in this task — the require-graph delegation test, the request-shape test, and D-PROMPT). Then `npm test` — expected PASS.
- [ ] **Step 5 — Commit.** `git add lib/deepseek-client.js tests/ai-providers.test.js` then `git commit -m "refactor(deepseek-client): delegate to ai-providers deepseek adapter, preserve createClient surface"`.

---

### Task 8: Provider/model resolution + setProvider command in ai-background-service.js

**Files:**
- Modify: `lib/ai-background-service.js` (`L11-216`)
- Test: `tests/ai-background-service.test.js`

Steps:

- [ ] **Step 1 — Failing test: per-call provider resolution + setProvider gating.** Append to `tests/ai-background-service.test.js` (after the existing tests; reuse `fakeStorage`, `fakeClient`, `callAs`, `strictCanManageSecrets`):
```js
// === Phase B: provider-agnostic generation ===

function fakeProviders(map) {
  // map: { providerId: behaviorFn(snap, key, opts) }
  return {
    get: function (id) {
      if (!map[id]) return null;
      return { createClient: function () { return { generateAnswers: map[id] }; } };
    },
    list: function () { return Object.keys(map).map(function (id) { return { id: id, label: id, models: [], defaultModel: 'm' }; }); },
  };
}

test('PB1: generateAnswers resolves the adapter from ccp.ai.provider and calls THAT provider', async () => {
  const session = fakeStorage(); session._store['ccp.ai.sessionKey'] = 'sk-x';
  const local = fakeStorage(); local._store['ccp.ai.provider'] = 'openai';
  let calledProvider = null;
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    aiProviders: fakeProviders({
      deepseek: function () { calledProvider = 'deepseek'; return Promise.resolve({ ok: true, raw: { answers: [] } }); },
      openai: function () { calledProvider = 'openai'; return Promise.resolve({ ok: true, raw: { answers: [{ question_id: 'q1' }] } }); },
    }),
    clientFactory: function () { return fakeClient(function () { calledProvider = 'factory'; return Promise.resolve({ ok: true, raw: {} }); }); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(res.ok, true);
  assert.equal(calledProvider, 'openai');
  assert.equal(res.raw.answers[0].question_id, 'q1');
});

test('PB2: generateAnswers defaults to deepseek when ccp.ai.provider is unset', async () => {
  const session = fakeStorage(); session._store['ccp.ai.sessionKey'] = 'sk-x';
  const local = fakeStorage();
  let calledProvider = null;
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    aiProviders: fakeProviders({
      deepseek: function () { calledProvider = 'deepseek'; return Promise.resolve({ ok: true, raw: { answers: [] } }); },
      openai: function () { calledProvider = 'openai'; return Promise.resolve({ ok: true, raw: { answers: [] } }); },
    }),
    clientFactory: function () { return fakeClient(function () { return Promise.resolve({ ok: true, raw: {} }); }); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(res.ok, true);
  assert.equal(calledProvider, 'deepseek');
});

test('PB3: generateAnswers passes the per-provider model from ccp.ai.model.{provider} to createClient', async () => {
  const session = fakeStorage(); session._store['ccp.ai.sessionKey'] = 'sk-x';
  const local = fakeStorage();
  local._store['ccp.ai.provider'] = 'openai';
  local._store['ccp.ai.model.openai'] = 'gpt-4o';
  let seenModel = null;
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    aiProviders: {
      get: function (id) {
        if (id !== 'openai') return null;
        return { createClient: function (opts) { seenModel = opts.model; return { generateAnswers: function () { return Promise.resolve({ ok: true, raw: { answers: [] } }); } }; } };
      },
      list: function () { return []; },
    },
    clientFactory: function () { return fakeClient(function () { return Promise.resolve({ ok: true }); }); },
  });
  await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(seenModel, 'gpt-4o');
});

test('PB4: generateAnswers passes ccp.ai.baseUrl to createClient for the custom provider', async () => {
  const session = fakeStorage(); session._store['ccp.ai.sessionKey'] = 'sk-x';
  const local = fakeStorage();
  local._store['ccp.ai.provider'] = 'custom';
  local._store['ccp.ai.baseUrl'] = 'https://llm.example.com/v1';
  let seenBase = null;
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    aiProviders: {
      get: function (id) {
        if (id !== 'custom') return null;
        return { createClient: function (opts) { seenBase = opts.baseUrl; return { generateAnswers: function () { return Promise.resolve({ ok: true, raw: { answers: [] } }); } }; } };
      },
      list: function () { return []; },
    },
    clientFactory: function () { return fakeClient(function () { return Promise.resolve({ ok: true }); }); },
  });
  await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(seenBase, 'https://llm.example.com/v1');
});

test('PB5: when no aiProviders dep is injected, generateAnswers falls back to clientFactory (back-compat)', async () => {
  const session = fakeStorage(); session._store['ccp.ai.sessionKey'] = 'sk-x';
  let factoryCalled = false;
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: fakeStorage(),
    clientFactory: function () { return fakeClient(function () { factoryCalled = true; return Promise.resolve({ ok: true, raw: { answers: [] } }); }); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(res.ok, true);
  assert.equal(factoryCalled, true);
});

test('PB6: setProvider from authorized options sender persists ccp.ai.provider and broadcasts providerChanged', async () => {
  const local = fakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: local,
    aiProviders: fakeProviders({ openai: function () {}, deepseek: function () {} }),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
    broadcast: function (m) { broadcasts.push(m); },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' }, 'setProvider', { provider: 'openai' });
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'openai');
  assert.equal(local._store['ccp.ai.provider'], 'openai');
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0], { type: 'ccp.ai.providerChanged' });
});

test('PB7: setProvider persists model and baseUrl when supplied', async () => {
  const local = fakeStorage();
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: local,
    aiProviders: fakeProviders({ custom: function () {} }),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' }, 'setProvider', { provider: 'custom', model: 'my-model', baseUrl: 'https://llm.example.com/v1' });
  assert.equal(res.ok, true);
  assert.equal(local._store['ccp.ai.provider'], 'custom');
  assert.equal(local._store['ccp.ai.model.custom'], 'my-model');
  assert.equal(local._store['ccp.ai.baseUrl'], 'https://llm.example.com/v1');
});

test('PB8: setProvider from a content-script sender is REJECTED — no write, no broadcast', async () => {
  const local = fakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: local,
    aiProviders: fakeProviders({ openai: function () {} }),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: strictCanManageSecrets('chrome-extension://EXT/options.html'),
    broadcast: function (m) { broadcasts.push(m); },
  });
  const res = await callAs(svc, { tab: { id: 1 }, url: 'https://www.coursera.org/learn/x' }, 'setProvider', { provider: 'openai' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'forbidden-sender');
  assert.equal(local._store['ccp.ai.provider'], undefined);
  assert.equal(broadcasts.length, 0);
});

test('PB9: setProvider with an unknown provider id is REFUSED — no write, no broadcast', async () => {
  const local = fakeStorage();
  const broadcasts = [];
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: local,
    aiProviders: fakeProviders({ openai: function () {}, deepseek: function () {} }),
    clientFactory: function () { return fakeClient(function () {}); },
    canManageSecrets: function () { return true; },
    broadcast: function (m) { broadcasts.push(m); },
  });
  const res = await callAs(svc, { url: 'chrome-extension://EXT/options.html' }, 'setProvider', { provider: 'nonexistent' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid-provider');
  assert.equal(local._store['ccp.ai.provider'], undefined);
  assert.equal(broadcasts.length, 0);
});

test('PB10: managed-credits mode still bypasses providers and calls managedClient', async () => {
  const local = fakeStorage(); local._store['ccp.ai.provider'] = 'openai';
  let openaiCalled = false; let managedCalled = false;
  const svc = createAiBackgroundService({
    storageSession: fakeStorage(), storageLocal: local,
    aiProviders: fakeProviders({ openai: function () { openaiCalled = true; return Promise.resolve({ ok: true }); } }),
    clientFactory: function () { return fakeClient(function () {}); },
    managedClient: { generateAnswers: function () { managedCalled = true; return Promise.resolve({ ok: false, reason: 'managed-not-implemented' }); } },
    accessModeProvider: function (cb) { cb('managed-credits'); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(res.reason, 'managed-not-implemented');
  assert.equal(openaiCalled, false);
  assert.equal(managedCalled, true);
});

test('PB11: generated result never contains the stored key', async () => {
  const session = fakeStorage(); session._store['ccp.ai.sessionKey'] = 'sk-LEAK-PB11';
  const local = fakeStorage(); local._store['ccp.ai.provider'] = 'openai';
  const svc = createAiBackgroundService({
    storageSession: session, storageLocal: local,
    aiProviders: fakeProviders({ openai: function (snap, key) { return Promise.resolve({ ok: true, raw: { answers: [] } }); } }),
    clientFactory: function () { return fakeClient(function () {}); },
  });
  const res = await callAs(svc, { tab: { id: 1 } }, 'generateAnswers', { snapshot: { page: {}, questions: [], token: 't' } });
  assert.equal(JSON.stringify(res).indexOf('sk-LEAK-PB11'), -1);
});
```
- [ ] **Step 2 — Run it, expect FAIL.** `node --test "tests/ai-background-service.test.js"` — expected FAIL: PB1 calls `clientFactory`'s client (not the provider), `setProvider` returns `unknown-command`.
- [ ] **Step 3 — Minimal implementation.** Edit `lib/ai-background-service.js`. (a) After the existing `var broadcast = …` line (`L46`), add provider deps and a resolver:
```js
    // Phase B: provider-agnostic generation. When aiProviders is injected, the
    // adapter-backed client is re-resolved PER generateAnswers call from
    // ccp.ai.provider / ccp.ai.model.{provider} / ccp.ai.baseUrl. When absent,
    // fall back to the once-constructed clientFactory client (back-compat).
    var aiProviders = deps.aiProviders || null;
    var VALID_PROVIDERS = { openai: true, anthropic: true, gemini: true, deepseek: true, custom: true };

    function resolveClient(cb) {
      if (!aiProviders || typeof aiProviders.get !== 'function') { cb(client); return; }
      storageLocal.get(['ccp.ai.provider', 'ccp.ai.baseUrl'], function (g1) {
        var providerId = (g1 && g1['ccp.ai.provider']) || 'deepseek';
        var baseUrl = (g1 && g1['ccp.ai.baseUrl']) || null;
        var adapter = aiProviders.get(providerId) || aiProviders.get('deepseek');
        if (!adapter || typeof adapter.createClient !== 'function') { cb(client); return; }
        storageLocal.get(['ccp.ai.model.' + providerId], function (g2) {
          var model = (g2 && g2['ccp.ai.model.' + providerId]) || undefined;
          cb(adapter.createClient({ model: model, baseUrl: baseUrl }));
        });
      });
    }
```
(b) In the personal-key path inside `generateAnswers` (`L164-178`), replace the direct `client.generateAnswers(...)` invocation with a `resolveClient` wrap:
```js
          readKey(function (key) {
            if (!key) { sendResponse({ ok: false, reason: 'missing-key' }); return; }
            var prior2 = state.byTab.get(k);
            if (prior2) { try { prior2.abort(); } catch (_) {} state.byTab.delete(k); }
            var ctrl = abortControllerFactory();
            state.byTab.set(k, ctrl);
            resolveClient(function (activeClient) {
              activeClient.generateAnswers(params.snapshot, key, { signal: ctrl.signal }).then(function (res) {
                if (state.byTab.get(k) === ctrl) state.byTab.delete(k);
                sendResponse(res);
              }, function (err) {
                if (state.byTab.get(k) === ctrl) state.byTab.delete(k);
                sendResponse({ ok: false, reason: 'network', detail: (err && err.message) ? String(err.message).slice(0, 80) : '' });
              });
            });
          });
```
(c) Add a `setProvider` command branch immediately before the `setAccessMode` branch (`L191`):
```js
      if (cmd === 'setProvider') {
        if (!canManageSecrets(sender)) { sendResponse({ ok: false, reason: 'forbidden-sender' }); return false; }
        var p = params && params.provider;
        if (!VALID_PROVIDERS[p]) { sendResponse({ ok: false, reason: 'invalid-provider' }); return false; }
        var writes = {}; writes['ccp.ai.provider'] = p;
        if (typeof params.model === 'string' && params.model) writes['ccp.ai.model.' + p] = params.model;
        if (typeof params.baseUrl === 'string' && params.baseUrl) writes['ccp.ai.baseUrl'] = params.baseUrl;
        storageLocal.set(writes, function () {
          broadcast({ type: 'ccp.ai.providerChanged' });
          sendResponse({ ok: true, provider: p });
        });
        return true;
      }
```
- [ ] **Step 4 — Run it, expect PASS.** `node --test "tests/ai-background-service.test.js"` — expected PASS (all existing tests + the 11 new PB tests). Then `npm test` — expected PASS.
- [ ] **Step 5 — Commit.** `git add lib/ai-background-service.js tests/ai-background-service.test.js` then `git commit -m "feat(ai-background-service): per-call provider resolution + gated setProvider command"`.

---

### Task 9: background.js wiring — importScripts + aiProviders registry injection

**Files:**
- Modify: `background.js` (`L8-15`, `L65-137`)
- Test: `tests/ai-background-service.test.js` (no new test; background.js is not unit-tested — covered by Task 8's injected-dep tests)

Steps:

- [ ] **Step 1 — No failing test (untested wiring file).** background.js has no test harness; its provider logic is exercised through `tests/ai-background-service.test.js`. This task is the production wiring that hands the real `aiProviders` registry to the already-tested service. Confirm baseline first: `npm test` — expected PASS.
- [ ] **Step 2 — Add ai-providers.js to importScripts.** In `background.js` change the `importScripts(...)` block (`L8-15`) so `lib/ai-providers.js` loads before `lib/deepseek-client.js` (deepseek-client delegates to it):
```js
importScripts(
  'lib/autopilot-state.js',
  'lib/autopilot-authority.js',
  'lib/ai-providers.js',
  'lib/deepseek-client.js',
  'lib/ai-background-service.js',
  'lib/managed-client.js',
  'lib/ai-open-options-background.js'
);
```
- [ ] **Step 3 — Wire aiProviders into the service.** In the AI-service IIFE (`L65-137`), after `const managedMod = …` (`L75`), add a reference to the registry, then pass it to `createAiBackgroundService`. Replace the `createAiBackgroundService({...})` call (`L126-134`) so it includes `aiProviders` while keeping the existing `clientFactory` as the back-compat fallback:
```js
  const providersMod = self.ClipboardCleaner && self.ClipboardCleaner.aiProviders;

  const svc = aiMod.createAiBackgroundService({
    storageSession: storageSession,
    storageLocal: storageLocal,
    aiProviders: providersMod || null,
    clientFactory: function () { return deepseekMod.createClient({}); },
    managedClient: managedMod ? managedMod.createManagedClient({ backendBaseUrl: null }) : null,
    accessModeProvider: readAccessModeFromStorage,
    canManageSecrets: canManageSecretsStrict,
    broadcast: broadcastToTabs,
  });
```
- [ ] **Step 4 — Run the suite, expect PASS.** `npm test` — expected PASS (no test changes; this confirms the wiring edit did not break the JS that other tests `require`). Sanity-check the file parses: `node --check background.js` — expected no output (valid syntax).
- [ ] **Step 5 — Commit.** `git add background.js` then `git commit -m "feat(background): load ai-providers and inject the registry into the AI service"`.

---

### Task 10: options.html — provider select, model field, custom base-URL field

**Files:**
- Modify: `options.html` (`L166-203`)
- Test: `tests/ai-options-controller.test.js`

Steps:

- [ ] **Step 1 — Failing test: options.html contains the new provider/model/base-URL controls and stays provider-neutral.** Append to `tests/ai-options-controller.test.js`:
```js
// === Phase B: provider selection HTML contract ===

test('PB-H1: options.html contains a provider select with data-role="ai-options-provider"', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/<select[^>]*data-role="ai-options-provider"|data-role="ai-options-provider"[^>]*>/.test(html),
    'provider <select> must exist');
});

test('PB-H2: options.html contains a model input and datalist with data-role="ai-options-model"', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/data-role="ai-options-model"/.test(html), 'model input must exist');
  assert.ok(/<datalist/i.test(html), 'a datalist of suggested models must exist');
});

test('PB-H3: options.html contains a custom base-URL field and its toggle container', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/data-role="ai-options-base-url"/.test(html), 'base-url input must exist');
  assert.ok(/data-role="ai-options-base-url-row"/.test(html), 'base-url row container must exist');
});

test('PB-H4: options.html still has NO "DeepSeek" and NO real sk- key after adding provider UI', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.equal(html.indexOf('DeepSeek'), -1, 'options.html must remain provider-neutral (no "DeepSeek")');
  assert.equal(html.match(/sk-[A-Za-z0-9_]{16,}/), null, 'no real-looking key may appear');
});

test('PB-H5: options.html still loads ai-options-controller.js + options.js and has no inline scripts', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/src=["']lib\/ai-options-controller\.js["']/.test(html));
  assert.ok(/src=["']options\.js["']/.test(html));
  const inlineScripts = html.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi) || [];
  assert.equal(inlineScripts.length, 0, 'no inline scripts allowed in MV3');
});

test('PB-H6: options.html loads lib/ai-providers.js (single source of truth for the provider list) before options.js', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  // The tag must exist with a src= (keeps U10-1 "every <script> has a src=" green).
  assert.ok(/<script[^>]*\bsrc=["']lib\/ai-providers\.js["'][^>]*>/.test(html),
    'options.html must include <script src="lib/ai-providers.js"> so window.ClipboardCleaner.aiProviders is the canonical provider list');
  // Load order: ai-providers.js must precede options.js so the registry exists when options.js reads it.
  const idxProviders = html.indexOf('lib/ai-providers.js');
  const idxOptions = html.indexOf('"options.js"') !== -1 ? html.indexOf('"options.js"') : html.indexOf("'options.js'");
  assert.ok(idxProviders !== -1 && idxOptions !== -1 && idxProviders < idxOptions,
    'lib/ai-providers.js must be loaded before options.js');
});
```
- [ ] **Step 2 — Run it, expect FAIL.** `node --test "tests/ai-options-controller.test.js"` — expected FAIL: PB-H1/H2/H3 (controls absent) and PB-H6 (the `lib/ai-providers.js` script tag is not yet present).
- [ ] **Step 3 — Minimal implementation.** In `options.html`, insert a new provider section inside `.byok-section`, immediately after the security-note / before or within the key form. Add this block right after the `<section class="byok-section">` opening `<h2>` (`L179`), before the key `<label>` (`L180`):
```html
      <label class="field-label" for="ai-provider">AI Provider</label>
      <select id="ai-provider" data-role="ai-options-provider"></select>

      <label class="field-label" for="ai-model">Model</label>
      <input id="ai-model" data-role="ai-options-model" type="text" list="ai-model-suggestions" autocomplete="off" spellcheck="false" placeholder="Leave blank for the provider default" />
      <datalist id="ai-model-suggestions"></datalist>

      <div data-role="ai-options-base-url-row" style="display:none;">
        <label class="field-label" for="ai-base-url">Custom base URL (OpenAI-compatible)</label>
        <input id="ai-base-url" data-role="ai-options-base-url" type="text" autocomplete="off" spellcheck="false" placeholder="https://your-endpoint.example.com/v1" />
      </div>
```
Then add the `lib/ai-providers.js` `<script>` tag so the page exposes `window.ClipboardCleaner.aiProviders` as the single source of truth for the provider list. In the existing script block (currently `lib/ai-options-controller.js`, `lib/ui-revision.js`, `options.js` at `L213-215`), insert it as the FIRST script (before `ai-options-controller.js` and before `options.js`):
```html
  <script src="lib/ai-providers.js"></script>
```
This is an external `src=` script, so it keeps U10-1 (`every <script> has a src=` / `no inline scripts`) green, and it satisfies the new PB-H6 load-order assertion.
- [ ] **Step 4 — Run it, expect PASS.** `node --test "tests/ai-options-controller.test.js"` — expected PASS (all existing U6/U9/U10/S2-4 contract tests stay green AND the 6 new PB-H tests pass, including PB-H6's `lib/ai-providers.js`-before-`options.js` load-order check). Then `npm test` — expected PASS.
- [ ] **Step 5 — Commit.** `git add options.html tests/ai-options-controller.test.js` then `git commit -m "feat(options): add provider select, model datalist, custom base-URL field, and load ai-providers.js"`.

---

### Task 11: ai-options-controller.js — wire provider/model/base-URL + setProvider

**Files:**
- Modify: `lib/ai-options-controller.js` (`L21-165`)
- Test: `tests/ai-options-controller.test.js`

Steps:

- [ ] **Step 1 — Failing test: controller populates providers, persists via setProvider, toggles base-URL.** Append to `tests/ai-options-controller.test.js`:
```js
// === Phase B: provider selection controller wiring ===

function makeProviderDom() {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<input data-role="ai-options-key" type="password">'
    + '<button data-action="ai-options-toggle">Show</button>'
    + '<input data-role="ai-options-remember" type="checkbox">'
    + '<button data-action="ai-options-save">Save</button>'
    + '<button data-action="ai-options-clear">Clear</button>'
    + '<div data-role="ai-options-status"></div>'
    + '<select data-role="ai-options-provider"></select>'
    + '<input data-role="ai-options-model" type="text" list="ai-model-suggestions">'
    + '<datalist id="ai-model-suggestions"></datalist>'
    + '<div data-role="ai-options-base-url-row" style="display:none;">'
    + '<input data-role="ai-options-base-url" type="text"></div>'
    + '</body></html>');
  return dom;
}

const PROVIDERS = [
  { id: 'openai', label: 'OpenAI', models: ['gpt-4o-mini', 'gpt-4o'], defaultModel: 'gpt-4o-mini' },
  { id: 'deepseek', label: 'DeepSeek', models: ['deepseek-chat'], defaultModel: 'deepseek-chat' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', models: [], defaultModel: 'gpt-4o-mini' },
];

test('PB-C1: wire() populates the provider select from the injected providerList', async () => {
  const dom = makeProviderDom();
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function () { return { ok: true, keyPresent: false }; }),
    storage: { get: function (k, cb) { cb({}); }, set: function (i, cb) { if (cb) cb(); } },
    providerList: PROVIDERS,
  });
  ctrl.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  const opts = dom.window.document.querySelectorAll('[data-role="ai-options-provider"] option');
  const values = Array.prototype.map.call(opts, function (o) { return o.value; });
  assert.deepEqual(values, ['openai', 'deepseek', 'custom']);
});

test('PB-C2: wire() selects the stored ccp.ai.provider and applies its stored model', async () => {
  const dom = makeProviderDom();
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function () { return { ok: true, keyPresent: false }; }),
    storage: { get: function (keys, cb) { cb({ 'ccp.ai.provider': 'openai', 'ccp.ai.model.openai': 'gpt-4o' }); }, set: function (i, cb) { if (cb) cb(); } },
    providerList: PROVIDERS,
  });
  ctrl.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(dom.window.document.querySelector('[data-role="ai-options-provider"]').value, 'openai');
  assert.equal(dom.window.document.querySelector('[data-role="ai-options-model"]').value, 'gpt-4o');
});

test('PB-C3: changing the provider dispatches setProvider via messenger (no direct storage write)', async () => {
  const dom = makeProviderDom();
  let storageSets = 0;
  const sent = [];
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: { send: function (cmd, params, cb) { sent.push({ cmd: cmd, params: params }); if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: false }); cb({ ok: true }); } },
    storage: { get: function (k, cb) { cb({}); }, set: function (i, cb) { storageSets++; if (cb) cb(); } },
    providerList: PROVIDERS,
  });
  ctrl.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  const sel = dom.window.document.querySelector('[data-role="ai-options-provider"]');
  sel.value = 'openai';
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  const setProv = sent.filter(function (c) { return c.cmd === 'setProvider'; });
  assert.equal(setProv.length, 1);
  assert.equal(setProv[0].params.provider, 'openai');
  assert.equal(storageSets, 0, 'must persist through messenger, never page storage');
});

test('PB-C4: selecting "custom" reveals the base-URL row; other providers hide it', async () => {
  const dom = makeProviderDom();
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: { send: function (cmd, params, cb) { if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: false }); cb({ ok: true }); } },
    storage: { get: function (k, cb) { cb({}); }, set: function (i, cb) { if (cb) cb(); } },
    providerList: PROVIDERS,
  });
  ctrl.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  const sel = dom.window.document.querySelector('[data-role="ai-options-provider"]');
  const row = dom.window.document.querySelector('[data-role="ai-options-base-url-row"]');
  sel.value = 'custom';
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.notEqual(row.style.display, 'none', 'base-url row must be visible for custom');
  sel.value = 'openai';
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(row.style.display, 'none', 'base-url row must hide for non-custom');
});

test('PB-C5: setProvider for custom includes the entered model and baseUrl', async () => {
  const dom = makeProviderDom();
  const sent = [];
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: { send: function (cmd, params, cb) { sent.push({ cmd: cmd, params: params }); if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: false }); cb({ ok: true }); } },
    storage: { get: function (k, cb) { cb({}); }, set: function (i, cb) { if (cb) cb(); } },
    providerList: PROVIDERS,
  });
  ctrl.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  const sel = dom.window.document.querySelector('[data-role="ai-options-provider"]');
  sel.value = 'custom';
  dom.window.document.querySelector('[data-role="ai-options-model"]').value = 'my-model';
  dom.window.document.querySelector('[data-role="ai-options-base-url"]').value = 'https://llm.example.com/v1';
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  const setProv = sent.filter(function (c) { return c.cmd === 'setProvider'; });
  assert.equal(setProv.length, 1);
  assert.deepEqual(setProv[0].params, { provider: 'custom', model: 'my-model', baseUrl: 'https://llm.example.com/v1' });
});

test('PB-C6: no provider controls present → wire() does not throw (backward compatible)', () => {
  const dom = makeDom();
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function () { return { ok: true, keyPresent: false }; }),
    providerList: PROVIDERS,
  });
  assert.doesNotThrow(function () { ctrl.wire(); });
});
```
- [ ] **Step 2 — Run it, expect FAIL.** `node --test "tests/ai-options-controller.test.js"` — expected FAIL: provider select stays empty; no `setProvider` dispatched.
- [ ] **Step 3 — Minimal implementation.** Edit `lib/ai-options-controller.js`. (a) In `createAiOptionsController` read the new dep after `var chromeRuntime = …` (`L27`):
```js
    var providerList = Array.isArray(deps.providerList) ? deps.providerList : [];
```
(b) Add helper functions before `function wire()` (after `populateBuildTag`, `L88`):
```js
    var providerEl = null;
    var modelEl    = null;
    var baseUrlEl  = null;
    var baseUrlRow = null;

    function modelsForProvider(id) {
      for (var i = 0; i < providerList.length; i++) {
        if (providerList[i].id === id) return providerList[i].models || [];
      }
      return [];
    }

    function applyModelSuggestions(id) {
      var dl = doc.getElementById('ai-model-suggestions');
      if (!dl) return;
      dl.innerHTML = '';
      var models = modelsForProvider(id);
      for (var i = 0; i < models.length; i++) {
        var opt = doc.createElement('option');
        opt.value = models[i];
        dl.appendChild(opt);
      }
    }

    function applyBaseUrlVisibility(id) {
      if (baseUrlRow) baseUrlRow.style.display = (id === 'custom') ? '' : 'none';
    }

    function populateProviders(selectedId) {
      if (!providerEl) return;
      providerEl.innerHTML = '';
      for (var i = 0; i < providerList.length; i++) {
        var p = providerList[i];
        var opt = doc.createElement('option');
        opt.value = p.id;
        opt.textContent = p.label;
        providerEl.appendChild(opt);
      }
      if (selectedId) providerEl.value = selectedId;
    }

    function persistProvider() {
      if (!providerEl) return;
      var id = providerEl.value;
      var params = { provider: id };
      if (modelEl && modelEl.value) params.model = modelEl.value;
      if (id === 'custom' && baseUrlEl && baseUrlEl.value) params.baseUrl = baseUrlEl.value;
      // No UI update needed on ack: the select/model/base-URL inputs already reflect
      // the user's choice locally, and the persisted values are re-read on the next
      // wire(). The background `ccp.ai.providerChanged` broadcast is for content-script
      // realms (lib/ai-content-listeners.js); the options page does NOT subscribe to it.
      messenger.send('setProvider', params, function (_res) { /* options select already reflects the choice locally; persisted value is re-read on next wire() */ });
    }

    function readProviderAndApply() {
      var defaultId = (providerList[0] && providerList[0].id) || 'deepseek';
      if (!storage || typeof storage.get !== 'function') {
        populateProviders(defaultId); applyModelSuggestions(defaultId); applyBaseUrlVisibility(defaultId);
        return;
      }
      storage.get(['ccp.ai.provider', 'ccp.ai.baseUrl'], function (got) {
        var id = (got && got['ccp.ai.provider']) || defaultId;
        populateProviders(id);
        applyModelSuggestions(id);
        applyBaseUrlVisibility(id);
        if (baseUrlEl && got && got['ccp.ai.baseUrl']) baseUrlEl.value = got['ccp.ai.baseUrl'];
        storage.get(['ccp.ai.model.' + id], function (g2) {
          if (modelEl && g2 && g2['ccp.ai.model.' + id]) modelEl.value = g2['ccp.ai.model.' + id];
        });
      });
    }
```
(c) Inside `wire()`, after `var portalBtn = …` listener (`L154`), resolve the new elements and attach listeners, then call `readProviderAndApply()` before `readModeAndApply()`:
```js
      providerEl = doc.querySelector('[data-role="ai-options-provider"]');
      modelEl    = doc.querySelector('[data-role="ai-options-model"]');
      baseUrlEl  = doc.querySelector('[data-role="ai-options-base-url"]');
      baseUrlRow = doc.querySelector('[data-role="ai-options-base-url-row"]');

      if (providerEl) {
        providerEl.addEventListener('change', function () {
          applyModelSuggestions(providerEl.value);
          applyBaseUrlVisibility(providerEl.value);
          persistProvider();
        });
      }

      readProviderAndApply();
```
- [ ] **Step 4 — Run it, expect PASS.** `node --test "tests/ai-options-controller.test.js"` — expected PASS (all existing tests + the 6 new PB-C tests). Then `npm test` — expected PASS.
- [ ] **Step 5 — Commit.** `git add lib/ai-options-controller.js tests/ai-options-controller.test.js` then `git commit -m "feat(ai-options-controller): wire provider select, model datalist, base-URL field, and setProvider"`.

---

### Task 12: manifest.json — host permissions + optional custom-endpoint permission

**Files:**
- Modify: `manifest.json` (`L11`)
- Test: `tests/manifest-permissions.test.js` (Create)

Steps:

- [ ] **Step 1 — Failing test: manifest carries all provider host permissions and the optional custom grant.** Create `tests/manifest-permissions.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function manifest() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
}

test('PB-M1: manifest is valid JSON and manifest_version 3', () => {
  const m = manifest();
  assert.equal(m.manifest_version, 3);
});

test('PB-M2: host_permissions include deepseek, openai, anthropic, and gemini API hosts', () => {
  const hp = manifest().host_permissions;
  ['https://api.deepseek.com/*', 'https://api.openai.com/*', 'https://api.anthropic.com/*', 'https://generativelanguage.googleapis.com/*']
    .forEach(function (h) { assert.ok(hp.indexOf(h) !== -1, 'missing host_permission: ' + h); });
});

test('PB-M3: optional_host_permissions requests https://*/* for the custom endpoint (not in always-on host_permissions)', () => {
  const m = manifest();
  assert.ok(Array.isArray(m.optional_host_permissions), 'optional_host_permissions must be an array');
  assert.ok(m.optional_host_permissions.indexOf('https://*/*') !== -1, 'must request https://*/* optionally');
  assert.equal(m.host_permissions.indexOf('https://*/*'), -1, 'broad grant must NOT ship as an always-on host_permission');
});

test('PB-M4: content_scripts.matches remain restricted to Coursera (hard boundary unchanged)', () => {
  const matches = manifest().content_scripts[0].matches.sort();
  assert.deepEqual(matches, ['https://*.coursera.org/*', 'https://coursera.org/*']);
});
```
- [ ] **Step 2 — Run it, expect FAIL.** `node --test "tests/manifest-permissions.test.js"` — expected FAIL: PB-M2 (only deepseek host present), PB-M3 (`optional_host_permissions` undefined).
- [ ] **Step 3 — Minimal implementation.** In `manifest.json`, replace the `host_permissions` line (`L11`) and add `optional_host_permissions` right after it:
```json
  "host_permissions": [
    "https://api.deepseek.com/*",
    "https://api.openai.com/*",
    "https://api.anthropic.com/*",
    "https://generativelanguage.googleapis.com/*"
  ],
  "optional_host_permissions": ["https://*/*"],
```
- [ ] **Step 4 — Run it, expect PASS.** `node --test "tests/manifest-permissions.test.js"` — expected PASS (4 tests). Then `npm test` — expected PASS.
- [ ] **Step 5 — Commit.** `git add manifest.json tests/manifest-permissions.test.js` then `git commit -m "feat(manifest): add provider host_permissions + optional_host_permissions for custom endpoint"`.

---

### Task 13: Custom-endpoint runtime permission request in the options controller

**Files:**
- Modify: `lib/ai-options-controller.js` (`persistProvider`, deps)
- Test: `tests/ai-options-controller.test.js`

Steps:

- [ ] **Step 1 — Failing test: saving a custom provider requests host permission, and a denial blocks setProvider.** Append to `tests/ai-options-controller.test.js`:
```js
// === Phase B: custom endpoint runtime permission ===

test('PB-C7: selecting custom with a base URL requests host permission via the injected permissions API', async () => {
  const dom = makeProviderDom();
  const requested = [];
  const sent = [];
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: { send: function (cmd, params, cb) { sent.push({ cmd: cmd, params: params }); if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: false }); cb({ ok: true }); } },
    storage: { get: function (k, cb) { cb({}); }, set: function (i, cb) { if (cb) cb(); } },
    providerList: PROVIDERS,
    permissions: { request: function (req, cb) { requested.push(req); cb(true); } },
  });
  ctrl.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  const sel = dom.window.document.querySelector('[data-role="ai-options-provider"]');
  sel.value = 'custom';
  dom.window.document.querySelector('[data-role="ai-options-base-url"]').value = 'https://llm.example.com/v1';
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(requested.length, 1, 'must request host permission for the custom origin');
  assert.ok(JSON.stringify(requested[0]).indexOf('llm.example.com') !== -1);
  const setProv = sent.filter(function (c) { return c.cmd === 'setProvider'; });
  assert.equal(setProv.length, 1, 'setProvider proceeds after permission granted');
});

test('PB-C8: if the host-permission request is DENIED, setProvider is NOT sent and a message is shown', async () => {
  const dom = makeProviderDom();
  const sent = [];
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: { send: function (cmd, params, cb) { sent.push({ cmd: cmd, params: params }); if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: false }); cb({ ok: true }); } },
    storage: { get: function (k, cb) { cb({}); }, set: function (i, cb) { if (cb) cb(); } },
    providerList: PROVIDERS,
    permissions: { request: function (req, cb) { cb(false); } },
  });
  ctrl.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  const sel = dom.window.document.querySelector('[data-role="ai-options-provider"]');
  sel.value = 'custom';
  dom.window.document.querySelector('[data-role="ai-options-base-url"]').value = 'https://llm.example.com/v1';
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  const setProv = sent.filter(function (c) { return c.cmd === 'setProvider'; });
  assert.equal(setProv.length, 0, 'setProvider must NOT be sent when permission is denied');
  const status = dom.window.document.querySelector('[data-role="ai-options-status"]');
  assert.ok(/permission/i.test(status.textContent), 'a permission-denied message must be shown');
});

test('PB-C9: non-custom provider change never requests host permission', async () => {
  const dom = makeProviderDom();
  const requested = [];
  const sent = [];
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: { send: function (cmd, params, cb) { sent.push({ cmd: cmd, params: params }); if (cmd === 'keyStatus') return cb({ ok: true, keyPresent: false }); cb({ ok: true }); } },
    storage: { get: function (k, cb) { cb({}); }, set: function (i, cb) { if (cb) cb(); } },
    providerList: PROVIDERS,
    permissions: { request: function (req, cb) { requested.push(req); cb(true); } },
  });
  ctrl.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  const sel = dom.window.document.querySelector('[data-role="ai-options-provider"]');
  sel.value = 'openai';
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(requested.length, 0, 'openai must not trigger a host-permission request');
  assert.equal(sent.filter(function (c) { return c.cmd === 'setProvider'; }).length, 1);
});
```
- [ ] **Step 2 — Run it, expect FAIL.** `node --test "tests/ai-options-controller.test.js"` — expected FAIL: PB-C7/C8/C9 (no `permissions` dep used; `setProvider` sent unconditionally for custom).
- [ ] **Step 3 — Minimal implementation.** Edit `lib/ai-options-controller.js`. (a) Read the new dep after `var providerList = …`:
```js
    var permissions = deps.permissions || null;
```
(b) Add an error/permission message constant near the other status strings (after `STATUS_REMEMBERED`, `L13`):
```js
    var STATUS_CUSTOM_PERMISSION_DENIED = 'Custom endpoint disabled: host permission was not granted.';
```
(c) Add an origin-pattern helper and replace `persistProvider` so the custom path requests permission first:
```js
    function originPatternFromBaseUrl(baseUrl) {
      try {
        var u = new URL(baseUrl);
        return u.protocol + '//' + u.host + '/*';
      } catch (_) { return null; }
    }

    function sendSetProvider() {
      if (!providerEl) return;
      var id = providerEl.value;
      var params = { provider: id };
      if (modelEl && modelEl.value) params.model = modelEl.value;
      if (id === 'custom' && baseUrlEl && baseUrlEl.value) params.baseUrl = baseUrlEl.value;
      // No UI update needed on ack (see persistProvider note): the options inputs
      // already reflect the choice locally; the options page does NOT subscribe to the
      // background `ccp.ai.providerChanged` broadcast (that is content-script-only).
      messenger.send('setProvider', params, function (_res) { /* options select already reflects the choice locally; persisted value is re-read on next wire() */ });
    }

    function persistProvider() {
      if (!providerEl) return;
      var id = providerEl.value;
      if (id === 'custom' && baseUrlEl && baseUrlEl.value && permissions && typeof permissions.request === 'function') {
        var pattern = originPatternFromBaseUrl(baseUrlEl.value);
        if (!pattern) { setStatus(STATUS_CUSTOM_PERMISSION_DENIED); return; }
        permissions.request({ origins: [pattern] }, function (granted) {
          if (!granted) { setStatus(STATUS_CUSTOM_PERMISSION_DENIED); return; }
          sendSetProvider();
        });
        return;
      }
      sendSetProvider();
    }
```
- [ ] **Step 4 — Run it, expect PASS.** `node --test "tests/ai-options-controller.test.js"` — expected PASS (all prior + PB-C1..C9). Then `npm test` — expected PASS.
- [ ] **Step 5 — Commit.** `git add lib/ai-options-controller.js tests/ai-options-controller.test.js` then `git commit -m "feat(ai-options-controller): request optional host permission before enabling a custom endpoint"`.

---

### Task 14: options.js wiring for setProvider/permissions (production glue)

**Files:**
- Modify: `options.js` — pass the real `chrome.permissions` + `providerList` into the controller. (`background.js` needs no further AI-service change in this task; the registry was already injected in Task 9 and verified there.)
- Test: a new drift-guard test in `tests/ai-providers.test.js` (the controller logic itself is covered by Tasks 11/13).

**Decision (resolved — NOT optional):** Because Task 10 adds `<script src="lib/ai-providers.js">` to `options.html` BEFORE `options.js`, `window.ClipboardCleaner.aiProviders` is always defined on the options page in production. The registry is therefore the SINGLE SOURCE OF TRUTH for the provider/model list; `options.js` uses `window.ClipboardCleaner.aiProviders.list()`. The inline array below is a DEFENSIVE BACKSTOP only — it executes solely if the script ever fails to load (e.g., a corrupted package) and must never silently diverge from the registry. Step 2b adds a test pinning the backstop ids to the registry ids.

Steps:

- [ ] **Step 1 — Confirm baseline.** `options.js` is not unit-tested; its controller wiring is covered by the injected-dep tests in Tasks 11/13. Confirm baseline before editing: `npm test` — expected PASS.
- [ ] **Step 2 — Read options.js to find the controller instantiation.** Open `options.js` and locate the `createAiOptionsController({...})` call (it is at `L34`, currently passing `messenger`, `document`, `storage`, `chromeRuntime`, `openPortalFn`). Add `providerList` and `permissions` to that deps object. `providerList` prefers the loaded registry (canonical) and only falls back to the inline backstop array if the registry is somehow absent; `permissions` wraps `chrome.permissions.request`. Concretely, extend the deps object with:
```js
    providerList: (typeof window !== 'undefined' && window.ClipboardCleaner && window.ClipboardCleaner.aiProviders)
      ? window.ClipboardCleaner.aiProviders.list()
      : [
          // DEFENSIVE BACKSTOP only — production uses the registry above (loaded via
          // <script src="lib/ai-providers.js"> in options.html). Step 2b pins these ids
          // to aiProviders.list() so this can never drift from the real adapters.
          { id: 'openai', label: 'OpenAI', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'], defaultModel: 'gpt-4o-mini' },
          { id: 'anthropic', label: 'Anthropic', models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest'], defaultModel: 'claude-3-5-haiku-latest' },
          { id: 'gemini', label: 'Google Gemini', models: ['gemini-1.5-flash', 'gemini-1.5-pro'], defaultModel: 'gemini-1.5-flash' },
          { id: 'deepseek', label: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'], defaultModel: 'deepseek-chat' },
          { id: 'custom', label: 'Custom (OpenAI-compatible)', models: [], defaultModel: 'gpt-4o-mini' },
        ],
    permissions: (typeof chrome !== 'undefined' && chrome.permissions && typeof chrome.permissions.request === 'function')
      ? { request: function (req, cb) { chrome.permissions.request(req, cb); } }
      : null,
```
- [ ] **Step 2b — Failing test: the options.js backstop ids match the registry ids (drift guard).** Append to `tests/ai-providers.test.js` a test that extracts the backstop provider ids from `options.js` source and asserts they equal `aiProviders.list().map(p=>p.id)`. Run it FIRST and watch it FAIL (the backstop array does not yet exist in `options.js`):
```js
test('D-DRIFT: options.js provider backstop ids equal the ai-providers registry ids', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'options.js'), 'utf8');
  // Collect every { id: '...' } literal in the providerList backstop array.
  var backstopIds = [];
  var re = /\{\s*id:\s*'([a-z]+)'/g;
  var m;
  while ((m = re.exec(src)) !== null) { backstopIds.push(m[1]); }
  assert.ok(backstopIds.length >= 5, 'expected the 5-provider backstop array in options.js; found: ' + JSON.stringify(backstopIds));
  var registryIds = aiProviders.list().map(function (p) { return p.id; }).sort();
  assert.deepEqual(backstopIds.slice().sort(), registryIds,
    'options.js backstop provider ids have drifted from lib/ai-providers.js — keep them in sync');
});
```
- [ ] **Step 3 — Implement, then re-run: expect PASS.** After adding the deps in Step 2, `node --test "tests/ai-providers.test.js"` — expected PASS (D-DRIFT now green). Then verify both files parse: `node --check options.js` and `node --check background.js` — expected no output (valid syntax).
- [ ] **Step 4 — Run the full suite, expect PASS.** `npm test` — expected PASS (no behavior regression; the options.html contract tests confirm it still has no `DeepSeek` substring in static HTML and no inline scripts — `DeepSeek` only appears as a runtime-rendered `<select>` option label, never in the static markup, so U9 stays green).
- [ ] **Step 5 — Commit.** `git add options.js tests/ai-providers.test.js` then `git commit -m "feat(options): pass registry provider list + chrome.permissions into the AI options controller, with drift guard"`.

---

### Task 15: Final regression sweep + phase verification

**Files:**
- Test: entire suite

Steps:

- [ ] **Step 1 — Run the complete suite.** `npm test` — expected PASS for ALL tests: the 1253 pre-existing tests plus every test added in this phase (`tests/ai-providers.test.js` 27 — 23 from Tasks 1-6, 3 from Task 7 [require-graph delegation, request-shape, D-PROMPT], 1 from Task 14 [D-DRIFT]; the PB* additions in `tests/ai-background-service.test.js` 11; the PB-H additions in `tests/ai-options-controller.test.js` 6 plus the PB-C additions 9 = 15; and `tests/manifest-permissions.test.js` 4). Confirm the printed `# pass` count equals the prior baseline plus the new total and `# fail 0`.
- [ ] **Step 2 — Run the at-risk legacy suites individually to confirm no contract drift.** `node --test "tests/deepseek-client.test.js"` (expected PASS; runner prints `ℹ tests 20` / `ℹ pass 20` / `ℹ fail 0` — default model `deepseek-chat`, SYSTEM_PROMPT literals, json_object body, key-only-in-header, classifyHttp, timeout/abort/network, 240-char excerpt), then `node --test "tests/ai-background-service.test.js"` (expected PASS — clientFactory back-compat + per-provider routing), then `node --test "tests/ai-options-controller.test.js"` (expected PASS — U6/U9/U10/S2-4 + PB-H + PB-C, no `DeepSeek` in HTML, no inline scripts).
- [ ] **Step 3 — Confirm no key leaks across the new surface.** Re-run `node --test "tests/ai-providers.test.js"` and verify every per-adapter `createClient` end-to-end test asserts `JSON.stringify(r).indexOf(<key>) === -1` AND the request body/URL contain no key substring (openai/deepseek/custom in `Authorization`, anthropic in `x-api-key`, gemini in `x-goog-api-key` header and NOT the URL). Expected PASS.
- [ ] **Step 4 — Syntax-validate the untested wiring files.** `node --check background.js` and `node --check options.js` and `node --check lib/ai-providers.js` and `node --check lib/deepseek-client.js` — expected no output (all valid).
- [ ] **Step 5 — Commit the phase marker (docs only).** No code changes here; if any tracking note is desired, add it to the plan checklist. Run `git add -A` limited to this plan file only if updated, then `git commit -m "test(phaseB): full-suite green — provider-agnostic AI complete"` (skip the commit if there are no staged changes).
