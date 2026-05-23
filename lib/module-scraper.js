// lib/module-scraper.js
// Parses the Coursera course-module sidebar into a queue.
(function (root) {
  'use strict';

  const CONTAINER_SELECTORS = [
    '[data-testid="lesson-collection"]',
    '.rc-LessonCollection',
    'nav[aria-label*="lesson" i]',
    '[class*="LessonCollection"]',
  ];

  const COMPLETED_SELECTORS = [
    '[aria-label*="completed" i]',
    '[class*="Completed"]',
    'svg[class*="check" i]',
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

  function extractModuleId(url) {
    if (!url) return null;
    const m = String(url).match(/\/home\/week\/(\d+)/);
    return m ? ('week-' + m[1]) : null;
  }

  function isCompleted(anchor) {
    for (let i = 0; i < COMPLETED_SELECTORS.length; i++) {
      if (anchor.querySelector(COMPLETED_SELECTORS[i])) return true;
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
        if (el) return el;
      }
    }
    return null;
  }

  function textOf(el) {
    return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
  }

  function scrapeModule(doc) {
    const url = (doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || '';
    const courseId = extractCourseId(url);
    const moduleId = extractModuleId(url);
    const container = firstMatching(doc, CONTAINER_SELECTORS);
    if (!container) {
      return { courseId: courseId, moduleId: moduleId, items: [] };
    }
    const anchors = container.querySelectorAll('a[href*="/learn/"]');
    const items = [];
    const seen = new Set();
    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const href = a.getAttribute('href');
      const id = extractItemId(href);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      items.push({
        id: id,
        title: textOf(a),
        kind: classifyKind(href),
        url: href,
        completed: isCompleted(a),
      });
    }
    return { courseId: courseId, moduleId: moduleId, items: items };
  }

  const api = {
    scrapeModule: scrapeModule,
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
