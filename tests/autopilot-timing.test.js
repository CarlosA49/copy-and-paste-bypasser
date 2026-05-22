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
  SEEK_BUFFER_SEC,
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

test('videoTiming: short video -> play-through', () => {
  const r = videoTiming(120, seededRng(1));
  assert.equal(r.mode, 'play-through');
  assert.equal(r.preSkipMs, 0);
  assert.equal(r.targetTimeSec, null);
  assert.ok(r.postEndMs >= 10000 && r.postEndMs <= 20000);
});

test('videoTiming: NaN/missing duration -> play-through', () => {
  const r = videoTiming(NaN, seededRng(1));
  assert.equal(r.mode, 'play-through');
});

test('videoTiming: long video -> seek mode, preSkip below targetTime - buffer', () => {
  const rng = seededRng(1);
  const duration = 600; // 10 min
  const r = videoTiming(duration, rng);
  assert.equal(r.mode, 'seek');
  // targetTime is duration - 60..120
  assert.ok(r.targetTimeSec >= duration - 120 && r.targetTimeSec <= duration - 60);
  // preSkipMs must be strictly less than (targetTimeSec - SEEK_BUFFER_SEC) * 1000
  const preSkipSec = r.preSkipMs / 1000;
  assert.ok(preSkipSec >= 60, 'preSkip >= 60 s');
  assert.ok(preSkipSec <= 300, 'preSkip <= 300 s');
  assert.ok(preSkipSec <= r.targetTimeSec - SEEK_BUFFER_SEC,
    'preSkip ' + preSkipSec + ' must be <= targetTime - buffer (' + (r.targetTimeSec - SEEK_BUFFER_SEC) + ')');
  assert.ok(r.postEndMs >= 10000 && r.postEndMs <= 20000);
});

test('videoTiming: just-below-threshold duration -> play-through fallback', () => {
  // 179 < MIN_VIDEO_DURATION_FOR_SKIP_SEC (180) -> early-return play-through for all seeds.
  for (let seed = 1; seed <= 20; seed++) {
    const r = videoTiming(179, seededRng(seed));
    assert.equal(r.mode, 'play-through');
  }
});

test('videoTiming: cap-fallback at borderline duration where maxPreSkip < 60', () => {
  // duration 185: implementation draws postEndMs first (randInt 10..20), then seekFromEnd (60..120).
  // Force seekFromEnd close to 120 so targetTime=65, maxPreSkip=55, below the 60 threshold.
  const forcedRng = (function () {
    const seq = [
      0.5,  // randInt(rng, 10, 20) -> postEndMs (value irrelevant for this assertion)
      0.99, // randInt(rng, 60, 120) -> seekFromEnd ~120 -> targetTime=65, maxPreSkip=55
    ];
    let i = 0;
    return function () { return seq[i++] || 0; };
  })();
  const r = videoTiming(185, forcedRng);
  assert.equal(r.mode, 'play-through', 'tight cap should force play-through');
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
  assert.ok(RANGES.videoPreSkipSec);
  assert.equal(MIN_VIDEO_DURATION_FOR_SKIP_SEC, 180);
  assert.equal(SEEK_BUFFER_SEC, 10);
});
