// lib/answer-parser.js
// Pure parser. No DOM. Turns raw text into structured answer candidates.
(function (root) {
  'use strict';

  // Match an answer letter when it's standalone — either wrapped in (), followed by a closing
  // marker like ) . : , space EOL, or both. Captures A–H (Coursera questions rarely exceed 8 options).
  // Examples that match: "A.", "(b)", "C)", "answer is D ", "D,"
  // Examples that do NOT match: "a" inside "answer", "act"
  const LETTER_PATTERN = /(?:\(([A-Ha-h])\)|(?:^|[\s,.;:])([A-Ha-h])(?=[\s.,:;)\]]|$))/g;

  function parseAnswerText(raw) {
    const rawText = typeof raw === 'string' ? raw : '';
    const letters = [];
    const seen = new Set();
    if (rawText.trim().length === 0) {
      return { letters: [], numbers: [], quotedSnippets: [], rawText: rawText };
    }
    let m;
    LETTER_PATTERN.lastIndex = 0;
    while ((m = LETTER_PATTERN.exec(rawText)) !== null) {
      const ch = (m[1] || m[2] || '').toUpperCase();
      if (!ch) continue;
      if (!seen.has(ch)) { seen.add(ch); letters.push(ch); }
    }
    return { letters: letters, numbers: [], quotedSnippets: [], rawText: rawText };
  }

  const api = { parseAnswerText: parseAnswerText };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.answerParser = api;
  }
})(typeof self !== 'undefined' ? self : this);
