// lib/module-autopilot.js
// Controller for the module autopilot. Owns the run loop, navigation,
// heartbeat, and pause/resume triggers.
(function (root) {
  'use strict';

  function buildSyntheticPageItem(scraperMod, url, doc) {
    if (!url) return null;
    const id = scraperMod.extractItemId(url);
    const kind = scraperMod.classifyKind(url);
    if (kind === 'other' && !id) return null;
    const title = (doc && doc.title) || 'Current page';
    return {
      id: id || ('page-' + (kind || 'unknown')),
      title: title.replace(/\s*\|\s*Coursera\s*$/i, ''),
      kind: kind === 'other' ? 'reading' : kind,
      url: url,
      completed: false,
      syntheticSinglePage: true,
    };
  }

  function buildDiagnosticsSnapshot(stateNow, item, doc, pageFallback, scraperMod) {
    const url = (doc && doc.defaultView && doc.defaultView.location && doc.defaultView.location.href) || '';
    const v = doc && doc.querySelector ? doc.querySelector('video') : null;
    const curT = v && Number.isFinite(v.currentTime) ? v.currentTime : null;
    const dur = v && Number.isFinite(v.duration) ? v.duration : null;
    const slider = doc && doc.querySelector ? doc.querySelector('[role="slider"][aria-label*="Video Progress" i]') : null;
    const sliderVal = slider ? (slider.getAttribute('aria-valuenow') || null) : null;
    const sliderMax = slider ? (slider.getAttribute('aria-valuemax') || null) : null;
    const markBtn = pageFallback && pageFallback.findMarkCompleteButton ? !!pageFallback.findMarkCompleteButton(doc) : false;
    const nextBtn = pageFallback && pageFallback.findGoToNextItemButton ? !!pageFallback.findGoToNextItemButton(doc) : false;
    const greenIn = scraperMod && scraperMod.findGreenCompletionIconInRow && item ? !!scraperMod.findGreenCompletionIconInRow(doc, item.id) : false;
    return {
      itemId: item ? item.id : null,
      kind: item ? item.kind : null,
      title: item ? item.title : null,
      url: url,
      queue: stateNow && stateNow.queue ? stateNow.queue.length : 0,
      cursor: stateNow ? stateNow.cursor : null,
      curT: curT,
      dur: dur,
      sliderVal: sliderVal,
      sliderMax: sliderMax,
      markBtn: markBtn,
      nextBtn: nextBtn,
      greenInRow: greenIn,
    };
  }

  function formatDiagnosticsSnapshot(snap) {
    if (!snap) return 'diag=null';
    const parts = [
      'diag id=' + snap.itemId,
      'kind=' + snap.kind,
      'title=' + JSON.stringify(snap.title || ''),
      'url=' + snap.url,
      'queue=' + snap.queue,
      'cursor=' + snap.cursor,
      'curT=' + (snap.curT === null ? 'n/a' : Math.round(snap.curT)),
      'dur=' + (snap.dur === null ? 'n/a' : Math.round(snap.dur)),
      'sliderVal=' + (snap.sliderVal === null ? 'n/a' : snap.sliderVal),
      'sliderMax=' + (snap.sliderMax === null ? 'n/a' : snap.sliderMax),
      'markBtn=' + snap.markBtn,
      'nextBtn=' + snap.nextBtn,
      'greenInRow=' + snap.greenInRow,
    ];
    return parts.join(' ');
  }

  function isFailureOutcome(o) {
    if (!o || !o.outcome) return true;
    if (/^pause-needed/.test(o.outcome)) return true;
    if (o.outcome === 'video-autoplay-blocked') return true;
    if (o.outcome === 'video-no-element') return true;
    if (o.outcome === 'discussion-skipped-no-input') return true;
    if (o.outcome === 'quiz-filled-paused-for-review') return true;
    if (o.outcome === 'quiz-filled-no-submit-button') return true;
    if (o.outcome === 'assignment-agreement-accepted-paused') return true;
    if (o.outcome === 'assessment-ai-answered-paused') return true;
    if (o.outcome === 'assessment-ai-no-answer') return true;
    if (o.outcome === 'assignment-no-action') return true;
    return false;
  }

  // Build an ordered traversal queue from raw scraped items.
  //
  // Semantics:
  // - Completed items are dropped silently (no skip log).
  // - Blocked items are KEPT in the queue, tagged with `blocked:true` and
  //   `blockReason`, so traversal can lazily log "Skipped <reason>: ..."
  //   exactly when it bypasses each one (and only once per run).
  // - The queue is trimmed so it starts at the first safe item to be processed:
  //   the current-URL match if it points to a safe non-completed item, else
  //   the first safe item in DOM order. Items before that point (including any
  //   blocked items the user is already past) are dropped silently.
  // Returns `{ queue, startCursor: 0 }`, or `{ queue: [], allComplete: true }`
  // when there are no safe items remaining.
  function buildOrderedQueue(scraperMod, rawItems, currentItemId) {
    const ordered = [];
    for (let i = 0; i < rawItems.length; i++) {
      const it = rawItems[i];
      if (it.completed) continue;
      if (scraperMod.isBlockedAssessmentItem && scraperMod.isBlockedAssessmentItem(it)) {
        ordered.push(Object.assign({}, it, { blocked: true, blockReason: blockReasonLabel(it) }));
      } else {
        ordered.push(it);
      }
    }
    if (ordered.length === 0) return { queue: [], allComplete: true };
    let targetIdx = -1;
    if (currentItemId) {
      for (let i = 0; i < ordered.length; i++) {
        if (ordered[i].id === currentItemId && !ordered[i].blocked) { targetIdx = i; break; }
      }
    }
    if (targetIdx === -1) {
      for (let i = 0; i < ordered.length; i++) {
        if (!ordered[i].blocked) { targetIdx = i; break; }
      }
    }
    if (targetIdx === -1) {
      // Only blocked items remain — nothing safe to process.
      return { queue: [], allComplete: true };
    }
    return { queue: ordered.slice(targetIdx), startCursor: 0 };
  }

  function blockReasonLabel(item) {
    if (!item) return 'blocked';
    const kind = (item.kind || '').toLowerCase();
    const url = (item.url || '');
    const title = (item.title || '');
    if (kind === 'discussion' || /\/discussion(Prompt)?\//i.test(url) || /\bdiscussion prompt\b/i.test(title)) return 'discussion prompt';
    if (kind === 'peer-review' || /\/peer\//i.test(url) || /\breview your peers\b/i.test(title)) return 'peer review';
    if (/\/exam\//i.test(url) || /\bexam\b/i.test(title)) return 'exam';
    if (kind === 'quiz' || /\/quiz\//i.test(url) || /\bquiz\b/i.test(title)) return 'quiz';
    if (kind === 'programming' || /\/programming\//i.test(url)) return 'programming assignment';
    if (/\/gradedLti\//i.test(url) || /\/assignment-submission\//i.test(url) || /\bgraded\b/i.test(title) || /\bapp item\b/i.test(title) || /\bassignment\b/i.test(title)) return 'graded item';
    return 'blocked';
  }

  const PRIMARY_CONFIRMER_TIMEOUT_MS = 45 * 1000;
  const FAST_PRIMARY_CONFIRMER_TIMEOUT_MS = 5 * 1000;
  const FALLBACK_CONFIRMER_TIMEOUT_MS = 15 * 1000;

  // Map internal failure-outcome tokens to user-grade phrases for the sidebar banner.
  const FAILURE_REASON_TEXT = {
    'pause-needed-no-answer': 'no answer text to apply',
    'pause-needed-no-match': "answer didn't match anything on the page",
    'pause-needed-no-applier': 'answer engine not loaded',
    'video-autoplay-blocked': 'video autoplay was blocked by the browser',
    'video-no-element': 'no video element found on the page',
    'discussion-skipped-no-input': 'no discussion reply input found',
    'quiz-filled-paused-for-review': 'quiz filled — review and submit, then Resume',
    'quiz-filled-no-submit-button': 'quiz filled but no submit button was found',
    'assignment-agreement-accepted-paused': 'agreement checked — review and submit manually, then Resume',
    'assignment-no-action': 'graded assignment — review and submit manually, then Resume',
    'assessment-ai-answered-paused': 'AI filled the answers — review and submit, then Resume',
    'assessment-ai-no-answer': 'no AI answer produced — configure an AI API Key (Manage AI API Key) or answer manually',
  };

  function reasonText(outcome) {
    if (!outcome || !outcome.outcome) return 'no outcome from handler';
    return FAILURE_REASON_TEXT[outcome.outcome] || outcome.outcome;
  }

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

  // PHASE 9: per-run identity. Stamped on active run state so an old
  // iteration's stale state.updateIfCurrentRun can be refused after stop()
  // cleared the run or after a fresh run rotated the runId.
  function generateRunId() {
    return 'run-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
  }

  const HEARTBEAT_INTERVAL_MS = 5000;

  function createAutopilot(opts) {
    opts = opts || {};
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    const win = opts.window || (typeof window !== 'undefined' ? window : null);
    const storage = opts.storage;
    const handlers = opts.handlers || {};
    const nowFn = opts.nowFn || function () { return Date.now(); };
    const sessionStore = opts.sessionStorage
      || (win && win.sessionStorage)
      || (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
    const TABKEY_SS = 'ccp_autopilot_tabkey';
    let tabKey = opts.tabKey;
    if (!tabKey && sessionStore) {
      try { tabKey = sessionStore.getItem(TABKEY_SS) || null; } catch (_) {}
    }
    if (!tabKey) tabKey = generateTabKey();
    if (sessionStore) {
      try { sessionStore.setItem(TABKEY_SS, tabKey); } catch (_) {}
    }
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
    const navigateUrlChangeTimeoutMs = (opts.navigateUrlChangeTimeoutMs && opts.navigateUrlChangeTimeoutMs > 0) ? opts.navigateUrlChangeTimeoutMs : 800;
    const markCompleteRaceTimeoutMs = (typeof opts.markCompleteRaceTimeoutMs === 'number' && opts.markCompleteRaceTimeoutMs >= 0)
      ? opts.markCompleteRaceTimeoutMs
      : FALLBACK_CONFIRMER_TIMEOUT_MS;
    const markCompleteRacePollMs = (typeof opts.markCompleteRacePollMs === 'number' && opts.markCompleteRacePollMs > 0)
      ? opts.markCompleteRacePollMs
      : 50;
    // After the race fails for a video item, the controller asks the handler
    // module to do a single bounded recovery (re-find <video>, seek near end,
    // re-click Mark-as-completed) and then runs the confirmer ONE more time
    // with this short timeout. The whole recovery path is bounded by this
    // value plus the handler's own internal end-wait.
    const videoRecoveryConfirmTimeoutMs = (typeof opts.videoRecoveryConfirmTimeoutMs === 'number' && opts.videoRecoveryConfirmTimeoutMs >= 0)
      ? opts.videoRecoveryConfirmTimeoutMs
      : 10 * 1000;
    const moduleExpandWaitMs = (typeof opts.moduleExpandWaitMs === 'number' && opts.moduleExpandWaitMs >= 0)
      ? opts.moduleExpandWaitMs
      : 100;
    const confirmer = opts.confirmer || null;
    // PHASE 9: callers may inject a deterministic runId generator for tests.
    // Defaults to the random/timestamp generateRunId().
    const runIdGenerator = (typeof opts.runIdGenerator === 'function') ? opts.runIdGenerator : generateRunId;

    const pageFallback = opts.pageFallback
      || (typeof require !== 'undefined' ? (function () { try { return require('./page-fallback.js'); } catch (_) { return null; } })() : null)
      || (root.ClipboardCleaner && root.ClipboardCleaner.pageFallback) || null;

    const courseraDom = opts.courseraDom
      || (typeof require !== 'undefined' ? (function () { try { return require('./coursera-dom.js'); } catch (_) { return null; } })() : null)
      || (root.ClipboardCleaner && root.ClipboardCleaner.courseraDom) || null;

    const stateMod = opts.stateMod || getStateMod();
    const scraperMod = opts.scraperMod || getScraperMod();
    // PHASE 11: accept either an explicit messenger (cross-realm; production
    // wires this to chrome.runtime via createRuntimeMessenger) or a raw
    // storage adapter (backward-compatible single-realm form used by tests
    // and the service-worker bootstrap). createState() handles both shapes.
    const state = opts.messenger
      ? stateMod.createState(opts.messenger)
      : stateMod.createState(storage);

    const debugRecorder = (opts && opts.debugRecorder) || null;
    function rec(type, details) {
      if (!debugRecorder || typeof debugRecorder.record !== 'function') return;
      try { debugRecorder.record(type, details); } catch (_) {}
    }

    // PHASE 17 — status-aware messaging for a refused start. When the
    // authority reports already-active with currentStatus='paused', the
    // user has either a resumable paused run (Resume/Stop) or a paused
    // run whose queue is empty (Stop/reset before starting fresh).
    //
    // The empty-queue distinction MUST come from the EXISTING persisted
    // queue (read via a follow-up state.load), not the controller's newly
    // planned scrape — the existing paused run might have queue=[] even
    // when the new scrape finds items. PHASE 16 used the planned queue
    // and so misled the user with Resume/Stop guidance for an existing
    // empty paused run that could only be cleared with Stop.
    function _ph17_refusedStartBanner(reason, currentStatus, existingQueueLen) {
      if (reason !== 'already-active') {
        return 'Authority unavailable — cannot start.';
      }
      if (currentStatus === 'paused') {
        if (existingQueueLen === 0) {
          return 'An autopilot run is paused with no remaining items. Stop it to reset before starting a new run.';
        }
        return 'An autopilot run is paused. Resume it or Stop it before starting a new run.';
      }
      if (currentStatus === 'running') {
        return 'Another tab is running an autopilot.';
      }
      // Unknown active status — be conservative.
      return 'An autopilot run is already active. Stop it before starting a new run.';
    }

    let heartbeatTimer = null;
    let destroyed = false;
    let abortController = null;
    let inFlight = null;
    // PHASE 17 — startup concurrency gate. Both start() and startAllModules()
    // pass through this flag. While a startup is pending, any further call to
    // either API is ignored (run.start.ignored). This prevents two prospective
    // runIds from being generated and racing through pre-install + restore
    // when both activateRun calls are refused — the live failure mode that
    // produced a phantom never-persisted runId in _authoritativeRunId on
    // 2026-05-26 and caused subsequent pause()/takeOver() to self-cancel.
    //
    // Token discipline: stop() may cancel a pending startup and immediately
    // permit a fresh start (PHASE 9 B8 reproduction). The cancelled startup's
    // eventual finally MUST NOT clear the gate the fresh start now owns. Each
    // startup carries a monotonically-increasing token; stop() bumps the token
    // when it cancels, so a late finally compares its token to the current
    // value and quietly skips cleanup.
    let _startInFlight = false;
    let _startToken = 0;
    // Run-generation counter. Bumped by stop() — AND by cross-realm RUN_KEY
    // change events that reveal our run was stopped or replaced by another
    // realm. Any in-flight runCurrentItem iteration whose myGen no longer
    // equals _runGeneration refuses to write state, AND the existing
    // isCancelled() short-circuits handler/page-click/recovery/navigation
    // side effects.
    let _runGeneration = 0;
    // PHASE 11: the controller's view of the authoritative runId. We set
    // this BEFORE issuing any write that mutates runId, so our own
    // authority-change broadcast lands with a matching value and the
    // listener treats it as a no-op. An external change (different runId,
    // or null when we held a runId) means a newer realm stopped/replaced
    // our run — the listener bumps _runGeneration so existing PHASE 7+
    // isCancelled() guards short-circuit handler/click/recovery/navigation
    // side effects.
    let _authoritativeRunId = null;
    // Track runIds this controller has previously been authoritative over.
    // A stale storage.set from one of OUR past runs (e.g. an old deferred
    // cursor-advance write landing after we stopped and started a new
    // run) carries a past runId — the listener must NOT mistake it for
    // an external takeover and cancel the current new run.
    const _pastRunIds = new Set();
    function _setAuthoritativeRunId(next) {
      if (_authoritativeRunId != null && _authoritativeRunId !== next) {
        _pastRunIds.add(_authoritativeRunId);
      }
      _authoritativeRunId = next;
    }

    // Subscribe to authority change broadcasts via the state's messenger
    // (which already wraps the authority subscription). Stop the loop if
    // the authority is unavailable (e.g. a messenger that doesn't support
    // onChange returns a no-op unsubscribe).
    const _unsubscribeAuthorityChange = (state && typeof state.onChange === 'function')
      ? state.onChange(function (ev) {
          if (!ev || ev.key !== stateMod.RUN_KEY) return;
          const newRunId = (ev.newValue && ev.newValue.runId) || null;
          if (newRunId === _authoritativeRunId) return; // our own current write
          if (newRunId != null && _pastRunIds.has(newRunId)) {
            // Stale write from one of OUR past runs landing late. Harmless;
            // do NOT cancel the current run.
            rec('authority.staleOwnWrite', {
              staleRunId: newRunId,
              currentAuthoritativeRunId: _authoritativeRunId,
            });
            return;
          }
          // External change of authority — our in-flight work is now stale.
          _runGeneration += 1;
          rec('authority.invalidated', {
            previousRunId: _authoritativeRunId,
            newRunId: newRunId,
            newStatus: ev.newValue && ev.newValue.status || null,
          });
          // Abort any pending handler/confirmer immediately.
          if (abortController && abortController.abort) {
            try { abortController.abort(); } catch (_) {}
          }
        })
      : function () {};
    // Coursera's SPA pushState fires synchronously when navigateAndConfirm
    // clicks the next sidebar anchor. The route watcher then calls
    // bootIfRunning re-entrantly, while the OUTER runCurrentItem is still
    // settling. Without coordination, `if (inFlight) return inFlight` would
    // attach the re-entry to the outer promise and the next safe item would
    // never run. We instead remember that a re-entry was requested, and
    // schedule a fresh bootIfRunning once the outer iteration releases.
    let queuedRun = false;

    // Single coalesced continuation request. Multiple navigation signals
    // (route watcher firing, navigateAndConfirm observing urlChanged=true,
    // a fresh content-script lifecycle calling bootIfRunning at startup) can
    // all converge on "now run the destination item". They share one token:
    // `pendingContinuationTarget` (the destination URL). The first request
    // schedules continuation; subsequent requests for the same target emit
    // `navigation.continuation.deduped` and do nothing. The token clears at
    // `item.run.entered` for the destination so a later transition can request
    // again.
    let pendingContinuationTarget = null;
    let missingContinuationTimer = null;
    const MISSING_CONTINUATION_TIMEOUT_MS = 5000;

    function clearMissingContinuationTimer() {
      if (missingContinuationTimer) { clearTimeout(missingContinuationTimer); missingContinuationTimer = null; }
    }

    function _normalizeTarget(target) {
      if (!target) return target;
      try {
        const origin = (win && win.location && win.location.origin) || 'https://www.coursera.org';
        return new URL(target, origin).pathname;
      } catch (_) { return target; }
    }

    function requestContinuation(source, target) {
      if (destroyed) return;
      // Route-watcher hands us the full absolute URL; the success path hands
      // us the queue item's relative URL. Normalize to pathname so the dedup
      // token compares apples to apples.
      const norm = _normalizeTarget(target);
      if (pendingContinuationTarget && pendingContinuationTarget === norm) {
        rec('navigation.continuation.deduped', { source: source, target: norm });
        return;
      }
      pendingContinuationTarget = norm;
      rec('navigation.continuation.requested', { source: source, target: norm });
      // Always feed the existing queuedRun pathway so a re-entry that arrives
      // while a previous iteration is still in flight is still coalesced.
      queuedRun = true;
      clearMissingContinuationTimer();
      missingContinuationTimer = setTimeout(function () {
        if (destroyed) return;
        // If the destination handler still has not started, the run truly stalled.
        if (pendingContinuationTarget === target) {
          rec('navigation.continuation.missing', { target: target });
        }
      }, MISSING_CONTINUATION_TIMEOUT_MS);
      if (missingContinuationTimer && typeof missingContinuationTimer.unref === 'function') {
        missingContinuationTimer.unref();
      }
      // If no iteration is currently running, kick boot directly on a
      // macrotask so any pending microtask state writes settle first.
      if (!inFlight) {
        setTimeout(function () {
          if (!destroyed) bootIfRunning(source);
        }, 0);
      }
    }

    function logNoItemsDiagnostic() {
      if (!sidebar.appendAutopilotLog) return;
      let diag = null;
      try {
        diag = scraperMod.scrapeModuleDiagnostics && scraperMod.scrapeModuleDiagnostics(doc);
      } catch (_) { /* diagnostic is best-effort */ }
      if (!diag || !diag.containerCandidates) {
        sidebar.appendAutopilotLog('No items found — scraper has no diagnostic helper');
        return;
      }
      const hits = diag.containerCandidates.filter(function (c) { return c.matched; });
      const extras = 'accordion=' + diag.accordionHeaderCount + ', panels=' + diag.accordionPanelCount
        + ', learn-anchors=' + diag.learnAnchorCount
        + ', mark-complete-btns=' + diag.markCompleteCount
        + ', go-next-btns=' + diag.goToNextCount;
      const samples = '; headers=[' + (diag.headerSamples || []).map(function (s) { return JSON.stringify(s); }).join(', ') + ']'
        + '; anchor-text=[' + (diag.anchorSamples || []).map(function (s) { return JSON.stringify(s); }).join(', ') + ']';
      if (hits.length === 0) {
        sidebar.appendAutopilotLog('No items found — 0 candidate containers matched. ' + extras + samples);
      } else {
        sidebar.appendAutopilotLog('No items found — ' + hits.length + ' container(s) matched but yielded 0 items; sections=' + diag.sectionCount + '. ' + extras + samples);
      }
    }

    function startHeartbeat() {
      stopHeartbeat();
      // PHASE 13: bind the heartbeat lifecycle to the runId observed AT
      // TIMER CREATION. Every tick passes this captured runId to
      // refreshHeartbeat. The authority refuses ticks whose expectedRunId
      // no longer matches the current runId in storage — preventing an
      // old already-scheduled timer in the SAME TAB from refreshing a
      // newer run after Stop+Start.
      const _heartbeatRunId = _authoritativeRunId;
      heartbeatTimer = setInterval(function () {
        state.refreshHeartbeat(tabKey, nowFn(), function () {}, _heartbeatRunId);
      }, HEARTBEAT_INTERVAL_MS);
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

    async function navigateAndConfirm(targetUrl) {
      const before = currentUrl();
      let _urlChanged = false;
      let _rowAnchorClicked = false;
      let _expectedId = null;
      try {
        if (courseraDom && typeof courseraDom.parseLearnUrl === 'function') {
          const _p = courseraDom.parseLearnUrl(targetUrl);
          _expectedId = _p ? _p.id : null;
        }
      } catch (_) { _expectedId = null; }
      await navigate(targetUrl);
      const deadline = Date.now() + navigateUrlChangeTimeoutMs;
      while (Date.now() < deadline) {
        if (currentUrl() !== before) {
          // Confirm by URL + expected item id: only accept the change if the new URL
          // parses to the target's item id. If we could not derive an expected id
          // (non-/learn/ target) OR the new URL does not parse, fall back to today's
          // behavior and accept the bare URL change. A parsed-but-mismatched id is an
          // interstitial/redirect and must NOT be accepted here — let the row-anchor /
          // next-item / launch fallbacks below decide.
          let _newId = null;
          try {
            if (courseraDom && typeof courseraDom.parseLearnUrl === 'function') {
              const _np = courseraDom.parseLearnUrl(currentUrl());
              _newId = _np ? _np.id : null;
            }
          } catch (_) { _newId = null; }
          const _idConfirmed = (!_expectedId || !_newId) ? true : (_newId === _expectedId);
          if (_idConfirmed) {
            // Yield once before returning so that any bootIfRunning() initiated by
            // the pushState side-effect (inside navigate()) can advance far enough
            // to call runCurrentItem() while inFlight is still set, enabling the
            // queuedRun re-entry mechanism to fire correctly.
            await Promise.resolve();
            _urlChanged = true; rec('navigation.result', { target: targetUrl, urlChanged: _urlChanged, idConfirmed: true, rowAnchorFallbackClicked: _rowAnchorClicked }); return true;
          }
          // URL changed but to a different (interstitial) item id: record and break
          // out of the wait loop so the fallbacks below run.
          _urlChanged = true;
          rec('navigation.interstitial', { target: targetUrl, expectedId: _expectedId, observedId: _newId });
          break;
        }
        await new Promise(function (r) { setTimeout(r, 50); });
      }
      if (doc && typeof doc.querySelectorAll === 'function') {
        let targetPath = targetUrl;
        try {
          const origin = (win && win.location && win.location.origin) || 'https://www.coursera.org';
          targetPath = new URL(targetUrl, origin).pathname;
        } catch (_) {}
        const anchors = doc.querySelectorAll('a[href*="/learn/"]');
        for (let i = 0; i < anchors.length; i++) {
          const href = anchors[i].getAttribute('href') || '';
          try {
            const aPath = new URL(href, 'https://www.coursera.org').pathname;
            if (aPath === targetPath) {
              try { anchors[i].click(); _rowAnchorClicked = true; rec('navigation.result', { target: targetUrl, urlChanged: _urlChanged, rowAnchorFallbackClicked: _rowAnchorClicked }); return true; } catch (_) {}
            }
          } catch (_) {}
        }
      }
      // External LTI launch page: there is no in-page row anchor or SPA route to
      // confirm; treat the page itself as the destination so the run loop proceeds
      // (the handler will skip-and-continue). Branch on URL kind / Launch-App form.
      if (courseraDom && typeof courseraDom.isExternalLaunchPage === 'function' && courseraDom.isExternalLaunchPage(doc, targetUrl)) {
        rec('navigation.result', { target: targetUrl, urlChanged: _urlChanged, externalLaunch: true });
        return true;
      }
      // Final fallback: an in-body "Go to next item" control (locale-tolerant).
      if (courseraDom && typeof courseraDom.findNextItemButton === 'function') {
        const nextBtn = courseraDom.findNextItemButton(doc);
        if (nextBtn) {
          try { nextBtn.click(); rec('navigation.result', { target: targetUrl, urlChanged: _urlChanged, nextItemButtonClicked: true }); return true; } catch (_) {}
        }
      }
      rec('navigation.result', { target: targetUrl, urlChanged: _urlChanged, rowAnchorFallbackClicked: _rowAnchorClicked });
      return false;
    }

    async function start(opts) {
      if (destroyed) return;
      const scopeChoice = (opts && opts.scope) || 'module';
      // PHASE 17 — startup concurrency gate. Refuse a second concurrent
      // startup. The check + flag set MUST be synchronous (no await before
      // them) so two rapid clicks from the UI cannot both pass through.
      if (_startInFlight) {
        rec('run.start.ignored', { reason: 'start-in-flight', requestedScope: scopeChoice });
        return;
      }
      const myToken = ++_startToken;
      _startInFlight = true;
      if (sidebar.setAutopilotButtonsStarting) sidebar.setAutopilotButtonsStarting(true);
      try {
        return await _doStart(opts, scopeChoice);
      } finally {
        // Only clear if our token still owns the gate. stop() may have
        // cancelled this startup and reassigned the gate to a fresh start;
        // in that case our late finally must not steal it.
        if (_startToken === myToken) {
          _startInFlight = false;
          if (sidebar.setAutopilotButtonsStarting) sidebar.setAutopilotButtonsStarting(false);
        }
      }
    }

    async function _doStart(opts, scopeChoice) {
      // PHASE 9: capture the run-generation at startup entry. Each await
      // below re-checks: if stop() bumped _runGeneration during a startup
      // await, the startup must bail BEFORE persisting status=running or
      // invoking handlers — otherwise the stopped run would be silently
      // resurrected by the late settlement.
      const _startGen = _runGeneration;
      rec('run.start.requested', { scope: scopeChoice, currentUrl: currentUrl() });
      rec('scrape.start', { scope: scopeChoice, url: currentUrl() });
      let scraped = scraperMod.scrapeModule(doc);
      rec('scrape.completed', { itemCount: (scraped.items || []).length });
      if (!scraped.items || scraped.items.length === 0) {
        logNoItemsDiagnostic();
        const syntheticItem = buildSyntheticPageItem(scraperMod, currentUrl(), doc);
        if (!syntheticItem) {
          if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('No items found in this module.');
          return;
        }
        scraped = { courseId: scraped.courseId, moduleId: scraped.moduleId, items: [syntheticItem], singlePage: true };
        if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('▶ Single-page mode for ' + syntheticItem.kind + ' "' + syntheticItem.title + '"');
      }

      // ---- Resume-from-progress queue building ----
      // The queue keeps blocked items in place (tagged blocked:true) and is
      // trimmed to start at the current safe item. Skip log lines are emitted
      // lazily by runCurrentItem when traversal actually bypasses each blocked
      // entry — never as a startup dump.
      const currentItemId = scraperMod.extractItemId(currentUrl());
      const built = buildOrderedQueue(scraperMod, scraped.items, currentItemId);
      {
        const _safeCount = built.queue.filter(function (it) { return !it.blocked; }).length;
        const _blockedCount = built.queue.length - _safeCount;
        rec('queue.built', { orderedCount: built.queue.length, safeCount: _safeCount, blockedCount: _blockedCount, trimmedResumeCount: built.startCursor || 0 });
      }
      if (built.allComplete) {
        if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Module already complete — no remaining safe items.');
        return;
      }
      const safeQueue = built.queue;
      const startCursor = built.startCursor;
      {
        const startItem = safeQueue[startCursor];
        rec('queue.resume.selected', { cursor: startCursor, itemId: startItem.id, title: startItem.title, kind: startItem.kind, reason: (currentItemId && currentItemId === startItem.id) ? 'current-url-match' : 'first-safe' });
      }
      // PHASE 13: do NOT call acquireOwnership before activateRun. The old
      // sequence (acquireOwnership → activateRun) could mutate the
      // ownerTabKey of an EXISTING active run with a stale heartbeat, then
      // have activateRun refused, leaving corrupted ownership. activateRun
      // is now atomic: it refuses unless the state is idle/no runId, and
      // assigns ownerTabKey as part of the same write.
      //
      // PHASE 16: capture the prior local authority identity BEFORE we set
      // the attempted runId. If activateRun is refused, restore the prior
      // value AND tag the attempted runId as past. Otherwise the never-
      // persisted runId would linger as _authoritativeRunId and a later
      // takeOver() / external write would emit a phantom
      // authority.invalidated event and self-cancel the recovery.
      const _runId = runIdGenerator();
      const _priorAuthRunId = _authoritativeRunId;
      _setAuthoritativeRunId(_runId);
      const _activateRes = await new Promise(function (resolve) {
        state.activateRun({
          status: 'running',
          courseId: scraped.courseId,
          moduleId: scraped.moduleId,
          queue: safeQueue,
          cursor: startCursor,
          startedAt: nowFn(),
          itemStartedAt: nowFn(),
          ownerTabKey: tabKey,
          heartbeatAt: nowFn(),
          runScope: scopeChoice,
          skippedLogged: {},
          lastPauseReason: null,
          runId: _runId,
        }, resolve);
      });
      if (!_activateRes || _activateRes.ok === false || _activateRes.written === false) {
        const r = (_activateRes && _activateRes.reason) || 'authority-unavailable';
        const curStatus = _activateRes && _activateRes.currentStatus;
        const curRunId = _activateRes && _activateRes.currentRunId;
        rec('run.start.aborted', { phase: 'authority-commit-failed', reason: r, currentStatus: curStatus, currentRunId: curRunId });
        // PHASE 16: discard the never-persisted attempted runId. Direct
        // assignment + _pastRunIds bookkeeping — _setAuthoritativeRunId
        // would otherwise add the restored value to _pastRunIds, which
        // would later cause our own legitimate writes to be misread as
        // stale own writes.
        if (_authoritativeRunId === _runId) {
          _authoritativeRunId = _priorAuthRunId;
          if (_runId != null) _pastRunIds.add(_runId);
          if (_priorAuthRunId != null) _pastRunIds.delete(_priorAuthRunId);
        }
        rec('run.start.identity.discarded', { attemptedRunId: _runId, restoredRunId: _priorAuthRunId });
        // PHASE 17 — banner reflects the EXISTING paused run's queue, not
        // the new planned scrape. The existing run might have queue=[] even
        // when the new scrape finds items; Resume can do nothing there, so
        // the banner must direct Stop/reset.
        let _existingQueueLen = null;
        if (r === 'already-active') {
          const _existing = await new Promise(function (resolve) { state.load(resolve); });
          _existingQueueLen = (_existing && Array.isArray(_existing.queue)) ? _existing.queue.length : null;
        }
        // PHASE 18 — control recovery. Refused-already-active means an
        // existing run is paused or running in the persisted state. The
        // banner directs the user to Stop (or Resume/Stop for non-empty
        // paused). The rendered Stop button MUST be enabled — otherwise
        // the banner-directed Stop is a UI dead end. setAutopilotButtonsRunning(true)
        // is the existing API that enables Stop AND disables Run/Run-All;
        // call it BEFORE setAutopilotPaused so the controls are usable by
        // the time the banner appears.
        if (r === 'already-active' && sidebar.setAutopilotButtonsRunning) {
          sidebar.setAutopilotButtonsRunning(true);
        }
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, _ph17_refusedStartBanner(r, curStatus, _existingQueueLen));
        return;
      }
      // PHASE 9: bail if Stop fired while the initial running-state write
      // was in flight. The write may have landed (which stop's queued clear
      // will overwrite), but we MUST NOT proceed to navigate, start the
      // heartbeat, or invoke a handler against the cleared run.
      if (destroyed || _runGeneration !== _startGen) {
        rec('run.start.aborted', { phase: 'post-initial-state-commit', reason: destroyed ? 'destroyed' : 'stale-generation' });
        return;
      }
      rec('queue.cursor.changed', { before: null, after: startCursor, reason: 'start' });
      startHeartbeat();
      if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(true);
      const startItem = safeQueue[startCursor];
      const safeCount = safeQueue.filter(function (it) { return !it.blocked; }).length;
      if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Running — ' + safeCount + ' safe item(s) to process');
      if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('▶ Resuming at "' + (startItem.title || startItem.id) + '" — current unfinished ' + startItem.kind);
      await navigateAndConfirm(safeQueue[startCursor].url);
      if (destroyed || _runGeneration !== _startGen) {
        rec('run.start.aborted', { phase: 'post-navigate', reason: destroyed ? 'destroyed' : 'stale-generation' });
        return;
      }
      // If the current URL already matches the start-cursor item, no SPA
      // route-change event will fire (navigate() is a no-op on the same URL),
      // so kick the handler directly. This applies at any cursor position — not
      // just cursor=0 — so that resuming from item 3 (startCursor>0) works too.
      const curItemId = scraperMod.extractItemId(currentUrl());
      if (curItemId && curItemId === safeQueue[startCursor].id) {
        const fresh = await new Promise(function (resolve) { state.load(resolve); });
        if (destroyed || _runGeneration !== _startGen) {
          rec('run.start.aborted', { phase: 'post-reload-before-runCurrentItem', reason: destroyed ? 'destroyed' : 'stale-generation' });
          return;
        }
        await runCurrentItem(fresh);
      }
    }

    async function scrapeAllModulesWithExpansion() {
      const merged = [];
      const byId = {};
      let courseId = null;

      function merge(scan) {
        if (!scan) return;
        if (scan.courseId) courseId = scan.courseId;
        const modules = Array.isArray(scan.modules) ? scan.modules : [];
        for (let i = 0; i < modules.length; i++) {
          const mod = modules[i];
          const key = mod.moduleId || ('module-' + (i + 1));
          let entry = byId[key];
          if (!entry) {
            entry = { moduleId: key, headerText: mod.headerText, items: [] };
            byId[key] = entry;
            merged.push(entry);
          }
          if (mod.headerText) entry.headerText = mod.headerText;
          if (Array.isArray(mod.items) && mod.items.length > 0) entry.items = mod.items;
        }
      }

      merge(scraperMod.scrapeAllModules(doc));
      if (typeof scraperMod.findAccordionHeaders !== 'function') {
        return { courseId: courseId, modules: merged };
      }

      const headers = scraperMod.findAccordionHeaders(doc);
      for (let i = 0; i < headers.length; i++) {
        const header = headers[i];
        if (!header || !header.getAttribute || header.getAttribute('aria-expanded') !== 'false') continue;
        const _headerText = (header.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        rec('module.expand.requested', { headerText: _headerText });
        try { header.click(); } catch (_) { continue; }
        if (moduleExpandWaitMs > 0) {
          await new Promise(function (resolve) { setTimeout(resolve, moduleExpandWaitMs); });
        }
        merge(scraperMod.scrapeAllModules(doc));
        rec('module.expand.completed', { itemCount: merged.length });
      }

      return { courseId: courseId, modules: merged };
    }

    async function startAllModules() {
      if (destroyed) return;
      // PHASE 17 — shared startup gate. Same instance as start(); if a
      // module start is mid-flight we must not race a second activation.
      if (_startInFlight) {
        rec('run.start.ignored', { reason: 'start-in-flight', requestedScope: 'course' });
        return;
      }
      const myToken = ++_startToken;
      _startInFlight = true;
      if (sidebar.setAutopilotButtonsStarting) sidebar.setAutopilotButtonsStarting(true);
      try {
        return await _doStartAllModules();
      } finally {
        if (_startToken === myToken) {
          _startInFlight = false;
          if (sidebar.setAutopilotButtonsStarting) sidebar.setAutopilotButtonsStarting(false);
        }
      }
    }

    async function _doStartAllModules() {
      // PHASE 9: same startup-generation discipline as start().
      const _startGen = _runGeneration;
      rec('run.start.requested', { scope: 'course', currentUrl: currentUrl() });
      rec('scrape.start', { scope: 'course', url: currentUrl() });
      const all = await scrapeAllModulesWithExpansion();
      if (destroyed || _runGeneration !== _startGen) {
        rec('run.start.aborted', { phase: 'post-scrape-all-modules', reason: destroyed ? 'destroyed' : 'stale-generation' });
        return;
      }
      const flat = [];
      for (let m = 0; m < all.modules.length; m++) {
        const mod = all.modules[m];
        for (let i = 0; i < mod.items.length; i++) {
          flat.push(Object.assign({}, mod.items[i], { _moduleId: mod.moduleId, _moduleHeader: mod.headerText }));
        }
      }
      rec('scrape.completed', { moduleCount: (all.modules || []).length, itemCount: flat.length });
      if (flat.length === 0) {
        // PHASE 17 — the outer startAllModules wrapper holds _startInFlight.
        // Call the gate-bypassing implementation directly; the wrapper still
        // owns the gate release.
        return await _doStart({ scope: 'course' }, 'course');
      }
      const currentItemId = scraperMod.extractItemId(currentUrl());
      const built = buildOrderedQueue(scraperMod, flat, currentItemId);
      {
        const _safeCount = built.queue.filter(function (it) { return !it.blocked; }).length;
        const _blockedCount = built.queue.length - _safeCount;
        rec('queue.built', { orderedCount: built.queue.length, safeCount: _safeCount, blockedCount: _blockedCount, trimmedResumeCount: built.startCursor || 0 });
      }
      if (built.allComplete) {
        if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Course already complete — no remaining safe items.');
        return;
      }
      const safeQueue = built.queue;
      const startCursor = built.startCursor;
      {
        const startItem = safeQueue[startCursor];
        rec('queue.resume.selected', { cursor: startCursor, itemId: startItem.id, title: startItem.title, kind: startItem.kind, reason: (currentItemId && currentItemId === startItem.id) ? 'current-url-match' : 'first-safe' });
      }
      // PHASE 13: atomic activation (no pre-acquireOwnership). See start().
      // PHASE 16: same prior-runId capture + restore as start(); see the
      // detailed rationale there.
      const _runId = runIdGenerator();
      const _priorAuthRunId = _authoritativeRunId;
      _setAuthoritativeRunId(_runId);
      const _activateRes = await new Promise(function (resolve) {
        state.activateRun({
          status: 'running',
          courseId: all.courseId,
          moduleId: safeQueue[startCursor]._moduleId,
          queue: safeQueue,
          cursor: startCursor,
          startedAt: nowFn(),
          itemStartedAt: nowFn(),
          ownerTabKey: tabKey,
          heartbeatAt: nowFn(),
          runScope: 'course',
          skippedLogged: {},
          lastPauseReason: null,
          runId: _runId,
        }, resolve);
      });
      if (!_activateRes || _activateRes.ok === false || _activateRes.written === false) {
        const r = (_activateRes && _activateRes.reason) || 'authority-unavailable';
        const curStatus = _activateRes && _activateRes.currentStatus;
        const curRunId = _activateRes && _activateRes.currentRunId;
        rec('run.start.aborted', { phase: 'authority-commit-failed', reason: r, currentStatus: curStatus, currentRunId: curRunId });
        if (_authoritativeRunId === _runId) {
          _authoritativeRunId = _priorAuthRunId;
          if (_runId != null) _pastRunIds.add(_runId);
          if (_priorAuthRunId != null) _pastRunIds.delete(_priorAuthRunId);
        }
        rec('run.start.identity.discarded', { attemptedRunId: _runId, restoredRunId: _priorAuthRunId });
        // PHASE 17 — see _doStart for rationale: existing persisted queue
        // length drives paused-empty banner, not the freshly planned queue.
        let _existingQueueLen = null;
        if (r === 'already-active') {
          const _existing = await new Promise(function (resolve) { state.load(resolve); });
          _existingQueueLen = (_existing && Array.isArray(_existing.queue)) ? _existing.queue.length : null;
        }
        // PHASE 18 — same control-recovery treatment as _doStart: enable
        // Stop before showing the banner so the banner-directed Stop works.
        if (r === 'already-active' && sidebar.setAutopilotButtonsRunning) {
          sidebar.setAutopilotButtonsRunning(true);
        }
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, _ph17_refusedStartBanner(r, curStatus, _existingQueueLen));
        return;
      }
      if (destroyed || _runGeneration !== _startGen) {
        rec('run.start.aborted', { phase: 'post-initial-state-commit', reason: destroyed ? 'destroyed' : 'stale-generation' });
        return;
      }
      rec('queue.cursor.changed', { before: null, after: startCursor, reason: 'start' });
      startHeartbeat();
      if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(true);
      const startItemCourse = safeQueue[startCursor];
      const safeCountCourse = safeQueue.filter(function (it) { return !it.blocked; }).length;
      if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Running (course) — ' + safeCountCourse + ' safe item(s) across ' + all.modules.length + ' modules');
      if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('▶ Course mode — resuming at "' + (startItemCourse.title || startItemCourse.id) + '" (' + safeCountCourse + ' safe item(s) across ' + all.modules.length + ' modules)');
      await navigateAndConfirm(safeQueue[startCursor].url);
      if (destroyed || _runGeneration !== _startGen) {
        rec('run.start.aborted', { phase: 'post-navigate', reason: destroyed ? 'destroyed' : 'stale-generation' });
        return;
      }
      const curItemId = scraperMod.extractItemId(currentUrl());
      if (curItemId && curItemId === safeQueue[startCursor].id) {
        const fresh = await new Promise(function (resolve) { state.load(resolve); });
        if (destroyed || _runGeneration !== _startGen) {
          rec('run.start.aborted', { phase: 'post-reload-before-runCurrentItem', reason: destroyed ? 'destroyed' : 'stale-generation' });
          return;
        }
        await runCurrentItem(fresh);
      }
    }

    function handlerForKind(kind) {
      if (kind === 'assignment' && handlers.assignment) return handlers.assignment;
      if (handlers[kind]) return handlers[kind];
      return handlers.fallback;
    }

    // Walk forward through any blocked entries starting at `fromCursor`,
    // emitting one skip-log line per blocked item (deduped via
    // stateNow.skippedLogged). Returns the new cursor and the updated logged
    // map so the caller can persist them. Pure: does not mutate stateNow.
    function emitSkipsAndAdvance(stateNow, fromCursor) {
      const loggedSet = Object.assign({}, stateNow.skippedLogged || {});
      let cur = fromCursor;
      while (cur < stateNow.queue.length && stateNow.queue[cur] && stateNow.queue[cur].blocked) {
        const b = stateNow.queue[cur];
        const lbl = b.blockReason || blockReasonLabel(b);
        rec('queue.blocked.encountered', { cursor: cur, itemId: b.id, title: b.title, blockReason: lbl });
        if (!loggedSet[b.id]) {
          if (sidebar.appendAutopilotLog) {
            sidebar.appendAutopilotLog('⏭ Skipped ' + lbl + ': "' + (b.title || b.id) + '"');
          }
          rec('queue.blocked.skipped', { cursor: cur, itemId: b.id, title: b.title, blockReason: lbl, logged: true });
          loggedSet[b.id] = true;
        } else {
          rec('queue.blocked.skipped', { cursor: cur, itemId: b.id, title: b.title, blockReason: lbl, logged: false });
        }
        cur += 1;
      }
      return { cursor: cur, loggedSet: loggedSet };
    }

    function runCurrentItem(stateNow) {
      if (inFlight) {
        // SPA re-entry during the outer iteration's success path. Queue a
        // fresh bootIfRunning once the outer settles so the next safe item
        // actually starts (otherwise the re-entry would just await the
        // outer promise and return its already-decided value).
        rec('item.run.deferred', { reason: 'inFlight', queuedRun: true });
        queuedRun = true;
        return inFlight;
      }
      // Capture the run-generation token for THIS iteration. stop() bumps the
      // counter, so any later state mutations we attempt after Stop has fired
      // (even after our signal has settled) can be detected and refused. The
      // local `signal` closure below catches the more common cases; this token
      // is the belt-and-braces for "stop, then immediately start a new run".
      const _myGen = _runGeneration;
      // PHASE 9: capture this iteration's run identity from persisted state.
      // updateIfCurrentRun(_expectedRunId, ...) below refuses to write if a
      // fresh run has rotated the runId — that's the explicit cross-storage
      // refusal layer on top of the in-memory _myGen check.
      const _expectedRunId = stateNow && stateNow.runId ? stateNow.runId : null;
      inFlight = (async function () {
        const _curItem = stateNow.queue[stateNow.cursor];
        if (_curItem) {
          rec('item.run.entered', { cursor: stateNow.cursor, itemId: _curItem.id, title: _curItem.title, kind: _curItem.kind, behaviorMode: (stateNow.settings && stateNow.settings.behaviorMode) || 'fast' });
          // We have started the destination of any outstanding continuation
          // request — release the dedup token so future transitions can be
          // requested again.
          if (pendingContinuationTarget) {
            pendingContinuationTarget = null;
            clearMissingContinuationTimer();
          }
        }
        // Defensive: cursor should land on a safe item after start() trimming,
        // but if we ever boot onto a blocked entry, lazy-log and step forward.
        let item = stateNow.queue[stateNow.cursor];
        if (item && item.blocked) {
          const _beforeBlockedCursor = stateNow.cursor;
          const adv = emitSkipsAndAdvance(stateNow, stateNow.cursor);
          await new Promise(function (resolve) {
            state.updateIfCurrentRun(_expectedRunId, { cursor: adv.cursor, skippedLogged: adv.loggedSet }, function () { resolve(); });
          });
          rec('queue.cursor.changed', { before: _beforeBlockedCursor, after: adv.cursor, reason: 'blocked-skip' });
          stateNow = Object.assign({}, stateNow, { cursor: adv.cursor, skippedLogged: adv.loggedSet });
          if (adv.cursor >= stateNow.queue.length) {
            // PHASE 11: this write clears runId; record locally first so the
            // authority's onChange broadcast lands as a no-op for us.
            _setAuthoritativeRunId(null);
            await new Promise(function (resolve) {
              state.updateIfCurrentRun(_expectedRunId, { status: 'idle', queue: [], ownerTabKey: null, dwellEndsAt: null, lastPauseReason: null, runId: null }, function () { resolve(); });
            });
            rec('run.completed', {});
            stopHeartbeat();
            if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Module complete.');
            if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('🏁 Module complete');
            if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(false);
            return true;
          }
          item = stateNow.queue[stateNow.cursor];
          await navigateAndConfirm(item.url);
          const curId = scraperMod.extractItemId(currentUrl());
          if (curId !== item.id) {
            // SPA route watcher will re-enter via bootIfRunning when the URL changes.
            return true;
          }
        }
        if (!item) return false;

        // Pre-handler shortcut: skip handler + confirmer if the item is already complete.
        const alreadyCompleteIndicator =
          (scraperMod.findGreenCompletionIconInRow && scraperMod.findGreenCompletionIconInRow(doc, item.id)) ||
          (item.kind === 'reading' && pageFallback && pageFallback.findCompletedReadingIndicator && pageFallback.findCompletedReadingIndicator(doc));

        // effectiveCursor tracks the last already-complete item processed in the
        // forward-scan below.  For the normal (non-shortcut) path it stays equal
        // to stateNow.cursor.
        let effectiveCursor = stateNow.cursor;

        const signal = makeSignal();
        let outcome = null;

        // Cancellation guard. Returns true when EITHER this iteration's signal
        // has been aborted (Pause or Stop on this run) OR the run has been
        // replaced (Stop bumped the generation counter, possibly followed by a
        // new start()). Callers MUST consult this before any state.update,
        // before emitting "natural failure" diagnostics, and after each await
        // inside the confirmation/recovery pipeline — Stop/Pause already
        // persisted the correct terminal state, so a late mutation here would
        // either overwrite that terminal state or leak into a fresh run.
        function isCancelled() {
          return destroyed || _myGen !== _runGeneration || (signal && signal.aborted);
        }

        if (alreadyCompleteIndicator) {
          if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('✓ Already completed: "' + (item.title || item.id) + '"');
          // Click Go-to-next-item if visible (page-level completion shortcut).
          if (pageFallback && pageFallback.findGoToNextItemButton) {
            const nextBtn = pageFallback.findGoToNextItemButton(doc);
            if (nextBtn) { try { nextBtn.click(); } catch (_) {} }
          }
          outcome = { outcome: 'already-completed' };

          // Forward-scan: if subsequent queue items are also already-complete in
          // the current DOM, process them all now so the cursor leaps past all of
          // them in one pass.  Needed for the "whole module already done" case
          // where the URL never changes between items.
          let scan = stateNow.cursor + 1;
          while (scan < stateNow.queue.length) {
            const scanItem = stateNow.queue[scan];
            const scanComplete =
              (scraperMod.findGreenCompletionIconInRow && scraperMod.findGreenCompletionIconInRow(doc, scanItem.id)) ||
              (scanItem.kind === 'reading' && pageFallback && pageFallback.findCompletedReadingIndicator && pageFallback.findCompletedReadingIndicator(doc));
            if (!scanComplete) break;
            if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('✓ Already completed: "' + (scanItem.title || scanItem.id) + '"');
            if (stateNow.courseId) {
              await new Promise(function (resolve) {
                state.recordCourseItem(stateNow.courseId, scanItem.id, scanItem.kind, 'already-completed', resolve);
              });
            }
            effectiveCursor = scan;
            scan++;
          }
        } else {
          const handler = handlerForKind(item.kind);
          if (!handler) {
            const _noHandlerReason = 'No handler for item kind: ' + item.kind;
            rec('run.paused', { reason: 'no-handler-for-kind', kind: item.kind });
            await new Promise(function (resolve) { state.updateIfCurrentRun(_expectedRunId, { status: 'paused', ownerTabKey: null, lastPauseReason: _noHandlerReason }, function () { resolve(); }); });
            if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'No handler for kind: ' + item.kind);
            return false;
          }
          try {
            const ctx = {
              doc: doc,
              item: item,
              rng: rng,
              signal: signal,
              replyHistory: stateNow.replyHistory || [],
              autoSubmitQuizzes: (stateNow.settings && stateNow.settings.autoSubmitQuizzes) || false,
              behaviorMode: (stateNow && stateNow.settings && stateNow.settings.behaviorMode) || 'fast',
              getAnswerText: function () { return (sidebar.getAnswerText && sidebar.getAnswerText()) || ''; },
              getLastCleanedCopy: function () { return (root.ClipboardCleaner && root.ClipboardCleaner.lastCleanedCopy) || null; },
            };
            outcome = await handler(ctx);
          } catch (e) {
            // If pause() already fired an intentional abort, the handler's
            // sleep/wait surfaces the same 'aborted' error here. Don't
            // double-record the pause as a generic handler-error.
            const _aborted = !!(e && e.message === 'aborted') && (_intentionalPauseSource || (signal && signal.aborted));
            if (_aborted) {
              const src = _intentionalPauseSource || 'manual';
              _intentionalPauseSource = null;
              rec('operation.aborted', { operation: 'handler', source: src });
              if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('⏸ Handler aborted (' + src + ')');
              stopHeartbeat();
              return false;
            }
            // PHASE 8: a non-abort error that arrives AFTER Pause/Stop already
            // fired the abort signal must not overwrite the intentional
            // terminal state with a generic "Handler error: ..." pause. The
            // _aborted branch above only catches errors whose message is
            // exactly 'aborted'; late real errors (e.g. a fetch rejecting
            // after the user paused) would otherwise bypass that and replace
            // the user-provided pause reason. Bail cleanly instead.
            if (isCancelled()) {
              rec('iteration.aborted', {
                itemId: item.id,
                kind: item.kind,
                phase: 'post-handler-error',
                reason: (signal && signal.aborted) ? 'signal-aborted' : 'stale-generation',
                handlerError: e && e.message,
              });
              stopHeartbeat();
              return false;
            }
            if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('✖ Handler error: ' + (e && e.message || 'unknown'));
            const _handlerErrMsg = 'Handler error: ' + (e && e.message || 'unknown');
            rec('run.paused', { reason: 'handler-error', message: e && e.message });
            rec('run.error', { operation: 'handler', message: e && e.message });
            await new Promise(function (resolve) { state.updateIfCurrentRun(_expectedRunId, { status: 'paused', ownerTabKey: null, lastPauseReason: _handlerErrMsg }, function () { resolve(); }); });
            if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Paused: handler error.');
            stopHeartbeat();
            return false;
          }
          if (isFailureOutcome(outcome)) {
            // PHASE 8: a handler that resolves a failure outcome AFTER
            // Pause/Stop has fired must not overwrite the intentional terminal
            // state. Bail cleanly here; the user-issued Stop has already
            // cleared state (or Pause has already persisted the user reason).
            if (isCancelled()) {
              rec('iteration.aborted', {
                itemId: item.id,
                kind: item.kind,
                phase: 'post-handler-failure-outcome',
                reason: (signal && signal.aborted) ? 'signal-aborted' : 'stale-generation',
                outcome: outcome.outcome,
              });
              stopHeartbeat();
              return false;
            }
            const _outcomeReason = 'Paused — ' + reasonText(outcome);
            rec('run.paused', { reason: 'handler-outcome', outcome: outcome.outcome });
            await new Promise(function (resolve) { state.updateIfCurrentRun(_expectedRunId, { status: 'paused', ownerTabKey: null, lastPauseReason: _outcomeReason }, function () { resolve(); }); });
            if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, _outcomeReason);
            stopHeartbeat();
            return false;
          }
          // If pause/stop fired during the handler and the signal was honored
          // after the handler had already resolved, bail before recording or
          // advancing the cursor.
          if (signal && signal.aborted) {
            if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('⏸ Paused before commit — cursor not advanced');
            return false;
          }
          // Wait for Coursera's sidebar to mark this item complete. The handler
          // took an action; the confirmer decides whether it actually worked.
          if (confirmer && typeof confirmer.waitForCompletion === 'function') {
            if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Waiting for completion mark — ' + item.kind + ' "' + (item.title || item.id) + '"');
            let confirmed = false;
            // PHASE 9: track what the controller attempted on this item so the
            // final completion-failure diagnostic can accurately report it. The
            // old generic `pageFallback.notFound` event was emitted in the
            // final pause path regardless of whether the Mark button had
            // actually been clicked or whether recovery had been tried, which
            // read as "Mark button missing" in timelines even when it wasn't.
            let markButtonAttempted = false;
            let recoveryAttempted = false;
            let recoverySucceeded = false;
            try {
              confirmed = await confirmer.waitForCompletion({
                doc: doc, itemId: item.id, itemKind: item.kind, scraper: scraperMod,
                pageFallback: pageFallback,
                signal: signal, timeoutMs: (stateNow && stateNow.settings && stateNow.settings.behaviorMode === 'fast'
                  && (item.kind === 'video' || item.kind === 'reading'))
                  ? FAST_PRIMARY_CONFIRMER_TIMEOUT_MS
                  : PRIMARY_CONFIRMER_TIMEOUT_MS,
              });
            } catch (_) { /* abort surfaces as not-confirmed */ }
            // PHASE 8: Stop/Pause during the PRIMARY confirmer surfaces as
            // `confirmed === false` through the swallowed-abort path above.
            // Without this guard, the controller would then fall straight into
            // the !confirmed page-fallback block: click Mark-as-completed on
            // the user's behalf, enter the race / recovery codepaths, and
            // ultimately emit a `run.paused reason=no-completion-indicator`
            // over the cleared idle state. Bail cleanly the moment we observe
            // cancellation so no page action is taken for a cancelled item.
            if (isCancelled()) {
              rec('iteration.aborted', {
                itemId: item.id,
                kind: item.kind,
                phase: 'post-primary-confirmer',
                reason: (signal && signal.aborted) ? 'signal-aborted' : 'stale-generation',
              });
              stopHeartbeat();
              return false;
            }
            if (!confirmed) {
              // Pre-compute the expected next safe queue destination BEFORE
              // clicking Mark-as-completed, so the post-click race observer
              // can recognize the case where Coursera advances the page in
              // response to the click.
              let _expectedNextSafe = null;
              {
                let _scan = stateNow.cursor + 1;
                while (_scan < stateNow.queue.length && stateNow.queue[_scan] && stateNow.queue[_scan].blocked) _scan++;
                _expectedNextSafe = stateNow.queue[_scan] || null;
              }
              const _expectedNextId = _expectedNextSafe ? _expectedNextSafe.id : null;

              let markClicked = false;
              if (pageFallback && typeof pageFallback.findMarkCompleteButton === 'function') {
                const btn = pageFallback.findMarkCompleteButton(doc);
                if (btn) {
                  try { btn.click(); markClicked = true; } catch (_) {}
                  if (markClicked) {
                    markButtonAttempted = true;
                    rec('pageFallback.markComplete.clicked', { itemId: item.id, expectedNextItemId: _expectedNextId });
                    if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('↻ Clicked Mark-as-completed (page-fallback) for "' + (item.title || item.id) + '"');
                  }
                }
              }
              if (!markClicked) {
                const handlersApi = (typeof require !== 'undefined') ? require('./item-handlers.js')
                  : (root.ClipboardCleaner && root.ClipboardCleaner.itemHandlers);
                const fallback = (handlers && handlers.tryMarkCompleteFallback)
                  || (handlersApi && handlersApi.tryMarkCompleteFallback);
                if (fallback && fallback(doc)) {
                  markClicked = true;
                  markButtonAttempted = true;
                  rec('pageFallback.markComplete.clicked', { itemId: item.id, expectedNextItemId: _expectedNextId });
                  if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('↻ Clicked Mark-as-complete fallback for "' + (item.title || item.id) + '"');
                }
              }

              if (markClicked) {
                // Race: original-item completion indicator vs. URL advance to
                // expected next safe. Both are observed in the same bounded
                // loop with a short poll interval, so whichever success signal
                // happens first ends the wait immediately. The controller must
                // NOT keep polling the old item's completion indicator for the
                // full fallback timeout while Coursera is visibly already on
                // the next lesson.
                rec('pageFallback.completionRace.started', { itemId: item.id, expectedNextItemId: _expectedNextId, timeoutMs: markCompleteRaceTimeoutMs });

                // Local AbortController gates the parallel confirmer so we can
                // stop it the moment the navigation observer wins (or the user
                // pauses). Propagate the user signal into the local one.
                let _localAbort = null;
                if (typeof AbortController === 'function') {
                  _localAbort = new AbortController();
                  if (signal) {
                    if (signal.aborted) { try { _localAbort.abort(); } catch (_) {} }
                    else if (typeof signal.addEventListener === 'function') {
                      signal.addEventListener('abort', function () { try { _localAbort.abort(); } catch (_) {} }, { once: true });
                    }
                  }
                }
                const _confirmerSignal = (_localAbort && _localAbort.signal) || signal;

                let _confirmerSettled = false;
                let _confirmerResult = false;
                const _confirmerPromise = confirmer.waitForCompletion({
                  doc: doc, itemId: item.id, itemKind: item.kind, scraper: scraperMod,
                  pageFallback: pageFallback,
                  signal: _confirmerSignal, timeoutMs: markCompleteRaceTimeoutMs,
                }).then(function (r) { _confirmerSettled = true; _confirmerResult = !!r; return r; })
                  .catch(function () { _confirmerSettled = true; _confirmerResult = false; return false; });
                // Prevent an unhandled rejection if .catch is ever bypassed.
                _confirmerPromise.catch(function () {});

                // The race deadline is a real wall-clock bound (independent of
                // the test-injectable nowFn used elsewhere) — both the URL
                // advance and the confirmer settle in real time, so the loop
                // must terminate based on the same clock.
                const _raceStartWall = Date.now();
                const _raceDeadlineWall = _raceStartWall + markCompleteRaceTimeoutMs;
                let _navMatched = false;
                let _navElapsed = 0;
                let _aborted = false;
                while (true) {
                  if (signal && signal.aborted) { _aborted = true; break; }
                  if (_confirmerSettled && _confirmerResult === true) break;
                  if (_expectedNextSafe) {
                    const _cid = scraperMod.extractItemId(currentUrl());
                    if (_cid && _cid === _expectedNextSafe.id) {
                      _navMatched = true;
                      _navElapsed = Date.now() - _raceStartWall;
                      break;
                    }
                  }
                  if (Date.now() >= _raceDeadlineWall) break;
                  // If confirmer already settled negative AND we have no nav
                  // target to wait on, there is nothing more to observe — bail
                  // immediately rather than spin until the timeout.
                  if (_confirmerSettled && _confirmerResult === false && !_expectedNextSafe) break;
                  await new Promise(function (r) { setTimeout(r, markCompleteRacePollMs); });
                }
                // Stop the parallel confirmer so it doesn't keep polling.
                if (_localAbort && !_localAbort.signal.aborted) { try { _localAbort.abort(); } catch (_) {} }

                if (_navMatched && _expectedNextSafe) {
                  rec('pageFallback.navigation.detected', { fromItemId: item.id, toItemId: _expectedNextSafe.id, elapsedMs: _navElapsed });
                  rec('completion.detected', { itemId: item.id, evidence: 'mark-complete-advanced-to-next' });
                  if (sidebar.appendAutopilotLog) {
                    sidebar.appendAutopilotLog('✓ ' + item.kind + ' "' + (item.title || item.id) + '" — Mark-as-completed advanced page to "' + (_expectedNextSafe.title || _expectedNextSafe.id) + '"');
                  }
                  confirmed = true;
                  // Pre-arm the continuation so when the success path advances
                  // the cursor, the destination boot picks up immediately and
                  // duplicate route signals are deduped by pendingContinuationTarget.
                  requestContinuation('mark-complete-navigation', _expectedNextSafe.url);
                } else if (_confirmerResult === true) {
                  confirmed = true;
                } else if (_aborted) {
                  // Surfaced to the outer signal-aborted path below.
                  confirmed = false;
                } else {
                  // Click was made, race timed out without either a confirmer
                  // success or a URL advance. This is the "clicked-but-not-
                  // committed" failure mode worth distinguishing from
                  // "no button found at all".
                  rec('pageFallback.markComplete.unconfirmed', { itemId: item.id, elapsedMs: Date.now() - _raceStartWall });
                }
              } else {
                // No button was located by either the primary or fallback selector.
                rec('pageFallback.markComplete.notFound', { itemId: item.id });
              }

              // ----- Video recovery (one bounded attempt on the SAME active
              // item) -----  If we are still unconfirmed for a video, ask the
              // handler module to nudge the player past Coursera's
              // "watched-enough" threshold and then re-run the confirmer once.
              //
              // Cursor advance remains gated on `confirmed === true`, so a
              // failed recovery does NOT advance — it falls through to the
              // pause path below.
              if (!confirmed && item.kind === 'video' && handlers && typeof handlers.videoRecovery === 'function' && !isCancelled()) {
                // Stale-player guard: if the URL has already moved off the
                // active item, refuse recovery so the old <video> element
                // cannot wrongly count for whatever lesson Coursera has
                // navigated to. Treat "no item id in URL at all" (e.g. the
                // user landed on /home/...) as stale too — we're no longer in
                // the learning context.
                const _curIdBefore = scraperMod.extractItemId(currentUrl());
                if (_curIdBefore !== item.id) {
                  rec('video.recovery.staleItem', { itemId: item.id, currentUrlItemId: _curIdBefore, expectedItemId: item.id });
                } else {
                  recoveryAttempted = true;
                  rec('video.recovery.requested', { itemId: item.id });
                  if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('↻ Video recovery: seeking near end and re-clicking Mark-as-completed for "' + (item.title || item.id) + '"');
                  const _recStart = Date.now();
                  let _recRes = null;
                  try {
                    _recRes = await handlers.videoRecovery({ doc: doc, item: item, signal: signal, rng: rng });
                  } catch (_) { _recRes = null; }

                  // If Stop/Pause fired during the recovery action, do not
                  // emit a "failed" outcome — pause()/stop() has already
                  // persisted the correct terminal state. Emit a one-line
                  // cancellation diagnostic and let the iteration unwind.
                  if (isCancelled()) {
                    rec('video.recovery.aborted', { itemId: item.id, phase: 'after-action' });
                  } else {
                    // Verify the URL has not silently moved off the active item
                    // during recovery — if it has, do NOT mark the prior item
                    // complete; let the route watcher reconcile the new state.
                    const _curIdAfter = scraperMod.extractItemId(currentUrl());
                    if (_curIdAfter !== item.id) {
                      rec('video.recovery.stalePostAction', { itemId: item.id, currentUrlItemId: _curIdAfter });
                      rec('video.recovery.completed', { itemId: item.id, success: false, elapsedMs: Date.now() - _recStart });
                    } else if (_recRes && _recRes.actionTaken) {
                      let _recovered = false;
                      try {
                        _recovered = await confirmer.waitForCompletion({
                          doc: doc, itemId: item.id, itemKind: item.kind, scraper: scraperMod,
                          pageFallback: pageFallback,
                          signal: signal, timeoutMs: videoRecoveryConfirmTimeoutMs,
                        });
                      } catch (_) { _recovered = false; }
                      // Same guard after the post-recovery confirmer await.
                      if (isCancelled()) {
                        rec('video.recovery.aborted', { itemId: item.id, phase: 'after-confirm' });
                      } else if (_recovered) {
                        rec('completion.detected', { itemId: item.id, evidence: 'video-recovery' });
                        rec('video.recovery.completed', { itemId: item.id, success: true, elapsedMs: Date.now() - _recStart });
                        if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('✓ Video recovery confirmed completion of "' + (item.title || item.id) + '"');
                        confirmed = true;
                        recoverySucceeded = true;
                      } else {
                        rec('video.recovery.completed', { itemId: item.id, success: false, elapsedMs: Date.now() - _recStart });
                        rec('video.recovery.failed', { itemId: item.id, reason: 'no-confirm-after-recovery' });
                      }
                    } else {
                      rec('video.recovery.completed', { itemId: item.id, success: false, elapsedMs: Date.now() - _recStart });
                      rec('video.recovery.failed', { itemId: item.id, reason: (_recRes && _recRes.reason) || 'no-action' });
                    }
                  }
                }
              }
            }
            if (!confirmed) {
              // Cancellation guard: if Stop or Pause aborted this iteration,
              // the terminal state (idle for Stop, paused with the explicit
              // user reason for Pause) is already persisted. Falling through
              // to emit a generic completion-failure diagnostic + `run.paused
              // reason=no-completion-indicator` here would overwrite that.
              // Bail cleanly with a single diagnostic line so timelines stay
              // truthful about what actually happened.
              if (isCancelled()) {
                rec('iteration.aborted', {
                  itemId: item.id,
                  kind: item.kind,
                  phase: 'pre-final-pause',
                  reason: (signal && signal.aborted) ? 'signal-aborted' : 'stale-generation',
                });
                stopHeartbeat();
                return false;
              }
              const snap = buildDiagnosticsSnapshot(stateNow, item, doc, pageFallback, scraperMod);
              if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog(formatDiagnosticsSnapshot(snap));
              try { console.warn('[autopilot stuck]', snap); } catch (_) {}
              const _noConfirmReason = 'No completion indicator after ' + item.kind + ' — Resume to retry or stop.';
              // PHASE 9: replace the old generic `pageFallback.notFound` with
              // a richer, accurately-named final diagnostic. The legacy event
              // could be misread as "Mark button missing" even when the Mark
              // button was clicked AND recovery was tried — both attempts are
              // now reported in the event's details so post-mortem traces are
              // unambiguous about WHAT was tried before pausing.
              rec('completion.unconfirmed.final', {
                itemId: item.id,
                itemKind: item.kind,
                markButtonAttempted: markButtonAttempted,
                recoveryAttempted: recoveryAttempted,
                recoverySucceeded: recoverySucceeded,
              });
              rec('run.paused', { reason: 'no-completion-indicator', itemKind: item.kind });
              await new Promise(function (resolve) { state.updateIfCurrentRun(_expectedRunId, { status: 'paused', ownerTabKey: null, lastPauseReason: _noConfirmReason }, function () { resolve(); }); });
              if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, _noConfirmReason);
              stopHeartbeat();
              return false;
            }
          }
        }

        // Success path: log + recordCourseItem + cursor advance + navigateAndConfirm.
        // Cancellation guard: a confirmer that settled `true` AFTER Stop fired
        // must not advance the cursor of a cleared run, nor leak into a
        // freshly-started replacement run. Pause does not bump the generation,
        // but pause's signal.aborted catches it here too.
        if (isCancelled()) {
          rec('iteration.aborted', {
            itemId: item.id,
            kind: item.kind,
            phase: 'pre-success-commit',
            reason: (signal && signal.aborted) ? 'signal-aborted' : 'stale-generation',
          });
          stopHeartbeat();
          return false;
        }
        // The ✓ Already completed line was already logged above for the shortcut path.
        if (!alreadyCompleteIndicator) {
          if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('✓ ' + item.kind + ' "' + (item.title || item.id) + '"');
        }
      if (stateNow.courseId) {
        await new Promise(function (resolve) {
          state.recordCourseItem(stateNow.courseId, item.id, item.kind, outcome.outcome, resolve);
        });
      }
      // One more guard immediately before the cursor/state mutation: the
      // recordCourseItem await above could resolve after Stop fired.
      if (isCancelled()) {
        rec('iteration.aborted', {
          itemId: item.id,
          kind: item.kind,
          phase: 'pre-cursor-advance',
          reason: (signal && signal.aborted) ? 'signal-aborted' : 'stale-generation',
        });
        stopHeartbeat();
        return false;
      }
      // Lazy-log any blocked entries between this item and the next safe one,
      // then point the cursor at the next safe item (or end-of-queue).
      const adv = emitSkipsAndAdvance(stateNow, effectiveCursor + 1);
      const nextCursor = adv.cursor;
      const newSkippedLogged = adv.loggedSet;
      const newReplyHistory = (outcome && outcome.usedReply)
        ? ((stateNow.replyHistory || []).concat([outcome.usedReply]).slice(-5))
        : (stateNow.replyHistory || []);
      const queueLen = stateNow.queue.length;
      if (nextCursor >= queueLen) {
        // If this was a synthetic single-page item, try to advance via Go-to-next-item.
        const wasSingle = item && item.syntheticSinglePage;
        // PHASE 11: for non-synthetic completion we clear runId; record
        // locally first so the authority broadcast lands as a no-op for us.
        if (!wasSingle) { _setAuthoritativeRunId(null); }
        await new Promise(function (resolve) {
          state.updateIfCurrentRun(_expectedRunId, {
            status: wasSingle ? 'running' : 'idle',
            cursor: wasSingle ? nextCursor : nextCursor,
            replyHistory: newReplyHistory,
            ownerTabKey: wasSingle ? tabKey : null,
            queue: [],
            dwellEndsAt: null,
            skippedLogged: newSkippedLogged,
            lastPauseReason: null,
            // End-of-queue clears the run identity for non-synthetic items;
            // synthetic single-page items keep running (and keep the runId)
            // because they expect a Go-to-next-item click to navigate.
            runId: wasSingle ? _expectedRunId : null,
          }, function () { resolve(); });
        });
        // PHASE 8: Stop during the awaited end-of-queue commit must suppress
        // the subsequent `queue.cursor.changed` + `run.completed` events and
        // any synthetic single-page Go-to-next-item click. stop() has already
        // cleared state; this iteration is now stale.
        if (isCancelled()) {
          rec('iteration.aborted', {
            itemId: item.id,
            kind: item.kind,
            phase: 'post-end-of-queue-commit',
            reason: (signal && signal.aborted) ? 'signal-aborted' : 'stale-generation',
          });
          stopHeartbeat();
          return false;
        }
        rec('queue.cursor.changed', { before: effectiveCursor, after: nextCursor, reason: 'success' });
        if (wasSingle && pageFallback) {
          const nextBtn = pageFallback.findGoToNextItemButton(doc);
          if (nextBtn) {
            if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('↪ Clicking "Go to next item"');
            rec('pageFallback.nextItem.clicked', {});
            try { nextBtn.click(); } catch (_) {}
            return true;
          }
        }
        rec('run.completed', {});
        stopHeartbeat();
        if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Module complete.');
        if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('🏁 Module complete');
        if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(false);
        return true;
      }
      {
        const _nextItem = stateNow.queue[nextCursor];
        if (_nextItem) {
          rec('queue.next.safe', { cursor: nextCursor, itemId: _nextItem.id, title: _nextItem.title, kind: _nextItem.kind });
          rec('navigation.requested', { from: currentUrl(), target: _nextItem.url, itemId: _nextItem.id, title: _nextItem.title });
        }
      }
      const _advRes = await new Promise(function (resolve) {
        state.updateIfCurrentRun(_expectedRunId, {
          cursor: nextCursor,
          replyHistory: newReplyHistory,
          itemStartedAt: nowFn(),
          skippedLogged: newSkippedLogged,
        }, function (r) { resolve(r); });
      });
      // PHASE 12: bail if the authority refused (stale-run) or was
      // unavailable. The cursor did NOT advance in storage; navigating to
      // the next item would be unauthorized.
      if (!_advRes || _advRes.ok === false || _advRes.written === false) {
        rec('iteration.aborted', {
          itemId: item.id,
          kind: item.kind,
          phase: 'post-cursor-advance-commit',
          reason: (_advRes && _advRes.reason) || 'authority-unavailable',
        });
        stopHeartbeat();
        return false;
      }
      // PHASE 8: Stop during the awaited cursor-advance commit must suppress
      // the subsequent navigateAndConfirm call entirely. Without this guard
      // the controller would navigate the visible Coursera page on behalf of
      // a cleared run and then schedule a rerun keyed off the dead cursor.
      if (isCancelled()) {
        rec('iteration.aborted', {
          itemId: item.id,
          kind: item.kind,
          phase: 'post-cursor-advance-commit',
          reason: (signal && signal.aborted) ? 'signal-aborted' : 'stale-generation',
        });
        stopHeartbeat();
        return false;
      }
      rec('queue.cursor.changed', { before: effectiveCursor, after: nextCursor, reason: 'success' });
      const _navTarget = stateNow.queue[nextCursor].url;
      const _navOk = await navigateAndConfirm(_navTarget);
      // PHASE 8: even if the page actually navigated (navigate() is not
      // unwindable once a click or location set has been issued), Stop during
      // navigation must suppress the explicit `url-change-result` continuation
      // request and the queued rerun. The visible page may have moved; the
      // autopilot does not pursue it.
      if (isCancelled()) {
        rec('iteration.aborted', {
          itemId: item.id,
          kind: item.kind,
          phase: 'post-navigation',
          reason: (signal && signal.aborted) ? 'signal-aborted' : 'stale-generation',
        });
        stopHeartbeat();
        return false;
      }
      if (_navOk) {
        // navigateAndConfirm reported a successful URL change (or a row-anchor
        // fallback click). The route watcher SHOULD also fire bootIfRunning,
        // but in real Coursera the patched pushState is often bypassed by the
        // router (it captured a reference before our document_start patch ran)
        // so we cannot rely on it. Request continuation explicitly; the
        // pendingContinuationTarget token deduplicates if the route watcher
        // ends up firing too.
        requestContinuation('url-change-result', _navTarget);
      }
      return true;
      })().finally(function () {
        inFlight = null;
        if (queuedRun && !destroyed) {
          queuedRun = false;
          rec('item.run.rerun.scheduled', {});
          // setTimeout(0) so the fresh iteration runs on a macrotask AFTER
          // the current microtask queue (including this finally) drains.
          setTimeout(function () {
            if (!destroyed) {
              rec('item.run.rerun.executed', {});
              bootIfRunning('queued-rerun');
            }
          }, 0);
        }
      });
      return inFlight;
    }

    async function bootIfRunning(source) {
      if (destroyed) return false;
      // PHASE 10: bootIfRunning capture the run-generation at entry. Every
      // await below re-checks: if Stop bumped _runGeneration during the
      // intervening await (or destroyed flipped), bail BEFORE writing
      // boot-align, off-queue pause, starting the heartbeat, or invoking
      // runCurrentItem.
      const _opGen = _runGeneration;
      const cur = await new Promise(function (resolve) { state.load(resolve); });
      if (destroyed || _runGeneration !== _opGen) {
        rec('boot.exited', { reason: 'cancelled-post-load' });
        return false;
      }
      // PHASE 12: state.load returns null on authority-unavailable. Bail
      // before any side effect.
      if (!cur) {
        rec('boot.exited', { reason: 'authority-unavailable-on-load' });
        return false;
      }
      rec('boot.entered', { status: cur.status, cursor: cur.cursor, url: currentUrl(), source: source || 'unknown' });
      if (cur.status !== 'running') { rec('boot.exited', { reason: 'idle' }); return false; }
      const url = currentUrl();
      const scraperUrlCourseId = scraperMod.extractCourseId(url);
      if (cur.courseId && scraperUrlCourseId && cur.courseId !== scraperUrlCourseId) {
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Autopilot is running on a different course.');
        rec('boot.exited', { reason: 'foreign-course' });
        return false;
      }
      // PHASE 10: legacy persisted running state from before PHASE 9 had no
      // runId. Assign one BEFORE handlers run so iteration writes are
      // identity-bound by a non-null runId. Without this, runCurrentItem
      // captures _expectedRunId=null and updateIfCurrentRun(null,...) was
      // either silently treated as a wildcard (PHASE 9) or refused outright
      // (PHASE 10) — neither permits the run to proceed safely.
      let _activeRunId = cur.runId;
      if (!_activeRunId) {
        _activeRunId = runIdGenerator();
        _setAuthoritativeRunId(_activeRunId);
        // PHASE 12: fenced upgrade — refused if runId is no longer null or
        // status no longer matches what we observed at load time.
        const _upgradeRes = await new Promise(function (resolve) {
          state.upgradeLegacyRunId(cur.status, _activeRunId, resolve);
        });
        if (!_upgradeRes || _upgradeRes.ok === false || _upgradeRes.written === false) {
          rec('boot.exited', { reason: 'authority-upgrade-failed', detail: (_upgradeRes && _upgradeRes.reason) || 'authority-unavailable' });
          return false;
        }
        if (destroyed || _runGeneration !== _opGen) {
          rec('boot.exited', { reason: 'cancelled-post-runid-upgrade' });
          return false;
        }
        rec('boot.runId.upgraded', { runId: _activeRunId, source: source || 'unknown' });
      } else {
        _setAuthoritativeRunId(_activeRunId);
      }
      // PHASE 14: fenced claim. claimRunOwnership refuses if storage no
      // longer shows _activeRunId — a late stale boot whose run was
      // stopped/replaced in the meantime cannot overwrite the new run's
      // ownership.
      const acq = await new Promise(function (resolve) { state.claimRunOwnership(_activeRunId, tabKey, nowFn(), resolve); });
      if (destroyed || _runGeneration !== _opGen) {
        rec('boot.exited', { reason: 'cancelled-post-ownership' });
        return false;
      }
      if (acq === 'authority-unavailable') {
        rec('boot.exited', { reason: 'authority-unavailable-on-ownership' });
        return false;
      }
      if (acq !== 'owner') {
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true,
          "Another tab is running this course's autopilot.", { offerTakeover: true });
        rec('boot.exited', { reason: 'foreign-active' });
        return false;
      }
      startHeartbeat();
      const stateNow = await new Promise(function (resolve) { state.load(resolve); });
      if (destroyed || _runGeneration !== _opGen) {
        stopHeartbeat();
        rec('boot.exited', { reason: 'cancelled-post-reload' });
        return false;
      }
      if (!stateNow) {
        stopHeartbeat();
        rec('boot.exited', { reason: 'authority-unavailable-on-reload' });
        return false;
      }
      const currentItemId = scraperMod.extractItemId(url);
      let cursor = stateNow.cursor;
      if (currentItemId) {
        const idx = stateNow.queue.findIndex(function (it) { return it.id === currentItemId; });
        if (idx === -1) {
          // Off-queue: use updateIfCurrentRun so a stale boot that fires
          // after Stop cannot overwrite the cleared state with paused.
          await new Promise(function (resolve) { state.updateIfCurrentRun(_activeRunId, { status: 'paused', ownerTabKey: null }, function () { resolve(); }); });
          stopHeartbeat();
          if (destroyed || _runGeneration !== _opGen) {
            rec('boot.exited', { reason: 'cancelled-post-off-queue' });
            return false;
          }
          if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Off-queue — Resume to continue.');
          rec('boot.exited', { reason: 'off-queue' });
          return false;
        }
        if (idx > stateNow.cursor) {
          const _beforeAlign = stateNow.cursor;
          cursor = idx;
          await new Promise(function (resolve) { state.updateIfCurrentRun(_activeRunId, { cursor: cursor }, function () { resolve(); }); });
          if (destroyed || _runGeneration !== _opGen) {
            stopHeartbeat();
            rec('boot.exited', { reason: 'cancelled-post-boot-align' });
            return false;
          }
          rec('queue.cursor.changed', { before: _beforeAlign, after: cursor, reason: 'boot-align' });
        }
      }
      const reloaded = await new Promise(function (resolve) { state.load(resolve); });
      if (destroyed || _runGeneration !== _opGen) {
        stopHeartbeat();
        rec('boot.exited', { reason: 'cancelled-pre-runCurrentItem' });
        return false;
      }
      if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(true);
      return await runCurrentItem(reloaded);
    }

    // Tracks the source of an intentional pause so the handler's abort-catch
    // can label its own diagnostics as operation.aborted rather than
    // run.paused reason=handler-error.
    let _intentionalPauseSource = null;
    async function pause(reason, opts) {
      const source = (opts && opts.source) || 'manual';
      _intentionalPauseSource = source;
      rec('run.paused', { reason: source, source: source, message: reason || null });
      rec('operation.aborted', { source: source });
      if (abortController && abortController.abort) abortController.abort();
      stopHeartbeat();
      // PHASE 13: pause requires an authoritative identity. With a local
      // _authoritativeRunId we use the fenced pauseRun. Without one we
      // load current state and choose: pauseRun(cur.runId) if a modern
      // runId is present AND we own it; pauseLegacyRun for legacy state
      // owned by this tab; otherwise refuse. No raw state.update fallback.
      let _pauseRes = null;
      const _reasonText = reason || ('Paused (' + source + ').');
      if (_authoritativeRunId) {
        _pauseRes = await new Promise(function (resolve) {
          state.pauseRun(_authoritativeRunId, _reasonText, resolve);
        });
      } else {
        const _cur = await new Promise(function (resolve) { state.load(resolve); });
        if (!_cur) {
          _pauseRes = { ok: false, reason: 'authority-unavailable' };
        } else if (_cur.status !== 'running' || _cur.ownerTabKey !== tabKey) {
          _pauseRes = { ok: true, written: false, reason: 'no-trusted-identity' };
        } else if (_cur.runId) {
          _pauseRes = await new Promise(function (resolve) {
            state.pauseRun(_cur.runId, _reasonText, resolve);
          });
        } else {
          _pauseRes = await new Promise(function (resolve) {
            state.pauseLegacyRun(_cur.status, _cur.ownerTabKey, _reasonText, resolve);
          });
        }
      }
      if (!_pauseRes || _pauseRes.ok === false || _pauseRes.written === false) {
        const r = (_pauseRes && _pauseRes.reason) || 'authority-unavailable';
        rec('pause.aborted', { reason: r });
        if (sidebar.setAutopilotStatus) {
          if (r === 'stale-run' || r === 'modern-run-active') {
            sidebar.setAutopilotStatus('Pause refused — this controller is no longer authoritative.');
          } else if (r === 'no-trusted-identity') {
            sidebar.setAutopilotStatus('Pause refused — no authoritative run.');
          } else {
            sidebar.setAutopilotStatus('Pause failed: ' + r);
          }
        }
        return;
      }
      rec('run.pause.confirmed', { runId: _authoritativeRunId });
      if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, reason || 'Paused.');
      if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(false);
    }

    async function resume() {
      const _opGen = _runGeneration;
      const cur = await new Promise(function (resolve) { state.load(resolve); });
      if (destroyed || _runGeneration !== _opGen) {
        rec('resume.aborted', { phase: 'post-load', reason: destroyed ? 'destroyed' : 'stale-generation' });
        return;
      }
      if (!cur) {
        rec('resume.aborted', { phase: 'post-load', reason: 'authority-unavailable' });
        return;
      }
      if (cur.status !== 'paused' || !cur.queue || cur.queue.length === 0) return;
      const url = currentUrl();
      const urlCourse = scraperMod.extractCourseId(url);
      if (cur.courseId && urlCourse && cur.courseId !== urlCourse) {
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(true, 'Navigate back to course ' + cur.courseId + ' to resume.');
        return;
      }
      let _activeRunId = cur.runId;
      if (!_activeRunId) {
        _activeRunId = runIdGenerator();
        _setAuthoritativeRunId(_activeRunId);
        // PHASE 12: fenced upgrade.
        const _upgradeRes = await new Promise(function (resolve) {
          state.upgradeLegacyRunId(cur.status, _activeRunId, resolve);
        });
        if (!_upgradeRes || _upgradeRes.ok === false || _upgradeRes.written === false) {
          rec('resume.aborted', { phase: 'authority-upgrade-failed', reason: (_upgradeRes && _upgradeRes.reason) || 'authority-unavailable' });
          return;
        }
        if (destroyed || _runGeneration !== _opGen) {
          rec('resume.aborted', { phase: 'post-runid-upgrade', reason: destroyed ? 'destroyed' : 'stale-generation' });
          return;
        }
        rec('resume.runId.upgraded', { runId: _activeRunId });
      } else {
        _setAuthoritativeRunId(_activeRunId);
      }
      // PHASE 14: no standalone unfenced ownership mutation. resumeRun is
      // atomic and fenced — it validates expectedRunId + expectedStatus
      // ('paused') AND writes { status: 'running', ownerTabKey, heartbeatAt }
      // in a single authority command. A stale resume arriving after a
      // replacement run has been installed is refused there. If the paused
      // run was concurrently resumed by another tab, the second resumeRun
      // sees status !== 'paused' and is refused.
      // PHASE 12: use fenced resumeRun (validates expectedRunId AND
      // expectedStatus='paused' atomically inside the authority).
      const _resumeRes = await new Promise(function (resolve) {
        state.resumeRun(_activeRunId, tabKey, nowFn(), resolve);
      });
      if (!_resumeRes || _resumeRes.ok === false || _resumeRes.written === false) {
        rec('resume.aborted', { phase: 'authority-commit-failed', reason: (_resumeRes && _resumeRes.reason) || 'authority-unavailable' });
        return;
      }
      if (destroyed || _runGeneration !== _opGen) {
        rec('resume.aborted', { phase: 'post-running-commit', reason: destroyed ? 'destroyed' : 'stale-generation' });
        return;
      }
      startHeartbeat();
      if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(false, '');
      const stateNow = await new Promise(function (resolve) { state.load(resolve); });
      if (destroyed || _runGeneration !== _opGen) {
        stopHeartbeat();
        rec('resume.aborted', { phase: 'post-reload', reason: destroyed ? 'destroyed' : 'stale-generation' });
        return;
      }
      if (!stateNow) {
        stopHeartbeat();
        rec('resume.aborted', { phase: 'post-reload', reason: 'authority-unavailable' });
        return;
      }
      await runCurrentItem(stateNow);
    }

    async function takeOver() {
      // PHASE 12: takeOver must (a) respect Stop fired during its ownership
      // commit and (b) be fenced on the expected runId so a stale takeover
      // arriving after Stop/replacement is refused at the authority. Load
      // the current state first.
      const _opGen = _runGeneration;
      const cur = await new Promise(function (resolve) { state.load(resolve); });
      if (destroyed || _runGeneration !== _opGen) {
        rec('takeOver.aborted', { phase: 'post-load', reason: destroyed ? 'destroyed' : 'stale-generation' });
        return false;
      }
      if (!cur) {
        rec('takeOver.aborted', { phase: 'post-load', reason: 'authority-unavailable' });
        return false;
      }
      if (cur.status !== 'running' && cur.status !== 'paused') {
        rec('takeOver.aborted', { phase: 'no-active-run', reason: 'status-' + cur.status });
        return false;
      }
      if (cur.runId) {
        // Fenced takeover (modern path).
        // PHASE 16: pre-set _authoritativeRunId to the existing runId
        // BEFORE the takeOverRun write so the broadcast from our own
        // write (same runId, updated ownerTabKey/heartbeatAt) is treated
        // as own-write by the change listener and does not falsely
        // emit authority.invalidated against this controller. bootIfRunning
        // (called after a successful takeover) also calls
        // _setAuthoritativeRunId(cur.runId) — same value, idempotent.
        const _priorAuthRunIdTO = _authoritativeRunId;
        _setAuthoritativeRunId(cur.runId);
        const _toRes = await new Promise(function (resolve) {
          state.takeOverRun(cur.runId, tabKey, nowFn(), resolve);
        });
        if (!_toRes || _toRes.ok === false || _toRes.written === false) {
          // PHASE 16: takeover refused — restore prior identity so the
          // unused cur.runId does not linger as our authority.
          if (_authoritativeRunId === cur.runId) {
            _authoritativeRunId = _priorAuthRunIdTO;
            if (_priorAuthRunIdTO !== cur.runId) _pastRunIds.add(cur.runId);
            if (_priorAuthRunIdTO != null) _pastRunIds.delete(_priorAuthRunIdTO);
          }
          rec('takeOver.aborted', { phase: 'authority-commit-failed', reason: (_toRes && _toRes.reason) || 'authority-unavailable' });
          return false;
        }
      } else {
        // PHASE 13: legacy state (cur.runId is null). Use fenced
        // takeOverLegacyRun carrying the expectedStatus + expectedOwnerTabKey
        // snapshotted from the same load. If a modern run-new has been
        // installed in the meantime, the authority refuses.
        const _toRes = await new Promise(function (resolve) {
          state.takeOverLegacyRun(cur.status, cur.ownerTabKey, tabKey, nowFn(), resolve);
        });
        if (!_toRes || _toRes.ok === false || _toRes.written === false) {
          rec('takeOver.aborted', { phase: 'authority-commit-failed', reason: (_toRes && _toRes.reason) || 'authority-unavailable' });
          return false;
        }
      }
      if (destroyed || _runGeneration !== _opGen) {
        rec('takeOver.aborted', { phase: 'post-ownership-commit', reason: destroyed ? 'destroyed' : 'stale-generation' });
        return false;
      }
      return await bootIfRunning();
    }

    async function stop() {
      rec('run.stopped', {});
      // Bump generation + cancel local in-flight work immediately, regardless
      // of whether the persisted Stop succeeds. That part is purely local.
      _runGeneration += 1;
      queuedRun = false;
      pendingContinuationTarget = null;
      clearMissingContinuationTimer();
      // PHASE 17: stop also cancels any pending startup. Release the gate
      // synchronously so a fresh start() invoked right after stop() can
      // proceed without being misread as a concurrent overlap. The pending
      // start's eventual finally will see _startToken has moved on and skip
      // its own gate cleanup.
      if (_startInFlight) {
        _startInFlight = false;
        _startToken += 1;
        if (sidebar.setAutopilotButtonsStarting) sidebar.setAutopilotButtonsStarting(false);
      }
      const _expectedRunId = _authoritativeRunId;
      _setAuthoritativeRunId(null);
      if (abortController && abortController.abort) abortController.abort();
      stopHeartbeat();
      // PHASE 13: persist Stop via the fenced stopRun command. A stale Stop
      // (controller whose runId no longer matches storage) is refused —
      // the replacement run remains untouched.
      let _stopRes = null;
      if (_expectedRunId != null) {
        _stopRes = await new Promise(function (resolve) { state.stopRun(_expectedRunId, resolve); });
      } else {
        // Controller has no local runId. Load current state and choose the
        // fenced command tied to the loaded identity. Both stopRun and
        // stopLegacyRun are race-safe; if storage changes between load and
        // command, the authority refuses.
        const _cur = await new Promise(function (resolve) { state.load(resolve); });
        if (!_cur) {
          _stopRes = { ok: false, reason: 'authority-unavailable' };
        } else if (_cur.runId) {
          _stopRes = await new Promise(function (resolve) { state.stopRun(_cur.runId, resolve); });
        } else if (_cur.status === 'idle') {
          _stopRes = { ok: true, written: true };
        } else if (_cur.ownerTabKey === tabKey || _cur.ownerTabKey == null) {
          // Legacy state owned by this tab or unowned/abandoned. Use the
          // fenced legacy stop carrying the snapshotted owner (null is a
          // valid expectedOwnerTabKey for unowned legacy state).
          _stopRes = await new Promise(function (resolve) {
            state.stopLegacyRun(_cur.status, _cur.ownerTabKey, resolve);
          });
        } else {
          _stopRes = { ok: false, reason: 'no-trusted-identity' };
        }
      }
      // UI must reflect authority truth, not local intent.
      if (_stopRes && _stopRes.ok && _stopRes.written) {
        rec('run.stop.confirmed', { runId: _expectedRunId });
        if (sidebar.setAutopilotStatus) sidebar.setAutopilotStatus('Idle.');
        if (sidebar.setAutopilotButtonsRunning) sidebar.setAutopilotButtonsRunning(false);
        if (sidebar.setAutopilotPaused) sidebar.setAutopilotPaused(false, '');
      } else {
        const reason = (_stopRes && _stopRes.reason) || 'authority-unavailable';
        rec('run.stop.rejected', { reason: reason, expectedRunId: _expectedRunId, currentRunId: _stopRes && _stopRes.currentRunId });
        // Do NOT announce Idle. Surface failure to the user.
        if (sidebar.setAutopilotStatus) {
          if (reason === 'stale-run') {
            sidebar.setAutopilotStatus('Stop refused — this controller is no longer authoritative.');
          } else {
            sidebar.setAutopilotStatus('Stop failed: ' + reason);
          }
        }
      }
    }

    function installRouteWatcher() {
      if (!win || typeof win.addEventListener !== 'function' || typeof win.history === 'undefined') return function () {};
      let lastHref = currentUrl();
      function onMaybeChange() {
        const now = currentUrl();
        if (now === lastHref) return;
        const oldLastHref = lastHref;
        lastHref = now;
        rec('route.changed', { from: oldLastHref, to: now, source: 'unknown' });
        if (destroyed) return;
        // Route through the same coalesced continuation request as the
        // url-change-result path so duplicate signals (route watcher AND
        // navigateAndConfirm both seeing the new URL) collapse to one run.
        requestContinuation('route-watcher', now);
      }
      win.addEventListener('popstate', onMaybeChange);
      const origPush = win.history.pushState;
      const origReplace = win.history.replaceState;
      function patched(fn) {
        return function () {
          const r = fn.apply(this, arguments);
          try { onMaybeChange(); } catch (_) {}
          return r;
        };
      }
      try { win.history.pushState = patched(origPush); } catch (_) {}
      try { win.history.replaceState = patched(origReplace); } catch (_) {}
      return function detach() {
        try { win.history.pushState = origPush; } catch (_) {}
        try { win.history.replaceState = origReplace; } catch (_) {}
        try { win.removeEventListener('popstate', onMaybeChange); } catch (_) {}
      };
    }

    const _detachRouteWatcher = installRouteWatcher();

    function destroy() {
      destroyed = true;
      clearMissingContinuationTimer();
      if (abortController && abortController.abort) abortController.abort();
      stopHeartbeat();
      try { _detachRouteWatcher && _detachRouteWatcher(); } catch (_) {}
      try { _unsubscribeAuthorityChange && _unsubscribeAuthorityChange(); } catch (_) {}
    }

    async function getRunSnapshotContext() {
      const cur = await new Promise(function (resolve) { state.load(resolve); });
      const settings = cur.settings || {};
      return {
        url: currentUrl(),
        status: cur.status,
        behaviorMode: settings.behaviorMode || 'fast',
        runScope: cur.runScope || settings.runScope || 'module',
        courseId: cur.courseId || null,
        moduleId: cur.moduleId || null,
        cursor: cur.cursor || 0,
        queueLength: (cur.queue || []).length,
        ownerTabKey: cur.ownerTabKey || null,
        lastPauseReason: cur.lastPauseReason || null,
        queue: (cur.queue || []).map(function (it) {
          return {
            id: it.id, title: it.title, kind: it.kind, url: it.url,
            blocked: !!it.blocked, blockReason: it.blockReason || null,
            completed: !!it.completed,
            skippedLogged: !!(cur.skippedLogged && cur.skippedLogged[it.id]),
          };
        }),
      };
    }

    return {
      start: start,
      startAllModules: startAllModules,
      stop: stop,
      pause: pause,
      resume: resume,
      takeOver: takeOver,
      bootIfRunning: bootIfRunning,
      destroy: destroy,
      getRunSnapshotContext: getRunSnapshotContext,
      _tabKey: tabKey,
      _test: {
        navigateAndConfirm: navigateAndConfirm,
        navigateUrlChangeTimeoutMs: navigateUrlChangeTimeoutMs,
      },
    };
  }

  const api = {
    createAutopilot: createAutopilot,
    generateTabKey: generateTabKey,
    isFailureOutcome: isFailureOutcome,
    HEARTBEAT_INTERVAL_MS: HEARTBEAT_INTERVAL_MS,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.moduleAutopilot = api;
  }
})(typeof self !== 'undefined' ? self : this);
