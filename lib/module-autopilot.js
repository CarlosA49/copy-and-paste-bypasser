// lib/module-autopilot.js
// Controller for the module autopilot. Owns the run loop, navigation,
// heartbeat, and pause/resume triggers.
(function (root) {
  'use strict';

  function getStateMod() {
    if (typeof module !== 'undefined' && module.exports) {
      return require('./autopilot-state.js');
    }
    return (root.ClipboardCleaner && root.ClipboardCleaner.autopilotState) || null;
  }

  function getScraperMod() {
    if (typeof module !== 'undefined' && module.exports) {
      return require('./module-scraper.js');
    }
    return (root.ClipboardCleaner && root.ClipboardCleaner.moduleScraper) || null;
  }

  function generateTabKey() {
    return 'tab-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
  }

  const HEARTBEAT_INTERVAL_MS = 5000;

  function createAutopilot(opts) {
    opts = opts || {};
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    const win = opts.window || (typeof window !== 'undefined' ? window : null);
    const storage = opts.storage;
    const handlers = opts.handlers || {};
    const nowFn = opts.nowFn || function () { return Date.now(); };
    const tabKey = opts.tabKey || generateTabKey();
    const rng = opts.rng || Math.random;
    const navigate = opts.navigate || function (url) {
      let targetPath = url;
      try {
        const origin = (win && win.location && win.location.origin) || 'https://www.coursera.org';
        targetPath = new URL(url, origin).pathname;
      } catch (_) { /* fall back to raw url */ }
      const anchors = doc.querySelectorAll('a[href*="/learn/"]');
      let match = null;
      for (let i = 0; i < anchors.length; i++) {
        const href = anchors[i].getAttribute('href') || '';
        try {
          const aPath = new URL(href, (win && win.location && win.location.origin) || 'https://www.coursera.org').pathname;
          if (aPath === targetPath) { match = anchors[i]; break; }
        } catch (_) { /* skip malformed */ }
      }
      if (match) { match.click(); return Promise.resolve(); }
      if (win && win.location) { win.location.href = url; }
      return Promise.resolve();
    };
    const sidebar = opts.sidebar || {};

    const stateMod = opts.stateMod || getStateMod();
    const scraperMod = opts.scraperMod || getScraperMod();
    const state = stateMod.createState(storage);

    let heartbeatTimer = null;
    let destroyed = false;
    let abortController = null;
    let inFlight = null;

    function startHeartbeat() {
      stopHeartbeat();
      heartbeatTimer = setInterval(function () {
        state.refreshHeartbeat(tabKey, nowFn(), function () {});
      }, HEARTBEAT_INTERVAL_MS);
      // In Node (tests), unref so the interval doesn't keep the event loop alive.
      // Browser setInterval returns a number; no unref method — guard with typeof.
      if (heartbeatTimer && typeof heartbeatTimer.unref === 'function') {
        heartbeatTimer.unref();
      }
    }

    function stopHeartbeat() {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    }

    function makeSignal() {
      if (typeof AbortController === 'function') {
        abortController = new AbortController();
        return abortController.signal;
      }
      const listeners = [];
      abortController = {
        signal: {
          aborted: false,
          addEventListener: function (k, fn) { if (k === 'abort') listeners.push(fn); },
          removeEventListener: function () {},
        },
        abort: function () {
          abortController.signal.aborted = true;
          listeners.forEach(function (fn) { fn(); });
        },
      };
      return abortController.signal;
    }

    function currentUrl() {
      return (win && win.location && win.location.href) || '';
    }

    async function start() {
      if (destroyed) return;
      const scraped = scraperMod.scrapeModule(doc);
      if (!scraped.items || scraped.items.length === 0) {
        if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('No items found in this module.');
        return;
      }
      const queue = scraped.items.filter(function (it) { return !it.completed; });
      if (queue.length === 0) {
        if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Module already complete.');
        return;
      }
      const acq = await new Promise(function (resolve) { state.acquireOwnership(tabKey, nowFn(), resolve); });
      if (acq !== 'owner') {
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Another tab is running an autopilot.');
        return;
      }
      await new Promise(function (resolve) {
        state.update({
          status: 'running',
          courseId: scraped.courseId,
          moduleId: scraped.moduleId,
          queue: queue,
          cursor: 0,
          startedAt: nowFn(),
          itemStartedAt: nowFn(),
          ownerTabKey: tabKey,
          heartbeatAt: nowFn(),
        }, resolve);
      });
      startHeartbeat();
      if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(true);
      if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Running — item 1 of ' + queue.length);
      if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('▶ Started — ' + queue.length + ' items');
      await navigate(queue[0].url);
    }

    function handlerForKind(kind) {
      if (handlers[kind]) return handlers[kind];
      return handlers.fallback;
    }

    function runCurrentItem(stateNow) {
      if (inFlight) return inFlight;
      inFlight = (async function () {
        const item = stateNow.queue[stateNow.cursor];
        if (!item) return false;
        const handler = handlerForKind(item.kind);
      if (!handler) {
        await new Promise(function (resolve) { state.update({ status: 'paused', ownerTabKey: null }, resolve); });
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'No handler for kind: ' + item.kind);
        return false;
      }
      const signal = makeSignal();
      let outcome = null;
      try {
        const ctx = {
          doc: doc,
          item: item,
          rng: rng,
          signal: signal,
          replyHistory: stateNow.replyHistory || [],
          autoSubmitQuizzes: (stateNow.settings && stateNow.settings.autoSubmitQuizzes) || false,
          getAnswerText: function () { return (sidebar.getAnswerText && sidebar.getAnswerText()) || ''; },
          getLastCleanedCopy: function () { return (root.ClipboardCleaner && root.ClipboardCleaner.lastCleanedCopy) || null; },
        };
        outcome = await handler(ctx);
      } catch (e) {
        if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('✖ Handler error: ' + (e && e.message || 'unknown'));
        await new Promise(function (resolve) { state.update({ status: 'paused', ownerTabKey: null }, resolve); });
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Paused: handler error.');
        stopHeartbeat();
        return false;
      }
      if (outcome && /^pause-needed/.test(outcome.outcome)) {
        await new Promise(function (resolve) { state.update({ status: 'paused', ownerTabKey: null }, resolve); });
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Paused — needs your action.');
        stopHeartbeat();
        return false;
      }
      // If pause/stop fired during the handler and the signal was honored
      // after the handler had already resolved, bail before recording or
      // advancing the cursor. The pause() call already wrote status='paused'
      // and ownerTabKey=null; we just need to not navigate/skip.
      if (signal && signal.aborted) {
        if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('⏸ Paused before commit — cursor not advanced');
        return false;
      }
      if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('✓ ' + item.kind + ' "' + (item.title || item.id) + '"');
      if (stateNow.courseId) {
        await new Promise(function (resolve) {
          state.recordCourseItem(stateNow.courseId, item.id, item.kind, outcome.outcome, resolve);
        });
      }
      const nextCursor = stateNow.cursor + 1;
      const newReplyHistory = (outcome && outcome.usedReply)
        ? ((stateNow.replyHistory || []).concat([outcome.usedReply]).slice(-5))
        : (stateNow.replyHistory || []);
      const queueLen = stateNow.queue.length;
      if (nextCursor >= queueLen) {
        await new Promise(function (resolve) {
          state.update({
            status: 'idle',
            cursor: nextCursor,
            replyHistory: newReplyHistory,
            ownerTabKey: null,
            queue: [],
            dwellEndsAt: null,
          }, resolve);
        });
        stopHeartbeat();
        if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Module complete.');
        if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('🏁 Module complete');
        if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(false);
        return true;
      }
      await new Promise(function (resolve) {
        state.update({
          cursor: nextCursor,
          replyHistory: newReplyHistory,
          itemStartedAt: nowFn(),
        }, resolve);
      });
      await navigate(stateNow.queue[nextCursor].url);
      return true;
      })().finally(function () { inFlight = null; });
      return inFlight;
    }

    async function bootIfRunning() {
      if (destroyed) return false;
      const cur = await new Promise(function (resolve) { state.load(resolve); });
      if (cur.status !== 'running') return false;
      const url = currentUrl();
      const scraperUrlCourseId = scraperMod.extractCourseId(url);
      if (cur.courseId && scraperUrlCourseId && cur.courseId !== scraperUrlCourseId) {
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Autopilot is running on a different course.');
        return false;
      }
      const acq = await new Promise(function (resolve) { state.acquireOwnership(tabKey, nowFn(), resolve); });
      if (acq !== 'owner') {
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, "Another tab is running this course's autopilot.");
        return false;
      }
      startHeartbeat();
      const stateNow = await new Promise(function (resolve) { state.load(resolve); });
      const currentItemId = scraperMod.extractItemId(url);
      let cursor = stateNow.cursor;
      if (currentItemId) {
        const idx = stateNow.queue.findIndex(function (it) { return it.id === currentItemId; });
        if (idx === -1) {
          await new Promise(function (resolve) { state.update({ status: 'paused', ownerTabKey: null }, resolve); });
          stopHeartbeat();
          if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Off-queue — Resume to continue.');
          return false;
        }
        if (idx > stateNow.cursor) {
          cursor = idx;
          await new Promise(function (resolve) { state.update({ cursor: cursor }, resolve); });
        }
      }
      const reloaded = await new Promise(function (resolve) { state.load(resolve); });
      if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(true);
      return await runCurrentItem(reloaded);
    }

    async function pause(reason) {
      if (abortController && abortController.abort) abortController.abort();
      await new Promise(function (resolve) { state.update({ status: 'paused', ownerTabKey: null }, resolve); });
      stopHeartbeat();
      if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, reason || 'Paused.');
      if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(false);
    }

    async function resume() {
      const cur = await new Promise(function (resolve) { state.load(resolve); });
      if (cur.status !== 'paused' || !cur.queue || cur.queue.length === 0) return;
      const url = currentUrl();
      const urlCourse = scraperMod.extractCourseId(url);
      if (cur.courseId && urlCourse && cur.courseId !== urlCourse) {
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Navigate back to course ' + cur.courseId + ' to resume.');
        return;
      }
      const acq = await new Promise(function (resolve) { state.acquireOwnership(tabKey, nowFn(), resolve); });
      if (acq !== 'owner') {
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Another tab owns this run.');
        return;
      }
      await new Promise(function (resolve) { state.update({ status: 'running', ownerTabKey: tabKey, heartbeatAt: nowFn() }, resolve); });
      startHeartbeat();
      if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(false, '');
      const stateNow = await new Promise(function (resolve) { state.load(resolve); });
      await runCurrentItem(stateNow);
    }

    async function stop() {
      if (abortController && abortController.abort) abortController.abort();
      stopHeartbeat();
      await new Promise(function (resolve) { state.clear(resolve); });
      if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Idle.');
      if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(false);
      if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(false, '');
    }

    function destroy() {
      destroyed = true;
      if (abortController && abortController.abort) abortController.abort();
      stopHeartbeat();
    }

    return {
      start: start,
      stop: stop,
      pause: pause,
      resume: resume,
      bootIfRunning: bootIfRunning,
      destroy: destroy,
      _tabKey: tabKey,
    };
  }

  const api = {
    createAutopilot: createAutopilot,
    generateTabKey: generateTabKey,
    HEARTBEAT_INTERVAL_MS: HEARTBEAT_INTERVAL_MS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.moduleAutopilot = api;
  }
})(typeof self !== 'undefined' ? self : this);
