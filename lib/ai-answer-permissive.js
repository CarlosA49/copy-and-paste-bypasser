'use strict';

// Permissive bypass extractor — runs when the strict validator can't produce
// applicable suggestions. Recovers a best-effort structured suggestion list
// from whatever shape the AI returned. See:
//   docs/superpowers/specs/2026-05-28-ai-permissive-bypass-design.md

(function (root) {
  function req(name, browserName) {
    if (typeof module !== 'undefined' && module.exports) return require(name);
    return root.ClipboardCleaner && root.ClipboardCleaner[browserName];
  }
  var validator = req('./ai-answer-validator.js', 'aiAnswerValidator');

  function lenientParse(raw) {
    if (raw == null) return null;
    if (typeof raw === 'object') return raw;
    var s = String(raw);
    var parsed = validator.extractStrictJson(s);
    if (parsed) return parsed;
    var m = s.match(/[\{\[][\s\S]*[\}\]]/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
    return null;
  }

  function findAnswersArray(parsed) {
    if (!parsed) return null;
    if (Array.isArray(parsed.answers)) return parsed.answers;
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed === 'object') {
      var keys = Object.keys(parsed);
      for (var i = 0; i < keys.length; i++) {
        var v = parsed[keys[i]];
        if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') return v;
      }
      // One level deeper.
      for (var j = 0; j < keys.length; j++) {
        var inner = parsed[keys[j]];
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
          var found = findAnswersArray(inner);
          if (found) return found;
        }
      }
    }
    return null;
  }

  function findQuestion(snapshot, item, positionalIdx) {
    var qs = (snapshot && Array.isArray(snapshot.questions)) ? snapshot.questions : [];
    var idCandidates = [item.question_id, item.questionId, item.qid, item.id];
    for (var i = 0; i < idCandidates.length; i++) {
      var c = idCandidates[i];
      if (typeof c !== 'string') continue;
      for (var k = 0; k < qs.length; k++) {
        if (qs[k].id === c) return qs[k];
      }
    }
    var numCandidates = [item.question_number, item.questionNumber, item.q, item.number];
    for (var j = 0; j < numCandidates.length; j++) {
      var n = numCandidates[j];
      if (typeof n !== 'number' || !isFinite(n)) continue;
      for (var m = 0; m < qs.length; m++) {
        if (qs[m].questionNumber === n) return qs[m];
      }
    }
    if (positionalIdx >= 0 && positionalIdx < qs.length) return qs[positionalIdx];
    return null;
  }

  function coerceArrayToString(v) {
    if (!Array.isArray(v)) return null;
    var parts = [];
    for (var i = 0; i < v.length; i++) {
      if (typeof v[i] === 'string') parts.push(v[i]);
      else if (typeof v[i] === 'number' && isFinite(v[i])) parts.push(String(v[i]));
    }
    return parts.length ? parts.join(', ') : null;
  }

  function extractAnswerString(item) {
    if (item == null) return null;
    if (typeof item === 'string') return item.trim() || null;
    if (typeof item === 'number' && isFinite(item)) return String(item);
    var sources = [];
    sources.push(item);
    if (item.answer && typeof item.answer === 'object') sources.push(item.answer);
    if (item.answer && typeof item.answer !== 'object') {
      if (typeof item.answer === 'string') { var s = item.answer.trim(); if (s) return s; }
      if (typeof item.answer === 'number' && isFinite(item.answer)) return String(item.answer);
    }
    var stringKeys = ['value', 'text', 'option_id', 'letter'];
    var arrayKeys = ['option_ids', 'letters', 'values'];
    for (var i = 0; i < sources.length; i++) {
      var src = sources[i];
      for (var sk = 0; sk < stringKeys.length; sk++) {
        var raw = src[stringKeys[sk]];
        if (typeof raw === 'string' && raw.trim()) return raw.trim();
        if (typeof raw === 'number' && isFinite(raw)) return String(raw);
      }
      for (var ak = 0; ak < arrayKeys.length; ak++) {
        var arr = src[arrayKeys[ak]];
        var joined = coerceArrayToString(arr);
        if (joined) return joined;
      }
    }
    return null;
  }

  function splitCommasAndAnd(s) {
    if (typeof s !== 'string') return [];
    return s.replace(/[\[\]]/g, '').replace(/\band\b/gi, ',').split(',')
      .map(function (p) { return p.trim(); })
      .filter(Boolean);
  }

  function extract(rawResponse, snapshot) {
    var parsed = lenientParse(rawResponse);
    if (!parsed) return { suggestions: [], sourceShape: 'unparseable' };
    var items = findAnswersArray(parsed);
    if (!items || items.length === 0) return { suggestions: [], sourceShape: 'no-array' };

    var out = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i] || {};
      var q = findQuestion(snapshot, item, i);
      var explanation = (item && typeof item.explanation === 'string') ? item.explanation.slice(0, 600) : '';
      if (!q) {
        out.push({
          questionNumber: null, type: null, explanation: explanation,
          mappingStatus: 'bypass-failed', applicable: false, bypassed: true,
        });
        continue;
      }
      var str = extractAnswerString(item);
      if (!str) {
        out.push({
          questionNumber: q.questionNumber, type: q.type, explanation: explanation,
          mappingStatus: 'bypass-failed', applicable: false, bypassed: true,
        });
        continue;
      }
      var suggestion = {
        questionNumber: q.questionNumber,
        type: q.type,
        explanation: explanation,
        mappingStatus: 'bypassed',
        applicable: true,
        bypassed: true,
      };
      if (q.type === 'single_choice') suggestion.choiceText = str;
      else if (q.type === 'multiple_choice') suggestion.choiceTexts = splitCommasAndAnd(str);
      else suggestion.value = str;
      // Multiple-choice with no separators parsed → keep as one-item array.
      if (q.type === 'multiple_choice' && suggestion.choiceTexts.length === 0) {
        suggestion.choiceTexts = [str];
      }
      out.push(suggestion);
    }
    return { suggestions: out, sourceShape: Array.isArray(parsed) ? 'array' : 'object' };
  }

  var api = { extract: extract, lenientParse: lenientParse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.ClipboardCleaner = root.ClipboardCleaner || {}; root.ClipboardCleaner.aiAnswerPermissive = api; }
})(typeof self !== 'undefined' ? self : this);
