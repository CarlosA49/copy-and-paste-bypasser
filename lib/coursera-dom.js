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

  // Status vocabulary (English default, locale-tolerant set). Maps a raw token
  // to the canonical value. Order: longest/most-specific phrasing first.
  const STATUS_TOKENS = [
    { re: /\bnot\s+submitted\b/i, value: 'not-submitted' },
    { re: /\bnot\s+completed\b/i, value: 'not-submitted' },
    { re: /\blocked\b/i, value: 'locked' },
    { re: /\bcompleted\b/i, value: 'completed' },
  ];

  function statusFromToken(token) {
    if (!token) return 'unknown';
    const s = String(token);
    for (let i = 0; i < STATUS_TOKENS.length; i++) {
      if (STATUS_TOKENS[i].re.test(s)) return STATUS_TOKENS[i].value;
    }
    return 'unknown';
  }

  // The status occupies its own comma-token in the grammar, so a token only
  // counts as the status when it equals a status phrase as a WHOLE token —
  // otherwise a title like "Completed solutions" or "Locked Room Mystery" would
  // be mis-detected as the status. (statusFromToken stays unanchored: it maps a
  // confirmed status token to its canonical value and backs the itemStatus string
  // fallback, where a status word embedded in free text is still a useful signal.)
  const WHOLE_STATUS_RE = /^(?:not\s+submitted|not\s+completed|locked|completed)$/i;

  function looksLikeStatus(token) {
    return WHOLE_STATUS_RE.test(String(token == null ? '' : token).trim());
  }

  // accessibleName grammar: "Kind, Title[, ...], Status[, lock reason], Duration"
  // Tokenize on commas, then locate the status token. Everything between the
  // first token (kind) and the status token rejoins into the title (so a title
  // like "Assignment: MATLAB Calculation" survives). Anything between status
  // and the final duration token is the optional lock reason.
  function parseItemAccessibleName(name) {
    if (!name) return null;
    const parts = String(name).split(',').map(function (p) { return p.trim(); }).filter(function (p) { return p.length > 0; });
    if (parts.length < 3) return null;
    let statusIdx = -1;
    for (let i = 1; i < parts.length; i++) {
      if (looksLikeStatus(parts[i])) { statusIdx = i; break; }
    }
    if (statusIdx === -1) return null;
    const kindToken = parts[0];
    const title = parts.slice(1, statusIdx).join(', ');
    const status = statusFromToken(parts[statusIdx]);
    const durationText = parts[parts.length - 1];
    let lockReason = null;
    // Tokens strictly between status and the trailing duration form the lock reason.
    if (parts.length - 1 > statusIdx + 1) {
      lockReason = parts.slice(statusIdx + 1, parts.length - 1).join(', ');
    }
    return {
      kindToken: kindToken,
      title: title,
      status: status,
      lockReason: lockReason,
      durationText: durationText,
    };
  }

  // Deliberately does NOT collapse whitespace (unlike accessibleNameOf): itemStatus
  // feeds this into parseItemAccessibleName, which tokenizes on commas, so the raw
  // string must be preserved.
  function nameOf(input) {
    if (input == null) return '';
    if (typeof input === 'string') return input;
    if (input.getAttribute) {
      return input.getAttribute('aria-label')
        || input.getAttribute('title')
        || (input.textContent || '');
    }
    return '';
  }

  function itemStatus(input) {
    const name = nameOf(input);
    const parsed = parseItemAccessibleName(name);
    if (parsed) return parsed.status;
    return statusFromToken(name);
  }

  // Hard exclusions applied before any scan/fill/submit. Covers the extension's
  // own sidebar (live: a shadow host #ccp-host-root; jsdom fixtures: an inlined
  // .ccp-host subtree + name=ccp-behavior controls) and the Boost support chat.
  const EXCLUDE_SELECTORS = [
    '#ccp-host-root',
    '.ccp-host',
    'input[name="ccp-behavior"]',
    '#boostai-chat-panel-composer',
    '[class*="Boost-ChatPanel"]',
    '[data-testid="coach-chat-launcher-button"]',
  ];

  function matchesAny(el, selectors) {
    if (!el || typeof el.matches !== 'function') return false;
    for (let i = 0; i < selectors.length; i++) {
      try { if (el.matches(selectors[i])) return true; } catch (_) { /* invalid selector in env */ }
    }
    return false;
  }

  function isExcludedNode(el) {
    if (!el || el.nodeType !== 1) return false;
    let cur = el;
    while (cur && cur.nodeType === 1) {
      if (matchesAny(cur, EXCLUDE_SELECTORS)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  // The Coursera app content root: prefer <main> / [role="main"], else <body>,
  // skipping any candidate that is itself excluded (isExcludedNode = extension/chat)
  // or nested under a page-chrome landmark (isChromeContainer = nav/aside/banner).
  function isChromeContainer(el) {
    if (!el || !el.getAttribute) return false;
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'NAV' || tag === 'ASIDE') return true;
    const role = el.getAttribute('role');
    if (role === 'navigation' || role === 'complementary' || role === 'banner') return true;
    return false;
  }

  function underChrome(el, stopAt) {
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== stopAt) {
      if (isChromeContainer(cur)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function assessmentRoot(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    const body = doc.body || null;
    let candidates = [];
    try { candidates = candidates.concat(Array.prototype.slice.call(doc.querySelectorAll('main, [role="main"]'))); } catch (_) {}
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (!isExcludedNode(c) && !underChrome(c, body)) return c;
    }
    return body;
  }

  function withinAssessment(el) {
    if (!el || el.nodeType !== 1) return false;
    if (isExcludedNode(el)) return false;
    const doc = el.ownerDocument;
    const root = assessmentRoot(doc);
    if (!root) return false;
    if (root === el) return true;
    if (typeof root.contains === 'function' && !root.contains(el)) return false;
    // Even inside the root, reject nodes under a chrome container.
    return !underChrome(el, root);
  }

  function normText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function accessibleNameOf(el) {
    if (!el || !el.getAttribute) return '';
    return normText(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '');
  }

  function findOutlineNav(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return null;
    let navs = [];
    try { navs = Array.prototype.slice.call(doc.querySelectorAll('[role="navigation"], nav')); } catch (_) {}
    for (let i = 0; i < navs.length; i++) {
      if (isExcludedNode(navs[i])) continue;
      // Prefer a nav that actually contains course item links or module regions.
      if (navs[i].querySelector && (navs[i].querySelector('a[href*="/learn/"]') || navs[i].querySelector('[role="region"]'))) {
        return navs[i];
      }
    }
    return navs.length ? navs[0] : null;
  }

  // Each module is a role=region "Module N Title" with a role=heading level-3
  // toggle button (interactions: clickable + expandable). Returns one entry per
  // region with its title, the toggle button, and its expanded state. NOTE: this
  // returns EVERY non-excluded [role="region"]; callers that want only outline
  // modules should pass the outline nav (findOutlineNav) as `doc` to scope it.
  function findModuleRegions(doc) {
    const out = [];
    if (!doc || typeof doc.querySelectorAll !== 'function') return out;
    let regions = [];
    try { regions = Array.prototype.slice.call(doc.querySelectorAll('[role="region"]')); } catch (_) {}
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
      if (isExcludedNode(region)) continue;
      let headingToggle = null;
      const heading = region.querySelector && region.querySelector('[role="heading"]');
      if (heading) headingToggle = heading.querySelector('button, [role="button"]') || heading;
      if (!headingToggle) headingToggle = region.querySelector && region.querySelector('button[aria-expanded], [role="button"][aria-expanded]');
      const title = (region.getAttribute && region.getAttribute('aria-label'))
        ? normText(region.getAttribute('aria-label'))
        : (headingToggle ? accessibleNameOf(headingToggle) : '');
      let expanded = false;
      const expSrc = (headingToggle && headingToggle.getAttribute && headingToggle.getAttribute('aria-expanded')) || (region.getAttribute && region.getAttribute('aria-expanded'));
      if (expSrc === 'true') expanded = true;
      out.push({ region: region, title: title, headingToggle: headingToggle, expanded: expanded });
    }
    return out;
  }

  function findItemLinks(regionOrDoc) {
    if (!regionOrDoc || typeof regionOrDoc.querySelectorAll !== 'function') return [];
    let anchors = [];
    try { anchors = Array.prototype.slice.call(regionOrDoc.querySelectorAll('a[href*="/learn/"]')); } catch (_) {}
    return anchors.filter(function (a) { return !isExcludedNode(a); });
  }

  // In-body progression control, e.g. role=button "Go to next item". Substring +
  // aria-first so localized labels still match. Excludes chat/extension nodes.
  const NEXT_ITEM_SUBSTR_RE = /(go\s+to\s+next\s+item|next\s+item)/i;

  function findNextItemButton(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    let els = [];
    try { els = Array.prototype.slice.call(doc.querySelectorAll('button, a, [role="button"]')); } catch (_) {}
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (isExcludedNode(el)) continue;
      const aria = el.getAttribute && el.getAttribute('aria-label');
      if (aria && NEXT_ITEM_SUBSTR_RE.test(aria)) return el;
      if (NEXT_ITEM_SUBSTR_RE.test(normText(el.textContent))) return el;
    }
    return null;
  }

  const LAUNCH_NAME_RE = /^\s*launch\s+app\s*$/i;

  // True iff the page is an external-tool launch (no in-page answer inputs):
  // either the URL kind is gradedLti, OR a role=form named "Launch App"/"Launch app"
  // exists. Branches on URL kind + launch-form shape, never on heuristicPageType.
  function isExternalLaunchPage(doc, url) {
    if (url && classifyKind(url) === 'gradedLti') return true;
    if (!doc || typeof doc.querySelectorAll !== 'function') return false;
    let forms = [];
    try { forms = Array.prototype.slice.call(doc.querySelectorAll('form, [role="form"]')); } catch (_) {}
    for (let i = 0; i < forms.length; i++) {
      const f = forms[i];
      if (isExcludedNode(f)) continue;
      const name = (f.getAttribute && f.getAttribute('aria-label')) || accessibleNameOf(f);
      if (LAUNCH_NAME_RE.test(normText(name))) return true;
    }
    return false;
  }

  const api = {
    parseLearnUrl: parseLearnUrl,
    classifyKind: classifyKind,
    parseItemAccessibleName: parseItemAccessibleName,
    itemStatus: itemStatus,
    isExcludedNode: isExcludedNode,
    assessmentRoot: assessmentRoot,
    withinAssessment: withinAssessment,
    findOutlineNav: findOutlineNav,
    findModuleRegions: findModuleRegions,
    findItemLinks: findItemLinks,
    findNextItemButton: findNextItemButton,
    isExternalLaunchPage: isExternalLaunchPage,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.courseraDom = api;
  }
})(typeof self !== 'undefined' ? self : this);
