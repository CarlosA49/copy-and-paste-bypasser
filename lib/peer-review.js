// lib/peer-review.js
// Peer-review auto-complete handler + pure rubric/comment/submit detection.
// All DOM access is scoped via an injected coursera-dom (Phase A) and excludes
// the extension's own sidebar + the Boost support chat. Auto-submit is the
// deliberate exception to the fill-and-pause rule (per spec WS-D).
(function (root) {
  'use strict';

  // --- exclusion helpers --------------------------------------------------

  // Hardcoded last-resort exclusion used only when coursera-dom is absent.
  function fallbackIsExcluded(el) {
    if (!el || el.nodeType !== 1) return false;
    let node = el;
    while (node && node.nodeType === 1) {
      const id = (node.id || '').toLowerCase();
      const cls = (typeof node.className === 'string' ? node.className : '').toLowerCase();
      if (id === 'ccp-host' || id === 'ccp-host-root') return true;
      if (id === 'boostai-chat-panel-composer') return true;
      if (cls.indexOf('boost-chatpanel') !== -1) return true;
      const name = (node.getAttribute && (node.getAttribute('name') || '')) || '';
      if (name.toLowerCase() === 'ccp-behavior') return true;
      node = node.parentElement;
    }
    return false;
  }

  // --- numeric point parsing ---------------------------------------------

  // Parse a numeric point value from option text/aria. Matches "2 points",
  // "1 point", "3 pts", "5 marks". Returns a finite number or null.
  function parsePoints(text) {
    if (!text) return null;
    const m = String(text).match(/(-?\d+(?:\.\d+)?)\s*(?:points?|pts?|marks?)\b/i);
    if (m) {
      const n = parseFloat(m[1]);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  // --- rubric detection ---------------------------------------------------

  function optionText(el) {
    const aria = (el.getAttribute && (el.getAttribute('aria-label') || '')) || '';
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return (aria + ' ' + txt).trim();
  }

  // A criterion = a radiogroup (role=radiogroup or a fieldset of radios) whose
  // options are the contained radio inputs / labelled cds- options.
  function detectCriteria(rootEl, excludeFn) {
    const exclude = (typeof excludeFn === 'function') ? excludeFn : function () { return false; };
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return [];
    const groups = [];
    const seen = new Set();
    const groupEls = rootEl.querySelectorAll('[role="radiogroup"], fieldset');
    for (let i = 0; i < groupEls.length; i++) {
      const g = groupEls[i];
      if (exclude(g)) continue;
      const radios = g.querySelectorAll('input[type="radio"], [role="radio"]');
      if (radios.length < 2) continue; // not a scoring criterion
      if (seen.has(g)) continue;
      seen.add(g);
      const options = [];
      for (let r = 0; r < radios.length; r++) {
        const radio = radios[r];
        if (exclude(radio)) continue;
        // The clickable target is the label wrapper if present, else the input.
        const label = radio.closest ? (radio.closest('label') || radio) : radio;
        const text = optionText(label);
        options.push({ input: radio, control: label, text: text, points: parsePoints(text) });
      }
      if (options.length < 2) continue;
      const label = (g.getAttribute && (g.getAttribute('aria-label') || '')) || '';
      groups.push({ element: g, label: label, options: options });
    }
    return groups;
  }

  // Select the highest-scoring option. If no option has parseable points, fall
  // back to the LAST option (Coursera usually orders best last) and flag it.
  function selectHighestOption(criterion) {
    const opts = (criterion && criterion.options) || [];
    if (opts.length === 0) return { option: null, points: null, lowConfidence: true };
    let best = null;
    let bestPoints = -Infinity;
    for (let i = 0; i < opts.length; i++) {
      const p = opts[i].points;
      if (typeof p === 'number' && Number.isFinite(p) && p > bestPoints) {
        bestPoints = p;
        best = opts[i];
      }
    }
    if (best) {
      return { option: best, points: bestPoints, lowConfidence: false };
    }
    return { option: opts[opts.length - 1], points: null, lowConfidence: true };
  }

  // --- comment + submit detection ----------------------------------------

  function findRequiredCommentBoxes(rootEl, excludeFn) {
    const exclude = (typeof excludeFn === 'function') ? excludeFn : function () { return false; };
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return [];
    const boxes = [];
    const candidates = rootEl.querySelectorAll(
      'textarea[required], textarea[aria-required="true"], textarea[data-required="true"], ' +
      'div[contenteditable="true"][aria-required="true"]');
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (exclude(el)) continue;
      boxes.push(el);
    }
    return boxes;
  }

  const SUBMIT_TEXT_RE = /\b(submit|submit review|done|finish|complete review)\b/i;

  function findSubmitControl(rootEl, excludeFn) {
    const exclude = (typeof excludeFn === 'function') ? excludeFn : function () { return false; };
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return null;
    const buttons = rootEl.querySelectorAll(
      'button, [role="button"], input[type="submit"], [class*="cds-button"]');
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      if (exclude(b)) continue;
      const aria = (b.getAttribute && (b.getAttribute('aria-label') || '')) || '';
      const txt = (b.textContent || '');
      if (SUBMIT_TEXT_RE.test(aria) || SUBMIT_TEXT_RE.test(txt)) return b;
    }
    return null;
  }

  // --- handler factory (real flow in Task 4) -----------------------------

  function createPeerReviewHandler(deps) {
    // Filled in by Task 4.
    return async function peerReview(ctx) {
      return { outcome: 'peer-review-needs-user' };
    };
  }

  const api = {
    detectCriteria: detectCriteria,
    selectHighestOption: selectHighestOption,
    findRequiredCommentBoxes: findRequiredCommentBoxes,
    findSubmitControl: findSubmitControl,
    parsePoints: parsePoints,
    fallbackIsExcluded: fallbackIsExcluded,
    createPeerReviewHandler: createPeerReviewHandler,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.peerReview = api;
  }
})(typeof self !== 'undefined' ? self : this);
