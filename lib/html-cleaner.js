// Dual-mode module: usable from a browser content script (attaches to window)
// and from Node tests (exports via module.exports). Mirrors lib/cleaner.js.
//
// Public surface:
//   cleanSelectionHtml(htmlString) -> { cleanHtml, cleanText }

(function (root) {
  'use strict';

  // --- Environment-aware document factory -----------------------------------

  function getDoc(html) {
    if (typeof DOMParser !== 'undefined') {
      // Browser / content-script context.
      return new DOMParser().parseFromString(
        '<!doctype html><html><body>' + html + '</body></html>',
        'text/html'
      );
    }
    // Node test context. JSDOM is loaded lazily so the browser bundle never
    // tries to require it.
    const { JSDOM } = require('jsdom');
    return new JSDOM('<!doctype html><html><body>' + html + '</body></html>').window.document;
  }

  // --- Cleaner -------------------------------------------------------------

  function cleanSelectionHtml(rawHtml) {
    if (rawHtml == null) return { cleanHtml: '', cleanText: '' };
    if (typeof rawHtml !== 'string') return { cleanHtml: '', cleanText: '' };

    const doc = getDoc(rawHtml);
    const body = doc.body;

    // Passes are added in subsequent tasks. For now, identity transform.

    const cleanHtml = body.innerHTML.trim();
    const cleanText = body.textContent.replace(/\s+$/g, '');

    return { cleanHtml: cleanHtml, cleanText: cleanText };
  }

  const api = { cleanSelectionHtml: cleanSelectionHtml };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.cleanSelectionHtml = cleanSelectionHtml;
  }
})(typeof self !== 'undefined' ? self : this);
