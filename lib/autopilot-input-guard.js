// lib/autopilot-input-guard.js
// Decides whether a user-input event should pause the autopilot.
// Pure helper + a tiny attachInputListeners utility for content scripts.
(function (root) {
  'use strict';

  const SIDEBAR_HOST_ID = 'ccp-host-root';
  const INPUT_EVENT_TYPES = ['keydown', 'pointerdown', 'mousedown'];

  function isInSidebar(event) {
    const path = (event && typeof event.composedPath === 'function') ? event.composedPath() : [];
    for (let i = 0; i < path.length; i++) {
      const el = path[i];
      if (el && el.id === SIDEBAR_HOST_ID) return true;
    }
    return false;
  }

  function shouldPauseFor(event, settings, opts) {
    if (!event || !event.isTrusted) return false;
    if (!settings || settings.pauseOnUserInput !== true) return false;
    if (isInSidebar(event)) return false;
    if (opts && typeof opts.isSidebarHost === 'function' && opts.isSidebarHost(event)) return false;
    return true;
  }

  function attachInputListeners(target, getSettings, isSidebarHost, onPause) {
    if (!target || typeof target.addEventListener !== 'function') return function () {};
    function handler(ev) {
      let settings = null;
      try { settings = getSettings && getSettings(); } catch (_) { settings = null; }
      if (shouldPauseFor(ev, settings || {}, { isSidebarHost: isSidebarHost })) {
        try { onPause(ev); } catch (_) { /* never break input handling */ }
      }
    }
    INPUT_EVENT_TYPES.forEach(function (t) { target.addEventListener(t, handler, true); });
    return function detach() {
      INPUT_EVENT_TYPES.forEach(function (t) { target.removeEventListener(t, handler, true); });
    };
  }

  const api = {
    shouldPauseFor: shouldPauseFor,
    attachInputListeners: attachInputListeners,
    SIDEBAR_HOST_ID: SIDEBAR_HOST_ID,
    INPUT_EVENT_TYPES: INPUT_EVENT_TYPES,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.autopilotInputGuard = api;
  }
})(typeof self !== 'undefined' ? self : this);
