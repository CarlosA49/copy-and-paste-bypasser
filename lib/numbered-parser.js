// lib/numbered-parser.js
// Cascading parser: turns messy AI output into an ordered list of
// {questionNumber, rawAnswer}. No DOM. No math-normalisation. Dual-export.
(function (root) {
  'use strict';

  function dedupByQuestion(items) {
    const seen = new Set();
    const out = [];
    items.forEach(function (it) {
      if (!it || typeof it.questionNumber !== 'number') return;
      if (typeof it.rawAnswer !== 'string') return;
      const ans = it.rawAnswer.trim();
      if (!ans) return;
      if (seen.has(it.questionNumber)) return;
      seen.add(it.questionNumber);
      out.push({ questionNumber: it.questionNumber, rawAnswer: ans });
    });
    out.sort(function (a, b) { return a.questionNumber - b.questionNumber; });
    return out;
  }

  function fromJSONShape(parsed) {
    const out = [];
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.answers) ? parsed.answers : null);
    if (!list) return [];
    list.forEach(function (item) {
      if (!item || typeof item !== 'object') return;
      const qid = item.question_id != null ? item.question_id : item.questionNumber;
      const ans = item.answer != null ? item.answer : item.value;
      const n = parseInt(qid, 10);
      if (!Number.isFinite(n) || n < 1 || n > 50) return;
      const s = (typeof ans === 'string') ? ans : (ans == null ? '' : String(ans));
      out.push({ questionNumber: n, rawAnswer: s });
    });
    return out;
  }

  function tryJSON(text) {
    try { return JSON.parse(text); } catch (_) { return undefined; }
  }

  function layerDirect(text) {
    const p = tryJSON(text);
    if (p === undefined) return [];
    return fromJSONShape(p);
  }

  function layerFenced(text) {
    const re = /```(?:json)?\s*([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const p = tryJSON(m[1].trim());
      if (p !== undefined) {
        const out = fromJSONShape(p);
        if (out.length) return out;
      }
    }
    return [];
  }

  function layerBraced(text) {
    const a = text.indexOf('{');
    const b = text.lastIndexOf('}');
    if (a === -1 || b <= a) return [];
    const p = tryJSON(text.slice(a, b + 1));
    return p === undefined ? [] : fromJSONShape(p);
  }

  function layerBracketed(text) {
    const a = text.indexOf('[');
    const b = text.lastIndexOf(']');
    if (a === -1 || b <= a) return [];
    const p = tryJSON(text.slice(a, b + 1));
    return p === undefined ? [] : fromJSONShape(p);
  }

  function stripWholeEmphasis(s) {
    let t = s.trim();
    while (true) {
      const m = t.match(/^\*\*(.+)\*\*$/) || t.match(/^\*(.+)\*$/);
      if (!m) break;
      t = m[1].trim();
    }
    return t;
  }

  function layerNumberedList(text) {
    const re = /^\s*(?:\*\*)?\s*(\d{1,2})\s*(?:\*\*)?\s*[.):]\s*(?:\*\*)?\s*(.+?)\s*$/gm;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = parseInt(m[1], 10);
      if (!Number.isFinite(n) || n < 1 || n > 50) continue;
      out.push({ questionNumber: n, rawAnswer: stripWholeEmphasis(m[2]) });
    }
    return out;
  }

  function layerQuestionN(text) {
    const re = /^\s*Question\s+(\d{1,2})\s*[:.\-]\s*(.+?)\s*$/gim;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = parseInt(m[1], 10);
      if (!Number.isFinite(n) || n < 1 || n > 50) continue;
      out.push({ questionNumber: n, rawAnswer: stripWholeEmphasis(m[2]) });
    }
    return out;
  }

  function layerLineFallback(text) {
    const lines = text.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    if (lines.length === 0) return [];
    if (lines.some(function (l) { return /^\d{1,2}[.):]/.test(l); })) return [];
    if (lines.length < 2) return [];
    return lines.map(function (l, i) { return { questionNumber: i + 1, rawAnswer: stripWholeEmphasis(l) }; });
  }

  function parseNumberedAnswers(raw) {
    if (typeof raw !== 'string') return [];
    let text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!text) return [];
    const layers = [layerDirect, layerFenced, layerBraced, layerBracketed,
                    layerNumberedList, layerQuestionN, layerLineFallback];
    for (let i = 0; i < layers.length; i++) {
      const out = dedupByQuestion(layers[i](text));
      if (out.length >= 2) return out;
      if (out.length === 1 && i >= 4) return out;
    }
    return [];
  }

  const api = { parseNumberedAnswers: parseNumberedAnswers };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.numberedParser = api;
  }
})(typeof self !== 'undefined' ? self : this);
