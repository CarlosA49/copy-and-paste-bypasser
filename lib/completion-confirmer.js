// lib/completion-confirmer.js
// Polls a scraper's findItemCompletionIndicator(doc, itemId) until the
// indicator appears or a timeout elapses. The "done" signal of record for
// the autopilot — handlers no longer self-report completion.
(function (root) {
  'use strict';

  const DEFAULT_TIMEOUT_MS = 45 * 1000;
  const DEFAULT_POLL_INTERVAL_MS = 1000;

  function createConfirmer(deps) {
    const sleep = (deps && deps.sleep) || function (ms, signal) {
      return new Promise(function (resolve, reject) {
        const t = setTimeout(resolve, ms);
        if (signal && signal.addEventListener) {
          signal.addEventListener('abort', function () { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
        }
      });
    };
    const nowFn = (deps && deps.nowFn) || function () { return Date.now(); };
    const debugRecorder = (deps && deps.debugRecorder) || null;
    function rec(type, details) {
      if (!debugRecorder || typeof debugRecorder.record !== 'function') return;
      try { debugRecorder.record(type, details); } catch (_) {}
    }

    async function waitForCompletion(opts) {
      opts = opts || {};
      const doc = opts.doc;
      const itemId = opts.itemId;
      const itemKind = opts.itemKind;
      const scraper = opts.scraper;
      const pageFallback = opts.pageFallback;
      const courseraDom = opts.courseraDom || null;
      const signal = opts.signal;
      const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
      const pollIntervalMs = (typeof opts.pollIntervalMs === 'number' && opts.pollIntervalMs > 0) ? opts.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
      rec('completion.wait.started', { itemId: itemId, itemKind: itemKind, timeoutMs: timeoutMs });
      if (!scraper || typeof scraper.findItemCompletionIndicator !== 'function') return false;
      const start = nowFn();
      let baselineProgress = null;
      if (pageFallback && typeof pageFallback.findTopProgressText === 'function') {
        const el = pageFallback.findTopProgressText(doc);
        if (el) baselineProgress = pageFallback.parseProgress(el.textContent);
      }
      while (true) {
        if (signal && signal.aborted) { rec('completion.aborted', { itemId: itemId }); throw new Error('aborted'); }
        if (scraper.findItemCompletionIndicator(doc, itemId)) {
          rec('completion.detected', { itemId: itemId, evidence: 'item-indicator' });
          return true;
        }
        if (typeof scraper.findGreenCompletionIconInRow === 'function' && scraper.findGreenCompletionIconInRow(doc, itemId)) {
          rec('completion.detected', { itemId: itemId, evidence: 'green-row-icon' });
          return true;
        }
        if (courseraDom && doc && typeof doc.querySelectorAll === 'function') {
          // Evidence: the item link's accessibleName status token reads 'completed'.
          let statusDone = false;
          try {
            const anchors = doc.querySelectorAll('a[href*="/learn/"]');
            for (let i = 0; i < anchors.length; i++) {
              const a = anchors[i];
              const parsed = courseraDom.parseLearnUrl(a.getAttribute('href') || '');
              if (parsed && parsed.id === itemId) {
                if (courseraDom.itemStatus(a) === 'completed') { statusDone = true; break; }
              }
            }
          } catch (_) {}
          if (statusDone) {
            rec('completion.detected', { itemId: itemId, evidence: 'accessible-status' });
            return true;
          }
          // Evidence: a nav progressbar reporting full completion (valuenow >= valuemax).
          let barDone = false;
          try {
            const bars = doc.querySelectorAll('[role="progressbar"]');
            for (let i = 0; i < bars.length; i++) {
              const b = bars[i];
              const now = parseFloat(b.getAttribute('aria-valuenow'));
              const max = parseFloat(b.getAttribute('aria-valuemax'));
              if (!isNaN(now) && !isNaN(max) && max > 0 && now >= max) { barDone = true; break; }
            }
          } catch (_) {}
          if (barDone) {
            rec('completion.detected', { itemId: itemId, evidence: 'nav-progressbar' });
            return true;
          }
        }
        if (itemKind === 'reading' && pageFallback
            && typeof pageFallback.findCompletedReadingIndicator === 'function'
            && pageFallback.findCompletedReadingIndicator(doc)) {
          rec('completion.detected', { itemId: itemId, evidence: 'reading-completed' });
          return true;
        }
        if ((itemKind === 'quiz' || itemKind === 'exam') && pageFallback
            && typeof pageFallback.findGradedResultsIndicator === 'function'
            && pageFallback.findGradedResultsIndicator(doc)) {
          rec('completion.detected', { itemId: itemId, evidence: 'graded-results' });
          return true;
        }
        if (baselineProgress && pageFallback) {
          const el = pageFallback.findTopProgressText(doc);
          if (el) {
            const cur = pageFallback.parseProgress(el.textContent);
            if (cur && cur.total === baselineProgress.total && cur.completed > baselineProgress.completed) {
              rec('completion.detected', { itemId: itemId, evidence: 'top-progress' });
              return true;
            }
          }
        }
        const elapsed = nowFn() - start;
        if (elapsed >= timeoutMs) {
          rec('completion.timeout', { itemId: itemId, itemKind: itemKind });
          return false;
        }
        await sleep(pollIntervalMs, signal);
      }
    }

    return { waitForCompletion: waitForCompletion };
  }

  const api = {
    createConfirmer: createConfirmer,
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    DEFAULT_POLL_INTERVAL_MS: DEFAULT_POLL_INTERVAL_MS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.completionConfirmer = api;
  }
})(typeof self !== 'undefined' ? self : this);
