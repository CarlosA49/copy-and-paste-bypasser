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
  });
  ctrl.wire();
})();
