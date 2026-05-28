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
    // One shared diagnostics recorder is injected into the confirmer, the
    // handlers, the autopilot, and the sidebar so a single timeline reflects
    // the entire run. A missing autopilot-debug module is non-fatal.
    let debugRecorder = null;
    if (a.autopilotDebug && typeof a.autopilotDebug.createDebugRecorder === 'function') {
      try { debugRecorder = a.autopilotDebug.createDebugRecorder({ maxEvents: 500 }); } catch (_) { debugRecorder = null; }
    }
    const confirmer = a.completionConfirmer.createConfirmer({ debugRecorder: debugRecorder });
    const handlers = a.itemHandlers.createHandlers({
      debugRecorder: debugRecorder,
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
    // PHASE 12 fail-closed wiring: in production, the active autopilot
    // MUST route every active-run mutation through the background
    // service-worker authority. If the messenger module isn't loaded or
    // chrome.runtime is unavailable, we refuse to instantiate a working
    // controller — falling back to per-realm raw storage would silently
    // reintroduce the cross-realm race the authority exists to prevent.
    if (!a.autopilotMessenger || typeof a.autopilotMessenger.createRuntimeMessenger !== 'function') {
      console.warn('[autopilot] disabled: autopilot-messenger module not loaded; cross-realm authority unavailable');
      if (a.sidebar && typeof a.sidebar.setAutopilotStatus === 'function') {
        try { a.sidebar.setAutopilotStatus('Disabled — cross-realm authority not available.'); } catch (_) {}
      }
      return;
    }
    let _runtimeMessenger;
    try {
      _runtimeMessenger = a.autopilotMessenger.createRuntimeMessenger({ runtime: chrome.runtime, storage: chrome.storage });
    } catch (e) {
      console.warn('[autopilot] disabled: runtime messenger construction failed:', e && e.message);
      if (a.sidebar && typeof a.sidebar.setAutopilotStatus === 'function') {
        try { a.sidebar.setAutopilotStatus('Disabled — runtime authority unavailable.'); } catch (_) {}
      }
      return;
    }
    if (!_runtimeMessenger) {
      console.warn('[autopilot] disabled: no runtime messenger');
      if (a.sidebar && typeof a.sidebar.setAutopilotStatus === 'function') {
        try { a.sidebar.setAutopilotStatus('Disabled — runtime authority unavailable.'); } catch (_) {}
      }
      return;
    }
    _autopilotInstance = a.moduleAutopilot.createAutopilot({
      document: document,
      window: window,
      // NOTE: no raw-storage fallback in production. Active-run mutations
      // travel via the messenger to the service worker authority.
      messenger: _runtimeMessenger,
      handlers: handlers,
      sidebar: a.sidebar,
      confirmer: confirmer,
      debugRecorder: debugRecorder,
    });
    if (debugRecorder && a.sidebar && typeof a.sidebar.setDebugRecorder === 'function') {
      try { a.sidebar.setDebugRecorder(debugRecorder); } catch (_) {}
    }
    let _latestSettings = { pauseOnUserInput: false, autoSubmitQuizzes: false, behaviorMode: 'fast', runScope: 'module' };
    // Initialize from storage once. The state module also runs a one-shot
    // settings migration here (legacy pauseOnUserInput=true → false) and
    // persists the result, so the in-memory `_latestSettings` and the sidebar
    // checkbox both end up reflecting the same effective value.
    a.autopilotState.createState(storage).load(function (cur) {
      if (cur && cur.settings) _latestSettings = Object.assign({}, _latestSettings, cur.settings);
      if (a.sidebar && typeof a.sidebar.setAutopilotSettings === 'function') {
        try { a.sidebar.setAutopilotSettings(_latestSettings); } catch (_) { /* best-effort UI sync */ }
      }
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
        function () { _autopilotInstance && _autopilotInstance.pause('You started interacting.', { source: 'user-input' }); }
      );
    }
    // Visibility pause after 60s hidden.
    let hiddenSince = 0;
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { hiddenSince = Date.now(); }
      else if (hiddenSince && Date.now() - hiddenSince > 60000) {
        _autopilotInstance && _autopilotInstance.pause('Tab was hidden — paused.', { source: 'visibility' });
        hiddenSince = 0;
      } else { hiddenSince = 0; }
    });
    _autopilotInstance.bootIfRunning('document-boot');

    // Periodically refresh the Diagnostics status block from the live
    // autopilot snapshot so the user can monitor the run from the sidebar.
    if (debugRecorder
        && a.sidebar && typeof a.sidebar.setAutopilotRunContext === 'function'
        && _autopilotInstance && typeof _autopilotInstance.getRunSnapshotContext === 'function') {
      setInterval(function () {
        _autopilotInstance.getRunSnapshotContext().then(function (ctx) {
          const item = (ctx && ctx.queue) ? ctx.queue[ctx.cursor] : null;
          try {
            a.sidebar.setAutopilotRunContext(Object.assign({}, ctx, {
              currentTitle: item ? item.title : '',
              currentKind: item ? item.kind : '',
            }));
          } catch (_) { /* sidebar update is best-effort */ }
        }).catch(function () { /* swallow */ });
      }, 2000);
    }
  }

  // === Let AI answer for you — content controller ===
  function setupAiAnswerController() {
    var a = window.ClipboardCleaner || {};
    if (!a.sidebar || !a.aiQuestionContext || !a.aiAnswerValidator || !a.answerApplier || !a.aiAnswerController) return;
    var permissive = a.aiAnswerPermissive || null;
    var messenger = {
      send: function (command, params, cb) {
        try {
          chrome.runtime.sendMessage({ type: 'ccp.ai.request', command: command, params: params || {} }, function (res) { cb(res || { ok: false, reason: 'no-response' }); });
        } catch (e) { cb({ ok: false, reason: 'send-failed', detail: String(e && e.message || '').slice(0, 80) }); }
      }
    };
    var controller = a.aiAnswerController.createAiController({
      sidebar: a.sidebar, questionContext: a.aiQuestionContext, validator: a.aiAnswerValidator, permissive: permissive, answerApplier: a.answerApplier,
      messenger: messenger, document: document, location: window.location,
      openOptionsFn: (a.aiOpenOptionsContent && typeof a.aiOpenOptionsContent.createOpenOptionsCallback === 'function')
        ? a.aiOpenOptionsContent.createOpenOptionsCallback({ runtime: chrome.runtime })
        : function (cb) { if (typeof cb === 'function') cb({ ok: false, reason: 'module-not-loaded' }); },
      openPortalFn: (a.aiOpenOptionsContent && typeof a.aiOpenOptionsContent.createOpenOptionsCallback === 'function')
        ? a.aiOpenOptionsContent.createOpenOptionsCallback({ runtime: chrome.runtime })
        : function (cb) { if (typeof cb === 'function') cb({ ok: false, reason: 'module-not-loaded' }); },
    });
    controller.wire();
    try {
      if (a.aiContentListeners && typeof a.aiContentListeners.attachAiContentListeners === 'function') {
        a.aiContentListeners.attachAiContentListeners({ runtime: chrome.runtime, controller: controller });
      }
    } catch (_) { /* ignore — extension reload, etc. */ }
  }

  function startup() {
    mountSidebarWhenReady();
    startAutopilot();
    setupAiAnswerController();
  }

  document.addEventListener('copy', onCopy, true);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startup, { once: true });
  } else {
    startup();
  }
})();
