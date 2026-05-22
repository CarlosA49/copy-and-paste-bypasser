// lib/transcript-scraper.js
(function (root) {
  'use strict';

  // Selectors tried in order. First non-empty match wins.
  const TRANSCRIPT_CONTAINER_SELECTORS = [
    '[data-testid="transcript"]',
    '.rc-Transcript',
    '[class*="Transcript"]',
  ];

  const CUE_SELECTORS = [
    '.phrase',
    '.transcript-text',
    '[class*="phrase"]',
    '[role="button"][data-time]',
  ];

  const LECTURE_TITLE_SELECTORS = [
    '.rc-ItemHeader h1',
    '.rc-VideoMiniPlayer h1',
    'h1[class*="LectureTitle"]',
    'h1',
  ];

  const WEEK_OBJECTIVE_SELECTORS = [
    '[aria-current="page"][data-week-objective]',
  ];

  const WEEK_TITLE_SELECTORS = [
    '[aria-current="page"] [class*="WeekTitle"]',
    'h2[class*="Week"]',
  ];

  function firstMatching(root, selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const el = root.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function allMatching(root, selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const list = root.querySelectorAll(selectors[i]);
      if (list && list.length > 0) return Array.prototype.slice.call(list);
    }
    return [];
  }

  function parseTime(raw) {
    if (raw == null) return null;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
    // Optional "MM:SS" fallback
    const m = String(raw).match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0);
    return null;
  }

  function scrapeCues(doc) {
    const container = firstMatching(doc, TRANSCRIPT_CONTAINER_SELECTORS);
    if (!container) return null;
    const cueEls = allMatching(container, CUE_SELECTORS);
    if (cueEls.length === 0) return null;
    const cues = [];
    for (let i = 0; i < cueEls.length; i++) {
      const el = cueEls[i];
      const text = (el.textContent || '').trim();
      if (!text) continue;
      cues.push({
        time: parseTime(el.getAttribute('data-time')),
        text: text,
      });
    }
    return cues.length > 0 ? cues : null;
  }

  function scrapeText(doc, selectors, attr) {
    const el = firstMatching(doc, selectors);
    if (!el) return null;
    if (attr) {
      const v = el.getAttribute(attr);
      return v ? v.trim() : null;
    }
    const t = (el.textContent || '').trim();
    return t || null;
  }

  function scrapeTranscript(doc) {
    const cues = scrapeCues(doc);
    const lectureTitle = scrapeText(doc, LECTURE_TITLE_SELECTORS);
    const weekTitle = scrapeText(doc, WEEK_TITLE_SELECTORS);
    const weekObjective = scrapeText(doc, WEEK_OBJECTIVE_SELECTORS, 'data-week-objective');
    return {
      cues: cues,
      lectureTitle: lectureTitle,
      weekTitle: weekTitle,
      weekObjective: weekObjective,
    };
  }

  function findVideoElement(doc) {
    return doc.querySelector('video') || null;
  }

  const api = {
    scrapeTranscript: scrapeTranscript,
    findVideoElement: findVideoElement,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.transcriptScraper = api;
  }
})(typeof self !== 'undefined' ? self : this);
