// lib/module-scraper.js
// Parses the Coursera course-module sidebar into a queue.
(function (root) {
  'use strict';

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
    quiz: 'quiz',
    exam: 'quiz',
    assignment: 'quiz',
    peer: 'peer-review',
    programming: 'programming',
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
    if (!KIND_BY_SEGMENT[m[1]]) return null;
    return m[2];
  }

  function classifyKind(url) {
    if (!url) return 'other';
    const m = String(url).match(/\/learn\/[^/]+\/([a-zA-Z]+)\//);
    if (!m) return 'other';
    return KIND_BY_SEGMENT[m[1]] || 'other';
  }

  function kindFromVisibleText(text) {
    if (!text) return null;
    for (let i = 0; i < VISIBLE_KIND_MAP.length; i++) {
      if (VISIBLE_KIND_MAP[i].re.test(text)) return VISIBLE_KIND_MAP[i].kind;
    }
    return null;
  }

  const ROW_STATUS_PREFIX_RE = /^\s*(Completed|Not completed|In progress)\s*/i;
  const ROW_KIND_RE = /(?<=[a-z0-9]|\b)(Practice Quiz|Programming Assignment|Programming Lab|Peer Review|Discussion Prompt|Video|Reading|Quiz|Assignment|Programming|Lab|Discussion)(?=\b|\.|\s|$)/i;

  function classifyVisibleKind(label) {
    const s = String(label || '').toLowerCase();
    if (/programming/.test(s)) return 'programming';
    if (/peer review/.test(s)) return 'peer-review';
    if (/discussion/.test(s)) return 'discussion';
    if (/practice quiz/.test(s)) return 'quiz';
    if (/quiz/.test(s)) return 'quiz';
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

  function extractModuleId(url) {
    if (!url) return null;
    const m = String(url).match(/\/home\/week\/(\d+)/);
    return m ? ('week-' + m[1]) : null;
  }

  function isCompleted(anchor) {
    for (let i = 0; i < COMPLETED_SELECTORS.length; i++) {
      const el = anchor.querySelector(COMPLETED_SELECTORS[i]);
      if (isPositiveCompletionEl(el)) return true;
    }
    return false;
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
    return { courseId: courseId, moduleId: moduleId, items: [] };
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
    return { containerCandidates: candidates, totalItemsFound: totalItemsFound, sectionCount: sectionCount };
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
    findItemCompletionIndicator: findItemCompletionIndicator,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.moduleScraper = api;
  }
})(typeof self !== 'undefined' ? self : this);
