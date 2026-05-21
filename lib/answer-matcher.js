// lib/answer-matcher.js
// DOM matcher: finds quiz option groups, matches parsed candidates, applies selection.
(function (root) {
  'use strict';

  function textOf(el) {
    if (!el) return '';
    // Prefer associated label content. Fall back to the element's own text.
    const id = el.id;
    let labelText = '';
    if (id) {
      const lbl = el.ownerDocument.querySelector('label[for="' + cssEscape(id) + '"]');
      if (lbl) labelText = lbl.textContent || '';
    }
    if (!labelText) {
      const wrappingLabel = el.closest && el.closest('label');
      if (wrappingLabel) labelText = wrappingLabel.textContent || '';
    }
    if (!labelText) labelText = el.textContent || '';
    return labelText.replace(/\s+/g, ' ').trim();
  }

  function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\' + c; });
  }

  function isUsable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled) return false;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return false;
    return true;
  }

  function findNativeGroups(root) {
    const groups = new Map();
    const anonCounter = { n: 0 };
    const inputs = root.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    inputs.forEach(function (inp) {
      if (!isUsable(inp)) return;
      const kind = inp.type === 'radio' ? 'radio' : 'checkbox';
      let key;
      let name;
      if (inp.name) {
        name = inp.name;
        key = kind + '::name::' + name;
      } else {
        // Anonymous: bucket by nearest grouping ancestor so unrelated fieldsets stay separate.
        const ancestor = inp.closest && inp.closest('fieldset,[role="radiogroup"],[role="group"]');
        if (ancestor) {
          if (!ancestor.__ccpAnonId) ancestor.__ccpAnonId = '__anonGroup__:' + (++anonCounter.n);
          name = ancestor.__ccpAnonId;
          key = kind + '::ancestor::' + name;
        } else {
          // No grouping ancestor — each input is its own group.
          name = '__anonInput__:' + (++anonCounter.n);
          key = kind + '::input::' + name;
        }
      }
      if (!groups.has(key)) groups.set(key, { kind: kind, name: name, options: [] });
      groups.get(key).options.push({ el: inp, text: textOf(inp), index: groups.get(key).options.length });
    });
    return Array.from(groups.values()).filter(function (g) { return g.options.length > 0; });
  }

  function findAriaGroups(root) {
    const out = [];
    const radioGroups = root.querySelectorAll('[role="radiogroup"]');
    radioGroups.forEach(function (rg) {
      const items = rg.querySelectorAll('[role="radio"]');
      if (items.length === 0) return;
      const options = [];
      items.forEach(function (it, i) {
        if (!isUsable(it)) return;
        options.push({ el: it, text: textOf(it), index: i });
      });
      if (options.length > 0) {
        const name = rg.id || ('__aria__:' + (out.length + 1));
        out.push({ kind: 'radio', name: name, options: options });
      }
    });
    const groupContainers = root.querySelectorAll('[role="group"]');
    const seenChecks = new Set();
    groupContainers.forEach(function (gc) {
      const items = gc.querySelectorAll('[role="checkbox"]');
      if (items.length === 0) return;
      const options = [];
      items.forEach(function (it, i) {
        if (seenChecks.has(it)) return;  // claimed by an outer container already
        if (!isUsable(it)) return;
        seenChecks.add(it);
        options.push({ el: it, text: textOf(it), index: options.length });
      });
      if (options.length > 0) {
        const name = gc.id || ('__aria__:' + (out.length + 1));
        out.push({ kind: 'checkbox', name: name, options: options });
      }
    });
    const looseChecks = root.querySelectorAll('[role="checkbox"]');
    const orphan = [];
    looseChecks.forEach(function (it, i) {
      if (seenChecks.has(it)) return;
      if (!isUsable(it)) return;
      orphan.push({ el: it, text: textOf(it), index: orphan.length });
    });
    if (orphan.length > 0) out.push({ kind: 'checkbox', name: '__aria_loose__:' + (out.length + 1), options: orphan });
    return out;
  }

  function findOptionGroups(root) {
    if (!root) return [];
    return findNativeGroups(root).concat(findAriaGroups(root));
  }

  const api = { findOptionGroups: findOptionGroups };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.answerMatcher = api;
  }
})(typeof self !== 'undefined' ? self : this);
