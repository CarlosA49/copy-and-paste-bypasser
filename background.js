// background.js
// PHASE 11 — extension-scoped service-worker authority. This is the single
// production writer for active-run (RUN_KEY) state. Content scripts send
// commands via chrome.runtime.sendMessage and the authority serialises
// them through one queue; chrome.storage.onChanged carries the broadcast
// back to every content-script realm.

importScripts(
  'lib/autopilot-state.js',
  'lib/autopilot-authority.js',
  'lib/ai-providers.js',
  'lib/deepseek-client.js',
  'lib/ai-background-service.js',
  'lib/managed-client.js',
  'lib/ai-open-options-background.js'
);

(function () {
  'use strict';

  if (!chrome || !chrome.storage || !chrome.storage.local) {
    console.warn('[autopilot-bg] chrome.storage.local unavailable; authority disabled');
    return;
  }
  if (!chrome.runtime || !chrome.runtime.onMessage) {
    console.warn('[autopilot-bg] chrome.runtime.onMessage unavailable; authority disabled');
    return;
  }

  const api = (self.ClipboardCleaner = self.ClipboardCleaner || {});
  const storage = {
    get: function (keys, cb) { chrome.storage.local.get(keys, cb); },
    set: function (items, cb) { chrome.storage.local.set(items, cb); },
  };
  // PHASE 15 — service-worker authority is the public/runtime command
  // surface. publicSurface:true refuses deprecated raw RUN_KEY commands
  // (save, update with run fields, clear, acquireOwnership) at the
  // authority boundary so a stale chrome.runtime.sendMessage from an old
  // content-script realm cannot bypass the PHASE 12–14 fences by naming
  // a legacy command.
  const authority = api.autopilotAuthority.createAuthority(storage, { publicSurface: true });

  // The broadcast across realms happens via chrome.storage.onChanged
  // automatically — every content script listens on it. We don't need to
  // do additional re-broadcasting from the worker. The authority's own
  // subscribe() is used internally if a future feature needs SW-local
  // hooks.

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'autopilot.state') return false;
    let _replied = false;
    authority.dispatch(msg.command, msg.params || {}, function (res) {
      if (_replied) return;
      _replied = true;
      try { sendResponse(res); } catch (_) { /* connection may be torn down */ }
    });
    // Returning true keeps the message channel open for the async response.
    return true;
  });
})();

// === Let AI answer for you — isolated namespace ===
// Thin instantiator: behavior lives in lib/ai-background-service.js (H2).
// Runs in a SECOND onMessage listener with its own state. Never touches
// autopilot authority, RUN_KEY, SETTINGS_KEY, or publicSurface fencing.
(function () {
  'use strict';

  const deepseekMod = self.ClipboardCleaner && self.ClipboardCleaner.deepseekClient;
  if (!deepseekMod) return; // safe-fail: extension still works without the AI feature
  if (!chrome || !chrome.runtime || !chrome.runtime.onMessage) return;

  const aiMod = self.ClipboardCleaner && self.ClipboardCleaner.aiBackgroundService;
  if (!aiMod) return; // safe-fail: service module not loaded

  const managedMod = self.ClipboardCleaner && self.ClipboardCleaner.managedClient;

  function readAccessModeFromStorage(cb) {
    try {
      chrome.storage.local.get(['ccp.ai.accessMode'], function (got) {
        cb((got && got['ccp.ai.accessMode']) || 'personal-key');
      });
    } catch (_) { cb('personal-key'); }
  }

  function adapter(area) {
    return {
      get: function (keys, cb) { area.get(keys, cb); },
      set: function (items, cb) { area.set(items, cb); },
      remove: function (keys, cb) { area.remove(keys, cb); },
    };
  }

  const storageSession = (chrome.storage && chrome.storage.session)
    ? adapter(chrome.storage.session)
    : null;
  const storageLocal = adapter(chrome.storage.local);

  const OPTIONS_URL = (chrome.runtime && chrome.runtime.getURL) ? chrome.runtime.getURL('options.html') : null;
  function canManageSecretsStrict(sender) {
    if (!sender || !OPTIONS_URL) return false;
    var u = sender.url || '';
    if (!u) return false;
    // Match exact options page URL, ignoring any hash/query suffix
    var base = u.split('#')[0].split('?')[0];
    return base === OPTIONS_URL;
  }

  function broadcastToTabs(msg) {
    if (!chrome.tabs || !chrome.tabs.query) return;
    chrome.tabs.query({}, function (tabs) {
      if (!tabs || !tabs.length) return;
      for (var i = 0; i < tabs.length; i++) {
        var tab = tabs[i];
        if (tab && typeof tab.id === 'number') {
          try {
            chrome.tabs.sendMessage(tab.id, msg, function () {
              // Swallow runtime.lastError when no content script is listening
              void (chrome.runtime && chrome.runtime.lastError);
            });
          } catch (_) { /* ignore */ }
        }
      }
    });
  }

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

  chrome.runtime.onMessage.addListener(svc.handleMessage);
})();

// === U11 Issue 1 — open-options navigation listener ===
// Sanitized navigation: handles ONLY {type:'ccp.ai.openOptions'}.
// Authorization is gated by the exported isCourseraSender predicate from
// lib/ai-open-options-background.js, which allows ONLY https://coursera.org/...
// and https://*.coursera.org/...; everything else is rejected with
// {ok:false, reason:'forbidden-sender'} and the opener is NOT invoked.
// This authorization surface is SEPARATE from the canManageSecrets gate that
// protects setSessionKey/clearKey/setAccessMode — granting Coursera origin
// the ability to request settings navigation does NOT grant it any
// secret-management privileges. No keys, no balance, no broadcast.
(function () {
  'use strict';
  if (!chrome || !chrome.runtime || !chrome.runtime.onMessage) return;
  const mod = self.ClipboardCleaner && self.ClipboardCleaner.aiOpenOptionsBackground;
  if (!mod) return;
  function openOptionsPageAdapter(cb) {
    try {
      if (chrome.runtime.openOptionsPage) {
        chrome.runtime.openOptionsPage(function () {
          var err = chrome.runtime && chrome.runtime.lastError;
          cb(err ? err : null);
        });
      } else {
        cb(new Error('openOptionsPage-unavailable'));
      }
    } catch (e) {
      cb(e);
    }
  }
  const handler = mod.createOpenOptionsHandler({
    openOptionsPage: openOptionsPageAdapter,
    canOpenOptions: mod.isCourseraSender,
  });
  chrome.runtime.onMessage.addListener(handler);
})();
