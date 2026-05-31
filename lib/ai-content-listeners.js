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
