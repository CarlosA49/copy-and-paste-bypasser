// lib/page-fallback.js
// Universal page-level helpers — find Mark-complete / Go-to-next-item / top progress /
// agreement checkbox by visible text and stable aria patterns, not by class hashes.
(function (root) {
  'use strict';

  function normText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  const MARK_COMPLETE_RE = /^(mark\s+as\s+completed?|mark\s+complete|complete|completed)$/i;
  const NEXT_ITEM_RE = /^(go\s+to\s+next\s+item|next\s+item|continue)$/i;
  const PROGRESS_RE = /(\d+)\s*\/\s*(\d+)\s+learning\s+items?/i;

  function findMarkCompleteButton(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;
    const candidates = root.querySelectorAll('button, [role="button"]');
    for (let i = 0; i < candidates.length; i++) {
      if (MARK_COMPLETE_RE.test(normText(candidates[i].textContent))) return candidates[i];
    }
    const labels = root.querySelectorAll('.cds-button-label, [class*="button-label" i]');
    for (let i = 0; i < labels.length; i++) {
      if (MARK_COMPLETE_RE.test(normText(labels[i].textContent))) {
        const btn = labels[i].closest && labels[i].closest('button, [role="button"]');
        if (btn) return btn;
      }
    }
    return null;
  }

  function findGoToNextItemButton(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;
    const els = root.querySelectorAll('button, a, [role="button"]');
    for (let i = 0; i < els.length; i++) {
      if (NEXT_ITEM_RE.test(normText(els[i].textContent))) return els[i];
    }
    return null;
  }

  function findTopProgressText(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return null;
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const own = normText(el.textContent);
      if (own.length === 0 || own.length > 80) continue;
      if (PROGRESS_RE.test(own)) {
        const hasChildMatch = Array.prototype.some.call(el.children || [], function (c) {
          return PROGRESS_RE.test(normText(c.textContent));
        });
        if (!hasChildMatch) return el;
      }
    }
    return null;
  }

  function parseProgress(text) {
    if (!text) return null;
    const m = String(text).match(PROGRESS_RE);
    if (!m) return null;
    return {
      completed: parseInt(m[1], 10),
      total: parseInt(m[2], 10),
      raw: m[0],
    };
  }

  function findAgreementCheckbox(root) {
    if (!root || typeof root.querySelector !== 'function') return null;
    const byId = root.querySelector('#agreement-checkbox-base');
    if (byId) return byId;
    const cbs = root.querySelectorAll('input[type="checkbox"]');
    for (let i = 0; i < cbs.length; i++) {
      const cb = cbs[i];
      let label = cb.closest && cb.closest('label');
      if (!label && cb.id) label = root.querySelector('label[for="' + cb.id + '"]');
      if (label && /\bagree\b/i.test(normText(label.textContent))) return cb;
    }
    return null;
  }

  const api = {
    findMarkCompleteButton: findMarkCompleteButton,
    findGoToNextItemButton: findGoToNextItemButton,
    findTopProgressText: findTopProgressText,
    parseProgress: parseProgress,
    findAgreementCheckbox: findAgreementCheckbox,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.pageFallback = api;
  }
})(typeof self !== 'undefined' ? self : this);
