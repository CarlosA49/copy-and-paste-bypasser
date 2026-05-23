// Runs after lib/cleaner.js, lib/html-cleaner.js, and lib/sidebar.js, which
// expose window.ClipboardCleaner.{cleanCopiedText, cleanSelectionHtml, sidebar, ...}.
(function () {
  'use strict';

  function api() { return (typeof window !== 'undefined' && window.ClipboardCleaner) || null; }

  function serializeRange(range) {
    const fragment = range.cloneContents();
    const tmp = document.createElement('div');
    tmp.appendChild(fragment);
    return tmp.innerHTML;
  }

  function onCopy(event) {
    const a = api();
    if (!a || typeof a.cleanCopiedText !== 'function') return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const selectedText = sel.toString();
    if (!selectedText) return;
    if (!event.clipboardData) return;

    let plainTextForSidebar = '';

    if (typeof a.cleanSelectionHtml === 'function') {
      try {
        const rawHtml = serializeRange(sel.getRangeAt(0));
        const { cleanHtml, cleanText } = a.cleanSelectionHtml(rawHtml);
        if (cleanText && cleanText.length > 0) {
          event.clipboardData.setData('text/html', cleanHtml);
          event.clipboardData.setData('text/plain', cleanText);
          event.preventDefault();
          plainTextForSidebar = cleanText;
        }
      } catch (e) {
        // fall through to plain-only
      }
    }

    if (!plainTextForSidebar) {
      const cleaned = a.cleanCopiedText(selectedText);
      event.clipboardData.setData('text/plain', cleaned);
      event.preventDefault();
      plainTextForSidebar = cleaned;
    }

    if (a.sidebar && typeof a.sidebar.showCopied === 'function') {
      try { a.sidebar.showCopied(plainTextForSidebar); } catch (_) { /* never block copy on UI error */ }
    }
  }

  function mountSidebarWhenReady() {
    const a = api();
    if (!a || !a.sidebar || typeof a.sidebar.mount !== 'function') return;
    try { a.sidebar.mount(); } catch (_) { /* don't crash the page on UI error */ }
  }

  let _autopilotInstance = null;

  function startAutopilot() {
    if (typeof window !== 'undefined' && window.top !== window) {
      // Only the top frame manages autopilot ownership.
      return;
    }
    const a = api();
    if (!a) { console.warn('[autopilot] disabled: window.ClipboardCleaner is missing'); return; }
    if (!a.moduleAutopilot || typeof a.moduleAutopilot.createAutopilot !== 'function') {
      console.warn('[autopilot] disabled: moduleAutopilot.createAutopilot not loaded');
      return;
    }
    if (!a.sidebar) { console.warn('[autopilot] disabled: sidebar API not loaded'); return; }
    if (!a.autopilotState) { console.warn('[autopilot] disabled: autopilotState not loaded'); return; }
    const storage = a.autopilotState.chromeStorageOrNull && a.autopilotState.chromeStorageOrNull();
    if (!storage) {
      console.warn('[autopilot] disabled: chrome.storage.local unavailable (missing "storage" permission?)');
      return;
    }
    if (!a.itemHandlers || typeof a.itemHandlers.createHandlers !== 'function') {
      console.warn('[autopilot] disabled: itemHandlers.createHandlers not loaded');
      return;
    }
    if (!a.completionConfirmer || typeof a.completionConfirmer.createConfirmer !== 'function') {
      console.warn('[autopilot] disabled: completionConfirmer not loaded');
      return;
    }
    const confirmer = a.completionConfirmer.createConfirmer({});
    const handlers = a.itemHandlers.createHandlers({
      sleep: function (ms, signal) {
        return new Promise(function (resolve, reject) {
          const t = setTimeout(resolve, ms);
          if (signal && signal.addEventListener) {
            signal.addEventListener('abort', function () { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
          }
        });
      },
      jitteredScroll: function (container, opts) {
        return new Promise(function (resolve, reject) {
          if (!container || !container.scrollBy) { resolve(); return; }
          const start = Date.now();
          const timing = a.autopilotTiming;
          function step() {
            if (Date.now() - start >= opts.totalMs) { resolve(); return; }
            if (opts.signal && opts.signal.aborted) { reject(new Error('aborted')); return; }
            const s = timing.scrollStep(opts.rng);
            try { container.scrollBy(0, s.pixels); } catch (_) {}
            setTimeout(step, s.intervalMs);
          }
          step();
        });
      },
      timing: a.autopilotTiming,
      replies: a.discussionReplies,
      typingEngine: a.typingEngine,
      typingInjector: a.typingInjector,
      answerApplier: a.answerApplier || null,
      pageFallback: a.pageFallback || null,
    });
    // Expose the generic Mark-complete fallback on handlers so the controller
    // can invoke it without re-resolving the module.
    handlers.tryMarkCompleteFallback = a.itemHandlers.tryMarkCompleteFallback;
    _autopilotInstance = a.moduleAutopilot.createAutopilot({
      document: document,
      window: window,
      storage: storage,
      handlers: handlers,
      sidebar: a.sidebar,
      confirmer: confirmer,
    });
    let _latestSettings = { pauseOnUserInput: true, autoSubmitQuizzes: false, behaviorMode: 'fast', runScope: 'module' };
    // Initialize from storage once.
    a.autopilotState.createState(storage).load(function (cur) {
      if (cur && cur.settings) _latestSettings = Object.assign({}, _latestSettings, cur.settings);
    });
    if (typeof a.sidebar.setAutopilotHandlers === 'function') {
      a.sidebar.setAutopilotHandlers({
        onRun:    function () { _autopilotInstance.start({ scope: 'module' }); },
        onRunAllModules: function () { _autopilotInstance.startAllModules(); },
        onStop:   function () { _autopilotInstance.stop(); },
        onResume: function () { _autopilotInstance.resume(); },
        onTakeOver: function () { _autopilotInstance.takeOver(); },
        onSettingsChange: function (settings) {
          _latestSettings = Object.assign({}, _latestSettings, settings || {});
          a.autopilotState && a.autopilotState.createState(storage).update({ settings: settings }, function () {});
        },
      });
    }
    // Pause-on-user-input listeners — gated by settings.pauseOnUserInput.
    if (a.autopilotInputGuard && typeof a.autopilotInputGuard.attachInputListeners === 'function') {
      a.autopilotInputGuard.attachInputListeners(
        document,
        function () { return _latestSettings; },
        null,
        function () { _autopilotInstance && _autopilotInstance.pause('You started interacting.'); }
      );
    }
    // Visibility pause after 60s hidden.
    let hiddenSince = 0;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { hiddenSince = Date.now(); }
      else if (hiddenSince && Date.now() - hiddenSince > 60000) {
        _autopilotInstance && _autopilotInstance.pause('Tab was hidden — paused.');
        hiddenSince = 0;
      } else { hiddenSince = 0; }
    });
    _autopilotInstance.bootIfRunning();
  }

  function startup() {
    mountSidebarWhenReady();
    startAutopilot();
  }

  document.addEventListener('copy', onCopy, true);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startup, { once: true });
  } else {
    startup();
  }
})();
