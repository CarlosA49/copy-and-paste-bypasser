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

  // Pure LaTeX → visible-text flattener. Browser context: rely on
  // window.ClipboardCleaner.mathFlatten (registered by lib/math-flatten.js,
  // loaded earlier by the manifest). Node tests: require the module directly.
  const mathFlatten = (function () {
    if (typeof module !== 'undefined' && module.exports) {
      return require('./math-flatten.js');
    }
    return (root.ClipboardCleaner && root.ClipboardCleaner.mathFlatten) || null;
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

  // --- Pass 3: Attribute stripping ------------------------------------------

  // Per-tag allow-list of attributes. Anything else gets stripped.
  // Tags not in this map keep zero attributes.
  const ATTR_ALLOW = {
    'A': ['href', 'title'],
    'IMG': ['src', 'alt', 'title', 'width', 'height'],
    'TD': ['colspan', 'rowspan', 'scope'],
    'TH': ['colspan', 'rowspan', 'scope', 'abbr'],
    'OL': ['start', 'type', 'reversed'],
    'MATH': ['xmlns', 'display', 'alttext'],
    'ANNOTATION': ['encoding'],
  };

  function stripAttributes(body) {
    const all = body.getElementsByTagName('*');
    // Iterate via index because attribute removal can invalidate live lists,
    // but getElementsByTagName('*') stays stable in iteration order.
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const tag = el.tagName.toUpperCase();
      const allow = ATTR_ALLOW[tag] || [];
      // Collect names first (live NamedNodeMap mutates during removal).
      const names = [];
      for (let j = 0; j < el.attributes.length; j++) names.push(el.attributes[j].name);
      for (let j = 0; j < names.length; j++) {
        const n = names[j];
        if (allow.indexOf(n) === -1) el.removeAttribute(n);
      }
    }
  }

  // --- Pass 4: Tag allow-list / unwrap ---------------------------------------

  const ALLOWED_TAGS = new Set([
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'P', 'BR', 'HR',
    'UL', 'OL', 'LI',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'CAPTION',
    'BLOCKQUOTE', 'PRE', 'CODE', 'KBD', 'SAMP', 'VAR',
    'STRONG', 'EM', 'B', 'I', 'U', 'S', 'DEL', 'INS', 'MARK', 'SMALL', 'SUB', 'SUP',
    'A', 'IMG', 'FIGURE', 'FIGCAPTION',
    'SPAN', 'DIV', 'SECTION', 'ARTICLE',
    // MathML core
    'MATH', 'SEMANTICS', 'ANNOTATION',
    'MROW', 'MI', 'MN', 'MO', 'MS', 'MTEXT',
    'MFRAC', 'MSUP', 'MSUB', 'MSUBSUP', 'MUNDER', 'MOVER', 'MUNDEROVER',
    'MSQRT', 'MROOT', 'MTABLE', 'MTR', 'MTD', 'MLABELEDTR',
    'MENCLOSE', 'MPHANTOM', 'MPADDED', 'MFENCED', 'MSPACE', 'MGLYPH',
  ]);

  function unwrap(el) {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }

  function filterTags(body) {
    // Collect first so removal/unwrap doesn't break live iteration.
    const all = Array.from(body.getElementsByTagName('*'));
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      // Some MathML tags resolve as lowercase via createElementNS; normalise.
      const tag = (el.tagName || '').toUpperCase();
      if (!ALLOWED_TAGS.has(tag)) unwrap(el);
    }
  }

  const BLOCK_EMPTY_CHECK = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'ASIDE',
    'HEADER', 'FOOTER', 'FIGURE', 'FIGCAPTION',
    'BLOCKQUOTE', 'SPAN', 'STRONG', 'EM',
  ]);

  function isEffectivelyEmpty(el) {
    if (el.children.length > 0) {
      for (let i = 0; i < el.children.length; i++) {
        if (!isEffectivelyEmpty(el.children[i])) return false;
      }
    }
    return (el.textContent || '').replace(/\s+/g, '') === '';
  }

  function dropEmptyWrappers(body) {
    // Multiple passes — removing an inner empty span may make its parent
    // effectively empty too.
    let changed = true;
    while (changed) {
      changed = false;
      const all = Array.from(body.getElementsByTagName('*'));
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (!el.parentNode) continue;
        const tag = el.tagName.toUpperCase();
        if (!BLOCK_EMPTY_CHECK.has(tag)) continue;
        if (isEffectivelyEmpty(el)) {
          el.remove();
          changed = true;
        }
      }
    }
  }

  function cleanSelectionHtml(rawHtml) {
    if (rawHtml == null) return { cleanHtml: '', cleanText: '' };
    if (typeof rawHtml !== 'string') return { cleanHtml: '', cleanText: '' };

    const doc = getDoc(rawHtml);
    const body = doc.body;

    applyMathJaxNormalization(body);
    dropJunkBlocks(body);
    stripAttributes(body);
    filterTags(body);
    dropEmptyWrappers(body);

    const cleanHtml = body.innerHTML.trim();

    // Derive plain text via a structural walker.
    let cleanText = walkPlainText(body);
    // Strip zero-width characters that some sites use as invisible spacers.
    cleanText = cleanText.replace(/[​-‍﻿]/g, '');
    // Collapse 3+ newlines to 2, trim trailing whitespace.
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').replace(/\s+$/g, '');
    // Paranoid final pass: any boilerplate that slipped past block-level
    // filtering (e.g., text directly inside <body>) is still caught here.
    const cleaner = (typeof module !== 'undefined' && module.exports)
      ? require('./cleaner.js').cleanCopiedText
      : (root.ClipboardCleaner && root.ClipboardCleaner.cleanCopiedText) || function (x) { return x; };
    cleanText = cleaner(cleanText);

    return { cleanHtml: cleanHtml, cleanText: cleanText };
  }

  // --- Plain-text derivation -------------------------------------------------

  function getAnnotationLatex(mathEl) {
    const ann = mathEl.querySelector('annotation[encoding="application/x-tex"]');
    if (ann) return (ann.textContent || '').trim();
    const alt = mathEl.getAttribute('alttext');
    if (alt) return alt.trim();
    return (mathEl.textContent || '').trim();
  }

  // Tags treated as inline by the walker; everything else is block-ish.
  const INLINE_TAGS = new Set([
    'A', 'SPAN', 'STRONG', 'EM', 'B', 'I', 'U', 'S',
    'DEL', 'INS', 'MARK', 'SMALL', 'SUB', 'SUP',
    'CODE', 'KBD', 'SAMP', 'VAR', 'IMG',
  ]);

  const LI_LABEL_RE = /^\s*\(?[a-zA-Z0-9]\)?[.):]/;
  // Matches "1.", "1)", "(1)", "a.", "a)", "(a)", "A.", "A)", "(A)" etc.

  function walkPlainText(body) {
    // Recursive walker. Accumulates into an array of strings, joins at end.
    const out = [];

    function emit(s) { out.push(s); }
    function lastChar() {
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].length > 0) return out[i][out[i].length - 1];
      }
      return '';
    }

    function walk(node, ctx) {
      // ctx: { inPre: bool, listStack: [{ ordered, index }, ...] }
      ctx = ctx || { inPre: false, listStack: [] };

      if (node.nodeType === 3) { // text
        let t = node.textContent;
        if (!ctx.inPre) t = t.replace(/\s+/g, ' ');
        emit(t);
        return;
      }
      if (node.nodeType !== 1) return;

      const tag = (node.tagName || '').toUpperCase();

      // <math>
      if (tag === 'MATH') {
        const latex = getAnnotationLatex(node);
        const isDisplay = (node.getAttribute('display') || 'inline').toLowerCase() === 'block';
        if (isDisplay) {
          if (lastChar() !== '\n') emit('\n');
          emit('$$' + latex + '$$\n');
        } else {
          // Inline: prefer visible Unicode; fall back to LaTeX only when the
          // expression is too complex to flatten safely.
          const flat = (mathFlatten && mathFlatten.flattenLatexToText)
            ? mathFlatten.flattenLatexToText(latex)
            : null;
          emit(flat !== null ? flat : ('$' + latex + '$'));
        }
        return;
      }

      // <br>
      if (tag === 'BR') { emit('\n'); return; }

      // <hr>
      if (tag === 'HR') {
        if (lastChar() !== '\n') emit('\n');
        emit('\n---\n\n');
        return;
      }

      // <a>
      if (tag === 'A') {
        const href = node.getAttribute('href') || '';
        const childText = collectChildText(node, ctx);
        if (href && childText && href !== childText) emit(childText + ' (' + href + ')');
        else if (href) emit(href);
        else emit(childText);
        return;
      }

      // <img>
      if (tag === 'IMG') {
        const alt = node.getAttribute('alt') || '';
        if (alt) emit(alt);
        return;
      }

      // Lists
      if (tag === 'OL' || tag === 'UL') {
        const start = tag === 'OL' ? parseInt(node.getAttribute('start') || '1', 10) || 1 : 0;
        const frame = { ordered: tag === 'OL', index: start };
        const newStack = ctx.listStack.concat([frame]);
        if (lastChar() && lastChar() !== '\n') emit('\n');
        for (let i = 0; i < node.childNodes.length; i++) {
          walk(node.childNodes[i], { inPre: ctx.inPre, listStack: newStack });
        }
        if (lastChar() !== '\n') emit('\n');
        return;
      }

      if (tag === 'LI') {
        const frame = ctx.listStack[ctx.listStack.length - 1];
        const bodyText = collectChildText(node, ctx).replace(/^\s+|\s+$/g, '');
        let prefix = '';
        if (frame) {
          if (frame.ordered) {
            if (!LI_LABEL_RE.test(bodyText)) {
              prefix = frame.index + '. ';
            }
            frame.index += 1;
          } else {
            if (!LI_LABEL_RE.test(bodyText)) {
              prefix = '- ';
            }
          }
        }
        if (lastChar() && lastChar() !== '\n') emit('\n');
        emit(prefix + bodyText + '\n');
        return;
      }

      // Tables
      if (tag === 'TR') {
        if (lastChar() && lastChar() !== '\n') emit('\n');
        const cells = [];
        for (let i = 0; i < node.children.length; i++) {
          const c = node.children[i];
          const ctag = c.tagName.toUpperCase();
          if (ctag === 'TD' || ctag === 'TH') {
            cells.push(collectChildText(c, ctx).replace(/\s+/g, ' ').trim());
          }
        }
        emit(cells.join('\t') + '\n');
        return;
      }
      if (tag === 'TD' || tag === 'TH') {
        // Handled by TR walker above; skip when reached directly.
        return;
      }

      // Block-ish elements: ensure newline separation before/after.
      const isInline = INLINE_TAGS.has(tag);
      if (!isInline) {
        if (lastChar() && lastChar() !== '\n') emit('\n');
      }
      for (let i = 0; i < node.childNodes.length; i++) {
        walk(node.childNodes[i], ctx);
      }
      if (!isInline) {
        // Paragraph break after block.
        if (lastChar() !== '\n') emit('\n');
        emit('\n');
      }
    }

    function collectChildText(node, ctx) {
      const saveLen = out.length;
      for (let i = 0; i < node.childNodes.length; i++) {
        walk(node.childNodes[i], ctx);
      }
      const collected = out.splice(saveLen).join('');
      return collected;
    }

    walk(body, { inPre: false, listStack: [] });
    return out.join('');
  }

  const api = { cleanSelectionHtml: cleanSelectionHtml };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.cleanSelectionHtml = cleanSelectionHtml;
  }
})(typeof self !== 'undefined' ? self : this);
