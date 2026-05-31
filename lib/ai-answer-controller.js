(function (root) {
  'use strict';

  function createAiController(deps) {
    var sidebar = deps.sidebar;
    var qc = deps.questionContext;
    var validator = deps.validator;
    var permissive = deps.permissive || null;
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
          try { console.warn('[ai-answer-controller] transport error:', res && res.reason, 'detail:', res && res.detail); } catch (_) {}
          var msg = (res && res.reason) ? aiServiceErrorMessage(res.reason, res.detail) : 'AI request failed.';
          sidebar.setAiSuggestions([]);
          if (sidebar.setAiApplyResult) sidebar.setAiApplyResult({ filled: 0, failed: 0, message: msg });
          return;
        }
        var val = validator.validateAndMap(res.raw, _activeSnapshot, { expectedToken: _activeSnapshot.token });
        var strictApplicableCount = 0;
        if (val.ok) {
          for (var si = 0; si < val.suggestions.length; si++) {
            if (val.suggestions[si].applicable) strictApplicableCount++;
          }
        }
        // Strict success path: ≥1 applicable suggestion → use validator output as-is.
        if (val.ok && strictApplicableCount > 0) {
          _activeSuggestions = val.suggestions;
          sidebar.setAiSuggestions(val.suggestions);
          return;
        }
        // Strict failed OR strict ok but 0 applicable → try permissive bypass.
        if (!val.ok) {
          try { console.warn('[ai-answer-controller] validator rejected:', val.reason, 'raw:', res && res.raw); } catch (_) {}
        } else {
          var statuses = [];
          for (var sj = 0; sj < val.suggestions.length; sj++) {
            statuses.push({ question: val.suggestions[sj].questionNumber, status: val.suggestions[sj].mappingStatus });
          }
          try { console.warn('[ai-answer-controller] 0 applicable suggestions; per-question statuses:', statuses); } catch (_) {}
        }
        var perm = permissive ? permissive.extract(res.raw, _activeSnapshot) : { suggestions: [] };
        var permApplicable = 0;
        for (var pi = 0; pi < perm.suggestions.length; pi++) {
          if (perm.suggestions[pi].applicable) permApplicable++;
        }
        if (permApplicable > 0) {
          try { console.warn('[ai-answer-controller] bypassed validator; permissive yielded', permApplicable, 'applicable suggestion(s)'); } catch (_) {}
          _activeSuggestions = perm.suggestions;
          sidebar.setAiSuggestions(perm.suggestions);
          sidebar.setAiApplyResult({ filled: 0, failed: 0,
            message: 'Bypassed validator — ' + permApplicable + ' forced suggestion(s). Review before applying.' });
          return;
        }
        // Final fallback: route raw response text through numbered-parser apply.
        var rawText = (typeof res.raw === 'string') ? res.raw : (function () {
          try { return JSON.stringify(res.raw); } catch (_) { return String(res.raw); }
        })();
        if (rawText && rawText.length > 0) {
          try { console.warn('[ai-answer-controller] permissive yielded 0 applicable; using raw-text fallback'); } catch (_) {}
          _activeSuggestions = { __rawTextFallback: true, rawText: rawText };
          sidebar.setAiSuggestions([{
            questionNumber: null, type: null, mappingStatus: 'raw-text-fallback',
            applicable: true, bypassed: true,
            explanation: 'Will apply raw AI response via numbered-parser when you press Apply.'
          }]);
          sidebar.setAiApplyResult({ filled: 0, failed: 0,
            message: 'Bypassed validator — will apply raw AI response as text. Press Apply to attempt.' });
          return;
        }
        // Nothing recoverable.
        sidebar.setAiSuggestions([]);
        sidebar.setAiApplyResult({ filled: 0, failed: 0,
          message: val.ok
            ? 'AI returned ' + val.suggestions.length + ' suggestion(s) but none were applicable (see console for details).'
            : 'AI returned an unrecognized format (reason: ' + val.reason + '). See console for details.' });
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
      // Raw-text fallback: no per-question structure to local-guard, just apply via numbered-parser.
      if (_activeSuggestions && _activeSuggestions.__rawTextFallback) {
        var resultRaw = answerApplier.applyAnswers(_activeSuggestions.rawText, doc.body, { verbose: false });
        sidebar.setAiApplyResult({
          filled: resultRaw.summary.filled,
          failed: resultRaw.summary.failed,
          message: 'Bypassed (raw text via ' + (resultRaw.mode || 'numbered-parser') + ') — filled ' + resultRaw.summary.filled + ', skipped ' + resultRaw.summary.failed + '.'
        });
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
      var anyBypassed = false;
      for (var i = 0; i < _activeSuggestions.length; i++) {
        var s = _activeSuggestions[i];
        if (!s.applicable) continue;
        if (s.bypassed) anyBypassed = true;
        var item = { questionNumber: s.questionNumber, type: s.type };
        if (s.choiceText) item.choiceText = s.choiceText;
        if (s.choiceTexts) item.choiceTexts = s.choiceTexts;
        if (s.value) item.value = s.value;
        structured.push(item);
      }
      var result = answerApplier.applyStructuredAnswers(structured, doc.body, { verbose: false });
      sidebar.setAiApplyResult(anyBypassed
        ? { filled: result.summary.filled, failed: result.summary.failed,
            message: 'Bypassed validator — filled ' + result.summary.filled + ', skipped ' + result.summary.failed + '.' }
        : { filled: result.summary.filled, failed: result.summary.failed });
    }

    function performClearSuggestions() {
      _activeSuggestions = null;
      sidebar.setAiSuggestions(null);
      sidebar.setAiApplyResult(null);
    }

    function aiServiceErrorMessage(reason, detail) {
      // Append a short, sanitized detail excerpt (when present) so the user can see
      // the real cause (e.g., "Model not found", "Invalid Authentication") in the sidebar
      // instead of just the abstract reason.
      function withDetail(base) {
        if (typeof detail !== 'string' || detail.length === 0) return base;
        return base + ' (' + detail.slice(0, 200) + ')';
      }
      switch (reason) {
        case 'missing-key': return 'Enter an AI API Key before generating suggestions.';
        case 'unauthorized': return withDetail('The AI service rejected the API key. Check the key and try again.');
        case 'rate-limit': return withDetail('AI request failed: rate limit.');
        case 'server-error': return withDetail('AI request failed: server error.');
        case 'network': return withDetail('AI request failed: network.');
        case 'timeout': return 'AI request failed: timed out.';
        case 'aborted': return 'AI request was cancelled.';
        case 'invalid-response': return withDetail('The AI service returned an unexpected response.');
        case 'managed-not-implemented': return 'Managed AI Credits are not yet available in this build.';
        default: return withDetail('AI request failed: ' + reason + '.');
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
