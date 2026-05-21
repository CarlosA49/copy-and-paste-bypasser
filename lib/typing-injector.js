// Safe character injection into focused editable fields.
(function (root) {
  'use strict';

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (!el.ownerDocument || !el.ownerDocument.contains(el)) return false;
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA') {
      return !el.disabled && !el.readOnly;
    }
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      const TEXT_TYPES = ['text', 'search', 'url', 'email', 'tel', 'password', 'number'];
      if (TEXT_TYPES.indexOf(t) === -1) return false;
      return !el.disabled && !el.readOnly;
    }
    // contenteditable: 'true', '', or 'plaintext-only' all count
    const ce = el.getAttribute && el.getAttribute('contenteditable');
    if (ce === 'true' || ce === '' || ce === 'plaintext-only') return true;
    return false;
  }

  function dispatchInput(el) {
    try {
      el.dispatchEvent(new (el.ownerDocument.defaultView.InputEvent || el.ownerDocument.defaultView.Event)('input', { bubbles: true }));
    } catch (_) {
      try { el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true })); } catch (__) { /* ignore */ }
    }
  }

  function insertOrBackspace(el, op) {
    if (!isEditable(el)) return false;
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT') {
      const cur = el.value;
      if (op.kind === 'char') {
        el.value = cur + op.char;
      } else if (op.kind === 'backspace') {
        el.value = cur.slice(0, -1);
      } else {
        return false;
      }
      dispatchInput(el);
      return true;
    }
    // contenteditable
    if (op.kind === 'char') {
      el.appendChild(el.ownerDocument.createTextNode(op.char));
    } else if (op.kind === 'backspace') {
      const last = el.lastChild;
      if (!last) return true;
      if (last.nodeType === 3) {
        if (last.textContent.length <= 1) last.remove();
        else last.textContent = last.textContent.slice(0, -1);
      } else {
        last.remove();
      }
    } else {
      return false;
    }
    dispatchInput(el);
    return true;
  }

  const api = { insertOrBackspace: insertOrBackspace, isEditable: isEditable };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.typingInjector = api;
  }
})(typeof self !== 'undefined' ? self : this);
