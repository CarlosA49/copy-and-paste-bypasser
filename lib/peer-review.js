// lib/peer-review.js
// Peer-review auto-complete handler + pure rubric/comment/submit detection.
// All DOM access is scoped via an injected coursera-dom (Phase A) and excludes
// the extension's own sidebar + the Boost support chat. Auto-submit is the
// deliberate exception to the fill-and-pause rule (per spec WS-D).
(function (root) {
  'use strict';

  // --- exclusion helpers --------------------------------------------------

  // Hardcoded last-resort exclusion used only when coursera-dom is absent.
  function fallbackIsExcluded(el) {
    if (!el || el.nodeType !== 1) return false;
    let node = el;
    while (node && node.nodeType === 1) {
      const id = (node.id || '').toLowerCase();
      const cls = (typeof node.className === 'string' ? node.className : '').toLowerCase();
      if (id === 'ccp-host' || id === 'ccp-host-root') return true;
      if (id === 'boostai-chat-panel-composer') return true;
      if (cls.indexOf('boost-chatpanel') !== -1) return true;
      const name = (node.getAttribute && (node.getAttribute('name') || '')) || '';
      if (name.toLowerCase() === 'ccp-behavior') return true;
      node = node.parentElement;
    }
    return false;
  }

  // --- numeric point parsing ---------------------------------------------

  // Parse a numeric point value from option text/aria. Matches "2 points",
  // "1 point", "3 pts", "5 marks". Returns a finite number or null.
  function parsePoints(text) {
    if (!text) return null;
    const m = String(text).match(/(-?\d+(?:\.\d+)?)\s*(?:points?|pts?|marks?)\b/i);
    if (m) {
      const n = parseFloat(m[1]);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  // --- rubric detection ---------------------------------------------------

  function optionText(el) {
    const aria = (el.getAttribute && (el.getAttribute('aria-label') || '')) || '';
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return (aria + ' ' + txt).trim();
  }

  // A criterion = a radiogroup (role=radiogroup or a fieldset of radios) whose
  // options are the contained radio inputs / labelled cds- options.
  function detectCriteria(rootEl, excludeFn) {
    const exclude = (typeof excludeFn === 'function') ? excludeFn : function () { return false; };
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return [];
    const groups = [];
    const seen = new Set();
    const groupEls = rootEl.querySelectorAll('[role="radiogroup"], fieldset');
    for (let i = 0; i < groupEls.length; i++) {
      const g = groupEls[i];
      if (exclude(g)) continue;
      const radios = g.querySelectorAll('input[type="radio"], [role="radio"]');
      if (radios.length < 2) continue; // not a scoring criterion
      if (seen.has(g)) continue;
      seen.add(g);
      const options = [];
      for (let r = 0; r < radios.length; r++) {
        const radio = radios[r];
        if (exclude(radio)) continue;
        // The clickable target is the label wrapper if present, else the input.
        const label = radio.closest ? (radio.closest('label') || radio) : radio;
        const text = optionText(label);
        options.push({ input: radio, control: label, text: text, points: parsePoints(text) });
      }
      if (options.length < 2) continue;
      const label = (g.getAttribute && (g.getAttribute('aria-label') || '')) || '';
      groups.push({ element: g, label: label, options: options });
    }
    return groups;
  }

  // Select the highest-scoring option. If no option has parseable points, fall
  // back to the LAST option (Coursera usually orders best last) and flag it.
  function selectHighestOption(criterion) {
    const opts = (criterion && criterion.options) || [];
    if (opts.length === 0) return { option: null, points: null, lowConfidence: true };
    let best = null;
    let bestPoints = -Infinity;
    for (let i = 0; i < opts.length; i++) {
      const p = opts[i].points;
      if (typeof p === 'number' && Number.isFinite(p) && p > bestPoints) {
        bestPoints = p;
        best = opts[i];
      }
    }
    if (best) {
      return { option: best, points: bestPoints, lowConfidence: false };
    }
    return { option: opts[opts.length - 1], points: null, lowConfidence: true };
  }

  // --- comment + submit detection ----------------------------------------

  function findRequiredCommentBoxes(rootEl, excludeFn) {
    const exclude = (typeof excludeFn === 'function') ? excludeFn : function () { return false; };
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return [];
    const boxes = [];
    const candidates = rootEl.querySelectorAll(
      'textarea[required], textarea[aria-required="true"], textarea[data-required="true"], ' +
      'div[contenteditable="true"][aria-required="true"]');
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (exclude(el)) continue;
      boxes.push(el);
    }
    return boxes;
  }

  const SUBMIT_TEXT_RE = /\b(submit|submit review|done|finish|complete review)\b/i;

  function findSubmitControl(rootEl, excludeFn) {
    const exclude = (typeof excludeFn === 'function') ? excludeFn : function () { return false; };
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return null;
    const buttons = rootEl.querySelectorAll(
      'button, [role="button"], input[type="submit"], [class*="cds-button"]');
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      if (exclude(b)) continue;
      const aria = (b.getAttribute && (b.getAttribute('aria-label') || '')) || '';
      const txt = (b.textContent || '');
      if (SUBMIT_TEXT_RE.test(aria) || SUBMIT_TEXT_RE.test(txt)) return b;
    }
    return null;
  }

  // --- handler factory ----------------------------------------------------

  function createPeerReviewHandler(deps) {
    const d = deps || {};
    const sleep = (typeof d.sleep === 'function') ? d.sleep : function () { return Promise.resolve(); };
    const timing = d.timing || null;
    const replies = d.replies || null;
    const typingEngine = d.typingEngine || null;
    const typingInjector = d.typingInjector || null;
    const debugRecorder = d.debugRecorder || null;

    function rec(type, details) {
      if (!debugRecorder || typeof debugRecorder.record !== 'function') return;
      try { debugRecorder.record(type, details); } catch (_) {}
    }

    // Resolve coursera-dom: injected dep > runtime global > require fallback.
    function resolveCourseraDom() {
      if (d.courseraDom) return d.courseraDom;
      if (root.ClipboardCleaner && root.ClipboardCleaner.courseraDom) return root.ClipboardCleaner.courseraDom;
      if (typeof require !== 'undefined') {
        try { return require('./coursera-dom.js'); } catch (_) { /* not present yet */ }
      }
      return null;
    }

    // Type one value into a comment box via TypingEngine (Fast speed in fast
    // mode, Normal in human mode); falls back to direct assignment if no engine.
    function fillComment(el, text, mode, signal) {
      return new Promise(function (resolve, reject) {
        if (typingEngine && typingEngine.TypingEngine && typingInjector) {
          let settled = false;
          let onAbort = null;
          const engine = new typingEngine.TypingEngine();
          function detach() {
            if (onAbort && signal && signal.removeEventListener) {
              try { signal.removeEventListener('abort', onAbort); } catch (_) {}
            }
          }
          if (signal && signal.addEventListener) {
            onAbort = function () {
              if (settled) return;
              settled = true;
              try { engine.stop(); } catch (_) {}
              detach();
              reject(new Error('aborted'));
            };
            if (signal.aborted) { onAbort(); return; }
            signal.addEventListener('abort', onAbort, { once: true });
          }
          engine.start({
            text: text,
            target: el,
            profile: 'Balanced Natural',
            speed: mode === 'fast' ? 'Fast' : 'Normal',
            simulateTypos: false,
            onTick: function (ev) { typingInjector.insertOrBackspace(el, ev); },
            onDone: function () {
              if (settled) return;
              settled = true;
              detach();
              resolve();
            },
          });
        } else {
          if ('value' in el) el.value = text;
          else el.textContent = text;
          try {
            const win = (el.ownerDocument && el.ownerDocument.defaultView) || null;
            if (win) {
              el.dispatchEvent(new win.Event('input', { bubbles: true }));
              el.dispatchEvent(new win.Event('change', { bubbles: true }));
            }
          } catch (_) {}
          resolve();
        }
      });
    }

    function detectMinLength(el) {
      const attr = el && el.getAttribute && el.getAttribute('minlength');
      const n = attr ? parseInt(attr, 10) : NaN;
      return Number.isFinite(n) && n > 0 ? n : 0;
    }

    return async function peerReview(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const mode = ctx.behaviorMode === 'human' ? 'human' : 'fast';
      const autoSubmit = !!ctx.autoSubmitQuizzes;
      const cdom = resolveCourseraDom();

      const scopeRoot = (cdom && typeof cdom.assessmentRoot === 'function' && cdom.assessmentRoot(doc))
        || (doc && doc.body) || null;
      const excludeFn = (cdom && typeof cdom.isExcludedNode === 'function')
        ? function (el) { return cdom.isExcludedNode(el); }
        : fallbackIsExcluded;

      if (!scopeRoot) {
        rec('peerReview.noRoot', {});
        return { outcome: 'peer-review-needs-user' };
      }

      const criteria = detectCriteria(scopeRoot, excludeFn);
      if (criteria.length === 0) {
        rec('peerReview.noCriteria', {});
        return { outcome: 'peer-review-needs-user' };
      }

      // Locate the submit control up-front: if there is none we must NOT make
      // any changes-then-fail-to-submit; pause for the user instead.
      const submitBtn = findSubmitControl(scopeRoot, excludeFn);
      if (!submitBtn) {
        rec('peerReview.noSubmit', {});
        return { outcome: 'peer-review-needs-user' };
      }

      // 1) Select the highest option per criterion.
      const selections = [];
      for (let i = 0; i < criteria.length; i++) {
        if (signal && signal.aborted) throw new Error('aborted');
        const choice = selectHighestOption(criteria[i]);
        if (choice.option && choice.option.control) {
          try { choice.option.control.click(); } catch (_) {}
          // Ensure the underlying radio reflects the choice even if click is faked.
          try {
            if (choice.option.input && 'checked' in choice.option.input) {
              choice.option.input.checked = true;
            }
          } catch (_) {}
        }
        selections.push({
          label: criteria[i].label,
          points: choice.points,
          lowConfidence: choice.lowConfidence,
          text: choice.option ? choice.option.text : '',
        });
        rec('peerReview.criterion.selected', {
          label: criteria[i].label, points: choice.points, lowConfidence: choice.lowConfidence,
        });
        if (mode === 'human' && timing && i < criteria.length - 1) {
          await sleep(timing.peerInterCriterionMs(rng), signal);
        }
      }

      // 2) Fill every required comment box, drawing from the pool with history.
      const boxes = findRequiredCommentBoxes(scopeRoot, excludeFn);
      const history = Array.isArray(ctx.replyHistory) ? ctx.replyHistory.slice() : [];
      const usedComments = [];
      for (let i = 0; i < boxes.length; i++) {
        if (signal && signal.aborted) throw new Error('aborted');
        const minLen = detectMinLength(boxes[i]);
        const comment = replies
          ? replies.pickComment(history.concat(usedComments), minLen, rng)
          : '';
        await fillComment(boxes[i], comment, mode, signal);
        usedComments.push(comment);
        rec('peerReview.comment.filled', { length: comment.length });
        if (mode === 'human' && timing && i < boxes.length - 1) {
          await sleep(timing.peerInterFieldMs(rng), signal);
        }
      }

      // 3) Pre-submit pause (human only) — only when we're actually submitting.
      //    autoSubmit off → fill-and-pause for the user to review + submit.
      if (mode === 'human' && timing && autoSubmit) {
        await sleep(timing.peerPreSubmitMs(rng), signal);
      }
      if (signal && signal.aborted) throw new Error('aborted');
      if (!autoSubmit) {
        rec('peerReview.filledPaused', { criteria: selections.length, comments: usedComments.length });
        return { outcome: 'peer-review-filled-paused', selections: selections, usedComments: usedComments };
      }
      try { submitBtn.click(); } catch (_) { /* ignore */ }
      rec('peerReview.submitted', { criteria: selections.length, comments: usedComments.length });

      return {
        outcome: 'peer-review-submitted',
        selections: selections,
        usedComments: usedComments,
      };
    };
  }

  const api = {
    detectCriteria: detectCriteria,
    selectHighestOption: selectHighestOption,
    findRequiredCommentBoxes: findRequiredCommentBoxes,
    findSubmitControl: findSubmitControl,
    parsePoints: parsePoints,
    fallbackIsExcluded: fallbackIsExcluded,
    createPeerReviewHandler: createPeerReviewHandler,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.peerReview = api;
  }
})(typeof self !== 'undefined' ? self : this);
