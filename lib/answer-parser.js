// lib/answer-parser.js
// Pure parser. No DOM. Turns raw text into structured answer candidates.
(function (root) {
  'use strict';

  // Match an answer letter when it's standalone — either wrapped in (), followed by a closing
  // marker like ) . : , space EOL, or both. Captures A–H (Coursera questions rarely exceed 8 options).
  // Examples that match: "A.", "(b)", "C)", "answer is D ", "D,"
  // Examples that do NOT match: "a" inside "answer", "act"
  const LETTER_PATTERN = /(?:\(([A-Ha-h])\)|(?:^|[\s,.;:])([A-Ha-h])(?=[\s.,:;)\]]|$))/g;
  // Matches: "option 2" / "choice 3" / "answer 4", "#5", "1)", "1." (but not "1.5" — a decimal)
  const NUMBER_PATTERN = /(?:\b(?:option|choice|answer)\s+(\d{1,2})\b|#(\d{1,2})\b|(?:^|\s)(\d{1,2})(?=\)|\.(?!\d)))/gi;
  // Matches “...”, '...', or “...” (curly). Captures inner text.
  const QUOTE_PATTERN = /"([^"]*)"|'([^']*)'|“([^”]*)”/g;

  // Computed-value extraction. Two strategies:
  //   1. “answer (is|:|=) NUMBER [UNIT]”  /  “final answer ...”
  //   2. “= NUMBER [UNIT]”  (typically the last assignment in a worked solution)
  // UNIT is a short ASCII/greek token following the number with optional space.
  const VALUE_NUM = '(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)';
  const VALUE_UNIT = '([A-Za-zμΩ°/]+(?:\\^?\\d+)?)';
  const ANSWER_PATTERN = new RegExp(
    '(?:final\\s+answer|answer)\\s*[:=]?\\s*(?:is\\s+)?' + VALUE_NUM + '(?:\\s*' + VALUE_UNIT + ')?',
    'gi'
  );
  const EQUALS_PATTERN = new RegExp('=\\s*' + VALUE_NUM + '(?:\\s*' + VALUE_UNIT + ')?', 'g');

  function extractComputedValues(rawText) {
    const out = [];
    if (typeof rawText !== 'string' || !rawText.trim()) return out;
    const seen = new Set();
    function pushMatch(value, unit) {
      const u = unit || '';
      const raw = u ? (value + ' ' + u) : value;
      const key = value + '|' + u.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ value: value, unit: u, raw: raw });
    }
    [ANSWER_PATTERN, EQUALS_PATTERN].forEach(function (re) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(rawText)) !== null) {
        const value = m[1];
        const unit = m[2] || '';
        if (value === undefined || value === null || value === '') continue;
        pushMatch(value, unit);
      }
    });
    return out;
  }

  function parseAnswerText(raw) {
    const rawText = typeof raw === 'string' ? raw : '';
    const letters = [];
    const numbers = [];
    const quotedSnippets = [];
    if (rawText.trim().length === 0) {
      return { letters: letters, numbers: numbers, quotedSnippets: quotedSnippets, computedValues: [], rawText: rawText };
    }
    const seenLetters = new Set();
    LETTER_PATTERN.lastIndex = 0;
    let m;
    while ((m = LETTER_PATTERN.exec(rawText)) !== null) {
      const ch = (m[1] || m[2] || '').toUpperCase();
      if (ch && !seenLetters.has(ch)) { seenLetters.add(ch); letters.push(ch); }
    }
    const seenNums = new Set();
    NUMBER_PATTERN.lastIndex = 0;
    while ((m = NUMBER_PATTERN.exec(rawText)) !== null) {
      const nStr = m[1] || m[2] || m[3];
      if (!nStr) continue;
      const n = parseInt(nStr, 10);
      if (!Number.isFinite(n) || n < 1 || n > 20) continue;
      if (!seenNums.has(n)) { seenNums.add(n); numbers.push(n); }
    }
    const seenSnippets = new Set();
    QUOTE_PATTERN.lastIndex = 0;
    while ((m = QUOTE_PATTERN.exec(rawText)) !== null) {
      const s = (m[1] || m[2] || m[3] || '').trim();
      if (s.length === 0) continue;
      const key = s.toLowerCase();
      if (seenSnippets.has(key)) continue;
      seenSnippets.add(key);
      quotedSnippets.push(s);
    }
    const computedValues = extractComputedValues(rawText);
    return { letters: letters, numbers: numbers, quotedSnippets: quotedSnippets, computedValues: computedValues, rawText: rawText };
  }

  const api = { parseAnswerText: parseAnswerText };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.answerParser = api;
  }
})(typeof self !== 'undefined' ? self : this);
