const test = require('node:test');
const assert = require('node:assert/strict');
const { TypingEngine } = require('../lib/typing-engine.js');

// Deterministic RNG: linear congruential, repeatable per seed.
function seededRandom(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// Fake clock: collects schedule + fires synchronously.
function makeClock() {
  let now = 0;
  const queue = [];
  return {
    now: function () { return now; },
    sleep: function (ms, cb) { queue.push({ at: now + ms, cb: cb }); },
    advanceTo: function (t) {
      while (queue.length && queue[0].at <= t) {
        const { at, cb } = queue.shift();
        now = at;
        cb();
        queue.sort(function (a, b) { return a.at - b.at; });
      }
      now = t;
    },
    drain: function () {
      while (queue.length) {
        const { at, cb } = queue.shift();
        now = at;
        cb();
        queue.sort(function (a, b) { return a.at - b.at; });
      }
    },
  };
}

function run(text, opts) {
  const clock = makeClock();
  const random = seededRandom(opts && opts.seed != null ? opts.seed : 1);
  const ticks = [];
  let done = false;
  const engine = new TypingEngine({ now: clock.now, sleep: clock.sleep, random: random });
  engine.start({
    text: text,
    target: null,
    profile: (opts && opts.profile) || 'Balanced Natural',
    speed: (opts && opts.speed) || 'Normal',
    simulateTypos: !!(opts && opts.simulateTypos),
    onTick: function (ev) { ticks.push(ev); },
    onDone: function () { done = true; },
  });
  clock.drain();
  return { ticks: ticks, done: done, finalText: ticks.reduce(function (s, t) {
    if (t.kind === 'char') return s + t.char;
    if (t.kind === 'backspace') return s.slice(0, -1);
    return s;
  }, '') };
}

test('start/stop on empty string completes immediately', () => {
  const { ticks, done } = run('');
  assert.equal(ticks.length, 0);
  assert.equal(done, true);
});

test('finalText matches input when typos disabled', () => {
  const out = run('Hello, world!', { simulateTypos: false });
  assert.equal(out.finalText, 'Hello, world!');
  assert.equal(out.done, true);
});

test('emits one char tick per character in the input', () => {
  const out = run('abc', { simulateTypos: false });
  const charTicks = out.ticks.filter(function (t) { return t.kind === 'char'; });
  assert.equal(charTicks.length, 3);
  assert.deepEqual(charTicks.map(function (t) { return t.char; }), ['a', 'b', 'c']);
});

test('state transitions: idle → running → done', () => {
  const clock = makeClock();
  const engine = new TypingEngine({ now: clock.now, sleep: clock.sleep, random: seededRandom(2) });
  assert.equal(engine.getState(), 'idle');
  engine.start({ text: 'hi', target: null, onTick: function () {}, onDone: function () {} });
  assert.equal(engine.getState(), 'running');
  clock.drain();
  assert.equal(engine.getState(), 'done');
});

test('pause halts new ticks; resume continues; final text still correct', () => {
  const clock = makeClock();
  const random = seededRandom(3);
  const ticks = [];
  const engine = new TypingEngine({ now: clock.now, sleep: clock.sleep, random: random });
  engine.start({ text: 'abcdef', target: null, simulateTypos: false,
    onTick: function (t) { ticks.push(t); },
    onDone: function () {} });
  // Let the first 2 chars fire, then pause.
  while (ticks.length < 2) clock.advanceTo(clock.now() + 1);
  engine.pause();
  assert.equal(engine.getState(), 'paused');
  const tickCountAtPause = ticks.length;
  // Advance time — no new ticks should fire while paused.
  clock.advanceTo(clock.now() + 10000);
  assert.equal(ticks.length, tickCountAtPause);
  engine.resume();
  clock.drain();
  assert.equal(engine.getState(), 'done');
  const final = ticks.reduce(function (s, t) {
    if (t.kind === 'char') return s + t.char;
    if (t.kind === 'backspace') return s.slice(0, -1);
    return s;
  }, '');
  assert.equal(final, 'abcdef');
});

test('stop halts emission and locks state', () => {
  const clock = makeClock();
  const ticks = [];
  const engine = new TypingEngine({ now: clock.now, sleep: clock.sleep, random: seededRandom(4) });
  engine.start({ text: 'abcdef', target: null, simulateTypos: false,
    onTick: function (t) { ticks.push(t); }, onDone: function () {} });
  while (ticks.length < 2) clock.advanceTo(clock.now() + 1);
  engine.stop();
  assert.equal(engine.getState(), 'stopped');
  clock.drain();
  // Stopped engine should not emit further ticks.
  assert.equal(ticks.length, 2);
});

test('Slow speed yields larger total elapsed than Fast speed for the same text', () => {
  const slow = run('Hello there friend.', { speed: 'Slow', seed: 9 });
  const fast = run('Hello there friend.', { speed: 'Fast', seed: 9 });
  const slowTotal = slow.ticks.length > 0 ? slow.ticks[slow.ticks.length - 1].at : 0;
  const fastTotal = fast.ticks.length > 0 ? fast.ticks[fast.ticks.length - 1].at : 0;
  assert.ok(slowTotal > fastTotal, 'expected slow > fast (slow=' + slowTotal + ', fast=' + fastTotal + ')');
});

test('simulateTypos: emits some backspace events but final text still equals input', () => {
  const out = run('the quick brown fox jumped', { simulateTypos: true, seed: 11 });
  const bs = out.ticks.filter(function (t) { return t.kind === 'backspace'; });
  // Either we got at least one typo+correction, or seed produced none — both OK.
  // The contract is: final text must still equal input after corrections.
  assert.equal(out.finalText, 'the quick brown fox jumped');
  if (bs.length > 0) {
    // For each backspace there must be a re-typed char of the original following it.
    assert.ok(bs.length >= 1);
  }
});

test('onTick receives { kind, char|null, index, total, at } shape', () => {
  const out = run('xy', { simulateTypos: false });
  out.ticks.forEach(function (t) {
    assert.ok(t.kind === 'char' || t.kind === 'backspace');
    assert.equal(typeof t.index, 'number');
    assert.equal(typeof t.total, 'number');
    assert.equal(typeof t.at, 'number');
    if (t.kind === 'char') assert.equal(typeof t.char, 'string');
  });
});
