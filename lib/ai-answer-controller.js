(function (root) {
  'use strict';

  function createAiController(deps) {
    var sidebar = deps.sidebar;
    var qc = deps.questionContext;
    var validator = deps.validator;
    var answerApplier = deps.answerApplier;
    var doc = deps.document;
    var loc = deps.location;
    var openOptionsFn = typeof deps.openOptionsFn === 'function' ? deps.openOptionsFn : function () {};
    var openPortalFn = (typeof deps.openPortalFn === 'function') ? deps.openPortalFn : null;

    // `messenger` is stored in a mutable slot so the test pattern of setting
    // controller.messenger after construction keeps working. The returned object
    // exposes a `messenger` property backed by this slot.
    var _messenger = deps.messenger || null;

    function send(cmd, params, cb) {
      var m = _messenger;
      if (!m || typeof m.send !== 'function') { cb({ ok: false, reason: 'no-messenger' }); return; }
      m.send(cmd, params || {}, cb);
    }

    var _activeSnapshot = null;
    var _activeSuggestions = null;

    function refreshKeyStatus() {
      send('keyStatus', {}, function (res) {
        sidebar.setAiKeyStatus({ keyPresent: !!(res && res.keyPresent), remembered: !!(res && res.remembered) });
        if (typeof sidebar.setAiAccessMode === 'function') {
          sidebar.setAiAccessMode((res && res.accessMode) || 'personal-key');
        }
      });
    }

    function performScan() {
      // U12 Layer 2 — fail-closed guard: refuse blocked pages BEFORE building a snapshot.
      // Disabled UI buttons are not the security boundary; programmatic invocation, stale
      // event handlers, or tests may still call performScan() directly. This must short-
      // circuit before any call to buildQuestionSnapshot/validator/answerApplier/messenger.
      var block = qc.isCurrentPageBlocked(loc, doc);
      if (block && block.blocked) {
        _activeSnapshot = null;
        _activeSuggestions = null;
        sidebar.setAiPageEligibility({
          eligible: false,
          blockedReason: block.reason,
          supportedCount: 0,
          actionableCount: 0,
        });
        sidebar.setAiScanResult(null);
        sidebar.setAiSuggestions(null);
        sidebar.setAiApplyResult({ filled: 0, failed: 0, message: 'AI answer filling is disabled on graded or blocked assessment pages.' });
        return;
      }
      var snap = qc.buildQuestionSnapshot(doc.body, loc, doc);
      _activeSnapshot = snap;
      _activeSuggestions = null;
      sidebar.setAiPageEligibility({
        eligible: snap.page.eligible,
        blockedReason: snap.page.blockedReason,
        supportedCount: snap.supportedCount,
        actionableCount: snap.actionableCount,
      });
      sidebar.setAiScanResult(snap);
      sidebar.setAiSuggestions(null);
      sidebar.setAiApplyResult(null);
    }

    function performGenerate() {
      if (!_activeSnapshot) return;
      // Re-check the current live page. Spec S7: never trust the cached snapshot here.
      var fresh = qc.buildQuestionSnapshot(doc.body, loc, doc);
      if (fresh.page.eligible === false) {
        sidebar.setAiPageEligibility({
          eligible: false,
          blockedReason: fresh.page.blockedReason,
          supportedCount: fresh.supportedCount,
          actionableCount: fresh.actionableCount,
        });
        sidebar.setAiApplyResult({ filled: 0, failed: 0, message: 'AI answer filling is disabled on graded or blocked assessment pages.' });
        return;
      }
      if (fresh.token !== _activeSnapshot.token) {
        sidebar.setAiApplyResult({ filled: 0, failed: 0, message: 'The page changed since you scanned. Scan again before generating suggestions.' });
        return;
      }
      // Adopt the fresh snapshot for downstream validation (token equality already holds; localGuard may have refreshed).
      _activeSnapshot = fresh;
      var sanitized = qc.sanitizeForRequest(_activeSnapshot);
      if (!sanitized.questions || sanitized.questions.length === 0) {
        sidebar.setAiApplyResult({ filled: 0, failed: 0, message: 'No unanswered supported questions to send.' });
        return;
      }
      sidebar.setAiInFlight(true);
      send('generateAnswers', { snapshot: sanitized }, function (res) {
        sidebar.setAiInFlight(false);
        if (!res || !res.ok) {
          var msg = (res && res.reason) ? aiServiceErrorMessage(res.reason) : 'AI request failed.';
          sidebar.setAiSuggestions([]);
          if (sidebar.setAiApplyResult) sidebar.setAiApplyResult({ filled: 0, failed: 0, message: msg });
          return;
        }
        var val = validator.validateAndMap(res.raw, _activeSnapshot, { expectedToken: _activeSnapshot.token });
        if (!val.ok) {
          sidebar.setAiSuggestions([]);
          sidebar.setAiApplyResult({ filled: 0, failed: 0, message: 'The AI service returned an answer format that could not be safely applied.' });
          return;
        }
        _activeSuggestions = val.suggestions;
        sidebar.setAiSuggestions(val.suggestions);
      });
    }

    function performCancel() {
      send('cancelRequest', {}, function () { sidebar.setAiInFlight(false); });
    }

    function performApply() {
      if (!_activeSnapshot || !_activeSuggestions) return;
      var fresh = qc.buildQuestionSnapshot(doc.body, loc, doc);
      if (fresh.token !== _activeSnapshot.token) {
        sidebar.setAiApplyResult({ filled: 0, failed: 0, message: 'The page changed after suggestions were generated. Scan again before applying.' });
        return;
      }
      if (!fresh.page.eligible) {
        sidebar.setAiApplyResult({ filled: 0, failed: 0, message: 'AI answer filling is disabled on graded or blocked assessment pages.' });
        return;
      }
      // Local apply-guard: refuse if the user edited answers after Generate
      var applicableNums = [];
      for (var gi = 0; gi < _activeSuggestions.length; gi++) {
        if (_activeSuggestions[gi].applicable) applicableNums.push(_activeSuggestions[gi].questionNumber);
      }
      var cmp = qc.compareLocalGuards(_activeSnapshot, fresh, applicableNums);
      if (cmp.changed) {
        sidebar.setAiApplyResult({ filled: 0, failed: 0, message: 'Answers were changed after suggestions were generated. Scan again before applying.' });
        return;
      }
      var structured = [];
      for (var i = 0; i < _activeSuggestions.length; i++) {
        var s = _activeSuggestions[i];
        if (!s.applicable) continue;
        var item = { questionNumber: s.questionNumber, type: s.type };
        if (s.choiceText) item.choiceText = s.choiceText;
        if (s.choiceTexts) item.choiceTexts = s.choiceTexts;
        if (s.value) item.value = s.value;
        structured.push(item);
      }
      var result = answerApplier.applyStructuredAnswers(structured, doc.body, { verbose: false });
      sidebar.setAiApplyResult({ filled: result.summary.filled, failed: result.summary.failed });
    }

    function performClearSuggestions() {
      _activeSuggestions = null;
      sidebar.setAiSuggestions(null);
      sidebar.setAiApplyResult(null);
    }

    function aiServiceErrorMessage(reason) {
      switch (reason) {
        case 'missing-key': return 'Enter an AI API Key before generating suggestions.';
        case 'unauthorized': return 'The AI service rejected the API key. Check the key and try again.';
        case 'rate-limit': return 'AI request failed: rate limit.';
        case 'server-error': return 'AI request failed: server error.';
        case 'network': return 'AI request failed: network.';
        case 'timeout': return 'AI request failed: timed out.';
        case 'aborted': return 'AI request was cancelled.';
        case 'invalid-response': return 'The AI service returned an answer format that could not be safely applied.';
        case 'managed-not-implemented': return 'Managed AI Credits are not yet available in this build.';
        default: return 'AI request failed: ' + reason + '.';
      }
    }

    function wire() {
      var OPEN_OPTIONS_FAILURE_MSG = 'Unable to open AI API Key settings. Open the extension options page from chrome://extensions.';
      sidebar.setAiAnswerHandlers({
        onOpenOptions: function () {
          try {
            openOptionsFn(function (res) {
              var ok = !!(res && res.ok === true);
              if (typeof sidebar.setAiOpenOptionsFailure === 'function') {
                try {
                  sidebar.setAiOpenOptionsFailure(ok
                    ? ''
                    : OPEN_OPTIONS_FAILURE_MSG);
                } catch (_) { /* never let UI errors block the click */ }
              }
            });
          } catch (_) {
            if (typeof sidebar.setAiOpenOptionsFailure === 'function') {
              try {
                sidebar.setAiOpenOptionsFailure(OPEN_OPTIONS_FAILURE_MSG);
              } catch (_) {}
            }
          }
        },
        onOpenPortal: function () { if (openPortalFn) openPortalFn(); },
        onScan: performScan,
        onGenerate: performGenerate,
        onCancel: performCancel,
        onApply: performApply,
        onClearSuggestions: performClearSuggestions,
      });
      refreshKeyStatus();
      // Best-effort initial eligibility check (no scan):
      var initBlock = qc.isCurrentPageBlocked(loc, doc);
      sidebar.setAiPageEligibility({ eligible: !initBlock.blocked, blockedReason: initBlock.reason, supportedCount: 0 });
    }

    var controller = {
      wire: wire,
      refreshKeyStatus: refreshKeyStatus,
      performScan: performScan,
      performGenerate: performGenerate,
      performCancel: performCancel,
      performApply: performApply,
      performClearSuggestions: performClearSuggestions,
    };

    // Expose messenger as a settable property so test code can do:
    //   controller.messenger = fakeMessenger(...)
    // and have send() pick it up immediately.
    Object.defineProperty(controller, 'messenger', {
      get: function () { return _messenger; },
      set: function (v) { _messenger = v; },
      enumerable: true,
      configurable: true,
    });

    return controller;
  }

  var api = { createAiController: createAiController };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.ClipboardCleaner = root.ClipboardCleaner || {}; root.ClipboardCleaner.aiAnswerController = api; }
})(typeof self !== 'undefined' ? self : this);
