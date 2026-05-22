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
          const engine = new typingEngine.TypingEngine();
          engine.start({
            text: text,
            target: replyEl,
            profile: 'Balanced Natural',
            speed: 'Normal',
            simulateTypos: false,
            onTick: function (ev) { typingInjector.insertOrBackspace(replyEl, ev); },
            onDone: function () { resolve(); },
          });
          if (signal && signal.addEventListener) {
            signal.addEventListener('abort', function () { try { engine.stop(); } catch (_) {} reject(new Error('aborted')); }, { once: true });
          }
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

    return {
      reading: reading,
      discussion: discussion,
    };
  }

  const api = {
    createHandlers: createHandlers,
    cancellableSleep: cancellableSleep,
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
