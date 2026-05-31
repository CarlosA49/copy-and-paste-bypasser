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

  // Real Coursera mounts the destination <video> via React a few hundred
  // milliseconds AFTER SPA navigation reports urlChanged=true, so the handler
  // must poll for the element. 7 seconds matches the broader player-mount
  // window observed in the field; deps can override for tests.
  const VIDEO_ELEMENT_WAIT_TIMEOUT_MS = 7000;
  const VIDEO_ELEMENT_POLL_INTERVAL_MS = 150;

  // After the primary confirmer + mark-complete race both fail to confirm a
  // video, the controller can call videoRecovery() to nudge the player past
  // Coursera's "watched enough" threshold (seek very close to end + replay +
  // re-click Mark-as-completed). The wait below caps how long we let the
  // 'ended' event have to fire on its own before we still re-click and return.
  const VIDEO_RECOVERY_END_WAIT_MS = 5000;

  function createHandlers(deps) {
    const sleep = (deps && deps.sleep) || cancellableSleep;
    const jitteredScroll = (deps && deps.jitteredScroll) || defaultJitteredScroll;
    const timing = deps && deps.timing;
    const replies = deps && deps.replies;
    const typingEngine = deps && deps.typingEngine;
    const typingInjector = deps && deps.typingInjector;
    const pageFallback = (deps && deps.pageFallback) || null;
    const peerReviewMod = (deps && deps.peerReview) || ((typeof require !== 'undefined') ? (function () { try { return require('./peer-review.js'); } catch (_) { return null; } })() : (root.ClipboardCleaner && root.ClipboardCleaner.peerReview)) || null;
    const peerReviewReplies = (deps && deps.peerReviewReplies) || ((typeof require !== 'undefined') ? (function () { try { return require('./peer-review-replies.js'); } catch (_) { return null; } })() : (root.ClipboardCleaner && root.ClipboardCleaner.peerReviewReplies)) || null;
    const debugRecorder = (deps && deps.debugRecorder) || null;
    // Phase C AI-assessment deps (DI with window.ClipboardCleaner fallback).
    const answerApplier = (deps && deps.answerApplier) || null;
    const questionContext = (deps && deps.questionContext) || (root.ClipboardCleaner && root.ClipboardCleaner.aiQuestionContext) || null;
    const aiValidator = (deps && deps.validator) || (root.ClipboardCleaner && root.ClipboardCleaner.aiAnswerValidator) || null;
    const aiPermissive = (deps && deps.permissive) || (root.ClipboardCleaner && root.ClipboardCleaner.aiAnswerPermissive) || null;
    const courseraDom = (deps && deps.courseraDom) || (root.ClipboardCleaner && root.ClipboardCleaner.courseraDom) || null;
    const videoElementTimeoutMs = (deps && typeof deps.videoElementTimeoutMs === 'number') ? deps.videoElementTimeoutMs : VIDEO_ELEMENT_WAIT_TIMEOUT_MS;
    const videoElementPollMs = (deps && typeof deps.videoElementPollMs === 'number') ? deps.videoElementPollMs : VIDEO_ELEMENT_POLL_INTERVAL_MS;
    const videoRecoveryEndWaitMs = (deps && typeof deps.videoRecoveryEndWaitMs === 'number') ? deps.videoRecoveryEndWaitMs : VIDEO_RECOVERY_END_WAIT_MS;
    const nowFn = (deps && typeof deps.nowFn === 'function') ? deps.nowFn : function () { return Date.now(); };
    function rec(type, details) {
      if (!debugRecorder || typeof debugRecorder.record !== 'function') return;
      try { debugRecorder.record(type, details); } catch (_) {}
    }

    // Type a value into an editable element via the auto-typer when available
    // (Fast speed in fast mode, Normal otherwise); direct-set fallback if the
    // engine is unavailable. Resolves when typing completes; rejects on abort.
    function typeIntoElement(el, text, mode, signal) {
      const value = String(text == null ? '' : text);
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
              if (settled) return; settled = true;
              try { engine.stop(); } catch (_) {}
              detach(); reject(new Error('aborted'));
            };
            if (signal.aborted) { onAbort(); return; }
            signal.addEventListener('abort', onAbort, { once: true });
          }
          engine.start({
            text: value,
            target: el,
            profile: 'Balanced Natural',
            speed: mode === 'fast' ? 'Fast' : 'Normal',
            simulateTypos: false,
            onTick: function (ev) { typingInjector.insertOrBackspace(el, ev); },
            onDone: function () { if (settled) return; settled = true; detach(); resolve(); },
          });
        } else {
          try {
            if ('value' in el) el.value = value; else el.textContent = value;
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

    // Bounded, abortable readiness poll for the destination <video> element.
    // Returns one of three reasons: 'found' (el set), 'timeout' (no element
    // within timeoutMs), 'aborted' (the signal fired). Records its progress
    // via the closed-over rec(); the caller emits handler.* / video.element
    // around it for backward-compat with the existing VIDEO STATE snapshot.
    async function waitForVideoElement(doc, signal, itemId) {
      const startedAt = nowFn();
      // Immediate check — the common case where the element is already mounted.
      let el = doc && doc.querySelector ? doc.querySelector('video') : null;
      if (el) {
        return { el: el, found: true, polls: 0, elapsedMs: nowFn() - startedAt, reason: 'found' };
      }
      rec('video.element.wait.started', { itemId: itemId, timeoutMs: videoElementTimeoutMs });
      let polls = 0;
      while (true) {
        if (signal && signal.aborted) {
          return { el: null, found: false, polls: polls, elapsedMs: nowFn() - startedAt, reason: 'aborted' };
        }
        const elapsed = nowFn() - startedAt;
        if (elapsed >= videoElementTimeoutMs) {
          return { el: null, found: false, polls: polls, elapsedMs: elapsed, reason: 'timeout' };
        }
        try { await sleep(videoElementPollMs, signal); } catch (_) {
          return { el: null, found: false, polls: polls, elapsedMs: nowFn() - startedAt, reason: 'aborted' };
        }
        polls += 1;
        el = doc && doc.querySelector ? doc.querySelector('video') : null;
        if (el) {
          return { el: el, found: true, polls: polls, elapsedMs: nowFn() - startedAt, reason: 'found' };
        }
      }
    }

    async function reading(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const behaviorMode = ctx.behaviorMode || 'human';
      rec('handler.start', { itemId: ctx.item && ctx.item.id, title: ctx.item && ctx.item.title, kind: 'reading', behaviorMode: behaviorMode });
      const markButton = function () {
        if (pageFallback && typeof pageFallback.findMarkCompleteButton === 'function') {
          return pageFallback.findMarkCompleteButton(doc);
        }
        return firstMatching(doc, MARK_COMPLETE_SELECTORS);
      };
      if (behaviorMode === 'fast') {
        const btn = markButton();
        if (btn) {
          try { btn.click(); } catch (_) { /* ignore */ }
          rec('handler.outcome', { itemId: ctx.item && ctx.item.id, outcome: 'reading-done-fast', mode: behaviorMode });
          return { outcome: 'reading-done-fast' };
        }
        rec('handler.outcome', { itemId: ctx.item && ctx.item.id, outcome: 'reading-auto-fast', mode: behaviorMode });
        return { outcome: 'reading-auto-fast' };
      }
      const totalMs = timing.readingDwellMs(rng);
      const container = firstMatching(doc, READING_SELECTORS) || doc.body;
      await jitteredScroll(container, { totalMs: totalMs, rng: rng, signal: signal });
      const btn = markButton();
      if (btn) {
        try { btn.click(); } catch (_) { /* ignore */ }
        rec('handler.outcome', { itemId: ctx.item && ctx.item.id, outcome: 'reading-done', mode: behaviorMode });
        return { outcome: 'reading-done' };
      }
      rec('handler.outcome', { itemId: ctx.item && ctx.item.id, outcome: 'reading-auto', mode: behaviorMode });
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

    async function waitForVideoDuration(videoEl, signal, rec, itemId) {
      rec('video.duration.initial', { itemId: itemId, value: videoEl.duration });
      if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
        rec('video.duration.wait.completed', { itemId: itemId, duration: videoEl.duration, polls: 0 });
        return videoEl.duration;
      }
      rec('video.duration.wait.started', { itemId: itemId });
      let polls = 0;
      for (let i = 0; i < 20; i++) {
        await sleep(250, signal);
        polls++;
        if (Number.isFinite(videoEl.duration) && videoEl.duration > 0) {
          rec('video.duration.wait.completed', { itemId: itemId, duration: videoEl.duration, polls: polls });
          return videoEl.duration;
        }
      }
      rec('video.duration.wait.completed', { itemId: itemId, duration: videoEl.duration, polls: polls });
      return videoEl.duration;
    }

    async function seekVideoWithFallback(doc, videoEl, directTarget, fallbackTarget, signal, behaviorMode, rec, itemId) {
      try {
        videoEl.currentTime = directTarget;
      } catch (_) { /* read-only in some players */ }
      const directAccepted = Number.isFinite(videoEl.currentTime) && videoEl.currentTime >= directTarget - 5;
      rec('video.seek.direct.result', { itemId: itemId, attempted: true, accepted: directAccepted, currentTime: Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : null, targetTime: directTarget });
      if (directAccepted) return true;
      const fwd = doc.querySelector('button[aria-label*="Seek Video Forward" i], button[aria-label*="seek forward" i]');
      if (!fwd) {
        rec('video.seek.forward.result', { itemId: itemId, forwardFound: false, forwardClicks: 0, currentTime: Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : null, targetReached: false });
        return false;
      }
      const clickGapMs = behaviorMode === 'human' ? 350 : 60;
      let clicks = 0;
      while (clicks < 720 && (!Number.isFinite(videoEl.currentTime) || videoEl.currentTime < fallbackTarget - 5)) {
        try { fwd.click(); } catch (_) {
          rec('video.seek.forward.result', { itemId: itemId, forwardFound: true, forwardClicks: clicks, currentTime: Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : null, targetReached: false });
          return false;
        }
        clicks++;
        await sleep(clickGapMs, signal);
      }
      rec('video.seek.forward.result', { itemId: itemId, forwardFound: !!fwd, forwardClicks: clicks, currentTime: Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : null, targetReached: Number.isFinite(videoEl.currentTime) && videoEl.currentTime >= fallbackTarget - 5 });
      return Number.isFinite(videoEl.currentTime) && videoEl.currentTime >= fallbackTarget - 5;
    }

    async function video(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const behaviorMode = (ctx && ctx.behaviorMode) || 'fast';
      const itemId = ctx.item && ctx.item.id;
      rec('handler.start', { itemId: itemId, title: ctx.item && ctx.item.title, kind: 'video', behaviorMode: behaviorMode });
      // Coursera mounts the destination <video> via React shortly AFTER the
      // SPA route swap reports urlChanged=true. Poll a bounded window so the
      // handler does not pause the whole run just because the destination
      // player hasn't rendered yet. Abort-aware via ctx.signal.
      const waitRes = await waitForVideoElement(doc, signal, itemId);
      rec('video.element.wait.completed', { itemId: itemId, found: waitRes.found, polls: waitRes.polls, elapsedMs: waitRes.elapsedMs, timeoutMs: videoElementTimeoutMs });
      // Keep emitting `video.element` after the wait so the existing VIDEO
      // STATE snapshot projection (and prior tests) continue to see the
      // resolved final state.
      rec('video.element', { itemId: itemId, found: waitRes.found });
      if (!waitRes.found) {
        if (waitRes.reason === 'aborted') {
          rec('video.element.wait.aborted', { itemId: itemId, polls: waitRes.polls });
        } else if (waitRes.reason === 'timeout') {
          rec('video.element.wait.timeout', { itemId: itemId, found: false, polls: waitRes.polls, elapsedMs: waitRes.elapsedMs });
        }
        rec('handler.outcome', { itemId: itemId, outcome: 'video-no-element', mode: behaviorMode });
        return { outcome: 'video-no-element' };
      }
      const v = waitRes.el;

      // -------- Fast mode --------
      if (behaviorMode === 'fast') {
        // Best-effort play; ignore rejection (DRM/autoplay-block — handled by completion confirmer).
        rec('video.play.requested', { itemId: itemId });
        try {
          const p = v.play();
          if (p && typeof p.then === 'function') {
            p.then(
              function () { rec('video.play.result', { itemId: itemId, success: true, rejected: false }); },
              function () { rec('video.play.result', { itemId: itemId, success: false, rejected: true }); }
            );
          } else {
            rec('video.play.result', { itemId: itemId, success: true, rejected: false });
          }
        } catch (_) {
          rec('video.play.result', { itemId: itemId, success: false, rejected: true });
        }
        const duration = await waitForVideoDuration(v, signal, rec, itemId);
        const t = timing.fastVideoTiming(duration, rng);
        rec('video.mode.selected', { itemId: itemId, mode: 'fast', timing: t.mode });
        if (t.mode === 'fast-seek') {
          rec('video.seek.requested', { itemId: itemId, directTarget: t.targetTimeSec, fallbackTarget: t.targetTimeSec, mode: 'fast' });
          await seekVideoWithFallback(doc, v, t.targetTimeSec, t.targetTimeSec, signal, 'fast', rec, itemId);
        }
        // In Fast mode the controller will run the confirmer with a 5s primary timeout.
        // Wait the short post-seek window here so handlers don't return before the player flushes the 'completed' state.
        await sleep(t.postSeekWaitMs, signal);
        rec('handler.outcome', { itemId: itemId, outcome: 'video-done-fast', mode: behaviorMode });
        return { outcome: 'video-done-fast', mode: t.mode };
      }

      // -------- Human mode: brief opening watch, then a near-end seek --------
      let playError = null;
      let playSettled = false;
      rec('video.play.requested', { itemId: itemId });
      const playPromise = (function () {
        try {
          const p = v.play();
          if (p && typeof p.then === 'function') {
            return p.then(
              function () {
                playSettled = true;
                rec('video.play.result', { itemId: itemId, success: true, rejected: false });
              },
              function (e) {
                playSettled = true;
                playError = e;
                rec('video.play.result', { itemId: itemId, success: false, rejected: true });
              }
            );
          }
        } catch (e) { playSettled = true; playError = e; rec('video.play.result', { itemId: itemId, success: false, rejected: true }); }
        playSettled = true;
        return Promise.resolve();
      })();
      const duration = await waitForVideoDuration(v, signal, rec, itemId);
      const t = timing.videoTiming(duration, rng);
      rec('video.mode.selected', { itemId: itemId, mode: 'human', timing: t.mode });
      if (t.mode === 'seek') {
        await sleep(t.preSkipMs, signal);
        const endTarget = Math.max(t.targetTimeSec, duration - 10);
        rec('video.seek.requested', { itemId: itemId, directTarget: t.targetTimeSec, fallbackTarget: endTarget, mode: 'human' });
        await seekVideoWithFallback(doc, v, t.targetTimeSec, endTarget, signal, 'human', rec, itemId);
      }
      const ended = waitForEvent(v, 'ended', signal);
      const playFailed = playPromise.then(function () {
        return playError ? Promise.reject(new Error('autoplay-blocked')) : new Promise(function () { /* never resolves */ });
      });
      try {
        await Promise.race([ended, playFailed]);
      } catch (e) {
        if (e && e.message === 'autoplay-blocked') {
          rec('handler.outcome', { itemId: itemId, outcome: 'video-autoplay-blocked', mode: behaviorMode });
          return { outcome: 'video-autoplay-blocked', mode: t.mode };
        }
        throw e;
      }
      await sleep(t.postEndMs, signal);
      rec('handler.outcome', { itemId: itemId, outcome: 'video-done', mode: behaviorMode });
      return { outcome: 'video-done', mode: t.mode };
    }

    // videoRecovery: invoked by the controller AFTER the primary confirmer +
    // Mark-as-completed race have both failed to confirm a video. It re-finds
    // the <video> on the same active item, seeks very close to the end
    // (`duration - 1`), replays, briefly waits for an 'ended' event, and then
    // re-clicks Mark-as-completed. Returns `{ actionTaken, reason }`.
    // The controller is responsible for re-running the confirmer after this
    // returns — recovery does not itself decide completion.
    //
    // The handler never advances any cursor or persists state; that remains
    // the controller's invariant ("never advance until confirmed").
    async function videoRecovery(ctx) {
      const doc = ctx.doc;
      const item = ctx.item;
      const signal = ctx.signal;
      const itemId = item && item.id;
      rec('video.recovery.handler.entered', { itemId: itemId });

      const waitRes = await waitForVideoElement(doc, signal, itemId);
      if (!waitRes.found) {
        rec('video.recovery.handler.noElement', { itemId: itemId, reason: waitRes.reason });
        return { actionTaken: false, reason: 'no-video-element' };
      }
      if (signal && signal.aborted) {
        return { actionTaken: false, reason: 'aborted' };
      }
      const v = waitRes.el;

      const duration = await waitForVideoDuration(v, signal, rec, itemId);
      if (!Number.isFinite(duration) || duration <= 0) {
        rec('video.recovery.handler.noDuration', { itemId: itemId });
        return { actionTaken: false, reason: 'no-duration' };
      }

      // Seek as close to end as the player accepts — that is the segment most
      // likely to convince Coursera the video was watched. 1s buffer keeps us
      // off the very last frame in case the player rejects exact-duration seeks.
      const seekTarget = Math.max(0, duration - 1);
      let seekAccepted = false;
      try { v.currentTime = seekTarget; } catch (_) { /* read-only in some players */ }
      seekAccepted = Number.isFinite(v.currentTime) && v.currentTime >= seekTarget - 5;
      rec('video.recovery.handler.seekResult', { itemId: itemId, seekTarget: seekTarget, accepted: seekAccepted, currentTime: Number.isFinite(v.currentTime) ? v.currentTime : null });

      // Best-effort play. Autoplay rejection is non-fatal — the seek alone may
      // be enough to flip Coursera's "completed" state.
      try {
        const p = v.play();
        if (p && typeof p.then === 'function') p.then(function () {}, function () {});
      } catch (_) { /* ignore */ }

      // Wait for the 'ended' event OR a bounded timeout, whichever comes first.
      const endedPromise = waitForEvent(v, 'ended', signal).then(
        function () { return 'ended'; },
        function () { return 'aborted'; }
      );
      const timeoutPromise = new Promise(function (resolve) {
        const t = setTimeout(function () { resolve('timeout'); }, videoRecoveryEndWaitMs);
        if (signal && signal.addEventListener) {
          signal.addEventListener('abort', function () { clearTimeout(t); resolve('aborted'); }, { once: true });
        }
      });
      const waitOutcome = await Promise.race([endedPromise, timeoutPromise]);
      rec('video.recovery.handler.endWait', { itemId: itemId, outcome: waitOutcome });

      if (signal && signal.aborted) {
        return { actionTaken: true, reason: 'aborted' };
      }

      // Re-click Mark-as-completed. Coursera commonly rejects the first click
      // for a partially-watched short video but accepts it once the player has
      // advanced past the watched-enough threshold.
      let reclicked = false;
      if (pageFallback && typeof pageFallback.findMarkCompleteButton === 'function') {
        const btn = pageFallback.findMarkCompleteButton(doc);
        if (btn) {
          try { btn.click(); reclicked = true; } catch (_) { /* ignore */ }
        }
      }
      if (!reclicked) {
        const fb = firstMatching(doc, MARK_COMPLETE_SELECTORS);
        if (fb) {
          try { fb.click(); reclicked = true; } catch (_) { /* ignore */ }
        }
      }
      rec('video.recovery.handler.reclick', { itemId: itemId, clicked: reclicked });

      return { actionTaken: true, reason: 'recovery-acted' };
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
      const applier = answerApplier;
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

    function _suggestionsToStructured(suggestions) {
      const out = [];
      for (let i = 0; i < (suggestions || []).length; i++) {
        const s = suggestions[i];
        if (!s || s.applicable === false) continue;
        if (typeof s.questionNumber !== 'number') continue;
        const itm = { questionNumber: s.questionNumber, type: s.type };
        if (s.type === 'single_choice') itm.choiceText = s.choiceText;
        else if (s.type === 'multiple_choice') itm.choiceTexts = s.choiceTexts || [];
        else itm.value = s.value;
        out.push(itm);
      }
      return out;
    }

    function _mapStructured(raw, snapshot) {
      let structured = [];
      if (aiValidator && typeof aiValidator.validateAndMap === 'function') {
        const v = aiValidator.validateAndMap(raw, snapshot, { expectedToken: snapshot.token });
        if (v && v.ok) structured = _suggestionsToStructured(v.suggestions);
      }
      if (structured.length === 0 && aiPermissive && typeof aiPermissive.extract === 'function') {
        const p = aiPermissive.extract(raw, snapshot);
        if (p && p.suggestions) structured = _suggestionsToStructured(p.suggestions);
      }
      return structured;
    }

    // Build a reduced request payload for the questions still unmapped after the
    // first pass. Returns null when nothing-mapped (identical re-ask is useless)
    // or all-mapped (nothing to retry). Sanitized question .id is 'q'+number.
    function _unmappedPayload(sanitized, structured) {
      const mappedIds = {};
      for (let i = 0; i < structured.length; i++) mappedIds['q' + structured[i].questionNumber] = true;
      const all = sanitized.questions || [];
      const rest = all.filter(function (q) { return !mappedIds[q.id]; });
      if (rest.length === 0 || rest.length === all.length) return null;
      return Object.assign({}, sanitized, { questions: rest });
    }

    async function assessmentAi(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const mode = ctx.behaviorMode === 'human' ? 'human' : 'fast';
      const autoSubmit = !!ctx.autoSubmitQuizzes;
      const location = ctx.location || (doc && doc.defaultView && doc.defaultView.location) || { origin: '', href: '' };
      const aiGenerate = ctx.aiGenerate;
      rec('handler.start', { handler: 'assessment-ai', itemId: ctx.item && ctx.item.id });
      if (typeof aiGenerate !== 'function' || !questionContext || !answerApplier) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-answer', reason: 'no-ai-bridge' });
        return { outcome: 'assessment-ai-no-answer' };
      }
      if (courseraDom && typeof courseraDom.isExternalLaunchPage === 'function' && courseraDom.isExternalLaunchPage(doc, location.href)) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-skipped-lti' });
        return { outcome: 'assessment-skipped-lti' };
      }
      const region = (courseraDom && typeof courseraDom.assessmentRoot === 'function' && courseraDom.assessmentRoot(doc)) || doc.body;
      const snapshot = questionContext.buildQuestionSnapshot(region, location, doc);
      if (!snapshot || (snapshot.actionableCount || 0) === 0) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-answer', reason: 'no-actionable-questions' });
        return { outcome: 'assessment-ai-no-answer' };
      }
      const sanitized = questionContext.sanitizeForRequest(snapshot);
      let res;
      try {
        res = await aiGenerate(sanitized);
      } catch (e) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-answer', reason: 'generate-error' });
        return { outcome: 'assessment-ai-no-answer' };
      }
      if (res && res.ok !== true && res.reason === 'missing-key') {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-needs-key' });
        return { outcome: 'assessment-ai-needs-key' };
      }
      if (!res || res.ok !== true || !res.raw) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-answer', reason: 'no-raw' });
        return { outcome: 'assessment-ai-no-answer' };
      }
      let structured = _mapStructured(res.raw, snapshot);
      if (structured.length > 0 && structured.length < (snapshot.actionableCount || 0)) {
        const retryPayload = _unmappedPayload(sanitized, structured);
        if (retryPayload) {
          try {
            const res2 = await aiGenerate(retryPayload);
            if (res2 && res2.ok === true && res2.raw) {
              const more = _mapStructured(res2.raw, snapshot);
              const have = {};
              for (let i = 0; i < structured.length; i++) have[structured[i].questionNumber] = true;
              for (let j = 0; j < more.length; j++) if (!have[more[j].questionNumber]) structured.push(more[j]);
              rec('handler.retry', { handler: 'assessment-ai', added: more.length });
            }
          } catch (_) { /* retry is best-effort */ }
        }
      }
      if (structured.length === 0) {
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-answer', reason: 'no-mappable-answers' });
        return { outcome: 'assessment-ai-no-answer' };
      }
      if (mode === 'human' && timing && typeof timing.quizDwellMs === 'function') {
        await sleep(timing.quizDwellMs(rng), signal);
      }
      const summary = answerApplier.applyStructuredAnswers(structured, region, { verbose: false, deferText: true }) || { summary: { filled: 0 }, pendingText: [] };
      let filled = (summary.summary && summary.summary.filled) || 0;
      const pending = Array.isArray(summary.pendingText) ? summary.pendingText : [];
      for (let i = 0; i < pending.length; i++) {
        if (signal && signal.aborted) throw new Error('aborted');
        try {
          await typeIntoElement(pending[i].el, pending[i].value, mode, signal);
          filled += 1;
        } catch (e) {
          if (e && e.message === 'aborted') throw e;
        }
      }
      if (autoSubmit && filled > 0) {
        const submitBtn = firstMatching(doc, SUBMIT_SELECTORS);
        if (!submitBtn) {
          rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-no-submit-button', filled: filled });
          return { outcome: 'assessment-ai-no-submit-button', filled: filled };
        }
        try { submitBtn.click(); } catch (_) {}
        rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-submitted', filled: filled });
        return { outcome: 'assessment-ai-submitted', filled: filled };
      }
      rec('handler.outcome', { handler: 'assessment-ai', outcome: 'assessment-ai-answered-paused', filled: filled });
      return { outcome: 'assessment-ai-answered-paused', filled: filled };
    }

    const peerReviewHandler = (peerReviewMod && typeof peerReviewMod.createPeerReviewHandler === 'function')
      ? peerReviewMod.createPeerReviewHandler({
          sleep: sleep,
          timing: timing,
          replies: peerReviewReplies,
          typingEngine: typingEngine,
          typingInjector: typingInjector,
          courseraDom: courseraDom,
          debugRecorder: debugRecorder,
        })
      : async function () { return { outcome: 'peer-review-needs-user' }; };

    return {
      reading: reading,
      discussion: discussion,
      video: video,
      videoRecovery: videoRecovery,
      fallback: fallback,
      assignment: assignment,
      assessmentAi: assessmentAi,
      peerReview: peerReviewHandler,
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
