// lib/question-detector.js
// DOM read: finds Coursera question containers, identifies type
// (math_input / single_choice / multiple_choice), exposes targets/choices.
// Depends on lib/answer-matcher.js for findOptionGroups (re-uses radio/checkbox
// discovery). Dual-export.
(function (root) {
  'use strict';

  const answerMatcher = (function () {
    if (typeof module !== 'undefined' && module.exports) {
      return require('./answer-matcher.js');
    }
    return (root.ClipboardCleaner && root.ClipboardCleaner.answerMatcher) || null;
  })();

  const courseraDom = (function () {
    if (typeof module !== 'undefined' && module.exports) {
      try { return require('./coursera-dom.js'); } catch (_) { return null; }
    }
    return (root.ClipboardCleaner && root.ClipboardCleaner.courseraDom) || null;
  })();

  function isExcludedContainer(el) {
    return !!(courseraDom && typeof courseraDom.isExcludedNode === 'function' && courseraDom.isExcludedNode(el));
  }

  const HEAD_RE = /^\s*Question\s+(\d{1,2})\b/i;

  const CONTAINER_SELECTOR = 'fieldset, [role="radiogroup"], [role="group"], [data-testid^="cml-question"], [data-testid*="question"], div[class*="question" i]';

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hidden === true) return false;
    if (el.type === 'hidden') return false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
      if (cur.style && (cur.style.display === 'none' || cur.style.visibility === 'hidden')) return false;
      // Computed style honours stylesheets too (real browser). In JSDOM this
      // mostly reflects inline styles, so the inline checks above already cover
      // the common test cases.
      const view = cur.ownerDocument && cur.ownerDocument.defaultView;
      if (view && view.getComputedStyle) {
        try {
          const cs = view.getComputedStyle(cur);
          if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
        } catch (_) { /* JSDOM may throw on detached nodes */ }
      }
      cur = cur.parentElement;
    }
    return true;
  }

  function findHeaderInside(container) {
    // Find first descendant whose direct visible text matches HEAD_RE.
    // Cheap walk: querySelectorAll('h1,h2,h3,h4,h5,h6,div,span,p,legend').
    const candidates = container.querySelectorAll('h1,h2,h3,h4,h5,h6,div,span,p,legend');
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const m = txt.match(HEAD_RE);
      if (m) return { number: parseInt(m[1], 10), titleText: m[0].trim() };
    }
    return null;
  }

  function collectContainers(root) {
    const seen = new Set();
    const containers = [];

    // Pass A: explicit selectors.
    const explicit = root.querySelectorAll(
      '[data-testid^="cml-question"], [data-testid*="question"], fieldset[data-testid*="question"]'
    );
    explicit.forEach(function (el) {
      if (seen.has(el)) return;
      if (isExcludedContainer(el)) return;
      const hdr = findHeaderInside(el);
      if (hdr) {
        seen.add(el);
        containers.push({ container: el, header: hdr });
      }
    });

    // Pass B: walk headings ourselves.
    const heads = root.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,div,span,p');
    heads.forEach(function (el) {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const m = txt.match(HEAD_RE);
      if (!m) return;
      // Skip if this heading is nested inside an already-collected container.
      const anc = el.closest(CONTAINER_SELECTOR);
      const c = anc || el.parentElement;
      if (!c || seen.has(c)) return;
      if (isExcludedContainer(c)) return;
      // Require the matched element to be the leftmost text of its block
      // (e.g. a heading, not buried prose). Heuristic: txt starts with "Question N".
      if (!/^Question\s+\d{1,2}\b/i.test(txt)) return;
      seen.add(c);
      containers.push({ container: c, header: { number: parseInt(m[1], 10), titleText: 'Question ' + m[1] } });
    });

    return containers;
  }

  function findRadioOrCheckbox(container) {
    if (!answerMatcher || typeof answerMatcher.findOptionGroups !== 'function') return null;
    const groups = answerMatcher.findOptionGroups(container);
    if (!groups || groups.length === 0) return null;
    // Prefer the first group; Coursera questions are 1 group per question.
    return groups[0];
  }

  // Detect editable input targets, preferring visible / non-hidden / non-mirror.
  function findEditableTargets(container) {
    const out = [];
    const TEXT_TYPES = ['text','number','email','tel','url','password'];
    const candidates = container.querySelectorAll(
      'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""], .mq-editable-field, [data-testid*="math" i][contenteditable]'
    );
    candidates.forEach(function (el) {
      const tag = (el.tagName || '').toUpperCase();
      if (tag === 'INPUT') {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'hidden') return;
        if (TEXT_TYPES.indexOf(t) === -1) return;
      }
      if (el.disabled) return;
      if (el.readOnly) return;
      if (!isVisible(el)) return;
      out.push(el);
    });
    // If we have both a visible contenteditable and a sibling hidden mirror,
    // prefer the contenteditable. (Already excluded type=hidden above.)
    // De-dup by element.
    const seen = new Set();
    const dedup = [];
    out.forEach(function (el) {
      if (seen.has(el)) return;
      seen.add(el); dedup.push(el);
    });
    return dedup;
  }

  function classify(container) {
    const group = findRadioOrCheckbox(container);
    if (group) {
      return {
        type: group.kind === 'radio' ? 'single_choice' : 'multiple_choice',
        choices: group.options.map(function (o) { return { el: o.el, text: o.text, index: o.index }; }),
        targets: []
      };
    }
    const targets = findEditableTargets(container);
    if (targets.length > 0) {
      return { type: 'math_input', choices: [], targets: targets };
    }
    return { type: 'unknown', choices: [], targets: [] };
  }

  function detectQuestions(root) {
    if (!root) return [];
    const raw = collectContainers(root);

    const byNumber = new Map();
    raw.forEach(function (rc) {
      const cls = classify(rc.container);
      const fullText = (rc.container.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      const entry = {
        questionNumber: rc.header.number,
        titleText: rc.header.titleText,
        fullText: fullText,
        type: cls.type,
        choices: cls.choices,
        targets: cls.targets,
        container: rc.container
      };
      const prev = byNumber.get(entry.questionNumber);
      if (!prev) { byNumber.set(entry.questionNumber, entry); return; }
      // Prefer the entry with a typed answer surface.
      const score = function (e) {
        if (e.type === 'single_choice' || e.type === 'multiple_choice') return 3;
        if (e.type === 'math_input') return 2;
        return 0;
      };
      if (score(entry) > score(prev)) byNumber.set(entry.questionNumber, entry);
    });

    const list = Array.from(byNumber.values());
    list.sort(function (a, b) { return a.questionNumber - b.questionNumber; });
    return list;
  }

  const api = { detectQuestions: detectQuestions };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.questionDetector = api;
  }
})(typeof self !== 'undefined' ? self : this);
