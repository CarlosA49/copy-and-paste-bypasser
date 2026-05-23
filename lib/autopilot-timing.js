// lib/autopilot-timing.js
// Pure RNG-driven timing helpers for the module autopilot. All ranges named.
(function (root) {
  'use strict';

  const RANGES = {
    videoSeekFromEndSec: [50, 70],
    videoPostEndSec: [5, 10],
    readingDwellSec: [120, 180],
    discussionDwellSec: [120, 180],
    quizDwellSec: [120, 180],
    interItemGapSec: [8, 18],
    scrollStepIntervalSec: [3, 8],
    scrollStepPx: [200, 500],
  };

  const MIN_VIDEO_DURATION_FOR_SKIP_SEC = 90;

  function randInt(rng, lo, hi) {
    // [lo, hi] inclusive
    return Math.floor(rng() * (hi - lo + 1)) + lo;
  }

  function videoTiming(durationSec, rng) {
    const postEndMs = randInt(rng, RANGES.videoPostEndSec[0], RANGES.videoPostEndSec[1]) * 1000;
    if (!Number.isFinite(durationSec) || durationSec < MIN_VIDEO_DURATION_FOR_SKIP_SEC) {
      return { mode: 'play-through', preSkipMs: 0, targetTimeSec: null, postEndMs: postEndMs };
    }
    const seekFromEnd = randInt(rng, RANGES.videoSeekFromEndSec[0], RANGES.videoSeekFromEndSec[1]);
    const targetTimeSec = durationSec - seekFromEnd;
    return {
      mode: 'seek',
      preSkipMs: 0,
      targetTimeSec: targetTimeSec,
      postEndMs: postEndMs,
    };
  }

  function readingDwellMs(rng)    { return randInt(rng, RANGES.readingDwellSec[0],    RANGES.readingDwellSec[1])    * 1000; }
  function discussionDwellMs(rng) { return randInt(rng, RANGES.discussionDwellSec[0], RANGES.discussionDwellSec[1]) * 1000; }
  function quizDwellMs(rng)       { return randInt(rng, RANGES.quizDwellSec[0],       RANGES.quizDwellSec[1])       * 1000; }
  function interItemGapMs(rng)    { return randInt(rng, RANGES.interItemGapSec[0],    RANGES.interItemGapSec[1])    * 1000; }

  function scrollStep(rng) {
    return {
      intervalMs: randInt(rng, RANGES.scrollStepIntervalSec[0], RANGES.scrollStepIntervalSec[1]) * 1000,
      pixels:     randInt(rng, RANGES.scrollStepPx[0],          RANGES.scrollStepPx[1]),
    };
  }

  const api = {
    RANGES: RANGES,
    MIN_VIDEO_DURATION_FOR_SKIP_SEC: MIN_VIDEO_DURATION_FOR_SKIP_SEC,
    randInt: randInt,
    videoTiming: videoTiming,
    readingDwellMs: readingDwellMs,
    discussionDwellMs: discussionDwellMs,
    quizDwellMs: quizDwellMs,
    interItemGapMs: interItemGapMs,
    scrollStep: scrollStep,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.autopilotTiming = api;
  }
})(typeof self !== 'undefined' ? self : this);
