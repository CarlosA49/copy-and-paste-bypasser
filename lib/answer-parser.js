// lib/answer-parser.js
// Pure parser. No DOM. Turns raw text into structured answer candidates.
(function (root) {
  'use strict';

  const valueNormalize = (function () {
    if (typeof module !== 'undefined' && module.exports) {
      return require('./value-normalize.js');
    }
    return (root.ClipboardCleaner && root.ClipboardCleaner.valueNormalize) || null;
  })();

  // Match an answer letter when it's standalone — either wrapped in (), followed by a closing
  // marker like ) . : , space EOL, or both. Captures A–H (Coursera questions rarely exceed 8 options).
  // Examples that match: "A.", "(b)", "C)", "answer is D ", "D,"
  // Examples that do NOT match: "a" inside "answer", "act"
  const LETTER_PATTERN = /(?:\(([A-Ha-h])\)|(?:^|[\s,.;:])([A-Ha-h])(?=[\s.,:;)\]]|$))/g;
  // Matches: "option 2" / "choice 3" / "answer 4", "#5", "1)", "1." (but not "1.5" — a decimal)
  const NUMBER_PATTERN = /(?:\b(?:option|choice|answer)\s+(\d{1,2})\b|#(\d{1,2})\b|(?:^|\s)(\d{1,2})(?=\)|\.(?!\d)))/gi;
  // Matches "...", '...', or "..." (curly). Captures inner text.
  const QUOTE_PATTERN = /"([^"]*)"|'([^']*)'|"([^"]*)"/g;

  // Numeric value regex, post-normalisation. Matches "500", "0.0352", "1.0e-6",
  // "1.0e+3", "-3.14". Does NOT match bare "10^N" — the normaliser converts
  // those to "1eN" first.
  const VALUE_RE = '(-?\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)';

  // Unit regex: short letter run with optional Unicode μ/Ω/° and optional /denominator,
  // and an optional ²/³ etc. attached. Keeps "Vs/A", "cm²", "kΩ". Bounded length to
  // avoid swallowing whole sentences.
  const UNIT_RE = '([A-Za-zμΩ°][A-Za-zμΩ°/]{0,6}[²³]?)';

  // Physics units that are ALSO valid multiple-choice letters (A, B, C, ...).
  // Used by suppressUnitLetters in Task B4.
  const UNIT_LETTERS = new Set(['H','F','C','A','V','W','N','J','T','K']); // eslint-disable-line no-unused-vars

  // Words that look like a unit to the regex but are actually prose connectors.
  const STOP_UNITS = new Set([
    'and','or','but','so','is','to','for','of','the','an',
    'then','thus','therefore','hence','where','when','if','as','by','in','on','with',
    'plus','minus','times','divided','over','from','at','that','this','these','those',
  ]);

  // Patterns that signal a "labeled answer" (high confidence). Each pattern
  // emits {label, value, unit}. Patterns are scanned globally in document order.
  const LABEL_PATTERNS = [
    // "Q1: ...", "Q 1: ...", "Q1 ..."
    new RegExp('\\bQ\\s*(\\d{1,2})\\s*[:.=]?\\s*' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?', 'gi'),
    // "Question 1: ...", "Question 1 ..."
    new RegExp('\\bquestion\\s+(\\d{1,2})\\s*[:.=]?\\s*(?:is\\s+)?' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?', 'gi'),
    // "Answer 2 = ...", "Answer 2: ..."
    new RegExp('\\banswer\\s+(\\d{1,2})\\s*[:=]\\s*' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?', 'gi'),
    // "For #3, ... result is X" / "#3 ... = X" — capture the # number.
    new RegExp('#(\\d{1,2})\\b[^.]*?(?:result\\s+is|=)\\s*' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?', 'gi'),
    // "the answer (is|:|=) X" or "final answer X" — no question label.
    // The (?!\s*\d) negative-lookahead prevents matching "answer 2 = ..." here;
    // that form is already captured by the labelled pattern above.
    // Place last so labelled forms above win when both could match.
    new RegExp('(?:final\\s+answer|\\banswer(?!\\s*\\d))\\s*[:=]?\\s*(?:is\\s+)?' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?', 'gi'),
  ];


  function cleanUnit(u) {
    const t = (u || '').trim();
    if (!t) return '';
    if (STOP_UNITS.has(t.toLowerCase())) return '';
    return t;
  }

  function makeAnswer(value, unit, confidence, label) {
    const u = cleanUnit(unit);
    const raw = u ? (value + ' ' + u) : value;
    return { value: value, unit: u, raw: raw, confidence: confidence, label: label || null };
  }

  // Numbered or bulleted list lines. "1. VALUE UNIT" gets label = "1";
  // "- VALUE UNIT" gets label = null. Confidence: medium.
  // Anchored at line start (post-normalisation, ^ in multiline mode).
  const NUMBERED_LINE_RE = new RegExp(
    '^\\s*(\\d{1,2})[.)\\s]\\s*' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?',
    'gm'
  );
  const BULLET_LINE_RE = new RegExp(
    '^\\s*[-•*]\\s+' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?',
    'gm'
  );

  function extractListAnswers(normalisedText) {
    const out = [];
    NUMBERED_LINE_RE.lastIndex = 0;
    let m;
    while ((m = NUMBERED_LINE_RE.exec(normalisedText)) !== null) {
      const label = m[1];
      const value = m[2];
      const unit = m[3] || '';
      if (!value) continue;
      out.push(makeAnswer(value, unit, 'medium', label));
    }
    BULLET_LINE_RE.lastIndex = 0;
    while ((m = BULLET_LINE_RE.exec(normalisedText)) !== null) {
      const value = m[1];
      const unit = m[2] || '';
      if (!value) continue;
      out.push(makeAnswer(value, unit, 'medium', null));
    }
    return out;
  }

  // Inline "= X UNIT" assignments, last match per paragraph. Confidence: low.
  // A paragraph is separated by a blank line.
  const INLINE_EQUALS_RE = new RegExp('=\\s*' + VALUE_RE + '(?:\\s*' + UNIT_RE + ')?', 'g');

  function extractInlineAnswers(normalisedText) {
    const out = [];
    const paragraphs = normalisedText.split(/\n[ \t]*\n+/);
    paragraphs.forEach(function (para) {
      INLINE_EQUALS_RE.lastIndex = 0;
      let last = null;
      let m;
      while ((m = INLINE_EQUALS_RE.exec(para)) !== null) {
        if (m[1]) last = m;
      }
      if (last) {
        out.push(makeAnswer(last[1], last[2] || '', 'low', null));
      }
    });
    return out;
  }

  function extractLabeledAnswers(normalisedText) {
    const out = [];
    LABEL_PATTERNS.forEach(function (re) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(normalisedText)) !== null) {
        // For the question-labeled patterns, m[1] is the question number, m[2] is value, m[3] is unit.
        // For the "answer is X" pattern (no label), m[1] is value, m[2] is unit.
        let label = null, value, unit;
        if (m.length === 4) {
          label = m[1];
          value = m[2];
          unit = m[3] || '';
        } else {
          value = m[1];
          unit = m[2] || '';
        }
        if (!value) continue;
        out.push(makeAnswer(value, unit, 'high', label));
      }
    });
    return out;
  }

  function dedupAnswers(list) {
    const byKey = new Map();
    const order = ['high', 'medium', 'low'];
    list.forEach(function (a) {
      const key = a.value + '|' + (a.unit || '').toLowerCase();
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, a);
        return;
      }
      // If both have confidence, prefer higher confidence.
      if (a.confidence && prev.confidence) {
        if (order.indexOf(a.confidence) < order.indexOf(prev.confidence)) {
          byKey.set(key, a);
        }
      }
      // If current entry has confidence but previous does not, prefer current.
      if (a.confidence && !prev.confidence) {
        byKey.set(key, a);
      }
    });
    return Array.from(byKey.values());
  }

  // When a confident numeric answer with units is present, drop any single-letter
  // MC candidates that are actually physics-unit codes (H, F, C, A, V, W, N, J, T, K).
  function suppressUnitLetters(letters, computedValues) {
    const hasConfidentNumeric = computedValues.some(function (cv) {
      return cv.confidence === 'high' || cv.confidence === 'medium';
    });
    if (!hasConfidentNumeric) return letters;
    return letters.filter(function (l) { return !UNIT_LETTERS.has(l); });
  }

  // Top-level extractor used by parseAnswerText.
  function extractAnswers(rawText) {
    if (typeof rawText !== 'string' || !rawText.trim()) return [];
    const normalised = valueNormalize ? valueNormalize.normalizeAnswerText(rawText) : rawText;
    const labeled = extractLabeledAnswers(normalised);
    const listed = extractListAnswers(normalised);
    const inline = extractInlineAnswers(normalised);
    return dedupAnswers(labeled.concat(listed).concat(inline));
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
    const computedValues = extractAnswers(rawText);
    const filteredLetters = suppressUnitLetters(letters, computedValues);
    return { letters: filteredLetters, numbers: numbers, quotedSnippets: quotedSnippets, computedValues: computedValues, rawText: rawText };
  }

  const api = { parseAnswerText: parseAnswerText };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.answerParser = api;
  }
})(typeof self !== 'undefined' ? self : this);
