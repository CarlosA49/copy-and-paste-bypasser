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

  function normalizeAnswerText(text) {
    if (typeof text !== 'string') return '';
    if (!text) return '';
    let s = text;
    s = normalizeMinus(s);
    s = normalizeSuperscripts(s);
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
