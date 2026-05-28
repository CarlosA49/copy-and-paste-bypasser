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

  function letterToOption(q, raw) {
    if (!q || !Array.isArray(q.options) || q.options.length === 0) return null;
    if (typeof raw !== 'string') return null;
    var s = raw.trim();
    if (!/^[A-Za-z]$/.test(s)) return null;
    var idx = s.toUpperCase().charCodeAt(0) - 65;
    if (idx < 0 || idx >= q.options.length) return null;
    return q.options[idx];
  }

  function findOptionByText(q, raw) {
    if (!q || !Array.isArray(q.options) || q.options.length === 0) return null;
    if (typeof raw !== 'string') return null;
    var s = raw.trim();
    if (!s) return null;
    if (/^[A-Za-z]$/.test(s)) {
      var byLetter = letterToOption(q, s);
      if (byLetter) return byLetter;
    }
    for (var i = 0; i < q.options.length; i++) {
      if (q.options[i].id === s) return q.options[i];
    }
    function norm(t) { return String(t || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
    var n = norm(s);
    for (var j = 0; j < q.options.length; j++) {
      if (norm(q.options[j].label) === n) return q.options[j];
    }
    for (var k = 0; k < q.options.length; k++) {
      var L = norm(q.options[k].label);
      if (L && (L.indexOf(n) !== -1 || n.indexOf(L) !== -1)) return q.options[k];
    }
    function tokens(t) { return norm(t).split(' ').filter(function (x) { return x.length > 1; }); }
    function jaccard(a, b) {
      if (!a.length || !b.length) return 0;
      var A = {}, B = {}, inter = 0, uA = 0, uB = 0;
      a.forEach(function (t) { if (!A[t]) { A[t] = 1; uA++; } });
      b.forEach(function (t) { if (!B[t]) { B[t] = 1; uB++; if (A[t]) inter++; } });
      return inter / (uA + uB - inter);
    }
    var best = null, bestScore = 0;
    for (var m = 0; m < q.options.length; m++) {
      var sc = jaccard(tokens(s), tokens(q.options[m].label));
      if (sc > bestScore) { bestScore = sc; best = q.options[m]; }
    }
    return (best && bestScore >= 0.34) ? best : null;
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
        // Wrap bare-string a.answer as { value: <string> } for uniform handling.
        var rawAns = (typeof a.answer === 'string') ? { value: a.answer } : (a.answer || {});
        // Resolution paths, safest first. First success wins.
        var resolvedId = null;
        if (Array.isArray(rawAns.option_ids) && rawAns.option_ids.length === 1 && typeof rawAns.option_ids[0] === 'string') {
          resolvedId = rawAns.option_ids[0];
        } else if (typeof rawAns.option_id === 'string') {
          resolvedId = rawAns.option_id;
        } else if (typeof rawAns.letter === 'string') {
          var letterOpt = letterToOption(q, rawAns.letter);
          if (letterOpt) resolvedId = letterOpt.id;
        } else if (typeof rawAns.value === 'string') {
          var textOpt = findOptionByText(q, rawAns.value);
          if (textOpt) resolvedId = textOpt.id;
        }
        if (!resolvedId) {
          suggestions.push(Object.assign(base, { mappingStatus: 'wrong-type', applicable: false })); rejected++; continue;
        }
        var lbl = findOptionLabel(q, resolvedId);
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
        var TEXT_LIKE_TYPES = { 'text': 1, 'math_input': 1, 'numerical': 1, 'input': 1, 'string': 1 };
        // Tolerate the many shape variants the AI tends to emit for typed answers:
        //   { type: 'text'|'math_input'|'numerical'|'input'|'string', value: '...' }
        //   { type, text: '...' }              (text alias for value)
        //   { value: '...' }                   (no type)
        //   { type, value: 3.14 }              (numeric value coerced to string)
        //   bare string  a.answer = '0.5'      (no object wrapper)
        //   bare number  a.answer = 7          (no object wrapper)
        // The applier downstream (applyStructuredAnswers + mathNormalize + answerMatcher)
        // is robust to all of these — the validator just needs to extract a non-empty
        // string value and mark the suggestion applicable.
        var rawAns = a.answer;
        var rawVal, ansType;
        if (typeof rawAns === 'string') {
          rawVal = rawAns;
          ansType = null;
        } else if (typeof rawAns === 'number') {
          rawVal = rawAns;
          ansType = null;
        } else if (rawAns && typeof rawAns === 'object') {
          rawVal = (rawAns.value !== undefined ? rawAns.value : rawAns.text);
          ansType = rawAns.type;
        } else {
          rawVal = undefined;
          ansType = null;
        }
        var typeOk = !ansType || (typeof ansType === 'string' && TEXT_LIKE_TYPES[ansType] === 1);
        var stringVal = (typeof rawVal === 'string') ? rawVal
                      : (typeof rawVal === 'number' && isFinite(rawVal)) ? String(rawVal)
                      : null;
        if (!typeOk || stringVal === null || stringVal.trim() === '') {
          suggestions.push(Object.assign(base, { mappingStatus: 'wrong-type', applicable: false })); rejected++; continue;
        }
        suggestions.push(Object.assign(base, { value: stringVal.trim(), mappingStatus: 'matched', applicable: true }));
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
