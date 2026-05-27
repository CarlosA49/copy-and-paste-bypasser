// lib/autopilot-messenger.js
// PHASE 11 — transport between content scripts and the state authority.
//
// Two factories, one shape:
//   createInProcessMessenger(authority)
//     For service-worker code and Node tests. send() calls authority.dispatch
//     synchronously; onChange() subscribes via authority.subscribe.
//   createRuntimeMessenger({ runtime, storage, runKey, settingsKey })
//     For production content scripts. send() uses chrome.runtime.sendMessage
//     to reach the service worker; onChange() listens on
//     chrome.storage.onChanged.
//
// Both expose:
//   send(command, params, cb)
//     cb(response) where response is whatever the authority returns,
//     e.g. { ok: true, ... } or { ok: false, reason: 'authority-unavailable' }.
//   onChange(listener)
//     listener({ key, oldValue, newValue }). Returns an unsubscribe fn.
//
// Fail-closed semantics:
//   The runtime messenger does NOT fall back to direct storage.set when the
//   service worker is unreachable. Such a fallback would reintroduce the
//   PHASE 10 cross-realm defect (multiple content scripts writing storage
//   independently, with no serialization). Instead, send() returns
//   { ok: false, reason: 'authority-unavailable' } and the controller treats
//   the operation as cancelled.

(function (root) {
  'use strict';

  function createInProcessMessenger(authority) {
    function send(command, params, cb) {
      authority.dispatch(command, params || {}, function (res) {
        if (cb) try { cb(res); } catch (_) {}
      });
    }
    function onChange(listener) {
      return authority.subscribe(function (ev) { listener(ev); });
    }
    return { send: send, onChange: onChange };
  }

  function createRuntimeMessenger(opts) {
    opts = opts || {};
    const runtime = opts.runtime || (typeof chrome !== 'undefined' ? chrome.runtime : null);
    const storage = opts.storage || (typeof chrome !== 'undefined' ? chrome.storage : null);
    const runKey = opts.runKey || 'ccp_autopilot_run';
    const settingsKey = opts.settingsKey || 'ccp_autopilot_settings';

    function send(command, params, cb) {
      if (!runtime || typeof runtime.sendMessage !== 'function') {
        if (cb) cb({ ok: false, reason: 'authority-unavailable' });
        return;
      }
      try {
        runtime.sendMessage({ type: 'autopilot.state', command: command, params: params || {} }, function (response) {
          if (runtime.lastError) {
            if (cb) cb({ ok: false, reason: 'authority-unavailable', message: runtime.lastError.message });
            return;
          }
          if (cb) cb(response || { ok: false, reason: 'no-response' });
        });
      } catch (e) {
        if (cb) cb({ ok: false, reason: 'authority-unavailable', message: e && e.message });
      }
    }

    function onChange(listener) {
      if (!storage || !storage.onChanged || typeof storage.onChanged.addListener !== 'function') {
        return function () {};
      }
      function handler(changes, areaName) {
        if (areaName !== 'local') return;
        Object.keys(changes || {}).forEach(function (k) {
          if (k !== runKey && k !== settingsKey) return;
          const c = changes[k];
          try { listener({ key: k, oldValue: c && c.oldValue, newValue: c && c.newValue }); } catch (_) {}
        });
      }
      storage.onChanged.addListener(handler);
      return function unsubscribe() {
        try { storage.onChanged.removeListener(handler); } catch (_) {}
      };
    }

    return { send: send, onChange: onChange };
  }

  const api = {
    createInProcessMessenger: createInProcessMessenger,
    createRuntimeMessenger: createRuntimeMessenger,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.autopilotMessenger = api;
  }
})(typeof self !== 'undefined' ? self : this);
