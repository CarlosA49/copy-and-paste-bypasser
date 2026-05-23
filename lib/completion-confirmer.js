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

    async function waitForCompletion(opts) {
      opts = opts || {};
      const doc = opts.doc;
      const itemId = opts.itemId;
      const scraper = opts.scraper;
      const signal = opts.signal;
      const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
      const pollIntervalMs = (typeof opts.pollIntervalMs === 'number' && opts.pollIntervalMs > 0) ? opts.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS;
      if (!scraper || typeof scraper.findItemCompletionIndicator !== 'function') return false;
      const start = nowFn();
      while (true) {
        if (signal && signal.aborted) throw new Error('aborted');
        const found = scraper.findItemCompletionIndicator(doc, itemId);
        if (found) return true;
        const elapsed = nowFn() - start;
        if (elapsed >= timeoutMs) return false;
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
