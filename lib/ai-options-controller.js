'use strict';
// lib/ai-options-controller.js
// S3 — Extension-origin options-page controller.
// Manages the AI API key entry form, communicating with the background
// service via an injected messenger (chrome.runtime.sendMessage abstraction).
// Testable via jsdom: the document is passed in as a dependency.

(function (root) {
  'use strict';

  var STATUS_NO_KEY       = 'No AI API Key configured.';
  var STATUS_SESSION_ONLY = 'AI API Key configured for this session.';
  var STATUS_REMEMBERED   = 'AI API Key remembered on this browser.';

  var ERROR_MESSAGES = {
    'session-storage-unavailable': "This browser does not support session-only AI API Key storage. Enable Remember on this browser or try again in a supported browser.",
    'forbidden-sender': 'This page cannot set the key (untrusted sender).',
    'empty-key': 'Enter an AI API Key to save.'
  };

  function createAiOptionsController(deps) {
    deps = deps || {};
    var messenger    = deps.messenger;
    var doc          = deps.document;
    var storage      = deps.storage || null;
    var openPortalFn = (typeof deps.openPortalFn === 'function') ? deps.openPortalFn : null;
    var chromeRuntime = deps.chromeRuntime || null;

    if (!messenger) throw new Error('messenger is required');
    if (!doc)       throw new Error('document is required');

    // Lazily-resolved DOM references (populated in wire())
    var inputEl    = null;
    var rememberEl = null;
    var statusEl   = null;

    // ------------------------------------------------------------------ helpers

    function setStatus(text) {
      if (statusEl) statusEl.textContent = text;
    }

    var VALID_MODES_OPT = { 'personal-key': true, 'managed-credits': true };

    function setRadioMode(mode) {
      var normalized = VALID_MODES_OPT[mode] ? mode : 'personal-key';
      var personalRadio = doc.querySelector('[data-role="ai-options-mode-personal-key"]');
      var managedRadio = doc.querySelector('[data-role="ai-options-mode-managed-credits"]');
      if (personalRadio) personalRadio.checked = (normalized === 'personal-key');
      if (managedRadio) managedRadio.checked = (normalized === 'managed-credits');
    }

    function persistMode(mode) {
      messenger.send('setAccessMode', { mode: mode }, function (_res) { /* status managed by accessModeChanged */ });
    }

    function readModeAndApply() {
      if (!storage || typeof storage.get !== 'function') { setRadioMode('personal-key'); return; }
      storage.get(['ccp.ai.accessMode'], function (got) {
        var mode = (got && got['ccp.ai.accessMode']) || 'personal-key';
        setRadioMode(mode);
      });
    }

    function statusFromKeyState(res) {
      if (!res || !res.ok || !res.keyPresent) return STATUS_NO_KEY;
      if (res.remembered) return STATUS_REMEMBERED;
      return STATUS_SESSION_ONLY;
    }

    function errorMessage(reason) {
      if (reason && ERROR_MESSAGES[reason]) return ERROR_MESSAGES[reason];
      return 'Save failed: ' + String(reason || 'unknown') + '.';
    }

    function populateBuildTag() {
      var version = '';
      try {
        if (chromeRuntime && typeof chromeRuntime.getManifest === 'function') {
          var m = chromeRuntime.getManifest();
          if (m && typeof m.version === 'string') version = m.version;
        }
      } catch (_) { /* ignore — fall through to neutral placeholder */ }
      var els = doc.querySelectorAll('[data-role="ccp-build"]');
      for (var i = 0; i < els.length; i++) {
        els[i].textContent = 'Build: ' + (version || '—');
      }
    }

    // ------------------------------------------------------------------ public API

    function refreshStatus() {
      messenger.send('keyStatus', {}, function (res) {
        setStatus(statusFromKeyState(res));
      });
    }

    function save(key, remember) {
      messenger.send('setSessionKey', { key: key, remember: !!remember }, function (res) {
        // Clear the typed key from the DOM regardless of outcome
        if (inputEl) inputEl.value = '';

        if (!res || !res.ok) {
          setStatus(errorMessage(res && res.reason));
          return;
        }
        // Refresh canonical status from background
        refreshStatus();
      });
    }

    function clear() {
      messenger.send('clearKey', {}, function () {
        refreshStatus();
      });
    }

    function wire() {
      inputEl    = doc.querySelector('[data-role="ai-options-key"]');
      rememberEl = doc.querySelector('[data-role="ai-options-remember"]');
      statusEl   = doc.querySelector('[data-role="ai-options-status"]');

      var toggleEl  = doc.querySelector('[data-action="ai-options-toggle"]');
      var saveEl    = doc.querySelector('[data-action="ai-options-save"]');
      var clearEl   = doc.querySelector('[data-action="ai-options-clear"]');

      if (toggleEl) {
        toggleEl.addEventListener('click', function () {
          if (!inputEl) return;
          inputEl.setAttribute('type', inputEl.getAttribute('type') === 'password' ? 'text' : 'password');
        });
      }

      if (saveEl) {
        saveEl.addEventListener('click', function () {
          var key      = inputEl ? inputEl.value : '';
          var remember = rememberEl ? rememberEl.checked : false;
          save(key, remember);
        });
      }

      if (clearEl) {
        clearEl.addEventListener('click', function () {
          clear();
        });
      }

      var personalRadio = doc.querySelector('[data-role="ai-options-mode-personal-key"]');
      var managedRadio = doc.querySelector('[data-role="ai-options-mode-managed-credits"]');
      if (personalRadio) personalRadio.addEventListener('change', function () { if (personalRadio.checked) persistMode('personal-key'); });
      if (managedRadio) managedRadio.addEventListener('change', function () { if (managedRadio.checked) persistMode('managed-credits'); });

      var portalBtn = doc.querySelector('[data-action="ai-options-open-portal"]');
      if (portalBtn) portalBtn.addEventListener('click', function () { if (openPortalFn) openPortalFn(); });

      readModeAndApply();

      populateBuildTag();

      // Initial status load
      refreshStatus();
    }

    return { wire: wire, refreshStatus: refreshStatus, save: save, clear: clear };
  }

  var api = { createAiOptionsController: createAiOptionsController };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.aiOptionsController = api;
  }

})(typeof self !== 'undefined' ? self : this);
