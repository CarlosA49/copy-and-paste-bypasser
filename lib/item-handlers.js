// lib/item-handlers.js
// Per-kind item handlers for the module autopilot.
// Pure logic with dependency-injected sleep/scroll/typing.
(function (root) {
  'use strict';

  function cancellableSleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      const t = setTimeout(function () { resolve(); }, ms);
      if (signal) {
        const onAbort = function () { clearTimeout(t); reject(new Error('aborted')); };
        if (signal.aborted) { clearTimeout(t); reject(new Error('aborted')); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  const READING_SELECTORS = [
    '[data-testid="reading"]',
    '.rc-Reading',
    'article',
    'main',
  ];

  const MARK_COMPLETE_SELECTORS = [
    'button[aria-label*="mark as completed" i]',
    'button[aria-label*="completed" i]',
    'button[data-testid*="mark" i][data-testid*="complete" i]',
  ];

  const REPLY_INPUT_SELECTORS = [
    '[data-testid="reply-input"]',
    '[data-role="discussion-reply"]',
    'textarea[name*="reply" i]',
    'div[contenteditable="true"]',
  ];

  const REPLY_SUBMIT_SELECTORS = [
    '[data-testid="submit-reply"]',
    'button[type="submit"]',
    'button[aria-label*="reply" i]',
  ];

  function tryMarkCompleteFallback(doc) {
    if (!doc || typeof doc.querySelector !== 'function') return false;
    for (let i = 0; i < MARK_COMPLETE_SELECTORS.length; i++) {
      const btn = doc.querySelector(MARK_COMPLETE_SELECTORS[i]);
      if (btn) {
        try { btn.click(); } catch (_) { return false; }
        return true;
      }
    }
    return false;
  }

  function firstMatching(doc, selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const el = doc.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function defaultJitteredScroll(container, opts) {
    // No-op scroller used as a fallback. The autopilot controller injects a real one.
    return Promise.resolve();
  }

  function createHandlers(deps) {
    const sleep = (deps && deps.sleep) || cancellableSleep;
    const jitteredScroll = (deps && deps.jitteredScroll) || defaultJitteredScroll;
    const timing = deps && deps.timing;
    const replies = deps && deps.replies;
    const typingEngine = deps && deps.typingEngine;
    const typingInjector = deps && deps.typingInjector;
    const pageFallback = (deps && deps.pageFallback) || null;

    async function reading(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const totalMs = timing.readingDwellMs(rng);
      const container = firstMatching(doc, READING_SELECTORS) || doc.body;
      await jitteredScroll(container, { totalMs: totalMs, rng: rng, signal: signal });
      const btn = firstMatching(doc, MARK_COMPLETE_SELECTORS);
      if (btn) {
        try { btn.click(); } catch (_) { /* ignore */ }
        return { outcome: 'reading-done' };
      }
      return { outcome: 'reading-auto' };
    }

    async function discussion(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const history = Array.isArray(ctx.replyHistory) ? ctx.replyHistory : [];
      const totalMs = timing.discussionDwellMs(rng);
      const threadEl = doc.querySelector('[data-testid="discussion-thread"]') || doc.body;
      await jitteredScroll(threadEl, { totalMs: totalMs, rng: rng, signal: signal });
      const replyEl = firstMatching(doc, REPLY_INPUT_SELECTORS);
      if (!replyEl) {
        return { outcome: 'discussion-skipped-no-input' };
      }
      const text = replies.pickReply(history, rng);
      await new Promise(function (resolve, reject) {
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
            target: replyEl,
            profile: 'Balanced Natural',
            speed: 'Normal',
            simulateTypos: false,
            onTick: function (ev) { typingInjector.insertOrBackspace(replyEl, ev); },
            onDone: function () {
              if (settled) return;
              settled = true;
              detach();
              resolve();
            },
          });
        } else {
          // Fallback: direct assignment.
          if ('value' in replyEl) replyEl.value = text;
          else replyEl.textContent = text;
          resolve();
        }
      });
      const submitBtn = firstMatching(doc, REPLY_SUBMIT_SELECTORS);
      if (submitBtn) {
        try { submitBtn.click(); } catch (_) { /* ignore */ }
      }
      return { outcome: 'discussion-posted', usedReply: text };
    }

    function waitForEvent(target, event, signal) {
      return new Promise(function (resolve, reject) {
        if (signal && signal.aborted) { reject(new Error('aborted')); return; }
        let settled = false;
        let onAbort = null;
        function onFire() {
          if (settled) return;
          settled = true;
          target.removeEventListener(event, onFire);
          if (onAbort && signal && signal.removeEventListener) {
            try { signal.removeEventListener('abort', onAbort); } catch (_) {}
          }
          resolve();
        }
        target.addEventListener(event, onFire);
        if (signal && signal.addEventListener) {
          onAbort = function () {
            if (settled) return;
            settled = true;
            target.removeEventListener(event, onFire);
            reject(new Error('aborted'));
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
    }

    async function video(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const behaviorMode = (ctx && ctx.behaviorMode) || 'fast';
      const v = doc.querySelector('video');
      if (!v) { return { outcome: 'video-no-element' }; }

      // -------- Fast mode --------
      if (behaviorMode === 'fast') {
        const t = timing.fastVideoTiming(v.duration, rng);
        // Best-effort play; ignore rejection (DRM/autoplay-block — handled by completion confirmer).
        try { const p = v.play(); if (p && typeof p.then === 'function') p.then(function () {}, function () {}); } catch (_) {}
        if (t.mode === 'fast-seek') {
          let seeked = false;
          try {
            v.currentTime = t.targetTimeSec;
            seeked = !isNaN(v.currentTime) && Math.abs((v.currentTime || 0) - t.targetTimeSec) < 5;
          } catch (_) { /* read-only */ }
          if (!seeked) {
            const fwd = doc.querySelector('button[aria-label*="Seek Video Forward" i], button[aria-label*="seek forward" i]');
            if (fwd) {
              let need = Math.max(0, Math.ceil((t.targetTimeSec - (v.currentTime || 0)) / 10));
              need = Math.min(need, 200);
              for (let i = 0; i < need; i++) {
                try { fwd.click(); } catch (_) {}
              }
            }
          }
        }
        // In Fast mode the controller will run the confirmer with a 5s primary timeout.
        // Wait the short post-seek window here so handlers don't return before the player flushes the 'completed' state.
        await sleep(t.postSeekWaitMs, signal);
        return { outcome: 'video-done-fast', mode: t.mode };
      }

      // -------- Human mode (existing behavior, unchanged) --------
      const t = timing.videoTiming(v.duration, rng);
      let playError = null;
      let playSettled = false;
      const playPromise = (function () {
        try {
          const p = v.play();
          if (p && typeof p.then === 'function') {
            return p.then(
              function () { playSettled = true; },
              function (e) { playSettled = true; playError = e; }
            );
          }
        } catch (e) { playSettled = true; playError = e; }
        playSettled = true;
        return Promise.resolve();
      })();
      if (t.mode === 'seek') {
        let seeked = false;
        try {
          v.currentTime = t.targetTimeSec;
          seeked = !isNaN(v.currentTime) && Math.abs((v.currentTime || 0) - t.targetTimeSec) < 5;
        } catch (_) { /* read-only in some envs */ }
        if (!seeked) {
          const fwd = doc.querySelector('button[aria-label*="Seek Video Forward" i], button[aria-label*="seek forward" i]');
          if (fwd) {
            // In fallback mode we drive close to the natural end (duration - 10s) rather than the
            // primary 50-70s-before-end seek target, so the video reaches `ended` quickly without
            // requiring a full ~minute of real playback after clicking the forward-seek button.
            const endTarget = Math.max(t.targetTimeSec, v.duration - 10);
            let need = Math.max(0, Math.ceil((endTarget - (v.currentTime || 0)) / 10));
            need = Math.min(need, 200);
            for (let i = 0; i < need; i++) {
              try { fwd.click(); } catch (_) {}
            }
          }
        }
      }
      const ended = waitForEvent(v, 'ended', signal);
      const playFailed = playPromise.then(function () {
        return playError ? Promise.reject(new Error('autoplay-blocked')) : new Promise(function () { /* never resolves */ });
      });
      try {
        await Promise.race([ended, playFailed]);
      } catch (e) {
        if (e && e.message === 'autoplay-blocked') {
          return { outcome: 'video-autoplay-blocked', mode: t.mode };
        }
        throw e;
      }
      await sleep(t.postEndMs, signal);
      return { outcome: 'video-done', mode: t.mode };
    }

    const SUBMIT_SELECTORS = [
      '[data-testid="submit"]',
      '[data-testid="quiz"] button[type="submit"]',
      'form[data-testid*="quiz" i] button[type="submit"]',
      '[class*="Quiz"] button[type="submit"]',
    ];

    async function fallback(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const getAnswerText = ctx.getAnswerText || function () { return ''; };
      const getLastCleanedCopy = ctx.getLastCleanedCopy || function () { return null; };
      const autoSubmit = !!ctx.autoSubmitQuizzes;
      const applier = deps && deps.answerApplier;
      if (!applier || typeof applier.applyAnswers !== 'function') {
        return { outcome: 'pause-needed-no-applier' };
      }
      const raw = (getAnswerText() || '').trim()
        || ((getLastCleanedCopy && getLastCleanedCopy()) || '').trim()
        || '';
      if (!raw) {
        return { outcome: 'pause-needed-no-answer' };
      }
      const summary = applier.applyAnswers(raw, doc.body, {}) || { selected: 0, filled: 0 };
      const did = (summary.selected || 0) + (summary.filled || 0);
      if (did === 0) {
        return { outcome: 'pause-needed-no-match' };
      }
      await sleep(timing.quizDwellMs(rng), signal);
      if (!autoSubmit) {
        return { outcome: 'quiz-filled-paused-for-review' };
      }
      const submitBtn = firstMatching(doc, SUBMIT_SELECTORS);
      if (!submitBtn) {
        return { outcome: 'quiz-filled-no-submit-button' };
      }
      try { submitBtn.click(); } catch (_) { /* ignore */ }
      return { outcome: 'quiz-submitted' };
    }

    async function assignment(ctx) {
      const doc = ctx.doc;
      if (!pageFallback) return { outcome: 'assignment-no-action' };
      const cb = pageFallback.findAgreementCheckbox(doc);
      if (!cb) return { outcome: 'assignment-no-action' };
      if (!cb.checked) {
        try { cb.checked = true; } catch (_) {}
        try { cb.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true })); } catch (_) {}
        try { cb.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true })); } catch (_) {}
      }
      return { outcome: 'assignment-agreement-accepted-paused' };
    }

    return {
      reading: reading,
      discussion: discussion,
      video: video,
      fallback: fallback,
      assignment: assignment,
    };
  }

  const api = {
    createHandlers: createHandlers,
    cancellableSleep: cancellableSleep,
    tryMarkCompleteFallback: tryMarkCompleteFallback,
    _selectors: {
      reading: READING_SELECTORS,
      markComplete: MARK_COMPLETE_SELECTORS,
      replyInput: REPLY_INPUT_SELECTORS,
      replySubmit: REPLY_SUBMIT_SELECTORS,
    },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.itemHandlers = api;
  }
})(typeof self !== 'undefined' ? self : this);
