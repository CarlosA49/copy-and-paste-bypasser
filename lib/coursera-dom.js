// lib/coursera-dom.js
// Pure, DOM-reading Coursera helpers (jsdom-testable). The spec-frozen public
// API consumed by module-scraper, question-detector, answer-matcher,
// ai-question-context, page-fallback, completion-confirmer, module-autopilot.
// Leaf module: no static require of sibling lib modules (must load in both
// node --test and the browser content-script context).
(function (root) {
  'use strict';

  // URL grammar: /learn/{courseSlug}/{kind}/{id}/{itemSlug}
  // Extends module-scraper's KIND_BY_SEGMENT. Unknown segments map to 'other'
  // and KEEP their id (never null) so new/renamed segments stay in the queue.
  const KIND_BY_SEGMENT = {
    home: 'home',
    lecture: 'video',
    supplement: 'reading',
    discussionPrompt: 'discussion',
    ungradedWidget: 'plugin',
    quiz: 'quiz',
    exam: 'exam',
    peer: 'peer',
    assignment: 'assignment',
    programming: 'programming',
    gradedLti: 'gradedLti',
  };

  // accessibleName "Kind, ..." token -> kind. English default; locale-tolerant
  // callers can extend later. Longer/more specific tokens first.
  const KIND_BY_NAME_TOKEN = [
    { re: /\bungraded\s+plugin\b/i, kind: 'plugin' },
    { re: /\bgraded\s+app\s+item\b/i, kind: 'gradedLti' },
    { re: /\bapp\s+item\b/i, kind: 'gradedLti' },
    { re: /\bgraded\s+assignment\b/i, kind: 'assignment' },
    { re: /\bpeer\s+review\b/i, kind: 'peer' },
    { re: /\bprogramming\b/i, kind: 'programming' },
    { re: /\bdiscussion\s+prompt\b/i, kind: 'discussion' },
    { re: /\bexam\b/i, kind: 'exam' },
    { re: /\bpractice\s+quiz\b/i, kind: 'quiz' },
    { re: /\bquiz\b/i, kind: 'quiz' },
    { re: /\bvideo\b/i, kind: 'video' },
    { re: /\breading\b/i, kind: 'reading' },
  ];

  const LEARN_RE = /\/learn\/([^/?#]+)\/([a-zA-Z]+)\/([^/?#]+)(?:\/([^?#]+))?/;

  function parseLearnUrl(url) {
    if (!url) return null;
    const m = String(url).match(LEARN_RE);
    if (!m) return null;
    return {
      courseSlug: m[1],
      kind: m[2],
      id: m[3],
      itemSlug: (typeof m[4] === 'string' && m[4].length > 0) ? m[4] : null,
    };
  }

  function kindFromName(accessibleName) {
    if (!accessibleName) return null;
    const s = String(accessibleName);
    for (let i = 0; i < KIND_BY_NAME_TOKEN.length; i++) {
      if (KIND_BY_NAME_TOKEN[i].re.test(s)) return KIND_BY_NAME_TOKEN[i].kind;
    }
    return null;
  }

  function classifyKind(urlOrSegment, accessibleName) {
    const raw = String(urlOrSegment || '');
    let seg = null;
    const parsed = parseLearnUrl(raw);
    if (parsed) {
      seg = parsed.kind;
    } else if (/^[a-zA-Z]+$/.test(raw.trim())) {
      seg = raw.trim();
    }
    if (seg && Object.prototype.hasOwnProperty.call(KIND_BY_SEGMENT, seg)) {
      return KIND_BY_SEGMENT[seg];
    }
    // URL segment unknown/absent: cross-check the accessibleName.
    const byName = kindFromName(accessibleName);
    if (byName) return byName;
    return 'other';
  }

  const api = {
    parseLearnUrl: parseLearnUrl,
    classifyKind: classifyKind,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.courseraDom = api;
  }
})(typeof self !== 'undefined' ? self : this);
