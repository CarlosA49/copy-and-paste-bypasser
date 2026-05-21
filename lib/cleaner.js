// Dual-mode module: usable from a browser content script (attaches to window)
// and from Node tests (exports via module.exports).

(function (root) {
  // Patterns that mark a line as injected boilerplate. Each is tested against
  // a single line. If any matches, the whole line is dropped.
  //
  // Word boundaries (\b) are used so "right" does not trigger the
  // "copyright" rule and "passessment" (hypothetical) does not trigger
  // "assessment".
  const JUNK_LINE_PATTERNS = [
    /\bcoursera\b/i,
    /\bcopyright\b/i,
    /\bassessment\b/i,
    /\bdon['‘’]t\s+share\b/i,
    /\(c\)\s*\d{4}/i,   // "(c) 2025"
    /©\s*\d{4}/,    // "© 2025"
  ];

  function isJunkLine(line) {
    return JUNK_LINE_PATTERNS.some(function (re) { return re.test(line); });
  }

  function cleanCopiedText(input) {
    if (input == null) return '';
    if (typeof input !== 'string') return '';

    // Normalize CRLF to LF so line splitting is uniform.
    const normalized = input.replace(/\r\n?/g, '\n');

    const kept = normalized
      .split('\n')
      .filter(function (line) { return !isJunkLine(line); });

    // Trim trailing blank lines and trailing whitespace on the final string,
    // but keep interior blank lines that separate paragraphs.
    return kept.join('\n').replace(/\s+$/, '');
  }

  const api = { cleanCopiedText: cleanCopiedText };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = api;
  }
})(typeof self !== 'undefined' ? self : this);
