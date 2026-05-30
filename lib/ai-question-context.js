(function (root) {
  'use strict';

  function req(name, browserName) {
    if (typeof module !== 'undefined' && module.exports) return require(name);
    return root.ClipboardCleaner && root.ClipboardCleaner[browserName];
  }
  const moduleScraper    = req('./module-scraper.js',    'moduleScraper');
  const questionDetector = req('./question-detector.js', 'questionDetector');

  const courseraDom = (function () {
    try { return req('./coursera-dom.js', 'courseraDom'); } catch (_) { return null; }
  })();

  function ccpExcludes(el) {
    return !!(courseraDom && typeof courseraDom.isExcludedNode === 'function' && courseraDom.isExcludedNode(el));
  }

  // Types the AI can answer in-page. code/file_upload are deliberately EXCLUDED:
  // code is best-effort handled in the handler (still pauses), file_upload always
  // pauses, so neither is sent to the model as an actionable answer slot.
  var SUPPORTED_TYPES = {
    single_choice: true, multiple_choice: true, math_input: true,
    numerical: true, input: true, dropdown: true, free_text: true,
  };

  var VISIBLE_BLOCK_PATTERNS = [
    { re: /\bgraded\s+app\s+item\b/i,    reason: 'graded app item' },
    { re: /\bgraded\s+assignment\b/i,    reason: 'graded assignment' },
    { re: /\bgraded\s+quiz\b/i,          reason: 'graded quiz' },
    { re: /\bprogramming\s+assignment\b/i, reason: 'programming assignment' },
    { re: /\bpeer\s+review\b/i,          reason: 'peer review' },
    { re: /\bassignment\s+submission\b/i, reason: 'assignment submission' },
    { re: /\bexam\b/i,                   reason: 'exam' },
    { re: /\bdiscussion\s+prompt\b/i,    reason: 'discussion prompt' },
  ];

  function findCurrentActivityEvidenceRoot(doc, location) {
    if (!doc || !doc.body) return null;
    var hostEl = doc.getElementById && doc.getElementById('ccp-host-root');

    function isUnderExcluded(el) {
      if (!el) return true;
      if (ccpExcludes(el)) return true;
      var cur = el;
      while (cur && cur !== doc.body) {
        if (cur === hostEl) return true;
        // Tag-based exclusions
        var tag = (cur.tagName || '').toUpperCase();
        if (tag === 'ASIDE' || tag === 'NAV') return true;
        // Role-based exclusions
        var role = cur.getAttribute && cur.getAttribute('role');
        if (role === 'navigation' || role === 'complementary' || role === 'banner') return true;
        // Class-name patterns indicating chrome/navigation rather than current activity content
        var cls = (cur.className || '');
        if (typeof cls === 'string' && /\b(sidebar|drawer|outline|course-outline|nav|module-list|toc)\b/i.test(cls)) return true;
        cur = cur.parentNode;
      }
      return false;
    }

    // Priority 1: question-bearing region. If detectQuestions found at least one
    // question container, walk up from that container until we hit body or an
    // excluded ancestor, yielding the highest non-excluded ancestor as the root.
    var detected = (questionDetector && questionDetector.detectQuestions)
      ? questionDetector.detectQuestions(doc.body) : [];
    for (var i = 0; i < detected.length; i++) {
      var c = detected[i] && detected[i].container;
      if (!c || isUnderExcluded(c)) continue;
      // Walk up to find the highest non-excluded ancestor (stopping at body).
      var best = c;
      var up = c.parentNode;
      while (up && up !== doc.body) {
        if (!isUnderExcluded(up)) { best = up; }
        up = up.parentNode;
      }
      return best;
    }

    // Priority 2: first <main> or [role="main"] that is not itself under an exclusion.
    var mainCandidates = [];
    try { mainCandidates = mainCandidates.concat(Array.prototype.slice.call(doc.querySelectorAll('main'))); } catch (_) {}
    try { mainCandidates = mainCandidates.concat(Array.prototype.slice.call(doc.querySelectorAll('[role="main"]'))); } catch (_) {}
    for (var j = 0; j < mainCandidates.length; j++) {
      if (mainCandidates[j] && !isUnderExcluded(mainCandidates[j])) return mainCandidates[j];
    }

    // Priority 3: assessment-specific Coursera containers
    var asmt = [];
    try { asmt = asmt.concat(Array.prototype.slice.call(doc.querySelectorAll('[class*="rc-Assignment"], [class*="rc-Quiz"], [class*="rc-PeerReview"], [data-testid*="content"]'))); } catch (_) {}
    for (var k = 0; k < asmt.length; k++) {
      if (asmt[k] && !isUnderExcluded(asmt[k])) return asmt[k];
    }

    // No reliable current-activity anchor found.
    return null;
  }

  function _visibleBlockedReason(doc, location) {
    var root = findCurrentActivityEvidenceRoot(doc, location);
    if (!root) return null;   // No anchor — fall back to URL/title (the only signal we trust)
    var hostEl = doc.getElementById && doc.getElementById('ccp-host-root');
    function isUnderExcluded(el) {
      if (!el) return true;
      if (ccpExcludes(el)) return true;
      var cur = el;
      while (cur && cur !== doc.body) {
        if (cur === hostEl) return true;
        var tag = (cur.tagName || '').toUpperCase();
        if (tag === 'ASIDE' || tag === 'NAV') return true;
        var role = cur.getAttribute && cur.getAttribute('role');
        if (role === 'navigation' || role === 'complementary' || role === 'banner') return true;
        var cls = (cur.className || '');
        if (typeof cls === 'string' && /\b(sidebar|drawer|outline|course-outline|nav|module-list|toc)\b/i.test(cls)) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    var maxLen = 8000;
    var seen = '';
    // Tree-walk variant to honor inner-aside exclusion:
    function visit(el) {
      if (!el || seen.length >= maxLen) return;
      if (el.nodeType === 1) { // Element
        if (isUnderExcluded(el)) return;
        // Skip script/style nodes entirely
        var t = (el.tagName || '').toUpperCase();
        if (t === 'SCRIPT' || t === 'STYLE') return;
        var children = el.childNodes || [];
        for (var i = 0; i < children.length; i++) visit(children[i]);
      } else if (el.nodeType === 3) { // Text
        seen += (el.nodeValue || '') + ' ';
      }
    }
    visit(root);
    seen = seen.replace(/\s+/g, ' ').trim();
    if (seen.length > maxLen) seen = seen.slice(0, maxLen);
    for (var p = 0; p < VISIBLE_BLOCK_PATTERNS.length; p++) {
      if (VISIBLE_BLOCK_PATTERNS[p].re.test(seen)) return VISIBLE_BLOCK_PATTERNS[p].reason;
    }
    return null;
  }

  function djb2(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = (((h << 5) + h) + str.charCodeAt(i)) >>> 0;
    return h.toString(16);
  }

  function blockReasonFor(url, title) {
    var u = url || '';
    var t = title || '';
    if (/\/gradedLti\//i.test(u)) return 'graded item';
    if (/\/peer\//i.test(u) || /\bpeer\b/i.test(t) || /\breview your peers\b/i.test(t)) return 'peer review';
    if (/\/programming\//i.test(u)) return 'programming assignment';
    if (/\/exam\//i.test(u) || /\bexam\b/i.test(t)) return 'exam';
    if (/\/quiz\//i.test(u) || /\bquiz\b/i.test(t)) return 'quiz';
    if (/\/discussion(Prompt)?\//i.test(u) || /\bdiscussion prompt\b/i.test(t)) return 'discussion prompt';
    if (/\/assignment-submission\//i.test(u) || /\bassignment\b/i.test(t) || /\bgraded\b/i.test(t)) return 'graded assignment';
    return 'blocked';
  }

  function isCurrentPageBlocked(location, doc) {
    var url = (location && location.href) || '';
    var title = (doc && doc.title) || '';
    var item = { url: url, title: title };
    if (moduleScraper && moduleScraper.isBlockedAssessmentItem && moduleScraper.isBlockedAssessmentItem(item)) {
      return { blocked: true, reason: blockReasonFor(url, title) };
    }
    var visible = _visibleBlockedReason(doc, location);
    if (visible) return { blocked: true, reason: visible + ' (visible)' };
    return { blocked: false, reason: null };
  }

  function isAlreadyAnswered(q) {
    if (!q) return false;
    if (q.type === 'single_choice' || q.type === 'multiple_choice') {
      for (var i = 0; i < (q.choices || []).length; i++) {
        var inp = q.choices[i].el;
        if (inp && (inp.checked === true)) return true;
      }
      return false;
    }
    if (q.type === 'math_input') {
      for (var j = 0; j < (q.targets || []).length; j++) {
        var t = q.targets[j];
        if (!t) continue;
        if (typeof t.value === 'string' && t.value.trim() !== '') return true;
        var ce = t.getAttribute && t.getAttribute('contenteditable');
        if (ce && t.textContent && t.textContent.trim() !== '') return true;
      }
      return false;
    }
    return false;
  }

  function _buildLocalGuard(detected) {
    var guard = [];
    for (var i = 0; i < detected.length; i++) {
      var q = detected[i];
      if (q.type === 'single_choice' || q.type === 'multiple_choice') {
        var selectedIndices = [];
        var choices = q.choices || [];
        for (var ci = 0; ci < choices.length; ci++) {
          if (choices[ci].el && choices[ci].el.checked === true) {
            selectedIndices.push(ci);
          }
        }
        guard.push({ type: q.type, selectedIndices: selectedIndices });
      } else if (q.type === 'math_input') {
        var val = '';
        var targets = q.targets || [];
        if (targets.length > 0) {
          var t = targets[0];
          if (t) {
            if (typeof t.value === 'string') {
              val = t.value.trim();
            } else if (t.getAttribute && t.getAttribute('contenteditable')) {
              val = (t.textContent || '').trim();
            }
          }
        }
        if (val === '') {
          guard.push({ type: 'math_input', empty: true });
        } else {
          guard.push({ type: 'math_input', empty: false, fingerprint: djb2(val) });
        }
      } else {
        guard.push({ type: q.type });
      }
    }
    return guard;
  }

  function buildQuestionSnapshot(rootEl, location, doc) {
    var origin = (location && location.origin) || '';
    var detected = (questionDetector && questionDetector.detectQuestions)
      ? questionDetector.detectQuestions(rootEl) : [];

    var questions = [];
    for (var i = 0; i < detected.length; i++) {
      var q = detected[i];
      var id = 'q' + q.questionNumber;
      var supported = !!SUPPORTED_TYPES[q.type];
      var prompt = (q.fullText || q.titleText || '').toString().slice(0, 500);
      var entry = {
        id: id,
        order: i + 1,
        questionNumber: q.questionNumber,
        type: q.type,
        prompt: prompt,
        supported: supported,
        alreadyAnswered: isAlreadyAnswered(q),
      };
      if (q.type === 'single_choice' || q.type === 'multiple_choice') {
        entry.options = (q.choices || []).map(function (c, idx) {
          return { id: id + 'o' + idx, label: (c.text || '').toString().slice(0, 200) };
        });
      } else if (q.type === 'math_input') {
        entry.answerFormatHint = 'number-or-text';
      }
      questions.push(entry);
    }

    var supportedCount = 0, unsupportedCount = 0, actionableCount = 0;
    for (var k = 0; k < questions.length; k++) {
      if (questions[k].supported) {
        supportedCount++;
        if (!questions[k].alreadyAnswered) actionableCount++;
      } else {
        unsupportedCount++;
      }
    }

    var tokenSeed = JSON.stringify([
      (location && location.href) || '',
      questions.map(function (e) {
        return [e.questionNumber, e.type, e.prompt, (e.options || []).map(function (o) { return o.label; })];
      })
    ]);

    var localGuard = _buildLocalGuard(detected);

    return {
      token: 'snap_' + djb2(tokenSeed),
      page: {
        urlOrigin: origin,
        eligible: true,
        blockedReason: null,
      },
      questions: questions,
      supportedCount: supportedCount,
      unsupportedCount: unsupportedCount,
      actionableCount: actionableCount,
      localGuard: localGuard,
    };
  }

  function sanitizeForRequest(snapshot) {
    var clean = [];
    for (var i = 0; i < snapshot.questions.length; i++) {
      var q = snapshot.questions[i];
      if (!q.supported) continue;
      if (q.alreadyAnswered) continue;
      var out = {
        id: q.id,
        order: q.order,
        type: q.type,
        prompt: q.prompt,
      };
      if (q.options) out.options = q.options.map(function (o) { return { id: o.id, label: o.label }; });
      if (q.answerFormatHint) out.answerFormatHint = q.answerFormatHint;
      clean.push(out);
    }
    // NOTE: localGuard is intentionally NOT included — it must never leave the content-script process.
    return {
      page: { urlOrigin: snapshot.page.urlOrigin, eligible: snapshot.page.eligible },
      questions: clean,
      token: snapshot.token,
    };
  }

  function compareLocalGuards(oldSnap, newSnap, applicableQuestionNumbers) {
    var changed = false;
    var changedQuestions = [];
    var oldGuard = (oldSnap && oldSnap.localGuard) || [];
    var newGuard = (newSnap && newSnap.localGuard) || [];
    var oldQuestions = (oldSnap && oldSnap.questions) || [];
    var newQuestions = (newSnap && newSnap.questions) || [];

    for (var ai = 0; ai < applicableQuestionNumbers.length; ai++) {
      var qNum = applicableQuestionNumbers[ai];
      // Find index in questions array by questionNumber
      var oldIdx = -1;
      for (var oi = 0; oi < oldQuestions.length; oi++) {
        if (oldQuestions[oi].questionNumber === qNum) { oldIdx = oi; break; }
      }
      var newIdx = -1;
      for (var ni = 0; ni < newQuestions.length; ni++) {
        if (newQuestions[ni].questionNumber === qNum) { newIdx = ni; break; }
      }
      if (oldIdx === -1 || newIdx === -1) continue;

      var og = oldGuard[oldIdx];
      var ng = newGuard[newIdx];
      if (!og || !ng) {
        if (og !== ng) { changed = true; changedQuestions.push(qNum); }
        continue;
      }

      // Compare by type
      if (og.type !== ng.type) { changed = true; changedQuestions.push(qNum); continue; }

      if (og.type === 'single_choice' || og.type === 'multiple_choice') {
        var osi = (og.selectedIndices || []).slice().sort(function (a, b) { return a - b; });
        var nsi = (ng.selectedIndices || []).slice().sort(function (a, b) { return a - b; });
        if (JSON.stringify(osi) !== JSON.stringify(nsi)) {
          changed = true; changedQuestions.push(qNum);
        }
      } else if (og.type === 'math_input') {
        if (og.empty !== ng.empty || og.fingerprint !== ng.fingerprint) {
          changed = true; changedQuestions.push(qNum);
        }
      }
    }

    return { changed: changed, changedQuestions: changedQuestions };
  }

  const api = { isCurrentPageBlocked, buildQuestionSnapshot, sanitizeForRequest, compareLocalGuards, findCurrentActivityEvidenceRoot };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.aiQuestionContext = api;
  }
})(typeof self !== 'undefined' ? self : this);
