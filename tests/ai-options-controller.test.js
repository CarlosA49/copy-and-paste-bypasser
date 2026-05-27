'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createAiOptionsController } = require('../lib/ai-options-controller.js');

function makeDom() {
  const dom = new JSDOM('<!doctype html><html><body>'
    + '<input data-role="ai-options-key" type="password">'
    + '<button data-action="ai-options-toggle">Show</button>'
    + '<input data-role="ai-options-remember" type="checkbox">'
    + '<button data-action="ai-options-save">Save</button>'
    + '<button data-action="ai-options-clear">Clear</button>'
    + '<div data-role="ai-options-status"></div>'
    + '</body></html>');
  return dom;
}

function fakeMessenger(impl) {
  const calls = [];
  const send = function (cmd, params, cb) {
    calls.push({ cmd: cmd, params: params });
    Promise.resolve(impl(cmd, params)).then(function (r) { cb(r); });
  };
  return { send: send, calls: calls };
}

test('wire() runs an initial keyStatus refresh and renders "no key" by default', async () => {
  const dom = makeDom();
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function (cmd) {
      if (cmd === 'keyStatus') return { ok: true, keyPresent: false, remembered: false };
      return { ok: true };
    }),
  });
  ctrl.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  const status = dom.window.document.querySelector('[data-role="ai-options-status"]');
  assert.equal(status.textContent, 'No AI API Key configured.');
});

test('save sends setSessionKey with the entered key+remember, then clears the input', async () => {
  const dom = makeDom();
  let captured = null;
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function (cmd, params) {
      if (cmd === 'setSessionKey') { captured = params; return { ok: true, keyPresent: true, remember: !!params.remember }; }
      if (cmd === 'keyStatus') return { ok: true, keyPresent: true, remembered: !!params && !!params.remembered };
      return { ok: true };
    }),
  });
  ctrl.wire();
  const input = dom.window.document.querySelector('[data-role="ai-options-key"]');
  const remember = dom.window.document.querySelector('[data-role="ai-options-remember"]');
  input.value = 'sk-pretend';
  remember.checked = false;
  dom.window.document.querySelector('[data-action="ai-options-save"]').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.deepEqual(captured, { key: 'sk-pretend', remember: false });
  // After save, the input must be cleared so the key does not linger in the DOM
  assert.equal(input.value, '');
});

test('save with remember=true sets the params accordingly', async () => {
  const dom = makeDom();
  let captured = null;
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function (cmd, params) {
      if (cmd === 'setSessionKey') { captured = params; return { ok: true, keyPresent: true, remember: true }; }
      if (cmd === 'keyStatus') return { ok: true, keyPresent: true, remembered: true };
      return { ok: true };
    }),
  });
  ctrl.wire();
  dom.window.document.querySelector('[data-role="ai-options-key"]').value = 'sk-r';
  dom.window.document.querySelector('[data-role="ai-options-remember"]').checked = true;
  dom.window.document.querySelector('[data-action="ai-options-save"]').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.deepEqual(captured, { key: 'sk-r', remember: true });
});

test('save renders the session-only status after success', async () => {
  const dom = makeDom();
  let savedRemember = false;
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function (cmd, params) {
      if (cmd === 'setSessionKey') { savedRemember = !!params.remember; return { ok: true, keyPresent: true, remember: savedRemember }; }
      if (cmd === 'keyStatus') return { ok: true, keyPresent: true, remembered: savedRemember };
      return { ok: true };
    }),
  });
  ctrl.wire();
  dom.window.document.querySelector('[data-role="ai-options-key"]').value = 'sk-x';
  dom.window.document.querySelector('[data-action="ai-options-save"]').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(dom.window.document.querySelector('[data-role="ai-options-status"]').textContent,
    'AI API Key configured for this session.');
});

test('save with remember renders the remembered status', async () => {
  const dom = makeDom();
  let savedRemember = false;
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function (cmd, params) {
      if (cmd === 'setSessionKey') { savedRemember = !!params.remember; return { ok: true, keyPresent: true, remember: savedRemember }; }
      if (cmd === 'keyStatus') return { ok: true, keyPresent: true, remembered: savedRemember };
      return { ok: true };
    }),
  });
  ctrl.wire();
  dom.window.document.querySelector('[data-role="ai-options-key"]').value = 'sk-r';
  dom.window.document.querySelector('[data-role="ai-options-remember"]').checked = true;
  dom.window.document.querySelector('[data-action="ai-options-save"]').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(dom.window.document.querySelector('[data-role="ai-options-status"]').textContent,
    'AI API Key remembered on this browser.');
});

test('clear sends clearKey and updates status', async () => {
  const dom = makeDom();
  let cleared = false;
  let keyState = { keyPresent: true, remembered: false };
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function (cmd) {
      if (cmd === 'clearKey') { cleared = true; keyState = { keyPresent: false, remembered: false }; return { ok: true, keyPresent: false }; }
      if (cmd === 'keyStatus') return Object.assign({ ok: true }, keyState);
      return { ok: true };
    }),
  });
  ctrl.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  dom.window.document.querySelector('[data-action="ai-options-clear"]').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(cleared, true);
  assert.equal(dom.window.document.querySelector('[data-role="ai-options-status"]').textContent, 'No AI API Key configured.');
});

test('toggle changes input type only, never the stored value', () => {
  const dom = makeDom();
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function () { return { ok: true, keyPresent: false }; }),
  });
  ctrl.wire();
  const input = dom.window.document.querySelector('[data-role="ai-options-key"]');
  input.value = 'sk-stable';
  dom.window.document.querySelector('[data-action="ai-options-toggle"]').click();
  assert.equal(input.getAttribute('type'), 'text');
  assert.equal(input.value, 'sk-stable');
  dom.window.document.querySelector('[data-action="ai-options-toggle"]').click();
  assert.equal(input.getAttribute('type'), 'password');
  assert.equal(input.value, 'sk-stable');
});

test('empty save renders the empty-key message', async () => {
  const dom = makeDom();
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function (cmd) {
      if (cmd === 'setSessionKey') return { ok: false, reason: 'empty-key' };
      if (cmd === 'keyStatus') return { ok: true, keyPresent: false, remembered: false };
      return { ok: true };
    }),
  });
  ctrl.wire();
  dom.window.document.querySelector('[data-action="ai-options-save"]').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(dom.window.document.querySelector('[data-role="ai-options-status"]').textContent, 'Enter an AI API Key to save.');
});

test('session-storage-unavailable renders the documented message', async () => {
  const dom = makeDom();
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function (cmd) {
      if (cmd === 'setSessionKey') return { ok: false, reason: 'session-storage-unavailable' };
      if (cmd === 'keyStatus') return { ok: true, keyPresent: false, remembered: false };
      return { ok: true };
    }),
  });
  ctrl.wire();
  dom.window.document.querySelector('[data-role="ai-options-key"]').value = 'sk-x';
  dom.window.document.querySelector('[data-action="ai-options-save"]').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  const status = dom.window.document.querySelector('[data-role="ai-options-status"]');
  assert.ok(/AI API Key/i.test(status.textContent) && /session-only/i.test(status.textContent));
});

test('status text always renders via textContent (no HTML injection from server)', async () => {
  // Simulate a misbehaving response with markup in a reason
  const dom = makeDom();
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function (cmd) {
      if (cmd === 'setSessionKey') return { ok: false, reason: '<img data-attack="reason" src=x>' };
      if (cmd === 'keyStatus') return { ok: true, keyPresent: false, remembered: false };
      return { ok: true };
    }),
  });
  ctrl.wire();
  dom.window.document.querySelector('[data-role="ai-options-key"]').value = 'sk-x';
  dom.window.document.querySelector('[data-action="ai-options-save"]').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  const status = dom.window.document.querySelector('[data-role="ai-options-status"]');
  assert.equal(status.querySelector('img[data-attack="reason"]'), null);
  assert.ok(status.textContent.indexOf('<img') !== -1, 'literal text');
});

// === U6: options.html visual contract ===

const fs = require('fs');
const path = require('path');

test('U6: options.html contains a "AI API Key Settings" heading', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/AI API Key Settings/i.test(html));
});

test('U6: options.html contains a security note explicitly contrasting extension settings vs Coursera', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/extension settings/i.test(html), 'must mention extension settings');
  assert.ok(/Coursera/i.test(html), 'must mention Coursera');
});

test('U6: options.html preserves all selectors the controller queries', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  ['ai-options-key', 'ai-options-remember', 'ai-options-status'].forEach(function (r) {
    assert.ok(html.indexOf('data-role="' + r + '"') !== -1, 'missing data-role: ' + r);
  });
  ['ai-options-toggle', 'ai-options-save', 'ai-options-clear'].forEach(function (a) {
    assert.ok(html.indexOf('data-action="' + a + '"') !== -1, 'missing data-action: ' + a);
  });
});

test('U6: options.html save button has data-variant="primary"', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  // Save button must declare data-variant="primary" (either before or after data-action).
  assert.ok(
    /data-action="ai-options-save"[^>]*data-variant="primary"|data-variant="primary"[^>]*data-action="ai-options-save"/.test(html),
    'Save button must be primary'
  );
});

test('U6: options.html clear button has data-variant="danger"', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(
    /data-action="ai-options-clear"[^>]*data-variant="danger"|data-variant="danger"[^>]*data-action="ai-options-clear"/.test(html),
    'Clear button must be visually destructive'
  );
});

test('U6: options.html API key input is password-masked by default', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(
    /data-role="ai-options-key"[^>]*type="password"|type="password"[^>]*data-role="ai-options-key"/.test(html),
    'API key input must default to type="password"'
  );
});

test('U6: options.html still loads ai-options-controller.js and options.js scripts', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/src=["']lib\/ai-options-controller\.js["']/.test(html), 'controller script tag must remain');
  assert.ok(/src=["']options\.js["']/.test(html), 'options.js script tag must remain');
});

test('U6: options.html does NOT include any hardcoded API key string', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  // Match an sk- pattern with 16+ chars (real DeepSeek keys are longer)
  assert.equal(html.match(/sk-[A-Za-z0-9_]{16,}/), null, 'no real-looking key may appear');
});

test('U6: options.html contains the heading element and a remember checkbox label', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/<h1[^>]*>/.test(html), 'h1 heading exists');
  // Remember checkbox carries a visible label mentioning "Remember"
  assert.ok(/Remember/i.test(html));
});

// === U9: provider-neutral wording for ai-options-controller ===

test('U9: status constants are provider-neutral — no DeepSeek in any rendered message', async () => {
  const dom = makeDom();
  let keyState = { keyPresent: false, remembered: false };
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function (cmd) {
      if (cmd === 'keyStatus') return Object.assign({ ok: true }, keyState);
      if (cmd === 'setSessionKey') return { ok: true, keyPresent: true, remember: false };
      return { ok: true };
    }),
  });
  ctrl.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  const status = dom.window.document.querySelector('[data-role="ai-options-status"]');
  // Initial: no key
  assert.equal(status.textContent, 'No AI API Key configured.');

  // After save (session-only)
  keyState = { keyPresent: true, remembered: false };
  dom.window.document.querySelector('[data-role="ai-options-key"]').value = 'sk-x';
  dom.window.document.querySelector('[data-action="ai-options-save"]').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(status.textContent, 'AI API Key configured for this session.');

  // Switch to remembered
  keyState = { keyPresent: true, remembered: true };
  dom.window.document.querySelector('[data-role="ai-options-remember"]').checked = true;
  dom.window.document.querySelector('[data-role="ai-options-key"]').value = 'sk-y';
  dom.window.document.querySelector('[data-action="ai-options-save"]').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(status.textContent, 'AI API Key remembered on this browser.');
});

test('U9: empty-key error renders generic AI API Key wording', async () => {
  const dom = makeDom();
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function (cmd) {
      if (cmd === 'keyStatus') return { ok: true, keyPresent: false };
      if (cmd === 'setSessionKey') return { ok: false, reason: 'empty-key' };
      return { ok: true };
    }),
  });
  ctrl.wire();
  dom.window.document.querySelector('[data-action="ai-options-save"]').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(dom.window.document.querySelector('[data-role="ai-options-status"]').textContent, 'Enter an AI API Key to save.');
});

test('U9: session-storage-unavailable error message is provider-neutral', async () => {
  const dom = makeDom();
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function (cmd) {
      if (cmd === 'keyStatus') return { ok: true, keyPresent: false };
      if (cmd === 'setSessionKey') return { ok: false, reason: 'session-storage-unavailable' };
      return { ok: true };
    }),
  });
  ctrl.wire();
  dom.window.document.querySelector('[data-role="ai-options-key"]').value = 'sk-x';
  dom.window.document.querySelector('[data-action="ai-options-save"]').click();
  await new Promise(function (r) { setTimeout(r, 0); });
  const status = dom.window.document.querySelector('[data-role="ai-options-status"]');
  assert.ok(/AI API Key/i.test(status.textContent));
  assert.equal(status.textContent.indexOf('DeepSeek'), -1);
});

test('U9: options.html heading is "AI API Key Settings" (no provider name)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/AI API Key Settings/i.test(html));
  // No DeepSeek in the options page user-facing text.
  assert.equal(html.indexOf('DeepSeek'), -1, 'options.html must not contain "DeepSeek"');
});

test('U9: options.html field label says "AI API Key"', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/AI API Key/.test(html));
});

// ---------------------------------------------------------------------------
// Task S0-1 — Build indicator
// ---------------------------------------------------------------------------

test('Stage 0: options.html contains a [data-role="ccp-build"] element in the footer', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/data-role="ccp-build"/.test(html), 'options.html must contain [data-role="ccp-build"]');
});

// === S2-4: mode radio + Managed AI Credits section ===

test('S2-4: options.html contains the radio mode toggle and managed section', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.ok(/name="ai-access-mode"/.test(html), 'mode radio group must exist');
  assert.ok(/value="personal-key"/.test(html), 'personal-key option must exist');
  assert.ok(/value="managed-credits"/.test(html), 'managed-credits option must exist');
  assert.ok(/data-action="ai-options-open-portal"/.test(html), 'portal link button must exist');
});

test('S2-4: controller reads stored aiAccessMode and checks the managed radio when stored value is managed', async () => {
  const dom = makeDom();
  dom.window.document.body.insertAdjacentHTML('beforeend',
    '<input type="radio" name="ai-access-mode" value="personal-key" data-role="ai-options-mode-personal-key" />' +
    '<input type="radio" name="ai-access-mode" value="managed-credits" data-role="ai-options-mode-managed-credits" />');
  const ctrl = createAiOptionsController({
    document: dom.window.document,
    messenger: fakeMessenger(function (cmd) {
      if (cmd === 'keyStatus') return { ok: true, keyPresent: false, accessMode: 'managed-credits' };
      return { ok: true };
    }),
    storage: { get: function (k, cb) { cb({ 'ccp.ai.accessMode': 'managed-credits' }); }, set: function (i, cb) { if (cb) cb(); } },
  });
  ctrl.wire();
  await new Promise(function (r) { setTimeout(r, 0); });
  assert.equal(dom.window.document.querySelector('[data-role="ai-options-mode-managed-credits"]').checked, true);
});

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

test('S2-4: invalid stored mode value defaults to personal-key radio checked', async () => {
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

test('S2-4: clicking the portal-link button invokes the injected openPortalFn', () => {
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

test('U10-1: wire() populates [data-role="ccp-build"] with "Build: <manifest.version>" from a mocked chrome.runtime.getManifest()', async () => {
  const dom = makeDom();
  dom.window.document.body.insertAdjacentHTML('beforeend',
    '<div data-role="ccp-build">Build: —</div>');
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
  const m = html.match(/<button[^>]*data-action="ai-options-open-portal"[^>]*>/i);
  if (m) {
    assert.ok(/\bdisabled\b/.test(m[0]),
      'portal button must be disabled until a real portal exists; found: ' + m[0]);
  }
});

test('U10-3: options.html does NOT contain the literal string "Open AI Credits Portal" as an enabled label', () => {
  const fs = require('fs'); const path = require('path');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
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
