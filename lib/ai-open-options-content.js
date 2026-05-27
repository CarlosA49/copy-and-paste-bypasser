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
