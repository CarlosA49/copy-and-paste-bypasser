// tests/autopilot-timing.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  randInt,
  videoTiming,
  readingDwellMs,
  discussionDwellMs,
  quizDwellMs,
  interItemGapMs,
  scrollStep,
  RANGES,
  MIN_VIDEO_DURATION_FOR_SKIP_SEC,
} = require('../lib/autopilot-timing.js');

function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('randInt returns integers in [lo, hi] inclusive', () => {
  const rng = seededRng(1);
  for (let i = 0; i < 200; i++) {
    const n = randInt(rng, 5, 10);
    assert.ok(Number.isInteger(n));
    assert.ok(n >= 5 && n <= 10, 'expected 5..10, got ' + n);
  }
});

test('videoTiming: short video (<90 s) -> play-through', () => {
  const r = videoTiming(60, seededRng(1));
  assert.equal(r.mode, 'play-through');
  assert.equal(r.preSkipMs, 0);
  assert.equal(r.targetTimeSec, null);
  assert.ok(r.postEndMs >= 5000 && r.postEndMs <= 10000);
});

test('videoTiming: NaN/missing duration -> play-through', () => {
  const r = videoTiming(NaN, seededRng(1));
  assert.equal(r.mode, 'play-through');
});

test('videoTiming: just-below-threshold duration (89) -> play-through', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const r = videoTiming(89, seededRng(seed));
    assert.equal(r.mode, 'play-through');
  }
});

test('videoTiming: long video -> seek mode after a short opening watch, target near end', () => {
  const rng = seededRng(1);
  const duration = 600;
  const r = videoTiming(duration, rng);
  assert.equal(r.mode, 'seek');
  assert.ok(r.preSkipMs >= 5000 && r.preSkipMs <= 12000, 'Human mode watches the opening briefly before seeking');
  assert.ok(r.targetTimeSec >= duration - 70 && r.targetTimeSec <= duration - 50,
    'targetTimeSec ' + r.targetTimeSec + ' should be in [duration-70, duration-50]');
  assert.ok(r.postEndMs >= 5000 && r.postEndMs <= 10000);
});

test('videoTiming: boundary duration (90) -> seek mode (threshold is inclusive at 90)', () => {
  // 90 is NOT < 90, so it enters seek mode. targetTime = 90 - seekFromEnd(50..70) = 20..40.
  const r = videoTiming(90, seededRng(1));
  assert.equal(r.mode, 'seek');
  assert.ok(r.preSkipMs >= 5000 && r.preSkipMs <= 12000);
  assert.ok(r.targetTimeSec >= 20 && r.targetTimeSec <= 40);
});

test('readingDwellMs in [120000, 180000]', () => {
  const rng = seededRng(1);
  for (let i = 0; i < 50; i++) {
    const v = readingDwellMs(rng);
    assert.ok(v >= 120000 && v <= 180000);
  }
});

test('discussionDwellMs in [120000, 180000]', () => {
  const rng = seededRng(1);
  for (let i = 0; i < 50; i++) {
    const v = discussionDwellMs(rng);
    assert.ok(v >= 120000 && v <= 180000);
  }
});

test('quizDwellMs in [120000, 180000]', () => {
  const rng = seededRng(1);
  for (let i = 0; i < 50; i++) {
    const v = quizDwellMs(rng);
    assert.ok(v >= 120000 && v <= 180000);
  }
});

test('interItemGapMs in [8000, 18000]', () => {
  const rng = seededRng(1);
  for (let i = 0; i < 50; i++) {
    const v = interItemGapMs(rng);
    assert.ok(v >= 8000 && v <= 18000);
  }
});

test('scrollStep returns intervalMs in [3000, 8000] and pixels in [200, 500]', () => {
  const rng = seededRng(1);
  for (let i = 0; i < 50; i++) {
    const s = scrollStep(rng);
    assert.ok(s.intervalMs >= 3000 && s.intervalMs <= 8000);
    assert.ok(s.pixels >= 200 && s.pixels <= 500);
  }
});

test('exports RANGES and constants', () => {
  assert.deepEqual(RANGES.videoSeekFromEndSec, [50, 70]);
  assert.deepEqual(RANGES.videoPostEndSec, [5, 10]);
  assert.deepEqual(RANGES.videoInitialWatchSec, [5, 12]);
  assert.equal(MIN_VIDEO_DURATION_FOR_SKIP_SEC, 90);
});

const timing = require('../lib/autopilot-timing.js');

test('fastVideoTiming: returns mode "fast-seek" and targetTimeSec = max(0, duration - 45)', () => {
  const t = timing.fastVideoTiming(180, function () { return 0.5; });
  assert.equal(t.mode, 'fast-seek');
  assert.equal(t.targetTimeSec, 135);
  assert.equal(t.postSeekWaitMs, 5000);
});

test('fastVideoTiming: very short video (< 45s) clamps targetTimeSec to 0', () => {
  const t = timing.fastVideoTiming(20, function () { return 0.5; });
  assert.equal(t.mode, 'fast-seek');
  assert.equal(t.targetTimeSec, 0);
});

test('fastVideoTiming: unknown duration (NaN) returns targetTimeSec = null and play-through mode', () => {
  const t = timing.fastVideoTiming(NaN, function () { return 0.5; });
  assert.equal(t.mode, 'fast-play-through');
  assert.equal(t.targetTimeSec, null);
});

test('FAST_VIDEO_SEEK_FROM_END_SEC = 45, FAST_POST_SEEK_WAIT_MS = 5000', () => {
  assert.equal(timing.FAST_VIDEO_SEEK_FROM_END_SEC, 45);
  assert.equal(timing.FAST_POST_SEEK_WAIT_MS, 5000);
});

const peerTiming = require('../lib/autopilot-timing.js');

test('peerInterCriterionMs in [2000, 6000]', () => {
  const rng = seededRng(1);
  for (let i = 0; i < 50; i++) {
    const v = peerTiming.peerInterCriterionMs(rng);
    assert.ok(v >= 2000 && v <= 6000, 'got ' + v);
  }
});

test('peerInterFieldMs in [1000, 4000]', () => {
  const rng = seededRng(2);
  for (let i = 0; i < 50; i++) {
    const v = peerTiming.peerInterFieldMs(rng);
    assert.ok(v >= 1000 && v <= 4000, 'got ' + v);
  }
});

test('peerPreSubmitMs in [3000, 8000]', () => {
  const rng = seededRng(3);
  for (let i = 0; i < 50; i++) {
    const v = peerTiming.peerPreSubmitMs(rng);
    assert.ok(v >= 3000 && v <= 8000, 'got ' + v);
  }
});

test('exports peer-review RANGES', () => {
  assert.deepEqual(peerTiming.RANGES.peerInterCriterionSec, [2, 6]);
  assert.deepEqual(peerTiming.RANGES.peerInterFieldSec, [1, 4]);
  assert.deepEqual(peerTiming.RANGES.peerPreSubmitSec, [3, 8]);
});
