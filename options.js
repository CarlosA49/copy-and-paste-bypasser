'use strict';
// U13 — populate UI Revision label from the source-controlled constant.
(function () {
  function populate() {
    try {
      var uiRev = (typeof window !== 'undefined' && window.ClipboardCleaner && window.ClipboardCleaner.uiRevision) ? window.ClipboardCleaner.uiRevision : null;
      if (uiRev && typeof uiRev.populateUiRevisionTag === 'function') uiRev.populateUiRevisionTag(document);
    } catch (_) { /* never break the options page on label render */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', populate, { once: true });
  } else {
    populate();
  }
})();
(function () {
  var mod = window.ClipboardCleaner && window.ClipboardCleaner.aiOptionsController;
  if (!mod) { console.error('ai-options-controller not loaded'); return; }
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
    chromeRuntime: (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime : null,
    openPortalFn: function () { /* Stage 2: no portal exists; button is disabled. */ },
    providerList: (typeof window !== 'undefined' && window.ClipboardCleaner && window.ClipboardCleaner.aiProviders)
      ? window.ClipboardCleaner.aiProviders.list()
      : [
          // DEFENSIVE BACKSTOP only — production uses the registry above (loaded via
          // <script src="lib/ai-providers.js"> in options.html). The D-DRIFT test pins
          // these ids to aiProviders.list() so this can never drift from the adapters.
          { id: 'openai', label: 'OpenAI', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'], defaultModel: 'gpt-4o-mini' },
          { id: 'anthropic', label: 'Anthropic', models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest'], defaultModel: 'claude-3-5-haiku-latest' },
          { id: 'gemini', label: 'Google Gemini', models: ['gemini-1.5-flash', 'gemini-1.5-pro'], defaultModel: 'gemini-1.5-flash' },
          { id: 'deepseek', label: 'DeepSeek', models: ['deepseek-chat', 'deepseek-reasoner'], defaultModel: 'deepseek-chat' },
          { id: 'custom', label: 'Custom (OpenAI-compatible)', models: [], defaultModel: 'gpt-4o-mini' },
        ],
    permissions: (typeof chrome !== 'undefined' && chrome.permissions && typeof chrome.permissions.request === 'function')
      ? { request: function (req, cb) { chrome.permissions.request(req, cb); } }
      : null,
  });
  ctrl.wire();
})();
