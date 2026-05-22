// Runs after lib/cleaner.js, lib/html-cleaner.js, and lib/sidebar.js, which
// expose window.ClipboardCleaner.{cleanCopiedText, cleanSelectionHtml, sidebar, ...}.
(function () {
  'use strict';

  function api() { return (typeof window !== 'undefined' && window.ClipboardCleaner) || null; }

  function serializeRange(range) {
    const fragment = range.cloneContents();
    const tmp = document.createElement('div');
    tmp.appendChild(fragment);
    return tmp.innerHTML;
  }

  function onCopy(event) {
    const a = api();
    if (!a || typeof a.cleanCopiedText !== 'function') return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const selectedText = sel.toString();
    if (!selectedText) return;
    if (!event.clipboardData) return;

    let plainTextForSidebar = '';

    if (typeof a.cleanSelectionHtml === 'function') {
      try {
        const rawHtml = serializeRange(sel.getRangeAt(0));
        const { cleanHtml, cleanText } = a.cleanSelectionHtml(rawHtml);
        if (cleanText && cleanText.length > 0) {
          event.clipboardData.setData('text/html', cleanHtml);
          event.clipboardData.setData('text/plain', cleanText);
          event.preventDefault();
          plainTextForSidebar = cleanText;
        }
      } catch (e) {
        // fall through to plain-only
      }
    }

    if (!plainTextForSidebar) {
      const cleaned = a.cleanCopiedText(selectedText);
      event.clipboardData.setData('text/plain', cleaned);
      event.preventDefault();
      plainTextForSidebar = cleaned;
    }

    if (a.sidebar && typeof a.sidebar.showCopied === 'function') {
      try { a.sidebar.showCopied(plainTextForSidebar); } catch (_) { /* never block copy on UI error */ }
    }
  }

  function mountSidebarWhenReady() {
    const a = api();
    if (!a || !a.sidebar || typeof a.sidebar.mount !== 'function') return;
    try { a.sidebar.mount(); } catch (_) { /* don't crash the page on UI error */ }
  }

  function startLectureCompanion() {
    const a = api();
    if (!a || !a.lectureCompanion || typeof a.lectureCompanion.createCompanion !== 'function') return;
    if (!a.sidebar || typeof a.sidebar.setLectureDraft !== 'function') return;
    const companion = a.lectureCompanion.createCompanion({
      document: document,
      onDraft: function (text) {
        try { a.sidebar.setLectureDraft(text); } catch (_) { /* ignore UI error */ }
      },
    });
    companion.init();
  }

  document.addEventListener('copy', onCopy, true);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountSidebarWhenReady, { once: true });
    document.addEventListener('DOMContentLoaded', startLectureCompanion, { once: true });
  } else {
    mountSidebarWhenReady();
    startLectureCompanion();
  }
})();
