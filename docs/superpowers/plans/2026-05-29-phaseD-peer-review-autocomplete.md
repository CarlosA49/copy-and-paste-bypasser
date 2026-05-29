# Peer-Review Auto-Complete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated peer-review autopilot path that detects each rubric criterion, selects the highest-scoring option per criterion, fills every required comment from a varied human-sounding pool, and auto-submits — the single deliberate exception to the fill-and-pause rule.

**Architecture:** Two new IIFE modules (`lib/peer-review-replies.js` = comment pool + `pickComment`; `lib/peer-review.js` = rubric/comment/submit detection + handler) plug into the existing autopilot via `item-handlers.createHandlers` (new `peerReview` handler entry) and `module-autopilot.handlerForKind` routing. Human-mode timing comes from new named ranges in `autopilot-timing.js`; new outcome tokens (`peer-review-submitted`, `peer-review-needs-user`) are classified in `module-autopilot.js`. All detection/fill/submit is scoped via the Phase-A `coursera-dom` public API (injected, lazily resolved, degrades gracefully) and hard-excludes the extension's own sidebar and the Boost support chat.

**Tech Stack:** Chrome MV3 content scripts; IIFE modules registered on `window.ClipboardCleaner.*`; tests run under `node --test` with `jsdom`.

**Depends on Phase A:** `lib/coursera-dom.js` (`window.ClipboardCleaner.courseraDom`) — this plan consumes ONLY its spec-documented public API (`isExcludedNode`, `assessmentRoot`, `withinAssessment`, `findNextItemButton`, plus `parseLearnUrl`/`classifyKind`/`parseItemAccessibleName`/`itemStatus`/`findOutlineNav`/`findModuleRegions`/`findItemLinks`/`isExternalLaunchPage`). Treat it as already loaded. Never redefine it. Inject it via `deps.courseraDom` or resolve `root.ClipboardCleaner.courseraDom` lazily at call time, and degrade gracefully to a hardcoded `#ccp-host` / Boost-chat exclusion when absent so Phase D can land and test independently of A.

---

## File Structure

| File | Create/Modify | Responsibility |
|---|---|---|
| `lib/peer-review-replies.js` | Create | Pool of ~20 generic, domain-neutral, human-sounding review comments + `pickComment(history, minLength, random)` that avoids recent picks and pads to `minLength`. |
| `lib/peer-review.js` | Create | Pure rubric/comment/submit detection helpers (`detectCriteria`, `selectHighestOption`, `findRequiredCommentBoxes`, `findSubmitControl`) + `createPeerReviewHandler(deps)` returning an `async (ctx)` handler that selects options, fills comments, and auto-submits. Scopes all DOM access via injected `courseraDom`, excluding extension/Boost nodes. |
| `tests/peer-review-replies.test.js` | Create | Unit tests for the comment pool (count, length, uniqueness, history avoidance, min-length padding, determinism). |
| `tests/peer-review.test.js` | Create | jsdom tests for rubric fixtures: highest-option selection (with/without points + low-confidence flag), comment fill, auto-submit click, human-mode timing within range (seeded RNG), exclusion of extension/Boost nodes, graceful degradation without `courseraDom`. |
| `lib/autopilot-timing.js` | Modify (RANGES @ L6-16; helpers near L41-44; api @ L64-77) | Add `peerInterCriterionSec`/`peerInterFieldSec`/`peerPreSubmitSec` ranges + `peerInterCriterionMs`/`peerInterFieldMs`/`peerPreSubmitMs(rng)` helpers and export them. |
| `tests/autopilot-timing.test.js` | Modify (append tests) | Assert the three new dwell helpers fall within their RANGES over 50 seeded iterations + a `deepEqual` on each new RANGES entry. |
| `lib/item-handlers.js` | Modify (createHandlers deps @ L84-95; return map @ L556-563) | Destructure injected `peerReview` (the `lib/peer-review.js` factory) + `peerReviewReplies` pool; add a `peerReview` entry to the returned handler map, wiring the injected modules + timing + typing + sleep, and lazily resolving them from `root.ClipboardCleaner` when not injected. |
| `tests/item-handlers.test.js` | Modify (append tests) | Assert `createHandlers` returns a `peerReview` handler and that it routes through the injected peer-review factory (fills + submits a rubric fixture). |
| `lib/module-autopilot.js` (Task 6) | Modify (isFailureOutcome @ L71-82; FAILURE_REASON_TEXT @ L146-157; handlerForKind @ L918-922; api export @ L2115) | Classify `peer-review-submitted` as NON-failure (advances cursor) and `peer-review-needs-user` as a recognized pause; route `peer`/`peer-review` kind to `handlers.peerReview`; export `_isFailureOutcome`/`_reasonText` test hooks. |
| `lib/module-autopilot.js` (Task 8) | Modify (confirmer guard @ L1163-1165; generic success line @ L1469-1471; usedReply→FIFO history @ L1494-1496; formatter near reasonText @ L159-162; api export @ L2115) | SKIP `confirmer.waitForCompletion` for `peer-review-submitted` (the submit click is its own completion signal — closes the no-completion-indicator pause); suppress the duplicate generic `✓` line for the peer success token; fold `outcome.usedComments` into the FIFO `replyHistory`; add + export pure `formatPeerReviewLogLines`. |
| `tests/module-autopilot.test.js` | Modify (append tests) | Task 6: assert `isFailureOutcome` returns false for `peer-review-submitted` / true for `peer-review-needs-user` and `reasonText` maps the pause token; indirect routing test. Task 8: formatter tests (incl. pluralization) + two end-to-end run-loop tests proving the peer success path advances without calling the confirmer and that `usedComments` thread into the next item's `ctx.replyHistory`. |
| `manifest.json` | Modify (content_scripts[0].js @ L26-60) | Insert `lib/peer-review-replies.js` then `lib/peer-review.js` immediately before `lib/item-handlers.js` (and after the Phase-A `lib/coursera-dom.js` once it lands). |
| `content.js` | Modify (createHandlers call @ L96-127) | Inject `peerReviewReplies: a.peerReviewReplies` and `peerReview: a.peerReview` (and `courseraDom: a.courseraDom`) so the production handler receives the real modules. |

Outcome tokens this phase emits: `peer-review-submitted` (success, advances cursor) and `peer-review-needs-user` (recoverable pause). The success token advances the cursor end-to-end: Task 8 makes the run loop skip the completion-confirmer for `peer-review-submitted` (no Mark-as-completed button exists after a fresh auto-submit), so the loop never reaches the `no-completion-indicator` pause for a successfully submitted review.

---

### Task 1: Comment pool module (`lib/peer-review-replies.js`)

**Files:**
- Create: `lib/peer-review-replies.js`
- Test: `tests/peer-review-replies.test.js`

**Steps:**

- [ ] **Step 1.1 — Write the failing pool test.** Create `tests/peer-review-replies.test.js` with the full body below.

```js
// tests/peer-review-replies.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { COMMENTS, pickComment } = require('../lib/peer-review-replies.js');

function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

test('COMMENTS has at least 20 entries', () => {
  assert.ok(COMMENTS.length >= 20, 'expected >= 20 comments, got ' + COMMENTS.length);
});

test('every comment is a non-empty string within a sane length bound', () => {
  for (let i = 0; i < COMMENTS.length; i++) {
    const c = COMMENTS[i];
    assert.equal(typeof c, 'string');
    assert.ok(c.trim().length > 0, 'comment ' + i + ' is empty');
    assert.ok(c.length <= 400, 'comment ' + i + ' is too long (' + c.length + ' chars)');
  }
});

test('every comment is unique', () => {
  const set = new Set(COMMENTS);
  assert.equal(set.size, COMMENTS.length);
});

test('no comment mentions a specific topic, AI, or Coursera', () => {
  const banned = /\b(coursera|chatgpt|gpt|openai|deepseek|anthropic|claude|gemini|\bAI\b|artificial intelligence)\b/i;
  for (let i = 0; i < COMMENTS.length; i++) {
    assert.ok(!banned.test(COMMENTS[i]), 'comment ' + i + ' mentions a banned word: ' + COMMENTS[i]);
  }
});

test('pickComment returns a string built from the pool', () => {
  const c = pickComment([], 0, seededRng(1));
  assert.equal(typeof c, 'string');
  assert.ok(c.length > 0);
});

test('pickComment with minLength 0 returns a single pool entry verbatim', () => {
  const c = pickComment([], 0, seededRng(1));
  assert.ok(COMMENTS.indexOf(c) !== -1, 'with no padding the result should be a verbatim pool entry');
});

test('pickComment excludes the most recent entry in history', () => {
  // History holds the single comment we just used; the picker must avoid it.
  const recent = COMMENTS[0];
  for (let seed = 1; seed <= 30; seed++) {
    const c = pickComment([recent], 0, seededRng(seed));
    assert.notEqual(c, recent, 'picked comment must not equal the recent history entry (seed ' + seed + ')');
  }
});

test('pickComment still returns something when history contains every comment', () => {
  const c = pickComment(COMMENTS.slice(), 0, seededRng(1));
  assert.equal(typeof c, 'string');
  assert.ok(c.length > 0);
});

test('pickComment pads to at least minLength by appending further pool sentences', () => {
  const minLength = 600; // longer than any single pool entry
  const c = pickComment([], minLength, seededRng(7));
  assert.ok(c.length >= minLength, 'padded result length ' + c.length + ' should be >= ' + minLength);
});

test('pickComment padding does not infinite-loop and stays bounded', () => {
  // Even an absurd minimum must terminate and produce a finite, capped string.
  const c = pickComment([], 100000, seededRng(3));
  assert.ok(typeof c === 'string' && c.length >= 100000);
  assert.ok(c.length <= 200000, 'padding should be bounded, got ' + c.length);
});

test('pickComment is deterministic given the same seed, history, and minLength', () => {
  const a = pickComment(['x'], 500, seededRng(42));
  const b = pickComment(['x'], 500, seededRng(42));
  assert.equal(a, b);
});
```

- [ ] **Step 1.2 — Run it and watch it fail.** Run `node --test "tests/peer-review-replies.test.js"`. Expected: FAIL with `Cannot find module '../lib/peer-review-replies.js'`.

- [ ] **Step 1.3 — Minimal implementation.** Create `lib/peer-review-replies.js` with the full body below.

```js
// lib/peer-review-replies.js
// ~20 generic, domain-neutral, human-sounding peer-review comments + a
// cooldown-aware, min-length-padding picker. No topic / AI / Coursera mention.
(function (root) {
  'use strict';

  const COMMENTS = [
    "Solid work overall. You laid out the steps clearly enough that I could follow your reasoning without backtracking, which is harder to do than it looks.",
    "I appreciated how direct this was. A couple of the middle points could use a sentence more of support, but the through-line held up.",
    "Strong submission. The part that worked best for me was how you connected the opening claim to the conclusion instead of leaving it implied.",
    "Clear and well organized. I'd only nudge you to spell out the assumption behind your second point, since it carries a lot of the argument.",
    "Nicely done. You picked a defensible position and stuck with it, and the examples mostly earned their place rather than padding the length.",
    "Good effort here. The structure is easy to navigate. Where I got slowed down was the jump from the evidence to the recommendation.",
    "This reads like you actually thought it through rather than rushing it. The tradeoffs you named felt genuine, not boilerplate.",
    "Competent and readable. One thing I'd flag: the strongest idea is buried in the middle, and it deserves to be up front.",
    "I liked the restraint. You resisted the urge to overclaim, and that made the parts you did assert land harder.",
    "Decent foundation. The opening is sharp; the closing trails off a little, so a firmer final sentence would tie it together.",
    "Honestly better than I expected from the prompt. You found an angle that wasn't obvious and committed to it without hedging everything.",
    "Works well. I'd push you on the example in the third section — it almost makes the opposite case if you read it closely.",
    "Thorough. You covered the bases and didn't leave obvious gaps, though a tighter edit would let the best points breathe more.",
    "Good instincts throughout. The reasoning is sound; what's missing is one concrete instance to anchor the more abstract middle stretch.",
    "I found this persuasive. The move from the general principle to the specific case was smooth, which is exactly where most attempts stumble.",
    "Reasonable and clear-eyed. You acknowledged the weaker side of your own position, and that honesty made the whole thing more convincing.",
    "Well argued. If I were revising it, I'd cut the qualifier in the second paragraph — it softens a claim that didn't need softening.",
    "Pretty effective. The pacing is uneven in spots, but the core idea is genuinely interesting and you gave it room to develop.",
    "Capable work. The framing is the standout part. The supporting detail is fine, just a touch generic where a sharper instance would help.",
    "This holds together. You didn't try to do too much, and the focus paid off — every section earned its keep instead of wandering.",
    "Genuinely thoughtful. I came away with a clearer sense of where you stand, and the few rough edges are easy fixes, not structural problems.",
    "Good submission. The logic chains cleanly from start to finish, and the one place I'd revisit is the transition into your final point.",
  ];

  function pickComment(history, minLength, random) {
    const hist = Array.isArray(history) ? history : [];
    const min = (typeof minLength === 'number' && minLength > 0) ? minLength : 0;
    const rng = (typeof random === 'function') ? random : Math.random;

    function pickOne(exclude) {
      const usable = COMMENTS.filter(function (c) { return exclude.indexOf(c) === -1; });
      const pool = usable.length > 0 ? usable : COMMENTS;
      const idx = Math.floor(rng() * pool.length);
      return pool[idx];
    }

    // First pick avoids recent history.
    let result = pickOne(hist);
    if (result.length >= min) return result;

    // Pad by appending further pool sentences (avoiding immediate repeats),
    // bounded so an absurd minLength can never loop forever.
    const used = hist.slice();
    used.push(result);
    let guard = 0;
    while (result.length < min && guard < 100000) {
      const next = pickOne(used);
      result = result + ' ' + next;
      used.push(next);
      guard += 1;
    }
    return result;
  }

  const api = { COMMENTS: COMMENTS, pickComment: pickComment };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.peerReviewReplies = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 1.4 — Run it and watch it pass.** Run `node --test "tests/peer-review-replies.test.js"`. Expected: PASS (all tests green).

- [ ] **Step 1.5 — Commit.** Run:
```
git add lib/peer-review-replies.js tests/peer-review-replies.test.js
git commit -m "feat(peer-review-replies): pooled comment picker with history avoidance + min-length padding"
```

---

### Task 2: Human-mode timing ranges (`lib/autopilot-timing.js`)

**Files:**
- Modify: `lib/autopilot-timing.js` (RANGES @ L6-16; helpers near L41-44; api @ L64-77)
- Test: `tests/autopilot-timing.test.js` (append)

**Steps:**

- [ ] **Step 2.1 — Write the failing range tests.** Append the full block below to the end of `tests/autopilot-timing.test.js`.

```js
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
```

- [ ] **Step 2.2 — Run it and watch it fail.** Run `node --test "tests/autopilot-timing.test.js"`. Expected: FAIL with `TypeError: peerTiming.peerInterCriterionMs is not a function` (and the RANGES deepEqual failing on `undefined`).

- [ ] **Step 2.3 — Add the ranges.** In `lib/autopilot-timing.js`, replace the `RANGES` object (currently L6-16) so it includes the three new entries:

```js
  const RANGES = {
    videoSeekFromEndSec: [50, 70],
    videoInitialWatchSec: [5, 12],
    videoPostEndSec: [5, 10],
    readingDwellSec: [120, 180],
    discussionDwellSec: [120, 180],
    quizDwellSec: [120, 180],
    interItemGapSec: [8, 18],
    scrollStepIntervalSec: [3, 8],
    scrollStepPx: [200, 500],
    peerInterCriterionSec: [2, 6],
    peerInterFieldSec: [1, 4],
    peerPreSubmitSec: [3, 8],
  };
```

- [ ] **Step 2.4 — Add the helpers.** In `lib/autopilot-timing.js`, immediately after the `interItemGapMs` one-liner (currently L44) add:

```js
  function peerInterCriterionMs(rng) { return randInt(rng, RANGES.peerInterCriterionSec[0], RANGES.peerInterCriterionSec[1]) * 1000; }
  function peerInterFieldMs(rng)     { return randInt(rng, RANGES.peerInterFieldSec[0],     RANGES.peerInterFieldSec[1])     * 1000; }
  function peerPreSubmitMs(rng)      { return randInt(rng, RANGES.peerPreSubmitSec[0],      RANGES.peerPreSubmitSec[1])      * 1000; }
```

- [ ] **Step 2.5 — Export the helpers.** In `lib/autopilot-timing.js`, add the three helpers to the `api` object (currently L64-77), after the `interItemGapMs: interItemGapMs,` line:

```js
    interItemGapMs: interItemGapMs,
    peerInterCriterionMs: peerInterCriterionMs,
    peerInterFieldMs: peerInterFieldMs,
    peerPreSubmitMs: peerPreSubmitMs,
    scrollStep: scrollStep,
```

- [ ] **Step 2.6 — Run it and watch it pass.** Run `node --test "tests/autopilot-timing.test.js"`. Expected: PASS (existing timing tests still green + the four new ones).

- [ ] **Step 2.7 — Commit.** Run:
```
git add lib/autopilot-timing.js tests/autopilot-timing.test.js
git commit -m "feat(autopilot-timing): peer-review inter-criterion/inter-field/pre-submit dwell ranges"
```

---

### Task 3: Pure rubric detection helpers (`lib/peer-review.js` — detection only)

**Files:**
- Create: `lib/peer-review.js`
- Test: `tests/peer-review.test.js`

This task ships the pure detection helpers and the IIFE/registration scaffold. The `createPeerReviewHandler` factory follows in Task 4.

**Steps:**

- [ ] **Step 3.1 — Write the failing detection tests.** Create `tests/peer-review.test.js` with the full body below.

```js
// tests/peer-review.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
  detectCriteria,
  selectHighestOption,
  findRequiredCommentBoxes,
  findSubmitControl,
  createPeerReviewHandler,
} = require('../lib/peer-review.js');

function seededRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeFakeDoc(html, url) {
  const j = new JSDOM('<!doctype html><html><body>' + html + '</body></html>',
    { url: url || 'https://www.coursera.org/learn/x/peer/p1/review' });
  return j.window.document;
}

// A rubric with two criteria; each criterion is a cds- radio group whose
// options carry "N points" text. The highest-points option must be selected.
const RUBRIC_HTML =
  '<div data-testid="peer-review-content">' +
    '<fieldset class="rc-Option" role="radiogroup" aria-label="Clarity">' +
      '<label class="cds-checkboxAndRadio-input"><input type="radio" name="crit1"><span>0 points: Unclear</span></label>' +
      '<label class="cds-checkboxAndRadio-input"><input type="radio" name="crit1"><span>1 point: Somewhat clear</span></label>' +
      '<label class="cds-checkboxAndRadio-input"><input type="radio" name="crit1"><span>2 points: Very clear</span></label>' +
    '</fieldset>' +
    '<fieldset class="rc-Option" role="radiogroup" aria-label="Depth">' +
      '<label class="cds-checkboxAndRadio-input"><input type="radio" name="crit2"><span>3 points: Excellent</span></label>' +
      '<label class="cds-checkboxAndRadio-input"><input type="radio" name="crit2"><span>1 point: Shallow</span></label>' +
    '</fieldset>' +
    '<textarea data-required="true" aria-label="Overall feedback"></textarea>' +
    '<button class="cds-button-primary"><span class="cds-button-label">Submit</span></button>' +
  '</div>';

test('detectCriteria finds each rubric radiogroup as a criterion', () => {
  const doc = makeFakeDoc(RUBRIC_HTML);
  const crits = detectCriteria(doc.body, function () { return false; });
  assert.equal(crits.length, 2);
  assert.equal(crits[0].label, 'Clarity');
  assert.equal(crits[0].options.length, 3);
  assert.equal(crits[1].options.length, 2);
});

test('selectHighestOption picks the option with the most points', () => {
  const doc = makeFakeDoc(RUBRIC_HTML);
  const crits = detectCriteria(doc.body, function () { return false; });
  const r = selectHighestOption(crits[0]);
  assert.equal(r.points, 2);
  assert.equal(r.lowConfidence, false);
  assert.ok(/Very clear/.test(r.option.text));
});

test('selectHighestOption handles unordered points (max not last)', () => {
  const doc = makeFakeDoc(RUBRIC_HTML);
  const crits = detectCriteria(doc.body, function () { return false; });
  const r = selectHighestOption(crits[1]); // "3 points" is FIRST here
  assert.equal(r.points, 3);
  assert.equal(r.lowConfidence, false);
  assert.ok(/Excellent/.test(r.option.text));
});

test('selectHighestOption falls back to last option and flags low-confidence when no points are parseable', () => {
  const doc = makeFakeDoc(
    '<fieldset role="radiogroup" aria-label="Tone">' +
      '<label><input type="radio" name="t"><span>Needs work</span></label>' +
      '<label><input type="radio" name="t"><span>Good</span></label>' +
      '<label><input type="radio" name="t"><span>Outstanding</span></label>' +
    '</fieldset>');
  const crits = detectCriteria(doc.body, function () { return false; });
  const r = selectHighestOption(crits[0]);
  assert.equal(r.lowConfidence, true);
  assert.equal(r.points, null);
  assert.ok(/Outstanding/.test(r.option.text), 'should fall back to the last option');
});

test('findRequiredCommentBoxes finds required textareas, excluding extension/chat nodes', () => {
  const doc = makeFakeDoc(
    RUBRIC_HTML +
    '<textarea id="boost-fake" aria-label="Send a message"></textarea>');
  // exclude function flags the Boost textarea by id.
  const exclude = function (el) { return el && el.id === 'boost-fake'; };
  const boxes = findRequiredCommentBoxes(doc.body, exclude);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].getAttribute('aria-label'), 'Overall feedback');
});

test('findSubmitControl locates the primary submit button by cds- prefix + text, excluding chat send', () => {
  const doc = makeFakeDoc(
    RUBRIC_HTML +
    '<button id="boost-send" class="Boost-ChatPanel-send"><span>Send</span></button>');
  const exclude = function (el) { return el && el.id === 'boost-send'; };
  const btn = findSubmitControl(doc.body, exclude);
  assert.ok(btn, 'should find a submit control');
  assert.ok(/Submit/.test(btn.textContent));
  assert.notEqual(btn.id, 'boost-send');
});

test('detectCriteria skips excluded (extension/chat) radiogroups', () => {
  const doc = makeFakeDoc(
    RUBRIC_HTML +
    '<fieldset id="ccp-fake" role="radiogroup" aria-label="ccp-behavior">' +
      '<label><input type="radio" name="ccp-behavior"><span>Fast</span></label>' +
    '</fieldset>');
  const exclude = function (el) { return el && el.id === 'ccp-fake'; };
  const crits = detectCriteria(doc.body, exclude);
  assert.equal(crits.length, 2, 'the extension radiogroup must be excluded');
});
```

- [ ] **Step 3.2 — Run it and watch it fail.** Run `node --test "tests/peer-review.test.js"`. Expected: FAIL with `Cannot find module '../lib/peer-review.js'`.

- [ ] **Step 3.3 — Minimal implementation (detection helpers + scaffold).** Create `lib/peer-review.js` with the full body below. (Task 4 will fill in `createPeerReviewHandler`'s real flow; for now it must be exported but the detection helpers are the tested surface.)

```js
// lib/peer-review.js
// Peer-review auto-complete handler + pure rubric/comment/submit detection.
// All DOM access is scoped via an injected coursera-dom (Phase A) and excludes
// the extension's own sidebar + the Boost support chat. Auto-submit is the
// deliberate exception to the fill-and-pause rule (per spec WS-D).
(function (root) {
  'use strict';

  // --- exclusion helpers --------------------------------------------------

  // Hardcoded last-resort exclusion used only when coursera-dom is absent.
  function fallbackIsExcluded(el) {
    if (!el || el.nodeType !== 1) return false;
    let node = el;
    while (node && node.nodeType === 1) {
      const id = (node.id || '').toLowerCase();
      const cls = (typeof node.className === 'string' ? node.className : '').toLowerCase();
      if (id === 'ccp-host' || id === 'ccp-host-root') return true;
      if (id === 'boostai-chat-panel-composer') return true;
      if (cls.indexOf('boost-chatpanel') !== -1) return true;
      const name = (node.getAttribute && (node.getAttribute('name') || '')) || '';
      if (name.toLowerCase() === 'ccp-behavior') return true;
      node = node.parentElement;
    }
    return false;
  }

  // --- numeric point parsing ---------------------------------------------

  // Parse a numeric point value from option text/aria. Matches "2 points",
  // "1 point", "3 pts", "5 marks". Returns a finite number or null.
  function parsePoints(text) {
    if (!text) return null;
    const m = String(text).match(/(-?\d+(?:\.\d+)?)\s*(?:points?|pts?|marks?)\b/i);
    if (m) {
      const n = parseFloat(m[1]);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  // --- rubric detection ---------------------------------------------------

  function optionText(el) {
    const aria = (el.getAttribute && (el.getAttribute('aria-label') || '')) || '';
    const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return (aria + ' ' + txt).trim();
  }

  // A criterion = a radiogroup (role=radiogroup or a fieldset of radios) whose
  // options are the contained radio inputs / labelled cds- options.
  function detectCriteria(rootEl, excludeFn) {
    const exclude = (typeof excludeFn === 'function') ? excludeFn : function () { return false; };
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return [];
    const groups = [];
    const seen = new Set();
    const groupEls = rootEl.querySelectorAll('[role="radiogroup"], fieldset');
    for (let i = 0; i < groupEls.length; i++) {
      const g = groupEls[i];
      if (exclude(g)) continue;
      const radios = g.querySelectorAll('input[type="radio"], [role="radio"]');
      if (radios.length < 2) continue; // not a scoring criterion
      if (seen.has(g)) continue;
      seen.add(g);
      const options = [];
      for (let r = 0; r < radios.length; r++) {
        const radio = radios[r];
        if (exclude(radio)) continue;
        // The clickable target is the label wrapper if present, else the input.
        const label = radio.closest ? (radio.closest('label') || radio) : radio;
        const text = optionText(label);
        options.push({ input: radio, control: label, text: text, points: parsePoints(text) });
      }
      if (options.length < 2) continue;
      const label = (g.getAttribute && (g.getAttribute('aria-label') || '')) || '';
      groups.push({ element: g, label: label, options: options });
    }
    return groups;
  }

  // Select the highest-scoring option. If no option has parseable points, fall
  // back to the LAST option (Coursera usually orders best last) and flag it.
  function selectHighestOption(criterion) {
    const opts = (criterion && criterion.options) || [];
    if (opts.length === 0) return { option: null, points: null, lowConfidence: true };
    let best = null;
    let bestPoints = -Infinity;
    for (let i = 0; i < opts.length; i++) {
      const p = opts[i].points;
      if (typeof p === 'number' && Number.isFinite(p) && p > bestPoints) {
        bestPoints = p;
        best = opts[i];
      }
    }
    if (best) {
      return { option: best, points: bestPoints, lowConfidence: false };
    }
    return { option: opts[opts.length - 1], points: null, lowConfidence: true };
  }

  // --- comment + submit detection ----------------------------------------

  function findRequiredCommentBoxes(rootEl, excludeFn) {
    const exclude = (typeof excludeFn === 'function') ? excludeFn : function () { return false; };
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return [];
    const boxes = [];
    const candidates = rootEl.querySelectorAll(
      'textarea[required], textarea[aria-required="true"], textarea[data-required="true"], ' +
      'div[contenteditable="true"][aria-required="true"]');
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (exclude(el)) continue;
      boxes.push(el);
    }
    return boxes;
  }

  const SUBMIT_TEXT_RE = /\b(submit|submit review|done|finish|complete review)\b/i;

  function findSubmitControl(rootEl, excludeFn) {
    const exclude = (typeof excludeFn === 'function') ? excludeFn : function () { return false; };
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return null;
    const buttons = rootEl.querySelectorAll(
      'button, [role="button"], input[type="submit"], [class*="cds-button"]');
    for (let i = 0; i < buttons.length; i++) {
      const b = buttons[i];
      if (exclude(b)) continue;
      const aria = (b.getAttribute && (b.getAttribute('aria-label') || '')) || '';
      const txt = (b.textContent || '');
      if (SUBMIT_TEXT_RE.test(aria) || SUBMIT_TEXT_RE.test(txt)) return b;
    }
    return null;
  }

  // --- handler factory (real flow in Task 4) -----------------------------

  function createPeerReviewHandler(deps) {
    // Filled in by Task 4.
    return async function peerReview(ctx) {
      return { outcome: 'peer-review-needs-user' };
    };
  }

  const api = {
    detectCriteria: detectCriteria,
    selectHighestOption: selectHighestOption,
    findRequiredCommentBoxes: findRequiredCommentBoxes,
    findSubmitControl: findSubmitControl,
    parsePoints: parsePoints,
    fallbackIsExcluded: fallbackIsExcluded,
    createPeerReviewHandler: createPeerReviewHandler,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.ClipboardCleaner = root.ClipboardCleaner || {};
    root.ClipboardCleaner.peerReview = api;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 3.4 — Run it and watch it pass.** Run `node --test "tests/peer-review.test.js"`. Expected: PASS (the seven detection tests; the handler factory is stubbed and not yet asserted).

- [ ] **Step 3.5 — Commit.** Run:
```
git add lib/peer-review.js tests/peer-review.test.js
git commit -m "feat(peer-review): rubric/comment/submit detection helpers + low-confidence fallback"
```

---

### Task 4: Peer-review handler flow (fill + auto-submit, human/fast timing)

**Files:**
- Modify: `lib/peer-review.js` (`createPeerReviewHandler` factory — replaces the Task 3 stub)
- Test: `tests/peer-review.test.js` (append)

**Steps:**

- [ ] **Step 4.1 — Write the failing handler tests.** Append the full block below to `tests/peer-review.test.js`.

```js
// ---- handler flow ----

function mkSignal() {
  const listeners = [];
  return {
    aborted: false,
    addEventListener: function (k, fn) { if (k === 'abort') listeners.push(fn); },
    removeEventListener: function () {},
    _abort: function () { this.aborted = true; listeners.forEach(function (fn) { fn(); }); },
  };
}

const fakeEngine = {
  TypingEngine: function FakeEngine() {
    this.start = function (opts) {
      opts.target.value = opts.text;
      opts.onDone && opts.onDone();
    };
    this.stop = function () {};
  },
};
const fakeInjector = {
  insertOrBackspace: function () {},
  isEditable: function () { return true; },
};

// A coursera-dom test double exposing only the public API the handler uses.
function fakeCourseraDom(doc, excludeFn) {
  return {
    assessmentRoot: function () { return doc.body; },
    isExcludedNode: function (el) { return excludeFn ? excludeFn(el) : false; },
    withinAssessment: function () { return true; },
    findNextItemButton: function () { return null; },
  };
}

function makeHandler(deps) {
  const base = {
    sleep: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    replies: require('../lib/peer-review-replies.js'),
    typingEngine: fakeEngine,
    typingInjector: fakeInjector,
  };
  return createPeerReviewHandler(Object.assign(base, deps || {}));
}

test('handler: selects highest option per criterion, fills comment, auto-submits, returns peer-review-submitted', async () => {
  const doc = makeFakeDoc(RUBRIC_HTML);
  let submitted = false;
  const submitBtn = doc.querySelector('.cds-button-primary');
  submitBtn.click = function () { submitted = true; };

  const handler = makeHandler({ courseraDom: fakeCourseraDom(doc, null) });
  const out = await handler({
    doc: doc,
    item: { id: 'p1', kind: 'peer' },
    rng: seededRng(1),
    signal: mkSignal(),
    behaviorMode: 'fast',
    replyHistory: [],
  });

  // Highest option in crit1 is "2 points" (3rd radio); crit2 is "3 points" (1st radio).
  const crit1Radios = doc.querySelectorAll('input[name="crit1"]');
  const crit2Radios = doc.querySelectorAll('input[name="crit2"]');
  assert.equal(crit1Radios[2].checked, true, 'highest crit1 option should be checked');
  assert.equal(crit2Radios[0].checked, true, 'highest crit2 option should be checked');
  assert.ok(doc.querySelector('textarea').value.length > 0, 'comment should be filled');
  assert.equal(submitted, true, 'should auto-submit');
  assert.equal(out.outcome, 'peer-review-submitted');
  assert.equal(out.selections.length, 2);
  assert.equal(out.selections[0].lowConfidence, false);
});

test('handler: pauses (peer-review-needs-user) when no rubric criteria are present', async () => {
  const doc = makeFakeDoc('<div data-testid="peer-review-content"><p>nothing to score</p></div>');
  const handler = makeHandler({ courseraDom: fakeCourseraDom(doc, null) });
  const out = await handler({
    doc: doc, item: { id: 'p1', kind: 'peer' }, rng: seededRng(1),
    signal: mkSignal(), behaviorMode: 'fast', replyHistory: [],
  });
  assert.equal(out.outcome, 'peer-review-needs-user');
});

test('handler: pauses when no submit control is found (never clicks a wrong button)', async () => {
  const noSubmit =
    '<fieldset role="radiogroup" aria-label="Clarity">' +
      '<label><input type="radio" name="c"><span>0 points</span></label>' +
      '<label><input type="radio" name="c"><span>2 points</span></label>' +
    '</fieldset>';
  const doc = makeFakeDoc(noSubmit);
  const handler = makeHandler({ courseraDom: fakeCourseraDom(doc, null) });
  const out = await handler({
    doc: doc, item: { id: 'p1', kind: 'peer' }, rng: seededRng(1),
    signal: mkSignal(), behaviorMode: 'fast', replyHistory: [],
  });
  assert.equal(out.outcome, 'peer-review-needs-user');
});

test('handler: never clicks the Boost chat Send button (exclusion)', async () => {
  const doc = makeFakeDoc(
    RUBRIC_HTML +
    '<button id="boost-send" class="Boost-ChatPanel-send"><span>Send</span></button>');
  let boostClicked = false;
  doc.querySelector('#boost-send').click = function () { boostClicked = true; };
  let realSubmitted = false;
  doc.querySelector('.cds-button-primary').click = function () { realSubmitted = true; };

  const exclude = function (el) {
    let n = el;
    while (n && n.nodeType === 1) { if (n.id === 'boost-send') return true; n = n.parentElement; }
    return false;
  };
  const handler = makeHandler({ courseraDom: fakeCourseraDom(doc, exclude) });
  const out = await handler({
    doc: doc, item: { id: 'p1', kind: 'peer' }, rng: seededRng(1),
    signal: mkSignal(), behaviorMode: 'fast', replyHistory: [],
  });
  assert.equal(boostClicked, false, 'must never click the Boost Send button');
  assert.equal(realSubmitted, true);
  assert.equal(out.outcome, 'peer-review-submitted');
});

test('handler (human mode): dwells between criteria/fields and before submit, all within timing RANGES', async () => {
  const doc = makeFakeDoc(RUBRIC_HTML);
  doc.querySelector('.cds-button-primary').click = function () {};
  const sleeps = [];
  const handler = makeHandler({
    courseraDom: fakeCourseraDom(doc, null),
    sleep: function (ms) { sleeps.push(ms); return Promise.resolve(); },
  });
  const out = await handler({
    doc: doc, item: { id: 'p1', kind: 'peer' }, rng: seededRng(5),
    signal: mkSignal(), behaviorMode: 'human', replyHistory: [],
  });
  assert.equal(out.outcome, 'peer-review-submitted');
  assert.ok(sleeps.length > 0, 'human mode should dwell');
  // Every dwell must fall within one of the three peer ranges (in ms).
  for (let i = 0; i < sleeps.length; i++) {
    const ms = sleeps[i];
    const inCriterion = ms >= 2000 && ms <= 6000;
    const inField = ms >= 1000 && ms <= 4000;
    const inPreSubmit = ms >= 3000 && ms <= 8000;
    assert.ok(inCriterion || inField || inPreSubmit, 'dwell ' + ms + 'ms out of all peer ranges');
  }
});

test('handler (fast mode): does not dwell', async () => {
  const doc = makeFakeDoc(RUBRIC_HTML);
  doc.querySelector('.cds-button-primary').click = function () {};
  const sleeps = [];
  const handler = makeHandler({
    courseraDom: fakeCourseraDom(doc, null),
    sleep: function (ms) { sleeps.push(ms); return Promise.resolve(); },
  });
  await handler({
    doc: doc, item: { id: 'p1', kind: 'peer' }, rng: seededRng(1),
    signal: mkSignal(), behaviorMode: 'fast', replyHistory: [],
  });
  assert.equal(sleeps.length, 0, 'fast mode should not dwell');
});

test('handler: ignores autoSubmitQuizzes and always auto-submits', async () => {
  const doc = makeFakeDoc(RUBRIC_HTML);
  let submitted = false;
  doc.querySelector('.cds-button-primary').click = function () { submitted = true; };
  const handler = makeHandler({ courseraDom: fakeCourseraDom(doc, null) });
  const out = await handler({
    doc: doc, item: { id: 'p1', kind: 'peer' }, rng: seededRng(1),
    signal: mkSignal(), behaviorMode: 'fast', replyHistory: [],
    autoSubmitQuizzes: false, // must be ignored
  });
  assert.equal(submitted, true);
  assert.equal(out.outcome, 'peer-review-submitted');
});

test('handler: degrades gracefully (scopes to doc.body) when courseraDom is absent', async () => {
  const doc = makeFakeDoc(RUBRIC_HTML);
  let submitted = false;
  doc.querySelector('.cds-button-primary').click = function () { submitted = true; };
  const handler = makeHandler({}); // NO courseraDom injected
  const out = await handler({
    doc: doc, item: { id: 'p1', kind: 'peer' }, rng: seededRng(1),
    signal: mkSignal(), behaviorMode: 'fast', replyHistory: [],
  });
  assert.equal(submitted, true);
  assert.equal(out.outcome, 'peer-review-submitted');
});

test('handler: reports low-confidence selections in the outcome', async () => {
  const doc = makeFakeDoc(
    '<fieldset role="radiogroup" aria-label="Tone">' +
      '<label><input type="radio" name="t"><span>Needs work</span></label>' +
      '<label><input type="radio" name="t"><span>Outstanding</span></label>' +
    '</fieldset>' +
    '<button class="cds-button-primary"><span>Submit</span></button>');
  doc.querySelector('.cds-button-primary').click = function () {};
  const handler = makeHandler({ courseraDom: fakeCourseraDom(doc, null) });
  const out = await handler({
    doc: doc, item: { id: 'p1', kind: 'peer' }, rng: seededRng(1),
    signal: mkSignal(), behaviorMode: 'fast', replyHistory: [],
  });
  assert.equal(out.outcome, 'peer-review-submitted');
  assert.equal(out.selections.length, 1);
  assert.equal(out.selections[0].lowConfidence, true);
});
```

- [ ] **Step 4.2 — Run it and watch it fail.** Run `node --test "tests/peer-review.test.js"`. Expected: FAIL — the stubbed factory returns `peer-review-needs-user`, so the submit/fill assertions fail (e.g. `submitted` is false, `out.selections` is undefined).

- [ ] **Step 4.3 — Implement the real handler.** In `lib/peer-review.js`, replace the entire `createPeerReviewHandler` stub (the `function createPeerReviewHandler(deps) { ... }` block) with the full implementation below.

```js
  function createPeerReviewHandler(deps) {
    const d = deps || {};
    const sleep = (typeof d.sleep === 'function') ? d.sleep : function () { return Promise.resolve(); };
    const timing = d.timing || null;
    const replies = d.replies || null;
    const typingEngine = d.typingEngine || null;
    const typingInjector = d.typingInjector || null;
    const debugRecorder = d.debugRecorder || null;

    function rec(type, details) {
      if (!debugRecorder || typeof debugRecorder.record !== 'function') return;
      try { debugRecorder.record(type, details); } catch (_) {}
    }

    // Resolve coursera-dom: injected dep > runtime global > require fallback.
    function resolveCourseraDom() {
      if (d.courseraDom) return d.courseraDom;
      if (root.ClipboardCleaner && root.ClipboardCleaner.courseraDom) return root.ClipboardCleaner.courseraDom;
      if (typeof require !== 'undefined') {
        try { return require('./coursera-dom.js'); } catch (_) { /* not present yet */ }
      }
      return null;
    }

    // Type one value into a comment box (TypingEngine in human, direct in fast).
    function fillComment(el, text, mode, signal) {
      return new Promise(function (resolve, reject) {
        if (mode === 'human' && typingEngine && typingEngine.TypingEngine && typingInjector) {
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
            target: el,
            profile: 'Balanced Natural',
            speed: 'Normal',
            simulateTypos: false,
            onTick: function (ev) { typingInjector.insertOrBackspace(el, ev); },
            onDone: function () {
              if (settled) return;
              settled = true;
              detach();
              resolve();
            },
          });
        } else {
          if ('value' in el) el.value = text;
          else el.textContent = text;
          try {
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

    function detectMinLength(el) {
      const attr = el && el.getAttribute && el.getAttribute('minlength');
      const n = attr ? parseInt(attr, 10) : NaN;
      return Number.isFinite(n) && n > 0 ? n : 0;
    }

    return async function peerReview(ctx) {
      const doc = ctx.doc;
      const rng = ctx.rng;
      const signal = ctx.signal;
      const mode = ctx.behaviorMode === 'human' ? 'human' : 'fast';
      const cdom = resolveCourseraDom();

      const scopeRoot = (cdom && typeof cdom.assessmentRoot === 'function' && cdom.assessmentRoot(doc))
        || (doc && doc.body) || null;
      const excludeFn = (cdom && typeof cdom.isExcludedNode === 'function')
        ? function (el) { return cdom.isExcludedNode(el); }
        : fallbackIsExcluded;

      if (!scopeRoot) {
        rec('peerReview.noRoot', {});
        return { outcome: 'peer-review-needs-user' };
      }

      const criteria = detectCriteria(scopeRoot, excludeFn);
      if (criteria.length === 0) {
        rec('peerReview.noCriteria', {});
        return { outcome: 'peer-review-needs-user' };
      }

      // Locate the submit control up-front: if there is none we must NOT make
      // any changes-then-fail-to-submit; pause for the user instead.
      const submitBtn = findSubmitControl(scopeRoot, excludeFn);
      if (!submitBtn) {
        rec('peerReview.noSubmit', {});
        return { outcome: 'peer-review-needs-user' };
      }

      // 1) Select the highest option per criterion.
      const selections = [];
      for (let i = 0; i < criteria.length; i++) {
        if (signal && signal.aborted) throw new Error('aborted');
        const choice = selectHighestOption(criteria[i]);
        if (choice.option && choice.option.control) {
          try { choice.option.control.click(); } catch (_) {}
          // Ensure the underlying radio reflects the choice even if click is faked.
          try {
            if (choice.option.input && 'checked' in choice.option.input) {
              choice.option.input.checked = true;
            }
          } catch (_) {}
        }
        selections.push({
          label: criteria[i].label,
          points: choice.points,
          lowConfidence: choice.lowConfidence,
          text: choice.option ? choice.option.text : '',
        });
        rec('peerReview.criterion.selected', {
          label: criteria[i].label, points: choice.points, lowConfidence: choice.lowConfidence,
        });
        if (mode === 'human' && timing && i < criteria.length - 1) {
          await sleep(timing.peerInterCriterionMs(rng), signal);
        }
      }

      // 2) Fill every required comment box, drawing from the pool with history.
      const boxes = findRequiredCommentBoxes(scopeRoot, excludeFn);
      const history = Array.isArray(ctx.replyHistory) ? ctx.replyHistory.slice() : [];
      const usedComments = [];
      for (let i = 0; i < boxes.length; i++) {
        if (signal && signal.aborted) throw new Error('aborted');
        const minLen = detectMinLength(boxes[i]);
        const comment = replies
          ? replies.pickComment(history.concat(usedComments), minLen, rng)
          : '';
        await fillComment(boxes[i], comment, mode, signal);
        usedComments.push(comment);
        rec('peerReview.comment.filled', { length: comment.length });
        if (mode === 'human' && timing && i < boxes.length - 1) {
          await sleep(timing.peerInterFieldMs(rng), signal);
        }
      }

      // 3) Pre-submit pause (human only), then AUTO-SUBMIT (the exception).
      if (mode === 'human' && timing) {
        await sleep(timing.peerPreSubmitMs(rng), signal);
      }
      if (signal && signal.aborted) throw new Error('aborted');
      try { submitBtn.click(); } catch (_) { /* ignore */ }
      rec('peerReview.submitted', { criteria: selections.length, comments: usedComments.length });

      return {
        outcome: 'peer-review-submitted',
        selections: selections,
        usedComments: usedComments,
      };
    };
  }
```

- [ ] **Step 4.4 — Run it and watch it pass.** Run `node --test "tests/peer-review.test.js"`. Expected: PASS (the seven detection tests from Task 3 plus the nine handler tests).

- [ ] **Step 4.5 — Commit.** Run:
```
git add lib/peer-review.js tests/peer-review.test.js
git commit -m "feat(peer-review): handler selects highest rubric option, fills comments, auto-submits with human/fast timing"
```

---

### Task 5: Route the `peer` kind through `item-handlers.createHandlers`

**Files:**
- Modify: `lib/item-handlers.js` (deps destructuring @ L84-95; returned handler map @ L556-563)
- Test: `tests/item-handlers.test.js` (append)

**Steps:**

- [ ] **Step 5.1 — Write the failing routing test.** Append the full block below to `tests/item-handlers.test.js`.

```js
test('createHandlers exposes a peerReview handler that fills a rubric and submits', async () => {
  const doc = makeFakeDoc(
    '<div data-testid="peer-review-content">' +
      '<fieldset role="radiogroup" aria-label="Clarity">' +
        '<label class="cds-checkboxAndRadio-input"><input type="radio" name="c1"><span>0 points</span></label>' +
        '<label class="cds-checkboxAndRadio-input"><input type="radio" name="c1"><span>2 points</span></label>' +
      '</fieldset>' +
      '<textarea data-required="true" aria-label="Feedback"></textarea>' +
      '<button class="cds-button-primary"><span class="cds-button-label">Submit</span></button>' +
    '</div>',
    'https://www.coursera.org/learn/x/peer/p1/review'
  );
  let submitted = false;
  doc.querySelector('.cds-button-primary').click = function () { submitted = true; };

  const fakeEngine2 = {
    TypingEngine: function FakeEngine() {
      this.start = function (opts) { opts.target.value = opts.text; opts.onDone && opts.onDone(); };
      this.stop = function () {};
    },
  };
  const fakeInjector2 = { insertOrBackspace: function () {}, isEditable: function () { return true; } };

  const handlers = createHandlers({
    sleep: function () { return Promise.resolve(); },
    timing: require('../lib/autopilot-timing.js'),
    peerReview: require('../lib/peer-review.js'),
    peerReviewReplies: require('../lib/peer-review-replies.js'),
    typingEngine: fakeEngine2,
    typingInjector: fakeInjector2,
  });

  assert.equal(typeof handlers.peerReview, 'function', 'should expose a peerReview handler');
  const out = await handlers.peerReview({
    doc: doc,
    item: { id: 'p1', kind: 'peer' },
    rng: seededRng(1),
    signal: mkSignal(),
    behaviorMode: 'fast',
    replyHistory: [],
  });
  assert.equal(doc.querySelectorAll('input[name="c1"]')[1].checked, true, 'highest option checked');
  assert.ok(doc.querySelector('textarea').value.length > 0, 'comment filled');
  assert.equal(submitted, true, 'auto-submitted');
  assert.equal(out.outcome, 'peer-review-submitted');
});
```

- [ ] **Step 5.2 — Run it and watch it fail.** Run `node --test "tests/item-handlers.test.js"`. Expected: FAIL with `handlers.peerReview is not a function` (assertion on `typeof handlers.peerReview`).

- [ ] **Step 5.3 — Destructure the new deps.** In `lib/item-handlers.js`, inside `createHandlers(deps)` after the `const pageFallback = (deps && deps.pageFallback) || null;` line (currently L90), add:

```js
    const peerReviewMod = (deps && deps.peerReview) || ((typeof require !== 'undefined') ? (function () { try { return require('./peer-review.js'); } catch (_) { return null; } })() : (root.ClipboardCleaner && root.ClipboardCleaner.peerReview)) || null;
    const peerReviewReplies = (deps && deps.peerReviewReplies) || ((typeof require !== 'undefined') ? (function () { try { return require('./peer-review-replies.js'); } catch (_) { return null; } })() : (root.ClipboardCleaner && root.ClipboardCleaner.peerReviewReplies)) || null;
    const courseraDom = (deps && deps.courseraDom) || (root.ClipboardCleaner && root.ClipboardCleaner.courseraDom) || null;
```

- [ ] **Step 5.4 — Build the peerReview handler and add it to the map.** In `lib/item-handlers.js`, immediately before the `return {` of the handler map (currently L556), add a constructed handler:

```js
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
```

Then add the entry to the returned map (currently L556-563):

```js
    return {
      reading: reading,
      discussion: discussion,
      video: video,
      videoRecovery: videoRecovery,
      fallback: fallback,
      assignment: assignment,
      peerReview: peerReviewHandler,
    };
```

- [ ] **Step 5.5 — Run it and watch it pass.** Run `node --test "tests/item-handlers.test.js"`. Expected: PASS (all existing item-handlers tests + the new routing test).

- [ ] **Step 5.6 — Commit.** Run:
```
git add lib/item-handlers.js tests/item-handlers.test.js
git commit -m "feat(item-handlers): wire peerReview handler from injected peer-review module + pool"
```

---

### Task 6: Classify outcome tokens + route `peer` kind in `module-autopilot.js`

**Files:**
- Modify: `lib/module-autopilot.js` (isFailureOutcome @ L71-82; FAILURE_REASON_TEXT @ L146-157; handlerForKind @ L918-922)
- Test: `tests/module-autopilot.test.js` (append)

**Steps:**

- [ ] **Step 6.1 — Export the test hooks.** `lib/module-autopilot.js` currently exports ONLY `{ createAutopilot, generateTabKey, HEARTBEAT_INTERVAL_MS }` from its `api` object (the tail at L2115-2119) — there is NO underscore-prefixed test-hook convention in this file. `isFailureOutcome` (L71) and `reasonText` (L159) are top-level IIFE functions that are never exported; `handlerForKind` (L918) is closure-scoped inside `createAutopilot` and cannot be exported at all. Add the two top-level functions directly to the `api` object at L2115 as test hooks:

```js
  const api = {
    createAutopilot: createAutopilot,
    generateTabKey: generateTabKey,
    HEARTBEAT_INTERVAL_MS: HEARTBEAT_INTERVAL_MS,
    _isFailureOutcome: isFailureOutcome,
    _reasonText: reasonText,
  };
```

(`_formatPeerReviewLogLines` is added to this same object in Task 8.4. `handlerForKind` is NOT exported — it is closure-scoped — so Step 6.7 tests routing indirectly.) The top-of-file require in `tests/module-autopilot.test.js` is `const { createAutopilot, generateTabKey } = require('../lib/module-autopilot.js');`; the new tests below `require('../lib/module-autopilot.js')` again to read the underscore hooks.

- [ ] **Step 6.2 — Write the failing classification test.** Append the full block below to `tests/module-autopilot.test.js`. The hook names are `mod._isFailureOutcome` / `mod._reasonText` exactly as exported in Step 6.1.

```js
test('peer-review-submitted is NOT a failure outcome (advances the cursor)', () => {
  const mod = require('../lib/module-autopilot.js');
  assert.equal(mod._isFailureOutcome({ outcome: 'peer-review-submitted' }), false);
});

test('peer-review-needs-user IS a recognized pause outcome', () => {
  const mod = require('../lib/module-autopilot.js');
  assert.equal(mod._isFailureOutcome({ outcome: 'peer-review-needs-user' }), true);
});

test('reasonText maps peer-review-needs-user to a user-grade phrase', () => {
  const mod = require('../lib/module-autopilot.js');
  const phrase = mod._reasonText({ outcome: 'peer-review-needs-user' });
  assert.ok(/peer review/i.test(phrase), 'phrase should mention peer review, got: ' + phrase);
});
```

- [ ] **Step 6.3 — Run it and watch it fail.** Run `node --test "tests/module-autopilot.test.js"`. Expected: FAIL — with the hooks exported in Step 6.1, `peer-review-needs-user` currently falls through `isFailureOutcome` to `return false` (so the pause assertion fails), and `reasonText` returns the raw token (so the phrase regex fails). (If you have not yet applied Step 6.1's export edit, the failure is a `TypeError: mod._isFailureOutcome is not a function` — apply Step 6.1 first, then Step 6.4.)

- [ ] **Step 6.4 — Classify the new tokens.** In `lib/module-autopilot.js`, in `isFailureOutcome` (currently L71-82), add the pause token before the final `return false;`:

```js
  function isFailureOutcome(o) {
    if (!o || !o.outcome) return true;
    if (/^pause-needed/.test(o.outcome)) return true;
    if (o.outcome === 'video-autoplay-blocked') return true;
    if (o.outcome === 'video-no-element') return true;
    if (o.outcome === 'discussion-skipped-no-input') return true;
    if (o.outcome === 'quiz-filled-paused-for-review') return true;
    if (o.outcome === 'quiz-filled-no-submit-button') return true;
    if (o.outcome === 'assignment-agreement-accepted-paused') return true;
    if (o.outcome === 'assignment-no-action') return true;
    if (o.outcome === 'peer-review-needs-user') return true;
    return false;
  }
```

(`peer-review-submitted` is not listed, so `isFailureOutcome` returns `false` for it — a success that advances the cursor. No change is needed for that token beyond NOT adding it.)

In `FAILURE_REASON_TEXT` (currently L146-157), add the pause entry after the `'assignment-no-action'` line:

```js
    'assignment-no-action': 'graded assignment — review and submit manually, then Resume',
    'peer-review-needs-user': 'peer review needs you — complete it manually, then Resume',
```

- [ ] **Step 6.5 — Confirm the test hooks are exported.** This was done in Step 6.1 (`_isFailureOutcome: isFailureOutcome, _reasonText: reasonText,` were added to the `api` object at L2115). Verify both names resolve when you `require('../lib/module-autopilot.js')` from the test — no separate edit is needed here.

- [ ] **Step 6.6 — Route the peer kind.** In `lib/module-autopilot.js`, in `handlerForKind(kind)` (currently L918-922), add the explicit peer branch:

```js
    function handlerForKind(kind) {
      if (kind === 'assignment' && handlers.assignment) return handlers.assignment;
      if ((kind === 'peer' || kind === 'peer-review') && handlers.peerReview) return handlers.peerReview;
      if (handlers[kind]) return handlers[kind];
      return handlers.fallback;
    }
```

- [ ] **Step 6.7 — Write a failing routing test and run it.** Append the full block below to `tests/module-autopilot.test.js` (using the exact exported name for `handlerForKind` confirmed in Step 6.1 — likely `_handlerForKind`; if it is not exported, add `_handlerForKind: handlerForKind` is not possible because `handlerForKind` is closure-scoped inside `createAutopilot`. In that case, test routing indirectly: assert that a `handlers` map containing `{ peerReview, fallback }` resolves `peer` to `peerReview`. The block below uses the indirect form, which does not depend on a new export):

```js
test('peer/peer-review kind routes to the peerReview handler when present', () => {
  // Mirror handlerForKind's resolution logic against a handler map.
  function resolve(kind, handlers) {
    if (kind === 'assignment' && handlers.assignment) return handlers.assignment;
    if ((kind === 'peer' || kind === 'peer-review') && handlers.peerReview) return handlers.peerReview;
    if (handlers[kind]) return handlers[kind];
    return handlers.fallback;
  }
  const peerReview = function () {};
  const fallback = function () {};
  const handlers = { peerReview: peerReview, fallback: fallback };
  assert.equal(resolve('peer', handlers), peerReview);
  assert.equal(resolve('peer-review', handlers), peerReview);
  assert.equal(resolve('quiz', handlers), fallback, 'unknown kind still falls back');
});
```

Run `node --test "tests/module-autopilot.test.js"`. Expected: PASS (the existing suite plus the three classification tests and the routing test).

- [ ] **Step 6.8 — Commit.** Run:
```
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(module-autopilot): classify peer-review outcomes and route peer kind to peerReview handler"
```

---

### Task 7: Manifest load order + production wiring (`manifest.json`, `content.js`)

**Files:**
- Modify: `manifest.json` (content_scripts[0].js @ L26-60)
- Modify: `content.js` (createHandlers call @ L96-127)
- Test: `tests/peer-review.test.js` (append a load-order guard)

**Steps:**

- [ ] **Step 7.1 — Write the failing load-order guard test.** Append the full block below to `tests/peer-review.test.js`. This reads `manifest.json` and asserts the new modules sit before `item-handlers.js` (and after `coursera-dom.js` IF Phase A has added it; the test tolerates its absence).

```js
const fs = require('node:fs');
const path = require('node:path');

test('manifest loads peer-review-replies.js then peer-review.js before item-handlers.js', () => {
  const manifestPath = path.join(__dirname, '..', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const js = manifest.content_scripts[0].js;
  const iReplies = js.indexOf('lib/peer-review-replies.js');
  const iPeer = js.indexOf('lib/peer-review.js');
  const iHandlers = js.indexOf('lib/item-handlers.js');
  assert.ok(iReplies !== -1, 'peer-review-replies.js must be listed');
  assert.ok(iPeer !== -1, 'peer-review.js must be listed');
  assert.ok(iHandlers !== -1, 'item-handlers.js must be listed');
  assert.ok(iReplies < iPeer, 'peer-review-replies.js must load before peer-review.js');
  assert.ok(iPeer < iHandlers, 'peer-review.js must load before item-handlers.js');
  // If Phase A has shipped coursera-dom.js, peer-review.js must load after it.
  const iDom = js.indexOf('lib/coursera-dom.js');
  if (iDom !== -1) {
    assert.ok(iDom < iPeer, 'coursera-dom.js must load before peer-review.js');
  }
});
```

- [ ] **Step 7.2 — Run it and watch it fail.** Run `node --test "tests/peer-review.test.js"`. Expected: FAIL — `peer-review-replies.js must be listed` (the modules are not yet in the manifest).

- [ ] **Step 7.3 — Insert the modules in the manifest.** In `manifest.json`, in `content_scripts[0].js`, insert the two new entries immediately before `"lib/item-handlers.js",` (currently L43). After the edit, that slice reads:

```json
        "lib/page-fallback.js",
        "lib/peer-review-replies.js",
        "lib/peer-review.js",
        "lib/item-handlers.js",
        "lib/completion-confirmer.js",
```

(If Phase A has already added `"lib/coursera-dom.js"` earlier in the array — before `lib/module-scraper.js` — leave it where it is; it already precedes this insertion point.)

- [ ] **Step 7.4 — Run it and watch it pass.** Run `node --test "tests/peer-review.test.js"`. Expected: PASS (the manifest guard now green along with all earlier peer-review tests).

- [ ] **Step 7.5 — Wire the production deps in content.js.** In `content.js`, in the `a.itemHandlers.createHandlers({ ... })` call (currently L96-127), add three injected deps after the `pageFallback: a.pageFallback || null,` line (currently L126):

```js
      pageFallback: a.pageFallback || null,
      peerReview: a.peerReview || null,
      peerReviewReplies: a.peerReviewReplies || null,
      courseraDom: a.courseraDom || null,
```

- [ ] **Step 7.6 — Run the full suite.** Run `npm test`. Expected: PASS — all 1253 existing tests plus every test added in Tasks 1-7 are green.

- [ ] **Step 7.7 — Commit.** Run:
```
git add manifest.json content.js tests/peer-review.test.js
git commit -m "feat(manifest,content): load peer-review modules in order and inject them into createHandlers"
```

---

### Task 8: Peer-review completion confirmation, cross-item comment history, and run-log transparency (`lib/module-autopilot.js`)

**Files:**
- Modify: `lib/module-autopilot.js` (confirmer guard @ L1163-1165; generic success log line @ L1469-1471; `outcome.usedReply` history threading @ L1494-1496; pure formatter near `reasonText` @ L159-162; api export @ L2115)
- Test: `tests/module-autopilot.test.js` (append)

The handler already returns `selections` (with `lowConfidence` flags) and `usedComments`. This task closes three gaps so the spec's `peer-review-submitted` outcome actually advances the cursor end-to-end:

1. **Completion confirmation (major).** After any non-failure outcome the run loop UNCONDITIONALLY calls `confirmer.waitForCompletion` (L1165) before reaching the success path. `lib/completion-confirmer.js` has NO peer-review branch — it only special-cases `reading` (L55) and otherwise waits on the item-completion indicator / green-row icon / top-progress flip, falling back to clicking a "Mark as completed" button (L1219-1241). A freshly auto-submitted peer review has no Mark-as-completed button and may not flip to "Completed" within `PRIMARY_CONFIRMER_TIMEOUT_MS` (45s, L141), so the loop can time out into the page-fallback path and ultimately pause with `no-completion-indicator` (L1444-1448). We treat the successful submit click as its own completion signal: when `outcome.outcome === 'peer-review-submitted'` we SKIP `waitForCompletion` and go straight to the success path (Step 8.5a).

2. **Cross-item comment history (major).** Spec WS-D step 3 ("push to history (FIFO cap)") requires comment dedup to persist ACROSS peer-review items. The handler reads `ctx.replyHistory` (passed at L1086) and returns `outcome.usedComments`, but the run loop only threads `outcome.usedReply` (singular) into `replyHistory` at L1494-1496. We extend that computation to also fold `outcome.usedComments` into the FIFO-capped history (Step 8.5b).

3. **Run-log transparency (minor).** A pure `formatPeerReviewLogLines` helper composes glyph-prefixed lines for the sidebar's existing `appendAutopilotLog` sink (L631-641); no new sidebar export is required. To avoid a duplicate success line, the generic `✓ <kind> "<title>"` line at L1470 is suppressed for the `peer-review-submitted` token (Step 8.5a), leaving only the richer peer-review lines.

**Steps:**

- [ ] **Step 8.1 — Write the failing log-formatting test.** Append the full block below to `tests/module-autopilot.test.js`. This relies on a new pure export `_formatPeerReviewLogLines` (added to the `api` object at L2115 alongside the Step 6.1 hooks — see Step 8.4).

```js
test('formatPeerReviewLogLines summarizes selections, flags low-confidence, and notes auto-submit', () => {
  const mod = require('../lib/module-autopilot.js');
  const lines = mod._formatPeerReviewLogLines({
    outcome: 'peer-review-submitted',
    selections: [
      { label: 'Clarity', points: 2, lowConfidence: false },
      { label: 'Depth', points: null, lowConfidence: true },
    ],
    usedComments: ['a', 'b'],
  });
  assert.ok(Array.isArray(lines));
  // One line per criterion + one auto-submit line.
  assert.equal(lines.length, 3);
  assert.ok(/Clarity/.test(lines[0]) && /2/.test(lines[0]));
  assert.ok(/Depth/.test(lines[1]) && /low.?confidence/i.test(lines[1]), 'low-confidence flagged: ' + lines[1]);
  assert.ok(/submitted/i.test(lines[2]) && /✓/.test(lines[2]), 'auto-submit line: ' + lines[2]);
  // Plural counts (2 criteria, 2 comments) read as plurals.
  assert.ok(/2 criteria/.test(lines[2]), 'plural criteria: ' + lines[2]);
  assert.ok(/2 comments/.test(lines[2]), 'plural comments: ' + lines[2]);
});

test('formatPeerReviewLogLines pluralizes single counts (criterion/comment)', () => {
  const mod = require('../lib/module-autopilot.js');
  const lines = mod._formatPeerReviewLogLines({
    outcome: 'peer-review-submitted',
    selections: [{ label: 'Clarity', points: 2, lowConfidence: false }],
    usedComments: ['only one'],
  });
  const submitLine = lines[lines.length - 1];
  assert.ok(/1 criterion\b/.test(submitLine), 'singular criterion: ' + submitLine);
  assert.ok(/1 comment\b/.test(submitLine), 'singular comment: ' + submitLine);
});

test('formatPeerReviewLogLines returns a pause note for peer-review-needs-user', () => {
  const mod = require('../lib/module-autopilot.js');
  const lines = mod._formatPeerReviewLogLines({ outcome: 'peer-review-needs-user' });
  assert.equal(lines.length, 1);
  assert.ok(/⏸/.test(lines[0]) && /peer review/i.test(lines[0]));
});
```

- [ ] **Step 8.2 — Run it and watch it fail.** Run `node --test "tests/module-autopilot.test.js"`. Expected: FAIL with `mod._formatPeerReviewLogLines is not a function` (the formatter tests). The end-to-end tests added in Step 8.5c will be added and run there.

- [ ] **Step 8.3 — Add the pure formatter.** In `lib/module-autopilot.js`, near `reasonText` (currently L159-162), add the pure function:

```js
  function formatPeerReviewLogLines(outcome) {
    if (!outcome || !outcome.outcome) return [];
    if (outcome.outcome === 'peer-review-needs-user') {
      return ['⏸ Peer review needs you — complete it manually, then Resume'];
    }
    if (outcome.outcome !== 'peer-review-submitted') return [];
    const lines = [];
    const selections = Array.isArray(outcome.selections) ? outcome.selections : [];
    for (let i = 0; i < selections.length; i++) {
      const s = selections[i];
      const label = s.label || ('Criterion ' + (i + 1));
      const score = (typeof s.points === 'number') ? (s.points + ' pts') : 'highest option';
      const flag = s.lowConfidence ? ' (low-confidence: no point values found)' : '';
      lines.push('↳ ' + label + ': chose ' + score + flag);
    }
    const critCount = selections.length;
    const commentCount = Array.isArray(outcome.usedComments) ? outcome.usedComments.length : 0;
    const critWord = critCount === 1 ? 'criterion' : 'criteria';
    const commentWord = commentCount === 1 ? 'comment' : 'comments';
    lines.push('✓ Peer review submitted (' + critCount + ' ' + critWord + ', ' + commentCount + ' ' + commentWord + ' filled)');
    return lines;
  }
```

(`⏸` = ⏸, `↳` = ↳, `✓` = ✓ — matching the existing glyph-prefixed run-log convention.)

- [ ] **Step 8.4 — Export the formatter.** Add `_formatPeerReviewLogLines: formatPeerReviewLogLines,` to the module-autopilot `api` object at L2115 (the same object that gained `_isFailureOutcome` / `_reasonText` in Step 6.1, ending with the `module.exports` / `root.ClipboardCleaner.moduleAutopilot` tail). After this edit the `api` object reads:

```js
  const api = {
    createAutopilot: createAutopilot,
    generateTabKey: generateTabKey,
    HEARTBEAT_INTERVAL_MS: HEARTBEAT_INTERVAL_MS,
    _isFailureOutcome: isFailureOutcome,
    _reasonText: reasonText,
    _formatPeerReviewLogLines: formatPeerReviewLogLines,
  };
```

- [ ] **Step 8.5a — Skip the confirmer for an auto-submitted peer review, suppress the generic line, and emit the peer lines.** This single edit closes major finding #1 (no Mark-as-completed button exists for a fresh peer-review submit, so the unconditional `waitForCompletion` at L1165 would time out and pause on `no-completion-indicator`) and minor finding #4 (the generic `✓ <kind> "<title>"` line at L1470 would otherwise double-log alongside the richer peer line).

  The confirmer is invoked inside `if (confirmer && typeof confirmer.waitForCompletion === 'function') {` at L1165. Wrap that whole block so it is bypassed for the peer success token. In `lib/module-autopilot.js`, change the guard at L1165 from:

```js
          if (confirmer && typeof confirmer.waitForCompletion === 'function') {
```

to:

```js
          // An auto-submitted peer review has no Mark-as-completed button and
          // may not flip to "Completed" within the confirmer timeout. The
          // submit click IS the completion signal — skip the confirmer entirely
          // and let the success path advance the cursor (per spec WS-D:
          // peer-review-submitted advances the cursor).
          const _isPeerSubmitted = outcome && outcome.outcome === 'peer-review-submitted';
          if (_isPeerSubmitted) {
            rec('completion.detected', { itemId: item.id, evidence: 'peer-review-submitted' });
          }
          if (!_isPeerSubmitted && confirmer && typeof confirmer.waitForCompletion === 'function') {
```

  Then gate the generic success line at L1469-1471 so it does NOT fire for the peer success token (the peer-review lines below replace it). Change:

```js
        if (!alreadyCompleteIndicator) {
          if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('✓ ' + item.kind + ' "' + (item.title || item.id) + '"');
        }
```

to:

```js
        if (!alreadyCompleteIndicator && !(outcome && outcome.outcome === 'peer-review-submitted')) {
          if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog('✓ ' + item.kind + ' "' + (item.title || item.id) + '"');
        }
```

  Finally, emit the peer-review lines. Immediately after that gated generic-line block (still before the `recordCourseItem` await at L1472), add:

```js
        if (outcome && outcome.outcome === 'peer-review-submitted') {
          const _peerLines = formatPeerReviewLogLines(outcome);
          for (let _i = 0; _i < _peerLines.length; _i++) {
            if (sidebar.appendAutopilotLog) sidebar.appendAutopilotLog(_peerLines[_i]);
          }
        }
```

  (`peer-review-needs-user` is a failure/pause outcome handled by `isFailureOutcome` → the pause path at L1149-1154, which already shows the `reasonText` banner from Task 6; it never reaches this success-path emission, so we only emit for the success token here. No double-logging.)

- [ ] **Step 8.5b — Thread `usedComments` into the FIFO comment history (cross-item dedup).** This closes major finding #2 / spec WS-D step 3 ("push to history (FIFO cap)"). The success path computes `newReplyHistory` from `outcome.usedReply` only (L1494-1496), so the peer handler's `outcome.usedComments` is never persisted and the next peer item starts from an empty `ctx.replyHistory`, allowing the same pool comment to repeat. Extend the computation so it also folds in `usedComments`. In `lib/module-autopilot.js`, replace the `newReplyHistory` block at L1494-1496:

```js
      const newReplyHistory = (outcome && outcome.usedReply)
        ? ((stateNow.replyHistory || []).concat([outcome.usedReply]).slice(-5))
        : (stateNow.replyHistory || []);
```

with:

```js
      // Fold whatever the handler used into the FIFO-capped reply/comment
      // history so dedup persists across items: discussions return a singular
      // `usedReply`; peer reviews return an array of `usedComments`.
      const _usedNow = (outcome && outcome.usedReply)
        ? [outcome.usedReply]
        : ((outcome && Array.isArray(outcome.usedComments)) ? outcome.usedComments : []);
      const newReplyHistory = _usedNow.length
        ? (stateNow.replyHistory || []).concat(_usedNow).slice(-5)
        : (stateNow.replyHistory || []);
```

  (The FIFO cap stays at the existing `slice(-5)`. `usedComments` is already what `createPeerReviewHandler` returns from Task 4, Step 4.3 — `return { outcome: 'peer-review-submitted', selections, usedComments }` — so no handler change is needed.)

- [ ] **Step 8.5c — Write end-to-end run-loop tests for the confirmer skip and the FIFO history threading, run them, and watch them pass.** Append the full block below to `tests/module-autopilot.test.js`. These exercise the real run loop via `bootIfRunning` (the same harness used by the existing confirmer tests at L390-481, with `mkFakeHandlers`, `makePage`, `MODULE_HTML`, `fakeStorage`, `stateMod`, `seededRng` already in scope at the top of the file). The first test injects a confirmer that would FAIL the wait if called — proving the peer success path advances the cursor WITHOUT pausing on `no-completion-indicator` (major finding #1). The second threads `usedComments` across two peer items, proving FIFO history persistence reaches the next item's `ctx.replyHistory` (major finding #2). Run `node --test "tests/module-autopilot.test.js"` after appending; both must FAIL before Steps 8.5a/8.5b are applied (the confirmer-skip test would pause; the history test's `replyHistory` would be empty) and PASS after.

```js
const PEER_HTML =
  '<div data-testid="lesson-collection">' +
    '<a href="/learn/x/peer/p1/review">Peer Review One</a>' +
    '<a href="/learn/x/peer/p2/review">Peer Review Two</a>' +
    '<a href="/learn/x/supplement/r1/reading">Reading</a>' +
  '</div>';

function mkPeerHandlers(onCtx) {
  const base = mkFakeHandlers();
  base.peerReview = function (ctx) {
    base.calls.push({ kind: 'peer', id: ctx.item.id, replyHistory: (ctx.replyHistory || []).slice() });
    if (onCtx) onCtx(ctx);
    return Promise.resolve({
      outcome: 'peer-review-submitted',
      selections: [{ label: 'Clarity', points: 2, lowConfidence: false }],
      usedComments: ['comment-for-' + ctx.item.id],
    });
  };
  return base;
}

test('peer-review-submitted advances the cursor WITHOUT invoking the confirmer (no no-completion-indicator pause)', async () => {
  const j = makePage(PEER_HTML, 'https://www.coursera.org/learn/x/peer/p1/review');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'p1', kind: 'peer', url: '/learn/x/peer/p1/review', title: 'Peer Review One' },
    { id: 'r1', kind: 'reading', url: '/learn/x/supplement/r1/reading', title: 'Reading' },
  ];
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkPeerHandlers(null);
  // A confirmer that would FAIL the wait and force a pause IF the loop called it.
  let confirmerCalls = 0;
  const confirmer = { waitForCompletion: function () { confirmerCalls += 1; return Promise.resolve(false); } };
  const navTargets = [];
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    confirmer: confirmer,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function (url) { navTargets.push(url); return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  await ap.bootIfRunning();
  assert.equal(confirmerCalls, 0, 'confirmer must NOT be called for an auto-submitted peer review');
  const after = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after.cursor, 1, 'cursor must advance past the submitted peer review');
  assert.notEqual(after.status, 'paused', 'must not pause on no-completion-indicator after a successful submit');
  assert.equal(navTargets.length, 1, 'should navigate to the next item');
  assert.ok(navTargets[0].indexOf('/supplement/r1') !== -1);
});

test('peer-review usedComments are folded into replyHistory and reach the next item ctx', async () => {
  const j = makePage(PEER_HTML, 'https://www.coursera.org/learn/x/peer/p1/review');
  const storage = fakeStorage();
  const d = stateMod.defaults();
  d.status = 'running';
  d.courseId = 'x';
  d.queue = [
    { id: 'p1', kind: 'peer', url: '/learn/x/peer/p1/review', title: 'Peer Review One' },
    { id: 'p2', kind: 'peer', url: '/learn/x/peer/p2/review', title: 'Peer Review Two' },
  ];
  await new Promise(function (r) { const it = {}; it[stateMod.RUN_KEY] = d; storage.set(it, r); });
  const handlers = mkPeerHandlers(null);
  const confirmer = { waitForCompletion: function () { return Promise.resolve(false); } };
  const ap = createAutopilot({
    document: j.window.document, window: j.window, storage: storage, handlers: handlers,
    confirmer: confirmer,
    nowFn: function () { return 1_000_000; }, tabKey: 'tab-1', rng: seededRng(1),
    navigate: function () { return Promise.resolve(); },
    sidebar: { setAutopilotStatus: function () {}, appendAutopilotLog: function () {}, setAutopilotPaused: function () {}, setAutopilotButtonsRunning: function () {}, getAnswerText: function () { return ''; } },
  });
  // First iteration: handles p1, advances cursor to p2.
  await ap.bootIfRunning();
  const after1 = await new Promise(function (r) { storage.get([stateMod.RUN_KEY], function (g) { r(g[stateMod.RUN_KEY]); }); });
  assert.equal(after1.cursor, 1, 'cursor advanced to p2');
  assert.deepEqual(after1.replyHistory, ['comment-for-p1'], 'p1 usedComments persisted to replyHistory');
  // Second iteration: re-boot at the advanced cursor; p2 must see p1's comment in ctx.replyHistory.
  await ap.bootIfRunning();
  const p2Call = handlers.calls.filter(function (c) { return c.kind === 'peer' && c.id === 'p2'; })[0];
  assert.ok(p2Call, 'p2 peer handler should have run');
  assert.ok(p2Call.replyHistory.indexOf('comment-for-p1') !== -1, 'p2 ctx.replyHistory must include p1 comment');
});
```

- [ ] **Step 8.6 — Run it and watch it pass.** Run `node --test "tests/module-autopilot.test.js"`. Expected: PASS (the three formatter tests, the two end-to-end tests from Step 8.5c, and the existing suite, including the Task 6 classification/routing tests).

- [ ] **Step 8.7 — Run the full suite.** Run `npm test`. Expected: PASS — all 1253 existing tests plus all Phase D additions are green.

- [ ] **Step 8.8 — Commit.** Run:
```
git add lib/module-autopilot.js tests/module-autopilot.test.js
git commit -m "feat(module-autopilot): peer-review submit advances without confirmer, threads usedComments into FIFO history, run-logs criterion selections with low-confidence flags"
```

---

## Final verification

- [ ] Run `npm test` once more. Confirm `pass 1253 + <new>` and `fail 0`. The new test files (`tests/peer-review-replies.test.js`, `tests/peer-review.test.js`) and the appended tests in `tests/autopilot-timing.test.js`, `tests/item-handlers.test.js`, `tests/module-autopilot.test.js` must all be green, and NO existing test may have regressed.
- [ ] Manual smoke (deferred, per spec "Testing strategy" / "Regression"): on a real Coursera peer-review page with Human mode, confirm the highest rubric option is selected per criterion, comments are filled, and the review auto-submits — and that neither the extension sidebar nor the Boost chat is ever touched. This is a manual step; do not block the plan on it.
