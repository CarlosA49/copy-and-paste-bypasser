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
    var providerList = Array.isArray(deps.providerList) ? deps.providerList : [];
    var permissions = deps.permissions || null;
    var providerEl = null;
    var modelEl = null;
    var baseUrlEl = null;
    var baseUrlRow = null;
    var STATUS_CUSTOM_PERMISSION_DENIED = 'Custom endpoint disabled: host permission was not granted.';

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

    function modelsForProvider(id) {
      for (var i = 0; i < providerList.length; i++) {
        if (providerList[i].id === id) return providerList[i].models || [];
      }
      return [];
    }

    function applyModelSuggestions(id) {
      var dl = doc.getElementById('ai-model-suggestions');
      if (!dl) return;
      dl.innerHTML = '';
      var models = modelsForProvider(id);
      for (var i = 0; i < models.length; i++) {
        var opt = doc.createElement('option');
        opt.value = models[i];
        dl.appendChild(opt);
      }
    }

    function applyBaseUrlVisibility(id) {
      if (baseUrlRow) baseUrlRow.style.display = (id === 'custom') ? '' : 'none';
    }

    function populateProviders(selectedId) {
      if (!providerEl) return;
      providerEl.innerHTML = '';
      for (var i = 0; i < providerList.length; i++) {
        var p = providerList[i];
        var opt = doc.createElement('option');
        opt.value = p.id;
        opt.textContent = p.label;
        providerEl.appendChild(opt);
      }
      if (selectedId) providerEl.value = selectedId;
    }

    function originPatternFromBaseUrl(baseUrl) {
      try {
        var u = new URL(baseUrl);
        return u.protocol + '//' + u.host + '/*';
      } catch (_) { return null; }
    }

    function sendSetProvider() {
      if (!providerEl) return;
      var id = providerEl.value;
      var params = { provider: id };
      if (modelEl && modelEl.value) params.model = modelEl.value;
      if (id === 'custom' && baseUrlEl && baseUrlEl.value) params.baseUrl = baseUrlEl.value;
      // Persist through the background via messenger (never a direct page storage
      // write). The options inputs already reflect the choice locally; the persisted
      // value is re-read on the next wire().
      messenger.send('setProvider', params, function (_res) { /* options select already reflects the choice locally */ });
    }

    function persistProvider() {
      if (!providerEl) return;
      var id = providerEl.value;
      // A custom endpoint needs host permission for its origin before we enable it.
      if (id === 'custom' && baseUrlEl && baseUrlEl.value && permissions && typeof permissions.request === 'function') {
        var pattern = originPatternFromBaseUrl(baseUrlEl.value);
        if (!pattern) { setStatus(STATUS_CUSTOM_PERMISSION_DENIED); return; }
        permissions.request({ origins: [pattern] }, function (granted) {
          if (!granted) { setStatus(STATUS_CUSTOM_PERMISSION_DENIED); return; }
          sendSetProvider();
        });
        return;
      }
      sendSetProvider();
    }

    function readProviderAndApply() {
      var defaultId = (providerList[0] && providerList[0].id) || 'deepseek';
      if (!storage || typeof storage.get !== 'function') {
        populateProviders(defaultId); applyModelSuggestions(defaultId); applyBaseUrlVisibility(defaultId);
        return;
      }
      storage.get(['ccp.ai.provider', 'ccp.ai.baseUrl'], function (got) {
        var id = (got && got['ccp.ai.provider']) || defaultId;
        populateProviders(id);
        applyModelSuggestions(id);
        applyBaseUrlVisibility(id);
        if (baseUrlEl && got && got['ccp.ai.baseUrl']) baseUrlEl.value = got['ccp.ai.baseUrl'];
        storage.get(['ccp.ai.model.' + id], function (g2) {
          if (modelEl && g2 && g2['ccp.ai.model.' + id]) modelEl.value = g2['ccp.ai.model.' + id];
        });
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

      providerEl = doc.querySelector('[data-role="ai-options-provider"]');
      modelEl    = doc.querySelector('[data-role="ai-options-model"]');
      baseUrlEl  = doc.querySelector('[data-role="ai-options-base-url"]');
      baseUrlRow = doc.querySelector('[data-role="ai-options-base-url-row"]');

      if (providerEl) {
        providerEl.addEventListener('change', function () {
          applyModelSuggestions(providerEl.value);
          applyBaseUrlVisibility(providerEl.value);
          persistProvider();
        });
      }

      readProviderAndApply();

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
