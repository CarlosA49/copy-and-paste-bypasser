// Pure, deterministic-with-injected-clock typing state machine.
// No DOM. Emits tick events with the next character or a backspace, plus
// scheduled delays. Caller owns actually inserting the character.
(function (root) {
  'use strict';

  const SPEED_PROFILES = {
    Slow:   { delayMul: 1.25, pauseMul: 1.15 },
    Normal: { delayMul: 1.00, pauseMul: 1.00 },
    Fast:   { delayMul: 0.72, pauseMul: 0.75 },
  };

  const TYPING_PROFILES = {
    'Balanced Natural': {
      charDelay: [40, 130], wordPause: [70, 180], sentencePause: [500, 1300],
      paragraphPause: [1000, 2500], longPauseProb: 0.045, longPause: [5000, 12000],
      typoProb: 1/210, burstLen: [8, 25], hesitation: [150, 750],
    },
    'Careful Writer': {
      charDelay: [60, 160], wordPause: [100, 240], sentencePause: [900, 2250],
      paragraphPause: [1800, 4300], longPauseProb: 0.035, longPause: [5000, 14000],
      typoProb: 1/420, burstLen: [7, 18], hesitation: [200, 900],
    },
    'Fast Drafter': {
      charDelay: [20, 80], wordPause: [40, 120], sentencePause: [350, 1000],
      paragraphPause: [850, 2000], longPauseProb: 0.025, longPause: [5000, 9000],
      typoProb: 1/155, burstLen: [12, 32], hesitation: [80, 450],
    },
  };

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  function TypingEngine(deps) {
    deps = deps || {};
    this._now = deps.now || function () { return Date.now(); };
    this._sleep = deps.sleep || function (ms, cb) { setTimeout(cb, ms); };
    this._random = deps.random || Math.random;
    this._state = 'idle';
    this._opts = null;
    this._i = 0;
    this._total = 0;
    this._pendingResumeAt = 0;
  }

  TypingEngine.prototype.getState = function () { return this._state; };

  TypingEngine.prototype.start = function (opts) {
    opts = opts || {};
    if (this._state === 'running' || this._state === 'paused') return;
    const profile = TYPING_PROFILES[opts.profile] || TYPING_PROFILES['Balanced Natural'];
    const speed = SPEED_PROFILES[opts.speed] || SPEED_PROFILES.Normal;
    this._opts = {
      text: typeof opts.text === 'string' ? opts.text : '',
      target: opts.target || null,
      profile: profile,
      speed: speed,
      simulateTypos: !!opts.simulateTypos,
      onTick: typeof opts.onTick === 'function' ? opts.onTick : function () {},
      onDone: typeof opts.onDone === 'function' ? opts.onDone : function () {},
    };
    this._i = 0;
    this._total = this._opts.text.length;
    this._state = 'running';
    if (this._total === 0) { this._finish(); return; }
    this._scheduleNext(0);
  };

  TypingEngine.prototype.pause = function () {
    if (this._state === 'running') this._state = 'paused';
  };

  TypingEngine.prototype.resume = function () {
    if (this._state !== 'paused') return;
    this._state = 'running';
    this._scheduleNext(0);
  };

  TypingEngine.prototype.stop = function () {
    if (this._state === 'idle' || this._state === 'done') return;
    this._state = 'stopped';
  };

  TypingEngine.prototype._range = function (range, mul) {
    const lo = range[0] * mul;
    const hi = range[1] * mul;
    return lo + this._random() * (hi - lo);
  };

  TypingEngine.prototype._delayBeforeChar = function (ch) {
    const p = this._opts.profile;
    const sp = this._opts.speed;
    const base = this._range(p.charDelay, sp.delayMul);
    // Word boundary
    if (ch === ' ') return base + this._range(p.wordPause, sp.pauseMul);
    // Sentence boundary trailing char
    if (/[.!?]/.test(ch)) return base + this._range(p.sentencePause, sp.pauseMul);
    // Paragraph boundary
    if (ch === '\n') return base + this._range(p.paragraphPause, sp.pauseMul);
    // Long thinking pause
    if (this._random() < p.longPauseProb) return base + this._range(p.longPause, sp.pauseMul);
    return base;
  };

  TypingEngine.prototype._emitTypo = function (atTime) {
    // Pick a wrong-but-adjacent character; emit it, then a backspace, then the real char.
    const text = this._opts.text;
    const real = text[this._i];
    const wrong = pickAdjacentKey(real, this._random);
    if (!wrong) return false; // no good substitute, skip typo
    this._opts.onTick({ kind: 'char', char: wrong, index: this._i, total: this._total, at: atTime });
    const corrDelay = clamp(80 + this._random() * 220, 80, 350);
    const self = this;
    this._sleep(corrDelay, function () {
      if (self._state !== 'running') return;
      const t = self._now();
      self._opts.onTick({ kind: 'backspace', char: null, index: self._i, total: self._total, at: t });
      const reDelay = clamp(60 + self._random() * 140, 60, 220);
      self._sleep(reDelay, function () {
        if (self._state !== 'running') return;
        const t2 = self._now();
        self._opts.onTick({ kind: 'char', char: real, index: self._i, total: self._total, at: t2 });
        self._i += 1;
        if (self._i >= self._total) self._finish();
        else self._scheduleNext(self._delayBeforeChar(self._opts.text[self._i]));
      });
    });
    return true;
  };

  TypingEngine.prototype._scheduleNext = function (delay) {
    if (this._state !== 'running') return;
    const self = this;
    this._sleep(delay, function () { self._fire(); });
  };

  TypingEngine.prototype._fire = function () {
    if (this._state !== 'running') return;
    if (this._i >= this._total) { this._finish(); return; }
    const real = this._opts.text[this._i];
    const atTime = this._now();
    // Maybe inject a typo for this character.
    if (this._opts.simulateTypos && isTypoEligible(real) && this._random() < this._opts.profile.typoProb * 30) {
      // 30x boost relative to the per-char prob so typos appear on short texts in tests too.
      const ok = this._emitTypo(atTime);
      if (ok) return;
    }
    this._opts.onTick({ kind: 'char', char: real, index: this._i, total: this._total, at: atTime });
    this._i += 1;
    if (this._i >= this._total) { this._finish(); return; }
    this._scheduleNext(this._delayBeforeChar(this._opts.text[this._i]));
  };

  TypingEngine.prototype._finish = function () {
    if (this._state === 'stopped') return;
    this._state = 'done';
    this._opts.onDone();
  };

  function isTypoEligible(ch) {
    return /[a-zA-Z]/.test(ch);
  }

  function pickAdjacentKey(ch, random) {
    if (!/[a-zA-Z]/.test(ch)) return null;
    const lower = ch.toLowerCase();
    const NEIGHBOURS = {
      a:'sq', b:'vn', c:'xv', d:'sf', e:'rw', f:'dg', g:'fh', h:'gj',
      i:'uo', j:'hk', k:'jl', l:'k', m:'n', n:'bm', o:'ip', p:'o',
      q:'wa', r:'et', s:'ad', t:'ry', u:'yi', v:'cb', w:'qe', x:'zc',
      y:'tu', z:'x',
    };
    const opts = NEIGHBOURS[lower];
    if (!opts) return null;
    const pick = opts[Math.floor(random() * opts.length)];
    return ch === lower ? pick : pick.toUpperCase();
  }

  const api = { TypingEngine: TypingEngine, SPEED_PROFILES: SPEED_PROFILES, TYPING_PROFILES: TYPING_PROFILES };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.typingEngine = api;
  }
})(typeof self !== 'undefined' ? self : this);
