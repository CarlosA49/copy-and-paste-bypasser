// lib/value-normalize.js
// Pure text preprocessor for AI-output normalisation. Turns the many
// flavours of scientific notation (×10^N, x10^N, 10⁻⁶, 1.0E-6, split across
// lines, Unicode minus) into a canonical "1.0e-6" form so downstream extractors
// can use a single simple regex. No DOM. Dual-export (browser + CJS).
(function (root) {
  'use strict';

  // Map Unicode superscript characters to their ASCII equivalents.
  const SUPER_MAP = {
    '⁰':'0','¹':'1','²':'2','³':'3','⁴':'4','⁵':'5','⁶':'6','⁷':'7','⁸':'8','⁹':'9',
    '⁻':'-','⁺':'+',
  };

  // Normalise Unicode minus (U+2212) to ASCII hyphen-minus.
  function normalizeMinus(s) {
    return s.replace(/−/g, '-');
  }

  // When Unicode superscript digits/sign appear immediately after the digits "10",
  // unpack them as "^N" so later passes can canonicalise to "e" form. Other
  // superscript clusters (like m²) are left alone — they're units, not exponents.
  function normalizeSuperscripts(s) {
    return s.replace(/10([⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+)/g, function (_m, sup) {
      let ascii = '';
      for (let i = 0; i < sup.length; i++) {
        ascii += SUPER_MAP[sup[i]] || sup[i];
      }
      return '10^' + ascii;
    });
  }

  // Canonicalise scientific notation to "e" form.
  //   "N × 10^M" / "N x 10^M" / "N * 10^M"  →  "NeM"
  //   bare "10^M" (preceded by non-alphanumeric) →  "1eM"
  //   "NE-M" / "Ne-M" → "Ne-M" (lowercase the E, no semantic change)
  function normalizeSciNotation(s) {
    // First: coefficient × 10^exponent form. Whitespace around × is allowed.
    // Coefficient must include at least one digit; exponent is signed.
    s = s.replace(
      /(-?\d+(?:\.\d+)?)\s*[×x*]\s*10\s*\^?\s*([+-]?\d+)/g,
      '$1e$2'
    );
    // Second: bare "10^M" where the leading 10 is not part of a larger number.
    // The boundary check (?:^|[^A-Za-z0-9.]) ensures we don't catch "2110^6".
    s = s.replace(
      /(^|[^A-Za-z0-9.])10\s*\^\s*([+-]?\d+)/g,
      function (_m, prefix, exp) { return prefix + '1e' + exp; }
    );
    // Third: lowercase E in canonical "Ne-M" form.
    s = s.replace(/(\d)E([+-]?\d)/g, '$1e$2');
    return s;
  }

  function normalizeAnswerText(text) {
    if (typeof text !== 'string') return '';
    if (!text) return '';
    let s = text;
    s = normalizeMinus(s);
    s = normalizeSuperscripts(s);
    s = normalizeSciNotation(s);
    return s;
  }

  const api = { normalizeAnswerText: normalizeAnswerText };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.valueNormalize = api;
  }
})(typeof self !== 'undefined' ? self : this);
