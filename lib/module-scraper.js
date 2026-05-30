// lib/module-scraper.js
// Parses the Coursera course-module sidebar into a queue.
(function (root) {
  'use strict';

  const courseraDom = (function () {
    if (typeof module !== 'undefined' && module.exports) {
      try { return require('./coursera-dom.js'); } catch (_) { return null; }
    }
    return (root.ClipboardCleaner && root.ClipboardCleaner.courseraDom) || null;
  })();

  function findModuleRegions(doc) {
    if (courseraDom && typeof courseraDom.findModuleRegions === 'function') {
      return courseraDom.findModuleRegions(doc);
    }
    return [];
  }

  const CONTAINER_SELECTORS = [
    '[data-testid="lesson-collection"]',
    '.rc-LessonCollection',
    'nav[aria-label*="lesson" i]',
    '[class*="LessonCollection"]',
    // Modern course-content drawer (Module 1 / Course Pages screenshot)
    '[data-testid="course-content-drawer"]',
    'aside[aria-label*="course content" i]',
    '[data-testid*="course-content" i]',
    '[class*="CourseContentDrawer" i]',
  ];

  const SECTION_SELECTORS = [
    '[data-testid="module-section"]',
    '[data-testid*="module-section" i]',
    '[class*="ModuleSection" i]',
    'section',
  ];

  const COMPLETED_SELECTORS = [
    '[aria-label*="completed" i]',
    '[class*="Completed"]',
    'svg[class*="check" i]',
    '[class*="status-completed" i]',
    '[data-testid*="completed" i]',
    '[data-icon*="check" i]',
  ];

  const VISIBLE_KIND_MAP = [
    { re: /\bvideo\b/i,        kind: 'video' },
    { re: /\breading\b/i,      kind: 'reading' },
    { re: /\bdiscussion\b/i,   kind: 'discussion' },
    { re: /\bquiz\b/i,         kind: 'quiz' },
    { re: /\bassignment\b/i,   kind: 'quiz' },
    { re: /\bexam\b/i,         kind: 'quiz' },
    { re: /\bpeer review\b/i,  kind: 'peer-review' },
    { re: /\bprogramming\b/i,  kind: 'programming' },
    { re: /\bplugin\b/i,       kind: 'reading' },
  ];

  const KIND_BY_SEGMENT = {
    lecture: 'video',
    supplement: 'reading',
    discussionPrompt: 'discussion',
    ungradedWidget: 'reading',
    quiz: 'quiz',
    exam: 'quiz',
    assignment: 'quiz',
    peer: 'peer-review',
    programming: 'programming',
    gradedLti: 'assignment',
  };

  function firstMatching(root, selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const el = root.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function allMatching(root, selectors) {
    const seen = new Set();
    const out = [];
    for (let i = 0; i < selectors.length; i++) {
      const list = root.querySelectorAll(selectors[i]);
      for (let j = 0; j < list.length; j++) {
        const el = list[j];
        if (!seen.has(el)) { seen.add(el); out.push(el); }
      }
    }
    return out.filter(function (el) {
      return !out.some(function (other) { return other !== el && other.contains(el); });
    });
  }

  function extractCourseId(url) {
    if (!url) return null;
    const m = String(url).match(/\/learn\/([^/]+)/);
    return m ? m[1] : null;
  }

  function extractItemId(url) {
    if (!url) return null;
    const m = String(url).match(/\/learn\/[^/]+\/([a-zA-Z]+)\/([^/?#]+)/);
    if (!m) return null;
    // Unknown/renamed segments KEEP their id (kind resolves to 'other' via
    // classifyKind) so new lessons are never silently dropped from the queue.
    return m[2];
  }

  function classifyKind(url) {
    if (!url) return 'other';
    const m = String(url).match(/\/learn\/[^/]+\/([a-zA-Z]+)\//);
    if (!m) return 'other';
    return KIND_BY_SEGMENT[m[1]] || 'other';
  }

  const BLOCKED_URL_PATTERNS = [
    /\/gradedLti\//i,
    /\/assignment-submission\//i,
    /\/quiz\//i,
    /\/exam\//i,
    /\/peer\//i,
    /\/programming\//i,
    /\/review\//i,
    /\/discussionPrompt\//i,
    /\/discussion\//i,
  ];

  const BLOCKED_TITLE_PATTERNS = [
    /\bgraded\b/i,
    /\bassignment\b/i,
    /\bexam\b/i,
    /\bquiz\b/i,
    /\bpeer\b/i,
    /\bassessment\b/i,
    /\breview your peers\b/i,
    /\bapp item\b/i,
    /\bdiscussion prompt\b/i,
  ];

  const BLOCKED_KINDS = ['quiz', 'peer-review', 'programming', 'assignment', 'discussion'];

  function isBlockedAssessmentItem(item) {
    if (!item) return false;
    if (item.kind && BLOCKED_KINDS.indexOf(item.kind) !== -1) return true;
    const url = item.url || '';
    for (let i = 0; i < BLOCKED_URL_PATTERNS.length; i++) {
      if (BLOCKED_URL_PATTERNS[i].test(url)) return true;
    }
    const title = item.title || '';
    for (let i = 0; i < BLOCKED_TITLE_PATTERNS.length; i++) {
      if (BLOCKED_TITLE_PATTERNS[i].test(title)) return true;
    }
    return false;
  }

  function kindFromVisibleText(text) {
    if (!text) return null;
    for (let i = 0; i < VISIBLE_KIND_MAP.length; i++) {
      if (VISIBLE_KIND_MAP[i].re.test(text)) return VISIBLE_KIND_MAP[i].kind;
    }
    return null;
  }

  const ROW_STATUS_PREFIX_RE = /^\s*(Completed|Not completed|In progress)\s*/i;
  // Coursera appends the item type just before its punctuation/meta text.
  // Requiring that suffix avoids interpreting the "LAB" inside "MATLAB" or
  // a word such as "Programming" in a reading title as the activity kind.
  // "Graded App Item" and "App Item" must come BEFORE "Assignment" so the regex
  // prefers the longer, more specific match for blocked rows like
  // "Assignment: Matrix IndexingGraded App Item. Duration: 15 minutes15 min".
  const ROW_KIND_RE = /(Practice Quiz|Programming Assignment|Programming Lab|Peer Review|Discussion Prompt|Graded App Item|App Item|Video|Reading|Quiz|Assignment|Programming|Lab|Discussion)(?=\s*(?:\.|$))/i;

  function classifyVisibleKind(label) {
    const s = String(label || '').toLowerCase();
    if (/programming/.test(s)) return 'programming';
    if (/peer review/.test(s)) return 'peer-review';
    if (/discussion/.test(s)) return 'discussion';
    if (/practice quiz/.test(s)) return 'quiz';
    if (/quiz/.test(s)) return 'quiz';
    if (/app item/.test(s)) return 'assignment';
    if (/assignment/.test(s)) return 'quiz';
    if (/lab\b/.test(s)) return 'programming';
    if (/reading/.test(s)) return 'reading';
    if (/video/.test(s)) return 'video';
    return null;
  }

  function parseRowText(rawText) {
    let text = String(rawText || '').replace(/\s+/g, ' ').trim();
    text = text.replace(ROW_STATUS_PREFIX_RE, '');
    const m = text.match(ROW_KIND_RE);
    if (!m) return { title: text, kind: null, meta: null };
    const idx = m.index;
    const title = text.slice(0, idx).trim().replace(/[\.•·\-:\s]+$/, '').trim();
    const meta = text.slice(idx).trim();
    return { title: title, kind: classifyVisibleKind(m[1]), meta: meta };
  }

  const MODULE_HEADER_RE = /\b(Module|Week|Lesson|Unit)\s+\d+/i;

  function findAccordionHeaders(root) {
    if (!root) return [];
    let candidates = Array.prototype.slice.call(
      root.querySelectorAll('button[class*="AccordionHeader" i], button[class*="accordion-header" i], [role="button"][class*="AccordionHeader" i]')
    );
    if (candidates.length === 0) {
      candidates = Array.prototype.slice.call(root.querySelectorAll('button, [role="button"]'));
    }
    return candidates.filter(function (b) {
      return MODULE_HEADER_RE.test(textOf(b));
    });
  }

  function pairHeaderWithPanel(headerEl, doc) {
    if (!headerEl) return null;
    const controlsId = headerEl.getAttribute && headerEl.getAttribute('aria-controls');
    if (controlsId && doc && typeof doc.getElementById === 'function') {
      const byId = doc.getElementById(controlsId);
      if (byId) return byId;
    }
    // First, check the header's own immediate following siblings (same parent level).
    let sib = headerEl.nextElementSibling;
    while (sib) {
      if (sib.querySelector && sib.querySelector('a[href*="/learn/"]')) return sib;
      sib = sib.nextElementSibling;
    }
    // Walk forward through ancestors looking at following siblings for a panel-like subtree.
    let node = headerEl.parentElement;
    while (node) {
      let parentSib = node.nextElementSibling;
      while (parentSib) {
        if (parentSib.querySelector && parentSib.querySelector('a[href*="/learn/"]')) return parentSib;
        parentSib = parentSib.nextElementSibling;
      }
      // Also look inside the current ancestor for a panel that comes after the header in document order.
      if (node.querySelector) {
        const panels = node.querySelectorAll('[id*="accordion-panel" i], [role="region"]');
        for (let i = 0; i < panels.length; i++) {
          if (headerEl.compareDocumentPosition && (headerEl.compareDocumentPosition(panels[i]) & 0x04 /* FOLLOWING */)) {
            if (panels[i].querySelector('a[href*="/learn/"]')) return panels[i];
          }
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function extractItemsFromPanel(panelEl) {
    if (!panelEl || typeof panelEl.querySelectorAll !== 'function') return [];
    const anchors = panelEl.querySelectorAll('a[href*="/learn/"]');
    const items = [];
    const seen = new Set();
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const href = a.getAttribute('href');
      const id = extractItemId(href);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // Title + kind from row text via parseRowText
      const rowEl = a.querySelector('.outline-single-item-content-wrapper, [class*="outline-single-item" i]') || a;
      const parsed = parseRowText(textOf(rowEl));
      let title = parsed.title || textOf(a);
      let kind = parsed.kind || classifyKind(href);
      if (!kind || kind === 'other') kind = classifyKind(href);
      items.push({
        id: id,
        title: title,
        kind: kind || 'other',
        url: href,
        completed: isCompleted(a),
      });
    }
    return items;
  }

  function scrapeModuleByAccordion(doc) {
    if (!doc) return { items: [], section: null };
    const url = (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || '';
    const currentItemId = extractItemId(url);
    const headers = findAccordionHeaders(doc);
    if (headers.length === 0) return { items: [], section: null };
    const pairs = [];
    for (let i = 0; i < headers.length; i++) {
      const panel = pairHeaderWithPanel(headers[i], doc);
      if (!panel) continue;
      pairs.push({ header: headers[i], panel: panel, items: extractItemsFromPanel(panel) });
    }
    if (pairs.length === 0) return { items: [], section: null };
    // 1. Section containing the current URL's item
    if (currentItemId) {
      for (let i = 0; i < pairs.length; i++) {
        if (pairs[i].items.some(function (it) { return it.id === currentItemId; })) {
          return { items: pairs[i].items, section: pairs[i].panel };
        }
      }
    }
    // 2. Expanded section (aria-expanded="true")
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i].header.getAttribute && pairs[i].header.getAttribute('aria-expanded') === 'true') {
        if (pairs[i].items.length > 0) return { items: pairs[i].items, section: pairs[i].panel };
      }
    }
    // 3. First non-empty section
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i].items.length > 0) return { items: pairs[i].items, section: pairs[i].panel };
    }
    return { items: [], section: null };
  }

  function moduleHeaderElements(root) {
    const out = [];
    if (!root || typeof root.querySelectorAll !== 'function') return out;
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      const t = textOf(el);
      if (!t || t.length > 120) continue;
      if (!MODULE_HEADER_RE.test(t)) continue;
      const childMatch = Array.prototype.some.call(el.children || [], function (c) { return MODULE_HEADER_RE.test(textOf(c)); });
      if (childMatch) continue;
      out.push(el);
    }
    return out;
  }

  function scrapeModuleByText(doc) {
    if (!doc) return { items: [], section: null };
    const url = (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || '';
    const currentItemId = extractItemId(url);
    const headers = moduleHeaderElements(doc);
    if (headers.length === 0) return { items: [], section: null };
    const anchors = Array.prototype.slice.call(doc.querySelectorAll('a[href*="/learn/"]'));
    const headerPositions = headers.map(function (h, i) {
      return { header: h, items: [], idx: i };
    });
    function compareDoc(a, b) {
      if (a === b) return 0;
      const p = a.compareDocumentPosition(b);
      return (p & 0x04) ? -1 : ((p & 0x02) ? 1 : 0);
    }
    for (let j = 0; j < anchors.length; j++) {
      const a = anchors[j];
      let owner = -1;
      for (let i = 0; i < headers.length; i++) {
        if (compareDoc(headers[i], a) < 0) owner = i; else break;
      }
      if (owner < 0) continue;
      headerPositions[owner].items.push(a);
    }
    function buildItems(anchorList) {
      const items = [];
      const seen = new Set();
      for (let i = 0; i < anchorList.length; i++) {
        const a = anchorList[i];
        const href = a.getAttribute('href');
        const id = extractItemId(href);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const parsed = parseRowText(textOf(a));
        const items_kind = parsed.kind || classifyKind(href);
        items.push({
          id: id,
          title: parsed.title || textOf(a),
          kind: items_kind || 'other',
          url: href,
          completed: isCompleted(a),
        });
      }
      return items;
    }
    if (currentItemId) {
      for (let i = 0; i < headerPositions.length; i++) {
        const items = buildItems(headerPositions[i].items);
        if (items.some(function (it) { return it.id === currentItemId; })) {
          return { items: items, section: headerPositions[i].header };
        }
      }
    }
    for (let i = 0; i < headerPositions.length; i++) {
      const items = buildItems(headerPositions[i].items);
      if (items.length > 0) return { items: items, section: headerPositions[i].header };
    }
    return { items: [], section: null };
  }

  function extractModuleId(url) {
    if (!url) return null;
    const m = String(url).match(/\/home\/week\/(\d+)/);
    return m ? ('week-' + m[1]) : null;
  }

  function isCompleted(anchor) {
    // PREFERRED signal: the item link's accessibleName status token. When the
    // accessibleName carries a recognized status, it is authoritative — a
    // 'completed' token means done, any other recognized status (not-submitted /
    // locked) means NOT done, and the green-RGB heuristic is not consulted.
    if (courseraDom && typeof courseraDom.itemStatus === 'function') {
      const status = courseraDom.itemStatus(anchor);
      if (status === 'completed') return true;
      if (status === 'not-submitted' || status === 'locked') return false;
      // status === 'unknown' -> fall through to the legacy signals below.
    }
    // Secondary signal: existing class / aria-label / data-testid completion markers.
    for (let i = 0; i < COMPLETED_SELECTORS.length; i++) {
      const el = anchor.querySelector(COMPLETED_SELECTORS[i]);
      if (isPositiveCompletionEl(el)) return true;
    }
    // LAST RESORT: the brittle green-RGB icon heuristic, only when no status token
    // and no explicit marker resolved the question.
    return !!findGreenCompletionElement(anchor);
  }

  function findItemCompletionIndicator(doc, itemId) {
    if (!doc || !itemId) return null;
    const anchors = doc.querySelectorAll('a[href*="/learn/"]');
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const href = a.getAttribute('href');
      if (extractItemId(href) !== itemId) continue;
      for (let j = 0; j < COMPLETED_SELECTORS.length; j++) {
        const el = a.querySelector(COMPLETED_SELECTORS[j]);
        if (isPositiveCompletionEl(el)) return el;
      }
    }
    return null;
  }

  function parseColorToRgb(c) {
    if (!c) return null;
    const s = String(c).trim();
    let m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/i);
    if (m) return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
    m = s.match(/^#([0-9a-f]{6})$/i);
    if (m) {
      return { r: parseInt(m[1].slice(0,2), 16), g: parseInt(m[1].slice(2,4), 16), b: parseInt(m[1].slice(4,6), 16) };
    }
    m = s.match(/^#([0-9a-f]{3})$/i);
    if (m) {
      const x = m[1];
      return { r: parseInt(x[0] + x[0], 16), g: parseInt(x[1] + x[1], 16), b: parseInt(x[2] + x[2], 16) };
    }
    return null;
  }

  function isGreenColor(rgb) {
    if (!rgb) return false;
    return rgb.g >= 80 && rgb.r < 120 && rgb.b < 120 && rgb.g > rgb.r && rgb.g > rgb.b;
  }

  function elementHasGreenColor(el) {
    if (!el || !el.getAttribute) return false;
    // 1. Inline style (jsdom-safe).
    const style = el.getAttribute('style') || '';
    const styleColor = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
    if (styleColor && isGreenColor(parseColorToRgb(styleColor[1]))) return true;
    const styleFill = style.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i);
    if (styleFill && isGreenColor(parseColorToRgb(styleFill[1]))) return true;
    const styleStroke = style.match(/(?:^|;)\s*stroke\s*:\s*([^;]+)/i);
    if (styleStroke && isGreenColor(parseColorToRgb(styleStroke[1]))) return true;
    // 2. SVG-style attributes.
    const fillAttr = el.getAttribute('fill');
    if (fillAttr && isGreenColor(parseColorToRgb(fillAttr))) return true;
    const strokeAttr = el.getAttribute('stroke');
    if (strokeAttr && isGreenColor(parseColorToRgb(strokeAttr))) return true;
    // 3. getComputedStyle in browsers.
    if (typeof el.ownerDocument !== 'undefined' && el.ownerDocument && el.ownerDocument.defaultView
        && typeof el.ownerDocument.defaultView.getComputedStyle === 'function') {
      try {
        const cs = el.ownerDocument.defaultView.getComputedStyle(el);
        if (cs) {
          if (isGreenColor(parseColorToRgb(cs.color))) return true;
          if (isGreenColor(parseColorToRgb(cs.fill))) return true;
          if (isGreenColor(parseColorToRgb(cs.stroke))) return true;
        }
      } catch (_) {}
    }
    return false;
  }

  function findGreenCompletionElement(anchor) {
    if (!anchor || typeof anchor.querySelectorAll !== 'function') return null;
    const candidates = anchor.querySelectorAll('svg, path, span, i');
    for (let i = 0; i < candidates.length; i++) {
      if (elementHasGreenColor(candidates[i])) return candidates[i];
    }
    return null;
  }

  function findGreenCompletionIconInRow(doc, itemId) {
    if (!doc || !itemId) return null;
    const anchors = doc.querySelectorAll('a[href*="/learn/"]');
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      if (extractItemId(a.getAttribute('href')) !== itemId) continue;
      // PREFERRED: accessibleName status. A recognized non-completed status
      // (not-submitted / locked) means this row is NOT done — do not fall through
      // to the green-RGB heuristic for it. A 'completed' token is positive evidence.
      if (courseraDom && typeof courseraDom.itemStatus === 'function') {
        const rowStatus = courseraDom.itemStatus(a);
        if (rowStatus === 'completed') return a;
        if (rowStatus === 'not-submitted' || rowStatus === 'locked') continue;
      }
      // 1. Existing aria-label / class-based positive completion markers.
      for (let j = 0; j < COMPLETED_SELECTORS.length; j++) {
        const marker = a.querySelector(COMPLETED_SELECTORS[j]);
        if (isPositiveCompletionEl(marker)) return marker;
      }
      // 2. Row-scoped green icon search.
      const greenIcon = findGreenCompletionElement(a);
      if (greenIcon) return greenIcon;
    }
    return null;
  }

  function isPositiveCompletionEl(el) {
    if (!el) return false;
    if (!el.getAttribute) return true;
    const aria = el.getAttribute('aria-label');
    if (aria && /\bnot\b/i.test(aria)) return false;
    const testid = el.getAttribute('data-testid');
    if (testid && /not[-_]?completed/i.test(testid)) return false;
    return true;
  }

  function textOf(el) {
    return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function collectItemsFrom(container) {
    const anchors = container.querySelectorAll('a[href*="/learn/"]');
    const items = [];
    const seen = new Set();
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const href = a.getAttribute('href');
      const id = extractItemId(href);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      let title = '';
      const titleEl = a.querySelector('.item-title, [class*="ItemTitle" i], [data-testid*="item-title" i]');
      if (titleEl) title = textOf(titleEl);
      if (!title) title = textOf(a);
      const metaEl = a.querySelector('.item-meta, [class*="ItemMeta" i], [data-testid*="item-meta" i]');
      const metaText = metaEl ? textOf(metaEl) : '';
      let kind = classifyKind(href);
      if (kind === 'other') {
        const fromText = kindFromVisibleText(metaText) || kindFromVisibleText(textOf(a));
        if (fromText) kind = fromText;
      }
      items.push({
        id: id,
        title: title,
        kind: kind,
        url: href,
        completed: isCompleted(a),
      });
    }
    return items;
  }

  function isDrawerContainer(el) {
    if (!el) return false;
    const testId = el.getAttribute && el.getAttribute('data-testid');
    if (testId && /course-content/i.test(testId)) return true;
    const cls = (el.className && typeof el.className === 'string') ? el.className : '';
    if (/CourseContentDrawer/i.test(cls)) return true;
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && /course content/i.test(aria)) return true;
    return false;
  }

  function sectionsIn(container) {
    for (let i = 0; i < SECTION_SELECTORS.length; i++) {
      const list = container.querySelectorAll(SECTION_SELECTORS[i]);
      if (list.length > 1) return Array.prototype.slice.call(list);
    }
    return [container];
  }

  function pickSection(sections, currentItemId) {
    if (currentItemId) {
      for (let i = 0; i < sections.length; i++) {
        const items = collectItemsFrom(sections[i]);
        if (items.some(function (it) { return it.id === currentItemId; })) {
          return { section: sections[i], items: items };
        }
      }
    }
    for (let i = 0; i < sections.length; i++) {
      const items = collectItemsFrom(sections[i]);
      if (items.length > 0) return { section: sections[i], items: items };
    }
    return { section: null, items: [] };
  }

  function scrapeModule(doc) {
    const url = (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || '';
    const courseId = extractCourseId(url);
    const moduleId = extractModuleId(url);
    const currentItemId = extractItemId(url);
    // ---- Layer 1: Existing stable selectors ----
    const containers = allMatching(doc, CONTAINER_SELECTORS);
    if (containers.length > 0) {
      for (let i = 0; i < containers.length; i++) {
        if (!isDrawerContainer(containers[i])) continue;
        const sections = sectionsIn(containers[i]);
        const picked = pickSection(sections, currentItemId);
        if (picked.items.length > 0) {
          return { courseId: courseId, moduleId: moduleId, items: picked.items };
        }
      }
      let chosenItems = null;
      let firstNonEmpty = null;
      for (let i = 0; i < containers.length; i++) {
        const items = collectItemsFrom(containers[i]);
        if (items.length === 0) continue;
        if (!firstNonEmpty) firstNonEmpty = items;
        if (currentItemId && items.some(function (it) { return it.id === currentItemId; })) {
          chosenItems = items;
          break;
        }
      }
      if (chosenItems || firstNonEmpty) {
        return { courseId: courseId, moduleId: moduleId, items: chosenItems || firstNonEmpty };
      }
    }
    // ---- Layer 2: Coursera Design System accordion ----
    const acc = scrapeModuleByAccordion(doc);
    if (acc.items.length > 0) {
      return { courseId: courseId, moduleId: moduleId, items: acc.items };
    }
    // ---- Layer 3: Pure text-pattern ----
    const txt = scrapeModuleByText(doc);
    if (txt.items.length > 0) {
      return { courseId: courseId, moduleId: moduleId, items: txt.items };
    }
    return { courseId: courseId, moduleId: moduleId, items: [] };
  }

  function scrapeAllModules(doc) {
    if (!doc) return { courseId: null, modules: [] };
    const url = (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || '';
    const courseId = extractCourseId(url);
    const headers = findAccordionHeaders(doc);
    const modules = [];
    for (let i = 0; i < headers.length; i++) {
      const headerText = textOf(headers[i]).slice(0, 200);
      const panel = pairHeaderWithPanel(headers[i], doc);
      const items = panel ? extractItemsFromPanel(panel) : [];
      const idMatch = headerText.match(MODULE_HEADER_RE);
      const moduleId = idMatch ? (idMatch[1] + '-' + headerText.match(/\d+/)[0]).toLowerCase() : ('module-' + (i + 1));
      modules.push({ moduleId: moduleId, headerText: headerText, items: items });
    }
    return { courseId: courseId, modules: modules };
  }

  function scrapeModuleDiagnostics(doc) {
    const candidates = CONTAINER_SELECTORS.map(function (sel) {
      const list = doc.querySelectorAll(sel);
      let itemCount = 0;
      for (let i = 0; i < list.length; i++) {
        itemCount += list[i].querySelectorAll('a[href*="/learn/"]').length;
      }
      return { selector: sel, matched: list.length > 0, nodeCount: list.length, itemCount: itemCount };
    });
    let sectionCount = 0;
    for (let i = 0; i < SECTION_SELECTORS.length; i++) {
      const found = doc.querySelectorAll(SECTION_SELECTORS[i]).length;
      if (found > sectionCount) sectionCount = found;
    }
    const totalItemsFound = candidates.reduce(function (n, c) { return n + c.itemCount; }, 0);
    const headers = findAccordionHeaders(doc);
    const accordionPanelCount = doc.querySelectorAll('[id*="accordion-panel" i], [role="region"]').length;
    const learnAnchorCount = doc.querySelectorAll('a[href*="/learn/"]').length;
    const markCompleteCount = Array.prototype.filter.call(
      doc.querySelectorAll('button, [role="button"]'),
      function (b) { return /^(mark\s+as\s+completed?|mark\s+complete|complete|completed)$/i.test(textOf(b)); }
    ).length;
    const goToNextCount = Array.prototype.filter.call(
      doc.querySelectorAll('button, a, [role="button"]'),
      function (b) { return /^(go\s+to\s+next\s+item|next\s+item|continue)$/i.test(textOf(b)); }
    ).length;
    const headerSamples = headers.slice(0, 3).map(function (h) { return textOf(h).slice(0, 80); });
    const anchorSamples = Array.prototype.slice.call(doc.querySelectorAll('a[href*="/learn/"]'), 0, 5).map(function (a) { return textOf(a).slice(0, 80); });
    return {
      containerCandidates: candidates,
      totalItemsFound: totalItemsFound,
      sectionCount: sectionCount,
      accordionHeaderCount: headers.length,
      accordionPanelCount: accordionPanelCount,
      learnAnchorCount: learnAnchorCount,
      markCompleteCount: markCompleteCount,
      goToNextCount: goToNextCount,
      headerSamples: headerSamples,
      anchorSamples: anchorSamples,
    };
  }

  const api = {
    scrapeModule: scrapeModule,
    scrapeModuleDiagnostics: scrapeModuleDiagnostics,
    extractCourseId: extractCourseId,
    extractItemId: extractItemId,
    classifyKind: classifyKind,
    classifyVisibleKind: classifyVisibleKind,
    parseRowText: parseRowText,
    findAccordionHeaders: findAccordionHeaders,
    pairHeaderWithPanel: pairHeaderWithPanel,
    extractItemsFromPanel: extractItemsFromPanel,
    scrapeModuleByAccordion: scrapeModuleByAccordion,
    scrapeAllModules: scrapeAllModules,
    findItemCompletionIndicator: findItemCompletionIndicator,
    findGreenCompletionIconInRow: findGreenCompletionIconInRow,
    scrapeModuleByText: scrapeModuleByText,
    isBlockedAssessmentItem: isBlockedAssessmentItem,
    findModuleRegions: findModuleRegions,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.moduleScraper = api;
  }
})(typeof self !== 'undefined' ? self : this);
