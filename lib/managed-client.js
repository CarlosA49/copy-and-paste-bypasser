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
