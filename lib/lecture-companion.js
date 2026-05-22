// lib/lecture-companion.js
(function (root) {
  'use strict';

  function getScraper(rootRef) {
    if (typeof require !== 'undefined') {
      try { return require('./transcript-scraper.js'); } catch (_) { /* browser */ }
    }
    const r = (rootRef && rootRef.ClipboardCleaner) || {};
    return r.transcriptScraper;
  }

  function getSynthesizer(rootRef) {
    if (typeof require !== 'undefined') {
      try { return require('./lecture-synthesizer.js'); } catch (_) { /* browser */ }
    }
    const r = (rootRef && rootRef.ClipboardCleaner) || {};
    return r.lectureSynthesizer;
  }

  function createCompanion(opts) {
    opts = opts || {};
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    const onDraft = typeof opts.onDraft === 'function' ? opts.onDraft : function () {};
    const debounceMs = typeof opts.debounceMs === 'number' ? opts.debounceMs : 400;
    const random = typeof opts.random === 'function' ? opts.random : Math.random;
    const scraper = opts.scraper || getScraper(typeof window !== 'undefined' ? window : null);
    const synth = opts.synthesizer || getSynthesizer(typeof window !== 'undefined' ? window : null);

    let timer = null;
    let attachedVideo = null;
    let observer = null;

    function trigger() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        if (!scraper || !synth) return;
        const t = scraper.scrapeTranscript(doc);
        if (!t || !t.cues || t.cues.length === 0) return;
        const draft = synth.generateDraft({
          cues: t.cues,
          lectureTitle: t.lectureTitle,
          weekObjective: t.weekObjective,
          random: random,
        });
        if (draft) onDraft(draft);
      }, debounceMs);
    }

    function attach(video) {
      if (!video || attachedVideo === video) return;
      attachedVideo = video;
      video.addEventListener('pause', trigger);
      video.addEventListener('ended', trigger);
    }

    function init() {
      if (!doc) return;
      const v = scraper && scraper.findVideoElement ? scraper.findVideoElement(doc) : doc.querySelector('video');
      if (v) { attach(v); return; }
      if (typeof doc.defaultView === 'undefined' || !doc.defaultView.MutationObserver) return;
      observer = new doc.defaultView.MutationObserver(function () {
        const v2 = scraper && scraper.findVideoElement ? scraper.findVideoElement(doc) : doc.querySelector('video');
        if (v2) {
          attach(v2);
          if (observer) { observer.disconnect(); observer = null; }
        }
      });
      observer.observe(doc.body, { childList: true, subtree: true });
    }

    function destroy() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (observer) { observer.disconnect(); observer = null; }
      if (attachedVideo) {
        attachedVideo.removeEventListener('pause', trigger);
        attachedVideo.removeEventListener('ended', trigger);
        attachedVideo = null;
      }
    }

    return { init: init, destroy: destroy, _trigger: trigger };
  }

  const api = { createCompanion: createCompanion };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.lectureCompanion = api;
  }
})(typeof self !== 'undefined' ? self : this);
