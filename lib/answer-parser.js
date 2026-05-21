// lib/answer-parser.js
// Pure parser. No DOM. Turns raw text into structured answer candidates.
(function (root) {
  'use strict';

  // Match an answer letter when it's standalone — either wrapped in (), followed by a closing
  // marker like ) . : , space EOL, or both. Captures A–H (Coursera questions rarely exceed 8 options).
  // Examples that match: "A.", "(b)", "C)", "answer is D ", "D,"
  // Examples that do NOT match: "a" inside "answer", "act"
  const LETTER_PATTERN = /(?:\(([A-Ha-h])\)|(?:^|[\s,.;:])([A-Ha-h])(?=[\s.,:;)\]]|$))/g;
  // Matches: "option 2", "choice 3", "answer 4", "#5", "1)", "1."
  const NUMBER_PATTERN = /(?:\b(?:option|choice|answer)\s+(\d{1,2})\b|#(\d{1,2})\b|(?:^|\s)(\d{1,2})(?=[)\.]))/gi;
  // Matches "...", '...', or “...” (curly). Captures inner text.
  const QUOTE_PATTERN = /"([^"]*)"|'([^']*)'|“([^”]*)”/g;

  function parseAnswerText(raw) {
    const rawText = typeof raw === 'string' ? raw : '';
    const letters = [];
    const numbers = [];
    const quotedSnippets = [];
    if (rawText.trim().length === 0) {
      return { letters: letters, numbers: numbers, quotedSnippets: quotedSnippets, rawText: rawText };
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
    QUOTE_PATTERN.lastIndex = 0;
    while ((m = QUOTE_PATTERN.exec(rawText)) !== null) {
      const s = (m[1] || m[2] || m[3] || '').trim();
      if (s.length > 0) quotedSnippets.push(s);
    }
    return { letters: letters, numbers: numbers, quotedSnippets: quotedSnippets, rawText: rawText };
  }

  const api = { parseAnswerText: parseAnswerText };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.answerParser = api;
  }
})(typeof self !== 'undefined' ? self : this);
