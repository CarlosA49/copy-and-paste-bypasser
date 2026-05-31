'use strict';
// lib/ai-open-options-background.js
// U11 Issue 1 — tiny tested handler that opens the extension options page
// from the MV3 service-worker context in response to a sanitized runtime
// message ({type:'ccp.ai.openOptions'}). The handler:
//  - only responds to the openOptions message type
//  - enforces a two-stage gate: (1) canOpenOptions(sender) authorization,
//    (2) injected openOptionsPage(cb) adapter
//  - responds {ok:true} on success, {ok:false, reason:'forbidden-sender'} on
//    auth failure, {ok:false, reason:'open-options-failed'} on adapter failure
//  - never reads or returns any key/balance/account/token/credit
//  - is SEPARATE from secret-management authorization (canManageSecrets used by
//    setSessionKey/clearKey/setAccessMode in ai-background-service.js) — this
//    factory does not accept that dep and cannot grant secret-management
//    privileges to the Coursera origin allowed here
//  - default canOpenOptions is deny-all (fail-closed): callers must inject the
//    appropriate predicate explicitly

(function (root) {
  'use strict';

  // Production predicate exported alongside the factory. Allows ONLY:
  //   - https://coursera.org/...
  //   - https://<any-subdomain>.coursera.org/...
  // Rejects: non-https, lookalike hosts, unrelated origins, extension pages,
  // missing/malformed URLs.
  function isCourseraSender(sender) {
    if (!sender || typeof sender.url !== 'string' || sender.url.length === 0) return false;
    var u;
    try { u = new URL(sender.url); } catch (_) { return false; }
    if (u.protocol !== 'https:') return false;
    var host = u.hostname;
    return host === 'coursera.org' || (host.length > '.coursera.org'.length && host.endsWith('.coursera.org'));
  }

  function defaultDenyAll() { return false; }

  function createOpenOptionsHandler(deps) {
    var openOptionsPage = (deps && typeof deps.openOptionsPage === 'function') ? deps.openOptionsPage : null;
    var canOpenOptions = (deps && typeof deps.canOpenOptions === 'function') ? deps.canOpenOptions : defaultDenyAll;
    return function handleMessage(msg, sender, sendResponse) {
      if (!msg || msg.type !== 'ccp.ai.openOptions') return false;
      if (!canOpenOptions(sender)) {
        sendResponse({ ok: false, reason: 'forbidden-sender' });
        return false;
      }
      if (!openOptionsPage) {
        sendResponse({ ok: false, reason: 'open-options-failed' });
        return false;
      }
      try {
        openOptionsPage(function (err) {
          if (err) sendResponse({ ok: false, reason: 'open-options-failed' });
          else sendResponse({ ok: true });
        });
        return true;
      } catch (_) {
        sendResponse({ ok: false, reason: 'open-options-failed' });
        return false;
      }
    };
  }

  var api = {
    createOpenOptionsHandler: createOpenOptionsHandler,
    isCourseraSender: isCourseraSender,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.ClipboardCleaner = root.ClipboardCleaner || {}; root.ClipboardCleaner.aiOpenOptionsBackground = api; }
})(typeof self !== 'undefined' ? self : this);
