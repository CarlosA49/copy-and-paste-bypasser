// lib/numbered-parser.js
// Cascading parser: turns messy AI output into an ordered list of
// {questionNumber, rawAnswer}. No DOM. No math-normalisation. Dual-export.
(function (root) {
  'use strict';

  const MAX_QUESTION_NUMBER = 100;

  function annotate(entry) {
    const segs = parseAnswerSegments(entry.rawAnswer);
    if (segs) entry.segments = segs;
    else if (isOptionEnumeration(entry.rawAnswer)) entry.enumeration = true;
    return entry;
  }

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
      out.push(annotate({ questionNumber: it.questionNumber, rawAnswer: ans }));
    });
    out.sort(function (a, b) { return a.questionNumber - b.questionNumber; });
    return out;
  }

  // A line is an option enumeration when it lists ≥2 letter labels (A–E)
  // in alphabetical sequence with no separator picking one — e.g.
  // "A: Monopole B: Dipole C: PCB". It provides no actionable selection
  // signal; the applier should refuse rather than guess. Single labels and
  // out-of-order labels do not trigger (bare "B" must keep working).
  function isOptionEnumeration(s) {
    if (typeof s !== 'string') return false;
    const re = /\b([A-E])\s*[:.)]\s*\S/g;
    const labels = [];
    let m;
    while ((m = re.exec(s)) !== null) labels.push(m[1]);
    if (labels.length < 2) return false;
    for (let i = 1; i < labels.length; i++) {
      if (labels[i].charCodeAt(0) !== labels[i - 1].charCodeAt(0) + 1) return false;
    }
    return true;
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
      if (!Number.isFinite(n) || n < 1 || n > MAX_QUESTION_NUMBER) return;
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
      // Full-wrap: **text** or *text*
      const m = t.match(/^\*\*(.+)\*\*$/) || t.match(/^\*(.+)\*$/);
      if (m) { t = m[1].trim(); continue; }
      // Unmatched leading emphasis — produced when a bold number like **1.**
      // is parsed and its closing ** lands at the front of the answer capture.
      const m2 = t.match(/^\*\*\s+(.+)$/) || t.match(/^\*\s+(.+)$/);
      if (m2) { t = m2[1].trim(); continue; }
      break;
    }
    return t;
  }

  function layerNumberedList(text) {
    // The 3rd (?:\*\*)? is intentionally absent here: we let stripWholeEmphasis
    // handle all emphasis markers in the captured answer so that a bold answer
    // like "1. **text**" is fully stripped rather than leaking a trailing "**".
    // The bold-number format "**1.**" is handled by the 2nd (?:\*\*)? group
    // (which consumes the closing ** that immediately follows the digit).
    // Capture groups: (1) question number, (2) delimiter, (3) spaces, (4) answer.
    const re = /^\s*(?:\*\*)?\s*(\d{1,3})\s*(?:\*\*)?\s*([.):])(\s*)(.+?)\s*$/gm;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = parseInt(m[1], 10);
      if (!Number.isFinite(n) || n < 1 || n > MAX_QUESTION_NUMBER) continue;
      // Reject decimal false-positives: "3.7647×10^5" is not "Q3: 7647×10^5".
      // When the delimiter is '.' with no following space and the captured answer
      // starts with a digit, the match is a decimal number, not a list item.
      if (m[2] === '.' && m[3] === '' && /^\d/.test(m[4])) continue;
      out.push({ questionNumber: n, rawAnswer: stripWholeEmphasis(m[4]) });
    }
    return out;
  }

  function layerQuestionN(text) {
    const re = /^\s*Question\s+(\d{1,3})\s*[:.\-]\s*(.+?)\s*$/gim;
    const out = [];
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = parseInt(m[1], 10);
      if (!Number.isFinite(n) || n < 1 || n > MAX_QUESTION_NUMBER) continue;
      out.push({ questionNumber: n, rawAnswer: stripWholeEmphasis(m[2]) });
    }
    return out;
  }

  function layerLineFallback(text) {
    // Strip wrapper preambles/trailers ("Final answers:", "Based on...", etc.)
    // BEFORE assigning positional question numbers — otherwise the preamble
    // becomes Q1's answer and every real answer shifts by one.
    const lines = text.split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 0 && !isWrapperLine(l); });
    if (lines.length === 0) return [];
    if (lines.some(function (l) { return /^\d{1,3}[.):]/.test(l); })) return [];
    if (lines.length < 2) return [];
    // Require each line to be at least 2 chars to avoid matching single-letter
    // noise (e.g. 'a\nb\nc') that is not a credible un-numbered answer block.
    if (lines.some(function (l) { return l.length < 2; })) return [];
    return lines.map(function (l, i) {
      return annotate({ questionNumber: i + 1, rawAnswer: stripWholeEmphasis(l) });
    });
  }

  const WRAPPER_PATTERNS = [
    /^\s*final\s+answers?\s*[:.]?\s*$/i,
    /^\s*(?:my|your|the|all)?\s*answers?\s*[:.]\s*$/i,
    /^\s*based\s+on\s+(?:the\s+)?(?:uploaded\s+)?question(?:\s+set)?\.?\s*$/i,
    /^\s*here\s+(?:are|is)\s+(?:the\s+|my\s+|your\s+|all\s+)?answers?\s*[:.]?\s*$/i,
  ];

  function isWrapperLine(line) {
    for (let i = 0; i < WRAPPER_PATTERNS.length; i++) {
      if (WRAPPER_PATTERNS[i].test(line)) return true;
    }
    return false;
  }

  function normalizeRaw(s) {
    return s.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  function parseOrderedLines(raw, expectedCount) {
    if (typeof raw !== 'string') return [];
    if (typeof expectedCount !== 'number' || !Number.isFinite(expectedCount) || expectedCount < 1) {
      return [];
    }
    const text = normalizeRaw(raw);
    const lines = text.split('\n')
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l.length > 0 && !isWrapperLine(l); });
    if (lines.length !== expectedCount) return [];
    return lines.map(function (l, i) {
      return annotate({ questionNumber: i + 1, rawAnswer: stripWholeEmphasis(l) });
    });
  }

  function parseAnswerSegments(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s) return null;

    // Letter segments. Matches "(A) value", "A. value", "A) value", "A: value".
    // The next-letter pattern + end-of-string serves as the value terminator so we
    // don't have to track commas/ands.
    const LETTER_RE = /(?:\(([A-H])\)|\b([A-H])[.:)])\s*([\s\S]*?)(?=(?:\s*,\s*|\s+and\s+)(?:\(([A-H])\)|\b([A-H])[.:)])|$)/g;
    const letterItems = [];
    let m;
    while ((m = LETTER_RE.exec(s)) !== null) {
      const label = m[1] || m[2];
      const value = (m[3] || '').trim();
      if (!value) continue;
      letterItems.push({ label: label, value: value });
    }
    if (letterItems.length >= 2) {
      const distinct = new Set(letterItems.map(function (it) { return it.label; }));
      if (distinct.size >= 2) {
        return { kind: 'letters', items: letterItems };
      }
    }

    // Sequence separators (NOT comma — too noisy in prose).
    const SEQ_RE = /\s+(?:–|—|≥|≤|→|←|->|=>)\s+/g;
    if (SEQ_RE.test(s)) {
      const parts = s.split(SEQ_RE).map(function (p) { return p.trim(); }).filter(Boolean);
      if (parts.length >= 2) {
        return { kind: 'sequence', items: parts.map(function (p) { return { label: null, value: p }; }) };
      }
    }

    return null;
  }

  function parseNumberedAnswers(raw) {
    if (typeof raw !== 'string') return [];
    let text = normalizeRaw(raw).trim();
    if (!text) return [];
    const layers = [layerDirect, layerFenced, layerBraced, layerBracketed,
                    layerNumberedList, layerQuestionN, layerLineFallback];
    for (let i = 0; i < layers.length; i++) {
      const out = dedupByQuestion(layers[i](text));
      // JSON/fence layers (0–3) must yield ≥ 2 answers to avoid single-value
      // false positives (bare numbers or short JSON snippets in prose).
      // Text layers (4+: numbered list, Question N, line fallback) may return 1.
      if (out.length >= 2) return out;
      if (out.length === 1 && i >= 4) return out;
    }
    return [];
  }

  const api = {
    parseAnswerSegments: parseAnswerSegments,
    parseNumberedAnswers: parseNumberedAnswers,
    parseOrderedLines: parseOrderedLines,
    MAX_QUESTION_NUMBER: MAX_QUESTION_NUMBER,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.numberedParser = api;
  }
})(typeof self !== 'undefined' ? self : this);
