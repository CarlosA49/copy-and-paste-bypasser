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

  const ROW_SELECTORS = [
    'a[href*="/learn/"]',
    '[data-testid="rc-DesktopItem"]',
    '[role="link"][href*="/learn/"]',
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
    const aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && /\bnot\b/i.test(aria)) return false;
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
    const containers = allMatching(doc, CONTAINER_SELECTORS);
    if (containers.length === 0) {
      return { courseId: courseId, moduleId: moduleId, items: [] };
    }
    // Drawer-style containers: partition into sections and pick by URL item.
    for (let i = 0; i < containers.length; i++) {
      if (!isDrawerContainer(containers[i])) continue;
      const sections = sectionsIn(containers[i]);
      const picked = pickSection(sections, currentItemId);
      if (picked.items.length > 0) {
        return { courseId: courseId, moduleId: moduleId, items: picked.items };
      }
    }
    // Legacy path: each container is its own module list.
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
    const items = chosenItems || firstNonEmpty || [];
    return { courseId: courseId, moduleId: moduleId, items: items };
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
    const totalItemsFound = candidates.reduce(function (n, c) { return n + c.itemCount; }, 0);
    return { containerCandidates: candidates, totalItemsFound: totalItemsFound };
  }

  const api = {
    scrapeModule: scrapeModule,
    scrapeModuleDiagnostics: scrapeModuleDiagnostics,
    extractCourseId: extractCourseId,
    extractItemId: extractItemId,
    classifyKind: classifyKind,
    findItemCompletionIndicator: findItemCompletionIndicator,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.moduleScraper = api;
  }
})(typeof self !== 'undefined' ? self : this);
