// Runs after lib/cleaner.js, which exposes window.ClipboardCleaner.
(function () {
  'use strict';

  function getSelectedText() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return '';
    const text = sel.toString();
    return typeof text === 'string' ? text : '';
  }

  function onCopy(event) {
    const cleaner = window.ClipboardCleaner;
    if (!cleaner || typeof cleaner.cleanCopiedText !== 'function') {
      // Cleaner module did not load — fall back to default browser behavior.
      return;
    }

    const selected = getSelectedText();
    if (!selected) {
      // Nothing selected (e.g. programmatic copy by the page). Don't interfere.
      return;
    }

    const cleaned = cleaner.cleanCopiedText(selected);

    if (!event.clipboardData) {
      // Very old browser, or copy was synthesized without clipboardData.
      return;
    }

    // Replace the clipboard payload with our cleaned text and stop the
    // browser (and any later page handler) from overwriting it.
    event.clipboardData.setData('text/plain', cleaned);
    event.preventDefault();
    // Note: we deliberately do NOT touch window.getSelection(), so the
    // highlighted range stays visible — the user still sees what they copied.
  }

  // Capture phase = true: we run before page-registered bubble handlers,
  // and our preventDefault() blocks the default action they rely on.
  document.addEventListener('copy', onCopy, true);
})();
