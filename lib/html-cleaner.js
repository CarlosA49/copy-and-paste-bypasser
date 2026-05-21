// Dual-mode module: usable from a browser content script (attaches to window)
// and from Node tests (exports via module.exports). Mirrors lib/cleaner.js.
//
// Public surface:
//   cleanSelectionHtml(htmlString) -> { cleanHtml, cleanText }

(function (root) {
  'use strict';

  // Reuse the junk-pattern source of truth from lib/cleaner.js. Loading is
  // environment-aware to mirror the document factory.
  const JUNK_LINE_PATTERNS = (function () {
    if (typeof module !== 'undefined' && module.exports) {
      // Node context.
      return require('./cleaner.js').JUNK_LINE_PATTERNS;
    }
    // Browser content-script context: lib/cleaner.js was loaded first and
    // attached the patterns to window.ClipboardCleaner.
    return (root.ClipboardCleaner && root.ClipboardCleaner.JUNK_LINE_PATTERNS) || [];
  })();

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

  // --- Pass 1: MathJax normalisation ----------------------------------------

  const MJ_CLASSES = [
    'MathJax', 'MathJax_Display', 'MathJax_Preview', 'MathJax_SVG',
    'MathJax_SVG_Display', 'MJX_Assistive_MathML', 'mjx-chtml', 'mjx-math',
  ];

  function isMathJaxNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (!node.classList) return false;
    for (let i = 0; i < MJ_CLASSES.length; i++) {
      if (node.classList.contains(MJ_CLASSES[i])) return true;
    }
    return false;
  }

  function createMathElement(doc, latex, isDisplay, preservedMathML) {
    const NS = 'http://www.w3.org/1998/Math/MathML';
    const math = doc.createElementNS(NS, 'math');
    math.setAttribute('xmlns', NS);
    math.setAttribute('display', isDisplay ? 'block' : 'inline');
    const semantics = doc.createElementNS(NS, 'semantics');
    if (preservedMathML) {
      semantics.appendChild(preservedMathML);
    } else {
      const mtext = doc.createElementNS(NS, 'mtext');
      mtext.textContent = latex;
      semantics.appendChild(mtext);
    }
    const annotation = doc.createElementNS(NS, 'annotation');
    annotation.setAttribute('encoding', 'application/x-tex');
    annotation.textContent = latex;
    semantics.appendChild(annotation);
    math.appendChild(semantics);
    return math;
  }

  function normalizeMathJaxScripts(body) {
    // Each <script type="math/tex"> is the LaTeX source. The companion
    // visual rendering(s) are preceding siblings with a MathJax class.
    // Walk backward, collect MathJax siblings, then replace the whole
    // group with one <math>.
    const scripts = Array.from(body.querySelectorAll('script[type^="math/tex"]'));
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i];
      const typeAttr = script.getAttribute('type') || '';
      const isDisplay = /mode\s*=\s*display/i.test(typeAttr);
      const latex = (script.textContent || '').trim();
      if (!latex) { script.remove(); continue; }

      const siblings = [];
      let prev = script.previousSibling;
      while (prev) {
        // Skip whitespace-only text nodes between siblings.
        if (prev.nodeType === 3 && /^\s*$/.test(prev.textContent)) {
          prev = prev.previousSibling;
          continue;
        }
        if (!isMathJaxNode(prev)) break;
        siblings.unshift(prev);
        prev = prev.previousSibling;
      }

      const insertionPoint = siblings.length > 0 ? siblings[0] : script;
      const math = createMathElement(body.ownerDocument, latex, isDisplay, null);
      insertionPoint.parentNode.insertBefore(math, insertionPoint);
      for (let j = 0; j < siblings.length; j++) siblings[j].remove();
      script.remove();
    }
  }

  function normalizeExistingMathML(body) {
    // Pre-existing <math> elements: ensure annotation exists if alttext does;
    // otherwise leave them alone.
    const maths = Array.from(body.getElementsByTagName('math'));
    for (let i = 0; i < maths.length; i++) {
      const m = maths[i];
      const hasAnnotation = m.querySelector('annotation[encoding="application/x-tex"]');
      if (hasAnnotation) continue;
      const alt = m.getAttribute('alttext');
      if (!alt) continue;
      // Inject annotation into the existing semantics, or wrap if missing.
      let semantics = m.querySelector('semantics');
      if (!semantics) {
        const NS = 'http://www.w3.org/1998/Math/MathML';
        semantics = body.ownerDocument.createElementNS(NS, 'semantics');
        while (m.firstChild) semantics.appendChild(m.firstChild);
        m.appendChild(semantics);
      }
      const NS = 'http://www.w3.org/1998/Math/MathML';
      const annotation = body.ownerDocument.createElementNS(NS, 'annotation');
      annotation.setAttribute('encoding', 'application/x-tex');
      annotation.textContent = alt;
      semantics.appendChild(annotation);
    }
  }

  function applyMathJaxNormalization(body) {
    normalizeMathJaxScripts(body);
    normalizeExistingMathML(body);
  }

  // --- Pass 2: Block-level junk drop ----------------------------------------

  const BLOCK_TAGS_FOR_JUNK_CHECK = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE',
    'HEADER', 'FOOTER', 'FIGURE', 'FIGCAPTION',
    'BLOCKQUOTE', 'LI', 'TR', 'TD', 'TH',
  ]);

  function elementTextMatchesAnyJunk(el) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) return false;
    for (let i = 0; i < JUNK_LINE_PATTERNS.length; i++) {
      if (JUNK_LINE_PATTERNS[i].test(text)) return true;
    }
    return false;
  }

  function dropJunkBlocks(body) {
    // Depth-first walk; remove leaves first so the smallest junk block is
    // dropped rather than a huge ancestor that also happens to contain junk.
    const stack = [body];
    const order = [];
    while (stack.length) {
      const node = stack.pop();
      for (let i = 0; i < node.children.length; i++) stack.push(node.children[i]);
      order.push(node);
    }
    // Reverse so children are processed before parents.
    for (let i = order.length - 1; i >= 0; i--) {
      const el = order[i];
      if (el === body) continue;
      if (!BLOCK_TAGS_FOR_JUNK_CHECK.has(el.tagName)) continue;
      if (!el.parentNode) continue; // already removed transitively
      if (elementTextMatchesAnyJunk(el)) el.remove();
    }
  }

  function cleanSelectionHtml(rawHtml) {
    if (rawHtml == null) return { cleanHtml: '', cleanText: '' };
    if (typeof rawHtml !== 'string') return { cleanHtml: '', cleanText: '' };

    const doc = getDoc(rawHtml);
    const body = doc.body;

    applyMathJaxNormalization(body);
    dropJunkBlocks(body);

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
