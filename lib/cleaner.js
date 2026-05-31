// Dual-mode module: usable from a browser content script (attaches to window)
// and from Node tests (exports via module.exports).

(function (root) {
  // Patterns that mark a paragraph as injected boilerplate. Each pattern is
  // tested against every line in the paragraph. If ANY line matches ANY
  // pattern, the whole paragraph is dropped — Coursera's prompt injection is
  // a multi-sentence block where only some sentences carry a keyword, so
  // line-level filtering leaks the unflagged sentences.
  const JUNK_LINE_PATTERNS = [
    // Generic copyright / boilerplate markers
    /\bcoursera\b/i,
    /\bcopyright\b/i,
    /\bassessment\b/i,
    /\bdon['’]t\s+share\b/i,
    /\(c\)\s*\d{4}/i,
    /©\s*\d{4}/,

    // Coursera AI-prompt-injection markers (added 2026-05-21 after observing
    // a multi-sentence injection paragraph leaking past the keyword filter)
    /\bAI\s+assistants?\b/i,
    /\bAI\s+agents?\b/i,
    /\bacademic\s+integrity\b/i,
    /\backnowledge[-\s]guidelines\b/i,
    /\bdata-action\b/i,
    /\bcompliance\s+verification\b/i,
    /\bdo\s+you\s+understand\b\s*[?.!]*/i,
    /^\s*i\s+understand\s*[.!?]*\s*$/i,
  ];

  function isJunkLine(line) {
    return JUNK_LINE_PATTERNS.some(function (re) { return re.test(line); });
  }

  function isJunkParagraph(paragraph) {
    return paragraph.split('\n').some(isJunkLine);
  }

  function cleanCopiedText(input) {
    if (input == null) return '';
    if (typeof input !== 'string') return '';

    // Normalize CRLF/CR to LF.
    const normalized = input.replace(/\r\n?/g, '\n');

    // Split into paragraphs on one-or-more blank lines (blank = newline,
    // optional whitespace, newline). Two consecutive paragraph breaks collapse
    // to one — that matches typical user expectations and avoids the cleaned
    // output having huge whitespace gaps where junk paragraphs were removed.
    const paragraphs = normalized.split(/\n(?:[ \t]*\n)+/);

    const kept = paragraphs.filter(function (p) { return !isJunkParagraph(p); });

    const result = kept.join('\n\n').replace(/\s+$/, '');
    // Stash the most recent cleaned result so the autopilot's quiz-fallback
    // handler can source it instead of silently reading the system clipboard.
    api.lastCleanedCopy = result;
    return result;
  }

  const api = {
    cleanCopiedText: cleanCopiedText,
    JUNK_LINE_PATTERNS: JUNK_LINE_PATTERNS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = api;
  }
})(typeof self !== 'undefined' ? self : this);
