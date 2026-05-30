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

// ---- Phase D: manifest load-order guard ----
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
