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
