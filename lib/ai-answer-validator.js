'use strict';

(function (root) {
  function extractStrictJson(text) {
    if (text == null) return null;
    if (typeof text === 'object') return text;
    var s = String(text).trim();
    try { return JSON.parse(s); } catch (_) {}
    // Tolerate exactly one ```json ... ``` fence.
    var m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (m) {
      try { return JSON.parse(m[1]); } catch (_) {}
    }
    return null;
  }

  function findQuestion(snap, qid) {
    for (var i = 0; i < snap.questions.length; i++) {
      if (snap.questions[i].id === qid) return snap.questions[i];
    }
    return null;
  }

  function findOptionLabel(question, oid) {
    var opts = question.options || [];
    for (var i = 0; i < opts.length; i++) if (opts[i].id === oid) return opts[i].label;
    return null;
  }

  function validateAndMap(rawResponse, snapshot, opts) {
    opts = opts || {};
    if (opts.expectedToken && snapshot && snapshot.token !== opts.expectedToken) {
      return { ok: false, reason: 'stale-snapshot', suggestions: [], rejectedCount: 0 };
    }
    var parsed = typeof rawResponse === 'string' ? extractStrictJson(rawResponse) : rawResponse;
    if (!parsed) return { ok: false, reason: 'invalid-json', suggestions: [], rejectedCount: 0 };
    if (!parsed.answers || !Array.isArray(parsed.answers)) {
      return { ok: false, reason: 'invalid-schema', suggestions: [], rejectedCount: 0 };
    }

    var suggestions = [];
    var rejected = 0;
    for (var i = 0; i < parsed.answers.length; i++) {
      var a = parsed.answers[i] || {};
      var qid = a.question_id;
      var q = qid ? findQuestion(snapshot, qid) : null;
      var explanation = typeof a.explanation === 'string' ? a.explanation.slice(0, 600) : '';
      var confidence = (a.confidence === 'low' || a.confidence === 'medium' || a.confidence === 'high') ? a.confidence : null;
      var ans = a.answer || {};

      if (!q) {
        suggestions.push({
          questionNumber: null, type: null, explanation: explanation, confidence: confidence,
          mappingStatus: 'unknown-question', applicable: false
        });
        rejected++;
        continue;
      }

      var base = {
        questionNumber: q.questionNumber,
        type: q.type,
        explanation: explanation,
        confidence: confidence,
      };

      if (q.type === 'single_choice') {
        if (ans.type !== 'single_choice' || !Array.isArray(ans.option_ids) || ans.option_ids.length !== 1) {
          suggestions.push(Object.assign(base, { mappingStatus: 'wrong-type', applicable: false })); rejected++; continue;
        }
        var lbl = findOptionLabel(q, ans.option_ids[0]);
        if (lbl == null) {
          suggestions.push(Object.assign(base, { mappingStatus: 'unknown-option', applicable: false })); rejected++; continue;
        }
        suggestions.push(Object.assign(base, { choiceText: lbl, mappingStatus: 'matched', applicable: true }));
      } else if (q.type === 'multiple_choice') {
        if (ans.type !== 'multiple_choice' || !Array.isArray(ans.option_ids)) {
          suggestions.push(Object.assign(base, { mappingStatus: 'wrong-type', applicable: false })); rejected++; continue;
        }
        var labels = [];
        var bad = false;
        for (var k = 0; k < ans.option_ids.length; k++) {
          var L = findOptionLabel(q, ans.option_ids[k]);
          if (L == null) { bad = true; break; }
          labels.push(L);
        }
        if (bad) {
          suggestions.push(Object.assign(base, { mappingStatus: 'unknown-option', applicable: false })); rejected++; continue;
        }
        if (labels.length === 0) {
          suggestions.push(Object.assign(base, { mappingStatus: 'missing-answer', applicable: false })); rejected++; continue;
        }
        suggestions.push(Object.assign(base, { choiceTexts: labels, mappingStatus: 'matched', applicable: true }));
      } else if (q.type === 'math_input') {
        if (ans.type !== 'text' || typeof ans.value !== 'string' || ans.value.trim() === '') {
          suggestions.push(Object.assign(base, { mappingStatus: 'wrong-type', applicable: false })); rejected++; continue;
        }
        suggestions.push(Object.assign(base, { value: ans.value.trim(), mappingStatus: 'matched', applicable: true }));
      } else {
        suggestions.push(Object.assign(base, { mappingStatus: 'unsupported', applicable: false })); rejected++;
      }
    }

    return { ok: true, suggestions: suggestions, rejectedCount: rejected };
  }

  var api = { validateAndMap: validateAndMap, extractStrictJson: extractStrictJson };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.ClipboardCleaner = root.ClipboardCleaner || {}; root.ClipboardCleaner.aiAnswerValidator = api; }
})(typeof self !== 'undefined' ? self : this);
