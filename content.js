// Runs after lib/cleaner.js and lib/html-cleaner.js, which expose
// window.ClipboardCleaner.{cleanCopiedText, cleanSelectionHtml, JUNK_LINE_PATTERNS}.
(function () {
  'use strict';

  function serializeRange(range) {
    const fragment = range.cloneContents();
    const tmp = document.createElement('div');
    tmp.appendChild(fragment);
    return tmp.innerHTML;
  }

  function onCopy(event) {
    const api = window.ClipboardCleaner;
    if (!api || typeof api.cleanCopiedText !== 'function') return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const selectedText = sel.toString();
    if (!selectedText) return;

    if (!event.clipboardData) return;

    // Rich path: derive both text/html and text/plain from the cleaned HTML.
    if (typeof api.cleanSelectionHtml === 'function') {
      try {
        const rawHtml = serializeRange(sel.getRangeAt(0));
        const { cleanHtml, cleanText } = api.cleanSelectionHtml(rawHtml);
        // If the cleaner returned empty (all junk), fall through to plain
        // path so the user still copies *something*.
        if (cleanText && cleanText.length > 0) {
          event.clipboardData.setData('text/html', cleanHtml);
          event.clipboardData.setData('text/plain', cleanText);
          event.preventDefault();
          return;
        }
      } catch (e) {
        // Fall through to plain path on any error.
      }
    }

    // Plain-only fallback path.
    const cleaned = api.cleanCopiedText(selectedText);
    event.clipboardData.setData('text/plain', cleaned);
    event.preventDefault();
  }

  document.addEventListener('copy', onCopy, true);
})();
