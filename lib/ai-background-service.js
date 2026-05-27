'use strict';
// lib/ai-background-service.js
// H2 — extracted AI message-handler service.
// Behavior-preserving refactor of the setupAiNamespace IIFE from background.js.
// All chrome.storage references are replaced by injected storageSession / storageLocal deps.
// Registers NO listeners; the caller (background.js) does chrome.runtime.onMessage.addListener.

(function (root) {
  'use strict';

  function createAiBackgroundService(deps) {
    deps = deps || {};
    var storageSession = deps.storageSession || null;
    var storageLocal = deps.storageLocal;
    var clientFactory = deps.clientFactory;
    var abortControllerFactory = deps.abortControllerFactory || function () { return new AbortController(); };

    if (!storageLocal) throw new Error('storageLocal is required');
    if (typeof clientFactory !== 'function') throw new Error('clientFactory is required');

    var managedClient = deps.managedClient || null;
    var accessModeProvider = (typeof deps.accessModeProvider === 'function')
      ? deps.accessModeProvider
      : function (cb) { cb('personal-key'); };

    var VALID_MODES = { 'personal-key': true, 'managed-credits': true };
    function readAccessMode(cb) {
      accessModeProvider(function (m) { cb(VALID_MODES[m] ? m : 'personal-key'); });
    }

    // canManageSecrets: predicate that decides whether a sender may call
    // setSessionKey / clearKey. Production background.js passes a strict URL-based
    // variant; the default backstop rejects any content-script sender (has tab.id).
    function defaultCanManageSecrets(sender) {
      // Backstop: reject content-script senders (sender with tab.id). Production
      // background.js passes a stricter predicate that validates sender.url against
      // chrome.runtime.getURL('options.html').
      return !(sender && sender.tab && typeof sender.tab.id === 'number');
    }
    var canManageSecrets = (typeof deps.canManageSecrets === 'function')
      ? deps.canManageSecrets
      : defaultCanManageSecrets;

    // broadcast: optional dep — called with a sanitized payload (no key material)
    // after successful secret mutations so open content scripts can refresh UI.
    var broadcast = (typeof deps.broadcast === 'function') ? deps.broadcast : function () {};

    var SESSION_KEY = 'ccp.ai.sessionKey';
    var LOCAL_KEY   = 'ccp.ai.localKey';
    // Per-tab cancellation: AI generation uses a Map keyed by tab origin so that
    // each tab's in-flight request is tracked independently. Starting a new generate
    // in tab A only aborts any prior generate from tab A; tab B's request is
    // unaffected. Extension-origin senders (options page, popup) share the 'ext' key.
    var state = { byTab: new Map() };
    var client = clientFactory();

    function tabKey(sender) {
      if (sender && sender.tab && typeof sender.tab.id === 'number') return 'tab:' + sender.tab.id;
      return 'ext';
    }

    function readKey(cb) {
      if (storageSession) {
        storageSession.get([SESSION_KEY], function (got) {
          var k = got && got[SESSION_KEY];
          if (k) return cb(k);
          storageLocal.get([LOCAL_KEY], function (g2) { cb((g2 && g2[LOCAL_KEY]) || null); });
        });
      } else {
        storageLocal.get([LOCAL_KEY], function (g2) { cb((g2 && g2[LOCAL_KEY]) || null); });
      }
    }

    function handle(msg, sender, sendResponse) {
      var cmd = msg.command;
      var params = msg.params || {};

      if (cmd === 'setSessionKey') {
        if (!canManageSecrets(sender)) { sendResponse({ ok: false, reason: 'forbidden-sender' }); return false; }
        var k = (params.key || '').toString();
        if (!k) { sendResponse({ ok: false, reason: 'empty-key' }); return false; }
        if (params.remember) {
          // remember=true: persist to local (and optionally mirror to session)
          var afterLocal = function () {
            if (storageSession) {
              var ws = {}; ws[SESSION_KEY] = k;
              storageSession.set(ws, function () {
                broadcast({ type: 'ccp.ai.keyStatusChanged' });
                sendResponse({ ok: true, keyPresent: true, remember: true });
              });
            } else {
              broadcast({ type: 'ccp.ai.keyStatusChanged' });
              sendResponse({ ok: true, keyPresent: true, remember: true });
            }
          };
          var wl = {}; wl[LOCAL_KEY] = k;
          storageLocal.set(wl, afterLocal);
          return true;
        }
        // remember=false: session-only — fail closed if session unavailable
        if (!storageSession) {
          sendResponse({ ok: false, reason: 'session-storage-unavailable' });
          return false;
        }
        var ws2 = {}; ws2[SESSION_KEY] = k;
        storageSession.set(ws2, function () {
          // Purge any previously persisted local key
          storageLocal.remove([LOCAL_KEY], function () {
            broadcast({ type: 'ccp.ai.keyStatusChanged' });
            sendResponse({ ok: true, keyPresent: true, remember: false });
          });
        });
        return true;
      }

      if (cmd === 'clearKey') {
        if (!canManageSecrets(sender)) { sendResponse({ ok: false, reason: 'forbidden-sender' }); return false; }
        var afterSessionClear = function () {
          storageLocal.remove([LOCAL_KEY], function () {
            broadcast({ type: 'ccp.ai.keyStatusChanged' });
            sendResponse({ ok: true, keyPresent: false });
          });
        };
        if (storageSession) storageSession.remove([SESSION_KEY], afterSessionClear);
        else afterSessionClear();
        return true;
      }

      if (cmd === 'keyStatus') {
        var hasSession = false, hasLocal = false, mode = 'personal-key';
        function done() { sendResponse({ ok: true, keyPresent: !!(hasSession || hasLocal), remembered: !!hasLocal, accessMode: mode }); }
        function checkMode() { readAccessMode(function (m) { mode = m; done(); }); }
        function checkLocal() { storageLocal.get([LOCAL_KEY], function (g) { hasLocal = !!(g && g[LOCAL_KEY]); checkMode(); }); }
        if (storageSession) {
          storageSession.get([SESSION_KEY], function (g) { hasSession = !!(g && g[SESSION_KEY]); checkLocal(); });
        } else {
          checkLocal();
        }
        return true;
      }

      if (cmd === 'generateAnswers') {
        var k = tabKey(sender);
        readAccessMode(function (mode) {
          if (mode === 'managed-credits') {
            if (!managedClient || typeof managedClient.generateAnswers !== 'function') {
              sendResponse({ ok: false, reason: 'managed-not-implemented' });
              return;
            }
            var prior = state.byTab.get(k);
            if (prior) { try { prior.abort(); } catch (_) {} state.byTab.delete(k); }
            var mctrl = abortControllerFactory();
            state.byTab.set(k, mctrl);
            managedClient.generateAnswers(params.snapshot, null, { signal: mctrl.signal }).then(function (res) {
              if (state.byTab.get(k) === mctrl) state.byTab.delete(k);
              sendResponse(res);
            }, function (err) {
              if (state.byTab.get(k) === mctrl) state.byTab.delete(k);
              sendResponse({ ok: false, reason: 'network', detail: (err && err.message) ? String(err.message).slice(0, 80) : '' });
            });
            return;
          }
          // personal-key path: existing behavior unchanged.
          readKey(function (key) {
            if (!key) { sendResponse({ ok: false, reason: 'missing-key' }); return; }
            // Cancel any previous request for THIS tab/key only.
            var prior2 = state.byTab.get(k);
            if (prior2) { try { prior2.abort(); } catch (_) {} state.byTab.delete(k); }
            var ctrl = abortControllerFactory();
            state.byTab.set(k, ctrl);
            client.generateAnswers(params.snapshot, key, { signal: ctrl.signal }).then(function (res) {
              if (state.byTab.get(k) === ctrl) state.byTab.delete(k);
              sendResponse(res);
            }, function (err) {
              if (state.byTab.get(k) === ctrl) state.byTab.delete(k);
              sendResponse({ ok: false, reason: 'network', detail: (err && err.message) ? String(err.message).slice(0, 80) : '' });
            });
          });
        });
        return true;
      }

      if (cmd === 'cancelRequest') {
        var k2 = tabKey(sender);
        var c = state.byTab.get(k2);
        if (c) { try { c.abort(); } catch (_) {} state.byTab.delete(k2); }
        sendResponse({ ok: true });
        return false;
      }

      if (cmd === 'setAccessMode') {
        if (!canManageSecrets(sender)) { sendResponse({ ok: false, reason: 'forbidden-sender' }); return false; }
        var mode = params && params.mode;
        if (!VALID_MODES[mode]) { sendResponse({ ok: false, reason: 'invalid-mode' }); return false; }
        var write = {}; write['ccp.ai.accessMode'] = mode;
        storageLocal.set(write, function () {
          broadcast({ type: 'ccp.ai.accessModeChanged' });
          sendResponse({ ok: true, accessMode: mode });
        });
        return true;
      }

      sendResponse({ ok: false, reason: 'unknown-command', command: cmd });
      return false;
    }

    function handleMessage(msg, sender, sendResponse) {
      if (!msg || msg.type !== 'ccp.ai.request') return false;
      try { return handle(msg, sender || {}, sendResponse); } catch (e) {
        sendResponse({ ok: false, reason: 'handler-error', detail: String((e && e.message) || '').slice(0, 80) });
        return false;
      }
    }

    return { handleMessage: handleMessage, _state: state };
  }

  var api = { createAiBackgroundService: createAiBackgroundService };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.aiBackgroundService = api;
  }
})(typeof self !== 'undefined' ? self : this);
